import type { PostRef } from '../../types.ts'
import { fbPageUrl } from './normalize.ts'

/**
 * I/O ONLY, and this is the FIRST Facebook fetcher this project has had — the platform was
 * container-only (yt-dlp for both video and metadata) because Meta was measured to decoy the
 * crawler-UA metadata surface from datacenter egress.
 *
 * THAT MEASUREMENT WAS TRUE OF ONE USER-AGENT AND FALSE OF THE OTHERS. Measured 2026-07-26 against the
 * same post url, same minute, only the UA differing:
 *
 *   facebookexternalhit/1.1  -> HTTP 200, ZERO BYTES
 *   Twitterbot/1.0           -> HTTP 200, 319,851 bytes with a complete og: set
 *   Discordbot/2.0           -> HTTP 200, 322,740 bytes
 *
 * Meta serves its OWN crawler an empty body and a competitor's crawler the real page. So the decoy was
 * real and the generalisation from it ("the metadata surface is gated") was not — the gate is the UA.
 *
 * ASSERT ON CONTENT, NEVER STATUS: every one of those three answers is HTTP 200. The zero-byte decoy
 * and the real page are distinguished only by what is in them, which is why the caller's assertion is
 * facebookPostCard returning non-null rather than any check on this response.
 *
 * FALLBACK-ONLY. worker.ts reaches this solely after the container's yt-dlp has already declined the
 * url — i.e. the post is not a video — so the video path never pays for it, and a post that is not
 * renderable either way costs exactly one extra request on an already-failing path.
 *
 * REDIRECTS ARE FOLLOWED because the whole point is the share link: /share/{code}/ 302s to the real
 * /{page}/posts/{id}/, and the code is opaque until it does. `redirect: 'follow'` is the default and is
 * spelled out here because it is load-bearing rather than incidental. There is no SSRF concern in
 * following it — the URL is built from a validated ref against a literal facebook.com host, and the
 * only value read out of the response is an og:image that facebookPostCard range-checks against Meta's
 * CDNs before it can reach fetch() again.
 *
 * NOT EGRESS-CONFIRMED. Every measurement above is from a RESIDENTIAL host. Meta demonstrably treats
 * datacenter IPs differently on this very surface (that is what the original decoy finding was), so
 * this is written to FAIL SAFE: any throw, any empty body, any decoy returns null and the caller falls
 * through to exactly today's behaviour, which is the generic failure card.
 */
/**
 * A FULL BROWSER HEADER SET, NOT A UA STRING — and the difference is an entire feature.
 *
 * A crawler UA (Twitterbot) gets the og: set and ONE image, which is what led to the conclusion that
 * multi-image posts could only ever render a cover and that a gallery would need account credentials.
 * That was WRONG, and the owner disproved it the obvious way: the post shows all its pictures in a
 * logged-out incognito window. Measured 2026-07-26 on the same multi-image post:
 *
 *   Chrome UA alone                 ->  1,542 bytes (a shell)
 *   Chrome UA + sec-fetch-* + accept-language + accept-encoding
 *                                   ->  the real page: og: set, the age marker when present, AND
 *                                       every photo preloaded (5 distinct on the multi-image post,
 *                                       1 on the single-image one)
 *
 * So the gate is the HEADER SET, not the user-agent and not an account. Sending a browser UA without
 * the accompanying fetch-metadata headers is the worst of both worlds — it looks like a browser that
 * is lying, and Facebook answers with the shell.
 *
 * `accept-encoding` matters and is easy to miss: without it the response is smaller and incomplete.
 * Workers' fetch sets it automatically, so it is deliberately NOT spelled here — setting it by hand is
 * a forbidden header in some runtimes and would throw rather than help.
 *
 * ONE FETCH SERVES ALL THREE READS — the og: card, the gallery, and the age gate — which is why this
 * replaced the crawler-UA request rather than being added beside it.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
}

/**
 * Split from fetchFacebookPage so the share-code FALLBACK can fetch a RESOLVED permalink while still
 * caching and rendering under the ORIGINAL share ref. The url is always built by fbPageUrl from a
 * routed ref — never taken raw from a redirect Location — so the SSRF boundary stays exactly where it
 * already was: a literal facebook.com host assembled from validated ref fields.
 */
export async function fetchFacebookPageUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' })
    return await res.text()
  } catch {
    return null
  }
}

export function fetchFacebookPage(ref: Extract<PostRef, { p: 'fb' }>): Promise<string | null> {
  return fetchFacebookPageUrl(fbPageUrl(ref))
}
