import type { PostRef, ProfileRef } from '../../types.ts'
import { BS_ACTOR } from '../../refkey.ts'

const API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread'
const PROFILE_API = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile'

/**
 * Bluesky's public AT Protocol: no auth, no anti-bot, no rate wall.
 * The only non-adversarial platform of the six.
 */
export async function fetchBluesky(ref: Extract<PostRef, { p: 'bs' }>): Promise<unknown> {
  const uri = `at://${ref.handle}/app.bsky.feed.post/${ref.rkey}`
  const url = `${API}?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=1`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) return null
  // Never JSON.parse an unvalidated body — platforms return HTML error pages with 200s.
  if (!(res.headers.get('content-type') || '').includes('json')) return null
  return res.json()
}

/**
 * THE ACCOUNT, for a profile card. One unauthenticated GET, same public appview as the post path.
 *
 * MEASURED FROM CLOUDFLARE EGRESS 2026-08-11 (wrangler dev --remote), which is where it matters and
 * not from a laptop:
 *
 *   ?actor=bsky.app                             200, application/json, 1,052 bytes, 409ms
 *                                               displayName, description, avatar, banner, createdAt,
 *                                               followersCount, followsCount, postsCount
 *   ?actor=thishandledoesnotexist9987.bsky.social
 *                                               400, {"error":"InvalidRequest",
 *                                                     "message":"Profile not found"}
 *
 * A MISSING ACCOUNT IS AN HONEST 400 HERE, which is worth writing down because it is the exception
 * on this project rather than the rule: the endpoint does not answer a miss with a 200 and a decoy
 * the way Twitter's syndication endpoint, TikTok's page and Instagram's do. The content assertion
 * below is still the load-bearing one — `res.ok` proving nothing is a property of the OTHER
 * platforms' habits, not of this response's status code, and the day this endpoint starts serving
 * an error envelope at 200 the normalizer's did/handle check is what catches it.
 *
 * THE SHAPE GUARD IS RE-APPLIED HERE rather than trusted from the router: this value is
 * interpolated into a query on a fixed origin, and the fetcher is the boundary a future caller
 * (a resolver, a batch warm) would cross without passing through route(). Same discipline
 * platforms/lemmy/fetch.ts applies to its host.
 */
export async function fetchBlueskyProfile(ref: ProfileRef): Promise<unknown> {
  if (ref.p !== 'bs' || !BS_ACTOR.test(ref.handle)) return null
  const res = await fetch(`${PROFILE_API}?actor=${encodeURIComponent(ref.handle)}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) return null
  if (!(res.headers.get('content-type') || '').includes('json')) return null
  return res.json()
}
