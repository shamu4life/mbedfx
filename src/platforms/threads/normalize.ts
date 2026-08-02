import type { Media, Post, PostRef } from '../../types.ts'

type Any = Record<string, any>

/**
 * Threads serves a BOT user-agent a server-rendered page whose OpenGraph/meta tags carry the post.
 * This file is the pure half: it reads those tags out of already-fetched HTML and builds a Post. No
 * I/O — fetch.ts owns the two-UA fetch and the "did a real post arrive" gate; everything here is
 * testable against a handful of literal meta tags with no network.
 *
 * TWO PAGES, because no single UA carries both the text and the post's own media (measured
 * 2026-07-21): `facebookexternalhit/1.1` renders `name="description"` (the caption) but its
 * `og:image` is only the author's profile picture; `Discordbot/2.0` renders `og:image` as the POST
 * media (fbcdn `t39.92108-6`) but no caption. So `media` is the Discord page and `text` the fbhit
 * page, and each field is read from the page that actually carries it.
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
 * Build a Post from the two OG pages. `media` is the Discord-UA page (post image in og:image),
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
 */
const SSR_PRELOADERS = [
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
 * AND FOR THE SAME REASON, THE 2026-07-25 DIRECT-VIDEO PROXY DELIBERATELY SKIPS THIS PLATFORM. mediaproxy.ts
 * serves Instagram video bytes from the Worker instead of 302-ing, and these urls are on the SAME
 * scontent*.cdninstagram.com hosts — so a host-only allowlist would have captured Threads too. The Worker's
 * egress is a datacenter IP exactly like the container's, so those bytes would most likely come back
 * non-video, fail the content assertion, and answer og:video with 503 on every Threads video post.
 * proxyableVideoUrl is therefore gated on `ref.p === 'ig'`; revisit only with a real measurement.
 *
 * A video is `kind: 'video'` with the cover as its poster, at BOTH levels; where it renders diverges in
 * the RENDERER, not here (exactly as Instagram): a standalone / single-item video advertises og:video and
 * plays, while a multi-item carousel is flattened by mastodon.ts to that poster still PLUS the "🎬 Contains
 * video" marker (galleryHasVideo, usableCount > 1). A non-video item is its still image.
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
    // call (galleryHasVideo, usableCount > 1) — a multi-item carousel flattens, a 1-item one plays.
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
