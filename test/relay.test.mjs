import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_HOSTS, MAX_BYTES, allowedTarget, handle, keyMatches, selftest, startupError } from '../relay/server.mjs'

/**
 * THE REDDIT RELAY (relay/server.mjs): mbedfx's Reddit and archive requests from a Google Cloud Run address,
 * because Cloudflare's is blocked by Reddit and shares the archive's rate limit with every Worker. It runs on
 * the open internet with a URL anyone can find, so what these tests hold is that it is NOT an open proxy: no
 * key, no answer; an off-list host, no request; a redirect is no way out. Fetch is stubbed throughout.
 */

const KEY = 'k'.repeat(40)
const ENV = { RELAY_KEY: KEY }
const req = (path, headers = {}) => new Request(`http://relay${path}`, { headers })
const authed = (path, headers = {}) => req(path, { 'x-relay-key': KEY, ...headers })
const fetchUrl = (url, redirect = 'manual') => `/fetch?url=${encodeURIComponent(url)}&redirect=${redirect}`

/** A fetch stub answering by url, recording every call. */
function stub(answers) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const a = answers[url]
    if (!a) throw new Error(`unexpected fetch ${url}`)
    return typeof a === 'function' ? a() : a.clone()
  }
  return { impl, calls }
}

test('the relay answers nothing without the key, and refuses to start with a short or missing one', async () => {
  const { impl, calls } = stub({})
  for (const headers of [{}, { 'x-relay-key': 'wrong' }, { 'x-relay-key': KEY.slice(1) }]) {
    const res = await handle(req(fetchUrl('https://www.reddit.com/r/aww/comments/bh1r38/'), headers), ENV, impl)
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('x-relay'), 'error', 'the relay\'s own answer, so mbedfx falls back')
  }
  assert.equal(calls.length, 0, 'not one upstream request without the key')
  assert.equal(keyMatches(KEY, KEY), true)
  assert.equal(keyMatches('short', 'short'), false, 'a short configured key matches nothing')
  assert.match(startupError({}), /RELAY_KEY/)
  assert.match(startupError({ RELAY_KEY: 'abc' }), /at least 32/)
  assert.equal(startupError(ENV), null)
})

test('only https urls on the three allowed hosts are asked: no other host, port, scheme or credentials', async () => {
  assert.deepEqual([...ALLOWED_HOSTS].sort(), ['arctic-shift.photon-reddit.com', 'embed.reddit.com', 'www.reddit.com'])
  for (const bad of [
    'https://example.com/', 'http://www.reddit.com/r/aww/', 'https://www.reddit.com:8443/', 'https://user:pw@www.reddit.com/',
    'https://evil.www.reddit.com/', 'https://www.reddit.com.evil.example/', 'https://169.254.169.254/computeMetadata/v1/',
    'file:///etc/passwd', 'not a url', '',
  ]) assert.equal(allowedTarget(bad), null, bad)
  const { impl, calls } = stub({})
  const res = await handle(authed(fetchUrl('https://metadata.google.internal/computeMetadata/v1/')), ENV, impl)
  assert.equal(res.status, 403)
  assert.equal(calls.length, 0)
})

test('an upstream answer comes back as the upstream gave it, marked upstream, with only the headers mbedfx reads', async () => {
  const url = 'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=bh1r38'
  const { impl, calls } = stub({
    [url]: new Response('{"data":null,"error":"Too many requests"}', {
      status: 429, headers: { 'content-type': 'application/json', 'x-ratelimit-reset': '25', 'set-cookie': 'x=1', server: 'cloudflare' },
    }),
  })
  const res = await handle(authed(fetchUrl(url, 'follow'), { 'user-agent': 'mbedfx.app', accept: 'application/json', cookie: 'secret' }), ENV, impl)
  // A 429 is the archive's answer, for mbedfx to judge, so it is relayed as it is rather than as a relay failure.
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('x-relay'), 'upstream')
  assert.equal(res.headers.get('x-ratelimit-reset'), '25')
  assert.equal(res.headers.get('set-cookie'), null)
  assert.equal(await res.text(), '{"data":null,"error":"Too many requests"}')
  const sent = calls[0].init.headers
  assert.deepEqual(sent, { 'user-agent': 'mbedfx.app', accept: 'application/json' }, 'the cookie stays behind')
  assert.equal(calls[0].init.redirect, 'manual', 'redirects are always followed by hand')
})

test('a manual ask returns the 301 itself with its body, and a followed one never leaves the allowed hosts', async () => {
  const crawler = 'https://www.reddit.com/r/aww/comments/bh1r38/'
  const page = '<title>Apparently reptiles like squeaky toys too : r/aww</title>'
  const { impl } = stub({
    [crawler]: new Response(page, { status: 301, headers: { location: '/r/aww/comments/bh1r38/apparently_reptiles_like_squeaky_toys_too/' } }),
    'https://www.reddit.com/r/aww/comments/bh1r38/apparently_reptiles_like_squeaky_toys_too/': new Response('followed', { status: 200 }),
    'https://embed.reddit.com/r/x/comments/1/': new Response('', { status: 302, headers: { location: 'https://example.com/steal' } }),
  })
  const manual = await handle(authed(fetchUrl(crawler)), ENV, impl)
  assert.equal(manual.status, 301)
  assert.equal(manual.headers.get('location'), '/r/aww/comments/bh1r38/apparently_reptiles_like_squeaky_toys_too/')
  assert.equal(await manual.text(), page, 'mbedfx reads the 301\'s own body, so the relay must keep it')
  const followed = await handle(authed(fetchUrl(crawler, 'follow')), ENV, impl)
  assert.equal([followed.status, await followed.text(), followed.headers.get('x-relay-hops')].join(' '), '200 followed 1')
  const off = await handle(authed(fetchUrl('https://embed.reddit.com/r/x/comments/1/', 'follow')), ENV, impl)
  assert.equal(off.status, 502)
  assert.equal(off.headers.get('x-relay'), 'error')
})

test('a relay-side failure is the relay\'s own 502, so mbedfx can tell it from anything the upstream said', async () => {
  const url = 'https://embed.reddit.com/r/aww/comments/bh1r38/'
  const thrown = await handle(authed(fetchUrl(url)), ENV, async () => { throw new TypeError('connection reset') })
  assert.equal(thrown.status, 502)
  assert.equal(thrown.headers.get('x-relay'), 'error')
  const huge = await handle(authed(fetchUrl(url)), ENV, async () => new Response(new Uint8Array(MAX_BYTES + 1)))
  assert.equal(huge.status, 502)
  assert.match(await huge.text(), /size cap/)
})

test('the self-test asks three fixed urls, needs no key, and is kept for a minute so it cannot be used to hammer anyone', async () => {
  const { impl, calls } = stub({
    'https://embed.reddit.com/r/aww/comments/bh1r38/': new Response("You've been blocked by network security.", { status: 403 }),
    'https://www.reddit.com/r/aww/comments/bh1r38/': new Response('<title>Apparently reptiles like squeaky toys too : r/aww</title>', { status: 301, headers: { location: '/r/aww/x/' } }),
    'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=bh1r38': new Response('{"data":[{"id":"bh1r38"}]}', { status: 200 }),
  })
  const first = await selftest(impl, 1_000_000)
  assert.deepEqual([first.embed.status, first.embed.blocked, first.embed.post], [403, true, false])
  assert.deepEqual([first.crawler.status, first.crawler.title], [301, 'Apparently reptiles like squeaky toys too : r/aww'])
  assert.deepEqual([first.archive.status, first.archive.record], [200, true])
  assert.equal(calls.length, 3)
  await selftest(impl, 1_000_000 + 59_000)
  assert.equal(calls.length, 3, 'a second self-test inside the minute asks nobody')
  const viaRoute = await handle(req('/selftest'), {}, impl)
  assert.equal(viaRoute.status, 200, 'no key needed: it takes no input')
})
