import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, recordMuxGiveUp, clearMuxGiveUp, muxFailMarkKey } from '../src/worker.ts'
import { MUX_GAVE_UP_NOTE, MUX_GIVE_UP_WINDOW_MS, gaveUpIsFresh, muxFailKey } from '../src/muxpolicy.ts'
import { RESP_TTL } from '../src/cache.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'

/**
 * A VIDEO THE ALARM GAVE UP ON GETS A FINAL ANSWER (muxpolicy.ts muxFailKey).
 *
 * THE DEFECT, measured 2026-11-24 on yt:zp8_bKhhnlw: every container attempt answered 502 for over 25
 * minutes and /_api/v1 said `muxing: true` the whole time, because the alarm forgot its verdict when it
 * ran out of attempts and the next render armed a fresh job. These tests pin the mark that remembers it:
 * while fresh, no container call and no alarm from any seam, and a poster with a note in place of a
 * player that will never play. After the window, behaviour is exactly what it was before.
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = url => new Request(url, { headers: { 'user-agent': DISCORD } })
const ytRef = id => ({ p: 'yt', id })
const activityUrl = ref => `https://mbedfx.app/users/anyone/statuses/${encodeStatusId(refKey(ref))}`
const headUrl = ref => `https://mbedfx.app/watch?v=${ref.id}`
const apiUrl = ref => `https://mbedfx.app/_api/v1?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ref.id}`)}`
const mediaUrl = (ref, i = 0) => `https://mbedfx.app/_media/${encodeURIComponent(refKey(ref))}/${i}`
const muxKey = (ref, i = 0) => `mux/${refKey(ref)}/${i}`

const ctx = () => ({ waits: [], waitUntil(p) { this.waits.push(Promise.resolve(p).catch(() => {})) } })
const settle = c => Promise.all(c.waits)

const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

/** An R2 stand-in whose head() carries `uploaded`, which is what the mark's age is read from. */
function fakeR2() {
  const store = new Map()
  return {
    store,
    mark(key, uploaded, at = muxFailMarkKey(key)) { store.set(at, { body: '', uploaded }) },
    async head(k) { const v = store.get(k); return v ? { size: v.body.length, uploaded: v.uploaded } : null },
    async get(k) {
      const v = store.get(k)
      return v ? { body: new Response(v.body).body, size: v.body.length, uploaded: v.uploaded, async json() { return JSON.parse(v.body) } } : null
    },
    async put(k, body) {
      const text = typeof body === 'string' ? body : new TextDecoder().decode(await new Response(body).arrayBuffer())
      store.set(k, { body: text, uploaded: new Date() })
    },
    async delete(k) { store.delete(k) },
  }
}

const recordingAE = () => {
  const rows = []
  return { rows, writeDataPoint(d) { rows.push(d) } }
}
const rowsOf = (ae, outcome) => ae.rows.filter(r => r.blobs?.[1] === outcome)

/** A container that fails every call and counts them, and a MuxRunner that records every schedule(). */
const countingResolver = () => {
  const calls = []
  return { calls, getByName: () => ({ fetch: async () => { calls.push(Date.now()); return new Response('', { status: 502 }) } }) }
}
const recordingRunner = () => {
  const jobs = []
  return {
    jobs,
    getByName: name => ({
      async schedule(job) { jobs.push({ name, job }) },
      async claim() { return true },
      async release() {},
    }),
  }
}

/**
 * `YT_PROMISE: 'on'` since 2026-11-25, when the promise became opt-in (src/muxpolicy.ts ytPromiseOn).
 * The "not a promised player" assertions below are only worth anything in promise mode: with the
 * promise off nothing is promised whatever the mark says, and they would pass without the give-up gate.
 * An env without the var used to be promise mode, so these tests are unchanged in what they exercise.
 */
const envWith = ({ r2 = fakeR2(), ae = recordingAE(), resolver = countingResolver(), runner = recordingRunner() } = {}) => ({
  AE: ae,
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: r2,
  MEDIA_RESOLVER: resolver,
  MUX_RUNNER: runner,
  TRANSLATE_GOOGLE: 'off',
  YT_PROMISE: 'on',
})

const ytPost = ref => ({
  ref,
  canonical: `https://www.youtube.com/watch?v=${ref.id}`,
  author: { name: 'give up watch', handle: 'giveupwatch', url: 'https://www.youtube.com/@giveupwatch' },
  text: 'a commercial the container could not fetch',
  createdAt: new Date('2026-11-24T00:00:00Z'),
  counts: {}, sensitive: false,
  media: [{
    kind: 'video',
    url: `https://www.youtube.com/watch?v=${ref.id}`,
    w: 0, h: 0,
    poster: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`, posterW: 480, posterH: 360,
    remux: { page: `https://www.youtube.com/watch?v=${ref.id}` },
    duration: 60,
  }],
})
const deps = () => ({
  cache: fakeCache(),
  fetchPost: async ref => ytPost(ref),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

test('the window is fresh inside six hours, stale after, and a mark with no readable time is no mark', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  assert.equal(gaveUpIsFresh(new Date(now - 60_000), now), true)
  assert.equal(gaveUpIsFresh(new Date(now - MUX_GIVE_UP_WINDOW_MS + 1), now), true)
  assert.equal(gaveUpIsFresh(new Date(now - MUX_GIVE_UP_WINDOW_MS), now), false)
  assert.equal(gaveUpIsFresh(undefined, now), false, 'refusing on an unreadable time would block a video forever')
  assert.equal(gaveUpIsFresh('2026-11-24T11:59:00Z', now), false, 'a string is not a Date')
  assert.equal(gaveUpIsFresh(new Date(now + 60_000), now), false, 'a mark from the future is not trusted')
  assert.ok(MUX_GIVE_UP_WINDOW_MS > RESP_TTL * 1000 * 4,
    'the window must be well over RESP_TTL, or a cached give-up card outlives its verdict')
})

const pageJob = ref => ({ key: muxKey(ref), slotKey: refKey(ref), source: { page: `https://www.youtube.com/watch?v=${ref.id}` } })

test('a {page} give-up writes the mark under the resolver generation, and clearMuxGiveUp removes it', async () => {
  const r2 = fakeR2()
  const env = envWith({ r2 })
  const job = pageJob(ytRef('giveup00001'))
  await recordMuxGiveUp(env, job, false)
  assert.ok(r2.store.has(muxFailMarkKey(job.key)))
  assert.match(muxFailMarkKey(job.key), new RegExp(`^muxfail/g\\d+/${job.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    'the generation segment is what lets a RESOLVER_GENERATION bump end a wave of wrong marks')
  await clearMuxGiveUp(env, job.key)
  assert.equal(r2.store.has(muxFailMarkKey(job.key)), false)
  // Neither may throw: the alarm that calls them never throws.
  await recordMuxGiveUp({}, job, false)
  await clearMuxGiveUp({}, job.key)
})

test('a give-up whose last attempt THREW leaves no mark: our own outage is not a verdict on the video', async () => {
  const r2 = fakeR2()
  const job = pageJob(ytRef('giveup00011'))
  await recordMuxGiveUp(envWith({ r2 }), job, true)
  assert.equal(r2.store.size, 0)
})

test('a {video} give-up leaves no mark: Bluesky and Reddit keep their player, so /_media must keep trying', async () => {
  const r2 = fakeR2()
  const job = { key: 'mux/bs:did/0', slotKey: 'bs:did', source: { video: 'https://video.bsky.app/x/playlist.m3u8' } }
  await recordMuxGiveUp(envWith({ r2 }), job, false)
  assert.equal(r2.store.size, 0)
})

test('a mark written under ANOTHER resolver generation is ignored: the outage lever clears verdicts too', async () => {
  const ref = ytRef('giveup00012')
  const r2 = fakeR2()
  r2.mark(muxKey(ref), new Date(Date.now() - 60_000), muxFailKey(muxKey(ref), 'g0'))
  const resolver = countingResolver()
  const c = ctx()
  const j = await (await handle(bot(apiUrl(ref)), envWith({ r2, resolver }), c, deps())).json()
  await settle(c)
  assert.equal(j.muxing, true, 'treated as no mark')
  assert.ok(resolver.calls.length >= 1, 'and the container is asked again')
})

test('INSIDE THE WINDOW the API answers a final still, with the note, and no container call is made', async () => {
  const ref = ytRef('giveup00002')
  const r2 = fakeR2()
  r2.mark(muxKey(ref), new Date(Date.now() - 60_000))
  const ae = recordingAE()
  const resolver = countingResolver()
  const runner = recordingRunner()
  const c = ctx()
  const res = await handle(bot(apiUrl(ref)), envWith({ r2, ae, resolver, runner }), c, deps())
  await settle(c)
  const j = await res.json()
  assert.equal(j.ok, true)
  assert.equal(j.muxing, false, 'final, not "still muxing": the defect was this flag never clearing')
  assert.equal(j.post.media[0].kind, 'image')
  assert.equal(j.post.media[0].still, true)
  assert.ok(j.post.text.startsWith(MUX_GAVE_UP_NOTE), 'the card says why there is no player')
  assert.equal(resolver.calls.length, 0, 'no container call from any seam: settleMux, prewarm or the alarm')
  assert.equal(runner.jobs.length, 0, 'and no alarm armed')
  assert.equal(rowsOf(ae, 'card_gave_up').length, 1, 'counted, so the failure rate does not improve on paper')
  assert.equal(rowsOf(ae, 'card_degraded').length, 0)
})

test('INSIDE THE WINDOW the activity document draws the poster, not a promised player', async () => {
  const ref = ytRef('giveup00003')
  const r2 = fakeR2()
  r2.mark(muxKey(ref), new Date(Date.now() - 60_000))
  const resolver = countingResolver()
  const c = ctx()
  const res = await handle(bot(activityUrl(ref)), envWith({ r2, resolver }), c, deps())
  await settle(c)
  const j = await res.json()
  assert.equal(j.media_attachments.length, 1)
  assert.equal(j.media_attachments[0].type, 'image',
    'a promise here is a play button Discord freezes in the message, over a video that will not come')
  assert.ok(j.content.includes("couldn't be loaded") || j.content.includes('couldn&#39;t be loaded') || j.content.includes('couldn&apos;t be loaded'),
    `the note reaches the document Discord renders: ${j.content.slice(0, 200)}`)
  assert.equal(resolver.calls.length, 0)
})

test('INSIDE THE WINDOW the HTML head promises no og:video and /_media starts no download', async () => {
  const ref = ytRef('giveup00004')
  const r2 = fakeR2()
  r2.mark(muxKey(ref), new Date(Date.now() - 60_000))
  const resolver = countingResolver()
  const env = envWith({ r2, resolver })
  const c = ctx()
  const html = await (await handle(bot(headUrl(ref)), env, c, deps())).text()
  assert.ok(!html.includes(`${encodeURIComponent(refKey(ref))}/0"`),
    'no og:video (or any url) at the slot the container will not fill')
  assert.ok(html.includes(`${encodeURIComponent(refKey(ref))}/poster0`), 'the poster is drawn instead')
  const media = await handle(bot(mediaUrl(ref)), env, c, deps())
  await settle(c)
  assert.notEqual(media.status, 200)
  assert.equal(resolver.calls.length, 0, 'the media route meets the same gate')
})

test('AFTER THE WINDOW the mark is ignored and the video is tried again, exactly as before', async () => {
  const ref = ytRef('giveup00005')
  const r2 = fakeR2()
  r2.mark(muxKey(ref), new Date(Date.now() - MUX_GIVE_UP_WINDOW_MS - 60_000))
  const ae = recordingAE()
  const resolver = countingResolver()
  const runner = recordingRunner()
  const c = ctx()
  const res = await handle(bot(apiUrl(ref)), envWith({ r2, ae, resolver, runner }), c, deps())
  await settle(c)
  const j = await res.json()
  assert.equal(j.muxing, true, 'a stale mark is no verdict: still muxing, as before the mark existed')
  assert.ok(!(j.post.text ?? '').includes(MUX_GAVE_UP_NOTE))
  assert.ok(resolver.calls.length >= 1, 'the container is asked again')
  assert.ok(runner.jobs.length >= 1, 'and the alarm is armed again')
  assert.equal(rowsOf(ae, 'card_gave_up').length, 0)
})

test('WARM BYTES WIN over a stray mark: the video plays', async () => {
  const ref = ytRef('giveup00006')
  const r2 = fakeR2()
  r2.mark(muxKey(ref), new Date(Date.now() - 60_000))
  r2.store.set(muxKey(ref), { body: 'mp4 bytes', uploaded: new Date() })
  const c = ctx()
  const res = await handle(bot(apiUrl(ref)), envWith({ r2 }), c, deps())
  await settle(c)
  const j = await res.json()
  assert.equal(j.muxing, false)
  assert.equal(j.post.media[0].kind, 'video', 'bytes in R2 are the truth, whatever the mark says')
  assert.ok(!(j.post.text ?? '').includes(MUX_GAVE_UP_NOTE))
})

test('NO MARK, NO CHANGE: a cold video with no verdict is still muxing and still tried', async () => {
  const ref = ytRef('giveup00007')
  const resolver = countingResolver()
  const runner = recordingRunner()
  const c = ctx()
  const res = await handle(bot(apiUrl(ref)), envWith({ resolver, runner }), c, deps())
  await settle(c)
  const j = await res.json()
  assert.equal(j.muxing, true)
  assert.ok(resolver.calls.length >= 1)
  assert.ok(runner.jobs.length >= 1)
})
