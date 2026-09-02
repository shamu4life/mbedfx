import type { Media, Platform, Post } from '../types.ts'
import { mediaList } from '../media.ts'
import { refKey } from '../refkey.ts'
import { encodeStatusId } from '../statusid.ts'
import { bytesIndex, fudge, isSensitive, mediaOf, mediaUrl, str, usable } from './embed.ts'
import { buildContentHtml, statParts, withVideoGalleryMarker } from './text.ts'

/**
 * The Mastodon-spoof payloads: a Mastodon API v1 `Status` and the oEmbed document whose
 * `author_name` supplies the embed's top line. Both are pure — no I/O, and no clock, so the
 * same Post always maps to the same bytes. `created_at` comes from post.createdAt, never
 * from Date.now(), because these responses are cached and a clock read would make two
 * identical requests differ.
 *
 * Field names, and equally which fields are ABSENT, follow the wire spec's §6c/§6d — both
 * derived from live FxEmbed output, which ships to 100% of their Discord traffic and is
 * therefore the strongest available evidence about what Discord accepts. Where we differ,
 * the deviation is marked and reasoned.
 */

/**
 * Media.kind -> Mastodon attachment type.
 *
 * 'video' IS THE ROW THAT DRAWS THE INLINE PLAYER, and as of 2026-07-19 it is live rather than
 * theoretical. Removing the video carve-out put every Discord video post on this document, and
 * Discord builds its player from `media_attachments[].type === "video"` — not from og:video, which
 * this repo now emits only as an OpenGraph fallback. Production fxtiktok's own status JSON was
 * measured the same day and agrees exactly: one attachment, type "video", url on its own origin,
 * meta.original 720x1280. Nothing about this table needed to change for that to work, which is
 * why the whole change landed in discord.ts.
 *
 * 'gif' maps to 'image', NOT to Mastodon's 'gifv'. 'gifv' promises a soundless looping
 * VIDEO — Mastodon transcodes uploaded GIFs to mp4 and that type describes the mp4, not the
 * GIF — whereas our Media.kind 'gif' means the url IS an animated .gif file. Handing a video
 * player an image file is Phase 1's I-1 defect exactly (an HLS playlist advertised as
 * og:video rendered a dead player), and Discord animates a GIF served as an image anyway.
 * Reddit reaches this: an i.redd.it `.gif` surfaces as kind:'gif' and maps here to 'image' — a real
 * animated gif Discord plays as a picture, exactly the intent. (Bluesky video is a remux kind:'video'
 * since 2026-07-22, and TikTok emits 'video' or a still cover — neither a 'gif'.)
 */
const ATTACHMENT_TYPE: Record<Media['kind'], string> = {
  image: 'image',
  video: 'video',
  gif: 'image',
}

/**
 * The Mastodon attachment type a Media entry would be emitted as.
 *
 * NOT `ATTACHMENT_TYPE[m.kind] ?? 'image'`. That is a raw lookup on an object literal, so it
 * inherits Object.prototype and `??` never fires for an inherited key — neither a function nor an
 * object is undefined or null. A corrupt kind of 'constructor'/'toString'/'valueOf' resolved to a
 * FUNCTION, which JSON.stringify silently drops, shipping an attachment with no `type` field at
 * all; '__proto__' shipped `"type":{}` where §6c requires a string. Checking the RESULT is a
 * string is total over every possible key, unlike a fallback keyed on absence: Object.prototype
 * carries no string-valued member.
 *
 * Named rather than inlined because galleryHasVideo() below must ask the SAME question attachment()
 * does — "does this entry emit as a video?". Answering it on `m.kind` instead would get 'gif' wrong:
 * a gif emits type "image", so a gif is a still and does not trip the video gate, whereas a
 * kind-based test would count it as neither image nor video. Two spellings of "what type is this"
 * is how they drift.
 */
function attachmentType(m: Media): string {
  const t: unknown = ATTACHMENT_TYPE[m.kind]
  return typeof t === 'string' ? t : 'image'
}

/**
 * "This is a MULTI-ITEM gallery containing at least one video, so every video child must be
 * flattened to a poster still" — the gate for both the attachment flattening (attachment() below)
 * and the visible `content` marker (via hasConvertedVideo).
 *
 * WIDENED 2026-07-20, and the name changed with it. This was `isMixedGallery`, meaning "image AND
 * video both present", born from a measurement: on the Instagram carousel /p/DaQ5CPTki4E our wire
 * output was correct by every other standard — 10 attachments, types interleaved
 * image,image,video,image,video,image,video,image,video,image, every video carrying a distinct real
 * JPEG poster in preview_url, all on our origin, all one hop — and DISCORD DREW SIX AND SILENTLY
 * DISCARDED THE FOUR VIDEOS. The gate now also covers an ALL-VIDEO carousel, because a second
 * measurement showed that shape is no better off: an all-video Instagram post renders in Discord as
 * ONE playable video with the other N-1 items HIDDEN (a 10-video post drew a single player).
 *
 * WHY DISCORD LOSES THEM — established, and it is the same root cause for both shapes:
 *
 *  - Discord cannot render mixed-type galleries at all. FxEmbed issue #1113 ("add support for
 *    twitter's mixed media feature") is CLOSED / NOT_PLANNED, maintainer comment: "Discord and
 *    Telegram won't allow mixed media in embeds unfortunately."
 *  - A mixed array is not legal Mastodon. Mastodon's own post service raises "Cannot attach a video
 *    to a post that already contains images" whenever size > 1 and any attachment is audio/video,
 *    and Status::MEDIA_ATTACHMENTS_LIMIT is 4. Discord's consumer has therefore never seen a mixed
 *    set from a real Mastodon server, so there is no defined behaviour for it to have.
 *  - DISCORD KEEPS THE TYPE OF THE FIRST ATTACHMENT. Two observations, one rule: FxEmbed's array
 *    starts `video` and its 3 images drop; ours starts `image` and its 4 videos drop. In an
 *    all-video array the first type IS every type, so nothing is discarded on TYPE grounds — but
 *    only the first attachment renders as a player anyway, so the other videos are still lost.
 *  - The gallery is NOT capped at 4 on this path — six rendered, measured. So the loss is not length.
 *
 * THE TRADEOFF, OWNER-DECIDED 2026-07-20 AND ACCEPTED WITH EYES OPEN. For a MIXED gallery the
 * conversion is pure gain: the videos render as NOTHING today, so turning them into visible poster
 * stills costs no player anyone was shown. For an ALL-VIDEO gallery it is a deliberate TRADE: today
 * Discord draws ONE inline player, and flattening replaces that one player with N poster stills so
 * that every item is VISIBLE instead of one playable and the rest invisible. The owner has SEEN the
 * one-player render and chosen every-item-visible over it. Real playback is not lost outright — it
 * still ships on the surface that can carry it (discord.ts's og:video head fallback, untouched, for
 * OpenGraph and every non-Discord consumer). Do not re-add the inline player on this path.
 *
 * A SINGLE video is deliberately NOT covered (usableCount > 1): a lone reel/TikTok video renders a
 * real inline player, verified in a real client, and there is no sibling being hidden to justify
 * trading it away. That line is load-bearing — it is the one thing this widening must not move.
 *
 * IT LIVES HERE, IN THE SHARED MAPPER, RATHER THAN IN THE INSTAGRAM PLATFORM CODE. This is a
 * property of what DISCORD accepts, not of Instagram — Instagram is merely the first platform whose
 * ordinary shape trips it. Twitter's own galleries are the next one, and putting the rule in a
 * normalizer would mean discovering it again per platform.
 *
 * usable() FIRST, so a dead entry cannot vote — on the count OR on the video test. media[] is never
 * validated by deserializePost, so `media: [null, <video>]` is a reachable cache record; it
 * contributes no attachment, so it leaves usableCount at 1 and the gallery is a single video that
 * is left alone, not a two-item gallery flattened by a phantom.
 */
/**
 * THE POST'S OWN VIDEO IS THE CONTENT; A QUOTE IS CONTEXT — and hoisting the quote's media used to
 * cost the reader the player.
 *
 * REPORTED 2026-07-31 on x:2082783260523020766, against fxtwitter which shows the video:
 *
 *     post  media: 1 video (1080x1080)
 *     quote media: 1 video (388x360)
 *     mediaList   : 2 videos -> galleryHasVideo -> BOTH flattened -> two stills, no player
 *
 * galleryHasVideo asks its question over mediaList(), "the array Discord actually receives", and that
 * reasoning is right for a post whose OWN media is a gallery. It is wrong when the post is a single
 * video that happens to quote something: the second item exists only because we hoisted it, and
 * flattening then destroys the one thing the post is.
 *
 * NOT FLATTENING IS SAFE HERE, by this file's own measurement: Discord keeps the type of the FIRST
 * attachment and only the first renders as a player. So the main video plays and the quote's media is
 * lost — which is exactly what fxtwitter does, and what the owner asked for.
 */
function ownVideoLeads(post: Post): boolean {
  const own = mediaOf(post).filter(usable)
  return own.length === 1 && attachmentType(own[0]) === 'video'
}

function galleryHasVideo(list: Media[]): boolean {
  let usableCount = 0
  let video = 0
  for (const m of list) {
    if (!usable(m)) continue
    usableCount++
    if (attachmentType(m) === 'video') video++
  }
  return usableCount > 1 && video > 0
}

/**
 * "This gallery flattens videos AND at least one of them was actually converted to a still" — the
 * gate for the VISIBLE content marker (see contentWithMarker below and withVideoGalleryMarker in
 * text.ts). It is what keeps the visible marker and the invisible flattening from ever disagreeing.
 *
 * It must answer YES on exactly the posts where attachment() emits a converted video, and NO on
 * every other shape. attachment() converts an entry when `hasVideo && declared === 'video'` and
 * then DROPS it when it has no poster (`if (flatten && !poster) return null`), so a video becomes a
 * still PRECISELY when the gallery is a multi-item gallery with a video (mixed OR all-video) and
 * that video carries a usable poster. This asks that same question with the same primitives:
 * galleryHasVideo() is the very predicate that sets `hasVideo` in attachments(), and str(m.poster)
 * is the exact test posterUrl() makes. A flattening gallery whose only poster-bearing video has no
 * poster converts NOTHING — every video is dropped, not stilled — and so gets no marker; a
 * "contains video" label with no converted still behind it is the mismatch this shuts out.
 *
 * usable() first, for the reason galleryHasVideo() applies it too: a dead entry cannot vote, so a
 * `media: [null, <video>]` cache record cannot manufacture a phantom conversion here.
 */
function hasConvertedVideo(list: Media[]): boolean {
  return (
    galleryHasVideo(list) &&
    list.some(m => usable(m) && attachmentType(m) === 'video' && !!str(m.poster))
  )
}

/**
 * §6c's `meta.original`, or null when the dimensions are unknown.
 *
 * DEVIATION from the plan, which said to apply Phase 1's fudge() to everything: live
 * evidence shows FxEmbed sending TRUE dimensions for images (4000x2250 among them, mixed
 * orientations, all four rendering) and size-multiplying only video. fudge() exists because
 * Discord drops an oversized og:image and postage-stamps a tiny one; media_attachments is a
 * different consumer, and lying there throws away the real aspect ratio for no observed gain.
 *
 * Omitting the whole block on a zero dimension rather than emitting it is deliberate.
 * normalize.ts defaults w/h to 0 whenever the AT record carries no aspectRatio, so 0 is a
 * live value, and both naive outputs are worse than silence: `aspect: w/h` is Infinity, which
 * JSON.stringify SILENTLY writes as `null` (a deliberate-looking null nobody wrote), and
 * `size: "0x0"` tells the client the image has no area. No meta means "size me yourself".
 */
function originalMeta(m: Media, type: string): object | null {
  const [w, h] = type === 'video' ? fudge(m.w, m.h) : [m.w, m.h]
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { original: { width: w, height: h, size: `${w}x${h}`, aspect: w / h } }
}

/**
 * A video attachment's poster url, or null when the entry has no usable poster.
 *
 * ONLY WHEN THE Media ACTUALLY CARRIES ONE — the same rule, and the same scar, as the avatar in
 * toMastodonStatus below. pickMedia returns null for an absent poster, so an unconditional
 * /_media/{key}/poster{i} would advertise a guaranteed 404, and Phase 1 already paid for that
 * lesson with og:image=".../_media/undefined/avatar", a picture-shaped hole in every embed. Here
 * it would be worse than a hole: a preview_url that 404s is indistinguishable, from Discord's
 * side, from the video-bytes-for-a-poster response that lost us the card in the first place.
 *
 * str() rather than a truthiness test on the raw field, because media[] arrives from the KV cache
 * unvalidated (deserializePost checks ref, canonical and createdAt and nothing else): a poster of
 * 42 or {} is a reachable shape, and both would interpolate into a plausible-looking url.
 */
function posterUrl(post: Post, origin: string, m: Media, index: number): string | null {
  return str(m.poster) ? mediaUrl(origin, post, { poster: index }) : null
}

/**
 * The `description` of a CONVERTED video — the author's own alt text with a video marker composed
 * onto it, or the bare marker when there is none.
 *
 * THE DECISION, stated rather than left invisible: converted videos ARE marked, and as of
 * 2026-07-20 they are marked on BOTH surfaces — here in `description` (Mastodon ALT TEXT) and, for
 * the whole gallery, as a leading line in `content` (contentWithMarker -> withVideoGalleryMarker in
 * text.ts). The two are complementary, and this alt-text tag is deliberately KEPT alongside the
 * visible marker rather than replaced by it.
 *
 * WHY MARK AT ALL. The conversion is lossy in exactly one respect. A viewer sees a still frame with
 * nothing telling them it is a video, so nothing tells them to click through to the post for the
 * motion. Everything else about the change is pure gain (four blanks become four visible frames);
 * this is the one thing it takes away, and marking is a cheap way to give it back.
 *
 * WHY KEEP `description` NOW THAT `content` CARRIES THE VISIBLE CUE. Two reasons the content marker
 * does not cover:
 *
 *  1. SEMANTICALLY THE RIGHT FIELD, AND PER-ENTRY. `description` is Mastodon's ALT TEXT, and "this
 *     frame is a video" is true, useful alt text for a screen reader independently of anything
 *     Discord draws — attached to the exact frame it describes, which a per-POST `content` line
 *     cannot be. It earns its keep even in the world where Discord ignores it entirely.
 *  2. IT COSTS NOTHING. It rides only the converted attachments, so an unconverted gallery is byte-
 *     identical; there is no reason to drop a harmless accessibility win when adding the visible one.
 *
 * THE VISIBLE MARKER IS THE ONE DISCORD DRAWS. `content` is the embed BODY Discord demonstrably
 * renders — caption, counts, reply prefix, `[sensitive] ` label, all human-verified — which is why
 * the cue a sighted Discord viewer needs lives THERE, while this `description`/alt text is the
 * accessibility companion. Earlier this file argued `content` was only "where to try next" if a
 * client showed alt text undrawn; the owner has since decided the visible line ships, so it does.
 *
 * COMPOSES rather than replaces. Clobbering an author's real alt text to say "Video" would trade
 * accessibility information for accessibility information, at a loss.
 */
function markConverted(alt: string): string {
  return alt ? `Video: ${alt}` : 'Video'
}

/**
 * One `media_attachments[i]`. `index` is the entry's index in the RAW mediaList(post) — the
 * post's own media followed by its quote's — and must stay that way: /_media/{key}/{index} is
 * resolved by pickMedia, which indexes that same raw list, so compacting it (the obvious
 * `.filter().map()`) would make every attachment after a corrupt entry serve the wrong image.
 *
 * `post` is the PARENT even for a hoisted entry, and that is deliberate rather than
 * incidental — mediaUrl builds the URL from post.ref, and the parent's refKey is the only key
 * that names a cached record containing the quoted image. The quote's own ref looks equally
 * plausible in a URL and resolves to nothing: it was never cached as a post of its own.
 */
function attachment(post: Post, origin: string, m: Media, index: number, hasVideo: boolean): object | null {
  // Shared with discord.ts's spoof gate rather than spelled out here, which is the point:
  // this function decides what the gallery contains and that gate decides whether to suppress
  // every image tag on the way to it, so the two asking the same question two different ways
  // is how a post ends up with no picture by either route. See usable() for the reasoning
  // behind each clause. Dropping an entry here costs no index, because the index comes from
  // the loop counter in attachments() rather than from output position.
  if (!usable(m)) return null

  // bytesIndex, NOT the bare `index`: a settleMux DEGRADED STILL keeps the video's array position, and
  // that position addresses the VIDEO slot, which answers 503 no-store until the mux lands (it never
  // does for a video the container refuses outright). The still's bytes are at poster{index}. Every
  // other entry gets the bare index, byte for byte — see bytesIndex, the only reader of posterOnly.
  const own = mediaUrl(origin, post, bytesIndex(m, index))
  const declared = attachmentType(m)
  const poster = declared === 'video' ? posterUrl(post, origin, m, index) : null

  // THE MULTI-ITEM GALLERY FLATTENING. A video inside a multi-item gallery that has any video is
  // emitted as an IMAGE attachment pointing at its POSTER, so that every child renders instead of a
  // subset. See galleryHasVideo() above for the two measurements (a mixed carousel drew six of ten;
  // an all-video carousel drew one of N) and for why Discord's constraint, not the platform's shape,
  // owns it.
  //
  // TWO SHAPES, TWO WARRANTS. For a MIXED gallery there is no inline playback to lose: Discord
  // discards the videos outright, so converting blanks into visible frames costs no player anyone
  // was shown. For an ALL-VIDEO gallery Discord DOES draw one inline player (and hides the rest);
  // flattening trades that single player for N visible poster stills — the owner's decision, made
  // with the one-player render seen, to prefer every-item-visible over one-playable-rest-invisible.
  //
  // A SINGLE video is untouched (`hasVideo` is false for it — see galleryHasVideo's usableCount > 1),
  // and that is the line that must not move: a lone reel/TikTok video keeps a real player, verified
  // in a real client, with no hidden sibling to justify trading it away.
  //
  // REAL PLAYBACK STILL SHIPS, on the surface that can carry it: discord.ts's og:video fallback is
  // untouched and still addresses the real mp4, so the OpenGraph path and every non-Discord consumer
  // get the video. The gallery gives up what the gallery cannot do; the head keeps what it can.
  const flatten = hasVideo && declared === 'video'

  // A CONVERTED VIDEO WITH NO POSTER IS DROPPED, never emitted pointing at the video. Pointing an
  // image attachment at an mp4 is the EXACT defect fixed on 2026-07-19 — Discord requests the
  // poster, receives video bytes, and abandons the whole rich card — so "fall back to the url" here
  // would trade four invisible children for a broken embed on the entire post. Dropping costs no
  // index (the index is the loop counter, not the output position) and leaves the rest of the
  // carousel exactly as it was.
  if (flatten && !poster) return null

  const type = flatten ? 'image' : declared
  const url = flatten ? poster : own
  // originalMeta() keys off the EMITTED type, so a converted entry takes the IMAGE convention (true
  // dimensions) rather than video's fudge(). That follows from the conversion rather than being an
  // extra decision: the bytes at that url are now a poster JPEG, and fudge() is the rule for video.
  const meta = originalMeta(m, type)

  // preview_url IS THE POSTER FRAME, AND FOR A VIDEO THAT IS NOT `url`. This is the fix for a
  // MEASURED defect (2026-07-19), diffed across the three payloads Discord actually receives:
  //
  //   PROD video    (rich card)  type "video"  preview_url ".../generate/COVER/{id}"  <- an IMAGE
  //   OUR slideshow (rich card)  type "image"  preview_url the image itself           <- fine
  //   OUR video     (PLAIN card) type "video"  preview_url THE VIDEO FILE             <- the bug
  //
  // Discord requests the poster, receives mp4 bytes, and abandons the rich activity card for the
  // plain OpenGraph one. The original line was `preview_url: url` for EVERY attachment — a
  // generic Phase 2 bug that was harmless for images (an image IS its own poster) and stayed
  // invisible until TikTok brought the first real video attachment.
  //
  // IMAGES ARE DELIBERATELY UNTOUCHED: `preview_url === url` is correct for them and is what the
  // working slideshow ships today, so the branch is on `type`, not on "does it have a poster".
  //
  // A VIDEO WITH NO POSTER OMITS THE KEY rather than falling back to `url`. Pointing preview_url
  // at the video is the defect itself; keeping that as a fallback would fix the one post we
  // measured and leave the bug live everywhere the cover extraction fails. Omission is also what
  // this file already does for every other value it does not have (the avatar keys, the meta
  // block): a key we cannot fill honestly does not ship.
  //
  // A CONVERTED ENTRY TAKES THE IMAGE BRANCH, because by this point it IS an image: `url` is
  // already its poster, and an image is its own poster. That falls out of testing the EMITTED
  // `type` rather than `declared`, which is the same reason the branch is on `type` at all.
  const preview = type === 'video' ? poster : url

  return {
    // DEVIATION: FxEmbed hardcodes ONE id ("114163769487684704") for every attachment on a
    // post and Discord accepts it. Distinct ids are what the Mastodon API specifies and are
    // strictly safer — any consumer that de-duplicates by id would collapse four images into
    // one. If multi-image ever fails in a real client, FxEmbed's single production-proven
    // value is the first thing to try.
    id: String(index),
    type,
    // NEVER the raw CDN url (project constraint): a Bluesky CDN url can be signed and
    // expiring, and Discord caches what it fetches. Phase 1 proved this percent-encoded
    // /_media/ 302 resolves through Discord's media proxy to real image bytes.
    url,
    // Spread IN PLACE rather than appended, so the key keeps its §6c position for every payload
    // that still has one: JSON.stringify emits insertion order, and moving it would change the
    // bytes of every image attachment we already ship without changing a single value.
    ...(preview ? { preview_url: preview } : {}),
    remote_url: null,
    preview_remote_url: null,
    text_url: null,
    // null, not '' and not undefined: an empty string claims the author wrote empty alt text,
    // and undefined vanishes from JSON.stringify, taking the key with it.
    //
    // A CONVERTED VIDEO IS MARKED AS ONE HERE, and this is a decision rather than a detail — see
    // markConverted() for which field, why, and what is still unverified about it.
    description: flatten ? markConverted(str(m.alt)) : str(m.alt) || null,
    ...(meta ? { meta } : {}),
  }
}

/**
 * The gallery: the post's own pictures, then the quoted post's, hoisted in behind them (§7).
 *
 * This is the ONLY surface a hoisted image can reach a viewer through. The plain-og head shows
 * exactly one picture and deliberately keeps choosing the post's own (see discord.ts), so
 * without the hoist here a quote-only post advertises the author's avatar and the picture the
 * post is actually about reaches nobody.
 */
function attachments(post: Post, origin: string): object[] {
  /**
   * A POST WHOSE OWN MEDIA IS ONE VIDEO SHIPS THAT VIDEO ALONE — the quote's media is dropped.
   *
   * REPORTED 2026-08-01: /Potaterrtot/status/2083366241515827378 is a video quoting a post that
   * carries a MAP IMAGE, and Discord drew the map. The wire payload was two attachments,
   * [video, image], and Discord SILENTLY DISCARDS VIDEOS FROM A MIXED GALLERY — the same behaviour
   * measured on the Instagram carousel /p/DaQ5CPTki4E, where ten attachments became six drawn and
   * four videos dropped. So the quote's picture did not sit beside the video, it REPLACED it.
   *
   * ownVideoLeads already stops such a post flattening its own video to a still (that was the fix
   * for a quote costing the post its player). It could not stop the quote's media being hoisted in
   * alongside, which is the other half of the same problem: whichever way the gallery is treated,
   * a mixed one loses the thing the post is actually about.
   *
   * THE QUOTE IS NOT LOST — its author and text still render in the content blockquote, which is
   * the context a reader needs. What is dropped is a second picture competing with the video.
   *
   * SLICING IS INDEX-SAFE: mediaList is `[...mediaOf(post), ...mediaOf(post.quote)]`, so the post's
   * own media is a PREFIX of it and every `/_media/{refKey}/{i}` this loop emits keeps addressing
   * the same entry it did before.
   */
  const list = ownVideoLeads(post) ? mediaOf(post) : mediaList(post)
  // Computed ONCE, over the whole list, and passed down — never re-derived per entry. "Does this
  // gallery flatten its videos" is a property of the GALLERY (more than one usable attachment AND a
  // video), and an entry cannot answer it about itself. Asking per attachment would also mean
  // answering it n times for one payload, each answer free to disagree with the last if the
  // predicate ever grows a wrinkle.
  //
  // Over mediaList(), which is the post's own media THEN its quote's hoisted in — the same list
  // this loop indexes and the same one /_media/{key}/{i} addresses. A post whose quote contributes
  // a video, or whose second usable item comes only from the quote, really does produce a
  // flattening gallery, so the question has to be asked of the array Discord actually receives, not
  // of post.media alone.
  const hasVideo = galleryHasVideo(list) && !ownVideoLeads(post)
  const out: object[] = []
  for (let i = 0; i < list.length; i++) {
    const a = attachment(post, origin, list[i], i, hasVideo)
    if (a) out.push(a)
  }
  return out
}

/**
 * `application.name` per platform — the footer line a Mastodon client attributes the post to.
 *
 * Phase 2 hardcoded 'Bluesky Social' with a note that this becomes a per-ref.p lookup when
 * Phase 3 lands TikTok. Left alone it ships "Bluesky Social" on every TikTok embed: not a
 * cosmetic slip but an outright false attribution, on the one surface that names the source.
 *
 * The x/ig/th/rd rows are UNVERIFIED placeholders. Those platforms have no fetcher, so no Post
 * can reach here carrying them, and the cost of a wrong guess stays zero until the phase that
 * verifies it. 'Bluesky Social' and 'TikTok' are the two that are real.
 */
/**
 * The "posted via" name Discord draws on the embed, so every value here is USER-FACING PROSE, not
 * an identifier. That distinction decides the `x` row: the platform CODE stays `'x'` and the URLs
 * stay `x.com` — those are identifiers and would be a pointless breaking change to rename — but the
 * word a human reads is "Twitter", per the owner's stated preference (2026-07-19: refer to it as
 * Twitter, not "X", wherever possible). This row shipped as the literal 'X' and was caught before
 * the Twitter fetcher landed, so it never reached a client.
 *
 * Keep prose and identifiers apart when adding a platform: `Platform` keys are code, these values
 * are copy.
 */
const APPLICATION: Record<Platform, string> = {
  bs: 'Bluesky Social', tt: 'TikTok', x: 'Twitter', ig: 'Instagram', th: 'Threads', rd: 'Reddit', yt: 'YouTube', fb: 'Facebook',
  dm: 'Dailymotion', st: 'Streamable', im: 'Imgur', tw: 'Twitch', lm: 'Lemmy', ms: 'Mastodon', mk: 'Misskey', pt: 'PeerTube', pn: 'Pinterest',
}

/**
 * Checking the RESULT is a string, NOT falling back on absence — the same total-over-every-key
 * rule attachment() states two functions up, and for exactly the same reason: a raw lookup on
 * an object literal inherits Object.prototype, where 'constructor' is a FUNCTION (JSON.stringify
 * drops it silently, shipping a status with no `application.name` at all) and '__proto__' is an
 * object. Neither is undefined, so `?? 'mbedfx'` would never fire for either.
 *
 * Reachable because ref.p arrives from the KV cache UNVALIDATED: deserializePost checks that the
 * ref round-trips through refKey/parseRefKey, which is a real guard, so this is defence in depth
 * rather than a live crash — but it is one line, and the sibling lookup in this file has the
 * scar to show what skipping it costs.
 */
function applicationName(post: Post): string {
  const v: unknown = APPLICATION[(post?.ref as { p?: Platform } | undefined)?.p as Platform]
  return typeof v === 'string' ? v : 'mbedfx'
}

/**
 * `content`, plus the leading video-gallery marker when the post is a flattened multi-item video
 * carousel (mixed OR all-video), and plus Phase 1's `[sensitive] ` label when the post carries one.
 *
 * The label has to live HERE, on the activity payload, because this is the only body surface
 * Discord reads on the spoof path: §3 states the premise of the whole spoof — Discord prefers
 * the activity data and does not take the body from elsewhere — so the og:description that
 * Phase 1's renderPost marks is not consulted. An earlier version of this file omitted the
 * marker and justified it by citing that og:description fallback; the citation was false in
 * two independent ways. buildPlainText, which §6a designates as the spoof head's
 * og:description source, carries no marker (text.ts delegates it to the renderer), and even
 * if it did, the OpenGraph body is not what this consumer reads. The net effect would have
 * been a straight regression: Phase 1 shows `[sensitive] ` to every Discord viewer, and the
 * spoof — served to every Discord response that HAS media, per the Task 5 gate in discord.ts
 * (spec §5; C1's "every discord response" was not the gate that shipped) — would have shown
 * nothing on exactly the posts that most need the label, the image-only ones.
 *
 * Applied by the renderer rather than inside buildContentHtml for the reason text.ts gives:
 * one owner per concern, and the builder is shared with a surface whose own renderer already
 * applies the marker.
 *
 * isSensitive(), NOT `post.sensitive`. The predicate is shared with describe() so the two
 * renderers cannot disagree about the same post, and since §7 it answers a wider question than
 * the parent's own flag: the hoist surfaces a QUOTED post's media here, and a sensitive quote's
 * picture arriving in a gallery whose only warning channel is this string is exactly the case
 * `post.sensitive` alone gets wrong. See embed.ts for why that shape is ordinary rather than
 * hypothetical, and why the gallery is the only surface it can reach.
 */
function contentWithMarker(post: Post): string {
  // The visible video-gallery marker is APPENDED to the body (below the caption and counts, next to
  // the engagement numbers — owner's call 2026-07-20; see withVideoGalleryMarker in text.ts) BEFORE
  // the `[sensitive]` label wraps it, so `[sensitive]` stays OUTERMOST. That ordering is unchanged by
  // the move: the content WARNING still leads the whole body, the caption leads the readable part,
  // and the "tap to watch" cue trails by the counts. See hasConvertedVideo() for the gate (a
  // flattening gallery AND a real conversion) and withVideoGalleryMarker() for its GAP separator.
  // mediaList(post), not post.media: a post whose QUOTE contributes the video flattens too, exactly
  // as attachments() asks the same concatenated list.
  let body = buildContentHtml(post)
  // The SAME exception attachments() applies, for the reason this file states twice: the visible
  // marker and the invisible flattening must never disagree. A post whose own video still plays has
  // nothing flattened to warn about.
  if (!ownVideoLeads(post) && hasConvertedVideo(mediaList(post))) body = withVideoGalleryMarker(body)
  if (!isSensitive(post)) return body
  // No trailing space when there is no body: an image-only sensitive post is exactly the one
  // that most needs the label, and `[sensitive] ` alone would ship a dangling separator.
  return body ? `[sensitive] ${body}` : '[sensitive]'
}

export function toMastodonStatus(post: Post, origin: string): object {
  // post.createdAt is a real Date on every path that reaches here: the normalizer rejects an
  // unparseable date outright, and cache.ts's hasValidIdentity requires a string that
  // Date.parse accepts before reviveDates turns it back into a Date. A value that parses can
  // never make toISOString throw, so this needs no guard of its own — unlike the text fields,
  // which that guard deliberately does not cover.
  const created = post.createdAt.toISOString()
  const handle = str(post.author?.handle)

  // The avatar is emitted ONLY when the Post actually carries one. pickMedia returns null for
  // a missing avatar, so /_media/{key}/avatar would 404 — and a 404 image is worse than no
  // image: Phase 1's scar here is a corrupt ref that produced
  // og:image=".../_media/undefined/avatar", a picture-shaped hole in every embed. Both keys
  // go together; avatar_static is the one that gets forgotten.
  const avatar = str(post.author?.avatar) ? mediaUrl(origin, post, 'avatar') : null

  return {
    // The ONLY channel back to us: Discord ignores the href we advertise and calls
    // /api/v1/statuses/{id} with this segment, so it must round-trip through decodeStatusId.
    // Measured 2026-09-02 (the wait_api / wait_users counters behind `/_wait` in src/worker.ts):
    // 5 of 5 real crawls came to /api/v1/, none to the advertised /users/ path.
    id: encodeStatusId(refKey(post.ref)),
    url: post.canonical,
    uri: post.canonical,
    created_at: created,
    edited_at: null,
    reblog: null,
    // Null even for a reply. The reply context is already drawn into `content` (§6e step 1),
    // and a non-null id here is an invitation to fetch a second status and render the context
    // twice — the same double-render trap §3 describes for counts.
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    language: null,
    content: contentWithMarker(post),
    // Empty, and there is deliberately no `sensitive` field: those two are Mastodon's content
    // WARNING mechanism, and a client that honours it blurs or collapses exactly the media
    // Discord came for. The sensitivity SIGNAL is not lost by omitting them — it rides
    // `content` as the `[sensitive] ` label (see contentWithMarker). Label without blur.
    spoiler_text: '',
    visibility: 'public',
    // Phase 3a landed TikTok, so this IS the per-ref.p lookup the Phase 2 comment promised
    // here. `website` stays null for every platform: it is the application's OWN homepage, and
    // we have no verified evidence any Discord surface reads it.
    application: { name: applicationName(post), website: null },
    media_attachments: attachments(post, origin),
    account: {
      id: handle,
      display_name: str(post.author?.name),
      username: handle,
      acct: handle,
      // DEVIATION: FxEmbed puts the POST url in account.url/uri. Clicking the author of an
      // embed should land on the author, so we send the author's profile instead.
      url: str(post.author?.url),
      uri: str(post.author?.url),
      // We have no join date. The post's own timestamp is a deterministic stand-in; the
      // alternative is reading the clock, which would break this mapper's purity.
      created_at: created,
      locked: false,
      bot: false,
      discoverable: true,
      indexable: false,
      group: false,
      ...(avatar ? { avatar, avatar_static: avatar } : {}),
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      hide_collections: false,
      noindex: false,
      emojis: [],
      roles: [],
      fields: [],
    },
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    // NOTE the absent replies_count / reblogs_count / favourites_count (spec C3). Counts
    // already legitimately render on two disjoint surfaces (`content` and oEmbed
    // author_name); adding a third field makes a third render possible, and FxEmbed's
    // verified payload omits them.
  }
}

/**
 * `author_name` is a single-purpose priority slot, and the priority is verified: counts beat
 * reply context, and the literal 'Embed' is the floor. It is NOT an author line — the account
 * block above already carries the author — which is why nothing here mentions the poster.
 */
function authorName(post: Post): string {
  // Three literal spaces, not the &ensp; the content block uses. Same metrics, same
  // abbreviation, different separator — statParts owns everything except the join, so the two
  // surfaces cannot drift in which counts survive. An all-zero counts object yields no parts
  // and falls THROUGH to the reply branch, which is the case a naive `if (post.counts)` gets
  // wrong: a brand-new post has all three present and all three zero.
  const stats = statParts(post)
  if (stats.length > 0) return stats.join('   ')

  // U+21AA here, deliberately NOT the U+21A9 that buildContentHtml's reply prefix uses; both
  // are verified in their own slot. A reply with no usable handle falls through instead of
  // rendering '↪ Replying to @', which names nobody while claiming context — reachable
  // because the cache guard validates a nested post's ref/canonical/createdAt but not author.
  const parentHandle = str(post.replyTo?.author?.handle)
  if (parentHandle) return `↪ Replying to @${parentHandle}`

  // The literal string, never ''. The empty string is untested against Discord and the
  // constant doubles as the oEmbed title.
  return 'Embed'
}

export function toOEmbed(post: Post, origin: string): object {
  // Exactly seven fields. html/width/height are omitted despite type:'rich' because Discord
  // reads only these, and an `html` payload is a second body it could decide to render.
  return {
    author_name: authorName(post),
    // The POST url, unlike account.url above — this one is FxEmbed's shape and it is right:
    // the oEmbed author line links to the thing being embedded.
    author_url: post.canonical,
    provider_name: 'mbedfx',
    // From the request, never a constant: a hardcoded origin would point a staging embed's
    // footer at prod.
    provider_url: origin,
    title: 'Embed',
    type: 'rich',
    version: '1.0',
  }
}
