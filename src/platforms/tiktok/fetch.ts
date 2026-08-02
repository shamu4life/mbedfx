import type { Post, PostRef } from '../../types.ts'
import { AWEME_PLAY, rehydrationScopes, videoDetailScope } from './normalize.ts'

/**
 * I/O ONLY. This file fetches a TikTok post page and decides one question — "did I get a real
 * page" — and nothing else. Parsing the blob, walking it, and deciding whether there is a POST
 * in it all live in normalize.ts, which is pure and tested against real captured bytes.
 *
 * TASK 1'S MEASURED BRANCH: decision-tree BRANCH 1 (page works from Workers egress, unchanged).
 * Reproduced 2026-07-19 from a real Cloudflare isolate on both post kinds: `none`, `chrome` and
 * `chrome_win` each returned HTTP 200 with the marker present, `statusCode: 0` and an
 * `itemStruct`; `discordbot` returned the ~7KB decoy with no marker at all.
 *
 * BRANCH 3 — resolve the aweme 302 server-side and store the resolved CDN URL — IS NOW HERE, and
 * the header comment that used to say it was unavailable was reasoning from the wrong premise.
 * See resolveAwemeUrl for the full account: the probe measured a network path production does not
 * use, and it measured it for the wrong reason. What forced the change is a SECOND, independent
 * measurement — the redirect HOP COUNT decides which card Discord draws — and that one is about
 * Discord's fetch, not ours. The probe's result is still respected rather than overruled: it is
 * exactly the failure branch resolveAwemeUrl degrades on, and the degrade is today's behaviour.
 * See docs/research/2026-07-18-tiktok-workers-egress-probe.md.
 */

/**
 * TIKTOK'S UA GATE IS INVERTED FROM INSTAGRAM'S. Verified live 2026-07-18:
 *
 *   facebookexternalhit / Discordbot / Twitterbot -> HTTP 200, ~7KB stub, NO caption,
 *     NO playAddr, og:title "TikTok · Mystic Aquarium", og:description "TikTok | Make Your Day"
 *   bingbot                                        -> HTTP 403
 *   a plain Chrome UA, or no UA at all             -> the real page
 *
 * Instagram is the exact opposite — there the CRAWLER UA is the one that works and a Chrome
 * UA gets a 599KB decoy at HTTP 200 — and this project's Instagram notes say so in language
 * that reads almost identically to this paragraph. Do not "fix" this file to match them.
 *
 * An explicit UA rather than relying on sending none: both were verified to work, but "none"
 * makes our behaviour depend on whatever the runtime does or does not add by default, which
 * is not a property we control or can test.
 *
 * THIS IS A MAINTAINED VALUE, NOT A CONSTANT. Chrome 126 shipped June 2024 and this string was
 * last measured working 2026-07-19 (from Workers egress: marker present, statusCode 0, itemStruct
 * on both post kinds). The same argument that rejects sending no UA — do not depend on a value
 * nobody controls — applies to a build that ages: this is a gate TikTok demonstrably tunes, and a
 * UA old enough to be implausible is a slow-drift risk. Re-measure it when TikTok breaks, and
 * move the date with it.
 */
export const TIKTOK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MARKER = '__UNIVERSAL_DATA_FOR_REHYDRATION__'

/**
 * "This segment cannot dissolve the path it is interpolated into."
 *
 * encodeURIComponent IS NOT ENOUGH ON ITS OWN, and both URL-pinning comments in this file used to
 * imply it was. It escapes `/` but NOT `.`, so the two shortest traversal segments there are walk
 * straight out of the pinned prefix while the template string still looks pinned:
 *
 *   fetchTikTok '..'            -> https://www.tiktok.com/@i/video/..  => the wire path is /@i/
 *   fetchTikTok '.'            -> https://www.tiktok.com/@i/video/.   => the wire path is /@i/video/
 *   resolveTikTokShortlink '..' -> https://www.tiktok.com/t/..         => the wire path is /
 *
 * Both tests that pin those URLs sampled only '../../evil', which is precisely the case
 * encodeURIComponent handles — so the property they asserted was false for the inputs they did not
 * try. Found by a reviewer on the Instagram fetcher, which had copied the same guard and the same
 * blind spot; fixed on both platforms in one commit.
 *
 * `.` AND `..` ARE THE COMPLETE ESCAPE SET once encodeURIComponent has run — `/` is escaped and
 * `%` becomes `%25`, so no other segment can normalise away — which is why this is an exact
 * two-case refusal rather than a shape check. DELIBERATELY NOT A SHAPE CHECK: the Instagram
 * sibling can afford `/^[A-Za-z0-9_-]{1,64}$/` because shortcodes are base64url by construction,
 * but router.ts validates neither a tt id nor a /t/ code (line 266 notes the id is digits "in
 * practice" and declines to require it), and a strict pattern here would be a new way to break a
 * shipped platform if TikTok ever mints a shape we did not predict. This refuses only what is
 * provably unfetchable.
 */
function pinnable(seg: string): boolean {
  return seg !== '.' && seg !== '..'
}

/**
 * "The page rendered at all." A NECESSARY BUT INSUFFICIENT condition — see hasVideoDetailScope,
 * which is the one that actually decides, and read that before using this to classify anything.
 *
 * Kept as its own predicate for two reasons: it is the cheap prefilter that keeps a ~1.8ms
 * match-and-parse off every junk body (measured on the 286KB video fixture; the substring test is
 * ~0.0005ms), and it is the assertion whose failure means the specific thing "TikTok renamed the
 * rehydration blob" — which is the single most likely way this platform dies and is worth being
 * able to name separately from every other page failure.
 *
 * `typeof body === 'string'` before `.includes` because this is handed whatever `res.text()`
 * or a caller produced: a non-string here must classify, not throw.
 */
export function hasRehydrationPayload(body: unknown): boolean {
  return typeof body === 'string' && body.includes(MARKER)
}

/**
 * "This is a real POST page." NOT "there is a post in it" — a DELETED post returns a full 287KB
 * page carrying this scope with statusCode 10204 and no itemStruct, and deciding THAT is the
 * normalizer's job.
 *
 * THE MARKER ALONE IS NOT THE DISCRIMINATOR, AND THE HOMEPAGE IS THE PROOF. Captured live
 * 2026-07-19: `https://www.tiktok.com/` answers HTTP 200 with 354,893 bytes carrying the marker
 * and a 257,666-byte blob — and no `webapp.video-detail` scope at all. Any block, geo-bounce or
 * edge interstitial that lands on TikTok's generic shell therefore passes a marker-only test,
 * classifies as "the page answered", and gets counted as a missing post. That is exactly the
 * conflation assert_fail was introduced to eliminate. Plan fact 10 says so in terms, and
 * normalize.ts has said it since it was written: the blob's mere presence proves nothing.
 *
 * It delegates to the normalizer's extractor rather than pattern-matching the scope name here,
 * so there is ONE regex and ONE parse spelling in the codebase. A substring test for
 * "webapp.video-detail" would be cheaper and would also let a TRUNCATED response through — the
 * marker and the scope name both survive a body that got cut off mid-JSON, and a body we cannot
 * parse is a page that failed to arrive, not a post that is gone.
 */
export function hasVideoDetailScope(body: unknown): boolean {
  return hasRehydrationPayload(body) && videoDetailScope(body) !== null
}

/**
 * "The PAGE did not answer" vs "the POST was rejected" — two different failures that used to
 * share one counter, so a renamed blob, a 429 and a wave of deleted links were indistinguishable.
 *
 * assert_fail means WE are broken: no marker (a rate limit, TikTok renaming the rehydration blob)
 * or a marker with no post scope behind it (a block page, a geo-bounce or an interstitial served
 * as TikTok's generic shell, which carries a blob of its own — see hasVideoDetailScope). fetch_fail
 * (decided one layer up, by the normalizer's statusCode check) means the PLATFORM is working
 * correctly and the post is not there. Outcome2 has declared assert_fail since Phase 1 and nothing
 * has ever emitted it — so an assertion too weak to fire on a block page would leave it at zero
 * for the exact failure it exists to detect.
 */
export type TikTokFetch =
  | { ok: true; html: string }
  | { ok: false; reason: 'assert_fail' }

/**
 * PURE, so the classification is testable with no network and no stubbed globals.
 *
 * This is the POST-PATH classifier: it is asked about a body fetched from `/@i/video/{id}`, where
 * landing on a page with no video-detail scope means TikTok bounced us. Measured 2026-07-19, a
 * bogus id on this path still answers WITH the scope — `foobar` and `0` give statusCode 100002,
 * `99999999999999999999` gives 10204 — so scope-absence here is never just "no such post".
 *
 * DO NOT REUSE THIS UNCHANGED FOR THE `/t/{code}` SHORT-LINK RESOLVER. There, scope-absence is the
 * homepage, and the homepage means "this code is not TikTok" — a legitimate answer whose correct
 * response is the chooser, not a counter that means WE are broken (a real Threads short code
 * produces it, verified 2026-07-18). That resolver wants the two predicates separately:
 * hasRehydrationPayload false is assert_fail; marker-present-but-scope-absent is "not TikTok".
 */
export function pageOutcome(body: unknown): TikTokFetch {
  return hasVideoDetailScope(body)
    ? { ok: true, html: body as string }
    : { ok: false, reason: 'assert_fail' }
}

/**
 * ASSERT ON CONTENT, NEVER ON STATUS. The decoy above is HTTP 200 with a plausible
 * content-type, so neither is evidence of anything. `/@i/video/{id}` is used because it
 * resolves without knowing the username (verified 2026-07-18) — which is what lets
 * PostRef {p:'tt', id} be sufficient identity for the platform.
 *
 * `encodeURIComponent` IS LOAD-BEARING TODAY. It is not future-proofing, and the earlier version
 * of this comment said it was — which is how a "simplify" pass deletes it.
 *
 * router.ts's tiktok() requires only that the id segment be TRUTHY; there is no digit check, and
 * route() safeDecodes segments first. So `/@user/video/..%2f..%2fevil` — a public URL anyone can
 * paste — reaches this function with `ref.id === '../../evil'`, and bare interpolation collapses
 * `https://www.tiktok.com/@i/video/../../evil` to `https://www.tiktok.com/evil`: an
 * attacker-chosen path on tiktok.com, fetched by us with our egress. Encoded, it stays under
 * /@i/video/ and 404s, which is the correct answer for a path segment that is not an id.
 * test/tiktok-normalize.test.mjs pins BOTH halves — that the router really mints it, and that
 * the URL this builds is unchanged by it.
 *
 * The `accept` header is the one part of this request configuration that was NOT in Task 1's
 * measured probe, which sent the UA alone — so do not read the verified-live claims above as
 * covering it. Measured 2026-07-19 over paired runs: TikTok answers this path at either ~315KB or
 * ~385KB with the header AND without it, so the size is run-to-run variance and not header-driven,
 * and the ~315KB variant still classifies ok and still carries a working /aweme/v1/play/ URL. It
 * stays because it is strictly more browser-like on a UA-gated path, not because it was measured
 * to be load-bearing.
 *
 * A THROWN fetch is deliberately not caught here: worker.ts's getPost already treats a thrown
 * live-fetch as a null, and that is a transport failure rather than evidence about TikTok's
 * gate. Catching it here to relabel it assert_fail would dilute the one signal this type exists
 * to carry.
 */
export async function fetchTikTok(ref: Extract<PostRef, { p: 'tt' }>): Promise<TikTokFetch> {
  if (!pinnable(ref.id)) return { ok: false, reason: 'assert_fail' }
  const res = await fetch(`https://www.tiktok.com/@i/video/${encodeURIComponent(ref.id)}`, {
    headers: { 'user-agent': TIKTOK_UA, accept: 'text/html' },
  })
  return pageOutcome(await res.text())
}

/**
 * The SHORT-LINK classifier — the separate one pageOutcome's comment says to write, and the one
 * place this file deliberately diverges from the plan's Task 6 sketch (which reused pageOutcome).
 *
 * The two paths disagree about what scope-absence MEANS, and that is the whole reason there are
 * two functions:
 *
 *   /@i/video/{id}  scope absent -> TikTok bounced us. Even a bogus id answers WITH the scope
 *                   (measured 2026-07-19: `foobar` and `0` give statusCode 100002), so absence
 *                   there can only be a block page or an interstitial. assert_fail: WE are broken.
 *   /t/{code}       scope absent -> the TikTok HOMEPAGE, which is where every non-TikTok code
 *                   lands (verified 2026-07-18 on a dead code AND on a real THREADS code). That
 *                   is the resolver WORKING, and its correct answer is the chooser.
 *
 * Reusing pageOutcome here would count every Threads short link somebody pastes as assert_fail —
 * the counter that exists to mean "TikTok changed and we are blind" — and Threads links are not
 * rare. It would swamp the one signal the Phase-1 Outcome2 split was introduced to carry.
 *
 * So this asserts that the page ARRIVED — the blob is there AND it parses — and stops there.
 * Marker present but no post scope is handed back as ok, and videoDetailScope() decides "not
 * TikTok" one layer up, where that is a legitimate answer rather than a counter.
 *
 * IT ASSERTS THE PARSE, NOT JUST THE MARKER, AND THAT DISTINCTION IS THE WHOLE POINT OF
 * rehydrationScopes(). A marker-only substring test is what shipped first, and it let a
 * TRUNCATED response through as "the page arrived": the marker is in the document's first 60
 * bytes and survives any cut, so a body severed at 50%, 90% or 99% (all three measured on the
 * real capture) classified ok, found no scope, and degraded into "that code is not TikTok" — the
 * chooser — while assert_fail stayed at zero. hasVideoDetailScope's own comment rejects a
 * substring test for exactly this reason; this function was the substring test.
 */
export function shortlinkOutcome(body: unknown): TikTokFetch {
  // hasRehydrationPayload first as the cheap prefilter (~0.0005ms vs ~1.8ms), same as
  // hasVideoDetailScope: it keeps a full match-and-parse off every junk body.
  return hasRehydrationPayload(body) && rehydrationScopes(body) !== null
    ? { ok: true, html: body as string }
    : { ok: false, reason: 'assert_fail' }
}

/**
 * ONE fetch. `fetch()` follows redirects by default and the redirect TARGET's body is the post
 * page — verified 2026-07-18: /t/ZTSw2mYwR -> redirects=1 -> the @user/video/{id} page with
 * statusCode 0, itemStruct.id and five aweme URLs, in a single 286KB response. There is no
 * resolve-then-fetch round trip to pay for, which is the measurement that retired this feature's
 * deferral.
 *
 * Same UA and same headers as fetchTikTok, deliberately: a short link is the same page fetch with
 * a different starting URL, so any divergence here would be a SECOND UA gate to keep in sync with
 * the inversion documented at TIKTOK_UA. Only the classifier differs, and shortlinkOutcome says
 * why.
 *
 * encodeURIComponent for the same reason fetchTikTok has it, and it is load-bearing the same way:
 * router.ts requires only that the code segment be truthy and route() safeDecodes it first, so
 * `/t/..%2f..%2fevil` reaches here as `../../evil` and bare interpolation would collapse the URL
 * to an attacker-chosen path on tiktok.com, fetched with our egress.
 */
export async function resolveTikTokShortlink(code: string): Promise<TikTokFetch> {
  if (!pinnable(code)) return { ok: false, reason: 'assert_fail' }
  const res = await fetch(`https://www.tiktok.com/t/${encodeURIComponent(code)}`, {
    headers: { 'user-agent': TIKTOK_UA, accept: 'text/html' },
  })
  return shortlinkOutcome(await res.text())
}

/**
 * The CDN hosts the aweme endpoint is allowed to redirect us to.
 *
 * MEASURED, not guessed: the residential control arm resolved to `v16m-default.tiktokcdn-us.com`
 * (2026-07-19, 14,548,779 bytes of MP4 with `ftyp` at bytes 4-8). The `-XX` group covers the
 * sibling regional spellings of the same name without opening the pattern to an arbitrary
 * wildcard.
 *
 * `(^|\.)` IS THE WHOLE GUARD AND IT IS NOT DECORATION. Without the anchor, `eviltiktokcdn.com`
 * matches; without the `$`, `tiktokcdn-us.com.attacker.example` does. This value ends up in
 * og:video, so a host we did not mean is a video tag pointing at somebody else's bytes.
 *
 * DELIBERATELY STRICT, and the direction of the error is the point. Too strict costs us the
 * one-hop card and degrades to the two-hop behaviour we already ship — visibly the same embed,
 * just the OpenGraph one. Too loose emits an og:video pointing at an HTML page, which renders a
 * DEAD player AND suppresses og:image (normalize.ts's I-1 lesson): the post shows nothing at all.
 * So if the Discord card ever regresses to the OpenGraph shape, THIS PATTERN IS THE FIRST THING
 * TO CHECK — a renamed CDN fails closed here, silently and by design.
 */
const CDN_HOST = /(^|\.)tiktokcdn(-[a-z]{2})?\.com$/

/**
 * The final CDN URL the aweme endpoint 302s to, or null. ONE upstream request, NO video bytes.
 *
 * WHY THIS EXISTS: THE HOP COUNT DECIDES WHICH CARD DISCORD DRAWS. Measured 2026-07-19 with
 * `curl -sSL -w '%{num_redirects}'`, after three tag-level hypotheses had already been tried and
 * disproven:
 *
 *   our slideshow image   1 redirect   -> Mastodon activity card  (works)
 *   Bluesky image         1 redirect   -> Mastodon activity card  (works)
 *   PRODUCTION fxtiktok   1 redirect   -> Mastodon activity card  (works)
 *   OUR video             2 redirects  -> OpenGraph card          (FAILS)
 *
 * Our chain was `/_media/{key}/0` -> 302 the aweme endpoint -> 302 the real bytes. Production's
 * offload service resolves that second hop server-side, which is the entire reason its chain is
 * one hop. It is NOT a meta tag; nothing in the head was ever the difference.
 *
 * WHY THE EARLIER "THIS IS IMPOSSIBLE" MEASUREMENT DOES NOT BLOCK IT. The Task 1 probe fetched
 * this URL from Workers egress and got an HTTP 200 `text/html` page from `www.tiktok.com` with no
 * redirect at all, and concluded the remedy had "nothing to resolve". That conclusion was drawn
 * against a different question — "can WE download the video" — and its own document says the
 * probe "measured a network path production does not use". If Workers egress really cannot see
 * the 302, this function returns null and the caller keeps handing out the aweme URL, which is
 * precisely today's behaviour: the change is then a no-op that costs one HEAD-shaped request per
 * post fetch. If it can, the card is fixed. Neither outcome can make the embed worse, which is
 * why this ships rather than waiting on another probe.
 *
 * ASSERT ON CONTENT, NEVER ON STATUS, and this endpoint is the reason that rule exists here: the
 * WORKING residential fetch and the FAILING datacenter fetch were BOTH HTTP 200. So the status is
 * deliberately not consulted at all. The Location header's presence and its host are the whole
 * assertion — an interstitial carries no Location, and a redirect to anywhere that is not a
 * TikTok CDN is refused by CDN_HOST above.
 *
 * `redirect: 'manual'` IS LOAD-BEARING. The default follows the redirect and streams ~14MB of
 * MP4 into the isolate — this project has never proxied bytes and must not start by accident.
 * The body is cancelled rather than read for the same reason.
 *
 * TTL: the resolved URL carries roughly a 6-hour expiry (recon measured ~21,667s), comfortably
 * longer than POST_TTL (900s) + MEDIA_MAX_AGE (300s), which is what makes it safe to cache the
 * resolved URL inside the Post. IF TIKTOK EVER SHORTENS THAT WINDOW THIS IS THE FIRST THING TO
 * CHECK: an expired CDN URL is a dead video where today there is a live one.
 */
export async function resolveAwemeUrl(aweme: string): Promise<string | null> {
  let res: Response
  try {
    // Same UA as the page fetch, deliberately — TikTok's gate is INVERTED from Instagram's (see
    // TIKTOK_UA), so a crawler UA or an absent one would be measuring a different endpoint than
    // the one we are about to hand to Discord.
    res = await fetch(aweme, {
      redirect: 'manual',
      headers: { 'user-agent': TIKTOK_UA, accept: 'video/mp4,*/*' },
    })
  } catch {
    // A transport failure is not evidence about TikTok's gate, and it must never become an
    // uncaught 500: liveFetchPost's tt arm has no try/catch and worker.ts's media branch has none
    // either. Null degrades to the aweme URL, which is what we ship today.
    return null
  }
  // Never read. On the 200-interstitial branch this is a whole HTML page, and on a
  // misconfigured-redirect branch it could be the video itself.
  res.body?.cancel().catch(() => {})

  const loc = res.headers.get('location')
  if (!loc) return null
  let u: URL
  try {
    // Resolved against the request URL because a relative Location is legal HTTP. It cannot
    // survive the host check below — it resolves back onto www.tiktok.com — but parsing it
    // relative-safely is what keeps `new URL` from throwing on the way to that refusal.
    u = new URL(loc, aweme)
  } catch {
    return null
  }
  // https only, for the reason httpsUrl() gives in the normalizer: this string becomes og:video,
  // and an http one is a mixed-content hole we would be authoring ourselves.
  if (u.protocol !== 'https:') return null
  if (!CDN_HOST.test(u.hostname)) return null
  // Another aweme URL is not progress — it is the same two hops with an extra request spent.
  if (u.pathname.includes(AWEME_PLAY)) return null
  return u.href
}

/**
 * A TikTok Post whose video Media points at the FINAL CDN URL rather than at the aweme redirect.
 * Returns a Post, never null: every failure hands the input straight back.
 *
 * WHY THE FETCHER AND NOT THE NORMALIZER, which is where the aweme URL is actually selected and
 * would be the natural place. normalize.ts is PURE — its header says so, and the whole test suite
 * depends on it: every normalizer test drives real captured bytes with no network and no stubbed
 * globals, and callers treat `normalizeTikTok` as returning a Post rather than a Promise. Making
 * it async to do one fetch would make that entire layer I/O-shaped for one platform's one field.
 * So the split the architecture already draws is kept: fetchers do I/O, normalizers are pure, and
 * this is the fetcher.
 *
 * ONCE PER POST, NOT ONCE PER MEDIA HIT. Called from liveFetchPost, so the resolved URL is what
 * loadPost serializes into the cache entry and every subsequent /_media/ hit — from every client
 * that unfurls the link — reads it back for free. Doing this in the media route instead would
 * mean one aweme request per client per view, which is the amplification media.ts's own comment
 * refuses ("an 8-image carousel triggers 8 media hits; re-resolving each would mean 8 upstream
 * fetches per viewing client, on the platforms we rate most fragile").
 *
 * AT MOST ONE REQUEST, structurally: only the FIRST aweme-shaped video entry is resolved.
 * videoMedia emits exactly one Media and slideshowMedia emits none, so this is one fetch for a
 * video post and ZERO for a photo post — which matters, because slideshows are the arm that
 * already renders correctly and must not start paying for this.
 */
export async function withResolvedVideo(post: Post): Promise<Post> {
  const media = post.media
  if (!Array.isArray(media)) return post
  const i = media.findIndex(
    m => m?.kind === 'video' && typeof m.url === 'string' && m.url.includes(AWEME_PLAY),
  )
  if (i < 0) return post

  const resolved = await resolveAwemeUrl(media[i].url)
  // DEGRADE TO THE INPUT, and the direction is deliberate: two hops renders the OpenGraph card,
  // which is a worse embed; no video renders nothing at all. Every no-answer lands on the former.
  if (!resolved) return post

  // Spread rather than rebuilt, so `duration` (and anything a later Media gains) survives. A
  // hand-built `{kind, url, w, h}` would silently drop it, and og:video:duration with it.
  const next = [...media]
  next[i] = { ...media[i], url: resolved }
  return { ...post, media: next }
}
