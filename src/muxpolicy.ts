/**
 * WHEN THE MUX ALARM FIRES — the pure half of src/muxrunner.ts, split out for this repo's standing
 * rule that the judgement lives where it can be tested with no network and no runtime. The runner
 * itself imports `cloudflare:workers`, which does not exist under `node --test`, so anything left
 * inside it is untestable by construction; the schedule is the only part with an opinion, so the
 * schedule is what comes out.
 */

/**
 * PAST THE waitUntil CEILING ON PURPOSE, and this number is a derivation rather than a taste.
 *
 * Cloudflare cancels an unsettled `ctx.waitUntil` promise 30 seconds after the response, on a budget
 * SHARED across every waitUntil in the same request. The inline mux attempt still runs and is still
 * the fast path; this alarm exists for the case where that attempt is killed. Firing at 35s means:
 *
 *   - a mux that finished inline has already written to R2, so the alarm's first act (the R2 head
 *     check inside ensureMuxed) hits and it does NO container work — the fast path pays one cheap
 *     Durable Object wake and nothing else;
 *   - a mux that did not finish is certainly dead, so there is no double download.
 *
 * FIRING SOONER WOULD BE THE BUG. It would race a still-running inline attempt and mux the same video
 * twice on the same pooled container instance, competing for the exact bandwidth that decides whether
 * the card gets a player — the failure muxOnce was written to prevent, reintroduced by the fix.
 */
export const MUX_FIRST_ATTEMPT_MS = 35_000

/**
 * THE SAME DERIVATION, RUN AGAINST THE OTHER CEILING — because `{video}` track remuxes do not live
 * inside `waitUntil` at all, and 35s is wrong for them by a factor of four.
 *
 * A `{page}` source is dispatched by settleMux/prewarm into `ctx.waitUntil`, so 30s is genuinely the
 * moment its inline attempt stops existing. A `{video}` source (Bluesky, Reddit) has only ONE
 * dispatcher — serveMuxed, running inside Discord's media-proxy request — and that attempt is
 * ceilinged by the container instead: `container/server.py`'s `_mux_tracks` runs ffmpeg under
 * `timeout=PROC_TIMEOUT` (120s). Firing at 35s would therefore wake the alarm while the ffmpeg pull
 * is still going, in a DO isolate where `muxInflight` cannot dedupe (it is isolate-local and says so)
 * and where ensureMuxed's R2 head still misses because nothing is written until the mux finishes.
 *
 * That is two concurrent HLS pulls of one video on ONE pooled instance — the exact double-mux
 * MUX_FIRST_ATTEMPT_MS's own comment calls "the failure muxOnce was written to prevent, reintroduced
 * by the fix" — and it would land on the slow videos this alarm exists for and nothing else.
 *
 * 140s = PROC_TIMEOUT (120) + slack for the container's own request overhead. Move it if PROC_TIMEOUT
 * moves; they are one number expressed twice and that is the bug shape this repo keeps writing down.
 */
export const MUX_FIRST_ATTEMPT_TRACKS_MS = 140_000

/**
 * How long after arming the first attempt should fire, given the source that will be muxed.
 *
 * ONE FUNCTION SO THE CHOICE IS MADE ONCE. The two constants above are each derived from a DIFFERENT
 * ceiling, and picking between them at the call site would mean the derivation and the choice living
 * in different files — which is how the 35s constant came to be applied to a path that has no
 * `waitUntil` in it at all.
 */
export function firstMuxDelayMs(hasPage: boolean): number {
  return hasPage ? MUX_FIRST_ATTEMPT_MS : MUX_FIRST_ATTEMPT_TRACKS_MS
}

/**
 * BOUNDED RETRY, and the bound is the point.
 *
 * The complaint this was built for (2026-08-23) was a reader pressing the site's warm button for ten
 * minutes because each press bought a fresh 30-second attempt that threw away all of its bytes.
 * Retrying on their behalf is most of the fix — they should press once.
 *
 * RETRYING FOREVER IS A DIFFERENT BUG. A video YouTube has permanently gated would hold a container
 * slot on a schedule, and the pool is four slots shared by every platform — so an unbounded retry
 * would convert one dead video into a service-wide degradation, which is strictly worse than the
 * still it replaces.
 *
 * THE DELAYS ARE SHAPED BY WHAT ACTUALLY FAILS. A cold container (503) heals in seconds; a throttled
 * download heals in minutes if the throttle lifts; a hard gate never heals, and three attempts is
 * enough to establish that without spending the afternoon proving it.
 */
export const MUX_RETRY_MS: readonly number[] = [120_000, 1_200_000]

/**
 * How long to wait before attempt number `spent + 1`, or `null` to give up.
 *
 * TOTAL OVER JUNK, because this reads a counter out of Durable Object storage — a value written by a
 * previous deploy, which is outside this function's control. Anything that is not a sane count is
 * treated as "no attempts left" rather than as zero: refusing to retry costs one cold card, while
 * mis-reading junk as a fresh start is an unbounded loop against a shared container pool.
 */
export function nextMuxDelayMs(spent: number): number | null {
  if (!Number.isInteger(spent) || spent < 0) return null
  return MUX_RETRY_MS[spent] ?? null
}

/**
 * The horizon a reader is promised: one paste, and we keep trying for this long before giving up.
 *
 * STATED FOR THE SLOWEST SHAPE, not the common one. A `{page}` source's horizon is 105s shorter; this
 * is the number to quote when the question is "how long before we have definitely stopped".
 */
export const MUX_TOTAL_HORIZON_MS =
  MUX_FIRST_ATTEMPT_TRACKS_MS + MUX_RETRY_MS.reduce((a, b) => a + b, 0)
