import type { Media, MediaIndex, Platform, Post } from '../types.ts'
import { refKey } from '../refkey.ts'

/**
 * Primitives every embed renderer needs. They live here rather than in whichever renderer
 * happened to need them first because Phase 2 added a SECOND consumer for each: the Mastodon
 * mapper emits the same /_media/ urls and the same dimension lie as the OpenGraph path, and
 * two copies of a wire format are two things to keep in sync with router.ts.
 */

// refKey() joins components with a literal ':', which is legal in a path segment
// (RFC 3986) but not guaranteed to survive every edge/proxy unmolested. Discord's
// media proxy (and any CDN in front of it) is free to percent-normalize ':' to
// '%3A'. encodeURIComponent-ing the WHOLE key here means the wire format never
// contains a bare colon in the first place, so there is nothing left for an edge
// to normalize — the router reverses this with a single decodeURIComponent
// before handing the key to parseRefKey (see the `_media` branch in router.ts).
export const mediaUrl = (origin: string, p: Post, i: MediaIndex) =>
  `${origin}/_media/${encodeURIComponent(refKey(p.ref))}/${indexSegment(i)}`

/**
 * The index SEGMENT of a /_media/ url — the serializing half of the wire format router.ts parses.
 *
 * A bare template literal was enough while every index was a number or 'avatar'. The poster form
 * is an object, and `${{poster: 0}}` interpolates to the string '[object Object]' — a url that is
 * perfectly well-formed, routes to notfound, and would have shipped as a broken preview_url on
 * every video. Spelled as a function so the object case cannot be reintroduced by accident.
 */
const indexSegment = (i: MediaIndex) => (typeof i === 'object' ? `poster${i.poster}` : String(i))

/**
 * WHICH /_media/ INDEX HOLDS THIS ENTRY'S BYTES — the poster slot for a degraded still, the bare
 * array position for everything else. Every renderer that mints a PICTURE url from an array position
 * asks this instead of passing the position straight to mediaUrl().
 *
 * ONE spelling, because THREE heads mint that url (mastodon.ts's media_attachments and both plain-og
 * og:image branches) and all three shipped the same defect: settleMux's degrade rewrites a `{page}`
 * remux video into its poster STILL without moving it, and the bare index still addresses the VIDEO
 * on the /_media/ route, which answers 503 no-store. See Media.posterOnly for the measurement.
 *
 * IT CHANGES NO URL'S CONTENTS. It only chooses between two urls that are already correct, so the
 * 2026-07-24 rule (a video url must never answer with an image) is untouched — and no player tag can
 * receive a poster slot: videoTags/spoofVideoTags/telegram's video branch all mint from
 * `mediaOf(post).indexOf(video)` on an entry selected by kind === 'video', and this returns the bare
 * index for any such entry regardless of the flag.
 *
 * ALL THREE CLAUSES ARE LOAD-BEARING. `posterOnly` is the signal; `str(m.poster)` is posterUrl()'s
 * existing paranoia (pickMedia's poster branch has NO fallback to m.url, so a flag without a poster
 * would advertise a guaranteed 404); `kind !== 'video'` makes "the flag can never move a video url"
 * structural rather than merely true today.
 */
export const bytesIndex = (m: Media, i: number): MediaIndex =>
  m?.posterOnly && m.kind !== 'video' && str(m.poster) ? { poster: i } : i

/** Discord drops 4K and postage-stamps low-res, so we lie about dimensions. */
export function fudge(w: number, h: number): [number, number] {
  if (w > 1920 || h > 1920) return [Math.round(w / 2), Math.round(h / 2)]
  if (w < 400 && h < 400 && w > 0 && h > 0) return [w * 2, h * 2]
  return [w, h]
}

/**
 * The two dimension tags for a picture, or NOTHING when we do not have real dimensions.
 *
 * usable() blesses a media entry on its `url` ALONE, and deserializePost never validates w/h —
 * so `{kind:'image', url:'…'}` with no dimensions is a shape a corrupted cache record can hand
 * a renderer. Every comparison in fudge() is false against undefined, so it returns the pair
 * untouched and a bare template literal then shipped `content="undefined"` to a crawler:
 * measured on both OpenGraph heads, a non-numeric dimension out of the same corrupted record
 * the rest of this file exists to defend against.
 *
 * OMITTING both tags is the right degradation rather than defaulting them, because OGP reads a
 * missing width/height as "size it yourself" while a wrong one is a wrong layout. mastodon.ts
 * already makes exactly this call at its own call site — it drops the whole `meta` block rather
 * than ship a malformed one — so this is that established rule, shared, for the two OG heads
 * that were still missing it. Shared rather than spelled twice for the reason everything else
 * here is: two renderers is two places for one of them to quietly stop guarding.
 *
 * FINITENESS ONLY, DELIBERATELY — and a `<= 0` gate was tried here on 2026-07-25 and REVERTED the
 * same day, which is worth more than the original note. The evidence that prompted it was real but
 * FACEBOOK-ONLY: the fb head shipped og:video:width="0" for a video that is really 576x1024, because
 * the container's meta call was not reporting dimensions it had. That is fixed AT THE SOURCE now
 * (container/server.py's _meta_page returns width/height; normalizeFacebook carries them), so this
 * shared primitive does not have to guess on behalf of one platform.
 *
 * WHY THE GATE COULD NOT STAY, since it looked strictly safer: 0 is a LIVE, SHIPPED, HUMAN-VERIFIED
 * value on platforms that already work. youtube/normalize.ts sets w:0,h:0 with the note "Discord reads
 * the muxed mp4's real dimensions"; reddit/normalize.ts, tiktok/normalize.ts's slideshow cover, and
 * every Threads/Bluesky entry with no aspectRatio do the same. Dropping their two tags is a
 * SPECULATIVE SUBTRACTION from a verified head, which is exactly what discord.ts's spoofVideoTags
 * docstring forbids in as many words ("MUST NOT do so speculatively, because three speculative
 * subtractions have already been wrong, and each one costs a human a Discord test to discover") —
 * on evidence gathered from a different platform than the ones it would have changed.
 *
 * mastodon.ts's originalMeta DOES drop its block on `w <= 0`, and the two surfaces disagreeing is
 * deliberate rather than an oversight: its `aspect: w/h` would be Infinity, which JSON.stringify
 * silently writes as null, and `size: "0x0"` is a different claim than an OGP width. If someone wants
 * them to agree, that is a change to shipped verified output on five platforms and it wants its own
 * evidence and its own decision — the same sentence this docstring carried before, still true.
 */
export function dimTags(prefix: string, w: number, h: number): string[] {
  const [fw, fh] = fudge(w, h)
  if (!Number.isFinite(fw) || !Number.isFinite(fh)) return []
  return [
    `<meta property="${prefix}:width" content="${fw}"/>`,
    `<meta property="${prefix}:height" content="${fh}"/>`,
  ]
}

/**
 * Every renderer's input arrives from the KV cache, and deserializePost validates identity
 * and dates only — never text, never author.*. The Post type is therefore a claim about the
 * normalizer, not about the real input: a number, null or an object can reach a renderer.
 * Downstream that is a 500 (esc() throws `s.replace is not a function`) or a payload reading
 * "[object Object]", on routes whose entire contract is to degrade.
 */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * "This entry can actually become a picture." ONE definition, imported by every consumer,
 * because two consumers disagreeing about it is a live defect class rather than a tidiness
 * argument: discord.ts's gate decides whether to suppress all image tags, and mastodon.ts's
 * attachments() decides what the gallery contains. When the gate said yes and the mapper
 * produced [], the post got no picture by EITHER route — measurably worse than Phase 1, which
 * would at least have fallen back to the avatar. Spelling the rule twice is how that happened.
 *
 * The three clauses are not interchangeable defensiveness. media[] is never validated by
 * deserializePost (it checks ref, canonical and createdAt and nothing else), so a corrupted
 * cache record can hand us null or a primitive — and a raw `m.kind` read on those is a
 * TypeError, a 500 out of a module whose entire contract is to degrade. The url clause is the
 * same rule the avatar branch states: an OBJECT with no url clears the typeof check but
 * resolves through pickMedia to null, so advertising it promises an image guaranteed to 404,
 * and a 404 image is worse than no image.
 *
 * Index-preserving by design — callers must FILTER NOTHING, only test. /_media/{key}/{index} is
 * resolved by pickMedia against the raw, UNCOMPACTED list (mediaList since §7), so compacting
 * here would make every entry after a corrupt one serve the wrong image.
 */
/**
 * THE BYLINE — `Name (@handle)`, or just `Name` when there is no handle.
 *
 * ONE SPELLING, because there were SIX. discord.ts built it twice, telegram.ts once and text.ts three
 * times, each independently, which is precisely the shape this file exists to collapse — the same
 * argument themeColor and usable() carry, and the same way one of them ends up drifting.
 *
 * THE EMPTY CASE IS THE REASON THIS LANDED (2026-07-30). A Facebook GROUP post has no @-handle at all
 * — a group has an id, not a username — so fbAuthor leaves it empty, and all six sites rendered the
 * literal `GMT800s With Threatening Auras v2 (@)`. Worse, the commit that introduced the empty handle
 * ASSERTED in its own comment that "the renderers already omit an empty one instead of printing
 * `(@)`". They did not. This makes that sentence true.
 *
 * A missing NAME is left alone rather than substituted: every normalizer already defaults it, and a
 * blank byline is a different bug that belongs where the name is chosen.
 */
export function byline(author: unknown): string {
  const a = author as { name?: unknown; handle?: unknown } | undefined
  const name = str(a?.name)
  const handle = str(a?.handle)
  return handle ? `${name} (@${handle})` : name
}

export function usable(m: unknown): m is Media {
  return !!m && typeof m === 'object' && !!str((m as Media).url)
}

/**
 * post.media as an ARRAY, whatever the cache actually handed us. deserializePost validates
 * ref, canonical and createdAt and nothing else, so a corrupted record can carry a string, a
 * number or nothing at all here — and the difference is not academic: a bare
 * `post.media.length > 0` reads 3 on a string (sending a post with no images down a
 * has-media branch) and throws on undefined, a 500 out of the one module whose entire
 * contract is to degrade.
 *
 * Array-ness is only half the guard; every read of an ENTRY still goes through usable().
 * Array.isArray says nothing about what is inside, and `media: [null]` cleared this check,
 * fired discord.ts's spoof gate, and then produced media_attachments: [] — an embed with no
 * picture by either route.
 *
 * NOT filtered, only wrapped — every consumer indexes /_media/{key}/{i} against the raw,
 * uncompacted list, so compacting here would make every entry after a corrupt one serve the
 * wrong image. Note that "the raw list" is no longer one array for everyone: since §7,
 * mastodon.ts and pickMedia index mediaList (this array, then the quote's), while the two
 * OpenGraph heads deliberately select from this array ALONE. Both are safe against the SAME
 * index because the hoist appends — parent entries keep 0..n-1 — but they are not the same
 * list, and an editor who reads them as one will break the quote-only case.
 *
 * Shared for the reason everything else in this file is: telegram.ts is the third consumer, and
 * three copies of a totality guard are three places for one of them to quietly stop being total.
 *
 * Takes `Post | undefined` since §7, so mediaList() can ask it about `post.quote` — which is
 * absent on almost every post — without spelling the absent case as a second, subtly
 * different guard.
 */
export const mediaOf = (post: Post | undefined): Media[] => {
  const m = post?.media
  return Array.isArray(m) ? m : []
}

/**
 * "Warn about this post." The parent's own flag, OR a sensitive QUOTE that actually contributed
 * a picture to the gallery — because §7's hoist made the second case reachable and nothing else
 * followed it.
 *
 * normalize.ts computes `sensitive` PER post from that post's own `labels`, and Bluesky attaches
 * moderation labels to the record that HOLDS the media, so `parent.sensitive === false` with
 * `quote.sensitive === true` is the ordinary real-world shape — unlabelled commentary quoting a
 * self-labelled post — not a corrupted-cache hypothetical. Proven through normalizeBluesky, not
 * a hand-built Post (see test/quote-media.test.mjs). Before this, the hoist shipped that quoted
 * NSFW image to a Discord viewer with the warning on no surface at all, and §7 is what created
 * the exposure: pre-hoist the picture reached nobody, because the plain head drew the avatar and
 * media_attachments was empty.
 *
 * That matters more here than the usual "nice to have a label", because mastodon.ts deliberately
 * emits `spoiler_text: ''` and no `sensitive` field — Mastodon's blur mechanism would hide
 * exactly the media Discord came for — so the `[sensitive] ` prefix is the ONLY signal that
 * exists on the spoof path. There is nothing to degrade to. The repo has already regressed on
 * this once (commit faab291, "restore the sensitivity signal").
 *
 * Gated on the quote having USABLE media, deliberately, rather than on `quote.sensitive` alone:
 * the picture is what §7 newly puts in front of a viewer. A sensitive quote carrying nothing
 * usable reaches exactly the surfaces it reached before §7 — its TEXT, in `content` and
 * og:description, unlabelled — and relabelling those is a change to output Phase 1 verified in a
 * real client, so it wants its own evidence and its own decision rather than a ride on this fix.
 *
 * ONE level, matching mediaList: a cache record is not the normalizer's output by the time it
 * reaches a renderer, and reading `post.quote.quote` would be a walk of unbounded depth on a
 * route with no try/catch.
 */
export const isSensitive = (post: Post): boolean =>
  !!post.sensitive || (!!post.quote?.sensitive && mediaOf(post.quote).some(usable))

/**
 * "This post has a video Discord can actually play." ONE definition, because BOTH heads in
 * discord.ts now ask it — renderSpoof for its og:video fallback and renderPost for the plain
 * head's video branch — and they must not answer it differently. The same rule usable() and
 * mediaOf() exist for.
 *
 * THREE CALLERS AS OF 2026-07-19, and the count has moved twice in one day. They used to be "the
 * C1 gate and the plain head's video selection"; the gate went with the video carve-out it
 * implemented, renderSpoof took its place, and the production-parity change then split the spoof
 * head's player tags into their own builder — so it is now videoTags(), spoofVideoTags() and
 * renderPost's own selection. The shared-predicate argument only got STRONGER: the two heads
 * deliberately emit different player tags now, which makes "they must at least agree on WHICH
 * video, in WHICH list" the thing holding them together.
 *
 * mediaOf(post), NOT mediaList(post): both heads select a video from the post's OWN media with
 * quote media deliberately excluded, so answering over the hoisted list would make a post whose
 * QUOTE carries a video advertise an og:video — with an index computed against a different array
 * than the one that mints /_media/ urls, i.e. a player pointing at one of the parent's pictures.
 * The quoted video still reaches the viewer through the §7 gallery, which is its proper surface.
 *
 * usable() before the kind read, for the reason it always comes first: media[] is never
 * validated by deserializePost, so `media: [null]` reaches here from a corrupted cache record
 * and a raw `m.kind` on it is a TypeError — a 500 out of a module whose contract is to degrade.
 * Its url clause is load-bearing here too and not merely defensive: a video entry with no url
 * resolves through pickMedia to null, so emitting a fallback for it would advertise a player
 * guaranteed to 404.
 *
 * Returns the Media rather than a boolean so the caller can take its index off the same array
 * it was found in. An index recomputed against a different list is the other half of this bug.
 */
export const playableVideo = (post: Post): Media | undefined =>
  mediaOf(post).find(m => usable(m) && m.kind === 'video')

/**
 * The index of the entry whose mux is still running and will be PROMISED by the activity document,
 * or -1. Read by the spoof head to stand the stock player down and to put the poster in og:image
 * (Media.pendingMux). Same list as playableVideo, for the same reason: the index has to be taken off
 * the array that mints /_media/ urls. Null-guarded because media[] is never validated on the way
 * out of the cache.
 */
export const pendingMuxIndex = (post: Post): number =>
  mediaOf(post).findIndex(m => m != null && typeof m === 'object' && m.pendingMux === true)

/**
 * The embed's accent colour, per platform.
 *
 * #0085ff is the verified Bluesky head — the colour a real Discord client was observed
 * rendering at the end of Phase 1. #ff0050 is production fxtiktok's MEASURED value, read off
 * its own live plain-og video head, not a colour anyone picked. The x/ig/th/rd rows are
 * UNVERIFIED placeholders: those platforms have no fetcher, so no Post can reach them yet.
 */
const THEME: Record<Platform, string> = {
  bs: '#0085ff', tt: '#ff0050', x: '#000000', ig: '#c13584', th: '#000000', rd: '#ff4500', yt: '#ff0000', fb: '#1877f2',
  dm: '#0066dc', st: '#0f90fa', im: '#1bb76e', tw: '#9146ff', lm: '#00bc8c', ms: '#6364ff', mk: '#86b300', pt: '#f1680d', pn: '#e60023',
}

/**
 * ONE definition, imported by BOTH heads — the same rule usable(), mediaOf() and playableVideo()
 * are here for, and with a live defect behind it rather than a tidiness argument. The spoof head
 * has always had a theme-color (hardcoded Bluesky blue); the plain head had never had one AT ALL.
 * While Phase 3a's video carve-out existed that meant a TikTok VIDEO post — the whole point of
 * that phase — rendered with no accent colour whatever, which is what forced the fix.
 *
 * THAT PARTICULAR EXPOSURE IS GONE (the carve-out was removed 2026-07-19; a Discord video post
 * takes the spoof head, which always had the tag) AND THE SHARING STILL STANDS. 'other-bot' still
 * reaches the plain head with a post of any platform, and two heads spelling this separately is
 * precisely how one of them ended up without it, and how it would end up without it again.
 *
 * The string-RESULT guard, not a fallback keyed on absence: ref.p arrives from the KV cache
 * unvalidated, and a raw lookup on an object literal inherits Object.prototype, where
 * 'constructor' is a function and '__proto__' is an object — neither undefined, so `??` never
 * fires. Interpolating a function into a meta tag ships the source text of Object into the
 * head. Same rule mastodon.ts's applicationName() states, and the same scar behind both.
 *
 * Defaults to #0085ff rather than to nothing: it is the one colour a real client has been
 * observed rendering, and a corrupted ref should degrade to a verified embed, not a bare one.
 */
export function themeColor(post: Post): string {
  return themeOf((post?.ref as { p?: Platform } | undefined)?.p)
}

/**
 * THE SAME TABLE, ASKED BY PLATFORM RATHER THAN BY POST — because the profile head has no Post to
 * ask with, and a second copy of this table is the exact defect the docstring above records (one
 * head with a colour, one without, for months).
 *
 * The string-RESULT guard moved here with the lookup and matters more, not less: `p` now arrives
 * from a Profile as well as a Post, both of which are shaped by code rather than validated on
 * read, and a raw lookup on an object literal inherits Object.prototype — 'constructor' resolves
 * to a function, '__proto__' to an object, and neither is undefined, so `??` never fires and the
 * source text of Object ships inside a meta tag.
 */
export function themeOf(p: unknown): string {
  const v: unknown = THEME[p as Platform]
  return typeof v === 'string' ? v : '#0085ff'
}

/**
 * Phase 1's sensitive marker, applied by whichever renderer is building a description.
 *
 * Shared rather than re-spelled per head because it has already gone missing once: text.ts's
 * builders deliberately do not apply it (one owner per concern) and mastodon.ts applies its
 * own to `content`, so a head that forgets this call simply ships without the signal — no
 * error, no test failure unless that head has its own assertion, and a straight regression
 * against what Phase 1 shows every viewer today.
 *
 * The PREDICATE is shared with mastodon.ts for the same reason the marker text is: two surfaces
 * answering "is this sensitive" two different ways is how the warning lands on whichever one the
 * consumer did not read. Truthiness on `post.sensitive`, matching Phase 1's rule exactly, so a
 * corrupted cache value errs toward SHOWING the warning.
 */
export const describe = (post: Post, text: string) => (isSensitive(post) ? `[sensitive] ${text}` : text)
