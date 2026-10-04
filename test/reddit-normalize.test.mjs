import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReddit, redditGate } from '../src/platforms/reddit/normalize.ts'
import { readFileSync } from 'node:fs'

// The shape /comments/{id} returns over OAuth: [postListing, commentListing]. Only the post's
// data.children[0].data matters here.
const listing = (post) => [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: post }] } },
  { kind: 'Listing', data: { children: [] } },
]

const base = {
  title: 'A title', author: 'spez', subreddit: 'test',
  permalink: '/r/test/comments/abc/a_title/', selftext: '', score: 42, num_comments: 5,
  created_utc: 1700000000, over_18: false,
}

const REF = { p: 'rd', sub: 'test', id: 'abc' }

test('normalizeReddit builds a Post: title leads text, u/author, counts, canonical from permalink', () => {
  const post = normalizeReddit(listing({ ...base, selftext: 'the body' }), REF)
  assert.ok(post)
  assert.equal(post.author.name, 'u/spez')
  assert.equal(post.author.handle, 'spez')
  assert.equal(post.author.url, 'https://www.reddit.com/user/spez')
  assert.equal(post.title, 'A title', 'the headline is its own field')
  assert.equal(post.text, 'the body', 'the body is the selftext alone — the renderer bolds the title above it')
  assert.equal(post.canonical, 'https://www.reddit.com/r/test/comments/abc/a_title/')
  assert.deepEqual(post.counts, { likes: 42, replies: 5 })
  assert.equal(post.createdAt.toISOString(), '2023-11-14T22:13:20.000Z')
  assert.equal(post.sensitive, false)
  assert.equal(post.ref.p, 'rd')
  assert.equal(post.ref.sub, 'test')
})

test('normalizeReddit recovers the subreddit from the payload for a bare /comments ref', () => {
  const post = normalizeReddit(listing(base), { p: 'rd', sub: '', id: 'abc' })
  assert.equal(post.ref.sub, 'test', 'payload subreddit fills an empty ref sub')
})

test('normalizeReddit: an image post carries the preview source, &amp; decoded', () => {
  const post = normalizeReddit(listing({
    ...base, post_hint: 'image',
    preview: { images: [{ source: { url: 'https://preview.redd.it/x.jpg?a=1&amp;b=2', width: 800, height: 600 } }] },
  }), REF)
  assert.equal(post.media.length, 1)
  assert.deepEqual(post.media[0], { kind: 'image', url: 'https://preview.redd.it/x.jpg?a=1&b=2', w: 800, h: 600 })
})

test('normalizeReddit: a gallery carries every media_metadata image', () => {
  const post = normalizeReddit(listing({
    ...base, is_gallery: true,
    gallery_data: { items: [{ media_id: 'm1' }, { media_id: 'm2' }] },
    media_metadata: {
      m1: { s: { u: 'https://i.redd.it/m1.jpg?s=1&amp;e=2', x: 1080, y: 720 } },
      m2: { s: { u: 'https://i.redd.it/m2.jpg', x: 640, y: 640 } },
    },
  }), REF)
  assert.equal(post.media.length, 2)
  assert.equal(post.media[0].url, 'https://i.redd.it/m1.jpg?s=1&e=2')
  assert.equal(post.media[1].w, 640)
})

test('normalizeReddit: NSFW sets sensitive, not a gate — the content still renders', () => {
  const post = normalizeReddit(listing({ ...base, over_18: true }), REF)
  assert.ok(post)
  assert.equal(post.sensitive, true)
})

test('normalizeReddit returns null for a removed/deleted post (loud-default, not a gate)', () => {
  for (const gone of [
    { ...base, removed_by_category: 'moderator' },
    { ...base, selftext: '[removed]' },
    { ...base, selftext: '[deleted]' },
    { ...base, author: '[deleted]' },
  ]) {
    assert.equal(normalizeReddit(listing(gone), REF), null)
  }
})

test('normalizeReddit is a no-op on the wrong platform and on a non-listing', () => {
  assert.equal(normalizeReddit(listing(base), { p: 'x', id: '1' }), null)
  assert.equal(normalizeReddit({ error: 403 }, REF), null)
  assert.equal(normalizeReddit(null, REF), null)
})

// ── embed.reddit.com HTML path (the PRIMARY, credential-free source) ─────────────────────────────
// Minimal pages that mirror the real embed's extraction points: the screenview JSON blob (entity-
// encoded), the canonical-url element (authoritative subreddit), an h1 or shreddit-embed-title, the
// /user/ author link, the faceplate-number score, and "N comments".
const enc = (o) => JSON.stringify(o).replace(/"/g, '&quot;')
const sv = (post, sub) => `<shreddit-screenview-data data="${enc({ post, subreddit: { name: sub, id: 't5_x' } })}">`
const canon = (sub, id, slug = 'a_slug') => `<div id="canonical-url-updater" value="https://www.reddit.com/r/${sub}/comments/${id}/${slug}/">`
const author = (a) => `<a href="https://www.reddit.com/user/${a}/?utm_source=embedv2">u/${a}</a>`
const score = (n) => `<faceplate-number number="${n}" pretty></faceplate-number> upvotes`

const imagePage = (o = {}) => {
  const { sub = 'pics', id = 'haucpf', title = 'A pic', a = 'rick', s = 42, c = 5, nsfw = false, url = 'https://i.redd.it/abc.jpg', type = 'image' } = o
  return '<html><body>' + canon(sub, id) + sv({ id: `t3_${id}`, url, type, created_timestamp: 1700000000000, nsfw }, sub) +
    `<h1 class="line-clamp-3 m-0">${title}</h1>` + author(a) + score(s) + `<span>View ${c} comments</span></body></html>`
}
const eRef = (id = "haucpf") => ({ p: 'rd', sub: '', id })

test('embed: an image post -> title, author, subreddit (from canonical), score, comments, ms timestamp, i.redd.it image', () => {
  const post = normalizeReddit({ source: 'embed', html: imagePage() }, eRef())
  assert.equal(post.author.name, 'u/rick')
  assert.equal(post.author.handle, 'rick')
  assert.equal(post.ref.sub, 'pics', 'the real subreddit is recovered from canonical even though ref.sub was empty')
  assert.equal(post.canonical, 'https://www.reddit.com/r/pics/comments/haucpf/a_slug/')
  assert.equal(post.title, 'A pic', 'an image post carries its headline as the title')
  assert.equal(post.text, '', 'and no body (the image is the content)')
  assert.deepEqual(post.media, [{ kind: 'image', url: 'https://i.redd.it/abc.jpg', w: 0, h: 0 }])
  assert.deepEqual(post.counts, { likes: 42, replies: 5 })
  assert.equal(post.createdAt.toISOString(), new Date(1700000000000).toISOString())
  assert.equal(post.sensitive, false)
})

test('embed: NSFW sets sensitive (Reddit serves it in full logged-out); a .gif image is kind:gif', () => {
  assert.equal(normalizeReddit({ source: 'embed', html: imagePage({ nsfw: true }) }, eRef()).sensitive, true)
  assert.equal(normalizeReddit({ source: 'embed', html: imagePage({ url: 'https://i.redd.it/x.gif' }) }, eRef()).media[0].kind, 'gif')
})

test('embed: a text post reads shreddit-embed-title + the rtjson body; title leads the text', () => {
  const html = '<html><body>' + canon('AskReddit', 'xyz') +
    sv({ id: 't3_xyz', url: 'https://www.reddit.com/r/AskReddit/comments/xyz/q/', type: 'text', created_timestamp: 1700000000000, nsfw: false }, 'AskReddit') +
    '<shreddit-embed-title>My TIFU</shreddit-embed-title>' + author('bob') + score(10) + 'View 3 comments' +
    '<div id="t3_xyz-post-rtjson-content" class="md"><p>first para</p><p>second para</p></div></body></html>'
  const post = normalizeReddit({ source: 'embed', html }, { p: 'rd', sub: '', id: 'xyz' })
  assert.equal(post.title, 'My TIFU', 'the title leads as its own (bold) field')
  assert.equal(post.text, 'first para\n\nsecond para', 'the rtjson body, title-free')
})

test('embed: a LONG selftext body is capped to a preview (…) so the counts footer stays visible', () => {
  // The renderer appends counts as the LAST block of the Mastodon content, so an uncapped multi-KB
  // selftext pushed the counts past Discord's preview and a text post showed none (reported 2026-07-22).
  const longBody = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') // ~700+ chars, one para
  const html = '<html><body>' + canon('massachusetts', 'lng') +
    sv({ id: 't3_lng', url: 'https://www.reddit.com/r/massachusetts/comments/lng/q/', type: 'text', created_timestamp: 1700000000000, nsfw: false }, 'massachusetts') +
    '<shreddit-embed-title>A long one</shreddit-embed-title>' + author('sam') + score(163) + 'View 44 comments' +
    `<div id="t3_lng-post-rtjson-content" class="md"><p>${longBody}</p></div></body></html>`
  const post = normalizeReddit({ source: 'embed', html }, { p: 'rd', sub: '', id: 'lng' })
  assert.equal(post.title, 'A long one', 'the title is its own field, never capped')
  assert.ok(post.text.endsWith('…'), 'the body is ellipsized when it exceeds the preview cap')
  assert.ok(post.text.length < 502, `body capped near 500, got ${post.text.length}`)
  assert.ok(post.text.length > 200, 'but still a substantial preview')
  assert.deepEqual(post.counts, { likes: 163, replies: 44 }, 'counts are unaffected by the body cap')
})

test('embed: a SHORT selftext body is NOT capped — no ellipsis added', () => {
  const html = '<html><body>' + canon('t', 'shrt') +
    sv({ id: 't3_shrt', url: 'https://www.reddit.com/r/t/comments/shrt/q/', type: 'text', created_timestamp: 1700000000000, nsfw: false }, 't') +
    '<shreddit-embed-title>Short</shreddit-embed-title>' + author('x') + score(1) + 'View 2 comments' +
    '<div id="t3_shrt-post-rtjson-content" class="md"><p>just a line</p></div></body></html>'
  const post = normalizeReddit({ source: 'embed', html }, { p: 'rd', sub: '', id: 'shrt' })
  assert.equal(post.title, 'Short')
  assert.equal(post.text, 'just a line', 'a short body is untouched, no trailing …')
})

test('embed: a gallery reconstructs clean full-res i.redd.it urls from every slide', () => {
  const html = '<html><body>' + canon('pics', 'g1') +
    sv({ id: 't3_g1', url: 'https://www.reddit.com/gallery/g1', type: 'gallery', created_timestamp: 1700000000000, nsfw: false }, 'pics') +
    '<h1 class="line-clamp-3">Gallery</h1>' + author('carol') + score(7) + 'View 2 comments' +
    '<gallery-carousel post-id="t3_g1"><ul>' +
    '<li slot="page-0"><faceplate-img src="https://preview.redd.it/title-v0-aaa111.jpg?width=640&amp;s=xxx"></li>' +
    '<li slot="page-1"><faceplate-img src="https://preview.redd.it/title-v0-bbb222.png?width=640&amp;s=yyy"></li>' +
    '</ul></gallery-carousel></body></html>'
  const post = normalizeReddit({ source: 'embed', html }, { p: 'rd', sub: '', id: 'g1' })
  assert.deepEqual(post.media.map(m => m.url), ['https://i.redd.it/aaa111.jpg', 'https://i.redd.it/bbb222.png'])
})

/**
 * GIF POSTS, 2026-10-04. Reported: https://forsen.sex/r/forsen/comments/1wuh1g1/ rendered as text only.
 * Reddit labels these `type: "gif"` in the screenview, no branch knew the word, and media came back empty
 * with nothing failing. The fixture is that post's real embed page (container egress, real subreddit,
 * trimmed of scripts and styles; see its header for exactly what was cut and that the Post it yields is
 * identical to the full page's).
 */
const GIF_PAGE = readFileSync(new URL('./fixtures/reddit-embed-gif.html', import.meta.url), 'utf8')
const GIF_REF = { p: 'rd', sub: 'forsen', id: '1wuh1g1' }
const GIF_MP4 = 'https://preview.redd.it/4gg2f32z3qsh1.gif?width=320&format=mp4&s=b980ae1e4df49136d178f605cd05e89ac921bb5e'
const GIF_POSTER = 'https://preview.redd.it/this-man-is-deranged-v0-4gg2f32z3qsh1.gif?format=png8&s=e8f08d5ba684bd179ca3a777577ec2f742cfdf50'

// A gif page with a player tag, built from the same parts as imagePage, for the edges the capture lacks.
const gifPage = ({ player = '', ar = '1.3333333333333333', url = 'https://i.redd.it/x.gif', type = 'gif' } = {}) =>
  imagePage({ url, type }).replace('</body>',
    (ar ? `<shreddit-aspect-ratio style="--aspect-ratio: ${ar};">` : '') + player + '</body>')
const playerTag = (src, poster = 'https://preview.redd.it/x-v0-x.gif?format=png8&amp;s=p') =>
  `<shreddit-player src="${src}" autoplay gif post-id="t3_x" poster="${poster}">`

test('embed: a type:gif post is a VIDEO, Reddit\'s own mp4 rendition with its png8 poster and the size read off the page', () => {
  const post = normalizeReddit({ source: 'embed', html: GIF_PAGE }, GIF_REF)
  assert.ok(post)
  // Entities decoded, the signed query passed through exactly (s= binds it), and NO remux: the rendition
  // is already a progressive mp4, so the container is never involved.
  assert.deepEqual(post.media, [{ kind: 'video', url: GIF_MP4, w: 320, h: 240, poster: GIF_POSTER }])
  assert.equal(post.title, 'this man is deranged')
  assert.equal(post.author.handle, 'beau_fighter')
  assert.deepEqual(post.counts, { likes: 297, replies: 29 }, 'the same counts production read that day')
})

test('embed: a type:gif post with no player yields NO media, never an image where the full render puts a video', () => {
  /**
   * The placeholder-sub render (a bare /comments/{id} link) carries no player, and its Post is cached under
   * the same canonical key as the real-subreddit render's. Falling back to the .gif here would let
   * /_media/{key}/0.mp4, a url og:video promised as video, 302 to image bytes: the sticky poisoned-url
   * defect. Caught by an adversarial review before this shipped. No media is what this render gave
   * before the fix, and a missing index answers 404, which poisons nothing.
   */
  const post = normalizeReddit({ source: 'embed', html: gifPage() }, eRef())
  assert.deepEqual(post.media, [])
})

test('embed: a gif player whose src or poster is not Reddit\'s own is not trusted, and yields no media', () => {
  // The src lands in a Location header on our origin, so only Reddit's own image host is accepted, and
  // only its mp4 rendition (a png or gif `format` would be an image behind kind:'video').
  for (const src of ['https://evil.example/x.gif?format=mp4', 'https://preview.redd.it/x.gif?width=320&amp;format=png', 'http://preview.redd.it/x.gif?format=mp4']) {
    const post = normalizeReddit({ source: 'embed', html: gifPage({ player: playerTag(src) }) }, eRef())
    assert.deepEqual(post.media, [], src)
  }
  const offHostPoster = normalizeReddit({ source: 'embed',
    html: gifPage({ player: playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4', 'https://evil.example/p.png') }) }, eRef())
  assert.deepEqual(offHostPoster.media, [], 'an off-host poster is refused the same way')
})

test('embed: a gif player with no aspect ratio is 0x0, never an invented height', () => {
  const post = normalizeReddit({ source: 'embed',
    html: gifPage({ ar: '', player: playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4&amp;s=q') }) }, eRef())
  assert.equal(post.media[0].kind, 'video')
  assert.equal(post.media[0].url, 'https://preview.redd.it/x.gif?width=320&format=mp4&s=q')
  assert.equal(post.media[0].w, 0)
  assert.equal(post.media[0].h, 0)
})

test('embed: a NON-gif player on the page is not mistaken for one, even though its src ends .gif?', () => {
  // `gif` is a BARE attribute; the src's own ".gif?" must not count. Without the blanking of quoted
  // values, any player whose url mentions .gif would be read as the animated rendition.
  const notGif = '<shreddit-player src="https://preview.redd.it/x.gif?width=320&amp;format=mp4" autoplay poster="https://preview.redd.it/p.png">'
  const post = normalizeReddit({ source: 'embed', html: gifPage({ player: notGif }) }, eRef())
  assert.deepEqual(post.media, [], 'no gif attribute, no player reading')
})

test('embed: a type:image .gif post is NOT read for a player, even when the page has one — it stays kind:gif', () => {
  // Both renders of a type:'image' post have always agreed on the .gif. Reading the player for it would
  // make the real-subreddit render disagree with the placeholder one at index 0, the same poisoned-url
  // hazard the type:'gif' rule above avoids.
  const post = normalizeReddit({ source: 'embed', html: gifPage({ type: 'image',
    player: playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4&amp;s=q') }) }, eRef())
  assert.deepEqual(post.media, [{ kind: 'gif', url: 'https://i.redd.it/x.gif', w: 0, h: 0 }])
})

test('embed: the aspect ratio is the one wrapping the player, not the first on the page', () => {
  const player = playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4&amp;s=q')
  const html = gifPage({ ar: '', player: '' }).replace('</body>',
    '<shreddit-aspect-ratio style="--aspect-ratio: 9;"></shreddit-aspect-ratio>'
    + '<shreddit-aspect-ratio style="--aspect-ratio: 2;">' + player + '</body>')
  const post = normalizeReddit({ source: 'embed', html }, eRef())
  assert.equal(post.media[0].h, 160, '320 over the wrapping 2, not over the decoy 9')
})

test('embed: a type:gif post hosted on v.redd.it takes the video branch, not the empty card', () => {
  // Whether Reddit labels its is_gif VIDEOS 'gif' or 'video' is unmeasured. If 'gif', the v.redd.it url
  // still means a remux video with its cover, which is what this pins.
  const html = imagePage({ url: 'https://v.redd.it/g1abc', type: 'gif' }).replace('</body>',
    '<img src="https://external-preview.redd.it/cover.jpg?width=640&amp;s=zzz"></body>')
  const post = normalizeReddit({ source: 'embed', html }, eRef())
  assert.equal(post.media[0].kind, 'video')
  assert.equal(post.media[0].remux.video, 'https://v.redd.it/g1abc/HLSPlaylist.m3u8')
})

test('embed: a video post is a remux video — HLS playlist + external-preview poster', () => {
  const html = '<html><body>' + canon('oddlysatisfying', 'v1') +
    sv({ id: 't3_v1', url: 'https://v.redd.it/v1abc', type: 'video', created_timestamp: 1700000000000, nsfw: false }, 'oddlysatisfying') +
    '<h1 class="line-clamp-3">A clip</h1>' + author('dave') + score(100) + 'View 9 comments' +
    '<img src="https://external-preview.redd.it/cover.jpg?width=640&amp;s=zzz"></body></html>'
  const post = normalizeReddit({ source: 'embed', html }, { p: 'rd', sub: '', id: 'v1' })
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'video')
  // The /_media/ route muxes this HLS to a playable MP4 via the container; withResolver falls back to
  // the poster still when the container is absent. The '&amp;' in the cover url is decoded.
  assert.equal(post.media[0].remux.video, 'https://v.redd.it/v1abc/HLSPlaylist.m3u8')
  assert.equal(post.media[0].url, 'https://v.redd.it/v1abc/HLSPlaylist.m3u8')
  assert.equal(post.media[0].poster, 'https://external-preview.redd.it/cover.jpg?width=640&s=zzz')
})

test('embed: a stripped render (no title element) derives a title from the url slug', () => {
  // The placeholder-sub / bare-/comments render omits the title element; the slug is the fallback so
  // the post still renders rather than falling to the generic failure.
  const html = canon('pics', 'haucpf', 'ive_found_a_few_funny_memories') +
    sv({ id: 't3_haucpf', url: 'https://i.redd.it/x.jpg', type: 'image', created_timestamp: 1700000000000, nsfw: false }, 'pics')
  const post = normalizeReddit({ source: 'embed', html }, eRef())
  assert.equal(post.title, 'Ive found a few funny memories', 'the slug-derived headline lands in title')
  assert.equal(post.text, '', 'an image post has no body')
  assert.equal(post.media.length, 1)
})

test('embed: a deleted post (tombstone) and a not-found shell (no canonical) both yield null', () => {
  const deleted = canon('meirl', 'd1') + sv({ id: 't3_d1', created_timestamp: 1700000000000 }, 'meirl') +
    '<p>This post has been deleted, but comments are still viewable.</p>' + author('x')
  assert.equal(normalizeReddit({ source: 'embed', html: deleted }, { p: 'rd', sub: '', id: 'd1' }), null)
  assert.equal(normalizeReddit({ source: 'embed', html: '<html>no canonical here</html>' }, eRef("zzz")), null)
})

test('redditGate names a private/banned/quarantined subreddit as the private wall, else nothing', () => {
  assert.equal(redditGate({ reason: 'private', error: 403 }), 'private')
  assert.equal(redditGate({ reason: 'banned', error: 404 }), 'private')
  assert.equal(redditGate({ reason: 'quarantined' }), 'private')
  assert.equal(redditGate(listing(base)), undefined)
  assert.equal(redditGate({}), undefined)
})
