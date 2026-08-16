import { Container } from '@cloudflare/containers'
import type { Env } from './analytics.ts'

/**
 * The media-resolver container's Durable Object. The `Container` base (from @cloudflare/containers)
 * owns the lifecycle: boot on first request, block until `defaultPort` is listening, sleep when idle.
 * The Worker never touches this class directly — it calls env.MEDIA_RESOLVER.getByName(key).fetch(),
 * a standard Durable-Object-namespace call, so worker.ts stays dependency-free (see serveMuxed).
 *
 * THE ONLY FILE THAT IMPORTS @cloudflare/containers. That package pulls in `cloudflare:workers`, a
 * module that exists only in the Workers runtime, so importing it under `node --test` throws. Keeping
 * it here — reached solely through the deploy entry src/index.ts, never through the test-imported
 * worker.ts — is what lets the suite keep running in plain Node.
 */
export class MediaResolver extends Container<Env> {
  defaultPort = 8080   // matches container/server.py; requests block until the port is listening
  /**
   * MEASURED FROM THE BILL, 2026-08-16 (cycle Jul 27 - Aug 26; 21 of 31 days observed).
   *
   * A container instance bills for WALL-CLOCK TIME IT IS AWAKE, not for work done, and memory and
   * disk are billed on PROVISIONED size whatever ffmpeg actually touches. At '10m' the pool never got
   * the chance to sleep: 27.95k Durable Object requests over 21 days across RESOLVER_SLOTS (4) is one
   * every ~4.3 minutes per slot, which resets a ten-minute idle timer before it can ever fire. The
   * result was 3.24M instance-seconds — 42.9 instance-hours a DAY out of a possible 96 — against
   * 42.9k vCPU-seconds of actual work. A 5.3% duty cycle: 94.7% of what was billed was idle.
   *
   * THE SAME SECONDS ARE BILLED THREE TIMES, which is what made this worth chasing rather than
   * absorbing. Container Memory (3.24M GiB-s / 1 GiB), Container Disk (12.95M GB-s / 4 GB) and
   * Durable Objects Compute Duration (411k GB-s / 128 MB) all divide back to the same ~3.24M seconds
   * — a Container IS a Durable Object underneath, so its uptime lands on both products. $21.23 of a
   * $21.63 cycle was uptime. $0.41 was work.
   *
   * WHY 5 AND NOT 2. The Durable Object line is a CLIFF, not a slope: billable usage is rounded UP to
   * the next million GB-s, so anything between the 400k included allowance and 1.4M costs a flat
   * $12.50, and landing under 400k takes it to zero. That single step is worth more than halving
   * every other line. On the projection '5m' lands near 364k against that 400k allowance — real, but
   * only ~9% of margin, so if the next cycle still shows a DO charge the answer is 3m rather than a
   * rethink. '2m' would clear it comfortably and save about $2.66 more per cycle, at proportionally
   * more cold boots than this project should spend before it has watched 10m -> 5m for a week.
   *
   * WHAT IT COSTS, STATED PLAINLY. A cold instance is a real degradation, not merely a slower card: a
   * cold mux is ~6-9s at <=480p, and the worst measured stack was 12.3s — past the point Discord
   * gives up and draws nothing. The saving is concentrated in QUIET HOURS, because that is where the
   * long gaps between dispatches are and where the ten-minute tail was pure idle, so the extra cold
   * boots land when the fewest readers are watching. A busy period still arrives inside five minutes
   * and stays warm.
   *
   * THIS IS NOT WHAT THE 2026-07-24 POOLING FIX PROTECTED, and the two are easy to confuse. That fix
   * was about instance COUNT — per-video instance names exhausted `max_instances` and every mux
   * failed. This is instance DURATION. Shortening it makes exhaustion strictly LESS likely, because
   * slots are returned to the pool sooner; it does not reopen that defect.
   *
   * IT ALSO HELPS DEPLOYS LAND. A pooled instance keeps running the image it booted with until it
   * idles out, so a shorter timer is a shorter window in which a redeploy has not taken effect — see
   * RESOLVER_GENERATION, which exists because that window was long enough to matter.
   *
   * IF CARDS START DEGRADING, raise this before touching anything else, and judge it on AE's
   * media_hit vs media_miss for dm/st/im/fb/yt rather than on the bill, which lags a day.
   */
  sleepAfter = '5m'
}
