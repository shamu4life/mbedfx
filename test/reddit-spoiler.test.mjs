import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeReddit, redditNeedsCaption } from '../src/platforms/reddit/normalize.ts'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'

/**
 * A WHOLE POST TAGGED AS A SPOILER. Reddit draws it blurred under "This post may contain spoilers."; the card
 * showed its picture, and its caption, in the clear. The owner's call (2026-10-11): the body becomes
 * `[spoiler]` and the media is marked for Discord's blur (the Mastodon `sensitive` flag), and one paste
 * decides whether Discord blurs, drops or ignores it.
 *
 * Fixtures: three embed.reddit.com pages captured that day from a residential IP (see each file's comment).
 * The NSFW one is the control, because Reddit draws the SAME button over adult content.
 */

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const SPOILER_IMAGE = fx('reddit-embed-spoiler-image.html')
const SPOILER_TEXT = fx('reddit-embed-spoiler-text.html')
const NSFW_VIDEO = fx('reddit-embed-nsfw-video.html')
const embed = (html) => ({ source: 'embed', html })
const untag = (html) => html.replace(/<shreddit-embed-spoiler-button\b/g, '<x-untagged')

test('A SPOILER-TAGGED PICTURE POST KEEPS ITS PICTURE AND TITLE, and its body is [spoiler]', () => {
  const post = normalizeReddit(embed(SPOILER_IMAGE), { p: 'rd', sub: 'OnePiece', id: '1x34r8f' })
  assert.equal(post.spoiler, true)
  assert.equal(post.text, '[spoiler]', 'the card says why its picture is blurred, even with no caption to hide')
  assert.equal(post.title, 'Oda would be a character genius', 'Reddit shows the title, and the tag requires a clean one')
  assert.deepEqual(post.media, [{ kind: 'image', url: 'https://i.redd.it/axrijj2fetuh1.jpeg', w: 0, h: 0 }],
    'the media stays: it is blurred, not removed')
  assert.equal(post.sensitive, false, 'a spoiler is not adult content')
})

test('A SPOILER-TAGGED TEXT POST SHOWS NONE OF ITS BODY', () => {
  const ref = { p: 'rd', sub: 'OnePiece', id: '1x2tkke' }
  const post = normalizeReddit(embed(SPOILER_TEXT), ref)
  assert.equal(post.text, '[spoiler]')
  assert.ok(!JSON.stringify(post).includes('Sanji character'), 'the body is nowhere in the Post, so no surface can show it')
  // Not vacuous: the same page with the tag removed carries that body.
  assert.match(normalizeReddit(embed(untag(SPOILER_TEXT)), ref).text, /^Hello\. I have always liked Sanji character/)
})

test('AN NSFW POST WEARS THE SAME BUTTON AND IS NOT A SPOILER', () => {
  // Reddit draws <shreddit-embed-spoiler-button> over adult content too ("This post contains mature or adult
  // content."); the page's own nsfw flag tells the two apart. Read as a spoiler, an NSFW post would lose
  // its `[sensitive]` label to `[spoiler]` and its body to the mask.
  assert.ok(NSFW_VIDEO.includes('<shreddit-embed-spoiler-button'), 'precondition: the control carries the button')
  const post = normalizeReddit(embed(NSFW_VIDEO), { p: 'rd', sub: 'HonkaiStarRail', id: '1x2fqyu' })
  assert.equal('spoiler' in post, false)
  assert.equal(post.sensitive, true)
})

test('EVERY OTHER REDDIT PAGE NORMALIZES EXACTLY AS BEFORE: no spoiler key, inline spoilers still masked in place', () => {
  for (const name of [
    'reddit-embed-gif.html', 'reddit-embed-image-caption.html', 'reddit-embed-link-youtube.html',
    'reddit-embed-multimedia.html', 'reddit-embed-multimedia-figure.html', 'reddit-embed-multimedia-spoiler.html',
    'reddit-embed-text-bullets.html', 'reddit-embed-text-list.html', 'reddit-embed-text-table.html', 'reddit-embed-video.html',
  ]) {
    const html = fx(name)
    assert.ok(!html.includes('<shreddit-embed-spoiler-button'), `precondition: ${name} is untagged`)
    const post = normalizeReddit(embed(html), { p: 'rd', sub: 'x', id: 'abc123' })
    assert.ok(post, name)
    assert.equal('spoiler' in post, false, name)
    assert.notEqual(post.text, '[spoiler]', name)
  }
})

test('THE OAUTH LISTING NAMES THE TAG OUTRIGHT, on the same terms as the page', () => {
  const listing = (over) => [{ data: { children: [{ data: {
    title: 't', author: 'a', created_utc: 1760000000, subreddit: 'OnePiece', permalink: '/r/OnePiece/comments/zz1/t/',
    selftext: 'the reveal', is_self: true, score: 5, num_comments: 1, ...over,
  } }] } }]
  const ref = { p: 'rd', sub: 'OnePiece', id: 'zz1' }
  const tagged = normalizeReddit({ source: 'json', data: listing({ spoiler: true }) }, ref)
  assert.equal(tagged.spoiler, true)
  assert.equal(tagged.text, '[spoiler]')
  const both = normalizeReddit({ source: 'json', data: listing({ spoiler: true, over_18: true }) }, ref)
  assert.equal('spoiler' in both, false, 'NSFW wins, as on the page, because both renders share a cache key')
  assert.equal(both.text, 'the reveal')
})

/** Global fetch answered per host; every request recorded. */
async function withHosts(routes, fn) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    asked.push(url)
    for (const [prefix, answer] of routes) if (url.startsWith(prefix)) return answer(url, init)
    return new Response('', { status: 404 })
  }
  try { return await fn(asked) } finally { globalThis.fetch = real }
}
const page = (body) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })

test('A SPOILER-TAGGED POST ASKS NO CAPTION SOURCE: its body would only be masked', async () => {
  assert.equal(redditNeedsCaption(SPOILER_IMAGE), false)
  assert.equal(redditNeedsCaption(untag(SPOILER_IMAGE)), true, 'not vacuous: the untagged picture post is asked about')
  await withHosts([['https://embed.reddit.com/', page(SPOILER_IMAGE)]], async (asked) => {
    const ref = { p: 'rd', sub: 'OnePiece', id: '1x34r8f' }
    const got = await fetchReddit(ref, {})
    assert.equal(normalizeReddit(got, ref).text, '[spoiler]')
    assert.deepEqual(asked, ['https://embed.reddit.com/r/OnePiece/comments/1x34r8f/'],
      'the embed page only: no crawler page, no rationed feed, no third-party archive')
  })
})

/* ===================== THE CARD, THROUGH handle() ===================== */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = (url) => new Request(url, { headers: { 'user-agent': DISCORD } })
const human = (url) => new Request(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605' } })
const ctx = () => ({ waitUntil() {} })
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const fakeR2 = () => {
  const store = new Map()
  return {
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}
/** A container that never answers: a cold mux, honestly. */
const silentResolver = () => ({ getByName: () => ({ fetch: () => new Promise(() => {}) }) })
const envWith = ({ resolver } = {}) => ({
  AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
  ...(resolver ? { MEDIA_CACHE: fakeR2(), MEDIA_RESOLVER: resolver } : {}),
})
const depsOf = (byKey) => ({
  cache: fakeCache(),
  fetchPost: async (ref) => (typeof byKey[refKey(ref)] === 'function' ? byKey[refKey(ref)](ref) : byKey[refKey(ref)] ?? null),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})
const activity = (ref) => `https://mbedfx.app/users/x/statuses/${encodeStatusId(refKey(ref))}`
const enc = (ref) => encodeURIComponent(refKey(ref))

const rdPost = (ref, over = {}) => ({
  ref, canonical: `https://www.reddit.com/r/${ref.sub}/comments/${ref.id}/t/`,
  author: { name: 'u/someone', handle: 'someone', url: 'https://www.reddit.com/user/someone' },
  title: 'Is this Glitch? or Badluck?', text: '', createdAt: new Date('2026-10-10T00:00:00Z'),
  media: [], counts: { likes: 12, replies: 3 }, sensitive: false, ...over,
})
// A plain progressive mp4 (no remux), so the head's og:video is decided by the spoiler rule alone.
const mp4 = { kind: 'video', url: 'https://v.redd.it/abc123/DASH_720.mp4', w: 1280, h: 720, poster: 'https://external-preview.redd.it/abc.jpg', posterW: 1280, posterH: 720 }

test('THE ACTIVITY DOCUMENT ASKS DISCORD TO BLUR A SPOILER, and only a spoiler', async () => {
  const ref = { p: 'rd', sub: 'OnePiece', id: '1x34r8f' }
  const tagged = normalizeReddit(embed(SPOILER_IMAGE), ref)
  const j = await (await handle(bot(activity(ref)), envWith(), ctx(), depsOf({ [refKey(ref)]: tagged }))).json()
  assert.equal(j.sensitive, true, 'Mastodon\'s blur, which is what the paste test measures')
  assert.equal(j.spoiler_text, '', 'one untested field at a time: the body already says [spoiler]')
  assert.equal(j.media_attachments.length, 1, 'the picture is still sent')
  assert.match(j.content, /\[spoiler\]/)
  assert.doesNotMatch(j.content, /\[sensitive\]/, 'a spoiler is not labelled as adult content')

  // The same post untagged: the document is the one every other post gets, with no `sensitive` key at all.
  const plainRef = { p: 'rd', sub: 'OnePiece', id: '1x34r8g' }
  const plain = normalizeReddit(embed(untag(SPOILER_IMAGE)), plainRef)
  const k = await (await handle(bot(activity(plainRef)), envWith(), ctx(), depsOf({ [refKey(plainRef)]: plain }))).json()
  assert.equal('sensitive' in k, false)
})

test('THE HEAD OF A SPOILER VIDEO NAMES NO MEDIA, and keeps the activity link that carries it', async () => {
  const ref = { p: 'rd', sub: 'HonkaiStarRail', id: 'spv0001' }
  const twin = { p: 'rd', sub: 'HonkaiStarRail', id: 'spv0002' }
  const deps = depsOf({
    [refKey(ref)]: rdPost(ref, { media: [mp4], spoiler: true, text: '[spoiler]' }),
    [refKey(twin)]: rdPost(twin, { media: [mp4] }),
  })
  const head = async (r) => (await handle(bot(`https://mbedfx.app/r/${r.sub}/comments/${r.id}/t/`), envWith(), ctx(), deps)).text()
  const shown = await head(twin)
  assert.match(shown, /og:video/, 'precondition: the untagged twin advertises its video in the head')
  const html = await head(ref)
  assert.doesNotMatch(html, /og:video|og:image|twitter:player|_media\//, 'no picture or video the head could show unblurred')
  assert.match(html, /application\/activity\+json/, 'the document, where the blur is asked for')
  assert.match(html, /twitter:card" content="summary_large_image"/, 'the slideshow head, measured to draw the activity card')
})

test('A SPOILER-TAGGED LINK POST BLURS THE LINKED VIDEO, and its head names no still', async () => {
  // The composition (worker.ts linkedFor) keeps the Reddit post's own fields, so the tag covers the YouTube
  // video it borrows. Untagged, this head carries the linked still (reddit-link.test.mjs).
  const ref = { p: 'rd', sub: 'movies', id: 'spl0001' }
  const yt = { p: 'yt', id: 'splAAAAAAA1' }
  const ytPost = {
    ref: yt, canonical: `https://www.youtube.com/watch?v=${yt.id}`,
    author: { name: 'c', handle: 'c', url: 'https://www.youtube.com/@c' }, title: 'trailer', text: '',
    createdAt: new Date('2026-10-01T00:00:00Z'), counts: {}, sensitive: false,
    media: [{ kind: 'video', url: `https://www.youtube.com/watch?v=${yt.id}`, w: 0, h: 0, poster: `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`, posterW: 480, posterH: 360, remux: { page: `https://www.youtube.com/watch?v=${yt.id}` }, duration: 120 }],
  }
  const deps = depsOf({
    [refKey(ref)]: rdPost(ref, { link: `https://youtu.be/${yt.id}`, spoiler: true, text: '[spoiler]' }),
    [refKey(yt)]: ytPost,
  })
  const j = await (await handle(bot(activity(ref)), envWith({ resolver: silentResolver() }), ctx(), deps)).json()
  assert.equal(j.sensitive, true)
  assert.equal(j.media_attachments[0]?.url, `https://mbedfx.app/_media/${enc(yt)}/0`, 'the linked video, under its own key')
  const html = await (await handle(bot(`https://mbedfx.app/r/${ref.sub}/comments/${ref.id}/t/`), envWith({ resolver: silentResolver() }), ctx(), deps)).text()
  assert.ok(!html.includes('/_media/'), `no still in the head: ${html}`)
  assert.match(html, /application\/activity\+json/)
})

test('THE API AND THE CONVERTER PREVIEW SAY spoiler, and false for every other post', async () => {
  const ref = { p: 'rd', sub: 'OnePiece', id: '1x34r8f' }
  const plainRef = { p: 'rd', sub: 'OnePiece', id: '1x36qa4' }
  const deps = depsOf({
    [refKey(ref)]: normalizeReddit(embed(SPOILER_IMAGE), ref),
    [refKey(plainRef)]: normalizeReddit(embed(untag(SPOILER_IMAGE)), plainRef),
  })
  const api = async (r) => (await (await handle(human(`https://mbedfx.app/_api/v1?url=${encodeURIComponent(`https://www.reddit.com/r/${r.sub}/comments/${r.id}/t/`)}`), envWith(), ctx(), deps)).json()).post
  const card = async (r) => (await handle(human(`https://mbedfx.app/_card?p=${encodeURIComponent(`/r/${r.sub}/comments/${r.id}/t/`)}`), envWith(), ctx(), deps)).json()
  const a = await api(ref)
  assert.equal(a.spoiler, true)
  assert.equal(a.sensitive, false, 'published separately')
  assert.equal(a.text, '[spoiler]')
  assert.equal(a.media.length, 1)
  assert.equal((await api(plainRef)).spoiler, false)
  assert.equal((await card(ref)).spoiler, true, 'the page blurs its preview for this')
  assert.equal((await card(plainRef)).spoiler, false)
})
