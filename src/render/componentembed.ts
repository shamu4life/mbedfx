import type { Post } from '../types.ts'
import { displayName } from './chooser.ts'
import { bytesIndex, describe, isSpoiler, mediaOf, mediaUrl, str, themeColor, usable } from './embed.ts'
import { buildPlainText, statParts } from './text.ts'

/**
 * A DISCORD COMPONENT EMBED FOR ONE POST, for the `/_wait/e` paste experiment (src/worker.ts). Built
 * for that experiment and nothing else today: no production head carries one. If the paste says
 * Discord draws it, this is the renderer a production head would call, which is why it is a pure
 * module beside the other heads and not a block inside the route.
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
 *     `label`, `emoji`, and `disabled`, with a `label`, an `emoji`, or both. Any other key invalidates
 *     the entire payload." Label max 80 characters, url max 512 (reference.mdx).
 *   - "Media Gallery items are capped at 10 across the entire embed, not per component. Thumbnails
 *     don't count toward this limit." A gallery holds 1 to 10 items; an item is `{ media: { url },
 *     description?, spoiler? }`, description max 1024 characters.
 *   - Section: one to three Text Displays plus a REQUIRED `accessory`, a Button or a Thumbnail.
 *     Thumbnails "only support images".
 *   - Media urls "must use `http` or `https` and be a max of 2,048 characters". "A video in a Media
 *     Gallery shows a preview frame with play controls but does not autoplay."
 *   - Open Graph tags stay in the page "so a standard preview is available when a component embed
 *     can't be shown". This builder only adds; the head keeps every tag it had.
 *
 * test/component-embed.test.mjs encodes each rule above as a validator and runs every payload this
 * file can produce through it, including a worst case built to overflow the budget.
 *
 * THE LAYOUT. Author row (a Section with the avatar as its Thumbnail, or a bare Text Display when
 * there is no avatar, because a Section without an accessory is invalid), the post text, the counts,
 * a Media Gallery of the post's own media, and one link button to the original post. The button is
 * also the paste's tell: neither the activity card nor the Open Graph card ever draws one, so a
 * button on the card means Discord drew this payload.
 *
 * Returns the JSON text ready to sit between the script tags, or null when no valid payload fits.
 * The route answers null with a 422 rather than a head without the script, which would be a second
 * control posing as the variant.
 */
export const COMPONENT_EMBED_MAX_BYTES = 3000

/** The schema's per-field ceilings, from the pages quoted above. */
const GALLERY_MAX = 10
const ALT_MAX = 1024
const LABEL_MAX = 80
const BUTTON_URL_MAX = 512
const MEDIA_URL_MAX = 2048

type Item = { media: { url: string }; description?: string; spoiler?: true }

export function componentEmbedJson(post: Post, origin: string): string | null {
  const button = buttonOf(post)
  if (!button) return null
  const author = authorLine(post)
  const avatar = str(post.author?.avatar) ? mediaUrl(origin, post, 'avatar') : ''
  const body = describe(post, buildPlainText(post)).trim()
  const counts = statParts(post).join('   ')
  const items = galleryOf(post, origin)
  const accent = accentOf(post)

  const build = (text: string, withAlt: boolean, n: number): string => {
    const components: object[] = []
    if (author) {
      const line = { type: 10, content: author }
      // A Section must have an accessory, so the avatar decides between the two shapes.
      components.push(avatar && avatar.length <= MEDIA_URL_MAX
        ? { type: 9, components: [line], accessory: { type: 11, media: { url: avatar } } }
        : line)
    }
    if (text) components.push({ type: 10, content: text })
    if (counts) components.push({ type: 10, content: `**${counts}**` })
    const shown = items.slice(0, n).map(it => (withAlt ? it : { ...it, description: undefined }))
    // An empty gallery is invalid, so no media means no gallery component at all.
    if (shown.length) components.push({ type: 12, items: shown })
    components.push({ type: 1, components: [button] })
    return scriptSafeJson({ component: { type: 17, ...(accent === null ? {} : { accent_color: accent }), components } })
  }
  const fits = (s: string) => utf8Bytes(s) <= COMPONENT_EMBED_MAX_BYTES

  // THE TRIM LADDER, in the order that keeps the most of what the paste is about. The media is the
  // question, so it goes last. Alt text goes first: four 1024-character descriptions are already over
  // the budget on their own, and the picture still shows without them. Then the text, cut at a
  // grapheme boundary with the same "..." the other heads use. Then gallery items, from the end.
  const all = items.length
  const fullText = md(body)
  let out = build(fullText, true, all)
  if (fits(out)) return out
  out = build(fullText, false, all)
  if (fits(out)) return out
  // Largest cut of the RAW text that fits, found by bisection. Escaping happens after the cut, so a
  // cut can never land inside an escape sequence.
  let lo = 0
  let hi = body.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(build(md(cut(body, mid)), false, all))) lo = mid
    else hi = mid - 1
  }
  if (lo > 0) return build(md(cut(body, lo)), false, all)
  for (let n = all; n >= 1; n--) {
    out = build('', false, n)
    if (fits(out)) return out
  }
  return null
}

/**
 * The post's OWN media, as the urls mbedfx already publishes for them, at most ten. Quote media is
 * left out: the quote's text still renders, and the activity document drops it too when the post's
 * own media leads with a video (mastodon.ts attachments()).
 *
 * A VIDEO TAKES THE `.mp4` SPELLING, the url the spoof head already publishes as og:video for the
 * same entry. The docs list the formats as ".mp4, .webm, and .mov", and if Discord checks that
 * against the url rather than the bytes, the activity document's bare `/0` would lose the video and
 * the paste would read as "component embeds can't play video". Both spellings are one resource
 * (router.ts, the `.mp4` tolerance), and both 302 to the same twimg file (measured 2026-11-26 on
 * /_media/x%3A2102147636702634195/0 and /0.mp4).
 *
 * AN IMAGE KEEPS THE EXTENSIONLESS URL. The router would accept `.jpg`, but the format is the CDN's
 * choice per request: cdn.bsky.app answered image/webp for a feed_fullsize/plain url asked with no
 * Accept header (2026-11-26). Any extension would be a guess about bytes this Worker never sees.
 * If Bluesky's gallery is missing from a component card while X's video shows, suspect this first.
 * A GIF takes `.gif`, as its media_attachment does.
 */
function galleryOf(post: Post, origin: string): Item[] {
  const spoiler = isSpoiler(post)
  const out: Item[] = []
  mediaOf(post).forEach((m, i) => {
    if (out.length >= GALLERY_MAX || !usable(m)) return
    const url = m.kind === 'video'
      ? `${mediaUrl(origin, post, i)}.mp4`
      : `${mediaUrl(origin, post, bytesIndex(m, i))}${m.kind === 'gif' ? '.gif' : ''}`
    if (url.length > MEDIA_URL_MAX) return
    const alt = cut(str(m.alt).trim(), ALT_MAX, '')
    out.push({ media: { url }, ...(alt ? { description: alt } : {}), ...(spoiler ? { spoiler: true as const } : {}) })
  })
  return out
}

/**
 * `**Name** (@handle)`: byline()'s spelling with the name in bold, built from the same two fields so
 * an empty handle prints no `(@)` here either.
 */
function authorLine(post: Post): string {
  const name = str(post.author?.name).trim()
  const handle = str(post.author?.handle).trim()
  if (!name) return handle ? `**@${md(handle)}**` : ''
  return handle ? `**${md(name)}** (@${md(handle)})` : `**${md(name)}**`
}

/** The one link button: style 5, a label, the post's own url, and no other key. */
function buttonOf(post: Post): { type: 2; style: 5; label: string; url: string } | null {
  const url = str(post.canonical)
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    return null
  }
  if ((protocol !== 'https:' && protocol !== 'http:') || url.length > BUTTON_URL_MAX) return null
  const label = cut(`View on ${displayName(post.ref.p)}`, LABEL_MAX, '')
  return { type: 2, style: 5, label, url }
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
