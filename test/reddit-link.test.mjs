import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'

/**
 * A REDDIT LINK POST CARRIES ITS LINKED POST'S MEDIA. Reported 2026-10-11 on r/theydidthemath/comments/1mizdfz,
 * which is a YouTube video and nothing else: the card showed its title and no video.
 *
 * The composition (worker.ts linkedFor, tagLinked, withLinked) loads the linked post through the same post
 * cache a direct paste uses, settles it AS ITSELF, and hands its entries to the Reddit card tagged `via`, so
 * every url names the YouTube key. These tests pin that through handle(), with every upstream stubbed, on the
 * four seams Discord, the converter and the API read: the activity document, the head, /_api/v1 and /_card,
 * and the d./.mp4 file link. Each test has its own ids: muxInflight is a module-level map.
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = url => new Request(url, { headers: { 'user-agent': DISCORD } })
const human = url => new Request(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605' } })
const retainingCtx = () => ({ waitUntil() {} })
const fakeCache = () => {
  const m = new Map()
  return { store: m, async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const fakeR2 = () => {
  const store = new Map()
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}
const recordingAE = () => { const rows = []; return { rows, writeDataPoint(d) { rows.push(d) } } }
const rowsOf = (ae, outcome) => ae.rows.filter(r => r.blobs?.[1] === outcome)
/** A container that never answers: a cold mux, honestly. */
const silentResolver = () => ({ getByName: () => ({ fetch: () => new Promise(() => {}) }) })
/** A container that refuses at once, for the seams that would otherwise wait out a 9 s budget. */
const failingResolver = () => ({ getByName: () => ({ fetch: async () => new Response('', { status: 502 }) }) })
const envWith = ({ ae = recordingAE(), resolver = silentResolver() } = {}) => ({
  AE: ae, ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: fakeR2(), MEDIA_RESOLVER: resolver, TRANSLATE_GOOGLE: 'off',
})

const rdRef = id => ({ p: 'rd', sub: 'theydidthemath', id })
const redditPost = (ref, link) => ({
  ref, canonical: `https://www.reddit.com/r/${ref.sub}/comments/${ref.id}/self_i_did_the_math/`,
  author: { name: 'u/mleverce', handle: 'mleverce', url: 'https://www.reddit.com/user/mleverce' },
  title: '[SELF] I did the math on that mosquito laser that we all saw a few weeks ago...',
  text: '', link, createdAt: new Date('2025-08-06T08:46:38Z'), media: [], counts: { likes: 76, replies: 28 }, sensitive: false,
})
const ytPost = (ref, over = {}) => ({
  ref, canonical: `https://www.youtube.com/watch?v=${ref.id}`,
  author: { name: 'some channel', handle: 'somechannel', url: 'https://www.youtube.com/@somechannel' },
  title: 'the video', text: 'the video description, which the Reddit card must not show',
  createdAt: new Date('2025-07-01T00:00:00Z'), counts: { views: 99 }, sensitive: false,
  media: [{
    kind: 'video', url: `https://www.youtube.com/watch?v=${ref.id}`, w: 0, h: 0,
    poster: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`, posterW: 480, posterH: 360,
    remux: { page: `https://www.youtube.com/watch?v=${ref.id}` }, duration: 120, ...over,
  }],
})

/** Deps whose fetchPost answers the Reddit post and its linked YouTube post, recording every ref asked. */
function depsFor(rd, yt, { link } = {}) {
  const asked = []
  return {
    asked,
    cache: fakeCache(),
    fetchPost: async ref => {
      asked.push(refKey(ref))
      if (ref.p === 'rd') return redditPost(ref, link ?? `https://youtu.be/${yt.id}`)
      if (ref.p === 'yt') return typeof yt.post === 'function' ? yt.post(ref) : ytPost(ref, yt.over)
      return null
    },
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
  }
}

const enc = ref => encodeURIComponent(refKey(ref))
const activity = ref => `https://mbedfx.app/users/x/statuses/${encodeStatusId(refKey(ref))}`
const head = ref => `https://mbedfx.app/r/${ref.sub}/comments/${ref.id}/self_i_did_the_math/`

test('THE ACTIVITY DOCUMENT PLAYS THE LINKED VIDEO, under the YouTube key, with Reddit\'s words around it', async () => {
  const ae = recordingAE()
  const rd = rdRef('lnk0001'); const yt = { p: 'yt', id: 'lnkAAAAAAA1' }
  const deps = depsFor(rd, yt)
  const res = await handle(bot(activity(rd)), envWith({ ae }), retainingCtx(), deps)
  const j = await res.json()
  assert.equal(j.media_attachments.length, 1)
  const [a] = j.media_attachments
  assert.equal(a.type, 'video', 'a promisable video is promised, exactly as on a direct paste')
  assert.equal(a.url, `https://mbedfx.app/_media/${enc(yt)}/0`, 'the YouTube key and index: the mux, its R2 object and the cookie pool are YouTube\'s')
  assert.equal(a.preview_url, `https://mbedfx.app/_media/${enc(yt)}/poster0`)
  assert.ok(!JSON.stringify(j.media_attachments).includes(enc(rd)), 'no media url under the Reddit key')
  assert.match(j.content, /mosquito laser/, 'the Reddit title leads the card')
  assert.doesNotMatch(j.content, /must not show/, 'the YouTube description is not the Reddit post\'s text')
  assert.match(j.content, /❤️ 76/, 'Reddit\'s counts')
  assert.equal(rowsOf(ae, 'card_promised')[0]?.blobs?.[0], 'yt', 'the promise is counted where the video lives')
  assert.equal(rowsOf(ae, 'link_ok').length, 1)
  assert.deepEqual(deps.asked, [refKey(rd), refKey(yt)], 'the Reddit post, then the linked post, each through the post cache')
})

test('A LINKED VIDEO THAT CANNOT BE VOUCHED FOR SHOWS ITS THUMBNAIL, sized, never a dead player', async () => {
  // The owner's call (2026-10-11): an un-promisable video's first Reddit card is its still, not YouTube's
  // own player. Over the 240 s ceiling, or with no duration verdict, it is never promised.
  for (const [id, over] of [['lnk0002', { duration: undefined }], ['lnk0003', { duration: 1191 }]]) {
    const rd = rdRef(id); const yt = { p: 'yt', id: `${id}BBBB`, over }
    const res = await handle(bot(activity(rd)), envWith({ resolver: failingResolver() }), retainingCtx(), depsFor(rd, yt))
    const [a] = (await res.json()).media_attachments
    assert.equal(a.type, 'image', `${id}: a picture, not a player that may never play`)
    assert.equal(a.url, `https://mbedfx.app/_media/${enc(yt)}/poster0`, `${id}: the poster slot, under the YouTube key`)
    assert.deepEqual(a.meta?.original && [a.meta.original.width, a.meta.original.height], [480, 360],
      `${id}: the still carries its own size, or Discord draws nothing (types.ts posterW)`)
  }
})

test('THE HEAD ADVERTISES THE LINKED VIDEO\'S STILL AND THE ACTIVITY LINK — and never YouTube\'s own player', async () => {
  const rd = rdRef('lnk0004'); const yt = { p: 'yt', id: 'lnkCCCCCCC4', over: { duration: 1191 } }
  const deps = depsFor(rd, yt)
  const res = await handle(bot(head(rd)), envWith({ resolver: failingResolver() }), retainingCtx(), deps)
  const html = await res.text()
  assert.match(html, /application\/activity\+json/, 'the activity link, so Discord reads the document above')
  assert.doesNotMatch(html, /youtube\.com\/embed/, 'the stock iframe is YouTube-ref only, and this card is Reddit\'s')
  assert.ok(!html.includes(`/_media/${enc(rd)}/`), 'no media url under the Reddit key')
})

test('A LINK TO ANYWHERE ELSE COSTS NOTHING: one fetch, the Reddit post, and no linked load', async () => {
  for (const [id, link] of [
    ['lnk0005', 'https://evil.example/watch?v=lnkDDDDDDD5'],
    ['lnk0006', 'https://www.reddit.com/r/x/comments/abc123/'],
    ['lnk0007', 'https://mbedfx.app/watch?v=lnkDDDDDDD7'],
    ['lnk0008', 'https://mastodon.social/@a/1'],
    ['lnk0009', 'https://www.theguardian.com/world/2026/oct/10/article'],
  ]) {
    const rd = rdRef(id)
    const deps = depsFor(rd, { p: 'yt', id: 'unusedAAAAA' }, { link })
    const res = await handle(bot(activity(rd)), envWith(), retainingCtx(), deps)
    const j = await res.json()
    assert.deepEqual(j.media_attachments, [], `${link}: no media`)
    assert.deepEqual(deps.asked, [refKey(rd)], `${link}: exactly one fetch`)
  }
})

test('A LINKED POST THAT FAILS TO LOAD LEAVES THE REDDIT CARD AS IT WAS, and says so in the counters', async () => {
  const ae = recordingAE()
  const rd = rdRef('lnk0010'); const yt = { p: 'yt', id: 'lnkEEEEEE10', post: () => null }
  const res = await handle(bot(activity(rd)), envWith({ ae }), retainingCtx(), depsFor(rd, yt))
  const j = await res.json()
  assert.deepEqual(j.media_attachments, [])
  assert.match(j.content, /mosquito laser/)
  assert.equal(rowsOf(ae, 'link_fail').length, 1)
})

test('A LINKED POST THAT MISSES THE HEAD\'S BUDGET SHIPS THE CARD WITHOUT IT, UNCACHED, so the next render has it', async () => {
  // Slow by construction: the head waits out its whole budget (HTML_DEADLINE_MS less the floors).
  const ae = recordingAE()
  const rd = rdRef('lnk0011'); const yt = { p: 'yt', id: 'lnkFFFFFF11', post: () => new Promise(() => {}) }
  const deps = depsFor(rd, yt)
  const t0 = Date.now()
  const res = await handle(bot(head(rd)), envWith({ ae }), retainingCtx(), deps)
  const ms = Date.now() - t0
  assert.equal(res.status, 200)
  assert.ok(ms < 5200, `inside the head's deadline, took ${ms}ms`)
  assert.equal(rowsOf(ae, 'link_pending').length, 1)
  // The post cache holds the Reddit post (that is the point: the next render reuses it); the RESPONSE cache
  // must hold nothing, or the card without its video would be served for RESP_TTL.
  assert.ok(![...deps.cache.store.keys()].some(k => String(k).includes('resp%3A') || String(k).includes('resp:')),
    `a card missing something still arriving is never response-cached: ${[...deps.cache.store.keys()]}`)
})

test('THE API AND THE PREVIEW SHOW THE LINKED MEDIA UNDER ITS OWN KEY', async () => {
  const rd = rdRef('lnk0012'); const yt = { p: 'yt', id: 'lnkGGGGGG12', over: { duration: 1191 } }
  const target = encodeURIComponent(`https://www.reddit.com/r/${rd.sub}/comments/${rd.id}/x/`)
  const env = () => envWith({ resolver: failingResolver() })
  const api = await (await handle(human(`https://mbedfx.app/_api/v1?url=${target}`), env(), retainingCtx(), depsFor(rd, yt))).json()
  assert.equal(api.post.platform, 'rd', 'the post is still the Reddit one')
  assert.equal(api.post.media.length, 1)
  assert.match(api.post.media[0].url, new RegExp(`/_media/${enc(yt)}/`), 'its media url names the YouTube key')
  const path = encodeURIComponent(`/r/${rd.sub}/comments/${rd.id}/x/`)
  const card = await (await handle(human(`https://mbedfx.app/_card?p=${path}`), env(), retainingCtx(), depsFor(rd, yt))).json()
  assert.match(card.media[0].url, new RegExp(`/_media/${enc(yt)}/`))
  assert.match(card.media[0].poster ?? card.media[0].url, /poster0/)
})

test('THE FILE LINK OF A REDDIT LINK POST IS THE LINKED POST\'S FILE', async () => {
  const rd = rdRef('lnk0013'); const yt = { p: 'yt', id: 'lnkHHHHHH13' }
  const res = await handle(bot(`https://d.mbedfx.app/r/${rd.sub}/comments/${rd.id}/x/`), envWith(), retainingCtx(), depsFor(rd, yt))
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location'), new RegExp(`/_media/${enc(yt)}/0$`))
})

test('THE REDDIT KEY ITSELF SERVES NOTHING for a link post — it never had media of its own', async () => {
  const rd = rdRef('lnk0014'); const yt = { p: 'yt', id: 'lnkIIIIII14' }
  const res = await handle(bot(`https://mbedfx.app/_media/${enc(rd)}/0`), envWith(), retainingCtx(), depsFor(rd, yt))
  assert.equal(res.status, 404)
})
