import type { PostRef } from '../../types.ts'
import type { Env } from '../../analytics.ts'
import {
  REDDIT_SUB, redditArchiveLink, redditArchiveSub, redditCrosspostNeeds, redditEmbedLink, redditEmbedRefused, redditEmbedSub,
  redditFullRender, redditGate, redditGifUrl, redditNeedsCaption,
} from './normalize.ts'
import { crawlerCaption, feedCaption } from './caption.ts'
import { askTwice } from '../../fetchretry.ts'
import { viaRelay } from './relay.ts'

/**
 * I/O ONLY. Reddit blocks anonymous `.json` from datacenter IPs (verified 2026-07-21: our Workers
 * egress gets a 403 "network security" block page). The way in is `embed.reddit.com` — the host that
 * backs Reddit's official post-embed widget — which serves the full post server-rendered and is NOT
 * IP-blocked from our egress (verified). That is the PRIMARY, credential-free path. An OAuth app-only
 * token (oauth.reddit.com) stays as a FALLBACK for when the Reddit app creds are set, but Reddit gates
 * app creation behind the Responsible Builder Policy so that path rarely runs.
 *
 * SINCE 2026-10-22 embed.reddit.com REFUSES OUR EGRESS TOO (403, "You've been blocked by network
 * security.", measured from a Worker 2026-10-25), and every Reddit card was the failure card until the
 * archive path (fetchRedditArchive below; normalize.ts says what it reads and why it is safe). The
 * embed page is still asked first, so the full render comes back by itself if Reddit lifts the block.
 *
 * WITH THE OWNER'S RELAY CONFIGURED (relay.ts; REDDIT_RELAY_URL and REDDIT_RELAY_KEY), the embed page, the
 * archive and the feed are asked from a Google Cloud Run address instead, and every one of them falls back
 * to the direct request below when the relay cannot answer. Reddit's crawler page is always asked directly.
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
  | { ok: true; source: 'embed'; html: string; gifHead?: Uint8Array; caption?: RedditCaptionBytes; parent?: string }
  | { ok: true; source: 'archive'; id: string; archive: string; crawler: string; gifHead?: Uint8Array }
  | { ok: true; source: 'json'; data: unknown; gifHead?: Uint8Array }
  // `refused`: embed.reddit.com refused the request rather than answering about the post (the worker counts it).
  | { ok: false; reason: 'assert_fail' | 'private'; refused?: true }

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

/** The first bytes of the post's gif when it is one (a gif post or a crosspost of one), else undefined. Never throws. */
async function gifHeadOf(got: Extract<RedditFetch, { ok: true }>): Promise<Uint8Array | undefined> {
  const url = redditGifUrl(got)
  return url ? readGifHead(url) : undefined
}

/** A successful fetch, plus its gif's header when the post is one. Never turns a success into a failure. */
async function withGifHead<T extends Extract<RedditFetch, { ok: true }>>(got: T): Promise<T> {
  const gifHead = await gifHeadOf(got)
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

/**
 * The response body as text, up to `cap` bytes: 512 KB by default (Reddit's block page is ~190 KB), more for an
 * archive record, which runs to 260 KB on a heavily awarded post and whose JSON is worthless cut short.
 */
async function readTextCapped(res: Response, cap = 524_288): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let n = 0
  while (n < cap) {
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

/**
 * THE ARCHIVE PATH'S WHOLE BUDGET, and each request's ceiling inside it. Measured from a Worker (colo IAD,
 * 2026-10-25): the archive 866 ms, the crawler page 107 ms (and 419 ms from LHR on 2026-10-11, caption.ts).
 * Spent inside getPost, before the head's own HTML_DEADLINE_MS (5000) races begin, like the caption budget it
 * replaces on this path (the feed it would ask is blocked too), so the ceilings sit at about three times
 * what was measured and no more. A bare link pays the two in turn, so the budget covers both.
 */
const ARCHIVE_PATH_BUDGET_MS = 3000
const ARCHIVE_POST_TIMEOUT_MS = 2500
const CRAWLER_POST_TIMEOUT_MS = 1500
const ARCHIVE_MAX_BYTES = 4 * 1024 * 1024

/**
 * One required read of the archive path, or undefined on a throw, a timeout or no time left. askTwice: unlike the
 * caption sources, the card does not exist without this answer, so a refused first ask gets the one more ask
 * every platform fetcher gets (src/fetchretry.ts).
 */
async function readRequired(
  url: string, headers: Record<string, string>, ms: number, redirect: 'manual' | 'follow', cap?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (ms < CAPTION_MIN_MS) return undefined
  try {
    const res = await askTwice(url, { headers, redirect, signal: AbortSignal.timeout(ms) }, fetchImpl)
    return await readTextCapped(res, cap)
  } catch {
    return undefined
  }
}

/**
 * THE ARCHIVE'S ANSWER IS KEPT, because from this egress asking it is a coin flip. Measured 2026-10-26, the
 * hour after the archive path shipped: production's /_api/v1 loaded 7 of 15 uncached posts (00:03 UTC), a
 * Worker replaying the same 15 a minute later got `429 {"error":"Too many requests"}` on all 15, with
 * x-ratelimit-reset 20 to 25 s and the reset on the minute, and the next minute's three asks all answered 200.
 * The scheduled check at 00:00 UTC failed too. The archive allows "a couple requests per second" to an address
 * (its API README), and every probe here, from IAD, EWR and LHR, reached it as the same address,
 * 2a06:98c0:3600::103, which is Cloudflare's own egress to a Cloudflare-proxied site: that allowance is shared
 * with every Worker that asks it. PullPush, the other Reddit archive, answered the same egress 429 as well.
 *
 * So one good answer per post is made to last. Everything the card takes from the record is fixed once the post
 * exists (date, title, subreddit, media urls; normalize.ts says what is read live instead), and Reddit's live
 * page still vouches for the post on every render, so a kept record cannot bring back a post Reddit removed.
 * R2, not the per-colo Cache API, because the point is that a post read once anywhere is never asked about
 * again. The bucket's expire-60d lifecycle rule (wrangler.jsonc) is the record's only TTL, and that is the
 * right one: after it the post costs one more ask. Kept as received, the bytes normalize.ts already reads.
 * This does not make a never-seen post's first card reliable; only an egress the archive does not share with
 * every Worker would, and that is the owner's decision (CLAUDE.md).
 */
const archiveKey = (id: string) => `rd-archive/${id}.json`

async function keptArchive(env: Env, id: string): Promise<string | undefined> {
  try {
    const obj = await env.MEDIA_CACHE?.get(archiveKey(id))
    const text = obj ? await obj.text() : undefined
    return text !== undefined && redditArchiveSub(text, id) ? text : undefined
  } catch {
    return undefined
  }
}

/** Only an answer that holds this post's record is kept: a 429, a block page or an empty `data` is not. */
async function keepArchive(env: Env, id: string, text: string): Promise<void> {
  try {
    await env.MEDIA_CACHE?.put(archiveKey(id), text, { httpMetadata: { contentType: 'application/json' } })
  } catch { /* a write that fails costs the next render one more ask, never this card */ }
}

/**
 * WHEN EMBED.REDDIT.COM REFUSED US: the Arctic Shift archive's record and Reddit's crawler page, which
 * normalize.ts combines (its "Archive path" section says what each carries, and why a post renders only when
 * Reddit's live title is the archived one). The archive is asked for the whole record because its `fields=`
 * filter refuses every media field (preview, media_metadata, gallery_data, is_video and others answered 400,
 * 2026-10-25). It is the endpoint caption.ts already asks for a body (there with `fields=id,selftext`), so it
 * names the same third party and sends it the same id. Measured that day from the Claude Code dev sandbox,
 * not a Worker: one id per request, 4 to 260 KB, 0.46 to 1.43 s. The Worker read in ARCHIVE_PATH_BUDGET_MS's
 * note answered 200 with the same record shape.
 *
 * Asked side by side when the link names its subreddit, which a pasted link almost always does. A bare
 * /comments/{id}/ link waits for the archive to name it, because the crawler page of a bare link is not the
 * post's (a 380 KB generic page, measured from the Worker). A wrong subreddit needs no second ask: Reddit
 * still answers the post's own page under it, and only the title's suffix names the wrong one.
 *
 * Never throws: a transport failure here is no evidence about the post, and the card is the failure card
 * either way.
 */
async function fetchRedditArchive(ref: Extract<PostRef, { p: 'rd' }>, asked: string, env: Env): Promise<RedditFetch> {
  const until = Date.now() + ARCHIVE_PATH_BUDGET_MS
  const left = (cap: number) => Math.min(cap, until - Date.now())
  const crawl = (sub: string) => readRequired(crawlerUrl(sub, ref.id),
    { 'user-agent': CRAWLER_UA, accept: 'text/html' }, left(CRAWLER_POST_TIMEOUT_MS), 'manual')
  const early = asked !== '_' ? crawl(asked) : null
  const kept = await keptArchive(env, ref.id)
  const archive = kept ?? await readRequired(`https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${ref.id}`,
    { 'user-agent': ARCHIVE_UA, accept: 'application/json' }, left(ARCHIVE_POST_TIMEOUT_MS), 'follow', ARCHIVE_MAX_BYTES,
    viaRelay(env))
  const sub = archive === undefined ? null : redditArchiveSub(archive, ref.id)
  if (archive === undefined || !sub) return { ok: false, reason: 'assert_fail', refused: true }
  if (kept === undefined) await keepArchive(env, ref.id, archive)
  const crawler = await (early ?? crawl(sub))
  if (crawler === undefined) return { ok: false, reason: 'assert_fail', refused: true }
  return { ok: true, source: 'archive', id: ref.id, archive, crawler }
}

/** One caption source's body, or undefined on a throw, a timeout or no time left. Never throws. */
async function readSource(
  url: string, headers: Record<string, string>, ms: number, redirect: 'manual' | 'follow', fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (ms < CAPTION_MIN_MS) return undefined
  try {
    // NO-RETRY: deliberate. A body source is optional: the post loads without it, a failure only shortens
    // or drops the body, and a second ask would double the failure path inside the caption budget, which
    // getPost spends before the head's own deadline races begin. Bounded by `ms`. See withCaption.
    const res = await fetchImpl(url, { headers, redirect, signal: AbortSignal.timeout(ms) })
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
 *
 * `wantPoster`: the post is a crosspost of a Reddit video, whose poster is the crawler page's og:image
 * (normalize.ts crosspostMedia). That page is then read even when no body is wanted, and nothing else is.
 */
async function withCaption(
  got: Extract<RedditFetch, { source: 'embed' }>, id: string, env: Env, wantPoster = false,
): Promise<Extract<RedditFetch, { source: 'embed' }>> {
  const needed = redditNeedsCaption(got.html)
  if (!needed && !wantPoster) return got
  const sub = redditEmbedSub(got.html)
  if (!sub) return got
  const until = Date.now() + CAPTION_BUDGET_MS
  const left = (cap: number) => Math.min(cap, until - Date.now())
  const caption: RedditCaptionBytes = {}
  caption.crawler = await readSource(crawlerUrl(sub, id),
    { 'user-agent': CRAWLER_UA, accept: 'text/html' }, left(CRAWLER_TIMEOUT_MS), 'manual')
  if (!needed) return { ...got, caption }
  const said = caption.crawler === undefined ? { kind: 'unknown' as const } : crawlerCaption(caption.crawler, sub)
  const cut = said.kind === 'body' && said.cut
  if (said.kind === 'unknown' || cut) {
    caption.feed = await readSource(`https://www.reddit.com/by_id/t3_${id}/.rss`,
      { 'user-agent': BROWSER_UA, accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8' },
      left(FEED_TIMEOUT_MS), 'manual', viaRelay(env))
    if (cut && feedCaption(caption.feed ?? '', id) === null) {
      caption.archive = await readSource(`https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${id}&fields=id,selftext`,
        { 'user-agent': ARCHIVE_UA, accept: 'application/json' }, left(ARCHIVE_TIMEOUT_MS), 'follow', viaRelay(env))
    }
  }
  return { ...got, caption }
}

/**
 * A GALLERY CROSSPOST'S SLIDES LIVE ON ITS PARENT'S PAGE, which this reads (normalize.ts crosspostMedia). The
 * crosspost names its parent only as `/gallery/{id}`, with no subreddit, so the parent is asked as the `_`
 * placeholder first, whose canonical names the subreddit, and then under it, because the placeholder carries no
 * carousel (residential, 2026-10-11: r/_/comments/1x2epoi named AskElectricians, whose page held 2 slides; 6 of 6
 * gallery crossposts named their parent this way). Run beside the gif and caption reads, so a cold card waits for
 * the slower of the two rather than for both. NOT measured from a Worker, though both are the requests fetchReddit
 * already makes for a bare /comments/{id} link.
 *
 * NO-RETRY, like the caption sources: the crosspost loads without its slides, and a second ask would double the
 * failure path inside the same head budget. Bounded by PARENT_BUDGET_MS; never throws.
 */
const PARENT_BUDGET_MS = 2000

async function galleryParent(id: string, env: Env): Promise<string | undefined> {
  if (!POST_ID.test(id)) return undefined
  const until = Date.now() + PARENT_BUDGET_MS
  const page = async (sub: string): Promise<string | undefined> => {
    const ms = until - Date.now()
    if (ms < CAPTION_MIN_MS) return undefined
    try {
      // NO-RETRY: deliberate. The slides are optional (the crosspost loads without them), and a second ask
      // would double the failure path inside the head budget the caption lookup spends beside it.
      const res = await viaRelay(env)(`https://embed.reddit.com/r/${sub}/comments/${id}/`, {
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(ms),
      })
      return await readTextCapped(res)
    } catch {
      return undefined
    }
  }
  const first = await page('_')
  if (!first) return undefined
  if (redditFullRender(first)) return first
  const sub = redditEmbedSub(first)
  if (!sub) return undefined
  const full = await page(sub)
  return full && redditFullRender(full) ? full : undefined
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
async function fetchRedditEmbed(ref: Extract<PostRef, { p: 'rd' }>, sub: string, env: Env): Promise<RedditFetch> {
  const res = await askTwice(`https://embed.reddit.com/r/${sub}/comments/${encodeURIComponent(ref.id)}/`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
    redirect: 'follow',
  }, viaRelay(env))
  const html = await res.text()
  if (/id="canonical-url-updater"/.test(html) && !/\/undefined"/.test(html)) {
    return { ok: true, source: 'embed', html }
  }
  return { ok: false, reason: 'assert_fail', ...(redditEmbedRefused(res.status, html) ? { refused: true as const } : {}) }
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
 * embed first (credential-free and rich, when Reddit answers it); OAuth only if the app creds are set,
 * which they usually are not; the archive path when the embed page was refused. A thrown embed fetch is
 * NOT caught — worker.ts treats a thrown live fetch as null. A success that is a Reddit gif also carries
 * its header (withGifHead), whichever path produced it, so every render sizes the gif the same way.
 */
/**
 * `onLink` is told a link post's link the moment the post's page names it, before the gif read and the
 * caption lookup, which can take two more seconds. The worker uses it to start the linked video's mux that
 * early (liveFetchPost's rd arm); it is optional, synchronous, and a throw from it never reaches the fetch.
 */
export async function fetchReddit(
  ref: Extract<PostRef, { p: 'rd' }>, env: Env, onLink?: (link: string) => void,
): Promise<RedditFetch> {
  const tell = (link: string | undefined) => {
    try { if (link) onLink?.(link) } catch { /* a hook may not cost the post */ }
  }
  if (!POST_ID.test(ref.id)) return { ok: false, reason: 'assert_fail' }
  const asked = ref.sub && SUB.test(ref.sub) ? ref.sub : '_'
  let embed = await fetchRedditEmbed(ref, asked, env)
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
        const full = await fetchRedditEmbed(ref, real, env)
        if (full.ok) embed = full
      } catch { /* keep the placeholder render */ }
    }
  }
  if (embed.ok && embed.source === 'embed') {
    tell(redditEmbedLink(embed.html))
    // The gif's size, the caption (with a crosspost video's poster, which rides on the same crawler page) and a
    // gallery crosspost's parent are independent reads, so they run side by side and a cold card waits for the
    // slowest of them, not their sum: a gif post took GIF_HEAD_TIMEOUT_MS + CAPTION_BUDGET_MS, 3.0 s, at worst
    // when the two ran in turn (review, 2026-10-11).
    const needs = redditCrosspostNeeds(embed.html)
    const [gifHead, got, parent] = await Promise.all([
      gifHeadOf(embed),
      withCaption(embed, ref.id, env, needs !== null && 'poster' in needs),
      needs && 'gallery' in needs ? galleryParent(needs.gallery, env) : Promise.resolve(undefined),
    ])
    return { ...got, ...(gifHead ? { gifHead } : {}), ...(parent ? { parent } : {}) }
  }
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    const oauth = await fetchRedditOAuth(ref, env)
    if (oauth.ok) return withGifHead(oauth)
    if (oauth.reason === 'private') return oauth
  }
  // Only a REFUSAL reaches the archive. A page that says the post is not there is Reddit's answer
  // (normalize.ts redditEmbedRefused), and the archive is never asked to overrule it.
  if (!embed.ok && embed.refused) {
    const arch = await fetchRedditArchive(ref, asked, env)
    if (!arch.ok) return arch
    tell(redditArchiveLink(arch))
    return withGifHead(arch)
  }
  return embed
}
