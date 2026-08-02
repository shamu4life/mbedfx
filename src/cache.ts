import type { ClientClass, Post, PostRef } from './types.ts'
import { refKey, parseRefKey } from './refkey.ts'

/** 15 min. Also the max age of a signed CDN URL we hand out (plus MEDIA_MAX_AGE). */
export const POST_TTL = 900
export const RESP_TTL = 900
/** On the /_media/ 302 itself, bounding repeat media hits. Matches InstaFix-Revived. */
export const MEDIA_MAX_AGE = 300

/** Shared across client classes: one upstream fetch serves every bot. */
export const postCacheKey = (ref: PostRef) => `post:${refKey(ref)}`

/**
 * Only the rendered response varies by client. Never Vary: User-Agent — cardinality is unbounded.
 *
 * THE ORIGIN IS PART OF THE KEY, added 2026-07-25 with the apex cutover, and it is not a nicety.
 * This worker answers on FOUR hostnames across TWO zones (mbedfx.app and staging.*, plus the original
 * megapenispoopenfarten.sex and staging.* retained for links already pasted), and a rendered
 * response is not origin-independent: renderPostRoute builds every og:video / twitter:player /
 * avatar url from `new URL(req.url).origin`, so the markup EMBEDS the hostname that rendered it.
 * Keyed without the origin, the first hostname to warm a post wins and serves its urls to the other
 * — measured immediately after the cutover, when the apex answered /reel, /share/v and /t cards whose
 * og:video pointed at staging.megapenispoopenfarten.sex.
 *
 * That is worse than untidy. Discord CACHES the media url it is given, keyed by that url, so a
 * production card can pin a staging hostname for as long as Discord keeps it — and staging is
 * precisely the hostname most likely to be renamed or torn down. The 2026-07-30 rename made this
 * load-bearing twice over: with two zones live, a card warmed on either one would otherwise serve its
 * hostname to the other, and the whole point of keeping the old zone is that its links keep working. Note a `?cb=` cache-buster does NOT
 * expose this: the key is built from the REF, so the query string never reaches it.
 *
 * The POST cache deliberately stays origin-free (postCacheKey above): it holds upstream platform
 * data, which is genuinely the same whoever asked, and sharing it is the point.
 */
export const respCacheKey = (ref: PostRef, client: ClientClass, origin: string) =>
  `resp:${refKey(ref)}:${client}:${origin}`

/**
 * A SHORT CODE IS A LOOKUP NAME, NOT AN IDENTITY, AND IT GETS ITS OWN NAMESPACE.
 *
 * The obvious spelling — build a `{p:'tt', id: code}` and run it through the two functions above
 * — renders `post:tt:{code}`, which is byte-identical in shape to `post:tt:{id}` for a real post.
 * A short code and a post id are then THE SAME CACHE ENTRY, and both directions were reachable:
 *
 *   - Warm /@u/video/7660566211100511518, then request /t/7660566211100511518: the short link
 *     was answered off the post-id key with the resolver never called. Upstream answers
 *     /t/{19 digits} with the HOMEPAGE (measured), so the correct answer is the chooser — one URL
 *     with two answers, decided by whether anybody happened to view the permalink first.
 *   - The reverse, the day TikTok mints an all-digit code: resolving /t/999 wrote `post:tt:999`,
 *     so the legitimate permalink for post 999 served whatever that code resolved to. The wrong
 *     post, silently, which is the one failure mode this codebase says it cannot debug.
 *
 * The `short:` infix cannot collide with a refKey: refKey always begins with a Platform tag, and
 * `short` is not one. Percent-encoded for the same reason refKey encodes its components — the
 * code is an unvalidated path segment and ':' is the delimiter here.
 *
 * getPost's canonical-key write is what keeps this from splitting a post in half: the resolved
 * Post also lands under postCacheKey(post.ref), so /_media/ and the long-form permalink share
 * one entry with the short link.
 */
export const shortPostCacheKey = (p: 'tt', code: string) => `post:short:${p}:${encodeURIComponent(code)}`

/** The rendered-response twin. Same namespace argument, plus the client class — and the origin, for
 *  exactly the reason respCacheKey carries one: this value is rendered markup with a hostname in it. */
export const shortRespCacheKey = (p: 'tt', code: string, client: ClientClass, origin: string) =>
  `resp:short:${p}:${encodeURIComponent(code)}:${client}:${origin}`

/** The Cache API needs a full URL as its key; this namespaces ours onto a fake origin. */
export const cacheUrl = (key: string) => `https://cache.mbedfx.internal/${encodeURIComponent(key)}`

function reviveDates(p: any): any {
  if (!p) return p
  p.createdAt = new Date(p.createdAt)
  if (p.quote) reviveDates(p.quote)
  if (p.replyTo) reviveDates(p.replyTo)
  return p
}

/** Structural equality for the flat, all-primitive shape of a PostRef. */
function shallowEqual(a: object, b: object): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every(k => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

/**
 * A ref is well-formed only if it round-trips through refKey → parseRefKey back to
 * itself — the strongest check available with zero new dependencies, and it reuses
 * the two functions that already define ref identity rather than hand-rolling a
 * parallel per-platform validator that could drift from them.
 *
 * `typeof refKey(ref) === 'string'` is NOT sufficient. refKey's switch has no
 * default case, so an unknown platform tag (`{p:'zz'}`) silently returns
 * `undefined` (caught by the typeof check below) — but a KNOWN tag with missing
 * fields (`{p:'bs'}`) does NOT: `encodeURIComponent(undefined) === 'undefined'`,
 * so it returns the literal string `'bs:undefined:undefined'`. Only the round
 * trip through parseRefKey — which requires every component to be non-empty —
 * catches that second case.
 */
function isValidRef(ref: unknown): ref is PostRef {
  if (!ref || typeof ref !== 'object') return false
  const key = refKey(ref as PostRef)
  if (typeof key !== 'string') return false
  const parsed = parseRefKey(key)
  return parsed !== null && shallowEqual(parsed, ref)
}

/**
 * Ref shape + a non-empty canonical string + a Date that actually parses. Applied
 * identically to the root post AND, since reviveDates already recurses into them,
 * to a nested quote/replyTo too — a corrupted canonical one level down reaches the
 * exact same served markup (render/discord.ts's `esc(post.canonical)`) as a
 * corrupted root canonical would. It is dormant only because quote/replyTo layout
 * is Phase 2; the guard must be total between a corrupted cache entry and served
 * output regardless of what today's renderer happens to draw.
 * Depth is capped at 1 (Post.quote.quote is always undefined), so this is never
 * called more than two levels deep and needs no recursion of its own.
 */
function hasValidIdentity(o: any): boolean {
  return (
    isValidRef(o?.ref) &&
    typeof o?.canonical === 'string' && o.canonical.length > 0 &&
    typeof o?.createdAt === 'string' && !Number.isNaN(Date.parse(o.createdAt))
  )
}

export function serializePost(p: Post): string {
  // JSON.stringify turns Date into an ISO string automatically, including nested ones.
  return JSON.stringify(p)
}

export function deserializePost(s: string): Post | null {
  try {
    const o = JSON.parse(s)
    // hasValidIdentity covers the root the same way it covers quote/replyTo — no
    // separate `typeof o.canonical === 'string'` check here, so root and nested
    // posts can never drift out of sync again.
    if (!hasValidIdentity(o)) return null
    if (o.quote != null && !hasValidIdentity(o.quote)) return null
    if (o.replyTo != null && !hasValidIdentity(o.replyTo)) return null
    return reviveDates(o) as Post
  } catch {
    return null
  }
}
