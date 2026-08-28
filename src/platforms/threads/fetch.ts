import type { PostRef } from '../../types.ts'
import { hasThreadsSSR, threadsHasPost } from './normalize.ts'
import { askTwice } from '../../fetchretry.ts'

/**
 * I/O ONLY. Fetches the Threads post page and decides one thing — "did a real post arrive" — leaving
 * every tag-reading and Post-building decision to normalize.ts (pure, tested with no network).
 *
 * THREADS' UA GATE, measured from a datacenter IP 2026-07-21 (a valid proxy for Workers egress —
 * unlike Instagram, the gate here is the UA, NOT the IP, so a datacenter result transfers):
 *
 *   browser UA (Chrome/Firefox)  -> ~256KB contentless JS shell, NO OG tags
 *   bot UA (facebookexternalhit, Discordbot, curl, Googlebot, WhatsApp, Telegram) -> OG page
 *
 * AND THE BOT UA CHANGES THE PAYLOAD, which is why this fetches TWICE:
 *   Discordbot/2.0           -> og:title (author) + og:image = the POST media (fbcdn t39.92108-6)
 *   facebookexternalhit/1.1  -> name="description" (the caption); its og:image is only the avatar
 *
 * Neither UA carries both, so a rich card needs both pages. They are fetched concurrently; the
 * caption page is ~5x larger (~560KB vs ~100KB), which is why the cheaper Discord page owns the
 * liveness answer below and the fbhit page is read only for text.
 */
const MEDIA_UA = 'Discordbot/2.0'
const TEXT_UA = 'facebookexternalhit/1.1'

/**
 * THE SSR GATE IS A HEADER COMBINATION, not a UA (measured from Workers egress 2026-07-21). A browser
 * UA alone gets the ~256KB dataless shell; add `Accept: text/html` + `Sec-Fetch-Dest: document` +
 * `Sec-Fetch-Mode: navigate` and Threads server-renders the full post JSON (~700-860KB), video and
 * counts included, from our datacenter IP with no decoy, block or cookie. `/@i/post/{code}` 301s to
 * the real @user url and still resolves, so the ref needs only the shortcode.
 */
const SSR_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
}

/**
 * A Threads shortcode is base64url and nothing else. The bound is slack over the ~11-char norm.
 * Guards the URL the same way fetchInstagram's SHORTCODE does: route() only requires the segment be
 * truthy, and `..`/`.` would traverse out of the pinned path during URL parsing (encodeURIComponent
 * escapes '/' but not '.'), so refusing a non-shortcode BEFORE the fetch is what pins the URL.
 */
const SHORTCODE = /^[A-Za-z0-9_-]{1,64}$/

export type ThreadsFetch =
  | { ok: true; source: 'ssr'; html: string }
  | { ok: true; source: 'html'; media: string; text: string }
  | { ok: false; reason: 'assert_fail' }

/**
 * ASSERT ON CONTENT, NEVER ON STATUS — a deleted code was seen to 302 and another to 200, and a
 * browser UA gets a healthy-looking 200 shell with no post in it. The one marker is og:type=article
 * (threadsHasPost). The username is DECORATION: `/@i/post/{code}` resolves by shortcode regardless
 * (verified), which is why the ref needs to carry only the code.
 *
 * A thrown fetch is deliberately NOT caught — worker.ts's loadPost already treats a thrown live
 * fetch as null, and a transport failure is not evidence about Threads' gate, the same rule
 * fetchInstagram states.
 */
export async function fetchThreads(ref: Extract<PostRef, { p: 'th' }>): Promise<ThreadsFetch> {
  if (!SHORTCODE.test(ref.code)) return { ok: false, reason: 'assert_fail' }
  const url = `https://www.threads.com/@i/post/${encodeURIComponent(ref.code)}`

  // PRIMARY: the SSR path. ONE GET yields the full post JSON (video, counts, timestamp, carousel,
  // quotes). A rate-limit (429) or a shifted header gate returns no SSR payload and we fall through.
  try {
    const res = await askTwice(url, { headers: SSR_HEADERS, redirect: 'follow' })
    const html = await res.text()
    if (hasThreadsSSR(html)) return { ok: true, source: 'ssr', html }
  } catch {
    // Transport failure on the SSR fetch is not fatal — the OG scrape below is a second chance.
  }

  // FALLBACK: the two-UA OG scrape (author + caption + cover image, no video/counts). Robust when the
  // SSR path is throttled, at the cost of richness. No single bot UA carries both text and media, so
  // Discordbot gives the post image and facebookexternalhit the caption.
  const [media, text] = await Promise.all([
    fetch(url, { headers: { 'user-agent': MEDIA_UA, accept: 'text/html' } }).then(r => r.text()),
    fetch(url, { headers: { 'user-agent': TEXT_UA, accept: 'text/html' } }).then(r => r.text()),
  ])
  if (!threadsHasPost(media) && !threadsHasPost(text)) return { ok: false, reason: 'assert_fail' }
  return { ok: true, source: 'html', media, text }
}
