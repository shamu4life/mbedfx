import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  instagramCopyrightBlocked, normalizeInstagram, recoveredMediaFrom, withRecoveredVideo,
} from '../src/platforms/instagram/normalize.ts'

/**
 * THE COPYRIGHT-BLOCKED REEL, and the reason this whole seam exists.
 *
 * Reported from a live embed 2026-07-26: instagram.com/reel/DbN6SsKum-9/ is a video that rendered
 * as a PHOTO. It was not our bug and it was not a takedown — Instagram's `/embed/captioned/`
 * serializer applies a rights gate and omits `video_url` ENTIRELY, while still returning caption,
 * author, dimensions, display_url and `is_video: true`. Measured across four reels from one
 * account, the correlation is exact:
 *
 *   copyright_blocked: false  ->  video_url present   (DZc6RL8sHtz, DbOwAfWp0YT)
 *   copyright_blocked: true   ->  video_url ABSENT    (DbN6SsKum-9, Da2xdeSuhtt)
 *
 * WHAT ACTUALLY DRIVES THE FLAG is the audio's rightsholder, not "licensed vs original" — a
 * hypothesis that looked clean on four samples and DIED on twelve. From one account's feed:
 * Wonderwall (Oasis) and Thomas Theme (Mattel) are blocked; Cartoon Cat (Ozpi), Padroeiro do Ceara
 * (Tiririca) and Hot Dog (Little Apple Band) are NOT, and original audio never is. Major-label
 * catalog is withheld from embedders; indie catalog is not. Written down because the tempting
 * shortcut — "has music_info => blocked" — is measurably wrong and would mis-fire the recovery on
 * the majority of posts that carry licensed audio and are perfectly fine.
 *
 * THE GATE IS ON THE SERIALIZER, NOT THE MEDIA. The embed returns Instagram's Polaris WEB
 * `shortcode_media` type, which HAS a `copyright_blocked` field. The v1 shape returned by the user
 * feed has no such field anywhere on it — verified over the real item's key set — so there is
 * nothing to enforce and `video_versions[]` is served intact. That is the entire recovery.
 */
const BLOCKED = readFileSync(new URL('./fixtures/instagram-copyright-blocked.html', import.meta.url), 'utf8')
const REEL = readFileSync(new URL('./fixtures/instagram-reel.html', import.meta.url), 'utf8')
const FEED = readFileSync(new URL('./fixtures/instagram-user-feed.json', import.meta.url), 'utf8')

const REF = { p: 'ig', kind: 'p', code: 'DbN6SsKum-9' }

test('instagramCopyrightBlocked: TRUE on the blocked reel, FALSE on a healthy one', () => {
  assert.equal(instagramCopyrightBlocked(BLOCKED), true, 'DbN6SsKum-9 is the reported post')
  assert.equal(instagramCopyrightBlocked(REEL), false, 'the healthy reel fixture carries :false')
})

test('instagramCopyrightBlocked is TOTAL over junk — never throws, never true by accident', () => {
  for (const bad of [null, undefined, 42, {}, [], '', 'copyright_blocked', '<html></html>']) {
    assert.equal(instagramCopyrightBlocked(bad), false, `${JSON.stringify(bad)} is not a blocked payload`)
  }
  // The FALSE spelling must not match the TRUE one. This is the mutation that matters: a regex
  // that merely looks for the key name would fire on every healthy post and spend a 500KB feed
  // fetch on all of them.
  assert.equal(instagramCopyrightBlocked('\\"copyright_blocked\\":false'), false)
  assert.equal(instagramCopyrightBlocked('\\"copyright_blocked\\":true'), true)
})

test('THE BLOCKED REEL NORMALIZES TO A STILL — the behaviour the recovery is layered onto', () => {
  const post = normalizeInstagram(BLOCKED, REF)
  assert.equal(post.author.name, 'fixture_user_10')
  assert.equal(post.media.length, 1)
  // A video we cannot play degrades to its cover, never to a dead player. That is correct and
  // stays correct — the recovery below UPGRADES this, and must never be a precondition for it.
  assert.equal(post.media[0].kind, 'image', 'without recovery it is honestly a still')
})

test('recoveredMediaFrom: the v1 feed yields a real playable rendition for the blocked code', () => {
  const got = recoveredMediaFrom(FEED, 'DbN6SsKum-9')
  assert.ok(got, 'the blocked shortcode is present in the feed capture')
  assert.equal(got.length, 1, 'a single-video post is one entry')
  assert.match(got[0].url, /^https:\/\/[^/]*cdninstagram\.com\//, 'a direct CDN url, proxyable by mediaproxy')
  assert.equal(got[0].w, 720)
  assert.equal(got[0].h, 1280)
})

test('recoveredMediaFrom is TOTAL and SHORTCODE-SCOPED — it never returns another post\'s video', () => {
  // The feed is USER-scoped, not media-scoped: it answers with a page of the account's posts and
  // we pick ours out of it. Returning items[0] blindly would serve a DIFFERENT REEL's video under
  // this post's card — silently, and only for rights-struck posts, which is the least-watched path
  // there is. The fixture keeps a second real post precisely so this is a live assertion.
  const other = recoveredMediaFrom(FEED, 'DbQa5yKO3ie')
  const ours = recoveredMediaFrom(FEED, 'DbN6SsKum-9')
  assert.notEqual(other?.[0]?.url, ours?.[0]?.url, 'two distinct posts must not share a recovered url')

  assert.equal(recoveredMediaFrom(FEED, 'NotInThisFeed'), null, 'a code outside the window is null')
  for (const bad of [null, undefined, 42, '', '{}', '[]', 'not json', '{"items":null}', '{"items":[{}]}']) {
    assert.equal(recoveredMediaFrom(bad, 'DbN6SsKum-9'), null, `${JSON.stringify(bad)} recovers nothing`)
  }
})

test('withRecoveredVideo: UPGRADES the still to a video and keeps it as the poster', () => {
  const post = normalizeInstagram(BLOCKED, REF)
  const still = post.media[0].url
  const out = withRecoveredVideo(post, recoveredMediaFrom(FEED, 'DbN6SsKum-9'))

  assert.equal(out.media[0].kind, 'video', 'the whole point')
  assert.match(out.media[0].url, /cdninstagram\.com/)
  /**
   * A posterless video drops Discord's rich card to plain OG (types.ts, Media.poster), so a poster
   * MUST be present — that is the load-bearing assertion.
   *
   * It is no longer asserted to be the EMBED's display_url. Once the recovery generalised to
   * carousels, the feed item supplies its own cover from the same `image_versions2` ladder the video
   * came from, and that is the better source: it is aspect-SELECTED, whereas the other candidate for
   * this slot — the full-page path's og:image — is the SQUARE CROP that caused the reported
   * "cropped first image" bug. Pinning exact equality with the embed still would lock in the worse
   * of the two for the path that needs it most.
   */
  assert.ok(out.media[0].poster, 'a poster is present')
  assert.match(out.media[0].poster, /cdninstagram\.com/, 'and it is a real CDN cover')
  assert.ok(still, 'the pre-recovery still existed (the thing being upgraded)')
  assert.equal(out.media[0].w, 720)
  assert.equal(out.media[0].h, 1280)
})

test('withRecoveredVideo is TOTAL and NON-DESTRUCTIVE — junk returns the same object reference', () => {
  const post = normalizeInstagram(BLOCKED, REF)
  for (const bad of [null, undefined, {}, { url: '' }, { url: 'http://x/y.mp4' }, 42, 'nope']) {
    assert.equal(withRecoveredVideo(post, bad), post, `${JSON.stringify(bad)} must not clone the post`)
  }
  assert.equal(post.media[0].kind, 'image', 'the input is not mutated')
  assert.equal(withRecoveredVideo(null, recoveredMediaFrom(FEED, 'DbN6SsKum-9')), null, 'no post, no crash')
})

test('withRecoveredVideo REFUSES a non-https or off-CDN url — it feeds a byte proxy', () => {
  /**
   * mediaproxy.ts host-allowlists cdninstagram.com / fbcdn.net and re-checks the FINAL url after
   * redirects, so a foreign host here cannot exfiltrate. This is the SECOND layer, kept because the
   * value comes from a DIFFERENT upstream surface than the one the rest of this file parses, and a
   * url is the one field of it we hand to fetch().
   */
  const post = normalizeInstagram(BLOCKED, REF)
  for (const url of ['http://scontent.cdninstagram.com/v.mp4', 'https://evil.example/v.mp4', 'javascript:alert(1)']) {
    assert.equal(withRecoveredVideo(post, { url, w: 720, h: 1280 }), post, `${url} is refused`)
  }
})

test('A HEALTHY POST NEVER PAYS FOR THIS — the gate is what keeps the feed fetch off the hot path', () => {
  // The recovery costs a ~500KB user-feed request. instagramCopyrightBlocked being false on every
  // healthy post is the ONLY thing standing between that and every Instagram unfurl we serve.
  assert.equal(instagramCopyrightBlocked(REEL), false)
  const healthy = normalizeInstagram(REEL, { p: 'ig', kind: 'p', code: 'C79gQqLpkul' })
  assert.equal(healthy.media[0].kind, 'video', 'the happy path already has its video, unchanged')
})

test('A CAROUSEL RECOVERS EVERY SLIDE — the 12-image gallery that rendered as one', () => {
  /**
   * Reported 2026-07-27 with screenshots on /p/DbRYdu1Dx62/: a TWELVE-image carousel rendered as ONE
   * image, and that image was visibly CROPPED — the card showed a zoomed detail of a sign where the
   * post's own first slide shows the whole building.
   *
   * BOTH SYMPTOMS, ONE CAUSE. The embed answered with the ~81KB shell, so the post fell to
   * instagramFullPageCard, which emits exactly one image: Instagram's og:image. And og:image is a
   * SQUARE crop — the feed item's candidate ladder shows the two groups plainly (3024x4032, 1080x1440,
   * 720x960 … then 1080x1080, 750x750, 640x640 …), and og:image is drawn from the second.
   */
  const feed = readFileSync(new URL('./fixtures/instagram-feed-carousel.json', import.meta.url), 'utf8')
  const media = recoveredMediaFrom(feed, 'DbRYdu1Dx62')
  assert.equal(media.length, 12, 'every slide, not a cover — and not truncated by our own cap')
  assert.equal(new Set(media.map(m => m.url)).size, 12, 'twelve distinct pictures')
})

test('THE RECOVERED SIZE IS ASPECT-CORRECT, NOT THE SQUARE CROP', () => {
  // This is the half of the bug a gallery count alone would not catch: getting twelve pictures that
  // are all cropped would still be wrong. 1080x1440 is 3:4, matching the 3024x4032 original; the
  // square candidates on the same ladder are the ones og:image was serving.
  const feed = readFileSync(new URL('./fixtures/instagram-feed-carousel.json', import.meta.url), 'utf8')
  for (const m of recoveredMediaFrom(feed, 'DbRYdu1Dx62')) {
    assert.notEqual(m.w, m.h, 'a square rendition is the crop, never the picture')
    assert.equal(Math.round((m.w / m.h) * 100), 75, '3:4, the original aspect')
    assert.ok(Math.max(m.w, m.h) <= 1440, 'and bounded, because Discord postage-stamps an oversized image')
  }
})

test('recoveredMediaFrom still handles a SINGLE VIDEO, with its poster', () => {
  // The carousel generalisation must not regress the case it grew out of.
  const media = recoveredMediaFrom(FEED, 'DbN6SsKum-9')
  assert.equal(media.length, 1)
  assert.equal(media[0].kind, 'video')
  assert.ok(media[0].poster, 'a posterless video drops Discord to plain OpenGraph')
})

test('recoveredMediaFrom is TOTAL over junk', () => {
  for (const bad of [null, undefined, 42, '', '{}', '[]', 'not json', '{"items":null}', '{"items":[{}]}']) {
    assert.equal(recoveredMediaFrom(bad, 'DbN6SsKum-9'), null, `${JSON.stringify(bad)} recovers nothing`)
  }
  assert.equal(recoveredMediaFrom(FEED, 'NotInThisFeed'), null, 'a code outside the window is null')
})
