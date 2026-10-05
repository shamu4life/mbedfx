import type { PostRef } from '../../types.ts'
import type { Env } from '../../analytics.ts'
import { redditGate, redditGifUrl } from './normalize.ts'
import { askTwice } from '../../fetchretry.ts'

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

/**
 * `gifHead` rides on a success when the post is a Reddit gif (normalize.ts redditGifUrl): the first ten
 * bytes of its .gif, unparsed, for normalize.ts's gifSize to read the size out of. Absent when there was
 * nothing to read or the read failed, which costs the card its size and nothing else.
 */
export type RedditFetch =
  | { ok: true; source: 'embed'; html: string; gifHead?: Uint8Array }
  | { ok: true; source: 'json'; data: unknown; gifHead?: Uint8Array }
  | { ok: false; reason: 'assert_fail' | 'private' }

/**
 * How long the gif's size may take. Sized on what was measured, not on a guess at Worker latency: 40
 * ranged GETs of the headers of 36 i.redd.it gifs from the Claude Code dev sandbox (2026-10-05; not a
 * Worker, and Worker egress to i.redd.it has NOT been measured) answered in 120 to 425 ms, all 206 with
 * a GIF87a/GIF89a signature. This runs after the embed fetch and inside
 * the head's whole-response budget (worker.ts HTML_DEADLINE_MS, 5000), so its ceiling is spent from the
 * same pot as everything else on a cold first paste, and a slow i.redd.it must cost a size, never a card.
 */
const GIF_HEAD_TIMEOUT_MS = 1000

/** The header holds the logical screen size at bytes 6-9, so ten bytes is the whole read. */
const GIF_HEAD_BYTES = 10

/**
 * The first ten bytes of a Reddit gif, or undefined. I/O ONLY: whether they are a GIF, and what size
 * they say, is normalize.ts's gifSize. The url has already passed redditGifUrl's i.redd.it check.
 *
 * WHAT IS SENT, AND WHY EACH PART. Measured 2026-10-05 from the dev sandbox against
 * i.redd.it/4gg2f32z3qsh1.gif: `range: bytes=0-9` answers 206 with exactly ten bytes (content-range
 * bytes 0-9/556483), so a 99 MB gif costs ten bytes, not a download. An Accept that lists text/html gets a
 * 307 to www.reddit.com/media (an HTML viewer); an image Accept, `*\/*` or none gets the gif, so this
 * asks for images. `redirect: 'manual'` keeps a redirect from being followed into that page, and the
 * body is read only to the tenth byte and then cancelled, so a server that ignored the Range header
 * still costs ten bytes of reading.
 */
async function readGifHead(url: string): Promise<Uint8Array | undefined> {
  try {
    // NO-RETRY: deliberate. This only reads a SIZE for a card that renders either way, and a failed
    // read already degrades to 0x0, so a second ask buys nothing a reader is owed and doubles the cost
    // of the failure path inside the head's budget. Bounded by GIF_HEAD_TIMEOUT_MS. See src/fetchretry.ts.
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'image/gif,image/*;q=0.8', range: `bytes=0-${GIF_HEAD_BYTES - 1}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(GIF_HEAD_TIMEOUT_MS),
    })
    const reader = res.body?.getReader()
    if (!reader) return undefined
    const out = new Uint8Array(GIF_HEAD_BYTES)
    let n = 0
    while (n < GIF_HEAD_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const take = Math.min(GIF_HEAD_BYTES - n, value.length)
      out.set(value.subarray(0, take), n)
      n += take
    }
    reader.cancel().catch(() => {})
    return out.slice(0, n)
  } catch {
    // A timeout, a reset or a refusal is no evidence about the post, and this path must never throw
    // into the fetch that decides whether a card exists. No size is the whole consequence.
    return undefined
  }
}

/** A successful fetch, plus its gif's header when the post is one. Never turns a success into a failure. */
async function withGifHead<T extends Extract<RedditFetch, { ok: true }>>(got: T): Promise<T> {
  const url = redditGifUrl(got)
  if (!url) return got
  const gifHead = await readGifHead(url)
  return gifHead ? { ...got, gifHead } : got
}

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
  const res = await askTwice(`https://embed.reddit.com/r/${sub}/comments/${encodeURIComponent(ref.id)}/`, {
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
    res = await askTwice(shareUrl, {
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
  const res = await askTwice('https://www.reddit.com/api/v1/access_token', {
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
  const res = await askTwice(`https://oauth.reddit.com/comments/${encodeURIComponent(ref.id)}?raw_json=1&limit=1`, {
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
 * usually are not. A thrown fetch is NOT caught — worker.ts treats a thrown live fetch as null. A
 * success that is a Reddit gif also carries its header (withGifHead), whichever path produced it, so
 * both renders size the gif the same way.
 */
export async function fetchReddit(ref: Extract<PostRef, { p: 'rd' }>, env: Env): Promise<RedditFetch> {
  if (!POST_ID.test(ref.id)) return { ok: false, reason: 'assert_fail' }
  const embed = await fetchRedditEmbed(ref)
  if (embed.ok) return withGifHead(embed)
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    const oauth = await fetchRedditOAuth(ref, env)
    if (oauth.ok) return withGifHead(oauth)
    if (oauth.reason === 'private') return oauth
  }
  return embed
}
