import type { PostRef } from '../../types.ts'
import { LEMMY_ID } from '../../refkey.ts'
import { MAX_BODY, instanceFetchable, type InstanceGuard } from '../fedihost.ts'
import { askTwice } from '../../fetchretry.ts'

/**
 * I/O ONLY. Lemmy's v3 API, unauthenticated, ON THE HOST THE USER PASTED.
 *
 * THE PASTED HOST IS THE RIGHT SOURCE, not merely an acceptable one. A federated post exists on many
 * instances and they do not agree: the same post read from sopuli.xyz and from lemmy.dbzer0.com
 * returns score 88 vs 86, and a different `thumbnail_url` (the origin caches its own pict-rs copy;
 * the mirror kept the third-party URL). The instance the user was LOOKING AT is the one whose card
 * they expect, and it is also the one whose moderation state applies to them. `post.ap_id` carries
 * the canonical origin for the link, so nothing is lost by reading locally.
 *
 * WHY NOT ActivityPub, which was the obvious alternative. `Accept: application/activity+json` on a
 * mirror's permalink 308s to the origin (verified: sopuli.xyz/post/49387259 ->
 * lemmy.dbzer0.com/post/72978307), which is elegant — but it answers the wrong question (it gives the
 * ORIGIN's view, not the pasted instance's), it carries no vote or comment counts, and it is not
 * reliable: discuss.tchncs.de answers an AP request with `text/html` at HTTP 200. The v3 call needs
 * none of that machinery. The AP path stays the documented hedge for the eventual v3 -> v4 cut.
 *
 * WHY NOT resolve_object, which would have removed the user-supplied host entirely. It cannot:
 * unauthenticated it is a LOCAL DATABASE LOOKUP and never federates on demand. Measured over 12
 * host/object pairs — a cold object 400s with `couldnt_find_object` and a second attempt never flips
 * it — and Lemmy's own source says so: the remote-lookup branch is gated on `local_user_view.is_some()`.
 * Federation-on-demand requires an account, i.e. a credential.
 *
 * VERSION SPREAD IS NOT A PROBLEM TODAY. Of 481 instances in the public census, ZERO are on 1.x or
 * 0.20+; `/api/v4/site` is a bare 404 everywhere.
 *
 * THIS CLIENT IS LEMMY-ONLY. An earlier revision of this comment claimed PieFed came along for free
 * because it "also serves /api/v3/*". That is FALSE and was corrected by measurement (2026-07-28):
 * PieFed serves `/api/v3/site` — a compatibility shim so Lemmy apps can fingerprint it — and 404s
 * `/api/v3/post?id=`, which is the only endpoint this client actually calls. Its real post API is
 * `/api/alpha/post?id=`, and the payload differs in two ways beyond the path: the title lives in
 * `post.title` (Lemmy uses `post.name`, so a naive port yields a titleless card) and `image_details`
 * sits on the POST rather than on the view. The `post_view` envelope, `creator.actor_id` and
 * `community.actor_id` are otherwise identical, so adding PieFed is a small, deliberate change —
 * not something to assume already works. Until then a PieFed URL fails the liveness assert and
 * renders "couldn't load", which is honest.
 *
 * MBIN / KBIN ARE OUT OF REACH, not merely unbuilt: their API is credential-gated. `/api/entry/{id}`
 * on fedia.io answers 401 `Full authentication is required` with no anonymous path — the same dead
 * end as Reddit's OAuth surface. Nothing to build here without an account.
 */

/**
 * THE SSRF BOUNDARY NOW LIVES IN ../fedihost.ts, shared with the Mastodon-API client — a security
 * boundary kept in two copies is one that gets fixed in one copy. Clauses 4, 5 and 6 of the contract
 * documented there are enforced BELOW, in attempt(): manual redirects, the body cap, and the
 * content-shaped liveness assert.
 *
 * RE-EXPORTED AS THE SYNC PREDICATE, which is the half that answers "may this host be fetched at
 * all" with no I/O. fetchLemmy itself calls `instanceFetchable`, the whole gate: this plus clause
 * 7's DNS seam, which only a self-hosted runtime can supply.
 */
export { fetchableInstance } from '../fedihost.ts'

export type LemmyFetch =
  | { ok: true; view: Record<string, unknown> }
  | { ok: false; reason: 'assert_fail' | 'private' }

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * THE TWO SOFTWARE FAMILIES THAT ANSWER A LEMMY-SHAPED URL, in that order.
 *
 * A `/{host}/post/{id}` link does not say which software serves it, and no cheap header does either
 * (PieFed answers `/api/v3/site` precisely so Lemmy clients fingerprint it as Lemmy). So the flavour
 * is discovered by ASKING, and the cost is bounded at two subrequests: Lemmy — far the larger
 * population — is tried first and costs one, PieFed costs two.
 *
 * A NodeInfo lookup would identify the software in advance, but it would cost every Lemmy request an
 * extra round trip to save PieFed one, which is the wrong trade at this population ratio.
 */
const FLAVORS = [
  { post: (id: string) => `/api/v3/post?id=${id}`, comment: (id: string) => `/api/v3/comment?id=${id}` },
  { post: (id: string) => `/api/alpha/post?id=${id}`, comment: (id: string) => `/api/alpha/comment?id=${id}` },
] as const

/**
 * ONE ATTEMPT against one endpoint. Every guard in the SSRF boundary above applies per attempt.
 */
async function attempt(host: string, path: string): Promise<LemmyFetch> {
  const res = await askTwice(`https://${host}${path}`, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  })
  // ASSERT ON CONTENT — but refuse a non-JSON content type before spending the body read, because a
  // decoy here is a 227KB HTML page rather than a small error document. PieFed's 404 for the v3 post
  // endpoint is exactly this shape: `text/html` at a non-200, caught here without reading a body.
  const ct = res.headers.get('content-type') || ''
  if (!/^application\/json\b/i.test(ct.trim())) return { ok: false, reason: 'assert_fail' }
  const len = Number(res.headers.get('content-length') || 0)
  if (Number.isFinite(len) && len > MAX_BODY) return { ok: false, reason: 'assert_fail' }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'assert_fail' }
  }
  const top = obj(body)
  if (!top) return { ok: false, reason: 'assert_fail' }
  // A private instance answers with a typed error rather than a view; that is a WALL, not a miss, and
  // it is the one error string worth telling apart (everything else — couldnt_find_post, a removed
  // post, a bad id — is the generic "couldn't load").
  if (typeof top.error === 'string') {
    return { ok: false, reason: top.error === 'instance_is_private' ? 'private' : 'assert_fail' }
  }
  const view = obj(top.post_view) ?? obj(top.comment_view)
  // The liveness assertion: a *_view carrying a post that carries its own id. Nothing else is
  // evidence that this host is really a Lemmy instance rather than an origin that happens to serve
  // JSON at that path.
  if (!view || !obj(view.post) || typeof obj(view.post)?.id !== 'number') {
    return { ok: false, reason: 'assert_fail' }
  }
  return { ok: true, view }
}

/**
 * A THROWN FETCH IS NOT CAUGHT — worker.ts treats a thrown live fetch as null, the same contract
 * every sibling platform fetcher has. Only upstream ANSWERS are classified here.
 *
 * A THROW ON THE FIRST FLAVOUR STILL TRIES THE SECOND, deliberately: a DNS failure or a connection
 * reset is a property of the attempt, not a verdict on the instance, and giving up there would make
 * PieFed's support depend on how Lemmy's endpoint happens to fail. A throw on the LAST flavour
 * propagates, preserving the existing contract.
 */
export async function fetchLemmy(
  ref: Extract<PostRef, { p: 'lm' }>,
  guard?: InstanceGuard,
): Promise<LemmyFetch> {
  if (!LEMMY_ID.test(ref.id) || !(await instanceFetchable(ref.host, guard))) {
    return { ok: false, reason: 'assert_fail' }
  }
  const id = encodeURIComponent(ref.id)
  let last: LemmyFetch = { ok: false, reason: 'assert_fail' }
  for (let i = 0; i < FLAVORS.length; i++) {
    // A COMMENT is fetched by its own endpoint; both return a *_view carrying the post.
    const path = ref.kind === 'comment' ? FLAVORS[i].comment(id) : FLAVORS[i].post(id)
    let r: LemmyFetch
    try {
      r = await attempt(ref.host, path)
    } catch (e) {
      if (i === FLAVORS.length - 1) throw e
      continue
    }
    if (r.ok) return r
    // A PRIVATE INSTANCE IS A FINAL ANSWER, not something to retry under a different API. Falling
    // through would turn a truthful "this instance is private" into a generic "couldn't load".
    if (r.reason === 'private') return r
    last = r
  }
  return last
}
