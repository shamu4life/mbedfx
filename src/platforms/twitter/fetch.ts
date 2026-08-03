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
 */
export async function fetchSyndication(
  ref: Extract<PostRef, { p: 'x' }>,
): Promise<SyndicationResult> {
  const url =
    'https://cdn.syndication.twimg.com/tweet-result' +
    `?id=${encodeURIComponent(ref.id)}&lang=en&token=${deriveSyndicationToken(ref.id)}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const body = await res.text()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    // A 404 HTML poodle page (or any non-JSON body) — the endpoint answered, but not with a tweet.
    return { ok: false, reason: 'assert_fail' }
  }
  return syndicationOutcome(json)
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
 * so we reuse ONE activation for 2 hours (spec §Credentials) through the RUNTIME FETCH CACHE — the
 * FxEmbed form: `cf: { cacheEverything: true, cacheTtl }` on the activate.json fetch, so workerd serves
 * the cached activation until the TTL lapses. This is NOT caches.default: that is the Cache API
 * (match/put on Request/Response objects), a DIFFERENT mechanism you cannot "store with cf" into —
 * pick one, and this phase picks the cf fetch-cache. No KV binding.
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
 * I/O: activate (or reuse) a guest token, or null. POST activate.json with the public bearer, caching
 * the activation for GUEST_TOKEN_TTL via the `cf` fetch cache (see GUEST_TOKEN_TTL).
 *
 * ASSERT ON THE `guest_token` STRING, NOT on res.ok — a 200 carrying no token is still a failure (the
 * phase's assert-on-content rule). The body parse is guarded: a non-JSON body degrades to null (no
 * token), never an uncaught throw. `env` is accepted for signature parity with the credential seam and
 * a future secret-store binding; the bearer is a public constant, so it is unused today.
 */
export async function getGuestToken(_env: Env): Promise<string | null> {
  const res = await fetch('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { authorization: GUEST_BEARER, 'user-agent': GUEST_UA },
    // The cf fetch cache reuses the activation for the TTL — NOT caches.default (see GUEST_TOKEN_TTL).
    cf: { cacheEverything: true, cacheTtl: GUEST_TOKEN_TTL },
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  const gt = (body as Any)?.guest_token
  return typeof gt === 'string' && gt ? gt : null
}

/**
 * I/O: fetch Path B for one tweet and classify the body. GET TweetResultByRestId with the guest-token
 * header set (fact 2): the public bearer, x-guest-token, a random x-csrf-token, x-twitter-active-user,
 * and the guest_id/ct0 Cookie. No guest token -> assert_fail (the token dance failed; nothing to try).
 *
 * ASSERT ON CONTENT, NEVER ON STATUS. The parse is guarded (a non-JSON body -> assert_fail); a thrown
 * `fetch` is deliberately NOT caught (worker.ts treats it as null / fetch_fail — a transport failure,
 * a different signal from "the endpoint answered un-parseably"), matching fetchSyndication.
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

  const res = await fetch(url, {
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
  let json: unknown
  try {
    json = JSON.parse(await res.text())
  } catch {
    return { ok: false, reason: 'assert_fail' }
  }
  return guestOutcome(json)
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
 * both paths, both egresses (recon 2026-07-19). FxEmbed surmounts them with a pool of real,
 * AES-256-GCM-encrypted logged-in accounts decrypted with CREDENTIAL_KEY and picked at random per
 * request (src/providers/twitter/proxy/credentials.ts). We ship that seam EMPTY: no CREDENTIAL_KEY, no
 * accounts, so this returns null and the tweet becomes an honest age_restricted failure.
 *
 * THIS IS THE INJECTION POINT, and it is deliberately a real, tested function rather than a TODO: a
 * later phase fills it (decrypt the bundle, getRandomTwitterAccount, fetch TweetResultByRestId with the
 * account's auth) and returns { source:'guest', data } — the SAME shape fetchGuest's ok result carries,
 * so fromGuest normalizes it with no further change. Filling it turns these exact posts into ordinary
 * successes with zero rearchitecting (spec, the X-platform credential section). Do NOT half-build a
 * credential system here now.
 *
 * `_ref`/`_env` are the signature a filled seam needs (which tweet, and the secret-store binding that
 * holds CREDENTIAL_KEY + the bundle); unused while empty, prefixed so tsc does not flag them.
 */
export async function fetchWithCredentials(
  _ref: Extract<PostRef, { p: 'x' }>,
  _env: Env,
): Promise<{ source: 'guest'; data: unknown } | null> {
  return null // empty seam: no accounts bundled this phase
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
