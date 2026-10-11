import type { Route } from './types.ts'

/**
 * GUEST HOSTS — domains another Worker owns, where mbedfx answers only the embed paths.
 *
 * sorryifuckedyour.mom and hotsinglesnear.you are custom domains of the owner's `you-stupid` Worker,
 * which serves a dating-site page at `/` and its own files under it. Added 2026-10-11 at the owner's
 * ask: "mbedfx.app … can perform their functions using the domains … without affecting the root
 * site function from you-stupid". So a post link with the host swapped for one of these unfurls as
 * the post, and the dating page stays where it is.
 *
 * HOW A REQUEST GETS HERE. Not through wrangler.jsonc: a hostname can be a custom domain of exactly
 * one Worker, and these belong to you-stupid. That Worker serves `/`, `/whoami`, `/favicon.ico` and
 * every file in its own public/ first, and hands anything left over to this one through a service
 * binding (`env.MBEDFX.fetch(request)`), which keeps the request's url and so its hostname. That is
 * the only way a guest hostname reaches handle(). Do not add these to wrangler.jsonc's routes: a
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
 * EVERY GUEST HOST IS ALSO REFUSED BY THE SSRF GUARD (fedihost.ts spreads this list into OWN_HOSTS).
 * A fediverse ref names its own origin, and `/hotsinglesnear.you/post/1` would otherwise fetch
 * you-stupid, which hands the leftover path straight back here: a loop through two Workers instead
 * of the one self-fetch that guard was written for.
 *
 * `d.` DOES NOT WORK ON THESE, because you-stupid has no wildcard DNS or route for it. The `.mp4`
 * path suffix is a post route and does.
 *
 * THE CONVERTER OFFERS BOTH AS DOMAIN BUTTONS since 2026-10-11 (owner's call; forsen.sex stays
 * recognised and not offered), and both differences above reach it. public/index.html keeps its own
 * copy of this list (GUEST_HOSTS; it has no build step, and test/landing-convert.test.mjs holds the
 * two equal), and on a guest host its media-only box emits the `.mp4` spelling instead of `d.`. And it
 * can hand out a path that guestServes declines, a bare `/{handle}` above all, which here is the other
 * site's page; /_card echoes guestServes as `guestDeclines` so the preview can say so without a second
 * copy of the switch below.
 */
export const GUEST_HOSTS = ['sorryifuckedyour.mom', 'hotsinglesnear.you']

/** The response header you-stupid reads. Value `served`. See the contract above. */
export const GUEST_MARK = 'x-mbedfx-guest'

/** A guest host or any subdomain of one. Anchored, so `nothotsinglesnear.you` is not one. */
export function isGuestHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return GUEST_HOSTS.some(g => h === g || h.endsWith(`.${g}`))
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
