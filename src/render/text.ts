import type { Post } from '../types.ts'
import { esc } from './fail.ts'
import { byline, str } from './embed.ts'

/**
 * THE CAP ON A POST'S BODY, applied to BOTH heads from one place.
 *
 * WHY A CAP AT ALL, since most posts do not need one. Measured across the captured fixtures: the
 * median caption is 81 characters and two thirds are under 200 — a tweet, a reel caption or a Bluesky
 * post is a line or two and was never the problem. The mess is concentrated in the LONG-FORM
 * platforms, where a "caption" is an article: Lemmy's median fixture is 3,239 characters and PieFed's
 * 1,228. Those render as a wall in a card meant to be glanced at.
 *
 * 253 IS THE OWNER'S NUMBER, not a derived one, and it is the WHOLE string including the marker — 250
 * characters of post plus three dots. Recorded as a decision rather than a calculation so nobody
 * "corrects" it to a rounder one later.
 *
 * BOTH HEADS OR NEITHER. buildContentHtml (the Mastodon spoof) and the plain-text builder below are
 * the two documents Discord reads, and this file's oldest lesson is that fixing one and not the other
 * is, from a reader's side, fixing neither. So the clamp lives here and both builders call it.
 *
 * APPLIED AFTER TRANSLATION, WHICH IS DELIBERATE AND HAS A CONSEQUENCE WORTH KNOWING. withTranslation
 * composes English first, then the marker, then the original. A translated post long enough to hit
 * this cap therefore keeps the ENGLISH — the half a reader of the card most needs — and loses the
 * original, rather than the other way round. That ordering is why the cap is safe to apply late.
 *
 * PLAIN DOTS, NOT AN ELLIPSIS CHARACTER, because that is what was asked for. Note YouTube has its own
 * earlier clamp (YT_DESC_MAX, first paragraph only, using '…') whose purpose is different: it strips
 * link dumps and timestamp lists rather than bounding length. At 300 it no longer binds — this cap is
 * tighter — so a YouTube description reaching the card is shortened by paragraph there and by length
 * here.
 */
export const DESC_MAX = 253
const ELLIPSIS = '...'

export const clampText = (s: string): string =>
  s.length <= DESC_MAX ? s : s.slice(0, DESC_MAX - ELLIPSIS.length).trimEnd() + ELLIPSIS

/**
 * The two rich-text builders for the Mastodon spoof. Both are pure: no I/O, no clock,
 * every input arrives as an argument. They are the only place the wire's separator
 * characters are spelled out, and those characters are load-bearing — they were
 * established by codepoint-dumping live FxEmbed output (wire spec §4, §6e), not guessed.
 */

// U+FE00, VARIATION SELECTOR-1. Always an escape, never a literal: the character is
// invisible, so a literal here would be indistinguishable from its own absence in a diff
// and could be silently eaten by an editor or a copy-paste — the code would still LOOK
// right while emitting the wrong bytes.
const VS1 = '\uFE00'

/**
 * Every newline inside user text becomes this: <br> plus TWO variation selectors,
 * unconditionally. The plan said to insert a hair space between *consecutive* <br> only;
 * that is wrong (spec §4). U+FE00 is invisible AND non-whitespace, which is the whole
 * trick — a blank line built this way cannot be trimmed or collapsed by Discord, and no
 * conditional is needed because a run of them is self-protecting.
 */
const TEXT_BREAK = `<br>${VS1}${VS1}`

/**
 * A gap the builder generates (before a quote, before the counts) — bare, no selector.
 * The asymmetry with TEXT_BREAK is deliberate and is exactly how a user's own blank line
 * is told apart from a separator we inserted. Collapsing the two would make that
 * distinction unrecoverable downstream.
 */
const GAP = '<br><br>'

/**
 * Rendered left to right. `views` is deliberately absent: Post.counts carries it, but the
 * verified FxEmbed block has three slots, and a fourth would diverge from the format the
 * spec pinned. The heart is U+2764 U+FE0F — the trailing VS16 is required for emoji
 * presentation (bare U+2764 renders as a monochrome text glyph) and is itself invisible,
 * so it is escaped for the same reason VS1 is.
 */
// ORDER CHANGED 2026-07-19 to likes, replies, reposts \u2014 matching fxTikTok/tnktok, verified from its
// source (generateActivity.tsx builds the block in that order) and independently corroborated by
// measured production output recorded in render.test.mjs.
//
// Ours was replies, reposts, likes, which matches FxEmbed/fxbsky instead. So there is no single
// upstream convention to inherit: the two reference implementations genuinely disagree, and this is
// a choice rather than a correction.
//
// Picked GLOBALLY rather than per-platform. This project's whole premise is one coherent embed style
// across every platform, so stat order is a property of OUR renderer, not of whichever site a post
// came from. Matching each platform to its own upstream would rebuild the exact inconsistency the
// project exists to remove \u2014 a Bluesky embed and a TikTok embed side by side in one channel with
// their stats in different orders.
//
// tnktok's order won only because it is the reference the owner was comparing against. Flipping back
// is this array alone; nothing else reads the order.
//
// Metric names are spelled in prose above rather than as emoji, deliberately: the heart carries an
// invisible VS16 and the comment is not the place to depend on it surviving a copy-paste. The array
// below is where the exact codepoints live.
const METRICS = [
  ['likes', '\u2764\uFE0F'],
  ['replies', '\u{1F4AC}'],
  ['reposts', '\u{1F501}'],
] as const

/**
 * 1000+ -> '1.1K', 1_000_000+ -> '1.1M'.
 *
 * Truncates rather than rounds, and that is the interesting choice: rounding 999_950 to
 * one decimal gives 1000.0, so it would render "1000K" for a number that is not yet a
 * million. Truncation cannot carry a value up into the next tier's range, so the tier
 * check and the formatting can never disagree.
 *
 * Deliberately hand-rolled instead of Intl.NumberFormat(…, {notation:'compact'}), which
 * FxEmbed uses: Intl's output depends on the runtime's ICU data, so Node and workerd could
 * format the same count differently — an untestable divergence in a pure function whose
 * whole job is determinism. Above 999M this keeps counting in M ('1000M'); no engagement
 * count reaches that, and inventing a 'B' tier the spec never specified would be a
 * silent deviation from the verified format.
 *
 * Determinism is not the ONLY difference from Intl, and the rest is a real divergence a
 * future reader chasing byte-fidelity needs told: Intl compact keeps ~2 significant digits
 * (12345 -> '12K', 999999 -> '1M'), this keeps one fraction digit whenever it is nonzero
 * (-> '12.3K', '999.9K'). Both of the spec's pinned examples, 1.1K and 8.1K, have a
 * single-digit integer part, where the two rules agree — so the spec cannot distinguish
 * them and this reproduces both exactly. The 10K–999K band is where they part ways.
 */
export function abbrev(n: number): string {
  if (!Number.isFinite(n)) return '0' // callers filter these out; stay total anyway
  const scale = (div: number, suffix: string) => {
    // n * 10 before the divide, not (n / div) * 10: the multiply is exact for every count
    // that fits in a double, so no float residue can turn 3.0 into 2.9999 and truncate to
    // the wrong tenth.
    const tenths = Math.floor((n * 10) / div)
    const whole = Math.floor(tenths / 10)
    const frac = tenths % 10
    return frac === 0 ? `${whole}${suffix}` : `${whole}.${frac}${suffix}`
  }
  if (n >= 1_000_000) return scale(1_000_000, 'M')
  if (n >= 1000) return scale(1000, 'K')
  return String(Math.trunc(n))
}

/**
 * Whether a quote/replyTo has an author object at all. Its head is built ENTIRELY from
 * author fields, so a missing one leaves nothing to identify — better to drop the part than
 * to draw "Quoting  (@)". cache.ts's hasValidIdentity validates a nested ref, canonical and
 * createdAt but not author, and states the guard "must be total between a corrupted cache
 * entry and served output regardless of what today's renderer happens to draw"; this
 * builder is the code that activates that path, so it owns the renderer's half of it.
 *
 * The `as unknown` is not ceremony: author is typed non-optional, so without it the check
 * reads as dead code to anyone (and to any linter) who trusts the type over the cache.
 */
function hasAuthor(p: Post): boolean {
  const a = p.author as unknown
  return !!a && typeof a === 'object'
}

/**
 * \r\n and a lone \r are newlines. A stray \r would otherwise survive into the JSON
 * `content` string as a real carriage return, for which Discord renders no break at all —
 * two lines would silently run together while the payload still looked plausible. Shared
 * with buildPlainText so og:description, which is fed from that side, cannot drift: it is
 * the same hazard reaching a different attribute.
 */
const normalizeBreaks = (text: string) => text.replace(/\r\n?/g, '\n')

/**
 * Escapes, then converts newlines. Order matters: esc() first means a '<' the user typed
 * can never be confused with the '<' of the <br> we insert.
 */
function textToHtml(text: string): string {
  return esc(normalizeBreaks(text)).replace(/\n/g, TEXT_BREAK)
}

/**
 * Spec §6e step 1. Deliberately does NOT emit the plain <br> that follows it in the spec's
 * step-by-step reading: see buildContentHtml on why every separator belongs to the part
 * that follows it.
 */
function replyPrefix(post: Post): string {
  const r = post.replyTo
  if (!r || !hasAuthor(r)) return ''
  const who = esc(byline(r.author))
  return `<sub>↩ <a href="${esc(str(r.author.url))}" class="u-url mention">${who}</a></sub>`
}

/**
 * Spec §6e step 3. Note the internal separator is ONE variation selector, not the two
 * that user text uses — verified, and the easiest detail to lose by copy-pasting
 * TEXT_BREAK in here.
 *
 * Depth is capped at 1 by the normalizer (post.quote.quote is always undefined), so this
 * does not recurse. It also must not *assume* the cap: the cache is the real input, and
 * deserializePost validates identity and dates, not depth. Not recursing makes a deeper
 * chain degrade to a dropped grandchild rather than a throw.
 */
function quoteHtml(post: Post): string {
  const q = post.quote
  if (!q || !hasAuthor(q)) return ''
  const head =
    `<b><a href="${esc(str(q.canonical))}">Quoting</a> ${esc(str(q.author.name))} ` +
    `(<a href="${esc(str(q.author.url))}">@${esc(str(q.author.handle))}</a>)</b>`
  // A textless quote gets no separator — otherwise the blockquote ends on two dangling
  // breaks, the same stray-separator bug as joining a list that has holes in it.
  const body = textToHtml(str(q.text))
  return `<blockquote>${head}${body ? `<br>${VS1}<br>${body}` : ''}</blockquote>`
}

/**
 * The metrics that survive, already rendered ('❤️ 1.1K'), in METRICS order — which as of
 * 2026-07-19 is likes, replies, reposts. That order is NOT the one the FxEmbed spec pinned;
 * it is a deliberate match to fxTikTok/tnktok, and METRICS above owns the reasoning.
 *
 * Exported because counts reach a client on TWO surfaces with DIFFERENT separators — the
 * Mastodon `content` block below (&ensp;, plus a trailing one) and the oEmbed `author_name`
 * (three literal spaces, no trailing). Only the join differs; which metrics survive, and how
 * each is spelled, must not. Splitting the rule across two modules is how one surface ends up
 * printing "❤️ 0" or a raw 1100 months after the other stopped.
 */
export function statParts(post: Post): string[] {
  const parts: string[] = []
  for (const [key, emoji] of METRICS) {
    const n = post.counts?.[key]
    // typeof + isFinite, not a truthiness check: counts survive a JSON cache round trip,
    // so this value can be null, a string, or NaN. Rendering "❤️ NaN" into a Discord embed
    // is the failure this shuts. `> 0` also covers the spec's "omit any metric that is 0";
    // a negative count is impossible upstream and would render as nonsense, so it is
    // dropped rather than shown — the one deliberate widening of the stated rule.
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) parts.push(`${emoji} ${abbrev(n)}`)
  }
  return parts
}

/**
 * DELETED 2026-07-19: statsPlain(), which rendered the counts block as PLAIN TEXT for a consumer
 * that reads an attribute VALUE, plus the EN_SPACE (U+2002) constant it joined with.
 *
 * Its only caller was discord.ts's video carve-out, which composed it into og:description for a
 * few hours (fdd8cfa) to make a video's counts draw in the same emoji artwork as a slideshow's.
 * A real Discord client then showed that a player-type embed renders NO og:description at all, so
 * the counts went back to oEmbed `author_name` — whose separator is authorName()'s three literal
 * spaces, not this one — and this helper was left with no callers. Deleted rather than kept "in
 * case": recover it from that commit if a plain-text counts surface is ever PROVEN to render, and
 * do not re-add it on spec reasoning alone.
 *
 * THE PROBLEM IT WAS FOR NO LONGER EXISTS, later the same day. The video carve-out itself was
 * removed once production fxtiktok was measured shipping og:video AND the activity link on one
 * head with the activity card still winning, so a tt video now takes the spoof path and its counts
 * ride the Mastodon `content` — the same surface, the same artwork and the same '&ensp;' join as a
 * slideshow's. There is nothing left for a plain-text counts renderer to fix.
 *
 * countsHtml below is unaffected; it emits the '&ensp;' ENTITY into HTML and never needed the
 * character.
 */

/**
 * Spec §6e step 4. Joined with '&ensp;' AND terminated with a trailing one — the trailing
 * separator is not a transcription slip, it is in the live output, and dropping it is
 * invisible locally while changing the rendered spacing in a real client.
 */
function countsHtml(post: Post): string {
  const parts = statParts(post)
  // No surviving metric means no block at all — never an empty <b></b>, which would render
  // as a stray gap on a brand-new post where every count is legitimately 0.
  return parts.length === 0 ? '' : `<b>${parts.join('&ensp;')}&ensp;</b>`
}

/**
 * The Mastodon `content` field: HTML, escaped here because nothing downstream escapes it.
 * JSON.stringify protects JSON syntax, not markup, so this function is the ONLY escaping
 * boundary on that path — and post text is attacker-controlled, since anyone can post one.
 * Every attribute stays double-quoted: esc() does not escape "'" or a backtick.
 *
 * Order: reply prefix, text, quote, counts. Every separator belongs to the part that
 * FOLLOWS it and is emitted only when something also precedes it, so an absent part leaves
 * no stray separator behind in either direction.
 *
 * That ownership rule is load-bearing, not style. The reply prefix used to carry its own
 * trailing <br> (a literal reading of §6e step 1), which is indistinguishable from correct
 * as long as text sits between it and the next part — and wrong the moment text is empty,
 * which an image-only reply or a no-commentary quote-post-as-reply both are: the prefix's
 * <br> stacked under the next part's GAP for THREE breaks where §6e specifies two, or
 * dangled at the end of the content pointing at nothing.
 */
export function buildContentHtml(post: Post): string {
  let out = replyPrefix(post)

  // The post TITLE (Reddit today; link/article/video cards later) as a BOLD leading block above the
  // body — what differentiates the headline from the selftext. esc() escapes the title's own text; the
  // <b> is ours. A bare <br> after a reply prefix (structural), matching the body's rule below.
  const title = str(post.title) ? `<b>${esc(str(post.title))}</b>` : ''
  if (title) out += (out ? '<br>' : '') + title

  // GAP (a blank line) after a title — the headline/body break the Reddit normalizer used to make by
  // concatenating title\n\nbody; a single bare <br> after a lone reply prefix (structural, no variation
  // selector, narrower than a quote/counts gap — §6e step 1); nothing at the very start.
  const text = textToHtml(clampText(str(post.text)))
  if (text) out += (title ? GAP : out ? '<br>' : '') + text

  const quote = quoteHtml(post)
  if (quote) out += (out ? GAP : '') + quote

  // Kept last and structurally independent so that, if the Task 7 live gate shows Discord
  // reading oEmbed author_name AND the activity JSON (wire spec C4 — the one genuinely
  // unresolved question), deleting these three lines is the entire fix.
  const counts = countsHtml(post)
  if (counts) out += (out ? GAP : '') + counts

  return out
}

/**
 * The VISIBLE video-gallery marker, and its composition onto `content`.
 *
 * The multi-item gallery flattening (mastodon.ts) turns each video child of a MIXED or ALL-VIDEO
 * carousel into a poster still so every item renders, instead of Discord discarding the videos
 * (mixed) or drawing one player and hiding the rest (all-video). That is a win — every item becomes
 * visible — but for one thing: a still frame says nothing about being a video, so nothing invites
 * the viewer to click through to the post for the motion. The per-attachment `description: "Video"`
 * alt text carries exactly that cue — but `description` is Mastodon ALT TEXT, which Discord does
 * not draw. This marker puts the same cue on the surface Discord DOES render: the `content` body,
 * human-verified in this project as the source of both the caption and the counts.
 *
 * FIXED PROSE, not user data and not a count. The owner chose "Contains video" over "N videos", so
 * nothing here computes or pluralizes a number no matter how many videos the gallery holds. The
 * string shares the `content` value with attacker-controlled caption text, but it is a constant
 * this file owns and never routes through esc(); the caption still takes the exact same esc() path
 * it does today (see textToHtml), so escaping is unaffected.
 *
 * CODEPOINTS AS ESCAPES, matching this file's house style for characters an editor could silently
 * corrupt (VS1, the metric emoji): \u{1F3AC} is the CLAPPER BOARD and — is an EM DASH, NOT an
 * ASCII hyphen (-). A literal em dash here is one careless save away from a hyphen and
 * indistinguishable from it in a diff, which is the whole reason the codepoint is spelled out.
 */
const VIDEO_GALLERY_MARKER = `\u{1F3AC} Contains video \u2014 tap to watch`

/**
 * APPEND VIDEO_GALLERY_MARKER as a TRAILING block on the content body — under the caption and the
 * counts, next to the engagement numbers rather than above the caption. Moved there on the owner's
 * call (2026-07-20): as a leading line it read like a headline and pushed the actual caption down;
 * beside the counts it lands where the eye already goes for post metadata and sits adjacent to the
 * media it describes, letting the caption lead. It is still the LAST block, which counts already
 * were, so a caption+counts post now ends `…counts{GAP}🎬 Contains video — tap to watch`.
 *
 * The separator is GAP, the SAME `<br><br>` the builder puts between every other block (text, quote,
 * counts), so the marker reads as its own line rather than running into the counts. Reaching for a
 * narrower or wider separator here is exactly the drift GAP is the single owner of; the marker is a
 * block, and blocks are joined with GAP.
 *
 * An empty body yields the marker ALONE, with no dangling separator — the same shape, and the same
 * reason, as contentWithMarker's `[sensitive]`-only branch: a caption-less video carousel is a real
 * post, and a leading `<br><br>` over nothing is a stray separator.
 *
 * The GATE — whether the gallery flattens videos AND actually converted one — is deliberately NOT here.
 * That is a property of the Mastodon attachment mapping, so mastodon.ts owns it and calls this only
 * once it has decided the marker applies. This function owns the SEPARATOR; that file owns the
 * CONDITION. Note buildPlainText below never calls this: the marker is a `content`-only surface, and
 * og:description (fed from that builder) must not carry it.
 */
export function withVideoGalleryMarker(body: string): string {
  return body ? `${body}${GAP}${VIDEO_GALLERY_MARKER}` : VIDEO_GALLERY_MARKER
}

/**
 * The og:description source. MUST stay counts-free (wire spec §3): counts legitimately
 * appear in two places at once — Mastodon `content` and oEmbed `author_name` — because
 * those two surfaces have disjoint consumers. og:description is NOT disjoint from
 * author_name: the OpenGraph path reads the body from og:description and the author line
 * from author_name, so a count here renders the stats twice in one embed. That pairing,
 * not content+author_name, is the real double-render trap.
 *
 * STILL TRUE AFTER 2026-07-19, and the day put two more reasons under it. Every caller's
 * og:description is counts-free (discord.ts's video carve-out composed counts in at its own call
 * site for a few hours; the tag turned out not to render on a player-type embed at all, so the
 * counts went back to author_name) — and then the carve-out itself was removed, so a tt video
 * takes the spoof head where the BODY is the Mastodon `content` and og:description is only
 * fallback insurance. This builder itself never carried counts and must not start: it is shared
 * with telegram.ts and with 'other-bot' on the plain head, neither of whom was part of any of it.
 *
 * Returns PLAIN text, deliberately un-escaped. Its consumer interpolates it into the
 * og:description attribute value and escapes at that boundary (Phase 1's renderPost does
 * esc(desc)); escaping here as well would double-escape, so a post reading `a & b` would
 * show as `a &amp; b`. The `[sensitive]` marker is applied by the renderer for the same
 * reason — one owner per concern.
 */
export function buildPlainText(post: Post): string {
  let out = ''
  const r = post.replyTo
  if (r && hasAuthor(r)) out += `↩ ${byline(r.author)}`

  // The title (plain, no bold — og:description is text) so the headline still leads the description
  // now that the normalizer keeps title and body separate. A blank line before the body mirrors the
  // content block; a bare newline after a lone reply prefix.
  if (str(post.title)) out += (out ? '\n' : '') + str(post.title)

  // Same separator-ownership rule as buildContentHtml, for the same reason: §6f's template
  // puts the \n on the reply prefix, which reads fine until text is empty and the quote's
  // own \n\n lands on top of it for a run of three.
  const text = normalizeBreaks(clampText(str(post.text)))
  if (text) out += (str(post.title) ? '\n\n' : out ? '\n' : '') + text

  const q = post.quote
  if (q && hasAuthor(q)) {
    if (out) out += '\n\n'
    out += `Quoting ${byline(q.author)}`
    const quoted = normalizeBreaks(str(q.text))
    if (quoted) out += `\n\n${quoted}`
  }
  return out
}
