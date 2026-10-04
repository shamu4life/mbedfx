import type { Media, Post, PostRef } from '../../types.ts'

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

/** The HTML entities that appear in embed text/urls/attributes; `&amp;` LAST so it does not re-decode. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch { return _ } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ } })
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '')

/**
 * Reddit selftext is the ONE post body that runs to thousands of chars (Twitter/Bluesky cap far
 * shorter, and Reddit's OWN embed line-clamps it). The renderer appends the engagement counts as the
 * LAST block of the Mastodon `content`, so a long body pushes `❤️ 💬` past Discord's content preview
 * and a text post shows no counts (reported 2026-07-22) — while short posts keep the footer near the
 * top. Cap the body to a preview (word-boundary, ellipsized) so the counts stay visible and the embed
 * is not a wall of text. Length is tunable; the title is never capped (it leads the card).
 */
const BODY_PREVIEW = 500
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

/**
 * An ANIMATED post's player, read off the embed page: Reddit's own mp4 rendition of the gif, its still
 * poster, and the size, as one `kind: 'video'` entry. Null when any part is missing or off-host.
 *
 * WHY THIS AND NOT THE .gif. Reported 2026-10-04: r/forsen/comments/1wuh1g1, a gif post, rendered as
 * text only. Reddit now labels such posts `type: "gif"` in the screenview (measured), which no branch
 * below knew, so media came back empty and nothing failed loudly. Treating it as the old .gif image
 * would have been a one-line fix, and it is the worse card on what was measured that day (container
 * egress): the .gif is 556 KB against 25 KB for the mp4, and it carries no size. Whether Discord draws a
 * size-less IMAGE attachment at all is unresolved for Reddit: types.ts records that it does not (measured
 * on a YouTube poster), while embed.ts calls Reddit's 0x0 images human-verified. The mp4-with-poster shape
 * sidesteps that question, and it is the one Twitter's animated_gif, Imgur and Mastodon's gifv already
 * ship. It also previews: /_card publishes 'gif' as a posterless 'video', which the converter draws as
 * nothing, and a video with a poster as its poster.
 *
 * WHAT THE PAGE CARRIES, in the real-subreddit render fetch.ts asks for:
 *   <shreddit-player src="https://preview.redd.it/{id}.gif?width=320&format=mp4&s=…" … gif …
 *                    poster="https://preview.redd.it/{slug}-v0-{id}.gif?format=png8&s=…">
 * inside a `<shreddit-aspect-ratio style="--aspect-ratio: 1.333…">`. The `gif` attribute is what marks
 * it, and it is a BARE attribute, so quoted values are blanked before looking for it: the src's own
 * `.gif?` must not count. The `s=` signature binds the whole query (dropping `width=` answered 403), so
 * the url is passed through exactly as served, entities decoded.
 *
 * THE SIZE IS READ, NEVER GUESSED: the width from the src's own `width=` (it names the rendition, and the
 * served mp4 measured exactly 320x240), the height from that width over the aspect ratio of the
 * `<shreddit-aspect-ratio>` that wraps the player (the last one opened before it, not the first on the
 * page). If either is missing, both are 0, which every renderer already treats as "unknown".
 */
function gifPlayer(html: string): Media | null {
  for (const m of html.matchAll(/<shreddit-player\b[^>]*>/g)) {
    const tag = m[0]
    if (!/\sgif(?=[\s>=/])/.test(tag.replace(/"[^"]*"/g, '""'))) continue
    const attr = (name: string) => {
      const a = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
      return a ? decodeEntities(a[1]) : ''
    }
    const src = attr('src')
    const poster = attr('poster')
    // Reddit's own image hosts only. This url ends up in a Location header on our origin.
    if (!/^https:\/\/preview\.redd\.it\/[^?#]+\?(?:[^#]*&)?format=mp4(?:&|#|$)/.test(src)) return null
    if (!/^https:\/\/(?:external-)?preview\.redd\.it\//.test(poster)) return null
    const w = Number((src.match(/[?&]width=(\d+)(?:&|#|$)/) || [])[1])
    const before = html.slice(0, m.index)
    const wrap = before.slice(before.lastIndexOf('<shreddit-aspect-ratio'))
    const ar = Number((wrap.match(/^<shreddit-aspect-ratio\b[^>]*?--aspect-ratio:\s*([\d.]+)/) || [])[1])
    const sized = Number.isFinite(w) && w > 0 && Number.isFinite(ar) && ar > 0
    return { kind: 'video', url: src, w: sized ? w : 0, h: sized ? Math.round(w / ar) : 0, poster }
  }
  return null
}

/**
 * Media by post type (from the embed HTML + screenview). VIDEO is a `remux` video: Reddit serves
 * HLS/CMAF only (no progressive mp4 — the legacy DASH_{q}.mp4 files 404), which the /_media/ route
 * hands to the media-resolver container to mux to a playable MP4, with the external-preview cover as
 * the poster. WITHOUT the container, worker.ts's withResolver degrades it to that cover still, exactly
 * as it rendered before playback existed. Verified live 2026-07-22: a v.redd.it HLS muxed to a 13MB
 * progressive MP4 through the container.
 */
function redditEmbedMedia(html: string, post: Any): Media[] {
  const type = post?.type
  const url = typeof post?.url === 'string' ? post.url : ''

  /**
   * A 'gif' POST IS ITS PLAYER OR NOTHING, and the "nothing" is the important half.
   *
   * The placeholder-sub render (a bare /comments/{id} or /user/{name}/comments/{id} link, fetch.ts) has no
   * player at all, and loadPost writes whichever render it got under the post's CANONICAL cache key, the
   * same key a real-subreddit load uses (an empty-sub refKey does not parse, and /_media/ needs the real
   * sub). Falling back to the raw i.redd.it .gif there would put an IMAGE at index 0 of a post whose other
   * render puts the mp4 there, so the one /_media/{key}/0.mp4 url og:video promised could 302 to image
   * bytes, which is the sticky poisoned-url defect worker.ts's notReady() exists to prevent. Caught by an
   * adversarial review of this change before it shipped. Absent media at index 0 answers 404 instead,
   * which poisons nothing, and is exactly what a bare link to a gif post rendered before 2026-10-04.
   *
   * For the same reason a type:'image' post is NOT read for a player: its .gif fallback below is what both
   * renders have always agreed on, and reading the player for it would reopen the same disagreement.
   */
  if (type === 'gif') {
    const player = gifPlayer(html)
    if (player) return [player]
  }
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
  // 'gif' on a v.redd.it url: whether Reddit labels its is_gif VIDEOS 'gif' or 'video' has not been
  // measured. If it is 'gif', the video branch is the right reading of that url, and before 2026-10-04
  // this combination came back as no media at all, so routing it here cannot make a card worse.
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
  // file has not met yet, which is how 'gif' rendered as text only until 2026-10-04.
  return []
}

function buildFromEmbed(html: string, ref: Extract<PostRef, { p: 'rd' }>): Post | null {
  // NOT-FOUND / expired: no canonical, or a `/undefined` url. Reddit answers 200 for these, so this
  // is the content assertion, not a status check.
  const canon = html.match(/id="canonical-url-updater"\s+value="(https:\/\/www\.reddit\.com\/r\/([^/]+)\/comments\/([^/]+)[^"]*)"/)
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
  const sub = canon[2]
  const score = parseInt((html.match(/<faceplate-number number="(\d+)"/) || [])[1] || '', 10)
  const comments = parseInt(((html.match(/([\d,]+)\s+comments?/) || [])[1] || '').replace(/,/g, ''), 10)

  // selftext body (text posts only); the container id is stable, and the whole body is present
  // despite the CSS truncation. Title leads, body follows — Reddit's headline is the title.
  const bodyM = html.match(/<div id="t3_[a-z0-9]+-post-rtjson-content"[^>]*>([\s\S]*?)<\/div>/)
  const body = capBody(bodyM ? decodeEntities(stripTags(bodyM[1].replace(/<\/p>\s*<p[^>]*>/gi, '\n\n'))).trim() : '')

  return {
    ref: { p: 'rd', sub, id: ref.id },
    canonical: canon[1],
    author: { name: `u/${author}`, handle: author, url: `https://www.reddit.com/user/${author}` },
    // The title is the headline (bold, its own block); the body is the selftext (text posts only).
    // Keeping them separate is what lets the renderer differentiate the two — the concatenated
    // `title\n\nbody` this replaced rendered as one undifferentiated run.
    title,
    text: post.type === 'text' ? body : '',
    createdAt: created,
    media: redditEmbedMedia(html, post),
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
function redditOAuthMedia(d: Any): Media[] {
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

function buildFromOAuth(raw: unknown, ref: Extract<PostRef, { p: 'rd' }>): Post | null {
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
    // Title/body split so the renderer can bold the headline (same as the embed path); selftext capped.
    title: d.title,
    text: capBody(typeof d.selftext === 'string' ? d.selftext : ''),
    createdAt: created,
    media: redditOAuthMedia(d),
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

/** Pure: fetched Reddit data -> Post. Dispatches on `source`; a bare listing is the OAuth path. */
export function normalizeReddit(raw: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'rd') return null
  const r = raw as Any
  if (r?.source === 'embed') return buildFromEmbed(typeof r.html === 'string' ? r.html : '', ref)
  if (r?.source === 'json') return buildFromOAuth(r.data, ref)
  return buildFromOAuth(raw, ref)
}
