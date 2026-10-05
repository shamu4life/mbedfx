import type { PostRef } from '../../types.ts'
import { PIN_ID } from '../../refkey.ts'
import { askTwice } from '../../fetchretry.ts'

/**
 * I/O ONLY. Pinterest's own web-app resource endpoint, unauthenticated and cookie-free.
 *
 * TWO HEADERS ARE THE GATE: `X-Pinterest-PWS-Handler` and a non-empty `user-agent`. They guard two
 * different walls, and each wall answers with its own body, which is how to tell them apart in a log:
 *
 *   no user-agent, handler or not   -> 403 JSON {"message":"Looks like you don't have permission to
 *                                      access this page. Your pinterest request id: …","status":403}
 *   a user-agent, no handler        -> 403, the bare text `Invalid Resource Request`
 *   a user-agent and the handler    -> 200 with the full pin
 *
 * THE HANDLER HEADER. Bisected header by header (2026-07-27): with no headers the endpoint answered
 * 403 `Invalid Resource Request`; adding X-Requested-With, X-APP-VERSION, X-Pinterest-AppState,
 * Referer or X-Pinterest-Source-Url individually stayed 403; adding ONLY this one returned 200 with
 * the full pin. No cookie is sent and none is required. The header's VALUE must be a recognised
 * handler name (an allowlist — `garbage` and `` both 403) but need not be the right one for the
 * route, so the literal below is stable rather than route-derived.
 *
 * THE USER-AGENT, AND WHY THIS COMMENT USED TO SAY THE OPPOSITE. On 2026-07-27 this endpoint answered
 * identical 200s to `curl/8.0`, a Discordbot UA and NO user-agent header at all, and this section was
 * headed "IT IS NOT A UA GATE". So this fetcher sent no UA, and a Worker's fetch adds none of its own:
 * it was riding on the absence being allowed. That stopped somewhere between 2026-08-12 (the date
 * /_smoke's pn row was last verified good through production) and 2026-10-05, when every pin in
 * production failed: the pn row drew a failure card and /_api/v1 answered fetch_fail on 5 of 5 pins
 * sampled. The exact day it changed was not measured.
 *
 * Re-measured 2026-10-05 from the Claude Code dev sandbox (a non-Cloudflare cloud IP behind an HTTPS
 * proxy, NOT a Worker), with the exact URL and headers built below, two asks per arm on each of pin
 * 66287425756772418 (an image pin) and pin 4855512095802122 (a video pin), same answer both times:
 *
 *   no user-agent header                  -> 403, the JSON above
 *   `user-agent` present but EMPTY        -> 403, the same JSON (one ask, image pin): non-empty is
 *                                            what is checked, not merely present
 *   curl/8.5.0                            -> 200, full pin
 *   Chrome 121 (BROWSER_UA below)         -> 200, full pin, grid_title and V_720P intact
 *   Chrome 150                            -> 200, full pin
 *   Discordbot/2.0, bare and Mozilla form -> 200, full pin
 *   facebookexternalhit/1.1               -> 200, full pin
 *
 * Every non-empty value tried passed, so from the sandbox this is an absence check, not a UA
 * allowlist. Remove the header and every pin is the 403 above.
 *
 * WHETHER A UA IS ENOUGH FROM CLOUDFLARE EGRESS IS NOT YET MEASURED. Everything above is the sandbox.
 * Production's failure is consistent with the no-UA arm, which this fixes, but a datacenter IP can
 * meet a wall a cloud sandbox does not, and CLAUDE.md lists three that did. The first measurement from
 * a Worker will be /_smoke's pn row after this deploys. If that row still draws a failure card with a
 * UA set, suspect the egress next, not the header.
 *
 * WHY A BROWSER UA AND NOT A CRAWLER'S. Every non-empty value measured alike, so the evidence is a tie
 * and the choice is convention. This is the web app's own XHR endpoint and the request already carries
 * the web app's handler header, so a browser UA makes it the request Pinterest's own page sends. That
 * is the same reasoning that gives the other web-app API fetchers here, twitch/fetch.ts and
 * twitter/fetch.ts, a browser UA. A crawler UA next to an app-internal header is a pairing no real
 * client sends. And facebook/normalize.ts records a second reason: an upstream identity that is not
 * Discord's stays independent of whichever client happens to be unfurling. The string is BROWSER_UA
 * from reddit/fetch.ts and twitch/fetch.ts, verbatim, so one future bump finds all three.
 *
 * ROBOTS.TXT EXPLICITLY ALLOWS THIS PATH: `Allow: /resource/*​/get/`. Worth recording because it is
 * the rare case where the surface we use is one the site publishes permission for.
 *
 * WHY NOT THE OTHER TWO SURFACES:
 *   __PWS_DATA__  exists and parses, but on a pin page it holds only the app shell
 *                 (`renderMode: "shellReady"`, zero occurrences of `"pin"`). Pinterest streams the
 *                 shell and fills the pin through React Suspense boundaries. Do not build on it.
 *   oembed.json   works with no headers at all (still true 2026-10-05 from the dev sandbox, no UA:
 *                 200 JSON), but is thin: title, author, and a 236px thumbnail. No video, no
 *                 dimensions, no counts. Kept in mind as a fallback, not a source.
 */

const HANDLER = 'www/pin/[id].js'

/** See "THE USER-AGENT" above: without a non-empty one, every pin is a 403. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

export type PinterestFetch =
  | { ok: true; pin: Record<string, unknown> }
  | { ok: false; reason: 'assert_fail' }

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * `field_set_key: 'detailed'` IS LOAD-BEARING AND WAS ALMOST GOT WRONG.
 *
 * An abbreviated pin (what the search resource returns, and what a lesser field set returns) carries
 * a TRUNCATED `videos.video_list`: only the HLS renditions, `V_HLSV4` and `V_HLSV3_MOBILE`. Measured
 * over 41 video pins from search, exactly ONE exposed a progressive mp4 — which reads as "Pinterest
 * video is HLS, we need the remux container". Re-fetching those same pins through THIS call returned
 * `V_720P` on every one. The truncation is in the response, not in the pin.
 *
 * So: always the detail endpoint, never a video list from anywhere else.
 */
export async function fetchPinterest(ref: Extract<PostRef, { p: 'pn' }>): Promise<PinterestFetch> {
  if (!PIN_ID.test(ref.id)) return { ok: false, reason: 'assert_fail' }
  const data = JSON.stringify({ options: { id: ref.id, field_set_key: 'detailed' }, context: {} })
  const qs = new URLSearchParams({ source_url: `/pin/${ref.id}/`, data })
  const res = await askTwice(`https://www.pinterest.com/resource/PinResource/get/?${qs}`, {
    headers: {
      'X-Pinterest-PWS-Handler': HANDLER,
      // Load-bearing, though nothing in the response depends on WHICH UA, so it reads as decoration.
      // A Worker's fetch sends no user-agent by default, Pinterest now 403s every pin that arrives
      // without one, and that is exactly the all-pins outage found on 2026-10-05.
      'user-agent': BROWSER_UA,
      accept: 'application/json',
    },
    redirect: 'manual',
  })
  // A dead pin id is a clean HTTP 404 (measured on ids 0, 1 and 999999999999999999), so status is a
  // cheap first filter — but the REAL assertion is the payload shape below, because a 403
  // `Invalid Resource Request` is also JSON and would otherwise parse.
  if (res.status !== 200) return { ok: false, reason: 'assert_fail' }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'assert_fail' }
  }
  const rr = obj(obj(body)?.resource_response)
  if (rr?.status !== 'success') return { ok: false, reason: 'assert_fail' }
  const pin = obj(rr.data)
  // Liveness is a pin carrying its own id. Nothing weaker: the envelope reports `success` for shapes
  // that carry no pin at all.
  if (!pin || typeof pin.id !== 'string') return { ok: false, reason: 'assert_fail' }
  return { ok: true, pin }
}
