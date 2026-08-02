/**
 * The numeric status-id codec for the spoofed Mastodon routes.
 *
 * The {id} segment of /api/v1/statuses/{id}, /users/{h}/statuses/{id} and
 * /_oembed/{id} must LOOK like a Mastodon snowflake — real ones are pure digits.
 * Putting a raw refKey there ('bs%3Aalice…') is an asymmetric bet: if Discord
 * requires a numeric-looking id the spoof silently does nothing, and because the
 * spoof path emits ZERO og:image the result is worse than the plain-og path. Emitting
 * digits when Discord doesn't care costs nothing.
 *
 * Scheme: UTF-8 encode, then one 3-digit zero-padded decimal per byte. Deliberately
 * simpler than FxEmbed's 2-digit-per-char alphabet (src/helpers/snowcode.ts), which is
 * total only over its 72 permitted characters and needs a fallback path for the rest;
 * 000..255 is total over every byte, so there is no such path to get wrong.
 *
 * Side benefit: the wire form contains no '%' at all, so the two-layer decode hazard
 * that /_media/ has to reason about cannot arise on these routes.
 *
 * The empty string is not a representable key — encode('') is the bare sentinel and
 * decode(sentinel) is null. That is intentional: an empty path segment must 404, and
 * refKey() never produces an empty key.
 */

const utf8 = new TextEncoder()
// fatal:true is load-bearing — the lenient decoder substitutes U+FFFD for invalid
// sequences, which would turn attacker-chosen bytes into a *successful* decode to a
// key that was never encoded. We want null instead.
// ignoreBOM:true is NOT the default and is required for byte-exactness: with the
// default (false) the decoder STRIPS a leading U+FEFF, so a key beginning with one
// would encode fine and come back one character shorter. Measured: 'abc' prefixed with
// U+FEFF round-trips only under ignoreBOM:true. Not reachable through refKey today
// (it percent-encodes U+FEFF down to ASCII '%EF%BB%BF'), but this is a general string
// codec and "exact inverse" should not quietly depend on that.
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Wire spec C2. Without a nonzero leading digit, a refKey starting with 'b' (98) encodes
// to '098…', and 'b' is the ONLY platform tag byte below 100 — so Bluesky, the single
// platform Phase 1 already ships end to end, would be the one that breaks, on every post.
// Any layer that treats the {id} segment as a number strips that zero (plausible: real
// Mastodon ids ARE numeric snowflakes), after which the 3-digit framing no longer divides
// and decode fails. Measured pre-fix: 'bs:alice.bsky.social:3k2a' -> 75 digits -> 74 after
// BigInt normalization -> decodeStatusId null. The sentinel makes that strip a provable
// no-op. It does NOT rescue a float coercion of a 160-digit id — nothing could — but that
// mangles every platform equally and loudly, rather than one platform silently.
const SENTINEL = '1'

/** Pure-digit encoding of a refKey. Inverse of decodeStatusId. */
export function encodeStatusId(key: string): string {
  let out = SENTINEL
  for (const b of utf8.encode(key)) out += String(b).padStart(3, '0')
  return out
}

/**
 * Exact inverse of encodeStatusId for any string containing no unpaired surrogate.
 * Returns null for anything malformed — never throws.
 *
 * The surrogate carve-out is not a decode bug and no decoder can close it: TextEncoder
 * substitutes U+FFFD for a lone surrogate, so encode is already lossy before decode runs
 * (measured: '\uD800' -> '1239191189' -> U+FFFD). Unreachable through refKey, which
 * throws URIError on such a key inside encodeURIComponent — the same reason the
 * ignoreBOM hazard above is unreachable, and it is stated here for the same reason.
 *
 * Same contract, and the same reason, as parseRefKey: this value is a raw request-path
 * segment, so it is attacker-influenced and a throw would be a trivially reachable 500.
 */
export function decodeStatusId(id: string): string | null {
  // Regex, not Number(), and it must run BEFORE everything else. Number() accepts far
  // more than digits, and the ids that survive the sentinel and framing checks anyway are
  // the dangerous ones. Re-measured against THIS function with the regex swapped for
  // Number.isInteger(Number(id)) — the sentinel changed the answer, so the old list no
  // longer applies and is not what is written here:
  //   '112.' and '112 ' DECODE SUCCESSFULLY, both to '\f'. Number() tolerates a trailing
  //            dot and trailing whitespace on the whole id, and the inner Number() then
  //            tolerates them again on the 3-char group — so a non-canonical wire form
  //            yields a real key, which is the whole class this shape check exists to shut.
  //   '1+12', '1 12', '10x1', '1-12', '11e3' now return null under that swap too — but
  //            each for an incidental reason (NaN, or `> 255` catching that one exponent),
  //            not because anything validated the shape. Resting on luck is the defect.
  // (Fullwidth digits are NOT a Number() hazard — Number('１２３') is NaN — but the regex
  // rejects them anyway, which is the point of validating shape rather than value.)
  if (!/^[0-9]+$/.test(id)) return null

  // C2's other half. Rejecting the sentinel-less form is not just symmetry: without it
  // '065' and '1065' would BOTH decode to 'A', so two distinct wire forms would alias to
  // one key. That is exactly the ambiguity a numeric-normalizing intermediary would
  // create, and silently accepting its output would hide the mangling instead of 404ing.
  if (!id.startsWith(SENTINEL)) return null
  const body = id.slice(SENTINEL.length)

  // A bare sentinel carries no bytes. Rejecting it keeps "the empty string is not a
  // representable key" true — without this, decodeStatusId('1') would hand the router an
  // empty key that refKey() can never mint.
  if (body.length === 0 || body.length % 3 !== 0) return null

  const bytes = new Uint8Array(body.length / 3)
  for (let i = 0; i < bytes.length; i++) {
    const n = Number(body.slice(i * 3, i * 3 + 3)) // safe: verified all-ASCII-digits above
    if (n > 255) return null // 256..999 is not a byte; reject rather than truncate
    bytes[i] = n
  }

  try {
    return utf8Strict.decode(bytes)
  } catch {
    return null // invalid UTF-8: lone continuation byte, surrogate half, overlong form
  }
}
