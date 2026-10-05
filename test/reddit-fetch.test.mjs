import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'
import { normalizeReddit } from '../src/platforms/reddit/normalize.ts'

/**
 * THE GIF SIZE READ, fetch.ts's half of Reddit gif posts looping (2026-10-05). The normalizer decides the
 * entry from the screenview alone; this file only checks what fetch.ts asks i.redd.it, how little it reads,
 * and that every way the read can fail costs the size and nothing else. The network is stubbed throughout:
 * the embed page is the real capture in test/fixtures, and the gif's ten bytes are the ones read from the
 * dev sandbox (not a Worker) for i.redd.it/4gg2f32z3qsh1.gif: GIF89a, 320x240.
 */

const GIF_PAGE = readFileSync(new URL('./fixtures/reddit-embed-gif.html', import.meta.url), 'utf8')
const GIF_URL = 'https://i.redd.it/4gg2f32z3qsh1.gif'
const GIF_HEAD = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])
const REF = { p: 'rd', sub: 'forsen', id: '1wuh1g1' }
const ENV = {}

/** Run `fn` with global fetch answering the embed page and handing every other url to `gif`. */
async function withFetch(gif, fn, page = GIF_PAGE) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    asked.push({ url, init })
    if (url.startsWith('https://embed.reddit.com/')) return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })
    return gif(url, init)
  }
  try { return await fn(asked) } finally { globalThis.fetch = real }
}

test('a Reddit gif\'s size costs ONE ten-byte ranged GET of the original, asking for an image and following no redirect', async () => {
  /**
   * Each header is a measured requirement, from the dev sandbox on 2026-10-05: `range: bytes=0-9` is
   * answered 206 with ten bytes (so a 99 MB gif costs ten bytes), and an Accept listing text/html is sent
   * a 307 to Reddit's HTML viewer instead of the file. One request, never two: the read is NO-RETRY.
   */
  await withFetch(async () => new Response(GIF_HEAD, { status: 206, headers: { 'content-type': 'image/gif', 'content-range': 'bytes 0-9/556483' } }), async (asked) => {
    const got = await fetchReddit(REF, ENV)
    assert.equal(got.ok, true)
    assert.deepEqual([...got.gifHead], [...GIF_HEAD])
    const probes = asked.filter(a => !a.url.startsWith('https://embed.reddit.com/'))
    assert.equal(probes.length, 1, 'exactly one read of the gif')
    const [{ url, init }] = probes
    const h = new Headers(init.headers)
    assert.equal(url, GIF_URL, 'the url the screenview names, nothing else')
    assert.equal(h.get('range'), 'bytes=0-9')
    assert.doesNotMatch(h.get('accept') || '', /text\/html/, 'an Accept with text/html is answered with an HTML page')
    assert.equal(init.redirect, 'manual')
    assert.ok(init.signal, 'bounded by a timeout')
    assert.deepEqual(normalizeReddit(got, REF).media, [{ kind: 'gif', url: GIF_URL, w: 320, h: 240 }])
  })
})

test('every way the size read can fail costs the SIZE, never the card, the kind or the url', async () => {
  /**
   * The read runs inside the head's whole-response budget on a cold first paste, so it must never turn a
   * card into a failure, and it must never change what index 0 is: a probe that can fail transiently
   * deciding the kind would give two renders of one post two kinds, the poisoned-url defect.
   */
  const failures = {
    'a thrown fetch': async () => { throw new TypeError('connection reset') },
    'a timeout': async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') },
    'the 307 to the HTML viewer': async () => new Response('<html>redirecting</html>', { status: 307, headers: { location: 'https://www.reddit.com/media?url=x' } }),
    'a 200 with a page in it': async () => new Response('<!DOCTYPE html><html>', { status: 200 }),
    'a 403': async () => new Response('blocked', { status: 403 }),
    'an empty body': async () => new Response(null, { status: 206 }),
    'a short body': async () => new Response(GIF_HEAD.slice(0, 7), { status: 206 }),
  }
  for (const [why, gif] of Object.entries(failures)) {
    await withFetch(gif, async (asked) => {
      const got = await fetchReddit(REF, ENV)
      assert.equal(got.ok, true, `${why}: the post still loads`)
      assert.equal(asked.filter(a => a.url === GIF_URL).length, 1, `${why}: asked once, not retried`)
      const post = normalizeReddit(got, REF)
      assert.deepEqual(post.media, [{ kind: 'gif', url: GIF_URL, w: 0, h: 0 }], `${why}: same entry, no size`)
      assert.equal(post.title, 'this man is deranged', `${why}: the rest of the card is untouched`)
    })
  }
})

test('a server that ignores the Range header still costs ten bytes of reading, then the stream is cancelled', async () => {
  // A 99 MB gif (the largest measured) must not be pulled into the isolate because one edge skipped Range.
  let pulled = 0
  let cancelled = false
  const big = new ReadableStream({
    pull(c) { pulled++; c.enqueue(pulled === 1 ? Uint8Array.from([...GIF_HEAD.slice(0, 4)]) : pulled === 2 ? Uint8Array.from([...GIF_HEAD.slice(4), 1, 2, 3]) : new Uint8Array(65536)) },
    cancel() { cancelled = true },
  })
  await withFetch(async () => new Response(big, { status: 200, headers: { 'content-type': 'image/gif' } }), async () => {
    const got = await fetchReddit(REF, ENV)
    assert.deepEqual([...got.gifHead], [...GIF_HEAD], 'the first ten bytes, across two chunks')
    assert.ok(pulled <= 3, `stopped reading at ten bytes, pulled ${pulled} chunks`)
    assert.equal(cancelled, true, 'and released the rest')
  })
})

test('a post that is not a Reddit gif costs no extra request', async () => {
  const image = GIF_PAGE.replace(/&quot;url&quot;:&quot;https:\/\/i\.redd\.it\/4gg2f32z3qsh1\.gif&quot;/, '&quot;url&quot;:&quot;https://i.redd.it/4gg2f32z3qsh1.jpg&quot;')
    .replace(/&quot;type&quot;:&quot;gif&quot;/g, '&quot;type&quot;:&quot;image&quot;')
  assert.notEqual(image, GIF_PAGE, 'precondition: the screenview was rewritten')
  await withFetch(async () => { throw new Error('no gif read may happen for a .jpg post') }, async (asked) => {
    const got = await fetchReddit(REF, ENV)
    assert.equal(got.ok, true)
    assert.equal(got.gifHead, undefined)
    assert.deepEqual(asked.map(a => new URL(a.url).host), ['embed.reddit.com'])
  }, image)
})
