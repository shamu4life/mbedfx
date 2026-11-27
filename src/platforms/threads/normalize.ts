import type { Media, Post, PostRef } from '../../types.ts'

type Any = Record<string, any>

/**
 * The pure half of Threads: already-fetched HTML in, a Post out, no I/O. fetch.ts owns the requests and
 * the "did a real post arrive" gate. Two sources, dispatched in normalizeThreads at the bottom:
 *
 *  - 'ssr' (PRIMARY): the server-rendered post JSON in the logged-out permalink (SSR_PRELOADERS below).
 *    Every field a rich card needs: each carousel slide, video, counts, avatar, the real timestamp,
 *    the quoted post, the pictures of a linked Instagram post, and who a reply answers.
 *  - 'html' (FALLBACK): the OG tags of two bot-UA pages, for when the SSR payload is missing. TWO
 *    pages, because no single UA carries both (measured 2026-07-21): `facebookexternalhit/1.1`
 *    renders `name="description"` (the caption) but its `og:image` is only the author's profile
 *    picture; `Discordbot/2.0` renders an `og:image` and no caption. So `media` is the Discord page
 *    and `text` the fbhit page, and each field is read from the page that actually carries it.
 *
 * WHAT THE DISCORDBOT og:image ACTUALLY IS, measured 2026-10-04 on a carousel and on a video post, from
 * the Claude Code dev sandbox (a non-Cloudflare cloud IP behind an HTTPS proxy), not a Worker and not the Cloudflare Container (and the same picture came back through production's /_media/ for both):
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

/** og:title is `Name (@handle) on Threads`; pull the display name and handle back out of it. */
const AUTHOR = /^(.*) \(@([A-Za-z0-9._]+)\) on Threads$/

/** The author a page's og:title names, or null when the title is not the `Name (@handle) on Threads` form. */
function pageAuthor(html: string): { name: string; handle: string } | null {
  const title = metaContent(html, 'property', 'og:title')
  const am = title ? AUTHOR.exec(title) : null
  return am ? { name: am[1], handle: am[2] } : null
}

/**
 * "A REAL POST PAGE ARRIVED." Two markers, and both are required: `og:type=article`, and an og:title
 * that names the post's author as `Name (@handle) on Threads`. Status is UNRELIABLE (measured
 * 2026-07-21: one bad code 302'd and another 200'd), so neither marker is a status.
 *
 * og:type ALONE WAS THE CHECK UNTIL 2026-11-27, and it let Threads' login wall through as a post. On
 * 2026-07-21 a deleted/private/age-gated/profile URL rendered the contentless JS shell with no og:type
 * at all, so og:type=article was enough. By 2026-11-27 it was not. Measured that day at 05:04 UTC
 * through production's /_api/v1 (Worker egress): a deleted post, threads.com/@i/post/DbcSwYaEa9r,
 * and a code nobody minted, ZTSw2mYwR, both came back `ok: true` as a post by "Threads • Log in"
 * with no handle. The text was "Join Threads to share ideas, ask questions, post random thoughts,
 * find your people and more. Log in with your Instagram." and the one picture was a static
 * cdninstagram rsrc.php asset, not a post's media. That card can only come from the OG fallback
 * (buildFromHtml): the SSR path needs a `user.username`. fetch.ts let it through only because
 * og:type=article held on at least one of the two pages, so the login wall carries it. Which of the
 * two pages, and what else is on them, is not known: the raw bytes were not captured, and the dev host
 * this was worked on got 429 from threads.com for every ask at 05:04 UTC.
 *
 * WHY THE AUTHOR AND NOT A BLOCKLIST OF "Log in": the byline is what the card needs, and a brand
 * title is not one. A post page names its author in og:title: the two SSR fixtures, cut from post
 * pages captured 2026-10-04, keep their og:* head and it is that form, and the fallback has parsed
 * its byline out of exactly that form since 2026-07-21. A login wall, a feed, a profile or a page
 * Threads invents next names no `(@handle) on Threads`, so it fails this without anyone having to
 * have seen it first. If Threads ever renames its post titles, the fallback card turns into the
 * failure card, which is the direction to fail in: a wrong byline is a guess shown as fact.
 *
 * Threads gives a logged-out crawler no way to tell private from deleted from age, so all of them
 * fall to the generic "couldn't load" card, which is the honest answer to "we cannot see why".
 */
export function threadsHasPost(html: unknown): boolean {
  return typeof html === 'string' && metaContent(html, 'property', 'og:type') === 'article' && pageAuthor(html) !== null
}

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
 * THE INVERSE OF THE DECODE ABOVE: a numeric post id to its shortcode. Threads names a reply's parent
 * only by its numeric id (`text_post_app_info.reply_to_post_id`), and a th ref needs the shortcode.
 *
 * Measured 2026-11-26 on pages fetched once each with SSR_HEADERS from a Linux workstation, not from a
 * Worker (the conversion is arithmetic on the payload, so egress cannot change it): every object
 * carrying both a `pk` and a `code` agreed with this function, 50 of 50 across two captured pages and
 * 12 of 12 in the committed fixtures (test/threads-normalize.test.mjs walks those). On the same two
 * pages, each of the three replies (one self-reply, two replies from other accounts) named a parent
 * that was on the page too, with `pk` equal to `reply_to_post_id`, `code` equal to this function's
 * answer, and its author equal to `reply_to_author`.
 *
 * A STRING OF 1 TO 20 DIGITS, NO LEADING ZERO, OR NOTHING. A pk is a 64-bit integer, so 20 digits is
 * the most it can have. BigInt() throws on anything that is not digits. And an id that arrived as a JSON
 * NUMBER is refused rather than converted, because JSON.parse has already rounded it: these ids are 19
 * digits, past 2^53, so its shortcode would name some other post.
 */
const POST_ID = /^[1-9]\d{0,19}$/
export function codeFromId(id: unknown): string | null {
  if (typeof id !== 'string' || !POST_ID.test(id)) return null
  let n = BigInt(id)
  let code = ''
  while (n > 0n) {
    code = B64URL[Number(n % 64n)] + code
    n /= 64n
  }
  return code
}

/**
 * Build a Post from the two OG pages. `media` is the Discord-UA page (the share card in og:image),
 * `text` the fbhit-UA page (caption in name=description). The handle is parsed out of og:title so the
 * canonical is rebuilt from the PAYLOAD — the same "normalizer owns its canonical" rule TikTok and
 * Instagram follow, because the ref carries only the shortcode (the pasted username was decoration).
 *
 * EACH FIELD COMES ONLY FROM A PAGE THAT IS THE POST (threadsHasPost), and the Post exists only if one
 * of them is. Until 2026-11-27 the title was taken from whichever page had one and used whole when it
 * was not a byline, so Threads' login wall became a post by "Threads • Log in" (threadsHasPost has the
 * production measurement). Per page, because the two are separate requests and either can be the wall
 * on its own: with only the fbhit page walled, a real post's caption would have been "Join Threads to
 * share ideas…", and with only the Discordbot page walled, its picture the wall's static asset. Such a
 * card loses that field instead. Two pages naming DIFFERENT authors for one code means one of them is
 * not this post, and nothing says which, so that is null too.
 *
 * createdAt IS READ AFTER THAT CHECK, never before. It is decoded from the shortcode, so it is only as
 * true as the claim that the code is a post: for the made-up ZTSw2mYwR it decodes to 2011-09-03, a
 * date production showed on the login-wall card. Once a page names the post's author, the code is
 * Threads' own and the decode is its creation time (createdAtFromCode has the measurement).
 */
function buildFromHtml(mediaHtml: unknown, textHtml: unknown, ref: Extract<PostRef, { p: 'th' }>): Post | null {
  const media = threadsHasPost(mediaHtml) ? mediaHtml as string : ''
  const text = threadsHasPost(textHtml) ? textHtml as string : ''
  const fromMedia = media ? pageAuthor(media) : null
  const fromText = text ? pageAuthor(text) : null
  if (fromMedia && fromText && fromMedia.handle !== fromText.handle) return null
  const author = fromMedia ?? fromText
  if (!author) return null
  const { name, handle } = author

  const caption = metaContent(text, 'name', 'description') ?? metaContent(text, 'name', 'twitter:description') ?? ''
  const image = metaContent(media, 'property', 'og:image')
  const createdAt = createdAtFromCode(ref.code)
  if (!createdAt) return null

  const items: Media[] = typeof image === 'string' && image ? [{ kind: 'image', url: image, w: 0, h: 0 }] : []
  return {
    ref,
    canonical: `https://www.threads.com/@${handle}/post/${ref.code}`,
    author: {
      name,
      handle,
      url: `https://www.threads.com/@${handle}`,
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
 * Measured from the Claude Code dev sandbox (a non-Cloudflare cloud IP behind an HTTPS proxy), not a Worker and not the Cloudflare Container, on six pages with SSR_HEADERS: a carousel, a video, a
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
 * A TEXT POST THAT LINKS AN INSTAGRAM POST has no media of its own, and Threads draws the linked post's
 * pictures inline in it. Measured 2026-11-26 on the FIXERS.md carousel example, fetched with
 * SSR_HEADERS from a Linux workstation (not a Worker): the post is `media_type 19` with an empty
 * `image_versions2.candidates` and no `carousel_media`. Its ten slides sit under
 * `text_post_app_info.linked_inline_media`, a `media_type 8` dict whose `permalink` is on
 * www.instagram.com and whose `user` is a different account from the Threads author, next to a
 * `link_preview_attachment` for the same Instagram post. mediaEntries read only the top level, so
 * production answered `media: []` for it, the avatar summary card, while its counts showed the SSR
 * path had run.
 *
 * THE POST'S OWN MEDIA WINS whenever there is any, and only the linked post's MEDIA is read. Its
 * caption (683 characters on the example) and its author are left alone: the card is the Threads post,
 * so its text and byline stay the Threads author's. A post with both its own media and a linked post
 * was not seen; preferring its own is what keeps such a card from showing someone else's pictures in
 * place of the author's. Not measured: a linked reel. If Threads sends it with no `video_versions`,
 * mediaFromDict makes it its cover still, the same as any dict without a playable url.
 */
function postMedia(m: Any): Media[] {
  const own = mediaEntries(m)
  if (own.length) return own
  const linked = m?.text_post_app_info?.linked_inline_media
  return linked && typeof linked === 'object' ? mediaEntries(linked) : []
}

/** A Threads handle, the same charset AUTHOR accepts out of og:title. */
const HANDLE = /^[A-Za-z0-9._]+$/

/**
 * THE PARENT OF A REPLY, as little of it as the reply marker needs. Built the way twitter/normalize.ts's
 * minimalReplyTo builds one: the renderer reads only replyTo.author (text.ts replyPrefix, mastodon.ts
 * authorName), so this carries the parent's handle and honest empties. The parent's text is never
 * filled in; the Target block does not carry it.
 *
 * Three fields on `text_post_app_info`, measured 2026-11-26 on the FIXERS.md reply example and on two
 * replies from other accounts on the carousel example's page: `is_reply: true`, `reply_to_author`
 * (username, id and profile_pic_url, no display name) and `reply_to_post_id` (a numeric string;
 * codeFromId says how it becomes the parent's shortcode and what proves it does). A post that is not a
 * reply carried `is_reply: false` and nulls for the other two. buildFromMedia used to read none of
 * them, so every Threads reply rendered as if it started a thread.
 *
 * ALL THREE OR NO REPLY CONTEXT. cache.ts's hasValidIdentity re-checks a nested replyTo when a cached
 * post is read back, and a replyTo without a valid ref, canonical or createdAt makes the WHOLE post read
 * back as null, so every view would refetch. A replyTo with the ref or canonical left out is therefore
 * not a way to degrade. A reply with no usable id or handle gets no replyTo, the rule Twitter follows.
 *
 * createdAt is the PARENT's, read from its shortcode by createdAtFromCode, where Twitter has to borrow
 * the child's. Nothing renders it, but the cache stores it, and the real value is in hand. On the
 * example it is 145 ms before the child's id time.
 */
function replyToFrom(tp: Any): Post | undefined {
  if (tp?.is_reply !== true) return undefined
  const handle = tp.reply_to_author?.username
  if (typeof handle !== 'string' || !HANDLE.test(handle)) return undefined
  const code = codeFromId(tp.reply_to_post_id)
  const createdAt = code ? createdAtFromCode(code) : null
  if (!code || !createdAt) return undefined
  return {
    ref: { p: 'th', code },
    canonical: `https://www.threads.com/@${handle}/post/${code}`,
    // reply_to_author has no display name, so the name is the handle, as on Twitter's minimal parent.
    author: { name: handle, handle, url: `https://www.threads.com/@${handle}` },
    text: '',
    createdAt,
    media: [],
    counts: {},
    sensitive: false,
  }
}

/**
 * Build a Post from an Instagram media dict. `quoted`, when false, blocks the one level of recursion
 * into a quoted/reposted post (share_info) and the reply context, both depth 1, the same cap the other
 * platforms enforce.
 *
 * NO META_GENERATION BUMP came with the 2026-11-26 linked-media and reply fixes, because a Threads
 * Post is never stored under it. META_GENERATION scopes only the R2 meta records (metaCacheKey in
 * worker.ts, for yt, fb, dm, st and im). A Threads Post lives in the per-colo Cache API, under
 * postCacheKey for POST_TTL and as a rendered response for RESP_TTL, 900 s each. So a card cached
 * without its pictures or its marker heals within about half an hour. A bump would not reach it, and
 * would throw away up to 30 days of other platforms' records.
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
    media: postMedia(m),
    counts: { likes: num(m.like_count), replies: num(tp.direct_reply_count), reposts: num(tp.repost_count) },
    sensitive: false,
  }
  if (!quoted) {
    const q = tp.share_info?.quoted_post ?? tp.share_info?.reposted_post
    if (q?.user?.username) {
      const qp = buildFromMedia(q, { p: 'th', code: typeof q.code === 'string' ? q.code : '' }, true)
      if (qp) post.quote = qp
    }
    const parent = replyToFrom(tp)
    if (parent) post.replyTo = parent
  }
  return post
}

/**
 * Pure: fetched Threads data -> Post. Dispatches on `source`: 'ssr' is the rich path (video, counts,
 * timestamp, carousels, quotes) from the server-rendered JSON; 'html' is the OG-tag fallback (author,
 * caption, and Threads' rendered share card as the one image) for when the SSR page is rate-limited or
 * its header gate shifts. Returns null
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
