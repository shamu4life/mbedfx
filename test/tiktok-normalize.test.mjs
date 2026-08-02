import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { normalizeTikTok, tiktokGate, videoDetailScope } from '../src/platforms/tiktok/normalize.ts'
import {
  TIKTOK_UA, fetchTikTok, hasRehydrationPayload, hasVideoDetailScope, pageOutcome,
  resolveAwemeUrl, resolveTikTokShortlink, shortlinkOutcome, withResolvedVideo,
} from '../src/platforms/tiktok/fetch.ts'

const html = f => readFileSync(`test/fixtures/tiktok-${f}.html`, 'utf8')
const VIDEO = html('video')
const SLIDES = html('slideshow')
const DELETED = html('deleted')
// The real TikTok HOMEPAGE, captured 2026-07-19 with TIKTOK_UA and re-wrapped like the others.
// It is in the fixtures for exactly one reason: it is the only body that separates "the page
// carries a rehydration blob" from "the page is a POST page". Plan fact 10 measured it at 257KB
// of blob; this capture is 257,666 bytes of it, with no webapp.video-detail scope.
const HOMEPAGE = html('homepage')

// Fill these in from the Step 1 inspection output.
const VIDEO_REF = { p: 'tt', id: '7660566211100511518' }
const SLIDES_REF = { p: 'tt', id: '7663591047909379341' }

/**
 * A modified `webapp.video-detail` scope, re-wrapped into the page shape the normalizer parses.
 * Editing the scope object and re-wrapping beats a string replace on the capture: the fixture
 * spells its slashes as JSON escapes, so a naive replace silently matches nothing (see the
 * degradation test's SLASH comment for the green-and-vacuous test that taught us this).
 */
const wrap = scope =>
  `<!doctype html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${
    JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': scope } })
  }</script>`

test('a video post normalizes into a well-formed Post', () => {
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  assert.ok(post, 'must normalize')
  assert.deepEqual(post.ref, VIDEO_REF)
  assert.ok(post.author.handle.length > 0)
  assert.ok(post.createdAt instanceof Date)
  // Fact 9: createTime is a decimal STRING of Unix SECONDS ('1783614572'). A `typeof === 'number'`
  // guard returns null here for every real post; `new Date(str)` without *1000 is 1970.
  assert.ok(!Number.isNaN(post.createdAt.getTime()), 'createTime is a STRING of SECONDS — Number() it, then *1000')
  assert.ok(post.createdAt.getUTCFullYear() > 2015, `a bare new Date(seconds) lands in 1970, got ${post.createdAt.toISOString()}`)
  assert.equal(typeof post.text, 'string')
  assert.equal(post.sensitive, false, 'TikTok does not expose a sensitivity signal — spec says always false')
})

test('canonical is rebuilt from the PAYLOAD, since the ref carries only an id', () => {
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  assert.match(post.canonical, /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/7660566211100511518$/)
})

test('canonical degrades to the @i form when the payload has no uniqueId', () => {
  // Verified 2026-07-18: tiktok.com/@i/video/{id} resolves without knowing the username, so
  // the degrade is a WORKING link rather than a plausible-looking dead one.
  const stripped = VIDEO.replace(/"uniqueId":"[^"]*"/, '"uniqueId":""')
  const post = normalizeTikTok(stripped, VIDEO_REF)
  assert.equal(post.canonical, 'https://www.tiktok.com/@i/video/7660566211100511518')
})

test('THE VIDEO URL IS THE /aweme/v1/play/ ONE, selected by substring and never by index', () => {
  // playAddr and the *-webapp-prime hosts are cookie-gated (tk=tt_chain_token) and 403 without
  // a cookie, which is exactly what Discord's media proxy sends. The aweme endpoint
  // content-negotiates on cookies: cookie-free it 302s to a working tiktokcdn-us host.
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  const v = post.media.find(m => m.kind === 'video')
  assert.ok(v, 'a video post must yield a video Media entry')
  assert.ok(v.url.includes('/aweme/v1/play/'), `must be the aweme URL, got ${v.url}`)
  assert.ok(!v.url.includes('webapp-prime'), 'a cookie-gated host must never be handed out')
  assert.ok(v.w > 0 && v.h > 0, 'dimensions come from video.width/height')
  // Pinned exactly: dropping the duration assignment altogether survived the whole suite, and
  // duration is what renderers use to decide a video is worth an og:video:duration at all.
  assert.equal(v.duration, 67, 'duration <- video.duration')
})

test('the aweme URL is picked by CONTENT even when it is not first in the list', () => {
  // Upstream okdargy/fxTikTok selects by substring (src/generate.ts:63) and index position is
  // not guaranteed stable. Proven on a synthetic list rather than by trusting the fixture's
  // current ordering, which would make this test pass for the wrong reason.
  const raw = {
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': {
        statusCode: 0,
        itemInfo: { itemStruct: {
          // STRING createTime and a MIXED stats object, exactly as the live payload spells them
          // (fact 9). Written this way deliberately: a synthetic fixture with a NUMBER here
          // passes against a `typeof === 'number'` normalizer that returns null for every real
          // post, so the green synthetic test would argue the real fixture was wrong.
          id: '1', desc: 'x', createTime: '1750000000',
          author: { uniqueId: 'u', nickname: 'U' },
          stats: { diggCount: 21000, playCount: '75900' },
          video: {
            width: 720, height: 1280, duration: 10, cover: 'https://cdn/c.jpg',
            playAddr: 'https://v16-webapp-prime.tiktok.com/gated.mp4?tk=tt_chain_token',
            bitrateInfo: [{ PlayAddr: { UrlList: [
              'https://v16-webapp-prime.tiktok.com/a.mp4?tk=tt_chain_token',
              'https://v19-webapp-prime.tiktok.com/b.mp4?tk=tt_chain_token',
              'https://www.tiktok.com/aweme/v1/play/?video_id=v&file_id=f',
            ] } }],
          },
        } },
      },
    },
  }
  const wrapped = `<!doctype html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`
  const post = normalizeTikTok(wrapped, { p: 'tt', id: '1' })
  assert.equal(post.media[0].url, 'https://www.tiktok.com/aweme/v1/play/?video_id=v&file_id=f')
})

test('STRING createTime and STRING counts COERCE — the live payload spells them that way', () => {
  // The same synthetic post as above, re-asserted for fact 9. This is the test that fails if
  // anyone "tightens" the normalizer to `typeof x === 'number'`: that guard is the natural
  // defensive write in this repo, it matches build()'s Bluesky shape, and it returns null for
  // 100% of real TikTok posts. Coerce with Number() and reject NaN — never type-guard.
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000',
      author: { uniqueId: 'u', nickname: 'U' },
      stats: { diggCount: 21000, playCount: '75900', commentCount: '7' },
      video: { width: 720, height: 1280, cover: 'https://cdn/c.jpg',
        bitrateInfo: [{ PlayAddr: { UrlList: ['https://www.tiktok.com/aweme/v1/play/?video_id=v'] } }] },
    } } } },
  }
  const post = normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  )
  assert.ok(post, 'a STRING createTime must not make the whole post null')
  assert.equal(post.createdAt.getTime(), 1750000000 * 1000)
  assert.equal(post.counts.likes, 21000, 'a NUMBER count survives')
  assert.equal(post.counts.views, 75900, 'a STRING count is coerced, not dropped and not kept as a string')
  assert.equal(post.counts.replies, 7)
})

test('a count that cannot be a number is ABSENT, never NaN and never a string', () => {
  // NaN JSON-serializes to null and would reach a renderer as a count of "null"; a string
  // would reach mastodon.ts's payload as a quoted value where a number is required.
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000', author: { uniqueId: 'u' },
      stats: { diggCount: 'lots', playCount: null, commentCount: {} },
      video: { width: 720, height: 1280, cover: 'https://cdn/c.jpg' },
    } } } },
  }
  const post = normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  )
  assert.ok(post)
  for (const k of ['likes', 'reposts', 'replies', 'views']) {
    assert.ok(!(k in post.counts) || typeof post.counts[k] === 'number', k)
    assert.ok(!Number.isNaN(post.counts[k]), `${k} must be absent, not NaN`)
  }
  // THE ZERO-INVENTION HALF, made able to fail. Everything above passes under a num() with its
  // null/''/object/boolean exclusion deleted, because `Number(null)` is 0 — a number, and not
  // NaN. Deleting that whole line left 254/254 green before this assertion existed. An invented
  // "0 views" is worse than a missing one: the renderer prints it as fact.
  assert.ok(!('views' in post.counts), 'a null count must be ABSENT, not 0 — Number(null) is 0')
  assert.ok(!('replies' in post.counts), 'an object count must be ABSENT, not 0 — Number({}) is NaN but [] is 0')
  assert.ok(!('likes' in post.counts), "'lots' does not coerce, so likes must be absent")
})

test('a blank-string or negative or fractional count is ABSENT, never a coerced 0', () => {
  // num()'s comment claims to exclude "the values Number() silently turns into 0", but the
  // exclusion list was `null`/`''`/object/boolean only — and `Number(' ')` is also 0, so a
  // whitespace-only count hit the exact failure the comment says it prevents. A count is a
  // cardinality: negative and fractional values are nonsense that would reach a renderer and be
  // printed as fact, so they are dropped rather than rounded into something plausible.
  const mk = digg => `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000', author: { uniqueId: 'u' },
      stats: { diggCount: digg }, video: { cover: 'https://cdn/c.jpg' },
    } } } },
  })}</script>`
  for (const bad of [' ', '\n', '\t', -5, '-5', 1.9, '1.9']) {
    const post = normalizeTikTok(mk(bad), { p: 'tt', id: '1' })
    assert.ok(post, `${JSON.stringify(bad)} must not null the whole post — one bad count is not a bad post`)
    assert.ok(!('likes' in post.counts), `${JSON.stringify(bad)} must leave likes ABSENT, got ${post.counts.likes}`)
  }
  // …and the values that legitimately coerce still arrive, so the guard is not just "reject all".
  assert.equal(normalizeTikTok(mk('3000'), { p: 'tt', id: '1' }).counts.likes, 3000, 'fact 9: a STRING count still coerces')
  assert.equal(normalizeTikTok(mk(0), { p: 'tt', id: '1' }).counts.likes, 0, 'a genuine zero is a real count, not an absence')
})

test('an unparseable createTime is NULL, not a 1970 post', () => {
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: 'not-a-time', author: { uniqueId: 'u' }, stats: {}, video: {},
    } } } },
  }
  assert.equal(normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  ), null)
})

test('AN OUT-OF-RANGE createTime IS NULL — an Invalid Date must never escape the normalizer', () => {
  // `Number.isFinite(t)` is NOT enough. The ECMAScript Date range is +/-8.64e15 ms, so any
  // createTime above ~8.64e12 seconds coerces to a finite number and `new Date(t*1000)` is an
  // Invalid Date — which sailed straight through into a Post.
  //
  // THIS IS AN INVARIANT ANOTHER MODULE DOCUMENTS AND DECLINES TO GUARD. render/mastodon.ts
  // says in a comment that "the normalizer rejects an unparseable date outright … so this needs
  // no guard of its own" and then calls post.createdAt.toISOString() bare. An Invalid Date makes
  // that throw RangeError, and worker.ts calls toMastodonStatus on the 'activity' route with no
  // try/catch — an uncaught 500. Bluesky's normalizer validates the DATE (normalize.ts:83-84);
  // this one validated only the NUMBER. Validate what you are about to hand out.
  const mk = createTime => `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime, author: { uniqueId: 'u', nickname: 'U' }, stats: {},
      video: { width: 720, height: 1280, cover: 'https://cdn/c.jpg' },
    } } } },
  })}</script>`
  for (const t of ['99999999999999', 10000000000000, '8640000000001', '1e19', 8640000000000000, 1e300]) {
    assert.equal(normalizeTikTok(mk(t), { p: 'tt', id: '1' }), null, `${JSON.stringify(t)} makes an Invalid Date — must be null, not a Post`)
  }
  // The same guard's smaller sibling: `Number(true)` is 1, so a boolean createTime became a post
  // dated 1970-01-01T00:00:01Z — the exact outcome the sibling test's name forbids. num() already
  // excludes booleans and says why; the createTime path was calling bare Number() instead.
  for (const t of [true, false, [], {}, ' ', 0, -1, '-1750000000']) {
    assert.equal(normalizeTikTok(mk(t), { p: 'tt', id: '1' }), null, `${JSON.stringify(t)} is not a timestamp — must be null, not a 1970 post`)
  }
  // …and the real spelling still works, so the guard is not just "reject everything".
  assert.equal(normalizeTikTok(mk('1783614572'), { p: 'tt', id: '1' }).createdAt.getTime(), 1783614572000)
})

test('every Post the normalizer emits carries a VALID Date — checked on the real captures', () => {
  // The end of the invariant above, asserted where it is consumed rather than only where it is
  // built: toISOString() is what mastodon.ts calls, and it is what throws.
  for (const [html, ref] of [[VIDEO, VIDEO_REF], [SLIDES, SLIDES_REF]]) {
    const post = normalizeTikTok(html, ref)
    assert.ok(!Number.isNaN(post.createdAt.getTime()), 'createdAt must be a real Date')
    assert.doesNotThrow(() => post.createdAt.toISOString(), 'mastodon.ts calls this bare, on purpose')
  }
})

test('the caption, display name and avatar are the RIGHT fields — pinned to the captures', () => {
  // These four are the primary VISIBLE surface of the Discord embed, and every one of them was
  // untested: mutants setting text to '', text to a wrong field, name to '', and avatar to
  // undefined all passed the whole suite. `typeof post.text === 'string'` cannot fail — the
  // normalizer's own expression makes it true by construction — so it pinned nothing. Exact
  // values from the fixture are what make a future wrong-field mapping loud.
  const v = normalizeTikTok(VIDEO, VIDEO_REF)
  assert.equal(v.text, 'Duck’s fish era has officially begun. \u{1F41F}✨', 'text <- itemStruct.desc, verbatim (curly apostrophe and emoji included)')
  assert.equal(v.author.name, 'Mystic Aquarium', 'author.name <- author.nickname, NOT uniqueId')
  assert.equal(v.author.handle, 'mysticaquariumct', 'author.handle <- author.uniqueId, NOT nickname')
  assert.equal(v.author.url, 'https://www.tiktok.com/@mysticaquariumct', 'a trustworthy handle builds a PROFILE url')
  assert.match(v.author.avatar, /^https:\/\//, 'avatar must be present and https — it is the fallback image on every media-less embed')
  assert.ok(v.author.avatar.includes('avt'), `avatar <- author.avatar*, got ${v.author.avatar}`)

  const s = normalizeTikTok(SLIDES, SLIDES_REF)
  assert.equal(s.author.name, 'Duolingo')
  assert.equal(s.author.handle, 'duolingo')
  // RECORDED, AND ESCALATED TO THE TASK 11 GATE. The plan directs text <- desc, and this capture
  // shows the two diverging: desc is '@Tinder ' (trailing space and all) while the caption a
  // human sees on tiktok.com is imagePost.title, 'game meets beautiful game'. So a photo post's
  // embed shows '@Tinder ' as its entire caption. This test pins TODAY'S plan-directed behaviour
  // so that whichever way the gate resolves it, the change is deliberate and visible in a diff —
  // it is not an endorsement of desc being the better field.
  assert.equal(s.text, '@Tinder ', 'plan-directed: text <- desc. imagePost.title is the human caption — see Task 11')
})

test('author.url degrades to the POST when the handle is untrustworthy', () => {
  // With no handle there is no profile URL to build, and tiktok.com/@i names no profile — so the
  // degrade points at the post itself, a link that works. Untested before: a mutant returning
  // canonical unconditionally passed everything, which would have silently sent every profile
  // link to the post instead.
  const stripped = VIDEO.replace(/"uniqueId":"[^"]*"/, '"uniqueId":"not a legal handle!"')
  const post = normalizeTikTok(stripped, VIDEO_REF)
  assert.equal(post.author.handle, '', 'a handle failing the path-segment guard is dropped entirely')
  assert.equal(post.author.url, 'https://www.tiktok.com/@i/video/7660566211100511518', 'no handle -> point at the post, not at a dead profile')
  assert.equal(post.author.name, 'Mystic Aquarium', 'the display name is independent of the handle guard')
})

test('a non-https media or avatar URL is REFUSED, not passed through', () => {
  // The guard's comment calls a protocol-relative or http URL here "a mixed-content hole we
  // would be authoring ourselves". It was untested: relaxing httpsUrl to accept any string left
  // 254/254 green. Every candidate below is a spelling that Number-of-`startsWith` would let by.
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000', stats: {},
      author: { uniqueId: 'u', nickname: 'U', avatarLarger: '//cdn/a.jpg', avatarMedium: 'http://cdn/a.jpg', avatarThumb: 'HTTPS://cdn/a.jpg' },
      video: { width: 720, height: 1280, cover: 'http://cdn/c.jpg', originCover: '//cdn/o.jpg',
        bitrateInfo: [{ PlayAddr: { UrlList: ['http://www.tiktok.com/aweme/v1/play/?video_id=v'] } }] },
    } } } },
  }
  const post = normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  )
  assert.ok(post, 'unusable URLs are not a reason to drop the whole post')
  assert.equal(post.author.avatar, undefined, 'no https avatar means NO avatar, not a mixed-content one')
  assert.equal(post.media.length, 0, 'an http aweme URL is not a usable video, and an http cover is not a usable still')
})

test("statusCode '0' AS A STRING is accepted — this payload is untrustworthy per-key about types", () => {
  // A deliberate widening beyond the plan, argued for in a comment (fact 9: collectCount ships as
  // a string beside four ints in the same object) and until now untested — so the next person to
  // "tighten" the gate would revert it silently and green. Both real captures carry a NUMBER 0,
  // so only a synthetic can exercise the string branch.
  const mk = statusCode => `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000', author: { uniqueId: 'u' }, stats: {},
      video: { cover: 'https://cdn/c.jpg' },
    } } } },
  })}</script>`
  assert.ok(normalizeTikTok(mk('0'), { p: 'tt', id: '1' }), "'0' must be accepted beside 0")
  assert.ok(normalizeTikTok(mk(0), { p: 'tt', id: '1' }), '0 must still be accepted')
  // The widening is a superset of exactly one value. Everything else still fails closed, and
  // that is the half that matters: these are the shapes a deleted post and a homepage produce.
  for (const bad of ['10204', 10204, '', null, undefined, false, ' 0', '0.0', '00']) {
    assert.equal(normalizeTikTok(mk(bad), { p: 'tt', id: '1' }), null, `${JSON.stringify(bad)} must fail closed`)
  }
})

test('BLOB extraction stays LINEAR — a hostile body must not burn the Worker CPU budget', () => {
  // `[^>]*` after the 46-char literal is quadratic: on a body carrying many copies of the literal
  // and no '>', each start position rescans to end-of-string. Measured on the unbounded pattern:
  // 300 KB -> 2.0 s, 1 MB -> 23 s, against Cloudflare's 30 s CPU ceiling — i.e. a self-inflicted
  // 500 on a body only 3x the size of a real TikTok page (the video capture is 287 KB). Bounding
  // the attribute scan takes the same 1 MB input to ~22 ms.
  //
  // The threshold is deliberately loose — this is a complexity-class assertion, not a benchmark.
  // Fixed is ~1000x under it and the quadratic version ~11x over it, so it cannot flake into
  // either verdict on a slow machine.
  const hostile = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"'.repeat(Math.ceil((1024 * 1024) / 46))
  const t0 = Date.now()
  assert.equal(normalizeTikTok(hostile, { p: 'tt', id: '1' }), null, 'no blob in it, so: null')
  const ms = Date.now() - t0
  assert.ok(ms < 2000, `1 MB of hostile input took ${ms}ms — the attribute scan has gone quadratic again`)
})

test('NO aweme URL degrades to the cover image, never to a gated URL', () => {
  // Phase 1's I-1 lesson, restated for a new platform: an og:video pointing at something that
  // cannot play renders a DEAD player and suppresses og:image, so the post shows nothing at
  // all. A still is strictly better than a blank player. Bluesky's HLS handling is the same
  // rule with a different cause.
  //
  // THE STRIP PATTERN IS SLASH-SPELLING-AWARE, and it has to be. The plan's version matched
  // only '/' or '\/'; the fixture spells every slash as the six-character JSON escape
  // backslash-u-0-0-2-F (781 of them in this capture), so that pattern matched ZERO of the
  // aweme URLs in it. (Written out in words on purpose — the first draft of this comment
  // contained the escape already decoded, so it read "spells every slash as the escape /" and
  // taught the next reader nothing.) The test still ran — against an
  // unmodified fixture — and "degraded" a post that still had a live aweme URL in it. It was
  // green and vacuous, which is the exact failure mode this file's other comments keep naming.
  // The two sanity assertions below are what make it impossible to regress that way again:
  // one proves the fixture carries the URLs, the other proves the strip removed them.
  const SLASH = String.raw`(?:/|\\/|\\u002[Ff])`
  const aweme = flags => new RegExp(`https:${SLASH}${SLASH}www\\.tiktok\\.com${SLASH}aweme${SLASH}v1${SLASH}play${SLASH}[^"]*`, flags)
  const noAweme = VIDEO.replace(aweme('g'), 'https://v16-webapp-prime.tiktok.com/gated.mp4')
  assert.ok(aweme('').test(VIDEO), 'fixture sanity: the capture really does carry aweme URLs')
  assert.ok(!aweme('').test(noAweme), 'fixture sanity: the strip must remove every one of them')
  const post = normalizeTikTok(noAweme, VIDEO_REF)
  assert.ok(!post.media.some(m => m.kind === 'video'), 'no playable url must mean no video entry')
  assert.ok(!post.media.some(m => m.url.includes('webapp-prime')), 'a gated url must never be surfaced')
  // NOT `if (post.media.length)`. Behind that guard, media:[] passes with zero assertions run —
  // the silently-vacuous shape Phase 2 only caught by mutation testing. The fixture HAS a
  // video.cover, so the degrade must produce exactly one image entry; asserting the count first
  // is what makes the kind assertion able to fail.
  assert.equal(post.media.length, 1, 'the cover must still produce one entry — a video post is not media-less')
  assert.equal(post.media[0].kind, 'image', 'the cover becomes a plain image entry')
  assert.match(post.media[0].url, /^https:\/\//)
})

test('a video post emits EXACTLY ONE media entry — the video, with no trailing cover', () => {
  // A second entry would be a spurious second gallery item in media_attachments — which is now
  // the surface a video post actually renders through, since the carve-out that sent it to the
  // plain og:video head was removed (2026-07-19). It would also be a picture that neither head's
  // og:video selection ever names, playableVideo() finding the video first.
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  assert.equal(post.media.length, 1)
})

test('A SLIDESHOW YIELDS EVERY IMAGE — this is the Phase 2 gallery path, for free', () => {
  const post = normalizeTikTok(SLIDES, SLIDES_REF)
  assert.ok(post, 'must normalize')
  // EXACT, not `>= 2`. The fixture's imagePost.images has 5 entries, each with a 2-entry urlList
  // that is a MIRROR pair (p16-/p19- hosts, same object path) — not two pictures. A regression
  // that pushes every mirror emits 10 entries and ships a Discord gallery showing all five
  // pictures twice; under `>= 2` that mutation passed all 17 tests. Same reasoning as the
  // `media.length === 1` pin on the video path: asserting the count is what makes the rest able
  // to fail.
  assert.equal(post.media.length, 5, `the capture is a 5-picture gallery, got ${post.media.length}`)
  for (const m of post.media) {
    assert.equal(m.kind, 'image')
    assert.match(m.url, /^https:\/\//)
    // The gallery's dimensions come from imageWidth/imageHeight, NOT from video.width/height —
    // which a slideshow carries as literal 0. Pinned because a mutation zeroing these survived.
    assert.ok(m.w > 0 && m.h > 0, `slideshow dims come from imageWidth/imageHeight, got ${m.w}x${m.h}`)
  }
  // DISTINCT PICTURES, checked by PATH and not by URL string. The mirrors differ in host and
  // signature, so a dedupe-by-URL would happily keep all ten; only the path proves they are
  // five different objects.
  const paths = post.media.map(m => new URL(m.url).pathname)
  assert.equal(new Set(paths).size, 5, 'each entry must be a DIFFERENT picture, not a CDN mirror of the same one')
  assert.ok(!post.media.some(m => m.kind === 'video'), 'a slideshow has no video entry')
  assert.match(post.canonical, /\/photo\//, 'a slideshow canonical uses the /photo/ form')
})

test('a video post keeps its video even when imagePost is present-but-NULL', () => {
  // `'imagePost' in item` is true for `imagePost: null`, so a single nullable field serialized as
  // null on video posts routed EVERY video post down the slideshow branch and stripped its media
  // — total loss on the most common shape there is, from an upstream change that adds nothing.
  // The discriminator must be a non-null imagePost OBJECT, not the presence of the key.
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000', author: { uniqueId: 'u', nickname: 'U' }, stats: {},
      imagePost: null,
      video: { width: 720, height: 1280, cover: 'https://cdn/cover.jpg',
        bitrateInfo: [{ PlayAddr: { UrlList: ['https://www.tiktok.com/aweme/v1/play/?video_id=v'] } }] },
    } } } },
  }
  const post = normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  )
  assert.equal(post.media.length, 1, 'imagePost:null is a VIDEO post — its aweme URL must survive')
  assert.equal(post.media[0].kind, 'video')
  assert.match(post.canonical, /\/video\//, 'and its canonical is the /video/ form, not /photo/')
})

test('a slideshow whose images are UNUSABLE degrades to a still, never to nothing', () => {
  // The video path already degrades to video.cover because "a still is strictly better" than a
  // media-less post (Phase 1's I-1 lesson). The slideshow path had no fallback at all, so if
  // TikTok renames `imageURL`/`urlList` — the single most likely way this branch dies — every
  // photo post would go media-less even though BOTH covers are sitting right there in the
  // payload. Each row below is a real drift shape, verified to produce media=0 before the fix.
  const mk = imagePost => `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000', author: { uniqueId: 'u' }, stats: {},
      imagePost,
      video: { width: 0, height: 0, cover: 'https://cdn/videocover.jpg' },
    } } } },
  })}</script>`
  const cover = { imageURL: { urlList: ['https://cdn/imagepostcover.jpg'] } }
  const rows = [
    ['images key RENAMED upstream', { images: [{ imgURL: { urlList: ['https://a/1.jpg'] } }], cover }, 'https://cdn/imagepostcover.jpg'],
    ['every image is http://, not https', { images: [{ imageURL: { urlList: ['http://a/1.jpg'] } }], cover }, 'https://cdn/imagepostcover.jpg'],
    ['images: [] (empty gallery)', { images: [], cover }, 'https://cdn/imagepostcover.jpg'],
    // imagePost.cover is preferred, but with no usable imagePost cover the video cover is the
    // last still standing — a slideshow carries one too.
    ['no usable imagePost cover either', { images: [] }, 'https://cdn/videocover.jpg'],
    ['imagePost is an empty object', {}, 'https://cdn/videocover.jpg'],
  ]
  for (const [label, imagePost, expected] of rows) {
    const post = normalizeTikTok(mk(imagePost), { p: 'tt', id: '1' })
    assert.equal(post.media.length, 1, `${label}: must degrade to one still, got ${post.media.length}`)
    assert.equal(post.media[0].kind, 'image', `${label}: a slideshow still is an image, never a video`)
    assert.equal(post.media[0].url, expected, label)
  }
})

test('the video/slideshow discriminator is a non-null imagePost, not a guess about media', () => {
  assert.ok(SLIDES.includes('imagePost'), 'fixture sanity: the slideshow carries imagePost')
  assert.ok(!VIDEO.includes('"imagePost"'), 'fixture sanity: the video post does not')
})

test('A DELETED POST IS NULL — HTTP 200 and a 287KB page prove nothing', () => {
  // Verified 2026-07-18: a deleted post returns HTTP 200 with a full page and a VALID blob
  // carrying statusCode 10204 / "item doesn't exist" and no itemStruct. Status is not evidence.
  assert.equal(normalizeTikTok(DELETED, { p: 'tt', id: '1' }), null)
  assert.ok(DELETED.includes('10204'), 'fixture sanity: this really is the deleted shape')
})

test('a nonzero statusCode is null even when an itemStruct is somehow present', () => {
  // Belt and braces: the assertion is on statusCode, not on "did we find something usable".
  const raw = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 10204, itemInfo: { itemStruct: {
      id: '1', desc: 'ghost', createTime: 1750000000, author: { uniqueId: 'u' }, stats: {}, video: {},
    } } } },
  })}</script>`
  assert.equal(normalizeTikTok(raw, { p: 'tt', id: '1' }), null)
})

test('counts map to the shared shape — and AT LEAST ONE really arrives', () => {
  // Every assertion in the first draft of this test sat behind `!== undefined`, so counts:{}
  // passed it with zero assertions executed. That is the silently-vacuous pattern Phase 2 only
  // caught by mutation testing, and it is the WORST test in this file to leave toothless:
  // TikTok's stats are genuinely mixed-typed (fact 9), so this is the assertion standing
  // between a string count and mastodon.ts's payload.
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  // The live payload always carries diggCount and playCount. Unconditional, so a normalizer
  // that dropped every count on the floor turns this red instead of green.
  assert.equal(typeof post.counts.likes, 'number', 'likes <- stats.diggCount must be present and numeric')
  assert.ok(Number.isFinite(post.counts.likes) && post.counts.likes > 0)
  assert.equal(typeof post.counts.views, 'number', 'views <- stats.playCount must be present and numeric')
  assert.ok(Number.isFinite(post.counts.views) && post.counts.views > 0)
  // The rest are optional in shape, but never the WRONG type when present.
  for (const k of ['likes', 'reposts', 'replies', 'views']) {
    if (post.counts[k] !== undefined) {
      assert.equal(typeof post.counts[k], 'number', `${k} must be a number, not the string TikTok may have sent`)
      assert.ok(Number.isFinite(post.counts[k]), `${k} must not be NaN`)
    }
  }
})

test('returns null on junk rather than throwing or inventing a Post', () => {
  for (const junk of [
    null, undefined, 42, '', '<html></html>',
    '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">not json</script>',
    '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{}</script>',
    // The ~7KB crawler decoy: HTTP 200, no blob at all.
    '<html><head><meta property="og:title" content="TikTok · Mystic Aquarium"></head></html>',
  ]) {
    assert.doesNotThrow(() => normalizeTikTok(junk, { p: 'tt', id: '1' }), String(junk).slice(0, 40))
    assert.equal(normalizeTikTok(junk, { p: 'tt', id: '1' }), null, String(junk).slice(0, 40))
  }
})

test('normalizeTikTok refuses a ref that is not a tt ref', () => {
  assert.equal(normalizeTikTok(VIDEO, { p: 'bs', handle: 'a', rkey: 'b' }), null)
})

// ── Task 4: the FETCHER's contract ───────────────────────────────────────────────────────────
// The fetcher does I/O, so what is testable offline is its contract: the UA it sends, its
// content assertion, and how it CLASSIFIES a body it does not like. All three are the things
// most likely to be edited wrongly later, and the classification is pure — no network, no
// stubbed globals.

test('THE UA IS NOT CRAWLER-SHAPED — TikTok is INVERTED from Instagram', () => {
  // Verified 2026-07-18: facebookexternalhit / Discordbot / Twitterbot all get HTTP 200 with
  // a ~7KB stub — no caption, no playAddr, og:title "TikTok · Mystic Aquarium". bingbot gets
  // 403. Instagram is the OPPOSITE: there the crawler UA works and Chrome gets a decoy. A
  // future reader WILL conflate the two, so this asserts the difference mechanically.
  const s = TIKTOK_UA.toLowerCase()
  for (const bad of ['bot', 'crawler', 'spider', 'preview', 'facebookexternalhit', 'discord']) {
    assert.ok(!s.includes(bad), `TIKTOK_UA must not look like a crawler (contains "${bad}")`)
  }
  assert.match(TIKTOK_UA, /Mozilla\/5\.0/)
})

test('the fetcher asserts on CONTENT, and the crawler decoy fails that assertion', () => {
  // The decoy is HTTP 200 with a valid content-type. Only the payload distinguishes it.
  assert.equal(hasRehydrationPayload(VIDEO), true)
  assert.equal(hasRehydrationPayload('<html><head><meta property="og:title" content="TikTok · Mystic Aquarium"><meta property="og:description" content="TikTok | Make Your Day"></head></html>'), false)
  assert.equal(hasRehydrationPayload(''), false)
  assert.equal(hasRehydrationPayload(null), false)
})

test('the DELETED page still passes the fetch-layer assertion — rejection is the normalizer\'s job', () => {
  // Deliberate division of labour: the fetcher only asks "did I get a real POST PAGE", because a
  // deleted post DOES return one. "Is there a post in it" is a statusCode question and stays with
  // the normalizer. The fetcher does now reach into the blob far enough to see the scope — it has
  // to, or the homepage passes (see below) — but it does it by CALLING the normalizer's extractor,
  // so there is still exactly one place that knows how to find the blob.
  assert.equal(hasRehydrationPayload(DELETED), true)
  assert.equal(normalizeTikTok(DELETED, { p: 'tt', id: '1' }), null)
})

test('A BLOCKED OR CHANGED PAGE IS assert_fail, NOT fetch_fail — and never throws', () => {
  // The whole point of the split. Today all three of these look identical to a wave of
  // genuinely deleted posts, which is how "TikTok renamed the blob" would go unnoticed for a
  // week. pageOutcome is PURE, so this needs no network and no stubbed global fetch.
  const cases = {
    '429': '<html><head><title>429 Too Many Requests</title></head><body>rate limited</body></html>',
    // The marker RENAMED — the single most likely way this phase dies. Note the rename must
    // not merely append: hasRehydrationPayload is a substring test, so '..._V2' with the old
    // name still inside it would (correctly) still match.
    renamed: VIDEO.replaceAll('__UNIVERSAL_DATA_FOR_REHYDRATION__', '__UNIVERSAL_DATA_2__'),
    interstitial: '<html><body>Access Denied</body></html>',
    empty: '',
    // The crawler decoy from fact 1: HTTP 200, plausible content-type, ~7KB, no payload.
    decoy: '<html><head><meta property="og:title" content="TikTok · Mystic Aquarium"></head></html>',
  }
  for (const [name, body] of Object.entries(cases)) {
    let got
    assert.doesNotThrow(() => { got = pageOutcome(body) }, name)
    assert.equal(got.ok, false, name)
    assert.equal(got.reason, 'assert_fail', name)
  }
  // Non-strings from a hostile or broken caller degrade the same way.
  for (const junk of [null, undefined, 42, {}]) {
    assert.equal(pageOutcome(junk).ok, false, String(junk))
    assert.equal(pageOutcome(junk).reason, 'assert_fail', String(junk))
  }
})

test('a real page is ok:true and carries the body through unmodified', () => {
  const got = pageOutcome(VIDEO)
  assert.equal(got.ok, true)
  assert.equal(got.html, VIDEO, 'the body must reach the normalizer byte-for-byte')
  // A deleted post is a REAL page. It is ok at this layer and null at the next one.
  assert.equal(pageOutcome(DELETED).ok, true, 'a deleted post is not an assertion failure')
})

test('THE HOMEPAGE CARRIES THE MARKER AND IS NOT A POST PAGE — scope, not marker, is the assertion', () => {
  // THE REGRESSION: asserting on the bare '__UNIVERSAL_DATA_FOR_REHYDRATION__' substring accepts
  // the TikTok homepage as "the page answered". Captured live 2026-07-19: HTTP 200, 354,893 bytes,
  // marker present once, webapp.video-detail ABSENT (scopes: app-context, biz-context,
  // i18n-translation, seo.abtest, a-b). That is what a geo-bounce, an edge interstitial or a
  // datacenter block looks like when TikTok answers with its generic shell instead of the post —
  // and marker-only classified it ok:true, so it landed in fetch_fail among the genuinely deleted
  // links, which is precisely the conflation the assert_fail split exists to eliminate.
  //
  // Plan fact 10 states it in terms ("the marker's mere presence proves nothing. The discriminator
  // is the webapp.video-detail scope"), and normalize.ts's statusCode comment repeats it. The fetch
  // layer must use the discriminator its sibling module names.
  assert.equal(hasRehydrationPayload(HOMEPAGE), true, 'the premise: the homepage DOES carry the blob')
  assert.equal(hasVideoDetailScope(HOMEPAGE), false, 'and it does NOT carry the post scope')
  assert.equal(pageOutcome(HOMEPAGE).ok, false, 'a homepage bounce is assert_fail, not a missing post')
  assert.equal(pageOutcome(HOMEPAGE).reason, 'assert_fail')
})

test('A TRUNCATED PAGE IS assert_fail — an unparseable blob means WE are broken, not that the post is gone', () => {
  // Same class as the homepage, reached differently: the marker survives a truncated response
  // while the JSON does not. A body we cannot parse is a body that failed to arrive, which is a
  // page failure; counting it as fetch_fail would file "the connection died mid-response" next to
  // "this post was deleted". Only reachable because the assertion parses rather than substring-matching.
  const truncated = VIDEO.slice(0, 60_000)
  assert.equal(hasRehydrationPayload(truncated), true, 'the marker survives truncation')
  assert.equal(pageOutcome(truncated).ok, false)
  assert.equal(pageOutcome(truncated).reason, 'assert_fail')
})

test('THE DELETED PAGE IS STILL ok:true — the scope assertion must not swallow the normalizer\'s job', () => {
  // The load-bearing counterweight to the two tests above. Tightening the fetch assertion from
  // "marker" to "scope" is only correct because a DELETED post carries the scope too — measured:
  // statusCode 10204, statusMsg "item doesn't exist", no itemStruct. If someone "tightens" this
  // further to require itemStruct or statusCode 0, every deleted link starts counting as
  // assert_fail and the split inverts: the counter that means "TikTok changed something" would be
  // dominated by TikTok working exactly as designed.
  assert.equal(hasVideoDetailScope(DELETED), true, 'a deleted post HAS the scope — statusCode is the normalizer\'s question')
  assert.equal(pageOutcome(DELETED).ok, true)
  assert.equal(normalizeTikTok(DELETED, { p: 'tt', id: '1' }), null, 'and the normalizer is what rejects it')
})

test('THE ROUTER MINTS AN UNVALIDATED PATH SEGMENT — including path traversal', () => {
  // This test exists to pin a FACT the fetcher's comment cites. router.ts's tiktok() requires only
  // that seg[2] be truthy — there is no digit check — and route() safeDecodes segments first, so
  // '..%2f..%2f' arrives as a literal '../../'. A public URL therefore reaches fetchTikTok with an
  // id that is not an id at all.
  //
  // If this ever fails because the router started validating ids, do NOT delete the fetcher's
  // encodeURIComponent — update its comment and keep the guard. Defence in depth is the point:
  // the whole reason this test exists is that the fetcher once claimed the router already
  // guaranteed digits, which invited exactly that deletion.
  assert.deepEqual(route(new URL('https://s.example/@user/video/..%2f..%2fevil')).ref, { p: 'tt', id: '../../evil' })
  assert.deepEqual(route(new URL('https://s.example/@user/video/foobar')).ref, { p: 'tt', id: 'foobar' })
})

test('THE FETCHER PINS ITS UPSTREAM URL — a traversal id cannot steer our egress off the post path', async () => {
  // Without encodeURIComponent, `https://www.tiktok.com/@i/video/${'../../evil'}` COLLAPSES to
  // https://www.tiktok.com/evil — an attacker-chosen path on tiktok.com, reachable from a public
  // URL by the test above. Nothing tested this before, so deleting the guard, or misspelling the
  // 'user-agent' header key into the crawler-decoy branch, left the whole suite green.
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response('<html>not the point</html>')
  }
  try {
    await fetchTikTok({ p: 'tt', id: '../../evil' })
    await fetchTikTok({ p: 'tt', id: '7660566211100511518' })
  } finally {
    globalThis.fetch = real
  }

  assert.equal(calls[0].url, 'https://www.tiktok.com/@i/video/..%2F..%2Fevil')
  const u = new URL(calls[0].url)
  assert.equal(u.host, 'www.tiktok.com')
  assert.match(u.pathname, /^\/@i\/video\//, 'the id must never escape the /@i/video/ prefix')
  // The ordinary case is unencoded and unchanged — the guard is not paid for by mangling real ids.
  assert.equal(calls[1].url, 'https://www.tiktok.com/@i/video/7660566211100511518')

  // Fact 1: a crawler UA gets a ~7KB decoy with no caption at HTTP 200. The header must be spelled
  // exactly, because a misspelled key sends no UA rather than failing loudly.
  assert.equal(calls[0].init.headers['user-agent'], TIKTOK_UA)
})

test('a body that fails the fetch assertion is classified, never thrown, at the I/O boundary too', async () => {
  // pageOutcome is tested pure above; this pins that fetchTikTok actually ROUTES its response
  // through it rather than returning ok:true on whatever came back.
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(HOMEPAGE)
  try {
    const got = await fetchTikTok({ p: 'tt', id: '7660566211100511518' })
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'assert_fail')
  } finally {
    globalThis.fetch = real
  }
})

// ---------------------------------------------------------------------------
// The /t/{code} SHORT-LINK path. Its classifier is deliberately NOT pageOutcome, and
// nothing pinned that until these tests: reverting `shortlinkOutcome` to `pageOutcome`
// — the plan's Task 6 sketch, and the obvious "simplify" edit — left all 294 tests green.
// ---------------------------------------------------------------------------

/**
 * A TRUNCATED page: the blob opens and never closes. Measured on the real capture — at 50%,
 * 90% and 99% the marker survives (it is in the first 60 bytes of the document) while the
 * blob's `</script>` does not, so a marker-only test calls a response that never arrived a
 * page that did.
 */
const TRUNCATED = VIDEO.slice(0, Math.floor(VIDEO.length * 0.9))

/**
 * Outcomes carry the whole 286KB body on the ok arm, so they are compared through this rather
 * than with deepEqual — an assertion failure otherwise prints a quarter of a megabyte of TikTok
 * A/B-test JSON and buries the one word that matters.
 */
const brief = o => (o.ok ? 'ok' : o.reason)

test('THE SHORT-LINK CLASSIFIER IS THREE-WAY, AND EACH ARM IS A DIFFERENT REAL BODY', () => {
  // ARM 1 — THE PAGE ARRIVED AND IS A POST. The ordinary success.
  assert.equal(shortlinkOutcome(VIDEO).ok, true)

  // ARM 2 — THE PAGE ARRIVED AND IS NOT A POST PAGE. This is the whole reason this function
  // exists instead of pageOutcome: every non-TikTok short code lands on the TikTok HOMEPAGE
  // (verified 2026-07-18 on a dead code AND on a real THREADS code), and a Threads link
  // somebody pasted is the resolver WORKING. Counting it assert_fail — which is exactly what
  // pageOutcome does, asserted below on the same bytes — would swamp the one counter that
  // means "TikTok changed and we are blind".
  assert.equal(shortlinkOutcome(HOMEPAGE).ok, true, 'a Threads code is not an assertion failure')
  assert.equal(brief(pageOutcome(HOMEPAGE)), 'assert_fail',
    'the POST path still counts it, and the two classifiers must not be merged')

  // A deleted post is arm 1 as far as the PAGE is concerned — the scope is there, statusCode
  // 10204 is the payload's own answer, and deciding that is one layer up.
  assert.equal(shortlinkOutcome(DELETED).ok, true)

  // ARM 3 — THE PAGE DID NOT ARRIVE. Two bodies, both assert_fail, and the second is the one
  // the marker-only test got wrong: fetch.ts's own comment rejects a substring test partly
  // because it "would also let a TRUNCATED response through", and the substring test was what
  // shipped here. A body we cannot parse is a response that failed to arrive, not a post that
  // is gone — so it must never degrade silently into "that code is not TikTok".
  assert.equal(brief(shortlinkOutcome('<html><head><title>429</title></head></html>')),
    'assert_fail', 'no marker at all')
  assert.equal(hasRehydrationPayload(TRUNCATED), true, 'the marker survives truncation — that is the trap')
  assert.equal(brief(shortlinkOutcome(TRUNCATED)), 'assert_fail',
    'a blob that does not close is a response that failed to arrive')

  // Total on junk, like every other classifier in this file.
  for (const junk of [null, undefined, 42, '', {}]) {
    assert.doesNotThrow(() => shortlinkOutcome(junk))
    assert.equal(shortlinkOutcome(junk).ok, false)
  }
})

test('THE RESOLVER PINS ITS UPSTREAM URL AND ITS UA — the sibling guards, on the sibling function', async () => {
  // fetchTikTok has had this test since it was written; resolveTikTokShortlink copied its two
  // load-bearing guards AND their comments but not its test, so both could be deleted with the
  // suite green (verified by mutation: 294/294 for each).
  //
  // The traversal half is not theoretical. router.ts requires only that the code segment be
  // TRUTHY and route() safeDecodes it first, so /t/..%2f..%2fevil — a public URL anyone can
  // paste — arrives here as '../../evil', and bare interpolation collapses
  // https://www.tiktok.com/t/../../evil to https://www.tiktok.com/evil: an attacker-chosen path
  // on tiktok.com, fetched with OUR egress.
  assert.equal(route(new URL('https://s.example/t/..%2f..%2fevil')).code, '../../evil')

  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response('<html>not the point</html>')
  }
  try {
    await resolveTikTokShortlink('../../evil')
    await resolveTikTokShortlink('ZTSw2mYwR')
  } finally {
    globalThis.fetch = real
  }

  assert.equal(calls[0].url, 'https://www.tiktok.com/t/..%2F..%2Fevil')
  assert.equal(new URL(calls[0].url).host, 'www.tiktok.com')
  assert.match(new URL(calls[0].url).pathname, /^\/t\//, 'the code must never escape the /t/ prefix')
  // The ordinary case is unencoded and unchanged — the guard is not paid for by mangling codes.
  assert.equal(calls[1].url, 'https://www.tiktok.com/t/ZTSw2mYwR')

  // Fact 1, and it is INVERTED from Instagram: a crawler UA gets a ~7KB decoy with no caption at
  // HTTP 200. The header key must be spelled exactly — a misspelled key sends no UA at all
  // rather than failing loudly, and the short-link path would then resolve against the decoy.
  assert.equal(calls[1].init.headers['user-agent'], TIKTOK_UA)
  assert.equal(calls[1].init.headers['user-agent'], calls[0].init.headers['user-agent'])
})

test('the resolver ROUTES its response through the short-link classifier, not the post one', async () => {
  // The I/O-boundary half: shortlinkOutcome is pure and tested above, but resolveTikTokShortlink
  // could still call pageOutcome. On the homepage — the body every non-TikTok code produces —
  // the two disagree, so this one body is enough to tell them apart through the fetch.
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(HOMEPAGE)
    assert.equal((await resolveTikTokShortlink('DTI1vjIEi5y')).ok, true)
    globalThis.fetch = async () => new Response(TRUNCATED)
    assert.equal(brief(await resolveTikTokShortlink('ZTSw2mYwR')), 'assert_fail')
  } finally {
    globalThis.fetch = real
  }
})

// ---------------------------------------------------------------------------
// THE AWEME RESOLVER — the hop-count fix.
//
// Discord renders the OpenGraph card instead of the Mastodon activity card when there are TWO
// HTTP redirects between it and the bytes. Measured 2026-07-19 with `curl -sSL -w '%{num_redirects}'`,
// and the correlation is perfect across four samples:
//
//   our slideshow image  1 redirect  -> activity card   (works)
//   Bluesky image        1 redirect  -> activity card   (works)
//   PRODUCTION fxtiktok  1 redirect  -> activity card   (works)
//   our video            2 redirects -> OpenGraph card  (FAILS)
//
// Our second hop is the aweme endpoint's own 302 to the CDN. Production's offload service
// resolves it server-side and hands out the final URL, which is why its chain is one hop.
// These tests own the resolution itself; pipeline.test.mjs owns the hop count end to end.
// ---------------------------------------------------------------------------

/** The measured shape of the aweme 302's target (2026-07-19 residential control arm). */
const CDN = 'https://v16m-default.tiktokcdn-us.com/abc123/def/video.mp4?a=1234&br=900'
const AWEME = normalizeTikTok(VIDEO, VIDEO_REF).media[0].url

/** Stubs the network, returns what the calls looked like alongside the resolver's answer. */
async function resolving(responder, fn) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }
  try {
    return { out: await fn(), calls }
  } finally {
    globalThis.fetch = real
  }
}

const redirectTo = loc => async () => new Response(null, { status: 302, headers: { location: loc } })

test('THE RESOLVER RETURNS THE CDN TARGET, AND NEVER DOWNLOADS THE VIDEO', async () => {
  const { out, calls } = await resolving(redirectTo(CDN), () => resolveAwemeUrl(AWEME))
  assert.equal(out, CDN, 'the Location header IS the answer')

  // The request itself. The URL must be the aweme url UNCHANGED — its signaturev3 and tk
  // parameters are what make the cookie-free branch work, and a rebuilt URL silently drops them.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, AWEME)
  // MANUAL, so `fetch` hands us the 302 instead of following it and streaming 14MB of MP4
  // through our Worker. This is the single line that separates "read a header" from "proxy the
  // bytes", which is a thing this project has never done and must not start doing by accident.
  assert.equal(calls[0].init.redirect, 'manual')
  // The same UA the page fetch sends. TikTok's gate is INVERTED from Instagram's (see TIKTOK_UA):
  // a crawler UA gets a decoy, so a resolver that sent one — or sent none, and inherited whatever
  // the runtime adds — would be measuring a different endpoint than the one we hand out.
  assert.equal(calls[0].init.headers['user-agent'], TIKTOK_UA)
})

test('THE RESOLVER ASSERTS ON CONTENT — a 200 interstitial resolves to NOTHING, not to itself', async () => {
  // THE MEASURED WORKERS-EGRESS BRANCH, and the reason this whole function must degrade rather
  // than trust. docs/research/2026-07-18-tiktok-workers-egress-probe.md: from a real Cloudflare
  // isolate the aweme URL answered `HTTP 200`, `content-type: text/html`, final host
  // `www.tiktok.com`, NO redirect at all — while the residential control arm minutes later got
  // 14,548,779 bytes of MP4 off `v16m-default.tiktokcdn-us.com`. Status proves nothing in either
  // direction; both arms were 200.
  const interstitial = async () =>
    new Response('<!doctype html><html><head><title>TikTok</title></head></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const { out } = await resolving(interstitial, () => resolveAwemeUrl(AWEME))
  assert.equal(out, null, 'no Location means nothing was resolved — never "the page we got"')
})

test('THE RESOLVER REFUSES A REDIRECT THAT IS NOT A CDN — a login page is worse than two hops', async () => {
  // The failure this guard exists for: og:video pointing at an HTML page renders a DEAD player
  // AND suppresses og:image (normalize.ts's I-1 lesson), so the post shows NOTHING. Two hops
  // renders a worse card; a bad first hop renders no card at all. Refusing degrades to two hops.
  for (const bad of [
    'https://www.tiktok.com/login?redirect_url=x',          // the gate, one hop further along
    'https://www.tiktok.com/aweme/v1/play/?video_id=v',      // another aweme url: still two hops
    'http://v16m-default.tiktokcdn-us.com/x.mp4',            // http: mixed content we would author
    'https://eviltiktokcdn.com/x.mp4',                       // suffix-glued, not a subdomain
    'https://v16m.tiktokcdn-us.com.evil.example/x.mp4',      // the CDN name as a LABEL, not the tail
    '/relative/path.mp4',                                    // legal HTTP, resolves back to tiktok.com
    'not a url at all',
    '',
  ]) {
    const { out } = await resolving(redirectTo(bad), () => resolveAwemeUrl(AWEME))
    assert.equal(out, null, `must refuse ${JSON.stringify(bad)}`)
  }

  // And the positive control on the same assertion, so "refuses everything" cannot pass this test.
  for (const good of [
    'https://v16m-default.tiktokcdn-us.com/x.mp4?a=1',
    'https://v19-webapp.tiktokcdn.com/x.mp4',
    'https://v16m-default.tiktokcdn-eu.com/x.mp4',
  ]) {
    const { out } = await resolving(redirectTo(good), () => resolveAwemeUrl(AWEME))
    assert.equal(out, good, `must accept ${good}`)
  }
})

test('A RESOLVER THAT CANNOT REACH THE NETWORK RETURNS NULL, NEVER THROWS', async () => {
  // worker.ts's media branch has no try/catch and liveFetchPost's tt arm has none either. A
  // rejected fetch here — DNS, timeout, connection reset — must not turn a working two-hop embed
  // into an uncaught 500.
  const boom = async () => { throw new Error('ECONNRESET') }
  const { out } = await resolving(boom, async () => {
    let r
    await assert.doesNotReject(async () => { r = await resolveAwemeUrl(AWEME) })
    return r
  })
  assert.equal(out, null)
})

test('withResolvedVideo REWRITES THE VIDEO URL AND TOUCHES NOTHING ELSE', async () => {
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  const { out, calls } = await resolving(redirectTo(CDN), () => withResolvedVideo(post))

  assert.equal(calls.length, 1, 'exactly one upstream request per post')
  assert.equal(out.media[0].url, CDN)
  // Everything else about the Post is byte-identical. A resolver that rebuilt the Media entry
  // would silently drop `duration`, which the renderer emits as og:video:duration.
  assert.deepEqual(
    { ...out, media: out.media.map(m => ({ ...m, url: null })) },
    { ...post, media: post.media.map(m => ({ ...m, url: null })) },
    'only media[].url may change',
  )
  assert.equal(out.media[0].duration, 67)
})

test('A SLIDESHOW COSTS NO RESOLUTION — there is no aweme url to resolve', async () => {
  // The MUST-NOT-BREAK case. A photo post's media are images on p16-/p19- hosts and already
  // reach Discord in ONE hop, which is why slideshows render the activity card today. Fetching
  // anything here would be pure amplification on the platform we rate most fragile.
  const post = normalizeTikTok(SLIDES, SLIDES_REF)
  const { out, calls } = await resolving(redirectTo(CDN), () => withResolvedVideo(post))
  assert.equal(calls.length, 0, 'a slideshow must not touch the network')
  assert.deepEqual(out, post, 'and must come back untouched')
})

test('A FAILED RESOLUTION DEGRADES TO THE AWEME URL — two hops, never zero video', async () => {
  // The degrade rule, stated at the type level: this function returns a Post, never null. Two
  // hops renders the OpenGraph card, which is the bug we are fixing; NO video renders nothing at
  // all, which is strictly worse. Every failure mode lands on the former.
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  for (const responder of [
    async () => new Response('<html>interstitial</html>', { status: 200 }),
    async () => { throw new Error('ECONNRESET') },
    redirectTo('https://www.tiktok.com/login'),
  ]) {
    let out
    const r = await resolving(responder, async () => {
      await assert.doesNotReject(async () => { out = await withResolvedVideo(post) })
      return out
    })
    assert.deepEqual(r.out, post, 'the post is handed back exactly as the normalizer built it')
    assert.ok(r.out.media[0].url.includes('/aweme/v1/play/'), 'still a playable url, not nothing')
  }
})

// ---------------------------------------------------------------------------
// THE VIDEO'S POSTER FRAME, captured 2026-07-19.
//
// Mastodon's preview_url on a video attachment is the POSTER, not the video — and the mapper had
// no poster to emit, so it emitted the video url and Discord fell back to the plain OpenGraph
// card. The cover was sitting in the payload the whole time.
//
// VERIFIED LIVE on post 7662750461509782814 before this was built: `video.cover` fetches with NO
// COOKIES and NO UA — the shape of Discord's media proxy request — and answers 200, image/jpeg,
// 183,137 bytes, magic bytes ff d8 ff (JPEG). Same for `originCover` (48,770 bytes, JPEG).
// ---------------------------------------------------------------------------

test('A VIDEO POST CAPTURES ITS COVER AS THE MEDIA POSTER', () => {
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  const v = post.media[0]
  assert.equal(v.kind, 'video', 'fixture sanity: this capture must yield a video entry')
  assert.equal(typeof v.poster, 'string')
  assert.match(v.poster, /^https:\/\//, 'the poster rides the same https-only guard as every url')
  // It must be the COVER, not the video: pointing the poster at the mp4 is the defect itself.
  assert.notEqual(v.poster, v.url)
  assert.ok(!v.poster.includes('/aweme/v1/play/'), 'the poster must never be the video url')
  // Pinned to the capture's actual cover field, so a normalizer that invented a plausible-looking
  // url from somewhere else fails here.
  const cover = videoDetailScope(VIDEO).itemInfo.itemStruct.video.cover
  assert.equal(v.poster, cover)
})

test('the poster falls back to originCover, and is ABSENT when neither cover is usable', () => {
  // Same precedence as the no-aweme degradation path directly below it in the normalizer:
  // cover, then originCover. dynamicCover is deliberately not in the chain (it is the animated
  // one). Absent rather than empty, so a Post is structurally the same whether the cover was
  // missing upstream or merely unusable — mediaObj's rule, applied to the new field.
  const scope = () => JSON.parse(JSON.stringify(videoDetailScope(VIDEO)))

  const noCover = scope()
  noCover.itemInfo.itemStruct.video.cover = ''
  assert.equal(
    normalizeTikTok(wrap(noCover), VIDEO_REF).media[0].poster,
    videoDetailScope(VIDEO).itemInfo.itemStruct.video.originCover,
    'with no cover the poster must fall back to originCover',
  )

  const neither = scope()
  neither.itemInfo.itemStruct.video.cover = ''
  neither.itemInfo.itemStruct.video.originCover = ''
  const m = normalizeTikTok(wrap(neither), VIDEO_REF).media[0]
  assert.equal(m.kind, 'video', 'a coverless video is still a video, not a degraded still')
  assert.ok(!('poster' in m), 'the key must be ABSENT, never undefined or empty')

  // A non-https cover is refused like every other url, and refusal means absent, not passed through.
  const insecure = scope()
  insecure.itemInfo.itemStruct.video.cover = 'http://p16-common-sign.tiktokcdn-us.com/c.jpg'
  insecure.itemInfo.itemStruct.video.originCover = 'http://p16-common-sign.tiktokcdn-us.com/o.jpg'
  assert.ok(!('poster' in normalizeTikTok(wrap(insecure), VIDEO_REF).media[0]), 'an http cover must be refused')
})

test('A SLIDESHOW IMAGE NEVER GAINS A POSTER — an image is its own poster', () => {
  // The working case, pinned at the normalizer as well as at the renderer: our slideshows already
  // draw Discord's rich card, and the whole risk of this change is regressing them.
  const post = normalizeTikTok(SLIDES, SLIDES_REF)
  assert.ok(post.media.length > 1, 'fixture sanity')
  for (const m of post.media) {
    assert.equal(m.kind, 'image')
    assert.ok(!('poster' in m), 'no image entry may carry a poster')
  }
  // Nor does the still that a video post degrades to when it has no playable url. The strip uses
  // the SLASH-SPELLING-AWARE pattern the degradation test above documents at length — the fixture
  // spells its slashes as JSON escapes, and a naive '/aweme/v1/play/' replace matches zero of
  // them and leaves this test green and vacuous.
  const SLASH = String.raw`(?:/|\\/|\\u002[Ff])`
  const awemeRx = new RegExp(`https:${SLASH}${SLASH}www\\.tiktok\\.com${SLASH}aweme${SLASH}v1${SLASH}play${SLASH}[^"]*`, 'g')
  const noAweme = VIDEO.replace(awemeRx, 'https://v16-webapp-prime.tiktok.com/gated.mp4')
  assert.ok(!new RegExp(awemeRx.source).test(noAweme), 'fixture sanity: the strip must remove every aweme url')
  const degraded = normalizeTikTok(noAweme, VIDEO_REF).media[0]
  assert.equal(degraded.kind, 'image', 'fixture sanity: the aweme strip must force the degrade')
  assert.ok(!('poster' in degraded), 'the degraded still is already the cover; a poster would duplicate it')
})

test('`..` AND `.` ESCAPE THE PINNED PATH TOO — encodeURIComponent does not encode a dot', async () => {
  // THE SIBLING OF THE INSTAGRAM FIX, and the same one-character oversight. Both TikTok URL tests
  // above sample a single hostile input, '../../evil', which is exactly the case
  // encodeURIComponent HANDLES (it escapes `/`). It does not escape `.`, so the two shortest
  // traversal segments there are walk straight out of the pinned prefix during URL parsing:
  //
  //   fetchTikTok '..'            -> https://www.tiktok.com/@i/video/..  => wire path /@i/
  //   fetchTikTok '.'             -> https://www.tiktok.com/@i/video/.   => wire path /@i/video/
  //   resolveTikTokShortlink '..' -> https://www.tiktok.com/t/..         => wire path /
  //
  // `.` and `..` are the COMPLETE escape set once encodeURIComponent has run: `/` is escaped and
  // `%` becomes `%25`, so no other segment can normalise away. Guarding those two therefore makes
  // the prefix invariant true rather than merely usually-true.
  const hostile = ['..', '.', '../..', './.']
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response('<html>not the point</html>')
  }
  try {
    for (const id of hostile) await fetchTikTok({ p: 'tt', id })
    for (const code of hostile) await resolveTikTokShortlink(code)
    // The legitimate shapes must be untouched by the guard — a real 19-digit id and a real short
    // code, both of which appear in the tests above.
    await fetchTikTok({ p: 'tt', id: '7660566211100511518' })
    await resolveTikTokShortlink('ZTSw2mYwR')
  } finally {
    globalThis.fetch = real
  }
  // `u.pathname` is the NORMALISED path — the one the wire carries — so a segment that collapsed
  // during parsing is visible here even though the template string looked pinned.
  for (const { url } of calls) {
    const u = new URL(url)
    assert.equal(u.host, 'www.tiktok.com', url)
    assert.match(u.pathname, /^\/(@i\/video|t)\/[^/]+$/, `${url} escaped its pinned prefix`)
  }
  // Only `.` and `..` are refused before the fetch, because only they can dissolve the path. The
  // others ('../..', './.') ARE fetched, and that is correct rather than an oversight: encoded,
  // they stay inside the prefix and 404, which is the right answer for a segment that is not an
  // id. The guard buys the invariant, not a shape check — see `pinnable`'s comment for why TikTok
  // deliberately does not get Instagram's stricter `/^[A-Za-z0-9_-]{1,64}$/`.
  assert.equal(calls.length, 6, 'the 2 traversing segments cost no request; the 4 safely-pinned ones still go')
  assert.equal(calls[0].url, 'https://www.tiktok.com/@i/video/..%2F..')
  assert.equal(calls[4].url, 'https://www.tiktok.com/@i/video/7660566211100511518')
  assert.equal(calls[5].url, 'https://www.tiktok.com/t/ZTSw2mYwR')
})

// ── gated-post scheme: TikTok age (🔞) + private (🔒) detection. PARSER-CONFIRMED (yt-dlp / tt-bot /
// gallery-dl read the SAME webapp.video-detail scope we parse), EGRESS-UNCONFIRMED and SELF-CORRECTING
// (the branch simply does not fire if the signal never arrives). It MUST be no-regression: a false
// positive on a NORMAL post is impossible because it gates ONLY on the specific status codes / the
// isContentClassified field. `tiktokGate` returns the analytics/FetchReport vocabulary
// ('age_restricted' | 'private'), mapped to render's 'age' | 'private' at the post route.

// A content-classified item whose video is WITHHELD (no playAddr / bitrate url) — the age tell.
const AGE_SCOPE = { statusCode: 0, itemInfo: { itemStruct: {
  id: '7660566211100511518', createTime: '1700000000', desc: 'x', author: { uniqueId: 'u' },
  isContentClassified: true, video: {} } } }
// A content-classified item that DOES have a playable video — must DEGRADE to rendering, not a gate.
const CLASSIFIED_WITH_VIDEO = { statusCode: 0, itemInfo: { itemStruct: {
  id: '7660566211100511518', createTime: '1700000000', desc: 'still a post', author: { uniqueId: 'u' },
  isContentClassified: true, video: {
    playAddr: 'https://v16.tiktokcdn-us.com/aweme/v1/play/?video_id=x', width: 720, height: 1280,
    cover: 'https://p.tiktokcdn.com/c.jpg', duration: 5 } } } }

test('gated-post scheme: tiktokGate keys ONLY on the specific codes / isContentClassified', () => {
  assert.equal(tiktokGate(wrap(AGE_SCOPE)), 'age_restricted', 'isContentClassified + no video -> age')
  // number OR string status (this payload is untrustworthy per-key about number-vs-string).
  assert.equal(tiktokGate(wrap({ statusCode: 10216 })), 'private', '10216 private post')
  assert.equal(tiktokGate(wrap({ statusCode: '10216' })), 'private')
  assert.equal(tiktokGate(wrap({ statusCode: 10222 })), 'private', '10222 private account')
  assert.equal(tiktokGate(wrap({ statusCode: '10222' })), 'private')
  // FRIENDS-ONLY: statusCode 10204 is SHARED with a deleted post; the statusMsg is the discriminator.
  // Captured live 2026-07-21 — the whole video-detail scope is {statusCode:10204, statusMsg:'status_friend_see'}.
  assert.equal(tiktokGate(wrap({ statusCode: 10204, statusMsg: 'status_friend_see' })), 'private',
    'friends-only (10204 / status_friend_see) is private, not gone')
  // FALSE-POSITIVE GUARDS — none of these is a gate:
  assert.equal(tiktokGate(wrap({ statusCode: 10204, statusMsg: "item doesn't exist" })), undefined,
    'a deleted post (10204 / "item doesn\'t exist") is NOT a gate, even though it shares the code with friends-only')
  assert.equal(tiktokGate(wrap({ statusCode: 10204 })), undefined, 'a deleted post (10204) is NOT a gate')
  assert.equal(tiktokGate(DELETED), undefined, 'the REAL deleted capture is NOT a gate')
  assert.equal(tiktokGate(VIDEO), undefined, 'a NORMAL video post is never gated')
  assert.equal(tiktokGate(SLIDES), undefined, 'a NORMAL slideshow is never gated')
  assert.equal(tiktokGate(HOMEPAGE), undefined, 'the homepage (no video-detail scope) is never gated')
  assert.equal(tiktokGate(CLASSIFIED_WITH_VIDEO), undefined, 'a playable video wins over the age tell')
  // The egress-safety case: the age signal ABSENT -> undefined, fall through to generic.
  const noSignal = { statusCode: 0, itemInfo: { itemStruct: {
    id: '7', createTime: '1700000000', desc: 'x', author: { uniqueId: 'u' }, video: {} } } }
  assert.equal(tiktokGate(wrap(noSignal)), undefined, 'no isContentClassified -> not a gate')
})

test('gated-post scheme: tiktokGate mutation guards — a widened condition would flip these', () => {
  // isContentClassified must be === true, not merely truthy/present: a false or absent value is not
  // a gate. A widen to `!= 0` on statusCode, or to `'isContentClassified' in item`, breaks these.
  for (const v of [false, 0, undefined, 'true', 1, null]) {
    const s = { statusCode: 0, itemInfo: { itemStruct: {
      id: '7', createTime: '1700000000', desc: 'x', author: { uniqueId: 'u' }, isContentClassified: v, video: {} } } }
    assert.equal(tiktokGate(wrap(s)), undefined, `isContentClassified=${JSON.stringify(v)} is NOT the age tell`)
  }
  // A private-adjacent-but-wrong status must NOT be misread as private.
  for (const s of [10215, 10217, 10221, 10223, 100002, 1])
    assert.equal(tiktokGate(wrap({ statusCode: s })), undefined, `statusCode ${s} is not a private code`)
})

test('gated-post scheme: normalizeTikTok REFUSES a media-less age-gated item (builds no Post)', () => {
  // statusCode is 0 here, so without this refusal the normal build path would emit a media-less (or
  // cover-only) Post. It must return null so liveFetchPost reports the 'age' gate instead.
  assert.equal(normalizeTikTok(wrap(AGE_SCOPE), VIDEO_REF), null, 'no media-less Post for an age wall')
  // But a content-classified post WITH a playable video still normalizes (degrade-safe, no false gate).
  const post = normalizeTikTok(wrap(CLASSIFIED_WITH_VIDEO), VIDEO_REF)
  assert.ok(post, 'a content-classified post that still has a video renders')
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'video')
})
