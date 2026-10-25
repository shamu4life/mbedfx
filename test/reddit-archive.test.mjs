import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'
import { normalizeReddit, redditCaptionSource, redditEmbedRefused } from '../src/platforms/reddit/normalize.ts'
import { liveFetchPost } from '../src/worker.ts'

/**
 * THE ARCHIVE PATH: every Reddit card since embed.reddit.com began refusing Cloudflare's egress on
 * 2026-10-22 (normalize.ts, "Archive path", has the measurements). Every Reddit link was the failure card
 * for three days before it, the reported one being r/aww/comments/bh1r38.
 *
 * FIXTURES. reddit-blocked-*.html are Reddit's crawler page as Discordbot with redirects not followed,
 * captured 2026-10-25 from a Cloudflare Worker (the Workers Playground, colo IAD) while embed.reddit.com
 * answered that same egress 403 (each file's first line says so). reddit-blocked-archive.json holds the
 * Arctic Shift records of the same posts, read the same day from the Claude Code dev sandbox, not a Worker:
 * the archive is not Reddit and served the Worker the same record shape (200, 866 ms). Each record is as
 * received except `all_awardings`, dropped because r/pics/comments/haucpf's alone ran to ~250 KB.
 */

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const RECORDS = JSON.parse(fx('reddit-blocked-archive.json')).data
/** The archive's answer for one id, as the fetcher asks for it: `{"data":[record]}`, or `[]` when it has none. */
const answer = (id, edit = r => r) => JSON.stringify({ data: RECORDS.filter(r => r.id === id).map(r => edit(structuredClone(r))) })
const crawler = kind => fx(`reddit-blocked-${kind}.html`)
const archived = (id, kind, edit) => ({ ok: true, source: 'archive', id, archive: answer(id, edit), crawler: crawler(kind) })
const media = post => post.media.map(m => `${m.kind} ${m.url}`)

/** The block page embed.reddit.com answers our egress with: HTTP 403, text/plain, these 40 bytes. */
const BLOCK = "You've been blocked by network security."

test('an archive card is the embed card\'s twin: the same media kind and url at every index, and the same post', () => {
  /**
   * THE INVARIANT THAT MAKES TWO SOURCES SAFE. Both renders land under one post's cache keys, and Discord's
   * media proxy keeps a /_media/{key}/{i} url by url, so index i has to be the same kind from either source or
   * a url promised as a video serves a picture (normalize.ts redditGifUrl). Eleven posts, one of every type
   * the embed fixtures cover, rendered from their embed capture (residential, 2026-10-11) and from their
   * archive capture (2026-10-25). The dates differ only below the second: the embed page carries
   * milliseconds, the archive whole seconds.
   */
  const pairs = [
    ['reddit-embed-gif.html', 'gif', 'forsen', '1wuh1g1', {}],
    ['reddit-embed-gallery-parent.html', 'gallery', 'AskElectricians', '1x2epoi', {}],
    ['reddit-embed-multimedia-figure.html', 'multimedia', 'DeadlockTheGame', '1x2wg7e', {}],
    ['reddit-embed-xpost-video.html', 'xpost-video', 'accelerate', '1x1w6rq', { caption: { crawler: fx('reddit-crawler-xpost-video.html') } }],
    ['reddit-embed-nsfw-video.html', 'nsfw-video', 'HonkaiStarRail', '1x2fqyu', {}],
    ['reddit-embed-profile.html', 'profile', 'u_NekkidSnaku', '1x1vfk8', {}],
    ['reddit-embed-xpost-gallery.html', 'xpost-gallery', 'electrical', '1x2eq29', { parent: fx('reddit-embed-gallery-parent.html') }],
    ['reddit-embed-xpost-gif.html', 'xpost-gif', 'reactions', '1woblnl', {}],
    ['reddit-embed-link-youtube.html', 'link', 'theydidthemath', '1mizdfz', {}],
    ['reddit-embed-spoiler-image.html', 'spoiler-image', 'OnePiece', '1x34r8f', {}],
    ['reddit-embed-spoiler-text.html', 'spoiler-text', 'OnePiece', '1x2tkke', {}],
  ]
  for (const [embedFx, kind, sub, id, extra] of pairs) {
    const ref = { p: 'rd', sub, id }
    const e = normalizeReddit({ ok: true, source: 'embed', html: fx(embedFx), ...extra }, ref)
    const a = normalizeReddit(archived(id, kind), ref)
    assert.ok(e && a, `${id}: both renders load`)
    assert.deepEqual(media(a), media(e), `${id}: the media`)
    for (const k of ['title', 'canonical', 'sensitive', 'spoiler', 'link']) assert.equal(a[k], e[k], `${id}: ${k}`)
    assert.deepEqual([a.ref, a.author.name], [e.ref, e.author.name], `${id}: the ref and the author`)
    assert.equal(Math.floor(e.createdAt.getTime() / 1000), a.createdAt.getTime() / 1000, `${id}: the date, to the second`)
  }
})

test('the reported post renders: r/aww/comments/bh1r38 is its video, its 2019 date and Reddit\'s own counts today', () => {
  const ref = { p: 'rd', sub: 'aww', id: 'bh1r38' }
  const post = normalizeReddit(archived('bh1r38', 'video'), ref)
  assert.equal(post.title, 'Apparently reptiles like squeaky toys too')
  assert.equal(post.author.name, 'u/7937397')
  assert.equal(post.createdAt.toISOString(), '2019-04-24T23:47:31.000Z')
  // Reddit's page says "12K votes, 202 comments" today; the archive froze at 10890 and 182 in 2019, and the
  // card is for today. Reddit rounds to the thousand, so 12K is what the card can honestly say.
  assert.deepEqual(post.counts, { likes: 12000, replies: 202 })
  assert.equal(post.media.length, 1)
  const [v] = post.media
  assert.equal(v.kind, 'video')
  assert.equal(v.url, 'https://v.redd.it/z13kdo73uau21/HLSPlaylist.m3u8')
  assert.deepEqual(v.remux, { video: v.url })
  assert.match(v.poster, /^https:\/\/external-preview\.redd\.it\//)
  assert.deepEqual([v.posterW, v.posterH], [640, 640])
  assert.equal(post.text, '', 'the crawler page\'s description is the subreddit\'s tagline, not a body')
})

test('a post renders from the archive ONLY when Reddit\'s live title is the archived one, so nothing removed comes back', () => {
  /**
   * The rule that keeps an archive from resurrecting a post. Each refusal here is a measured page: a
   * moderator's removal (titled "[ Removed by moderator ]", one of them NSFW), and the generic page an id
   * that does not exist gets. The rest are the shapes it must also refuse: a block page where the crawler
   * page should be, nothing at all, an archived title Reddit no longer shows, and no record for the id.
   */
  const refuse = (got, why) => assert.equal(normalizeReddit(got, { p: 'rd', sub: 'AskReddit', id: got.id }), null, why)
  refuse(archived('1xbami4', 'removed'), 'removed by a moderator: the archive still holds its title and must not be shown')
  refuse(archived('1xbak2d', 'removed-nsfw'), 'removed by a moderator, NSFW')
  refuse({ ok: true, source: 'archive', id: 'zzzzzzz', archive: answer('zzzzzzz'), crawler: crawler('nonexistent') }, 'no such post')
  refuse({ ...archived('bh1r38', 'video'), crawler: `<html><body>${BLOCK}</body></html>` }, 'a block page vouches for nothing')
  refuse({ ...archived('bh1r38', 'video'), crawler: '' }, 'an empty answer vouches for nothing')
  refuse(archived('bh1r38', 'video', r => ({ ...r, title: `${r.title} (edited)` })), 'a title Reddit does not show')
  refuse({ ...archived('bh1r38', 'video'), archive: answer('haucpf') }, 'the archive answered about another post')
  refuse({ ...archived('bh1r38', 'video'), archive: '<html>522</html>' }, 'the archive did not answer')
})

test('the fields that can change are Reddit\'s or left out; the archive\'s frozen counts are never shown', () => {
  // 1x2epoi: the archive read it 4.7 hours in, at a score of 1 and 27 comments. Reddit's page prints neither
  // count for it (its description is the body, its og:description generic), so the card carries none.
  const gallery = normalizeReddit(archived('1x2epoi', 'gallery'), { p: 'rd', sub: 'AskElectricians', id: '1x2epoi' })
  assert.deepEqual(gallery.counts, { likes: undefined, replies: undefined })
  // The body: Reddit cut its description short, the archive's text continues it exactly, so the card carries
  // the archive's whole text (caption.ts pickCaption, the rule the embed path's captions already used).
  assert.ok(gallery.text.startsWith('I’m looking to have an EV charger installed.'))
  assert.ok(gallery.text.length > 300, `the archive completed the body Reddit cut: ${gallery.text.length}`)
  assert.equal(redditCaptionSource(archived('1x2epoi', 'gallery')), 'archive')
  // 1x1w6rq: the archive's author is replaced by the one Reddit's page prints ("Posted by FuManBoobs").
  const xp = normalizeReddit(archived('1x1w6rq', 'xpost-video', r => ({ ...r, author: 'SomeoneElse' })), { p: 'rd', sub: 'accelerate', id: '1x1w6rq' })
  assert.equal(xp.author.name, 'u/FuManBoobs')
  assert.deepEqual(xp.counts, { likes: 163, replies: 74 })
  // 1xbannz: a live post whose page has no og tags at all (11 of 40 in the AskReddit sample) keeps the archive's
  // author and shows no counts.
  const bare = normalizeReddit(archived('1xbannz', 'no-og'), { p: 'rd', sub: 'AskReddit', id: '1xbannz' })
  assert.equal(bare.author.name, 'u/Weak-Comfortable-778')
  assert.deepEqual(bare.counts, { likes: undefined, replies: undefined })
})

test('NSFW is either source\'s, and a spoiler hides the body, with NSFW winning when a post is both', () => {
  const nsfw = (got, sub) => normalizeReddit(got, { p: 'rd', sub, id: got.id }).sensitive
  assert.equal(nsfw(archived('1x2fqyu', 'nsfw-video'), 'HonkaiStarRail'), true)
  // Reddit's "[Mature Content]" alone, as for a post marked NSFW after the archive read it.
  assert.equal(nsfw(archived('1x2fqyu', 'nsfw-video', r => ({ ...r, over_18: false })), 'HonkaiStarRail'), true)
  // The archive's flag alone, for a page with no og:title to carry Reddit's mark.
  assert.equal(nsfw(archived('1xbannz', 'no-og', r => ({ ...r, over_18: true })), 'AskReddit'), true)
  assert.equal(nsfw(archived('1xbannz', 'no-og'), 'AskReddit'), false)

  const text = normalizeReddit(archived('1x2tkke', 'spoiler-text'), { p: 'rd', sub: 'OnePiece', id: '1x2tkke' })
  assert.equal(text.text, '[spoiler]')
  assert.equal(text.spoiler, true)
  assert.equal(redditCaptionSource(archived('1x2tkke', 'spoiler-text')), null, 'a body nobody is shown is not counted')
  // 1x34r8f: Reddit blurs a spoiler's og:image (`blur=40`), which marks it even when the archive's flag is stale.
  const image = normalizeReddit(archived('1x34r8f', 'spoiler-image', r => ({ ...r, spoiler: false })), { p: 'rd', sub: 'OnePiece', id: '1x34r8f' })
  assert.equal(image.spoiler, true)
  const both = normalizeReddit(archived('1x2tkke', 'spoiler-text', r => ({ ...r, over_18: true })), { p: 'rd', sub: 'OnePiece', id: '1x2tkke' })
  assert.equal(both.spoiler, undefined, 'an NSFW post reads as NSFW only, as on the embed path')
  assert.equal(both.sensitive, true)
})

test('a link under the wrong subreddit still renders the post, and that subreddit\'s tagline is not taken for its body', () => {
  // Measured: asked as r/pics, Reddit serves r/aww's bh1r38 with r/pics's tagline in its description.
  const post = normalizeReddit(archived('bh1r38', 'wrong-sub'), { p: 'rd', sub: 'pics', id: 'bh1r38' })
  assert.equal(post.ref.sub, 'aww')
  assert.equal(post.canonical, 'https://www.reddit.com/r/aww/comments/bh1r38/apparently_reptiles_like_squeaky_toys_too/')
  assert.equal(post.text, '')
})

test('embed.reddit.com refusing us is told apart from it answering that the post is not there', () => {
  assert.equal(redditEmbedRefused(403, BLOCK), true, 'the block page measured 2026-10-25')
  assert.equal(redditEmbedRefused(200, `<html>${BLOCK}</html>`), true, 'the block page by its words, whatever the status')
  assert.equal(redditEmbedRefused(429, ''), true)
  assert.equal(redditEmbedRefused(503, '<html>oops</html>'), true)
  // Reddit's not-found shell is HTTP 200 for every bad or deleted id: an answer about the post, never a
  // reason to ask an archive instead.
  assert.equal(redditEmbedRefused(200, '<html><body>no post here</body></html>'), false)
  assert.equal(redditEmbedRefused(403, '<input id="canonical-url-updater" value="https://www.reddit.com/r/x/comments/1/">'), false)
})

/** Run `fn` with fetch answering each url prefix by its handler; anything else fails the test. */
async function withHosts(hosts, fn) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    asked.push({ url, at: Date.now(), init })
    const hit = hosts.find(([prefix]) => url.startsWith(prefix))
    if (!hit) throw new Error(`unexpected fetch ${url}`)
    return hit[1](url, init)
  }
  try { return await fn(asked) } finally { globalThis.fetch = real }
}
const blocked = () => new Response(BLOCK, { status: 403, headers: { 'content-type': 'text/plain' } })
const archiveOf = id => () => new Response(answer(id), { status: 200, headers: { 'content-type': 'application/json' } })
const page = (kind, status = 301) => () => new Response(crawler(kind), { status, headers: { 'content-type': 'text/html' } })
const slow = (ms, f) => async (...a) => { await new Promise(r => setTimeout(r, ms)); return f(...a) }

test('a refused embed page sends the fetch to the archive and Reddit\'s crawler page, asked side by side', async () => {
  await withHosts([
    ['https://embed.reddit.com/', blocked],
    ['https://arctic-shift.photon-reddit.com/', slow(60, archiveOf('bh1r38'))],
    ['https://www.reddit.com/r/aww/comments/bh1r38/', page('video')],
  ], async (asked) => {
    const ref = { p: 'rd', sub: 'aww', id: 'bh1r38' }
    const got = await fetchReddit(ref, {})
    assert.equal(got.ok, true)
    assert.equal(got.source, 'archive')
    assert.equal(normalizeReddit(got, ref).title, 'Apparently reptiles like squeaky toys too')
    const at = prefix => asked.find(a => a.url.startsWith(prefix))
    assert.equal(at('https://arctic-shift.photon-reddit.com/').url, 'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=bh1r38')
    assert.ok(at('https://www.reddit.com/').at < at('https://arctic-shift.photon-reddit.com/').at + 50, 'the crawler page did not wait for the archive')
    const h = new Headers(at('https://www.reddit.com/').init.headers)
    assert.match(h.get('user-agent'), /Discordbot/)
    assert.equal(at('https://www.reddit.com/').init.redirect, 'manual', 'the 301 itself carries the page; following it gives a share card')
    assert.equal(asked.filter(a => a.url.startsWith('https://embed.reddit.com/')).length, 1, 'a 403 is an answer, not asked twice')
  })
})

test('a bare /comments/{id} link asks the crawler page under the subreddit the archive names', async () => {
  await withHosts([
    ['https://embed.reddit.com/', blocked],
    ['https://arctic-shift.photon-reddit.com/', archiveOf('bh1r38')],
    ['https://www.reddit.com/r/aww/comments/bh1r38/', page('video')],
  ], async (asked) => {
    const ref = { p: 'rd', id: 'bh1r38' }
    const got = await fetchReddit(ref, {})
    assert.equal(got.source, 'archive')
    assert.equal(normalizeReddit(got, ref).ref.sub, 'aww')
    assert.deepEqual(asked.map(a => a.url), [
      'https://embed.reddit.com/r/_/comments/bh1r38/',
      'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=bh1r38',
      'https://www.reddit.com/r/aww/comments/bh1r38/',
    ])
  })
})

test('a page saying the post is not there is final: the archive is never asked to overrule Reddit', async () => {
  await withHosts([
    ['https://embed.reddit.com/', () => new Response('<html><body>no post here</body></html>', { status: 200 })],
  ], async (asked) => {
    const got = await fetchReddit({ p: 'rd', sub: 'aww', id: 'bh1r38' }, {})
    assert.deepEqual(got, { ok: false, reason: 'assert_fail' })
    assert.equal(asked.length, 1)
  })
})

test('a refusal the archive cannot carry is the failure it was, marked as a refusal', async () => {
  for (const [why, hosts] of [
    ['no record', [['https://arctic-shift.photon-reddit.com/', () => new Response('{"data":[]}', { status: 200 })]]],
    ['the archive down', [['https://arctic-shift.photon-reddit.com/', () => new Response('<html>522</html>', { status: 522 })]]],
    ['the crawler page down', [
      ['https://arctic-shift.photon-reddit.com/', archiveOf('bh1r38')],
      ['https://www.reddit.com/', () => { throw new TypeError('connection reset') }],
    ]],
  ]) {
    await withHosts([['https://embed.reddit.com/', blocked], ['https://www.reddit.com/', page('video')], ...hosts].reverse(), async () => {
      const got = await fetchReddit({ p: 'rd', sub: 'aww', id: 'bh1r38' }, {})
      assert.deepEqual(got, { ok: false, reason: 'assert_fail', refused: true }, why)
    })
  }
})

test('on the archive path a gif is still sized from its first ten bytes, and a link post still names its link early', async () => {
  const GIF_HEAD = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])
  await withHosts([
    ['https://embed.reddit.com/', blocked],
    ['https://arctic-shift.photon-reddit.com/', archiveOf('1wuh1g1')],
    ['https://www.reddit.com/r/forsen/', page('gif')],
    ['https://i.redd.it/4gg2f32z3qsh1.gif', () => new Response(GIF_HEAD, { status: 206, headers: { 'content-type': 'image/gif' } })],
  ], async () => {
    const ref = { p: 'rd', sub: 'forsen', id: '1wuh1g1' }
    const got = await fetchReddit(ref, {})
    assert.deepEqual(normalizeReddit(got, ref).media, [{ kind: 'gif', url: 'https://i.redd.it/4gg2f32z3qsh1.gif', w: 320, h: 240 }])
  })
  await withHosts([
    ['https://embed.reddit.com/', blocked],
    ['https://arctic-shift.photon-reddit.com/', archiveOf('1mizdfz')],
    ['https://www.reddit.com/r/theydidthemath/', page('link')],
  ], async () => {
    const told = []
    const ref = { p: 'rd', sub: 'theydidthemath', id: '1mizdfz' }
    const got = await fetchReddit(ref, {}, link => told.push(link))
    assert.deepEqual(told, ['https://youtu.be/6j7bugx2hvk'])
    assert.equal(normalizeReddit(got, ref).link, 'https://youtu.be/6j7bugx2hvk')
  })
})

test('every refusal is counted as embed_refused, beside ok or assert_fail, so the operator sees the block', async () => {
  const rows = []
  const env = { AE: { writeDataPoint: p => rows.push(p.blobs.slice(0, 2).join(' ')) }, TRANSLATE_GOOGLE: 'off' }
  await withHosts([
    ['https://embed.reddit.com/', blocked],
    ['https://arctic-shift.photon-reddit.com/', archiveOf('bh1r38')],
    ['https://www.reddit.com/r/aww/', page('video')],
  ], async () => {
    const post = await liveFetchPost({ p: 'rd', sub: 'aww', id: 'bh1r38' }, env, 'discord')
    assert.equal(post?.title, 'Apparently reptiles like squeaky toys too')
  })
  assert.ok(rows.includes('rd embed_refused'), JSON.stringify(rows))
  rows.length = 0
  await withHosts([
    ['https://embed.reddit.com/', blocked],
    ['https://arctic-shift.photon-reddit.com/', () => new Response('{"data":[]}', { status: 200 })],
    ['https://www.reddit.com/r/aww/', page('video')],
  ], async () => {
    assert.equal(await liveFetchPost({ p: 'rd', sub: 'aww', id: 'bh1r38' }, env, 'discord'), null)
  })
  assert.deepEqual(rows.filter(r => r.startsWith('rd ')), ['rd embed_refused', 'rd assert_fail'])
})
