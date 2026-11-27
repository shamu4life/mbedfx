import type { Media, Post } from '../types.ts'
import { siteLabel } from '../instance.ts'
import { mediaList } from '../media.ts'
import { awaitsTranslation } from '../translate.ts'
import { byline, bytesIndex, isSensitive, isSpoiler, knownDate, mediaOf, mediaUrl, str, themeColor, usable } from './embed.ts'
import { clampText, hasAuthor, normalizeBreaks, statParts } from './text.ts'

/**
 * THE GALLERY CARD: a Discord component embed for a post with MORE THAN FOUR PICTURES AND NO VIDEO,
 * built to look like the activity card every other post gets. discord.ts's renderSpoof is the only
 * caller, and it adds this to a head that is otherwise byte for byte today's, activity link included.
 *
 * WHAT WAS MEASURED, 2026-11-26, by the owner in the Discord mobile app, through the one-day `/_wait/e`
 * test route (PR #156, removed once it had answered). Two posts, /X/status/2102147636702634195 (a video)
 * and /profile/bsky.app/post/3myx7vphq3s2j (four pictures), each pasted three ways:
 *
 *   v=0  today's head                         -> today's activity card: author row, text, counts, the
 *                                                video with its poster frame / a 2x2 grid, and the
 *                                                footer "mbedfx | {date}".
 *   v=1  today's head + a component embed     -> the COMPONENT card, in both posts.
 *   v=2  the component embed, no activity link -> the component card again.
 *
 * Analytics Engine had `wait_api` rows coded 700 (x, three fetches, 23:13Z) and NO 701 row at all: with
 * a component embed in the head, Discord did not fetch the activity document. So when a head carries
 * both, the component embed REPLACES the activity card. The Bluesky v=0 document fetch also left no 700
 * row although that card came from the document; that is recorded and was not chased.
 *
 * The component card the test built had a Section with the author's avatar as its Thumbnail (both
 * authors' avatars are their platform's logo, so it read as a large logo at the top right), a "View on
 * ..." link button, no footer, and for the video a blank white tile with a play button where the
 * poster frame belongs, although the video did play when tapped. The four pictures drew as a grid from
 * EXTENSIONLESS /_media/ urls, which settles the question the test's own notes left open: a gallery item
 * does not need `.jpg` on its url.
 *
 * THE OWNER'S DECISION, after seeing the six cards: only the v=0 look is acceptable, but 3x3 galleries
 * are wanted if they can be had. So this card is used ONLY where the activity card cannot show what
 * the post has, a post with more than four pictures and no video, and it is built to look like today's
 * card, not like the test's:
 *
 *   - the author line as text, `**Name** (@handle)`, with no Section, no Thumbnail and no logo;
 *   - the body in buildContentHtml's order (the reply line, the title in bold, the text, the quote as
 *     a blockquote), then the counts in bold with the activity card's en-space join;
 *   - a Media Gallery of the first nine pictures, which Discord lays out as a 3x3 grid at nine;
 *   - a footer line, `-# {SITE_NAME} | {date} {time}`, the activity card's own footer spelled in
 *     Discord markdown, or just the name for an undated post as that card prints it;
 *   - the Container's accent colour from themeColor, the head's own theme-color;
 *   - NO BUTTON. Buttons are optional: the docs' first example ("Option 1: Inline Script") is a
 *     Container holding a single Text Display and nothing else.
 *
 * WHY THE THRESHOLD IS FIVE. Two readings of the activity card disagree, and the threshold is the
 * owner's call between them rather than either measurement. mastodon.ts records an Instagram carousel
 * of ten attachments drawing six on 2026-07-20 (client not recorded). The 2026-11-26 reading is that
 * the activity card shows four. At four or fewer the two cards hold the same pictures, so nothing is
 * gained by replacing the card the owner approved.
 *
 * WHY NO VIDEO, AND NO GIF, AND NO SPOILER. A video costs the poster frame and draws a blank tile
 * (measured above). A degraded still (Media.posterOnly, pendingMux) is a video whose mux has not
 * finished, and Discord keeps a message's first embed forever, so it counts as a video here. A gif in a
 * Media Gallery has not been pasted, and neither has a spoilered gallery item; a spoiler post's head
 * deliberately names no media (discord.ts), and this card would. All three keep today's head.
 *
 * NOR A VIDEO IN THE QUOTED POST (review, 2026-11-26). The activity card hoists a quote's video in
 * behind the post's own pictures and flattens it to a still, and on /p it then adds the "🎬 Contains
 * video" line under the counts (mastodon.ts contentWithMarker). This card shows none of the quote's
 * media, so it would drop that line, and the reader would never learn the post leads to a video. A
 * Threads or Misskey carousel of six quoting a video, shared as /p, was the case found in review. It
 * also made /p and /v the same card, though they are meant to differ.
 *
 * NOR WHILE THE TRANSLATION IS STILL COMING (review, 2026-11-26). When the head's translation loses its
 * race (worker.ts withTranslated, `pending`), today's card still gets a second try: the activity document
 * Discord fetches a moment later asks again, often finding the answer the head's own request has written
 * to R2 meanwhile, and draws it with the 🌐 marker. This card replaces that document, and Discord never
 * fetches it, so a gallery built from a lost race would show the untranslated caption for good.
 * Reproduced in review, before this rule existed: a six-picture post with a Japanese caption arriving at
 * 4600 ms and a model answering at 800 ms. The head came back with the untranslated text in its gallery
 * card, while /api/v1/statuses/{id} fetched right after carried the translation. So a head whose post is
 * still arriving keeps today's card; it is the same head that worker.ts already refuses to
 * response-cache. A translation that did land in time is in post.text, and this card carries it like the
 * activity card does.
 *
 * WHY OWN MEDIA ONLY. A quoted post's pictures are hoisted into the activity gallery behind the post's
 * own (mediaList, §7). Here the count and the gallery are the post's own, the rule the test builder
 * used and the list /_card's preview draws from. The cost: a post with five or more pictures of its own
 * loses the quote's pictures that today's card would show. The quote's author and text still render.
 * A quote's video is the exception: it keeps today's card, as above.
 *
 * MEASURED after the deploy on 2026-11-26 (owner's paste, Discord's phone AND desktop apps): a
 * 10-picture Threads post and a 10-picture Reddit gallery, both public, drew this card as intended. Nine pictures in a 3x3 grid, all
 * loaded inside Discord's 10-second budget for "the whole fetch, including every image in the
 * payload"; the `-#` footer as small text; `<t:…>` as a real date; no thumbnail and no button.
 * NOT MEASURED YET: a gallery of five to eight, whose mosaic Discord lays out itself.
 *
 * THE SCHEMA, read 2026-11-26 from Discord's own docs source at commit 2d337dbb16 ("Document link
 * previews", discord/discord-api-docs#8606, merged 2026-10-06; the changelog entry is dated
 * 2026-10-05). The pages say "Link previews are subject to change", so these are the rules as of
 * that commit, from component-embeds.mdx and the component reference.mdx in these two folders
 * (named by folder because the repo's citation check reads a path ending in `.md` as one of ours):
 *
 *   https://github.com/discord/discord-api-docs/tree/2d337dbb16/developers/link-previews
 *   https://github.com/discord/discord-api-docs/tree/2d337dbb16/developers/components
 *
 *   - `<script id="discord:component-embed" type="application/json">` inside `<head>`, in the
 *     server-rendered markup. "For both options, there is a 3,000-byte limit. Escape sequences like
 *     [the six-character JSON escape of `<`] also count toward it at their full length."
 *   - "a JSON object with a single, parent Container component": `{ "component": { "type": 17, … } }`.
 *     "A Container cannot contain another Container component."
 *   - "up to 40 components, including the parent Container", from types 1 Action Row, 2 Button,
 *     9 Section, 10 Text Display, 11 Thumbnail, 12 Media Gallery, 14 Separator, 17 Container.
 *   - Button: "must use the link style (`style` of `5`) and may contain `id`, `type`, `url`, `style`,
 *     `label`, `emoji`, and `disabled` … Any other key invalidates the entire payload." This card
 *     sends none.
 *   - "Media Gallery items are capped at 10 across the entire embed, not per component." A gallery
 *     holds 1 to 10 items; an item is `{ media: { url }, description?, spoiler? }`, description max
 *     1024 characters.
 *   - Media urls "must use `http` or `https` and be a max of 2,048 characters".
 *   - Open Graph tags stay in the page "so a standard preview is available when a component embed
 *     can't be shown". This builder only adds; the head keeps every tag it had.
 *
 * test/component-embed.test.mjs encodes each rule above as a validator and runs every payload this
 * file can produce through it, including a worst case built to overflow the budget.
 */
export const COMPONENT_EMBED_MAX_BYTES = 3000

/** More than four pictures: the fewest this card is drawn for. */
export const GALLERY_CARD_MIN = 5
/** The most it shows. Nine is the 3x3 grid; a post with more shows its first nine. */
export const GALLERY_CARD_MAX = 9

/** The schema's per-field ceilings, from the pages quoted above. */
const ALT_MAX = 1024
const MEDIA_URL_MAX = 2048

type Item = { media: { url: string }; description?: string }

/**
 * DOES THIS POST GET THE GALLERY CARD? More than four usable pictures of its own, every usable entry a
 * plain picture, no video in the quoted post either, no spoiler, and nothing still arriving. The head
 * (discord.ts) and the converter preview (/_card) both ask, through galleryCardJson, so the page cannot
 * draw a gallery the card does not carry.
 *
 * usable() first, as everywhere: a dead entry (`null`, no url) neither counts toward five nor turns a
 * gallery into a video post. `kind === 'image'` and the two flags rule out every shape the docstring
 * lists: a video, a gif, and a video's still standing in until its mux lands.
 *
 * THE QUOTE IS ASKED OVER mediaList, the list the activity card hoists from, and only about video: the
 * quote's pictures and gifs are dropped here at a cost the docstring accepts, but its video is the one
 * thing the activity card marks in words.
 *
 * `pending` IS WHAT THE CALLER KNOWS ABOUT THE REST OF THE HEAD, and it has three values because the
 * caller can be in three states:
 *   - true: something on this head is still arriving, a translation that lost its race above all
 *     (worker.ts renderPostRoute passes the same flags that keep the head out of the response cache).
 *     The activity document would get a second try at it, so no gallery card.
 *   - false: the caller ran the translation step and has its final answer: the translation is in
 *     post.text, or the caption is English, or the model declined, or translation is off. The activity
 *     document would come to the same answer, so the card may be drawn.
 *   - left out: the caller never asked, which is the TikTok short-link arm and every test calling this
 *     with three arguments. Then a caption awaitsTranslation says yes to keeps today's card. Defaulting to
 *     "drawn" instead would freeze an untranslated caption on that arm, because its head never
 *     translates and the activity document behind it does.
 */
export function takesGalleryCard(post: Post, pending?: boolean): boolean {
  if (isSpoiler(post)) return false
  const own = mediaOf(post).filter(usable)
  if (own.length < GALLERY_CARD_MIN || !own.every(isPlainPicture)) return false
  if (mediaList(post).some(m => usable(m) && isVideo(m))) return false
  if (pending === true) return false
  return pending === false || !awaitsTranslation(post)
}
const isPlainPicture = (m: Media): boolean => m.kind === 'image' && !m.posterOnly && !m.pendingMux
/** A video, or the still of one whose mux has not landed: what the activity card would mark as video. */
const isVideo = (m: Media): boolean => m.kind === 'video' || !!m.posterOnly || !!m.pendingMux

/**
 * The gallery card's JSON, ready to sit between the script tags, or null: for every post that does not
 * take it, and for one that does when no valid card fits in 3,000 bytes. Null means today's head, with
 * nothing added, so a post this card cannot carry keeps the card the owner approved. `pending` is
 * takesGalleryCard's.
 */
export function galleryCardJson(post: Post, origin: string, site: string, pending?: boolean): string | null {
  if (!takesGalleryCard(post, pending)) return null
  const items = galleryOf(post, origin)
  // A url past the schema's 2,048 characters is left out by galleryOf; below five there is no gallery
  // worth replacing the activity card for.
  if (items.length < GALLERY_CARD_MIN) return null
  const author = authorLine(post)
  const parts = bodyParts(post)
  const counts = statParts(post)
  const footer = footerLine(post, site)
  const accent = accentOf(post)

  const build = (limit: number, withAlt: boolean): string => {
    const components: object[] = []
    if (author) components.push({ type: 10, content: author })
    // The counts close the body block as they close the activity card's `content`, a blank line below
    // the text. Joined with U+2002, the `&ensp;` countsHtml joins with, and with no trailing one: the
    // bold could fail to close on trailing whitespace, and the activity card's trailing space draws as
    // nothing anyway.
    const body = [sensitiveMarked(post, renderBody(parts, limit)), counts.length ? `**${counts.join(' ')}**` : '']
      .filter(Boolean).join('\n\n')
    if (body) components.push({ type: 10, content: body })
    components.push({ type: 12, items: withAlt ? items : items.map(({ media }) => ({ media })) })
    components.push({ type: 10, content: footer })
    return scriptSafeJson({ component: { type: 17, ...(accent === null ? {} : { accent_color: accent }), components } })
  }
  const fits = (s: string) => utf8Bytes(s) <= COMPONENT_EMBED_MAX_BYTES

  // THE TRIM LADDER. The pictures are the point, so they are never trimmed: a card that fits only by
  // dropping some would show fewer than the post has, and today's card is the better answer then.
  // Alt text goes first, because nine 1024-character descriptions are three times the budget on their
  // own and the pictures still show without them. Then the body, cut at a grapheme boundary with the
  // "..." the other heads use, as late as still fits.
  let out = build(Infinity, true)
  if (fits(out)) return out
  out = build(Infinity, false)
  if (fits(out)) return out
  // The largest raw-character budget that fits, by bisection. Escaping happens after the cut, so a cut
  // can never land inside an escape sequence.
  let lo = -1
  let hi = parts.reduce((n, p) => n + p.raw.length, 0)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(build(mid, false))) lo = mid
    else hi = mid - 1
  }
  return lo >= 0 ? build(lo, false) : null
}

/** The script element for the head, or '' when the post keeps today's head unchanged. */
export function galleryCardScript(post: Post, origin: string, site: string, pending?: boolean): string {
  const json = galleryCardJson(post, origin, site, pending)
  return json ? `<script id="discord:component-embed" type="application/json">${json}</script>` : ''
}

/**
 * The post's first nine usable pictures, as the urls media_attachments already publishes for them:
 * bytesIndex on the source index, extensionless. The extensionless spelling is measured, not assumed:
 * the 2026-11-26 paste drew Bluesky's four pictures from exactly these urls inside a component embed.
 */
function galleryOf(post: Post, origin: string): Item[] {
  const out: Item[] = []
  mediaOf(post).forEach((m, i) => {
    if (out.length >= GALLERY_CARD_MAX || !usable(m)) return
    const url = mediaUrl(origin, post, bytesIndex(m, i))
    if (url.length > MEDIA_URL_MAX) return
    const alt = cut(str(m.alt).trim(), ALT_MAX, '')
    out.push({ media: { url }, ...(alt ? { description: alt } : {}) })
  })
  return out
}

/**
 * `**Name** (@handle)`: byline()'s spelling with the name in bold, built from the same two fields so an
 * empty handle prints no `(@)` here either. The activity card's author row draws the avatar beside it;
 * this one draws none, because the only way to put a picture there is a Section Thumbnail, and that is
 * the large top-right image the owner turned down.
 */
function authorLine(post: Post): string {
  const name = str(post.author?.name).trim()
  const handle = str(post.author?.handle).trim()
  if (!name) return handle ? `**@${md(handle)}**` : ''
  return handle ? `**${md(name)}** (@${md(handle)})` : `**${md(name)}**`
}

/**
 * The body, as parts, in buildContentHtml's order and with its separators: the reply line, the title,
 * the text, then the quote's head and the quote's text. Each part is kept RAW until renderBody cuts and
 * formats it, so the trim ladder can measure and cut plain text and escape afterwards.
 *
 * The reply line is `-#` subtext, the markdown for the `<sub>` the activity card puts it in. The quote
 * is a blockquote, as the activity card draws it: the bold head, an empty quoted line for the break
 * buildContentHtml puts there, then each line of the quote. md() runs first, so a quoted line that opens
 * with `>` stays text inside the quote.
 */
type Part = { sep: string; raw: string; fmt: (s: string) => string }
function bodyParts(post: Post): Part[] {
  const parts: Part[] = []
  const r = post.replyTo
  if (r && hasAuthor(r)) parts.push({ sep: '', raw: `↩ ${byline(r.author)}`, fmt: s => `-# ${md(s)}` })
  const title = str(post.title)
  if (title) parts.push({ sep: '\n', raw: title, fmt: s => `**${md(s)}**` })
  const text = normalizeBreaks(clampText(str(post.text)))
  if (text) parts.push({ sep: title ? '\n\n' : '\n', raw: text, fmt: md })
  const q = post.quote
  if (q && hasAuthor(q)) {
    parts.push({ sep: '\n\n', raw: `Quoting ${byline(q.author)}`, fmt: s => `> **${md(s)}**` })
    const quoted = normalizeBreaks(str(q.text))
    if (quoted) parts.push({ sep: '\n> \n', raw: quoted, fmt: s => md(s).split('\n').map(l => `> ${l}`).join('\n') })
  }
  return parts
}

/**
 * The parts, joined, keeping at most `limit` raw characters: the part that crosses the limit is cut with
 * "..." and nothing after it is kept. A separator belongs to the part after it and is dropped when that
 * part comes first, the ownership rule buildContentHtml states.
 */
function renderBody(parts: Part[], limit: number): string {
  let out = ''
  let room = limit
  for (const p of parts) {
    if (room <= 0) break
    const kept = p.raw.length <= room ? p.raw : cut(p.raw, room)
    if (!kept) break
    out += (out ? p.sep : '') + p.fmt(kept)
    if (kept !== p.raw) break
    room -= p.raw.length
  }
  return out
}

/**
 * describe()'s `[sensitive] ` label, outside the trim budget so no cut can lose it. On its own line when
 * the body opens with the `-#` reply line, which only reads as subtext at the start of a line.
 */
function sensitiveMarked(post: Post, body: string): string {
  if (!isSensitive(post)) return body
  const label = md('[sensitive]')
  if (!body) return label
  return body.startsWith('-# ') ? `${label}\n${body}` : `${label} ${body}`
}

/**
 * THE FOOTER. The activity card's reads "mbedfx | 06/12/2026 2:54 PM" on the client the converter page
 * was compared against (public/index.html footLine), and "mbedfx" alone for an undated post
 * (toMastodonStatus, 2026-11-25). Discord prints that date in the READER's time zone and locale, which a
 * string built here cannot do, so the date is two Discord timestamps: style `d` (short date) and `t`
 * (short time), joined with a space where style `s` would put a comma. Built raw, because md() escapes
 * the `<` they open with.
 */
function footerLine(post: Post, site: string): string {
  const name = md(siteLabel(site))
  const d = knownDate(post)
  const s = d ? Math.floor(d.getTime() / 1000) : 0
  return s > 0 ? `-# ${name} | <t:${s}:d> <t:${s}:t>` : `-# ${name}`
}

/** themeColor's `#rrggbb` as the integer accent_color takes, or null to leave the key out. */
function accentOf(post: Post): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(themeColor(post))
  return m ? parseInt(m[1], 16) : null
}

/**
 * JSON that is safe between `<script>` tags. Post text is anyone's to write, and a caption reading
 * `</script><script>…` would otherwise end the element and run as markup. `<`, `>` and `&`, and
 * the two line terminators U+2028 and U+2029, each become a six-character JSON escape (a backslash,
 * `u`, four hex digits), which every JSON parser reads back as the same character. The byte budget
 * is measured on THIS string, escapes included, because the docs count them "at their full length".
 * The class is built from code points so this source file never holds a raw line terminator, which
 * would end a regex literal.
 */
const SCRIPT_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g')
export function scriptSafeJson(v: unknown): string {
  return JSON.stringify(v).replace(SCRIPT_UNSAFE, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length

/**
 * DISCORD MARKDOWN, ESCAPED, so a caption reads as the author typed it. Text Display content is
 * rendered as markdown, and post text is plain: `*` `_` `~` `` ` `` `|` would turn into emphasis,
 * strikethrough, code or spoiler bars, `[` `]` into a masked link, `<` into a mention or timestamp,
 * and a line opening with `#`, `-#`, `>`, a list bullet or `1.` into a heading, subtext, quote or
 * list. URLs are copied as they are: a backslash inside one would end up in the link.
 */
const URL_RUN = /https?:\/\/[^\s<>]+/g
export function md(s: string): string {
  let out = ''
  let last = 0
  for (const m of s.matchAll(URL_RUN)) {
    out += escInline(s.slice(last, m.index)) + m[0]
    last = (m.index ?? 0) + m[0].length
  }
  out += escInline(s.slice(last))
  return out
    .replace(/^([ \t]*)(#{1,3}|-#|>{1,3}|[-+])(?=[ \t])/gm, '$1\\$2')
    .replace(/^([ \t]*)(\d+)\.(?=[ \t])/gm, '$1$2\\.')
}
const escInline = (s: string) => s.replace(/[\\*_~`|[\]<]/g, '\\$&')

/** `s` cut to at most `limit` UTF-16 units at a grapheme boundary, with `tail` added when it was cut. */
const GRAPHEMES = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null
function cut(s: string, limit: number, tail = '...'): string {
  if (s.length <= limit) return s
  const room = Math.max(0, limit - tail.length)
  let end = 0
  if (GRAPHEMES) {
    for (const { index, segment } of GRAPHEMES.segment(s)) {
      if (index + segment.length > room) break
      end = index + segment.length
    }
  } else {
    end = room
    const c = s.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) end -= 1
  }
  const kept = s.slice(0, end).trimEnd()
  return kept ? kept + tail : ''
}
