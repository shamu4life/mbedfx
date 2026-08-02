import type { Media, Post, PostRef } from '../../types.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'

/** PURE: a Pinterest pin -> a Post. No I/O. */

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * THE TITLE, AND WHY IT IS NOT `title`.
 *
 * Measured: a real pin returns `title: ''` and carries its actual headline in `grid_title`
 * ("Great grandma's Dilly Bread"). Reading `title` alone gives an empty card headline on pins that
 * plainly have one. `seo_title` and `closeup_unified_title` are further fallbacks seen in the wild.
 */
export function pinTitle(pin: Record<string, unknown>): string {
  const cu = obj(pin.closeup_unified_title)
  return str(pin.grid_title) || str(pin.title) || str(pin.seo_title) || str(cu?.text) || ''
}

/**
 * THE VIDEO, when there is one — and `is_video` IS NOT THE TEST.
 *
 * Measured on three pins that all carry a full `videos.video_list` with a playable `V_720P`:
 * every one reported `is_video: false`. Gating on that flag would drop the video on exactly the
 * pins that have it. The presence of a rendition is the only honest test.
 *
 * V_720P IS A REAL PROGRESSIVE MP4 and needs no remux: measured `content-type: video/mp4`, HTTP 206
 * on a range request, first bytes `ftypisom`. It also serves to a Discordbot UA and to NO user-agent
 * at all, which is why this platform keeps the plain /_media/ 302 instead of streaming bytes the way
 * Instagram and Twitch must.
 *
 * The HLS renditions (V_HLSV4, V_HLSV3_MOBILE) are deliberately ignored: Discord cannot play HLS, and
 * advertising one as og:video is the dead-player defect this project fixed in Phase 1.
 */
export function pinVideo(pin: Record<string, unknown>): { url: string; w: number; h: number } | null {
  const list = obj(obj(pin.videos)?.video_list)
  if (!list) return null
  for (const key of ['V_720P', 'V_EXP7', 'V_EXP6', 'V_EXP5', 'V_EXP4', 'V_EXP3']) {
    const q = obj(list[key])
    const url = str(q?.url)
    // .mp4 ONLY. The same list holds HLS manifests, and a key name is not evidence of a container.
    if (/^https:\/\/[^/]*pinimg\.com\/.*\.mp4(?:\?|$)/i.test(url)) {
      return { url, w: num(q?.width), h: num(q?.height) }
    }
  }
  return null
}

/**
 * THE PICTURE. `images.orig` is the untouched upload; the rest of the ladder (736x, 564x, 474x, 236x,
 * 170x, 136x136, 60x60) are downscales, and `600x315` is a CROP for link previews — the same
 * square-crop trap that produced the reported Instagram carousel defect, so it is never selected.
 */
export function pinImage(pin: Record<string, unknown>): { url: string; w: number; h: number } | null {
  const images = obj(pin.images)
  const orig = obj(images?.orig)
  const url = str(orig?.url)
  if (/^https:\/\//i.test(url)) return { url, w: num(orig?.width), h: num(orig?.height) }
  // Fall back down the ladder, largest first, skipping the crop.
  for (const key of ['736x', '564x', '474x', '236x', '170x']) {
    const c = obj(images?.[key])
    const u = str(c?.url)
    if (/^https:\/\//i.test(u)) return { url: u, w: num(c?.width), h: num(c?.height) }
  }
  return null
}

export function normalizePinterest(
  pin: Record<string, unknown>,
  ref: Extract<PostRef, { p: 'pn' }>,
): Post {
  const pinner = obj(pin.pinner)
  const board = obj(pin.board)
  const video = pinVideo(pin)
  const image = pinImage(pin)

  const media: Media[] = []
  if (video) {
    media.push({
      kind: 'video',
      url: video.url,
      w: video.w || image?.w || 0,
      h: video.h || image?.h || 0,
      // MANDATORY on a video — a posterless video drops Discord's rich card to plain OpenGraph
      // (types.ts, Media.poster). The pin's own still is the poster.
      ...(image ? { poster: image.url } : {}),
    })
  } else if (image) {
    media.push({ kind: 'image', url: image.url, w: image.w, h: image.h })
  }

  const handle = str(pinner?.username)
  // A pin's DESCRIPTION is the body; the board is the context a pin has instead of a community, and
  // it is the one piece a reader cannot infer from the picture.
  const desc = str(pin.description).trim()
  const boardName = str(board?.name)
  const text = [desc, boardName ? `Board: ${boardName}` : ''].filter(Boolean).join('\n\n')

  const stats = obj(obj(pin.aggregated_pin_data)?.aggregated_stats)

  return {
    ref,
    // The slug in `/pin/{slug}--{id}/` is IGNORED by Pinterest itself (verified: an invented slug
    // returns the same pin), so the canonical is the bare id form.
    canonical: new URL(`https://www.pinterest.com/pin/${encodeURIComponent(ref.id)}/`).href,
    author: {
      name: str(pinner?.full_name) || handle || 'Pinterest',
      handle,
      url: handle
        ? new URL(`https://www.pinterest.com/${encodeURIComponent(handle)}/`).href
        : 'https://www.pinterest.com',
      ...(/^https:\/\//i.test(str(pinner?.image_medium_url))
        ? { avatar: str(pinner?.image_medium_url) }
        : {}),
    },
    title: pinTitle(pin) || undefined,
    text,
    createdAt: uploadDateOrEpoch(str(pin.created_at)),
    media,
    counts: {
      // Pinterest's unit of approval is a SAVE, which is the closest analogue to a like here.
      likes: num(stats?.saves) || num(pin.repin_count) || undefined,
      replies: num(pin.comment_count) || undefined,
    },
    // Pinterest exposes no per-pin NSFW flag on this payload. Claiming one would be inventing a
    // signal; the absence is honest.
    sensitive: false,
  }
}
