import { FEDI_HOST } from '../refkey.ts'
import { blockedHost, blockedResolvedHost, type HostResolver } from '../netguard.ts'

/**
 * THE SSRF BOUNDARY SHARED BY EVERY FEDIVERSE CLIENT, and every clause is load-bearing. The host
 * arrives from a URL path segment and becomes the ORIGIN of the request, so this is the closest thing
 * in this codebase to a genuine server-side-request-forgery surface and it is guarded rather than
 * reasoned about.
 *
 * IT LIVES HERE, ALONE, BECAUSE THERE ARE NOW TWO CALLERS. Lemmy/PieFed and the Mastodon-API family
 * both take a user-supplied instance, and a security boundary that exists in two copies is one that
 * will be fixed in one copy. Any future fediverse client imports this rather than restating it.
 *
 * WHAT IS ENFORCED, beyond FEDI_HOST's syntactic shape (which already excludes IP literals in every
 * family — including the `::ffff:` and NAT64 spellings that defeat naive prefix checks — plus bare
 * `localhost`, ports and userinfo; see refkey.ts):
 *
 *   1. https ONLY. Built as a literal by each caller rather than accepted from anywhere.
 *   2. OUR OWN ZONE IS REFUSED — this function. A Worker fetching its own hostname re-enters through
 *      the edge, and Cloudflare's default subrequest behaviour bypasses the zone's own WAF, so the
 *      one host that must never be reachable is the one an attacker would most like to aim at.
 *   3. NO CREDENTIAL IS EVER ATTACHED. Neither client sends a header that would mean anything to a
 *      host other than the intended one; there is nothing to leak by pointing them at an arbitrary
 *      origin.
 *   4. REDIRECTS ARE NOT FOLLOWED (`redirect: 'manual'` at each call site). An instance is free to
 *      3xx us anywhere and a followed hop would land on a host that never passed this gate. lemm.ee
 *      301s its whole API to join-lemmy.org and would otherwise read as a live instance serving HTML.
 *   5. THE BODY IS CAPPED (MAX_BODY), so a hostile origin cannot stream us an unbounded response.
 *   6. THE RESPONSE MUST BE THE RIGHT SHAPE, asserted on CONTENT. Every upstream in this project
 *      returns 200 with a decoy somewhere, so a status check proves nothing.
 *
 *   7. THE DESTINATION MUST NOT BE A PRIVATE ADDRESS — src/netguard.ts, added for self-hosting.
 *      Two halves: `blockedHost` reads the hostname text (every literal spelling of loopback, the
 *      LAN and 169.254.169.254, including the IPv4-mapped and NAT64 forms a prefix blocklist
 *      misses), and `blockedResolvedHost` is the DNS seam. See instanceFetchable below for which
 *      half runs where.
 *
 * CLAUSE 7 IS NOT REDUNDANT WITH THE SHAPE CHECK, and the sentence above it about FEDI_HOST used to
 * imply it was. Corrected 2026-08-12 by RUNNING the regex rather than reading it: FEDI_HOST refuses
 * the single label `localhost` and admits `api.localhost`, `printer.local`, `db.internal`,
 * `host.home.arpa` and `1.0.0.127.in-addr.arpa`, because every one of those is two or more labels
 * ending in letters, which is all it asks for. On Cloudflare those names resolve to nothing and the
 * point is academic. On a self-hosted box they are the machine next door. That is why clause 7
 * checks NAMES as well as address literals, and deleting the name list "because the regex covers
 * it" re-opens exactly this.
 *
 * WHAT THIS DOES NOT COVER, said plainly: on CLOUDFLARE, a PUBLIC hostname that resolves to a
 * private address. No DNS resolution is possible in a Worker and there is no TOCTOU-free way to add
 * one; Cloudflare's docs are silent on whether `fetch()` blocks private ranges at all. The bound on
 * that residual is (3)+(5)+(6): the request carries nothing, and a response that is not the expected
 * document never reaches a client — so the worst case is a blind GET, not an exfiltration channel or
 * an open proxy. OFF Cloudflare that bound is much weaker, because the blind GET leaves a box that
 * is usually inside a network — which is what clause 7's resolver seam exists to close, and why
 * docs/SELF-HOSTING.md tells an operator to wire it.
 */

/** A hostile origin cannot stream us an unbounded response. See clause 5. */
export const MAX_BODY = 512 * 1024

/**
 * Hosts this Worker is served from, which it must never be induced to fetch. See clause 2.
 *
 * EVERY SERVING DOMAIN MUST BE LISTED, and adding one to wrangler.production.jsonc without adding it here is a
 * silent SSRF hole rather than a cosmetic omission: a fediverse ref names its own origin, so
 * `/{our-own-host}/post/1` would make the Worker fetch itself through the edge — the one request
 * clause 2 exists to refuse. The `.endsWith('.' + h)` test below covers every subdomain, so a bare
 * apex entry is enough per zone.
 *
 * mbedfx.app was added 2026-07-30 alongside the original domain, which is retained: links already
 * pasted in Discord keep resolving, so both are genuinely serving and both must be refused here.
 *
 * sorryifuckedyour.mom and hotsinglesnear.you are the public instance's two GUEST HOSTS: this Worker
 * serves embeds on them too, through another Worker's service binding rather than a route of its own.
 * Fetching one would reach that Worker, which hands the path back here; src/guesthost.ts has the rest.
 *
 * WRITTEN OUT, NOT READ FROM THE GUEST_HOSTS VAR, since 2026-11-25. Until then this list spread
 * guesthost.ts's constant. The constant is now a var that wrangler.production.jsonc sets, and the var is
 * added below like OWN_HOSTS, so the guard reads it. The names stay here as well because the routing and
 * the refusal fail differently. If the var is ever lost from production (a deploy without it, a
 * dashboard edit), the guest routing stops and you-stupid gets unmarked answers and serves its own page.
 * That is visible and harmless. Without the names here the same loss would also re-open the two-Worker
 * loop above, silently. They cost every other deployment nothing: refusing someone else's domain as a
 * fediverse instance is the right answer anywhere.
 */
const OWN_HOSTS = [
  'mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'workers.dev',
  'sorryifuckedyour.mom', 'hotsinglesnear.you',
]

/**
 * The settings a fediverse fetch reads off the environment. Structural rather than `Env` so this file
 * keeps importing nothing but refkey.ts and netguard.ts, and so a test can pass `{}`. worker.ts passes
 * the whole `Env`, so a field added here is read from the Worker's own var of the same name.
 */
export interface FediEnv {
  /**
   * THE SELF-HOSTER'S OWN DOMAINS, added to OWN_HOSTS above. Whitespace- or comma-separated; a bare
   * hostname or a full origin (`https://embed.example.com`) both work, because an operator copying
   * the value out of their own config will paste whichever they have.
   *
   * ADDITIVE, NEVER A REPLACEMENT, and that is the whole answer to "what is the safe default":
   *
   *   - UNSET is not "wide open". The built-in list still stands, the address guard (clause 7)
   *     still refuses every private destination, and FEDI_HOST still refuses IP literals. Since
   *     2026-11-25 the domain a request ARRIVED ON is refused too (InstanceGuard.self, from
   *     worker.ts), so a deployment with one domain that forgets this setting can no longer be made
   *     to fetch itself. What an unset value still leaves open is a SIBLING: a second serving
   *     domain, named in a path requested on the first. That host is the operator's own public
   *     domain, which resolves to their own public address. The worst case there is a single
   *     self-request that lands on a path this Worker does not serve as an API, fails clause 6's
   *     content assert, and renders "couldn't load". It is a misconfiguration, not a way into a
   *     network.
   *   - SET cannot subtract. A typo, an empty string, or a hostile value cannot un-block mbedfx's
   *     own zones, so the failure mode of getting this wrong is always "too strict", never "too
   *     open". A guard whose config can widen it is a guard one env var away from being absent.
   *
   * Still MANDATORY for a public self-hosted instance, and docs/SELF-HOSTING.md says so: on
   * Cloudflare a self-fetch re-enters through the edge and bypasses the zone's own WAF, and off it
   * a service that will fetch its own hostname is a service that will fetch its own siblings on the
   * same private network the moment DNS says so. The request-origin refusal does not make it
   * optional: it covers only the domain each request came in on, so every other serving domain is
   * known to this guard through this list, or through PUBLIC_ORIGIN below when the operator lists it
   * there (since 2026-11-25).
   */
  OWN_HOSTS?: string
  /**
   * THE ORIGINS THIS DEPLOYMENT IS SERVED ON (the PUBLIC_ORIGIN var; on Node, the adapter's own
   * PUBLIC_ORIGIN). Every host in it is refused like an OWN_HOSTS entry, and each entry is read the way
   * the request origin is (selfHosts), so a `d.` origin refuses the domain under it as well. Since
   * 2026-11-25, so a Cloudflare deployment that lists its domains here for the scheduled check has them
   * guarded too, as the Node adapter's have been since it folded PUBLIC_ORIGIN into OWN_HOSTS.
   * Additive, like OWN_HOSTS: an entry that does not parse refuses nothing and admits nothing.
   */
  PUBLIC_ORIGIN?: string
  /**
   * THE GUEST HOSTS (src/guesthost.ts). A guest host reaches this Worker through another Worker, and
   * fetching one would loop through that Worker and back. Read with the same parser as OWN_HOSTS, the
   * one guesthost.ts routes with, so every host routed as a guest is refused here. Additive.
   */
  GUEST_HOSTS?: string
  /**
   * THE DNS SEAM (clause 7). Absent on Cloudflare — a Worker has no resolver — and supplied by a
   * self-hosted adapter as roughly `(h) => dns.promises.lookup(h, { all: true }).then(a =>
   * a.map(x => x.address))`. Without it the address check is literal-only, which is all Cloudflare
   * has ever been able to do; with it, `evil.example.com IN A 127.0.0.1` is refused before the
   * request is made. See src/netguard.ts for what it cannot promise (rebinding).
   */
  RESOLVE_HOST?: HostResolver
}

/** Everything a fediverse fetcher knows about ITS OWN deployment, threaded from worker.ts. */
export interface InstanceGuard {
  /**
   * The ORIGIN this request arrived on (`https://embed.example.com`, a URL's `.origin`), when a
   * caller has one. Refused like any OWN_HOSTS entry, subdomains included, and a `d.` alias is
   * refused as its parent too (see selfHosts). worker.ts passes `url.origin`; a bare hostname is
   * read the same way, because until selfHosts existed one did not parse and silently guarded
   * nothing, which is the wrong way for a misspelled argument to fail.
   *
   * ABSENT means "no extra information", never "admit more": a test, a direct caller, or anything
   * else without a request in hand gets exactly the built-in list plus env.OWN_HOSTS.
   */
  self?: string
  env?: FediEnv
}

/**
 * The hosts a request origin makes this guard refuse: its own hostname, plus, on a `d.` host, the
 * host with that ONE label taken off.
 *
 * WHY THE PARENT. `d.` is not a separate site. worker.ts (DIRECT_MEDIA_HOST) reads a leading `d.` as
 * "serve this post's bytes", and every `d.` domain in production is an alias of a serving apex
 * (d.mbedfx.app, d.sorryifuckedyour.mom). So a request on d.embed.example.com is a request to a
 * deployment that also answers on embed.example.com, and `/embed.example.com/post/1` requested there
 * is the same self-fetch as on the apex. Refusing only `d.embed.example.com` would leave the apex,
 * the host an attacker would actually name, open on every direct-media request.
 *
 * THE SAME SHAPE AS DIRECT_MEDIA_HOST (`^d\.[^.]+\.`): `d.` followed by at least two more labels. On
 * `d.com` the parent would be the bare TLD `com`, and refusing every .com instance on the strength
 * of one odd hostname is an outage, not a guard. worker.ts does not treat `d.com` as a direct host
 * either, so here it is just its own hostname. If that regex changes, change this one with it.
 *
 * WHAT THIS DOES NOT HANDLE: a `d.` host directly under a multi-label public suffix (`d.co.uk`) would
 * refuse that whole suffix. Telling `co.uk` from `example.com` needs the public suffix list, which
 * this project does not carry. The failure is "too strict" for one implausible deployment, and that
 * host is already a direct-media host to worker.ts, so the two readings of `d.` still agree.
 *
 * A TRAILING DOT IS DROPPED: `embed.example.com.` is the same host as `embed.example.com`, and the
 * `===`/`endsWith` match in fetchableInstance would otherwise miss it. declaredHosts does the same.
 */
export function selfHosts(self?: string): string[] {
  if (!self) return []
  let h: string
  try {
    // The same reading declaredHosts gives an OWN_HOSTS entry: an origin, or a bare hostname.
    h = new URL(self.includes('//') ? self : `https://${self}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    // A malformed origin is not a reason to admit the host; it is simply no extra information.
    return []
  }
  if (!h) return []
  return /^d\.[^.]+\./.test(h) ? [h, h.slice(2)] : [h]
}

/**
 * `a.example, https://b.example` -> ['a.example', 'b.example']. Total: junk contributes nothing.
 *
 * THE ONE READING OF A HOST-LIST VAR. OWN_HOSTS and GUEST_HOSTS go through it here, and
 * src/guesthost.ts routes GUEST_HOSTS through it too, so the hosts routed as guests and the hosts
 * refused as guests cannot come apart over a separator or a trailing dot.
 */
export function declaredHosts(list?: string): string[] {
  if (!list) return []
  const out: string[] = []
  for (const raw of list.split(/[\s,]+/)) {
    if (!raw) continue
    const t = raw.trim().toLowerCase().replace(/\.$/, '')
    if (t.includes('/') || t.includes('@')) {
      try {
        out.push(new URL(t.includes('//') ? t : `https://${t}`).hostname.replace(/\.$/, ''))
      } catch {
        // Unparseable: contributes nothing. It cannot ADMIT a host, so ignoring it is safe.
      }
    } else {
      out.push(t.replace(/^\./, ''))
    }
  }
  return out.filter(Boolean)
}

/** Every host a PUBLIC_ORIGIN list names, each read as selfHosts reads the request origin. Total. */
function publicHosts(list?: string): string[] {
  return (list ?? '').split(/[\s,]+/).flatMap(selfHosts)
}

/**
 * THE PURE HALF of the gate: shape, our own zones, and every private destination that can be read
 * off the hostname TEXT. Sync, total, and callable before any I/O is spent.
 *
 * `self` stays the second positional parameter it has always been, so the call sites and tests that
 * pass an origin string are untouched.
 */
export function fetchableInstance(host: string, self?: string, env?: FediEnv): boolean {
  if (!FEDI_HOST.test(host)) return false
  // Clause 7, literal half. Redundant with FEDI_HOST today — that regex admits no IP literal — and
  // deliberately not left to it: this is the check that survives someone widening the regex to allow
  // a port, a numeric label, or an IDN, none of which look like they touch SSRF.
  if (blockedHost(host)) return false
  // Five sources, all ADDED to one list, so none of them can take a host off another's: the built-in
  // zones, the operator's declared ones, the deployment's configured origins and guest hosts, and the
  // origin this request arrived on.
  const own = [
    ...OWN_HOSTS, ...declaredHosts(env?.OWN_HOSTS), ...publicHosts(env?.PUBLIC_ORIGIN),
    ...declaredHosts(env?.GUEST_HOSTS), ...selfHosts(self),
  ]
  return !own.some(h => host === h || host.endsWith(`.${h}`))
}

/**
 * THE WHOLE GATE, pure half plus the DNS seam — what a fetcher calls.
 *
 * ASYNC ONLY BECAUSE OF THE SEAM. With no `RESOLVE_HOST` (every Cloudflare deployment) it resolves
 * on the spot with no await of anything real, so the Workers path is unchanged in behaviour and in
 * cost. Keeping the sync `fetchableInstance` exported beside it is not duplication: the pure half is
 * what the smoke checks and the tests assert against, and what a caller with no env still gets.
 */
export async function instanceFetchable(host: string, guard?: InstanceGuard): Promise<boolean> {
  if (!fetchableInstance(host, guard?.self, guard?.env)) return false
  return (await blockedResolvedHost(host, guard?.env?.RESOLVE_HOST)) === null
}
