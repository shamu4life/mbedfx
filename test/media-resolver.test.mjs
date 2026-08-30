import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'

// The /_media/ remux orchestration, exercised with a synthetic post that carries a `remux` video and
// mocked bindings — no container, no real R2, no platform. Proves: resolver present -> mux + cache +
// range-serve; resolver absent -> the post's video degrades to its poster still; a mux failure -> the
// poster; a second hit -> served from R2 without re-muxing.

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

/** Minimal in-memory R2 bucket: head/get(range)/put(stream). */
function fakeR2() {
  const store = new Map() // key -> Uint8Array
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k, opts) {
      const v = store.get(k)
      if (!v) return null
      if (opts?.range) {
        const off = opts.range.offset ?? 0
        const slice = v.slice(off, opts.range.length != null ? off + opts.range.length : undefined)
        return { body: new Response(slice).body, size: v.length }
      }
      return { body: new Response(v).body, size: v.length }
    },
    async put(k, body) { store.set(k, new Uint8Array(await new Response(body).arrayBuffer())) },
  }
}

const REF = { p: 'bs', handle: 'a.bsky.social', rkey: 'k' }
const KEY = `mux/${refKey(REF)}/0`
const remuxPost = () => ({
  ref: REF, canonical: 'https://bsky.app/x',
  author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: 'https://cdn.bsky.app/v.m3u8', w: 1280, h: 720, poster: 'https://cdn.bsky.app/thumb.jpg', remux: { video: 'https://cdn.bsky.app/v.m3u8' } }],
})

const MP4 = 'FAKE-MP4-BYTES-0123456789'
const withResolver = (impl) => ({
  AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) },
  MEDIA_CACHE: fakeR2(),
})
const noResolver = () => ({ AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } })
const mediaReq = (i = 0) =>
  new Request(`https://staging.megapenispoopenfarten.sex/_media/${encodeURIComponent(refKey(REF))}/${i}`, {
    headers: { 'user-agent': 'Discordbot/2.0' },
  })

test('resolver present: /_media/ muxes via the container, caches in R2, serves video/mp4', async () => {
  let sentBody
  const env = withResolver(async (_url, init) => { sentBody = JSON.parse(init.body); return new Response(MP4, { headers: { 'content-type': 'video/mp4' } }) })
  const res = await handle(mediaReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(await res.text(), MP4)
  assert.deepEqual(sentBody, { video: 'https://cdn.bsky.app/v.m3u8' }, 'the remux source is sent to the container')
  assert.ok(env.MEDIA_CACHE.store.has(KEY), 'the muxed mp4 is cached in R2')
})

test('a Range request is honoured with 206 + Content-Range', async () => {
  const env = withResolver(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }))
  const req = new Request(mediaReq().url, { headers: { 'user-agent': 'Discordbot/2.0', range: 'bytes=0-3' } })
  const res = await handle(req, env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 0-3/${MP4.length}`)
  assert.equal(await res.text(), MP4.slice(0, 4))
})

test('A SUFFIX RANGE IS THE LAST N BYTES — `bytes=-N` used to answer with the FIRST N+1', async () => {
  /**
   * The range regex accepts an empty first group, so `bytes=-4` parsed as start=0/end=4 and the route
   * returned a confident 206 labelled `bytes 0-4` containing the wrong bytes. A 416 would have been a
   * bug someone noticed; this was a lie a player would believe. Discord's proxy has not been observed
   * sending one, which is why it survived — an ordinary MP4 player looking for the moov atom at the
   * tail is exactly who does.
   */
  const env = withResolver(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }))
  const req = new Request(mediaReq().url, { headers: { 'user-agent': 'Discordbot/2.0', range: 'bytes=-4' } })
  const res = await handle(req, env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes ${MP4.length - 4}-${MP4.length - 1}/${MP4.length}`)
  assert.equal(await res.text(), MP4.slice(-4))
})

test('`bytes=-0` IS A 416 — a zero-length suffix is unsatisfiable, and the existing guard already knew', async () => {
  // start = size, end = size-1, so start > end. No special case was added for this; the point of the
  // assertion is that none is NEEDED, so nobody adds one later.
  const env = withResolver(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }))
  const req = new Request(mediaReq().url, { headers: { 'user-agent': 'Discordbot/2.0', range: 'bytes=-0' } })
  const res = await handle(req, env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 416)
  assert.equal(res.headers.get('content-range'), `bytes */${MP4.length}`)
})

test('AN OVERSIZED SUFFIX IS THE WHOLE FILE, not a 416 — RFC 9110 says clamp', async () => {
  const env = withResolver(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }))
  const req = new Request(mediaReq().url, { headers: { 'user-agent': 'Discordbot/2.0', range: 'bytes=-99999999' } })
  const res = await handle(req, env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 0-${MP4.length - 1}/${MP4.length}`)
  assert.equal(await res.text(), MP4)
})

test('/_media/ ARMS THE ALARM — it is the only mux dispatcher Bluesky and Reddit ever reach', async () => {
  /**
   * THE HOLE THIS CLOSES. settleMux returns before its arming loop for any post with no `{page}`
   * remux, and prewarmable() answers null for `bs`/`rd` — so the two platforms whose video is an
   * ordinary CDN HLS manifest had ZERO alarm coverage. Their single attempt ran inside Discord's
   * media-proxy request, and a cancelled request left the container deleting its temp file in a
   * `finally`: zero bytes in R2, and the next paste starting again from zero. Not slow. Never.
   */
  const jobs = []
  const env = {
    ...withResolver(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } })),
    MUX_RUNNER: { getByName: (name) => ({ async schedule(job) { jobs.push({ name, job }) } }) },
  }
  const waited = []
  const capturing = { waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})) } }
  const res = await handle(mediaReq(), env, capturing, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  await Promise.all(waited)

  assert.equal(res.status, 200, 'the bytes are still served inline — the alarm is an upgrade, not a detour')
  assert.equal(jobs.length, 1, 'the /_media/ route must arm; it is the only durable path this platform has')
  assert.equal(jobs[0].name, KEY, 'addressed by the mux key, which is the global dedupe')
  assert.deepEqual(jobs[0].job.source, { video: 'https://cdn.bsky.app/v.m3u8' },
    'the unsigned CDN manifest is the durable form — there is no page to fall back to')
})

test('a second hit serves from R2 without calling the container again', async () => {
  let calls = 0
  const env = withResolver(async () => { calls++; return new Response(MP4, { headers: { 'content-type': 'video/mp4' } }) })
  const deps = { cache: fakeCache(), fetchPost: async () => remuxPost() }
  await handle(mediaReq(), env, ctx, deps)
  await handle(mediaReq(), env, ctx, deps)
  assert.equal(calls, 1, 'muxed once, then served from R2')
})

test('a mux failure answers 503 no-store — the VIDEO url must never serve an image', async () => {
  // REVERSED DELIBERATELY (2026-07-24). This used to 302 to the poster "never a dead player", and that
  // fallback was the bug: this is the url og:video points at, so Discord's media proxy fetched it, landed
  // on content-type image/jpeg, and CACHED "this video is an image" — every later view then drew a static
  // frame that could never play, and re-pasting could not clear it (the poisoned entry is keyed by the
  // media url, which does not change). The card's still comes from og:image / preview_url (the separate
  // poster path), so answering the video url with an image bought nothing. 503 + no-store caches nothing.
  const env = withResolver(async () => new Response('nope', { status: 502 }))
  const res = await handle(mediaReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.ok(!(res.headers.get('location') || '').includes('poster'), 'never redirect the video url to the still')
})

test('resolver absent: the remux video degrades to its poster image (302 to the thumbnail)', async () => {
  const res = await handle(mediaReq(), noResolver(), ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://cdn.bsky.app/thumb.jpg', 'withResolver stripped it to the cover')
})


// ── THE SHORTCUT AND ITS FALLBACK.
//
//    A remux entry from the yt-dlp tier carries BOTH: the format urls the metadata call already
//    resolved, and the page to re-extract from. The tracks skip a second yt-dlp extraction (~5.0s
//    measured 2026-08-22 against a 1.8s download of the same bytes) — but they are bound to the egress
//    IP that resolved them and expire in hours, and nothing on this side can see that they have. So the
//    only safe way to use one is to be able to give up: try the tracks, fall back to the page.

const SHORTCUT_REF = { p: 'st', id: 'shortcut1' }
const shortcutPost = () => ({
  ref: SHORTCUT_REF, canonical: 'https://streamable.com/shortcut1',
  author: { name: 'Streamable', handle: 'streamable', url: 'https://streamable.com' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [{
    kind: 'video', url: 'https://streamable.com/shortcut1', w: 0, h: 0,
    poster: 'https://cdn.example/thumb.jpg',
    remux: {
      page: 'https://streamable.com/shortcut1',
      video: 'https://cdn.example/v.m4s',
      audio: 'https://cdn.example/a.m4s',
    },
  }],
})
const shortcutReq = () =>
  new Request(`https://staging.megapenispoopenfarten.sex/_media/${encodeURIComponent(refKey(SHORTCUT_REF))}/0`,
    { headers: { 'user-agent': 'Discordbot/2.0' } })

test('THE TRACKS ARE TRIED FIRST, and they are sent WITHOUT the page beside them', async () => {
  /**
   * container/server.py's do_POST checks `page` BEFORE `video`, so a body carrying both takes the slow
   * path every time. Sending the whole remux source would leave this optimisation as dead code that
   * still read as correct on both sides — which is why the keys are asserted, not just the values.
   */
  const bodies = []
  const env = withResolver(async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
  })
  const res = await handle(shortcutReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => shortcutPost() })
  assert.equal(res.status, 200)
  assert.deepEqual(bodies, [{ video: 'https://cdn.example/v.m4s', audio: 'https://cdn.example/a.m4s' }])
})

test('A STALE SHORTCUT IS NOT A VERDICT ON THE VIDEO — the page attempt still gets to speak', async () => {
  /**
   * A googlevideo/CloudFront url dies on its own schedule and ffmpeg reports that as a failed mux. If
   * the first attempt ended the story, this optimisation would convert a working card into a 503 the
   * moment a signature expired — strictly worse than never having had it. The page is the fallback and
   * it is the load-bearing half.
   */
  const bodies = []
  const env = withResolver(async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (body.video) return new Response('{"error":"mux failed"}', { status: 502 })
    return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
  })
  const res = await handle(shortcutReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => shortcutPost() })
  assert.equal(res.status, 200, 'the card keeps its video')
  assert.equal(await res.text(), MP4)
  assert.deepEqual(bodies.map(b => Object.keys(b).sort()), [['audio', 'video'], ['page']],
    'tracks first, then the page — in that order and nothing else')
})

test('BOTH ATTEMPTS FAILING IS STILL A 503, never a 302 to the still', async () => {
  // The shortcut must not change what a real failure looks like: the same 503 no-store the video url
  // has answered since 2026-07-24, for the poisoned-media-proxy reason argued above.
  let calls = 0
  const env = withResolver(async () => { calls++; return new Response('nope', { status: 502 }) })
  const res = await handle(shortcutReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => shortcutPost() })
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 2, 'and both attempts were really made')
})


// ── MUX TELEMETRY — added 2026-08-23, after a reported "a 10-minute video took nearly ten minutes to
//    warm" that could only be explained by arithmetic because nothing recorded what happened.
//
//    The video half of this service had no counters at all. Our own container wall (504; 180s then,
//    MUX_PAGE_TIMEOUT = 360s on a {page} mux since 2026-08-29), the
//    upstream's gate (502 "mux failed"), an empty result (502, same status), a cold container (503)
//    and a refused store all reached the reader as the identical bodiless 503 no-store and left the
//    identical unstored console.error behind. These tests pin the distinctions, because a counter
//    that collapses two systems into one number is worse than no counter — it points at the wrong one.

const AE_REF = { p: 'st', id: 'telem001' }
const aePost = (remux) => ({
  ref: AE_REF, canonical: 'https://streamable.com/telem001',
  author: { name: 'Streamable', handle: 'streamable', url: 'https://streamable.com' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [{
    kind: 'video', url: 'https://streamable.com/telem001', w: 0, h: 0,
    poster: 'https://cdn.example/thumb.jpg',
    remux: remux ?? { page: 'https://streamable.com/telem001' },
  }],
})
const aeReq = () =>
  new Request(`https://staging.megapenispoopenfarten.sex/_media/${encodeURIComponent(refKey(AE_REF))}/0`,
    { headers: { 'user-agent': 'Discordbot/2.0' } })

/** withResolver + a recording Analytics Engine, so the counter is observed rather than assumed. */
function countingMuxEnv(impl) {
  const points = []
  return {
    points,
    env: {
      AE: { writeDataPoint(p) { points.push(p) } },
      ASSETS: { async fetch() { return new Response('a') } },
      MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) },
      MEDIA_CACHE: fakeR2(),
    },
  }
}
const muxRows = points => points.filter(p => String(p.blobs?.[1] || '').startsWith('mux_'))

test('EVERY CONTAINER FAILURE GETS ITS OWN NAME — 504 is OURS, 502 is THEIRS, and they are not one number', async () => {
  /**
   * THE WHOLE POINT. container/server.py answers 504 for its own wall — MUX_PAGE_TIMEOUT on a page
   * mux, PROC_TIMEOUT on the other two subprocesses — and 502 for a
   * non-zero yt-dlp exit, and until now the Worker recorded neither. "Our clock ran out" and "YouTube
   * refused us" are opposite claims about which system to go and look at, and the reported incident
   * cost a night precisely because nothing had ever written down which one it was.
   *
   * NOTE THE TWO 502s. The container uses that status for a gate AND for a run that produced nothing
   * usable, so the body — not the status — is what separates mux_gate from mux_empty.
   */
  const cases = [
    [504, '{"error":"mux timed out"}', 'mux_timeout', 'our own wall, not the upstream'],
    [502, '{"error":"mux failed"}', 'mux_gate', 'yt-dlp exited non-zero — the upstream refused'],
    [502, '{"error":"empty or oversized result"}', 'mux_empty', 'it ran and produced nothing usable'],
    [503, '', 'mux_pool', 'a cold boot or an exhausted instance pool'],
    [400, '{"error":"invalid source"}', 'mux_badsource', 'the container SSRF guard refused our url'],
    [500, '{"error":"internal error"}', 'mux_error', 'unclassified — should stay at zero'],
  ]
  for (const [status, body, outcome, why] of cases) {
    const { env, points } = countingMuxEnv(async () => new Response(body, { status }))
    const res = await handle(aeReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => aePost() })
    assert.equal(res.status, 503, 'the reader still gets 503 no-store — telemetry changes nothing there')
    const rows = muxRows(points)
    assert.equal(rows.length, 1, `${status} must count exactly once`)
    assert.equal(rows[0].blobs[1], outcome, `${status} "${body}" is ${outcome}: ${why}`)
    assert.equal(rows[0].blobs[0], 'st', 'the platform is read back off the slot key')
    assert.equal(rows[0].blobs[2], 'none', 'a mux is collapsed across callers, so it has no client')
  }
})

test('A SUCCESSFUL MUX IS COUNTED WITH ITS DURATION — the field the incident had no answer for', async () => {
  // Nothing recorded how long a mux took even when it WORKED, so "it took ten minutes" could only be
  // reconstructed from arithmetic. double2 is the elapsed ms; double1 stays the literal 1.
  const { env, points } = countingMuxEnv(async () =>
    new Response('MP4-BYTES', { headers: { 'content-type': 'video/mp4' } }))
  const res = await handle(aeReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => aePost() })
  assert.equal(res.status, 200)
  const rows = muxRows(points)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].blobs[1], 'mux_ok')
  assert.equal(rows[0].doubles[0], 1, 'double1 stays the literal 1, as every other row in the dataset')
  assert.equal(typeof rows[0].doubles[1], 'number', 'double2 is the elapsed ms')
  assert.ok(rows[0].doubles[1] >= 0, 'and it is never negative')
})

test('A WARM R2 HIT IS NOT A MUX — counting it would make mux_ok\'s duration a meaningless average', async () => {
  /**
   * The clock starts AFTER the R2 head check on purpose. If a hit counted, `mux_ok` would be a
   * mixture of "we already had it" (milliseconds) and "we made it" (seconds), and the average would
   * answer neither question. A second view must add no row at all.
   */
  const { env, points } = countingMuxEnv(async () =>
    new Response('MP4-BYTES', { headers: { 'content-type': 'video/mp4' } }))
  const d = { cache: fakeCache(), fetchPost: async () => aePost() }
  await handle(aeReq(), env, ctx, d)
  const afterFirst = muxRows(points).length
  await handle(aeReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => aePost() })
  assert.equal(afterFirst, 1, 'the cold one counted')
  assert.equal(muxRows(points).length, 1, 'the warm one did not — it never reached the container')
})

test('A FAILED SHORTCUT IS NOT COUNTED — only the attempt that actually decides the video is', async () => {
  /**
   * ensureMuxed tries the resolved tracks first and falls back to the page. A stale track url is an
   * expected, recoverable event, NOT a verdict on the video — counting it would inflate mux_gate with
   * failures that the very next attempt repaired, and mux_gate is the number that decides whether
   * somebody goes and investigates YouTube.
   */
  const { env, points } = countingMuxEnv(async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.video) return new Response('{"error":"mux failed"}', { status: 502 })
    return new Response('MP4-BYTES', { headers: { 'content-type': 'video/mp4' } })
  })
  const post = () => aePost({ page: 'https://streamable.com/telem001', video: 'https://cdn.example/v.m4s' })
  const res = await handle(aeReq(), env, ctx, { cache: fakeCache(), fetchPost: post })
  assert.equal(res.status, 200, 'the page attempt repaired it')
  const rows = muxRows(points)
  assert.deepEqual(rows.map(r => r.blobs[1]), ['mux_ok'],
    'one row, and it is the outcome that actually happened')
})

test('NO PART OF THE CONTAINER ERROR BODY IS EVER STORED — the url-suppression rule still holds', async () => {
  /**
   * yt-dlp's stderr is suppressed inside the container BECAUSE it can carry the source url, and
   * src/analytics.ts refuses to put a url in a counter for the reason TwitFix died over. Reading the
   * body to classify a failure must not quietly reopen either. The outcome is a fixed enum member
   * chosen from a closed allowlist; the body itself goes nowhere.
   */
  const leak = '{"error":"mux failed: https://rr3---sn-secret.googlevideo.com/videoplayback?id=LEAKED"}'
  const { env, points } = countingMuxEnv(async () => new Response(leak, { status: 502 }))
  await handle(aeReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => aePost() })
  const serialized = JSON.stringify(points)
  assert.ok(!serialized.includes('googlevideo'), `a url reached the counter: ${serialized}`)
  assert.ok(!serialized.includes('LEAKED'), 'nor any part of the body')
  assert.equal(muxRows(points)[0].blobs[1], 'mux_gate', 'and it is still classified correctly')
})
