import type { Env } from './analytics.ts'

/**
 * WHO THIS DEPLOYMENT SAYS IT IS, read from its vars in one place (self-hosting phase 6, 2026-11-25).
 *
 * Until then three strings were constants, and every fork shipped them unchanged:
 *   - 'mbedfx' as og:site_name on four heads and provider_name in the oEmbed document;
 *   - 'web:mbedfx.app:v0.1 (by /u/shamu4life)', sent to Reddit's OAuth API. A fork running its OWN
 *     Reddit app credentials introduced itself to Reddit as the owner's app and the owner's account,
 *     so whatever that fork did was Reddit's to attribute to the owner;
 *   - 'mbedfx.app (embed fixer; +https://github.com/shamu4life/mbedfx)', sent to the Arctic Shift
 *     archive. Its rate limit and its maintainer's complaints about a fork's traffic landed on
 *     mbedfx.app the same way.
 *
 * Every function here is total: a var is a string or absent on Cloudflare, but the Node adapter, a test
 * or a hand-built env can hand over anything, and these run inside renders and fetches that must not
 * throw over a setting. With the public instance's vars (wrangler.production.jsonc) each one returns
 * exactly the constant it replaced; test/instance.test.mjs reads that file and pins it.
 */

/**
 * The name a card gives its instance when SITE_NAME is unset. It is the software's name, not a host:
 * an unconfigured fork is still running mbedfx, and naming the software claims no domain.
 */
export const DEFAULT_SITE_NAME = 'mbedfx'

/**
 * ONE READING OF A SITE NAME, for siteName below and for the renderers, which apply it again to
 * whatever reaches them. That second pass is for test/*.mjs, which call the renderers with three
 * arguments and are never typechecked: without it a missing name would print the word "undefined" in
 * og:site_name. Trimmed, because a dashboard value pasted with a trailing space would otherwise print
 * one. Empty or blank means unset, because the Cloudflare dashboard and compose's `${VAR:-}` both
 * produce "" for a variable nobody filled in.
 */
export function siteLabel(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : ''
  return v || DEFAULT_SITE_NAME
}

/** The SITE_NAME var, read once per request in worker.ts and passed to every render. */
export function siteName(env: Pick<Env, 'SITE_NAME'> | undefined): string {
  return siteLabel(env?.SITE_NAME)
}

/**
 * WHETHER A URL `host` IS ONE A DEPLOYMENT CAN BE REACHED ON: dot-separated labels of letters, digits and
 * hyphens, or a bracketed IPv6 literal, either with an optional port. Takes the URL parser's own spelling
 * (lowercase, punycode, the default port dropped), so it is a shape check and not a second parser.
 *
 * WHY THE PARSER IS NOT ENOUGH. WHATWG forbids neither `"` nor an empty label in a host, so
 * `new URL('https://a"b')` and `new URL('https://x..y')` both parse, and neither names anything DNS can
 * serve. The converter page writes these names into its head, its buttons and its links
 * (src/sitepage.ts), where a quote is one step from an attribute. Read here, once, the cron, the user
 * agents and the page skip the same entries, so they cannot disagree about which origin is the primary.
 * A trailing dot is refused as well: the page compares hosts as plain strings, and `example.com.` would
 * be a second spelling of `example.com` there.
 */
export function servableHost(host: string): boolean {
  return /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::[0-9]+)?$/.test(host)
}

/**
 * EVERY ORIGIN PUBLIC_ORIGIN DECLARES, IN ORDER: the one reading of the var (self-hosting phase 5,
 * 2026-11-25). An entry counts when it is a bare http(s) origin, as the Node adapter's parseOrigins
 * requires (no path, query, fragment or credentials), and its host passes servableHost. Junk is skipped,
 * never thrown, because the cron reads this inside the scheduled handler and a throw there is a tick with
 * no record. Skipping rather than stopping means a typo in one entry falls through to the next real one.
 *
 * primaryOrigin below is the first of these, and the converter page's host lists are all of them
 * (pageConfig in src/sitepage.ts). The page needed the whole list, and reading it a second time there
 * is how the two came to disagree once: the page filtered `https://a"b` out and the cron did not, so a
 * value with that entry first put the check on one origin and the page's head on another.
 */
export function publicOrigins(env: Pick<Env, 'PUBLIC_ORIGIN'> | undefined): URL[] {
  const list = env?.PUBLIC_ORIGIN
  const out: URL[] = []
  for (const raw of (typeof list === 'string' ? list : '').split(/[\s,]+/)) {
    if (!raw) continue
    try {
      const u = new URL(raw)
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/' && !u.search && !u.hash
        && !u.username && !u.password && servableHost(u.host)) {
        out.push(u)
      }
    } catch {
      // Not a url: skipped, like every other entry that is not an origin.
    }
  }
  return out
}

/**
 * The PRIMARY entry of PUBLIC_ORIGIN: the first that publicOrigins keeps. Null when none qualifies, so
 * each caller chooses its own fallback: the scheduled check needs SOME origin to render on (cronOrigin in
 * src/worker.ts), the converter page falls back to the origin it was requested on (src/sitepage.ts), and
 * the user agents below need to know that there isn't one. It decides what this instance calls itself
 * and nothing else; it never admits a host anywhere.
 *
 * Moved here from cronOrigin on 2026-11-25, so the cron and the user agents cannot read "primary" two
 * ways, and built on publicOrigins the same day, so the converter page cannot either.
 */
export function primaryOrigin(env: Pick<Env, 'PUBLIC_ORIGIN'> | undefined): string | null {
  return publicOrigins(env)[0]?.origin ?? null
}

/**
 * THE PRIMARY ORIGIN'S HOSTNAME, IF IT NAMES THIS DEPLOYMENT TO A STRANGER. The user agents below
 * send it to Reddit and to the archive, so two kinds of primary are read as no host at all:
 *   - `localhost` and `*.localhost`. The Node adapter fills PUBLIC_ORIGIN with
 *     `http://localhost:$PORT` when the operator sets none (adapters/node/server.ts), so an unset
 *     variable on Node arrives here as localhost. It names nobody, and `web:localhost:v0.1` would
 *     read to Reddit as a deliberate app id.
 *   - an IP literal. A primary like `http://192.168.1.20:8787` is an address on the operator's own
 *     network, and a user agent would put it in a third party's logs.
 * The port is dropped (hostname, not host): Reddit's format separates its fields with colons.
 */
export function primaryHost(env: Pick<Env, 'PUBLIC_ORIGIN'> | undefined): string | null {
  const origin = primaryOrigin(env)
  if (!origin) return null
  const h = new URL(origin).hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return null
  // An IPv6 literal keeps its brackets in `hostname`; an IPv4 one is all digits and dots.
  if (h.startsWith('[') || /^[\d.]+$/.test(h)) return null
  return h
}

/**
 * Reddit's OAuth user agent with no REDDIT_USER_AGENT and no usable primary. It names the software and
 * says it is a self-hosted copy. Reddit's rules want a contact as well, and there is none to give,
 * which docs/SELF-HOSTING.md tells an operator who sets the Reddit credentials.
 */
export const REDDIT_UA_FALLBACK = 'web:mbedfx-selfhost:v0.1'

/**
 * THE USER AGENT FOR REDDIT'S OAUTH API, and only that: the embed path sends a browser's, the crawler
 * page Discord's, so this one string identifies the app whose credentials are in REDDIT_CLIENT_ID.
 * Reddit's convention is `platform:app-id:version (by /u/user)`. The operator's own value wins, trimmed.
 * Without one it is `web:<primary host>:v0.1`, which tells Reddit which deployment is asking, or
 * REDDIT_UA_FALLBACK. Neither default names a Reddit account. A guessed one would put somebody's name
 * on traffic they did not send, which is the defect this replaced.
 */
export function redditUserAgent(env: Pick<Env, 'REDDIT_USER_AGENT' | 'PUBLIC_ORIGIN'> | undefined): string {
  const own = typeof env?.REDDIT_USER_AGENT === 'string' ? env.REDDIT_USER_AGENT.trim() : ''
  if (own) return own
  const host = primaryHost(env)
  return host ? `web:${host}:v0.1` : REDDIT_UA_FALLBACK
}

/**
 * The part of the archive's user agent that stays the same on every deployment: what the software is
 * and where its source lives. Arctic Shift asks its users to be considerate, and the repository is
 * where a person finds out what is asking and how to reach whoever runs it. relay/server.mjs repeats
 * it, because the relay's /selftest has to send what the Worker sends.
 */
export const ARCHIVE_UA_PRODUCT = '(embed fixer; +https://github.com/shamu4life/mbedfx)'

/**
 * THE ARCHIVE'S USER AGENT: the primary host, then ARCHIVE_UA_PRODUCT. On the public instance that is
 * 'mbedfx.app (embed fixer; …)', exactly the constant it replaced. A deployment with no usable primary
 * leads with the software's name rather than with a host it does not own. There is no var for the whole
 * string: the leading host is the one part that differs between deployments, and PUBLIC_ORIGIN already
 * says what it is.
 */
export function archiveUserAgent(env: Pick<Env, 'PUBLIC_ORIGIN'> | undefined): string {
  return `${primaryHost(env) ?? DEFAULT_SITE_NAME} ${ARCHIVE_UA_PRODUCT}`
}
