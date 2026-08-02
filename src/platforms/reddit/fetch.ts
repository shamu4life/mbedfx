import type { PostRef } from '../../types.ts'
import type { Env } from '../../analytics.ts'
import { redditGate } from './normalize.ts'

/**
 * I/O ONLY. Reddit blocks anonymous `.json` from datacenter IPs (verified 2026-07-21: our Workers
 * egress gets a 403 "network security" block page). The way in is `embed.reddit.com` — the host that
 * backs Reddit's official post-embed widget — which serves the full post server-rendered and is NOT
 * IP-blocked from our egress (verified). That is the PRIMARY, credential-free path. An OAuth app-only
 * token (oauth.reddit.com) stays as a FALLBACK for when the Reddit app creds are set, but Reddit gates
 * app creation behind the Responsible Builder Policy so that path rarely runs.
 */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
// Reddit's convention is `platform:app-id:version (by /u/user)`. Only the OAUTH fallback sends
// this (the primary embed path uses BROWSER_UA), and that path is effectively dead behind
// Reddit's Responsible Builder gate — so the rename here is identification, not behaviour.
const REDDIT_UA = 'web:mbedfx.app:v0.1 (by /u/shamu4life)'

// The post id is base36; guard the path the same way the other fetchers guard theirs.
const POST_ID = /^[0-9a-z]+$/i

export type RedditFetch =
  | { ok: true; source: 'embed'; html: string }
  | { ok: true; source: 'json'; data: unknown }
  | { ok: false; reason: 'assert_fail' | 'private' }

/**
 * PRIMARY. `embed.reddit.com/r/{sub}/comments/{id}/`. Resolution is by id, so a placeholder sub still
 * resolves the post — BUT (measured from Workers egress 2026-07-22) a placeholder gets a STRIPPED
 * ~280KB render with NO title/author/score element, while the REAL sub gets the full ~308KB page. So
 * pass the real subreddit when the ref carries it (every /r/{sub}/comments/ link — the common case);
 * only a bare /comments/{id} link falls back to the `_` placeholder, and normalizeReddit derives a
 * title from the url slug for that degraded case. ASSERT ON CONTENT: every id, including bad/deleted,
 * returns HTTP 200, so liveness is the canonical url present and no `/undefined` marker, never status.
 * A thrown fetch is NOT caught (a transport failure is the worker's null, not a Reddit signal).
 */
async function fetchRedditEmbed(ref: Extract<PostRef, { p: 'rd' }>): Promise<RedditFetch> {
  const sub = ref.sub && /^[A-Za-z0-9_]+$/.test(ref.sub) ? ref.sub : '_'
  const res = await fetch(`https://embed.reddit.com/r/${sub}/comments/${encodeURIComponent(ref.id)}/`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
    redirect: 'follow',
  })
  const html = await res.text()
  if (/id="canonical-url-updater"/.test(html) && !/\/undefined"/.test(html)) {
    return { ok: true, source: 'embed', html }
  }
  return { ok: false, reason: 'assert_fail' }
}

/**
 * Resolve the mobile app's share link (/r/{sub}/s/{code}, or /user/{name}/s/{code}) to its canonical
 * permalink URL. The /s/ code is an OPAQUE share token: Reddit answers it with a 301 whose Location is
 * the /comments/{id} permalink. We take exactly ONE hop (`redirect: 'manual'`, which the Workers
 * runtime lets us read the Location off — unlike a browser's opaque redirect) and return the Location
 * string; the caller re-routes that permalink and fetches the post by id via the egress-safe
 * embed.reddit.com path above. This hits Reddit's WEB edge (www.reddit.com), a DIFFERENT endpoint from
 * the .json/oauth API that IP-blocks our datacenter egress — its reachability is asserted on staging,
 * not assumed, and a block simply yields no Location -> a clean null (the generic card, no regression).
 *
 * The fetch IS guarded here (the sibling platform fetchers deliberately are not): this resolver is
 * called OUTSIDE loadPost's try/catch, so an unguarded throw would be a 500 on a public path rather
 * than the honest "couldn't load".
 */
export async function resolveRedditShareUrl(shareUrl: string): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(shareUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
    })
  } catch {
    return null
  }
  if (res.status < 300 || res.status >= 400) return null
  return res.headers.get('location')
}

/** App-only token, cached in module scope for its lifetime minus a minute. Null when creds are unset. */
let tokenCache: { token: string; exp: number } | null = null

async function appToken(env: Env): Promise<string | null> {
  const now = Date.now()
  if (tokenCache && tokenCache.exp > now + 60_000) return tokenCache.token
  const id = env.REDDIT_CLIENT_ID
  const secret = env.REDDIT_CLIENT_SECRET
  if (!id || !secret) return null
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': REDDIT_UA,
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) return null
  const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
  if (typeof j.access_token !== 'string') return null
  tokenCache = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 }
  return tokenCache.token
}

/** FALLBACK. oauth.reddit.com by id; a private/banned sub answers with an error object -> 'private'. */
async function fetchRedditOAuth(ref: Extract<PostRef, { p: 'rd' }>, env: Env): Promise<RedditFetch> {
  const token = await appToken(env)
  if (!token) return { ok: false, reason: 'assert_fail' }
  const res = await fetch(`https://oauth.reddit.com/comments/${encodeURIComponent(ref.id)}?raw_json=1&limit=1`, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': REDDIT_UA, accept: 'application/json' },
  })
  if (!(res.headers.get('content-type') || '').includes('json')) return { ok: false, reason: 'assert_fail' }
  const body = await res.json()
  const gate = redditGate(body)
  if (gate) return { ok: false, reason: gate }
  if (!res.ok) return { ok: false, reason: 'assert_fail' }
  return { ok: true, source: 'json', data: body }
}

/**
 * embed first (credential-free, egress-safe, rich); OAuth only if the app creds are set, which they
 * usually are not. A thrown fetch is NOT caught — worker.ts treats a thrown live fetch as null.
 */
export async function fetchReddit(ref: Extract<PostRef, { p: 'rd' }>, env: Env): Promise<RedditFetch> {
  if (!POST_ID.test(ref.id)) return { ok: false, reason: 'assert_fail' }
  const embed = await fetchRedditEmbed(ref)
  if (embed.ok) return embed
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    const oauth = await fetchRedditOAuth(ref, env)
    if (oauth.ok || oauth.reason === 'private') return oauth
  }
  return embed
}
