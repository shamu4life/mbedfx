import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'

/**
 * THE FIRST PASTE OF A `{video}` VIDEO (2026-11-24): the mux starts at render time, and every container
 * attempt leaves a `stage_times` row saying where its seconds went.
 *
 * Measured that day: cold Reddit muxes of 8-11 s, started only when Discord asked /_media for the file
 * (2-3 s after the head), against a Discord video fetch that gives up at about 10 s from the head. The
 * owner's two failed Reddit pastes of 2026-11-14 and -16 were both cold muxes of that length.
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const BS_REF = { p: 'bs', did: 'did:plc:firstpaste', rkey: 'fp0001' }
const HLS = 'https://video.bsky.app/watch/did%3Aplc%3Afirstpaste/fp0001/playlist.m3u8'

const bsPost = (ref = BS_REF) => ({
  ref, canonical: `https://bsky.app/profile/${ref.did}/post/${ref.rkey}`,
  author: { name: 'first paste', handle: 'firstpaste.bsky.social', url: 'https://bsky.app/profile/firstpaste.bsky.social' },
  text: 'a video nobody has pasted before', createdAt: new Date('2026-11-24T00:00:00Z'), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: HLS, w: 0, h: 0, poster: 'https://video.bsky.app/thumb.jpg', remux: { video: HLS } }],
})

const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
function fakeR2() {
  const store = new Map()
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length, uploaded: new Date() } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length } : null },
    async put(k, body) { store.set(k, new Uint8Array(await new Response(body).arrayBuffer())) },
    async delete(k) { store.delete(k) },
  }
}
const recordingAE = () => {
  const rows = []
  return { rows, writeDataPoint(d) { rows.push(d) } }
}
const runner = () => ({ getByName: () => ({ async schedule() {}, async claim() { return true }, async release() {} }) })
const ctx = () => ({ waits: [], waitUntil(p) { this.waits.push(Promise.resolve(p).catch(() => {})) } })
const deps = post => ({
  cache: fakeCache(), fetchPost: async () => post,
  resolveShortlink: async () => ({ kind: 'unresolved' }), resolveRedditShare: async () => null,
})
const cardReq = (ref = BS_REF) => new Request(`https://mbedfx.app/profile/${ref.did}/post/${ref.rkey}`, { headers: { 'user-agent': DISCORD } })
const stageRows = ae => ae.rows.filter(r => r.blobs?.[1] === 'stage_times')

test('A `{video}` CARD STARTS ITS MUX WHILE THE CARD RENDERS, not when Discord asks for the file', async () => {
  const calls = []
  const env = {
    AE: recordingAE(), ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
    MEDIA_CACHE: fakeR2(), MUX_RUNNER: runner(),
    MEDIA_RESOLVER: { getByName: () => ({ fetch: async (u, init) => { calls.push(JSON.parse(init.body)); return new Response('', { status: 503 }) } }) },
  }
  const c = ctx()
  const res = await handle(cardReq(), env, c, deps(bsPost()))
  const html = await res.text()
  await Promise.all(c.waits)
  assert.ok(calls.some(b => b.video === HLS), `the container was asked during the render: ${JSON.stringify(calls)}`)
  assert.ok(html.includes(`${encodeURIComponent(refKey(BS_REF))}/0`), 'and the card still names the video, unchanged')
})

test('THE EARLY START RESPECTS THE GIVE-UP MARK: a video the alarm gave up on is not dispatched', async () => {
  const calls = []
  const r2 = fakeR2()
  // A `{video}` job never writes a mark (recordMuxGiveUp), but a mark from any source must still gate it.
  const { muxFailMarkKey } = await import('../src/worker.ts')
  r2.store.set(muxFailMarkKey(`mux/${refKey(BS_REF)}/0`), new Uint8Array())
  const env = {
    AE: recordingAE(), ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
    MEDIA_CACHE: r2, MUX_RUNNER: runner(),
    MEDIA_RESOLVER: { getByName: () => ({ fetch: async (u, init) => { calls.push(init.body); return new Response('', { status: 503 }) } }) },
  }
  const c = ctx()
  await (await handle(cardReq(), env, c, deps(bsPost()))).text()
  await Promise.all(c.waits)
  assert.equal(calls.length, 0)
})

test('A SUCCESSFUL ATTEMPT WRITES ONE stage_times ROW from the container\'s headers', async () => {
  const ae = recordingAE()
  const env = {
    AE: ae, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
    MEDIA_CACHE: fakeR2(), MUX_RUNNER: runner(),
    MEDIA_RESOLVER: { getByName: () => ({ fetch: async () => new Response(new Uint8Array(64), {
      status: 200, headers: { 'content-type': 'video/mp4', 'x-mux-run-ms': '4321', 'x-mux-uptime-s': '7', 'x-mux-variant': 'reuse' },
    }) }) },
  }
  const c = ctx()
  await (await handle(cardReq(), env, c, deps(bsPost()))).text()
  await Promise.all(c.waits)
  const rows = stageRows(ae)
  assert.equal(rows.length, 1, `one attempt, one row: ${JSON.stringify(rows)}`)
  const [row] = rows
  assert.deepEqual(row.blobs, ['bs', 'stage_times', 'none', 'tracks', 'ok', 'reuse'])
  assert.equal(row.doubles[0], 1)
  assert.equal(row.doubles[2], 4321, 'the container\'s own run time')
  assert.equal(row.doubles[4], 7, 'and how warm its instance was')
  assert.ok(row.doubles[1] >= 0 && row.doubles[3] >= 0, 'fetch and R2 times are measured, not guessed')
})

test('A FAILED ATTEMPT WRITES A fail ROW from the 502 body, and an older image reads as unknown', async () => {
  for (const [body, want] of [
    [JSON.stringify({ error: 'mux failed', detail: 'ERROR: x', run_ms: 1200, uptime_s: 300, variant: 'fallback' }), ['fallback', 1200, 300]],
    [JSON.stringify({ error: 'mux failed' }), ['unknown', -1, -1]],
    ['not json', ['unknown', -1, -1]],
  ]) {
    const ae = recordingAE()
    const ref = { ...BS_REF, rkey: `fp${want[0]}${want[1]}`.slice(0, 13) }
    const env = {
      AE: ae, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
      MEDIA_CACHE: fakeR2(), MUX_RUNNER: runner(),
      MEDIA_RESOLVER: { getByName: () => ({ fetch: async () => new Response(body, { status: 502 }) }) },
    }
    const c = ctx()
    await (await handle(cardReq(ref), env, c, deps(bsPost(ref)))).text()
    await Promise.all(c.waits)
    const rows = stageRows(ae)
    assert.ok(rows.length >= 1, `a row per attempt: ${body}`)
    assert.deepEqual(rows[0].blobs.slice(3), ['tracks', 'fail', want[0]], body)
    assert.equal(rows[0].doubles[2], want[1], body)
    assert.equal(rows[0].doubles[4], want[2], body)
    assert.ok(!JSON.stringify(ae.rows).includes('ERROR: x'), 'the reason never reaches a row')
  }
})
