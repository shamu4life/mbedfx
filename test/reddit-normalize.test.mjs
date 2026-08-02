import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReddit, redditGate } from '../src/platforms/reddit/normalize.ts'

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
