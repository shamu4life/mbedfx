import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postCacheKey, respCacheKey, serializePost, deserializePost, cacheUrl } from '../src/cache.ts'

const ref = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }

test('the Post layer is shared across client classes', () => {
  // One upstream fetch must serve discord, telegram and every other bot.
  assert.equal(postCacheKey(ref), 'post:bs:alice.bsky.social:3k2a')
})

test('the response layer varies by client class AND by origin', () => {
  const PROD = 'https://megapenispoopenfarten.sex'
  const STAGING = 'https://staging.megapenispoopenfarten.sex'
  assert.equal(respCacheKey(ref, 'discord', PROD), `resp:bs:alice.bsky.social:3k2a:discord:${PROD}`)
  assert.notEqual(respCacheKey(ref, 'discord', PROD), respCacheKey(ref, 'telegram', PROD))
  // THE ORIGIN SPLIT, added with the apex cutover 2026-07-25. A rendered response embeds the
  // hostname that rendered it (every og:video / twitter:player url is built from the request's own
  // origin), so two hostnames served by one worker must not share an entry. Measured right after the
  // cutover: the apex replayed staging-warmed cards whose og:video pointed at staging, and Discord
  // caches that media url — pinning a hostname built to be disposable. The post cache stays shared.
  assert.notEqual(respCacheKey(ref, 'discord', PROD), respCacheKey(ref, 'discord', STAGING))
})

test('the media route and the post cache agree on identity', () => {
  // /_media/ reads the Post cache; if the keys diverged, every media hit would miss.
  assert.ok(postCacheKey(ref).endsWith('bs:alice.bsky.social:3k2a'))
})

test('cacheUrl is a valid URL even for keys with colons and slashes', () => {
  const weird = { p: 'bs', handle: 'did:plc:abc/def', rkey: 'r k' }
  assert.doesNotThrow(() => new URL(cacheUrl(postCacheKey(weird))))
})

test('Post survives a serialize/deserialize round trip, Date included', () => {
  const post = {
    ref,
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'hi',
    createdAt: new Date('2026-07-01T12:00:00Z'),
    media: [{ kind: 'image', url: 'https://cdn/a.jpg', w: 1, h: 2 }],
    counts: { likes: 1 },
    sensitive: false,
  }
  const back = deserializePost(serializePost(post))
  assert.ok(back.createdAt instanceof Date, 'createdAt must survive as a Date, not a string')
  assert.equal(back.createdAt.toISOString(), post.createdAt.toISOString())
  assert.deepEqual(back.ref, post.ref)
  assert.deepEqual(back.media, post.media)
})

test('nested quote Dates also survive the round trip', () => {
  const inner = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 'https://bsky.app/profile/q.bsky.social/post/qk',
    author: { name: 'Q', handle: 'q.bsky.social', url: 'https://bsky.app/profile/q.bsky.social' },
    text: 'quoted', createdAt: new Date('2026-06-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const outer = { ...inner, ref, text: 'root', createdAt: new Date('2026-07-01T00:00:00Z'), quote: inner }
  const back = deserializePost(serializePost(outer))
  assert.ok(back.quote.createdAt instanceof Date, 'a nested Date must not come back as a string')
})

test('deserialize returns null on junk rather than throwing', () => {
  assert.equal(deserializePost('not json'), null)
  assert.equal(deserializePost('{}'), null)
  assert.equal(deserializePost('null'), null)
})

// --- Regression: shallow validation let junk through disguised as a Post. ---
// The docstring promises "null on junk, never throws." The old checks were
// type-only (typeof createdAt === 'string') or truthy-only (!o?.ref), so a
// stale/corrupted cache entry could deserialize successfully and then render
// as garbage in served markup — e.g. /_media/undefined/avatar in an og:image.

const validAuthor = { name: 'a', handle: 'a', url: 'a' }

test('rejects a createdAt that does not parse as a date, not just non-string', () => {
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: 'garbage',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a ref with no recognizable shape at all ({})', () => {
  // !o?.ref is a truthy check only — {} is truthy and used to sail through.
  const s = JSON.stringify({
    ref: {}, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a ref with a valid platform tag but missing required fields', () => {
  // refKey({p:'bs'}) is the STRING 'bs:undefined:undefined' (encodeURIComponent(undefined)
  // === 'undefined'), not undefined — so a naive `typeof refKey(ref) === 'string'`
  // check does not catch this. Only the round trip through parseRefKey does.
  const s = JSON.stringify({
    ref: { p: 'bs' }, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a ref with an unknown platform tag', () => {
  const s = JSON.stringify({
    ref: { p: 'zz', id: '1' }, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('a malformed quote ref is rejected too, not just a malformed root ref', () => {
  // reviveDates already recurses into quote/replyTo; a bad quote ref produces the
  // same /_media/undefined/ bug one level down. Depth is capped at 1 — no recursion
  // problem in the validator either.
  const badQuote = {
    ref: { p: 'bs' }, canonical: 'q', createdAt: '2026-06-01T00:00:00Z',
    author: validAuthor, text: 'quoted', media: [], counts: {}, sensitive: false,
  }
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
    quote: badQuote,
  })
  assert.equal(deserializePost(s), null)
})

test('a fully valid Post with a well-formed quote still round-trips (positive control)', () => {
  // Guards against over-rejection: the stricter validation must not reject good data.
  const quote = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 'https://bsky.app/profile/q.bsky.social/post/qk',
    author: { name: 'Q', handle: 'q.bsky.social', url: 'https://bsky.app/profile/q.bsky.social' },
    text: 'quoted', createdAt: new Date('2026-06-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const post = {
    ref, canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'root', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false, quote,
  }
  const back = deserializePost(serializePost(post))
  assert.ok(back, 'a fully well-formed Post must not be rejected')
  assert.deepEqual(back.ref, post.ref)
  assert.ok(back.quote, 'a well-formed quote must not be rejected')
  assert.deepEqual(back.quote.ref, quote.ref)
})

// --- Regression: canonical was validated on the root but NEVER on a nested
// quote/replyTo. hasValidIdentity (what nested posts go through) checked only ref
// shape + createdAt — never canonical, the exact field render/discord.ts drops
// into og:-tag markup via esc(post.canonical). A corrupted quote.canonical sailed
// through deserializePost and came back out the other side untouched. Dormant only
// because quote/replyTo layout is Phase 2 — the guard must be total between a
// corrupted cache entry and served output regardless of what today's renderer draws.

test('rejects a quote whose canonical is not a string', () => {
  const badQuote = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 12345, // a number, not a string
    createdAt: '2026-06-01T00:00:00Z',
    author: validAuthor, text: 'quoted', media: [], counts: {}, sensitive: false,
  }
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
    quote: badQuote,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a replyTo whose canonical is missing entirely', () => {
  const badReplyTo = {
    ref: { p: 'bs', handle: 'p.bsky.social', rkey: 'pk' },
    // canonical omitted entirely
    createdAt: '2026-05-01T00:00:00Z',
    author: validAuthor, text: 'parent', media: [], counts: {}, sensitive: false,
  }
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
    replyTo: badReplyTo,
  })
  assert.equal(deserializePost(s), null)
})

test('a Post with both a valid quote AND a valid replyTo still round-trips (positive control)', () => {
  // Guards against over-rejection: validating canonical on nested posts too must
  // not reject a Post whose quote and replyTo are both genuinely well-formed.
  const quote = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 'https://bsky.app/profile/q.bsky.social/post/qk',
    author: { name: 'Q', handle: 'q.bsky.social', url: 'https://bsky.app/profile/q.bsky.social' },
    text: 'quoted', createdAt: new Date('2026-06-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const replyTo = {
    ref: { p: 'bs', handle: 'p.bsky.social', rkey: 'pk' },
    canonical: 'https://bsky.app/profile/p.bsky.social/post/pk',
    author: { name: 'P', handle: 'p.bsky.social', url: 'https://bsky.app/profile/p.bsky.social' },
    text: 'parent', createdAt: new Date('2026-05-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const post = {
    ref, canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'root', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false, quote, replyTo,
  }
  const back = deserializePost(serializePost(post))
  assert.ok(back, 'a fully well-formed Post with quote+replyTo must not be rejected')
  assert.ok(back.quote, 'a well-formed quote must not be rejected')
  assert.ok(back.replyTo, 'a well-formed replyTo must not be rejected')
  assert.deepEqual(back.quote.ref, quote.ref)
  assert.deepEqual(back.replyTo.ref, replyTo.ref)
})

// --- Coverage gap: positive controls only ever exercised the 'bs' PostRef variant.
// Over-rejection is the dangerous direction here: it would silently disable the
// cache for a whole platform (or a subset of handles) and hammer upstream — and no
// test would fail, it would just get slow. This exercises all seven PostRef union
// members, plus "weird but legal" Bluesky handles that a naive validator might
// wrongly flag.

test('all seven PostRef variants, plus known-good edge-case handles, round-trip through deserializePost', () => {
  const cases = [
    { p: 'x', id: '123' },
    { p: 'tt', id: '456' },
    { p: 'ig', kind: 'p', code: 'BsOGulcndj-' },
    { p: 'ig', kind: 'reel', code: 'CxReelCode1' },
    { p: 'ig', kind: 'tv', code: 'DzTvCode123' },
    { p: 'ig', kind: 'story', user: 'someuser', id: '987' },
    { p: 'th', code: 'DTI1vjIEi5y' },
    { p: 'rd', sub: 'aww', id: 'abc123' },
    { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    // Known-good edge cases: legal Bluesky handles that must not be over-rejected.
    { p: 'bs', handle: 'did:plc:abcdef123456', rkey: 'edgekey1' }, // DID handle — contains ':'
    { p: 'bs', handle: 'weird%handle', rkey: 'edgekey2' }, // contains a raw '%'
    { p: 'bs', handle: 'weird/handle', rkey: 'edgekey3' }, // contains a raw '/'
  ]
  for (const r of cases) {
    const post = {
      ref: r,
      canonical: 'https://example.test/canonical',
      author: validAuthor,
      text: 't',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      media: [], counts: {}, sensitive: false,
    }
    const back = deserializePost(serializePost(post))
    assert.ok(back, `over-rejected a valid ref: ${JSON.stringify(r)}`)
    assert.deepEqual(back.ref, r, `ref corrupted in round trip: ${JSON.stringify(r)}`)
  }
})
