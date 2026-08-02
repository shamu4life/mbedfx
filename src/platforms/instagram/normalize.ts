import type { Media, Post, PostRef } from '../../types.ts'
// PURE (no I/O, total over junk) — see its docstring for why the SSRF host rule is imported rather
// than spelled a third time here.
import { allowedHost } from '../../mediaproxy.ts'

/**
 * Pure: an Instagram EMBED page (HTML) -> Post. No I/O; every test against it runs on real
 * captured bytes with no network. The extraction lives here rather than in fetch.ts because
 * finding the blob and walking it is exactly where a platform change breaks us first, and that
 * is the part worth testing against real captures.
 *
 * THE UA GATE IS INVERTED FROM TIKTOK — this matters to whoever fetched the HTML we are handed.
 * Instagram answers a CRAWLER UA (facebookexternalhit / Discordbot / curl) with the REAL
 * server-rendered content, and answers a plain Chrome UA with a ~598KB empty JavaScript shell at
 * HTTP 200. TikTok is the exact opposite: a crawler UA there gets a ~7KB decoy and Chrome gets
 * the real page. src/platforms/tiktok/normalize.ts opens with the mirror image of this paragraph.
 * Both are true, about different platforms; do not conflate them and do not "fix" either one to
 * match the other. Measured 2026-07-19 on four UAs.
 *
 * TWO PAYLOAD SHAPES, AND THE PLAN ONLY KNEW ABOUT ONE. Measured 2026-07-19 across eleven live
 * posts, three accounts and four crawler UAs:
 *
 *   post is a VIDEO or a CAROUSEL -> the whole GraphQL `shortcode_media` object is embedded
 *   post is a SINGLE IMAGE        -> `contextJSON` is the literal null; there is NO object,
 *                                    and the post is SERVER-RENDERED into the markup instead
 *
 * Instagram's own init flags say it outright in the document: single images arrive with
 * {"isRichEmbed":false,"isSidecar":false,…,"contextJSON":null}. Single images are plausibly the
 * commonest Instagram post there is, so a normalizer built on the object alone returns null —
 * fetch_fail — for most of the platform, while looking perfectly healthy against a reel and a
 * carousel. Hence two paths, blob first, markup second.
 */

type Any = Record<string, any>

/** Instagram usernames are [A-Za-z0-9._], max 30. See authorOf() for why this is enforced. */
const HANDLE = /^[\w.]{1,30}$/

/**
 * A shortcode we are willing to interpolate into a URL. Deliberately WIDER than the router's own
 * rule (this accepts one character) because the ref may arrive from the CACHE unvalidated and the
 * job here is only to exclude what breaks a header — CR, LF, NUL, spaces and slashes. canonical
 * lands in worker.ts's `location`, where a raw CR/LF makes new Headers() throw (the HTTP 500
 * fixed in 4655ee8 for the router's side of the same hazard).
 */
const CODE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * A media id whose DECODE we are willing to publish as a date. See createdAtFromId for the
 * mechanism; this is the width, and the width is the whole guard.
 *
 * WHY 18-19 AND NOT "SOME DIGITS". The id is a shifted timestamp, so its WIDTH is its era, and
 * the low range is not merely imprecise — it is degenerate. Everything below 2^23 shifts to zero
 * and decodes to the epoch instant itself, and the whole sub-18-digit range lands within weeks
 * of it:
 *
 *   6 digits -> 2011-08-24T21:07:01.721Z   17 digits -> 2011-09-10
 *   7 digits -> 2011-08-24T21:07:01.721Z   18 digits -> 2012-01-09  (the floor below)
 *  11 digits -> 2011-08-24T21:07:01.723Z   19 digits -> 2015-06-04 onward, i.e. every real post
 *
 * The previous rule was /^[1-9]\d{5,23}$/, which admitted all of that: a six-digit id passed the
 * shape test and produced a confident 2011-08-24 — the exact fabricated date this guard's own
 * comment claimed to prevent. Only the leading [1-9] was doing any work, and it caught the literal
 * '0' alone.
 *
 * The floor is 18 rather than 19 on purpose: 19 digits begins at 2015-06-04, so requiring it would
 * return null — fetch_fail, a broken embed — for every genuine post older than that, rather than
 * merely mis-dating one. 18 reaches back to 2012-01-09, which is past the degenerate cluster and
 * past Instagram's own 2010 launch, so a real pre-2015 post still resolves.
 */
const MEDIA_ID = /^[1-9]\d{17,18}$/

/**
 * A usable number, or ABSENT. Never NaN and never a string.
 *
 * Copied from TikTok's normalizer rather than re-derived: it carries three separate measured
 * scars (mixed number/string typing, the values Number() silently turns into 0, and whitespace
 * strings, which the comment once claimed to cover while they coerced to 0 and shipped).
 * Instagram's payload is better typed than TikTok's, but the counts still come off an untrusted
 * upstream and the cost of the tolerant version is nil.
 */
function num(v: unknown): number | undefined {
  if (v === null || typeof v === 'object' || typeof v === 'boolean') return undefined
  if (typeof v === 'string' && v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * A COUNT specifically: a non-negative integer, or absent. Separate from num() because the tighter
 * rule is wrong for the other callers — dim() rounds its own pixels and video_duration is
 * legitimately fractional here (75.492 on the reel fixture). A count cannot be: it is a
 * cardinality, and -5 likes or 1.9 comments are upstream nonsense a renderer would print as fact.
 */
function count(v: unknown): number | undefined {
  const n = num(v)
  return n !== undefined && n >= 0 && Number.isInteger(n) ? n : undefined
}

/** A pixel dimension, or 0 for "unknown" — the convention both existing normalizers use. */
function dim(v: unknown): number {
  const n = num(v)
  return n !== undefined && n > 0 ? Math.round(n) : 0
}

/**
 * An https URL with no control characters in it, or null.
 *
 * The prefix check is not decoration: these strings end up in og:image and og:video, and a
 * protocol-relative ('//host/x') or http URL there is a mixed-content hole we would be authoring
 * ourselves.
 *
 * THE CONTROL-CHARACTER HALF IS WHY THIS IS NOT A COPY OF TIKTOK'S. Everything that survives here
 * becomes a `Media.url`, `Media.poster` or `author.avatar`, and worker.ts's /_media/ branch puts
 * exactly those into a `location` header with no try/catch — where a raw CR/LF makes new Headers()
 * throw, an uncaught HTTP 500 on a public path. That is the crash class 4655ee8 fixed for the
 * router's canonicals and the reason CODE below excludes the same bytes.
 *
 * A prefix test alone left the rest of the string unexamined, and this normalizer is the only one
 * that can MANUFACTURE such a byte: TikTok and Bluesky read their urls out of JSON, while the
 * markup path here runs unentityUrl over an HTML attribute, so `&#13;&#10;` in an img src becomes
 * a real CR/LF. Rejecting outright rather than stripping: a url containing a control character is
 * not a url we mis-copied, it is one we do not understand.
 */
const CTRL = /[\u0000-\u001f\u007f]/
function httpsUrl(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('https://') && !CTRL.test(v) ? v : null
}

/**
 * THE POST'S TIMESTAMP, DERIVED FROM ITS MEDIA ID — because the embed carries no timestamp field.
 *
 * The plan specifies `taken_at_timestamp` in Unix seconds. THAT FIELD DOES NOT EXIST on this
 * endpoint. The reel blob's keys, in full, are: __typename, accessibility_caption,
 * clips_music_attribution_info, dimensions, display_resources, display_url, edge_liked_by,
 * edge_media_to_caption, edge_media_to_comment, id, is_video, owner, product_type, shortcode,
 * thumbnail_resources, thumbnail_src, video_duration, video_url, video_view_count. No date of any
 * kind, and the server-rendered markup has none either — no <time>, no datetime attribute.
 *
 * Instagram media ids are Snowflake-shaped: (unix_ms - 1314220021721) << 23, with the low 23 bits
 * carrying shard and sequence. Confirmed 2026-07-19 against six posts whose dates are known from
 * outside the payload (five search-result titles giving the calendar day, plus a #WorldOceansDay
 * caption on a post this decodes to 8 June) — 6/6 exact on the day.
 *
 * `Post.createdAt` is not optional and a renderer will print whatever it is given, so the only
 * alternative to deriving it was fabricating one. Rejecting on the id's WIDTH is what makes that
 * safe, and it is a strictly stronger test than "is the Date valid": a right shift is
 * non-negative, so EVERY id decodes to a well-formed Date at or after the 2011 epoch, and the
 * Bluesky/TikTok rule of validating the Date you are handing out cannot see a single one of the
 * bad cases. MEDIA_ID carries the measurements and the reasoning.
 *
 * BigInt, not Number: a real id (3943405578951853695) is far above Number.MAX_SAFE_INTEGER, so
 * shifting it as a float would silently lose the low bits and, worse, invite the same class of
 * corruption TikTok's normalizer documents for ids parsed out of JSON as bare numbers.
 */
const IG_EPOCH_MS = 1314220021721
function createdAtFromId(id: unknown): Date | null {
  if (typeof id !== 'string' || !MEDIA_ID.test(id)) return null
  let ms: number
  try {
    ms = Number(BigInt(id) >> 23n) + IG_EPOCH_MS
  } catch {
    return null
  }
  const d = new Date(ms)
  // Validate the DATE, not the number: the ECMAScript Date range is +/-8.64e15 ms, so a large
  // finite value is still an Invalid Date. render/mastodon.ts calls post.createdAt.toISOString()
  // bare, and worker.ts calls toMastodonStatus on the 'activity' route with no try/catch, so an
  // escaped Invalid Date lands as an uncaught RangeError 500.
  if (Number.isNaN(d.getTime())) return null
  // BOTH BOUNDS ARE UNREACHABLE WHILE MEDIA_ID STAYS AT 18-19 DIGITS — that width admits exactly
  // 2012-01-09 to 2049, so neither this nor the NaN check above can fire, and the honest
  // description is belt to that regex's braces rather than a second independent guard. They are
  // here because the width rule is the kind of thing a future reader loosens ("surely a 17-digit
  // id is fine"), and this is what stops a loosened one from publishing an epoch-instant 2011 date
  // or an id from a different id space entirely. Do not read them as the mechanism; MEDIA_ID is.
  const y = d.getUTCFullYear()
  return y >= 2010 && y <= 2100 ? d : null
}

/**
 * THE ESCAPING, AND IT IS PARSE-TWICE RATHER THAN UNESCAPE-THEN-PARSE.
 *
 * Transcribed one character at a time from a live capture, the document carries:
 *
 *   "contextJSON":"{\"context\":{\"type\":\"GraphVideo\",…},\"gql_data\":{\"shortcode_media\":{…
 *
 * So the GraphQL object is not embedded as JSON — it is embedded as a JSON *string* whose
 * contents are themselves JSON, inside an ordinary JSON object in a script. The correct read is
 * therefore JSON.parse the string literal (which undoes exactly one level of escaping, including
 * the \\/ slashes and the \\uXXXX in captions), then JSON.parse the result. Hand-rolling the
 * unescape would get the depth wrong in at least three places and would have to be kept in step
 * with whatever Instagram's serializer does next.
 *
 * THE SCAN IS A LINEAR LOOP AND NOT A REGEX, and that is the point rather than a style choice.
 * TikTok's normalizer carries the measurement: an unbounded `[^>]*` attribute scan is quadratic
 * and took 23 SECONDS of Worker CPU on 1MB against Cloudflare's 30s ceiling. Here the
 * pathological input is not hypothetical — Instagram serves a 598KB shell to the wrong UA on
 * purpose, and any caller can provoke it. A character loop that only ever moves forward cannot
 * backtrack, so it is O(n) by construction; MAX is a second belt on top of that, sized well above
 * any real payload (the largest live capture's whole document is 214KB).
 */
const CONTEXT_JSON = '"contextJSON":"'
const MAX_BLOB = 2_000_000

export function shortcodeMedia(html: unknown): Any | null {
  if (typeof html !== 'string') return null
  // Requiring the opening QUOTE is what skips the single-image case for free: those documents
  // spell it `"contextJSON":null`, so there is no string literal to scan and nothing to parse.
  const at = html.indexOf(CONTEXT_JSON)
  if (at < 0) return null
  const open = at + CONTEXT_JSON.length - 1 // index OF the opening quote, so the slice is a literal
  const limit = Math.min(html.length, open + MAX_BLOB)
  let i = open + 1
  while (i < limit) {
    const c = html.charCodeAt(i)
    // A backslash escapes the next character whatever it is, so skip both. This is the only rule
    // needed to find the real end of a JSON string, and it is why `\"` inside the blob — which is
    // every single quote in it — cannot terminate the scan early.
    if (c === 92) { i += 2; continue }
    if (c === 34) break
    i++
  }
  // Ran off the end (or past the cap) without a closing quote: a truncated body, not a payload.
  // An EARLY EXIT, not the safety mechanism — the try/catch below is what actually makes a
  // truncated body safe, since without this the slice simply runs to the end and JSON.parse
  // throws into it. This saves parsing a megabyte to learn that, which on the 598KB decoy is the
  // difference worth having.
  if (i >= limit) return null
  let obj: unknown
  try {
    obj = JSON.parse(JSON.parse(html.slice(open, i + 1)) as string)
  } catch {
    return null
  }
  const sm: unknown = (obj as Any)?.gql_data?.shortcode_media
  // Null for a non-object (and for an array, which typeof calls an object): callers read named
  // fields off it, and a shortcode_media that is a string or a list is drift, not data.
  return sm !== null && typeof sm === 'object' && !Array.isArray(sm) ? (sm as Any) : null
}

/* ------------------------------------------------------------------------------------------- *
 * THE SERVER-RENDERED PATH — single-image posts, which ship no blob at all.
 * ------------------------------------------------------------------------------------------- */

/**
 * Every quantifier below is BOUNDED, for the reason shortcodeMedia's comment measures. The bounds
 * are sized off the live capture with slack, never "big enough to be safe": `alt` on the media img
 * is ~40 characters, a signed CDN URL is ~800, and a srcset carrying six of them is ~5KB.
 */
const MEDIA_TYPE = /data-media-type="(Graph[A-Za-z]{1,20})"/
const MEDIA_ID_ATTR = /data-media-id="(\d{1,24})"/
const USERNAME = /<span class="UsernameText">([^<]{1,64})<\/span>/
const AVATAR = /class="Avatar"[^>]{0,600}>\s*<img src="([^"]{20,4000})"/
const MEDIA_IMG = /<img class="EmbeddedMediaImage"[^>]{0,600}?\ssrc="([^"]{20,4000})"/
const MEDIA_SRCSET = /<img class="EmbeddedMediaImage"[^>]{0,8000}?\ssrcset="([^"]{20,40000})"/
const FRAME_RATIO = /class="Content EmbedFrame"[^>]{0,200}?style="[^"]{0,200}?padding-bottom:\s*([\d.]{1,20})%/
/** Only the plain grouped-digit form. See counts below for why "1.4M" must NOT parse. */
const LIKES = /likeCountClick"[^>]{0,200}>([\d,]{1,20})\s+likes?</
const COMMENTS = /captionCommentsClick"[^>]{0,200}>View all ([\d,]{1,20}) comments?</

/**
 * The named entities Instagram's embed markup actually emits, plus numeric escapes.
 *
 * NOT a general HTML parser and not trying to be: this runs over a caption we are about to hand a
 * renderer that escapes it again, so the failure mode of missing an entity is a visible `&#123;`
 * in a caption, never markup injection. `&amp;` is unescaped LAST, which is the ordering bug this
 * class of function is famous for — do it first and `&amp;lt;` becomes a literal `<`.
 */
function unentity(s: string): string {
  return s
    .replace(/&#(\d{1,7});/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * The caption, out of the rendered markup.
 *
 * THREE THINGS IN THAT DIV ARE NOT CAPTION TEXT and each one has been seen in a naive read:
 *  - `<a class="CaptionUsername">nasajpl</a>` is the BYLINE. Left in, every single-image post's
 *    text begins with the author's own handle.
 *  - `<div class="CaptionComments">…View all 30 comments</div>` is a nested div, so "the first
 *    </div>" is 2,204 characters past the caption and swallows it.
 *  - hashtags are `<a href="/explore/tags/NASA/">#NASA</a>`, so stripping tags without keeping
 *    their text loses every hashtag in the post.
 * `<br />` is the only line break in this markup; the blob path's captions carry real newlines,
 * and the two must agree or the same post reads differently depending on its media type.
 */
const CAPTION_OPEN = '<div class="Caption">'
function captionFromMarkup(html: string): string {
  const at = html.indexOf(CAPTION_OPEN)
  if (at < 0) return ''
  const from = at + CAPTION_OPEN.length
  const comments = html.indexOf('<div class="CaptionComments"', from)
  const close = html.indexOf('</div>', from)
  const end = comments >= 0 ? comments : close >= 0 ? close : from
  return unentity(
    html
      .slice(from, end)
      // The byline anchor, removed whole — its TEXT is the handle, so tag-stripping alone keeps it.
      .replace(/^<a class="CaptionUsername"[\s\S]{0,2000}?<\/a>/, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]{0,4000}>/g, ''),
  ).trim()
}

/**
 * The single image's dimensions, recovered from the markup — VERIFIED AGAINST THE IMAGE BYTES.
 *
 * There is no dimensions object on this path, and 0/0 would be a real loss: discord.ts and
 * telegram.ts both emit og:image:width/height from these, and a client that is not told the shape
 * of a picture reserves the wrong box for it.
 *
 * The width is the largest `Nw` descriptor in the srcset — the full-size entry, which is also the
 * one `src` points at. The height comes from the frame's `padding-bottom` percentage, which is
 * the CSS aspect-ratio trick: height = width * pct/100, and an ABSENT padding-bottom means
 * square. Both halves were checked 2026-07-19 by fetching the actual JPEG and reading its SOF
 * marker: 799w with no padding-bottom -> 799x799, and 1440w with 133.33333333333% -> 1440x1920.
 * Exact, on both, which is why this is a measurement and not an estimate.
 */
function dimsFromMarkup(html: string): { w: number; h: number } {
  const set = html.match(MEDIA_SRCSET)?.[1] ?? ''
  let w = 0
  for (const m of set.matchAll(/\s(\d{1,5})w/g)) w = Math.max(w, Number(m[1]))
  if (!w) return { w: 0, h: 0 }
  const pct = num(html.match(FRAME_RATIO)?.[1]) ?? 100
  const h = Math.round((w * pct) / 100)
  return { w, h: h > 0 ? h : 0 }
}

/**
 * "A REAL POST PAGE ARRIVED" — the ONE spelling of that question, and the one fetch.ts asserts on.
 *
 * NOT `shortcode_media`. That is the assertion the plan names for Task 4 and it would reject every
 * single-image post as a failed fetch — the commonest shape on the platform — while catching
 * nothing the two checks below do not already catch. Two spellings of "did the page arrive" is
 * two things to keep in step when Instagram renames something; TikTok's videoDetailScope states
 * the same rule for the same reason.
 *
 * THE THREE STATES THIS SEPARATES, all of which are HTTP 200 with a valid text/html content-type:
 *
 *   real post          -> a blob, or a data-media-type in the markup
 *   deleted / private  -> the 80,319-byte "post unavailable" page: TimeSliceImpl and a
 *                         contextJSON KEY are both present, so NEITHER is a liveness marker.
 *                         It carries no data-media-type and no gql_data.
 *   Chrome-UA decoy    -> the ~598KB empty shell: no markup, no blob, and LARGER than the real
 *                         payload, so every size or status heuristic gets it backwards.
 *
 * THIS IS DELIBERATELY WIDER THAN normalizeInstagram, AND TASK 4 SHOULD KNOW IT. MEDIA_TYPE
 * matches any `Graph*` type, while fromMarkup claims a page only when the type is exactly
 * GraphImage — so a video or carousel page that LOST its blob answers true here and then
 * normalizes to null. That asymmetry is intended in that direction and only that direction: the
 * fetcher caches a body it has evidence for, and the drift surfaces as a loud fetch_fail rather
 * than as a reel served with no player. test/instagram-normalize.test.mjs pins it.
 */
export function hasEmbedPost(html: unknown): boolean {
  if (typeof html !== 'string') return false
  return shortcodeMedia(html) !== null || MEDIA_TYPE.test(html)
}

/**
 * One Media entry from one node — the top-level object, or a sidecar child. ONE function for both,
 * because the discriminator is the same field at both levels and a second copy would be a second
 * place to get fact 6 wrong.
 *
 * `is_video` IS THE DISCRIMINATOR, NEVER `__typename`. Sidecar children in the EMBED payload have
 * no `__typename` field at all — measured 2026-07-19 on all ten children of DaQ5CPTki4E, whose
 * keys are exactly accessibility_caption, dimensions, display_resources, display_url, id,
 * is_video, owner, shortcode. Upstream reads `__typename`, so on this endpoint it reads undefined
 * and mislabels EVERY carousel video as an image. That failure is asymmetric and therefore
 * invisible: a mislabelled video still has a display_url, still renders a still, and only loses
 * the player and the poster logic — which is to say it only breaks the part nobody looks at.
 *
 * Compared with `=== true` rather than truthily, so a drifted `is_video: "false"` fails closed to
 * an image (a still that works) instead of open to a video url that is not there.
 */
function mediaFrom(node: Any): Media | null {
  const still = httpsUrl(node?.display_url)
  const w = dim(node?.dimensions?.width)
  const h = dim(node?.dimensions?.height)

  if (node?.is_video === true) {
    const url = httpsUrl(node?.video_url)
    if (url) {
      const media: Media = { kind: 'video', url, w, h }
      // THE POSTER FRAME. Mastodon's preview_url on a video attachment is this picture, and
      // emitting the video url there instead is what cost us Discord's rich activity card
      // (measured 2026-07-19 — see types.ts's Media.poster). display_url is present alongside
      // video_url on every video node in both live captures, so this is populating a mechanism
      // that already exists, not inventing a second one.
      //
      // Omitted entirely rather than set to undefined when there is none: mastodon.ts omits
      // preview_url deliberately in that case, and a fallback to `url` here would reinstate the
      // measured defect behind the renderer's back.
      if (still) media.poster = still
      // A FLOAT of seconds here (75.492 on the reel), unlike TikTok's integer — so this goes
      // through num(), not count().
      const d = num(node?.video_duration)
      if (d !== undefined && d > 0) media.duration = d
      return media
    }
    // A video we cannot play degrades to its STILL, never to a dead player. Phase 1's I-1 lesson:
    // an og:video pointing at something unplayable renders a dead player AND suppresses og:image,
    // so the post shows nothing at all. A still is strictly better.
    return still ? { kind: 'image', url: still, w, h } : null
  }

  // An image needs no poster of its own — an image IS its own poster, which is exactly why the
  // image path was never touched by the preview_url bug.
  return still ? { kind: 'image', url: still, w, h } : null
}

/** The author, from the blob's `owner`, or null when the handle cannot be trusted as a path. */
function authorOf(owner: Any): Post['author'] | null {
  const handle = owner?.username
  // Rejecting outright rather than escaping: the handle is interpolated into `author.url`, and
  // unlike TikTok there is no @i-style fallback that resolves without a username, so a bad handle
  // means we genuinely do not know whose post this is.
  if (typeof handle !== 'string' || !HANDLE.test(handle)) return null
  return {
    // `full_name` IS ABSENT from this payload — owner is {id, username, is_verified,
    // profile_pic_url, edge_followed_by}, measured on both live blobs. So name === handle is the
    // NORMAL case here, not a degrade, and reading full_name first costs nothing if it returns.
    name: typeof owner?.full_name === 'string' && owner.full_name ? owner.full_name : handle,
    handle,
    url: `https://www.instagram.com/${handle}/`,
    avatar: httpsUrl(owner?.profile_pic_url) ?? undefined,
  }
}

/**
 * Pure: Instagram embed-page HTML -> Post. Returns null rather than inventing a Post — a half-built
 * Post renders as a broken embed, and the null routes into the existing fetch_fail error path.
 *
 * Total by construction: `html` is whatever the fetcher got (or nothing) and `ref` may arrive from
 * the CACHE unvalidated, so every read is defensive and both JSON.parses are inside a try.
 */
export function normalizeInstagram(html: unknown, ref: PostRef): Post | null {
  // Stories are out of scope for this phase (plan, Task 2 decision 4) and carry no `code`, so
  // without this they would interpolate `undefined` into a canonical and mint a URL naming no post.
  if (ref.p !== 'ig' || ref.kind === 'story') return null
  // `typeof` FIRST, and it is not belt-and-braces: RegExp.test STRINGIFIES its argument, so
  // CODE.test(undefined) tests the string "undefined" and passes — minting
  // instagram.com/p/undefined/, the very URL the story-ref line above exists to prevent, from any
  // ref that lost its code. Same for null, a number, or a one-element array. types.ts makes that
  // unreachable from the live caller, but this function's contract is that the ref may arrive from
  // the CACHE unvalidated, and a guard advertised as total has to be total.
  if (typeof ref.code !== 'string' || !CODE.test(ref.code)) return null

  const sm = shortcodeMedia(html)
  return sm ? fromBlob(sm, ref) : fromMarkup(html, ref)
}

/** A video or carousel post: everything comes out of the GraphQL object. */
function fromBlob(sm: Any, ref: Extract<PostRef, { p: 'ig'; kind: 'p' | 'reel' | 'tv' }>): Post | null {
  const author = authorOf(sm.owner)
  if (!author) return null
  const createdAt = createdAtFromId(sm.id)
  if (!createdAt) return null

  // Sidecar -> one entry per child; no sidecar -> one entry from the object itself. The array's
  // PRESENCE is the discriminator rather than a guess about what media exist, and an empty edges
  // array falls through to the top-level read so a drifted-empty carousel still shows its cover.
  const edges = sm?.edge_sidecar_to_children?.edges
  const nodes: Any[] = Array.isArray(edges) && edges.length
    ? edges.map((e: Any) => e?.node).filter((n: unknown) => !!n && typeof n === 'object')
    : [sm]
  // Entries we cannot vouch for are SKIPPED, not emitted, so a non-https child never becomes an
  // og:image — but a skipped child must not shift the ones after it, and it does not: /_media/
  // indexes this array, and the array is what the renderer and pickMedia both read.
  const media = nodes.map(mediaFrom).filter((m: Media | null): m is Media => m !== null)

  const counts: Post['counts'] = {}
  const put = (k: keyof Post['counts'], v: unknown) => {
    const n = count(v)
    if (n !== undefined) counts[k] = n
  }
  // NOT `edge_media_preview_like`, which the plan names and this payload does not have.
  put('likes', sm?.edge_liked_by?.count)
  put('replies', sm?.edge_media_to_comment?.count)
  // `views` IS DELIBERATELY NOT EMITTED. The reel fixture reports `video_view_count: 0` while
  // being a real post with real views, so the field is present-but-unpopulated on this endpoint.
  // A confident "0 views" under a post is worse than no view count: absent degrades, wrong lies.

  return {
    ref,
    canonical: canonicalFor(ref.code, sm?.product_type === 'clips'),
    author,
    text: captionOf(sm),
    createdAt,
    media,
    counts,
    // Instagram exposes no per-post sensitivity signal at all (spec §Sensitivity). Always false.
    sensitive: false,
  }
}

/**
 * A single-image post: there is no blob, so everything comes out of the server-rendered markup.
 *
 * This whole function is the plan's blind spot, and it exists because the alternative was
 * returning null for the commonest post shape on the platform. It is deliberately narrow — it
 * claims a page ONLY when the markup says GraphImage, so a future video shape that loses its blob
 * fails loudly here rather than being half-read into a Post with no player.
 */
function fromMarkup(html: unknown, ref: Extract<PostRef, { p: 'ig'; kind: 'p' | 'reel' | 'tv' }>): Post | null {
  if (typeof html !== 'string') return null
  if (html.match(MEDIA_TYPE)?.[1] !== 'GraphImage') return null

  const createdAt = createdAtFromId(html.match(MEDIA_ID_ATTR)?.[1])
  if (!createdAt) return null
  const author = authorOf({
    username: html.match(USERNAME)?.[1],
    profile_pic_url: unentityUrl(html.match(AVATAR)?.[1]),
  })
  if (!author) return null

  const url = unentityUrl(html.match(MEDIA_IMG)?.[1])
  const { w, h } = dimsFromMarkup(html)
  const media: Media[] = httpsUrl(url) ? [{ kind: 'image', url: url as string, w, h }] : []

  const counts: Post['counts'] = {}
  // Grouped digits only, and the separators are stripped rather than parsed: the SAME document
  // writes "1.4M followers" two lines above the like count, and a tolerant number reader would
  // turn that into 1. Absent beats wrong.
  const put = (k: keyof Post['counts'], m: RegExpMatchArray | null) => {
    const n = m ? count(m[1].replace(/,/g, '')) : undefined
    if (n !== undefined) counts[k] = n
  }
  put('likes', html.match(LIKES))
  put('replies', html.match(COMMENTS))

  return {
    ref,
    // A GraphImage is never a reel, so this is always the /p/ form — no payload evidence needed.
    canonical: canonicalFor(ref.code, false),
    author,
    text: captionFromMarkup(html),
    createdAt,
    media,
    counts,
    sensitive: false,
  }
}

/** Attribute values are HTML-escaped (`&amp;` in every signed CDN URL); decode before use. */
function unentityUrl(v: string | undefined): string | null {
  return typeof v === 'string' ? unentity(v) : null
}

/** `edge_media_to_caption.edges[0].node.text`, or '' — a caption-less post is still a post. */
function captionOf(sm: Any): string {
  const t = sm?.edge_media_to_caption?.edges?.[0]?.node?.text
  return typeof t === 'string' ? t : ''
}

/**
 * The canonical URL, rebuilt from the PAYLOAD rather than from the ref.
 *
 * Task 2 collapses /p/, /reel/, /reels/ and /tv/ onto one ref with kind:'p' — one cache key and
 * one /_media/ namespace for what fact 1 proves is one post — so the ref no longer remembers which
 * surface the link named. `product_type: 'clips'` is the evidence that replaces it, measured
 * present on the reel capture and absent on the carousel. Same division of labour as TikTok, where
 * route() keeps the pasted @handle and the normalizer rebuilds /@{uniqueId}/{video|photo}/{id}.
 *
 * Built through new URL().href so the URL spec's percent-encode set is re-applied, keeping a
 * hostile code out of the `location` header worker.ts builds from this (the crash class fixed in
 * 4655ee8). CODE has already excluded the characters that would matter, so this is a no-op on
 * every URL we actually emit — and it is the belt to that regex's braces, not a substitute.
 */
function canonicalFor(code: string, isReel: boolean): string {
  return new URL(`https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`).href
}

/**
 * THE PRIVATE-ACCOUNT GATE — read off the full /p/{code}/ page (fetchInstagramFullPage), NEVER the
 * embed. On the embed surface a private post is byte-identical to a deleted one; the full page is the
 * only surface that names the account. Returns 'private' (the FetchReport / render vocabulary) or
 * undefined.
 *
 * THE SIGNAL: a "username" is present AND no `data-media-type` is. A private wall server-renders the
 * account handle with no media; a deleted post renders neither, so it falls through to undefined and
 * today's generic failure. Egress-confirmed 2026-07-21 (probe: `"username":"fixture_user_1"` present,
 * no data-media-type, from Workers egress on a real private post; the fabricated deleted code carried
 * neither).
 *
 * POSITIVE AND NO-REGRESSION, the discipline tiktokGate keeps. It is consulted ONLY on a full page
 * fetched AFTER the embed already failed, so a PUBLIC post — whose embed succeeds — never reaches it.
 * The `data-media-type` guard is what makes a false positive impossible on anything with media: a
 * page that rendered media is not a private wall, whatever else it carries. Total over junk: a
 * non-string input is undefined, not a throw.
 */
const IG_USERNAME = /"username":"[A-Za-z0-9._]{1,40}"/
export function instagramPrivateGate(html: unknown): 'private' | undefined {
  if (typeof html !== 'string') return undefined
  // Media present -> this is not a private wall (and never a private post, which shows none).
  if (/data-media-type/.test(html)) return undefined
  return IG_USERNAME.test(html) ? 'private' : undefined
}

/**
 * THE AGE GATE — read off the same full page the private gate reads, and consulted BEFORE it.
 *
 * REPORTED 2026-07-28 on /reel/DZFDtEhoNPy/ and /reel/DZPWDqmIIld/: both rendered "It may be private,
 * removed, or unavailable." Both posts EXIST and are live; the owning account is restricted to 25+,
 * so Instagram refuses them to every logged-out client. The card was not wrong about failing — it was
 * wrong about WHY, and this project already ships a 🔞 card for exactly this on Twitter and TikTok.
 *
 * INSTAGRAM TELLS US, POSITIVELY, IN BYTES WE ALREADY HAVE. The full page (fetchInstagramFullPage,
 * already fetched on this path) server-renders a PolarisErrorRoot whose props are verbatim:
 *
 *     "failure_reason":"MA","restricted_age":25,"page_type":"MEDIA"
 *
 * A live public post carries neither key. So this is a POSITIVE signal — the discipline tiktokGate
 * keeps and the one instagramPrivateGate cannot: that gate infers a wall from what is ABSENT (a
 * username with no media), which is precisely how a public reel came to render 🔒 from datacenter
 * egress on 2026-07-26. Reasoning from Instagram's own error field cannot make that mistake.
 *
 * WHY THE FULL PAGE AND NOT oEmbed. `/api/v1/oembed/?url=…` gives a cleaner answer still — HTTP 400
 * with `"blocks_logging_data":"MIN_AGE_ACCOUNT"` and "People under 25 can't see this content", where
 * a live post returns 200 and a fabricated-but-well-formed code returns 404 `No Media Match`. It is a
 * better discriminator, but it costs an EXTRA request, and this page is already in hand on the only
 * path that reaches here. If the full page ever stops carrying the field, oEmbed is the documented
 * fallback rather than something to rediscover.
 *
 * BOTH KEYS ARE REQUIRED, and `message":"geoblock_required"` is deliberately NOT used. Meta reuses
 * its GEO-gating transport for age gating: the oEmbed body's `message` literally reads
 * `geoblock_required` while `geo_block_rule_type` is null and the real reason is MIN_AGE_ACCOUNT.
 * Keying on `message` would ship a card claiming "region blocked" for an age wall.
 *
 * 'MA' IS THE ONLY VALUE CLAIMED. It is the only one measured (n=2, one account). Other
 * `failure_reason` values certainly exist and are left to fall through to today's generic behaviour
 * rather than guessed at — a wrong gate label is worse than a generic one.
 *
 * Total over junk: a non-string input is undefined, not a throw.
 */
export function instagramAgeGate(html: unknown): 'age_restricted' | undefined {
  if (typeof html !== 'string') return undefined
  return /"failure_reason":"MA"/.test(html) && /"restricted_age":\d{1,3}/.test(html)
    ? 'age_restricted'
    : undefined
}

/* ------------------------------------------------------------------------------------------- *
 * THE FULL-PAGE CARD — a public post whose EMBED failed is still a public post.
 * ------------------------------------------------------------------------------------------- */

/**
 * Instagram's shortcode IS its media id, base64url big-endian. Pure, and it is what lets a full-page
 * card carry a real timestamp: that page has no `data-media-id` for createdAtFromId to read, and the
 * og: set carries only a human date string ("on June 12, 2026") in the viewer's locale.
 *
 * VERIFIED AGAINST A REAL PAYLOAD, not just self-consistently: DbN6SsKum-9 decodes to
 * 3949068819346649021, which is byte-identical to the `id` in that post's own embed blob (captured
 * 2026-07-26 in instagram-copyright-blocked.html). Decoded dates also match the pages' own copy —
 * DZghoo7PAzi -> 2026-06-13T01:49Z against an og:description reading "June 12, 2026" (the same
 * instant in US time zones).
 *
 * Returns a decimal id string for createdAtFromId, or null. Total: an out-of-alphabet character is
 * null rather than a silently wrong number, and BigInt cannot throw on a validated alphabet.
 */
const IG_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
function mediaIdFromShortcode(code: string): string | null {
  let n = 0n
  for (const ch of code) {
    const i = IG_B64.indexOf(ch)
    if (i < 0) return null
    n = n * 64n + BigInt(i)
  }
  return n.toString()
}

/** One og: property's raw content attribute, or ''. Bounded, like every quantifier in this file. */
function ogContent(html: string, prop: string): string {
  const m = html.match(new RegExp(`<meta property="og:${prop}" content="([^"]{0,2000})"`))
  return m ? unentity(m[1]) : ''
}

/**
 * A CARD BUILT FROM THE FULL /p/{code}/ PAGE's og: SET — the fix for a PUBLIC post rendering 🔒.
 *
 * THE DEFECT, reported 2026-07-26 on /reel/DZghoo7PAzi/ (public, @fixture8.example, 12K likes) which the
 * live apex answered "This post is private" while instagram7 served it. Nothing was parsed wrongly.
 * The embed endpoint answered our DATACENTER egress with the ~81KB "unavailable" shell, so
 * normalizeInstagram returned null, and the worker fell back to instagramPrivateGate — whose rule is
 * "a username with no data-media-type". On the page Cloudflare receives, that is true of this public
 * post, so it inferred a wall.
 *
 * THE ASYMMETRY IS WHY IT REACHED PRODUCTION: from a RESIDENTIAL host the identical full page makes
 * instagramPrivateGate return undefined, so the bug does not reproduce off-datacenter. The gate's
 * "egress-confirmed" note is honest and insufficient — it proves the gate catches TRUE positives, never
 * that it avoids FALSE ones. A rule that concludes from ABSENT evidence cannot be validated by
 * examples where the conclusion is right.
 *
 * SO THIS READS WHAT IS PRESENT INSTEAD. The full page carries the whole post — og:title (display name
 * + caption), og:url (the handle), og:image (the cover) — and a positive content read always beats an
 * inference from missing markers. The worker tries this FIRST and consults the private gate only when
 * this returns null, which is the ordering that makes 🔒 a last resort rather than a default.
 *
 * NO og:video ON THIS SURFACE, measured — a reel's page ships og:image alone. So this alone yields a
 * COVER card; the video is recovered separately from the v1 user feed, which is the same surface the
 * copyright-blocked path uses and is reachable precisely because og:url hands us the handle.
 *
 * REFUSES RATHER THAN GUESSES on anything that is not unambiguously a post: no handle in og:url, no
 * https cover, or a shortcode that will not decode all mean null, and null means the gate gets its turn.
 */
export function instagramFullPageCard(html: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'ig' || ref.kind === 'story') return null
  if (typeof ref.code !== 'string' || !CODE.test(ref.code)) return null
  if (typeof html !== 'string') return null

  // og:url is https://www.instagram.com/{handle}/reel/{code}/ — the one place this page states the
  // handle in a form worth trusting. A /p/{code}/ form carries none, and we decline rather than
  // invent one, because author.url is built from it.
  const handle = ogContent(html, 'url').match(/instagram\.com\/([A-Za-z0-9._]{1,40})\/(?:p|reel|reels|tv)\//)?.[1]
  if (!handle || !HANDLE.test(handle)) return null

  const cover = ogContent(html, 'image')
  if (!httpsUrl(cover)) return null

  const createdAt = createdAtFromId(mediaIdFromShortcode(ref.code))
  if (!createdAt) return null

  // og:title is `{Display Name} on Instagram: "{caption}"`. Splitting on that literal gives a real
  // display name AND the caption; if the shape ever drifts, the split simply fails and both degrade
  // to the handle and og:description rather than emitting a mangled title.
  const title = ogContent(html, 'title')
  const at = title.indexOf(' on Instagram: ')
  const display = at > 0 ? title.slice(0, at) : ''
  const quoted = at > 0 ? title.slice(at + ' on Instagram: '.length) : ''
  const caption = quoted.replace(/^"|"$/g, '') || ogContent(html, 'description')

  return {
    ref,
    canonical: canonicalFor(ref.code, /\/(reel|reels)\//.test(ogContent(html, 'url'))),
    author: {
      name: display || handle,
      handle,
      url: `https://www.instagram.com/${handle}/`,
    },
    text: caption,
    createdAt,
    media: [{ kind: 'image', url: cover as string, w: 0, h: 0 }],
    counts: {},
    sensitive: false,
  }
}

/* ------------------------------------------------------------------------------------------- *
 * THE COPYRIGHT-BLOCKED RECOVERY — a rights-struck reel is still a playable video.
 * ------------------------------------------------------------------------------------------- */

/**
 * IS THIS POST'S VIDEO WITHHELD FROM EMBEDDERS? Read off the ORDINARY embed payload we already
 * fetched — this costs no request and gates one that does.
 *
 * THE DEFECT IT NAMES, reported from a live embed 2026-07-26: instagram.com/reel/DbN6SsKum-9/ is a
 * video that rendered as a photo. Instagram's `/embed/captioned/` serializer omits `video_url`
 * ENTIRELY for a rights-struck post while still returning caption, author, dimensions, display_url
 * and `is_video: true`, so mediaFrom's (correct) "a video we cannot play degrades to its still" arm
 * fires and the card silently becomes a picture. Measured over four reels, exactly:
 *
 *   copyright_blocked: false  ->  video_url present   (DZc6RL8sHtz, DbOwAfWp0YT)
 *   copyright_blocked: true   ->  video_url ABSENT    (DbN6SsKum-9, Da2xdeSuhtt)
 *
 * IT IS NOT A TAKEDOWN AND NOT GEO. The driver is the AUDIO'S RIGHTSHOLDER: measured across one
 * account's twelve most recent posts, Wonderwall (Oasis) and Thomas Theme (Mattel) are blocked while
 * Cartoon Cat (Ozpi), Padroeiro do Ceara (Tiririca) and Hot Dog (Little Apple Band) are not, and
 * original audio never is. Major-label catalog is licensed for playback INSIDE Instagram and not
 * sub-licensed to embedders; indie catalog largely is. Recorded because the obvious shortcut —
 * "carries music_info => blocked" — looked clean on four samples, DIED on twelve, and would fire the
 * 500KB recovery on the majority of posts that carry licensed audio and are perfectly fine.
 *
 * A REGEX RATHER THAN shortcodeMedia(), deliberately: the flag lives on the blob's `context` object,
 * a SIBLING of `gql_data`, and shortcodeMedia returns `gql_data.shortcode_media` — so there is no
 * existing parse to read it from and adding one would mean parsing the blob twice on every post to
 * answer a question that is false for nearly all of them. The pattern tolerates both the escaped
 * spelling the raw document carries (`\"copyright_blocked\":true`) and the plain one, and is pinned
 * against the `:false` twin, which is the mutation that would matter: a match on the KEY alone is
 * true for every healthy post and would spend the recovery fetch on all of them.
 */
const IG_COPYRIGHT_BLOCKED = /"copyright_blocked\\?"\s*:\s*true/
export function instagramCopyrightBlocked(html: unknown): boolean {
  return typeof html === 'string' && IG_COPYRIGHT_BLOCKED.test(html)
}


/**
 * OVERLAY THE RECOVERED VIDEO ONTO THE STILL-ONLY POST. Pure, total, NON-DESTRUCTIVE — junk returns
 * the SAME object reference, which is what lets worker.ts call it unconditionally on the blocked
 * path without a branch and without ever degrading a post it could not improve.
 *
 * THE POSTER IS CARRIED ACROSS, NOT DISCARDED. The still we already extracted IS this video's cover
 * frame, and a posterless video drops Discord's rich card to plain OpenGraph (types.ts, Media.poster)
 * — so the upgrade would otherwise be a visible downgrade in the exact case it exists to fix.
 *
 * THE HOST CHECK IS mediaproxy's OWN allowedHost, IMPORTED. This url arrives from a different
 * upstream surface than everything else in this file, and it is handed to fetch() by serveDirectVideo
 * — so it is range-checked here too, at the boundary where it enters a Post. mediaproxy re-checks it
 * before the fetch AND on the final url after redirects; this is the outermost of those three layers,
 * not a replacement for them, and it deliberately shares their one spelling so the three cannot drift.
 *
 * REPLACES media[0] RATHER THAN APPENDING. A blocked reel normalizes to exactly one still (a
 * single-video post), and appending would give Discord two attachments for one piece of media. If a
 * blocked CAROUSEL ever appears this refuses it — see the length guard — because a carousel's items
 * are positional and pairing them with a feed item's renditions is an unmeasured mapping.
 */
export function withRecoveredVideo<T extends Post | null>(post: T, recovered: unknown): T {
  if (!post || !recovered) return post
  const list: Media[] = Array.isArray(recovered) ? recovered as Media[]
    : typeof recovered === 'object' ? [recoveredToMedia(recovered as Any)].filter(Boolean) as Media[]
      : []
  const usable = list.filter(m => m && typeof m.url === 'string' && allowedHost(m.url))
  if (!usable.length) return post
  // The post must be the STILL-ONLY shape this recovery exists to upgrade. A post that already has its
  // media is not the broken case and must not be touched.
  if (!Array.isArray(post.media) || post.media.length !== 1 || post.media[0]?.kind !== 'image') return post
  const still = post.media[0]
  /**
   * THE COVER SURVIVES AS THE POSTER on a single recovered VIDEO — a posterless video drops Discord's
   * rich card to plain OpenGraph (types.ts, Media.poster), so the upgrade would otherwise be a visible
   * downgrade in the exact case it exists to fix. A recovered GALLERY needs no poster: every entry is
   * already a picture, and the cover is the first of them.
   */
  if (usable.length === 1 && usable[0].kind === 'video' && still.url && !usable[0].poster) {
    usable[0] = { ...usable[0], poster: still.url }
  }
  return { ...post, media: usable } as T
}

/** The legacy single-object shape ({url,w,h,duration}) that recoveredVideoFrom used to return. */
function recoveredToMedia(r: Any): Media | null {
  if (typeof r?.url !== 'string' || !r.url) return null
  if (r.kind === 'image' || r.kind === 'video') return r as Media
  const m: Media = { kind: 'video', url: r.url, w: dim(r.w), h: dim(r.h) }
  const d = num(r.duration)
  if (d !== undefined && d > 0) m.duration = d
  return m
}

/**
 * EVERY PIECE OF MEDIA A POST HAS, recovered from the v1 feed — carousel, video or single image.
 *
 * THE DEFECT THIS CLOSES, reported 2026-07-27 with screenshots on /p/DbRYdu1Dx62/: a TWELVE-image
 * carousel rendered as ONE image, and that image was visibly CROPPED — the card showed a zoomed
 * detail of a sign where the post's own first slide shows the whole building.
 *
 * BOTH SYMPTOMS HAD THE SAME CAUSE: the embed endpoint answered with the ~81KB shell, so the post fell
 * to instagramFullPageCard, which emits exactly one image — Instagram's og:image. And og:image is a
 * SQUARE crop. The feed item's candidate ladder makes that explicit: 3024x4032, 1080x1440, 720x960 …
 * then 1080x1080, 750x750, 640x640 …, i.e. the aspect-correct renditions and then the cropped ones.
 * og:image is drawn from the second group, which is why the picture was both alone AND wrong.
 *
 * CANDIDATE CHOICE IS ASPECT-FIRST, THEN SIZE. The largest candidate defines the true aspect ratio;
 * anything that disagrees with it by more than a hair is a crop and is discarded outright — that is
 * what fixes the zoomed picture. Among the survivors the largest is taken subject to MAX_EDGE, because
 * the untouched original here is 3024x4032 and Discord postage-stamps an oversized image (the defect
 * render/mastodon.ts records for og:image). 1440 keeps the 1080x1440 rendition, which is the one a
 * human would pick.
 *
 * A CAROUSEL'S SLIDES CAN BE VIDEOS TOO (media_type 2 inside media_type 8), so each child is mapped by
 * the same rule as a top-level item rather than assumed to be a picture.
 *
 * BOUNDED AT INSTAGRAM'S OWN CAROUSEL MAXIMUM (20), not at a number picked for comfort. The bound
 * exists because an unbounded map over an upstream array is the shape every other reader in this file
 * guards against — but it must not TRUNCATE, and a first draft capped at 10 would have silently
 * dropped 2 slides of the reported 12-image post. The blob path (fromBlob) emits every child with no
 * cap, so a lower limit here would also make the same post render differently depending on which
 * surface answered.
 */
const MAX_EDGE = 1440

function bestImage(node: Any): { url: string; w: number; h: number } | null {
  const cands = node?.image_versions2?.candidates
  if (!Array.isArray(cands) || !cands.length) return null
  const valid = cands.filter(c => c && typeof c.url === 'string' && dim(c.width) > 0 && dim(c.height) > 0)
  if (!valid.length) return null
  // The biggest candidate is the untouched original, so it defines the post's real aspect ratio.
  const original = valid.reduce((a, b) => (dim(a.width) * dim(a.height) >= dim(b.width) * dim(b.height) ? a : b))
  const aspect = dim(original.width) / dim(original.height)
  const sameShape = valid.filter(c => Math.abs(dim(c.width) / dim(c.height) - aspect) < 0.02)
  const pool = sameShape.length ? sameShape : [original]
  const fits = pool.filter(c => Math.max(dim(c.width), dim(c.height)) <= MAX_EDGE)
  const pick = (fits.length ? fits : pool)
    .reduce((a, b) => (dim(a.width) * dim(a.height) >= dim(b.width) * dim(b.height) ? a : b))
  return { url: pick.url as string, w: dim(pick.width), h: dim(pick.height) }
}

function bestVideo(node: Any): { url: string; w: number; h: number } | null {
  const vs = node?.video_versions
  if (!Array.isArray(vs)) return null
  const valid = vs.filter(v => v && typeof v.url === 'string' && v.url)
  if (!valid.length) return null
  const pick = valid.reduce((a, b) => (dim(a.width) * dim(a.height) >= dim(b.width) * dim(b.height) ? a : b))
  return { url: pick.url as string, w: dim(pick.width), h: dim(pick.height) }
}

function mediaFromFeedNode(node: Any): Media | null {
  const v = bestVideo(node)
  if (v) {
    const m: Media = { kind: 'video', url: v.url, w: v.w, h: v.h }
    const cover = bestImage(node)
    if (cover) m.poster = cover.url
    const d = num(node?.video_duration)
    if (d !== undefined && d > 0) m.duration = d
    return m
  }
  const i = bestImage(node)
  return i ? { kind: 'image', url: i.url, w: i.w, h: i.h } : null
}

export function recoveredMediaFrom(body: unknown, code: string): Media[] | null {
  if (typeof body !== 'string' || !code) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const items: unknown = (parsed as Any)?.items
  if (!Array.isArray(items)) return null
  const item = items.find(it => it !== null && typeof it === 'object' && (it as Any).code === code) as Any
  if (!item) return null

  const kids = item.carousel_media
  const nodes: Any[] = Array.isArray(kids) && kids.length ? kids.slice(0, 20) : [item]
  const out = nodes.map(mediaFromFeedNode).filter(Boolean) as Media[]
  return out.length ? out : null
}
