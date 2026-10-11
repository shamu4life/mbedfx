import type { PostRef } from '../../types.ts'
import type { Env } from '../../analytics.ts'
import { REDDIT_SUB, redditEmbedSub, redditGate, redditGifUrl, redditNeedsCaption } from './normalize.ts'
import { crawlerCaption, feedCaption } from './caption.ts'
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
// A subreddit name as it may appear in a path we build, a profile's `u_{name}` included (normalize.ts
// REDDIT_SUB). Anything else is asked as the `_` placeholder.
const SUB = REDDIT_SUB

/**
 * THE CRAWLER PAGE'S ADDRESS. A post on a user's profile lives at `/user/{name}/comments/{id}/`: asked as
 * `/r/u_{name}/…` Reddit answers a 301 to that path with a 51-58 byte body and no meta, while the /user/ path
 * answers its own 301 carrying the description and og tags like any subreddit post (residential, 2026-10-11:
 * u_NekkidSnaku/1x1vfk8 and u_whatthechuck_99/1x00xeb; NOT measured from a Worker).
 */
function crawlerUrl(sub: string, id: string): string {
  return sub.startsWith('u_')
    ? `https://www.reddit.com/user/${sub.slice(2)}/comments/${id}/`
    : `https://www.reddit.com/r/${sub}/comments/${id}/`
}

/**
 * `gifHead` rides on a success when the post is a Reddit gif (normalize.ts redditGifUrl): up to the first
 * ten bytes of whatever i.redd.it answered, AS RECEIVED, for normalize.ts's gifSize to read the size out
 * of. Absent only on a thrown or timed-out read, or a response with no body. Its presence does NOT mean
 * the read succeeded: a 403, the 307 to Reddit's HTML viewer or a 200 page all attach their first bytes,
 * and an empty but present body attaches a zero-length array. Whether the bytes are a GIF is gifSize's
 * signature check, and nothing else may treat this field as a verdict.
 */
export type RedditFetch =
  | { ok: true; source: 'embed'; html: string; gifHead?: Uint8Array; caption?: RedditCaptionBytes }
  | { ok: true; source: 'json'; data: unknown; gifHead?: Uint8Array }
  | { ok: false; reason: 'assert_fail' | 'private' }

/**
 * THE BODY SOURCES' RAW ANSWERS, when the embed page carried no body (caption.ts names the three and
 * what was measured about each). Bytes as received, for caption.ts to judge: a 429, a block page or a
 * decoy is still attached, and only the parsers there decide whether it says anything about the post.
 * An absent field is a source that was not asked or did not answer before its deadline.
 */
export type RedditCaptionBytes = { crawler?: string; feed?: string; archive?: string }

/**
 * How long the gif's size may take. Sized on what was measured, not on a guess at Worker latency: 40
 * ranged GETs of the headers of 36 i.redd.it gifs from the Claude Code dev sandbox (2026-10-05; not a
 * Worker, and Worker egress to i.redd.it has NOT been measured) answered in 120 to 425 ms, all 206 with
 * a GIF87a/GIF89a signature. This runs after the embed fetch and inside the head's whole-response budget
 * (worker.ts HTML_DEADLINE_MS, 5000), so its ceiling is spent from the same pot as everything else on a
 * cold first paste, and a slow i.redd.it must never cost the post itself: past this it gives up and the
 * gif goes out at 0x0, which may cost the picture (normalize.ts gifSize) but never the card's text.
 */
const GIF_HEAD_TIMEOUT_MS = 1000

/** The header holds the logical screen size at bytes 6-9, so ten bytes is the whole read. */
const GIF_HEAD_BYTES = 10

/**
 * The first ten bytes of a Reddit gif, or undefined. I/O ONLY: whether they are a GIF, and what size
 * they say, is normalize.ts's gifSize. The url has already passed redditGifUrl's i.redd.it check.
 *
 * WHAT IS SENT, AND WHY EACH PART. Measured 2026-10-05 from the Claude Code dev sandbox (a non-Cloudflare
 * cloud IP behind an HTTPS proxy, not a Worker) against i.redd.it/4gg2f32z3qsh1.gif: `range: bytes=0-9`
 * answers 206 with exactly ten bytes (content-range bytes 0-9/556483), so a 99 MB gif costs ten bytes, not
 * a download. An Accept that lists text/html gets a 307 to www.reddit.com/media (an HTML viewer); an image
 * Accept, `*\/*` or none gets the gif, so this asks for images. THE EXACT HEADERS BELOW were measured as a
 * set, not only their neighbours: this BROWSER_UA with `accept: image/gif,image/*;q=0.8` and the range,
 * 3 of 3 answered 206 image/gif, ten bytes reading GIF89a 320x240, in 144 to 418 ms (same sandbox, same
 * day). `redirect: 'manual'` keeps a redirect from being followed into that page, and the body is read
 * only to the tenth byte and then cancelled, so a server that ignored the Range header still costs ten
 * bytes of reading.
 *
 * WHAT A FAILED READ COSTS, AND WHY IT IS CACHED ANYWAY. Any failure here leaves the gif at 0x0, and per
 * normalize.ts gifSize that may leave Discord drawing NO PICTURE (types.ts posterW, measured on a YouTube
 * poster 2026-07-31; unmeasured for Reddit, whose 0x0 stills embed.ts calls human-verified). That card
 * is then cached like a healthy one, the Post for POST_TTL and the head for RESP_TTL (900 s each, per
 * colo). That is a choice, made with CLAUDE.md's "a degraded card must not be response-cached" in view:
 * that rule is settleMux's `degraded`, which means "incomplete, something is still coming", and nothing
 * is coming here, the same reasoning settleMux gives for not setting it on the over-ceiling and live
 * arms. Marking a failed read uncacheable would also turn a systematic refusal (Worker egress to
 * i.redd.it is unmeasured) into an embed fetch plus up to a second of waiting on EVERY unfurl of every
 * Reddit gif, while what it buys is a re-read inside the 900 s window. And 0x0 is the exact shape
 * Reddit's type:'image' .gif and every Reddit still have shipped in for months. If the post-deploy
 * /_api/v1 check shows 0x0 for the measured post, Worker egress is failing this read, and that is the
 * moment to revisit, not before.
 */
async function readGifHead(url: string): Promise<Uint8Array | undefined> {
  try {
    // NO-RETRY: deliberate. This reads only a SIZE: the post loads either way, a failed read falls back
    // to 0x0, and a second ask would double the failure path's cost (up to two seconds) inside the head's
    // whole-response budget. Bounded by GIF_HEAD_TIMEOUT_MS. See src/fetchretry.ts.
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
    // into the fetch that decides whether a card exists. The entry goes out at 0x0, which may cost the
    // picture in Discord (see WHAT A FAILED READ COSTS above), never the post.
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
 * THE CAPTION LOOKUP'S WHOLE BUDGET, and each source's own ceiling inside it. Measured from a Cloudflare
 * Worker (colo LHR) on 2026-10-11: the crawler page 419 ms, the feed 136 ms, the archive 940 ms, so all
 * three in a row fit with room to spare. It is spent INSIDE getPost, which every head awaits in full
 * before its own HTML_DEADLINE_MS (5000) races begin, on top of the embed fetch (about 500 ms from
 * the same Worker) — so it is kept well under half of that, and a source that would overrun it is not
 * asked at all. Only a post whose page carries no body pays any of it, once per post-cache miss.
 */
const CAPTION_BUDGET_MS = 2000
const CRAWLER_TIMEOUT_MS = 1500
const FEED_TIMEOUT_MS = 800
const ARCHIVE_TIMEOUT_MS = 1500
/** Below this there is no time for a round trip, so the source is not asked. */
const CAPTION_MIN_MS = 100

/**
 * Discord's own crawler identity, because that is who Reddit serves the description to, and who this
 * request is made on behalf of: it only ever runs while a card for Discord is being built or previewed.
 * Twitterbot/1.0 got the identical meta from a Worker the same day; a browser UA gets an 8.4 KB JS
 * challenge and a fake Googlebot a 403 (residential, 2026-10-11).
 */
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
/** Arctic Shift asks its users to be considerate; a name and a way to reach the project is the minimum. */
const ARCHIVE_UA = 'mbedfx.app (embed fixer; +https://github.com/shamu4life/mbedfx)'

/** The response body as text, up to 512 KB (Reddit's block page is ~190 KB; nothing needed is larger). */
async function readTextCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let n = 0
  while (n < 524_288) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    n += value.length
  }
  reader.cancel().catch(() => {})
  const all = new Uint8Array(n)
  let at = 0
  for (const c of chunks) { all.set(c.subarray(0, n - at), at); at += c.length }
  return new TextDecoder().decode(all.subarray(0, n))
}

/** One caption source's body, or undefined on a throw, a timeout or no time left. Never throws. */
async function readSource(url: string, headers: Record<string, string>, ms: number, redirect: 'manual' | 'follow'): Promise<string | undefined> {
  if (ms < CAPTION_MIN_MS) return undefined
  try {
    // NO-RETRY: deliberate. A body source is optional: the post loads without it, a failure only shortens
    // or drops the body, and a second ask would double the failure path inside the caption budget, which
    // getPost spends before the head's own deadline races begin. Bounded by `ms`. See withCaption.
    const res = await fetch(url, { headers, redirect, signal: AbortSignal.timeout(ms) })
    return await readTextCapped(res)
  } catch {
    return undefined
  }
}

/**
 * THE BODY OF A POST WHOSE EMBED PAGE CARRIES NONE, from the sources caption.ts names, asked in its
 * order and only as far as needed: the crawler page always; the feed only when the crawler's text was cut
 * short or the crawler said nothing usable; the archive only when the crawler's text was cut short and the
 * feed did not answer. The bytes ride on the fetch for normalize.ts to judge, the same split gifHead uses.
 *
 * NO-RETRY on all three, deliberately: the post loads either way, a failure only shortens or drops its
 * body, and a second ask would double the failure path's cost inside a head budget that is already the
 * tightest thing about a cold Reddit card. See src/fetchretry.ts.
 *
 * THE ARCHIVE IS A THIRD PARTY, and that was the owner's call (2026-10-11), made knowing the trade: it
 * is a free, single-maintainer service with no terms, no uptime promise and a day-and-a-half outage on
 * 2026-10-09; every post id asked about is sent to it; and its own ingest depends on Reddit's Data API,
 * which Reddit says ends in March 2027. It is asked only when Reddit's own text was cut, and its text is
 * shown only when Reddit's cut text is a prefix of it.
 */
async function withCaption(got: Extract<RedditFetch, { source: 'embed' }>, id: string): Promise<RedditFetch> {
  if (!redditNeedsCaption(got.html)) return got
  const sub = redditEmbedSub(got.html)
  if (!sub) return got
  const until = Date.now() + CAPTION_BUDGET_MS
  const left = (cap: number) => Math.min(cap, until - Date.now())
  const caption: RedditCaptionBytes = {}
  caption.crawler = await readSource(crawlerUrl(sub, id),
    { 'user-agent': CRAWLER_UA, accept: 'text/html' }, left(CRAWLER_TIMEOUT_MS), 'manual')
  const said = caption.crawler === undefined ? { kind: 'unknown' as const } : crawlerCaption(caption.crawler, sub)
  const cut = said.kind === 'body' && said.cut
  if (said.kind === 'unknown' || cut) {
    caption.feed = await readSource(`https://www.reddit.com/by_id/t3_${id}/.rss`,
      { 'user-agent': BROWSER_UA, accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8' },
      left(FEED_TIMEOUT_MS), 'manual')
    if (cut && feedCaption(caption.feed ?? '', id) === null) {
      caption.archive = await readSource(`https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${id}&fields=id,selftext`,
        { 'user-agent': ARCHIVE_UA, accept: 'application/json' }, left(ARCHIVE_TIMEOUT_MS), 'follow')
    }
  }
  return { ...got, caption }
}

/**
 * PRIMARY. `embed.reddit.com/r/{sub}/comments/{id}/`. Resolution is by id, so a placeholder sub still
 * resolves the post — BUT (measured from Workers egress 2026-07-22, and again 2026-10-11) a placeholder
 * gets a STRIPPED render with NO title, author, score or body, while the REAL sub gets the full page.
 * fetchReddit passes the sub the ref carries, `_` when it carries none, and asks again under the page's
 * own canonical sub when that differs. ASSERT ON CONTENT: every id, including bad/deleted, returns HTTP
 * 200, so liveness is the canonical url present and no `/undefined` marker, never status. A thrown fetch
 * is NOT caught (a transport failure is the worker's null, not a Reddit signal).
 */
async function fetchRedditEmbed(ref: Extract<PostRef, { p: 'rd' }>, sub: string): Promise<RedditFetch> {
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
/**
 * `onPage` is told the embed page the moment it is in hand, before the gif read and the caption lookup,
 * which can take two more seconds. The worker uses it to start a link post's video mux that early
 * (liveFetchPost's rd arm); it is optional, synchronous, and a throw from it never reaches the fetch.
 */
export async function fetchReddit(
  ref: Extract<PostRef, { p: 'rd' }>, env: Env, onPage?: (html: string) => void,
): Promise<RedditFetch> {
  if (!POST_ID.test(ref.id)) return { ok: false, reason: 'assert_fail' }
  const asked = ref.sub && SUB.test(ref.sub) ? ref.sub : '_'
  let embed = await fetchRedditEmbed(ref, asked)
  /**
   * ASK AGAIN UNDER THE REAL SUBREDDIT when the page says the post lives elsewhere: a bare /comments/{id}
   * link (asked as `_`), or a wrong sub. The first answer is a stripped render — no title, author, counts
   * or body — and it was being cached under the post's CANONICAL key, because normalize takes the sub
   * from the page: measured in production on 2026-10-11, the ordinary link for r/DeadlockTheGame/
   * comments/1x2xbtq served that degraded card for up to 900 s after anyone in the same colo pasted the
   * bare form. One more embed fetch on bare links only, and the card is the full one either way.
   */
  if (embed.ok && embed.source === 'embed') {
    const real = redditEmbedSub(embed.html)
    if (real && real.toLowerCase() !== asked.toLowerCase()) {
      // A re-ask that throws keeps the first answer: a thinner card, never the failure card a transport
      // error would otherwise become here (askTwice rethrows), which Discord would freeze.
      try {
        const full = await fetchRedditEmbed(ref, real)
        if (full.ok) embed = full
      } catch { /* keep the placeholder render */ }
    }
  }
  if (embed.ok && embed.source === 'embed') {
    try { onPage?.(embed.html) } catch { /* a hook may not cost the post */ }
    return withCaption(await withGifHead(embed), ref.id)
  }
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    const oauth = await fetchRedditOAuth(ref, env)
    if (oauth.ok) return withGifHead(oauth)
    if (oauth.reason === 'private') return oauth
  }
  return embed
}
