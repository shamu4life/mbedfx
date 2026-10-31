import type { Env } from '../../analytics.ts'
import { countRelay } from '../../analytics.ts'

/**
 * I/O ONLY: Reddit's requests through the owner's relay (relay/server.mjs, on Google Cloud Run) when one is
 * configured, so they leave from an address Reddit does not block and the archive does not share with every
 * Cloudflare Worker (fetch.ts keptArchive has the measurement). The owner chose Cloud Run on 2026-10-26.
 *
 * WHAT GOES THROUGH IT: the embed page (refused to Cloudflare since 2026-10-22), the Arctic Shift archive (its
 * per-address limit is spent by every Worker) and Reddit's Atom feed (rationed to one request a minute per
 * address, caption.ts). Reddit's crawler page does NOT: it answers Cloudflare's egress, it is asked on every
 * archive card, and routing it would only add a hop and a second place to fail.
 *
 * FALLING BACK IS ALWAYS SAFE AND ALWAYS COUNTED. Anything the relay says about itself (`x-relay: error`: a wrong
 * key, a refused host, an upstream that did not answer), any answer without the relay's mark (Cloud Run's own
 * error page, a misconfigured url) and a relay that does not answer within RELAY_TIMEOUT_MS all fall back to the
 * direct request this code made before the relay existed, so a broken relay costs what no relay cost and never
 * more. `relay_fallback` counts each one: a relay that silently fails would look exactly like no relay at all,
 * cards degrading to the rate-limited archive path, and the counter is the only thing that would say so. An
 * answer MARKED upstream is final whatever its status, Reddit's 403 block page and the archive's 429 included:
 * that is the upstream's answer to judge, the way a direct one would be.
 *
 * THE CALLER'S OWN DEADLINE WINS. When the caller's signal fires, the error is rethrown rather than retried
 * directly, because there is no time left for a second ask. The relay's own ceiling exists because the embed
 * fetch has none of its own, and a cold Cloud Run instance must not hold a card longer than the direct request
 * it replaced.
 */

/**
 * NOT MEASURED YET: chosen before the relay was deployed, to sit inside the archive path's own budget
 * (fetch.ts ARCHIVE_PATH_BUDGET_MS, 3000). Check it against the deployed relay's real times, a cold start
 * included, before trusting it; `relay_fallback` rising with no relay outage is the sign it is too tight.
 */
const RELAY_TIMEOUT_MS = 2500

/** Whether this url is one the relay carries (see above). */
export function relayedUrl(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:') return false
  return u.hostname === 'embed.reddit.com'
    || u.hostname === 'arctic-shift.photon-reddit.com'
    || (u.hostname === 'www.reddit.com' && u.pathname.startsWith('/by_id/'))
}

/** The relay's base url when both secrets are set and the url is https, else null (no relay). */
export function relayBase(env: Env): string | null {
  const base = env.REDDIT_RELAY_URL
  if (!base || !env.REDDIT_RELAY_KEY || !/^https:\/\/[^/?#]+/.test(base)) return null
  return base.replace(/\/+$/, '')
}

/** A `fetch` that sends relayed urls through the relay and everything else, and every fallback, directly. */
export function viaRelay(env: Env): typeof fetch {
  const base = relayBase(env)
  if (!base) return fetch
  const key = env.REDDIT_RELAY_KEY as string
  const relayed = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    // NO-RETRY: this function IS a fetch, handed to callers that already decided (askTwice wraps it for the
    // embed page and the archive card read; the caption sources and the gallery parent say NO-RETRY at their own
    // call). Retrying here as well would ask twice per attempt.
    if (!relayedUrl(url)) return fetch(input, init)
    const headers = new Headers(init.headers)
    headers.set('x-relay-key', key)
    const target = `${base}/fetch?url=${encodeURIComponent(url)}&redirect=${init.redirect === 'manual' ? 'manual' : 'follow'}`
    const own = AbortSignal.timeout(RELAY_TIMEOUT_MS)
    try {
      // `redirect: 'manual'` on the relay call itself, always: the relay hands back an upstream's 3xx as it is,
      // and following its relative Location would send the next request to the relay's own origin.
      // NO-RETRY: a relay that cannot answer is not asked again, it is replaced by the direct request below;
      // the caller's own retry policy (askTwice or its NO-RETRY) still governs the request as a whole.
      const res = await fetch(target, { headers, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, own]) : own })
      if (res.headers.get('x-relay') === 'upstream') {
        countRelay(env, 'relay_ok')
        return res
      }
      res.body?.cancel().catch(() => {})
    } catch (e) {
      if (init.signal?.aborted) throw e
    }
    countRelay(env, 'relay_fallback')
    // NO-RETRY: the fallback is exactly the direct request the caller would have made with no relay, and the
    // caller's own policy (askTwice or its NO-RETRY) decides whether that is asked twice.
    return fetch(input, init)
  }
  return relayed as typeof fetch
}
