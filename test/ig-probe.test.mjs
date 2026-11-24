import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeInstagramGraphQL, shortcodeToPk, probeMessage, bodyKind, IG_PROBE_SHORTCODE, IG_NEW_DOC_ID } from '../src/platforms/instagram/probe.ts'
import { handle } from '../src/worker.ts'

/** /_igprobe (2026-11-24): which Instagram GraphQL query answers from the Worker's egress. */

test('shortcodeToPk decodes base64url digits to the media pk, as yt-dlp does', () => {
  assert.equal(shortcodeToPk('B'), '1')
  assert.equal(shortcodeToPk('BA'), '64')
  assert.equal(shortcodeToPk('_'), '63')
  assert.equal(shortcodeToPk('a!'), '', 'a character outside the table is no pk at all')
})

test('probeMessage strips urls and bounds the text; bodyKind tells json from a decoy page', () => {
  assert.equal(probeMessage('{"message":"Rate limit exceeded"}'), 'Rate limit exceeded')
  assert.equal(probeMessage('{"message":"see https://www.instagram.com/x?sig=SECRET now"}'), 'see <url> now')
  assert.ok(probeMessage(`{"message":"${'x'.repeat(300)}"}`).length <= 80)
  assert.equal(probeMessage('<html>'), '')
  assert.equal(bodyKind(' {"a":1}'), 'json')
  assert.equal(bodyKind('<!DOCTYPE html><html>'), 'html')
  assert.equal(bodyKind(''), 'empty')
})

/** A fake Instagram that answers each step from a table and records what was asked. */
function fakeInstagram(answers) {
  const asked = []
  const f = async (url, init = {}) => {
    asked.push({ url: String(url), init })
    for (const [prefix, make] of answers) if (String(url).startsWith(prefix)) return make(init)
    return new Response('', { status: 404 })
  }
  return { asked, f }
}

const SIGNED = 'https://scontent.cdninstagram.com/v/t50/x.mp4?oh=SECRET'

test('a working new path is reported step by step, with no url, token or body in the answer', async () => {
  const { asked, f } = fakeInstagram([
    ['https://www.instagram.com/graphql/query/', () => new Response('{"errors":[{"message":"Rate limit exceeded"}]}')],
    ['https://www.instagram.com/api/v1/web/get_ruling_for_content/', () => new Response('{"status":"ok"}')],
    ['https://www.instagram.com/api/graphql', () => new Response(
      `{"data":{"xig_polaris_media":{"if_not_gated_logged_out":{"video_versions":[{"url":"${SIGNED}"}]}}}}`)],
    ['https://www.instagram.com/', () => new Response(
      '<html><script id="__eqmc" type="application/json">{"l":"LSDTOKEN"}</script></html>',
      { headers: { 'set-cookie': 'csrftoken=CSRFTOKEN; Path=/; Secure' } })],
  ])
  const out = await probeInstagramGraphQL(f)
  assert.equal(out.shortcode, IG_PROBE_SHORTCODE)
  assert.equal(out.old.message, 'Rate limit exceeded')
  assert.equal(out.old.root, false)
  assert.deepEqual([out.new.home.lsd, out.new.home.csrf, out.new.ruling.ok], [true, true, true])
  assert.deepEqual([out.new.graphql.root, out.new.graphql.notGated, out.new.graphql.video, out.new.graphql.kind],
    [true, true, true, 'json'])
  const text = JSON.stringify(out)
  for (const leak of ['SECRET', 'LSDTOKEN', 'CSRFTOKEN', 'cdninstagram']) assert.ok(!text.includes(leak), `${leak} leaked`)
  const gql = asked.find(a => a.url === 'https://www.instagram.com/api/graphql')
  const body = new URLSearchParams(gql.init.body)
  assert.equal(body.get('doc_id'), IG_NEW_DOC_ID)
  assert.equal(body.get('lsd'), 'LSDTOKEN')
  assert.equal(JSON.parse(body.get('variables')).media_id, shortcodeToPk(IG_PROBE_SHORTCODE))
  assert.equal(gql.init.headers['x-csrftoken'], 'CSRFTOKEN', 'csrf only once the ruling says ok, as yt-dlp does')
  assert.ok(asked.length <= 5, 'at most five requests to Instagram per run')
})

test('a decoy page and a network failure read as answers, never as a throw', async () => {
  const { f } = fakeInstagram([
    ['https://www.instagram.com/api/graphql', () => new Response('<!DOCTYPE html><html>login</html>')],
    ['https://www.instagram.com/api/v1/', () => new Response('', { status: 400 })],
    ['https://www.instagram.com/graphql/query/', () => { throw new TypeError('connection reset') }],
    ['https://www.instagram.com/', () => new Response('<html></html>')],
  ])
  const out = await probeInstagramGraphQL(f)
  assert.equal(out.old.status, 0)
  assert.deepEqual([out.new.ruling.status, out.new.ruling.ok], [400, false])
  assert.deepEqual([out.new.graphql.kind, out.new.graphql.root], ['html', false])
  assert.equal(out.new.graphql.status, 200, 'a 200 decoy is reported as what it is, not trusted')
})

test('/_igprobe answers from the cache for five minutes, so a loop cannot spend Instagram\'s patience', async () => {
  const store = new Map()
  const cache = { async match(k) { const v = store.get(k); return v ? v.clone() : undefined }, async put(k, v) { store.set(k, v.clone()) } }
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('{}') }
  const waits = []
  const ctx = { waitUntil(p) { waits.push(p) } }
  const deps = { cache, fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }), resolveRedditShare: async () => null }
  const env = { AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } }
  try {
    const a = await handle(new Request('https://mbedfx.app/_igprobe'), env, ctx, deps)
    await Promise.all(waits)
    const first = calls
    const b = await handle(new Request('https://mbedfx.app/_igprobe'), env, ctx, deps)
    assert.equal(a.status, 200)
    assert.match(a.headers.get('cache-control'), /max-age=300/)
    assert.ok(first >= 1 && first <= 5)
    assert.equal(calls, first, 'the second hit asked Instagram nothing')
    assert.deepEqual(await b.json(), await a.json())
  } finally {
    globalThis.fetch = real
  }
})
