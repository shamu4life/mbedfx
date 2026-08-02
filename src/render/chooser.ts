import type { Platform } from '../types.ts'
import { esc, html } from './fail.ts'

export const HOST: Record<Platform, string> = {
  x: 'x.com',
  tt: 'tiktok.com',
  ig: 'instagram.com',
  th: 'threads.com',
  rd: 'reddit.com',
  bs: 'bsky.app',
  yt: 'youtube.com',
  fb: 'facebook.com',
  dm: 'dailymotion.com',
  st: 'streamable.com',
  im: 'imgur.com',
  // clips.twitch.tv, not twitch.tv: the only Twitch surface routed here is a CLIP, and this map's
  // consumer builds "did you mean {host}{path}" links — twitch.tv/{slug} is not a real clip url.
  tw: 'clips.twitch.tv',
  // Lemmy has NO single host — that is the whole point of the platform. This row is the one
  // placeholder in the map, used only to build a "did you mean" chooser link, and a chooser can
  // never name a Lemmy post: the instance lives in the path, so a Lemmy path is never ambiguous.
  lm: 'lemmy.world',
  // Same placeholder reasoning as Lemmy above: the Mastodon-API family has no single host, and a
  // path carrying an instance is never ambiguous, so this row can never name a real post either.
  ms: 'mastodon.social',
  mk: 'misskey.io',
  pt: 'framatube.org',
  pn: 'pinterest.com',
}

/**
 * The bare, user-facing platform name — what a failure embed titles itself with ("Twitter extraction
 * failed"). Lives here beside HOST because both are per-Platform user-facing lookups keyed by the code
 * (index.ts already imports HOST from this file). The KEYS are the Platform ENUM identifiers and stay
 * as they are — `x` stays `x`, never renamed — while the VALUES are prose: `x` -> 'Twitter', never 'X'.
 *
 * DELIBERATELY A SEPARATE MAP FROM mastodon.ts's APPLICATION, not a reuse: APPLICATION is the Mastodon
 * "posted via" application name and its `bs` value is 'Bluesky Social', which is right for a "posted
 * via" footer but wrong as the bare platform name in "Couldn't load this … post". A new platform needs a row
 * in BOTH maps — keep the two in sync by eye.
 */
export const DISPLAY_NAME: Record<Platform, string> = {
  x: 'Twitter', tt: 'TikTok', ig: 'Instagram', th: 'Threads', rd: 'Reddit', bs: 'Bluesky', yt: 'YouTube', fb: 'Facebook',
  dm: 'Dailymotion', st: 'Streamable', im: 'Imgur', tw: 'Twitch', lm: 'Lemmy', ms: 'Mastodon', mk: 'Misskey', pt: 'PeerTube', pn: 'Pinterest',
}

/**
 * Guard on the RESULT being a string, NOT `?? 'this link'` on absence — the same total-over-every-key
 * rule mastodon.ts's applicationName states, for the same reason: a raw lookup on an object literal
 * inherits Object.prototype, where 'constructor' is a FUNCTION and '__proto__' an object, neither of
 * which is undefined, so a `??` fallback would never fire for them. `p` reaches here from a cache-shaped
 * outcome that is UNVALIDATED, so this is defence in depth rather than a live crash — but it is one line.
 */
export function displayName(p: Platform): string {
  const v: unknown = DISPLAY_NAME[p]
  return typeof v === 'string' ? v : 'this link'
}

/**
 * Ambiguous paths are never guessed. A human picks; a crawler is told plainly.
 * Guessing would sometimes serve the wrong post and nobody would notice.
 */
export function renderChooser(path: string, candidates: Platform[]): Response {
  const links = candidates
    .map(p => `<li><a href="https://${HOST[p]}${esc(path)}">${esc(HOST[p] + path)}</a></li>`)
    .join('')
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Which site?</title></head>` +
    `<body><h1>Which site did you mean?</h1>` +
    `<p><code>${esc(path)}</code> is a valid link on more than one site, and replacing the ` +
    `domain threw away which one. Pick:</p><ul>${links}</ul></body></html>`,
    { status: 300, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}
