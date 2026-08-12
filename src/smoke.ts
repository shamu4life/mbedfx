import type { ClientClass, Platform } from './types.ts'

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
 * a check that has never passed cannot tell an outage from a bad entry. An absence is not silent
 * either way — SMOKE_UNCHECKED below names every platform without a row and why, and the test suite
 * fails on a platform that appears in neither list.
 *
 * THEY ROT, AND THAT IS THE KNOWN WEAKNESS. A deleted post becomes a permanent false alarm, and this
 * cannot distinguish "the platform broke" from "this particular post went away" — both look like a
 * failure card. The mitigation is that the counter names the PLATFORM, so one failing check reads as
 * "look at this entry" and several failing at once reads as "the platform broke". Swapping an entry
 * is a code change on purpose: the list is what makes the endpoint safe (see runSmoke).
 *
 * THE ROWS OUTNUMBER THE PLATFORMS, since 2026-08-12: sixteen platforms across seventeen rows, because
 * Bluesky is checked twice (its profile route and a post, which share no code below render()). The
 * counter is per PLATFORM, so those two rows sum into one `bs` pair in the Analytics Engine query and
 * a single failure shows there as half a platform. `name` is what tells them apart, and it is what
 * `/_smoke` and the cron's log line report.
 */
export type SmokeCheck = {
  /**
   * The counter's `blob1`. TYPED rather than a bare string, because this is the value that lands in
   * Analytics Engine: a mistyped code would write a platform that does not exist into a permanent
   * dataset, and nothing downstream would reject it — the SQL in docs/METRICS.md groups by whatever
   * is there. The compiler is the only thing that can catch it before it ships.
   */
  platform: Platform
  /**
   * What `/_smoke` and the cron's log line call this row. UNIQUE, and not the same thing as the
   * platform: `bs` has TWO rows (a profile and a post), so a report keyed on platform alone would
   * say "bs ok, bs failure-card" and leave the reader with no way to tell which one broke. The
   * counter still carries only the platform — Analytics Engine's blob1 is the platform enum and
   * widening it is not worth a dimension.
   */
  name: string
  path: string
  verifiedOn: string
}

export const SMOKE_CHECKS: readonly SmokeCheck[] = [
  /**
   * DAILYMOTION, and the reason it is here rather than in SMOKE_UNCHECKED with Streamable.
   *
   * Both were first excluded together for "a cron hits cold nearly every time: POST_TTL and RESP_TTL
   * are 900s against a 30-minute schedule". That is the wrong cache. The card these two fail to
   * produce depends on the yt-dlp META RECORD, which lives in R2 and is GLOBAL, not on the per-colo
   * response cache — and `DM_META_TTL_MS` is 86_400_000, a full day. A scheduled check therefore
   * reads a warm record on roughly 47 of every 48 ticks.
   *
   * EXPECT ABOUT ONE FAILURE A DAY FROM THIS ROW, and read it as the known cold tick rather than an
   * outage. That is stated here because a counter nobody can interpret is worse than no counter: the
   * ratio is what matters, and `dm` sitting near 47/48 is health. `dm` going to zero is not.
   *
   * FACEBOOK IS THE PRECEDENT ALREADY IN THIS LIST. It is the same container tier with the same 24h
   * meta TTL (FB_META_TTL_MS), is checked, and is measured at 4.0s cold.
   *
   * Verified 2026-08-12 through production as a Discordbot: a complete card, og:title
   * "Fortune (@Fortune)" with og:video and an activity link, 1674 bytes in 0.38s warm. Fortune's own
   * upload, i.e. publisher-owned — the id this repo shipped before (xaqwy7q) went HTTP 410 Gone,
   * which is what a random reupload does.
   */
  { platform: 'dm', name: 'dm', path: '/video/x8ocv9e', verifiedOn: '2026-08-12' },

  // Verified 2026-08-11 from Cloudflare egress: renders byline, caption and a photo through the
  // embed-plugin surface, which is the only Facebook post surface still answering this egress.
  { platform: 'fb', name: 'fb', path: '/WYFF4/posts/1596906778724399', verifiedOn: '2026-08-11' },
  // Verified 2026-08-11: the reported reel, repaired by the by-shortcode lookup.
  { platform: 'ig', name: 'ig', path: '/reel/DZxLuleoEoC/', verifiedOn: '2026-08-11' },
  // Verified 2026-08-09: a TikTok whose card carries og:video at 576x1024.
  { platform: 'tt', name: 'tt', path: '/@.g.r.b/video/7246058829106973978', verifiedOn: '2026-08-09' },
  // "Me at the zoo", the first video published to YouTube. As close to undeletable as this list gets.
  { platform: 'yt', name: 'yt', path: '/jNQXAC9IVRw', verifiedOn: '2026-08-09' },
  // Verified 2026-08-10: a Threads video, now proxied rather than redirected.
  { platform: 'th', name: 'th', path: '/@bisniscom/post/DbkwmbMEt6u', verifiedOn: '2026-08-10' },
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
  { platform: 'bs', name: 'bs:profile', path: '/profile/bsky.app', verifiedOn: '2026-08-11' },

  /**
   * ─── THE 2026-08-12 WIDENING, six platforms to fifteen ────────────────────────────────────────
   *
   * Six checks left ELEVEN of the seventeen platforms unwatched, which is the wrong shape for a
   * service whose stated differentiator is breadth. Seventeen undocumented endpoints break
   * independently on their own schedules, and every platform without a row here had exactly the
   * detector Facebook had in the incident at the top of this file: somebody pasting a link.
   *
   * HOW EACH WAS VERIFIED, because a row added on a platform "working in general" is the bad entry
   * this list cannot tell from an outage. Every path below was rendered through PRODUCTION —
   * `https://mbedfx.app{path}` with a Discordbot user agent, on 2026-08-12 — so the upstream fetch
   * behind it left Cloudflare egress rather than a laptop, and each answer was read for og:title AND
   * a drawable. The drawable each one carried is named on its line; where a row says "activity
   * link" and nothing else, that is a media post, which deliberately emits no og:image (see
   * cardVerdict).
   *
   * AND THE `platform` FIELD WAS VERIFIED TOO, not assumed from the url's shape. Each path was put
   * through `/_card?p=…` on production the same day and the platform it reported was compared with
   * the field below, because this value is what lands in Analytics Engine's blob1: a row labelled
   * with the wrong platform would write a permanently wrong answer into the dataset and nothing
   * downstream would reject it. All ten agreed.
   *
   * EIGHT OF THEM ARE ALSO public/index.html's OWN SAMPLE LINKS (x, rd, tw, ms, pt, im, pn, lm), and
   * that is a second reason to check them rather than a coincidence. The audit that prompted this
   * widening found the converter page advertising `dailymotion.com/video/xaqwy7q`, which answered
   * HTTP 410 when it was asked on 2026-08-12, and a test naming one that answers 404 — both dead,
   * with nothing in the project noticing for as long as either had been. A check on a published
   * sample makes that rot loud instead of silent.
   */
  // The first tweet. og:title "jack (@jack)", og:image, activity link — and about as deletable as
  // "Me at the zoo", which is to say it would be news.
  { platform: 'x', name: 'x', path: '/jack/status/20', verifiedOn: '2026-08-12' },
  // Rick Astley's r/pics post. og:title "u/ReallyRickAstley (@ReallyRickAstley)", caption, activity
  // link. Also the converter page's Reddit sample, and reads through embed.reddit.com — the surface
  // that replaced the OAuth and .json paths after both were gated shut.
  { platform: 'rd', name: 'rd', path: '/r/pics/comments/haucpf', verifiedOn: '2026-08-12' },
  // og:title "xQc (@xqc)" and og:video. The converter page's Twitch sample, and the largest channel
  // on the platform, so the clip outliving this project is the way to bet.
  { platform: 'tw', name: 'tw', path: '/xqc/clip/DeliciousDelightfulPicklesWOOP', verifiedOn: '2026-08-12' },
  // og:title "stux⚡️ (@stux@mstdn.social)", og:image, activity link. stux ADMINISTERS mstdn.social,
  // so this is the closest a Mastodon row gets to an institutional account on its own instance.
  { platform: 'ms', name: 'ms', path: '/mstdn.social/@stux/116994812581955524', verifiedOn: '2026-08-12' },
  /**
   * PeerTube. og:title "Guy Jantic (@guyjantic@tube.tchncs.de)" and og:video.
   *
   * NOTE WHAT THAT BYLINE SAYS, since it is the thing to check first when this row starts failing:
   * the url is on framatube.org but the video is FEDERATED from tube.tchncs.de, so this row exercises
   * the remote-lookup path and depends on two instances rather than one. That is more of the code
   * than a local video would cover and more surface to break. Framasoft's instance is the durable
   * half; the origin instance is not ours to rely on.
   */
  { platform: 'pt', name: 'pt', path: '/framatube.org/w/vZNcho9kCoVzc8wZwacPtc', verifiedOn: '2026-08-12' },
  /**
   * Misskey. og:title ":petthex_javasparrow:しゅいろ:petthex_javasparrow:(本物) (@syuilo@misskey.io)",
   * og:image (the avatar, this note carrying no files), activity link.
   *
   * CHOSEN OVER THE CONVERTER PAGE'S SAMPLE, deliberately. That one is a private individual's note,
   * which this list says at the top it will not fetch on a timer forever. This is Misskey's CREATOR
   * posting the project's own donation appeal, PINNED to his account since 2024-10-17 — the nearest
   * thing misskey.io has to an institutional post, and pinned means kept. `@misskey_io` was the
   * obvious first choice and its API answers USER_SUSPENDED (checked 2026-08-12), which is why this
   * is an account rather than the instance's own.
   */
  { platform: 'mk', name: 'mk', path: '/misskey.io/notes/9zgt8ac8kc2o034w', verifiedOn: '2026-08-12' },
  /**
   * ─── THE THREE THAT ARE HONESTLY WEAK, and are here anyway ────────────────────────────────────
   *
   * Each renders — verified 2026-08-12 through production, same method as the rows above — and each
   * is likelier than the rest of the list to disappear on its own, which is to say each bends the
   * durable-and-institutional preference stated at the top. They are in because a platform with no
   * check has no detector at all, and they are grouped here rather than hidden among the others so
   * that the trade is visible. When one starts failing, READ THIS BLOCK BEFORE ASSUMING AN OUTAGE:
   * "this post went away" is a likelier explanation for these three than for the rest.
   */
  // Imgur. og:title "Imgur (@imgur)", og:video, activity link. An ANONYMOUS album, which is the weak
  // part: nobody's account is keeping it. It stays because it is the only check that can catch an
  // Imgur client id that has expired or gone missing — the API is the sole path to albums, yt-dlp
  // refuses stills outright, and the page carries one og:image whatever the album holds. Without a
  // row here, a dead client id looks exactly like nothing at all.
  { platform: 'im', name: 'im', path: '/a/iX265HX', verifiedOn: '2026-08-12' },
  // Pinterest. og:title "Judy Hiatt (@1juh)" and an activity link. A PRIVATE PERSON'S PIN, and the
  // one row that departs from the public-and-institutional preference — no public or institutional
  // pin has been verified from this egress, and inventing one to fill the hole is the defect this
  // project names first. It is already the pin public/index.html invites every visitor to click, so
  // the timer adds a bounded load to a link the project publishes anyway, and this row is what would
  // tell us the published sample had rotted. Swap it the day a durable public pin is measured.
  { platform: 'pn', name: 'pn', path: '/pin/66287425756772418', verifiedOn: '2026-08-12' },
  // Lemmy. og:title "snooptodd (@snooptodd@lemmy.world)", og:image, activity link. A recurring daily
  // post from an ordinary account rather than an institution, so it is likelier to age out than the
  // rest — and it is the converter page's Lemmy sample, which is a second reason to watch it.
  { platform: 'lm', name: 'lm', path: '/lemmy.world/post/49966212', verifiedOn: '2026-08-12' },
  /**
   * ─── BLUESKY, THE SECOND ROW ──────────────────────────────────────────────────────────────────
   *
   * The row above it checks the PROFILE route. This checks a POST, and the two share no code below
   * render(), which is the whole reason both exist: a normalizer or a router arm can break one while
   * the other keeps answering. bsky.app's own account again, for the same durability reason.
   *
   * Verified 2026-08-12 through production — og:title "Bluesky (@bsky.app)", og:url the post itself,
   * og:description the post's text ("v1.130 is live!…"), activity link. Reading og:url mattered
   * here: a post path that quietly fell back to the profile would render a card that passes every
   * assertion in cardVerdict while checking the row above twice.
   */
  { platform: 'bs', name: 'bs:post', path: '/profile/bsky.app/post/3msqpuobiwk2t', verifiedOn: '2026-08-12' },
]

/**
 * THE PLATFORMS WITH NO CHECK, NAMED — which is the only way "unwatched" stops being something an
 * audit has to rediscover.
 *
 * Before 2026-08-12 the answer to "what is this cron not looking at?" was eleven of seventeen
 * platforms, and finding that out took someone rendering all seventeen through production by hand.
 * A list of the deliberate omissions, checked against the Platform union by
 * test/outage-smoke.test.mjs, turns that into a build failure: adding an eighteenth platform now
 * fails the suite until somebody either writes a check for it or writes down why not.
 *
 * `why` is for the person who reads it while deciding to delete the entry, so it says what would
 * have to become true first.
 */
export const SMOKE_UNCHECKED: readonly { platform: Platform, why: string }[] = [
  /**
   * STREAMABLE, and it is the ONLY platform excluded for a cadence reason. Dailymotion was excluded
   * alongside it on a rationale this repo's own constants contradict; that is corrected below and dm
   * is now checked.
   *
   * Rendered through production on 2026-08-12, st returned the 257-byte FAILURE CARD on the COLD
   * first request and healed on the second, while its upstream was independently confirmed healthy
   * at that moment (oembed answered 200 at 852x480, and the page carried og:video). So the miss is
   * ours, not theirs — see META_TIMEOUT_MS, whose 4700ms crawler budget a cold container extract
   * overruns.
   *
   * WHAT MAKES IT UNCHECKABLE IS THE TTL, NOT THE FAILURE. The card depends on the yt-dlp META
   * RECORD, which lives in R2 and is therefore GLOBAL rather than per-colo — POST_TTL and RESP_TTL
   * have nothing to do with it. `ST_META_TTL_MS` is 1_800_000, which is EXACTLY the cron interval,
   * so a scheduled check would find the record freshly expired essentially every tick and would sit
   * permanently on the cold path this service does not yet handle. An alarm that cries every half
   * hour teaches its only reader to ignore it, which leaves the service worse off than with no check
   * at all — the reader is the same person who has to believe the Facebook row when it fires.
   *
   * ADD IT when either the cold crawler path renders a real card or ST_META_TTL_MS stops coinciding
   * with the schedule, and say in the commit which one changed.
   */
  { platform: 'st', why: 'ST_META_TTL_MS (1800s) equals the cron interval, so a scheduled check is always cold, and the cold crawler path still returns the failure card (measured 2026-08-12)' },
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

export type SmokeVerdict = 'ok' | 'failure-card' | 'no-card' | 'threw' | 'timeout'

export type SmokeResult = {
  platform: Platform
  name: string
  verdict: SmokeVerdict
  /**
   * How long this check took, and it is reported because THE BUDGET BELOW HAS TO STAY MEASURED.
   *
   * The repeated defect in this project is a deadline picked from an intuition and left to rot
   * against an upstream that got slower (META_WAIT_API_MS sat at 4000 while the extract it waited
   * for took 2.3-6.7s, and first pastes rendered the epoch for months). This list will keep growing;
   * whoever grows it should be able to read the real per-check cost off `/_smoke` instead of
   * guessing, which is the whole reason this field exists rather than a comment claiming a number.
   *
   * IT IS A LOWER BOUND, not a stopwatch. Workers coarsen `Date.now()` — it advances on I/O rather
   * than continuously — so a check answered entirely from the response cache can read 0, and every
   * value here is "at least this long". That is fine for the question it is kept for (is any check
   * approaching the budget?) and wrong for anything finer.
   */
  ms: number
}

/**
 * THE PER-CHECK BUDGET, and the arithmetic that has to hold for the serial loop to be safe.
 *
 * MEASURED 2026-08-12 by rendering each path through production (https://mbedfx.app, Discordbot UA,
 * timed from outside, every render taken more than RESP_TTL after the last one so the response and
 * post caches were both cold and the upstream was really reached):
 *
 *   fb 4.0s   mk 2.7s   ig 1.7s   th 1.6s   tt 1.2s   pt 0.90s   ms 0.76s   x 0.48s
 *   bs:post 0.36s   pn 0.35s   tw 0.25s   rd 0.22s   lm 0.22s   im 0.14s   (yt and bs:profile
 *   measured 0.23s and 0.27s, but seconds after a cron tick, so treat those two as unmeasured)
 *
 * The whole six-check `/_smoke` run took 10.4s cold and 0.10-0.13s warm; the ten checks added that
 * day sum to 6.4s. A full sixteen-check tick is therefore on the order of fifteen to twenty seconds
 * cold, and a cron tick is always cold.
 *
 * 20s is five times the slowest measured cold render, which makes this a budget for "this upstream
 * has stopped answering" rather than for "this upstream is having a slow day". Cutting it finer
 * would start converting slowness into false alarms, and a monitor that cries wrongly is the one
 * failure mode that makes the service worse than having no monitor — the same reasoning that keeps
 * Dailymotion and Streamable out of the list entirely.
 *
 * WHY THERE IS A BUDGET AT ALL, given a cron sounds like it has all the time in the world. It does
 * not, and the two facts that decide it come from Cloudflare's limits page (read 2026-08-12):
 *
 *   - a scheduled invocation is killed at 15 MINUTES of wall clock, and
 *   - "There is no set time limit on individual subrequests".
 *
 * Nothing in this repo's platform fetchers passes an AbortSignal, so an upstream that accepts a
 * connection and then says nothing stalls its render for as long as the invocation lives. A serial
 * list with no per-check bound therefore has NO bound at all: ONE hung upstream can consume the
 * whole invocation, the runtime kills it part-way down the list, and every check after the hang goes
 * uncounted — which docs/METRICS.md says reads exactly like "the cron is not running". A monitor
 * that goes quiet during an outage is worse than no monitor, and the outage is precisely when an
 * upstream is likeliest to hang.
 *
 * With the budget, the worst case is SMOKE_CHECKS.length * SMOKE_BUDGET_MS = 16 * 20s = 320s, about
 * a third of the ceiling, and a hung platform is REPORTED as `timeout` rather than silently eating
 * the checks behind it. `smokeRunCeilingMs` and its test keep that arithmetic honest as the list
 * grows.
 */
export const SMOKE_BUDGET_MS = 20_000

/**
 * Cloudflare's wall-clock ceiling on ONE scheduled invocation, from the Workers limits page read
 * 2026-08-12: "Scheduled Workers have a maximum wall time of 15 minutes per invocation." It is not a
 * CPU number and must not be confused with one — CPU time for a Cron Trigger under an hour is 30s,
 * and waiting on a fetch does not count toward it, which is why a list of network-bound checks is
 * bounded by this and not by that.
 */
export const CRON_WALL_LIMIT_MS = 15 * 60_000

/** The worst case the serial loop can take: every check hanging until its budget expires. */
export const smokeRunCeilingMs = (checks: number = SMOKE_CHECKS.length, budgetMs: number = SMOKE_BUDGET_MS) =>
  checks * budgetMs

/**
 * Run every check and report. Takes the fetch handler rather than importing it, so worker.ts owns
 * the wiring and this file stays testable without a network or a container.
 *
 * ORIGIN IS OUR OWN AND THE PATHS ARE CONSTANTS. Nothing a caller supplies reaches a url here, which
 * is what makes the on-demand route safe: `/_smoke` cannot be pointed at anything, so it is not a
 * fetch proxy and not an oracle for arbitrary hosts. That property is why the list lives in code
 * instead of in a binding or a query parameter.
 *
 * STILL SERIAL AT SIXTEEN CHECKS, and this was re-decided on measurements rather than left alone.
 * A cold six-check run measured 10.4s end to end on 2026-08-12 and the ten checks added that day sum
 * to 6.4s cold, so a healthy tick is fifteen to twenty seconds against a fifteen-MINUTE ceiling —
 * about two per cent of it. Concurrency would buy nothing worth having and would cost two things:
 *
 *   - Cloudflare allows six connections per invocation to be WAITING FOR RESPONSE HEADERS at once
 *     (limits page, read 2026-08-12); a seventh is queued until one of the six gets its headers.
 *     A render is several subrequests, so a concurrent batch does not fan out the way it reads — it
 *     queues at a limit that is invisible in the code, and the checks pile up behind the slowest
 *     upstream instead of beside it.
 *   - Serial keeps this monitor's load on somebody else's API shaped like ONE reader, which is what
 *     it is pretending to be. Sixteen simultaneous requests from one Cloudflare IP every thirty
 *     minutes is a shape that gets IPs rate-limited, and this project has already lost two surfaces
 *     to datacenter-egress blocks.
 *
 * ROTATING A SUBSET PER TICK was the other option and is rejected for the same reason the list is
 * checked at all: it multiplies time-to-detect by the number of ticks in the rotation, and the
 * incident behind this file was one where the breakage went unnoticed for a WEEK. There is no
 * budget pressure to trade detection latency for. Nor is the upstream cost a reason to rotate: at 48
 * ticks a day this is 48 requests per checked post per day, which is smaller than one person sharing
 * one link into one busy channel.
 *
 * It also keeps the container out of it: none of these paths is a `{page}` remux the resolver would
 * be dispatched for, and a cold mux would be abandoned when the scheduled invocation ends anyway.
 */
export async function runSmoke(
  origin: string,
  render: (url: string) => Promise<Response>,
  budgetMs: number = SMOKE_BUDGET_MS,
): Promise<SmokeResult[]> {
  const out: SmokeResult[] = []
  for (const check of SMOKE_CHECKS) {
    const started = Date.now()
    // `| null`, not `| undefined`: the Workers lib types clearTimeout as `(id: number | null)`, and
    // an undefined initial value does not typecheck against it.
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      /**
       * The losing side of this race is NOT cancelled — a Worker cannot abort a fetch already in
       * flight, so an abandoned render keeps running until the invocation ends, and its
       * `ctx.waitUntil` cache writes still land. That is deliberate: the point of the timeout is to
       * stop one stuck upstream from consuming the checks behind it, not to save the bytes.
       *
       * `Promise.race` attaches a rejection handler to both members, so a render that rejects AFTER
       * losing the race is handled rather than escaping as an unhandled rejection. Reintroducing
       * that (a bare `.then`, an `await` with the race unwound) turns a slow upstream into a dead
       * invocation, and the tests below pin it.
       */
      const raced = await Promise.race<Response | 'timeout'>([
        render(`${origin}${check.path}`),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs) }),
      ])
      const verdict = raced === 'timeout' ? 'timeout' : cardVerdict(await raced.text())
      out.push({ platform: check.platform, name: check.name, verdict, ms: Date.now() - started })
    } catch {
      // A throw is a failure like any other: the point is whether a reader would have got a card.
      out.push({ platform: check.platform, name: check.name, verdict: 'threw', ms: Date.now() - started })
    } finally {
      // Not tidiness: an armed timer holds the run open in `node --test` and, in a Worker, keeps
      // work scheduled on an invocation that is trying to finish.
      clearTimeout(timer)
    }
  }
  return out
}

/** The counter name for a verdict. `smoke_ok` and `smoke_fail` are a PAIR; only the ratio means anything. */
export function smokeOutcome(verdict: SmokeVerdict): 'smoke_ok' | 'smoke_fail' {
  return verdict === 'ok' ? 'smoke_ok' : 'smoke_fail'
}

/** The client class every smoke count carries, so a monitor's traffic never dilutes a reader's. */
export const SMOKE_CLIENT: ClientClass = 'other-bot'
