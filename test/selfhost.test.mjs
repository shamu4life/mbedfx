import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { fetchableInstance, instanceFetchable } from '../src/platforms/fedihost.ts'
import { fetchMasto } from '../src/platforms/mastoapi/fetch.ts'
import { fetchLemmy } from '../src/platforms/lemmy/fetch.ts'
import { getGuestToken, resetGuestToken } from '../src/platforms/twitter/fetch.ts'

/**
 * THE CORRECTIONS ISSUE #27 REQUIRES BEFORE ANYONE EXPOSES A SELF-HOSTED INSTANCE — the four that
 * are behaviour rather than documentation. Each one is a thing that is CORRECT on Cloudflare and
 * silently wrong off it, which is the only reason none of them was a bug before:
 *
 *   1. OWN_HOSTS names mbedfx's own zones and cannot name yours (src/platforms/fedihost.ts).
 *   2. The address guard's DNS seam — the half a Worker cannot do (src/netguard.ts).
 *   3. `cf: { cacheEverything, cacheTtl }` on the Twitter guest-token activation is a Cloudflare-only
 *      option that is IGNORED elsewhere, with no error, so every cold card mints a fresh token.
 *   4. `FixedLengthStream` is a Workers global; without it every mux is buffered whole in memory.
 *
 * The fifth item, the CacheLike contract, is pinned at the bottom: the seam already existed, and
 * what was missing was a statement of what an implementation must do and a test that notices when
 * the worker starts asking for more than the contract promises.
 *
 * MEASURED NOWHERE. Nothing here is a network measurement and none of it should be read as one —
 * every assertion is offline, against stubs, on the SHAPE of the code's behaviour.
 */

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

// ── 1. OWN_HOSTS, configurable, and additive so configuring it cannot widen it.

test('a self-hoster declares their own domain in OWN_HOSTS, and subdomains come with it', () => {
  // Without this the service can be induced to fetch ITSELF: the fediverse routes take the instance
  // hostname from the path, so `/embed.example.com/post/1` on an instance served at
  // embed.example.com is a self-request. On Cloudflare that re-enters through the edge and bypasses
  // the zone's own WAF; off it, it is a service that will fetch things on its own network.
  const env = { OWN_HOSTS: 'embed.example.com' }
  assert.equal(fetchableInstance('embed.example.com', undefined, env), false)
  assert.equal(fetchableInstance('staging.embed.example.com', undefined, env), false,
    'one apex entry covers every subdomain, exactly as the built-in list does')
  assert.equal(fetchableInstance('lemmy.world', undefined, env), true, 'and a real instance is untouched')
})

test('OWN_HOSTS takes a list in whatever spelling the operator has it in', () => {
  // An operator pastes this out of their own config, which holds an origin as often as a hostname,
  // and separates values with whatever their config format uses. Refusing their spelling means the
  // guard silently covers nothing while looking configured.
  const env = { OWN_HOSTS: 'a.example, https://b.example\n c.example.' }
  for (const h of ['a.example', 'b.example', 'c.example', 'sub.b.example']) {
    assert.equal(fetchableInstance(h, undefined, env), false, h)
  }
})

test('OWN_HOSTS is ADDITIVE — a set, empty or junk value can never un-block mbedfx own zones', () => {
  // THE SAFE-DEFAULT ARGUMENT, as a test. A configurable guard whose config can SUBTRACT is a guard
  // one env var away from being absent, and the operator most likely to get the value wrong is the
  // one who has never read fedihost.ts. Every failure mode of this setting is "too strict".
  for (const OWN_HOSTS of ['', '   ', 'not a hostname', 'https://', 'other.example', undefined]) {
    for (const ours of ['mbedfx.app', 'staging.mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex']) {
      assert.equal(fetchableInstance(ours, undefined, { OWN_HOSTS }), false,
        `${ours} must stay refused with OWN_HOSTS=${JSON.stringify(OWN_HOSTS)}`)
    }
  }
})

test('UNSET is not "wide open": the built-in list, the address guard and the shape check all still stand', () => {
  // What an unset OWN_HOSTS actually leaves reachable is ONE host — the operator's own public domain,
  // which resolves to their own public address. It is a misconfiguration, not a route into a network,
  // and saying so precisely is what stops the next reader from either panicking or shrugging.
  assert.equal(fetchableInstance('mbedfx.app'), false, 'the built-in list needs no config')
  assert.equal(fetchableInstance('127.0.0.1'), false, 'nor does the address guard')
  assert.equal(fetchableInstance('localhost'), false)
  assert.equal(fetchableInstance('[::ffff:127.0.0.1]'), false)
  assert.equal(fetchableInstance('lemmy.world'), true, 'and an ordinary instance is still fetchable')
})

test('the LAN names that FEDI_HOST admits are refused by the address guard, not by the regex', () => {
  // THE ONE THING THAT WAS ACTUALLY REACHABLE, found by running the regex instead of reading it.
  // FEDI_HOST refuses the bare label `localhost` and admits every one of these: they are two or more
  // labels ending in letters, which is all it asks for. On Cloudflare they resolve to nothing. On a
  // self-hosted box `/db.internal/post/1` is a GET against the machine next to it.
  //
  // A reviewer deleting the blockedHost call in fetchableInstance "because FEDI_HOST already covers
  // it" is the exact regression this test exists to turn red.
  for (const lan of ['api.localhost', 'printer.local', 'db.internal', 'host.home.arpa', '1.0.0.127.in-addr.arpa']) {
    assert.equal(fetchableInstance(lan), false, `${lan} must never be fetchable`)
  }
})

// ── 2. The DNS seam, at the boundary where it decides whether a request is made at all.

test('a fedi host that RESOLVES to loopback costs ZERO fetches, on the real fetcher', async () => {
  // The whole point of the seam is that it runs BEFORE the request. Asserting on the returned reason
  // alone would pass against a guard that fetched first and judged afterwards, which off Cloudflare
  // is the request that reaches 127.0.0.1.
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('{}', { headers: { 'content-type': 'application/json' } }) }
  try {
    const env = { RESOLVE_HOST: async () => ['127.0.0.1'] }
    assert.deepEqual(await fetchMasto({ p: 'ms', host: 'evil.example', id: 'abc' }, { env }),
      { ok: false, reason: 'assert_fail' })
    assert.deepEqual(await fetchLemmy({ p: 'lm', host: 'evil.example', kind: 'post', id: '1' }, { env }),
      { ok: false, reason: 'assert_fail' })
    assert.equal(calls, 0, 'the guard must refuse before any I/O, not after it')
  } finally { globalThis.fetch = real }
})

test('the seam is silent with no resolver, so the Cloudflare path is unchanged', async () => {
  // A guard that refuses everything on the runtime that cannot answer the question is an outage.
  // Workers has no DNS: there, the literal check is the whole guard and the fetch must still happen.
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ id: '1' }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    await fetchMasto({ p: 'ms', host: 'mstdn.social', id: 'abc' }, { env: {} })
    assert.equal(calls, 1, 'no RESOLVE_HOST means the request goes out exactly as it does today')
  } finally { globalThis.fetch = real }
})

test('instanceFetchable is the whole gate: shape, own zones, literals, then DNS', async () => {
  assert.equal(await instanceFetchable('lemmy.world'), true)
  assert.equal(await instanceFetchable('mbedfx.app'), false, 'our own zone')
  assert.equal(await instanceFetchable('mstdn.social', { self: 'https://mstdn.social' }), false, 'the request origin')
  assert.equal(await instanceFetchable('nope', {}), false, 'FEDI_HOST shape')
  assert.equal(
    await instanceFetchable('lemmy.world', { env: { RESOLVE_HOST: async () => ['169.254.169.254'] } }), false,
    'a public name pointed at the metadata endpoint',
  )
})

// ── 3. The Twitter guest token, on a runtime where `cf` does nothing.

test('a second guest-token call reuses the activation instead of minting another', async () => {
  // Off Cloudflare the `cf` fetch-cache option is silently ignored, so before the memo this was one
  // activate.json POST per cold card. A token carries roughly a 500-request budget, so the symptom
  // is not an outage — it is Twitter rate-limiting an instance for no reason anybody can see.
  resetGuestToken()
  const real = globalThis.fetch
  let activations = 0
  globalThis.fetch = async () => {
    activations++
    return new Response(JSON.stringify({ guest_token: 'gt-1' }), { status: 200 })
  }
  try {
    assert.equal(await getGuestToken({}), 'gt-1')
    assert.equal(await getGuestToken({}), 'gt-1')
    assert.equal(await getGuestToken({}), 'gt-1')
    assert.equal(activations, 1, 'one activation serves the TTL, on every runtime')
  } finally { globalThis.fetch = real; resetGuestToken() }
})

test('a COLD BURST on one token is one activation, not one per concurrent request', async () => {
  // One pasted tweet is unfurled by three concurrent requests. A memo holding only a VALUE lets all
  // three see an empty memo and activate their own token, which is the case the shared in-flight
  // promise exists for and the case a sequential test cannot see.
  resetGuestToken()
  const real = globalThis.fetch
  let activations = 0
  globalThis.fetch = async () => {
    activations++
    await new Promise(r => setTimeout(r, 5))
    return new Response(JSON.stringify({ guest_token: 'gt-burst' }), { status: 200 })
  }
  try {
    const got = await Promise.all([getGuestToken({}), getGuestToken({}), getGuestToken({})])
    assert.deepEqual(got, ['gt-burst', 'gt-burst', 'gt-burst'])
    assert.equal(activations, 1)
  } finally { globalThis.fetch = real; resetGuestToken() }
})

test('a FAILED activation is never memoized — one 503 must not kill the guest path for two hours', async () => {
  // The failure would be invisible and long: every tweet on this isolate would take the credential-
  // free "no token" path until the TTL lapsed, and the cards would still render, just worse.
  //
  // REWRITTEN 2026-08-28. The invariant is untouched — only a real token is ever stored — but the
  // title's own promise is now kept one rung earlier: since the activation goes through askTwice, ONE
  // 503 no longer costs the token at all, so the stub has to refuse for as long as the retry is
  // willing to ask before there is a failed activation to not-memoize. Both properties are pinned
  // below, because the new one is the stronger half and would otherwise be untested.
  resetGuestToken()
  const real = globalThis.fetch
  let activations = 0
  globalThis.fetch = async () => {
    activations++
    return activations <= 2
      ? new Response('gateway blew up', { status: 503 })
      : new Response(JSON.stringify({ guest_token: 'gt-after' }), { status: 200 })
  }
  try {
    assert.equal(await getGuestToken({}), null, 'a non-JSON body is no token, asserted on content')
    assert.equal(activations, 2, 'and a refused activation is asked again before it is called a failure')
    assert.equal(await getGuestToken({}), 'gt-after', 'and the next caller tries again')
    assert.equal(activations, 3)
  } finally { globalThis.fetch = real; resetGuestToken() }
})

test('ONE REFUSED ACTIVATION IS SURVIVED OUTRIGHT — the guest path is not lost to a single 503', async () => {
  /**
   * The half the rewrite above added rather than replaced, and the one that matters to a reader. The
   * guest path is Twitter's FALLBACK: it runs only after syndication has already failed, so losing it
   * to a blip means losing the card, and Discord caches that card permanently inside the message.
   * Before src/fetchretry.ts a single 503 on activate.json ended the whole request with no token.
   */
  resetGuestToken()
  const real = globalThis.fetch
  let activations = 0
  globalThis.fetch = async () => {
    activations++
    return activations === 1
      ? new Response('gateway blew up', { status: 503 })
      : new Response(JSON.stringify({ guest_token: 'gt-survived' }), { status: 200 })
  }
  try {
    assert.equal(await getGuestToken({}), 'gt-survived', 'the second ask activates, so Path B still exists')
    assert.equal(activations, 2, 'one extra ask, not a loop')
  } finally { globalThis.fetch = real; resetGuestToken() }
})

test('a THROWN activation does not park a rejected promise for the life of the process', async () => {
  // The in-flight slot has to be cleared however it settles. Left set, one transport error would be
  // handed to every later caller forever — a dead guest path with no way back short of a restart.
  //
  // REWRITTEN 2026-08-28: the activation now goes through askTwice, so a SINGLE reset is recovered
  // from rather than propagated, and the stub has to throw for both attempts before there is a
  // rejection to not-park. The invariant is unchanged, and so is the reason it exists — the in-flight
  // slot must be cleared however it settles.
  resetGuestToken()
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls <= 2) throw new Error('connection reset')
    return new Response(JSON.stringify({ guest_token: 'gt-recovered' }), { status: 200 })
  }
  try {
    await assert.rejects(() => getGuestToken({}), /connection reset/)
    assert.equal(calls, 2, 'asked twice before the reset was allowed to propagate')
    assert.equal(await getGuestToken({}), 'gt-recovered')
  } finally { globalThis.fetch = real; resetGuestToken() }
})

// ── 4. The buffering fallback, bounded.

const REF = { p: 'bs', handle: 'a.bsky.social', rkey: 'k' }
const KEY = `mux/${refKey(REF)}/0`
const remuxPost = () => ({
  ref: REF, canonical: 'https://bsky.app/x',
  author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [{
    kind: 'video', url: 'https://cdn.bsky.app/v.m3u8', w: 1280, h: 720,
    poster: 'https://cdn.bsky.app/thumb.jpg', remux: { video: 'https://cdn.bsky.app/v.m3u8' },
  }],
})
function fakeR2() {
  const store = new Map()
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length } : null },
    async put(k, body) { store.set(k, new Uint8Array(await new Response(body).arrayBuffer())) },
  }
}
const muxEnv = (impl, extra = {}) => ({
  AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) },
  MEDIA_CACHE: fakeR2(),
  ...extra,
})
const mediaReq = () => new Request(
  `https://mbedfx.app/_media/${encodeURIComponent(refKey(REF))}/0`,
  { headers: { 'user-agent': 'Discordbot/2.0' } },
)
const deps = () => ({ cache: fakeCache(), fetchPost: async () => remuxPost() })

test('a mux larger than the memory ceiling is REFUSED rather than buffered whole', async () => {
  // Off Cloudflare `FixedLengthStream` does not exist, so every mux takes the buffering path. The
  // container's own ceiling is a 375 MB output (MAX_BYTES 393216000 beside MAX_SECONDS 1500 in
  // container/server.py) and RESOLVER_SLOTS is 4, so "bounded by the container" is a 1.5 GB bound on
  // this host's memory — for four ordinary long videos and no attacker at all.
  const body = 'X'.repeat(64)
  const env = muxEnv(
    async () => new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) } }),
    { MUX_BUFFER_MAX: '16' },
  )
  const res = await handle(mediaReq(), env, ctx, deps())
  assert.equal(env.MEDIA_CACHE.store.size, 0, 'nothing that big may be held in memory to be stored')
  assert.equal(res.status, 503, 'the view degrades exactly as a failed mux does')
  assert.equal(res.headers.get('cache-control'), 'no-store', 'and nothing caches the degraded answer')
})

test('an oversize body with NO content-length is refused mid-read, not after it is all in memory', async () => {
  // Checking the header alone bounds the size we were TOLD, not the size we take: a chunked answer
  // from a proxy in front of the resolver carries no length, and `arrayBuffer()` on one of those is
  // an unbounded allocation with a promise attached.
  const env = muxEnv(async () => new Response('Y'.repeat(64), { headers: { 'content-type': 'video/mp4' } }),
    { MUX_BUFFER_MAX: '16' })
  const res = await handle(mediaReq(), env, ctx, deps())
  assert.equal(env.MEDIA_CACHE.store.size, 0)
  assert.equal(res.status, 503)
})

test('a mux UNDER the ceiling still caches and serves, with the ceiling at its default', async () => {
  // The bound must not change what the service does for the videos it was already doing it for.
  const body = 'FAKE-MP4-BYTES'
  const env = muxEnv(async () => new Response(body, { headers: { 'content-type': 'video/mp4' } }))
  const res = await handle(mediaReq(), env, ctx, deps())
  assert.equal(res.status, 200)
  assert.equal(await res.text(), body)
  assert.ok(env.MEDIA_CACHE.store.has(KEY), 'and it is in the cache for the next viewer')
})

test('a store that accepts a stream never buffers at all — the seam that makes the ceiling a fallback', async () => {
  // The honest fix for a self-hoster is a store that takes a stream (a file write, an S3 multipart
  // upload). R2 cannot: it needs a known length, which is why FixedLengthStream exists. `putStream`
  // is how a store says it can, and a store that says so is not subject to the ceiling.
  const body = 'Z'.repeat(4096)
  const env = muxEnv(async () => new Response(body, { headers: { 'content-type': 'video/mp4' } }),
    { MUX_BUFFER_MAX: '16' })
  let streamed = 0
  env.MEDIA_CACHE.putStream = async function (key, stream) {
    streamed++
    return this.put(key, stream)
  }
  const res = await handle(mediaReq(), env, ctx, deps())
  assert.equal(streamed, 1, 'the stream went straight to the store')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), body, 'all of it, ceiling or no ceiling')
})

// ── 5. The CacheLike contract.

test('the worker asks a CacheLike for exactly two methods, which is what the contract promises', () => {
  // The seam a self-hoster implements is two methods wide, and its docstring is a list of promises
  // (honour max-age, hand back a readable body, be shared, never reject). A third call site would
  // make every implementation written against that docstring quietly incomplete — and the failure
  // would be a TypeError inside ctx.waitUntil, on someone else's deployment, in production.
  const src = readFileSync('src/worker.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const used = [...new Set((src.match(/\bd\.cache\.([a-zA-Z]+)/g) || []).map(m => m.split('.')[2]))].sort()
  assert.deepEqual(used, ['match', 'put'],
    'update the CacheLike contract docstring and docs/SELF-HOSTING.md before adding a third method')
})

test('the Cloudflare cache is reached in ONE place, and it is the adapter entry point', () => {
  // `caches.default` is the only Cloudflare-shaped value in the default export, which is what makes
  // a Node adapter an object literal rather than a port. A second reference — anywhere inside
  // handle() — would be a Workers-only global on the request path and would break that.
  const src = readFileSync('src/worker.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal((src.match(/\bcaches\./g) || []).length, 1)
})
