import { FEDI_HOST } from '../refkey.ts'

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
 * family — including the `::ffff:` and NAT64 spellings that defeat naive prefix checks — plus
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
 * WHAT THIS DOES NOT COVER, said plainly: a PUBLIC hostname that resolves to a private address. No
 * DNS resolution happens here and there is no TOCTOU-free way to add one in a Worker; Cloudflare's
 * docs are silent on whether `fetch()` blocks private ranges at all. The bound on that residual is
 * (3)+(5)+(6): the request carries nothing, and a response that is not the expected document never
 * reaches a client — so the worst case is a blind GET, not an exfiltration channel or an open proxy.
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
const OWN_HOSTS = ['mbedfx.app', 'megapenispoopenfarten.sex', 'workers.dev']

export function fetchableInstance(host: string, self?: string): boolean {
  if (!FEDI_HOST.test(host)) return false
  const own = [...OWN_HOSTS]
  if (self) {
    try {
      own.push(new URL(self).hostname.toLowerCase())
    } catch {
      // A malformed origin is not a reason to admit the host; it is simply no extra information.
    }
  }
  return !own.some(h => host === h || host.endsWith(`.${h}`))
}
