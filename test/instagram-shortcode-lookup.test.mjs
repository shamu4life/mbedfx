import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, liveFetchPost } from '../src/worker.ts'

/**
 * A POST'S AGE MUST NOT DECIDE WHETHER IT CAN BE EMBEDDED.
 *
 * Reported 2026-08-10, and the reporter asked the question this file exists to answer: what does the
 * age of a video have to do with whether it can be embedded? Nothing. It was an accident of the
 * LOOKUP. When Instagram's embed surface returns EmbedBrokenMedia, the recovery searched the author's
 * account feed, which is ordered newest-first and served twelve at a time — so a post fell out of
 * reach purely by being old. Paging that feed only moved the boundary: measured on the reported
 * account, post #49 still failed with a three-page walk.
 *
 * The GraphQL surface addresses a post by its OWN shortcode, so there is no window at all. Measured
 * from Cloudflare egress with `wrangler dev --remote` after wiring it in: post #49 and post #109 both
 * render og:video, where #49 failed before and #109 is nine times beyond the original window.
 *
 * THE ORDER IS THE RULE THIS PINS. Shortcode first because it is correct at any age and ~25 KB in one
 * request; the account feed second because a doc_id is a rotating identifier and the day it rotates
 * the feed is what keeps recent posts working. Losing both at once is a worse outage than either.
 *
 * NO NETWORK. `fetch` is stubbed; each test uses its own shortcode so one test's stub can never
 * answer another's lookup.
 */

const GQL_ROOT = 'xdt_api__v1__media__shortcode__web_info'

/** The GraphQL answer, in the shape the shipped assertion actually checks for. */
const gqlBody = (code) => JSON.stringify({
  data: {
    [GQL_ROOT]: {
      items: [{
        code,
        media_type: 2,
        video_versions: [{ url: `https://scontent.cdninstagram.com/${code}.mp4`, width: 720, height: 1280 }],
        image_versions2: { candidates: [{ url: `https://scontent.cdninstagram.com/${code}.jpg`, width: 720, height: 1280 }] },
        original_width: 720,
        original_height: 1280,
      }],
    },
  },
})

/** The full page, carrying the og: set instagramFullPageCard reads and no video. */
const fullPage = (code, handleName) => `<html><head>
<meta property="og:url" content="https://www.instagram.com/${handleName}/reel/${code}/" />
<meta property="og:title" content="Someone Real on Instagram: &quot;a caption&quot;" />
<meta property="og:image" content="https://scontent.cdninstagram.com/${code}_cover.jpg" />
<meta property="og:description" content="1 likes, 0 comments - ${handleName} on August 10, 2026" />
</head><body></body></html>`

/** The embed, broken exactly as Instagram serves it for these accounts. */
const brokenEmbed = '<html><body><div class="EmbedBrokenMedia"></div></body></html>'

function stub({ code, handleName, gql, feed }) {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (u, init) => {
    const url = String(u)
    if (url.includes('/graphql/query/')) {
      seen.push('graphql')
      return new Response(gql ?? '{}', { status: 200, headers: { 'content-type': 'text/javascript' } })
    }
    if (url.includes('/api/v1/feed/user/')) {
      seen.push('feed')
      return new Response(feed ?? '{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/embed/captioned/')) { seen.push('embed'); return new Response(brokenEmbed, { status: 200 }) }
    if (url.includes('instagram.com/p/')) { seen.push('page'); return new Response(fullPage(code, handleName), { status: 200 }) }
    return real(u, init)
  }
  return { seen, restore: () => { globalThis.fetch = real } }
}

const env = () => ({ AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } })
const ctx = { waitUntil() {} }
const deps = () => ({
  cache: { async match() { return undefined }, async put() {} },
  // The REAL fetcher, because the Instagram chain under test lives inside it.
  fetchPost: liveFetchPost,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
  resolveMetaShare: async () => null,
})
const bot = (code) => new Request(`https://mbedfx.app/reel/${code}/`, {
  headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
})

test('A POST IS LOOKED UP BY ITS SHORTCODE, so its age cannot decide whether it embeds', async () => {
  const code = 'DZxLuleoEoC'
  const { seen, restore } = stub({ code, handleName: 'someone', gql: gqlBody(code) })
  try {
    const res = await handle(bot(code), env(), ctx, deps())
    const html = await res.text()
    assert.equal(res.status, 200)
    assert.match(html, /og:video/, 'the video is recovered without consulting the account feed')
    assert.ok(!seen.includes('feed'), 'the feed is not walked when the shortcode lookup answers')
  } finally { restore() }
})

test('THE ACCOUNT FEED IS THE FALLBACK, not the primary — a rotated doc_id must not take the platform down', async () => {
  // IG_GRAPHQL_DOC_ID exists because a doc_id rotates. When it does, the shortcode lookup returns
  // null (its content assertion refuses anything without the documented root) and recent posts must
  // keep working off the feed exactly as they did before this surface was wired in.
  const code = 'DaZ4Z3CI_4p'
  const feed = JSON.stringify({
    items: [{ code, media_type: 2, video_versions: [{ url: `https://scontent.cdninstagram.com/${code}.mp4` }], original_width: 720, original_height: 1280 }],
    more_available: false,
  })
  const { seen, restore } = stub({ code, handleName: 'someone', gql: '{"data":{}}', feed })
  try {
    const res = await handle(bot(code), env(), ctx, deps())
    const html = await res.text()
    assert.match(html, /og:video/, 'the feed still repairs the post')
    assert.ok(seen.includes('graphql'), 'the shortcode lookup was tried first')
    assert.ok(seen.includes('feed'), 'and the feed was consulted only after it declined')
  } finally { restore() }
})

test('BOTH SURFACES FAILING STILL LEAVES A CARD, never a broken one', async () => {
  // The cover still is what this path shipped before either recovery existed, and it stays the floor.
  const code = 'DVtEcNdiAr0'
  const { seen, restore } = stub({ code, handleName: 'someone', gql: '{"data":{}}', feed: '{"items":[]}' })
  try {
    const res = await handle(bot(code), env(), ctx, deps())
    const html = await res.text()
    assert.equal(res.status, 200)
    assert.match(html, /og:title/, 'the card is still drawn from the full page')
    assert.ok(!/og:video/.test(html), 'and it honestly promises no video it cannot serve')
    assert.deepEqual(seen.filter(x => x === 'graphql' || x === 'feed'), ['graphql', 'feed'])
  } finally { restore() }
})
