/**
 * THE YOUTUBE CARD'S METADATA, FROM YOUTUBE'S OWN PLAYER API, IN ONE ~10KB POST.
 *
 * WHY THIS EXISTS, and it is a defect report rather than an optimisation. Every YouTube card this
 * service rendered between 2026-08-18 and today said **1 January 1970** with an empty body. The date,
 * the description and the counts all came from ONE place — a `yt-dlp -J` extract inside the media
 * container — and that extract never completed for a caller that was still listening. Measured
 * 2026-08-25: the R2 meta record exists under generations g8 and g10 and does NOT exist under g11 or
 * g12 for any id checked, so nothing had been written for over a week. `wrangler tail` showed every
 * request-scoped MediaResolver invocation ending `canceled` at 1.3-1.8s, which is the render's own
 * budget, not a platform fault. A card cannot wait seconds for a date: Discord caches the embed it
 * gets permanently (jhgg, discord-api-docs#1663), so the FIRST paste is the only paste.
 *
 * SO THE DATE STOPPED COMING FROM A SUBPROCESS AND STARTED COMING FROM A FETCH. `youtubei/v1/player`
 * is the endpoint youtube.com's own web player calls. Measured 2026-08-27, residential, cookie-free:
 *
 *   dQw4w9WgXcQ  200  14,248 B  0.233s  publishDate 2009-10-24T23:57:33-07:00  desc 2375ch  1920x1080
 *   yJl0XuDKSjc  200  10,508 B  0.314s  publishDate 2010-02-15T14:10:31-08:00  desc  367ch  1920x1080
 *   dEi_rHWFm5Q  200   9,278 B  0.199s  publishDate 2026-08-25T03:17:16-07:00  desc  131ch  1920x1080
 *   G0sORVBL4kM  200   9,685 B  0.179s  LOGIN_REQUIRED / "Sign in to confirm your age"
 *
 * `Date.parse('2009-10-24T23:57:33-07:00')/1000` is **1256453853**, which is byte-identical to the
 * `timestamp` in this bucket's own surviving g10 record for that id and to what `yt-dlp -J` returns.
 * The two sources agree exactly; this one costs 0.2s and no container slot instead of 15.9s and one.
 *
 * NO KEY, NO COOKIE, NO PO TOKEN, NO PLAYER JS, NO DENO. The `INNERTUBE_API_KEY` that older
 * write-ups attach to this endpoint has not been required for some time; the calls above send none.
 * That matters because every one of those things is a credential or a subprocess that fails closed
 * and invisibly, which is the failure class this project already has too much of.
 *
 * THE METADATA ARRIVES INSIDE A RESPONSE YOUTUBE CONSIDERS A FAILURE, and that is the one fragile
 * thing here, so it is stated rather than buried: `playabilityStatus` is `UNPLAYABLE / "Video
 * unavailable"` for an ordinary public video asked this way, and `videoDetails` + `microformat` are
 * fully populated anyway. We read the metadata and ignore the verdict. If Google ever empties
 * `videoDetails` on a non-OK status — a sibling client, ANDROID_VR, already behaves that way — this
 * silently returns null and the card is exactly as bad as it was before this file existed. That is
 * the whole reason every caller treats a null as "no change" rather than as an error.
 *
 * DELIBERATELY NOT THE TITLE. `videoDetails.title` is right there and is not used: oembed already
 * supplies the title and is the existing content assertion for "is this a real video". Two sources
 * for one field is two things that can disagree, and the disagreement would be invisible.
 */

import { ytDescriptionOf } from './description.ts'

/** The public web player's own client identity. No key, no auth — see the docstring. */
const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const INNERTUBE_CLIENT = { clientName: 'WEB', clientVersion: '2.20260101.00.00', hl: 'en', gl: 'US' }
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * A HARD ABORT, NOT A RACE, and 1200ms is derived rather than chosen.
 *
 * This call sits in `fetchYouTube`'s `Promise.all` on the FIRST-PASTE critical path, inside
 * HTML_DEADLINE_MS (5000). The measurements above are 0.18-0.31s residential; 1200ms is roughly four
 * times the slowest of them, which leaves the render's remaining budget to `settleMux`, which is the
 * thing that actually needs it.
 *
 * `AbortSignal.timeout` rather than the `deadline()` helper used elsewhere in this repo: that one
 * deliberately leaves the loser running because the loser is doing work worth finishing. Here it is
 * not — a metadata answer that arrives after the card is rendered has nobody to give it to — so the
 * connection should be released rather than left to occupy the isolate.
 */
const INNERTUBE_TIMEOUT_MS = 1200

/**
 * The fields this endpoint can tell us that the card actually renders. Every one is OPTIONAL and
 * absent-on-doubt: this is untrusted JSON from a private API, so each read is guarded individually
 * and one malformed field never suppresses the others.
 */
export type InnertubeMeta = {
  /** ISO 8601 with offset, e.g. `2009-10-24T23:57:33-07:00`. `uploadDateFrom` already parses this. */
  uploadedAt?: string
  /** First paragraph, clamped — the same shape the container's record stored. */
  description?: string
  /** Seconds. Lets settleMux refuse an over-ceiling mux on the FIRST paste rather than never. */
  duration?: number
  /** 18 when YouTube says the video is age-walled; absent otherwise. Never 0 — see below. */
  ageLimit?: number
  /** Views only. Innertube's WEB player response carries no like or comment count. */
  views?: number
}

const str = (v: unknown): string | undefined =>
  (typeof v === 'string' && v.length > 0 ? v : undefined)

/** YouTube sends counts as decimal STRINGS (`"1808522174"`), so parse rather than type-check. */
function count(v: unknown): number | undefined {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : ''
  if (!/^\d{1,15}$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined)

/**
 * THE AGE GATE, AND `isFamilySafe` IS NOT THE DISCRIMINATOR.
 *
 * Measured 2026-08-27: an age-walled video answers `playabilityStatus.status = 'LOGIN_REQUIRED'` with
 * `reason = "Sign in to confirm your age"`, which reproduces the container's `age_limit: 18` exactly.
 * `isFamilySafe` does not: an ordinary public video can report it false and a gated one true, so
 * keying on it would put the 🔞 note on cards that do not deserve one.
 *
 * BOTH HALVES ARE REQUIRED. `LOGIN_REQUIRED` alone also covers private videos and members-only
 * content, which are different failures with different cards — see the platform's own gate handling.
 * Returning undefined for those leaves the existing behaviour untouched, which is correct: this
 * function's job is to report an age wall it is sure about, not to guess at every gate.
 */
function ageLimitFrom(playability: Record<string, unknown> | undefined): number | undefined {
  if (!playability) return undefined
  if (str(playability.status) !== 'LOGIN_REQUIRED') return undefined
  return /confirm your age/i.test(str(playability.reason) ?? '') ? 18 : undefined
}

/**
 * Parse a `youtubei/v1/player` body into the fields the card needs. Exported and PURE so the parsing
 * is testable against captured fixtures with no network — the network half below is four lines and
 * has nothing to get wrong that a fixture would catch.
 */
export function parseInnertube(body: unknown): InnertubeMeta | null {
  const d = obj(body)
  if (!d) return null
  const details = obj(d.videoDetails)
  const micro = obj(obj(d.microformat)?.playerMicroformatRenderer)
  const out: InnertubeMeta = {}

  // publishDate carries the offset; uploadDate is the same instant on every id measured. Prefer
  // publishDate and fall back, rather than reading only one and returning nothing when it moves.
  const when = str(micro?.publishDate) ?? str(micro?.uploadDate)
  if (when) out.uploadedAt = when

  const desc = ytDescriptionOf(details?.shortDescription)
  if (desc) out.description = desc

  const secs = count(details?.lengthSeconds)
  // 0 is what a livestream reports, and a zero duration is not a short video — it is "unknown", which
  // must stay absent so settleMux's over-ceiling arm does not read it as "safely under the ceiling".
  if (secs) out.duration = secs

  const age = ageLimitFrom(obj(d.playabilityStatus))
  if (age !== undefined) out.ageLimit = age

  const views = count(details?.viewCount)
  if (views !== undefined) out.views = views

  // ALL-ABSENT IS A MISS, NOT AN EMPTY ANSWER. An empty object overlaid onto the post would look
  // exactly like a successful call that found nothing, and the caller could not tell it from the
  // shape change this file's docstring warns about. Null is the signal that nothing was learned.
  return Object.keys(out).length ? out : null
}

/**
 * Ask YouTube's player API about one video id. Null on ANY failure — a throw, a timeout, a non-2xx,
 * a body that does not parse, or a body carrying nothing we can use.
 *
 * TOTAL BY CONSTRUCTION, because the caller is on the render path and a YouTube link must always
 * produce a card. Every failure here degrades to exactly the behaviour that shipped before this file
 * existed; none of them can fail the fetch that owns the title.
 */
export async function fetchInnertube(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InnertubeMeta | null> {
  try {
    const res = await fetchImpl(INNERTUBE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA, accept: 'application/json' },
      body: JSON.stringify({
        context: { client: INNERTUBE_CLIENT },
        videoId: id,
        // Both flags say "I have already confirmed this is fine to play". They do not defeat the age
        // wall — G0sORVBL4kM still answers LOGIN_REQUIRED with them set — but they stop an ordinary
        // sensitive-content interstitial from replacing the metadata we came for.
        contentCheckOk: true,
        racyCheckOk: true,
      }),
      signal: AbortSignal.timeout(INNERTUBE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return parseInnertube(await res.json())
  } catch {
    return null
  }
}
