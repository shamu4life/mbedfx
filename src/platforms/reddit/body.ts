/**
 * Pure: a Reddit post body, as Reddit renders it, to the plain text a card carries. No I/O.
 *
 * TWO INPUTS, ONE SHAPE OF OUTPUT. redditHtmlToText reads rendered HTML: the `t3_{id}-post-rtjson-content`
 * div on embed.reddit.com, and the `<div class="md">` of Reddit's Atom feed, which use the same block
 * vocabulary (p, br, lists, blockquote, pre, table, headings) with different spoiler markup.
 * redditMarkdownToText reads the raw markdown an archive stores. Both produce paragraphs separated by
 * one blank line and list items on their own lines, so a body reads the same whichever source supplied it.
 *
 * WHAT THE OLD EXTRACTION DID, measured on real pages (embed.reddit.com from a residential IP and from a
 * Cloudflare Worker, 2026-10-11): it turned `</p><p>` into a blank line and stripped every other tag, so
 * Reddit's template whitespace survived as four newlines plus indentation per paragraph (production
 * /_api/v1 showed `\n    \n\n\n      ` inside a body), a `<br>` vanished and glued two sentences
 * together, list items ran into one line, and a spoiler's text was shown in the clear.
 *
 * LINEAR, AND BOUNDED, BECAUSE THE INPUT IS A STRANGER'S. A first version trimmed trailing spaces with
 * `buf.replace(/[ \t]+$/, '')` over the whole growing buffer at every block, which V8 backtracks through
 * quadratically: a 7.6K-character body with a long space run inside a code block took 29.7 s of CPU in
 * workerd (adversarial review, 2026-10-11), where the extraction it replaced took 2 ms. Every trim here is
 * now a loop over the tail, and each converter stops once it has more text than anything downstream keeps.
 */

/**
 * HOW FAR EITHER CONVERTER READS: the HTML one stops once its output passes this many characters (before
 * tidying, which only shrinks it), the markdown one converts only this many characters of input. Above the
 * normalizer's 4000-character storage bound, so a body that long is still seen as cut there and marked, and
 * far above the card's 500. Work past it is discarded.
 */
export const BODY_CONVERT_MAX = 6000

/**
 * THE NAMED ENTITIES REDDIT'S PAGES AND FEEDS USE, plus the punctuation ones a body can carry. Numeric
 * forms are decoded generically. `&amp;` is handled by the same single pass, so `&amp;lt;` becomes the
 * literal `&lt;` and is not decoded twice.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', laquo: '«',
  raquo: '»', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  euro: '€', pound: '£', cent: '¢', yen: '¥', sect: '§', para: '¶', shy: '',
  zwj: '\u200d', zwnj: '\u200c',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      try { return String.fromCodePoint(n) } catch { return whole }
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body] : whole
  })
}

/**
 * Characters a body must not carry into a card: zero-width spaces (Reddit's `&#x200B;` paragraph filler),
 * the BOM, and the C0 controls other than newline and tab. ZWJ is kept; it is part of emoji sequences.
 */
const INVISIBLE = /[\u200b\ufeff\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** `s` without INVISIBLE's characters: what the converters drop, for a source caption.ts compares with them. */
export const stripInvisible = (s: string): string => s.replace(INVISIBLE, '')

/**
 * A SPOILER IS REPLACED, NEVER SHOWN, wherever the source marks it. Reddit hides `>!text!<` behind a click;
 * a card has no click, so the honest rendering is a marker that says something is hidden. rtjson spells it
 * `<shreddit-spoiler>` (measured on r/anime/comments/1x2om7u, 2026-10-11), the feed's old renderer `<span
 * class="md-spoiler-text">`, and markdown `>!…!<`. caption.ts says what happens on the one source that does
 * not mark spoilers at all.
 */
export const SPOILER_MARK = '[spoiler]'

/** Elements whose content is not body text: inline media (alt text is "r/Sub - Title"), widgets, scripts. */
const SKIP = new Set(['figure', 'script', 'style', 'svg', 'button', 'template', 'noscript', 'iframe', 'video', 'audio', 'object', 'faceplate-tracker'])
const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'hr', 'div', 'section', 'article', 'header', 'footer'])

/**
 * One tag or one run of text. Attribute values are matched quoted-aware so a `>` inside an attribute
 * (srcset, title) cannot end the tag early.
 */
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g

/** `s` without its trailing spaces and tabs, by walking back from the end: linear, unlike `/[ \t]+$/`. */
function trimTail(s: string): string {
  let e = s.length
  while (e > 0) {
    const c = s.charCodeAt(e - 1)
    if (c !== 32 && c !== 9) break
    e--
  }
  return e === s.length ? s : s.slice(0, e)
}

export function redditHtmlToText(html: string, max = BODY_CONVERT_MAX): string {
  let buf = ''
  // The break owed before the next text: 0 none, 1 a line break, 2 a blank line. Owed rather than
  // written so a closing tag followed by an opening one cannot stack two separators.
  let pend = 0
  let skip: { tag: string; depth: number } | null = null
  let pre = 0
  const lists: Array<{ ordered: boolean; n: number }> = []
  let liOpen = false
  let cell = 0

  const owe = (n: number) => { if (buf) pend = Math.max(pend, n) }
  /** Pay the owed break, if any. */
  const flush = () => {
    if (pend && buf) buf = trimTail(buf) + (pend === 2 ? '\n\n' : '\n')
    pend = 0
  }
  const write = (s: string, raw = false) => {
    if (!s) return
    flush()
    // No leading space at the start of a line, and none after a space already written (a list marker,
    // a table separator, the space between two inline elements): Reddit pads every <p> with its template
    // indentation, which would otherwise read "1.  ASRock" and "99203  | 99204".
    if (!raw && (!buf || buf.endsWith('\n') || buf.endsWith(' '))) s = s.replace(/^ +/, '')
    if (!s) return
    buf += s
    liOpen = false
  }

  for (const t of html.matchAll(TOKEN)) {
    if (buf.length > max) break
    const [, close, rawName, attrs, text] = t
    if (text !== undefined || t[0] === '<') {
      if (skip) continue
      const decoded = decodeEntities(text ?? '<').replace(INVISIBLE, '')
      if (pre) {
        write(decoded.replace(/^\n/, ''), true)
      } else {
        const collapsed = decoded.replace(/\s+/g, ' ')
        if (collapsed === ' ') {
          // Whitespace between two inline elements is a real space; at a block boundary it is layout.
          if (!pend && buf && !buf.endsWith(' ') && !buf.endsWith('\n')) buf += ' '
        } else write(collapsed)
      }
      continue
    }
    if (rawName === undefined) continue // a comment
    const name = rawName.toLowerCase()
    const closing = close === '/'

    if (skip) {
      if (name === skip.tag) skip.depth += closing ? -1 : (/\/\s*$/.test(attrs) ? 0 : 1)
      if (skip.depth <= 0) skip = null
      continue
    }
    const spoiler = name === 'shreddit-spoiler' || (name === 'span' && /\bmd-spoiler-text\b/.test(attrs))
    if (!closing && spoiler) {
      write(SPOILER_MARK)
      skip = { tag: name, depth: 1 }
      continue
    }
    if (!closing && SKIP.has(name)) {
      if (!/\/\s*$/.test(attrs)) skip = { tag: name, depth: 1 }
      continue
    }

    switch (name) {
      case 'br':
        if (buf) pend = Math.min(2, pend + 1)
        break
      case 'p':
        // A paragraph inside a list item is the item's text, not a new paragraph: Reddit wraps every
        // <li>'s content in a <p> (measured, r/buildapc 1x2zjml and 1x2z546).
        if (lists.length) { if (!closing && !liOpen) owe(1) } else owe(2)
        break
      case 'ul':
      case 'ol':
        if (!closing) {
          if (!liOpen) owe(lists.length ? 1 : 2)
          const start = Number((/\bstart="?(\d+)/.exec(attrs) || [])[1])
          lists.push({ ordered: name === 'ol', n: Number.isFinite(start) && start > 0 ? start : 1 })
        } else {
          lists.pop()
          owe(lists.length ? 1 : 2)
        }
        break
      case 'li':
        if (!closing) {
          const l = lists[lists.length - 1]
          owe(1)
          const indent = '  '.repeat(Math.max(0, lists.length - 1))
          write(indent + (l?.ordered ? `${l.n++}. ` : '• '), true)
          liOpen = true
        }
        break
      case 'pre':
        // Right after a list marker, a block is the item's own text: no break, or the marker would sit
        // alone on its line ("•\n\nquoted"). Inside a list, a block ends with a line break, not a blank
        // line, so the next item follows on the next line.
        if (!liOpen) owe(lists.length ? 1 : 2)
        pre += closing ? -1 : 1
        if (pre < 0) pre = 0
        break
      case 'tr':
        if (!closing) { owe(1); cell = 0 }
        break
      case 'td':
      case 'th':
        if (!closing) {
          // Every cell after the first is preceded by a bar, empty cells included, so a row whose first
          // cell is blank keeps its columns: the measured r/excel table's header row starts with one.
          if (cell > 0) {
            if (pend) { flush(); buf += '| ' } else { buf = trimTail(buf) + ' | ' }
          }
          cell++
        }
        break
      case 'img':
        break
      default:
        if (BLOCK.has(name) && !(liOpen && !closing)) owe(lists.length ? 1 : 2)
    }
  }
  return tidy(buf)
}

/**
 * Trailing spaces off every line, at most one blank line in a row, and no blank lines at either end. A line
 * that is nothing but table bars (a row of empty cells) carries nothing and goes too.
 */
function tidy(s: string): string {
  return s
    .split('\n').map(l => l.trimEnd()).filter(l => !/^[\s|]*\|[\s|]*$/.test(l)).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * EVERY SPOILER IN A MARKDOWN BODY, as one pass over the whole text and BEFORE it is split into lines: a
 * spoiler may span a line break (`>!Solomon was the narrator\nall along!<`), and a per-line pattern saw
 * neither line as holding one (adversarial review, 2026-10-11). A spoiler never crosses a blank line, as in
 * Reddit's renderer; one left open (a typo, or a body cut short) is masked to the end of its paragraph,
 * because masking too much is the safe direction. Linear: each opener is consumed with what it hides.
 *
 * `unwrap` keeps the hidden text and drops only the markers, for caption.ts's comparison with Reddit's
 * description, which shows a spoiler's text without its markers (measured, r/Jujutsufolk/comments/1x2vdbg).
 * `keepOpen` leaves an opener with no closer as the literal text it then is, for that description: there
 * a lone `>!` was typed, not cut (Reddit drops real markers), and masking it would hide the caption.
 *
 * LINEAR in the length of the text: the next closer and the end of the current paragraph are each found
 * once and reused by every opener before them, so many openers in one paragraph cost one scan, not one
 * scan each (the first version rescanned to the end per opener: 2.2 s for a 500 KB run in workerd).
 */
export function maskSpoilers(md: string, unwrap = false, keepOpen = false): string {
  let out = ''
  let at = 0
  let close = -2
  let paraEnd = -1
  const para = /\n[ \t]*\n/g
  for (;;) {
    const open = md.indexOf('>!', at)
    if (open < 0) return out + md.slice(at)
    if (close !== -1 && close < open + 2) close = md.indexOf('!<', open + 2)
    if (paraEnd <= open) {
      para.lastIndex = open + 2
      const blank = para.exec(md)
      paraEnd = blank ? blank.index : md.length
    }
    const end = close >= 0 && close < paraEnd ? close : -1
    if (end < 0 && keepOpen) {
      out += md.slice(at, open + 2)
      at = open + 2
      continue
    }
    const hidden = md.slice(open + 2, end >= 0 ? end : paraEnd)
    out += md.slice(at, open) + (unwrap ? hidden : SPOILER_MARK)
    at = end >= 0 ? end + 2 : paraEnd
  }
}

/**
 * Raw Reddit markdown, as an archive stores `selftext`, to the same plain text redditHtmlToText makes.
 *
 * CONSERVATIVE ON PURPOSE. This output is shown only after it is checked against Reddit's own rendering
 * of the same post (caption.ts requires Reddit's text to be a prefix of it), so a construct converted
 * slightly differently from Reddit costs the archive's text, never a wrong caption on a card.
 *
 * A single newline is a line break, as new Reddit renders it (`<br>` in the rtjson of r/tifu/1x2pjzx),
 * and a blank line a paragraph break.
 *
 * BOUNDED: only the first BODY_CONVERT_MAX characters are converted, and a body that was longer ends in
 * `…` so it can never be presented as whole. Several inline patterns rescan a line once per unclosed
 * opener, which the bound keeps to milliseconds; on a 40,000-character line it was seconds.
 */
export function redditMarkdownToText(md: string, opts: { spoilers?: 'mask' | 'unwrap' } = {}): string {
  const cut = md.length > BODY_CONVERT_MAX
  let head = cut ? md.slice(0, BODY_CONVERT_MAX) : md
  // Never half a character at the cut: a lone high surrogate would reach the card as a replacement box.
  if (cut && /[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1)
  const src = maskSpoilers(decodeEntities(head.replace(/\r\n?/g, '\n')).replace(INVISIBLE, ''), opts.spoilers === 'unwrap')
  const out: string[] = []
  let fence = false
  for (const raw of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue }
    if (fence) { out.push(raw.trimEnd()); continue }
    // Escaped characters are set aside first, so `\*` can never open emphasis, and restored last.
    let l = raw.replace(/\\([\\`*_{}[\]()#+\-.!>~^|])/g, (_, c: string) => String.fromCharCode(PARKED + c.charCodeAt(0)))
    // A table's alignment row (`|---|:--:|`) carries nothing; its cells become " | "-joined text.
    if (/^[\s|:-]+$/.test(l) && l.includes('|') && (l.match(/-/g) || []).length >= 3) continue
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push(''); continue }
    const indent = (sp: string) => '  '.repeat(Math.min(3, Math.ceil(sp.length / 4)))
    l = l.replace(/^\s{0,3}#{1,6}\s+/, '')
    l = l.replace(/^(\s*)[-*+]\s+/, (_, sp: string) => `${indent(sp)}• `)
    l = l.replace(/^(\s*)(\d{1,9})[.)]\s+/, (_, sp: string, n: string) => `${indent(sp)}${n}. `)
    if (/^\s*\|.*\|\s*$/.test(l)) l = l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).join(' | ')
    out.push(inline(l).replace(PARKED_RE, c => String.fromCharCode(c.charCodeAt(0) - PARKED)))
  }
  const text = tidy(out
    .map(l => l.replace(/^(\s*)>+\s?/, '$1'))
    .map(l => (/^\s*(?:•|\d+\. )/.test(l) ? l : l.replace(/^\s+/, '')))
    .join('\n'))
  return cut && text ? `${text}…` : text
}

/** Where an escaped ASCII character waits out the inline pass: the Private Use Area, U+E000 + its code. */
const PARKED = 0xe000
const PARKED_RE = /[\ue000-\ue07f]/g

/** Inline markdown to text: links to their text, emphasis dropped. Spoilers are already masked. */
function inline(l: string): string {
  return l
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<((?:https?:\/\/|www\.)[^>\s]+)>/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\^\(([^)]*)\)/g, '$1')
    .replace(/\^(?=\S)/g, '')
}
