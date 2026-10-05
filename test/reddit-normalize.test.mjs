import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReddit, redditGate, gifSize, redditGifUrl } from '../src/platforms/reddit/normalize.ts'
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

test('normalizeReddit (OAuth): an i.redd.it .gif is the SAME gif entry the embed renders emit; any other animated marker still yields no media, never its png8 still', () => {
  /**
   * REWRITTEN 2026-10-05. This pinned "an animated post yields no media" for every animated marker,
   * because the embed render then put Reddit's mp4 rendition, a VIDEO, at index 0 of a gif post, and the
   * png8 preview still here would have sat behind a /_media/{key}/0.mp4 url a cached card promised as video.
   * Every render must agree on index 0's KIND, because they all land under one canonical cache key.
   *
   * What changed: the embed renders now put the ORIGINAL .gif at index 0 (kind:'gif'), so the agreeing
   * answer for an i.redd.it .gif url is that same entry, sized from the header fetch.ts read. What did not:
   * a gif/mp4 preview variant on a non-.gif url, and a .gif off i.redd.it, still yield nothing, because the
   * png8 still the preview branch would pick is an image where an embed render may put a video.
   */
  const still = { source: { url: 'https://preview.redd.it/x.gif?format=png8&amp;s=abc', width: 320, height: 240 } }
  const head = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]) // GIF89a 320x240
  const gif = normalizeReddit({ source: 'json', gifHead: head,
    data: listing({ ...base, post_hint: 'image', url: 'https://i.redd.it/x.gif', preview: { images: [still] } }) }, REF)
  assert.deepEqual(gif.media, [{ kind: 'gif', url: 'https://i.redd.it/x.gif', w: 320, h: 240 }],
    'the .gif itself, never the png8 still, and sized from its own header')
  const unsized = normalizeReddit(listing({ ...base, post_hint: 'image', url: 'https://i.redd.it/x.gif', preview: { images: [still] } }), REF)
  assert.deepEqual(unsized.media, [{ kind: 'gif', url: 'https://i.redd.it/x.gif', w: 0, h: 0 }],
    'with no header read the KIND and url are identical; only the size is unknown')
  for (const over of [
    { url: 'https://i.redd.it/x.png', preview: { images: [{ ...still, variants: { gif: { source: { url: 'https://preview.redd.it/x.gif' } } } }] } },
    { url: 'https://i.redd.it/x.png', preview: { images: [{ ...still, variants: { mp4: { source: { url: 'https://preview.redd.it/x.gif?format=mp4' } } } }] } },
    { url: 'https://i.imgur.com/x.gif', preview: { images: [still] } },
  ]) {
    const post = normalizeReddit(listing({ ...base, post_hint: 'image', ...over }), REF)
    assert.deepEqual(post.media, [], JSON.stringify(over).slice(0, 80))
  }
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
 * GIF POSTS. Reported 2026-10-04: https://forsen.sex/r/forsen/comments/1wuh1g1/ rendered as text only.
 * Reddit labels these `type: "gif"` in the screenview, no branch knew the word, and media came back empty
 * with nothing failing. #98 answered with Reddit's mp4 rendition (a video, which Discord does not loop);
 * since 2026-10-05 the answer is the original .gif (kind:'gif'), which Discord loops as an image. The
 * fixture is that post's real embed page (captured from the Claude Code dev sandbox, not a Worker or the
 * Cloudflare Container; real subreddit, trimmed of scripts and styles; see its header for exactly what
 * was cut and that the Post it yields is identical to the full page's).
 */
const GIF_PAGE = readFileSync(new URL('./fixtures/reddit-embed-gif.html', import.meta.url), 'utf8')
const GIF_REF = { p: 'rd', sub: 'forsen', id: '1wuh1g1' }
const GIF_URL = 'https://i.redd.it/4gg2f32z3qsh1.gif'
// The first ten bytes of that file, as read 2026-10-05 from the dev sandbox with `range: bytes=0-9`:
// "GIF89a", then 320 and 240 little-endian.
const GIF_HEAD = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])
// What a bare /comments/{id} link gets: the placeholder-sub render. Measured the same day on this post, it
// carries the same screenview (`url` the .gif, `type: "gif"`) and the same canonical, and no player.
const GIF_PLACEHOLDER = GIF_PAGE.replace(/<shreddit-player\b[^>]*>/g, '')

// A gif page with a player tag, built from the same parts as imagePage, for the edges the capture lacks.
const gifPage = ({ player = '', ar = '1.3333333333333333', url = 'https://i.redd.it/x.gif', type = 'gif' } = {}) =>
  imagePage({ url, type }).replace('</body>',
    (ar ? `<shreddit-aspect-ratio style="--aspect-ratio: ${ar};">` : '') + player + '</body>')
const playerTag = (src, poster = 'https://preview.redd.it/x-v0-x.gif?format=png8&amp;s=p') =>
  `<shreddit-player src="${src}" autoplay gif post-id="t3_x" poster="${poster}">`
// A GIF header for any size, little-endian, the way the file spells it.
const header = (w, h, sig = 'GIF89a') => Uint8Array.from([...sig].map(c => c.charCodeAt(0)).concat([w & 255, w >> 8, h & 255, h >> 8]))

test('embed: a type:gif post is its ORIGINAL .gif, kind:gif, sized from the header fetch.ts read, never the mp4 rendition', () => {
  /**
   * REWRITTEN 2026-10-05 from "a type:gif post is a VIDEO, Reddit's own mp4 rendition with its png8 poster
   * and the size read off the page". The owner chose the loop: Discord draws a video with a play button and
   * no loop, and loops an animated GIF image natively. So the entry is now the .gif the screenview names,
   * with no poster (a GIF is its own picture) and the size its own header states.
   */
  const post = normalizeReddit({ source: 'embed', html: GIF_PAGE, gifHead: GIF_HEAD }, GIF_REF)
  assert.ok(post)
  assert.deepEqual(post.media, [{ kind: 'gif', url: GIF_URL, w: 320, h: 240 }])
  assert.doesNotMatch(JSON.stringify(post.media), /format=mp4|preview\.redd\.it/, 'nothing of the rendition survives')
  assert.equal(post.title, 'this man is deranged')
  assert.equal(post.author.handle, 'beau_fighter')
  assert.deepEqual(post.counts, { likes: 297, replies: 29 }, 'the same counts production read that day')
})

test('embed: the PLACEHOLDER render of a type:gif post (no player) yields the SAME gif entry as the full render', () => {
  /**
   * REWRITTEN 2026-10-05 from "a type:gif post with no player yields NO media, never an image where the
   * full render puts a video". That rule existed because the full render put a VIDEO at index 0 and this
   * render, cached under the same canonical key, could only have put an image there: the poisoned-url
   * defect. Now neither render reads the player. Both read the screenview's `url` and `type`, which the
   * placeholder render carries too (measured), so index 0 is the same entry in both. That sameness is the
   * safety property, so it is what is asserted, with and without the size.
   */
  const full = normalizeReddit({ source: 'embed', html: GIF_PAGE, gifHead: GIF_HEAD }, GIF_REF)
  const bare = normalizeReddit({ source: 'embed', html: GIF_PLACEHOLDER, gifHead: GIF_HEAD }, { p: 'rd', sub: '', id: '1wuh1g1' })
  assert.deepEqual(bare.media, full.media)
  const bareUnsized = normalizeReddit({ source: 'embed', html: GIF_PLACEHOLDER }, { p: 'rd', sub: '', id: '1wuh1g1' })
  assert.deepEqual(bareUnsized.media.map(m => [m.kind, m.url]), full.media.map(m => [m.kind, m.url]),
    'a header read that failed for one render changes its size, never its kind or url')
})

test('embed: a type:gif post whose url is not a strict i.redd.it .gif yields no media, whatever player the page carries', () => {
  /**
   * REWRITTEN 2026-10-05 from "a gif player whose src or poster is not Reddit's own is not trusted". The
   * url this file trusts is now the screenview's, and it ends up in a Location header on our origin, so the
   * host AND the path are checked: i.redd.it, one base36 id, `.gif`, nothing after. A page that also has a
   * perfectly good Reddit player still gets nothing for these, because reading the player for them would
   * give the full render a video at index 0 that the placeholder render, which has no player, cannot match.
   */
  const player = playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4&amp;s=q')
  for (const url of [
    'https://evil.example/x.gif', 'http://i.redd.it/x.gif', 'https://i.redd.it.evil.example/x.gif',
    'https://i.redd.it/x.gif?y=1', 'https://i.redd.it/x.gif#y', 'https://i.redd.it/a/x.gif', 'https://i.redd.it/x.gifv',
    'https://i.redd.it/x.png', 'https://preview.redd.it/x.gif', 'https://i.redd.it/X.GIF', 'https://i.redd.it/.gif',
  ]) {
    const post = normalizeReddit({ source: 'embed', html: gifPage({ url, player }), gifHead: header(320, 240) }, eRef())
    assert.deepEqual(post.media, [], url)
  }
})

test('embed: a gif whose header was not read, or is not a GIF, is 0x0, never a size from anywhere else', () => {
  /**
   * REWRITTEN 2026-10-05 from "a gif player with no aspect ratio is 0x0, never an invented height". Same
   * rule, new source: the size is the file's own header or nothing. Assert on content: an HTML page (what
   * i.redd.it sends a browser-style Accept, via a 307) or a PNG must not be read as a size because it came
   * back at all.
   */
  const html = gifPage({ player: playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4&amp;s=q') })
  const enc = (s) => Uint8Array.from([...s].map(c => c.charCodeAt(0)))
  for (const [why, gifHead] of [
    ['no read', undefined], ['empty', new Uint8Array(0)], ['short', header(320, 240).slice(0, 9)],
    ['an HTML page', enc('<!DOCTYPE html>')], ['a PNG', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])],
    ['GIF90a', header(320, 240, 'GIF90a')], ['zero width', header(0, 240)], ['zero height', header(320, 0)],
    ['not bytes', 'GIF89a@\u0001ð\u0000'],
  ]) {
    const post = normalizeReddit({ source: 'embed', html, gifHead }, eRef())
    assert.deepEqual(post.media, [{ kind: 'gif', url: 'https://i.redd.it/x.gif', w: 0, h: 0 }], why)
  }
})

test('embed: the page\'s player is never read for a gif post, so no mp4 or png8 url can reach the Post', () => {
  /**
   * REWRITTEN 2026-10-05 from "a NON-gif player is not mistaken for one, even with the word gif inside one
   * of its attribute values". That guarded gifPlayer's bare-attribute detection, and gifPlayer is gone:
   * the player block is in the full render only, so any reading of it gives two renders of one post two
   * different answers at index 0. What replaces the guard is the stronger statement that nothing of the
   * player, gif-marked or not, reaches media at all.
   */
  for (const player of [
    playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4&amp;s=q'),
    '<shreddit-player class="block gif media" src="https://preview.redd.it/x.gif?width=320&amp;format=mp4" autoplay poster="https://preview.redd.it/p.png">',
  ]) {
    const post = normalizeReddit({ source: 'embed', html: gifPage({ player }) }, eRef())
    assert.deepEqual(post.media, [{ kind: 'gif', url: 'https://i.redd.it/x.gif', w: 0, h: 0 }])
  }
})

test('embed: a type:image .gif post is NOT read for a player, even when the page has one — it stays kind:gif', () => {
  // Both renders of a type:'image' post have always agreed on the .gif. Reading the player for it would
  // make the real-subreddit render disagree with the placeholder one at index 0, the same poisoned-url
  // hazard the type:'gif' rule above avoids. Since 2026-10-05 it shares the gif reading, so it is sized
  // from its header like a type:'gif' post; its kind and url are what they always were.
  const html = gifPage({ type: 'image', player: playerTag('https://preview.redd.it/x.gif?width=320&amp;format=mp4&amp;s=q') })
  assert.deepEqual(normalizeReddit({ source: 'embed', html }, eRef()).media, [{ kind: 'gif', url: 'https://i.redd.it/x.gif', w: 0, h: 0 }])
  assert.deepEqual(normalizeReddit({ source: 'embed', html, gifHead: header(500, 281) }, eRef()).media,
    [{ kind: 'gif', url: 'https://i.redd.it/x.gif', w: 500, h: 281 }])
})

test('embed: the size is the GIF header\'s, never the aspect-ratio wrapper\'s, which reads 1 for a portrait gif', () => {
  /**
   * REWRITTEN 2026-10-05 from "the aspect ratio is the one wrapping the player, not the first on the page".
   * #98 sized the rendition from that wrapper. Measured 2026-10-05 from the dev sandbox on 35 i.redd.it
   * gifs, the wrapper reads 1 for every portrait one, so an 800x1422 gif would have been published as
   * 800x800. The header is read instead, and the wrapper is ignored however it reads.
   */
  const player = playerTag('https://preview.redd.it/x.gif?width=800&amp;format=mp4&amp;s=q')
  const post = normalizeReddit({ source: 'embed', html: gifPage({ ar: '1', player }), gifHead: header(800, 1422) }, eRef())
  assert.deepEqual([post.media[0].w, post.media[0].h], [800, 1422])
})

test('gifSize reads GIF87a and GIF89a logical screen sizes little-endian, and nothing else', () => {
  assert.deepEqual(gifSize(GIF_HEAD), { w: 320, h: 240 }, 'the measured header')
  assert.deepEqual(gifSize(header(1920, 1038)), { w: 1920, h: 1038 }, 'both bytes of each number count')
  assert.deepEqual(gifSize(header(1280, 1280, 'GIF87a')), { w: 1280, h: 1280 }, 'the older signature, seen on 1 of 36')
  assert.deepEqual(gifSize([...header(222, 227)]), { w: 222, h: 227 }, 'a plain array of bytes reads the same')
  // Trailing bytes are ignored: a server that ignored the Range header still yields the size of the first ten.
  assert.deepEqual(gifSize(Uint8Array.from([...header(640, 364), 0xf7, 0, 0])), { w: 640, h: 364 })
  for (const junk of [null, undefined, 42, {}, 'GIF89a', header(320, 240).slice(0, 9)]) {
    assert.deepEqual(gifSize(junk), { w: 0, h: 0 }, String(junk))
  }
})

test('redditGifUrl names exactly the url every render puts at index 0, and nothing for a non-gif post', () => {
  /**
   * fetch.ts asks this which file to read the size of, and the normalizer builds media[0] from the same
   * reading. If the two disagreed, a size would be read for one url and attached to another. Asserted
   * against all three renders a post can have.
   */
  const embedFull = { source: 'embed', html: GIF_PAGE }
  const embedBare = { source: 'embed', html: GIF_PLACEHOLDER }
  const oauth = { source: 'json', data: listing({ ...base, post_hint: 'image', url: GIF_URL }) }
  for (const [name, raw, ref] of [['full', embedFull, GIF_REF], ['placeholder', embedBare, eRef('1wuh1g1')], ['oauth', oauth, REF]]) {
    assert.equal(redditGifUrl(raw), GIF_URL, name)
    assert.equal(normalizeReddit(raw, ref).media[0].url, redditGifUrl(raw), `${name}: the url read is the url emitted`)
  }
  assert.equal(redditGifUrl({ source: 'embed', html: imagePage() }), null, 'a .jpg image post')
  assert.equal(redditGifUrl({ source: 'embed', html: imagePage({ url: 'https://v.redd.it/g1abc', type: 'gif' }) }), null, 'a v.redd.it gif-labelled video')
  assert.equal(redditGifUrl({ source: 'embed', html: imagePage({ url: GIF_URL, type: 'link' }) }), null, 'a link post pointing at a gif')
  assert.equal(redditGifUrl({ source: 'json', data: listing({ ...base, url: 'https://i.redd.it/x.png' }) }), null)
  for (const junk of [null, undefined, {}, { source: 'embed' }, { source: 'json', data: 42 }]) assert.equal(redditGifUrl(junk), null)
})

test('NO RENDER OF A GIF POST PUTS A VIDEO AT INDEX 0: full, placeholder and OAuth all emit the same gif kind and url', () => {
  /**
   * THE SAFETY PROPERTY OF THIS WHOLE CHANGE, stated once over every render. All three land under one post
   * cache key, and /_media/{key}/0 is answered from whichever wrote last, while Discord's media proxy holds
   * that url as whatever kind it was first told. So the kind at index 0 must not depend on which render
   * ran, nor on whether its header read succeeded (a probe can fail transiently; only the size may differ).
   */
  const renders = [
    normalizeReddit({ source: 'embed', html: GIF_PAGE, gifHead: GIF_HEAD }, GIF_REF),
    normalizeReddit({ source: 'embed', html: GIF_PAGE }, GIF_REF),
    normalizeReddit({ source: 'embed', html: GIF_PLACEHOLDER, gifHead: GIF_HEAD }, eRef('1wuh1g1')),
    normalizeReddit({ source: 'embed', html: GIF_PLACEHOLDER }, eRef('1wuh1g1')),
    normalizeReddit({ source: 'json', gifHead: GIF_HEAD, data: listing({ ...base, post_hint: 'image', url: GIF_URL }) }, REF),
    normalizeReddit(listing({ ...base, post_hint: 'image', url: GIF_URL }), REF),
  ]
  for (const post of renders) {
    assert.equal(post.media.length, 1)
    assert.equal(post.media[0].kind, 'gif')
    assert.equal(post.media[0].url, GIF_URL)
    assert.ok(!('poster' in post.media[0]) && !('remux' in post.media[0]))
  }
})

test('embed: a type:gif post hosted on v.redd.it takes the video branch, not the empty card', () => {
  // Reddit DOES label some videos 'gif': measured 2026-10-05 from the dev sandbox, 1 of 36 type:'gif'
  // posts (r/HighQualityGifs/comments/1wpy40m) plays from v.redd.it. The v.redd.it url means a remux video
  // with its cover in every render, which is what this pins; it is never read as a gif.
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

const VIDEO_PAGE = readFileSync(new URL('./fixtures/reddit-embed-video.html', import.meta.url), 'utf8')

test('embed: a real video page yields the unsigned HLS master at index 0, never the signed player src or a packaged-media mp4', () => {
  /**
   * THE POST IN THE 2026-10-04 REPORT, and the first real capture of a Reddit VIDEO page in this suite
   * (the test above is synthetic). Uploaded 2024-08-14, so its audio is MPEG-TS named .aac, the
   * packaging the container's ffmpeg refused until container/server.py's REDDIT_HLS_HOST. Nothing on
   * this page tells it apart from a video that always muxed, which is why the fix lives in the container
   * and this file only has to keep handing over the same url.
   *
   * WHAT THIS PINS. The page now carries two tempting alternatives, and both are signed to expire: the
   * player's own src (`?f=..&a=..`) and `packaged-media-json`'s ready-muxed mp4s (`e=` at the next UTC
   * midnight in every url seen). A Post sits in the Post cache, the response cache and the alarm's
   * durable mux source for minutes, so either one would let a cached card hand Discord a dead link. The
   * unsigned master never expires, and it was present for 21 of 21 posts from 2018 to 2026 (dev sandbox).
   *
   * 0x0, NOT A SIZE OFF THE PAGE. The <shreddit-aspect-ratio> around this player reads 1 while the video
   * is 360x450, so the gif path's way of sizing a player must never be reused for a video.
   */
  assert.match(VIDEO_PAGE, /packaged-media-json=/, 'the fixture must still carry the thing this test is about')
  const post = normalizeReddit({ source: 'embed', html: VIDEO_PAGE }, { p: 'rd', sub: 'interestingasfuck', id: '1es7hb1' })
  assert.ok(post)
  const hls = 'https://v.redd.it/muy8yipuynid1/HLSPlaylist.m3u8'
  assert.equal(post.media.length, 1)
  const [m] = post.media
  assert.equal(m.kind, 'video')
  assert.equal(m.url, hls)
  assert.deepEqual(m.remux, { video: hls })
  assert.deepEqual([m.w, m.h], [0, 0])
  assert.match(m.poster, /^https:\/\/external-preview\.redd\.it\/[^?]+\?/)
  assert.doesNotMatch(JSON.stringify(post), /packaged-media|SIGNATURE-BLANKED|HLSPlaylist\.m3u8\?/)
  assert.equal(post.title, "Raygun's husband and trainer, Sammie Free. Now it makes sense.")
  assert.equal(post.createdAt.toISOString(), '2024-08-14T17:23:59.843Z')
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
