import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, HTML_DEADLINE_MS, MUX_WAIT_FLOOR_MS, YT_MUX_BOT_MS } from '../src/worker.ts'
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

test('THE PREVIEW CUTS A LONG BODY WHERE THE CARD DOES — 500 characters or 10 lines', async () => {
  /**
   * /_card returned the raw text, so the converter previewed a Reddit body to its 500-character storage cap
   * while the card stopped at 253, and a 30-line post previewed whole. It now returns clampText's cut, the one
   * function both of the card's heads call. Added 2026-10-11 with the owner's 500/10 budget.
   */
  const rd = rdRef('lnk0015')
  const lines = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n')
  const deps = {
    cache: fakeCache(),
    fetchPost: async ref => ({ ...redditPost(ref, undefined), text: lines }),
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
  }
  const path = encodeURIComponent(`/r/${rd.sub}/comments/${rd.id}/x/`)
  const card = await (await handle(human(`https://mbedfx.app/_card?p=${path}`), envWith(), retainingCtx(), deps)).json()
  assert.equal(card.text.split('\n').length, 10, 'ten lines, as the card')
  assert.ok(card.text.endsWith('line 10...'), `and the card's marker, got ${JSON.stringify(card.text)}`)
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

/* ===================== FROM THE ADVERSARIAL REVIEW, 2026-10-11 =====================
 * Each of these failed, or passed vacuously, on the first version of the composition.
 */

const slow = (ms, value) => new Promise(r => setTimeout(() => r(value), ms))
/**
 * A container that records each job's body and refuses it, so a dispatch can be counted and never hangs.
 * Called as fetch(url, init), as worker.ts calls the container stub: reading a Request off the first
 * argument would throw before recording, and a "no call" assertion would then pass with calls happening.
 */
const recordingResolver = () => {
  const jobs = []
  return { jobs, getByName: () => ({ fetch: async (_url, init) => { jobs.push(String(init?.body ?? '')); return new Response('', { status: 502 }) } }) }
}

test('THE HEAD OF A REDDIT CARD WITH A PROMISABLE VIDEO NAMES ITS STILL UNDER THE YOUTUBE KEY, beside the activity link', async () => {
  // The first head test passed with no composition at all (review): a 1191 s video leaves no /_media/ url
  // on the head. A promisable one leaves the poster of the video the document is about to promise.
  const rd = rdRef('lnk0016'); const yt = { p: 'yt', id: 'lnkJJJJJJ16' }
  const html = await (await handle(bot(head(rd)), envWith(), retainingCtx(), depsFor(rd, yt))).text()
  assert.ok(html.includes(`<meta property="og:image" content="https://mbedfx.app/_media/${enc(yt)}/poster0"/>`), html)
  assert.match(html, /application\/activity\+json/)
})

test('A SLOW REDDIT FETCH AND A SLOW LINKED LOAD STILL END THE HEAD WELL INSIDE ITS DEADLINE', async () => {
  // Review: with a non-promisable video the settle waited out the rest of HTML_DEADLINE_MS for a mux that
  // could not land, and the head ended at 5.0 s. A Reddit card's borrowed video now takes the floor.
  const rd = rdRef('lnk0017'); const yt = { p: 'yt', id: 'lnkKKKKKK17', post: (ref) => slow(1750, ytPost(ref, { duration: 1191 })) }
  const deps = depsFor(rd, yt)
  const fetchRd = deps.fetchPost
  deps.fetchPost = async (ref) => (ref.p === 'rd' ? slow(2000, await fetchRd(ref)) : fetchRd(ref))
  const t0 = Date.now()
  await handle(bot(head(rd)), envWith(), retainingCtx(), deps)
  const ms = Date.now() - t0
  assert.ok(ms < HTML_DEADLINE_MS - 400, `head took ${ms}ms`)
})

test('THE ACTIVITY DOCUMENT OF A COMPOSED CARD IS BOUNDED FROM THE TOP — a slow Reddit load shrinks its waits', async () => {
  // Review: a cold colo stacked a ~2 s Reddit fetch, a ~1.75 s linked load and a fresh 4 s mux wait.
  const rd = rdRef('lnk0018'); const yt = { p: 'yt', id: 'lnkLLLLLL18', post: (ref) => slow(1750, ytPost(ref, { duration: undefined })) }
  const deps = depsFor(rd, yt)
  const fetchRd = deps.fetchPost
  deps.fetchPost = async (ref) => (ref.p === 'rd' ? slow(2000, await fetchRd(ref)) : fetchRd(ref))
  const t0 = Date.now()
  const j = await (await handle(bot(activity(rd)), envWith(), retainingCtx(), deps)).json()
  const ms = Date.now() - t0
  assert.ok(ms < YT_MUX_BOT_MS + MUX_WAIT_FLOOR_MS + 300, `document took ${ms}ms`)
  assert.equal(j.media_attachments[0]?.type, 'image', 'the still, under the YouTube key')
})

test('A LINKED POST THAT NEVER LOADS ENDS THE DOCUMENT ON TIME, counted pending', async () => {
  const ae = recordingAE()
  const rd = rdRef('lnk0019'); const yt = { p: 'yt', id: 'lnkMMMMMM19', post: () => new Promise(() => {}) }
  const t0 = Date.now()
  const j = await (await handle(bot(activity(rd)), envWith({ ae }), retainingCtx(), depsFor(rd, yt))).json()
  const ms = Date.now() - t0
  assert.ok(ms < YT_MUX_BOT_MS + MUX_WAIT_FLOOR_MS + 300, `document took ${ms}ms`)
  assert.deepEqual(j.media_attachments, [])
  assert.equal(rowsOf(ae, 'link_pending').length, 1)
})

test('AN AGE-GATED LINKED VIDEO MAKES THE REDDIT CARD SENSITIVE', async () => {
  // The `[sensitive]` prefix is the only signal on the spoof path (embed.ts isSensitive), and this repo has
  // regressed on it before. A Reddit post linking a gated video carries the gated video's thumbnail.
  const rd = rdRef('lnk0020')
  const yt = { p: 'yt', id: 'lnkNNNNNN20', post: (ref) => ({ ...ytPost(ref, { gated: true }), sensitive: true }) }
  const j = await (await handle(bot(activity(rd)), envWith({ resolver: failingResolver() }), retainingCtx(), depsFor(rd, yt))).json()
  assert.match(j.content, /^\[sensitive\]/)
})

test('A LINK TO A VIDEO THAT CAN NEVER MUX COSTS NO CONTAINER CALL on the document, the preview or the API', async () => {
  // Review: the first version prewarmed on every seam before the entry was known, one doomed dispatch per
  // request. A direct paste of the same video makes none on these seams, and neither does a Reddit card now.
  for (const [i, over] of [[1, { duration: 7200 }], [2, { live: true, duration: undefined }], [3, { gated: true }]]) {
    const rd = rdRef(`lnk002${i}`); const yt = { p: 'yt', id: `lnkOOOOOO2${i}`, over }
    const resolver = recordingResolver()
    const deps = depsFor(rd, yt)
    const target = encodeURIComponent(`https://www.reddit.com/r/${rd.sub}/comments/${rd.id}/x/`)
    for (let n = 0; n < 2; n++) {
      await handle(bot(activity(rd)), envWith({ resolver }), retainingCtx(), deps)
      await handle(human(`https://mbedfx.app/_api/v1?url=${target}`), envWith({ resolver }), retainingCtx(), deps)
    }
    await slow(20)
    assert.deepEqual(resolver.jobs, [], `case ${i}: no container call`)
  }
})

test('A LINKED POST THAT FAILS ONCE IS NOT PINNED: the next render shows its media, and the API says pending', async () => {
  // Review: every null was a final link_fail, the media-less card was response-cached for 900 s, and the API
  // published `media: []` with a public max-age, after the upstream had recovered.
  const rd = rdRef('lnk0025'); let calls = 0
  const yt = { p: 'yt', id: 'lnkPPPPPP25', post: (ref) => (++calls === 1 ? null : ytPost(ref)) }
  const deps = depsFor(rd, yt)
  const first = await (await handle(bot(head(rd)), envWith(), retainingCtx(), deps)).text()
  assert.ok(!first.includes(`/_media/${enc(yt)}/`), 'the first render had nothing to show')
  const second = await (await handle(bot(head(rd)), envWith(), retainingCtx(), deps)).text()
  assert.ok(second.includes(`/_media/${enc(yt)}/`), 'and the second one, not served from a pinned cache, does')
  calls = 0
  const target = encodeURIComponent(`https://www.reddit.com/r/${rd.sub}/comments/${rd.id}/x/`)
  const res = await handle(human(`https://mbedfx.app/_api/v1?url=${target}`), envWith(), retainingCtx(), { ...depsFor(rd, yt), cache: fakeCache() })
  const j = await res.json()
  assert.equal(j.pending, true, 'incomplete, so a consumer asks again')
  assert.match(res.headers.get('cache-control'), /no-store/)
})

/* ===================== FROM THE SECOND REVIEW, 2026-10-11 ===================== */

test('A COLD COLO STILL GETS THE MEDIA: a slow Reddit load does not starve the linked load', async () => {
  // The first fix cut the linked load to what was left of YT_META_BOT_MS after the Reddit load, and a cold
  // colo (2.3 s Reddit, 2.1 s YouTube) shipped `media_attachments: []`, the original report, frozen.
  const rd = rdRef('lnk0030'); const yt = { p: 'yt', id: 'lnkQQQQQQ30', post: (ref) => slow(2100, ytPost(ref)) }
  const deps = depsFor(rd, yt)
  const fetchRd = deps.fetchPost
  deps.fetchPost = async (ref) => (ref.p === 'rd' ? slow(2300, await fetchRd(ref)) : fetchRd(ref))
  const t0 = Date.now()
  const j = await (await handle(bot(activity(rd)), envWith(), retainingCtx(), deps)).json()
  const ms = Date.now() - t0
  assert.equal(j.media_attachments.length, 1, 'the linked video, promised')
  assert.ok(ms < 2300 + 2700 + MUX_WAIT_FLOOR_MS + 400, `and bounded, ${ms}ms`)
})

test('A COMPOSED CARD THAT DEGRADES IS COUNTED UNDER REDDIT, beside its ok', async () => {
  // card_degraded / ok is a per-platform ratio; filed under yt, Reddit traffic inflated YouTube's.
  const ae = recordingAE()
  const rd = rdRef('lnk0031'); const yt = { p: 'yt', id: 'lnkRRRRRR31', over: { duration: 1191 } }
  await handle(bot(head(rd)), envWith({ ae, resolver: failingResolver() }), retainingCtx(), depsFor(rd, yt))
  assert.deepEqual(rowsOf(ae, 'card_degraded').map(r => r.blobs[0]), ['rd'])
  assert.deepEqual(rowsOf(ae, 'ok').map(r => r.blobs[0]), ['rd'])
})
