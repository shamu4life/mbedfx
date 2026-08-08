import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { facebookPluginCard, fbPluginUrl } from '../src/platforms/facebook/normalize.ts'

/**
 * THE EMBED-PLUGIN SURFACE, which is how Facebook posts render at all since 2026-08-08.
 *
 * On that date every ordinary post url started answering this project's datacenter egress with either
 * a login wall or a 300 KB page stripped of its og: tags — permalink, story.php, pfbid and share
 * spellings alike, and in four different client shapes. Meta's own embed endpoint is not behind that
 * wall. facebookPluginCard's docstring carries the measurements.
 *
 * THE FIXTURE IS A REAL CAPTURE, taken through Cloudflare egress rather than from a laptop, because
 * that is the only client whose answer this code will ever see. Ids and the signed CDN query are
 * scrubbed: the tokens are per-request and expire, and the ids name a real post.
 */
const PLUGIN = readFileSync(new URL('./fixtures/facebook-plugin-post.html', import.meta.url), 'utf8')
const REF = { p: 'fb', kind: 'post', id: 'WYFF4_1111111111111111' }

test('the plugin fragment becomes a real card — byline, caption and photo', () => {
  const card = facebookPluginCard(PLUGIN, REF)
  assert.ok(card, 'the fragment carries the post')
  assert.equal(card.author.name, 'WYFF News 4')
  assert.equal(card.author.url, 'https://www.facebook.com/WYFF4', 'the page, not the permalink')
  assert.match(card.text, /^Exclusive Sky 4 footage/, 'the caption, from the fragment body')
  assert.equal(card.media.length, 1)
  assert.match(card.media[0].url, /fbcdn\.net/)
})

test('THE BYLINE IS NESTED AND MUST STILL BE READ — a [^<] capture finds nothing here', () => {
  // The byline is `<a href="…"><span class="…">WYFF News 4</span></a>`. The first version of this
  // regex captured `[^<]`, matched the empty string before the <span>, decided the anchor was
  // textless, and returned null for every post — which looked exactly like the outage it was written
  // to fix. The avatar anchor above it points at the SAME page and genuinely has no text, so
  // "first anchor with text" is the rule, not "first anchor".
  const card = facebookPluginCard(PLUGIN, REF)
  assert.equal(card.author.name, 'WYFF News 4', 'not the empty avatar anchor that precedes it')
})

test('THE POSTER’S AVATAR IS NOT THE POST’S PHOTO — the bucket is the discriminator', () => {
  // `t39.30808-1` is the avatar bucket and `-6` is the photo bucket, the same rule fbGallery uses.
  // The avatar sits EARLIER in the fragment than the photo does, so anything positional picks the
  // profile picture and ships a card whose image is a face.
  const card = facebookPluginCard(PLUGIN, REF)
  assert.equal(card.media.length, 1, 'exactly the post photo')
  assert.ok(!card.media.some(m => m.url.includes('t39.30808-1')), 'no avatar in the media')
})

test('ENTITIES AND EMOJI SURVIVE THE CAPTION — tags are stripped, text is not', () => {
  // Facebook writes the apostrophe as `&#039;` and wraps each emoji in a <span> whose text content is
  // the character. Stripping tags keeps the emoji; decoding after stripping keeps the apostrophe.
  const card = facebookPluginCard(PLUGIN, REF)
  assert.match(card.text, /Denny's parking lot/, 'the decimal entity decoded')
  assert.match(card.text, /⬇️/, 'the emoji survived its wrapper')
  assert.ok(!card.text.includes('<'), 'no markup leaked into the caption')
})

test('THE CANONICAL COMES FROM THE FRAGMENT’S OWN BACK-LINK, without Meta’s embed marker', () => {
  const card = facebookPluginCard(PLUGIN, REF)
  assert.equal(card.canonical, 'https://www.facebook.com/WYFF4/posts/1111111111111111')
  assert.ok(!card.canonical.includes('ref=embed_post'), 'the marker is Meta’s, not part of the url')
})

test('A DATE IS NOT INVENTED — the plugin prints a relative age, which is not a timestamp', () => {
  // The fragment says "on Wednesday", and turning that into a date needs the render time, which is
  // not in the document. The epoch is what the other Facebook surfaces already use for absent; a
  // guessed "now" would be a WRONG date rather than a missing one.
  const card = facebookPluginCard(PLUGIN, REF)
  assert.equal(card.createdAt.getTime(), 0)
})

test('a fragment with no post is an honest failure, and junk cannot throw', () => {
  // Meta answers an unembeddable post with a fragment that renders nothing — measured on a real post
  // whose caption appears ONLY inside a ServerJS blob, with no <p> and no byline anchor. A card
  // asserting an empty post is worse than the failure card the caller already has.
  const empty = '<html><body><div class="_1dwg"></div></body></html>'
  assert.equal(facebookPluginCard(empty, REF), null)
  for (const bad of [null, undefined, 42, '', {}, [], '<html></html>']) {
    assert.equal(facebookPluginCard(bad, REF), null, `${JSON.stringify(bad)} carries no post`)
  }
  assert.equal(facebookPluginCard(PLUGIN, { p: 'ig', kind: 'p', code: 'x' }), null, 'a non-fb ref is not ours')
})

test('fbPluginUrl encodes the post url as a parameter, never splices it', () => {
  // The href is attacker-reachable through a routed ref, and an unencoded splice would let a crafted
  // id add parameters to Meta's endpoint.
  const u = fbPluginUrl('https://www.facebook.com/WYFF4/posts/1111111111111111/')
  assert.equal(u, 'https://www.facebook.com/plugins/post.php?href='
    + 'https%3A%2F%2Fwww.facebook.com%2FWYFF4%2Fposts%2F1111111111111111%2F')
  assert.ok(!u.includes('&'), 'nothing a post url contains can become a second parameter')
})

test('THE PHOTO CARRIES ITS REAL SIZE — render/mastodon.ts drops meta.original on a zero', () => {
  /**
   * `originalMeta` returns null the moment a dimension is 0, so an attachment built without these is
   * handed to Discord with no size and no aspect ratio at all. The og: surface never had dimensions
   * to give; the plugin prints width/height right on the <img>, so there is no reason to ship the
   * zero here. This is the assertion that stops a later "simplification" back to w: 0, h: 0.
   */
  const card = facebookPluginCard(PLUGIN, REF)
  assert.equal(card.media[0].w, 398)
  assert.equal(card.media[0].h, 498)
})
