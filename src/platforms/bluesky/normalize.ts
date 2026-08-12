import type { Media, Post, PostRef, Profile, ProfileRef } from '../../types.ts'

type Any = Record<string, any>

// Bluesky's self-label content-warning vocabulary (the `val` values a labeler
// attaches via com.atproto.label.defs#label). Third-party labelers can apply
// arbitrary non-sensitive labels (spam, community moderation, etc.), so we key
// off these specific values rather than "any label is present".
const SENSITIVE_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media'])

/** at://{did-or-handle}/app.bsky.feed.post/{rkey} -> a ref of that post's own identity. */
function refFromUri(uri: unknown, fallbackHandle: string): Extract<PostRef, { p: 'bs' }> | null {
  if (typeof uri !== 'string') return null
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/)
  if (!m) return null
  return { p: 'bs', handle: fallbackHandle || m[1], rkey: m[2] }
}

/**
 * Builds a Media object, omitting `alt` entirely (never `alt: undefined`) when
 * there is no non-empty alt text — Media.alt is optional, and a Post is expected
 * to structurally match whether alt was absent from the source or merely blank.
 */
function mediaObj(kind: 'image' | 'video', url: string, w: number, h: number, rawAlt: unknown): Media {
  const alt = typeof rawAlt === 'string' && rawAlt ? rawAlt : undefined
  return alt === undefined ? { kind, url, w, h } : { kind, url, w, h, alt }
}

/** Pushes any `{fullsize, alt, aspectRatio}` entries (images[] or gallery#view items[]) as image Media. */
function pushImages(out: Media[], imgs: unknown): void {
  if (!Array.isArray(imgs)) return
  for (const im of imgs) {
    if (typeof im?.fullsize !== 'string') continue
    out.push(mediaObj('image', im.fullsize, im.aspectRatio?.width ?? 0, im.aspectRatio?.height ?? 0, im.alt))
  }
}

/**
 * `embed` is either a single view (postView.embed, viewRecord's outer embed) or an
 * array of views (viewRecord.embeds[] — the lexicon gives quoted posts a PLURAL
 * `embeds` array, unlike postView's singular `embed`). Both shapes parse the same way.
 */
function mediaFrom(embed: Any | Any[] | undefined): Media[] {
  if (!embed) return []
  const out: Media[] = []
  for (const e of Array.isArray(embed) ? embed : [embed]) {
    if (!e) continue
    pushImages(out, e.images ?? e.media?.images)
    // app.bsky.embed.gallery#view: { items: [{ thumbnail, fullsize, alt, aspectRatio }] }
    // recordWithMedia#view.media also carries gallery#view with items, so fallback needed here too
    pushImages(out, e.items ?? e.media?.items)
    // Bluesky video embeds carry `playlist`, an HLS (.m3u8) MANIFEST — not a progressive file —
    // which Discord's embed player cannot play directly. So it becomes a REMUX video: the /_media/
    // route hands the playlist to the resolver container, which muxes it to a progressive MP4, with
    // the video's own `thumbnail` as the poster. Without the container bound, worker.ts's withResolver
    // degrades it to that thumbnail STILL — exactly the plain IMAGE the Phase 1 fix rendered, so the
    // no-container render is byte-identical to before. Verified live 2026-07-22 that HLS muxes through
    // the container (via the shared Reddit HLS path). A remux video needs BOTH a playlist and a
    // thumbnail (its guaranteed still); with only a thumbnail it stays a plain image, and with neither
    // we emit nothing rather than a broken video.
    // app.bsky.embed.video#view carries playlist/thumbnail at its TOP LEVEL — as the embed `e`
    // itself when the post IS a video, or as `e.media` under a recordWithMedia#view. (A nested
    // `.video` shape is also accepted, defensively.) Identify the view by a string `playlist`; the
    // earlier `e.video ?? e.media?.video` spelling matched only the nested form and so found NOTHING
    // on a real Bluesky video, rendering every one as a text-only card.
    const v = typeof e.playlist === 'string' ? e
      : typeof e.media?.playlist === 'string' ? e.media
        : e.video ?? e.media?.video
    if (v && typeof v.thumbnail === 'string') {
      const w = v.aspectRatio?.width ?? 0
      const h = v.aspectRatio?.height ?? 0
      if (typeof v.playlist === 'string' && v.playlist) {
        out.push({ ...mediaObj('video', v.playlist, w, h, v.alt), poster: v.thumbnail, remux: { video: v.playlist } })
      } else {
        out.push(mediaObj('image', v.thumbnail, w, h, v.alt))
      }
    }
  }
  return out
}

/**
 * Build a Post from an AT post object. `ref` is that post's OWN identity — never
 * the root's. A quote sharing the root's ref would make /_media/{refKey}/{i}
 * resolve against the root's media[], serving the wrong image.
 *
 * `embed` is passed in rather than read off `p.embed`, because the shape of "this
 * post's embed(s)" differs by caller: postView (root/parent) has singular `embed`,
 * but app.bsky.embed.record#viewRecord (quote) has a plural `embeds` array and no
 * singular `embed` at all. mediaFrom() accepts either shape.
 */
function build(p: Any, ref: Extract<PostRef, { p: 'bs' }>, record: Any, embed: Any | Any[] | undefined): Post | null {
  const author = p?.author
  if (!record || typeof record.text !== 'string' || !author?.handle) return null
  const created = new Date(record.createdAt ?? p.indexedAt ?? NaN)
  if (Number.isNaN(created.getTime())) return null
  return {
    ref,
    canonical: `https://bsky.app/profile/${ref.handle}/post/${ref.rkey}`,
    author: {
      name: author.displayName || author.handle,
      handle: author.handle,
      url: `https://bsky.app/profile/${author.handle}`,
      avatar: typeof author.avatar === 'string' ? author.avatar : undefined,
    },
    text: record.text,
    createdAt: created,
    media: mediaFrom(embed),
    counts: { likes: p.likeCount, reposts: p.repostCount, replies: p.replyCount },
    // Bluesky exposes moderation labels on the record; only specific label VALUES
    // mean sensitive — a third-party labeler's "spam" tag must not count.
    sensitive: Array.isArray(p.labels) && p.labels.some((l: Any) => SENSITIVE_LABELS.has(l?.val)),
  }
}

/**
 * Pure: raw AT Protocol JSON -> Post. No I/O. Returns null rather than inventing
 * a Post, because a half-built Post renders as a broken embed.
 * Quote and replyTo are capped at depth 1 — build() never recurses.
 */
/**
 * A NON-NEGATIVE INTEGER COUNT, or undefined — never a coerced 0.
 *
 * The distinction is the whole honesty rule of a profile card: `0` is a real answer (a new account
 * has no followers) and prints as one, while "the payload did not carry this field" must print
 * NOTHING. `Number(undefined)` is NaN and `undefined ?? 0` is 0, so both of the obvious spellings
 * turn a missing field into a claim.
 */
function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined
}

/**
 * THE AVATAR HOST ALLOWLIST, and it is what lets a Profile carry an ORIGIN url where a Post may
 * only carry a /_media/ one.
 *
 * Media.url's rule exists because those urls "may be signed and expiring" — a TikTok avatar url
 * carries x-expires and x-signature, and Discord caches an og:image BY URL, so an expiring one
 * becomes a broken picture on a card that outlives it. Bluesky's CDN is the opposite, and that was
 * measured rather than assumed: the avatar in the getProfile payload is
 * `https://cdn.bsky.app/img/avatar/plain/{did}/{cid}@jpeg` — content-addressed, no query string, no
 * signature, no expiry (2026-08-11, from Cloudflare egress). It is the url every Bluesky client
 * hotlinks.
 *
 * SO THE PREFIX IS AN ASSERTION, not decoration. If the appview ever starts handing out signed urls
 * on another host this drops the avatar and the card renders without a picture — the honest degrade
 * — rather than shipping a link that 403s a week later inside Discord's cache.
 */
const BS_CDN = 'https://cdn.bsky.app/'

/**
 * getProfile -> Profile. PURE, and every field is either present in the payload or absent from the
 * card; nothing here computes a plausible value.
 *
 * THE IDENTITY ASSERTION IS `handle`, NOT THE STATUS CODE. fetchBlueskyProfile already refuses a
 * non-JSON body; this refuses a body with no handle in it, which is what an error envelope served
 * at HTTP 200 would look like. Everything else may be missing — a card with a handle and nothing
 * else is still true.
 *
 * `handle` COMES FROM THE PAYLOAD, not from the ref: a DID url resolves to the account's CURRENT
 * handle, and a renamed account's old handle 400s. So the card names the account the way Bluesky
 * does now, and `canonical` is rebuilt from that same handle — the "normalizer owns its canonical"
 * split TikTok, Instagram and Threads already use.
 *
 * A HANDLE OF `handle.invalid` IS KEPT AS-IS. That is what the appview returns while an account's
 * DNS or HTTPS handle verification is failing, and it is honest: the account really is unverifiable
 * at that moment. Rewriting it to the DID would be tidier and would state something the payload
 * does not.
 */
export function normalizeBlueskyProfile(raw: unknown, ref: ProfileRef): Profile | null {
  if (ref.p !== 'bs') return null
  const r = raw as Any
  const handle = typeof r?.handle === 'string' && r.handle ? r.handle : ''
  if (!handle) return null
  const avatar = typeof r.avatar === 'string' && r.avatar.startsWith(BS_CDN) ? r.avatar : undefined
  // A date the payload does not carry, or carries as junk, is ABSENT — never the epoch, which is the
  // 1970 card this project has already shipped once. `new Date(junk)` is an Invalid Date, not a throw.
  const created = typeof r.createdAt === 'string' ? new Date(r.createdAt) : null
  const createdAt = created && !Number.isNaN(created.getTime()) ? created : undefined
  const followers = count(r.followersCount)
  const following = count(r.followsCount)
  const posts = count(r.postsCount)
  return {
    ref,
    canonical: `https://bsky.app/profile/${handle}`,
    handle,
    name: typeof r.displayName === 'string' ? r.displayName : '',
    bio: typeof r.description === 'string' ? r.description : '',
    ...(avatar ? { avatar } : {}),
    ...(createdAt ? { createdAt } : {}),
    counts: {
      ...(followers === undefined ? {} : { followers }),
      ...(following === undefined ? {} : { following }),
      ...(posts === undefined ? {} : { posts }),
    },
  }
}

export function normalizeBluesky(raw: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'bs') return null
  const r = raw as Any
  const p = r?.thread?.post
  if (!p) return null

  const post = build(p, ref, p.record, p.embed)
  if (!post) return null

  const parent = r.thread?.parent?.post
  if (parent) {
    const pref = refFromUri(parent.uri, parent.author?.handle)
    if (pref) {
      const rp = build(parent, pref, parent.record, parent.embed)
      if (rp) post.replyTo = rp // depth 1: build() never sets replyTo/quote
    }
  }

  const rec = p.embed?.record?.record ?? p.embed?.record
  if (rec?.value?.text && rec?.author?.handle) {
    const qref = refFromUri(rec.uri, rec.author.handle)
    if (qref) {
      // viewRecord carries its media as `embeds` (plural array), not `embed`.
      const q = build(rec, qref, rec.value, rec.embeds)
      if (q) post.quote = q // depth 1
    }
  }

  return post
}
