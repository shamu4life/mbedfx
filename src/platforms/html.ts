/**
 * HTML -> PLAIN TEXT, for upstreams that send a rendered fragment where the card needs prose.
 *
 * The Mastodon-API family is the reason this is shared rather than local: `status.content` is always
 * HTML, never a source field, so every client in that family needs it. reddit/normalize.ts and
 * instagram/normalize.ts each carry an older private copy entangled with their own body handling;
 * they are left alone rather than refactored on the way past.
 *
 * THIS IS NOT A SANITISER AND MUST NEVER BE USED AS ONE. It produces text for a `content` string that
 * the renderers escape on output; it is not what makes anything safe to emit.
 */

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch { return _ } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ } })
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    // LAST, always. Decoding &amp; earlier would turn `&amp;lt;` into `<` — re-animating an entity
    // the author had deliberately escaped.
    .replace(/&amp;/g, '&')
}

/**
 * Block boundaries become newlines BEFORE tags are stripped, because stripping first would run
 * paragraphs together into one unreadable line — the whole reason this is not a bare tag-strip.
 *
 * The `{0,4000}` bound on the tag class mirrors instagram/normalize.ts: an unbounded `[^>]*` against
 * hostile input is a catastrophic-backtracking shape, and no real tag is anywhere near that long.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]{0,4000}>/gi, '\n\n')
      .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li[^>]{0,4000}>/gi, '• ')
      .replace(/<[^>]{0,4000}>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
