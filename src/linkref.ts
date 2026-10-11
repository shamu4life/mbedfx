import type { Platform, PostRef } from './types.ts'
import { route } from './router.ts'
import { parseRefKey, refKey } from './refkey.ts'

/**
 * Pure: THE POST A REDDIT LINK POST POINTS AT, as a ref this worker can fetch, or null.
 *
 * Reported 2026-10-11 on r/theydidthemath/comments/1mizdfz, a post that is a YouTube video and nothing else:
 * the card showed its title and no video. The worker now gives such a card the LINKED post's own media,
 * addressed under the linked post's own /_media/ key (worker.ts composeLinked), so the mux, its R2 object,
 * the cookie pool and the YouTube promise run exactly as they do when the YouTube link is pasted directly.
 *
 * THIS IS THE BOUNDARY, because the url is chosen by whoever posted to Reddit. It reaches a fetcher only as
 * a ref that route() minted for a FIXED-ORIGIN platform named by the url's own host:
 *
 *  - a closed host table. route() is host-blind on purpose (it reads the path alone; router.ts says why),
 *    so without the table `evil.example/watch?v={id}` would route to YouTube, which is harmless, and
 *    `evil.example/r/x/comments/{id}` to Reddit, which is a loop. The host decides the platform here and
 *    route() must agree with it, or there is no ref;
 *  - Reddit, the four fediverse platforms and every mbedfx host are absent, so a link post can never name
 *    another Reddit post (depth stays 1 by construction) and never names an origin of its own choosing;
 *  - no userinfo, no port, no trailing-dot host, http(s) only;
 *  - the ref must survive the wire format the /_media/ route parses (refKey, then parseRefKey), the same
 *    allowlist every media url already crosses.
 *
 * The host table follows the converter page's (public/index.html mbedfxConvert), whose host-first mapping
 * routed 53 of 53 delegable targets in a sample of 89 Reddit link posts to the right post and no wrong one
 * (2026-10-11), where raw route() got one wrong (share.google read as a Twitch clip). Measured on 42 real
 * link posts the same day: the url Reddit's page carries is byte-identical to the submitted one, so
 * `youtu.be`, `si=`, `t=` and http: all arrive intact and are read here.
 */
const HOSTS: Record<string, Platform> = {
  'youtube.com': 'yt', 'youtu.be': 'yt', 'youtube-nocookie.com': 'yt',
  'x.com': 'x', 'twitter.com': 'x', 'fxtwitter.com': 'x', 'vxtwitter.com': 'x', 'fixupx.com': 'x', 'fixvx.com': 'x',
  'tiktok.com': 'tt',
  'instagram.com': 'ig', 'ddinstagram.com': 'ig',
  'threads.com': 'th', 'threads.net': 'th',
  'bsky.app': 'bs',
  'facebook.com': 'fb',
  'dailymotion.com': 'dm', 'dai.ly': 'dm',
  'streamable.com': 'st',
  'twitch.tv': 'tw', 'clips.twitch.tv': 'tw',
  'imgur.com': 'im', 'i.imgur.com': 'im',
}

/** The presentation sub-domains the converter strips; `clips.` and `i.` are meaningful and stay. */
const PRESENTATION = /^(?:www|m|mobile|music|web)\./

function platformOf(host: string): Platform | null {
  if (Object.hasOwn(HOSTS, host)) return HOSTS[host]
  return /(?:^|\.)pinterest\.[a-z.]{2,}$/.test(host) ? 'pn' : null
}

/**
 * The path, and the one query value a post id can live in, that route() reads this platform's post from.
 * Everything else in the query is tracking (`si=`, `utm_*`, `t=`) and is dropped, as the converter drops it.
 */
function pathFor(p: Platform, host: string, u: URL): string | null {
  const seg = u.pathname.split('/').filter(Boolean)
  const id = (s: string | undefined) => (s && /^[A-Za-z0-9_-]+$/.test(s) ? s : null)
  switch (p) {
    case 'yt': {
      if (host === 'youtu.be') return id(seg[0]) ? `/${seg[0]}` : null
      if (seg[0] === 'watch') {
        const v = id(u.searchParams.get('v') ?? undefined) ?? id(seg[1])
        return v ? `/watch?v=${v}` : null
      }
      return seg.length >= 2 && ['shorts', 'live', 'embed'].includes(seg[0]) && id(seg[1]) ? `/${seg[0]}/${seg[1]}` : null
    }
    case 'st':
      if (seg.length === 1 && id(seg[0]) && seg[0] !== 'e' && seg[0] !== 's') return `/st/${seg[0]}`
      return (seg[0] === 'e' || seg[0] === 's') && id(seg[1]) ? `/st/${seg[1]}` : null
    case 'dm':
      if (host === 'dai.ly') return id(seg[0]) ? `/dm/${seg[0]}` : null
      return seg[0] === 'video' && seg[1] ? (id(seg[1].split('_')[0]) ? `/dm/${seg[1].split('_')[0]}` : null) : null
    case 'tw':
      if (host === 'clips.twitch.tv') return id(seg[0]) ? `/tw/${seg[0]}` : null
      return seg.length === 3 && seg[1] === 'clip' && id(seg[2]) ? `/tw/${seg[2]}` : null
    case 'im':
      if (seg[0] === 'a' && id(seg[1])) return `/a/${seg[1]}`
      if (seg[0] === 'gallery' && id(seg[1])) return `/im/gallery/${seg[1]}`
      if (host === 'i.imgur.com') return seg.length === 1 && /^[A-Za-z0-9]+\.[a-z0-9]{3,4}$/.test(seg[0]) ? `/${seg[0]}` : null
      return seg.length === 1 && id(seg[0]) ? `/im/${seg[0]}` : null
    case 'fb': {
      const v = u.searchParams.get('v')
      if (seg[0] === 'watch' && v && /^\d{5,}$/.test(v)) return `/watch?v=${v}`
      const fbid = u.searchParams.get('fbid')
      if (/^photo(\.php)?$/.test(seg[0] ?? '') && fbid && /^\d{5,}$/.test(fbid)) return `/photo/?fbid=${fbid}`
      return seg.length ? u.pathname : null
    }
    default:
      return seg.length ? u.pathname : null
  }
}

export function linkedRef(link: unknown): PostRef | null {
  if (typeof link !== 'string' || link.length > 2048) return null
  let u: URL
  try { u = new URL(link) } catch { return null }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase()
  if (!host || host.endsWith('.')) return null
  const bare = host.replace(PRESENTATION, '')
  const p = platformOf(bare)
  if (!p) return null
  const path = pathFor(p, bare, u)
  if (!path) return null
  let r
  try { r = route(new URL(path, 'https://mbedfx.invalid')) } catch { return null }
  if (r.kind !== 'post' || r.ref.p !== p) return null
  const key = refKey(r.ref)
  const back = parseRefKey(key)
  return back && refKey(back) === key ? back : null
}
