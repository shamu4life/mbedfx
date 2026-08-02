import type { Media, Post, PostRef } from '../../types.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'

/** PURE: a PeerTube `Video` -> a Post. No I/O. */

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const https = (v: unknown): boolean => /^https:\/\//i.test(str(v))

const BODY_CAP = 900
const capBody = (s: string): string => (s.length <= BODY_CAP ? s : `${s.slice(0, BODY_CAP - 1)}…`)

/**
 * THE RENDITION CEILING, and both halves were measured rather than guessed.
 *
 * HEIGHT: 720 is the same ceiling Twitch uses here, for the same reason — it is the largest that
 * reliably survives Discord's media proxy while still looking like video rather than a thumbnail.
 *
 * BYTES: PeerTube hosts LONG videos, which is the difference from every other direct-serve platform
 * in this project. Measured 2026-07-30: a 215-second framatube clip ships a 185 MB 1080p rendition,
 * and a 24-minute Blender video ships 179 MB at 1080p / 73 MB at 480p. Handing Discord a 185 MB url
 * is not a video embed, it is a timeout. The cap is applied to the SELECTED file, so a long video
 * simply falls through to its cover still rather than promising a player that will never load.
 */
const MAX_HEIGHT = 720
const MAX_BYTES = 100 * 1024 * 1024

/**
 * THE BEST RENDITION IN ONE FILE LIST. Shared by both lists peertubeFile consults; see it for why
 * there are two.
 *
 * "AUDIO ONLY" IS A REAL ENTRY AND MUST BE EXCLUDED. Every instance sampled ships one, at 0x0 — and
 * it is a genuine mp4, so a naive "first .mp4 wins" selects a file with no picture in it. Requiring a
 * positive height is what keeps it out, and it is why the HEIGHT is tested rather than the label.
 *
 * .mp4 IS ASSERTED ON THE URL, never on the resolution label: a label is not evidence of a container,
 * and the same list on an HLS instance sits beside an .m3u8 that must never be selected.
 *
 * Picks the LARGEST rendition inside both ceilings, so a video offering only a 1080p file yields
 * nothing and the card degrades to its cover rather than to a player that will time out.
 */
function pickFrom(list: unknown[]): { url: string; w: number; h: number } | null {
  let best: { url: string; w: number; h: number } | null = null
  for (const raw of list) {
    const f = obj(raw)
    if (!f) continue
    const url = str(f.fileUrl)
    // .mp4 ONLY, asserted on the URL: the resolution LABEL is not evidence of a container.
    if (!https(url) || !/\.mp4(?:\?|$)/i.test(url)) continue
    const h = num(f.height)
    const w = num(f.width)
    if (h <= 0 || w <= 0) continue                    // the "Audio only" 0x0 entry
    if (h > MAX_HEIGHT) continue
    const size = num(f.size)
    if (size > 0 && size > MAX_BYTES) continue
    if (!best || h > best.h) best = { url, w, h }
  }
  return best
}

/**
 * PROGRESSIVE FIRST, THEN THE HLS RENDITIONS — because an instance may publish either, and which one
 * is an ADMIN SETTING rather than a property of PeerTube.
 *
 * Measured 2026-07-30: framatube.org and video.blender.org carry real progressive files, while
 * tilvids.com carries NOTHING but "Audio only" in `files[]` and puts its 1080p/360p/144p under
 * `streamingPlaylists[0].files[]` as FRAGMENTED mp4s. Reading only the first list makes every
 * HLS-only instance a cover-still platform; reading only the second throws away the better file
 * where both exist.
 *
 * THE FRAGMENTED FILES ARE REAL MP4s, not manifests — that is what makes this safe. The tilvids 360p
 * answers 206 `content-type: video/mp4` with ranges honoured, carries the `ftypiso5` (CMAF) brand,
 * and ffprobe decodes it as h264 + aac. The `playlistUrl` .m3u8 beside them is still never used.
 */
export function peertubeFile(
  video: Record<string, unknown>,
): { url: string; w: number; h: number } | null {
  const direct = pickFrom(arr(video.files))
  if (direct) return direct
  for (const raw of arr(video.streamingPlaylists)) {
    const pl = obj(raw)
    if (!pl) continue
    const got = pickFrom(arr(pl.files))
    if (got) return got
  }
  return null
}

/**
 * The cover still. `thumbnailPath` is a PATH on the instance, not a url — the one field here that
 * needs the host prepended, and forgetting that ships a relative url into og:image.
 */
export function peertubeThumb(video: Record<string, unknown>, host: string): string {
  const p = str(video.thumbnailPath) || str(video.previewPath)
  if (/^https:\/\//i.test(p)) return p
  return p.startsWith('/') ? `https://${host}${p}` : ''
}

export function normalizePeerTube(
  video: Record<string, unknown>,
  ref: Extract<PostRef, { p: 'pt' }>,
): Post | null {
  const account = obj(video.account)
  const channel = obj(video.channel)

  const file = peertubeFile(video)
  const thumb = peertubeThumb(video, ref.host)

  /**
   * A LIVE STREAM HAS NO FILE TO SERVE and its card is stale the moment the stream ends, so it
   * degrades to the cover exactly as an over-long video does. `isLive` is checked rather than
   * inferred from an empty files[] — an empty list also means "still transcoding", which is a
   * different and temporary thing.
   */
  const live = video.isLive === true
  const media: Media[] = []
  if (file && !live) {
    media.push({
      kind: 'video',
      url: file.url,
      w: file.w,
      h: file.h,
      ...(num(video.duration) ? { duration: num(video.duration) } : {}),
      // MANDATORY on a video — a posterless video drops Discord's rich card to plain OpenGraph.
      ...(thumb ? { poster: thumb } : {}),
    })
  } else if (thumb) {
    media.push({ kind: 'image', url: thumb, w: 0, h: 0 })
  }

  /**
   * THE AUTHOR IS THE ACCOUNT, FULLY QUALIFIED — and `account.host` is the ORIGIN instance, which on
   * a federated video is not the one we asked. Measured: framatube.org serves a video whose account
   * is `guyjantic@tube.tchncs.de`. Deriving the handle from ref.host would mislabel it, the same trap
   * Lemmy's actor_id comment records.
   */
  const name = str(account?.name)
  const accHost = str(account?.host) || ref.host
  const display = str(account?.displayName) || str(channel?.displayName) || name || 'PeerTube'

  const desc = capBody(str(video.description).trim())
  const chan = str(channel?.displayName)
  const text = [
    live ? '🔴 Live — no preview' : '',
    chan ? `📺 ${chan}` : '',
    desc,
  ].filter(Boolean).join('\n\n')

  return {
    ref,
    // The PASTED instance's permalink, for the same reason as every other fediverse platform here:
    // `video.url` is the ORIGIN's (tube.tchncs.de for the framatube example), and sending someone to
    // a different instance than the one they pasted is a surprise.
    canonical: new URL(`https://${ref.host}/w/${encodeURIComponent(ref.id)}`).href,
    author: {
      name: display,
      handle: name ? `${name}@${accHost}` : '',
      url: https(account?.url) ? str(account?.url) : `https://${ref.host}/a/${encodeURIComponent(name)}`,
      ...(https(obj(arr(account?.avatars)[0])?.fileUrl) ? { avatar: str(obj(arr(account?.avatars)[0])?.fileUrl) } : {}),
    },
    title: str(video.name) || undefined,
    text,
    createdAt: uploadDateOrEpoch(str(video.publishedAt) || str(video.originallyPublishedAt)),
    media,
    counts: {
      likes: num(video.likes) || undefined,
      views: num(video.views) || undefined,
    },
    // PeerTube's own adult flag. Instances set it per video and it is the platform telling us
    // directly, so it needs no inference.
    sensitive: video.nsfw === true,
  }
}
