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
 */

/**
 * THE NAMED ENTITIES REDDIT'S PAGES AND FEEDS USE, plus the punctuation ones a body can carry. Numeric
 * forms are decoded generically. `&amp;` is handled by the same single pass, so `&amp;lt;` becomes the
 * literal `&lt;` and is not decoded twice.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', euro: '€', pound: '£', cent: '¢',
  yen: '¥', sect: '§', para: '¶', shy: '', zwj: '‍', zwnj: '‌',
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
const INVISIBLE = /[​﻿\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * A SPOILER IS REPLACED, NEVER SHOWN. Reddit hides `>!text!<` behind a click; a card has no click, so
 * the honest rendering is a marker that says something is hidden. rtjson spells it `<shreddit-spoiler>`
 * (measured on r/anime/comments/1x2om7u, 2026-10-11) and the feed's old renderer `<span
 * class="md-spoiler-text">`.
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

export function redditHtmlToText(html: string): string {
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
  const write = (s: string, raw = false) => {
    if (!s) return
    if (pend && buf) {
      buf = buf.replace(/[ \t]+$/, '') + (pend === 2 ? '\n\n' : '\n')
    }
    pend = 0
    // No leading space at the start of a line, and none after a space already written (a list marker,
    // a table separator, the space between two inline elements): Reddit pads every <p> with its template
    // indentation, which would otherwise read "1.  ASRock" and "99203  | 99204".
    if (!raw && (!buf || buf.endsWith('\n') || buf.endsWith(' '))) s = s.replace(/^ +/, '')
    if (!s) return
    buf += s
    liOpen = false
  }

  for (const t of html.matchAll(TOKEN)) {
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
          owe(lists.length ? 1 : 2)
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
        owe(2)
        pre += closing ? -1 : 1
        if (pre < 0) pre = 0
        break
      case 'tr':
        if (!closing) { owe(1); cell = 0 }
        break
      case 'td':
      case 'th':
        if (!closing) {
          if (cell > 0 && !pend) { buf = buf.replace(/[ \t]+$/, ''); write(' | ', true) }
          cell++
        }
        break
      case 'img':
        break
      default:
        if (BLOCK.has(name)) owe(2)
    }
  }
  return tidy(buf)
}

/** Trailing spaces off every line, at most one blank line in a row, and no blank lines at either end. */
function tidy(s: string): string {
  return s
    .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
 */
export function redditMarkdownToText(md: string): string {
  const lines = decodeEntities(md.replace(/\r\n?/g, '\n')).replace(INVISIBLE, '').split('\n')
  const out: string[] = []
  let fence = false
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue }
    if (fence) { out.push(raw.replace(/\s+$/, '')); continue }
    // Escaped characters are set aside first, so `\*` can never open emphasis, and restored last.
    let l = raw.replace(/\\([\\`*_{}[\]()#+\-.!>~^|])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)))
    // A table's alignment row (`|---|:--:|`) carries nothing; its cells become " | "-joined text.
    if (/^[\s|:-]+$/.test(l) && l.includes('|') && (l.match(/-/g) || []).length >= 3) continue
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push(''); continue }
    const indent = (sp: string) => '  '.repeat(Math.min(3, Math.ceil(sp.length / 4)))
    l = l.replace(/^\s{0,3}#{1,6}\s+/, '')
    l = l.replace(/^(\s*)[-*+]\s+/, (_, sp: string) => `${indent(sp)}• `)
    l = l.replace(/^(\s*)(\d{1,9})[.)]\s+/, (_, sp: string, n: string) => `${indent(sp)}${n}. `)
    if (/^\s*\|.*\|\s*$/.test(l)) l = l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).join(' | ')
    out.push(inline(l).replace(/[-]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xe000)))
  }
  return tidy(out
    .map(l => l.replace(/^(\s*)>+\s?/, '$1'))
    .map(l => (/^\s*(?:•|\d+\. )/.test(l) ? l : l.replace(/^\s+/, '')))
    .join('\n'))
}

/** Inline markdown to text: spoilers masked, links to their text, emphasis dropped. */
function inline(l: string): string {
  return l
    .replace(/>!([\s\S]*?)!</g, SPOILER_MARK)
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
