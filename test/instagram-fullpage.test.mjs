import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  instagramFullPageCard, instagramPrivateGate, normalizeInstagram, recoveredMediaFrom,
  withRecoveredVideo,
} from '../src/platforms/instagram/normalize.ts'

/**
 * THE FALSE 🔒, reported 2026-07-26: instagram.com/reel/DZghoo7PAzi/ rendered "This post is private"
 * on the live apex while instagram7 served it fine. It is not private. It is a PUBLIC reel by
 * @fixture8.example — 12K likes, 215 comments — whose full page carries a complete og: set.
 *
 * THE MECHANISM, and it is an egress difference rather than a parsing bug. The embed endpoint answers
 * our datacenter with the ~81KB "unavailable" shell (captured here as instagram-embed-shell.html), so
 * normalizeInstagram returns null and the worker falls back to the full page for a gate signal.
 * instagramPrivateGate's rule is "a username with no data-media-type" — and on the page Cloudflare
 * receives that is TRUE for this public post, so it claims private.
 *
 * Measured asymmetry, and the reason this defect was invisible until it hit production: from a
 * RESIDENTIAL host the same full page makes instagramPrivateGate return undefined, so the bug does not
 * reproduce off-datacenter at all. The gate's "egress-confirmed 2026-07-21" note is honest but proves
 * only that it catches TRUE positives; nothing ever confirmed it avoids FALSE ones.
 *
 * THE FIX IS A POSITIVE CONTENT READ BEATING A NEGATIVE INFERENCE. The full page HAS the post — title,
 * author, caption, cover image — so we build a card from what is there instead of inferring a wall
 * from what is missing. 'private' becomes the LAST resort, reached only when the page carries no post.
 */
const FULL = readFileSync(new URL('./fixtures/instagram-fullpage-public.html', import.meta.url), 'utf8')
const SHELL = readFileSync(new URL('./fixtures/instagram-embed-shell.html', import.meta.url), 'utf8')
const FEED = readFileSync(new URL('./fixtures/instagram-user-feed-datsun.json', import.meta.url), 'utf8')

const REF = { p: 'ig', kind: 'p', code: 'DZghoo7PAzi' }

test('THE EMBED GENUINELY FAILS — the precondition, so this is not a strawman', () => {
  assert.equal(normalizeInstagram(SHELL, REF), null, 'the ~81KB shell yields no post')
})

test('instagramFullPageCard: the public reel becomes a REAL card, not a 🔒', () => {
  const post = instagramFullPageCard(FULL, REF)
  assert.ok(post, 'the full page carries the post')
  // og:title is `{Display Name} on Instagram: "{caption}"`, so this surface yields a REAL display
  // name — something the embed blob never carries (its owner object has no full_name, so the blob
  // path always falls back to the handle). The degraded path is strictly better-named than the happy one.
  assert.equal(post.author.name, 'Drew’s Datsun', 'the display name, not the handle')
  assert.equal(post.author.handle, 'fixture8.example', 'the handle comes from og:url, not a guess')
  assert.match(post.text, /You had to PAY to be in this meet/, 'the real caption')
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'image', 'the page has og:image but no og:video')
  assert.match(post.media[0].url, /cdninstagram\.com/)
})

test('THE HANDLE IS READ FROM og:url — it is what unlocks the feed recovery', () => {
  // og:url is https://www.instagram.com/fixture8.example/reel/DZghoo7PAzi/ — the ONLY place on this page
  // the handle appears in a form we can trust. Without it there is no feed url to build, so this is
  // load-bearing for the video, not just cosmetic for the byline.
  const post = instagramFullPageCard(FULL, REF)
  assert.equal(post.author.handle, 'fixture8.example')
  assert.equal(post.author.url, 'https://www.instagram.com/fixture8.example/')
})

test('AND THEN THE VIDEO COMES BACK — full page for identity, feed for media', () => {
  // The end-to-end point of the whole change: a post that rendered "🔒 private" becomes a playing
  // video. Same feed surface the copyright-blocked recovery uses; this case just reaches it via the
  // full page because the embed gave us nothing at all to gate on.
  const card = instagramFullPageCard(FULL, REF)
  const rec = recoveredMediaFrom(FEED, 'DZghoo7PAzi')
  assert.ok(rec, 'the feed carries this shortcode')
  const out = withRecoveredVideo(card, rec)
  assert.equal(out.media[0].kind, 'video')
  assert.ok(out.media[0].poster, 'the og:image survives as the poster')
})

test('instagramFullPageCard is TOTAL and REFUSES a page with no post', () => {
  for (const bad of [null, undefined, 42, '', {}, [], '<html></html>', SHELL]) {
    assert.equal(instagramFullPageCard(bad, REF), null, `${String(bad).slice(0, 20)} carries no post`)
  }
  assert.equal(instagramFullPageCard(FULL, { p: 'rd', sub: 'x', id: 'y' }), null, 'a non-ig ref is not ours')
})

test('PRIVATE IS STILL DETECTABLE — the fix must not disarm the real gate', () => {
  /**
   * The risk in demoting 'private' to a last resort is that a genuinely private post stops being
   * detected and renders a generic failure instead of 🔒. So the gate itself is untouched and still
   * fires on its own shape; what changes is only that a page carrying a POST is answered with the post.
   *
   * Synthetic, and it says so: this project has never captured a real private post's full page from
   * datacenter egress (fetch.ts records that gap). It pins the ORDERING rule, not a measured capture.
   */
  const wall = '<html><head><title>Instagram</title></head><body>{"username":"someone"}</body></html>'
  assert.equal(instagramFullPageCard(wall, REF), null, 'a wall carries no og post -> no card')
  assert.equal(instagramPrivateGate(wall), 'private', 'so the gate still gets its turn')
})

test('A PAGE WITH MEDIA IS NEVER PRIVATE — the pre-existing guard, re-pinned', () => {
  // instagramPrivateGate already refuses to call anything with data-media-type a private wall. That
  // guard is what keeps the two mechanisms from ever both firing on one page.
  assert.equal(instagramPrivateGate('<div data-media-type="GraphVideo"></div>{"username":"x"}'), undefined)
})
