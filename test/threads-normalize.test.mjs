import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createdAtFromCode, hasThreadsSSR, normalizeThreads, threadsHasPost } from '../src/platforms/threads/normalize.ts'
import { toMastodonStatus } from '../src/render/mastodon.ts'

// An SSR page embeds the post as an Instagram media dict under a RelayPrefetchedStreamCache preloader
// with a stable prefix + rotating hash. This mirrors the real wrapper closely enough to exercise the
// prefix regex, the string-aware brace scan, and the media path.
const ssrPage = (media) =>
  `<html><body><script type="application/json" data-sjs>` +
  `{"require":[["RelayPrefetchedStreamCache","next",[],` +
  `["adp_BarcelonaPermalinkMobilePostColumnPageQueryRelayPreloader_9f3a2b",` +
  `{"__bbox":{"result":{"data":{"media":${JSON.stringify(media)}}}}}]]]}</script></body></html>`

const mediaDict = (over = {}) => ({
  code: 'DDYEM_foiI1', taken_at: 1733786843, media_type: 1,
  user: { username: 'pmestevez', full_name: 'Pablo Estevez', profile_pic_url: 'https://cdn.example/pp.jpg' },
  caption: { text: 'hello' }, like_count: 4,
  text_post_app_info: { direct_reply_count: 1, repost_count: 2 },
  image_versions2: { candidates: [{ url: 'https://cdn.example/img.jpg', width: 720, height: 720 }] },
  ...over,
})

// Small literal meta-tag pages, not real captures — the two-UA split is the whole point, so the
// fixtures mirror it: the "media" (Discordbot) page carries og:image = the POST media, the "text"
// (fbhit) page carries name="description" = the caption. `&#064;` is how Threads spells '@' in
// og:title, and `&amp;` is in every CDN url — both must decode.
const mediaPage = (title, image) =>
  `<html><head>` +
  `<meta property="og:type" content="article" />` +
  `<meta property="og:title" content="${title}" />` +
  `<meta property="og:image" content="${image}" />` +
  `</head></html>`

const textPage = (title, desc) =>
  `<html><head>` +
  `<meta property="og:type" content="article" />` +
  `<meta property="og:title" content="${title}" />` +
  `<meta name="description" content="${desc}" />` +
  `</head></html>`

const CODE = 'DDYEM_foiI1'
const TITLE = 'Pablo Estevez (&#064;pmestevez) on Threads'
const IMG = 'https://scontent.xx.fbcdn.net/v/t39.92108-6/img.jpg?a=1&amp;b=2'

test('threadsHasPost keys on og:type=article, the one liveness marker', () => {
  assert.equal(threadsHasPost(mediaPage(TITLE, IMG)), true)
  // A deleted/private/profile page renders the shell with no article type.
  assert.equal(threadsHasPost('<html><head><meta property="og:type" content="profile" /></head></html>'), false)
  assert.equal(threadsHasPost('<html><head><title>nothing</title></head></html>'), false)
  assert.equal(threadsHasPost(null), false)
  assert.equal(threadsHasPost(undefined), false)
})

test('createdAtFromCode derives the timestamp from the snowflake (shift 23 + IG epoch)', () => {
  // pmestevez/DDYEM_foiI1 -> 2024-12-09 (the Threads oEmbed launch window); verified against the
  // decoded id 3519581593786262069.
  const d = createdAtFromCode(CODE)
  assert.equal(d.toISOString(), '2024-12-09T23:27:23.032Z')
  // nike/CuaNNJVvRga -> 2023-07-07 (Threads launch).
  assert.equal(createdAtFromCode('CuaNNJVvRga').toISOString(), '2023-07-07T20:25:15.140Z')
  // A non-base64url char is refused rather than silently mis-decoded.
  assert.equal(createdAtFromCode('has a space'), null)
})

test('normalizeThreads builds a Post from the two OG pages, decoding entities', () => {
  const post = normalizeThreads(
    { source: 'html', media: mediaPage(TITLE, IMG), text: textPage(TITLE, 'the caption &amp; more') },
    { p: 'th', code: CODE },
  )
  assert.ok(post)
  // Author name + handle parsed out of og:title, with the &#064; decoded to '@'.
  assert.equal(post.author.name, 'Pablo Estevez')
  assert.equal(post.author.handle, 'pmestevez')
  assert.equal(post.author.url, 'https://www.threads.com/@pmestevez')
  // Canonical is rebuilt from the PARSED handle, not the pasted (decorative) username.
  assert.equal(post.canonical, 'https://www.threads.com/@pmestevez/post/DDYEM_foiI1')
  // Caption comes from the fbhit page's name=description, with entities decoded.
  assert.equal(post.text, 'the caption & more')
  // The post media (Discord page og:image) is one image entry, with its &amp; decoded.
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'image')
  assert.equal(post.media[0].url, 'https://scontent.xx.fbcdn.net/v/t39.92108-6/img.jpg?a=1&b=2')
  assert.equal(post.createdAt.toISOString(), '2024-12-09T23:27:23.032Z')
  assert.equal(post.ref.p, 'th')
})

test('normalizeThreads returns null on a page with no og:title, never a half-built Post', () => {
  assert.equal(
    normalizeThreads({ source: 'html', media: '<html></html>', text: '<html></html>' }, { p: 'th', code: CODE }),
    null,
  )
})

test('normalizeThreads is a no-op on the wrong platform and an unknown source', () => {
  assert.equal(normalizeThreads({ source: 'html', media: mediaPage(TITLE, IMG), text: '' }, { p: 'x', id: '1' }), null)
  assert.equal(normalizeThreads({ source: 'graphql', data: {} }, { p: 'th', code: CODE }), null)
})

test('SSR: normalizeThreads reads counts, timestamp, avatar and an image from the media dict', () => {
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict()) }, { p: 'th', code: 'DDYEM_foiI1' })
  assert.ok(post)
  assert.equal(post.author.name, 'Pablo Estevez')
  assert.equal(post.author.handle, 'pmestevez')
  assert.equal(post.author.avatar, 'https://cdn.example/pp.jpg')
  assert.equal(post.text, 'hello')
  assert.deepEqual(post.counts, { likes: 4, replies: 1, reposts: 2 })
  assert.equal(post.createdAt.toISOString(), '2024-12-09T23:27:23.000Z')
  assert.deepEqual(post.media, [{ kind: 'image', url: 'https://cdn.example/img.jpg', w: 720, h: 720 }])
})

test('SSR: a single video post is a playable video (progressive mp4, poster = cover) — like an IG reel', () => {
  // video_versions[0].url is a PROGRESSIVE mp4 on cdninstagram (same as Instagram), so a single video
  // plays: the renderer advertises og:video and the /_media/ route 302s to the signed url for Discord's
  // proxy to fetch. Poster = the image_versions2 cover.
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict({
    media_type: 2, video_versions: [{ url: 'https://cdn.example/v.mp4', width: 720, height: 1280 }],
    image_versions2: { candidates: [{ url: 'https://cdn.example/cover.jpg', width: 720, height: 1280 }] },
  })) }, { p: 'th', code: 'DDYEM_foiI1' })
  assert.equal(post.media.length, 1)
  assert.deepEqual(post.media[0], { kind: 'video', url: 'https://cdn.example/v.mp4', w: 720, h: 1280, poster: 'https://cdn.example/cover.jpg' })
})

test('SSR: a mixed carousel keeps the video child as kind:video+poster so the renderer flattens + marks it like IG', () => {
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict({
    media_type: 8,
    carousel_media: [
      { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn.example/1.jpg', width: 1, height: 1 }] } },
      { media_type: 2, video_versions: [{ url: 'https://cdn.example/2.mp4', width: 2, height: 2 }],
        image_versions2: { candidates: [{ url: 'https://cdn.example/2.jpg', width: 2, height: 2 }] } },
    ],
  })) }, { p: 'th', code: 'DDYEM_foiI1' })
  assert.equal(post.media.length, 2)
  assert.equal(post.media[0].kind, 'image')
  assert.equal(post.media[0].url, 'https://cdn.example/1.jpg')
  // The video child stays kind:'video' WITH its cover as poster — the renderer's multi-item flatten
  // converts it to that poster still AND adds the "🎬 Contains video" marker, identical to Instagram.
  // The DASH url rides along but is never served (the flatten links the poster).
  assert.deepEqual(post.media[1], { kind: 'video', url: 'https://cdn.example/2.mp4', w: 2, h: 2, poster: 'https://cdn.example/2.jpg' })
})

test('SSR end-to-end: a Threads mixed carousel gets the "Contains video" marker + all slides visible, same as IG', () => {
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict({
    text_post_app_info: { direct_reply_count: 0 },
    media_type: 8,
    carousel_media: [
      { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn.example/1.jpg', width: 1, height: 1 }] } },
      { media_type: 2, video_versions: [{ url: 'https://cdn.example/2.mp4', width: 2, height: 2 }],
        image_versions2: { candidates: [{ url: 'https://cdn.example/2.jpg', width: 2, height: 2 }] } },
    ],
  })) }, { p: 'th', code: 'DDYEM_foiI1' })
  const s = toMastodonStatus(post, 'https://staging.megapenispoopenfarten.sex')
  // The exact marker the IG mixed-carousel path emits — now reached by Threads because the video
  // child reaches the renderer as kind:'video'+poster rather than being pre-flattened to an image.
  assert.ok(s.content.includes('\u{1F3AC} Contains video — tap to watch'), `expected the marker in: ${s.content}`)
  // Both slides render (the video flattened to its poster still), not just the first type.
  assert.equal(s.media_attachments.length, 2, 'both carousel slides render')
  assert.ok(s.media_attachments.every(a => a.type === 'image'), 'the video slide is flattened to an image poster still')
})

test('SSR: a degenerate single-child carousel is one playable video (renderer flattens only multi-item)', () => {
  // The renderer flattens only a MULTI-item carousel (galleryHasVideo, usableCount > 1). A lone video —
  // even labelled a carousel — is a single item, so it plays: kind:'video', og:video. No dead player,
  // because the url is a progressive mp4 (Instagram's CDN), not the DASH an earlier note assumed.
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict({
    media_type: 8,
    carousel_media: [
      { media_type: 2, video_versions: [{ url: 'https://cdn.example/v.mp4', width: 9, height: 9 }],
        image_versions2: { candidates: [{ url: 'https://cdn.example/v.jpg', width: 9, height: 9 }] } },
    ],
  })) }, { p: 'th', code: 'DDYEM_foiI1' })
  assert.deepEqual(post.media, [{ kind: 'video', url: 'https://cdn.example/v.mp4', w: 9, h: 9, poster: 'https://cdn.example/v.jpg' }])
})

test('SSR: the brace scan survives a caption full of braces, quotes and backslashes', () => {
  // The whole reason extraction is a string-aware scan and not a regex: a caption like this would
  // close the object early under any naive brace match.
  const nasty = 'a } b { c "quoted" \\ end } }}'
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict({ caption: { text: nasty } })) }, { p: 'th', code: 'DDYEM_foiI1' })
  assert.ok(post, 'extraction must not be derailed by braces/quotes inside a string')
  assert.equal(post.text, nasty)
})

test('SSR: a quoted post is attached at depth 1 and never recurses further', () => {
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict({
    text_post_app_info: { direct_reply_count: 0, share_info: { quoted_post: mediaDict({
      code: 'QUOTED0code', caption: { text: 'the quoted one' },
      user: { username: 'someoneelse', full_name: 'Someone Else' },
    }) } },
  })) }, { p: 'th', code: 'DDYEM_foiI1' })
  assert.ok(post.quote)
  assert.equal(post.quote.author.handle, 'someoneelse')
  assert.equal(post.quote.text, 'the quoted one')
  assert.equal(post.quote.quote, undefined, 'depth-1: the quote has no quote of its own')
})

test('SSR: hasThreadsSSR is true only when a media dict is actually extractable', () => {
  assert.equal(hasThreadsSSR(ssrPage(mediaDict())), true)
  // A page with the shell but no media (deleted/private/age) -> false -> the fetch falls back / fails.
  assert.equal(hasThreadsSSR('<html><body>nothing here</body></html>'), false)
  assert.equal(hasThreadsSSR(null), false)
})

test('SSR: a payload with no extractable media returns null (deleted/private -> loud-default)', () => {
  assert.equal(normalizeThreads({ source: 'ssr', html: '<html>no media</html>' }, { p: 'th', code: 'DDYEM_foiI1' }), null)
})

test('normalizeThreads tolerates a post with no image (text-only) — an empty media list, not null', () => {
  const post = normalizeThreads(
    { source: 'html', media: `<meta property="og:type" content="article" /><meta property="og:title" content="${TITLE}" />`,
      text: textPage(TITLE, 'just text') },
    { p: 'th', code: CODE },
  )
  assert.ok(post)
  assert.deepEqual(post.media, [])
  assert.equal(post.text, 'just text')
})
