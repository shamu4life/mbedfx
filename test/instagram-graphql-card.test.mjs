import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { instagramGraphQLCard } from '../src/platforms/instagram/normalize.ts'
import { fetchInstagramGraphQLMedia } from '../src/platforms/instagram/fetch.ts'
import { handle, liveFetchPost } from '../src/worker.ts'

/**
 * A POST INSTAGRAM'S EMBED CANNOT SERVE IS DRAWN FROM THE SHORTCODE GRAPHQL QUERY, BEFORE THE FULL PAGE.
 *
 * Measured 2026-10-14: any post the embed cannot serve (embedding disabled by its owner, age-gated,
 * private, deleted) depended on the full /p/{code}/ page, which Instagram intermittently refuses to
 * Cloudflare's egress with 302, 302, 429, 429 and empty bodies. A refused page left no card, the query
 * that could have answered was only ever asked after a page had produced one, and a live public post
 * drew the generic failure card: real pastes failed 26% of the time in the week to 10-13.
 *
 * THE FIXTURES are real answers to the shipped request shape, from a residential connection that day,
 * trimmed to the keys the parser reads with no value edited:
 *   instagram-graphql-reel.json      National Geographic's reel DXwiAJ4lMtM (27,737 bytes untrimmed)
 *   instagram-graphql-agegated.json  the 25+ reel DZFDtEhoNPy: `data: null` and a field_exception error
 *                                    whose `path` names the root. A made-up code answered the same.
 *
 * NO NETWORK. `fetch` is stubbed, and each pipeline test uses its own shortcode so one test's stub can
 * never answer another's lookup.
 */

const F = new URL('./fixtures/', import.meta.url)
const load = n => readFileSync(new URL(n, F), 'utf8')
const REEL = load('instagram-graphql-reel.json')
const AGE_ERROR = load('instagram-graphql-agegated.json')
const AGE_PAGE = load('instagram-fullpage-agegated.html')
const ROOT = 'xdt_api__v1__media__shortcode__web_info'
const ref = (code) => ({ p: 'ig', kind: 'p', code })

/** The reel fixture, answering for another shortcode, optionally with its item changed. */
const reelAs = (code, edit = item => item) => {
  const j = JSON.parse(REEL)
  const item = j.data[ROOT].items[0]
  item.code = code
  j.data[ROOT].items[0] = edit(item)
  return JSON.stringify(j)
}

test('THE ITEM IS A WHOLE CARD: author, caption, date, counts and the video, from one ~22 KB answer', () => {
  const post = instagramGraphQLCard(REEL, ref('DXwiAJ4lMtM'))
  assert.ok(post)
  assert.deepEqual({ name: post.author.name, handle: post.author.handle, url: post.author.url },
    { name: 'National Geographic', handle: 'natgeo', url: 'https://www.instagram.com/natgeo/' })
  assert.match(post.author.avatar, /^https:\/\/scontent/)
  assert.equal(post.canonical, 'https://www.instagram.com/reel/DXwiAJ4lMtM/', 'product_type clips is a reel')
  assert.equal(post.createdAt.toISOString(), new Date(1777564803 * 1000).toISOString(), 'taken_at, not a derived date')
  assert.match(post.text, /^National Geographic Explorer/)
  assert.deepEqual(post.counts, { likes: 8333, replies: 71 }, 'views stay out: view_count is null on this surface')
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'video')
  assert.deepEqual([post.media[0].w, post.media[0].h], [720, 1280])
  assert.match(post.media[0].poster, /^https:\/\/scontent/, 'a posterless video drops Discord to plain OpenGraph')
  assert.equal(post.sensitive, false)
})

test('LIKES THE OWNER HID ARE NOT PRINTED, though the item still carries a number', () => {
  const post = instagramGraphQLCard(reelAs('DXwiAJ4lMtM', it => ({ ...it, like_and_view_counts_disabled: true })), ref('DXwiAJ4lMtM'))
  assert.equal(post.counts.likes, undefined)
  assert.equal(post.counts.replies, 71)
})

test('A DATE IN THE WRONG UNIT OR MISSING FALLS BACK TO THE ONE THE SHORTCODE ENCODES, never to a guess', () => {
  const derived = instagramGraphQLCard(reelAs('DXwiAJ4lMtM', ({ taken_at, ...it }) => it), ref('DXwiAJ4lMtM')).createdAt
  assert.equal(derived.getUTCFullYear(), 2026, 'the id-derived date of the same post')
  const ms = instagramGraphQLCard(reelAs('DXwiAJ4lMtM', it => ({ ...it, taken_at: it.taken_at * 1000 })), ref('DXwiAJ4lMtM')).createdAt
  assert.equal(ms.toISOString(), derived.toISOString(), 'milliseconds would be the year 58,000; the window refuses it')
})

test('NO ITEM, NO CARD: an age-gated answer, another post\'s item, junk, a story, a bad handle or no usable media', () => {
  assert.equal(instagramGraphQLCard(AGE_ERROR, ref('DZFDtEhoNPy')), null, 'the 25+ reel answers data:null')
  assert.equal(instagramGraphQLCard(REEL, ref('DXwiAJ4lMtN')), null, 'the item must be the post asked about')
  for (const junk of [null, '', 'nope', '{}', '{"data":{}}', 42]) assert.equal(instagramGraphQLCard(junk, ref('DXwiAJ4lMtM')), null)
  assert.equal(instagramGraphQLCard(REEL, { p: 'ig', kind: 'story', user: 'natgeo', id: '1' }), null)
  assert.equal(instagramGraphQLCard(reelAs('DXwiAJ4lMtM', it => ({ ...it, user: { ...it.user, username: 'a/../b' } })), ref('DXwiAJ4lMtM')), null,
    'the handle becomes author.url, so one that is not a handle is refused, not escaped')
  const offHost = reelAs('DXwiAJ4lMtM', it => ({
    ...it,
    video_versions: it.video_versions.map(v => ({ ...v, url: 'https://evil.example/v.mp4' })),
    image_versions2: { candidates: it.image_versions2.candidates.map(c => ({ ...c, url: 'https://evil.example/i.jpg' })) },
  }))
  assert.equal(instagramGraphQLCard(offHost, ref('DXwiAJ4lMtM')), null, '/_media/ hands these urls to fetch(), so the host rule applies here too')
})

test('THE FETCHER REFUSES THE ERROR ANSWER whose `path` names the root, and keeps the real one', async () => {
  // The bare root name matched the refusal before 2026-10-14; it has to be the key with an object.
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(AGE_ERROR, { status: 200 })
    assert.equal(await fetchInstagramGraphQLMedia('DZFDtEhoNPy'), null)
    globalThis.fetch = async () => new Response(REEL, { status: 200 })
    assert.equal(await fetchInstagramGraphQLMedia('DXwiAJ4lMtM'), REEL)
  } finally {
    globalThis.fetch = real
  }
})

const brokenEmbed = '<html><body><div class="EmbedBrokenMedia"></div></body></html>'

/** Instagram as the Worker meets it: a broken embed, then whatever this test says for the rest. */
function stub({ gql, page }) {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (u) => {
    const url = String(u)
    if (url.includes('/graphql/query/')) { seen.push('graphql'); return new Response(gql, { status: 200 }) }
    if (url.includes('/embed/captioned/')) { seen.push('embed'); return new Response(brokenEmbed, { status: 200 }) }
    if (url.includes('instagram.com/p/')) { seen.push('page'); return page() }
    if (url.includes('/api/v1/feed/user/')) { seen.push('feed'); return new Response('{"items":[]}', { status: 200 }) }
    seen.push(`other ${url}`)
    return new Response('', { status: 404 })
  }
  return { seen, restore: () => { globalThis.fetch = real } }
}

function run(code) {
  const points = []
  const env = { AE: { writeDataPoint(p) { points.push(p.blobs) } }, ASSETS: { async fetch() { return new Response('a') } } }
  const deps = {
    cache: { async match() { return undefined }, async put() {} },
    fetchPost: liveFetchPost,
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
    resolveMetaShare: async () => null,
  }
  const req = new Request(`https://mbedfx.app/reel/${code}/`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  })
  return handle(req, env, { waitUntil() {} }, deps).then(async res => ({ res, html: await res.text(), points }))
}
const outcomes = points => points.filter(b => b[0] === 'ig').map(b => b[1])

test('A REFUSED FULL PAGE NO LONGER MATTERS when the query answers: the card is drawn and the page is never asked for', async () => {
  const code = 'DGqlCardOne'
  const { seen, restore } = stub({ gql: reelAs(code), page: () => new Response('', { status: 429 }) })
  try {
    const { res, html, points } = await run(code)
    assert.equal(res.status, 200)
    assert.match(html, /og:video/)
    assert.match(html, /National Geographic/)
    assert.deepEqual(seen, ['embed', 'graphql'], 'one ~22 KB request after the embed, and no ~950 KB page')
    assert.ok(outcomes(points).includes('graphql_recovered'))
    assert.ok(!outcomes(points).includes('fetch_fail'))
  } finally { restore() }
})

test('THE GATE CARDS ARE UNCHANGED: an age-gated post answers the query with no item and the full page still says 🔞', async () => {
  const code = 'DGqlCardTwo'
  const { seen, restore } = stub({ gql: AGE_ERROR, page: () => new Response(AGE_PAGE, { status: 200 }) })
  try {
    const { points } = await run(code)
    assert.deepEqual(seen, ['embed', 'graphql', 'page'])
    assert.ok(outcomes(points).includes('age_restricted'))
    assert.ok(!outcomes(points).includes('graphql_recovered'))
  } finally { restore() }
})

test('BOTH REFUSED IS TODAY\'S FAILURE CARD, not a new one: no item from the query and a 429 from the page', async () => {
  const code = 'DGqlCardThr'
  const { seen, restore } = stub({ gql: AGE_ERROR, page: () => new Response('', { status: 429 }) })
  try {
    const { res, points } = await run(code)
    assert.equal(res.status, 200, 'a crawler gets the error embed, as before')
    assert.deepEqual(seen.filter(s => s === 'graphql'), ['graphql'], 'the query is asked once, never again for the page\'s card')
    assert.ok(outcomes(points).includes('fetch_fail'))
    assert.ok(!outcomes(points).includes('graphql_recovered'))
  } finally { restore() }
})
