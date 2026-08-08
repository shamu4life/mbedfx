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
 * TAKES A URL, NOT A REF, so the share-code FALLBACK can fetch a RESOLVED permalink while still
 * caching and rendering under the ORIGINAL share ref. The url is always built by fbPageUrl from a
 * routed ref — never taken raw from a redirect Location — so the SSRF boundary stays exactly where it
 * already was: a literal facebook.com host assembled from validated ref fields.
 */
/**
 * THE SECOND CLIENT SHAPE, and the reason there are now two.
 *
 * BROWSER_HEADERS above stopped working from datacenter egress between 2026-08-01 and 2026-08-08.
 * normalize.ts:41 records /{owner}/posts/{id} answering "our datacenter egress with a complete og:
 * set" on the earlier date; on the later one the same url, same code, same headers returns nothing
 * facebookPostCard can read, and every spelling of the same post fails with it (share, story.php,
 * pfbid, numeric-owner). Nothing in this repo changed in between.
 *
 * IT IS NOT THE EGRESS BEING BLOCKED OUTRIGHT, which is the tempting and wrong conclusion. The SAME
 * Cloudflare egress reaches Facebook fine in the same minute — resolveMetaShare pulls og:url out of
 * a real /share/{code} body, and it can only be doing so from the BODY, because metashare/fetch.ts:74
 * measured that Facebook hands Cloudflare no 3xx on that url at all. So Facebook is serving this
 * egress real HTML to one client shape and not to the other.
 *
 * WHAT DIFFERS, and why this set is the one to fall back to. The working shape is
 * metashare's SHARE_HEADERS: a CURRENT Chrome and five headers. The failing one pins
 * Chrome/131 — roughly two years stale by 2026-08 — and adds sec-ch-ua client hints advertising the
 * same stale build. A stale client is a cheap thing for Meta to gate on, and cheaper still when the
 * IP is a datacenter. This is the best-supported reading of the measurements, NOT a proven cause:
 * the two probes also differ in url surface, and separating those needs a request from Cloudflare
 * egress that this repo has no way to make on demand (preview URLs sit behind Access).
 *
 * WHY IT IS ADDED RATHER THAN SUBSTITUTED. BROWSER_HEADERS is what makes the GALLERY work — the
 * multi-image preload is what the fuller header set bought, measured 2026-07-26 — so replacing it
 * would trade a live feature for a hypothesis. Tried second, it costs one request on a path that has
 * already failed, and if the theory is wrong the answer is exactly today's failure card.
 *
 * VERIFIED to parse: fetched residentially 2026-08-08 against the reported post, this shape returns
 * 990,812 bytes and facebookPostCard builds the full card from it (author, caption, image). That
 * says the shape is not WORSE, which is all a residential probe can say about a datacenter gate.
 */
const LEAN_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  accept: 'text/html',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
}

/**
 * Tried IN ORDER by the caller, richest first. The order is the point: the first entry is the one
 * that reads a gallery, the second is the one measured still reaching this egress.
 */
export const FB_CLIENT_SHAPES: readonly Record<string, string>[] = [BROWSER_HEADERS, LEAN_HEADERS]

export async function fetchFacebookPageUrl(
  url: string, headers: Record<string, string> = BROWSER_HEADERS,
): Promise<string | null> {
  try {
    const res = await fetch(url, { headers, redirect: 'follow' })
    return await res.text()
  } catch {
    return null
  }
}
