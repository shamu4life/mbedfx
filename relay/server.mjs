/**
 * THE REDDIT RELAY: mbedfx's Reddit and archive requests, sent from a Google Cloud Run address instead of
 * Cloudflare's. No dependencies; Node 20 or later.
 *
 * WHY IT EXISTS. Measured 2026-10-25 and 26 from Cloudflare Workers (CLAUDE.md, "An egress-safe upstream"):
 * embed.reddit.com answers every Cloudflare request with a 403 block page, and the Arctic Shift archive
 * rate-limits per address while every Worker reaches it from the same one (2a06:98c0:3600::103), so it
 * answered 429 to 15 of 15 asks in one minute. Both are about WHERE the request comes from, so the fix is a
 * different "where". The owner chose Google Cloud Run's free tier (2026-10-26) over a relay at home and over
 * asking the archive's maintainer.
 *
 * WHAT IT WILL DO, AND NOTHING ELSE. One authenticated route, GET /fetch?url=…&redirect=manual|follow, for
 * https urls on three hosts (ALLOWED_HOSTS), forwarding three request headers and six response headers. It is
 * not an open proxy: without the key it answers 401, and an off-list host 403. A redirect is followed only to
 * another allowed host, by hand, so an upstream cannot bounce a request somewhere else. GET /selftest asks three
 * FIXED urls and needs no key, because it takes no input and is the one way to measure this egress from outside;
 * its answer is kept for a minute so it cannot be used to hammer anyone.
 *
 * WHAT TELLS mbedfx A RELAY ANSWER FROM AN UPSTREAM ONE: `x-relay: upstream` on everything the upstream said
 * (whatever its status, a 403 or a 429 included, which are Reddit's and the archive's answers to judge), and
 * `x-relay: error` on everything the relay said itself. The Worker falls back to its own direct fetch on the
 * second, never on the first.
 */
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** Exact hostnames, no subdomains: the three hosts mbedfx's Reddit fetcher asks (src/platforms/reddit/fetch.ts). */
export const ALLOWED_HOSTS = new Set(['embed.reddit.com', 'www.reddit.com', 'arctic-shift.photon-reddit.com'])
/** The request headers mbedfx sets on those fetches. Nothing else is forwarded, cookies and auth included. */
const PASS_REQUEST = ['user-agent', 'accept', 'range']
/** The response headers mbedfx reads: the type, a redirect's target, a range, and the archive's rate-limit clock. */
const PASS_RESPONSE = ['content-type', 'content-range', 'location', 'retry-after', 'x-ratelimit-reset', 'x-ratelimit-reset-at']
/** Larger than anything mbedfx needs (its own cap on an archive record is 4 MB), small enough to bound memory. */
export const MAX_BYTES = 8 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 10_000
const MAX_HOPS = 5
/** A key shorter than this is refused at startup, so the relay cannot be deployed open by mistake. */
export const MIN_KEY_LENGTH = 32
const SELFTEST_TTL_MS = 60_000

/** The url as a target this relay may ask, or null. https, an allowed host, the default port, no credentials. */
export function allowedTarget(raw) {
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return null
  return ALLOWED_HOSTS.has(u.hostname) ? u : null
}

/** Constant-time comparison of the caller's key with the configured one. Hashing first evens out the lengths. */
export function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length < MIN_KEY_LENGTH) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Why the relay must not start with this environment, or null when it may. */
export function startupError(env) {
  const key = env.RELAY_KEY
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) {
    return `RELAY_KEY must be set to at least ${MIN_KEY_LENGTH} characters (try: openssl rand -hex 32)`
  }
  return null
}

const own = (status, text) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-relay': 'error' } })

/** The body, up to MAX_BYTES, or null when it is larger. */
async function readCapped(res) {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > MAX_BYTES) { reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const out = new Uint8Array(n)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

/** Ask `target`, following redirects by hand and only to allowed hosts when `follow` is set. */
async function ask(target, headers, follow, fetchImpl) {
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  let url = target
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url.href, { headers, redirect: 'manual', signal })
    const location = res.headers.get('location')
    if (!follow || res.status < 300 || res.status >= 400 || !location) return { res, hops: hop }
    const next = allowedTarget(new URL(location, url).href)
    res.body?.cancel().catch(() => {})
    if (!next) return { off: true }
    if (hop + 1 >= MAX_HOPS) return { tooMany: true }
    url = next
  }
}

async function relayFetch(request, env, fetchImpl) {
  if (!keyMatches(request.headers.get('x-relay-key'), env.RELAY_KEY)) return own(401, 'missing or wrong x-relay-key\n')
  const params = new URL(request.url).searchParams
  const target = allowedTarget(params.get('url') ?? '')
  if (!target) return own(403, 'that url is not one this relay asks\n')
  const headers = {}
  for (const h of PASS_REQUEST) {
    const v = request.headers.get(h)
    if (v) headers[h] = v
  }
  let got
  try {
    got = await ask(target, headers, params.get('redirect') === 'follow', fetchImpl)
  } catch (e) {
    return own(502, `upstream did not answer: ${e?.name === 'TimeoutError' ? 'timeout' : 'error'}\n`)
  }
  if (got.off) return own(502, 'redirect to a host this relay does not ask\n')
  if (got.tooMany) return own(502, 'too many redirects\n')
  let body
  try { body = await readCapped(got.res) } catch { return own(502, 'upstream body cut off\n') }
  if (body === null) return own(502, 'upstream body over the size cap\n')
  const out = new Headers({ 'x-relay': 'upstream', 'x-relay-hops': String(got.hops) })
  for (const h of PASS_RESPONSE) {
    const v = got.res.headers.get(h)
    if (v) out.set(h, v)
  }
  return new Response(body, { status: got.res.status, headers: out })
}

/** The three fixed requests mbedfx depends on, made from this egress, so a person can see what it gets. */
const SELFTEST = {
  embed: { url: 'https://embed.reddit.com/r/aww/comments/bh1r38/', redirect: 'follow',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', accept: 'text/html' },
  crawler: { url: 'https://www.reddit.com/r/aww/comments/bh1r38/', redirect: 'manual',
    ua: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', accept: 'text/html' },
  archive: { url: 'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=bh1r38', redirect: 'follow',
    ua: 'mbedfx.app (embed fixer; +https://github.com/shamu4life/mbedfx)', accept: 'application/json' },
}

let selftestCache = null

export async function selftest(fetchImpl = fetch, now = Date.now()) {
  if (selftestCache && now - selftestCache.at < SELFTEST_TTL_MS) return selftestCache.value
  const value = { at: new Date(now).toISOString() }
  for (const [name, t] of Object.entries(SELFTEST)) {
    const t0 = Date.now()
    try {
      const got = await ask(new URL(t.url), { 'user-agent': t.ua, accept: t.accept }, t.redirect === 'follow', fetchImpl)
      if (!got.res) { value[name] = { error: got.off ? 'redirect off the allowlist' : 'too many redirects' }; continue }
      const text = new TextDecoder().decode((await readCapped(got.res)) ?? new Uint8Array(0))
      value[name] = {
        status: got.res.status, ms: Date.now() - t0, bytes: text.length,
        // The same content checks mbedfx makes: the embed page's canonical marker, the crawler page's title,
        // the archive's record, and Reddit's block page by its own words.
        blocked: /blocked by network security|whoa there, pardner|name="js_challenge"/i.test(text),
        ...(name === 'embed' ? { post: /id="canonical-url-updater"/.test(text) } : {}),
        ...(name === 'crawler' ? { title: (text.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.trim().slice(0, 120) ?? null } : {}),
        ...(name === 'archive' ? { record: /"id":"bh1r38"/.test(text) } : {}),
      }
    } catch (e) {
      value[name] = { error: e?.name === 'TimeoutError' ? 'timeout' : 'error', ms: Date.now() - t0 }
    }
  }
  selftestCache = { at: now, value }
  return value
}

/** The whole relay as a function of a web Request, so the tests drive it with no server and no network. */
export async function handle(request, env, fetchImpl = fetch) {
  const { pathname } = new URL(request.url)
  if (request.method !== 'GET') return own(405, 'GET only\n')
  if (pathname === '/') return new Response('mbedfx relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  if (pathname === '/selftest') {
    return new Response(JSON.stringify(await selftest(fetchImpl), null, 1), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  if (pathname === '/fetch') return relayFetch(request, env, fetchImpl)
  return own(404, 'not found\n')
}

/** Cloud Run starts this file directly; importing it (the tests do) starts nothing. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = startupError(process.env)
  if (problem) { console.error(problem); process.exit(1) }
  const port = Number(process.env.PORT) || 8080
  createServer(async (req, res) => {
    try {
      // Only the headers the relay reads; Cloud Run's own and the hop-by-hop ones stay behind.
      const headers = {}
      for (const h of ['x-relay-key', ...PASS_REQUEST]) {
        if (typeof req.headers[h] === 'string') headers[h] = req.headers[h]
      }
      const request = new Request(`http://relay${req.url}`, { method: req.method, headers })
      const answer = await handle(request, process.env)
      const body = Buffer.from(await answer.arrayBuffer())
      res.writeHead(answer.status, Object.fromEntries(answer.headers))
      res.end(body)
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'x-relay': 'error' })
      res.end('relay error\n')
    }
  }).listen(port, () => console.log(`mbedfx relay listening on ${port}`))
}
