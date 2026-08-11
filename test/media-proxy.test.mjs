import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'

/**
 * The /_media/ DIRECT-VIDEO pass-through, driven through the real dispatcher with `globalThis.fetch`
 * stubbed — no network, no container, no R2.
 *
 * WHY IT EXISTS (measured 2026-07-25): Instagram reel DbOwAfWp0YT (38,774,320 bytes) draws NO Discord
 * card behind our 302, while DZc6RL8sHtz (2,471,034 bytes) on the identical path plays. The measured
 * difference is one header — the CDN's plain 200 on the big object carries no `accept-ranges: bytes`,
 * the small one's does, and both honour Range regardless. A 302 cannot add a header to someone else's
 * response, so we serve the bytes and advertise it ourselves. instagram7.com serves the byte-identical
 * file from its own domain with accept-ranges on its 200, and it works.
 *
 * The two security-relevant claims are asserted as BEHAVIOUR rather than by inspection: a foreign host
 * costs ZERO fetches (the allowlist is decided before any I/O), and neither an image nor an HTML block
 * page can ever be relayed under the url og:video points at.
 */

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const fakeEnv = () => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
})

const REF = { p: 'ig', kind: 'p', code: 'DbOwAfWp0YT' }
const KEY = encodeURIComponent(refKey(REF))
const CDN_VIDEO = 'https://scontent-bos5-1.cdninstagram.com/o1/v/t2/f2/m86/AQreel.mp4?oe=6A6739FF'

/**
 * Index 0 an IMAGE on the same CDN, index 1 the VIDEO with a poster, index 2 a video on a FOREIGN
 * host, index 3 a video on plain http. The last two are the two ways the allowlist must say no
 * without ever reaching the network.
 */
const igPost = () => ({
  ref: REF, canonical: 'https://www.instagram.com/p/DbOwAfWp0YT/',
  author: { name: 'slop.time', handle: 'slop.time', url: 'https://www.instagram.com/slop.time/', avatar: 'https://scontent.cdninstagram.com/av.jpg' },
  text: 'reel', createdAt: new Date(0), counts: {}, sensitive: false,
  media: [
    { kind: 'image', url: 'https://scontent.cdninstagram.com/a.jpg', w: 1080, h: 1080 },
    { kind: 'video', url: CDN_VIDEO, w: 720, h: 1280, poster: 'https://scontent.cdninstagram.com/cover.jpg' },
    { kind: 'video', url: 'https://evil.example/x.mp4', w: 720, h: 1280, poster: 'https://scontent.cdninstagram.com/c2.jpg' },
    { kind: 'video', url: 'http://scontent.cdninstagram.com/insecure.mp4', w: 720, h: 1280 },
  ],
})

const deps = () => ({ cache: fakeCache(), fetchPost: async () => igPost(), resolveShortlink: async () => ({ kind: 'unresolved' }) })
const mediaReq = (seg, init) =>
  new Request(`https://staging.megapenispoopenfarten.sex/_media/${KEY}/${seg}`, {
    headers: { 'user-agent': 'Discordbot/2.0', ...(init?.headers || {}) },
    ...(init?.method ? { method: init.method } : {}),
  })

/**
 * Swap `globalThis.fetch` for the duration of one call and record what the proxy asked upstream for.
 * `calls` counting ZERO is an assertion in its own right on every 302 case below — it is what proves
 * the host allowlist is a pure decision made before any egress, rather than a check made after.
 */
async function withUpstream(impl, body) {
  const real = globalThis.fetch
  const seen = { calls: 0, url: null, range: null, method: null }
  globalThis.fetch = async (u, init) => {
    seen.calls++
    seen.url = String(u)
    seen.range = new Headers(init?.headers || {}).get('range')
    seen.method = init?.method ?? 'GET'
    return impl(seen)
  }
  try {
    return { seen, res: await body() }
  } finally {
    globalThis.fetch = real
  }
}

const MP4 = 'FAKE-MP4-BYTES-0123456789'
const okVideo = () => new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } })

test('no Range: the video is SERVED from our origin, with accept-ranges the CDN omits', async () => {
  const { seen, res } = await withUpstream(okVideo, () => handle(mediaReq(1), fakeEnv(), ctx, deps()))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('location'), null, 'the video url must not hand off to a third-party origin')
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  // THE HEADER THE CDN OMITS ON A LARGE FILE, and the measured reason the 38MB reel drew no card.
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300')
  assert.equal(await res.text(), MP4)
  assert.equal(seen.calls, 1)
  assert.equal(seen.url, CDN_VIDEO, 'we fetch OUR extraction for THAT ref, at zero further hops')
  assert.equal(seen.range, null, 'no inbound Range -> none forwarded')
})

test('inbound Range is forwarded and the 206 + content-range comes back verbatim', async () => {
  const impl = () => new Response(MP4.slice(0, 4), {
    status: 206,
    headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-3/${MP4.length}`, 'content-length': '4' },
  })
  const { seen, res } = await withUpstream(impl, () =>
    handle(mediaReq(1, { headers: { range: 'bytes=0-3' } }), fakeEnv(), ctx, deps()))
  assert.equal(seen.range, 'bytes=0-3')
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 0-3/${MP4.length}`)
  assert.equal(res.headers.get('accept-ranges'), 'bytes', 'still advertised on a 206')
  assert.equal(await res.text(), MP4.slice(0, 4))
})

/**
 * A REFUSED PROXY FALLS BACK TO THE 302 — reversed deliberately 2026-07-25, and the four tests below
 * pin the reversal. They were written hours earlier in this same batch asserting 503, and NONE of
 * that 503 behaviour ever shipped, so no verified assertion is being weakened here.
 *
 * WHY THE REVERSAL. This proxy is an OPTIMISATION over a shipped, measured-good 302, so its failure
 * must cost exactly that optimisation. The risk is concrete: this fetch leaves Cloudflare's
 * DATACENTER egress toward scontent*.cdninstagram.com, and platforms/threads/normalize.ts records
 * the measurement that Meta blocks that egress for Threads video on the SAME host family. If
 * Instagram behaves likewise — or starts to — answering 503 would take down every Instagram video
 * INCLUDING the small reels that play today, in exchange for fixing the large ones. Falling back
 * makes the worst case "unchanged from today".
 *
 * WHAT IS STILL PINNED, because these are the properties that actually matter and none of them
 * depends on the status code: the refused BYTES are never relayed, the url og:video points at never
 * answers with an image content-type, and the fallback target is this video entry's OWN url — never
 * the poster, and never a host the allowlist rejected. The poisoned-url defect was a VIDEO url
 * answering as an IMAGE; a redirect to the same video is not that, which is why notReady() is still
 * right for serveMuxed (there the only fallback on offer really was the poster still).
 */
const assertFellBackTo302 = (res) => {
  assert.equal(res.status, 302, 'a refused proxy degrades to the shipped 302, not to a dead 503')
  assert.equal(res.headers.get('location'), CDN_VIDEO, 'to the VIDEO url — never the poster, never off-allowlist')
  assert.ok(!/^image\//.test(res.headers.get('content-type') || ''), 'the video url never answers image/*')
}

test('upstream 403 (dead signature or refused egress) falls back to the 302 — never an image', async () => {
  const { res } = await withUpstream(() => new Response('forbidden', { status: 403 }), () =>
    handle(mediaReq(1), fakeEnv(), ctx, deps()))
  assertFellBackTo302(res)
})

test('ASSERT ON CONTENT, NEVER STATUS: an HTTP 200 text/html block page is refused, not relayed', async () => {
  // Meta answers a gate with HTTP 200 and ordinary text/html. Relaying that body under the url
  // og:video points at is the poisoned-content-type defect. Refusing it is the assertion; the 302 is
  // merely where we land afterwards, and it points at the same bytes Discord would have fetched anyway.
  const blocked = '<!DOCTYPE html><html><body>Sorry, this content is not available</body></html>'
  const { res } = await withUpstream(() => new Response(blocked, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), () =>
    handle(mediaReq(1), fakeEnv(), ctx, deps()))
  assertFellBackTo302(res)
  assert.ok(!(await res.text()).includes('not available'), 'the HTML body must not be relayed')
})

test('an upstream fetch that THROWS degrades to the 302, never an uncaught 500 on a public route', async () => {
  const { res } = await withUpstream(() => { throw new TypeError('network') }, () =>
    handle(mediaReq(1), fakeEnv(), ctx, deps()))
  assertFellBackTo302(res)
})

test('SSRF PIN: a foreign host 302s exactly as today and costs ZERO fetches', async () => {
  // The assertion that proves the allowlist is decided BEFORE any I/O. A media url is our own
  // extraction, but a cache record is not the normalizer's output by the time it reaches this route.
  const { seen, res } = await withUpstream(okVideo, () => handle(mediaReq(2), fakeEnv(), ctx, deps()))
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://evil.example/x.mp4')
  assert.equal(seen.calls, 0, 'no server-side request to an unmeasured host, ever')
})

test('SSRF PIN: a non-https url in a corrupted cache record costs ZERO fetches', async () => {
  const { seen, res } = await withUpstream(okVideo, () => handle(mediaReq(3), fakeEnv(), ctx, deps()))
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'http://scontent.cdninstagram.com/insecure.mp4')
  assert.equal(seen.calls, 0)
})

test('IMAGES KEEP THE 302 and cost no fetch: the picture index, poster{N} and avatar', async () => {
  for (const [seg, want] of [
    [0, 'https://scontent.cdninstagram.com/a.jpg'],
    ['poster1', 'https://scontent.cdninstagram.com/cover.jpg'],
    ['avatar', 'https://scontent.cdninstagram.com/av.jpg'],
  ]) {
    const { seen, res } = await withUpstream(okVideo, () => handle(mediaReq(seg), fakeEnv(), ctx, deps()))
    assert.equal(res.status, 302, `${seg} must still 302`)
    assert.equal(res.headers.get('location'), want, `${seg} must resolve to its own url`)
    // Proxying images would multiply held-open subrequests by gallery size for no measured gain —
    // a 10-child carousel is ten streams. The 302 is measured-good on every platform for pictures.
    assert.equal(seen.calls, 0, `${seg} must not stream through us`)
  }
})

test('a multi-range request is not forwarded, so the content assertion can never meet multipart', async () => {
  const { seen, res } = await withUpstream(okVideo, () =>
    handle(mediaReq(1, { headers: { range: 'bytes=0-1,5-6' } }), fakeEnv(), ctx, deps()))
  assert.equal(seen.range, null, 'multi-range is dropped, not passed through')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
})

test('HEAD is forwarded as HEAD and answers headers with an empty body', async () => {
  const impl = () => new Response(null, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '38774320' } })
  const { seen, res } = await withUpstream(impl, () =>
    handle(mediaReq(1, { method: 'HEAD' }), fakeEnv(), ctx, deps()))
  assert.equal(seen.method, 'HEAD')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(res.headers.get('content-length'), '38774320')
  assert.equal(await res.text(), '')
})

/**
 * THREADS IS ON THE SAME CDN AND MUST KEEP ITS 302 — the regression this platform gate exists to stop.
 *
 * Threads video is Instagram's backend: `video_versions[0].url` is on scontent*.cdninstagram.com, so the
 * host allowlist covers it and only the ref can tell it apart from Instagram.
 *
 * IT USED TO 302, AND THIS TEST USED TO PIN THAT. The reasoning was that Meta blocks Cloudflare's
 * datacenter egress for Threads media, so proxying would fetch a non-video answer, refuse it, and 503 the
 * url og:video points at — no player on any Threads video post. That was an INFERENCE, and the comment
 * that carried it named the one thing that could overturn it: a real measurement of a Worker-egress fetch
 * of a Threads scontent url.
 *
 * MEASURED 2026-08-09 with `wrangler dev --remote`, so the request left Cloudflare rather than a laptop: a
 * live post's 302 target answered HTTP 200, content-type video/mp4, 8,990,730 bytes. The block is not
 * there. It may have been real when it was written; this project has watched Meta and TikTok change their
 * egress rules inside a week.
 *
 * WHAT THE 302 COST A READER, reported the same day: a viewer who has not accepted Meta's cookie consent
 * could not play Threads video full screen. A 302 hands the VIEWER'S OWN CLIENT a Meta url and that client
 * meets the consent wall — while Discord's proxy, which has its own cookies, does not, which is why the
 * inline embed looked fine and only the full-screen fetch failed. Proxying keeps the client on our origin.
 */
const TH_REF = { p: 'th', code: 'DDYEM_foiI1' }
const TH_VIDEO = 'https://scontent-lhr8-1.cdninstagram.com/o1/v/t2/f2/m86/AQthreads.mp4?oe=6A6739FF'
const thPost = () => ({
  ref: TH_REF, canonical: 'https://www.threads.com/@someone/post/DDYEM_foiI1',
  author: { name: 'someone', handle: 'someone', url: 'https://www.threads.com/@someone' },
  text: 'threads video', createdAt: new Date(0), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: TH_VIDEO, w: 720, h: 1280, poster: 'https://scontent.cdninstagram.com/thcover.jpg' }],
})

test('PLATFORM SCOPE: a Threads video on the Meta CDN is PROXIED, so no viewer is sent to Meta', async () => {
  const d = { cache: fakeCache(), fetchPost: async () => thPost(), resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const path = `/_media/${encodeURIComponent(refKey(TH_REF))}/0`
  const { seen, res } = await withUpstream(okVideo, () =>
    handle(new Request(`https://staging.megapenispoopenfarten.sex${path}`, { headers: { 'user-agent': 'Discordbot/2.0' } }),
      fakeEnv(), ctx, d))
  assert.equal(res.status, 200, 'the bytes come from us, not from a redirect to Meta')
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(res.headers.get('location'), null, 'nothing hands the viewer a Meta url to consent to')
  assert.equal(seen.calls, 1, 'exactly one upstream fetch, made by us on our own egress')
})

test('A THREADS VIDEO THAT DOES NOT ANSWER WITH VIDEO STILL FALLS BACK TO THE 302', async () => {
  // The safety half of the change. Proxying is an attempt, not a promise: if Meta ever reinstates the
  // block this path met before 2026-08-09, the content assertion refuses the answer and the reader gets
  // the redirect that worked for the year before it — not a 503 at the url og:video points at.
  const d = { cache: fakeCache(), fetchPost: async () => thPost(), resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const path = `/_media/${encodeURIComponent(refKey(TH_REF))}/0`
  const notVideo = () => new Response('<html>consent</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  const { res } = await withUpstream(notVideo, () =>
    handle(new Request(`https://staging.megapenispoopenfarten.sex${path}`, { headers: { 'user-agent': 'Discordbot/2.0' } }),
      fakeEnv(), ctx, d))
  assert.equal(res.status, 302, 'a non-video answer degrades to the redirect rather than breaking the player')
  assert.equal(res.headers.get('location'), TH_VIDEO)
})

test('SSRF PIN: an allowlisted host that REDIRECTS off the allowlist is refused, not relayed', async () => {
  /**
   * `redirect: 'follow'` means the pre-fetch host check constrains only the FIRST hop, so the
   * pure-decision tests above can all pass while the end-to-end claim is false: an allowlisted Meta host
   * that 302s elsewhere would have us streaming an unvetted origin's bytes out under our own domain.
   * Stubbed by reporting a FINAL url the way the runtime does (Response.url after the redirect chain).
   */
  const impl = () => {
    const r = new Response('EVIL-BYTES', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '10' } })
    Object.defineProperty(r, 'url', { value: 'https://evil.example/x.mp4' })
    return r
  }
  const { seen, res } = await withUpstream(impl, () => handle(mediaReq(1), fakeEnv(), ctx, deps()))
  assert.equal(seen.calls, 1, 'the first hop is the allowlisted CDN — the redirect is upstream of us')
  // THE SECURITY CLAIM IS "NOT RELAYED", NOT "503" (see assertFellBackTo302's docstring for why the
  // refusal path now degrades instead of failing). Both halves are asserted: the unvetted origin's
  // bytes never reach the client, and the Location we emit is the ALLOWLISTED url we started from —
  // emphatically not evil.example, so the fallback cannot become the redirect the check just refused.
  assert.ok(!(await res.clone().text()).includes('EVIL-BYTES'), 'an unvetted origin\'s bytes must never be relayed')
  assertFellBackTo302(res)
  assert.notEqual(res.headers.get('location'), 'https://evil.example/x.mp4')
})

test('a redirect that stays INSIDE the allowlist is served — Meta shard-redirects between scontent hosts', async () => {
  const impl = () => {
    const r = new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } })
    Object.defineProperty(r, 'url', { value: 'https://scontent-lga3-2.cdninstagram.com/o1/v/t2/f2/m86/AQreel.mp4' })
    return r
  }
  const { res } = await withUpstream(impl, () => handle(mediaReq(1), fakeEnv(), ctx, deps()))
  assert.equal(res.status, 200, 'follow is kept deliberately: a shard hop is normal and must still play')
  assert.equal(await res.text(), MP4)
})

test('a content-encoded upstream does NOT get its content-length relayed', async () => {
  // The runtime decompresses, so a relayed length would describe bytes we are not sending. mp4 is
  // never encoded in practice; this pins the belt so a future tidy cannot remove it silently.
  const impl = () => new Response(MP4, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': '9', 'content-encoding': 'gzip' },
  })
  const { res } = await withUpstream(impl, () => handle(mediaReq(1), fakeEnv(), ctx, deps()))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), null)
})
