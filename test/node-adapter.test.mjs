import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter, gracefulStop, toRequest, writeResponse } from '../adapters/node/server.ts'
import { DirBucket, keyFile } from '../adapters/node/r2dir.ts'
import { ENV_VARS, envVars, inProcessMuxRunner, memoryCache, trackingContext } from '../adapters/node/bindings.ts'
import { refKey } from '../src/refkey.ts'

/**
 * THE NODE ADAPTER (adapters/node/), started in this process on a random port and driven over real
 * sockets, with a fake container on another. Issue #27 Phase 1 is "the production handler, unchanged,
 * off Cloudflare", and every one of these checks a way that claim fails while the server still answers
 * 200:
 *
 *   - og: urls minted from the socket address instead of the public origin, so every card Discord
 *     caches points at 127.0.0.1;
 *   - a waitUntil that does not wait, so cache writes and muxes die with the response;
 *   - a directory "bucket" that loses `uploaded`, serves half-written files or folds case;
 *   - a resolver on fetch(), whose 300 s header timeout is shorter than the container's 360 s mux;
 *   - a cron that reaches for `caches.default`, which Node does not have.
 *
 * OFFLINE. `fetch` is stubbed to refuse anything that is not loopback, so a live fetcher that slipped
 * past a stub fails here instead of reaching the internet. The resolver stand-in uses node:http, which
 * the stub does not cover, and its only peer is the fake container below.
 *
 * Every post gets its own id: muxInflight and the post caches in src/worker.ts are module-level.
 */

const PRIMARY = 'https://embed.example.test'
const DIRECT = 'https://d.embed.example.test'
const SECRET = 'test-secret-not-real'
const BOT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const MP4 = Buffer.from('FAKE-MP4-0123456789abcdefghijklmnopqrstuvwxyz')

const realFetch = globalThis.fetch
const loopback = u => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u)
before(() => {
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (loopback(u)) return realFetch(input, init)
    throw new Error('network refused in tests')
  }
})
after(() => { globalThis.fetch = realFetch })

const cleanups = []
after(async () => { for (const c of cleanups.reverse()) await c() })

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })

/** A container/server.py look-alike that records what it was sent. */
async function fakeContainer(answer) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const call = { method: req.method, path: req.url, secret: req.headers['x-resolver-secret'], body: body ? JSON.parse(body) : null }
      calls.push(call)
      answer(call, res)
    })
  })
  const port = await listen(server)
  cleanups.push(() => closeServer(server))
  return { url: `http://127.0.0.1:${port}`, calls }
}

async function start(over = {}) {
  const mediaDir = mkdtempSync(join(tmpdir(), 'mbedfx-adapter-test-'))
  const lines = []
  const adapter = createAdapter({
    origins: [PRIMARY, DIRECT],
    mediaDir,
    containerUrl: null,
    vars: { RESOLVER_SECRET: SECRET, TRANSLATE_GOOGLE: 'off' },
    log: line => lines.push(line),
    ...over,
  })
  const port = await listen(adapter.server)
  cleanups.push(async () => {
    await adapter.drain(5000)
    adapter.close()
    await closeServer(adapter.server)
    rmSync(mediaDir, { recursive: true, force: true })
  })
  return { adapter, port, base: `http://127.0.0.1:${port}`, mediaDir, lines }
}

/** A raw request, for what fetch() hides: a HEAD body, a chosen Host header. */
function raw(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const tweet = id => ({
  ref: { p: 'x', id },
  canonical: `https://x.com/adapterwatch/status/${id}`,
  author: { name: 'adapter watch', handle: 'adapterwatch', url: 'https://x.com/adapterwatch', avatar: 'https://example.invalid/a.jpg' },
  text: 'a post rendered off Cloudflare',
  createdAt: new Date('2026-11-01T12:00:00Z'),
  counts: { likes: 4, replies: 1 },
  sensitive: false,
  media: [{ kind: 'image', url: 'https://example.invalid/one.jpg', w: 800, h: 600 }],
})

const offlineDeps = (post = null) => {
  let calls = 0
  return {
    calls: () => calls,
    deps: {
      fetchPost: async () => { calls++; return typeof post === 'function' ? post() : post },
      fetchProfile: async () => null,
      resolveShortlink: async () => ({ kind: 'unresolved' }),
      resolveRedditShare: async () => null,
      resolveMetaShare: async () => null,
    },
  }
}

// ── HTTP glue ──────────────────────────────────────────────────────────────────────────────────────

test('a SITE_PATH is served from public/ byte for byte, and /index.html redirects as Cloudflare does', async () => {
  // Measured against mbedfx.app 2026-11-25: `/` is index.html, `/index.html` is a 307 to `/`. The bytes
  // are compared with the file, because an assets stand-in that answers 200 with the wrong file (or an
  // empty one) is the failure a status check passes.
  const { base } = await start()
  const robots = await fetch(`${base}/robots.txt`)
  assert.equal(robots.status, 200)
  assert.equal(robots.headers.get('content-type'), 'text/plain')
  assert.deepEqual(Buffer.from(await robots.arrayBuffer()), readFileSync(new URL('../public/robots.txt', import.meta.url)))
  const home = await fetch(`${base}/`)
  assert.deepEqual(Buffer.from(await home.arrayBuffer()), readFileSync(new URL('../public/index.html', import.meta.url)))
  const moved = await fetch(`${base}/index.html`, { redirect: 'manual' })
  assert.equal(moved.status, 307)
  assert.equal(moved.headers.get('location'), '/')
})

test('a post url reaches handle, and the card is minted on PUBLIC_ORIGIN, never on the socket', async () => {
  // The socket is 127.0.0.1:<random>. Had the adapter built the Request from it, every alternate link
  // (the activity document Discord reads for media) would point there, and Discord caches that url.
  const id = '2000000000000000901'
  const { base } = await start({ deps: offlineDeps(tweet(id)).deps })
  const res = await fetch(`${base}/adapterwatch/status/${id}`, { headers: { 'user-agent': BOT } })
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /<meta property="og:title" content="adapter watch \(@adapterwatch\)"\/>/)
  assert.match(html, /<meta property="og:description" content="a post rendered off Cloudflare"\/>/)
  assert.match(html, /type="application\/activity\+json" href="https:\/\/embed\.example\.test\/users\/adapterwatch\/statuses\//)
  assert.doesNotMatch(html, /127\.0\.0\.1/, 'the socket address must not reach a card')
})

test('the Host header picks among configured origins only: d. is honoured, an unlisted host gets the primary', async () => {
  // `d.` serves a post's bytes rather than its card (DIRECT_MEDIA_HOST, src/worker.ts), so the second
  // configured origin has to be reachable by Host. An unlisted Host must not become the origin of
  // anything, or a client could choose the domain a cached card advertises.
  const id = '2000000000000000902'
  const { port } = await start({ deps: offlineDeps(tweet(id)).deps })
  const evil = await raw(port, 'GET', `/adapterwatch/status/${id}`, { 'user-agent': BOT, host: 'evil.example' })
  assert.equal(evil.status, 200)
  assert.match(evil.body.toString(), /href="https:\/\/embed\.example\.test\/users\//)
  assert.doesNotMatch(evil.body.toString(), /evil\.example/)
  const direct = await raw(port, 'GET', `/adapterwatch/status/${id}`, { 'user-agent': BOT, host: 'd.embed.example.test' })
  assert.equal(direct.status, 302, 'a d. host answers with the bytes, not the card')
  assert.match(direct.headers.location, /^https:\/\/d\.embed\.example\.test\/_media\//, 'minted on the d. origin it was asked on')
})

test('the request target cannot choose the host: //host is a path, an absolute-form target is refused', () => {
  // `new URL('//evil.example/x', origin)` resolves to evil.example. The adapter concatenates instead,
  // which is the whole defence, so it is pinned on the function itself.
  const msg = (url, method = 'GET') => ({ url, method, rawHeaders: ['Host', 'embed.example.test'], headers: { host: 'embed.example.test' } })
  const r = toRequest(msg('//evil.example/x'), [PRIMARY])
  assert.equal(new URL(r.url).host, 'embed.example.test')
  assert.equal(new URL(r.url).pathname, '//evil.example/x')
  assert.equal(toRequest(msg('http://evil.example/x'), [PRIMARY]), null)
  assert.equal(toRequest(msg('*'), [PRIMARY]), null)
  assert.equal(toRequest(msg('/x', 'TRACE'), [PRIMARY]), null, 'fetch refuses TRACE, so the adapter does first')
})

test('HEAD answers the headers and no body, for an asset and for a card', async () => {
  // Checked over a raw socket because fetch() discards a HEAD body itself and would pass either way.
  const id = '2000000000000000903'
  const { port } = await start({ deps: offlineDeps(tweet(id)).deps })
  const asset = await raw(port, 'HEAD', '/robots.txt')
  assert.equal(asset.status, 200)
  assert.equal(asset.headers['content-length'], String(readFileSync(new URL('../public/robots.txt', import.meta.url)).length))
  assert.equal(asset.body.length, 0)
  const card = await raw(port, 'HEAD', `/adapterwatch/status/${id}`, { 'user-agent': BOT })
  assert.equal(card.status, 200)
  assert.match(card.headers['content-type'], /^text\/html/)
  assert.equal(card.body.length, 0)
})

test('a HEAD response cancels the body it was handed, so no file or socket is left open under it', async () => {
  // Node's ServerResponse already keeps a HEAD body off the wire, so the test above passes without the
  // cancel. What the cancel buys is the source: an R2 file stream or a container socket that nobody
  // reads stays open until the garbage collector finds it.
  let cancelled = false
  let pulled = 0
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(8)) }, cancel() { cancelled = true } })
  const written = []
  const res = { writeHead(...a) { written.push(['head', a[0]]) }, end() { written.push(['end']) }, write() { written.push(['write']) } }
  await writeResponse(res, new Response(body, { headers: { 'content-type': 'video/mp4' } }), true)
  assert.equal(cancelled, true)
  assert.deepEqual(written, [['head', 200], ['end']])
  assert.ok(pulled <= 1, 'the body was not read through')
})

test('a write verb reaches the worker without its body, so /_api/v1 keeps its documented JSON 405', async () => {
  // docs/API.md promises `method_not_allowed` as JSON for every method but GET, HEAD and OPTIONS, and
  // production answers exactly that (measured 2026-11-25). An adapter-level 405 would change the body.
  const { base } = await start()
  const res = await fetch(`${base}/_api/v1?url=${encodeURIComponent('https://x.com/a/status/1')}`, { method: 'POST', body: 'ignored' })
  assert.equal(res.status, 405)
  assert.equal((await res.json()).error.code, 'method_not_allowed')
})

// ── ctx.waitUntil ──────────────────────────────────────────────────────────────────────────────────

test('drain waits for waitUntil work, including work handed over by other work, and a rejection is only a log line', async () => {
  // A no-op waitUntil silently cancels muxes, slot releases and cache writes (docs/SELF-HOSTING.md). In
  // Node an unhandled rejection exits the process, so a rejecting cache write must not escape either.
  const lines = []
  const { ctx, drain } = trackingContext(l => lines.push(l))
  const done = []
  ctx.waitUntil(new Promise(r => setTimeout(() => {
    done.push('outer')
    ctx.waitUntil(new Promise(r2 => setTimeout(() => { done.push('inner'); r2() }, 30)))
    r()
  }, 30)))
  ctx.waitUntil(Promise.reject(new Error('write failed for https://example.invalid/secret')))
  assert.equal(await drain(5000), true)
  assert.deepEqual(done, ['outer', 'inner'])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /waitUntil rejected: Error: write failed for <url>/, 'and the log line carries no url')
})

test('the response-cache write rides waitUntil and lands: the second paste never reaches the fetcher', async () => {
  const id = '2000000000000000904'
  const fetcher = offlineDeps(tweet(id))
  const { base, adapter } = await start({ deps: fetcher.deps })
  const url = `${base}/adapterwatch/status/${id}`
  await (await fetch(url, { headers: { 'user-agent': BOT } })).text()
  assert.equal(await adapter.drain(5000), true)
  assert.ok(adapter.cache.size() > 0, 'the response cache holds the card')
  const again = await fetch(url, { headers: { 'user-agent': BOT } })
  assert.match(await again.text(), /adapter watch/)
  assert.equal(fetcher.calls(), 1, 'the second render is served from the cache the first one wrote')
})

// ── MEDIA_CACHE as a directory ─────────────────────────────────────────────────────────────────────

test('the directory bucket round-trips head, get, a ranged get, put, putStream and delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbedfx-r2dir-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const b = new DirBucket(dir)

  assert.equal(await b.head('meta/g1/x:1.json'), null)
  await b.put('meta/g1/x:1.json', JSON.stringify({ a: 1 }))
  const h = await b.head('meta/g1/x:1.json')
  assert.equal(h.size, 7)
  // gaveUpIsFresh checks instanceof Date and readCachedMeta calls getTime(); a number or a string here
  // makes both fail silently.
  assert.ok(h.uploaded instanceof Date)
  assert.ok(Math.abs(Date.now() - h.uploaded.getTime()) < 60_000)
  assert.deepEqual(await (await b.get('meta/g1/x:1.json')).json(), { a: 1 })

  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i)
  await b.put('mux/bs:a/0', bytes)
  const part = await b.get('mux/bs:a/0', { range: { offset: 10, length: 5 } })
  assert.equal(part.size, 100, 'size is the whole object, as R2 reports it')
  assert.deepEqual([...new Uint8Array(await new Response(part.body).arrayBuffer())], [10, 11, 12, 13, 14])

  await b.putStream('mux/bs:b/0', new Response(MP4).body, MP4.length)
  assert.deepEqual(Buffer.from(await (await b.get('mux/bs:b/0')).arrayBuffer()), MP4)
  // A transfer that ends short is not stored: nothing re-muxes a key that heads, so a truncated file
  // would be the video at that key for good.
  await assert.rejects(b.putStream('mux/bs:c/0', new Response(MP4).body, MP4.length + 1), /short write/)
  assert.equal(await b.head('mux/bs:c/0'), null)

  // The give-up mark is an empty object, and it has to exist.
  await b.put('muxfail/g1/mux/bs:a/0', '')
  assert.equal((await b.head('muxfail/g1/mux/bs:a/0')).size, 0)
  assert.equal(await (await b.get('muxfail/g1/mux/bs:a/0')).text(), '')

  await b.delete('mux/bs:a/0')
  assert.equal(await b.head('mux/bs:a/0'), null)
  await b.delete('never-existed')
  assert.deepEqual(readdirSync(join(dir, '#tmp')), [], 'no temp file is left behind, even by the failed write')
})

test('a key cannot leave the directory, and two keys that differ only in case are two files', async () => {
  // YouTube ids are case-sensitive and macOS and Windows disks are not. Folding them would serve one
  // video's bytes for the other.
  for (const k of ['../../etc/passwd', '..', '.', 'a/../../b']) {
    assert.doesNotMatch(keyFile(k), /\//, k)
    assert.notEqual(keyFile(k), '..')
    assert.notEqual(keyFile(k), '.')
  }
  assert.notEqual(keyFile('mux/yt:jNQXAC9IVRw/0').toLowerCase(), keyFile('mux/yt:jnqxac9ivrw/0').toLowerCase())
  assert.equal(keyFile('mux/yt:jNQXAC9IVRw/0'), keyFile('mux/yt:jNQXAC9IVRw/0').toLowerCase(), 'no capital is left')
  assert.match(keyFile('x'.repeat(400)), /^#[0-9a-f]{64}$/, 'a name past NAME_MAX is hashed')
})

// ── MEDIA_RESOLVER and the whole /_media path ──────────────────────────────────────────────────────

const BS = { p: 'bs', handle: 'adapter.bsky.social', rkey: 'adapter-mux-1' }
const bsPost = () => ({
  ref: BS, canonical: 'https://bsky.app/profile/adapter.bsky.social/post/adapter-mux-1',
  author: { name: 'A', handle: 'adapter.bsky.social', url: 'https://bsky.app/profile/adapter.bsky.social' },
  text: 't', createdAt: new Date('2026-11-01T00:00:00Z'), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: 'https://video.bsky.app/v.m3u8', w: 1280, h: 720, poster: 'https://video.bsky.app/thumb.jpg', remux: { video: 'https://video.bsky.app/v.m3u8' } }],
})

test('/_media muxes through the container into the directory and serves a byte range of it', async () => {
  // One request exercises the resolver stand-in (secret, path, body), putStream into the directory and
  // the ranged read back out, streamed through node:http.
  const container = await fakeContainer((call, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) })
    res.end(MP4)
  })
  const { base, mediaDir, adapter } = await start({ containerUrl: container.url, deps: offlineDeps(bsPost).deps })
  const url = `${base}/_media/${encodeURIComponent(refKey(BS))}/0`

  const part = await fetch(url, { headers: { 'user-agent': BOT, range: 'bytes=0-3' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${MP4.length}`)
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), 'FAKE')

  assert.equal(container.calls.length, 1)
  assert.equal(container.calls[0].path, '/resolve')
  assert.equal(container.calls[0].secret, SECRET)
  assert.deepEqual(container.calls[0].body, { video: 'https://video.bsky.app/v.m3u8' })
  assert.ok(readdirSync(mediaDir).includes(keyFile(`mux/${refKey(BS)}/0`)), 'the mp4 is a file in the directory')

  const whole = await fetch(url, { headers: { 'user-agent': BOT } })
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), MP4)
  assert.equal(container.calls.length, 1, 'the second view is served from the directory, not re-muxed')
  assert.ok(adapter.mux.size() >= 1, 'and the alarm was armed, as on Cloudflare')
})

test('/_clients reaches the container with the secret, and a container that never answers times out', async () => {
  const container = await fakeContainer((call, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, serving: ['tv_simply'], clients: [] }))
  })
  const { base } = await start({ containerUrl: container.url })
  const res = await fetch(`${base}/_clients`)
  const j = await res.json()
  assert.equal(j.ok, true)
  assert.deepEqual(j.serving, ['tv_simply'])
  assert.deepEqual(container.calls[0].body, { probe: true })
  assert.equal(container.calls[0].secret, SECRET)

  // The idle timeout is what replaces undici's 300 s header timeout; here it is shrunk so the test can
  // see it fire. The worker turns the rejection into its own 502.
  const silent = await fakeContainer(() => {})
  const slow = await start({ containerUrl: silent.url, resolverTimeoutMs: 200 })
  const t0 = Date.now()
  const r = await fetch(`${slow.base}/_clients`)
  assert.equal(r.status, 502)
  assert.equal((await r.json()).error, 'resolver unreachable')
  assert.ok(Date.now() - t0 < 5000)
})

test('A STOP WAITS FOR THE REQUEST IN FLIGHT, not only for waitUntil work (review, 2026-11-25)', async () => {
  // The reproduction: a container that answers after 1.5 s, a /_clients call in flight, then a stop
  // 0.3 s in. The first version closed the server and drained only the waitUntil set, so the caller
  // got an empty reply while the log said "all settled".
  const slow = await fakeContainer((call, res) => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, serving: ['web_embedded'], clients: [] }))
  }, 1500))
  const { adapter, port } = await start({ containerUrl: slow.url })
  let answeredAt = 0
  const inFlight = raw(port, 'GET', '/_clients', { host: new URL(PRIMARY).host })
    .then(res => { answeredAt = Date.now(); return res })
  await new Promise(r => setTimeout(r, 300))
  let stoppedAt = 0
  const stopped = gracefulStop(adapter, 5000).then(r => { stoppedAt = Date.now(); return r })
  const res = await inFlight
  assert.equal(res.status, 200, 'the request in flight finished')
  assert.deepEqual(JSON.parse(res.body.toString()).serving, ['web_embedded'])
  const r = await stopped
  // THE ORDER IS THE FIX: main() calls process.exit as soon as this resolves, so resolving before the
  // answer went out is the empty reply the review reproduced.
  assert.ok(answeredAt > 0 && stoppedAt >= answeredAt, `stop resolved after the answer (${stoppedAt - answeredAt} ms)`)
  assert.equal(r.requestsDone, true, 'and the stop says so')
  assert.equal(r.backgroundClean, true)
  // A request after the stop is refused: the server no longer listens.
  await assert.rejects(raw(port, 'GET', '/_clients', { host: new URL(PRIMARY).host }))
})

// ── MUX_RUNNER ─────────────────────────────────────────────────────────────────────────────────────

test('the mux runner: first schedule wins, claim is check-and-set, the alarm disarms before it runs and never throws', async () => {
  const { ctx, drain } = trackingContext(() => {})
  const ran = []
  // WAITS ON THE RUNS THEMSELVES, not on a sleep: this suite is the deploy gate, and a sleep that is
  // long enough on a laptop is short on a loaded build machine. When run n starts, its alarm is
  // already in the waitUntil set, so drain() then waits for it to finish.
  let notify = () => {}
  const reached = n => new Promise((resolve, reject) => {
    if (ran.length >= n) return resolve()
    const t = setTimeout(() => reject(new Error(`${ran.length} of ${n} alarm runs within 5 s`)), 5000)
    notify = () => { if (ran.length >= n) { clearTimeout(t); resolve() } }
  })
  let throwNext = true
  const policy = {
    first: () => 20,
    next: spent => (spent < 2 ? 20 : null),
    run: async (_env, job) => {
      ran.push(job.source.video)
      notify()
      if (throwNext) { throwNext = false; throw new Error('container gone') }
      return true
    },
  }
  const lines = []
  const runner = inProcessMuxRunner({}, p => ctx.waitUntil(p), policy, l => lines.push(l))
  cleanups.push(() => runner.close())
  const key = 'mux/bs:runner-1/0'
  const stub = runner.getByName(key)

  // Two claims in the same tick: a DO's input gates make exactly one win, and so must this.
  assert.deepEqual(await Promise.all([stub.claim(), stub.claim()]), [true, false])
  await stub.release()
  assert.equal(await stub.claim(), true)
  await stub.release()

  await stub.schedule({ key, slotKey: 'bs:runner-1', source: { video: 'first' } })
  await stub.schedule({ key, slotKey: 'bs:runner-1', source: { video: 'second' } })
  await reached(2)
  assert.equal(await drain(5000), true)
  // The first attempt threw and was retried, not rethrown; the second succeeded and ended the job.
  assert.deepEqual(ran, ['first', 'first'])
  assert.deepEqual(lines, [], 'a throwing mux is a counted attempt, not an error')
  assert.equal(runner.size(), 0, 'a finished job leaves nothing behind')

  // The armed flag was cleared when the alarm fired, so a later paste can arm it again.
  await stub.schedule({ key, slotKey: 'bs:runner-1', source: { video: 'third' } })
  await reached(3)
  assert.equal(await drain(5000), true)
  assert.deepEqual(ran, ['first', 'first', 'third'])
})

// ── caches.default ─────────────────────────────────────────────────────────────────────────────────

test('the cache honours max-age, hands back a fresh body on every match, and never rejects', async () => {
  let now = 1_000_000
  const lines = []
  const cache = memoryCache({ now: () => now, log: l => lines.push(l) })
  await cache.put('https://cache.mbedfx.internal/a', new Response('card', { headers: { 'cache-control': 'max-age=900' } }))
  assert.equal(await (await cache.match('https://cache.mbedfx.internal/a')).text(), 'card')
  assert.equal(await (await cache.match('https://cache.mbedfx.internal/a')).text(), 'card', 'a second match is readable too')
  now += 901_000
  assert.equal(await cache.match('https://cache.mbedfx.internal/a'), undefined, 'past max-age is a miss')

  await cache.put('https://cache.mbedfx.internal/b', new Response('no lifetime'))
  assert.equal(await cache.match('https://cache.mbedfx.internal/b'), undefined, 'no max-age, no entry: a lifetime is never invented')

  const broken = new Response(new ReadableStream({ pull(c) { c.error(new Error('upstream reset')) } }), { headers: { 'cache-control': 'max-age=60' } })
  await cache.put('https://cache.mbedfx.internal/c', broken)
  assert.equal(lines.length, 1, 'the failed put is a log line, not a rejection')
})

// ── SMOKE_RUNNER and the cron ──────────────────────────────────────────────────────────────────────

test('a cron tick runs the check through SMOKE_RUNNER without caches.default, and /_health reads the week back', async () => {
  // Without the stand-in, smokeWhereReadersAre falls back to liveDeps(), whose default argument reads
  // `caches.default`: a ReferenceError in Node on every tick. The deps are offline, so every check fails,
  // and that is fine: what is asserted is that a week was recorded and read back.
  assert.equal(typeof globalThis.caches, 'undefined', 'Node has no Cache API, which is the point')
  const offline = offlineDeps(null).deps
  const { adapter, base, lines } = await start({ smokeDeps: () => ({ ...offline, cache: memoryCache() }) })
  const before = await (await fetch(`${base}/_health`)).json()
  assert.equal(before.updated, null)
  // The scheduled handler prints one line per failing check; every check fails here by design.
  const quiet = console.error
  const printed = []
  console.error = (...a) => printed.push(a.join(' '))
  try {
    adapter.tick(Date.now())
    assert.equal(await adapter.drain(60_000), true)
  } finally {
    console.error = quiet
  }
  assert.ok(printed.some(l => /^smoke /.test(l)), 'the scheduled handler itself ran')
  assert.deepEqual(lines.filter(l => /ReferenceError|caches/.test(l)), [])
  const week = await (await fetch(`${base}/_health`)).json()
  assert.notEqual(week.updated, null, 'the tick wrote the week into the directory')
  assert.ok(week.checks.length > 0)
  for (const c of week.checks) assert.equal(c.runs, 1, c.name)
})

// ── env ────────────────────────────────────────────────────────────────────────────────────────────

test('every string var Env declares is read from the environment, and nothing else is', () => {
  // A var added to Env and not to ENV_VARS would be silently unset on every self-hosted instance. Parsed
  // from the source, as test/prep.test.mjs parses the Route union, so the list cannot drift.
  const src = readFileSync(new URL('../src/analytics.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export interface Env {'))
  const block = body.slice(0, body.indexOf('\n}\n'))
  const declared = [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\?: string\s*$/gm)].map(m => m[1]).sort()
  assert.ok(declared.length >= 20, `parsed ${declared.length} vars; the parser has gone stale`)
  assert.deepEqual([...ENV_VARS].sort(), declared)

  const env = envVars({ YT_PROMISE: '', OWN_HOSTS: 'mine.example', AI: '1', ASSETS: 'x', PATH: '/bin', X_ACCOUNTS_2: '[]' }, ['embed.example.test'])
  assert.equal(env.YT_PROMISE, 'off', 'unset or empty is production\'s value, from wrangler.jsonc')
  assert.equal(env.OWN_HOSTS, 'mine.example embed.example.test', 'the served host is refused as an instance too')
  assert.equal(env.X_ACCOUNTS_2, '[]', 'the overflow pools are read through a computed key and still arrive')
  for (const k of ['AI', 'ASSETS', 'PATH']) assert.equal(k in env, false, k)

  // The compose file names each variable it forwards, so a var missing there is unset in every
  // container however the operator fills .env.
  const compose = readFileSync(new URL('../adapters/node/compose.yaml', import.meta.url), 'utf8')
  const forwarded = new Set([...compose.matchAll(/^ {6}([A-Z][A-Z0-9_]*): \$\{\1[:}]/gm)].map(m => m[1]))
  for (const k of ENV_VARS) assert.ok(forwarded.has(k), `compose.yaml does not forward ${k}`)
})

test('no environment variable can shadow a binding, AI stays unbound and RESOLVE_HOST is wired', async () => {
  const { adapter } = await start({ vars: { AI: 'yes', AE: 'yes', MEDIA_RESOLVER: 'x', TRANSLATE_GOOGLE: 'off' } })
  assert.equal(adapter.env.AI, undefined)
  assert.equal(adapter.env.AE, undefined)
  assert.equal(adapter.env.MEDIA_RESOLVER, undefined, 'no CONTAINER_URL, no resolver, whatever the env says')
  assert.equal(typeof adapter.env.ASSETS.fetch, 'function')
  assert.equal(typeof adapter.env.RESOLVE_HOST, 'function')
  assert.equal(adapter.env.YT_PROMISE, 'off')
})

test('THE IMAGE NEVER CARRIES adapters/node/.env: the exclusion sits BELOW the re-include (review, 2026-11-25)', () => {
  // BuildKit applies .dockerignore rules in order and the last match wins, so `!adapters/node` re-includes
  // the operator's .env unless an exclusion for it comes after. Pinned as order, not as presence.
  const lines = readFileSync(new URL('../adapters/node/Dockerfile.dockerignore', import.meta.url), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const reinclude = lines.indexOf('!adapters/node')
  assert.ok(reinclude >= 0, 'the adapter directory is re-included')
  for (const rule of ['**/.env', '**/.env.*']) {
    assert.ok(lines.indexOf(rule) > reinclude, `${rule} must come after !adapters/node`)
  }
  assert.ok(!lines.slice(reinclude + 1).some(l => /^!.*\.env/.test(l)), 'nothing re-includes an env file after it')
})
