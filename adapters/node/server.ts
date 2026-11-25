import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Env } from '../../src/analytics.ts'
import type { Deps } from '../../src/worker.ts'
import worker, { handle, scheduledDeps } from '../../src/worker.ts'
import { DirBucket } from './r2dir.ts'
import {
  analytics, containerResolver, envVars, inProcessMuxRunner, inProcessSmokeRunner, memoryCache, publicAssets,
  resolveHost, scrub, trackingContext,
} from './bindings.ts'

/**
 * THE NODE ADAPTER: the production handler, `handle(req, env, ctx, deps)` from src/worker.ts, behind
 * node:http. Nothing under src/ knows it exists. The Cloudflare default export's `fetch` is the same
 * call with `liveDeps()`; this is that call with the bindings rebuilt in ./bindings.ts and ./r2dir.ts.
 *
 *   node adapters/node/server.ts        (Node 22.18 or later: it runs the .ts files as written)
 *
 * Configuration is environment variables, listed in docs/SELF-HOSTING.md under "Running the Node
 * adapter". Every string var and secret the worker reads passes through under its own name.
 */

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * WHERE A REQUEST'S URL COMES FROM: the configured public origin, never the socket.
 *
 * `url.origin` is what the worker mints every og: url from, so a socket address (127.0.0.1:8787 behind
 * a proxy, or http where the public side is https) would put an unreachable url into every card Discord
 * caches. And the hostname is not only cosmetic: src/guesthost.ts answers guest hosts differently, and a
 * `d.` host serves the post's bytes instead of its card (DIRECT_MEDIA_HOST in src/worker.ts).
 *
 * PUBLIC_ORIGIN is a list. The first entry is the primary. Another entry is chosen only when the Host
 * header matches it exactly, which is how one adapter serves both `embed.example.com` and
 * `d.embed.example.com`. A Host that matches nothing gets the primary, so an attacker-chosen Host can
 * never become the origin of a card.
 */
export function parseOrigins(spec: string): string[] {
  const out: string[] = []
  for (const raw of spec.split(/[\s,]+/).filter(Boolean)) {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`PUBLIC_ORIGIN: not http(s): ${raw}`)
    if (u.pathname !== '/' || u.search || u.hash) throw new Error(`PUBLIC_ORIGIN: an origin has no path: ${raw}`)
    out.push(u.origin)
  }
  if (!out.length) throw new Error('PUBLIC_ORIGIN is empty')
  return out
}

export function pickOrigin(origins: string[], hostHeader: string | undefined): string {
  const host = (hostHeader ?? '').toLowerCase()
  return origins.find(o => new URL(o).host === host) ?? origins[0]
}

/** Hop-by-hop headers (RFC 9110 §7.6.1) and Host, which the configured origin replaces. */
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host',
  'proxy-authorization', 'proxy-authenticate',
])

/**
 * IncomingMessage to Request. Null means 400.
 *
 * THE URL IS BUILT BY CONCATENATION, `origin + rawPath`, and never with `new URL(rawPath, origin)`.
 * The two-argument form lets the path pick the host: `//evil.example/x` and an absolute-form
 * `http://evil.example/x` both resolve to evil.example, and then evil.example is what the card's og:
 * urls say. Concatenated, `//evil.example/x` is a path on our own host, which is also how Cloudflare
 * hands it to the worker. A request target that is not origin-form (`*`, `host:port`, an absolute url)
 * is refused outright.
 *
 * NO BODY IS FORWARDED. Nothing in src/ reads a request body: /_api/v1 branches on the method and
 * nothing else does. So every method goes to `handle` without one. That keeps production's answers
 * (measured 2026-11-25 against mbedfx.app): a POST to /_api/v1 is the documented JSON
 * `method_not_allowed` 405 (docs/API.md), a POST to an asset is a 405, and a write verb on a post url
 * renders the card. CONNECT, TRACE and TRACK are refused here, because the fetch Request constructor
 * throws on all three.
 */
export function toRequest(req: IncomingMessage, origins: string[]): Request | null {
  const raw = req.url ?? ''
  if (!raw.startsWith('/')) return null
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'CONNECT' || method === 'TRACE' || method === 'TRACK') return null
  const headers = new Headers()
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    if (HOP.has(name.toLowerCase())) continue
    try { headers.append(name, req.rawHeaders[i + 1]) } catch { /* a header fetch refuses is dropped */ }
  }
  try {
    return new Request(pickOrigin(origins, req.headers.host) + raw, { method, headers })
  } catch {
    return null
  }
}

/**
 * Response to ServerResponse, streamed with backpressure.
 *
 * HEAD SENDS NO BODY AND CANCELS THE ONE IT WAS HANDED. Several routes build a full Response for HEAD
 * (the R2 range path, the container's stream), and an unread body is an open file or socket until the
 * garbage collector finds it. The same cancel runs when the client hangs up mid-stream: pipeline()
 * destroys the source, which cancels the web stream under it.
 *
 * A `content-encoding` HEADER IS DROPPED, WITH content-length, and nothing in src/ sets one itself. The
 * only way one arrives is on a passed-through upstream response, and Node's fetch has already decoded
 * that body. Relaying the header would label plain bytes as gzip. src/mediaproxy.ts already drops it
 * for the same reason; this is the belt for any future route that does not.
 */
export async function writeResponse(res: ServerResponse, response: Response, head: boolean): Promise<void> {
  const out: Record<string, string | string[]> = {}
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) out['set-cookie'] = cookies
  if (out['content-encoding']) {
    delete out['content-encoding']
    delete out['content-length']
  }
  res.writeHead(response.status, response.statusText || undefined, out)
  if (head || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    res.end()
    return
  }
  try {
    await pipeline(Readable.fromWeb(response.body as never), res)
  } catch {
    // The client went away, or the source failed mid-body. Either way the status line is already
    // sent and there is nobody left to tell.
  }
}

export type AdapterConfig = {
  /** PUBLIC_ORIGIN, parsed. The first is the primary. */
  origins: string[]
  /** Where ASSETS reads from. Default: the repository's public/. */
  publicDir?: string
  /** MEDIA_CACHE's directory, or null for no MEDIA_CACHE binding. */
  mediaDir: string | null
  /** The container's base url, or null for no MEDIA_RESOLVER binding. */
  containerUrl: string | null
  resolverTimeoutMs?: number
  /** process.env, or a test's own. Only ENV_VARS are read from it. */
  vars?: Record<string, string | undefined>
  analyticsLog?: boolean
  /** TESTS ONLY: replace a live dependency (fetchPost, say) so nothing reaches the network. */
  deps?: Partial<Deps>
  /** TESTS ONLY: the deps the scheduled check renders with. Production uses scheduledDeps(). */
  smokeDeps?: () => Deps
  log?: (line: string) => void
}

/**
 * Builds env, ctx and deps and a node:http server around `handle`, and does not listen. The entry point
 * at the bottom of this file listens, runs the cron and handles signals; a test does none of those.
 */
export function createAdapter(cfg: AdapterConfig) {
  const log = cfg.log ?? console.error
  const tracker = trackingContext(log)
  const ctx = tracker.ctx
  const hosts = cfg.origins.map(o => new URL(o).hostname)
  // String vars first, bindings after, so no environment variable can land on a binding's name.
  const env = { ...envVars(cfg.vars ?? {}, hosts) } as Env
  env.ASSETS = publicAssets(cfg.publicDir ?? join(REPO, 'public'))
  if (cfg.mediaDir) env.MEDIA_CACHE = new DirBucket(cfg.mediaDir) as unknown as R2Bucket
  if (cfg.containerUrl) {
    env.MEDIA_RESOLVER = containerResolver(cfg.containerUrl, cfg.resolverTimeoutMs) as unknown as DurableObjectNamespace
  }
  const mux = inProcessMuxRunner(env, p => ctx.waitUntil(p), undefined, log)
  env.MUX_RUNNER = mux
  env.SMOKE_RUNNER = inProcessSmokeRunner(env, ctx, cfg.smokeDeps)
  env.AE = analytics(!!cfg.analyticsLog)
  // Workers AI has no stand-in. Translation runs on Google's endpoint alone (src/translate.ts), and a
  // post Google refuses renders untranslated.
  env.AI = undefined
  env.RESOLVE_HOST = resolveHost

  const cache = memoryCache({ log })
  // NOT A HAND-COPIED liveDeps. scheduledDeps() is liveDeps(COLD_CACHE), exported from src/worker.ts, so
  // spreading it picks up every live fetcher the default export uses, including any added later. Only
  // the cache is swapped, for the one this process keeps.
  const deps: Deps = { ...scheduledDeps(), cache, ...cfg.deps }

  const server = http.createServer(async (req, res) => {
    const request = toRequest(req, cfg.origins)
    if (!request) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('bad request\n')
      return
    }
    let response: Response
    try {
      response = await handle(request, env, ctx, deps)
    } catch (err) {
      // What Workers does with a throw from fetch: a 500, and the process carries on.
      log(`handle threw: ${scrub(err)}`)
      response = new Response('internal error\n', { status: 500, headers: { 'content-type': 'text/plain' } })
    }
    // node:http does not await this callback, so anything thrown past here (writeHead refusing a header
    // value, say) would be an unhandled rejection. One broken response must not become a crash.
    try {
      await writeResponse(res, response, request.method === 'HEAD')
    } catch (err) {
      log(`response failed: ${scrub(err)}`)
      res.destroy()
    }
  })

  /** One scheduled tick, as Cloudflare's cron would call it: the default export's own `scheduled`. */
  const tick = (scheduledTime: number) => {
    const controller = { scheduledTime, cron: '*/30 * * * *', noRetry() {} } as unknown as ScheduledController
    ctx.waitUntil(worker.scheduled(controller, env, ctx))
  }

  return {
    server, env, ctx, deps, cache, mux, tick,
    drain: tracker.drain,
    pending: () => tracker.pending.size,
    /** Stop the alarms. Call after drain: a mux already running is in the waitUntil set and finishes. */
    close: () => mux.close(),
  }
}

/**
 * THE CRON, wrangler.jsonc's half-hourly trigger: aligned to :00 and :30 rather than every 30 minutes
 * from boot, so `/_health` reads like production's and `scheduledTime` is the slot, as Cloudflare
 * passes it. Unref'd: a pending tick never holds the process open.
 */
export function startCron(tick: (scheduledTime: number) => void, everyMs = 30 * 60_000): () => void {
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    const now = Date.now()
    const at = Math.floor(now / everyMs) * everyMs + everyMs
    timer = setTimeout(() => { tick(at); arm() }, at - now)
    timer.unref()
  }
  arm()
  return () => clearTimeout(timer)
}

const on = (v: string | undefined) => v !== undefined && v !== '' && v !== 'off' && v !== '0'

async function main(): Promise<void> {
  const e = process.env
  // Workers logs an unhandled rejection and keeps serving; Node's default is to exit. One stray
  // rejection anywhere in src/ would otherwise take every card down with it.
  process.on('unhandledRejection', (err: unknown) => console.error(`unhandled rejection: ${scrub(err)}`))

  const port = Number(e.PORT ?? 8787)
  const host = e.HOST ?? '127.0.0.1'
  const origins = parseOrigins(e.PUBLIC_ORIGIN ?? `http://localhost:${port}`)
  const mediaDir = e.MEDIA_CACHE_DIR === 'off' ? null : (e.MEDIA_CACHE_DIR || join(tmpdir(), 'mbedfx-media'))
  const containerUrl = e.CONTAINER_URL === 'off' ? null : (e.CONTAINER_URL || 'http://127.0.0.1:8080')
  const adapter = createAdapter({
    origins, mediaDir, containerUrl,
    resolverTimeoutMs: e.RESOLVER_TIMEOUT_MS ? Number(e.RESOLVER_TIMEOUT_MS) : undefined,
    vars: e,
    analyticsLog: on(e.ANALYTICS_LOG),
  })
  const stopCron = e.SMOKE_CRON === 'off' ? () => {} : startCron(adapter.tick)

  adapter.server.listen(port, host, () => {
    console.log(`mbedfx adapter on ${host}:${port}, serving ${origins.join(' ')}`)
    console.log(`  MEDIA_CACHE ${mediaDir ?? 'off'}, MEDIA_RESOLVER ${containerUrl ?? 'off'}, cron ${e.SMOKE_CRON === 'off' ? 'off' : 'on'}`)
  })

  /**
   * SIGTERM: stop taking requests, then wait for the waitUntil set (muxes, cache writes, slot releases)
   * for up to DRAIN_MS, default 25 s. Docker sends SIGKILL ten seconds after SIGTERM unless told
   * otherwise, which is why the compose file sets stop_grace_period above this. An armed alarm that has
   * not fired yet is dropped; the next paste arms it again.
   */
  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    stopCron()
    const r = await gracefulStop(adapter, Number(e.DRAIN_MS ?? 25_000))
    console.log(`${signal}: requests ${r.requestsDone ? 'finished' : 'cut off at the deadline'}, `
      + `${r.backgroundPending} background task(s) pending at stop, ${r.backgroundClean ? 'all settled' : 'gave up at the deadline'}`)
    process.exit(0)
  }
  process.once('SIGTERM', () => void stop('SIGTERM'))
  process.once('SIGINT', () => void stop('SIGINT'))
}

/**
 * STOP IN THE RIGHT ORDER, INSIDE ONE DEADLINE: requests in flight first, then the waitUntil set.
 *
 * `server.close()` stops taking connections but returns at once; its CALLBACK is what fires when every
 * request still inside handle(), and every response body still streaming, has finished. The first
 * version called close() and went straight to draining the waitUntil set, which does not hold those
 * requests, so a review reproduced it (Node 22.18, a container answering after 3 s, SIGTERM 0.5 s into
 * a /_clients call): curl got an empty reply while the log said "all settled". Under compose that is
 * every unfurl mid-render on a recreate, and Discord never re-crawls a failed one (muxpolicy.ts).
 *
 * Both waits share `drainMs`, so the total stays under the compose stop_grace_period.
 */
export async function gracefulStop(
  adapter: { server: http.Server; drain(ms: number): Promise<boolean>; pending(): number; close(): void },
  drainMs: number,
): Promise<{ requestsDone: boolean; backgroundPending: number; backgroundClean: boolean }> {
  const deadline = Date.now() + drainMs
  const closed = new Promise<boolean>(resolve => adapter.server.close(() => resolve(true)))
  // closeIdleConnections() only closes what is idle WHEN it runs; a request that finishes after it
  // leaves a keep-alive socket open, and close()'s callback would then wait out the keep-alive timeout
  // (measured in the test below: the stop reported "cut off" with every request already answered).
  // So keep closing idle sockets until the server reports it is closed.
  adapter.server.closeIdleConnections()
  const sweep = setInterval(() => adapter.server.closeIdleConnections(), 100)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), drainMs) })
  const requestsDone = await Promise.race([closed, timedOut])
  clearTimeout(timer)
  clearInterval(sweep)
  // A request that finished may have handed work to waitUntil on its way out, so count after it.
  const backgroundPending = adapter.pending()
  const backgroundClean = await adapter.drain(Math.max(0, deadline - Date.now()))
  adapter.close()
  return { requestsDone, backgroundPending, backgroundClean }
}

// `import.meta.main` is Node 22.18+; the argv test is the same question asked the older way.
if ((import.meta as { main?: boolean }).main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`adapter failed to start: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
