import type { ClientClass, Platform } from './types.ts'

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
 * `copyright_recovered` is the ONE SUCCESS counter here that reports a repair rather than an outcome:
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
  | 'translated' | 'translate_fallback'

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
 */
export function count(env: Env, platform: Platform | 'none', outcome: Outcome2, client: ClientClass): void {
  env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })
}
