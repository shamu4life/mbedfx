import type { ClientClass, Post } from '../types.ts'
import { mediaList } from '../media.ts'
import { refKey } from '../refkey.ts'
import { encodeStatusId } from '../statusid.ts'
import { esc, html } from './fail.ts'
import { byline, bytesIndex, describe, dimTags, mediaOf, mediaUrl, playableVideo, str, themeColor, usable } from './embed.ts'
import { buildPlainText } from './text.ts'

/**
 * Two heads, one gate, ONE operand:
 *
 *   client === 'discord'  ->  the Mastodon-spoof head
 *   everything else       ->  the plain-og head
 *
 * THE VIDEO CARVE-OUT IS GONE, 2026-07-19, and this docstring has been wrong about the gate in
 * both directions inside two days — so trust this version, which is the one with a production
 * measurement under it, over any memory or any commit message you find first.
 *
 * Phase 3a added a second operand (`&& !playableVideo(post)`) on the premise that the
 * activity+json link COMPETES with og:video, so a post with a playable mp4 had to be routed away
 * from the spoof or lose its inline player. THE PREMISE WAS FALSE. Measured against production
 * fxtiktok, 2026-07-19, with a Discordbot UA:
 *
 *   GET https://tnktok.com/@mysticaquariumct/video/7660566211100511518
 *     -> og:video, og:video:type, og:video:width/height, og:type=video.other, twitter:player*,
 *        <link ... application/json+oembed> AND <link ... application/activity+json>,
 *        no og:image, no twitter:card. ALL ON ONE HEAD.
 *   GET https://offload.tnktok.com/api/v1/statuses/7660566211100511518
 *     -> content "<b>❤️ 20.9K 💬 82 🔁 4.1K</b>",
 *        media_attachments [{ type: "video", url: ".../generate/video/…" }],
 *        account.avatar ".../generate/pfp/…"
 *
 * Production ships the activity link and og:video TOGETHER and the ACTIVITY card is what Discord
 * draws — confirmed by a screenshot of the production embed showing an avatar row, the counts in
 * the BODY (Discord's own emoji artwork), a working player, and a footer, all on one card. The
 * player comes from `media_attachments[].type === "video"`, not from og:video. Emitting both is
 * proven-safe, not a conflict.
 *
 * WHAT THE CARVE-OUT COST, all three reported by the owner from real Discord clients: no caption
 * (a player-type card renders no og:description at all), counts drawn in the viewer's system emoji
 * font instead of Discord's artwork, and no avatar/author row — just a bare provider line. All
 * three disappear when video takes the spoof like everything else, which is what this file now
 * does.
 *
 * The spoof head draws a gallery OR a player, FORMATTED text, a quote blockquote, reply context
 * and an author row, by betting that Discord follows the activity+json link. It still emits no
 * og:IMAGE on a post that has media — that suppression is the mechanism and is untouched (see
 * renderSpoof) — but it now emits og:VIDEO as a fallback, exactly as production does.
 *
 * The plain head therefore serves ONE audience again: 'other-bot'. (Telegram left in Task 6, to
 * telegram.ts; Discord left again today.) It keeps reply and quote context in its og:description
 * and it keeps its video branch, which is NOT dead code — 'other-bot' still needs a player.
 * Nothing on it is Discord-gated any more, because nothing Discord-shaped can reach it: the gate
 * below narrows `client` on the early return, so a `client === 'discord'` test further down is a
 * TS2367 no-overlap error rather than a live branch.
 *
 * ONLY THE SPOOF HEAD EMITS THE CALLBACK LINKS now, and both of them. Its `author_name` and the
 * Mastodon `content` are the two counts surfaces, and they stay legal under §3 because they are
 * different DOCUMENTS with different consumers. og:description stays COUNTS-FREE on both heads.
 *
 * The `client === 'discord'` gate stays written as equality against 'discord' rather than
 * `!== 'other-bot'` because it guards something bet specifically on Discord's behaviour: a new
 * client class must OPT IN to that bet, not inherit it by being none of the others.
 *
 * ===========================================================================================
 * PRODUCTION PARITY, 2026-07-19 — WHY THE VIDEO BRANCH IS A COPY AND NOT A DESIGN
 * ===========================================================================================
 *
 * THE DEFECT: removing the carve-out (above) did NOT fix video. Discord kept drawing our VIDEO
 * posts with the OpenGraph card — no avatar, no caption at all, counts in the author line in the
 * viewer's system emoji font, no footer — while drawing our SLIDESHOWS with the activity card
 * (avatar, caption, counts in Discord's own artwork, footer). Production fxtiktok gets the
 * ACTIVITY card for video posts. Confirmed by screenshots in a real Discord client THREE TIMES.
 *
 * WHY THIS IS ONE BIG CHANGE RATHER THAN ANOTHER SMALL ONE. Three single-tag hypotheses were
 * tried and all three failed — most recently "it must be twitter:card", which was deleted from
 * this head (commit 6b20562) and changed nothing. Every attempt costs a full round trip through a
 * human with a Discord client, which is an extremely slow oracle to bisect against, and the
 * bisection had already consumed a day. So the method changed: reproduce production's head
 * WHOLESALE, get one confirmation, and only then consider shrinking it.
 *
 * PRODUCTION'S VIDEO HEAD, captured live from https://megapenispoopenfarten.sex/t/ZTSw2mYwR/ :
 *   og:site_name, og:title, og:url, og:description, og:type=video.other, theme-color
 *   twitter:site, twitter:creator, twitter:title           <- ALL spelled property=, not name=
 *   og:video, og:video:type, og:video:width, og:video:height
 *   twitter:player, twitter:player:stream, twitter:player:width, twitter:player:height,
 *   twitter:player:stream:content_type                     <- also property=
 *   <link ... application/json+oembed>, <link ... application/activity+json>
 *   ABSENT: og:image, twitter:card, rel=canonical, og:video:secure_url
 *   and the og:video / twitter:player url ENDS IN .mp4
 *
 * WHAT THAT COST US, i.e. the delta this change closes. Ours had og:video:secure_url and
 * rel=canonical that production lacks; production had the whole twitter: family, the .mp4 suffix
 * and (a production bug) a duplicated og:video:type that we lack. See spoofVideoTags() for the
 * tag-by-tag treatment and the one deliberate divergence.
 *
 * THE HONEST CAVEAT: no tag in that block is individually justified. They are there because
 * production emits them. Once a real client confirms this head works, someone may bisect back
 * toward a smaller one — but MUST NOT do so SPECULATIVELY. Three speculative subtractions have
 * already been wrong, and each one costs a human a Discord test to discover.
 *
 * SCOPED TO THE VIDEO BRANCH, deliberately and narrowly. Slideshows already get the activity card
 * and are the CONTROL in every screenshot that established the defect — moving them would destroy
 * the evidence. They keep rel=canonical and twitter:card, which is also a live proof that those
 * two tags are harmless on a non-video head. A Bluesky IMAGE or text post, telegram and 'other-bot'
 * are untouched, byte for byte. (A Bluesky VIDEO post now DOES take this video branch — since
 * 2026-07-22 its HLS is a remux kind:'video' — and correctly drops those two tags; verified live.)
 */

/**
 * The {handle} path segment, which is pure decoration — the id carries the whole ref and
 * router.ts never parses this segment back out — but which still has to SURVIVE THE TRIP, and
 * three separate inputs stop it doing that. All three arrive the same way: normalize.ts takes
 * the handle from the Bluesky API, which validates domain-shaped handles, so this is the
 * corrupted/hostile-cache threat model that str() and usable() also exist for.
 *
 * - '' — '/users//statuses/{id}' loses its empty segment to route()'s filter(Boolean), leaving
 *   three segments, which matches no spoof shape at all.
 * - '.' and '..' — encodeURIComponent does NOT escape them, so they reach the wire intact and
 *   RFC 3986 dot-segment removal (applied by `new URL`, undici, curl — by whatever Discord
 *   fetches with) collapses the path to three or two segments BEFORE route() sees it. Measured:
 *   both routed to notfound. Percent-encoded forms ('%2e%2e') are NOT normalized and are fine,
 *   which is why this tests the raw handle rather than the encoded result.
 * - a lone surrogate — encodeURIComponent throws URIError on an unpaired one, and str() has
 *   already blessed the value as a string. esc() tolerates it; this is the only call in the
 *   head that does not.
 *
 * Each of those ends the same way: Discord's callback 404s on the post's OWN advertised URL,
 * or the render 500s outright (worker.ts's 'post' case wraps only d.fetchPost in a try/catch).
 * And because the spoof head emits zero og:image, a failed callback degrades to a bare title
 * and description — strictly worse than Phase 1. A placeholder loses nothing real, because
 * nothing reads this segment.
 */
function handleSegment(raw: unknown): string {
  const h = str(raw)
  if (h === '' || h === '.' || h === '..') return 'user'
  try {
    return encodeURIComponent(h)
  } catch {
    return 'user'
  }
}

/**
 * The oEmbed link. Discord reads `author_name` out of that document for the embed's small top
 * line, and that is where engagement counts live on the spoof path — disjointly from the Mastodon
 * `content`, which carries them too, because those are two different documents read by two
 * different consumers (§3).
 *
 * ONE caller again as of 2026-07-19 (renderSpoof), and this time for a reason that is not going to
 * flip back: the plain head can no longer be reached by a Discord response at all, so a second
 * caller there would be dead code — TypeScript says so outright, since the gate narrows `client`
 * on its early return. The count went 2 -> 1 (fdd8cfa) -> 2 (141005e's restore) -> 1 (today) while
 * the video carve-out existed; with the carve-out gone the question is settled structurally rather
 * than by measurement.
 *
 * Still named rather than inlined: /_oembed/{encodeStatusId(refKey)} is a wire format shared with
 * router.ts's spoofShape(), and a second spelling of it is a second thing to keep in sync.
 */
const oembedLink = (origin: string, id: string) =>
  `<link rel="alternate" type="application/json+oembed" href="${esc(`${origin}/_oembed/${id}`)}"/>`

/**
 * THE PLAIN HEAD's five OpenGraph player tags for a post carrying a playable video, or NOTHING
 * when it carries none.
 *
 * ONE CALLER AGAIN as of 2026-07-19's parity change — renderPost, i.e. 'other-bot'. These are that
 * head's whole embed: it has no activity document to read, so og:video is the only thing that can
 * produce a player for it, and og:video:secure_url is part of what it has always shipped.
 *
 * THE SPOOF HEAD NO LONGER SHARES THIS, and the split is deliberate rather than duplication anyone
 * should re-merge. See spoofVideoTags() below: the two heads now disagree about og:video:secure_url
 * (production omits it) and about the media url's .mp4 suffix (production has one), and the whole
 * point of the parity change is that the spoof head is a REPRODUCTION of a measured production
 * head, not a design. Merging them would silently drag one head's untested bet onto the other —
 * which is the exact failure mode that made a Discord video post render as an OpenGraph card while
 * a slideshow rendered as the activity card.
 *
 * WHAT STAYS SHARED, because it must: playableVideo() and mediaOf(). Both heads select the video
 * with the same predicate from the same list, so indexOf lands in the array the video was found
 * in. mediaList's hoist APPENDS, so a parent entry's index is identical in both lists and the
 * /_media/ url minted here is the one pickMedia and mastodon.ts resolve.
 *
 * WHAT IS DELIBERATELY NOT HERE: twitter:card and twitter:image. They are this head's own bet
 * (twitter:card=player plus the /_alt/0 suppression target) and they stay at the call site.
 *
 * esc() on the url, matching every other attribute: mediaUrl interpolates `origin`, which
 * worker.ts derives from the REQUEST rather than from configuration. dimTags() rather than a raw
 * fudge() interpolation because an entry with a url and no w/h shipped `content="undefined"` to a
 * crawler — see embed.ts.
 */
function videoTags(post: Post, origin: string): string[] {
  const video = playableVideo(post)
  if (!video) return []
  const url = esc(mediaUrl(origin, post, mediaOf(post).indexOf(video)))
  return [
    `<meta property="og:type" content="video.other"/>`,
    `<meta property="og:video" content="${url}"/>`,
    `<meta property="og:video:secure_url" content="${url}"/>`,
    `<meta property="og:video:type" content="video/mp4"/>`,
    ...dimTags('og:video', video.w, video.h),
  ]
}

/**
 * THE SPOOF HEAD's video block: a REPRODUCTION of production fxtiktok's video head, tag for tag.
 * Empty for a post with no playable video, which is what scopes the whole parity change to the
 * video branch.
 *
 * READ THE "PRODUCTION PARITY" SECTION OF THIS FILE'S TOP DOCSTRING BEFORE CHANGING ANYTHING HERE.
 * The short version: Discord drew our VIDEO posts with the OpenGraph card (no avatar, no caption,
 * counts in the viewer's system emoji font, no footer) while drawing our SLIDESHOWS with the
 * activity card, and production gets the activity card for both. Three single-tag hypotheses were
 * tried against a human-with-a-Discord-client oracle and all three failed. So this stops guessing
 * one tag at a time and ships production's head whole.
 *
 * NOTHING IN THIS FUNCTION IS INDIVIDUALLY JUSTIFIED, and that is the honest description of it.
 * These tags are here because production emits them, full stop. Once a real client confirms the
 * head works, someone may bisect back toward a smaller one — but MUST NOT do so speculatively,
 * because three speculative subtractions have already been wrong.
 *
 * THE THREE DELTAS AGAINST THE PLAIN HEAD, all measured 2026-07-19 against production's live head:
 *  - NO og:video:secure_url. Production has none; the plain head keeps its.
 *  - THE MEDIA URL ENDS IN .mp4. Production's does. router.ts's _media branch strips a trailing
 *    media extension before the integer parse so the suffixed url resolves to the same bytes; the
 *    extensionless form stays live everywhere else, media_attachments included.
 *  - THE twitter: FAMILY, spelled property= rather than name=. Production spells it that way. That
 *    looks wrong and is copied exactly: the point is to reproduce an observed-working head, not to
 *    correct it. dimTags() already emits property=, so the player dimensions come out matching
 *    production's spelling for free — and, more importantly, come out IDENTICAL to og:video's,
 *    because they are the same call on the same Media.
 *
 * ONE DELIBERATE DIVERGENCE: production emits og:video:type TWICE. That is plainly a production
 * bug — a duplicated tag cannot be what selects a card model, and OGP takes the first occurrence
 * anyway — so we emit it once. Recorded here rather than silently dropped, because "we match
 * production" is the entire warrant for everything else in this function and a reader deserves to
 * know where it stops.
 *
 * og:IMAGE STAYS FORBIDDEN on this head and none of the above relaxes it. An og:image gives
 * Discord a single-image OpenGraph card that is a strictly better match than the activity gallery,
 * so it wins and silently degrades the embed to Phase 1. Production emits none either.
 *
 * `title` is passed in rather than recomputed so twitter:title and og:title cannot drift; it
 * arrives ALREADY esc()'d, since it is the same string interpolated into og:title. The handle goes
 * through str() for the reason every author read in this repo does: deserializePost validates ref,
 * canonical and createdAt and NOTHING else, so an author-less cache record reaches here and a raw
 * read would ship "@undefined" as a twitter:site.
 */
function spoofVideoTags(post: Post, origin: string, title: string): string[] {
  const video = playableVideo(post)
  if (!video) return []
  // The .mp4 suffix is appended to the /_media/ url rather than baked into mediaUrl(), because
  // mediaUrl() is shared with the avatar, with every image and with mastodon.ts — and only THIS
  // pair of tags was measured carrying it.
  const url = esc(`${mediaUrl(origin, post, mediaOf(post).indexOf(video))}.mp4`)
  const handle = esc(`@${str(post.author?.handle)}`)
  return [
    `<meta property="og:type" content="video.other"/>`,
    `<meta property="og:video" content="${url}"/>`,
    `<meta property="og:video:type" content="video/mp4"/>`,
    ...dimTags('og:video', video.w, video.h),
    `<meta property="twitter:title" content="${title}"/>`,
    `<meta property="twitter:site" content="${handle}"/>`,
    `<meta property="twitter:creator" content="${handle}"/>`,
    `<meta property="twitter:player" content="${url}"/>`,
    `<meta property="twitter:player:stream" content="${url}"/>`,
    `<meta property="twitter:player:stream:content_type" content="video/mp4"/>`,
    ...dimTags('twitter:player', video.w, video.h),
  ]
}

/**
 * THE STOCK PLAYER — YouTube's own embed iframe, for the yt cards that cannot carry an mp4.
 *
 * MEASURED IN A REAL DISCORD CLIENT, 2026-08-30, via the /_stock/{1|2|3} experiment (v1.13.1), and
 * every claim below is that screenshot rather than a guess. Three heads, one video, one session:
 *
 *   v1  player tags alone                          -> PLAYABLE. Discord renders the iframe from OUR
 *                                                     origin; playback is YouTube's own pop-out.
 *   v2  v1 + the oEmbed callback link              -> PLAYABLE, and the counts row renders beside it.
 *   v3  v2 + the activity+json link                -> the ACTIVITY card. The iframe is gone: Discord
 *                                                     prefers the Mastodon document whenever the link
 *                                                     is present.
 *
 * v3 is the whole design constraint. The iframe and the activity card cannot coexist on one head, so
 * this is not an upgrade to the spoof — it is a REPLACEMENT head for exactly the yt states where the
 * activity card has nothing to play: the mux still racing (a cold first paste), a live stream, and a
 * video past MUX_MAX_SECONDS. Today all three render a photo, Discord caches the embed in the
 * message forever (discord-api-docs#1663), and that photo never heals. The stock head trades the
 * activity card's author row for a player that works — at FULL quality, because it is YouTube's own
 * player, and at ZERO latency, because the url derives from the video id alone. The owner rated the
 * warm activity card's inline mp4 the better experience, so the gate below leaves every warm video
 * exactly as it was: this head exists only where the alternative is a frozen photo.
 *
 * AGE-GATED VIDEOS ARE EXCLUDED (post.sensitive, set by normalizeYouTube from the same signal as
 * AGE_NOTE): YouTube's embed player refuses them with a sign-in wall, so the stock head would trade
 * an honest note for a player that errors on tap. The note card stays.
 *
 * og:image IS DELIBERATE AND NOT A C1 VIOLATION. C1's suppression protects the activity card from
 * an OpenGraph card outranking it; this head has no activity link to protect. The measured v1/v2
 * head carried the thumbnail and Discord drew it as the player's poster frame. `{poster: 0}` is the
 * one slot that serves in every gated state — a yt video's poster is mandatory (derived from the id
 * by the normalizer), and settleMux's degraded still lives in the poster slot by construction.
 *
 * 1280x720 is the measured experiment's value, not the video's: the iframe is a viewport, not the
 * file, and the real dimensions belong to a player YouTube lays out itself.
 */
function stockPlayerTags(post: Post, origin: string, vid: string): string[] {
  // `vid` arrives from the gate, where `post.ref?.p === 'yt'` has already narrowed the union —
  // the ref's other arms (ig's {code}, fb's {kind}) have no `id` for this function to read.
  const embed = esc(`https://www.youtube.com/embed/${str(vid)}`)
  return [
    `<meta property="og:type" content="video.other"/>`,
    `<meta property="og:video" content="${embed}"/>`,
    `<meta property="og:video:secure_url" content="${embed}"/>`,
    `<meta property="og:video:type" content="text/html"/>`,
    `<meta property="og:video:width" content="1280"/>`,
    `<meta property="og:video:height" content="720"/>`,
    `<meta property="og:image" content="${esc(mediaUrl(origin, post, { poster: 0 }))}"/>`,
    `<meta property="twitter:card" content="player"/>`,
    `<meta property="twitter:player" content="${embed}"/>`,
    `<meta property="twitter:player:width" content="1280"/>`,
    `<meta property="twitter:player:height" content="720"/>`,
  ]
}

/**
 * The Mastodon-spoof head. Emits NINE tags on a post with usable media, those nine plus exactly
 * ONE og:image (the author avatar) on a post without, and those nine plus a SIX-TAG og:video
 * fallback on a post whose own media is a playable video — never twitter:image, and never more
 * than one og:image.
 *
 * That conditional og:image is correction C1's live-measured table, and it is the ONE thing in
 * this head gated on media:
 *
 *   usable media >= 1  ->  ZERO og:image, twitter:card=summary_large_image
 *   usable media == 0  ->  ONE  og:image (the avatar), twitter:card=summary
 *
 * The zero-when-media-exists half is LOAD-BEARING and must not weaken. The suppression is the
 * mechanism, not an oversight: FxEmbed's src/embed/status.ts:449 skips its whole media block on
 * this path (`if (!useActivity && !flags?.textOnly)`). An og:image on a gallery post hands
 * Discord a single-image OpenGraph card to prefer over the gallery the activity JSON describes,
 * and og:image outranks everything else on that card — so the spoof would quietly degrade to
 * exactly what Phase 1 already draws, while looking like it worked. "Add an avatar as a
 * fallback, it can't hurt" is precisely the fix that breaks this, and it cannot be caught by
 * eye in a client, because the degraded result still looks like a working embed.
 *
 * mediaList, NOT post.media: hoisted quote media COUNTS. A quote-only post has a picture to
 * show, so it belongs in the >= 1 branch — otherwise it gets an avatar og:image AND a populated
 * media_attachments, which C1 names by name as the state §7 must not leave behind: a face where
 * the embed's actual subject is a picture the viewer then cannot see.
 *
 * NO avatar means NO og:image at all, rather than a /_media/{key}/avatar URL that pickMedia
 * resolves to null. An author-less record reaches here (deserializePost validates ref, canonical
 * and createdAt and nothing else) and this repo has a scar exactly here — a corrupt ref once
 * shipped og:image=".../_media/undefined/avatar". A 404 image is worse than no image; it is the
 * same rule usable()'s url clause states for post media, and the same call the plain head below
 * makes, deliberately spelled the same way so the two heads cannot drift apart on it.
 *
 * §6a listed seven tags and said "no twitter:card"; correction C1 re-measured the live head and
 * overturned that, and the spec states corrections win over anything earlier in the document,
 * so twitter:card and (C3) rel="canonical" are emitted. Deviating from a byte-derived head on
 * the strength of a retracted passage is the drift this spec exists to prevent — and twitter:card
 * cannot defeat the suppression: it names a card LAYOUT, not an image source, so on the >= 1
 * branch there is nothing for it to promote.
 *
 * og:title and og:description stay as documented fallback insurance: if Discord ever stops
 * following the activity link, the embed degrades to a titled, described card rather than to
 * nothing. Everything reads through str(): a renderer's input comes from the cache unvalidated
 * (see embed.ts), and esc() throws on a non-string.
 */
function renderSpoof(post: Post, origin: string): Response {
  const id = encodeStatusId(refKey(post.ref))
  const handle = handleSegment(post.author?.handle)
  const canonical = esc(str(post.canonical))
  const hasMedia = mediaList(post).some(usable)
  // Computed once and shared with twitter:title, so the two cannot drift. Already esc()'d.
  const title = esc(byline(post.author))

  // THE PRODUCTION-PARITY VIDEO BLOCK — see spoofVideoTags() above, and the PRODUCTION PARITY
  // section of this file's top docstring for why it is reproduced wholesale. Empty on any post
  // without a playable video, which is what scopes every video-branch divergence below. The
  // `hasMedia` branch already guarantees ZERO og:image on a video post, so this block inherits the
  // C1 suppression rather than needing a guard of its own.
  const videoOg = spoofVideoTags(post, origin, title)

  // THE STOCK GATE — see stockPlayerTags. yt only; only when there is NO playable video (the three
  // states the activity card renders as a frozen photo); never on an age-gated post. Mutually
  // exclusive with videoOg by construction: `!videoOg.length` is in the predicate.
  const stockOg = post.ref?.p === 'yt' && !videoOg.length && !post.sensitive
    ? stockPlayerTags(post, origin, post.ref.id)
    : []

  const tags = [
    `<meta property="og:title" content="${title}"/>`,
    // buildPlainText, never buildContentHtml: this value is COUNTS-FREE by contract (§3).
    // og:description and oEmbed author_name are not disjoint consumers — the OpenGraph path
    // reads the body from one and the author line from the other — so a count here would
    // print the engagement stats twice inside a single embed.
    `<meta property="og:description" content="${esc(describe(post, buildPlainText(post)))}"/>`,
    `<meta property="og:url" content="${canonical}"/>`,
    `<meta property="og:site_name" content="mbedfx"/>`,
    // C1's 0-media branch, and the ONLY og:image this head can ever emit. Positioned with the
    // other og: tags to match the plain head below; the live evidence measured that the tag is
    // PRESENT on a text-only post, not where in the head it sat, and OGP is order-insensitive
    // except for duplicates — so this is our choice, not a measured fact. mediaUrl() rather than
    // a hand-built path, because /_media/{encodeURIComponent(refKey)}/avatar is a wire format
    // shared with router.ts and pickMedia, and a second spelling of it is a second thing to
    // keep in sync. No dimTags: we have no width/height for an avatar and will not guess.
    ...(!hasMedia && post.author?.avatar
      ? [`<meta property="og:image" content="${esc(mediaUrl(origin, post, 'avatar'))}"/>`]
      : []),
    // Kept with the other og: tags, immediately after the og:image branch it is mutually
    // exclusive with — a video post has media, so that branch is empty whenever this one is not.
    ...videoOg,
    ...stockOg,
    // name=, NOT property= — CORRECTED 2026-08-01, and the old comment here was wrong on the one
    // point that mattered. It claimed each spelling was "the one its own head was observed working
    // with"; what was actually observed was the TAG being present, never the stripe appearing.
    //
    // THE OWNER SUPPLIED THE DISCRIMINATING CASE: "LGB successfully gets a gold/yellow card". lgb45
    // is an fxtwitter fork and ships BOTH spellings on the same head —
    //
    //     <meta name="theme-color" content="#F79829"/>       <- gold, its own
    //     <meta property="theme-color" content="#6363ff"/>   <- periwinkle, inherited
    //
    // and Discord draws it GOLD. One head, two values, one winner: `name=` is read and `property=`
    // is ignored. vxtwitter (name=, #1DA1F2) gets its blue for the same reason.
    //
    // That is also the whole explanation for the reported "we cannot colour our cards". Emitting only
    // property= meant Discord found NO theme-color and fell back to its own default — which sits
    // close enough to fxtwitter's #6363ff that the fallback was mistaken for a fixed Discord colour
    // and written up as "the Mastodon spoof has no colour field". The spoof was never involved.
    //
    // theme-color is a standard HTML meta and takes name=; property= is the OGP-flavoured attribute
    // and this is not an og tag. fail.ts's errorEmbed has always spelled it correctly, so failure
    // cards have been coloured this whole time while post cards were not.
    //
    // The COLOUR is no longer the hardcoded Bluesky blue this shipped as. themeColor() is shared
    // with the plain head below rather than spelled here: that head had no theme-color at all,
    // and while the video carve-out existed a per-ref.p lookup in THIS function alone would have
    // left the accent missing on exactly the post kind Phase 3a shipped. The carve-out is gone
    // (2026-07-19) so this head now covers every Discord post again, but the sharing stays — the
    // plain head still serves 'other-bot', and two heads spelling one colour separately is how
    // one of them ended up without it. No esc(): the value comes from a closed
    // Record<Platform, string>, never from a Post.
    /**
     * BOTH SPELLINGS, ONE VALUE — a DELIBERATE amendment to §6a's "emit only" list, made by the owner
     * 2026-08-01 with the trade stated. The whitelist test named "a second theme-color" as exactly
     * what it existed to prevent, so this is a spec change rather than a slip past it, and the test
     * was amended in the same commit instead of being re-baselined quietly.
     *
     * WHY name= IS FIRST AND WHY IT IS THE ONE THAT MATTERS: it is what the HTML standard specifies
     * and the only spelling with evidence of being READ. property= ships beside it for coverage of
     * consumers that copied fxtwitter's spelling, which is a real population — fxtwitter, fixupx and
     * everything forked from them emit it — and costs about forty bytes.
     *
     * THE PROVISO IS THE WHOLE THING: both come from a SINGLE themeColor(post) call, so they cannot
     * disagree. lgb45 ships both and ITS TWO DISAGREE (#F79829 by name=, an inherited #6363ff by
     * property=), which is how a fork ends up advertising a colour it does not use. Two tags naming
     * one value is redundancy; two tags naming two values is a bug waiting for a consumer to read the
     * other one. If this ever becomes a variable, it stays ONE variable — and render.test.mjs asserts
     * the two are equal, which is the assertion that actually protects anything here.
     */
    ...((c => [
      `<meta name="theme-color" content="${c}"/>`,
      `<meta property="theme-color" content="${c}"/>`,
    ])(themeColor(post))),
    // C1's table, both rows. Retracts §6a's "no twitter:card", which C1 measured wrong on live
    // fixtures. Note it tracks the MEDIA branch and not the og:image actually emitted: an
    // avatar-less text-only post still says summary, because the tag names a layout and
    // "summary with no image" is a coherent thing to say.
    //
    // OMITTED ENTIRELY WHEN THIS HEAD ALSO CARRIES og:video (2026-07-19). Measured, not guessed —
    // three heads, and only the combination loses the Mastodon card:
    //
    //   our slideshow   twitter:card, no og:video   -> Discord renders the ACTIVITY card
    //   our video       twitter:card +  og:video    -> Discord falls back to the OPENGRAPH card
    //   production      no twitter:card, og:video   -> Discord renders the ACTIVITY card
    //
    // Diffing our own two heads isolates it further: video vs slideshow differ ONLY by the
    // og:video block, so og:video is what tips it — but production proves og:video alone is
    // harmless, which leaves the PAIR. Production omits twitter:card on video posts and gets the
    // card we want; we emitted it and lost the avatar, the body-rendered counts and the footer.
    //
    // The cost of being wrong is asymmetric and that is why this is a deletion rather than a new
    // value: twitter:card only names a LAYOUT, and this head has no twitter:image for it to
    // promote, so dropping it can lose us nothing — while keeping it demonstrably costs the whole
    // activity card. Do not "restore for consistency" with the no-video branch; the branches face
    // different Discord code paths.
    // ALSO OMITTED ON THE STOCK BRANCH, which carries its own `twitter:card player` — a second
    // twitter:card is the duplicate-tag hazard the whitelist test exists to catch.
    ...(videoOg.length || stockOg.length
      ? []
      : [`<meta name="twitter:card" content="${hasMedia ? 'summary_large_image' : 'summary'}"/>`]),
    // C3: present in the proven head, so emit it. Redundant with og:url as far as any
    // consumer we know of is concerned — which is the argument for keeping it, not for
    // dropping it: the head was byte-derived from a working probe, and quietly shipping a
    // subset of it is how you find out which tag mattered by breaking production.
    //
    // OMITTED ON THE VIDEO BRANCH ONLY (2026-07-19, the parity change). Production's video head
    // carries no rel=canonical, and that is the whole reason — this is a reproduction, not a
    // judgement about what canonical does. The C3 argument above still holds everywhere it can be
    // tested against evidence: our SLIDESHOW emits canonical and gets the activity card we want,
    // which is a live proof that the tag is harmless on a non-video head, so it stays there.
    //
    // Gated on `videoOg` rather than on a fresh playableVideo() call, like every other divergence
    // in this head, so one predicate decides all of them and they cannot drift apart branch by
    // branch. See twitter:card immediately above, which is gated the same way for the same reason.
    // The stock branch omits canonical too: the measured v1/v2 experiment head carried none and
    // rendered, and this head is a reproduction of that artifact, same as the video branch is of
    // production fxtiktok's.
    ...(videoOg.length || stockOg.length ? [] : [`<link rel="canonical" href="${canonical}"/>`]),
    // The whole point of this head. router.ts's spoofShape() is the other half of both URLs,
    // and the id has to survive decodeStatusId -> parseRefKey to name the post again.
    // OMITTED ON THE STOCK BRANCH, and this omission IS the stock feature: the v3 experiment
    // measured that Discord prefers the activity document whenever this link is present, and the
    // activity card is exactly the thing that has nothing to play in the gated states. The oEmbed
    // link stays — v2 measured the counts row coexisting with the iframe.
    ...(stockOg.length
      ? []
      : [`<link rel="alternate" type="application/activity+json" href="${esc(`${origin}/users/${handle}/statuses/${id}`)}"/>`]),
    oembedLink(origin, id),
  ]
  return html(tags.join(''))
}

export function renderPost(post: Post, client: ClientClass, origin: string): Response {

  // The post's OWN media, hoisted quote media deliberately EXCLUDED — this list feeds the
  // plain-og head's single-picture choice, and §7 requires that choice to stay the post's own
  // whenever it has one. renderSpoof asks the hoisted question (mediaList) instead, because "is
  // there a picture anywhere" and "which one picture" are different questions with different
  // answers.
  //
  // Not merely a first-vs-later ordering point, which mediaList would satisfy anyway by putting
  // parent entries first: the video branch prefers a video found ANYWHERE in the list over an
  // image, so a hoisted quote video would take the og:video branch and suppress the parent's own
  // og:image entirely. NO LONGER UNREACHABLE — this paragraph was written in Phase 2 as a
  // prediction ("when a platform that really carries video lands in Phase 3"), and Phase 3a's
  // TikTok normalizer is that platform: it is the first to emit a genuine kind:'video' entry.
  // The prediction came true in the gate below rather than here, which is why the selection is
  // now shared: playableVideo() asks THIS list, so the gate and the head cannot disagree.
  const media = mediaOf(post)

  // THE GATE. This now ships correction C1 — the authoritative spec — and the deviation that
  // used to be flagged here is gone. Reading the history matters, because the obvious "fix" is
  // to put the media test back.
  //
  // §5 said `discord && has media`, verified by sweeping 0/1/2/3/4-image posts. Correction C1
  // then measured `activity=1` on all five live fixtures and overturned it: TWO INDEPENDENT
  // GATES, not one — the callback links go out for every discord response, and only og:image is
  // gated on media (renderSpoof owns that half). This file shipped §5 anyway, on a risk argument
  // C1 did not address: the spoof emits zero og:image and had never been in front of a real
  // client (§9), so a text-only post had no gallery to win and a human-verified Phase 1 embed to
  // lose. Asymmetric downside, so the unverified bet was placed only where it paid.
  //
  // THAT JUSTIFICATION IS SPENT. On 2026-07-18 the spoof was VERIFIED IN A REAL DISCORD CLIENT
  // (Android): a 4-image Bluesky post drew a correct 2x2 gallery with author row, full text and
  // engagement counts; hoisted quote media rendered; blank lines survived; and the counts
  // rendered exactly ONCE, so C4's feared double-render did not happen either. The bet is no
  // longer a bet, and the same session measured what §5's caution was costing: reply and
  // text-only posts fell back to the plain-og head and rendered visibly WORSE beside the spoof —
  // a blue link title, the avatar shoved into a corner as a small thumbnail, no proper author
  // row. C1 won on evidence, not on argument.
  //
  // TO REVERT C1, if a real client later disagrees: restore the media operand —
  //   if (client === 'discord' && mediaList(post).some(usable)) return renderSpoof(post, origin)
  // — and the plain-og path below picks text-only Discord posts back up. renderSpoof's no-media
  // branch then becomes dead code rather than wrong code.
  //
  // TWO EDITS, not one, and this paragraph has now been rewritten FOUR TIMES IN TWO DAYS — so
  // trust this version, dated 2026-07-19 and written after the production measurement in this
  // file's top docstring, over any memory of the others or any commit message you find first.
  //
  // The second edit is the plain path's trailing `if (client === 'discord')` oEmbed push, which
  // is GONE AGAIN and for the original reason: with the gate narrowed back to the client test
  // alone, TypeScript narrows `client` to 'telegram' | 'other-bot' | 'human' after this return,
  // so that comparison is a TS2367 no-overlap error rather than a branch anyone can keep. A C1
  // revert must restore it by hand or text-only Discord embeds come back with no engagement
  // counts. What such a revert must NOT also do is append counts to og:description: author_name
  // would then be carrying them too, which is §3's double-render inside a single embed.
  //
  // The full history of that push, since `git log` shows it flip several times: present, deleted
  // by C1 as unreachable, restored by Phase 3a's carve-out (which made Discord reachable here
  // again), deleted by fdd8cfa, restored by 141005e, and now deleted with the carve-out itself.
  //
  // What a revert would NOT undo: the §7 quote-media hoist means a quote-only post takes the
  // spoof path under the old gate as well.
  //
  // PHASE 3a'S VIDEO CARVE-OUT WAS HERE — a second operand, `&& !playableVideo(post)` — AND IT
  // IS GONE, 2026-07-19. Its premise was that the activity+json link competes with og:video, so a
  // post with a playable mp4 had to leave this head or lose its player. Production fxtiktok
  // measured that same day ships BOTH on one head and the activity card still wins; see the top
  // docstring for the two curl transcripts and what the carve-out was costing (no caption, no
  // avatar row, mismatched count emoji). A video post now takes the spoof like every other
  // Discord post, and renderSpoof emits og:video as a fallback beside the activity link, exactly
  // as production does.
  //
  // A SLIDESHOW HAS NO VIDEO and always took the spoof; that is unchanged. A video post with only
  // a THUMBNAIL is also unchanged: the normalizer emits the cover as a lone kind:'image' entry and
  // it renders through the activity gallery as a one-image slideshow does.
  if (client === 'discord') return renderSpoof(post, origin)

  const tags: string[] = []
  // str(post.author?.…), not a raw read. deserializePost validates ref, canonical and createdAt
  // and NOTHING else, so `author` can be absent from a cache record entirely — confirmed by
  // round-tripping an author-less record through it, which returns a Post. The raw form was
  // then `Cannot read properties of undefined (reading 'name')`, and worker.ts calls render()
  // OUTSIDE any try/catch (only d.fetchPost is wrapped), so that was an uncaught 500 out of the
  // one module whose entire contract is to degrade.
  //
  // This was the LAST raw author read in the codebase: the spoof path above, mastodon.ts and
  // text.ts all already go through str(post.author?.…). telegram.ts gained the guard when it
  // split out of this file and this path did not, which left the crash live on the two client
  // classes that still use it — the split fixed one caller of a shared hazard, not the hazard.
  tags.push(`<meta property="og:title" content="${esc(byline(post.author))}"/>`)

  // Exactly one og:description. OGP takes the FIRST occurrence, so a second tag
  // would be silently ignored — which is how a sensitive marker gets lost.
  //
  // buildPlainText, not raw post.text, and both heads now agree on that. This is the ONLY
  // surface reply and quote context can reach on this path: it is what every non-Discord bot
  // gets, and — because of the gate above — what every text-only Discord post would get under a
  // C1 revert. Raw post.text meant a text-only reply or quote post carried its context to NO
  // surface at all, which is exactly what C1 predicted and what §5's own defence of the gate
  // ("quote context still reaches those posts through og:description") assumed was already true.
  //
  // COUNTS-FREE ON THIS SURFACE (§3). buildPlainText is counts-free by contract and is used raw
  // here — no composition, no client test.
  //
  // A DAY-LONG ROUND TRIP ENDED HERE, 2026-07-19, and its middle is still in `git log` where a
  // reader will find it first. fdd8cfa appended statsPlain(post) to this value for `discord`, to
  // fix a real cosmetic defect (a video's counts and a slideshow's counts drew different emoji
  // artwork). A screenshot from a real client showed the composed value reaching nobody: DISCORD
  // RENDERS NO og:description ON A PLAYER-TYPE EMBED. The origin was verified to be serving it
  // correctly, so that is Discord's renderer, not our wire. 141005e reverted it.
  //
  // THAT WHOLE ARGUMENT IS NOW MOOT ON THIS HEAD, and the reason is worth stating because it is
  // the opposite of what the deleted paragraph said: no Discord response reaches this line any
  // more. The video carve-out that put one here is gone, so a tt video's caption and counts both
  // ride the Mastodon `content` — one body surface, Discord's own emoji artwork, no mismatch to
  // accept and nothing to append here. The counts-free rule survives for 'other-bot', which never
  // had a counts surface on this head and does not gain one.
  tags.push(`<meta property="og:description" content="${esc(describe(post, buildPlainText(post)))}"/>`)

  tags.push(`<meta property="og:url" content="${esc(post.canonical)}"/>`)
  tags.push(`<meta property="og:site_name" content="mbedfx"/>`)
  // NEW in Phase 3a, and it STAYS after the video carve-out's removal — for a smaller audience
  // than the argument that added it. It was added because the carve-out made this head what a
  // TikTok VIDEO post rendered through on Discord, so without it the phase's headline post kind
  // shipped with no accent colour at all. That case now belongs to renderSpoof, which has always
  // carried the tag. This line remains because 'other-bot' still reaches this head with a tt post
  // of any shape, and "a head with no accent colour at all" was the defect — not a Discord-scoped
  // one. Deleting it would re-open it for the one client left here.
  //
  // BOTH SPELLINGS, ONE VALUE — the same amendment as the spoof head above, for the same reasons.
  //
  // The comment here used to justify property= alone as "measured on production fxtiktok's own
  // plain-og video head, which is the head Discord renders with #ff0050 today". The first half was
  // true and the second half was assumed: fxtiktok is an fxtwitter fork emitting property= ONLY, so
  // it is another site whose stripe Discord is not reading. Copying its head copied its bug.
  //
  // themeColor() is called ONCE and both tags share the result, so the two can never disagree.
  // No esc(): the value comes from a closed Record<Platform, string>, never from a Post.
  const colour = themeColor(post)
  tags.push(`<meta name="theme-color" content="${colour}"/>`)
  tags.push(`<meta property="theme-color" content="${colour}"/>`)

  // Exactly one og:image, or none. Emitting both the avatar and the post image
  // means the avatar wins and Discord shows the wrong picture.
  // usable() first in both finds: a bare `m.kind` read threw `Cannot read properties of null` on
  // `media: [null]` from a corrupt cache record. It also keeps the promise the url clause makes —
  // an entry with no url resolves through pickMedia to null, so pointing og:image at it
  // advertises a guaranteed 404, and a broken-image embed is worse than the avatar this now falls
  // through to.
  //
  // THE SAME PREDICATE renderSpoof USES, deliberately — that is the entire reason it was lifted
  // into embed.ts. It used to be "the same call THE GATE makes", and the gate it named is gone
  // (the video carve-out, removed 2026-07-19); the shared-predicate rule survived the change
  // because renderSpoof picked the predicate up for its own og:video fallback. The og: tags
  // themselves are now shared outright, through videoTags() — if these two heads ever emitted
  // different player tags, one would advertise a player off an index computed against a list the
  // video was not found in.
  const video = playableVideo(post)
  if (video) {
    tags.push(...videoTags(post, origin))
    // twitter:card and twitter:image stay HERE rather than inside videoTags(), because they are
    // this head's own bet: the spoof head keeps C1's measured summary/summary_large_image and has
    // no twitter:image for a layout tag to promote. See videoTags() for the split.
    tags.push(`<meta name="twitter:card" content="player"/>`)
    // DELETED 2026-07-19: a `twitter:description` push carrying the caption, gated on
    // `client === 'discord'` (added the same day, commit 6fae4a9).
    //
    // It was an explicitly-labelled UNVERIFIED EXPERIMENT — a guess that Discord renders this head
    // under the twitter-card model rather than the OpenGraph one, which would have explained why
    // og:description went undrawn on a player card, and would have given the caption somewhere to
    // land. Nobody ever saw it work. It is obsolete rather than disproven: the caption now reaches
    // the viewer through the Mastodon `content` on the spoof head, which is where a Discord video
    // post goes again, so there is nothing left for the experiment to recover.
    //
    // Deleted rather than kept "because it is additive and cannot hurt", which is what its own
    // comment demanded: an unfalsified guess sitting in a head is cargo cult, and the next reader
    // takes it for something measured. Recover it from 6fae4a9 if a twitter-card body surface is
    // ever actually needed here — and note it could never have been right for 'other-bot', the
    // only client that still reaches this branch.
    //
    // Absolute, never the bare string "0": a relative "0" resolves to /0 on our
    // origin, which is the bare-username shape, and would serve a chooser.
    // No og:image here — it would outrank this and defeat the suppression.
    // esc() for the same reason as the media URLs above — `origin` comes from the request, and
    // this was the last raw interpolation of it in either head.
    tags.push(`<meta name="twitter:image" content="${esc(`${origin}/_alt/0`)}"/>`)
  } else {
    const img = media.find(m => usable(m) && (m.kind === 'image' || m.kind === 'gif'))
    if (img) {
      // bytesIndex, NOT the bare index: a settleMux DEGRADED STILL arrives here as a kind:'image' entry
      // sitting at the VIDEO's array position, and that position answers 503 no-store on the /_media/
      // route — an og:image that 503s is an embed with no picture at all. Its bytes are at poster{i}.
      tags.push(`<meta property="og:image" content="${esc(mediaUrl(origin, post, bytesIndex(img, media.indexOf(img))))}"/>`)
      tags.push(...dimTags('og:image', img.w, img.h))
      tags.push(`<meta name="twitter:card" content="summary_large_image"/>`)
    } else if (post.author?.avatar) {
      // Only when there is no post media does the avatar become the embed image.
      // Optional-chained for the same reason as og:title above: an author-less record reaches
      // here on any post with no usable media, which is exactly the degrade path.
      tags.push(`<meta property="og:image" content="${esc(mediaUrl(origin, post, 'avatar'))}"/>`)
      tags.push(`<meta name="twitter:card" content="summary"/>`)
    }
  }

  // NO CALLBACK LINK HERE, and none is possible: this head has no Discord audience left.
  //
  // A `if (client === 'discord') tags.push(oembedLink(...))` used to sit at exactly this point. It
  // is gone with the video carve-out that made it reachable (2026-07-19), and it cannot simply be
  // put back — the gate above returns on the bare client test, so TypeScript narrows `client` to
  // 'telegram' | 'other-bot' | 'human' by this line and the comparison is a TS2367 no-overlap
  // error. That is a feature: the compiler now enforces what this head's audience is.
  //
  // The counts it used to deliver are not lost, they moved back to a better surface. A tt video's
  // counts and caption both ride the Mastodon `content` on the spoof head, drawn as the embed BODY
  // in Discord's own emoji artwork — which also retires the video/slideshow emoji mismatch that
  // 2026-07-19's three commits (141005e, fdd8cfa, 6fae4a9) spent the day trading against a
  // countless player. renderSpoof links the oEmbed document itself, so author_name still carries
  // counts for the top line, disjointly, exactly as §3 permits.
  //
  // IT MUST NOT BE WIDENED TO 'other-bot' if it ever returns: an oEmbed document with type:'rich'
  // and no `html` violates the oEmbed spec. Discord demonstrably tolerates it (FxEmbed ships
  // exactly that to 100% of its Discord traffic); no evidence exists for Slack or Facebook, and a
  // bot that follows the link and then rejects the document ends up worse off than one that never
  // saw it. Telegram cannot reach this line at all — it renders through telegram.ts.
  return html(tags.join(''))
}
