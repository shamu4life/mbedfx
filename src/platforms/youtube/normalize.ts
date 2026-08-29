import type { Post, PostRef } from '../../types.ts'
import { uploadDateFrom, uploadDateOrEpoch } from '../uploaddate.ts'
import type { YouTubeFetch } from './fetch.ts'

type Any = Record<string, any>

/**
 * Pure: oembed enrichment (or nothing) -> a REMUX-video Post. Always returns a Post — a YouTube link is
 * renderable from the id alone (the thumbnail + the remux source both derive from it), so an oembed miss
 * just loses the real title/channel, never the card. No I/O — testable against captured oembed.
 *
 * IT READS THE CLOCK, EXACTLY ONCE, AND THIS FILE USED TO CLAIM IT DID NOT. That claim ("no I/O, no
 * clock") was true while createdAt was a hardcoded `new Date(0)`; it stopped being true the moment the
 * real upload date arrived, and it was deleted here rather than left lying. The read is
 * uploadDateFrom's default `now`, which exists for ONE purpose: the future bound on an upstream
 * timestamp. That bound cannot be dropped — an upstream value 130,000 years out is exactly the junk
 * this normalizer must not turn into a card — and threading a `now` through would add a parameter no
 * caller has anything to pass (worker.ts has no clock of its own), i.e. a dead seam of the kind
 * fetch.ts's `uploadedAt` parameter already was. So the clock stays, deliberately, and is named here.
 *
 * WHAT IS STILL DETERMINISTIC, precisely: every input except a FUTURE-DATED one maps to the same
 * output whenever it is evaluated, because the only clock-dependent branch is `ms > now + 1 day`.
 * A test that needs the bound itself pinned calls uploadDateFrom with an explicit `now` — which is
 * exactly what youtube-normalize.test.mjs's range test does.
 *
 * The video is a `remux: {page}` — the container's yt-dlp resolves the watch url to a REAL progressive
 * mp4 the /_media route serves, which Discord plays with its NATIVE video player (scrubbing, no iframe)
 * and which is AD-FREE (YouTube's ads are stitched in client-side by its player, never baked into the
 * file). This replaced an earlier twitter:card=player iframe attempt: the iframe IS Discord's native
 * YouTube handling — same ads, same login-blind player — so it fixed nothing (owner's whole point). The
 * ad-free stream needs a JS runtime (Deno) in the container to solve YouTube's signature challenge;
 * with it, extraction works from CF datacenter egress (measured 2026-07-22 — YouTube is NOT IP-blocked,
 * the earlier "empty result" was a container skip-bug + a missing JS runtime). withResolver degrades the
 * remux to the thumbnail still when no container is bound, so a link never shows a dead player.
 */
/**
 * THE UPLOAD DATE, and why it is fetched at all.
 *
 * This used to be a hardcoded `new Date(0)` with the comment "oembed carries no timestamp; a fixed
 * epoch keeps this pure". The first half is true — oembed's response has no date field of any kind
 * (measured: author_name, author_url, height, html, provider_name, provider_url, thumbnail_*, title,
 * type, version, width, and nothing else). The second half was the mistake: the epoch is not a
 * neutral placeholder, it RENDERS. render/mastodon.ts maps post.createdAt straight into the spoof's
 * `created_at`, which is the field Discord draws the card's timestamp from — so every YouTube embed
 * displayed 1 January 1970. A fabricated date is worse than an absent one, and this one was
 * fabricated on every single YouTube card.
 *
 * WHERE THE VALUE COMES FROM, CORRECTED 2026-07-26. The first fix read the watch page's own
 * `<meta itemprop="datePublished">`. Measured live against the apex with a Discordbot UA, on the
 * field that actually renders (`created_at` on the /users/{h}/statuses/{id} callback), that source
 * was right 1 time in 3 — /watch?v=jNQXAC9IVRw and /watch?v=M7lc1UVf-VE both came back
 * 1970-01-01T00:00:00.000Z while /watch?v=9bZkp7q19f0 came back 2012-07-15T07:46:32.000Z. It also
 * cost a 1,575,509-byte request to youtube.com on the FIRST-PASTE critical path. It is gone; the
 * value now comes from the container's `yt-dlp -J` `timestamp` (epoch SECONDS), which reproduces the
 * shipped semantics to the second: `Date.parse('2009-10-24T23:57:33-07:00')/1000 === 1256453853`,
 * and 1256453853 is exactly what yt-dlp returns for that video (measured 2026-07-26). See worker.ts's
 * youtubeMeta for the cache, the gate chain and the bounded wait.
 *
 * A MISS STILL FALLS BACK TO THE EPOCH, deliberately. Post.createdAt is a required Date, and the two
 * honest alternatives — making it nullable across all eight platforms, or omitting `created_at` from
 * a Mastodon status where the schema requires it — are both larger changes than this defect warrants,
 * and the second is unverifiable without a real Discord client. The fallback is now reached rarely
 * (a video whose meta is not yet cached and whose container call missed) rather than ~70% of the time.
 */

/**
 * THE ONE SPELLING OF THE FALLBACK AUTHOR URL, exported because youtubeVouched compares against it.
 * A rename that touched only one of the two would silently turn the vouch into "always vouched", i.e.
 * would hand an arbitrary 11-char id a container call.
 */
export const YT_FALLBACK_AUTHOR_URL = 'https://www.youtube.com'

/**
 * The `@handle` out of an oEmbed `author_url`, or '' when it names a channel some other way.
 *
 * Returns the handle WITHOUT its leading '@', because every consumer here re-adds one: the byline
 * renders `(@{handle})` and twitter:site/creator emit `@{handle}`. Returning it with the '@' shipped
 * `(@@uwu-lf9yw)`.
 *
 * Parsed rather than regexed off the raw string so a hostile or malformed author_url cannot smuggle
 * anything: a non-URL throws into '' , and only the FIRST path segment is considered, so
 * `/watch/@notahandle` is not one. The character class is YouTube's own handle alphabet (letters,
 * digits, dot, dash, underscore, 3-30 chars); anything outside it falls back to the display name.
 */
export function ytHandle(authorUrl: string): string {
  let seg: string
  try {
    seg = new URL(authorUrl).pathname.split('/').filter(Boolean)[0] ?? ''
  } catch {
    return ''
  }
  if (!seg.startsWith('@')) return ''
  const h = seg.slice(1)
  return /^[A-Za-z0-9._-]{3,30}$/.test(h) ? h : ''
}

/**
 * THE RANGE-CHECKED PARSE MOVED to platforms/uploaddate.ts, unchanged, when the yt-dlp tier needed the
 * same rule — see that file for why a second copy of it was a 500 rather than a style problem. It is
 * re-exported here because this module is where its consumers (worker.ts, the normalizer tests) have
 * always imported it from, and moving a file is not a reason to churn every import of it.
 */
export { uploadDateFrom } from '../uploaddate.ts'

/**
 * DID YOUTUBE ITSELF VOUCH FOR THIS ID? oembed answers only for a video that exists, and its
 * author_url is the one field that proves it answered — normalizeYouTube's fallback is the bare
 * platform url, so anything else came from upstream.
 *
 * This is the gate on the container call for the date (worker.ts): it costs nothing extra (oembed
 * already ran), it is a CONTENT assertion rather than a status check, and it SURVIVES the post cache
 * because it is derived from the cached Post. It is strictly stronger than the post-cache-hit gate the
 * yt mux prewarm uses, which is weak on this platform precisely because normalizeYouTube never returns
 * null — `GET /shorts/<any 11 legal chars>` produces a post-cache entry on request #1.
 */
export function youtubeVouched(post: Post): boolean {
  const p = (post as { ref?: { p?: string } } | undefined)?.ref?.p
  const url = (post as { author?: { url?: unknown } } | undefined)?.author?.url
  return p === 'yt' && typeof url === 'string' && url !== YT_FALLBACK_AUTHOR_URL
}

/**
 * Overlay a late-arriving upload instant onto an already-built Post. TOTAL and NON-DESTRUCTIVE: junk
 * returns the SAME object reference, and a post that already carries a real (non-epoch) date is never
 * overwritten — the fetch-time cache read fills most of them, and this is only the seam for the ones
 * whose container answer landed after the Post was built.
 */
export function withUploadDate(post: Post, ts: unknown): Post {
  if (!post) return post
  const cur = post.createdAt instanceof Date ? post.createdAt.getTime() : NaN
  if (Number.isFinite(cur) && cur !== 0) return post
  const d = uploadDateFrom(ts)
  return d ? { ...post, createdAt: d } : post
}

/**
 * Overlay a late-arriving AGE GATE onto an already-built Post — the sibling of withUploadDate above,
 * and it exists for the same seam for the same reason.
 *
 * WITHOUT IT THE NOTE MOSTLY NEVER FIRES, which is the whole point. `ageLimit` reaches
 * normalizeYouTube only from the WARM meta record, and on a first paste there is no warm record yet:
 * the container call is dispatched and lands after the Post is built. The date already had this
 * problem and already had this fix (youtubeMeta -> withUploadDate); the note needs the identical
 * treatment or it appears only after POST_TTL expires and the post is re-normalized — 15 minutes
 * later, which is exactly when nobody is looking at the card.
 *
 * TOTAL AND NON-DESTRUCTIVE, same contract as withUploadDate: junk returns the SAME object reference,
 * a post that already carries the note is not double-marked, and a post with its own body text keeps
 * it — the note is PREPENDED, never substituted, because the owner's requirement was to keep the card
 * and add to it.
 */
/**
 * Put a description on a Post that was built without one — the first-paste companion to
 * withUploadDate, and NOT optional for the same reason that one is not.
 *
 * The Post is built from getPost BEFORE the container's meta extract has resolved, so on a cold
 * video the body is empty at build time and the description only exists once youtubeMeta returns.
 * Without this overlay it stays invisible for the whole POST_TTL (900s) even though the worker is
 * holding it — precisely the defect withAgeNote's own history records.
 *
 * NON-DESTRUCTIVE AND TOTAL, matching withUploadDate's contract: never overwrites a body that
 * already has one (the age note gets there first and must keep the top), returns the same reference
 * when there is nothing to add, and never throws on junk.
 *
 * A BARE LIVE NOTE IS NOT A BODY, corrected 2026-08-29 in the same review that scoped the notes to
 * this platform. LIVE_NOTE is unlike the age note in one way that matters here: it is applied at
 * BUILD TIME, inside normalizeYouTube, because Innertube answers the liveness question before the
 * Post exists. So by the time this seam runs, `text` is non-empty on every broadcast and a warm
 * record's description was refused. Reachable on /_card and /_api/v1, where describeTarget falls
 * back to readCachedMeta and supplies a description even though youtubeMeta declined to run.
 *
 * THE AGE NOTE IS DELIBERATELY NOT TREATED THIS WAY. That one is a decision about what to show, not
 * an ordering accident: an age-restricted video has no description worth putting under it, which is
 * what the rule below has always said.
 */
export function withDescription(post: Post, description: unknown): Post {
  if (!post) return post
  if (typeof description !== 'string') return post
  const add = description.trim()
  if (!add) return post
  const cur = typeof post.text === 'string' ? post.text : ''
  // A body already present wins. The only writers that get in first are the two notes above.
  if (cur && cur !== LIVE_NOTE) return post
  return { ...post, text: cur ? `${cur}\n\n${add}` : add }
}

/**
 * THE NOTE FOR A VIDEO TOO LONG TO MUX, and the duration that lets the worker skip trying.
 *
 * Two jobs in one pass because they need the same fact and the same moment. The duration lands on the
 * media entry, which is what settleMux consults to avoid dispatching a mux that the container will
 * refuse; and when it is over the ceiling the card gains a line saying so.
 *
 * WITHOUT THE NOTE THIS IS A SILENT DEGRADE, which is the one failure mode this project says it will
 * not ship: "when a post can't be shown, the card says why — not a blank rectangle". A 24-minute video
 * quietly becoming a picture is that rectangle with a thumbnail in it. Reported exactly that way.
 *
 * PREPENDED, like the age note, so it survives the body cap — the cap trims the END, and a note only a
 * short post can afford is not a note.
 */
export const LENGTH_NOTE = '🎬 Too long to play here. Open it on YouTube'

/**
 * THE NOTE FOR A BROADCAST WITH NO FINISHED FILE, and the flag that stops the mux being dispatched.
 *
 * The same two jobs as the length note, for the case the length note structurally cannot cover: a
 * live or scheduled stream reports `lengthSeconds: '0'`, so there is no duration to be over the
 * ceiling and settleMux's over-ceiling arm waved every one of them through to a container that
 * refuses them on `!is_live`. Measured on yt:xDWQ3LkccY8 (Sky News, permanently live): pinned at
 * `muxing: true`, ~1.7s of container round trip per render, never cached, forever. News channels
 * post these constantly.
 *
 * PREPENDED AND IDEMPOTENT, the same contract as the age and length notes: the cap trims the END, so
 * a note only a short post can afford is not a note, and a second application must not double it.
 *
 * "STREAM" RATHER THAN "LIVE NOW", deliberately. The card is cached for POST_TTL and Discord keeps
 * the embed it got forever, so a note that asserts the present tense is wrong the moment the
 * broadcast ends. This one stays true for an ended stream too — it just stops being applied.
 */
export const LIVE_NOTE = '🔴 Live stream, so no preview here. Open it on YouTube'

/**
 * A DURATION WE WILL ACT ON: finite, positive, seconds. One predicate, because the value crosses R2
 * and a corrupt record must be ignored identically wherever it is read.
 */
function usableDuration(d: unknown): d is number {
  return typeof d === 'number' && Number.isFinite(d) && d > 0
}

/**
 * IS THIS OUR POST AT ALL — the guard the two note overlays below could do without until they grew a
 * source of truth that is not their argument.
 *
 * THE DEFECT, found in review 2026-08-29 and reproduced end to end. Both notes name YouTube in their
 * text, and both are applied at the activity seam (worker.ts's 'activity'/'oembed' callback), which
 * is NOT platform-scoped — describeTarget's `if (post.ref.p === 'yt')` has no twin there. That was
 * harmless while the only supply was `meta?.duration` / `meta?.isLive`, because youtubeMeta returns
 * null for every other platform, so both overlays were no-ops on a non-yt post by accident. Adding
 * the media fallbacks turned the accident into a bug: `Media.duration` is written by dm/st/im (the
 * yt-dlp tier), pt, tw, ig, fb and mastoapi, so
 *
 *     GET /users/anyone/statuses/{dm:x9abcde}   ->  "🎬 Too long to play here. Open it on YouTube"
 *
 * on a 4830s Dailymotion video — measured through the real dispatcher, and frozen in the message by
 * Discord forever. The live note has the same reach and is safe today only because nothing but
 * normalizeYouTube writes `Media.live`.
 *
 * GUARDED IN THE FUNCTIONS, NOT AT THE CALL SITE, because the accident is what a call-site guard
 * restores: it protects the two seams that exist and nothing about the third. These live in a
 * YouTube module and say "YouTube" in their output; refusing a post from another platform is their
 * contract, not their caller's.
 */
const isYouTube = (post: Post): boolean => post.ref?.p === 'yt'

/**
 * THE LENGTH THIS POST ALREADY KNOWS, off its own media, or undefined.
 *
 * THE READ IS DELIBERATELY BROADER THAN withMuxDuration's WRITE, and that is not a second spelling of
 * "which entries carry a duration" — it is the only question worth asking here. The stamp goes on the
 * `remux` entry, but by the time withLengthNote runs, settleMux has already replaced that entry with
 * its poster still on exactly the videos this matters for (worker.ts's stillOf, on the over-ceiling
 * arm): same item, same length, no `remux`. A reader that re-spelled the write predicate would
 * therefore find nothing in the one case it exists for.
 */
function mediaDuration(post: Post): number | undefined {
  const media = Array.isArray(post.media) ? post.media : []
  for (const m of media) if (usableDuration(m?.duration)) return m.duration
  return undefined
}

/**
 * DOES THIS POST'S OWN MEDIA SAY IT IS A BROADCAST — the live twin of mediaDuration, and it exists
 * for the identical reason, so read that one first. The overlay seams are handed `meta?.isLive`, and
 * the meta call is correctly SKIPPED on the common path (the post already carries a date), so the
 * argument is undefined exactly when the note is needed. The flag is on the entry either way:
 * normalizeYouTube stamps it, and settleMux's live arm carries it onto the still.
 */
function mediaLive(post: Post): boolean {
  const media = Array.isArray(post.media) ? post.media : []
  return media.some(m => m?.live === true)
}

/**
 * Overlay the live note onto an already-built Post — the seam for a verdict that arrives after the
 * Post was built, exactly as withAgeNote is for the age gate.
 *
 * A `false` ARGUMENT DOES NOT UN-MARK A POST, and that is not laziness about the third value. The
 * media flag is what settleMux acted on THIS render: if the entry is a still because of it, the card
 * must say why, or it is the silent blank rectangle this project promises not to ship. The fresh
 * negative does its work one step earlier — in the yt arm, where it decides what gets stamped on the
 * next fetch — and the post cache bounds how long the two can disagree.
 */
export function withLiveNote(post: Post, isLive: unknown): Post {
  if (!post) return post
  // See isYouTube: this note names YouTube and the seam that applies it is not platform-scoped.
  if (!isYouTube(post)) return post
  if (isLive !== true && !mediaLive(post)) return post
  const cur = typeof post.text === 'string' ? post.text : ''
  if (cur.includes(LIVE_NOTE)) return post
  return { ...post, text: cur ? `${LIVE_NOTE}\n\n${cur}` : LIVE_NOTE }
}

/**
 * THE DURATION, STAMPED ON THE REMUX ENTRY AND NOTHING ELSE — split out of withLengthNote so the
 * fetch path can use it without dragging the note along.
 *
 * WHY THE SPLIT EXISTS. settleMux refuses to dispatch a mux for a video past MUX_MAX_SECONDS, which
 * saves a container call that can only ever be refused — and with the alarm landed, three of them
 * across a 22-minute horizon against a pool of four slots shared by ten platforms. That arm reads
 * `m.duration`, and on YouTube it had been dead code since it was written, because normalizeYouTube
 * hardcodes `remux: { page }` and carries no duration.
 *
 * THE NOTE MUST NOT COME WITH IT. withLengthNote also prepends LENGTH_NOTE into `post.text`, and
 * withDescription refuses to write a body when one is already there ("A body already present wins").
 * Calling the note version at fetch time would therefore silently blank the description on every long
 * YouTube card — fixing a wasted container call by deleting the text the card exists to show.
 *
 * REGARDLESS OF LENGTH, deliberately: a video under the ceiling benefits from that decision being
 * cheap too, and one rule with no threshold in it is one fewer place for the threshold to drift.
 */
export function withMuxDuration(post: Post, duration: unknown): Post {
  if (!post) return post
  if (!usableDuration(duration)) return post
  const media = Array.isArray(post.media) ? post.media : []
  return { ...post, media: media.map(m => (m && m.remux ? { ...m, duration } : m)) }
}

/**
 * THE ARGUMENT IS NO LONGER THE ONLY SUPPLY, and until 2026-08-29 it was — which made the note
 * unreachable on the path most pastes take.
 *
 * Both call sites pass `meta?.duration`, and youtubeMeta returns null as soon as the post already
 * carries a real date. Since the Innertube source landed (#61-#64) that is the COMMON case: the date
 * arrives at fetch time, the meta call is correctly skipped, and the note therefore never fired at
 * all. Not a rare miss — the ordinary path.
 *
 * The duration is not missing in that state, only somewhere else: liveFetchPost's yt arm stamps it
 * onto the remux entry with withMuxDuration (`warm?.duration ?? got.duration`) before the post is
 * ever cached. So the fallback reads it back off the media — see mediaDuration for why the read is
 * not the write predicate spelled twice.
 *
 * THE ARGUMENT STILL WINS where both exist: it is the fresher of the two, and on the seam where a
 * warm record answers it is the only one that has been re-read this request.
 *
 * AND ONLY THE ARGUMENT IS STAMPED. withMuxDuration writes one number onto EVERY entry carrying a
 * `remux`, which is right for a value that arrived from outside and wrong for one read back off the
 * media: `mediaDuration` returns the FIRST usable length, so re-stamping would copy entry 0's length
 * onto its siblings and erase theirs. Inert on YouTube (normalizeYouTube emits exactly one entry) and
 * a trap the moment anything else reaches here, which is the shape of every bug on this path so far.
 */
export function withLengthNote(post: Post, duration: unknown, maxSeconds: number): Post {
  if (!post) return post
  // See isYouTube: this note names YouTube and the seam that applies it is not platform-scoped.
  if (!isYouTube(post)) return post
  const fresh = usableDuration(duration)
  const secs = fresh ? duration : mediaDuration(post)
  if (secs === undefined) return post
  // ONE SPELLING OF THE STAMP, shared with the fetch path — see withMuxDuration. Skipped when the
  // value came off the media, because then it is already where the stamp would put it.
  const base = fresh ? withMuxDuration(post, secs) : post
  if (secs <= maxSeconds) return base
  const cur = typeof base.text === 'string' ? base.text : ''
  // ONE REASON PER CARD. The live note already says there is no player and it is the more specific
  // verdict — settleMux refuses the mux on liveness, not on length — so it wins and this one stands
  // down. An unfinished broadcast reports a length of 0 and cannot reach here on its own; a 30-day
  // record written while it was live, read back beside a real duration, can. The STAMP above still
  // happens either way: it is what the next reader needs, and it renders nothing.
  if (cur.includes(LENGTH_NOTE) || cur.includes(LIVE_NOTE)) return base
  return { ...base, text: cur ? `${LENGTH_NOTE}\n\n${cur}` : LENGTH_NOTE }
}

export function withAgeNote(post: Post, ageLimit: unknown): Post {
  if (!post) return post
  if (typeof ageLimit !== 'number' || !Number.isFinite(ageLimit) || ageLimit <= 0) return post
  const cur = typeof post.text === 'string' ? post.text : ''
  if (cur.includes(AGE_NOTE)) return post
  return { ...post, text: cur ? `${AGE_NOTE}\n\n${cur}` : AGE_NOTE, sensitive: true }
}

/**
 * READ REGARDLESS OF `got.ok`, and the `got.ok &&` this replaced was a real defect (2026-07-26).
 * `uploadedAt` is a date the WORKER ALREADY HOLDS, out of its own R2 meta cache; oembed answering is a
 * separate, independent question about the title and channel. Gating one on the other threw away a
 * known-correct date whenever oembed transiently missed — and that is not a one-render loss: the post
 * built from it is UNVOUCHED (author.url falls back to the platform url), so youtubeMeta's vouch gate
 * refuses to recover the date on the activity route either, and the card renders 1 January 1970 for the
 * full POST_TTL. The two facts are independent, so they are read independently.
 */
function uploadDate(got: YouTubeFetch): Date {
  return uploadDateOrEpoch(got.uploadedAt)
}

/**
 * THE AGE-GATE NOTE, and it is an ADDITION to the card rather than a replacement for it.
 *
 * Reported 2026-07-30 on yt:G0sORVBL4kM: an age-restricted video rendered as a bare still with no
 * hint of why, so it read as our bug. The owner's call was explicit and is the right one — keep the
 * title, author, thumbnail and date, and say the video is gated. A wall card (the shape Instagram
 * uses, where the whole post is replaced) would throw away metadata we can see perfectly well.
 *
 * WHY THE VIDEO CANNOT PLAY, since it is worth writing down once. yt-dlp's age-gate bypass died in
 * 2024.10.22 (`ec2f4bf08`, "Remove broken age-restriction workaround") when YouTube made
 * TVHTML5_SIMPLY_EMBEDDED_PLAYER require sign-in for every video; `tv_embedded` was deleted outright
 * in 2026.01.31. A PARTIAL bypass survives via the `web_embedded` client, but only for videos whose
 * uploader ALLOWS EMBEDDING — verified working cookie-free on 2026-07-30. G0sORVBL4kM has embedding
 * disabled, so it is genuinely unplayable without a credential, from residential egress too. PO
 * tokens are irrelevant here: they address the separate "confirm you're not a bot" error.
 *
 * SO THE NOTE DOES NOT PROMISE A RETRY. This is not a warm-up state that fixes itself on a second
 * paste, and saying otherwise would be the kind of hopeful message that costs someone a re-test.
 *
 * 18 IS NOT HARDCODED. yt-dlp reports the uploader's actual threshold; anything above zero is a gate.
 */
const AGE_NOTE = '🔞 Age-restricted on YouTube. Sign-in required, so no preview here.'

/**
 * The description carried on the fetch, or ''. Total over junk for the same reason every other
 * reader in this file is: the value crosses R2, so a corrupted cache record must render an empty
 * body rather than throw inside a request.
 */
/**
 * The counts carried on the fetch, or {}. Total over junk for the same reason ytDesc is: the value
 * crosses R2, so a corrupt record must render a countless card rather than throw inside a request.
 * A non-positive or non-finite entry is DROPPED, not zeroed — see withCounts.
 */
export function ytCounts(got: YouTubeFetch): Post['counts'] {
  const c = (got as { counts?: Record<string, unknown> } | null)?.counts
  if (!c || typeof c !== 'object') return {}
  const out: Post['counts'] = {}
  for (const k of ['views', 'likes', 'replies'] as const) {
    const v = c[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v)
  }
  return out
}

/**
 * Put counts on a Post that was built without them — the first-paste companion to withDescription,
 * and not optional for the same reason: the Post is built before the container's extract resolves.
 *
 * NEVER OVERWRITES A COUNT THAT EXISTS and never writes a zero. A hidden like count and a video with
 * comments disabled both arrive as absent, and "0 comments" on a video where commenting is switched
 * off is a confident lie — worse than saying nothing, which is what an absent count renders as.
 */
export function withCounts(post: Post, counts: unknown): Post {
  if (!post) return post
  const c = counts as Record<string, unknown> | null | undefined
  if (!c || typeof c !== 'object') return post
  const add: Post['counts'] = {}
  for (const k of ['views', 'likes', 'replies'] as const) {
    const v = c[k]
    if (post.counts?.[k] !== undefined) continue
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) add[k] = Math.floor(v)
  }
  if (!Object.keys(add).length) return post
  return { ...post, counts: { ...post.counts, ...add } }
}

export function ytDesc(got: YouTubeFetch): string {
  const d = (got as { description?: unknown } | null)?.description
  return typeof d === 'string' ? d.trim() : ''
}

export function ytAgeRestricted(got: YouTubeFetch): boolean {
  const n = got?.ageLimit
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/**
 * ONLY AN EXPLICIT `true`. The field is three-valued on the fetch (see fetch.ts) and it crosses R2 on
 * the warm-record overlay, so anything else — false, absent, a corrupt record's string — means "not
 * known to be a broadcast", which is the answer that changes nothing.
 */
export function ytLive(got: YouTubeFetch): boolean {
  return got?.isLive === true
}

export function normalizeYouTube(got: YouTubeFetch, ref: PostRef): Post | null {
  if (ref.p !== 'yt') return null
  const id = ref.id
  /**
   * READ ONCE, USED TWICE — the media flag and the note, and they must not be able to disagree. The
   * flag is what settleMux refuses the mux on; the note is what tells the reader why the card is a
   * picture. A card carrying one without the other is either a silent degrade or a lie.
   *
   * KNOWN AT BUILD TIME ON THE FIRST PASTE, which is what makes this worth doing here rather than
   * only at the overlay seams: `isLive` comes from the Innertube call inside fetchYouTube, so it is
   * on `got` before the Post exists — no warm record needed, no container call, and the very first
   * render already refuses the mux. That is the opposite of the length note's history, which was
   * unreachable until a record existed.
   */
  const live = ytLive(got)
  const o: Any = got.ok && got.oembed && typeof got.oembed === 'object' ? (got.oembed as Any) : {}

  const title = typeof o.title === 'string' && o.title ? o.title : 'YouTube video'
  const author = typeof o.author_name === 'string' && o.author_name ? o.author_name : 'YouTube'
  // The fallback is the exported constant, not a literal: youtubeVouched compares against it, and two
  // spellings of one string is one edit away from a vouch that is always true.
  const authorUrl = typeof o.author_url === 'string' && o.author_url ? o.author_url : YT_FALLBACK_AUTHOR_URL
  /**
   * THE HANDLE COMES OUT OF author_url, NOT off author_name — reported 2026-07-29.
   *
   * `handle: author` rendered every YouTube card as "Name (@Name)": `Rick Astley (@Rick Astley)`,
   * and on a channel whose display name carries punctuation, `uwu • (@uwu •)` — which reads as a
   * broken card rather than a byline. It also shipped that string into `twitter:site` /
   * `twitter:creator`, where a handle containing a SPACE and a bullet is simply malformed.
   *
   * oEmbed already carries the real one: `author_url` is `https://www.youtube.com/@uwu-lf9yw`, so
   * the handle is the `@`-segment of its path. Measured on the reported video — author_name
   * "uwu •", author_url ".../@uwu-lf9yw".
   *
   * FALLS BACK TO THE NAME, deliberately, rather than to an empty handle: a channel can still be
   * addressed by `/channel/UC…` with no `@` form, and YT_FALLBACK_AUTHOR_URL (used when oEmbed did
   * not answer at all) has no handle either. Today's output is the floor, so this can only improve
   * a card, never blank one.
   */
  const handle = ytHandle(authorUrl) || author
  // hqdefault always exists; oembed hands it to us, and the id derives it when oembed is absent.
  const thumb = typeof o.thumbnail_url === 'string' && o.thumbnail_url
    ? o.thumbnail_url
    : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  /**
   * THE POSTER'S SIZE, carried separately from the video's — see Media.posterW for the card this
   * blanked. hqdefault is always 480x360 (verified by decoding the JPEG's own SOF header, not just
   * by trusting oEmbed, which independently reports thumbnail_width 480 / height 360), so the
   * fallback is a measurement rather than a guess. oEmbed's numbers win when it answered, since a
   * future thumbnail size would come through them first.
   */
  const posterW = typeof o.thumbnail_width === 'number' && o.thumbnail_width > 0 ? o.thumbnail_width : 480
  const posterH = typeof o.thumbnail_height === 'number' && o.thumbnail_height > 0 ? o.thumbnail_height : 360
  const canonical = `https://www.youtube.com/watch?v=${id}`

  const post: Post = {
    ref: { p: 'yt', id },
    canonical,
    author: { name: author, handle, url: authorUrl },
    title,
    /**
     * THE DESCRIPTION IS THE BODY — and until 2026-08-01 this was hardcoded to '' for every ordinary
     * video, which is why a YouTube card rendered as a title and an author and nothing else. The
     * container has been sending a description the whole time (container/server.py's _meta_page); the
     * worker's YouTubeMeta type simply had no field to put it in, so it was dropped on arrival.
     *
     * Clamped to its first paragraph upstream (worker.ts's ytDescription) rather than here, because
     * the value is stored in R2 for 30 days and the clamp belongs where the write happens.
     *
     * The age note still goes in the BODY rather than the title — the title is the video's own name
     * and overwriting it would lose the one thing the reader came for — and it now PREFIXES a
     * description instead of standing alone. withAgeNote composes the same way either way.
     */
    text: ytAgeRestricted(got) ? AGE_NOTE : ytDesc(got),
    createdAt: uploadDate(got),
    // A remux video whose source is the watch PAGE (yt-dlp resolves it in the container). w/h are 0 like
    // every other remux platform — Discord reads the muxed mp4's real dimensions, so a Short plays
    // portrait without a per-surface hint. poster = the thumbnail (mandatory on a video, and the still
    // withResolver degrades to when no container is bound). url is the watch page as a plain placeholder
    // — it is never served (the /_media route uses `remux`, and the no-container degrade uses `poster`).
    // `live` marks the entry settleMux must not dispatch — see Media.live. The remux is KEPT rather
    // than rewritten to the thumbnail here: settleMux owns the degrade shape (posterOnly, the poster
    // slot the card then names), and a second spelling of it in a normalizer is how the two drift.
    media: [{
      kind: 'video', url: canonical, w: 0, h: 0, poster: thumb, posterW, posterH,
      remux: { page: canonical }, ...(live ? { live: true as const } : {}),
    }],
    /**
     * COUNTS, from the container's extract. This was hardcoded `{}` until 2026-08-01, and unlike the
     * description that was not an oversight — there was nowhere to get them. oEmbed carries none and
     * the container's meta dict did not either, so `{}` was the whole supply. Both ends were added
     * together (container/server.py's _meta_page now passes view/like/comment through).
     *
     * `views` is populated and, today, RENDERED BY NOTHING — text.ts's METRICS draws likes, replies
     * and reposts only. That is deliberate rather than forgotten: four platforms already populate
     * `views`, so drawing it is a global change to every card, not a YouTube decision.
     */
    counts: ytCounts(got),
    // An age gate IS the platform telling us the content is adult, so the post carries the flag the
    // renderers already understand — Discord blurs, and the shared `[sensitive]` marker applies.
    sensitive: ytAgeRestricted(got),
  }
  // THROUGH withLiveNote RATHER THAN A THIRD TERNARY IN `text` ABOVE, so the prepend, the cap-safe
  // ordering and the idempotence have ONE spelling shared with the overlay seam. It is a no-op on
  // every ordinary video.
  return withLiveNote(post, live)
}
