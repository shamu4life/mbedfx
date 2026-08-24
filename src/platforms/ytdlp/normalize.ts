import type { Post, PostRef } from '../../types.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'

/**
 * THE SHARED PURE CORE OF THE yt-dlp TIER — Dailymotion, Streamable and Imgur.
 *
 * Each of those three is a `{fetch.ts, normalize.ts}` pair like every other platform here, and each
 * normalize.ts is a thin per-platform pure function. What they call is THIS, and there is exactly one
 * of it on purpose: the three differ only in a page-url template and a byline, so three hand-copied
 * mappers would be three places for one of them to drift — and the drift would be invisible, because
 * each platform's tests would keep passing against its own copy.
 *
 * Same shape as platforms/facebook/normalize.ts, which is the tier's fourth member in everything but
 * name: the metadata comes from the container's `{page, meta:true}` (`yt-dlp -J`) because that is the
 * one datacenter-reachable source, and the video is a `remux: {page}` the /_media route muxes. No I/O
 * here — the container call lives in worker.ts, so this half tests against captured `yt-dlp -J` bytes
 * with no network.
 *
 * IT DOES READ THE CLOCK, ONCE, and this docstring used to say otherwise. uploadDateOrEpoch's future
 * bound needs it — see platforms/uploaddate.ts, and normalizeYouTube's docstring for the same call made
 * for the same reason. Every input except a future-dated timestamp still maps to one fixed output.
 *
 * WHAT IS DELIBERATELY NOT COPIED FROM FACEBOOK: the og:title unpacking and the `usableUploader`
 * heuristic. Both exist because Facebook packs "<counts> | <caption> | <creator>" into the title its
 * extractor falls back to. Measured 2026-07-26, none of these three does — Dailymotion's uploader is a
 * clean 'Winter.Desire', Streamable and Imgur report no uploader at all — so importing that heuristic
 * would be defending against a defect these platforms do not have.
 */

/** What the container's `{page, meta:true}` mode yields, mapped for the card. */
export type YtdlpMeta = {
  /**
   * yt-dlp's own kind. 'video' is the only one we can render. MEASURED 2026-07-26: an Imgur album
   * (imgur.com/a/iX265HX) returns _type='playlist' with a TITLE and nothing else — no thumbnail, no
   * dimensions, no duration, no timestamp — so the "title is non-empty" content assertion PASSES on it
   * and the card would ship as a bare headline over a video url resolving to nothing. Optional,
   * because a pooled container instance still running a pre-g5 image does not report it; absent means
   * "unknown", which is treated as renderable (that is the pre-g5 behaviour, degrading rather than
   * throwing) while an explicit non-'video' value is refused.
   */
  type?: string
  title: string
  poster?: string
  uploader?: string
  uploaderUrl?: string
  description?: string
  w?: number
  h?: number
  duration?: number
  timestamp?: number
}

/**
 * THE MUX SHORTCUT — the format urls the SAME container call already resolved, so the /_media/ mux can
 * hand them to ffmpeg instead of paying a second, byte-identical yt-dlp extraction (measured
 * 2026-08-22: ~5.0s of player-API round trips against a 1.8s download of the same bytes).
 *
 * NOT PART OF YtdlpMeta, and that separation is load-bearing rather than tidiness. A resolved format
 * url is bound to the egress IP that resolved it and expires in hours; YtdlpMeta is the thing written
 * to R2 and read back for 30 minutes (Streamable) or 24 hours (Dailymotion, Imgur). Two types means
 * the volatile half cannot reach the durable one by a later edit that looks harmless — see worker.ts's
 * cachedYtdlpMeta, where the shortcut rides beside the record instead of inside it.
 *
 * ALWAYS OPTIONAL. The container declines it for a livestream, an unknown duration and an age-gated
 * source with no formats, a pooled instance on a pre-g12 image does not report it at all, and a cache
 * hit has none by construction. Absent means "mux from the page", which is the behaviour that shipped.
 */
export type MuxShortcut = { video?: string; audio?: string }

/** The per-platform half — a url template's worth of difference, named once. */
export type YtdlpSite = {
  /** The byline when the extract names no uploader (Streamable and Imgur never do). */
  name: string
  /** The author handle when there is no uploader. Lowercase, like facebook's 'facebook'. */
  handle: string
  /** Where an author-less byline points. */
  home: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const http = (v: unknown): string | undefined => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined)

/**
 * BOTH OR NEITHER — the same rule facebook/normalize.ts states at length. A half-known pair (w:0,
 * h:1024) is neither the known-unknown 0,0 every remux platform ships nor a usable aspect ratio, and
 * every consumer would have to re-derive that per field.
 */
function dims(w: unknown, h: unknown): [number, number] {
  const ok = (v: unknown) => Number.isInteger(v) && (v as number) > 0
  return ok(w) && ok(h) ? [w as number, h as number] : [0, 0]
}

/**
 * The shortcut's contribution to the remux entry — `{}` unless there is a real http VIDEO url, which
 * is what makes "no shortcut" and "a shortcut the container declined" the same thing here.
 *
 * VALIDATED RATHER THAN TRUSTED, like every other field this file reads. The urls originate in a
 * yt-dlp dict for an attacker-chosen page; the container re-checks them with its own SSRF guard before
 * ffmpeg sees one, and this is the cheaper half of that — a non-http url is dropped where it costs a
 * `{page}` mux rather than a rejected container call.
 */
function shortcut(mux: MuxShortcut | undefined): { video?: string; audio?: string } {
  const video = http(mux?.video)
  if (!video) return {}
  const audio = http(mux?.audio)
  return audio ? { video, audio } : { video }
}

/**
 * TOTAL: null meta, a junk meta, a foreign ref and a playlist all return null rather than throwing,
 * and every optional field degrades independently.
 *
 * A NULL RETURN IS A FAILURE CARD, not a crash — the worker counts it and renders the generic
 * "couldn't load", which is the honest answer for a page the container could not extract.
 */
export function normalizeYtdlp(
  meta: YtdlpMeta | null, ref: PostRef, site: YtdlpSite, page: string, mux?: MuxShortcut,
): Post | null {
  if (!meta || typeof meta !== 'object') return null
  const title = str(meta.title)
  if (!title) return null
  // An explicit non-video _type is refused; an ABSENT one is the pre-g5 container and stays renderable.
  if (typeof meta.type === 'string' && meta.type !== 'video') return null

  const [w, h] = dims(meta.w, meta.h)
  const who = str(meta.uploader)
  const poster = http(meta.poster)
  const duration = typeof meta.duration === 'number' && Number.isFinite(meta.duration) && meta.duration > 0
    ? meta.duration
    : undefined

  return {
    ref,
    canonical: page,
    /**
     * handle = the NAME when there is one, exactly as YouTube and Facebook do: none of these three
     * has an @handle concept on the surface we route, and this repo's established answer for a
     * platform without one is name-as-handle (the renderer's handleSegment encodes it for the url).
     */
    author: {
      name: who || site.name,
      handle: who || site.handle,
      url: http(meta.uploaderUrl) || site.home,
    },
    /**
     * NO `title` field, deliberately — the same call facebook/normalize.ts makes and for the same
     * reason: render/text.ts PREPENDS Post.title to og:description, so a video whose headline IS its
     * only text would ship it twice. The extract's title is the body.
     */
    text: str(meta.description) || title,
    /**
     * Upstream's timestamp, RANGE-CHECKED by the one shared rule — not `new Date(ts * 1000)` behind a
     * Number.isFinite guard, which is what this was and which is NOT total. isFinite admits 1e16;
     * `new Date(1e19)` is an Invalid Date (Date's range is ±8.64e15 ms); and render/mastodon.ts calls
     * `post.createdAt.toISOString()` on it, which THROWS RangeError — an uncaught 500 on the public
     * activity route, out of the function whose docstring three lines up promises it is TOTAL. The
     * value is attacker-adjacent in the ordinary sense: it is whatever the extracted page declared.
     * 0 still keeps the epoch fallback every other platform here uses when upstream carries no date.
     */
    createdAt: uploadDateOrEpoch(meta.timestamp),
    media: [{
      kind: 'video', url: page, w, h,
      ...(duration ? { duration } : {}),
      /**
       * THE PAGE IS ALWAYS KEPT, and the shortcut only ever ADDS to it. ensureMuxed tries the tracks
       * first and falls back to the page when they fail, which is the only safe way to use a url that
       * can go stale between this normalize and the mux — dropping `page` here would delete that
       * fallback and turn an expired signature into a card with no video at all.
       *
       * AUDIO ONLY RIDES WITH VIDEO. The container's `_mux_tracks` maps `0:v:0` and `1:a:0`, so audio
       * on its own is not a degraded mux, it is a broken argv.
       */
      remux: { page, ...shortcut(mux) },
      ...(poster ? { poster } : {}),
    }],
    counts: {},
    sensitive: false,
  }
}
