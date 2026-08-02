export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * EVERY rendered document goes out through here, which is why the cache header lives here and not
 * at one call site.
 *
 * THE BUG THIS FIXES, measured 2026-07-19. We set NO Cache-Control on embed HTML, so Cloudflare
 * applied a zone default and the edge served our documents for FOUR HOURS:
 *
 *     cf-cache-status: HIT
 *     age: 871
 *     cache-control: max-age=14400
 *
 * That is not a performance footnote — it silently invalidated a full day of A/B testing against a
 * real Discord client. The loop was: curl a URL (which POPULATES the edge cache), deploy a fix, hand
 * the same URL to a human, and Cloudflare serves them the PRE-DEPLOY document. Four separate
 * hypotheses about Discord's card selection were recorded as "refuted by measurement" when the
 * measurement never saw the new code at all. Any conclusion drawn from a same-URL retest inside four
 * hours of a deploy is void.
 *
 * `max-age=0, must-revalidate` rather than a long TTL: this project's OWN two-layer Cache API
 * absorbs the expensive part (the upstream fetch), so edge caching of the HTML buys little and costs
 * the ability to observe a deploy. Production fxtiktok ships `public, max-age=3600`; raising ours to
 * something similar is a deliberate performance decision to make LATER, with a way to bust it, not a
 * default to inherit silently from the CDN.
 */
export function html(head: string, status = 200): Response {
  return new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  })
}

/** 302, never a meta refresh: Telegram hangs on meta refresh. */
export function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } })
}

/**
 * `color` defaults to the alarm red every genuine failure has always used; it is a parameter ONLY so
 * the age-restricted embed can pass a calmer neutral, because an age gate is a known limit rather than
 * an error. esc() on a caller-chosen hex is defence in depth (the value is a literal today), and it
 * keeps the theme-color spelled name= here — the deliberate, recorded divergence from the spoof head's
 * property= that render.test.mjs pins.
 */
export function errorEmbed(title: string, reason: string, color = '#d33'): Response {
  return html(
    `<meta property="og:title" content="${esc(title)}"/>` +
    `<meta property="og:description" content="${esc(reason)}"/>` +
    `<meta name="theme-color" content="${esc(color)}"/>`,
  )
}
