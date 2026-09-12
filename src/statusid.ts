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

import type { GalleryMode } from './types.ts'

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

/**
 * THE SENTINEL ALSO CARRIES THE GALLERY MODE, and that is the only channel that reaches the document
 * Discord actually renders.
 *
 * WHY IT CANNOT RIDE IN THE PATH. The /p and /v suffix is on the url a person pastes, but the card
 * is drawn from the ACTIVITY DOCUMENT, and Discord does not fetch the href we advertise: measured
 * 2026-09-02, "Discord fetched /api/v1/statuses/{id} 5 times out of 5 and the advertised /users/
 * href never" (worker.ts). It reconstructs that url from the {id} alone. So a mode kept anywhere
 * except inside {id} is a mode the gallery renderer never sees, and /p and /v would be a visible
 * no-op on the one surface they exist to change.
 *
 * WHY IT CANNOT RIDE IN THE refKey. refKey is simultaneously the post cache key, the /_media wire
 * format, the mux R2 key `mux/{refKey}/{index}`, the meta record key and this status id. Forking it
 * per mode would double every upstream fetch, orphan every warm mux, and need a parseRefKey arm
 * whose omission is SILENT — the fb:group bug. The key stays one key; only its wrapper varies.
 *
 * WHY A SENTINEL DIGIT AND NOT A PATH SEGMENT. spoofShape accepts EXACTLY 2 segments for /_oembed
 * and EXACTLY 4 for the activity forms, so an extra segment is refused by our own router before
 * Discord's rewrite is even reached. A leading digit rides through both. The /_wait experiment
 * already measured that a differently-prefixed all-digit id survives Discord's reconstruction.
 *
 * EVERY VALUE HERE MUST BE NONZERO, for the reason SENTINEL is: a layer that treats {id} as a number
 * strips a leading zero, after which the 3-digit framing no longer divides and decode fails.
 *
 * '1' MEANS "UNSPECIFIED", NOT "videos", and the distinction is what makes this backward compatible.
 * Every id already minted — including the ones frozen inside Discord's embed cache forever — starts
 * with '1', and must keep decoding to the same key and to whatever the CURRENT default is, so that a
 * card re-crawled after this ships renders like every other default card rather than like a
 * pre-2026-09-11 one. An explicitly chosen mode gets its own digit so it cannot be re-read as the
 * default if the default later moves.
 */
const MODE_SENTINEL: Record<GalleryMode, string> = { videos: '2', stills: '3' }
const SENTINEL_MODE: Record<string, GalleryMode> = { 2: 'videos', 3: 'stills' }

/**
 * What a request naming no mode gets. Spelled ONCE, here, because this file is the only one that has
 * to enumerate every mode anyway — see the note in types.ts, which deliberately keeps no runtime
 * export of its own.
 *
 * FLIPPED TO 'videos' 2026-09-11 on the owner's call, reversing the 2026-07-20 decision recorded in
 * mastodon.ts ("The owner has SEEN the one-player render and chosen every-item-visible over it").
 * The reversal is deliberate and its cost is stated there: one player instead of N stills, with a
 * content-body note naming what else the post holds.
 */
export const DEFAULT_GALLERY_MODE: GalleryMode = 'videos'

/**
 * Pure-digit encoding of a refKey, optionally carrying an EXPLICIT gallery mode. Inverse of
 * decodeStatusId (for the key) and statusIdMode (for the mode).
 *
 * Called with no mode for every ordinary render, which keeps the wire form byte-identical to what
 * this service has always emitted. Pass a mode only when the request named one.
 */
export function encodeStatusId(key: string, mode?: GalleryMode): string {
  let out = mode ? MODE_SENTINEL[mode] : SENTINEL
  for (const b of utf8.encode(key)) out += String(b).padStart(3, '0')
  return out
}

/**
 * The mode an id was minted with, or null when it names none (the '1' form, and every id predating
 * 2026-09-11). Null is NOT 'videos': the caller applies DEFAULT_GALLERY_MODE, so the default can move
 * again without rewriting what is already in Discord's cache.
 *
 * Same total-over-garbage contract as decodeStatusId — this reads a raw request-path segment.
 */
export function statusIdMode(id: string): GalleryMode | null {
  return (typeof id === 'string' && SENTINEL_MODE[id.charAt(0)]) || null
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
  //
  // ANY OF THE THREE SENTINELS, since 2026-09-11. '2' and '3' name a gallery mode (see
  // MODE_SENTINEL) and '1' names none. They are DIFFERENT WIRE FORMS OF THE SAME KEY, which is not
  // the aliasing this check exists to stop: that one was two spellings of one REQUEST, and these are
  // three distinct requests that happen to share a key. Anything outside the set is still refused,
  // so a stripped leading zero still fails to divide and still 404s rather than decoding to
  // something nobody minted.
  const head = id.charAt(0)
  if (head !== SENTINEL && !SENTINEL_MODE[head]) return null
  const body = id.slice(1)

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
