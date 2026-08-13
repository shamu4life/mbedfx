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
 * EVERY SERVING DOMAIN MUST BE LISTED, and adding one to wrangler.jsonc without adding it here is a
 * silent SSRF hole rather than a cosmetic omission: a fediverse ref names its own origin, so
 * `/{our-own-host}/post/1` would make the Worker fetch itself through the edge — the one request
 * clause 2 exists to refuse. The `.endsWith('.' + h)` test below covers every subdomain, so a bare
 * apex entry is enough per zone.
 *
 * mbedfx.app was added 2026-07-30 alongside the original domain, which is retained: links already
 * pasted in Discord keep resolving, so both are genuinely serving and both must be refused here.
 */
const OWN_HOSTS = ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'workers.dev']

/**
 * The two settings a fediverse fetch reads off the environment. Structural rather than `Env` so this
 * file keeps importing nothing but refkey.ts and netguard.ts, and so a test can pass `{}`.
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
   *     still refuses every private destination, and FEDI_HOST still refuses IP literals. What an
   *     unset value leaves open is exactly ONE host: the operator's own public domain, which
   *     resolves to their own public address. The worst case there is a single self-request that
   *     lands on a path this Worker does not serve as an API, fails clause 6's content assert, and
   *     renders "couldn't load". It is a misconfiguration, not a way into a network.
   *   - SET cannot subtract. A typo, an empty string, or a hostile value cannot un-block mbedfx's
   *     own zones, so the failure mode of getting this wrong is always "too strict", never "too
   *     open". A guard whose config can widen it is a guard one env var away from being absent.
   *
   * Still MANDATORY for a public self-hosted instance, and docs/SELF-HOSTING.md says so: on
   * Cloudflare a self-fetch re-enters through the edge and bypasses the zone's own WAF, and off it
   * a service that will fetch its own hostname is a service that will fetch its own siblings on the
   * same private network the moment DNS says so.
   */
  OWN_HOSTS?: string
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
  /** The origin this request arrived on, when a caller has one. Refused like any OWN_HOSTS entry. */
  self?: string
  env?: FediEnv
}

/** `a.example, https://b.example` -> ['a.example', 'b.example']. Total: junk contributes nothing. */
function declaredHosts(list?: string): string[] {
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
  const own = [...OWN_HOSTS, ...declaredHosts(env?.OWN_HOSTS)]
  if (self) {
    try {
      own.push(new URL(self).hostname.toLowerCase())
    } catch {
      // A malformed origin is not a reason to admit the host; it is simply no extra information.
    }
  }
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
