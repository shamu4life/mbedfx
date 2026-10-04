import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createdAtFromCode, hasThreadsSSR, normalizeThreads, threadsHasPost } from '../src/platforms/threads/normalize.ts'
import { toMastodonStatus } from '../src/render/mastodon.ts'
import { readFileSync } from 'node:fs'
import { renderPost } from '../src/render/discord.ts'
import { fetchThreads } from '../src/platforms/threads/fetch.ts'
import { cardVerdict } from '../src/smoke.ts'

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
  /**
   * BOTH MODES, 2026-09-11. This test's real subject is the NORMALIZER — that a Threads carousel
   * video reaches the renderer as kind:'video'+poster rather than pre-flattened to an image — and
   * that subject is mode-independent. What the renderer then does with it is the mode's business, so
   * both answers are pinned here, and either one going wrong still catches a normalizer that
   * flattened too early: a pre-flattened child would produce two stills under BOTH modes and no
   * promotion under either.
   */
  const s = toMastodonStatus(post, 'https://staging.megapenispoopenfarten.sex', 'stills')
  // The exact marker the IG mixed-carousel path emits — now reached by Threads because the video
  // child reaches the renderer as kind:'video'+poster rather than being pre-flattened to an image.
  assert.ok(s.content.includes('\u{1F3AC} Contains video — tap to watch'), `expected the marker in: ${s.content}`)
  // Both slides render (the video flattened to its poster still), not just the first type.
  assert.equal(s.media_attachments.length, 2, 'both carousel slides render')
  assert.ok(s.media_attachments.every(a => a.type === 'image'), 'the video slide is flattened to an image poster still')

  // AND UNDER THE DEFAULT: the video slide leads as a real player, the image trails as a still, and
  // the note names what is behind it. One picture is hidden and no other video, so the note is the
  // pictures-only spelling — which is what makes this worth asserting on a TWO-item carousel: it is
  // the smallest gallery that can produce a note at all.
  const v = toMastodonStatus(post, 'https://staging.megapenispoopenfarten.sex', 'videos')
  assert.deepEqual(v.media_attachments.map(a => a.type), ['video', 'image'], 'the video slide is promoted and leads')
  assert.deepEqual(v.media_attachments.map(a => a.id), ['1', '0'], 'reordered output, SOURCE ids')
  assert.ok(v.content.endsWith('\u{1F5BC} More pictures in the post'), `expected the pictures note in: ${v.content}`)
  assert.ok(!v.content.includes('\u{1F3AC}'), 'and never both markers on one card')
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

/**
 * REAL PAGES, 2026-10-04. Everything above builds its SSR page by hand, under the OLD preloader name and
 * without the real page's outer `{"require":[["ScheduledServerJS",…,{"__bbox":{"require":…` wrapper. That
 * is how a rename went unnoticed: no test had ever seen a page Threads actually served. These two are cut
 * from pages captured that day from CONTAINER egress with fetch.ts's SSR_HEADERS (not a Worker):
 *
 *  - threads-ssr-carousel.html: @bradandthegoat/post/DeEFGTkCLxz, the ten-slide carousel the owner reported
 *    collapsing to one picture.
 *  - threads-ssr-video.html: @bisniscom/post/DbkwmbMEt6u, the smoke row's video post.
 *
 * WHAT WAS KEPT: the page's own og:* head, one NON-data mention of the Target preloader name (the page
 * lists it in expectedPreloaders, followed by "queryID" instead of a `{"__bbox"`, and the extractor must
 * skip it), and the Target data script verbatim, outer wrapper, `\/` escapes, `\uXXXX` escapes and all.
 * WHAT WAS CHANGED: every query-string VALUE on a Meta CDN url is x-filled at equal length (the oh/oe
 * signatures expire and add nothing to a pure test). WHAT WAS DROPPED: the Upward, Downward and
 * LoggedOutRelatedPosts scripts, which carry replies and posts by other people. The Target block names
 * one account, the post's author.
 */

const CAROUSEL = readFileSync(new URL('./fixtures/threads-ssr-carousel.html', import.meta.url), 'utf8')
const VIDEO = readFileSync(new URL('./fixtures/threads-ssr-video.html', import.meta.url), 'utf8')
const CAROUSEL_REF = { p: 'th', code: 'DeEFGTkCLxz' }
const VIDEO_REF = { p: 'th', code: 'DbkwmbMEt6u' }
const ORIGIN = 'https://mbedfx.app'

test('THE 2026-10-04 PAGE IS READ: a real carousel yields every slide, the counts, the avatar and taken_at', () => {
  /**
   * The defect this pins: Threads moved the post to `BarcelonaPostPageTargetQueryRelayPreloader_<hash>`,
   * neither name SSR_PRELOADERS knew appeared on the page, and every Threads post fell to the OG scrape.
   * That fallback can only make one image, and the one it makes is Threads' rendered share card, so the
   * reported carousel became one unscrollable picture with the counts baked into it.
   */
  assert.equal(hasThreadsSSR(CAROUSEL), true)
  const post = normalizeThreads({ source: 'ssr', html: CAROUSEL }, CAROUSEL_REF)
  assert.ok(post, 'the real page must build a Post on the rich path')
  assert.equal(post.media.length, 10, 'all ten slides, not one share card')
  assert.ok(post.media.every(m => m.kind === 'image'))
  assert.ok(post.media.every(m => m.w > 0 && m.h > 0), 'each slide carries its real dimensions')
  assert.ok(post.media.every(m => /\/t51\./.test(m.url)), 'real slides are t51; the share card is t39.92108-6')
  assert.deepEqual(post.counts, { likes: 4316, replies: 21, reposts: 2003 })
  // taken_at, to the second. The fallback can only estimate from the shortcode (createdAtFromCode),
  // which lands about a minute off and carries milliseconds no real timestamp has.
  assert.equal(post.createdAt.toISOString(), '2026-10-04T07:18:02.000Z')
  assert.ok(post.author.avatar, 'the avatar only exists on the rich path')
  assert.equal(post.author.handle, 'bradandthegoat')
  assert.equal(post.canonical, 'https://www.threads.com/@bradandthegoat/post/DeEFGTkCLxz')
  assert.ok(post.text.startsWith('not everything is urgent'))
})

test('A CAROUSEL IS A GALLERY IN THE ACTIVITY DOCUMENT, NOT ONE PICTURE, in every gallery mode', () => {
  /**
   * The surface the owner actually looked at: a post with media renders from the Mastodon-shaped status,
   * so this is where "one unscrollable image" lived. Ten image attachments with their source ids, under
   * the default and under both explicit modes (an all-image gallery has no video for /v or /p to pick).
   */
  const post = normalizeThreads({ source: 'ssr', html: CAROUSEL }, CAROUSEL_REF)
  for (const mode of [undefined, 'videos', 'stills']) {
    const s = toMastodonStatus(post, ORIGIN, mode)
    assert.equal(s.media_attachments.length, 10, `mode ${mode}: ten attachments`)
    assert.ok(s.media_attachments.every(a => a.type === 'image'), `mode ${mode}: all images`)
    assert.deepEqual(s.media_attachments.map(a => a.id), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
  }
})

test('A REAL THREADS VIDEO PLAYS AGAIN: one video with its poster, and og:video in the Discord head', () => {
  /**
   * The same rename cost every Threads video its player. The fallback's og:image for this post is the
   * share card with a play glyph baked into the picture, which looks playable and is not.
   */
  const post = normalizeThreads({ source: 'ssr', html: VIDEO }, VIDEO_REF)
  assert.ok(post)
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'video')
  assert.equal(post.media[0].w, 640)
  assert.equal(post.media[0].h, 1136)
  assert.ok(post.media[0].poster, 'a video keeps its cover as the poster')
  assert.equal(post.createdAt.toISOString(), '2026-08-03T10:20:46.000Z')
  return renderPost(post, 'discord', ORIGIN).text().then(html => {
    assert.match(html, /<meta property="og:video" content="https:\/\/mbedfx\.app\/_media\/th%3ADbkwmbMEt6u\/0\.mp4"/)
  })
})

test('ONLY THE TARGET PRELOADER IS READ: the same block under a sibling\'s name is not the post', () => {
  /**
   * The page carries sibling preloaders in the same `__bbox.result` envelope, each holding a DIFFERENT
   * post: Upward (the parent chain), Downward (replies), LoggedOutRelatedPosts (other posts, the same
   * author's other carousels among them) and, on an invalid code, LoggedOutFeedContainer (strangers'
   * posts). Measured 2026-10-04: a wildcard match plus a walk picked a stranger's reply on one page and
   * the author's OTHER carousel on another, a confidently wrong card. Renaming the Target block to each
   * sibling shows the extractor goes by the exact name, not by the shape it finds behind it.
   */
  for (const sibling of [
    'BarcelonaPostPageUpwardQueryRelayPreloader_',
    'BarcelonaPostPageDownwardQueryRelayPreloader_',
    'BarcelonaLoggedOutRelatedPostsQueryRelayPreloader_',
    'BarcelonaLoggedOutFeedContainerQueryRelayPreloader_',
  ]) {
    const html = CAROUSEL.replaceAll('BarcelonaPostPageTargetQueryRelayPreloader_', sibling)
    assert.equal(hasThreadsSSR(html), false, `${sibling} must not be read as the post`)
    assert.equal(normalizeThreads({ source: 'ssr', html }, CAROUSEL_REF), null)
  }
})

test('fetchThreads TAKES THE RICH PATH ON THE REAL PAGE, in one request, without the two OG fetches', async () => {
  /**
   * The I/O half of the same defect. With the Target name unknown, hasThreadsSSR said no to a perfectly
   * good page and fetchThreads spent two more requests on the bot-UA OG pages to build a worse card.
   */
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input, init) => {
    seen.push(init?.headers?.['user-agent'] ?? '')
    return new Response(CAROUSEL, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  try {
    const got = await fetchThreads(CAROUSEL_REF)
    assert.equal(got.ok, true)
    assert.equal(got.source, 'ssr')
    assert.equal(seen.length, 1, 'one request; the Discordbot and facebookexternalhit fallbacks never ran')
    assert.match(seen[0], /Chrome/, 'and it was the SSR request, which carries the browser UA')
  } finally {
    globalThis.fetch = real
  }
})

test('THE th SMOKE ROW TELLS THE TWO PATHS APART: the real page is ok, the OG fallback is no-video', async () => {
  /**
   * Why the smoke row stayed green through the outage: a fallback card still has og:title and the
   * activity link, which is all the default verdict asks. With `expect: 'video'` the row's verdict turns
   * on og:video, which on this video post only the SSR path can produce (the fallback builds images
   * only). Both heads below come out of the real normalizer and the real renderer, not hand-written tags.
   */
  const rich = normalizeThreads({ source: 'ssr', html: VIDEO }, VIDEO_REF)
  const richHead = await renderPost(rich, 'discord', ORIGIN).text()
  assert.equal(cardVerdict(richHead, 'video'), 'ok')

  const fallback = normalizeThreads({
    source: 'html',
    media: mediaPage('Bisnis.com (&#064;bisniscom) on Threads', 'https://scontent.xx.fbcdn.net/v/t39.92108-6/share.jpg'),
    text: textPage('Bisnis.com (&#064;bisniscom) on Threads', 'a caption'),
  }, VIDEO_REF)
  const fallbackHead = await renderPost(fallback, 'discord', ORIGIN).text()
  assert.equal(cardVerdict(fallbackHead), 'ok', 'the default verdict cannot see the difference; that was the blind spot')
  assert.equal(cardVerdict(fallbackHead, 'video'), 'no-video')
})
