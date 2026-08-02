import type { PostRef } from '../../types.ts'
import { hasEmbedPost } from './normalize.ts'

/**
 * I/O ONLY. This file fetches an Instagram embed page and decides one question — "did a real post
 * page arrive" — and nothing else. Finding the payload, walking it and deciding whether there is a
 * POST in it all live in normalize.ts, which is pure and tested against real captured bytes.
 *
 * WHICH MARKER TASK 1 SETTLED ON, and it is neither of the two candidates the plan offered.
 * Task 1's decision tree asked whether the GraphQL object arrives under `TimeSliceImpl` /
 * `shortcode_media` or under `contextJSON`, and the answer measured from the fixtures is that the
 * question was malformed: `contextJSON` is the CONTAINER (the object is a JSON string inside it,
 * hence normalize.ts's parse-twice), and BOTH `contextJSON` and `TimeSliceImpl` are present on the
 * 80,319-byte "post unavailable" page too — so neither is a liveness marker. See hasEmbedPayload
 * for what is asserted instead.
 *
 * CAVEAT ON PROVENANCE, stated because the next reader will otherwise assume it was settled.
 * The four-UA table below was measured from a RESIDENTIAL IP on 2026-07-19 (the fixtures in
 * test/fixtures/, captured with facebookexternalhit/1.1). The plan's fact 11 is explicit that
 * Instagram's behaviour toward Cloudflare is PATH-DEPENDENT, so a residential result does not
 * transfer to Workers egress by itself, and if this platform ever fails only in production the
 * egress measurement is the first thing to go and get.
 *
 * WHAT IS ACTUALLY EVIDENCED FROM WORKERS EGRESS, and it is narrower than the table: the ONE row
 * this fetcher depends on. Staging renders a real post end-to-end and its /_media/ 302 resolves to
 * live CDN bytes (`ftypisom`), which is only reachable if this fetch — from Workers egress, with
 * the crawler UA pinned below — got the real payload rather than the decoy. The other three rows
 * have never been measured from Workers. See
 * docs/research/2026-07-19-instagram-workers-egress-probe.md, which records exactly that split.
 *
 * THE PROBE THAT WOULD MEASURE THE REST NO LONGER EXISTS — it was removed in 0a32bbc, before the
 * deploy this phase is judged on, because it fetched a caller-supplied shortcode from our egress
 * on a public origin. Two tests in test/pipeline.test.mjs now make its reintroduction fail the
 * suite, including under a different filename. If you genuinely need the full table, re-add a
 * probe DELIBERATELY and temporarily, and heed the trap that made the old one dangerous: it
 * asserted on `shortcode_media`, the marker this task disproved, and a single-image post carries
 * none — so pointed at a single image it reported a false "blocked from Workers egress", the most
 * damaging wrong answer available here. Probe a REEL or a CAROUSEL.
 */

/**
 * INSTAGRAM'S UA GATE IS INVERTED FROM TIKTOK'S. Measured 2026-07-19 over four UAs:
 *
 *   facebookexternalhit/1.1  -> real, server-rendered payload
 *   Discordbot/2.0           -> real, server-rendered payload
 *   curl/8.4.0               -> real, server-rendered payload
 *   Chrome/122               -> ~598KB empty JS shell, NO payload, at HTTP 200   DECOY
 *
 * Claim to be a browser and Instagram assumes you have JavaScript and serves a large empty shell;
 * claim to be a crawler and it server-renders the content. OGInstagram documents it outright
 * (config.go:62). curl/8.4.0 succeeding is the decisive row — the least browser-like fingerprint
 * available gets the real content, which disproves the widely-repeated TLS/JA3 theory. The gate is
 * the UA, which is why InstaFix died: its curl_cffi sidecar impersonates Chrome, i.e. the exact UA
 * class that is served the decoy.
 *
 * This repo holds BOTH SIDES of the inversion as captured bytes rather than as a claim in a
 * comment: test/fixtures/instagram-single.html is the facebookexternalhit capture of
 * C79gQqLpkul (payload present) and instagram-decoy.html is the Chrome capture (no payload,
 * 597,851 bytes). The decoy carries no shortcode anywhere in it — it is a genuinely contentless
 * shell — so "the same post" is NOT checkable from the fixtures and is recorded here as capture
 * provenance instead: both were taken 2026-07-19, minutes apart, against that same URL.
 *
 * SENDING NO UA AT ALL IS NOT A WORKING BRANCH, and an earlier version of this file said it was.
 * Measured live 2026-07-20 against the exact URL this fetcher builds: an empty User-Agent gets
 * HTTP 302 to https://www.facebook.com/unsupportedbrowser, whose body carries zero
 * `data-media-type`. So an absent UA fails the content assertion immediately and loudly — the
 * SAME failure mode as TikTok, not the opposite one. (The crawler UA was re-measured in the same
 * run and still works: HTTP 200, 100,183 bytes, marker present.)
 *
 * TIKTOK IS THE EXACT OPPOSITE — there a crawler UA gets a ~7KB decoy and a plain Chrome UA gets
 * the real page — and src/platforms/tiktok/fetch.ts says so in language that reads almost
 * identically to this paragraph. DO NOT "FIX" THIS FILE TO MATCH IT. Tests assert mechanically
 * that this UA IS crawler-shaped and that TIKTOK_UA is NOT, so the conflation cannot be made
 * silently in either direction.
 *
 * NO CREDENTIALS OF ANY KIND. No cookie, no x-ig-app-id, no CSRF token, no session. There is
 * nothing to rotate and no device identity to generate — unlike TikTok, where upstream's
 * device-id machinery had to be reasoned about before being ruled moot.
 */
export const INSTAGRAM_UA = 'facebookexternalhit/1.1'

/**
 * "A REAL POST PAGE ARRIVED." The one content assertion, and it is `hasEmbedPost`, NOT
 * `shortcode_media`.
 *
 * THE PLAN NAMED shortcode_media FOR THIS FUNCTION AND IT IS WRONG ON THE COMMONEST POST ON THE
 * PLATFORM. Task 3 measured eleven live posts across three accounts: a SINGLE IMAGE ships
 * `"contextJSON":null` and is server-rendered into the markup, so its document contains no
 * `shortcode_media` anywhere. Asserting on the object would count every single-image post as
 * assert_fail — the counter that means "Instagram changed and we are blind" — while a reel and a
 * carousel looked perfectly healthy. A false alarm that fires on most of the platform is worse
 * than no alarm, because the real one is then unreadable.
 *
 * TWO CONJUNCTS, AND THEY ANSWER DIFFERENT QUESTIONS. `hasEmbedPost` is liveness — "is there a
 * real post in these bytes" — and is DELEGATED whole. `bodyIsComplete` is arrival — "did the bytes
 * stop early" — and belongs here rather than in the normalizer, because a truncated response is a
 * property of the FETCH, not of the page. Adding it is not a second spelling of the liveness
 * marker and does not weaken the delegation below; see bodyIsComplete for what it caught.
 *
 * It DELEGATES rather than re-implementing: normalize.ts is where finding the payload lives, and
 * that is where a platform change breaks us first. Two spellings of "did the page arrive" is two
 * things to keep in step when Instagram renames something, and the drift would be silent. Same
 * rule videoDetailScope states for TikTok.
 *
 * NOT "there is a usable post in it" — a page can arrive and still yield no Post. Deciding that is
 * the normalizer's job, one layer down, and two places answering it is two places that can
 * disagree. hasEmbedPost's own docstring records the resulting asymmetry and its direction: a
 * video page that lost only its blob is ok here and null there, so the drift surfaces as a loud
 * fetch_fail rather than as a reel served with no player.
 */
/**
 * "The body did not STOP EARLY." Orthogonal to liveness, and it is the second half of the page
 * assertion for the reason src/platforms/tiktok/fetch.ts already carries in writing: a
 * marker-only substring test lets a TRUNCATED response through as "the page arrived".
 *
 * INSTAGRAM'S MARKUP MARKER IS EXACTLY THE VULNERABLE SHAPE. `data-media-type` sits ~27% into the
 * document (measured: 27.0% single, 12.7% carousel, 21.2% reel), so it survives almost any cut.
 * Of the 99 truncations of each real fixture, the number that classified as "a real post page
 * arrived" before this function existed: single 72, reel 78, carousel 87.
 *
 * AND THE SINGLE-IMAGE CASE DID NOT MERELY MISCOUNT — IT MINTED A POST. A single-image page cut to
 * 30% normalized to a complete-looking Post with one media entry, a real author and an EMPTY
 * caption; worker.ts caches any truthy Post for POST_TTL, so that caption-less post would be
 * served to every client for the full TTL. Cut to 29% it yielded a Post with `media: []` — an
 * author, no image, no caption. The markup path has no "a post must have media" guard, so the
 * fetcher is the layer that has to refuse the body.
 *
 * WHY A STRUCTURAL TEST AND NOT A MARKER. The obvious alternative is the trailing
 * `s.cleanup(TimeSlice)` call, which sits at 100% of every real embed document and catches 237 of
 * 237 truncations to this test's 236. It was rejected on FAILURE DIRECTION: that string is
 * minified Facebook JS, so a variable rename — the single likeliest cosmetic change upstream can
 * make — would take every Instagram post to assert_fail and kill the platform outright. "The
 * document ends in a complete tag" cannot be broken by a minifier, a CSS class rename or a markup
 * restructure, because it is a property of HTML rather than of Instagram's build.
 *
 * NOT `</html>`, WHICH IS THE TRAP: the real embed pages do NOT close their document. All four
 * live captures end on `</script>` and carry no `</body>` and no `</html>` at all — the DECOY is
 * the one that ends `</body></html>`. So the intuitive completeness check is precisely backwards
 * here and would fail every healthy page.
 *
 * THE ONE THAT SLIPS THROUGH, stated rather than hidden: a cut landing exactly on a tag boundary
 * passes (1 of 297 measured). This is a cheap completeness test, not a proof of completeness.
 *
 * Read off the LAST 64 BYTES rather than by anchoring a regex on the whole body, so the cost is
 * O(1) on a 598KB decoy instead of a scan, and no hostile body can make it quadratic.
 */
export function bodyIsComplete(body: unknown): boolean {
  if (typeof body !== 'string') return false
  return /(<\/[a-z][a-z0-9]{0,14}>|\/>)\s*$/i.test(body.slice(-64))
}

export function hasEmbedPayload(body: unknown): boolean {
  return hasEmbedPost(body) && bodyIsComplete(body)
}

/**
 * "The PAGE did not answer" vs "the POST was rejected" — two different failures that would
 * otherwise share one counter, so a renamed marker, a 429, an edge block and a wave of genuinely
 * deleted links would all be indistinguishable, and they call for opposite responses.
 *
 * assert_fail means WE are broken: the decoy, a block page, a rate limit, or Instagram renaming
 * what the extractor looks for. THE DECOY IS WHY THIS SPLIT EARNS ITS KEEP ON THIS PLATFORM
 * SPECIFICALLY. A silently-flipped UA gate returns HTTP 200 with valid, plentiful HTML — the
 * single most likely way Instagram dies for us — so folded into fetch_fail it would be
 * indistinguishable from a page that simply failed to arrive, and the spec's alert (assert_fail >
 * 10% of a platform's requests over 15 minutes) would never fire.
 *
 * A DELETED OR PRIVATE POST IS ALSO assert_fail HERE, AND WHOEVER READS THAT ALERT MUST KNOW IT.
 * This is the one place the "WE are broken" reading above is not the whole truth. The 80,319-byte
 * "post unavailable" page carries neither marker — no data-media-type, no parseable blob — so it
 * cannot be told apart from a shell, and it lands in assert_fail. TikTok is the opposite (its
 * deleted page keeps the video-detail scope and stays ok:true, which an existing test pins by
 * name), so do not reason across the two platforms here.
 *
 * IT IS DELIBERATE AND IT IS THE PLAN'S CALL, not drift: Task 8 pins gone -> assert_fail with the
 * rationale "Instagram does not distinguish 'gone' from 'shell' on this endpoint, so we do not
 * invent a distinction we cannot observe", and re-measurement confirms there is no observable
 * distinguisher (`Sorry, this page`, `isn't available` and `PolarisErrorRoot` are all absent from
 * the capture). The plan's OWN counter table at Task 4 says fetch_fail instead — the plan
 * contradicts itself here, and this file follows the tested half.
 *
 * THE OPERATIONAL CONSEQUENCE: ordinary dead-link and private-account traffic feeds the 10%
 * alert, so the threshold is noisier on Instagram than on TikTok and a firing alert is NOT by
 * itself proof the gate flipped. Check the decoy's signature — a ~598KB body — before concluding
 * that. If dead links ever swamp it in practice, the fix is a positive "post unavailable"
 * detector, not lowering the bar on the page assertion.
 *
 * The counters STACK, they do not replace: an assert_fail is also counted as a fetch_fail by the
 * worker's existing null path, which is this file's established pattern (worker.ts's
 * activity/oembed case already layers fetch_fail on top of api_miss). So assert_fail / fetch_fail
 * reads as "of the failures, this fraction were the page assertion".
 */
export type InstagramFetch =
  | { ok: true; html: string }
  | { ok: false; reason: 'assert_fail' }

/** PURE, so the classification is testable with no network and no stubbed globals. */
export function pageOutcome(body: unknown): InstagramFetch {
  return hasEmbedPayload(body)
    ? { ok: true, html: body as string }
    : { ok: false, reason: 'assert_fail' }
}

/**
 * WHAT AN INSTAGRAM SHORTCODE CAN BE — base64url and nothing else. The three live captures are
 * C79gQqLpkul, DaQ5CPTki4E and Da5ynsiuAZ_; `-` and `_` are legal and must not be rejected, and
 * the {1,64} bound is slack over the historical 11 characters rather than a measured maximum.
 *
 * THIS EXISTS BECAUSE encodeURIComponent IS NOT SUFFICIENT ON ITS OWN, which the comment below it
 * used to imply and a reviewer disproved. encodeURIComponent escapes `/` but NOT `.`, so the two
 * shortest traversal codes there are walked straight out of the pinned path during URL parsing:
 *
 *   '..' -> https://www.instagram.com/p/../embed/captioned/  => the wire path is /embed/captioned/
 *   '.'  -> https://www.instagram.com/p/./embed/captioned/   => the wire path is /p/embed/captioned/
 *
 * REACHABLE FROM A PUBLIC URL, not just from a stale cache. The permalink route cannot deliver it
 * (WHATWG URL normalises `%2e%2e` before route() sees it, and /p/%2e%2e lands on kind 'site'), but
 * the Mastodon-spoof route can: encodeStatusId is a numeric encoding of an ARBITRARY key and
 * parseRefKey percent-decodes each component, so `ig:p:%2e%2e` round-trips to code '..' through
 * /api/v1/statuses/{digits}, /users/{h}/statuses/{id} and /_oembed/{id} alike.
 *
 * The blast radius was bounded — both escaped paths answer HTTP 200 with markerless shell, so no
 * wrong body ever reached a client — but the cost was a fabricated ~600-700KB upstream request per
 * hit, made with OUR egress, on a path we never meant to request. Refusing before the fetch is
 * strictly cheaper than discovering it upstream.
 *
 * THE SAME SHAPE EXISTS IN fetchTikTok and is fixed there in the same commit, for the same reason
 * and with the same argument: `..` collapses https://www.tiktok.com/@i/video/.. to /@i/.
 */
const SHORTCODE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * ASSERT ON CONTENT, NEVER ON STATUS, NEVER ON CONTENT-TYPE, AND NEVER ON SIZE. All three lie
 * here: the decoy is HTTP 200 with an ordinary text/html, and it is SIX TIMES LARGER than the real
 * payload — so every instinct that reaches for a size or status check is not merely uninformative
 * but actively backwards. A nonexistent shortcode is also HTTP 200.
 *
 * ONE SPELLING OF THE URL, FOR EVERY SURFACE. `/reel/{code}/embed/captioned/` and
 * `/p/{code}/embed/captioned/` return byte-identical payloads (verified 2026-07-19), so this
 * fetcher never has to know which surface the link came from — and Task 2's router, which
 * collapses /p, /reel, /reels and /tv onto one `kind:'p'` ref, is what makes that sound. The `kind`
 * is deliberately not consulted below except to refuse a story.
 *
 * THE URL IS PINNED BY THE SHORTCODE CHECK ABOVE, NOT BY `encodeURIComponent`, and an earlier
 * version of this comment had that backwards. router.ts's instagram() requires only that the code
 * segment be TRUTHY (there is no shape check there) and route() safeDecodes segments first, so a
 * hostile code genuinely does reach this function — but encodeURIComponent alone does not stop it,
 * because it escapes `/` and not `.`. SHORTCODE is what makes the invariant true.
 *
 * encodeURIComponent STAYS ANYWAY, as the second layer, and it is now redundant BY CONSTRUCTION:
 * SHORTCODE admits only [A-Za-z0-9_-], on which encodeURIComponent is a no-op. That means no test
 * driving fetchInstagram can observe its removal — stated plainly rather than left for the next
 * reader to discover, because the honest status of a guard matters more than the appearance of
 * coverage. It is here so that LOOSENING the shape check (a plausible future edit — Instagram
 * could mint a code shape this rejects) cannot silently reopen the traversal at the same time.
 * Delete it only together with SHORTCODE, never on its own.
 *
 * A THROWN fetch is deliberately NOT caught here: worker.ts's loadPost already treats a thrown
 * live-fetch as a null, and a transport failure (DNS, timeout, reset) is not evidence about
 * Instagram's gate. Catching it to relabel it assert_fail would dilute the one signal this type
 * exists to carry.
 */
export async function fetchInstagram(ref: Extract<PostRef, { p: 'ig' }>): Promise<InstagramFetch> {
  // STORIES HAVE NO /embed/captioned/ EQUIVALENT and are out of scope for this phase (see the
  // plan's Task 2 for the three reasons). It carries no `code` at all, so falling through would
  // fetch `/p/undefined/embed/captioned/`: a fabricated upstream request on a shape this endpoint
  // does not serve. Narrowing here rather than guessing.
  //
  // A STORY REF IS REACHABLE, and an earlier version of this comment claimed the opposite — that
  // it "cannot happen" and could only arrive "from a STALE CACHE ENTRY". Both were wrong. Task 2's
  // router never mints one from a PERMALINK, but PostRef has declared {kind:'story', user, id}
  // since Phase 1 and refKey/parseRefKey round-trip it through `ig:story:{user}:{id}` — so an
  // unauthenticated caller can mint story refs at will through all three spoof endpoints
  // (/api/v1/statuses/{digits}, /users/{h}/statuses/{id}, /_oembed/{id}), which is the same
  // channel that made the `..` traversal above reachable. Refs arriving in this function are NOT
  // router-shaped; do not inherit that belief.
  //
  // assert_fail is the imperfect counter for it — nothing about Instagram is broken — but the
  // volume is a hand-crafted status id rather than real traffic, and a third reason for it would
  // cost more than the pollution it prevents.
  if (ref.kind === 'story') return { ok: false, reason: 'assert_fail' }
  // A code that cannot be a shortcode has no right answer upstream, so no request is spent
  // discovering that. This is what actually pins the URL invariant; encodeURIComponent below stays
  // as the second layer, because the two fail in different directions and neither is redundant.
  if (!SHORTCODE.test(ref.code)) return { ok: false, reason: 'assert_fail' }
  const res = await fetch(
    `https://www.instagram.com/p/${encodeURIComponent(ref.code)}/embed/captioned/`,
    // The `accept` header mirrors fetchTikTok's: strictly more browser-like on a gated path, and
    // not measured to be load-bearing either way. The UA is the gate.
    { headers: { 'user-agent': INSTAGRAM_UA, accept: 'text/html' } },
  )
  return pageOutcome(await res.text())
}

/**
 * THE PRIVATE-ACCOUNT FALLBACK SURFACE. fetchInstagram uses /embed/captioned/, where a private post
 * is BYTE-IDENTICAL to a deleted one — measured 2026-07-21 with two real private posts and a
 * fabricated deleted code: all three are the same ~81KB "unavailable" shell, no username, no marker.
 * The full /p/{code}/ page is the ONE surface that names the account: a private post server-renders
 * "username" with no media; a deleted post renders neither. This survives Cloudflare egress — the
 * ONE IG signal besides the happy path that has been confirmed from Workers (probe 2026-07-21:
 * `"username":"fixture_user_1"` present, no data-media-type), which is why private is reachable here
 * and nowhere else on this platform.
 *
 * FALLBACK-ONLY, and that is the cost containment. It runs ONLY after the embed already failed — a
 * minority of IG traffic (deleted + private + blocked) — never on the happy path, and the rendered
 * result is response-cached for RESP_TTL, so a wave of dead links re-fetches once per code per 15
 * minutes. The page is 0.6–2.2MB against the embed's ~100KB, so it is deliberately not primary.
 *
 * Returns the body or null. A thrown/failed fallback is simply "no gate signal" and falls through to
 * today's generic failure — it must NEVER turn a private detection into a louder error, so the fetch
 * is caught here (unlike fetchInstagram's, whose throw is a real transport signal the worker reads).
 */
/**
 * THE COPYRIGHT-BLOCKED RECOVERY SURFACE — Instagram's v1 USER FEED, fetched ONLY for a post whose
 * embed came back rights-struck. Returns the body or null; a throw is "no recovery", never an error.
 *
 * WHY THIS ENDPOINT AT ALL. `/embed/captioned/` omits `video_url` entirely when the post's audio is
 * major-label catalog Meta declines to sub-license to embedders, so a real video renders as a still
 * (the defect reported 2026-07-26 on /reel/DbN6SsKum-9/). The gate lives on the Polaris WEB
 * serializer, which HAS a `copyright_blocked` field. This endpoint answers with the v1 shape, which
 * has NO key matching /copyright/ anywhere on the item — nothing to enforce — so `video_versions[]`
 * comes back intact. Measured 2026-07-26, COOKIE-FREE and TOKEN-FREE: HTTP 200, and the top
 * rendition served HTTP 206 `video/mp4` on a range request.
 *
 * `x-ig-app-id` IS THE LOAD-BEARING HEADER, not the UA. Without it this path answers 302 to a login
 * page; with it, the crawler UA we already use is accepted. Measured both ways.
 *
 * USER-SCOPED, NOT MEDIA-SCOPED, and that asymmetry is the cost of the whole approach. There is no
 * "give me this shortcode" form of it that survives logged-out — `i.instagram.com/api/v1/media/{id}/info/`
 * answers `login_required` (logout_reason 33) from our egress today, which is also why Cobalt's
 * primary anonymous path no longer works. So we ask for the ACCOUNT's recent posts and pick ours out
 * of the page (recoveredMediaFrom is shortcode-scoped for exactly this reason). Two consequences,
 * both accepted rather than hidden: an OLDER blocked reel falls outside the window and stays a still,
 * and we spend ~500KB to recover one video.
 *
 * FALLBACK-ONLY, which is the entire cost containment, and it is enforced by the CALLER: worker.ts
 * reaches this only when instagramCopyrightBlocked() is true on a payload we already have. That
 * predicate is false on every healthy post — pinned by a test — so the happy path never pays for it,
 * and the rendered result is response-cached for RESP_TTL like any other.
 *
 * NOT egress-confirmed. Every measurement above is from a RESIDENTIAL host, and Instagram is known to
 * treat Cloudflare datacenter IPs differently on other surfaces (the ~598KB decoy is the standing
 * proof). This is written to FAIL SAFE rather than to be trusted: a refusal, a redirect, a decoy or a
 * throw all produce null, and null degrades to the cover still we already ship today. The worst case
 * is therefore "unchanged from before this existed", never a regression.
 */
const IG_HANDLE = /^[A-Za-z0-9._]{1,40}$/
const IG_WEB_APP_ID = '936619743392459'

export async function fetchInstagramUserFeed(username: unknown): Promise<string | null> {
  // The handle reaches here off a PARSED payload, not off the router, so it is shape-checked before
  // it is interpolated into a path — the same discipline SHORTCODE applies above, and for the same
  // reason: `.` is not escaped by encodeURIComponent and two of them traverse.
  if (typeof username !== 'string' || !IG_HANDLE.test(username)) return null
  try {
    /**
     * THE sec-fetch-* TRIO IS MANDATORY AND MUST BE SET BY HAND — omitting it does not mean "absent",
     * it means WRONG. fetch() (undici in Node, and the Workers runtime alike) stamps
     * `sec-fetch-site: cross-site` on a request it originates, and Instagram rejects that on its own
     * API with a 26-byte body reading "SecFetch Policy violation." at HTTP 200.
     *
     * THIS WAS CAUGHT BY VERIFICATION, NOT BY REVIEW, and it is worth recording why it survived so
     * long: every manual probe used curl, which sends NO sec-fetch headers at all and is waved
     * through. Only real fetch() traffic trips the policy — so the endpoint measured perfectly by hand
     * and failed the moment our own code called it. A hand-probe and the shipped client are different
     * clients, exactly as Facebook's crawler-UA-vs-browser gate turned out to be.
     *
     * `same-origin` + a referer on the profile is what the real web app sends for this call, and the
     * 200-with-a-text-body failure mode is another reminder that status carries no information here.
     */
    const res = await fetch(
      `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`,
      {
        headers: {
          'user-agent': INSTAGRAM_UA,
          accept: 'application/json',
          'x-ig-app-id': IG_WEB_APP_ID,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
        },
      },
    )
    return await res.text()
  } catch {
    return null
  }
}

export async function fetchInstagramFullPage(ref: Extract<PostRef, { p: 'ig' }>): Promise<string | null> {
  if (ref.kind === 'story') return null
  if (!SHORTCODE.test(ref.code)) return null
  try {
    const res = await fetch(`https://www.instagram.com/p/${encodeURIComponent(ref.code)}/`, {
      headers: { 'user-agent': INSTAGRAM_UA, accept: 'text/html' },
    })
    return await res.text()
  } catch {
    return null
  }
}

/**
 * THE SHORTCODE-SCOPED RECOVERY: one anonymous GraphQL POST that answers with the v1 media shape.
 * Returns the body or null; a throw is "no recovery", never an error.
 *
 * WHY THIS IS THE FIRST THING TRIED for a rights-struck post. fetchInstagramUserFeed above works and
 * is kept, but it is ACCOUNT-scoped: there was no logged-out shortcode form of the v1 serializer, so
 * it asks for the account's recent posts and picks ours out. Instagram serves exactly 12 items
 * whatever `count` requests (measured at 33 and 50, both 12), so a blocked reel further back stayed a
 * still — reported 2026-08-02 on /reel/DX7byl-oyGR/, roughly 60 posts deep, which InstaFix-derived
 * services played and we drew as a photo. Paging to it took five requests and 2.45 MB.
 *
 * This endpoint dissolves that problem rather than widening it: addressed by the POST, there is no
 * window to fall outside and an ancient blocked reel costs exactly what a fresh one does.
 *
 * MEASURED, with Node's fetch() rather than curl, cookie-free and token-free, on that exact reel:
 * HTTP 200, 21,648 bytes, 429ms, `video_versions` present, and no `copyright_blocked` key anywhere in
 * the payload — the same absence that makes the user feed work, because this is a different ADDRESS
 * onto that serializer, not a different format. recoveredMediaFrom reads both envelopes for exactly
 * that reason.
 *
 * NOT curl, DELIBERATELY, AND THAT IS THE WHOLE POINT OF SAYING SO. The sibling endpoint above
 * carries a long note about a probe that measured perfectly by hand and was refused the moment the
 * shipped client called it, because fetch() stamps sec-fetch headers curl never sends. So this was
 * verified with the client shape that will actually run.
 *
 * `lsd` ONLY HAS TO BE SELF-CONSISTENT. It is Meta's CSRF-ish token; the body value and the X-FB-LSD
 * header must match each other, and a freshly random one is accepted — no session, no cookie jar, no
 * prior page load to scrape it from. Verified with random bytes.
 *
 * THE doc_id ROTS, and that is a known, accepted cost rather than an oversight. It is Env-overridable
 * (IG_GRAPHQL_DOC_ID) so a rotation is a config change. When it dies this returns null and the older
 * recoveries — the user feed, then the yt-dlp container — carry the card, so the failure is a quiet
 * loss of rendition quality and never a broken embed. That layering is why depending on a magic
 * number here is defensible at all.
 *
 * NOT EGRESS-CONFIRMED, and this caveat is sharper than usual: the OTHER media-scoped anonymous
 * surface, `i.instagram.com/api/v1/media/{id}/info/`, already answers login_required from our egress
 * today (see fetchInstagramUserFeed). A media-scoped Instagram endpoint being refused specifically
 * from Cloudflare is the documented pattern here, not a hypothetical. Every failure lands on the
 * existing chain, so the residential evidence bounds the UPSIDE — the win may be zero from Workers —
 * rather than the downside.
 */
const IG_GRAPHQL_DOC_ID = '27128499623469141'

export async function fetchInstagramGraphQLMedia(
  code: unknown, docId?: string,
): Promise<string | null> {
  // Same shape check the embed path applies, and for the same reason: this reaches a url.
  if (typeof code !== 'string' || !SHORTCODE.test(code)) return null
  try {
    const lsd = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    const body = new URLSearchParams({
      doc_id: (typeof docId === 'string' && /^\d{6,32}$/.test(docId)) ? docId : IG_GRAPHQL_DOC_ID,
      lsd,
      server_timestamps: 'true',
      variables: JSON.stringify({
        shortcode: code,
        __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
      }),
    })
    const res = await fetch('https://www.instagram.com/graphql/query/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0',
        'x-fb-friendly-name': 'PolarisPostRootQuery',
        'x-fb-lsd': lsd,
      },
      body,
    })
    if (!res.ok) return null
    const text = await res.text()
    /**
     * ASSERT ON CONTENT, NOT ON STATUS. This surface answers HTTP 200 with a refusal body — the
     * sibling endpoint's "SecFetch Policy violation." at 200 is the standing example — so a 200 is
     * not evidence of anything. The only acceptable answer carries the documented root; anything
     * else is a refusal, a decoy or a rotated doc_id, and all three mean "no recovery".
     */
    return text.includes('xdt_api__v1__media__shortcode__web_info') ? text : null
  } catch {
    return null
  }
}
