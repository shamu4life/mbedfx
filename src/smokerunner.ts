import { DurableObject } from 'cloudflare:workers'
import type { Env } from './analytics.ts'
import { scheduledDeps, scheduledSmoke, type ScheduledSmoke } from './worker.ts'

/**
 * THE SCHEDULED CHECK, RUN FROM EASTERN NORTH AMERICA. One object, created by the cron with a location
 * hint and addressed by a constant name, whose only job is to be somewhere: its subrequests leave from
 * the data center it was placed in, so the check meets each platform from where Discord's crawler meets
 * it rather than from wherever Cloudflare put the cron that tick. The measurement behind it, and what
 * happens when it cannot be reached, are at `smokeWhereReadersAre` in worker.ts.
 *
 * IN ITS OWN FILE for the reason src/muxrunner.ts is: it imports `cloudflare:workers`, which does not
 * exist under `node --test`. The body it runs is `scheduledSmoke`, in worker.ts, where the suite reaches
 * it. Nothing is stored, so the object holds no state between ticks and needs no cleanup.
 */
export class SmokeRunner extends DurableObject<Env> {
  async run(): Promise<ScheduledSmoke> {
    // handle() only ever calls waitUntil on its context; the object stays alive while that work runs.
    const ctx = {
      waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext
    return scheduledSmoke(this.env, ctx, scheduledDeps())
  }
}
