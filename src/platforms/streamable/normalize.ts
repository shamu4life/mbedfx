import type { Post, PostRef } from '../../types.ts'
import { normalizeYtdlp, type YtdlpMeta, type YtdlpSite } from '../ytdlp/normalize.ts'
import { stPageUrl } from './fetch.ts'

/**
 * PURE: container-extracted metadata -> a REMUX-video Post. The mapping lives in
 * platforms/ytdlp/normalize.ts, shared with Dailymotion and Imgur.
 *
 * Streamable reports NO uploader on any of its three fields (measured 2026-07-26), so every card here
 * carries the platform byline. That is deliberate and it is why the fallback is a real name rather
 * than an empty string: an author whose name is '' renders as a blank line above the title.
 */
const ST: YtdlpSite = { name: 'Streamable', handle: 'streamable', home: 'https://streamable.com' }

export function normalizeStreamable(meta: YtdlpMeta | null, ref: PostRef): Post | null {
  if (ref.p !== 'st') return null
  return normalizeYtdlp(meta, ref, ST, stPageUrl(ref))
}
