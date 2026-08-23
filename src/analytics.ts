import type { ClientClass, MuxJob, Platform } from './types.ts'
import type { HostResolver } from './netguard.ts'

/**
 * `api_hit`/`api_miss` are the Mastodon-spoof routes and are deliberately NOT folded into
 * media_hit/media_miss: the spec's fetch-amplification alert watches that ratio, and a second
 * traffic class sharing the counters would blind it. Nor into `ok`, which counts post-HTML
 * renders — the spoof routes are a different consumer of the same cache entry, and telling
 * them apart is the only way to see one working while the other is not.
 *
 * `api_bad_id` is a spoof callback whose {id} did not decode, and it is deliberately NOT
 * `notfound`: domain-wide 404s are background noise, while this one says Discord's callbacks
 * are arriving mangled — the C2 hazard statusid.ts's SENTINEL exists to defend against.
 * Folded into `notfound` it is indistinguishable from that noise, which is how it went
 * unnoticed that these requests were being answered with an HTML page.
 */
/**
 * `age_restricted` and `private` are the TWO GATE counters — a post that EXISTS but is walled behind
 * an age gate (🔞) or a private/login requirement (🔒), a known limit rather than a fetch error. They
 * are deliberately distinct from `fetch_fail` (a deleted/errored post) and from each other, so the
 * three cases stay separable in analytics; each is counted by the fetcher (the worker cannot see WHY a
 * null came back) and STACKS on top of the worker's own `fetch_fail`, no double-count.
 */
/**
 * `copyright_recovered` is the MIDDLE of three repair counters, not the only one — see the Outcome2
 * comment below for the trio. It reports a repair rather than an outcome:
 * an Instagram post whose embed came back rights-struck (no video_url) and whose video we then got
 * back off the v1 user feed. It is worth its own name because the mechanism is UNCONFIRMED FROM
 * CLOUDFLARE EGRESS — every measurement behind it is residential — and the recovery is written to
 * fail silently into today's cover-still. So this counter going to ZERO is the only way anyone learns
 * that Instagram closed the surface or that our datacenter IPs never had it: the cards keep rendering
 * either way, which is exactly what makes the failure invisible without a counter.
 *
 * Read it against `ig`/`ok`, not on its own — it is a fraction of blocked posts, and blocked posts are
 * a small fraction of traffic (the gate is the audio rightsholder; see instagramCopyrightBlocked).
 *
 * `fullpage_recovered` is its sibling and carries the same warning for a different surface: an
 * Instagram post whose EMBED failed from our egress but whose full /p/{code}/ page still carried the
 * whole post in its og: set. It replaced a case that used to render a FALSE 🔒 "private" — so every
 * count here is a post that would previously have been mislabelled as a wall, and this counter and
 * `private` should move in OPPOSITE directions. A `private` count that stays high while this stays at
 * zero means the full-page read is failing from egress and the old false-positive is back.
 */
/**
 * `translated` and `translate_fallback` are a PAIR, and only the ratio means anything. Translation is
 * served by Google's endpoint first and by Workers AI (gemma-4-26b-a4b-it) when that fails, and the failure this
 * exists to expose is a datacenter-wide block: every measurement behind the Google path was taken
 * from a residential IP, and this project has twice found an upstream that answers a laptop and
 * refuses Cloudflare's egress (Facebook's share 302, Reddit's anonymous reads).
 *
 * If `translated` sits at zero while `translate_fallback` climbs, Google is refusing us and the
 * weaker model is quietly carrying the feature — cards keep rendering either way, which is exactly
 * what makes that failure invisible without a counter.
 */
export type Outcome2 =
  | 'ok' | 'media_hit' | 'media_miss' | 'api_hit' | 'api_miss' | 'api_bad_id' | 'assert_fail'
  | 'fetch_fail' | 'age_restricted' | 'private' | 'ambiguous' | 'notfound'
  // A credential pool IS SET and the gate was hit anyway. Two very different things land here and the
  // platform tells them apart: on `x` it is EXPECTED — the secret can be filled today and the
  // Worker-side call that would spend it is a later phase, so this counts the staging gap rather than
  // a fault. On `ig`/`yt` it is a REAL SIGNAL: those do spend the pool, so a rising count means the
  // accounts are logged out, rate-limited, or shadow-flagged, and the jar needs rotating.
  //
  // It exists because the predicate it replaces (`credentialSeamArmed`) was written for exactly this
  // purpose and then never called from anywhere, so it made nothing visible at all. A counter in the
  // arm that would have used the credential is the version that cannot rot the same way.
  | 'pool_unused'
  // The three copyright recoveries, in the order they are tried. copyright_gql = the shortcode
  // GraphQL query answered (cheapest, and the only one with no window). copyright_recovered = it did
  // not, but the account feed had the post, so it was recent. copyright_remux = neither, and the page
  // went to the yt-dlp container.
  //
  // Counted separately because the RATIO is the operational signal, and each ratio names a different
  // failure. copyright_gql collapsing to zero is how a rotated doc_id announces itself. Everything
  // landing on copyright_remux means both private endpoints are refusing our egress. All three at
  // zero while ig/ok keeps climbing means Instagram closed the recovery entirely and every blocked
  // reel is quietly a photo again — which no card will ever tell anyone, since they all still render.
  | 'copyright_gql' | 'copyright_recovered' | 'copyright_remux' | 'fullpage_recovered'
  // `plugin_recovered` is a Facebook post read off Meta's EMBED-PLUGIN fragment because every
  // ordinary post surface answered our egress with a login wall (measured 2026-08-08 from
  // Cloudflare; see facebookPluginCard). Read it against `fb`/`ok`: while the wall stands this
  // carries most Facebook posts, so it going to ZERO is not good news — it means Meta closed the
  // plugin too and every Facebook link is a failure card again.
  | 'plugin_recovered'
  // `caption_recovered` is the THIRD Facebook post surface and the narrowest: a page whose og: set
  // carries a byline and a caption but NO og:image, which both of the other two refuse — the picture
  // requirement rejects it here and Meta's plugin answers "no longer available" for it.
  //
  // EXPECT IT ON 1 OF 35, not 2. Measured 2026-08-12 from Cloudflare egress, the caption read ANSWERS
  // two of the 35 sampled post urls, but it only RUNS on one of them: the plugin answers
  // /NASA/posts/10150113094966772 first, so that url returns at `plugin_recovered` and never reaches
  // here. The two numbers are different questions and only the second one is what this counter
  // measures. It should stay SMALL either way. If it
  // ever overtakes `plugin_recovered`, Meta has narrowed the plugin and most Facebook cards have
  // quietly become captions with no picture — which no card will announce, since they all render.
  | 'caption_recovered'
  | 'translated' | 'translate_fallback'
  /**
   * `translate_pending` is the THIRD member of that pair, and it exists because the state it names
   * was invisible. A translation that loses its deadline race returns `pending`, which deliberately
   * suppresses the response cache so the untranslated card is not pinned for RESP_TTL — so every
   * unfurl of that post re-runs the whole render until the R2 entry lands. `translated` and
   * `translate_fallback` are counted only when a translation ARRIVES, so the losing case left no
   * trace at all: nothing in the counters, and nothing in the logs, which are off for privacy.
   *
   * ADDED AFTER A REPORT NOBODY COULD DIAGNOSE, 2026-08-08. A TikTok post rendered no Discord card at
   * all; by the time it was looked at, the translation had landed and every url worked. The only
   * measurable difference between the failing and working posts was this state, and there was no way
   * to tell whether it had been rare or constant. That is the whole reason this counter exists —
   * not to prove that theory, but so the next report has something to read.
   *
   * READ IT AS A RATIO against `translated` + `translate_fallback`, never alone. A few percent is the
   * design working: a cold post defers its translation to the next reader and self-heals. A large or
   * rising share means posts are NOT self-healing — the R2 write is failing, or the budget is too
   * small for the model's current latency — and every one of those unfurls is an uncached full render.
   */
  | 'translate_pending'
  /**
   * `meta_timeout` — THE CONTAINER METADATA CALL RAN OUT OF **OUR** BUDGET, and it is `assert_fail`'s
   * counterpart in the same way `translate_pending` is `translated`'s: the state was real, common and
   * completely untraceable.
   *
   * IT WAS COUNTED AS assert_fail, WHICH SAYS THE OPPOSITE OF THE TRUTH. This file defines assert_fail
   * as "upstream changed shape, blocked mbedfx, or served a decoy" and docs/METRICS.md tells the
   * operator that a moving assert_fail/ok ratio means that platform's upstream changed shape. A lost
   * meta deadline is none of those: the container is still extracting, it lands in R2 under waitUntil a
   * moment later, and the very next unfurl of the same post is a warm hit. Filing it under assert_fail
   * pointed the one available signal at the wrong system.
   *
   * ADDED AFTER AN AUDIT FOUND WHAT NO COUNTER COULD, 2026-08-12. Dailymotion and Streamable each
   * answered a Discord crawler with the bare failure card on a cold first request and healed on a
   * retry, and the only reason anyone knew was that all seventeen platforms happened to be rendered by
   * hand that day. Both upstreams were independently healthy at that moment. See META_TIMEOUT_API_MS in
   * worker.ts for the measurement.
   *
   * WHERE IT FIRES: the yt-dlp tier (dm/st/im) only — the platforms where the container IS the card, so
   * a lost deadline is immediately the generic "couldn't load". Facebook takes the same budget but
   * falls through to three more surfaces on a miss, so its null is not this event and is left alone.
   *
   * READ IT AGAINST assert_fail ON THE SAME PLATFORM. It REPLACES assert_fail rather than stacking on
   * it (the precedent is `notfound` on ms/mk/pt, counted separately so a deleted post does not inflate
   * assert_fail); the route-level `fetch_fail` still fires either way, so only the attribution moves.
   * A rise here is OURS to fix — a slower upstream extract, a cold container, or a budget that no
   * longer covers a healthy call. A rise in assert_fail beside a flat one here is still theirs.
   */
  | 'meta_timeout'
  /**
   * `smoke_ok` / `smoke_fail` are the OUTAGE DETECTOR, and they are a pair like the translate ones:
   * a raw count means nothing, a RATIO per platform means everything.
   *
   * ADDED AFTER AN OUTAGE NOBODY NOTICED. Facebook embeds were broken for up to a week — Meta walled
   * the post surfaces from datacenter egress between 2026-08-01 and 2026-08-08 — and the way it was
   * discovered was the owner pasting a link. The service had no opinion about its own health.
   *
   * A scheduled check now renders known posts through this worker's own handler and asks whether a
   * real card came back, asserting on CONTENT because every interesting failure here answers HTTP
   * 200. See src/smoke.ts.
   *
   * READ IT PER PLATFORM. One platform failing while the others pass is either that platform's
   * upstream or a rotted check url, and both want a human. All of them failing at once is this
   * service. `smoke_fail` sitting at zero forever is also a signal: it means the checks are not
   * running, which is indistinguishable from health if nobody asks.
   *
   * ONE PAIR IS NOT ONE CHECK, since 2026-08-12. `bs` carries TWO rows — the profile route and a post
   * — and this blob is the PLATFORM, so they sum here: a Bluesky pair reading 1 and 1 means one of
   * the two broke, and nothing in the dataset says which. That is a deliberate trade against widening
   * blob1 beyond the platform enum; `/_smoke` and the cron's log line carry the check's name for the
   * reader who needs it. Two platforms (`dm`, `st`) emit neither counter on purpose — see
   * SMOKE_UNCHECKED — so their silence here is not an outage.
   */
  | 'smoke_ok' | 'smoke_fail'
  /**
   * THE MUX OUTCOMES — added 2026-08-23, and the reason is that the video half of this service had NO
   * telemetry at all. Every failure reached the reader as the same bodiless `503 no-store` and the
   * same unstored `console.error('mux failed', key, status)`, so our own blown clock, YouTube's gate,
   * an oversized result and a cold container were one indistinguishable event. That is what made a
   * reported "a 10-minute video took ten minutes to warm" cost a night of arithmetic to explain
   * instead of one query, and it is why nothing here could be evaluated except by vibes.
   *
   * READ THEM AS A GROUP, per platform. The RATIO is the signal, exactly as with translate_* and
   * smoke_*: `mux_ok` alone says nothing, and the interesting question is always which of the
   * failures is carrying the weight.
   *
   *   mux_ok       the container produced bytes and R2 stored them. double2 is the elapsed ms.
   *   mux_gate     502 + "mux failed" — yt-dlp exited non-zero. THEIRS: a 403, a PO-token demand, a
   *                sign-in wall, an nsig solve failure. A rise here on `yt` alone is YouTube moving.
   *   mux_timeout  504 — the container's own 180s wall (PROC_TIMEOUT + 60). OURS.
   *   mux_empty    502 + "empty or oversized result" — it ran and produced nothing usable.
   *   mux_pool     503 — a cold boot, or "Maximum number of running container instances exceeded".
   *                A rise here degrades EVERY platform's card, not just the one in blob1.
   *   mux_badsource 400 — the container's SSRF guard refused the url we sent it.
   *   mux_error    500, or a status this mapping does not know. Should stay at zero.
   *   mux_refused  the mux SUCCEEDED and we declined to store it (MUX_BUFFER_MAX). Not an
   *                extraction verdict, and it must never be read as one.
   *
   * `blob3` IS `'none'` ON EVERY MUX ROW, deliberately — see countMux for why a mux has no client.
   */
  | 'mux_ok' | 'mux_gate' | 'mux_timeout' | 'mux_empty'
  | 'mux_pool' | 'mux_badsource' | 'mux_error' | 'mux_refused'

/**
 * The two analytics outcomes that are content GATES (walls a post sits behind) rather than fetch
 * errors: an age gate or a private/login wall. Named ONCE, as the subset of Outcome2 that is a gate,
 * so the fetcher out-parameter (FetchReport.reason), the short-link resolution ({kind:'gated'}) and
 * the render mapping (renderGate) all speak the same vocabulary instead of re-spelling this union at
 * each site. Derived via Extract so it can never drift from the analytics counter names.
 */
export type GateReason = Extract<Outcome2, 'age_restricted' | 'private'>

export interface Env {
  AE?: { writeDataPoint(x: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }
  ASSETS: { fetch(req: Request): Promise<Response> }
  // The phase-2 video-playback bindings — the media-resolver container and its R2 mux cache. BOTH
  // OPTIONAL: when unset (a Worker deployed without the container), the DASH/HLS platforms degrade a
  // remux video to its cover still, exactly as before playback existed. See container/README.md.
  MEDIA_RESOLVER?: DurableObjectNamespace
  MEDIA_CACHE?: R2Bucket
  /**
   * THE MUX RUNNER — a Durable Object whose ALARM performs a mux, because an alarm handler gets 15
   * minutes where `ctx.waitUntil` gets 30 seconds (both Cloudflare's documented limits). See MuxJob
   * for the defect that makes the difference matter.
   *
   * TYPED STRUCTURALLY, NOT AS THE CLASS, and that is the same constraint src/container.ts exists
   * for: the class extends `DurableObject` from `cloudflare:workers`, a module that does not exist
   * under `node --test`, and worker.ts is the test-imported half. Naming only the method keeps the
   * import out of every file but src/muxrunner.ts and the deploy entry.
   *
   * OPTIONAL exactly as MEDIA_RESOLVER is: a Worker deployed without it behaves precisely as this
   * service did before the alarm existed — the inline attempt still runs, it is just still capped at
   * 30 seconds. That is what makes this safe to ship ahead of the binding, and it is what a
   * self-hosted deploy gets for free.
   */
  MUX_RUNNER?: { getByName(name: string): { schedule(job: MuxJob): Promise<void> } }
  /**
   * Workers AI, for translating a foreign-script post. OPTIONAL exactly as MEDIA_RESOLVER is:
   * absent means every card renders as it did before translation existed, so the binding can be
   * added to the account after the code ships rather than before it.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }
  // Optional shared secret sent to the media-resolver container in X-Resolver-Secret; when the
  // container has RESOLVER_SECRET set it rejects any call that does not present the match. Defence in
  // depth — the container is only reached over the internal DO binding, never a public route.
  RESOLVER_SECRET?: string
  /**
   * ===========================================================================================
   * THE THREE SELF-HOSTING SETTINGS. Every one of them is unset on Cloudflare and MUST stay
   * optional: this Worker's own deployment is the case where each default is already correct, and a
   * required setting would be one more thing between a merge and a deploy. docs/SELF-HOSTING.md is
   * where an operator is told which of them are mandatory for them (the first one is).
   * ===========================================================================================
   *
   * THE DOMAINS THIS INSTANCE IS SERVED FROM, added to the built-in list in
   * src/platforms/fedihost.ts, which is what stops a fediverse ref from naming US as its instance.
   * Whitespace/comma separated, hostname or origin. ADDITIVE — see FediEnv there for why setting it
   * can only ever make the guard stricter, and why leaving it unset is a misconfiguration rather
   * than an open door.
   */
  OWN_HOSTS?: string
  /**
   * A DNS RESOLVER, so the fediverse fetchers can refuse a public hostname that resolves into your
   * network. Not a wrangler binding and never will be: a Worker has no resolver, so on Cloudflare
   * this is permanently undefined and the address guard runs on the hostname text alone. A
   * self-hosted adapter assigns a function here when it builds this object literal. See
   * src/netguard.ts.
   */
  RESOLVE_HOST?: HostResolver
  /**
   * The ceiling, in bytes, on buffering ONE muxed mp4 in memory before writing it to MEDIA_CACHE —
   * the fallback taken when `FixedLengthStream` is absent, i.e. everywhere except Workers. See
   * putMuxed in src/worker.ts for the numbers and for what a video above the ceiling degrades to.
   */
  MUX_BUFFER_MAX?: string
  /**
   * Imgur's API client id. OPTIONAL, and the fallback is the interesting part.
   *
   * Every Imgur endpoint requires a client id — there is no anonymous path, and scraping is not an
   * alternative: the page carries exactly ONE og:image (the album cover) under both a browser and a
   * Discordbot UA, which is the very limitation albums exist to fix. Measured 2026-07-31.
   *
   * Absent, we fall back to the client id yt-dlp publishes in its own source. That works today and is
   * why this shipped without blocking on an account — but it is a SHARED bucket: Imgur reports
   * x-ratelimit-clientlimit 12500/day against it, and every other tool using yt-dlp's key is drawing
   * from the same one. Register a free client id and `wrangler secret put IMGUR_CLIENT_ID` to stop
   * competing with strangers for quota.
   */
  IMGUR_CLIENT_ID?: string
  /**
   * Set to 'off' to stop using Google's translate endpoint and fall back to Workers AI alone.
   *
   * A KILL SWITCH RATHER THAN A FEATURE FLAG, and it is here because of what the endpoint IS:
   * `client=dict-chrome-ex` is an undocumented internal Google surface, not the paid API, and using
   * it is automated access outside their terms. That was the owner's informed call; this is the
   * lever that reverses it in seconds without a deploy, whether the reason is a 403 wave or a letter.
   */
  TRANSLATE_GOOGLE?: string
  /**
   * The `doc_id` of Instagram's shortcode-scoped GraphQL query (PolarisPostRootQuery). Overridable
   * because Meta ROTATES IT — InstaFix's history shows one rotating inside about a month, which is
   * why they made theirs configurable too. When it dies this path stops answering and the older
   * recoveries carry the card, so the symptom is a quiet loss of quality rather than an outage; a var
   * means re-pinning it is a config change, not a patch release.
   */
  IG_GRAPHQL_DOC_ID?: string
  /**
   * THE CREDENTIAL SEAM'S BINDINGS — and TWO OF THE THREE ARE LIVE. Corrected 2026-08-03: this comment
   * said "READ BY NOTHING YET" and "SETTING THESE CHANGES NOTHING TODAY" for all three, and pointed at a
   * `credentialSeamArmed` that no longer exists, while the paragraph below it correctly narrowed the
   * claim to X_ACCOUNTS. Both halves could not be true. It matters more than an ordinary stale comment
   * because this is the text an operator reads to decide whether filling a secret is worth the ToS
   * exposure of a throwaway account — it was telling them no.
   *
   * Age-gated posts are unreachable credential-free — measured on both paths and both egresses.
   *   IG_ACCOUNTS and YT_ACCOUNTS ARE SPENT TODAY, inside the container: the jar rides both the mux and
   *   the `-J` meta call, and a filled YT pool turns an `age_limit: 18` video with `formats: 0` into an
   *   ordinary card. See withCookieJar and jarPlatform in worker.ts for the two-name allowlist that
   *   decides which container calls may carry one, and container/server.py's _CookieJar for what
   *   happens to it there.
   *   X_ACCOUNTS IS NOT. Twitter's gate is beaten in the WORKER, and the injection point is a real,
   *   tested function (fetchWithCredentials in platforms/twitter/fetch.ts) that returns null. Those
   *   posts become an honest age_restricted card instead of a broken one, which is the correct answer
   *   without accounts rather than a bug in the fetcher.
   *
   * ONE THING A FILLED POOL DOES NOT DO, and it is the question this comment gets asked: Instagram's
   * `failure_reason:MA` gate is read off the WORKER'S OWN page fetch, which carries no jar. So a filled
   * IG pool changes what the container can download and NOT whether a gated Instagram post is detected
   * as gated. `ig`/`pool_unused` climbing is that, not dead accounts.
   *
   * ONE SECRET PER PLATFORM, each a JSON array of accounts, one picked at random per request so no
   * single account carries the whole load. Read only through src/credentials.ts, which is total: a
   * malformed secret is an EMPTY pool, never a throw, because these are consulted on the path for
   * ordinary posts too and a stray comma must not 500 a platform that has nothing to do with gates.
   *
   * WHY PLAINTEXT. This briefly declared CREDENTIAL_KEY + an AES-256-GCM CREDENTIAL_BUNDLE, copied
   * from FxEmbed. That design answers a threat we do not have: FxEmbed self-hosts, where the bundle
   * sits on a disk somebody else may read. A Worker secret is encrypted at rest, unreadable from the
   * dashboard, and absent from the repo, so a second layer buys nothing while costing a key stored in
   * the same place as what it protects — and a bespoke encrypt step on every rotation, which is the
   * step most likely to be skipped.
   *
   * WHERE EACH GATE IS BEATEN DIFFERS, and it decides what belongs in each secret:
   *   X_ACCOUNTS  — Twitter's is beaten in the WORKER (a GraphQL call), so these carry auth_token+ct0.
   *   IG_ACCOUNTS — Instagram's is beaten inside yt-dlp, so these carry a `cookies` jar.
   *   YT_ACCOUNTS — YouTube likewise: age_limit 18 answers `formats: 0` until a jar is present.
   *
   * SETTING X_ACCOUNTS STILL CHANGES NOTHING TODAY — the Worker-side call that would spend it is a
   * later phase. That is deliberate staging, and it is COUNTED (`pool_unused`) rather than left to
   * memory, because a variable that looks live and is inert is worse than one that does not exist.
   */
  X_ACCOUNTS?: string
  IG_ACCOUNTS?: string
  YT_ACCOUNTS?: string
  // The Reddit OAuth app's credentials (a "script"/"web" app registered as shamu4life). Reddit
  // blocks anonymous access from datacenter IPs, so `rd` alone of the six needs a stored secret;
  // fetchReddit exchanges these for an app-only bearer token. Set with `wrangler secret put`. These
  // are DELIBERATE long-lived config, NOT the deletion-dated debug secret warned about below — and
  // like every secret here they become PRODUCTION secrets on the Phase 3 apex cutover, which for
  // Reddit is intended (prod needs them too). Optional so a deploy without them degrades `rd` to the
  // generic failure rather than throwing.
  REDDIT_CLIENT_ID?: string
  REDDIT_CLIENT_SECRET?: string
  // NOTHING ELSE BELONGS HERE WITHOUT A DELETION DATE. This interface briefly carried an optional
  // secret gating a debug endpoint that fetched a caller-supplied shortcode from our egress; it is
  // gone, with the probe module itself, its mount in worker.ts, and the wrangler secret. (The
  // module's path is deliberately not spelled: a citation of a deleted file reads as a live
  // pointer, and a test now fails the suite for any source comment that names one.) Three tests
  // in test/pipeline.test.mjs enforce that by reading the TREE — which is why the secret's
  // name is deliberately not spelled here; the mount is what survives a partial deletion.
  // `wrangler.jsonc` declares ZERO `env` stanzas: one worker, one secret store, so a leftover
  // secret becomes a PRODUCTION secret the day the Phase 3 cutover moves the apex onto it.
}

/**
 * Counters only. No URLs, no post IDs, no IPs, no verbatim user agents.
 *
 * The historically demonstrated way a fixer dies is not lawyers — it is logging.
 * TwitFix shut down in 2022 over a public log of processed URLs and the harassment
 * that followed, with zero legal contact. We have nothing to leak.
 *
 * AND THAT CLAIM WAS NOT TRUE UNTIL 2026-08-04, which is worth recording rather than
 * quietly fixing. This function was scrupulous and the platform underneath it was not:
 * `observability` was enabled in wrangler.jsonc, so Cloudflare persisted an invocation
 * log per request for seven days carrying the whole request url — on this Worker, the
 * post somebody pasted — with the client IP, the user agent and the geolocation beside
 * it. Everything above was true of OUR analytics and false of the deployment.
 *
 * Workers Logs is off now. If it is ever turned back on, this comment stops being true
 * again, so treat the two as one decision: the honest version of "we have nothing to
 * leak" is "nothing here writes one, AND nothing under us is storing one either".
 */
export function count(env: Env, platform: Platform | 'none', outcome: Outcome2, client: ClientClass): void {
  env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })
}

/** The mux outcomes — the subset of Outcome2 that describes a video mux. Derived, so it cannot drift. */
export type MuxOutcome = Extract<Outcome2, `mux_${string}`>

/**
 * A MUX OUTCOME, WITH ITS DURATION — the one row shape in this dataset that carries a second double.
 *
 * `double2` IS ELAPSED MILLISECONDS, and it is the field the reported incident had no answer for:
 * nothing anywhere recorded how long a mux took, even when it SUCCEEDED, so "it took ten minutes"
 * could only ever be reconstructed from arithmetic. docs/METRICS.md used to state flatly that
 * `double1` is always 1 and that there are no durations in this dataset; both halves of that
 * sentence are now qualified there rather than silently falsified here.
 *
 * `blob3` IS ALWAYS `'none'`, and that is a decision rather than a gap. A cold video is asked for by
 * the prewarm, the HTML render and the activity render within ~2s of one paste, and muxOnce collapses
 * all of them onto ONE piece of work — so there is no single client that the mux belongs to, and
 * naming any one of them would be arbitrary. `'none'` is the sentinel blob1 already uses for a row
 * with no platform, so the dataset gains no new vocabulary.
 *
 * NO URL EVER REACHES THIS. The outcome is a fixed enum member chosen from the container's STATUS and
 * a closed allowlist of its own error strings — never its stderr, which is suppressed at the source
 * precisely because it can carry the source url.
 */
export function countMux(env: Env, platform: Platform | 'none', outcome: MuxOutcome, ms: number): void {
  env.AE?.writeDataPoint({ blobs: [platform, outcome, 'none'], doubles: [1, Math.max(0, Math.round(ms))] })
}
