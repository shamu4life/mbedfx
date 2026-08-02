// THE DEPLOY ENTRY (wrangler `main`). It exists only to pair the Worker's fetch handler with the
// media-resolver container's Durable Object export, WITHOUT the test-imported worker.ts having to
// import @cloudflare/containers — whose `cloudflare:workers` dependency does not exist under
// `node --test`. Tests import ./worker.ts (unchanged); wrangler bundles this.
import worker from './worker.ts'

export { MediaResolver } from './container.ts'
export default worker
