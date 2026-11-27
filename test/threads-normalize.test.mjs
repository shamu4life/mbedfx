import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeFromId, createdAtFromCode, hasThreadsSSR, normalizeThreads, threadsHasPost } from '../src/platforms/threads/normalize.ts'
import { deserializePost, serializePost } from '../src/cache.ts'
import { toMastodonStatus } from '../src/render/mastodon.ts'
import { readFileSync } from 'node:fs'
import { renderPost } from '../src/render/discord.ts'
import { fetchThreads } from '../src/platforms/threads/fetch.ts'
import { cardVerdict } from '../src/smoke.ts'
import { handle, liveFetchPost } from '../src/worker.ts'

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
// fixtures mirror it: the "media" (Discordbot) page carries og:image (Threads' rendered share card, measured
// 2026-10-04; called the POST media here before that), the "text"
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

/**
 * Threads' login wall as the OG fallback saw it in production on 2026-11-27: REBUILT from what
 * /_api/v1 returned, not captured (the fixture's own comment has the measurement and what is inferred).
 */
const LOGIN_WALL = readFileSync(new URL('./fixtures/threads-login-wall.html', import.meta.url), 'utf8')

test('threadsHasPost needs og:type=article AND an og:title naming the author, so a login wall is no post', () => {
  /**
   * REWRITTEN 2026-11-27. This was "threadsHasPost keys on og:type=article, the one liveness marker",
   * and pinned og:type as enough. It was enough on 2026-07-21, when a dead code got a shell with no
   * og:type at all. By 2026-11-27 Threads' login wall reached production through it: a deleted post
   * and a made-up code each drew a card by "Threads • Log in". The wall carries og:type=article (the
   * fetch gate could not have passed otherwise), so the type alone is now asserted to be NOT enough.
   */
  assert.equal(threadsHasPost(mediaPage(TITLE, IMG)), true)
  assert.equal(threadsHasPost(LOGIN_WALL), false, 'og:type=article with a brand title is not a post page')
  assert.match(LOGIN_WALL, /og:type" content="article"/, 'the fixture keeps the marker that let it through')
  // A title naming an author is not enough without the type, and the type is not enough without it.
  assert.equal(threadsHasPost(`<meta property="og:title" content="${TITLE}" />`), false)
  assert.equal(threadsHasPost('<meta property="og:type" content="article" /><meta property="og:title" content="Threads" />'), false)
  assert.equal(threadsHasPost('<meta property="og:type" content="article" />'), false)
  // A deleted/private/profile page as measured 2026-07-21: the shell with no article type.
  assert.equal(threadsHasPost('<html><head><meta property="og:type" content="profile" /></head></html>'), false)
  assert.equal(threadsHasPost('<html><head><title>nothing</title></head></html>'), false)
  assert.equal(threadsHasPost(null), false)
  assert.equal(threadsHasPost(undefined), false)
})

test('A LOGIN WALL IS NEVER A POST, and a date decoded from a code it did not vouch for never surfaces', () => {
  /**
   * The production card this prevents, measured 2026-11-27 05:04 UTC through /_api/v1 (Worker egress):
   * threads.com/@i/post/DbcSwYaEa9r, a deleted post, answered ok:true with author "Threads • Log in",
   * no handle, the wall's "Join Threads to share ideas…" as its text and a static asset as its picture.
   * The made-up ZTSw2mYwR answered the same with createdAt 2011-09-03T16:56:37.702Z, decoded from a
   * code nobody minted. buildFromHtml used the title whole when it was not a byline, and decoded the
   * date before anything had said the code was a post.
   */
  for (const code of ['DbcSwYaEa9r', 'ZTSw2mYwR']) {
    assert.equal(normalizeThreads({ source: 'html', media: LOGIN_WALL, text: LOGIN_WALL }, { p: 'th', code }), null, code)
  }
  // The date production showed is what the code decodes to, which is why it had to be gated.
  assert.equal(createdAtFromCode('ZTSw2mYwR').toISOString(), '2011-09-03T16:56:37.702Z')
})

test('EACH OG FIELD COMES FROM A PAGE THAT IS THE POST: one walled page loses its field, never lends the wall\'s', () => {
  /**
   * The two OG pages are separate requests, so either can be the wall alone. Read as before, a walled
   * fbhit page made a real post's caption "Join Threads to share ideas…", and a walled Discordbot page
   * made its picture the wall's static asset.
   */
  const ref = { p: 'th', code: CODE }
  const textWalled = normalizeThreads({ source: 'html', media: mediaPage(TITLE, IMG), text: LOGIN_WALL }, ref)
  assert.equal(textWalled.author.handle, 'pmestevez')
  assert.equal(textWalled.text, '', 'no caption rather than the wall\'s')
  assert.equal(textWalled.media[0].url, 'https://scontent.xx.fbcdn.net/v/t39.92108-6/img.jpg?a=1&b=2')

  const mediaWalled = normalizeThreads({ source: 'html', media: LOGIN_WALL, text: textPage(TITLE, 'the caption') }, ref)
  assert.equal(mediaWalled.author.name, 'Pablo Estevez', 'the byline comes from the page that is the post')
  assert.equal(mediaWalled.text, 'the caption')
  assert.deepEqual(mediaWalled.media, [], 'no picture rather than the wall\'s static asset')

  // Two pages for one code naming two authors: one is not this post and nothing says which.
  const other = 'Someone Else (&#064;someoneelse) on Threads'
  assert.equal(normalizeThreads({ source: 'html', media: mediaPage(TITLE, IMG), text: textPage(other, 'x') }, ref), null)
})

test('fetchThreads ANSWERS assert_fail WHEN EVERY PAGE IS THE LOGIN WALL, the failure card\'s reason', async () => {
  // Every request answers the wall, the SSR one included: it carries no Target preloader, so the OG
  // fallback runs, and it is the fallback's gate that let the wall through before.
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input, init) => {
    seen.push(init?.headers?.['user-agent'] ?? '')
    return new Response(LOGIN_WALL, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  try {
    assert.deepEqual(await fetchThreads({ p: 'th', code: 'DbcSwYaEa9r' }), { ok: false, reason: 'assert_fail' })
    assert.equal(seen.length, 3, 'the SSR ask and both OG asks, each answered once')
  } finally {
    globalThis.fetch = real
  }
})

test('THE API ANSWERS fetch_fail FOR A DELETED THREADS POST, not a card by "Threads • Log in"', async () => {
  /**
   * The same request production answered wrongly on 2026-11-27, through the real handler and the real
   * fetcher, with fetch stubbed to answer the wall to every ask. No createdAt reaches the body.
   */
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(LOGIN_WALL, { status: 200, headers: { 'content-type': 'text/html' } })
  const points = []
  try {
    const env = { AE: { writeDataPoint(p) { points.push(p.blobs) } }, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off' }
    const deps = {
      cache: { async match() { return undefined }, async put() {} },
      fetchPost: liveFetchPost,
      resolveShortlink: async () => ({ kind: 'unresolved' }),
      resolveRedditShare: async () => null,
      resolveMetaShare: async () => null,
    }
    const target = 'https://www.threads.com/@i/post/DbcSwYaEa9r'
    const res = await handle(new Request(`https://mbedfx.app/_api/v1?url=${encodeURIComponent(target)}`), env, { waitUntil() {} }, deps)
    const raw = await res.text()
    const body = JSON.parse(raw)
    assert.equal(body.ok, false, raw)
    assert.equal(body.error.code, 'fetch_fail')
    assert.equal(body.error.platform, 'th')
    assert.doesNotMatch(raw, /Log in|Join Threads|createdAt/)
    assert.ok(points.some(b => b[0] === 'th' && b[1] === 'assert_fail'), 'counted as the gate refusing the page')
  } finally {
    globalThis.fetch = real
  }
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
  // The Discord page's og:image (the share card) is one image entry, with its &amp; decoded.
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
 * from pages captured that day with fetch.ts's SSR_HEADERS from the Claude Code dev sandbox (a non-Cloudflare cloud IP behind an HTTPS proxy), not a Worker and not the Cloudflare Container:
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
  // taken_at, exactly. The OG fallback can only estimate from the shortcode (createdAtFromCode): 0.4s off on
  // this post (07:18:02.401), 65s on the video one, and always with milliseconds no real timestamp has.
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

/**
 * TWO MORE PAGES, 2026-11-26: the carousel and reply examples from FixTweetBot's FIXERS.md (tested
 * 2026-11-08), which production drew with no pictures and with no reply marker. Each was fetched once
 * with SSR_HEADERS from a Linux workstation, not a Worker. They are cut differently from the two above.
 *
 * WHAT WAS KEPT: the Target data script's JSON envelope, verbatim, with the preloader's real name and
 * hash. The script tag lost its nonce and data-content-len attributes. Counts, taken_at and each
 * slide's width and height are the page's. One real identifier is kept: the reply's `reply_to_post_id`,
 * because the reply test needs a real id to show that it converts to the real parent's shortcode.
 * WHAT WAS CHANGED: the media dict is MINIMISED to the fields normalize.ts reads. Every handle, display
 * name and caption is a placeholder, and so are both posts' own shortcodes and every CDN filename. Each
 * CDN url keeps only its real path class (t51.*). Its host is the generic scontent.cdninstagram.com,
 * because the real one names the CDN edge nearest the machine that fetched the page, and its query
 * string is dropped.
 * WHAT WAS DROPPED: the og:* head, the Upward, Downward and LoggedOutRelatedPosts scripts, the linked
 * Instagram post's own caption, author and link preview, and the `pk` of every object.
 */
const LINKED = readFileSync(new URL('./fixtures/threads-ssr-linked-carousel.html', import.meta.url), 'utf8')
const LINKED_REF = { p: 'th', code: 'DtextPost00' }
const REPLY_PAGE = readFileSync(new URL('./fixtures/threads-ssr-reply.html', import.meta.url), 'utf8')
const REPLY_REF = { p: 'th', code: 'DreplyPost0' }
// The reply's parent as the captured page carried it in its Upward block: this code, with a pk equal
// to the fixture's reply_to_post_id, by the account reply_to_author names.
const PARENT_CODE = 'DfM7FCMk8ht'

test('A TEXT POST THAT LINKS AN INSTAGRAM CAROUSEL SHOWS ITS TEN SLIDES, not the avatar card', async () => {
  /**
   * The defect: the post is media_type 19 with no media of its own, and its slides sit under
   * text_post_app_info.linked_inline_media. mediaEntries read only the top level, so production
   * answered media: [] and Discord drew the avatar summary card, although Threads shows the slides
   * inline. Only the pictures are taken from the linked post: the byline, text and link stay the
   * Threads post's.
   */
  assert.equal(hasThreadsSSR(LINKED), true)
  const post = normalizeThreads({ source: 'ssr', html: LINKED }, LINKED_REF)
  assert.ok(post)
  assert.equal(post.media.length, 10, 'every slide of the linked carousel')
  assert.ok(post.media.every(m => m.kind === 'image' && m.w > 0 && m.h > 0), 'images with their real dimensions')
  assert.ok(post.media.every(m => /\/t51\./.test(m.url)), 'real slides, not the t39.92108-6 share card')
  assert.deepEqual(
    post.media.map(m => m.url.split('/').pop()),
    Array.from({ length: 10 }, (_, i) => `linked_slide_${String(i + 1).padStart(2, '0')}.jpg`),
    'in the order Threads lists them',
  )
  assert.equal(post.author.handle, 'threads_author')
  assert.equal(post.text, 'A text post that links an Instagram carousel.')
  assert.equal(post.canonical, 'https://www.threads.com/@threads_author/post/DtextPost00')
  assert.deepEqual(post.counts, { likes: 80, replies: 2, reposts: 4 })
  assert.equal(post.replyTo, undefined, 'is_reply is false here and both reply fields are null')

  // Discord draws a post with media from the activity document, so the slides have to arrive there.
  for (const mode of [undefined, 'videos', 'stills']) {
    const s = toMastodonStatus(post, ORIGIN, mode)
    assert.equal(s.media_attachments.length, 10, `mode ${mode}: ten attachments`)
    assert.ok(s.media_attachments.every(a => a.type === 'image'), `mode ${mode}: all images`)
  }
  const head = await renderPost(post, 'discord', ORIGIN).text()
  assert.match(head, /<meta name="twitter:card" content="summary_large_image"\/>/, 'the media head, not the avatar summary card')
})

test('A POST\'S OWN MEDIA WINS OVER A LINKED POST\'S, and a post with neither keeps an empty list', () => {
  /**
   * linked_inline_media is a fallback. A post with pictures of its own shows those, never another
   * account's in their place. And the fallback goes through mediaEntries, so a linked single picture
   * works as well as a linked carousel.
   */
  const ssr = (over) => normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict(over)) }, { p: 'th', code: 'DDYEM_foiI1' })
  const linkedCarousel = { media_type: 8, carousel_media: [
    { media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn.example/linked.jpg', width: 5, height: 5 }] } },
  ] }
  const own = ssr({ text_post_app_info: { direct_reply_count: 0, linked_inline_media: linkedCarousel } })
  assert.deepEqual(own.media, [{ kind: 'image', url: 'https://cdn.example/img.jpg', w: 720, h: 720 }])

  const textOnly = { media_type: 19, image_versions2: { candidates: [] } }
  const linkedOnly = ssr({ ...textOnly, text_post_app_info: { direct_reply_count: 0, linked_inline_media: linkedCarousel } })
  assert.deepEqual(linkedOnly.media, [{ kind: 'image', url: 'https://cdn.example/linked.jpg', w: 5, h: 5 }])

  const single = ssr({ ...textOnly, text_post_app_info: { direct_reply_count: 0, linked_inline_media: {
    media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn.example/one.jpg', width: 3, height: 4 }] },
  } } })
  assert.deepEqual(single.media, [{ kind: 'image', url: 'https://cdn.example/one.jpg', w: 3, h: 4 }])

  for (const linked of [null, undefined, 'not a dict']) {
    const none = ssr({ ...textOnly, text_post_app_info: { direct_reply_count: 0, linked_inline_media: linked } })
    assert.ok(none, `${linked}: the post is still built`)
    assert.deepEqual(none.media, [], `${linked}: no media, and none invented`)
  }
})

test('A THREADS REPLY SAYS WHO IT ANSWERS, in the head Discord draws a text post from and in the activity document', async () => {
  /**
   * The defect: buildFromMedia never read is_reply, reply_to_author or reply_to_post_id, so a reply
   * rendered as if it started a thread. The renderer already draws the marker for any post.replyTo
   * with an author (text.ts replyPrefix). This post has no media, so Discord draws it from the
   * OpenGraph head, and og:description is where the marker has to be. The example is a self-reply, a
   * post continuing its author's own thread, which is why both handles are the same placeholder.
   */
  const post = normalizeThreads({ source: 'ssr', html: REPLY_PAGE }, REPLY_REF)
  assert.ok(post)
  assert.deepEqual(post.media, [])
  const r = post.replyTo
  assert.ok(r, 'a reply carries its parent')
  assert.deepEqual(r.ref, { p: 'th', code: PARENT_CODE }, 'the real parent, converted from reply_to_post_id')
  assert.equal(r.canonical, `https://www.threads.com/@threads_author/post/${PARENT_CODE}`)
  assert.deepEqual(r.author, { name: 'threads_author', handle: 'threads_author', url: 'https://www.threads.com/@threads_author' })
  assert.equal(r.text, '', 'the parent text is not in the Target block, so none is invented')
  assert.deepEqual(r.media, [])
  assert.deepEqual(r.counts, {})
  assert.equal(r.replyTo, undefined, 'depth 1')
  assert.equal(r.quote, undefined, 'depth 1')
  // The parent's own time, from its shortcode. The child's taken_at is 14:15:02 to the second; the
  // ids put the parent 145 ms before the child (whose id time is 14:15:02.787).
  assert.equal(r.createdAt.toISOString(), '2026-11-01T14:15:02.642Z')

  const head = await renderPost(post, 'discord', ORIGIN).text()
  assert.match(head, /<meta property="og:description" content="↩ threads_author \(@threads_author\)/)
  const s = toMastodonStatus(post, ORIGIN)
  assert.ok(
    s.content.includes('<sub>↩ <a href="https://www.threads.com/@threads_author" class="u-url mention">threads_author (@threads_author)</a></sub>'),
    `expected the reply marker in: ${s.content}`,
  )
})

test('A THREADS REPLY SURVIVES THE POST CACHE: its parent passes the nested identity check', () => {
  /**
   * cache.ts's hasValidIdentity re-checks a nested replyTo's ref, canonical and createdAt when a cached
   * post is read back, and one bad field makes the WHOLE post read back as null, so every view of
   * every reply would be a fresh fetch. This is the trap that rules out a replyTo with its ref or
   * canonical left out.
   */
  const post = normalizeThreads({ source: 'ssr', html: REPLY_PAGE }, REPLY_REF)
  const back = deserializePost(serializePost(post))
  assert.ok(back, 'the reply reads back from the cache')
  assert.deepEqual(back.replyTo.ref, { p: 'th', code: PARENT_CODE })
  assert.equal(back.replyTo.canonical, post.replyTo.canonical)
  assert.equal(back.replyTo.createdAt.toISOString(), post.replyTo.createdAt.toISOString())
  assert.equal(back.replyTo.author.handle, 'threads_author')
})

test('NO REPLY CONTEXT WITHOUT ALL THREE FIELDS, and the post itself is still built', () => {
  /**
   * Every case below would otherwise need a guess: a parent nobody can name, a shortcode from an id
   * JSON.parse has already rounded, or a ref the cache would reject. Each gets no replyTo instead, and
   * keeps its card. The positive control uses an id and code this file already pins (DDYEM_foiI1 is
   * 3519581593786262069, decoded above).
   */
  const ID = '3519581593786262069'
  const good = { is_reply: true, reply_to_author: { username: 'someoneelse' }, reply_to_post_id: ID }
  const reply = (tp) => normalizeThreads(
    { source: 'ssr', html: ssrPage(mediaDict({ text_post_app_info: { direct_reply_count: 0, ...tp } })) },
    { p: 'th', code: 'DDYEM_foiI1' },
  )
  const control = reply(good)
  assert.deepEqual(control.replyTo.ref, { p: 'th', code: 'DDYEM_foiI1' }, 'positive control')
  assert.equal(control.replyTo.author.handle, 'someoneelse')

  for (const [why, tp] of [
    ['is_reply false', { ...good, is_reply: false }],
    ['is_reply missing', { reply_to_author: good.reply_to_author, reply_to_post_id: ID }],
    ['is_reply the string "true"', { ...good, is_reply: 'true' }],
    ['no author', { ...good, reply_to_author: null }],
    ['an author without a username', { ...good, reply_to_author: { id: '1' } }],
    ['a username that is not a handle', { ...good, reply_to_author: { username: 'not a handle' } }],
    ['no id', { ...good, reply_to_post_id: null }],
    // A number literal this long is already rounded, which is the case being tested.
    ['an id that arrived as a JSON number', { ...good, reply_to_post_id: Number(ID) }],
    ['an id that is a shortcode, not digits', { ...good, reply_to_post_id: 'DDYEM_foiI1' }],
    ['a zero id', { ...good, reply_to_post_id: '0' }],
    ['an id with a leading zero', { ...good, reply_to_post_id: `0${ID}` }],
    ['an id longer than 64 bits allows', { ...good, reply_to_post_id: '1'.repeat(21) }],
  ]) {
    const post = reply(tp)
    assert.ok(post, `${why}: the post is still built`)
    assert.equal(post.replyTo, undefined, `${why}: no reply context`)
  }
})

test('A QUOTED POST NEVER CARRIES REPLY CONTEXT OF ITS OWN (depth 1)', () => {
  const post = normalizeThreads({ source: 'ssr', html: ssrPage(mediaDict({
    text_post_app_info: { direct_reply_count: 0, share_info: { quoted_post: mediaDict({
      code: 'QUOTED0code', caption: { text: 'a quoted reply' },
      user: { username: 'someoneelse', full_name: 'Someone Else' },
      text_post_app_info: { is_reply: true, reply_to_author: { username: 'thirdparty' }, reply_to_post_id: '3519581593786262069' },
    }) } },
  })) }, { p: 'th', code: 'DDYEM_foiI1' })
  assert.ok(post.quote)
  assert.equal(post.quote.replyTo, undefined, 'the quote is depth 1 and gets no replyTo')
  assert.equal(post.replyTo, undefined, 'and the quoting post is not a reply')
})

test('codeFromId IS THE SHORTCODE: every pk and code pair on the two committed real pages agrees', () => {
  /**
   * Threads names a reply's parent only by its numeric id, and a th ref needs the shortcode, so the
   * reply marker rests on this conversion. The pairs come from data already in the repo: the carousel
   * post and its ten slides, and the video post, twelve objects that each carry a pk and a code. A pk
   * is a string on the wire. A JSON number could not hold it, which is why codeFromId refuses one.
   */
  const pairs = []
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) return o.forEach(walk)
    if ('pk' in o && typeof o.code === 'string') pairs.push([o.pk, o.code])
    Object.values(o).forEach(walk)
  }
  for (const page of [CAROUSEL, VIDEO]) {
    for (const [, json] of page.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) walk(JSON.parse(json))
  }
  assert.equal(pairs.length, 12)
  for (const [pk, code] of pairs) {
    assert.equal(typeof pk, 'string', 'a pk arrives as a string')
    assert.equal(codeFromId(pk), code, `pk ${pk}`)
    // And it is the inverse of the decode createdAtFromCode does: the same id gives the same time.
    assert.equal(createdAtFromCode(codeFromId(pk)).getTime(), createdAtFromCode(code).getTime())
  }
  assert.equal(codeFromId('3519581593786262069'), 'DDYEM_foiI1', 'the pair the createdAtFromCode test names')
})
