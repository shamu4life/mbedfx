import type { Route } from './types.ts'
import { declaredHosts } from './platforms/fedihost.ts'

/**
 * GUEST HOSTS — domains another Worker owns, where mbedfx answers only the embed paths.
 *
 * WHICH DOMAINS ARE GUESTS IS THE `GUEST_HOSTS` VAR, since 2026-11-25 (self-hosting phase 4). Until then
 * it was a constant here naming the owner's two, so every fork declined `/` on them and nobody else could
 * have a guest host of their own without editing this file. wrangler.production.jsonc sets the var to the
 * same two names, so mbedfx.app routes exactly as before. Unset, which is every other deployment unless
 * its operator sets it, there are no guest hosts and handle() is serve() on every hostname.
 *
 * On the public instance, sorryifuckedyour.mom and hotsinglesnear.you are custom domains of the
 * owner's `you-stupid` Worker, which serves a dating-site page at `/` and its own files under it. Added
 * 2026-10-11 at the owner's ask: "mbedfx.app … can perform their functions using the domains … without
 * affecting the root site function from you-stupid". So a post link with the host swapped for one of
 * these unfurls as the post, and the dating page stays where it is.
 *
 * HOW A REQUEST GETS HERE. Not through wrangler.production.jsonc: a hostname can be a custom domain of exactly
 * one Worker, and these belong to you-stupid. That Worker serves `/`, `/whoami`, `/favicon.ico` and
 * every file in its own public/ first, and hands anything left over to this one through a service
 * binding (`env.MBEDFX.fetch(request)`), which keeps the request's url and so its hostname. That is
 * the only way a guest hostname reaches handle(). Do not add these to wrangler.production.jsonc's routes: a
 * deploy reconciles that array, so claiming them there would try to take the domains off you-stupid.
 * test/guesthost.test.mjs fails if one appears.
 *
 * WHAT IS ANSWERED, decided per Route kind in guestServes() below: a pasted post or profile link, the
 * share codes and short links that resolve to one, and the three callbacks a card minted on this
 * origin sends a crawler back to (/_media/, the activity document, oEmbed). Everything else is
 * DECLINED, and on a guest host that is most of the url space:
 *
 *   - `site`. The converter page, robots.txt, og.jpg and openapi.json are mbedfx's front door, and
 *     the front door of these domains is somebody else's.
 *   - `notfound` and `ambiguous`. you-stupid sends any unknown page to its dating page so a typo
 *     still lands on the joke. `ambiguous` is every bare `/{word}`, so answering it here would replace
 *     that page with a chooser on almost every typo.
 *   - `api`, `card`, `prep`. The JSON API and the converter's two endpoints. docs/API.md and
 *     public/openapi.json publish the API on mbedfx's own domains only, and the converter page that
 *     calls the other two is declined above.
 *   - `badid`, and with it the diagnostic paths. A spoof-shaped path whose id does not decode names
 *     no post. It is also the route every experiment status id takes (the `9…` ids /_wait/ mints), and
 *     /_smoke, /_clients, /_stock/ and /_wait/ route to `ambiguous` or `notfound`, so the experiments
 *     and the diagnostics stay on mbedfx's own domains without a second list naming them.
 *
 * THE DECLINE IS A 404 AND THE ANSWER IS MARKED, and the mark is the contract with you-stupid. That
 * Worker passes a response through only when it carries GUEST_MARK: served, and treats anything
 * else, this 404 included, as "not mbedfx's" and serves its own page. Marking what IS served, rather
 * than what is declined, is what keeps a failure here from reaching the dating page: an exception, a
 * Cloudflare error page, or a version of this Worker from before guest hosts existed all come back
 * unmarked, and the visitor sees exactly what they saw before. It also makes the two deploys
 * independent of order.
 *
 * EVERY GUEST HOST IS ALSO REFUSED BY THE SSRF GUARD: fedihost.ts adds the GUEST_HOSTS var to its
 * own-zone list. A fediverse ref names its own origin, and `/hotsinglesnear.you/post/1` would otherwise
 * fetch you-stupid, which hands the leftover path straight back here: a loop through two Workers instead
 * of the one self-fetch that guard was written for. The owner's two are also written out in fedihost.ts's
 * built-in list, so they stay refused even if the var is lost; see the note there.
 *
 * `d.` WORKS ON THESE TOO, since 2026-10-11 (owner's ask). d.sorryifuckedyour.mom and
 * d.hotsinglesnear.you are custom domains of the same you-stupid Worker (shamu4life/you-stupid#22), whose
 * host checks take any subdomain, so a d. request arrives through the same binding with its hostname. Here
 * isGuestHost matches it (subdomains count) and handle() reads the `d.` off the hostname as on any domain
 * (worker.ts DIRECT_MEDIA_HOST), so it is the file, marked, with nothing added for it (pinned in
 * test/guesthost.test.mjs). For a day before that the names had no DNS and the `.mp4` path suffix was the
 * only file spelling here; it is a post route on every host and still works.
 *
 * THE CONVERTER OFFERS BOTH AS DOMAIN BUTTONS since 2026-10-11 (owner's call; forsen.sex stays
 * recognised and not offered). public/index.html keeps its own copy of the list (GUEST_HOSTS; it has no
 * build step, and test/landing-convert.test.mjs holds it equal to wrangler.production.jsonc's var), and
 * its media-only box emits `d.` on them as on every domain. It can hand out a path that guestServes
 * declines, a bare `/{handle}` above all, which here is the other site's page; /_card echoes guestServes
 * as `guestDeclines` so the preview can say so without a second copy of the switch below.
 */

/** The response header you-stupid reads. Value `served`. See the contract above. */
export const GUEST_MARK = 'x-mbedfx-guest'

/**
 * The GUEST_HOSTS var as a list of hostnames. Whitespace- or comma-separated, hostname or origin, read
 * by the same function that reads OWN_HOSTS (fedihost.ts declaredHosts). Sharing it is the point: a
 * host this file routes as a guest is, for any value of the var, a host the guard refuses, and
 * test/guesthost.test.mjs checks that on junk as well as on real values. Total: junk contributes nothing.
 */
export function guestHosts(spec: string | undefined): string[] {
  return declaredHosts(spec)
}

/**
 * A guest host or any subdomain of one. Anchored, so `nothotsinglesnear.you` is not one.
 *
 * `spec` IS REQUIRED, though it may be undefined. Optional would let a caller drop `env.GUEST_HOSTS`
 * and get "no guest hosts" with nothing failing, and on the public instance that is every guest-host
 * answer going out unmarked, which you-stupid replaces with its own page.
 */
export function isGuestHost(hostname: string, spec: string | undefined): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return guestHosts(spec).some(g => h === g || h.endsWith(`.${g}`))
}

/**
 * Whether a guest host gets this route answered. EXHAUSTIVE ON PURPOSE: a new Route kind fails the
 * typecheck here until someone decides whether a domain that is not ours should serve it. Defaulting
 * either way would make that decision silently.
 */
export function guestServes(r: Route): boolean {
  switch (r.kind) {
    case 'post':
    case 'profile':
    case 'shortlink':
    case 'redditshare':
    case 'metashare':
    case 'media':
    case 'activity':
    case 'oembed':
      return true
    case 'site':
    case 'notfound':
    case 'ambiguous':
    case 'badid':
    case 'api':
    case 'card':
    case 'prep':
      return false
    default: {
      const unhandled: never = r
      return unhandled
    }
  }
}

/** The decline: a plain 404, unmarked, never cached. you-stupid replaces it with its own page. */
export function guestDeclined(): Response {
  return new Response('not served on this host\n', {
    status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}
