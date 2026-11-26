import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Env } from '../../src/analytics.ts'
import type { CacheLike, Deps } from '../../src/worker.ts'
import type { MuxJob } from '../../src/types.ts'
import { clearMuxGiveUp, recordMuxGiveUp, runMuxJob, scheduledDeps, scheduledSmoke } from '../../src/worker.ts'
import { claimIsLive, firstMuxDelayMs, nextMuxDelayMs } from '../../src/muxpolicy.ts'

/**
 * THE CLOUDFLARE BINDINGS, REBUILT FOR ONE NODE PROCESS. Each stand-in says what it replaces and what is
 * lost without the real thing. Nothing here is imported by `src/`: the worker sees only the structural
 * shapes `Env` already declares (src/analytics.ts), which is what lets it run unchanged.
 *
 * ONE PROCESS IS THE UNIT. The cache, the mux runner and the waitUntil set all live in memory, and two
 * adapter processes behind one load balancer would hold two of each. That is a 1/N cache hit rate and
 * no cross-process mux dedupe; see CacheLike's third promise in src/worker.ts.
 */

/** A log line that cannot carry a reader's url: the worker's own console lines name things, never urls. */
export function scrub(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  const msg = err instanceof Error ? err.message : String(err)
  return `${name}: ${msg.replace(/https?:\/\/\S+/g, '<url>').slice(0, 160)}`
}

// ── ctx ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A REAL `ctx.waitUntil`. It replaces the ExecutionContext Workers passes to `fetch`.
 *
 * A no-op would compile and look fine, and it silently cancels three things: in-flight muxes, the release
 * of container slots, and every response-cache write. The symptom is "videos never appear", with no error
 * anywhere. So every promise is kept in a Set until it settles, and SIGTERM drains the Set before the
 * process exits.
 *
 * TWO DIFFERENCES FROM WORKERS, both deliberate:
 *   - No 30-second ceiling. Workers cancels unsettled waitUntil work 30 s after the response; here it runs
 *     until it settles or the process is stopped. Muxes therefore finish inline more often than they do
 *     on the public instance, which only helps.
 *   - A rejection is logged and swallowed. On Workers an unhandled rejection is a log line; in Node it is
 *     the process exiting, and most of these promises are cache writes whose failure is a performance
 *     event (CacheLike's fourth promise).
 */
export function trackingContext(log: (line: string) => void = console.error) {
  const pending = new Set<Promise<void>>()
  const ctx = {
    waitUntil(p: Promise<unknown>): void {
      const tracked: Promise<void> = Promise.resolve(p).then(
        () => undefined,
        err => { log(`waitUntil rejected: ${scrub(err)}`) },
      )
      pending.add(tracked)
      void tracked.then(() => pending.delete(tracked))
    },
    passThroughOnException(): void {},
    props: {},
  }
  /**
   * Resolves true once nothing is pending, false if `timeoutMs` ran out first. It loops because work
   * can hand more work to waitUntil as it settles (a mux whose finally writes a cache entry).
   */
  async function drain(timeoutMs = Infinity): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (pending.size > 0) {
      const left = deadline - Date.now()
      if (left <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const out = await Promise.race([
        Promise.all([...pending]).then(() => 'settled' as const),
        new Promise<'timeout'>(resolve => {
          if (Number.isFinite(left)) timer = setTimeout(() => resolve('timeout'), left)
        }),
      ])
      if (timer) clearTimeout(timer)
      if (out === 'timeout') return false
    }
    return true
  }
  return { ctx: ctx as unknown as ExecutionContext & { waitUntil(p: Promise<unknown>): void }, drain, pending }
}

// ── caches.default ────────────────────────────────────────────────────────────────────────────────

/** `s-maxage` wins over `max-age`, as in a shared cache. Null means "do not store". */
export function storeSeconds(cacheControl: string | null): number | null {
  if (!cacheControl) return null
  if (/(?:^|,)\s*(?:no-store|private)\s*(?:,|$)/i.test(cacheControl)) return null
  const s = /(?:^|,)\s*s-maxage\s*=\s*"?(\d+)"?/i.exec(cacheControl)
  const m = s ?? /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(cacheControl)
  const n = m ? Number(m[1]) : 0
  return n > 0 ? n : null
}

const NULL_BODY = new Set([101, 204, 205, 304])

/**
 * THE `CacheLike` STAND-IN, a Map in one process. It replaces `caches.default`.
 *
 * It keeps four of the five promises in CacheLike's docstring (src/worker.ts):
 *   1. It HONOURS max-age. Every put carries one; an entry past it is a miss and is dropped.
 *   2. It RETURNS A FRESH BODY. The bytes are read once on put and a new Response is built on every
 *      match, so two matches never share a consumed stream.
 *   4. It NEVER REJECTS. A failed put is a log line.
 *   5. It IS KEYED ON THE EXACT STRING.
 * It BREAKS the third, sharing across processes, and says so: run one adapter process, or implement
 * CacheLike over a shared store. Nothing else changes; the seam is two methods wide.
 *
 * A Map with no bound grows with every post anybody pastes, so it is capped at `maxEntries` and the
 * least recently used entry goes first. Entries live 15 minutes at most (POST_TTL, RESP_TTL), so the cap
 * only matters under a burst.
 */
export function memoryCache(opts: { maxEntries?: number; now?: () => number; log?: (line: string) => void } = {}): CacheLike & { size(): number } {
  const max = opts.maxEntries ?? 5000
  const now = opts.now ?? Date.now
  const log = opts.log ?? console.error
  type Entry = { status: number; statusText: string; headers: [string, string][]; body: Uint8Array; expires: number }
  const m = new Map<string, Entry>()
  return {
    async match(key: string): Promise<Response | undefined> {
      try {
        const e = m.get(key)
        if (!e) return undefined
        if (e.expires <= now()) {
          m.delete(key)
          return undefined
        }
        m.delete(key)
        m.set(key, e)
        return new Response(NULL_BODY.has(e.status) ? null : e.body.slice(), {
          status: e.status, statusText: e.statusText, headers: e.headers,
        })
      } catch (err) {
        log(`cache match failed: ${scrub(err)}`)
        return undefined
      }
    },
    async put(key: string, res: Response): Promise<void> {
      try {
        const ttl = storeSeconds(res.headers.get('cache-control'))
        if (ttl === null) {
          await res.body?.cancel()
          return
        }
        const body = new Uint8Array(await res.arrayBuffer())
        m.delete(key)
        m.set(key, {
          status: res.status, statusText: res.statusText, headers: [...res.headers], body,
          expires: now() + ttl * 1000,
        })
        for (const k of m.keys()) {
          if (m.size <= max) break
          m.delete(k)
        }
      } catch (err) {
        log(`cache put failed: ${scrub(err)}`)
      }
    },
    size: () => m.size,
  }
}

// ── ASSETS ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Content types as Cloudflare's asset server labels these files, measured against mbedfx.app on
 * 2026-11-25: `text/html` and `text/plain` with no charset, and `image/vnd.microsoft.icon` rather than
 * `image/x-icon`.
 */
const ASSET_TYPES: Record<string, string> = {
  '.html': 'text/html', '.txt': 'text/plain', '.ico': 'image/vnd.microsoft.icon', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css',
  '.js': 'text/javascript',
}

/**
 * THE ASSETS STAND-IN, a file server over `public/`. It replaces Workers Static Assets.
 *
 * The worker reaches it only for router.ts's SITE_PATHS, because `run_worker_first` is on in
 * wrangler.jsonc and every request goes through the worker first. It mirrors what production answered
 * when measured on 2026-11-25:
 *   - `/` serves index.html.
 *   - `/index.html` is a 307 to `/`, which is Cloudflare's default html_handling.
 *   - Every file gets `cache-control: public, max-age=0, must-revalidate` and an etag.
 *   - A write verb gets a 405.
 *
 * WHAT DEGRADES: compression. Cloudflare gzips or brotlis `/`; this sends it plain. Put a reverse proxy
 * in front if that matters.
 *
 * ONE PATH SEGMENT, NO DOTFILES. Only plain names directly under `public/` are served, so no url can
 * name a file outside it, whatever the router lets through in future.
 */
export function publicAssets(root: string): Env['ASSETS'] {
  return {
    async fetch(req: Request): Promise<Response> {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
      }
      const { pathname } = new URL(req.url)
      if (pathname === '/index.html') return new Response(null, { status: 307, headers: { location: '/' } })
      const name = pathname === '/' ? 'index.html' : pathname.slice(1)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return new Response(null, { status: 404 })
      let bytes: Buffer
      try {
        bytes = await readFile(join(root, name))
      } catch {
        return new Response(null, { status: 404 })
      }
      const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`
      const headers = {
        'content-type': ASSET_TYPES[extname(name)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=0, must-revalidate',
        etag,
      }
      if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
      return new Response(req.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: { ...headers, 'content-length': String(bytes.byteLength) },
      })
    },
  }
}

// ── MEDIA_RESOLVER ────────────────────────────────────────────────────────────────────────────────

/**
 * THE MEDIA_RESOLVER STAND-IN, pointed at a running `container/server.py`. It replaces the Durable
 * Object namespace that fronts the Cloudflare Container (src/container.ts).
 *
 * The worker calls exactly one thing on it, `getByName(name).fetch('http://media-resolver/resolve',
 * init)`, at six sites in src/worker.ts. Here the path and query are kept and the origin becomes
 * CONTAINER_URL.
 *
 * WHAT DEGRADES: pooling. On Cloudflare the name picks one of RESOLVER_SLOTS (4) container instances;
 * here every name reaches the one container. `server.py` is a ThreadingHTTPServer, so the calls still run
 * side by side. They just share one machine's CPU, and yt-dlp's extraction is the CPU-bound part
 * (docs/SELF-HOSTING.md, "Size the host").
 *
 * NODE:HTTP, NOT fetch(), AND THE TIMEOUT IS THE REASON. The container sends nothing until the whole mux
 * is finished: it buffers the file, then streams it. A `{page}` mux may run for MUX_PAGE_TIMEOUT, which
 * is 360 s (container/server.py). Node's fetch is undici, and undici's default headersTimeout is 300 s;
 * the undici bundled in Node 22.18 (6.21.2) has `headersTimeout != null ? headersTimeout : 3e5`, read
 * from its source. So a fetch() would give up on every long mux 60 s before the container could answer.
 * This uses a socket idle timeout, RESOLVER_TIMEOUT_MS, default 420 s, which is the container's own
 * ceiling plus a minute.
 *
 * A connection error rejects, as a Durable Object fetch does, and every call site already catches it.
 */
export function containerResolver(base: string, timeoutMs = 420_000) {
  const baseUrl = new URL(base)
  const prefix = baseUrl.pathname.replace(/\/+$/, '')
  const lib = baseUrl.protocol === 'https:' ? https : http
  async function resolverFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const asked = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const target = `${baseUrl.origin}${prefix}${asked.pathname}${asked.search}`
    const method = (init.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const body = init.body == null
      ? null
      : typeof init.body === 'string' ? init.body : Buffer.from(await new Response(init.body).arrayBuffer())
    if (body !== null) headers['content-length'] = String(Buffer.byteLength(body))
    return new Promise<Response>((resolve, reject) => {
      const req = lib.request(target, { method, headers, timeout: timeoutMs })
      req.on('timeout', () => req.destroy(new Error(`resolver idle for ${timeoutMs} ms`)))
      req.on('error', reject)
      const signal = init.signal
      if (signal) {
        if (signal.aborted) req.destroy(signal.reason)
        else signal.addEventListener('abort', () => req.destroy(signal.reason), { once: true })
      }
      req.on('response', res => {
        const h = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) h.append(k, x)
          else if (v !== undefined) h.set(k, v)
        }
        const status = res.statusCode ?? 502
        const empty = method === 'HEAD' || NULL_BODY.has(status)
        if (empty) res.resume()
        resolve(new Response(empty ? null : Readable.toWeb(res) as unknown as ReadableStream, {
          status, statusText: res.statusMessage, headers: h,
        }))
      })
      req.end(body ?? undefined)
    })
  }
  return { getByName: (_name: string) => ({ fetch: resolverFetch }) }
}

// ── MUX_RUNNER ────────────────────────────────────────────────────────────────────────────────────

type MuxPolicy = {
  first: (hasPage: boolean) => number
  next: (spent: number) => number | null
  run: (env: Env, job: MuxJob) => Promise<boolean>
}

/**
 * THE MUX_RUNNER STAND-IN, in process. It replaces the MuxRunner Durable Object (src/muxrunner.ts),
 * which cannot be imported here because it extends `DurableObject` from `cloudflare:workers`.
 *
 * It is that class rebuilt line for line from the same exported pieces: runMuxJob, recordMuxGiveUp and
 * clearMuxGiveUp from src/worker.ts, and claimIsLive, firstMuxDelayMs and nextMuxDelayMs from
 * src/muxpolicy.ts. So the retry schedule and the give-up rule cannot drift from production's. Four
 * points that a straight port gets wrong:
 *
 *   - `schedule`: the first caller wins. An armed alarm is left alone, or a popular video would have
 *     its mux pushed back by every paste.
 *   - `claim` CHECKS AND SETS WITH NO AWAIT BETWEEN. A Durable Object's input gates are what make the
 *     storage version atomic. An async Map has no gates, and one `await` between the read and the write
 *     lets two callers both win.
 *   - THE ALARM CLEARS ITS ARMED FLAG BEFORE IT RUNS. Otherwise `schedule` sees an alarm that is armed
 *     forever and refuses every later job for that key.
 *   - THE ALARM NEVER THROWS, for MuxRunner.alarm's reason: one retry policy, written down, here.
 *
 * WHAT DEGRADES: durability. A Durable Object's alarm survives a deploy and a crash; this is a
 * setTimeout, and a restart forgets every armed job. The next paste of the video arms it again. The
 * claim is also only process-wide. That costs nothing here, because muxInflight in src/worker.ts
 * already joins every caller in one process onto one download before a claim is ever asked for.
 *
 * Every alarm's work goes through `track` (the waitUntil set), so SIGTERM waits for a mux that is
 * running. Every timer is unref'd, so an armed alarm never holds the process open on its own, and
 * `close()` clears them all.
 */
export function inProcessMuxRunner(
  env: Env,
  track: (p: Promise<unknown>) => void,
  policy: MuxPolicy = { first: firstMuxDelayMs, next: nextMuxDelayMs, run: runMuxJob },
  log: (line: string) => void = console.error,
) {
  type State = { job?: MuxJob; attempt: number; claim?: number; timer: ReturnType<typeof setTimeout> | null }
  const states = new Map<string, State>()
  const stateOf = (key: string): State => {
    let s = states.get(key)
    if (!s) {
      s = { attempt: 0, timer: null }
      states.set(key, s)
    }
    return s
  }
  /** A key with no job, no claim and no timer is forgotten, as a DO with empty storage is collected. */
  const tidy = (key: string) => {
    const s = states.get(key)
    if (s && !s.job && s.claim === undefined && !s.timer) states.delete(key)
  }
  const arm = (key: string, s: State, ms: number) => {
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => track(alarm(key)), ms)
    s.timer.unref()
  }
  /** MuxRunner's `deleteAll`: the job, the attempt count and the claim go. An alarm armed meanwhile stays. */
  const forget = (s: State) => {
    s.job = undefined
    s.attempt = 0
    s.claim = undefined
  }

  async function alarm(key: string): Promise<void> {
    const s = states.get(key)
    if (!s) return
    s.timer = null
    try {
      const job = s.job
      if (!job) {
        forget(s)
        return
      }
      const attempt = s.attempt
      let done = false
      let threw = false
      try {
        done = await policy.run(env, job)
      } catch {
        done = false
        threw = true
      }
      const next = policy.next(attempt)
      if (done || next === null) {
        if (done) await clearMuxGiveUp(env, job.key)
        else await recordMuxGiveUp(env, job, threw)
        forget(s)
        return
      }
      s.attempt = attempt + 1
      arm(key, s, next)
    } catch (err) {
      log(`mux alarm failed: ${scrub(err)}`)
    } finally {
      tidy(key)
    }
  }

  return {
    getByName(key: string) {
      return {
        async schedule(job: MuxJob): Promise<void> {
          const s = stateOf(key)
          if (s.timer) return
          s.job = job
          arm(key, s, policy.first(!!job.source?.page))
        },
        async claim(): Promise<boolean> {
          const s = stateOf(key)
          const now = Date.now()
          if (claimIsLive(s.claim, now)) return false
          s.claim = now
          return true
        },
        async release(): Promise<void> {
          const s = states.get(key)
          if (!s) return
          s.claim = undefined
          tidy(key)
        },
      }
    },
    /** How many keys hold state. For tests and for a shutdown log line. */
    size: () => states.size,
    close(): void {
      for (const s of states.values()) if (s.timer) clearTimeout(s.timer)
      states.clear()
    },
  }
}

// ── SMOKE_RUNNER ──────────────────────────────────────────────────────────────────────────────────

/**
 * THE SMOKE_RUNNER STAND-IN. It replaces the SmokeRunner Durable Object (src/smokerunner.ts) and runs
 * its body, `scheduledSmoke(env, ctx, scheduledDeps())`, in this process.
 *
 * IT IS REQUIRED HERE, NOT OPTIONAL, though it looks optional in `Env`. Without the binding the cron
 * falls back to `smokeWhereReadersAre`'s in-place path, whose default is `liveDeps()`, and that reads
 * `caches.default`, a global Node does not have. The scheduled check would throw a ReferenceError on
 * every tick. scheduledDeps() is the cold cache SmokeRunner itself uses, so this is also what
 * production runs.
 *
 * WHAT DEGRADES: placement. The point of the real object is to run the check from eastern North
 * America, where Discord's crawler is. Here it runs from wherever this host is. The colo `/_health`
 * records comes from cloudflare.com/cdn-cgi/trace, so it names the Cloudflare data center nearest this
 * host's egress, not the host.
 */
export function inProcessSmokeRunner(env: Env, ctx: ExecutionContext, deps: () => Deps = scheduledDeps) {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (_id: DurableObjectId, _options?: { locationHint?: string }) => ({
      run: () => scheduledSmoke(env, ctx, deps()),
    }),
  }
}

// ── AE ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE AE STAND-IN. It replaces Workers Analytics Engine.
 *
 * Off by default, which is what an unbound AE does in the worker: every counter is dropped and every
 * card still renders. With ANALYTICS_LOG=1 each data point is one JSON line on stdout, for a log
 * pipeline to count. The blobs are platform, outcome and client class, a closed vocabulary with no url
 * in it (docs/METRICS.md), so the lines are as safe to keep as the counters are.
 *
 * WHAT DEGRADES with it off: the only signal that reports a refused egress, because the counters
 * docs/SELF-HOSTING.md tells a self-hoster to watch are these.
 */
export function analytics(toStdout: boolean): Env['AE'] {
  if (!toStdout) return undefined
  return {
    writeDataPoint(x) {
      process.stdout.write(`${JSON.stringify({ ae: x.blobs ?? [], d: x.doubles ?? [] })}\n`)
    },
  }
}

// ── RESOLVE_HOST ──────────────────────────────────────────────────────────────────────────────────

/**
 * THE DNS HALF OF THE WORKER'S ADDRESS GUARD (src/netguard.ts). A Worker has no resolver, so on
 * Cloudflare this is undefined and the guard checks the hostname text alone. Here it is wired, so a
 * public name that resolves into this host's network (`evil.example IN A 127.0.0.1`) is refused
 * before the fetch. Every address is returned, so one private answer among public ones still refuses.
 */
export const resolveHost = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map(a => a.address)

// ── vars and secrets ──────────────────────────────────────────────────────────────────────────────

/**
 * EVERY STRING VAR AND SECRET `Env` DECLARES, read from process.env. An ALLOWLIST rather than a copy of
 * process.env: a copied PATH is harmless, but a stray `AI=1` or `ASSETS=x` in an operator's
 * environment would land on a binding's name. test/node-adapter.test.mjs parses `Env` out of
 * src/analytics.ts and fails when a string field is added there and not here.
 */
export const ENV_VARS = [
  'RESOLVER_SECRET', 'OWN_HOSTS', 'MUX_BUFFER_MAX', 'PUBLIC_ORIGIN', 'GUEST_HOSTS', 'SITE_NAME', 'REDDIT_USER_AGENT',
  'IMGUR_CLIENT_ID', 'TRANSLATE_GOOGLE', 'IG_GRAPHQL_DOC_ID',
  'X_ACCOUNTS', 'IG_ACCOUNTS', 'YT_ACCOUNTS', 'YT_PROMISE',
  'X_ACCOUNTS_2', 'X_ACCOUNTS_3', 'IG_ACCOUNTS_2', 'IG_ACCOUNTS_3', 'YT_ACCOUNTS_2', 'YT_ACCOUNTS_3',
  'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_RELAY_URL', 'REDDIT_RELAY_KEY',
] as const

/**
 * The string half of `Env`. Three values are not passed through as given:
 *   - YT_PROMISE defaults to "off", which is what wrangler.production.jsonc sets on the public instance. Until
 *     2026-11-25 an unset var meant the YouTube activity-document promise was ON, so without this the
 *     same paste drew a different card here than there. The code now reads unset as off by itself
 *     (src/muxpolicy.ts ytPromiseOn), so this changes nothing that renders today. It stays as the
 *     second lock: if that predicate ever slides back to "anything but off", this adapter still runs
 *     the value production measured, and test/node-adapter.test.mjs still sees "off" on the env.
 *   - PUBLIC_ORIGIN is `origins`, the list main() parsed (adapters/node/server.ts parseOrigins), not the
 *     variable's raw text. The two agree whenever the variable is set, since that list was parsed from
 *     it. When it is unset they do not: the adapter serves on its default, `http://localhost:$PORT`, and
 *     the Worker reads PUBLIC_ORIGIN for the scheduled check's origin (cronOrigin in src/worker.ts), so
 *     the cron renders on the origin this process actually serves rather than on the Worker's fallback.
 *   - OWN_HOSTS gains the hosts of PUBLIC_ORIGIN. The value is additive (src/platforms/fedihost.ts),
 *     so this can only make the guard stricter, and it means the domain this adapter serves is
 *     refused as a fediverse instance even when the operator forgets to list it. Since 2026-11-25 the
 *     guard also reads PUBLIC_ORIGIN itself, on both runtimes, so this fold is the second of two locks.
 * An empty string is treated as unset. Compose writes `${VAR:-}` as "", and "" is not "off".
 */
export function envVars(source: Record<string, string | undefined>, origins: string[]): Partial<Env> {
  const out: Record<string, string> = {}
  for (const name of ENV_VARS) {
    const v = source[name]
    if (typeof v === 'string' && v !== '') out[name] = v
  }
  out.YT_PROMISE ??= 'off'
  if (origins.length) out.PUBLIC_ORIGIN = origins.join(' ')
  else delete out.PUBLIC_ORIGIN
  const own = [out.OWN_HOSTS, ...origins.map(o => new URL(o).hostname)].filter(Boolean).join(' ')
  if (own) out.OWN_HOSTS = own
  return out as Partial<Env>
}
