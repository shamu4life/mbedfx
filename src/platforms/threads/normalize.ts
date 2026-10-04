import type { Media, Post, PostRef } from '../../types.ts'

type Any = Record<string, any>

/**
 * The pure half of Threads: already-fetched HTML in, a Post out, no I/O. fetch.ts owns the requests and
 * the "did a real post arrive" gate. Two sources, dispatched in normalizeThreads at the bottom:
 *
 *  - 'ssr' (PRIMARY): the server-rendered post JSON in the logged-out permalink (SSR_PRELOADERS below).
 *    Every field a rich card needs: each carousel slide, video, counts, avatar, the real timestamp,
 *    the quoted post.
 *  - 'html' (FALLBACK): the OG tags of two bot-UA pages, for when the SSR payload is missing. TWO
 *    pages, because no single UA carries both (measured 2026-07-21): `facebookexternalhit/1.1`
 *    renders `name="description"` (the caption) but its `og:image` is only the author's profile
 *    picture; `Discordbot/2.0` renders an `og:image` and no caption. So `media` is the Discord page
 *    and `text` the fbhit page, and each field is read from the page that actually carries it.
 *
 * WHAT THE DISCORDBOT og:image ACTUALLY IS, measured 2026-10-04 on a carousel and on a video post:
 * Threads' own rendered SHARE CARD (fbcdn `t39.92108-6`), not the post's media. It is one picture with the
 * Threads logo, a truncated caption, cropped slides, counts as they were when it was rendered, and on a
 * video a play glyph that does not play. Real slides and covers are `t51.*`. The 2026-07-21 note
 * called it "the POST media", and it was probably always this (same `t39.92108-6` class, inferred).
 * That is why the fallback is a single-image card by nature, and why losing the SSR path showed up as
 * "a carousel became one unscrollable image".
 */

/**
 * Decode the HTML entities that appear in meta `content` attributes — Threads emits `&#064;` for
 * '@' in og:title and `&amp;` in every CDN url query string. `&amp;` LAST, so an already-decoded
 * `&lt;` from an `&amp;lt;` source is not re-processed into a literal '<'.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch { return _ } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ } })
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Read a single `<meta>` tag's content by its key attribute, tolerant of attribute ORDER — Threads
 * writes `property` before `content`, but nothing guarantees that, so match the whole tag then pull
 * each attribute out of it rather than assuming a fixed layout. `attr` is 'property' (the og:* tags)
 * or 'name' (the description/twitter:* tags), which Threads spells on different tags for the same
 * data.
 */
function metaContent(html: string, attr: 'property' | 'name', val: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi)
  if (!tags) return undefined
  const keyRe = new RegExp(`\\b${attr}\\s*=\\s*"${val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i')
  for (const tag of tags) {
    if (keyRe.test(tag)) {
      const c = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)
      if (c) return decodeEntities(c[1])
    }
  }
  return undefined
}

/**
 * "A REAL POST PAGE ARRIVED." The one liveness marker, and it is `og:type=article`: a valid post
 * renders it, while a deleted/private/age-gated/profile URL renders the contentless JS shell with no
 * og:type at all (measured 2026-07-21 — status is UNRELIABLE, one bad code 302'd and another 200'd).
 * Threads gives a logged-out crawler no way to tell private from deleted from age here, so all of
 * them correctly fall to the generic "couldn't load" card, which is the honest answer to "we cannot
 * see why".
 */
export function threadsHasPost(html: unknown): boolean {
  return typeof html === 'string' && metaContent(html, 'property', 'og:type') === 'article'
}

/** og:title is `Name (@handle) on Threads`; pull the display name and handle back out of it. */
const AUTHOR = /^(.*) \(@([A-Za-z0-9._]+)\) on Threads$/

/**
 * Threads/Instagram-Barcelona post ids are snowflakes: the creation time is the high bits of the id,
 * and the id is the base64url-decode of the shortcode — so `createdAt` is derivable with no network,
 * which matters because the OG tags carry no timestamp at all.
 *
 * SHIFT 23, NOT the Instagram-classic 22. Measured against two known-date posts (2026-07-21):
 * shift 22 puts a 2024 post in 2038; shift 23 with the Instagram epoch (1314220021721 ms, 2011-08-24)
 * places pmestevez/DDYEM_foiI1 at 2024-12-09 (the Threads oEmbed launch window) and nike/CuaNNJVvRga
 * at 2023-07-07 (Threads launch). The GraphQL tier's `taken_at` supersedes this when present.
 */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function createdAtFromCode(code: string): Date | null {
  let n = 0n
  for (const ch of code) {
    const i = B64URL.indexOf(ch)
    if (i < 0) return null
    n = n * 64n + BigInt(i)
  }
  const d = new Date(Number((n >> 23n) + 1314220021721n))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Build a Post from the two OG pages. `media` is the Discord-UA page (the share card in og:image),
 * `text` the fbhit-UA page (caption in name=description). The handle is parsed out of og:title so the
 * canonical is rebuilt from the PAYLOAD — the same "normalizer owns its canonical" rule TikTok and
 * Instagram follow, because the ref carries only the shortcode (the pasted username was decoration).
 */
function buildFromHtml(mediaHtml: unknown, textHtml: unknown, ref: Extract<PostRef, { p: 'th' }>): Post | null {
  const media = typeof mediaHtml === 'string' ? mediaHtml : ''
  const text = typeof textHtml === 'string' ? textHtml : ''
  const title = metaContent(media, 'property', 'og:title') ?? metaContent(text, 'property', 'og:title')
  if (!title) return null

  const am = AUTHOR.exec(title)
  const name = am ? am[1] : title
  const handle = am ? am[2] : ''
  const caption = metaContent(text, 'name', 'description') ?? metaContent(text, 'name', 'twitter:description') ?? ''
  const image = metaContent(media, 'property', 'og:image')
  const createdAt = createdAtFromCode(ref.code)
  if (!createdAt) return null

  const items: Media[] = typeof image === 'string' && image ? [{ kind: 'image', url: image, w: 0, h: 0 }] : []
  return {
    ref,
    canonical: `https://www.threads.com/@${handle || 'i'}/post/${ref.code}`,
    author: {
      name,
      handle,
      url: handle ? `https://www.threads.com/@${handle}` : 'https://www.threads.com',
    },
    text: caption,
    createdAt,
    media: items,
    counts: {},
    sensitive: false,
  }
}

/**
 * THE RICHNESS TIER. The logged-out permalink SERVER-SIDE-RENDERS the whole post as JSON — no
 * GraphQL, no rotating lsd/doc_id (the credential-free GraphQL POST is dead; the SSR payload is the
 * durable path, verified from Workers egress 2026-07-21). The object is a standard Instagram media
 * dict embedded in a `<script type="application/json" data-sjs>` under a RelayPrefetchedStreamCache
 * preloader whose name has a stable prefix + a rotating hash. We match the prefix, then a
 * string-aware brace scan lifts the `{"__bbox"…}` object out for JSON.parse — regexing a nested JSON
 * object whole would be wrong on the first escaped quote or brace inside a caption/url.
 *
 * THE NAME MOVED, AND NOTHING SAID SO. By 2026-10-04 the logged-out permalink carried the post under
 * `BarcelonaPostPageTargetQueryRelayPreloader_<hash>` and neither of the two older names appeared
 * anywhere on the page. So every Threads post fell through to the OG scrape in fetch.ts, which can only
 * ever produce ONE image. Reported as a carousel collapsing to a single picture; it was every post: a
 * video lost its player, and every card lost its counts, its avatar and its real timestamp. /_smoke
 * stayed green, because the fallback card still has a title and the activity link (see its th row).
 * Measured from CONTAINER egress (not a Worker) on six pages with SSR_HEADERS: a carousel, a video, a
 * reply permalink, a quote post, a third account and an invalid code. The path inside is the same
 * `__bbox.result.data.media` the Permalink name used, and the hash differs per request, so the `\w+`
 * after the prefix is required. test/fixtures/threads-ssr-*.html are cut from two of those pages.
 *
 * MATCH EXACT NAMES, NEVER A `Barcelona\w*QueryRelayPreloader_` WILDCARD. The same page carries three
 * sibling preloaders with the same `__bbox.result` envelope, and each holds a DIFFERENT post: Upward is
 * the parent chain, Downward is the replies, LoggedOutRelatedPosts is other posts (including the same
 * author's other carousels), and an invalid code serves LoggedOutFeedContainer, a feed of strangers'
 * posts. Measured: a wildcard plus a walk picked a stranger's reply on one page and the author's OTHER
 * carousel on another, which is a confidently wrong card, worse than the degraded one. The
 * `user.username` guard below happens to reject Upward and Downward today, but that is luck of shape,
 * not a defence. The two older names stay because they cost one failed scan each and Threads has
 * served them before.
 */
const SSR_PRELOADERS = [
  'BarcelonaPostPageTargetQueryRelayPreloader_',
  'BarcelonaPermalinkMobilePostColumnPageQueryRelayPreloader_',
  'BarcelonaPostPageDirectQueryRelayPreloader_',
]

/** From index `start` (which must be a '{'), return the balanced JSON object, respecting strings. */
function braceScan(s: string, start: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      if (--depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/** Find and parse the embedded media dict. Two preloader shapes carry it at two different paths. */
function extractThreadsMedia(html: string): Any | null {
  for (const prefix of SSR_PRELOADERS) {
    const m = new RegExp(`${prefix}\\w+",(\\{"__bbox")`).exec(html)
    if (!m) continue
    const obj = braceScan(html, m.index + m[0].length - m[1].length)
    if (!obj) continue
    try {
      const box = (JSON.parse(obj) as Any)?.__bbox
      const media =
        box?.result?.data?.media ??
        box?.result?.data?.data?.edges?.[0]?.node?.thread_items?.[0]?.post
      if (media?.user?.username) return media
    } catch {
      // A truncated or reshaped block: try the next preloader rather than throwing.
    }
  }
  return null
}

/** True once the SSR payload carrying a post is present — the fetch's "a real post arrived" check. */
export function hasThreadsSSR(html: unknown): boolean {
  return typeof html === 'string' && extractThreadsMedia(html) !== null
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined

/**
 * One media item out of a media dict — the SAME handling as Instagram, because Threads IS Instagram's
 * backend: `video_versions[0].url` is a PROGRESSIVE mp4 on scontent.cdninstagram.com (verified 2026-07-22
 * across four live posts — `.mp4?…`, a plain GET is 200 `video/mp4` with `ftyp`/`accept-ranges`, and the
 * `efg` param decodes to `progressive_recipe:1`; NOT the DASH an earlier note wrongly assumed). It plays
 * exactly as an Instagram reel does: the /_media/ route 302s straight to that signed url and Discord's own
 * media proxy fetches it — CONFIRMED by the owner that IG reels play, and this is the identical CDN + url
 * form. NOT routed through the resolver container: our container can't fetch it (Meta blocks Cloudflare's
 * datacenter egress — that fetch is a datacenter IP; Discord's proxy is not), so a remux would fail on
 * every video. The signed url expires in hours, but the Post cache TTL is far shorter, so each render
 * carries a fresh one — same as Instagram.
 *
 * The Worker's direct-video proxy (mediaproxy.ts proxyableVideoUrl) DOES serve these bytes itself, since
 * 2026-08-09, when a `wrangler dev --remote` fetch of a Threads scontent url came back as real video and
 * retired the inferred Meta block this paragraph used to cite. Its reasons and its 302 fallback live there.
 *
 * A video is `kind: 'video'` with the cover as its poster, at BOTH levels; where it renders diverges in
 * the RENDERER, not here (exactly as Instagram): a standalone / single-item video advertises og:video and
 * plays, while a multi-item carousel is handled by mastodon.ts according to the GALLERY MODE
 * (galleryHasVideo, usableCount > 1): the default promotes one video to a real player and stills the
 * rest with a "more in the post" note, and /p stills every one with the "🎬 Contains video" marker.
 * Which of those happens is emphatically not this file's business — what matters here is that the
 * child arrives as kind:'video' WITH a poster, because both modes need the poster and neither can
 * recover it. A non-video item is its still image.
 */
function mediaFromDict(m: Any): Media | null {
  const cover = m?.image_versions2?.candidates?.[0]
  const coverUrl = typeof cover?.url === 'string' ? cover.url : undefined
  const v = m?.video_versions?.[0]
  if (m?.media_type === 2 && typeof v?.url === 'string' && coverUrl) {
    return { kind: 'video', url: v.url, w: num(v.width) ?? num(cover.width) ?? 0, h: num(v.height) ?? num(cover.height) ?? 0, poster: coverUrl }
  }
  return coverUrl ? { kind: 'image', url: coverUrl, w: num(cover.width) ?? 0, h: num(cover.height) ?? 0 } : null
}

function mediaEntries(m: Any): Media[] {
  if (m?.media_type === 8 && Array.isArray(m.carousel_media)) {
    // Each child is normalized the same; whether a video plays or flattens to a still is the renderer's
    // call (galleryHasVideo, usableCount > 1, and since 2026-09-11 the gallery mode) — a 1-item
    // carousel always plays, and a multi-item one plays at most one of its videos.
    return m.carousel_media.map((c: Any) => mediaFromDict(c)).filter((x: Media | null): x is Media => x !== null)
  }
  const one = mediaFromDict(m)
  return one ? [one] : []
}

/**
 * Build a Post from an Instagram media dict. `quoted`, when false, blocks the one level of recursion
 * into a quoted/reposted post (share_info) — depth 1, the same cap the other platforms enforce.
 */
function buildFromMedia(m: Any, ref: Extract<PostRef, { p: 'th' }>, quoted = false): Post | null {
  const user = m?.user
  if (!user?.username) return null
  const created = new Date(num(m.taken_at) === undefined ? NaN : Number(m.taken_at) * 1000)
  if (Number.isNaN(created.getTime())) return null

  const tp = m.text_post_app_info ?? {}
  const post: Post = {
    ref: { p: 'th', code: ref.code },
    canonical: `https://www.threads.com/@${user.username}/post/${typeof m.code === 'string' ? m.code : ref.code}`,
    author: {
      name: typeof user.full_name === 'string' && user.full_name ? user.full_name : user.username,
      handle: user.username,
      url: `https://www.threads.com/@${user.username}`,
      avatar: typeof user.profile_pic_url === 'string' ? user.profile_pic_url : undefined,
    },
    text: typeof m.caption?.text === 'string' ? m.caption.text : '',
    createdAt: created,
    media: mediaEntries(m),
    counts: { likes: num(m.like_count), replies: num(tp.direct_reply_count), reposts: num(tp.repost_count) },
    sensitive: false,
  }
  if (!quoted) {
    const q = tp.share_info?.quoted_post ?? tp.share_info?.reposted_post
    if (q?.user?.username) {
      const qp = buildFromMedia(q, { p: 'th', code: typeof q.code === 'string' ? q.code : '' }, true)
      if (qp) post.quote = qp
    }
  }
  return post
}

/**
 * Pure: fetched Threads data -> Post. Dispatches on `source`: 'ssr' is the rich path (video, counts,
 * timestamp, carousels, quotes) from the server-rendered JSON; 'html' is the OG-tag fallback (author,
 * caption, cover image) for when the SSR page is rate-limited or its header gate shifts. Returns null
 * rather than inventing a Post — a half-built Post renders as a broken embed.
 */
export function normalizeThreads(raw: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'th') return null
  const r = raw as Any
  if (r?.source === 'ssr') {
    const media = typeof r.html === 'string' ? extractThreadsMedia(r.html) : null
    return media ? buildFromMedia(media, ref) : null
  }
  if (r?.source === 'html') return buildFromHtml(r.media, r.text, ref)
  return null
}
