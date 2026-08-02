import type { PostRef } from '../../types.ts'
import { MASTO_ID } from '../../refkey.ts'
import { MAX_BODY, fetchableInstance } from '../fedihost.ts'

/**
 * I/O ONLY. `POST /api/notes/show`, unauthenticated, ON THE HOST THE USER PASTED.
 *
 * WHY THIS RATHER THAN THE MASTODON ENDPOINT, measured rather than assumed. Misskey has NO Mastodon
 * compatibility layer at all (`/api/v1/statuses/{id}` → 404 `UNKNOWN_API_ENDPOINT`), and Sharkey
 * 2025.4.7's compat layer answers only for BOOSTS — original notes 404 `NO_SUCH_NOTE`, reproduced on
 * three separate instances across 60 notes while `notes/show` returned every one. Iceshrimp and newer
 * Sharkey answer both. So this endpoint is preferred for the whole family: all of them serve it, all
 * of them take the id straight out of `/notes/{id}`, and it has no version hole.
 *
 * IT IS A POST WITH A JSON BODY, unlike every other fetcher here. That does not weaken the SSRF
 * contract in ../fedihost.ts: the body carries the note id and nothing else, so there is still no
 * credential to leak to whatever origin the ref names.
 *
 * NO `Accept` NEGOTIATION GAME IS NEEDED — this API is JSON in, JSON out, and (unlike every Meta
 * surface in this project) does not vary on User-Agent.
 */

export type MisskeyFetch =
  | { ok: true; note: Record<string, unknown> }
  | { ok: false; reason: 'assert_fail' | 'notfound' | 'private' }

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * A THROWN FETCH IS NOT CAUGHT — worker.ts treats a thrown live fetch as null, the same contract
 * every sibling platform fetcher has. Only upstream ANSWERS are classified here.
 */
export async function fetchMisskey(
  ref: Extract<PostRef, { p: 'mk' }>,
  origin?: string,
): Promise<MisskeyFetch> {
  if (!fetchableInstance(ref.host, origin) || !MASTO_ID.test(ref.id)) {
    return { ok: false, reason: 'assert_fail' }
  }
  const res = await fetch(`https://${ref.host}/api/notes/show`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ noteId: ref.id }),
    redirect: 'manual',
  })
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
  const top = obj(body)
  if (!top) return { ok: false, reason: 'assert_fail' }
  /**
   * MISSKEY'S ERRORS ARE TYPED AND TWO OF THEM ARE WORTH TELLING APART.
   *
   * `NO_SUCH_NOTE` is a deleted or never-existent note — a wall, not a fetch failure.
   * `SIGNIN_REQUIRED` is an author-level setting (`requireSigninToViewContents`), which is a real
   * PRIVACY wall and measured live on a real account — so it maps to the same 'private' outcome as a
   * Lemmy private instance rather than to the generic couldn't-load.
   */
  const err = obj(top.error)
  if (err) {
    const code = typeof err.code === 'string' ? err.code : ''
    if (code === 'NO_SUCH_NOTE') return { ok: false, reason: 'notfound' }
    if (code === 'SIGNIN_REQUIRED' || code === 'AUTHENTICATION_FAILED') {
      return { ok: false, reason: 'private' }
    }
    return { ok: false, reason: 'assert_fail' }
  }
  /**
   * THE LIVENESS ASSERTION: a note carrying its own STRING id and a `user` that carries a username.
   * Nothing weaker distinguishes a real instance from an origin that happens to serve JSON here.
   */
  if (typeof top.id !== 'string' || !top.id) return { ok: false, reason: 'assert_fail' }
  const user = obj(top.user)
  if (!user || typeof user.username !== 'string' || !user.username) {
    return { ok: false, reason: 'assert_fail' }
  }
  return { ok: true, note: top }
}
