import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeStatusId, decodeStatusId } from '../src/statusid.ts'
import { refKey } from '../src/refkey.ts'

// The whole point of this codec is that the {id} segment of the spoofed Mastodon
// routes LOOKS like a snowflake — pure digits. Wire spec §1: if Discord requires a
// numeric-looking id and we emit 'bs%3Aalice…', the spoof silently does nothing, and
// because the spoof path emits ZERO og:image the fallback is worse than Phase 1 ships
// today. So the digits-only property is asserted on every case below, not spot-checked.

// The same seven-variant PostRef table cache.test.mjs uses. Keys are always produced by
// refKey() rather than hand-written: a hand-written key could drift from what the router
// actually round-trips, and then this file would pass while production 404'd.
const refs = [
  { p: 'x', id: '123' },
  { p: 'tt', id: '7660566211100511518' },
  { p: 'ig', kind: 'p', code: 'BsOGulcndj-' },
  { p: 'ig', kind: 'reel', code: 'CxReelCode1' },
  { p: 'ig', kind: 'tv', code: 'DzTvCode123' },
  { p: 'ig', kind: 'story', user: 'someuser', id: '987' },
  { p: 'th', code: 'DTI1vjIEi5y' },
  { p: 'rd', sub: 'aww', id: 'abc123' },
  { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
]

test('every PostRef variant round-trips through the status-id codec', () => {
  for (const r of refs) {
    const key = refKey(r)
    assert.equal(decodeStatusId(encodeStatusId(key)), key, `round trip lost: ${key}`)
  }
})

test('a DID handle round-trips — refKey percent-encodes its colons', () => {
  // Verified live: at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l
  // This is the key that made the double-decode hazard real (wire spec §2); it must
  // survive the codec byte-exactly, '%' escapes included.
  const key = refKey({ p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6oveex3ii2l' })
  assert.ok(key.includes('%3A'), 'precondition: refKey percent-encodes the DID colons')
  assert.equal(decodeStatusId(encodeStatusId(key)), key)
})

test('encodeStatusId output is pure digits for every ref — the property the design rests on', () => {
  for (const r of refs) {
    const id = encodeStatusId(refKey(r))
    assert.match(id, /^[0-9]+$/, `not snowflake-shaped: ${id}`)
  }
  // Weird-but-legal Bluesky handles reach refKey too; '%', '/' and spaces must not
  // leak a non-digit into the wire form.
  for (const handle of ['weird%handle', 'weird/handle', 'handle with spaces', 'a?b#c']) {
    const id = encodeStatusId(refKey({ p: 'bs', handle, rkey: '3k2a' }))
    assert.match(id, /^[0-9]+$/, `not snowflake-shaped: ${id}`)
  }
})

test('each byte becomes exactly three digits after the sentinel', () => {
  // Pins the wire format itself, not just its invertibility: a 2-digit-per-byte or
  // variable-width scheme would still round-trip here but would not be decodable by
  // anything that assumes the documented framing.
  assert.equal(encodeStatusId('A'), '1065')
  assert.equal(encodeStatusId('x:1'), '1120058049')
  for (const r of refs) assert.equal((encodeStatusId(refKey(r)).length - 1) % 3, 0)
})

test('no encoded id ever starts with a zero — the C2 leading-sentinel guarantee', () => {
  // Wire spec C2. 3-digit-per-byte encoding of a refKey beginning with 'b' (98) would
  // start '098…' without the sentinel, and ASCII 'b' is the ONLY platform tag byte below
  // 100 — so Bluesky, the one platform Phase 1 already ships end to end, would be the one
  // that regresses, on 100% of its posts. Any layer that treats the {id} segment as a
  // number (plausible: real Mastodon ids are numeric snowflakes) eats that leading zero.
  for (const r of refs) {
    const id = encodeStatusId(refKey(r))
    assert.equal(id[0], '1', `id must start with the nonzero sentinel: ${id.slice(0, 8)}…`)
  }
})

test('numeric normalization of an encoded id is a no-op, so it still decodes', () => {
  // The exact failure C2 was written to prevent, exercised end to end rather than
  // asserted structurally. PROVEN REAL against the pre-sentinel codec: this loop failed
  // for both Bluesky rows — 'bs:alice.bsky.social:3k2a' encoded to a 75-digit id starting
  // '098115…', BigInt normalization dropped it to 74 digits, `length % 3` then rejected
  // it and decodeStatusId returned null. Every other platform passed, which is precisely
  // why a round-trip-only suite could not see this: the normalization step never happens
  // when you feed encode's output straight back into decode.
  const keys = [
    ...refs.map(refKey),
    refKey({ p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6oveex3ii2l' }),
  ]
  for (const key of keys) {
    const id = encodeStatusId(key)
    // BigInt, not Number: Number() would lose precision on a 160-digit id and confound
    // the leading-zero question with a float-rounding one. BigInt isolates the strip.
    const normalized = String(BigInt(id))
    assert.equal(normalized, id, `numeric normalization changed the id for ${key}`)
    assert.equal(decodeStatusId(normalized), key, `lost after normalization: ${key}`)
  }
})

test('decodeStatusId rejects an id that is missing the sentinel', () => {
  // C2 requires both halves: emit the sentinel AND refuse anything without it. Without
  // the reject half, a sentinel-less id from an older cache entry or a hand-built URL
  // would decode to a DIFFERENT key than the one it was minted for — '1065' is 'A' but
  // bare '065' would also be 'A', so two wire forms would alias to one key.
  assert.equal(decodeStatusId('065'), null, 'bare 3-digit group must not decode')
  assert.equal(decodeStatusId('120058049'), null, "pre-sentinel form of 'x:1' must not decode")
  assert.equal(decodeStatusId('0' + encodeStatusId('x:1')), null, 'leading zero must not decode')
  assert.equal(decodeStatusId('2065'), null, 'only the constant sentinel 1 is accepted')
  assert.equal(decodeStatusId('1'), null, 'the sentinel alone is not a key — an empty id must 404')
})

test('decodeStatusId returns null (never throws) on junk from the request path', () => {
  // These values arrive as a raw path segment, so they are attacker-influenced: a
  // throw here is a trivially reachable 500. Same contract as parseRefKey.
  const junk = [
    '', // empty segment — /_oembed/ with nothing after it
    'abc', // no digits at all
    '12', // length not a multiple of 3
    '1234', // length not a multiple of 3
    '256000', // first group overflows a byte
    '999', // group overflows a byte
    // --- Non-digit shapes that Number() would accept. Under the sentinel these are
    // rejected by the startsWith check rather than by the regex, so they no longer prove
    // the regex load-bearing on their own — the sentinel-carrying pair in framedJunk
    // below does that. Kept anyway: "never decodes, never throws" is the contract no
    // matter which guard fires, and a refactor that reorders the guards must not free them.
    '+12', // Number() drops a leading '+'
    ' 12', // Number() trims leading whitespace
    '12.', // a trailing dot still parses as 12
    '0x1', // hex literal — Number('0x1') is 1
    '-12', // Number() gives -12; Uint8Array wraps it to byte 244 and `> 255` never fires
    '1e3', // exponent — Number('1e3') is 1000
    '１２３', // fullwidth digits: Number() gives NaN here, but shape-checking rejects them
    '12 3', // embedded space
    '0x41', // hex, length 4
  ]
  for (const bad of junk) {
    assert.doesNotThrow(() => decodeStatusId(bad), `${JSON.stringify(bad)} must not throw`)
    assert.equal(decodeStatusId(bad), null, `${JSON.stringify(bad)} must not decode`)
  }

  // These carry the sentinel deliberately. Without the '1' the sentinel check would
  // reject them first and the byte-range and strict-UTF-8 defenses below it would never
  // run — the test would still be green while guarding nothing. Each of these is
  // well-framed (sentinel + a whole number of 3-digit groups) so it reaches the loop.
  const framedJunk = [
    '1256000', // first group is 256 — one past a byte; must reject, not truncate
    '1999', // group overflows a byte
    '1255255255', // in-range bytes, but 0xFF 0xFF 0xFF is not valid UTF-8
    '1128', // a lone UTF-8 continuation byte
    '1237160128', // 0xED 0xA0 0x80 — a surrogate half, which strict UTF-8 forbids
    '112', // sentinel present but the body is not a multiple of 3
    '11234', // same, one digit long
    // The two that make /^[0-9]+$/ load-bearing under the sentinel. RE-MEASURED against
    // the current decodeStatusId with the regex swapped for Number.isInteger(Number(id)):
    // these two DECODE SUCCESSFULLY, both to '\f' (U+000C). Number() tolerates a trailing
    // dot and trailing whitespace on the whole id, and the inner Number() tolerates them
    // again on the 3-char group. The pre-sentinel hazards ('+12', ' 12', '0x1') no longer
    // reach that far, so this pair — not that list — is the live proof.
    '112.', // trailing dot: Number('112.') is 112 and Number('12.') is 12
    '112 ', // trailing space: Number() trims it at both levels
  ]
  for (const bad of framedJunk) {
    assert.doesNotThrow(() => decodeStatusId(bad), `${JSON.stringify(bad)} must not throw`)
    assert.equal(decodeStatusId(bad), null, `${JSON.stringify(bad)} must not decode`)
  }
})

test('multi-byte UTF-8 survives the round trip', () => {
  // encodeStatusId is a general string codec, so it must not assume ASCII even though
  // today's refKeys happen to be percent-encoded down to it.
  for (const s of ['café', '🎉', 'ünïcødé 🎉 テスト']) {
    assert.equal(decodeStatusId(encodeStatusId(s)), s, `round trip lost: ${s}`)
    assert.match(encodeStatusId(s), /^[0-9]+$/)
  }
})

test('a key beginning with U+FEFF is not silently shortened by BOM stripping', () => {
  // TextDecoder's ignoreBOM defaults to FALSE, which STRIPS a leading U+FEFF — so the
  // obvious `new TextDecoder('utf-8', {fatal:true})` makes decode a lossy near-inverse.
  // Proven by measurement: those bytes decode to length 3 under the default and length 4
  // under ignoreBOM:true. Unreachable via refKey today (it percent-encodes U+FEFF to
  // ASCII), so nothing would have caught this until some future caller encoded raw text.
  const key = '﻿abc'
  assert.equal(decodeStatusId(encodeStatusId(key)), key)
  assert.equal(decodeStatusId(encodeStatusId(key))?.length, 4, 'the BOM must not be eaten')
})

test('encode/decode is identity over a few hundred random ASCII keys', () => {
  // Seeded (not Math.random) so a failure names one exact input and reproduces on rerun
  // — an unreproducible fuzz failure is a test we would end up deleting.
  let seed = 0x5eed1234
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let n = 0; n < 400; n++) {
    const len = 1 + Math.floor(rnd() * 40)
    let s = ''
    // 0x20..0x7e — the printable ASCII range a refKey component can contain.
    for (let i = 0; i < len; i++) s += String.fromCharCode(0x20 + Math.floor(rnd() * 95))
    const id = encodeStatusId(s)
    assert.match(id, /^[0-9]+$/, `not snowflake-shaped for ${JSON.stringify(s)}`)
    assert.equal(decodeStatusId(id), s, `round trip lost: ${JSON.stringify(s)}`)
  }
})
