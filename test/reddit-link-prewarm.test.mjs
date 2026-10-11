import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { liveFetchPost } from '../src/worker.ts'

/**
 * ITS OWN FILE ON PURPOSE: the prewarm is bounded by SPECULATIVE_MUX_CAP on the module-level muxInflight map,
 * and test/reddit-link.test.mjs parks never-answering muxes there, which would cap this one out before it ran
 * (the same reason card-promise.test.mjs runs its T0 test first). Node runs each file in its own process.
 */

const slow = (ms, value) => new Promise(r => setTimeout(() => r(value), ms))
const retainingCtx = () => ({ waitUntil() {} })
const fakeR2 = () => {
  const store = new Map()
  return {
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get() { return null },
    async put(k, body) { store.set(k, body) },
  }
}

test("THE LINKED VIDEO'S MUX STARTS AS SOON AS THE REDDIT PAGE NAMES IT, before the caption lookup ends", async () => {
  // Review: the first version started it only after the whole Reddit load (embed, caption lookup) and the
  // linked load, up to 2.5 s into Discord's ~10 s window. Through the real liveFetchPost and fetchReddit.
  const page = readFileSync(new URL('./fixtures/reddit-embed-link-youtube.html', import.meta.url), 'utf8')
  const real = globalThis.fetch
  let crawlerAskedAt = 0
  globalThis.fetch = async (u) => {
    const url = String(u)
    if (url.startsWith('https://embed.reddit.com/')) return new Response(page, { status: 200 })
    if (url.startsWith('https://www.reddit.com/r/')) {
      crawlerAskedAt = Date.now()
      await slow(300)
      return new Response('<meta name="description" content="2.4M subscribers in the theydidthemath community. x">', { status: 301 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  try {
    const jobs = []
    const jobsAt = []
    const env = {
      AE: { writeDataPoint() {} }, MEDIA_CACHE: fakeR2(), TRANSLATE_GOOGLE: 'off',
      // Records each job and refuses it, so the dispatch is counted and nothing is left parked.
      // Called as fetch(url, init), as worker.ts calls the container stub.
      MEDIA_RESOLVER: { getByName: () => ({ fetch: async (_url, init) => { jobsAt.push(Date.now()); jobs.push(String(init?.body ?? '')); return new Response('', { status: 502 }) } }) },
    }
    const post = await liveFetchPost({ p: 'rd', sub: 'theydidthemath', id: '1mizdfz' }, env, 'discord', undefined, retainingCtx())
    await slow(20)
    assert.equal(post?.link, 'https://youtu.be/6j7bugx2hvk', 'the Reddit post itself loaded, as before')
    assert.ok(jobs.some(b => b.includes('6j7bugx2hvk')), `the YouTube page was dispatched: ${jobs}`)
    assert.ok(jobsAt[0] <= crawlerAskedAt + 50, `at the embed page (${jobsAt[0] - crawlerAskedAt}ms after the caption lookup began), not after it ended`)
  } finally { globalThis.fetch = real }
})
