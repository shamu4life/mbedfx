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

/** The horizon a reader is promised: one paste, and we keep trying for this long before giving up. */
export const MUX_TOTAL_HORIZON_MS =
  MUX_FIRST_ATTEMPT_MS + MUX_RETRY_MS.reduce((a, b) => a + b, 0)
