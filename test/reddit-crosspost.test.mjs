import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeReddit, redditCrosspostNeeds, redditGifUrl, crawlerPoster, redditCaptionSource } from '../src/platforms/reddit/normalize.ts'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'

/**
 * A CROSSPOST OF A REDDIT PICTURE, GIF, VIDEO OR GALLERY CARRIES THE PARENT'S MEDIA. It was title-only: the
 * crosspost's page has no media of its own and names no parent id, only the parent's `url` (28 of 28 live
 * crossposts, residential, 2026-10-11). The owner asked for pictures and videos together.
 *
 * Fixtures are real pages captured that day from a residential IP (each file says which post): an image, a gif,
 * a video and a gallery crosspost; the video's crawler page (its poster) and the one crawler page in ten that
 * named Reddit's logo instead; the gallery's parent page and that parent's `_` placeholder render.
 */

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const XP_IMAGE = fx('reddit-embed-xpost-image.html')
const XP_GIF = fx('reddit-embed-xpost-gif.html')
const XP_VIDEO = fx('reddit-embed-xpost-video.html')
const XP_GALLERY = fx('reddit-embed-xpost-gallery.html')
const CRAWLER_VIDEO = fx('reddit-crawler-xpost-video.html')
const CRAWLER_LOGO = fx('reddit-crawler-xpost-logo.html')
const PARENT_GALLERY = fx('reddit-embed-gallery-parent.html')
const PARENT_PLACEHOLDER = fx('reddit-embed-gallery-placeholder.html')

const read = (html, extra = {}) => normalizeReddit({ source: 'embed', html, ...extra }, { p: 'rd', sub: 'x', id: 'abc123' })
const HLS = 'https://v.redd.it/gndqe7i7abuh1/HLSPlaylist.m3u8'
const POSTER = 'https://external-preview.redd.it/self-cleaning-toilet-stalls-v0-dTNjbmRxZzdhYnVoMdBdD-rfmIm2622dzQCasaEzTV2bdmS8GEN02wSLMLGO.png?format=pjpg&auto=webp&s=aae95f4585a1256df37150a859df15d037753106'

test('AN IMAGE CROSSPOST IS ITS PARENT\'S PICTURE, read off the url Reddit copies, and nothing more is fetched', () => {
  assert.deepEqual(read(XP_IMAGE).media, [{ kind: 'image', url: 'https://i.redd.it/nliuxopzzauh1.png', w: 0, h: 0 }])
  assert.equal(redditCrosspostNeeds(XP_IMAGE), null)
})

test('A GIF CROSSPOST IS ITS PARENT\'S .gif, sized from its header like any Reddit gif', () => {
  const raw = { source: 'embed', html: XP_GIF }
  assert.equal(redditGifUrl(raw), 'https://i.redd.it/43dvfo4tvarh1.gif', 'so fetch.ts reads its first ten bytes')
  const head = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]) // GIF89a 320x240
  assert.deepEqual(read(XP_GIF, { gifHead: head }).media, [{ kind: 'gif', url: 'https://i.redd.it/43dvfo4tvarh1.gif', w: 320, h: 240 }])
})

test('A VIDEO CROSSPOST PLAYS ITS PARENT\'S VIDEO, under the poster its crawler page names, at the poster\'s size', () => {
  assert.deepEqual(redditCrosspostNeeds(XP_VIDEO), { poster: true })
  assert.deepEqual(read(XP_VIDEO, { caption: { crawler: CRAWLER_VIDEO } }).media, [{
    kind: 'video', url: HLS, w: 0, h: 0, poster: POSTER, posterW: 405, posterH: 720, remux: { video: HLS },
  }], 'the HLS master, as a video post\'s, and the 405x720 still Discord can draw while it muxes')
})

test('NO POSTER, NO VIDEO: Reddit\'s logo, a share card or a missing crawler page leaves the video out', () => {
  // Without a still the entry could never degrade (normalize.ts's video branch makes the same refusal), and a
  // wrong still would be drawn as the video's picture. Absent is safe: index 0 is a 404, never a second kind.
  assert.equal(crawlerPoster(CRAWLER_LOGO), null, 'i.redd.it/o0h58lzmax6a1.png, "Reddit logo", 1 crawler page in 10')
  assert.deepEqual(read(XP_VIDEO, { caption: { crawler: CRAWLER_LOGO } }).media, [])
  const shareCard = '<meta property="og:image" content="https://share.redd.it/preview/post/1x00xeb"><meta property="og:image:width" content="1120">'
  assert.equal(crawlerPoster(shareCard), null, 'a /user/ page\'s generated share card')
  assert.deepEqual(read(XP_VIDEO).media, [], 'the crawler page did not answer')
  assert.deepEqual(read(XP_VIDEO, { caption: { crawler: '<html>blocked by network security</html>' } }).media, [])
})

test('A GALLERY CROSSPOST SHOWS ITS PARENT\'S SLIDES, and only from the page of the post its url names', () => {
  assert.deepEqual(redditCrosspostNeeds(XP_GALLERY), { gallery: '1x2epoi' })
  assert.deepEqual(read(XP_GALLERY, { parent: PARENT_GALLERY }).media, [
    { kind: 'image', url: 'https://i.redd.it/6gyj38m51nuh1.jpg', w: 0, h: 0 },
    { kind: 'image', url: 'https://i.redd.it/3xnni7m51nuh1.jpg', w: 0, h: 0 },
  ])
  assert.deepEqual(read(XP_GALLERY, { parent: PARENT_PLACEHOLDER }).media, [], 'the placeholder render has no carousel')
  assert.deepEqual(read(XP_GALLERY, { parent: XP_IMAGE }).media, [], 'another post\'s page is not this gallery')
  assert.deepEqual(read(XP_GALLERY).media, [], 'the parent did not answer')
})

test('A CROSSPOST OF A TEXT POST, OR A REMOVED ONE, STAYS AS IT WAS', () => {
  const text = XP_VIDEO.replaceAll('https://v.redd.it/gndqe7i7abuh1', 'https://www.reddit.com/r/OnePiece/comments/1x0v3v9/a_title/')
  assert.equal(redditCrosspostNeeds(text), null)
  assert.deepEqual(read(text, { caption: { crawler: CRAWLER_VIDEO } }).media, [])
  const removed = XP_VIDEO.replaceAll('https://v.redd.it/gndqe7i7abuh1', 'https://www.reddit.com/r/accelerate/comments/1x1w6rq/removed_by_moderator/')
  assert.deepEqual(read(removed, { caption: { crawler: CRAWLER_VIDEO } }).media, [])
})

/* ===================== THE FETCHES ===================== */

/** Global fetch answered per url prefix (the first that matches); every request recorded. */
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
const page = (body, status = 200, ms = 0) => async () => {
  if (ms) await new Promise(r => setTimeout(r, ms))
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}
const SPOILER_BUTTON = '<div class="spoiler-button"><shreddit-embed-spoiler-button></shreddit-embed-spoiler-button></div>'

test('A VIDEO CROSSPOST\'S POSTER RIDES ON THE CRAWLER PAGE THE CAPTION LOOKUP ALREADY READS', async () => {
  const ref = { p: 'rd', sub: 'accelerate', id: '1x1w6rq' }
  await withHosts([
    ['https://embed.reddit.com/r/accelerate/comments/1x1w6rq/', page(XP_VIDEO)],
    ['https://www.reddit.com/r/accelerate/comments/1x1w6rq/', page(CRAWLER_VIDEO, 301)],
  ], async (asked) => {
    const got = await fetchReddit(ref, {})
    assert.equal(normalizeReddit(got, ref).media[0]?.url, HLS)
    assert.equal(redditCaptionSource(got), 'none', 'its description is the tagline, refused as before')
    assert.equal(asked.length, 2, `the embed page and the crawler page, nothing new: ${asked}`)
  })
})

test('A SPOILER-TAGGED VIDEO CROSSPOST STILL READS ITS POSTER, and nothing else: no feed, no archive', async () => {
  // The spoiler change stopped every caption source for a spoiler-tagged post, which would have cost this
  // video its only poster. The crawler page is now read for the poster alone.
  const ref = { p: 'rd', sub: 'accelerate', id: '1x1w6rq' }
  const tagged = XP_VIDEO.replace('</body>', `${SPOILER_BUTTON}</body>`)
  assert.notEqual(tagged, XP_VIDEO, 'precondition: the button went in')
  await withHosts([
    ['https://embed.reddit.com/', page(tagged)],
    ['https://www.reddit.com/r/accelerate/comments/1x1w6rq/', page(CRAWLER_VIDEO, 301)],
  ], async (asked) => {
    const got = await fetchReddit(ref, {})
    const post = normalizeReddit(got, ref)
    assert.equal(post.spoiler, true)
    assert.equal(post.text, '[spoiler]')
    assert.equal(post.media[0]?.poster, POSTER, 'blurred in Discord, but there')
    assert.equal(redditCaptionSource(got), null, 'a poster read is not a caption lookup, so no body_* is counted')
    assert.deepEqual(asked.map(u => new URL(u).hostname), ['embed.reddit.com', 'www.reddit.com'])
  })
})

test('A GALLERY CROSSPOST READS ITS PARENT AS `_`, THEN UNDER THE SUBREDDIT THAT NAMES, beside the caption lookup', async () => {
  const ref = { p: 'rd', sub: 'electrical', id: '1x2eq29' }
  // Each source is slow on purpose: read one after another they take 900 ms, side by side the slower one.
  await withHosts([
    ['https://embed.reddit.com/r/electrical/comments/1x2eq29/', page(XP_GALLERY)],
    ['https://embed.reddit.com/r/_/comments/1x2epoi/', page(PARENT_PLACEHOLDER, 200, 200)],
    ['https://embed.reddit.com/r/AskElectricians/comments/1x2epoi/', page(PARENT_GALLERY, 200, 200)],
    ['https://www.reddit.com/r/electrical/comments/1x2eq29/', page('<meta name="description" content="I&#x27;m looking to have an EV charger installed.">', 301, 500)],
  ], async (asked) => {
    const t0 = Date.now()
    const got = await fetchReddit(ref, {})
    const ms = Date.now() - t0
    const post = normalizeReddit(got, ref)
    assert.equal(post.media.length, 2, 'the parent\'s two slides')
    assert.equal(post.text, "I'm looking to have an EV charger installed.", 'and the crosspost\'s own caption')
    assert.ok(asked.includes('https://embed.reddit.com/r/_/comments/1x2epoi/'))
    assert.ok(asked.includes('https://embed.reddit.com/r/AskElectricians/comments/1x2epoi/'))
    assert.ok(ms < 800, `the parent and the caption are read side by side: ${ms}ms`)
  })
})

test('A GALLERY PARENT THAT DOES NOT ANSWER COSTS THE SLIDES, NEVER THE POST', async () => {
  const ref = { p: 'rd', sub: 'electrical', id: '1x2eq29' }
  await withHosts([
    ['https://embed.reddit.com/r/electrical/comments/1x2eq29/', page(XP_GALLERY)],
    ['https://embed.reddit.com/r/_/', () => { throw new TypeError('connection reset') }],
  ], async (asked) => {
    const post = normalizeReddit(await fetchReddit(ref, {}), ref)
    assert.equal(post.title, 'Help with Panel and EV Charger')
    assert.deepEqual(post.media, [])
    assert.ok(!asked.some(u => u.includes('/r/AskElectricians/')), 'no subreddit learned, so no second ask')
  })
})

/* ===================== THE CARD ===================== */

test('THE CARD OF A VIDEO CROSSPOST PLAYS FROM ITS OWN KEY, its poster beside it', async () => {
  // The entry is an ordinary Reddit `{video}` remux, so the card is a Reddit video's: armed, not raced, and the
  // document names the video at the crosspost's own /_media/ key.
  const ref = { p: 'rd', sub: 'accelerate', id: '1x1w6rq' }
  const post = normalizeReddit({ source: 'embed', html: XP_VIDEO, caption: { crawler: CRAWLER_VIDEO } }, ref)
  const deps = {
    cache: { async match() { return undefined }, async put() {} },
    fetchPost: async () => post,
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
  }
  const env = {
    AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
    MEDIA_CACHE: { async head() { return null }, async get() { return null }, async put() {} },
    MEDIA_RESOLVER: { getByName: () => ({ fetch: () => new Promise(() => {}) }) },
  }
  const req = new Request(`https://mbedfx.app/users/x/statuses/${encodeStatusId(refKey(ref))}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } })
  const j = await (await handle(req, env, { waitUntil() {} }, deps)).json()
  const [a] = j.media_attachments
  const key = encodeURIComponent(refKey(ref))
  assert.equal(a?.type, 'video', 'the crosspost plays now')
  assert.equal(a.url, `https://mbedfx.app/_media/${key}/0`, 'under the crosspost\'s own key')
  assert.equal(a.preview_url, `https://mbedfx.app/_media/${key}/poster0`)
})
