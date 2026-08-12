import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { facebookAgeGate, facebookCaptionCard, facebookPostCard } from '../src/platforms/facebook/normalize.ts'

/**
 * FACEBOOK POSTS, which this project has never rendered — the platform was VIDEO-ONLY (watch / reel /
 * share-of-a-video, all via the container's yt-dlp) because the roadmap recorded Meta as decoying the
 * crawler-UA metadata surface from datacenter egress.
 *
 * THAT WAS TRUE OF ONE UA AND FALSE OF THE OTHERS, measured 2026-07-26 on the same post url:
 *
 *   facebookexternalhit/1.1   -> HTTP 200, ZERO BYTES        <- the UA this project sends everywhere
 *   Twitterbot/1.0            -> HTTP 200, 319,851 bytes, full og: set
 *   Discordbot/2.0            -> HTTP 200, 322,740 bytes
 *
 * So Meta serves its OWN crawler an empty body and a competitor's crawler the real page. The gate is
 * the UA, inverted from the assumption, and exactly the shape Instagram's gate has (crawler UA wins
 * there, browser UA gets a decoy) — same lesson, opposite direction, which is why neither platform's
 * conclusion may be carried across to the other.
 *
 * WHAT IT DOES AND DOES NOT UNLOCK, measured over the three links reported 2026-07-26:
 *   /share/Fixture06X/  (multi-image post) -> og set present, ONE image  -> renders
 *   /share/Fixture07X/  (single image)     -> og set present, ONE image  -> renders
 *   /share/Fixture02X/  (text post)        -> NO og tags at all, 3/3 tries -> still nothing
 *
 * MULTI-IMAGE IS A COVER, NOT A GALLERY, and that is a real limit rather than an oversight: the
 * multi-image post's page exposes exactly ONE distinct scontent url (measured by deduping every
 * scontent link in the body), so there is no second picture to emit even though the post has several.
 */
const POST = readFileSync(new URL('./fixtures/facebook-post-page.html', import.meta.url), 'utf8')
const REF = { p: 'fb', kind: 'share', id: 'Fixture06X' }

test('facebookPostCard: an image post becomes a real card', () => {
  const card = facebookPostCard(POST, REF)
  assert.ok(card, 'the page carries the post')
  assert.equal(card.author.name, 'InfoWars', 'og:title is the PAGE name on this surface')
  assert.match(card.text, /viewing this social media post/i, 'og:description is the post body')
  assert.equal(card.media[0].kind, 'image')
  assert.match(card.media[0].url, /fbcdn\.net/)
})

test('A MULTI-IMAGE POST IS A REAL GALLERY — five photos, not a cover', () => {
  /**
   * This was called impossible and it was not. A crawler UA yields the og: set and ONE image, and the
   * first conclusion here was that a gallery needed account credentials. The owner disproved it the
   * obvious way — the post shows every picture in a logged-out incognito window. The missing piece was
   * the REQUEST, not permission: a full browser header set (see fetch.ts) returns the whole page.
   *
   * Recorded because "we tested it and it isn't there" was wrong in a specific, reusable way: a
   * crawler UA is not a weaker browser, it is a DIFFERENT client that Facebook answers differently.
   */
  const card = facebookPostCard(POST, REF)
  assert.equal(card.media.length, 5, 'the post has five photos')
  assert.equal(new Set(card.media.map(m => m.url)).size, 5, 'and no duplicates')
  for (const m of card.media) {
    assert.equal(m.kind, 'image')
    assert.match(m.url, /t39\.30808-6\//, 'the PHOTO bucket; -1 is avatars and must not leak in')
    assert.ok(!m.url.includes('&amp;'), 'entity-decoded, or the signed url 403s')
  }
})

test('THE GALLERY IS ORDERED, AND THE COVER COMES FIRST', () => {
  // Preload order is a fetch-priority artefact (measured 830, 926, 782, 734, 878) and would shuffle
  // between requests. Media ids are evenly spaced and the lowest IS og:image, so ascending id recovers
  // the post's real sequence and puts the cover first — which is the picture Discord shows largest.
  const card = facebookPostCard(POST, REF)
  const ids = card.media.map(m => m.url.match(/t39\.30808-6\/\d+_(\d+)_/)[1])
  assert.deepEqual(ids, [...ids].sort(), 'ascending media id')
  const cover = POST.match(/<meta property="og:image" content="[^"]*t39\.30808-6\/\d+_(\d+)_/)[1]
  assert.equal(ids[0], cover, 'the first attachment is the post cover')
})

test('A SINGLE-IMAGE POST STAYS ONE — the gallery rule must not invent siblings', () => {
  // The control that makes the five above meaningful: the same extraction on a one-photo post of the
  // same type yields exactly one, so the rule is reading the post rather than scraping the page.
  const one = POST.replace(/<link rel="preload" href="[^"]*t39\.30808-6\/\d+_(?!122206800734682898)\d+_[^"]*"[^>]*>/g, '')
  const card = facebookPostCard(one, REF)
  assert.equal(card.media.length, 1)
})

test('THE CARD KEEPS THE SHARE REF — the /_media namespace and cache key must not shift', () => {
  // The card is built from a page reached by FOLLOWING the share redirect, so it is tempting to
  // canonicalise onto the resolved /{page}/posts/{id}/ url. It must not: refKey(ref) is the cache key
  // and the /_media/{refKey}/ namespace, and a ref that changes identity mid-request would strand
  // both. The resolved url belongs in `canonical` (what a human clicks), never in the ref.
  const card = facebookPostCard(POST, REF)
  assert.deepEqual(card.ref, { p: 'fb', kind: 'share', id: 'Fixture06X' })
})

test('A PAGE WITH NO og SET IS NULL — the text post stays honestly unrenderable', () => {
  // Measured 3/3 on /share/Fixture02X/: even with the Twitterbot UA that unlocks the image posts, the
  // text post's page carries no og:title and no og:image. Returning null keeps that an honest
  // extraction failure rather than a card asserting an empty post.
  const noOg = '<html><head><title>Facebook</title></head><body>login login</body></html>'
  assert.equal(facebookPostCard(noOg, REF), null)
})

test('facebookPostCard is TOTAL over junk and refuses a foreign ref', () => {
  for (const bad of [null, undefined, 42, '', {}, [], '<html></html>']) {
    assert.equal(facebookPostCard(bad, REF), null, `${JSON.stringify(bad)} carries no post`)
  }
  assert.equal(facebookPostCard(POST, { p: 'ig', kind: 'p', code: 'x' }), null, 'a non-fb ref is not ours')
})

test('AN og:image THAT IS NOT ON A META CDN IS REFUSED — it feeds the byte proxy', () => {
  // The url is handed to the renderer and can reach fetch(); the host allowlist is the SSRF boundary,
  // and this surface is a page we followed a REDIRECT to, so it is the least trusted input here.
  const swap = (u) => POST.replace(/(<meta property="og:image" content=")[^"]+/, `$1${u}`)
  for (const u of ['http://scontent.xx.fbcdn.net/a.jpg', 'https://evil.example/a.jpg']) {
    assert.equal(facebookPostCard(swap(u), REF), null, `${u} is refused`)
  }
})

test('ENTITIES DECODE — both numeric forms, and an out-of-range escape cannot throw', () => {
  /**
   * Facebook writes apostrophes as `&#039;` (DECIMAL) and emoji as `&#x1f600;` (HEX) in the same
   * document. A hex-only decoder shipped cards reading "Don&#039;t be complicit" — caught end to end
   * on a real post, which is why this pins both forms rather than the one that looked likelier.
   *
   * The out-of-range case is a 500, not a cosmetic bug: String.fromCodePoint THROWS a RangeError above
   * 0x10FFFF, and this runs while building a public response.
   */
  const withText = (t) => POST.replace(/(<meta property="og:description" content=")[^"]*/, `$1${t}`)
  assert.equal(facebookPostCard(withText('Don&#039;t'), REF).text, 'Don’t'.replace('’', "'"))
  assert.equal(facebookPostCard(withText('hi &#x1f600; there'), REF).text, 'hi 😀 there')
  assert.doesNotThrow(() => facebookPostCard(withText('&#x110000; &#999999;'), REF))
  assert.equal(facebookPostCard(withText('&#x110000;'), REF).text, '&#x110000;', 'left as written')
  // &amp; resolves LAST so a poster cannot double-decode their own text into an entity.
  assert.equal(facebookPostCard(withText('&amp;#039;'), REF).text, '&#039;')
})

test('THE 18+ GATE IS READ FROM FACEBOOK\'S OWN ERROR ROUTE, not inferred from absence', () => {
  /**
   * /share/Fixture02X/ is age-gated — a fact the owner supplied, which this code could not observe:
   * the page is 304,440 bytes but carries no og: set and no scontent url, so it looked identical to
   * "empty" from the outside.
   *
   * The inference "substantial page + no og => age-gated" is the SAME defect shape as
   * instagramPrivateGate's "username + no media => private", which shipped a false 🔒 on public posts.
   * Deleted, geo-blocked and login-walled posts would all land in that bucket. So this keys on Meta's
   * own route name instead, found by diffing token sets between a gated and a working page.
   */
  const gated = readFileSync(new URL('./fixtures/facebook-age-gated.html', import.meta.url), 'utf8')
  assert.equal(facebookAgeGate(gated), 'age_restricted')
  assert.equal(facebookPostCard(gated, REF), null, 'and it is still not a renderable post')
  // 0 occurrences on both working image posts, measured across repeat fetches.
  assert.equal(facebookAgeGate(POST), undefined, 'a working post is not gated')
})

test('facebookAgeGate is TOTAL and does not fire on incidental text', () => {
  for (const bad of [null, undefined, 42, '', {}, [], '<html></html>', 'age', 'inappropriate']) {
    assert.equal(facebookAgeGate(bad), undefined, `${JSON.stringify(bad)} is not a gate`)
  }
})

/**
 * A LIVE PUBLIC POST WITH WORDS AND NO PICTURE, which both Facebook surfaces refused at once.
 *
 * /NASA/posts/1304655294363177, captured through Cloudflare egress 2026-08-12. The ~950 KB body is
 * dropped from the fixture (this parser reads the head and the preload links and nothing else) and
 * two real preload links are kept, because their buckets — t39.1997-6 stickers, t39.30808-1 avatars —
 * are the reason fbGallery correctly finds no gallery on it.
 */
const CAPTION_ONLY = readFileSync(new URL('./fixtures/facebook-page-caption-only.html', import.meta.url), 'utf8')

test('A POST WITH A CAPTION AND NO PICTURE IS STILL A POST — but only when asked', () => {
  /**
   * REPORTED, AND THE PREMISE TURNED OUT TO BE WRONG IN A USEFUL WAY. This url was recorded as a post
   * whose fragment "does not server-render at all, with the caption appearing only inside a ServerJS
   * blob". Measured from Cloudflare egress 2026-08-12 it is neither walled nor unrendered:
   *
   *   the page   952,579 bytes, og:title, og:description, og:url — and NO og:image
   *   the plugin  38,448 bytes, Meta's own "This Facebook post is no longer available"
   *
   * Both surfaces answered. The plugin refuses to EMBED the post, and the page card refused it for
   * want of a picture — so the caption sat in og:description while the reader got a failure card.
   *
   * STRICT STAYS STRICT. facebookPostCard is what runs FIRST in worker.ts, ahead of the plugin
   * fragment that carries real photos at real sizes; if it started accepting a page that merely lost
   * its og:image, a picture card could become a text card. The relaxed read is a separate entry
   * point, called last, where the alternative is the failure card.
   */
  assert.equal(facebookPostCard(CAPTION_ONLY, REF), null, 'the strict read still wants a picture')

  const card = facebookCaptionCard(CAPTION_ONLY, REF)
  assert.ok(card, 'and the relaxed one renders the post')
  assert.equal(card.author.name, 'NASA - National Aeronautics and Space Administration')
  assert.match(card.text, /Go, Comet 3I\/ATLAS, go/, 'og:description is the caption')
  assert.equal(card.canonical, 'https://www.facebook.com/NASA/posts/1304655294363177/')
  /**
   * NO MEDIA AT ALL, rather than one entry holding the empty string. An attachment with no url is a
   * picture-shaped hole in the card — the same defect as the `og:image=".../_media/undefined/avatar"`
   * this project shipped once already — and it is reachable now only because the picture is optional.
   */
  assert.deepEqual(card.media, [], 'an absent picture is no attachment, not an empty one')
})

test('THE RELAXED READ IS STILL AN ASSERTION ON CONTENT — a wall is not a caption', () => {
  /**
   * The rule is og:title AND og:description, both present and both content, which is the same shape
   * as facebookPluginCard's "a byline, and either a caption or a picture". What licenses it is a
   * measurement rather than a hope: over the same 35 urls, sampled from Cloudflare egress 2026-08-12,
   * every non-post answer carried NO og tags whatsoever — a login wall at 438,635 bytes on all
   * fourteen /photo/?fbid= urls, a stripped 325,661-byte page, and a deleted post at 325,556.
   *
   * So the shapes that must never become a card are refused for the reason they were always refused:
   * there is no byline in them to read.
   */
  const gated = readFileSync(new URL('./fixtures/facebook-age-gated.html', import.meta.url), 'utf8')
  assert.equal(facebookCaptionCard(gated, REF), null, 'an 18+ page carries no og set and no card')
  const wall = '<!DOCTYPE html><html><head><title>Facebook</title></head><body>'
    + '<div id="loginform"><a href="https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2FNASA">'
    + 'Log in</a></div></body></html>'
  assert.equal(facebookCaptionCard(wall, REF), null, 'a login wall has no byline to read')
  // A title with nothing under it is not a post either — a caption is required when a picture is not.
  const bare = CAPTION_ONLY.replace(/<meta property="og:description"[^>]*>/, '')
  assert.equal(facebookCaptionCard(bare, REF), null, 'a byline alone is not a post')
  for (const bad of [null, undefined, 42, '', {}, [], '<html></html>']) {
    assert.equal(facebookCaptionCard(bad, REF), null, `${JSON.stringify(bad)} carries no post`)
  }
  assert.equal(facebookCaptionCard(CAPTION_ONLY, { p: 'ig', kind: 'p', code: 'x' }), null, 'not our ref')
})

test('THE BYLINE IS NOT PRINTED TWICE — there is no @-handle on the og: surface', () => {
  /**
   * fbAuthor emptied `handle` only on the packed `… | Facebook` shape and left it as the raw og:title
   * otherwise — and og:title on an ordinary page post IS the page name, so name and handle were the
   * same string and render/embed.ts's byline printed "Name (@Name)".
   *
   * Measured from Cloudflare egress 2026-08-12: of 35 sampled post urls, 17 rendered from this
   * surface and not one og:title ended in ` | Facebook`, so every one of them carried the doubled
   * byline. On a reel-shaped title it doubled a view count and a whole caption with it.
   *
   * This is the assertion the old behaviour never had, which is why nothing failed while it shipped.
   */
  for (const [html, who] of [[POST, 'InfoWars'], [CAPTION_ONLY, 'NASA - National Aeronautics and Space Administration']]) {
    const card = facebookCaptionCard(html, REF)
    assert.equal(card.author.name, who)
    assert.equal(card.author.handle, '', 'no handle exists on this surface, so none is invented')
  }
})


/* ============ THE CAPTION READ IS BOUND TO A PAGE FACEBOOK CLAIMS, NOT JUST TO TWO OG TAGS ============
 *
 * Dropping the picture requirement dropped the only structural check this read had. The strict read
 * range-checks the CDN host through fbImage; the plugin read anchors to facebook.com/{page}; this one
 * was left with "og:title is non-empty and og:description is non-empty", which is true of most of the
 * web.
 *
 * WHAT WAS HOLDING IT UP WAS A MEASUREMENT OF SOMEBODY ELSE'S PRODUCT: that Meta's login wall, its
 * stripped page and a deleted post carry no og tags at all, over 35 urls on 2026-08-12. True when
 * measured, and not a promise. A wall that starts emitting a generic og:title/og:description pair
 * would turn this read into a card asserting a post nobody read, and no card would announce it.
 * og:url's HOST is now checked, so the refusal is structural.
 */
test('A DOCUMENT FACEBOOK DOES NOT CLAIM IS REFUSED, even carrying both og tags the read wants', () => {
  const foreign = CAPTION_ONLY.replace('https://www.facebook.com/NASA/posts/1304655294363177/',
    'https://notfacebook.example.com/NASA/posts/1304655294363177/')
  assert.notEqual(foreign, CAPTION_ONLY, 'the fixture must actually have been rewritten')
  assert.equal(facebookCaptionCard(foreign, REF), null, 'the og tags are not enough on their own')
})

test('A LOOKALIKE HOST DOES NOT PASS FOR FACEBOOK — the check is the host, not a substring of it', () => {
  for (const host of ['facebook.com.evil.example', 'notfacebook.com', 'wwwfacebook.com']) {
    const doc = CAPTION_ONLY.replace('www.facebook.com', host)
    assert.equal(facebookCaptionCard(doc, REF), null, `${host} is not facebook.com`)
  }
})

test('A SUBDOMAIN OF FACEBOOK STILL PASSES, because m. and web. are the same product', () => {
  const mobile = CAPTION_ONLY.replace('www.facebook.com/NASA/posts', 'm.facebook.com/NASA/posts')
  assert.ok(facebookCaptionCard(mobile, REF), 'm.facebook.com is Facebook')
})

test('NO og:url AT ALL IS REFUSED, so an absent claim is not read as a claim', () => {
  // The canonical falls back to fbPageUrl(ref) when og:url is missing, which is always a facebook.com
  // url — so checking the FALLBACK would have made this test pass while checking nothing. The raw tag
  // is what is read.
  const stripped = CAPTION_ONLY.replace(/<meta property="og:url"[^>]*>/, '')
  assert.ok(!/og:url/.test(stripped), 'the tag must actually be gone')
  assert.equal(facebookCaptionCard(stripped, REF), null, 'no claim of ownership, no card')
})

test('THE PICTURE PATH IS UNTOUCHED BY THE BINDING, so a normal post cannot regress behind it', () => {
  // The check is on the captionOnly branch only. A post with a real picture passes fbImage's host
  // range-check and must not acquire a new way to fail.
  const noUrl = POST.replace(/<meta property="og:url"[^>]*>/, '')
  assert.ok(facebookPostCard(noUrl, REF), 'a picture post with no og:url still renders')
})
