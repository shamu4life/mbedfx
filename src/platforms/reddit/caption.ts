import { decodeEntities, maskSpoilers, redditHtmlToText, redditMarkdownToText } from './body.ts'

/**
 * Pure: the BODY of a Reddit post that embed.reddit.com does not carry. No I/O; fetch.ts fetches the
 * bytes and these functions read them, so the whole decision is testable against captured responses.
 *
 * THE GAP, measured 2026-10-11. embed.reddit.com renders a post's body (the rtjson div) for `text` and
 * `multi_media` posts only. Of 69 image, gallery, video and crosspost posts that HAVE a body, sampled from
 * ten subreddits, it carried the body for none; two link posts and a crosspost with bodies likewise. In
 * help and hobby subreddits 72-88% of picture posts have one, and it is often the point of the post
 * (reported: r/DeadlockTheGame/comments/1x1xajw, whose caption explains the picture).
 *
 * THE SOURCES, IN THE ORDER THE OWNER CHOSE (2026-10-11: "Reddit + archive"), every one measured from a
 * Cloudflare Worker (colo LHR, egress 2a06:98c0:3600::103) the same day:
 *
 *   1. Reddit's crawler page: www.reddit.com/r/{sub}/comments/{id}/ as Discordbot, redirect not followed.
 *      The 301's own body carries `<meta name="description">` with the body's first ~120-150 characters,
 *      current (edits show), ending in `…` when cut. 301, 5205 B, 419 ms. Twitterbot got the same meta.
 *      A post with no body carries the SUBREDDIT'S TAGLINE there instead ("2.4M subscribers in the
 *      theydidthemath community. And they said math has no real world applications"), which reads like a
 *      body and is not one, so it is recognised and refused.
 *   2. Reddit's Atom feed by id: www.reddit.com/by_id/t3_{id}/.rss. The whole body as rendered HTML,
 *      current. 200, 2567 B, 136 ms. Rationed to ONE request per IP per minute (x-ratelimit-remaining
 *      0.0 after it, and 8 of 8 second requests 429 from a residential IP), so on Cloudflare's shared
 *      egress it is a bonus when it answers, never something to depend on.
 *   3. The Arctic Shift archive: arctic-shift.photon-reddit.com/api/posts/ids. The whole body as posted.
 *      200, 940 ms. Only asked when Reddit's own text was cut short and the feed did not answer, and only
 *      believed when Reddit's cut text is a prefix of it (an archived body can predate an edit, ~6% of
 *      a residential sample, or read `[removed]` for a post approved later, another ~6%).
 *
 * www.reddit.com's `.json` is not on the list: it answers 403 to Worker egress (2026-07-21) and to a
 * residential IP (2026-10-11). Neither is old.reddit.com, which redirects a browser to a login and gives
 * a crawler the same ~140-character meta as source 1.
 *
 * SPOILERS, ON THE ONE SOURCE THAT DOES NOT MARK THEM. Reddit flattens its description from the rendered
 * post and drops a spoiler's markers while keeping what it hid: r/Jujutsufolk/comments/1x2vdbg's body opens
 * with `>!&#x200B;!<` and its description opens with the bare zero-width space (measured 2026-10-11, the
 * only spoiler-led caption in a sample of ~1,600 posts). So a caption read from the description ALONE shows
 * a spoiler as Reddit's own Discord preview of the same link shows it, which is in the clear. Wherever a
 * second source answers, its markers win: the feed's body replaces the description, and the archive's text
 * is compared with its spoilers unwrapped and shown with them masked. Raw `>!…!<` in a description, should
 * Reddit ever leave one, is masked too.
 */

/** What the crawler page said about the body. `cut` means Reddit shortened it and ended it with `…`. */
export type CrawlerCaption =
  | { kind: 'body'; text: string; cut: boolean }
  | { kind: 'none' }
  | { kind: 'unknown' }

/** What the feed entry said, or null when the bytes are not this post's entry (a 429, a block, a 404). */
export type FeedCaption = { kind: 'body'; text: string } | { kind: 'none' } | null

/**
 * Reddit prefixes the description with the post's counts when it has any ("6.8K votes, 96 comments. ");
 * a gallery with few votes carried none (r/Minecraft/comments/1x2voz0, measured from a Worker).
 */
const COUNTS_PREFIX = /^[\d.,]+\s*[KkMmBb]? votes?, [\d.,]+\s*[KkMmBb]? comments?\.\s+/

/** The three block pages Reddit serves, named by their content (every one has been seen at HTTP 200 or 403). */
function blocked(html: string): boolean {
  const lower = html.toLowerCase()
  return lower.includes('blocked by network security') || lower.includes('whoa there, pardner')
    || html.includes('name="js_challenge"')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The crawler page's verdict on the body of post `sub`/`id`. `unknown` is a page that is not this post's
 * (a block page, a challenge, a redirect with no meta, an unexpected shape), and is never read as "no body".
 */
export function crawlerCaption(html: string, sub: string): CrawlerCaption {
  if (!html || blocked(html)) return { kind: 'unknown' }
  const m = /<meta name="description" content="([^"]*)"/.exec(html)
  if (!m) return { kind: 'unknown' }
  const desc = decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
  const rest = desc.replace(COUNTS_PREFIX, '')
  // "{N} {members|subscribers|…} in the {sub} community." is the subreddit's description, shown when the
  // post itself has none. Keyed on THIS post's subreddit so a body that happens to mention a community
  // is not mistaken for it.
  if (!rest || new RegExp(`^[\\d.,]+\\s*[KkMmBb]? [A-Za-z ]{1,40} in the ${escapeRe(sub)} community\\.`, 'i').test(rest)) {
    return { kind: 'none' }
  }
  if (rest === '[removed]' || rest === '[deleted]') return { kind: 'none' }
  const cut = rest.endsWith('\u2026')
  // A cut that lands inside a spoiler swallows the `…` into the mask, so it is put back: the body is
  // still cut, and the archive is still the way to complete it.
  const text = maskSpoilers(rest)
  return { kind: 'body', text: cut && !text.endsWith('\u2026') ? `${text}\u2026` : text, cut }
}

/** The feed entry's body, read only from the entry whose id is this post's. */
export function feedCaption(xml: string, id: string): FeedCaption {
  if (!xml) return null
  // The whole <entry> that names this post. Reddit writes <content> BEFORE <id> inside an entry, so
  // reading forward from the id finds nothing (measured on /by_id/t3_1x1xajw/.rss, 2026-10-11).
  const entry = xml.split('<entry>').slice(1).map(e => e.split('</entry>')[0]).find(e => e.includes(`<id>t3_${id}</id>`))
  if (!entry) return null
  const c = /<content type="html">([\s\S]*?)<\/content>/.exec(entry)
  if (!c) return null
  const html = decodeEntities(c[1])
  const open = html.indexOf('<!-- SC_OFF --><div class="md">')
  if (open < 0) return { kind: 'none' }
  const from = open + '<!-- SC_OFF --><div class="md">'.length
  const close = html.indexOf('</div><!-- SC_ON -->', from)
  const text = redditHtmlToText(html.slice(from, close < 0 ? undefined : close))
  return text && text !== '[removed]' && text !== '[deleted]' ? { kind: 'body', text } : { kind: 'none' }
}

/**
 * The archive's body for post `id`, twice: `masked` is what a card may show, `plain` keeps each spoiler's
 * text without its markers, which is how Reddit's description renders it and so what to compare it with.
 * Null when there is no usable body. Its counts are never read: they freeze at ingest.
 */
export type ArchiveCaption = { masked: string; plain: string }

export function archiveCaption(json: string, id: string): ArchiveCaption | null {
  let data: unknown
  try { data = JSON.parse(json) } catch { return null }
  const rows = (data as { data?: unknown })?.data
  if (!Array.isArray(rows)) return null
  const row = rows.find(r => r && typeof r === 'object' && (r as { id?: unknown }).id === id) as { selftext?: unknown } | undefined
  const st = row?.selftext
  if (typeof st !== 'string' || !st.trim() || st === '[removed]' || st === '[deleted]') return null
  const masked = redditMarkdownToText(st)
  return masked ? { masked, plain: redditMarkdownToText(st, { spoilers: 'unwrap' }) } : null
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * THE ONE RULE FOR WHICH TEXT A CARD CARRIES, given whatever the fetcher managed to read.
 *
 *  - the feed's body wins: it is Reddit's own, whole and current;
 *  - else the crawler's text when Reddit did not cut it;
 *  - else, when Reddit cut it, the archive's text if Reddit's cut text is a prefix of it, and otherwise
 *    Reddit's cut text with its `…`. The prefix is all that can be checked: an edit inside the part
 *    Reddit shows is caught (the archive is refused), and one made AFTER it, once the archive had
 *    ingested the post, is not, so the card then shows the archived tail. That is the trade the owner
 *    accepted with the archive (2026-10-11); it is bounded by the card's 500 characters;
 *  - "no body" from either Reddit source is final; the archive is never asked to overrule Reddit.
 *
 * `source` is for the counters only.
 */
export function pickCaption(
  crawler: CrawlerCaption | null, feed: FeedCaption, archive: ArchiveCaption | null,
): { text: string; source: 'feed' | 'crawler' | 'archive' | 'cut' | 'none' | 'unknown' } {
  if (feed?.kind === 'body') return { text: feed.text, source: 'feed' }
  if (crawler?.kind === 'body') {
    if (!crawler.cut) return { text: crawler.text, source: 'crawler' }
    const head = flat(crawler.text.slice(0, -1))
    // Against the archive's text with spoilers unwrapped (how Reddit's description renders them) or
    // masked (how a raw marker in the description was masked above); shown masked either way.
    if (archive && head && (flat(archive.plain).startsWith(head) || flat(archive.masked).startsWith(head))) {
      return { text: archive.masked, source: 'archive' }
    }
    return { text: crawler.text, source: 'cut' }
  }
  if (feed?.kind === 'none' || crawler?.kind === 'none') return { text: '', source: 'none' }
  return { text: '', source: 'unknown' }
}
