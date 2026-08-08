import type { Media, Post, PostRef } from '../../types.ts'

/**
 * Pure: a TikTok post PAGE (HTML) -> Post. No I/O; every test against it runs on real
 * captured bytes with no network. The extraction lives here rather than in fetch.ts
 * because finding the blob and walking it is exactly where a platform change breaks us
 * first, and that is the part worth testing against real captures.
 *
 * THE UA GATE IS INVERTED FROM INSTAGRAM — this matters to whoever fetched the HTML we
 * are handed. TikTok answers a CRAWLER UA (facebookexternalhit / Discordbot / Twitterbot)
 * with a ~7KB decoy at HTTP 200 that has no caption and no playAddr, and answers a plain
 * Chrome UA (or no UA at all) with the real payload. Instagram is the exact opposite. The
 * project's Instagram notes read almost identically and say the reverse; do not conflate
 * them. Reproduced from Cloudflare Workers egress 2026-07-19, not just residentially.
 */

type Any = Record<string, any>

/**
 * The rehydration blob. `SIGI_STATE` IS GONE — do not look for it, and do not add it as a
 * fallback: an empty fallback branch reads as "we still support the old shape" and would
 * hide the day this one is renamed (which is the single most likely way this platform dies).
 *
 * Non-greedy to the FIRST `</script>` on purpose. TikTok emits `<` inside the JSON as the
 * six-character escape backslash-u-0-0-3-c, so a literal `</script>` cannot appear inside a
 * well-formed blob — but a greedy match on a page carrying any later script tag would swallow it
 * and fail to parse. (Spelled out in words because writing the escape itself into this comment
 * once made the sentence tautological: the reader saw the decoded character and learned nothing.)
 *
 * THE ATTRIBUTE SCAN IS BOUNDED, and the bound is load-bearing rather than tidiness. Unbounded
 * `[^>]*` is quadratic in input length: once the 46-char literal matches, the scan runs to the
 * next '>' or to end-of-string, so a body carrying many copies of the literal and no '>' rescans
 * from every start position. Measured on the unbounded pattern: 300 KB -> 2.0s, 1 MB -> 23s of
 * Worker CPU against Cloudflare's 30s ceiling — a self-inflicted 500 on a body only ~3x the size
 * of a real TikTok page (the video capture is 287 KB). Bounded, the same 1 MB input takes ~22ms.
 * The real tag's attributes are 23 characters (` type="application/json"`), so 200 is slack.
 */
const BLOB = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]{0,200}>([\s\S]*?)<\/script>/

/** TikTok usernames are [A-Za-z0-9._], max 24. See handleOf() for why this is enforced. */
const HANDLE = /^[\w.]{1,24}$/

/**
 * A usable number, or ABSENT. Never NaN and never a string. The generic coercion — see count()
 * for the tighter rule that `Post.counts` needs and dim()/duration deliberately do not.
 *
 * `stats` IS MIXED-TYPED, measured on live payloads: `diggCount: 21000` sits beside
 * `collectCount: '3000'` in the same object. So NEVER type-guard on `typeof v === 'number'`
 * — that is the natural defensive write in this repo (it is what Bluesky's build() does) and
 * here it drops real counts. Coerce, then reject what did not coerce.
 *
 * The exclusions are the values `Number()` silently turns into 0: `Number(null)`, `Number('')`,
 * `Number([])` and `Number(' ')` are ALL 0, which would invent a count of zero out of an absent
 * field. Booleans are excluded because `Number(true)` is 1 and a boolean count is nonsense.
 *
 * WHITESPACE IS IN THAT LIST AND WAS ONCE MISSING FROM IT. The comment used to claim it covered
 * "the values Number() turns into 0" while `' '`, `'\n'` and `'\t'` all coerced to 0 and shipped
 * — the exact failure the sentence promised to prevent. Trim before deciding, so any all-blank
 * string is treated as the empty string it effectively is.
 */
function num(v: unknown): number | undefined {
  if (v === null || typeof v === 'object' || typeof v === 'boolean') return undefined
  if (typeof v === 'string' && v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * A COUNT specifically: a non-negative integer, or absent.
 *
 * Separate from `num()` because the tighter rule is wrong for the other callers — `dim()` rounds
 * its own pixels, and a video `duration` may legitimately be fractional. A count cannot: it is a
 * cardinality, and `-5` likes or `1.9` comments are upstream nonsense that a renderer would print
 * as fact. Absent is the safe degrade this whole module is built on, so drop rather than clamp —
 * a clamped value is indistinguishable from a real one at the point it is displayed.
 */
function count(v: unknown): number | undefined {
  const n = num(v)
  return n !== undefined && n >= 0 && Number.isInteger(n) ? n : undefined
}

/** A pixel dimension, or 0 for "unknown" — the same convention Bluesky's normalizer uses. */
function dim(v: unknown): number {
  const n = num(v)
  return n !== undefined && n > 0 ? Math.round(n) : 0
}

/**
 * An https URL, or null. The prefix check is not decoration: these strings end up in og:image
 * and og:video, and a protocol-relative ('//host/x') or http URL there is a mixed-content hole
 * we would be authoring ourselves.
 */
function httpsUrl(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('https://') ? v : null
}

/**
 * The author handle, or null when it cannot be trusted as a URL path segment.
 *
 * This value comes from an upstream payload and gets interpolated into `canonical`, which
 * worker.ts hands to redirect() — i.e. into a `location` header, where a raw CR/LF/NUL or an
 * astral codepoint makes `new Headers()` throw (the HTTP 500 fixed in 4655ee8 for the router's
 * side of the same hazard). Rejecting outright rather than escaping is the better degrade here
 * because the fallback is genuinely good: tiktok.com/@i/video/{id} resolves without any
 * username at all, so a rejected handle costs a working link, not a mangled one.
 */
function handleOf(item: Any): string | null {
  const u = item?.author?.uniqueId
  return typeof u === 'string' && HANDLE.test(u) ? u : null
}

/**
 * A photo SLIDESHOW's images.
 *
 * Shape read off a live capture (@duolingo 7663591047909379341), not ported from upstream on
 * faith: `imagePost.images[] = { imageURL: { urlList: [...] }, imageWidth, imageHeight }`.
 *
 * One Media per picture, mirrors collapsed by firstHttps() — see there for why that matters.
 * Entries that are not https are skipped rather than emitted, so an image we cannot vouch for
 * never becomes an og:image. Never returns an empty array when any cover is reachable.
 */
function slideshowMedia(item: Any): Media[] {
  const out: Media[] = []
  const imgs = item?.imagePost?.images
  if (Array.isArray(imgs)) {
    for (const im of imgs) {
      const url = firstHttps(im?.imageURL?.urlList)
      if (!url) continue
      // Dimensions come from imageWidth/imageHeight and NOT from video.width/height: a slideshow
      // carries a `video` object whose width and height are literal 0.
      out.push({ kind: 'image', url, w: dim(im?.imageWidth), h: dim(im?.imageHeight) })
    }
  }
  if (out.length) return out

  /**
   * DEGRADE TO A STILL — the same rule videoMedia() follows, and for the same reason.
   *
   * Reaching here means `imagePost` existed but yielded nothing usable: `images` renamed or
   * missing, an empty gallery, or every mirror on a non-https URL. That is the platform-drift
   * shape, and it is the single most likely way this branch dies. Without a fallback the post
   * goes media-less — while BOTH covers are sitting in the payload, verified on the capture
   * (`imagePost.cover` and `video.cover` are each present on a real slideshow).
   *
   * ALWAYS `kind: 'image'`, never a video entry, even though the value comes off the `video`
   * object: this is a photo post, and an og:video on it would render a dead player and suppress
   * og:image (Phase 1's I-1 lesson).
   */
  const cover =
    firstHttps(item?.imagePost?.cover?.imageURL?.urlList) ??
    firstHttps(item?.imagePost?.shareCover?.imageURL?.urlList) ??
    httpsUrl(item?.video?.cover) ??
    httpsUrl(item?.video?.originCover)
  return cover ? [{ kind: 'image', url: cover, w: 0, h: 0 }] : []
}

/**
 * The first usable https entry of a `urlList`, or null.
 *
 * `urlList` is a MIRROR list — the same object on p16- and p19- hosts, verified identical
 * pathnames on the capture — not distinct pictures. Taking the FIRST usable entry is therefore
 * correct; pushing all of them would double every gallery, and because the mirrors differ in host
 * and signature a downstream dedupe-by-URL would not catch it either.
 */
function firstHttps(list: unknown): string | null {
  if (!Array.isArray(list)) return null
  return list.map(httpsUrl).find((u: string | null) => u !== null) ?? null
}

/**
 * The cookie-free play endpoint's path, which is both how videoMedia SELECTS a url and how
 * fetch.ts RECOGNISES one it should resolve. ONE spelling, for the reason videoDetailScope gives
 * about its own extraction: two spellings is two things to keep in step when TikTok renames
 * something, and a fetcher that stopped recognising the url it was handed would silently go back
 * to emitting two redirect hops — the exact bug the resolution exists to fix, and one that is
 * invisible from the outside because the embed still works, just with the wrong card.
 */
export const AWEME_PLAY = '/aweme/v1/play/'

/**
 * A video post's single Media entry.
 *
 * THE URL IS THE `/aweme/v1/play/` ONE, SELECTED BY SUBSTRING AND NEVER BY INDEX.
 *
 * `video.playAddr` and every `*-webapp-prime.*` host are cookie-gated — the query literally
 * names its own gate, `tk=tt_chain_token` — and 403 without a cookie, which is exactly what
 * Discord's media proxy sends. The aweme endpoint content-negotiates on cookies instead:
 * cookie-free it 302s to a working `tiktokcdn-us` host (verified 200, video/mp4, 12,550,214
 * bytes, `ftyp` at bytes 4-8). It is also deterministic across sessions — two independent page
 * fetches produced byte-identical aweme URLs while playAddr differed every time, and its
 * signaturev3 decodes to stable ids with no timestamp — so it is safe to cache for the full
 * Post TTL. Upstream okdargy/fxTikTok selects it by substring too (src/generate.ts:63, with the
 * cookie behaviour noted at src/generate.ts:91-92); index position is not guaranteed stable.
 *
 * THAT VERIFICATION NO LONGER HOLDS FOR **OUR** EGRESS, measured 2026-08-08 from Cloudflare with
 * `wrangler dev --remote`, on three unrelated videos including one whose card was rendering fine
 * in Discord at the time:
 *
 *   aweme url, Discordbot UA   200, 33,227 bytes, text/html -> www.tiktok.com/404?fromUrl=...
 *   aweme url, browser UA      200, 33,227 bytes, text/html -> the same 404 page
 *   v19-webapp-prime url       403
 *   aweme url, RESIDENTIAL     200, 6,028,413 bytes, video/mp4
 *
 * Byte-identical 404s across videos and user agents, so it is the EGRESS and not the post, not the
 * UA, and not a per-video signature expiring.
 *
 * IT DOES NOT MEAN TIKTOK VIDEO IS BROKEN, which is the tempting and wrong conclusion — one of the
 * videos measured above was playing in Discord while its aweme url answered this egress with the 404
 * page. Discord's media proxy is not Cloudflare, and TikTok evidently does not refuse it. Redirecting
 * Discord at the aweme url therefore still works, and that is what this function keeps doing.
 *
 * WHAT IT RULES OUT is anything where WE fetch the bytes: proxying /_media/ through the Worker
 * instead of redirecting, or handing the url to the mux container. Both look like obvious upgrades —
 * they are what every other platform here does — and both would fetch from this same egress and get
 * 33 KB of HTML where a card expects an mp4. Measure before building either.
 *
 * NO aweme URL degrades to the still cover, NEVER to a gated URL. That is Phase 1's I-1 lesson
 * restated: an og:video pointing at something that cannot play renders a DEAD player AND
 * suppresses og:image, so the post shows nothing at all. A still is strictly better.
 */
function videoMedia(item: Any): Media[] {
  const v = item?.video
  const bitrate = Array.isArray(v?.bitrateInfo) ? v.bitrateInfo : []
  const urls: unknown[] = [
    v?.playAddr,
    ...bitrate.flatMap((b: Any) => (Array.isArray(b?.PlayAddr?.UrlList) ? b.PlayAddr.UrlList : [])),
  ]
  const aweme = urls.map(httpsUrl).find((u): u is string => u !== null && u.includes(AWEME_PLAY))

  // ONE selection of "the still", used by both branches below — as the video's POSTER when there
  // is a playable url, and as the whole media entry when there is not. Hoisted out of the degrade
  // path deliberately: two spellings would let a video's poster and its fallback still drift into
  // being different pictures, and there is no reading of this payload where that is correct.
  //
  // originCover is the second-best still and is present when cover is not; dynamicCover is an
  // animated webp and is deliberately not used — Discord renders it as a static frame anyway.
  const cover = httpsUrl(v?.cover) ?? httpsUrl(v?.originCover)

  if (aweme) {
    const duration = num(v?.duration)
    const media: Media = { kind: 'video', url: aweme, w: dim(v?.width), h: dim(v?.height) }
    // Omitted entirely rather than set to undefined, so a Post is structurally the same
    // whether duration was absent upstream or merely unusable (mediaObj's rule in Bluesky).
    if (duration !== undefined && duration > 0) media.duration = duration
    // THE POSTER FRAME. Mastodon's preview_url on a video attachment is this picture, and
    // emitting the video url there instead is what cost us Discord's rich activity card — see
    // types.ts's Media.poster for the measurement. The cover was in this payload all along.
    //
    // VERIFIED LIVE 2026-07-19 on post 7662750461509782814: video.cover fetches with NO COOKIES
    // and no UA — the shape of Discord's media proxy request — and answers 200, image/jpeg,
    // 183,137 bytes, magic bytes ff d8 ff. That matters because the video url on this same post
    // is cookie-NEGOTIATED (see this function's docstring); the cover is not, so it needs no
    // resolution step of its own and is safe to cache for the full Post TTL alongside the rest.
    //
    // Omitted rather than set to undefined when there is no usable cover, same rule as duration.
    if (cover) media.poster = cover
    return [media]
  }

  // No playable url: the still becomes the media entry ITSELF, as a plain image. It needs no
  // poster of its own — an image is its own poster, which is exactly why the image path was
  // never touched by the preview_url bug.
  return cover ? [{ kind: 'image', url: cover, w: dim(v?.width), h: dim(v?.height) }] : []
}

/**
 * Does this itemStruct carry a playable video — i.e. is the video NOT withheld? Deliberately BROADER
 * than videoMedia's aweme selection: ANY https play url (playAddr or a bitrate `PlayAddr.UrlList`
 * entry) counts, because the question here is "is the video present at all", not "which cookie-free
 * variant do we hand Discord". An age-WITHHELD post carries no play url; a reachable one always does.
 * Used only by the age-gate predicate below, so a content-classified post that still has a video
 * degrades to RENDERING it rather than a false gate.
 */
function hasPlayableVideo(item: Any): boolean {
  const v = item?.video
  if (!v || typeof v !== 'object') return false
  const bitrate = Array.isArray(v.bitrateInfo) ? v.bitrateInfo : []
  const urls: unknown[] = [
    v.playAddr,
    ...bitrate.flatMap((b: Any) => (Array.isArray(b?.PlayAddr?.UrlList) ? b.PlayAddr.UrlList : [])),
  ]
  return urls.some(u => typeof u === 'string' && u.startsWith('https://'))
}

/**
 * THE AGE TELL — `isContentClassified` present-and-TRUE AND no playable video. Shared by tiktokGate
 * (which reports the gate) and normalizeTikTok (which refuses to build a media-less Post for it).
 *
 * PARSER-CONFIRMED, EGRESS-UNCONFIRMED (see tiktokGate). A NORMAL post NEVER carries
 * isContentClassified, so present-and-true is the tell — checked with `=== true`, not merely truthy,
 * so a `false`/absent/string value is not a gate. The `!hasPlayableVideo` guard is what makes this a
 * NO-REGRESSION addition: a content-classified post that still has a video is NOT gated and renders.
 */
function isAgeGated(item: Any): boolean {
  return !!item && typeof item === 'object' && item.isContentClassified === true && !hasPlayableVideo(item)
}

/**
 * The `webapp.video-detail` scope object, or null. THE ONE SPELLING OF THIS EXTRACTION.
 *
 * Exported because fetch.ts's page assertion needs the same question answered — "is this a POST
 * page at all" — and the alternative was a second regex and a second JSON.parse over there. Two
 * spellings of the extraction is two things to keep in step when TikTok renames something, and
 * this module's whole premise is that the extraction is where a platform change breaks us first.
 *
 * THE SCOPE'S PRESENCE IS THE DISCRIMINATOR, AND IT IS NOT THE SAME QUESTION AS THE MARKER'S.
 * The TikTok HOMEPAGE carries a rehydration blob of its own — measured 2026-07-19, 257,666 bytes
 * of it, with scopes app-context / biz-context / i18n-translation / seo.abtest / a-b and NO
 * video-detail. Every failed short code, and any geo-bounce or edge interstitial that lands on
 * the generic shell, looks exactly like a real page to a marker test. This function is what
 * separates them.
 *
 * Null for a non-object (and for an array, which `typeof` calls an object): callers read
 * `.statusCode` and `.itemInfo` off it, and a scope that is a string or a list is drift, not data.
 */
export function videoDetailScope(html: unknown): Record<string, any> | null {
  const scope: unknown = rehydrationScopes(html)?.['webapp.video-detail']
  return scope !== null && typeof scope === 'object' && !Array.isArray(scope) ? (scope as Any) : null
}

/**
 * "THE PAGE ARRIVED, WHOLE." The blob, found and PARSED — its `__DEFAULT_SCOPE__` object — or
 * null. Says nothing about which page it is; videoDetailScope above answers that.
 *
 * SPLIT OUT OF videoDetailScope BECAUSE COLLAPSING THE TWO THREW AWAY A DISCRIMINATOR WE HAVE.
 * There are three distinguishable states in a short-link response and the caller must tell them
 * apart, because they mean opposite things about who is broken:
 *
 *   blob absent, or present and UNPARSEABLE  -> the response did not arrive (a 429 shell, an
 *                                               interstitial, a TRUNCATED body). WE are broken.
 *   parsed, no webapp.video-detail scope     -> the TikTok HOMEPAGE, where every non-TikTok short
 *                                               code lands. The resolver WORKING. Not TikTok.
 *   parsed, scope present                    -> a TikTok post page; statusCode decides the rest.
 *
 * Truncation is the case that motivated the split and it is not hypothetical: the marker sits in
 * the first 60 bytes of the document, so it survives any truncation, while BLOB needs the closing
 * `</script>` the truncation removed. Measured on the 286KB capture — cut to 50%, 90% and 99%,
 * the marker is present every time and the blob matches none of them. Folded together with the
 * homepage, a truncated response silently became "that code is not TikTok" and the chooser, with
 * assert_fail left at zero for the failure it exists to name.
 */
export function rehydrationScopes(html: unknown): Record<string, any> | null {
  if (typeof html !== 'string') return null
  const m = html.match(BLOB)
  // No blob, or a blob whose closing tag never arrived. Either way there is nothing to parse.
  if (!m) return null
  let scopes: unknown
  try {
    scopes = (JSON.parse(m[1]) as Any)?.__DEFAULT_SCOPE__
  } catch {
    // Not JSON, or truncated mid-object with a later `</script>` closing the match. A page we
    // cannot parse is not a page with a missing post — it is a response that failed to arrive,
    // which is why fetch.ts counts this case as assert_fail on both paths.
    return null
  }
  return scopes !== null && typeof scopes === 'object' && !Array.isArray(scopes) ? (scopes as Any) : null
}

/** Real ids are 19 digits. The bound is hygiene, not a measurement — see tiktokRefFrom. */
const ID = /^\d{1,32}$/

/**
 * The canonical {p:'tt', id} a page payload names, or null.
 *
 * Short-link resolution needs this BEFORE it can build a Post: the /t/{code} route knows a code,
 * not an id. The id comes from `itemStruct.id` and NEVER from the resolved URL — that URL carries
 * a `?_r=1&_t=…` session tail (measured 2026-07-18), and parsing an id back out of a URL would be
 * a second, driftable spelling of the router.
 *
 * Returning null is the "this is not a TikTok post" answer, and it is load-bearing: a dead code
 * and a real THREADS code both land on the TikTok HOMEPAGE, which carries a rehydration blob of
 * its own (measured 2026-07-19: 257,666 bytes). The marker's presence proves nothing; the
 * `webapp.video-detail` scope is the discriminator and statusCode === 0 is the second half of it.
 * It therefore goes through videoDetailScope() — the ONE spelling of that extraction — rather
 * than parsing the blob a second time here.
 *
 * A STRING OF DIGITS, AND THE STRING PART IS NOT PEDANTRY. A real id (7660566211100511518) is
 * larger than Number.MAX_SAFE_INTEGER, so had TikTok emitted it as a bare JSON number, JSON.parse
 * would have handed us 7660566211100511500 — a well-formed id for a post that does not exist,
 * which would mint a wrong canonical, a wrong cache key and a wrong /_media/ namespace, silently.
 * Accepting a number here to be "tolerant of mixed types" (fact 9 makes that tempting, and it is
 * the right instinct for `stats`) would be accepting a corrupted value. Reject instead.
 */
export function tiktokRefFrom(html: unknown): Extract<PostRef, { p: 'tt' }> | null {
  const scope = videoDetailScope(html)
  if (!scope) return null
  // Same fail-closed statusCode rule as normalizeTikTok below, and '0' is accepted beside 0 for
  // the same reason: this payload is demonstrably untrustworthy per-key about number-vs-string.
  if (scope.statusCode !== 0 && scope.statusCode !== '0') return null
  const id: unknown = scope?.itemInfo?.itemStruct?.id
  return typeof id === 'string' && ID.test(id) ? { p: 'tt', id } : null
}

/**
 * The GATE a TikTok page names — 'age_restricted' (owner: 🔞) or 'private' (🔒) — or undefined for no
 * gate. Pure; returns the analytics/FetchReport vocabulary ('age_restricted' | 'private'), which the
 * post route maps to render's 'age' | 'private'. Threaded exactly like Twitter's fetch reason.
 *
 * PARSER-CONFIRMED BUT EGRESS-UNCONFIRMED, AND SELF-CORRECTING. The signals are corroborated by
 * yt-dlp + tt-bot + gallery-dl parsing the SAME `webapp.video-detail` scope we parse — but they are
 * NOT self-captured live and NOT confirmed from Cloudflare Workers egress (this project has been
 * bitten by TikTok answering datacenter IPs differently). So this MUST be a no-regression addition: if
 * a signal is absent the branch simply does not fire and the caller falls through to today's generic
 * behavior. It gates ONLY on the specific status codes / the isContentClassified field — NEVER a broad
 * condition — so a false positive on a NORMAL post (statusCode 0, a real itemStruct, isContentClassified
 * absent, a playable video) is impossible.
 *
 *   statusCode 10216 (private post) / 10222 (private account)      -> 'private'
 *   statusMsg 'status_friend_see' (friends-only; statusCode 10204) -> 'private'
 *   isContentClassified === true AND no playable video            -> 'age_restricted' (statusCode may be 0)
 *   statusCode 10204 + statusMsg "item doesn't exist" & all else  -> undefined (generic failure, UNCHANGED)
 *
 * THE 10204 CONFOUND, and why private cannot key on the number alone. statusCode 10204 is SHARED: a
 * genuinely deleted post returns 10204 / "item doesn't exist" (tiktok-deleted.html) while a FRIENDS-ONLY
 * post returns 10204 / "status_friend_see" (captured live 2026-07-21 from a public account's
 * friends-only post — its ENTIRE webapp.video-detail scope is {statusCode:10204, statusMsg:'status_friend_see'},
 * no itemStruct, no author, nothing personal). So the number is worthless as a discriminator and the
 * statusMsg string is the tell. Keying private on that string is positive and no-regression: it fires on
 * friends-only and nothing else, where a `=== 10204` private branch would have swept in every deleted
 * post. Other privacy statusMsgs (e.g. a self-only 'status_self_see') are deliberately left OUT until
 * captured live, per this function's self-correcting discipline — an absent signal falls through to
 * today's generic behavior, never a wrong gate.
 *
 * Status codes are accepted as number OR string — this payload is demonstrably untrustworthy per-key
 * about number-vs-string (see num() and the tiktokRefFrom/normalizeTikTok statusCode notes).
 */
export function tiktokGate(html: unknown): 'age_restricted' | 'private' | undefined {
  const scope = videoDetailScope(html)
  if (!scope) return undefined
  const status = scope.statusCode
  if (status === 10216 || status === '10216' || status === 10222 || status === '10222') return 'private'
  // Friends-only: 10204 is shared with a deleted post, so the discriminator is statusMsg, not the code.
  if (scope.statusMsg === 'status_friend_see') return 'private'
  if (isAgeGated(scope?.itemInfo?.itemStruct)) return 'age_restricted'
  return undefined
}

/**
 * Pure: TikTok post-page HTML -> Post. Returns null rather than inventing a Post — a half-built
 * Post renders as a broken embed, and the null routes into the existing fetch_fail error path.
 *
 * Total by construction: `html` is whatever the fetcher got (or nothing), so every read is
 * defensive and the JSON.parse is inside a try.
 */
export function normalizeTikTok(html: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'tt') return null

  const scope = videoDetailScope(html)
  if (!scope) return null

  /**
   * STATUS CODE, NOT HTTP STATUS. A DELETED post returns HTTP 200 with a full ~287KB page and
   * a structurally VALID blob carrying `statusCode: 10204`, `statusMsg: "item doesn't exist"`
   * and no itemStruct. Asserting on the response status would accept every one of them.
   *
   * An ABSENT scope never reaches this line — videoDetailScope() above already returned null for
   * it, which is the same answer one step earlier. That is deliberate, not redundant: scope-absence
   * (the TikTok HOMEPAGE, where a dead short code lands, blob and all) means the PAGE is not a post
   * page, while a non-zero statusCode means the page IS one and the POST is gone. fetch.ts counts
   * those two differently, so they are decided in different places.
   *
   * '0' is accepted beside 0 because this payload is demonstrably untrustworthy per-key about
   * number-vs-string (see num()). Anything else — including null and undefined — fails closed.
   */
  const status = scope?.statusCode
  if (status !== 0 && status !== '0') return null

  const item: Any = scope?.itemInfo?.itemStruct
  if (!item || typeof item !== 'object') return null

  // AGE GATE — refuse to build a Post for a content-classified item whose video is withheld. Here
  // statusCode may be 0, so the normal build path below would otherwise emit a media-less (or
  // cover-only) embed instead of the honest 🔞 wall. Returning null lets liveFetchPost's tiktokGate
  // report the 'age' gate. isAgeGated is the ONE shared predicate (see tiktokGate for the
  // parser-confirmed / egress-unconfirmed caveat); a NORMAL post never carries isContentClassified,
  // and a classified post that DOES have a playable video is not gated and still renders.
  if (isAgeGated(item)) return null

  /**
   * `createTime` IS A DECIMAL STRING OF UNIX SECONDS ('1783614572'), not a number.
   * Coerce, then scale, then VALIDATE THE DATE. Three ways to get this wrong, all silent:
   *  - `typeof x === 'number' ? … : NaN` (Bluesky's shape) returns null for EVERY real post.
   *  - `new Date(seconds)` without *1000 lands every post in 1970.
   *  - validating the NUMBER instead of the DATE lets an Invalid Date escape into a Post.
   *
   * THAT THIRD ONE IS THE SHARP EDGE, because another module documents relying on it not
   * happening. `Number.isFinite(t)` is not sufficient: the ECMAScript Date range is +/-8.64e15
   * ms, so any createTime above ~8.64e12 seconds is finite and still yields an Invalid Date.
   * render/mastodon.ts calls `post.createdAt.toISOString()` bare, with a comment saying the
   * normalizer "rejects an unparseable date outright … so this needs no guard of its own", and
   * worker.ts calls toMastodonStatus on the 'activity' route with no try/catch — so the escape
   * lands as an uncaught RangeError 500. Bluesky's normalizer validates the Date it just built
   * (bluesky/normalize.ts:83-84); mirror that, and validate the thing being handed out.
   *
   * Coercion goes through num() rather than bare `Number()` so the absent/blank/boolean cases
   * this file already reasons about once are not re-litigated (and got a different answer) here:
   * bare `Number(true)` is 1, which made a boolean createTime a post dated 1970-01-01T00:00:01Z.
   */
  const t = num(item.createTime)
  if (t === undefined || t <= 0) return null
  const createdAt = new Date(t * 1000)
  if (Number.isNaN(createdAt.getTime())) return null

  // A NON-NULL imagePost OBJECT is the discriminator, not a guess about what media exist: a
  // slideshow also carries a `video` object (with zeroed width/height and a cover), so "did we
  // find a playable URL" would misclassify it as a degraded video post.
  //
  // NOT `'imagePost' in item`, which was the first spelling and is true for `imagePost: null`.
  // A single nullable field serialized as null on video posts would route EVERY video post down
  // the slideshow branch and strip its media — total loss on the commonest shape there is, from
  // an upstream change that adds no information at all.
  const isSlideshow = !!item.imagePost && typeof item.imagePost === 'object'

  const handle = handleOf(item)
  // tiktok.com/@i/video/{id} resolves without knowing the username (verified 2026-07-18), so
  // the degrade is a WORKING link rather than a plausible-looking dead one. new URL().href
  // re-applies the URL spec's percent-encode set, which keeps a hostile ref.id out of the
  // `location` header worker.ts builds from this — the crash class fixed in 4655ee8 for the
  // router's own canonicals. It is a byte-for-byte no-op on every URL we actually emit.
  const canonical = new URL(
    `https://www.tiktok.com/@${handle ?? 'i'}/${isSlideshow ? 'photo' : 'video'}/${ref.id}`,
  ).href

  const counts: Post['counts'] = {}
  const stats = item.stats
  // Assigned one key at a time so an unusable value leaves the key ABSENT. `counts: { likes:
  // num(x) }` would put `likes: undefined` in the object, and `NaN` is worse still — it
  // JSON-serializes to null, reaching mastodon.ts's payload as a null where a number belongs.
  const put = (k: keyof Post['counts'], v: unknown) => {
    const n = count(v)
    if (n !== undefined) counts[k] = n
  }
  put('likes', stats?.diggCount)
  put('views', stats?.playCount)
  put('replies', stats?.commentCount)
  put('reposts', stats?.shareCount)

  return {
    ref,
    canonical,
    author: {
      name: typeof item.author?.nickname === 'string' && item.author.nickname ? item.author.nickname : (handle ?? ''),
      handle: handle ?? '',
      // With no trustworthy handle there is no profile URL to build, so this points at the post
      // itself — a link that works — rather than at tiktok.com/@i, which names no profile.
      url: handle ? `https://www.tiktok.com/@${handle}` : canonical,
      avatar: httpsUrl(item.author?.avatarLarger) ?? httpsUrl(item.author?.avatarMedium) ?? httpsUrl(item.author?.avatarThumb) ?? undefined,
    },
    text: typeof item.desc === 'string' ? item.desc : '',
    createdAt,
    media: isSlideshow ? slideshowMedia(item) : videoMedia(item),
    counts,
    // TikTok exposes no per-post sensitivity signal at all (spec §Sensitivity). Always false —
    // never inferred from a warnInfo/takeDown field, which mean moderation state, not NSFW.
    sensitive: false,
  }
}
