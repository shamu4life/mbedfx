import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hasEmbedPost, instagramPrivateGate, normalizeInstagram, shortcodeMedia } from '../src/platforms/instagram/normalize.ts'
import { INSTAGRAM_UA, fetchInstagram, hasEmbedPayload, pageOutcome } from '../src/platforms/instagram/fetch.ts'
import { TIKTOK_UA } from '../src/platforms/tiktok/fetch.ts'

const html = f => readFileSync(`test/fixtures/instagram-${f}.html`, 'utf8')
const SINGLE = html('single')
const CAROUSEL = html('carousel')
const REEL = html('reel')
const DECOY = html('decoy')
const GONE = html('gone')

// All three live fixtures are @nasajpl, captured 2026-07-19 with facebookexternalhit/1.1.
const SINGLE_REF = { p: 'ig', kind: 'p', code: 'C79gQqLpkul' }
const CAROUSEL_REF = { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' }
const REEL_REF = { p: 'ig', kind: 'p', code: 'Da5ynsiuAZ_' }

/**
 * A synthetic `shortcode_media`, wrapped in THE SAME DOUBLE ENCODING THE WIRE USES.
 *
 * Transcribed from the live capture, the blob is not a bare JSON object in the document — it is
 * the value of `contextJSON`, which is itself a JSON *string* inside an outer JSON object. So the
 * document carries the object escaped exactly once, and reading it is parse-twice, never
 * unescape-then-parse. `JSON.stringify` of a `JSON.stringify` reproduces that byte for byte;
 * hand-writing the backslashes would produce easier bytes than the wire and a test that passes
 * for the wrong reason (the plan's own warning, and the TikTok fixture's SLASH scar).
 *
 * The `data-media-*` attributes are carried too, because the GraphImage path reads them and
 * because a wrapper that omitted them would let a regression in the attribute scan hide here.
 */
const wrap = (media, { type = 'GraphVideo' } = {}) =>
  `<!doctype html><html><body>` +
  `<div class="Embed" data-media-type="${type}" data-media-id="${media?.id ?? ''}"></div>` +
  `<script>requireLazy(["TimeSliceImpl"],function(TimeSliceImpl){TimeSliceImpl.guard(function(){` +
  `requireLazy(["PolarisEmbedSimple"],function(m){m.init(${JSON.stringify({
    isRichEmbed: true,
    isSidecar: false,
    contextJSON: JSON.stringify({
      context: { type, shortcode: media?.shortcode ?? 'X', copyright_blocked: false },
      gql_data: { shortcode_media: media },
    }),
  })})})})})</script></body></html>`

// A real 19-digit media id, so every synthetic post has a derivable createdAt. See the snowflake
// test below for why the id IS the timestamp on this endpoint.
const ID = '3943405578951853695' // -> 2026-07-17T17:49:59Z

/**
 * A synthetic GraphImage page — the SERVER-RENDERED path, which has no blob to wrap.
 *
 * wrap() above cannot reach this half of the normalizer at all: it builds a page with a
 * `contextJSON` string, so shortcodeMedia() claims it and fromMarkup() never runs. Every negative
 * test written with wrap() therefore covers fromBlob ONLY — which is how the markup path's https
 * guard, its entity decoding, its `<br />` handling and its aspect-ratio maths all shipped with a
 * green suite and no assertion touching them. This builder is the missing half.
 *
 * The element shapes are transcribed from instagram-single.html rather than invented, because the
 * regexes are anchored on real class names and attribute order and a looser synthetic would pass
 * against a normalizer that no longer matches the wire.
 */
const img = ({
  id = ID,
  handle = 'nasajpl',
  avatar = 'https://cdn.example/avatar.jpg',
  src = 'https://cdn.example/full.jpg',
  srcset = 'https://cdn.example/small.jpg 320w, https://cdn.example/full.jpg 1440w',
  style = '',
  caption = 'hello',
  type = 'GraphImage',
} = {}) =>
  `<!doctype html><html><body>` +
  `<div class="Embed" data-media-type="${type}" data-media-id="${id}">` +
  `<div class="Avatar"><img src="${avatar}"></div>` +
  `<a href="https://www.instagram.com/${handle}/" data-log-event="profileClick">` +
  `<span class="UsernameText">${handle}</span></a>` +
  `<div class="Content EmbedFrame" style="${style}"><a class="EmbeddedMedia" href="#">` +
  `<img class="EmbeddedMediaImage" alt="Instagram post" src="${src}" srcset="${srcset}">` +
  `</a></div>` +
  `<div class="SocialProof"><a data-log-event="likeCountClick" href="#">4,737 likes</a></div>` +
  `<div class="Caption"><a class="CaptionUsername" href="#" data-log-event="captionProfileClick"` +
  ` target="_blank">${handle}</a>${caption}` +
  `<div class="CaptionComments"><a data-log-event="captionCommentsClick" href="#">` +
  `View all 30 comments</a></div></div>` +
  `</div></body></html>`

test('a single-image post normalizes into a well-formed Post', () => {
  const post = normalizeInstagram(SINGLE, SINGLE_REF)
  assert.ok(post, 'must normalize')
  assert.deepEqual(post.ref, SINGLE_REF)
  assert.ok(post.author.handle.length > 0)
  assert.ok(post.createdAt instanceof Date)
  assert.ok(!Number.isNaN(post.createdAt.getTime()))
  assert.ok(post.createdAt.getUTCFullYear() > 2010, `got ${post.createdAt.toISOString()}`)
  assert.equal(typeof post.text, 'string')
  assert.equal(post.sensitive, false, 'Instagram exposes no sensitivity signal — spec says always false')
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'image')
  assert.match(post.media[0].url, /^https:\/\//)
  assert.ok(post.media[0].w > 0 && post.media[0].h > 0, 'dimensions must be recovered, not left at 0')
})

test('A SINGLE IMAGE CARRIES NO GraphQL BLOB AT ALL — the plan predicted one and there is none', () => {
  // THE LARGEST DIVERGENCE THIS TASK FOUND, and the test exists so nobody "fixes" the HTML path
  // back out again. Measured 2026-07-19 on eleven live posts across three accounts and four
  // crawler UAs: the embed page ships `contextJSON` as the literal null for a single image, and
  // the shortcode_media object exists ONLY when the post is a video (isRichEmbed) or a carousel
  // (isSidecar). Instagram's own init flags in the document say it in as many words:
  //
  //   single image  {"isRichEmbed":false,"isSidecar":false,…,"contextJSON":null}
  //   reel          {"isRichEmbed":true, "isSidecar":false,…,"contextJSON":"{\"context\":…"}
  //   carousel      {"isRichEmbed":false,"isSidecar":true, …,"contextJSON":"{\"context\":…"}
  //
  // Single images are plausibly the commonest Instagram post there is, so a normalizer built on
  // shortcode_media alone would return null — i.e. fetch_fail — for most of the platform, and
  // would do it while looking perfectly healthy against a reel and a carousel fixture.
  assert.equal(shortcodeMedia(SINGLE), null, 'a single image genuinely has no blob')
  assert.ok(shortcodeMedia(REEL), 'a reel has one')
  assert.ok(shortcodeMedia(CAROUSEL), 'a carousel has one')
  // …and the post still normalizes, from the server-rendered markup.
  assert.ok(normalizeInstagram(SINGLE, SINGLE_REF), 'the GraphImage path must cover it')
})

test('THE MIXED CAROUSEL YIELDS EVERY CHILD, AND THE VIDEOS ARE LABELLED VIDEO', () => {
  // THE HEADLINE TEST OF THIS PHASE. Verified live: DaQ5CPTki4E has 10 children, 4 of them video,
  // and the embed carries all 10. Upstream reads __typename, which sidecar children DO NOT HAVE,
  // so it mislabels every carousel video as an image — and that failure is INVISIBLE, because a
  // mislabelled video still has a display_url and still renders a still.
  const post = normalizeInstagram(CAROUSEL, CAROUSEL_REF)
  assert.ok(post, 'must normalize')
  assert.equal(post.media.length, 10, 'the embed carries EVERY child; no pagination, no second request')
  const videos = post.media.filter(m => m.kind === 'video')
  const images = post.media.filter(m => m.kind === 'image')
  assert.equal(videos.length, 4, 'at least one child MUST be a video — is_video is the discriminator, not __typename')
  assert.equal(images.length, 6, 'and at least one MUST be an image, or this is not a MIXED carousel')
  assert.equal(videos.length + images.length, post.media.length, 'no child may be dropped or gain a third kind')
  for (const m of post.media) assert.match(m.url, /^https:\/\//)
})

test('the real carousel children provably carry NO __typename — fact 6, re-measured', () => {
  // Asserted on the FIXTURE, not on our output, so the day Instagram adds the field back this
  // test says so rather than the discriminator quietly starting to matter less.
  const sm = shortcodeMedia(CAROUSEL)
  const kids = sm.edge_sidecar_to_children.edges.map(e => e.node)
  assert.equal(kids.length, 10)
  for (const k of kids) {
    assert.equal(k.__typename, undefined, 'a sidecar child has no __typename on this endpoint')
    assert.equal(typeof k.is_video, 'boolean', 'is_video is what it does have')
  }
})

test('EVERY VIDEO ENTRY CARRIES A POSTER — the rich card depends on it', () => {
  // MEASURED 2026-07-19: preview_url pointing at the video made Discord request a poster, receive
  // mp4 bytes, and abandon the rich activity card for the plain OpenGraph one. Media.poster and
  // the /_media/{key}/poster{N} route already exist and are already tested; Instagram's whole job
  // is to POPULATE poster from display_url. Do not invent a second mechanism.
  for (const [name, h, ref] of [['reel', REEL, REEL_REF], ['carousel', CAROUSEL, CAROUSEL_REF]]) {
    const post = normalizeInstagram(h, ref)
    const vids = post.media.filter(x => x.kind === 'video')
    assert.ok(vids.length > 0, `${name}: fixture sanity — there must be a video to check`)
    for (const m of vids) {
      assert.ok(typeof m.poster === 'string' && m.poster.startsWith('https://'),
        `${name}: a video entry with no poster costs the rich card`)
      assert.notEqual(m.poster, m.url, `${name}: the poster must be the IMAGE, never the video`)
    }
  }
})

test('a reel yields ONE video entry, on a direct CDN url with no hop to collapse', () => {
  // Verified live cookie-free: video_url downloaded 6,887,308 bytes, h264/aac 720x1280, 75.58s,
  // at ZERO redirect hops. That is strictly better than TikTok, whose playable url is itself a
  // 302 that Workers egress provably cannot resolve (docs/research/2026-07-19-aweme-…).
  const post = normalizeInstagram(REEL, REEL_REF)
  assert.ok(post)
  assert.equal(post.media.length, 1)
  const v = post.media.find(m => m.kind === 'video')
  assert.ok(v, 'a reel must yield a video Media entry')
  assert.match(v.url, /^https:\/\//)
  assert.ok(v.w > 0 && v.h > 0)
  // Pinned exactly. `video_duration` is a FLOAT of seconds here (75.492), unlike TikTok's integer,
  // and dropping the assignment altogether would otherwise survive the suite.
  assert.equal(v.duration, 75.492, 'duration <- video_duration')
})

test('createdAt is DERIVED FROM THE MEDIA ID — there is no taken_at_timestamp on this endpoint', () => {
  // THE SECOND DIVERGENCE FROM THE PLAN. The plan specifies `taken_at_timestamp` as Unix seconds;
  // that field does not exist in the embed payload. The reel's shortcode_media keys, in full, are:
  // __typename, accessibility_caption, clips_music_attribution_info, dimensions, display_resources,
  // display_url, edge_liked_by, edge_media_to_caption, edge_media_to_comment, id, is_video, owner,
  // product_type, shortcode, thumbnail_resources, thumbnail_src, video_duration, video_url,
  // video_view_count. No timestamp of any kind, and the GraphImage markup has none either.
  //
  // The id IS the timestamp: Instagram media ids are Snowflake-shaped, (ms - 1314220021721) << 23.
  // Confirmed on six posts whose dates are known independently (search-result titles and a
  // #WorldOceansDay caption), 6/6 to the correct calendar day. Without it every Instagram Post
  // would need a fabricated date, and a fabricated date is what `createdAt` must never be.
  const reel = normalizeInstagram(REEL, REEL_REF)
  assert.equal(reel.createdAt.toISOString(), '2026-07-17T17:49:59.198Z')
  const single = normalizeInstagram(SINGLE, SINGLE_REF)
  // C79gQqLpkul's caption is a #WorldOceansDay post — 8 June, which is the day this decodes to.
  assert.equal(single.createdAt.toISOString().slice(0, 10), '2024-06-08')
})

test('canonical is rebuilt from the PAYLOAD, and a reel gets the /reel/ form', () => {
  // The ref carries only kind:'p' (every surface collapses onto one cache key — Task 2), so the
  // payload is the ONLY evidence about which surface this post really is. `product_type:'clips'`
  // is that evidence — measured present on the reel and absent on the carousel.
  assert.match(normalizeInstagram(SINGLE, SINGLE_REF).canonical, /instagram\.com\/p\/C79gQqLpkul/)
  assert.match(normalizeInstagram(REEL, REEL_REF).canonical, /instagram\.com\/reel\/Da5ynsiuAZ_/)
  assert.match(normalizeInstagram(CAROUSEL, CAROUSEL_REF).canonical, /instagram\.com\/p\/DaQ5CPTki4E/)
})

test('the author is read from the payload, and name degrades to the handle', () => {
  // `owner` on this endpoint is {id, username, is_verified, profile_pic_url, edge_followed_by} —
  // there is NO full_name, measured on both live blobs. So name === handle is the normal case
  // here rather than a degrade, and a renderer that printed an empty name would be showing an
  // empty byline on every Instagram post.
  for (const [h, ref] of [[REEL, REEL_REF], [CAROUSEL, CAROUSEL_REF], [SINGLE, SINGLE_REF]]) {
    const post = normalizeInstagram(h, ref)
    assert.equal(post.author.handle, 'nasajpl')
    assert.equal(post.author.name, 'nasajpl')
    assert.equal(post.author.url, 'https://www.instagram.com/nasajpl/')
    assert.match(post.author.avatar, /^https:\/\//)
  }
})

test('counts come from edge_liked_by and edge_media_to_comment, and views is never emitted', () => {
  // NOT edge_media_preview_like, which the plan names and which this payload does not have.
  // views is deliberately dropped: the reel reports `video_view_count: 0` while being a real post
  // with real views, so emitting it would render a confident "0 views" from a field the endpoint
  // simply does not populate. Absent beats wrong — the same rule count() applies to NaN.
  const reel = normalizeInstagram(REEL, REEL_REF)
  assert.equal(reel.counts.likes, 46280)
  assert.equal(reel.counts.replies, 495)
  assert.equal(reel.counts.views, undefined, 'video_view_count is 0 on a real reel — do not emit it')
  const car = normalizeInstagram(CAROUSEL, CAROUSEL_REF)
  assert.equal(car.counts.likes, 7130)
  assert.equal(car.counts.replies, 27)
})

test('the GraphImage path recovers likes and comments from the rendered markup', () => {
  // The single-image page has no blob, so these come out of the server-rendered text: "4,737
  // likes" and "View all 30 comments". Only the plain grouped-digit form is accepted — the same
  // document writes "1.4M followers" two lines up, and parsing that would invent a count of 1.
  const post = normalizeInstagram(SINGLE, SINGLE_REF)
  assert.equal(post.counts.likes, 4737)
  assert.equal(post.counts.replies, 30)
})

test('the caption survives both paths, with entities decoded and line breaks kept', () => {
  const car = normalizeInstagram(CAROUSEL, CAROUSEL_REF)
  assert.match(car.text, /^What’s up for July\?\n\n/, 'the blob path returns the caption verbatim')
  const single = normalizeInstagram(SINGLE, SINGLE_REF)
  // From the rendered markup: <a class="CaptionUsername">nasajpl</a> is the byline, NOT the first
  // word of the caption, and stripping it is what keeps "nasajpl" from being prepended to every
  // single-image post's text. <br /> becomes a newline; &amp;-style entities are decoded.
  assert.ok(!single.text.startsWith('nasajpl'), 'the CaptionUsername byline is not caption text')
  assert.match(single.text, /^That’s us\. That’s home\./)
  // NOT an entity-decoding assertion, and it never was: the only `&amp;` in this fixture's caption
  // region live inside the byline anchor's href, which captionFromMarkup strips before unentity is
  // ever called — so this passed with the `&amp;` rule deleted. The decoding that IS load-bearing
  // is on the CDN urls (the raw form 403s) and has its own test below; the ordering rule has one
  // too. This line is now only what it can honestly be: nothing escaped survives into the text.
  assert.ok(!single.text.includes('&amp;'), 'no escaped entity may survive into the caption')
  assert.ok(!single.text.includes('<'), 'no markup may survive into the caption')
  assert.ok(!single.text.includes('View all 30 comments'), 'the comments link is not caption text')
})

test('IS_VIDEO IS THE DISCRIMINATOR, PROVEN ON A CHILD WITH NO __typename AT ALL', () => {
  // Synthetic and deliberate. Sidecar children in the EMBED payload carry no __typename — their
  // keys are accessibility_caption, dimensions, display_resources, display_url, id, is_video,
  // owner, shortcode. A hand-written fixture naturally includes __typename because that is what
  // the GraphQL docs show, so the synthetic test passes against a __typename normalizer while
  // only the real fixture fails. This one is written the way the WIRE spells it.
  const media = {
    id: ID, shortcode: 'X',
    owner: { username: 'u' },
    dimensions: { width: 1080, height: 1080 },
    display_url: 'https://cdn/cover.jpg',
    edge_media_to_caption: { edges: [{ node: { text: 'hi' } }] },
    edge_sidecar_to_children: { edges: [
      { node: { id: '1', is_video: false, display_url: 'https://cdn/1.jpg',
                dimensions: { width: 1080, height: 1080 } } },
      { node: { id: '2', is_video: true, video_url: 'https://cdn/2.mp4',
                display_url: 'https://cdn/2.jpg',
                dimensions: { width: 720, height: 1280 } } },
    ] },
  }
  const post = normalizeInstagram(wrap(media, { type: 'GraphSidecar' }), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(post.media.length, 2)
  assert.equal(post.media[0].kind, 'image')
  assert.equal(post.media[1].kind, 'video', 'is_video:true with NO __typename must still be a video')
  assert.equal(post.media[1].url, 'https://cdn/2.mp4')
  assert.equal(post.media[1].poster, 'https://cdn/2.jpg')
  assert.equal(post.text, 'hi')
})

test('a video child with NO video_url degrades to its still, never to a dead player', () => {
  // Phase 1's I-1 lesson, restated for a third platform: an og:video pointing at something that
  // cannot play renders a DEAD player AND suppresses og:image, so the post shows nothing at all.
  const media = {
    id: ID, shortcode: 'X', owner: { username: 'u' },
    dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg',
    edge_sidecar_to_children: { edges: [
      { node: { id: '1', is_video: true, display_url: 'https://cdn/1.jpg',
                dimensions: { width: 720, height: 1280 } } },
    ] },
  }
  const post = normalizeInstagram(wrap(media, { type: 'GraphSidecar' }), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(post.media.length, 1, 'the still must still produce an entry')
  assert.equal(post.media[0].kind, 'image')
  assert.equal(post.media[0].url, 'https://cdn/1.jpg')
  assert.equal(post.media[0].poster, undefined, 'an image is its own poster; the key must be absent')
})

test('THE ~598KB DECOY MUST FAIL — the one silent failure mode', () => {
  // Named by the spec's own testing table. HTTP 200, valid content-type, and SIX TIMES LARGER
  // than the real payload, so every instinct that reaches for a size or status check is
  // backwards. Only the absence of the object distinguishes it.
  assert.equal(shortcodeMedia(DECOY), null)
  assert.equal(normalizeInstagram(DECOY, SINGLE_REF), null)
  assert.equal(hasEmbedPost(DECOY), false)
  assert.ok(DECOY.length > 300_000, 'fixture sanity: this really is the big shell')
  // AND THE DECOY IS THE SAME POST AS THE SINGLE FIXTURE. Same shortcode, same moment, one
  // crawler UA and one Chrome UA — so this pair is the UA inversion itself, held in the repo.
  assert.ok(SINGLE.includes('C79gQqLpkul') && DECOY.includes('C79gQqLpkul'))
  assert.ok(hasEmbedPost(SINGLE), 'the crawler-UA capture of the very same post must pass')
})

test('an unavailable post is null, not a blank embed', () => {
  // A well-formed shortcode that names nothing returns an 80,319-byte page at HTTP 200 carrying
  // TimeSliceImpl and a contextJSON key — so neither of those is a liveness marker, which is
  // exactly the question Task 1 left open. It has no data-media-type and no gql_data.
  assert.equal(normalizeInstagram(GONE, SINGLE_REF), null)
  assert.equal(hasEmbedPost(GONE), false)
  assert.ok(GONE.includes('TimeSliceImpl'), 'the dead page carries the marker the plan considered')
  assert.ok(GONE.includes('contextJSON'), 'and the other one too — neither discriminates')
})

test('hasEmbedPost is the ONE question the fetcher asserts on, and it is not shortcode_media', () => {
  // Task 4's content assertion cannot be `shortcode_media`: that would reject every single-image
  // post as a failed fetch while accepting nothing the decoy does not already fail. This is the
  // one spelling of "a real post page arrived", for the same reason videoDetailScope is TikTok's.
  assert.equal(hasEmbedPost(SINGLE), true)
  assert.equal(hasEmbedPost(CAROUSEL), true)
  assert.equal(hasEmbedPost(REEL), true)
  assert.equal(hasEmbedPost(GONE), false)
  assert.equal(hasEmbedPost(DECOY), false)
  assert.equal(hasEmbedPost(''), false)
  assert.equal(hasEmbedPost(null), false)
})

test('a caption-less post is text:"" and still a Post', () => {
  const media = {
    id: ID, shortcode: 'X', owner: { username: 'u' },
    dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg',
    edge_media_to_caption: { edges: [] },
  }
  const post = normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' })
  assert.ok(post, 'no caption is not a reason to reject a post')
  assert.equal(post.text, '')
})

test('a non-https media url is SKIPPED, never emitted', () => {
  // These strings become og:image and og:video. A protocol-relative or http URL there is a
  // mixed-content hole we would be authoring ourselves.
  //
  // ASSERT THE LENGTH, not `.every()`. `[].every(...)` is vacuously true and `!post` short-circuits
  // the whole thing, so the original shape of this assertion passed whenever the post was null or
  // the media array empty FOR ANY REASON — including a normalizer that had stopped parsing.
  const media = {
    id: ID, shortcode: 'X', owner: { username: 'u' },
    dimensions: { width: 1, height: 1 }, display_url: 'http://cdn/insecure.jpg',
  }
  const post = normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' })
  assert.ok(post, 'the post itself still normalizes — only the entry is dropped')
  assert.equal(post.media.length, 0)
  // The control: the same page with an https url DOES produce an entry, so the assertion above
  // cannot be passing because nothing was read.
  const ok = normalizeInstagram(wrap({ ...media, display_url: 'https://cdn/fine.jpg' }), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(ok.media.length, 1)
})

test('an unusable media id is NULL, not a 1970 post and not a 2011 one', () => {
  // The id is the ONLY timestamp source, so an id we cannot decode is a post we cannot date.
  // `(0 >> 23) + epoch` is a perfectly valid-looking 2011 Date, which is why this rejects on the
  // id's SHAPE rather than on the Date being NaN — the Bluesky/TikTok "validate the Date you are
  // handing out" rule does not catch this one on its own.
  //
  // THESE ARE THE MALFORMED ids ONLY — not one of them is in the accepting range, so this test
  // does NOT cover the 2011 date its title names. The one that does is the width test below;
  // this list would pass against a shape rule of "any digits at all", and did.
  for (const id of ['not-an-id', '', '0', '-1', '1.5', 'x'.repeat(40), null, 12345]) {
    const media = {
      id, shortcode: 'X', owner: { username: 'u' },
      dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg',
    }
    assert.equal(normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' }), null, `id=${id}`)
  }
})

test('returns null on junk rather than throwing or inventing a Post', () => {
  for (const junk of [null, undefined, 42, '', '<html></html>', '{}', '<script>not json</script>',
                      '"contextJSON":"', '"contextJSON":"{oops', '"contextJSON":null']) {
    assert.doesNotThrow(() => normalizeInstagram(junk, SINGLE_REF), String(junk).slice(0, 40))
    assert.equal(normalizeInstagram(junk, SINGLE_REF), null, String(junk).slice(0, 40))
  }
})

test('normalizeInstagram refuses a ref that is not an ig POST ref', () => {
  assert.equal(normalizeInstagram(SINGLE, { p: 'tt', id: '1' }), null)
  assert.equal(normalizeInstagram(SINGLE, { p: 'bs', handle: 'a', rkey: 'b' }), null)
  // A story ref is an ig ref with NO `code`, so it would interpolate `undefined` into canonical.
  // Stories are out of scope for this phase (plan, Task 2 decision 4) and this is where the
  // normalizer says so instead of minting instagram.com/p/undefined/.
  assert.equal(normalizeInstagram(SINGLE, { p: 'ig', kind: 'story', user: 'u', id: '1' }), null)
})

test('a hostile ref.code can never reach the location header', () => {
  // canonical goes to worker.ts's redirect(), i.e. into a `location` header, where a raw CR/LF
  // makes new Headers() throw — the HTTP 500 fixed in 4655ee8 for the router's own canonicals.
  for (const code of ['a\r\nb', 'a b', '../evil', 'a/b', 'x'.repeat(200)]) {
    assert.equal(normalizeInstagram(SINGLE, { p: 'ig', kind: 'p', code }), null, code)
  }
})

test('the extraction is LINEAR, so the decoy cannot burn the CPU budget', () => {
  // TikTok's normalizer carries a measured scar: an unbounded attribute scan is quadratic and
  // took 23s of Worker CPU on 1MB against Cloudflare's 30s ceiling. Instagram hands us a 597,851-byte
  // body on the wrong UA ON PURPOSE, so the pathological input here is one the platform serves.
  // A megabyte of the worst shape — the marker repeated with no closing quote ever — must stay
  // in the milliseconds.
  const hostile = '"contextJSON":"' + 'a'.repeat(1_000_000)
  const t0 = Date.now()
  assert.equal(normalizeInstagram(hostile, SINGLE_REF), null)
  assert.equal(normalizeInstagram(DECOY, SINGLE_REF), null)
  const ms = Date.now() - t0
  assert.ok(ms < 2_000, `extraction took ${ms}ms — a quadratic scan has come back`)
})

test('AN IN-SHAPE BUT TOO-SHORT MEDIA ID IS NULL — the whole low range decodes to one 2011 instant', () => {
  // THE GUARD ABOVE ONLY EVER CAUGHT A LEADING ZERO. `MEDIA_ID` was /^[1-9]\d{5,23}$/, so a
  // six-digit id passed the SHAPE test the comment calls load-bearing and then decoded to
  // 2011-08-24T21:07:01.721Z — the exact fabricated date the sibling test's title promises is
  // prevented. Every id below 2^23 shifts to zero and lands on the epoch instant itself, and the
  // whole sub-18-digit range lands within days of it:
  //
  //   6 digits -> 2011-08-24   17 digits -> 2011-09-10   18 digits -> 2012-01-09   19 -> real
  //
  // The year window cannot see any of this (a right shift is non-negative, so nothing can decode
  // BELOW the 2011 epoch), which is why the fix is the width and not the window.
  for (const id of ['100000', '999999', '8388607', '1234567', '99999999999', '12345678901234567']) {
    const media = { id, shortcode: 'X', owner: { username: 'u' },
                    dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg' }
    assert.equal(normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' }), null, `id=${id}`)
    // The markup path derives the same date from the same shape, through data-media-id.
    assert.equal(normalizeInstagram(img({ id }), { p: 'ig', kind: 'p', code: 'X' }), null, `markup id=${id}`)
  }
  // …and the widths that ARE real still decode. 19 digits is every post since 2015-06-04; 18 is
  // the floor, reaching back to 2012-01-09, and dropping it would return null — fetch_fail — for
  // every post older than 2015 rather than merely mis-dating it.
  const ok = id => normalizeInstagram(img({ id }), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(ok('100000000000000000').createdAt.toISOString().slice(0, 10), '2012-01-09')
  assert.equal(ok(ID).createdAt.toISOString(), '2026-07-17T17:49:59.198Z')
})

test('the single image reports the LARGEST srcset width, and it is the width of the url it emits', () => {
  // Both halves were unpinned: `w > 0 && h > 0` passes just as happily when dimsFromMarkup folds
  // the srcset with Math.MIN and reports a 150w thumbnail's width against the 799w url in `src`.
  // discord.ts and telegram.ts turn these into og:image:width/height, so the failure is a client
  // reserving a 150px box for an 799px picture — silent, and invisible to every existing assertion.
  const post = normalizeInstagram(SINGLE, SINGLE_REF)
  assert.equal(post.media[0].w, 799, 'the FULL-SIZE srcset entry, not the smallest')
  assert.equal(post.media[0].h, 799, 'no padding-bottom on this frame means square — verified against the JPEG SOF')
  // The fixture's srcset carries 799w down to 150w, so a min/max flip is a real 799 -> 150 divergence.
  assert.match(SINGLE, /\s150w/, 'fixture sanity: there IS a smaller entry to pick by mistake')
  // And the reported width must describe the url actually handed to clients: `src` is the 799w entry.
  assert.ok(SINGLE.includes(`${post.media[0].url.replace(/&/g, '&amp;')} 799w`),
    'the emitted url must be the srcset entry whose descriptor we reported')
})

test('A PORTRAIT SINGLE IMAGE IS NOT SQUARE — the height comes from padding-bottom', () => {
  // THE COMMONEST REAL SHAPE, AND THE ONE THE FIXTURES CANNOT REACH. instagram-single.html is a
  // square post whose frame is literally `style=""`, so FRAME_RATIO never matched in this suite and
  // `pct` always fell to its `?? 100` default — h === w by coincidence. Instagram's default
  // portrait crop is 4:5, i.e. padding-bottom:125%, so the untested branch is the one most
  // single-image posts take. Deleting the aspect-ratio read entirely used to pass 24/24.
  const portrait = normalizeInstagram(
    img({ style: 'padding-bottom: 125.0%;', srcset: 'https://cdn.example/s.jpg 320w, https://cdn.example/full.jpg 1440w' }),
    { p: 'ig', kind: 'p', code: 'X' },
  )
  assert.equal(portrait.media[0].w, 1440)
  assert.equal(portrait.media[0].h, 1800, '1440 * 125/100 — a square guess would say 1440')
  // The exact pair the implementation comment claims it measured against the JPEG's SOF marker —
  // 1440w at 133.33333333333% is 1440x1920 — which nothing in the repo pinned until now.
  const measured = normalizeInstagram(
    img({ style: 'padding-bottom: 133.33333333333331%;', srcset: 'https://cdn.example/full.jpg 1440w' }),
    { p: 'ig', kind: 'p', code: 'X' },
  )
  assert.deepEqual({ w: measured.media[0].w, h: measured.media[0].h }, { w: 1440, h: 1920 })
  // The 4:3 landscape form, so the multiplier is exercised in both directions.
  const landscape = normalizeInstagram(
    img({ style: 'padding-bottom: 75%;', srcset: 'https://cdn.example/full.jpg 1080w' }),
    { p: 'ig', kind: 'p', code: 'X' },
  )
  assert.equal(landscape.media[0].h, 810, '1080 * 75/100')
  // An absent padding-bottom is SQUARE, which is the default the fixture happens to exercise.
  const square = normalizeInstagram(img({ srcset: 'https://cdn.example/full.jpg 640w' }), { p: 'ig', kind: 'p', code: 'X' })
  assert.deepEqual({ w: square.media[0].w, h: square.media[0].h }, { w: 640, h: 640 })
})

test('MARKUP CDN URLS ARE ENTITY-DECODED — the raw form 403s at the CDN', () => {
  // MEASURED 2026-07-19 on the single fixture's own image url: decoded it returns HTTP 200 and
  // 50,612 bytes of image/jpeg; with the `&amp;` left in it returns HTTP 403 and 12 bytes of
  // text/plain, because Instagram's signature params arrive as `amp;oh=` / `amp;oe=` and the CDN
  // sees no signature at all. This url is exactly what /_media/{key}/0 302s Discord and Telegram
  // to, so a regression here breaks the picture on every single-image post.
  //
  // The assertion that used to stand in for this — `!single.text.includes('&amp;')` on the CAPTION
  // — never ran against an `&amp;`: the only ones in the caption region live in the byline
  // anchor's href, which captionFromMarkup strips before unentity is ever called.
  const post = normalizeInstagram(SINGLE, SINGLE_REF)
  for (const [what, url] of [['media', post.media[0].url], ['avatar', post.author.avatar]]) {
    assert.ok(!url.includes('&amp;'), `${what}: the escaped form is what the CDN 403s`)
    assert.ok(!url.includes('amp;'), `${what}: no half-decoded parameter names either`)
    assert.match(url, /&_nc_cat=/, `${what}: fixture sanity — this url really does carry & params`)
  }
  // The raw attribute in the fixture IS escaped, so the decode is doing work rather than
  // passing through a url that never needed it.
  assert.ok(SINGLE.includes(post.media[0].url.replace(/&/g, '&amp;')), 'the wire form is the escaped one')
})

test('unentity decodes &amp; LAST, so &amp;lt; survives as text and never becomes markup', () => {
  // The ordering bug this class of function is famous for: unescape `&amp;` first and `&amp;lt;`
  // becomes a literal `<`. Moving that one replace to the front of the chain used to pass 24/24,
  // because no fixture caption contains a doubly-escaped entity.
  const post = normalizeInstagram(img({ caption: 'Ocean &amp; sky &amp;lt;3 &#64;home &#x21;' }), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(post.text, 'Ocean & sky &lt;3 @home !')
})

test('<br /> becomes a newline, so the same post reads the same on both paths', () => {
  // The markup path's ONLY line break is `<br />`; the blob path's captions carry real newlines.
  // The two must agree or a post reads differently depending on its media type. The existing
  // caption assertion is anchored at `^That’s us`, which matches whether or not the breaks
  // survive, so dropping the conversion altogether used to pass.
  const single = normalizeInstagram(SINGLE, SINGLE_REF)
  assert.equal((single.text.match(/\n/g) || []).length, 8, 'the live caption has eight line breaks')
  const synthetic = normalizeInstagram(img({ caption: 'a<br />b<br>c' }), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(synthetic.text, 'a\nb\nc')
})

test('a non-https media url is SKIPPED ON THE MARKUP PATH TOO, and the entry is not emitted', () => {
  // The existing https test builds its page with wrap(), which is a BLOB page — so it exercised
  // fromBlob only, and the markup path's guard was unprotected. Its assertion shape was also
  // vacuous twice over: `!post || post.media.every(...)` is true for a null post AND for an empty
  // array, so it would pass if the entry vanished for any unrelated reason. Assert the LENGTH.
  for (const src of ['http://cdn.example/a.jpg', '//cdn.example/a.jpg', 'javascript:alert(1)']) {
    const post = normalizeInstagram(img({ src }), { p: 'ig', kind: 'p', code: 'X' })
    assert.ok(post, `${src}: the post itself still normalizes`)
    assert.equal(post.media.length, 0, `${src}: an unvouchable url must not become an og:image`)
  }
  // …and the control case, so the assertion above cannot be passing because nothing was parsed.
  assert.equal(normalizeInstagram(img(), { p: 'ig', kind: 'p', code: 'X' }).media.length, 1)
})

test('A CONTROL CHARACTER IN A MEDIA URL NEVER REACHES THE LOCATION HEADER', () => {
  // worker.ts's /_media/ branch does `new Response(null, {headers: {location: target}})` with no
  // try/catch, and a raw CR/LF makes Headers throw — the same uncaught HTTP 500 that 4655ee8 fixed
  // for the router's canonicals, and the reason CODE excludes those bytes. httpsUrl checked only
  // the `https://` PREFIX, so the rest of the string was unexamined on both paths.
  //
  // The markup path is the sharper half because it MANUFACTURES the control characters: unentityUrl
  // runs the full entity decoder over the attribute, so `&#13;&#10;` in an img src becomes a real
  // CR/LF in a string pickMedia hands straight to a 302.
  const blob = { id: ID, shortcode: 'X', owner: { username: 'u' }, dimensions: { width: 1, height: 1 },
                 display_url: 'https://cdn/a.jpg?x=1\r\nX-Injected: yes' }
  assert.deepEqual(normalizeInstagram(wrap(blob), { p: 'ig', kind: 'p', code: 'X' }).media, [],
    'blob path: a url with CR/LF is skipped, not emitted')
  const markup = normalizeInstagram(img({ src: 'https://cdn.example/a.jpg?x=1&#13;&#10;X-Injected:%20yes' }),
    { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(markup.media.length, 0, 'markup path: the decoder must not be able to mint one either')
  // An avatar goes into the same header through /_media/{key}/avatar.
  assert.equal(normalizeInstagram(img({ avatar: 'https://cdn.example/a.jpg\r\nX: y' }), { p: 'ig', kind: 'p', code: 'X' })
    .author.avatar, undefined)
  // Belt: every url the three live fixtures produce must be header-safe by construction.
  for (const [h, ref] of [[SINGLE, SINGLE_REF], [CAROUSEL, CAROUSEL_REF], [REEL, REEL_REF]]) {
    const post = normalizeInstagram(h, ref)
    for (const url of [post.author.avatar, ...post.media.flatMap(m => [m.url, m.poster])]) {
      if (url) assert.doesNotThrow(() => new Headers({ location: url }), url.slice(0, 60))
    }
  }
})

test('THE GraphImage GATE IS NARROW: a blob-less video is NULL, never a half-read image post', () => {
  // The stated safety property of the whole markup path — "it claims a page ONLY when the markup
  // says GraphImage, so a future video shape that loses its blob fails loudly here rather than
  // being half-read into a Post with no player". Widening the gate to any Graph* type used to pass
  // 24/24, and the result is exactly the asymmetric-invisible failure fact 6 is about: the reel
  // came back as an image-only Post with a /p/ canonical, a still, and no player.
  for (const [name, h, ref] of [['reel', REEL, REEL_REF], ['carousel', CAROUSEL, CAROUSEL_REF]]) {
    const blobless = h.replaceAll('contextJSON', 'ctxJSON')
    assert.equal(shortcodeMedia(blobless), null, `${name}: fixture sanity — the blob really is gone`)
    assert.equal(normalizeInstagram(blobless, ref), null, `${name}: half a post is worse than none`)
    // AND THE ASYMMETRY IS DELIBERATE, pinned here so Task 4 knows: hasEmbedPost still says yes,
    // because MEDIA_TYPE matches any Graph* type. So a drifted video page is cached as a good body
    // and then fails in the normalizer — loudly, which is the point — rather than being served.
    assert.equal(hasEmbedPost(blobless), true, `${name}: the liveness check is deliberately wider`)
  }
})

test('a count that is negative or fractional is ABSENT, never printed as fact', () => {
  // count() exists precisely because -5 likes and 1.9 comments are upstream nonsense a renderer
  // would print verbatim. Every count in every fixture is a well-formed non-negative integer, so
  // replacing count() with num() used to pass the whole suite.
  const media = { id: ID, shortcode: 'X', owner: { username: 'u' }, dimensions: { width: 1, height: 1 },
                  display_url: 'https://cdn/c.jpg',
                  edge_liked_by: { count: -5 }, edge_media_to_comment: { count: 1.9 } }
  const post = normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(post.counts.likes, undefined, '-5 likes is drift, not a count')
  assert.equal(post.counts.replies, undefined, '1.9 comments is drift, not a count')
  // The markup path strips separators before counting, so "4,737" must still arrive as 4737 —
  // the control that keeps the assertions above from passing because counting broke entirely.
  assert.equal(normalizeInstagram(img(), { p: 'ig', kind: 'p', code: 'X' }).counts.likes, 4737)
})

test('a handle that cannot be trusted as a path is NULL on both paths', () => {
  // The handle is interpolated raw into author.url with no new URL() around it, and USERNAME
  // captures `[^<]{1,64}` — which admits spaces, quotes and CR/LF straight out of the markup.
  // HANDLE is the only thing standing between that and a rendered link; nothing tested it.
  for (const handle of ['a'.repeat(31), 'a/b', 'a b', 'a\r\nb', '', 'a"b']) {
    assert.equal(normalizeInstagram(img({ handle }), { p: 'ig', kind: 'p', code: 'X' }), null, `markup ${JSON.stringify(handle)}`)
    const media = { id: ID, shortcode: 'X', owner: { username: handle },
                    dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg' }
    assert.equal(normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' }), null, `blob ${JSON.stringify(handle)}`)
  }
  // 30 characters is the platform's own limit and must still pass, or the guard is a coverage bug.
  assert.equal(normalizeInstagram(img({ handle: 'a'.repeat(30) }), { p: 'ig', kind: 'p', code: 'X' }).author.handle,
    'a'.repeat(30))
})

test('sensitive is false on the BLOB path too, not only on the markup one', () => {
  // Instagram exposes no per-post sensitivity signal at all (spec §Sensitivity), so this is a
  // constant — but it was only ever asserted on the single-image fixture, i.e. on fromMarkup.
  // Flipping fromBlob's literal to true used to pass 24/24, and a spurious sensitive:true is a
  // spoiler-wrapped embed on every reel and carousel.
  for (const [h, ref] of [[REEL, REEL_REF], [CAROUSEL, CAROUSEL_REF]]) {
    assert.equal(normalizeInstagram(h, ref).sensitive, false)
  }
})

test('a ref carrying no usable code can never mint instagram.com/p/undefined/', () => {
  // CODE.test(undefined) is TRUE — the regex coerces its argument, and "undefined" matches
  // /^[A-Za-z0-9_-]{1,64}$/ perfectly. So the guard whose docstring promises to be "total by
  // construction" because "ref may arrive from the CACHE unvalidated" minted exactly the URL its
  // sibling story-ref guard exists to prevent. Not reachable through parseRefKey today; it is a
  // hole in a claimed-total guard, which is the kind that gets relied on later.
  for (const code of [undefined, null, 123, true, ['abc'], {}]) {
    assert.equal(normalizeInstagram(SINGLE, { p: 'ig', kind: 'p', code }), null, String(code))
  }
})

// ── Task 4: the FETCHER's contract ───────────────────────────────────────────────────────────
// The fetcher does I/O, so what is testable offline is its contract: the UA it sends, the URL it
// builds, its content assertion, and how it CLASSIFIES a body it does not like. The classifier is
// pure — no network and no stubbed globals — and the two I/O tests stub `fetch` rather than
// reaching Instagram, so the whole suite still runs offline.

test('THE UA IS CRAWLER-SHAPED — INSTAGRAM IS INVERTED FROM TIKTOK', () => {
  // The mirror image of tiktok-normalize.test.mjs's 'THE UA IS NOT CRAWLER-SHAPED'. Both
  // assertions exist so the inversion cannot be "fixed" silently in EITHER direction, which is a
  // live risk rather than a theoretical one: both normalizers and both fetchers open with a
  // paragraph about not conflating them, in language that reads almost identically.
  //
  // Measured 2026-07-19: facebookexternalhit, Discordbot and curl/8.4.0 all get the real
  // server-rendered payload; Chrome/122 gets the ~598KB empty shell at HTTP 200 (this repo holds
  // both captures of the SAME post — instagram-single.html and instagram-decoy.html). curl
  // succeeding is the decisive row: the least browser-like fingerprint available gets the real
  // content, which is what disproves the widely-repeated TLS/JA3 theory. The gate is the UA.
  assert.ok(/bot|crawler|external|curl/i.test(INSTAGRAM_UA), `INSTAGRAM_UA must be crawler-shaped, got ${INSTAGRAM_UA}`)
  assert.ok(!/Mozilla\/5\.0 \(Macintosh|Windows NT/.test(INSTAGRAM_UA), 'and must not be a browser UA')
  assert.notEqual(INSTAGRAM_UA, TIKTOK_UA, 'the two platforms gate in OPPOSITE directions')
})

test('the fetcher asserts on CONTENT — and the ~598KB decoy fails that assertion', () => {
  // Status is 200 and content-type is text/html for BOTH. Size is not a signal either, and it
  // points the wrong way: the decoy is SIX TIMES the real document.
  assert.equal(hasEmbedPayload(SINGLE), true)
  assert.equal(hasEmbedPayload(CAROUSEL), true)
  assert.equal(hasEmbedPayload(REEL), true)
  assert.equal(hasEmbedPayload(DECOY), false, 'the decoy must not pass the page assertion')
  assert.equal(hasEmbedPayload(GONE), false, 'a well-formed code naming nothing is not a page that answered')
  assert.equal(hasEmbedPayload(''), false)
  assert.equal(hasEmbedPayload(null), false)
})

test('THE PAGE ASSERTION IS hasEmbedPost ITSELF, NOT A SECOND SPELLING OF IT', () => {
  // THE PLAN'S SKETCH FOR THIS FILE WAS `shortcodeMedia(body) !== null`, AND IT IS WRONG ON THE
  // COMMONEST POST ON THE PLATFORM. Measured 2026-07-19 and pinned by 'A SINGLE IMAGE CARRIES NO
  // GraphQL BLOB AT ALL' above: a single image arrives with `"contextJSON":null` and is
  // server-rendered into the markup, so there is no shortcode_media anywhere in the document.
  // That assertion would have counted every single-image post as assert_fail — the counter that
  // means "Instagram changed and we are blind" — while a reel and a carousel looked perfectly
  // healthy, which is the worst possible shape for a false alarm.
  //
  // Asserted as an EQUALITY over every fixture rather than by re-listing expected booleans,
  // because the property that matters is delegation: one spelling of "did a real post page
  // arrive", in the normalizer, where the extraction that a platform change breaks first already
  // lives. Re-implementing the check here is two things to keep in step, and the drift would be
  // silent — the same rule videoDetailScope states for TikTok.
  for (const [name, body] of Object.entries({ SINGLE, CAROUSEL, REEL, DECOY, GONE })) {
    assert.equal(hasEmbedPayload(body), hasEmbedPost(body), name)
  }
  // And the specific claim, spelled out so a reader does not have to run it: no shortcode_media
  // in the single-image capture at all, yet it must pass.
  assert.equal(SINGLE.includes('shortcode_media'), false, 'fixture sanity: the plan predicted a blob and there is none')
  assert.equal(shortcodeMedia(SINGLE), null)
  assert.equal(hasEmbedPayload(SINGLE), true, 'the commonest post on Instagram must not be assert_fail')
})

/**
 * Break BOTH page markers — the blob's `"contextJSON":"` and the markup's `data-media-type`.
 *
 * hasEmbedPost is a DISJUNCTION (a parseable blob OR a Graph* media type in the markup), because
 * the two payload shapes are genuinely different documents, so a rename has to take out both to be
 * a page failure. Renaming by APPENDING would not do it either: the scan looks for the literal
 * `"contextJSON":"`, so `contextJSON2` still contains it — hence a rename to a different token.
 */
const renameMarkers = h =>
  h.replaceAll('"contextJSON":"', '"ctxV2":"').replaceAll('data-media-type', 'data-media-kind')

test('A DECOY, A BLOCK PAGE OR A CHANGED MARKER IS assert_fail — and never throws', () => {
  // pageOutcome is PURE, so this needs no network and no stubbed global fetch.
  const cases = {
    decoy: DECOY,
    // A deleted or private post: the 80,319-byte "post unavailable" page, at HTTP 200, carrying
    // BOTH TimeSliceImpl and a contextJSON key. It is the negative control that proves neither of
    // those is a liveness marker — the question Task 1 was written to answer.
    gone: GONE,
    '429': '<html><head><title>429 Too Many Requests</title></head><body>rate limited</body></html>',
    // The markers RENAMED — the single most likely way this platform dies.
    //
    // THE PLAN'S OWN CASE HERE WAS A NO-OP AND ASSERTED NOTHING: it spelled this
    // `SINGLE.replaceAll('shortcode_media', …)`, and the single-image fixture contains no
    // shortcode_media to replace, so the "renamed" body was byte-identical to a healthy page.
    renamed_blob_page: renameMarkers(REEL),
    renamed_markup_page: renameMarkers(SINGLE),
    login: '<html><body>Log in to Instagram</body></html>',
    empty: '',
  }
  for (const [name, body] of Object.entries(cases)) {
    let got
    assert.doesNotThrow(() => { got = pageOutcome(body) }, name)
    assert.equal(got.ok, false, name)
    assert.equal(got.reason, 'assert_fail', name)
  }
  // Non-strings from a hostile or broken caller degrade the same way rather than throwing: this
  // body is whatever res.text() produced, and a non-string here must classify, not 500.
  for (const junk of [null, undefined, 42, {}]) {
    assert.equal(pageOutcome(junk).ok, false, String(junk))
    assert.equal(pageOutcome(junk).reason, 'assert_fail', String(junk))
  }
})

test('HALF a rename is still a page that ARRIVED — the asymmetry is deliberate, in one direction', () => {
  // The counterpart to the case above, and it pins the behaviour hasEmbedPost's docstring calls
  // intended "in that direction and only that direction". A video page that lost only its blob
  // still proves a real post page came back, so it is ok here and normalizes to null one layer
  // down — a loud fetch_fail rather than a reel served with no player. The reverse is what must
  // never happen: a page with NEITHER marker is never ok, which the previous test pins.
  const blobless = REEL.replaceAll('"contextJSON":"', '"ctxV2":"')
  assert.equal(pageOutcome(blobless).ok, true, 'the markup marker still proves the page arrived')
  assert.equal(normalizeInstagram(blobless, REEL_REF), null, 'and the drift surfaces as fetch_fail')
})

test('a real page is ok:true and carries the body through unmodified', () => {
  for (const [name, body] of Object.entries({ SINGLE, CAROUSEL, REEL })) {
    const got = pageOutcome(body)
    assert.equal(got.ok, true, name)
    assert.equal(got.html, body, `${name}: the body must reach the normalizer byte-for-byte`)
  }
})

test('THE FETCHER PINS ITS UPSTREAM URL — a traversal code cannot steer our egress off the post path', async () => {
  // router.ts's instagram() requires only that the code segment be TRUTHY — there is no shape
  // check there — and route() safeDecodes each segment first. So `/p/..%2f..%2fevil` is a public
  // URL anyone can paste that reaches this function with ref.code === '../../evil', and bare
  // interpolation collapses https://www.instagram.com/p/../../evil/embed/captioned/ to
  // https://www.instagram.com/evil/embed/captioned/ — an attacker-chosen path on instagram.com,
  // fetched with OUR egress. encodeURIComponent is load-bearing TODAY, not future-proofing; the
  // identical guard on fetchTikTok carries the identical scar.
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response('<html>not the point</html>')
  }
  try {
    // '../../evil' is now refused BEFORE the fetch by the shortcode shape check, so it must
    // contribute no call at all — see 'A CODE THAT CANNOT BE A SHORTCODE NEVER REACHES THE
    // NETWORK'. It stays in this list so that loosening the shape check without thinking puts the
    // traversal URL back into calls[] and trips the pathname assertion below.
    await fetchInstagram({ p: 'ig', kind: 'p', code: '../../evil' })
    await fetchInstagram({ p: 'ig', kind: 'p', code: 'Da5ynsiuAZ_' })
    // Task 2 collapses every surface to kind 'p', but a kind that survived in an old CACHE entry
    // still arrives here, and the embed endpoints are byte-identically interchangeable — so there
    // is exactly ONE spelling of this URL and the kind must never reach it.
    await fetchInstagram({ p: 'ig', kind: 'reel', code: 'Da5ynsiuAZ_' })
  } finally {
    globalThis.fetch = real
  }

  assert.equal(calls.length, 2, 'the traversal code must not have produced a request at all')
  // EVERY call, not just calls[0] — asserting the invariant over one sample is how the version
  // this replaced passed while the property it named ("the code must never escape") was false for
  // `..` and `.`. `u.pathname` is the NORMALISED path, so a segment that collapsed during URL
  // parsing shows up here even when the template string looked pinned.
  for (const { url } of calls) {
    const u = new URL(url)
    assert.equal(u.host, 'www.instagram.com', url)
    assert.match(u.pathname, /^\/p\/[^/]+\/embed\/captioned\/$/, `${url} escaped /p/{code}/embed/captioned/`)
  }
  // The ordinary case is unencoded and unchanged — the guard is not paid for by mangling real
  // shortcodes, which legitimately contain `-` and `_`.
  assert.equal(calls[0].url, 'https://www.instagram.com/p/Da5ynsiuAZ_/embed/captioned/')
  assert.equal(calls[1].url, calls[0].url, 'a reel is fetched at the /p/ spelling, byte-identical payload')

  // The header must be spelled exactly, and a misspelled key sends no UA at all. THAT IS NOT A
  // SURVIVABLE BRANCH ON THIS PLATFORM, though an earlier version of this comment claimed it was
  // ("the branch that still works... invisible until Instagram tightened the gate"). Measured live
  // 2026-07-20 against this exact URL: an empty User-Agent gets HTTP 302 to
  // facebook.com/unsupportedbrowser, whose body carries zero data-media-type. So the typo fails
  // the content assertion loudly and immediately — the SAME failure mode as TikTok, not the
  // opposite one. The test earns its keep either way; only the reasoning was wrong, and it was
  // wrong in the direction that would let a reader conclude a missing UA is survivable here.
  assert.equal(calls[0].init.headers['user-agent'], INSTAGRAM_UA)
})

test('a body that fails the assertion is classified, never thrown, at the I/O boundary too', async () => {
  // pageOutcome is tested pure above; this pins that fetchInstagram actually ROUTES its response
  // through it rather than returning ok:true on whatever came back. The decoy is the body to do it
  // with, because it is the one that arrives at HTTP 200 with a valid content-type.
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(DECOY)
  try {
    const got = await fetchInstagram({ p: 'ig', kind: 'p', code: 'C79gQqLpkul' })
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'assert_fail')
  } finally {
    globalThis.fetch = real
  }
})

test('A STORY REF NEVER REACHES THE NETWORK — there is no /embed/captioned/ for one', async () => {
  // PostRef has declared {p:'ig', kind:'story', user, id} since Phase 1 and refKey/parseRefKey
  // round-trip it, so a story ref can arrive from a STALE CACHE ENTRY even though Task 2's router
  // never mints one. It has no `code` at all, so unguarded interpolation would fetch
  // https://www.instagram.com/p/undefined/embed/captioned/ — the same fabricated URL the
  // normalizer's ref guard exists to prevent, except this one is an outbound request.
  const real = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => { called++; return new Response(SINGLE) }
  try {
    const got = await fetchInstagram({ p: 'ig', kind: 'story', user: 'nasajpl', id: '123' })
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'assert_fail')
  } finally {
    globalThis.fetch = real
  }
  assert.equal(called, 0, 'no request may be made for a shape this endpoint does not serve')
})

// ── Task 4 FIX ROUND: three holes a reviewer demonstrated in the shipped fetcher ──────────────

/**
 * A stub `fetch` that records every call, restores the real one, and never touches the network.
 * Factored out because all three tests below need it and each hand-rolled copy is another
 * try/finally that can leak a stubbed global into the rest of the suite.
 */
const withStubbedFetch = async (body, fn) => {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(body)
  }
  try {
    await fn(calls)
  } finally {
    globalThis.fetch = real
  }
  return calls
}

test('THE URL INVARIANT HOLDS OVER EVERY HOSTILE CODE — `..` and `.` are NOT stopped by encodeURIComponent', async () => {
  // THE BUG THIS PINS: encodeURIComponent escapes `/` but NOT `.`, so the previous test's single
  // sample ('../../evil') was exactly the case the guard handles and the invariant it asserted —
  // "the code must never escape /p/{code}/embed/captioned/" — was false for the two shortest
  // traversal codes there are. Measured on the shipped fetcher:
  //
  //   '..'  -> https://www.instagram.com/p/../embed/captioned/  => real path /embed/captioned/
  //   '.'   -> https://www.instagram.com/p/./embed/captioned/   => real path /p/embed/captioned/
  //
  // AND IT IS REACHABLE FROM A PUBLIC URL. The permalink path cannot deliver it — WHATWG URL
  // normalises `%2e%2e` before route() ever sees it — but the Mastodon-spoof route can:
  // encodeStatusId is a numeric encoding of an ARBITRARY key and parseRefKey percent-decodes each
  // component, so the key `ig:p:%2e%2e` round-trips to {p:'ig',kind:'p',code:'..'} through
  // /api/v1/statuses/{digits}, /users/{h}/statuses/{id} and /_oembed/{id} alike. Both escaped
  // paths were fetched live 2026-07-20 and answer HTTP 200 with 597-702KB of markerless shell, so
  // no wrong body reaches a client — the cost is a fabricated ~700KB upstream request per hit made
  // with OUR egress on a path we never meant to request, plus assert_fail pollution on the very
  // counter whose >10% alert this ok/reason split exists to make readable.
  //
  // Asserted over the whole table rather than over calls[0], which is how the single-sample
  // version passed while the invariant it named was false.
  const hostile = ['..', '.', '../../evil', '../..', './.', '%2e%2e', '..%2f..', '', '.'.repeat(40)]
  const calls = await withStubbedFetch('<html>not the point</html>', async () => {
    for (const code of hostile) await fetchInstagram({ p: 'ig', kind: 'p', code })
  })
  for (const { url } of calls) {
    const u = new URL(url)
    assert.equal(u.host, 'www.instagram.com', url)
    // `u.pathname` is the NORMALISED path — the one the wire actually carries — so a `..` that
    // collapsed during parsing shows up here even though the template string looked pinned.
    assert.match(u.pathname, /^\/p\/[^/]+\/embed\/captioned\/$/, `${url} escaped /p/{code}/embed/captioned/`)
  }
})

test('A CODE THAT CANNOT BE A SHORTCODE NEVER REACHES THE NETWORK', async () => {
  // The other half: a segment that is not shortcode-shaped has no right answer upstream, so the
  // cheapest correct behaviour is to not spend an egress request discovering that. Instagram
  // shortcodes are base64url — the three live fixtures are C79gQqLpkul, DaQ5CPTki4E, Da5ynsiuAZ_ —
  // and every hostile code above fails that shape, so the guard costs real traffic nothing.
  const calls = await withStubbedFetch('<html>not the point</html>', async calls => {
    for (const code of ['..', '.', '../../evil', '', 'a/b', 'a?b', 'a#b', 'a b']) {
      const got = await fetchInstagram({ p: 'ig', kind: 'p', code })
      assert.equal(got.ok, false, code)
      assert.equal(got.reason, 'assert_fail', code)
    }
    assert.equal(calls.length, 0, 'not one upstream request may be spent on a non-shortcode')
  })
  assert.equal(calls.length, 0)
})

test('THE FETCHER ACTUALLY RETURNS THE BODY — the success path, which nothing asserted', async () => {
  // THE BUG THIS PINS: every fetchInstagram test shipped in Task 4 asserted a FAILURE path — the
  // traversal test discards the return value, the decoy test asserts ok:false, the story test
  // asserts ok:false. So the only I/O function in the file had NO test that it ever returns
  // ok:true, and two mutations that make it never succeed passed all 457 tests:
  //
  //   A  `await res.text(); return { ok: false, reason: 'assert_fail' }`   -> 46/46 green
  //   B  `pageOutcome(res)` instead of `pageOutcome(await res.text())`     -> 46/46 green
  //
  // B is the realistic one — forgetting to read the body — and because hasEmbedPost type-guards
  // non-strings, EVERY Instagram post on the platform would return assert_fail: the platform 100%
  // dead AND the counter that means "Instagram changed and we are blind" pegged at 100%, with a
  // fully green suite. Nothing later in the plan catches it either: Task 5 stubs fetch only with
  // the decoy and the gone page (both correctly assert_fail), and the render/media tests bypass
  // the fetcher through the fetchPost dep override.
  for (const [name, body] of Object.entries({ SINGLE, CAROUSEL, REEL })) {
    await withStubbedFetch(body, async () => {
      const got = await fetchInstagram({ p: 'ig', kind: 'p', code: 'C79gQqLpkul' })
      assert.equal(got.ok, true, name)
      assert.equal(got.html, body, `${name}: the body must reach the normalizer byte-for-byte`)
    })
  }
})

test('A TRUNCATED PAGE IS assert_fail — a body that stopped early is not a page that arrived', () => {
  // THE BUG THIS PINS, and it is the scar src/platforms/tiktok/fetch.ts already carries in
  // writing: hasEmbedPost's markup half is `MEDIA_TYPE.test(html)`, a bare regex on an attribute
  // that sits ~27% into the document and therefore survives almost any cut. Measured on the real
  // fixtures, of the 99 truncations of each, the count that classified as "the page arrived":
  //
  //   single 72/99, reel 78/99, carousel 87/99
  //
  // And the single-image case does not merely miscount — it MINTS A POST. A single-image page cut
  // to 30% classified ok:true and normalized to a complete-looking Post: one media entry, a real
  // author, and an EMPTY CAPTION. worker.ts caches any truthy Post for POST_TTL, so that
  // caption-less post would be served to every client for the full TTL. Cut to 29% it normalized
  // to a Post with media:[] — an embed with an author and no image at all.
  //
  // TikTok's shortlinkOutcome docstring names this exact mistake ("a marker-only substring test is
  // what shipped first, and it let a TRUNCATED response through as 'the page arrived'"), and the
  // Instagram suite had no truncation case anywhere.
  for (const [name, body] of Object.entries({ SINGLE, CAROUSEL, REEL })) {
    for (const pct of [10, 29, 30, 50, 90, 99]) {
      const cut = body.slice(0, Math.floor((body.length * pct) / 100))
      const got = pageOutcome(cut)
      assert.equal(got.ok, false, `${name} truncated to ${pct}% must not classify as arrived`)
      assert.equal(got.reason, 'assert_fail', `${name}@${pct}%`)
    }
    // The WHOLE document still passes — the completeness check must not cost a healthy page.
    assert.equal(pageOutcome(body).ok, true, `${name}: intact must still be ok`)
  }
  // And the harm the truncation caused is gone at the source: no truncated single-image body can
  // reach the normalizer to become a cacheable caption-less Post.
  const cut30 = SINGLE.slice(0, Math.floor(SINGLE.length * 0.3))
  assert.equal(normalizeInstagram(cut30, SINGLE_REF)?.text, '', 'fixture sanity: it really did mint a caption-less Post')
  assert.equal(pageOutcome(cut30).ok, false, 'so the fetcher must never hand that body on')
})

// ── gated-post scheme: Instagram PRIVATE (🔒) detection off the FULL /p/{code}/ page. The embed
// surface cannot carry it — a private post is byte-identical to a deleted one there (measured
// 2026-07-21 with two real private posts + a fabricated deleted code) — so this reads the fallback
// full page, where a private wall names the account. Egress-confirmed 2026-07-21. It runs ONLY after
// the embed already failed, so a public post (embed succeeds) never reaches it, and the data-media-type
// guard makes a false positive on anything carrying media impossible.

test('gated-post scheme: instagramPrivateGate fires on username-with-no-media, never otherwise', () => {
  // A private wall: the account handle server-rendered, no media.
  assert.equal(
    instagramPrivateGate('<html><body><script>{"user":{"username":"fixture_user_1","is_private":true}}</script></body></html>'),
    'private', 'username present + no data-media-type -> private')
  // A deleted/gone full page: neither a username nor media.
  assert.equal(instagramPrivateGate('<html><body>Sorry, this page is not available.</body></html>'), undefined,
    'no username -> not private (a deleted post falls through to generic)')
  // Media present WINS: a page that rendered media is never a private wall, whatever else it carries.
  assert.equal(
    instagramPrivateGate('<div data-media-type="GraphImage"></div><script>{"username":"someone"}</script>'),
    undefined, 'data-media-type present -> never private, even with a username')
  // Totality over junk.
  for (const v of [null, undefined, 42, {}, [], '']) assert.equal(instagramPrivateGate(v), undefined, `${JSON.stringify(v)} -> undefined`)
  // An empty username string is not a handle.
  assert.equal(instagramPrivateGate('<script>{"username":""}</script>'), undefined, 'empty username is not a signal')
})

test('gated-post scheme: instagramPrivateGate NEVER fires on any embed-surface content (no-regression)', () => {
  // Every embed fixture is what the PRIMARY surface returns; the private gate must be silent on all of
  // them. SINGLE/CAROUSEL/REEL carry data-media-type (media wins); DECOY carries no username.
  for (const [name, body] of [['single', SINGLE], ['carousel', CAROUSEL], ['reel', REEL], ['decoy', DECOY]])
    assert.equal(instagramPrivateGate(body), undefined, `${name} embed content must never read as private`)
})
