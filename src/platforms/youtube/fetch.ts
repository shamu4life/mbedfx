import type { PostRef } from '../../types.ts'
import { askTwice } from '../../fetchretry.ts'
import { fetchInnertube } from './innertube.ts'

/**
 * I/O ONLY, and the ONE call here is pure ENRICHMENT: normalize builds a complete card from the
 * 11-char video id alone (thumbnail and canonical are derived, no network), so a miss degrades
 * rather than fails. That is why the fetch GUARDS ITSELF and returns a miss on a throw instead of
 * propagating to the worker's null — a YouTube link must always render.
 *
 *   oembed -> the real title + channel. Keyless, JSON, fast (745 bytes, ttfb 0.146s measured
 *             2026-07-26 with a crawler UA).
 *
 * THE WATCH-PAGE FETCH IS GONE (2026-07-26), and the measurement that retired it is the point. It
 * read `<meta itemprop="datePublished">` out of the first 64KB of the watch page for the upload
 * date. From Cloudflare egress that was right 1 TIME IN 3 on the field that actually renders — two
 * of three probed videos came back 1970-01-01T00:00:00.000Z on their own activity callback — while
 * costing a 1,575,509-byte request to youtube.com (ttfb 0.169s, total 1.010s) INSIDE fetchYouTube's
 * Promise.all, i.e. on the first-paste critical path, spending the HTML_DEADLINE_MS budget that
 * settleMux would otherwise get, on every cold post fetch in every colo.
 *
 * It was not kept as a "fast path" because it was none of fast, free or deterministic: the same
 * video rendered two different timestamps depending on which unfurl warmed the cache. The container
 * reproduces its exact value — `yt-dlp -J` returns timestamp 1256453853 for dQw4w9WgXcQ, and
 * Date.parse of the watch page's own '2009-10-24T23:57:33-07:00' divided by 1000 IS 1256453853 — at
 * one call per video per 30 days globally instead of up to ~96/day/video/colo at POST_TTL=900. See
 * worker.ts's youtubeMeta for the cache and the gate chain, and YouTubeFetch below for where the date
 * this file does NOT fetch is joined onto the result instead.
 *
 * CORRECTION, 2026-07-25: this docstring used to end "that is why we ship an iframe player, not
 * extracted media". That is no longer true and was the opposite of the current design — the iframe
 * was scrapped precisely because it IS Discord's ad-riddled native player. YouTube video now goes
 * through the media container as a `remux {page}` like any other slow source. Left recorded rather
 * than silently rewritten, because a reader who half-remembers the iframe should see it retracted.
 */

const CRAWLER_UA = 'facebookexternalhit/1.1'
const YT_ID = /^[A-Za-z0-9_-]{11}$/

/** The watch url — the container's mux source AND its metadata page. A pure function of the id. */
export function ytPageUrl(ref: Extract<PostRef, { p: 'yt' }>): string {
  return `https://www.youtube.com/watch?v=${ref.id}`
}

/**
 * `uploadedAt` is the date the WORKER ALREADY KNOWS — its own R2 meta-cache read — OVERLAID onto the
 * result after this function returns, never passed into it. It is a STRING (the ISO form the retired
 * watch page produced, still exercised by the normalizer's tests) or a NUMBER of epoch seconds (what
 * `yt-dlp -J` returns). Nothing in this file asks youtube.com for a date.
 *
 * ONE SEAM, NOT TWO. fetchYouTube used to take it as a second PARAMETER as well, and no caller ever
 * passed one — worker.ts called `fetchYouTube(ref)` and spread the field onto the result — so the
 * documented mechanism and the real one were different mechanisms, and a reader fixing the date at the
 * "documented" seam would have edited dead code. The parameter is gone and the overlay is the seam,
 * because the overlay is the one that can be CONCURRENT: worker.ts runs the R2 read and this fetch in
 * one Promise.all, and a parameter would have forced the read to finish first, serializing two calls
 * that today cost the wall clock of the slower one.
 *
 * IT SITS ON BOTH ARMS OF THE UNION, deliberately: an oembed miss says nothing about whether the date
 * is known, and gating the date on `ok` discarded a correct one (see normalize's uploadDate).
 */
export type YouTubeFetch =
  // `description` sits on BOTH arms for the reason the comment above gives about the date: it comes
  // from the container's meta extract, oembed knows nothing about it, and an oembed miss must not
  // suppress a body this worker is already holding.
  //
  // `duration` joined them 2026-08-27 with the Innertube source. It is not rendered — it is what lets
  // settleMux REFUSE a mux the container would refuse anyway, and until there was a date source on the
  // render path that arm was unreachable on this platform because the only duration lived in a record
  // that was never written. See innertube.ts.
  //
  // `isLive` joined them 2026-08-29 for the same job on the case duration cannot cover: an unfinished
  // broadcast reports lengthSeconds '0', so it has no duration to be over any ceiling, and every paste
  // dispatched a mux the container refuses on `!is_live`. THREE-VALUED ON PURPOSE — true, false and
  // absent are three different things here; see innertube.ts's liveVerdict and worker.ts's yt arm.
  | { ok: true; oembed: unknown; uploadedAt?: string | number | null; ageLimit?: number | null; description?: string | null; counts?: unknown; duration?: number | null; isLive?: boolean | null }
  | { ok: false; uploadedAt?: string | number | null; ageLimit?: number | null; description?: string | null; counts?: unknown; duration?: number | null; isLive?: boolean | null }

/**
 * TWO CALLS TO youtube.com, CONCURRENTLY, AND THE SECOND ONE CANNOT HURT THE FIRST.
 *
 * oembed owns the TITLE and the content assertion; Innertube owns the DATE, the description, the
 * duration and the view count (see innertube.ts for why the date stopped coming from the container).
 * They are independent, they go to the same host from the same egress, and they are raced in one
 * Promise.all so the wall clock is the slower of the two rather than their sum — 0.146s and ~0.25s
 * measured, against an HTML_DEADLINE_MS of 5000.
 *
 * THE ENRICHMENT IS STRICTLY ADDITIVE. `fetchInnertube` is total and answers null on a throw, a
 * timeout, a non-2xx or an unusable body, and every field it can supply is optional on both arms of
 * the union. So if YouTube changes that endpoint tomorrow, or refuses it from Cloudflare's egress
 * entirely, this function returns exactly what it returned before the second call existed. That
 * property is the whole reason the call is safe to make on the first-paste critical path, and it is
 * worth preserving over any future refactor that would let an Innertube failure reach the caller.
 */
export async function fetchYouTube(
  ref: Extract<PostRef, { p: 'yt' }>,
  fetchImpl: typeof fetch = fetch,
): Promise<YouTubeFetch> {
  if (!YT_ID.test(ref.id)) return { ok: false }
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ytPageUrl(ref))}`

  // askTwice ON THE OEMBED LEG, added 2026-08-29, and this is the call in the repo with the most to
  // lose to one refusal. oembed is YouTube's own existence check and the whole VOUCH: miss it and the
  // post is built unvouched (author.url falls back to YT_FALLBACK_AUTHOR_URL), so youtubeMeta's vouch
  // gate then refuses to recover the date on the activity route too, and the card renders 1 January
  // 1970 — permanently, because Discord keeps the embed it drew. It is passed `fetchImpl` because
  // that seam is how this file's tests answer with no network; see askTwice's third parameter.
  //
  // The Innertube leg beside it deliberately does NOT retry — different failure, different reason,
  // written down at that call site.
  const [oembedRes, meta] = await Promise.all([
    askTwice(url, { headers: { 'user-agent': CRAWLER_UA, accept: 'application/json' } }, fetchImpl)
      .catch(() => null),
    fetchInnertube(ref.id, fetchImpl),
  ])

  // Spread onto BOTH arms below rather than onto the result at the end, so the oembed-miss arm keeps
  // the date and body too — the exact defect the union's own comment records for `uploadedAt`.
  const enriched = {
    ...(meta?.uploadedAt === undefined ? {} : { uploadedAt: meta.uploadedAt }),
    ...(meta?.description === undefined ? {} : { description: meta.description }),
    ...(meta?.ageLimit === undefined ? {} : { ageLimit: meta.ageLimit }),
    ...(meta?.duration === undefined ? {} : { duration: meta.duration }),
    // ABSENT STAYS ABSENT, and `=== undefined` rather than a truthiness test is the whole point: a
    // `false` here is the fresh negative that lets an ended stream out of a 30-day record that still
    // says it is live. Dropping it would leave the record unopposed.
    ...(meta?.isLive === undefined ? {} : { isLive: meta.isLive }),
    ...(meta?.views === undefined ? {} : { counts: { views: meta.views } }),
  }

  if (!oembedRes) return { ok: false, ...enriched }
  // ASSERT ON CONTENT: oembed answers a nonexistent/embedding-disabled video with 401/404 and a
  // non-JSON body, and a real one with a JSON object carrying `title` — the JSON IS the assertion.
  if (!(oembedRes.headers.get('content-type') || '').includes('json')) return { ok: false, ...enriched }
  try {
    return { ok: true, oembed: await oembedRes.json(), ...enriched }
  } catch {
    return { ok: false, ...enriched }
  }
}
