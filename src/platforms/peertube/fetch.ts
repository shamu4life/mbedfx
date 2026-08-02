import type { PostRef } from '../../types.ts'
import { PEERTUBE_ID } from '../../refkey.ts'
import { MAX_BODY, fetchableInstance } from '../fedihost.ts'

/**
 * I/O ONLY. `GET /api/v1/videos/{idOrUUID}`, unauthenticated, ON THE HOST THE USER PASTED.
 *
 * PEERTUBE IS THE EASIEST FEDIVERSE SURFACE THIS PROJECT HAS INTEGRATED. The API is open, needs no
 * credential, no header games and no UA (measured on framatube.org, video.blender.org and
 * tilvids.com), and the id in the pasted url IS the id the endpoint takes — verified byte-identical
 * response bodies for the shortUUID, the full UUID and the numeric id of the same video.
 *
 * THE SSRF CONTRACT IS THE SHARED ONE in ../fedihost.ts, exactly as for Lemmy, the Mastodon family
 * and Misskey: https only, our own zones refused, no credential attached, redirects not followed, the
 * body capped, and the response asserted on CONTENT.
 */

export type PeerTubeFetch =
  | { ok: true; video: Record<string, unknown> }
  | { ok: false; reason: 'assert_fail' | 'notfound' }

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * A THROWN FETCH IS NOT CAUGHT — worker.ts treats a thrown live fetch as null, the same contract
 * every sibling platform fetcher has. Only upstream ANSWERS are classified here.
 */
export async function fetchPeerTube(
  ref: Extract<PostRef, { p: 'pt' }>,
  origin?: string,
): Promise<PeerTubeFetch> {
  if (!fetchableInstance(ref.host, origin) || !PEERTUBE_ID.test(ref.id)) {
    return { ok: false, reason: 'assert_fail' }
  }
  const res = await fetch(`https://${ref.host}/api/v1/videos/${encodeURIComponent(ref.id)}`, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  })
  // A deleted video, or an id that never existed. A wall, not a fetch failure — and PeerTube cannot
  // tell the two apart either, so 'notfound' is the honest name for both.
  if (res.status === 404 || res.status === 410) {
    void res.body?.cancel()
    return { ok: false, reason: 'notfound' }
  }
  const ct = res.headers.get('content-type') || ''
  if (!/^application\/json\b/i.test(ct.trim())) {
    void res.body?.cancel()
    return { ok: false, reason: 'assert_fail' }
  }
  const len = Number(res.headers.get('content-length') || 0)
  if (Number.isFinite(len) && len > MAX_BODY) {
    void res.body?.cancel()
    return { ok: false, reason: 'assert_fail' }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'assert_fail' }
  }
  const video = obj(body)
  /**
   * THE LIVENESS ASSERTION: a numeric `id`, a string `uuid` and a non-empty `name`. Nothing weaker
   * distinguishes a real instance from an origin that happens to serve JSON at that path — and `name`
   * specifically, because it is the one field the card cannot be built without.
   */
  if (!video || typeof video.id !== 'number') return { ok: false, reason: 'assert_fail' }
  if (typeof video.uuid !== 'string' || !video.uuid) return { ok: false, reason: 'assert_fail' }
  if (typeof video.name !== 'string' || !video.name) return { ok: false, reason: 'assert_fail' }
  return { ok: true, video }
}
