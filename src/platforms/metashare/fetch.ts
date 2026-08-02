/**
 * META'S BARE SHARE CODE — `/share/{code}` — which BOTH Threads and Facebook mint, in the same shape,
 * with no field that tells them apart.
 *
 * REPORTED 2026-07-30. A Threads share link host-swapped onto our domain rendered nothing, and worse:
 * `mbedfx.app/share/Fixture08X/` 302'd a THREADS share token to `facebook.com`, a site the sharer
 * never pasted. facebook()'s bare-share arm claims any `[A-Za-z0-9]{5,}` at seg[1], and a Threads
 * code satisfies it. The reporter's other code, `_pqHlzmHj`, escaped only because a leading
 * underscore fails that class — luck, not a guard.
 *
 * THE DISAMBIGUATION IS A 302, AND IT IS CLEAN. Measured on both codes against both hosts:
 *
 *     threads.com/share/Fixture08X   302 -> threads.com/@dexerto/post/DbWxxQjFe4u?xmt=…&slof=1
 *     facebook.com/share/Fixture08X  200  (no redirect)
 *     facebook.com/share/Fixture03X  302 -> facebook.com/reel/2209468366484962/?rdid=…&share_url=…
 *     threads.com/share/Fixture03X   200  (no redirect)
 *
 * The owning host redirects; the other answers 200 with no Location. So the code is resolved by
 * ASKING, on content, rather than guessed from its shape — which is what this project does everywhere
 * a token is opaque.
 *
 * WHY RESOLVING IS A PRIVACY IMPROVEMENT, not just a routing fix. The destination Facebook redirects
 * to carries the share link BACK as a query parameter:
 *
 *     /reel/971477999277129/?rdid=rdidFixtureXXXXX&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2Fv%2F1Hk3dBbUyJ%2F
 *
 * `share_url` is the original share URL in plaintext, and a share code is minted per SHARING ACT —
 * the same post yields different codes for different shares (verified: two Threads codes, one post,
 * two distinct `xmt` tokens). Forwarding a viewer to the share url hands all of that to the
 * destination. Resolving it here and emitting the bare permalink strips `rdid`, `share_url`, `xmt`
 * and `slof` before anyone clicks — router.ts's canonical() rebuilds from ref fields, so nothing from
 * the redirect target's query string survives.
 */

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

/**
 * The header combination Threads' SSR gate needs. Measured on this project's Threads fetcher: a
 * browser UA ALONE gets a dataless shell — the `Accept` + `Sec-Fetch-*` combination is what makes
 * Meta serve the real response, and the share redirect is gated the same way. A plain curl-shaped
 * request gets 200 and no Location on BOTH hosts, which would read as "neither owns this code".
 */
const SHARE_HEADERS: Record<string, string> = {
  'user-agent': BROWSER_UA,
  accept: 'text/html',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
}

/** The two hosts that mint a bare `/share/{code}`, tried in this order. */
const SHARE_HOSTS = ['www.threads.com', 'www.facebook.com'] as const

/**
 * Follow ONE hop and return the Location, or null. `redirect: 'manual'` is what makes this a
 * disambiguator rather than a fetch: the owning host's 3xx is the answer, and the other host's 200 is
 * the other half of it. A followed redirect would land on a page and lose the distinction.
 *
 * Guards its own fetch, so a blocked or throwing hop degrades to "not this host" rather than
 * propagating — the caller then tries the next one, and a total miss is an honest failure card.
 */
/**
 * How much of a 200 body to read before giving up on finding og:url. Meta's share pages put it in the
 * head; 256 KB is far past that and bounds a page that measured 45 KB (Facebook) to 258 KB (Threads'
 * app shell) — the shell being the case we specifically do NOT want to read in full.
 */
const MAX_BODY = 256 * 1024

/**
 * THE SECOND SIGNAL, added 2026-07-31 after a Facebook share code rendered as a Threads failure.
 *
 * The 302 is the clean answer and stays the first one, but it is not one we always get. Measured on
 * facebook.com/share/Fixture05X: a browser-shaped request from a laptop gets `302 -> /posts/…`, while
 * the SAME request from Cloudflare's egress gets no redirect — Facebook is stricter with datacenter
 * IPs than Threads is, which is why a Threads code resolved from production the whole time and a
 * Facebook one never did. Confirmed by natural experiment against the live worker: Fixture08X (a
 * Threads code) rendered its post; Fixture05X (a Facebook code) did not.
 *
 * What a 200 from the OWNING host still carries is `og:url` pointing at the real permalink, and what
 * the non-owning host carries is nothing:
 *
 *     facebook.com/share/Fixture05X  200 -> og:url .../61557887564469/posts/poor-arnold/1222…
 *     threads.com /share/Fixture05X  200 -> og:url ABSENT
 *     threads.com /share/Fixture08X  302 -> /@dexerto/post/DbWxxQjFe4u
 *     facebook.com/share/Fixture08X  200 -> og:url ABSENT
 *
 * So og:url discriminates exactly as the redirect does, and only the owning host answers with one.
 * It is read ONLY when there is no Location, so the cheap path is unchanged.
 */
function ogUrlOf(html: string): string | null {
  const m = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i)
  return m ? m[1] : null
}

async function locationOf(url: string): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', redirect: 'manual', headers: SHARE_HEADERS })
  } catch {
    return null
  }
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel()
    return res.headers.get('location')
  }
  // Not a redirect. The owning host may still be telling us, in the head — see ogUrlOf.
  if (res.status !== 200) {
    void res.body?.cancel()
    return null
  }
  const len = Number(res.headers.get('content-length') ?? '0')
  if (len > MAX_BODY) {
    void res.body?.cancel()
    return null
  }
  try {
    const body = await res.text()
    return body.length > MAX_BODY ? null : ogUrlOf(body)
  } catch {
    return null
  }
}

/**
 * Resolve a bare `/share/{code}` to the permalink it names, on whichever Meta property owns it.
 *
 * Returns the raw Location. The CALLER re-routes it through route(), exactly as the redditshare path
 * does — so the resolved post takes the ordinary Threads or Facebook code path, with one cache entry
 * and one render, and no new gate vocabulary.
 *
 * SEQUENTIAL, NOT PARALLEL, and deliberately: the wrong host answers 200 quickly, so the second hop
 * is only paid when the first misses, and firing both would double the upstream requests on every
 * share link to save latency on half of them.
 */
/**
 * Meta's own tracking parameters, stripped from a resolved permalink before anyone is sent to it.
 *
 * WHY THIS IS NOT COSMETIC — reported 2026-07-31, by the person it names. Following
 * facebook.com/share/Fixture05X lands on a page headed "see what Alex Fixture shared", and the
 * Location we were forwarding carried
 *
 *     ?rdid=rdidFixtureXXXXX&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F18pJs2hmTD%2F
 *
 * `share_url` is the share link back in plaintext and a share code is minted per SHARING ACT, so
 * forwarding it hands the destination a handle on who shared — the sharer's real name and profile,
 * for someone who deliberately swapped our host in expecting the link to have been cleaned.
 *
 * NOW AN ALLOWLIST. This was a denylist, deliberately, and the comment here stated the trade so it
 * could be re-taken "with better information". That information arrived 2026-08-01, reported against
 * a Threads share link:
 *
 *     threads.com/share/Fixture09X
 *       -> /@_soul_solace_/post/DbcSwYaEa9r?hwta=1&http_ref=eyJ0cyI6MTc4NTU0OTA4MDAwMCwiciI6IiJ9
 *
 * NEITHER `hwta` NOR `http_ref` WAS ON THE LIST, so both survived a function whose entire purpose is
 * removing them. `http_ref` is base64 JSON — {"ts":1785549080000,"r":""} — a per-click timestamp.
 *
 * The denylist could not have worked. It enumerates a set only Meta can change, on properties that
 * mint new parameters continuously, and every addition is invisible to us until somebody reports a
 * dirty link — which is exactly how this one surfaced, twice, having been "fixed" once already.
 *
 * SO THE DEFAULT FLIPS: a parameter survives only by being STRUCTURAL — part of how the permalink
 * identifies its post, without which the url names nothing. That set is small, stable, and OURS to
 * know, because it is the set of shapes the router already parses:
 *
 *     story.php / permalink.php   story_fbid + id     the post IS the pair
 *     /watch/                     v                   the video id
 *     photo.php / /photo/         fbid, set           the photo and its album
 *     Instagram carousels         img_index           which image was linked
 *
 * A Threads or Instagram permalink needs NOTHING, which is why the reported link should have come
 * back bare. The failure mode is now inverted and strictly better: a new tracking parameter is
 * dropped automatically, and the residual risk is Meta inventing a new STRUCTURAL parameter — rare,
 * loud when it happens (the card fails to resolve rather than quietly leaking), and fixable here.
 */
const META_STRUCTURAL = new Set([
  'story_fbid', 'id', 'v', 'fbid', 'set', 'img_index',
])

/**
 * Strip Meta's share/tracking parameters from a resolved url, keeping everything else. Returns the
 * input unchanged if it will not parse — a url we cannot read is one we must not half-rewrite.
 */
export function stripMetaTracking(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  for (const key of [...u.searchParams.keys()]) {
    if (!META_STRUCTURAL.has(key.toLowerCase())) u.searchParams.delete(key)
  }
  // A url whose whole query was tracking should not keep a dangling '?'.
  if (![...u.searchParams.keys()].length) u.search = ''
  return u.toString()
}

/** Which Meta property a resolved permalink is on, for naming a failure honestly. */
export function metaPlatformOf(url: string): 'fb' | 'th' | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  if (host === 'www.threads.com' || host === 'threads.com' || host === 'www.threads.net' || host === 'threads.net') return 'th'
  if (host === 'www.facebook.com' || host === 'facebook.com' || host === 'm.facebook.com' || host === 'fb.watch') return 'fb'
  return null
}

export async function resolveMetaShare(code: string): Promise<string | null> {
  for (const host of SHARE_HOSTS) {
    const loc = await locationOf(`https://${host}/share/${encodeURIComponent(code)}/`)
    // A Location that is not on a Meta property is not an answer we will follow — the code is
    // attacker-supplied and this value becomes a route() input.
    if (loc && /^https:\/\/(?:www\.)?(?:threads\.com|threads\.net|facebook\.com|fb\.watch)\//i.test(loc)) {
      return loc
    }
  }
  return null
}
