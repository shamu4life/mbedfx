import type { Env } from './analytics.ts'
import { declaredHosts } from './platforms/fedihost.ts'
import { guestHosts, isGuestHost } from './guesthost.ts'

/**
 * THE CONVERTER PAGE, SERVED WITH THIS DEPLOYMENT'S OWN HOST LISTS (self-hosting phase 5, 2026-11-25).
 *
 * public/index.html has no build step, so until now it carried mbedfx.app's domains as literals: which
 * hosts are "ours", which ones the domain buttons offer, and mbedfx.app as the fallback for everything
 * else. On anyone else's deployment that page handed out https://mbedfx.app/... links, so a fork's own
 * converter sent its readers to the owner's instance. The 'site' arm of serve() now passes the page
 * through pageResponse() below, which adds ONE script element holding this deployment's values. The
 * page reads it and keeps its literal arrays as the fallback for every copy that has no block: a file://
 * open, the tests that lift the converter block, a copy cached before this shipped.
 *
 * PLAIN STRING REPLACEMENT, NOT HTMLRewriter. The Node adapter (adapters/node/) has no HTMLRewriter and
 * runs this same function through handle(), with its publicAssets() stand-in as ASSETS. One spelling on
 * both runtimes means one thing to test.
 *
 * ON mbedfx.app NOTHING ELSE CHANGES. With wrangler.production.jsonc's vars the block reproduces the
 * page's literal arrays exactly, order included, the primary is https://mbedfx.app so the head is left
 * alone, and the served bytes are the file plus the block. test/sitepage.test.mjs renders `/` on every
 * production hostname and checks exactly that.
 */

/** The origin public/index.html's head is written for. On this primary the head is not touched. */
export const PAGE_ORIGIN = 'https://mbedfx.app'

/**
 * The absolute self-links in the page's head, which a crawler unfurling the front page follows: og:url,
 * og:image and twitter:image. They have to be absolute (Discord does not resolve a relative og:image),
 * so they cannot follow the host by themselves. Replaced whole, tag and all, so a stray mention of the
 * origin anywhere else in the file (there are several, in comments) is never touched.
 */
export const HEAD_SELF_LINKS = [
  `<meta property="og:url" content="${PAGE_ORIGIN}/">`,
  `<meta property="og:image" content="${PAGE_ORIGIN}/og.jpg">`,
  `<meta name="twitter:image" content="${PAGE_ORIGIN}/og.jpg">`,
] as const

/** The block goes in front of this, which the page carries exactly once (the tests lift it by this id). */
export const CONFIG_ANCHOR = '<script id="mbedfx-convert">'

/** What the page is told. Every host is a URL `host`: lowercase, punycode, a port only when not default. */
export interface PageConfig {
  /** The origin the head's self-links and the visible copy name. First PUBLIC_ORIGIN entry, else the request's. */
  primary: string
  /** The host the visitor arrived on, one leading `d.` taken off. The page's default domain. */
  host: string
  /** Every host this deployment answers on, d. names folded into their parents. The page's OUR_HOSTS. */
  ours: string[]
  /** The domains the buttons offer, primary first. The page's PUBLIC_HOSTS. */
  public: string[]
  /** The guest hosts, as handle() reads them. The page's GUEST_HOSTS. */
  guests: string[]
  /** Every declared `d.` name. Media only is offered on a domain whose d. name is in here, and nowhere else. */
  direct: string[]
}

/**
 * THE `d.` THE WORKER READS, ONE LABEL, the same shape as DIRECT_MEDIA_HOST in src/worker.ts and selfHosts
 * in src/platforms/fedihost.ts (`d.` and at least two more labels, so `d.com` is its own host).
 *
 * WHY THE SERVER STRIPS IT. The page used to take its domain from location.hostname, and that was
 * reverted on 2026-08-03 (baff668): on d.mbedfx.app the page took d.mbedfx.app for its own domain, and
 * media only put a second d. in front of it, d.d.mbedfx.app. The page now gets the arrived-on host with
 * the d. already gone, so the page never sees a d. host as a domain of its own.
 */
export function stripD(host: string): string {
  return /^d\.[^.]+\./.test(host) ? host.slice(2) : host
}

/**
 * THE ORIGINS A PUBLIC_ORIGIN VALUE DECLARES, in order: every entry that is a bare http(s) origin (no
 * path, query, fragment or userinfo), the same rule the Node adapter's parseOrigins applies. Junk is
 * skipped, never thrown, because the cron reads this too (cronOrigin in src/worker.ts is the first entry).
 */
export function declaredOrigins(spec: string | undefined): URL[] {
  const out: URL[] = []
  for (const raw of (spec ?? '').split(/[\s,]+/)) {
    if (!raw) continue
    try {
      const u = new URL(raw)
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/' && !u.search && !u.hash
        && !u.username && !u.password) {
        out.push(u)
      }
    } catch {
      // Not a url: skipped, like every other entry that is not an origin.
    }
  }
  return out
}

/**
 * A host as the page may be told it, or null. declaredHosts passes a token with no `/` or `@` through
 * untouched, so `<b>` in OWN_HOSTS would otherwise reach the page as a "host". Kept: a string the URL
 * parser gives back unchanged as a host AND that is dot-separated labels of letters, digits and hyphens,
 * with an optional port. The second half is not redundant: the parser accepts `a"b` and `x..y` as hosts
 * (WHATWG forbids neither), and neither is a domain anybody can serve. The block is escaped as well
 * (scriptJson), so this is the first of two locks, and the reason the page can trust every list to hold
 * hostnames. An IPv6 literal does not fit the shape and is dropped; nobody publishes a converter on one.
 */
function pageHost(raw: string): string | null {
  try {
    const u = new URL(`https://${raw}`)
    return u.host === raw && /^[a-z0-9-]+(\.[a-z0-9-]+)*(:[0-9]+)?$/.test(raw) ? raw : null
  } catch {
    return null
  }
}

const dedupe = (xs: string[]) => [...new Set(xs)]

/**
 * THIS DEPLOYMENT'S VALUES FOR THE PAGE, from its vars and the request.
 *
 *   - "ours" is every host the deployment says it answers on: PUBLIC_ORIGIN, then OWN_HOSTS, then
 *     GUEST_HOSTS, then the request's own host, each with one d. taken off. OWN_HOSTS is "every domain
 *     you serve from" (docs/SELF-HOSTING.md), which is what makes forsen.sex ours on mbedfx.app:
 *     production serves it and lists it there, and leaves it out of PUBLIC_ORIGIN so it is not offered.
 *     The request host is always in, so a deployment with no vars still recognises its own links.
 *   - "public" is PUBLIC_ORIGIN's hosts, then the guest hosts. With no usable PUBLIC_ORIGIN it is the
 *     request host alone, then the guest hosts, so an unconfigured deployment offers the one domain the
 *     page was opened on.
 *   - "guests" is GUEST_HOSTS read through isGuestHost, so a host the page treats as a guest is exactly
 *     one handle() routes as a guest.
 *   - "direct" is every d. name the three vars declare. Nothing infers one: a d. name works only when
 *     somebody has pointed DNS at it, and a box that emits a link to a name nobody set up is a dead link.
 *
 * Every list is deduplicated in first-seen order and holds only parsed hosts (pageHost).
 */
export function pageConfig(env: Pick<Env, 'PUBLIC_ORIGIN' | 'OWN_HOSTS' | 'GUEST_HOSTS'>, url: URL): PageConfig {
  const valid = (xs: string[]) => xs.map(pageHost).filter((h): h is string => h !== null)
  // Origins whose host fails the shape are dropped before one can become the primary.
  const origins = declaredOrigins(env.PUBLIC_ORIGIN).filter(u => pageHost(u.host) !== null)
  const originHosts = origins.map(u => u.host)
  const own = valid(declaredHosts(env.OWN_HOSTS))
  const guests = valid(guestHosts(env.GUEST_HOSTS))
  const here = stripD(url.host)
  const first = origins[0]
  const primary = first ? `${first.protocol}//${stripD(first.host)}` : `${url.protocol}//${here}`
  return {
    primary,
    host: here,
    ours: dedupe([...originHosts, ...own, ...guests, url.host].map(stripD)),
    public: dedupe([...(first ? originHosts : [url.host]), ...guests].map(stripD)),
    guests: dedupe(guests.map(stripD).filter(g => isGuestHost(g, env.GUEST_HOSTS, env.PUBLIC_ORIGIN))),
    direct: dedupe([...originHosts, ...own, ...guests].filter(h => stripD(h) !== h)),
  }
}

/**
 * JSON THAT IS SAFE INSIDE AN INLINE <script>. JSON.stringify alone is not: a string holding `</script>`
 * ends the element early, `<!--` changes how the HTML parser reads the rest of a script, and U+2028 and
 * U+2029 end a line in an older JavaScript engine though JSON allows them in a string. Each is written as
 * its \u escape, which parses back to the same value. `<` and `>` can only appear inside a string in JSON,
 * so escaping every one is always valid. `&` goes too, so the text means the same if it is ever moved
 * into an attribute.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** The element the page reads, newline included, so a test can take it back out exactly. */
export function configBlock(cfg: PageConfig): string {
  return `<script id="mbedfx-config">var MBEDFX_CONFIG = ${scriptJson(cfg)};</script>\n`
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * THE PAGE WITH ITS BLOCK, and on any primary but mbedfx.app's, its head self-links pointed at that
 * primary. A page without the anchor comes back exactly as it was: serving the literal arrays is the
 * page's own fallback, and a broken page is worse.
 *
 * The head links are replaced only inside the head, and only when the primary differs from PAGE_ORIGIN,
 * so on mbedfx.app the bytes outside the block are the file's bytes, which is what the owner was promised.
 */
export function injectPage(html: string, cfg: PageConfig): string {
  const at = html.indexOf(CONFIG_ANCHOR)
  if (at < 0) return html
  let out = html.slice(0, at) + configBlock(cfg) + html.slice(at)
  if (cfg.primary !== PAGE_ORIGIN) {
    const end = out.indexOf('</head>')
    if (end > 0) {
      let head = out.slice(0, end)
      for (const tag of HEAD_SELF_LINKS) head = head.split(tag).join(tag.replace(PAGE_ORIGIN, attr(cfg.primary)))
      out = head + out.slice(end)
    }
  }
  return out
}

/**
 * THE CONDITIONAL HEADERS ASSETS MUST NOT SEE. The asset server answers If-None-Match with a 304 and no
 * body, and a 304 has nothing to inject into, so the browser would keep the copy it already had, and that
 * copy may have no block at all (one cached before this shipped). A Range request would hand back part of
 * the file, and a block spliced into part of a page corrupts it. All of them go, so ASSETS always
 * answers with the whole file.
 */
const CONDITIONAL = ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range', 'range']

/**
 * THE 'site' ARM FOR `/`. Every other site path (robots.txt, og.jpg, favicon.ico, openapi.json, the
 * /index.html redirect) goes to ASSETS untouched, conditional headers and all.
 *
 * VALIDATORS ARE DROPPED. The ETag and Last-Modified ASSETS sends describe the file, and the response
 * is the file plus a block that varies by deployment and by host. Revalidating against the file's ETag
 * would answer 304 for a page whose block had changed. content-length is the file's too, and
 * content-encoding is dropped because the body is rebuilt as plain text: on Workers the edge compresses
 * it again, and on Node a stale gzip label over a plain body would be a corrupt page.
 *
 * Cache-Control IS KEPT AS ASSETS SENT IT (`public, max-age=0, must-revalidate`, measured on mbedfx.app
 * 2026-11-25). It cannot serve one host's page on another: every cache keys on the URL, and the host is in
 * the URL. The response cache this Worker keeps (src/cache.ts respCacheKey) is for cards and never sees
 * this route. With no validator left, must-revalidate means a full fetch each time, about the cost of the
 * page every visit, which is what a page that varies by host should cost.
 *
 * HEAD gets the same headers and no body.
 */
export async function pageResponse(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname !== '/' || (req.method !== 'GET' && req.method !== 'HEAD')) return env.ASSETS.fetch(req)
  const headers = new Headers(req.headers)
  for (const h of CONDITIONAL) headers.delete(h)
  // GET even for HEAD: the length and type of what goes out are the injected page's, not the file's.
  const res = await env.ASSETS.fetch(new Request(req.url, { method: 'GET', headers }))
  if (res.status !== 200 || !/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
    if (req.method !== 'HEAD') return res
    await res.body?.cancel()
    return new Response(null, res)
  }
  const body = injectPage(await res.text(), pageConfig(env, url))
  const out = new Headers(res.headers)
  for (const h of ['etag', 'last-modified', 'content-length', 'content-encoding']) out.delete(h)
  return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers: out })
}
