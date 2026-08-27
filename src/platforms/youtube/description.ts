/**
 * THE ONE RULE FOR TURNING A YOUTUBE DESCRIPTION INTO A CARD BODY.
 *
 * It lived inline in worker.ts while the container's `yt-dlp -J` was the only source. There are two
 * sources now — the container's extract and `youtubei/v1/player` (see innertube.ts) — and they write
 * to the SAME field, one of them into an R2 record kept for 30 days. Two copies of a clamp is two
 * chances to clamp differently, and the symptom would be a card whose body changes length depending
 * on which path warmed it. Same reasoning, and the same shape, as platforms/uploaddate.ts.
 *
 * A description is not a caption. They run to 5000 characters of chapter lists, sponsor blocks,
 * affiliate links and social handles, and NOTHING in src/render/ truncates Post.text — it would land
 * verbatim in the Mastodon `content` AND in og:description, turning a card into a wall.
 *
 * So the first paragraph, capped. That is the part that reads like a caption; everything after the
 * first blank line is reliably the boilerplate. Clamped at the worker boundary rather than in a
 * renderer, because this value is STORED IN R2 FOR 30 DAYS — trimming at render time would keep
 * paying to store and read the 5000 characters we always discard.
 */
export const YT_DESC_MAX = 300

export function ytDescriptionOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  // The first blank line ends the caption-ish part. \r\n handled because both sources pass through
  // whatever the uploader typed.
  const first = v.replace(/\r\n/g, '\n').split(/\n\s*\n/)[0].trim()
  if (!first) return undefined
  // THE SAME THREE DOTS render/text.ts uses, so the codebase carries ONE truncation marker rather
  // than two a reader would have to tell apart. Note this one can no longer reach a card: DESC_MAX
  // (253) is tighter than YT_DESC_MAX (300), so anything clamped here is re-clamped at render. It
  // survives because its job is bounding what is STORED IN R2 FOR 30 DAYS, not what is displayed —
  // so matching the marker is about consistency in the stored value, not about anything a reader sees.
  return first.length > YT_DESC_MAX ? `${first.slice(0, YT_DESC_MAX - 3).trimEnd()}...` : first
}
