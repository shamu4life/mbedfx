import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, metaCacheKey } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
import { normalizeYouTube, withMuxDuration } from '../src/platforms/youtube/normalize.ts'
import { readFileSync } from 'node:fs'

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
   * THE BOUND MOVED 8000 -> 9000 when META_WAIT_API_MS went 4000 -> 8000, and the ASSERTION IS
   * UNCHANGED IN INTENT: the wait must stay bounded rather than becoming the container's own timeout.
   *
   * 9000 is not an arbitrary bump — it is MUX_WAIT_API_MS, the ceiling this route already accepts on
   * the very same Promise.all. That is the entire justification for raising the meta wait: on a first
   * paste the mux is cold by definition, so the meta wait happens INSIDE a wait that is happening
   * anyway. A number above 9000 here would stop expressing "bounded by the route" and start
   * expressing nothing.
   *
   * 4000 was under the thing it was waiting for (`yt-dlp -J` measures 2.3-6.7s), which is why the
   * first activity callback on a cold video rendered 1 January 1970 — the reported bug.
   */
  assert.ok(elapsed < 9000, `the bounded wait must not become the container's own timeout (${elapsed}ms)`)
  assert.equal(seen.meta, 1)
  assert.ok(waits.length > 0, 'the extract keeps running past the response rather than being abandoned')
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
