import type { Media, Post, PostRef } from '../../types.ts'
import { decodeEntities, redditHtmlToText, redditMarkdownToText, SPOILER_MARK } from './body.ts'
import { archiveCaption, crawlerCaption, feedCaption, pickCaption } from './caption.ts'

type Any = Record<string, any>

/**
 * Pure: Reddit post data -> Post. Two sources, dispatched by `source`:
 *
 *  - 'embed' (PRIMARY): the `embed.reddit.com/r/{sub}/comments/{id}/` HTML, which is credential-free
 *    and — unlike www.reddit.com/.json — NOT IP-blocked from Workers egress. Rich: title, author,
 *    subreddit, score, timestamp, nsfw, image/gif/gallery/video-cover/selftext.
 *  - 'json' (FALLBACK): the OAuth listing from oauth.reddit.com, used only if the Reddit app creds are
 *    set. Reddit gates app creation behind the Responsible Builder Policy, so this rarely runs; it
 *    stays as a richer path for if that ever opens up.
 *
 * No I/O — testable against captured HTML/JSON with no network and no credentials.
 */

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '')

/**
 * A STORAGE BOUND, NOT THE CARD'S CUT. Reddit selftext runs to tens of thousands of characters, and this
 * value is cached and published by /_api/v1, so it is bounded here; what a CARD shows is render/text.ts's
 * clampText (500 characters and 10 lines on every platform since 2026-10-11).
 *
 * It used to be 500 and was the card's cut too: a long body pushed `❤️ 💬` past Discord's content preview
 * and a text post showed no counts (reported 2026-07-22). clampText's line cap is what protects the counts
 * row now, for every platform at once, so this no longer has to.
 */
const BODY_PREVIEW = 4000
function capBody(body: string): string {
  if (body.length <= BODY_PREVIEW) return body
  const slice = body.slice(0, BODY_PREVIEW)
  const sp = slice.lastIndexOf(' ')
  return `${(sp > BODY_PREVIEW * 0.6 ? slice.slice(0, sp) : slice).trimEnd()}…`
}

/** `ive_found_a_few_funny_memories` -> `Ive found a few funny memories` — the slug-derived fallback title. */
function slugToTitle(slug: string | undefined): string {
  if (!slug) return ''
  let t: string
  try { t = decodeURIComponent(slug) } catch { t = slug }
  t = t.replace(/_/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''
}

// ============================================================================
// embed.reddit.com HTML path (PRIMARY)
// ============================================================================

/**
 * The `<shreddit-screenview-data data="{…}">` JSON — the metadata backbone, present on every live and
 * removed post. Entity-decoded then parsed; returns the `post` object ({id, url, type,
 * created_timestamp (ms), nsfw}) or null.
 */
function screenview(html: string): Any | null {
  const m = html.match(/<shreddit-screenview-data data="([^"]*)"/)
  if (!m) return null
  try { return (JSON.parse(decodeEntities(m[1])) as Any)?.post ?? null } catch { return null }
}

const CANONICAL = /id="canonical-url-updater"\s+value="(https:\/\/www\.reddit\.com\/r\/([^/]+)\/comments\/([^/]+)[^"]*)"/

/**
 * THE BODY'S HTML: the inside of `t3_{id}-post-rtjson-content`, scanned to its BALANCED closing div. The
 * lazy match that preceded this stops at the first `</div>`; no measured body nests one (inline images
 * are `<figure>`, tables and lists carry no div; 2026-10-11, residential and Worker), but a scan costs
 * nothing and a nested div would otherwise end a body mid-sentence without a sign.
 */
function rtjsonInner(html: string): string | null {
  const open = /<div id="t3_[a-z0-9]+-post-rtjson-content"[^>]*>/.exec(html)
  if (!open) return null
  const re = /<div\b|<\/div>/gi
  re.lastIndex = open.index + open[0].length
  let depth = 1
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].toLowerCase() === '</div>' ? -1 : 1
    if (depth === 0) return html.slice(open.index + open[0].length, m.index)
  }
  return null
}

/**
 * THE SUBREDDIT THIS PAGE SAYS THE POST IS IN, from its canonical url. Read before a second fetch, so
 * fetch.ts can re-ask with the REAL sub when it asked with the `_` placeholder (a bare /comments/{id}
 * link) or a wrong one, and so the crawler page is asked under the right path.
 */
export function redditEmbedSub(html: string): string | null {
  const c = CANONICAL.exec(html)
  return c && /^[A-Za-z0-9_]+$/.test(c[2]) ? c[2] : null
}

/**
 * THE PAGE HOLDS A FULL RENDER: the post's title element. A placeholder render (requested as /r/_/) has
 * none, and neither its author, its counts nor its body (measured from a Worker, 2026-10-11:
 * /r/_/comments/8xq8ac/ kept the screenview type and dropped the rtjson body, title and author).
 */
export function redditFullRender(html: string): boolean {
  return /<h1[^>]*\bline-clamp-3\b/.test(html) || /<shreddit-embed-title[^>]*>/.test(html)
}

/**
 * THE BUTTON REDDIT DRAWS OVER A POST IT BLURS. The same element serves two overlays: "This post may contain
 * spoilers." and "This post contains mature or adult content." (2026-10-11, embed.reddit.com from a
 * residential IP with fetch.ts's BROWSER_UA, NOT a Worker: 14 of 14 spoiler-tagged pages of every type
 * (text, multi_media, image, gallery, video, link, crosspost) and 3 of 3 NSFW pages carried it; 13 of 13
 * pages that were neither did not). The page's own `nsfw` is what tells the two apart: false on all 14
 * spoiler pages, true on all 3 NSFW ones. The overlay's English sentence would also tell them apart, and is
 * not read, so a localised page cannot change the answer.
 */
const BLUR_BUTTON = /<shreddit-embed-spoiler-button\b/

/**
 * THE POST IS SPOILER-TAGGED: blurred, and not for being adult. A post that is both reads as NSFW only (its
 * overlay names the adult content), so it keeps the `[sensitive]` label and its body, the same as before.
 * Arctic Shift's `spoiler` flag disagreed with the live page twice in that sample (one tag added and one
 * removed after the archive read the post), which is why the page decides.
 */
function spoilerTagged(html: string, post: Any | null): boolean {
  return BLUR_BUTTON.test(html) && post?.nsfw !== true
}

/**
 * WHETHER THE BODY HAS TO BE ASKED FOR ELSEWHERE (caption.ts): a live post whose page carries no rtjson
 * body. That is every picture, gallery, video, gif, link and crosspost post (0 of 72 with a body carried
 * it on embed.reddit.com, 2026-10-11), and a text post only when the render is a placeholder. A text post
 * in a full render with no rtjson is a title-only post and is not asked about.
 *
 * NEVER FOR A SPOILER-TAGGED POST: its body is replaced by `[spoiler]` whatever it says (buildFromEmbed), so
 * the three requests, one of them rationed to a request a minute, would fetch text nobody is shown.
 */
export function redditNeedsCaption(html: string): boolean {
  if (!CANONICAL.test(html) || /\/undefined"/.test(html) || html.includes('This post has been deleted')) return false
  if (rtjsonInner(html) !== null) return false
  const post = screenview(html)
  if (typeof post?.type !== 'string' || spoilerTagged(html, post)) return false
  return post.type !== 'text' || !redditFullRender(html)
}

/** Hosts whose urls are Reddit's own: a link to one is a Reddit post or Reddit media, never delegated. */
const REDDIT_HOST = /(?:^|\.)(?:reddit\.com|redd\.it|redditmedia\.com|redditstatic\.com)$/i

/**
 * THE URL A LINK POST POINTS AT, or undefined. Read from the screenview's `url`, which is byte-identical
 * to the url the poster submitted on 37 of 42 measured link posts (youtu.be, `si=`, `t=`, http: all kept;
 * 2026-10-11). The other five were moderator removals, whose url Reddit rewrites to the post's own
 * permalink + `/removed_by_moderator/`: refused here by host, so a removed link post delegates nothing.
 *
 * `crosspost` too: a crosspost's url is its parent's destination (3 of 3 measured), so a crosspost of a
 * YouTube link carries the YouTube url. http(s) only; nothing else is a link a card can name.
 */
/** The link a page's post points at (linkOf), read straight off the embed page, for the worker's early prewarm. */
export function redditEmbedLink(html: string): string | undefined {
  const post = screenview(html)
  return post ? linkOf(post.type, post.url) : undefined
}

function linkOf(type: unknown, url: unknown): string | undefined {
  if ((type !== 'link' && type !== 'crosspost') || typeof url !== 'string') return undefined
  let u: URL
  try { u = new URL(url) } catch { return undefined }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || REDDIT_HOST.test(u.hostname)) return undefined
  return url
}

/**
 * THE ORIGINAL .gif OF A REDDIT-HOSTED ANIMATED POST, exactly as Reddit spells it: `https://i.redd.it/`,
 * one lowercase base36 id, `.gif`, nothing after it. The url reaches a Location header on our origin, so
 * it is validated the way the gallery path below rebuilds i.redd.it urls, host and path both, and
 * anything looser is not a gif this file will vouch for.
 *
 * Tight on purpose and measured, not guessed: 35 of 36 type:'gif' posts read from r/gifs, r/forsen,
 * r/reactiongifs and r/HighQualityGifs on 2026-10-05 carry exactly this shape in the screenview's
 * `url`, and the 36th is a v.redd.it video (the video branch's). WHERE: the Claude Code dev sandbox (a
 * non-Cloudflare cloud IP behind an HTTPS proxy), not a Worker. A type:'gif' post this misses renders
 * no media, which is the same answer in every render of the post and so poisons nothing.
 */
const REDDIT_GIF = /^https:\/\/i\.redd\.it\/[a-z0-9]+\.gif$/

/**
 * THE GIF'S OWN SIZE, read off the first ten bytes of the file, which fetch.ts fetches with a ranged GET
 * and hands over untouched. A GIF opens with `GIF87a` or `GIF89a` and then its logical screen width and
 * height, two little-endian 16-bit numbers (bytes 6-9). Anything else, including a short read, an HTML
 * page or no bytes at all, is 0x0, which every renderer already reads as "unknown".
 *
 * ASSERT ON CONTENT: the signature is the check, never the status the bytes came with. i.redd.it answers
 * a request whose Accept lists text/html with a 307 to an HTML viewer (measured 2026-10-05 from the
 * Claude Code dev sandbox, not a Worker), and a 200 with a page in it would read as a plausible size if
 * only the numbers were taken.
 *
 * WHY READ A SIZE AT ALL, when Reddit's type:'image' .gif shipped 0x0 for months. Because 0x0 may draw
 * NOTHING. mastodon.ts's originalMeta omits `meta.original` on 0x0, and types.ts posterW records,
 * measured 2026-07-31 on yt:Jky5ZXI0axc, that Discord drew no picture at all for an IMAGE attachment
 * without it. embed.ts's dimTags note says the opposite for Reddit: its 0x0 is "human-verified", and
 * every Reddit still goes out as an image attachment with no `meta.original`. Those two records
 * conflict, nothing in this change settles which is right for Reddit, and no Discord test was run. The
 * read is the inexpensive way not to depend on the answer (ten bytes; 120 to 425 ms from the sandbox),
 * and the true size is also what /_api/v1 publishes. So do not delete it as unnecessary on the strength
 * of the type:'image' precedent: if types.ts is right, a sizeless gif is a card with no picture. The
 * same reasoning is why a FAILED read is not harmless, and fetch.ts readGifHead says what that costs
 * and why it is still cached like a healthy card.
 *
 * WHY THE HEADER AND NOT THE PLAYER. #98 sized the mp4 rendition from the `width=` in its src over the
 * `--aspect-ratio` of the element wrapping the player. On the 35 gifs above that wrapper reads 1 for every
 * portrait one (800x1422, 640x1138, 1050x1400, 148x269 among them), so it would have published 800x800
 * for a 800x1422 gif. The header is the file's own statement of its size.
 */
export function gifSize(head: unknown): { w: number; h: number } {
  const b = head instanceof Uint8Array || Array.isArray(head) ? head : null
  if (!b || b.length < 10) return { w: 0, h: 0 }
  const sig = String.fromCharCode(...Array.from(b.slice(0, 6), x => Number(x) & 0xff))
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return { w: 0, h: 0 }
  const w = (Number(b[6]) & 0xff) | ((Number(b[7]) & 0xff) << 8)
  const h = (Number(b[8]) & 0xff) | ((Number(b[9]) & 0xff) << 8)
  return w > 0 && h > 0 ? { w, h } : { w: 0, h: 0 }
}

/**
 * THE ONE READING OF "THIS POST IS A REDDIT GIF", shared by every render that can see the post and by
 * fetch.ts, which asks it which file to read the size of. The url it returns is the url media[0] will be.
 *
 * It looks at the post's `url` and `type` and nothing else, and that restriction is the design. Renders of
 * a post share post cache keys (the OAuth render lands under the same canonical key as the full one; a
 * placeholder render of a bare /comments/{id} link, since 2026-10-11, only under the bare key it was asked
 * under, and only when fetch.ts's re-ask under the real sub failed), and the
 * /_media/{key}/0 url that cache answers has already been handed to Discord, whose media proxy caches per
 * url. So index 0 must be the SAME KIND in every render, or a url Discord holds as one kind serves the
 * other: the sticky poisoned-url defect worker.ts's notReady() exists for. `url` and `type` are present in
 * every render seen: the screenview of the placeholder render carries the same `url` and `type: "gif"` as
 * the full one for r/forsen/comments/1wuh1g1 and only lacks the player (measured 2026-10-05 from the
 * Claude Code dev sandbox, NOT a Worker), and the OAuth listing's `url` is the same field. Worker egress is
 * known to get a different, stripped placeholder render (fetch.ts, measured 2026-07-22), and whether that
 * one carries `url` and `type` has not been measured. If it does not, this returns null there and that
 * render has no media: index 0 absent, a 404, which is not a second KIND and so poisons nothing. A probe
 * that can fail transiently never decides this; it only sizes the entry.
 *
 * A type:'image' post with an i.redd.it .gif has always been kind:'gif' (the branch below it); it shares
 * this reading so it gets the same size, and its kind and url are exactly what they were.
 */
export function redditGifUrl(raw: unknown): string | null {
  const r = raw as Any
  if (r?.source === 'embed') {
    const post = screenview(typeof r.html === 'string' ? r.html : '')
    const url = typeof post?.url === 'string' ? post.url : ''
    return (post?.type === 'gif' || post?.type === 'image') && REDDIT_GIF.test(url) ? url : null
  }
  const listing = r?.source === 'json' ? r.data : r
  const d = (Array.isArray(listing) ? listing[0] : listing)?.data?.children?.[0]?.data
  return typeof d?.url === 'string' && REDDIT_GIF.test(d.url) ? d.url : null
}

/** The gif entry itself, built ONCE so the embed and OAuth renders cannot spell it differently. */
function gifEntry(url: string, head: unknown): Media {
  return { kind: 'gif', url, ...gifSize(head) }
}

/**
 * Media by post type (from the embed HTML + screenview). VIDEO is a `remux` video: the unsigned
 * {v.redd.it base}/HLSPlaylist.m3u8, which the /_media/ route hands to the media-resolver container
 * to mux to a playable MP4, with the external-preview cover as the poster. WITHOUT the container,
 * worker.ts's withResolver degrades it to that cover still, exactly as it rendered before playback
 * existed. Verified live 2026-07-22: a v.redd.it HLS muxed to a 13MB progressive MP4 through the
 * container.
 *
 * WHY THE HLS MASTER AND NOT A FILE. This used to say the legacy DASH_{q}.mp4 files 404, without
 * saying where that was measured. Measured 2026-10-04 from the dev sandbox (not a Worker), they do
 * not: DASHPlaylist.mpd answered 200 on 10 of 10 posts and its track files 206. They are still not
 * worth reading, because DASH puts video and audio in separate files, so they need the same mux. The
 * master is the one source present for every live post (21 of 21, 2018 to 2026, same sandbox) and it
 * is unsigned and never expires, which is what lets it sit in the Post cache, the response cache and
 * the alarm's durable source. The embed page's newer `packaged-media-json` holds ready-muxed MP4s,
 * but it was missing on the first fetch for 6 of 23 posts, and every url seen was signed to expire at
 * the next UTC midnight (one day observed), so a cached card could hand Discord a dead link.
 *
 * WHICH 2024-25 VIDEOS FAILED, AND WHERE THE FIX LIVES. Uploads from about 2024-05 to 2025-11 put
 * MPEG-TS audio in files named .aac, and the container's ffmpeg refused that until 2026-10-04.
 * Nothing in this url or the playlist text tells those posts apart, so the fix is in the container
 * (container/server.py, REDDIT_HLS_HOST), not here.
 */
function redditEmbedMedia(html: string, post: Any, gifHead: unknown): Media[] {
  const type = post?.type
  const url = typeof post?.url === 'string' ? post.url : ''

  /**
   * A REDDIT GIF IS ITS ORIGINAL .gif, kind:'gif', so that Discord LOOPS it. Since 2026-10-05.
   *
   * WHY NOT REDDIT'S MP4 RENDITION, which #98 shipped the day before (r/forsen/comments/1wuh1g1, reported
   * as text only; Reddit labels these posts `type: "gif"` and no branch knew the word). The rendition goes
   * out as a VIDEO attachment, and Discord draws a video with a play button and no loop. An animated IMAGE
   * attachment is what Discord is expected to loop; for a .gif that is EXPECTED, NOT MEASURED, and the
   * owner's paste after deploy is the check. FxEmbed is the nearest precedent and it is narrower than it
   * looks: for Twitter's GIFs it sends a Mastodon `image` of an animated transcode, never `gifv`, and for
   * Discordbot that transcode is `.webp` unless the link carries `?gif=` (mastodon.ts ATTACHMENT_TYPE has
   * the source references). Reddit keeps the original, so no transcode is needed: the screenview's `url`
   * IS the .gif. The owner chose the loop over the smaller file, for Reddit only; Twitter's animated_gif
   * stays a video (twitter/normalize.ts).
   *
   * THE COST, MEASURED ON 36 GIFS (2026-10-05, the Claude Code dev sandbox, not a Worker): the originals
   * run from 0.4 MB to 99.1 MB, median 11.9 MB, 19 of them over 10 MB. Five of their mp4 renditions were
   * checked and ran 0.025 to 4.1 MB (r/forsen's 556 KB .gif against a 25 KB mp4; a 99 MB one against
   * 3.3 MB). Whether Discord draws a GIF that large at all is NOT MEASURED. It cannot be decided here by
   * size either: the size comes from a probe that can fail, and a kind chosen by a probe would differ
   * between two renders of one post (see redditGifUrl).
   *
   * THE PLACEHOLDER AND OAUTH RENDERS EMIT THE SAME ENTRY, which is what lets this be safe at all: every
   * render reads it off `url` and `type` (redditGifUrl), so index 0 is a gif in all of them. #98's rule,
   * "a gif post is its player or nothing", existed because the placeholder render has no player and an
   * image there would sit behind a url the full render promised as a video. With no video in any render
   * that hazard is gone, and the transition from #98's video is worker.ts's job (the media arm's two
   * extension guards, `asVideo` and `asImage`, and mastodon.ts's `.gif` spelling of the attachment url).
   *
   * NO POSTER, deliberately: a GIF is its own picture, and mastodon.ts's image branch uses the url itself
   * as preview_url. THE SIZE comes from the file's own header (gifSize), or 0x0 when that read failed,
   * which may cost the picture and not only the number (gifSize says why).
   */
  if ((type === 'gif' || type === 'image') && REDDIT_GIF.test(url)) return [gifEntry(url, gifHead)]
  if (type === 'image' && /^https:\/\/i\.redd\.it\//.test(url)) {
    // A true .gif animates as an image; Discord plays a gif og:image. Everything else is a still.
    return [{ kind: /\.gif(?:\?|$)/i.test(url) ? 'gif' : 'image', url, w: 0, h: 0 }]
  }
  if (type === 'gallery') {
    const car = html.match(/<gallery-carousel[^>]*>([\s\S]*?)<\/gallery-carousel>/)
    if (car) {
      // Reconstruct the CLEAN, unsigned, permanent full-res i.redd.it url from the `-v0-{mediaid}.{ext}`
      // in each preview src, rather than passing the signed/expiring preview.redd.it urls through.
      const ids = [...new Set([...car[1].matchAll(/-v0-([a-z0-9]+)\.(\w+)(?:\?|")/g)].map(x => `${x[1]}.${x[2]}`))]
      return ids.map(x => ({ kind: 'image' as const, url: `https://i.redd.it/${x}`, w: 0, h: 0 }))
    }
  }
  /**
   * A MULTI_MEDIA POST'S PICTURES ARE INSIDE ITS BODY, as `<figure class="rte-media"><a><img src=
   * "https://preview.redd.it/{slug}-v0-{mediaid}.{ext}?…">` (r/DeadlockTheGame/comments/1x2wg7e, measured
   * from a Worker 2026-10-11). Rebuilt into the same clean, unsigned i.redd.it url the gallery branch
   * makes, which answered 206 image/png for one of them (i.redd.it/46ya6ushyquh1.png, residential). Only
   * still formats: an inline gif's preview url has not been seen, so it is left out rather than guessed.
   *
   * THE SAME ENTRY IN EVERY RENDER THAT HAS ONE. The placeholder render carries no rtjson, so it carries
   * no images either: index 0 is absent there (a 404), which is not a second KIND and poisons nothing.
   */
  if (type === 'multi_media') {
    const inner = rtjsonInner(html) ?? ''
    const figures = [...inner.matchAll(/<figure class="rte-media"[\s\S]*?<\/figure>/g)].map(f => f[0])
    const ids = [...new Set(figures.flatMap(f => {
      const m = /<img[^>]+src="https:\/\/preview\.redd\.it\/[^"]*?-v0-([a-z0-9]+)\.(png|jpe?g|webp)\?/i.exec(f)
      return m ? [`${m[1]}.${m[2].toLowerCase()}`] : []
    }))]
    return ids.map(x => ({ kind: 'image' as const, url: `https://i.redd.it/${x}`, w: 0, h: 0 }))
  }
  // 'gif' on a v.redd.it url: Reddit DOES label some of its videos 'gif'. Measured 2026-10-05 from the
  // dev sandbox, 1 of 36 type:'gif' posts (r/HighQualityGifs/comments/1wpy40m), whose player plays from
  // v.redd.it. It is a video, so it takes the video branch in every render, the same kind each time.
  if (type === 'video' || (type === 'gif' && /^https:\/\/v\.redd\.it\//.test(url))) {
    const cover = html.match(/https:\/\/external-preview\.redd\.it\/[^"\\ ]+/)
    const poster = cover ? decodeEntities(cover[0]) : undefined
    // The HLS lives at {v.redd.it base}/HLSPlaylist.m3u8. Emit a remux video only with BOTH a v.redd.it
    // base and a poster (so it can always degrade to a still); otherwise fall back to the cover image.
    if (/^https:\/\/v\.redd\.it\/[a-z0-9]+$/i.test(url) && poster) {
      const hls = `${url}/HLSPlaylist.m3u8`
      return [{ kind: 'video', url: hls, w: 0, h: 0, poster, remux: { video: hls } }]
    }
    if (poster) return [{ kind: 'image', url: poster, w: 0, h: 0 }]
  }
  // link (no preview thumbnail is exposed by embed) and text carry no media. So does any type this
  // file has not met yet, which is how 'gif' rendered as text only until 2026-10-04, and so does a
  // type:'gif' post whose url is neither an i.redd.it .gif nor v.redd.it (none seen in the 36 measured).
  // #98 read the page's player for that case; it no longer does, because the player is in the full render
  // only, and a video there with nothing in the placeholder render is a second kind for one post's index 0.
  return []
}

/**
 * The raw bytes fetch.ts read from the three body sources (caption.ts), when the embed page had no body.
 * Absent fields are sources that were not asked or did not answer.
 */
type CaptionBytes = { crawler?: unknown; feed?: unknown; archive?: unknown }

/**
 * The body the caption sources agree on, and which one supplied it (for the counters). Read ONCE per fetch:
 * liveFetchPost asks for the source and normalizeReddit for the text, from the same bytes, and parsing them
 * twice doubled the cost of the slowest thing a stranger's post can make this file do.
 */
const captionMemo = new WeakMap<object, ReturnType<typeof pickCaption>>()

function captionOf(raw: CaptionBytes | undefined, sub: string, id: string): ReturnType<typeof pickCaption> | null {
  if (!raw || typeof raw !== 'object') return null
  const known = captionMemo.get(raw)
  if (known) return known
  const crawler = typeof raw.crawler === 'string' ? crawlerCaption(raw.crawler, sub) : null
  const feed = typeof raw.feed === 'string' ? feedCaption(raw.feed, id) : null
  const archive = typeof raw.archive === 'string' ? archiveCaption(raw.archive, id) : null
  const picked = pickCaption(crawler, feed, archive)
  captionMemo.set(raw, picked)
  return picked
}

/**
 * WHERE THIS POST'S BODY CAME FROM, for liveFetchPost's counters: null when the embed page carried the
 * body itself or no other source was asked. The same reading buildFromEmbed makes, so the count and the
 * card cannot disagree about which source won.
 */
export function redditCaptionSource(raw: unknown): ReturnType<typeof pickCaption>['source'] | null {
  const r = raw as Any
  if (r?.source !== 'embed' || typeof r.html !== 'string' || !r.caption) return null
  const sub = redditEmbedSub(r.html)
  const id = (CANONICAL.exec(r.html) || [])[3]
  return sub && id ? captionOf(r.caption, sub, id)?.source ?? null : null
}

function buildFromEmbed(html: string, ref: Extract<PostRef, { p: 'rd' }>, gifHead?: unknown, caption?: CaptionBytes): Post | null {
  // NOT-FOUND / expired: no canonical, or a `/undefined` url. Reddit answers 200 for these, so this
  // is the content assertion, not a status check.
  const canon = html.match(CANONICAL)
  if (!canon || /\/undefined"/.test(html)) return null
  // A user-deleted post keeps its canonical + timestamp but loses its title/score/type — the tombstone
  // is the discriminator. It, and a mod-removed shell with no title, render the generic "couldn't load".
  if (html.includes('This post has been deleted')) return null

  const rawTitle = (
    html.match(/<h1[^>]*\bline-clamp-3\b[^>]*>([\s\S]*?)<\/h1>/) ||
    html.match(/<shreddit-embed-title[^>]*>([\s\S]*?)<\/shreddit-embed-title>/) ||
    []
  )[1]
  // The rendered title is the best source; but a placeholder-sub render (bare /comments/{id}) omits it,
  // so fall back to the url slug — lossy (no punctuation/case) but far better than a generic failure.
  const title = rawTitle
    ? decodeEntities(stripTags(rawTitle)).trim()
    : slugToTitle((canon[1].match(/\/comments\/[^/]+\/([^/?#"]+)/) || [])[1])
  if (!title) return null

  const post = screenview(html) ?? {}
  const created = new Date(Number(post.created_timestamp))
  if (Number.isNaN(created.getTime())) return null

  const author = (html.match(/https:\/\/www\.reddit\.com\/user\/([^/"?]+)/) || [])[1] || '[unknown]'
  /**
   * THE SUB IN THE REF DECIDES THE CACHE KEY, so a placeholder render keeps the one it was asked under.
   * loadPost writes a Post under its own ref's key as well as the requested one, and the page's canonical
   * sub made a stripped render of a bare /comments/{id} link (no author, counts or body) the card for the
   * ORDINARY link too, for up to 900 s in that colo (measured in production, 2026-10-11). fetch.ts now asks
   * again under the real sub, so a placeholder reaches here only when that re-ask failed, and then it is
   * the bare link's thinner card alone. A full render takes the canonical sub, as it always did.
   */
  const sub = redditFullRender(html) ? canon[2] : (ref.sub ?? '')
  const score = parseInt((html.match(/<faceplate-number number="(\d+)"/) || [])[1] || '', 10)
  const comments = parseInt(((html.match(/([\d,]+)\s+comments?/) || [])[1] || '').replace(/,/g, ''), 10)

  /**
   * THE BODY, FOR EVERY POST TYPE THAT HAS ONE. It was kept for type 'text' alone, and Reddit calls a
   * text post with an inline picture `multi_media` — reported on r/YouShouldKnow/comments/8xq8ac (2018,
   * no picture at all, still `multi_media`), whose 785-character body the page carried and the card
   * threw away. Read from the page when the page has it (rtjson, any type), and otherwise from the
   * sources caption.ts names, which fetch.ts asks only when redditNeedsCaption says the page has none.
   */
  const inner = rtjsonInner(html)
  /**
   * A SPOILER-TAGGED POST'S BODY IS `[spoiler]`, whatever it says and even when it says nothing, the owner's
   * call (2026-10-11). Reddit hides the whole post, and the card says why its picture is blurred rather than
   * showing an empty body under one. The title stays: Reddit shows it, and subreddits that use the tag
   * require spoiler-free titles.
   */
  const spoiler = spoilerTagged(html, post)
  const body = spoiler
    ? SPOILER_MARK
    : capBody(inner !== null ? redditHtmlToText(inner) : captionOf(caption, sub, ref.id)?.text ?? '')
  const link = linkOf(post.type, post.url)

  return {
    ref: { p: 'rd', sub, id: ref.id },
    canonical: canon[1],
    author: { name: `u/${author}`, handle: author, url: `https://www.reddit.com/user/${author}` },
    // The title is the headline (bold, its own block); the body follows it. Keeping them separate is
    // what lets the renderer differentiate the two — the concatenated `title\n\nbody` this replaced
    // rendered as one undifferentiated run.
    title,
    text: body,
    ...(link ? { link } : {}),
    ...(spoiler ? { spoiler: true as const } : {}),
    createdAt: created,
    media: redditEmbedMedia(html, post, gifHead),
    counts: {
      likes: Number.isFinite(score) ? score : undefined,
      replies: Number.isFinite(comments) ? comments : undefined,
    },
    sensitive: post.nsfw === true,
  }
}

// ============================================================================
// OAuth JSON path (FALLBACK — only when app creds are configured)
// ============================================================================

/** A removed/deleted post returns 200 with the content gone; read the fields, never the status. */
function isRemoved(d: Any): boolean {
  return (
    (typeof d.removed_by_category === 'string' && d.removed_by_category.length > 0) ||
    d.selftext === '[removed]' || d.selftext === '[deleted]' || d.author === '[deleted]'
  )
}

/** OAuth media: gallery images, else the preview image. Video is the still (audio-split, unmuxable here). */
function redditOAuthMedia(d: Any, gifHead: unknown): Media[] {
  /**
   * A REDDIT GIF IS THE SAME ENTRY HERE AS IN THE EMBED RENDERS, since 2026-10-05: kind:'gif', the
   * i.redd.it .gif, sized from its header. This Post lands under the same canonical cache key as the
   * embed render, so index 0 has to be the same kind in both (redditGifUrl). The embed renders emit this
   * entry for a type:'gif' post and, as always, for a type:'image' one with an i.redd.it .gif, so a .gif
   * `url` here means that entry whichever of the two Reddit called it. Until 2026-10-05 this returned
   * nothing for it, because the embed render put an mp4 VIDEO at index 0 and the png8 preview still below
   * would have sat behind a url promised as video. No render puts a video there now.
   *
   * EVERY OTHER ANIMATED MARKER STILL GETS NO MEDIA: a .gif url anywhere but i.redd.it, or a gif/mp4 preview
   * variant on a non-gif url. Those are read off Reddit's public listing shape, which nothing here has
   * captured (this path needs app credentials), and the preview branch below would pick a still for them
   * where an embed render may put a video (a v.redd.it type:'gif' post, measured, takes the video branch
   * there). A missing index answers 404; a still behind a promised video url is the sticky defect.
   */
  if (typeof d.url === 'string' && REDDIT_GIF.test(d.url)) return [gifEntry(d.url, gifHead)]
  const v = d.preview?.images?.[0]?.variants
  if ((typeof d.url === 'string' && /\.gif(?:\?|$)/i.test(d.url)) || v?.gif || v?.mp4) return []
  if (d.is_gallery && d.gallery_data?.items && d.media_metadata) {
    const out: Media[] = []
    for (const it of d.gallery_data.items) {
      const s = d.media_metadata?.[it?.media_id]?.s
      if (typeof s?.u === 'string') out.push({ kind: 'image', url: decodeEntities(s.u), w: Number(s.x) || 0, h: Number(s.y) || 0 })
    }
    if (out.length) return out
  }
  const src = d.preview?.images?.[0]?.source
  if (typeof src?.url === 'string') return [{ kind: 'image', url: decodeEntities(src.url), w: Number(src.width) || 0, h: Number(src.height) || 0 }]
  if (d.post_hint === 'image' && typeof d.url === 'string' && /^https:\/\/i\.redd\.it\//.test(d.url)) {
    return [{ kind: 'image', url: d.url, w: 0, h: 0 }]
  }
  return []
}

function buildFromOAuth(raw: unknown, ref: Extract<PostRef, { p: 'rd' }>, gifHead?: unknown): Post | null {
  const listing = Array.isArray(raw) ? raw[0] : (raw as Any)
  const d = listing?.data?.children?.[0]?.data
  if (!d || typeof d.title !== 'string' || typeof d.author !== 'string') return null
  if (isRemoved(d)) return null

  const created = new Date(Number(d.created_utc) * 1000)
  if (Number.isNaN(created.getTime())) return null

  const sub = typeof d.subreddit === 'string' && d.subreddit ? d.subreddit : ref.sub
  return {
    ref: { p: 'rd', sub, id: ref.id },
    canonical: typeof d.permalink === 'string'
      ? `https://www.reddit.com${d.permalink}`
      : `https://www.reddit.com/r/${sub}/comments/${ref.id}`,
    author: { name: `u/${d.author}`, handle: d.author, url: `https://www.reddit.com/user/${d.author}` },
    // Title/body split so the renderer can bold the headline (same as the embed path). selftext is
    // MARKDOWN here, which the cards showed raw (asterisks, `[text](url)`) until 2026-10-11. A
    // spoiler-tagged post is `[spoiler]`, as on the embed path, and on the same terms: an NSFW post is
    // read as NSFW only, because the embed page cannot see its spoiler tag and both renders share a key.
    title: d.title,
    text: d.spoiler === true && d.over_18 !== true
      ? SPOILER_MARK
      : capBody(typeof d.selftext === 'string' ? redditMarkdownToText(d.selftext) : ''),
    ...(d.is_self !== true ? (l => (l ? { link: l } : {}))(linkOf('link', d.url)) : {}),
    ...(d.spoiler === true && d.over_18 !== true ? { spoiler: true as const } : {}),
    createdAt: created,
    media: redditOAuthMedia(d, gifHead),
    counts: { likes: Number(d.score) || 0, replies: Number(d.num_comments) || 0 },
    sensitive: d.over_18 === true,
  }
}

/**
 * A private/banned/quarantined subreddit answers the OAuth path with an error object `{reason}`;
 * name that wall 'private' (🔒). The embed path cannot see this (it returns the same not-found shell
 * as a missing post), so this only fires on the OAuth fallback.
 */
export function redditGate(raw: unknown): 'private' | undefined {
  const reason = (raw as Any)?.reason
  return reason === 'private' || reason === 'banned' || reason === 'quarantined' ? 'private' : undefined
}

/**
 * Pure: fetched Reddit data -> Post. Dispatches on `source`; a bare listing is the OAuth path.
 * `gifHead` is the first ten bytes of the post's .gif when fetch.ts read them (see gifSize). It sizes
 * the gif entry and changes nothing else in the Post: a missing or garbled one leaves the same entry at
 * 0x0. What 0x0 costs in Discord is a separate question, and it may be the picture (gifSize says why).
 */
export function normalizeReddit(raw: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'rd') return null
  const r = raw as Any
  if (r?.source === 'embed') return buildFromEmbed(typeof r.html === 'string' ? r.html : '', ref, r.gifHead, r.caption)
  if (r?.source === 'json') return buildFromOAuth(r.data, ref, r.gifHead)
  return buildFromOAuth(raw, ref)
}
