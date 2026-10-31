import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'
import { normalizeReddit } from '../src/platforms/reddit/normalize.ts'
import { relayBase, relayedUrl } from '../src/platforms/reddit/relay.ts'

/**
 * mbedfx's side of the owner's Reddit relay (src/platforms/reddit/relay.ts; the relay itself is relay/server.mjs,
 * tested in test/relay.test.mjs). What has to hold: with the relay configured, the embed page, the archive and
 * the feed go through it, the crawler page does not, an answer the relay marks as the upstream's is final, and
 * everything the relay cannot answer goes direct, counted, exactly as it would with no relay. Fetch is stubbed.
 */

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const RELAY = 'https://mbedfx-relay-test.a.run.app'
const KEY = 'k'.repeat(64)
const BLOCK = "You've been blocked by network security."
const RECORDS = JSON.parse(fx('reddit-blocked-archive.json')).data
const archiveAnswer = id => JSON.stringify({ data: RECORDS.filter(r => r.id === id) })

/** An env with the relay configured and an AE that records rows. */
function relayEnv() {
  const rows = []
  return { rows, env: { REDDIT_RELAY_URL: RELAY, REDDIT_RELAY_KEY: KEY, AE: { writeDataPoint: p => rows.push(p.blobs.slice(0, 2).join(' ')) } } }
}

/**
 * Run `fn` with fetch answering: calls to the relay by `relay(target, redirect, headers)`, everything else by
 * `direct(url)`. Records which went where.
 */
async function withNet({ relay, direct }, fn) {
  const real = globalThis.fetch
  const viaRelay = []
  const viaDirect = []
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    if (url.startsWith(`${RELAY}/fetch?`)) {
      const q = new URL(url).searchParams
      viaRelay.push({ target: q.get('url'), redirect: q.get('redirect'), init })
      return relay(q.get('url'), q.get('redirect'), new Headers(init.headers))
    }
    viaDirect.push(url)
    return direct(url, init)
  }
  try { return await fn({ viaRelay, viaDirect }) } finally { globalThis.fetch = real }
}
const upstream = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'x-relay': 'upstream', ...headers } })

test('only the embed page, the archive and the feed are relayed; Reddit\'s crawler page and every other host go direct', () => {
  for (const u of [
    'https://embed.reddit.com/r/aww/comments/bh1r38/',
    'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=bh1r38',
    'https://www.reddit.com/by_id/t3_bh1r38/.rss',
  ]) assert.equal(relayedUrl(u), true, u)
  for (const u of [
    'https://www.reddit.com/r/aww/comments/bh1r38/', 'https://i.redd.it/4gg2f32z3qsh1.gif', 'https://v.redd.it/z13kdo73uau21/HLSPlaylist.m3u8',
    'http://embed.reddit.com/r/aww/comments/bh1r38/', 'https://oauth.reddit.com/comments/bh1r38',
  ]) assert.equal(relayedUrl(u), false, u)
  assert.equal(relayBase({ REDDIT_RELAY_URL: RELAY, REDDIT_RELAY_KEY: KEY }), RELAY)
  assert.equal(relayBase({ REDDIT_RELAY_URL: `${RELAY}/`, REDDIT_RELAY_KEY: KEY }), RELAY)
  assert.equal(relayBase({ REDDIT_RELAY_URL: RELAY }), null, 'no key, no relay')
  assert.equal(relayBase({ REDDIT_RELAY_KEY: KEY }), null, 'no url, no relay')
  assert.equal(relayBase({ REDDIT_RELAY_URL: 'http://mbedfx-relay-test.a.run.app', REDDIT_RELAY_KEY: KEY }), null, 'never the key over plain http')
})

test('when Reddit gives the relay\'s address the embed page, the card is the FULL embed render again', async () => {
  // The best case the relay exists for: embed.reddit.com refuses Cloudflare (2026-10-22) and not this address.
  const page = fx('reddit-embed-video.html')
  const ref = { p: 'rd', sub: 'interestingasfuck', id: '1es7hb1' }
  const { env, rows } = relayEnv()
  await withNet({
    relay: (target, _r, headers) => {
      assert.equal(headers.get('x-relay-key'), KEY)
      assert.match(headers.get('user-agent'), /Chrome/, 'the request\'s own headers travel with it')
      return upstream(page, 200, { 'content-type': 'text/html' })
    },
    // A video post's page carries no body, so its caption lookup asks Reddit's crawler page, which goes direct.
    direct: () => new Response('<meta name="description" content="2 votes, 3 comments. 61K subscribers in the interestingasfuck community. x">', { status: 301 }),
  }, async ({ viaRelay, viaDirect }) => {
    const got = await fetchReddit(ref, env)
    assert.equal(got.source, 'embed')
    assert.equal(normalizeReddit(got, ref).media[0].kind, 'video')
    assert.equal(viaRelay[0].target, 'https://embed.reddit.com/r/interestingasfuck/comments/1es7hb1/')
    assert.equal(viaRelay[0].init.redirect, 'manual', 'the relay call itself never follows: the relay hands back 3xx as they are')
    assert.deepEqual(viaDirect, ['https://www.reddit.com/r/interestingasfuck/comments/1es7hb1/'], 'only the crawler page went direct')
  })
  assert.ok(rows.includes('rd relay_ok'))
})

test('a block page the relay marks as Reddit\'s is final, so the archive path follows through the relay, with the crawler direct', async () => {
  const ref = { p: 'rd', sub: 'aww', id: 'bh1r38' }
  const { env } = relayEnv()
  await withNet({
    relay: target => target.startsWith('https://embed.reddit.com/')
      ? upstream(BLOCK, 403, { 'content-type': 'text/plain' })
      : upstream(archiveAnswer('bh1r38'), 200, { 'content-type': 'application/json' }),
    direct: url => {
      assert.ok(url.startsWith('https://www.reddit.com/r/aww/comments/bh1r38/'), `only the crawler page goes direct, not ${url}`)
      return new Response(fx('reddit-blocked-video.html'), { status: 301 })
    },
  }, async ({ viaRelay, viaDirect }) => {
    const got = await fetchReddit(ref, env)
    assert.equal(got.source, 'archive')
    assert.equal(normalizeReddit(got, ref).title, 'Apparently reptiles like squeaky toys too')
    assert.deepEqual(viaRelay.map(r => new URL(r.target).hostname), ['embed.reddit.com', 'arctic-shift.photon-reddit.com'])
    assert.equal(viaDirect.length, 1)
  })
})

test('a relay that answers for itself, answers unmarked or does not answer falls back to the direct request, and every fallback is counted', async () => {
  const ref = { p: 'rd', sub: 'aww', id: 'bh1r38' }
  for (const [why, relay] of [
    ['a wrong key', () => new Response('missing or wrong x-relay-key\n', { status: 401, headers: { 'x-relay': 'error' } })],
    ['Cloud Run\'s own error page', () => new Response('<html>Service Unavailable</html>', { status: 503 })],
    ['the relay unreachable', () => { throw new TypeError('connection refused') }],
  ]) {
    const { env, rows } = relayEnv()
    await withNet({
      relay,
      direct: url => url.startsWith('https://embed.reddit.com/')
        ? new Response(BLOCK, { status: 403 })
        : url.startsWith('https://arctic-shift')
          ? new Response(archiveAnswer('bh1r38'), { status: 200 })
          : new Response(fx('reddit-blocked-video.html'), { status: 301 }),
    }, async ({ viaDirect }) => {
      const got = await fetchReddit(ref, env)
      assert.equal(got.source, 'archive', `${why}: the card is what it was with no relay`)
      assert.ok(viaDirect.some(u => u.startsWith('https://embed.reddit.com/')), `${why}: the embed page was asked directly`)
      assert.ok(viaDirect.some(u => u.startsWith('https://arctic-shift')), `${why}: the archive was asked directly`)
    })
    assert.ok(rows.filter(r => r === 'rd relay_fallback').length >= 2, `${why}: ${JSON.stringify(rows)}`)
    assert.equal(rows.includes('rd relay_ok'), false)
  }
})

test('the Worker and the real relay agree on the contract: key, url, redirect mode and the upstream mark', async () => {
  // The two halves are written separately (src/platforms/reddit/relay.ts and relay/server.mjs), so this wires
  // one to the other in process: the Worker's requests to the relay go into the relay's own handle(), whose
  // upstream fetch is the stub. A header renamed on one side only fails here.
  const { handle } = await import('../relay/server.mjs')
  const upstreamFetch = async url => url.startsWith('https://embed.reddit.com/')
    ? new Response(BLOCK, { status: 403, headers: { 'content-type': 'text/plain' } })
    : new Response(archiveAnswer('bh1r38'), { status: 200, headers: { 'content-type': 'application/json' } })
  const ref = { p: 'rd', sub: 'aww', id: 'bh1r38' }
  const { env, rows } = relayEnv()
  const real = globalThis.fetch
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    if (url.startsWith(RELAY)) {
      return handle(new Request(url.replace(RELAY, 'http://relay'), { headers: init.headers }), { RELAY_KEY: KEY }, upstreamFetch)
    }
    return new Response(fx('reddit-blocked-video.html'), { status: 301 })
  }
  try {
    const got = await fetchReddit(ref, env)
    assert.equal(got.source, 'archive')
    assert.equal(normalizeReddit(got, ref).createdAt.toISOString(), '2019-04-24T23:47:31.000Z')
  } finally { globalThis.fetch = real }
  assert.deepEqual(rows.filter(r => r.startsWith('rd relay')), ['rd relay_ok', 'rd relay_ok'])
})

test('with no relay configured nothing is sent to one, which is every deploy before the owner sets both secrets', async () => {
  await withNet({
    relay: () => { throw new Error('the relay must not be called') },
    direct: url => url.startsWith('https://embed.reddit.com/')
      ? new Response(BLOCK, { status: 403 })
      : url.startsWith('https://arctic-shift')
        ? new Response(archiveAnswer('bh1r38'), { status: 200 })
        : new Response(fx('reddit-blocked-video.html'), { status: 301 }),
  }, async ({ viaRelay }) => {
    for (const env of [{}, { REDDIT_RELAY_URL: RELAY }, { REDDIT_RELAY_KEY: KEY }]) {
      const got = await fetchReddit({ p: 'rd', sub: 'aww', id: 'bh1r38' }, env)
      assert.equal(got.source, 'archive')
    }
    assert.equal(viaRelay.length, 0)
  })
})
