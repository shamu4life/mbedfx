import { DurableObject } from 'cloudflare:workers'
import type { Env } from './analytics.ts'
import type { MuxJob } from './types.ts'
import { runMuxJob } from './worker.ts'
import { MUX_FIRST_ATTEMPT_MS, nextMuxDelayMs } from './muxpolicy.ts'

/**
 * THE MUX RUNNER — one Durable Object per video, whose ALARM does the work a request is not allowed
 * to finish.
 *
 * THE DEFECT IT CLOSES, measured 2026-08-23 and confirmed against Cloudflare's own limits page. Every
 * mux in this service was dispatched through `ctx.waitUntil`: settleMux, the prewarm in
 * renderPostRoute, and the site's own warm button `/_prep`. Cloudflare documents that as a HARD
 * 30-second ceiling — "`waitUntil()` can extend execution for up to 30 seconds after the response is
 * sent or the client disconnects. This time limit is shared across all `waitUntil()` calls within the
 * same request. If any Promises have not settled after 30 seconds, they are canceled." An alarm
 * handler gets FIFTEEN MINUTES, the same budget as a cron trigger or a queue consumer.
 *
 * AND A CANCELLED ATTEMPT LEFT NOTHING BEHIND, which is what turned "slow" into "never". The
 * container buffers the whole file before it sends a byte (container/server.py), writes to a fresh
 * `tempfile.mkstemp` with `--force-overwrites`, and removes it in a `finally` — so there is no
 * partial R2 object and no resumable `.part` for the next attempt to find. `/_prep` returns in 23ms
 * and then gets exactly 30 seconds; the reported "a 10-minute video took nearly ten minutes to warm"
 * was that lottery being re-rolled by hand, each losing roll discarding 100% of its bytes.
 *
 * WHY A DO ALARM RATHER THAN A QUEUE. Cloudflare's docs recommend a Queue for exactly this, and that
 * remains the eventual answer — this ships first because it needs no new product, no new bill line
 * and no consumer config, and the 15-minute budget is identical. What a Queue would add on top is
 * retries with backoff and a dead-letter queue; the bounded retry below is the small hand-rolled
 * version of the first, and there is deliberately no equivalent of the second.
 *
 * IT IS ALSO THE FIRST GLOBAL MUTEX THIS PATH HAS EVER HAD. `muxInflight`/`muxOnce` are isolate-local
 * and their own comment says so ("two isolates can still double-mux one video"). A DO addressed by
 * the mux key is one object worldwide, so `schedule` collapses every isolate's request for one video
 * onto one alarm.
 */

/** How many alarm attempts have been spent. Storage, not the job — the Worker never sends it. */
const ATTEMPT = 'attempt'
const JOB = 'job'

export class MuxRunner extends DurableObject<Env> {
  /**
   * ARM THE ALARM, ONCE. Called from every dispatch site, so it is called MANY times for one video —
   * the prewarm, the HTML render and the activity render all inside ~2s of a single paste. An
   * already-armed alarm is left exactly as it is: re-arming would push the deadline further out on
   * every duplicate call, so a popular video would have its mux postponed indefinitely by its own
   * popularity. First caller wins, and the rest are free.
   */
  async schedule(job: MuxJob): Promise<void> {
    if (await this.ctx.storage.getAlarm() !== null) return
    await this.ctx.storage.put(JOB, job)
    await this.ctx.storage.setAlarm(Date.now() + MUX_FIRST_ATTEMPT_MS)
  }

  /**
   * NEVER THROWS, and that is not defensiveness — it is the retry policy.
   *
   * The Durable Object runtime retries an alarm that throws, with its own backoff and its own limit,
   * which would layer an invisible second retry loop under the explicit one below and make the real
   * number of container calls per video unknowable. So every failure is caught, counted as an
   * attempt, and either re-armed here or given up on here. One policy, written down, in one place.
   */
  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<MuxJob>(JOB)
    if (!job) {
      await this.ctx.storage.deleteAll()
      return
    }
    const attempt = (await this.ctx.storage.get<number>(ATTEMPT)) ?? 0
    let done = false
    try {
      done = await runMuxJob(this.env, job)
    } catch {
      // A throw here is our own bug or a binding that vanished; either way it is not evidence about
      // the video, and it is handled exactly like a failed mux — see the docstring.
      done = false
    }
    const next = nextMuxDelayMs(attempt)
    if (done || next === null) {
      // FINISHED, or out of attempts. Either way this object has nothing left to remember, and a DO
      // that keeps storage keeps costing — `deleteAll` is what lets it be collected.
      await this.ctx.storage.deleteAll()
      return
    }
    await this.ctx.storage.put(ATTEMPT, attempt + 1)
    await this.ctx.storage.setAlarm(Date.now() + next)
  }
}
