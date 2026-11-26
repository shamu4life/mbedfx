import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle, liveFetchPost } from '../src/worker.ts'
import { resetInstagramSessionForTests, shortcodeToPk } from '../src/platforms/instagram/fetch.ts'

/**
 * WHICH INSTAGRAM STAGE DREW THE CARD, AS THE COUNTERS SAY IT: `embed_ok` and `gql_loggedout`
 * (src/analytics.ts has what each one is for).
 *
 * Both were added after a read-only check on 2026-11-26 had to infer them. Ten fresh public posts
 * probed from production that day were all drawn from the embed page, and no counter said so: the
 * embed's share could only be inferred from the copyright counters that happen to run after it. And
 * `graphql_recovered` was counting the logged-out query's cards under the same name as the old
 * query's, so the next refusal would have looked like the 11-19 outage with no way to say which
 * query went.
 *
 * WHAT THESE PIN: one `embed_ok` for each post the embed page carried, and none for a page that
 * arrived but held no post. `gql_loggedout` stacks on top of the counter that used the logged-out
 * answer, and never replaces it, so `graphql_recovered` and `copyright_gql` keep their meaning.
 *
 * NO NETWORK. `fetch` is stubbed, every test has its own shortcode, and the logged-out query's
 * homepage session (module-level in fetch.ts) is reset before each test. Without the reset, one
 * test's session could answer the next test's query.
 *
 * SYNTHETIC GraphQL ITEMS: the keys the card builders read, every value invented. The two embed
 * pages are the repo's existing captures (instagram-single.html, a single image; and
 * instagram-copyright-blocked.html, a reel whose embed withholds the video).
 */

const fixture = n => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')
const SINGLE = fixture('instagram-single.html')
const BLOCKED = fixture('instagram-copyright-blocked.html')
const BROKEN = '<html><body><div class="EmbedBrokenMedia"></div></body></html>'
const RATE_LIMITED = '{"message":"Rate limit exceeded","status":"fail"}'

/** A v1 item. With no `user` no card can be built from it, but its video still repairs another card. */
const item = (code, { user = true } = {}) => ({
  code, pk: shortcodeToPk(code), taken_at: 1763500000, media_type: 2, product_type: 'clips',
  ...(user ? { user: { username: 'fixture_user', full_name: 'Fixture User', profile_pic_url: 'https://scontent.cdninstagram.com/a.jpg' } } : {}),
  caption: { text: 'a caption' }, like_count: 1, comment_count: 2, original_width: 720, original_height: 1280,
  image_versions2: { candidates: [{ url: `https://scontent.cdninstagram.com/${code}.jpg`, width: 720, height: 1280 }] },
  video_versions: [{ type: 101, url: `https://scontent.cdninstagram.com/${code}.mp4`, width: 720, height: 1280 }],
})
const oldAnswer = (code, o) => JSON.stringify({ data: { xdt_api__v1__media__shortcode__web_info: { items: [item(code, o)] } } })
const loggedOutAnswer = (code, o) => JSON.stringify({ data: { xig_polaris_media: { if_not_gated_logged_out: item(code, o) } } })

/** The full page's og: set, which instagramFullPageCard reads. A reel's page names no video. */
const fullPage = code => `<html><head>
<meta property="og:url" content="https://www.instagram.com/fixture_user/reel/${code}/" />
<meta property="og:title" content="Fixture User on Instagram: &quot;a caption&quot;" />
<meta property="og:image" content="https://scontent.cdninstagram.com/${code}_cover.jpg" />
<meta property="og:description" content="1 likes, 0 comments - fixture_user on November 26, 2026" />
</head><body></body></html>`

function homeResponse() {
  const h = new Headers({ 'content-type': 'text/html' })
  h.append('set-cookie', 'csrftoken=CSRF1; Path=/; Secure')
  h.append('set-cookie', 'mid=MID1; Path=/')
  return new Response('<html><script type="application/json" id="__eqmc">{"l":"LSDTOKEN"}</script></html>', { headers: h })
}

/** A fake Instagram. Every surface not named answers 404, so nothing reaches the real network. */
function stub({ embed, old = RATE_LIMITED, gql = '', page = '' }) {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (u) => {
    const url = String(u)
    if (url.includes('/embed/captioned/')) { seen.push('embed'); return new Response(embed) }
    if (url.includes('/graphql/query/')) { seen.push('old'); return new Response(old) }
    if (url === 'https://www.instagram.com/') { seen.push('home'); return homeResponse() }
    if (url.includes('/api/v1/web/get_ruling_for_content/')) { seen.push('ruling'); return new Response('{"status":"ok"}') }
    if (url === 'https://www.instagram.com/api/graphql') { seen.push('loggedout'); return new Response(gql) }
    if (url.includes('instagram.com/p/')) { seen.push('page'); return new Response(page, { status: page ? 200 : 429 }) }
    seen.push(`other ${url}`)
    return new Response('', { status: 404 })
  }
  return { seen, restore: () => { globalThis.fetch = real } }
}

async function run(code) {
  const points = []
  const env = { AE: { writeDataPoint(p) { points.push(p.blobs) } }, ASSETS: { async fetch() { return new Response('a') } } }
  const deps = {
    cache: { async match() { return undefined }, async put() {} },
    fetchPost: liveFetchPost,
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
    resolveMetaShare: async () => null,
  }
  const req = new Request(`https://mbedfx.app/p/${code}/`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  })
  const res = await handle(req, env, { waitUntil() {} }, deps)
  return { html: await res.text(), ig: points.filter(b => b[0] === 'ig').map(b => b[1]) }
}
const times = (list, name) => list.filter(x => x === name).length

beforeEach(() => resetInstagramSessionForTests())

test('A POST THE EMBED PAGE CARRIES COUNTS embed_ok once, and nothing from the stages behind it', async () => {
  const { seen, restore } = stub({ embed: SINGLE })
  try {
    const { html, ig } = await run('DCntEmbOk01')
    assert.match(html, /og:title" content="nasajpl/, 'the card was drawn from the embed page')
    assert.equal(times(ig, 'embed_ok'), 1)
    assert.equal(times(ig, 'ok'), 1)
    for (const n of ['assert_fail', 'graphql_recovered', 'gql_loggedout', 'fullpage_recovered']) assert.equal(times(ig, n), 0, n)
    assert.deepEqual(seen, ['embed'], 'one request, as before')
  } finally { restore() }
})

test('A PAGE THAT ARRIVED BUT HELD NO POST IS NOT embed_ok: a video with no blob is the route\'s fetch_fail', async () => {
  // hasEmbedPost passes this page (it has a Graph* media type) and normalizeInstagram returns null
  // (the markup path takes only GraphImage). Counting embed_ok on the fetch's ok instead of on the
  // Post would report this drift as a success.
  const page = '<html><body><div class="Embed" data-media-type="GraphVideo" data-media-id="3900000000000000003"></div></body></html>'
  const { restore } = stub({ embed: page })
  try {
    const { ig } = await run('DCntNoPost1')
    assert.equal(times(ig, 'embed_ok'), 0)
    assert.equal(times(ig, 'fetch_fail'), 1)
  } finally { restore() }
})

test('A BROKEN EMBED IS assert_fail AND NO embed_ok, and the old query\'s card counts graphql_recovered alone', async () => {
  const code = 'DCntOldQry1'
  const { seen, restore } = stub({ embed: BROKEN, old: oldAnswer(code) })
  try {
    const { html, ig } = await run(code)
    assert.match(html, /og:video/)
    assert.equal(times(ig, 'assert_fail'), 1)
    assert.equal(times(ig, 'embed_ok'), 0)
    assert.equal(times(ig, 'graphql_recovered'), 1)
    assert.equal(times(ig, 'gql_loggedout'), 0, 'the old query answered, so nothing says logged-out')
    assert.ok(!seen.includes('home'), 'and the logged-out query was never started')
  } finally { restore() }
})

test('THE LOGGED-OUT QUERY\'S CARD COUNTS gql_loggedout ON TOP OF graphql_recovered, never instead of it', async () => {
  const code = 'DCntLogOut1'
  const { seen, restore } = stub({ embed: BROKEN, gql: loggedOutAnswer(code) })
  try {
    const { html, ig } = await run(code)
    assert.match(html, /og:video/)
    assert.equal(times(ig, 'graphql_recovered'), 1, 'graphql_recovered still counts every GraphQL card')
    assert.equal(times(ig, 'gql_loggedout'), 1)
    assert.deepEqual(seen, ['embed', 'old', 'home', 'ruling', 'loggedout'])
  } finally { restore() }
})

test('A LOGGED-OUT ANSWER THAT ONLY REPAIRS THE FULL PAGE\'S CARD counts gql_loggedout beside copyright_gql', async () => {
  // No `user` on the item, so no card can be built from it; the full page draws the card and the
  // answer already in hand gives it its video (the copyright_gql count on the full-page path).
  const code = 'DCntLogOut2'
  const { restore } = stub({ embed: BROKEN, gql: loggedOutAnswer(code, { user: false }), page: fullPage(code) })
  try {
    const { html, ig } = await run(code)
    assert.match(html, /og:video/)
    assert.equal(times(ig, 'graphql_recovered'), 0)
    assert.equal(times(ig, 'fullpage_recovered'), 1)
    assert.equal(times(ig, 'copyright_gql'), 1)
    assert.equal(times(ig, 'gql_loggedout'), 1)
  } finally { restore() }
})

test('A RIGHTS-STRUCK REEL THE LOGGED-OUT QUERY REPAIRS counts embed_ok, copyright_gql and gql_loggedout', async () => {
  // The embed-success path: the embed page carried the post, withheld the video, and the shortcode
  // lookup put it back. embed_ok and copyright_gql both fire, which is why copyright_gql on this path
  // is a subset of embed_ok.
  const code = 'DCntBlockd1'
  const { seen, restore } = stub({ embed: BLOCKED, gql: loggedOutAnswer(code) })
  try {
    const { html, ig } = await run(code)
    assert.match(html, /og:video/)
    assert.equal(times(ig, 'embed_ok'), 1)
    assert.equal(times(ig, 'copyright_gql'), 1)
    assert.equal(times(ig, 'gql_loggedout'), 1)
    assert.equal(times(ig, 'assert_fail'), 0)
    assert.ok(seen.includes('loggedout'))
  } finally { restore() }
})

test('WHEN NEITHER QUERY ANSWERS, NOTHING SAYS WHICH ONE DID', async () => {
  const code = 'DCntNeithr1'
  const { restore } = stub({ embed: BROKEN, gql: '<!DOCTYPE html><html>log in</html>' })
  try {
    const { ig } = await run(code)
    for (const n of ['graphql_recovered', 'copyright_gql', 'gql_loggedout', 'embed_ok']) assert.equal(times(ig, n), 0, n)
    assert.equal(times(ig, 'fetch_fail'), 1)
  } finally { restore() }
})
