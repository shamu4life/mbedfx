import type { Post, PostRef } from '../../types.ts'
import { normalizeYtdlp, type YtdlpMeta, type YtdlpSite } from '../ytdlp/normalize.ts'
import { dmPageUrl } from './fetch.ts'

/**
 * PURE: container-extracted metadata -> a REMUX-video Post. The mapping itself lives in
 * platforms/ytdlp/normalize.ts, shared with Streamable and Imgur — see its docstring for why one
 * implementation rather than three copies. This file is the per-platform half: the byline a card
 * falls back to, and the refusal of a foreign ref.
 */
const DM: YtdlpSite = { name: 'Dailymotion', handle: 'dailymotion', home: 'https://www.dailymotion.com' }

export function normalizeDailymotion(meta: YtdlpMeta | null, ref: PostRef): Post | null {
  if (ref.p !== 'dm') return null
  return normalizeYtdlp(meta, ref, DM, dmPageUrl(ref))
}
