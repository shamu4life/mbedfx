import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, liveFetchPost, metaCacheKey, HTML_DEADLINE_MS, MUX_WAIT_FLOOR_MS } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { cacheUrl, postCacheKey, serializePost } from '../src/cache.ts'

/**
 * The Facebook orchestration, driven through the real dispatcher with mocked bindings — no container,
 * no real R2, no network. It pins the three defects measured on
 * https://staging.megapenispoopenfarten.sex/share/v/Fixture03X/ on 2026-07-25:
 *
 *   (a) 12.3s to render (Discord times out) — because the meta call and the mux ran SERIALLY, on two
 *       different container instances, and the 3s mux wait was ADDED after the 3s fetch;
 *   (b) og:video:width="0" for a real 576x1024 video;
 *   (c) og:title "Facebook (@facebook)" for a video whose creator "PhillyBanana" was sitting in a
 *       structured field the Worker was dropping at two layers.
 *
 * (b) and (c) are pinned in facebook-normalize.test.mjs and render.test.mjs (they are pure); this file
 * is the orchestration half.
 */

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

/**
 * In-memory R2 with the two fields cachedFacebookMeta reads: `uploaded` and `json()`.
 *
 * `latencyMs` models what a real R2 `head` costs — an RPC, not a synchronous map lookup. It defaults
 * to 0 (every other test here wants the fast path), and the one test that sets it is the one whose
 * whole subject is a race against a timer: a 0ms budget beats an RPC every time, so an instant fake
 * would hide the very defect that test exists to pin.
 */
function fakeR2(seed = [], latencyMs = 0) {
  const store = new Map()
  for (const [k, v, uploaded] of seed) store.set(k, { bytes: new TextEncoder().encode(v), uploaded: uploaded ?? new Date() })
  return {
    store,
    async head(k) {
      if (latencyMs) await new Promise(r => setTimeout(r, latencyMs))
      const v = store.get(k)
      return v ? { size: v.bytes.length } : null
    },
    async get(k, opts) {
      const v = store.get(k)
      if (!v) return null
      const body = opts?.range
        ? v.bytes.slice(opts.range.offset ?? 0, (opts.range.offset ?? 0) + (opts.range.length ?? v.bytes.length))
        : v.bytes
      return {
        body: new Response(body).body, size: v.bytes.length, uploaded: v.uploaded,
        async json() { return JSON.parse(new TextDecoder().decode(v.bytes)) },
      }
    },
    async put(k, body) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body).arrayBuffer())
      store.set(k, { bytes, uploaded: new Date() })
    },
  }
}

const FB_REF = { p: 'fb', kind: 'watch', id: '10153231379946729' }
const FB_PATH = '/watch?v=10153231379946729'
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const req = (path, ua = DISCORD) =>
  new Request(`https://staging.megapenispoopenfarten.sex${path}`, { headers: { 'user-agent': ua } })

/** The g3 meta dict, as the container returns it (snake_case, straight off `yt-dlp -J`). */
const META_JSON = {
  title: '3.9K reactions · 292 shares | Are you “Disturbed” | PhillyBanana',
  thumbnail: 'https://scontent.xx.fbcdn.net/thumb.jpg',
  uploader: 'PhillyBanana ', uploader_id: '61554703834017', uploader_url: null,
  description: 'Are you “Disturbed”', width: 576, height: 1024, duration: 150.209, timestamp: 1784218446,
}
const MP4 = 'FAKE-MP4-BYTES'

/**
 * A resolver that records every getByName NAME and every /resolve body, and answers meta calls with
 * JSON and mux calls with mp4 bytes. `impl` overrides either half.
 */
function fakeResolver(impl = {}) {
  const seen = { names: [], meta: 0, mux: 0, at: [] }
  const binding = {
    getByName(name) {
      seen.names.push(name)
      return {
        async fetch(_url, init) {
          const body = JSON.parse(init.body)
          seen.at.push(Date.now())
          if (body.meta === true) {
            seen.meta++
            return impl.meta ? impl.meta(seen) : Response.json(META_JSON)
          }
          seen.mux++
          return impl.mux ? impl.mux(seen) : new Response(MP4, { headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } })
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
const deps = (fetchPost = liveFetchPost) => ({
  cache: fakeCache(), fetchPost,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

test('SLOT AFFINITY: one post\'s meta call and its mux land on the SAME container instance', async () => {
  // THE 74% DEFECT. Both call sites used to hash their own OPERATION key — `meta/{ref}` and
  // `mux/{ref}/{i}` — which sent one post's two calls to different pooled instances 74% of the time
  // (measured over 2000 synthetic refs; this very ref hashed to slot 0 for meta and slot 2 for mux).
  // A Facebook post needs BOTH, so it could pay two cold container boots back to back on the one path
  // where latency is a correctness issue.
  const { seen, binding } = fakeResolver()
  await handle(req(FB_PATH), envWith(binding), ctx, deps())
  assert.ok(seen.meta >= 1 && seen.mux >= 1, 'both a meta call and a mux must have happened')
  assert.equal(new Set(seen.names).size, 1, `all calls for one ref must share one instance: ${[...new Set(seen.names)]}`)
  // And the name is derived from the POST, so it is stable across requests for the same ref.
  const first = seen.names[0]
  await handle(req(FB_PATH), envWith(binding), ctx, deps())
  assert.ok(seen.names.every(n => n === first), 'the slot must be a pure function of the ref')
})

test('THE CREATOR AND THE REAL DIMENSIONS SURVIVE the container -> Worker -> normalizer trip', async () => {
  // The end-to-end version of (b) and (c): the fields were being dropped at TWO layers (the Worker's
  // response type, then FacebookMeta), so a unit test on either half alone could not see it.
  const { binding } = fakeResolver()
  const html = await (await handle(req(FB_PATH), envWith(binding), ctx, deps())).text()
  assert.match(html, /og:title" content="PhillyBanana \(@PhillyBanana\)"/)
  assert.ok(!html.includes('Facebook (@facebook)'), 'the platform byline must not survive a real creator')
  assert.match(html, /og:video:width" content="576"/)
  assert.match(html, /og:video:height" content="1024"/)
  // THE PACKED og:title MUST NOT BECOME THE BODY — the measured description defect.
  assert.match(html, /og:description" content="Are you .Disturbed."/)
  assert.ok(!html.includes('3.9K reactions'), 'the packed counts string must be absent from the head')
})

test('THE OLD PRE-g3 DICT still renders: a non-atomic deploy degrades, never throws', async () => {
  // A pooled instance keeps running the image it booted with until sleepAfter (10m), so this response
  // is live for minutes after a redeploy.
  const old = { title: 'A funny clip', thumbnail: 'https://scontent.xx.fbcdn.net/t.jpg', uploader: 'PhillyBanana' }
  const { binding } = fakeResolver({ meta: () => Response.json(old) })
  const html = await (await handle(req(FB_PATH), envWith(binding), ctx, deps())).text()
  assert.match(html, /og:title" content="PhillyBanana/)
  assert.match(html, /og:description" content="A funny clip"/)
  // No dimensions were reported, so the card ships 0,0 — byte-for-byte what YouTube, the other {page}
  // remux platform, has always shipped (Discord reads the muxed mp4's real dimensions). An earlier
  // version of this line asserted the tags were ABSENT, which came from a `<= 0` gate in dimTags that
  // was reverted the same day: it would have subtracted those tags from five verified platforms'
  // heads. The measured 0x0 defect is fixed at the SOURCE — see the g4 test below.
  assert.deepEqual([...html.matchAll(/og:video:width" content="([^"]*)"/g)].map(m => m[1]), ['0'])
})

test('a meta response with NO title is a null Post — the content assertion, not the status', async () => {
  /**
   * THE PAGE AND PLUGIN SURFACES ARE STUBBED, and until 2026-08-11 they were not — this test reached
   * the REAL facebook.com, which is the one thing the suite is not allowed to do. It passed by
   * accident: the plugin fragment for this video carries its byline UNLINKED, the parser could not
   * read that shape, and "no card" looked like the assertion holding. Teaching the parser the second
   * byline shape turned the same live fetch into a real card and the test went red — a network
   * dependency reporting itself, three years' worth of luck later than it should have.
   *
   * The stub answers with the plugin's own measured error state, so the fall-through arms find nothing
   * and the subject of this test — a container extract with no title must not become a card — is what
   * the assertion actually measures.
   */
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(
    '<html><body><div class="pam uiBoxWhite"><p class="_1q3v">This Facebook post is no longer available.'
    + '</p></div></body></html>', { headers: { 'content-type': 'text/html' } })
  try {
    for (const bad of [{}, { title: '' }, { title: 42 }]) {
      const { binding } = fakeResolver({ meta: () => Response.json(bad) })
      const html = await (await handle(req(FB_PATH), envWith(binding), ctx, deps())).text()
      assert.match(html, /couldn't load/i, `a gone/blocked extract must render the failure card: ${JSON.stringify(bad)}`)
    }
  } finally {
    globalThis.fetch = real
  }
})

test('THE META R2 CACHE: a fresh object is used and the container is never called', async () => {
  const key = metaCacheKey(FB_REF)
  const stored = { title: 'cached title', uploader: 'PhillyBanana', w: 576, h: 1024 }
  const r2 = fakeR2([[key, JSON.stringify(stored)]])
  const { seen, binding } = fakeResolver()
  const html = await (await handle(req(FB_PATH), envWith(binding, r2), ctx, deps())).text()
  assert.equal(seen.meta, 0, 'a warm meta entry must cost NO container call')
  assert.match(html, /og:description" content="cached title"/)
})

test('THE META R2 CACHE: an object older than the TTL is ignored and re-extracted', async () => {
  const key = metaCacheKey(FB_REF)
  const stale = new Date(Date.now() - 86_400_000 - 60_000)   // 24h + 1min
  const r2 = fakeR2([[key, JSON.stringify({ title: 'STALE' }), stale]])
  const { seen, binding } = fakeResolver()
  const html = await (await handle(req(FB_PATH), envWith(binding, r2), ctx, deps())).text()
  assert.equal(seen.meta, 1, 'a stale entry must be re-extracted')
  assert.ok(!html.includes('STALE'))
})

test('THE META R2 CACHE: a success is written, a FAILURE is never written', async () => {
  const key = metaCacheKey(FB_REF)
  const okR2 = fakeR2()
  const { binding: okBinding } = fakeResolver()
  await handle(req(FB_PATH), envWith(okBinding, okR2), ctx, deps())
  assert.ok(okR2.store.has(key), 'a successful extract is cached for 24h')

  const badR2 = fakeR2()
  const { binding: badBinding } = fakeResolver({ meta: () => new Response('nope', { status: 502 }) })
  await handle(req(FB_PATH), envWith(badBinding, badR2), ctx, deps())
  assert.ok(!badR2.store.has(key), 'a failed extract must NEVER be cached — it self-heals next unfurl')
})

test('THE META R2 CACHE: the GENERATION is in the key, so a bump misses the old entry', async () => {
  /**
   * A redeploy is not atomic. During a rollout a PRE-BUMP pooled instance still answers, and without
   * the generation in the key its thinner dict is PERSISTED for 24h — so after the rollout completes
   * the card STILL ships with no dimensions, no caption and no timestamp, on every colo, not fixable by
   * re-pasting. Same argument container/README.md already makes for instance names: the bump has to be
   * the SINGLE invalidation switch, covering both the instances that produce an answer and the answers
   * we kept.
   *
   * Asserted against a key built the OLD way rather than by mutating the constant: this is exactly what
   * a pre-bump object in the live bucket looks like on the morning after.
   */
  const key = metaCacheKey(FB_REF)
  assert.notEqual(key, `meta/${refKey(FB_REF)}.json`, 'the key must carry a generation segment')
  for (const older of [`meta/${refKey(FB_REF)}.json`, `meta/g3/${refKey(FB_REF)}.json`, `meta/g4/${refKey(FB_REF)}.json`]) {
    const r2 = fakeR2([[older, JSON.stringify({ title: 'PRE-BUMP TITLE' })]])
    const { seen, binding } = fakeResolver()
    const html = await (await handle(req(FB_PATH), envWith(binding, r2), ctx, deps())).text()
    assert.equal(seen.meta, 1, `a pre-bump entry must be invisible: ${older}`)
    assert.ok(!html.includes('PRE-BUMP TITLE'), `a pre-bump entry must never reach the card: ${older}`)
    assert.ok(r2.store.has(key), 'and the fresh answer lands under the CURRENT generation')
  }
})

test('THE META R2 CACHE: a corrupt stored object falls through to the container, never throws', async () => {
  const key = metaCacheKey(FB_REF)
  for (const junk of ['not json at all', '{"title":""}', 'null']) {
    const { seen, binding } = fakeResolver()
    const html = await (await handle(req(FB_PATH), envWith(binding, fakeR2([[key, junk]])), ctx, deps())).text()
    assert.equal(seen.meta, 1, `a corrupt entry must be refetched: ${junk}`)
    assert.ok(!/couldn't load/i.test(html))
  }
})

/**
 * A post cache PRE-SEEDED with `post` — the state that says "a real fetch+normalize has already
 * vouched for this ref", which is what the prewarm is now gated on.
 */
function depsWithCachedPost(post, fetchPost = liveFetchPost) {
  const d = deps(fetchPost)
  d.cache.put(cacheUrl(postCacheKey(post.ref)), new Response(serializePost(post)))
  return d
}

/**
 * A cached fb Post carrying NO media at all. Deliberate: settleMux only touches entries with
 * `remux.page`, so with an empty media list the ONLY thing in the whole route that can call the
 * container is the prewarm. That is what makes the assertion below attributable to the prewarm rather
 * than to the render's own mux, and it is also prewarmable()'s actual claim — the mux source comes
 * from the REF alone, with no upstream call and nothing read off the post.
 */
const mediaLessPost = () => ({
  ref: FB_REF, canonical: 'https://www.facebook.com/watch/?v=10153231379946729',
  author: { name: 'PhillyBanana', handle: 'PhillyBanana', url: 'https://www.facebook.com/61554703834017' },
  text: 'seeded', createdAt: new Date('2026-07-16T16:14:06Z'), counts: {}, sensitive: false, media: [],
})

test('PREWARM: a ref the post cache already holds dispatches the mux from the REF alone', async () => {
  // The latency fix, scoped. The mux source is a PURE function of the ref (fbPageUrl), so it never has
  // to wait on anything the post says — measured 2026-07-25, meta ~3.0s + mux 4.1s serial is 7s+ and
  // the old 3s wait expired, degrading the card AND leaving it uncached so the next fetch redid it all.
  const { seen, binding } = fakeResolver()
  await handle(req(FB_PATH), envWith(binding), ctx, depsWithCachedPost(mediaLessPost()))
  assert.equal(seen.mux, 1, 'the warm ref must still prewarm its mux')
})

test('PREWARM SCOPE: an unknown, never-fetched ref costs ZERO container muxes', async () => {
  /**
   * THE SECURITY PIN. Prewarming moves container dispatch IN FRONT of the fetch that used to establish
   * that the ref names a real post, so an unbounded prewarm let `GET /watch/?v=<anything>` boot an
   * instance and run yt-dlp on an attacker-chosen page — and a loop over distinct ids saturates a pool
   * of four slots with 120s/300MB jobs, degrading every legitimate post to a video-less card.
   *
   * `fetchPost` returns null, which is what an id naming no post looks like. With the old
   * unconditional prewarm this request cost a full mux anyway; with the post-cache gate it costs none.
   */
  const { seen, binding } = fakeResolver()
  const res = await handle(req(FB_PATH), envWith(binding), ctx, deps(async () => null))
  assert.equal(seen.mux, 0, 'speculative container work must need a ref we have already fetched')
  assert.match(await res.text(), /couldn't load/i)
})

test('PREWARM: a response-cache HIT costs no container call at all', async () => {
  // Placed after the cache check deliberately: a cached card must cost nothing, container included.
  const { seen, binding } = fakeResolver()
  const d = deps()
  await handle(req(FB_PATH), envWith(binding), ctx, d)
  const before = seen.mux + seen.meta
  await handle(req(FB_PATH), envWith(binding), ctx, d)
  assert.equal(seen.mux + seen.meta, before, 'a warm response must not wake the container')
})

test('muxOnce: concurrent /_media/ hits for ONE key produce exactly ONE container call', async () => {
  // ensureMuxed's "at most once" is an R2 head check, which only dedupes work that has already
  // FINISHED — a cold video is asked for by the prewarm and both settleMux calls within ~2s of one
  // paste, and all three used to start their own yt-dlp download on the same pooled instance.
  let resolveMux
  const gate = new Promise(r => { resolveMux = r })
  const { seen, binding } = fakeResolver({
    mux: async () => { await gate; return new Response(MP4, { headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } }) },
  })
  const r2 = fakeR2()
  const env = envWith(binding, r2)
  const d = deps()
  const url = `/_media/${encodeURIComponent(refKey(FB_REF))}/0`
  const both = Promise.all([handle(req(url), env, ctx, d), handle(req(url), env, ctx, d)])
  resolveMux()
  const [a, b] = await both
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(seen.mux, 1, 'one video, one download — not one per caller')
  // And a THIRD call after they settle hits R2 and makes none.
  const c = await handle(req(url), env, ctx, d)
  assert.equal(c.status, 200)
  assert.equal(seen.mux, 1, 'the finished mux is served from R2')
})

/** A fetch that has already spent the entire HTML budget by the time the post exists. */
const budgetBlowingFetch = async (ref, env, client, report) => {
  await new Promise(r => setTimeout(r, HTML_DEADLINE_MS + 30))
  return liveFetchPost(ref, env, client, report)
}

test('THE DEADLINE: a fetch that outruns the budget leaves settleMux the FLOOR, not a fresh one', async () => {
  // HTML_DEADLINE_MS is a ceiling on the WHOLE bot response rather than an amount ADDED after the
  // fetch. Under the old semantics this request would have waited the full budget again on top of an
  // already-blown fetch — the shape of the measured 12.3s, by which point Discord has given up.
  const { binding } = fakeResolver({ mux: () => new Promise(() => {}) })   // a mux that never finishes
  const t0 = Date.now()
  const res = await handle(req(FB_PATH), envWith(binding), ctx, deps(budgetBlowingFetch))
  const elapsed = Date.now() - t0
  assert.equal(res.status, 200)
  assert.ok(elapsed < HTML_DEADLINE_MS * 2,
    `the blown budget must not be re-spent on the mux wait (elapsed ${elapsed}ms)`)
  // And the card is honest: the mux never finished, so it degrades to the still rather than promising
  // a video the /_media route cannot serve.
  assert.ok(!(await res.text()).includes('og:video'), 'a card only promises a video that exists')
})

test('THE FLOOR: a mux already WARM IN R2 still reaches the card after the budget is blown', async () => {
  /**
   * THE DEFECT THE FLOOR FIXES. The remaining budget used to be `Math.max(0, …)`, and settleMux races
   * muxOnce against `setTimeout(resolve, budgetMs)` — while muxOnce's FIRST step is a real R2 `head`
   * RPC. A 0ms timer beats an RPC every time, so a finished video sitting warm in the bucket, needing
   * no container call at all, was dropped from the card as if it did not exist — AND the card then
   * counted as degraded, so the response was not cached and the next unfurl repeated the whole path.
   *
   * Reachable on exactly this platform: any meta extract slower than HTML_DEADLINE_MS lands here.
   * `latencyMs` on the fake R2 is what makes the test able to see it — with an instant fake, the head
   * resolves in microtasks and even a 0ms timer loses.
   */
  /**
   * ITS OWN REF, and that is not cosmetic: muxInflight is module-level and isolate-lifetime, so the
   * never-resolving mux the test above leaves behind is still parked under FB_REF's key and muxOnce
   * would hand this request that same dead promise. A distinct ref is how one test's in-flight work
   * stops being another test's answer.
   */
  const ref = { p: 'fb', kind: 'reel', id: '1195289147628387' }
  const r2 = fakeR2([[`mux/${refKey(ref)}/0`, MP4]], 15)
  const { seen, binding } = fakeResolver({ mux: () => new Promise(() => {}) })   // never finishes
  const res = await handle(req(`/reel/${ref.id}`), envWith(binding, r2), ctx, deps(budgetBlowingFetch))
  const html = await res.text()
  assert.equal(seen.mux, 0, 'a warm object must cost no container call')
  assert.match(html, /property="og:video"/, 'a finished mux must not be discarded by a zero-length race')
  assert.ok(MUX_WAIT_FLOOR_MS > 0, 'the floor is the mechanism; a zero floor reinstates the defect')
})

test('THE TWO BOUNDS ARE CONSISTENT: a meta call at its ceiling still leaves the mux floor', () => {
  // META_TIMEOUT_MS used to be 6000 against an HTML_DEADLINE_MS of 5000 — a ceiling LARGER than the
  // budget it spends from, so any extract in the 5-6s band blew the whole deadline and guaranteed a
  // degraded, uncached card. It is derived now; this pins the relationship rather than the numbers.
  assert.ok(HTML_DEADLINE_MS - MUX_WAIT_FLOOR_MS > 0)
  // A meta extract measured at 2.4-3.1s must still fit comfortably under the derived ceiling.
  assert.ok(HTML_DEADLINE_MS - MUX_WAIT_FLOOR_MS >= 3500,
    'the meta ceiling must stay generous against the measured 2.4-3.1s extract')
})
