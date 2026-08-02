import type { PostRef } from '../../types.ts'

/**
 * NO PLATFORM EGRESS — see platforms/dailymotion/fetch.ts for the shape; Streamable is identical.
 *
 * MEASURED 2026-07-26 (`yt-dlp -J`, residential): streamable.com/moo extracts title 'me irl', a signed
 * CloudFront thumbnail, 852x480, duration 12.0, timestamp 1426115495 — and NO uploader of any kind
 * (uploader, uploader_id and uploader_url are all null), so the card carries the platform byline. It
 * muxes end to end to a real `ISO Media, MP4 Base Media v1` file (3,044,857 bytes).
 *
 * THE POSTER IS SIGNED AND SHORT-LIVED, which is why Streamable does NOT share Facebook's 24h meta
 * TTL. Its thumbnail is a CloudFront url carrying `Expires=` — measured twice, 1.2h and 1.83h of
 * remaining life at capture time. A record cached for 24h would therefore serve a DEAD poster for
 * most of its life, and invisibly from our side (we 302 to it). worker.ts gives this platform its own
 * short TTL for exactly that reason; see ST_META_TTL_MS.
 */
export function stPageUrl(ref: Extract<PostRef, { p: 'st' }>): string {
  return `https://streamable.com/${ref.id}`
}
