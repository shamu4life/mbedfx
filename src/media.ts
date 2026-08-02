import type { Media, MediaIndex, Post } from './types.ts'
import { mediaOf } from './render/embed.ts'

/**
 * Everything /_media/{refKey}/{i} can address: the post's own media, then its quoted post's,
 * hoisted onto the end. ONE definition, because an index only means anything if every consumer
 * counts the same list — pickMedia below resolves the URL, mastodon.ts emits it and discord.ts's
 * gate decides whether to advertise any picture at all, and two of those disagreeing is how an
 * embed ends up pointing at the wrong image or at none.
 *
 * VERIFIED FxEmbed behaviour (spec §7): a quoted post's images appear in the PARENT's
 * media_attachments — proven by resolving an attachment's DID to the quoted author and matching
 * the CID. Phase 1 fought a real bug to extract this data at all (quote media was always
 * dropped, because app.bsky.embed.record#viewRecord carries a plural `embeds` array and no
 * singular `embed`), so dropping it here would spend that fix on nothing, and a quote-only post
 * has no picture of its own to fall back to.
 *
 * PARENT FIRST, always. That ordering is the entire compatibility argument: the post's own media
 * keep indices 0..n-1, so every /_media/ URL Phase 1 ever emitted still names the same bytes and
 * the plain-og head's og:image selection is untouched. Hoisted entries can only ever appear
 * after the last parent slot — INCLUDING the dead ones, since neither this nor any caller
 * compacts (see mediaOf).
 *
 * RAISES THE GALLERY CEILING, which nothing else records. Bluesky caps a post at 4 images and
 * normalize.ts adds no cap of its own, so media_attachments.length <= 4 used to be structurally
 * guaranteed; a 4-image post quoting a 4-image post now yields 8. That is past every fixture the
 * spec's evidence sweep measured (§5 covered 0/1/2/3/4) and past what a real Mastodon server ever
 * returns, and §9 already flags multi-image rendering as the known weak spot. No client-visible
 * failure is demonstrated — this is a LIVE GATE item, the second thing to check in front of a
 * real Discord client after the quote-only case.
 *
 * INSTAGRAM MOVED THAT FROM A RARE EDGE TO THE ORDINARY CASE, and the change of frequency is the
 * whole point of this paragraph. The 8-item case above needs a 4-image post quoting a 4-image
 * post — rare enough to defer. A CAROUSEL IS THE ORDINARY SHAPE OF INSTAGRAM: the committed
 * fixture is 10 entries, 4 of them video and interleaved with images, and the platform permits up
 * to 20. So >4 is now routine production output rather than a corner, and it arrives with two
 * further firsts the plan names (§"GENUINELY NEW"): the first MIXED type:image/type:video array
 * this service has ever emitted, and the first gallery carrying more than one video.
 *
 * STILL NOT A DEMONSTRATED FAILURE, and deliberately not "fixed" by capping here. Whether Discord
 * renders a mixed 10-item gallery is UNKNOWN and cannot be settled locally — Phase 2 established
 * that Discord's embed debugger does not render the spoof path faithfully, so the answer comes
 * from a human looking at a phone. If it degrades, CAPTURE WHAT THE CLIENT SHOWS AND TAKE IT TO
 * THE HUMAN; do not guess at a subtraction here (three speculative single-tag subtractions were
 * already wrong once on the TikTok video head). The dispatch seam pins the count of 10 and the
 * interleaved types end-to-end; the og:video-index question on a carousel whose first video sits
 * at position 3 belongs to the mixed-gallery task, not here.
 *
 * Exactly ONE level deep, and not because the normalizer promises depth 1 (it does —
 * post.quote.quote is always undefined). A cache record is not the normalizer's output by the
 * time it reaches here: deserializePost validates a nested quote's ref, canonical and createdAt
 * and nothing else, so a corrupted or hostile record can carry a deeper chain, or a quote that
 * IS the post. Reading one level makes an unbounded walk structurally impossible rather than
 * merely unlikely, on a route that worker.ts calls outside any try/catch.
 */
export const mediaList = (post: Post): Media[] => [...mediaOf(post), ...mediaOf(post?.quote)]

/**
 * Resolve a /_media/{refKey}/{index} URL to the origin CDN URL held in the cached Post.
 *
 * The caller reads the Post CACHE — it does not re-fetch upstream per image. An
 * 8-image carousel triggers 8 media hits; re-resolving each would mean 8 upstream
 * fetches per viewing client, on the platforms we rate most fragile.
 * InstaFix-Revived's offload handler does the same and states the rationale:
 * "one place to refresh cached scrape data before redirecting bots to image/video bytes."
 */
/**
 * The Media ENTRY at a numeric index (never a poster/avatar), for the /_media/ route's remux check —
 * it needs the object (`remux`, `poster`), not just the url pickMedia returns. Same defensive reads
 * and same mediaList as pickMedia, because the input is the cache, not the normalizer: a corrupted
 * record can hold `media: 42` or a hole, which must become null, never a throw on a no-try/catch route.
 */
export function pickMediaEntry(post: Post, index: MediaIndex): Media | null {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  const list = mediaList(post)
  if (index >= list.length) return null
  const m: unknown = list[index]
  return m && typeof m === 'object' ? (m as Media) : null
}

export function pickMedia(post: Post, index: MediaIndex): string | null {
  // Every read below is defensive because the input is the CACHE, not the normalizer.
  // deserializePost validates ref, canonical and createdAt and nothing else — it never looks
  // at media[] or author — so a corrupted record carrying `media: [null, …]`, `media: 42` or
  // `author: null` passes the guard and arrives here intact. The naive reads
  // (`post.author.avatar`, `post.media.length`, `post.media[i].url`) each THROW on one of
  // those, and worker.ts's media branch has no try/catch: that is an uncaught 500 on a public
  // path whose index segment the caller chooses, on the one route whose whole contract is to
  // degrade. cache.ts states the rule this satisfies — the guard "must be total between a
  // corrupted cache entry and served output".
  const url = (v: unknown) => (typeof v === 'string' && v ? v : null)
  if (index === 'avatar') return url(post.author?.avatar)

  // The POSTER FRAME of media[i] — a still image, never the video (see types.ts's Media.poster).
  // Resolved before the numeric path and through the same mediaList + range check, so a poster
  // index is exactly as total against a corrupted cache record as its bare sibling: the entry can
  // be null or a primitive, and `poster` itself is a field deserializePost never looks at, so a
  // number or an object can arrive here and must become null rather than a Location header.
  //
  // NO FALLBACK TO m.url. A posterless video resolves to null and 404s, and that is the point:
  // handing back the video is the defect this whole change removes, and a fallback here would
  // reinstate it behind the renderer's back on exactly the posts whose cover we failed to read.
  if (typeof index === 'object' && index !== null) {
    const i = index.poster
    const list = mediaList(post)
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return null
    const m: unknown = list[i]
    return m && typeof m === 'object' ? url((m as { poster?: unknown }).poster) : null
  }

  // mediaList, not post.media: a hoisted quote image is addressable only through the PARENT's
  // refKey, because the quoted post is nested inside the parent's cache entry and was never
  // cached under its own key. Resolving it here is what makes the URL mastodon.ts emits for it
  // mean anything — the two index the same list by construction.
  //
  // A non-array media is `[]`, not a throw (mediaOf's guard, applied to the quote as well as
  // the post). Number.isInteger already rejects 'avatar'-shaped leftovers, NaN and fractions;
  // the range check is what keeps a caller-chosen index from reading past the end.
  const list = mediaList(post)
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null

  // A hole is a 404, never a Location header. `url || null` used to hand back whatever the
  // entry held — a NUMBER for `url: 42` — and worker.ts feeds this straight into a 302
  // Location, which either coerces to a nonsense redirect or throws inside Response.
  const m: unknown = list[index]
  return m && typeof m === 'object' ? url((m as { url?: unknown }).url) : null
}
