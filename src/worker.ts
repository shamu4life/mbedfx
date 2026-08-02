import type { ClientClass, Media, Post, PostRef, Route } from './types.ts'
import { classify } from './classify.ts'
import { route } from './router.ts'
import { render } from './render/index.ts'
import { redirect } from './render/fail.ts'
import { toMastodonStatus, toOEmbed } from './render/mastodon.ts'
import { pickMedia, pickMediaEntry } from './media.ts'
import { bytesIndex, byline, mediaOf, mediaUrl, str, themeColor, usable } from './render/embed.ts'
import { statParts } from './render/text.ts'
import { proxyableVideoUrl, serveDirectVideo } from './mediaproxy.ts'
import { refKey } from './refkey.ts'
import { count, type Env, type GateReason } from './analytics.ts'
import {
  cacheUrl, deserializePost, postCacheKey, respCacheKey, shortPostCacheKey, shortRespCacheKey,
  serializePost, POST_TTL, RESP_TTL, MEDIA_MAX_AGE,
} from './cache.ts'
import { fetchBluesky } from './platforms/bluesky/fetch.ts'
import { normalizeBluesky } from './platforms/bluesky/normalize.ts'
import { fetchTikTok, resolveTikTokShortlink, withResolvedVideo } from './platforms/tiktok/fetch.ts'
import { normalizeTikTok, tiktokGate, tiktokRefFrom, videoDetailScope } from './platforms/tiktok/normalize.ts'
import { fetchInstagram, fetchInstagramFullPage, fetchInstagramUserFeed } from './platforms/instagram/fetch.ts'
import {
  instagramAgeGate, instagramCopyrightBlocked, instagramFullPageCard, instagramPrivateGate,
  normalizeInstagram,
  recoveredMediaFrom, withRecoveredVideo,
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
import {
  normalizeYouTube, uploadDateFrom, withAgeNote, withCounts, withDescription, withUploadDate,
  youtubeVouched,
} from './platforms/youtube/normalize.ts'
import {
  facebookAgeGate, facebookPostCard, fbPageUrl, normalizeFacebook, type FacebookMeta,
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
import { type YtdlpMeta } from './platforms/ytdlp/normalize.ts'
import { dmPageUrl } from './platforms/dailymotion/fetch.ts'
import { normalizeDailymotion } from './platforms/dailymotion/normalize.ts'
import { stPageUrl } from './platforms/streamable/fetch.ts'
import { normalizeStreamable } from './platforms/streamable/normalize.ts'
import { fetchImgur, imPageUrl } from './platforms/imgur/fetch.ts'
import { normalizeImgur, normalizeImgurApi } from './platforms/imgur/normalize.ts'

/** Minimal shape of the Cache API we use, so tests can inject an in-memory stand-in. */
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
   */
  fetchPost(
    ref: PostRef, env: Env, client: ClientClass, report?: FetchReport, ctx?: ExecutionContext,
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
export async function liveFetchPost(
  ref: PostRef, env: Env, client: ClientClass, report?: FetchReport, ctx?: ExecutionContext,
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
      if (post) return await withResolvedVideo(post)
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
          const rec = recoveredMediaFrom(await fetchInstagramUserFeed(card.author.handle), code)
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
        const feed = await fetchInstagramUserFeed(post.author?.name)
        const recovered = recoveredMediaFrom(feed, ref.kind === 'p' ? ref.code : '')
        if (recovered) count(env, 'ig', 'copyright_recovered', client)
        return withRecoveredVideo(post, recovered)
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
        if ((got.reason === 'age_restricted' || got.reason === 'private') && report) report.reason = got.reason
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
        readCachedMeta<YouTubeMeta>(ref, env, YT_META_TTL_MS, ytMetaValid),
      ])
      if (!got.ok) count(env, 'yt', 'assert_fail', client)
      // THE WARM DATE IS OVERLAID WHETHER OR NOT OEMBED ANSWERED. `got.ok && warm` was the first
      // spelling and it threw away a date this worker was already holding: an oembed miss makes the
      // post UNVOUCHED, youtubeMeta then declines to fill the date on the activity route (the vouch is
      // link 5 of its gate chain), and the card renders 1 January 1970 for the whole POST_TTL — with a
      // correct timestamp sitting in R2 the entire time. Title and date come from two independent
      // sources; one missing must not suppress the other.
      return normalizeYouTube(
        warm
          ? {
            ...got,
            uploadedAt: warm.timestamp,
            ageLimit: warm.ageLimit,
            description: warm.description,
            counts: { views: warm.views, likes: warm.likes, replies: warm.replies },
          }
          : got,
        ref)
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
      // No `origin` is threaded in: fetchableInstance's own-zone refusal reads a module-level list of
      // the hosts this Worker is served from, so the guard does not depend on a request field that
      // every .mjs test stub would then have to supply.
      const got = await fetchLemmy(ref)
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
       * fetchMasto re-guards the host at the boundary via the shared fedihost.ts contract, and no
       * `origin` is threaded in for the same reason given above.
       *
       * A 404/410 IS COUNTED AS 'notfound' RATHER THAN AS A FETCH FAILURE. Mastodon answers
       * `Record not found` for a deleted status and for one that never existed alike, so they cannot
       * be told apart — 'notfound' is the honest name for both, and keeps a deleted post from
       * inflating the assert_fail counter that exists to catch upstreams changing shape.
       */
      const got = await fetchMasto(ref)
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
      const got = await fetchMisskey(ref)
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
      const got = await fetchPeerTube(ref)
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
      const meta = await cachedYtdlpMeta(ref, env, ctx)
      if (!meta) {
        count(env, ref.p, 'assert_fail', client)
        return null
      }
      return ref.p === 'dm' ? normalizeDailymotion(meta, ref) : normalizeStreamable(meta, ref)
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
      const meta = await cachedYtdlpMeta(ref, env, ctx)
      if (!meta) {
        count(env, 'im', 'assert_fail', client)
        return null
      }
      return normalizeImgur(meta, ref)
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
 */
function getPost(
  ref: PostRef, d: Deps, env: Env, client: ClientClass, ctx: ExecutionContext,
): Promise<{ post: Post | null; cached: boolean; failReason?: GateReason }> {
  const report: FetchReport = {}
  // `ctx` rides through to the fetchers whose upstream is the container (fb, dm/st/im), which need it
  // to keep a slow extract alive past the response — see cachedMeta. REQUIRED here, not optional: all
  // three call sites are in this file and every one of them has a ctx, so there is no reason to let a
  // future fourth one silently drop it. It stays optional at the Deps/liveFetchPost boundary, which is
  // the injected, .mjs-stubbed one.
  return loadPost(postCacheKey(ref), () => d.fetchPost(ref, env, client, report, ctx), d)
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
  req: Request, env: Env, ref: PostRef, index: number, source: Media['remux'],
): Promise<Response> {
  const { MEDIA_RESOLVER: resolver, MEDIA_CACHE: cache } = env
  if (!resolver || !cache || !source) return notReady()

  const key = `mux/${refKey(ref)}/${index}`
  // EVERYTHING here degrades, never 500s: this route has the same total-failure contract as pickMedia,
  // but its work (an R2 read, a container call, an R2 write) can throw for reasons a corrupt-cache guard
  // cannot — R2 unavailable, the container down, a stream with no known length.
  try {
    // muxOnce, not ensureMuxed: a cold video is asked for by the prewarm and both settleMux calls
    // within ~2s of one paste, and three concurrent downloads of one video is the bandwidth that
    // decides whether the card gets a player. The slot key is the POST, so this call and the meta
    // call for the same ref land on one already-booted instance.
    const head = await muxOnce(env, key, source, refKey(ref))
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
 * instance. wrangler caps that (`max_instances`) and an instance lingers ~10min (`sleepAfter`), so after a
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
 * BUMP THIS WHENEVER container/ CHANGES BEHAVIOUR. Pooling gave instances STABLE names, and a container
 * instance keeps running the image it started with until it idles out (`sleepAfter`) — so with steady
 * traffic a redeploy never takes effect: the 20-min duration cap shipped and every mux kept enforcing the
 * old 10-min one, because the four pooled instances were still the previous build. (The per-key naming
 * this replaced hid the problem — a new video meant a new name meant a new instance on the new image.)
 * Changing this string changes the instance names, which forces the new image in immediately.
 *
 * IT IS ALSO THE META CACHE'S GENERATION — see metaCacheKey. Any container answer we PERSIST has to be
 * invalidated by the same switch that retires the instance that produced it, or the bump only half-works.
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
const RESOLVER_GENERATION = 'g8'
/** `slotKey` is the POST (refKey), never the operation — see RESOLVER_SLOTS for the 74% measurement. */
function resolverStub(resolver: NonNullable<Env['MEDIA_RESOLVER']>, slotKey: string) {
  let h = 2166136261
  for (let i = 0; i < slotKey.length; i++) {
    h ^= slotKey.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return resolver.getByName(`resolver-${RESOLVER_GENERATION}-${Math.abs(h) % RESOLVER_SLOTS}`)
}

/**
 * Get a muxed MP4 into R2 and return its head — the shared half of serveMuxed and prewarmMux. Returns the
 * existing object when it is already there (so a mux happens at most once), else calls the container and
 * stores the result. Null on any no (no bindings, no source, a container error, an empty body).
 */
async function ensureMuxed(
  env: Env, key: string, source: Media['remux'], slotKey: string,
): Promise<{ size: number } | null> {
  const { MEDIA_RESOLVER: resolver, MEDIA_CACHE: cache } = env
  if (!resolver || !cache || !source) return null
  const existing = await cache.head(key)
  if (existing) return existing
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
  const muxed = await resolverStub(resolver, slotKey).fetch('http://media-resolver/resolve', {
    method: 'POST', body: JSON.stringify(source), headers,
  })
  if (!muxed.ok || !muxed.body) {
    // SERVER-SIDE ONLY (wrangler tail), never the client: a non-200 here is invisible otherwise — the
    // route degrades to the poster still, so a failed mux and an exhausted container instance look
    // identical from outside (both a 302), which is exactly the ambiguity that made "it shows a frame and
    // never plays" hard to diagnose. `key` is the ref, and the body carries no url — safe to log.
    console.error('mux failed', key, muxed.status, (await muxed.text().catch(() => '')).slice(0, 200))
    return null
  }
  await putMuxed(cache, key, muxed)
  return await cache.head(key)
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
 * ~10min, and "Maximum number of running container instances exceeded" degrades every legitimate post
 * on the pool to a video-less card. A skipped prewarm costs latency on one card; an exhausted pool
 * costs every card.
 *
 * NOT A LOCK, for the same reason muxInflight is not one: isolate-local, and two isolates can exceed
 * it together. It bounds the amplification, it does not serialize the work.
 */
const SPECULATIVE_MUX_CAP = 2
function muxOnce(env: Env, key: string, source: Media['remux'], slotKey: string): Promise<{ size: number } | null> {
  const running = muxInflight.get(key)
  if (running) return running
  const p = ensureMuxed(env, key, source, slotKey).finally(() => muxInflight.delete(key))
  muxInflight.set(key, p)
  return p
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
  post: Post, env: Env, ctx: ExecutionContext, budgetMs: number,
): Promise<{ post: Post; degraded: boolean }> {
  if (!env.MEDIA_RESOLVER || !env.MEDIA_CACHE) return { post, degraded: false }
  const own = Array.isArray(post.media) ? post.media : []
  if (!own.some(m => m?.remux?.page)) return { post, degraded: false }

  let degraded = false
  const media = await Promise.all(own.map(async (m, i) => {
    if (!m?.remux?.page) return m
    const key = `mux/${refKey(post.ref)}/${i}`
    // The mux runs to completion regardless of who wins this race — waitUntil keeps it alive past the
    // response, so a slow video is ready for the next render rather than being restarted from scratch.
    const work = muxOnce(env, key, m.remux, refKey(post.ref)).catch(() => null)
    ctx.waitUntil(work)
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), budgetMs))
    const head = await Promise.race([work, timeout])
    if (head) return m
    degraded = true
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
    return m.poster
      ? {
        kind: 'image' as const,
        url: m.poster,
        poster: m.poster,
        w: m.posterW ?? m.w,
        h: m.posterH ?? m.h,
        posterOnly: true as const,
      }
      : null
  }))

  if (!degraded) return { post, degraded: false }
  return { post: { ...post, media: media.filter((m): m is Media => m != null) }, degraded: true }
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
 * (RESOLVER_SLOTS 4, sleepAfter ~10min, PROC_TIMEOUT 120s, MAX_BYTES 300MB), which is exactly the
 * documented "Maximum number of running container instances exceeded" failure that degrades EVERY
 * legitimate post to a video-less card. So the call site prewarms only for a ref the POST CACHE already
 * holds — i.e. one a real fetch+normalize has already vouched for, restoring the pre-prewarm
 * reachability rule — and additionally only while this isolate has fewer than SPECULATIVE_MUX_CAP muxes
 * outstanding.
 *
 * THE COST, STATED PLAINLY: the very first paste of a video no longer overlaps its mux with its fetch,
 * so that first HTML render is likelier to degrade to the still. It is NOT the whole measurement
 * refunded — by the time Discord's activity callback arrives ~1s later the post IS cached, that
 * document is where `media_attachments[].type` is decided, and it waits MUX_WAIT_API_MS — and every
 * re-paste takes the warm path this gate is scoped to. Speculative work for a ref nobody has
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
 */
const META_TIMEOUT_MS = HTML_DEADLINE_MS - MUX_WAIT_FLOOR_MS

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
 * timestamp, on every colo, not fixable by re-pasting, and RESOLVER_GENERATION alone would not clear it.
 *
 * With the generation in the key, bumping it is the SINGLE invalidation switch for both halves of the
 * container's output: the instances that produce an answer, and the answers we kept. Old objects are
 * simply never read again; R2 has no cost pressure to delete them urgently and a lifecycle rule is the
 * right eventual broom, not a delete on the request path.
 *
 * Exported for the test that pins the miss — a key built by hand there would pass while this drifted.
 *
 * WIDENED to PostRef 2026-07-26 (it was fb-only) because YouTube now persists a container answer of
 * its own. refKey namespaces the platform (`yt:` vs `fb:watch:`), so no two platforms can collide
 * here, and a mux key (`mux/{refKey}/{i}`, no '.json', an index segment) cannot either.
 */
export const metaCacheKey = (ref: PostRef) => `meta/${RESOLVER_GENERATION}/${refKey(ref)}.json`

/**
 * ONE IMPLEMENTATION of "generation-scoped R2 meta with a TTL, a deadline, and never-cache-a-failure",
 * split in two so a caller can put a GATE between the read and the container call. Two copies of this
 * would be two places for one of them to drift, and the drift would be a persisted wrong answer.
 *
 * THE READ IS try/catch, NOT `.catch()`, and that is not defensiveness: the injected MEDIA_CACHE
 * stand-in in test/pipeline.test.mjs provides only `head` and `put`, so `cache.get` is UNDEFINED and
 * calling it throws SYNCHRONOUSLY — a rejected-promise guard never sees it, and the route 500s.
 */
async function readCachedMeta<T>(
  ref: PostRef, env: Env, ttlMs: number, valid: (j: unknown) => boolean,
): Promise<T | null> {
  const cache = env.MEDIA_CACHE
  if (!cache) return null
  try {
    const obj = await cache.get(metaCacheKey(ref))
    // R2 stamps `uploaded`, so no expiry field has to be stored or trusted.
    if (!obj || Date.now() - obj.uploaded.getTime() >= ttlMs) return null
    const j = await obj.json<T>().catch(() => null)
    return j && valid(j) ? j : null
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
 * before it starts another — RESOLVER_SLOTS is 4, instances linger ~10min, and an exhausted pool
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
  return await deadline(attempt, budgetMs)
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

function cachedFacebookMeta(
  ref: Extract<PostRef, { p: 'fb' }>, env: Env, ctx?: ExecutionContext,
): Promise<FacebookMeta | null> {
  return cachedMeta<FacebookMeta>(
    // FB_FAIL_TTL_MS is 0 — Facebook does NOT negative-cache, deliberately; see the constant.
    ref, env, ctx, FB_META_TTL_MS, META_TIMEOUT_MS, FB_FAIL_TTL_MS, metaHasTitle,
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
async function resolveYtdlpMeta(page: string, slot: string, env: Env): Promise<YtdlpMeta | null> {
  const resolver = env.MEDIA_RESOLVER
  if (!resolver) return null
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
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
 * the gate, a loop over distinct ids saturates a 4-slot pool whose instances linger ~10 minutes and
 * degrades EVERY platform's card to a video-less still.
 */
function cachedYtdlpMeta(
  ref: Extract<PostRef, { p: 'dm' | 'st' | 'im' }>, env: Env, ctx?: ExecutionContext,
): Promise<YtdlpMeta | null> {
  // The slot is the POST (refKey), never the operation, so this call and the video mux for one ref
  // land on ONE container instance — see RESOLVER_SLOTS for the 74% measurement.
  const page = ytdlpPageUrl(ref)
  return cachedMeta<YtdlpMeta>(
    ref, env, ctx, YTDLP_TTL[ref.p], META_TIMEOUT_MS, META_FAIL_TTL_MS, metaHasTitle,
    () => resolveYtdlpMeta(page, refKey(ref), env),
  )
}

/**
 * YOUTUBE'S UPLOAD DATE — the fix for the "every YouTube card says 1 January 1970" report, measured
 * live 2026-07-26 on the field that actually renders (created_at on the activity callback: 2 of 3
 * probed videos were the epoch).
 *
 * ONLY THE TIMESTAMP IS STORED. oembed already supplies title/author/thumbnail and the mux supplies
 * the video; the upload instant of a published video id is the one field here that is genuinely
 * immutable, which is what a 30-day TTL is buying.
 *
 * 30 DAYS, versus Facebook's 24h, on purpose: the value cannot change, and the TTL is exactly what
 * decides how often the one real latency trade below (a warm mux with a cold meta) can recur.
 */
const YT_META_TTL_MS = 30 * 86_400_000
/**
 * `ageLimit` is OPTIONAL AND NOT PART OF THE VALIDITY TEST, deliberately. Records written before
 * g6 carry no such field and are still perfectly good dates; requiring it would throw away a
 * 30-day cache for a cosmetic marker. Absent simply means "not known to be gated".
 */
type YouTubeMeta = {
  timestamp: number
  ageLimit?: number
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
const YT_DESC_MAX = 300
function ytDescription(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  // The first blank line ends the caption-ish part. \r\n handled because yt-dlp passes through
  // whatever the uploader typed.
  const first = v.replace(/\r\n/g, '\n').split(/\n\s*\n/)[0].trim()
  if (!first) return undefined
  return first.length > YT_DESC_MAX ? `${first.slice(0, YT_DESC_MAX - 1).trimEnd()}…` : first
}
/**
 * The content assertion for a stored/returned yt meta record. It is the SAME validator the value is
 * parsed with, so a record that would not render can never be written or read back — which matters
 * more here than anywhere else in this file, because a wrong value would be kept for 30 days.
 */
const ytMetaValid = (j: unknown): boolean =>
  typeof (j as YouTubeMeta | null)?.timestamp === 'number' &&
  uploadDateFrom((j as YouTubeMeta).timestamp) !== null

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
const META_WAIT_API_MS = 8000

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
  const resolver = env.MEDIA_RESOLVER
  if (!resolver) return null
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.RESOLVER_SECRET) headers['x-resolver-secret'] = env.RESOLVER_SECRET
    const r = await resolverStub(resolver, refKey(ref)).fetch('http://media-resolver/resolve', {
      method: 'POST', body: JSON.stringify({ page: ytPageUrl(ref), meta: true }), headers,
    })
    if (!r.ok) {
      // SERVER-SIDE ONLY (wrangler tail), ref-only like ensureMuxed — and NO analytics counter: yt's
      // assert_fail already means "oembed missed", and mediaproxy.ts's precedent is explicit that
      // folding an unrelated event into an existing counter blunts the alert that matters.
      console.error('yt meta failed', refKey(ref), r.status)
      return null
    }
    const j = await r.json() as Record<string, unknown>
    if (!ytMetaValid(j)) return null
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
    return {
      timestamp: j.timestamp as number,
      ...(ageLimit === undefined ? {} : { ageLimit }),
      ...(description === undefined ? {} : { description }),
      ...(views === undefined ? {} : { views }),
      ...(likes === undefined ? {} : { likes }),
      ...(replies === undefined ? {} : { replies }),
    }
  } catch {
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
  const warm = await readCachedMeta<YouTubeMeta>(ref, env, YT_META_TTL_MS, ytMetaValid)
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
 * Stream a muxed MP4 response into R2. R2's `put` needs a KNOWN LENGTH for a streamed body; a
 * subrequest response body is not always a fixed-length stream even when the origin sent
 * content-length, and `put(key, body)` then throws synchronously. So drive the length explicitly: a
 * FixedLengthStream when the container gave us content-length (the streaming path, no buffering), else
 * buffer to an ArrayBuffer (bounded by the container's own MAX_BYTES output cap).
 */
async function putMuxed(cache: R2Bucket, key: string, muxed: Response): Promise<void> {
  const len = Number(muxed.headers.get('content-length'))
  // FixedLengthStream is a Workers-runtime global; under `node --test` it is absent, so the buffer
  // path below serves the unit tests while the streaming path serves production.
  if (typeof FixedLengthStream !== 'undefined' && Number.isInteger(len) && len > 0) {
    const fixed = new FixedLengthStream(len)
    const pumped = muxed.body!.pipeTo(fixed.writable)
    await cache.put(key, fixed.readable)
    await pumped
  } else {
    await cache.put(key, await muxed.arrayBuffer())
  }
}

/** Serve an R2 object as video/mp4, honouring a single `bytes=` range so players can seek. */
async function r2Range(cache: R2Bucket, key: string, size: number, range: string | null): Promise<Response> {
  const base: Record<string, string> = {
    'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': `public, max-age=${MEDIA_MAX_AGE}`,
  }
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (m) {
    const start = m[1] ? Number(m[1]) : 0
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
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
  if (raced === TIMED_OUT) return { post, pending: true, source }
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

async function renderPostRoute(
  ref: PostRef, canonical: string, d: Deps, env: Env, ctx: ExecutionContext, client: ClientClass, origin: string,
): Promise<Response> {
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
    ctx.waitUntil(muxOnce(env, `mux/${refKey(ref)}/${pre.index}`, pre.source, refKey(ref)).catch(() => null))
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
  const settled = await settleMux(post, env, ctx, Math.max(MUX_WAIT_FLOOR_MS, HTML_DEADLINE_MS - (Date.now() - started)))
  // What is LEFT after the mux, not a fresh budget — the translation is the least important thing on
  // this card and must never be the reason Discord gives up on it. A lost race still lands in R2 for
  // the next reader; see withTranslated.
  // CAPPED as well as floored — see XLATE_MAX_WAIT_MS. What is left of the deadline is an upper bound
  // on the whole response, not an allowance the least important element gets to spend in full.
  const xlate = await withTranslated(
    settled.post, env, ctx,
    Math.max(XLATE_WAIT_FLOOR_MS, Math.min(XLATE_MAX_WAIT_MS, HTML_DEADLINE_MS - (Date.now() - started))),
  )
  const res = render({ kind: 'post', post: xlate.post }, client, origin)
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

export async function handle(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response> {
  const url = new URL(req.url)

  // Always the request's own origin — never a constant. A hardcoded prod origin
  // would make staging embeds point Discord's media proxy at the live prod worker.
  const origin = url.origin
  const client = classify(req.headers.get('user-agent'))
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
        return serveMuxed(req, env, r.ref, r.index as number, entry.remux)
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
       * YouTube's date here. This route already waits up to MUX_WAIT_API_MS for every yt post, so a
       * cold-mux callback pays ZERO extra wall clock for a correct timestamp, and the route's ceiling
       * is unchanged. Scoped to 'activity' because that is the only document with a date field:
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
      const [settledApi, meta, xlate] = await Promise.all([
        settleMux(post, env, ctx, MUX_WAIT_API_MS),
        r.kind === 'activity' ? youtubeMeta(r.ref, post, env, ctx) : null,
        r.kind === 'activity' ? translationFor(post, env, ctx, MUX_WAIT_API_MS) : null,
      ])
      return Response.json(
        r.kind === 'activity'
          // ALL THREE overlays, from the one record. Each arrives after the Post was built, and
          // applying only some of them leaves the card silent about the rest on every first paste.
          // Translation is applied LAST so the marker trails the body the age note may have extended.
          // FOUR overlays now, from the one record. withDescription runs BEFORE withAgeNote so the
          // note keeps the top of the body on an age-gated video, and before withTranslation so a
          // foreign-language description is what gets translated.
          ? toMastodonStatus(
            withTranslation(
              withAgeNote(
                withCounts(
                  withDescription(withUploadDate(settledApi.post, meta?.timestamp), meta?.description),
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
      // A share code names no post until a hop resolves it, so the page gets the REAL permalink
      // rather than the opaque token it pasted — the "unfurl to the full thing" half of the ask.
      if (inner.kind === 'metashare') {
        let loc: string | null = null
        try {
          loc = await d.resolveMetaShare(inner.code)
        } catch {
          loc = null
        }
        const resolved = loc ? route(new URL(stripMetaTracking(loc))) : null
        inner = resolved && resolved.kind === 'post' ? resolved : inner
      }
      /**
       * A SHORT LINK IS RESOLVED TOO, not just a Meta share code.
       *
       * REPORTED 2026-08-01: tiktok.com/t/ZTAxTF9aD showed "unresolved" on the fixer page while the
       * SAME link rendered a correct card in Discord. Both halves are true, and that is the bug — the
       * page refused to preview a link that works perfectly when pasted, which is worse than a broken
       * link because it talks the reader out of a good one.
       *
       * The cause is that this arm learned to unfurl 'metashare' and never learned 'shortlink', so a
       * /t/{code} fell through to {ok:false, reason:'shortlink'}. The post route has resolved these
       * since it shipped; only the two endpoints the PAGE talks to were left out.
       *
       * The resolution is the cached one the bot render already paid for whenever the card has been
       * drawn — d.resolveShortlink is the same door, so a warm code costs no upstream hop.
       */
      if (inner.kind === 'shortlink') {
        let got: Awaited<ReturnType<Deps['resolveShortlink']>> | null = null
        try {
          got = await d.resolveShortlink(inner.p, inner.code, env, client)
        } catch {
          got = null
        }
        const canon = got?.kind === 'post' ? got.post?.canonical : null
        let resolved: Route | null = null
        if (canon) {
          try {
            resolved = route(new URL(canon))
          } catch {
            resolved = null
          }
        }
        // A miss leaves `inner` alone, so the answer degrades to exactly what it was before.
        if (resolved && resolved.kind === 'post') inner = resolved
      }
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
      return Response.json({
        ok: true,
        url: `${origin}${new URL(shown).pathname}${new URL(shown).search}`,
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
       */
      const started = Date.now()
      let inner: Route
      try {
        inner = route(new URL(r.target, origin))
      } catch {
        return Response.json({ ok: false, reason: 'unparseable' }, { status: 400 })
      }
      // A share code names no post until a hop resolves it — the same unfurl /_prep does, so the
      // preview follows the link the page is actually about to hand somebody.
      if (inner.kind === 'metashare') {
        let loc: string | null = null
        try {
          loc = await d.resolveMetaShare(inner.code)
        } catch {
          loc = null
        }
        const resolved = loc ? route(new URL(stripMetaTracking(loc))) : null
        inner = resolved && resolved.kind === 'post' ? resolved : inner
      }
      /**
       * A SHORT LINK IS RESOLVED TOO, not just a Meta share code.
       *
       * REPORTED 2026-08-01: tiktok.com/t/ZTAxTF9aD showed "unresolved" on the fixer page while the
       * SAME link rendered a correct card in Discord. Both halves are true, and that is the bug — the
       * page refused to preview a link that works perfectly when pasted, which is worse than a broken
       * link because it talks the reader out of a good one.
       *
       * The cause is that this arm learned to unfurl 'metashare' and never learned 'shortlink', so a
       * /t/{code} fell through to {ok:false, reason:'shortlink'}. The post route has resolved these
       * since it shipped; only the two endpoints the PAGE talks to were left out.
       *
       * The resolution is the cached one the bot render already paid for whenever the card has been
       * drawn — d.resolveShortlink is the same door, so a warm code costs no upstream hop.
       */
      if (inner.kind === 'shortlink') {
        let got: Awaited<ReturnType<Deps['resolveShortlink']>> | null = null
        try {
          got = await d.resolveShortlink(inner.p, inner.code, env, client)
        } catch {
          got = null
        }
        const canon = got?.kind === 'post' ? got.post?.canonical : null
        let resolved: Route | null = null
        if (canon) {
          try {
            resolved = route(new URL(canon))
          } catch {
            resolved = null
          }
        }
        // A miss leaves `inner` alone, so the answer degrades to exactly what it was before.
        if (resolved && resolved.kind === 'post') inner = resolved
      }
      if (inner.kind !== 'post') return Response.json({ ok: false, reason: inner.kind })

      const got = await getPost(inner.ref, d, env, client, ctx)
      if (!got.post) {
        // The page shows the same 🔞/🔒 wording Discord would, rather than inventing its own.
        return Response.json({ ok: false, reason: 'fetch_fail', gate: renderGate(got.failReason) })
      }
      const settled = await settleMux(got.post, env, ctx, Math.max(MUX_WAIT_FLOOR_MS, HTML_DEADLINE_MS - (Date.now() - started)))
      const xlate = await withTranslated(
        settled.post, env, ctx,
        Math.max(XLATE_WAIT_FLOOR_MS, Math.min(XLATE_MAX_WAIT_MS, HTML_DEADLINE_MS - (Date.now() - started))),
      )
      /**
       * THE SAME OVERLAYS THE ACTIVITY CALLBACK APPLIES, because a preview that disagrees with the
       * card is worse than no preview.
       *
       * This endpoint applied none of them, and it lied for it. The Post it describes comes out of the
       * post cache (POST_TTL 900s), so a video whose meta record warmed AFTER that Post was frozen kept
       * reporting createdAt 1970 for a quarter of an hour while R2 held the right answer — which is
       * exactly what the bug report was filed against, and what sent the first investigation at the
       * date pipeline instead of at a stale cache.
       *
       * A CACHE READ, NEVER A CONTAINER CALL: one R2 GET on a yt ref. Warming the meta is the activity
       * route's job (youtubeMeta), and giving a preview endpoint the power to dispatch container work
       * would hand it a cost the card path deliberately bounds.
       */
      let post = xlate.post
      if (post.ref.p === 'yt') {
        const warm = await readCachedMeta<YouTubeMeta>(post.ref, env, YT_META_TTL_MS, ytMetaValid)
        if (warm) {
          post = withAgeNote(
            withCounts(withDescription(withUploadDate(post, warm.timestamp), warm.description), warm),
            warm.ageLimit,
          )
        }
      }
      const own = mediaOf(post).filter(usable)
      return Response.json({
        ok: true,
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
        media: own.map((m, i) => ({
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

    case 'post': {
      // Humans never cost us an upstream fetch: the router already knows canonical. The bot half —
      // cache-check, fetch, render, cache — is renderPostRoute, shared with the reddit share route so
      // a fetch_fail gets the distinct 🔞/🔒 or generic card identically whichever url shape was pasted.
      if (client === 'human') return redirect(r.canonical)
      return renderPostRoute(r.ref, r.canonical, d, env, ctx, client, origin)
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
      if (client === 'human') return redirect(r.canonical)
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
        if (client === 'human') return redirect(loc ? stripMetaTracking(loc) : r.canonical)
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
      if (client === 'human') return redirect(inner.canonical)
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
      if (client === 'human') {
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
      const hit = await d.cache.match(rkey)
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
        const amb = render({ kind: 'ambiguous', path: url.pathname, candidates: ['tt', 'th'] }, client, origin)
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

      const res = render({ kind: 'post', post }, client, origin)
      const toCache = new Response(res.clone().body, res)
      toCache.headers.set('cache-control', `max-age=${RESP_TTL}`)
      ctx.waitUntil(d.cache.put(rkey, toCache))
      count(env, r.p, 'ok', client)
      return res
    }
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, ctx, {
      cache: caches.default as unknown as CacheLike,
      fetchPost: liveFetchPost,
      resolveShortlink: liveResolveShortlink,
      resolveRedditShare: liveResolveRedditShare,
      resolveMetaShare,
    })
  },
}
