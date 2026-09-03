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
 * container/server.py's `MUX_PAGE_TIMEOUT`, MIRRORED — the wall a `{page}` mux actually runs to, and
 * the reason this file no longer holds the slowest first attempt.
 *
 * A MIRROR, NOT A DERIVATION, and there is precedent for both halves of that. The container is
 * reached over a binding rather than imported, so no build step can share the number and nothing but
 * a test can make the two agree — exactly the situation `MAX_SECONDS` / `MUX_MAX_SECONDS` is already
 * in, and test/smoke.test.mjs is what keeps that pair honest. test/preview-mux-watch.test.mjs does
 * the same for this one, parsing `container/server.py` and comparing.
 *
 * WHY IT IS HERE RATHER THAN AT ITS ONE READER. public/index.html mirrors the SUM below and cannot
 * import anything (it ships as one hand-written page with no build step), so the alternative is a
 * literal in the page derived from a literal in Python with nothing in between. That is the shape of
 * the defect the deadline constants argue about at length.
 */
export const MUX_PAGE_WALL_MS = 360_000

/**
 * WHEN A `{page}` FIRST ATTEMPT HAS CERTAINLY ENDED: the alarm's own delay, plus the container wall
 * the work it starts then runs to. 395s.
 *
 * THE `{page}` SHAPE IS NOW THE SLOWEST, and it was not when MUX_FIRST_ATTEMPT_TRACKS_MS was written.
 * That constant's 140s came from PROC_TIMEOUT (120) because the tracks ffmpeg was the longest thing
 * the container did. Splitting MUX_PAGE_TIMEOUT out at 360s (2026-08-29) inverted it: a page mux now
 * runs nearly three times as long as a tracks mux, and every YouTube link is a page source
 * (src/platforms/youtube/normalize.ts hardcodes `remux: { page }`).
 *
 * NOT USED BY THE ALARM. `firstMuxDelayMs` is when the alarm FIRES, which is still 35s for a page
 * source — the moment its inline waitUntil attempt stops existing. This is when the work that alarm
 * starts is finally walled, which is a different question and is only asked by things that watch.
 */
export const MUX_FIRST_ATTEMPT_PAGE_TOTAL_MS = MUX_FIRST_ATTEMPT_MS + MUX_PAGE_WALL_MS

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
 *
 * WHAT THE 360s PAGE WALL DID TO THIS COST, written down 2026-08-29 because the count did not change
 * and the price did. The delay is applied AFTER an attempt resolves (src/muxrunner.ts), so a longer
 * wall creates no double-mux hazard and needs no companion change here — but a permanently-failing
 * `{page}` video now burns 3 x 360s of container time instead of 3 x 180s: 1080 slot-seconds out of
 * RESOLVER_SLOTS (4), or eighteen minutes of one slot, and ~41 minutes of wall clock end to end.
 *
 * DROPPING THE THIRD ATTEMPT (`[120_000]`) IS THE OBVIOUS ANSWER AND IT IS NOT TAKEN HERE. The
 * argument for it is real: a 360s attempt that fails is much stronger evidence of a hard gate than a
 * 180s one was, since 180s could fail on the wall alone; and the third attempt lands ~34 minutes
 * after the paste, long after Discord froze the embed and after the converter page stopped watching,
 * so its only remaining value is warming R2 for the next reader — which attempt two already delivers
 * at ~15 minutes. What is missing is a measurement of how often attempt three is the one that lands,
 * and this change had none. Cutting it is a separate decision with its own number to take first.
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
 * IT SUMS THE WAITS, NOT THE ATTEMPTS, and that has always been true — it just used to be close
 * enough not to matter. The attempts themselves are up to 360s each on a `{page}` source and 120s on
 * `{video}` tracks, none of which is in this number: the real page-shape wall clock is
 * 35 + 360 + 120 + 360 + 1200 + 360 ≈ 2435s (~41 min) against the 1460s stated here.
 *
 * SO IT IS A LOWER BOUND, and the sentence it used to carry — "stated for the slowest shape, a
 * `{page}` source's horizon is 105s shorter" — is now backwards twice over. The page shape is the
 * SLOWEST since MUX_PAGE_WALL_MS split out at 360s (2026-08-29), and it is ~975s longer, not 105s
 * shorter. Read this as "the alarm has certainly stopped scheduling by now"; for "how long could one
 * paste hold container time", add the attempts.
 *
 * NOT REDEFINED TO THE TRUE WALL CLOCK, deliberately: the two readers of this constant (the alarm
 * test, and the converter page's window sanity check) both want "when do we stop trying", and
 * changing the meaning underneath them to make one docstring shorter is how a number silently starts
 * answering a different question.
 */
export const MUX_TOTAL_HORIZON_MS =
  MUX_FIRST_ATTEMPT_TRACKS_MS + MUX_RETRY_MS.reduce((a, b) => a + b, 0)

/**
 * PROMISE-AND-STALL ON THE yt ACTIVITY SEAM — the switch, the ceiling, and the vouch.
 *
 * WHAT WAS MEASURED (2026-09-02, the owner's real Discord client with Cloudflare's invocation
 * analytics beside it; the `/_wait` block in worker.ts carries the whole ladder). Discord gives a
 * card ONE ~10s budget from the head fetch: head, activity document, poster and video must all
 * COMPLETE inside it, and the validator downloads the WHOLE video before it draws a player. A
 * document that keeps `type:'video'` at a url which only starts serving seconds later draws the
 * native player the moment the bytes land — that is what every paste that played did.
 *
 * WHAT WAS FOUND IN THE CODE: on a cold YouTube paste the head's settleMux had at most 1500ms, the
 * fastest mux ever recorded is 4200ms, so the entry ALWAYS degraded, the stock gate ALWAYS fired and
 * the activity link was ALWAYS omitted. Discord never asked for the document on the paste that
 * mattered — a structural 0%. YT_MUX_BOT_MS was tuned for a document nobody fetched.
 *
 * SO (1.15.0): the head stands the stock player down when a mux it can VOUCH for is in flight and
 * keeps the activity link; the yt activity document answers at the floor and KEEPS the video
 * attachment (`card_promised`); /_media waits for the mux and Discord waits ~9s for /_media. The mux
 * is dispatched at T0. Conversion = the share of promised videos whose mux lands inside that window:
 * `video_ok / card_promised` in the counters, readable within an hour of any deploy with no paste.
 *
 * THE VOUCH IS THE SAFETY VALVE. A promise that cannot be kept is frozen in Discord's message forever
 * (it re-crawls successful cards, never failed ones), so a promise is made only when the duration is
 * KNOWN — Innertube answered, or the 30-day record has it — and under YT_PROMISE_MAX_SECONDS. No
 * verdict means Innertube was refused (about half of cold pastes from Cloudflare egress) and a live
 * stream looks identical from here: `lengthSeconds: '0'`. Those keep today's stock player.
 *
 * YT_PROMISE_MAX_SECONDS is a starting point, not a measurement: the mux must land ~8s after the head
 * fetch, extraction alone is 3.1-4.7s on standard-2, and download time scales with the file. 240s
 * covers Shorts and short clips, the population most likely to make it. Widen it when the
 * `card_promised` rows (double2 = duration) against `video_ok` say longer videos convert too.
 *
 * YT_PROMISE = false is the rollback: it restores the 1500ms head wait, the 4000ms document wait and
 * the stock gate in one build, and keeps every counter and the T0 dispatch so the instrument
 * survives the retreat. It heals nothing already pasted.
 */
export const YT_PROMISE = true
export const YT_PROMISE_MAX_SECONDS = 240

/** Can this entry's video be promised to Discord before the mux has finished? See YT_PROMISE. */
export function promisable(m: { live?: true; duration?: number } | null | undefined): boolean {
  if (!YT_PROMISE || !m || m.live) return false
  return typeof m.duration === 'number' && m.duration > 0 && m.duration <= YT_PROMISE_MAX_SECONDS
}
