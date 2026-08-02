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
  sleepAfter = '10m'   // stop the instance after 10 minutes with no requests
}
