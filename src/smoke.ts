import type { ClientClass } from './types.ts'

/**
 * THE OUTAGE DETECTOR, and the incident that made it necessary.
 *
 * Facebook embeds were completely broken for up to a week. Meta walled the ordinary post surfaces
 * from datacenter egress somewhere between 2026-08-01 (when this repo last measured them working)
 * and 2026-08-08, and the way anyone found out was the OWNER pasting a link and seeing a failure
 * card. Nothing in the service noticed. The counters in docs/METRICS.md would have shown it to
 * somebody who went looking, and nobody had a reason to look.
 *
 * That is the whole gap this closes: seventeen platforms of undocumented endpoints break
 * independently on somebody else's schedule, and the only detector was a human being surprised.
 *
 * WHAT IT ASSERTS, and the rule it obeys. It renders a known post through THIS WORKER'S OWN code
 * path — the same `handle()` a crawler reaches — and asks whether a real card came back. It never
 * looks at an HTTP status, because on this service every interesting failure answers 200: the
 * failure card is a 200, Meta's login wall is a 200, TikTok's 404 page is a 200. `cardVerdict`
 * below is a pure function over the emitted head, and it is the entire assertion.
 *
 * WHAT IT DOES NOT COLLECT. Platform, outcome and nothing else, through the existing counters. No
 * url, no ip, no user agent, no geolocation. wrangler.jsonc explains at length why Workers Logs are
 * off on this service and why turning them on to make debugging easier would be the wrong trade;
 * a monitor that reintroduced that by the back door would be a worse defect than the outage it
 * detects.
 */

/**
 * The posts this service checks itself against.
 *
 * PUBLIC AND INSTITUTIONAL BY PREFERENCE, because this list is permanent and a private person's post
 * should not be fetched on a timer forever. Each was verified rendering from Cloudflare egress on the
 * date noted; a platform with no verified sample is deliberately ABSENT rather than guessed at, since
 * a check that has never passed cannot tell an outage from a bad entry.
 *
 * THEY ROT, AND THAT IS THE KNOWN WEAKNESS. A deleted post becomes a permanent false alarm, and this
 * cannot distinguish "the platform broke" from "this particular post went away" — both look like a
 * failure card. The mitigation is that the counter names the PLATFORM, so one failing check reads as
 * "look at this entry" and several failing at once reads as "the platform broke". Swapping an entry
 * is a code change on purpose: the list is what makes the endpoint safe (see runSmoke).
 */
export const SMOKE_CHECKS: readonly { platform: string, path: string, verifiedOn: string }[] = [
  // Verified 2026-08-11 from Cloudflare egress: renders byline, caption and a photo through the
  // embed-plugin surface, which is the only Facebook post surface still answering this egress.
  { platform: 'fb', path: '/WYFF4/posts/1596906778724399', verifiedOn: '2026-08-11' },
  // Verified 2026-08-11: the reported reel, repaired by the by-shortcode lookup.
  { platform: 'ig', path: '/reel/DZxLuleoEoC/', verifiedOn: '2026-08-11' },
  // Verified 2026-08-09: a TikTok whose card carries og:video at 576x1024.
  { platform: 'tt', path: '/@.g.r.b/video/7246058829106973978', verifiedOn: '2026-08-09' },
  // "Me at the zoo", the first video published to YouTube. As close to undeletable as this list gets.
  { platform: 'yt', path: '/jNQXAC9IVRw', verifiedOn: '2026-08-09' },
  // Verified 2026-08-10: a Threads video, now proxied rather than redirected.
  { platform: 'th', path: '/@bisniscom/post/DbkwmbMEt6u', verifiedOn: '2026-08-10' },
  /**
   * THE PROFILE ROUTE, and this row is here for the ROUTE rather than for the platform — the one
   * entry in this list that is not about a fragile upstream.
   *
   * Bluesky is the least fragile of the six: a public, documented, unauthenticated API with no UA
   * gate and no anti-bot. What this checks is that OUR profile path still produces a card at all —
   * a shape change in the appview's response, a normalizer that starts refusing every payload, a
   * router arm that stops matching. Every other row detects a platform breaking; this one detects
   * us breaking, which is the failure the rest of the list cannot see because a post card and a
   * profile card share no code below render().
   *
   * bsky.app's own account, chosen for the reason "Me at the zoo" was: as close to undeletable as
   * this list gets. Verified 2026-08-11 from Cloudflare egress — og:title "Bluesky (@bsky.app)",
   * og:image on cdn.bsky.app, counts and join date in og:description.
   */
  { platform: 'bs', path: '/profile/bsky.app', verifiedOn: '2026-08-11' },
]

/**
 * DID A REAL CARD COME BACK? Pure, total over junk, and the one assertion this whole file rests on.
 *
 * A card is real when it carries a TITLE and at least one thing to draw. The two Discord heads differ in
 * which of those they emit — the plain OpenGraph head carries og:image, and a post WITH media
 * renders from the Mastodon-shaped document behind `rel=alternate application/activity+json` and
 * deliberately emits NO og:image (render/discord.ts argues that at length). So the presence of the
 * activity link counts as "something to draw", and requiring og:image would fail every working
 * media post.
 *
 * THE FAILURE CARD IS THE THING BEING DETECTED and it also has an og:title — "Couldn't load this
 * ... post" — so a title alone proves nothing. It carries no media and no activity link, which is
 * exactly what separates it here.
 */
export function cardVerdict(html: unknown): 'ok' | 'failure-card' | 'no-card' {
  if (typeof html !== 'string' || !html) return 'no-card'
  const hasTitle = /<meta property="og:title"/.test(html)
  if (!hasTitle) return 'no-card'
  const drawable = /<meta property="og:(image|video)"/.test(html)
    || /type="application\/activity\+json"/.test(html)
  return drawable ? 'ok' : 'failure-card'
}

/**
 * Run every check and report. Takes the fetch handler rather than importing it, so worker.ts owns
 * the wiring and this file stays testable without a network or a container.
 *
 * ORIGIN IS OUR OWN AND THE PATHS ARE CONSTANTS. Nothing a caller supplies reaches a url here, which
 * is what makes the on-demand route safe: `/_smoke` cannot be pointed at anything, so it is not a
 * fetch proxy and not an oracle for arbitrary hosts. That property is why the list lives in code
 * instead of in a binding or a query parameter.
 *
 * SERIAL, NOT CONCURRENT. Five renders that each may reach an upstream is not a burst worth making
 * simultaneous, and a cron has no deadline pressure. It also keeps the container out of it: none of
 * these paths is a `{page}` remux the resolver would be dispatched for, and a cold mux would be
 * abandoned when the scheduled invocation ends regardless.
 */
export async function runSmoke(
  origin: string,
  render: (url: string) => Promise<Response>,
): Promise<{ platform: string, verdict: 'ok' | 'failure-card' | 'no-card' | 'threw' }[]> {
  const out: { platform: string, verdict: 'ok' | 'failure-card' | 'no-card' | 'threw' }[] = []
  for (const check of SMOKE_CHECKS) {
    try {
      const res = await render(`${origin}${check.path}`)
      out.push({ platform: check.platform, verdict: cardVerdict(await res.text()) })
    } catch {
      // A throw is a failure like any other: the point is whether a reader would have got a card.
      out.push({ platform: check.platform, verdict: 'threw' })
    }
  }
  return out
}

/** The counter name for a verdict. `smoke_ok` and `smoke_fail` are a PAIR; only the ratio means anything. */
export function smokeOutcome(verdict: 'ok' | 'failure-card' | 'no-card' | 'threw'): 'smoke_ok' | 'smoke_fail' {
  return verdict === 'ok' ? 'smoke_ok' : 'smoke_fail'
}

/** The client class every smoke count carries, so a monitor's traffic never dilutes a reader's. */
export const SMOKE_CLIENT: ClientClass = 'other-bot'
