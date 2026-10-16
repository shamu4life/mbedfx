import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeReddit, redditEmbedSub, redditCaptionSource, REDDIT_SUB } from '../src/platforms/reddit/normalize.ts'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'

/**
 * A POST ON A USER'S PROFILE. The router has always routed /user/{name}/comments/{id} and /r/u_{name}/comments/{id},
 * and embed.reddit.com answers the latter with a full render, but that page's canonical is the /user/ form and
 * the normalizer read only `/r/`: every profile post was the failure card. Found 2026-10-11 by the crosspost
 * research (6 of 30 crossposts in an unbiased sample were posted to a profile). Fixture: the real page,
 * residential, for u_NekkidSnaku/1x1vfk8.
 */

const PROFILE = readFileSync(new URL('./fixtures/reddit-embed-profile.html', import.meta.url), 'utf8')

test('A POST ON A USER\'S PROFILE IS READ, under the subreddit Reddit gives it: u_{name}', () => {
  const post = normalizeReddit({ source: 'embed', html: PROFILE }, { p: 'rd', sub: 'u_NekkidSnaku', id: '1x1vfk8' })
  assert.ok(post, 'not the failure card')
  assert.equal(post.ref.sub, 'u_NekkidSnaku')
  assert.match(post.canonical, /^https:\/\/www\.reddit\.com\/user\/NekkidSnaku\/comments\/1x1vfk8\//, 'the page\'s own address')
  assert.match(post.title, /^Luna is a rare white lioness/)
  assert.equal(post.author.handle, 'NekkidSnaku')
  assert.equal(redditEmbedSub(PROFILE), 'u_NekkidSnaku', 'so a bare or wrong-sub link is asked again under it')
})

test('A USERNAME MAY HOLD A HYPHEN; A SUBREDDIT NAME MAY NOT; NOTHING ELSE REACHES A PATH', () => {
  assert.ok(REDDIT_SUB.test('u_Tough-Driver5143'), 'a real profile sub from the sample')
  assert.ok(REDDIT_SUB.test('DeadlockTheGame'))
  assert.ok(!REDDIT_SUB.test('Tough-Driver5143'), 'a hyphen outside a profile is not a subreddit')
  for (const bad of ['', 'u_a/b', 'u_../x', 'a b', 'r/x', 'u_x?y']) assert.ok(!REDDIT_SUB.test(bad), JSON.stringify(bad))
  const hyphened = PROFILE.replaceAll('/user/NekkidSnaku/', '/user/Tough-Driver5143/')
  assert.equal(redditEmbedSub(hyphened), 'u_Tough-Driver5143')
})

/** Global fetch answered per url prefix; every request recorded. */
async function withHosts(routes, fn) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    asked.push(url)
    for (const [prefix, answer] of routes) if (url.startsWith(prefix)) return answer(url, init)
    return new Response('', { status: 404 })
  }
  try { return await fn(asked) } finally { globalThis.fetch = real }
}
const page = (body, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html' } })
// The /user/ crawler page's description for this post, measured 2026-10-11 (residential): the profile's tagline,
// because the post has no body of its own.
const PROFILE_CRAWLER = '<meta name="description" content="44 subscribers in the u_NekkidSnaku community.">'

test('A /user/ LINK IS ASKED UNDER u_{name}, AND ITS CAPTION AT /user/{name}/, where Reddit answers with meta', async () => {
  // The router gives a /user/{name}/comments/{id} link no sub, so the first ask is the `_` placeholder, whose
  // canonical names the profile. /r/u_{name}/… on the crawler host is a 301 with no meta, so it is never asked.
  await withHosts([
    ['https://embed.reddit.com/', page(PROFILE)],
    ['https://www.reddit.com/user/NekkidSnaku/comments/1x1vfk8/', page(PROFILE_CRAWLER, 301)],
  ], async (asked) => {
    const ref = { p: 'rd', sub: '', id: '1x1vfk8' }
    const got = await fetchReddit(ref, {})
    const post = normalizeReddit(got, ref)
    assert.equal(post.ref.sub, 'u_NekkidSnaku')
    assert.equal(redditCaptionSource(got), 'none', 'the tagline is refused, keyed on u_NekkidSnaku')
    assert.deepEqual(asked, [
      'https://embed.reddit.com/r/_/comments/1x1vfk8/',
      'https://embed.reddit.com/r/u_NekkidSnaku/comments/1x1vfk8/',
      'https://www.reddit.com/user/NekkidSnaku/comments/1x1vfk8/',
    ])
  })
})
