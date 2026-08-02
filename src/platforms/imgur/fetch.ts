import type { Env } from '../../analytics.ts'
import type { PostRef } from '../../types.ts'
import { IM_ID } from '../../refkey.ts'

/**
 * IMGUR, VIA IMGUR'S OWN JSON API — not the container.
 *
 * WHY THIS FILE EXISTS AT ALL. Imgur used to be a pure yt-dlp platform with no egress, and that put a
 * hard ceiling on it that had nothing to do with Imgur. yt-dlp's Imgur extractor opens by refusing
 * anything that is not moving:
 *
 *     ERROR: [Imgur] QAcLnaf: QAcLnaf is not a video or animated image
 *
 * Measured 2026-07-31 against a real 1275x1234 JPEG, exit code 1. Every still photo on the site was
 * unreachable by construction, and an album came back as `_type: 'playlist'` whose top-level object
 * carries a title and nothing else — which normalizeYtdlp correctly refuses, because a card built
 * from it would be a bare headline over a video url that resolves to nothing.
 *
 * SCRAPING IS NOT THE ALTERNATIVE, which is worth stating because it is the obvious next idea. The
 * Imgur page emits exactly ONE og:image — the album cover — under a browser UA and under Discordbot
 * alike. That is precisely what Discord already does with a raw Imgur link, so a scraper would ship
 * the status quo. The `postDataJSON` blob some pages carry is not a fallback either: present on one
 * album, absent on another, and absent entirely under the Discordbot UA. All measured the same day.
 *
 * The API answers all of it in one request: title, description, created_at, is_mature, the uploader's
 * username, image_count, and every item with type/mime/dimensions/url.
 */

/**
 * The client id yt-dlp ships in its own public source. A DELIBERATE, DOCUMENTED FALLBACK rather than a
 * secret: see Env.IMGUR_CLIENT_ID. It works, and it means this feature needed no account to ship —
 * but it is a shared 12,500/day bucket, so an owner-registered id is strictly better.
 */
const PUBLIC_CLIENT_ID = '546c25a59c58ad7'

/** Imgur's API is a fixed origin, so there is no host to validate — unlike the fediverse clients. */
const API = 'https://api.imgur.com/post/v1'

/** What a media item looks like once we have decided we can use it. */
export type ImgurItem = {
  /** Imgur's own id for this item, which is also how its poster url is spelled. */
  id: string
  url: string
  kind: 'image' | 'video'
  w: number
  h: number
  animated: boolean
  description?: string
}

/**
 * Imgur's thumbnail convention: the item id with a size suffix. 'h' is the largest ("huge", 1024px),
 * which is what yt-dlp reports as the thumbnail for a gifv and what a poster wants — a postage stamp
 * would be worse than no poster at all. Always .jpg, whatever the source was.
 */
export const imThumb = (id: string): string => `https://i.imgur.com/${id}h.jpg`

export type ImgurPost = {
  id: string
  title?: string
  description?: string
  createdAt?: string
  uploader?: string
  uploaderAvatar?: string
  mature: boolean
  /** What Imgur says the post holds, which can exceed items.length once we cap for Discord. */
  total: number
  items: ImgurItem[]
}

export type ImgurFetch =
  | { ok: true; post: ImgurPost }
  | { ok: false; reason: 'assert_fail' }

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0

/**
 * ONE ITEM. Returns null for anything we cannot put on a card, and the caller SKIPS those rather than
 * emitting a hole — /_media/{refKey}/{i} indexes the array we build, so a null would shift every
 * later picture onto the wrong slot. Same rule instagram's carousel builder follows.
 */
function item(raw: unknown): ImgurItem | null {
  const m = raw as Record<string, unknown> | null
  const url = str(m?.url)
  // https ONLY, and on Imgur's own CDN. The url is echoed into a 302 from /_media/, so an attacker
  // who could get an arbitrary host in here would have an open redirect on our origin.
  if (!url || !/^https:\/\/i\.imgur\.com\/[\w.-]+$/.test(url)) return null
  const mime = str(m?.mime_type) ?? ''
  const meta = (m?.metadata ?? {}) as Record<string, unknown>
  const animated = meta.is_animated === true
  // Imgur calls an animated GIF `type: 'image'` with `is_animated: true`, and an mp4 `type: 'video'`.
  // The card only cares whether it MOVES, because a moving thing needs a poster and a still does not.
  const kind: 'image' | 'video' = mime.startsWith('video/') ? 'video' : 'image'
  // The id is shape-checked like every other Imgur id: it is interpolated into a poster url and, for
  // an animated item, into the container page url the mux fetches.
  const id = str(m?.id)
  if (!id || !IM_ID.test(id)) return null
  return {
    id,
    url,
    kind,
    w: num(m?.width),
    h: num(m?.height),
    animated,
    description: str(meta.description),
  }
}

/** Which endpoints answer for a given ref kind, in the order they should be tried. */
const ENDPOINTS: Record<'post' | 'album' | 'gallery', readonly string[]> = {
  // Measured 2026-07-31: `media/{id}` 404s on an album id and `albums/{id}` 404s on a single, so a
  // /gallery/ link — which can legally be either — has to try both. There is no unified endpoint;
  // `posts/{id}` behaves identically to `albums/`.
  post: ['media'],
  album: ['albums'],
  gallery: ['albums', 'media'],
}

/**
 * ASSERT ON CONTENT, NEVER STATUS — the house rule. Imgur is better behaved than Meta (a genuine 404
 * for a missing post), but the check that decides a card is "did we get usable media", not "was it a
 * 200". A deleted album and a typo'd id are both `assert_fail` and render the neutral "couldn't load"
 * card; NEITHER is a gate, because Imgur does not tell us it was private, only that it is not there.
 */
export async function fetchImgur(
  ref: Extract<PostRef, { p: 'im' }>,
  env: Env,
): Promise<ImgurFetch> {
  if (!IM_ID.test(ref.id)) return { ok: false, reason: 'assert_fail' }
  const clientId = str(env.IMGUR_CLIENT_ID) ?? PUBLIC_CLIENT_ID

  for (const endpoint of ENDPOINTS[ref.kind]) {
    const url =
      `${API}/${endpoint}/${encodeURIComponent(ref.id)}` +
      `?client_id=${encodeURIComponent(clientId)}&include=media,account`
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (res.status !== 200) continue

    let j: Record<string, unknown>
    try {
      j = await res.json() as Record<string, unknown>
    } catch {
      continue
    }

    const media = Array.isArray(j.media) ? j.media : []
    const items = media.map(item).filter((x): x is ImgurItem => x !== null)
    if (!items.length) continue

    const account = (j.account ?? {}) as Record<string, unknown>
    return {
      ok: true,
      post: {
        id: typeof j.id === 'string' ? j.id : ref.id,
        title: str(j.title),
        description: str(j.description),
        createdAt: str(j.created_at),
        uploader: str(account.username),
        uploaderAvatar: str(account.avatar_url),
        mature: j.is_mature === true,
        // image_count is Imgur's own count and is what "+N more" must be derived from — items.length
        // is already capped and would always report "nothing hidden".
        total: num(j.image_count) || items.length,
        items,
      },
    }
  }
  return { ok: false, reason: 'assert_fail' }
}

/**
 * THE PAGE URL THE CONTAINER FETCHES for an animated single. Unchanged from when Imgur was a pure
 * yt-dlp platform, and still the right url for that one case: i.imgur.com/{id}.gifv is the surface
 * yt-dlp's extractor answers as a VIDEO.
 */
export function imPageUrl(ref: Extract<PostRef, { p: 'im' }>): string {
  return `https://i.imgur.com/${ref.id}.gifv`
}
