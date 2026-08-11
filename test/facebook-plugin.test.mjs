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
/**
 * THE SECOND BYLINE SHAPE, and a photo post with NO CAPTION — two more real captures, taken the same
 * way and scrubbed the same way, added 2026-08-11 while routing photo permalinks. Both were measured
 * returning NULL from this parser before that day, and neither is photo-specific: the byline shape
 * also silenced /NASA/posts/1583701703125200, an ordinary post permalink routed since 2026-08-01.
 */
const UNLINKED = readFileSync(new URL('./fixtures/facebook-plugin-unlinked-byline.html', import.meta.url), 'utf8')
const NOCAPTION = readFileSync(new URL('./fixtures/facebook-plugin-photo-nocaption.html', import.meta.url), 'utf8')
const REF = { p: 'fb', kind: 'post', id: 'WYFF4_1111111111111111' }
const PHOTO_REF = { p: 'fb', kind: 'photo', id: '3333333333333333' }

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

test('THE BYLINE FACEBOOK DOES NOT LINK is still a byline — the avatar carries its own label', () => {
  /**
   * Facebook emits the poster's name in TWO shapes and only one of them is inside an anchor:
   *
   *   <a href="…/WYFF4?ref=embed_post"><span class="_2_79 _50f7">WYFF News 4</span></a>   linked
   *   <div class="_2iem"><span class="_2_79 _50f7">Humans of New York</span>…             NOT linked
   *
   * Measured from Cloudflare egress 2026-08-11 across six real fragments: every @NASA and
   * @humansofnewyork one used the second shape, so this parser returned null for all of them and drew
   * the failure card — for photo permalinks AND for the ordinary /{page}/posts/{id} permalinks routed
   * since 2026-08-01. The fix reads the avatar image's `aria-label`, which carried the page name in
   * all six fragments in both shapes, rather than the `_2_79` class, which is generated and churns.
   */
  const card = facebookPluginCard(UNLINKED, PHOTO_REF)
  assert.ok(card, 'a fragment whose byline is a bare span still carries a post')
  assert.equal(card.author.name, 'Humans of New York')
  assert.equal(card.author.url, 'https://www.facebook.com/humansofnewyork',
    'the avatar’s own anchor is the page, which is what a textless anchor still tells us')
  assert.equal(card.media.length, 1)
  assert.equal(card.media[0].w, 552)
  assert.ok(card.media[0].url.includes('&_nc_ohc='), 'the &amp; in the signed query is decoded, or the CDN 403s')
})

test('THE LINKED BYLINE STILL WINS — the label is a fallback, not a replacement', () => {
  // Additive by construction: the fragment that already rendered must render byte-identically, or
  // this "fix" is a silent rewrite of every working Facebook card. Its avatar's aria-label and its
  // anchor text happen to agree here, so the assertion that matters is the PAGE url, which the
  // fallback would have taken from a different anchor.
  const card = facebookPluginCard(PLUGIN, REF)
  assert.equal(card.author.name, 'WYFF News 4')
  assert.equal(card.author.url, 'https://www.facebook.com/WYFF4', 'the anchor that had text, not the first one')
})

test('A PICTURE POSTED WITH NO WORDS IS STILL A POST — caption OR photo, not caption AND photo', () => {
  /**
   * The rule used to be byline AND caption, and it refused real posts: measured 2026-08-11 from
   * Cloudflare egress, a National Geographic photo carrying a byline, one 552x414 picture and ZERO
   * <p> elements returned null and drew the failure card. A photo posted without a caption is an
   * ordinary thing for a photo to be, and it is exactly what a /photos/ permalink often names.
   *
   * The failure state is still refused — see the test below — so this is a wider content assertion,
   * not the absence of one.
   */
  const card = facebookPluginCard(NOCAPTION, PHOTO_REF)
  assert.ok(card, 'a byline and a picture are a post even with no caption')
  assert.equal(card.text, '', 'the caption is absent, not invented')
  assert.equal(card.media.length, 1)
  assert.deepEqual([card.media[0].w, card.media[0].h], [552, 414])
  // No /posts/ back-link in this fragment, so the canonical falls back to the ref's own url rather
  // than being guessed at.
  assert.equal(card.canonical, 'https://www.facebook.com/photo/?fbid=3333333333333333')
})

test('THE POSTER’S AVATAR IS NEVER THE POST’S PHOTO, even when it is the byline', () => {
  // The avatar is now READ for its label, which puts its `t39.30808-1` url one step closer to the
  // media list than it has ever been. The bucket is still the discriminator and the two paths are
  // separate: a card whose picture is the poster's face is the defect this guards.
  for (const [html, ref] of [[UNLINKED, PHOTO_REF], [NOCAPTION, PHOTO_REF]]) {
    const card = facebookPluginCard(html, ref)
    assert.ok(!card.media.some(m => m.url.includes('t39.30808-1')), 'no avatar in the media')
  }
})

test('a fragment with no post is an honest failure, and junk cannot throw', () => {
  // Meta answers an unembeddable post with a fragment that renders nothing — measured on a real post
  // whose caption appears ONLY inside a ServerJS blob, with no <p> and no byline anchor. A card
  // asserting an empty post is worse than the failure card the caller already has.
  const empty = '<html><body><div class="_1dwg"></div></body></html>'
  assert.equal(facebookPluginCard(empty, REF), null)
  /**
   * THE PLUGIN'S OWN ERROR STATE, measured from Cloudflare egress on a bogus fbid 2026-08-11:
   * 38,109 bytes, no byline anchor, no avatar and therefore no label, zero urls in the photo bucket,
   * and its message in a CLASSED <p> that the bare-<p> caption regex does not match. It must stay
   * null now that a caption is no longer required — that is the whole reason the relaxed rule still
   * demands a byline.
   */
  const gone = '<html><body><div role="feed"><div class="pam uiBoxWhite"><p class="_1q3v">This Facebook post is '
    + 'no longer available. It may have been removed or the privacy settings of the post may have changed.</p>'
    + '</div></div></body></html>'
  assert.equal(facebookPluginCard(gone, PHOTO_REF), null, 'a deleted post must not become a byline-less card')
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
