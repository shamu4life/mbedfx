import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
// The housekeeping enforcers at the foot of this file assert through git's OWN ignore matcher
// rather than by grepping .gitignore: the defect they pin was a pattern that looks correct and
// does not match, so only git is evidence.
import { execFileSync } from 'node:child_process'
import worker, { handle, liveFetchPost, liveResolveShortlink, liveResolveRedditShare } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
// Imported to pin a MECHANISM, not to re-test these units: the last test in this file proves that
// TikTok's video-resolution hop is inert on Instagram media, which is the reason the ig arm has no
// such hop and the reason no request count can police that difference. See it for the full case.
import { normalizeInstagram } from '../src/platforms/instagram/normalize.ts'
// Task 7's end-to-end block runs REAL syndication captures through the REAL normalizer and into the
// REAL router/renderer/media route, so a wire-format disagreement between two Twitter modules (the
// normalizer's `poster` vs the router's `poster{N}` segment, refKey's colons vs /_media/'s percent
// encoding, the canonical the normalizer mints vs the one the router assumed) fails HERE, before
// staging, instead of as a dead player on Discord.
import { normalizeTwitter } from '../src/platforms/twitter/normalize.ts'
import { withResolvedVideo } from '../src/platforms/tiktok/fetch.ts'
import { AWEME_PLAY } from '../src/platforms/tiktok/normalize.ts'
import { toMastodonStatus } from '../src/render/mastodon.ts'

/**
 * "This exact ref is what got rendered" — the og:video tag's identity marker.
 *
 * Three assertions below prove that the RIGHT post (not a failure embed, not a chooser, not the
 * short code) was rendered, by pinning a url that encodes the ref exactly. Which url that is has
 * moved twice and the current answer is stable for a reason worth writing down:
 *
 *   - originally encodeStatusId(refKey(ref)), the spoof head's `statuses/{id}` callback;
 *   - then /_media/{encodeURIComponent(refKey)}/0, when Task 7's video carve-out moved every tt
 *     VIDEO post on Discord onto the plain og:video head, which emits no callback at all;
 *   - and STILL that, after the carve-out was removed on 2026-07-19. A tt video takes the spoof
 *     head again, but renderSpoof now emits og:video as a fallback beside the callback links, so
 *     this marker survived the reversal untouched. Both proofs are available on this head today;
 *     the /_media/ one is kept because it additionally proves the media is on OUR origin.
 *
 * A plain substring, not a RegExp: refKey encodes to 'tt%3A{id}', and '%' inside a pattern
 * built by interpolation is the kind of thing that silently matches something else.
 */
const mediaRef = (ref, i = 0) => `/_media/${encodeURIComponent(refKey(ref))}/${i}`

/** Minimal in-memory stand-in for the Cache API. */
function fakeCache() {
  const m = new Map()
  return {
    store: m,
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}
/**
 * `points` is captured in a closure, NOT via `this`. analytics.ts calls
 * `env.AE?.writeDataPoint(x)`, so the receiver is `env.AE` — a `this.points`
 * would resolve against AE, which has no such field, and throw on every count().
 */
// `extra` is spread LAST so a test can add a binding (MEDIA_RESOLVER, RESOLVER_SECRET) without
// every other caller changing. Default {} keeps the no-bindings shape every existing test relies on
// — several of them assert behaviour that only holds when a binding is ABSENT.
const fakeEnv = (extra = {}) => {
  const points = []
  return {
    points,
    AE: { writeDataPoint(p) { points.push(p) } },
    ASSETS: { async fetch() { return new Response('asset', { status: 200 }) } },
    ...extra,
  }
}
const ctx = { waitUntil() {} }
const req = (path, ua) =>
  new Request(`https://staging.megapenispoopenfarten.sex${path}`, { headers: ua ? { 'user-agent': ua } : {} })

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const BS_POST = '/profile/alice.bsky.social/post/3k2a'

test('humans NEVER trigger an upstream fetch — the router already knows canonical', async () => {
  let fetched = false
  const res = await handle(req(BS_POST), fakeEnv(), ctx, {
    cache: fakeCache(),
    fetchPost: async () => { fetched = true; return null },
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://bsky.app/profile/alice.bsky.social/post/3k2a')
  assert.equal(fetched, false, 'the human short-circuit must precede any fetch')
})

test('a crawler DOES fetch, and gets an embed', async () => {
  const post = {
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'hello', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const res = await handle(req(BS_POST, DISCORD), fakeEnv(), ctx, {
    cache: fakeCache(),
    fetchPost: async () => post,
  })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /og:title/)
})

test('the response body is still readable after being cached', async () => {
  // new Response(res.clone().body, res) is easy to get wrong and silently
  // returns an empty body to Discord.
  const post = {
    ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
    canonical: 'https://bsky.app/x',
    author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social' },
    text: 'body must survive', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const cache = fakeCache()
  const res = await handle(req('/profile/a.bsky.social/post/k', DISCORD), fakeEnv(), ctx,
    { cache, fetchPost: async () => post })
  const text = await res.text()
  assert.ok(text.length > 0, 'returned body must not be empty')
  assert.match(text, /body must survive/)
})

test('a warm cache hit serves the STORED body without re-fetching', async () => {
  // The previous test only ever reads the immediately-returned `res`. It never
  // proves the copy written to cache is itself readable on a second request —
  // a corrupt stored body would "silently return an empty body to Discord".
  const post = {
    ref: { p: 'bs', handle: 'c.bsky.social', rkey: 'k3' },
    canonical: 'https://bsky.app/profile/c.bsky.social/post/k3',
    author: { name: 'C', handle: 'c.bsky.social', url: 'https://bsky.app/profile/c.bsky.social' },
    text: 'warm hit must be readable too', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  let calls = 0
  const cache = fakeCache()
  const opts = { cache, fetchPost: async () => { calls++; return post } }
  const url = '/profile/c.bsky.social/post/k3'

  const first = await handle(req(url, DISCORD), fakeEnv(), ctx, opts)
  assert.equal(first.status, 200)

  const second = await handle(req(url, DISCORD), fakeEnv(), ctx, opts)
  assert.equal(calls, 1, 'the warm hit must be served from cache, not a second fetch')

  const text = await second.text()
  assert.ok(text.length > 0, 'the cached body must not be empty')
  assert.match(text, /og:title/)
  assert.match(text, /warm hit must be readable too/)
})

test('a fetchPost that THROWS on a crawler post-route request yields a graceful error embed, not an uncaught throw', async () => {
  // A real network failure (DNS, timeout, connection reset) makes fetch() itself
  // REJECT — fetchBluesky only guards `!res.ok` and content-type, so a rejection
  // must not propagate uncaught out of the handler.
  const opts = { cache: fakeCache(), fetchPost: async () => { throw new Error('ECONNRESET') } }
  const pending = handle(req('/profile/d.bsky.social/post/k4', DISCORD), fakeEnv(), ctx, opts)
  await assert.doesNotReject(pending)
  const res = await pending
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /og:title/)
  assert.match(text, /may be private, removed, or unavailable/)
})

test('media is class-agnostic — every client gets the same 302', async () => {
  const post = {
    ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
    canonical: 'https://bsky.app/x',
    author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social', avatar: 'https://cdn/av.jpg' },
    text: 't', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const opts = { cache: fakeCache(), fetchPost: async () => post }
  const outs = []
  for (const ua of [DISCORD, 'Mozilla/5.0 Firefox/38.0', undefined, 'TelegramBot']) {
    const r = await handle(req('/_media/bs:a.bsky.social:k/avatar', ua), fakeEnv(), ctx, opts)
    outs.push([r.status, r.headers.get('location')])
  }
  for (const o of outs) assert.deepEqual(o, [302, 'https://cdn/av.jpg'])
})

test('a corrupt media entry 404s instead of crashing the Worker', async () => {
  // The unit-level rule lives in media.test.mjs; this pins it at the surface that actually
  // ships, because worker.ts's media branch has NO try/catch — anything pickMedia throws is
  // an uncaught 500 on a public path, and the index segment is caller-chosen. The record
  // reaches pickMedia intact because deserializePost validates ref/canonical/createdAt and
  // never looks at media[].
  //
  // Asserted on the BODY, not on the status alone: this project has already shipped a
  // failure that returned HTTP 200 with an error page, so a status code proves nothing.
  const post = {
    ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
    canonical: 'https://bsky.app/x',
    author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social' },
    text: 't', createdAt: new Date(), counts: {}, sensitive: false,
    media: [null, { kind: 'image', url: 'https://cdn/1.jpg', w: 1, h: 1 }],
  }
  const opts = { cache: fakeCache(), fetchPost: async () => post }
  const hole = await handle(req('/_media/bs:a.bsky.social:k/0', DISCORD), fakeEnv(), ctx, opts)
  assert.equal(await hole.text(), 'media unavailable\n')
  assert.equal(hole.status, 404)
  // The entry after the hole still resolves to its OWN url — the index must not shift.
  const ok = await handle(req('/_media/bs:a.bsky.social:k/1', DISCORD), fakeEnv(), ctx, opts)
  assert.equal(ok.headers.get('location'), 'https://cdn/1.jpg')
  assert.equal(ok.status, 302)
  // An authorless record takes the avatar branch down the same path.
  const noAuthor = { cache: fakeCache(), fetchPost: async () => ({ ...post, author: null }) }
  const av = await handle(req('/_media/bs:a.bsky.social:k/avatar', DISCORD), fakeEnv(), ctx, noAuthor)
  assert.equal(await av.text(), 'media unavailable\n')
})

test('media_miss fires on a POST-CACHE miss, not only on a 404', async () => {
  // The spec's alert watches media_miss/media_hit to detect fetch amplification.
  // If media_miss only fired on 404s, the very failure it exists to catch is invisible.
  const post = {
    ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
    canonical: 'https://bsky.app/x',
    author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social', avatar: 'https://cdn/av.jpg' },
    text: 't', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const cache = fakeCache()
  const env = fakeEnv()
  const opts = { cache, fetchPost: async () => post }
  const url = '/_media/bs:a.bsky.social:k/avatar'

  await handle(req(url, DISCORD), env, ctx, opts)     // cold: had to fetch
  await handle(req(url, DISCORD), env, ctx, opts)     // warm: served from cache

  const outcomes = env.points.map(p => p.blobs[1])
  assert.ok(outcomes.includes('media_miss'), 'the cold hit must count as a miss')
  assert.ok(outcomes.includes('media_hit'), 'the warm hit must count as a hit')

  // The other half of the same claim, and the half that was unpinned: a request whose post
  // could not be fetched AT ALL still cost the upstream attempt, so it still counts as a
  // miss. Above, post is non-null, so moving the count() below the null check left this
  // test green — proven by mutation. Amplification during an upstream outage is exactly
  // when the ratio matters most, and it is exactly what that reordering would have hidden.
  const down = fakeEnv()
  const dead = await handle(req(url, DISCORD), down, ctx,
    { cache: fakeCache(), fetchPost: async () => null })
  assert.equal(await dead.text(), 'media unavailable\n')
  assert.deepEqual(down.points.map(p => p.blobs), [['bs', 'media_miss', 'discord']])
})

// ---------------------------------------------------------------------------
// The Mastodon-spoof callback routes at the surface that actually ships.
// ---------------------------------------------------------------------------

const SPOOF_REF = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' }
const SPOOF_ID = encodeStatusId(refKey(SPOOF_REF))
/** A DID-handle post with four images — the fixture shape the whole spoof exists for. */
const spoofPost = () => ({
  ref: SPOOF_REF,
  canonical: 'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6o',
  author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
  text: 'four pictures',
  createdAt: new Date('2026-07-18T12:00:00.000Z'),
  media: [0, 1, 2, 3].map(i => ({ kind: 'image', url: `https://cdn/${i}.jpg`, w: 800, h: 600 })),
  counts: {},
  sensitive: false,
})

test('the activity route returns application/json with every media attachment', async () => {
  // Asserted on the BODY, not the status: this project has shipped a failure that returned
  // HTTP 200 with an error page, so a status code proves nothing on its own.
  //
  // Content-Type is checked for EXACT equality. §6c verified live that FxEmbed sends no
  // charset parameter, and 'application/json; charset=utf-8' is what a hand-rolled
  // `new Response(JSON.stringify(...))` would produce.
  let seen = null
  const res = await handle(req(`/api/v1/statuses/${SPOOF_ID}`, DISCORD), fakeEnv(), ctx, {
    cache: fakeCache(),
    fetchPost: async ref => { seen = ref; return spoofPost() },
  })
  assert.equal(res.headers.get('content-type'), 'application/json')
  // The ref that reached the fetcher came out of the {id} segment, DID colons intact —
  // the end-to-end proof that the router did not decode the key a second time.
  assert.deepEqual(seen, SPOOF_REF)

  const body = await res.json()
  assert.equal(body.media_attachments.length, 4, 'all four images must reach media_attachments')
  assert.equal(body.content, 'four pictures')
  // NEVER a raw CDN url (project constraint): a Bluesky CDN url can be signed and expiring.
  for (const a of body.media_attachments) {
    assert.match(a.url, /^https:\/\/staging\.megapenispoopenfarten\.sex\/_media\//, a.url)
    assert.doesNotMatch(a.url, /cdn/, 'a raw CDN url must never be advertised')
  }
  // The id Discord calls us back on must be the one we can decode again.
  assert.equal(body.id, SPOOF_ID)
})

test('the oembed route returns the oEmbed document as application/json', async () => {
  const res = await handle(req(`/_oembed/${SPOOF_ID}`, DISCORD), fakeEnv(), ctx, {
    cache: fakeCache(),
    fetchPost: async () => spoofPost(),
  })
  assert.equal(res.headers.get('content-type'), 'application/json')
  const body = await res.json()
  assert.equal(body.type, 'rich')
  assert.equal(body.version, '1.0')
  assert.equal(body.provider_name, 'mbedfx')
  // From the request, never a constant — a hardcoded origin would point a staging embed's
  // footer at prod.
  assert.equal(body.provider_url, 'https://staging.megapenispoopenfarten.sex')
  assert.equal(body.author_name, 'Embed', 'the countless fixture falls to the verified floor')
})

test('a THROWING fetchPost on the spoof routes is graceful, not an uncaught 500', async () => {
  // Phase 1 shipped a fix for exactly this on the post route (a real network failure makes
  // fetch() REJECT rather than resolve falsy). The new routes share getPost, so the guard
  // covers them — but "shares the code path" is a claim, and this is the proof.
  for (const path of [`/api/v1/statuses/${SPOOF_ID}`, `/_oembed/${SPOOF_ID}`]) {
    const opts = { cache: fakeCache(), fetchPost: async () => { throw new Error('ECONNRESET') } }
    const pending = handle(req(path, DISCORD), fakeEnv(), ctx, opts)
    await assert.doesNotReject(pending, path)
    const res = await pending
    assert.equal(res.headers.get('content-type'), 'application/json', path)
    // Real Mastodon's shape for a status that is not there. A JSON consumer handed an HTML
    // error page is the failure mode this asserts against.
    assert.deepEqual(await res.json(), { error: 'Record not found' }, path)
    assert.equal(res.status, 404, path)
  }
})

test('a spoof-shaped path with a MANGLED id answers JSON 404, never the HTML error embed', async () => {
  // THE regression this file exists to prevent. worker.ts states the invariant — "A JSON
  // consumer must never be handed our HTML error embed — it would parse-fail rather than
  // degrade" — but enforced it only on the !post branch. An {id} that fails to decode never
  // reached that branch: the router said notfound and the worker rendered the OpenGraph
  // error page. Measured before the fix, running handle() with a Discordbot UA and
  // `accept: application/json`, every case below returned:
  //
  //   HTTP 200  content-type: text/html; charset=utf-8  counters=[["none","notfound","discord"]]
  //   body[0:60]='<!doctype html><html><head><meta property="og:title" content="Not found"'
  //   JSON.parse FAILS: Unexpected token '<', "<!doctype "...
  //
  // The first case is not invented input: statusid.ts's C2 note says an intermediary
  // treating {id} as a number is "plausible: real Mastodon ids ARE numeric snowflakes",
  // which is the entire reason SENTINEL exists. The codebase's own threat model produces it.
  let fetched = false
  const opts = { cache: fakeCache(), fetchPost: async () => { fetched = true; return spoofPost() } }
  for (const path of [
    `/api/v1/statuses/${String(Number(SPOOF_ID))}`, // coerced through a float upstream
    `/api/v1/statuses/${SPOOF_ID.slice(0, -1)}`,    // truncated: 3-digit framing stops dividing
    `/users/alice/statuses/${SPOOF_ID.slice(1)}`,   // sentinel stripped by a numeric normalizer
    `/_oembed/${SPOOF_ID.slice(1)}`,
    '/api/v1/statuses/abc',
    '/api/v1/statuses/%ZZ',                         // malformed escape: a separate code path
  ]) {
    const env = fakeEnv()
    const res = await handle(req(path, DISCORD), env, ctx, opts)
    // Asserted on the BODY and the content-type, not the status alone: this project has
    // already shipped a failure that returned HTTP 200 with an error page.
    assert.equal(res.headers.get('content-type'), 'application/json', path)
    const body = await res.text()
    assert.doesNotThrow(() => JSON.parse(body), `${path} must be parseable by a JSON consumer`)
    assert.deepEqual(JSON.parse(body), { error: 'Record not found' }, path)
    // Real Mastodon 404s a missing status. HTTP 200 for a missing API resource is the other
    // half of the defect: it tells the caller the mangled id was fine.
    assert.equal(res.status, 404, path)
    // A distinct counter, not the domain-wide 'notfound' this used to share. Mangled
    // callbacks are the C2 hazard; folded into ordinary 404 noise they have no signal
    // anywhere, and "Discord is calling us back with ids we cannot decode" is precisely
    // the thing an operator needs to be able to see.
    assert.deepEqual(env.points.map(p => p.blobs), [['none', 'api_bad_id', 'discord']], path)
  }
  assert.equal(fetched, false, 'an undecodable id names no post, so it must cost no upstream fetch')
})

test('the spoof routes are class-agnostic — a human UA gets the JSON, not a 302', async () => {
  // Copying the post route's human short-circuit here would 302 Discord's own callback
  // whenever its UA changed. These endpoints have no human-facing meaning to redirect to.
  const res = await handle(req(`/api/v1/statuses/${SPOOF_ID}`), fakeEnv(), ctx, {
    cache: fakeCache(),
    fetchPost: async () => spoofPost(),
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.equal((await res.json()).media_attachments.length, 4)
})

test('api_miss/api_hit count the spoof routes and NEVER touch the media counters', async () => {
  // Separate counters are load-bearing, not tidiness: the spec's fetch-amplification alert
  // watches the media_miss/media_hit ratio, and folding a second traffic class into it would
  // blind the alert. 'ok' is equally wrong — that tracks post-HTML renders.
  const env = fakeEnv()
  const cache = fakeCache()
  const opts = { cache, fetchPost: async () => spoofPost() }
  const path = `/api/v1/statuses/${SPOOF_ID}`

  await handle(req(path, DISCORD), env, ctx, opts)  // cold: had to fetch
  await handle(req(path, DISCORD), env, ctx, opts)  // warm: served from the post cache
  // The oembed route shares the cache entry, so it is warm too.
  await handle(req(`/_oembed/${SPOOF_ID}`, DISCORD), env, ctx, opts)

  const outcomes = env.points.map(p => p.blobs[1])
  assert.deepEqual(outcomes, ['api_miss', 'api_hit', 'api_hit'])
  assert.deepEqual(env.points.map(p => p.blobs[0]), ['bs', 'bs', 'bs'], 'the platform must be counted')
})

test('a FAILED spoof fetch counts api_miss AND fetch_fail, in that order', async () => {
  // Two properties in one, because the same reordering breaks both.
  //
  // fetch_fail: without it a cold success and a cold failure emit byte-identical analytics
  // (both just 'api_miss'), so a spoof callback arriving while upstream is down is invisible
  // — a real window whenever the post-cache entry expired before Discord called back.
  //
  // Ordering: api_miss is counted BEFORE the null check on purpose, because it measures
  // "this request cost an upstream fetch", not "this request succeeded". worker.ts asserts
  // that in a comment; this is what makes the assertion load-bearing. Proven necessary by
  // mutation — moving the count() below `if (!post)` left all 176 other tests passing, so a
  // failing spoof request recorded no api_miss at all and nothing flagged it.
  for (const fetchPost of [async () => null, async () => { throw new Error('ECONNRESET') }]) {
    const env = fakeEnv()
    const res = await handle(req(`/api/v1/statuses/${SPOOF_ID}`, DISCORD), env, ctx,
      { cache: fakeCache(), fetchPost })
    assert.equal(res.status, 404)
    assert.deepEqual(env.points.map(p => p.blobs), [
      ['bs', 'api_miss', 'discord'],
      ['bs', 'fetch_fail', 'discord'],
    ])
  }
})

test('ambiguous and notfound never reach a fetch', async () => {
  let fetched = false
  const opts = { cache: fakeCache(), fetchPost: async () => { fetched = true; return null } }
  const amb = await handle(req('/mrbeast'), fakeEnv(), ctx, opts)
  assert.equal(amb.status, 300)
  const nf = await handle(req('/totally/unknown/deep/path'), fakeEnv(), ctx, opts)
  assert.equal(nf.status, 404)
  assert.equal(fetched, false)
})

test('site paths are served from ASSETS', async () => {
  const res = await handle(req('/'), fakeEnv(), ctx, { cache: fakeCache(), fetchPost: async () => null })
  assert.equal(await res.text(), 'asset')
})

test('the default export exposes a fetch handler', () => {
  assert.equal(typeof worker.fetch, 'function')
})

test('a hostile permalink segment never crashes the worker on the human 302 path', async () => {
  // REGRESSION, end to end. `route()` interpolates ALREADY-DECODED segments into canonical,
  // and the post arm hands that straight to `redirect(r.canonical)` -> a `location` header.
  // A segment decoding to CR/LF/NUL or any codepoint > U+00FF made `new Headers` throw, and
  // handle() has no try/catch — the default export does not wrap it either — so it surfaced
  // as an uncaught TypeError (HTTP 500), not the 404 these paths used to get.
  //
  // Driven through handle() rather than route() because the Location header is where the
  // invalid value actually lands; a router-only test cannot see the throw. No UA is sent, so
  // classify(null) === 'human' and the redirect branch is taken.
  const hostile = [
    '/@u%0d%0aX-Injected:%201/video/123', // CRLF in the tiktok handle segment
    '/@u/video/1%0d%0aX-Injected:%201',   // CRLF in the tiktok id segment
    '/@%F0%9F%92%A9/video/123',           // astral codepoint: not a ByteString
    '/@u%00/video/123',                   // NUL
    '/u%0d%0aX-Injected:%201/status/123', // the SAME defect on the pre-existing x() arm
    '/profile/%F0%9F%92%A9/post/3k2a',    // ...and on the pre-existing bluesky() arm
  ]
  for (const path of hostile) {
    const opts = { cache: fakeCache(), fetchPost: async () => null }
    let res
    await assert.doesNotReject(
      async () => { res = await handle(req(path), fakeEnv(), ctx, opts) },
      `${path} must not throw`,
    )
    // Whatever we answer (302 with a sanitized target, or 404), it must be a real response
    // and the header must not smuggle an injected field.
    assert.ok(res.status === 302 || res.status === 404, `${path} -> unexpected ${res.status}`)
    assert.equal(res.headers.get('x-injected'), null, `${path} must not inject a header`)
    const loc = res.headers.get('location')
    if (loc !== null) {
      assert.doesNotThrow(() => new URL(loc), `${path}: Location must be a valid URL`)
      assert.ok(!/[\r\n]/.test(loc), `${path}: Location must carry no bare CR/LF`)
    }
  }
})

// ---------------------------------------------------------------------------
// TikTok dispatch. `if (ref.p !== 'bs') return null` in liveFetchPost was the one
// line that would have made a correct TikTok fetcher and normalizer render
// the generic "couldn't load" failure — so the dispatch gets tests of its own, at the surface
// that ships.
// ---------------------------------------------------------------------------

const TT_POST = '/@mysticaquarium/video/7660566211100511518'

test('a TikTok video post reaches the renderer as a tt post, and leaks no CDN url', async () => {
  // What THIS test owns is the DISPATCH: a tt ref reaches the renderer at all, as a tt post,
  // with nothing raw leaking out of it.
  //
  // It was written before Task 7 and asserted on the SPOOF callback id, because until the video
  // carve-out existed a tt VIDEO post on Discord took renderSpoof — which emitted ZERO /_media/
  // urls when hasMedia is true, the C1 og:IMAGE suppression being the entire mechanism rather
  // than an oversight. Its comment said the /_media/ assertion "lives in Task 7", and the
  // carve-out made it available. It stayed available when the carve-out was REMOVED on
  // 2026-07-19: the post is back on the spoof head, but that head now emits an og:video fallback,
  // and og:video was never what the suppression was about. Same claim, same strictness — and both
  // markers are on this head today. See mediaRef above.
  const post = {
    ref: { p: 'tt', id: '7660566211100511518' },
    canonical: 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518',
    author: { name: 'Mystic Aquarium', handle: 'mysticaquarium', url: 'https://www.tiktok.com/@mysticaquarium' },
    text: 'a beluga', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280, duration: 10 }],
    counts: { likes: 5, views: 900 }, sensitive: false,
  }
  const res = await handle(req(TT_POST, DISCORD), fakeEnv(), ctx, { cache: fakeCache(), fetchPost: async () => post })
  const html = await res.text()
  assert.equal(res.status, 200)
  assert.ok(!html.includes('aweme/v1/play'), 'a raw CDN url must never reach a client')
  assert.ok(!html.includes('tiktokcdn'), 'nor any other raw CDN host')
  // The og:video url encodes the ref, so this proves the tt post — not a failure embed — is what
  // got rendered, AND that its media is served from our own origin rather than TikTok's.
  assert.ok(html.includes(mediaRef(post.ref)), `the rendered post must carry ${mediaRef(post.ref)}`)
  assert.ok(!/couldn't load/i.test(html), 'the dispatch must not fall through to fetch_fail')
})

test('/_media/ resolves a TikTok video to the aweme url with a 302, never a proxy', async () => {
  const cache = fakeCache()
  const post = {
    ref: { p: 'tt', id: '777' },
    canonical: 'https://www.tiktok.com/@u/video/777',
    author: { name: 'U', handle: 'u', url: 'https://www.tiktok.com/@u' },
    text: '', createdAt: new Date(),
    media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280 }],
    counts: {}, sensitive: false,
  }
  const res = await handle(req('/_media/tt%3A777/0'), fakeEnv(), ctx, { cache, fetchPost: async () => post })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.tiktok.com/aweme/v1/play/?video_id=v')
  assert.match(res.headers.get('cache-control'), /max-age=300/)
})

test('a TikTok fetch failure degrades: error embed for a crawler, 302 for a human', async () => {
  const bad = { cache: fakeCache(), fetchPost: async () => null }
  const crawler = await handle(req(TT_POST, DISCORD), fakeEnv(), ctx, bad)
  assert.match(await crawler.text(), /may be private, removed, or unavailable/i)
  const human = await handle(req(TT_POST), fakeEnv(), ctx, bad)
  assert.equal(human.status, 302)
  assert.equal(human.headers.get('location'), 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518')
})

test('liveFetchPost dispatches on ref.p and returns null for platforms with no fetcher', async () => {
  // No network: every ref here belongs to a platform whose fetcher lands in Phase 4-5, so the
  // dispatch returns before any I/O. This is the line that made a correct TikTok fetcher
  // invisible — `if (ref.p !== 'bs') return null` — and it is worth a test of its own.
  // `ig` and now `th` LEFT THIS LIST when their dispatch landed, and the reason is worth pinning: a
  // ref for a platform with a real fetcher reaches out to the live site from the pure test suite. It
  // would still assert null — a blocked/unavailable page is assert_fail is null — so the test would
  // keep passing while quietly putting the network into a suite whose whole contract is that it has
  // none. A stub that keeps passing for the wrong reason is the failure mode.
  //
  // `rd` STAYS, and does so soundly: fetchReddit needs an OAuth token, and fakeEnv() sets no
  // REDDIT_CLIENT_ID, so appToken() returns null BEFORE any request and rd degrades to null with
  // zero network. `x` is the dispatch control; its own end-to-end block runs the real fixtures with
  // the network stubbed.
  for (const ref of [
    { p: 'x', id: '1' },
    { p: 'rd', sub: 'aww', id: 'a' },
  ]) {
    assert.equal(await liveFetchPost(ref, fakeEnv(), 'other-bot'), null, ref.p)
  }
})

test('counters attribute the platform, so tt traffic is visible separately', async () => {
  const env = fakeEnv()
  await handle(req(TT_POST, DISCORD), env, ctx, { cache: fakeCache(), fetchPost: async () => null })
  assert.ok(env.points.some(p => p.blobs[0] === 'tt' && p.blobs[1] === 'fetch_fail'))
})

test('A BLOCKED PAGE LANDS IN assert_fail, A DELETED POST IN fetch_fail ALONE', async () => {
  // The counter half of Task 4's split, and the reason it is worth a signature change: without
  // this, "TikTok renamed the rehydration blob" and "someone pasted a deleted link" emit
  // byte-identical analytics. Global fetch is stubbed rather than mocked at a module boundary,
  // because the thing under test is precisely what liveFetchPost does with a real response body.
  const real = globalThis.fetch
  try {
    const run = async body => {
      globalThis.fetch = async () => new Response(body, { status: 200 })
      const env = fakeEnv()
      await liveFetchPost({ p: 'tt', id: '7660566211100511518' }, env, 'discord')
      return env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    }

    // A 429 body: no marker, so the PAGE assertion failed.
    const blocked = await run('<html><head><title>429 Too Many Requests</title></head></html>')
    assert.ok(blocked.includes('assert_fail'), 'a rate-limited page must be assert_fail')

    // A real page carrying a real "this post is gone" answer: the assertion PASSED.
    const deletedBody = readFileSync('test/fixtures/tiktok-deleted.html', 'utf8')
    const deleted = await run(deletedBody)
    assert.ok(!deleted.includes('assert_fail'), 'a deleted post is NOT an assertion failure')
  } finally {
    globalThis.fetch = real
  }
})

test('assert_fail STACKS on top of fetch_fail, on one request, through the real dispatch', async () => {
  // REGRESSION THIS PREVENTS: the earlier spelling of this assertion injected
  // `fetchPost: async () => null`, so liveFetchPost never ran and assert_fail was never emitted
  // — it observed fetch_fail alone while its comment claimed to prove stacking. A stub that
  // short-circuits the code under test cannot witness the property it is named for.
  //
  // The stacking IS the design: the fetcher counts "the page did not answer" and the worker
  // counts "no post came back" on the SAME request, so the assert_fail/fetch_fail ratio stays
  // readable. Wire the real liveFetchPost in and stub the network underneath it, which is the
  // only arrangement in which both counters can be seen on one request.
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('<html><head><title>429</title></head></html>', { status: 200 })
    const env = fakeEnv()
    await handle(req(TT_POST, DISCORD), env, ctx, { cache: fakeCache(), fetchPost: liveFetchPost })
    const tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    assert.ok(tt.includes('assert_fail'), 'the fetcher must count the page failure')
    assert.ok(tt.includes('fetch_fail'), 'and the worker must still count the missing post')
  } finally {
    globalThis.fetch = real
  }
})

test('A REAL TIKTOK PAGE BECOMES A POST — the fetch->normalize seam, not just its failure half', async () => {
  // REGRESSION THIS PREVENTS: every other test on this dispatch injects a `fetchPost` stub or
  // exercises a FAILURE branch, so `return normalizeTikTok(got.html, ref)` — the entire point of
  // Task 5 — was held by nothing. Replacing that one line with `return null` typechecks clean and
  // passed the full suite, i.e. an implementation in which EVERY real TikTok post renders "could
  // not fetch post" was indistinguishable from a working one. That is verbatim the failure this
  // task exists to prevent, so it gets an assertion at the seam that ships.
  //
  // Stubbing globalThis.fetch rather than the fetcher module is deliberate: the thing under test
  // is precisely that a real page body travels from fetchTikTok into normalizeTikTok intact.
  const real = globalThis.fetch
  try {
    const run = async (fixture, ref) => {
      globalThis.fetch = async () => new Response(readFileSync(`test/fixtures/${fixture}`, 'utf8'), { status: 200 })
      const env = fakeEnv()
      const post = await liveFetchPost(ref, env, 'discord')
      return { post, tt: env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1]) }
    }

    // A video post. Asserting on CONTENT from the captured payload — the caption — not on a
    // shape: a mutant that returns a hollow-but-well-typed Post has to reproduce the real text.
    const ref = { p: 'tt', id: '7660566211100511518' }
    const video = await run('tiktok-video.html', ref)
    assert.ok(video.post, 'a real TikTok page must produce a Post, not null')
    assert.deepEqual(video.post.ref, ref, 'the ref we asked for must be the ref carried back')
    assert.equal(video.post.text, 'Duck’s fish era has officially begun. 🐟✨')
    assert.equal(video.post.media.length, 1)
    assert.equal(video.post.media[0].kind, 'video')
    // A page that answered is NOT a page failure. If a success ever counted assert_fail, the
    // counter would stop meaning "TikTok broke" and the split Task 4 paid for would be worthless.
    //
    // CHANGED 2026-08-30: this read `deepEqual(video.tt, [])`. A success now also emits exactly one
    // INFORMATIONAL counter — tt_onehop or tt_twohop, saying how many redirects the shipped url puts
    // between Discord and the bytes — so "no counters at all" stopped being the property worth
    // holding. The failure half is unchanged and still asserted; the hop counter is excluded by name
    // rather than by relaxing the assertion, so a NEW failure counter on this path still fails here.
    const HOP = ['tt_onehop', 'tt_twohop']
    assert.deepEqual(video.tt.filter(c => !HOP.includes(c)), [],
      'a page that answered must emit no failure counter')
    // AND THE HOP COUNTER IS PINNED POSITIVELY, because its absence is the defect it exists for: it
    // was added after resolveAwemeUrl was found returning null for every TikTok in production for
    // three weeks with nothing counting it. Exactly one, so a refactor cannot double-count.
    assert.deepEqual(video.tt.filter(c => HOP.includes(c)), ['tt_twohop'],
      'a video post reports its hop count, and this fixture resolves to two (the stub answers the ' +
      'aweme fetch with the page, so there is no Location to follow)')

    // The slideshow arm through the same seam: five images, proving the whole body reaches the
    // normalizer rather than a prefix of it that happens to satisfy the video branch.
    const slides = await run('tiktok-slideshow.html', ref)
    assert.ok(slides.post, 'a slideshow page must produce a Post too')
    assert.equal(slides.post.media.length, 5)
    assert.deepEqual([...new Set(slides.post.media.map(m => m.kind))], ['image'])
    assert.deepEqual(slides.tt, [])
  } finally {
    globalThis.fetch = real
  }
})

// ---------------------------------------------------------------------------
// /t/{code} short links, at the surface that ships. The cache assertions are the
// load-bearing half: a short code is a LOOKUP key, never identity, and the post it
// resolves to must land under its CANONICAL key too or every /_media/ hit costs a
// second upstream fetch and splits one post across two media namespaces.
// ---------------------------------------------------------------------------

/** classify() routes this to 'other-bot' — a different response-cache key, same post cache. */
const OTHER_BOT = 'facebookexternalhit/1.1'

const TT_CANON = { p: 'tt', id: '7660566211100511518' }
const ttResolved = {
  ref: TT_CANON,
  canonical: 'https://www.tiktok.com/@mysticaquariumct/video/7660566211100511518',
  author: { name: 'Mystic Aquarium', handle: 'mysticaquariumct', url: 'https://www.tiktok.com/@mysticaquariumct' },
  text: 'a beluga', createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280 }],
  counts: { likes: 5 }, sensitive: false,
}

test('A RESOLVED SHORT LINK CARRIES THE CANONICAL REF, NEVER THE SHORT CODE', async () => {
  // The short code is a lookup key. If it reached post.ref, every /_media/ url would be minted
  // under tt:ZTSw2mYwR while the long-form url minted tt:7660… — two cache entries and two
  // media namespaces for one post, which is precisely what Task 2's "same cache key" test
  // forbids. Asserted on the /_media/ url the og:video tag mints, which is the strongest
  // available form of this claim: it is literally the namespace the test is about. (Written
  // against the spoof callback id before Task 7's carve-out, when a tt video post took renderSpoof
  // and no /_media/ url existed on that head to inspect. The carve-out is gone as of 2026-07-19
  // but renderSpoof's og:video fallback keeps this url on the head, so the assertion did not have
  // to move back.)
  const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'post', post: ttResolved }) }
  const html = await (await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)).text()
  assert.ok(html.includes(mediaRef(TT_CANON)), `must mint media under the canonical ref: ${mediaRef(TT_CANON)}`)
  assert.ok(!html.includes('ZTSw2mYwR'), 'the short code must not appear anywhere in the output')
  assert.match(html, /www\.tiktok\.com\/@mysticaquariumct\/video\/7660566211100511518/)
})

test('THE CACHE: a resolved short link lands under BOTH keys, so /_media/ costs no refetch', async () => {
  // The load-bearing cache assertion. fetchPost THROWS here: any path that reaches it means the
  // canonical key was never written and a short link would cost a second upstream fetch on its
  // very first media hit.
  const cache = fakeCache()
  let resolves = 0
  const deps = {
    cache,
    fetchPost: async () => { throw new Error('the canonical post key must already be warm') },
    resolveShortlink: async () => { resolves++; return { kind: 'post', post: ttResolved } },
  }

  await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)
  assert.equal(resolves, 1)

  // A DIFFERENT client class misses the response cache but must still hit the POST cache under
  // the short key — otherwise the short code is only ever as warm as one rendered response.
  await handle(req('/t/ZTSw2mYwR', OTHER_BOT), fakeEnv(), ctx, deps)
  assert.equal(resolves, 1, 'a second client class must not cost a second resolve')

  // And the canonical key: /_media/ derives its ref from post.ref, which is the numeric id.
  const m = await handle(req(`/_media/${encodeURIComponent(refKey(TT_CANON))}/0`), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.equal(m.headers.get('location'), 'https://www.tiktok.com/aweme/v1/play/?video_id=v')
  assert.equal(resolves, 1, 'the first media hit must not cost an upstream fetch')

  // The long-form permalink shares that same warm entry — the invariant Task 2 asserts on refKey,
  // now asserted end to end through the cache.
  //
  // ASSERTED ON CONTENT, because `long.status === 200` — what this line used to say — cannot tell
  // a shared warm entry from a total failure: the "Couldn't load this TikTok post" embed is ALSO HTTP
  // 200, so the assertion passed whether the entry was shared or the fetch died. Verified against a
  // cold cache with this test's own deps: status 200, og:title "Couldn't load this TikTok post".
  const long = await handle(req('/@mysticaquariumct/video/7660566211100511518', DISCORD), fakeEnv(), ctx, deps)
  assert.equal(long.status, 200)
  const longHtml = await long.text()
  assert.match(longHtml, /a beluga/, 'the permalink must be served the SAME post the short link resolved')
  assert.ok(!/couldn't load/i.test(longHtml), 'and fetchPost throws here, so a miss is a visible failure')
})

test('A NON-TIKTOK CODE DEGRADES TO AMBIGUOUS — no throw, no guess', async () => {
  // Verified 2026-07-18: a dead code AND a real Threads code both land on the TikTok homepage
  // with the webapp.video-detail scope ABSENT. The resolver returns null and the answer is the
  // chooser — exactly what this path would have shipped with no resolver at all, so the
  // no-case behaviour is unchanged by building the yes-case.
  const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }) }

  const crawler = await handle(req('/t/DTI1vjIEi5y', DISCORD), fakeEnv(), ctx, deps)
  const html = await crawler.text()
  assert.match(html, /Ambiguous link/i)
  assert.match(html, /tiktok\.com/)
  assert.match(html, /threads\.com/)

  // A HUMAN CANNOT BE GIVEN THE CHOOSER HERE, and the plan's own test asked for it anyway.
  //
  // The plan (Task 6 Step 1) asserted `human.status === 300` on this same dead code, while its
  // Step 3 implementation short-circuits humans with `if (client === 'human') return redirect(...)`
  // BEFORE resolving, and its sibling test below asserts `resolves === 0` for a human. Those three
  // cannot all hold: 300 requires knowing the code is not TikTok, knowing that requires resolving,
  // and resolving is the upstream fetch the human short-circuit exists to prevent. There is no
  // ordering that satisfies both assertions, so this one was corrected rather than implemented.
  //
  // 302 is the right answer of the two. "A human never costs us an upstream fetch" is a global
  // constraint and the whole reason the shortlink Route carries a canonical at all; the cost of
  // honouring it is that a human on a Threads code lands on TikTok's homepage — one wasted click,
  // paid by the person who pasted a link we do not serve, instead of an upstream fetch paid by us
  // on every human short link including the ones that work.
  const human = await handle(req('/t/DTI1vjIEi5y'), fakeEnv(), ctx, deps)
  assert.equal(human.status, 302, 'a human is 302d to the short url — resolving for them is the fetch we refuse')
  assert.equal(human.headers.get('location'), 'https://www.tiktok.com/t/DTI1vjIEi5y')
})

test('a resolver that THROWS degrades the same way, rather than 500ing', async () => {
  const deps = {
    cache: fakeCache(), fetchPost: async () => null,
    resolveShortlink: async () => { throw new Error('upstream reset') },
  }
  const res = await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)
  assert.match(await res.text(), /Ambiguous link/i)
})

test('A HUMAN ON A SHORT LINK IS SENT THE CLEAN PERMALINK, not the share url', async () => {
  /**
   * REVERSED 2026-07-30. This used to assert the opposite — 302 straight to
   * https://www.tiktok.com/t/{code}, on the invariant that "humans never trigger an upstream fetch".
   * That invariant was about OUR COST and it is still true of the post route; it was the wrong thing
   * to optimise here, because the value being forwarded is a SHARE CODE.
   *
   * Reported 2026-07-30 with real links. /t/ZTAUdx7dv resolves to
   *     /@kfc.laos/video/7658012561153035542?_r=1&_t=ZT-98PbBJ7V0JR
   * so every click on a shared link handed the code and its tracking parameters to the destination.
   * A user who deliberately swaps our host in expects the link to have been SANITISED.
   *
   * WHAT IS ACTUALLY LEAKED, measured, because the alarming reading is wrong: `_t` is NOT a sharer
   * fingerprint carried in the link. The same code resolved repeatedly from one machine yields the
   * SAME `_t` across repeats and across client shapes, while the reporter saw a different value for
   * that identical code — so it is minted for whoever RESOLVES, not baked in by whoever shared. The
   * residual is the CODE, which TikTok can join to the share event server-side. We cannot unmake that
   * join; we can stop carrying it onward, and that is all this change claims.
   */
  let resolves = 0
  const deps = {
    cache: fakeCache(), fetchPost: async () => null,
    resolveShortlink: async () => { resolves++; return { kind: 'post', post: ttResolved } },
  }
  const res = await handle(req('/t/ZTSw2mYwR'), fakeEnv(), ctx, deps)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), ttResolved.canonical, 'the clean permalink')
  assert.doesNotMatch(res.headers.get('location'), /_t=|_r=|\/t\//, 'no share code, no tracking params')
  assert.equal(resolves, 1, 'and it costs exactly one resolve, not more')
})

test('AN UNRESOLVABLE SHORT LINK STILL LANDS A HUMAN SOMEWHERE', async () => {
  // A human must always land somewhere. When the resolve fails we fall back to the share url — a
  // worse privacy answer than the permalink, but not a broken link.
  const deps = {
    cache: fakeCache(), fetchPost: async () => null,
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  const res = await handle(req('/t/ZTSw2mYwR'), fakeEnv(), ctx, deps)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.tiktok.com/t/ZTSw2mYwR')
})

test('A THROWING RESOLVER DEGRADES A HUMAN TO THE SHARE URL, never a 500', async () => {
  const deps = {
    cache: fakeCache(), fetchPost: async () => null,
    resolveShortlink: async () => { throw new TypeError('network') },
  }
  const res = await handle(req('/t/ZTSw2mYwR'), fakeEnv(), ctx, deps)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.tiktok.com/t/ZTSw2mYwR')
})

// ---------------------------------------------------------------------------
// /r/{sub}/s/{code} — the Reddit app's SHARE link. An opaque code the worker resolves via a 301 to
// the /comments/{id} permalink, then routes through the ORDINARY post path so a share link and a
// permalink converge on ONE cache entry and render identically. Before this route both a real image
// link (BatmanArkham) and a video link (DankPods) rendered "not found": /s/ fell through to 'r' in
// the KNOWN dead-end set. Unlike TikTok's /t/, /r/…/s/ is unambiguous — there is never a chooser.
// ---------------------------------------------------------------------------

const RD_CANON = { p: 'rd', sub: 'BatmanArkham', id: '1v3hkln' }
const rdResolved = {
  ref: RD_CANON,
  canonical: 'https://www.reddit.com/r/BatmanArkham/comments/1v3hkln',
  author: { name: 'r/BatmanArkham', handle: 'BatmanArkham', url: 'https://www.reddit.com/r/BatmanArkham' },
  text: 'did they wipe', createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [{ kind: 'image', url: 'https://i.redd.it/abc.jpg', w: 800, h: 600 }],
  counts: { likes: 42 }, sensitive: false,
}
const RD_SHARE = '/r/BatmanArkham/s/uucSZtDEbI'
const rdDeps = (over = {}) => ({
  cache: fakeCache(),
  fetchPost: async (ref) => (ref.p === 'rd' ? rdResolved : null),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => ({ ref: RD_CANON, canonical: rdResolved.canonical }),
  ...over,
})

test('a Reddit /s/ share link RESOLVES and renders the post under the canonical ref', async () => {
  const deps = rdDeps()
  const html = await (await handle(req(RD_SHARE, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, /did they wipe/, 'the resolved post is rendered, not "not found"')
  assert.match(html, /www\.reddit\.com\/r\/BatmanArkham\/comments\/1v3hkln/, 'og:url/canonical is the resolved permalink')
  assert.ok(!html.includes('uucSZtDEbI'), 'the opaque share code must never appear in the output')
  // The media is addressable under the CANONICAL ref (never the share code): the /_media/ route the
  // renderer's tags point at 302s to the origin image. This is the namespace claim, asserted directly.
  const m = await handle(req(`/_media/${encodeURIComponent(refKey(RD_CANON))}/0`, DISCORD), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.equal(m.headers.get('location'), 'https://i.redd.it/abc.jpg')
})

test('a share link our egress cannot resolve is the generic card, never a 500', async () => {
  const res = await handle(req(RD_SHARE, DISCORD), fakeEnv(), ctx, rdDeps({ resolveRedditShare: async () => null }))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /couldn't load/i, 'a resolve miss degrades to the reddit failure card')
})

test('a share link whose resolver THROWS degrades the same way, not a 500', async () => {
  const deps = rdDeps({ resolveRedditShare: async () => { throw new Error('egress blocked') } })
  const res = await handle(req(RD_SHARE, DISCORD), fakeEnv(), ctx, deps)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /couldn't load/i)
})

test('a HUMAN on a share link costs us nothing — 302 to the /s/ url, zero resolves', async () => {
  let resolves = 0
  const deps = rdDeps({ resolveRedditShare: async () => { resolves++; return { ref: RD_CANON, canonical: rdResolved.canonical } } })
  const res = await handle(req(RD_SHARE), fakeEnv(), ctx, deps)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.reddit.com/r/BatmanArkham/s/uucSZtDEbI')
  assert.equal(resolves, 0, 'a human resolves the share link in their own browser')
})

test('THE CACHE: a resolved share link and its permalink converge on ONE warm entry', async () => {
  let fetches = 0
  const deps = rdDeps({ fetchPost: async (ref) => { fetches++; return ref.p === 'rd' ? rdResolved : null } })
  await handle(req(RD_SHARE, DISCORD), fakeEnv(), ctx, deps)
  assert.equal(fetches, 1)
  // The permalink for the SAME post reads the response cache the share link warmed (same ref+client):
  // renderPostRoute keys on respCacheKey(ref), which the resolver made canonical, so no second fetch.
  const long = await handle(req('/r/BatmanArkham/comments/1v3hkln', DISCORD), fakeEnv(), ctx, deps)
  assert.equal(long.status, 200)
  assert.match(await long.text(), /did they wipe/, 'the permalink is served the SAME resolved post')
  assert.equal(fetches, 1, 'the permalink must not cost a second upstream fetch — it shares the entry')
})

test('liveResolveRedditShare: follows the 301 and re-routes the permalink to an rd ref', async () => {
  // The subtle half — the resolver reads the post id from the REDIRECT, never from the /s/ code, and
  // re-routes through route() so the tracking query (?share_id/utm_*) is dropped to the clean canonical.
  const real = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /www\.reddit\.com\/r\/BatmanArkham\/s\/uucSZtDEbI/)
    assert.equal(opts.redirect, 'manual', 'one hop, read off the Location — never fetch the permalink html')
    return Response.redirect(
      'https://www.reddit.com/r/BatmanArkham/comments/1v3hkln/did_they_wipe/?share_id=x&utm_source=share',
      301,
    )
  }
  try {
    const got = await liveResolveRedditShare('https://www.reddit.com/r/BatmanArkham/s/uucSZtDEbI', fakeEnv())
    assert.deepEqual(got, {
      ref: { p: 'rd', sub: 'BatmanArkham', id: '1v3hkln' },
      canonical: 'https://www.reddit.com/r/BatmanArkham/comments/1v3hkln',
    })
  } finally {
    globalThis.fetch = real
  }
})

test('liveResolveRedditShare: a withheld redirect (egress blocked) is a clean null, no throw', async () => {
  // Reddit blocks our datacenter egress on the .json/oauth API; if it withholds the /s/ redirect too,
  // there is simply no Location — the share link becomes the generic card, exactly today's behaviour.
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('security block', { status: 200 })
  try {
    assert.equal(await liveResolveRedditShare('https://www.reddit.com/r/x/s/y', fakeEnv()), null)
  } finally {
    globalThis.fetch = real
  }
})

test('liveResolveRedditShare: a Location that is not a Reddit POST is rejected — never mis-routes', async () => {
  // A share code we do not understand must not become some other platform's ref: route() must return
  // an rd post or the resolver says null. A subreddit LISTING is the nearest non-post reddit shape.
  const real = globalThis.fetch
  globalThis.fetch = async () => Response.redirect('https://www.reddit.com/r/pics', 301)
  try {
    assert.equal(await liveResolveRedditShare('https://www.reddit.com/r/pics/s/z', fakeEnv()), null)
  } finally {
    globalThis.fetch = real
  }
})

// ---------------------------------------------------------------------------
// YouTube — a REMUX-video platform. The container's yt-dlp resolves the watch page to a real,
// AD-FREE mp4 (ads are stitched in client-side by YouTube's player, never in the file), served via
// /_media as og:video → Discord's NATIVE video player (scrubbing, no iframe). This replaced an iframe
// twitter:card=player attempt, which was just Discord's own crappy ad-riddled embed. withResolver
// keeps the remux only with the container bindings present; without them it degrades to the thumbnail
// still (never a dead player). YouTube is NOT datacenter-IP-blocked — a JS runtime (Deno) in the
// container solves its signature challenge, so extraction works from CF egress (measured 2026-07-22).
// ---------------------------------------------------------------------------

const YT_REF = { p: 'yt', id: 'dQw4w9WgXcQ' }
const YT_CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const YT_THUMB = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
const ytPost = {
  ref: YT_REF,
  canonical: YT_CANON,
  author: { name: 'Rick Astley', handle: 'Rick Astley', url: 'https://www.youtube.com/@RickAstley' },
  title: 'Never Gonna Give You Up', text: '', createdAt: new Date(0),
  media: [{ kind: 'video', url: YT_CANON, w: 0, h: 0, poster: YT_THUMB, remux: { page: YT_CANON } }],
  counts: {}, sensitive: false,
}
const ytDeps = () => ({
  cache: fakeCache(),
  fetchPost: async (ref) => (ref.p === 'yt' ? ytPost : null),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})
// withResolver keeps a remux video only when both container bindings are present.
// withResolver keeps a remux video only with both container bindings present, and settleMux additionally
// requires the muxed object to EXIST before the card may promise og:video — so the fake R2 reports a hit.
const muxedEnv = () => ({
  ...fakeEnv(),
  MEDIA_RESOLVER: { getByName: () => ({ fetch: async () => new Response('', { status: 502 }) }) },
  MEDIA_CACHE: { head: async () => ({ size: 4494401 }), put: async () => {} },
})
const ytEnv = muxedEnv

test('YouTube renders a NATIVE og:video (remux {page}) through /_media — a real ad-free player, not an iframe', async () => {
  const html = await (await handle(req('/watch?v=dQw4w9WgXcQ', DISCORD), ytEnv(), ctx, ytDeps())).text()
  assert.match(html, /og:video" content="[^"]*\/_media\/yt%3AdQw4w9WgXcQ\/0/, 'og:video is our muxed mp4 via /_media')
  assert.match(html, /og:video:type" content="video\/mp4"/, 'a real video FILE — Discord uses its native player, no iframe')
  assert.ok(!/text\/html/.test(html), 'NOT the og:video:type=text/html iframe form')
  assert.ok(!html.includes('youtube.com/embed'), 'no embed-iframe url anywhere')
  assert.ok(!html.includes('i.ytimg.com'), 'no raw thumbnail CDN url leaks into the head')
  assert.match(html, /og:description" content="Never Gonna Give You Up"/, 'the title rides og:description on the spoof head')
})

test('a NOT-YET-MUXED {page} video renders the still (no og:video) and is NOT response-cached', async () => {
  // The card must only promise a video that exists: og:video pointing at an unfinished mux made the media
  // route answer with the poster IMAGE, which Discord cached as "this video is an image" — permanently.
  // Degrading here is honest, and skipping the response cache is what lets the NEXT render promise the
  // real video once the mux (still running in waitUntil) has landed.
  const cache = fakeCache()
  const env = {
    ...fakeEnv(),
    MEDIA_RESOLVER: { getByName: () => ({ fetch: async () => new Response('', { status: 502 }) }) },
    MEDIA_CACHE: { head: async () => null, put: async () => {} }, // never becomes ready
  }
  const waits = []
  const deps = { ...ytDeps(), cache }
  const html = await (await handle(req('/watch?v=dQw4w9WgXcQ', DISCORD), env, { waitUntil: (p) => waits.push(p) }, deps)).text()
  await Promise.allSettled(waits)
  assert.ok(!html.includes('og:video'), 'no video is promised until one exists')
  // The POST cache legitimately holds the post data (it is correct — only the RENDERED CARD is stale the
  // moment the mux lands), so assert precisely that: no HTML response was cached.
  const cachedHtml = [...cache.store.values()].filter(v => (v.headers.get('content-type') || '').includes('text/html'))
  assert.equal(cachedHtml.length, 0, 'a degraded card must not be response-cached — the next render must promise the video')
})

test('rendering a {page} remux post PREWARMS the mux — Discord loses the race otherwise', async () => {
  // THE DEFECT (measured 2026-07-24): Discord's media proxy fetches og:video seconds after the head and
  // caches what it gets; a cold yt-dlp mux took 27s, so it cached the poster fallback and the embed showed
  // "a frame that never plays". Starting the mux at RENDER time is what closes that gap.
  let called = 0
  const env = {
    ...fakeEnv(),
    MEDIA_RESOLVER: { getByName: () => ({ fetch: async () => { called++; return new Response('', { status: 502 }) } }) },
    MEDIA_CACHE: { head: async () => null, put: async () => {} },
  }
  const waits = []
  await handle(req('/watch?v=dQw4w9WgXcQ', DISCORD), env, { waitUntil: (p) => waits.push(p) }, ytDeps())
  await Promise.allSettled(waits)
  assert.ok(called >= 1, 'the container was asked to mux during the render, not left for Discord to trigger')
})

test('fetchYouTube NEVER fetches the watch page — the 1.58MB request is gone and stays gone', async () => {
  /**
   * THE PIN ON THE DELETED WATCH-PAGE FETCH. It read `<meta itemprop="datePublished">` out of the
   * first 64KB of a 1,575,509-byte page, inside fetchYouTube's own Promise.all — i.e. on the
   * first-paste critical path, spending the HTML_DEADLINE_MS budget settleMux needs — and from
   * Cloudflare egress it was right 1 TIME IN 3 on the field that actually renders (measured
   * 2026-07-26 against the apex with a Discordbot UA: 2 of 3 videos came back 1970 on their own
   * activity callback).
   *
   * THIS ASSERTED A REQUEST *COUNT* UNTIL 2026-08-27, and the count was the wrong pin. The property
   * that matters is that we never pull the watch page again; "exactly one request" was a proxy for it
   * that happened to be true. It stopped being true when the date moved to `youtubei/v1/player`
   * (see src/platforms/youtube/innertube.ts) — a ~10KB POST that is the fix for every YouTube card
   * rendering 1 January 1970, and which a count-based pin would have blocked for the wrong reason.
   *
   * So: assert the SHAPE of what we ask for. No watch page, ever; and every request we do make is one
   * of the two small JSON endpoints. That forbids the thing that was actually wrong without forbidding
   * the thing that was actually right.
   */
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return new Response(JSON.stringify({ title: 'Never Gonna Give You Up', author_name: 'Rick Astley' }),
      { headers: { 'content-type': 'application/json' } })
  }
  try {
    const got = await liveFetchPost(YT_REF, fakeEnv(), 'discord')
    for (const u of asked) {
      assert.doesNotMatch(u, /\/watch\?/, `the 1.58MB watch page must never be fetched: ${u}`)
      assert.match(u, /\/oembed\?|\/youtubei\/v1\/player/, `unexpected upstream request: ${u}`)
    }
    assert.ok(asked.some(u => /\/oembed\?/.test(u)), 'oembed still owns the title')
    assert.equal(got.title, 'Never Gonna Give You Up')
    // The stub answers the Innertube POST with the oembed body, which carries no date — so the epoch
    // fallback still stands here. youtube-innertube.test.mjs is where a real body is asserted.
    assert.equal(got.createdAt.getTime(), 0)
  } finally {
    globalThis.fetch = real
  }
})

test('YouTube degrades to the thumbnail still (no og:video) when no container is bound', async () => {
  const deps = ytDeps()
  const html = await (await handle(req('/watch?v=dQw4w9WgXcQ', DISCORD), fakeEnv(), ctx, deps)).text()
  assert.ok(!html.includes('og:video'), 'no container -> no muxed video, never a dead player')
  // withResolver turned the remux video into the poster image; the /_media route 302s to the thumbnail.
  const m = await handle(req(`/_media/${encodeURIComponent(refKey(YT_REF))}/0`, DISCORD), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.equal(m.headers.get('location'), YT_THUMB)
})

// ---------------------------------------------------------------------------
// Facebook — a REMUX-video platform like YouTube. The container's yt-dlp resolves the watch/reel/share
// PAGE to a real mp4 (measured egress-OK — Meta did NOT gate our datacenter), served via /_media as
// og:video -> Discord's native player. The poster is the crawler-UA og:image (lookaside.fbsbx.com).
// ---------------------------------------------------------------------------

const FB_REF = { p: 'fb', kind: 'watch', id: '10153231379946729' }
const FB_WATCH = 'https://www.facebook.com/watch/?v=10153231379946729'
const FB_POSTER = 'https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=10153231379946729'
const fbPost = {
  ref: FB_REF, canonical: FB_WATCH,
  author: { name: 'Facebook', handle: 'facebook', url: 'https://www.facebook.com' },
  title: 'A funny clip', text: '', createdAt: new Date(0),
  media: [{ kind: 'video', url: FB_WATCH, w: 0, h: 0, poster: FB_POSTER, remux: { page: FB_WATCH } }],
  counts: {}, sensitive: false,
}
const fbDeps = () => ({
  cache: fakeCache(),
  fetchPost: async (ref) => (ref.p === 'fb' ? fbPost : null),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})
const fbEnv = muxedEnv

test('Facebook renders a NATIVE og:video (remux {page}) through /_media, poster via /_media', async () => {
  const html = await (await handle(req('/watch?v=10153231379946729', DISCORD), fbEnv(), ctx, fbDeps())).text()
  assert.match(html, /og:video" content="[^"]*\/_media\/fb%3Awatch%3A10153231379946729\/0/, 'og:video is our muxed mp4 via /_media')
  assert.match(html, /og:video:type" content="video\/mp4"/)
  assert.ok(!html.includes('lookaside.fbsbx.com'), 'no raw poster CDN url leaks into the head (poster rides /_media)')
  assert.match(html, /og:url" content="https:\/\/www\.facebook\.com\/watch\/\?v=10153231379946729"/, 'og:url is the FB canonical (correct)')
  assert.match(html, /og:description" content="A funny clip"/)
})

test('Facebook degrades to the poster still (no og:video) when no container is bound', async () => {
  const deps = fbDeps()
  const html = await (await handle(req('/watch?v=10153231379946729', DISCORD), fakeEnv(), ctx, deps)).text()
  assert.ok(!html.includes('og:video'), 'no container -> the poster still, never a dead player')
  const m = await handle(req(`/_media/${encodeURIComponent(refKey(FB_REF))}/0`, DISCORD), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.equal(m.headers.get('location'), FB_POSTER)
})

test('tiktokRefFrom reads the id from the PAYLOAD, and refuses everything else', async () => {
  const { tiktokRefFrom } = await import('../src/platforms/tiktok/normalize.ts')
  const VIDEO = readFileSync('test/fixtures/tiktok-video.html', 'utf8')
  assert.deepEqual(tiktokRefFrom(VIDEO), { p: 'tt', id: '7660566211100511518' })
  // The homepage: a rehydration blob IS present (257,666 bytes of it), but no video-detail
  // scope. A resolver asserting on the marker alone would accept this as a post.
  //
  // THE REAL CAPTURE, not a two-key hand-written stub. This is the named hazard of the whole
  // short-link path — a failed code lands on the HOMEPAGE, which carries its own blob — and a
  // stub built to lack the scope cannot fail if the real homepage ever grows one. The capture
  // has been in test/fixtures since this phase's fetcher landed.
  const homepage = readFileSync('test/fixtures/tiktok-homepage.html', 'utf8')
  assert.equal(tiktokRefFrom(homepage), null, 'no video-detail scope means NOT a TikTok post')
  assert.equal(tiktokRefFrom(readFileSync('test/fixtures/tiktok-deleted.html', 'utf8')), null)
  for (const junk of [null, undefined, 42, '', '<html></html>']) {
    assert.doesNotThrow(() => tiktokRefFrom(junk))
    assert.equal(tiktokRefFrom(junk), null)
  }
})

// ---------------------------------------------------------------------------
// The short-link path driven through the REAL resolver, with only the network stubbed.
// Every test above this line injects a `resolveShortlink` stub, so none of them can see
// what the resolver DECIDES about a real body — which is where all four of the defects
// below lived.
// ---------------------------------------------------------------------------

const TT_VIDEO_HTML = readFileSync('test/fixtures/tiktok-video.html', 'utf8')
const TT_HOMEPAGE_HTML = readFileSync('test/fixtures/tiktok-homepage.html', 'utf8')
const TT_DELETED_HTML = readFileSync('test/fixtures/tiktok-deleted.html', 'utf8')
/** classify() routes this to 'telegram' — a third client class, i.e. a third response-cache key. */
const TELEGRAM = 'TelegramBot (like TwitterBot)'
/** The real Threads code from plan fact 10. Upstream answers it with the TikTok homepage. */
const THREADS_CODE = 'DTI1vjIEi5y'

/**
 * Wires the real liveFetchPost/liveResolveShortlink over a counted, scriptable network.
 *
 * TWO COUNTERS, NOT ONE, AND THE SPLIT IS LOAD-BEARING. A tt VIDEO post now costs TWO upstream
 * requests: the page fetch, and the aweme-redirect resolution that collapses Discord's chain from
 * two hops to one (see the hop-count block at the end of this file). They answer completely
 * different questions — `net.page` is "did the cache do its job", `net.aweme` is "was the video
 * url resolved" — and a single total conflates them: every assertion below that says "one fetch"
 * is about the PAGE, and would silently start passing or failing on a change to the other.
 *
 * The aweme url is answered with the 200 HTML interstitial that Workers egress actually measured
 * (docs/research/2026-07-18-tiktok-workers-egress-probe.md), NOT with `body`. Serving a 287KB post
 * page as the answer to a video request is a body that endpoint cannot produce, and it would make
 * these tests exercise a branch that does not exist. The interstitial resolves to null, so every
 * test in this block sees the DEGRADE path — the aweme url, two hops, i.e. exactly the behaviour
 * they were written against. The one-hop success path is owned by ttNetwork below.
 */
function liveDeps(cache = fakeCache()) {
  const net = { calls: 0, page: 0, aweme: 0, body: '' }
  return {
    net,
    deps: { cache, fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink },
    async serving(body, fn) {
      const real = globalThis.fetch
      net.body = body
      globalThis.fetch = async url => {
        net.calls++
        if (String(url).includes('/aweme/v1/play/')) {
          net.aweme++
          return new Response('<!doctype html><html><head><title>TikTok</title></head></html>',
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        net.page++
        return new Response(net.body, { status: 200 })
      }
      try { return await fn() } finally { globalThis.fetch = real }
    },
  }
}
const ogTitle = html => (html.match(/property="og:title" content="([^"]*)"/) || [, ''])[1]

test('A SHORT CODE AND A POST ID ARE DIFFERENT NAMESPACES — a warm post must not answer /t/', async () => {
  // DEFECT THIS PREVENTS: the lookup ref was `{p:'tt', id: code}`, so postCacheKey rendered it
  // `post:tt:{code}` — byte-identical in shape to a real post id's key. Warming
  // /@u/video/7660566211100511518 therefore made /t/7660566211100511518 serve that post with the
  // resolver NEVER CALLED. Measured live: /t/{19 digits} lands on the TikTok HOMEPAGE, so the
  // correct answer is the chooser and the cache was inventing the other one. Same URL, two
  // answers, decided by whether anyone happened to view the permalink first — which is verbatim
  // the "a guess serves the wrong post and nobody notices" failure the chooser exists to refuse.
  const { net, deps, serving } = liveDeps()
  const ID = '7660566211100511518'

  await serving(TT_VIDEO_HTML, () => handle(req(`/@mysticaquariumct/video/${ID}`, DISCORD), fakeEnv(), ctx, deps))
  // net.page, not net.calls: this fixture is a VIDEO, so it also costs an aweme resolution. The
  // claim here is about the PAGE fetch and the post cache, and it is unchanged by that.
  assert.equal(net.page, 1, 'the permalink warms the POST cache under the canonical id')

  // A DIFFERENT client class, so the response cache cannot be the explanation: this can only be
  // answered from the post cache, which is the layer the collision lived in.
  const env = fakeEnv()
  const html = await serving(TT_HOMEPAGE_HTML, async () =>
    (await handle(req(`/t/${ID}`, TELEGRAM), env, ctx, deps)).text())
  assert.equal(net.page, 2, 'the short code must be RESOLVED, never read off the post-id key')
  assert.ok(!html.includes('Duck'), 'a post keyed by id must not be served to a code that merely looks like it')
  assert.match(html, /Ambiguous link|Which site/i, 'upstream says that code is not TikTok — so, the chooser')
})

test('and the reverse: a resolved short link must not overwrite a real post id', async () => {
  // The same root cause pointing the other way, and the worse half — it serves the WRONG POST.
  // A short code that is all digits wrote `post:tt:{code}`, which IS the canonical key of the
  // post with that id. A legitimate permalink for that post then read a completely different
  // post out of it, silently.
  const { net, deps, serving } = liveDeps()
  const CODE = '1234567890123456789' // digits, and NOT the id the fixture resolves to

  await serving(TT_VIDEO_HTML, () => handle(req(`/t/${CODE}`, DISCORD), fakeEnv(), ctx, deps))
  assert.equal(net.page, 1)

  const html = await serving(TT_DELETED_HTML, async () =>
    (await handle(req(`/@someoneelse/video/${CODE}`, DISCORD), fakeEnv(), ctx, deps)).text())
  assert.equal(net.page, 2, 'the permalink must ask upstream, not read a short code entry')
  assert.ok(!html.includes('Duck'), 'post 7660… must never be served under the id 1234567890123456789')
  // Shared DISPLAY_NAME (Task 5): the failure embed now titles on the platform NAME, not the code —
  // 'TikTok', never 'tt'. outcome.platform stays the code; only the displayed string is mapped.
  assert.equal(ogTitle(html), "Couldn't load this TikTok post", 'upstream says that post is gone, and that is the answer')
})

test('A DELETED POST REACHED BY SHORT CODE IS A tt FAILURE, NOT A "maybe it was Threads" CHOOSER', async () => {
  // DEFECT THIS PREVENTS: tiktokRefFrom folds "no video-detail scope" (not TikTok) and "scope
  // present, statusCode 10204" (TikTok, post gone) into one null, and the resolver only had the
  // null. So the same deleted post answered "Couldn't load this TikTok post" through the permalink and
  // "Ambiguous link … tiktok.com or threads.com" through the short link — offering threads.com
  // for a link we hold positive proof is TikTok's, and filing it as ('none','ambiguous'), which
  // is byte-identical to a genuine Threads link. The payload distinguishes them; the deleted
  // fixture HAS the scope (statusCode 10204) and the homepage does not.
  const { deps, serving } = liveDeps()
  const env = fakeEnv()
  const html = await serving(TT_DELETED_HTML, async () =>
    (await handle(req('/t/ZTSw2mYwR', DISCORD), env, ctx, deps)).text())

  assert.equal(ogTitle(html), "Couldn't load this TikTok post", 'the same answer the permalink gives for the same post')
  assert.ok(!/threads\.com/.test(html), 'never offer Threads for a page that IS a TikTok video-detail page')
  const blobs = env.points.map(p => p.blobs.slice(0, 2).join('/'))
  assert.ok(blobs.includes('tt/fetch_fail'), `a deleted post is a tt fetch_fail, got ${JSON.stringify(blobs)}`)
  assert.ok(!blobs.includes('none/ambiguous'), 'and must not be filed as "we could not tell which platform"')
})

test('A NON-TIKTOK CODE IS ATTRIBUTED TO tt AND PAID FOR ONCE', async () => {
  // Two defects in one path. (a) The chooser here COSTS AN UPSTREAM FETCH and emitted the same
  // ('none','ambiguous') data point as /mrbeast, which costs nothing — so the spec's
  // fetch-amplification alert could not see this path at all. (b) Nothing was cached, so every
  // re-unfurl of the same pasted Threads link was another fetch to tiktok.com.
  const { net, deps, serving } = liveDeps()
  const env = fakeEnv()
  const html = await serving(TT_HOMEPAGE_HTML, async () => {
    const first = await (await handle(req(`/t/${THREADS_CODE}`, DISCORD), env, ctx, deps)).text()
    await handle(req(`/t/${THREADS_CODE}`, DISCORD), fakeEnv(), ctx, deps)
    await handle(req(`/t/${THREADS_CODE}`, DISCORD), fakeEnv(), ctx, deps)
    return first
  })

  assert.equal(ogTitle(html), 'Ambiguous link', 'the no-answer is still the chooser — nothing is guessed')
  assert.match(html, /threads\.com/, 'and it still names both candidate sites')
  assert.equal(net.calls, 1, 'three identical unfurls of one dead code must cost ONE upstream fetch')
  const blobs = env.points.map(p => p.blobs.slice(0, 2).join('/'))
  assert.ok(blobs.includes('tt/ambiguous'), `a PAID chooser must be attributable, got ${JSON.stringify(blobs)}`)
  assert.ok(!blobs.includes('none/ambiguous'), 'a free router-level ambiguous is a different event')
})

test('A REAL SHORT LINK STILL RESOLVES, through the real resolver, on real bytes', async () => {
  // The success arm of all of the above, so no fix to the failure arms can be paid for by
  // breaking the case that works. Asserted on CONTENT from the captured payload — the caption.
  const { net, deps, serving } = liveDeps()
  const env = fakeEnv()
  const html = await serving(TT_VIDEO_HTML, async () =>
    (await handle(req('/t/ZTSw2mYwR', DISCORD), env, ctx, deps)).text())
  assert.equal(net.page, 1, 'ONE fetch: the redirect and the payload arrive together')
  // The video resolution is a SECOND upstream request, and it is stated here rather than left
  // inside a total, so the cost of the hop-count fix is visible on the path that pays it.
  assert.equal(net.aweme, 1, 'plus the aweme resolution — one per post, and never more')
  assert.match(html, /Duck/, 'the resolved post, not a chooser and not a failure embed')
  // Under the CANONICAL ref, never the short code. Reads the og:video tag's /_media/ url since
  // Task 7's carve-out; it was the spoof callback id before that, and the carve-out's removal on
  // 2026-07-19 did not take the url away — renderSpoof emits og:video as a fallback.
  assert.ok(html.includes(mediaRef(TT_CANON)), 'under the CANONICAL ref')
  assert.ok(env.points.some(p => p.blobs[0] === 'tt' && p.blobs[1] === 'ok'))
})

test('A TRUNCATED RESPONSE IS assert_fail, NOT "that code is not TikTok"', async () => {
  // The marker survives truncation (it is in the first 60 bytes of the document); the blob's
  // closing tag does not. A marker-only assertion therefore called a response that never
  // arrived a page that did, and every short link degraded to the chooser with assert_fail
  // sitting at zero — the exact blindness the Phase-1 Outcome2 split exists to prevent.
  const { deps, serving } = liveDeps()
  const env = fakeEnv()
  await serving(TT_VIDEO_HTML.slice(0, Math.floor(TT_VIDEO_HTML.length * 0.9)), () =>
    handle(req('/t/ZTSw2mYwR', DISCORD), env, ctx, deps))
  const blobs = env.points.map(p => p.blobs.slice(0, 2).join('/'))
  assert.ok(blobs.includes('tt/assert_fail'), `a body we cannot parse means WE are broken, got ${JSON.stringify(blobs)}`)
})

test('a resolver returning the WRONG SHAPE degrades too, rather than 500ing', async () => {
  // The resolver's contract went from `Post | null` to a three-way ShortlinkResolution, and .mjs
  // callers are never typechecked against it (tsconfig includes only src). A stale caller still
  // returning `null` therefore reaches the shortlink case with nothing to read `.kind` off —
  // verified: an uncaught TypeError out of handle(), which is HTTP 500 on a public path, because
  // handle() has no try/catch and the default export does not wrap it. The sibling case, a
  // resolver that THROWS, has degraded to the chooser since this route was written; this is the
  // same class of failure and must not answer differently.
  const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => null }
  const res = await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /Ambiguous link/i)
})

// ---------------------------------------------------------------------------
// END TO END, ON THE REAL FIXTURES, WITH NO NETWORK.
//
// The liveDeps block ABOVE already drives real captured bytes through the real normalizer and
// out through handle() — it is not the case that everything above injects a hand-written Post,
// and line ~906 already asserts the /_media/ seam on the video fixture. What this block adds is
// the coverage those tests structurally cannot give, because each of them drives ONE url:
//   - the slideshow fixture at all (the gallery path; liveDeps only ever serves video/homepage/
//     deleted), and the Mastodon JSON surface, which no test above reaches with a real capture;
//   - the CALLBACK ROUND-TRIP: render the head, read the url it advertises back out of it, and
//     drive THAT. A test that mints the id with `encodeStatusId(refKey(ref))` itself only proves
//     decode is the inverse of its own encode — it cannot see the renderer advertising a third
//     thing, and it cannot see the decode landing on the WRONG post (proven: corrupting either
//     parseRefKey's tt arm or router.spoof's ref left the old form of this test green);
//   - long-form vs short-link BYTE IDENTITY, which pins the canonical cache write in loadPost.
//
// The shared property is the SEAM — a wire format two modules spell differently — which is the
// one defect class no single-module test can see: normalize.ts writing `media[].url` and
// media.ts reading `media[].href` would leave both modules' own suites green.
//
// These are seam coverage, not sole guards: every mutation tried against them is also caught by
// at least one pre-existing test. That is a healthy suite, not a redundant one — but do not
// delete a pre-existing test on the theory that one of these replaced it.
//
// `tiktokRefFrom` mints the ref rather than a hardcoded literal, because that is exactly what the
// short-link resolver does upstream. A ref typed in by hand here would let a normalizer that
// reads the id from the wrong place still satisfy the "short and long agree" assertion below.
//
// `resolveShortlink` returns a three-way ShortlinkResolution, NOT a bare Post. Passing `post`
// directly (or `null`) type-checks nowhere — .mjs is outside tsconfig — and degrades silently to
// the chooser via `got?.kind === 'post' ? got.post : null` in worker.ts, which would make the
// tests below pass or fail for reasons unrelated to what they name. See the dedicated
// wrong-shape test above.
// ---------------------------------------------------------------------------

const { normalizeTikTok: ttNormalize, tiktokRefFrom: ttRefFrom } =
  await import('../src/platforms/tiktok/normalize.ts')

/** Fixtures the module scope already holds, so the 287KB captures are read once, not twice. */
const TT_FIXTURES = { video: TT_VIDEO_HTML, deleted: TT_DELETED_HTML }
const ttHtml = name => TT_FIXTURES[name] ?? readFileSync(`test/fixtures/tiktok-${name}.html`, 'utf8')

/** The real capture -> the real normalizer -> a Post, keyed by the id its own payload names. */
const ttPost = name => {
  const html = ttHtml(name)
  const ref = ttRefFrom(html)
  // ttRefFrom returns null for any capture that loses its video-detail scope or gains a nonzero
  // statusCode — i.e. exactly the platform-drift case this file exists to name. Without this,
  // drift surfaces as `TypeError: Cannot read properties of null (reading 'p')` thrown from
  // normalizeTikTok's first line, which names neither the fixture nor the cause.
  assert.ok(ref, `fixture tiktok-${name}.html no longer yields a ref — the capture drifted`)
  return ttNormalize(html, ref)
}

test('REAL FIXTURE: a TikTok video renders a player, WITH MEDIA ON OUR OWN ORIGIN', async () => {
  // THE ASSERTION TASK 5 COULD NOT MAKE. Before the carve-out (Task 7), a tt video post took
  // renderSpoof, which emitted ZERO /_media/ urls on a media post — the C1 og:IMAGE suppression
  // is that mechanism. The carve-out made og:video available to assert on; its removal on
  // 2026-07-19 kept it available, because renderSpoof gained an og:video FALLBACK when the post
  // came back to it. Either way og:video must be OUR url, never TikTok's.
  //
  // This test now covers the shipped Discord shape again rather than a carve-out-only path: the
  // head it inspects carries og:video AND both callback links, which is production fxtiktok's
  // measured shape (2026-07-19).
  const post = ttPost('video')
  const cache = fakeCache()
  const deps = { cache, fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const html = await (await handle(req(`/@u/video/${post.ref.id}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, /property="og:video"/)
  // mediaRef, not the plan's `new RegExp('/_media/tt%3A' + id + '/0')`: same claim, and the
  // reason is written out at the top of this file — a '%' inside an interpolated pattern is how
  // an assertion silently starts matching something adjacent to what it names.
  assert.ok(html.includes(mediaRef(post.ref)), 'og:video must point at OUR origin')
  assert.ok(!html.includes('tiktokcdn'), 'no raw CDN url may reach a client')
  assert.ok(!html.includes('aweme/v1/play'))
  assert.ok(!html.includes('webapp-prime'), 'and never a cookie-gated host')
  assert.match(html, /name="theme-color" content="#ff0050"/, 'the head carries the accent too')
  // THE END-TO-END PROOF THAT THE CARVE-OUT IS GONE, on real captured bytes rather than a
  // hand-built Post: a real TikTok video, normalized by the real normalizer, rendered for a real
  // Discord UA, comes out on the SPOOF head — activity link, oEmbed link, og:video fallback, and
  // no og:image. render.test.mjs asserts this shape on a fixture; this asserts it survives the
  // whole pipeline.
  assert.match(html, /application\/activity\+json/, 'a tt video takes the spoof head again')
  assert.match(html, /application\/json\+oembed/)
  assert.ok(!html.includes('og:image'), 'an og:image would outrank the activity card')

  const key = encodeURIComponent(refKey(post.ref))
  const m = await handle(req(`/_media/${key}/0`), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.ok(m.headers.get('location').includes('/aweme/v1/play/'))
})

test('REAL FIXTURE: a TikTok slideshow becomes a Mastodon gallery, all images, all on our origin', async () => {
  // THE PHASE 2 PAYOFF. Not one line of gallery code was written this phase.
  const post = ttPost('slideshow')
  // The ref the ROUTER decoded, captured off the callback. `async () => post` throws this away
  // and hands back the right post no matter what the router decoded, so the old form of this
  // test could not fail on a broken decode — proven by mutation: corrupting parseRefKey's tt arm
  // (`dec(p[1]) + 'X'`) or router.spoof's ref (`id + '9'`) left it green while four and six
  // pre-existing tests respectively went red.
  let seen = null
  const depsWith = cache => ({
    cache,
    fetchPost: async ref => { seen = ref; return post },
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  })

  // Drive the url the HEAD ADVERTISES, read back out of the rendered head — not one this test
  // mints for itself with encodeStatusId. Two reasons. (a) A self-minted id only proves decode
  // inverts this file's own encode; it cannot see the renderer advertising a third spelling that
  // nothing ever decodes. (b) Discord requests `/users/{handle}/statuses/{id}`, NOT the
  // `/api/v1/statuses/{id}` this test used to drive — both route to 'activity', but only one of
  // them is the shape a crawler actually sends.
  const head = await (await handle(req(`/@u/photo/${post.ref.id}`, DISCORD), fakeEnv(), ctx, depsWith(fakeCache()))).text()
  const advertised = (head.match(/https:\/\/staging\.megapenispoopenfarten\.sex(\/users\/[^"]*\/statuses\/[^"]*)/) || [])[1]
  assert.ok(advertised, 'the spoof head must advertise a statuses callback at all')
  assert.equal(advertised, `/users/${post.author.handle}/statuses/${encodeStatusId(refKey(post.ref))}`)

  // A COLD cache for the callback, deliberately. Sharing the head render's cache serves the
  // callback out of the post cache without ever calling fetchPost, leaving `seen` null and the
  // decode unobserved — which is how this assertion first failed. Discord's callback is a
  // separate request and may well land on a different colo with nothing warm anyway.
  seen = null
  const res = await handle(req(advertised, DISCORD), fakeEnv(), ctx, depsWith(fakeCache()))
  // THE ROUND-TRIP: the ref that came back out of the advertised id is the one that went in.
  // renderer -> encodeStatusId -> {id} segment -> decodeStatusId -> parseRefKey, closed.
  assert.deepEqual(seen, post.ref, 'the callback must decode to the post it advertises, not merely to A valid tt ref')

  assert.equal(res.headers.get('content-type'), 'application/json')
  const json = await res.json()
  assert.equal(json.media_attachments.length, post.media.length)
  assert.ok(json.media_attachments.length >= 2)
  json.media_attachments.forEach((a, i) => {
    assert.equal(a.type, 'image')
    // Full url, not a /_media/ substring: "all on our origin" is what the title claims, and a
    // hardcoded prod origin in embed.ts is invisible to a path-only match. The trailing index is
    // pinned too — every attachment collapsing to /0 is a 5-image gallery of one image.
    assert.equal(a.url, `https://staging.megapenispoopenfarten.sex${mediaRef(post.ref, i)}`)
  })
  assert.equal(json.application.name, 'TikTok')
})

test('REAL FIXTURE: a deleted TikTok post is an honest failure, not a blank embed', async () => {
  // The deleted capture is HTTP 200 with a structurally valid 287KB blob (statusCode 10204, no
  // itemStruct), so nothing before the normalizer can tell it from a live post. Its null has to
  // survive all the way out to a visible failure rather than an empty-but-well-formed embed.
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => ttNormalize(TT_DELETED_HTML, { p: 'tt', id: '1' }),
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  const res = await handle(req('/@u/video/1', DISCORD), fakeEnv(), ctx, deps)
  assert.match(await res.text(), /may be private, removed, or unavailable/i)
})

test('REAL FIXTURE: a SHORT LINK reaches the same player, on the same canonical media urls', async () => {
  // The seam Task 6 built, driven through the real fixture and the real normalizer: the short
  // code resolves to the canonical ref, and every url it mints is the one the long-form
  // permalink mints.
  //
  // What this does NOT test, despite the obvious reading: resolver behaviour. `resolveShortlink`
  // is INJECTED here and hands back a post whose ref is already canonical, so no resolver
  // decision is under test — the liveDeps block above owns that. What it does test is the
  // worker's canonical cache write in loadPost: fetchPost THROWS in these deps, so the long-form
  // permalink can only be answered out of the entry the shortlink path wrote under the canonical
  // key. Disabling that write (`if (false && canonical !== key)`) turns the second render into a
  // "couldn't load" failure embed and fails the byte-identity assertion below.
  const post = ttPost('video')
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => { throw new Error('a short link must resolve, not fall through to fetchPost') },
    resolveShortlink: async () => ({ kind: 'post', post }),
  }
  const short = await (await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)).text()
  assert.ok(short.includes(mediaRef(post.ref)), `must mint media under the canonical ref: ${mediaRef(post.ref)}`)
  assert.ok(!short.includes('ZTSw2mYwR'), 'the short code must not survive into the output')

  // Same warm cache entry, same bytes, from the long-form permalink. fetchPost THROWS in these
  // deps, so a permalink that does NOT find the shortlink's canonical write is a hard failure
  // here rather than a quietly-refetched second copy that happens to look the same.
  const long = await (await handle(req(`/@u/video/${post.ref.id}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.equal(long, short, 'both spellings of one post must render identically')
})

test('THE PROBE IS GONE — a debug egress endpoint must not ship to a public origin', () => {
  // This test exists because the probe's removal was, in the first draft of the TikTok plan, a
  // BASH COMMENT. An agent that ran `git rm` and skipped the unmount left a token-gated endpoint
  // that fetches a caller-supplied id from our egress, on a public staging hostname, with a
  // green suite and a clean typecheck.
  //
  // It was SUSPENDED with `{ skip }` — never deleted — for exactly as long as the Instagram plan's
  // Task 1 probe was in flight, because that task re-mounts a probe of the shape this test forbids
  // on purpose (every Instagram fact that phase rests on was measured from a RESIDENTIAL IP, and
  // Instagram answers the wrong requester with a 599KB decoy at HTTP 200). A skip prints on every
  // run and keeps the debt in front of whoever runs the suite next; a deleted test is in front of
  // nobody. Task 8 — this commit — is what unskips it, and it may never be skipped again without a
  // named, in-flight measurement to point at.
  //
  // Source-level, deliberately: the MOUNT is what survives a partial deletion, and it is what a
  // cutover would carry into production.
  assert.equal(existsSync('src/probe.ts'), false, 'src/probe.ts must be deleted')
  assert.equal(existsSync('test/probe.test.mjs'), false, 'test/probe.test.mjs must be deleted')
  for (const f of ['src/worker.ts', 'src/analytics.ts']) {
    const src = readFileSync(f, 'utf8')
    assert.ok(!src.includes('_probe'), `${f} still mounts the probe`)
    assert.ok(!src.includes('PROBE_TOKEN'), `${f} still references PROBE_TOKEN`)
    assert.ok(!src.includes('runProbe'), `${f} still imports runProbe`)
  }
})

test('and the probe PATH is now just an unknown path, even with a token in env', async () => {
  // The behavioural half. It does NOT assert a non-200: after the unmount /_probe/t is a depth-2
  // unknown path, which route() answers notfound and render() answers with an error embed at 200
  // for a crawler. The assertion is on the BODY.
  //
  // THE CODE MUST BE SHORTCODE-SHAPED, and this is not cosmetic. runProbe rejects anything failing
  // /^[A-Za-z0-9_-]{5,32}$/ with a 400 BEFORE emitting a report, so `?code=ABC` — three characters
  // — makes every assertion below hold against a live, mounted, reachable probe. That exact defect
  // shipped once already in Task 1's guards and was caught only by mutation testing: the suite
  // stayed green at 389 pass with the token gate deleted outright. A false green here is worse
  // than a red, because this test is the ONLY thing standing between "the agent meant to unmount
  // the probe" and "the agent unmounted the probe". The same trap applies to the field names: the
  // TikTok spellings (`"page"`, `markerPresent`) are absent from an Instagram probe report, so
  // asserting on those would pass against a mounted probe too.
  //
  // fetch is stubbed so that a regression fails offline and fast instead of making five real
  // Instagram requests from the test suite.
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('stub', { status: 200 })
  try {
    const env = { ...fakeEnv(), PROBE_TOKEN: 't' }
    const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }) }
    const text = await (await handle(req('/_probe/t?code=AAAAAAAAAAA', DISCORD), env, ctx, deps)).text()
    assert.ok(!text.includes('"embed"'), 'no probe report may be emitted')
    assert.ok(!text.includes('hasShortcodeMedia'), 'nor any field of one')
  } finally { globalThis.fetch = realFetch }
})

// ---------------------------------------------------------------------------
// THE HOP COUNT — why a tt VIDEO got the OpenGraph card while a tt SLIDESHOW got the
// Mastodon activity card.
//
// It was never a meta tag. Three tag-level hypotheses were tried and all three were wrong
// (see the git log for 6b20562, 5a7578e, 6fae4a9). Measured 2026-07-19 with
// `curl -sSL -w '%{num_redirects}'`, the correlation is perfect:
//
//   our slideshow image   1 redirect   -> activity card   (works)
//   Bluesky image         1 redirect   -> activity card   (works)
//   PRODUCTION fxtiktok   1 redirect   -> activity card   (works)
//   OUR video             2 redirects  -> OpenGraph card  (FAILS)
//
// Our chain was /_media/{key}/0 -> 302 the aweme endpoint -> 302 the real CDN bytes. Production
// is one hop because its offload service resolves the aweme redirect server-side. So do we now.
//
// These tests drive handle() with an injected network and assert on the Location header the
// media route actually emits, because the hop count IS the fix — inferring it from "the
// normalizer stored a different string" would not see the route that has to hand it out.
// ---------------------------------------------------------------------------

/** The measured shape of the aweme 302's target (2026-07-19 residential control arm). */
const CDN_URL = 'https://v16m-default.tiktokcdn-us.com/abc123/def/video.mp4?a=1234&br=900'

/**
 * A network that tells the PAGE fetch from the AWEME fetch and counts both, so a test can assert
 * how many times each was paid for. `aweme` scripts the second hop's answer:
 *   a string -> a 302 carrying it as Location (the working branch)
 *   null     -> the 200 HTML interstitial Workers egress actually measured (the degrade branch)
 *   'throw'  -> a rejected fetch (DNS, timeout, reset)
 */
function ttNetwork({ page = TT_VIDEO_HTML, aweme = CDN_URL } = {}) {
  const net = { page: 0, aweme: 0, urls: [] }
  return {
    net,
    async serving(fn) {
      const real = globalThis.fetch
      globalThis.fetch = async (url) => {
        const u = String(url)
        net.urls.push(u)
        if (u.includes('/aweme/v1/play/')) {
          net.aweme++
          if (aweme === 'throw') throw new Error('ECONNRESET')
          if (aweme === null) {
            return new Response('<!doctype html><html><head><title>TikTok</title></head></html>',
              { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          return new Response(null, { status: 302, headers: { location: aweme } })
        }
        net.page++
        return new Response(page, { status: 200 })
      }
      try { return await fn() } finally { globalThis.fetch = real }
    },
  }
}

const TT_VIDEO_ID = '7660566211100511518'
const TT_MEDIA_KEY = encodeURIComponent(refKey({ p: 'tt', id: TT_VIDEO_ID }))

test('THE FIX: a tt video /_media/ 302s STRAIGHT TO THE CDN, not to the aweme endpoint', async () => {
  // THE ASSERTION THE WHOLE CHANGE EXISTS FOR. Discord follows this Location; if it lands on
  // another 302 that is two hops and the OpenGraph card comes back.
  const { net, serving } = ttNetwork()
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const loc = await serving(async () => {
    const m = await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), fakeEnv(), ctx, deps)
    assert.equal(m.status, 302)
    return m.headers.get('location')
  })

  assert.equal(loc, CDN_URL, 'the media route must hand out the RESOLVED url')
  // Spelled as its own assertion rather than left implicit in the equality above, because this
  // is the property in prose: the thing Discord fetches must not be another redirect.
  assert.ok(!loc.includes('tiktok.com/aweme'), `still two hops: ${loc}`)
  assert.ok(!loc.includes('/aweme/v1/play/'), `still two hops: ${loc}`)
  assert.equal(new URL(loc).hostname, 'v16m-default.tiktokcdn-us.com')
  // And it really was resolved through the network rather than pattern-matched out of the page.
  assert.equal(net.aweme, 1)
  assert.equal(net.page, 1)
})

test('THE RESOLUTION IS PAID FOR ONCE PER POST, NOT ONCE PER MEDIA HIT', async () => {
  // The amortisation constraint, and the reason this happens in the FETCHER rather than in the
  // media route. media.ts already states the rule for the post fetch itself — "an 8-image
  // carousel triggers 8 media hits; re-resolving each would mean 8 upstream fetches per viewing
  // client, on the platforms we rate most fragile" — and resolving per media hit would reinstate
  // exactly that, one aweme request per client per view.
  const { net, serving } = ttNetwork()
  const cache = fakeCache()
  const deps = { cache, fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  await serving(async () => {
    for (let i = 0; i < 4; i++) {
      const m = await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), fakeEnv(), ctx, deps)
      assert.equal(m.headers.get('location'), CDN_URL, `hit ${i} must serve the resolved url`)
    }
    // A SECOND consumer of the same cache entry: the post head and the activity callback both
    // read the post the media route warmed. None of them may re-resolve.
    await handle(req(`/@u/video/${TT_VIDEO_ID}`, DISCORD), fakeEnv(), ctx, deps)
  })
  assert.equal(net.page, 1, 'one page fetch, as before')
  assert.equal(net.aweme, 1, 'and ONE resolution, amortised across every client that fetches it')
})

test('A FAILED RESOLUTION DEGRADES TO THE AWEME URL — the old two hops, never a 404', async () => {
  // The degrade rule at the surface that ships. Two hops renders a worse card; zero video
  // renders nothing. worker.ts's media branch has no try/catch, so a throw here is an uncaught
  // 500 on a public path — asserted on both the interstitial branch (which Workers egress
  // actually measured, see docs/research/2026-07-18-tiktok-workers-egress-probe.md) and a
  // rejected fetch.
  for (const aweme of [null, 'throw']) {
    const { serving } = ttNetwork({ aweme })
    const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
    const m = await serving(async () => {
      let res
      await assert.doesNotReject(
        async () => { res = await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), fakeEnv(), ctx, deps) },
        `aweme=${aweme} must not throw`,
      )
      return res
    })
    assert.equal(m.status, 302, `aweme=${aweme}: still a redirect, never a 404`)
    const loc = m.headers.get('location')
    assert.ok(loc.includes('/aweme/v1/play/'), `aweme=${aweme}: must degrade to the aweme url, got ${loc}`)
    assert.ok(loc.includes(`item_id=${TT_VIDEO_ID}`), 'and to THIS post\'s url, not a placeholder')
  }
})

test('THE SHORT-LINK PATH RESOLVES TOO — one post, one answer, whichever url was pasted', async () => {
  // liveResolveShortlink builds its own Post out of a second fetcher. Wiring the resolution into
  // liveFetchPost alone would leave every /t/{code} video on two hops, i.e. the same post
  // rendering differently depending on which url shape somebody pasted — the failure the
  // canonical-key cache write exists to prevent, reappearing one layer up.
  const { net, serving } = ttNetwork()
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const loc = await serving(async () => {
    await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)
    const m = await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), fakeEnv(), ctx, deps)
    return m.headers.get('location')
  })
  assert.equal(loc, CDN_URL, 'a short link must reach the same one-hop media url as the permalink')
  assert.equal(net.aweme, 1, 'and the media hit must ride the shortlink write, not re-resolve')
})

test('NO RESOLVED CDN URL REACHES A CLIENT — not in the head, not in media_attachments', async () => {
  // The project rule is unchanged by this fix: /_media/ is the ONLY place a CDN url may appear,
  // and all we changed is what it redirects TO. Now that the cached Post holds a real
  // tiktokcdn-us host, a renderer that ever inlined media[].url would leak a signed, expiring
  // origin url straight into Discord's cache — which is precisely what the indirection prevents.
  const { serving } = ttNetwork()
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const [head, activity] = await serving(async () => {
    const h = await (await handle(req(`/@u/video/${TT_VIDEO_ID}`, DISCORD), fakeEnv(), ctx, deps)).text()
    const id = encodeStatusId(refKey({ p: 'tt', id: TT_VIDEO_ID }))
    const a = await (await handle(req(`/api/v1/statuses/${id}`, DISCORD), fakeEnv(), ctx, deps)).json()
    return [h, a]
  })

  for (const [what, text] of [['head', head], ['activity json', JSON.stringify(activity)]]) {
    assert.ok(!text.includes('tiktokcdn'), `${what} leaked the resolved CDN host`)
    assert.ok(!text.includes('v16m-default'), `${what} leaked the resolved CDN host`)
    assert.ok(!text.includes('aweme/v1/play'), `${what} leaked the aweme url`)
    assert.ok(!text.includes('webapp-prime'), `${what} leaked a cookie-gated host`)
  }
  // The positive half: the head still advertises OUR url for the same bytes.
  assert.ok(head.includes(`/_media/${TT_MEDIA_KEY}/0`), 'og:video must still point at our origin')
})

/**
 * A container binding whose /resolve answers the `{redirect}` mode with `location`.
 * `calls` counts them, so "the container was not asked at all" is assertable rather than implied.
 */
function fakeRedirectResolver(location, { status = 200 } = {}) {
  const calls = { n: 0, bodies: [] }
  return {
    calls,
    binding: {
      getByName: () => ({
        async fetch(_url, init) {
          calls.n++
          calls.bodies.push(JSON.parse(init.body))
          if (status !== 200) return new Response('', { status })
          return Response.json({ location, status: location ? 302 : 200 })
        },
      }),
    },
  }
}

test('WHEN WORKER EGRESS CANNOT RESOLVE, THE CONTAINER DOES — and the card gets one hop anyway', async () => {
  // THE FIX THIS RELEASE EXISTS FOR. `aweme: null` is the 200 HTML interstitial Cloudflare WORKER
  // egress actually returns for /aweme/v1/play/ — the state production has been in since roughly
  // 2026-08-08, measured as tt_twohop 3 / tt_onehop 0. Before this, that meant two hops forever.
  //
  // It is NOT a bug we can fix in the Worker, which is why the fallback goes through the container:
  // fxTikTok's own Cloudflare Worker answers the same 404 for the same video, and their production
  // only works because OFF_LOAD points at a box they run themselves.
  const { net, serving } = ttNetwork({ aweme: null })
  const rr = fakeRedirectResolver(CDN_URL)
  const env = fakeEnv({ MEDIA_RESOLVER: rr.binding })
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const loc = await serving(async () => {
    const m = await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), env, ctx, deps)
    assert.equal(m.status, 302)
    return m.headers.get('location')
  })
  assert.equal(loc, CDN_URL, 'the container-resolved url must be what /_media/ hands Discord')
  assert.ok(!loc.includes('/aweme/v1/play/'), `still two hops: ${loc}`)
  assert.equal(rr.calls.n, 1, 'the container is asked exactly once, not once per media hit')
  assert.equal(rr.calls.bodies[0].redirect.includes('/aweme/v1/play/'), true,
    'and it is asked to resolve the AWEME url, not the page')
  // The Worker still tries its own fetch first — free when it works, and the only path the day
  // TikTok stops refusing this egress.
  assert.equal(net.aweme, 1, 'the Worker attempt still happens before the container is asked')
})

test('THE WORKER FETCH WINS WHEN IT CAN — the container is a fallback, never the default', async () => {
  // Guards the ordering. If this inverted, every TikTok would pay a container round trip for an
  // answer the Worker already had, on the platform this repo rates most fragile.
  const { serving } = ttNetwork()   // aweme resolves normally
  const rr = fakeRedirectResolver('https://v16m-default.tiktokcdn-us.com/SHOULD-NOT-BE-USED/v.mp4')
  const env = fakeEnv({ MEDIA_RESOLVER: rr.binding })
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const loc = await serving(async () =>
    (await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), env, ctx, deps)).headers.get('location'))
  assert.equal(loc, CDN_URL, "the Worker's own resolution must win")
  assert.equal(rr.calls.n, 0, 'and the container must not be asked at all')
})

test('A CONTAINER ANSWER IS HELD TO THE SAME HOST RULE — never trusted because it came from us', async () => {
  // A Location is attacker-influenced wherever it is followed, and this one becomes og:video. The
  // container validates its own output; this asserts the WORKER does too, so the rule survives the
  // container changing independently. Each of these degrades to the aweme url — today's behaviour —
  // rather than shipping the bad value.
  for (const [what, bad] of [
    ['a non-CDN host', 'https://evil.example.com/v.mp4'],
    ['another aweme url', 'https://www.tiktok.com/aweme/v1/play/?item_id=1'],
    ['plain http', 'http://v16m-default.tiktokcdn-us.com/v.mp4'],
    ['nothing at all', ''],
  ]) {
    const { serving } = ttNetwork({ aweme: null })
    const rr = fakeRedirectResolver(bad)
    const env = fakeEnv({ MEDIA_RESOLVER: rr.binding })
    const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
    const loc = await serving(async () =>
      (await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), env, ctx, deps)).headers.get('location'))
    assert.ok(loc.includes('/aweme/v1/play/'), `${what}: must degrade to the aweme url, got ${loc}`)
    assert.ok(!loc.includes('evil.example.com'), `${what}: refused host reached a client`)
  }
})

test('A REFUSING CONTAINER COSTS THE OPTIMISATION AND NOTHING ELSE — never a 500, never a 404', async () => {
  // The tt arm has no try/catch around this call, so an escaping throw is an uncaught 500 on a
  // public path. Asserted on a 502 from the binding and on a binding that throws outright.
  const throwing = { getByName: () => ({ fetch: async () => { throw new Error('DO unavailable') } }) }
  for (const [what, binding] of [
    ['a 502 from the container', fakeRedirectResolver(CDN_URL, { status: 502 }).binding],
    ['a binding that throws', throwing],
  ]) {
    const { serving } = ttNetwork({ aweme: null })
    const env = fakeEnv({ MEDIA_RESOLVER: binding })
    const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
    let res
    await serving(async () => {
      await assert.doesNotReject(async () => {
        res = await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), env, ctx, deps)
      }, `${what} must not throw`)
    })
    assert.equal(res.status, 302, `${what}: still a redirect`)
    assert.ok(res.headers.get('location').includes('/aweme/v1/play/'),
      `${what}: degrades to the aweme url, exactly as before this fallback existed`)
  }
})

test('NO CONTAINER BINDING MEANS NO FALLBACK, AND NO CRASH — the self-host / dev shape', async () => {
  // awemeViaContainer returns undefined with no MEDIA_RESOLVER, and withResolvedVideo must then be
  // the two-hop-degrading function it has always been. docs/SELF-HOSTING.md's whole premise is that
  // the Worker runs without the container.
  const { serving } = ttNetwork({ aweme: null })
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const loc = await serving(async () =>
    (await handle(req(`/_media/${TT_MEDIA_KEY}/0`, DISCORD), fakeEnv(), ctx, deps)).headers.get('location'))
  assert.ok(loc.includes('/aweme/v1/play/'), 'no binding: the aweme url, unchanged')
})

/**
 * THE STOCK-PLAYER EXPERIMENT ROUTE. These pin the three variants' SHAPES, because the experiment's
 * whole value is that one paste session discriminates between them — two variants that accidentally
 * emit the same head answer nothing, and nobody would notice from a client.
 */
const stockServing = async (fn, { oembed = { title: 'Real Title', author_name: 'Real Author' } } = {}) => {
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    if (oembed === 'throw') throw new Error('ECONNRESET')
    return Response.json(oembed)
  }
  try { return await fn() } finally { globalThis.fetch = real }
}

test('STOCK v1 EMITS THE IFRAME PLAYER AND NOTHING THAT COMPETES WITH IT', async () => {
  const res = await stockServing(() => handle(req('/_stock/1/jNQXAC9IVRw', DISCORD), fakeEnv(), ctx, {}))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store',
    'an experiment result must never be pinned by a response cache')
  const h = await res.text()
  assert.ok(h.includes('twitter:player" content="https://www.youtube.com/embed/jNQXAC9IVRw"'),
    'the player IS the experiment')
  assert.ok(h.includes('og:video:type" content="text/html"'), 'an iframe, not an mp4')
  assert.ok(h.includes('Real Title'), 'the oEmbed title reaches the card')
  assert.ok(!h.includes('activity+json'), 'v1 must not carry the link v3 exists to test')
  assert.ok(!h.includes('json+oembed'), 'v1 must not carry the link v2 exists to test')
})

test('STOCK v2 ADDS ONLY THE OEMBED LINK; v3 ADDS THE ACTIVITY LINK ON TOP', async () => {
  const [v2, v3] = await stockServing(async () => [
    await (await handle(req('/_stock/2/jNQXAC9IVRw', DISCORD), fakeEnv(), ctx, {})).text(),
    await (await handle(req('/_stock/3/jNQXAC9IVRw', DISCORD), fakeEnv(), ctx, {})).text(),
  ])
  assert.ok(v2.includes('json+oembed') && !v2.includes('activity+json'), 'v2: oEmbed only')
  assert.ok(v3.includes('json+oembed') && v3.includes('activity+json'), 'v3: both')
  for (const h of [v2, v3]) {
    assert.ok(h.includes('twitter:player" content="https://www.youtube.com/embed/'),
      'every variant keeps the player — the links are the only variable')
  }
})

test('A STOCK PASTE BY A HUMAN GOES TO YOUTUBE, AND A FAILED OEMBED STILL RENDERS', async () => {
  const human = await stockServing(() =>
    handle(req('/_stock/1/jNQXAC9IVRw', 'Mozilla/5.0 (Macintosh) Safari/605.1'), fakeEnv(), ctx, {}))
  assert.equal(human.status, 302)
  assert.equal(human.headers.get('location'), 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
  // The title fetch failing must not fail the experiment — a static fallback is the answer.
  const res = await stockServing(() => handle(req('/_stock/1/jNQXAC9IVRw', DISCORD), fakeEnv(), ctx, {}),
    { oembed: 'throw' })
  assert.equal(res.status, 200)
  assert.ok((await res.text()).includes('YouTube video'), 'the static title stands in')
})

test('A MALFORMED STOCK PATH NEVER REACHES THE EXPERIMENT', async () => {
  // 10 chars, 12 chars, a bad variant — each must fall through to ordinary routing rather than
  // render an experiment head for an id that is not a YouTube id.
  for (const path of ['/_stock/1/shortid123', '/_stock/1/twelvechars12', '/_stock/9/jNQXAC9IVRw']) {
    const res = await stockServing(() => handle(req(path, DISCORD), fakeEnv(), ctx, {}))
    const h = await res.text()
    assert.ok(!h.includes('stock-player experiment'), `${path} must not render the experiment`)
  }
})

test('A SLIDESHOW IS UNTOUCHED — one hop already, and it must cost no extra fetch', async () => {
  // MUST NOT BREAK. Slideshows are the arm that already renders the activity card correctly, so
  // the fix must be invisible to them: their images are not aweme urls and nothing may probe.
  const { net, serving } = ttNetwork({ page: readFileSync('test/fixtures/tiktok-slideshow.html', 'utf8') })
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const key = encodeURIComponent(refKey({ p: 'tt', id: '7663591047909379341' }))
  const locs = await serving(async () => {
    const out = []
    for (const i of [0, 1, 2]) {
      const m = await handle(req(`/_media/${key}/${i}`, DISCORD), fakeEnv(), ctx, deps)
      assert.equal(m.status, 302)
      out.push(m.headers.get('location'))
    }
    return out
  })
  assert.equal(net.aweme, 0, 'a photo post must never touch the aweme endpoint')
  assert.equal(net.page, 1)
  // Distinct images, each on TikTok's image CDN, exactly as before the fix.
  assert.equal(new Set(locs).size, 3, 'three slides, three urls — the gallery must not collapse')
  for (const l of locs) assert.ok(l.startsWith('https://'), l)
})

test('BLUESKY NEVER REACHES THE RESOLVER — it has no playable video at all', async () => {
  // MUST NOT BREAK, and proven structurally rather than by inspection. Two independent claims:
  //
  // (a) The resolution is inside liveFetchPost's `case 'tt'`, so a bs ref cannot reach it. Driven
  //     through the real dispatch with a counted network: exactly ONE request, to bsky, and
  //     nothing resembling an aweme url.
  // (b) Even if it could, there would be nothing to resolve: Bluesky's normalizer downgrades an
  //     HLS `playlist` to a still (bluesky/normalize.ts:52-59), so no bs Post ever carries a
  //     `kind: 'video'` Media. Asserted on the real fixture, so the day someone adds HLS support
  //     this test fails and the interaction gets thought about deliberately.
  const raw = JSON.parse(readFileSync('test/fixtures/bluesky-post.json', 'utf8'))
  const urls = []
  const real = globalThis.fetch
  let post
  try {
    globalThis.fetch = async url => {
      urls.push(String(url))
      return new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } })
    }
    post = await liveFetchPost({ p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }, fakeEnv(), 'discord')
  } finally {
    globalThis.fetch = real
  }

  assert.equal(urls.length, 1, `a bs post must cost exactly one fetch, got ${JSON.stringify(urls)}`)
  assert.ok(!urls[0].includes('aweme'), 'and never the aweme endpoint')
  assert.ok(!urls[0].includes('tiktok'), 'and never tiktok.com at all')
  if (post) {
    for (const m of post.media) {
      assert.notEqual(m.kind, 'video', 'a bs Post must carry no playable video — HLS is downgraded to a still')
    }
  }
})

// ---------------------------------------------------------------------------
// Instagram dispatch. liveFetchPost's `default` arm swallowed `ig`, so a correct
// fetcher and a correct normalizer would still have rendered "could not fetch
// post" — the same one line that made TikTok's fetcher invisible in Phase 3a, and
// the reason platform dispatch gets tests at the surface that ships rather than
// being assumed to follow from the two pure halves passing.
// ---------------------------------------------------------------------------

const IG_POST = '/p/DaQ5CPTki4E'

/**
 * A MIXED post — one image, one video WITH a poster — because the poster is the half that has no
 * TikTok precedent to inherit. Measured 2026-07-19: Discord asks for the poster, receives mp4
 * bytes, and abandons the rich activity card for the plain OpenGraph one, losing the avatar row
 * and the caption. `Media.poster` is the mechanism that fixes it and it was already built, tested
 * and live before Instagram existed here; these tests prove an `ig` post REACHES it.
 *
 * A factory rather than a shared constant: handle() hands the object to the renderer and to the
 * cache layer, and a test that mutated it would silently poison every later one.
 */
const igPost = () => ({
  ref: { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' },
  canonical: 'https://www.instagram.com/p/DaQ5CPTki4E/',
  author: { name: 'Someone', handle: 'someone', url: 'https://www.instagram.com/someone/' },
  text: 'a caption', createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [
    { kind: 'image', url: 'https://scontent.cdninstagram.com/a.jpg', w: 1080, h: 1080 },
    {
      kind: 'video', url: 'https://scontent.cdninstagram.com/b.mp4', w: 720, h: 1280,
      poster: 'https://scontent.cdninstagram.com/b.jpg',
    },
  ],
  counts: { likes: 5 }, sensitive: false,
})

test('an Instagram post reaches the renderer as an ig post, leaking no CDN url', async () => {
  const post = igPost()
  const res = await handle(req(IG_POST, DISCORD), fakeEnv(), ctx, {
    cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }),
  })
  const html = await res.text()
  assert.equal(res.status, 200)
  // Global constraint, and it is not decorative on this platform: Instagram's CDN urls carry a
  // signed `oe=` expiry, so a leaked one is BOTH a privacy leak and a link that dies on its own
  // schedule rather than ours. Every media url a client sees must be on our own origin.
  assert.ok(!html.includes('cdninstagram'), 'a raw CDN url must never reach a client')
  assert.ok(!html.includes('scontent'), 'nor any other raw CDN host')
  // The spoof callback id encodes the ref exactly, so this proves the IG post — not a failure
  // embed, not a chooser — is what got rendered.
  assert.match(html, new RegExp(`statuses/${encodeStatusId(refKey(post.ref))}`))
  assert.ok(!/couldn't load/i.test(html), 'the dispatch must not fall through to fetch_fail')
})

test('/_media/ resolves an Instagram image AND its video poster with 302s, never a proxy', async () => {
  const post = igPost()
  const deps = {
    cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  const key = encodeURIComponent(refKey(post.ref))

  const img = await handle(req(`/_media/${key}/0`), fakeEnv(), ctx, deps)
  assert.equal(img.status, 302)
  assert.equal(img.headers.get('location'), 'https://scontent.cdninstagram.com/a.jpg')
  assert.match(img.headers.get('cache-control'), /max-age=300/)

  // THE POSTER ROUTE, already built and already tested — this proves ig reaches it. If this ever
  // returns the mp4, Discord draws the plain OpenGraph card and the whole rich embed degrades.
  const poster = await handle(req(`/_media/${key}/poster1`), fakeEnv(), ctx, deps)
  assert.equal(poster.status, 302)
  assert.equal(poster.headers.get('location'), 'https://scontent.cdninstagram.com/b.jpg',
    'poster{N} must resolve to the IMAGE, never the mp4')
})

test('an Instagram fetch failure degrades: error embed for a crawler, 302 for a human', async () => {
  // The path that must keep working AFTER the dispatch exists: a dispatched platform whose post
  // is genuinely not there still degrades, rather than crashing or rendering a hollow embed.
  const bad = {
    cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  assert.match(await (await handle(req(IG_POST, DISCORD), fakeEnv(), ctx, bad)).text(), /may be private, removed, or unavailable/i)
  const human = await handle(req(IG_POST), fakeEnv(), ctx, bad)
  assert.equal(human.status, 302)
  assert.equal(human.headers.get('location'), 'https://www.instagram.com/p/DaQ5CPTki4E/')
})

// NO "liveFetchPost dispatches ig" TEST HERE, and its absence is deliberate rather than an
// oversight. The plan's Task 5 list specified one, but the body it specified contained no ig ref
// at all — it iterated th/rd/x and was a verbatim duplicate of the sibling test above, which
// already asserts those three AND already carries the note about why `ig` left that list. A test
// whose title claims a behaviour its body never exercises is worse than no test: it reads as
// coverage. The ig dispatch is genuinely covered, by the seam and request-count tests below.

test('THE DECOY LANDS IN assert_fail, distinguishably from a post that is simply gone', async () => {
  // The counter half of Task 4's split. Without it, "Instagram flipped the UA gate" and "people
  // are pasting dead links" emit byte-identical analytics — and the decoy is an HTTP 200, so
  // nothing else would ever reveal it.
  const real = globalThis.fetch
  try {
    const run = async body => {
      globalThis.fetch = async () => new Response(body, { status: 200 })
      const env = fakeEnv()
      await liveFetchPost({ p: 'ig', kind: 'p', code: 'ABC' }, env, 'discord')
      return env.points.filter(p => p.blobs[0] === 'ig').map(p => p.blobs[1])
    }
    const decoy = await run(readFileSync('test/fixtures/instagram-decoy.html', 'utf8'))
    assert.ok(decoy.includes('assert_fail'), 'the 599KB decoy must be assert_fail')

    const gone = await run(readFileSync('test/fixtures/instagram-gone.html', 'utf8'))
    // A page with no payload at all is also assert_fail — which is correct and worth pinning:
    // Instagram does not distinguish "gone" from "shell" on this endpoint, so we do not invent
    // a distinction we cannot observe. Recorded here so nobody later "fixes" it into fetch_fail.
    assert.ok(gone.includes('assert_fail'))
  } finally {
    globalThis.fetch = real
  }
})

test('counters attribute the platform, so ig traffic is visible separately', async () => {
  const env = fakeEnv()
  await handle(req(IG_POST, DISCORD), env, ctx, {
    cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }),
  })
  assert.ok(env.points.some(p => p.blobs[0] === 'ig' && p.blobs[1] === 'fetch_fail'))
})

test('A REAL INSTAGRAM PAGE BECOMES A POST — the fetch->normalize seam, not just its failure half', async () => {
  // REGRESSION THIS PREVENTS, and it is the identical hole TikTok's sibling test was written to
  // close: every other test on this dispatch injects a `fetchPost` stub or exercises a FAILURE
  // branch, so `return normalizeInstagram(got.html, ref)` — the entire point of this task — would
  // be held by nothing. Replacing that one line with `return null` typechecks clean and passes the
  // whole suite otherwise, i.e. an implementation in which EVERY real Instagram post renders
  // the generic "couldn't load" failure is indistinguishable from a working one.
  //
  // Stubbing globalThis.fetch rather than the fetcher module is deliberate: the thing under test
  // is precisely that a real page body travels from fetchInstagram into normalizeInstagram intact.
  const real = globalThis.fetch
  try {
    const run = async (fixture, ref) => {
      globalThis.fetch = async () => new Response(readFileSync(`test/fixtures/${fixture}`, 'utf8'), { status: 200 })
      const env = fakeEnv()
      const post = await liveFetchPost(ref, env, 'discord')
      return { post, ig: env.points.filter(p => p.blobs[0] === 'ig').map(p => p.blobs[1]) }
    }

    // THE REEL: the blob path. Asserting on CONTENT — the child count and the kind — not on a
    // shape, so a mutant returning a hollow-but-well-typed Post cannot pass.
    const reel = await run('instagram-reel.html', { p: 'ig', kind: 'p', code: 'Da5ynsiuAZ_' })
    assert.ok(reel.post, 'a real Instagram reel page must produce a Post, not null')
    assert.equal(reel.post.media.length, 1)
    assert.equal(reel.post.media[0].kind, 'video')
    // Fact 7: the poster is what keeps Discord on the rich activity card, and a video that
    // arrives here without one is the whole bug this platform's media work exists to avoid.
    assert.ok(reel.post.media[0].poster, 'a video must carry a poster all the way through dispatch')
    // A page that answered is NOT a page failure. If a success ever counted assert_fail, the
    // counter would stop meaning "Instagram changed" and the split Task 4 paid for is worthless.
    assert.deepEqual(reel.ig, [], 'a page that answered must emit no failure counter')

    // THE SINGLE IMAGE: the MARKUP path, which has no blob at all. Both extraction paths have to
    // survive the trip through the fetcher, and only one of them would if the seam read the blob.
    const single = await run('instagram-single.html', { p: 'ig', kind: 'p', code: 'C79gQqLpkul' })
    assert.ok(single.post, 'a single-image page must produce a Post too')
    assert.deepEqual([...new Set(single.post.media.map(m => m.kind))], ['image'])
    assert.deepEqual(single.ig, [])

    // THE MIXED CAROUSEL: ten children, four of them video. This is the fixture that catches
    // upstream's `__typename` bug — embed children carry no `__typename`, so a discriminator
    // reading it labels every carousel VIDEO as an image and nothing looks broken.
    const carousel = await run('instagram-carousel.html', { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' })
    assert.ok(carousel.post, 'a mixed carousel must produce a Post')
    assert.equal(carousel.post.media.length, 10)
    assert.equal(carousel.post.media.filter(m => m.kind === 'video').length, 4,
      'is_video, never __typename — embed children carry no __typename at all')
    assert.deepEqual(carousel.ig, [])
  } finally {
    globalThis.fetch = real
  }
})

test('an ig post costs exactly ONE upstream fetch — there is no video-resolution hop to pay', async () => {
  // THE ABSENCE OF withResolvedVideo IS A DELIBERATE FACT, so it gets an assertion rather than a
  // comment. TikTok pays a SECOND request per video post because its playable url is itself a 302
  // and Discord seeing two hops costs the rich activity card. Instagram's video_url is a direct
  // CDN url at zero hops (verified 2026-07-19: 6,887,308 bytes, h264/aac 720x1280, cookie-free),
  // so there is nothing to collapse.
  //
  // REGRESSION THIS PREVENTS: a genuinely ADDED upstream fetch on this path — a poster download,
  // a HEAD probe, a second page request. That is the whole of it, and the scope is worth stating
  // because an earlier version of this comment claimed more. It does NOT catch a copied
  // `case 'tt'`; the test below proves that mutation is a behavioural no-op costing zero fetches,
  // so no request count could ever see it. Do not cite this test as protection against the copy.
  const urls = []
  const real = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      urls.push(String(url))
      return new Response(readFileSync('test/fixtures/instagram-reel.html', 'utf8'), { status: 200 })
    }
    await liveFetchPost({ p: 'ig', kind: 'p', code: 'Da5ynsiuAZ_' }, fakeEnv(), 'discord')
  } finally {
    globalThis.fetch = real
  }
  assert.equal(urls.length, 1, `a reel must cost exactly one fetch, got ${JSON.stringify(urls)}`)
  assert.ok(urls[0].includes('/embed/captioned/'), 'and it must be the embed endpoint')
})

test('A COPYRIGHT-BLOCKED REEL FALLS BACK TO THE ACCOUNT FEED WHEN THE SHORTCODE QUERY CANNOT ANSWER', async () => {
  /**
   * The defect: instagram.com/reel/DbN6SsKum-9/ is a video that rendered as a PHOTO, because the
   * embed serializer omits video_url for rights-struck audio. This pins the WIRING — the pure halves
   * are covered in instagram-copyright.test.mjs; what can only break here is the worker arm.
   *
   * REWRITTEN 2026-08-02, when the shortcode GraphQL query became the first recovery. This used to
   * assert "blocked reel = embed + feed, exactly 2 fetches", which was the whole chain at the time.
   * There are now three tiers, so the count moved to 3 — and the assertion that matters is not the
   * NUMBER but the ORDER and the SCOPING, both of which are kept below. The GraphQL tier refusing is
   * simulated here rather than mocked away, so this doubles as the fallback path's wiring test.
   */
  const urls = []
  const real = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      urls.push(String(url))
      if (String(url).includes('/graphql/query/')) {
        // A refusal at HTTP 200, which is what this surface actually does.
        return new Response('{"data":null}', { status: 200 })
      }
      const body = String(url).includes('/api/v1/feed/user/')
        ? readFileSync('test/fixtures/instagram-user-feed.json', 'utf8')
        : readFileSync('test/fixtures/instagram-copyright-blocked.html', 'utf8')
      return new Response(body, { status: 200 })
    }
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DbN6SsKum-9' }, fakeEnv(), 'discord')
    assert.equal(post.media[0].kind, 'video', 'the whole point: it renders as a video again')
    assert.ok(post.media[0].poster, 'and keeps a poster, without which Discord drops the rich card')
  } finally {
    globalThis.fetch = real
  }
  assert.equal(urls.length, 3, `blocked reel = embed + graphql + feed, got ${JSON.stringify(urls)}`)
  assert.ok(urls[0].includes('/embed/captioned/'), 'the embed is still FIRST and still primary')
  assert.ok(urls[1].includes('/graphql/query/'), 'the cheap shortcode query is tried before the walk')
  // The handle comes off the PARSED payload, not the ref — pinned so a refactor that passes the
  // shortcode here (which the feed endpoint would happily 200 on, with the wrong account's posts)
  // is caught rather than silently serving a stranger's video.
  assert.ok(urls[2].includes('/api/v1/feed/user/fixture_user_10/'), `the feed must be scoped to the OWNER, got ${urls[2]}`)
})

test('A PUBLIC POST WHOSE EMBED FAILED IS NOT PRIVATE — the false 🔒, end to end', async () => {
  /**
   * Reported 2026-07-26: /reel/DZghoo7PAzi/ (public, @fixture8.example) rendered "This post is private"
   * on the live apex. The parser was never wrong — the ORDER was: the embed failed from datacenter
   * egress, and instagramPrivateGate ("a username with no data-media-type") found that shape true of
   * a public post. This pins the ordering fix, which is the part a unit test cannot see.
   */
  const urls = []
  const real = globalThis.fetch
  let post
  try {
    globalThis.fetch = async url => {
      urls.push(String(url))
      const u = String(url)
      const body = u.includes('/embed/captioned/') ? readFileSync('test/fixtures/instagram-embed-shell.html', 'utf8')
        : u.includes('/api/v1/feed/user/') ? readFileSync('test/fixtures/instagram-user-feed-datsun.json', 'utf8')
          : readFileSync('test/fixtures/instagram-fullpage-public.html', 'utf8')
      return new Response(body, { status: 200 })
    }
    post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DZghoo7PAzi' }, fakeEnv(), 'discord')
  } finally {
    globalThis.fetch = real
  }
  assert.ok(post, 'a public post must not come back null')
  assert.equal(post.author.handle, 'fixture8.example')
  assert.match(post.text, /You had to PAY to be in this meet/)
  // And the feed recovery rides along, because og:url gave us the handle to ask with.
  assert.equal(post.media[0].kind, 'video', 'the reel plays, rather than rendering a 🔒')
  assert.ok(urls.some(u => u.includes('/api/v1/feed/user/fixture8.example/')), 'feed scoped to the OWNER')
})

test('A REFUSED FEED NOW HANDS THE PAGE TO THE CONTAINER, still carrying the cover as its poster', async () => {
  /**
   * REWRITTEN 2026-08-02. This pinned "a refused feed leaves exactly today's cover-still card", which
   * was the right guarantee while the user feed was the only recovery there was: every measurement
   * behind it is residential, so degrading to the still was what made shipping it defensible.
   *
   * WHAT CHANGED. The feed is ACCOUNT-scoped and Instagram serves 12 items whatever `count` asks for,
   * so a blocked reel further back than that was unrecoverable by it — reported on /reel/DX7byl-oyGR/,
   * ~60 posts deep, which instagram7 played and we drew as a photo. Paging to it measured five
   * sequential requests and 2.45 MB. yt-dlp resolves the same reel by URL in one request, cookie-free,
   * at a better rendition, and the container that does it is already how YouTube and Facebook work.
   *
   * So a refused or exhausted feed is no longer the end of the line. The GUARANTEE the old test
   * existed to protect is unchanged and is asserted below: the cover still survives as the poster, so
   * a card drawn before the mux lands — or one where the container is absent or refuses — is exactly
   * the picture we shipped before, never a posterless video and never an error.
   */
  const real = globalThis.fetch
  try {
    globalThis.fetch = async url => String(url).includes('/api/v1/feed/user/')
      ? new Response('{"message":"login_required","status":"fail"}', { status: 403 })
      : new Response(readFileSync('test/fixtures/instagram-copyright-blocked.html', 'utf8'), { status: 200 })
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DbN6SsKum-9' }, fakeEnv(), 'discord')

    assert.equal(post.media.length, 1, 'still exactly one piece of media')
    assert.equal(post.media[0].kind, 'video', 'the page goes to the container instead of giving up')
    assert.ok(post.media[0].remux?.page?.startsWith('https://www.instagram.com/'),
      'addressed BY THE POST, which is why the 12-item window cannot apply to it')
    assert.ok(post.media[0].poster, 'and the cover rides along as the poster')
    assert.equal(post.author.name, 'fixture_user_10', 'the rest of the card is untouched')
  } finally {
    globalThis.fetch = real
  }
})

test('THE REMUXED BLOCKED REEL CARRIES THE STILL\'S SIZE, or every degrade draws a blank card', async () => {
  /**
   * The degrade paths — withResolver on a Worker with no container, and settleMux when the mux loses
   * its race — both rebuild the cover as `{ kind: 'image', w: posterW ?? w }`. A remux video's own w/h
   * are deliberately 0, so WITHOUT posterW/posterH that reconstruction is a 0x0 image; mastodon.ts
   * omits meta.original when the size is unknown, and Discord draws no picture at all.
   *
   * So the consequence of dropping these is not a slightly wrong card, it is a BLANK one — on exactly
   * the deploys and races where the still is the only thing left. This project has already shipped
   * that bug once, on the degraded-still slot, which is why it is pinned here rather than trusted.
   */
  const real = globalThis.fetch
  try {
    globalThis.fetch = async url => String(url).includes('/api/v1/feed/user/')
      ? new Response('{"message":"login_required","status":"fail"}', { status: 403 })
      : new Response(readFileSync('test/fixtures/instagram-copyright-blocked.html', 'utf8'), { status: 200 })
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DbN6SsKum-9' }, fakeEnv(), 'discord')
    const m = post.media[0]

    assert.equal(m.kind, 'video')
    assert.equal(m.w, 0, "the video's own size is unknown until the container reports it")
    assert.ok(m.posterW > 0 && m.posterH > 0,
      `the still's real size rides along for the degrade (got ${m.posterW}x${m.posterH})`)
  } finally {
    globalThis.fetch = real
  }
})

test('A HEALTHY REEL NEVER TOUCHES THE FEED — the gate is what keeps this off the hot path', async () => {
  // The recovery costs ~500KB. instagramCopyrightBlocked being false on healthy posts is the ONLY
  // thing standing between that and every Instagram unfurl we serve, so it is pinned at the wiring
  // level too and not just as a unit test of the predicate.
  const urls = []
  const real = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      urls.push(String(url))
      return new Response(readFileSync('test/fixtures/instagram-reel.html', 'utf8'), { status: 200 })
    }
    await liveFetchPost({ p: 'ig', kind: 'p', code: 'Da5ynsiuAZ_' }, fakeEnv(), 'discord')
  } finally {
    globalThis.fetch = real
  }
  assert.ok(!urls.some(u => u.includes('/api/v1/feed/user/')), `no feed fetch on a healthy reel, got ${JSON.stringify(urls)}`)
})

test('a copied `case tt` is a NO-OP on Instagram media — which is why no request count can catch it', async () => {
  // WHY THIS TEST EXISTS: three places (worker.ts's ig arm, the request-count test above, and
  // this task's commit message) once claimed the count-of-one test catches a copied `case 'tt'`.
  // It does not. Rather than delete the claim and leave the next reader to re-derive the truth,
  // the truth gets pinned — a comment asserting a mechanism is exactly the thing that rots.
  //
  // REGRESSION THIS PREVENTS: someone "hardening" the ig arm by appending TikTok's
  // `? await withResolvedVideo(post) : null` and believing the suite vouches for the difference.
  // It cannot: withResolvedVideo bails at `if (i < 0) return post` unless a video url contains
  // AWEME_PLAY, and an Instagram scontent url never does — so the mutant is byte-identical output
  // at zero added fetches. It is also, therefore, not a defect; the wholesale copy (fetchTikTok
  // on an ig ref) is the one that is genuinely wrong, and the TYPECHECKER rejects it with TS2345.
  //
  // If Instagram ever DID start serving a redirecting play endpoint, the video-url assertion here
  // is what fails first, and this comment stops being true in a visible way.
  const post = normalizeInstagram(readFileSync('test/fixtures/instagram-reel.html', 'utf8'), { p: 'ig', kind: 'p', code: 'Da5ynsiuAZ_' })
  assert.equal(post.media[0].kind, 'video')
  // Asserting on CONTENT — the actual url — never on a shape. This is the load-bearing fact.
  assert.ok(!post.media[0].url.includes(AWEME_PLAY),
    `an Instagram video url must not look aweme-shaped, got ${post.media[0].url}`)

  let fetches = 0
  const real = globalThis.fetch
  let out
  try {
    globalThis.fetch = async () => { fetches++; throw new Error('withResolvedVideo must not fetch here') }
    out = await withResolvedVideo(post)
  } finally {
    globalThis.fetch = real
  }
  assert.equal(fetches, 0, 'withResolvedVideo must cost ZERO fetches on Instagram media')
  // Same object back, not merely an equal one: this is why reference identity is also useless as
  // a guard against the copy, which is worth pinning so nobody proposes it as the fix again.
  assert.equal(out, post, 'withResolvedVideo must hand back the very same Post it was given')
})

test('a TEN-item mixed carousel survives to media_attachments — past the >4 gallery ceiling', async () => {
  // REGRESSION THIS PREVENTS: silent truncation or type-collapse of a gallery larger than any the
  // suite previously asserted. Before Instagram, the highest media_attachments count asserted
  // ANYWHERE in this suite was 4 — media.ts records why (Bluesky caps at 4, so <=4 used to be
  // structurally guaranteed, and only a 4-image post quoting a 4-image post reached 8). A
  // carousel is the ordinary shape of Instagram, so this dispatch makes >4 routine production
  // output; shipping that with no end-to-end assertion is how a cap or an off-by-one added later
  // reaches clients invisibly, since a truncated gallery still renders a perfectly valid embed.
  //
  // At the DISPATCH SEAM with the real fixture, deliberately: mastodon.ts's own mixed-gallery
  // unit tests (and the og:video-index question, which is the interesting one on a carousel whose
  // first video sits at position 3) belong to the mixed-gallery task. This pins only that the
  // count and the interleaving survive the whole trip, which is what THIS commit changed.
  const real = globalThis.fetch
  let post
  try {
    globalThis.fetch = async () => new Response(readFileSync('test/fixtures/instagram-carousel.html', 'utf8'), { status: 200 })
    post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' }, fakeEnv(), 'discord')
  } finally {
    globalThis.fetch = real
  }
  const st = toMastodonStatus(post, 'https://example.com')

  assert.equal(st.media_attachments.length, 10, 'all ten children must reach media_attachments')
  // FLATTENED TO ONE TYPE, 2026-07-20. This assertion used to pin the exact interleaving
  // image,image,video,image,video,… — which is precisely the array a real Discord client was then
  // measured rendering SIX of: it keeps the type of the first attachment and silently discards the
  // rest, so the four videos drew as nothing. The wire was correct and the consumer could not read
  // it. See galleryHasVideo() in mastodon.ts for the evidence and the reasoning.
  //
  // The DISCRIMINATOR is still under test, just not here: the normalizer's kinds are asserted at
  // the normalize seam above ("4 videos"), which is where the __typename regression this line used
  // to guard would actually show up. Flattening at the renderer cannot hide it, because a
  // normalizer that labelled every video an image would produce a gallery that is not mixed at all
  // and would leave those four children pointing at mp4s.
  assert.deepEqual(st.media_attachments.map(a => a.type),
    ['image', 'image', 'image', 'image', 'image', 'image', 'image', 'image', 'image', 'image'],
    'a mixed gallery must be flattened, or Discord draws only the images')
  // Positional identity: attachment i must address media i, all ten of them. This is the assertion
  // that catches a REORDERING or a dropped child, which the type array no longer can now that
  // every entry says the same thing.
  assert.deepEqual(st.media_attachments.map(a => a.id), ['0','1','2','3','4','5','6','7','8','9'])
  // The four former videos address their POSTERS, and never the mp4 — pointing an image attachment
  // at video bytes is the defect fixed on 2026-07-19, and the conversion is exactly where it would
  // come back.
  for (const i of [2, 4, 6, 8]) {
    assert.ok(st.media_attachments[i].url.endsWith(`/poster${i}`),
      `converted attachment ${i} must address its own poster, got ${st.media_attachments[i].url}`)
  }
  // Never proxy, never leak: every url is ours, and no scontent/cdninstagram host escapes. The
  // ceiling is exactly where a hand-rolled "just cap it" patch would be tempted to special-case.
  for (const a of st.media_attachments) {
    assert.ok(a.url.includes('/_media/'), `attachment ${a.id} must be an origin /_media/ url, got ${a.url}`)
    assert.ok(!/cdninstagram|scontent/.test(a.url), `attachment ${a.id} must not leak the CDN host`)
  }
})

// ---------------------------------------------------------------------------
// INSTAGRAM END TO END, THROUGH THE REAL FIXTURES, WITH NO NETWORK.
//
// Everything above this line either injects a hand-written `igPost()` (a two-entry synthetic that
// exists to prove the DISPATCH) or stops at `liveFetchPost` and inspects the Post. Neither can see
// a SEAM: a wire format two modules spell differently — the normalizer's `poster` versus the
// router's `poster{N}` segment, `refKey`'s colons versus `/_media/`'s percent-encoding, the
// canonical the normalizer mints versus the one the router assumed. Those only fail where a real
// payload meets the real request path, which is exactly this block: real fixture -> real
// normalizer -> real router -> real renderer -> real media route.
//
// Fixture codes are the REAL ones the captures were taken from (the plan carries REPLACE_*
// placeholders), so the assertions below are about payloads that actually exist.
// ---------------------------------------------------------------------------

/**
 * A real captured embed page through the real normalizer.
 *
 * NOT named `igPost` as the plan spells it — that name is already a synthetic factory in this file
 * (the mixed two-entry post the dispatch tests use), and shadowing it would silently retarget every
 * test above at a fixture, or vice versa.
 *
 * `kind: 'p'` for the reel too, and that is not a shortcut: router.ts's instagram() mints `kind:'p'`
 * for EVERY surface (/p/, /reel/, /reels/, /tv/) precisely so one post has one cache key. Passing
 * the ref the router would actually build is what makes these end-to-end rather than hypothetical.
 */
const igFixture = (name, code) =>
  normalizeInstagram(readFileSync(`test/fixtures/instagram-${name}.html`, 'utf8'), { p: 'ig', kind: 'p', code })

const IG_CAROUSEL = 'DaQ5CPTki4E'
const IG_REEL = 'Da5ynsiuAZ_'
const IG_SINGLE = 'C79gQqLpkul'
/** Every test below injects the post, so the resolver is never consulted — but Deps requires it. */
const igDeps = post => ({
  cache: fakeCache(),
  fetchPost: async () => post,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
})

/**
 * Deps that RECORD the ref the router decoded, so the spoof {id} round trip is observable.
 *
 * `igDeps`'s `async () => post` discards its argument and hands back the right post no matter what
 * came out of parseRefKey, which makes the decode seam invisible — PROVEN by mutation on
 * 2026-07-20: corrupting parseRefKey's ig arm to `code: dec(p[2]) + 'X'` left all 66 tests in this
 * file green, while in production the callback and every /_media/ url 404 ("Record not found") and
 * the whole gallery silently degrades to a plain card. Only `deepEqual(seen, post.ref)` sees it.
 *
 * Takes the cache per call because the callback MUST be driven on a COLD one: sharing the head
 * render's cache serves the callback out of the post cache without ever reaching fetchPost, leaving
 * `seen` null and the decode unobserved again. Discord's callback is a separate request that may
 * well land on a different colo with nothing warm anyway.
 */
const igWatchingDeps = post => {
  const box = { seen: null }
  box.deps = cache => ({
    cache,
    fetchPost: async ref => { box.seen = ref; return post },
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  })
  return box
}

/**
 * The callback url the rendered head ADVERTISES, pulled back out of the head itself.
 *
 * Never an id this file mints with encodeStatusId: that only proves decode inverts this file's own
 * encode, and cannot see the renderer advertising a third spelling that nothing ever decodes. The
 * `/users/{handle}/statuses/{id}` shape is also the one Discord actually sends — `/api/v1/statuses/
 * {id}` routes to the same 'activity' arm but is not a request any crawler makes.
 */
const advertisedCallback = head =>
  (head.match(/https:\/\/staging\.megapenispoopenfarten\.sex(\/users\/[^"]*\/statuses\/[^"]*)/) || [])[1]

/**
 * Every Instagram CDN host, as one pattern, for "no raw CDN url in ANY output".
 *
 * Broader than the `cdninstagram` substring the plan spelled, deliberately. Every host in all three
 * captures today is *.cdninstagram.com (scontent-bos5-1 and static), so the narrow form happens to
 * be sufficient — but scontent-*.fbcdn.net is the same CDN under Facebook's domain and a fixture
 * recaptured tomorrow may well carry it, at which point the narrow assertion passes on a real leak.
 */
const IG_CDN = /cdninstagram|scontent|fbcdn/

test('REAL FIXTURE: a mixed carousel becomes a gallery, all on our own origin', async () => {
  // The activity callback is where Discord actually reads the gallery from, and it is a DIFFERENT
  // renderer from the head — toMastodonStatus, reached through the spoof {id} round trip rather
  // than called directly. A media_attachments assertion on the unit alone cannot see the two seams
  // in between: encodeStatusId/decodeStatusId, and the router's `activity` arm rebuilding the ref.
  //
  // Driven the way the TikTok slideshow test above drives it, and NOT the way the plan spelled it.
  // The plan minted the id here with encodeStatusId and injected `async () => post`; that form
  // makes the very claim in the paragraph above FALSE, because it discards the decoded ref and
  // cannot fail on a broken decode. See igWatchingDeps for the mutation that proved it.
  const post = igFixture('carousel', IG_CAROUSEL)
  const w = igWatchingDeps(post)
  const head = await (await handle(req(`/p/${post.ref.code}`, DISCORD), fakeEnv(), ctx, w.deps(fakeCache()))).text()
  const advertised = advertisedCallback(head)
  assert.ok(advertised, 'the spoof head must advertise a statuses callback at all')
  assert.equal(advertised, `/users/${post.author.handle}/statuses/${encodeStatusId(refKey(post.ref))}`)

  w.seen = null
  const res = await handle(req(advertised, DISCORD), fakeEnv(), ctx, w.deps(fakeCache()))
  // THE ROUND TRIP, closed: renderer -> encodeStatusId -> {id} segment -> decodeStatusId ->
  // parseRefKey -> the ref fetchPost is asked for. `deepEqual`, not "is an ig ref": the failure
  // this catches is a ref that is perfectly well-formed and points at the wrong post.
  assert.deepEqual(w.seen, post.ref, 'the callback must decode to the post it advertises, not merely to A valid ig ref')

  // Exact equality, no charset: a JSON consumer handed anything else is the failure mode, and
  // Response.json's exact spelling was verified against live FxEmbed output (spec §6c).
  assert.equal(res.headers.get('content-type'), 'application/json')
  const json = await res.json()
  assert.equal(json.media_attachments.length, post.media.length, 'every child must survive the trip')
  assert.ok(json.media_attachments.length >= 2)
  // The real carousel HAS videos in it — four of them — and every one of them now ships as an
  // IMAGE attachment addressing its poster, because Discord renders only the type of the FIRST
  // attachment and measurably discarded these four (2026-07-20). The discriminator regression this
  // pair of assertions used to guard (`__typename`, which embed children do not carry) is caught at
  // the normalize seam instead, on post.media, where it originates.
  assert.equal(post.media.filter(m => m.kind === 'video').length, 4, 'the real carousel HAS videos in it')
  assert.ok(json.media_attachments.every(a => a.type === 'image'),
    'and every one of them reaches the viewer as an image, rather than not at all')
  const key = encodeURIComponent(refKey(post.ref))
  json.media_attachments.forEach((a, i) => {
    // FULL urls — origin and index — not a `/_media/ig%3Ap%3A` substring. A hardcoded prod origin
    // in embed.ts is invisible to a path-only match, and every attachment collapsing to /0 is a
    // ten-item gallery of one item. Same reasoning the TikTok slideshow test records.
    //
    // A CONVERTED VIDEO ADDRESSES ITS POSTER; an image addresses itself. Branching on the SOURCE
    // media's kind rather than on the emitted type, deliberately: after flattening every attachment
    // says "image", so `a.type` can no longer tell the two cases apart and a branch on it would
    // silently stop checking the four entries this test most needs to check.
    //
    // Pinned to THIS attachment's own index, not `/poster\d+$/`. The loose pattern accepts every
    // video pointing at poster0 — PROVEN by mutation: `posterUrl(post, origin, m, 0)` in
    // mastodon.ts left this whole file green while emitting four videos all pointing at poster0,
    // which on this carousel is an IMAGE child with no poster and 404s. Under the flattening that
    // mutation is strictly worse than it was: poster0 is now the attachment's `url`, so all four
    // former videos would render as the same broken image rather than merely previewing as one.
    const want = post.media[i].kind === 'video'
      ? `https://staging.megapenispoopenfarten.sex/_media/${key}/poster${i}`
      : `https://staging.megapenispoopenfarten.sex${mediaRef(post.ref, i)}`
    assert.equal(a.url, want, `attachment ${a.id} must address media ${i} on OUR origin`)
    // An image is its own poster, and a converted video now is too — so preview_url tracks url for
    // every entry in a flattened gallery. preview_url = the video file is the MEASURED defect
    // (2026-07-19): Discord asks for the poster, gets mp4 bytes, and abandons the rich activity
    // card for the plain OpenGraph one.
    assert.equal(a.preview_url, want, `attachment ${a.id} must preview its OWN poster`)
    assert.ok(!/\.mp4/.test(a.url + a.preview_url), `attachment ${a.id} must never address video bytes`)
  })
  // NO RAW CDN URL IN ANY OUTPUT — the whole body, not just `url`. preview_url, the avatar and the
  // meta block are all url-bearing, and a per-field check leaves each new field unguarded by
  // default. Instagram CDN urls carry a signed `oe=` expiry, so a leaked one is both a privacy
  // leak and a link that dies on its own schedule rather than ours.
  assert.ok(!IG_CDN.test(JSON.stringify(json)), 'the callback body must not leak a CDN host')
  assert.ok(!IG_CDN.test(head), 'nor must the head that advertised it')
  // The APPLICATION row has been an unverified placeholder since Phase 3a because no ig Post could
  // reach it. A real one now does, all the way through the callback.
  assert.equal(json.application.name, 'Instagram')
})

test('REAL FIXTURE: a reel renders a player and /_media/ SERVES the video, never 302s to the CDN', async () => {
  const post = igFixture('reel', IG_REEL)
  const deps = igDeps(post)
  const html = await (await handle(req(`/reel/${post.ref.code}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, /property="og:video"/, 'a reel must reach a player, not a still')
  assert.match(html, /\/_media\/ig%3Ap%3A/, 'og:video must point at OUR origin')
  assert.ok(!IG_CDN.test(html), 'no raw CDN url in the head')
  assert.match(html, /theme-color" content="#c13584"/)

  const key = encodeURIComponent(refKey(post.ref))
  const i = post.media.findIndex(m => m.kind === 'video')
  // FETCH THE URL THE HEAD ADVERTISES, not a different spelling of it. The head emits
  // `/_media/{key}/0.mp4`; this test used to reconstruct the bare `/_media/{key}/0` and fetch
  // that. Both resolve — router.ts strips the extension behind an allowlist, added precisely
  // because "a URL we advertise has to resolve" — but reconstructing means the block's own claim
  // (real renderer meets real media route, so a two-module spelling disagreement cannot hide) is
  // not actually being made here. The suffix IS a seam; drive the seam.
  const ogVideo = (html.match(/property="og:video" content="([^"]*)"/) || [])[1]
  assert.ok(ogVideo, 'the head must advertise an og:video at all')
  assert.equal(ogVideo, `https://staging.megapenispoopenfarten.sex/_media/${key}/${i}.mp4`)
  /**
   * REWRITTEN 2026-07-25. This used to assert a 302 with a Location on the CDN — "zero hops, the
   * Instagram advantage over TikTok". Zero hops was true and was not enough: measured on the real
   * reels, the CDN's plain 200 for a 38,774,320-byte file carries NO `accept-ranges: bytes` while a
   * 2,471,034-byte one's does (it honours Range on both regardless), so the client behind our
   * redirect had no licence to range-fetch the big file and had to pull all 38MB inside its own
   * timeout — the big reel drew no Discord card, the small one played. A 302 cannot add a header to
   * someone else's response, so we serve the bytes ourselves and advertise it (see mediaproxy.ts).
   *
   * The end-to-end claim is unchanged and is why this was rewritten rather than deleted: the url the
   * head ADVERTISES is the url that resolves. Only the claim about HOW moved, from "it redirects" to
   * "it serves, with accept-ranges". `igDeps` stubs no fetch, so the stub here is also what keeps
   * this test off the live network.
   */
  const realFetch = globalThis.fetch
  let asked
  let m
  try {
    globalThis.fetch = async (u, init) => {
      asked = { url: String(u), range: new Headers(init?.headers || {}).get('range'), method: init?.method ?? 'GET' }
      return new Response('FAKE-MP4', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '8' } })
    }
    m = await handle(req(new URL(ogVideo).pathname), fakeEnv(), ctx, deps)
    assert.equal(m.status, 200)
    assert.equal(m.headers.get('location'), null, 'the video url must not hand off to a third-party origin')
    assert.equal(m.headers.get('content-type'), 'video/mp4')
    // THE HEADER THE CDN OMITS ON A LARGE FILE, and the measured reason the 38MB reel drew no card.
    assert.equal(m.headers.get('accept-ranges'), 'bytes')
    assert.equal(await m.text(), 'FAKE-MP4')
    // And the url we fetched is OUR extraction for THAT ref — the CDN, at zero further hops. An
    // instagram.com url here would be the two-hop shape that cost TikTok the rich card.
    assert.ok(/^https:\/\/scontent[^/]*\.cdninstagram\.com\//.test(asked.url), asked.url)
    assert.equal(asked.range, null, 'no inbound Range -> none forwarded')
  } finally {
    globalThis.fetch = realFetch
  }

  // The poster half is UNCHANGED and must stay a 302 to an IMAGE — images are deliberately not
  // proxied, and the video/poster split is the 2026-07-19 defect this route already closed.
  const p = await handle(req(`/_media/${key}/poster${i}`), fakeEnv(), ctx, deps)
  assert.equal(p.status, 302)
  // The poster is NOT the video, and the two now differ in KIND as well as in url: the video is
  // served, the poster redirects. Asserted against the video's own extracted url rather than
  // against a (now absent) Location, so the claim survived the rewrite intact.
  assert.notEqual(p.headers.get('location'), asked.url, 'the poster is NOT the video')
  // And it is an image url rather than merely a different one — the whole point of the poster is
  // that Discord receives image bytes from it. A '.mp4' here reinstates the measured defect.
  assert.ok(!/\.mp4/.test(p.headers.get('location')), 'the poster must not be an mp4 url')
})

test('REAL FIXTURE: /p/ and /reel/ of ONE post render IDENTICALLY, off ONE cache entry', async () => {
  // The Task 2 invariant, driven end to end. This is the assertion that would catch a regression
  // reintroducing the ig:reel: key split — two upstream fetches and two /_media/ namespaces for
  // one post, which is invisible from any single request.
  const post = igFixture('reel', IG_REEL)
  let fetches = 0
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => { fetches++; return post },
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  const a = await (await handle(req(`/p/${post.ref.code}`, DISCORD), fakeEnv(), ctx, deps)).text()
  const b = await (await handle(req(`/reel/${post.ref.code}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.equal(a, b, 'both spellings of one post must render byte-identically')
  assert.equal(fetches, 1, 'and must cost exactly ONE upstream fetch')
  // Spelled out rather than left implicit in the equality, because equality alone cannot say WHICH
  // namespace they agreed on: two renders that both minted ig%3Areel%3A would be equal and wrong.
  // The media namespace is the thing the split actually damages.
  assert.ok(a.includes(`/_media/ig%3Ap%3A${IG_REEL}/`), 'both must mint media under the ig:p: key')
  assert.ok(!a.includes('ig%3Areel%3A'), 'the reel spelling must not survive into a media url')
})

test('REAL FIXTURE: the decoy is an honest failure, not a blank embed', async () => {
  // THE ONE SILENT FAILURE MODE. A Chrome UA gets ~598KB of perfectly ordinary text/html at HTTP
  // 200, so status, size and content-type all look healthy; only the content assertion can see it.
  // At this surface the requirement is narrower and just as important: the viewer must be told,
  // rather than shown an embed with a title and nothing in it.
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => normalizeInstagram(readFileSync('test/fixtures/instagram-decoy.html', 'utf8'),
                                              { p: 'ig', kind: 'p', code: 'X' }),
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  assert.match(await (await handle(req('/p/X', DISCORD), fakeEnv(), ctx, deps)).text(), /may be private, removed, or unavailable/i)
})

test('REAL FIXTURE: a single-image post still takes the path a human already signed off', async () => {
  // The regression guard, and it is about the SPOOF path specifically: a single image is the
  // commonest shape on the platform, it comes out of the markup extractor rather than the blob,
  // and it must land on the same head Bluesky's four-image post did — activity link present,
  // og:image SUPPRESSED, because that suppression is the mechanism that makes the gallery come
  // from media_attachments instead of a single card image.
  const post = igFixture('single', IG_SINGLE)
  const w = igWatchingDeps(post)
  const html = await (await handle(req(`/p/${post.ref.code}`, DISCORD), fakeEnv(), ctx, w.deps(fakeCache()))).text()
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:image'))
  assert.ok(!/couldn't load/i.test(html), 'the markup path must produce a real post')

  // AND THE OTHER TWO THINGS THIS BLOCK EXISTS TO PROVE — media on our origin, and no raw CDN url.
  // They were missing here while the carousel and reel tests both carried them, which left the gap
  // in exactly the wrong place: THE MARKUP PATH IS THE ONE THAT MANUFACTURES URLS. Every other
  // shape reads its urls out of the embedded JSON blob; a single image comes from unentityUrl over
  // an img src/srcset attribute (normalize.ts says so in its own comment), so string surgery on
  // hostile-ish markup is what produces the url, and it is the likeliest place for a raw CDN host
  // to escape. Verified correct today — this is the guard, not a bug report.
  const advertised = advertisedCallback(html)
  assert.equal(advertised, `/users/${post.author.handle}/statuses/${encodeStatusId(refKey(post.ref))}`)
  w.seen = null
  const res = await handle(req(advertised, DISCORD), fakeEnv(), ctx, w.deps(fakeCache()))
  assert.deepEqual(w.seen, post.ref, 'the callback must decode to the post it advertises')
  const json = await res.json()
  assert.equal(json.media_attachments.length, 1, 'a single-image post is exactly one attachment')
  assert.equal(json.media_attachments[0].type, 'image')
  assert.equal(json.media_attachments[0].url, `https://staging.megapenispoopenfarten.sex${mediaRef(post.ref, 0)}`)
  assert.ok(!IG_CDN.test(JSON.stringify(json)), 'the callback body must not leak a CDN host')
  assert.ok(!IG_CDN.test(html), 'nor must the head')
  // And the url we just advertised RESOLVES. A /_media/ url that is beautifully on our own origin
  // and 404s is a broken embed with a clean audit trail; only fetching it closes that loop.
  const m = await handle(req(mediaRef(post.ref, 0)), fakeEnv(), ctx, w.deps(fakeCache()))
  assert.equal(m.status, 302)
  assert.match(m.headers.get('location'), /^https:\/\//)
})

test('Bluesky and TikTok did not regress', async () => {
  // A third platform landing must not perturb the two that already work. The plan's spelling of
  // this test referenced an undefined `base` and asserted only the Bluesky half despite its title;
  // both were corrected rather than copied, because this file already records why a test whose
  // title claims a behaviour its body never exercises is worse than no test.
  //
  // theme-color is the marker on purpose: it is the ONE per-platform value looked up by ref.p at
  // render time, so a table edit that mis-wires Instagram shows up here as the wrong colour on a
  // platform this commit never touched.
  const bs = {
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'still blue', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [{ kind: 'image', url: 'https://cdn/0.jpg', w: 800, h: 600 }], counts: {}, sensitive: false,
  }
  const bsHtml = await (await handle(req(BS_POST, DISCORD), fakeEnv(), ctx, igDeps(bs))).text()
  assert.match(bsHtml, /theme-color" content="#0085ff"/)
  assert.ok(!bsHtml.includes('#c13584'), 'Instagram purple must not ship on Bluesky')
  assert.match(bsHtml, /still blue/, 'and it is really that post, not a failure embed')

  const tt = {
    ref: { p: 'tt', id: '7660566211100511518' },
    canonical: 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518',
    author: { name: 'Mystic Aquarium', handle: 'mysticaquarium', url: 'https://www.tiktok.com/@mysticaquarium' },
    text: 'still pink', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280 }],
    counts: {}, sensitive: false,
  }
  const ttHtml = await (await handle(req(TT_POST, DISCORD), fakeEnv(), ctx, igDeps(tt))).text()
  assert.match(ttHtml, /theme-color" content="#ff0050"/)
  assert.ok(!ttHtml.includes('#c13584'), 'nor on TikTok')
  assert.match(ttHtml, /still pink/)
})

// ---------------------------------------------------------------------------
// THREE HOUSEKEEPING ENFORCERS, each closing a hole a code review demonstrated live.
//
// They share a shape with "THE PROBE IS GONE" above: they read the TREE rather than call a
// function, because what they defend against is not a wrong value at runtime — it is an edit
// (or a missing edit) that leaves the suite green while the repo ships something it should not.
// ---------------------------------------------------------------------------

test('.gitignore must ignore the node_modules SYMLINK, not just a node_modules directory', () => {
  // `node_modules/` — with the trailing slash — is a DIRECTORY-ONLY pattern. In a git worktree
  // node_modules is a SYMLINK to the parent checkout's copy, and a symlink is not a directory, so
  // the pattern never matched it and `git add -A` (which this repo's plans call for verbatim at
  // the end of every task) staged it. The committed artifact would be a dangling symlink to
  // `../../../node_modules`, resolving only from inside one specific worktree layout and broken in
  // every clone.
  //
  // Asserted through GIT ITSELF, not by grepping .gitignore for a string: the defect was precisely
  // that a pattern which LOOKS right does not MATCH, so only git's own matcher is evidence. This
  // is the same reason the rest of this file asserts on content rather than on status.
  const ignored = (p) => {
    // check-ignore exits 0 when the path is ignored and 1 when it is not; execFileSync throws on
    // a non-zero exit, so the catch IS the negative result rather than an error to report.
    try { execFileSync('git', ['check-ignore', '-q', p], { stdio: 'ignore' }); return true }
    catch { return false }
  }
  //
  // EVERY scratch pattern is checked, not just node_modules, because CI caught this test's own blind
  // spot on its first run (2026-07-26): `.superpowers/` carried a trailing slash, so it matched
  // locally — where the directory exists — and NOT in a clean clone, where git cannot know a
  // non-existent path would have been a directory. A green suite on the author's machine is exactly
  // the evidence this test was built to distrust, so it now asks git about every pattern whose whole
  // job is to survive `git add -A` on a checkout that has never seen the tool that creates it.
  for (const p of ['node_modules', '.superpowers', '.playwright-mcp', '__pycache__']) {
    assert.equal(ignored(p), true, `${p} is scratch and must be ignored on ANY checkout, existing or not`)
  }
})

test('every file this repo CITES in a source comment must actually exist', () => {
  // Two comment blocks survived the probe's deletion still telling the next engineer to run
  // `src/probe.ts` and to read `docs/research/2026-07-19-instagram-workers-egress-probe.md`.
  // Neither existed. That is worse than ordinary comment rot, because that specific block is the
  // documented escalation path for a production-only Instagram failure — it sends whoever is
  // debugging one to a deleted tool and an unwritten document.
  //
  // Scoped to citations of OUR OWN tree. Comments here legitimately cite files in UPSTREAM
  // repositories (okdargy/fxTikTok, FxEmbed) to show where a behaviour was read from, and those
  // paths cannot resolve locally by definition — so they are allowlisted individually rather than
  // by a loose pattern, which keeps a NEW dangling citation of our own a failure.
  const FOREIGN = new Set([
    'src/generate.ts',        // okdargy/fxTikTok — cited by platforms/tiktok/normalize.ts
    'src/embed/status.ts',    // FxEmbed — cited by render/discord.ts
    'src/helpers/snowcode.ts',// FxEmbed — cited by statusid.ts
    // FxEmbed — the credential system the empty seam mirrors, cited by platforms/twitter/fetch.ts's
    // fetchWithCredentials docstring. Upstream by definition: this repo ships the seam EMPTY.
    'src/providers/twitter/proxy/credentials.ts',
  ])
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = `${d}/${e}`
      statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p)
    }
  }
  walk('src')
  const broken = []
  for (const f of files) {
    const cites = readFileSync(f, 'utf8').match(/(?:src|test|docs|public)\/[A-Za-z0-9._/-]+\.(?:ts|mjs|md|html|jsonc?)/g) || []
    for (const c of new Set(cites)) if (!FOREIGN.has(c) && !existsSync(c)) broken.push(`${f} cites missing ${c}`)
  }
  assert.deepEqual(broken, [], `dangling citations:\n${broken.join('\n')}`)
})

test('the probe enforcer is HAZARD-scoped, not NAME-scoped', () => {
  // The original enforcer scanned exactly two files for the three strings 'probe', 'PROBE_TOKEN'
  // and 'runProbe'. A review proved the hole by mutation: an identical caller-controlled egress
  // endpoint added as `src/diag.ts` and mounted in handle() as `/_diag/` passed the whole suite
  // green, with no token gate at all. Re-introduction under a NEW NAME is the same class of
  // mistake the original test was written to make impossible.
  //
  // Two widenings, both cheap and both behavioural rather than lexical:
  for (const f of ['src/worker.ts', 'src/analytics.ts']) {
    const src = readFileSync(f, 'utf8')
    assert.ok(!src.includes('_probe'), `${f} still mounts the probe`)
    assert.ok(!src.includes('PROBE_TOKEN'), `${f} still references PROBE_TOKEN`)
    assert.ok(!src.includes('runProbe'), `${f} still imports runProbe`)
  }

  // (1) THE DISPATCHER PERFORMS NO EGRESS OF ITS OWN. Every upstream fetch in this codebase
  // arrives through an injected dep (`d.fetchPost`, `d.resolveShortlink`) or a platform fetcher;
  // worker.ts itself calls fetch() exactly never. That invariant is what the probe violated — it
  // was a route in the dispatcher that fetched a caller-supplied identifier — and it holds no
  // matter what the endpoint or its file is called. `env.ASSETS.fetch(` (static assets, no
  // caller-controlled destination) and the exported `async fetch(` handler are the two legal
  // spellings and are excluded by requiring a bare, unqualified call.
  const workerSrc = readFileSync('src/worker.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')  // strip block comments — prose about fetch() is not a call
    .replace(/\/\/[^\n]*/g, '')        // and line comments likewise
  // `(?<![.\w])` rejects the qualified `env.ASSETS.fetch(`; `(?<!async )` rejects the exported
  // handler's own `async fetch(req, env, ctx)` signature, which is a DECLARATION, not a call. Both
  // exclusions are needed and both were found by running this test before the widening: without
  // the second it reports the default export as an egress site, which is a false positive that
  // would have made the assertion untrustworthy on its first real hit.
  const bareFetch = workerSrc.match(/(?<![.\w])(?<!async )fetch\s*\(/g) || []
  assert.deepEqual(bareFetch, [], 'worker.ts must reach the network only through injected deps')

  // (1b) src/mediaproxy.ts is now the ONE non-platform egress site (added 2026-07-25 to serve
  // Instagram video bytes ourselves rather than 302-ing to a CDN whose large-object 200 omits
  // `accept-ranges`). Moving egress one import away from a guarded file is exactly the move the
  // comment above says must be argued for here rather than merged quietly, so: it is a DIFFERENT
  // hazard class from the probe. The probe fetched a CALLER-SUPPLIED shortcode; this fetches a url
  // that came out of OUR OWN extraction for the ref in the path, host-allowlisted to Meta's two CDN
  // domains by a PURE function before any I/O. Pinned lexically here so a second one cannot appear
  // quietly, and behaviourally in test/media-proxy.test.mjs (a foreign-host url costs ZERO fetches).
  const proxySrc = readFileSync('src/mediaproxy.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal((proxySrc.match(/(?<![.\w])fetch\s*\(/g) || []).length, 1,
    'mediaproxy.ts must make exactly one upstream request, in serveDirectVideo')

  // (2) NO NEW UNDERSCORE-PREFIXED DEBUG MOUNT, whatever it is called. Internal routes in this
  // worker are minted by route(), and the underscore namespace is reserved for machine routes
  // (/_media/, /_oembed/). A `startsWith('/_…')` branch in the dispatcher is the exact shape the
  // probe mount had, so any reappearance of one has to be argued for here rather than merged
  // quietly under a name no test knows to look for.
  assert.deepEqual(workerSrc.match(/startsWith\(\s*['"`]\/_/g) || [], [],
    'a new /_ debug route was mounted directly in the dispatcher')
})

// ── Task 5: Twitter dispatch through liveFetchPost — the render seam, the age-gate honest failure,
// and that unfetched platforms still degrade to null.
const X_POST = '/jack/status/20'

test('a Twitter post reaches the renderer as an x post, leaking no CDN url', async () => {
  // fetchPost is STUBBED here — this pins the RENDER seam, not the fetchers: a fully-formed x Post must
  // render the Mastodon-spoof head with EVERY media URL rewritten onto our /_media/ namespace, never a
  // raw pbs.twimg / video.twimg url (the Global-Constraints leak rule).
  const post = {
    ref: { p: 'x', id: '20' }, canonical: 'https://x.com/jack/status/20',
    author: { name: 'jack', handle: 'jack', url: 'https://x.com/jack' },
    text: 'just setting up my twttr', createdAt: new Date('2006-03-21T20:50:14Z'),
    media: [{ kind: 'video', url: 'https://video.twimg.com/x.mp4', w: 1280, h: 720,
              poster: 'https://pbs.twimg.com/x.jpg' }],
    counts: { likes: 5 }, sensitive: false,
  }
  const html = await (await handle(req(X_POST, DISCORD), fakeEnv(), ctx, {
    cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }),
  })).text()
  assert.ok(!html.includes('video.twimg.com') && !html.includes('pbs.twimg.com'), 'no raw CDN url')
  assert.match(html, new RegExp(`statuses/${encodeStatusId(refKey(post.ref))}`))
  assert.ok(!/couldn't load/i.test(html))
})

test('an age-restricted tweet is an HONEST failure — crawler embed, human 302, counted age_restricted', async () => {
  // The whole point of the seam. A TweetTombstone from the (stubbed) network walls credential-free, so
  // liveFetchPost returns null AND counts 'x'/'age_restricted' — distinct from fetch_fail (the worker's
  // own null-path counter) and assert_fail (both paths failing to answer). The worker cannot see WHY a
  // null came back, so the fetcher attributes the reason, exactly as ig does for its decoy. BEFORE the
  // dispatch arm exists, the default case swallows 'x' and emits NO count, so this fails on the missing
  // age_restricted point.
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ __typename: 'TweetTombstone', tombstone: {} }), { status: 200 })
  try {
    const env = fakeEnv()
    const post = await liveFetchPost({ p: 'x', id: '1' }, env, 'discord')
    assert.equal(post, null, 'a tombstone never becomes a Post')
    assert.ok(env.points.some(p => p.blobs[0] === 'x' && p.blobs[1] === 'age_restricted'),
      'it counts age_restricted, distinct from fetch_fail and assert_fail')
  } finally { globalThis.fetch = real }
})

test('liveFetchPost dispatches x, and still returns null for platforms with no fetcher', async () => {
  // Adding the 'x' case must not swallow the honest default: rd must still degrade to null (a
  // fetch_fail like any other), never a throw. rd HAS a fetcher now, but fakeEnv() sets no Reddit
  // creds, so appToken() returns null before any request — null with zero network. (th left this
  // list when its dispatch landed — it reaches the live site, which a no-network test must not do.)
  for (const ref of [{ p: 'rd', sub: 'aww', id: 'a' }])
    assert.equal(await liveFetchPost(ref, fakeEnv(), 'other-bot'), null, ref.p)
})

// ---------------------------------------------------------------------------
// Task 7: TWITTER END TO END, through the REAL fixtures, with NO network.
//
// Everything in the Task 5 block above injects a hand-written x Post (a synthetic that exists to
// prove the DISPATCH and the render leak rule). None of it can see a SEAM: a wire format the
// normalizer and the router/renderer spell differently. Those only fail where a REAL captured
// payload meets the real request path — real syndication JSON -> real normalizeTwitter -> real
// router -> real renderer -> real /_media/ route — which is exactly this block.
//
// The fixture IDs are the REAL ones the captures were taken from (the plan carried REPLACE_*
// placeholders); the /_media/ namespace is `x:{id}` for all of them, so the assertions below are
// about tweets that actually exist. The naming split still holds: these are x.com URLs and x:{id}
// keys (code identifiers), rendered under the display name "Twitter" (prose) — do not "fix" either.
// ---------------------------------------------------------------------------

/** A real captured syndication response through the real normalizer, at the ref the router mints. */
const xPost = (f, id) =>
  normalizeTwitter(
    { source: 'syndication', data: JSON.parse(readFileSync(`test/fixtures/twitter-${f}.json`, 'utf8')) },
    { p: 'x', id },
  )
const X_VIDEO_ID = '1491475671058681863'
const X_MULTI_ID = '1376712834269159425'
const X_QUOTE_ID = '1823076043017630114'
const X_GIF_ID = '1479837621337657345'
/** Every test below injects the post, so the resolver is never consulted — but Deps requires it. */
const xDeps = post => ({
  cache: fakeCache(),
  fetchPost: async () => post,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
})

test('REAL FIXTURE: a video tweet renders a player, /_media/ 302s to a DIRECT CDN url', async () => {
  const post = xPost('video', X_VIDEO_ID)
  const deps = xDeps(post)
  const html = await (await handle(req(`/i/status/${post.ref.id}`, DISCORD), fakeEnv(), ctx, deps)).text()
  // og:video is the player; it must point at OUR /_media/ namespace, never the raw CDN. A raw
  // video.twimg/pbs.twimg url in the head is the leak the Global Constraints forbid — a privacy hole
  // and a link on the CDN's schedule, not ours.
  assert.match(html, /property="og:video"/)
  assert.match(html, /\/_media\/x%3A/, 'og:video on OUR origin, keyed x:{id}')
  assert.ok(!html.includes('video.twimg') && !html.includes('pbs.twimg'), 'no raw CDN url in the head')
  // THEME.x is the one per-ref.p value the head looks up; a table mis-wire ships the wrong accent.
  assert.match(html, /theme-color" content="#000000"/)

  // The video /_media/ url resolves to the CDN itself — ZERO further hops. This is the Twitter
  // advantage over TikTok (whose playable url is itself a 302, which cost it the rich card until
  // withResolvedVideo collapsed it): here the Location IS video.twimg.com, nothing left to follow,
  // comfortably inside Discord's one-hop media-proxy budget. Asserted as CONTENT — a second-hop
  // Location would look like a perfectly ordinary 302 from the status alone.
  const key = encodeURIComponent(refKey(post.ref))
  const i = post.media.findIndex(m => m.kind === 'video')
  const m = await handle(req(`/_media/${key}/${i}`), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.match(m.headers.get('location'), /^https:\/\/video\.twimg\.com\//, 'the CDN itself — ZERO further hops')
  // The poster is the STILL image, not the mp4. preview_url = the video file is the 2026-07-19
  // defect (Discord asks for a still, gets mp4 bytes, drops the rich card), so the two /_media/
  // spellings MUST land on different urls.
  const p = await handle(req(`/_media/${key}/poster${i}`), fakeEnv(), ctx, deps)
  assert.equal(p.status, 302)
  assert.notEqual(p.headers.get('location'), m.headers.get('location'), 'the poster is NOT the video')
  assert.ok(!/\.mp4/.test(p.headers.get('location')), 'the poster must be the still image, not an mp4')
})

test('REAL FIXTURE: a multi-photo tweet becomes a gallery, all on our origin', async () => {
  // The gallery reaches Discord through the activity callback (toMastodonStatus), a DIFFERENT
  // renderer from the head, reached via the encodeStatusId/decodeStatusId spoof {id} round trip.
  // A media_attachments assertion on the unit alone cannot see those two seams in between.
  const post = xPost('multiphoto', X_MULTI_ID)
  const deps = xDeps(post)
  const id = encodeStatusId(refKey(post.ref))
  const json = await (await handle(req(`/api/v1/statuses/${id}`, DISCORD), fakeEnv(), ctx, deps)).json()
  assert.ok(json.media_attachments.length >= 2, `expected a multi-photo gallery, got ${json.media_attachments.length}`)
  assert.ok(json.media_attachments.every(a => a.type === 'image'), 'every photo is an image attachment')
  for (const a of json.media_attachments)
    assert.match(a.url, /\/_media\/x%3A/, 'every image on OUR origin, keyed x:{id}')
  // No raw CDN url anywhere in the JSON body — url, preview_url, avatar and the meta block all bear
  // urls, and a per-field check leaves each new field unguarded.
  assert.ok(!JSON.stringify(json).includes('pbs.twimg') && !JSON.stringify(json).includes('video.twimg'),
    'the callback body must not leak a CDN host')
  // The APPLICATION row: the code is 'x', the user-facing "posted via" name is 'Twitter'.
  assert.equal(json.application.name, 'Twitter')
})

test('REAL FIXTURE: a quote-tweet hoists the quoted image through /_media/, no raw CDN leak', async () => {
  // Quote extraction was BUILT this phase (owner's call). The renderer already consumes post.quote
  // (text.ts draws the "Quoting …" line, media.ts hoists the quoted post's media in behind the
  // parent's). This proves the normalizer populates it AND that the nested post's media reach a
  // viewer ONLY through the parent's /_media/ namespace — never as a raw CDN url from the nested post.
  const post = xPost('quote', X_QUOTE_ID)
  assert.ok(post.quote, 'the fixture is a quote-tweet')
  const deps = xDeps(post)
  const id = encodeStatusId(refKey(post.ref))
  const json = await (await handle(req(`/api/v1/statuses/${id}`, DISCORD), fakeEnv(), ctx, deps)).json()
  assert.match(json.content, /Quoting/, 'the quoted author line is in content')
  for (const a of json.media_attachments)
    assert.match(a.url, /\/_media\/x%3A/, 'all media on OUR origin, including the hoisted quote image')
  assert.ok(!JSON.stringify(json).includes('pbs.twimg') && !JSON.stringify(json).includes('video.twimg'),
    'the quoted post is a NESTED post and its media must not leak as raw CDN either')
  // The hoisted quote image resolves via the PARENT refKey (its attachment id is its raw index in
  // mediaList(post) = parent media THEN quote media, so the last attachment is the hoisted one).
  const idx = json.media_attachments.at(-1).id
  const m = await handle(req(`/_media/${encodeURIComponent(refKey(post.ref))}/${idx}`), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302, 'the hoisted quote image resolves under the parent /_media/ namespace')
})

test('REAL FIXTURE: an animated_gif renders a player, not an og:image=mp4', async () => {
  // The trap fact 4 names: a Twitter "GIF" is an mp4 with no audio, mapped to kind:'video' (never
  // kind:'gif', which is a Mastodon image attachment — an mp4 there is the poster defect). So it must
  // reach a player via og:video, exactly like a real video, rather than an og:image pointing at mp4
  // bytes Discord will refuse.
  const post = xPost('gif', X_GIF_ID)
  const deps = xDeps(post)
  const html = await (await handle(req(`/i/status/${post.ref.id}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, /property="og:video"/, 'the GIF plays as a video, not an og:image')
  assert.ok(!html.includes('video.twimg') && !html.includes('pbs.twimg'), 'no raw CDN url in the GIF head')
})

test('REAL FIXTURE: a tombstone renders the AGE-RESTRICTED embed — calm card for a crawler, human 302', async () => {
  // The age gate, driven through fetchTwitter's REAL path with the network stubbed to the tombstone
  // capture (both fetch paths see the same stub). A credential-walled post can never become a Post, so
  // the crawler now gets the DISTINCT age-restricted embed (a known limit, not a fetch error) rather
  // than the neutral "couldn't load" card, and the human still 302s to the real post on
  // x.com — where they can log in. This closes the threading end to end: liveFetchPost reports the age
  // reason, the post route sets outcome.ageRestricted, and render() picks the calm embed.
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(readFileSync('test/fixtures/twitter-tombstone.json', 'utf8'), { status: 200 })
  try {
    const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: async () => ({ kind: 'unresolved' }) }
    const crawler = await (await handle(req('/i/status/1', DISCORD), fakeEnv(), ctx, deps)).text()
    assert.match(crawler, /This post is age-restricted/, 'the crawler gets the distinct age embed')
    assert.match(crawler, /Can.t preview age-restricted posts\./)
    assert.ok(!/couldn't load/i.test(crawler), 'and NOT the generic failure embed — the two are distinct')
    const human = await handle(req('/i/status/1'), fakeEnv(), ctx, deps)
    assert.equal(human.status, 302, 'a human is sent to x.com, never shown the age embed')
    assert.match(human.headers.get('location'), /^https:\/\/x\.com\//, 'the human is sent to the real post')
  } finally { globalThis.fetch = real }
})

test('the age case counts age_restricted ONCE + fetch_fail ONCE; a GENERIC x failure counts fetch_fail alone', async () => {
  // The counter must neither double-fire nor drop. age_restricted is attributed by the fetcher (the
  // worker cannot see WHY a null came back); fetch_fail is the worker's own null-path counter. They
  // STACK, exactly once each — the same layering ig/tt keep. A generic failure (a deleted tweet, a
  // network error -> fetchPost null) gets fetch_fail alone, no age concept, and the OLD embed.
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(readFileSync('test/fixtures/twitter-tombstone.json', 'utf8'), { status: 200 })
  try {
    const env = fakeEnv()
    const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: async () => ({ kind: 'unresolved' }) }
    await handle(req('/i/status/1', DISCORD), env, ctx, deps)
    const x = env.points.filter(p => p.blobs[0] === 'x').map(p => p.blobs[1])
    assert.deepEqual(x.filter(o => o === 'age_restricted'), ['age_restricted'], 'age_restricted fires exactly once')
    assert.deepEqual(x.filter(o => o === 'fetch_fail'), ['fetch_fail'], 'and fetch_fail exactly once, stacked')
  } finally { globalThis.fetch = real }

  const env2 = fakeEnv()
  const deps2 = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const html = await (await handle(req(X_POST, DISCORD), env2, ctx, deps2)).text()
  assert.match(html, /Couldn't load this Twitter post/, 'a generic failure renders the neutral card')
  assert.ok(!/age-restricted/i.test(html), 'no age concept for a generic failure')
  assert.deepEqual(env2.points.filter(p => p.blobs[0] === 'x').map(p => p.blobs[1]), ['fetch_fail'],
    'generic failure: fetch_fail alone, never age_restricted')
})

test('a Bluesky or TikTok failure is UNCHANGED — the generic embed, no age concept leaks in', async () => {
  // Only Twitter's tombstone produces age_restricted; the other platforms have no such reason, so a
  // failed fetch on them keeps the generic "couldn't load" card and never the age embed.
  for (const [path, name] of [[BS_POST, 'Bluesky'], [TT_POST, 'TikTok']]) {
    const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }) }
    const html = await (await handle(req(path, DISCORD), fakeEnv(), ctx, deps)).text()
    assert.match(html, new RegExp(`Couldn't load this ${name} post`), `${name} keeps the generic embed`)
    assert.ok(!/age-restricted/i.test(html), `no age concept leaks to ${name}`)
  }
})

test('Bluesky, TikTok and Instagram did not regress', async () => {
  // A fourth platform landing must not perturb the three that already work. Written to actually
  // exercise all THREE platforms its title names, rather than the plan's spelling, which referenced
  // an undefined `base` and asserted only the Bluesky half — a test whose title claims a behaviour
  // its body never exercises is worse than no test, as the Instagram-phase regression test above this
  // one already records. It also adds the Instagram leg the pre-Twitter regression test lacked.
  //
  // theme-color is the marker on purpose: it is the ONE per-platform value looked up by ref.p at
  // render time, so a DISPLAY_NAME/THEME table edit that mis-wires a platform shows up here as the
  // wrong accent on a platform this commit never touched.
  const bs = {
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'still blue', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [{ kind: 'image', url: 'https://cdn/0.jpg', w: 800, h: 600 }], counts: {}, sensitive: false,
  }
  const bsHtml = await (await handle(req(BS_POST, DISCORD), fakeEnv(), ctx, xDeps(bs))).text()
  assert.match(bsHtml, /theme-color" content="#0085ff"/)
  assert.ok(!bsHtml.includes('#000000'), 'Twitter black must not ship on Bluesky')
  assert.match(bsHtml, /still blue/, 'and it is really that post, not a failure embed')

  const tt = {
    ref: { p: 'tt', id: '7660566211100511518' },
    canonical: 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518',
    author: { name: 'Mystic Aquarium', handle: 'mysticaquarium', url: 'https://www.tiktok.com/@mysticaquarium' },
    text: 'still pink', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280 }],
    counts: {}, sensitive: false,
  }
  const ttHtml = await (await handle(req(TT_POST, DISCORD), fakeEnv(), ctx, xDeps(tt))).text()
  assert.match(ttHtml, /theme-color" content="#ff0050"/)
  assert.match(ttHtml, /still pink/)

  // Instagram through a REAL fixture, so the third leg is a genuine render, not a synthetic — igFixture
  // and IG_REEL are defined in the Instagram end-to-end block above.
  const ig = igFixture('reel', IG_REEL)
  const igHtml = await (await handle(req(`/reel/${ig.ref.code}`, DISCORD), fakeEnv(), ctx, xDeps(ig))).text()
  assert.match(igHtml, /theme-color" content="#c13584"/)
  assert.ok(!igHtml.includes('#000000'), 'nor Twitter black on Instagram')
})

// ── gated-post scheme: THREE cases end to end, threaded exactly like the age gate — the fetcher
// attributes the reason (private/age_restricted), the post route maps it to Outcome.gate, render()
// picks the calm 🔞/🔒 embed. A deleted post and a 10204 TikTok both stay the GENERIC red failure.

// Wrap a webapp.video-detail scope into the page shape the normalizer parses (mirrors the tt tests).
const ttWrap = scope =>
  `<!doctype html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${
    JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': scope } })
  }</script>`
// A URL-aware Twitter stub: syndication, guest activate.json, and the guest GraphQL answer distinctly.
const twStub = ({ syndication, graphql }) => async (url) => {
  const u = String(url)
  if (u.includes('cdn.syndication.twimg.com')) return typeof syndication === 'string'
    ? new Response(syndication, { status: 404 })
    : new Response(JSON.stringify(syndication), { status: 200 })
  if (u.includes('guest/activate.json')) return new Response(JSON.stringify({ guest_token: 'gt' }), { status: 200 })
  if (u.includes('TweetResultByRestId')) return new Response(JSON.stringify(graphql ?? {}), { status: 200 })
  throw new Error('unexpected url ' + u)
}
const gateDeps = () => ({ cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: async () => ({ kind: 'unresolved' }) })

test('gated-post scheme: a PRIVATE tweet (guest Protected) renders 🔒, human 302, counts private once', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = twStub({
      syndication: { __typename: 'TweetTombstone', tombstone: {} },
      graphql: { data: { tweetResult: { result: { __typename: 'TweetUnavailable', reason: 'Protected' } } } },
    })
    const env = fakeEnv()
    const crawler = await (await handle(req('/i/status/1', DISCORD), env, ctx, gateDeps())).text()
    assert.match(crawler, /This post is private/, 'the crawler gets the distinct private embed')
    assert.match(crawler, /Can.t preview posts from a private account\./)
    assert.ok(!/age-restricted/i.test(crawler), 'a private gate is NOT the age embed')
    assert.ok(!/couldn't load/i.test(crawler), 'nor the generic failure — the three are distinct')
    const human = await handle(req('/i/status/1'), fakeEnv(), ctx, gateDeps())
    assert.equal(human.status, 302, 'a human is sent to x.com, never shown the private embed')
    assert.match(human.headers.get('location'), /^https:\/\/x\.com\//)
    const x = env.points.filter(p => p.blobs[0] === 'x').map(p => p.blobs[1])
    assert.deepEqual(x.filter(o => o === 'private'), ['private'], 'private fires exactly once')
    assert.deepEqual(x.filter(o => o === 'fetch_fail'), ['fetch_fail'], 'stacked with fetch_fail once')
    assert.ok(!x.includes('age_restricted'), 'and never age_restricted for a private post')
  } finally { globalThis.fetch = real }
})

test('gated-post scheme: a genuinely DELETED tweet stays the GENERIC failure, never a gate', async () => {
  // FALSE-POSITIVE GUARD. Syndication 404s to an HTML poodle (assert_fail); guest returns an empty
  // result (no gate, no legacy -> assert_fail). No gate reason, so the crawler gets the neutral generic
  // embed and NO 🔞/🔒, and no gate counter fires.
  const real = globalThis.fetch
  try {
    globalThis.fetch = twStub({
      syndication: '<html>Nothing to see here</html>',
      graphql: { data: { tweetResult: { result: {} } } },
    })
    const env = fakeEnv()
    const html = await (await handle(req('/i/status/1', DISCORD), env, ctx, gateDeps())).text()
    assert.match(html, /Couldn't load this Twitter post/, 'a deleted tweet is the generic failure')
    assert.ok(!/age-restricted/i.test(html) && !/This post is private/.test(html), 'never a gate message')
    const x = env.points.filter(p => p.blobs[0] === 'x').map(p => p.blobs[1])
    assert.ok(!x.includes('private') && !x.includes('age_restricted'), 'no gate counter for a deleted post')
    assert.ok(x.includes('fetch_fail'), 'just the ordinary fetch_fail')
  } finally { globalThis.fetch = real }
})

test('gated-post scheme: TikTok age (isContentClassified, no video) renders 🔞, counts age_restricted', async () => {
  const real = globalThis.fetch
  const ageScope = { statusCode: 0, itemInfo: { itemStruct: {
    id: '7660566211100511518', createTime: '1700000000', desc: 'x', author: { uniqueId: 'u' },
    isContentClassified: true, video: {} } } }
  try {
    globalThis.fetch = async () => new Response(ttWrap(ageScope), { status: 200 })
    const env = fakeEnv()
    const html = await (await handle(req(TT_POST, DISCORD), env, ctx, gateDeps())).text()
    assert.match(html, /This post is age-restricted/, 'the TikTok age wall renders 🔞')
    assert.ok(!/This post is private/.test(html) && !/couldn't load/i.test(html), 'distinct from private + generic')
    const tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    assert.deepEqual(tt.filter(o => o === 'age_restricted'), ['age_restricted'], 'age_restricted once')
    assert.deepEqual(tt.filter(o => o === 'fetch_fail'), ['fetch_fail'], 'stacked with fetch_fail once')
  } finally { globalThis.fetch = real }
})

test('gated-post scheme: TikTok private (10216 / 10222) renders 🔒, counts private', async () => {
  const real = globalThis.fetch
  try {
    for (const status of [10216, 10222]) {
      globalThis.fetch = async () => new Response(ttWrap({ statusCode: status }), { status: 200 })
      const env = fakeEnv()
      const html = await (await handle(req(TT_POST, DISCORD), env, ctx, gateDeps())).text()
      assert.match(html, /This post is private/, `statusCode ${status} renders 🔒`)
      assert.ok(!/age-restricted/i.test(html), `${status} is private, not age`)
      const tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
      assert.deepEqual(tt.filter(o => o === 'private'), ['private'], `${status} counts private once`)
    }
  } finally { globalThis.fetch = real }
})

test('gated-post scheme: a TikTok 10204 (deleted) and a signal-absent page stay GENERIC, never a gate', async () => {
  const real = globalThis.fetch
  try {
    // 10204 deleted: the existing false-positive guard, now proven NOT to trip the gate.
    globalThis.fetch = async () => new Response(readFileSync('test/fixtures/tiktok-deleted.html', 'utf8'), { status: 200 })
    let env = fakeEnv()
    let html = await (await handle(req(TT_POST, DISCORD), env, ctx, gateDeps())).text()
    assert.match(html, /Couldn't load this TikTok post/, 'a deleted TikTok is the generic failure')
    assert.ok(!/age-restricted/i.test(html) && !/This post is private/.test(html), 'never a gate')
    let tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    assert.ok(!tt.includes('private') && !tt.includes('age_restricted'), 'no gate counter for 10204')

    // EGRESS-SAFETY: a status-0 page with an itemStruct but NO isContentClassified is NOT a gate — the
    // branch simply does not fire, and the post degrades exactly as today (here: a media-less Post).
    const noSignal = { statusCode: 0, itemInfo: { itemStruct: {
      id: '7660566211100511518', createTime: '1700000000', desc: 'x', author: { uniqueId: 'u' }, video: {} } } }
    globalThis.fetch = async () => new Response(ttWrap(noSignal), { status: 200 })
    env = fakeEnv()
    html = await (await handle(req(TT_POST, DISCORD), env, ctx, gateDeps())).text()
    assert.ok(!/age-restricted/i.test(html) && !/This post is private/.test(html), 'no signal -> no gate')
    tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    assert.ok(!tt.includes('private') && !tt.includes('age_restricted'), 'no gate counter when the signal is absent')
  } finally { globalThis.fetch = real }
})

// ---------------------------------------------------------------------------
// THE GATE ON THE SHORT-LINK PATH. Confirmed live 2026-07-21: a followers-only post showed the
// permalink's 🔒 wall but its /t/{code} SHORT link fell through to the generic failure card — the raw
// signal being webapp.video-detail statusCode 10222 (author_secret), which
// tiktokGate already maps to 'private'. The gate check was wired into liveFetchPost (permalink) only
// and never into the resolver. The resolver now runs tiktokGate on the page it already fetched and
// carries the reason out on a {kind:'gated'} ShortlinkResolution, which the route maps onto
// Outcome.gate exactly as the post route maps failReason — so one post renders the SAME card whichever
// url shape was pasted. These four are the permalink-parity, no-regression, and false-positive guards.
// ---------------------------------------------------------------------------

const gateShortDeps = () => ({ cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink })
const TT_SHORT = '/t/ZTA8HeVno'

test('gated short link: PRIVATE (10222 author_secret) renders 🔒 and MATCHES the permalink byte-for-byte', async () => {
  const real = globalThis.fetch
  const privateScope = { statusCode: 10222, statusMsg: 'author_secret' }
  try {
    // The permalink answer first — the card the short link must now match. errorEmbed does not embed
    // the canonical, so a gated permalink and a gated short link render byte-identical bodies.
    globalThis.fetch = async () => new Response(ttWrap(privateScope), { status: 200 })
    const permalink = await (await handle(req(TT_POST, DISCORD), fakeEnv(), ctx, gateShortDeps())).text()
    assert.match(permalink, /This post is private/, 'the permalink shows 🔒 (the control)')

    // The short link — the bug. Same signal, DIFFERENT url shape; it must now give the same answer.
    const env = fakeEnv()
    const short = await (await handle(req(TT_SHORT, DISCORD), env, ctx, gateShortDeps())).text()
    assert.match(short, /This post is private/, 'the short link now shows 🔒 too — the bug is fixed')
    assert.ok(!/couldn't load/i.test(short), 'never the generic failure card')
    assert.ok(!/age-restricted/i.test(short), 'a private gate is not the age embed')
    assert.ok(!/threads\.com/.test(short), 'and never the chooser — it IS a TikTok video-detail page')
    assert.equal(short, permalink, 'SAME post, SAME card — the short link matches its permalink exactly')

    const tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    assert.deepEqual(tt.filter(o => o === 'private'), ['private'], 'private fires exactly once')
    assert.deepEqual(tt.filter(o => o === 'fetch_fail'), ['fetch_fail'], 'stacked with fetch_fail once, no double-count')
    assert.ok(!tt.includes('age_restricted') && !tt.includes('ambiguous'), 'and never age or the chooser')
  } finally { globalThis.fetch = real }
})

test('gated short link: AGE (isContentClassified, no video) renders 🔞, counts age_restricted once', async () => {
  const real = globalThis.fetch
  const ageScope = { statusCode: 0, itemInfo: { itemStruct: {
    id: '7660566211100511518', createTime: '1700000000', desc: 'x', author: { uniqueId: 'u' },
    isContentClassified: true, video: {} } } }
  try {
    globalThis.fetch = async () => new Response(ttWrap(ageScope), { status: 200 })
    const env = fakeEnv()
    const short = await (await handle(req(TT_SHORT, DISCORD), env, ctx, gateShortDeps())).text()
    assert.match(short, /This post is age-restricted/, 'the short link renders 🔞')
    assert.ok(!/This post is private/.test(short) && !/couldn't load/i.test(short), 'distinct from private + generic')
    const tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    assert.deepEqual(tt.filter(o => o === 'age_restricted'), ['age_restricted'], 'age_restricted once')
    assert.deepEqual(tt.filter(o => o === 'fetch_fail'), ['fetch_fail'], 'stacked with fetch_fail once')
    assert.ok(!tt.includes('ambiguous'), 'never the chooser')
  } finally { globalThis.fetch = real }
})

test('gated short link FALSE-POSITIVE GUARD: a DELETED short link (10204) stays GENERIC, never a gate', async () => {
  // THE MUTATION CHECK. A deleted post has no itemStruct either, so the ONLY thing keeping it out of
  // the gate branch is tiktokGate returning undefined for 10204. If the resolver's gate-check ever
  // fired on 10204, this deleted post would flip to a 🔒/🔞 wall and this test would fail.
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(TT_DELETED_HTML, { status: 200 })
    const env = fakeEnv()
    const short = await (await handle(req(TT_SHORT, DISCORD), env, ctx, gateShortDeps())).text()
    assert.match(short, /Couldn't load this TikTok post/, 'a deleted short link is the generic failure')
    assert.ok(!/age-restricted/i.test(short) && !/This post is private/.test(short), 'never a gate message')
    assert.ok(!/threads\.com/.test(short), 'and never the chooser — it IS a TikTok video-detail page')
    const tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    assert.ok(!tt.includes('private') && !tt.includes('age_restricted'), 'no gate counter for 10204')
    assert.ok(tt.includes('fetch_fail'), 'just the ordinary fetch_fail, as the gone branch always did')
  } finally { globalThis.fetch = real }
})

test('gated short link MUST NOT REGRESS: a NORMAL public short link still resolves to the real Post', async () => {
  // The success arm — the fix must be invisible to a healthy public short link, which still builds a
  // Post and reaches the same one-hop media url as its permalink.
  const { net, serving } = ttNetwork()
  const deps = { cache: fakeCache(), fetchPost: liveFetchPost, resolveShortlink: liveResolveShortlink }
  const env = fakeEnv()
  const short = await serving(async () =>
    (await handle(req(TT_SHORT, DISCORD), env, ctx, deps)).text())
  assert.match(short, /Duck/, 'the resolved post, not a gate embed and not a chooser')
  assert.ok(!/couldn't load/i.test(short) && !/This post is (private|age-restricted)/.test(short), 'no gate on a public post')
  assert.equal(net.page, 1, 'ONE page fetch, as before')
  const tt = env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
  assert.ok(tt.includes('ok') && !tt.includes('private') && !tt.includes('age_restricted'), 'counts ok, no gate')
})

test('THE SHORTCODE GRAPHQL QUERY IS TRIED FIRST, and the account feed is never touched when it answers', async () => {
  /**
   * Added 2026-08-02. The account feed is window-limited to Instagram's twelve most recent items —
   * whatever `count` asks for — so a blocked reel further back was unrecoverable by it. The GraphQL
   * surface is addressed BY THE POST, so no window applies; measured on the reported reel at HTTP 200,
   * 21.6 KB, 429 ms, cookie-free, with video_versions intact.
   *
   * Two things are pinned. That it goes FIRST, because it is ~113x cheaper than the feed walk and the
   * ordering is the entire cost argument. And that a hit STOPS there — if the feed were still called
   * afterwards the saving would be imaginary.
   */
  const urls = []
  const real = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      urls.push(String(url))
      if (String(url).includes('/graphql/query/')) {
        // The real envelope: the v1 item, wrapped one level deeper than the feed's.
        assert.match(String(init?.body ?? ''), /doc_id=\d+/, 'sends a doc_id')
        assert.equal(init.headers['x-fb-friendly-name'], 'PolarisPostRootQuery')
        assert.ok(init.headers['x-fb-lsd'], 'and an lsd token matching the body')
        return new Response(JSON.stringify({
          data: {
            xdt_api__v1__media__shortcode__web_info: {
              items: [{
                code: 'DbN6SsKum-9',
                media_type: 2,
                image_versions2: { candidates: [{ url: 'https://example.invalid/c.jpg', width: 720, height: 1280 }] },
                video_versions: [{ url: 'https://scontent.cdninstagram.com/v.mp4', width: 720, height: 1280, type: 101 }],
              }],
            },
          },
        }), { status: 200 })
      }
      return new Response(readFileSync('test/fixtures/instagram-copyright-blocked.html', 'utf8'), { status: 200 })
    }
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DbN6SsKum-9' }, fakeEnv(), 'discord')

    assert.equal(post.media[0].kind, 'video', 'the reel plays')
    assert.ok(urls.some(u => u.includes('/graphql/query/')), 'the shortcode query was asked')
    assert.ok(!urls.some(u => u.includes('/api/v1/feed/user/')),
      'and the 2.4MB account walk was never started')
  } finally {
    globalThis.fetch = real
  }
})

test('A ROTATED doc_id FALLS THROUGH INSTEAD OF FAILING — the reason depending on one is defensible', async () => {
  /**
   * Meta rotates this number; InstaFix's history shows one dying inside about a month, which is why
   * theirs is configurable and ours is too (Env.IG_GRAPHQL_DOC_ID). What makes shipping a magic number
   * acceptable is that its death is not an outage: the query stops carrying the documented root, this
   * returns null, and the older recoveries carry the card at a slower tier.
   *
   * Also pins ASSERT-ON-CONTENT for this surface. Instagram answers refusals at HTTP 200 here — the
   * sibling endpoint's "SecFetch Policy violation." is the standing example — so a 200 with the wrong
   * body must count as no recovery, not as success.
   */
  const urls = []
  const real = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      urls.push(String(url))
      if (String(url).includes('/graphql/query/')) {
        // What a dead doc_id actually returns: HTTP 200, and an error envelope.
        return new Response('{"errors":[{"message":"Query with id does not exist"}],"data":null}', { status: 200 })
      }
      if (String(url).includes('/api/v1/feed/user/')) {
        return new Response('{"message":"login_required","status":"fail"}', { status: 403 })
      }
      return new Response(readFileSync('test/fixtures/instagram-copyright-blocked.html', 'utf8'), { status: 200 })
    }
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DbN6SsKum-9' }, fakeEnv(), 'discord')

    assert.ok(urls.some(u => u.includes('/graphql/query/')), 'it tried')
    assert.ok(urls.some(u => u.includes('/api/v1/feed/user/')), 'then fell through to the feed')
    assert.equal(post.media[0].kind, 'video', 'and the container still carries the card')
    assert.ok(post.media[0].remux?.page, 'via the yt-dlp tier, which no Instagram endpoint can revoke')
  } finally {
    globalThis.fetch = real
  }
})
