import type { PostRef } from '../../types.ts'
import type { Env } from '../../analytics.ts'
import { syndicationHasTweet } from './normalize.ts'

/** Read-through for cache-shaped, UNVALIDATED guest bodies — whatever JSON.parse produced. */
type Any = Record<string, any>

/**
 * I/O ONLY — the Twitter fetchers. This file's job is to GET a tweet and decide one question,
 * "what KIND of answer did I get", and nothing else: parsing the payload into a Post lives in
 * normalize.ts, which is pure and tested against real captured bytes with no network.
 *
 * PATH A — SYNDICATION — is the PRIMARY source and the whole of this file today. One GET to
 * cdn.syndication.twimg.com/tweet-result with a token DERIVED client-side (not issued), no bearer,
 * no cookie, no guest-token dance — the cheapest of the six platforms. The guest-GraphQL fallback
 * (Path B) and the fetchTwitter orchestrator + credential seam land in Tasks 4–5; this file is
 * deliberately just the syndication half so each path is reviewed on its own.
 *
 * NAMING SPLIT (restated here and in normalize.ts's header, and mastodon.ts's APPLICATION docstring,
 * so nobody "consistency-fixes" it): this file lives at src/platforms/twitter/ and its functions say
 * "Twitter" — the full-name directory/function convention every platform follows (fetchBluesky,
 * fetchTikTok). But every `ref.p` value is `'x'` and every URL is on x.com / cdn.syndication.twimg —
 * those are the Platform ENUM identifier and the real hosts, not names, and renaming them would churn
 * cache keys and refKeys for nothing.
 *
 * ASSERT ON CONTENT, NEVER ON STATUS — and never on content-type or size either. This one endpoint
 * lies THREE distinct ways, all measured live (recon 2026-07-19), and status/content-type
 * discriminate none of them:
 *   - HTTP 200 + body `{}`               when the derived token is missing/wrong,
 *   - HTTP 200 + a `TweetTombstone`      when the post is age-gated (the credential wall),
 *   - HTTP 404 + an HTML "poodle" page   when the id names no post (a 404 from a JSON endpoint).
 * The classification is syndicationOutcome() below, and its one content assertion is
 * syndicationHasTweet() imported from normalize.ts — ONE spelling, not a second driftable copy (the
 * rule TikTok's hasVideoDetailScope and Instagram's pageOutcome both follow).
 */

/**
 * The syndication token, DERIVED client-side — Twitter issues nothing. It is a base-36 digest of the
 * numeric id scaled by π, with runs of `0` and the `.` stripped.
 *
 * THE FLOAT IMPRECISION IS INTENDED — do NOT "fix" it to BigInt. `Number(id)` loses precision on a
 * 19-digit snowflake id, but Twitter's own web client computes the token with the identical IEEE-754
 * JS math, so our token matches theirs EXACTLY. A "more correct" BigInt token would be the WRONG
 * token and the endpoint would answer with the `{}` missing-token trap. Verified against a live
 * request in the recon: id `20` -> token `6dq1a2xwd93` returns jack's "just setting up my twttr".
 */
export function deriveSyndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

/**
 * The three-way result Path A returns. One `Post | null` cannot express it, because the three
 * trap-states each demand a DIFFERENT downstream response (Task 5's orchestrator keys on the split):
 *
 *   ok: true                    -> normalize it (a real Tweet).
 *   reason: 'age_restricted'    -> the credential wall; guest walls too, so go straight to the seam.
 *   reason: 'assert_fail'       -> maybe the token algo/endpoint broke; fall back to guest (Path B).
 *
 * Collapsing age_restricted into assert_fail would pointlessly hammer the guest path on every gated
 * post (it walls identically — recon); collapsing the other way would silently miss the
 * token-algo-broke case. Both `reason`s are already first-class in analytics.ts's Outcome2.
 */
export type SyndicationResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'age_restricted' | 'assert_fail' }

/**
 * PURE, so the classification is testable with no network and no stubbed globals — the same
 * discipline TikTok's pageOutcome and Instagram's pageOutcome keep.
 *
 * ORDER MATTERS: the tombstone is checked FIRST, on `__typename === 'TweetTombstone'` — NEVER on a
 * `reason` field. The recon corrects the spec here: the current age-gate shape is a bare
 * `TweetTombstone` that carries NO `reason` field, so FxEmbed's `result.reason === 'NsfwLoggedOut'`
 * branch would not fire on it and keying on `reason` would silently miss every gated post measured.
 * A tombstone also fails syndicationHasTweet (no text/user), so without this explicit branch it would
 * mislabel as assert_fail and the orchestrator would waste a guest fetch on a wall.
 *
 * The `__typename` read is optional-chained so a non-object input (a 404 HTML string, null, a number,
 * an array) classifies to assert_fail rather than throwing — this function is handed whatever
 * JSON.parse produced, and it must be TOTAL over junk.
 */
export function syndicationOutcome(json: unknown): SyndicationResult {
  if ((json as { __typename?: unknown } | null | undefined)?.__typename === 'TweetTombstone') {
    return { ok: false, reason: 'age_restricted' }
  }
  if (syndicationHasTweet(json)) return { ok: true, data: json }
  return { ok: false, reason: 'assert_fail' }
}

/**
 * I/O: fetch Path A for one tweet and classify the body. GET only, no credentials.
 *
 * No UA gate on this endpoint — it is Fastly-fronted and answered byte-identically from residential
 * AND Cloudflare Workers egress in the recon, so we send a plain `accept: application/json` and NO
 * browser UA: there is nothing to impersonate, and a value nobody controls is not a property we can
 * test.
 *
 * THE PARSE IS GUARDED, THE FETCH IS NOT. A nonexistent id answers 404 with an HTML page, so
 * JSON.parse throws — that throw is CAUGHT and becomes assert_fail (the id names nothing; try guest).
 * A thrown `fetch` (or a body-read failure) is deliberately NOT caught: it is a genuine network
 * failure the worker treats as null / fetch_fail, a different signal from "the endpoint answered with
 * something un-parseable". id is percent-encoded into the query, but the token is base-36 (derived,
 * never user text) so it needs none.
 *
 * The single ask is now askJson's — see it for why one refusal must not cost a permanent card.
 */
export async function fetchSyndication(
  ref: Extract<PostRef, { p: 'x' }>,
): Promise<SyndicationResult> {
  const url =
    'https://cdn.syndication.twimg.com/tweet-result' +
    `?id=${encodeURIComponent(ref.id)}&lang=en&token=${deriveSyndicationToken(ref.id)}`
  const got = await askJson(url, { headers: { accept: 'application/json' } })
  // A 404 HTML poodle page (or any non-JSON body) — the endpoint answered, but not with a tweet.
  if (!got.ok) return { ok: false, reason: 'assert_fail' }
  return syndicationOutcome(got.json)
}

/**
 * ===================================================================================================
 * ONE EXTRA ASK — the whole of the retry, shared by both Twitter paths.
 * ===================================================================================================
 *
 * REPORTED 2026-08-28: a public video tweet drew the "couldn't load" card on this service while a
 * self-hosted rival drew the same id correctly, minutes apart, from the same Discord message.
 *
 * MEASURED the same day, residentially, on that exact id: syndication answered a full `Tweet` with
 * video 8 times out of 8 (0.18-0.34s), and the guest TweetResultByRestId answered `__typename: Tweet`
 * carrying `media: ['video']`. Nothing about the post is gated — not sensitive, not protected, not
 * deleted, and the account is live. Both of our paths are healthy for it. So the card was lost to
 * Cloudflare's egress being refused ONCE: the same shape already measured on YouTube's Innertube
 * endpoint, where ~40-50% of Worker-egress calls are refused while every one of them answers
 * perfectly from a residential IP in the same minute.
 *
 * WHY ONE BLIP WAS ONE PERMANENT CARD. Discord stores the embed it built INSIDE the message and does
 * not re-unfurl a link it has already drawn (discord-api-docs#1663). A transient refusal therefore is
 * not a transient card: the first paste is the only paste, and a card lost to a 300ms hiccup stays
 * lost for everyone who ever scrolls past that message. The YouTube fix could lean on PERSISTENCE for
 * a second chance because a later paste re-reads R2; a Discord embed has no later. The extra attempt
 * has to happen inside the one request we are given, which is what this is.
 *
 * WHAT IS AND IS NOT ASKED AGAIN, because retrying the wrong thing is worse than not retrying.
 * A PARSED BODY IS A VERDICT AND IS BELIEVED — a `TweetTombstone`, a real `Tweet` and a recognizable
 * error object all return on the first ask. Only an answer carrying NO verdict is asked again: a
 * thrown fetch, an unreadable body, or a non-JSON body on a status that says the endpoint REFUSED
 * rather than answered. That split is what keeps a genuinely deleted tweet from costing a second
 * round trip: measured 2026-08-28, a nonexistent id answers HTTP 200 with a parseable
 * `TweetTombstone` reading "This Post is from an account that no longer exists", so it never reaches
 * the retry at all.
 *
 * THIS IS NOT "ASSERT ON STATUS", and the difference is worth stating because CLAUDE.md forbids the
 * other thing for good reasons. Status never decides whether we HAVE an answer — `syndicationOutcome`
 * and `guestOutcome` still read that out of the body, and a 200 carrying a decoy is still a failure.
 * Status is consulted only to decide whether asking again is worth one round trip when we have no
 * answer at all. A 429 with an HTML body and a 404 with an HTML body are identical to a content check
 * and want opposite treatment, which is the one question status can answer and content cannot.
 *
 * NO BACKOFF, DELIBERATELY. 200ms does not reset a rate-limit window, so a sleep would buy nothing
 * against the case it looks like it addresses, while adding latency to every failing card and to
 * every test that exercises this path. The failure measured is per-request, not per-window — the very
 * next request out of the same colo succeeds — so the valuable retry is the immediate one.
 *
 * IF THIS IS EVER "SIMPLIFIED" BACK to a single fetch, the failure it reintroduces is silent: cards
 * stop appearing for a fraction of pastes, permanently, with nothing in the logs (Workers Logs are off
 * — see wrangler.jsonc) and nothing in the counters to distinguish it from a genuinely dead post.
 */

/** One extra ask, not a loop: two attempts total. See askJson for why more would not help. */
const ASK_ATTEMPTS = 2

/**
 * Does a verdict-less answer deserve one more round trip? PURE, so the policy is testable with no
 * network — the same discipline syndicationOutcome and guestOutcome keep.
 *
 * True for the statuses that mean "the endpoint refused this request", which is the case a second ask
 * can win: 429 (rate limited), 5xx (edge/origin trouble), 408/425 (the request itself was dropped).
 * False for everything else — notably 404 and 403, which are answers about the POST rather than about
 * the request, and asking twice would only double the cost of every dead link.
 */
export function worthAskingAgain(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * I/O: GET a url and return its parsed JSON, asking twice when the first answer carried no verdict.
 *
 * `{ ok: false }` means "the endpoint answered, but not with JSON" — both call sites map that to
 * assert_fail, exactly as their inline parse did before. A THROWN fetch is re-thrown after the last
 * attempt rather than swallowed, which preserves the contract fetchSyndication/fetchGuest documented
 * and worker.ts depends on: a genuine transport failure is null / fetch_fail, a DIFFERENT signal from
 * "the endpoint answered un-parseably". The retry changes how many times we ask, never what an answer
 * means.
 */
async function askJson(url: string, init: RequestInit): Promise<{ ok: true; json: unknown } | { ok: false }> {
  let thrown: unknown
  let threw = false
  for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt++) {
    const last = attempt === ASK_ATTEMPTS - 1
    let status = 0
    let body: string
    try {
      const res = await fetch(url, init)
      status = res.status
      body = await res.text()
    } catch (e) {
      // A reset/DNS failure is the most transient answer there is, and the one most worth asking
      // again. Remembered rather than rethrown here so a successful second ask still wins.
      threw = true
      thrown = e
      continue
    }
    try {
      return { ok: true, json: JSON.parse(body) }
    } catch {
      // The endpoint answered with something that is not JSON. Only ask again if the STATUS says it
      // refused the request; a 404 poodle page is a verdict about the post and is believed.
      if (last || !worthAskingAgain(status)) return { ok: false }
    }
  }
  if (threw) throw thrown
  return { ok: false }
}

/**
 * ===================================================================================================
 * PATH B — GUEST GRAPHQL — the FALLBACK. More fragile to OPERATE than Path A (a guest-token dance, a
 * rotating qid, a features set Twitter tunes), which is exactly why it is the fallback and syndication
 * is primary: its marginal value is ROBUSTNESS — if Twitter changes the syndication token algorithm or
 * retires that endpoint, Path A returns `{}`/junk (assert_fail) and this keeps the service alive.
 * Measured working from Cloudflare Workers egress in the recon (2026-07-19); its live surface is
 * exercised at staging (Task 8), and the guest fixtures pin only the PARSE (in normalize.ts).
 * ===================================================================================================
 */

/**
 * THE PUBLIC WEB BEARER — a hardcoded PUBLIC CONSTANT, not a secret. It is Twitter's own web-client
 * bearer, shipped in FxEmbed's source (constants.ts line 60, read at HEAD 9f57d264) and served to
 * every anonymous browser; there is nothing to leak and nothing to rotate on our side. Log it never
 * anyway (Global Constraints: never log the guest token or any token) — it is the same public value
 * the recon captured, but it is not a credential we hold.
 */
const GUEST_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

/**
 * A MAINTAINED VALUE, not a constant — the same argument TIKTOK_UA makes. A browser-plausible UA on
 * the guest endpoints; last measured activating a token and answering TweetResultByRestId from Workers
 * egress on 2026-07-19. Re-measure and move the date when the guest path breaks.
 */
const GUEST_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

/**
 * The guest token is FREE and REUSABLE (~500-request budget, x-rate-limit-remaining: 499 per token),
 * so we reuse ONE activation for 2 hours (spec §Credentials) rather than minting one per tweet.
 *
 * IT IS REUSED TWICE OVER, and the second mechanism is the one that works everywhere:
 *
 *   1. `cf: { cacheEverything: true, cacheTtl }` on the activate.json fetch — the FxEmbed form, so
 *      workerd serves the cached activation until the TTL lapses. This is NOT caches.default: that
 *      is the Cache API (match/put on Request/Response objects), a DIFFERENT mechanism you cannot
 *      "store with cf" into. No KV binding.
 *   2. `tokenMemo` below, an isolate-local memo. ADDED FOR SELF-HOSTING, and it is not belt-and-
 *      braces: the `cf` option is a Cloudflare-only field on RequestInit, and off Cloudflare it is
 *      SILENTLY IGNORED — no error, no warning, just a fresh guest-token activation on every single
 *      cold card, which is a rate-limit source nobody would find until Twitter started answering
 *      429. A cache that only exists on one of the two runtimes is not a cache; the memo is the half
 *      that behaves the same on both, and on Workers it also saves the subrequest the `cf` cache
 *      would still have cost.
 *
 * WHY NOT `Deps.cache` INSTEAD, which is genuinely shared and would survive an isolate. Because it
 * is not reachable from here: fetchGuest is called by liveFetchPost, which is handed `env`, not
 * `Deps` — and widening that seam to carry a cache into every platform fetcher, so one of eighteen
 * can memoize one string, is a much larger change than the problem. The memo's weakness is exactly
 * the weakness the `cf` cache already had: it is per isolate / per process, so N processes hold N
 * tokens. At ~500 requests per token that is bounded and harmless.
 */
const GUEST_TOKEN_TTL = 7200

/**
 * TweetResultByRestId — its query id (`qid`). qids DRIFT; Twitter rotates them (see fetchGuest).
 *
 * THIS IS DELIBERATELY THE OLDER qid, and the choice is the difference between guessing a gate and
 * reading one. Measured 2026-07-26 on the SAME age-restricted tweet (2081088993219710978), same
 * bearer, same guest token, same headers — only the qid differs:
 *
 *   f2sagi1jweVHFkTUIHzmMQ (FxEmbed's current)
 *     -> {"data":{"tweetResult":{"result":{"__typename":"TweetTombstone"}}}}
 *        A BARE tombstone. No reason, no text, no image. Nothing to classify on.
 *
 *   0aTrQMKgj95K791yXeNDRA (this one, vxtwitter's)
 *     -> __typename        BlurredMediaTombstone
 *        blurred_image_url https://pbs.twimg.com/media/GxJIrSUagAAK-ZP?format=jpg&name=240x240
 *        text.text         "Age-restricted adult content. This content might not be appropriate for
 *                           people under 18 years old. To view this media, you'll need to log in to X."
 *
 * guestGateReason ALREADY reads `tombstone.text` to tell private from age — that code was written for
 * a tombstone that carries text and, on the newer qid, never received any, so its private branch was
 * unreachable and EVERY tombstone fell to the age default. The older qid is what makes the classifier
 * that already exists actually run, and turns the age verdict from a default into a positive read.
 *
 * NOT A DOWNGRADE ON THE HAPPY PATH, which is the thing to check before trusting an older qid.
 * Verified against real ids across every media shape this project renders — text (20), animated_gif
 * (1479837621337657345), video (1491475671058681863), photo+quote (1823076043017630114) and
 * multi-photo (1376712834269159425) — all returned `__typename: Tweet` with their media intact.
 *
 * IT DOES NOT UNLOCK THE MEDIA, and nothing credential-free does. Both fxtwitter and vxtwitter fetch
 * age-restricted posts with POOLS OF REAL LOGGED-IN ACCOUNTS (`auth_token` cookies + OAuth2Session);
 * vxtwitter ships a tokenTester.py purely to find the ones that got banned, and FxEmbed ships a
 * change_country.ts because logged-in EU/UK accounts are still refused. See fetchWithCredentials.
 */
const TWEET_RESULT_QID = '0aTrQMKgj95K791yXeNDRA'

/**
 * The `features` flag set for TweetResultByRestId, RESOLVED to the exact object that goes on the wire
 * — the `rwebTweetFeatureKeys` subset of FxEmbed's flag table with each key's value inlined (FxEmbed
 * `graphql/features.ts` + `queries.ts`, read at HEAD 9f57d264). Twitter 400s when a REQUIRED feature
 * is missing, so this is a faithful copy, not a guess; it DRIFTS with the qid and is kept current from
 * FxEmbed. This exact set answered HTTP 200 from Workers egress in the recon.
 */
const TWEET_RESULT_FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  tweet_awards_web_tipping_enabled: false,
}

/** fieldToggles for TweetResultByRestId (FxEmbed `queries.ts`). Drifts with the qid; kept current. */
const TWEET_RESULT_FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
}

/**
 * The guest three-way result, mirroring SyndicationResult — the orchestrator (Task 5) keys on the same
 * split (age_restricted -> the seam, assert_fail -> give up after both paths tried). One `Post | null`
 * cannot carry the age-gate distinction.
 */
export type GuestResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'age_restricted' | 'private' | 'assert_fail' }

/** A string, or ''. The read-through for the untrusted, cache-shaped guest body. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A TweetTombstone's human text, when it carries one (`tombstone.text.text` / `.text`), or ''. */
function tombstoneText(result: Any): string {
  const t = (result as Any)?.tombstone
  return str(t?.text?.text) || str(t?.text)
}

/**
 * The GATE a guest result names — 'age_restricted' | 'private' — or undefined for "not a recognized
 * gate" (a real Tweet, a deleted/suspended post, junk). This is where the age-vs-private DISTINCTION
 * lives, because the syndication tombstone is empty and cannot carry it.
 *
 *   TweetUnavailable.reason === 'Protected'      -> private   (the protected-account wall)
 *   TweetUnavailable.reason === 'NsfwLoggedOut'  -> age        (the age wall)
 *   a bare TweetTombstone                        -> age        (the MEASURED age-wall shape — recon
 *                                                   2026-07-19 shows a bare TweetTombstone with NO
 *                                                   reason on BOTH paths — DEFAULTING to age unless
 *                                                   its `tombstone.text` positively names a private
 *                                                   account)
 *   anything else (a real legacy, Suspended, a   -> undefined  (NOT a gate; falls through so a
 *   moderated/deleted result, junk)                 genuinely gone post renders the GENERIC failure)
 *
 * TWITTER PRIVATE-DETECTION IS BEST-EFFORT, pending a live protected-tweet capture: the 'Protected'
 * reason string is confirmed from yt-dlp / twitter-openapi, but this project has not itself captured a
 * protected tweet's guest body, so private is returned ONLY on a positive 'Protected' (or an explicit
 * private-naming tombstone text) match and otherwise falls back to age. The age default matches the
 * pre-existing behavior (every tombstone was age_restricted before private became a third case).
 */
function guestGateReason(result: unknown): 'age_restricted' | 'private' | undefined {
  const r = result as Any
  const reason = str(r?.reason)
  if (reason === 'Protected') return 'private'
  if (reason === 'NsfwLoggedOut') return 'age_restricted'
  if (r?.__typename === 'TweetTombstone') {
    return /protected|private/i.test(tombstoneText(r)) ? 'private' : 'age_restricted'
  }
  return undefined
}

/**
 * PURE classifier for a guest TweetResultByRestId body, testable with no network — the guest analogue
 * of syndicationOutcome. The whole path is OPTIONAL-CHAINED so a missing tweetResult/result, a `{}`, a
 * number, an array or null all fail closed to assert_fail rather than throwing (the OPTIONAL-CHAIN
 * TOTALITY the tests pin):
 *
 *   a GATE (guestGateReason positive)                      -> age_restricted | private (the wall,
 *                                                             classified — see guestGateReason).
 *   a Tweet/TweetWithVisibilityResults carrying a legacy   -> ok (data is the whole envelope, so
 *                                                             fromGuest can re-unwrap it).
 *   everything else                                        -> assert_fail.
 *
 * The gate is decided by guestGateReason (a TweetTombstone `__typename`, or a TweetUnavailable
 * `reason` — NsfwLoggedOut/Protected), never by a bare `reason` on a real Tweet. It runs BEFORE the
 * legacy check: a real Tweet/TweetWithVisibilityResults carries no gate signal, so it still reads ok.
 * The legacy check accepts BOTH nestings (result.legacy for an ordinary Tweet, result.tweet.legacy for
 * a TweetWithVisibilityResults — GOTCHA 1), the same defensive unwrap fromGuest uses.
 */
export function guestOutcome(json: unknown): GuestResult {
  const result = (json as Any)?.data?.tweetResult?.result
  const gate = guestGateReason(result)
  if (gate) return { ok: false, reason: gate }
  const legacy = result?.legacy ?? result?.tweet?.legacy
  if (result && legacy && typeof legacy === 'object') return { ok: true, data: json }
  return { ok: false, reason: 'assert_fail' }
}

/** A random 32-hex x-csrf-token. Its ONLY contract is that it matches the ct0 cookie (fact 2). */
function randomCsrf(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

/**
 * THE RUNTIME-INDEPENDENT HALF OF THE TOKEN REUSE (mechanism 2 under GUEST_TOKEN_TTL).
 *
 * `activation` is the token and when it lapses. `inFlight` is the SECOND thing this must do and the
 * reason a bare value would not be enough: one pasted tweet is unfurled by three concurrent
 * requests, and with only a value each of them sees an empty memo and activates its own token. The
 * shared promise collapses a cold burst into ONE activation.
 *
 * A FAILED ACTIVATION IS NOT MEMOIZED, deliberately. Twitter answering 503 once must not turn into
 * two hours of "no guest path" for every tweet on this isolate; the failure is per-attempt, and the
 * next caller tries again. Only a real token is stored.
 */
let activation: { token: string; expires: number } | null = null
let inFlight: Promise<string | null> | null = null

/**
 * TEST SEAM, and it exists for the rule CLAUDE.md states about module-level in-flight maps: this
 * memo is module state shared by every test in the process, so one test's token would silently
 * become another's answer and a test asserting "a fresh activation happens" would pass or fail
 * depending on file order. Every test that touches the guest path calls this first.
 */
export function resetGuestToken(): void {
  activation = null
  inFlight = null
}

/**
 * I/O: activate (or reuse) a guest token, or null. POST activate.json with the public bearer, reusing
 * the activation for GUEST_TOKEN_TTL through the memo above and the `cf` fetch cache (see
 * GUEST_TOKEN_TTL for why it takes both).
 *
 * ASSERT ON THE `guest_token` STRING, NOT on res.ok — a 200 carrying no token is still a failure (the
 * phase's assert-on-content rule). The body parse is guarded: a non-JSON body degrades to null (no
 * token), never an uncaught throw. `env` is accepted for signature parity with the credential seam and
 * a future secret-store binding; the bearer is a public constant, so it is unused today.
 */
export async function getGuestToken(_env: Env): Promise<string | null> {
  const now = Date.now()
  if (activation && activation.expires > now) return activation.token
  if (inFlight) return inFlight
  const work = activateGuestToken()
  inFlight = work
  // Cleared however it settles, INCLUDING on a throw: a rejected promise parked here would be
  // handed to every later caller for the life of the isolate, turning one network blip into a
  // permanently dead guest path. Attached to `work` rather than awaited so the clear cannot be
  // skipped by an early return.
  void work.catch(() => null).then(() => { if (inFlight === work) inFlight = null })
  return work
}

async function activateGuestToken(): Promise<string | null> {
  const res = await fetch('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { authorization: GUEST_BEARER, 'user-agent': GUEST_UA },
    // The cf fetch cache reuses the activation for the TTL on Workers — NOT caches.default, and NOT
    // effective anywhere else, which is what the memo above is for (see GUEST_TOKEN_TTL).
    cf: { cacheEverything: true, cacheTtl: GUEST_TOKEN_TTL },
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  const gt = (body as Any)?.guest_token
  if (typeof gt !== 'string' || !gt) return null
  activation = { token: gt, expires: Date.now() + GUEST_TOKEN_TTL * 1000 }
  return gt
}

/**
 * I/O: fetch Path B for one tweet and classify the body. GET TweetResultByRestId with the guest-token
 * header set (fact 2): the public bearer, x-guest-token, a random x-csrf-token, x-twitter-active-user,
 * and the guest_id/ct0 Cookie. No guest token -> assert_fail (the token dance failed; nothing to try).
 *
 * ASSERT ON CONTENT, NEVER ON STATUS. The parse is guarded (a non-JSON body -> assert_fail); a thrown
 * `fetch` still reaches worker.ts as null / fetch_fail — a transport failure, a different signal from
 * "the endpoint answered un-parseably" — matching fetchSyndication. Both of those now run through
 * askJson, which asks a SECOND time when the first answer carries no verdict and re-throws afterwards
 * rather than swallowing; see askJson for what that does and does not change.
 *
 * THE qid/features/fieldToggles SET DRIFTS — Twitter rotates them. It is kept current from FxEmbed, and
 * a LIVE 400/404 in Task 8 means "the set drifted" (re-copy from FxEmbed), NOT "the design is wrong".
 * This fragility to operate is precisely why Path B is the fallback, not the primary.
 *
 * The tweet id is JSON-encoded inside `variables` and percent-encoded into the query — it is never a
 * path segment (the path is the constant qid), so there is no traversal surface to pin.
 */
export async function fetchGuest(
  ref: Extract<PostRef, { p: 'x' }>,
  env: Env,
): Promise<GuestResult> {
  const gt = await getGuestToken(env)
  if (!gt) return { ok: false, reason: 'assert_fail' }
  const csrf = randomCsrf()

  const variables = {
    tweetId: ref.id,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  }
  const url =
    `https://api.x.com/graphql/${TWEET_RESULT_QID}/TweetResultByRestId` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(TWEET_RESULT_FEATURES))}` +
    `&fieldToggles=${encodeURIComponent(JSON.stringify(TWEET_RESULT_FIELD_TOGGLES))}`

  const got = await askJson(url, {
    headers: {
      authorization: GUEST_BEARER,
      'user-agent': GUEST_UA,
      'x-guest-token': gt,
      'x-csrf-token': csrf,
      'x-twitter-active-user': 'yes',
      accept: 'application/json',
      cookie: `guest_id=v1%3A${gt}; ct0=${csrf}`,
    },
  })
  if (!got.ok) return { ok: false, reason: 'assert_fail' }
  return guestOutcome(got.json)
}

/**
 * ===================================================================================================
 * THE ORCHESTRATOR + THE CREDENTIAL SEAM — Path A, then Path B, then (only for the age wall) the seam.
 * ===================================================================================================
 */

/**
 * What fetchTwitter hands the worker. It carries the SOURCE alongside the data so the worker calls one
 * normalizer entry (normalizeTwitter) that dispatches on `source` and never itself branches on shape;
 * and it keeps the SAME two-`reason` split the path fetchers use, because the worker still has to count
 * age_restricted vs assert_fail distinctly (they mean different things — the credential wall vs. both
 * paths failing to answer — and both are first-class in Outcome2).
 */
export type TwitterFetch =
  | { ok: true; source: 'syndication' | 'guest'; data: unknown }
  | { ok: false; reason: 'age_restricted' | 'private' | 'assert_fail' }

/**
 * THE CREDENTIAL SEAM. Age-gated posts (TweetTombstone) are unreachable credential-free — measured on
 * both paths, both egresses (recon 2026-07-19). FxEmbed surmounts them with a pool of real logged-in
 * accounts, picked at random per request (src/providers/twitter/proxy/credentials.ts). This function is
 * where ours would be spent, and it STILL RETURNS NULL, so the tweet becomes an honest age_restricted
 * card rather than a broken one.
 *
 * THE POOL EXISTS NOW; THE CALL THAT SPENDS IT DOES NOT. `X_ACCOUNTS` is a Worker secret holding a JSON
 * array of accounts, read through `twitterAccounts()` in src/credentials.ts — which filters to the
 * entries carrying BOTH `auth_token` and `ct0`, because that pair is what a logged-in
 * TweetResultByRestId call needs and a bare cookie jar is not an account this path can use. Setting the
 * secret today changes nothing here, deliberately, and worker.ts COUNTS that (`pool_unused` in the
 * Twitter gate arm) so a filled secret with no effect is a number rather than a mystery.
 *
 * WHY PLAINTEXT RATHER THAN THE ENCRYPTED BUNDLE THIS COMMENT USED TO DESCRIBE. An earlier phase copied
 * FxEmbed's shape — `CREDENTIAL_KEY` + an AES-256-GCM `CREDENTIAL_BUNDLE` decrypted per request. That
 * design answers a threat FxEmbed has and we do not: it self-hosts, where the bundle sits on a disk
 * somebody else may read. A Cloudflare Worker secret is encrypted at rest, unreadable back from the
 * dashboard, and absent from the repo, so a second layer buys no attacker-resistance while costing a
 * key stored in the same place as the thing it protects — plus a bespoke encrypt step on every
 * rotation, which is the step most likely to be skipped. Both variables are gone; the pool is read
 * straight out of the secret.
 *
 * THIS IS THE INJECTION POINT, and it is deliberately a real, tested function rather than a TODO: a
 * later phase fills it (pick from `twitterAccounts(env)`, fetch TweetResultByRestId with that account's
 * auth_token + ct0) and returns { source:'guest', data } — the SAME shape fetchGuest's ok result
 * carries, so fromGuest normalizes it with no further change. Filling it turns these exact posts into
 * ordinary successes with zero rearchitecting. Do NOT half-build a credential system here now: a
 * half-built one returns SOMETHING, and something wrong from a logged-in request is how a pool gets
 * flagged.
 *
 * `_ref`/`_env` are the signature a filled seam needs (which tweet, and the env that carries
 * X_ACCOUNTS); unused while empty, prefixed so tsc does not flag them.
 */
export async function fetchWithCredentials(
  _ref: Extract<PostRef, { p: 'x' }>,
  _env: Env,
): Promise<{ source: 'guest'; data: unknown } | null> {
  return null // empty seam: the pool is readable, the logged-in GraphQL call is a later phase
}

/**
 * The whole Twitter fetch, in fallback order. Syndication (Path A) is primary because it is the
 * cheapest (one GET, no credentials); guest (Path B) is the fallback that keeps the service alive if
 * Twitter changes the token algorithm or retires the syndication endpoint.
 *
 * THE TWO FALLBACK TRIGGERS ARE NOT INTERCHANGEABLE, and the reason split is the whole point of the
 * three-way results the path fetchers return:
 *   - A syndication `age_restricted` (a TweetTombstone) CONSULTS the guest path — not to fetch the post
 *     (guest walls the same ids credential-free too, recon), but to CLASSIFY the gate: the syndication
 *     tombstone is EMPTY `{}` and cannot tell age from private, whereas a guest TweetUnavailable NAMES
 *     the reason (Protected -> private, NsfwLoggedOut/bare-tombstone -> age). This is the ONE extra
 *     fetch a gated post pays and a NORMAL tweet never does (a normal tweet returns ok from Path A and
 *     never reaches guest). After classifying, escalate to the seam; if it is empty, surface the
 *     classified gate.
 *   - A syndication `assert_fail` (the {} missing-token trap, a 404 HTML poodle page, junk) is the
 *     "maybe Path A broke" case the fallback exists for, so it TRIES guest.
 *   - A guest `age_restricted`/`private` also escalates to the seam (a filled seam is the only thing
 *     that surmounts either wall); a guest `assert_fail` after syndication already failed means both
 *     paths are out of answers -> assert_fail, and the worker stacks it on its own fetch_fail.
 *
 * A filled seam returns { source:'guest', data }, which we re-wrap as an ok TwitterFetch so the exact
 * same fromGuest normalizer consumes a credentialed response — no new normalize path.
 *
 * NO try/catch around the path fetchers, deliberately: a genuinely thrown fetch (DNS, reset) propagates
 * to loadPost's try/catch in worker.ts, which turns it into null / fetch_fail — a transport failure is
 * a different signal from "the endpoint answered un-parseably" (assert_fail), the same layering tt/ig
 * keep.
 */
export async function fetchTwitter(
  ref: Extract<PostRef, { p: 'x' }>,
  env: Env,
): Promise<TwitterFetch> {
  const a = await fetchSyndication(ref) // Path A — primary
  if (a.ok) return { ok: true, source: 'syndication', data: a.data }
  if (a.reason === 'age_restricted') {
    // The wall. The empty syndication tombstone cannot tell age from private, so consult guest to
    // READ THE REASON (guest walls too, but its wall names why). If guest somehow FETCHED the post,
    // prefer that real post over any gate message.
    const b = await fetchGuest(ref, env)
    if (b.ok) return { ok: true, source: 'guest', data: b.data }
    const cred = await fetchWithCredentials(ref, env)
    if (cred) return { ok: true, source: cred.source, data: cred.data }
    // 'private' ONLY on a positive guest match; a bare/unreadable guest reason (assert_fail included)
    // DEFAULTS to age — the documented, pre-existing fallback.
    return { ok: false, reason: b.reason === 'private' ? 'private' : 'age_restricted' }
  }

  // a.reason === 'assert_fail' — the token algo/endpoint may have broken; try the fallback.
  const b = await fetchGuest(ref, env) // Path B — fallback
  if (b.ok) return { ok: true, source: 'guest', data: b.data }
  if (b.reason === 'age_restricted' || b.reason === 'private') {
    const cred = await fetchWithCredentials(ref, env)
    return cred ? { ok: true, source: cred.source, data: cred.data } : { ok: false, reason: b.reason }
  }
  return { ok: false, reason: 'assert_fail' }
}
