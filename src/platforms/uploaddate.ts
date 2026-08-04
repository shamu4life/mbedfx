/**
 * THE ONE RULE FOR TURNING AN UPSTREAM UPLOAD INSTANT INTO A Date, shared by every platform whose date
 * comes out of the container's `yt-dlp -J` dict — YouTube, Facebook, Dailymotion, Streamable, Imgur.
 *
 * IT LIVES IN ITS OWN FILE BECAUSE THE SECOND COPY WAS A 500 ON A PUBLIC ROUTE. platforms/ytdlp and
 * platforms/facebook each open-coded `new Date(meta.timestamp * 1000)` behind a Number.isFinite check,
 * which is NOT the same rule: isFinite admits 1e16, `new Date(1e19)` is an INVALID DATE (the range is
 * ±8.64e15 ms), and render/mastodon.ts calls `post.createdAt.toISOString()` on it — which THROWS
 * RangeError, uncaught, on the activity route, out of normalizers whose own docstrings promise they are
 * total and never throw. One upstream field with a junk value was a 500 on /users/{h}/statuses/{id}.
 *
 * SO THERE IS EXACTLY ONE IMPLEMENTATION, and every consumer imports it. A per-platform copy of a
 * range check is a per-platform opportunity to get the range wrong, and the symptom is not a wrong
 * date — it is a crashed response.
 */

/**
 * THE FLOOR under a plausible upload instant on any platform we route: 2005-02-14, the day
 * youtube.com was registered — which is also before Dailymotion's launch (2005-03-15), Imgur's (2009)
 * and Streamable's (2013), so the earliest of the five bounds all five. Facebook predates it as a
 * SITE, but not as a video host (video shipped 2007), so no real record here can sit below it either.
 *
 * A value under the floor is not a date any of these platforms produced — it is a unit mix-up
 * (milliseconds read as seconds land in 1970) or junk — and rejecting rather than rendering it matters
 * because worker.ts PERSISTS a validated timestamp: YouTube's for 30 days, the rest for up to a day.
 */
const UPLOAD_FLOOR_MS = Date.UTC(2005, 1, 14)
const DAY_MS = 86_400_000

/**
 * The upload instant, from EITHER source shape, as one pure total function.
 *
 *   - a STRING is an ISO-ish date (what YouTube's retired watch-page tag produced, and what the
 *     existing normalizer tests still feed in);
 *   - a NUMBER is epoch SECONDS (the container's `timestamp`; 1256453853 -> 2009-10-25T06:57:33Z and
 *     1114313512 -> 2005-04-24T03:31:52Z, both captured from real `yt-dlp -J` output 2026-07-26).
 *
 * Null for anything else, INCLUDING an out-of-range number: milliseconds mistaken for seconds
 * (4102444800000) lands ~130,000 years out and a real epoch-0 lands before any of these sites existed.
 *
 * `now` is a PARAMETER with a clock default rather than a bare `Date.now()` read, so the range check
 * exists without making the function non-deterministic for its tests — the future bound is the only
 * thing here that needs a clock, and a caller that wants determinism passes one.
 *
 * Number.isFinite, not !isNaN, on the RESULT: an unparseable date yields NaN, and `new Date(NaN)` is
 * an Invalid Date whose toISOString() THROWS — inside render/mastodon.ts, i.e. on the response path.
 * The range comparison then does the rest: every value that survives it is inside Date's own ±8.64e15
 * limit by construction, so the Date this returns can always be formatted.
 */
export function uploadDateFrom(value: unknown, now: number = Date.now()): Date | null {
  let ms: number
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    ms = value * 1000
  } else if (typeof value === 'string') {
    /**
     * `YYYYMMDD` IS A THIRD SHAPE, and it is yt-dlp's `upload_date` — the field that survives when
     * `timestamp` does not. Added 2026-08-04 because its absence was a live defect, not a tidiness
     * gap: yt-dlp sources `timestamp` only from a timezone-bearing microformat, several of its
     * YouTube player clients do not carry one, and on those responses the dict comes back complete
     * except that `timestamp` is null. `Date.parse('20091025')` is NaN, so a perfectly good date was
     * being read as no date at all.
     *
     * NORMALISED TO EXPLICIT UTC MIDNIGHT rather than handed to Date.parse as-is. `Date.parse` on a
     * bare `YYYY-MM-DD` is defined as UTC, but on `YYYY-MM-DDT00:00:00` without a zone it is LOCAL —
     * one character apart, and the difference is a day's error for anyone west of Greenwich. Spelled
     * out so a later edit cannot introduce that by tidying the string.
     *
     * DAY PRECISION IS THE HONEST LIMIT of this shape, and it is enough: `upload_date` carries no
     * time of day, so this is midnight UTC and not the real upload instant. Every surface that shows
     * it renders a date rather than a clock time, so nothing displays a wrong hour — but a consumer
     * sorting two same-day uploads gets an arbitrary order, which is why `timestamp` is still
     * PREFERRED wherever it exists and this is only the fallback.
     */
    ms = /^\d{8}$/.test(value)
      ? Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`)
      : Date.parse(value)
  } else {
    return null
  }
  if (!Number.isFinite(ms) || ms < UPLOAD_FLOOR_MS || ms > now + DAY_MS) return null
  return new Date(ms)
}

/**
 * The same rule, for the many normalizers that must produce a Date no matter what: a validated instant,
 * or the epoch. The epoch is what every platform here already ships when upstream carries no date at
 * all (Post.createdAt is a required Date), so this changes nothing about the "no date" case — it only
 * stops a junk or out-of-range one from becoming an Invalid Date that throws when rendered.
 */
export function uploadDateOrEpoch(value: unknown, now?: number): Date {
  return uploadDateFrom(value, now) ?? new Date(0)
}
