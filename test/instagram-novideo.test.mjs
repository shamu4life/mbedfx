import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { liveFetchPost } from '../src/worker.ts'
import { IG_AGE_NOTE, IG_NO_VIDEO_NOTE, instagramAudienceGate, withNoVideoNote } from '../src/platforms/instagram/normalize.ts'

/**
 * A REEL WE COULD NOT GET THE VIDEO FOR SAYS SO (normalize.ts withNoVideoNote). Reported 2026-10-30 on
 * /reel/DfCz_wfx2zp/: the card was the reel's cover alone, and that cover has Instagram's play button printed into
 * the picture, so people pressed a play button that does nothing.
 *
 * FIXTURE. instagram-gql-refused.json is the shortcode query's whole answer for that reel, captured 2026-10-30 from
 * a Cloudflare Worker (the Workers Playground, colo IAD) with the shipped request: `data: null` and a non-transient
 * field_exception naming the root. A non-Cloudflare host got the same answer, and a working control reel got its
 * video from both, so the refusal is about that reel and not this egress. instagram-oembed-gates.json is
 * Instagram's oEmbed answer for that reel and three controls, captured from a Worker (EWR) the same day with the
 * request fetchInstagramAudienceGate sends. Fetch is stubbed throughout.
 */

const REFUSED = readFileSync(new URL('./fixtures/instagram-gql-refused.json', import.meta.url), 'utf8')
const GATES = JSON.parse(readFileSync(new URL('./fixtures/instagram-oembed-gates.json', import.meta.url), 'utf8'))
const reelPost = (media, text = 'NI HOWDY MY FELLOW TOMODATCHI') => ({
  ref: { p: 'ig', kind: 'p', code: 'DfCz_wfx2zp' }, canonical: 'https://www.instagram.com/reel/DfCz_wfx2zp/',
  author: { name: 'Jake Sing Chan', handle: 'jakesing_', url: 'https://www.instagram.com/jakesing_/' },
  text, createdAt: new Date('2026-10-28T16:00:45Z'), media, counts: {}, sensitive: false,
})
const cover = { kind: 'image', url: 'https://scontent.cdninstagram.com/cover.jpg', w: 0, h: 0 }

test('a reel that is only its cover says the video could not be loaded, once, ahead of its caption', () => {
  const noted = withNoVideoNote(reelPost([cover]))
  assert.equal(noted.text, `${IG_NO_VIDEO_NOTE}\n\nNI HOWDY MY FELLOW TOMODATCHI`)
  assert.equal(withNoVideoNote(noted).text, noted.text, 'idempotent: a cached post passed through again is not noted twice')
  assert.equal(withNoVideoNote(reelPost([cover], '')).text, IG_NO_VIDEO_NOTE, 'a reel with no caption gets the note alone')
  assert.doesNotMatch(IG_NO_VIDEO_NOTE, /signed.in|login|private|age/i, 'the note names no cause: nothing here can tell which one it was')
})

test('the note is never put on a reel that has its video, nor on a /p/ post, which is as often a photo', () => {
  const video = { kind: 'video', url: 'https://scontent.cdninstagram.com/v.mp4', w: 720, h: 1280, poster: cover.url }
  assert.equal(withNoVideoNote(reelPost([video])).text, 'NI HOWDY MY FELLOW TOMODATCHI')
  const photo = { ...reelPost([cover]), canonical: 'https://www.instagram.com/p/DfCz_wfx2zp/' }
  assert.equal(withNoVideoNote(photo).text, 'NI HOWDY MY FELLOW TOMODATCHI')
  assert.equal(withNoVideoNote(null), null)
})

test('Instagram\'s own gate answer is read as age-restricted only for the two gates measured, never a 403', () => {
  assert.equal(instagramAudienceGate(GATES.reported), 'age_restricted', 'gate 3: the reported reel, age-restricted on its web page')
  assert.equal(instagramAudienceGate(GATES.account25), 'age_restricted', 'gate 12: a 25+ account, MIN_AGE_ACCOUNT')
  // A PUBLIC reel that plays answers 403 "Private media" from this egress. Reading it as a wall would put a
  // false 🔒 or 🔞 on every public reel whose video we merely failed to fetch.
  assert.equal(GATES.publicControl.status, 403)
  assert.equal(instagramAudienceGate(GATES.publicControl), undefined)
  assert.equal(instagramAudienceGate(GATES.madeUp), undefined, 'a made-up code is a 404, not a gate')
})

test('a region block, an unmeasured gate number and junk all fall through to the neutral note', () => {
  const reported = JSON.parse(GATES.reported.body)
  const as = body => ({ status: 400, body: JSON.stringify(body) })
  // Meta labels its age gates `geoblock_required`, so the message proves nothing; a geo RULE is a real region block.
  assert.equal(instagramAudienceGate(as({ ...reported, geo_block_rule_type: 1 })), undefined)
  assert.equal(instagramAudienceGate(as({ ...reported, gating_type_thrift: 5 })), undefined, 'only gates 3 and 12 were measured')
  assert.equal(instagramAudienceGate({ status: 200, body: GATES.reported.body }), undefined, 'the gate is a 400')
  for (const junk of [null, undefined, 'x', {}, { status: 400 }, { status: 400, body: 'not json' }, { status: 400, body: 'null' }]) {
    assert.equal(instagramAudienceGate(junk), undefined, JSON.stringify(junk))
  }
})

test('an age-restricted reel says so instead of the neutral note, marks itself sensitive, and never gets both', () => {
  const noted = withNoVideoNote(reelPost([cover]), 'age_restricted')
  assert.equal(noted.text, `${IG_AGE_NOTE}\n\nNI HOWDY MY FELLOW TOMODATCHI`)
  assert.equal(noted.sensitive, true, 'the YouTube age note marks its card sensitive, and this one matches it')
  assert.equal(withNoVideoNote(noted, 'age_restricted').text, noted.text, 'idempotent')
  assert.equal(withNoVideoNote(noted).text, noted.text, 'a later pass with no gate does not add the neutral note too')
  assert.equal(withNoVideoNote(withNoVideoNote(reelPost([cover])), 'age_restricted').text.includes(IG_AGE_NOTE), false,
    'nor the other way round: one reason per card')
  const video = { kind: 'video', url: 'https://scontent.cdninstagram.com/v.mp4', w: 720, h: 1280, poster: cover.url }
  assert.equal(withNoVideoNote(reelPost([video]), 'age_restricted').text, 'NI HOWDY MY FELLOW TOMODATCHI', 'a reel that plays is never noted')
})

/** Instagram, stubbed: the embed broken (as it answered every reel from a Worker on 2026-10-30), the rest per test. */
function stubInstagram({ code, gql, feedStatus = 404, gate = GATES.publicControl }) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (u) => {
    const url = String(u)
    asked.push(url)
    if (url.includes('/api/v1/oembed/')) {
      if (gate instanceof Error) throw gate
      return new Response(gate.body, { status: gate.status })
    }
    if (url.includes('/embed/captioned/')) return new Response('<html><body><div class="EmbedBrokenMedia"></div></body></html>', { status: 200 })
    if (url.includes('/graphql/query/')) return new Response(gql, { status: 200, headers: { 'content-type': 'text/javascript' } })
    if (url.includes('/api/v1/feed/user/')) return new Response('<!DOCTYPE html><html class="not-logged-in"></html>', { status: feedStatus })
    if (url.includes(`instagram.com/p/${code}/`)) {
      return new Response(`<html><head>
<meta property="og:url" content="https://www.instagram.com/jakesing_/reel/${code}/" />
<meta property="og:title" content="Jake Sing Chan on Instagram: &quot;NI HOWDY MY FELLOW TOMODATCHI&quot;" />
<meta property="og:image" content="https://scontent.cdninstagram.com/${code}_cover.jpg" />
</head><body></body></html>`, { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const restore = () => { globalThis.fetch = real }
  restore.asked = asked
  return restore
}
const points = []
const env = { AE: { writeDataPoint(p) { points.push(p.blobs) } } }

/**
 * REWRITTEN 2026-10-30, same day. This test first pinned the neutral note on the reported reel, because nothing
 * then read a reason. The owner found that Instagram calls the reel age-restricted, and its oEmbed gate answer
 * (the captured fixture) says so in a form the card can read, so the reel now carries the age note. The neutral
 * note keeps its own test below, for a reel Instagram gives no reason for.
 */
test('the reported reel: refused by the shortcode query, no feed, gated by Instagram, so the cover says age-restricted', async () => {
  points.length = 0
  const restore = stubInstagram({ code: 'DfCz_wfx2zp', gql: REFUSED, gate: GATES.reported })
  try {
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DfCz_wfx2zp' }, env, 'discord')
    assert.deepEqual(post.media.map(m => m.kind), ['image'], 'still only the cover: nothing logged out gets this video')
    assert.ok(post.text.startsWith(IG_AGE_NOTE), post.text)
    assert.ok(!post.text.includes(IG_NO_VIDEO_NOTE), 'one reason per card')
    assert.equal(post.sensitive, true)
    assert.match(post.text, /NI HOWDY MY FELLOW TOMODATCHI$/, 'and the caption is kept after it')
    assert.ok(restore.asked.some(u => u.startsWith('https://www.instagram.com/api/v1/oembed/?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FDfCz_wfx2zp%2F')),
      'the measured form of the request: the /reel/ url, encoded')
    assert.ok(points.some(b => b[0] === 'ig' && b[1] === 'reel_age_gated'), JSON.stringify(points))
    // Not the gate counter: that one stacks on fetch_fail, and this card rendered.
    assert.ok(!points.some(b => b[1] === 'age_restricted'), JSON.stringify(points))
  } finally { restore() }
})

test('a reel Instagram gives no reason for, or whose gate cannot be asked, keeps the neutral note', async () => {
  // Its own code per case, so no module-level in-flight map can hand one case's answer to the other.
  for (const [code, gate] of [['DfCz_wfx2zA', GATES.publicControl], ['DfCz_wfx2zB', new TypeError('network down')]]) {
    points.length = 0
    const restore = stubInstagram({ code, gql: REFUSED, gate })
    try {
      const post = await liveFetchPost({ p: 'ig', kind: 'p', code }, env, 'discord')
      assert.ok(post.text.startsWith(IG_NO_VIDEO_NOTE), post.text)
      assert.ok(!post.text.includes(IG_AGE_NOTE))
      assert.notEqual(post.sensitive, true)
      assert.ok(!points.some(b => b[1] === 'reel_age_gated' || b[1] === 'age_restricted'), 'nothing counted as a wall')
    } finally { restore() }
  }
})

test('a reel the shortcode query answers with its video carries no note', async () => {
  const code = 'DZxLuleoEoC'
  const gql = JSON.stringify({ data: { xdt_api__v1__media__shortcode__web_info: { items: [{
    code, media_type: 2, product_type: 'clips', taken_at: 1781874660,
    user: { username: 'someone', full_name: 'Someone' }, caption: { text: 'a caption' },
    video_versions: [{ url: `https://scontent.cdninstagram.com/${code}.mp4`, width: 720, height: 1280 }],
    image_versions2: { candidates: [{ url: `https://scontent.cdninstagram.com/${code}.jpg`, width: 720, height: 1280 }] },
    original_width: 720, original_height: 1280,
  }] } } })
  const restore = stubInstagram({ code, gql })
  try {
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code }, env, 'discord')
    assert.ok(post.media.some(m => m.kind === 'video'), JSON.stringify(post.media))
    assert.ok(!post.text.includes(IG_NO_VIDEO_NOTE))
  } finally { restore() }
})
