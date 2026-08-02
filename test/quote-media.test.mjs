import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { normalizeBluesky } from '../src/platforms/bluesky/normalize.ts'
import { render } from '../src/render/index.ts'
import { toMastodonStatus } from '../src/render/mastodon.ts'
import { pickMedia } from '../src/media.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
import { serializePost, deserializePost } from '../src/cache.ts'

/**
 * Spec §7 — a quoted post's images are hoisted into the PARENT's attachments.
 *
 * Verified against FxEmbed by resolving an attachment's DID: it belongs to the QUOTED author,
 * not the poster, and the CID matches byte for byte. Phase 1 fought a real bug to extract this
 * data at all (Task 6: quote media was always dropped, because `app.bsky.embed.record#viewRecord`
 * carries a plural `embeds` array and no singular `embed`), so dropping it again at render would
 * spend that fix on nothing — and a quote-only post has no picture of its own to fall back to.
 *
 * Everything here is asserted through the PUBLIC surfaces — pickMedia, the Mastodon mapper and
 * the three heads — rather than through mediaList() directly. That is what makes the golden test
 * below meaningful: this file loads and runs against the pre-hoist implementation, so the bytes
 * it pins are the bytes that shipped, not a snapshot of the change under test.
 */

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'
/** The PARENT's refKey, percent-encoded exactly as mediaUrl() emits it. */
const KEY = 'bs%3Aalice.bsky.social%3A3k2a'
const mediaHref = i => `${ORIGIN}/_media/${KEY}/${i}`

const body = r => r.text()
const tagsOf = (html, prop) =>
  [...html.matchAll(new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'g'))].map(m => m[1])
const linksOf = html =>
  [...html.matchAll(/<link rel="alternate" type="([^"]*)" href="([^"]*)"/g)]
    .filter(m => m[1] === 'application/activity+json')
    .map(m => m[2])

/** No quote. The golden fixture: every byte this post renders must survive §7 untouched. */
const solo = {
  ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
  canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  author: {
    name: 'Alice',
    handle: 'alice.bsky.social',
    url: 'https://bsky.app/profile/alice.bsky.social',
    avatar: 'https://cdn.bsky.app/avatar.jpg',
  },
  text: 'hello <world> & "friends"',
  createdAt: new Date('2026-07-01T12:00:00Z'),
  media: [
    { kind: 'image', url: 'https://cdn.bsky.app/a.jpg', w: 800, h: 600, alt: 'a' },
    { kind: 'image', url: 'https://cdn.bsky.app/b.jpg', w: 800, h: 600 },
  ],
  counts: { likes: 5, reposts: 2, replies: 1 },
  sensitive: false,
}

/**
 * The quoted post carries its OWN ref, which is the whole reason hoisting needs care:
 * normalize.ts gives a quote its own identity precisely so /_media/{refKey}/{i} cannot resolve
 * against the wrong post's media[]. Its dimensions (1000x500) differ from every parent entry
 * (800x600) so an assertion can tell WHICH entry an index actually resolved to, rather than
 * only that something was there.
 */
const quoted = {
  ref: { p: 'bs', handle: 'carol.bsky.social', rkey: '3p1p' },
  canonical: 'https://bsky.app/profile/carol.bsky.social/post/3p1p',
  author: { name: 'Carol', handle: 'carol.bsky.social', url: 'https://bsky.app/profile/carol.bsky.social' },
  text: 'quoted body',
  createdAt: new Date('2026-06-30T09:00:00Z'),
  media: [{ kind: 'image', url: 'https://cdn.bsky.app/q.jpg', w: 1000, h: 500, alt: 'quoted alt' }],
  counts: {},
  sensitive: false,
}

const quoting = { ...solo, quote: quoted }
const quoteOnly = { ...solo, media: [], quote: quoted }

test('a quoted post\'s media are hoisted onto the parent, AFTER the parent\'s own', async () => {
  // Order is the contract, not a detail. Parent entries keep indices 0..n-1, so every
  // /_media/ URL Phase 1 ever emitted — and the og:image selection that picks one — means
  // exactly what it did before. The hoisted entries can only ever appear at the END.
  const attachments = toMastodonStatus(quoting, ORIGIN).media_attachments
  assert.equal(attachments.length, 3, `expected 2 parent + 1 quoted, got ${attachments.length}`)
  assert.deepEqual(attachments.map(a => a.url), [0, 1, 2].map(mediaHref))
  assert.deepEqual(attachments.map(a => a.id), ['0', '1', '2'])

  // Dimensions, not just presence: 1000x500 belongs to the QUOTED entry alone, so this is
  // what distinguishes a real hoist from index 2 accidentally resolving to a parent entry.
  assert.equal(attachments[2].description, 'quoted alt')
  assert.deepEqual(attachments[2].meta, {
    original: { width: 1000, height: 500, size: '1000x500', aspect: 2 },
  })

  // The hoisted URL carries the PARENT's refKey and never the quote's. This is the subtle
  // half of the whole task: the quoted image is reachable only because it is nested inside
  // the parent's cache entry, which is the record /_media/{parentKey}/{i} resolves against.
  // A URL built from the quote's own ref would look right and 404 — nothing ever caches
  // 'bs:carol.bsky.social:3p1p' as a post of its own.
  assert.ok(!JSON.stringify(attachments).includes('carol'), 'hoisted URLs must use the parent ref')
})

test('/_media/{parentKey}/{hoisted index} resolves to the QUOTED post\'s image', async () => {
  // Through the cache round trip, not the in-memory object, because that is how the media
  // route actually gets its Post: worker.ts reads the KV entry and hands it to pickMedia. If
  // the quote did not survive serialization the hoist would resolve to null in production
  // while passing every in-memory test here.
  const cached = deserializePost(serializePost(quoting))
  assert.ok(cached, 'precondition: the cache guard accepts a quoting post')
  assert.equal(pickMedia(cached, 0), 'https://cdn.bsky.app/a.jpg')
  assert.equal(pickMedia(cached, 1), 'https://cdn.bsky.app/b.jpg')
  assert.equal(pickMedia(cached, 2), 'https://cdn.bsky.app/q.jpg')
  // Still bounded. The index segment is caller-chosen, so past-the-end must stay a 404 and
  // never wrap back onto the parent's list.
  assert.equal(pickMedia(cached, 3), null)
  assert.equal(pickMedia(cached, -1), null)
})

/**
 * Bytes captured from the pre-hoist implementation (commit 75a70fb) by rendering `solo`
 * through every client class and both mappers. They are pasted here VERBATIM from that run,
 * which is what makes this an additivity proof rather than a snapshot of the new behaviour:
 * this file runs unchanged against the old code, and these constants came out of it.
 *
 * A future deliberate change to any head has to update this constant — that is the point.
 * The failure it exists to catch is the silent one: mediaList() picking up a quote that is
 * not there, an off-by-one in the index arithmetic, or the parent's own attachment URLs
 * shifting, on the ~all posts that carry no quote at all.
 *
 * ONE deliberate divergence from that 75a70fb capture has been applied since, and it is
 * named here so the provenance claim above stays honest: Phase 3a added
 * `<meta name="theme-color" content="#0085ff"/>` to the PLAIN head, which 'other-bot'
 * renders through — the head had no accent colour at all, and the TikTok video carve-out then
 * sent that phase's headline post kind down it. 'telegram' is deliberately unchanged
 * (telegram.ts is a separate renderer), and 'discord' already carried the tag on the spoof
 * head. Nothing else in these bytes has moved.
 *
 * THE CARVE-OUT WAS REMOVED ON 2026-07-19 and these bytes did not move again, which is the
 * point of a golden-byte test: a Bluesky post has no playable video (its HLS becomes a still
 * image, Phase 1 fix I-1), so it cannot reach any line that change touched — on any client.
 * The theme-color divergence above stays for 'other-bot', which is now the plain head's only
 * audience.
 */
const GOLDEN = {
  discord:
    '<!doctype html><html><head><meta property="og:title" content="Alice (@alice.bsky.social)"/><meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/><meta property="og:url" content="https://bsky.app/profile/alice.bsky.social/post/3k2a"/><meta property="og:site_name" content="mbedfx"/><meta name="theme-color" content="#0085ff"/><meta property="theme-color" content="#0085ff"/><meta name="twitter:card" content="summary_large_image"/><link rel="canonical" href="https://bsky.app/profile/alice.bsky.social/post/3k2a"/><link rel="alternate" type="application/activity+json" href="https://staging.megapenispoopenfarten.sex/users/alice.bsky.social/statuses/1098115058097108105099101046098115107121046115111099105097108058051107050097"/><link rel="alternate" type="application/json+oembed" href="https://staging.megapenispoopenfarten.sex/_oembed/1098115058097108105099101046098115107121046115111099105097108058051107050097"/></head><body></body></html>',
  telegram:
    '<!doctype html><html><head><meta property="og:title" content="Alice (@alice.bsky.social)"/><meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/><meta property="og:url" content="https://bsky.app/profile/alice.bsky.social/post/3k2a"/><meta property="og:site_name" content="mbedfx"/><meta property="og:image" content="https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/0"/><meta property="og:image:width" content="800"/><meta property="og:image:height" content="600"/><meta name="twitter:card" content="summary_large_image"/></head><body></body></html>',
  'other-bot':
    '<!doctype html><html><head><meta property="og:title" content="Alice (@alice.bsky.social)"/><meta property="og:description" content="hello &lt;world&gt; &amp; &quot;friends&quot;"/><meta property="og:url" content="https://bsky.app/profile/alice.bsky.social/post/3k2a"/><meta property="og:site_name" content="mbedfx"/><meta name="theme-color" content="#0085ff"/><meta property="theme-color" content="#0085ff"/><meta property="og:image" content="https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/0"/><meta property="og:image:width" content="800"/><meta property="og:image:height" content="600"/><meta name="twitter:card" content="summary_large_image"/></head><body></body></html>',
}
const GOLDEN_ATTACHMENTS = JSON.stringify([
  { id: '0', type: 'image', url: mediaHref(0), preview_url: mediaHref(0), remote_url: null,
    preview_remote_url: null, text_url: null, description: 'a',
    meta: { original: { width: 800, height: 600, size: '800x600', aspect: 800 / 600 } } },
  { id: '1', type: 'image', url: mediaHref(1), preview_url: mediaHref(1), remote_url: null,
    preview_remote_url: null, text_url: null, description: null,
    meta: { original: { width: 800, height: 600, size: '800x600', aspect: 800 / 600 } } },
])

test('a post with NO quote renders byte-identically to the pre-hoist implementation', async () => {
  for (const client of ['discord', 'telegram', 'other-bot']) {
    const html = await body(render({ kind: 'post', post: solo }, client, ORIGIN))
    assert.equal(html, GOLDEN[client], `${client}: the head changed for a post with no quote`)
  }
  assert.equal(JSON.stringify(toMastodonStatus(solo, ORIGIN).media_attachments), GOLDEN_ATTACHMENTS)
  // The media route too, since it is the other half of every URL above.
  assert.deepEqual(
    [pickMedia(solo, 0), pickMedia(solo, 1), pickMedia(solo, 2), pickMedia(solo, 'avatar')],
    ['https://cdn.bsky.app/a.jpg', 'https://cdn.bsky.app/b.jpg', null, 'https://cdn.bsky.app/avatar.jpg'],
  )
})

test('a quote carrying no usable media is a strict no-op', async () => {
  // Every shape a quote's media can arrive in and still contribute nothing. The corrupt ones
  // are reachable, not hypothetical: deserializePost validates a nested quote's ref, canonical
  // and createdAt and NOTHING else (see cache.ts), so media:[null] or a non-array media one
  // level down passes the guard and lands in the hoist intact — and `[...post.quote.media]`
  // on a non-iterable is a TypeError, a 500 out of the two paths whose contract is to degrade.
  for (const media of [[], undefined, null, 'nope', 42, {}, [null], [{ kind: 'image', url: null }]]) {
    const post = { ...quoting, quote: { ...quoted, media } }
    const label = `quote.media = ${JSON.stringify(media) ?? 'undefined'}`
    assert.equal(JSON.stringify(toMastodonStatus(post, ORIGIN).media_attachments), GOLDEN_ATTACHMENTS, label)
    // [null] is the interesting one: it must occupy index 2 without RESOLVING to anything, so
    // the hole is a 404 rather than a silent re-serving of the parent's last image.
    assert.equal(pickMedia(post, 2), null, label)
    assert.equal(pickMedia(post, 0), 'https://cdn.bsky.app/a.jpg', label)
  }
})

test('a corrupt PARENT entry does not shift the hoisted index', async () => {
  // The index in a /_media/ URL is a position in the raw combined list, never a position in
  // the filtered output — mastodon.ts drops an unusable entry from the gallery but takes the
  // index from the loop counter. A hoisted entry lands after every parent slot including the
  // dead ones, or the quoted image serves under an index that pickMedia resolves elsewhere.
  const post = { ...quoting, media: [null, solo.media[1]] }
  const attachments = toMastodonStatus(post, ORIGIN).media_attachments
  assert.deepEqual(attachments.map(a => a.url), [mediaHref(1), mediaHref(2)], 'index 0 is a hole, not a shift')
  assert.equal(pickMedia(post, 1), 'https://cdn.bsky.app/b.jpg')
  assert.equal(pickMedia(post, 2), 'https://cdn.bsky.app/q.jpg')
})

test('og:image stays the PARENT\'s first image whenever the parent has one', async () => {
  // The plain-og head picks ONE picture and the post's own comes first — a hoisted image must
  // never displace it. Asserting the dimension tags as well as the URL is what makes this
  // real: 800x600 is the parent entry's alone, so an assertion on /0 by itself would still
  // pass if index 0 had started resolving to the 1000x500 quoted image.
  for (const client of ['other-bot', 'telegram']) {
    const html = await body(render({ kind: 'post', post: quoting }, client, ORIGIN))
    assert.deepEqual(tagsOf(html, 'og:image'), [mediaHref(0)], `${client}: the quote displaced the post's own image`)
    assert.deepEqual(tagsOf(html, 'og:image:width'), ['800'])
    assert.deepEqual(tagsOf(html, 'og:image:height'), ['600'])
  }
})

test('a QUOTE-ONLY post: Discord gets the hoisted gallery, every other bot gets the avatar', async () => {
  // The documented answer to "what does og:image do now", and it is two different answers.
  //
  // Discord: the spoof gate now asks the hoisted question, so this post takes the spoof path —
  // ZERO og:image, plus an activity link describing a gallery of exactly the quoted image. That
  // is the gate's own §5 risk argument applied honestly rather than by the letter of which array
  // the pictures came from: a post with a picture has a gallery to win that the plain head
  // cannot draw, and this post has one. Before the hoist it took the plain path and showed the
  // author's AVATAR — a face where the embed's actual subject was a picture nobody could see.
  // Correction C1 names this exact state ("a quote-only post gets both an avatar og:image and a
  // populated media_attachments") as the thing §7 must not leave behind.
  const discord = await body(render({ kind: 'post', post: quoteOnly }, 'discord', ORIGIN))
  assert.deepEqual(tagsOf(discord, 'og:image'), [], 'an og:image outranks the gallery and defeats the spoof')
  assert.equal(linksOf(discord).length, 1, 'the hoisted picture must reach Discord through the activity link')
  const attachments = toMastodonStatus(quoteOnly, ORIGIN).media_attachments
  assert.deepEqual(attachments.map(a => a.url), [mediaHref(0)])

  // Everyone else: unchanged — the avatar, exactly as Phase 1 shipped. The plain head's
  // SELECTION deliberately stays parent-only (see discord.ts), so this is a deviation recorded
  // rather than an oversight: promoting a hoisted entry there would let a quoted VIDEO win the
  // og:video branch over the parent's own image, which is the one thing §7 must not do. The
  // quoted picture is still reachable at the URL below; nothing on this head points at it.
  for (const client of ['other-bot', 'telegram']) {
    const html = await body(render({ kind: 'post', post: quoteOnly }, client, ORIGIN))
    const imgs = tagsOf(html, 'og:image')
    assert.equal(imgs.length, 1, `${client}: expected exactly one og:image`)
    assert.match(imgs[0], /\/avatar$/, `${client}: the plain head keeps Phase 1's avatar fallback`)
  }
  assert.equal(pickMedia(quoteOnly, 0), 'https://cdn.bsky.app/q.jpg')
})

/**
 * The raw AT thread in which the hoist and the sensitivity label disagree — a post carrying no
 * label of its own, quoting one that self-labels `porn` and holds the only picture.
 *
 * Driven through normalizeBluesky rather than hand-written as a Post, because the entire
 * question is whether `parent.sensitive === false, quote.sensitive === true` is a REAL shape
 * rather than a corrupted-cache hypothetical. It is: build() computes `sensitive` per post from
 * THAT post's own `labels` against SENSITIVE_LABELS, and Bluesky attaches moderation labels to
 * the record that HOLDS the media — so `app.bsky.embed.record#viewRecord` carries its own, and
 * unlabelled commentary quoting a self-labelled post is the ordinary case.
 */
const nsfwQuoteRaw = {
  thread: {
    post: {
      uri: 'at://did:plc:alice/app.bsky.feed.post/3k2a',
      author: { handle: 'alice.bsky.social', displayName: 'Alice' },
      record: { text: 'look at this', createdAt: '2026-07-01T12:00:00Z' },
      labels: [],
      embed: {
        record: {
          uri: 'at://did:plc:carol/app.bsky.feed.post/3p1p',
          author: { handle: 'carol.bsky.social', displayName: 'Carol' },
          value: { text: 'nsfw body', createdAt: '2026-06-30T09:00:00Z' },
          labels: [{ val: 'porn' }],
          // Plural `embeds`, which is the viewRecord shape Phase 1's Task 6 bug was about.
          embeds: [{ images: [{ fullsize: 'https://cdn.bsky.app/NSFW.jpg', aspectRatio: { width: 1000, height: 500 } }] }],
        },
      },
    },
  },
}

test('a sensitive QUOTE whose media the hoist surfaced still gets the [sensitive] marker', async () => {
  // THE DEFECT THIS PINS, proven end to end before the fix: §7 hoists the quoted image into the
  // parent's gallery, but every sensitivity site read the PARENT's flag alone. So this post
  // shipped a self-labelled NSFW picture to a Discord viewer with the warning on NO surface —
  // and it is §7 that creates the exposure, since before the hoist the picture reached nobody
  // (the plain head drew the avatar and media_attachments was empty).
  const post = normalizeBluesky(nsfwQuoteRaw, { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' })
  assert.equal(post.sensitive, false, 'precondition: the parent carries no label of its own')
  assert.equal(post.quote.sensitive, true, 'precondition: the quote carries its own label')

  // The hoist did its job — this is the surface that actually ships the picture.
  const status = toMastodonStatus(post, ORIGIN)
  assert.deepEqual(status.media_attachments.map(a => a.url), [mediaHref(0)], 'precondition: hoisted')

  // `content` is the ONLY place the warning can live on this path: mastodon.ts deliberately
  // emits spoiler_text:'' and no `sensitive` field ("label without blur"), so there is no
  // client-side blur to fall back on when the label goes missing. The repo has regressed here
  // once already (commit faab291, "restore the sensitivity signal").
  assert.ok(status.content.startsWith('[sensitive] '), `no marker on content: ${status.content}`)

  // The head has to agree with the payload it advertises. og:description is the spoof head's
  // documented fallback insurance, so the two disagreeing would put the warning on whichever
  // surface Discord happened not to read.
  const html = await body(render({ kind: 'post', post }, 'discord', ORIGIN))
  assert.ok(html.includes('[sensitive] '), 'the spoof head lost the marker')
})

test('the marker follows the HOIST, not the mere presence of a sensitive quote', async () => {
  // The predicate is gated on the quote actually CONTRIBUTING a picture, because that picture is
  // what §7 newly puts in front of a viewer. A sensitive quote carrying nothing usable reaches
  // exactly the surfaces it reached before §7 — its text, unlabelled — and relabelling those is
  // a change to output Phase 1 verified in a real client, which wants its own evidence rather
  // than a ride on this fix. Each shape below also survives the hoist's own no-op test above.
  for (const media of [[], undefined, [null], [{ kind: 'image', url: '' }]]) {
    const post = { ...quoteOnly, quote: { ...quoted, sensitive: true, media } }
    const label = `quote.media = ${JSON.stringify(media) ?? 'undefined'}`
    assert.ok(!toMastodonStatus(post, ORIGIN).content.includes('[sensitive]'), label)
  }

  // A sensitive PARENT stays unconditional, hoist or no hoist. The fix WIDENS the predicate and
  // must not narrow it — a `quote ? … : …` spelling would drop the label on every quoting post.
  for (const post of [solo, quoting, quoteOnly]) {
    const sensitive = { ...post, sensitive: true }
    assert.ok(toMastodonStatus(sensitive, ORIGIN).content.includes('[sensitive]'), 'parent flag lost')
    // Both heads, because describe() and contentWithMarker() are two sites for one rule.
    for (const client of ['discord', 'telegram', 'other-bot']) {
      const html = await body(render({ kind: 'post', post: sensitive }, client, ORIGIN))
      assert.ok(html.includes('[sensitive] '), `${client}: parent flag lost from og:description`)
    }
  }
})

/** The pipeline harness, in miniature — enough to drive worker.ts's real request path. */
const fakeCache = () => {
  const m = new Map()
  return {
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}
const fakeEnv = () => ({ AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('asset') } } })
const ctx = { waitUntil() {} }
const req = path => new Request(`${ORIGIN}${path}`, { headers: { 'user-agent': 'Discordbot/2.0' } })

test('END TO END: the hoisted /_media/ URL 302s to the quoted image at the real surface', async () => {
  // The unit rules above are pinned at the surface that actually SHIPS, because everything
  // between them and a viewer is untested otherwise: the router has to parse the parent's
  // refKey out of an index-2 path, worker.ts has to find the post in cache, and pickMedia has
  // to resolve an index past the end of the parent's own media[]. A hoisted attachment URL
  // that 404s here is worse than no hoist at all — Discord caches a broken picture.
  //
  // Asserted on CONTENT (the Location header, the parsed JSON body), never on the status code
  // alone: this project has already shipped a failure that returned HTTP 200 with an error page.
  const opts = { cache: fakeCache(), fetchPost: async () => quoteOnly }
  const key = 'bs:alice.bsky.social:3k2a'

  const hoisted = await handle(req(`/_media/${key}/0`), fakeEnv(), ctx, opts)
  assert.equal(hoisted.headers.get('location'), 'https://cdn.bsky.app/q.jpg', 'the quoted image must resolve')
  assert.equal(hoisted.status, 302)

  // Past the end is still a 404 with a real body, not a redirect to null or an uncaught throw.
  const past = await handle(req(`/_media/${key}/1`), fakeEnv(), ctx, { cache: fakeCache(), fetchPost: async () => quoteOnly })
  assert.equal(await past.text(), 'media unavailable\n')
  assert.equal(past.status, 404)

  // And the activity callback describes exactly that one attachment, pointing at the URL just
  // proven to resolve. This is the pair that has to agree: the gallery Discord is told about
  // and the route it fetches it from.
  const id = encodeStatusId(refKey(quoteOnly.ref))
  const api = await handle(req(`/api/v1/statuses/${id}`), fakeEnv(), ctx, { cache: fakeCache(), fetchPost: async () => quoteOnly })
  const status = JSON.parse(await api.text())
  assert.deepEqual(status.media_attachments.map(a => a.url), [mediaHref(0)])
})

test('the hoist stops at depth 1 — it never recurses into a quote\'s own quote', async () => {
  // The normalizer guarantees post.quote.quote is undefined, and mediaList must not assume it:
  // a hostile or corrupted cache record can carry one, and a recursive hoist on a self-
  // referencing record is an unbounded loop inside a route with no try/catch. Reading exactly
  // one level is what makes that structurally impossible rather than merely unlikely.
  const deep = {
    ...quoting,
    quote: { ...quoted, quote: { ...quoted, media: [{ kind: 'image', url: 'https://cdn.bsky.app/deep.jpg', w: 10, h: 10 }] } },
  }
  const attachments = toMastodonStatus(deep, ORIGIN).media_attachments
  assert.equal(attachments.length, 3, 'depth 2 media must not appear')
  assert.equal(pickMedia(deep, 3), null)

  // Self-reference, the pathological form of the same shape.
  const cyclic = { ...solo }
  cyclic.quote = cyclic
  assert.equal(toMastodonStatus(cyclic, ORIGIN).media_attachments.length, 4, 'own media twice, then stop')
  assert.equal(pickMedia(cyclic, 4), null)
})

test('A VIDEO POST QUOTING AN IMAGE SHIPS THE VIDEO ALONE — Discord drops videos from a mixed gallery', () => {
  /**
   * REPORTED 2026-08-01 on /Potaterrtot/status/2083366241515827378: a video quoting a post that
   * carries a map image, and Discord drew THE MAP. The wire payload was [video, image] and Discord
   * silently discards videos from a mixed gallery — the same behaviour this file already records for
   * the Instagram carousel, where ten attachments became six drawn and four videos dropped.
   *
   * So the quote's picture did not sit beside the video. It replaced it.
   *
   * ownVideoLeads already stopped such a post FLATTENING its own video to a still. It could not stop
   * the quote's media being hoisted in alongside — the other half of the same problem.
   */
  const post = {
    ref: { p: 'x', id: '1' },
    canonical: 'https://x.com/a/status/1',
    author: { name: 'A', handle: 'a', url: 'https://x.com/a' },
    text: 'US-Iran War (2026)',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    media: [{ kind: 'video', url: 'https://x.invalid/v.mp4', w: 1280, h: 720, poster: 'https://x.invalid/p.jpg' }],
    counts: {},
    sensitive: false,
    quote: {
      ref: { p: 'x', id: '2' },
      canonical: 'https://x.com/b/status/2',
      author: { name: 'B', handle: 'b', url: 'https://x.com/b' },
      text: 'Holy shit 7 WHAT are airborne?',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      media: [{ kind: 'image', url: 'https://x.invalid/map.jpg', w: 1200, h: 800 }],
      counts: {},
      sensitive: false,
    },
  }

  const s = toMastodonStatus(post, ORIGIN)
  assert.equal(s.media_attachments.length, 1, 'one attachment — the quote picture must not join it')
  assert.equal(s.media_attachments[0].type, 'video', 'and it is the post\'s own video, not a still')

  // The quote is NOT lost: its author and text still carry in the content blockquote, which is the
  // context a reader actually needs. Only the competing picture is dropped.
  assert.match(s.content, /Quoting/)
  assert.match(s.content, /Holy shit 7 WHAT are airborne\?/)
})
