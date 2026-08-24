// THE DEPLOY ENTRY (wrangler `main`). It exists only to pair the Worker's fetch handler with the
// media-resolver container's Durable Object export, WITHOUT the test-imported worker.ts having to
// import @cloudflare/containers — whose `cloudflare:workers` dependency does not exist under
// `node --test`. Tests import ./worker.ts (unchanged); wrangler bundles this.
import worker from './worker.ts'

export { MediaResolver } from './container.ts'
// The mux runner's alarm — 15 minutes of wall clock where ctx.waitUntil gets 30. Exported here for
// exactly the reason MediaResolver is: it imports `cloudflare:workers`, which does not exist under
// `node --test`, and worker.ts is the test-imported half. See src/muxrunner.ts for the measurement.
export { MuxRunner } from './muxrunner.ts'
export default worker
