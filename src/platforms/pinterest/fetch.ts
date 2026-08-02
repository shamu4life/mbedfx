import type { PostRef } from '../../types.ts'
import { PIN_ID } from '../../refkey.ts'

/**
 * I/O ONLY. Pinterest's own web-app resource endpoint, unauthenticated and cookie-free.
 *
 * ONE HEADER IS THE ENTIRE GATE. `X-Pinterest-PWS-Handler` — nothing else. Bisected header by header
 * (2026-07-27): with no headers the endpoint answers 403 `Invalid Resource Request`; adding
 * X-Requested-With, X-APP-VERSION, X-Pinterest-AppState, Referer or X-Pinterest-Source-Url
 * individually stays 403; adding ONLY this one returns 200 with the full pin. No cookie is sent and
 * none is required.
 *
 * IT IS NOT A UA GATE, which is the opposite of every Meta surface this project has fought. Measured
 * identical 200s for `curl/8.0`, a Discordbot UA, and NO user-agent header at all. The header's VALUE
 * must be a recognised handler name (an allowlist — `garbage` and `` both 403) but need not be the
 * right one for the route, so the literal below is stable rather than route-derived.
 *
 * ROBOTS.TXT EXPLICITLY ALLOWS THIS PATH: `Allow: /resource/*​/get/`. Worth recording because it is
 * the rare case where the surface we use is one the site publishes permission for.
 *
 * WHY NOT THE OTHER TWO SURFACES:
 *   __PWS_DATA__  exists and parses, but on a pin page it holds only the app shell
 *                 (`renderMode: "shellReady"`, zero occurrences of `"pin"`). Pinterest streams the
 *                 shell and fills the pin through React Suspense boundaries. Do not build on it.
 *   oembed.json   works with no headers at all, but is thin: title, author, and a 236px thumbnail.
 *                 No video, no dimensions, no counts. Kept in mind as a fallback, not a source.
 */

const HANDLER = 'www/pin/[id].js'

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
  const res = await fetch(`https://www.pinterest.com/resource/PinResource/get/?${qs}`, {
    headers: {
      'X-Pinterest-PWS-Handler': HANDLER,
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
