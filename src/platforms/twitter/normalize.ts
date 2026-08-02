import type { Media, Post, PostRef } from '../../types.ts'

/**
 * Pure: a cdn.syndication.twimg.com/tweet-result JSON object -> Post. No I/O; every test against
 * it runs on real captured bytes with no network. The extraction lives here rather than in fetch.ts
 * because the field walk is exactly where a platform change breaks us first, and that is the part
 * worth testing against real captures.
 *
 * NAMING SPLIT — restated here so nobody "consistency-fixes" it (mastodon.ts's APPLICATION docstring
 * states the same rule for the render side). This file lives at src/platforms/twitter/ and its
 * functions say "Twitter", because directory/function names use the full-name convention every
 * other platform already follows (fetchBluesky, normalizeTikTok). But every `ref.p` value is `'x'`,
 * every refKey is `x:{id}`, and every URL is on `x.com` — those are the Platform ENUM identifier
 * and the canonical host, and renaming them would churn cache keys, refKeys and every /_media/ URL
 * for nothing. The short code `'x'` is a name of a slot in code; "Twitter" is the word a human reads.
 *
 * CONTENT-ASSERT, NEVER STATUS. syndicationHasTweet() below is the ONE content assertion, and the
 * hazards it defends against were all measured (Global Constraints): the missing-token response is
 * HTTP 200 with body `{}`, an age-gated post is HTTP 200 carrying a `TweetTombstone`, and a
 * nonexistent id is a 404 serving an HTML page. Status and content-type discriminate none of them;
 * the presence of `__typename === 'Tweet'` with real fields is the only reliable signal.
 */

type Any = Record<string, any>

/** A string, or ''. The read-through this whole module uses on cache-shaped, untrusted input. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * DECODE Twitter's HTML-entity-encoded tweet text. Measured: the syndication `text` field (and the
 * guest `legacy.full_text` field Task 3 will read — same encoding) delivers `&`, `<`, `>` PRE-ENCODED
 * as `&amp;`, `&lt;`, `&gt;`, and leaves `"` and `'` LITERAL (video fixture: `plains &amp; plateaus`,
 * `"Earth's twin"`). We must hand the renderer ALREADY-DECODED text, because the shared renderer
 * escapes exactly ONCE at its boundary (render/text.ts esc(); og:description does esc(desc) too). Skip
 * this and every tweet with `&`/`<`/`>` double-encodes: `R&D` -> stored `R&amp;D` -> wire `R&amp;amp;D`
 * -> the client decodes one level -> the user sees a literal `R&amp;D`. This is the SAME hazard the
 * Instagram sibling decodes for (instagram/normalize.ts unentity); TikTok/Bluesky don't, because their
 * JSON text is not entity-encoded — Twitter's is. The plan is silent on it.
 *
 * ONLY the three entities Twitter actually emits, and no more. Decoding `&quot;`/`&apos;`/numeric
 * escapes would be decoding entities the source never produces and would CORRUPT literal text: a user
 * who typed the 6 characters `&quot;` has it delivered as `&amp;quot;`, which must decode to the
 * literal `&quot;`, NOT to `"`. So the minimal exact inverse of Twitter's encoding is the correct one.
 *
 * `&amp;` is unescaped LAST — the ordering bug this class of function is famous for (the Instagram
 * sibling's comment names it). A user's literal `&lt;` arrives as `&amp;lt;`; decoding `&amp;` first
 * would corrupt it to `<`, whereas decoding `&lt;`/`&gt;` first (neither matches inside `&amp;lt;`)
 * then `&amp;` recovers the literal `&lt;` the user actually typed. Shared by the root body and the
 * depth-1 quoted body because it lives in build(), which is shared.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // LAST — see ordering hazard above
}

/**
 * A usable number, or ABSENT. Never NaN and never a string. Copied verbatim from TikTok's num()
 * — it carries three scars (see tiktok/normalize.ts): `Number(null)`/`Number('')`/`Number([])`/
 * `Number(' ')` are all 0, which would invent a value out of an absent field; a boolean coerces to
 * 1; and an all-blank string had to be trimmed before deciding, because ' '/'\n'/'\t' also coerce
 * to 0. Reused here rather than re-derived so those three do not get re-litigated with a new answer.
 */
function num(v: unknown): number | undefined {
  if (v === null || typeof v === 'object' || typeof v === 'boolean') return undefined
  if (typeof v === 'string' && v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * A COUNT specifically: a non-negative integer, or absent. Separate from num() because a count is a
 * cardinality — `-5` likes or `1.9` replies are upstream nonsense a renderer would print as fact, so
 * drop rather than clamp (a clamped value is indistinguishable from a real one when displayed).
 * Copied verbatim from TikTok's count().
 */
function count(v: unknown): number | undefined {
  const n = num(v)
  return n !== undefined && n >= 0 && Number.isInteger(n) ? n : undefined
}

/** A pixel dimension, or 0 for "unknown" — the same convention Bluesky's and TikTok's normalizers use. */
function dim(v: unknown): number {
  const n = num(v)
  return n !== undefined && n > 0 ? Math.round(n) : 0
}

/**
 * An https URL, or null. The prefix check is not decoration: these strings end up in og:image and
 * og:video (via /_media/), and a protocol-relative ('//host/x') or http URL there is a
 * mixed-content hole we would be authoring ourselves. Syndication carries the still as
 * `media_url_https` (measured — there is no `media_url` on these entries), so the https one is the
 * value to read; the http twin, where it exists on other endpoints, is the hole.
 */
function httpsUrl(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('https://') ? v : null
}

/**
 * Twitter handles are [A-Za-z0-9_], max 15. The handle, or null when it cannot be trusted as a URL
 * path segment. Mirrors TikTok's handleOf(): this value comes from an upstream payload and is
 * interpolated into `canonical`, which worker.ts hands to redirect() — into a `location` header,
 * where a raw CR/LF/NUL makes `new Headers()` throw (the 500 fixed in 4655ee8). Rejecting outright
 * beats escaping because the fallback is genuinely good: x.com/i/status/{id} resolves without any
 * handle, so a rejected handle costs a working link, not a mangled one.
 */
const HANDLE = /^\w{1,15}$/
function handleOf(v: unknown): string | null {
  return typeof v === 'string' && HANDLE.test(v) ? v : null
}

/**
 * The best playable mp4 url from a `video_info.variants` list, or null.
 *
 * FILTER BY content_type FIRST, THEN max bitrate. `application/x-mpegURL` (the HLS `m3u8`) is
 * dropped because Discord's player cannot play it — selecting it would render a dead player and
 * suppress og:image (Phase 1's I-1 lesson). Among the real `video/mp4` variants we take the highest
 * bitrate.
 *
 * DO NOT gate on a truthy bitrate. A Twitter `animated_gif` is delivered as an mp4 with no audio,
 * and its single mp4 variant frequently carries `bitrate: 0` or omits it entirely (measured on the
 * gif fixture: one variant, `bitrate: 0`). A truthy-bitrate filter would discard the only playable
 * url and leave a dead player. So an absent/zero bitrate reads as 0 and is still selectable, and the
 * `best === null` clause guarantees the first valid mp4 is taken regardless of its (even negative)
 * bitrate. This selection is SHARED by both source shapes — `video_info.variants` is the same
 * structure in syndication and in guest.
 */
function pickMp4(variants: unknown): string | null {
  if (!Array.isArray(variants)) return null
  let best: string | null = null
  let bestBr = -1
  for (const v of variants) {
    if (!v || (v as Any).content_type !== 'video/mp4') continue
    const url = httpsUrl((v as Any).url)
    if (!url) continue
    const br = num((v as Any).bitrate) ?? 0 // absent/NaN bitrate is 0, still selectable
    if (best === null || br > bestBr) {
      best = url
      bestBr = br
    }
  }
  return best
}

/**
 * `mediaDetails[]` -> Media[]. Shared by the root post and a quoted post (a quoted tweet carries its
 * OWN `mediaDetails` in the identical shape). Non-https entries and unknown types are SKIPPED, never
 * emitted — an image we cannot vouch for must not become an og:image.
 *
 *  - `photo`         -> { kind:'image', url: media_url_https, w, h }
 *  - `video`         -> { kind:'video', url: <best mp4>, poster: media_url_https, w, h, duration? }
 *  - `animated_gif`  -> { kind:'video', … } WITH a poster — NEVER kind:'gif'.
 *
 * THE animated_gif TRAP (fact 4): a Twitter "GIF" is an mp4 with no audio, not a `.gif` file. Our
 * Media.kind 'gif' means "the url IS an animated .gif file" and maps to a Mastodon `image`
 * attachment (mastodon.ts ATTACHMENT_TYPE). Mapping animated_gif to 'gif' would put an mp4 url into
 * an image attachment — the exact 2026-07-19 poster defect (Discord requests a still, receives mp4
 * bytes, drops the rich card). So it maps to 'video' with a real poster: a silent looping inline
 * player that actually plays.
 *
 * DEGRADE, NEVER A DEAD PLAYER (Phase 1's I-1 lesson): a video/animated_gif with no selectable mp4
 * falls back to its still as a plain `kind:'image'`. A still is strictly better than a player that
 * cannot play. Dimensions come from `original_info.{width,height}` (measured — there is no top-level
 * `dimensions`, and `sizes` only carries thumb/small/medium/large buckets).
 */
function mediaFrom(list: unknown): Media[] {
  if (!Array.isArray(list)) return []
  const out: Media[] = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    const still = httpsUrl((m as Any).media_url_https)
    const w = dim((m as Any).original_info?.width)
    const h = dim((m as Any).original_info?.height)
    const type = (m as Any).type

    if (type === 'photo') {
      if (still) out.push({ kind: 'image', url: still, w, h })
      continue
    }

    if (type === 'video' || type === 'animated_gif') {
      const mp4 = pickMp4((m as Any).video_info?.variants)
      if (mp4) {
        const media: Media = { kind: 'video', url: mp4, w, h }
        // Poster is the STILL, never the mp4 (types.ts Media.poster). Omitted entirely rather than
        // set to undefined when there is no https still, so a Post is structurally identical whether
        // the poster was absent or merely unusable — and the renderer omits preview_url rather than
        // pointing it at the video (the 2026-07-19 defect).
        if (still) media.poster = still
        // duration_millis -> seconds, only when it is a usable positive number. Omitted otherwise.
        const ms = num((m as Any).video_info?.duration_millis)
        if (ms !== undefined && ms > 0) media.duration = ms / 1000
        out.push(media)
      } else if (still) {
        // No playable mp4: degrade to the still as a plain image — never a dead video entry.
        out.push({ kind: 'image', url: still, w, h })
      }
      continue
    }
    // Unknown media type — skip rather than guess.
  }
  return out
}

/**
 * THE CORE Post BUILDER, shared by the root post and its quoted tweet, and it NEVER sets
 * quote/replyTo — that is the depth-1 cap, exactly the way Bluesky's build()/normalizeBluesky split
 * enforces it. Because build() is the only thing that touches a nested quoted tweet and it does not
 * recurse, `post.quote.quote` is structurally undefined (types.ts, text.ts's quoteHtml and
 * media.ts's mediaList all rely on this).
 *
 * It deliberately does NOT re-assert `__typename`. The content assertion lives once, at the top of
 * fromSyndication (syndicationHasTweet); a nested `quoted_tweet` is already known to be a tweet by
 * its position, and — measured on the quote fixture — it carries NO `__typename` field at all, so
 * re-checking it here would drop every quote. build() still fails closed on the fields it DOES need:
 * a string text (an honest '' is allowed), and a `created_at` that parses.
 *
 * `created_at` is ISO 8601 ('2006-03-21T20:50:14.000Z'), so `new Date(str)` parses it directly.
 * VALIDATE THE Date OBJECT, not the string: an escaped Invalid Date is an uncaught RangeError 500 in
 * mastodon.ts's bare `toISOString()` (the scar TikTok and Bluesky both document). Returns null
 * rather than inventing a Post — a half-built Post renders as a broken embed.
 */
function build(json: Any, ref: Extract<PostRef, { p: 'x' }>): Post | null {
  if (!json || typeof json !== 'object') return null

  // Twitter delivers `text` HTML-entity-encoded (&amp;/&lt;/&gt;); decode HERE so the shared renderer's
  // single esc() is correct and does not double-encode (decodeEntities names the hazard). An honest ''
  // is allowed; a non-string is the fail-closed signal. This is the ONLY place tweet text is read, so
  // the decode reaches both the root body and the depth-1 quoted body (build() is shared).
  const rawText = typeof json.text === 'string' ? json.text : null
  if (rawText === null) return null
  const text = decodeEntities(rawText)

  const created = new Date(typeof json.created_at === 'string' ? json.created_at : NaN)
  if (Number.isNaN(created.getTime())) return null

  const user = json.user
  const handle = handleOf(user?.screen_name)

  // new URL().href re-applies the URL spec's percent-encode set, keeping a hostile field out of the
  // `location` header worker.ts builds from `canonical` (the CR/LF 500 fixed in 4655ee8). With no
  // trustworthy handle we fall back to /i/status/{id}, which resolves without a handle.
  const canonical = new URL(`https://x.com/${handle ?? 'i'}/status/${ref.id}`).href

  const counts: Post['counts'] = {}
  const put = (k: keyof Post['counts'], v: unknown) => {
    // One key at a time so an unusable value leaves the key ABSENT — `counts: { likes: undefined }`
    // or a NaN (which JSON-serializes to null) would reach mastodon.ts where a number belongs.
    const n = count(v)
    if (n !== undefined) counts[k] = n
  }
  // Syndication is leaner than guest: it carries only `favorite_count` and `conversation_count`
  // (measured — no retweet/quote/view). So `reposts` and `views` are simply omitted, and `replies`
  // reads reply_count when present, else conversation_count (the whole-thread size stand-in).
  put('likes', json.favorite_count)
  put('replies', json.reply_count ?? json.conversation_count)
  put('reposts', json.retweet_count)

  return {
    ref,
    canonical,
    author: {
      name: str(user?.name) || handle || '',
      handle: handle ?? '',
      // With no trustworthy handle there is no profile URL to build, so point at the post itself —
      // a link that works — rather than at x.com/i, which names no profile.
      url: handle ? `https://x.com/${handle}` : canonical,
      avatar: httpsUrl(user?.profile_image_url_https) ?? undefined,
    },
    text,
    createdAt: created,
    media: mediaFrom(json.mediaDetails),
    counts,
    // possibly_sensitive IS a real signal here, unlike TikTok/Instagram which are always false (spec
    // §sensitive, fact 8). This is the SUCCESSFULLY-fetched sensitive post — distinct from the age
    // gate, which is a TweetTombstone with no post at all (refused by syndicationHasTweet below).
    sensitive: !!json.possibly_sensitive,
  }
}

/**
 * THE ONE CONTENT ASSERTION, exported so the fetcher (Task 3) reuses this exact spelling rather than
 * re-implementing a second, driftable one (the rule TikTok's videoDetailScope and Instagram's
 * shortcodeMedia both state). True only for an object with `__typename === 'Tweet'`, a string
 * `text`, and a `user` object. It is what tells the three measured traps apart from a real post:
 *   - the missing-token `{}` has no __typename            -> false
 *   - an age-gated `TweetTombstone` has no text/user      -> false
 *   - a 404 HTML "poodle" page is not even an object here -> false
 */
export function syndicationHasTweet(json: unknown): boolean {
  const j = json as Any
  return (
    !!j &&
    typeof j === 'object' &&
    j.__typename === 'Tweet' &&
    typeof j.text === 'string' &&
    !!j.user &&
    typeof j.user === 'object'
  )
}

/**
 * Pure: parsed syndication JSON -> Post, or null. Total over junk: `json` is whatever the fetcher
 * got (or nothing), so every read is defensive.
 *
 * `depth` is how the depth-1 cap is enforced. At depth 0 this is the top-level call: the `__typename`
 * content assertion runs, the core Post is built, and `quote`/`replyTo` are attached. The single
 * recursive call for a quote runs at depth 1, where the assertion is SKIPPED (a nested quoted_tweet
 * carries no __typename) and the attach block does not run — so `post.quote.quote` is never set.
 */
export function fromSyndication(json: unknown, ref: PostRef, depth = 0): Post | null {
  if (ref.p !== 'x') return null
  // The content assertion is a TOP-LEVEL gate only. The recursive depth-1 quote call trusts its
  // caller (build() still fails closed on missing text / bad date), because the quoted_tweet has no
  // __typename to assert on.
  if (depth === 0 && !syndicationHasTweet(json)) return null

  const post = build(json as Any, ref)
  if (!post) return null
  if (depth !== 0) return post

  const j = json as Any

  // QUOTE — the nested `quoted_tweet` (measured: its id is `quoted_tweet.id_str`, NOT the top-level
  // `quoted_status_id_str`, which was null on the fixture). Built through the SAME core extraction
  // with its own ref and depth+1, so its media flow through the same mediaFrom/pickMp4 and it carries
  // no quote/replyTo of its own. Those quoted-media reach a client only via the PARENT's /_media/
  // namespace (mastodon.ts hoists them under the parent refKey) — do not expect a URL keyed on the
  // quote's own id.
  const qt = j.quoted_tweet
  const qid = str(qt?.id_str)
  if (qt && qid) {
    const q = fromSyndication(qt, { p: 'x', id: qid }, depth + 1)
    if (q) post.quote = q
  }

  // REPLY — syndication gives only the parent's HANDLE (in_reply_to_screen_name) and ID
  // (in_reply_to_status_id_str), never the full parent post (no `parent` object — measured). The
  // renderer reads only replyTo.author.{name,handle,url} (text.ts replyPrefix, mastodon.ts
  // authorName), so we build a MINIMAL replyTo carrying exactly that and honest empties elsewhere:
  // text '' (NEVER fabricate the parent's text), media [], counts {}, sensitive false.
  //
  // ref.id, canonical and createdAt must be REAL, because cache.ts's hasValidIdentity re-validates a
  // nested replyTo on deserialize and an empty id / missing canonical / unparseable date makes the
  // WHOLE post round-trip to null. So: a NON-EMPTY parent id (a reply with none cannot get a replyTo
  // — skip it), a canonical of x.com/i/status/{id} (resolves without a handle), and the child's own
  // createdAt as a deterministic, never-rendered stand-in. A parent handle that fails validation is
  // skipped too, because the reply-context line would otherwise name nobody (mastodon.ts authorName).
  const parentId = str(j.in_reply_to_status_id_str)
  const parentHandle = handleOf(j.in_reply_to_screen_name)
  // The reply-context Post is built through the SHARED minimalReplyTo (below), so syndication and
  // guest produce a byte-identical replyTo — one spelling of the cache-guard-critical id/canonical.
  if (parentId && parentHandle) post.replyTo = minimalReplyTo(parentId, parentHandle, post.createdAt)

  return post
}

/**
 * THE MINIMAL reply-context Post — the parent named only by its handle and id, never fetched. Shared
 * by BOTH source shapes' reply branch (syndication reads the parent handle/id off the top-level
 * fields; guest reads them off `legacy`), so the reply-context Post is built ONE way. The renderer
 * reads only replyTo.author.{name,handle,url} (text.ts replyPrefix, mastodon.ts authorName), so we
 * fill exactly that and honest empties elsewhere.
 *
 * ref.id, canonical and createdAt must be REAL — cache.ts's hasValidIdentity re-validates a nested
 * replyTo on deserialize, and an empty id / missing canonical / unparseable date makes the WHOLE post
 * round-trip to null. So a NON-EMPTY parent id (a reply with none cannot get a replyTo — the caller
 * skips it), a canonical of x.com/i/status/{id} (resolves without a handle), and the CHILD's own
 * createdAt as a deterministic, never-rendered stand-in. text is '' — NEVER fabricate the parent's
 * text. `createdAt` is passed in rather than read, because only the child's is available here.
 */
function minimalReplyTo(parentId: string, parentHandle: string, createdAt: Date): Post {
  return {
    ref: { p: 'x', id: parentId },
    canonical: new URL(`https://x.com/i/status/${parentId}`).href,
    author: { name: parentHandle, handle: parentHandle, url: `https://x.com/${parentHandle}` },
    text: '',
    createdAt,
    media: [],
    counts: {},
    sensitive: false,
  }
}

/**
 * ===================================================================================================
 * PATH B — the GUEST-GraphQL normalizer. Same Post out, DIFFERENT bytes in. Where syndication carries
 * `text`/`created_at`/`user`/`mediaDetails` at the top level, guest nests them under `legacy` and
 * `core.user_results.result.core`, one level deeper still for a TweetWithVisibilityResults. So the
 * FIELD-LEVEL helpers are shared verbatim (decodeEntities, mediaFrom, pickMp4, count, dim, httpsUrl,
 * handleOf, str, minimalReplyTo — ONE spelling, because video_info.variants and the reply shape are
 * identical on both paths), but the WALK differs and gets its own builder below. This mirrors
 * Bluesky's build()/normalizeBluesky split for a second on-the-wire shape.
 * ===================================================================================================
 */

/**
 * THE GUEST CORE Post BUILDER — the analogue of build() for the guest walk. `base` is the tweet
 * object that carries `legacy`: for an ordinary Tweet that is `result` itself; for a
 * TweetWithVisibilityResults it is `result.tweet` (GOTCHA 1 — see fromGuest, which picks the base).
 * NEVER sets quote/replyTo (the depth-1 cap, same as build()).
 *
 * Author sits BESIDE legacy under the SAME base: `base.core.user_results.result.{core,avatar}` —
 * measured on real captures (screen_name/name are on `.core`, the avatar on `.avatar.image_url`);
 * `legacy.screen_name`/`legacy.profile_image_url_https` are absent on the guest shape, so reading
 * them would drop the author. Fails closed on a missing/typeless legacy, a non-string full_text, or an
 * unparseable created_at — the same three gates build() keeps, so a half-built Post never renders.
 *
 * `created_at` is Twitter's ruby format ('Tue Mar 21 20:50:14 +0000 2006'); `new Date(str)` parses it.
 * VALIDATE THE Date OBJECT (an Invalid Date is a RangeError 500 in mastodon.ts's bare toISOString()).
 */
function buildGuest(base: Any, ref: Extract<PostRef, { p: 'x' }>): Post | null {
  const legacy = base?.legacy
  if (!legacy || typeof legacy !== 'object') return null

  // full_text is HTML-entity-encoded exactly like syndication's `text` (&amp;/&lt;/&gt;), so decode
  // HERE through the SAME decodeEntities so the shared renderer's single esc() is correct. An honest
  // '' is allowed; a non-string is the fail-closed signal.
  const rawText = typeof legacy.full_text === 'string' ? legacy.full_text : null
  if (rawText === null) return null
  const text = decodeEntities(rawText)

  const created = new Date(typeof legacy.created_at === 'string' ? legacy.created_at : NaN)
  if (Number.isNaN(created.getTime())) return null

  const userResult = base?.core?.user_results?.result
  const uCore = userResult?.core
  const handle = handleOf(uCore?.screen_name)

  // new URL().href keeps a hostile field out of the location header worker.ts builds from canonical
  // (the CR/LF 500 fixed in 4655ee8), and /i/status/{id} resolves with no trustworthy handle.
  const canonical = new URL(`https://x.com/${handle ?? 'i'}/status/${ref.id}`).href

  const counts: Post['counts'] = {}
  const put = (k: keyof Post['counts'], v: unknown) => {
    const n = count(v)
    if (n !== undefined) counts[k] = n
  }
  // Guest is RICHER than syndication: alongside favorite/reply/retweet in `legacy` it carries a view
  // count at `base.views.count` (a STRING — count() coerces and rejects NaN/negative/non-integer).
  put('likes', legacy.favorite_count)
  put('replies', legacy.reply_count)
  put('reposts', legacy.retweet_count)
  put('views', base?.views?.count)

  return {
    ref,
    canonical,
    author: {
      name: str(uCore?.name) || handle || '',
      handle: handle ?? '',
      // No trustworthy handle -> no profile URL to build; point at the post itself (a working link).
      url: handle ? `https://x.com/${handle}` : canonical,
      avatar: httpsUrl(userResult?.avatar?.image_url) ?? undefined,
    },
    text,
    createdAt: created,
    // extended_entities.media is the same entry shape as syndication's mediaDetails (type,
    // media_url_https, original_info, video_info.variants), so mediaFrom/pickMp4 are reused verbatim.
    media: mediaFrom(legacy.extended_entities?.media),
    counts,
    // possibly_sensitive is the successfully-fetched sensitive signal (fact 8), distinct from the age
    // gate (a TweetTombstone, refused by guestOutcome before this ever runs).
    sensitive: !!legacy.possibly_sensitive,
  }
}

/**
 * Pure: parsed guest-GraphQL JSON -> Post, or null. Total over junk — `json` is whatever the fetcher
 * got (or nothing), so every read is optional-chained.
 *
 * THE UNWRAP IS DEFENSIVE ACROSS THE WHOLE PATH, and `?? json` is load-bearing: it lets the SAME
 * function normalize the top envelope at depth 0 AND a bare `result` at depth 1. A quoted status
 * arrives as `result.quoted_status_result.result` — a bare result object, NOT another
 * `{data:{tweetResult}}` envelope — so the recursive call must accept that bare shape or every quote
 * is silently dropped. `base = result.tweet ?? result` then picks the object that carries `legacy`:
 * an ordinary Tweet has it directly; a TweetWithVisibilityResults nests the whole tweet (legacy,
 * core, views, quoted_status_result) under `.tweet` (GOTCHA 1). The naive `result.legacy ??
 * result.tweet.legacy` would THROW when `result` is a number/`{}`/lacks `.tweet` — a future
 * TweetUnavailable or a totality input — so optional chaining and returning null is mandatory.
 *
 * `depth` enforces the depth-1 cap exactly as fromSyndication: at depth 0 the core Post is built and
 * quote/replyTo are attached; the single recursive quote call runs at depth 1, where the attach block
 * does not run — so `post.quote.quote` is structurally undefined.
 */
export function fromGuest(json: unknown, ref: PostRef, depth = 0): Post | null {
  if (ref.p !== 'x') return null
  const j = json as Any
  const result = j?.data?.tweetResult?.result ?? j
  const base = result?.tweet ?? result

  const post = buildGuest(base, ref)
  if (!post) return null
  if (depth !== 0) return post

  // QUOTE — the quoted status is at base.quoted_status_result.result (a bare result). Built through
  // the SAME core-with-unwrap at depth+1, so post.quote.quote is undefined; its media reach a client
  // only via the PARENT's /_media/ namespace (mastodon.ts hoists them under the parent refKey), not a
  // URL keyed on the quote's own id. Its id is the quoted tweet's own rest_id (or legacy.id_str).
  const qr = base?.quoted_status_result?.result
  const qBase = qr?.tweet ?? qr
  const qid = str(qBase?.rest_id) || str(qBase?.legacy?.id_str)
  if (qr && qid) {
    const q = fromGuest(qr, { p: 'x', id: qid }, depth + 1)
    if (q) post.quote = q
  }

  // REPLY — the parent's HANDLE and ID from legacy.in_reply_to_screen_name / _status_id_str, never
  // the full parent post. Built through the SHARED minimalReplyTo (a real id/canonical/createdAt for
  // the cache guard; text '' never fabricated). A reply with no parent id, or an untrustworthy parent
  // handle, gets no replyTo — the reply-context line would otherwise name nobody.
  const legacy = base?.legacy
  const parentId = str(legacy?.in_reply_to_status_id_str)
  const parentHandle = handleOf(legacy?.in_reply_to_screen_name)
  if (parentId && parentHandle) post.replyTo = minimalReplyTo(parentId, parentHandle, post.createdAt)

  return post
}

/**
 * THE SINGLE ENTRY the worker calls (Task 5), so the worker never branches on the on-the-wire shape:
 * it dispatches on `got.source` and both fetch paths funnel through here at depth 0. A guest response
 * goes to fromGuest, a syndication response to fromSyndication.
 */
export function normalizeTwitter(
  got: { source: 'syndication' | 'guest'; data: unknown },
  ref: PostRef,
): Post | null {
  return got.source === 'guest' ? fromGuest(got.data, ref) : fromSyndication(got.data, ref)
}
