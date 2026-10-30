import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { liveFetchPost } from '../src/worker.ts'
import { IG_NO_VIDEO_NOTE, withNoVideoNote } from '../src/platforms/instagram/normalize.ts'

/**
 * A REEL WE COULD NOT GET THE VIDEO FOR SAYS SO (normalize.ts withNoVideoNote). Reported 2026-10-30 on
 * /reel/DfCz_wfx2zp/: the card was the reel's cover alone, and that cover has Instagram's play button printed into
 * the picture, so people pressed a play button that does nothing.
 *
 * FIXTURE. instagram-gql-refused.json is the shortcode query's whole answer for that reel, captured 2026-10-30 from
 * a Cloudflare Worker (the Workers Playground, colo IAD) with the shipped request: `data: null` and a non-transient
 * field_exception naming the root. A non-Cloudflare host got the same answer, and a working control reel got its
 * video from both, so the refusal is about that reel and not this egress. Fetch is stubbed throughout.
 */

const REFUSED = readFileSync(new URL('./fixtures/instagram-gql-refused.json', import.meta.url), 'utf8')
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

/** Instagram, stubbed: the embed broken (as it answered every reel from a Worker on 2026-10-30), the rest per test. */
function stubInstagram({ code, gql, feedStatus = 404 }) {
  const real = globalThis.fetch
  globalThis.fetch = async (u) => {
    const url = String(u)
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
  return () => { globalThis.fetch = real }
}
const env = { AE: { writeDataPoint() {} } }

test('the reported reel: refused by the shortcode query, no feed, so its card is the cover AND the note', async () => {
  const restore = stubInstagram({ code: 'DfCz_wfx2zp', gql: REFUSED })
  try {
    const post = await liveFetchPost({ p: 'ig', kind: 'p', code: 'DfCz_wfx2zp' }, env, 'discord')
    assert.deepEqual(post.media.map(m => m.kind), ['image'], 'still only the cover: nothing logged out gets this video')
    assert.ok(post.text.startsWith(IG_NO_VIDEO_NOTE), post.text)
    assert.match(post.text, /NI HOWDY MY FELLOW TOMODATCHI$/, 'and the caption is kept after it')
  } finally { restore() }
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
