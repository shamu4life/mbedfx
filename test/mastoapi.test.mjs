import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { fetchMasto } from '../src/platforms/mastoapi/fetch.ts'
import { effectiveStatus, fullHandle, mastoMedia, normalizeMasto } from '../src/platforms/mastoapi/normalize.ts'

/**
 * THE MASTODON-API FAMILY — one client, several softwares, and the scope was set by measurement
 * rather than by the API's reputation.
 *
 * WHAT ANSWERS `GET /api/v1/statuses/{id}` UNAUTHENTICATED (2026-07-28, real permalinks):
 *   Mastodon ✅   Pleroma ✅   Akkoma ✅   Iceshrimp ✅
 *   GoToSocial ❌ 401 `token not supplied` (0.21 and 0.22, two instances; unsigned AP is 401 too)
 *   Pixelfed   ❌ HTTP 500 whose BODY is `{"error":"Unauthenticated."}`, and a 302 to /login elsewhere
 *
 * A first draft of this client claimed GoToSocial and Pixelfed. That would have been the identical
 * mistake this project had just finished undoing for PieFed — a shape that looks supported and always
 * fails — so neither is routed.
 *
 * THE PROBE THAT NEARLY LIED. An early sweep sourced ids from `/api/v1/timelines/public` and reported
 * several softwares as gated, because that TIMELINE is 401/422 on many instances. The single-status
 * endpoint is a different permission: stereophonic.space returns 401 on the timeline and serves
 * `/api/v1/statuses/{id}` wide open. The probe's limit had masqueraded as the platform's.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => JSON.parse(readFileSync(new URL(n, F), 'utf8'))

const IMAGES = load('masto-status-images.json')
const VIDEO = load('masto-status-video.json')
const GIFV = load('masto-status-gifv.json')
const TEXT = load('masto-status-text.json')
const REBLOG = load('masto-status-reblog.json')

const HOST = 'mstdn.social'
const REF = { p: 'ms', host: HOST, id: '116995943988954963' }
const r = p => route(new URL(`https://staging.megapenispoopenfarten.sex${p}`))

test('EVERY PERMALINK SHAPE IN THE FAMILY FOLDS TO ONE REF', () => {
  /**
   * All four forms are served by Mastodon itself (verified 200 on each), and `/notice/{id}` is
   * Pleroma's and Akkoma's — where the flake id in the URL is verbatim the API id.
   */
  const id = '116995943988954963'
  for (const p of [
    `/${HOST}/@stux/${id}`,
    `/${HOST}/@Portes_Thomas@mastox.eu/${id}`,   // a REMOTE account read locally
    `/${HOST}/@stux/statuses/${id}`,
    `/${HOST}/users/stux/statuses/${id}`,
    `/${HOST}/statuses/${id}`,
    `/${HOST}/notice/${id}`,
    `/https://${HOST}/@stux/${id}`,              // the prepend alias
    `/ms/${HOST}/@stux/${id}`,                   // the escape hatch
  ]) {
    assert.deepEqual(r(p).ref, REF, `${p} -> one ref`)
  }
  assert.equal(refKey(REF), `ms:${HOST}:${id}`)
  assert.deepEqual(parseRefKey(`ms:${HOST}:${id}`), REF)
})

test('THE USERNAME IS DECORATION FOR THE API — but NOT for the HTML page', () => {
  /**
   * Measured on mstdn.social: `/api/v1/statuses/{id}` takes no username at all and returns the post,
   * so parsing only the trailing id is correct. The HTML page is the opposite — `/@WRONGNAME/{id}`
   * and even `/@a-real-different-user/{id}` both 404, and `/@Gargron/{id}` 410s.
   *
   * That asymmetry is why this router stores no user and why nothing here may grow an HTML fallback
   * that rewrites the username: the API tolerates it, the page does not.
   */
  const a = r(`/${HOST}/@stux/116995943988954963`).ref
  const b = r(`/${HOST}/@literally-anyone/116995943988954963`).ref
  assert.deepEqual(a, b, 'both mint the same ref')
  assert.equal(Object.hasOwn(a, 'user'), false, 'and the ref carries no user at all')
})

test('THE ID SHAPE SPANS THREE SOFTWARES — digits-only would drop two of them', () => {
  const ok = [
    '116995943988954963',           // Mastodon snowflake
    'AhF3rSKHCdWTxTKGmi',           // Pleroma FlakeID
    '01H8XPS3M4VQKB7FZG2N9YRJDT',   // GoToSocial ULID
  ]
  for (const id of ok) assert.equal(r(`/${HOST}/@u/${id}`).kind, 'post', `${id} routes`)
  // CASE IS PRESERVED, unlike the host: FlakeIDs and ULIDs are case-bearing, so lowercasing would
  // corrupt them. Two spellings are two ids upstream, not one id twice.
  assert.notDeepEqual(r(`/${HOST}/@u/AbC`).ref, r(`/${HOST}/@u/abc`).ref)
  // ALPHANUMERIC-ONLY is the security property — the id is interpolated into a path on a host the
  // user also supplied, so nothing that could climb out of the segment is admitted.
  // '?' and '#' are NOT tested here: they terminate the path in a URL, so they never reach a
  // segment — the guard that matters for them is the URL parser, not this class.
  for (const bad of ['a/b', 'a.b', 'a%2fb', 'a:b', '', 'x'.repeat(65)]) {
    assert.notEqual(r(`/${HOST}/@u/${bad}`).kind, 'post', `${JSON.stringify(bad)} must not route`)
    assert.equal(parseRefKey(`ms:${HOST}:${bad}`), null, `nor parse as a refKey`)
  }
})

test('THE HOST IS RE-VALIDATED IN parseRefKey — it decides who the Worker talks to', () => {
  for (const bad of ['localhost', '127.0.0.1', '::1', '[::1]', 'a', 'host:8080', 'u@host.com', '']) {
    assert.equal(parseRefKey(`ms:${bad}:123`), null, `${bad} must not parse`)
  }
  assert.equal(parseRefKey('ms:mstdn.social'), null, 'a truncated key is not a ref')
  assert.equal(parseRefKey('ms:mstdn.social:1:2'), null)
})

test('PIXELFED AND GOTOSOCIAL ARE NOT ROUTED — a shape that always fails is worse than notfound', () => {
  // Pixelfed's permalink. Its Mastodon API answers 500 `Unauthenticated`, so a ref here would mint a
  // card that never loads.
  assert.notEqual(r('/pixelfed.social/p/dansup/983334946843155557').kind, 'post')
})

test('A BOOST IS UNWRAPPED — the outer status is EMPTY', () => {
  /**
   * Measured on a real boost: the outer status's `content` is the empty string and it has no media.
   * Rendering it would produce a blank card, so the unwrap is not a nicety.
   */
  assert.equal(REBLOG.content, '', 'the fixture really is empty')
  assert.ok(REBLOG.reblog, 'and carries its payload in reblog')
  assert.equal(effectiveStatus(REBLOG).id, REBLOG.reblog.id)
  const post = normalizeMasto(REBLOG, { p: 'ms', host: HOST, id: REBLOG.id })
  assert.ok(post.text.length > 0, 'the card is not blank')
  assert.match(post.text, /^🔁 boosted by @stux@mstdn\.social/, 'and names who boosted it')
  assert.equal(post.author.handle, 'josh@hactivedirectory.com', 'the author is the ORIGINAL poster')
  // canonical stays on what the user pasted — the boost — not on the inner post.
  assert.match(post.canonical, new RegExp(`/${REBLOG.id}$`))
})

test('canonical IS THE PASTED INSTANCE, NEVER status.url — which can be TWITTER', () => {
  /**
   * The measurement that settles it. A bridged account read from mstdn.social returns:
   *     status.url = https://twitter.com/somos_FOX/status/2081974010259104079
   * Using `url` as canonical would 302 someone who clicked a Mastodon link to Twitter. A Pleroma
   * origin gives `/objects/{uuid}` — an id space our own router cannot route back.
   */
  assert.match(VIDEO.url, /^https:\/\/twitter\.com\//, 'the fixture really does point off-platform')
  const post = normalizeMasto(VIDEO, { p: 'ms', host: HOST, id: VIDEO.id })
  assert.match(post.canonical, /^https:\/\/mstdn\.social\//)
  assert.doesNotMatch(post.canonical, /twitter\.com/)
})

test('A REMOTE HANDLE KEEPS ITS LITERAL @ in the canonical', () => {
  // encodeURIComponent escapes '@' and yields `/@Portes_Thomas%40mastox.eu/…` — a URL Mastodon never
  // mints. The acct is placed raw after a class check that admits no '/', '?', '#', ':' or '%'.
  const post = normalizeMasto(IMAGES, REF)
  assert.equal(post.canonical, 'https://mstdn.social/@Portes_Thomas@mastox.eu/116995943988954963')
  assert.doesNotMatch(post.canonical, /%40/)
  // An acct that fails the safe class degrades to the username-free permalink rather than being
  // escaped into a broken one.
  const weird = normalizeMasto(
    { ...IMAGES, account: { ...IMAGES.account, acct: 'a/../b' } },
    { p: 'ms', host: HOST, id: '123' },
  )
  assert.equal(weird.canonical, 'https://mstdn.social/statuses/123')
})

test('THE HANDLE IS ALWAYS FULLY QUALIFIED', () => {
  assert.equal(fullHandle('stux', HOST), 'stux@mstdn.social', 'a local acct gains the reading host')
  assert.equal(fullHandle('a@b.tld', HOST), 'a@b.tld', 'a remote acct is already qualified')
  assert.equal(fullHandle('', HOST), '')
  assert.equal(normalizeMasto(IMAGES, REF).author.handle, 'Portes_Thomas@mastox.eu')
})

test('gifv MAPS TO video, NOT TO OUR gif — they mean opposite things', () => {
  /**
   * Our `Media.kind === 'gif'` means THE URL IS AN ANIMATED .gif FILE, and render/mastodon.ts maps it
   * to an `image` attachment for that reason. Mastodon's `gifv` is the reverse: a soundless looping
   * MP4. Calling it 'gif' would hand Discord mp4 bytes labelled as a picture.
   */
  assert.equal(GIFV.media_attachments[0].type, 'gifv', 'the fixture really is a gifv')
  assert.match(GIFV.media_attachments[0].url, /\.mp4$/, 'and it really is an mp4')
  const [m] = mastoMedia(GIFV)
  assert.equal(m.kind, 'video')
})

test('A POSTER THAT IS THE VIDEO ITSELF IS REFUSED — the Pleroma shape', () => {
  /**
   * On Mastodon `preview_url` is a real generated still. ON PLEROMA IT IS NOT: measured on
   * stereophonic.space, `url`, `preview_url`, `remote_url` and `text_url` are all THE SAME .webm and
   * `meta` is null. Passing it through would tell Discord to fetch a poster and hand it video bytes —
   * the Phase 2 defect in types.ts that dropped the rich card to plain OpenGraph.
   */
  const pleroma = {
    media_attachments: [{
      type: 'video',
      url: 'https://stereophonic.space/media/2292.webm',
      preview_url: 'https://stereophonic.space/media/2292.webm',
      meta: null,
    }],
  }
  const [m] = mastoMedia(pleroma)
  assert.equal(m.kind, 'video')
  assert.equal(m.poster, undefined, 'posterless beats a poster that is really the video')
  assert.equal(m.w, 0, 'and null meta costs dimensions, not a crash')
  // Mastodon's real poster still comes through.
  assert.ok(mastoMedia(VIDEO)[0].poster, 'a genuine preview_url is kept')
  assert.notEqual(mastoMedia(VIDEO)[0].poster, mastoMedia(VIDEO)[0].url)
})

test('A CAROUSEL KEEPS EVERY ATTACHMENT AND ITS OWN DIMENSIONS', () => {
  const media = mastoMedia(IMAGES)
  assert.equal(media.length, 4)
  assert.deepEqual(media.map(m => `${m.w}x${m.h}`), ['1200x800', '538x1200', '770x513', '770x513'])
  assert.ok(media.every(m => m.kind === 'image'))
})

test('audio AND unknown ARE DROPPED rather than guessed at', () => {
  const odd = { media_attachments: [
    { type: 'audio', url: 'https://x.tld/a.mp3' },
    { type: 'unknown', url: 'https://x.tld/u.bin' },
    { type: 'image', url: 'http://x.tld/insecure.jpg' },
  ] }
  assert.deepEqual(mastoMedia(odd), [], 'including a non-https url')
})

test('A CONTENT WARNING LEADS THE BODY AND MARKS THE POST SENSITIVE', () => {
  const cw = { ...TEXT, spoiler_text: 'food, veg, tofu day!', sensitive: true, content: '<p>hi</p>' }
  const post = normalizeMasto(cw, { p: 'ms', host: HOST, id: '1' })
  assert.match(post.text, /^⚠️ food, veg, tofu day!/)
  assert.match(post.text, /hi/, 'the guarded text is still shown — a blank card is worse')
  assert.equal(post.sensitive, true)
  // A CW alone marks it sensitive even if the instance omitted the flag.
  assert.equal(normalizeMasto({ ...cw, sensitive: false }, REF).sensitive, true)
})

test('THE HTML CONTENT BECOMES READABLE TEXT, not one run-together line', () => {
  const post = normalizeMasto(
    { ...TEXT, content: '<p>one</p><p>two<br />three</p>', account: TEXT.account },
    { p: 'ms', host: HOST, id: '1' },
  )
  assert.equal(post.text, 'one\n\ntwo\nthree')
  // Entities are decoded, and &amp; last so an escaped entity is not re-animated.
  const ent = normalizeMasto({ ...TEXT, content: '<p>a &amp;lt; b &quot;q&quot;</p>' }, REF)
  assert.equal(ent.text, 'a &lt; b "q"')
})

test('normalizeMasto is TOTAL over a status with holes', () => {
  const bare = { id: '1', account: { acct: 'u' } }
  const post = normalizeMasto(bare, { p: 'ms', host: HOST, id: '1' })
  assert.equal(post.media.length, 0)
  assert.equal(post.title, undefined, 'a microblog post has no title')
  assert.equal(post.text, '')
  assert.equal(post.author.name, 'u')
  assert.equal(post.author.handle, 'u@mstdn.social')
  assert.ok(!post.author.avatar)
  assert.deepEqual(post.counts, { likes: undefined, replies: undefined, reposts: undefined })
  assert.doesNotThrow(() => post.createdAt.toISOString())
  assert.equal(normalizeMasto({ id: '1' }, REF), null, 'no account at all is null, not a blank card')
})

test('THE FETCHER ASSERTS ON CONTENT — a 200 proves nothing', async () => {
  const real = globalThis.fetch
  const ref = { p: 'ms', host: 'mstdn.social', id: '1' }
  try {
    // HTML at 200 — the decoy shape.
    globalThis.fetch = async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    assert.deepEqual(await fetchMasto(ref), { ok: false, reason: 'assert_fail' })

    // JSON at 200 that is not a status.
    globalThis.fetch = async () => new Response('{"hello":"world"}', { headers: { 'content-type': 'application/json' } })
    assert.deepEqual(await fetchMasto(ref), { ok: false, reason: 'assert_fail' })

    // `id` AS A NUMBER is refused: this API serialises ids as STRINGS precisely because they
    // overflow a double, so a numeric id is a decoy Mastodon itself would never send.
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 1, account: { acct: 'u' } }),
      { headers: { 'content-type': 'application/json' } })
    assert.deepEqual(await fetchMasto(ref), { ok: false, reason: 'assert_fail' })

    // A status with no account.
    globalThis.fetch = async () => new Response(JSON.stringify({ id: '1' }),
      { headers: { 'content-type': 'application/json' } })
    assert.deepEqual(await fetchMasto(ref), { ok: false, reason: 'assert_fail' })

    // 404/410 is a WALL, counted as notfound rather than inflating assert_fail.
    globalThis.fetch = async () => new Response('{"error":"Record not found"}',
      { status: 404, headers: { 'content-type': 'application/json' } })
    assert.deepEqual(await fetchMasto(ref), { ok: false, reason: 'notfound' })
    globalThis.fetch = async () => new Response('', { status: 410, headers: { 'content-type': 'application/json' } })
    assert.deepEqual(await fetchMasto(ref), { ok: false, reason: 'notfound' })

    // The real shape survives.
    globalThis.fetch = async () => new Response(JSON.stringify(VIDEO), { headers: { 'content-type': 'application/json' } })
    assert.equal((await fetchMasto(ref)).ok, true)
  } finally {
    globalThis.fetch = real
  }
})

test('THE SSRF GUARD REFUSES OUR OWN ZONE AND ANY MALFORMED HOST', async () => {
  const real = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => { called++; return new Response('{}', { headers: { 'content-type': 'application/json' } }) }
  try {
    for (const host of ['megapenispoopenfarten.sex', 'a.megapenispoopenfarten.sex', 'x.workers.dev']) {
      assert.deepEqual(await fetchMasto({ p: 'ms', host, id: '1' }), { ok: false, reason: 'assert_fail' })
    }
    assert.equal(called, 0, 'and no request was made at all')
  } finally {
    globalThis.fetch = real
  }
})

test('the Mastodon-API family disturbs no neighbour', () => {
  assert.equal(r('/p/DbN6SsKum-9').ref.p, 'ig')
  assert.equal(r('/xqc/status/20').ref.p, 'x')
  assert.equal(r('/lemmy.world/post/49966212').ref.p, 'lm')
  assert.equal(r('/pin/66287425756772418').ref.p, 'pn')
  assert.equal(r('/misskey.io/notes/ap7sliijot1f03nr').ref.p, 'mk')
  // A handle-shaped first segment can never satisfy FEDI_HOST, which is what keeps this matcher off
  // every other platform's turf.
  assert.notEqual(r('/@stux/116995943988954963').kind, 'post')
  assert.equal(r('/@tiktokuser/video/123').ref.p, 'tt')
})
