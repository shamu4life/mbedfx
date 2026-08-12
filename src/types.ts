export type Platform = 'x' | 'tt' | 'ig' | 'th' | 'rd' | 'bs' | 'yt' | 'fb' | 'dm' | 'st' | 'im' | 'tw' | 'lm' | 'pn' | 'ms' | 'mk' | 'pt'

/**
 * Per-platform identity. Carries every field needed to both fetch the post and
 * rebuild its canonical URL. A bare {platform, id} cannot express Bluesky
 * (handle + rkey) or Instagram stories (user + id).
 *
 * Note `bs.handle` may be a DID (`did:plc:…`), which contains colons — see refkey.ts.
 */
export type PostRef =
  | { p: 'x'; id: string }
  | { p: 'tt'; id: string }
  | { p: 'ig'; kind: 'p' | 'reel' | 'tv'; code: string }
  | { p: 'ig'; kind: 'story'; user: string; id: string }
  | { p: 'th'; code: string }
  | { p: 'rd'; sub: string; id: string }
  | { p: 'bs'; handle: string; rkey: string }
  /** YouTube: the 11-char video id is the whole identity (watch / shorts / embed / live all share it). */
  | { p: 'yt'; id: string }
  /**
   * Facebook video. `kind` picks the url the container's yt-dlp is handed: 'watch' -> /watch/?v={id}
   * (also where /{page}/videos/{id} lands), 'reel' -> /reel/{id}, 'share' -> /share/v/{id} (id is the
   * opaque share code, which yt-dlp resolves). The video itself is a remux:{page}.
   */
  /**
   * `kind: 'group'` CARRIES A COMPOSITE ID, `{groupId}_{postId}` — the only fb kind whose url needs
   * two numbers. That spelling is Facebook's OWN historical post-id format, not an invention, and it
   * keeps refKey's `fb:{kind}:{id}` shape intact rather than adding a field every other arm ignores.
   * Both halves are digits, so the separator can never be ambiguous.
   */
  /**
   * `post` IS THE ORDINARY PERMALINK, added 2026-08-01 — /{owner}/posts/{id}, story.php and
   * permalink.php, all three spellings Facebook itself emits for one post. Its id is the composite
   * `{ownerId}_{postId}`, exactly mirroring `group`, because a Facebook post is identified by the
   * PAIR: story.php carries both as separate query params and neither alone names the post.
   *
   * It was missing, and its absence was not cosmetic: metashare's own comment already promised
   * "story.php / permalink.php  story_fbid + id  the post IS the pair" as a shape "the router already
   * parses", and stripMetaTracking preserves exactly those keys for it. The router never built its
   * half, so a resolved share code landed on a url nothing could route.
   */
  /**
   * `photo` IS A SINGLE PICTURE'S PERMALINK, added 2026-08-11 — and it is the ONE fb kind whose id is
   * a LONE number rather than the `{owner}_{post}` pair, because the photo's `fbid` alone names it.
   *
   * MEASURED FROM CLOUDFLARE EGRESS (wrangler dev --remote), 2026-08-11, over the six spellings
   * Facebook emits for one picture. Handed to Meta's embed plugin, all six return the SAME fragment:
   *
   *   /{page}/photos/{fbid}/                     74,474 bytes, the post
   *   /{page}/photos/pcb.{postId}/{fbid}/        74,502 bytes, the same post
   *   /photo.php?fbid={fbid}&set=pb.…&type=3     74,536 bytes, the same post
   *   /photo/?fbid={fbid}                        74,471 bytes, the same post   <- NO owner, NO set
   *
   * The last line is why the id is the fbid alone: the query spellings carry no owner at all, so a
   * composite id would have a hole in it on two of the six, and the fbid needs no company to resolve.
   * All six therefore converge on ONE cache entry instead of six.
   *
   * THE TRAILING NUMBER IS THE PHOTO, NOT THE POST, and building a `post` ref out of it would name
   * nothing: measured on the reported link, photo 1596906755391068 belongs to post 1596906778724399,
   * and on a second page photo 1632169048280519 belongs to post 1632169068280517. The two id spaces
   * look alike and are not the same number.
   *
   * TWO PICTURES OF ONE POST ARE TWO REFS, and that is accepted rather than fixed. Measured on a
   * four-photo post, fbid …900257527 and fbid …666570257660 return the same 86,865-byte fragment and
   * therefore the same card. They are two cache entries for one card, which costs a second fetch and
   * nothing else; collapsing them would need the parent post id, which the url does not carry.
   */
  | { p: 'fb'; kind: 'watch' | 'reel' | 'share' | 'group' | 'post' | 'photo'; id: string }
  /**
   * THE yt-dlp TIER — Dailymotion and Streamable. One opaque id is the whole identity on each (like
   * yt), because exactly ONE surface per platform is routable: no `kind` discriminator can earn its
   * keep. Both share the Facebook shape end to end — the card's metadata comes from the container's
   * `{page, meta:true}` (`yt-dlp -J`) and the video is a `remux: {page}` — so neither has a platform
   * fetcher that touches the network. Measured 2026-07-26: both extract, and both mux to a real
   * `ISO Media, MP4` file. Imgur WAS a third member and is no longer; see its own note below.
   *
   * NEWGROUNDS IS DELIBERATELY ABSENT. Every path 403s behind a JS challenge served by Newgrounds' own
   * proxy (`<title>NG Guard</title>`, /_guard/assets/main-*.js), INCLUDING the site root, independent
   * of UA and with no cookie set — yt-dlp cannot pass it because it cannot execute the guard's JS. That
   * was measured from a RESIDENTIAL host, which bot guards normally treat more favourably than
   * datacenter, so Cloudflare egress is very unlikely to be better. Its route shapes
   * (/portal/view/{digits}, /audio/listen/{digits}) are free and collision-proof, so adding it later
   * costs nothing — but it must not be half-added on the strength of an older measurement.
   */
  | { p: 'dm'; id: string }
  | { p: 'st'; id: string }
  /**
   * IMGUR LEFT THE TIER ABOVE, and the paragraph above no longer describes it. It kept the tier's
   * shape for as long as `.gifv` was the only routable surface; it now has three, because Imgur's own
   * JSON API turns out to answer for albums and stills that yt-dlp refuses outright:
   *
   *   ERROR: [Imgur] QAcLnaf: QAcLnaf is not a video or animated image   (measured 2026-07-31)
   *
   * That refusal is in yt-dlp's extractor, not in Imgur, so no amount of container work reaches a
   * photo. The API does, cookie-free, in one request — see platforms/imgur/fetch.ts.
   *
   * THE `kind` EARNS ITS KEEP THE WAY TWITCH'S DOES: the three surfaces need three different
   * canonicals (`/a/{id}`, `/gallery/{id}`, `/{id}`) and, for 'album' and 'gallery', a different API
   * endpoint — and canonical() runs in the ROUTER, long before any fetch could disambiguate them.
   * 'post' still covers gifv, animated and still singles alike, because the API reports which it is
   * and nothing upstream of the fetch needs to care.
   */
  | { p: 'im'; kind: 'post' | 'album' | 'gallery'; id: string }
  /**
   * A TWITCH CLIP, and clips ONLY — the slug is the whole identity, exactly like `yt`. The channel
   * segment in `twitch.tv/{channel}/clip/{slug}` is DECORATION: the GraphQL surface resolves by slug
   * alone, and `clips.twitch.tv/{slug}` (the share button's own output) carries no channel at all, so
   * putting it in the ref would make one clip mint two cache entries.
   *
   * VODS AND LIVE CHANNELS ARE DELIBERATELY ABSENT, not forgotten. A VOD (`/videos/{id}`) is HLS only
   * — there is no progressive mp4 to hand Discord — so it could be at best a cover still, and a
   * multi-hour VOD is not a remux candidate the way a 44-second clip is. A bare `/{channel}` is a
   * LIVE-STATE surface whose card is stale the moment the stream ends, and its name shape (lowercase,
   * 4-25 chars) is indistinguishable from the Twitter/Instagram handles the ambiguity chooser already
   * owns at depth 1. Both are honest notfound today; both are additive later.
   */
  | { p: 'tw'; kind: 'clip'; slug: string }
  /**
   * LEMMY — AND THE ONLY REF IN THIS UNION THAT CARRIES A HOSTNAME, which is a deliberate break from
   * every sibling above and needs its reason stated.
   *
   * Every other platform here is ONE site, so replacing the host is lossless. The fediverse is not
   * one site, and a Lemmy post id is LOCAL TO THE INSTANCE THAT SERVES IT: the same post is
   * sopuli.xyz/post/49387259 and lemmy.dbzer0.com/post/72978307. Ids are per-instance dense, so a
   * bare /post/{id} resolved against a default instance does not usually 404 — it returns a REAL BUT
   * COMPLETELY DIFFERENT POST. Measured 2026-07-27: 10 of 50 lookups in the shared dense id range,
   * and 2 of 12 current lemmy.world ids against lemmy.dbzer0.com. Roughly ONE IN FIVE, silently.
   *
   * That is the worst failure mode this project recognises, so the instance is part of the identity
   * and the URL must carry it. There is no default instance and there will not be one.
   *
   * `host` IS ATTACKER-SUPPLIED AND IS FETCHED. It is the only field in any ref that becomes the
   * ORIGIN of a request rather than a path component of a fixed one, which is why refkey.ts
   * shape-checks it (see FEDI_HOST) and platforms/lemmy/fetch.ts guards it again at the boundary.
   *
   * NO DEFAULT AND NO ALLOWLIST. An allowlist was the obvious answer and the precedent argues
   * against it: FixTweetBot hardcodes exactly ten Mastodon instances, and the fixer those ten point
   * at is now DEAD (connection refused on 443). A curated list rots and truncates a long tail that
   * is genuinely long — 481 instances in the public census.
   */
  | { p: 'lm'; host: string; kind: 'post' | 'comment'; id: string }
  /**
   * THE MASTODON-API FAMILY — the second host-carrying ref, and everything the 'lm' comment above
   * says about why the instance is part of the identity applies here unchanged.
   *
   * ONE REF FOR MANY SOFTWARES, deliberately. `/api/v1/statuses/{id}` is the de-facto standard of
   * the microblogging fediverse, so ONE client covers several products. That is why this arm names an
   * API rather than a product: calling it `mastodon` would invite a near-identical `pleroma` arm.
   *
   * WHAT IT ACTUALLY COVERS, measured 2026-07-28 against real permalinks rather than assumed from
   * the API's reputation — an earlier draft of this comment claimed GoToSocial and Pixelfed and was
   * WRONG about both, the same false-coverage mistake this project just spent two commits undoing
   * for PieFed:
   *
   *   Mastodon    ✅  200, id from the URL
   *   Pleroma     ✅  /notice/{id}; the flake id in the URL is verbatim the API id
   *   Akkoma      ✅  same
   *   Iceshrimp   ✅  answers BOTH this and the Misskey API
   *   GoToSocial  ❌  401 `token not supplied`, on 0.21 and 0.22, on two instances. Unsigned
   *                   ActivityPub is 401 too. There is no unauthenticated path; only its OG tags.
   *   Pixelfed    ❌  HTTP 500 carrying `{"error":"Unauthenticated."}` on pixelfed.social and a 302
   *                   to /login on pixey.org. (A 500 whose body is an auth error is a good reminder
   *                   why this project asserts on content, never on status.)
   *
   * The router therefore mints NO ref for a Pixelfed `/p/{user}/{id}` url: a shape that always fails
   * the liveness assert is worse than an honest notfound, because it looks supported.
   *
   * MISSKEY IS NOT IN THIS FAMILY — see the 'mk' arm below.
   *
   * FRIENDICA IS DELIBERATELY ABSENT even though it answers this API, because its URL does not carry
   * the id the API wants: the permalink is `/display/{guid}` while `/api/v1/statuses/` takes a
   * NUMERIC uri-id, and `/api/v1/search?resolve=true` — the documented way to map one to the other —
   * is 401 `This API requires login`. The mapping exists only inside the HTML page, so supporting it
   * means an HTML scrape rather than a URL derivation. Not worth it for the traffic.
   *
   * THERE IS NO `kind`. This family has exactly one addressable object — a status — where Lemmy has
   * posts and comments. A reply is a status too, so it needs no distinct arm.
   *
   * THE USERNAME IS NOT PART OF THE IDENTITY, verified rather than assumed: `/@anything/{id}` on
   * mstdn.social 302s to exactly the same `/redirect/statuses/{id}` as the true handle. Only the
   * trailing id is identity, so the ref carries no user — the same finding as Pinterest's slug.
   */
  | { p: 'ms'; host: string; id: string }
  /**
   * THE MISSKEY FAMILY — Misskey, Sharkey, Iceshrimp — read through `POST /api/notes/show`. The
   * instance-in-the-path reasoning from 'lm' applies here too.
   *
   * IT IS A SEPARATE CLIENT BECAUSE THE MASTODON ONE DOES NOT REACH THEM, measured rather than
   * assumed:
   *
   *   Misskey            `/api/v1/statuses/{id}` → 404 `UNKNOWN_API_ENDPOINT`. No compat layer at all.
   *   Sharkey 2025.4.7   404 `NO_SUCH_NOTE` for ORIGINAL notes while boosts succeed — the same split
   *                      on three separate instances over 60 notes (blahaj.zone 13/20,
   *                      transfem.social 6/20, woem.men 10/20 via the Mastodon API; 20/20 via
   *                      notes/show). The version correlation is measured; the cause is not.
   *   Sharkey 2025.5.2+  both APIs work.
   *   Iceshrimp         both APIs work.
   *
   * So `notes/show` is preferred for EVERYTHING Misskey-derived rather than trying the Mastodon
   * endpoint first: all three answer it, all three take the id straight out of `/notes/{id}`, and it
   * has no version hole to fall into.
   *
   * THE SHAPES DIFFER FROM MASTODON'S IN WAYS THAT MATTER, all handled in the normalizer: an
   * attachment's `type` is a MIME STRING (`image/webp`, `video/mp4`) rather than an enum, dimensions
   * live in `properties` and are `{}` for video, the body is `text` not `content` and is PLAIN TEXT
   * rather than HTML, the content warning is `cw`, and there is NO note-level sensitive flag — only
   * `files[].isSensitive`.
   */
  | { p: 'mk'; host: string; id: string }
  /**
   * PEERTUBE — the fourth host-carrying ref, and the reasoning in the 'lm' comment applies unchanged.
   *
   * IT NEEDS NO REMUX CONTAINER, and BOTH FILE SHAPES EXIST IN THE WILD — which is the part worth
   * writing down, because each of the two surveys that looked at this saw only one of them:
   *
   *     framatube.org      files[]: 1080p (185 MB), 480p 854x480 (25 MB), 360p, Audio only
   *     video.blender.org  files[]: 1080p, 480p, Audio only
   *     tilvids.com        files[]: **Audio only, and nothing else**
   *                        streamingPlaylists[0].files[]: 1080p, 360p (33 MB), 144p — FRAGMENTED
   *
   * Whether an instance publishes progressive "web videos" at all is an ADMIN SETTING, so neither
   * shape can be assumed. Both are served, because both are real mp4s:
   *
   *     progressive (framatube 480p)  206, video/mp4, `ftypisom`, ranges honoured
   *     fragmented  (tilvids 360p)    206, video/mp4, `ftypiso5`, ranges honoured, and ffprobe
   *                                   decodes it as h264 + aac — a CMAF mp4, not a manifest
   *
   * So PeerTube is a DIRECT-SERVE platform like Pinterest, not a container one. The HLS MASTER
   * (`playlistUrl`, an .m3u8) is still ignored: Discord cannot play a manifest, and advertising one
   * as og:video is the dead-player defect fixed in Phase 1. Only the per-rendition mp4s are used.
   *
   * THE ID IS THE shortUUID OR THE UUID. Both address the same video through
   * `/api/v1/videos/{idOrUUID}`, and so does the numeric id — verified byte-identical bodies for all
   * three. Only the two that appear in a pasted URL are routed.
   *
   * LIVE STREAMS AND PLAYLISTS ARE DELIBERATELY ABSENT. `isLive` has no file to serve and its card
   * would be stale the moment the stream ends; `/w/p/{id}` is a playlist, a different object with no
   * single video to embed.
   */
  | { p: 'pt'; host: string; id: string }
  /**
   * A PINTEREST PIN. The numeric id is the whole identity: Pinterest itself IGNORES the slug in
   * `/pin/{slug}--{id}/` (verified — an invented slug returns the same pin), and every regional
   * domain serves the same id, so neither belongs in the ref.
   *
   * `pin.it/{code}` IS DELIBERATELY ABSENT. It is an opaque short code that names no pin until a
   * network hop resolves it, and once the host is replaced it collapses to a BARE /{code} at depth 1
   * — the shape the ambiguity chooser already owns. It would need the async-resolver treatment
   * /t/{code} gets, and no live code could be captured to measure the success path, so it is an
   * honest notfound rather than a guess.
   */
  | { p: 'pn'; id: string }

/**
 * AN ACCOUNT, NOT A POST — and it is a separate type from PostRef rather than a new arm of it,
 * which is the first of the two decisions this feature turns on.
 *
 * A PostRef names something that was published once and never changes. An account is a LIVE
 * surface: its counts move every minute and its bio moves whenever the owner edits it. The
 * machinery hung off PostRef assumes the first — the post cache stores a normalized Post for
 * POST_TTL, /_media/ hands Discord a url whose bytes are expected to be stable, and the Mastodon
 * spoof turns a refKey into a status id. None of that is right for a profile, and pretending
 * otherwise is how a card ends up promising numbers that were true fifteen minutes ago.
 *
 * IT ALSO KEEPS refkey.ts ALONE. refKey/parseRefKey are the security boundary for what crosses
 * the wire and comes back, and their kind lists are allowlists; a profile mints NO refKey at all
 * (see render/profile.ts for why the avatar needs no /_media/ hop), so nothing new crosses that
 * boundary and its allowlists are untouched. A profile arm on PostRef would have had to be added
 * there, and forgetting it is silent — the `fb:group:` scar.
 *
 * ONE PLATFORM TODAY, spelled as a literal so a second is a deliberate type change rather than a
 * widening nobody reviews. See router.ts's profile() for the measurement that made Bluesky the
 * only member.
 */
export type ProfileRef = { p: 'bs'; handle: string }

/**
 * WHAT A PROFILE CARD IS ALLOWED TO SAY. Every field is either measured from the platform's own
 * payload or ABSENT — there is no field here whose value can be inferred, and that is the second
 * decision this feature turns on.
 *
 * WHY IT IS NOT A `Post` WITH THE HOLES FILLED IN. Post makes two demands a profile cannot meet
 * honestly:
 *   - `createdAt: Date` is REQUIRED, and a profile has no post date. Reusing the field would put
 *     either the account's join date (a different thing, mislabelled) or `new Date()` (a
 *     fabrication) on every card.
 *   - `counts` is {likes, reposts, replies, views} — engagement on ONE post. Followers, follows
 *     and post totals are none of those, and mapping followers onto `likes` to reuse the renderer
 *     would print a number under an emoji that means something else.
 * Both are the kind of "plausible value filling a hole" this project forbids on the card, so the
 * type refuses to have the holes.
 *
 * EVERY COUNT IS OPTIONAL, INDIVIDUALLY. A platform that publishes followers and not posts gets a
 * card with followers and no posts line, rather than a zero. `0` is a real answer (a new account
 * genuinely has 0 followers) and is rendered as one; `undefined` means nobody told us.
 */
export type Profile = {
  ref: ProfileRef
  canonical: string
  /** The handle as the PLATFORM spells it, which is not always what the url carried (a DID resolves). */
  handle: string
  /** The display name. Empty string when the account has none — never backfilled from the handle. */
  name: string
  /** The bio, plain text. Empty when the account has none. */
  bio: string
  /**
   * The avatar, as an ORIGIN url rather than a /_media/ one — the only place in this codebase that
   * does that, and it is admitted only under the allowlist in normalize (see there). Absent means
   * the account has no avatar, never a placeholder.
   */
  avatar?: string
  /**
   * WHEN THE ACCOUNT WAS CREATED, and only when the platform states it. This is NOT a post date and
   * is never rendered as one; the card says "joined". Absent on any platform that does not publish
   * it, which is why it is optional rather than defaulted to the epoch — the 1970 card is a defect
   * this project has already shipped once.
   */
  createdAt?: Date
  counts: { followers?: number; following?: number; posts?: number }
}

export type Media = {
  kind: 'image' | 'video' | 'gif'
  /**
   * Origin CDN URL as of this Post's fetch. May be signed and expiring; staleness
   * is bounded by the Post cache TTL plus the /_media/ 302's max-age.
   * Never emitted to a client — always via /_media/{refKey}/{index}.
   */
  url: string
  w: number
  h: number
  duration?: number
  alt?: string
  /**
   * THE POSTER FRAME OF A VIDEO — a still IMAGE, never the video itself. Same staleness bound
   * and the same never-raw rule as `url`: it reaches a client only as /_media/{refKey}/poster{i}.
   *
   * Mastodon's `media_attachments[].preview_url` on a video attachment is this picture, and
   * getting it wrong is a MEASURED defect rather than a theoretical one (2026-07-19). The Phase 2
   * mapper set preview_url = url for every attachment; on an image that is harmless — an image is
   * its own poster — but on a video it told Discord to fetch a poster and handed it mp4 bytes,
   * and Discord answered by dropping the rich activity card back to the plain OpenGraph one.
   * Production fxtiktok's own payload sends a real cover image here and keeps the card.
   *
   * OPTIONAL, and its absence must degrade to an OMITTED preview_url rather than to `url` —
   * falling back to the video is the defect itself and must not survive as a fallback.
   */
  poster?: string
  /**
   * THE POSTER'S OWN PIXEL SIZE, which is NOT the video's and is only needed when the two differ.
   *
   * THE DEFECT THAT REQUIRES IT, reported 2026-07-31 on yt:Jky5ZXI0axc — "not a single one has
   * generated a card", across four url spellings. Every piece worked in isolation: the spoof carried
   * one attachment, `/_media/{key}/poster0` 302'd to a real 20,338-byte JPEG. What was missing was
   * `meta.original`, and mastodon.ts omits that block when the dimensions are unknown. Discord will
   * not lay out an IMAGE attachment it has no size for, so it drew nothing at all.
   *
   * The zero came from YouTube by design: a remux video carries `w: 0, h: 0` so Discord reads the
   * muxed mp4's real dimensions and a Short plays portrait without a per-surface hint. That is right
   * for the VIDEO and wrong for the STILL settleMux degrades it to, which copied `w`/`h` straight
   * across and inherited 0x0. Compare Pinterest, whose plain image carries 1152x620 and renders.
   *
   * Set it wherever the poster's size is known independently of the video's; the degrade prefers it
   * over `w`/`h`. Absent means "same as the video, or unknown", which is the old behaviour.
   */
  posterW?: number
  posterH?: number
  /**
   * A video that is NOT a directly-playable url — it is DASH/HLS or a yt-dlp page that a bare fetch
   * cannot serve as og:video. When present, the /_media/ route resolves it to a progressive MP4 via
   * the media-resolver container (cached in R2) instead of 302-ing to `url`; `url` stays the plain
   * source. Either explicit tracks we already extracted (`video` [+ `audio`]) or a `page` for yt-dlp.
   *
   * SAFE WHEN THE CONTAINER IS ABSENT: liveFetchPost downgrades a remux video to its poster still
   * when the MEDIA_RESOLVER binding is unset, so a deploy without the container renders the cover
   * rather than a dead player — the same behavior the DASH/HLS platforms had before playback existed.
   */
  remux?: { video?: string; audio?: string; page?: string }
  /**
   * "THIS ENTRY'S BYTES ARE AT /_media/{refKey}/poster{i} — NOT AT /_media/{refKey}/{i}."
   *
   * Set by exactly ONE line: settleMux's DEADLINE degrade, which turns a `{page}` remux VIDEO into
   * its poster STILL *without moving it in the array*. The /_media/ route re-derives the post from
   * the cache, and a degraded card is deliberately not response-cached, so the route still finds the
   * remux VIDEO at that index, tries the mux again, fails again, and answers 503 no-store. Measured
   * on yt:Jky5ZXI0axc (1431s, over the container's MAX_SECONDS): `/0` -> 503 while `/poster0` -> 302
   * -> i.ytimg.com/vi/Jky5ZXI0axc/hqdefault.jpg. The card was naming the wrong one of two
   * already-correct urls, so Discord fetched an IMAGE url that 503s: no picture, no player.
   *
   * A FIELD, NOT A ROUTE CHANGE, and that is the whole safety argument. Nothing here alters what any
   * url ANSWERS: `{i}` stays video-bytes-or-503 forever (serveMuxed/notReady, the 2026-07-24
   * poisoned-url rule) and `poster{i}` stays an image-or-404 forever (router.ts's poster matcher
   * allows IMAGE extensions only, so `poster0.mp4` 404s). The two url classes stay disjoint across
   * the degrade and back, which is exactly what Discord's per-url media cache needs.
   *
   * withResolver's BINDINGS degrade MUST NOT SET IT. That rewrite runs inside getPost, so the
   * /_media/ ROUTE sees the same degraded entry and the bare `{i}` already resolves to the poster
   * there (pinned by test/media-resolver.test.mjs's "resolver absent … 302 to the thumbnail") — and
   * that degrade DROPS `poster`, so a poster slot would read a field that is not there and 404.
   * The two degrade shapes differ deliberately; see the comment at each site.
   *
   * READ DEFENSIVELY AND NEVER TRUSTED ALONE: bytesIndex also requires a string `poster` and a
   * non-video `kind`, because deserializePost validates nothing about media[] and pickMedia's poster
   * branch has NO FALLBACK TO m.url — a slot minted for an entry without a poster is a guaranteed
   * 404, the og:image=".../undefined/avatar" scar. Not persisted today either: both degrades run
   * after the post cache is written.
   */
  posterOnly?: true
}

/**
 * Everything /_media/{refKey}/{…} can address. Named once, because four modules spell it and a
 * fifth parses it off the wire: router.ts mints it, embed.ts's mediaUrl serializes it, media.ts's
 * pickMedia resolves it, and the renderers pass it through.
 *
 *   number            media[i] itself — the picture, or the video file
 *   'avatar'          the author's avatar
 *   {poster: i}       media[i]'s POSTER FRAME, a still image (see Media.poster)
 *
 * The poster form is an OBJECT rather than a string so it cannot be confused with either sibling
 * by any consumer: `typeof === 'number'` and `=== 'avatar'` both stay total, and a `{poster}` that
 * reached a numeric path would be a type error rather than a silently-coerced index.
 */
export type MediaIndex = number | 'avatar' | { poster: number }

export type Post = {
  /** Identity AND platform. Use ref.p; there is deliberately no `platform` field. */
  ref: PostRef
  canonical: string
  author: {
    name: string
    handle: string
    url: string
    /** Same staleness bound as Media.url. Renderers MUST emit /_media/{refKey}/avatar. */
    avatar?: string
  }
  /**
   * A headline distinct from the body — Reddit posts have one, and future link/article/video cards
   * will too. Renderers draw it as a BOLD leading block above `text`; platforms with no title concept
   * (Twitter, Bluesky, …) leave it undefined and render exactly as before. Not identity: a title can
   * be empty, change, or be absent, so it never enters the ref or a cache key.
   */
  title?: string
  text: string
  createdAt: Date
  media: Media[]
  counts: { likes?: number; reposts?: number; replies?: number; views?: number }
  /** Depth-limited to exactly 1: post.quote.quote is always undefined. */
  quote?: Post
  /** Depth-limited to exactly 1: post.replyTo.replyTo is always undefined. */
  replyTo?: Post
  sensitive: boolean
}

export type ClientClass = 'discord' | 'telegram' | 'other-bot' | 'human'

export type Route =
  | { kind: 'site'; path: string }
  | { kind: 'media'; ref: PostRef; index: MediaIndex }
  /**
   * The two Mastodon-spoof callbacks Discord makes after reading the head's
   * <link rel="alternate"> tags. Machine-facing siblings of 'media': the ref is the
   * whole payload, there is no canonical to redirect a human to, and neither carries
   * the advertised handle — that segment is decoration (see router.ts).
   */
  | { kind: 'activity'; ref: PostRef }
  | { kind: 'oembed'; ref: PostRef }
  /**
   * A spoof-SHAPED path whose {id} did not decode. Separate from 'notfound' because the
   * shape already tells us the caller is a JSON consumer, and handing that caller the HTML
   * error embed makes it parse-fail rather than degrade — the one thing the renderer's
   * contract forbids. Decided last, so it only ever replaces what was already a notfound:
   * the spoof matchers' fallthrough is untouched.
   */
  | { kind: 'badid' }
  /**
   * THE FIXER PAGE ASKING US TO GET READY — `/_prep?p={path}`.
   *
   * Two jobs, both requested by the owner 2026-07-31: resolve a share code so the page can show the
   * real permalink instead of a host-swapped opaque token, and START THE MUX so the video is warm by
   * the time the link is pasted into Discord. Today the first paste of a cold video degrades to a
   * still, and the page is the one moment we know a link is about to be shared.
   *
   * IT GRANTS NO NEW REACHABILITY, which is the whole safety argument and the reason it can do real
   * work. Everything it does is what a Discordbot GET of the same url already does, seconds later,
   * from anyone who sets a UA — the same fetch, the same container dispatch, behind the same
   * SPECULATIVE_MUX_CAP and the same muxOnce dedupe. It buys latency, not permission.
   */
  | { kind: 'prep'; target: string }
  // /_card?p={path} — describe the card Discord will draw, for the fixer page's preview.
  | { kind: 'card'; target: string }
  /**
   * /_api/v1?url={the whole original url} — the public JSON API.
   *
   * `target` IS NULLABLE HERE AND NOWHERE ELSE IN THIS UNION, deliberately: a request with no `url`
   * parameter is a malformed REQUEST, and the one thing this endpoint must not do is answer it the
   * same way it answers "that url has no post". Every other internal route falls through to notfound
   * for a missing target because the page that calls them never omits it; a public endpoint is asked
   * wrongly all the time, and telling the caller so is most of what makes it usable.
   */
  | { kind: 'api'; target: string | null }
  | { kind: 'post'; ref: PostRef; canonical: string }
  /**
   * AN ACCOUNT PAGE — `/profile/{handle}`, which is bsky.app's own permalink with the host swapped
   * and nothing else edited.
   *
   * IT IS ITS OWN KIND, not a 'post' with a profile-shaped ref, because every consumer of 'post'
   * (renderPostRoute's mux prewarm, the translation race, /_media/, the Mastodon spoof, the post
   * cache) is written against a Post and would need a profile branch. One route kind keeps the
   * profile path visible to a reader instead of hidden inside five `if`s.
   *
   * WHY ONLY THIS SHAPE IS UNFORCED, and why the other candidates are not here at all, is argued
   * at router.ts's profile() — the shadowing analysis is the dangerous half of this feature.
   */
  | { kind: 'profile'; ref: ProfileRef; canonical: string }
  /**
   * A short code that NAMES no post yet. Deliberately not a 'post' with a ref: a short code is
   * not a post id, and TikTok and Threads mint the identical /t/{code} shape — putting one into
   * a PostRef would be guessing, and every downstream consumer would then treat it as an id.
   *
   * `p` names WHICH RESOLVER TO RUN, not which platform the link belongs to. worker.ts resolves
   * it asynchronously (route() is synchronous and always will be); if the resolver says no, the
   * answer is the ambiguous chooser, which is what this path would have served with no resolver
   * at all.
   *
   * `canonical` is the short URL itself, so a human costs us zero upstream fetches — it resolves
   * in their browser exactly as it does in ours.
   */
  | { kind: 'shortlink'; p: 'tt'; code: string; canonical: string }
  /**
   * Reddit's mobile-app "copy link" share form — /r/{sub}/s/{code} (or /user/{name}/s/{code}). Like
   * 'shortlink' the {code} is an OPAQUE token that names no post until a network hop resolves it, so
   * it is deliberately not a 'post' ref. UNLIKE 'shortlink' it is UNAMBIGUOUS (the /r/ or /user/
   * prefix names Reddit), and Reddit resolves it with a plain 301 to the /comments/{id} permalink —
   * so worker.ts follows that redirect, re-routes the permalink through route(), and hands the
   * resolved ref to the ORDINARY reddit post path. No chooser, no separate gate vocabulary: a
   * resolve miss is the same generic "couldn't load" card a permalink gets. `canonical` is the share
   * url itself (a human resolves it in their own browser at zero upstream cost); `sub` is carried for
   * clarity only — the resolver reads the post id from the redirect, never from these fields.
   */
  | { kind: 'redditshare'; sub: string; code: string; canonical: string }
  /**
   * META'S BARE SHARE CODE — `/share/{code}`, which BOTH Threads and Facebook mint in the identical
   * shape. Like 'redditshare' the code is an OPAQUE token naming no post until a network hop resolves
   * it; UNLIKE it, the code does not even name the PLATFORM, which is why this carries no `p`.
   *
   * IT WAS A CROSS-SITE MISROUTE BEFORE THIS EXISTED (reported 2026-07-30): facebook()'s bare-share
   * arm claims any `[A-Za-z0-9]{5,}`, so a THREADS share token was 302'd to facebook.com — a site the
   * sharer never pasted. The resolver asks both hosts and follows whichever 302s; see
   * platforms/metashare/fetch.ts for the measurement.
   *
   * `canonical` IS THE THREADS URL rather than either resolution, because a bare code cannot be
   * attributed before the hop and Threads is the shape that was BROKEN. It is only ever used as a
   * last-resort failure link, never as the card's canonical — a resolved share takes the ordinary
   * post path and gets that platform's own canonical, with every share parameter stripped.
   */
  | { kind: 'metashare'; code: string; canonical: string }
  | { kind: 'ambiguous'; path: string; candidates: Platform[] }
  | { kind: 'notfound' }

export type Outcome =
  | { kind: 'post'; post: Post }
  /**
   * A rendered ACCOUNT. Separate from 'post' for the reason ProfileRef is separate from PostRef:
   * render()'s post arm reaches renderPost/renderTelegram/renderSpoof, all of which read a Post,
   * and the Mastodon spoof in particular exists to draw media attachments a profile does not have.
   */
  | { kind: 'profile'; profile: Profile }
  | { kind: 'ambiguous'; path: string; candidates: Platform[] }
  /**
   * `gate` marks a failure that is a known LIMIT rather than an error, and NAMES which limit — the
   * three-way distinction this replaced the earlier boolean `ageRestricted` to express:
   *   'age'     — an age-restricted post (Twitter TweetTombstone; TikTok isContentClassified + no video).
   *   'private' — a private / login-required post (Twitter protected account via the guest reason;
   *               TikTok statusCode 10216 private-post / 10222 private-account).
   * render() gives each a distinct, calmer embed (the owner's copy) naming the specific limit; every
   * other failure — a deleted post, a network error, a platform with no such signal — leaves `gate`
   * undefined and falls to the LOUD DEFAULT: a calm neutral "couldn't load this post" card (same grey
   * as the gate cards), NOT the old alarm-red "…extraction failed" that read as our bug. Optional, so
   * only the gated paths set it; its absence is the honest-hedged default (see render/index.ts).
   */
  /**
   * `subject` names WHAT could not be loaded, and exists because the default card says "post" in
   * words. A profile route that fails would otherwise render "Couldn't load this Bluesky post" for
   * a url that names an account and no post at all — a card that misdescribes what was asked for is
   * the same class of small lie as an invented count. Optional, so every existing failure site is
   * untouched and still means 'post'.
   */
  | {
    kind: 'failure'; canonical: string | null; platform: Platform | null; reason: string
    gate?: 'age' | 'private'; subject?: 'profile'
  }
