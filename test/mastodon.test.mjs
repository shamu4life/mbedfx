import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toMastodonStatus, toOEmbed } from '../src/render/mastodon.ts'
import { render } from '../src/render/index.ts'
import { normalizeBluesky } from '../src/platforms/bluesky/normalize.ts'
import { normalizeTikTok } from '../src/platforms/tiktok/normalize.ts'
import { normalizeInstagram } from '../src/platforms/instagram/normalize.ts'
import { buildContentHtml, buildPlainText } from '../src/render/text.ts'
import { refKey } from '../src/refkey.ts'
import { decodeStatusId } from '../src/statusid.ts'
import { serializePost, deserializePost } from '../src/cache.ts'

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'

/**
 * The CDN host and the signature parameter are the two things that must NEVER reach a
 * client: a signed URL expires, and once Discord has cached it the embed rots. Both are
 * spelled out here as distinctive literals so the whole-blob assertions below can look for
 * them by substring rather than checking fields one at a time.
 */
const CDN = 'https://cdn.bsky.app'
const SIG = 'sig=deadbeefcafe'
const cdnUrl = n => `${CDN}/img/feed_fullsize/plain/did:plc:xyz/img${n}@jpeg?${SIG}`

const base = {
  ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
  canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  author: {
    name: 'Alice',
    handle: 'alice.bsky.social',
    url: 'https://bsky.app/profile/alice.bsky.social',
    avatar: `${CDN}/img/avatar/plain/did:plc:xyz/avatar@jpeg?${SIG}`,
  },
  text: 'hello',
  createdAt: new Date('2026-07-01T12:00:00.000Z'),
  media: [],
  counts: {},
  sensitive: false,
}
const parent = {
  ...base,
  ref: { p: 'bs', handle: 'carol.bsky.social', rkey: '3p1p' },
  canonical: 'https://bsky.app/profile/carol.bsky.social/post/3p1p',
  author: { name: 'Carol', handle: 'carol.bsky.social', url: 'https://bsky.app/profile/carol.bsky.social' },
  text: 'parent text',
}
const img = (n, w = 1200, h = 800) => ({ kind: 'image', url: cdnUrl(n), w, h, alt: `alt ${n}` })
const fourImages = { ...base, media: [img(0), img(1, 4000, 2250), img(2, 900, 1600), img(3)] }

/**
 * BYTE-FOR-BYTE GOLDENS, captured from the implementation as it stood BEFORE the mixed-gallery
 * flattening (2026-07-20). These four payloads are the shapes a human has verified rendering
 * correctly in a real Discord client — two all-image galleries and two single-video players — and
 * the flattening must not move any of them by a single byte. Literals rather than a snapshot file
 * on purpose: a self-updating snapshot cannot fail, and "unchanged" is the whole assertion.
 */
const TT_SLIDESHOW_GOLDEN = "[{\"id\":\"0\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/0\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/0\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":null,\"meta\":{\"original\":{\"width\":1080,\"height\":1350,\"size\":\"1080x1350\",\"aspect\":0.8}}},{\"id\":\"1\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/1\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/1\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":null,\"meta\":{\"original\":{\"width\":1080,\"height\":1350,\"size\":\"1080x1350\",\"aspect\":0.8}}},{\"id\":\"2\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/2\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/2\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":null,\"meta\":{\"original\":{\"width\":640,\"height\":800,\"size\":\"640x800\",\"aspect\":0.8}}},{\"id\":\"3\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/3\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/3\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":null,\"meta\":{\"original\":{\"width\":1080,\"height\":1350,\"size\":\"1080x1350\",\"aspect\":0.8}}},{\"id\":\"4\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/4\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7534/4\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":null,\"meta\":{\"original\":{\"width\":1080,\"height\":1350,\"size\":\"1080x1350\",\"aspect\":0.8}}}]"
const BS_FOUR_IMAGE_GOLDEN = "[{\"id\":\"0\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/0\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/0\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":\"alt 0\",\"meta\":{\"original\":{\"width\":1200,\"height\":800,\"size\":\"1200x800\",\"aspect\":1.5}}},{\"id\":\"1\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/1\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/1\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":\"alt 1\",\"meta\":{\"original\":{\"width\":4000,\"height\":2250,\"size\":\"4000x2250\",\"aspect\":1.7777777777777777}}},{\"id\":\"2\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/2\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/2\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":\"alt 2\",\"meta\":{\"original\":{\"width\":900,\"height\":1600,\"size\":\"900x1600\",\"aspect\":0.5625}}},{\"id\":\"3\",\"type\":\"image\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/3\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/bs%3Aalice.bsky.social%3A3k2a/3\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":\"alt 3\",\"meta\":{\"original\":{\"width\":1200,\"height\":800,\"size\":\"1200x800\",\"aspect\":1.5}}}]"
const TT_VIDEO_GOLDEN = "[{\"id\":\"0\",\"type\":\"video\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7535/0\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/tt%3A7535/poster0\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":null,\"meta\":{\"original\":{\"width\":720,\"height\":1280,\"size\":\"720x1280\",\"aspect\":0.5625}}}]"
const IG_REEL_GOLDEN = "[{\"id\":\"0\",\"type\":\"video\",\"url\":\"https://staging.megapenispoopenfarten.sex/_media/ig%3Ap%3ADa5ynsiuAZ_/0\",\"preview_url\":\"https://staging.megapenispoopenfarten.sex/_media/ig%3Ap%3ADa5ynsiuAZ_/poster0\",\"remote_url\":null,\"preview_remote_url\":null,\"text_url\":null,\"description\":null,\"meta\":{\"original\":{\"width\":898,\"height\":1594,\"size\":\"898x1594\",\"aspect\":0.5633626097867002}}}]"

/** The verified oEmbed author_name separator: THREE literal spaces (spec §3), not one, not &ensp;. */
const SEP = '   '
/**
 * Emoji as escapes, never literals — same reason text.test.mjs gives: the heart is the
 * two-codepoint emoji-presentation sequence U+2764 U+FE0F, whose trailing selector is
 * invisible and is exactly what an editor or a copy-paste silently eats.
 */
const LIKES = '\u2764\uFE0F'
const REPLIES = '\u{1F4AC}'
const REPOSTS = '\u{1F501}'

test('a 4-image post yields exactly 4 media_attachments, every id DISTINCT', () => {
  // FxEmbed hardcodes ONE id ("114163769487684704") for all four attachments and Discord
  // accepts it, so this is a deliberate deviation, not a bug fix: distinct ids are what the
  // Mastodon API actually specifies, and any consumer that de-duplicates by id would collapse
  // four images into one. Strictly safer in the only direction that matters.
  const s = toMastodonStatus(fourImages, ORIGIN)
  assert.equal(s.media_attachments.length, 4, 'all four images must survive the mapping')
  const ids = s.media_attachments.map(a => a.id)
  assert.equal(new Set(ids).size, 4, `ids must be distinct: ${JSON.stringify(ids)}`)
  assert.deepEqual(ids, ['0', '1', '2', '3'])
})

test('NO raw CDN url survives anywhere in the serialized payload', () => {
  // Asserted against the whole JSON.stringify blob, deliberately, instead of field by field:
  // media_attachments alone has four url-shaped slots (url, preview_url, remote_url,
  // preview_remote_url) plus text_url and the two account avatar fields, and the failure this
  // guards is precisely "a field you forgot". A field-by-field test passes while the payload
  // still leaks.
  const withEverything = { ...fourImages, quote: { ...parent, media: [img(9)] }, replyTo: parent }
  const blob = JSON.stringify(toMastodonStatus(withEverything, ORIGIN))
  assert.ok(!blob.includes('cdn.bsky.app'), `a raw CDN host reached the client: ${blob}`)
  assert.ok(!blob.includes(SIG), `a signed CDN URL reached the client — it expires: ${blob}`)
  for (let i = 0; i < 4; i++) assert.ok(!blob.includes(cdnUrl(i)))
  // Every url-shaped value that IS present must be ours.
  for (const m of blob.match(/https?:\/\/[^"]+/g) ?? []) {
    const ok = m.startsWith(ORIGIN) || m.startsWith('https://bsky.app/')
    assert.ok(ok, `unexpected outbound url in the payload: ${m}`)
  }
  // The oEmbed side carries no media at all, but assert it rather than assume it.
  assert.ok(!JSON.stringify(toOEmbed(withEverything, ORIGIN)).includes('cdn.bsky.app'))
})

test('every media url is /_media/{encodeURIComponent(refKey)}/{i} — DID handles included', () => {
  // A DID handle is the case that broke Phase 1 twice (I-2, and the router double-decode in
  // the wire spec §2): refKey percent-encodes the DID's colons, then the whole key is encoded
  // again, so a correct url carries '%253A' and NO bare colon after /_media/. Building the
  // expectation from refKey() rather than a hand-written string is what makes this an
  // encoding test rather than a transcription test.
  const did = {
    ...fourImages,
    ref: { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' },
  }
  const key = encodeURIComponent(refKey(did.ref))
  assert.ok(key.includes('%253A'), `the DID colons must be doubly encoded, got ${key}`)
  const s = toMastodonStatus(did, ORIGIN)
  s.media_attachments.forEach((a, i) => {
    assert.equal(a.url, `${ORIGIN}/_media/${key}/${i}`)
    assert.equal(a.preview_url, a.url, 'preview_url must not fall back to the CDN')
    assert.ok(!a.url.slice(ORIGIN.length + '/_media/'.length).includes(':'), `bare colon on the wire: ${a.url}`)
  })
  // The avatar rides the same wire format under the reserved 'avatar' index.
  assert.equal(s.account.avatar, `${ORIGIN}/_media/${key}/avatar`)
})

test('created_at is a valid ISO string on both the status and the account', () => {
  const s = toMastodonStatus(base, ORIGIN)
  assert.equal(s.created_at, '2026-07-01T12:00:00.000Z')
  assert.equal(new Date(s.created_at).toISOString(), s.created_at, 'must round-trip as ISO')
  // We have no join date for the author, so the post's own timestamp is the stand-in. The
  // alternative — reading the clock — would make the mapper impure and the response
  // uncacheable-by-value.
  assert.equal(s.account.created_at, s.created_at)
})

test('the mappers never read the clock', () => {
  // Purity is not decorative here: these responses are cached, so a clock read makes two
  // identical requests produce different bytes, and it makes every assertion above
  // time-dependent. Date.now() is the reachable form (new Date(x) with an argument does not
  // call it), so poisoning it proves the property rather than asserting equality twice.
  const realNow = Date.now
  Date.now = () => { throw new Error('the mappers must not read the clock') }
  try {
    assert.doesNotThrow(() => toMastodonStatus(fourImages, ORIGIN))
    assert.doesNotThrow(() => toOEmbed(fourImages, ORIGIN))
  } finally {
    Date.now = realNow
  }
  assert.deepEqual(toMastodonStatus(fourImages, ORIGIN), toMastodonStatus(fourImages, ORIGIN))
})

test('an absent avatar omits BOTH avatar keys — it never emits a url that 404s', () => {
  // Phase 1's scar: a corrupt ref produced og:image=".../_media/undefined/avatar", an image
  // URL that resolves to nothing. pickMedia returns null when author.avatar is absent, so an
  // emitted /_media/{key}/avatar would 404 — and a 404 image is worse than no image, because
  // the OpenGraph fallback then has a broken picture instead of falling back cleanly.
  const s = toMastodonStatus({ ...base, author: { ...base.author, avatar: undefined } }, ORIGIN)
  assert.ok(!('avatar' in s.account), 'avatar must be ABSENT, not null or empty')
  assert.ok(!('avatar_static' in s.account), 'avatar_static is the one that gets forgotten')
  assert.ok(!JSON.stringify(s).includes('/avatar'), 'no avatar url may appear anywhere')
  // Present avatar: both keys, same url.
  const withAvatar = toMastodonStatus(base, ORIGIN)
  assert.equal(withAvatar.account.avatar_static, withAvatar.account.avatar)
})

test('a zero dimension produces neither Infinity nor a null aspect nor a 0x0 size', () => {
  // normalize.ts defaults w/h to 0 whenever the AT record omits aspectRatio, so this is a
  // live shape, not a hypothetical. JSON.stringify(Infinity) is silently `null`, which means
  // the naive w/h would ship a null aspect that looks deliberate in the payload and is not.
  // "0x0" is no better: it tells a client the image has no area.
  for (const [w, h] of [[0, 0], [1200, 0], [0, 800]]) {
    const s = toMastodonStatus({ ...base, media: [{ kind: 'image', url: cdnUrl(0), w, h }] }, ORIGIN)
    assert.equal(s.media_attachments.length, 1, 'the attachment itself still ships — only its meta is unknown')
    // Scoped to the attachment on purpose: the status legitimately carries many nulls
    // (edited_at, reblog, remote_url…), so a blanket search for 'null' proves nothing.
    const att = JSON.stringify(s.media_attachments[0])
    assert.ok(!('meta' in s.media_attachments[0]), `unknown dimensions must omit meta, got ${att}`)
    // The quoted key names, not bare substrings: a Bluesky CDN path contains the literal
    // 'feed_fullsize', so a loose `includes('size')` passes for the wrong reason.
    assert.ok(!att.includes('"aspect"'), `a ${w}x${h} attachment must carry no aspect at all: ${att}`)
    assert.ok(!att.includes('"size"'), `a zero-area size was advertised: ${att}`)
    assert.ok(!att.includes('Infinity'))
  }
  // And where the dimensions ARE known, aspect must be a finite number rather than a
  // stringified or rounded stand-in — the property the null above would have hidden.
  const ok = toMastodonStatus({ ...base, media: [img(0, 1200, 800)] }, ORIGIN).media_attachments[0]
  assert.equal(typeof ok.meta.original.aspect, 'number')
  assert.ok(Number.isFinite(ok.meta.original.aspect))
})

test('images keep TRUE dimensions; only video gets Phase 1 fudge()', () => {
  // A deliberate deviation from the plan, which said to fudge everything. Live evidence
  // (spec §6c) shows FxEmbed sending true dimensions for images — 4000x2250 among them, in
  // mixed orientations — and all four render. fudge() exists because Discord DROPS oversized
  // og:image and postage-stamps tiny ones; media_attachments is a different consumer, and
  // lying there loses the real aspect ratio for no observed benefit.
  const s = toMastodonStatus(fourImages, ORIGIN)
  assert.deepEqual(s.media_attachments[1].meta.original, {
    width: 4000, height: 2250, size: '4000x2250', aspect: 4000 / 2250,
  })
  assert.deepEqual(s.media_attachments[2].meta.original.size, '900x1600', 'portrait must not be flipped')

  const v = toMastodonStatus({ ...base, media: [{ kind: 'video', url: cdnUrl(0), w: 4000, h: 2250 }] }, ORIGIN)
  assert.deepEqual(v.media_attachments[0].meta.original, {
    width: 2000, height: 1125, size: '2000x1125', aspect: 2000 / 1125,
  })
  assert.equal(v.media_attachments[0].type, 'video')
})

test('a corrupt media entry drops WITHOUT shifting the indices after it', () => {
  // The index is not cosmetic: /_media/{key}/{i} is resolved by pickMedia, which indexes the
  // RAW post.media array. Compacting the list here (the obvious `.filter().map()`) would make
  // attachment 2 advertise index 1 and serve the wrong image — or the hole. media[] is also
  // exactly the kind of value that can be corrupt: deserializePost validates ref, canonical
  // and createdAt, and nothing else.
  const s = toMastodonStatus({ ...base, media: [img(0), null, img(2)] }, ORIGIN)
  assert.equal(s.media_attachments.length, 2)
  assert.deepEqual(s.media_attachments.map(a => a.id), ['0', '2'])
  assert.ok(s.media_attachments[1].url.endsWith('/2'), `index shifted: ${s.media_attachments[1].url}`)
})

test('a media entry with no usable url is dropped, in place — never one that 404s', () => {
  // The same rule the avatar branch states nineteen lines away in the same file: a 404 image
  // is worse than no image. An OBJECT entry with no url cleared the `typeof m === 'object'`
  // guard and shipped an attachment whose /_media/{key}/{i} url resolves through pickMedia to
  // null — a guaranteed 404, advertised to the client. Proven end to end before the fix: the
  // emitted url for such an entry returned 404 'media unavailable' while its neighbour 302'd.
  const s = toMastodonStatus({ ...base, media: [{ kind: 'image', w: 10, h: 10 }, img(1)] }, ORIGIN)
  assert.deepEqual(s.media_attachments.map(a => a.id), ['1'], 'the hole drops; the survivor keeps its OWN index')
  assert.ok(s.media_attachments[0].url.endsWith('/1'), `index shifted: ${s.media_attachments[0].url}`)
  for (const bad of [{}, { kind: 'image', url: '' }, { kind: 'image', url: 42 }, { kind: 'image', url: null }]) {
    assert.equal(toMastodonStatus({ ...base, media: [bad] }, ORIGIN).media_attachments.length, 0, JSON.stringify(bad))
  }
})

test('the attachment type is always one of the three literal strings', () => {
  // ATTACHMENT_TYPE is an object literal, so it inherits Object.prototype, and a raw
  // `TABLE[m.kind] ?? 'image'` resolves INHERITED keys — `??` never fires, because a prototype
  // member is neither undefined nor null. Proven, varying only `kind`: 'constructor',
  // 'toString' and 'valueOf' each resolved to a FUNCTION, which JSON.stringify silently drops,
  // shipping an attachment with no `type` key at all; '__proto__' shipped `"type":{}` where
  // §6c requires a string. The second of those defeats the no-undefined-holes test below on
  // the one field it does not cover. Reachable only from a corrupted cache record
  // (normalize.ts emits the literal 'image' and nothing else) — which is precisely the threat
  // model the null-entry guard three lines above it already codes against.
  for (const kind of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'nonsense', 42, null]) {
    const att = toMastodonStatus({ ...base, media: [{ kind, url: cdnUrl(0), w: 9, h: 9 }] }, ORIGIN).media_attachments[0]
    assert.ok(['image', 'video', 'gifv'].includes(att.type), `kind ${String(kind)} -> type ${JSON.stringify(att.type)}`)
    // And it must survive the wire: a function- or undefined-valued key vanishes silently.
    assert.ok(JSON.stringify(att).includes(`"type":"${att.type}"`), `type dropped off the wire for kind ${String(kind)}`)
  }
  // The three real kinds still map as specified — 'gif' to 'image', NOT to Mastodon's 'gifv',
  // which promises a soundless looping VIDEO and would hand a player an image file.
  for (const [kind, type] of [['image', 'image'], ['video', 'video'], ['gif', 'image']]) {
    const s = toMastodonStatus({ ...base, media: [{ kind, url: cdnUrl(0), w: 9, h: 9 }] }, ORIGIN)
    assert.equal(s.media_attachments[0].type, type)
  }
})

test('a degraded cached Post degrades the payload instead of throwing', () => {
  // Same contract as the text builders, and reachable the same way: the cache guard accepts a
  // post with no author (proven in text.test.mjs) and never looks at media at all. A throw
  // here is a 500 on a route whose entire job is to degrade.
  const authorless = deserializePost(serializePost({ ...base, author: undefined }))
  assert.ok(authorless !== null, 'the cache guard accepts an authorless post; the mapper must too')
  assert.doesNotThrow(() => toMastodonStatus(authorless, ORIGIN))
  assert.doesNotThrow(() => toOEmbed(authorless, ORIGIN))
  for (const bad of [undefined, null, 'not an array', 42, {}]) {
    const p = { ...base, media: bad }
    assert.doesNotThrow(() => toMastodonStatus(p, ORIGIN), `media ${JSON.stringify(bad) ?? 'undefined'}`)
    assert.deepEqual(toMastodonStatus(p, ORIGIN).media_attachments, [])
  }
})

test('the status id is pure digits and decodes back to the refKey', () => {
  // Spec §1: real Mastodon ids are numeric snowflakes, so the id segment must be all digits —
  // and it is the ONLY channel back, because Discord calls /api/v1/statuses/{id} rather than
  // the href we advertise. If the round trip breaks, the spoof 404s silently.
  for (const ref of [base.ref, { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' }]) {
    const s = toMastodonStatus({ ...base, ref }, ORIGIN)
    assert.match(s.id, /^[0-9]+$/, `the id must look like a snowflake, got ${s.id}`)
    assert.equal(decodeStatusId(s.id), refKey(ref))
  }
})

test('account.url and uri are the AUTHOR profile, not the post', () => {
  // FxEmbed puts the POST url in account.url. That is wrong on its face — clicking the author
  // of an embed should land on the author — and copying it would import their bug.
  const s = toMastodonStatus(base, ORIGIN)
  assert.equal(s.account.url, base.author.url)
  assert.equal(s.account.uri, base.author.url)
  assert.notEqual(s.account.url, base.canonical)
  // The STATUS url/uri, by contrast, is the post.
  assert.equal(s.url, base.canonical)
  assert.equal(s.uri, base.canonical)
})

test('no count field is ever emitted on the status', () => {
  // Spec C3. Counts already render twice by design (Mastodon `content` and oEmbed
  // author_name) because those consumers are disjoint. replies_count / reblogs_count /
  // favourites_count would be a THIRD surface — verified absent from FxEmbed's payload —
  // and keeping them absent makes a third render structurally impossible rather than merely
  // unlikely.
  const blob = JSON.stringify(toMastodonStatus({ ...base, counts: { likes: 140, reposts: 14, replies: 5 } }, ORIGIN))
  for (const k of ['replies_count', 'reblogs_count', 'favourites_count']) {
    assert.ok(!blob.includes(k), `${k} must not be emitted: ${blob}`)
  }
})

test('content is buildContentHtml verbatim — the mapper adds no second escaping layer', () => {
  // Verbatim for a non-sensitive post, which is every post but the labelled ones: the mapper's
  // only addition to the builder's output is the `[sensitive] ` prefix tested below, and that
  // prefix is literal text nobody can inject. Everything else — escaping, separators,
  // composition order — has exactly one owner, in text.ts.
  const p = { ...base, text: 'a & <b>\nsecond', counts: { likes: 3 }, quote: parent, replyTo: parent }
  const s = toMastodonStatus(p, ORIGIN)
  assert.equal(s.content, buildContentHtml(p), 'one owner for the content HTML')
  assert.ok(!s.content.includes('&amp;amp;'), 'double-escaping would show as &amp;amp; in the embed')
})

test('a title renders as a BOLD leading block above the body, separated by a blank line', () => {
  // The headline (Reddit today, link/article cards later) must be visually distinct from the body —
  // the whole reason Post.title exists. esc() still escapes the title's own text; only the <b> is ours.
  const c = buildContentHtml({ ...base, title: 'The Headline & <tag>', text: 'the body', counts: {} })
  assert.ok(c.startsWith('<b>The Headline &amp; &lt;tag&gt;</b>'), `title is bold and escaped: ${c}`)
  assert.ok(c.includes('</b><br><br>the body'), `blank line between title and body: ${c}`)

  // A title-only post (image/link with no selftext) is the bold headline alone, no dangling separator.
  assert.equal(buildContentHtml({ ...base, title: 'Just a headline', text: '', counts: {} }), '<b>Just a headline</b>')

  // Additive: a post with no title is byte-identical to before the field existed.
  const noTitle = { ...base, text: 'body only', counts: { likes: 2 } }
  assert.equal(buildContentHtml(noTitle), buildContentHtml({ ...noTitle, title: undefined }))
  assert.ok(!buildContentHtml(noTitle).includes('<b>body'), 'a bare body is never bolded')
})

test('a sensitive post is LABELLED in content, without the flag that blurs the media', () => {
  // The regression this exists to stop: the mapper shipped a sensitive post with no
  // sensitivity signal anywhere — no `sensitive`, an empty `spoiler_text`, an unmarked
  // `content` — and justified it in a comment with an og:description fallback that does not
  // reach this consumer. Proven: on a `sensitive: true` post,
  // /sensitive/i.test(JSON.stringify(status) + JSON.stringify(oembed)) was FALSE. Discord
  // reads the body from the activity JSON, not og:description (spec §3), so every Discord
  // viewer would have lost the warning Phase 1 already shows them.
  const s = toMastodonStatus({ ...fourImages, sensitive: true }, ORIGIN)
  assert.ok(s.content.startsWith('[sensitive] '), `no warning reached the viewer: ${s.content}`)
  // The LABEL, deliberately not Mastodon's content-warning MECHANISM: `sensitive: true` or a
  // non-empty spoiler_text makes clients blur or collapse exactly the media Discord came for.
  assert.ok(!('sensitive' in s), 'a Mastodon sensitive flag would blur the media')
  assert.equal(s.spoiler_text, '')
  // A prefix, not a replacement — the rest of the content is untouched.
  assert.equal(s.content, `[sensitive] ${buildContentHtml(fourImages)}`)
  assert.ok(!JSON.stringify(toMastodonStatus(fourImages, ORIGIN)).includes('[sensitive]'))
  // Truthiness, matching Phase 1's renderPost rule byte for byte, so the two renderers cannot
  // disagree about the same post. counts survive a JSON cache round trip, so this field can
  // arrive non-boolean; erring toward SHOWING the warning is the safe direction.
  assert.ok(toMastodonStatus({ ...base, sensitive: 'yes' }, ORIGIN).content.startsWith('[sensitive] '))
  // An image-only sensitive post has no text at all, and is exactly the post that most needs
  // the label. It must not degrade to a bare trailing space.
  assert.equal(toMastodonStatus({ ...base, text: '', media: [img(0)], sensitive: true }, ORIGIN).content, '[sensitive]')
})

test('the account block carries the §6c fields, and only those', () => {
  // The largest field set in the spec — 22 fields, all enumerated in §6c — and the only
  // nested block with no key-set guard while its sibling media_attachments[0] had one. A
  // dropped `indexable`, a typo'd `hide_collections` or a field bolted on later would ship
  // silently; only five of the 22 were touched by any assertion.
  const s = toMastodonStatus(base, ORIGIN)
  assert.deepEqual(Object.keys(s.account).sort(), [
    'acct', 'avatar', 'avatar_static', 'bot', 'created_at', 'discoverable', 'display_name',
    'emojis', 'fields', 'followers_count', 'following_count', 'group', 'hide_collections',
    'id', 'indexable', 'locked', 'noindex', 'roles', 'statuses_count', 'uri', 'url', 'username',
  ])
  // Without an avatar the SAME block is exactly two keys shorter and nothing else moves.
  const noAvatar = toMastodonStatus({ ...base, author: { ...base.author, avatar: undefined } }, ORIGIN)
  assert.deepEqual(
    Object.keys(noAvatar.account).sort(),
    Object.keys(s.account).sort().filter(k => k !== 'avatar' && k !== 'avatar_static'),
  )
})

test('the status carries the §6c fields, and only those', () => {
  // Presence AND absence are both load-bearing: `sensitive` and `spoiler_text:"<warning>"`
  // are the fields that would make Discord blur or hide the media. The sensitivity SIGNAL is
  // not dropped by omitting them — it rides `content` as a `[sensitive] ` prefix, which is
  // the surface Discord actually reads on this path (see the labelling test above).
  const s = toMastodonStatus(base, ORIGIN)
  assert.deepEqual(Object.keys(s).sort(), [
    'account', 'application', 'card', 'content', 'created_at', 'edited_at', 'emojis', 'id',
    'in_reply_to_account_id', 'in_reply_to_id', 'language', 'media_attachments', 'mentions',
    'poll', 'reblog', 'spoiler_text', 'tags', 'uri', 'url', 'visibility',
  ])
  assert.equal(s.visibility, 'public')
  assert.equal(s.spoiler_text, '')
  assert.equal(s.reblog, null)
  assert.equal(s.language, null)
  assert.ok(!('sensitive' in s), 'a Mastodon sensitive flag would blur the media Discord came for')
  // in_reply_to_id stays null even for a reply: the reply context is already rendered into
  // `content`, and a non-null id is an invitation to fetch a second status and draw it twice.
  const reply = toMastodonStatus({ ...base, replyTo: parent }, ORIGIN)
  assert.equal(reply.in_reply_to_id, null)
  assert.ok(reply.content.includes('Carol'), 'the reply context lives in content instead')
})

test('a media attachment carries the §6c fields, with description null when there is no alt', () => {
  const s = toMastodonStatus({ ...base, media: [img(0), { kind: 'image', url: cdnUrl(1), w: 10, h: 10 }] }, ORIGIN)
  assert.deepEqual(Object.keys(s.media_attachments[0]).sort(), [
    'description', 'id', 'meta', 'preview_remote_url', 'preview_url', 'remote_url', 'text_url', 'type', 'url',
  ])
  assert.equal(s.media_attachments[0].description, 'alt 0')
  // null, not undefined and not '': the key must survive JSON.stringify, and an empty string
  // is a claim that the author wrote empty alt text.
  assert.equal(s.media_attachments[1].description, null)
  assert.ok(JSON.stringify(s).includes('"description":null'))
})

test('oEmbed author_name: nonzero counts, else reply context, else the literal Embed', () => {
  // Spec §3, verified priority chain. Counts WIN over reply context — the two never both
  // appear — and a zero-valued metric is omitted entirely rather than rendered as 0.
  const counts = { replies: 5, reposts: 14, likes: 140 }
  assert.equal(
    toOEmbed({ ...base, counts, replyTo: parent }, ORIGIN).author_name,
    `${LIKES} 140${SEP}${REPLIES} 5${SEP}${REPOSTS} 14`,
    'counts outrank reply context',
  )
  assert.equal(toOEmbed({ ...base, replyTo: parent }, ORIGIN).author_name, '↪ Replying to @carol.bsky.social')
  assert.equal(toOEmbed(base, ORIGIN).author_name, 'Embed')

  // The zero-metrics case, which is the branch a naive `if (post.counts)` gets wrong: a
  // brand-new post has all three counts present and all three zero, and must fall THROUGH.
  assert.equal(toOEmbed({ ...base, counts: { likes: 0, reposts: 3, replies: 0 } }, ORIGIN).author_name, `${REPOSTS} 3`)
  assert.equal(
    toOEmbed({ ...base, counts: { likes: 0, reposts: 0, replies: 0 }, replyTo: parent }, ORIGIN).author_name,
    '↪ Replying to @carol.bsky.social',
    'an all-zero counts object must fall through to the reply branch',
  )
  assert.equal(toOEmbed({ ...base, counts: { likes: 0, reposts: 0, replies: 0 } }, ORIGIN).author_name, 'Embed')
  // Counts are abbreviated here for the same reason they are in `content` — one owner.
  assert.equal(toOEmbed({ ...base, counts: { likes: 1100 } }, ORIGIN).author_name, `${LIKES} 1.1K`)
})

test('the oEmbed reply branch needs a real handle, or it falls back to Embed', () => {
  // "↪ Replying to @" is worse than the fallback: it names nobody while claiming context.
  // Reachable because the cache guard validates a nested post's ref/canonical/createdAt but
  // not its author.
  for (const bad of [undefined, '', 42, {}, null]) {
    const p = { ...base, replyTo: { ...parent, author: { ...parent.author, handle: bad } } }
    assert.equal(toOEmbed(p, ORIGIN).author_name, 'Embed', `handle ${JSON.stringify(bad) ?? 'undefined'}`)
  }
  assert.equal(toOEmbed({ ...base, replyTo: { ...parent, author: undefined } }, ORIGIN).author_name, 'Embed')
})

test('oEmbed carries EXACTLY the 7 verified fields', () => {
  // Absence is the interesting half: html/width/height are omitted despite type:"rich",
  // because Discord reads only these seven and an html payload is a second body it could
  // render. `title` is the literal string "Embed" — the empty string is untested.
  const o = toOEmbed(base, ORIGIN)
  assert.deepEqual(Object.keys(o).sort(), [
    'author_name', 'author_url', 'provider_name', 'provider_url', 'title', 'type', 'version',
  ])
  assert.equal(o.author_url, base.canonical, 'the oEmbed author_url IS the post url — unlike account.url')
  assert.equal(o.provider_name, 'mbedfx')
  assert.equal(o.provider_url, ORIGIN)
  assert.equal(o.title, 'Embed')
  assert.equal(o.type, 'rich')
  assert.equal(o.version, '1.0')
})

test('both mappers survive JSON.stringify with no undefined-shaped holes', () => {
  // An `undefined` value silently disappears from JSON.stringify, so a field the spec
  // requires can be absent from the wire while the object in memory looks complete. Compare
  // the parsed blob to the object to catch that.
  for (const o of [toMastodonStatus(fourImages, ORIGIN), toOEmbed(fourImages, ORIGIN)]) {
    assert.deepEqual(JSON.parse(JSON.stringify(o)), o)
  }
})

test('application.name follows ref.p — not hardcoded Bluesky on every platform', () => {
  // mastodon.ts shipped the literal 'Bluesky Social' with a comment saying in as many words
  // that it becomes a per-ref.p lookup when Phase 3 lands TikTok. Left alone it puts
  // "Bluesky Social" on the footer of every TikTok embed we serve.
  const bs = toMastodonStatus(base, ORIGIN)
  assert.equal(bs.application.name, 'Bluesky Social')
  const tt = toMastodonStatus({ ...base, ref: { p: 'tt', id: '777' } }, ORIGIN)
  assert.equal(tt.application.name, 'TikTok')
  assert.equal(tt.application.website, null)
})

test('a corrupt ref.p degrades to a neutral name instead of a function or {}', () => {
  // Same hazard ATTACHMENT_TYPE carries a scar comment for: a raw lookup on an object literal
  // inherits Object.prototype, so 'constructor' resolves to a FUNCTION (silently dropped by
  // JSON.stringify) and '__proto__' to {} where a string is required. deserializePost
  // validates that the ref ROUND-TRIPS, so this is defence in depth — but it is one line.
  for (const p of ['constructor', '__proto__', 'toString', 'nope', 42, null]) {
    const s = toMastodonStatus({ ...base, ref: { p, id: '1' } }, ORIGIN)
    assert.equal(typeof s.application.name, 'string', String(p))
    assert.ok(s.application.name.length > 0, String(p))
  }
})

// ---------------------------------------------------------------------------
// preview_url IS THE POSTER FRAME, NOT A SECOND COPY OF THE URL. Measured 2026-07-19 by diffing
// the three media_attachments[0] objects Discord actually receives:
//
//   PROD video   (rich card)  type:"video"  preview_url ".../generate/COVER/{id}"  <- a poster IMAGE
//   OUR slideshow(rich card)  type:"image"  preview_url the image itself           <- fine, an image
//                                                                                     IS its poster
//   OUR video    (PLAIN card) type:"video"  preview_url THE VIDEO FILE             <- the defect
//
// Discord asks for the poster, receives mp4 bytes, and abandons the activity card. The Phase 2
// mapper set preview_url = url for EVERY attachment, which is harmless for an image and wrong
// only for a video — invisible until TikTok brought the first real video attachment.
// ---------------------------------------------------------------------------

/** A TikTok-shaped video post: one video attachment carrying its cover as `poster`. */
const TT_REF = { p: 'tt', id: '7660566211100511518' }
const ttKey = encodeURIComponent(refKey(TT_REF))
const TT_CDN = 'https://p16-common-sign.tiktokcdn-us.com'
const ttVideo = {
  ...base,
  ref: TT_REF,
  canonical: 'https://www.tiktok.com/@someone/video/7660566211100511518',
  media: [{
    kind: 'video',
    url: 'https://www.tiktok.com/aweme/v1/play/?file_id=abc',
    w: 720, h: 1280, duration: 67,
    poster: `${TT_CDN}/tos-useast8-p-0068-tx2/cover~tplv-tiktokx-orig`,
  }],
}

test('A VIDEO ATTACHMENT preview_url IS THE POSTER URL, AND IS NOT THE VIDEO URL', () => {
  const a = toMastodonStatus(ttVideo, ORIGIN).media_attachments[0]
  assert.equal(a.type, 'video', 'fixture sanity: this must be the attachment type that draws the player')
  assert.equal(a.url, `${ORIGIN}/_media/${ttKey}/0`)
  assert.equal(a.preview_url, `${ORIGIN}/_media/${ttKey}/poster0`)
  // The inequality IS the bug. Asserted on its own so a regression that reverted preview_url to
  // `url` fails here by name, not merely as a string mismatch three lines up.
  assert.notEqual(a.preview_url, a.url, 'preview_url pointing at the video is the defect itself')
})

test('THE POSTER URL IS ON OUR ORIGIN — no raw CDN url anywhere in the serialized status', () => {
  // The project constraint, restated for the field this change adds: a TikTok cover url is
  // signed and host-sharded, and Discord caches whatever it fetches. The assertion is over the
  // WHOLE serialized blob rather than the one field, because preview_url is the fourth
  // url-shaped slot in an attachment and the previous three were each covered this way.
  const blob = JSON.stringify(toMastodonStatus(ttVideo, ORIGIN))
  assert.ok(blob.includes(`/_media/${ttKey}/poster0`), 'the poster must ship as a /_media/ url')
  assert.ok(!blob.includes(TT_CDN), `a raw TikTok CDN host reached the client: ${TT_CDN}`)
  assert.ok(!blob.includes('tiktokcdn'), 'no tiktokcdn host may appear anywhere in the payload')
  assert.ok(!blob.includes('aweme/v1/play'), 'the raw aweme url must never be emitted either')
  // Every url-shaped value that is not null must be same-origin.
  for (const a of toMastodonStatus(ttVideo, ORIGIN).media_attachments) {
    for (const k of ['url', 'preview_url']) {
      if (a[k] != null) assert.ok(a[k].startsWith(`${ORIGIN}/_media/`), `${k} escaped our origin: ${a[k]}`)
    }
  }
})

test('A VIDEO WITH NO POSTER OMITS preview_url RATHER THAN POINTING IT AT THE VIDEO', () => {
  // Pointing it at the video is the actual defect, so it must not survive as a FALLBACK — that
  // would fix the measured case and leave the bug live for every video whose cover we failed to
  // extract, which is precisely the case a later platform is most likely to hit.
  const noPoster = { ...ttVideo, media: [{ ...ttVideo.media[0], poster: undefined }] }
  const a = toMastodonStatus(noPoster, ORIGIN).media_attachments[0]
  assert.equal(a.type, 'video')
  assert.equal(a.url, `${ORIGIN}/_media/${ttKey}/0`)
  assert.ok(!('preview_url' in a), `preview_url must be absent, got ${a.preview_url}`)
  assert.ok(!JSON.stringify(a).includes('preview_url'))
  // And it must never fall back to the video, by either spelling.
  assert.notEqual(a.preview_url, a.url)
})

test('a poster that is not a usable string is treated as NO poster', () => {
  // media[] arrives from the cache unvalidated (deserializePost checks ref, canonical and
  // createdAt only), so these are reachable shapes, and each must degrade to the omitted key
  // rather than to the video url or to a "/_media/{key}/poster0" that is guaranteed to 404.
  for (const bad of ['', 42, null, {}, []]) {
    const p = { ...ttVideo, media: [{ ...ttVideo.media[0], poster: bad }] }
    const a = toMastodonStatus(p, ORIGIN).media_attachments[0]
    assert.ok(!('preview_url' in a), `poster ${JSON.stringify(bad)} must yield no preview_url`)
  }
})

test('IMAGE ATTACHMENTS ARE UNCHANGED — preview_url still equals url (the slideshow must not regress)', () => {
  // The working case, pinned. Our TikTok slideshows and every Bluesky image post ship
  // preview_url === url and Discord draws the rich card for them today; this change must be
  // invisible to them. An image IS its own poster, which is exactly why they were never broken.
  const s = toMastodonStatus(fourImages, ORIGIN)
  assert.equal(s.media_attachments.length, 4)
  s.media_attachments.forEach((a, i) => {
    assert.equal(a.type, 'image')
    assert.equal(a.preview_url, a.url, 'an image attachment keeps preview_url === url')
    assert.equal(a.preview_url, `${ORIGIN}/_media/${encodeURIComponent(refKey(fourImages.ref))}/${i}`)
  })
  // An image entry that happens to carry a poster still ships preview_url === url: the poster
  // rule is scoped to `type === 'video'`, not to "has a poster field".
  const odd = { ...base, media: [{ ...img(0), poster: 'https://cdn/ignored.jpg' }] }
  const a = toMastodonStatus(odd, ORIGIN).media_attachments[0]
  assert.equal(a.preview_url, a.url)
})

test('the attachment KEY SET and key ORDER are unchanged for an image, and lose only preview_url for a posterless video', () => {
  // Key order is load-bearing for the byte-identical Bluesky pin below: JSON.stringify emits
  // insertion order, so moving preview_url would change every existing payload's bytes without
  // changing a single value.
  const IMAGE_KEYS = ['id', 'type', 'url', 'preview_url', 'remote_url', 'preview_remote_url', 'text_url', 'description', 'meta']
  assert.deepEqual(Object.keys(toMastodonStatus(fourImages, ORIGIN).media_attachments[0]), IMAGE_KEYS)
  assert.deepEqual(Object.keys(toMastodonStatus(ttVideo, ORIGIN).media_attachments[0]), IMAGE_KEYS)
  const noPoster = { ...ttVideo, media: [{ ...ttVideo.media[0], poster: undefined }] }
  assert.deepEqual(
    Object.keys(toMastodonStatus(noPoster, ORIGIN).media_attachments[0]),
    IMAGE_KEYS.filter(k => k !== 'preview_url'),
  )
})

// ---------------------------------------------------------------------------
// BLUESKY IS UNAFFECTED — VERIFIED, NOT ASSUMED.
//
// The claim is that Bluesky can never take the new poster branch, because its normalizer
// DOWNGRADES an HLS video embed to the video's still `thumbnail` as a plain image Media (Phase 1's
// I-1 lesson: an .m3u8 playlist advertised as og:video renders a dead player). So Bluesky emits no
// kind:'video' media at all, every attachment stays type:'image', and preview_url === url as
// before. Both halves are asserted below: the structural one (no video kind), and the byte one.
//
// The baseline fixture was generated from the code as it stood BEFORE the poster change, so this
// is a genuine before/after comparison rather than a snapshot of the new behaviour.
// ---------------------------------------------------------------------------

const BS_CASES = JSON.parse(readFileSync('test/fixtures/bluesky-media-cases.json', 'utf8'))
const BS_BASELINE = JSON.parse(readFileSync('test/fixtures/bluesky-render-baseline.json', 'utf8'))

test("BLUESKY MEDIA SHAPES: images stay images, a video is a remux entry", () => {
  // Fixture sanity underpinning the byte-identical baseline below. The image case must be all
  // images; the video case must be a single REMUX video whose poster carries the still — the shape
  // the /_media/ route muxes and withResolver degrades to a poster when no container is bound.
  const imgs = normalizeBluesky(BS_CASES.images.raw, BS_CASES.images.ref)
  assert.ok(imgs.media.length > 0 && imgs.media.every(m => m.kind === 'image'), 'the image case is all images')
  assert.ok(imgs.media.every(m => !('poster' in m) && !('remux' in m)), 'an image carries no poster/remux')

  const v = normalizeBluesky(BS_CASES.video.raw, BS_CASES.video.ref)
  assert.equal(v.media.length, 1)
  assert.equal(v.media[0].kind, 'video')
  assert.match(v.media[0].url, /playlist\.m3u8$/, 'the video url is the HLS playlist the container muxes')
  assert.equal(v.media[0].remux.video, v.media[0].url, 'remux.video is that same playlist')
  assert.match(v.media[0].poster, /thumbnail\.jpg$/, 'the poster is the still, for the no-container degrade')
})

test('BLUESKY OUTPUT IS BYTE-IDENTICAL ACROSS ALL THREE CLIENT CLASSES, before and after', async () => {
  for (const [name, { raw, ref }] of Object.entries(BS_CASES)) {
    const post = normalizeBluesky(raw, ref)
    const want = BS_BASELINE[name]
    assert.deepEqual(post.media, want.media, `${name}: normalizer media drifted`)
    // Compared as SERIALIZED bytes, not deepEqual: key order and null-vs-absent are exactly what
    // this change could disturb, and deepEqual sees through both.
    assert.equal(JSON.stringify(toMastodonStatus(post, ORIGIN)), JSON.stringify(want.activity), `${name}: activity JSON drifted`)
    assert.equal(JSON.stringify(toOEmbed(post, ORIGIN)), JSON.stringify(want.oembed), `${name}: oEmbed JSON drifted`)
    for (const client of ['discord', 'telegram', 'other-bot']) {
      const body = await render({ kind: 'post', post }, client, ORIGIN).text()
      assert.equal(body, want.html[client], `${name}/${client}: rendered HTML drifted`)
    }
  }
})

// ---------------------------------------------------------------------------
// THE MIXED CAROUSEL — the one genuinely new render shape Instagram brings.
//
// A media_attachments array mixing type:"image" and type:"video" has NEVER been produced by
// this service. Every gallery to date is homogeneous: Bluesky is all images (max 4), a TikTok
// slideshow is all images, a TikTok video post is exactly one video. An Instagram carousel is
// up to 10 entries with videos interleaved — simultaneously the first MIXED gallery and the
// first gallery carrying MORE THAN ONE video.
//
// These tests are the evidence for the plan's claim that the gallery, the poster route and the
// platform-identity tables are "free" for Instagram. A claim of inheritance is worth nothing
// until something exercises it, and nothing could: no `ig` Post existed before this phase.
// ---------------------------------------------------------------------------

/**
 * Five entries, videos at indices 2 and 4 — deliberately NOT at 0, and deliberately TWO of them.
 * A single-video platform (TikTok) can only ever have its video at index 0, so an off-by-one in
 * the poster index was structurally unreachable until this shape existed.
 *
 * 'https://cdn/…' rather than a realistic scontent host, so the "no raw CDN url may reach a
 * client" assertions can match the substring 'cdn/' and fail LOUDLY on a leak, the same trick
 * the Bluesky CDN/SIG constants at the top of this file play.
 */
const igMixed = () => ({
  ref: { p: 'ig', kind: 'p', code: 'ABC' },
  canonical: 'https://www.instagram.com/p/ABC/',
  author: { name: 'A', handle: 'a', url: 'https://www.instagram.com/a/' },
  text: 'x', createdAt: new Date('2026-07-01T00:00:00Z'), counts: {}, sensitive: false,
  media: [
    { kind: 'image', url: 'https://cdn/0.jpg', w: 1080, h: 1080 },
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1080, h: 1350 },
    { kind: 'video', url: 'https://cdn/2.mp4', w: 720, h: 1280, poster: 'https://cdn/2.jpg' },
    { kind: 'image', url: 'https://cdn/3.jpg', w: 1080, h: 1080 },
    { kind: 'video', url: 'https://cdn/4.mp4', w: 720, h: 1280, poster: 'https://cdn/4.jpg' },
  ],
})

test('A MIXED CAROUSEL KEEPS EVERY ENTRY, IN ORDER, AND ON OUR OWN ORIGIN', () => {
  // WAS "…WITH ITS OWN TYPE", 2026-07-20. Emitting each child with its own type is exactly what a
  // real Discord client was then measured DISCARDING — six of ten drawn, the four videos dropped —
  // so the types are now flattened and the assertion that pinned them has moved to the
  // mixed-gallery block at the foot of this file, inverted. See galleryHasVideo() in mastodon.ts.
  //
  // WHAT THIS TEST STILL OWNS, and it is the half that never depended on the types: every child
  // survives, in source order, addressing its OWN index on our origin. A flattening that also
  // dropped, reordered or collapsed entries would satisfy the new type assertion perfectly.
  //
  // Order is asserted as a whole array rather than entry-by-entry because the failure mode this
  // guards is a REORDERING: five entries whose urls no longer line up with their positions.
  //
  // COMPACTION is deliberately NOT this test's job, and the fixture cannot observe it — every
  // entry here passes usable(), so attachment() never returns null and the drop branch is never
  // taken. That hazard has its own THREE tests ('a corrupt media entry drops WITHOUT shifting
  // the indices after it', 'a corrupt PARENT entry does not shift the hoisted index' and 'a
  // media entry with no usable url is dropped, in place'), all of which go red on the real bug —
  // an index taken from output position instead of the loop counter. Verified by applying
  // exactly that mutation: those three fail, this one does not. Claiming the coverage here would
  // have left this comment the only thing standing between a future reader and the belief that a
  // shape-agnostic hazard was pinned by a shape-specific fixture.
  const s = toMastodonStatus(igMixed(), ORIGIN)
  assert.equal(s.media_attachments.length, 5)
  // The ids are the raw mediaList indices, so this is the order-and-completeness claim that used
  // to ride on the type array.
  assert.deepEqual(s.media_attachments.map(a => a.id), ['0', '1', '2', '3', '4'],
    'every child, in source order')
  for (const [i, a] of s.media_attachments.entries()) {
    // `/poster{i}` for the two converted videos, `/{i}` for the images — either way attachment i
    // addresses media i, which is the invariant /_media/ depends on.
    assert.match(a.url, new RegExp(`/_media/ig%3Ap%3AABC/(poster)?${i}$`), `attachment ${i} must address media ${i} on our origin`)
    assert.ok(!a.url.includes('cdn/'), 'no raw CDN url may reach a client')
  }
  assert.equal(s.application.name, 'Instagram', 'the APPLICATION table row is now reachable')
})

test('EVERY video attachment gets a POSTER url, and every image keeps its own', () => {
  // preview_url = the video file is the measured defect that cost the rich card. Two videos at
  // DIFFERENT indices is the case a single-video platform could never have caught: an off-by-one
  // here would give attachment 4 attachment 2's poster and look entirely plausible.
  const s = toMastodonStatus(igMixed(), ORIGIN)
  assert.match(s.media_attachments[2].preview_url, /\/poster2$/)
  assert.match(s.media_attachments[4].preview_url, /\/poster4$/)
  assert.ok(!s.media_attachments[2].preview_url.endsWith('/2'), 'preview_url must NOT be the video itself')
  // Images are deliberately untouched: an image IS its own poster.
  assert.equal(s.media_attachments[0].preview_url, s.media_attachments[0].url)
})

test('ALL-VIDEO: a child with NO usable poster is DROPPED, its siblings converted, still marked', () => {
  // WIDENED 2026-07-20. An all-video carousel is now flattened just like a mixed one (see the
  // ALL-VIDEO flatten test below for the WHY — the owner chose every item visible over the one
  // player Discord actually draws). So a posterless child in an all-video gallery follows the
  // MIXED rule, not the old all-video one: it is DROPPED, never emitted pointing at the mp4.
  // Pointing an image attachment at a video is the exact 2026-07-19 card-losing defect, and a
  // converted attachment with no poster has nowhere honest to point.
  const p = igAllVideo()
  delete p.media[0].poster
  let s
  assert.doesNotThrow(() => { s = toMastodonStatus(p, ORIGIN) }, 'a posterless video must not throw')
  assert.equal(s.media_attachments.length, 1, 'the posterless video is the only thing that drops')
  assert.equal(s.media_attachments[0].type, 'image', 'the surviving video is flattened to a poster still')
  // The id is the RAW index, so the drop is a HOLE at 0 rather than a shift.
  assert.deepEqual(s.media_attachments.map(a => a.id), ['1'],
    'dropping must not shift the indices after it — /_media/{key}/{i} addresses by position')
  // AND THE SURVIVING VIDEO KEEPS ITS OWN POSTER. Per-ENTRY, not per-payload: one failed cover
  // extraction must not cost the whole carousel its other videos.
  // MEASURED (on the mixed path): a posterUrl() that suppressed every poster once any video lacked
  // one passed the whole suite, because each test only ever looked at the entry it had just broken.
  // Here that mutation drops media[1] too and this length check goes to 0 — so it is guarded.
  assert.match(s.media_attachments[0].url, /\/poster1$/,
    'one posterless video must not strip the posters off its siblings')
  assert.match(s.media_attachments[0].preview_url, /\/poster1$/, 'an image is its own poster')
  assert.ok(!JSON.stringify(s).includes('/0'), 'nothing may still address the dropped video')
  // A partially-dropped all-video gallery still converted a video, so it is still marked. The
  // marker TRAILS the body (owner's call 2026-07-20), so it ends the content rather than leading it.
  assert.ok(s.content.endsWith(VIDEO_MARKER), 'the surviving conversion still carries the marker')
})

test('THE TWO DIMENSION CONVENTIONS CAN NO LONGER MEET IN ONE PAYLOAD — and that is structural', () => {
  // originalMeta() applies fudge() to video and TRUE dimensions to images, and this test used to
  // pin them appearing SIDE BY SIDE in a single mixed carousel — the first payload that could
  // carry both.
  //
  // THAT SHAPE NO LONGER EXISTS, 2026-07-20, and the reason is the point of this rewrite rather
  // than a reason to delete the test. Any gallery holding both an image and a video is by
  // definition MIXED, so it is flattened to all type:"image" before originalMeta() ever runs —
  // including the one shape that reaches two types without either post being mixed on its own, a
  // post whose QUOTE contributes the video (mediaList concatenates the two, and galleryHasVideo
  // asks the concatenated list). So "both conventions in one payload" is now UNREACHABLE, and the
  // useful assertion is that it is unreachable rather than merely absent.
  //
  // WHY PIN IT. The conventions still differ, and they still key off the emitted type — so a future
  // edit that narrowed the flattening (say, to the post's own media, missing the hoist) would
  // quietly bring the two-convention payload back, and nothing else in the suite would notice.
  //
  // THE DIMENSIONS CROSS fudge()'s THRESHOLD DELIBERATELY. It only moves a pair when w>1920||h>1920
  // (halve) or w<400&&h<400 (double); igMixed's 1080x1080, 1080x1350 and 720x1280 all sit inside
  // the pass-through band, where the two conventions are BYTE-IDENTICAL and every assertion below
  // would hold no matter which one ran. Measured against the pre-flattening code: inverting
  // originalMeta() to `type === 'image' ? fudge(...)` turned exactly ONE test red, and it was not
  // this one — in-band dimensions make the hazard invisible.
  const oversized = post => {
    const q = post
    q.media = q.media.map(m => ({ ...m, w: m.w * 2, h: m.h * 3 }))  // every entry now over 1920
    return q
  }

  // A MIXED CAROUSEL: every entry is an image after flattening, so every entry ships TRUE
  // dimensions. Not one fudge()d pair anywhere in the payload.
  const mixed = toMastodonStatus(oversized(igMixed()), ORIGIN)
  assert.deepEqual(mixed.media_attachments.map(a => a.meta.original.size),
    ['2160x3240', '2160x4050', '1440x3840', '2160x3240', '1440x3840'],
    'a flattened gallery is all image, so all TRUE — no fudge() survives in it')

  // A POST WHOSE QUOTE CARRIES THE VIDEO: the hoist makes mediaList two-type, and galleryHasVideo
  // asks that same concatenated list, so this flattens too. This is the case a flattening scoped
  // to post.media alone would get wrong, and it would look exactly like the old passing test.
  const quoting = {
    ...igMixed(),
    media: [{ kind: 'image', url: 'https://cdn/0.jpg', w: 4000, h: 2250 }],
    quote: { ...igMixed(), media: [{ kind: 'video', url: 'https://cdn/q.mp4', w: 2160, h: 3840, poster: 'https://cdn/q.jpg' }] },
  }
  const hoisted = toMastodonStatus(quoting, ORIGIN)
  assert.deepEqual(hoisted.media_attachments.map(a => a.type), ['image', 'image'],
    'a hoisted quote video makes the GALLERY mixed — the hoist must not escape the flattening')
  assert.deepEqual(hoisted.media_attachments.map(a => a.meta.original.size), ['4000x2250', '2160x3840'],
    'both TRUE: there is no video attachment left to take fudge()')

  // AND THE VIDEO CONVENTION IS STILL ALIVE where a video attachment survives — which since the
  // 2026-07-20 widening is ONLY a SINGLE video (an all-video carousel now flattens too, so it no
  // longer keeps a real video attachment). So the conventions were separated, not collapsed into
  // one: a lone reel/TikTok video still takes fudge().
  const single = toMastodonStatus(oversized(igSingleVideo()), ORIGIN)
  assert.deepEqual(single.media_attachments.map(a => a.type), ['video'])
  assert.deepEqual(single.media_attachments.map(a => a.meta.original.size), ['720x1920'],
    'a real video attachment still takes fudge()')
})

// ---------------------------------------------------------------------------
// THE MIXED-TYPE GALLERY FLATTENING — Discord renders only the type of the FIRST attachment.
//
// MEASURED IN A REAL DISCORD CLIENT, 2026-07-20. The Instagram carousel /p/DaQ5CPTki4E ships a
// wire payload that is already CORRECT by every assertion above: 10 media_attachments, types
// interleaved image,image,video,image,video,image,video,image,video,image, every video carrying a
// distinct real-JPEG poster in preview_url, all on our origin, all one hop. Discord drew SIX of
// them and silently discarded the four videos.
//
// WHY, established and not re-litigated here:
//   - FxEmbed issue #1113 ("add support for twitter's mixed media feature") is CLOSED/NOT_PLANNED,
//     maintainer comment: "Discord and Telegram won't allow mixed media in embeds unfortunately."
//   - A mixed array is not legal Mastodon either. Mastodon's own post service raises "Cannot attach
//     a video to a post that already contains images" when size > 1 and any attachment is
//     audio/video, and Status::MEDIA_ATTACHMENTS_LIMIT = 4. Discord's consumer has therefore NEVER
//     seen a mixed set: this is undefined behaviour, not a bug to route around.
//   - Discord keeps the type of the FIRST attachment. Two observations, one rule: FxEmbed's array
//     starts `video` and its 3 images drop; ours starts `image` and its 4 videos drop.
//   - The gallery is NOT capped at 4 on this path. Six rendered. Measured.
//
// THE ASYMMETRY THAT JUSTIFIES THE CONVERSION, and it is the whole argument: on this path there is
// NO inline playback to lose. The videos currently render as NOTHING AT ALL. Converting them to
// image attachments pointing at their poster turns four blanks into four visible frames. There is
// no shape of this change that can take a working player away from a mixed post, because a mixed
// post has never had one.
// ---------------------------------------------------------------------------

/** Two videos, at indices 2 and 4 — deliberately not at 0, and deliberately more than one. */
const igMixedFlat = () => igMixed()

/** An ALL-VIDEO gallery: more than one attachment, every one of them a video. */
const igAllVideo = () => ({
  ...igMixed(),
  media: [
    { kind: 'video', url: 'https://cdn/0.mp4', w: 720, h: 1280, poster: 'https://cdn/0.jpg' },
    { kind: 'video', url: 'https://cdn/1.mp4', w: 720, h: 1280, poster: 'https://cdn/1.jpg' },
  ],
})

/** A SINGLE-video post — the TikTok video and Instagram reel shape, verified in a real client. */
const igSingleVideo = () => ({
  ...igMixed(),
  media: [{ kind: 'video', url: 'https://cdn/0.mp4', w: 720, h: 1280, poster: 'https://cdn/0.jpg' }],
})

test('MIXED: every child appears, in SOURCE ORDER, and every one of them is type "image"', () => {
  // The fix. Ten-of-ten rather than six-of-ten is the entire point: a viewer sees every item
  // Instagram has, in the order Instagram has them.
  const s = toMastodonStatus(igMixedFlat(), ORIGIN)
  assert.equal(s.media_attachments.length, 5, 'no child may be dropped — all five must appear')
  assert.deepEqual(s.media_attachments.map(a => a.type),
    ['image', 'image', 'image', 'image', 'image'],
    'a mixed gallery must be flattened to ONE type, or Discord keeps only the first one')
  // SOURCE ORDER, asserted through the ids, which are the raw mediaList indices. A flattening that
  // sorted images-then-videos would also produce five type:"image" entries and would look fine.
  assert.deepEqual(s.media_attachments.map(a => a.id), ['0', '1', '2', '3', '4'],
    'source order must survive — the viewer sees Instagram\'s own order')
})

test('MIXED: a converted video points at its POSTER, never at the video url', () => {
  // Pointing an image attachment at an mp4 is the EXACT defect fixed on 2026-07-19: Discord asks
  // for a poster, receives video bytes, and abandons the whole card. Converting the type without
  // moving the url would reinstate it on every video in the carousel at once.
  const s = toMastodonStatus(igMixedFlat(), ORIGIN)
  const key = 'ig%3Ap%3AABC'
  for (const i of [2, 4]) {
    assert.equal(s.media_attachments[i].url, `${ORIGIN}/_media/${key}/poster${i}`,
      `converted attachment ${i} must address its OWN poster`)
    // Pinned to this attachment's own index, not /poster\d+$/: the loose pattern accepts every
    // converted video previewing poster0.
    assert.equal(s.media_attachments[i].preview_url, `${ORIGIN}/_media/${key}/poster${i}`,
      'an image IS its own poster, so preview_url must equal url')
    assert.ok(!s.media_attachments[i].url.endsWith(`/${i}`),
      'the url must NOT be the video file — that is the measured card-losing defect')
  }
  // The images beside them are untouched and still address themselves.
  assert.equal(s.media_attachments[0].url, `${ORIGIN}/_media/${key}/0`)
  assert.equal(s.media_attachments[3].url, `${ORIGIN}/_media/${key}/3`)
})

test('MIXED: a video with NO usable poster is DROPPED, and its siblings are unaffected', () => {
  // Dropping, not emitting-pointing-at-the-video. A converted attachment with no poster has
  // nowhere honest to point: the only other candidate is the mp4, which is the defect itself.
  const p = igMixedFlat()
  delete p.media[2].poster
  let s
  assert.doesNotThrow(() => { s = toMastodonStatus(p, ORIGIN) }, 'a posterless video must not throw')
  assert.equal(s.media_attachments.length, 4, 'the posterless video is the only thing that drops')
  // The ids are the RAW indices, so the drop is observable as a HOLE at 2 rather than a shift.
  assert.deepEqual(s.media_attachments.map(a => a.id), ['0', '1', '3', '4'],
    'dropping must not shift the indices after it — /_media/{key}/{i} addresses by position')
  assert.deepEqual(s.media_attachments.map(a => a.type), ['image', 'image', 'image', 'image'])
  // AND THE OTHER VIDEO IS UNAFFECTED. Per-ENTRY, not per-payload: one failed cover extraction
  // must not cost the whole carousel its other videos.
  assert.equal(s.media_attachments[3].url, `${ORIGIN}/_media/ig%3Ap%3AABC/poster4`,
    'one posterless video must not strip the poster off its siblings')
  assert.ok(!JSON.stringify(s).includes('/2'), 'nothing may still address the dropped video')
})

test('SINGLE VIDEO: UNCHANGED — still type "video", still a player', () => {
  // A reel and a TikTok video both render a real inline player, verified in a real client. The
  // flattening must not touch them: converting a working player into a still frame is a straight
  // regression, and it is the one thing this change could plausibly break.
  const s = toMastodonStatus(igSingleVideo(), ORIGIN)
  assert.equal(s.media_attachments.length, 1)
  assert.equal(s.media_attachments[0].type, 'video', 'a single video is NOT a mixed gallery')
  assert.equal(s.media_attachments[0].url, `${ORIGIN}/_media/ig%3Ap%3AABC/0`, 'url is the VIDEO')
  assert.equal(s.media_attachments[0].preview_url, `${ORIGIN}/_media/ig%3Ap%3AABC/poster0`)
  // fudge() still applies to a real video attachment, which is the convention that ships today.
  assert.equal(s.media_attachments[0].meta.original.size, '720x1280')
})

test('SINGLE VIDEO with no poster: still type "video", preview_url OMITTED — not dropped', () => {
  // The 2026-07-19 rule, untouched. Omission is the degradation for a NON-mixed video; dropping is
  // the degradation for a converted one. Conflating them would delete the only attachment on a
  // posterless reel and leave the post with no gallery at all.
  const p = igSingleVideo()
  delete p.media[0].poster
  const s = toMastodonStatus(p, ORIGIN)
  assert.equal(s.media_attachments.length, 1, 'a lone posterless video must NOT be dropped')
  assert.equal(s.media_attachments[0].type, 'video')
  assert.ok(!('preview_url' in s.media_attachments[0]), 'omission, never a fallback to the video')
})

test('ALL-VIDEO carousel: every child becomes type "image" at its own poster, in SOURCE ORDER', () => {
  // WIDENED 2026-07-20 — this test was the inverse ("all-video is left alone") until the owner
  // decided otherwise, with the tradeoff seen and accepted.
  //
  // An all-video carousel is NOT "mixed" by the old rule — Discord keeps the type of the first
  // attachment, and in an all-video array that first type IS every type, so nothing was discarded
  // on type grounds. But a real client showed what that actually renders: ONE playable video, the
  // other N-1 items HIDDEN (a 10-video post drew a single player). The owner has SEEN that and
  // chosen to flatten anyway — every item visible as a poster still with the "tap to watch" marker,
  // deliberately GIVING UP the one inline player so that nothing is invisible. So the gate widened
  // from "image AND video both present" to "more than one usable attachment AND at least one video".
  //
  // The compensating real player still ships on the surface that can carry it — discord.ts's
  // og:video head fallback is untouched (see the all-video head test below).
  const s = toMastodonStatus(igAllVideo(), ORIGIN)
  const key = 'ig%3Ap%3AABC'
  assert.equal(s.media_attachments.length, 2, 'no child may be dropped')
  assert.deepEqual(s.media_attachments.map(a => a.type), ['image', 'image'],
    'an all-video carousel is now flattened — every child is a poster still, or Discord hides all but one')
  // Each converted child addresses its OWN poster, and preview_url equals url (an image is its own
  // poster). Pinned to the entry's own index, not /poster\d+$/, so a bug pointing every child at
  // poster0 is caught.
  assert.equal(s.media_attachments[0].url, `${ORIGIN}/_media/${key}/poster0`, 'child 0 -> its own poster, not the mp4')
  assert.equal(s.media_attachments[1].url, `${ORIGIN}/_media/${key}/poster1`, 'child 1 -> its own poster')
  assert.equal(s.media_attachments[0].preview_url, `${ORIGIN}/_media/${key}/poster0`)
  assert.equal(s.media_attachments[1].preview_url, `${ORIGIN}/_media/${key}/poster1`)
  assert.ok(!s.media_attachments[0].url.endsWith('/0'), 'the url must NOT be the video file')
  // SOURCE ORDER through the ids, which are the raw mediaList indices.
  assert.deepEqual(s.media_attachments.map(a => a.id), ['0', '1'], 'source order must survive')
})

test('a GIF beside a video IS mixed — the test is on the EMITTED type, not on Media.kind', () => {
  // ATTACHMENT_TYPE maps 'gif' to 'image' (a Media.kind of 'gif' means the url IS an animated
  // .gif file). So a gif+video post emits image+video and IS a mixed gallery, while a gif+image
  // post emits image+image and is NOT. Answering mixedness on `m.kind` gets the second case wrong
  // and would flatten a gallery that never needed it.
  const p = igMixed()
  p.media = [
    { kind: 'gif', url: 'https://cdn/0.gif', w: 480, h: 480 },
    { kind: 'video', url: 'https://cdn/1.mp4', w: 720, h: 1280, poster: 'https://cdn/1.jpg' },
  ]
  const mixed = toMastodonStatus(p, ORIGIN)
  assert.deepEqual(mixed.media_attachments.map(a => a.type), ['image', 'image'],
    'gif emits image, so gif+video is MIXED and must flatten')

  const q = igMixed()
  q.media = [
    { kind: 'gif', url: 'https://cdn/0.gif', w: 480, h: 480 },
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1080, h: 1080 },
  ]
  const homogeneous = toMastodonStatus(q, ORIGIN)
  assert.deepEqual(homogeneous.media_attachments.map(a => a.url),
    [`${ORIGIN}/_media/ig%3Ap%3AABC/0`, `${ORIGIN}/_media/ig%3Ap%3AABC/1`],
    'gif+image is homogeneous — both entries keep their OWN url, nothing is redirected to a poster')
})

test('a corrupt entry beside a video does not make the gallery mixed by itself', () => {
  // usable() decides what is IN the gallery, so an unusable entry must not vote on its type. A
  // `media: [null, <video>]` record — reachable from the cache, which validates ref/canonical/
  // createdAt and nothing else — contributes no attachment, so the gallery is all-video and must
  // be left alone rather than flattened by a phantom.
  const p = igMixed()
  p.media = [null, { kind: 'video', url: 'https://cdn/1.mp4', w: 720, h: 1280, poster: 'https://cdn/1.jpg' }]
  const s = toMastodonStatus(p, ORIGIN)
  assert.equal(s.media_attachments.length, 1)
  assert.equal(s.media_attachments[0].type, 'video', 'a dead entry is not an image')
})

test('MIXED: a converted video takes the IMAGE dimension convention, because the bytes ARE an image', () => {
  // originalMeta() keys off the EMITTED type, and after conversion that is 'image' — so a
  // converted entry ships TRUE dimensions rather than fudge()d ones. That is correct rather than
  // incidental: the url now serves a poster JPEG, and fudge() is the video convention.
  const p = igMixedFlat()
  p.media[1] = { ...p.media[1], w: 4000, h: 2250 }  // IMAGE, oversized: must NOT be halved
  p.media[4] = { ...p.media[4], w: 2160, h: 3840 }  // CONVERTED video, oversized: also NOT halved
  const s = toMastodonStatus(p, ORIGIN)
  assert.deepEqual(s.media_attachments[1].meta.original,
    { width: 4000, height: 2250, size: '4000x2250', aspect: 4000 / 2250 },
    'the image keeps TRUE dimensions')
  assert.deepEqual(s.media_attachments[4].meta.original,
    { width: 2160, height: 3840, size: '2160x3840', aspect: 2160 / 3840 },
    'a CONVERTED video is an image now, so it takes the image convention')

  // And a REAL video attachment still takes fudge(), so the convention followed the type rather
  // than being deleted outright.
  const v = igSingleVideo()
  v.media[0] = { ...v.media[0], w: 2160, h: 3840 }
  assert.equal(toMastodonStatus(v, ORIGIN).media_attachments[0].meta.original.size, '1080x1920',
    'an unconverted video still takes fudge()')
})

test('MIXED: a converted video is MARKED as one in its description', () => {
  // THE DECISION, stated: converted videos ARE marked in the attachment `description` (alt text),
  // AND this tag is KEPT now that the visible `content` line exists (see the MARKER block at the
  // foot of this file). The two are complementary — this one is the screen-reader companion.
  //
  // WHY MARK AT ALL. The conversion is lossy in exactly one respect — a viewer sees a still frame
  // with nothing telling them it is a video, so nothing tells them to click through to the real
  // post for the motion. Marking costs one field on the entries that were converted and nothing
  // anywhere else.
  //
  // WHY KEEP `description`. It is PER-ENTRY, attached to the exact frame it describes, which a
  // per-POST `content` line cannot be; and it is SEMANTICALLY the right field — `description` is
  // Mastodon's alt text, and "this frame is a video" is true, useful alt text for a screen reader
  // whether or not Discord ever draws it. The VISIBLE cue a sighted Discord viewer needs is the
  // `content` marker; this is the accessibility half, kept because it costs nothing.
  const p = igMixedFlat()
  p.media[2] = { ...p.media[2], alt: 'a dog on a skateboard' }
  const s = toMastodonStatus(p, ORIGIN)
  assert.equal(s.media_attachments[2].description, 'Video: a dog on a skateboard',
    'the author\'s own alt text is PRESERVED, and the marker composes with it')
  assert.equal(s.media_attachments[4].description, 'Video',
    'with no alt text, the marker stands alone')
  // Unconverted entries are untouched: null when there is no alt, never the marker.
  assert.equal(s.media_attachments[0].description, null,
    'an image must not be labelled a video')
})

test('ALL-IMAGE GALLERIES ARE BYTE-FOR-BYTE UNCHANGED — TikTok slideshow and Bluesky 4-image', () => {
  // Both of these render correctly in a real Discord client TODAY. They are the control, and the
  // pin is on the exact serialized bytes rather than on a shape, because the flattening touches
  // the one function every gallery in the service passes through — a change that is "obviously
  // scoped to mixed" is exactly the kind that reorders a key or flips a null for everyone.
  const slideshow = normalizeTikTok(readFileSync('test/fixtures/tiktok-slideshow.html', 'utf8'), { p: 'tt', id: '7534' })
  assert.equal(JSON.stringify(toMastodonStatus(slideshow, ORIGIN).media_attachments), TT_SLIDESHOW_GOLDEN,
    'the TikTok slideshow payload must not move by one byte')
  assert.equal(JSON.stringify(toMastodonStatus(fourImages, ORIGIN).media_attachments), BS_FOUR_IMAGE_GOLDEN,
    'the Bluesky 4-image payload must not move by one byte')
})

test('SINGLE-VIDEO PAYLOADS ARE BYTE-FOR-BYTE UNCHANGED — TikTok video and Instagram reel', () => {
  // The two shapes a human verified as rendering a real inline player. Same argument as the
  // all-image pin above, on the other side of the type split.
  const video = normalizeTikTok(readFileSync('test/fixtures/tiktok-video.html', 'utf8'), { p: 'tt', id: '7535' })
  assert.equal(JSON.stringify(toMastodonStatus(video, ORIGIN).media_attachments), TT_VIDEO_GOLDEN,
    'the TikTok video payload must not move by one byte')
  const reel = normalizeInstagram(readFileSync('test/fixtures/instagram-reel.html', 'utf8'), { p: 'ig', kind: 'p', code: 'Da5ynsiuAZ_' })
  assert.equal(JSON.stringify(toMastodonStatus(reel, ORIGIN).media_attachments), IG_REEL_GOLDEN,
    'the Instagram reel payload must not move by one byte')
})

test('NO RAW CDN URL IN THE SERIALIZED STATUS, FOR ANY SHAPE', () => {
  // The project constraint, swept across every shape this change can produce — including the two
  // NEW ones, a flattened carousel and a carousel with a dropped child. The conversion moves a
  // url, and "moves a url" is precisely the change that leaks one: the poster is a raw CDN url on
  // the Media, and emitting `m.poster` instead of mediaUrl(..., {poster: i}) would be a one-token
  // slip that renders perfectly.
  const posterless = igMixedFlat()
  delete posterless.media[2].poster
  const allVideoPosterless = igAllVideo()
  delete allVideoPosterless.media[0].poster
  const shapes = {
    mixed: igMixedFlat(),
    'mixed with a dropped child': posterless,
    'all video': igAllVideo(),
    'all video with a dropped child': allVideoPosterless,
    'single video': igSingleVideo(),
    'four images': fourImages,
    'tiktok slideshow': normalizeTikTok(readFileSync('test/fixtures/tiktok-slideshow.html', 'utf8'), { p: 'tt', id: '7534' }),
    'instagram carousel': normalizeInstagram(readFileSync('test/fixtures/instagram-carousel.html', 'utf8'), { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' }),
  }
  for (const [name, post] of Object.entries(shapes)) {
    const blob = JSON.stringify(toMastodonStatus(post, ORIGIN))
    assert.ok(!/cdninstagram|scontent|fbcdn|tiktokcdn|cdn\.bsky\.app|https:\/\/cdn\//.test(blob),
      `${name}: a raw CDN url reached the wire`)
    assert.ok(!blob.includes(SIG), `${name}: a signed CDN url reached the wire`)
  }
})

test('THE og:video HEAD FALLBACK IS UNCHANGED FOR A MIXED POST', () => {
  // The compensating surface, and the reason the gallery is allowed to give up playback at all:
  // non-Discord consumers and the OpenGraph path still get a REAL video. It is driven by
  // playableVideo() over the post's own media in discord.ts and must stay completely independent
  // of what the gallery mapper decides — a "tidy-up" that routed the head through the same
  // flattening would take the last real player away from every mixed post.
  const post = normalizeInstagram(readFileSync('test/fixtures/instagram-carousel.html', 'utf8'), { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' })
  const head = render({ kind: 'post', post }, 'discord', ORIGIN)
  return head.text().then(html => {
    // The og:video still points at media index 2 — the first real VIDEO in the post's own list,
    // NOT at a poster and NOT at index 0.
    assert.ok(html.includes(`<meta property="og:video" content="${ORIGIN}/_media/ig%3Ap%3ADaQ5CPTki4E/2.mp4"/>`),
      'og:video must still address the real mp4')
    assert.ok(html.includes(`<meta property="og:type" content="video.other"/>`))
    assert.ok(html.includes(`<meta property="twitter:player" content="${ORIGIN}/_media/ig%3Ap%3ADaQ5CPTki4E/2.mp4"/>`))
    assert.ok(html.includes(`<meta property="og:video:width" content="720"/>`))
    assert.ok(html.includes(`<meta property="og:video:height" content="900"/>`))
    // And the head still emits ZERO og:image — the suppression that makes the activity card win.
    assert.ok(!html.includes('og:image'), 'the spoof head must emit no og:image on a media post')
    // 1707 -> 1701 on 2026-07-30, and the SIX bytes are accounted for exactly: og:site_name went
    // from "fxeverything" (12) to "mbedfx" (6) in the rename. Every semantic assertion above is
    // unchanged, which is what makes this a rename rather than drift. Do not adjust this number to
    // make a red test green without an equally specific reason.
    // 1701 -> 1697 -> 1745, and every step is accounted for, which is the point of asserting a
    // length at all:
    //   -4   theme-color respelled property= to name=, the spelling Discord actually reads
    //   +48  property= re-added BESIDE it, one value from one call, for consumer coverage
    // 48 is exactly len('<meta property="theme-color" content="#0085ff"/>'). A number that moves by
    // precisely the expected amount is the evidence that nothing ELSE moved — see discord.ts.
    assert.equal(html.length, 1745, 'the mixed post\'s head must not move by one byte')
  })
})

test('THE og:video HEAD FALLBACK IS UNCHANGED FOR AN ALL-VIDEO POST', () => {
  // The whole warrant for flattening an all-video carousel: the gallery gives up its one inline
  // player, and this head keeps a REAL video for the OpenGraph path and every non-Discord consumer.
  // It is driven by playableVideo() over the post's OWN media in discord.ts, entirely independent
  // of the gallery mapper — so the flattening in mastodon.ts must not leak here. The head points at
  // the FIRST video (index 0) as its real mp4, emits no og:image, and carries NO marker (the marker
  // is a `content`-only surface).
  const s = toMastodonStatus(igAllVideo(), ORIGIN)
  assert.ok(s.content.endsWith(VIDEO_MARKER), 'precondition: the all-video activity content IS marked')
  const head = render({ kind: 'post', post: igAllVideo() }, 'discord', ORIGIN)
  return head.text().then(html => {
    assert.ok(html.includes(`<meta property="og:video" content="${ORIGIN}/_media/ig%3Ap%3AABC/0.mp4"/>`),
      'og:video must still address the real mp4 at index 0')
    assert.ok(html.includes(`<meta property="og:type" content="video.other"/>`))
    assert.ok(html.includes(`<meta property="twitter:player" content="${ORIGIN}/_media/ig%3Ap%3AABC/0.mp4"/>`))
    assert.ok(html.includes(`<meta property="og:video:width" content="720"/>`))
    assert.ok(html.includes(`<meta property="og:video:height" content="1280"/>`))
    assert.ok(!html.includes('og:image'), 'the spoof head must emit no og:image on a media post')
    assert.ok(!html.includes('\u{1F3AC}'), 'the marker belongs to the activity content, never the head')
  })
})

// ---------------------------------------------------------------------------
// THE VISIBLE MIXED-GALLERY MARKER — a trailing line in `content`, which Discord DRAWS.
//
// The mixed-gallery flattening above converts each video child to a poster still so every item
// renders. That is pure gain except in ONE respect: a still frame carries nothing telling the
// viewer it is a video, so nothing tells them to click through for the motion. The per-attachment
// `description: "Video"` tag is Mastodon ALT TEXT, which Discord does not draw. This marker puts
// the same information on the surface Discord DOES render — the Mastodon `content` field, verified
// (the caption and counts both reach a real client from it). Moved 2026-07-20 (owner's call) from
// a leading line above the caption to a TRAILING line below the counts, next to the engagement
// numbers — so `content` now ENDS with the marker: `…caption…counts<br><br>🎬 …tap to watch`.
//
// SCOPED to exactly the posts the flattening touches: mixed AND at least one video actually
// converted to a still (had a usable poster). A pure-image gallery, a single image, a single
// video/reel and an all-video gallery are all UNCHANGED — the marker and the conversion are driven
// by the same gate so they cannot disagree.
// ---------------------------------------------------------------------------

// U+1F3AC clapper, U+2014 EM DASH — built from CODEPOINTS on purpose, so this constant fails to
// match a source file where an editor silently swapped the em dash for an ASCII hyphen.
const VIDEO_MARKER = '\u{1F3AC} Contains video — tap to watch'

test('MARKER: a mixed carousel appends the marker line, after the caption and counts', () => {
  // text + counts, so the assertion sees the marker TRAILING a NON-empty body: caption, GAP, counts,
  // GAP, marker. The strong pin is content === buildContentHtml + <br><br> + marker, which proves
  // in one line that the marker trails, that the separator is the builder's own GAP, and that the
  // whole caption/counts body is preserved unchanged ahead of it (buildContentHtml is its one owner).
  const p = { ...igMixed(), text: 'a real caption', counts: { likes: 5 } }
  const s = toMastodonStatus(p, ORIGIN)
  assert.ok(s.content.endsWith(`<br><br>${VIDEO_MARKER}`), `content must end with the marker line: ${s.content}`)
  assert.equal(s.content, `${buildContentHtml(p)}<br><br>${VIDEO_MARKER}`, 'the unchanged body + GAP + marker')
  assert.ok(s.content.includes('a real caption'), 'the caption still precedes the marker')
  assert.match(s.content, /<b>❤️ 5&ensp;<\/b>/, 'the counts block still follows the caption')
  // Both the caption and the counts come BEFORE the marker now that it trails.
  assert.ok(s.content.indexOf('a real caption') < s.content.indexOf(VIDEO_MARKER), 'the caption precedes the marker')
  assert.ok(s.content.indexOf('❤️ 5') < s.content.indexOf(VIDEO_MARKER), 'the counts precede the marker')
  // Exactly once — split on the marker yields two pieces iff there is exactly one occurrence.
  assert.equal(s.content.split(VIDEO_MARKER).length, 2, 'the marker must appear exactly once')
})

test('MARKER: exact codepoints — U+1F3AC clapper and U+2014 em dash, never a hyphen', () => {
  // An editor can swap an em dash for a hyphen invisibly. Every check below reads the marker line
  // off REAL rendered content and compares by CODEPOINT, so a hyphen in the source turns it red
  // regardless of how the constant looks in a diff.
  const content = toMastodonStatus(igMixed(), ORIGIN).content
  // The marker is the LAST block now that it trails the body — take the final <br><br>-delimited part.
  const blocks = content.split('<br><br>')
  const markerLine = blocks[blocks.length - 1]
  assert.equal(markerLine.codePointAt(0), 0x1F3AC, 'the marker opens with the clapper U+1F3AC')
  assert.ok(markerLine.includes(String.fromCodePoint(0x2014)), 'the dash is an em dash U+2014')
  assert.ok(!markerLine.includes('-'), 'never an ASCII hyphen')
  assert.ok(!markerLine.includes(String.fromCodePoint(0x2013)), 'never an en dash U+2013 either')
  assert.equal(markerLine, VIDEO_MARKER, 'the marker line is the exact fixed prose, byte for byte')
})

test('MARKER: with a [sensitive] prefix, [sensitive] is OUTERMOST and the marker follows it', () => {
  // ORDERING DECISION: [sensitive] outermost (first). It is the content WARNING and must lead — a
  // viewer scanning the top of the embed sees the warning before anything else. It also keeps the
  // existing role of the [sensitive] prefix unchanged: it wraps the whole content body, and the
  // marker is simply the LAST block inside what it labels (owner's call 2026-07-20 moved the marker
  // to trail the counts). Both markers are present: [sensitive] leads, the marker trails.
  const p = { ...igMixed(), text: 'cap', sensitive: true }
  const s = toMastodonStatus(p, ORIGIN)
  assert.equal(s.content, `[sensitive] ${buildContentHtml(p)}<br><br>${VIDEO_MARKER}`)
  assert.ok(s.content.startsWith('[sensitive] '), '[sensitive] leads')
  assert.ok(s.content.endsWith(VIDEO_MARKER), 'the marker is the LAST block')
  assert.ok(s.content.indexOf('[sensitive]') < s.content.indexOf(VIDEO_MARKER), '[sensitive] is outermost')
  assert.equal(s.content.split(VIDEO_MARKER).length, 2, 'the marker still appears exactly once')
})

test('MARKER: pure-image galleries are UNCHANGED — no marker, byte-for-byte', () => {
  // The control. These render correctly today and must not move by a byte. Pinned as the literal
  // caption for the Bluesky post and as buildContentHtml verbatim for the TikTok slideshow.
  assert.equal(toMastodonStatus(fourImages, ORIGIN).content, 'hello', 'a Bluesky 4-image caption is untouched')
  const slideshow = normalizeTikTok(readFileSync('test/fixtures/tiktok-slideshow.html', 'utf8'), { p: 'tt', id: '7534' })
  const sc = toMastodonStatus(slideshow, ORIGIN).content
  assert.equal(sc, buildContentHtml(slideshow), 'a TikTok slideshow content stays buildContentHtml verbatim')
  assert.ok(!sc.includes('\u{1F3AC}'), 'no video marker may reach an all-image gallery')
})

test('MARKER: a single image and a single reel/video are UNCHANGED — no marker', () => {
  const singleImage = toMastodonStatus({ ...base, media: [img(0)] }, ORIGIN)
  assert.equal(singleImage.content, 'hello', 'a single image is not a mixed gallery')
  assert.ok(!singleImage.content.includes('\u{1F3AC}'))
  const reel = toMastodonStatus(igSingleVideo(), ORIGIN)
  assert.equal(reel.content, buildContentHtml(igSingleVideo()), 'a single video renders a real player, so no marker')
  assert.ok(!reel.content.includes('\u{1F3AC}'))
})

test('MARKER: an all-video carousel IS marked, exactly once', () => {
  // WIDENED 2026-07-20. An all-video carousel is now flattened (see the ALL-VIDEO flatten test) —
  // every video becomes a poster still — so it converts videos and therefore carries the marker,
  // by the SAME gate as a mixed carousel. The marker and the conversion share one predicate, so
  // they cannot disagree: a gallery that flattens is a gallery that gets marked.
  const p = { ...igAllVideo(), text: 'a caption', counts: { likes: 5 } }
  const s = toMastodonStatus(p, ORIGIN)
  assert.ok(s.content.endsWith(`<br><br>${VIDEO_MARKER}`), `content must end with the marker: ${s.content}`)
  assert.equal(s.content, `${buildContentHtml(p)}<br><br>${VIDEO_MARKER}`, 'the unchanged body + GAP + marker')
  assert.equal(s.content.split(VIDEO_MARKER).length, 2, 'the marker must appear exactly once')
})

test('MARKER: buildPlainText / og:description carry NO marker — wrong surface', () => {
  // The marker is a property of the Discord/Mastodon `content` surface ONLY. buildPlainText is the
  // og:description SOURCE (discord.ts and telegram.ts feed it there), and a count- and marker-free
  // body is its contract. Proven end-to-end: the SAME real carousel that IS marked on its activity
  // content carries no marker anywhere in the rendered OpenGraph head.
  assert.ok(!buildPlainText(igMixed()).includes('\u{1F3AC}'), 'the plain-text builder must never carry the marker')
  const post = normalizeInstagram(readFileSync('test/fixtures/instagram-carousel.html', 'utf8'), { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' })
  assert.ok(toMastodonStatus(post, ORIGIN).content.endsWith(VIDEO_MARKER),
    'precondition: this mixed carousel IS marked on the activity surface')
  const head = render({ kind: 'post', post }, 'discord', ORIGIN)
  return head.text().then(html => {
    assert.ok(!html.includes('\u{1F3AC}'), 'the marker belongs to the activity content, never the OpenGraph head')
  })
})

// ---------------------------------------------------------------------------
// TASK 6 — TWITTER VIDEO / GIF / MULTI-PHOTO / QUOTE / REPLY RENDERING, ALL FREE.
//
// There is no genuinely new render SHAPE here the way Instagram's mixed carousel was: Twitter
// galleries are homogeneous (<=4 photos, OR one video, OR one animated_gif), every one of which
// three platforms already render. These tests convert "the render layer is free for Twitter" from
// a claim into evidence — the first time a real {p:'x'} Post reaches ATTACHMENT_TYPE, APPLICATION.x
// and the poster branch — and pin the ONE Twitter-specific wrinkle: an animated_gif is normalized
// to kind:'video' (Task 2) and must therefore render as a PLAYER with a poster still, never as an
// image attachment pointing at the mp4 (the invisible 2026-07-19 poster defect — a gif "looks like"
// an image, so a kind:'gif' regression here would pass every eye and fail only Discord).
// ---------------------------------------------------------------------------

const xVideo = () => ({
  ref: { p: 'x', id: '20' }, canonical: 'https://x.com/jack/status/20',
  author: { name: 'jack', handle: 'jack', url: 'https://x.com/jack' },
  text: 'x', createdAt: new Date('2020-01-01T00:00:00Z'), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: 'https://video.twimg.com/v.mp4', w: 1280, h: 720,
            poster: 'https://pbs.twimg.com/v.jpg' }],
})
const xGif = () => ({ ...xVideo(),
  media: [{ kind: 'video', url: 'https://video.twimg.com/g.mp4', w: 480, h: 480,
            poster: 'https://pbs.twimg.com/g.jpg' }] })
const xMultiPhoto = () => ({ ...xVideo(), media: [
  { kind: 'image', url: 'https://pbs.twimg.com/0.jpg', w: 1200, h: 900 },
  { kind: 'image', url: 'https://pbs.twimg.com/1.jpg', w: 1200, h: 900 },
  { kind: 'image', url: 'https://pbs.twimg.com/2.jpg', w: 1200, h: 900 },
] })

test('a Twitter video attachment is type video with a poster preview_url that is NOT the mp4', () => {
  const s = toMastodonStatus(xVideo(), ORIGIN)
  assert.equal(s.media_attachments.length, 1)
  assert.equal(s.media_attachments[0].type, 'video')
  assert.match(s.media_attachments[0].url, /\/_media\/x%3A20\/0$/)
  assert.match(s.media_attachments[0].preview_url, /\/poster0$/)
  assert.ok(!s.media_attachments[0].preview_url.endsWith('/0'), 'preview_url must not be the video')
  assert.equal(s.application.name, 'Twitter', 'the APPLICATION row is reachable and says Twitter')
})

test('an animated_gif rides the video path — a poster still, never an image attachment at the mp4', () => {
  const s = toMastodonStatus(xGif(), ORIGIN)
  assert.equal(s.media_attachments[0].type, 'video')          // NOT image
  assert.match(s.media_attachments[0].preview_url, /\/poster0$/)
})

test('a multi-photo tweet keeps every image, on our origin, in order', () => {
  const s = toMastodonStatus(xMultiPhoto(), ORIGIN)
  assert.deepEqual(s.media_attachments.map(a => a.type), ['image', 'image', 'image'])
  for (const [i, a] of s.media_attachments.entries()) {
    assert.match(a.url, new RegExp(`/_media/x%3A20/${i}$`))
    assert.ok(!a.url.includes('pbs.twimg'))
  }
})

// Quote/reply render consequence: the renderer already consumes quote/replyTo (text.ts quoteHtml /
// replyPrefix, media.ts mediaList hoist). These pin that the Twitter Post reaches those paths.
const xQuote = () => ({
  ref: { p: 'x', id: '20' }, canonical: 'https://x.com/jack/status/20',
  author: { name: 'jack', handle: 'jack', url: 'https://x.com/jack' },
  text: 'look at this', createdAt: new Date('2020-01-01T00:00:00Z'), counts: {}, sensitive: false,
  media: [],
  quote: {
    ref: { p: 'x', id: '99' }, canonical: 'https://x.com/NASA/status/99',
    author: { name: 'NASA', handle: 'NASA', url: 'https://x.com/NASA' },
    text: 'a real photo', createdAt: new Date('2019-01-01T00:00:00Z'), counts: {}, sensitive: false,
    media: [{ kind: 'image', url: 'https://pbs.twimg.com/q.jpg', w: 1200, h: 900 }],
  },
})
const xReply = () => ({ ...xQuote(), quote: undefined,
  replyTo: {
    ref: { p: 'x', id: '77' }, canonical: 'https://x.com/i/status/77',
    author: { name: 'someone', handle: 'someone', url: 'https://x.com/someone' },
    text: '', createdAt: new Date('2019-01-01T00:00:00Z'), counts: {}, sensitive: false, media: [],
  } })

test('a quote-tweet renders the quoted author + text in content, and hoists the quote image onto OUR origin', () => {
  const s = toMastodonStatus(xQuote(), ORIGIN)
  assert.match(s.content, /Quoting/)
  assert.match(s.content, /NASA/, 'the quoted author')
  assert.match(s.content, /a real photo/, 'the quoted text')
  // The quoted post's image is hoisted into the gallery, addressed via the PARENT refKey x:20 —
  // never the quote's own id and never the raw CDN url (mastodon.ts hoist rule).
  const urls = s.media_attachments.map(a => a.url)
  assert.ok(urls.length >= 1 && urls.every(u => u.includes('/_media/x%3A20/')))
  assert.ok(!JSON.stringify(s).includes('pbs.twimg'), 'the quoted image never leaks as a raw CDN url')
})

test('a reply renders the parent handle as reply context, with no fabricated parent text', () => {
  const s = toMastodonStatus(xReply(), ORIGIN)
  assert.match(s.content, /@someone/, 'the reply-context line names the parent handle')
})

/**
 * A QUOTE MUST NOT COST THE POST ITS PLAYER — reported 2026-07-31 on x:2082783260523020766, against
 * fxtwitter, which shows the video:
 *
 *     post  media: 1 video (1080x1080)
 *     quote media: 1 video (388x360)
 *     mediaList   : 2 videos -> galleryHasVideo -> BOTH flattened -> two stills, no player
 *
 * galleryHasVideo asks its question over mediaList(), "the array Discord actually receives", and that
 * is right for a post whose OWN media is a gallery. It is wrong when the post IS a single video that
 * happens to quote something: the second item exists only because we hoisted it, and flattening then
 * destroys the one thing the post is. The owner looked at Discord and said he wanted the video —
 * which is the human verdict this file's own comments say the question can only be settled by.
 */
test('A SINGLE-VIDEO POST KEEPS ITS PLAYER WHEN IT QUOTES ANOTHER VIDEO', () => {
  const vid = (id, w, h) => ({ kind: 'video', url: `https://video.twimg.com/${id}.mp4`, w, h,
    poster: `https://pbs.twimg.com/${id}.jpg` })
  const post = {
    ref: { p: 'x', id: '2082783260523020766' },
    canonical: 'https://x.com/Buckaroo_Skiddo/status/2082783260523020766',
    author: { name: 'Buckaroo', handle: 'Buckaroo_Skiddo', url: 'https://x.com/Buckaroo_Skiddo' },
    text: 'It\'s okay. You will make it through this.',
    createdAt: new Date('2026-07-30T00:00:00Z'),
    media: [vid('a', 1080, 1080)],
    counts: {},
    sensitive: false,
    quote: {
      ref: { p: 'x', id: '2082000000000000000' },
      canonical: 'https://x.com/methchan/status/2082000000000000000',
      author: { name: 'meth chan', handle: 'methchan', url: 'https://x.com/methchan' },
      text: 'quoted',
      createdAt: new Date('2026-07-29T00:00:00Z'),
      media: [vid('b', 388, 360)],
      counts: {},
      sensitive: false,
    },
  }
  const s = toMastodonStatus(post, ORIGIN)
  assert.equal(s.media_attachments[0].type, 'video', 'the post\'s own video must still be a player')
  assert.doesNotMatch(String(s.content), /Contains video/,
    'and nothing was flattened, so nothing is claimed about it')
})

test('A REAL GALLERY WITH A VIDEO STILL FLATTENS — the exception is scoped, not a removal', () => {
  // The behaviour galleryHasVideo exists for is untouched: a post whose OWN media is a multi-item
  // gallery containing video still flattens to posters and still says so.
  const post = {
    ref: { p: 'x', id: '1' },
    canonical: 'https://x.com/a/status/1',
    author: { name: 'a', handle: 'a', url: 'https://x.com/a' },
    text: 'gallery',
    createdAt: new Date('2026-07-30T00:00:00Z'),
    media: [
      { kind: 'video', url: 'https://video.twimg.com/v.mp4', w: 10, h: 10, poster: 'https://pbs.twimg.com/v.jpg' },
      { kind: 'image', url: 'https://pbs.twimg.com/i.jpg', w: 10, h: 10 },
    ],
    counts: {},
    sensitive: false,
  }
  const s = toMastodonStatus(post, ORIGIN)
  assert.equal(s.media_attachments[0].type, 'image', 'a real mixed gallery still flattens')
  assert.match(String(s.content), /Contains video/, 'and still warns')
})
