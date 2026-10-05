import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import {
  normalizePinterest, pinImage, pinTitle, pinVideo,
} from '../src/platforms/pinterest/normalize.ts'
import { proxyableVideoUrl } from '../src/mediaproxy.ts'
import { fetchPinterest } from '../src/platforms/pinterest/fetch.ts'

/**
 * PINTEREST — the cleanest surface this project has integrated.
 *
 * TWO HEADERS ARE THE GATE on `/resource/PinResource/get/`. The first is `X-Pinterest-PWS-Handler`,
 * bisected header by header (2026-07-27): no headers -> 403 `Invalid Resource Request`;
 * X-Requested-With, X-APP-VERSION, X-Pinterest-AppState, Referer and X-Pinterest-Source-Url each
 * alone -> still 403; this one alone -> 200 with the full pin. No cookie is sent and none is required,
 * and `robots.txt` explicitly allows the path (`Allow: /resource/*​/get/`).
 *
 * THE SECOND IS A NON-EMPTY USER-AGENT, and this header used to say the opposite. On 2026-07-27 it
 * read "IT IS NOT A UA GATE": identical 200s for `curl/8.0`, a Discordbot UA and NO user-agent at
 * all. Rewritten 2026-10-05, when every pin in production had started failing: re-measured from the
 * Claude Code dev sandbox (a non-Cloudflare cloud IP, not a Worker), no UA and an empty UA both answer
 * 403 `{"message":"Looks like you don't have permission to access this page…","status":403}`, and
 * every non-empty UA tried (curl, two Chromes, Discordbot, facebookexternalhit) answers 200 with the
 * pin. A Worker's fetch sends no UA unless told to. The fetcher tests at the bottom pin both headers.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => JSON.parse(readFileSync(new URL(n, F), 'utf8')).resource_response.data

const IMAGE = load('pinterest-pin-image.json')   // a link pin: title in grid_title, images.orig
const VIDEO = load('pinterest-pin-video.json')   // a video pin: V_720P present, is_video FALSE

const REF = { p: 'pn', id: '66287425756772418' }
const r = p => route(new URL(`https://staging.megapenispoopenfarten.sex${p}`))

test('EVERY URL SPELLING FOLDS TO ONE REF — the slug is decoration', () => {
  /**
   * Verified against Pinterest itself: `/pin/{invented-slug}--{id}/` returns the SAME pin, so only
   * the trailing id is identity. Regional domains need no handling at all — this router never sees a
   * host, and every region serves the same numeric id.
   */
  for (const p of [
    '/pin/66287425756772418/',
    '/pin/66287425756772418',
    '/pin/great-grandmas-dilly-bread--66287425756772418/',
    '/pin/anything-at-all--66287425756772418',
    '/pin/66287425756772418/sent/',          // the "shared with you" spelling
    '/pin/66287425756772418/visual-search',
    '/pn/pin/66287425756772418',             // the escape hatch
  ]) {
    assert.deepEqual(r(p).ref, REF, `${p} -> one ref`)
  }
  assert.equal(refKey(r('/pin/great-grandmas-dilly-bread--66287425756772418/').ref), 'pn:66287425756772418')
})

test('THE TRAILING SEGMENT IS AN ALLOWLIST, not "any third segment"', () => {
  /**
   * Caught by a 185,056-path sweep. The first draft accepted any seg[2], which claimed
   * /pin/{id}/post, /pin/{id}/clip, /pin/{id}/comments and every other spelling — the loose-matcher
   * habit matchPost's comment warns about, where a future platform's shape gets shadowed by a
   * matcher reading one segment less carefully than it should.
   */
  assert.equal(r('/pin/66287425756772418/sent').kind, 'post')
  for (const tail of ['post', 'clip', 'comments', 'status', 'anything']) {
    assert.equal(r(`/pin/66287425756772418/${tail}`).kind, 'notfound', `/pin/{id}/${tail} is nobody's`)
  }
  assert.equal(r('/pin/66287425756772418/sent/extra').kind, 'notfound', 'and depth stops at 3')

  /**
   * 'p' AND 'v' LEFT THIS LIST ON 2026-09-11, and they left it for a reason that is not Pinterest's.
   *
   * They used to be here as two more spellings nobody claims. They are now the GALLERY SUFFIX, which
   * route() strips ahead of every matcher — so /pin/{id}/p is this same pin rendered stills-first,
   * not a notfound. Pinterest's allowlist is unchanged and still an allowlist; what changed is that
   * two tokens are now spoken for globally, before pinterest() is ever consulted.
   *
   * ASSERTED AS THE SAME PIN, which is the property that makes the suffix safe to add: the mode
   * changes how the card is drawn and never which post it names. If a future strip ever resolved a
   * suffixed url to a DIFFERENT ref, this is where it should go red.
   */
  for (const [tail, mode] of [['p', 'stills'], ['v', 'videos']]) {
    const hit = r(`/pin/66287425756772418/${tail}`)
    assert.equal(hit.kind, 'post', `/pin/{id}/${tail} is the gallery suffix now, not a notfound`)
    assert.deepEqual(hit.ref, REF, `/pin/{id}/${tail} must name the SAME pin`)
    assert.equal(hit.gallery, mode)
  }
})

test('THE ID IS CANONICAL AND BOUNDED — junk never mints a ref', () => {
  for (const bad of ['/pin/abc', '/pin/0123', '/pin/0', '/pin/12', '/pin/-1', '/pin/', '/pin/1e9']) {
    assert.notEqual(r(bad).kind, 'post', `${bad} must not route`)
  }
  // A bare /pin keeps the chooser it has always had — nothing is shadowed.
  assert.equal(r('/pin').kind, 'ambiguous')
})

test('THE REF ROUND-TRIPS — or /_media/ 404s silently', () => {
  const key = refKey(REF)
  assert.equal(key, 'pn:66287425756772418')
  assert.deepEqual(parseRefKey(key), REF)
  for (const bad of ['pn', 'pn:', 'pn:abc', 'pn:0123', 'pn:1:2']) {
    assert.equal(parseRefKey(bad), null, `${bad} must not parse`)
  }
})

test('THE TITLE IS grid_title — `title` is EMPTY on a real pin', () => {
  // Measured: this pin returns `title: ''` and carries its headline in `grid_title`. Reading `title`
  // alone gives an empty card headline on pins that plainly have one.
  assert.equal(IMAGE.title, '', 'the fixture really does have an empty title')
  assert.equal(pinTitle(IMAGE), "Great grandma's Dilly Bread")
  assert.equal(pinTitle({}), '', 'and it is total over a pin with none of the four fields')
})

test('is_video IS FALSE ON A PIN THAT HAS VIDEO — gate on the rendition, never the flag', () => {
  /**
   * The trap that would have dropped every Pinterest video. Measured on three pins carrying a full
   * `videos.video_list` with a playable V_720P: every one reported `is_video: false`.
   */
  assert.equal(VIDEO.is_video, false, 'the fixture really does lie')
  assert.ok(pinVideo(VIDEO), 'and we find the video anyway')
  assert.equal(normalizePinterest(VIDEO, REF).media[0].kind, 'video')
})

test('V_720P IS PREFERRED AND HLS IS REFUSED', () => {
  /**
   * V_720P is a real progressive mp4 — measured `content-type: video/mp4`, HTTP 206 on a range
   * request, first bytes `ftypisom`, and it serves to a Discordbot UA AND to no UA at all. The HLS
   * renditions in the same list (V_HLSV4, V_HLSV3_MOBILE) are deliberately ignored: Discord cannot
   * play HLS, and advertising a manifest as og:video is the dead-player defect fixed in Phase 1.
   */
  const v = pinVideo(VIDEO)
  assert.match(v.url, /\.mp4(?:\?|$)/, 'an mp4, not a manifest')
  assert.match(v.url, /^https:\/\/v1\.pinimg\.com\//)
  assert.ok(v.w > 0 && v.h > 0)
  // A list holding ONLY HLS yields nothing rather than a manifest — the key name is not evidence of
  // a container, so the .mp4 test is on the URL.
  assert.equal(pinVideo({ videos: { video_list: { V_HLSV4: { url: 'https://v1.pinimg.com/x.m3u8' } } } }), null)
  assert.equal(pinVideo({ videos: { video_list: { V_720P: { url: 'https://evil.example/x.mp4' } } } }), null,
    'and off-CDN is refused')
  assert.equal(pinVideo({}), null)
  assert.equal(pinVideo({ videos: null }), null)
})

test('THE SEARCH RESOURCE TRUNCATES video_list — which is why the fetcher asks for `detailed`', () => {
  /**
   * This nearly shipped as "Pinterest video is HLS-only, needs the remux container". Measured over 41
   * video pins from the SEARCH resource, exactly one exposed a progressive mp4 — the rest showed only
   * V_HLSV4 / V_HLSV3_MOBILE. Re-fetching those same pins through the DETAIL endpoint returned V_720P
   * on every one. The truncation is in the response, not in the pin.
   *
   * The fixture is a detail-endpoint capture of one of those "HLS-only" pins, so it pins the fact.
   */
  const keys = Object.keys(VIDEO.videos.video_list)
  assert.ok(keys.includes('V_720P'), 'the detail response carries the progressive rendition')
  assert.ok(keys.includes('V_HLSV4'), 'alongside the HLS ones the search response showed alone')
})

test('THE PICTURE IS `orig`, NEVER THE 600x315 CROP', () => {
  // 600x315 is a link-preview CROP sitting in the same ladder — the same square-crop trap that
  // produced the reported Instagram carousel defect.
  const im = pinImage(IMAGE)
  assert.match(im.url, /\/originals\//)
  assert.equal(im.w, 1152)
  assert.equal(im.h, 620)
  assert.notEqual(`${im.w}x${im.h}`, '600x315')
  // Falls DOWN the ladder when orig is absent, still skipping the crop.
  const laddered = pinImage({ images: { '600x315': { url: 'https://i.pinimg.com/c.jpg', width: 600, height: 315 },
    '736x': { url: 'https://i.pinimg.com/big.jpg', width: 736, height: 400 } } })
  assert.equal(laddered.url, 'https://i.pinimg.com/big.jpg', 'the crop is never chosen')
  assert.equal(pinImage({}), null)
})

test('A VIDEO PIN CARRIES ITS POSTER — posterless drops Discord to plain OpenGraph', () => {
  const post = normalizePinterest(VIDEO, REF)
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'video')
  assert.ok(post.media[0].poster, 'the pin\'s own still')
  assert.match(post.media[0].poster, /^https:\/\/i\.pinimg\.com\//)
})

test('PINTEREST KEEPS THE 302 — it is the one video platform here that needs no byte proxy', () => {
  /**
   * Instagram is proxied because its CDN omits accept-ranges on big files; Twitch because its CDN
   * mislabels a real mp4 as binary/octet-stream. Pinterest does NEITHER: measured 206 with
   * `content-type: video/mp4` on a range request, to a Discordbot UA and to no UA at all. So the
   * plain /_media/ 302 is correct and cheaper, and proxyableVideoUrl must refuse it.
   */
  const post = normalizePinterest(VIDEO, REF)
  assert.equal(proxyableVideoUrl(post, 0), null, 'not proxied — the 302 is measured-good')
})

test('normalizePinterest is TOTAL over a pin with holes', () => {
  const bare = normalizePinterest({ id: '1' }, REF)
  assert.equal(bare.media.length, 0)
  assert.equal(bare.title, undefined, 'an empty title is absent, not an empty bold block')
  assert.equal(bare.text, '')
  assert.equal(bare.author.name, 'Pinterest', 'rather than an empty byline')
  assert.equal(bare.author.url, 'https://www.pinterest.com')
  assert.ok(!bare.author.avatar)
  assert.equal(bare.counts.likes, undefined)
  // createdAt is a required Date and render/mastodon.ts calls toISOString() on it.
  assert.doesNotThrow(() => bare.createdAt.toISOString())
  assert.equal(bare.canonical, 'https://www.pinterest.com/pin/66287425756772418/')
})

test('the real image pin normalizes end to end', () => {
  const post = normalizePinterest(IMAGE, REF)
  /**
   * THE IDENTITY IN THIS FIXTURE IS SYNTHETIC, and deliberately so. It was captured from a real
   * pin belonging to a private individual, and this repo is public — so the person's name, handle
   * and avatar url were replaced with placeholders before publication. The normalizer cares about
   * the SHAPE of the payload, never about who is in it, so the assertions are unweakened.
   */
  assert.equal(post.author.handle, 'fixture_user_2')
  assert.equal(post.author.name, 'Robin Fixture')
  assert.equal(post.title, "Great grandma's Dilly Bread")
  assert.match(post.text, /Family recipes/)
  assert.equal(post.media[0].kind, 'image')
  assert.equal(post.createdAt.getUTCFullYear(), 2021)
  assert.equal(post.counts.likes, 12, 'saves — Pinterest\'s unit of approval')
})

test('Pinterest disturbs no neighbour', () => {
  assert.equal(r('/p/DbN6SsKum-9').ref.p, 'ig')
  assert.equal(r('/xqc/status/20').ref.p, 'x')
  assert.equal(r('/lemmy.world/post/49966212').ref.p, 'lm')
  assert.equal(r('/r/pics/comments/abc123').ref.p, 'rd')
})

/**
 * A STAND-IN FOR PinResource THAT KEEPS THE TWO WALLS MEASURED ON 2026-10-05 (dev sandbox, not a
 * Worker), each with the body it really answers, so a fetcher that drops either header gets exactly
 * what production got. Never touches the network: it replaces globalThis.fetch and records every ask.
 */
const PIN_BODY = readFileSync(new URL('pinterest-pin-image.json', F), 'utf8')
async function withFakePinterest(body) {
  const real = globalThis.fetch
  const asks = []
  globalThis.fetch = async (input, init = {}) => {
    const h = new Headers(init.headers)
    asks.push({ url: String(input), headers: h })
    if (!(h.get('user-agent') ?? '').trim()) {
      return new Response(JSON.stringify({
        message: "Looks like you don't have permission to access this page. Your pinterest request id: 1.",
        status: 403,
      }), { status: 403, headers: { 'content-type': 'application/json' } })
    }
    if (h.get('x-pinterest-pws-handler') !== 'www/pin/[id].js') {
      return new Response('Invalid Resource Request', { status: 403, headers: { 'content-type': 'text/plain' } })
    }
    return new Response(PIN_BODY, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    return { got: await body(), asks }
  } finally {
    globalThis.fetch = real
  }
}

test('the pin request carries a non-empty user-agent beside the handler header, because Pinterest 403s every pin asked without one', async () => {
  /**
   * THE DEFECT: Pinterest was down on every pin in production. fetchPinterest sent only the handler
   * header and `accept`, a Worker's fetch adds no user-agent of its own, and somewhere between
   * 2026-08-12 and 2026-10-05 PinResource began refusing UA-less requests with 403 "Looks like you
   * don't have permission to access this page". /_smoke's pn row drew a failure card and /_api/v1
   * answered fetch_fail for 5 of 5 pins. The handler header alone, which was the whole gate in July,
   * is not enough now, so this asserts BOTH ride on the same request.
   *
   * An empty or whitespace user-agent counts as none: measured from the dev sandbox, a present but
   * empty UA got the same 403 as an absent one.
   */
  const { got, asks } = await withFakePinterest(() => fetchPinterest(REF))
  assert.equal(asks.length, 1, 'one ask: a 200 is never asked again')
  const [ask] = asks
  assert.match(ask.url, /^https:\/\/www\.pinterest\.com\/resource\/PinResource\/get\/\?/)
  assert.ok((ask.headers.get('user-agent') ?? '').trim().length > 0, 'a non-empty user-agent is sent')
  assert.equal(ask.headers.get('x-pinterest-pws-handler'), 'www/pin/[id].js', 'and the handler header with it')
  // Content, not status: the fetcher came back holding THE pin, its own id and headline intact.
  assert.equal(got.ok, true)
  assert.equal(got.pin.id, '66287425756772418')
  assert.equal(pinTitle(got.pin), "Great grandma's Dilly Bread")
})

test('the no-user-agent 403 body is a refusal, never a pin, even if it ever arrives as a 200', async () => {
  /**
   * The wall answers JSON, so it parses. It is refused today by the status check, but CLAUDE.md's
   * first rule is that status proves nothing and several upstreams decoy with HTTP 200. This pins that
   * the PAYLOAD check alone also refuses it: it has no `resource_response`, so it can never become a
   * card with an empty title.
   */
  const wall = JSON.stringify({ message: "Looks like you don't have permission to access this page.", status: 403 })
  for (const status of [403, 200]) {
    const real = globalThis.fetch
    globalThis.fetch = async () => new Response(wall, { status, headers: { 'content-type': 'application/json' } })
    try {
      assert.deepEqual(await fetchPinterest(REF), { ok: false, reason: 'assert_fail' }, `HTTP ${status}`)
    } finally {
      globalThis.fetch = real
    }
  }
})
