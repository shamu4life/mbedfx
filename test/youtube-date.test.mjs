import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, metaCacheKey, MUX_WAIT_BOT_MS, YT_META_BOT_MS } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
import { normalizeYouTube, withMuxDuration } from '../src/platforms/youtube/normalize.ts'
import { readFileSync } from 'node:fs'

/**
 * THIS FILE MAKES NO NETWORK CALLS, and now says so in code rather than by convention.
 *
 * `resolveYouTubeMeta` asks `youtubei/v1/player` before it asks the container (see
 * src/platforms/youtube/innertube.ts). Without this stub these tests would reach the live internet:
 * caught when one of them started asserting a REAL upload date it had fetched for M7lc1UVf-VE, which
 * is a non-deterministic suite and a dependency on YouTube being reachable from CI.
 *
 * Refusing the Innertube call is also what keeps these tests testing what they were WRITTEN to test —
 * the container rung and its cache — rather than silently exercising the fast path that now sits in
 * front of it. The Innertube path has its own file: test/youtube-innertube.test.mjs.
 */
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/youtubei/') || u.includes('youtube.com/oembed')) {
    return new Response('offline', { status: 503 })
  }
  throw new Error(`unexpected network call in an offline test: ${u}`)
}
void realFetch


/**
 * THE YOUTUBE UPLOAD DATE, driven through the real dispatcher with mocked bindings — no container, no
 * real R2, no network. It pins the defect reported from a live embed and re-measured 2026-07-26 with a
 * Discordbot UA against the apex, on the field that actually renders (`created_at` on the
 * /users/{h}/statuses/{id} callback the head advertises):
 *
 *   /watch?v=jNQXAC9IVRw  -> 1970-01-01T00:00:00.000Z   (BUG)
 *   /watch?v=M7lc1UVf-VE  -> 1970-01-01T00:00:00.000Z   (BUG)
 *   /watch?v=9bZkp7q19f0  -> 2012-07-15T07:46:32.000Z   (the watch page happened to win)
 *
 * The watch-page source that produced that 1-in-3 is deleted; the value now comes from the container's
 * `yt-dlp -J` timestamp, cached in R2 for 30 days. The pure half (parsing, the range guard, the vouch)
 * is pinned in youtube-normalize.test.mjs; this file is the orchestration half — WHERE the container is
 * allowed to be called, and where it is NOT.
 *
 * Deliberately mirrors facebook-meta.test.mjs's fake resolver + fake R2, because the two share
 * cachedMeta/metaCacheKey and a divergence in the fakes would hide a divergence in the code.
 */

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

function fakeR2(seed = [], muxWarm = true) {
  const store = new Map()
  for (const [k, v, uploaded] of seed) store.set(k, { bytes: new TextEncoder().encode(v), uploaded: uploaded ?? new Date() })
  return {
    store,
    // The muxed object is present by DEFAULT, so settleMux never degrades and never dominates the
    // timing of the assertions below — this file is about the META call, not the mux. The one test
    // that needs the mux to actually DISPATCH (slot affinity) passes muxWarm=false.
    async head() { return muxWarm ? { size: 4494401 } : null },
    async get(k) {
      const v = store.get(k)
      if (!v) return null
      return {
        body: new Response(v.bytes).body, size: v.bytes.length, uploaded: v.uploaded,
        async json() { return JSON.parse(new TextDecoder().decode(v.bytes)) },
      }
    },
    async put(k, body) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body).arrayBuffer())
      store.set(k, { bytes, uploaded: new Date() })
    },
  }
}

/** REAL CAPTURES, 2026-07-26: `yt-dlp -J --no-warnings --no-playlist` on each id. */
const TS_RICK = 1256453853        // dQw4w9WgXcQ -> 2009-10-25T06:57:33.000Z
const ISO_RICK = '2009-10-25T06:57:33.000Z'

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const req = (path, ua = DISCORD) =>
  new Request(`https://staging.megapenispoopenfarten.sex${path}`, { headers: { 'user-agent': ua } })

/**
 * EVERY TEST GETS ITS OWN VIDEO ID, and that is not cosmetic — it is the same hazard
 * facebook-meta.test.mjs records for muxInflight. metaInflight is module-level and isolate-lifetime,
 * so the never-resolving container promise one test parks under a key is still there for the next
 * test that uses the same key, which then waits the full deadline on a dead promise and makes ZERO
 * container calls. One test's in-flight work must never be another test's answer.
 */
const ytRef = id => ({ p: 'yt', id })
const activity = ref => `/users/anyone/statuses/${encodeStatusId(refKey(ref))}`
const oembedPath = ref => `/_oembed/${encodeStatusId(refKey(ref))}`

/** A VOUCHED post: oembed answered, so author.url is not the fallback constant. */
const vouchedPost = ref => normalizeYouTube({
  ok: true,
  oembed: {
    title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley',
    author_url: 'https://www.youtube.com/@RickAstley',
    thumbnail_url: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`,
  },
}, ref)
/** The oembed-MISS fallback post — renderable, but YouTube never vouched for the id. */
const unvouchedPost = ref => normalizeYouTube({ ok: false }, ref)

function fakeResolver(impl = {}) {
  const seen = { names: [], meta: 0, mux: 0, pages: [] }
  const binding = {
    getByName(name) {
      seen.names.push(name)
      return {
        async fetch(_url, init) {
          const body = JSON.parse(init.body)
          if (body.meta === true) {
            seen.meta++
            seen.pages.push(body.page)
            return impl.meta ? impl.meta(seen) : Response.json({ timestamp: TS_RICK, title: 'ignored' })
          }
          seen.mux++
          return new Response('MP4', { headers: { 'content-type': 'video/mp4', 'content-length': '3' } })
        },
      }
    },
  }
  return { seen, binding }
}

const envWith = (resolver, r2 = fakeR2()) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: resolver,
  MEDIA_CACHE: r2,
})
const deps = (post) => ({
  cache: fakeCache(),
  fetchPost: async ref => (ref.p === 'yt' ? post : null),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

const createdAt = async res => (await res.json()).created_at

test('A WARM META ENTRY gives the real created_at with ZERO container calls', async () => {
  const ref = ytRef('dQw4w9WgXcQ')
  const r2 = fakeR2([[metaCacheKey(ref), JSON.stringify({ timestamp: TS_RICK })]])
  const { seen, binding } = fakeResolver()
  const res = await handle(req(activity(ref)), envWith(binding, r2), ctx, deps(vouchedPost(ref)))
  assert.equal(await createdAt(res), ISO_RICK)
  assert.equal(seen.meta, 0, 'a warm meta entry must cost NO container call — every colo, 30 days')
})

test('A COLD ENTRY on a VOUCHED post costs exactly ONE container call and is WRITTEN', async () => {
  const ref = ytRef('M7lc1UVf-VE')
  const r2 = fakeR2()
  const { seen, binding } = fakeResolver()
  const res = await handle(req(activity(ref)), envWith(binding, r2), ctx, deps(vouchedPost(ref)))
  assert.equal(await createdAt(res), ISO_RICK, 'the card is right on the FIRST paste')
  assert.equal(seen.meta, 1)
  assert.equal(seen.pages[0], 'https://www.youtube.com/watch?v=M7lc1UVf-VE', 'the watch page, from the ref alone')
  // Asserted through the exported key, not a hand-built string: a hand-built one would pass while
  // metaCacheKey drifted. The GENERATION segment is matched as a shape rather than pinned to a
  // literal — it is the container's invalidation switch and is expected to move; what this test owns
  // is that a yt record is namespaced by refKey and cannot collide with fb's or with a mux object.
  assert.match(metaCacheKey(ref), /^meta\/g\d+\/yt:M7lc1UVf-VE\.json$/)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r2.store.get(metaCacheKey(ref)).bytes)),
    { timestamp: TS_RICK }, 'ONLY the field we consume is persisted')
})

test('INNERTUBE ANSWERS AND ITS ANSWER IS THE ONE WRITTEN — the container beside it is not waited for', async () => {
  /**
   * THE POINT OF PUTTING INNERTUBE IN FRONT OF THE CONTAINER, which is not the same as the render
   * path already asking it. `fetchYouTube` asks on every cold render, but that answer was not
   * persisted — so every paste was an INDEPENDENT attempt, and measured against production on
   * 2026-08-27 across 22 unseen ids that attempt succeeds only about 40-50% of the time from
   * Cloudflare's egress. Not a timeout (the post fetch returns in ~250ms) and not a bad video (every
   * failing id answers perfectly residentially) — the egress is refused on some fraction of requests.
   *
   * Reaching it from resolveYouTubeMeta puts the answer through metaAttempt -> metaWork, which writes
   * the record for 30 days. A coin flip that STICKS is a different thing from one re-rolled forever:
   * one success, on any paste, in any colo, fixes that video permanently for everyone.
   *
   * REWRITTEN 2026-09-04. This used to assert ZERO container calls, because the container ran only
   * after Innertube failed. That serial order is what drew the 1970 epoch on the owner's second paste
   * that day (a 1.7-2.5s refusal in front of a 3.1-4.7s `-J` under a 4000ms deadline), so the two
   * rungs now start together and the first usable record wins. The container may therefore be ASKED
   * here (at most once, bounded by metaOnce); what this test now pins is that its answer is neither
   * waited for nor written when Innertube's arrives first. The fake container is slow on purpose so
   * the race has a loser.
   */
  const ref = ytRef('innertube01')
  const { seen, binding } = fakeResolver({ meta: () => new Promise(r => setTimeout(() => r(Response.json({ timestamp: TS_RICK })), 3100)) })
  const r2 = fakeR2()

  const saved = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/youtubei/')) return new Response('offline', { status: 503 })
    return Response.json({
      playabilityStatus: { status: 'UNPLAYABLE', reason: 'Video unavailable' },
      videoDetails: {
        lengthSeconds: '213', viewCount: '1808522174',
        shortDescription: 'The official video for “Never Gonna Give You Up” by Rick Astley.',
      },
      microformat: { playerMicroformatRenderer: { publishDate: '2009-10-24T23:57:33-07:00' } },
    })
  }
  try {
    const t0 = Date.now()
    const res = await handle(req(activity(ref)), envWith(binding, r2), ctx, deps(vouchedPost(ref)))
    const elapsed = Date.now() - t0
    assert.equal(await createdAt(res), ISO_RICK, 'the real date, on the first paste')
    assert.ok(seen.meta <= 1, 'the container is asked beside Innertube, at most once')
    assert.ok(elapsed < 2500, `and never waited for once Innertube answered (${elapsed}ms)`)

    const written = r2.store.get(metaCacheKey(ref))
    assert.ok(written, 'the answer is PERSISTED, which is what stops the next paste re-rolling it')
    const rec = JSON.parse(new TextDecoder().decode(written.bytes))
    assert.equal(rec.timestamp, TS_RICK)
    assert.equal(rec.duration, 213)
    assert.equal(rec.jarred, undefined,
      'and never claims a credential was spent — this rung sends no cookie jar')
  } finally {
    globalThis.fetch = saved
  }
})

test('THE SECURITY PIN: an UNVOUCHED post costs ZERO container calls and renders the epoch', async () => {
  /**
   * The sibling of facebook-meta's "PREWARM SCOPE: an unknown, never-fetched ref costs ZERO container
   * muxes". The post-cache gate the yt mux prewarm uses is WEAK on this platform — normalizeYouTube
   * never returns null, so `GET /shorts/<any 11 legal chars>` earns a post-cache entry on request #1.
   * oembed answering for the id is the cheap, strictly stronger check, and it is free: oembed already ran.
   */
  const ref = ytRef('9bZkp7q19f0')
  const { seen, binding } = fakeResolver()
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(unvouchedPost(ref)))
  assert.equal(seen.meta, 0, 'an id YouTube never vouched for must not reach the container')
  assert.equal(await createdAt(res), '1970-01-01T00:00:00.000Z', 'and the answer is honest, not invented')
})

test('A CONTAINER THAT NEVER ANSWERS still returns, honestly, and the work is handed to waitUntil', async () => {
  const ref = ytRef('jNQXAC9IVRw')
  const { seen, binding } = fakeResolver({ meta: () => new Promise(() => {}) })
  const waits = []
  const t0 = Date.now()
  const res = await handle(req(activity(ref)), envWith(binding), { waitUntil: p => waits.push(p) }, deps(vouchedPost(ref)))
  const elapsed = Date.now() - t0
  assert.equal(await createdAt(res), '1970-01-01T00:00:00.000Z', 'no date is honest; a wrong one is not')
  /**
   * THE BOUND IS THIS ARM'S OWN BUDGET NOW, and the old one could not fail for the bug it guarded.
   *
   * It read `elapsed < 9000` — MUX_WAIT_API_MS, the ceiling the /_card surface accepts — while the
   * arm it measures was actually capped at 1500. Six times the slack. The exact behaviour 553bd2e was
   * written to remove, an 8.2s activity document, passes under 9000, so this assertion would have
   * stayed green through the regression it exists to catch. It also stayed green through the reverse
   * mistake: the arm being capped at 1500, BELOW the 1716ms median of its own successes.
   *
   * YT_META_BOT_MS is what this route now gives the metadata arm, and 900ms is slack for a loaded box
   * and nothing else. Anything wider stops expressing "bounded by its budget".
   */
  assert.ok(elapsed < YT_META_BOT_MS + 900,
    `the metadata arm must stop at its own budget, not the container's timeout (${elapsed}ms)`)
  assert.equal(seen.meta, 1)
  assert.ok(waits.length > 0, 'the extract keeps running past the response rather than being abandoned')
})

test("THE CONTAINER IS ASKED WHEN youtubeMeta RUNS, NOT AFTER INNERTUBE'S ABORT", async () => {
  // The other half of the 2026-09-04 fix, pinned directly: the `-J` must be dispatched at once, or
  // a 3.1-4.7s extract behind a 1.7-2.5s stall cannot fit any budget Discord tolerates.
  const ref = ytRef('concurrnt01')
  let askedAt = 0
  const t0 = Date.now()
  const { binding } = fakeResolver({ meta: () => { askedAt = Date.now() - t0; return Response.json({ timestamp: TS_RICK }) } })
  const saved = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('/youtubei/')) return new Response('offline', { status: 503 })
      return new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })
    }
    const res = await handle(req(activity(ref)), envWith(binding), { waitUntil() {} }, deps(vouchedPost(ref)))
    assert.equal(await createdAt(res), ISO_RICK)
  } finally {
    globalThis.fetch = saved
  }
  assert.ok(askedAt > 0 && askedAt < 500, `the container was asked ${askedAt}ms in — beside Innertube, not after its 2500ms abort`)
})

test('THE METADATA ARM GETS ITS OWN BUDGET, AND THE TRANSLATION DOES NOT', async () => {
  /**
   * WHAT THIS PINS, and why one number for all three arms was wrong.
   *
   * The activity route runs settleMux, youtubeMeta and translationFor in one Promise.all. Until
   * 2026-08-29 all three were handed MUX_WAIT_BOT_MS (1500) — chosen for the MUX. The metadata arm
   * has a different distribution and it is recorded in the code it calls: innertube.ts measures its
   * successes at a 1716ms MEDIAN, and aborts its own fetch at INNERTUBE_TIMEOUT_MS = 2500. A 1500
   * cap therefore sat below the median cost of a hit and could never observe a successful call
   * finish at all, which throttled the "second attempt per paste" resolveYouTubeMeta exists to buy.
   *
   * THE MUX ARM IS NOT WHAT ARM 2 BELOW MEASURES, and the title used to say it was. Later the same
   * day the mux arm got a budget of its own too — YT_MUX_BOT_MS, 4000ms on the yt activity document —
   * so "the other two" is now one. The seam-by-seam proof that only that document has it lives in
   * test/card-muxing.test.mjs, which owns a container that genuinely never answers; the fake resolver
   * in THIS file answers a mux instantly, so what arm 2 times is the TRANSLATION.
   *
   * The arms cannot be timed in one request — Promise.all ends at the slowest — so this drives two,
   * and compares them. Absolute bands alone would be a 300ms margin on a loaded box; the RELATIVE gap
   * is the real assertion, because both requests pay the same machine.
   */
  const rows = []
  const ae = { writeDataPoint: x => rows.push(x.blobs?.[1]) }

  /**
   * ARM 1, AND IT IS THE PRODUCTION SHAPE RATHER THAN A STOPWATCH. Innertube is refused — the ~50%
   * of pastes this whole path exists for — so `fetchInnertube` burns its shared 2500ms deadline and
   * the CONTAINER answers. That total does not fit in 1500 and does fit in 2800, so the assertion
   * that matters is the DATE, not the clock: this test renders 1 January 1970 if the arm is put back
   * on the shared budget.
   *
   * The refusal honours the abort signal rather than hanging, which is not decoration — an ignored
   * signal leaves the attempt in `metaInflight`, and SPECULATIVE_META_CAP is 2, so two stranded
   * slots silently refuse every later test's container call. The neighbouring "A CONTAINER THAT
   * NEVER ANSWERS" test spends one of those two on purpose; this one must not spend the other.
   */
  const metaRef = ytRef('budgetMeta1')
  /**
   * THE CONTAINER ANSWERS IN 3100ms, NOT 0ms — REWRITTEN 2026-09-04. The fake used to answer the
   * `-J` instantly, so this test passed while production rendered 1970 on the owner's second paste
   * that day: the real `-J` is 3.1-4.7s (src/worker.ts, resolveYouTubeMeta), and it was SERIALIZED
   * behind Innertube's 2500ms abort under a 4000ms deadline. 3100 is the fast end of the measured
   * range. This is that paste reproduced offline; it was red on the serial code and is green only
   * because the two rungs now start together.
   */
  const hangMeta = fakeResolver({ meta: () => new Promise(r => setTimeout(() => r(Response.json({ timestamp: TS_RICK, title: 'ignored' })), 3100)) })
  const saved = globalThis.fetch
  let metaMs = 0
  let dated = ''
  try {
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('/youtubei/')) return new Response('offline', { status: 503 })
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const t0 = Date.now()
    const res = await handle(
      req(activity(metaRef)),
      { ...envWith(hangMeta.binding), AE: ae },
      { waitUntil() {} },
      deps(vouchedPost(metaRef)),
    )
    metaMs = Date.now() - t0
    dated = await createdAt(res)
  } finally {
    globalThis.fetch = saved
  }
  assert.equal(dated, ISO_RICK,
    'a 3100ms container answer must land inside the metadata budget while Innertube burns its abort BESIDE it, not before it')
  assert.ok(metaMs > MUX_WAIT_BOT_MS + 400,
    `so the arm must outlive the shared crawler budget (${metaMs}ms, MUX_WAIT_BOT_MS=${MUX_WAIT_BOT_MS})`)
  assert.ok(metaMs < YT_META_BOT_MS + 900,
    `and still stop inside YT_META_BOT_MS (${metaMs}ms)`)

  /**
   * ARM 2, THE TRANSLATION, and it is the one arm here that still holds the shared budget.
   *
   * The metadata answers instantly. The mux is COLD (muxWarm=false, so the R2 head misses) and
   * degrades — but FAST, because this file's fake resolver answers a mux request the moment it
   * arrives and only the fake R2's head is what refuses to confirm it. So the mux arm never reaches
   * its own deadline here and cannot be timed from this file at all; card-muxing.test.mjs does that.
   * What is left holding a clock is the translation: a Japanese title against a Workers AI binding
   * that never returns, cut off at whatever budget translationFor was handed.
   *
   * NOT A VACUOUS PASS: `card_degraded` and `translate_pending` are only counted on the losing side
   * of their races, so `translate_pending` is the proof that this arm actually raced and was cut off
   * — without it a translation that silently no-opped would satisfy the timing on its own.
   */
  const otherRef = ytRef('budgetOther')
  const hangMux = fakeResolver({ meta: () => Response.json({ timestamp: TS_RICK }) })
  const jp = { ...vouchedPost(otherRef), text: '白菜おいしいね、今日もいい天気ですから散歩に行きます' }
  const t1 = Date.now()
  await handle(
    req(activity(otherRef)),
    {
      ...envWith(hangMux.binding, fakeR2([], false)),
      AE: ae,
      AI: { run: () => new Promise(() => {}) },
      // Google needs no binding, so it is the default path and would reach the live internet. Off
      // here, which leaves the AI fallback — the half this test can hang deterministically.
      TRANSLATE_GOOGLE: 'off',
    },
    { waitUntil() {} },
    deps(jp),
  )
  const otherMs = Date.now() - t1

  assert.ok(rows.includes('card_degraded'), 'the mux arm must have actually raced and lost')
  assert.ok(rows.includes('translate_pending'), 'and the translation arm too, or its timing proves nothing')
  assert.ok(otherMs > MUX_WAIT_BOT_MS - 300, `the translation must have waited its budget (${otherMs}ms)`)
  assert.ok(otherMs < MUX_WAIT_BOT_MS + 900,
    `and must not be given the metadata arm's (${otherMs}ms, YT_META_BOT_MS=${YT_META_BOT_MS})`)
  // The load-independent form of the line above: both requests ran on the same machine seconds
  // apart, so a box slow enough to inflate one inflates both, and only a real budget change moves
  // the GAP. Nothing but a shared budget can make it vanish.
  assert.ok(metaMs - otherMs > 600,
    `the translation arm must NOT have been given YT_META_BOT_MS ` +
    `(meta ${metaMs}ms vs translate ${otherMs}ms)`)
})

test('A JUNK OR MISSING timestamp is NEVER written — the self-healing rule', async () => {
  const junk = [{}, { timestamp: null }, { timestamp: 'yesterday' }, { timestamp: 0 }, { timestamp: 4102444800000 }]
  for (let i = 0; i < junk.length; i++) {
    const ref = ytRef(`junkTimest${i}`)
    const r2 = fakeR2()
    const { binding } = fakeResolver({ meta: () => Response.json(junk[i]) })
    const res = await handle(req(activity(ref)), envWith(binding, r2), ctx, deps(vouchedPost(ref)))
    assert.equal(await createdAt(res), '1970-01-01T00:00:00.000Z', `${JSON.stringify(junk[i])} must not render`)
    assert.ok(!r2.store.has(metaCacheKey(ref)),
      `an unvalidated extract must never be cached for 30 days: ${JSON.stringify(junk[i])}`)
  }
})

test('A CORRUPT STORED OBJECT falls through to the container without throwing', async () => {
  const corrupt = ['not json at all', 'null', '{"timestamp":"nope"}', '{}']
  for (let i = 0; i < corrupt.length; i++) {
    const ref = ytRef(`corruptR${i}_`)
    const r2 = fakeR2([[metaCacheKey(ref), corrupt[i]]])
    const { seen, binding } = fakeResolver()
    const res = await handle(req(activity(ref)), envWith(binding, r2), ctx, deps(vouchedPost(ref)))
    assert.equal(seen.meta, 1, `a corrupt entry must be refetched: ${corrupt[i]}`)
    assert.equal(await createdAt(res), ISO_RICK)
  }
})

test('AN R2 STAND-IN WITH NO `get` METHOD does not 500 the activity route', async () => {
  // Exactly what test/pipeline.test.mjs's muxedEnv provides today: {head, put} and nothing else. A
  // `.catch()` guard cannot see that — the missing method throws SYNCHRONOUSLY on the call.
  const ref = ytRef('noGetMetho')
  const { binding } = fakeResolver()
  const env = { ...envWith(binding), MEDIA_CACHE: { async head() { return { size: 1 } }, async put() {} } }
  const res = await handle(req(activity(ref)), env, ctx, deps(vouchedPost(ref)))
  assert.equal(res.status, 200)
  assert.equal(await createdAt(res), ISO_RICK, 'and the container still fills it')
})

test('THE FIRST-PASTE PIN: the HTML route and /_oembed make ZERO meta container calls', async () => {
  // The HTML head emits no date tag and toOEmbed has no date field, so a meta call on either would be
  // pure cost on the path where latency is a correctness issue. Deleting the watch-page fetch makes the
  // first paste strictly FASTER; this is the assertion that keeps it that way.
  const ref = ytRef('firstPaste0')
  const { seen, binding } = fakeResolver()
  const html = await handle(req(`/watch?v=${ref.id}`), envWith(binding), ctx, deps(vouchedPost(ref)))
  assert.equal(html.status, 200)
  assert.equal(seen.meta, 0, 'the HTML post route must never call the container for a date')

  await handle(req(oembedPath(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  assert.equal(seen.meta, 0, '/_oembed has no date field to fill')
})

test('SLOT AFFINITY: the meta call and the mux for one yt ref land on ONE instance', async () => {
  // The yt twin of facebook-meta's SLOT AFFINITY test. resolverStub hashes the POST (refKey), never the
  // operation, so a video's date extract finds the instance its mux already booted.
  const ref = ytRef('slotAffini0')
  const { seen, binding } = fakeResolver()
  await handle(req(activity(ref)), envWith(binding, fakeR2([], false)), ctx, deps(vouchedPost(ref)))
  assert.ok(seen.meta >= 1 && seen.mux >= 1, 'both a meta call and a mux must have happened')
  assert.equal(new Set(seen.names).size, 1, `one ref, one slot: ${[...new Set(seen.names)]}`)
})

test('AN OEMBED MISS DOES NOT THROW THE WARM DATE AWAY — the two sources are independent', async () => {
  /**
   * `got.ok && warm` was the first spelling of the overlay in worker.ts, and it discarded a date the
   * worker was ALREADY HOLDING whenever oembed transiently missed. Title/channel and the upload instant
   * come from two independent sources — oembed and R2 — and one missing says nothing about the other.
   *
   * WITH NO CONTAINER BOUND, which is the state that makes the loss observable rather than merely
   * wasteful. When MEDIA_RESOLVER is present the activity route papers over the epoch by re-reading R2
   * inside youtubeMeta (an extra GET per callback, and a post cache entry that stays wrong for the full
   * POST_TTL — reason enough on its own). When it is ABSENT — an ordinary degraded deployment this
   * codebase designs for; withResolver drops the remux to the still — youtubeMeta returns at its first
   * line and there is no second chance: the date is simply gone, with the correct timestamp sitting in
   * R2 the whole time.
   *
   * Driven through the REAL liveFetchPost, because the defect lives at that seam (the Promise.all of
   * oembed and the cache-only meta read), not in the normalizer.
   */
  const ref = ytRef('oembedMiss0')
  const r2 = fakeR2([[metaCacheKey(ref), JSON.stringify({ timestamp: TS_RICK })]])
  const { liveFetchPost } = await import('../src/worker.ts')
  const env = { AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } }, MEDIA_CACHE: r2 }
  const saved = globalThis.fetch
  // oembed answers 404 with an HTML body — what it does for an embedding-disabled or briefly
  // unavailable video, and what fetchYouTube's content assertion turns into { ok: false }.
  globalThis.fetch = async () => new Response('<html>nope', { status: 404, headers: { 'content-type': 'text/html' } })
  try {
    const res = await handle(req(activity(ref)), env, ctx, { ...deps(null), fetchPost: liveFetchPost })
    const json = await res.json()
    assert.equal(json.created_at, ISO_RICK, 'a known-correct date must survive an oembed miss')
    assert.match(json.content, /YouTube video/, 'and this really is the oembed-miss card, not an enriched one')
  } finally {
    globalThis.fetch = saved
  }
})

test('A POST THAT ALREADY CARRIES A REAL DATE costs neither an R2 read nor a container call', async () => {
  // The steady state: liveFetchPost's cache-only read already filled it, so there is nothing here to
  // improve and the route must not pay for the attempt.
  const ref = ytRef('alreadyDat0')
  const filled = { ...vouchedPost(ref), createdAt: new Date(TS_RICK * 1000) }
  let gets = 0
  const r2 = fakeR2()
  const counting = { ...r2, async get(k) { gets++; return r2.get(k) } }
  const { seen, binding } = fakeResolver()
  const res = await handle(req(activity(ref)), envWith(binding, counting), ctx, deps(filled))
  assert.equal(await createdAt(res), ISO_RICK)
  assert.equal(seen.meta, 0)
  assert.equal(gets, 0, 'a post with a real date short-circuits before the R2 read')
})

/* ===================== THE DESCRIPTION, AND ITS CLAMP =============================
 *
 * These live here rather than beside the normalizer tests because the clamp is applied
 * at the WORKER boundary — the record is stored in R2 for 30 days, so trimming at
 * render time would keep paying to store and read the part we always discard.
 */

const contentOf = async res => (await res.json()).content

test('THE DESCRIPTION REACHES THE CARD from the container record', async () => {
  const ref = ytRef('descPlain01')
  const { binding } = fakeResolver({
    meta: () => Response.json({ timestamp: TS_RICK, description: 'A short caption.' }),
  })
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  assert.match(await contentOf(res), /A short caption\./)
})

test('ONLY THE FIRST PARAGRAPH, AND CAPPED — a description is not a caption', async () => {
  /**
   * THE RISK THIS CLOSES. YouTube descriptions run to 5000 characters of chapter lists, sponsor
   * blocks, affiliate links and social handles, and NOTHING in src/render/ truncates Post.text — it
   * would land verbatim in the Mastodon `content` AND in og:description, turning a card into a wall.
   *
   * The first blank line ends the part that reads like a caption; everything after it is reliably
   * boilerplate.
   */
  const ref = ytRef('descLong001')
  const body = 'The real caption.\n\nSUBSCRIBE: http://example.invalid/sub\nMerch: http://example.invalid/merch'
  const { binding } = fakeResolver({ meta: () => Response.json({ timestamp: TS_RICK, description: body }) })
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  const content = await contentOf(res)
  assert.match(content, /The real caption\./)
  assert.ok(!content.includes('SUBSCRIBE'), 'the boilerplate after the blank line is dropped')
  assert.ok(!content.includes('merch'), 'and so is everything after it')
})

test('A WALL OF TEXT WITH NO BLANK LINE IS STILL BOUNDED', async () => {
  const ref = ytRef('descWall001')
  const { binding } = fakeResolver({
    meta: () => Response.json({ timestamp: TS_RICK, description: 'x'.repeat(5000) }),
  })
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  const content = await contentOf(res)
  const run = (content.match(/x+/) || [''])[0]
  /**
   * REWRITTEN 2026-08-03. This asserted a 300-character bound and a '…', which were YT_DESC_MAX's.
   * A cap now applies to EVERY platform's body at render (DESC_MAX = 253, render/text.ts), and it is
   * tighter — so YouTube's own clamp no longer decides what reaches a card, and its marker never
   * surfaces. YT_DESC_MAX still exists and still matters: it bounds what is STORED IN R2 for 30 days.
   *
   * The rule this test exists for is unchanged — a 5000-character wall must not reach a card whole,
   * and must say it was cut rather than stopping mid-word in silence. Only the numbers moved.
   */
  assert.ok(run.length <= 253, `capped by DESC_MAX, was ${run.length}`)
  assert.match(content, /\.\.\./, 'and says it was cut rather than ending mid-word silently')
})

test('A JUNK DESCRIPTION IS NO DESCRIPTION — the date still lands', async () => {
  // The date and the body are independent; a bad body must not cost a good date.
  for (const description of [null, 42, {}, '', '   ']) {
    const ref = ytRef(`descJunk${String(description).slice(0, 3).padEnd(3, '_')}`)
    const { binding } = fakeResolver({ meta: () => Response.json({ timestamp: TS_RICK, description }) })
    const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
    assert.equal(await createdAt(res), new Date(TS_RICK * 1000).toISOString(),
      `${JSON.stringify(description)} must not cost the date`)
  }
})

test('A VIDEO OVER THE MUX CEILING IS NEVER DISPATCHED, and says why on the card', async () => {
  /**
   * Reported on /Jky5ZXI0axc — "still just pulling up as a frozen image". The still was CORRECT: that
   * video is 1431s, and worker.ts already cites that exact id as the measurement case for the degrade.
   * Three things AROUND it were wrong.
   *
   * The ceiling is now 1500s (25 minutes, owner's call). Past it, a video must:
   *   - dispatch NO mux, because the container refuses it and the duration is already known;
   *   - say so on the card — "when a post can't be shown, the card says why" is a promise the README
   *     makes, and a silent thumbnail is exactly the blank rectangle it promises not to be;
   *   - and be cacheable, because "too long" is permanent rather than pending.
   *
   * Before this, the reported video cost 5.2s on the HTML seam and 9.1s on the activity seam — then
   * 5.1s again on a SECOND view, because a degraded card is deliberately not response-cached.
   */
  const { seen, binding } = fakeResolver({
    meta: () => Response.json({ timestamp: TS_RICK, duration: 1600 }),
  })
  const ref = ytRef('tooLong0001')
  /**
   * `muxWarm: false` IS LOAD-BEARING, and its absence made the dispatch assertion below vacuous for
   * as long as it existed. fakeR2 answers `head()` with an object by DEFAULT so this file's other
   * tests are not dominated by mux timing — but that head is exactly what muxOnce short-circuits on,
   * so `seen.mux` read 0 whatever the duration said. Verified by re-running this shape with a
   * 60-second video: also 0. The assertion proved nothing about the guard it was named for.
   *
   * AND THE GUARD DID NOT FIRE. Repaired, this dispatches. The reason is a seam, not the guard:
   * settleMux and youtubeMeta run CONCURRENTLY (deliberately — serialising them costs every ordinary
   * video ~3s), so the duration that produces the note arrives on the overlay AFTER settleMux has
   * already decided. The post settleMux sees carries no duration at all, because normalizeYouTube
   * hardcodes `remux: { page }`. So the card told the truth and the container was called anyway.
   *
   * This test now pins that honest cold state; the sibling below pins the fix.
   */
  const res = await handle(req(activity(ref)), envWith(binding, fakeR2([], false)), ctx, deps(vouchedPost(ref)))
  const content = await contentOf(res)

  assert.match(content, /Too long to play here/, 'the card says why it is a picture')
  assert.equal(seen.mux, 1,
    'COLD, the mux is still dispatched — the duration reaches the card but not the decision. ' +
    'See the sibling test: it is the warm meta record, stamped onto the remux entry at fetch time, ' +
    'that closes this. If this ever reads 0 without that stamp, the seam changed and the comment above is stale.')
})

test('A POST THAT CARRIES ITS DURATION IS NEVER DISPATCHED — the guard, finally reachable', async () => {
  /**
   * THE ARM THIS COVERS HAD BEEN DEAD CODE ON YOUTUBE SINCE IT WAS WRITTEN. settleMux refuses to mux
   * a video past MUX_MAX_SECONDS, reading `m.duration` off the remux entry — and normalizeYouTube
   * never put one there. Every over-ceiling YouTube video was therefore dispatched to be told what
   * the 30-day meta record already knew, and with the alarm landed that is THREE container calls
   * across a 22-minute horizon, out of a pool of four slots shared by ten platforms, for an answer
   * that is final and identical in thirty days.
   *
   * `withMuxDuration(post, 1600)` is exactly what liveFetchPost's yt arm now produces when the meta
   * record is warm — the same function, called the same way. The record is filled by the activity
   * route and lives 30 days, so this is the state of every view after the first.
   *
   * THE CARD IS BYTE-IDENTICAL EITHER WAY. This buys no pixels; it buys the container slots, and it
   * flips /_card's `muxing` from true to false so the fixer page stops spinning for 25 seconds about
   * a video it is simultaneously telling the reader is too long to play.
   */
  const { seen, binding } = fakeResolver({
    meta: () => Response.json({ timestamp: TS_RICK, duration: 1600 }),
  })
  const ref = ytRef('tooLong0002')
  const post = withMuxDuration(vouchedPost(ref), 1600)
  const res = await handle(req(activity(ref)), envWith(binding, fakeR2([], false)), ctx, deps(post))
  const content = await contentOf(res)

  assert.match(content, /Too long to play here/, 'the card still says why it is a picture')
  assert.equal(seen.mux, 0, 'and NOW no mux is dispatched for a video the container would refuse')
})

test('A VIDEO INSIDE THE CEILING IS UNTOUCHED — the guard must not swallow ordinary videos', async () => {
  // The other half. 1500s is the line; anything under behaves exactly as before, note-free. A guard
  // that quietly widened would turn every long-ish video into a still, which is the reported defect
  // with a different cause.
  const { binding } = fakeResolver({
    meta: () => Response.json({ timestamp: TS_RICK, duration: 1400 }),
  })
  const ref = ytRef('okLength001')
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  const content = await contentOf(res)

  assert.ok(!/Too long to play here/.test(content), 'no note on a video that can play')
})

// ── The note and the description were alternatives, and both could be missing (2026-08-29).

/**
 * A VOUCHED POST THAT ALREADY CARRIES WHAT INNERTUBE SUPPLIES — a real upload date and a real body.
 *
 * NO TEST IN THIS FILE HAD THIS SHAPE, and that is why the two defects below survived. `vouchedPost`
 * has no `uploadedAt`, so its createdAt is the epoch, so youtubeMeta's third gate ("the post does not
 * already carry a real date") never fires and the meta call always runs. Since the Innertube source
 * landed (#61-#64) the date arrives at FETCH time on the common path, that gate returns null, and the
 * overlays above are all handed `undefined`. Every note test was therefore exercising the arm
 * production mostly does not take.
 */
const innertubePost = (ref, description) => normalizeYouTube({
  ok: true,
  oembed: {
    title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley',
    author_url: 'https://www.youtube.com/@RickAstley',
    thumbnail_url: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`,
  },
  uploadedAt: TS_RICK,
  description,
}, ref)

/** 3406s = 56:46. Over MUX_MAX_SECONDS (1500) by enough that no future ceiling nudge silences this. */
const TOO_LONG = 3406
const DESC = 'The Sydney Opera House concert, in full.'

test('THE NOTE AND THE DESCRIPTION BOTH SURVIVE — they were alternatives, and that was the bug', async () => {
  /**
   * withDescription bails with "A body already present wins", and both call sites nested
   * withLengthNote INSIDE it — so on a long video the note landed first and the real description was
   * then discarded. A reader got the note or the body, never both.
   *
   * Nothing about the note or the description changed to fix it; only which one runs first.
   */
  const ref = ytRef('longDesc001')
  const { binding } = fakeResolver({
    meta: () => Response.json({ timestamp: TS_RICK, duration: TOO_LONG, description: DESC }),
  })
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  const content = await contentOf(res)

  assert.match(content, /Too long to play here/, 'the card still says why it is a picture')
  assert.match(content, /Sydney Opera House/, 'AND it keeps the description the note used to eat')
})

test('THE DURATION COMES OFF THE MEDIA ENTRY when no meta call happens — the common path', async () => {
  /**
   * THE NOTE WAS UNREACHABLE ON THE PATH MOST PASTES TAKE. withLengthNote returned early unless it
   * was handed a usable `duration`, and its only supply was `meta?.duration` — which is undefined
   * whenever youtubeMeta declines, i.e. whenever Innertube already dated the post at fetch time.
   *
   * The duration is not missing in that state, only elsewhere: liveFetchPost's yt arm stamps it onto
   * the remux entry with withMuxDuration (`warm?.duration ?? got.duration`), which is exactly what
   * this post is built with. Reading it back from there is the whole fix.
   *
   * `seen.meta` is asserted at 0 because that is the precondition, not a bonus: if the container is
   * ever called here, the post did not have its date and this test stopped covering the defect.
   */
  const ref = ytRef('stampDur001')
  const post = withMuxDuration(innertubePost(ref, DESC), TOO_LONG)
  const { seen, binding } = fakeResolver()
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(post))
  const content = await contentOf(res)

  assert.equal(seen.meta, 0, 'a post that already carries its date makes NO meta call — that is the gate')
  assert.match(content, /Too long to play here/, 'and the note fires anyway, off the stamped entry')
  assert.match(content, /Sydney Opera House/, 'without costing the description')
})

test('BOTH SEAMS: /_card keeps the note AND the description', async () => {
  /**
   * The activity callback is not the only place the overlays are applied — describeTarget feeds
   * /_card and /_api/v1 from the same record, with the same nesting and therefore the same defect.
   * "BOTH SEAMS OR NEITHER" is the rule worker.ts states at the other site; this is the half of it
   * that had no test.
   *
   * Unlike the activity route, this seam falls back to readCachedMeta when youtubeMeta declines, so a
   * dated post with a warm record still gets the duration and the description as ARGUMENTS — which is
   * the ordering half of the fix, on the other seam.
   */
  const ref = ytRef('cardBoth001')
  const r2 = fakeR2([[metaCacheKey(ref),
    JSON.stringify({ timestamp: TS_RICK, duration: TOO_LONG, description: DESC })]])
  const { seen, binding } = fakeResolver()
  const res = await handle(
    new Request(`https://staging.megapenispoopenfarten.sex/_card?p=${encodeURIComponent(`/watch?v=${ref.id}`)}`),
    { ...envWith(binding, r2), TRANSLATE_GOOGLE: 'off' }, ctx, deps(innertubePost(ref, '')),
  )
  const card = await res.json()

  assert.equal(seen.meta, 0, 'the warm record answers; no container call')
  assert.match(card.text, /Too long to play here/, 'the page is told why it will not get a player')
  assert.match(card.text, /Sydney Opera House/, 'and still gets the description')
})

// ── A broadcast with no finished file behind it (2026-08-29).

/**
 * WHAT A COLD LIVE PASTE ACTUALLY LOOKS LIKE. `isLive` comes off the Innertube call inside
 * fetchYouTube, so it is on the fetch result before the Post exists — no warm record, no container.
 * This is the exact shape liveFetchPost's yt arm hands the normalizer on the FIRST paste.
 */
const broadcastPost = (ref, isLive) => normalizeYouTube({
  ok: true,
  oembed: {
    title: 'Watch Sky News', author_name: 'Sky News',
    author_url: 'https://www.youtube.com/@SkyNews',
    thumbnail_url: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`,
  },
  uploadedAt: TS_RICK,
  isLive,
}, ref)

test('A LIVE STREAM DISPATCHES NOTHING AND SAYS WHY — the doomed mux, on every paste, forever', async () => {
  /**
   * THE DEFECT, probed on yt:xDWQ3LkccY8 (Sky News, permanently live): pinned at `muxing: true`, ~1.7s
   * of container round trip on EVERY render, never cached. A live stream reports `lengthSeconds: '0'`,
   * so it carries no duration, so the over-ceiling arm — the only refusal settleMux had — never fired.
   * The container then refuses it on its own `--match-filter "duration<?1500 & !is_live"`, the card is
   * marked degraded, and worker.ts declines to cache a degraded card. So the next render repeats it.
   * News channels post these constantly.
   *
   * `muxWarm: false` is load-bearing here for the reason the over-ceiling test records: fakeR2's
   * default head() short-circuits muxOnce, which would make the dispatch assertion vacuous.
   */
  const ref = ytRef('liveNow0001')
  const { seen, binding } = fakeResolver()
  const res = await handle(
    req(activity(ref)), envWith(binding, fakeR2([], false)), ctx, deps(broadcastPost(ref, true)))
  const content = await contentOf(res)

  assert.equal(seen.mux, 0, 'no container call for a stream the container will refuse')
  assert.equal(seen.meta, 0, 'and none for the metadata either — the post already carries its date')
  assert.match(content, /Live stream/, 'the card says why it is a picture, not a player')
  assert.ok(!/Too long to play here/.test(content), 'and says it once — the length note stands down')
})

test('AND THE LIVE CARD CACHES — that is the half that stops it repeating', async () => {
  /**
   * `degraded` means "incomplete, something is still coming". A live stream is not that: the answer is
   * final for as long as the broadcast runs, and re-deciding it every render is the cost this whole
   * arm exists to stop paying. /_card's `muxing` is the flag the render path reads to decide whether
   * the response may be cached, and it is what the fixer page spins on.
   */
  const ref = ytRef('liveNow0002')
  const { binding } = fakeResolver()
  const res = await handle(
    new Request(`https://staging.megapenispoopenfarten.sex/_card?p=${encodeURIComponent(`/watch?v=${ref.id}`)}`),
    { ...envWith(binding, fakeR2([], false)), TRANSLATE_GOOGLE: 'off' }, ctx, deps(broadcastPost(ref, true)),
  )
  const card = await res.json()

  assert.equal(card.muxing, false, 'not degraded, so the response caches and the page stops spinning')
  assert.match(card.text, /Live stream/)
})

test('AN ENDED STREAM IS AN ORDINARY VIDEO AND MUXES — the guard must not swallow the archive', async () => {
  /**
   * The other half, and the one that decides whether this is safe. A finished broadcast is a normal
   * VOD: `isLiveContent` stays true forever, `isLive` goes false, and a real length appears. Refusing
   * those would take the player away from every past stream a channel has published — a far bigger
   * card regression than the one being fixed. Measured shape: yt:0cVnt1bUzLI, 3764s, endTimestamp set.
   */
  const ref = ytRef('wasLive0001')
  const { seen, binding } = fakeResolver()
  const post = withMuxDuration(broadcastPost(ref, false), 600)
  const res = await handle(
    req(activity(ref)), envWith(binding, fakeR2([], false)), ctx, deps(post))
  const content = await contentOf(res)

  assert.equal(seen.mux, 1, 'the mux runs exactly as it would for a video that was never live')
  assert.ok(!/Live stream/.test(content), 'and the card carries no note about it')
})

/** Swap the module-level offline stub for one test, and put it back however the test ends. */
const withFetch = async (impl, fn) => {
  const prev = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = prev }
}

/** A minimal `youtubei/v1/player` body the parser accepts. `extra` decides the broadcast state. */
const innertubeBody = extra => JSON.stringify({
  videoDetails: { lengthSeconds: '213', viewCount: '100', shortDescription: 'body', ...extra },
  microformat: { playerMicroformatRenderer: { publishDate: '2009-10-24T23:57:33-07:00' } },
})

const answering = innertube => async (url) => {
  const u = String(url)
  if (u.includes('/youtubei/')) return innertube()
  if (u.includes('youtube.com/oembed')) {
    return Response.json({
      title: 'Watch Sky News', author_name: 'Sky News',
      author_url: 'https://www.youtube.com/@SkyNews',
    })
  }
  throw new Error(`unexpected call: ${u}`)
}

test('A FRESH "NOT LIVE" BEATS A 30-DAY RECORD THAT SAYS LIVE — the one field the record loses', async () => {
  /**
   * Every other field on the meta record wins over the fetch because it cannot change. Liveness can,
   * in the direction that matters: a stream ends and becomes a muxable VOD. The record lives 30 days,
   * so preferring it would refuse a player for a month after the broadcast finished — a worse card
   * than the one this change exists to fix.
   *
   * This goes through liveFetchPost rather than the routes because the routes stub fetchPost, so the
   * merge itself has no coverage from them.
   */
  const ref = ytRef('endedRec001')
  const r2 = fakeR2([[metaCacheKey(ref), JSON.stringify({ timestamp: TS_RICK, isLive: true })]])
  const { liveFetchPost } = await import('../src/worker.ts')
  const post = await withFetch(
    answering(() => new Response(innertubeBody({}), { headers: { 'content-type': 'application/json' } })),
    () => liveFetchPost(ref, envWith(fakeResolver().binding, r2), 'discord'))

  assert.equal(post.media[0].live, undefined, 'the stale record does not pin the still')
  assert.ok(post.media[0].remux, 'the video is kept, so it muxes on the next render')
  assert.ok(!/Live stream/.test(post.text))
})

test('A REFUSED INNERTUBE CALL IS NOT A "NO" — then the record is the only answer there is', async () => {
  /**
   * The other side of the same `??`. Cloudflare's egress is refused on roughly half of these calls
   * (see resolveYouTubeMeta), and a refusal carries `undefined`, not `false` — which is the entire
   * reason the verdict is three-valued from the wire down. Collapse the two and persisting it buys
   * nothing: the second paste would re-flip the same coin.
   */
  const ref = ytRef('liveRec0001')
  const r2 = fakeR2([[metaCacheKey(ref), JSON.stringify({ timestamp: TS_RICK, isLive: true })]])
  const { liveFetchPost } = await import('../src/worker.ts')
  const post = await withFetch(
    answering(() => new Response('nope', { status: 503 })),
    () => liveFetchPost(ref, envWith(fakeResolver().binding, r2), 'discord'))

  assert.equal(post.media[0].live, true, 'the record answers, so the mux is still refused')
  assert.match(post.text, /Live stream/, 'and the card still says why')
})

test('A RECORD THAT SAYS LIVE EXPIRES IN AN HOUR — the one field that is not immutable', async () => {
  /**
   * THE DEFECT, found in review 2026-08-29 and the reason the yt reads pass a FUNCTION for their TTL.
   * `isLive` is the only mutable field on a YouTubeMeta record and it moves in the direction that
   * costs a card: the stream ends and becomes an ordinary muxable VOD. Nothing rewrites the record —
   * metaAttempt runs only on a read miss, and youtubeMeta returns null the moment the post carries a
   * real date, which a live stream always does. So under the flat 30-day TTL a finished broadcast kept
   * saying "🔴 Live stream, so no preview here" on every render whose own Innertube call was refused,
   * for up to a MONTH, on a card that caches.
   *
   * Both directions are pinned. An expired live record must not be believed, and a fresh one must —
   * a fix that simply stopped reading the flag would pass half of this and re-flip the coin on every
   * cold paste, which is what persisting it was for.
   */
  const { liveFetchPost } = await import('../src/worker.ts')
  const refused = () => new Response('nope', { status: 503 })
  const at = mins => new Date(Date.now() - mins * 60_000)
  const rec = JSON.stringify({ timestamp: TS_RICK, isLive: true })

  const stale = ytRef('liveTtl0001')
  const post = await withFetch(answering(refused), () => liveFetchPost(
    stale, envWith(fakeResolver().binding, fakeR2([[metaCacheKey(stale), rec, at(120)]])), 'discord'))
  assert.equal(post.media[0].live, undefined, 'two hours on, the record no longer pins the still')
  assert.ok(!/Live stream/.test(post.text), 'and the card stops claiming a broadcast that may be over')

  const fresh = ytRef('liveTtl0002')
  const post2 = await withFetch(answering(refused), () => liveFetchPost(
    fresh, envWith(fakeResolver().binding, fakeR2([[metaCacheKey(fresh), rec, at(10)]])), 'discord'))
  assert.equal(post2.media[0].live, true, 'ten minutes on, it is still the best answer there is')

  // AND THE REST OF THE RECORD KEEPS THIRTY DAYS. Only liveness is short-lived; expiring an upload
  // date every hour would re-pay the container/Innertube cost this cache exists to stop paying.
  const old = ytRef('liveTtl0003')
  const post3 = await withFetch(answering(refused), () => liveFetchPost(
    old, envWith(fakeResolver().binding,
      fakeR2([[metaCacheKey(old), JSON.stringify({ timestamp: TS_RICK }), at(120)]])), 'discord'))
  assert.equal(post3.createdAt.toISOString(), ISO_RICK, 'a two-hour-old ordinary record is untouched')
})

test('THE LIVE VERDICT IS PERSISTED, which is what makes the SECOND paste of a stream free', async () => {
  /**
   * The render path's own Innertube call is refused on roughly half of requests from this egress, so
   * without a record the liveness coin is re-flipped on every cold post fetch and half the pastes go
   * back to dispatching a doomed mux. resolveYouTubeMeta is the rung that writes: it is reached from
   * the activity route when the post has no date yet, asks Innertube again, and hands the answer to
   * metaAttempt -> metaWork, which puts it in R2.
   *
   * The post here is VOUCHED and dateless, which is exactly the state a first paste is left in when
   * the render's Innertube call was refused — the case this write exists for.
   */
  const ref = ytRef('liveWrite01')
  const r2 = fakeR2()
  // Slow on purpose (2026-09-04): the container now runs BESIDE Innertube, and an instant fake would
  // win the race with a record that carries no live verdict — which is not the write under test.
  const { seen, binding } = fakeResolver({ meta: () => new Promise(r => setTimeout(() => r(Response.json({ timestamp: TS_RICK })), 3100)) })
  await withFetch(
    answering(() => new Response(
      innertubeBody({ lengthSeconds: '0', isLive: true }), { headers: { 'content-type': 'application/json' } })),
    () => handle(req(activity(ref)), envWith(binding, r2), ctx, deps(vouchedPost(ref))))

  const written = r2.store.get(metaCacheKey(ref))
  assert.ok(written, 'the answer is persisted rather than re-derived per paste')
  const got = JSON.parse(new TextDecoder().decode(written.bytes))
  assert.equal(got.isLive, true, 'including the verdict the next cold render needs')
  assert.equal(got.duration, undefined, "and lengthSeconds '0' is still absent, not a zero-second video")
  assert.ok(seen.meta <= 1, 'the container may be asked beside Innertube since 1.15.2; its slower answer is not the one written')
})

test('A "NOT LIVE" IS NEVER WRITTEN — absence is what every older record means', async () => {
  /**
   * The record is three-valued only because absence means "unknown". Writing `isLive: false` would
   * make it two-valued from the storage side while every pre-2026-08-29 record and every container
   * answer still means unknown by being absent — two spellings of one value, which is how the merge
   * in liveFetchPost's yt arm would start believing silence.
   */
  const ref = ytRef('liveWrite02')
  const r2 = fakeR2()
  const { binding } = fakeResolver()
  await withFetch(
    answering(() => new Response(innertubeBody({}), { headers: { 'content-type': 'application/json' } })),
    () => handle(req(activity(ref)), envWith(binding, r2), ctx, deps(vouchedPost(ref))))

  const got = JSON.parse(new TextDecoder().decode(r2.store.get(metaCacheKey(ref)).bytes))
  assert.equal('isLive' in got, false, 'an ordinary video stores no liveness key at all')
})

test('THE LIVE NOTE ARRIVES FROM THE RECORD TOO, on BOTH seams — not only from the fetch', async () => {
  /**
   * The other half of the overlay, and the one the route tests above cannot reach: `broadcastPost`
   * gets its note at BUILD time from normalizeYouTube, so every assertion about it so far has been
   * about the media-flag fallback. Both seams also pass the record's verdict as an ARGUMENT
   * (`meta?.isLive` on the activity callback, `warm.isLive` in describeTarget), which is the supply
   * on a post built before the record existed — a first paste whose Innertube call was refused,
   * followed by a second that filled the record.
   *
   * The post here is deliberately NOT marked live, so only the argument can produce the note. That
   * makes the card mildly incoherent (a playable video with a live note) and that is the point: it
   * isolates the seam from the flag.
   */
  const seed = ref => fakeR2([[metaCacheKey(ref), JSON.stringify({ timestamp: TS_RICK, isLive: true })]])

  const a = ytRef('liveSeam001')
  const res = await handle(req(activity(a)), envWith(fakeResolver().binding, seed(a)), ctx, deps(vouchedPost(a)))
  assert.match(await contentOf(res), /Live stream/, 'the activity document reads the record')

  const c = ytRef('liveSeam002')
  const card = await (await handle(
    new Request(`https://staging.megapenispoopenfarten.sex/_card?p=${encodeURIComponent(`/watch?v=${c.id}`)}`),
    { ...envWith(fakeResolver().binding, seed(c)), TRANSLATE_GOOGLE: 'off' }, ctx, deps(vouchedPost(c)),
  )).json()
  assert.match(card.text, /Live stream/, 'and so does /_card, through describeTarget — BOTH OR NEITHER')
})

// ── The date that arrives as `upload_date` instead of `timestamp` (2026-08-04).

test('A DICT WITH NO timestamp BUT AN upload_date STILL DATES THE CARD', async () => {
  /**
   * THE REPORTED DEFECT: "YouTube links still show the epoch occasionally when cold."
   *
   * yt-dlp builds `timestamp` ONLY from a timezone-bearing microformat, and several of its YouTube
   * player clients do not carry one. On those responses the dict comes back complete — title,
   * description, counts, duration, age_limit — with `timestamp: null` and `upload_date: '20091025'`
   * right beside it. The container forwarded only `timestamp`, and the worker required a numeric one
   * to accept a record at all, so the WHOLE dict was discarded: no date, no description, no counts,
   * and nothing written to R2 to heal from. Which client answers varies per request, which is exactly
   * why the same video was fine on one paste and epoch on the next.
   *
   * Asserted on `created_at` from the activity callback, because that is the field Discord actually
   * draws the date from — the plain OG head emits no date tag at all.
   */
  const ref = ytRef('upldate0001')
  const { seen, binding } = fakeResolver({
    meta: () => Response.json({ title: 'a video', timestamp: null, upload_date: '20091025' }),
  })
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  assert.equal(seen.meta, 1, 'the container was asked')
  assert.equal(await createdAt(res), '2009-10-25T00:00:00.000Z',
    'UTC midnight of the upload day — day precision is what upload_date carries, and it is not the epoch')
})

test('timestamp WINS OVER upload_date when the dict carries both', async () => {
  /**
   * `upload_date` is a bare day, so it becomes midnight UTC; `timestamp` carries the real instant.
   * Nothing renders a clock time today, so this is not about what a card shows — it is about what
   * gets PERSISTED for 30 days and sorted on later. Preferring the coarser field because it happened
   * to be read first is the kind of thing that is invisible until somebody sorts two same-day uploads.
   */
  const ref = ytRef('upldate0002')
  const { binding } = fakeResolver({
    meta: () => Response.json({ title: 'a video', timestamp: TS_RICK, upload_date: '20200101' }),
  })
  const res = await handle(req(activity(ref)), envWith(binding), ctx, deps(vouchedPost(ref)))
  assert.equal(await createdAt(res), ISO_RICK, 'the precise instant, not midnight of the other day')
})

test('AN ANSWER WITH NO USABLE DATE DOES NOT NEGATIVELY CACHE THE VIDEO — our rejection is not its verdict', async () => {
  /**
   * THE AMPLIFIER, and the reason the defect above was durable rather than a one-view blip.
   *
   * metaAttempt reads a resolved null as "the extract's own verdict — the page is gone, blocked or
   * unextractable" and marks the id failed for META_FAIL_TTL_MS (60s per isolate). A dict rejected
   * because OUR validator wanted a field is not that: it is evidence about us. Read as a verdict, it
   * refused the one thing that could have healed the card — asking again — for a minute.
   *
   * So the unusable answer is THROWN, and metaAttempt's rejection arm (which deliberately does not
   * mark, and says so) is the one that runs. Pinned by dispatching TWICE and requiring the second
   * call to happen: before this, the second was refused and the card stayed epoch.
   */
  const ref = ytRef('upldate0003')
  const { seen, binding } = fakeResolver({
    // No timestamp and no upload_date: the residual case, after the fix above removes the common one.
    meta: () => Response.json({ title: 'a video' }),
  })
  const env = envWith(binding)

  const first = await handle(req(activity(ref)), env, ctx, deps(vouchedPost(ref)))
  assert.equal(await createdAt(first), '1970-01-01T00:00:00.000Z', 'no date anywhere, so no date is honest')
  assert.equal(seen.meta, 1)

  const second = await handle(req(activity(ref)), env, ctx, deps(vouchedPost(ref)))
  assert.equal(seen.meta, 2,
    'the retry is ALLOWED — a rejection of ours must not spend the video\'s 60-second negative cache')
  await second.json()
})

test('THE CONTAINER FORWARDS upload_date — the worker cannot fall back to a field it is never sent', () => {
  /**
   * The Node half of this fix is unreachable without the Python half, and the two live in different
   * languages in different processes, so nothing else fails when they drift. Same instrument, and the
   * same reason, as the argv-splice pin in ytdlp-tier.test.mjs: a grep is a poor test and a much
   * better tripwire than the nothing that was there before.
   */
  const py = readFileSync(new URL('../container/server.py', import.meta.url), 'utf8')
  assert.match(py, /"upload_date":\s*d\.get\("upload_date"\)/,
    '_meta_page must forward upload_date alongside timestamp')
})
