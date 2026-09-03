import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle, liveFetchPost, runMuxJob, metaCacheKey } from '../src/worker.ts'
import { MUX_CLAIM_TTL_MS, claimIsLive } from '../src/muxpolicy.ts'
import { refKey } from '../src/refkey.ts'

/**
 * THE TWO THINGS THAT WOULD EACH HAVE CONVERTED THE OWNER'S FIRST REAL PASTE ON 1.15.0 (2026-09-03,
 * 13:47 UTC, read off the counters):
 *
 *   1. The converter page fetched the post at :23 and Innertube ANSWERED — duration known. Discord's
 *      crawler fetched the head at :26 from another colo, its own Innertube call was REFUSED, and the
 *      answer we had held three seconds earlier never reached that render: the successful answer was
 *      persisted only when it came from the document route's retry, never from a render. No duration,
 *      no vouch, no promise, stock iframe. So: PERSIST INNERTUBE'S ANSWER ON EVERY SUCCESSFUL RENDER.
 *   2. Two `mux_ok` rows for one video, 13.6 s and 14.1 s, started within a second of each other in
 *      different isolates and finishing at :37 — on a one-vCPU container slot that would have finished
 *      one mux around :32, inside the window. `muxInflight` is isolate-local and says so; the Durable
 *      Object is already one object per video worldwide. So: CLAIM THE MUX THERE, and let every other
 *      isolate join the bytes instead of downloading them again.
 *
 * Every test has its own 11-character id: muxInflight and the R2 stand-in are shared for the life of
 * the process.
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = url => new Request(url, { headers: { 'user-agent': DISCORD } })
const ytRef = id => ({ p: 'yt', id })
const headUrl = ref => `https://mbedfx.app/watch?v=${ref.id}`
const retainingCtx = () => { const kept = []; return { kept, waitUntil(p) { kept.push(p) } } }

const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
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
const recordingAE = () => { const rows = []; return { rows, writeDataPoint(d) { rows.push(d) } } }
const envWith = ({ resolver, r2 = fakeR2(), ae = recordingAE(), runner } = {}) => ({
  AE: ae,
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: r2,
  MEDIA_RESOLVER: resolver,
  TRANSLATE_GOOGLE: 'off',
  ...(runner ? { MUX_RUNNER: runner } : {}),
})
const ytPost = (ref, over = {}) => ({
  ref, canonical: `https://www.youtube.com/watch?v=${ref.id}`,
  author: { name: 'claim watch', handle: 'claimwatch', url: 'https://www.youtube.com/@claimwatch' },
  text: 'a clip', createdAt: new Date('2026-08-02T00:00:00Z'), counts: {}, sensitive: false,
  media: [{
    kind: 'video', url: `https://www.youtube.com/watch?v=${ref.id}`, w: 0, h: 0,
    poster: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`, posterW: 480, posterH: 360,
    remux: { page: `https://www.youtube.com/watch?v=${ref.id}` }, duration: 120, ...over,
  }],
})
const depsFor = post => ({ cache: fakeCache(), fetchPost: async ref => post(ref), resolveShortlink: async () => ({ kind: 'unresolved' }), resolveRedditShare: async () => null })
const countingResolver = () => {
  const calls = []
  return { calls, getByName: () => ({ fetch: async () => { calls.push(Date.now()); return new Response('', { status: 502 }) } }) }
}
/** A MuxRunner stand-in that records claims and releases and answers the claim as told. */
const runnerAnswering = (claimed) => {
  const calls = []
  return { calls, getByName: () => ({ async schedule() { calls.push('schedule') }, async claim() { calls.push('claim'); return claimed }, async release() { calls.push('release') } }) }
}

/** The real Innertube body shape, from the captured fixture, with a duration set explicitly. */
const innertube = (lengthSeconds = '212') => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/youtube-innertube-ordinary.json', import.meta.url), 'utf8'))
  raw.videoDetails.lengthSeconds = lengthSeconds
  return raw
}
/** oembed always answers; youtubei answers the given body, or 403 when `answer` is null (the refused half). */
const stubYouTube = answer => {
  const real = globalThis.fetch
  globalThis.fetch = async url => {
    const u = String(url)
    if (/\/oembed\?/.test(u)) return new Response(JSON.stringify({ title: 'T', author_name: 'A' }), { headers: { 'content-type': 'application/json' } })
    if (/youtubei\/v1\/player/.test(u)) return answer ? new Response(JSON.stringify(answer()), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 403 })
    throw new Error(`unexpected upstream request: ${u}`)
  }
  return () => { globalThis.fetch = real }
}

// ── 1. Persist what Innertube said

test("INNERTUBE'S ANSWER IS PERSISTED ON THE FIRST SUCCESSFUL RENDER — any client, any colo", async () => {
  const restore = stubYouTube(() => innertube('212'))
  try {
    const ref = ytRef('persist0001')
    const r2 = fakeR2()
    const ctx = retainingCtx()
    const post = await liveFetchPost(ref, envWith({ r2 }), 'human', undefined, ctx)
    assert.equal(post.media[0].duration, 212, 'the render itself got the duration')
    await Promise.allSettled(ctx.kept)
    const raw = r2.store.get(metaCacheKey(ref))
    assert.ok(raw, 'and wrote the record the next render in another colo will read')
    const rec = JSON.parse(raw)
    assert.equal(rec.duration, 212)
    assert.equal(typeof rec.timestamp, 'number')
    assert.equal(rec.jarred, undefined, 'no jarred: this rung sent no cookie, and claiming one would be a lie the age gate reads')
    assert.equal(rec.isLive, undefined, 'isLive only when true, so absence keeps meaning unknown')
  } finally { restore() }
})

test('THE REFUSED RENDER IN THE OTHER COLO READS IT BACK, AND THE HEAD STANDS THE STOCK PLAYER DOWN', async () => {
  // The exact 13:47 sequence: a human render that Innertube answered, then a crawler render that it
  // refused. Before this, the second render knew nothing and shipped the iframe.
  const ref = ytRef('persist0002')
  const r2 = fakeR2()
  let restore = stubYouTube(() => innertube('90'))
  try {
    const ctx = retainingCtx()
    await liveFetchPost(ref, envWith({ r2 }), 'human', undefined, ctx)
    await Promise.allSettled(ctx.kept)
  } finally { restore() }
  restore = stubYouTube(null)
  try {
    const env = envWith({ r2, resolver: countingResolver() })
    const post = await liveFetchPost(ref, env, 'discord')
    assert.equal(post.media[0].duration, 90, 'the record filled what the refused call could not')
    assert.notEqual(post.createdAt.getTime(), 0, 'and the date with it')
    const deps = { ...depsFor(ytPost), fetchPost: r => liveFetchPost(r, env, 'discord') }
    const html = await (await handle(bot(headUrl(ref)), env, retainingCtx(), deps)).text()
    assert.ok(html.includes('type="application/activity+json"'), 'the crawler render promises')
    assert.ok(!html.includes('youtube.com/embed/'), 'no stock iframe on a video we can now vouch for')
  } finally { restore() }
})

test('NOTHING IS WRITTEN WHEN INNERTUBE WAS REFUSED, AND A WARM RECORD IS NEVER OVERWRITTEN', async () => {
  const ref = ytRef('persist0003')
  const r2 = fakeR2()
  let restore = stubYouTube(null)
  try {
    const ctx = retainingCtx()
    await liveFetchPost(ref, envWith({ r2 }), 'discord', undefined, ctx)
    await Promise.allSettled(ctx.kept)
    assert.equal(r2.store.get(metaCacheKey(ref)), undefined, 'a refusal is not an answer to persist')
  } finally { restore() }
  // A container-written record (jarred, with a gate verdict) must not be replaced by an Innertube one.
  r2.store.set(metaCacheKey(ref), JSON.stringify({ timestamp: 1256453853, duration: 33, ageLimit: 18, jarred: true }))
  restore = stubYouTube(() => innertube('212'))
  try {
    const ctx = retainingCtx()
    const post = await liveFetchPost(ref, envWith({ r2 }), 'discord', undefined, ctx)
    await Promise.allSettled(ctx.kept)
    assert.equal(JSON.parse(r2.store.get(metaCacheKey(ref))).jarred, true, 'the record the jar was spent on stands')
    assert.equal(post.media[0].duration, 33, 'and it is the record that wins on the post')
  } finally { restore() }
})

// ── 2. One mux worldwide

test('claimIsLive(): a claim is live for MUX_CLAIM_TTL_MS and dead after, junk is never live', () => {
  const now = 1_000_000_000
  assert.equal(claimIsLive(undefined, now), false)
  assert.equal(claimIsLive(now - 1000, now), true)
  assert.equal(claimIsLive(now - MUX_CLAIM_TTL_MS + 1, now), true)
  assert.equal(claimIsLive(now - MUX_CLAIM_TTL_MS, now), false, 'an inline attempt cannot outlive the 30s waitUntil ceiling, so a claim this old is a dead isolate')
  assert.equal(claimIsLive('yesterday', now), false)
  assert.equal(claimIsLive(NaN, now), false)
})

test('A MUX ANOTHER ISOLATE HOLDS IS JOINED, NOT STARTED AGAIN — and the join is counted with its wait', async () => {
  const resolver = countingResolver()
  const r2 = fakeR2()
  const ae = recordingAE()
  const runner = runnerAnswering(false)
  const ref = ytRef('claim000001')
  setTimeout(() => r2.store.set(`mux/${refKey(ref)}/0`, 'bytes-from-the-isolate-that-holds-the-claim'), 300)
  const ctx = retainingCtx()
  await handle(bot(headUrl(ref)), envWith({ resolver, r2, ae, runner }), ctx, depsFor(ytPost))
  await Promise.allSettled(ctx.kept)
  assert.equal(resolver.calls.length, 0, 'no second yt-dlp on the same one-vCPU slot')
  assert.ok(runner.calls.includes('claim'), 'the claim was asked')
  const joined = ae.rows.filter(r => r.blobs?.[1] === 'mux_joined')
  assert.equal(joined.length, 1, 'one join row')
  assert.deepEqual(joined[0].blobs, ['yt', 'mux_joined', 'none'], 'a mux row: platform, outcome, no client')
  assert.ok(joined[0].doubles[1] >= 250, `double2 is the wait for the other isolate's bytes (${joined[0].doubles[1]}ms)`)
})

test('THE ISOLATE THAT WINS THE CLAIM RUNS THE MUX AND RELEASES IT WHEN THE ATTEMPT ENDS', async () => {
  const resolver = countingResolver()
  const runner = runnerAnswering(true)
  const ctx = retainingCtx()
  await handle(bot(headUrl(ytRef('claim000002'))), envWith({ resolver, runner }), ctx, depsFor(ytPost))
  await Promise.allSettled(ctx.kept)
  assert.equal(resolver.calls.length, 1, 'exactly one container call')
  const seq = runner.calls.filter(c => c !== 'schedule')
  assert.deepEqual(seq, ['claim', 'release'], 'claimed before the work, released after it — even a refused attempt releases')
})

test('THE ALARM NEVER CLAIMS — a Durable Object must not call itself from its own alarm', async () => {
  // runMuxJob is what MuxRunner.alarm() runs INSIDE the object. An RPC back to the same object from
  // there would wait on an object that is busy running this very alarm.
  const resolver = countingResolver()
  const runner = runnerAnswering(false)
  const ref = ytRef('claim000003')
  await runMuxJob(envWith({ resolver, runner }), { key: `mux/${refKey(ref)}/0`, slotKey: refKey(ref), source: { page: `https://www.youtube.com/watch?v=${ref.id}` } })
  assert.equal(resolver.calls.length, 1, 'the alarm attempt runs the mux')
  assert.ok(!runner.calls.includes('claim'), 'and never asks the object it is running inside')
})

test('A RUNNER WITHOUT claim() — the shape before 1.15.1 — DISPATCHES AS BEFORE', async () => {
  const resolver = countingResolver()
  const runner = { getByName: () => ({ async schedule() {} }) }
  const ctx = retainingCtx()
  await handle(bot(headUrl(ytRef('claim000004'))), envWith({ resolver, runner }), ctx, depsFor(ytPost))
  await Promise.allSettled(ctx.kept)
  assert.equal(resolver.calls.length, 1)
})
