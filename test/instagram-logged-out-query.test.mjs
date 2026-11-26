import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchInstagramGraphQLMedia, resetInstagramSessionForTests, shortcodeToPk, cookieHeaderOf, IG_LOGGED_OUT_DOC_ID,
} from '../src/platforms/instagram/fetch.ts'
import { instagramGraphQLCard } from '../src/platforms/instagram/normalize.ts'

/**
 * THE LOGGED-OUT QUERY, the shortcode lookup's second query since 2026-11-24 (fetch.ts
 * fetchInstagramGraphQLMedia). Measured from production with /_igprobe that day: the old query answers
 * "Rate limit exceeded" to this egress every time; this one answered with the post and its video once it
 * sent the homepage's whole cookie jar.
 *
 * SYNTHETIC FIXTURE. The item below has the SHAPE of a real answer captured that day (keys and types
 * only); every value is invented, so no real account, caption or signed url is in this repo.
 */

const CODE = 'DLoggedOut1'
const ITEM = {
  __typename: 'XIGMedia', pk: shortcodeToPk(CODE), code: CODE, id: `${shortcodeToPk(CODE)}_1`,
  taken_at: 1763500000, media_type: 2, product_type: 'clips',
  user: { username: 'fixture_user', full_name: 'Fixture User', profile_pic_url: 'https://scontent.cdninstagram.com/avatar.jpg',
    is_verified: false, is_private: false, pk: '1', id: '1' },
  caption: { pk: '9', text: 'a reel the embed would not serve', created_at: 1763500000 },
  like_count: 1234, comment_count: 56, like_and_view_counts_disabled: false,
  original_width: 720, original_height: 1280,
  image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/poster.jpg', width: 720, height: 1280 }] },
  video_versions: [{ type: 101, url: 'https://scontent.cdninstagram.com/reel.mp4', width: 720, height: 1280 }],
  has_audio: true,
}
const ANSWER = JSON.stringify({ data: { xig_polaris_media: { __typename: 'XIGMedia', pk: ITEM.pk, code: CODE, if_not_gated_logged_out: ITEM } } })
const HOME = '<html><script type="application/json" id="__eqmc">{"l":"LSDTOKEN"}</script></html>'

function homeResponse() {
  const h = new Headers({ 'content-type': 'text/html' })
  h.append('set-cookie', 'csrftoken=CSRF1; Path=/; Secure')
  h.append('set-cookie', 'mid=MID1; Expires=Wed, 24 Nov 2027 00:00:00 GMT; Path=/')
  return new Response(HOME, { headers: h })
}

/** A fake Instagram: the old query rate-limited (as production measured), the rest from `over`. */
function stub(over = {}) {
  const asked = []
  const real = globalThis.fetch
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    asked.push({ url, init })
    if (url.includes('/graphql/query/')) return over.old ? over.old() : new Response('{"message":"Rate limit exceeded","status":"fail"}')
    if (url === 'https://www.instagram.com/') return over.home ? over.home() : homeResponse()
    if (url.includes('/api/v1/web/get_ruling_for_content/')) return new Response('{"status":"ok"}')
    if (url === 'https://www.instagram.com/api/graphql') return over.gql ? over.gql() : new Response(ANSWER)
    throw new Error(`unexpected fetch ${url}`)
  }
  return { asked, restore: () => { globalThis.fetch = real } }
}

beforeEach(() => resetInstagramSessionForTests())

test('A RATE-LIMITED OLD QUERY FALLS THROUGH TO THE LOGGED-OUT ONE, and the card has its video', async () => {
  const { asked, restore } = stub()
  try {
    const text = await fetchInstagramGraphQLMedia(CODE)
    assert.ok(text, 'the logged-out query answered')
    const card = instagramGraphQLCard(text, { p: 'ig', kind: 'reel', code: CODE })
    assert.ok(card, 'the existing card builder reads the re-wrapped answer unchanged')
    assert.equal(card.media[0].kind, 'video')
    assert.equal(card.counts.likes, 1234)
    assert.equal(card.author.handle, 'fixture_user')
    const gql = asked.find(a => a.url === 'https://www.instagram.com/api/graphql')
    const body = new URLSearchParams(gql.init.body)
    assert.equal(body.get('doc_id'), IG_LOGGED_OUT_DOC_ID)
    assert.equal(JSON.parse(body.get('variables')).media_id, shortcodeToPk(CODE))
    assert.equal(gql.init.headers.cookie, 'csrftoken=CSRF1; mid=MID1', 'the whole homepage jar, which is what made it answer')
    assert.equal(gql.init.headers['x-csrftoken'], 'CSRF1', 'csrf once the ruling said ok')
    assert.equal(gql.init.headers['x-fb-lsd'], 'LSDTOKEN')
  } finally { restore() }
})

test('THE HOMEPAGE SESSION IS REUSED: two cards, one ~540 KB homepage load', async () => {
  const { asked, restore } = stub()
  try {
    assert.ok(await fetchInstagramGraphQLMedia(CODE))
    assert.ok(await fetchInstagramGraphQLMedia(CODE))
    assert.equal(asked.filter(a => a.url === 'https://www.instagram.com/').length, 1)
  } finally { restore() }
})

test('A DECOY PAGE IS NO ANSWER, and it drops the session so the next card starts clean', async () => {
  const { asked, restore } = stub({ gql: () => new Response('<!DOCTYPE html><html>log in</html>') })
  try {
    assert.equal(await fetchInstagramGraphQLMedia(CODE), null)
    assert.equal(await fetchInstagramGraphQLMedia(CODE), null)
    assert.equal(asked.filter(a => a.url === 'https://www.instagram.com/').length, 2, 'session dropped after the decoy')
  } finally { restore() }
})

test('AN ITEM FOR ANOTHER CODE, OR NO SESSION, IS NO ANSWER', async () => {
  let r = stub({ gql: () => new Response(ANSWER.replaceAll(CODE, 'DSomeoneEls')) })
  try { assert.equal(await fetchInstagramGraphQLMedia(CODE), null) } finally { r.restore() }
  resetInstagramSessionForTests()
  r = stub({ home: () => new Response('<html>no token here</html>') })
  try {
    assert.equal(await fetchInstagramGraphQLMedia(CODE), null)
    assert.ok(!r.asked.some(a => a.url.endsWith('/api/graphql')), 'no session, no query')
  } finally { r.restore() }
})

test('A WORKING OLD QUERY IS USED AS BEFORE, and the logged-out one is never asked', async () => {
  const old = JSON.stringify({ data: { xdt_api__v1__media__shortcode__web_info: { items: [ITEM] } } })
  const { asked, restore } = stub({ old: () => new Response(old) })
  try {
    assert.equal(await fetchInstagramGraphQLMedia(CODE), old)
    assert.ok(!asked.some(a => a.url === 'https://www.instagram.com/'), 'no homepage load')
  } finally { restore() }
})

test('THE OUT-PARAMETER NAMES THE QUERY THAT ANSWERED, and stays unset when neither did', async () => {
  // worker.ts counts gql_loggedout off this (analytics.ts has why). The body is unchanged either way:
  // both queries hand back the same envelope, which is why the answer cannot say which one it was.
  let r = stub({ gql: () => new Response(ANSWER.replaceAll(CODE, 'DViaLogOut1')) })
  try {
    const answered = {}
    assert.ok(await fetchInstagramGraphQLMedia('DViaLogOut1', undefined, answered))
    assert.equal(answered.via, 'logged_out')
  } finally { r.restore() }
  resetInstagramSessionForTests()
  const old = JSON.stringify({ data: { xdt_api__v1__media__shortcode__web_info: { items: [{ ...ITEM, code: 'DViaOldQry1' }] } } })
  r = stub({ old: () => new Response(old) })
  try {
    const answered = {}
    assert.equal(await fetchInstagramGraphQLMedia('DViaOldQry1', undefined, answered), old)
    assert.equal(answered.via, 'post_root')
  } finally { r.restore() }
  resetInstagramSessionForTests()
  r = stub({ gql: () => new Response('<!DOCTYPE html><html>log in</html>') })
  try {
    const answered = {}
    assert.equal(await fetchInstagramGraphQLMedia('DViaNeithr1', undefined, answered), null)
    assert.equal('via' in answered, false)
  } finally { r.restore() }
})

test('cookieHeaderOf keeps every cookie and survives the comma inside Expires', () => {
  assert.equal(cookieHeaderOf(homeResponse()), 'csrftoken=CSRF1; mid=MID1')
  assert.equal(cookieHeaderOf(null), '')
})
