import type { PostRef } from '../../types.ts'
import { MASTO_ID } from '../../refkey.ts'
import { MAX_BODY, fetchableInstance } from '../fedihost.ts'

/**
 * I/O ONLY. `GET /api/v1/statuses/{id}`, unauthenticated, ON THE HOST THE USER PASTED.
 *
 * WHY THIS ENDPOINT COVERS A WHOLE FAMILY. The Mastodon client API is the de-facto standard of the
 * microblogging fediverse — Pleroma, Akkoma, GoToSocial and Pixelfed all implement it to keep
 * Mastodon apps working, so ONE client reads all of them. That is the entire reason this platform is
 * named for an API rather than a product.
 *
 * IT IS OPEN WITHOUT A CREDENTIAL, which is not obvious and was nearly mis-measured. A first sweep
 * sourced status ids from `/api/v1/timelines/public` and concluded several softwares were gated,
 * because that TIMELINE returns 401/422 on many instances (mastodon.social 422, GoToSocial 401,
 * Friendica 401). The SINGLE-STATUS endpoint is a different permission: measured open on mstdn.social
 * and hachyderm.io (Mastodon) and fe.disroot.org (Akkoma) with a real id. The probe's limit had
 * masqueraded as the platform's.
 *
 * THE PASTED HOST IS THE RIGHT SOURCE, exactly as for Lemmy: a status id is LOCAL to the instance
 * serving it, so the id in the pasted URL only means anything on that host. Unlike Lemmy this is not
 * merely preferable but required — there is no second host where that id resolves to the same post.
 *
 * WHY NOT ActivityPub. `Accept: application/activity+json` on a status permalink returns the origin's
 * canonical object, but it carries no engagement counts, no `sensitive` flag in the shape we need,
 * and instances disagree about whether to serve it unauthenticated. The client API answers everything
 * in one call.
 */

/**
 * The reasons are spelled in the ANALYTICS vocabulary (Outcome2) rather than in one invented here, so
 * worker.ts can count them without a translation table that would be the place the two drift apart.
 */
export type MastoFetch =
  | { ok: true; status: Record<string, unknown> }
  | { ok: false; reason: 'assert_fail' | 'notfound' }

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * A THROWN FETCH IS NOT CAUGHT — worker.ts treats a thrown live fetch as null, the same contract
 * every sibling platform fetcher has. Only upstream ANSWERS are classified here.
 */
export async function fetchMasto(
  ref: Extract<PostRef, { p: 'ms' }>,
  origin?: string,
): Promise<MastoFetch> {
  if (!fetchableInstance(ref.host, origin) || !MASTO_ID.test(ref.id)) {
    return { ok: false, reason: 'assert_fail' }
  }
  const res = await fetch(`https://${ref.host}/api/v1/statuses/${encodeURIComponent(ref.id)}`, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  })
  /**
   * A DELETED STATUS IS A WALL, NOT A MISS. Mastodon answers 404 with `{"error":"Record not found"}`
   * for both a never-existed id and a deleted one, so they cannot be told apart — but either way the
   * honest card is "this post is gone", not the generic couldn't-load. 410 is the same answer for a
   * status whose account was suspended.
   */
  if (res.status === 404 || res.status === 410) {
    void res.body?.cancel()
    return { ok: false, reason: 'notfound' }
  }
  // ASSERT ON CONTENT — but refuse a non-JSON content type before spending the body read, because a
  // decoy here is a full HTML page rather than a small error document.
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
  const status = obj(body)
  /**
   * THE LIVENESS ASSERTION: a status object carrying its own STRING id and an `account` that carries
   * an `acct`. Nothing weaker is evidence that this host is really running fediverse software rather
   * than being an origin that happens to serve JSON at that path.
   *
   * `id` IS A STRING IN THIS API even on Mastodon, whose ids are numeric — they are serialised as
   * strings precisely because they overflow a double. Accepting a number here would admit a decoy
   * that Mastodon itself would never send.
   */
  if (!status || typeof status.id !== 'string' || !status.id) return { ok: false, reason: 'assert_fail' }
  const account = obj(status.account)
  if (!account || typeof account.acct !== 'string' || !account.acct) {
    return { ok: false, reason: 'assert_fail' }
  }
  return { ok: true, status }
}
