import type { PostRef } from '../../types.ts'

/**
 * NO PLATFORM EGRESS — and its absence is the design, not an omission.
 *
 * Dailymotion's card metadata AND its video both come from the container's yt-dlp: the metadata as a
 * `{page, meta:true}` (`-J`) call and the video as the `remux: {page}` the /_media route muxes. So
 * this file holds only the ONE thing a fetcher owns here — the url the container is handed — and it
 * is a PURE function of the ref, which is what lets worker.ts start the mux before the metadata call
 * has answered (see prewarmable).
 *
 * MEASURED 2026-07-26 (`yt-dlp -J`, residential): dailymotion.com/video/xaqwy7q extracts a full card —
 * title, s1.dmcdn.net thumbnail, uploader 'Winter.Desire', 544x960, duration 4830, timestamp — and a
 * short one muxes end to end to a real `ISO Media, MP4 Base Media v5` file (12,015,216 bytes).
 *
 * THAT SAMPLE IS NOW HTTP 410 GONE (checked 2026-08-12), and the reading above is left standing
 * because it is what was actually observed on the day. Do not re-run it and conclude the extractor
 * broke: a 410 on xaqwy7q says the uploader deleted a video, nothing about yt-dlp. Reproduce against
 * a live id instead — dailymotion.com/video/x8ocv9e (Fortune's, publisher-owned) rendered ok with one
 * media through this worker on 2026-08-12, and is the id the converter page now advertises.
 *
 * EXPECT COVER-ONLY CARDS OFTEN, and that is correct behaviour rather than a break: Dailymotion's
 * catalogue skews to full movies and multi-hour episodes, and the container's MAX_SECONDS ceiling
 * (1200s) rejects them — only 2 of 30 sampled recent videos were under 600s. A long video renders its
 * still, the same as any other source over the ceiling.
 */
export function dmPageUrl(ref: Extract<PostRef, { p: 'dm' }>): string {
  return `https://www.dailymotion.com/video/${ref.id}`
}
