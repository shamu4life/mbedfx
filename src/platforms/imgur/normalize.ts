import type { Media, Post, PostRef } from '../../types.ts'
import { normalizeYtdlp, type MuxShortcut, type YtdlpMeta, type YtdlpSite } from '../ytdlp/normalize.ts'
import { imPageUrl, imThumb, type ImgurItem, type ImgurPost } from './fetch.ts'

/**
 * PURE: an Imgur API post -> a Post. Two builders live here because Imgur has two sources now:
 *
 *   normalizeImgurApi  — the JSON API. Albums, stills, and the metadata for everything.
 *   normalizeImgur     — the container's yt-dlp metadata, kept as the FALLBACK for a single so an
 *                        Imgur API outage or an exhausted rate limit degrades to what shipped before
 *                        the API existed instead of taking the platform down.
 */
const IM: YtdlpSite = { name: 'Imgur', handle: 'imgur', home: 'https://imgur.com' }

export function normalizeImgur(meta: YtdlpMeta | null, ref: PostRef, mux?: MuxShortcut): Post | null {
  if (ref.p !== 'im') return null
  return normalizeYtdlp(meta, ref, IM, imPageUrl(ref), mux)
}

/**
 * A PAYLOAD BOUND, NOT A DISPLAY RULE — and it was 4, which was wrong.
 *
 * That 4 came from misreading mastodon.ts's note that "Status::MEDIA_ATTACHMENTS_LIMIT is 4". That
 * number is MASTODON'S OWN SERVER-SIDE VALIDATION, quoted there to explain why Discord's consumer had
 * never been shown a MIXED gallery. It is not a limit this service applies: attachments() in
 * mastodon.ts iterates the whole list with no cap, which is why an Instagram carousel ships all
 * twelve of its slides. Capping Imgur at 4 made it the one platform that silently threw images away,
 * which is exactly what the owner caught.
 *
 * A bound is still wanted, because unlike every other gallery here an Imgur album is UNBOUNDED — a
 * few hundred images is an ordinary album, and each one costs a /_media/ slot and a line of JSON. 20
 * is comfortably above anything Discord will draw and far below anything that makes the payload
 * silly. Past it the remainder is reported in the text, since that is the only place a reader can
 * learn something was left out.
 */
const MAX_ITEMS = 20

const canonicalOf = (ref: Extract<PostRef, { p: 'im' }>): string =>
  ref.kind === 'album' ? `https://imgur.com/a/${ref.id}`
    : ref.kind === 'gallery' ? `https://imgur.com/gallery/${ref.id}`
      : `https://imgur.com/${ref.id}`

/**
 * ONE ITEM -> ONE Media entry.
 *
 * A MOVING ITEM IS EMITTED AS A VIDEO WITH A `remux` PAGE, not hand-flattened to its thumbnail, and
 * that is deliberate reuse rather than laziness: mastodon.ts already flattens every video in a
 * MULTI-item gallery to its poster still and appends the "🎬 Contains video" marker, and settleMux
 * already degrades a `{page}` remux to its poster when the container is absent or slow. Emitting the
 * honest shape gets both behaviours for free; flattening here would silently lose the marker and
 * would also lose playback on a single-item album, which is a real shape.
 *
 * A still needs no poster at all — an image is its own poster, the same note instagram's builder makes.
 */
function mediaOf(it: ImgurItem, alone: boolean): Media | null {
  if (it.kind === 'video' || it.animated) {
    return {
      kind: 'video',
      url: it.url,
      w: it.w,
      h: it.h,
      poster: imThumb(it.id),
      /**
       * REMUX ONLY WHEN THE VIDEO CAN ACTUALLY PLAY, i.e. when it is the post's only item.
       *
       * settleMux waits on EVERY entry carrying a `remux.page`, so putting one on each item of a
       * four-video album would block the render on four container muxes — for videos that are then
       * flattened to their posters anyway, because mastodon.ts converts every video in a MULTI-item
       * gallery to a still (Discord renders one player at most). Four muxes bought nothing and spent
       * the whole HTML deadline.
       *
       * A lone video is the opposite case: it renders a real inline player, which is the one thing
       * that widening must not trade away (see galleryHasVideo's "A SINGLE video is deliberately NOT
       * covered"), and the .gifv page is the surface yt-dlp answers as a video for any animated Imgur
       * item. Each entry remuxes from its OWN id rather than the post's, since an album's items are
       * separate posts upstream.
       *
       * The entry stays `kind: 'video'` either way, which is what keeps the "🎬 Contains video"
       * marker honest on a flattened gallery.
       */
      ...(alone ? { remux: { page: `https://i.imgur.com/${it.id}.gifv` } } : {}),
      ...(it.description ? { alt: it.description } : {}),
    }
  }
  return {
    kind: 'image',
    url: it.url,
    w: it.w,
    h: it.h,
    ...(it.description ? { alt: it.description } : {}),
  }
}

/**
 * The body. Imgur posts frequently have NO description at all — the title carries everything — so
 * this is often just the overflow note, and often empty.
 */
function bodyOf(p: ImgurPost, shown: number): string {
  const parts: string[] = []
  if (p.description) parts.push(p.description)
  const hidden = p.total - shown
  // Only when something is genuinely hidden. "+0 more" on a 4-image album would be a lie by rounding.
  if (hidden > 0) parts.push(`+${hidden} more ${hidden === 1 ? 'image' : 'images'} on Imgur`)
  return parts.join('\n\n')
}

/**
 * TOTAL OVER JUNK, like every normalizer here: a shape we do not recognise returns null and renders
 * the neutral failure card rather than throwing inside a request.
 */
export function normalizeImgurApi(p: ImgurPost | null, ref: PostRef): Post | null {
  if (!p || ref.p !== 'im') return null
  const items = Array.isArray(p.items) ? p.items.slice(0, MAX_ITEMS) : []
  const media = items.map(it => mediaOf(it, items.length === 1)).filter((m): m is Media => m !== null)
  if (!media.length) return null

  const who = p.uploader
  const created = p.createdAt ? new Date(p.createdAt) : null

  return {
    ref,
    canonical: canonicalOf(ref),
    author: {
      // An anonymous Imgur upload has no account at all, which is the common case for a direct link.
      // The platform byline is then the honest answer, exactly as the yt-dlp tier does it.
      name: who ?? IM.name,
      handle: who ?? IM.handle,
      url: who ? `https://imgur.com/user/${encodeURIComponent(who)}` : IM.home,
      ...(p.uploaderAvatar ? { avatar: p.uploaderAvatar } : {}),
    },
    ...(p.title ? { title: p.title } : {}),
    text: bodyOf(p, media.length),
    // An unparseable or absent timestamp becomes "now" rather than Invalid Date, which renders as
    // the string "Invalid Date" on a card. The same guard the other clients apply.
    createdAt: created && Number.isFinite(created.getTime()) ? created : new Date(),
    media,
    counts: {},
    sensitive: p.mature === true,
  }
}
