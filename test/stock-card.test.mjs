import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
import { stockState } from '../src/render/embed.ts'

/**
 * THE STOCK CARD NAMES THE VIDEO AND THE CHANNEL — fixed 2026-09-04 from the owner's screenshot.
 *
 * On the stock branch the activity link is omitted (that omission IS the stock feature), so the
 * OpenGraph tags and the oEmbed ARE the card. renderSpoof set og:title to the BYLINE for every post,
 * because on every other branch the activity card carries the title and og:title is only fallback
 * insurance; and toOEmbed's author_name is a COUNTS slot whose floor is the literal 'Embed'. So the
 * stock card drew the channel in the title slot and "Embed" in the author slot, and the video's
 * title — on the wire inside og:description, which Discord does not draw on a player card — appeared
 * nowhere. Every test has its own 11-character id (muxInflight is module-level).
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = url => new Request(url, { headers: { 'user-agent': DISCORD } })
const ytRef = id => ({ p: 'yt', id })
const headUrl = ref => `https://mbedfx.app/watch?v=${ref.id}`
const oembedUrl = ref => `https://mbedfx.app/_oembed/${encodeStatusId(refKey(ref))}`
const retainingCtx = () => ({ waitUntil() {} })
const fakeCache = () => { const m = new Map(); return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } } }
function fakeR2(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}
const envWith = ({ resolver, r2 = fakeR2() } = {}) => ({
  AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: r2, MEDIA_RESOLVER: resolver, TRANSLATE_GOOGLE: 'off',
})
const TITLE = 'driving in my car (ultra heavenly version)'
const AUTHOR = { name: 'Іван2006', handle: 'VanyaYouTube2006', url: 'https://www.youtube.com/@VanyaYouTube2006' }
const ytPost = (ref, over = {}) => ({
  ref, canonical: `https://www.youtube.com/watch?v=${ref.id}`, author: AUTHOR, title: TITLE,
  text: '', createdAt: new Date('2026-08-02T00:00:00Z'), counts: {}, sensitive: false,
  media: [{
    kind: 'video', url: `https://www.youtube.com/watch?v=${ref.id}`, w: 0, h: 0,
    poster: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`, posterW: 480, posterH: 360,
    remux: { page: `https://www.youtube.com/watch?v=${ref.id}` }, ...over,
  }],
})
const depsFor = post => ({ cache: fakeCache(), fetchPost: async ref => post(ref), resolveShortlink: async () => ({ kind: 'unresolved' }), resolveRedditShare: async () => null })
const silentResolver = () => ({ getByName: () => ({ fetch: () => new Promise(() => {}) }) })
const ogTitle = html => [...html.matchAll(/<meta property="og:title" content="([^"]*)"\/>/g)].map(m => m[1])
const ogDescription = html => /<meta property="og:description" content="([^"]*)"\/>/.exec(html)?.[1] ?? ''
const BYLINE = 'Іван2006 (@VanyaYouTube2006)'

test('stockState(): yt, no playable video, not sensitive, no promise pending', () => {
  const ref = ytRef('stockst0001')
  assert.equal(stockState({ ...ytPost(ref), media: [{ kind: 'image', url: 'x', w: 1, h: 1, posterOnly: true }] }), true)
  assert.equal(stockState({ ...ytPost(ref), media: [{ kind: 'image', url: 'x', w: 1, h: 1, posterOnly: true, pendingMux: true }] }), false, 'a promise is coming: no stock')
  assert.equal(stockState({ ...ytPost(ref), sensitive: true, media: [{ kind: 'image', url: 'x', w: 1, h: 1 }] }), false, 'age-gated: the embed would demand a sign-in')
  assert.equal(stockState(ytPost(ref)), false, 'a playable video is not a stock state')
  assert.equal(stockState({ ...ytPost(ref), ref: { p: 'x', kind: 'status', id: '1' }, media: [{ kind: 'image', url: 'x', w: 1, h: 1 }] }), false, 'yt only')
})

test('THE STOCK CARD NAMES THE VIDEO, NOT THE CHANNEL — and every other head keeps the byline', async () => {
  // Stock: no duration verdict, cold mux -> the iframe branch. og:title must be the video's title.
  const stock = await (await handle(bot(headUrl(ytRef('stockcd0001'))), envWith({ resolver: silentResolver() }), retainingCtx(), depsFor(r => ytPost(r, { duration: undefined })))).text()
  assert.ok(stock.includes('youtube.com/embed/stockcd0001'), 'this is the stock branch')
  assert.deepEqual(ogTitle(stock), [TITLE], 'the title slot names the video')
  assert.ok(!ogDescription(stock).startsWith(TITLE), 'and og:description does not repeat it')
  // Pending promise (known duration): the activity card carries the title; og:title stays the byline.
  const pending = await (await handle(bot(headUrl(ytRef('stockcd0002'))), envWith({ resolver: silentResolver() }), retainingCtx(), depsFor(r => ytPost(r, { duration: 120 })))).text()
  assert.ok(pending.includes('activity+json') && !pending.includes('youtube.com/embed/'), 'this is the pending head')
  assert.deepEqual(ogTitle(pending), [BYLINE], 'fallback insurance unchanged where the activity card carries the title')
  // Warm: same.
  const ref = ytRef('stockcd0003')
  const warm = await (await handle(bot(headUrl(ref)), envWith({ resolver: silentResolver(), r2: fakeR2({ [`mux/${refKey(ref)}/0`]: 'mp4' }) }), retainingCtx(), depsFor(ytPost))).text()
  assert.ok(/og:video[^>]*_media/.test(warm), 'this is the warm head')
  assert.deepEqual(ogTitle(warm), [BYLINE])
})

test("THE STOCK CARD'S AUTHOR SLOT IS THE CHANNEL, NOT 'Embed'", async () => {
  // The oEmbed link stays on the stock branch (v2 measured the counts row coexisting with the
  // iframe), so its author_name is the card's author slot. A cold yt post has no counts that
  // statParts draws, so authorName fell to the literal 'Embed'. On the stock branch it is the byline.
  const stock = await (await handle(bot(oembedUrl(ytRef('stockoe0001'))), envWith({ resolver: silentResolver() }), retainingCtx(), depsFor(r => ytPost(r, { duration: undefined })))).json()
  assert.equal(stock.author_name, BYLINE)
  assert.equal(stock.author_url, AUTHOR.url, 'and it links to the channel')
  assert.equal(stock.title, 'Embed', 'the oEmbed title is not what Discord draws; the literal stays')
  // Pending: the activity card draws the author itself, so the counts slot keeps its meaning.
  const pending = await (await handle(bot(oembedUrl(ytRef('stockoe0002'))), envWith({ resolver: silentResolver() }), retainingCtx(), depsFor(r => ytPost(r, { duration: 120 })))).json()
  assert.equal(pending.author_name, 'Embed', 'no counts, no reply: the floor, as before')
  assert.equal(pending.author_url, `https://www.youtube.com/watch?v=stockoe0002`)
})
