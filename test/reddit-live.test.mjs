import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle, liveFetchPost } from '../src/worker.ts'

/**
 * REDDIT THROUGH THE REAL FETCHER, end to end: handle() with liveFetchPost as the post loader and only
 * global fetch stubbed, so loadPost's cache writes, the bare-link re-ask and the early linked prewarm run
 * exactly as in production. Added after the second review of the Reddit change (2026-10-11), whose
 * findings the stubbed-fetchPost tests could not see. Its own file: the prewarm is bounded by a
 * module-level map, and Node runs each test file in its own process.
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = url => new Request(url, { headers: { 'user-agent': DISCORD } })
const human = url => new Request(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605' } })
const retainingCtx = () => ({ waitUntil() {} })
const fakeCache = () => {
  const m = new Map()
  return { store: m, async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const fakeR2 = () => ({ async head() { return null }, async get() { return null }, async put() {} })
const deps = () => ({
  cache: fakeCache(), fetchPost: liveFetchPost,
  resolveShortlink: async () => ({ kind: 'unresolved' }), resolveRedditShare: async () => null,
})
const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

async function withFetch(answer, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async (u, init) => answer(String(u), init)
  try { return await fn() } finally { globalThis.fetch = real }
}

test('A FAILED BARE-LINK RE-ASK NEVER BECOMES THE ORDINARY LINK\'S CARD', async () => {
  /**
   * The first fix kept the bare link's stripped render when its re-ask threw, and normalize filed it under
   * the post's canonical key: the ordinary permalink pasted next, with Reddit healthy, drew u/[unknown] and
   * no body, from cache (second review). A placeholder render now keeps the sub it was asked under.
   */
  const stripped = '<html><body><div id="canonical-url-updater" value="https://www.reddit.com/r/buildapc/comments/1x2z546/please_help/"></div>'
    + '<shreddit-screenview-data data="{&quot;post&quot;:{&quot;type&quot;:&quot;text&quot;,&quot;created_timestamp&quot;:1791680000000}}"></body></html>'
  let realAsks = 0
  const d = deps()
  const env = { AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off' }
  await withFetch((url) => {
    if (url.startsWith('https://embed.reddit.com/r/_/')) return new Response(stripped, { status: 200 })
    if (url.startsWith('https://embed.reddit.com/r/buildapc/')) {
      if (++realAsks <= 2) throw new TypeError('connection reset') // askTwice: both attempts of the first re-ask
      return new Response(fx('reddit-embed-text-list.html'), { status: 200 })
    }
    if (url.startsWith('https://www.reddit.com/')) return new Response('', { status: 429 })
    return new Response('', { status: 404 })
  }, async () => {
    const bare = await (await handle(bot('https://mbedfx.app/comments/1x2z546'), env, retainingCtx(), d)).text()
    assert.ok(bare.includes('[unknown]'), 'the bare link got the thinner card, not a failure')
    const permalink = await (await handle(bot('https://mbedfx.app/r/buildapc/comments/1x2z546/please_help/'), env, retainingCtx(), d)).text()
    assert.ok(permalink.includes('Big-Strength151'), 'the ordinary link draws the real author')
    assert.ok(!permalink.includes('[unknown]'))
  })
})

test('A REDDIT LINK TO A VIDEO THAT CAN NEVER MUX COSTS AT MOST ONE CONTAINER CALL PER COLD CACHE', async () => {
  /**
   * The early prewarm (liveFetchPost's rd arm) cannot know the video is over-long, live or gated, so a
   * Reddit post-cache miss may spend one call on it, as a direct paste's head prewarm does. Every request
   * after that, and every person's request, spends none (second review: the stubbed-loader test could not
   * see this path at all).
   */
  const jobs = []
  const env = {
    AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
    MEDIA_CACHE: fakeR2(),
    MEDIA_RESOLVER: { getByName: () => ({ fetch: async (_url, init) => { jobs.push(String(init?.body ?? '')); return new Response('', { status: 502 }) } }) },
  }
  const d = deps()
  const page = fx('reddit-embed-link-youtube.html')
  // The linked video: over the 1500 s mux ceiling, so settleMux refuses it without a call.
  const longVideo = { videoDetails: { videoId: '6j7bugx2hvk', lengthSeconds: '7200', title: 't', author: 'a' } }
  await withFetch((url) => {
    if (url.startsWith('https://embed.reddit.com/')) return new Response(page, { status: 200 })
    if (url.startsWith('https://www.reddit.com/')) return new Response('<meta name="description" content="2.4M subscribers in the theydidthemath community. x">', { status: 301 })
    if (url.includes('youtube.com/youtubei/v1/player')) return Response.json(longVideo)
    if (url.includes('youtube.com/oembed')) return Response.json({ title: 't', author_name: 'a', thumbnail_width: 480, thumbnail_height: 360 })
    return new Response('', { status: 404 })
  }, async () => {
    const status = 'https://mbedfx.app/r/theydidthemath/comments/1mizdfz/x/'
    const api = `https://mbedfx.app/_api/v1?url=${encodeURIComponent('https://www.reddit.com/r/theydidthemath/comments/1mizdfz/x/')}`
    await handle(human(api), env, retainingCtx(), d)
    await handle(human(api), env, retainingCtx(), d)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(jobs.length, 0, 'a person\'s request never prewarms')
    await handle(bot(status), env, retainingCtx(), deps())
    await handle(bot(status), env, retainingCtx(), d)
    await new Promise(r => setTimeout(r, 20))
    // Exactly one: the cold bot request's early prewarm (fresh deps, so a post-cache miss). The warm one
    // after it, and the head's settle, refuse the 2-hour video without a call.
    assert.equal(jobs.length, 1, `one call, on the one cold miss: ${jobs.length}`)
    assert.match(jobs[0], /6j7bugx2hvk/)
  })
})
