import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, MUX_WAIT_BOT_MS } from '../src/worker.ts'
import { YT_PROMISE, YT_PROMISE_MAX_SECONDS, promisable } from '../src/muxpolicy.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'

/**
 * PROMISE-AND-STALL ON THE yt ACTIVITY SEAM — the integration the whole patience experiment was run
 * to size, and the release that turns a structural 0% into a number.
 *
 * WHAT WAS MEASURED (2026-09-02, owner's real Discord client, invocation analytics beside it; the
 * `/_wait` block in src/worker.ts has the full ladder):
 *   - Discord gives a card ONE ~10s budget from the head fetch. Head, activity document, poster and
 *     video must all COMPLETE inside it (p/4/6: 4.1s of document + 5.65s of video, cut; p/4/3 and m/8
 *     played). Holding the document buys nothing.
 *   - The validator downloads the WHOLE video inside that budget (b/12, c/12 lost; b/5, c/5 played).
 *   - A document that keeps `type:'video'` at a url that only starts serving seconds later draws the
 *     native player the moment the bytes land — that is what every p/m/b paste that played did.
 *
 * WHAT WAS FOUND IN THE CODE: on a cold YouTube paste the head's settleMux had at most 1500ms (the
 * fastest mux ever recorded is 4200ms), so the entry ALWAYS degraded to a still, the stock gate ALWAYS
 * fired, and the activity link was ALWAYS omitted. Discord never asked for the document on the paste
 * that mattered. YT_MUX_BOT_MS was tuned for a document nobody fetched.
 *
 * SO: the head stands the stock player down when a mux it can vouch for is in flight and keeps the
 * activity link (plus an og:image, the exact head shape the p surface measured); the yt activity
 * document answers at the floor and KEEPS the video attachment; /_media waits for the mux. The
 * "vouch" is the safety valve — see promisable(): a known duration under YT_PROMISE_MAX_SECONDS.
 *
 * Every test has its OWN 11-char id: muxInflight is a module-level map keyed on `mux/{refKey}/{i}`,
 * and the silent resolver's promise stays parked for the life of the process.
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = url => new Request(url, { headers: { 'user-agent': DISCORD } })
const ytRef = id => ({ p: 'yt', id })
const activityUrl = ref => `https://mbedfx.app/users/anyone/statuses/${encodeStatusId(refKey(ref))}`
const headUrl = ref => `https://mbedfx.app/watch?v=${ref.id}`
const mediaUrl = (ref, i = 0) => `https://mbedfx.app/_media/${encodeURIComponent(refKey(ref))}/${i}`

const retainingCtx = () => ({ waitUntil() {} })

const fakeCache = () => {
  const m = new Map()
  return {
    store: m,
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}

function fakeR2(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) {
      const v = store.get(k)
      return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null
    },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}

const recordingAE = () => {
  const rows = []
  return { rows, writeDataPoint(d) { rows.push(d) } }
}

const envWith = ({ resolver, r2 = fakeR2(), ae = recordingAE() } = {}) => ({
  AE: ae,
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: r2,
  MEDIA_RESOLVER: resolver,
  TRANSLATE_GOOGLE: 'off',
})

const depsFor = post => ({
  cache: fakeCache(),
  fetchPost: async ref => post(ref),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

/** A yt post carrying a `{page}` remux video, as normalizeYouTube shapes one, with a DURATION by default. */
const ytPost = (ref, over = {}) => ({
  ref,
  canonical: `https://www.youtube.com/watch?v=${ref.id}`,
  author: { name: 'promise watch', handle: 'promisewatch', url: 'https://www.youtube.com/@promisewatch' },
  text: 'a clip that has to be muxed before anyone can play it',
  createdAt: new Date('2026-08-02T00:00:00Z'),
  counts: {}, sensitive: false,
  media: [{
    kind: 'video',
    url: `https://www.youtube.com/watch?v=${ref.id}`,
    w: 0, h: 0,
    poster: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`, posterW: 480, posterH: 360,
    remux: { page: `https://www.youtube.com/watch?v=${ref.id}` },
    duration: 120,
    ...over,
  }],
})

/** A container that never answers — the honest shape of a cold mux. */
const silentResolver = () => ({ getByName: () => ({ fetch: () => new Promise(() => {}) }) })
/** A container that refuses at once. */
const failingResolver = () => ({ getByName: () => ({ fetch: async () => new Response('', { status: 502 }) }) })
/**
 * A container that counts and then REFUSES, so a dispatch (or its absence) can be asserted and a
 * test that expected no dispatch fails fast rather than hanging on a parked promise. (The first
 * mutation run of this file hung for hours on exactly that: the join path removed, a never-answering
 * stub, and a test with no timeout waiting on it.)
 */
const countingResolver = () => {
  const calls = []
  return { calls, getByName: () => ({ fetch: async () => { calls.push(Date.now()); return new Response('', { status: 502 }) } }) }
}

const rowsOf = (ae, outcome) => ae.rows.filter(r => r.blobs?.[1] === outcome)

test('promisable(): a known duration under the ceiling, never live, never blind', () => {
  assert.equal(YT_PROMISE, true, 'the switch is on; flipping it is the rollback')
  assert.equal(promisable({ duration: 60 }), true)
  assert.equal(promisable({ duration: YT_PROMISE_MAX_SECONDS }), true, 'the ceiling is inclusive')
  assert.equal(promisable({ duration: YT_PROMISE_MAX_SECONDS + 1 }), false)
  assert.equal(promisable({}), false, 'no duration verdict = Innertube refused = we know nothing = no promise')
  assert.equal(promisable({ duration: 0 }), false, 'a live stream reports lengthSeconds 0')
  assert.equal(promisable({ duration: 60, live: true }), false)
  assert.equal(promisable(null), false)
})

test('THE MUX IS DISPATCHED AT T0, BEFORE THE POST FETCH RETURNS — every second before the first byte is a point of conversion', async () => {
  // getPost costs ~1.7s at the production median (Innertube's race), and the mux used to start after
  // it. The video id is in the url and normalizeYouTube never fails, so the prewarm gate that
  // required a post-cache hit bought yt nothing but the overlap it forbade.
  //
  // FIRST IN THIS FILE, deliberately: the prewarm is also bounded by SPECULATIVE_MUX_CAP on the
  // module-level muxInflight map, and every later test parks a never-answering mux in it.
  const resolver = countingResolver()
  const ref = ytRef('promise0012')
  let fetchReturnedAt = 0
  const deps = {
    ...depsFor(ytPost),
    fetchPost: async r => { await new Promise(res => setTimeout(res, 300)); fetchReturnedAt = Date.now(); return ytPost(r) },
  }
  await handle(bot(headUrl(ref)), envWith({ resolver }), retainingCtx(), deps)
  assert.ok(resolver.calls.length >= 1, 'the container was asked')
  assert.ok(resolver.calls[0] < fetchReturnedAt, `dispatched at ${resolver.calls[0] - fetchReturnedAt}ms relative to the fetch returning — must be before`)
})

test('THE yt ACTIVITY DOCUMENT KEEPS THE VIDEO ATTACHMENT WHILE THE MUX IS STILL RUNNING, and answers at the floor', async () => {
  const ae = recordingAE()
  const ref = ytRef('promise0001')
  const t0 = Date.now()
  const res = await handle(bot(activityUrl(ref)), envWith({ resolver: silentResolver(), ae }), retainingCtx(), depsFor(ytPost))
  const ms = Date.now() - t0
  const j = await res.json()
  assert.equal(j.media_attachments.length, 1)
  assert.equal(j.media_attachments[0].type, 'video', 'the promise: the player entry stays a player')
  assert.equal(j.media_attachments[0].url, mediaUrl(ref), 'at the url that will serve the bytes when the mux lands')
  assert.match(j.media_attachments[0].preview_url, /\/poster0$/, 'poster on its own slot, so the card has an image while it waits')
  // The document must not spend the budget Discord is about to spend on the video. The floor is an R2
  // head plus slack; the old arm was YT_MUX_BOT_MS = 4000 on exactly this seam.
  assert.ok(ms < MUX_WAIT_BOT_MS - 200, `answered at the floor, not a crawler budget (${ms}ms)`)
  assert.equal(rowsOf(ae, 'card_promised').length, 1, 'counted once, as a promise')
  assert.equal(rowsOf(ae, 'card_degraded').length, 0, 'and NOT as a degrade — the reader may get a player')
  const row = rowsOf(ae, 'card_promised')[0]
  assert.deepEqual(row.blobs, ['yt', 'card_promised', 'discord'], 'platform, outcome, the REAL client')
  assert.equal(row.doubles?.[1], 120, 'double2 is the duration in seconds: the conversion rate has to be read per length')
})

test('A VIDEO WE CANNOT VOUCH FOR IS NEVER PROMISED — the safety valve', async () => {
  // No duration = Innertube was refused and there is no record: a live stream looks the same from here.
  // Promising blind would hand Discord a url that 503s forever on a broadcast, frozen in the message.
  for (const [id, over, why] of [
    ['promise0002', { duration: undefined }, 'no duration verdict'],
    ['promise0003', { duration: YT_PROMISE_MAX_SECONDS + 1 }, 'over the promise ceiling'],
  ]) {
    const ae = recordingAE()
    const ref = ytRef(id)
    const j = await (await handle(bot(activityUrl(ref)), envWith({ resolver: silentResolver(), ae }), retainingCtx(),
      depsFor(r => ytPost(r, over)))).json()
    assert.equal(j.media_attachments[0].type, 'image', `${why}: degraded honestly`)
    assert.equal(rowsOf(ae, 'card_promised').length, 0, `${why}: no promise row`)
    assert.equal(rowsOf(ae, 'card_degraded').length, 1, `${why}: counted as the degrade it is`)
  }
  // Live and over-ceiling are the two rewrites that call nothing and count nothing — unchanged.
  for (const [id, over] of [['promise0004', { live: true, duration: 0 }], ['promise0005', { duration: 99_999 }]]) {
    const ae = recordingAE()
    const j = await (await handle(bot(activityUrl(ytRef(id))), envWith({ resolver: silentResolver(), ae }), retainingCtx(),
      depsFor(r => ytPost(r, over)))).json()
    assert.equal(j.media_attachments[0].type, 'image')
    assert.equal(rowsOf(ae, 'card_promised').length + rowsOf(ae, 'card_degraded').length, 0, 'a rewrite is neither')
  }
})

test('A WARM MUX IS THE REAL THING, NOT A PROMISE', async () => {
  const ae = recordingAE()
  const ref = ytRef('promise0006')
  const r2 = fakeR2({ [`mux/${refKey(ref)}/0`]: 'mp4-bytes' })
  const j = await (await handle(bot(activityUrl(ref)), envWith({ resolver: silentResolver(), r2, ae }), retainingCtx(), depsFor(ytPost))).json()
  assert.equal(j.media_attachments[0].type, 'video')
  assert.equal(rowsOf(ae, 'card_promised').length, 0, 'the counter counts promises, not players')
})

test('ONLY THE yt ACTIVITY SEAM PROMISES — /_oembed, /_card, and a non-yt document all still degrade', async () => {
  const ae = recordingAE()
  const ref = ytRef('promise0007')
  const env = () => envWith({ resolver: silentResolver(), ae })
  const oembed = await (await handle(bot(`https://mbedfx.app/_oembed/${encodeStatusId(refKey(ref))}`), env(), retainingCtx(), depsFor(ytPost))).json()
  assert.ok(oembed.author_name, 'the oEmbed answers')
  const card = await (await handle(new Request(`https://mbedfx.app/_card?p=${encodeURIComponent(`/watch?v=${ref.id}`)}`), env(), retainingCtx(), depsFor(ytPost))).json()
  assert.equal(card.muxing, true, 'the converter page is told the video is still coming, as before')
  assert.equal(card.media[0].kind, 'image')
  const xRef = { p: 'x', kind: 'status', id: '9200000000000000071' }
  const xPost = r => ({ ...ytPost(r), canonical: 'https://twitter.com/muxwatch/status/9200000000000000071', media: [{ ...ytPost(r).media[0], url: 'https://example.invalid/v', remux: { page: 'https://example.invalid/page/71' } }] })
  const x = await (await handle(bot(activityUrl(xRef)), env(), retainingCtx(), depsFor(xPost))).json()
  assert.equal(x.media_attachments[0].type, 'image', 'a non-yt activity document degrades as before')
  assert.equal(rowsOf(ae, 'card_promised').length, 0, 'not one promise across the three seams')
  assert.ok(rowsOf(ae, 'card_degraded').length >= 2, 'the degrades are still counted')
})

test('THE STOCK PLAYER STANDS DOWN WHILE A PROMISABLE MUX IS IN FLIGHT, SO DISCORD READS THE DOCUMENT', async () => {
  /**
   * The change without which everything else is inert. Today's cold yt head: no playable video ->
   * stock gate -> YouTube iframe as og:video, activity link OMITTED. Discord never fetched the
   * document on a cold paste. Now the head names the document and gives Discord an og:image to hold
   * — exactly the head every playing p/m/b paste carried on 2026-09-02.
   */
  const ae = recordingAE()
  const ref = ytRef('promise0008')
  const cache = fakeCache()
  const deps = { ...depsFor(ytPost), cache }
  const t0 = Date.now()
  const html = await (await handle(bot(headUrl(ref)), envWith({ resolver: silentResolver(), ae }), retainingCtx(), deps)).text()
  const ms = Date.now() - t0
  assert.ok(!html.includes('youtube.com/embed/'), 'no stock player: Discord would take the iframe and never ask for the document')
  assert.ok(html.includes('type="application/activity+json"'), 'the activity link is the whole point')
  assert.ok(!/og:video/.test(html), 'and no og:video of any kind: the player comes from the document')
  assert.ok(html.includes(`<meta property="og:image" content="https://mbedfx.app/_media/${encodeURIComponent(refKey(ref))}/poster0"/>`),
    'an og:image on the poster slot — the measured p-head shape, and what Discord falls back to if it abandons the video')
  assert.ok(!html.includes('twitter:card') && !html.includes('rel="canonical"'),
    'neither twitter:card nor canonical: the measured head carried neither, and og:image beside summary_large_image is the C1 hazard')
  assert.ok(ms < MUX_WAIT_BOT_MS - 200, `the head answers at the floor, not after a 1500ms wait that cannot succeed (${ms}ms)`)
  // Degraded still, so not response-cached: the next render in this colo must re-evaluate.
  const cachedHtml = [...cache.store.values()].filter(v => (v.headers.get('content-type') || '').includes('text/html'))
  assert.equal(cachedHtml.length, 0, 'a pending head is never response-cached')
  assert.equal(rowsOf(ae, 'card_degraded').length, 1, 'the head itself still degrades (and says so) — only the document promises')
})

test('THE STOCK PLAYER STILL STANDS FOR A VIDEO WITH NO DURATION VERDICT, A LIVE ONE, AND AN OVER-CEILING ONE', async () => {
  // The residual of the stock player, and the whole risk of narrowing its gate: these three are the
  // states where no promise can be kept, so the iframe (measured playable 2026-08-30) stays.
  for (const [id, over] of [
    ['promise0009', { duration: undefined }],
    ['promise0010', { live: true, duration: 0 }],
    ['promise0011', { duration: 99_999 }],
  ]) {
    const html = await (await handle(bot(headUrl(ytRef(id))), envWith({ resolver: silentResolver() }), retainingCtx(),
      depsFor(r => ytPost(r, over)))).text()
    assert.ok(html.includes(`youtube.com/embed/${id}`), `${id}: the stock player stands`)
    assert.ok(!html.includes('activity+json'), `${id}: and the activity link goes with it`)
  }
})

test('/_media WRITES ITS ENTRY ROW BEFORE THE WAIT — a hang-up erases everything after it', async () => {
  // Discord hangs up at ten seconds and the runtime cancels the invocation with it (docs/METRICS.md,
  // the invocation-analytics section), so a row written after the wait is written never for exactly
  // the case being measured. The funnel is card_promised -> video_wait -> video_ok | video_fail.
  const ae = recordingAE()
  const ref = ytRef('promise0013')
  const env = envWith({ resolver: silentResolver(), ae })
  // Seed the in-flight map through the head so this isolate HOLDS the mux (join code 0) — a cold
  // /_media that holds nothing would poll for another isolate's bytes first (next test).
  await handle(bot(headUrl(ref)), env, retainingCtx(), depsFor(ytPost))
  const pending = handle(new Request(mediaUrl(ref), { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:38.0) Gecko/20100101 Firefox/38.0' } }), env, retainingCtx(), depsFor(ytPost))
  await new Promise(r => setTimeout(r, 100))
  const wait = rowsOf(ae, 'video_wait')
  assert.equal(wait.length, 1, 'the entry row exists 100ms in, long before any mux could end')
  assert.deepEqual(wait[0].blobs, ['yt', 'video_wait', 'human'], 'blob3 is human: Discord\'s media proxy wears a browser UA on purpose')
  assert.equal(wait[0].doubles?.[1], 0, 'join code 0: this isolate holds the mux')
  assert.equal(rowsOf(ae, 'video_ok').length + rowsOf(ae, 'video_fail').length, 0, 'no terminal row yet')
  void pending
})

test('/_media JOINS BYTES ANOTHER ISOLATE MADE INSTEAD OF STARTING A SECOND DOWNLOAD', async () => {
  // muxInflight is isolate-local and its own comment admits two isolates can double-mux one video.
  // Discord's proxy may land anywhere. A cold /_media that holds no mux polls the bucket for the
  // bytes the head render's isolate is producing, and only starts its own if the poll expires.
  const ae = recordingAE()
  const resolver = countingResolver()
  const ref = ytRef('promise0014')
  const r2 = fakeR2()
  setTimeout(() => r2.store.set(`mux/${refKey(ref)}/0`, 'mp4-bytes-from-another-isolate'), 400)
  const res = await handle(new Request(mediaUrl(ref), { headers: { 'user-agent': 'Mozilla/5.0 Firefox/38.0' } }),
    envWith({ resolver, r2, ae }), retainingCtx(), depsFor(ytPost))
  assert.equal(res.status, 200, 'served')
  assert.equal(await res.text(), 'mp4-bytes-from-another-isolate')
  assert.equal(resolver.calls.length, 0, 'ZERO container calls from this isolate')
  assert.equal(rowsOf(ae, 'video_wait')[0]?.doubles?.[1], 1, 'join code 1: waited for another isolate')
  const ok = rowsOf(ae, 'video_ok')
  assert.equal(ok.length, 1)
  assert.ok(ok[0].doubles[1] >= 350 && ok[0].doubles[1] < 5000, `video_ok carries the wall clock Discord waited (${ok[0].doubles[1]}ms)`)
})

test('A WARM FILE AND A REFUSAL ARE DIFFERENT ROWS, AND BOTH CARRY THE WAIT', async () => {
  const ae = recordingAE()
  const warmRef = ytRef('promise0015')
  const r2 = fakeR2({ [`mux/${refKey(warmRef)}/0`]: 'warm' })
  const res = await handle(new Request(mediaUrl(warmRef)), envWith({ resolver: silentResolver(), r2, ae }), retainingCtx(), depsFor(ytPost))
  assert.equal(res.status, 200)
  assert.equal(rowsOf(ae, 'video_wait')[0]?.doubles?.[1], 3, 'join code 3: already warm')
  assert.equal(rowsOf(ae, 'video_ok').length, 1)
  // A refusal on a platform with no join poll (the poll is yt + page only): the row is video_fail.
  const xRef = { p: 'x', kind: 'status', id: '9200000000000000016' }
  const xPost = r => ({ ...ytPost(r), canonical: 'https://twitter.com/muxwatch/status/9200000000000000016',
    media: [{ ...ytPost(r).media[0], url: 'https://example.invalid/v', remux: { page: 'https://example.invalid/page/16' } }] })
  const fail = await handle(new Request(mediaUrl(xRef)), envWith({ resolver: failingResolver(), ae }), retainingCtx(), depsFor(xPost))
  assert.equal(fail.status, 503)
  const failed = rowsOf(ae, 'video_fail')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].blobs[0], 'x')
  assert.ok(typeof failed[0].doubles?.[1] === 'number' && failed[0].doubles[1] >= 0)
})
