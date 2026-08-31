import type { ClientClass, Media, MuxJob, Platform, Post, PostRef, Profile, ProfileRef, Route } from './types.ts'
import { classify } from './classify.ts'
import { route } from './router.ts'
import { render } from './render/index.ts'
import { redirect } from './render/fail.ts'
import { toMastodonStatus, toOEmbed } from './render/mastodon.ts'
import { pickMedia, pickMediaEntry } from './media.ts'
import { bytesIndex, byline, mediaOf, mediaUrl, str, themeColor, usable } from './render/embed.ts'
import { statParts } from './render/text.ts'
import { proxyableVideoUrl, serveDirectVideo } from './mediaproxy.ts'
import { parseRefKey, refKey } from './refkey.ts'
import { count, countMux, type Env, type GateReason, type MuxOutcome } from './analytics.ts'
import { runSmoke, smokeOutcome, SMOKE_CHECKS, SMOKE_CLIENT } from './smoke.ts'
import { cookiesFor, jarAvailable, poolSetButUnused, twitterAccounts, type CredentialPlatform } from './credentials.ts'
import {
  cacheUrl, deserializePost, postCacheKey, respCacheKey, shortPostCacheKey, shortRespCacheKey,
  serializePost, POST_TTL, PROFILE_TTL, RESP_TTL, MEDIA_MAX_AGE,
} from './cache.ts'
import { fetchBluesky, fetchBlueskyProfile } from './platforms/bluesky/fetch.ts'
import { normalizeBluesky, normalizeBlueskyProfile } from './platforms/bluesky/normalize.ts'
import type { AwemeResolver } from './platforms/tiktok/fetch.ts'
import { encodeStatusId } from './statusid.ts'
import { fetchTikTok, isTikTokCdnHost, resolveTikTokShortlink, TIKTOK_UA, withResolvedVideo } from './platforms/tiktok/fetch.ts'
import { AWEME_PLAY, normalizeTikTok, tiktokGate, tiktokRefFrom, videoDetailScope } from './platforms/tiktok/normalize.ts'
import {
  fetchInstagram, fetchInstagramFullPage, fetchInstagramGraphQLMedia, fetchInstagramUserFeed,
} from './platforms/instagram/fetch.ts'
import {
  instagramAgeGate, instagramCopyrightBlocked, instagramFullPageCard, instagramPrivateGate,
  normalizeInstagram,
  recoveredMediaFrom, withCopyrightRemux, withRecoveredVideo,
} from './platforms/instagram/normalize.ts'
import { fetchTwitter } from './platforms/twitter/fetch.ts'
import { normalizeTwitter } from './platforms/twitter/normalize.ts'
import { fetchThreads } from './platforms/threads/fetch.ts'
import { normalizeThreads } from './platforms/threads/normalize.ts'
import { fetchReddit, resolveRedditShareUrl } from './platforms/reddit/fetch.ts'
import { modelInput, sourceLanguage, translateBest, withTranslation } from './translate.ts'
import { displayName } from './render/chooser.ts'
import { metaPlatformOf, resolveMetaShare, stripMetaTracking } from './platforms/metashare/fetch.ts'
import { normalizeReddit } from './platforms/reddit/normalize.ts'
import { fetchYouTube, ytPageUrl } from './platforms/youtube/fetch.ts'
import { ytDescriptionOf } from './platforms/youtube/description.ts'
import { fetchInnertube } from './platforms/youtube/innertube.ts'
import {
  normalizeYouTube, uploadDateFrom, withAgeNote, withCounts, withDescription, withLengthNote,
  withLiveNote, withMuxDuration,
  withUploadDate,
  youtubeVouched,
} from './platforms/youtube/normalize.ts'
import {
  facebookAgeGate, facebookCaptionCard, facebookPluginCard, facebookPostCard, fbPageUrl, fbPluginUrl,
  normalizeFacebook, type FacebookMeta,
} from './platforms/facebook/normalize.ts'
import { fetchFacebookPage, fetchFacebookPageUrl } from './platforms/facebook/fetch.ts'
import { fetchPinterest } from './platforms/pinterest/fetch.ts'
import { normalizePinterest } from './platforms/pinterest/normalize.ts'
import { fetchLemmy } from './platforms/lemmy/fetch.ts'
import { normalizeLemmy } from './platforms/lemmy/normalize.ts'
import { fetchMasto } from './platforms/mastoapi/fetch.ts'
import { fetchMisskey } from './platforms/misskey/fetch.ts'
import { fetchPeerTube } from './platforms/peertube/fetch.ts'
import { normalizePeerTube } from './platforms/peertube/normalize.ts'
import { normalizeMisskey } from './platforms/misskey/normalize.ts'
import { normalizeMasto } from './platforms/mastoapi/normalize.ts'
import { fetchTwitchClip } from './platforms/twitch/fetch.ts'
import { normalizeTwitchClip } from './platforms/twitch/normalize.ts'
import { type MuxShortcut, type YtdlpMeta } from './platforms/ytdlp/normalize.ts'
import { dmPageUrl } from './platforms/dailymotion/fetch.ts'
import { normalizeDailymotion } from './platforms/dailymotion/normalize.ts'
import { stPageUrl } from './platforms/streamable/fetch.ts'
import { normalizeStreamable } from './platforms/streamable/normalize.ts'
import { fetchImgur, imPageUrl } from './platforms/imgur/fetch.ts'
import { normalizeImgur, normalizeImgurApi } from './platforms/imgur/normalize.ts'

/**
 * Minimal shape of the Cache API we use, so tests can inject an in-memory stand-in — and, since
 * self-hosting became a real target, THE CONTRACT A SELF-HOSTER IMPLEMENTS. Two methods, and the
 * whole seam: `caches.default` satisfies it on Cloudflare, a `Map` satisfies it in the suite, and
 * anything shared satisfies it in production off Cloudflare. Nothing in this repo will ever depend
 * on Redis, Memcached or a specific store; the point of a two-method interface is that the choice
 * stays the operator's.
 *
 * WHAT AN IMPLEMENTATION MUST DO, because "a Map" is right for the tests and wrong for a deployment:
 *
 *   1. HONOUR `cache-control: max-age`. Every `put` carries one (POST_TTL 900 s for a post,
 *      RESP_TTL 900 s for rendered markup, PROFILE_TTL 180 s for a profile). A store that ignores it
 *      serves a post's counts and a profile's follower number forever, and the staleness is
 *      invisible — the card renders, it is just wrong. Cloudflare's Cache API reads the header; a
 *      Map does not, so a Map needs an expiry beside it.
 *   2. RETURN A FRESHLY READABLE BODY from every `match`. Callers read it (`await hit.text()`); a
 *      Response body is single-use, so handing the same object to two matches gives the second an
 *      already-consumed stream, which deserializes to null and reads as a cache miss forever.
 *   3. BE SHARED ACROSS PROCESSES, or be honest that it is not. A per-process Map on N workers is N
 *      caches with a 1/N hit rate, and Discord fetches roughly three times per paste. Cloudflare's
 *      own Cache API is already only per-datacenter, so a shared self-hosted store is arguably
 *      better than what the public instance has — see docs/SELF-HOSTING.md.
 *   4. NEVER REJECT. Most `put`s ride `ctx.waitUntil`, where a rejection is an unhandled one and,
 *      depending on the runtime, takes the process with it. Swallow the store's errors inside the
 *      implementation: a failed cache write is a performance event, never a correctness one.
 *   5. BE KEYED ON THE STRING IT IS GIVEN, exactly. Keys are absolute urls minted by cacheUrl on a
 *      synthetic origin, and they already carry every dimension that matters (the ref, the client
 *      class, and the serving origin — see respCacheKey). Normalising, lowercasing or stripping the
 *      query would merge entries that are deliberately distinct.
 *
 * Only these two methods are used. test/selfhost.test.mjs asserts that from the source, so a third
 * call site cannot appear without this list being updated with it.
 */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>
  put(key: string, res: Response): Promise<void>
}

/**
 * A mutable OUT-parameter through which a live fetch reports WHY a null came back, for the one
 * caller that renders the reason distinctly (the post route). The RETURN stays `Post | null` — the
 * cache layer serializes that and must not learn about failure shapes — so the reason rides out on
 * this instead: `reason: 'age_restricted'` for an age wall, `'private'` for a private/login wall,
 * absent for every other failure. The post route maps these onto Outcome.gate ('age' | 'private').
 *
 * The same rationale that put `env`/`client` on fetchPost (so a fetcher can COUNT a failure the
 * worker cannot see) puts this here (so it can NAME the failures the worker must render
 * differently). Optional, and every existing stub passes it never — JS ignores the extra argument,
 * so a stub returning `Post | null` keeps working unchanged and simply reports nothing.
 */
export interface FetchReport {
  reason?: GateReason
}

export interface Deps {
  cache: CacheLike
  /**
   * Live upstream fetch+normalize. Injectable so tests need no network.
   *
   * `env` and `client` are here ONLY so a platform fetcher can count a failure the worker
   * cannot see from the outside — see liveFetchPost. No existing test stub declares more than
   * the `ref` parameter, so all of them keep working: JS ignores extra arguments, and tsconfig
   * includes only `src`, so the .mjs tests are never typechecked against this signature.
   *
   * `report` is a mutable OUT-parameter (see FetchReport): the fetcher writes the reason a null
   * came back into it, WITHOUT widening this return, so the post route can render an age-gated
   * wall distinctly. Optional and last, so the stubs — which pass it never — are untouched.
   *
   * `ctx` is here for ONE reason: a fetcher whose upstream is the CONTAINER (fb and the yt-dlp tier,
   * through cachedMeta) must be able to keep that call alive past the response, or a call that merely
   * lost its deadline is CANCELLED — which strands its in-flight slot and gets mistaken for the id's
   * own failure. See cachedMeta's waitUntil. Optional and last for `report`'s reason: every existing
   * stub declares fewer parameters and JS ignores the extras, and a fetcher that does no container
   * work (every other platform) never reads it.
   *
   * `metaBudgetMs` is the CALLER'S ceiling for the container metadata call, and it is a parameter
   * because getPost is the same function on every surface while the surfaces are not the same: the
   * crawler head has 5s and the converter preview has 9s. Omitted means the crawler's, which is what
   * shipped — see META_TIMEOUT_API_MS for the measurement that made the single number wrong. Optional
   * and last for `report`'s reason: every existing stub declares fewer parameters, JS ignores the
   * extras, and a fetcher with no container upstream never reads it.
   */
  fetchPost(
    ref: PostRef, env: Env, client: ClientClass, report?: FetchReport, ctx?: ExecutionContext,
    metaBudgetMs?: number,
  ): Promise<Post | null>
  /**
   * Resolve a /t/{code} short link. Separate from fetchPost because the INPUT is not a PostRef —
   * a short code names no post until it is resolved — see liveResolveShortlink.
   *
   * REQUIRED, not optional, even though only one route calls it: optional would let a future
   * caller wire up a Deps without it and get "every short link is ambiguous" silently, since the
   * miss degrades into the chooser rather than throwing. The existing .mjs stubs that omit it are
   * unaffected — tsconfig includes only `src`, so they are never checked against this interface,
   * and none of them requests a shortlink path.
   */
  resolveShortlink(p: 'tt', code: string, env: Env, client: ClientClass): Promise<ShortlinkResolution>
  /**
   * Resolve a Reddit /s/ share link to a post ref + canonical permalink. Separate from
   * resolveShortlink because the INPUT is a full share url (not a bare code), the resolution is a
   * REDIRECT to a permalink we then route normally (no chooser, no gate vocabulary), and the result
   * is a plain PostRef the ordinary reddit post path consumes — not a bundled Post. Required for the
   * same reason resolveShortlink is: an optional miss would silently make every share link a generic
   * failure. The .mjs stubs that omit it are unaffected (only `src` is type-checked) unless a test
   * exercises a redditshare path, which must inject it.
   */
  resolveRedditShare(shareUrl: string, env: Env): Promise<{ ref: Extract<PostRef, { p: 'rd' }>; canonical: string } | null>
  /**
   * Resolve a bare `/share/{code}` to the permalink it names, on whichever Meta property owns it.
   * Returns the RAW Location; the caller re-routes it through route(), exactly as redditshare does.
   * Injected like its sibling so the .mjs suite can exercise the path without a network.
   */
  resolveMetaShare(code: string): Promise<string | null>
  /**
   * Fetch+normalize an ACCOUNT. Separate from fetchPost for the reason ProfileRef is separate from
   * PostRef (see types.ts): the input is not a post id and the output is not a Post, so folding it
   * in would mean a `Post | Profile` return that every existing caller has to narrow.
   *
   * REQUIRED, like resolveShortlink and for the same reason: optional would let a caller assemble a
   * Deps without it and get "every profile link is a failure card" silently. The .mjs stubs that
   * omit it are unaffected — tsconfig includes only `src` — unless a test exercises a profile path,
   * which must inject it.
   */
  fetchProfile(ref: ProfileRef, env: Env, client: ClientClass): Promise<Profile | null>
}

/**
 * THREE ANSWERS, NOT TWO, AND THE THIRD ONE WAS BEING THROWN AWAY.
 *
 * A `Post | null` return could not express the difference between "this code is not TikTok's" and
 * "this code IS TikTok's and the post is gone" — so a deleted post reached by short link rendered
 * "Ambiguous link … tiktok.com or threads.com" and counted ('none','ambiguous'), while the SAME
 * post reached by permalink rendered "tt extraction failed" and counted ('tt','fetch_fail'). Two
 * answers for one post, an offer to go look on Threads for a link we hold positive proof is
 * TikTok's, and a counter in which every deleted TikTok short link is indistinguishable from a
 * genuine Threads link.
 *
 * The evidence to separate them was always in hand: the deleted page CARRIES the
 * webapp.video-detail scope (statusCode 10204), and the homepage every non-TikTok code lands on
 * does not. tiktokRefFrom folds both into null, so the split is made here, before that call.
 */
export type ShortlinkResolution =
  /** Resolved. `post.ref` carries the CANONICAL numeric id, never the short code. */
  | { kind: 'post'; post: Post }
  /**
   * TikTok's OWN gate, reached by short link — a private (statusCode 10216/10222) or age-restricted
   * (isContentClassified + no playable video) post. It carries a video-detail scope, so it is NOT the
   * homepage (never 'unresolved'); but it has no usable itemStruct, so tiktokRefFrom/normalizeTikTok
   * fold it to null and WITHOUT this it would collapse into {kind:'gone'} and render the generic red
   * failure — a DIFFERENT answer than its permalink, which shows 🔒/🔞. That inconsistency across the
   * two url shapes is the whole reason this variant exists. `reason` is the fetcher/analytics
   * vocabulary ('age_restricted' | 'private', from tiktokGate); the shortlink route maps it onto
   * Outcome.gate ('age' | 'private') exactly as the post route maps FetchReport.reason.
   */
  | { kind: 'gated'; reason: GateReason }
  /** A TikTok video-detail page with no usable post in it: deleted, region-blocked. */
  | { kind: 'gone' }
  /**
   * We cannot name a post. Either the code is not TikTok's (the homepage — the resolver working,
   * and the honest answer is the chooser) or the page never arrived (counted assert_fail inside
   * the resolver, so the two are still told apart in analytics even though they render alike).
   */
  | { kind: 'unresolved' }

/**
 * THE ONE PLACE the fetcher/analytics gate vocabulary (GateReason: 'age_restricted' | 'private')
 * maps onto render's Outcome.gate ('age' | 'private'). Both walls that reach a user — the post
 * route's `failReason` and the short-link route's {kind:'gated'} — call this, so the two paths can
 * never render the same wall differently; they used to carry hand-synced copies of this ternary
 * (the "mirroring failReason" the comments warned about). `undefined` in -> `undefined` out: a null
 * with no recognized gate reason is a generic failure, not a wall, and gets the default card.
 */
export function renderGate(reason: GateReason | undefined): 'age' | 'private' | undefined {
  return reason === 'age_restricted' ? 'age' : reason === 'private' ? 'private' : undefined
}

/**
 * Exported for the dispatch test. A `ref.p !== 'bs'` guard here is what made Phase 1's
 * "platform #7 is just a fetcher plus a normalizer" claim false in practice: the fetcher and
 * normalizer can be perfect and the post still renders "could not fetch post".
 *
 * A switch, deliberately, rather than a lookup table: TypeScript narrows `ref` per case, so
 * each fetcher gets its own Extract<PostRef, …> for free and a new platform cannot be wired
 * up with the wrong ref shape. The default arm is the honest one — those platforms land in
 * Phases 4-5 and until then a null routes into the existing fetch_fail path.
 *
 * `env` and `client` exist only so a fetcher can attribute a failure the worker cannot see:
 * "the PAGE did not answer" (assert_fail) versus "the POST was rejected" (fetch_fail). It
 * COUNTS ON TOP of the worker's own fetch_fail rather than instead of it — the same layering
 * the activity/oembed case already does with api_miss, so the ratio is the readable signal.
 */
/**
 * THE ACCOUNT FETCHER, and it is one line per platform on purpose: everything that makes
 * liveFetchPost long — the container, the credential seam, the gate vocabulary, the meta warm — is
 * about POSTS. A profile is one unauthenticated GET.
 *
 * `env` and `client` are taken for liveFetchPost's reason (a fetcher counting a failure the worker
 * cannot see) and are unused today, because the one platform here has no gate to attribute: Bluesky
 * has no private accounts and answers a missing one with an explicit 400 rather than a decoy. A
 * platform that DOES wall accounts must count here rather than in the route.
 */
export async function liveFetchProfile(
  ref: ProfileRef, _env: Env, _client: ClientClass,
): Promise<Profile | null> {
  switch (ref.p) {
    case 'bs': {
      const raw = await fetchBlueskyProfile(ref)
      return raw ? normalizeBlueskyProfile(raw, ref) : null
    }
  }
}

export async function liveFetchPost(
  ref: PostRef, env: Env, client: ClientClass, report?: FetchReport, ctx?: ExecutionContext,
  metaBudgetMs?: number,
): Promise<Post | null> {
  switch (ref.p) {
    case 'bs': {
      const raw = await fetchBluesky(ref)
      return raw ? normalizeBluesky(raw, ref) : null
    }
    case 'tt': {
      const got = await fetchTikTok(ref)
      if (!got.ok) {
        // TikTok changed, blocked us, or rate-limited us. NOT the same event as a deleted post,
        // and the whole reason Outcome2 declared assert_fail in Phase 1.
        count(env, 'tt', got.reason, client)
        return null
      }
      /**
       * ONE HOP, NOT TWO. The normalizer selects the cookie-free `/aweme/v1/play/` URL, which is
       * itself a 302 to the real CDN bytes — so Discord saw TWO redirects between it and the
       * video, and drew the OpenGraph card instead of the Mastodon activity card. Measured
       * 2026-07-19; see resolveAwemeUrl for the full table.
       *
       * HERE, and not in the normalizer, because normalizers are PURE in this project (fetchers
       * do I/O; normalizers and renderers test with no network) — withResolvedVideo says so at
       * length. And here rather than in the media route because this is the ONE place per post
       * where an upstream fetch is already being paid for: loadPost caches what we return, so the
       * resolution is amortised across every client that ever fetches this post's media.
       *
       * Cannot fail the fetch: withResolvedVideo returns a Post either way, and a failed
       * resolution hands back the aweme URL — two hops, which is exactly what we ship today.
       */
      const post = normalizeTikTok(got.html, ref)
      if (post) {
        const resolved = await withResolvedVideo(post, awemeViaContainer(env, ref))
        /**
         * COUNT WHICH URL WE ACTUALLY SHIPPED, because the degrade above is silent by design and
         * that is how it went unnoticed for three weeks. See Outcome2's tt_onehop/tt_twohop.
         *
         * READ OFF THE RESULT, not off a flag returned by the resolver, and the difference matters:
         * withResolvedVideo is called from three places and only reports a Post. The url in hand is
         * the thing Discord will fetch, so asking it directly cannot drift from what shipped — and it
         * stays correct if a later change resolves the url somewhere else entirely.
         */
        const shipped = Array.isArray(resolved.media)
          ? resolved.media.find(m => m?.kind === 'video' && typeof m.url === 'string')
          : undefined
        if (shipped) {
          count(env, 'tt', String(shipped.url).includes(AWEME_PLAY) ? 'tt_twohop' : 'tt_onehop', client)
        }
        return resolved
      }
      /**
       * No Post came back. BEFORE the generic fetch_fail, check the SAME page for a GATE signal —
       * TikTok's age (isContentClassified + no playable video) / private (statusCode 10216/10222)
       * walls. Threaded exactly like Twitter's: count the reason and report it so the post route
       * renders the distinct 🔞/🔒 embed. PARSER-CONFIRMED, EGRESS-UNCONFIRMED, SELF-CORRECTING:
       * tiktokGate returns undefined unless the specific signal is present, so a normal or deleted
       * post falls straight through to today's generic behavior and a false positive is impossible.
       * Stacks on the worker's own fetch_fail (below), same layering as age_restricted/assert_fail.
       */
      const gate = tiktokGate(got.html)
      if (gate) {
        count(env, 'tt', gate, client)
        if (report) report.reason = gate
      }
      return null
    }
    case 'ig': {
      const got = await fetchInstagram(ref)
      if (!got.ok) {
        /**
         * Instagram served the decoy, blocked us, or renamed what the extractor looks for. NOT the
         * same event as a deleted post — and on THIS platform that distinction is invisible without
         * the counter, because the decoy is an HTTP 200 carrying ~598KB of perfectly ordinary
         * text/html. Every status- or size-based health check passes on it; only the content
         * assertion inside fetchInstagram can see it, and only this line can report it.
         *
         * READ fetchInstagram's InstagramFetch DOCSTRING BEFORE TUNING AN ALERT OFF THIS. A
         * genuinely deleted or private post ALSO lands here, because Instagram's "post
         * unavailable" page carries no distinguisher we can observe — so ordinary dead-link
         * traffic feeds this counter and a firing alert is not by itself proof the gate flipped.
         * TikTok is the opposite (its deleted page keeps the video-detail scope and stays ok:true),
         * so do not reason across the two platforms here.
         */
        count(env, 'ig', got.reason, client)
        /**
         * BEFORE the generic failure, check the FULL /p/{code}/ page for a private-account signal.
         * The embed surface just failed cannot carry it — a private post is byte-identical to a
         * deleted one there — but the full page names the account (username present, no media).
         * Egress-confirmed 2026-07-21. Threaded exactly like TikTok's / Twitter's gate: count the
         * reason and report it so the post route renders the 🔒 embed. FALLBACK-ONLY (reached solely
         * because the embed failed) and SELF-CORRECTING — instagramPrivateGate is undefined unless the
         * username-with-no-media shape is present, so a deleted or blocked post falls straight through
         * to today's generic behavior and a false positive on a dead link is impossible. The full-page
         * fetch's cost is bounded to this failure path and the rendered result is response-cached.
         */
        const full = await fetchInstagramFullPage(ref)
        /**
         * READ THE PAGE BEFORE INFERRING A WALL FROM IT — the fix for a PUBLIC post rendering 🔒.
         *
         * Reported 2026-07-26 on /reel/DZghoo7PAzi/ (public, @fixture8.example, 12K likes): the live apex
         * said "This post is private" while instagram7 served it. The embed had answered our
         * DATACENTER egress with the ~81KB unavailable shell, so we arrived here and the private
         * gate — whose rule is "a username with no data-media-type" — found that shape true of a
         * perfectly public post. From RESIDENTIAL egress the same page makes the gate return
         * undefined, which is why this never reproduced off-datacenter and reached production.
         *
         * The full page carries the whole post in its og: set, so we build a card from what is THERE
         * instead of concluding a wall from what is missing. The gate keeps its job — it just goes
         * SECOND, and now only sees pages that carry no post at all. A rule that reasons from absent
         * evidence cannot be the first thing consulted about a page that has evidence.
         */
        const card = instagramFullPageCard(full, ref)
        if (card) {
          count(env, 'ig', 'fullpage_recovered', client)
          /**
           * og:url handed us the handle, which is the only reason the feed is reachable here — the
           * embed that would normally name the owner returned nothing. Same recovery surface the
           * copyright-blocked path uses, and it degrades identically: no feed, no window hit, or a
           * refused fetch all leave the cover card, which is already far better than the 🔒 this
           * replaces. A reel's page ships og:image and no og:video, so without this the card is
           * always a still.
           */
          // `card` is non-null, and instagramFullPageCard refuses a story ref outright — so this arm
          // is unreachable for one. The narrow is for the TYPE, which cannot know that.
          const code = ref.kind === 'story' ? '' : ref.code
          /**
           * BY SHORTCODE FIRST, BY ACCOUNT SECOND — and the order is the whole point.
           *
           * The account feed finds a post by SCANNING an account's posts newest-first, so whether it
           * can repair a post depends on how recently that post was made. That is an accident of the
           * lookup, not a fact about the post: reported 2026-08-10, a reel rendered as a still purely
           * for being old, and paging the feed only moved the boundary (measured: post #49 on the
           * reported account still failed with a three-page walk).
           *
           * The GraphQL surface addresses a post by its OWN shortcode, so age stops mattering
           * entirely. Measured from CLOUDFLARE EGRESS 2026-08-10 with `wrangler dev --remote`, calling
           * this same shipped fetcher: the reported reel, a control from another account, and the
           * post that defeated the feed walk all returned the documented root and a 720x1280 video —
           * 22,679 / 26,022 / 25,024 bytes. That retires fetchInstagramGraphQLMedia's own
           * "NOT EGRESS-CONFIRMED" caveat, which had reasoned from the sibling media endpoint being
           * refused from this egress and correctly refused to assume.
           *
           * IT IS ALSO THE CHEAPER CALL BY TWO ORDERS OF MAGNITUDE: ~25 KB and one request, against
           * up to three feed pages of ~530 KB each.
           *
           * THE FEED STAYS AS THE FALLBACK rather than being replaced. A doc_id is a rotating
           * identifier — IG_GRAPHQL_DOC_ID exists so a rotation is a config change — and the day it
           * rotates this returns null and the account feed is what keeps recent posts working. Two
           * independent surfaces failing the same day is a worse outage than either alone.
           */
          const viaCode = recoveredMediaFrom(
            await fetchInstagramGraphQLMedia(code, env.IG_GRAPHQL_DOC_ID), code)
          if (viaCode) {
            count(env, 'ig', 'copyright_gql', client)
            return withRecoveredVideo(card, viaCode)
          }
          // The code is passed so the feed walk can STOP as soon as it finds this post, and so it
          // only pages at all for a post that is not already on page one. See IG_FEED_MAX_PAGES.
          const rec = recoveredMediaFrom(await fetchInstagramUserFeed(card.author.handle, code), code)
          return withRecoveredVideo(card, rec)
        }
        /**
         * THE AGE GATE GOES BEFORE THE PRIVATE ONE, and the order is load-bearing twice over.
         *
         * It reads Instagram's OWN error field (`failure_reason":"MA"` + `restricted_age`), where the
         * private gate infers a wall from an ABSENCE (a username with no data-media-type). A positive
         * signal must be consulted before an inferential one, for the same reason the og: card above
         * goes before both — otherwise the weaker rule answers first and its answer sticks.
         *
         * Reported 2026-07-28: two live reels on a 25+ account rendered "may be private, removed, or
         * unavailable". They exist; only the age wall stops us. This turns that into the 🔞 card the
         * project already ships for Twitter and TikTok.
         */
        const age = instagramAgeGate(full)
        if (age) {
          count(env, 'ig', age, client)
          /**
           * THE POOL IS SET AND THE WALL HELD — and on Instagram that is worth a second point because
           * it is the ONLY evidence available about whether the accounts are alive.
           *
           * WHAT IS AND IS NOT TRUE HERE, stated plainly so nobody reads more into the number than it
           * carries. IG_ACCOUNTS is spent in the CONTAINER (the copyright-remux mux), which is a page
           * this arm never reaches: `failure_reason":"MA"` is read off Instagram's own answer to the
           * WORKER's page fetch, and that fetch carries no jar. So a filled pool does not beat this
           * gate today, and a rising count is not proof the accounts are logged out — it is proof that
           * somebody with accounts configured is still being walled, which is the signal that says
           * "the credential is not reaching the request that needs it".
           *
           * Kept a counter rather than a comment for the reason the predicate it replaces failed: an
           * inert credential that is documented is still rediscovered from a card, while one that is
           * counted shows up next to the age_restricted rate it is supposed to move.
           */
          if (poolSetButUnused(env, 'ig')) count(env, 'ig', 'pool_unused', client)
          if (report) report.reason = age
          return null
        }
        const gate = instagramPrivateGate(full)
        if (gate) {
          count(env, 'ig', gate, client)
          if (report) report.reason = gate
        }
        return null
      }
      /**
       * NO VIDEO-RESOLUTION STEP, and its absence is a fact rather than an omission — which is why
       * it is written down beside the one case that has one.
       *
       * TikTok needs withResolvedVideo because its playable url is the `/aweme/v1/play/` endpoint,
       * which is ITSELF a 302 to the real CDN bytes: Discord saw two hops between it and the video
       * and drew the plain OpenGraph card instead of the rich activity card. Instagram's
       * `video_url` is a DIRECT CDN url at ZERO redirect hops (verified 2026-07-19, cookie-free:
       * 6,887,308 bytes, h264/aac, 720x1280, 75.58s), so there is nothing to collapse and no
       * second upstream fetch to pay for on this path.
       *
       * WHAT THE REQUEST-COUNT TEST ACTUALLY GUARANTEES, corrected after review — an earlier
       * version of this comment claimed it catches a copied `case 'tt'`, and that is FALSE.
       * Appending TikTok's `? await withResolvedVideo(post) : null` here is a behavioural NO-OP:
       * withResolvedVideo bails at `if (i < 0) return post` unless a video url contains
       * AWEME_PLAY ('/aweme/v1/play/'), and an Instagram scontent url never does. Measured on the
       * real reel fixture — zero added fetches, and the SAME object reference back — so neither a
       * request count nor a reference-identity assertion can see that mutant. It is caught by
       * nothing, and it is also not a defect. The mutation that IS caught is the wholesale one
       * (calling fetchTikTok on an ig ref), and the TYPECHECKER catches it, not a test: TS2345,
       * an ig ref has no `id`. igNoVideoResolutionHop() in pipeline.test.mjs pins the mechanism.
       *
       * So the count-of-one test is a pin against a genuinely ADDED upstream fetch on this path —
       * a poster download, a HEAD probe, a second page request — which is real value, and is the
       * only claim it should ever be cited for.
       *
       * If Instagram's CDN ever refuses our egress, that STILL does not add a resolution step —
       * there is no redirect to resolve. It is a human-gate risk, not a code change.
       */
      const post = normalizeInstagram(got.html, ref)
      /**
       * THE COPYRIGHT-BLOCKED RECOVERY, and it is the ONE case where this platform makes a second
       * upstream request on a SUCCESSFUL fetch — so it is gated twice and both gates are cheap.
       *
       * Instagram's embed serializer omits `video_url` entirely when the post's audio is catalog
       * music Meta declines to sub-license to embedders, so mediaFrom's (correct) "a video we cannot
       * play degrades to its still" arm fires and a real video silently renders as a photo — the
       * defect reported 2026-07-26 on /reel/DbN6SsKum-9/. The v1 user-feed carries no copyright field
       * at all and serves the renditions intact. See fetchInstagramUserFeed for the measurement.
       *
       * GATED ON THE PAYLOAD WE ALREADY HAVE (instagramCopyrightBlocked, pure, no request) AND on
       * the post having actually degraded to a still. Both must hold, so a healthy post — the
       * overwhelming majority, and every post whose audio is original or indie catalog — never pays
       * the ~500KB. This is deliberately NOT the general "no video" case: a post can lack video for
       * many reasons and only this one is recoverable here.
       *
       * FAILS SAFE BY CONSTRUCTION. fetchInstagramUserFeed returns null on any refusal, redirect,
       * decoy or throw; recoveredMediaFrom returns null for a code outside the feed window; and
       * withRecoveredVideo returns the SAME post object for any of those. So every failure mode lands
       * on exactly today's cover-still behaviour and the worst case is "unchanged". That matters more
       * than usual here because the measurements behind this are RESIDENTIAL — Cloudflare egress is
       * unconfirmed on this endpoint, and this shape is what makes shipping it anyway defensible.
       */
      if (post && instagramCopyrightBlocked(got.html) && post.media[0]?.kind === 'image') {
        const code = ref.kind === 'p' ? ref.code : ''
        /**
         * THREE RECOVERIES, CHEAPEST AND MOST PRECISE FIRST, each covering the one below it.
         *
         * 1. THE SHORTCODE GRAPHQL QUERY. One POST, ~21KB, measured at 429ms — and addressed by the
         *    POST, so the user feed's 12-item window cannot apply to it. This is what the
         *    InstaFix-derived services use, and it is why they played /reel/DX7byl-oyGR/ while we drew
         *    a photo. Its weakness is a rotating doc_id.
         * 2. THE ACCOUNT FEED. Older, no magic number to rot, but account-scoped: only recovers a post
         *    inside the account's twelve most recent. It is the answer when the doc_id has rotated and
         *    the post is recent.
         * 3. THE yt-dlp CONTAINER. Slowest, and the only one that is not a private Instagram endpoint
         *    at all — which makes it the durable floor: yt-dlp's maintainers chase Meta's changes, so
         *    it survives the failure that takes out both of the above.
         *
         * They fail in DIFFERENT ways on purpose. 1 dies to a doc_id rotation, 2 to an old post, 3 to
         * a missing container or an extractor break. Nothing but Instagram refusing our egress
         * outright takes all three, and that lands on the cover still we already ship.
         */
        const gql = recoveredMediaFrom(
          await fetchInstagramGraphQLMedia(code, env.IG_GRAPHQL_DOC_ID), code,
        )
        if (gql) {
          count(env, 'ig', 'copyright_gql', client)
          return withRecoveredVideo(post, gql)
        }
        // Same walk, same reason: a copyright-blocked post outside the account's twelve most recent
        // was unrecoverable here too, for the age reason IG_FEED_MAX_PAGES records.
        const feed = await fetchInstagramUserFeed(post.author?.name, code)
        const recovered = recoveredMediaFrom(feed, code)
        if (recovered) {
          count(env, 'ig', 'copyright_recovered', client)
          return withRecoveredVideo(post, recovered)
        }
        /**
         * THE WINDOW RAN OUT, SO HAND THE PAGE TO THE CONTAINER — the same yt-dlp tier YouTube and
         * Facebook use. Reported 2026-08-02 on /reel/DX7byl-oyGR/, which instagram7 played and we drew
         * as a photo.
         *
         * The feed above is ACCOUNT-scoped and Instagram serves 12 items whatever `count` asks for, so
         * a blocked reel further back than that was unrecoverable. That one sits ~60 posts deep;
         * reaching it by `max_id` paging measured five sequential requests and 2.45 MB, which does not
         * fit a 5s ceiling and hands any unauthenticated caller a multi-megabyte lever. yt-dlp is
         * addressed by the POST, so the window simply does not apply — and on that reel it returned a
         * better rendition than the feed does (1080x1920 against 720x1280) in one request.
         *
         * ORDER MATTERS AND IS DELIBERATE: the feed is tried FIRST, so a recent blocked reel still
         * resolves without booting a container. This is the fallback's fallback.
         */
        count(env, 'ig', 'copyright_remux', client)
        return withCopyrightRemux(post)
      }
      return post
    }
    case 'x': {
      const got = await fetchTwitter(ref, env)
      if (!got.ok) {
        /**
         * age_restricted: the credential wall, and the seam is empty this phase — a TweetTombstone that
         * both paths return credential-free, routed here as a DISTINCT failure (crawler age-restricted
         * embed, human 302). assert_fail: BOTH paths failed to answer — the syndication token
         * algo/endpoint broke AND the guest path 400'd/blocked/returned junk. Counted HERE because the
         * worker cannot see WHY a null came back — the same split ig makes for its decoy — and both
         * stack on top of the worker's own fetch_fail (the null-path counter below), exactly as ig's
         * assert_fail does.
         *
         * age_restricted ALSO rides out on `report` (a distinct signal from the counter, which the post
         * route cannot read): a null tells the route the fetch failed, and this tells it the ONE reason
         * that changes what the crawler sees. assert_fail is left unreported — it renders as the generic
         * failure, like every deleted post. Counting is unchanged: exactly one age_restricted point.
         */
        count(env, 'x', got.reason, client)
        // age_restricted / private ALSO ride out on `report` (a distinct signal from the counter): a
        // null tells the route the fetch failed, and this tells it WHICH gate to render. assert_fail
        // is left unreported — it renders as the generic failure, like every deleted post.
        if (got.reason === 'age_restricted' || got.reason === 'private') {
          if (report) report.reason = got.reason
          /**
           * THE POOL IS SET AND THE WALL HELD — expected on THIS platform, and counted so that is a
           * number rather than a memory.
           *
           * X_ACCOUNTS can be filled today; the Worker-side GraphQL call that would spend it is a
           * later phase, so fetchWithCredentials returns null and these posts stay honest 🔞 / 🔒
           * cards. That is deliberate staging, and the failure mode it creates is somebody filling a
           * secret, seeing nothing change, and having no way to tell "the accounts are dead" from
           * "the code does not read them yet". This counter is that way.
           *
           * BOTH GATES, not only the age one: fetchTwitter escalates to the seam for a `private`
           * TweetUnavailable as well (see its fallback-order docstring), so both are arms that WOULD
           * have spent a credential. Counting only one would under-report the staging gap by exactly
           * the posts a filled pool is most likely to fix first.
           *
           * NOT a replacement for the `count(env, 'x', got.reason, client)` above — a second, distinct
           * point. Folding them would blunt the age_restricted rate, which is the alert that matters
           * when a pool is NOT set.
           *
           * `twitterAccounts`, not the generic pool predicate the other two platforms use, and the
           * difference is real: Twitter's path needs auth_token AND ct0 together, so an entry carrying
           * only a cookie jar is not an account this arm could ever have spent. Counting it would
           * report a staging gap where the honest answer is "that secret is the wrong shape".
           */
          if (twitterAccounts(env).length > 0) count(env, 'x', 'pool_unused', client)
        }
        return null
      }
      /**
       * NO withResolvedVideo, and its absence is a fact rather than an omission. TikTok needs one
       * because its playable url is ITSELF a 302 (two hops -> Discord draws the plain OpenGraph card).
       * Twitter's video.twimg.com mp4 is 0 redirect hops, unsigned, cookie-free (recon 2026-07-19), so
       * there is nothing to collapse and no second upstream fetch to pay. If the CDN ever refused our
       * egress that STILL adds no step — there is no redirect to resolve; it is a human-gate risk, not a
       * code change. normalizeTwitter dispatches on got.source, so the worker never sees two shapes.
       */
      return normalizeTwitter(got, ref)
    }
    case 'th': {
      // Threads gives a logged-out crawler no way to tell private / age / deleted apart (all render
      // the same no-og:type shell), so there is no gate to report — every failure is a plain
      // fetch_fail and renders the generic "couldn't load" card, which is the honest answer. The
      // only distinct counter is assert_fail: the page did not arrive (both UAs missed the marker).
      const got = await fetchThreads(ref)
      if (!got.ok) {
        count(env, 'th', got.reason, client)
        return null
      }
      return normalizeThreads(got, ref)
    }
    case 'rd': {
      // Reddit's anonymous .json is IP-blocked from our egress, so fetchReddit reads embed.reddit.com
      // (credential-free, egress-safe) as PRIMARY, with the OAuth token path only as a fallback when
      // app creds happen to be set. The embed surface can't tell a private sub from a missing post
      // (both are the not-found shell), so a removed/private/deleted post is a null Post -> the generic
      // "couldn't load"; the 'private' -> 🔒 gate only fires on the OAuth fallback.
      const got = await fetchReddit(ref, env)
      if (!got.ok) {
        count(env, 'rd', got.reason, client)
        if (got.reason === 'private' && report) report.reason = 'private'
        return null
      }
      return normalizeReddit(got, ref)
    }
    case 'yt': {
      // YouTube ALWAYS renders: the remux video and the thumbnail derive from the id alone, so oembed
      // is pure enrichment (the real title + channel) and a miss is not a failure. normalizeYouTube
      // handles both ok and !ok; we count the miss so oembed egress health is visible (it stacks under
      // the post route's 'ok', giving an assert_fail/ok = oembed-miss ratio).
      //
      // THE DATE IS READ CACHE-ONLY HERE — one small R2 GET, never a container call, CONCURRENT with
      // oembed so it adds no wall clock. It is what makes the POST CACHE ENTRY ITSELF honest in the
      // steady state (every consumer of a cached yt Post — the telegram and text renderers read the
      // same object — stops being handed a fabricated 1970), and it replaces a 1.58MB request to
      // youtube.com, so the cold HTML path is strictly faster than before. The container call that
      // FILLS this cache lives on the activity route alone (youtubeMeta), which is the only output
      // carrying a date.
      const [got, warm] = await Promise.all([
        fetchYouTube(ref),
        readCachedMeta<YouTubeMeta>(ref, env, ytMetaTtl, ytMetaUsable(env)),
      ])
      if (!got.ok) count(env, 'yt', 'assert_fail', client)
      // Bounded exactly as assert_fail is — once per post-cache miss, not once per request. The DATE
      // is the test rather than the status code: see the counter's own docstring for why a 200 with
      // an empty videoDetails must not read as success.
      count(env, 'yt', got.uploadedAt === undefined ? 'yt_innertube_fail' : 'yt_innertube_ok', client)
      /**
       * THE JAR WAS SENT AND THE GATE HELD — the one arm where `pool_unused` is a REAL fault signal
       * rather than a staging note.
       *
       * `ageLimit` on this record came out of the container's `-J`, and since g10 that call carries the
       * YT_ACCOUNTS jar when there is one to carry. So a positive threshold on a record read back WITH a
       * pool configured means the logged-in extract still saw an age wall: the accounts are signed out,
       * rate-limited, or flagged, and the jar needs rotating. That is a maintenance action nobody can
       * take from a card, which is why it is a number.
       *
       * WHY THIS SITE AND NOT resolveYouTubeMeta, where the call actually happens: `count` takes a
       * client class, and the container call has no request to classify. Here the gate is observed at
       * the same place `assert_fail` is, once per post-cache miss rather than once per request — so it
       * is bounded the same way every other counter on this path is.
       *
       * THE RECORD IS TRUSTED TO BE POST-JAR, and the generation bump above is only HALF of why —
       * corrected 2026-08-03, because the earlier half-answer here was wrong in the direction that costs
       * an operator the most. g10 retired every record written before the cookie code shipped. It could
       * not retire the ones written AFTER that deploy and BEFORE a secret was filled, which are g10
       * records produced by a jar-capable build with no jar to send. Read literally, this line would
       * therefore fire on exactly those on the day a pool is first filled — telling an operator their
       * brand-new accounts are dead, on the strength of an answer that was never asked with a credential,
       * and sending them to rotate throwaways that were fine. What actually makes the record trustworthy
       * is `ytMetaUsable`, which refuses a gated record that carries no `jarred` flag while a jar is
       * available: by the time `warm` exists here with a positive `ageLimit` and a pool set, the jar WAS
       * spent and the wall held. Keep those two facts together — this counter's meaning is that
       * predicate's, and weakening one silently changes the other.
       */
      if (typeof warm?.ageLimit === 'number' && warm.ageLimit > 0 && poolSetButUnused(env, 'yt')) {
        count(env, 'yt', 'pool_unused', client)
      }
      // THE WARM DATE IS OVERLAID WHETHER OR NOT OEMBED ANSWERED. `got.ok && warm` was the first
      // spelling and it threw away a date this worker was already holding: an oembed miss makes the
      // post UNVOUCHED, youtubeMeta then declines to fill the date on the activity route (the vouch is
      // link 5 of its gate chain), and the card renders 1 January 1970 for the whole POST_TTL — with a
      // correct timestamp sitting in R2 the entire time. Title and date come from two independent
      // sources; one missing must not suppress the other.
      /**
       * `??`, NOT PLAIN ASSIGNMENT, AND THE DIFFERENCE IS THE WHOLE POINT NOW.
       *
       * This overlay used to write `uploadedAt: warm.timestamp` unconditionally. That was harmless
       * while the R2 record was the ONLY source of a date — an absent warm field clobbered an absent
       * fetch field, and both were absent together. It stopped being harmless the moment fetchYouTube
       * started carrying a date of its own (innertube.ts): a warm record that predates a field, or a
       * warm record that exists at all while Innertube answered faster, would silently blank a value
       * we were already holding. That is the exact defect this file records for the pre-2026-07-26
       * `got.ok && warm` spelling, one field over.
       *
       * The RECORD still wins where both exist, deliberately: it is the container's `yt-dlp -J`
       * answer, it is what the age-gate jar was spent on, and the two agree byte-for-byte on every id
       * measured (dQw4w9WgXcQ -> 1256453853 from both). This only decides who wins when one is absent.
       */
      const gotCounts = got.counts as { views?: number; likes?: number; replies?: number } | undefined
      const ytPost = normalizeYouTube(
        warm
          ? {
            ...got,
            uploadedAt: warm.timestamp ?? got.uploadedAt,
            ageLimit: warm.ageLimit ?? got.ageLimit,
            description: warm.description ?? got.description,
            /**
             * THE ONE FIELD WHERE THE FETCH WINS AND THE RECORD LOSES, and the inversion is the whole
             * correctness argument for storing it at all.
             *
             * Every other line here prefers the record because the answer cannot change: an upload
             * instant, a duration, a gate verdict a credential was spent on. Liveness CAN change, in
             * the one direction that matters — a stream ends and becomes an ordinary muxable VOD —
             * and the record lives 30 days. Preferring it would refuse a player for a month after the
             * broadcast finished, which is a worse card than the one this change exists to fix.
             *
             * `??`, so this is not "the fetch always wins": a request whose Innertube call was refused
             * carries `undefined`, not `false`, and falls back to the record. Only an answer we
             * actually got can overrule it — see innertube.ts's liveVerdict for why the three values
             * are kept apart all the way from the wire.
             */
            isLive: got.isLive ?? warm.isLive,
            counts: {
              views: warm.views ?? gotCounts?.views,
              likes: warm.likes ?? gotCounts?.likes,
              replies: warm.replies ?? gotCounts?.replies,
            },
          }
          : got,
        ref)
      /**
       * THE DURATION IS STAMPED ON AFTERWARDS, and that is not squeamishness about the overlay above.
       *
       * settleMux already knows how to refuse a video the container will refuse — `m.duration >
       * MUX_MAX_SECONDS` returns the still without spending a container call. On YouTube that arm has
       * been DEAD CODE since it was written, because normalizeYouTube hardcodes `remux: { page }` and
       * never carries a duration, so every over-ceiling video is dispatched to be told what the meta
       * record already said. With the alarm landed that costs three container calls across a 22-minute
       * horizon, out of a pool of four slots shared by ten platforms, for an answer that is final.
       *
       * NOT PUT IN THE OVERLAY OBJECT. `YouTubeFetch` is a closed union (platforms/youtube/fetch.ts),
       * so `duration: warm.duration` there is a tsc error, and widening it would not help — normalize
       * never reads the field. Stamping the built entry is the whole change, and it keeps the fetch
       * type describing what youtube.com answered rather than what R2 remembered.
       *
       * COLD FIRST PASTE IS UNCHANGED: `warm` is a cache-only read, so the very first view of a long
       * video still dispatches the doomed mux. POST_TTL is 900s and the record lives 30 days, so every
       * view after the activity route fills it is covered.
       */
      // The record's duration first for the reason above; Innertube's is what makes this reachable at
      // all on a COLD paste, which is the only paste that matters.
      return ytPost ? withMuxDuration(ytPost, warm?.duration ?? got.duration) : ytPost
    }
    case 'fb': {
      // Facebook: BOTH the title/poster and the video come from the container's yt-dlp — Meta decoys the
      // crawler-UA/oembed metadata surface from datacenter, but yt-dlp extracts the video (and its metadata)
      // fine. So the meta comes from a `{page, meta:true}` container call here; the video is the
      // remux:{page} the /_media route muxes. No container (or a failed extract) => the generic card.
      // cachedFacebookMeta, not resolveFacebookMeta: the extract is 2.4-3.1s and its fields are
      // immutable for a video id, so it is paid at most once per video per day (R2, global — the
      // response cache is per-colo and Discord's three fetches do not reliably share one).
      // `ctx` so the extract survives the response — see cachedMeta's waitUntil.
      //
      // A `photo` REF TAKES THIS SAME PATH, extract first, and the obvious optimisation is DELIBERATELY
      // NOT TAKEN. A /photos/ or /photo/?fbid= url names a picture, so yt-dlp will decline it and the
      // ~3s is spent to learn nothing — but "yt-dlp declines a Facebook photo url" was NOT measured:
      // `wrangler dev --remote --enable-containers=false` is the sanctioned way to measure from this
      // egress and it has no container to ask. Skipping the call on an unmeasured belief would trade a
      // known cost for an unknown one (a video that a photo spelling happens to address would silently
      // become a still). Measure the decline, then skip it.
      //
      // The fall-through below is what actually renders a photo: the plugin fragment. Measured
      // 2026-08-11 from Cloudflare egress over eleven photo permalinks on four pages — all eleven.
      //
      // `metaBudgetMs` DELIBERATELY DOES NOT RIDE THROUGH HERE, and the reasoning that said it should
      // was wrong in both directions. Facebook was not in the diagnosis that produced the wider preview
      // budget; that diagnosis measured Dailymotion, where a lost meta deadline IS the failure card
      // because there is no second upstream. Facebook has two more (the page and the plugin fragment),
      // neither of which carries a deadline at all — platforms/facebook/fetch.ts has no AbortSignal and
      // no budget parameter — so nothing here "runs out of clock" and a wider meta budget cannot help
      // them. It can only hurt: widening this makes the fall-through start LATER, and the photo path
      // three paragraphs above takes this call EXPECTING yt-dlp to decline, so every Facebook photo
      // with a slow or cold container would sit up to 8700ms — with a human watching the converter
      // spinner — before reaching the plugin fragment that is what actually renders it.
      const meta = await cachedFacebookMeta(ref, env, ctx)
      if (!meta) {
        /**
         * NOT A VIDEO — so try the POST surface before giving up. Facebook's share sheet hands out one
         * opaque code for videos AND for photo/text posts (/share/{code} 302s to either), so a
         * yt-dlp decline is not evidence the link is dead; it is usually evidence the link is a post.
         *
         * This platform was video-only because the roadmap recorded Meta as decoying the crawler-UA
         * metadata surface from datacenter. That was measured against `facebookexternalhit` — Meta's
         * OWN crawler UA, which gets HTTP 200 and ZERO BYTES — and generalised further than the
         * measurement did: Twitterbot gets the full page with a complete og: set (measured
         * 2026-07-26, 319,851 bytes on the same url). See fetchFacebookPage.
         *
         * Two of the three links reported that day become real cards this way (both image posts); the
         * third is a TEXT post whose page carries no og tags under any UA tried, and it stays an
         * honest failure. Multi-image posts render their COVER only — the page exposes one distinct
         * scontent url — which is a real limit, not an oversight.
         *
         * FAILS SAFE: a throw, an empty body or a decoy all return null from either half, and null
         * lands on exactly the generic failure card this arm already produced.
         */
        const page = await fetchFacebookPage(ref)
        const card = facebookPostCard(page, ref)
        if (card) {
          count(env, 'fb', 'fullpage_recovered', client)
          return card
        }
        /**
         * THE EMBED PLUGIN, which since 2026-08-08 is the surface that actually answers. Every
         * ordinary post url — permalink, story.php, pfbid, share — now returns a login wall or a
         * metadata-stripped page to this project's datacenter egress, in four different client
         * shapes; the plugin fragment returns the post. The measurements are in facebookPluginCard.
         *
         * SECOND, NOT FIRST, and deliberately: when the og: surface DOES answer it carries the whole
         * multi-image gallery from its preload links, and this fragment carries what the embed
         * paints. So a post that still renders the richer way keeps doing so, and this costs one
         * request only on a path that has already failed.
         *
         * A SHARE REF SKIPS IT — `fbPageUrl` spells a share as /share/v/{code}, which is a redirect
         * to a post rather than a post, and the plugin has nothing to render for it. That case is
         * handled below instead, once the code has been resolved to a real permalink.
         */
        if (ref.kind !== 'share') {
          const viaPlugin = facebookPluginCard(await fetchFacebookPageUrl(fbPluginUrl(fbPageUrl(ref))), ref)
          if (viaPlugin) {
            count(env, 'fb', 'plugin_recovered', client)
            return viaPlugin
          }
          /**
           * A POST WITH WORDS AND NO PICTURE, which until now was a failure card on both surfaces at
           * once — the page has no og:image so facebookPostCard refused it, and Meta's plugin refuses
           * to embed it. `page` is already in hand, so this costs no request. See facebookCaptionCard
           * for the measurement and for why it is LAST rather than folded into the call above.
           *
           * INSIDE THIS BRANCH, not after it, so a SHARE ref still reaches the resolution arm below:
           * a share code's own page is a redirect stub, and letting a caption card off it win would
           * pre-empt the richer card the resolved permalink can still produce.
           */
          const viaCaption = facebookCaptionCard(page, ref)
          if (viaCaption) {
            count(env, 'fb', 'caption_recovered', client)
            return viaCaption
          }
        }
        /**
         * NOT RENDERABLE — but say WHY when Facebook tells us. An 18+ post answers with a substantial
         * page (304,440 bytes measured) carrying no og: set and no scontent url, so it is
         * indistinguishable from "empty" by shape alone. Meta names the state itself in the React
         * route it ships for it, and facebookAgeGate reads that name rather than inferring the gate
         * from the missing tags — see its docstring for why the tempting inference is the same defect
         * shape as the false 🔒 this session already fixed on Instagram.
         */
        const gate = facebookAgeGate(page)
        if (gate) {
          count(env, 'fb', gate, client)
          if (report) report.reason = gate
        }
        /**
         * LAST RESORT FOR A SHARE CODE: ask what it resolves to, and try THAT permalink shape.
         *
         * WHY THIS IS A FALLBACK AND NOT THE FRONT DOOR. Routing every typed /share/{v|r|p}/ through
         * resolution would put paths that WORK TODAY behind a network hop that can miss — measured:
         * three other photo-post share codes render real cards through the two halves above, and a
         * share VIDEO ref muxes and plays. Placed here, it cannot run on any request that already
         * produces a card, and if resolution or routing fails it returns exactly today's answer.
         *
         * WHAT IT BUYS, and the evidence for it. Facebook redirects share codes to TWO different
         * permalink shapes: most land on /{owner}/posts/{id}, and some — including the reported
         * /share/p/Fixture04X — land on the legacy story.php form. Every code observed failing landed
         * on the legacy one, and every code observed working landed on the modern one. Both spellings
         * serve a complete og: set to a residential client, so the post is fine and the SHAPE is the
         * only measured difference. This makes us ask for the shape that answers us.
         *
         * IT IS A MOTIVATED BET, NOT A PROVEN CURE, and that is worth writing down: if Meta is gating
         * this post for datacenter IPs regardless of shape, this still fails — but it then fails with
         * a real permalink in the card and in /_prep instead of an opaque share code.
         *
         * THE ORIGINAL REF IS KEPT for the card. refKey(ref) is both the cache key and the /_media/
         * namespace, so re-keying a card mid-flight would strand its own media urls.
         */
        if (ref.kind === 'share') {
          // The DIRECT import, not the Deps entry: liveFetchPost takes no deps and every platform
          // fetcher around it is imported the same way. Tests for this layer stub global fetch, which
          // is how fetchBluesky, fetchTikTok and the rest are already exercised.
          let loc: string | null = null
          try {
            loc = await resolveMetaShare(ref.id)
          } catch {
            loc = null
          }
          const resolved = loc ? route(new URL(stripMetaTracking(loc), 'https://www.facebook.com')) : null
          if (resolved?.kind === 'post' && resolved.ref.p === 'fb') {
            const viaPermalink = await fetchFacebookPageUrl(fbPageUrl(resolved.ref))
            const recovered = facebookPostCard(viaPermalink, ref)
            if (recovered) {
              count(env, 'fb', 'fullpage_recovered', client)
              return recovered
            }
            // The resolved permalink is a real post url, so the plugin has something to render. This
            // is the arm that carries a pasted /share/{code} while the login wall stands.
            const sharePlugin = facebookPluginCard(
              await fetchFacebookPageUrl(fbPluginUrl(fbPageUrl(resolved.ref))), ref)
            if (sharePlugin) {
              count(env, 'fb', 'plugin_recovered', client)
              return sharePlugin
            }
            // The words-with-no-picture case again, on the RESOLVED permalink — the same last resort
            // the non-share branch takes, in the same position relative to the plugin. Without it a
            // pasted share code for a text post would be the one spelling that still fails.
            const shareCaption = facebookCaptionCard(viaPermalink, ref)
            if (shareCaption) {
              count(env, 'fb', 'caption_recovered', client)
              return shareCaption
            }
          }
        }
        count(env, 'fb', 'assert_fail', client)
        return null
      }
      return normalizeFacebook(meta, ref)
    }
    case 'lm': {
      // LEMMY — the one platform whose ref names the ORIGIN we fetch, so fetchLemmy re-guards the
      // host at the boundary (refkey.ts already shape-checked it) and refuses our own zone. It is
      // refuses our own zone.
      //
      // A private instance answers with a typed `instance_is_private` error, which is a real WALL and
      // is reported as such; every other error — couldnt_find_post, a removed post, a bad id — is the
      // generic "couldn't load", because Lemmy does not distinguish them in a way we can trust.
      //
      // `env` IS THREADED IN, `origin` IS NOT, and the asymmetry is deliberate. The own-zone refusal
      // reads a module-level list of the hosts this Worker is served from PLUS `env.OWN_HOSTS`, which
      // is how a self-hosted instance declares a domain this repo cannot know — env is already a
      // parameter here, so nothing new has to reach the fetcher and every existing .mjs stub is
      // untouched. The request's own origin is a different matter: threading it would make the guard
      // depend on a request field every stub would then have to supply, for a host the operator can
      // simply declare. `env.RESOLVE_HOST` rides the same object (see fedihost.ts clause 7).
      const got = await fetchLemmy(ref, { env })
      if (!got.ok) {
        count(env, 'lm', got.reason, client)
        if (got.reason === 'private' && report) report.reason = 'private'
        return null
      }
      // normalizeLemmy returns null for a removed/deleted post — Lemmy still serves a post_view for
      // those, with the body blanked, and rendering it would produce an empty card that reads as our
      // bug rather than as a moderator's decision.
      return normalizeLemmy(got.view, ref)
    }
    case 'ms': {
      /**
       * THE MASTODON-API FAMILY — Mastodon, Pleroma, Akkoma, GoToSocial, Pixelfed, all through ONE
       * unauthenticated `GET /api/v1/statuses/{id}`. Like 'lm' this ref names the ORIGIN, so
       * fetchMasto re-guards the host at the boundary via the shared fedihost.ts contract, taking
       * the same `{ env }` guard and no `origin`, for the reasons given above.
       *
       * A 404/410 IS COUNTED AS 'notfound' RATHER THAN AS A FETCH FAILURE. Mastodon answers
       * `Record not found` for a deleted status and for one that never existed alike, so they cannot
       * be told apart — 'notfound' is the honest name for both, and keeps a deleted post from
       * inflating the assert_fail counter that exists to catch upstreams changing shape.
       */
      const got = await fetchMasto(ref, { env })
      if (!got.ok) {
        count(env, 'ms', got.reason, client)
        return null
      }
      return normalizeMasto(got.status, ref)
    }
    case 'mk': {
      /**
       * THE MISSKEY FAMILY through `POST /api/notes/show`. Same origin-naming guard as 'lm' and
       * 'ms'. Two upstream errors are distinguished and both are WALLS rather than fetch failures:
       * `NO_SUCH_NOTE` is a deleted note, and `SIGNIN_REQUIRED` is an author-level privacy setting
       * that is reported as 'private', the same as a Lemmy private instance.
       */
      const got = await fetchMisskey(ref, { env })
      if (!got.ok) {
        count(env, 'mk', got.reason, client)
        if (got.reason === 'private' && report) report.reason = 'private'
        return null
      }
      return normalizeMisskey(got.note, ref)
    }
    case 'pt': {
      /**
       * PEERTUBE — one open `GET /api/v1/videos/{idOrUUID}` on the pasted instance, same
       * origin-naming guard as the other three fediverse platforms. NO CONTAINER: its `files[]`
       * carries real progressive mp4s that serve 206 video/mp4 to a Discordbot UA, so this keeps the
       * plain /_media/ 302 like Pinterest. A video with nothing inside the rendition ceilings, or a
       * live stream, degrades to its cover still rather than to a dead player.
       */
      const got = await fetchPeerTube(ref, { env })
      if (!got.ok) {
        count(env, 'pt', got.reason, client)
        return null
      }
      return normalizePeerTube(got.video, ref)
    }
    case 'pn': {
      // Pinterest: ONE unauthenticated, cookie-free call gated by a single header. Its video is a
      // real progressive mp4 that serves to a Discordbot UA, so it keeps the plain /_media/ 302 —
      // no byte proxy and no container, unlike Instagram, Twitch and the yt-dlp tier.
      const got = await fetchPinterest(ref)
      if (!got.ok) {
        count(env, 'pn', got.reason, client)
        return null
      }
      return normalizePinterest(got.pin, ref)
    }
    case 'tw': {
      // Twitch clips. ONE unauthenticated GraphQL call carries the metadata, the rendition list AND
      // the playback token, so there is no second hop between "what is this clip" and "how do I play
      // it" — which is why this platform needs no container and no stored credential.
      //
      // The only gate Twitch reports is the playback token's `authorization.forbidden`, which
      // fetchTwitchClip reads and maps to 'age_restricted' — a POSITIVE signal off Twitch's own
      // payload, not an inference from a missing rendition (the false-🔒 defect class).
      const got = await fetchTwitchClip(ref)
      if (!got.ok) {
        count(env, 'tw', got.reason, client)
        if (got.reason === 'age_restricted' && report) report.reason = 'age_restricted'
        return null
      }
      return normalizeTwitchClip(got.clip, ref)
    }
    case 'dm':
    case 'st': {
      // THE yt-dlp TIER — no platform fetcher at all: the card's metadata and the video both come
      // from the container (see platforms/ytdlp/normalize.ts). Grouped because they differ only in a
      // page-url template; the normalizers stay separate so each refuses a foreign ref by type.
      // `ctx` so the extract survives the response — see cachedMeta's waitUntil.
      /**
       * THE COUNTER MUST NOT BLAME THE UPSTREAM FOR OUR OWN BLOWN DEADLINE, and for years it did.
       *
       * docs/METRICS.md defines assert_fail as "the page didn't answer: upstream changed shape, blocked
       * mbedfx, or served a decoy", and tells the operator that a moving assert_fail/ok ratio means that
       * platform's upstream changed shape. A lost META_TIMEOUT_MS is none of those — the container is
       * still extracting, and it lands in R2 under waitUntil a moment later — yet it landed in the same
       * bucket, so the one signal that exists pointed at the wrong system. That is why the 2026-08-12
       * cold-path defect had to be found by an audit rather than by a counter.
       *
       * REPLACES assert_fail rather than stacking on it, which is `notfound`'s precedent on ms/mk/pt
       * ("counted here so a deleted post does not inflate assert_fail"). The route-level fetch_fail
       * still fires either way, so the total failure count is unchanged and only its attribution moves.
       */
      const mreport: MetaReport = {}
      /**
       * THE MUX SHORTCUT — the format urls this very extraction resolved, so the /_media/ mux does
       * not pay a second identical one. Empty unless the container answered THIS call (an R2 hit
       * carries none, deliberately), and empty is the behaviour that shipped: a `{page}` mux.
       */
      const mux: MuxShortcut = {}
      const meta = await cachedYtdlpMeta(ref, env, ctx, metaBudgetMs, mreport, mux)
      if (!meta) {
        count(env, ref.p, mreport.timedOut ? 'meta_timeout' : 'assert_fail', client)
        return null
      }
      return ref.p === 'dm' ? normalizeDailymotion(meta, ref, mux) : normalizeStreamable(meta, ref, mux)
    }
    case 'im': {
      /**
       * IMGUR'S OWN API FIRST — it is the only source that can answer for an album or a still photo
       * (yt-dlp refuses both; see platforms/imgur/fetch.ts) and it carries an uploader name the
       * container never reported.
       *
       * THE CONTAINER IS KEPT AS A FALLBACK, and only for a single. Imgur's API needs a client id and
       * meters it (12,500/day), so an exhausted or revoked key would otherwise take the whole platform
       * down — where before this change a .gifv link worked with no key at all. Falling back means the
       * worst case is exactly the behaviour that shipped before albums existed. An album has no such
       * fallback because there was never a container path that could produce one.
       */
      const got = await fetchImgur(ref, env)
      if (got.ok) {
        const post = normalizeImgurApi(got.post, ref)
        if (post) return post
      }
      if (ref.kind !== 'post') {
        count(env, 'im', 'assert_fail', client)
        return null
      }
      // The SAME attribution split the dm/st arm documents at length — Imgur reaches this arm only when
      // its own API missed, so from here on the container is its whole card too.
      const mreport: MetaReport = {}
      // The shortcut, exactly as the dm/st arm above documents it. Only this CONTAINER fallback gets
      // one — normalizeImgurApi's post came from Imgur's own API, which resolves no format urls.
      const mux: MuxShortcut = {}
      const meta = await cachedYtdlpMeta(ref, env, ctx, metaBudgetMs, mreport, mux)
      if (!meta) {
        count(env, 'im', mreport.timedOut ? 'meta_timeout' : 'assert_fail', client)
        return null
      }
      return normalizeImgur(meta, ref, mux)
    }
    default:
      // Unreachable for a router-minted ref (every platform in the union dispatches above), but a ref can also
      // arrive from an unvalidated cache entry: null, not a throw, is this file's rule for a shape it
      // does not recognize.
      return null
  }
}

/**
 * Resolve a /t/{code} short link. Three answers — see ShortlinkResolution for why two was wrong.
 *
 * ONE fetch, not two: the redirect and the payload arrive in the same response.
 *
 * THE COUNTERS, IN ORDER OF WHO IS BROKEN. assert_fail (counted here) means WE are: the page did
 * not arrive at all — a 429, a block shell, a renamed blob, a truncated body. shortlinkOutcome()
 * is the classifier that decides that, and it is deliberately NOT pageOutcome: on this path a
 * page carrying no video-detail scope is the TikTok HOMEPAGE, which is where every non-TikTok
 * code lands (verified 2026-07-18 on a dead code AND on a real THREADS code), so reusing
 * pageOutcome would file every pasted Threads link as "TikTok changed and we are blind". Read its
 * comment before touching this line.
 *
 * THE REF COMES FROM THE PAYLOAD. tiktokRefFrom reads itemStruct.id, so the Post that comes back
 * carries the CANONICAL numeric id — never the short code, and never an id parsed out of the
 * resolved URL (which carries a `?_r=1&_t=…` session tail). That is what makes every /_media/ URL
 * a renderer mints from post.ref shared with the long-form permalink for free.
 */
export async function liveResolveShortlink(
  p: 'tt', code: string, env: Env, client: ClientClass,
): Promise<ShortlinkResolution> {
  // Narrowing, not defensiveness: the Route type pins p to 'tt' today, and the day a second
  // platform mints a short form this line is where its resolver goes.
  if (p !== 'tt') return { kind: 'unresolved' }
  const got = await resolveTikTokShortlink(code)
  if (!got.ok) {
    count(env, 'tt', got.reason, client)
    return { kind: 'unresolved' }
  }
  /**
   * THE GATE, CHECKED BEFORE gone/unresolved — the fix for the /t/{code} inconsistency confirmed
   * live 2026-07-21 (statusCode 10222 author_secret rendered the generic red failure by short link
   * while its permalink showed 🔒). A gated post carries a video-detail scope but no usable
   * itemStruct, so tiktokRefFrom folds it to null and it would otherwise become {kind:'gone'} and the
   * generic embed — the SAME wall the permalink path already reports through liveFetchPost/tiktokGate.
   *
   * ORDER IS THE FALSE-POSITIVE GUARD. tiktokGate returns undefined for the homepage (no scope, so a
   * non-TikTok/Threads code still reaches the 'unresolved' chooser below) and for a genuinely DELETED
   * post (statusCode 10204 with statusMsg "item doesn't exist" — see tiktokGate: the 10204 code is
   * SHARED with a friends-only post and is disambiguated by statusMsg, so deletion falls through while
   * friends-only 'status_friend_see' reports 'private'), so checking-gate-first is a no-regression
   * insert: a deleted short link still falls through to {kind:'gone'} and the generic failure. Counted
   * here, exactly as the permalink path counts inside liveFetchPost; the route stacks fetch_fail on top
   * (no double-count).
   */
  const gate = tiktokGate(got.html)
  if (gate) {
    count(env, 'tt', gate, client)
    return { kind: 'gated', reason: gate }
  }
  // Scope absent -> the homepage -> not a TikTok post. Deliberately NOT counted as assert_fail:
  // this is the resolver working correctly, and counting it would swamp the signal that TikTok
  // changed. The caller counts it as a tt-attributed 'ambiguous', because it cost a fetch.
  if (!videoDetailScope(got.html)) return { kind: 'unresolved' }
  // Past this line the page IS a TikTok video-detail page, which is positive proof the code is
  // TikTok's. Every remaining no — statusCode 10204, a missing itemStruct, an id that is not a
  // string of digits, a payload the normalizer rejects — means the POST is not there, which is a
  // fetch_fail and never a reason to go on offering Threads as a candidate.
  const ref = tiktokRefFrom(got.html)
  if (!ref) return { kind: 'gone' }
  const post = normalizeTikTok(got.html, ref)
  // The same one-hop resolution the permalink path does, for the same reason — and it has to be
  // here too, because this branch builds its own Post from its own fetcher and never passes
  // through liveFetchPost. Resolving in only one of the two would make ONE post render two
  // different cards depending on which URL shape somebody pasted, which is the failure the
  // canonical cache-key write exists to prevent, reappearing one layer up.
  return post ? { kind: 'post', post: await withResolvedVideo(post) } : { kind: 'gone' }
}

/**
 * Resolve a Reddit /s/ share link to a post ref + canonical. resolveRedditShareUrl does the single
 * network hop (the 301's Location); we re-route that permalink through route() to REUSE all of the
 * permalink parsing and canonical construction — and, as a safety net, to reject a Location that is
 * not a Reddit post, so a share code we cannot resolve never becomes some other platform's ref. The
 * post itself is fetched later by the ordinary reddit path (fetchReddit -> embed.reddit.com), so the
 * share link and a pasted permalink converge on ONE cache entry and render byte-identically.
 */
export async function liveResolveRedditShare(
  shareUrl: string, _env: Env,
): Promise<{ ref: Extract<PostRef, { p: 'rd' }>; canonical: string } | null> {
  const loc = await resolveRedditShareUrl(shareUrl)
  if (!loc) return null
  let resolved: Route
  try {
    resolved = route(new URL(loc, shareUrl))
  } catch {
    return null
  }
  if (resolved.kind !== 'post' || resolved.ref.p !== 'rd') return null
  return { ref: resolved.ref, canonical: resolved.canonical }
}

/**
 * Cache-read-through by REF: the ordinary path, where the ref IS the post's identity and the
 * cache key is derived from it. Returns the post plus whether it came from cache — the media
 * counter needs that bit — plus `failReason`, the one detail a null hides that the post route
 * renders distinctly.
 *
 * `report` is captured in this closure and read AFTER loadPost resolves, exactly as the shortlink
 * route captures its `seen` ShortlinkResolution: loadPost's contract is `Post | null` (it caches
 * the Post), so the richer failure reason must ride a closure rather than the return. On a cache
 * HIT the loader never runs and `report.reason` stays undefined — correct, a hit is a success; a
 * failure is never cached. A thrown fetch leaves it undefined too, degrading to the generic failure.
 *
 * `metaBudgetMs` IS THE ONE THING THIS FUNCTION CANNOT DERIVE, which is why it is passed rather than
 * read from a constant. Every other budget in this file is `ceiling - elapsed`, computed by the route
 * that owns the ceiling; this one was a single module constant shaped by the CRAWLER's and spent
 * unchanged on /_card and /_api/v1, which have their own and a bigger one. Omitted means the crawler's.
 */
function getPost(
  ref: PostRef, d: Deps, env: Env, client: ClientClass, ctx: ExecutionContext, metaBudgetMs?: number,
): Promise<{ post: Post | null; cached: boolean; failReason?: GateReason }> {
  const report: FetchReport = {}
  // `ctx` rides through to the fetchers whose upstream is the container (fb, dm/st/im), which need it
  // to keep a slow extract alive past the response — see cachedMeta. REQUIRED here, not optional: all
  // three call sites are in this file and every one of them has a ctx, so there is no reason to let a
  // future fourth one silently drop it. It stays optional at the Deps/liveFetchPost boundary, which is
  // the injected, .mjs-stubbed one.
  return loadPost(postCacheKey(ref), () => d.fetchPost(ref, env, client, report, ctx, metaBudgetMs), d)
    .then(r => ({ post: r.post ? withResolver(r.post, env) : null, cached: r.cached, failReason: report.reason }))
}

/**
 * The single point where the video-playback binding decides how a `remux` video renders. With the
 * MEDIA_RESOLVER + MEDIA_CACHE bindings present, remux videos are kept and the /_media/ route serves
 * their muxed MP4; without them (a Worker deployed with no container), each remux video degrades to
 * its poster STILL — the same cover-frame the DASH/HLS platforms showed before playback existed, and
 * never a dead player. Applied here so every post route and every /_media/ hit agree on the same
 * decision from the same cache entry. A direct-video platform (Twitter/TikTok/Instagram) carries no
 * `remux`, so this is a no-op for it.
 */
function withResolver(post: Post, env: Env): Post {
  if (env.MEDIA_RESOLVER && env.MEDIA_CACHE) return post
  // Defensive: the input is the cache, not the normalizer — media[] can be corrupt (a hole, a
  // primitive), and this route has no try/catch. `m && m.remux` never dereferences a null entry.
  const list: readonly Media[] = Array.isArray(post.media) ? post.media : []
  if (!list.some(m => m && m.remux)) return post
  // NO `posterOnly` HERE, and that is the one intended difference from settleMux's degrade (which
  // documents it at length). This rewrite is applied inside getPost, so the /_media/ ROUTE sees the
  // identical entry: the bare `{i}` already resolves through pickMedia to this entry's `url`, i.e. the
  // poster — pinned by test/media-resolver.test.mjs's "resolver absent … 302 to the thumbnail". And
  // this shape DROPS `poster`, so flagging it would send pickMedia's poster branch (no fallback to
  // m.url) looking for a field that is not there: a 404 on every no-container deploy. settleMux's
  // degrade is invisible to that route — a degraded card is not response-cached, so the route
  // re-derives the original remux video — which is exactly why it needs the flag and this does not.
  // posterW/posterH, not w/h — the SAME correction settleMux's degrade carries, for the same reason:
  // this entry becomes an IMAGE, and mastodon.ts omits meta.original when the size is unknown, which
  // Discord renders as no picture at all. A remux video's own w/h are deliberately 0. See Media.posterW.
  const media = list
    .map((m): Media | null => (m && m.remux
      ? (m.poster ? { kind: 'image', url: m.poster, w: m.posterW ?? m.w, h: m.posterH ?? m.h } : null)
      : m))
    .filter((m): m is Media => m != null)
  return { ...post, media }
}

/**
 * Serve a remux video: the muxed MP4 from R2 if it is already there, else mux it via the
 * media-resolver container (streaming the container's response straight into R2), then serve. Every
 * video is muxed at MOST once. Range-capable, so Discord/Telegram scrubbing works. `source` and the
 * bindings are re-checked though withResolver only keeps a remux video when they are present.
 *
 * A FAILURE RETURNS 503 no-store — IT MUST NOT REDIRECT TO THE POSTER, and that reversal is the fix for
 * the defect this route caused (diagnosed 2026-07-24). This is the url `og:video` points at, i.e. the one
 * Discord's media proxy fetches AND CACHES. The old "degrade to the poster still, never a dead player"
 * fallback answered it with a 302 that ended at `content-type: image/jpeg` — so the proxy cached "this
 * video is an image", and every later view rendered a static frame that could never play, even once the
 * mux had long since finished. That is exactly the reported "won't play past the first frame", and it was
 * self-inflicted and STICKY: re-pasting the link could not clear it, because the poisoned entry is keyed
 * by the media url, which does not change. The card's still frame comes from og:image / the attachment's
 * preview_url (the separate `poster{N}` path), so answering the VIDEO url with an image bought nothing.
 * 503 + no-store is the honest answer: Discord draws the card with no inline player and caches nothing,
 * and the next fetch — after settleMux/prewarm has finished the work — plays.
 */
/**
 * NEVER AN IMAGE ON A VIDEO URL, and now ONE spelling of that rule for BOTH ways we serve video (the
 * container mux and the direct CDN pass-through added 2026-07-25). 503 + no-store: Discord draws the
 * card with no inline player and caches nothing, and the next fetch plays. See serveMuxed above for
 * the poisoned-url defect this reverses — two copies of "the video url must never become an image"
 * would be two places for one of them to drift, and that drift IS the defect.
 */
const notReady = () => new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } })

async function serveMuxed(
  req: Request, env: Env, ctx: ExecutionContext, ref: PostRef, index: number, source: Media['remux'],
): Promise<Response> {
  const { MEDIA_RESOLVER: resolver, MEDIA_CACHE: cache } = env
  if (!resolver || !cache || !source) return notReady()

  // NO GENERATION SEGMENT, unlike metaCacheKey, and that is not an oversight: an mp4 keyed by ref and
  // index cannot go stale the way a record can, and re-muxing every video on a bump would be the most
  // expensive no-op in the codebase. The consequence is worth stating plainly because two analyses of
  // the generation churn got it backwards — no bump has ever cost a muxed video or forced a re-mux.
  // Everything a bump discards is metadata. See META_GENERATION.
  const key = `mux/${refKey(ref)}/${index}`
  // EVERYTHING here degrades, never 500s: this route has the same total-failure contract as pickMedia,
  // but its work (an R2 read, a container call, an R2 write) can throw for reasons a corrupt-cache guard
  // cannot — R2 unavailable, the container down, a stream with no known length.
  try {
    // muxOnce, not ensureMuxed: a cold video is asked for by the prewarm and both settleMux calls
    // within ~2s of one paste, and three concurrent downloads of one video is the bandwidth that
    // decides whether the card gets a player. The slot key is the POST, so this call and the meta
    // call for the same ref land on one already-booted instance.
    /**
     * THE ONLY DURABLE MUX PATH BLUESKY AND REDDIT HAVE, which is why the alarm is armed HERE and not
     * only in settleMux.
     *
     * settleMux returns before its arming loop for any post with no `{page}` remux, and prewarmable()
     * answers null for `bs`/`rd` — so those two platforms had ZERO alarm coverage. Their single mux
     * attempt is this line, running inside Discord's media-proxy request; when that request is
     * cancelled the container's `finally: os.remove(out)` discards every byte and the next paste
     * starts again from zero. Not slow — never, on repeat, forever.
     *
     * ARMED BEFORE THE AWAIT, for settleMux's reason: a request can be cancelled at any point after
     * this line, so arming afterwards would skip exactly the slow videos the alarm exists for.
     *
     * NOT RESTRICTED TO bs/rd. A `{page}` platform reaches this route cold too — a degraded card is
     * not response-cached, so /_media/{ref}/{i} re-derives the remux entry and retries — and the DO is
     * addressed by the mux key, so a second arming for a video settleMux already armed is a no-op.
     * A warm range request pays one cheap DO wake that finds the R2 head and deletes itself.
     */
    ctx.waitUntil(scheduleMux(env, key, refKey(ref), source))
    // `.catch(() => null)` for waitUntil only — handing the runtime a rejecting promise is not the
    // same as keeping the work alive. The awaited `work` is the UNcaught one, so a throw still reaches
    // the console.error below rather than being swallowed into an indistinguishable 503.
    const work = muxOnce(env, key, source, refKey(ref), jarPlatform(ref))
    ctx.waitUntil(work.catch(() => null))
    const head = await work
    if (!head) return notReady()
    return await r2Range(cache, key, head.size, req.headers.get('range'))
  } catch (err) {
    // key holds the ref, never the source url; err carries no url either — safe to log (privacy).
    console.error('serveMuxed could not serve', key, err instanceof Error ? err.message : String(err))
    return notReady()
  }
}

/**
 * CONTAINER INSTANCES ARE A CAPPED, SHARED RESOURCE — pool onto a few, never one per video.
 *
 * THE DEFECT (found 2026-07-24, and the biggest cause of "the video doesn't play"): both call sites used
 * a per-item instance name (`mux/{ref}/{i}`, `meta/{ref}`), so EVERY distinct video woke its own container
 * instance. wrangler caps that (`max_instances`) and an instance lingered ~10min (`sleepAfter` was 10m then; it
 * is 5m now, for reasons of cost argued at the field itself), so after a
 * handful of different videos in ten minutes EVERY mux failed with "Maximum number of running container
 * instances exceeded" — which the route then degraded, silently, into a video-less card. The per-item name
 * bought nothing: `container/server.py` is a ThreadingHTTPServer, so ONE instance serves many muxes
 * concurrently, and "mux at most once" is enforced by the R2 head check, not by instance identity.
 *
 * A stable hash keeps a given video on a given slot (so duplicate in-flight requests for the SAME video
 * land on the same instance and share its work), while the slot count stays under the configured cap.
 *
 * HASHED ON THE POST, NOT ON THE OPERATION (fixed 2026-07-25). Both call sites used to hash their own
 * OPERATION key — `meta/{ref}` for the Facebook metadata call, `mux/{ref}/{i}` for the video — which sent
 * one post's two container calls to DIFFERENT instances 74% of the time (measured over 2000 synthetic
 * refs; the reported fb:share:Fixture03X hashed to slot 0 for meta and slot 2 for mux). A Facebook post
 * needs BOTH calls, so it could pay two cold container boots back to back on the one path where latency
 * is a correctness issue — Discord gives up and the card degrades. Hashing the REF keeps a post's meta
 * call and its mux on one instance: the second call finds it already booted. This is also what the
 * pooling comment above always claimed ("keeps a given video on a given slot").
 */
const RESOLVER_SLOTS = 4
/**
 * THE GENERATION LOG — shared history for the TWO constants below (`RESOLVER_GENERATION` at the end of
 * it, `META_GENERATION` beside it). Every entry from g3 to g13 was a bump of ONE string doing both
 * jobs; the split happened after g13, and this log is what both of them inherit.
 *
 * WHY THE STRING EXISTS AT ALL. Pooling gave instances STABLE names, and a container instance keeps
 * running the image it started with until it idles out (`sleepAfter`) — so with steady traffic a
 * redeploy never takes effect: the 20-min duration cap shipped and every mux kept enforcing the old
 * 10-min one, because the four pooled instances were still the previous build. (The per-key naming this
 * replaced hid the problem — a new video meant a new name meant a new instance on the new image.)
 * Changing the string changes the instance names, which forces the new image in immediately. It was
 * also the meta cache's generation, so a persisted container answer was retired by the same switch
 * that retired the instance that produced it.
 *
 * WHEN TO BUMP WHICH, now that there are two:
 *
 *   RESOLVER_GENERATION — to EVICT CONTAINER INSTANCES. An outage, a bad image, a warm pool still
 *     serving code that has been fixed for ten minutes (that is g13, below). Costs nothing but a cold
 *     boot on the next call.
 *   META_GENERATION — when the SHAPE or MEANING of a STORED RECORD changed, i.e. when a record already
 *     in R2 would now say something WRONG or be read wrong. Costs up to YT_META_TTL_MS (30 days) of
 *     dates, descriptions, durations, counts and gate verdicts across yt, fb, dm, st and im.
 *
 * THE TEST IS WHAT A STALE RECORD WOULD SAY, NOT WHETHER container/ WAS TOUCHED. The old rule here was
 * "bump whenever container/ changes behaviour", which is input-shaped: it fires on container changes
 * that leave every record correct (see the two "no bump" notes below, both of which had to argue their
 * way out of it) and it says nothing about a change that corrupts records without touching container/ —
 * which is now possible, because the Innertube rung writes the same records and lives in src/. Ask
 * instead: if a record written yesterday is read tomorrow, does it say something false? Bump on yes.
 *
 * AND THE SPLIT MAKES UNDER-INVALIDATION EXPRESSIBLE FOR THE FIRST TIME, which is the worse direction.
 * Before it, forgetting to bump for a record change was impossible as long as you bumped for the
 * container change beside it; now the two can be forgotten separately, and the failure is silent — a
 * wrong value served for 30 days from every colo, unfixable by re-pasting, with a correct deploy live.
 * Over-invalidating costs a container call and heals; under-invalidating costs a month. When it is
 * genuinely unclear, bump META_GENERATION.
 *
 * g3 (2026-07-25): _meta_page returns width/height/uploader_id/uploader_url/description/timestamp.
 * g4 (2026-07-25): _meta_page's width/height fallback prefers the tallest format at or under 720, so the
 *   dimensions describe the format _mux_page's own `height<=?720` selector will pick rather than the
 *   tallest one in the manifest.
 *
 * (no bump, 2026-07-26): YouTube's upload date needed NONE, and the reason is the rule itself — this
 *   switch is about container BEHAVIOUR changing, and container/server.py was untouched by that work:
 *   _meta_page has returned `timestamp` since g3 and is platform-agnostic (it runs `yt-dlp -J` on
 *   whatever page it is given). Bumping for it would have retired four warm instances and invalidated
 *   every Facebook meta object for nothing. Recorded because "a new platform reads the container" is
 *   exactly the change a reader expects to see a bump beside.
 *
 * g5 (2026-07-26): TWO container changes, both in container/server.py, both real behaviour. (1)
 *   _mux_page's match filter is `duration<?1200 & !is_live` instead of `duration < 1200 & duration >
 *   0` — the old lower bound SILENTLY excluded every source declaring no duration, which is a class
 *   rather than an edge case (an Imgur gifv reports duration=None and was skipped outright), and
 *   `!is_live` replaces the livestream rejection that bound was providing by accident. (2) _meta_page
 *   returns `_type`, the only field that tells a video from a PLAYLIST — an Imgur album passes the
 *   "title is non-empty" content assertion carrying a title and nothing else. Because this string is
 *   also the meta-cache generation, the bump additionally discards every pre-g5 R2 record.
 */
// g6 (2026-07-30): _meta_page gained `age_limit` and --ignore-no-formats-error. A pooled instance
// keeps running the image it booted with until sleepAfter, so without this bump the new field
// stays undefined and age-gated videos keep rendering 1 January 1970 with no explanation.
// g6 -> g7, 2026-08-01. NOT because the container's dict changed — it did not; `description` has been
// in _meta_page all along — but because the STORED RECORD SHAPE did. ytMetaValid correctly does not
// require the new field, so every warm g6 record would keep serving a date with no description for up
// to YT_META_TTL_MS (30 days). The generation is the documented single invalidation switch.
//
// g7 -> g8, 2026-08-01. The value in use, and it was missing from this log — which is the one defect
// a generation history can have, because the log IS the record of why each bump happened and a gap in
// it reads as "nobody knows". Same reason as g7 and worth restating rather than cross-referencing:
// _meta_page began returning view_count/like_count/comment_count, so the STORED SHAPE changed again.
// A warm g7 record has no counts, and a missing count is indistinguishable from a post that genuinely
// has none — so the card would quietly show nothing for up to 30 days rather than visibly failing.
// g8 -> g9, 2026-08-03. _meta_page's dict is unchanged; the STORED SHAPE gained `duration`, which the
// worker now reads to skip a mux the container would refuse. A warm g8 record has no duration, so a
// 25-minute video would keep paying a full deadline to be told no — the exact cost this bump exists to
// stop. Same reasoning as g7 and g8: the generation is the one documented invalidation switch.
// g9 -> g10, 2026-08-03. THE FIRST BUMP THAT IS ABOUT THE INPUT RATHER THAN THE OUTPUT, and it is the
// whole point of the change rather than housekeeping beside it. container/server.py now accepts a
// `cookies` jar and the Worker sends one for yt (and ig on the mux), so the SAME id can answer
// differently than it did an hour ago — an age-gated video that returned `age_limit: 18, formats: 0`
// cookie-free resolves once a pool is filled. Every warm record and every negative-cache note was
// produced WITHOUT a jar, and both would otherwise outlive the thing that made them true:
//   - a g9 meta record says "gated" for up to YT_META_TTL_MS (30 days), so the card would keep the 🔞
//     note and keep refusing to play a video the credential now reaches, on every colo, unfixable by
//     re-pasting;
//   - and the negative cache ("a failing id is not a free container trigger") would refuse the retry
//     that would have discovered the difference.
// Retiring the instances is the smaller half here — filling a secret must not require also knowing
// that a stale answer has to be waited out. Same rule as g7/g8: the generation is the ONE documented
// invalidation switch, and this is the change it exists for.
//
// STILL g10 AFTER 2026-08-03's `jarred` FIELD, and the exception is deliberate enough to be written
// down, because every previous stored-shape change in this log bumped. g10 fixed the records written
// before the cookie CODE; it left a hole it could not reach — the records written after that deploy and
// before an operator fills YT_ACCOUNTS. Those ARE g10 records, so no g11 retires them either, and the
// gap is not a moment but every day until fill-day. Bumping on fill-day was the obvious answer and is
// the wrong one twice over: it makes an operator's `wrangler secret put` depend on somebody merging a
// deploy the same day, and it throws away 30 days of perfectly good dates, descriptions and counts for
// every ungated video to correct the gated few. So the invalidation is CONDITIONAL instead, carried in
// the record itself — see the `jarred` field and ytMetaUsable. The properties that make that safe: a
// deployment with no pool invalidates NOTHING (so this change is free to merge, and free for every fork
// that will never set a secret), an absent `jarred` on an older record reads as "not logged in", which
// is exactly what it was, and a gated record that DID carry a jar is kept. Rotating a dead pool is the
// case this does not cover, and that one still wants a bump.
// STILL g10 IN 1.9.0 EVEN THOUGH container/server.py's OUTPUT DICT CHANGED, which was a departure
// from the rule at the top of this log AS IT STOOD THEN ("bump whenever container/ changes
// behaviour"). Written down because a reader who finds an unbumped generation next to a container
// change is right to assume it was forgotten. The output-shaped rule the header carries today is the
// one this note and the paragraph below argued their way to.
//
// The rule exists for two things, and this change needs neither. It retires STALE RECORDS — and there
// are none, because the defect being fixed (`timestamp: null`) made the worker write nothing at all,
// and every record already in R2 carries a valid timestamp that stays correct. And it retires WARM
// INSTANCES still running the old image, which Cloudflare's own gradual container rollout now does on
// deploy anyway; the window is minutes, and a call landing on an old instance during it costs one
// wasted container call that is not cached and heals on the next view.
//
// The cost of bumping is real and one-directional: it discards up to 30 days of good dates,
// descriptions and counts across yt, fb, dm, st and im to shorten a few minutes of ambiguity. If a
// future container change persists a WRONG value rather than no value, that trade flips and it must
// bump — the test is what a stale record would say, not whether container/ was touched.
//
// g10 -> g11, 2026-08-18. THIS ONE MEETS THE TEST THAT PARAGRAPH SETS: the stale records say something
// WRONG, not merely something old. container/server.py now asks YouTube with an explicit player-client
// list (`web_embedded,tv_simply,mweb`) because the pinned yt-dlp's default client started getting HTTP
// 403 from googlevideo — see YT_PLAYER_CLIENTS there for the measurements.
//
// A DIFFERENT CLIENT RETURNS A DIFFERENT FORMAT LADDER, and g4 exists precisely so that the width and
// height on a record describe the format `_mux_page`'s selector will actually pick. Every g10 YouTube
// record was written from the OLD client's ladder — and written during an outage in which no format
// was downloadable at all — so those dimensions describe a format that either cannot be fetched or is
// not the one the new client selects. A card sized from them advertises a shape nobody will deliver,
// which is the disagreement g4 was added to end rather than a few minutes of ambiguity.
//
// It costs the usual 30 days of good dates and counts on the other four platforms, and that is the
// right trade here rather than the wrong one: the alternative is leaving YouTube cards sized by a
// broken generation for up to YT_META_TTL_MS (30 days) after the fix ships, which is most of the way
// to the fix not having shipped.
//
// CORRECTION, 2026-08-29: that argument was about a field YouTube RECORDS DO NOT HAVE. `type
// YouTubeMeta` has never carried w/h — it is timestamp, duration, isLive, ageLimit, jarred,
// description, views, likes, replies — so no yt record was ever "sized by a broken generation". Width
// and height live only on the yt-dlp tier's record (fb, dm, st, im), and a YouTube player-client list
// cannot change what `-J` reports for a Facebook or Dailymotion page. So the bump discarded exactly
// the records the change could not have made wrong, and found nothing to discard on the platform it
// was about. Kept rather than rewritten, because a log entry that quietly becomes correct in
// hindsight teaches nobody: this is one of the two bumps that bought YouTube nothing while throwing
// away a month of its dates, and the split below exists because of it.
//
// g12 -> g13, 2026-08-28. NOT FOR THE USUAL REASON — the records are fine. This bump is being spent on
// the OTHER thing the generation string does, which the paragraph above about instance names only
// mentions in passing: it names the Durable Objects, so changing it forces brand-new instances.
//
// THE OTHER OF THE TWO, and this one says so in its own words. "The records are fine" is precisely
// the case that must now bump RESOLVER_GENERATION and leave META_GENERATION where it is; in g13 the
// two were one string, so ending a container outage cost every stored date, description, duration,
// count and gate verdict on five platforms — 40 hours after #64 shipped the Innertube corpus that was
// meant to make YouTube dates reliable. Production reads "9/10 correct on first paste" instead of
// ~100% on anything seen before because of this line.
//
// WHAT HAPPENED. 1.11.0 shipped a container whose `do_GET`/`do_POST` had stopped being methods of the
// Handler class (a patch spliced module-level functions into the class body), so BaseHTTPRequestHandler
// answered EVERY request with 501 "Unsupported method". The repair deployed as container image version
// 120, sha256:3be632b0 — and production stayed broken anyway, because a pooled instance keeps running
// the image it booted with until it idles out, and `sleepAfter` is 5m that ANY request resets. Under
// live traffic the seven broken instances were being kept alive by the very requests they were
// failing. Six minutes of deliberate quiet did not clear it; `/_media/` still answered 503 and the
// probe still answered 501, on an image that had been correct for ten minutes.
//
// THE COST IS PAID TO END AN OUTAGE RATHER THAN TO AVOID A WRONG RECORD, which is a use this constant
// has not been put to before and is worth naming so the next reader does not think the records were
// suspect. If this recurs, the cheaper permanent answer is a shorter `sleepAfter` (see
// src/container.ts, which already argues 3m is available), not another bump.
/**
 * THE CONTAINER-INSTANCE HALF. It names the Durable Objects (`resolver-{gen}-{slot}`) and nothing
 * else. Bumping it costs one cold boot per slot and invalidates NOTHING that is stored.
 *
 * SPLIT FROM META_GENERATION 2026-08-29 — see it for the measurement that forced the split.
 *
 * g13 -> g14, 2026-08-30, AND IT IS THE SAME USE AS THE 2026-08-28 BUMP ABOVE: ending a stale-image
 * state, not invalidating a record. Every record is fine.
 *
 * WHAT WAS OBSERVED. 1.12.3 added one field to the container's TikTok probe (`hdrs`) precisely so the
 * running image could be identified from outside. After that deploy: the build log shows the image
 * built and pushed (`sha256:8a921a43248a`, 19:13:39), the application reports version 125 on that
 * digest, the rollout reports `completed` with 7/7 instances and zero errors, and the instance census
 * reports ALL TWELVE on that digest — and `/_clients` still answered without `hdrs`, i.e. still ran
 * 1.12.2's code. Not a response cache: a cache-busted request took 19s and did the real work.
 *
 * SEVEN MINUTES OF DELIBERATE QUIET DID NOT CLEAR IT, which is the same result the 2026-08-28 note
 * records for six. Take that pairing as the standing lesson rather than a coincidence: idling is not
 * a reliable way to cycle these instances, the platform's own instance census reports the DESIRED
 * image rather than the running one, and this constant is the only lever measured to work.
 *
 * THE MARKER FIELD IS THE PART WORTH COPYING. Without `hdrs` the stale image was indistinguishable
 * from a platform gate — the probe's `fetch: http-403` reads exactly like the `*-webapp-prime` cookie
 * wall — and the wrong conclusion was one step away. Ship a shape marker with any container change
 * whose result you intend to act on.
 */
const RESOLVER_GENERATION = 'g14'
/**
 * THE STORED-RECORD HALF, pinned at the value the shared string had when it split, so the split
 * itself invalidates nothing. Read by metaCacheKey and by nothing else.
 *
 * WHY THIS IS A SECOND CONSTANT. One string named the container instances AND scoped every meta
 * record, so every bump aimed at a bad instance also threw away every cached date, description, view
 * count, duration and age verdict on yt, fb, dm, st and im. Thirteen generations in 34 days, 2026-07-25
 * g3 through 2026-08-28 g13. The five since the 1.0.0 squash are the ones git can still show —
 * `git log -G"RESOLVER_GENERATION = 'g" --date=short -- src/worker.ts` — and the gaps between them, in
 * days, are 1.0, 0.3, 15.4, 4.3, 5.9, against a YT_META_TTL_MS of 30 days that has NEVER ONCE BEEN
 * REACHED. The TTL is a fiction: the real expiry was the generation, and it was set by container
 * incidents.
 *
 * Two of those five bought YouTube nothing at all, and both are annotated in the log above — g11's
 * stated reason was stored width/height that `type YouTubeMeta` has never had, and g13 says in its
 * own comment that the records were fine.
 *
 * PLAYBACK HAS NEVER BEEN AFFECTED BY A BUMP, ONLY METADATA — worth writing down because two separate
 * analyses got it backwards. The muxed MP4 lives at `mux/{refKey}/{index}` (serveMuxed, scheduleMux,
 * settleMux, the prewarm), which carries NO generation segment. A bump cannot orphan a muxed video,
 * cannot make one re-mux, and cannot cost a single byte of R2 egress on the video path. Everything a
 * bump has ever discarded is `meta/{gen}/{refKey}.json`.
 *
 * WHEN TO BUMP: when the SHAPE or MEANING of a stored record changed — see the rule at the head of
 * the log above, and note that the direction to fear is now UNDER-invalidation.
 */
export const META_GENERATION = 'g13'
/** `slotKey` is the POST (refKey), never the operation — see RESOLVER_SLOTS for the 74% measurement. */
/**
 * TIKTOK'S AWEME REDIRECT, FOLLOWED BY THE CONTAINER INSTEAD OF BY US.
 *
 * Returns undefined when there is no container binding, which is the same shape every other
 * container caller uses and keeps `withResolvedVideo` a pure two-argument function in the tests that
 * drive it with no bindings at all.
 *
 * WHY IT IS NOT A PLAIN fetch(): see withResolvedVideo's `viaContainer` docstring. The short version
 * is that Cloudflare WORKER egress gets a 404 HTML page from `/aweme/v1/play/` — reproduced against
 * fxTikTok's own Worker, so it is the platform and not us — while the container reaches TikTok in
 * under three seconds (`/_clients` TikTok arm, production, 2026-08-30).
 *
 * TOTAL BY CONSTRUCTION. Every failure returns null and `withResolvedVideo` then keeps the aweme url,
 * i.e. exactly today's behaviour. This call must never be able to fail a card: the tt arm has no
 * try/catch around it, so an escaping throw here is an uncaught 500 on a public path.
 *
 * THE HOST IS RE-CHECKED ON THIS SIDE even though the container checks its own output. A Location is
 * attacker-influenced, the container is a separate program that can change independently, and the
 * value goes on to become og:video — so the rule that produced today's url is applied to tomorrow's
 * too, in the file that ships it.
 */
function awemeViaContainer(env: Env, ref: PostRef): AwemeResolver | undefined {
  const resolver = env.MEDIA_RESOLVER
  if (!resolver) return undefined
  return async (url: string) => {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
      const r = await resolverStub(resolver, refKey(ref)).fetch('http://media-resolver/resolve', {
        method: 'POST', body: JSON.stringify({ redirect: url, ua: TIKTOK_UA }), headers,
      })
      if (!r.ok) return null
      const j = await r.json() as Record<string, unknown>
      const loc = typeof j?.location === 'string' ? j.location : ''
      if (!loc) return null
      const u = new URL(loc)
      // The same three refusals resolveAwemeUrl applies to its own answer, for the same reasons:
      // https only (this becomes og:video), a CDN host we recognise, and never another aweme url —
      // which would be the same two hops with an extra round trip spent.
      if (u.protocol !== 'https:') return null
      if (!isTikTokCdnHost(u.hostname)) return null
      if (u.pathname.includes(AWEME_PLAY)) return null
      return u.href
    } catch {
      return null
    }
  }
}

function resolverStub(resolver: NonNullable<Env['MEDIA_RESOLVER']>, slotKey: string) {
  let h = 2166136261
  for (let i = 0; i < slotKey.length; i++) {
    h ^= slotKey.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return resolver.getByName(`resolver-${RESOLVER_GENERATION}-${Math.abs(h) % RESOLVER_SLOTS}`)
}

/**
 * WHICH POOL A REF'S CONTAINER CALL MAY SPEND — an ALLOWLIST, and the four omissions are the point
 * rather than an oversight.
 *
 * Only `ig` and `yt` have a gate that is beaten INSIDE yt-dlp, so only they have any use for a jar in
 * the container. Facebook, Dailymotion, Streamable and Imgur reach the same endpoint and must never be
 * handed one: a session shipped to a subprocess that cannot spend it buys nothing and widens where it
 * can leak (an argv, a temp file, a crash dump) for every one of those platforms. Twitter is absent for
 * a second, independent reason — its gate is beaten in the WORKER, so `cookiesFor` refuses `'x'` outright
 * (see credentials.ts); listing it here would be a silent no-op that reads as a live path.
 *
 * DERIVED FROM THE REF, never from the slot key. The slot key is a refKey STRING, and recovering a
 * platform by parsing it would put the credential decision behind a string match that no type checker
 * can keep in step with the PostRef union — exactly the failure `parseRefKey` already documents.
 */
const jarPlatform = (ref: PostRef): CredentialPlatform | null =>
  ref.p === 'ig' ? 'ig' : ref.p === 'yt' ? 'yt' : null

/**
 * PUT THE COOKIE JAR ON A CONTAINER BODY — the ONE place in the Worker a credential crosses the wire.
 *
 * THE KEY IS OMITTED, never sent as `cookies: null`. container/server.py treats a non-string as "no
 * jar" either way, so this is not about the container understanding us; it is about the request body
 * being the thing that gets logged, echoed into an error, or captured in a test fixture. A body with no
 * `cookies` key cannot leak a field that is not there, and "absent" is unambiguous where a null is a
 * value somebody may later decide to render.
 *
 * ONLY THE {page} FORM, because that is the only one that can use it: `_mux_tracks` (the {video} path)
 * takes no jar at all, so attaching one to a direct-CDN remux would send a session somewhere it is
 * provably ignored. Same argument as the platform allowlist above, one level down.
 */
function withCookieJar<T extends object>(body: T, env: Env, platform: CredentialPlatform | null): T {
  if (!platform) return body
  const cookies = cookiesFor(env, platform)
  return cookies ? { ...body, cookies } : body
}

/**
 * Get a muxed MP4 into R2 and return its head — the shared half of serveMuxed and prewarmMux. Returns the
 * existing object when it is already there (so a mux happens at most once), else calls the container and
 * stores the result. Null on any no (no bindings, no source, a container error, an empty body).
 *
 * `platform` is threaded in EXPLICITLY rather than recovered from `slotKey` — see jarPlatform. It is the
 * only input that decides whether a credential is sent, so it is passed as a value the compiler checks.
 */
/**
 * WHICH FAILURE THIS WAS — the container's status plus a CLOSED ALLOWLIST of its own error strings,
 * mapped to a counter name. This is the whole of the diagnosability fix's judgement, and it is a pure
 * function so it can be tested without a container.
 *
 * TWO DIFFERENT 502s, and telling them apart is most of the point. container/server.py answers 502
 * for BOTH a non-zero yt-dlp exit (`"mux failed"` — the upstream refused us: a 403, a PO-token
 * demand, a sign-in wall) and a run that completed with nothing usable (`"empty or oversized
 * result"`). The first is YouTube's verdict and the second is ours, and a single `mux_gate` covering
 * both would point the next reader at the wrong system.
 *
 * MATCHED, NEVER ECHOED. The body is compared against fixed literals this repo owns; nothing from it
 * is ever stored or logged. yt-dlp's stderr is suppressed inside the container because it can carry
 * the source url, and reading a status code here must not quietly reopen that.
 */
function muxOutcomeOf(status: number, body: string): MuxOutcome {
  if (status === 504) return 'mux_timeout'
  if (status === 503) return 'mux_pool'
  if (status === 400) return 'mux_badsource'
  if (status === 502) return body.includes('empty or oversized result') ? 'mux_empty' : 'mux_gate'
  return 'mux_error'
}

/**
 * THE PLATFORM A MUX BELONGS TO, read back off the slot key rather than threaded through four
 * signatures. `slotKey` is refKey(ref), and parseRefKey is this repo's existing allowlist for turning
 * one back into a ref — so a platform that is not in that allowlist counts as `'none'` instead of
 * inventing a blob1 value the dataset has never seen.
 */
function muxPlatformOf(slotKey: string): Platform | 'none' {
  return parseRefKey(slotKey)?.p ?? 'none'
}

/**
 * READING THE ERROR BODY IS THE FIX, and discarding it was the defect. This used to be
 * `void attempt.body?.cancel()` on every failed attempt, so the container's own account of what went
 * wrong — which it has always sent — was thrown away unread on the one path that needed it.
 *
 * BOUNDED, because a body is attacker-adjacent in the ordinary sense: it is whatever the container
 * process wrote. 200 characters is far more than any of the fixed strings this repo matches on, and
 * the read is caught, because a stream that errors must degrade to "no detail" rather than take the
 * mux down with it. The body is released either way — an unread one leaks a connection.
 */
async function muxErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}

async function ensureMuxed(
  env: Env, key: string, from: Media['remux'], slotKey: string, platform: CredentialPlatform | null,
): Promise<{ size: number } | null> {
  const { MEDIA_RESOLVER: resolver, MEDIA_CACHE: cache } = env
  if (!resolver || !cache || !from) return null
  const existing = await cache.head(key)
  if (existing) return existing
  /**
   * THE CLOCK STARTS AFTER THE R2 HEAD, deliberately: a warm hit is not a mux and must not be counted
   * as a fast one, or `mux_ok`'s duration becomes a mixture of "we already had it" and "we made it"
   * and stops answering the only question it exists for.
   */
  const startedAt = Date.now()
  const site = muxPlatformOf(slotKey)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
  /**
   * TRACKS FIRST, PAGE AS THE FALLBACK — and the fallback is the load-bearing half.
   *
   * `{video, audio}` reaches the container's ffmpeg-from-urls path and skips yt-dlp entirely, which is
   * the whole saving: measured 2026-08-22, extraction is ~5.0s of player-API round trips plus a Deno
   * JS challenge, against a 1.8s download of the same 10 MB. A cold mux paid it TWICE — once for the
   * card's metadata and once again here — which is most of a 20.4s cold mux.
   *
   * THE URLS GO STALE AND NOTHING HERE CAN SEE IT. A googlevideo url is bound to the egress IP that
   * resolved it and expires in hours; slot affinity keeps that IP stable but nothing pins an instance
   * forever. A stale url fails inside ffmpeg, so the only safe way to use one is to be able to give up
   * and re-extract — hence two attempts rather than a cleverer cache. They are never persisted beyond
   * the Post (POST_TTL, 900s); the 30-day yt record and the 24h dm/im records must never carry one,
   * for exactly the reason ST_META_TTL_MS is 30 minutes.
   *
   * SENT AS A NARROWED OBJECT, not the whole remux source. The container checks `page` FIRST, so
   * posting {video, audio, page} together would take the slow path every time and this would be dead
   * code that still looked correct.
   */
  const attempts: Record<string, unknown>[] = []
  if (from.video) {
    attempts.push({ video: from.video, ...(from.audio ? { audio: from.audio } : {}) })
  }
  if (from.page) attempts.push(withCookieJar({ page: from.page }, env, platform))
  // Neither field set is not reachable through prewarmable()/normalize, but a Post deserialized from an
  // older cache entry is outside this file's control — fall back to the shape we were handed.
  if (!attempts.length) attempts.push(from as Record<string, unknown>)

  let muxed: Response | null = null
  for (let i = 0; i < attempts.length; i++) {
    const attempt = await resolverStub(resolver, slotKey).fetch('http://media-resolver/resolve', {
      method: 'POST', body: JSON.stringify(attempts[i]), headers,
    })
    if (attempt.ok && attempt.body) { muxed = attempt; break }
    // A failed SHORTCUT is not a verdict on the video — the page attempt still has to speak. Only the
    // last failure is worth reporting, and the body of a discarded one has to be released. Reading it
    // to the end releases it exactly as cancel() did, and unlike cancel() it keeps the reason.
    const detail = await muxErrorBody(attempt)
    if (i === attempts.length - 1) {
      /**
       * COUNTED **AND** LOGGED, which is the change. The console line is server-side only and needs
       * somebody attached to `wrangler tail` at the moment it fires; the counter is what survives, and
       * it is what turns "a video did not play last Tuesday" from an archaeology exercise into one
       * query. `key` is the ref, the outcome is a fixed enum, and no part of the body is stored.
       */
      countMux(env, site, muxOutcomeOf(attempt.status, detail), Date.now() - startedAt)
      console.error('mux failed', key, attempt.status)
      return null
    }
  }
  if (!muxed || !muxed.body) {
    // SERVER-SIDE ONLY (wrangler tail), never the client: a non-200 here is invisible otherwise — the
    // route degrades to the poster still, so a failed mux and an exhausted container instance look
    // identical from outside (both a 302), which is exactly the ambiguity that made "it shows a frame and
    // never plays" hard to diagnose. `key` is the ref, and the body carries no url — safe to log.
    return null
  }
  // A refused store is NOT an extraction verdict: the container produced a real video, we simply
  // would not hold it in memory to save it (see MUX_BUFFER_MAX). Returning null degrades this view
  // to the cover still, which is the same honest answer a failed mux gives — but it must NOT be
  // counted as one, or `mux_gate` starts blaming YouTube for our own buffer ceiling.
  if (!(await putMuxed(cache, key, muxed, env))) {
    countMux(env, site, 'mux_refused', Date.now() - startedAt)
    return null
  }
  const stored = await cache.head(key)
  // COUNTED ON THE WAY OUT, not at the 200: `mux_ok` means the bytes are IN R2 and the next view can
  // play them, which is the claim anyone reading this counter actually cares about.
  countMux(env, site, stored ? 'mux_ok' : 'mux_refused', Date.now() - startedAt)
  return stored
}

/**
 * ONE MUX PER VIDEO PER ISOLATE.
 *
 * ensureMuxed's "at most once" is enforced by an R2 head check, which only dedupes work that has
 * already FINISHED. A cold video is asked for by three callers within ~2s of one paste — the prewarm,
 * the HTML render's settleMux, and the activity render's settleMux — and all three miss the head check
 * and start their OWN yt-dlp download of the same video on the same pooled instance, competing for the
 * bandwidth that decides whether the card gets a player at all.
 *
 * ISOLATE-LOCAL ON PURPOSE, and it must not be described as a lock: two isolates can still double-mux
 * one video, and the R2 head check still bounds that. This is an optimization.
 */
const muxInflight = new Map<string, Promise<{ size: number } | null>>()

/**
 * A SECOND, INDEPENDENT BOUND ON SPECULATIVE CONTAINER WORK — see the prewarm site in renderPostRoute.
 * The primary bound there is that the ref must already be in the post cache (so a real fetch+normalize
 * has vouched for it); this caps how many downloads ONE isolate will have outstanding before it adds
 * another one nobody has asked for yet. Deliberately small: RESOLVER_SLOTS is 4, an instance lingers
 * ~5min, and "Maximum number of running container instances exceeded" degrades every legitimate post
 * on the pool to a video-less card. A skipped prewarm costs latency on one card; an exhausted pool
 * costs every card.
 *
 * NOT A LOCK, for the same reason muxInflight is not one: isolate-local, and two isolates can exceed
 * it together. It bounds the amplification, it does not serialize the work.
 */
const SPECULATIVE_MUX_CAP = 2
function muxOnce(
  env: Env, key: string, source: Media['remux'], slotKey: string, platform: CredentialPlatform | null,
): Promise<{ size: number } | null> {
  const running = muxInflight.get(key)
  if (running) return running
  const p = ensureMuxed(env, key, source, slotKey, platform).finally(() => muxInflight.delete(key))
  muxInflight.set(key, p)
  return p
}

/**
 * HAND THIS VIDEO TO THE ALARM, which is allowed to take fifteen minutes where this request is
 * allowed thirty seconds. See MuxJob for the measurement, and src/muxrunner.ts for the timing.
 *
 * FIRE AND FORGET, AND IT MUST NOT BE AWAITED ON THE RENDER PATH. This is one Durable Object RPC to
 * arm an alarm — it does no container work and no download — but the whole reason it exists is that
 * the render path has no time to spare, so blocking a card on it would spend the budget this is
 * meant to protect. The caller hands it to `ctx.waitUntil`, where a few milliseconds is exactly the
 * kind of work that ceiling was designed for.
 *
 * THE PAGE IS PREFERRED OVER THE RESOLVED TRACKS, and this is the one place that choice is made.
 * `remux.video`/`remux.audio` are urls the metadata call already resolved, which is a real saving
 * INSIDE a request (see ensureMuxed) — but they are bound to the egress IP that resolved them and
 * expire in hours, and this job may not run for twenty minutes. Sending them would mean a guaranteed
 * wasted container call followed by the page fallback anyway. A source with no page (Bluesky, Reddit)
 * keeps its `video`: those are ordinary CDN manifest urls, not signed ones.
 *
 * NO BINDING MEANS NO CHANGE. Without MUX_RUNNER this is a no-op and the service behaves exactly as
 * it did — the inline attempt still runs, still capped at thirty seconds.
 */
function scheduleMux(env: Env, key: string, slotKey: string, source: Media['remux']): Promise<void> {
  if (!env.MUX_RUNNER || !source) return Promise.resolve()
  const durable: NonNullable<Media['remux']> = source.page ? { page: source.page } : source
  // The DO is addressed BY THE MUX KEY, which makes it one object per video worldwide — the global
  // dedupe muxInflight has never been able to provide (it is isolate-local, and says so).
  return env.MUX_RUNNER.getByName(key).schedule({ key, slotKey, source: durable })
    // A failed RPC must never take down the render that scheduled it. The inline attempt is still
    // running and the next paste will arm it again; this is a best-effort upgrade, not a dependency.
    .catch(() => undefined)
}

/**
 * THE ALARM'S HALF OF THE MUX — exported for src/muxrunner.ts, which cannot reach `muxOnce` itself.
 *
 * Deliberately thin. Everything that decides whether a mux is correct — the R2 head check that makes
 * it at-most-once, the tracks-then-page attempts, the counters, the buffer ceiling — lives in
 * ensureMuxed and is shared with the inline path, so the two can never drift into muxing differently.
 * What this adds is only the re-derivation the job does not carry: the credential pool, which is
 * picked at random per call and must not be serialized into Durable Object storage.
 *
 * `true` MEANS THE BYTES ARE IN R2, which is what the caller's retry decision turns on — not that a
 * container answered.
 */
export async function runMuxJob(env: Env, job: MuxJob): Promise<boolean> {
  const ref = parseRefKey(job.slotKey)
  // An unparseable slotKey is a job from a build whose refKey allowlist has since changed. Refuse it
  // rather than muxing with no credential and no platform attribution — see parseRefKey.
  if (!ref) return false
  const head = await muxOnce(env, job.key, job.source, job.slotKey, jarPlatform(ref))
  return head !== null
}

/**
 * How long a request will WAIT for a cold {page} mux before giving up and promising no video.
 *
 * SPLIT DELIBERATELY, because the two fetches carry different risk. Discord fetches the HTML head FIRST,
 * then the activity JSON it advertises, then the media. Overrunning the HTML costs the WHOLE embed, so
 * that budget stays small; the activity JSON is where the card's `media_attachments[].type` is actually
 * decided, it arrives a second or so later (by which time the mux started during the HTML render has a
 * head start), and it is the last chance to tell the truth before Discord asks for bytes. Measured
 * 2026-07-24: a single cold mux of a typical video is ~6-9s at <=480p, so the combined runway
 * (HTML + gap + activity) covers the common case while no single response stalls for long.
 */
/**
 * HTML_DEADLINE_MS IS A CEILING ON THE WHOLE BOT RESPONSE, not an amount added after the fetch — that
 * change of KIND is the point, and it was MUX_WAIT_HTML_MS = 3000 before 2026-07-25. Measured on
 * /share/v/Fixture03X: the meta fetch is ~3.0s and the mux 4.1s, and serially that is 7s+ plus a
 * possible cold boot each — the reported 12.3s, at which point Discord has long given up. A 3s fetch now
 * leaves 2s of mux wait instead of stacking to 6s, and a fetch that already blew the budget waits ZERO
 * and degrades immediately, which is the honest answer when Discord is about to give up anyway.
 *
 * Raised to 5000 as a deadline because it now has to cover the fetch too. THE TRADE, stated plainly: a
 * platform whose upstream fetch is unusually slow will degrade to the still MORE often than before. A
 * still that renders beats a card Discord never draws.
 */
export const HTML_DEADLINE_MS = 5000

/**
 * THE FLOOR UNDER THE REMAINING BUDGET, AND IT MUST NOT BE ZERO.
 *
 * `Math.max(0, …)` was the first spelling and it threw away finished work. settleMux races muxOnce
 * against `setTimeout(resolve, budgetMs)`, and muxOnce's FIRST step is a real R2 `head` — an RPC with
 * real latency. A 0ms timer beats that every time, so a video sitting WARM in R2, needing no container
 * call at all, was dropped from the card as if it did not exist — and because the card then counts as
 * degraded, the response is not cached either, so the next unfurl repeats the entire slow path.
 *
 * Reachable on exactly the platform this budget was tuned for: any Facebook meta extract slower than
 * HTML_DEADLINE_MS arrives with the whole budget spent, and every one of those requests discarded a
 * finished mux. 300ms is an R2 head plus slack, not a mux wait — a COLD mux still loses it and still
 * degrades to the still, which is the intended behaviour.
 */
export const MUX_WAIT_FLOOR_MS = 300
const MUX_WAIT_API_MS = 9000

/**
 * THE CONVERTER PAGE'S OWN CEILING, and the reason it is not HTML_DEADLINE_MS.
 *
 * /_card used to borrow HTML_DEADLINE_MS, which is a bound on how long a CRAWLER will hold a
 * connection. /_card is not a crawler: it is an XHR from someone who has just pasted a link and is
 * watching a spinner, and it exists to predict a card that the activity route renders on
 * MUX_WAIT_API_MS. A preview given a smaller budget than the thing it previews will disagree with it
 * whenever the difference matters — which made it useless in exactly the cases worth previewing.
 *
 * So it is the SAME number, deliberately aliased rather than copied: if the card's budget ever moves,
 * the preview's has to move with it or they drift apart again.
 */
const CARD_DEADLINE_MS = MUX_WAIT_API_MS

  /**
   * The still, never a dead player — and it MUST CARRY `posterOnly` AND KEEP `poster`, which is the
   * one place this shape deliberately differs from withResolver's.
   *
   * THE DEFECT THAT REQUIRES IT (measured on yt:Jky5ZXI0axc, 1431s, refused by the container's
   * MAX_SECONDS match-filter): this degrade rewrites the entry WITHOUT MOVING IT, and the renderers
   * mint a picture url from the array POSITION. The /_media/ route re-derives the post from the
   * cache — and a degraded card is deliberately NOT response-cached (see the caller) — so at that
   * position the route still finds the remux VIDEO, muxes, fails again, and answers notReady():
   * 503 no-store. The card therefore shipped an IMAGE url that 503s and Discord drew a bare
   * title+description box, while the correct still sat reachable at `/_media/{key}/poster0` the
   * whole time. `posterOnly` is what tells the renderers to name that slot (see bytesIndex).
   *
   * `poster` IS KEPT rather than left behind on the original entry because bytesIndex requires a
   * string poster before it will mint a slot — pickMedia's poster branch has no fallback to m.url,
   * so a slot on a posterless entry is a guaranteed 404. It is also honest: on a still, `url` and
   * `poster` are the same bytes. Inert everywhere else, since every reader of `poster` is gated on
   * the attachment being a video.
   *
   * IT DOES NOT MAKE A VIDEO URL SERVE AN IMAGE (serveMuxed's rule, stated twice above). No url's
   * contents change; only which of two already-correct urls the degraded CARD names.
   *
   * WHY withResolver's DEGRADE IS NOT GIVEN THE FLAG: its rewrite is applied inside getPost, so the
   * /_media/ ROUTE sees it too and the bare `{i}` already resolves to the poster there — and that
   * degrade drops `poster`, so a poster slot would 404. See the comment at withResolver.
   */
  /**
   * THE POSTER'S DIMENSIONS, NOT THE VIDEO'S — see Media.posterW. Copying `w`/`h` across is what
   * shipped a card Discord refused to draw: a remux video carries 0x0 on purpose, the still
   * inherited it, mastodon.ts then omitted `meta.original`, and an image attachment with no size
   * renders as nothing at all. Falls back to the video's dimensions, which is right for every
   * platform whose poster and video are the same shape.
   */
/**
 * `duration` IS CARRIED ACROSS, added 2026-08-29, and dropping it was load-bearing in the wrong
 * direction. The over-ceiling arm below rewrites the remux entry into this still, so on exactly the
 * videos that need the length note the length was erased one step before withLengthNote looked for
 * it — the note fell back to nothing and the card went silent about why it was a picture. Nothing
 * renders the field (no renderer reads Media.duration; settleMux and the yt overlays are its only
 * consumers), so keeping it is free and it is honest: a still of a 56-minute video is still a still
 * of a 56-minute video.
 *
 * `live` IS CARRIED FOR THE SAME KIND OF REASON and is NOT load-bearing today, which is worth saying
 * plainly so the next reader neither deletes it as dead nor trusts it as a guarantee. withLiveNote's
 * media fallback reads it, but on every reachable path the note is already in `post.text` before this
 * runs: normalizeYouTube applies it at BUILD time, because Innertube answers the liveness question
 * before the Post exists. So dropping it changes no output that any test or route can observe — I
 * checked. It stays because it is honest (a still of a live stream is still a still of a live stream)
 * and free, and because the moment anything builds a yt Post without going through normalizeYouTube,
 * the fallback is what keeps the card from becoming the silent blank rectangle. Nothing renders it.
 */
function stillOf(m: Media): Media | null {
  if (!m.poster) return null
  return {
    kind: 'image' as const,
    url: m.poster,
    poster: m.poster,
    w: m.posterW ?? m.w,
    h: m.posterH ?? m.h,
    posterOnly: true as const,
    ...(m.duration === undefined ? {} : { duration: m.duration }),
    ...(m.live === undefined ? {} : { live: m.live }),
  }
}

/**
 * ONLY PROMISE og:video WHEN THE VIDEO ACTUALLY EXISTS.
 *
 * THE DEFECT (diagnosed 2026-07-24, the "won't play past the first frame" report). A cold `{page}` mux
 * (yt-dlp: extract, download, merge) takes seconds; Discord's media proxy fetches og:video within about
 * one second of reading the head and caches the answer. So the card promised a video that did not exist
 * yet, and the media route answered with the poster IMAGE — poisoning the url in Discord's cache
 * permanently (see serveMuxed). Starting the mux early (the previous fix) was not enough: prewarm only
 * bought the head start between the two fetches, roughly a second.
 *
 * So the render now WAITS, briefly, and tells the truth either way:
 *  - mux ready inside MUX_WAIT_MS -> keep the remux video; Discord's fetch hits warm R2 and PLAYS.
 *  - not ready -> return the post with that video degraded to its poster STILL (exactly what withResolver
 *    does with no container bound), so the card is honest and no url is poisoned. The mux keeps running
 *    in ctx.waitUntil, so the next render — the caller skips the response cache when it degraded — finds
 *    it warm and plays.
 * The budget is deliberately short: overrunning Discord's own HTML timeout would cost the whole card,
 * which is worse than a still. Only `{page}` sources wait; `{video}` track remuxes (Reddit/Bluesky HLS)
 * are fast enough to win the race on their own and are left untouched.
 *
 * Returns the post to render and whether anything degraded (the caller must not cache a degraded card).
 */
async function settleMux(
  post: Post, env: Env, ctx: ExecutionContext, budgetMs: number, client: ClientClass,
): Promise<{ post: Post; degraded: boolean }> {
  if (!env.MEDIA_RESOLVER || !env.MEDIA_CACHE) return { post, degraded: false }
  const own = Array.isArray(post.media) ? post.media : []
  /**
   * EVERY REMUX, NOT ONLY A `{page}` ONE — the guard used to read `m?.remux?.page`, and that single
   * `?.page` is what left Bluesky and Reddit with no durable mux path at all. They carry `{video}`
   * (an unsigned CDN HLS manifest) and never a page, so this function returned here before reaching
   * the arming loop, and prewarmable() answers null for them as well. scheduleMux was BUILT to accept
   * them — its own docstring reasons about "a source with no page (Bluesky, Reddit)" — and no caller
   * ever handed it one, so that branch shipped dead.
   *
   * The RACE below is still `{page}`-only. A `{video}` entry is armed and returned untouched: waiting
   * on it would start degrading cards that render fine today, which is a behaviour change with its own
   * measurement to do. This change is strictly additive and cannot make a rendered card worse.
   */
  if (!own.some(m => m?.remux)) return { post, degraded: false }

  let degraded = false
  /**
   * A SECOND FLAG, BECAUSE THE ARRAY CAN CHANGE WITHOUT THE CARD BEING INCOMPLETE.
   *
   * `degraded` answers one question only: may this response be cached? NEITHER of the two rewrites
   * below may set it — the over-ceiling one, and the live one — because both verdicts are final for
   * as long as the card lives, and re-deciding them on every view was the cost this whole path exists
   * to stop paying. (Final is not the same as permanent: an over-ceiling video is too long forever, a
   * broadcast only until it ends, and RESP_TTL is what bounds the second.)
   *
   * But the early return was `if (!degraded) return { post }` — the ORIGINAL post — so a post whose
   * only video is over the ceiling had its rewrite computed and then thrown away. The card went on
   * advertising og:video at /_media/{key}/0, which the container refuses forever: a permanent 503 at
   * a url the card promises, which is the exact shape of the bug the posterOnly comment below was
   * written for. One flag was being asked to mean both "changed" and "incomplete".
   */
  let rewritten = false
  const media = await Promise.all(own.map(async (m, i) => {
    if (!m?.remux) return m
    if (!m.remux.page) {
      // ARM, DO NOT RACE. See the guard above: this is the whole of Bluesky's and Reddit's alarm
      // coverage, and it deliberately does not touch the returned entry.
      ctx.waitUntil(scheduleMux(env, `mux/${refKey(post.ref)}/${i}`, refKey(post.ref), m.remux))
      return m
    }
    /**
     * A VIDEO OVER THE CEILING IS NEVER MUXED, AND ITS CARD IS CACHEABLE.
     *
     * The container refuses these with its own match filter, so dispatching one spends a full deadline
     * to be told something already known — the duration is in the meta record, kept 30 days. Measured
     * on the reported video before this existed: 5.2s on the HTML seam, 9.1s on the activity seam, and
     * 5.1s again on the SECOND view, because a degraded card is not response-cached.
     *
     * `degraded` is deliberately NOT set here. That flag means "incomplete, something is still coming,
     * do not pin this" — true of an ordinary slow mux, false of this, where the answer is final and
     * will be identical in thirty days. Setting it would re-pay the cost forever for an outcome that
     * cannot change.
     */
    /**
     * A BROADCAST WITH NO FINISHED FILE IS NEVER MUXED EITHER, and the arm above could not cover it.
     *
     * THE DEFECT, measured on yt:xDWQ3LkccY8 (Sky News, permanently live): a live stream reports
     * `lengthSeconds: '0'`, so it carries no duration, so `m.duration > MUX_MAX_SECONDS` is false and
     * the dispatch went ahead. The container refuses it on its own `--match-filter
     * "duration<?1500 & !is_live"`, the card degrades, a degraded card is deliberately not
     * response-cached — so the next render repeats the whole ~1.7s round trip, and the one after
     * that, forever. The probe found that id pinned at `muxing: true` and never cached. News channels
     * post these constantly, and the same shape covers a SCHEDULED stream (see liveVerdict).
     *
     * IDENTICAL TREATMENT TO THE OVER-CEILING ARM because it is the identical KIND of answer: final,
     * knowable without asking the container, and not "something is still coming". So no `degraded`,
     * and the card caches. The two arms cannot both be right about one entry — a length only exists
     * once the broadcast has ended — but they agree on the outcome, so the order is not load-bearing.
     *
     * THE RESIDUAL, written down because it is the remaining hole: renderPostRoute's PREWARM is keyed
     * on the ref alone (prewarmable() never sees a Post), so a live stream is still dispatched once
     * per colo on a response-cache miss. That is now bounded by RESP_TTL rather than unbounded, since
     * this card caches — it was every render before. Closing it properly means reading the post cache
     * entry before prewarming, which is the overlap the prewarm exists to avoid.
     */
    if (m.live) {
      const still = stillOf(m)
      // Same hole as the over-ceiling arm's: no poster, nothing to degrade to, leave the entry. See
      // the comment there — it is a hole in theory before it is one in practice, and yt always has a
      // thumbnail because normalizeYouTube derives one from the id.
      if (!still) return m
      rewritten = true
      return still
    }
    if (typeof m.duration === 'number' && m.duration > MUX_MAX_SECONDS) {
      // The same still the unfinished-mux path produces, from the same function, because the two
      // shapes MUST NOT DRIFT: this one was hand-rolled with a spread and so kept `remux` and lacked
      // `posterOnly`, which is precisely the combination stillOf's comment says renders as nothing.
      const still = stillOf(m)
      /**
       * NO POSTER, SO THERE IS NOTHING TO DEGRADE TO, and the entry is left alone rather than dropped.
       * This is the one case that still names a video url the container will refuse forever. Left
       * deliberately: dropping it makes an emptier card without making a truer one, and the reason is
       * already ON the card in words for the tier where this is reachable (see withLengthNote). Every
       * yt-dlp source measured so far carries a thumbnail, so this is a hole in theory before it is
       * one in practice — but it IS the remaining hole, and it should be found written down.
       */
      if (!still) return m
      rewritten = true
      return still
    }
    const key = `mux/${refKey(post.ref)}/${i}`
    /**
     * THE ALARM IS ARMED BEFORE THE RACE, not after it, and that ordering is the fix.
     *
     * The comment that used to sit here said the mux "runs to completion regardless of who wins this
     * race — waitUntil keeps it alive past the response". THAT WAS FALSE, and it is what the
     * 2026-08-23 diagnosis turned on: Cloudflare cancels every unsettled `waitUntil` promise 30
     * seconds after the response, on a budget SHARED with every other waitUntil in the same request.
     * A video that needs longer was not "ready for the next render" — it was killed with nothing
     * written, and the next render started it again from byte zero. See MuxJob.
     *
     * Armed FIRST because a render can be cancelled at any point after this line; arming after the
     * race would mean the slowest videos — the only ones that need the alarm — are exactly the ones
     * that never reach the arming code.
     */
    ctx.waitUntil(scheduleMux(env, key, refKey(post.ref), m.remux))
    // The inline attempt is unchanged and is still the fast path: a warm R2 hit and a quick mux both
    // finish well inside a request, and for those the alarm wakes at +35s, hits the R2 head check and
    // does nothing. waitUntil still buys the sub-30s tail, which is most muxes.
    const work = muxOnce(env, key, m.remux, refKey(post.ref), jarPlatform(post.ref)).catch(() => null)
    ctx.waitUntil(work)
    // deadline(), not a bare Promise.race: an uncleared timer stays armed for the full budget even
    // when the container answers instantly, holding the isolate open for nothing. deadline's own
    // comment records that this cost the test suite 6 seconds before it was fixed there.
    const head = await deadline(work, budgetMs)
    if (head) return m
    /**
     * THE ONE OUTCOME A READER ACTUALLY SEES, and until now the only one counted nowhere.
     *
     * The card that reaches this line is the still — no player — and the render that produced it goes
     * on to fire `ok`. So the dataset recorded the first-paste failure everyone is trying to fix as a
     * SUCCESS, twice. That is worse than having no number: it is a number that points the wrong way.
     *
     * `card_degraded`, NOT `mux_degraded`. docs/METRICS.md fixes blob3 as `none` and double2 as elapsed
     * ms on every `mux_*` row, and `MuxOutcome` is derived from that prefix — a `mux_`-named outcome
     * emitted through plain count() would satisfy the type system while falsifying both columns and
     * dragging every platform's avg_ms toward zero. This is also genuinely a different event: per
     * RENDER, not per mux, so the real client is meaningful here where countMux's `none` is not. Only
     * the Discord render is the one Discord then freezes forever.
     *
     * NEITHER OF THE TWO REWRITES ABOVE is counted here — the over-ceiling one, and the live one.
     * Neither calls the container and neither can ever succeed, so folding them in would put a
     * permanent floor under the ratio made of long videos and of channels that stream all day.
     */
    count(env, post.ref.p, 'card_degraded', client)
    degraded = true
    return stillOf(m)
  }))

  // `rewritten` is checked too, or the over-ceiling still is computed and discarded. `degraded` is
  // returned as it stands: that rewrite is permanent and its card is meant to cache.
  if (!degraded && !rewritten) return { post, degraded: false }
  return { post: { ...post, media: media.filter((m): m is Media => m != null) }, degraded }
}

/**
 * THE MUX SOURCE A REF IMPLIES WITH NO UPSTREAM CALL — the answer to "can the mux start before the
 * metadata fetch finishes?", which for the {page} platforms is YES: the page url is a PURE function of
 * the ref (fb: fbPageUrl; yt: the watch url), so the mux source never depends on the meta result and the
 * download can start the instant a bot asks for the card.
 *
 * Measured 2026-07-25 on /share/v/Fixture03X: meta ~3.0s, mux 4.1s. Serial, that is 7s+ and the old 3s
 * wait expires, the card degrades to a still, the response is NOT cached, and Discord's activity callback
 * ~1s later starts the whole download AGAIN. Overlapped, the mux is ~3s in by the time the post exists
 * and finishes inside the remaining budget — the difference between a cached card with a player and an
 * uncached still. Every other platform returns null and is untouched.
 *
 * WHAT PREWARMING CHANGES ABOUT REACHABILITY, AND WHAT NOW BOUNDS IT. Read this before widening it.
 * Starting the mux early moves container dispatch IN FRONT of the fetch that used to validate the ref.
 * Before it, the container was reachable only AFTER a successful fetch+normalize proved the ref named a
 * real post; with an unbounded prewarm, `GET /watch/?v=<any 11-char id>` boots an instance and runs
 * yt-dlp against an attacker-chosen page — and a loop over distinct ids saturates the pool
 * (RESOLVER_SLOTS 4, sleepAfter ~5min, PROC_TIMEOUT 120s, MAX_BYTES 300MB), which is exactly the
 * documented "Maximum number of running container instances exceeded" failure that degrades EVERY
 * legitimate post to a video-less card. So the call site prewarms only for a ref the POST CACHE already
 * holds — i.e. one a real fetch+normalize has already vouched for, restoring the pre-prewarm
 * reachability rule — and additionally only while this isolate has fewer than SPECULATIVE_MUX_CAP muxes
 * outstanding.
 *
 * THE COST, STATED PLAINLY: the very first paste of a video no longer overlaps its mux with its fetch,
 * so that first HTML render is likelier to degrade to the still. It is NOT the whole measurement
 * refunded — by the time Discord's activity callback arrives ~1s later the post IS cached, that
 * document is where `media_attachments[].type` is decided, and it waits YT_MUX_BOT_MS (4000) on yt
 * and MUX_WAIT_BOT_MS (1500) elsewhere — and every re-paste takes the warm path this gate is scoped
 * to. (It said MUX_WAIT_API_MS, 9000, until 2026-08-29; that stopped being true at 553bd2e. The ~1s
 * of head this paragraph banks on is also the mux's head start against the budget it now names, and
 * YT_MUX_BOT_MS is sized around it.) Speculative work for a ref nobody has
 * successfully fetched is not worth a shared, capped, cross-tenant resource.
 */
function prewarmable(ref: PostRef): { index: number; source: NonNullable<Media['remux']> } | null {
  if (ref.p === 'fb') return { index: 0, source: { page: fbPageUrl(ref) } }
  if (ref.p === 'yt') return { index: 0, source: { page: ytPageUrl(ref) } }
  // The yt-dlp tier — same argument as fb: the page is a pure function of the ref, so the download can
  // overlap the metadata call instead of running after it. The post-cache gate at the call site applies
  // to them exactly as it does to fb, and it is a REAL gate on these three (unlike yt, whose normalizer
  // never returns null, these produce no post at all for an id the container cannot extract).
  if (ref.p === 'dm' || ref.p === 'st' || ref.p === 'im') return { index: 0, source: { page: ytdlpPageUrl(ref) } }
  return null
}

/**
 * Facebook's title + thumbnail — from the container's yt-dlp `{page, meta:true}` mode (a `-J` metadata
 * dump, no download), the ONE datacenter-reachable source: Meta decoys the crawler-UA / oembed metadata
 * from datacenter, but yt-dlp extracts the video AND its metadata fine. Same container binding + secret as
 * serveMuxed. Any failure -> null (the generic "couldn't load"), never a throw. Title present is the
 * content assertion — a gone/blocked extract yields no title.
 */
/**
 * A CEILING ON THE META CALL. Without one it has NONE: the container's own PROC_TIMEOUT is 120s, so a
 * wedged instance blocks the whole embed and Discord shows nothing at all. A measured healthy extract is
 * 2.4-3.1s (yt-dlp -J, 2026-07-25), so this is generous; past it a generic card beats silence. Failures
 * are never cached, so a healthy-but-slow post self-heals on the next unfurl.
 *
 * DERIVED, NOT PICKED — and the previous hand-picked 6000 is why. HTML_DEADLINE_MS is 5000 and bounds
 * the WHOLE bot response, so a 6000 meta ceiling was LARGER than the budget it spends from: any extract
 * in the 5-6s band consumed the entire deadline and guaranteed a degraded, uncached card, on the one
 * platform this budget exists for. Deriving it makes the two bounds consistent by construction rather
 * than by somebody remembering to move both — a meta call that runs to its ceiling still leaves exactly
 * MUX_WAIT_FLOOR_MS, which is enough to observe a warm R2 mux.
 *
 * THE "GENEROUS" ABOVE IS STALE FOR THE yt-dlp TIER, and the correction is the whole reason
 * META_TIMEOUT_API_MS exists below. 2.4-3.1s was measured on FACEBOOK. Measured 2026-08-12 from
 * production against ten previously-unseen Dailymotion ids, a SUCCESSFUL `yt-dlp -J` costs 3.3s to
 * over 4.7s: every one of the ten landed its whole response at the 5.0s ceiling, and one blew this
 * deadline outright and returned the 258-byte failure card. The steady-state warm cost already sits
 * inside the last ~30% of this budget, so a cold container is not a special case — it is simply the
 * reliable way to push it over.
 *
 * THIS NUMBER STAYS 4700 ANYWAY, and that is a decision rather than an omission. It is DERIVED from
 * HTML_DEADLINE_MS, and that derivation is still right: 5000 bounds how long a CRAWLER holds the
 * connection, so raising the meta ceiling past it reintroduces exactly the "6000 was larger than the
 * budget it spends from" defect recorded above. If the crawler head needs more, it is HTML_DEADLINE_MS
 * that has to move, and that is a separate measurement about Discord's tolerance that nobody has taken.
 */
const META_TIMEOUT_MS = HTML_DEADLINE_MS - MUX_WAIT_FLOOR_MS

/**
 * THE SAME CALL, ON A SURFACE THAT IS NOT A CRAWLER — and the bug is that there was only one number.
 *
 * `getPost` is one function on every surface, so the container metadata call — the one that decides
 * whether there is a card AT ALL on fb/dm/st/im — was capped at the CRAWLER's 4700ms even on /_card and
 * /_api/v1, which race the mux and the translation on CARD_DEADLINE_MS (9000). A step given a smaller
 * budget than the response it is a step of is the identical mistake META_WAIT_API_MS = 4000 was, which
 * describeTarget's own comment calls a monument.
 *
 * WHAT IT COST, and why this surface is the one worth fixing first. CLAUDE.md names the converter
 * preview as the seam with NO NEXT RENDER: a degraded card heals on the next unfurl and a late
 * translation lands in R2 for the next reader, but /_card is fetched once per typing-settle and drawn,
 * and nobody re-pastes to heal it. So on this surface a lost meta deadline is not "slow", it is a
 * permanent "couldn't load" for a Dailymotion or Streamable link that is completely fine — reproduced
 * as ~1 in 10 fresh first-pastes on 2026-08-12 (see META_TIMEOUT_MS for the measurement).
 *
 * DERIVED THE SAME WAY, from the ceiling this surface actually spends: a meta call that runs to this
 * ceiling still leaves exactly MUX_WAIT_FLOOR_MS, which is what describeTarget's settleMux floors at.
 * So the two bounds stay consistent by construction, exactly as they do on the crawler head.
 *
 * NOT APPLIED TO THE ACTIVITY/oEMBED CALLBACK, deliberately, and for MUX_WAIT_BOT_MS's stated reason:
 * that document is fetched by Discord immediately after the head, so its ceiling is the second half of
 * a budget already spent, and how much a crawler will tolerate there is unmeasured. It keeps
 * META_TIMEOUT_MS. Widening it wants its own measurement, not this one.
 */
const META_TIMEOUT_API_MS = CARD_DEADLINE_MS - MUX_WAIT_FLOOR_MS

/**
 * Race a promise against a deadline, returning null if the deadline wins. The TIMER IS CLEARED when the
 * work wins — an uncleared one keeps firing after the response and, in `node --test`, holds the event
 * loop open for its full duration (it added 6s to this suite before it was cleared, which is how it was
 * noticed). NOT AbortSignal: the loser is deliberately left running to completion, so the container
 * finishes the extract it already started and the caller can still cache a late result.
 */
async function deadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([work, new Promise<null>(resolve => { t = setTimeout(() => resolve(null), ms) })])
  } finally {
    clearTimeout(t)
  }
}

async function resolveFacebookMeta(ref: Extract<PostRef, { p: 'fb' }>, env: Env): Promise<FacebookMeta | null> {
  const resolver = env.MEDIA_RESOLVER
  if (!resolver) return null
  const call = async (): Promise<FacebookMeta | null> => {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
      // The slot is the POST, not `meta/{ref}`: this call and the video mux for the same ref must land
      // on ONE container instance, or a Facebook post pays two cold boots back to back (see
      // RESOLVER_SLOTS).
      //
      // NO COOKIE JAR, deliberately, and it is written here because this call is a copy of YouTube's
      // that DOES carry one. Facebook has no pool (there is no FB_ACCOUNTS secret and nothing asked
      // for one), so sending anything would mean picking some other platform's session — see
      // jarPlatform for why an unusable credential on the wire is a cost with no benefit.
      const r = await resolverStub(resolver, refKey(ref)).fetch('http://media-resolver/resolve', {
        method: 'POST', body: JSON.stringify({ page: fbPageUrl(ref), meta: true }), headers,
      })
      if (!r.ok) return null
      const j = await r.json() as Record<string, unknown>
      // The content assertion, unchanged: a gone/blocked extract yields no title.
      if (typeof j?.title !== 'string' || !j.title) return null
      const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
      const http = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined)
      // EVERY NEW FIELD OPTIONAL, because a deploy is not atomic: a pooled instance still running the
      // pre-g3 image answers with only {title, thumbnail, uploader}, and that must degrade to the old
      // card rather than throw. The normalizer treats every one of them as absent.
      return {
        title: j.title, poster: http(j.thumbnail),
        uploader: s(j.uploader), uploaderId: s(j.uploader_id), uploaderUrl: http(j.uploader_url),
        description: s(j.description), w: n(j.width), h: n(j.height),
        duration: n(j.duration), timestamp: n(j.timestamp),
      }
    } catch {
      return null
    }
  }
  return call()
}

/**
 * 24h. The fields are IMMUTABLE for a given video id (title, creator, dimensions, duration), and the
 * cost of a miss is a 2.4-3.1s yt-dlp extraction (measured 2026-07-25) on the one path where latency is
 * a correctness issue.
 *
 * R2 RATHER THAN caches.default: the response/post caches are PER-COLO, and one paste generates three
 * fetches from different Discord infrastructure (the crawler's HTML, its activity callback, the media
 * proxy) that do not reliably share a colo — nor does a re-paste a day later. R2 is global; a hit is one
 * small GET. This does NOT speed up the FIRST paste anywhere (the prewarm and slot affinity do that); it
 * makes every subsequent unfurl free.
 *
 * Shares the bucket with `mux/{refKey}/{i}` and cannot collide: a mux key has no '.json' suffix and this
 * one has no index segment. A FAILED extract is deliberately never cached.
 */
const FB_META_TTL_MS = 86_400_000

/**
 * THE GENERATION IS IN THE KEY, and it is the same argument container/README.md already makes for
 * instance names: a redeploy is not atomic, so during a rollout a PRE-BUMP instance still answers, and
 * without this its thinner dict — {title, thumbnail, uploader} from a pre-g3 image — is PERSISTED for a
 * full 24h. The rollout then completes and the card STILL ships with no dimensions, no caption and no
 * timestamp, on every colo, not fixable by re-pasting, and a new instance name alone would not clear it.
 *
 * META_GENERATION, NOT RESOLVER_GENERATION, since 2026-08-29. It was one string, and every bump aimed
 * at retiring a container instance also emptied this cache: five bumps in 27 days against a 30-day
 * TTL, two of which had nothing to do with what is stored here. The two constants hold the same value
 * today (both `g13`), so nothing moved when they split — see META_GENERATION for the measurement and
 * for which one to bump.
 *
 * Bumping META_GENERATION is still the SINGLE invalidation switch for everything we persisted; old
 * objects are simply never read again. R2 has no cost pressure to delete them urgently and a lifecycle
 * rule is the right eventual broom, not a delete on the request path.
 *
 * Exported for the test that pins the miss — a key built by hand there would pass while this drifted.
 *
 * WIDENED to PostRef 2026-07-26 (it was fb-only) because YouTube now persists a container answer of
 * its own. refKey namespaces the platform (`yt:` vs `fb:watch:`), so no two platforms can collide
 * here, and a mux key (`mux/{refKey}/{i}`, no '.json', an index segment) cannot either — and that mux
 * key has no generation segment at all, which is why a bump has never cost a muxed video.
 */
export const metaCacheKey = (ref: PostRef) => `meta/${META_GENERATION}/${refKey(ref)}.json`

/**
 * ONE IMPLEMENTATION of "generation-scoped R2 meta with a TTL, a deadline, and never-cache-a-failure",
 * split in two so a caller can put a GATE between the read and the container call. Two copies of this
 * would be two places for one of them to drift, and the drift would be a persisted wrong answer.
 *
 * THE READ IS try/catch, NOT `.catch()`, and that is not defensiveness: the injected MEDIA_CACHE
 * stand-in in test/pipeline.test.mjs provides only `head` and `put`, so `cache.get` is UNDEFINED and
 * calling it throws SYNCHRONOUSLY — a rejected-promise guard never sees it, and the route 500s.
 *
 * THE TTL MAY BE A FUNCTION OF THE RECORD, added 2026-08-29 for exactly one caller. Every field these
 * records held was immutable, which is what a 30-day TTL was buying; `isLive` is not, and a record
 * that says a broadcast is live has to expire on the timescale a broadcast ends on rather than the
 * timescale an upload date stops being true on. See YT_LIVE_TTL_MS. Passing a number is unchanged and
 * is what every other caller does.
 *
 * THE PARSE MOVED IN FRONT OF THE AGE CHECK to make that possible. The only cost is parsing a record
 * that turns out to be expired — these are a few hundred bytes — and the outcome is identical either
 * way, since both paths return null.
 */
async function readCachedMeta<T>(
  ref: PostRef, env: Env, ttlMs: number | ((rec: T) => number), valid: (j: unknown) => boolean,
): Promise<T | null> {
  const cache = env.MEDIA_CACHE
  if (!cache) return null
  try {
    const obj = await cache.get(metaCacheKey(ref))
    if (!obj) return null
    const j = await obj.json<T>().catch(() => null)
    if (!j || !valid(j)) return null
    // R2 stamps `uploaded`, so no expiry field has to be stored or trusted.
    const ttl = typeof ttlMs === 'function' ? ttlMs(j) : ttlMs
    return Date.now() - obj.uploaded.getTime() >= ttl ? null : j
  } catch {
    return null
  }
}

/**
 * THE WRITE IS INSIDE THE RACED WORK, not after it — so a call that loses the deadline still lands in
 * R2 when it eventually finishes, and the NEXT unfurl (Discord's activity callback a second later, or
 * a re-paste) is a warm hit rather than another slow extract. That is the whole reason the bound is a
 * deadline rather than an AbortSignal: nothing is cancelled, only waited for less. A FAILED extract is
 * deliberately never written.
 *
 * A WRITE FAILURE IS NOT AN EXTRACTION VERDICT (fixed 2026-07-26). This used to end in a blanket
 * `.catch(() => null)`, which folded a failed R2 `put` into the SAME null a gone page produces: a
 * successful extract whose write threw was both DISCARDED (the generic "couldn't load" on a post that
 * extracted fine) and, through metaAttempt, marked failed for 60s so the retry that would have fixed
 * the card was refused. The value was obtained; failing to cache it is a caching problem. So the write
 * is caught HERE, narrowly, and the extracted value is returned either way — the only cost of a failed
 * write is that the next unfurl repeats the extract, which is exactly what an uncached record means.
 *
 * try/catch rather than `.catch()`, for readCachedMeta's reason: an injected MEDIA_CACHE stand-in can
 * be missing `put` entirely, and calling undefined throws SYNCHRONOUSLY where a rejected-promise guard
 * never sees it.
 *
 * AND THE WORK'S OWN REJECTION IS LEFT ALONE, deliberately — it is the one signal that says "no
 * evidence about this id" (it threw, or the isolate cancelled it), and metaAttempt is where that is
 * told apart from a real negative. Nothing is ever an unhandled rejection: metaAttempt attaches the
 * handler synchronously, in the same expression that creates this promise.
 */
function metaWork<T>(ref: PostRef, env: Env, work: () => Promise<T | null>): Promise<T | null> {
  const cache = env.MEDIA_CACHE
  const key = metaCacheKey(ref)
  return work().then(async fresh => {
    if (fresh && cache) {
      try {
        await cache.put(key, JSON.stringify(fresh))
      } catch { /* cached or not, it is the same answer — see the docstring */ }
    }
    return fresh
  })
}

/**
 * SPECULATIVE_MUX_CAP's sibling, and the same argument. Isolate-local, and NOT a lock: two isolates can
 * exceed it together. It bounds how much container work ONE isolate will have outstanding for METADATA
 * before it starts another — RESOLVER_SLOTS is 4, instances linger ~5min, and an exhausted pool
 * degrades EVERY post on it to a video-less card, which this file already documents as the biggest
 * single cause of "the video does not play".
 *
 * ONE CAP FOR ONE POOL. It is shared by every meta consumer — YouTube's date, Facebook's card, and the
 * yt-dlp tier's card — because they share the four container slots. Two constants would be two things
 * to keep in step with a pool that has one size.
 *
 * WHAT A SKIPPED CALL COSTS IS NOT THE SAME ON EVERY PLATFORM, and that is the real trade here rather
 * than a detail. On yt it costs one card's TIMESTAMP. On fb and the yt-dlp tier the meta call IS the
 * card, so a skip is the generic "couldn't load" — which is why the failure is never cached (neither
 * the null Post nor the response), so a re-paste or Discord's own retry takes the warm path. Reaching
 * it needs SPECULATIVE_META_CAP+1 DISTINCT ids in flight on ONE isolate at one instant; a burst on a
 * single id collapses to one call through metaOnce and does not count more than once.
 */
const SPECULATIVE_META_CAP = 2

/**
 * ONE EXTRACT PER META KEY PER ISOLATE — muxOnce's shape, for the metadata call.
 *
 * The R2 record only dedupes work that has already FINISHED, and one paste produces up to three
 * requests within ~2s (the crawler's HTML, its activity callback, the media proxy), all of which miss
 * the R2 read and would each start their OWN `yt-dlp -J` for the same page on the same pooled instance.
 *
 * `unknown` in the map, T at the boundary: the key is metaCacheKey(ref), which is namespaced by the
 * ref's PLATFORM, so one key can only ever carry one record type — a yt key holds a YouTubeMeta and a
 * dm key a YtdlpMeta, and no key is reachable from two different callers.
 *
 * WHAT GUARANTEES A SLOT IS RELEASED (both halves added 2026-07-26, after a leak that could disable
 * metadata for the LIFE of an isolate). Settling used to be the only release, and a promise is not
 * guaranteed to settle: on Workers, work with no waitUntil is cancelled once the response is sent, so
 * `.finally` never runs and the entry stays forever. SPECULATIVE_META_CAP is 2, so TWO stranded
 * entries made metaDispatchable answer false for EVERY key — no container dispatch at all, for fb, dm,
 * st, im AND yt, invisibly (cards just quietly lose their titles, dates and posters). So:
 *
 *   1. THE WORK IS KEPT ALIVE. Every dispatcher hands its attempt to ctx.waitUntil (cachedMeta and
 *      youtubeMeta both), so the promise runs to completion and settles normally. That is the primary
 *      guarantee and it also buys the R2 write on a deadline-losing call — see metaWork.
 *   2. AND THE SLOT EXPIRES ANYWAY. Release no longer depends on the promise at all: each entry
 *      carries the instant it started, and any sweep drops one older than META_INFLIGHT_MAX_MS. A
 *      future path that strands a promise (a cancellation link 1 does not cover) then costs at most
 *      one stale slot for that window instead of an isolate-lifetime outage.
 * Sweeping is a plain read-time scan — no timer, deliberately: a timer is itself request-scoped work
 * that a cancelled context stops running, i.e. exactly the thing that cannot be relied on here.
 */
type MetaSlot = { p: Promise<unknown>; at: number }
const metaInflight = new Map<string, MetaSlot>()

/**
 * How long an entry may sit in metaInflight before a sweep treats it as stranded rather than running.
 * PAST THE CONTAINER'S OWN CEILING, on purpose: container/server.py's PROC_TIMEOUT is 120s, so a
 * genuinely running `-J` cannot outlive this and the sweep can only ever evict a promise that is
 * already dead. Evicting a live one would not be a correctness bug either — it costs one duplicate
 * extract, the state metaOnce exists to improve on — which is why the ceiling is generous rather than
 * tight.
 */
const META_INFLIGHT_MAX_MS = 180_000

function metaSweep(): void {
  const now = Date.now()
  for (const [k, slot] of metaInflight) {
    if (now - slot.at >= META_INFLIGHT_MAX_MS) metaInflight.delete(k)
  }
}

function metaOnce<T>(key: string, start: () => Promise<T | null>): Promise<T | null> {
  metaSweep()
  const running = metaInflight.get(key)
  if (running) return running.p as Promise<T | null>
  const at = Date.now()
  // IDENTITY-CHECKED, and that is what makes the sweep safe: a swept entry whose promise settles later
  // must not delete the slot of the attempt that replaced it. Annotated because the callback closes
  // over the very const it initialises.
  const p: Promise<T | null> = start().finally(() => {
    if (metaInflight.get(key)?.p === p) metaInflight.delete(key)
  })
  metaInflight.set(key, { p, at })
  return p
}

/**
 * NEGATIVE CACHING, and why it does not contradict "a FAILED extract is deliberately never cached".
 *
 * That rule is about the R2 RECORD, which is read back to build a card and lives for a day or thirty:
 * persisting a failure there would serve a wrong card long after the cause healed. This is a different
 * thing — an isolate-local note that the container was ALREADY ASKED about this exact key and answered
 * with nothing usable — and it exists because without it a single unroutable id is a FREE, UNLIMITED
 * container trigger: nothing about a failing id is cached anywhere (getPost caches only a non-null
 * Post, and renderPostRoute caches only a non-degraded response), so every request for it re-dispatched
 * `yt-dlp -J` on a page an attacker chose.
 *
 * SHORT, because a container that is merely overloaded answers exactly like an id that does not exist,
 * and this must not turn a transient pool failure into a minute of guaranteed failure cards on a real
 * post. 60s bounds a repeat-abuse loop to ~1 call/minute/isolate/id while a genuine post that failed on
 * a wedged instance self-heals on the next unfurl after it.
 *
 * NOT MARKED ON A TIMEOUT, deliberately: the deadline losing means the extract is still RUNNING, and
 * metaOnce already collapses the callbacks that arrive during it onto that same promise. Only the
 * work's own null answer marks — see metaAttempt.
 *
 * BOUNDED, because it is keyed by attacker-chosen input: a Map with no ceiling is a memory leak with a
 * public trigger. Oldest-inserted is evicted, which is a memory bound rather than a cache policy —
 * getting evicted early only costs one more container call, the state this fix started from.
 *
 * PER CONSUMER, NOT GLOBAL, and Facebook opting OUT is the reason the TTL is a parameter rather than a
 * constant read in here. The cost of remembering a failure is real — a genuinely transient container
 * error (an overloaded pool answers exactly like an id that does not exist) becomes a minute of
 * guaranteed failure cards for that id on that isolate — and it is worth paying where the dispatch is
 * otherwise unbounded. Facebook's is NOT newly unbounded: it shipped that way, its own tests pin
 * "a failed extract self-heals on the next unfurl" as a property, and quietly trading that away is a
 * judgement about a platform this change does not otherwise touch. It still gains the cap and the
 * in-flight dedupe below. The dedupe costs it nothing; THE CAP IS NOT FREE, and the earlier version of
 * this sentence claimed both were — see metaDispatchable, which now states what the shared cap can
 * actually take from a platform whose whole card comes from the container. Named here so the gap is a
 * decision on the record rather than something rediscovered from a "couldn't load" card.
 */
const META_FAIL_TTL_MS = 60_000
const FB_FAIL_TTL_MS = 0
const META_FAIL_MAX = 512
const metaFailed = new Map<string, number>()

function markMetaFailed(key: string, ttlMs: number): void {
  if (ttlMs <= 0) return
  if (metaFailed.size >= META_FAIL_MAX) {
    const oldest = metaFailed.keys().next().value
    if (oldest !== undefined) metaFailed.delete(oldest)
  }
  metaFailed.set(key, Date.now() + ttlMs)
}

function metaRecentlyFailed(key: string): boolean {
  const until = metaFailed.get(key)
  if (until === undefined) return false
  if (until > Date.now()) return true
  metaFailed.delete(key)
  return false
}

/**
 * MAY THIS REQUEST DISPATCH A CONTAINER META CALL? The one gate, so the three consumers cannot drift
 * into three different answers.
 *
 * `metaInflight.has(key)` FIRST, and it is not an optimization: joining an extract that is already
 * running adds NO container work, so refusing it under the cap would spend the cap on nothing and
 * degrade a card for free. The cap is a bound on how many extracts are STARTED, not on how many
 * requests may await one.
 *
 * SWEPT FIRST, because this is the reader the cap is spent at: an entry stranded by a cancellation is
 * a slot this function would otherwise hold against every key forever — see metaInflight.
 *
 * THE CAP IS SHARED AND UNPRIORITISED, and that is a KNOWN, MEASURED-AGAINST trade rather than an
 * oversight. The five consumers are not worth the same thing:
 *
 *   CARD-CRITICAL (fb, dm, st, im) — the container is the ONLY upstream. A refused extract is a
 *     "couldn't load" card. There is nothing to degrade to.
 *   ENRICHMENT (yt) — oembed already supplied title, channel and thumbnail, and the mux already
 *     supplies the video. A refused extract costs the TIMESTAMP and nothing else, and the next view
 *     fills it from R2 for 30 days.
 *
 * so a shared cap rations by arrival order, and YouTube asking for a date can in principle refuse
 * Facebook a card. PRIORITISING WAS TRIED AND BACKED OUT 2026-07-26: giving enrichment a ceiling of
 * SPECULATIVE_META_CAP - 1 (i.e. 1) made ANY other in-flight extract refuse the yt date, which broke
 * three existing tests and would refuse it routinely in production — trading a rare fb starvation for
 * a common yt regression. Doing it properly means retuning the cap itself, which wants its own
 * measurement and does not belong on a diff that auto-deploys to the apex.
 *
 * What IS corrected here is the claim above META_FAIL_TTL_MS that Facebook "gains the cap and the
 * in-flight dedupe, which cost it nothing". The dedupe is free; THE CAP IS NOT. Reaching it needs
 * SPECULATIVE_META_CAP + 1 distinct ids in flight on ONE isolate at one instant, so it is rare — but
 * when it happens the card is a "couldn't load", and someone will debug that as a container fault
 * unless this paragraph tells them otherwise.
 */
function metaDispatchable(key: string): boolean {
  metaSweep()
  if (metaRecentlyFailed(key)) return false
  return metaInflight.has(key) || metaInflight.size < SPECULATIVE_META_CAP
}

/**
 * The deduped, negative-cached extract for one ref. Never dispatches twice for one key at a time.
 *
 * THE TWO NULLS ARE TOLD APART HERE, and that split is the whole of the negative cache's honesty.
 * Before 2026-07-26 metaWork resolved null for BOTH, so a rejected or cancelled call — a container
 * that was merely slow, or work the isolate dropped after the response — was recorded as the id's own
 * negative answer and blocked re-dispatch for 60s, flatly contradicting metaRecentlyFailed's
 * "NOT MARKED ON A TIMEOUT, deliberately" four lines above it. The card stayed wrong AND the retry
 * that would have fixed it was refused.
 */
function metaAttempt<T>(
  ref: PostRef, env: Env, failTtlMs: number, work: () => Promise<T | null>,
): Promise<T | null> {
  const key = metaCacheKey(ref)
  return metaOnce(key, () => metaWork(ref, env, work).then(
    // THE WORK ANSWERED, and a null answer is the extract's own verdict — the page is gone, blocked or
    // unextractable. The only thing that may mark.
    got => {
      if (!got) markMetaFailed(key, failTtlMs)
      return got
    },
    // THE WORK NEVER ANSWERED — it threw, or it was cancelled. That is evidence about US, not about
    // the id, so it must NOT mark. Handled synchronously, in the same expression that creates the
    // promise, so a deadline-losing call nobody is awaiting can never be an unhandled rejection.
    () => null,
  ))
}

/**
 * WHY A META CALL CAME BACK EMPTY — a mutable OUT-parameter, FetchReport's shape and for FetchReport's
 * reason: the answer stays `T | null` (that null is what every caller branches on) while the one detail
 * it hides rides out beside it.
 *
 * ONE FIELD, because there is one distinction worth counting: `timedOut` means the container was still
 * working when our budget ran out, which is a fact about US. Every other null — no binding, a refused
 * dispatch, or the extract's own "no title" — is left unflagged. Optional and last, so the callers that
 * do not count (the mux paths, the tests that call these directly) are untouched.
 */
interface MetaReport {
  timedOut?: boolean
}

/**
 * THE GATE CHAIN FOR A CARD-CRITICAL META CALL — Facebook and the yt-dlp tier, which unlike YouTube get
 * their WHOLE card from the container.
 *
 * THERE IS NO VOUCH LINK HERE, and its absence is a fact rather than an oversight. youtubeMeta's
 * strongest gate is that oembed already answered for the id, which is free because oembed ran anyway;
 * dm/st/im have NO second upstream at all (that is the definition of this tier — the container is their
 * only source), and fb's metadata surface is decoyed from datacenter egress, so there is nothing
 * cheaper than the container itself to ask. What stands in for it, in order:
 *
 *   1. the R2 record (global, so the second unfurl anywhere costs nothing);
 *   2. a container binding at all;
 *   3. the NEGATIVE cache — an id that already failed cannot be re-dispatched for `failTtlMs`, which is
 *      what closes "one bogus id, unlimited free container calls". THE yt-dlp TIER ONLY: Facebook
 *      passes 0 and keeps its pre-existing self-heal-immediately behaviour, argued at FB_FAIL_TTL_MS;
 *      so on fb, links 4 and 5 are the whole of this defence and a rotating attacker pays only the cap;
 *   4. metaOnce — a burst on one id is ONE extract, however many requests arrive;
 *   5. SPECULATIVE_META_CAP — the bound on DISTINCT ids, i.e. on the flooding case the first three do
 *      not cover.
 * Residual per abusive request that satisfies all five: one `-J` (metadata only, no download), at most
 * one per id per minute per isolate.
 *
 * `ctx` IS OPTIONAL IN THE TYPE AND REQUIRED IN PRACTICE — see the waitUntil below for what it buys,
 * and Deps.fetchPost for why the parameter is optional (the .mjs stubs, and the exported liveFetchPost
 * that tests call directly, pass neither `report` nor this). A call without it still gets every answer
 * right; it just loses the keep-alive, which is what this whole shape exists for.
 */
async function cachedMeta<T>(
  ref: PostRef, env: Env, ctx: ExecutionContext | undefined, ttlMs: number, budgetMs: number,
  failTtlMs: number, valid: (j: unknown) => boolean, work: () => Promise<T | null>,
  report?: MetaReport,
): Promise<T | null> {
  const hit = await readCachedMeta<T>(ref, env, ttlMs, valid)
  if (hit) return hit
  // Checked HERE rather than left to the resolver's own null: with no binding no container call
  // happened, so this is not evidence about the id and must not poison the negative cache with it.
  if (!env.MEDIA_RESOLVER) return null
  if (!metaDispatchable(metaCacheKey(ref))) return null
  const attempt = metaAttempt(ref, env, failTtlMs, work)
  /**
   * KEPT ALIVE PAST THE RESPONSE, exactly as youtubeMeta and settleMux already do with their losing
   * work — and it was MISSING here until 2026-07-26, which made the deadline-losing case (the common
   * one on a cold container call) also the CANCELLED case. Three things followed from that, all fixed
   * by this one line:
   *   - the R2 write inside the raced work never happened, so "a call that loses the deadline still
   *     lands in R2 and the next unfurl is free" — the reason the write is inside metaWork at all —
   *     was not true on the path it was written for;
   *   - the cancelled promise never settled, so its metaInflight slot leaked (see metaInflight);
   *   - and the cancellation was mistaken for the id's own failure (see metaAttempt).
   * A deadline is not an abort: nothing is cancelled by losing the race, only waited for less.
   */
  ctx?.waitUntil(attempt)
  /**
   * WHICH KIND OF NULL THIS WAS, for the counter — and the flag is set from whether the ATTEMPT had
   * settled, not from what `deadline` returned, because deadline answers null for BOTH cases: the
   * extract's own "this page is gone" and our budget running out underneath a container that is still
   * working. Those are opposite claims about who is broken, and the single `assert_fail` they used to
   * share told the operator the upstream had changed shape. See the counting site in liveFetchPost.
   *
   * `answered` is flipped in a .then on the same promise the race awaits, so it is already true by the
   * time the await below resumes on the work's value — a later microtask cannot make a real answer look
   * like a timeout. metaAttempt never rejects (it attaches its own handler), so there is no second arm.
   */
  let answered = false
  const got = await deadline(attempt.then(v => { answered = true; return v }), budgetMs)
  if (!got && !answered && report) report.timedOut = true
  return got
}

/**
 * THE CONTENT ASSERTION on a stored meta record, shared by Facebook and the yt-dlp tier because it is
 * literally the same claim on both: a gone/blocked/unextractable page yields no title, and every one
 * of these platforms gets its whole card from the same `yt-dlp -J`. Named once so the two cannot drift
 * into disagreeing about what a usable record is.
 *
 * It is NOT the whole gate on the yt-dlp tier — a PLAYLIST passes this (an Imgur album carries a title
 * and nothing else), which is exactly why resolveYtdlpMeta refuses a non-video `_type` before a record
 * is ever written.
 */
const metaHasTitle = (j: unknown): boolean => {
  const t = (j as { title?: unknown } | null)?.title
  return typeof t === 'string' && t.length > 0
}

/**
 * `budgetMs` DEFAULTS TO THE CRAWLER'S, so a caller that says nothing gets exactly the behaviour that
 * shipped. Only the surfaces with a bigger ceiling of their own pass one — see META_TIMEOUT_API_MS.
 */
function cachedFacebookMeta(
  ref: Extract<PostRef, { p: 'fb' }>, env: Env, ctx?: ExecutionContext, budgetMs = META_TIMEOUT_MS,
): Promise<FacebookMeta | null> {
  return cachedMeta<FacebookMeta>(
    // FB_FAIL_TTL_MS is 0 — Facebook does NOT negative-cache, deliberately; see the constant.
    ref, env, ctx, FB_META_TTL_MS, budgetMs, FB_FAIL_TTL_MS, metaHasTitle,
    () => resolveFacebookMeta(ref, env),
  )
}

type YtdlpRef = Extract<PostRef, { p: 'dm' | 'st' | 'im' }>
/** The page the container is handed — a PURE function of the ref, which is what lets it prewarm. */
function ytdlpPageUrl(ref: YtdlpRef): string {
  return ref.p === 'dm' ? dmPageUrl(ref) : ref.p === 'st' ? stPageUrl(ref) : imPageUrl(ref)
}

/**
 * THE yt-dlp TIER'S metadata — Dailymotion, Streamable and Imgur. The SAME container call Facebook
 * makes ({page, meta:true} -> `yt-dlp -J`), the same slot affinity, the same never-cache-a-failure
 * rule. These platforms have no fetcher of their own precisely because this is the whole of their
 * upstream: measured 2026-07-26, all three extract a full card from the existing dict and all three
 * mux end to end.
 *
 * `_type` IS READ, and it is the reason container/server.py changed (hence g5). The content assertion
 * is "title is a non-empty string", which an Imgur ALBUM passes with a title and NOTHING else — no
 * thumbnail, no dimensions, no timestamp. Without this field the Worker cannot tell that apart from a
 * video, and would ship a bare headline over a video url resolving to nothing. It is carried as an
 * OPTIONAL field so a pooled pre-g5 instance degrades to the old behaviour rather than failing.
 */
async function resolveYtdlpMeta(
  page: string, slot: string, env: Env, mux?: MuxShortcut,
): Promise<YtdlpMeta | null> {
  const resolver = env.MEDIA_RESOLVER
  if (!resolver) return null
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
    // NO COOKIE JAR — this one call serves dm, st AND im, none of which gate anything behind a
    // login, so there is no pool to spend and nothing a session would unlock. Stated rather than
    // left to inference, because the shape is identical to YouTube's call, which does carry one.
    const r = await resolverStub(resolver, slot).fetch('http://media-resolver/resolve', {
      method: 'POST', body: JSON.stringify({ page, meta: true }), headers,
    })
    if (!r.ok) return null
    const j = await r.json() as Record<string, unknown>
    if (typeof j?.title !== 'string' || !j.title) return null
    // A PLAYLIST IS A FAILED EXTRACT, decided HERE as well as in the pure normalizer — so it is never
    // WRITTEN, and the next unfurl of that url is not served a title-only card out of R2 for a day.
    // An ABSENT _type is a pre-g5 pooled instance and stays renderable, which is the old behaviour.
    if (typeof j._type === 'string' && j._type !== 'video') return null
    const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
    const http = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined)
    /**
     * THE MUX SHORTCUT LEAVES BY THE OUT-PARAMETER, and that is the entire reason it is one.
     *
     * The record built below is what metaWork PERSISTS — read back for 30 minutes on Streamable and
     * 24 HOURS on Dailymotion and Imgur. A resolved format url is bound to the egress IP that
     * resolved it and expires in hours, so a record carrying one would serve a dead shortcut for most
     * of its life. Putting these two fields on YtdlpMeta instead would make that a `delete` somebody
     * has to remember on the write path; assigning them HERE, to an object the cache never sees,
     * makes it unreachable. The `mux_*` fields are OPTIONAL — a pre-g12 pooled instance omits them
     * entirely, and the container itself returns null for a livestream, an unknown duration, and an
     * age-gated source with no formats (see container/server.py's `_mux_sources`).
     *
     * A CALL THAT JOINS AN EXTRACT ALREADY IN FLIGHT GETS NO SHORTCUT — metaOnce hands it the first
     * caller's promise, and this holder belongs to the caller that started the work. It muxes from
     * the page, which is correct and merely slower; the shortcut is a cold-path optimisation and the
     * request that pays the cold path is the one that gets it.
     */
    if (mux) {
      const video = http(j.mux_video)
      // ffmpeg maps `0:v:0` and `1:a:0`, so audio without video is a broken argv rather than half a
      // shortcut. The normalizer refuses that pair too — this is the cheaper half of one rule.
      if (video) {
        mux.video = video
        const audio = http(j.mux_audio)
        if (audio) mux.audio = audio
      }
    }
    return {
      type: s(j._type), title: j.title, poster: http(j.thumbnail),
      uploader: s(j.uploader), uploaderUrl: http(j.uploader_url), description: s(j.description),
      w: n(j.width), h: n(j.height), duration: n(j.duration), timestamp: n(j.timestamp),
    }
  } catch {
    return null
  }
}

/**
 * PER-PLATFORM TTLs, because ONE of these three has a poster that expires.
 *
 * Dailymotion (s*.dmcdn.net) and Imgur (i.imgur.com) serve UNSIGNED thumbnails, so their records are
 * as immutable as Facebook's and get the same 24h.
 *
 * STREAMABLE DOES NOT. Its thumbnail is a signed CloudFront url carrying `Expires=`, measured twice
 * on 2026-07-26 with 1.2h and 1.83h of life left at capture. Cached for 24h, such a record would
 * serve a DEAD poster for most of its life — and invisibly from our side, because we only 302 to it.
 * 30 minutes is what makes the WHOLE chain fit, not just this one hop — the poster is copied into the
 * POST cache too, which has its own POST_TTL (900s). Worst case, in full: a record written at T is
 * still readable at T+30m, a Post built from it at that instant is cached until T+45m, and the
 * signature dies at T+72m on the shorter of the two measurements. ~27 minutes of margin. A 24h TTL
 * would blow that by an order of magnitude, and INVISIBLY from our side — we only 302 to the poster,
 * so nothing here ever observes it 403.
 *
 * The cost is one extra `-J` (metadata only, no download) per Streamable video per half hour,
 * globally; the alternative is a card whose picture is usually broken.
 */
const DM_META_TTL_MS = 86_400_000
const ST_META_TTL_MS = 1_800_000
const IM_META_TTL_MS = 86_400_000
const YTDLP_TTL: Record<'dm' | 'st' | 'im', number> = {
  dm: DM_META_TTL_MS, st: ST_META_TTL_MS, im: IM_META_TTL_MS,
}

/**
 * THIS IS A CONTAINER CALL ANY UNAUTHENTICATED REQUEST CAN TRIGGER, and every bound on it lives in
 * cachedMeta — read that gate chain before touching this. It matters more on this tier than anywhere
 * else in the file: there is NO cheaper upstream to vouch for the id first (the container is the tier's
 * only source, by definition), and the ids are short, so `/e/{2-16 alnum}` enumerates cheaply. Without
 * the gate, a loop over distinct ids saturates a 4-slot pool whose instances linger ~5 minutes and
 * degrades EVERY platform's card to a video-less still.
 */
function cachedYtdlpMeta(
  ref: Extract<PostRef, { p: 'dm' | 'st' | 'im' }>, env: Env, ctx?: ExecutionContext,
  budgetMs = META_TIMEOUT_MS, report?: MetaReport, mux?: MuxShortcut,
): Promise<YtdlpMeta | null> {
  // The slot is the POST (refKey), never the operation, so this call and the video mux for one ref
  // land on ONE container instance — see RESOLVER_SLOTS for the 74% measurement.
  const page = ytdlpPageUrl(ref)
  /**
   * `mux` IS AN OUT-PARAMETER AND IT RIDES PAST THE CACHE, NOT THROUGH IT — MetaReport's shape, for a
   * variant of MetaReport's reason: the answer stays `YtdlpMeta | null`, which is what every caller
   * branches on, while the volatile half travels beside it. Filled ONLY by a fresh container call
   * (see resolveYtdlpMeta), so an R2 hit leaves it empty by construction and the mux falls back to
   * the page — which is the honest answer for urls that are minutes to hours old.
   */
  return cachedMeta<YtdlpMeta>(
    ref, env, ctx, YTDLP_TTL[ref.p], budgetMs, META_FAIL_TTL_MS, metaHasTitle,
    () => resolveYtdlpMeta(page, refKey(ref), env, mux),
    report,
  )
}

/**
 * YOUTUBE'S UPLOAD DATE — the fix for the "every YouTube card says 1 January 1970" report, measured
 * live 2026-07-26 on the field that actually renders (created_at on the activity callback: 2 of 3
 * probed videos were the epoch).
 *
 * ONLY THE TIMESTAMP WAS STORED when this was written; the record has since grown a description, a
 * duration, counts, an age verdict and a liveness verdict. Every one of those but the last is as
 * immutable as the upload instant, which is what a 30-day TTL is buying.
 *
 * 30 DAYS, versus Facebook's 24h, on purpose: the values cannot change, and the TTL is exactly what
 * decides how often the one real latency trade below (a warm mux with a cold meta) can recur.
 *
 * EXCEPT FOR ONE FIELD — see YT_LIVE_TTL_MS, which is why the yt reads pass a function here rather
 * than this number. "The value cannot change" is the whole argument for 30 days and it stopped being
 * true of the whole record on 2026-08-29.
 */
const YT_META_TTL_MS = 30 * 86_400_000

/**
 * A RECORD THAT SAYS "LIVE" EXPIRES IN AN HOUR, NOT IN THIRTY DAYS.
 *
 * THE DEFECT, found in review 2026-08-29. `isLive` is the one mutable field on a YouTubeMeta record,
 * and it moves in the direction that costs a card: a stream ends and becomes an ordinary muxable VOD.
 * The record cannot heal itself, because nothing rewrites it — metaAttempt only runs on a read MISS,
 * and youtubeMeta returns null the moment the post carries a real date, which a live stream always
 * does (Innertube's microformat.publishDate). So under the flat 30-day TTL a stream that ended kept
 * saying "🔴 Live stream, so no preview here" on every render whose own Innertube call was refused —
 * about half of them from this egress — for up to a month, on a card that CACHES (the live arm sets
 * `rewritten`, not `degraded`, on purpose).
 *
 * ONE HOUR, and the number is bounded on both sides by things already measured here. Below: the flag
 * exists to cover the render path's Innertube coin flip across cold post-cache windows, and POST_TTL
 * is 900s, so an hour is four of them. Above: an expiry costs one cookie-free ~0.2s Innertube call
 * (resolveYouTubeMeta tries it before the container) and no container slot, and only on a render that
 * was going to make that call anyway — so the price of being wrong for less time is close to nothing.
 *
 * IT HEALS RATHER THAN JUST FORGETTING. When the record expires, youtubeMeta runs, Innertube is asked
 * again, and the answer is rewritten with a fresh verdict: `isLive: true` for a stream still running
 * (another hour), absent for one that ended (and then the 30-day TTL applies again, correctly). If
 * Innertube is refused and the container answers instead, the new record carries no liveness at all,
 * which is the honest "unknown" and exactly the behaviour that shipped before the flag existed.
 */
const YT_LIVE_TTL_MS = 3_600_000

/**
 * How long a stored YouTube record may be believed, given what it says. The only caller-visible shape
 * of the split above, kept in one place so the three yt read sites cannot disagree about it.
 */
const ytMetaTtl = (rec: YouTubeMeta): number => (rec?.isLive ? YT_LIVE_TTL_MS : YT_META_TTL_MS)
/**
 * `ageLimit` is OPTIONAL AND NOT PART OF THE VALIDITY TEST, deliberately. Records written before
 * g6 carry no such field and are still perfectly good dates; requiring it would throw away a
 * 30-day cache for a cosmetic marker. Absent simply means "not known to be gated".
 */
/**
 * THE WORKER'S COPY OF container/server.py's MAX_SECONDS, and the two MUST be kept equal.
 *
 * It is duplicated rather than derived because the container is reached over a binding, not imported —
 * there is no build step that could share a constant. The cost of them disagreeing is asymmetric and
 * worth knowing: too LOW here and a video that would mux fine is refused a mux it never attempts; too
 * HIGH here and the old behaviour returns, a full deadline burned to be told no.
 */
const MUX_MAX_SECONDS = 1500

type YouTubeMeta = {
  timestamp: number
  /** Seconds, from the container's dict. Absent on a record written before 2026-08-03 (g8 -> g9). */
  duration?: number
  /**
   * WAS IT AN UNFINISHED BROADCAST WHEN THIS RECORD WAS WRITTEN — present only when true, like
   * `jarred`, because absent already means "not known to be one".
   *
   * THE ONE FIELD HERE THAT IS NOT IMMUTABLE, and the only reason it is stored anyway is that the
   * alternative is worse: without it the second paste re-asks Innertube, which Cloudflare's egress
   * refuses on roughly half of requests (see resolveYouTubeMeta). So it is persisted AND it is the
   * LOSER of the merge — a fresh `isLive: false` off the render path beats it, and only a request
   * that got no answer at all falls back to it. See the yt arm in liveFetchPost.
   *
   * Written by the Innertube rung only. The container's `-J` dict does not forward `is_live`
   * (container/server.py's _meta_page), so a record from that rung simply carries no verdict — which
   * is correct rather than a gap: absent means unknown, and the rung that knows runs first.
   */
  isLive?: true
  ageLimit?: number
  /**
   * WAS THE EXTRACT THAT PRODUCED THIS RECORD LOGGED IN? Present only when true; absent means "no jar
   * was sent, or this record predates the field", and those are deliberately the same answer — both
   * mean the gate verdict on it is not one a credential has been tried against.
   *
   * It exists because `ageLimit` is the ONE field here whose correct value depends on the CALLER and
   * not on the video, and the record outlives the deployment that produced it by up to 30 days. See
   * ytMetaUsable for what is done with it, and the g10 note in the generation log for why this is not
   * itself a generation bump.
   */
  jarred?: true
  description?: string
  /** Counts, each ABSENT rather than zero when the platform withholds it — see ytCount. */
  views?: number
  likes?: number
  replies?: number
}

/**
 * A COUNT, OR NOTHING. yt-dlp reports null for a like count a channel has hidden and for a comment
 * count on a video with comments disabled, and those are NOT zero — a card saying "0 comments" on a
 * video where commenting is switched off is a confident lie, and the renderer already drops anything
 * that is not a positive finite number. So the absence is carried as an absence.
 *
 * Bounded on the way in for the same reason the description is clamped: this is stored for 30 days,
 * and a junk value read back from R2 outlives the response that produced it.
 */
function ytCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e15 ? Math.floor(v) : undefined
}

/**
 * HOW MUCH OF A YOUTUBE DESCRIPTION BECOMES CARD TEXT.
 *
 * A description is not a caption. They run to 5000 characters of chapter lists, sponsor blocks,
 * affiliate links and social handles, and NOTHING in src/render/ truncates Post.text — it would land
 * verbatim in the Mastodon `content` AND in og:description, turning a card into a wall.
 *
 * So the first paragraph, capped. That is the part that reads like a caption; everything after the
 * first blank line is reliably the boilerplate. Clamped HERE, at the worker boundary, rather than in
 * a renderer, because this value is STORED IN R2 FOR 30 DAYS — trimming at render time would keep
 * paying to store and read the 5000 characters we always discard.
 */
// MOVED to platforms/youtube/description.ts, because there are two sources for this field now — the
// container's extract and youtubei/v1/player — and both write the record. See that file for why one
// copy of the clamp matters when the value is stored for 30 days.
const ytDescription = ytDescriptionOf
/**
 * The content assertion for a stored/returned yt meta record. It is the SAME validator the value is
 * parsed with, so a record that would not render can never be written or read back — which matters
 * more here than anywhere else in this file, because a wrong value would be kept for 30 days.
 */
const ytMetaValid = (j: unknown): boolean =>
  typeof (j as YouTubeMeta | null)?.timestamp === 'number' &&
  uploadDateFrom((j as YouTubeMeta).timestamp) !== null

/**
 * THE SAME SHAPE CHECK, PLUS "COULD THIS ANSWER HAVE CHANGED SINCE IT WAS WRITTEN" — and it is the
 * READ side of the credential feature rather than a second validator.
 *
 * THE DEFECT, and it is the one a generation bump could not reach. g10 retired every record written
 * before the cookie CODE shipped. It cannot retire the records written after that deploy and before an
 * operator fills YT_ACCOUNTS, because those are g10 records — written by a jar-capable build that had
 * no jar to send. Every age-gated video viewed in that window persists `ageLimit: 18` for
 * YT_META_TTL_MS (30 days), on every colo. Filling the secret would then heal nothing: `youtubeMeta`
 * returns a warm record UNCONDITIONALLY before it will consider a container call, `ytMetaValid`
 * deliberately does not test `ageLimit`, and re-pasting reads the same record. The operator's own
 * `pool_unused` counter would meanwhile report the fresh accounts as dead, sending them to rotate
 * throwaways that were never the problem. That window is not an edge case — it is every day between
 * the g10 deploy and fill-day.
 *
 * SO THE GATE VERDICT IS TIED TO WHAT PRODUCED IT, which is the rule this project already states about
 * cache keys, applied one level in: a record is invalidated only when it SAYS GATED, was produced
 * WITHOUT a jar, and a jar is available NOW. All three, because each drops a cost the others do not:
 *   - ungated records (the overwhelming majority) are never touched, so ordinary traffic is unaffected;
 *   - with NO pool configured — every fork, every self-host, this repo until an operator fills a
 *     secret — nothing is invalidated at all, so merging this costs zero cache churn;
 *   - and a record written WITH a jar is trusted even though it says gated, because that is a measured
 *     answer ("logged in, still walled") rather than an unanswered question. Re-extracting those would
 *     spend a container call per gated video per cold view, forever, to re-learn the same thing.
 *
 * WHY A PREDICATE FACTORY rather than a check at each call site: `readCachedMeta` takes the validator,
 * and there are THREE reads of this record — the platform arm that builds the Post (so every renderer
 * and the post cache see it), `youtubeMeta` on the activity route, and the converter preview's own
 * fallback read. Putting the rule in the validator is what makes all three agree; a check bolted onto
 * one of them is exactly how this codebase got a head fixed and its twin left broken.
 *
 * ROTATING A DEAD POOL still needs a META_GENERATION bump — a `jarred` record that says gated is
 * trusted, and swapping in working accounts does not make it untrue-looking. That is the documented
 * rotation path and it is unchanged by this. META_GENERATION and not RESOLVER_GENERATION since the
 * 2026-08-29 split: the thing that has to go is the stored verdict, and the instances are innocent.
 */
const ytMetaUsable = (env: Env) => (j: unknown): boolean => {
  if (!ytMetaValid(j)) return false
  const m = j as YouTubeMeta
  return !(typeof m.ageLimit === 'number' && m.ageLimit > 0 && !m.jarred && jarAvailable(env, 'yt'))
}

/**
 * THE UPLOAD INSTANT OUT OF THE CONTAINER'S RAW DICT, in epoch seconds, from EITHER field.
 *
 * THE DEFECT THIS CLOSES, found 2026-08-04 from the report "YouTube links still show the epoch
 * occasionally when cold". yt-dlp builds `timestamp` ONLY from a timezone-bearing microformat, and
 * several of its YouTube player clients do not carry one. On those responses the dict is otherwise
 * complete — title, description, counts, duration, age_limit — with `timestamp: null` and
 * `upload_date: '20091025'` sitting beside it. Which client answers varies per request, which is
 * exactly why the symptom was intermittent on the same video.
 *
 * `timestamp` IS STILL PREFERRED. It carries a time of day; `upload_date` is a bare date and becomes
 * UTC midnight. Nothing renders a clock time so nothing displays wrong, but the stored record is what
 * a future consumer sorts by, so the more precise source wins whenever it exists.
 *
 * NOTE THE ASYMMETRY WITH ytMetaValid, which is deliberate and not an oversight: that one validates a
 * STORED record, which by construction always carries a numeric `timestamp` because this function is
 * what produced it. This one validates the WIRE dict, where the date arrives in two shapes.
 */
function ytDateSeconds(j: Record<string, unknown>): number | null {
  if (typeof j.timestamp === 'number' && uploadDateFrom(j.timestamp) !== null) return j.timestamp
  const fromDay = uploadDateFrom(j.upload_date)
  return fromDay ? Math.floor(fromDay.getTime() / 1000) : null
}

/**
 * THE CONTAINER ANSWERED AND WE COULD NOT USE IT — thrown rather than returned, and the difference
 * decides whether the retry that would fix the card is allowed to happen.
 *
 * metaAttempt reads a resolved `null` as "the extract's own verdict — the page is gone, blocked or
 * unextractable" and negatively caches the id for META_FAIL_TTL_MS. That is right for a real negative
 * and wrong for this one: a dict we rejected because OUR validator wanted a field is evidence about
 * US, not about the video. Read as a verdict it blocked re-dispatch for a minute per isolate — so the
 * one thing that could have healed the card was refused, on the strength of our own rejection.
 *
 * metaAttempt's rejection arm already says exactly this in its own words ("it threw, or it was
 * cancelled. That is evidence about US, not about the id, so it must NOT mark"), so this throw is
 * that existing vocabulary rather than a new mechanism. Nothing is written either way — there is no
 * record to write — so the only thing the throw changes is that the next view gets to ask again.
 */
class MetaUnusable extends Error {}

/**
 * HOW LONG THE ACTIVITY CALLBACK WILL WAIT for a cold date extract, and the ONE real trade in this
 * change. Read this before changing it.
 *
 * The activity route already awaits settleMux(MUX_WAIT_API_MS = 9000) for every yt post, so when the
 * MUX IS COLD this call runs inside a wait that is happening anyway and adds ZERO wall clock — the
 * card is right on the very first paste. When the mux is WARM and the meta is cold, this is real
 * added latency: up to 4s, at most once per video per 30 days, and for every already-muxed video in
 * the hours after this ships (all meta entries start cold). It loses gracefully — the work keeps
 * running in ctx.waitUntil and the write is INSIDE the raced work — so a call that misses the
 * deadline still lands in R2 and the next unfurl is free and correct.
 *
 * Measured cost of what it is waiting for: `yt-dlp -J` on YouTube is 2.3-6.7s (5 runs, 2026-07-26;
 * the tail is the 4K/multi-format case). A bogus id fails in 1.9s. No download — -J is metadata only.
 *
 * THE "MUX_WAIT_API_MS = 9000" ABOVE IS STALE, twice over — annotated rather than deleted, because
 * the `yt-dlp -J` measurement it sits under is still the best data on record. 553bd2e cut the
 * activity route's mux wait to MUX_WAIT_BOT_MS (1500) and did not rewrite this paragraph, which is
 * how the "adds ZERO wall clock" argument outlived the thing that made it true. And since 2026-08-29
 * this constant does not bound the activity route's date arm at all: that call site wraps it in
 * `deadline(…, YT_META_BOT_MS)` (4000), and 8000 now governs only /_card and /_api/v1. The
 * zero-wall-clock property is back on the activity route as of the same day, by a different route —
 * YT_MUX_BOT_MS (4000) is level with YT_META_BOT_MS (4000), so on a cold yt paste the date arm again
 * finishes inside a wait the mux arm is spending anyway. Everything below is unchanged and still true.
 *
 * IF THIS IS EVER JUDGED UNACCEPTABLE, the knob is 0: that reduces the design to "right on the next
 * view" with no other change, because the write is already inside the raced work.
 */
// RAISED 4000 -> 8000, 2026-08-01, because 4000 was under the thing it waits for. The comment above
// records the measurement — `yt-dlp -J` is 2.3-6.7s — so the deadline sat INSIDE the distribution and
// the FIRST activity callback, the only one a first paste gets, fell through to the epoch. Reproduced
// on cold ids: call #1 renders 1 January 1970, call #2 seconds later is correct, from the record the
// abandoned call wrote in ctx.waitUntil. That is the reported bug, and it self-heals, which is
// exactly why it survived this long.
//
// IT DOES NOT RAISE THE ROUTE'S CEILING. The same Promise.all already awaits settleMux at
// MUX_WAIT_API_MS = 9000, so on a first paste — where the mux is cold by definition — this waits
// inside a wait that is happening anyway and costs zero wall clock. It costs real latency only in the
// warm-mux/cold-meta case, at most once per video per 30 days.
//
// THAT CEILING SENTENCE IS STALE ON THE ACTIVITY ROUTE, annotated 2026-08-29 and left in place because
// the 2026-08-01 measurement above it still stands. It is still right about /_card and /_api/v1, which
// do await settleMux on MUX_WAIT_API_MS = 9000. It stopped being right about the ACTIVITY route at
// 553bd2e, which took that settleMux to 1500 and left this 8000 towering over the budget it was
// supposed to hide inside. The activity route now bounds this arm at YT_META_BOT_MS (4000) against a
// mux arm of YT_MUX_BOT_MS (4000), so "inside a wait that is happening anyway" is true there again —
// with different numbers, and for a reason this comment does not give.
const META_WAIT_API_MS = 8000

/**
 * WHAT A CRAWLER WILL ACTUALLY WAIT, which is the number every budget above was missing.
 *
 * The seams Discord fetches were tuned to be RIGHT on the first paste: the HTML head spends up to
 * HTML_DEADLINE_MS (5000) on the mux, and the activity callback spends MUX_WAIT_API_MS (9000) on the
 * mux, META_WAIT_API_MS (8000) on the date, and a translation slice, all concurrent. Each of those is
 * individually argued and internally consistent. Together they answer a cold YouTube post in ~5.1s on
 * the head and ~8.2s on the activity document, and DISCORD IS GONE BY THEN — reported from production
 * 2026-08-08 as YouTube links that "fail to embed until warmed on the site", which is exactly what a
 * crawler timeout looks like from the outside.
 *
 * MEASURED, on four cold videos of 28s, ~60s and 615s (2026-08-09, against production):
 *
 *   card, fully cold          5.14 - 5.18s   no media on it
 *   activity document, cold   8.19 - 8.29s
 *   card, second view         0.19 - 0.29s   with og:video
 *
 * THE WAIT BUYS ALMOST NOTHING ON A COLD PASTE, which is what makes this a cut rather than a trade. A
 * WARM mux is an R2 head — MUX_WAIT_FLOOR_MS's comment sizes that at 300ms — so a shortened ceiling
 * cannot cost a video that already exists. A COLD mux measured ~5s for a 60-second Short (verified by
 * fetching /_media/ the moment the 5.1s card returned: 6,472,085 bytes, already complete), so no
 * budget a crawler tolerates was ever going to catch it. The old ceiling spent five seconds to lose
 * the same race it loses in one.
 *
 * NOTHING IS ABANDONED — FALSE AS WRITTEN, corrected 2026-08-29, and one of the two claims this cut
 * rested on. Both the mux and the meta extract do run under ctx.waitUntil with their R2 write INSIDE
 * the raced work; what was wrong is what waitUntil buys. Cloudflare cancels every unsettled waitUntil
 * promise 30 seconds after the response, on a budget SHARED across the whole request (settleMux's
 * alarm comment carries the 2026-08-23 diagnosis), and the yt mux distribution is a median of 18.2s
 * with a p90 of 41.3s — so most of the muxes this paragraph promised would "land the record" were
 * killed with zero bytes written and restarted from byte zero on the next render. What makes the
 * design "right on the next view" today is the MuxRunner DO alarm (15 min), armed BEFORE the race for
 * exactly this reason. The claim still holds for the meta extract, which costs seconds, not minutes.
 *
 * THE COST, STATED EXACTLY, because the imprecise version of it is flattering. A first paste of a cold
 * video shows the card with its THUMBNAIL instead of an inline player, without the counts, and dated
 * THE EPOCH rather than undated -- createdAt is a Date and the Mastodon document always emits one, so
 * an unknown date renders as 1 January 1970. Every later view has the player, the counts and the real
 * date, from the records the abandoned calls wrote under ctx.waitUntil.
 *
 * That 1970 is the same sentinel Facebook cards already ship to Discord in production for every post
 * (facebook/normalize.ts argues it: an absent date beats a guessed one), so it is not a new shape --
 * but it IS a visible wrong-looking date, and CLAUDE.md records the YouTube epoch as a reported bug
 * once already. It is accepted here only because the alternative it replaces is NO CARD AT ALL. The
 * clause that used to follow — "and because it lasts exactly one view" — IS FALSE, corrected
 * 2026-08-29: Discord stores the embed inside the message and never re-unfurls it
 * (discord-api-docs#1663, already cited by fetchretry.ts, twitter/fetch.ts, youtube/innertube.ts and
 * analytics.ts in this same tree), so the first paste is the only paste and a wrong date is frozen in
 * that message forever. That is the second claim this cut rested on, and it cuts both ways: it is why
 * these budgets are worth raising at all, and why losing the bet is permanent.
 * Suppressing the field when the date is unknown is the real fix
 * and is NOT done here: Discord is the consumer, a Mastodon document missing a required field may be
 * rejected outright, and rejecting it reintroduces precisely the bug this constant exists to remove.
 * That change wants its own measurement against a live unfurl.
 *
 * NOT APPLIED TO /_api/v1 OR /_card. Those are read by the converter page with a human watching a
 * spinner, and they are the surface that WARMS a link deliberately; shortening them would make the
 * page worse at the one job it has. They keep MUX_WAIT_API_MS.
 *
 * NO LONGER THE ONLY BOT BUDGET, and both costs stated above are the part that moved. This still
 * bounds the HTML head on every platform, the translation on the activity document, and the mux on
 * every platform except YouTube — but the activity document split away from it twice on 2026-08-29.
 * Its DATE arm went to YT_META_BOT_MS, because 1500 sat under that call's own measured median. Its
 * MUX arm went to YT_MUX_BOT_MS on yt only, because the production counters say 0 of 139 successful
 * yt muxes have ever finished inside 1500ms — "the wait buys almost nothing", measured, turns out to
 * read "the wait cannot buy anything". Read both constants before assuming one number governs this
 * route. The five-second cold-mux measurement above was taken on the HEAD, which is the seam this
 * constant still governs; YT_MUX_BOT_MS is where the activity seam's version of it is re-argued.
 */
export const MUX_WAIT_BOT_MS = 1500

/**
 * THE SAME CRAWLER BUDGET, FOR THE METADATA ARM ONLY — because one number was bounding three arms
 * whose measured costs are not the same size.
 *
 * WAS: MUX_WAIT_BOT_MS, 1500ms, shared by all three arms of the activity route's Promise.all since
 * 553bd2e. THEN: 2800ms on the metadata arm. NOW: 4000ms; the translation keeps 1500. The mux arm split
 * the same day and did NOT keep 1500 — see YT_MUX_BOT_MS, which is 4000 on yt. Since 2026-08-30 this
 * arm is LEVEL with it rather than under it, which keeps the response max unchanged; see below.
 *
 * WHY IT WAS WRONG, from the metadata call's OWN recorded distribution (innertube.ts, measured against
 * production on nine unseen ids immediately after the 1200 -> 2500 deploy):
 *
 *   innertube OK    n=3   min  281ms  median 1716ms  max 1723ms
 *   innertube MISS  n=5   min 1661ms  median 1754ms  max 1912ms
 *
 * 1500 is BELOW THE MEDIAN COST OF A SUCCESS. The arm was cut off before the middle of its own
 * hit distribution, so the "second attempt per paste" that reaching Innertube from resolveYouTubeMeta
 * was built to buy (see its docstring: the render already tried, this route tries again seconds later)
 * was throttled under the price of the thing it was buying. Worse, innertube.ts's hard abort is
 * INNERTUBE_TIMEOUT_MS = 2500: under a 1500 budget this arm could not observe even a successful second
 * attempt finish, ever, for any video. 2800 was that 2500 plus 300 — MUX_WAIT_FLOOR_MS's size, which is
 * what an R2 read costs — so the warm-record read in front of the call fits and the call itself still
 * clears its own abort. It is deliberately NOT written as `INNERTUBE_TIMEOUT_MS + MUX_WAIT_FLOOR_MS`:
 * the two bound different things (that one aborts a single fetch in another module; this one bounds a
 * whole arm that may also fall through to the container), and coupling them would make a change to
 * either read as a change to both.
 *
 * WHY 4000, RAISED FROM 2800 ON 2026-08-30, AND WHY THE RAISE IS FREE. The three arms race in one
 * `Promise.all`, so the response ends at the SLOWEST of them and the number that matters is the max,
 * not the sum. The mux arm is already YT_MUX_BOT_MS (4000) on this exact route. Taking the date arm
 * from 2800 to 4000 therefore moves the max by ZERO on any card whose mux arm is running, which is
 * every ordinary cold paste. It buys the arm 1.2 more seconds of the wait that was happening anyway.
 *
 * WHAT IT BUYS, AND WHY 2800 WAS THE WRONG SIZE FOR THIS ARM'S SECOND HALF. When the render's own
 * Innertube call is refused, this arm falls through to the container's `yt-dlp -J`. That extract is
 * 3.1-4.7s on standard-2 (measured 2026-08-28, see the container notes). 2800 sits UNDER the whole of
 * that range, so on the path where Innertube failed the fall-through could essentially never land and
 * the card rendered the epoch. 4000 reaches into it. This is the same shape of error as the
 * 1500-under-a-1716ms-median above, one level down: a budget sized against the FIRST source while the
 * arm's actual cost on the failing path is the SECOND one.
 *
 * HOW OFTEN THAT PATH IS TAKEN: `yt_innertube_fail` 324 vs `yt_innertube_ok` 293 all-time, and
 * 170 vs 182 over the 24h to 2026-08-30. It is a coin flip, not the "9 of 10" an earlier note
 * claimed. So about half of cold pastes depend entirely on this fall-through for their date.
 *
 * THE FOLKLORE BOUND IS NO LONGER THE REASON FOR THE NUMBER, because it finally got tested. 2800 was
 * chosen "to stay inside the 3-4s everyone assumes is Discord's abandon point" while admitting in the
 * same breath that NOBODY HAS EVER MEASURED THAT 3-4s (META_TIMEOUT_MS: "a separate measurement about
 * Discord's tolerance that nobody has taken"; META_TIMEOUT_API_MS: "how much a crawler will tolerate
 * there is unmeasured"). On 2026-08-30 the owner pasted a cold `youtu.be/MsqhUjjkDjI` into a real
 * Discord client against this deployed build. THE CARD DREW, with a player, at an activity document
 * measured at 4.03-4.15s across 15 probes the same hour. That is the first real-client observation on
 * this seam in the project's history and it falsifies "Discord leaves at 3-4s" for this document. It
 * is ONE observation and it does not license 9000; it licenses staying level with the mux arm, which
 * is where the response already ends. Do not read it as headroom above 4000.
 *
 * WHAT IT COSTS WHERE IT IS NOT FREE, stated because "free" is only true while the mux arm runs. When
 * settleMux REFUSES to dispatch — a live stream, or a video over MUX_MAX_SECONDS — the mux arm returns
 * in ~0.1s and this arm alone decides the response. Such a card with no cached date now takes 4000ms
 * instead of 2800ms. That is the one regression in the change, it is bounded by this constant, and it
 * is paid exactly where the reader would otherwise be shown 1 January 1970.
 *
 * WHAT IT COSTS, BOUNDED. youtubeMeta's first gate returns null the instant the post already carries a
 * real date, before any R2 GET or container call — so the common warm path never enters this budget
 * at all and the response still ends wherever the mux arm ends it, unchanged. The extra 1.3s is paid
 * only where the RENDER's own Innertube call was refused, which the 2026-08-27 measurement across 22
 * unseen ids puts at a bit over half of cold pastes (that call succeeds 40-50% of the time). Once per
 * video: the record is written for 30 days and the gate above closes for good.
 *
 * Losing this race still writes: `deadline` leaves the loser running and metaWork's R2 put is inside
 * the raced work, exactly as it was at 1500.
 */
export const YT_META_BOT_MS = 4000

/**
 * THE MUX ARM'S OWN CRAWLER BUDGET, on the one document and the one platform where that arm decides
 * whether Discord draws a PLAYER or a photo — and the only budget in this file that can lose a card
 * outright. Read all of this before moving it.
 *
 * WAS: MUX_WAIT_BOT_MS, 1500ms, on both crawler seams for every platform, since 553bd2e collapsed a
 * 5000/9000 split into one number. NOW: 4000ms, on the yt ACTIVITY document only. The HTML head keeps
 * 1500, the /_oembed callback keeps 1500, and every other platform keeps 1500 on both.
 *
 * WHY 1500 COULD NOT WIN. Analytics Engine, `mbedfx_counters`, every `mux_ok` row with blob1='yt'
 * since the counter went live 2026-08-24, n=139, weighted by `_sample_interval`:
 *
 *   p10 6922ms   p50 18219ms   p90 41254ms   min 4200ms   max 168851ms
 *
 *   finished within 1500ms:   0 of 139     <- the budget this replaces
 *   finished within 5000ms:   4 of 139
 *   finished within 9000ms:  23 of 139     <- the budget 553bd2e replaced
 *
 * ZERO. Not a poor hit rate — an arithmetically lost race, on the arm that sets
 * `media_attachments[].type`. The fastest yt mux ever recorded is 4200ms against a budget of 1500, so
 * no cold YouTube first paste has ever been able to carry a video, and Discord freezes the embed in
 * the message (see MUX_WAIT_BOT_MS's correction), so the first paste is the only one. `card_degraded`
 * against `ok` on blob1='yt', blob3='discord' reads 336/583 all-time, and runs about 1:1 in the hours
 * real pastes actually happened — the all-time ratio is flattered by the smoke cron, which renders
 * with a Discordbot UA off a warm mux and so can only ever add to the `ok` side (src/smoke.ts).
 *
 * WHY 4000 AND NOT MORE — the ceiling first. The one number in this repository derived from Discord's
 * own behaviour is the 2026-08-09 production run: a cold head answered in 5.14-5.18s and the reader
 * got NO CARD. Whatever the crawler's per-request tolerance is, it is under 5.14s. 4000 plus this
 * route's own work — a post-cache read and a JSON serialise — lands the response near 4.2-4.3s, which
 * is the last value that clearly sits inside that bound. 8000 does not: it rebuilds the 8.19-8.29s
 * activity document 553bd2e deleted, on the strength of the same production report ("YouTube links
 * fail to embed until warmed on the site"). The widely-quoted "Discord leaves at 3-4s" is NOT a
 * measurement — that phrase appears once in this repository and cites nothing — so it is not what
 * bounds this number; 5.14s is.
 *
 * AND WHY 4000 IS A TOLERANCE STEP, NOT A WIN. The mux does not start from zero here: it is
 * dispatched during the HTML head render, and Discord cannot request this document until it has
 * parsed that head, so roughly 1-2s of head plus gap is already on the clock when this deadline
 * fires — call it 5-6s of real extract time. Against the table above that is the fast tail and
 * nothing more, perhaps 5 of 139. What it buys is a race that CAN be won (min 4200ms) in place of one
 * that cannot, and a reading on Discord's tolerance that no budget in this file currently has. Anyone
 * quoting the p50 as the thing this catches has read the headline and not the arithmetic.
 *
 * WHAT IT RISKS, and this is a real trade rather than a freebie. Today's failure is a frozen card
 * that still carries the title, the description, the thumbnail and the link. An ABANDONED activity
 * fetch is worse than a missing upgrade, because renderSpoof emits NO og:image on any post with
 * usable media (the C1 suppression in render/discord.ts) and a yt post ALWAYS has usable media — so
 * the thumbnail reaches Discord only through this document. Lose it and the head alone is a title, a
 * colour stripe, and a description only where the render's own Innertube call was not refused, which
 * is about half of cold pastes. No image, no player, frozen in that message forever.
 *
 * WHAT IT COSTS WHEN IT WINS: nothing. settleMux races muxOnce through `deadline`, which returns the
 * instant muxOnce does, so a WARM mux still costs one R2 head (MUX_WAIT_FLOOR_MS sizes that at 300ms)
 * and the re-pastes that are the overwhelming majority of unfurls are untouched. The extra wait is
 * paid only on the cold pastes that are already failing.
 *
 * IT ALSO MAKES THE DATE ARM FREE AGAIN. YT_META_BOT_MS is 4000, LEVEL with this, so on a cold paste the
 * metadata arm once more finishes inside a wait that is happening anyway — the "adds ZERO wall clock"
 * property META_WAIT_API_MS's comment claims and 553bd2e silently removed.
 *
 * WHAT WOULD JUSTIFY GOING PAST 4000, and it is an experiment rather than an argument: make this
 * route sleep N seconds for one ref, paste that link into a real Discord client, and record what
 * draws at N = 3, 5, 8, 12. That measures the crawler's actual per-request tolerance AND what an
 * abandoned activity fetch renders — the two things every budget on this seam currently guesses at,
 * using the same human-with-a-client oracle the head parity work used. Until someone runs it, the
 * instrument is `card_degraded/ok` on blob1='yt', blob3='discord': if the raise works that ratio
 * falls. If Discord is bailing instead, it will NOT show up there — a degrade we render is not an
 * abandon — so pair it with client disconnects on this route.
 *
 * The counters, the queries and the archaeology on 553bd2e are written up once, in
 * docs/research/2026-08-29-the-1500ms-crawler-cut.md. Read that before changing this number.
 */
export const YT_MUX_BOT_MS = 4000

/**
 * The container call. IDENTICAL SURFACE to resolveFacebookMeta's — `{page, meta:true}` through the
 * same binding, the same secret, and the same refKey slot so this call and the video mux for one
 * video land on ONE already-booted instance (the 74% affinity fix). container/server.py's _meta_page
 * is platform-agnostic (it just runs `yt-dlp -J` on the page it is given) and has returned
 * `timestamp` since g3, so YOUTUBE'S DATE NEEDED NO CONTAINER CHANGE.
 *
 * VALIDATED BEFORE USE **AND** BEFORE WRITE. A pooled instance still running a pre-g3 image has no
 * `timestamp` in its dict; nothing validates, nothing is cached, no date, no throw, and it self-heals
 * when that instance idles out. Trusting the field instead would persist a hole for 30 days.
 */
async function resolveYouTubeMeta(ref: Extract<PostRef, { p: 'yt' }>, env: Env): Promise<YouTubeMeta | null> {
  /**
   * INNERTUBE FIRST, AND THIS IS WHAT MAKES THE DATE STICK RATHER THAN BEING RE-ROLLED EVERY PASTE.
   *
   * `fetchYouTube` already asks `youtubei/v1/player` on the render path, which is what stopped the
   * cards saying 1 January 1970. But that answer was deliberately not persisted, so every cold paste
   * was an INDEPENDENT attempt — and measured against production on 2026-08-27, across 22 ids the
   * service had never seen, that attempt succeeds only about 40-50% of the time. Not a timeout: the
   * post fetch returns in ~250ms and the ~1750ms card is `settleMux` waiting out MUX_WAIT_BOT_MS
   * afterwards. Not a bad video either: every failing id answers perfectly from a residential IP,
   * same request, same minute. Cloudflare's egress is simply refused on some fraction of requests,
   * and neither raising the budget (1200ms -> 2500ms) nor adding a second client moved the ratio.
   *
   * A COIN FLIP THAT IS RE-ROLLED FOREVER IS A DIFFERENT BUG FROM A COIN FLIP THAT STICKS. Reaching
   * it from HERE puts the answer through `metaAttempt` -> `metaWork`, which writes the record to R2
   * for 30 days — so one success anywhere, on any paste, in any colo, fixes that video permanently
   * for everyone. It also buys a SECOND attempt per paste at no extra cost, because the activity
   * route calls this seconds after the render already tried.
   *
   * AND IT IS TRIED BEFORE THE CONTAINER ON PURPOSE. The container's `yt-dlp -J` is the thing that
   * has not completed a request-scoped call since ~2026-08-18 (every MediaResolver invocation ends
   * `canceled` at 1.3-1.8s), it costs a slot from a pool of four shared by ten platforms, and it
   * takes 15.9s from this egress against Innertube's ~0.25s. It stays as the fallback because it is
   * the rung that carries a cookie jar, which is the only thing that can answer an age-gated id.
   */
  const quick = await fetchInnertube(ref.id)
  const quickAt = quick?.uploadedAt === undefined ? null : uploadDateFrom(quick.uploadedAt)
  if (quick && quickAt) {
    return {
      timestamp: Math.floor(quickAt.getTime() / 1000),
      ...(quick.duration === undefined || quick.duration >= 86_400 ? {} : { duration: quick.duration }),
      // ONLY WHEN TRUE, so the absence keeps meaning "unknown" for every record the container rung
      // and every pre-2026-08-29 write produced. This is what makes the SECOND paste of a live stream
      // free: the render path's own Innertube call is refused about half the time from this egress,
      // and without the record that coin is re-flipped on every cold post fetch.
      ...(quick.isLive ? { isLive: true as const } : {}),
      ...(quick.ageLimit === undefined ? {} : { ageLimit: quick.ageLimit }),
      ...(quick.description === undefined ? {} : { description: quick.description }),
      ...(quick.views === undefined ? {} : { views: quick.views }),
      // NO `jarred`, deliberately, and not an oversight: this rung sends no cookie. ytMetaUsable
      // reads the flag's ABSENCE as "the gate verdict on this record is not one a credential has been
      // tried against", which is exactly true here — so an age-gated id still falls through to the
      // container on a deployment that has a pool, and an ungated one is kept. Writing `jarred` here
      // would claim a credential was spent that never was.
    }
  }

  const resolver = env.MEDIA_RESOLVER
  if (!resolver) return null
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
    // THE JAR RIDES THE META CALL AS WELL AS THE MUX, and it is not redundant: an age-gated video
    // answers this `-J` with `age_limit: 18` and `formats: 0` (measured on G0sORVBL4kM, 2026-07-30),
    // so cookie-free the record we PERSIST for 30 days says "gated" whatever the mux later manages.
    // No pool set -> no `cookies` key at all, and this is byte-for-byte the call it has always been.
    // ASKED OF THE BODY, not of the pool, and that is the point: `withCookieJar` is the one place a
    // credential crosses the wire and it picks from the pool at RANDOM, so "is a pool set" is not the
    // same question as "did THIS call carry a jar". Reading it back off the body keeps the record's
    // provenance honest without a second copy of the picking logic — and without a second place a
    // cookie could be handled. See ytMetaUsable for what the flag is for.
    const body = withCookieJar({ page: ytPageUrl(ref), meta: true }, env, 'yt')
    const jarred = 'cookies' in body
    const r = await resolverStub(resolver, refKey(ref)).fetch('http://media-resolver/resolve', {
      method: 'POST', body: JSON.stringify(body), headers,
    })
    if (!r.ok) {
      // SERVER-SIDE ONLY (wrangler tail), ref-only like ensureMuxed — and NO analytics counter: yt's
      // assert_fail already means "oembed missed", and mediaproxy.ts's precedent is explicit that
      // folding an unrelated event into an existing counter blunts the alert that matters.
      console.error('yt meta failed', refKey(ref), r.status)
      return null
    }
    const j = await r.json() as Record<string, unknown>
    const seconds = ytDateSeconds(j)
    if (seconds === null) {
      /**
       * THE EXTRACT SUCCEEDED AND CARRIED NO USABLE DATE IN EITHER FIELD. Rare once `upload_date` is
       * forwarded — yt-dlp keeps it when `timestamp` fails — so reaching here means something changed
       * upstream, which is exactly when somebody needs to be told.
       *
       * NOT CACHED, deliberately. A record with no date would keep its description and counts for 30
       * days at the cost of never asking for the date again, and this project's rule is that a
       * degraded answer must not be the one that sticks. Thrown rather than returned so the negative
       * cache does not treat our own rejection as the video's verdict — see MetaUnusable.
       *
       * SERVER-SIDE ONLY, matching the `!r.ok` line below. There is no counter for it yet and that is
       * a known gap: with Workers Logs off this is visible under `wrangler tail` and nowhere else, so
       * a counted outcome is the follow-up.
       */
      console.error('yt meta had no usable date', refKey(ref),
        `timestamp=${String(j.timestamp)} upload_date=${String(j.upload_date)}`)
      throw new MetaUnusable('no usable upload date')
    }
    // age_limit rides along when the container reports one. Narrowed to a finite number rather than
    // passed through: this value is STORED FOR 30 DAYS, and a junk field read back from R2 would
    // reach the renderer long after the response that produced it is gone.
    const age = j.age_limit
    const ageLimit = typeof age === 'number' && Number.isFinite(age) ? age : undefined
    // The description rides along on the SAME record, and the container has been sending it all
    // along — container/server.py's _meta_page has carried `description` since Facebook needed it.
    // Nothing consumed it here, so every YouTube card has rendered with an empty body since the
    // platform shipped. Narrowed and clamped for the same reason ageLimit is narrowed: this is kept
    // for 30 days, and junk read back from R2 outlives the response that produced it.
    const description = ytDescription(j.description)
    const views = ytCount(j.view_count)
    const likes = ytCount(j.like_count)
    const replies = ytCount(j.comment_count)
    /**
     * AN UPPER SANITY BOUND, ADDED WHEN THIS FIELD GOT A SECOND JOB.
     *
     * It used to decide one sentence on the card ("too long to play here"). It now also decides
     * whether settleMux dispatches a mux at all, and that verdict is response-cached — so a junk
     * duration (a premiere, a live replay, an extractor quirk reporting a scheduled window) costs the
     * PLAYER for the whole TTL rather than a wrong line of prose. A day is not a long video, it is a
     * bad reading; refusing to store it keeps the old behaviour instead of inventing a new failure.
     */
    const duration = typeof j.duration === 'number' && Number.isFinite(j.duration)
      && j.duration > 0 && j.duration < 86_400
      ? j.duration : undefined
    return {
      // `seconds`, not `j.timestamp` — the two differ on exactly the responses this fix is about, and
      // reading the raw field here would re-introduce the bug one line below where it was fixed.
      timestamp: seconds,
      ...(duration === undefined ? {} : { duration }),
      ...(ageLimit === undefined ? {} : { ageLimit }),
      // ONLY WHEN TRUE, never `jarred: false`. Absent already means "not known to be logged in", which
      // is the same thing a pre-2026-08-03 record means, so storing the negative would put a field in
      // R2 for 30 days to say what its absence says — and would make the two spellings of one state
      // something every reader has to tell apart.
      ...(jarred ? { jarred: true as const } : {}),
      ...(description === undefined ? {} : { description }),
      ...(views === undefined ? {} : { views }),
      ...(likes === undefined ? {} : { likes }),
      ...(replies === undefined ? {} : { replies }),
    }
  } catch (err) {
    // MetaUnusable MUST NOT BE SWALLOWED HERE. This catch exists to turn a network or JSON failure
    // into "no answer"; folding our own deliberate rejection into that same null would hand it to
    // metaAttempt as the extract's verdict and negatively cache the id for a minute — which is the
    // amplifier this change exists to remove. Re-thrown so the rejection arm, which does not mark,
    // is the one that runs.
    if (err instanceof MetaUnusable) throw err
    return null
  }
}

/**
 * The upload instant for an ACTIVITY render, or null. Every no degrades — the date is enrichment.
 *
 * THE GATE CHAIN, all ANDed, and each link is load-bearing:
 *   1. an actual yt ref, on the ONLY route whose output has a date field (toOEmbed has none, and the
 *      HTML head emits no date tag at all — so the first paste is untouched and strictly faster).
 *   2. both container bindings present.
 *   3. the post does not already carry a real date — the steady state after liveFetchPost's
 *      cache-only read fills it. Costs neither an R2 GET nor a container call.
 *   4. the R2 entry is absent / stale / invalid.
 *   5. THE VOUCH — oembed answered for this id (youtubeVouched). YouTube's own existence check, free
 *      (oembed already ran), a CONTENT assertion, and it survives the post cache because it is
 *      derived from the cached Post. Strictly stronger than the post-cache-hit gate the yt mux
 *      prewarm uses, which is weak here: normalizeYouTube never returns null, so any 11 legal chars
 *      earn a post-cache entry on request #1.
 *   6. metaDispatchable — SPECULATIVE_META_CAP, the negative cache, and metaOnce so duplicate callbacks
 *      for one video share one extract. The SAME gate the card-critical platforms use (see cachedMeta):
 *      one bound for one container pool, rather than a bespoke cap here that drifts from theirs. It is
 *      also slightly more permissive than the bare `size >= cap` it replaces, in the one case that
 *      costs no container work — a callback joining an extract already running for its own key.
 * Residual per abusive request that satisfies all six: one ~2s `-J` with no download.
 */
async function youtubeMeta(
  ref: PostRef, post: Post, env: Env, ctx: ExecutionContext,
): Promise<YouTubeMeta | null> {
  if (ref.p !== 'yt' || !env.MEDIA_RESOLVER || !env.MEDIA_CACHE) return null
  // THE EARLY RETURN STILL KEYS ON THE DATE ALONE, deliberately. It is the "we already have what this
  // call would fetch" test, and a post with a real date was built from a warm record that carried the
  // age flag too — so there is nothing further to overlay. Widening it to also test the note would
  // dispatch a container call on every ordinary video, which is what this gate exists to prevent.
  if (post?.createdAt instanceof Date && post.createdAt.getTime() !== 0) return null
  const warm = await readCachedMeta<YouTubeMeta>(ref, env, ytMetaTtl, ytMetaUsable(env))
  if (warm) return warm
  if (!youtubeVouched(post) || !metaDispatchable(metaCacheKey(ref))) return null
  const work = metaAttempt(ref, env, META_FAIL_TTL_MS, () => resolveYouTubeMeta(ref, env))
  // Kept alive past the response, exactly as settleMux does with a losing mux: a call that misses the
  // deadline still writes, so the next unfurl is free rather than repeating the extract.
  ctx.waitUntil(work)
  const got = await deadline(work, META_WAIT_API_MS)
  return got ?? null
}

/**
 * THE MEMORY CEILING ON THE BUFFERING FALLBACK IN putMuxed. 64 MB, overridable with
 * `env.MUX_BUFFER_MAX`.
 *
 * THE REAL NUMBERS, from container/server.py, because "bounded by the container's own cap" was the
 * previous claim and it is a bound of the wrong size: `MAX_BYTES` there is 393216000 — a 375 MB
 * OUTPUT ceiling — beside `MAX_SECONDS` 1500, and the two move together because a `-c copy` mux
 * produces source-bitrate times duration. RESOLVER_SLOTS is 4, so "buffer whatever the container
 * produced" is up to 1.5 GB resident across a full pool, for four ordinary long videos and no
 * attacker at all.
 *
 * ON WORKERS THIS IS UNREACHABLE IN PRACTICE and still worth having: the container always sends
 * content-length (`self.send_header("content-length", str(size))` in server.py), so the
 * FixedLengthStream branch takes every real mux, and an isolate has ~128 MB anyway — buffering 375 MB
 * there does not risk a big allocation, it OOMs the isolate. Off Cloudflare, where FixedLengthStream
 * does not exist, the fallback IS the path and this is the only thing standing between one long video
 * and the host's memory.
 *
 * 64 MB is chosen against the isolate ceiling, not against a measured distribution of video sizes —
 * nobody has measured that, and a guessed "typical size" would be exactly the invented value this
 * project refuses. Above it the mux is not stored: the card degrades to its cover still (see
 * ensureMuxed's null) rather than the process degrading. That is a real cost — an over-ceiling video
 * re-muxes on every view — which is why the honest fix for a self-hoster is `putStream` below, and
 * why this number is env-overridable for an operator who has memory to spend.
 */
const MUX_BUFFER_MAX = 64 * 1024 * 1024

/** `env.MUX_BUFFER_MAX` if it parses to a positive integer, else the default. Total over junk. */
function muxBufferMax(env: Env): number {
  const n = Number(env.MUX_BUFFER_MAX)
  return Number.isInteger(n) && n > 0 ? n : MUX_BUFFER_MAX
}

/**
 * A STORE THAT CAN TAKE A STREAM, the seam that makes the ceiling above a fallback rather than a
 * limit. R2 cannot: `put` needs a KNOWN LENGTH for a streamed body, and a subrequest response body is
 * not always a fixed-length stream even when the origin sent content-length, so `put(key, body)`
 * throws synchronously — which is why FixedLengthStream exists in the first place. A self-hosted
 * store usually CAN (a file write, or an S3 multipart upload), so it may declare an optional
 * `putStream` and never buffer a byte. Optional, and absent on R2, so the Workers path is untouched.
 */
type StreamingBucket = R2Bucket & {
  putStream?: (key: string, body: ReadableStream, length: number | null) => Promise<void>
}

/**
 * Stream a muxed MP4 response into R2. Returns false when the object was NOT stored, so the caller
 * degrades to the cover still instead of reporting a video that is not there.
 *
 * Three paths, in order of how little memory they hold:
 *   1. FixedLengthStream + content-length — the Workers production path. No buffering.
 *   2. `cache.putStream` — a self-hosted store that accepts a stream. No buffering.
 *   3. buffer, bounded by muxBufferMax. Anything larger is refused rather than held in memory.
 */
async function putMuxed(cache: R2Bucket, key: string, muxed: Response, env: Env): Promise<boolean> {
  const raw = Number(muxed.headers.get('content-length'))
  const len = Number.isInteger(raw) && raw > 0 ? raw : null
  // FixedLengthStream is a Workers-runtime global; under `node --test` it is absent, so the paths
  // below serve the unit tests and every self-hosted runtime while this one serves production.
  if (typeof FixedLengthStream !== 'undefined' && len !== null) {
    const fixed = new FixedLengthStream(len)
    const pumped = muxed.body!.pipeTo(fixed.writable)
    await cache.put(key, fixed.readable)
    await pumped
    return true
  }
  const streaming = (cache as StreamingBucket).putStream
  if (streaming && muxed.body) {
    await streaming.call(cache, key, muxed.body, len)
    return true
  }
  const cap = muxBufferMax(env)
  if (len !== null && len > cap) {
    // SERVER-SIDE ONLY, like the mux-failed log above it: from outside, a refused store and a failed
    // mux both degrade to the poster still, and that ambiguity is what makes "it shows a frame and
    // never plays" undiagnosable. `key` is the ref and carries no url.
    console.error('mux not cached: over the buffer ceiling', key, len, cap)
    void muxed.body?.cancel()
    return false
  }
  const body = await readCapped(muxed, cap)
  if (!body) {
    // No content-length AND past the ceiling mid-read. Same refusal, reached the only other way.
    console.error('mux not cached: over the buffer ceiling', key, 'unknown', cap)
    return false
  }
  await cache.put(key, body)
  return true
}

/**
 * Read a body into memory, giving up the moment it passes `cap`. Null means "too big".
 *
 * IT EXISTS FOR THE HEADERLESS CASE, and that case is not hypothetical off Cloudflare: a store or a
 * proxy in front of the resolver that answers chunked has no content-length, and `arrayBuffer()` on
 * such a body is an unbounded allocation with a promise attached. Checking the header alone would
 * bound the size we were TOLD and not the size we take.
 */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > cap) {
        void reader.cancel()
        return null
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Serve an R2 object as video/mp4, honouring a single `bytes=` range so players can seek. */
async function r2Range(cache: R2Bucket, key: string, size: number, range: string | null): Promise<Response> {
  const base: Record<string, string> = {
    'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': `public, max-age=${MEDIA_MAX_AGE}`,
  }
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (m) {
    /**
     * `bytes=-N` IS A SUFFIX RANGE — the LAST N bytes — and this used to answer with the FIRST N+1,
     * labelled `bytes 0-N` as though that were what was asked for. The regex accepts an empty first
     * group, so `bytes=-500` parsed as start=0, end=500: a 206 that is confidently wrong rather than
     * a 416, which is the shape that costs an afternoon when a player finally sends one.
     *
     * The guard below is unchanged and gets the two edges right for free. `bytes=-0` -> start = size,
     * end = size-1 -> start > end -> 416, which is what RFC 9110 requires for a zero-length suffix. An
     * oversized suffix clamps to the whole representation, which is also what it requires.
     */
    const suffix = !m[1] && !!m[2]
    const start = suffix ? Math.max(0, size - Number(m[2])) : (m[1] ? Number(m[1]) : 0)
    const end = suffix ? size - 1 : (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1)
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } })
    }
    const obj = await cache.get(key, { range: { offset: start, length: end - start + 1 } })
    if (!obj) return new Response('gone\n', { status: 404 })
    return new Response(obj.body, {
      status: 206,
      headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
    })
  }
  const obj = await cache.get(key)
  if (!obj) return new Response('gone\n', { status: 404 })
  return new Response(obj.body, { status: 200, headers: { ...base, 'content-length': String(size) } })
}

/**
 * The general form: an arbitrary LOOKUP key plus a loader.
 *
 * Split from getPost so the shortlink route can name its entry WITHOUT constructing a PostRef it
 * has no right to. The earlier spelling passed `{p:'tt', id: code}` here purely to derive a key,
 * and that fake ref rendered `post:tt:{code}` — the same namespace a real post id occupies. See
 * shortPostCacheKey for both directions that collided. A key is what this function actually
 * needs; asking for a ref invited manufacturing one.
 */
async function loadPost(
  lookupKey: string, load: () => Promise<Post | null>, d: Deps,
): Promise<{ post: Post | null; cached: boolean }> {
  const key = cacheUrl(lookupKey)
  const hit = await d.cache.match(key)
  if (hit) {
    const p = deserializePost(await hit.text())
    if (p) return { post: p, cached: true }
  }
  // A genuine upstream failure (DNS, timeout, connection reset) makes fetch()
  // itself REJECT, not resolve with a falsy value — fetchBluesky only guards
  // `!res.ok` and content-type. Treat a thrown fetch like a null one, so it
  // routes into the same fetch_fail / errorEmbed path instead of crashing the
  // Worker with an uncaught 500. Scoped to just the live-fetch call: a corrupt
  // cache-read error above is intentionally NOT caught here.
  let post: Post | null
  try {
    post = await load()
  } catch {
    return { post: null, cached: false }
  }
  if (post) {
    const headers = { 'cache-control': `max-age=${POST_TTL}`, 'content-type': 'application/json' }
    // Serialized ONCE and re-wrapped, because a Response body is single-use: handing the same
    // Response to two cache.put calls stores an already-consumed body under the second key.
    const body = serializePost(post)
    await d.cache.put(key, new Response(body, { headers }))
    /**
     * A ref that was a LOOKUP KEY rather than the post's own identity — today only a resolved
     * short code — must ALSO land under the canonical key, or the very first /_media/ hit costs
     * a second upstream fetch and splits one post across two cache entries and two /_media/
     * namespaces. That is the invariant router.test.mjs asserts on refKey ("every TikTok path
     * shape for one post collapses to the SAME cache key"), and a lookup key is the one way to
     * violate it from inside the worker: the media route derives its ref from post.ref, which
     * the short code never reaches.
     *
     * Awaited, not waitUntil'd: this is a cache write we depend on within the same second, and
     * the test that proves it would otherwise race.
     *
     * A no-op for every ordinary fetch, where `key` already IS the canonical key.
     */
    const canonical = cacheUrl(postCacheKey(post.ref))
    if (canonical !== key) await d.cache.put(canonical, new Response(body, { headers }))
  }
  return { post, cached: false }
}

/**
 * The bot half of the post route — cache-check, fetch, render, cache — extracted so the reddit
 * share-link route can hand its RESOLVED permalink ref through the exact same path. A post that a
 * share link and a permalink both name renders byte-identically and dedupes to ONE cache entry,
 * because respCacheKey is keyed by the ref the resolver made canonical. The human redirect is NOT
 * here: each caller redirects to its OWN canonical (the permalink, or the /s/ share url) before it
 * ever resolves, so a human never costs an upstream fetch.
 */
/** Where a translation is remembered. Keyed by the TEXT, so two posts quoting the same line share
 *  one inference and a re-render never pays twice. Content-addressed, so it can never go stale. */
/**
 * A GENERATION, for the reason metaCacheKey has one — and because shipping without it made the engine
 * switch a no-op for every post already translated.
 *
 * The key was `xlate/{source}/{sha256(modelInput)}`, i.e. keyed on the QUESTION. That is right as far
 * as it goes and it is not far enough: the answer also depends on WHO WAS ASKED. When translation
 * moved from m2m100 to Google, every cached post kept serving its old m2m100 text under an unchanged
 * key — measured on x:2082851272315834575, which went on saying "White is delicious." after the
 * better engine was live and would have done so for 60 days.
 *
 * BUMP THIS whenever the engine, the prompt, or modelInput changes. Old objects simply become
 * unreachable and the bucket's 60-day lifecycle sweeps them; nothing needs deleting by hand.
 *
 *   x1  m2m100 only
 *   x2  Google first, m2m100 as the fallback (2026-07-31)
 *   x3  Google first, gemma-4-26b-a4b-it as the fallback, new system prompt (2026-07-31)
 *
 * x3 IS THE CASE THIS COMMENT WAS WRITTEN FOR. The bake-off measured m2m100 as the worst of five
 * engines, so the switch to Gemma exists precisely to stop serving lines like "White is delicious." —
 * and leaving the generation at x2 would have kept serving them from cache, making the change a no-op
 * on every post that had already been translated. Exactly the bug the x1→x2 note above records.
 */
const XLATE_GENERATION = 'x3'

const xlateKey = (source: string, hash: string) => `xlate/${XLATE_GENERATION}/${source}/${hash}.json`

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * TRANSLATE A FOREIGN-SCRIPT POST, appending to the card rather than replacing it.
 *
 * EVERY FAILURE IS "NO TRANSLATION", never a broken card: no AI binding, no R2, a model error, a
 * shape we do not recognise, a hash that will not compute. Each returns the post untouched, which is
 * exactly how it renders today — the property that lets this ship before Workers AI is enabled.
 *
 * THE R2 CACHE IS CONTENT-ADDRESSED and is the difference between paying once and paying forever.
 * The Post cache expires every POST_TTL (900s), so without this a hot foreign post would buy a fresh
 * inference four times an hour for as long as anyone looked at it. Keyed by sha256 of the exact text,
 * so it is immutable by construction and the bucket's 60-day lifecycle sweeps it like everything else.
 *
 * IT IS RACED AGAINST THE REMAINING BUDGET, and the first draft of this function was not — that was a
 * real defect, caught before it shipped, and the comment here argued FOR it: "an m2m100 call on <=600
 * characters is [not seconds], and the render is already past its expensive step." That was an
 * assumption, never a measurement, and it ignored the shape of the budget it was spending.
 * HTML_DEADLINE_MS is a ceiling on the WHOLE response (see it), and settleMux already consumes
 * whatever the upstream fetch left of it. An unraced inference therefore stacked on top of an
 * ALREADY-SPENT ceiling, so a slow model would not merely delay a translation — it would cost the
 * card, on precisely the posts (slow upstream, cold mux) that have the least budget to give.
 *
 * THE SAME COMMENT ALSO GOT THE REMEDY WRONG: "the fix is a deadline() around the run, not a
 * background seam — a translation that arrives after the card is a translation nobody sees." It is
 * BOTH, and the background seam is the more useful half. A late translation is written to R2 under a
 * content address, so the next unfurl of that post — or of any other post quoting the same text —
 * finds it warm and free. That is exactly how settleMux keeps a slow mux alive with waitUntil, and it
 * is why losing this race costs a reader nothing but the wait they were never going to survive.
 *
 * A LOST RACE SUPPRESSES THE RESPONSE CACHE (`pending`), mirroring settleMux's `degraded`: caching the
 * untranslated card would pin it for RESP_TTL and hide the translation that is landing in R2 as we
 * answer. It self-heals after one render, since the second reader hits the warm R2 entry.
 *
 * "THE MODEL DECLINED" IS NOT "PENDING", which is why the race uses a sentinel rather than testing for
 * null. A null result is final — a misdetected English post, or a model that will not translate this
 * string — and reporting it as pending would defeat the response cache for that post FOREVER, on every
 * unfurl, for a translation that is never coming.
 */
const TIMED_OUT = Symbol('translation timed out')

/**
 * A FLOOR SO A BLOWN BUDGET STILL ALLOWS A FAST INFERENCE, and it differs in KIND from
 * MUX_WAIT_FLOOR_MS. That floor exists because the WARM path (an R2 head) sat inside the race and a
 * 0ms timer beat it. Here the warm path — the R2 get above — is deliberately outside the race, so a
 * cached translation is never lost to a spent budget no matter how small this number is. This floor
 * buys only the COLD case: a post whose upstream was slow still gets its translation when the model
 * happens to be quick, instead of always deferring it to the next reader.
 */
const XLATE_WAIT_FLOOR_MS = 300

/**
 * AND A CEILING ON ITS SHARE, which the first version of the race did not have and which its own test
 * caught: "remaining budget" alone means a post with a FAST upstream hands the model the entire 5s,
 * because nothing else spent it. Measured on the first run of the deadline test — 5036ms to render a
 * card whose fetch and mux together cost nothing.
 *
 * That respects the ceiling and still gets the priority backwards. A translation is the least
 * important thing on the card: it is an accessibility nicety appended BELOW the author's own words,
 * and every millisecond it spends is one the card itself may need. It gets a slice, not the rest.
 * 1500ms is generous for a 1.2B model on <=600 characters while leaving the response comfortably
 * inside the budget even when the model is having a bad day.
 */
export const XLATE_MAX_WAIT_MS = 1500

/**
 * THE TRANSLATION FOR A POST, without applying it — so the Mastodon-spoof callback can fetch one
 * CONCURRENTLY with its mux wait and apply it last, the way the YouTube date and age note already do.
 *
 * REPORTED 2026-07-31 on x:2082851272315834575, a Japanese post that showed no translation. It was
 * working, in the one document Discord does not read for a post with media:
 *
 *   og:description  "白菜おいしいね …  🌐 Translated from Japanese  It is delicious …"
 *   spoof content   "白菜おいしいね …  ❤️ 561 🔁 40"          <- what Discord actually renders
 *
 * withTranslated ran only in renderPostRoute, i.e. on the HTML head. The /users/{handle}/statuses/{id}
 * callback re-derives the post from cache and renders it separately, so the translation never reached
 * the card. Exactly the defect the YouTube age note had ("must ride the late-meta seam, or it never
 * fires") — a per-render overlay applied on one of two seams is applied on neither, from the reader's
 * point of view.
 */
async function translationFor(
  post: Post, env: Env, ctx: ExecutionContext, budgetMs: number,
): Promise<{ text: string; source: string } | null> {
  const got = await withTranslated(post, env, ctx, budgetMs)
  return got.translated ? { text: got.translated, source: got.source } : null
}

async function withTranslated(
  post: Post, env: Env, ctx: ExecutionContext, budgetMs: number,
): Promise<{ post: Post; pending: boolean; translated?: string; source: string }> {
  const text = typeof post?.text === 'string' ? post.text : ''
  const source = sourceLanguage(text) ?? ''
  if (!source) return { post, pending: false, source }
  // NO LONGER GATED ON env.AI. Google's endpoint needs no binding, so a Worker with no Workers AI
  // still translates — the AI is the FALLBACK now, not the requirement.
  if (!env.AI && env.TRANSLATE_GOOGLE === 'off') return { post, pending: false, source }

  // HASH WHAT THE MODEL IS ASKED, not what the post said — see modelInput. Keying on the raw text
  // meant a change to how we build the question could not invalidate an answer already cached under
  // it, which is exactly what happened when url-stripping shipped and the poisoned translation kept
  // being served from R2 under an unchanged key.
  const asked = modelInput(text)
  if (!asked) return { post, pending: false, source }
  let hash = ''
  try {
    hash = await sha256Hex(asked)
  } catch {
    return { post, pending: false, source }
  }
  const key = xlateKey(source, hash)

  // THE WARM PATH, AND IT IS OUTSIDE THE RACE ON PURPOSE — see XLATE_WAIT_FLOOR_MS. One R2 get is the
  // whole cost of a translation that has already been paid for, and throwing it away to save 20ms
  // would buy a fresh inference on every unfurl of the most-shared posts we have.
  if (env.MEDIA_CACHE) {
    try {
      const hit = await env.MEDIA_CACHE.get(key)
      if (hit) {
        const j = await hit.json() as { t?: unknown; l?: unknown }
        if (typeof j?.t === 'string') {
          /**
           * AN EMPTY `t` IS A CACHED NEGATIVE, not a miss — "we asked, and it was English".
           *
           * It exists because the auto path asks about every Latin-script post, and the overwhelming
           * majority of them are English. Without a stored negative, every English post on the site
           * would buy a fresh upstream request on every single unfurl, forever. Older records only
           * ever hold a non-empty string, so this is safe to read against them.
           */
          if (!j.t) return { post, pending: false, source }
          // `l` is the language Google DETECTED; older records predate it and their key already names
          // the script we asked about, so `source` is the right fallback rather than a guess.
          const lang = typeof j.l === 'string' && j.l ? j.l : source
          return { post: withTranslation(post, j.t, lang), pending: false, translated: j.t, source: lang }
        }
      }
    } catch {
      // A cache miss and a cache FAILURE are the same thing here: ask the model.
    }
  }

  // The inference runs to completion regardless of who wins the race below — waitUntil keeps it alive
  // past the response, and the R2 write is part of the same chain, so a translation this reader never
  // sees is still warm for the next one. The write is inside `work` rather than after the race for
  // exactly that reason: losing the race must not skip it.
  const work = translateBest(text, source, { ai: env.AI, google: env.TRANSLATE_GOOGLE !== 'off' })
    .then(async got => {
      if (!got) return null
      // Counted here rather than at the call site so a translation that LOSES the deadline race is
      // still counted — the ratio is about which upstream answered, not about who saw the card.
      // A cached NEGATIVE is not a translation and must not be counted as one — otherwise the
      // English majority would swamp the ratio the counters exist to show.
      if (got.text) {
        count(env, post?.ref?.p ?? 'none', got.via === 'google' ? 'translated' : 'translate_fallback', 'discord')
      }
      if (env.MEDIA_CACHE) {
        await env.MEDIA_CACHE.put(key, JSON.stringify({ t: got.text, l: got.lang })).catch(() => undefined)
      }
      return got
    })
    .catch(() => null)
  ctx.waitUntil(work)

  const timeout = new Promise<typeof TIMED_OUT>(resolve => setTimeout(() => resolve(TIMED_OUT), budgetMs))
  const raced = await Promise.race([work, timeout])
  if (raced === TIMED_OUT) {
    /**
     * THE LOSING HALF OF THE PAIR ABOVE, counted for the first time here.
     *
     * `translated` and `translate_fallback` fire inside `work`, i.e. only when a translation ARRIVES.
     * A race the model loses returned `pending` and nothing else, so the one state that makes a post
     * render uncached on every single unfurl was invisible in the counters — and Workers Logs are off
     * on purpose (see wrangler.jsonc), so it was invisible there too.
     *
     * 'discord' for the same reason its siblings hardcode it: this ratio is about the MODEL's latency
     * against the budget, not about who happened to be looking. Splitting it by client would divide
     * the signal across classes for no question anyone is asking of it.
     */
    count(env, post?.ref?.p ?? 'none', 'translate_pending', 'discord')
    return { post, pending: true, source }
  }
  // Null here is FINAL, not late: the model declined or errored. See the sentinel note above.
  if (!raced) return { post, pending: false, source }
  /**
   * AN EMPTY TEXT IS THE ENGLISH ANSWER, and it is FINAL rather than pending — the question is
   * settled, so the card must be response-cached exactly as an untranslatable post always was.
   */
  if (!raced.text) return { post, pending: false, source: raced.lang }
  return {
    post: withTranslation(post, raced.text, raced.lang),
    pending: false,
    translated: raced.text,
    source: raced.lang,
  }
}

/**
 * RESOLVE A ROUTE THAT ONLY NAMES A POST INDIRECTLY — for the two JSON endpoints the converter page
 * talks to, and for BOTH of them out of one function.
 *
 * THIS IS THE THIRD TIME THIS SHIPPED BROKEN, which is why it is a function now rather than a third
 * pair of copies. These arms learned 'metashare', then had to be taught 'shortlink' (tiktok.com/t/
 * ZTAxTF9aD previewed as "unresolved" while the same link drew a perfect card in Discord), and still
 * did not know 'redditshare' — so /r/{sub}/s/{code}, the link the Reddit app's own share button
 * hands you, answered {ok:false, reason:'redditshare'} and the page said "this link doesn't resolve
 * to a post" about a link that unfurls correctly the moment it is pasted into Discord.
 *
 * That failure is worse than a broken link, because it talks the reader out of a GOOD one, on the
 * one surface whose whole job is to reassure them before they send it. And it is invisible from the
 * render path, which has resolved all three kinds since each shipped: the converter preview is a
 * THIRD SEAM, and every one of these was the render path being fixed while the preview was forgotten.
 *
 * The sweep test in test/prep.test.mjs fails until every post-yielding route kind is handled here, so
 * a FOURTH kind cannot be added without this being updated.
 *
 * TOTAL BY CONSTRUCTION: every resolver call is wrapped, and any miss returns `inner` untouched, so
 * the caller degrades to exactly the answer it gave before. A share code that cannot be resolved is
 * still an honest "this names no post"; it must never become a 500 on a public path.
 *
 * COSTS NOTHING WHEN WARM: these are the same doors the bot render already went through, so a code
 * whose card has been drawn is answered from cache rather than re-hopping upstream.
 *
 * `report` IS AN OUT-PARAM FOR THE ONE THING A Route CANNOT CARRY: a wall. TikTok's resolver can come
 * back {kind:'gated'} — the post exists and is private or age-restricted — and there is no Route kind
 * for that, so returning `inner` untouched loses the fact entirely. Same shape as liveFetchPost's
 * FetchReport, and for the same reason: the return type is what the CALLER routes on, and a failure
 * vocabulary does not belong in it. Nothing is required to pass one; /_prep does not.
 */
/**
 * WHAT A /t/ CODE DEGRADES TO WHEN IT RESOLVES TO NOTHING — one list, because two seams answer with it.
 *
 * `tiktok.com/t/{code}` and `threads.com/t/{code}` are the same path on two different products, so a
 * code that TikTok does not claim is genuinely ambiguous and the honest answer is to offer both. The
 * render arm has served this chooser since the route was written; describeTarget now returns the same
 * pair, and it is a constant so the two cannot drift into offering different links for one url.
 */
const SHORTLINK_CANDIDATES: Platform[] = ['tt', 'th']

/**
 * WHAT A SHORTLINK RESOLUTION CANNOT SAY THROUGH A `Route`, carried out of unwrapToPost instead.
 *
 * All three of these are facts the resolver learned and the return type has no room for: `Route` says
 * what to render, not why a render is impossible. Each mirrors one branch of the shortlink RENDER arm
 * exactly, which is the whole point of carrying them — see describeTarget.
 */
type ShortlinkReport = {
  /** {kind:'gated'} — the post exists and is private or age-restricted. */
  gate?: 'age' | 'private'
  /** {kind:'gone'} — TikTok claimed the code and the post is not there. NOT a wall and NOT ambiguous. */
  gone?: boolean
  /** Anything else — TikTok did not claim the code, so both products are still candidates. */
  candidates?: Platform[]
}

async function unwrapToPost(
  inner: Route, d: Deps, env: Env, client: ClientClass, report?: ShortlinkReport,
): Promise<Route> {
  const asPost = (u: string | null | undefined): Route | null => {
    if (!u) return null
    try {
      const r = route(new URL(u))
      return r.kind === 'post' ? r : null
    } catch {
      return null
    }
  }

  if (inner.kind === 'metashare') {
    let loc: string | null = null
    try {
      loc = await d.resolveMetaShare(inner.code)
    } catch {
      loc = null
    }
    return asPost(loc ? stripMetaTracking(loc) : null) ?? inner
  }

  if (inner.kind === 'shortlink') {
    let got: Awaited<ReturnType<Deps['resolveShortlink']>> | null = null
    try {
      got = await d.resolveShortlink(inner.p, inner.code, env, client)
    } catch {
      got = null
    }
    // THE WALL, CARRIED OUT — renderGate is the same map the post route and the shortlink RENDER arm
    // call, so a gated /t/ code says the same thing on all three surfaces. Without it the resolver's
    // {kind:'gated'} collapses back into an unresolved shortlink and the two JSON surfaces answer
    // `not_a_post` about a post that exists and is walled, while Discord draws the 🔒 card. Measured
    // offline through handle() with an injected resolver, 2026-08-11.
    /**
     * ALL THREE NON-POST RESOLUTIONS ARE CARRIED, not just the wall.
     *
     * The first version of this recorded only {kind:'gated'} and was closed against its own siblings:
     * a DELETED TikTok reached by /t/{code} still answered `not_a_post` with `platform: null` on
     * /_api/v1 while the render arm drew "Couldn't load this TikTok post" and counted ('tt',
     * 'fetch_fail'), and an unresolvable code answered `not_a_post` with no candidates while the
     * render arm offered the chooser. That is the same divergence the gated fix was written for,
     * one branch over — and a null platform is a claim the render path refuses to make, because the
     * page carried positive proof of whose post it is.
     */
    if (report) {
      if (got?.kind === 'gated') report.gate = renderGate(got.reason)
      else if (got?.kind === 'gone') report.gone = true
      else if (got?.kind !== 'post') report.candidates = SHORTLINK_CANDIDATES
    }
    return asPost(got?.kind === 'post' ? got.post?.canonical : null) ?? inner
  }

  if (inner.kind === 'redditshare') {
    /**
     * The /s/ code is opaque and the resolve is a single 301 follow, exactly as the render path does
     * it. Routed from the RESOLVED CANONICAL rather than from the ref the resolver also hands back,
     * so this seam and the render path cannot derive a different ref from the same code.
     */
    let got: { ref: Extract<PostRef, { p: 'rd' }>; canonical: string } | null = null
    try {
      got = await d.resolveRedditShare(inner.canonical, env)
    } catch {
      got = null
    }
    return asPost(got?.canonical) ?? inner
  }

  return inner
}

/**
 * A TARGET URL, FETCHED AND FULLY SETTLED — the shared half of `/_card` and `/_api/v1`.
 *
 * IT IS ONE FUNCTION BECAUSE THE ALTERNATIVE IS THIS PROJECT'S MOST REPEATED DEFECT. Everything below
 * used to live inline in the card arm, and every line of it was added the same way: something was
 * applied on one surface and not its twin, and the difference was invisible until somebody put two
 * screenshots side by side. The YouTube epoch (warmed by the activity route alone, so the preview
 * showed 1970 forever), the translation applied to the og head and not the Mastodon spoof, the quote
 * block drawn by the card and missing from the preview. A second surface that re-spells this pipeline
 * would reproduce that class on its first day, and — being a published contract rather than a
 * picture — would then be stuck with it.
 *
 * So there is exactly one place a target becomes a settled Post, and the two callers differ only in
 * how they SERIALISE it. When something is fixed here, both surfaces get it or neither does.
 *
 * `null` means the target could not be parsed as a url at all. That is the caller's to answer,
 * because it is the one failure that is a bad REQUEST rather than a post that cannot be shown, and
 * the two surfaces answer it with different status codes.
 */
type Described =
  | { ok: false; reason: string; gate?: 'age' | 'private'; candidates?: Platform[]; platform?: Platform; canonical?: string }
  | { ok: true; post: Post; muxing: boolean; pending: boolean; platform: Platform; canonical: string }

async function describeTarget(
  target: string, d: Deps, env: Env, ctx: ExecutionContext, client: ClientClass, origin: string,
): Promise<Described | null> {
  // TAKEN FIRST, so every budget below is a deadline on the WHOLE response rather than an amount
  // added after each step — the same discipline renderPostRoute uses, and the one the 4000ms
  // META_WAIT_API_MS bug is a monument to.
  const started = Date.now()
  let inner: Route
  try {
    inner = route(new URL(target, origin))
  } catch {
    return null
  }
  // A share code names no post until a hop resolves it — the same unfurl /_prep does, so both
  // surfaces follow the link the caller is actually about to hand somebody.
  const unwrapped: ShortlinkReport = {}
  inner = await unwrapToPost(inner, d, env, client, unwrapped)

  if (inner.kind !== 'post') {
    /**
     * A WALLED SHORT LINK IS A WALL, NOT A NON-POST — and this is the divergence the shared pipeline
     * was built to stop, found 2026-08-11 while writing the OpenAPI spec.
     *
     * The RENDER arm for 'shortlink' has answered a {kind:'gated'} resolution with the calm 🔞/🔒 card
     * since 2026-07-21, explicitly so one post does not draw two different cards depending on which
     * url shape was pasted. Both JSON surfaces answered `not_a_post` for the same link: the API said
     * "that url resolves to something other than a post" about a post that demonstrably exists, and
     * the converter preview said the link does not resolve while Discord unfurled it correctly — the
     * third-seam shape this file's own comments keep describing.
     *
     * Spelled as fetch_fail + gate because that is exactly what the post route returns for a walled
     * PERMALINK, so /_api/v1 publishes `private` / `age_restricted` and /_card draws the same wording
     * for both url shapes. platform and canonical are the shortlink's own — the short url is what the
     * caller sent and the only canonical that exists before the code resolves — which is the pair the
     * render arm already reports (`canonical: r.canonical, platform: r.p`).
     */
    if (inner.kind === 'shortlink' && (unwrapped.gate || unwrapped.gone)) {
      return {
        ok: false, reason: 'fetch_fail', gate: unwrapped.gate,
        platform: inner.p, canonical: inner.canonical,
      }
    }
    /**
     * AND THE CODE TIKTOK DID NOT CLAIM IS THE CHOOSER, not a bare "that names no post".
     *
     * `ambiguous` is the one not-a-post answer a caller can DO something about, and the shortlink arm
     * is where it was least available: a caller asking about `tiktok.com/t/{code}` for a Threads link
     * got `not_a_post` with nothing to try, while a reader pasting the same url into the converter
     * page was offered both. Same list as the render arm, from one constant.
     */
    if (inner.kind === 'shortlink' && unwrapped.candidates) {
      return { ok: false, reason: 'ambiguous', candidates: unwrapped.candidates }
    }
    /**
     * A PROFILE LANDS HERE AS `reason: 'profile'`, WHICH IS A KNOWN SCOPE BOUNDARY AND NOT AN
     * ACCIDENT. Both callers — /_card, the converter page's preview, and /_api/v1, the published
     * contract — are POST-SHAPED end to end: Described.post is a Post, toApiPost serialises a Post,
     * and docs/API.md documents that object. Describing a profile means a second payload shape in
     * the published API, which is a documented change of its own rather than a field added quietly
     * on the way past.
     *
     * WHAT THAT COSTS, stated rather than left to be discovered: the converter page previews
     * nothing for a profile link even though Discord draws a card for it. That is the third-seam
     * trap CLAUDE.md names, so the page's copy says exactly that for this reason (see
     * public/index.html's drawCard) instead of the generic "doesn't resolve to a post", which would
     * be false.
     */
    // THE CANDIDATES RIDE ALONG even though the card ignores them. An ambiguous path is the one
    // not-a-post answer a caller can DO something about — /_prep already expands it into a chooser —
    // and computing it here rather than in one serialiser is what keeps the other from having to
    // re-derive it later and get the list subtly different.
    return inner.kind === 'ambiguous'
      ? { ok: false, reason: 'ambiguous', candidates: inner.candidates }
      : { ok: false, reason: inner.kind }
  }

  /**
   * THE METADATA CALL GETS THIS SURFACE'S CEILING, NOT THE CRAWLER'S — the fix for a /_card and
   * /_api/v1 answering "couldn't load" about a Dailymotion or Streamable post that is completely fine.
   * See META_TIMEOUT_API_MS for the production measurement and for why this seam is the one that had to
   * move first: it is the one CLAUDE.md names as having no next render.
   *
   * REMAINING, NOT FRESH — the same discipline as the settleMux and translation budgets below, and the
   * reason `started` is taken at the top of this function. unwrapToPost above can spend a real network
   * hop on a share code, and a step that took a fresh budget after it would push the whole answer past
   * the ceiling it is supposed to be bounded by.
   *
   * FLOORED AT META_TIMEOUT_MS, which is what makes this strictly a widening: however slow the unwrap
   * was, this call still gets at least the budget it had before the change, so no link that previewed
   * yesterday can preview worse today. Above the floor it is derived exactly as the crawler's is — run
   * to the ceiling and MUX_WAIT_FLOOR_MS is left, which is what settleMux floors at.
   */
  const metaBudget = Math.max(META_TIMEOUT_MS, META_TIMEOUT_API_MS - (Date.now() - started))
  const got = await getPost(inner.ref, d, env, client, ctx, metaBudget)
  if (!got.post) {
    // renderGate is the ONE place the fetcher's gate vocabulary becomes render's, so a wall says the
    // same thing on the card, in the preview and in the API. `undefined` in, `undefined` out, and
    // JSON.stringify omits the key entirely — a generic failure never claims to be a gate.
    return {
      ok: false, reason: 'fetch_fail', gate: renderGate(got.failReason),
      platform: inner.ref.p, canonical: inner.canonical,
    }
  }

  /**
   * THE MUX AND THE TRANSLATION RACE CONCURRENTLY, ON THE PREVIEW'S OWN CEILING. Running them
   * SERIALLY was the whole of "translations don't really show up reliably on the preview": a cold mux
   * does not return early, it spends whatever budget it is given (6-9s measured), so
   * `CARD_DEADLINE_MS - elapsed` went negative and the translation fell to its 300ms floor. Google is
   * measured at 217-798ms, so a 300ms race wins SOMETIMES — which is why the symptom was "unreliable"
   * rather than "broken". The activity route never had this because it uses Promise.all.
   *
   * CARD_DEADLINE_MS rather than HTML_DEADLINE_MS: that one is a ceiling on a BOT response, shaped by
   * how long a crawler holds a connection. Both callers here are a client waiting on an answer about
   * a card the activity route renders on MUX_WAIT_API_MS, and giving the description a smaller budget
   * than the thing it describes guarantees they disagree.
   */
  const [settled, xlate] = await Promise.all([
    settleMux(got.post, env, ctx, Math.max(MUX_WAIT_FLOOR_MS, CARD_DEADLINE_MS - (Date.now() - started)), client),
    // The ORIGINAL post, not the settled one: the mux replaces media urls and never touches `text`,
    // so there is nothing to wait for. Same ordering the activity arm uses.
    withTranslated(
      got.post, env, ctx,
      Math.max(XLATE_WAIT_FLOOR_MS, Math.min(XLATE_MAX_WAIT_MS, CARD_DEADLINE_MS - (Date.now() - started))),
    ),
  ])

  // The translation was raced against the ORIGINAL post, so it is composed onto the SETTLED one here —
  // `xlate.post` carries the pre-mux media and using it would undo the mux.
  let post = withTranslation(settled.post, xlate.translated, xlate.source)
  /**
   * THE META WARM, AND IT IS NOT OPTIONAL ON EITHER SURFACE. The record is filled by the ACTIVITY
   * route — that is, by Discord unfurling the link — so it is cold for exactly the links somebody is
   * about to ask about and has not sent yet. Skipping it here reports createdAt 1970, no duration, no
   * counts and no age note on every fresh YouTube link, which is the bug that was reported as "it
   * ALWAYS says no upload date".
   *
   * It adds no container call: the caller is about to paste this into Discord, which dispatches the
   * identical `yt-dlp -J`. It moves the one that was already coming a few seconds earlier, behind
   * youtubeMeta's own bounds (the vouch, the negative cache, SPECULATIVE_META_CAP, metaOnce).
   *
   * The cache read is KEPT as the fallback: youtubeMeta returns null early when the post already
   * carries a real date, and there is still a record worth overlaying for the description, the counts
   * and the age note — so dropping it would trade a missing date for missing counts.
   */
  if (post.ref.p === 'yt') {
    const warm = await youtubeMeta(post.ref, post, env, ctx)
      // ytMetaUsable(env), NOT the bare validator. This read moved into describeTarget when /_card and
      // /_api/v1 were given one pipeline, and it moved carrying the spelling it had before the
      // pool-aware validator existed — so on this branch the two changes met and the third seam
      // silently went back to trusting a pre-jar gate verdict. The sweep test is what caught it,
      // which is the entire reason that test greps for a fourth spelling rather than testing three.
      ?? await readCachedMeta<YouTubeMeta>(post.ref, env, ytMetaTtl, ytMetaUsable(env))
    if (warm) {
      // withDescription BEFORE withLengthNote, and the reverse was a real defect (2026-08-29): the
      // note prepends into `text`, withDescription then refuses to write a body that already exists
      // ("A body already present wins"), so every long video traded its description for its note.
      // The other seam below has the identical nesting for the identical reason — BOTH OR NEITHER.
      //
      // withLiveNote INSIDE withLengthNote, so the length note can see it and stand down. Both
      // prepend, so nesting decides which one gets to be the only one — see withLengthNote.
      post = withAgeNote(
        withCounts(withLengthNote(withLiveNote(withDescription(withUploadDate(post, warm.timestamp),
          warm.description), warm.isLive), warm.duration, MUX_MAX_SECONDS), warm),
        warm.ageLimit,
      )
    }
  }
  return {
    ok: true, post, muxing: settled.degraded === true, pending: xlate.pending === true,
    platform: post.ref.p, canonical: post.canonical,
  }
}

/**
 * EVERY USABLE MEDIA ENTRY, PAIRED WITH ITS POSITION IN THE UNFILTERED ARRAY.
 *
 * THE BUG THIS EXISTS TO STOP, found 2026-08-03 while building the API on top of the card's shape.
 * The card was written `mediaOf(post).filter(usable).map((m, i) => …bytesIndex(m, i))`, so `i` was a
 * position in the FILTERED list — while `/_media/` resolves an index against the UNFILTERED one
 * (`pickMedia` reads `mediaList(post)`, and the media route's own `list.findIndex(usable)` returns an
 * unfiltered position). The two agree only while every entry is usable. Put one unusable entry in
 * front of a usable one and every url after it is off by one: the card advertises entry N and the
 * bytes at that index are entry N+1's, or a 404 past the end.
 *
 * It survived because the filter almost never removes anything — `usable` drops entries with no url,
 * which normalizers rarely emit — so this is a latent off-by-one rather than a visible one. It is
 * fixed rather than documented because the API PUBLISHES these urls as a contract, and an off-by-one
 * in a contract is not something a later release gets to quietly correct.
 */
const usableWithIndex = (post: Post): Array<{ m: Media; i: number }> =>
  mediaOf(post).map((m, i) => ({ m, i })).filter(({ m }) => usable(m))

/**
 * The headers every /_api/v1 answer carries. CORS is open because a public read-only API that a page
 * cannot call from script is most of an API missing — there is no cookie, no session and no
 * credential anywhere on this path, so there is nothing for an origin check to protect. `nosniff`
 * because this endpoint returns caller-influenced strings and must never be sniffed into anything but
 * JSON.
 */
const apiHeaders = (cacheControl: string) => ({
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'cache-control': cacheControl,
})

/**
 * A FAILURE ENVELOPE, AND IT IS NEVER CACHED — not even the "this post is private" ones, which look
 * permanent and are not. `loadPost` deliberately never caches a null Post so a post that goes public
 * self-heals on the next view; putting a max-age on the envelope here would reintroduce exactly that
 * staleness at the edge instead, one layer up, where nothing in this worker can invalidate it.
 */
const apiError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  // `platform` and `canonical` ARE ALWAYS PRESENT, as nulls when unknown — corrected 2026-08-04. They
  // used to be omitted entirely on the three request-level errors, because those call sites pass no
  // `extra`, while the failure arm below passed them explicitly. So the same envelope had two shapes
  // and the documentation described only one of them. A consumer in a typed language reads an absent
  // key and a null key differently, and this is a published contract; `...extra` stays LAST so the
  // arm that computed real values still wins.
  Response.json(
    { ok: false, error: { code, message, platform: null, canonical: null, ...extra } },
    { status, headers: apiHeaders('no-store') },
  )

/**
 * THE PUBLISHED FAILURE VOCABULARY, which is deliberately SMALLER than the internal one.
 *
 * /_card returns the raw route kind, and it can: the only consumer is a page in this repo. Publishing
 * those strings would make 'oembed', 'metashare' and 'redditshare' — names for internal plumbing that
 * exists because of how Discord's callbacks work — into a contract, and then renaming any of them
 * would be a breaking change to somebody else's code. So the ones a caller can act on are named and
 * the rest collapse into `not_a_post`, which is the only fact they share and the only one that
 * survives a refactor.
 *
 * The gates keep their own codes because "this post is age-restricted" and "this post is private" are
 * the answers this project exists to give instead of a blank rectangle. Flattening them into a
 * generic failure here would undercut the one row of the comparison table we lead on.
 */
function apiFailure(f: { reason: string; gate?: 'age' | 'private' }): { code: string; message: string } {
  if (f.reason === 'fetch_fail') {
    if (f.gate === 'age') return { code: 'age_restricted', message: 'That post is age-restricted, so it cannot be read without an account.' }
    if (f.gate === 'private') return { code: 'private', message: 'That post is private or login-walled, so it cannot be read.' }
    return { code: 'fetch_fail', message: 'That post could not be loaded. It may be deleted, or the platform may not have answered.' }
  }
  if (f.reason === 'ambiguous') {
    // THE EXAMPLE HAS TO BE A PATH THAT ACTUALLY RESOLVES. It was `/im/gallery/abc`, which is itself
    // notfound — Imgur ids are five characters or more — so a caller who followed the message
    // verbatim got the same dead end twice and reasonably concluded the prefix does not work.
    return { code: 'ambiguous', message: 'That path belongs to more than one site. Re-ask with a two-letter site prefix, e.g. /im/gallery/YcAQlkx.' }
  }
  if (f.reason === 'notfound') return { code: 'notfound', message: 'That url does not name a post on any site this service reads.' }
  if (f.reason === 'badid') return { code: 'bad_id', message: 'That url is the right shape for a post, but the id in it is not valid for that site.' }
  return { code: 'not_a_post', message: 'That url resolves to something other than a post.' }
}

/**
 * COUNTS, FILTERED THE SAME WAY THE CARD FILTERS THEM — and the filter is not defensiveness.
 *
 * `post.counts` comes out of the POST CACHE, and `deserializePost` validates the ref, the canonical
 * and the date and nothing else. So by the time a value reaches here it can legitimately be `null`, a
 * string, or `NaN`, and `counts: post.counts || {}` publishes whatever that is. statParts has carried
 * this exact `typeof + isFinite + > 0` guard since the day a card nearly rendered "❤️ NaN".
 *
 * ZERO IS OMITTED RATHER THAN PUBLISHED AS 0, which is the one part that is a judgement rather than a
 * safety check. Upstreams report zero for two different things — a genuinely uninteracted post, and a
 * count the platform WITHHOLDS (a hidden like count, a video with comments switched off) — and
 * nothing distinguishes them by the time they get here. `ytCount` already refuses to guess for the
 * same reason. An absent key says "we do not know"; a published `0` would say "we know, and it is
 * none", which is the plausible-value-in-a-hole this project's fourth rule forbids.
 */
const API_COUNTS = ['likes', 'reposts', 'replies', 'views'] as const
function apiCounts(post: Post): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of API_COUNTS) {
    const n = post.counts?.[key]
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[key] = Math.floor(n)
  }
  return out
}

/** A dimension, or null. Same reason as apiCounts: a cached record can hold a string or an object. */
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** An author, defensively — same reason as apiCounts: this came out of a cache, not a normalizer. */
const apiAuthor = (a: Post['author'] | undefined) => ({
  name: str(a?.name) || null,
  handle: str(a?.handle) || null,
  url: str(a?.url) || null,
})

/**
 * THE PUBLISHED SHAPE. Every url in it is ours — `/_media/{refKey}/{i}` — never the upstream CDN's,
 * which is the same rule the renderers follow and for the same two reasons: an upstream media url is
 * frequently signed and short-lived, so publishing one hands out a link that dies, and several of
 * them are referer- or IP-locked and would not load for the caller anyway.
 */
function toApiPost(post: Post, origin: string) {
  return {
    platform: post.ref.p,
    canonical: post.canonical,
    /**
     * THE EPOCH IS NOT A DATE, IT IS A HOLE, and this is the one place the API deliberately answers
     * differently from the card. A Post with no known upload date carries `new Date(0)`, and /_card
     * serialises that as "1970-01-01T00:00:00.000Z" because the page draws a "⚠ no upload date" note
     * beside it and a reader can see what happened. An API consumer sees a plausible timestamp and
     * sorts by it. So `null` — the same refusal to fill a hole with something that looks like an
     * answer that the cards make in words.
     */
    createdAt: post.createdAt instanceof Date && post.createdAt.getTime() !== 0
      ? post.createdAt.toISOString()
      : null,
    title: str(post.title) || null,
    /**
     * `str()` ON THE TEXT TOO, and it was missing while `title` right beside it had it — which is what
     * made it an oversight rather than a decision. Same argument as apiCounts: this came out of the
     * POST CACHE, `deserializePost` validates ref/canonical/createdAt and nothing else, so `text` can
     * be an object or a number by the time it reaches here. Published unguarded it becomes
     * `"text": {"evil":1}` at HTTP 200 with a fifteen-minute max-age, and every consumer doing
     * `post.text.length` breaks on a payload we told them was a string.
     */
    text: str(post.text) || '',
    sensitive: !!post.sensitive,
    author: {
      ...apiAuthor(post.author),
      avatar: str(post.author?.avatar) ? mediaUrl(origin, post, 'avatar') : null,
    },
    counts: apiCounts(post),
    media: usableWithIndex(post).map(({ m, i }) => ({
      // TWO KINDS, NOT THE INTERNAL THREE ('image'|'video'|'gif', types.ts:229; said FOUR until 2026-08-05).
      // A consumer needs to know whether to draw an <img> or a <video>; 'gif' is a video everywhere it matters
      // and publishing it would invite a third branch that does nothing. Same collapse the card makes.
      kind: m.kind === 'video' || m.kind === 'gif' ? 'video' : 'image',
      // bytesIndex, never the bare position: a settleMux degraded still lives in the POSTER slot, and
      // addressing it by its array index hits the video entry, which answers 503.
      url: mediaUrl(origin, post, bytesIndex(m, i)),
      // ONLY when the entry actually carries one. pickMedia has no fallback from the poster slot to
      // the bytes, so an unconditional poster url would advertise a guaranteed 404.
      poster: str(m.poster) ? mediaUrl(origin, post, { poster: i }) : null,
      // NUMBERS OR null, never whatever the cache held. `w: '800'` survives deserializePost and would
      // be published as a string under a key the docs type as a number.
      width: num(m.posterW ?? m.w),
      height: num(m.posterH ?? m.h),
      /**
       * THIS PICTURE IS STANDING IN FOR A VIDEO — the one thing a consumer cannot otherwise work out.
       *
       * settleMux rewrites an unfinished, an over-ceiling OR a live video into its poster still,
       * `kind:'image'`, and the payload is then indistinguishable from a post that only ever had a
       * picture. `muxing` covers the first case and clears on its own. It does NOT cover the other
       * two: a video past MUX_MAX_SECONDS and an unfinished broadcast both answer `muxing:false` on a
       * cacheable 200, and the only trace that a video exists at all is an English sentence prepended
       * to `text`. That is a card's answer, and a consumer parsing prose to find it is a consumer we
       * have failed.
       */
      still: !!m.posterOnly,
    })),
    // Depth is capped at 1 by the normalizers (post.quote.quote is always undefined), so this cannot
    // recurse. The quote's own media is NOT published in v1: its entries live at indices AFTER the
    // outer post's in `mediaList`, and getting that arithmetic wrong publishes urls that resolve to
    // the wrong bytes. Additive later; wrong now would be permanent.
    quote: post.quote?.author
      ? { canonical: str(post.quote.canonical) || null, text: str(post.quote.text) || '', author: apiAuthor(post.quote.author) }
      : null,
  }
}

async function renderPostRoute(
  ref: PostRef, canonical: string, d: Deps, env: Env, ctx: ExecutionContext, client: ClientClass, origin: string,
): Promise<Response> {
  /**
   * THE d. HOST SHORT-CIRCUITS HERE, so it covers every route rather than the one it was first wired
   * into. Reported on a Reddit /r/{sub}/s/{code} share link, which "does nothing different from the
   * version without d." — true, because that is a different route kind from a pasted permalink, as
   * are Meta /share/ codes and every shortlink. All of them converge on THIS function once their ref
   * is known, so checking here covers the set, and covers any future route that joins it without
   * anyone having to remember.
   *
   * The host comes off `origin`, which is already the request's own rather than a constant.
   */
  if (isDirectMediaOrigin(origin)) return serveDirectMedia(ref, d, env, ctx, client, origin)
  const rkey = cacheUrl(respCacheKey(ref, client, origin))
  const cached = await d.cache.match(rkey)
  if (cached) return cached

  /**
   * START THE MUX NOW, CONCURRENTLY WITH THE FETCH — for a ref we have already fetched once; see
   * prewarmable() for the measurement AND for what bounds it. Placed AFTER the response-cache hit
   * above, deliberately: a cached card must cost nothing, container included. `started` is taken
   * before anything else so the settleMux budget below is a DEADLINE on the whole response rather
   * than an amount ADDED after it. muxOnce collapses this with settleMux's own call for the same key,
   * so this ADDS no download.
   */
  const started = Date.now()
  const pre = env.MEDIA_RESOLVER && env.MEDIA_CACHE ? prewarmable(ref) : null
  /**
   * ONLY FOR A REF THE POST CACHE ALREADY HOLDS — the bound on speculative container work, and the
   * reason is reachability rather than cost: see prewarmable(). A cache entry exists only because a
   * fetch+normalize once succeeded for this exact ref, so this restores the pre-prewarm rule that the
   * container is reachable only for a post we have proven is real, while keeping the whole win on the
   * warm path (a re-paste, and any render that degraded and therefore cached no response).
   *
   * The same read getPost is about to make, so it adds a cache lookup and no upstream call — and it
   * still happens before the FETCH, which is the overlap the measurement is about. Uncaught, exactly
   * like the response-cache match above it: a cache layer that throws is not a condition this route
   * pretends to survive in one place and not the other.
   */
  if (pre && muxInflight.size < SPECULATIVE_MUX_CAP && await d.cache.match(cacheUrl(postCacheKey(ref)))) {
    const preKey = `mux/${refKey(ref)}/${pre.index}`
    // The alarm gets the same job the prewarm is about to start, for settleMux's reason: this render
    // may be cancelled, and the 30-second waitUntil ceiling means the videos most worth prewarming
    // are precisely the ones the prewarm cannot finish. Both are bounded by the post-cache gate
    // above, so this adds no new reachability — the container is still only reached for a ref a real
    // fetch+normalize has already vouched for.
    ctx.waitUntil(scheduleMux(env, preKey, refKey(ref), pre.source))
    ctx.waitUntil(
      muxOnce(env, preKey, pre.source, refKey(ref), jarPlatform(ref))
        .catch(() => null),
    )
  }

  const { post, failReason } = await getPost(ref, d, env, client, ctx)
  if (!post) {
    count(env, ref.p, 'fetch_fail', client)
    return render(
      {
        kind: 'failure', canonical, platform: ref.p, reason: 'could not fetch post',
        gate: renderGate(failReason),
      },
      client, origin,
    )
  }

  // Wait briefly for a cold {page} mux so the card only promises a video that exists — see settleMux for
  // the poisoned-url defect this closes. A degraded card (the still) is NEVER cached: the mux is still
  // running, and the next render must be free to find it warm and promise the real video.
  // The REMAINING budget, not a fresh one: HTML_DEADLINE_MS bounds the whole response, so a slow fetch
  // shrinks the mux wait rather than stacking on top of it. FLOORED, never zeroed — see
  // MUX_WAIT_FLOOR_MS: a 0ms race beats R2's own head RPC, so a blown budget used to discard a mux that
  // was already sitting warm in the bucket and then decline to cache the degraded card it produced.
  /**
   * CONCURRENT, for the reason the card arm is — and this is the seam DISCORD reads.
   *
   * These ran serially: settleMux first, then the translation re-evaluating the SAME
   * `HTML_DEADLINE_MS - elapsed` expression the mux had just spent. The old comment here argued the
   * translation should get "what is LEFT after the mux, not a fresh budget", because it "must never
   * be the reason Discord gives up on it". The intent is right and is kept; the implementation did
   * something stricter than intended. settleMux does not return early on a cold mux — it races
   * muxOnce against a timer and spends whatever it is handed — so "what is left" was reliably NOTHING
   * and the translation fell to its 300ms floor on every post with remux media.
   *
   * Measured on a live cold Instagram reel while chasing a different bug: the activity document came
   * back translated and this document, for the same post at the same moment, came back with the raw
   * Chinese caption. Two seams, one post, disagreeing — which is the failure this file warns about
   * more than any other.
   *
   * Running them concurrently costs NOTHING against the ceiling, because the response was already
   * waiting on the mux; the translation now overlaps that wait instead of queueing behind it. The
   * XLATE_MAX_WAIT_MS cap STAYS, and matters more here than anywhere else: this route's ceiling is
   * HTML_DEADLINE_MS and overrunning it costs the whole embed, so the translation still may not
   * become the long pole once the mux is done.
   *
   * NOT changed, deliberately: the activity route's translation share. This used to read "the
   * activity route's uncapped MUX_WAIT_API_MS … a 9s budget", which has been wrong since 553bd2e took
   * that route to 1500, and is wrong in a second way since 2026-08-29 — its mux arm is YT_MUX_BOT_MS
   * (4000) on yt and MUX_WAIT_BOT_MS (1500) on everything else. The ARGUMENT outlives all three
   * numbers: over there the translation still overlaps a mux wait the response is spending anyway, so
   * capping it separately would abandon it early to buy nothing. HERE the ceiling is HTML_DEADLINE_MS
   * and overrunning it forfeits the whole embed, which is why the cap stays on this seam.
   */
  const [settled, xlate] = await Promise.all([
    settleMux(post, env, ctx, Math.max(MUX_WAIT_FLOOR_MS, Math.min(MUX_WAIT_BOT_MS, HTML_DEADLINE_MS - (Date.now() - started))), client),
    // The pre-mux post: the mux rewrites media urls and never touches `text`.
    withTranslated(
      post, env, ctx,
      Math.max(XLATE_WAIT_FLOOR_MS, Math.min(XLATE_MAX_WAIT_MS, HTML_DEADLINE_MS - (Date.now() - started))),
    ),
  ])
  const res = render(
    { kind: 'post', post: withTranslation(settled.post, xlate.translated, xlate.source) },
    client, origin,
  )
  // `pending` joins `degraded` for the same reason: caching a card that is missing something still
  // arriving would pin the incomplete version for RESP_TTL.
  if (!settled.degraded && !xlate.pending) {
    // clone() tees the body, so `res` stays readable after we cache a copy.
    const toCache = new Response(res.clone().body, res)
    toCache.headers.set('cache-control', `max-age=${RESP_TTL}`)
    ctx.waitUntil(d.cache.put(rkey, toCache))
  }
  count(env, ref.p, 'ok', client)
  return res
}

/**
 * THE DIRECT-MEDIA HOST — `d.` in front of any serving domain, answering with the POST'S BYTES
 * instead of a card. fxTikTok's `d.` subdomain is the convention being followed.
 *
 * THE HOST CHECK LIVES HERE AND NOT IN route(), AND THAT IS THE WHOLE POINT OF THE PLACEMENT.
 * route() is host-agnostic — it reads url.pathname and url.searchParams and nothing else, a property
 * its own comments state and verify by grep — and that is load-bearing rather than tidy: it is why
 * /dm/{id}, /st/{id} and /im/{id} forcing can exist at all, because dai.ly, streamable.com and
 * imgur.com all collapse onto one undecidable bare /{id}. A host-sensitive route() would make the
 * routing table depend on which domain a link was pasted under, and every one of those decisions
 * would then need re-measuring per host. So the ROUTE is decided host-blind, and only the RESPONSE
 * SHAPE is chosen here, after it. A test pins that separation.
 *
 * `d.` IS A PREFIX TEST, NOT A DOMAIN LIST, so it works on every serving domain — including the ones
 * this file does not know about, which is the same reason `origin` is always the request's own rather
 * than a constant. It is anchored so a host merely CONTAINING "d." cannot match.
 */
const DIRECT_MEDIA_HOST = /^d\.[^.]+\./i

/**
 * The same test, asked of an ORIGIN rather than a hostname, because that is what the render path has
 * to hand. Spelled once so the two callers cannot drift, and total: an unparseable origin is simply
 * not a direct-media host.
 */
function isDirectMediaOrigin(origin: string): boolean {
  try {
    return DIRECT_MEDIA_HOST.test(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Resolve the post and hand back its bytes. A 302 to this post's own /_media/ url rather than a
 * proxy of its own: that route already owns byte-range serving, the R2 mux cache, the container
 * dispatch and the degrade rules, and a second path to the same bytes is a second place for those to
 * disagree. The redirect stays on the `d.` host, so a reader who lands there stays there.
 *
 * NO HUMAN/BOT SPLIT, deliberately, and it is the one place in this file without one. Everywhere else
 * a human is redirected to the original post because a card is for a crawler; here the bytes ARE the
 * product and a person pasting a d. link wants the file, not the post they already had.
 */
async function serveDirectMedia(
  ref: PostRef, d: Deps, env: Env, ctx: ExecutionContext, client: ClientClass, origin: string,
): Promise<Response> {
  const got = await getPost(ref, d, env, client, ctx)
  if (!got.post) {
    count(env, ref.p, 'fetch_fail', client)
    // PLAIN TEXT, NEVER A CARD. This host promises bytes; answering a failure with an HTML embed
    // would hand a media player a document, and `curl -O` a page of markup named like a video.
    return new Response('no media: this post could not be read\n', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  const list = mediaOf(got.post)
  const i = list.findIndex(m => usable(m))
  if (i < 0) {
    count(env, ref.p, 'media_miss', client)
    return new Response('no media: this post has nothing to serve\n', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  count(env, ref.p, 'media_hit', client)
  // bytesIndex, not the bare position: a degraded still lives in the poster slot, and addressing it
  // by its array index hits the VIDEO entry, which answers 503. The renderers all mint through this
  // for the same reason.
  return redirect(mediaUrl(origin, got.post, bytesIndex(list[i], i)))
}

export async function handle(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response> {
  const url = new URL(req.url)

  /**
   * `/_smoke` — the same checks the cron runs, on demand, so a human can ask "is anything broken?"
   * without waiting for a schedule or querying Analytics Engine.
   *
   * IT IS NOT A FETCH PROXY, and that is a property of its design rather than a promise. It takes NO
   * input: the paths are constants in src/smoke.ts and the origin is the request's own, so there is
   * nothing a caller can point it at. A version of this that accepted `?url=` would be an open relay
   * wearing a monitoring badge.
   *
   * IT COSTS WHAT IT LOOKS LIKE. One render per entry in SMOKE_CHECKS, serial, each of which may
   * reach an upstream — so it is deliberately not linked from anywhere and not cached. It answers
   * JSON rather than a card because nothing should ever unfurl it.
   *
   * IT REPORTS ITS OWN ELAPSED TIME, in `ms` here and per check in `results`, because the serial
   * loop's safety is an arithmetic claim about how long a run takes and that claim has to stay
   * checkable. Measured through production 2026-08-12: a run whose caches are all cold takes ~10s
   * for the six checks that existed that morning, and ~0.1s when they are warm — a difference big
   * enough that a number remembered from the wrong run would be off by two orders of magnitude.
   * See SMOKE_BUDGET_MS.
   *
   * WHAT IT IS NOT, now that the list is sixteen entries rather than five: an amplifier somebody can
   * point at the upstreams. Each render goes through the ordinary response and post caches, so a
   * second call within RESP_TTL costs no upstream fetch at all — measured 2026-08-12, a cold run took
   * 10.4s and the two behind it took 0.10s and 0.13s. The floor a caller can force is therefore about
   * one fetch per path per 15 minutes per colo, whatever they do to this endpoint, and only the JSON
   * itself is uncached.
   */
  /**
   * `/_clients` — WHICH YOUTUBE PLAYER CLIENTS ACTUALLY SERVE BYTES FROM THIS EGRESS.
   *
   * THE INSTRUMENT THIS PROJECT NEVER HAD, and the reason three "fixes" shipped dead. Every argument
   * about which `player_client` to use has been settled on a laptop, and a laptop is a residential IP:
   * measured 2026-08-28, the configured list answers 5 of 6 test videos residentially and tells us
   * nothing, because the failures that reach users are Cloudflare-egress-only (~40-50% of Worker-egress
   * YouTube requests refused, while every one succeeds residentially in the same minute). This runs the
   * comparison INSIDE the container, ON that egress.
   *
   * IT ASSERTS ON BYTES, WHICH IS THE WHOLE POINT. The container extracts with each client and then
   * range-fetches the chosen format url, so a client that lists formats and is then refused by
   * googlevideo reports `gvs: "http-403"` rather than looking healthy. That distinction is not
   * hypothetical: on the first residential run, `android_vr` returned `extracted: true, formats: 1`
   * and then 403'd — which also contradicts yt-dlp's own current table saying it needs no PO token.
   *
   * IT TAKES NO INPUT, the same property `/_smoke` has and for the same reason: the video id and the
   * client list are constants in container/server.py. There is no parameter to point anywhere, so this
   * is a diagnostic rather than an open yt-dlp relay.
   *
   * IT IS SLOW AND UNCACHED, deliberately. Serial by design (parallel yt-dlp on a quarter of a vCPU
   * contends for the only scarce resource), and measured at ~68s for six clients at that size. It is
   * not linked from anywhere, answers JSON so nothing unfurls it, and needs MEDIA_RESOLVER — without
   * the binding it says so rather than pretending.
   */
  /**
   * `/_stock/{1|2|3}/{videoId}` — THE STOCK-PLAYER EXPERIMENT. Three head variants that hand
   * Discord YouTube's OWN embed player instead of a muxed mp4, so a real client can say which (if
   * any) renders a playable iframe.
   *
   * WHY IT MIGHT WORK, AND WHY ONLY A REAL PASTE CAN SAY. `twitter:player` pointing at
   * `youtube.com/embed/{id}` is an IFRAME player card: no extraction, no mux, no container, no
   * signature, nothing to time out — the url derives from the id alone — and it is YouTube's own
   * player, so the viewer gets every resolution the video has. It would work on a stone-cold first
   * paste, on a live stream, and on a video past MUX_MAX_SECONDS, which are exactly the three cards
   * this project cannot currently play. koutube (iGerman00/koutube, videoHandler.ts) ships this as
   * its `stock` mode AND as its live-stream fallback, which is evidence Discord renders it — but
   * evidence is not proof, Discord's iframe support is provider-whitelist-shaped, and the page
   * serving the tag here is not youtube.com. Nothing curl-shaped can answer that; a paste can.
   *
   * WHY THREE VARIANTS, one question each:
   *   1 — the player tags alone (plus og:image, og:title). The minimal claim.
   *   2 — variant 1 plus the oEmbed callback link, i.e. can the counts row coexist with the iframe.
   *   3 — variant 2 plus the activity+json link. renderSpoof's whole path competes here: if Discord
   *       prefers the Mastodon document it may draw the photo card and drop the iframe, and that
   *       decides WHERE a real integration would have to sit (replace the yt spoof vs extend it).
   *
   * DELIBERATELY OUTSIDE every production path: nothing links here, nothing response-caches
   * (`no-store`), no container is touched, no R2 is written, and the ordinary /watch route is
   * byte-for-byte unchanged. The title comes from YouTube's cookie-free oEmbed with a static
   * fallback, because a missing title must not fail the experiment. Humans are redirected to the
   * real video, same as every other head. If the experiment wins, the integration is a separate,
   * measured change; if it loses, this route is deleted and the answer gets written down.
   */
  {
    const stock = /^\/_stock\/([123])\/([\w-]{11})$/.exec(url.pathname)
    if (stock) {
      const [, variant, vid] = stock
      // Local spellings of `client` and `origin`: this block sits above the shared declarations,
      // and hoisting those would reorder code that fifteen routes depend on for an experiment.
      const stockClient = classify(req.headers.get('user-agent'))
      const stockOrigin = url.origin
      if (stockClient === 'human') return redirect(`https://www.youtube.com/watch?v=${vid}`)
      // THROUGH THE PLATFORM FETCHER, not a bare fetch: worker.ts performs no egress of its own
      // (the probe enforcer pins that invariant, and it is the architecture, not a lint). This is
      // also more faithful — the title comes from the same call the real card makes.
      let title = 'YouTube video'
      let author = 'YouTube'
      try {
        const got = await fetchYouTube({ p: 'yt', id: vid })
        if (got.ok) {
          const j = got.oembed as Record<string, unknown>
          if (typeof j?.title === 'string' && j.title) title = j.title
          if (typeof j?.author_name === 'string' && j.author_name) author = j.author_name
        }
      } catch { /* the static fallback is the answer */ }
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      const embed = `https://www.youtube.com/embed/${vid}`
      const thumb = `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`
      const tags = [
        `<meta property="og:title" content="${esc(title)} [stock v${variant}]"/>`,
        `<meta property="og:site_name" content="mbedfx stock experiment"/>`,
        `<meta property="og:url" content="https://www.youtube.com/watch?v=${vid}"/>`,
        `<meta property="og:image" content="${thumb}"/>`,
        `<meta property="og:description" content="Variant ${variant}: YouTube's own embed player via twitter:player. Uploaded by ${esc(author)}."/>`,
        `<meta property="og:type" content="video.other"/>`,
        `<meta property="og:video" content="${embed}"/>`,
        `<meta property="og:video:secure_url" content="${embed}"/>`,
        `<meta property="og:video:type" content="text/html"/>`,
        `<meta property="og:video:width" content="1280"/>`,
        `<meta property="og:video:height" content="720"/>`,
        `<meta property="twitter:card" content="player"/>`,
        `<meta property="twitter:title" content="${esc(title)} [stock v${variant}]"/>`,
        `<meta property="twitter:player" content="${embed}"/>`,
        `<meta property="twitter:player:width" content="1280"/>`,
        `<meta property="twitter:player:height" content="720"/>`,
      ]
      if (variant !== '1') {
        tags.push(
          `<link rel="alternate" type="application/json+oembed" href="${stockOrigin}/_oembed/${encodeStatusId(refKey({ p: 'yt', id: vid }))}"/>`,
        )
      }
      if (variant === '3') {
        tags.push(
          `<link rel="alternate" type="application/activity+json" href="${stockOrigin}/users/youtube/statuses/${encodeStatusId(refKey({ p: 'yt', id: vid }))}"/>`,
        )
      }
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"/>${tags.join('')}</head><body>stock-player experiment v${variant}</body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
      )
    }
  }

  /**
   * `/_wait/...` — THE CRAWLER-PATIENCE EXPERIMENT. How long will Discord actually wait for a
   * card? Three routes, unlinked, no-store, outside every production path:
   *
   *   `/_wait/a/{n}/{videoId}[/{tag}]` — the PRODUCTION-SHAPED question. Serves a minimal head
   *       instantly whose activity+json link points at `/_wait/act/{n}/{sid}`; that document is
   *       the REAL activity status for the video, held {n} seconds first. Paste a WARM video and
   *       the drawn card can only contain a player if Discord waited out the delay — the head
   *       carries no player tags of any kind, deliberately, so a timeout-fallback to the head is
   *       visibly playerless rather than a confound.
   *   `/_wait/h/{n}/{videoId}[/{tag}]` — the same head, but the HEAD response itself is held
   *       {n} seconds and the activity link points at the ordinary instant status URL. Separates
   *       the head fetch's budget from the activity fetch's.
   *   `/_wait/act/{n}/{sid}` — the delayed activity document: sleep, then re-enter handle() for
   *       the real `/users/youtube/statuses/{sid}` (the same internal re-entry /_smoke uses), so
   *       shape drift is impossible.
   *
   * WHY THIS EXISTS (2026-08-31). The owner's verdict on 1.14.0's stock player: it re-wraps the
   * YouTube playback Discord already has, which is a stopgap and not the goal. The goal is the
   * native muxed mp4 on a COLD first paste, and the only blocker is arithmetic against an
   * UNMEASURED number: mux p50 is 18.2s, Discord caches a message's embed from its first crawl
   * forever, and every budget in this file descends from "Discord leaves at 3-4s" — folklore
   * whose sole source is a commit message (553bd2e). The one real observation (2026-08-30) is
   * that a ~4.1s activity document drew a full card. If the true ceiling is ~20-30s, holding the
   * activity document until the mux lands converts most cold pastes to the real card, and
   * YT_MUX_BOT_MS gets re-sized around a measurement instead of folklore.
   *
   * {n} is capped at 60: a held Worker response idles and costs nothing, but an open-ended sleep
   * parameter on a public route is an abuse handle. The optional {tag} exists because Discord
   * caches unfurls per-URL — re-testing the same n needs a fresh URL, not a re-paste.
   */
  {
    const wact = /^\/_wait\/act\/(\d{1,2})\/(\d+)$/.exec(url.pathname)
    if (wact) {
      const n = Number(wact[1])
      if (n > 60) return new Response('n is 0-60', { status: 400 })
      if (n) await new Promise(r => setTimeout(r, n * 1000))
      return handle(new Request(`${url.origin}/users/youtube/statuses/${wact[2]}`, { headers: req.headers }), env, ctx, d)
    }
    const wait = /^\/_wait\/([ah])\/(\d{1,2})\/([\w-]{11})(?:\/[\w-]{1,24})?$/.exec(url.pathname)
    if (wait) {
      const [, surface, ns, vid] = wait
      const n = Number(ns)
      if (n > 60) return new Response('n is 0-60', { status: 400 })
      // Local spelling again, for the same reason as /_stock: this block sits above the shared
      // `client`/`origin` declarations that fifteen routes depend on.
      const waitClient = classify(req.headers.get('user-agent'))
      if (waitClient === 'human') return redirect(`https://www.youtube.com/watch?v=${vid}`)
      if (surface === 'h' && n) await new Promise(r => setTimeout(r, n * 1000))
      let title = 'YouTube video'
      try {
        const got = await fetchYouTube({ p: 'yt', id: vid })
        if (got.ok) {
          const j = got.oembed as Record<string, unknown>
          if (typeof j?.title === 'string' && j.title) title = j.title
        }
      } catch { /* the static fallback is the answer */ }
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      const sid = encodeStatusId(refKey({ p: 'yt', id: vid }))
      const actHref = surface === 'a'
        ? `${url.origin}/_wait/act/${n}/${sid}`
        : `${url.origin}/users/youtube/statuses/${sid}`
      // NO og:video and NO twitter:player, on purpose: the drawn card can then only contain a
      // player if the activity document was consumed, which is the entire measurement.
      const tags = [
        `<meta property="og:title" content="${esc(title)} [wait ${surface}/${n}]"/>`,
        `<meta property="og:site_name" content="mbedfx patience experiment"/>`,
        `<meta property="og:url" content="https://www.youtube.com/watch?v=${vid}"/>`,
        `<meta property="og:image" content="https://i.ytimg.com/vi/${vid}/maxresdefault.jpg"/>`,
        `<meta property="og:description" content="Surface ${surface}, ${n}s hold. A player on this card means Discord waited."/>`,
        `<link rel="alternate" type="application/json+oembed" href="${url.origin}/_oembed/${sid}"/>`,
        `<link rel="alternate" type="application/activity+json" href="${actHref}"/>`,
      ]
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"/>${tags.join('')}</head><body>crawler-patience experiment ${surface}/${n}</body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
      )
    }
  }
  if (url.pathname === '/_clients') {
    const resolver = env.MEDIA_RESOLVER
    if (!resolver) {
      return Response.json({ ok: false, error: 'no MEDIA_RESOLVER binding on this deployment' }, { status: 503 })
    }
    const started = Date.now()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
    try {
      // A FIXED SLOT, not a hashed one: this is a diagnostic about the CLIENTS, and spreading it over
      // the pool would answer about a different instance each run and make two results incomparable.
      const r = await resolverStub(resolver, 'client-probe').fetch('http://media-resolver/resolve', {
        method: 'POST', body: JSON.stringify({ probe: true }), headers,
      })
      if (!r.ok) {
        return Response.json({ ok: false, status: r.status, ms: Date.now() - started }, { status: 502 })
      }
      const j = await r.json() as Record<string, unknown>
      const serving = Array.isArray(j.serving) ? j.serving : []
      return Response.json({ ok: serving.length > 0, ms: Date.now() - started, ...j })
    } catch {
      // Never a 500: this is a diagnostic, and one that crashes tells an operator less than one that
      // reports it could not reach the container.
      return Response.json({ ok: false, error: 'resolver unreachable', ms: Date.now() - started },
        { status: 502 })
    }
  }

  if (url.pathname === '/_smoke') {
    const started = Date.now()
    const results = await runSmoke(url.origin, u => handle(new Request(u, {
      // Rendered as a crawler, because that is the reader whose experience is being checked.
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
    }), env, ctx, d))
    for (const r of results) count(env, r.platform, smokeOutcome(r.verdict), SMOKE_CLIENT)
    const failed = results.filter(r => r.verdict !== 'ok')
    return Response.json({
      ok: failed.length === 0,
      checked: results.length,
      ms: Date.now() - started,
      // `name`, not `platform`: bs has two rows, and a failure list that named only the platform
      // would leave the reader unable to tell the profile route from the post route.
      failed: failed.map(f => ({ name: f.name, verdict: f.verdict })),
      results,
    }, { headers: { 'cache-control': 'no-store' } })
  }

  // Always the request's own origin — never a constant. A hardcoded prod origin
  // would make staging embeds point Discord's media proxy at the live prod worker.
  const origin = url.origin
  const client = classify(req.headers.get('user-agent'))
  // Computed once and consulted by every post-yielding arm: on a d. host a HUMAN wants the bytes too,
  // so the usual "bounce a person to the original post" must not fire. renderPostRoute makes the
  // same check for the render half.
  const direct = DIRECT_MEDIA_HOST.test(url.hostname)
  const r = route(url)

  switch (r.kind) {
    case 'site':
      return env.ASSETS.fetch(req)

    case 'notfound':
      count(env, 'none', 'notfound', client)
      return render({ kind: 'failure', canonical: null, platform: null, reason: 'not found' }, client, origin)

    case 'ambiguous':
      count(env, 'none', 'ambiguous', client)
      return render(r, client, origin)

    // A spoof-shaped path whose {id} did not decode. The path shape already tells us the
    // caller is parsing JSON, so this gets the same 404 body a live post that vanished
    // would — NOT render()'s HTML embed, which such a caller parse-fails on. It has no ref,
    // so there is no platform to attribute and nothing to fetch; an id we cannot decode
    // names no post, and probing upstream on one would be free amplification.
    case 'badid':
      count(env, 'none', 'api_bad_id', client)
      return Response.json({ error: 'Record not found' }, { status: 404 })

    case 'media': {
      // Deliberately does NOT branch on client class: every class gets the same 302.
      // That is what lets us skip detecting Discord's fake-Firefox media proxy.
      const { post, cached } = await getPost(r.ref, d, env, client, ctx)
      // media_miss means "this cost an upstream fetch", not "404". The spec's alert
      // watches the miss/hit ratio to detect fetch amplification; keying it on 404s
      // would make that failure invisible.
      count(env, r.ref.p, cached ? 'media_hit' : 'media_miss', client)
      // A remux video (present only when the resolver bindings exist — withResolver strips it
      // otherwise) is served as a muxed MP4 from R2/the container; everything else 302s to its url.
      const entry = post && typeof r.index === 'number' ? pickMediaEntry(post, r.index) : null
      if (entry?.remux && env.MEDIA_RESOLVER && env.MEDIA_CACHE) {
        return serveMuxed(req, env, ctx, r.ref, r.index as number, entry.remux)
      }
      /**
       * A DIRECT (non-remux) VIDEO ON A CDN WE HAVE MEASURED IS STREAMED BY US, NEVER 302'd.
       *
       * Instagram hands us ONE complete progressive mp4, so unlike a `remux` there is nothing to
       * compute — this is a pass-through, not a mux: no container, no R2 write, no cold path, and the
       * head can keep promising og:video with no settleMux wait.
       *
       * THE MEASUREMENT (2026-07-25, 3/3 each): the CDN's plain 200 for a 38,774,320-byte reel
       * carries no `accept-ranges: bytes`, while a 2,471,034-byte reel's does — and those are exactly
       * the reel that draws no Discord card and the reel that plays. It honours Range on both
       * regardless. A 302 cannot add that header to someone else's response; serving the bytes can,
       * and does (see mediaproxy.ts for the full measurement).
       *
       * IMAGES, POSTERS AND AVATARS KEEP THE 302 — proxyableVideoUrl returns null for every
       * non-numeric index and every non-video entry, so this is video-only by construction.
       */
      const direct = post ? proxyableVideoUrl(post, r.index) : null
      if (direct) {
        const streamed = await serveDirectVideo(req, direct)
        if (streamed) return streamed
        // SERVER-SIDE ONLY (wrangler tail), and NO counter — serveMuxed's precedent, and the reason
        // is that assert_fail already means "Instagram's PAGE gate moved" on this platform (see
        // platforms/instagram/fetch.ts). Counting a refused CDN byte-fetch under the same name would
        // put two unrelated events in one alert and blunt the one that matters. The ref is safe to
        // log; the url (a signed CDN url) is never logged.
        console.error('media proxy failed', refKey(r.ref), String(r.index))
        /**
         * A REFUSED PROXY FALLS THROUGH TO THE 302 — it does NOT answer notReady().
         *
         * This proxy is an OPTIMISATION over a shipped, measured-good path, so its failure must
         * cost exactly that optimisation and nothing else. The risk it would otherwise carry is
         * concrete, not hypothetical: this fetch leaves Cloudflare's DATACENTER egress toward
         * scontent*.cdninstagram.com, and platforms/threads/normalize.ts records the measurement
         * that Meta blocks that egress for Threads video on the SAME host family. If Instagram
         * behaves likewise — or starts to — a 503 here would take down every Instagram video,
         * INCLUDING the small reels that play today, in exchange for fixing the large ones.
         * Falling back to the 302 makes the worst case "unchanged from today" instead.
         *
         * SAFE, and specifically not the poisoned-url defect that notReady() exists to prevent:
         * that defect was a VIDEO url answering with an IMAGE content-type (Discord then caches
         * "this video is an image" forever, keyed by a url that never changes). `target` below is
         * this same video entry's own url — the exact bytes og:video promises — so the redirect
         * cannot mislabel anything. notReady() remains correct for serveMuxed, where the fallback
         * on offer really was the poster still.
         */
      }
      // EVERYTHING ELSE STILL 302s, and images are the deliberate part of that. A picture 302 is
      // measured-good on every platform today, cannot poison a url (its content-type is what the url
      // promises — the defect was always video-url-serves-image, never image-serves-image), and
      // proxying would multiply streamed bytes by gallery size: a 10-child Instagram carousel is ten
      // held-open subrequests, for no measured gain. Videos get the proxy because videos are where
      // the measurement says the 302 fails.
      const target = post ? pickMedia(post, r.index) : null
      if (!target) return new Response('media unavailable\n', { status: 404 })
      return new Response(null, {
        status: 302,
        headers: { location: target, 'cache-control': `public, max-age=${MEDIA_MAX_AGE}` },
      })
    }

    // The two Mastodon-spoof callbacks. Grouped because they differ in exactly one
    // expression: same cache read, same counters, same 404 — only the mapper changes.
    case 'activity':
    case 'oembed': {
      // Class-agnostic, deliberately, and with NO human short-circuit. Copying the post
      // route's `client === 'human'` redirect here would 302 Discord's own callback the day
      // its UA stopped matching, and these endpoints have no human-facing page to redirect
      // to anyway — the ref is the whole route, there is no canonical in it.
      const { post, cached } = await getPost(r.ref, d, env, client, ctx)
      // Counted before the null check, like media: this measures whether the request cost an
      // upstream fetch, not whether it succeeded. Keying it on success would hide the very
      // amplification the counter exists to expose.
      count(env, r.ref.p, cached ? 'api_hit' : 'api_miss', client)
      if (!post) {
        // Counted on top of the api_miss above, exactly as the post route does on the same
        // condition. Without it a cold success and a cold failure emit byte-identical
        // analytics, so a callback arriving while upstream is down has no signal of its own.
        count(env, r.ref.p, 'fetch_fail', client)
        // Real Mastodon's body for a status that is not there. A JSON consumer must never be
        // handed our HTML error embed — it would parse-fail rather than degrade, and the
        // renderer's whole contract is to degrade. The 'badid' case above answers the other
        // way this route fails: an {id} that never named a post at all.
        return Response.json({ error: 'Record not found' }, { status: 404 })
      }
      // Response.json sets exactly `application/json`, with no charset parameter — verified
      // against live FxEmbed output (spec §6c). A hand-rolled
      // `new Response(JSON.stringify(x), {headers:{'content-type':'application/json'}})`
      // would be equivalent today but is one edit away from picking up a charset.
      // THE SAME mux gate the HTML head applies (settleMux) — this is the document Discord actually reads
      // the card from, and its `media_attachments[].type: "video"` is what draws the player. Promising a
      // video here that the /_media route cannot yet serve is the same lie the head stopped telling; by
      // now the mux started during the HTML render is usually done, so this normally KEEPS the video.
      /**
       * CONCURRENT WITH THAT WAIT, NOT AFTER IT — which is the whole latency argument for putting
       * YouTube's date here. The wait it rides has moved twice, so the numbers are written out rather
       * than left as "MUX_WAIT_API_MS": that was 9000, 553bd2e took it to 1500 — which broke this
       * argument silently, because 1500 is below the date arm's own 1716ms median (see
       * YT_META_BOT_MS) — and since 2026-08-29 the yt mux arm is YT_MUX_BOT_MS (4000) against a date
       * arm of 4000. So a cold-mux callback pays ZERO extra wall clock for a correct timestamp again,
       * and the route's ceiling is set by the mux arm rather than by this one.
       * Scoped to 'activity' because that is the only document with a date field:
       * toOEmbed's seven fields carry none, so the /_oembed callback makes no meta call at all.
       */
      /**
       * THE TRANSLATION RIDES THIS SEAM TOO, for the reason the age note does.
       *
       * REPORTED 2026-07-31 on a Japanese post that showed no translation. It WAS being translated —
       * into og:description, which is the one document Discord does not read for a post with media.
       * This callback re-derives the post from cache and renders it independently, so an overlay
       * applied only in renderPostRoute is, from the reader's side, applied nowhere.
       *
       * Concurrent with the mux wait, which this route already pays, so a correct card costs zero
       * extra wall clock — the same argument that put YouTube's date here.
       */
      /**
       * BOUNDED FOR A CRAWLER, not for correctness — see MUX_WAIT_BOT_MS. This document is fetched by
       * Discord immediately after the head, so its ceiling is the second half of a budget that was
       * already spent. All three writes land in R2 under ctx.waitUntil regardless, so the next view is
       * complete; only the FIRST paste trades the date, the counts and the player for a card that
       * arrives at all.
       *
       * THREE BUDGETS, NOT ONE, both splits dated 2026-08-29. The three arms were given the same 1500
       * because they share a response, not because they cost the same.
       *
       * The METADATA arm gets YT_META_BOT_MS (4000): its own recorded median for a SUCCESS is 1716ms,
       * so 1500 cut it off below the middle of its hit distribution.
       *
       * The MUX arm gets YT_MUX_BOT_MS (4000) on yt, and keeps `botBudget` everywhere else. "A cold
       * mux cannot finish inside any crawler budget, so spending more on it buys nothing" is what this
       * comment used to say, and the production counters retired it: 0 of 139 successful yt muxes have
       * ever finished inside 1500ms, but the fastest finished in 4200ms, and this arm has a head
       * render's worth of head start on top of its budget. Read YT_MUX_BOT_MS — it is the one number
       * here that can lose a card, and it carries the whole trade.
       *
       * The TRANSLATION keeps `botBudget`: it has a warm R2 path in front of it, and it is the least
       * important thing on the card (see XLATE_MAX_WAIT_MS, which is the same 1500 anyway).
       *
       * The response ends at the SLOWEST arm, so the worst case on the yt activity document moved
       * 1500 -> 4000, and it is paid only on a cold mux — which is exactly the paste that is failing
       * today. Everywhere else it is unchanged at 1500.
       */
      const botBudget = Math.min(MUX_WAIT_BOT_MS, MUX_WAIT_API_MS)
      /**
       * THE MUX ARM'S BUDGET IS NOT THE SHARED ONE HERE — see YT_MUX_BOT_MS for the measurement and
       * the trade. Scoped two ways, and both scopes are load-bearing.
       *
       * `p === 'yt'` because the raise is priced against YouTube's mux distribution and nothing
       * else's, and because fb/dm/st/im pay META_TIMEOUT_MS (4700) inside the `getPost` above, which
       * is awaited SEQUENTIALLY before this Promise.all. A global raise would take their activity
       * worst case from ~6.2s to ~8.7s, past the 5.14s bound, for a budget nobody measured for them.
       *
       * `kind === 'activity'` because toOEmbed reads exactly two things off the post — the author
       * name and the canonical url — and settleMux can change neither. That callback is a THIRD
       * crawler request, already spending up to 1500ms of mux wait on a document that cannot differ;
       * giving it 4000 would buy literally nothing and cost the reader 2.5 more seconds.
       *
       * The `Math.min` above stays as it is. Deleting it to widen the budget would be a silent 6x
       * raise on every platform and both callback kinds — what remains is: the shared arms take
       * MUX_WAIT_BOT_MS (1500), because it is the smaller of the two, on every route through here.
       */
      const muxBudget = r.kind === 'activity' && r.ref.p === 'yt' ? YT_MUX_BOT_MS : botBudget
      const [settledApi, meta, xlate] = await Promise.all([
        settleMux(post, env, ctx, muxBudget, client),
        r.kind === 'activity' ? deadline(youtubeMeta(r.ref, post, env, ctx), YT_META_BOT_MS) : null,
        r.kind === 'activity' ? translationFor(post, env, ctx, botBudget) : null,
      ])
      return Response.json(
        r.kind === 'activity'
          // ALL FIVE overlays, from the one record — it was three, then four, and the count is kept
          // current here because "applying only some of them" is the recurring defect. Each arrives
          // after the Post was built, and every one left out leaves the card silent about that fact
          // on every first paste. Translation is applied LAST so the marker trails the body the age
          // note may have extended. withDescription runs BEFORE withAgeNote so the note keeps the top
          // of the body on an age-gated video, and before withTranslation so a foreign-language
          // description is what gets translated.
          //
          // AND BEFORE withLengthNote, corrected 2026-08-29. The two were nested the other way round,
          // so on a video past the ceiling the note went into an empty `text` first and
          // withDescription then declined to overwrite it ("A body already present wins") — the card
          // got the note or the description, never both. Only the order changed; both functions
          // prepend, so the resulting body is note-then-description either way.
          ? toMastodonStatus(
            withTranslation(
              withAgeNote(
                withCounts(
                  // BOTH SEAMS OR NEITHER. This is the document Discord reads for a post WITH media,
                  // which is every video — so a length note applied only to the plain head would be,
                  // from a reader's side, applied nowhere. describeTarget applies the same five in the
                  // same order; a change here that is not made there re-splits them.
                  //
                  // withLiveNote sits INSIDE withLengthNote so the length note can see it and stand
                  // down — one reason per card, and the live one is the reason the mux was refused.
                  withLengthNote(
                    withLiveNote(
                      withDescription(
                        withUploadDate(settledApi.post, meta?.timestamp),
                        meta?.description,
                      ),
                      meta?.isLive,
                    ),
                    meta?.duration, MUX_MAX_SECONDS,
                  ),
                  meta,
                ),
                meta?.ageLimit,
              ),
              xlate?.text, xlate?.source ?? '',
            ),
            origin,
          )
          : toOEmbed(settledApi.post, origin),
      )
    }

    case 'prep': {
      /**
       * THE FIXER PAGE, GETTING READY. Requested 2026-07-31: "if someone puts in a video which would
       * be going through yt-dlp then when they submit the link it kicks off the download/mux in the
       * background." The page is the one moment we know a link is ABOUT to be shared, and today the
       * first paste of a cold video degrades to a still because the mux starts when Discord arrives.
       *
       * IT GRANTS NO NEW REACHABILITY. Every effect here is what a Discordbot GET of the same url
       * already produces seconds later, reachable by anyone who sets a UA: the same fetch, the same
       * container dispatch, behind the same SPECULATIVE_MUX_CAP and the same muxOnce dedupe. It buys
       * latency, not permission. That is the entire reason this endpoint may do real work rather than
       * being a pure lookup — and it is the sentence to re-examine before widening it.
       *
       * THE RESOLUTION IS THE PART THE PAGE WAITS FOR; the warm is not. Answering the JSON and then
       * doing the expensive half in waitUntil is what keeps the input responsive, and it means a slow
       * or failing upstream costs the typist nothing.
       */
      let inner: Route
      try {
        inner = route(new URL(r.target, origin))
      } catch {
        return Response.json({ ok: false, reason: 'unparseable' }, { status: 400 })
      }
      /**
       * WHAT WAS ACTUALLY PASTED, captured before any resolution reassigns `inner`. It is what lets
       * this endpoint tell "I learned something" from "I merely re-spelled what you gave me".
       */
      const pasted = inner
      // A share code names no post until a hop resolves it, so the page gets the REAL permalink
      // rather than the opaque token it pasted — the "unfurl to the full thing" half of the ask.
      inner = await unwrapToPost(inner, d, env, client)

      if (inner.kind !== 'post') {
        /**
         * AN AMBIGUOUS PATH HANDS BACK ITS CANDIDATES, so the page can offer a choice instead of a
         * dead end. This is the router's own answer — the same list renderChooser shows a human —
         * rather than anything the page guesses, which is the point: route() is the only thing that
         * knows /gallery/{id} is contested between Reddit, Instagram and Imgur.
         *
         * The forced url is built here too, because the ESCAPE token that disambiguates each one is
         * router vocabulary and the page has no business re-spelling it.
         */
        if (inner.kind === 'ambiguous') {
          return Response.json({
            ok: false,
            reason: 'ambiguous',
            candidates: inner.candidates.map(p => ({
              platform: p,
              name: displayName(p),
              url: `${origin}/${p}${new URL(r.target, origin).pathname}`,
            })),
          })
        }
        return Response.json({ ok: false, reason: inner.kind })
      }
      const ref = inner.ref
      /**
       * ONLY WHEN THERE IS SOMETHING TO WARM. prewarmable() is the existing answer to "does this ref
       * imply a container mux", reused rather than re-spelled — a page that fired a full render at
       * every pasted link would spend an upstream fetch on every keystroke's worth of debounce for
       * platforms that have no mux at all.
       */
      /**
       * A TYPED FACEBOOK SHARE CODE IS UNFURLED TOO, not just the bare one.
       *
       * Reported 2026-08-01 alongside the failing card: "it's also not unfurling the url as I'd
       * expect". /share/p/{code} routes straight to a post ref, so prep answered with the share url
       * itself — and answered it with the WRONG LETTER, because fbCanonical rebuilds every typed share
       * as /share/v/. A reader who pasted a `p` link was shown a `v` link they did not ask for.
       *
       * SAFE HERE IN A WAY IT IS NOT IN THE ROUTER. This does not change which ref is rendered,
       * cached or warmed — `ref` is untouched below, so a resolution that misses costs the page
       * nothing and a card that works keeps working. It changes only the LINK THE PAGE DISPLAYS, and
       * prep is the one endpoint whose whole job is getting ready before anyone pastes.
       *
       * It is also only now WORTH doing: until the post permalink shapes were routable, the resolved
       * url would have been a link we then could not read.
       */
      let shown = inner.canonical
      if (ref.p === 'fb' && ref.kind === 'share') {
        let loc: string | null = null
        try {
          loc = await d.resolveMetaShare(ref.id)
        } catch {
          loc = null
        }
        const resolved = loc ? route(new URL(stripMetaTracking(loc), 'https://www.facebook.com')) : null
        if (resolved?.kind === 'post' && resolved.ref.p === 'fb') shown = resolved.canonical
      }
      const warms = prewarmable(ref) !== null
      if (warms) {
        // The render is discarded; the point is its SIDE EFFECTS — the post lands in the cache and
        // the mux starts. waitUntil keeps it alive past this response, exactly as settleMux does.
        /**
         * CONSUMED, NOT CANCELLED. `res.body.cancel()` looked like the tidy way to throw away a
         * render nobody reads, and it HANGS: renderPostRoute clones its response to populate the
         * cache, so the body is teed, and cancelling one branch while the other is still unread never
         * settles. Measured — the prep JSON returned in 23ms and the waitUntil promise was still
         * pending 8 seconds later, which on a Worker means an isolate held open for nothing.
         * arrayBuffer() drains it, which is what actually releases both branches.
         */
        ctx.waitUntil(
          renderPostRoute(ref, inner.canonical, d, env, ctx, 'discord', origin)
            .then(res => res.arrayBuffer())
            .then(() => undefined)
            .catch(() => undefined),
        )
      }
      /**
       * DO NOT RE-SPELL A LINK THAT WAS ALREADY RIGHT.
       *
       * Reported 2026-08-03: pasting youtu.be/{id} came back as /watch?v={id}. The page converts that
       * short form to a bare /{id} correctly on its own, and this endpoint then overwrote it — because
       * the url was rebuilt from the PLATFORM'S canonical every time, which for YouTube is the long
       * watch form. Nothing was learned by that rewrite; it only made the link longer than the one the
       * reader pasted, on the one screen whose entire job is handing back a tidy link.
       *
       * The rewrite exists for a real case and is kept for it: a share code or a shortlink names no
       * post until a hop resolves it, so the page must be handed the permalink rather than the opaque
       * token. The test is therefore not "is this canonical" but "did resolving CHANGE which post this
       * addresses" — and when it did not, whatever was pasted comes back untouched.
       *
       * `shown === inner.canonical` is part of that test rather than an afterthought: the Facebook
       * branch above deliberately rewrites `shown` while leaving `ref` alone, so comparing refs on
       * their own would silently undo that unfurl.
       */
      const target = new URL(r.target, origin)
      const alreadyRight = shown === inner.canonical
        && pasted.kind === 'post'
        && refKey(pasted.ref) === refKey(ref)
      const shownUrl = alreadyRight ? target : new URL(shown)
      return Response.json({
        ok: true,
        url: `${origin}${shownUrl.pathname}${shownUrl.search}`,
      canonical: shown,
      platform: ref.p,
      warming: warms,
    })
    }

    case 'card': {
      /**
       * WHAT DISCORD WILL DRAW, AS DATA — so the fixer page can show the card instead of a url and a
       * promise.
       *
       * THE PAGE CANNOT ASK FOR THIS ITSELF. A browser fetching the converted url is classified
       * `human` and gets a 302 to the platform, not an embed; there is no UA it can set from script.
       * So the description has to come from here or not at all.
       *
       * IT DESCRIBES THE POST, NOT THE MARKUP. The obvious implementation renders the Discord html and
       * regexes it back apart, which is worse in both directions: it is fragile against our own
       * renderers, and it silently picks ONE SEAM. Discord reads the Mastodon spoof for a post with
       * media and the og head for one without, so a preview parsing the head would be wrong for
       * exactly the media posts this feature exists to show. Both seams are built from the same Post
       * by the same predicates — usable(), mediaOf(), themeColor() — so describing the Post with those
       * predicates cannot drift from either.
       *
       * THE PIPELINE IS renderPostRoute's, deliberately: settleMux then withTranslated, in that order
       * and with the same budget shape. A preview that skipped them would show a still where the card
       * plays a video, or omit a translation the card carries.
       *
       * IT GRANTS NO NEW REACHABILITY, the same argument /_prep makes: every effect is what a
       * Discordbot GET of this url already produces, behind the same caches and the same container
       * bounds. It buys the page a picture, not permission.
       *
       * THE PIPELINE MOVED OUT, 2026-08-03, and nothing about the answer changed. It is describeTarget
       * now, shared with /_api/v1 — see that function for why it is one function rather than two.
       */
      const described = await describeTarget(r.target, d, env, ctx, client, origin)
      if (!described) return Response.json({ ok: false, reason: 'unparseable' }, { status: 400 })
      if (!described.ok) {
        // The page shows the same 🔞/🔒 wording Discord would, rather than inventing its own. `gate`
        // is undefined on every non-gate failure and JSON.stringify omits it, which is the shape this
        // endpoint has always returned — the candidates describeTarget also computes are deliberately
        // NOT emitted here, because the page has its own chooser and /_prep is what feeds it.
        return described.reason === 'fetch_fail'
          ? Response.json({ ok: false, reason: 'fetch_fail', gate: described.gate })
          : Response.json({ ok: false, reason: described.reason })
      }
      const post = described.post
      // PAIRED WITH ITS UNFILTERED POSITION — see usableWithIndex for the off-by-one this replaced.
      const own = usableWithIndex(post)
      return Response.json({
        ok: true,
        /**
         * THE ONE THING THE PAGE COULD NOT PREVIOUSLY LEARN: that this answer is incomplete.
         *
         * A translation that loses its race sets pending, and everywhere else in the worker that is
         * enough — renderPostRoute reads it to suppress the response cache, so the NEXT render heals.
         * The converter page never gets a next render: it fetches /_card once per typing-settle and
         * draws whatever came back. So the one surface that cannot self-heal was also the only one
         * not told it needed to.
         *
         * The work is still running in ctx.waitUntil and writes to R2 as this response goes out, so a
         * single re-fetch a couple of seconds later hits the warm path for free rather than paying a
         * second inference. The page does exactly that and then stops.
         */
        pending: described.pending,
        /**
         * A VIDEO IS STILL BEING MUXED, and this is the only way the page can know.
         *
         * settleMux degrades an unfinished video to its POSTER STILL and keeps working in waitUntil,
         * so the payload is indistinguishable from a post that only ever had a picture: kind 'image',
         * a url that resolves, nothing wrong with it. The reader saw a frozen frame and no reason for
         * it, which is why "why is this just an image" keeps being asked about a link that is fine.
         *
         * Distinct from the LENGTH note, which is the opposite case and must not be confused with it:
         * over the ceiling the answer is final and permanent, and the card says so in words. This flag
         * means the opposite — come back in a moment and it will be a video.
         *
         * Reported as wanting "a progress bar for the download". It cannot be a progress bar: yt-dlp
         * and ffmpeg run inside the container and the Worker sees a Durable Object that has either
         * finished or not. A truthful indeterminate spinner beats a fake percentage.
         */
        muxing: described.muxing,
        canonical: post.canonical,
        platform: post.ref.p,
        author: {
          name: post.author?.name || '',
          handle: post.author?.handle || '',
          /**
           * THE LINE DISCORD ACTUALLY DRAWS — "Name (@handle)" — named for what it is. It was briefly
           * returned as `handle`, which described the same string as something it is not; the page
           * renders this verbatim rather than re-assembling the two halves and inventing a third
           * spelling of the author line.
           */
          byline: byline(post.author),
          avatar: post.author?.avatar ? `${origin}/_media/${encodeURIComponent(refKey(post.ref))}/avatar` : null,
        },
        title: post.title || null,
        text: post.text || '',
        counts: post.counts || {},
        /**
         * THE RENDERER'S OWN STAT LINE, not the numbers for the page to re-assemble.
         *
         * Reported 2026-08-01 with a side-by-side screenshot: the real card reads
         * "❤️ 204.5K  💬 1.3K  🔁 69.2K" and the preview read "❤️ 204.5K  🔁 69.2K  💬 1.3K" — the
         * page had invented its own order, and its own abbreviation (toFixed ROUNDS; abbrev
         * TRUNCATES, so 999,950 renders "1000K" one way and "999.9K" the other).
         *
         * Both were the same mistake: a preview that re-implements a renderer is a preview that
         * drifts from it. statParts is the one function both surfaces now read, so the order, the
         * emoji codepoints and the rounding cannot disagree again.
         */
        stats: statParts(post),
        /**
         * THE QUOTED POST, because the card draws one and the preview did not.
         *
         * Reported 2026-08-01 with a side-by-side: Discord rendered "Quoting <name> (@handle)" and
         * the quoted text as an indented block, and the preview showed the outer post alone — so a
         * quote-tweet previewed as a completely different, and much emptier, card than the one that
         * would be posted.
         *
         * Depth is capped at 1 by the normalizer (post.quote.quote is always undefined), so this
         * cannot recurse. `byline` is the same function the card's own quote header uses, so the two
         * cannot render the author differently.
         */
        quote: post.quote && post.quote.author
          ? {
            byline: byline(post.quote.author),
            text: post.quote.text || '',
            canonical: post.quote.canonical || null,
          }
          : null,
        sensitive: !!post.sensitive,
        createdAt: post.createdAt instanceof Date ? post.createdAt.toISOString() : null,
        media: own.map(({ m, i }) => ({
          kind: m.kind === 'video' || m.kind === 'gif' ? 'video' : 'image',
          url: mediaUrl(origin, post, bytesIndex(m, i)),
          /**
           * THE POSTER, BECAUSE `url` ON A VIDEO IS THE MP4 AND AN <img> CANNOT DRAW ONE.
           *
           * The preview shipped without this and a YouTube card came out as an author line and a
           * title with a blank space where the thumbnail belongs — the image element was pointed at
           * video bytes and failed silently, which is the worst way for it to fail.
           *
           * Same derivation as the spoof's preview_url (mastodon.ts's posterUrl), including the
           * condition: ONLY when the entry actually carries a poster. pickMedia has no fallback from
           * the poster slot to the bytes, so an unconditional /_media/{key}/poster{i} would advertise
           * a guaranteed 404 — the same picture-shaped hole Phase 1 already paid for once.
           */
          poster: str(m.poster) ? mediaUrl(origin, post, { poster: i }) : null,
          w: m.posterW ?? m.w ?? null,
          h: m.posterH ?? m.h ?? null,
        })),
        /**
         * THE STRIPE, AND IT IS NOW REALLY OURS. This briefly shipped beside a `colorHonoured` flag
         * built on a WRONG diagnosis: the reel that rendered in Discord's default colour was read as
         * proof that a card with media takes the Mastodon spoof and the spoof has no colour field.
         * The spoof was never involved — the head was spelling the tag `property="theme-color"`,
         * which is not a thing Discord reads, so it found no colour at all and fell back.
         *
         * Corrected in discord.ts (name=, as the standard requires and as every fixer that gets a
         * coloured stripe uses), so the flag is gone rather than left to caveat a problem that no
         * longer exists. A preview that under-promises is still a preview that misinforms.
         */
        color: themeColor(post),
      })
    }

    case 'api': {
      /**
       * THE PUBLIC JSON API — the post this url names, as data, for anything that is not Discord.
       *
       * IT IS A CONTRACT, AND THAT IS THE ONLY THING THAT MAKES IT DIFFERENT from /_card. The preview
       * describes a card for one page we also write, so a field can be renamed the same afternoon it
       * is regretted. Everything below is a promise to somebody whose code we will never see, so the
       * rule applied throughout is: publish what is stable, withhold what is incidental, and prefer
       * omitting a value to inventing one. `color`, `stats` and `byline` are all deliberately absent —
       * they are the CARD's answers (a stripe colour, a pre-rendered stat line, a pre-assembled author
       * line), and a consumer building its own presentation wants the facts underneath them.
       *
       * EVERY ANSWER ABOUT A POST IS HTTP 200, including the gates. Rule 1 of this project pointed
       * outward: our own upstreams answer 200 with a login wall and 500 with a JSON error, which is
       * why nothing here asserts on status — so it would be incoherent to then make a consumer branch
       * on ours. `ok` and `error.code` are the contract. The non-200s are all about the REQUEST — 400
       * for a missing or unreadable `url`, 405 for a write verb — and never about the post.
       *
       * THE HOST IN `url` IS IGNORED, and the tie it could break is left unbroken. `/gallery/abc` is
       * Reddit, Instagram or Imgur, and this endpoint is handed a full url that says which — so it
       * looks like free disambiguation. It is not free: it would make the answer depend on a string
       * the caller controls, on a service where a hostname is a thing we FETCH (the fediverse arm
       * turns one into a request, and refkey.ts is explicit that Cloudflare is not relied on to block
       * private addresses). An ambiguous path answers `ambiguous` with the candidate list, and the
       * caller re-asks with a two-letter prefix — the same escape hatch the site documents.
       */
      /**
       * THE METHOD IS CHECKED BEFORE ANYTHING IS SPENT, and a preflight is answered rather than run.
       *
       * Both halves were wrong when this shipped for review. `OPTIONS /_api/v1?url=…` fell straight
       * through to the pipeline: a browser's CORS preflight paid for a full upstream fetch, a mux wait
       * and a `yt-dlp -J`, and then answered without `access-control-allow-methods` — so the preflight
       * FAILED, the real GET never fired, and we had bought the whole request for a call the browser
       * then threw away. Any consumer sending a custom header (which is what makes a request
       * preflighted) hit that, which is most of the ones a documented CORS-open API invites.
       *
       * POST/PUT/DELETE were likewise served the entire pipeline. This endpoint reads; a write verb is
       * a caller mistake and answering it cheaply is both correcter and cheaper.
       */
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...apiHeaders('no-store'),
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': '*',
            'access-control-max-age': '86400',
          },
        })
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return apiError(405, 'method_not_allowed', 'This endpoint reads. Use GET.')
      }
      if (!r.target) {
        return apiError(400, 'no_url', 'Pass the post url as the `url` query parameter.')
      }
      const described = await describeTarget(r.target, d, env, ctx, client, origin)
      if (!described) {
        return apiError(400, 'unparseable', 'That `url` could not be parsed as a url.')
      }
      if (!described.ok) {
        const { code, message } = apiFailure(described)
        return apiError(200, code, message, {
          platform: described.platform ?? null,
          canonical: described.canonical ?? null,
          ...(described.candidates ? { candidates: described.candidates } : {}),
        })
      }
      /**
       * AN INCOMPLETE ANSWER IS NEVER CACHED, and both flags below are that. A video still muxing is
       * serving its poster still, and a translation that lost its race is serving the original — cache
       * either and the correct answer never arrives, which is the rule renderPostRoute already follows
       * for exactly these two. A consumer that sees `muxing` or `pending` true can ask again in a few
       * seconds and get the finished answer for free: both are still running in waitUntil and will
       * have written by then.
       */
      const complete = !described.muxing && !described.pending
      return Response.json(
        {
          ok: true,
          muxing: described.muxing,
          pending: described.pending,
          post: toApiPost(described.post, origin),
        },
        { headers: apiHeaders(complete ? `public, max-age=${RESP_TTL}` : 'no-store') },
      )
    }

    case 'post': {
      // Humans never cost us an upstream fetch: the router already knows canonical. The bot half —
      // cache-check, fetch, render, cache — is renderPostRoute, shared with the reddit share route so
      // a fetch_fail gets the distinct 🔞/🔒 or generic card identically whichever url shape was pasted.
      if (!direct && client === 'human') return redirect(r.canonical)
      return renderPostRoute(r.ref, r.canonical, d, env, ctx, client, origin)
    }

    /**
     * AN ACCOUNT — `/profile/{handle}`. Deliberately NOT renderPostRoute, and the list of what it
     * would have brought with it is the reason: a container prewarm keyed on a refKey a profile has
     * no way to mint, a settleMux deadline for a video that does not exist, a translation race for a
     * body that is a bio, and a POST cache whose TTL assumes the thing it stores does not change. A
     * profile is a live surface; the only cache it takes is the RESPONSE one, below.
     *
     * THE d. HOST IS NOT SPECIAL-CASED. That host exists to hand a media file straight to a client,
     * and a profile has no media file — only an avatar, which is already a plain origin url on the
     * card. So a d. profile link renders the same card, which is the honest answer rather than a
     * 404 for a url somebody typed by habit.
     */
    case 'profile': {
      if (client === 'human') return redirect(r.canonical)
      // Keyed like every other rendered response: the client class (two clients get different
      // markup) and the ORIGIN (the markup carries a hostname, and two zones are live), in a
      // namespace that cannot collide with a refKey because refKey always starts with a Platform
      // tag and 'profile' is not one. Same argument as cache.ts's `short:` infix.
      const pkey = cacheUrl(`resp:profile:${r.ref.p}:${encodeURIComponent(r.ref.handle)}:${client}:${origin}`)
      const hit = await d.cache.match(pkey)
      if (hit) return hit
      const profile = await d.fetchProfile(r.ref, env, client)
      if (!profile) {
        count(env, r.ref.p, 'fetch_fail', client)
        // No `gate`: Bluesky has no private accounts and answers a missing one with an explicit
        // error, so every null here is "we could not read it", which is what the hedged default
        // card says. Inventing a gate would name a wall nobody measured.
        return render(
          {
            kind: 'failure', canonical: r.canonical, platform: r.ref.p,
            reason: 'could not fetch profile', subject: 'profile',
          },
          client, origin,
        )
      }
      const res = render({ kind: 'profile', profile }, client, origin)
      /**
       * CACHED, and for a SHORTER life than a post card. RESP_TTL is 900s, which is right for a
       * post: the thing it describes is finished and the only reason to re-render is our own code
       * changing. A profile's counts move continuously, so the same TTL would serve a number that
       * is fifteen minutes stale to every reader of a busy account. PROFILE_TTL is the compromise
       * — long enough that a link pasted into three channels costs one fetch, short enough that
       * "followers" means roughly now.
       */
      const toCache = new Response(res.clone().body, res)
      toCache.headers.set('cache-control', `max-age=${PROFILE_TTL}`)
      ctx.waitUntil(d.cache.put(pkey, toCache))
      count(env, r.ref.p, 'ok', client)
      return res
    }

    case 'redditshare': {
      /**
       * The Reddit app's /r/{sub}/s/{code} "copy link". Humans cost us nothing — the /s/ link
       * resolves in their own browser (302 to r.canonical). For a bot the {code} is an opaque share
       * token, so resolveRedditShare follows the 301 to the canonical /comments/{id} permalink and we
       * hand the resolved ref to the SAME post path a pasted permalink takes — one cache entry, one
       * render. A resolve miss (the redirect not served to our egress, or a non-Reddit Location) is
       * the generic "couldn't load" card, identical to a permalink whose post could not be fetched;
       * Reddit's /s/ is unambiguous, so there is never a chooser here. `withResolver`-style media
       * degradation is inherited for free by routing through getPost inside renderPostRoute.
       */
      if (!direct && client === 'human') return redirect(r.canonical)
      // The resolve runs OUTSIDE loadPost's try/catch (unlike the shortlink route), so a throwing
      // resolver is caught HERE — a blocked redirect must degrade to the generic card, never 500 a
      // public path. liveResolveRedditShare already guards its own fetch, so this is defence in depth.
      let resolved: { ref: Extract<PostRef, { p: 'rd' }>; canonical: string } | null = null
      try {
        resolved = await d.resolveRedditShare(r.canonical, env)
      } catch {
        resolved = null
      }
      if (!resolved) {
        count(env, 'rd', 'fetch_fail', client)
        return render(
          { kind: 'failure', canonical: r.canonical, platform: 'rd', reason: 'could not fetch post' },
          client, origin,
        )
      }
      return renderPostRoute(resolved.ref, resolved.canonical, d, env, ctx, client, origin)
    }

    case 'metashare': {
      /**
       * Meta's bare `/share/{code}`, minted identically by Threads and Facebook. The code names
       * neither a post nor a platform until a hop resolves it, so BOTH are asked and whichever 302s
       * owns it (see platforms/metashare/fetch.ts for the measurement).
       *
       * A HUMAN IS RESOLVED TOO, which is the one place this deliberately differs from redditshare
       * and shortlink. Both of those hand a human the share url on the argument that their browser
       * resolves it for free — true, but it also hands the DESTINATION the share token: Facebook's
       * own redirect target carries `share_url=<the entire share link>` plus `rdid`, and Threads'
       * carries `xmt`. A share code is minted per SHARING ACT, so forwarding it is forwarding a
       * handle on who shared. Resolving here and 302ing to the bare permalink strips all of it.
       * The cost is one upstream hop on a human click, and it is the reason this branch exists.
       */
      let loc: string | null = null
      try {
        loc = await d.resolveMetaShare(r.code)
      } catch {
        loc = null
      }
      // Re-route the resolved permalink through route(), so a share link takes the SAME path a
      // pasted permalink takes — one cache entry, one render, no separate gate vocabulary.
      const inner = loc ? route(new URL(loc)) : null
      if (!inner || inner.kind !== 'post') {
        // Unresolvable, or resolved to something we do not route (a text post, a profile). A human
        // still gets somewhere useful rather than a card they cannot act on.
        /**
         * A HUMAN IS SENT TO THE CLEANED PERMALINK, NEVER THE RAW Location.
         *
         * REPORTED 2026-07-31, by the person it names: following this share code lands on a page
         * headed "see what Alex Fixture shared", and the Location we forwarded carried
         * `share_url=<the share link>` plus `rdid`. Someone who swaps our host in is asking for the
         * link to be cleaned; handing the destination the share token — minted per sharing act, and
         * tied to the sharer's real profile — is the one thing here that must not happen.
         *
         * `r.canonical` is the fallback only when nothing resolved, and it is OUR url, not Meta's.
         */
        if (!direct && client === 'human') return redirect(loc ? stripMetaTracking(loc) : r.canonical)
        /**
         * NAME THE PLATFORM ONLY IF THE HOP TOLD US — this used to hardcode 'th'.
         *
         * REPORTED 2026-07-31: facebook.com/share/Fixture05X rendered "Couldn't load this Threads
         * post". The owner's question was the right one — the url is supposed to be resolved before
         * we say whose it is. It was; the resolution FAILED, and the failure branch then asserted
         * Threads anyway, turning "we could not find out" into a confident wrong answer about a
         * platform the sharer never mentioned.
         *
         * The root cause is measured in platforms/metashare/fetch.ts: Facebook withholds the 302
         * from Cloudflare's egress while Threads does not, so a Threads code always resolved and a
         * Facebook one never did — and every unresolved code was then blamed on Threads, which is
         * exactly backwards. Whatever the resolver could not determine, this must not invent.
         */
        /**
         * FROM THE RESOLVED HOST, not from route(). The first version of this asked route() for a
         * post ref and fell back to `null`, which renders the plain red "Not found" — and "Not found"
         * means "this is not a link we handle", which is false and worse than the bug it replaced.
         * That code resolves to a real Facebook post whose permalink shape we simply do not route.
         *
         * The HOST is what the hop actually established, so that is what gets named. Only a code that
         * resolved to nothing at all is genuinely unattributable.
         */
        const platform = loc ? metaPlatformOf(loc) : null
        count(env, platform ?? 'none', 'fetch_fail', client)
        return render(
          {
            kind: 'failure',
            canonical: loc ? stripMetaTracking(loc) : r.canonical,
            platform,
            reason: platform ? 'could not fetch post' : 'could not resolve this share link',
          },
          client, origin,
        )
      }
      // inner.canonical is rebuilt from ref fields by router.ts, so every share parameter the
      // redirect carried — share_url, rdid, xmt, slof — is already gone.
      if (!direct && client === 'human') return redirect(inner.canonical)
      return renderPostRoute(inner.ref, inner.canonical, d, env, ctx, client, origin)
    }

    case 'shortlink': {
      /**
       * A HUMAN IS RESOLVED, AND THE SHARE CODE IS NOT FORWARDED. Reversed 2026-07-30; the previous
       * reasoning is kept below because it was correct about cost and wrong about what it cost.
       *
       * IT SAID: "Humans cost us nothing — the short link resolves in their own browser exactly as it
       * does in ours", so redirecting to `/t/{code}` was free. True about our bandwidth. But the thing
       * being forwarded is a SHARE CODE, minted per sharing act, and following it lands on
       *
       *     /@kfc.laos/video/7658012561153035542?_r=1&_t=ZT-98PbBJ7V0JR
       *
       * so the code and its tracking parameters reach the destination on every click. A user who
       * deliberately swaps our host in reasonably expects the link to have been SANITISED; forwarding
       * the raw share url is the one thing here that does not.
       *
       * WHAT IS AND IS NOT LEAKED, measured rather than assumed, because the scary version is wrong.
       * `_t` is NOT a sharer fingerprint travelling in the link: resolved from this machine the same
       * code yields the SAME `_t` across repeats and across client shapes, while the reporter saw a
       * different value for that identical code — so `_t` is minted for whoever RESOLVES, not baked in
       * by whoever shared. The residual is the CODE itself, which TikTok can join to the share event
       * server-side. We cannot unmake that join; we can stop being the thing that carries it onward.
       *
       * THE COST IS ONE UPSTREAM HOP ON A HUMAN CLICK, and it is usually zero: the resolution is
       * already cached under shortPostCacheKey for the bot render that almost always precedes a human
       * click (Discord unfurls before anyone clicks). A miss falls back to the old behaviour rather
       * than failing — a human must always land somewhere.
       */
      if (!direct && client === 'human') {
        const cached = await d.cache.match(cacheUrl(shortRespCacheKey(r.p, r.code, 'other-bot', origin)))
        let clean: string | null = null
        if (cached) {
          // The bot render for this code is warm, so the canonical is already known and no upstream
          // hop is needed at all. Read it out of the rendered head rather than re-resolving.
          const html = await cached.clone().text().catch(() => '')
          const m = html.match(/<link rel="canonical" href="([^"]+)"/)
            || html.match(/property="og:url" content="([^"]+)"/)
          if (m) clean = m[1]
        }
        if (!clean) {
          try {
            const got = await d.resolveShortlink(r.p, r.code, env, client)
            if (got?.kind === 'post' && got.post?.canonical) clean = got.post.canonical
          } catch {
            clean = null
          }
        }
        // Fall back to the share url only when we genuinely could not resolve: a human must land
        // somewhere, and the old behaviour is a worse privacy answer but not a broken one.
        return redirect(clean || r.canonical)
      }

      // LOOKUP keys in their own namespace, never a post's. A short code and a post id must not
      // be able to name the same entry in either direction — see shortPostCacheKey. loadPost
      // writes the resolved post under the CANONICAL key too, so the short link, the long-form
      // permalink and every /_media/ hit still share one entry.
      const rkey = cacheUrl(shortRespCacheKey(r.p, r.code, client, origin))
      // NOT ON A d. HOST. These entries hold the HTML card this arm answers with, and the d. host
      // promises bytes — a card cached under the direct origin would keep being served for the whole
      // RESP_TTL. The direct answer is returned below, once the code has resolved to a ref.
      const hit = direct ? null : await d.cache.match(rkey)
      if (hit) return hit

      /**
       * Captured out of the loader because loadPost's contract is `Post | null` — the cache layer
       * has no business knowing what a short code is. On a cache HIT the loader never runs and
       * `seen` stays unread, because a hit means there IS a post. On a resolver that THROWS,
       * loadPost swallows it and `seen` keeps its initial value, so a transport failure degrades
       * to the chooser rather than a 500.
       *
       * A one-field object rather than a bare `let`, because TypeScript's control-flow analysis
       * does not model assignments made inside a callback: a `let` initialised to
       * {kind:'unresolved'} narrows to that literal type and the 'gone' comparison below becomes
       * a compile error about types that "have no overlap" — while the value at runtime is
       * whatever the resolver returned. The indirection is what keeps the declared type honest.
       */
      const seen: { at: ShortlinkResolution } = { at: { kind: 'unresolved' } }
      const { post } = await loadPost(shortPostCacheKey(r.p, r.code), async () => {
        const got = await d.resolveShortlink(r.p, r.code, env, client)
        seen.at = got
        // `got?.kind` rather than `got.kind`, and the ?. is not decoration: the TYPE says this is
        // always a ShortlinkResolution, but a Deps is injected and .mjs tests are never checked
        // against that type — a caller still returning the older `Post | null` hands us a null
        // here, and reading .kind off it is an uncaught TypeError, i.e. HTTP 500 on a public path.
        // The sibling case (a resolver that THROWS) has degraded to the chooser since this route
        // was written; returning the wrong shape is the same class of failure and gets the same
        // answer instead of a crash.
        return got?.kind === 'post' ? got.post : null
      }, d)

      if (!post) {
        if (seen.at?.kind === 'gated') {
          /**
           * IT IS TIKTOK'S, AND IT IS WALLED — private or age-restricted. The SAME answer the
           * permalink post route gives on the same condition: the calm 🔞/🔒 embed, NOT the generic
           * red failure, so one post does not render two different cards depending on which url shape
           * was pasted (confirmed live 2026-07-21). The gate point was counted inside the resolver;
           * fetch_fail STACKS here, exactly as the post route does on a recognized wall (no
           * double-count). renderGate is the SAME shared map the post route calls on its failReason,
           * which is what makes the two url shapes render byte-identical. Not cached, like the 'gone'
           * branch: a failure is never cached.
           */
          count(env, r.p, 'fetch_fail', client)
          return render(
            {
              kind: 'failure', canonical: r.canonical, platform: r.p, reason: 'could not fetch post',
              gate: renderGate(seen.at.reason),
            },
            client, origin,
          )
        }

        if (seen.at?.kind === 'gone') {
          /**
           * IT IS TIKTOK'S, AND THE POST IS NOT THERE. The page carried a webapp.video-detail
           * scope, which is positive proof about the platform, so this must NOT degrade to the
           * chooser: offering threads.com here sends the click to a dead end, and filing it as
           * ('none','ambiguous') made every deleted, private or region-blocked TikTok short link
           * byte-identical in analytics to a genuine Threads link.
           *
           * Identical answer and identical counter to the post route on the same condition, which
           * is the point — the same post must not get two different answers depending on which URL
           * shape was pasted. The canonical is the short URL itself: a deleted post has no
           * itemStruct, so there is no id to build a permalink out of, and /t/{code} is a real
           * link that lands on TikTok's own "video currently unavailable" page.
           */
          count(env, r.p, 'fetch_fail', client)
          return render(
            { kind: 'failure', canonical: r.canonical, platform: r.p, reason: 'could not fetch post' },
            client, origin,
          )
        }

        /**
         * NOT TikTok's, or the page never arrived. Nothing is guessed: this is the chooser the
         * path would have served with no resolver at all, so the no-case is unchanged by having
         * built the yes-case.
         *
         * ATTRIBUTED TO tt, NOT 'none', BECAUSE THIS CHOOSER COST AN UPSTREAM FETCH. The
         * router-level ambiguous at the top of this switch is free; this one is not, and while
         * they shared ('none','ambiguous') the spec's fetch-amplification alert could not see
         * this path at all — nor could anyone tell a wave of Threads links from TikTok blocking
         * us, since 'none' also carries every /mrbeast in the world.
         */
        count(env, r.p, 'ambiguous', client)
        const amb = render({ kind: 'ambiguous', path: url.pathname, candidates: SHORTLINK_CANDIDATES }, client, origin)
        /**
         * CACHED, unlike the router-level chooser, for the reason it is counted differently: it
         * cost a fetch. Uncached, every re-unfurl of one pasted Threads link was another request
         * to tiktok.com from our egress — measured at three fetches for three identical requests.
         * Bounded by RESP_TTL like every other cached response, so a code TikTok mints later is
         * picked up within 15 minutes.
         */
        const toCacheAmb = new Response(amb.clone().body, amb)
        toCacheAmb.headers.set('cache-control', `max-age=${RESP_TTL}`)
        ctx.waitUntil(d.cache.put(rkey, toCacheAmb))
        return amb
      }

      /**
       * THE d. HOST, REPEATED HERE BECAUSE THIS ARM NEVER REACHES renderPostRoute.
       *
       * That function short-circuits a direct-media origin for "every route rather than the one it was
       * first wired into", and its comment says the convergence is what makes remembering unnecessary.
       * A shortlink does not converge on it: a short code caches in its OWN namespace, so this arm
       * renders the post itself and the short-circuit never runs.
       *
       * MEASURED 2026-08-08, which is how the gap was found rather than reasoned about:
       *
       *   d.<host>/@user/video/{id}   302 -> /_media/tt:{id}/0     the file, via renderPostRoute
       *   d.<host>/t/{code}           302 -> tiktok.com/@user/...  the POST, bouncing a human away
       *
       * Same post, same host, two answers, decided only by which url shape was pasted — which is the
       * defect this file argues against everywhere else. The ref is not known until the code resolves,
       * so this cannot be hoisted above the resolution the way renderPostRoute's copy is.
       */
      if (direct) return serveDirectMedia(post.ref, d, env, ctx, client, origin)

      const res = render({ kind: 'post', post }, client, origin)
      const toCache = new Response(res.clone().body, res)
      toCache.headers.set('cache-control', `max-age=${RESP_TTL}`)
      ctx.waitUntil(d.cache.put(rkey, toCache))
      count(env, r.p, 'ok', client)
      return res
    }
  }
}

const liveDeps = (): Deps => ({
  cache: caches.default as unknown as CacheLike,
  fetchPost: liveFetchPost,
  fetchProfile: liveFetchProfile,
  resolveShortlink: liveResolveShortlink,
  resolveRedditShare: liveResolveRedditShare,
  resolveMetaShare,
})

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, ctx, liveDeps())
  },

  /**
   * THE CRON, which exists because this service had no opinion about its own health. Facebook was
   * broken for up to a week and the detector was the owner pasting a link. See src/smoke.ts.
   *
   * IT CHECKS ITSELF THROUGH ITS OWN FRONT DOOR — the same `handle()` a crawler reaches — so it sees
   * what a reader sees, including the render, the caches and the deadlines. What that CANNOT catch is
   * anything outside the worker: DNS, the route binding, a Cloudflare incident, or the deploy having
   * failed entirely. A check that runs inside the thing it is checking cannot report that the thing
   * is unreachable, and no amount of care here changes that. It is a platform-breakage detector, not
   * an uptime monitor.
   *
   * THE ORIGIN IS A CONSTANT because a scheduled invocation has no request to take one from. It is
   * the apex, which is the host readers actually paste.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const d = liveDeps()
    const results = await runSmoke('https://mbedfx.app', u => handle(new Request(u, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
    }), env, ctx, d))
    for (const r of results) count(env, r.platform, smokeOutcome(r.verdict), SMOKE_CLIENT)
    // One console line per FAILING check and nothing else. It carries the check's name and a
    // verdict — no url, no reader, nothing that identifies anybody — so it stays inside the boundary
    // wrangler.jsonc draws, and it is visible to `wrangler tail` when somebody is watching. The NAME
    // rather than the platform, because bs has two rows and the counter cannot tell them apart; this
    // line is the only place a reader learns which of the two went.
    for (const r of results) {
      if (r.verdict !== 'ok') console.error(`smoke ${r.name} ${r.verdict}`)
    }
    if (results.length !== SMOKE_CHECKS.length) console.error('smoke incomplete')
  },
}
