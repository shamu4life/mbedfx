import type { PostRef } from './types.ts'

// Every component is percent-encoded before joining. Two reasons:
//   1. Bluesky handles may be DIDs (did:plc:…), which contain the ':' delimiter.
//   2. refKey is interpolated into /_media/{refKey}/{index}, so it must be path-safe.
const enc = (s: string) => encodeURIComponent(s)
const dec = (s: string) => decodeURIComponent(s)

/**
 * THE ID SHAPES OF THE yt-dlp TIER — Dailymotion, Streamable, Imgur — AND WHY THEY LIVE HERE RATHER
 * THAN IN router.ts, which is where their matchers are.
 *
 * parseRefKey, NOT THE ROUTER, IS THE REAL BOUNDARY. A refKey reaches this function from two places
 * the router's regexes never see: the `/_media/{key}/{i}` path segment, and the Mastodon-spoof {id}
 * (`decodeStatusId` -> here). Both are attacker-supplied strings, and both mint a PostRef the worker
 * turns straight into a page url the CONTAINER is asked to extract (`https://streamable.com/{id}`).
 * Before this check the new dm/st/im arms accepted ANY non-empty id, so `/_media/{st:%2e%2e%2fadmin}/0`
 * chose that page. The router refusing such a segment is no protection at all — the router is not on
 * that path.
 *
 * DEFINED HERE AND IMPORTED BY router.ts, in that direction, for two reasons. router.ts already
 * imports this module, so this direction adds no import cycle. And the ROUND TRIP is this file's
 * invariant — cache.ts::isValidRef validates a cached record by refKey -> parseRefKey -> compare — so
 * an id the router mints and this function refuses would deserialize as null on every read: every
 * request re-fetching, silently, with nothing anywhere reporting it. One spelling of each shape makes
 * the two provably the same rule instead of two lists that drift.
 */
/** Dailymotion ids are 'x' + base36, 6-7 chars in practice (xaqwy7q); bounded rather than open. */
export const DM_ID = /^x[0-9a-z]{4,9}$/
/** Streamable ids are a short alnum word ('moo'); the shape is bounded, not `\w+` of any length. */
export const ST_ID = /^[A-Za-z0-9]{2,16}$/
/** Imgur ids are 5 or 7 url-safe alnum chars (A61SaA1, dqOyj). */
export const IM_ID = /^[A-Za-z0-9]{5,7}$/
const YTDLP_ID: Record<'dm' | 'st' | 'im', RegExp> = { dm: DM_ID, st: ST_ID, im: IM_ID }

/**
 * A TWITCH CLIP SLUG. Here rather than in platforms/twitch/, for the reason the block above gives —
 * this function is the boundary, not the router — and in THIS direction because refkey.ts imports
 * nothing but types.ts, so a platform module importing it adds no cycle.
 *
 * MEASURED over 697 real slugs pulled from ten channels' all-time clips (2026-07-27): length 18..61,
 * charset `[A-Za-z0-9_-]`, no dots ever, always leading uppercase. The bound here is deliberately
 * LOOSER than the measurement (3..100, leading alnum) because this is a SAFETY check on an
 * attacker-supplied path segment, not a recogniser — the router's TWITCH_CLIP_SLUG is the tight one,
 * and tightening this to the measured shape would make an older or shorter slug uncacheable rather
 * than merely unroutable.
 */
export const TWITCH_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{2,99}$/

/**
 * A FEDIVERSE INSTANCE HOSTNAME — the only ref field in this codebase that becomes the ORIGIN of a
 * request rather than a path component of a fixed one, and therefore the one that most needs this
 * function to be the boundary rather than the router.
 *
 * It is a SYNTACTIC guard, and being precise about what it does and does not buy matters more here
 * than anywhere else in this file:
 *
 *  WHAT IT RULES OUT, structurally. Requiring at least two labels and an ALPHABETIC final label of
 *  2..24 characters excludes every IP literal in one stroke — 127.0.0.1 and 10.0.0.1 end in digits,
 *  and every IPv6 form (including the `::ffff:`-mapped and NAT64 spellings that defeat naive
 *  prefix-based v6 guards) is either bracketed or full of colons, neither of which this admits. It
 *  also excludes `localhost` (one label), userinfo (`@`), and a port (`:`), because none of those
 *  characters appear in the class.
 *
 *  WHAT IT DOES NOT BUY, stated plainly rather than left to be assumed: a PUBLIC name that resolves
 *  to a private address still passes. There is no DNS resolution here and no TOCTOU-free way to add
 *  one in a Worker. Cloudflare's docs are SILENT on whether Workers `fetch()` blocks RFC1918 /
 *  127.0.0.1 / 169.254.0.0/16 — the documented block (`cannot connect to the specified address`)
 *  covers `connect()`, i.e. TCP sockets, and the fetch page restates nothing; error 1021 proves SOME
 *  host-access control exists without saying what is in it. So the platform is NOT relied on. The
 *  residual exposure is bounded instead at the fetch boundary, where platforms/lemmy/fetch.ts sends
 *  NO credential, caps the body, and refuses anything that is not a Lemmy-shaped JSON document — so
 *  a hit on a private address yields a blind GET whose response never reaches a client.
 *
 * LOWERCASE ONLY. Hostnames are case-insensitive, so the router lowercases before minting a ref;
 * accepting mixed case here would let `Lemmy.World` and `lemmy.world` mint two cache entries for one
 * instance, and cache.ts validates a record by round-tripping the key, so both would persist.
 *
 * The 253-character total is the DNS limit; 63 per label likewise.
 */
export const FEDI_HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/

/**
 * A Lemmy row id. Numeric, no leading zero, bounded — so one post has exactly ONE spelling and
 * `/post/007` cannot mint a second cache entry for `/post/7`. Twelve digits is far above the largest
 * id observed anywhere (lemmy.dbzer0.com was at 72,981,433 on 2026-07-27).
 */
export const LEMMY_ID = /^[1-9][0-9]{0,11}$/

/**
 * A Pinterest pin id. Numeric and bounded; observed 16-19 digits (66287425756772418,
 * 4855512095802122). No leading zero, so one pin has exactly one spelling and `/pin/0123` cannot
 * mint a second cache entry for `/pin/123`.
 */
export const PIN_ID = /^[1-9][0-9]{4,21}$/

/**
 * A status id in the Mastodon-API family. DELIBERATELY LOOSER THAN LEMMY_ID, because this one id
 * space is shared by software that disagrees about what an id looks like:
 *
 *   Mastodon      numeric snowflake      116995943988954963
 *   Pleroma       base62 FlakeID         AhF3rSKHCdWTxTKGmi
 *   GoToSocial    ULID (Crockford b32)   01H8XPS3M4VQKB7FZG2N9YRJDT
 *   Pixelfed      numeric
 *
 * Requiring digits-only would silently drop every Pleroma and GoToSocial link; there is no single
 * shape to pin, so the class is the constraint instead.
 *
 * ALPHANUMERIC-ONLY IS THE SECURITY PROPERTY, and it is what makes this safe despite being loose.
 * The value is interpolated into `/api/v1/statuses/{id}` on a host the user also supplied, so it is
 * attacker-controlled path material. With no '/', '.', '%', '?', '#' or ':' admitted it cannot climb
 * out of the path segment, reach a different endpoint, smuggle a query, or re-encode into one — the
 * whole class of path-traversal and request-splitting tricks is excluded by construction rather than
 * by escaping. The 64-char bound keeps a hostile ref from bloating a cache key.
 *
 * CASE IS PRESERVED, unlike FEDI_HOST: Pleroma FlakeIDs and GoToSocial ULIDs are case-bearing, so
 * lowercasing would corrupt them. That means `/@u/AbC` and `/@u/abc` are two refs — correct, because
 * upstream they are two different ids (or one id and one 404), not two spellings of one.
 */
export const MASTO_ID = /^[A-Za-z0-9]{1,64}$/

/**
 * A PeerTube video id — its shortUUID (base58, 22 chars, e.g. `vZNcho9kCoVzc8wZwacPtc`) or its full
 * UUID (36 with dashes). Both address the same video and both appear in pasted urls.
 *
 * DASHES ARE ADMITTED, unlike MASTO_ID, because a UUID cannot be expressed without them. Everything
 * that makes that safe still holds: no '/', '.', '%', '?', '#' or ':', so the value cannot climb out
 * of its path segment or smuggle a query when interpolated into `/api/v1/videos/{id}` on a host the
 * user also supplied. A LEADING dash is refused so the value can never look like a CLI flag to
 * anything downstream that shells out.
 */
export const PEERTUBE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{15,39}$/

/**
 * The cache and media-URL identity for a post. Derived from the ref's own fields
 * in a fixed order — never from the request path — so /p/ABC and /ig/p/ABC share
 * one cache entry and tracking params cannot cause a miss.
 */
export function refKey(ref: PostRef): string {
  switch (ref.p) {
    case 'x':
    case 'tt':
    case 'yt':
    // The yt-dlp tier: one opaque id apiece, exactly like yt.
    case 'dm':
    case 'st':
      return `${ref.p}:${enc(ref.id)}`
    /**
     * Imgur carries its `kind`, for Twitch's reason one paragraph down and one more of its own: the
     * three surfaces resolve through DIFFERENT API endpoints (`media/` vs `albums/`), so a key that
     * dropped the kind would make an album and a single indistinguishable at /_media/ time.
     *
     * THIS CHANGED SHAPE from the old `im:{id}`, which invalidates every cached Imgur entry. That is
     * safe and self-healing — cache.ts::isValidRef re-parses the key, an old one now fails to parse,
     * and the post is refetched — but it does mean the first render of each in-flight Imgur post
     * after deploy pays a fetch, and any /_media/ url Discord already cached 404s rather than
     * serving stale bytes. Preferable to the alternative, which is two shapes sharing one key.
     */
    case 'im':
      return `im:${ref.kind}:${enc(ref.id)}`
    case 'ig':
      return ref.kind === 'story'
        ? `ig:story:${enc(ref.user)}:${enc(ref.id)}`
        : `ig:${ref.kind}:${enc(ref.code)}`
    case 'th':
      return `th:${enc(ref.code)}`
    case 'rd':
      return `rd:${enc(ref.sub)}:${enc(ref.id)}`
    case 'bs':
      return `bs:${enc(ref.handle)}:${enc(ref.rkey)}`
    case 'fb':
      return `fb:${ref.kind}:${enc(ref.id)}`
    // `kind` is carried even though 'clip' is its only member today, so adding VODs later is a new
    // arm rather than a refKey format change that would silently invalidate every cached clip.
    case 'tw':
      return `tw:${ref.kind}:${enc(ref.slug)}`
    // The HOST leads, because it is the outer scope of the identity: two instances' post 7 are
    // different posts, and grouping by host keeps that obvious in any cache listing.
    case 'lm':
      return `lm:${enc(ref.host)}:${ref.kind}:${enc(ref.id)}`
    // Host-first for the same reason as 'lm'. There is no `kind` because this family has exactly one
    // addressable object — a status — where Lemmy has posts and comments.
    case 'ms':
      return `ms:${enc(ref.host)}:${enc(ref.id)}`
    // Host-first for the same reason as 'lm' and 'ms'.
    case 'mk':
      return `mk:${enc(ref.host)}:${enc(ref.id)}`
    // Host-first, same as every other origin-naming ref.
    case 'pt':
      return `pt:${enc(ref.host)}:${enc(ref.id)}`
    case 'pn':
      return `pn:${enc(ref.id)}`
  }
}

/** Exact inverse of refKey. Returns null for anything malformed — never guesses. */
export function parseRefKey(key: string): PostRef | null {
  // decodeURIComponent (via dec) throws URIError on malformed percent-encoding
  // (e.g. a lone '%' or a truncated multi-byte escape). Since the raw, undecoded
  // request path reaches this function, that input is attacker-influenced and
  // must produce null (→ 404), never an uncaught exception (→ 500).
  try {
    const p = key.split(':')
    const ok = (i: number) => typeof p[i] === 'string' && p[i].length > 0
    // Named, not `switch (p[0])`, purely so TypeScript narrows the tag to a literal inside the
    // shared dm/st/im arm below — an element access is not a narrowable reference.
    const tag = p[0]
    switch (tag) {
      case 'x':
        return p.length === 2 && ok(1) ? { p: 'x', id: dec(p[1]) } : null
      case 'tt':
        return p.length === 2 && ok(1) ? { p: 'tt', id: dec(p[1]) } : null
      case 'yt':
        return p.length === 2 && ok(1) ? { p: 'yt', id: dec(p[1]) } : null
      // The yt-dlp tier. BOTH DIRECTIONS MUST GROW TOGETHER: the `default: return null` below makes a
      // missing arm fail as a silent 404 on /_media/{refKey}/{i} — a card with a poster and a video url
      // that resolve to nothing, with no error anywhere.
      //
      // THE ID IS SHAPE-CHECKED, unlike every arm above it, and that asymmetry is deliberate rather
      // than inconsistent: these three are the only refs whose id is interpolated into a page url a
      // CONTAINER then fetches (see YTDLP_ID above for why this function, not the router, is the
      // boundary). The others name an upstream API by id and cost at most a bad request.
      case 'dm':
      case 'st': {
        if (p.length !== 2 || !ok(1)) return null
        const id = dec(p[1])
        return YTDLP_ID[tag].test(id) ? { p: tag, id } : null
      }
      /**
       * Imgur, which left the tier above but KEEPS ITS SHAPE CHECK. The 'post' kind still reaches a
       * container page url (i.imgur.com/{id}.gifv) for animated singles, so relaxing IM_ID here would
       * reopen exactly the hole the tier docstring describes. 'album' and 'gallery' only ever reach
       * api.imgur.com, but they are held to the same rule rather than a looser second one — the ids
       * are drawn from the same alphabet, and one spelling is one thing to keep correct.
       */
      case 'im': {
        if (p.length !== 3 || !ok(2)) return null
        if (p[1] !== 'post' && p[1] !== 'album' && p[1] !== 'gallery') return null
        const id = dec(p[2])
        return IM_ID.test(id) ? { p: 'im', kind: p[1], id } : null
      }
      /**
       * EVERY fb KIND, and two were missing.
       *
       * The list was watch|reel|share, so a 'group' ref — shipped 2026-07-30 — did not survive the
       * wire at all: refKey wrote `fb:group:{gid}_{pid}` and this refused to read it back, which means
       * every /_media/{refKey}/{i} on a group post 404s and the Mastodon spoof callback for one is
       * unroutable. A silent, latent break in a shipped feature, found 2026-08-01 while adding 'post'
       * — by a round-trip assertion, which is exactly the test the group work did not have.
       *
       * THE LIST IS SPELLED OUT RATHER THAN INFERRED because this function is the security boundary
       * (see the file header): what crosses here came off the wire, so the kinds are an ALLOWLIST and
       * a new one must be added deliberately. `ok(2)` still bounds the id.
       */
      case 'fb':
        return p.length === 3 && ok(2)
          && (p[1] === 'watch' || p[1] === 'reel' || p[1] === 'share'
            || p[1] === 'group' || p[1] === 'post')
          ? { p: 'fb', kind: p[1], id: dec(p[2]) }
          : null
      // SHAPE-CHECKED like the yt-dlp tier, for the reason YTDLP_ID gives: this function, not the
      // router, is what a /_media/{refKey}/{i} segment crosses. The slug is interpolated into a
      // GraphQL variable rather than a url, so the exposure is smaller — but TWITCH_SLUG is the same
      // rule the fetcher enforces, imported rather than respelled so the two cannot drift.
      case 'tw': {
        if (p.length !== 3 || p[1] !== 'clip' || !ok(2)) return null
        const slug = dec(p[2])
        return TWITCH_SLUG.test(slug) ? { p: 'tw', kind: 'clip', slug } : null
      }
      /**
       * THE HOST IS RE-VALIDATED HERE, and this is the single most important arm in this function.
       *
       * Every other ref's fields name a resource on a FIXED origin. This one names the ORIGIN. A
       * `/_media/{refKey}/{i}` path segment is attacker-supplied, reaches this function, and the ref
       * it mints decides who the Worker talks to — so a host that fails FEDI_HOST must produce null
       * here even if some future router arm were to mint it.
       */
      case 'lm': {
        if (p.length !== 4 || !ok(1) || !ok(3)) return null
        if (p[2] !== 'post' && p[2] !== 'comment') return null
        const host = dec(p[1])
        const id = dec(p[3])
        return FEDI_HOST.test(host) && LEMMY_ID.test(id) ? { p: 'lm', host, kind: p[2], id } : null
      }
      /**
       * THE SECOND ORIGIN-NAMING ARM, and it carries the same weight as 'lm' above — see that
       * comment. The host decides who the Worker talks to and the id is interpolated into that
       * host's path, so BOTH are re-validated here rather than trusted from the router.
       */
      case 'ms': {
        if (p.length !== 3 || !ok(1) || !ok(2)) return null
        const host = dec(p[1])
        const id = dec(p[2])
        return FEDI_HOST.test(host) && MASTO_ID.test(id) ? { p: 'ms', host, id } : null
      }
      /** The third origin-naming arm. Same contract as 'lm' and 'ms' above. */
      case 'mk': {
        if (p.length !== 3 || !ok(1) || !ok(2)) return null
        const host = dec(p[1])
        const id = dec(p[2])
        return FEDI_HOST.test(host) && MASTO_ID.test(id) ? { p: 'mk', host, id } : null
      }
      /** The fourth origin-naming arm. Same contract as 'lm', 'ms' and 'mk' above. */
      case 'pt': {
        if (p.length !== 3 || !ok(1) || !ok(2)) return null
        const host = dec(p[1])
        const id = dec(p[2])
        return FEDI_HOST.test(host) && PEERTUBE_ID.test(id) ? { p: 'pt', host, id } : null
      }
      // Shape-checked like the yt-dlp tier and Twitch: refkey.ts, not the router, is what a
      // /_media/{refKey}/{i} segment crosses, and the id is interpolated into an upstream query.
      case 'pn': {
        if (p.length !== 2 || !ok(1)) return null
        const id = dec(p[1])
        return PIN_ID.test(id) ? { p: 'pn', id } : null
      }
      case 'th':
        return p.length === 2 && ok(1) ? { p: 'th', code: dec(p[1]) } : null
      case 'rd':
        return p.length === 3 && ok(1) && ok(2) ? { p: 'rd', sub: dec(p[1]), id: dec(p[2]) } : null
      case 'bs':
        return p.length === 3 && ok(1) && ok(2) ? { p: 'bs', handle: dec(p[1]), rkey: dec(p[2]) } : null
      case 'ig':
        if (p[1] === 'story') {
          return p.length === 4 && ok(2) && ok(3)
            ? { p: 'ig', kind: 'story', user: dec(p[2]), id: dec(p[3]) }
            : null
        }
        if (p[1] === 'p' || p[1] === 'reel' || p[1] === 'tv') {
          return p.length === 3 && ok(2) ? { p: 'ig', kind: p[1], code: dec(p[2]) } : null
        }
        return null
      default:
        return null
    }
  } catch {
    return null
  }
}
