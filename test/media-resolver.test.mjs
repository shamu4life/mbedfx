import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'

// The /_media/ remux orchestration, exercised with a synthetic post that carries a `remux` video and
// mocked bindings — no container, no real R2, no platform. Proves: resolver present -> mux + cache +
// range-serve; resolver absent -> the post's video degrades to its poster still; a mux failure -> the
// poster; a second hit -> served from R2 without re-muxing.

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

/** Minimal in-memory R2 bucket: head/get(range)/put(stream). */
function fakeR2() {
  const store = new Map() // key -> Uint8Array
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k, opts) {
      const v = store.get(k)
      if (!v) return null
      if (opts?.range) {
        const off = opts.range.offset ?? 0
        const slice = v.slice(off, opts.range.length != null ? off + opts.range.length : undefined)
        return { body: new Response(slice).body, size: v.length }
      }
      return { body: new Response(v).body, size: v.length }
    },
    async put(k, body) { store.set(k, new Uint8Array(await new Response(body).arrayBuffer())) },
  }
}

const REF = { p: 'bs', handle: 'a.bsky.social', rkey: 'k' }
const KEY = `mux/${refKey(REF)}/0`
const remuxPost = () => ({
  ref: REF, canonical: 'https://bsky.app/x',
  author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: 'https://cdn.bsky.app/v.m3u8', w: 1280, h: 720, poster: 'https://cdn.bsky.app/thumb.jpg', remux: { video: 'https://cdn.bsky.app/v.m3u8' } }],
})

const MP4 = 'FAKE-MP4-BYTES-0123456789'
const withResolver = (impl) => ({
  AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) },
  MEDIA_CACHE: fakeR2(),
})
const noResolver = () => ({ AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } })
const mediaReq = (i = 0) =>
  new Request(`https://staging.megapenispoopenfarten.sex/_media/${encodeURIComponent(refKey(REF))}/${i}`, {
    headers: { 'user-agent': 'Discordbot/2.0' },
  })

test('resolver present: /_media/ muxes via the container, caches in R2, serves video/mp4', async () => {
  let sentBody
  const env = withResolver(async (_url, init) => { sentBody = JSON.parse(init.body); return new Response(MP4, { headers: { 'content-type': 'video/mp4' } }) })
  const res = await handle(mediaReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(await res.text(), MP4)
  assert.deepEqual(sentBody, { video: 'https://cdn.bsky.app/v.m3u8' }, 'the remux source is sent to the container')
  assert.ok(env.MEDIA_CACHE.store.has(KEY), 'the muxed mp4 is cached in R2')
})

test('a Range request is honoured with 206 + Content-Range', async () => {
  const env = withResolver(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }))
  const req = new Request(mediaReq().url, { headers: { 'user-agent': 'Discordbot/2.0', range: 'bytes=0-3' } })
  const res = await handle(req, env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 0-3/${MP4.length}`)
  assert.equal(await res.text(), MP4.slice(0, 4))
})

test('a second hit serves from R2 without calling the container again', async () => {
  let calls = 0
  const env = withResolver(async () => { calls++; return new Response(MP4, { headers: { 'content-type': 'video/mp4' } }) })
  const deps = { cache: fakeCache(), fetchPost: async () => remuxPost() }
  await handle(mediaReq(), env, ctx, deps)
  await handle(mediaReq(), env, ctx, deps)
  assert.equal(calls, 1, 'muxed once, then served from R2')
})

test('a mux failure answers 503 no-store — the VIDEO url must never serve an image', async () => {
  // REVERSED DELIBERATELY (2026-07-24). This used to 302 to the poster "never a dead player", and that
  // fallback was the bug: this is the url og:video points at, so Discord's media proxy fetched it, landed
  // on content-type image/jpeg, and CACHED "this video is an image" — every later view then drew a static
  // frame that could never play, and re-pasting could not clear it (the poisoned entry is keyed by the
  // media url, which does not change). The card's still comes from og:image / preview_url (the separate
  // poster path), so answering the video url with an image bought nothing. 503 + no-store caches nothing.
  const env = withResolver(async () => new Response('nope', { status: 502 }))
  const res = await handle(mediaReq(), env, ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.ok(!(res.headers.get('location') || '').includes('poster'), 'never redirect the video url to the still')
})

test('resolver absent: the remux video degrades to its poster image (302 to the thumbnail)', async () => {
  const res = await handle(mediaReq(), noResolver(), ctx, { cache: fakeCache(), fetchPost: async () => remuxPost() })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://cdn.bsky.app/thumb.jpg', 'withResolver stripped it to the cover')
})
