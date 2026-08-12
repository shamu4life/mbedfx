import type { Platform, PostRef, Route } from './types.ts'
import {
  DM_ID, FEDI_HOST, IM_ID, LEMMY_ID, MASTO_ID, PEERTUBE_ID, PIN_ID, ST_ID, TWITCH_SLUG, parseRefKey,
} from './refkey.ts'
import { decodeStatusId } from './statusid.ts'

// A CLOSED ALLOWLIST, and og.jpg has to be in it. The asset binding only answers for paths this
// set names, so an og:image pointing anywhere else 404s and the site's own card draws no picture —
// which is a conspicuous way for an embed fixer to fail.
//
// /openapi.json IS THE SIXTH, ADDED 2026-08-11, AND IT COSTS A PATH — so the shadowing is stated
// rather than assumed. Measured before adding it: route() answered /openapi.json with the ambiguity
// chooser, candidates ['x','ig'], and BOTH candidates dead-end — /x/openapi.json and
// /ig/openapi.json are each notfound, there being no profile route kind. So nothing that resolves
// today stops resolving; what is shadowed is a chooser page for a would-be profile whose every
// branch is already a 404. (An Instagram handle may legally contain a dot, which is why this is
// checked rather than dismissed.)
//
// WHAT IT BUYS. A spec that only sits in the repository is a file somebody has to go and find; a
// served one is a url `openapi-generator -i` and every schema viewer take directly, which is the
// form the rival fixers publish theirs in. The ASSET binding serves it, so the worker runs no code
// for it: no input is read, no upstream is reached, nothing is cached that could go stale. It is
// cheaper than /_smoke, which is the precedent for a fixed-cost path here.
//
// The alternative shapes were considered and are worse: /_api/v1/openapi.json would need a nested
// public/_api/v1/ directory for the asset binding to answer it, and would carve an exception into
// "an unrecognised path under /_api/v1 is a plain 404", which docs/API.md tells consumers to rely
// on. /openapi.json is where tooling looks first.
const SITE_PATHS = new Set(['/', '/index.html', '/favicon.ico', '/robots.txt', '/og.jpg', '/openapi.json'])

/**
 * Root tokens we claim as escape hatches (e.g. /x/status/123 forces the X interpretation).
 * A real handle can equal one of these tokens (x.com/x/status/123 is X Corp's own account),
 * so the escape hatch is tried FIRST but is not final: if forcing the token as a platform
 * yields no match, `route()` falls through to the normal unforced interpretation instead of
 * dead-ending. This shadows bare profiles under these names (no profile Route kind exists, so
 * that costs nothing) without ever shadowing a real post permalink.
 */
const ESCAPE: Record<string, Platform> = {
  x: 'x', tt: 'tt', ig: 'ig', th: 'th', rd: 'rd', bs: 'bs', yt: 'yt', fb: 'fb',
  /**
   * The yt-dlp tier. Each of these three ALSO carries a forced-only depth-1 arm — /dm/{id},
   * /st/{id}, /im/{id} — which is the only way this router can serve dai.ly/{id},
   * streamable.com/{id} and imgur.com/{id}: route() is HOST-AGNOSTIC (it reads url.pathname and
   * url.searchParams and nothing else, verified by grep for hostname/url.host across router.ts and
   * worker.ts), so all three of those collapse onto ONE bare /{id} that is measurably undecidable —
   * Dailymotion's real id 'xaqwy7q' also satisfies Imgur's 5-7 alnum shape, and YouTube already owns
   * every exactly-11-char bare segment. Forcing is the user saying which one they mean.
   *
   * ADDING THESE TOKENS SHADOWS NOTHING, and that was measured rather than reasoned: /dm/…, /st/…
   * and /im/… are notfound at every depth today EXCEPT /{token}/videos/{numeric}, which facebook()
   * claims as a watch post — and that still resolves, because the ESCAPE block FALLS THROUGH when
   * the forced matcher misses. Bare /dm, /st and /im stay the ['x','ig'] chooser for the same reason.
   */
  dm: 'dm', st: 'st', im: 'im',
  /**
   * Twitch. Like the yt-dlp tier this token unlocks a depth-1 arm — /tw/{slug} — but for the opposite
   * reason: the bare arm is not undecidable here (the slug shape is measured and tight), so forcing
   * exists to accept a slug the RECOGNISER refuses rather than to break a tie. The unforced twin
   * matchPost's comment requires is the shape-gated depth-1 arm plus the two 'clip' forms.
   */
  tw: 'tw',
  /** Lemmy. See the lemmy() matcher for why the instance must live in the path. */
  lm: 'lm',
  /** The Mastodon-API family — Mastodon, Pleroma, Akkoma, Iceshrimp. See masto(). */
  ms: 'ms',
  /** The Misskey family — Misskey, Sharkey, Iceshrimp. See misskey(). */
  mk: 'mk',
  /** PeerTube. See peertube(). */
  pt: 'pt',
  /** Pinterest. */
  pn: 'pn',
}

/**
 * Build a canonical URL out of already-DECODED path segments.
 *
 * EVERY canonical must go through here. `route()` decodes each segment (`raw.map(safeDecode)`)
 * before the matchers see it, so interpolating a segment straight into a template string can
 * put a raw CR, LF, NUL or astral codepoint inside the result — and worker.ts hands canonical
 * to `redirect()`, which puts it in a `location` header. `new Headers()` rejects all of those,
 * handle() has no try/catch, and the default export does not wrap it, so the throw surfaced as
 * an uncaught HTTP 500 on a public path. Measured: injecting each codepoint 0x00..0x17F into
 * the handle segment of /@u{c}/video/123 turned 131 previously-notfound paths into a crash.
 *
 * `new URL().href` is the fix because it re-applies the URL spec's own path percent-encode set,
 * which covers C0 controls AND everything above U+007E — so the result is always pure printable
 * ASCII, i.e. always a legal header value. Verified over codepoints 0x00..0x2FFFF: zero
 * header-unsafe outputs.
 *
 * NOT encodeURIComponent per segment, which is the obvious-looking fix and is wrong: it would
 * escape the characters these URLs legitimately contain, turning '@mysticaquarium' into
 * '%40mysticaquarium' and a Bluesky DID's colons into '%3A'. Normalization is a no-op on every
 * URL we already emit — pinned by a test — so this changes nothing except the crashes.
 *
 * Two accepted trades, both strictly better than a 500:
 *  - CR/LF/TAB are STRIPPED rather than escaped (the URL parser removes them before parsing),
 *    so a handle carrying them is silently mangled. Harmless here: the handle segment is
 *    decoration on all three platforms — tiktok.com/@i/video/{id} and x.com/anything/status/{id}
 *    both resolve regardless of it — and the post id is what carries identity.
 *  - A segment that decoded to contain '/' (from %2F) can traverse, e.g. '@a/../..'. The host
 *    is a fixed literal prefix and traversal cannot climb past it, so the result stays on the
 *    intended origin; verified '@a/../../evil.com' normalizes to www.tiktok.com/evil.com/….
 *
 * Total by construction: scheme and host are literals in every call site, so there is no input
 * that makes `new URL` throw. No try/catch, because a catch here would be unreachable code.
 */
function canonical(url: string): string {
  return new URL(url).href
}

/**
 * EVERY TOKEN THE AMBIGUITY TABLE NAMES, with the candidate row it carries. ONE object, because it
 * has two consumers that must never disagree about what "reserved" means:
 *
 *   - ambiguity() below, which reads its rows out of this. The POSITION each token is reserved at
 *     stays in that function and cannot move here — 'hashtag' is a row at seg[0] and 'followers' one
 *     at seg[1], and no flat table expresses that.
 *   - reserved(), which the yt-dlp tier's id matchers consult so they cannot CONSUME one of these
 *     tokens as an id. That was a live routing regression, not a hypothetical: ST_ID is
 *     /^[A-Za-z0-9]{2,16}$/, loose enough to match 'followers' and 'following', so /e/followers,
 *     /s/followers, /st/followers and the three /following twins stopped being the ['x','ig'] chooser
 *     and became Streamable posts. Measured 2026-07-26 by running the real route() over a
 *     219,660-path sweep with the tier on and off: those SIX paths were the entire regression — every
 *     other difference the tier makes is notfound -> post. Consuming a token the table declares
 *     undecidable is the same defect this file already fixed once for /settings/{surface}/{code}, and
 *     ambiguity()'s own docstring forbids it in as many words.
 *
 * A SECOND HAND-WRITTEN LIST WOULD BE ITS OWN BUG. Two copies drift, a matcher keeps consuming a row
 * somebody added later, and nothing reports it — the failure is a wrong post served silently. RESERVED
 * is derived with Object.keys, so the set and the table are the same tokens by construction.
 *
 * THE ROWS ARE `readonly` AND ROUTE() HANDS OUT A COPY (2026-07-26). Hoisting the rows here turned
 * what every ambiguity() arm used to return — a fresh array literal per call — into module-level state
 * SHARED by reference with whoever gets the Route, so a consumer that sorted, pushed or spliced its
 * `candidates` would permanently rewrite the routing table for the life of the isolate: every later
 * /settings on that isolate offering a different chooser, on a Worker that auto-deploys to the apex.
 * No consumer does today (render/index.ts and renderChooser only map), and that is precisely the kind
 * of fact that changes without anyone thinking about this file. `readonly` makes handing a row out
 * directly a compile error; route()'s spread is the one place the copy is made.
 */
const AMBIGUOUS: Record<string, readonly Platform[]> = {
  settings: ['x', 'bs', 'rd'],
  search: ['x', 'tt', 'bs', 'rd'],
  explore: ['x', 'ig', 'tt'],
  messages: ['x', 'bs', 'rd'],
  notifications: ['x', 'bs', 'rd'],
  hashtag: ['x', 'bs'],
  followers: ['x', 'ig'],
  following: ['x', 'ig'],
  i: ['x', 'ig'],
  lists: ['x', 'ig'],
  bookmarks: ['x', 'ig'],
  moments: ['x', 'ig'],
  // Imgur joined this row when albums shipped. imgur.com/gallery/{id} is one of the commonest Imgur
  // links there is, and it used to reach nothing at all — the chooser offered Reddit and Instagram
  // and neither could resolve it. Adding a third candidate is additive: no existing link changes
  // meaning, and the person who pasted an Imgur gallery is finally offered Imgur. See imgur().
  gallery: ['rd', 'ig', 'im'],
}
const RESERVED = new Set(Object.keys(AMBIGUOUS))

/**
 * Does this SEGMENT spell a token the ambiguity table reserves? Asked by the yt-dlp tier before it
 * accepts a segment as an id — see AMBIGUOUS.
 *
 * TOKEN-LEVEL, NOT POSITION-LEVEL, and that is the deliberately conservative reading: only
 * 'followers' and 'following' are reachable today (they are the only rows that sit at the depth these
 * matchers read), but refusing every named token costs nothing real — a reserved word is never a
 * plausible random id on any of these three platforms, and refusing one restores the honest notfound
 * that path had before the tier existed — while a position-aware version would have to be re-derived
 * every time a row moves.
 */
const reserved = (segment: string): boolean => RESERVED.has(segment)

/** A yt-dlp-tier id: the right SHAPE, and not a token the ambiguity table has already spoken for. */
const ytdlpId = (re: RegExp, segment: string): boolean => re.test(segment) && !reserved(segment)

/**
 * Genuinely undecidable paths. We never guess: a guess serves the wrong post and
 * nobody notices, which is the one failure mode we cannot debug.
 *
 * RETURNS A `readonly` ROW, which is how the shared AMBIGUOUS rows stay shared: the copy is made once,
 * at route()'s single ambiguous return. See AMBIGUOUS.
 */
function ambiguity(seg: string[]): readonly Platform[] | null {
  const [a, b] = seg
  if (a === 'settings') return AMBIGUOUS.settings // /settings and /settings/*
  if (seg.length === 1) {
    if (a === 'search' || a === 'explore' || a === 'messages' || a === 'notifications') return AMBIGUOUS[a]
    // Only TikTok and Threads put '@' in a profile URL; x.com/@user and instagram.com/@user
    // are not real links, so offering them in a chooser is offering two dead ends. There is
    // no profile Route kind, so this can only ever be a chooser — never a fetch.
    //
    // The length guard mirrors tiktok()'s `seg[0].length > 1`: a bare '@' names no profile
    // anywhere, so it is not an @-profile and falls to the generic row below. The two '@'
    // rules live in different functions and nothing but this comment ties them together.
    if (a.startsWith('@') && a.length > 1) return ['tt', 'th']
    return ['x', 'ig'] // bare /{username}: X and Instagram both mint these
  }
  if (seg.length === 2) {
    if (a === 'hashtag') return AMBIGUOUS.hashtag
    if (b === 'followers' || b === 'following') return AMBIGUOUS[b]
    // @i is a live Instagram account and IG's depth-2 fallback renders its profile.
    if (a === 'i' && (b === 'lists' || b === 'bookmarks' || b === 'moments')) return AMBIGUOUS.i
    // @gallery is a live Instagram account, so Reddit's /gallery/{id} is contested.
    if (a === 'gallery') return AMBIGUOUS.gallery
  }
  return null
}

function bluesky(seg: string[]): Route | null {
  // bsky.app/profile/{handle}/post/{rkey} — depth 4, unconditionally safe.
  if (seg.length === 4 && seg[0] === 'profile' && seg[2] === 'post' && seg[1] && seg[3]) {
    const ref: PostRef = { p: 'bs', handle: seg[1], rkey: seg[3] }
    return { kind: 'post', ref, canonical: canonical(`https://bsky.app/profile/${seg[1]}/post/${seg[3]}`) }
  }
  return null
}

function x(seg: string[]): Route | null {
  // /i/web/status/{id} — check before the generic form, which would also match.
  if (seg.length === 4 && seg[0] === 'i' && seg[1] === 'web' && seg[2] === 'status' && seg[3]) {
    return { kind: 'post', ref: { p: 'x', id: seg[3] }, canonical: canonical(`https://x.com/i/web/status/${seg[3]}`) }
  }
  // /{handle}/status/{id} and /i/status/{id} — depth 3+, safe by the depth rule.
  // Trailing /photo/N and /video/N are UI hints, not identity: same post, same ref.
  if (seg.length >= 3 && seg[1] === 'status' && seg[0] && seg[2]) {
    return { kind: 'post', ref: { p: 'x', id: seg[2] }, canonical: canonical(`https://x.com/${seg[0]}/status/${seg[2]}`) }
  }
  return null
}

/**
 * TikTok post permalinks. Depth 3, unconditionally safe by the spec's depth rule —
 * Instagram 404s at depth 3 — and the leading '@' is a second, independent marker
 * (reddit.com/@spez 404s).
 *
 * `video` vs `photo` is a UI distinction, not identity: both mint the same numeric id and
 * both must produce the SAME ref, so refKey collapses every spelling of one post onto one
 * cache entry and one /_media/ namespace. Segment 2 is also the entire discriminator against
 * Threads' /@{user}/post/{code} at the same depth — so match it exactly, never loosely.
 *
 * canonical keeps the user segment the caller gave us, because that is where worker.ts 302s
 * a human. The normalizer rebuilds its own canonical from the payload instead (it only has
 * the ref), which is why /@i/video/{id} resolving without a username is load-bearing there.
 *
 * SHORT LINKS (/t/{code}) ARE NOT HERE, and never will be. route() is synchronous, so a short
 * code cannot become a PostRef in this function — it is not a post id and pretending otherwise
 * would be guessing against Threads, which mints the same shape. They get their own Route kind
 * instead, resolved asynchronously in worker.ts.
 */
function tiktok(seg: string[]): Route | null {
  if (seg.length === 3 && seg[0].startsWith('@') && seg[0].length > 1 && seg[2]) {
    if (seg[1] !== 'video' && seg[1] !== 'photo') return null
    return {
      kind: 'post',
      ref: { p: 'tt', id: seg[2] },
      canonical: canonical(`https://www.tiktok.com/${seg[0]}/${seg[1]}/${seg[2]}`),
    }
  }
  return null
}

/**
 * Instagram post permalinks.
 *
 * ONE REF FOR EVERY SURFACE. /p/, /reel/, /reels/ and /tv/ are four spellings of one post —
 * verified 2026-07-19: /p/{code}/embed/captioned/ and /reel/{code}/embed/captioned/ return
 * byte-identical payloads. So they all mint `kind: 'p'`, and refKey collapses them onto one
 * cache entry and one /_media/ namespace. Un-collapsed, pasting a reel two ways costs two
 * upstream fetches on the platform we rate most fragile.
 *
 * NO TYPE CHANGE. PostRef's ig arm already declares kind 'p'|'reel'|'tv', and parseRefKey still
 * ACCEPTS ig:reel: and ig:tv: keys. That allowlist is kept, but be honest about WHY: it is NOT
 * protecting existing /_media/ URLs. No router before this one ever MINTED an ig ref — verified
 * across every commit reachable from this one, the only `p: 'ig'` construction sites were inside
 * parseRefKey itself, i.e. reading, never writing — so the set of ig:reel: URLs in the wild is
 * provably empty. It stays because it costs nothing and deleting it would be churn. If such keys
 * ever DID exist they would be a liability rather than an asset: postCacheKey is
 * `post:${refKey(ref)}`, so a legacy ig:reel:ABC would cache separately from ig:p:ABC — the
 * exact split this matcher exists to remove.
 *
 * THE SURFACE IS NOT LOST, IT MOVES. `canonical` here keeps the caller's spelling, because that
 * is where worker.ts 302s a human and they should land on what they pasted. normalizeInstagram
 * rebuilds its own canonical from the PAYLOAD (it has only the ref), picking /reel/ or /p/ from
 * evidence — the same split TikTok uses.
 *
 * DEPTH 2 IS SAFE HERE SPECIFICALLY. The spec's depth rule warns that depth 2 is safe only while
 * segment 1 is not a live Instagram username — but these ARE Instagram's own routes, so
 * segment-1 shadowing is moot by construction (spec §Routing). This is why the ambiguity table
 * needs no new row, and it is the one place that argument holds.
 *
 * THE DEPTH-3 ARM REFUSES AN '@' USER. Instagram never puts '@' in a path; TikTok and Threads do,
 * and /@{user}/… at depth 3 is theirs. Refusing it is a shape match, not a guess, and it keeps
 * the two families from reaching into each other.
 *
 * IT ALSO REFUSES ANY TOKEN route() HAS ALREADY SPOKEN FOR — see IG_NOT_A_USER, which is the
 * whole reason that set exists.
 *
 * STORIES ARE DELIBERATELY ABSENT. There is no story equivalent of /embed/captioned/, stories
 * expire in 24h, and they are the one IG shape that is plausibly private — all three are reasons
 * of a different kind, and any one of them is enough. 'stories' stays in KNOWN, and the depth-3
 * arm declines it directly, because KNOWN alone cannot defend it (see IG_NOT_A_USER).
 */
const IG_SURFACE = new Set(['p', 'reel', 'reels', 'tv'])

/**
 * Root tokens route() DEAD-ENDS, hoisted to module scope so instagram() can refuse to reach
 * past them. Reddit's and Threads' post shapes land in their own phases; until then those paths
 * are notfound — honest — but must never be *guessed* into a platform.
 *
 * 't' is NOT here: the shortlink branch claims it, and shortlink() runs above this set.
 *
 * 'p', 'reel', 'reels' and 'tv' ARE here, and the reason is the opposite of the intuition. They
 * look like they should leave once instagram() claims them, the way 't' left for short links —
 * but route() consults this set AFTER matchPost, so /p/{code} and /{user}/p/{code} are claimed
 * long before it is reached and REMOVING them enables no route at all. Verified by mutation over
 * 81,227 paths: the only behaviour the removal changed was the four BARE tokens at depth 1,
 * which stopped being notfound and became the generic ['x','ig'] profile chooser — a page that
 * tells a human instagram.com/reel is a valid link when this matcher's own premise is that
 * /reel/ is Instagram's ROUTE PREFIX and cannot be a profile. 'comments', 'stories' and 'r' are
 * all plausible Twitter handles too, and they dead-end here for exactly the same reason.
 */
const KNOWN = new Set(['comments', 'stories', 'r', 'p', 'reel', 'reels', 'tv'])

/**
 * Segment-0 tokens instagram()'s depth-3 arm refuses in its USERNAME position, because route()
 * has already spoken for them BELOW matchPost and would never get the chance to.
 *
 * THIS IS AN ORDERING DEFENCE, and it cannot be delegated. route() runs matchPost FIRST — that
 * ordering is deliberate and load-bearing (dead-ending a token that is also a real permalink is
 * the defect fixed twice already, for /x/status/123 and @api). The cost of running first is that
 * a matcher which accepts an arbitrary segment can reach past every table below it, so the
 * matcher has to decline those tokens itself. Two measured cases, both live before this set:
 *
 *   /settings/{surface}/{code}  ambiguity()'s settings row is DEPTH-INDEPENDENT — it sits above
 *                               the length branches precisely so it fires at every depth — yet
 *                               the depth-3 arm consumed 'settings' as a username and 302'd a
 *                               human to instagram.com/settings/p/ABC. That is a GUESS on a path
 *                               the table declares undecidable, which ambiguity()'s own docstring
 *                               forbids in as many words.
 *   /stories/{surface}/{id}     Instagram's story URL is /stories/{username}/{id}, so for the
 *                               four handles @p, @reel, @reels and @tv the arm matched and minted
 *                               a POST ref whose `code` was really a 19-digit story id — against
 *                               the one shape this file spends a paragraph declaring out of
 *                               scope. /r/ and /comments/ fell the same way.
 *
 * Nothing is lost by declining: none of these is a real Instagram username, so none of the URLs
 * this refuses could have resolved upstream anyway. KNOWN is spread rather than re-listed so the
 * two cannot drift; 'settings' is added by hand because it is ambiguity()'s row, not a dead end.
 */
const IG_NOT_A_USER = new Set([...KNOWN, 'settings'])

/**
 * Threads post permalinks: `/@{user}/post/{shortcode}`, depth 3. Two independent markers keep it
 * disjoint from its neighbours at the same depth: the leading '@' (which instagram() explicitly
 * refuses in its username position) and the `post` segment (which is TikTok's discriminator against
 * exactly this shape — tiktok() matches only `video`/`photo` at seg[1], never loosely). So the two
 * @-families cannot reach into each other.
 *
 * The ref carries ONLY the shortcode: the username is decoration, `/@i/post/{code}` resolves the
 * same post (verified 2026-07-21), and normalizeThreads rebuilds the real canonical from og:title —
 * the same "normalizer owns its canonical" split TikTok and Instagram use. `canonical` here keeps
 * the caller's spelling, because that is where worker.ts 302s a human.
 *
 * SHORT LINKS (/t/{code}) ARE NOT HERE. Threads mints them too and they are byte-shape-identical to
 * TikTok's, so a synchronous matcher cannot tell them apart — they stay the ['tt','th'] chooser
 * until a resolver claims them, exactly as the shortlink() docstring describes.
 */
function threads(seg: string[]): Route | null {
  if (seg.length === 3 && seg[0].startsWith('@') && seg[0].length > 1 && seg[1] === 'post' && seg[2]) {
    return {
      kind: 'post',
      ref: { p: 'th', code: seg[2] },
      canonical: canonical(`https://www.threads.com/${seg[0]}/post/${seg[2]}`),
    }
  }
  return null
}

/**
 * Reddit post permalinks. `seg[0]` is the marker — 'r' (a subreddit post), 'user'/'u' (a profile
 * post), or a bare 'comments' link — and 'comments' at seg[2] is the second, so a subreddit LISTING
 * (`/r/{sub}`, no comments segment) correctly falls through to notfound rather than being fetched as
 * a post. The trailing slug and any comment-id below the post id are UI decoration, dropped here.
 *
 * The subreddit is CARRIED when the URL names it and left empty otherwise (a bare /comments/{id} or a
 * /user/ post): `oauth.reddit.com/comments/{id}` resolves by id alone, and normalizeReddit recovers
 * the real subreddit from the payload — the same "the ref need not carry what the payload holds" split
 * the other platforms use.
 *
 * 'r' and 'comments' are in the KNOWN dead-end set, and this matcher runs (via matchPost) ABOVE that
 * check, so /r/{sub}/comments/{id} is claimed before 'r' can dead-end it — exactly how instagram()'s
 * /p/{code} survives 'p' being KNOWN. The mobile app's /s/ SHARE links resolve the same way: claimed
 * here as a 'redditshare' Route (an opaque code the worker resolves via a redirect) before 'r' can
 * dead-end them. The other short forms (redd.it, /gallery/) still land in a later commit; until then
 * they are an honest notfound, never a guess.
 */
function reddit(seg: string[]): Route | null {
  const post = (sub: string, id: string, href: string): Route =>
    ({ kind: 'post', ref: { p: 'rd', sub, id }, canonical: canonical(href) })
  const share = (sub: string, code: string, href: string): Route =>
    ({ kind: 'redditshare', sub, code, canonical: canonical(href) })
  if (seg.length >= 4 && seg[0] === 'r' && seg[2] === 'comments' && seg[1] && seg[3]) {
    return post(seg[1], seg[3], `https://www.reddit.com/r/${seg[1]}/comments/${seg[3]}`)
  }
  if (seg.length >= 4 && (seg[0] === 'user' || seg[0] === 'u') && seg[2] === 'comments' && seg[1] && seg[3]) {
    return post('', seg[3], `https://www.reddit.com/${seg[0]}/${seg[1]}/comments/${seg[3]}`)
  }
  if (seg.length === 2 && seg[0] === 'comments' && seg[1]) {
    return post('', seg[1], `https://www.reddit.com/comments/${seg[1]}`)
  }
  // /r/{sub}/s/{code} and /{user|u}/{name}/s/{code} — the "copy link" the Reddit app hands out. The
  // {code} is an opaque share token, so this cannot become a post ref here; it is resolved by a 301
  // hop in the worker. EXACTLY length 4 with 's' at seg[2]: a /r/{sub} listing (length 2/3) still
  // falls through to notfound, and a real post id is never a single 's'.
  if (seg.length === 4 && seg[0] === 'r' && seg[2] === 's' && seg[1] && seg[3]) {
    return share(seg[1], seg[3], `https://www.reddit.com/r/${seg[1]}/s/${seg[3]}`)
  }
  if (seg.length === 4 && (seg[0] === 'user' || seg[0] === 'u') && seg[2] === 's' && seg[1] && seg[3]) {
    return share('', seg[3], `https://www.reddit.com/${seg[0]}/${seg[1]}/s/${seg[3]}`)
  }
  return null
}

function instagram(seg: string[]): Route | null {
  // /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}
  if (seg.length === 2 && IG_SURFACE.has(seg[0]) && seg[1]) {
    return {
      kind: 'post',
      ref: { p: 'ig', kind: 'p', code: seg[1] },
      canonical: canonical(`https://www.instagram.com/${seg[0]}/${seg[1]}/`),
    }
  }
  // /{user}/p/{code} and friends. Exactly depth 3: Instagram has no trailing UI segment the way
  // X has /photo/N, so a fourth segment means this is not an Instagram permalink at all.
  if (
    seg.length === 3 && seg[0] && !seg[0].startsWith('@') && !IG_NOT_A_USER.has(seg[0]) &&
    IG_SURFACE.has(seg[1]) && seg[2]
  ) {
    return {
      kind: 'post',
      ref: { p: 'ig', kind: 'p', code: seg[2] },
      canonical: canonical(`https://www.instagram.com/${seg[0]}/${seg[1]}/${seg[2]}/`),
    }
  }
  return null
}

/** YouTube's 11-char video id — the whole identity; watch / shorts / embed / live all reduce to it. */
const YT_ID = /^[A-Za-z0-9_-]{11}$/
const ytPost = (id: string): Route =>
  ({ kind: 'post', ref: { p: 'yt', id }, canonical: canonical(`https://www.youtube.com/watch?v=${id}`) })
const YT_SURFACE = new Set(['shorts', 'embed', 'live', 'v'])

/**
 * YouTube PATHNAME forms: /shorts/{id}, /embed/{id}, /live/{id}, /v/{id}, and the bare /{id} that a
 * youtu.be short link maps to. The /watch?v={id} form is query-based and handled in route() itself,
 * where url.searchParams is in scope. The id is validated to EXACTLY 11 url-safe chars, which is what
 * makes the bare form safe: the only thing a bare /{11-char} otherwise means is a PROFILE on x/ig — a
 * shape we do not render (it dead-ends in the ambiguity chooser), so claiming it for YouTube trades a
 * dead end for a working video. A bare handle of any other length is untouched and still chooses.
 * 'shorts'/'embed'/'live'/'v' stay free for every other use (they are not 11-char ids).
 */
function youtube(seg: string[]): Route | null {
  if (seg.length === 2 && YT_SURFACE.has(seg[0]) && YT_ID.test(seg[1])) return ytPost(seg[1])
  if (seg.length === 1 && YT_ID.test(seg[0])) return ytPost(seg[0])
  return null
}

/**
 * Facebook video ids are LONG DIGIT strings (15-17 typically) — that shape is what disambiguates the two
 * forms Facebook shares with other platforms: /watch?v={id} (YouTube's id is exactly 11 url-safe chars,
 * checked first in route(); a long numeric v is Facebook's) and /reel/{id} (Instagram's reel code carries
 * letters; an all-numeric reel is Facebook's, and facebook() runs BEFORE instagram() in the chain so it
 * claims the numeric ones). Share links (/share/v|r/{code}) and /{page}/videos/{id} are unambiguous.
 */
const FB_NUM = /^\d{5,}$/
const FB_CODE = /^[A-Za-z0-9]{5,}$/
/**
 * A BARE META SHARE CODE, either platform's. Wider than FB_CODE by exactly the characters Threads
 * uses and Facebook does not: the reported `_pqHlzmHj` leads with an underscore, which FB_CODE
 * refuses — so before this the two codes for ONE post took two different paths, one to Facebook and
 * one to notfound. Bounded and free of separators, because the value is interpolated into a url this
 * Worker then fetches.
 */
const SHARE_CODE = /^[A-Za-z0-9_-]{5,64}$/
/**
 * A FACEBOOK POST ID: a numeric id, or the modern `pfbid…` opaque form Facebook now emits in its own
 * share menu. Both name one post; which one you get depends on where you copied the link from.
 */
const FB_POST_ID = /^(?:\d{5,}|pfbid[A-Za-z0-9]{10,})$/
/**
 * THE OWNER SEGMENT — a numeric page/profile id or a Facebook vanity name.
 *
 * Facebook vanities allow letters, digits and PERIODS, and NOT underscores, which is what makes the
 * composite `{owner}_{post}` id below unambiguous to split — the same argument the group ref already
 * relies on.
 */
const FB_OWNER = /^[A-Za-z0-9.]{3,}$/

type FbKind = 'watch' | 'reel' | 'share' | 'group' | 'post' | 'photo'

function fbCanonical(kind: FbKind, id: string): string {
  if (kind === 'photo') {
    /**
     * The `/photo/?fbid={id}` spelling, which is the one of the six that needs NOTHING but the fbid —
     * no owner, no album, no `set`. Measured 2026-08-11 from Cloudflare egress: handed to Meta's embed
     * plugin it returns the same 74 KB fragment as the owner-bearing spellings, so rebuilding this one
     * loses nothing and gives the two query forms (which carry no owner) something to rebuild INTO.
     * Facebook emits this spelling itself — it is what the page's own JSON links a picture by.
     */
    return `https://www.facebook.com/photo/?fbid=${id}`
  }
  if (kind === 'post') {
    // The /{owner}/posts/{id}/ spelling, which is what Facebook's OWN og:url uses — so a card and the
    // page it came from agree, and the three routable spellings converge on one cache entry.
    const half = id.split('_')
    return `https://www.facebook.com/${half[0]}/posts/${half[1]}/`
  }
  if (kind === 'group') {
    // `{groupId}_{postId}` -> always the /posts/ spelling, which is what Facebook's own share code
    // resolves to. The /permalink/ spelling routes to the same ref, so both converge on one entry.
    const half = id.split('_')
    return `https://www.facebook.com/groups/${half[0]}/posts/${half[1]}/`
  }
  return kind === 'reel' ? `https://www.facebook.com/reel/${id}`
    : kind === 'share' ? `https://www.facebook.com/share/v/${id}`
      : `https://www.facebook.com/watch/?v=${id}`
}
const fbPost = (kind: FbKind, id: string): Route =>
  ({ kind: 'post', ref: { p: 'fb', kind, id }, canonical: canonical(fbCanonical(kind, id)) })

function facebook(seg: string[]): Route | null {
  /**
   * A GROUP POST — `/groups/{gid}/permalink/{pid}/` and `/groups/{gid}/posts/{pid}/`, both spellings
   * Facebook itself emits for one post.
   *
   * Reported 2026-07-30 as a plain "Not found": neither shape was routed at all, while the SHARE code
   * for the very same post (`/share/p/Fixture01X/`) resolved fine. So the post was reachable and the
   * permalink a human actually copies out of the address bar was not — the worst way round.
   *
   * ONE REF FOR BOTH SPELLINGS. The id is the composite `{gid}_{pid}` (see the PostRef arm), and
   * fbCanonical always rebuilds the `/posts/` form — which is exactly what Facebook's own share
   * resolution lands on — so the two urls converge on one cache entry instead of racing each other.
   *
   * BOTH SEGMENTS MUST BE NUMERIC, and that is what keeps this off every other /groups/ url: a group
   * HOME page (/groups/{gid}) and its /members, /media and /about tabs all fail the depth-4 shape,
   * and a NAMED group (/groups/somename/posts/…) fails FB_NUM at seg[1].
   */
  if (seg.length === 4 && seg[0] === 'groups' && FB_NUM.test(seg[1])
    && (seg[2] === 'permalink' || seg[2] === 'posts') && FB_NUM.test(seg[3])) {
    return fbPost('group', `${seg[1]}_${seg[3]}`)
  }
  /**
   * THE ORDINARY POST PERMALINK — the link a human copies out of the address bar, and the shape
   * Facebook's own share resolution lands on. Reported 2026-08-01 as a plain "Not found" for
   * /{ownerId}/posts/{pfbid…}, alongside /story.php answering with the AMBIGUOUS CHOOSER offering
   * x.com and instagram.com — for a Facebook url. Both were the same hole: nothing here claimed a
   * post permalink at all, only the video shapes.
   *
   * TWO DEPTHS, because Facebook emits both: the bare /{owner}/posts/{id} and its own og:url form
   * /{owner}/posts/{slug}/{id}/ with a human-readable slug in the middle. Both name one post and both
   * mint the same ref, so they converge on one cache entry rather than racing.
   *
   * `groups` IS EXCLUDED at seg[0] so this cannot shadow the group arm above, which owns a different
   * shape at a different depth and must keep its own ref kind.
   *
   * THE RESERVATION THIS MAKES, stated rather than discovered later: it claims a WILDCARD first
   * segment followed by the literal 'posts'. Checked against the chain — Bluesky uses
   * /profile/{h}/post/{rkey} and Threads /@user/post/{id}, both SINGULAR and both differently shaped;
   * Lemmy's is /post/{id} at seg[0]. Nothing else claims /{x}/posts/{y}.
   */
  if (seg.length === 3 && seg[0] !== 'groups' && seg[1] === 'posts'
    && FB_OWNER.test(seg[0]) && FB_POST_ID.test(seg[2])) {
    return fbPost('post', `${seg[0]}_${seg[2]}`)
  }
  if (seg.length === 4 && seg[0] !== 'groups' && seg[1] === 'posts'
    && FB_OWNER.test(seg[0]) && FB_POST_ID.test(seg[3])) {
    return fbPost('post', `${seg[0]}_${seg[3]}`)
  }
  /**
   * A PHOTO PERMALINK — the link you get by clicking a picture and copying the address bar, and it
   * was `notfound` at every path spelling until 2026-08-11.
   *
   * TWO DEPTHS, because Facebook emits three shapes and they differ only in a middle segment it does
   * not need: /{owner}/photos/{fbid}/, /{owner}/photos/{album-or-post}/{fbid}/ (the middle reads
   * `a.{albumId}` or `pcb.{postId}`) and /{owner}/photos/{human-slug}/{fbid}/, which is the one
   * Facebook's own share menu hands out. THE LAST SEGMENT IS THE fbid IN ALL THREE, so the middle is
   * matched but not read — reading it would mean deciding which of the three it is, and nothing
   * downstream wants the answer.
   *
   * THE MIDDLE IS NOT SHAPE-CHECKED, deliberately. It is a slug in one spelling and a dotted id in
   * the others; a pattern loose enough for both is `.+`, and pretending otherwise would refuse the
   * slug form, which is exactly the one a human pastes.
   *
   * SHADOWING, measured rather than argued — route() run over 36,521 paths built from every token
   * this file names (each AMBIGUOUS key, each KNOWN member, IG_SURFACE, YT_SURFACE, the escape
   * hatches, '@user', a fediverse host and real page names) crossed with sixteen id shapes at both
   * depths, before and after this arm:
   *
   *   'photo' SINGULAR IS TIKTOK'S. /@{user}/photo/{id} is a live TikTok photo post — 32 of them in
   *   the sweep resolve to a tt ref today — and tiktok() runs BEFORE facebook() anyway. This arm
   *   requires the PLURAL, which no other matcher reads at any depth.
   *
   *   /settings/photos/… STAYS THE CHOOSER. 'settings' is ambiguous at EVERY depth (ambiguity()'s
   *   first line), and FB_OWNER would otherwise have swallowed 448 of those paths — the same defect
   *   the file already records for /settings/{surface}/{code} and for the yt-dlp tier eating
   *   'followers'. `reserved()` is the existing guard and is what refuses them.
   *
   *   NOTHING ELSE CLAIMED A 'photos' SEGMENT. In the whole sweep, before this arm, every path with
   *   'photos' at seg[1] was notfound except the /settings rows: x() needs 'status', reddit()
   *   'comments'/'s', bluesky() 'profile' + 'post', tiktok() and threads() a leading '@',
   *   youtube()'s surfaces are 'shorts'/'embed'/'live'/'v', instagram()'s are 'p'/'reel'/'reels'/'tv'
   *   and twitch()'s is 'clip'. 'photos' is in none of those sets.
   *
   * `groups` IS EXCLUDED at seg[0] for the same reason the post arm excludes it — /groups/… is a
   * different Facebook surface with its own ref kind, and no page is named `groups`.
   */
  if (seg.length === 3 && seg[1] === 'photos' && seg[0] !== 'groups'
    && FB_OWNER.test(seg[0]) && !reserved(seg[0]) && FB_NUM.test(seg[2])) {
    return fbPost('photo', seg[2])
  }
  if (seg.length === 4 && seg[1] === 'photos' && seg[0] !== 'groups'
    && FB_OWNER.test(seg[0]) && !reserved(seg[0]) && seg[2] && FB_NUM.test(seg[3])) {
    return fbPost('photo', seg[3])
  }
  // /reel/{numeric-id} — a NUMERIC reel is Facebook's; instagram() claims the alphanumeric ones after us.
  if (seg.length === 2 && seg[0] === 'reel' && FB_NUM.test(seg[1])) return fbPost('reel', seg[1])
  /**
   * THE SHARE LINK, all four spellings. Facebook's share sheet emits a BARE /share/{code} as well as
   * the typed /share/{v|r|p}/{code}, and the code is OPAQUE in every one of them — only the 302 knows
   * what it names. yt-dlp follows that redirect for us, so one ref shape serves all four.
   *
   * THE BARE FORM WAS notfound UNTIL NOW, which is the bug this fixes (reported 2026-07-26 on
   * /share/Fixture02X/). Because the code is opaque, refusing the bare form refused the VIDEOS too:
   * measured the same day, https://www.facebook.com/share/Fixture03X/ 302s to /reel/2209468366484962/
   * and yt-dlp extracts it cleanly (150.209s mp4, "Are you 'Disturbed' | PhillyBanana"). That link
   * differs from a working one ONLY by the absent /v/ segment. Serving the ones we can and failing
   * honestly on the rest beats refusing all of them sight-unseen.
   *
   * /share/p/ IS FACEBOOK'S, AND IT WAS GOING TO INSTAGRAM — a second, quieter defect found while
   * fixing the first. instagram()'s depth-3 arm matches /{user}/p/{code} and nothing stopped it
   * treating the literal 'share' as a username, so a Facebook post-share minted an ig ref and fetched
   * a nonexistent Instagram shortcode. facebook() runs BEFORE instagram() in matchPost, so naming the
   * segment here is the whole fix — no IG_NOT_A_USER entry needed, and none added, because the
   * ordering is what the chain already guarantees. The trade it makes, stated rather than discovered
   * later: an Instagram account literally named @share could no longer have its /share/p/{code}
   * permalink resolved. 'share' is not a registerable Instagram handle, and Facebook's /share/p/ is a
   * form the share sheet emits constantly, so this is the right way round — but it IS a reservation.
   * Measured for shadowing over the neighbouring shapes: /share/status/{id} still routes to Twitter
   * (x() precedes facebook(), and the depth-3 arm below only accepts v/r/p at seg[1]), and /share/{x}
   * shorter than FB_CODE's five characters stays notfound.
   *
   * NOT EVERY SHARE CODE RESOLVES TO SOMETHING WE CAN RENDER, and that is accepted rather than hidden:
   * /share/Fixture02X/ is a TEXT POST (302 -> /61570486943885/posts/122206281458682898/), we have no
   * Facebook post extraction, and yt-dlp answers "Cannot parse data" — so it stays a failure card. It
   * is now an honest extraction failure instead of a routing hole, which is the difference between "we
   * cannot read this post" and "that URL means nothing to us".
   */
  /**
   * THE BARE FORM IS NO LONGER CLAIMED FOR FACEBOOK — it is a 'metashare', resolved by asking.
   *
   * Threads mints the SAME `/share/{code}` shape, and this arm used to swallow it: a Threads token
   * was 302'd to facebook.com (reported 2026-07-30, live in production). The reporter's other code
   * escaped only because a leading underscore fails FB_CODE, which is luck rather than a guard.
   *
   * The TYPED forms below (/share/v|r|p/{code}) stay Facebook's — those name the platform. Only the
   * bare one is ambiguous, and only the bare one is resolved.
   */
  if (seg.length === 2 && seg[0] === 'share' && SHARE_CODE.test(seg[1])) {
    return {
      kind: 'metashare',
      code: seg[1],
      // Through canonical() for the same reason the shortlink route is: this becomes a Location
      // header, and a decoded segment can carry a CR/LF that makes `new Headers` throw.
      canonical: canonical(`https://www.threads.com/share/${seg[1]}`),
    }
  }
  if (
    seg.length === 3 && seg[0] === 'share' &&
    (seg[1] === 'v' || seg[1] === 'r' || seg[1] === 'p') && FB_CODE.test(seg[2])
  ) {
    return fbPost('share', seg[2])
  }
  // /{page}/videos/{id} — the classic page-video permalink; equivalent to watch?v={id}.
  if (seg.length === 3 && seg[1] === 'videos' && FB_NUM.test(seg[2]) && seg[0]) return fbPost('watch', seg[2])
  return null
}

/**
 * THE yt-dlp TIER — Dailymotion, Streamable and Imgur. Three matchers rather than one because their
 * shapes are disjoint and naming them separately is what makes each claim arguable on its own.
 *
 * EVERY UNFORCED SHAPE BELOW WAS MEASURED `notfound` BEFORE THIS EXISTED (2026-07-26, by running the
 * real route() over the candidate paths), so nothing is shadowed — with ONE deliberate exception,
 * /{id}.gifv, argued at imgur() itself.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED, each for a measured reason:
 *   bare /{id}         undecidable three ways (route() is host-agnostic, so dai.ly, streamable.com
 *                      and imgur.com all collapse here) and partly pre-owned by youtube()'s bare
 *                      11-char arm. Claiming it would silently serve the wrong post. It stays the
 *                      ['x','ig'] chooser; the /dm//st//im escape hatches are the answer instead.
 *   /gallery/{id}      already the ['rd','ig'] chooser, AND yt-dlp answers it video-OR-playlist
 *                      unpredictably (/gallery/YcAQlkx is a video, /t/unmuted/6lAn9VQ is a playlist)
 *                      — a synchronous matcher cannot tell, and guessing serves a title-only card.
 *   /a/{id}            free, but ALWAYS a playlist: a title and nothing else.
 *   /t/{x}/{id}, /topic/{x}/{id}
 *                      a loose depth-3 matcher here shadows 232 WORKING routes (measured over a
 *                      178,964-path sweep): /topic/status/{id} is a real Twitter permalink by @topic,
 *                      and /topic/reels/{id} and /topic/tv/{id} are real Instagram permalinks by user
 *                      @topic. Low value, high blast radius.
 * The honest consequence, which belongs in front of a reader rather than in a bug report later: a
 * pasted dai.ly, bare streamable.com/{id} or bare imgur.com/{id} link is NOT supported unforced.
 */

/**
 * THE THREE ID SHAPES LIVE IN refkey.ts, and are imported rather than spelled here. parseRefKey has to
 * apply the SAME shape (a refKey reaches it from /_media/ and from the Mastodon-spoof id, neither of
 * which passes through this file), and two copies of one rule is two things to keep in step. See the
 * YTDLP_ID docstring there for why that direction and not this one.
 *
 * EVERY ID POSITION GOES THROUGH ytdlpId(), never a bare `.test()` — the shape alone is not enough, see
 * AMBIGUOUS.
 */
const dmPost = (id: string): Route =>
  ({ kind: 'post', ref: { p: 'dm', id }, canonical: canonical(`https://www.dailymotion.com/video/${id}`) })

/**
 * /video/{id} and /embed/video/{id}. Both notfound today and both structurally safe:
 *  - depth 2 /video/{x}: tiktok() needs depth 3 AND a leading '@'; x() needs seg[1]==='status';
 *    instagram()'s depth-2 arm needs seg[0] in IG_SURFACE; facebook()'s needs seg[0]==='reel';
 *    youtube()'s needs seg[0] in YT_SURFACE. 'video' is in none of those sets.
 *  - depth 3 /embed/video/{x}: 'embed' IS in YT_SURFACE but only at DEPTH 2, which youtube() never
 *    reads at 3; instagram()'s depth-3 arm needs seg[1] in IG_SURFACE and 'video' is not;
 *    tiktok()/threads() both need a leading '@'; reddit() needs 'comments'/'s' at seg[2];
 *    facebook()'s page arm needs seg[1]==='videos', which is not 'video'.
 * The depth-1 arm is FORCED-ONLY — see ESCAPE.
 */
function dailymotion(seg: string[], forced = false): Route | null {
  if (seg.length === 2 && seg[0] === 'video' && ytdlpId(DM_ID, seg[1])) return dmPost(seg[1])
  if (seg.length === 3 && seg[0] === 'embed' && seg[1] === 'video' && ytdlpId(DM_ID, seg[2])) return dmPost(seg[2])
  if (forced && seg.length === 1 && ytdlpId(DM_ID, seg[0])) return dmPost(seg[0])
  return null
}

const stPost = (id: string): Route =>
  ({ kind: 'post', ref: { p: 'st', id }, canonical: canonical(`https://streamable.com/${id}`) })

/**
 * /e/{id} (the embed form) and /s/{id} (the share form). Both notfound today.
 *  - no matcher and no ambiguity() row claims the token 'e' at any depth.
 *  - 's' IS Reddit's share marker, but at seg[2] of a DEPTH-4 path (/r/{sub}/s/{code}); this is 's'
 *    at seg[0] of a depth-2 path, which reddit() never inspects.
 * The depth-1 arm is FORCED-ONLY — see ESCAPE.
 *
 * THE {id} POSITION IS THE ONE IN THIS TIER THAT CAN SWALLOW AN AMBIGUITY ROW, because ST_ID is by far
 * the loosest of the three shapes — 2-16 alnum matches 'followers' and 'following', which are the rows
 * at seg[1] of a depth-2 path, i.e. exactly where /e/{id}, /s/{id} and forced /st/{id} put their id.
 * ytdlpId() is what refuses them; see AMBIGUOUS for the sweep that measured it.
 */
function streamable(seg: string[], forced = false): Route | null {
  if (seg.length === 2 && (seg[0] === 'e' || seg[0] === 's') && ytdlpId(ST_ID, seg[1])) return stPost(seg[1])
  if (forced && seg.length === 1 && ytdlpId(ST_ID, seg[0])) return stPost(seg[0])
  return null
}

/**
 * The canonical differs per surface, which is the whole reason the ref carries a `kind`: 'post' keeps
 * the .gifv page (it is the url the container fetches for an animated single, and it redirects to the
 * still for everything else), while an album and a gallery each have their own permalink.
 */
const IM_CANONICAL: Record<'post' | 'album' | 'gallery', (id: string) => string> = {
  post: id => `https://i.imgur.com/${id}.gifv`,
  album: id => `https://imgur.com/a/${id}`,
  gallery: id => `https://imgur.com/gallery/${id}`,
}

const imPost = (id: string, kind: 'post' | 'album' | 'gallery' = 'post'): Route =>
  ({ kind: 'post', ref: { p: 'im', kind, id }, canonical: canonical(IM_CANONICAL[kind](id)) })

/**
 * /{id}.gifv — i.imgur.com's own video page, and the ONE claim in this tier that takes a path away
 * from something else. Today it is the bare-username ['x','ig'] chooser, which is a DEAD END: there
 * is no profile Route kind, so that page can only ever offer a human two links. Trading a dead end
 * for a working video is the identical argument youtube()'s bare-11-char arm already makes in its own
 * docstring.
 *
 * AND NOTHING THAT COULD RESOLVE IS LOST, which is the part that makes it safe rather than merely
 * net-positive: an X handle is \w{1,15} and cannot contain '.', so no reachable X permalink has this
 * shape; an Instagram username CAN contain '.', but an IG PROFILE is unrenderable here either way.
 *
 * The bare /{id} form (no extension) is FORCED-ONLY — unforced it is undecidable against Dailymotion
 * and Streamable, see the tier docstring.
 *
 * THE .gifv ARM STRIPS THE EXTENSION AND THEN APPLIES IM_ID, rather than re-spelling the id shape
 * inside a second regex — that copy read {5,7} and would have gone on reading {5,7} after the shared
 * one moved. It ALSO does not consult reserved(): the segment the ambiguity table sees here is
 * '{id}.gifv', which the table never names (it is the generic bare-username row), so the row this arm
 * takes is the dead end argued above and not a reserved token. `/search.gifv` is a legal i.imgur.com
 * video url and stays one; `/st/search` is not a Streamable id position we are willing to guess in.
 */
function imgur(seg: string[], forced = false): Route | null {
  if (seg.length === 1) {
    const m = /^(.+)\.gifv$/.exec(seg[0])
    if (m && IM_ID.test(m[1])) return imPost(m[1])
    if (forced && ytdlpId(IM_ID, seg[0])) return imPost(seg[0])
  }
  /**
   * /a/{id} — AN ALBUM, and it costs nothing to claim: `r('/a/…')` was `notfound` before this
   * (pinned in router.test.mjs), 'a' is not an AMBIGUOUS key, and no other matcher reads 'a' at
   * seg[0] of a depth-2 path. Unforced, unlike the bare id, because 'a' names the site in the path
   * the way `/pin/` names Pinterest — nothing else is competing for it.
   *
   * /gallery/{id} — FORCED ONLY, and that is a deliberate refusal rather than an oversight. The
   * unforced row belongs to the ['rd','ig'] chooser, and unlike the bare-username row the .gifv arm
   * took, THIS ONE IS NOT A DEAD END: reddit.com/gallery/{id} and instagram.com/gallery are real
   * destinations a human may have meant. Imgur is ADDED to that chooser's candidates instead (see
   * AMBIGUOUS), so a person pasting an Imgur gallery link now gets offered Imgur — which is strictly
   * more than the nothing they got before — while nobody's Reddit gallery link is silently stolen.
   */
  if (seg.length === 2) {
    if (seg[0] === 'a' && ytdlpId(IM_ID, seg[1])) return imPost(seg[1], 'album')
    if (forced && seg[0] === 'gallery' && ytdlpId(IM_ID, seg[1])) return imPost(seg[1], 'gallery')
  }
  return null
}

/**
 * The {id} segment of the Mastodon-spoof routes back to its PostRef.
 *
 * Exactly TWO steps, and the count is the point: `seg` was already decoded once at the
 * `raw.map(safeDecode)` line, and parseRefKey does the per-component decode after it splits
 * on ':'. A safeDecode HERE would be a third layer and a real bug — refKey percent-encodes
 * each component, so a Bluesky DID handle reaches this function still carrying its own
 * '%3A' escapes, and stripping them early over-splits the key:
 *
 *   decodeStatusId  -> bs:did%3Aplc%3Az72i…:3l6o   -> split(':') = 3 parts -> ref
 *   ...decoded again -> bs:did:plc:z72i…:3l6o      -> split(':') = 5 parts -> NULL
 *
 * That would 404 every Bluesky DID URL, silently. (In practice the id is pure digits and
 * safeDecode is a no-op on it — which is exactly why the bug would survive review and only
 * show up on the DID posts in production.)
 */
/**
 * TWITCH CLIPS. Three shapes, and the third is the one that needed measuring.
 *
 *   /{channel}/clip/{slug}   depth 3, 'clip' at seg[1] — unambiguous, the form twitch.tv puts in the
 *                            address bar. The channel is DECORATION (see the PostRef docstring).
 *   /clip/{slug}             depth 2 — the same permalink with the channel omitted.
 *   /{slug}                  depth 1 — what `clips.twitch.tv/{slug}`, the SHARE BUTTON'S OWN OUTPUT,
 *                            becomes when the host is replaced. Undecidable by POSITION, because a
 *                            bare segment is also every profile url on every other platform. Decided
 *                            by SHAPE, below.
 *
 * THE DEPTH-1 SHAPE GATE IS MEASURED, NOT GUESSED. 697 real slugs, pulled 2026-07-27 from the
 * all-time clips of ten channels (xqc, pokimane, shroud, summit1g, hasanabi, kaicenat, caseoh_,
 * jynxzi, zackrawrr, sodapoppin):
 *
 *   - total length 18..61 — MINIMUM 18, and only one below 21;
 *   - the head (before the first '-') is 15..44 chars, 677/697 pure alpha;
 *   - EVERY ONE of the 697 starts with an uppercase letter, and every head carries at least FOUR
 *     uppercase letters (the generated form is three-or-more CamelCase words);
 *   - charset is [A-Za-z0-9_-]; a dot never appears.
 *
 * WHAT THE GATE CAN SHADOW, stated precisely rather than waved at. A bare /{segment} is today the
 * ['x','ig'] chooser — never a post — so a false positive costs a chooser, not a wrong post, and the
 * "we never guess a post" rule is not in play. Within that:
 *   - A TWITTER HANDLE IS IMPOSSIBLE: Twitter handles are at most 15 characters and this requires 16.
 *   - An INSTAGRAM handle is merely implausible, not impossible, and the difference is deliberate.
 *     Instagram's own signup lowercases usernames, which would make the leading-uppercase requirement
 *     a proof — but that could NOT be verified here (instagram.com answers HTTP 200 for every
 *     username including invented ones, the decoy this project has been burned by three times), so it
 *     is claimed as a likelihood and nothing stronger.
 *   - A TWITCH CHANNEL name cannot match either: logins are lowercase, 4..25 chars.
 *
 * Verified against the corpus: 697/697 accepted, and every one of a hand list of real handles
 * (shamu4life, fixture8.example, Cristiano, BarackObama, MrBeast6000, zackrawrr, …) rejected.
 */
const TW_SLUG = /^[A-Z][A-Za-z0-9]{14,79}(?:-[A-Za-z0-9_-]{4,60})?$/
const twPost = (slug: string, href: string): Route =>
  ({ kind: 'post', ref: { p: 'tw', kind: 'clip', slug }, canonical: canonical(href) })

/** The tight, DEPTH-1-ONLY recogniser. The deeper arms need no shape gate: 'clip' already decides. */
function twitchClipSlug(s: string): boolean {
  if (s.length < 16 || !TW_SLUG.test(s)) return false
  const head = s.split('-')[0]
  let upper = 0
  for (let i = 1; i < head.length; i++) {
    const c = head.charCodeAt(i)
    if (c >= 65 && c <= 90) upper++
  }
  // Four uppercase letters in the head counting the leading one — the minimum observed over 697.
  return upper >= 3
}

/**
 * A SLUG THIS ROUTER MAY MINT A REF FROM. Two independent requirements, and the second is the one a
 * 200,073-path sweep turned up rather than reasoning:
 *
 *  1. TWITCH_SLUG — refkey.ts's shape. The router must never mint a ref that parseRefKey would
 *     REFUSE: refkey.ts's own docstring states the consequence, and it is not cosmetic. Such a ref
 *     routes as a post, fetches, renders — and then every /_media/{refKey}/{i} url on that card
 *     deserializes to null and 404s. A card with a poster and a player that resolve to nothing, with
 *     nothing anywhere reporting it.
 *
 *  2. NOT A TOKEN THE AMBIGUITY TABLE HAS SPOKEN FOR — the rule AMBIGUOUS states and `reserved()`
 *     exists to enforce. Measured: without this, `/clip/followers`, `/clip/following` and 56 paths
 *     under `/settings/clip/…` stopped being the chooser and became Twitch posts. Consuming a token
 *     the table declares undecidable is the defect this file already fixed once for
 *     `/settings/{surface}/{code}`; a second matcher re-committing it is exactly what the shared
 *     helper is here to prevent.
 */
const twSlug = (s: string): boolean => TWITCH_SLUG.test(s) && !reserved(s)

function twitch(seg: string[], forced = false): Route | null {
  // /{channel}/clip/{slug} — the canonical address-bar form. The CHANNEL is checked against the
  // reserved set too: `/settings/clip/{x}` must stay the ['x','bs','rd'] chooser, and a Twitch login
  // spelling a reserved word is both vanishingly unlikely and reachable via /tw/{slug}.
  if (seg.length === 3 && seg[1] === 'clip' && seg[0] && !reserved(seg[0]) && twSlug(seg[2])) {
    return twPost(seg[2], `https://www.twitch.tv/${seg[0]}/clip/${seg[2]}`)
  }
  // /clip/{slug} — the same permalink with the channel omitted. NOT a real Twitch route (measured:
  // twitch.tv/clip/{slug} serves the generic shell), but the slug is globally unique so resolving it
  // costs nothing and being more permissive than Twitch is free. The canonical it mints is therefore
  // the clips.twitch.tv spelling, which DOES resolve, rather than an invented channel segment.
  if (seg.length === 2 && seg[0] === 'clip' && twSlug(seg[1])) {
    return twPost(seg[1], `https://clips.twitch.tv/${seg[1]}`)
  }
  // /{slug} — clips.twitch.tv's own share output. Shape-gated unless the caller FORCED /tw/{slug},
  // which is the user saying which platform they mean and needs no recogniser — but even forced, the
  // refkey shape still binds, for reason 1 above.
  if (seg.length === 1 && twSlug(seg[0]) && (forced || twitchClipSlug(seg[0]))) {
    return twPost(seg[0], `https://clips.twitch.tv/${seg[0]}`)
  }
  return null
}

/**
 * LEMMY — the only matcher here that reads a HOSTNAME out of the path, because the fediverse is not
 * one site and a post id means nothing without the instance that minted it (see the PostRef arm for
 * the ~20% silent-wrong-answer measurement that forced this).
 *
 * TWO SPELLINGS, both cheap:
 *
 *   /{instance}/post/{id}            INSERT our domain in front of the pasted url. The cursor target
 *                                    is a FIXED offset — immediately after `https://` — which is
 *                                    actually an easier edit than the host REPLACEMENT every other
 *                                    platform here uses, since replacement means selecting a
 *                                    variable-length token.
 *   /https://{instance}/post/{id}    PREPEND our domain to the untouched url — one `Home` keypress.
 *                                    `path.split('/').filter(Boolean)` turns this into
 *                                    ['https:', '{instance}', 'post', '{id}'], so it is an ordinary
 *                                    depth-4 shape with an unmistakable leading token. FixBluesky
 *                                    ships exactly this alias on Cloudflare Workers.
 *
 * WHY THIS CANNOT SHADOW ANYTHING, by construction rather than by sweep alone:
 *   - FEDI_HOST requires at least two labels AND an alphabetic final label, so the segment must look
 *     like a real domain. Every IP literal, `localhost`, and every handle without a dot is excluded.
 *   - LEMMY_ID requires a bare integer with no leading zero. Threads' depth-3 /{user}/post/{code}
 *     needs a leading '@' AND carries a base64-ish code, so it is disjoint on both fields.
 *   - Instagram's depth-3 arm requires p/reel/reels/tv at seg[1]; 'post' is not in IG_SURFACE.
 *   - reserved() is consulted, so a token the ambiguity table has spoken for is never consumed —
 *     the rule a 200,073-path sweep caught the Twitch matcher breaking.
 *
 * NO DEFAULT INSTANCE ARM EXISTS, and none should be added. `/post/{id}` with an assumed host is the
 * shape that returns a real-but-different post one time in five.
 */
const lmPost = (host: string, kind: 'post' | 'comment', id: string): Route => ({
  kind: 'post',
  ref: { p: 'lm', host, kind, id },
  canonical: canonical(`https://${host}/${kind}/${id}`),
})

const LM_SURFACE = new Set(['post', 'comment'])

/** Shared by both spellings, so the guard cannot be applied to one and forgotten on the other. */
function lemmyArm(seg: string[]): Route | null {
  // Hostnames are case-insensitive; lowercasing HERE is what stops `Lemmy.World` and `lemmy.world`
  // minting two cache entries for one instance.
  const host = seg[0].toLowerCase()
  if (!FEDI_HOST.test(host) || reserved(seg[0])) return null
  // /{instance}/post/{id} and /{instance}/comment/{id} — Lemmy's own spelling, and the one PieFed
  // also answers.
  if (seg.length === 3 && LM_SURFACE.has(seg[1]) && LEMMY_ID.test(seg[2])) {
    return lmPost(host, seg[1] === 'comment' ? 'comment' : 'post', seg[2])
  }
  /**
   * PIEFED'S CANONICAL SPELLING: `/c/{community}@{instance}/p/{id}/{slug}`. This is what PieFed's own
   * `rel="canonical"` and share button emit, so it is the form a user actually pastes — the bare
   * `/post/{id}` above works on PieFed too, but nothing hands it to them.
   *
   * DEPTH IS >= 4 RATHER THAN EXACT because the trailing slug is required by PieFed itself: measured,
   * the full-slug URL is 200 and truncating the slug 404s. We do not reproduce the slug — only the id
   * is identity, and canonical() below is built from the id form, which PieFed serves happily.
   *
   * The community segment is NOT validated as a host: it is `technology@lemmy.world`, an actor handle
   * whose '@' FEDI_HOST would reject. It is decoration here; seg[0] is the only host we ever fetch.
   */
  if (seg.length >= 5 && seg[1] === 'c' && seg[3] === 'p' && LEMMY_ID.test(seg[4])) {
    return lmPost(host, 'post', seg[4])
  }
  return null
}

function lemmy(seg: string[]): Route | null {
  // /https://{instance}/post/{id} — the prepend alias. http: is accepted as an input SPELLING only;
  // the ref carries the host alone and fetch.ts builds an https url from it, so this cannot downgrade
  // a request to cleartext.
  if (seg.length >= 4 && (seg[0] === 'https:' || seg[0] === 'http:')) return lemmyArm(seg.slice(1))
  return lemmyArm(seg)
}

/**
 * THE MASTODON-API FAMILY — Mastodon, Pleroma, Akkoma, GoToSocial, Pixelfed. Same instance-in-the-path
 * rule as Lemmy above, and the same two spellings (insert, or prepend the whole url).
 *
 * FOUR PERMALINK SHAPES, because the family does not agree on one:
 *
 *   /{host}/@{user}/{id}              Mastodon, and GoToSocial's short form
 *   /{host}/@{user}@{origin}/{id}     Mastodon's spelling for a REMOTE account read locally
 *   /{host}/@{user}/statuses/{id}     GoToSocial's canonical
 *   /{host}/users/{user}/statuses/{id} the ActivityPub-ish form Mastodon also serves
 *   /{host}/notice/{id}               Pleroma and Akkoma
 *
 * THE USER SEGMENT IS NEVER VALIDATED AND NEVER STORED. Verified against a live instance:
 * `/@anything/{id}` 302s to exactly the same status as the true handle, so the username is decoration
 * — the same finding as Pinterest's slug. Validating it would reject real links (handles carry dots,
 * underscores and a second '@') while buying nothing, since only seg[0] is ever fetched.
 *
 * `/objects/{uuid}` IS DELIBERATELY ABSENT. Pleroma serves it, but it addresses an ActivityPub object
 * in a DIFFERENT id space from `/api/v1/statuses/{id}` — routing it would mint refs that always fail
 * the liveness assert, i.e. a shape that looks supported and never works.
 *
 * MISSKEY'S `/notes/{id}` IS ALSO ABSENT, for the same reason at one remove: Misskey and Sharkey do
 * not answer `/api/v1/statuses/{id}` for ids taken from their own permalinks. See the PostRef arm.
 */
/**
 * The username-free permalink, verified: `https://{host}/statuses/{id}` 302s to the same status as
 * the handle form on Mastodon. It is used here because the router does not know the handle yet — only
 * a fetch reveals it — and normalizeMasto replaces this with the handle-bearing url once it does.
 * Pleroma spells its own permalink `/notice/{id}`, so this fallback is Mastodon-shaped rather than
 * universal; it is a pre-fetch placeholder, never the card's canonical.
 */
const msPost = (host: string, id: string): Route => ({
  kind: 'post',
  ref: { p: 'ms', host, id },
  canonical: canonical(`https://${host}/statuses/${id}`),
})

function mastoArm(seg: string[]): Route | null {
  const host = seg[0].toLowerCase()
  if (!FEDI_HOST.test(host) || reserved(seg[0])) return null
  const at = seg[1]?.startsWith('@')
  // /{host}/@{user}/{id}
  if (seg.length === 3 && at && MASTO_ID.test(seg[2])) return msPost(host, seg[2])
  // /{host}/@{user}/statuses/{id} — GoToSocial's canonical, and Mastodon serves it too (verified 200).
  if (seg.length === 4 && at && seg[2] === 'statuses' && MASTO_ID.test(seg[3])) return msPost(host, seg[3])
  // /{host}/users/{user}/statuses/{id} — one segment LONGER, and folding the two into one length test
  // is a bug this file has already made once: the ActivityPub-ish form is depth 5, not 4.
  if (seg.length === 5 && seg[1] === 'users' && seg[3] === 'statuses' && MASTO_ID.test(seg[4])) {
    return msPost(host, seg[4])
  }
  // /{host}/notice/{id} — Pleroma and Akkoma
  if (seg.length === 3 && seg[1] === 'notice' && MASTO_ID.test(seg[2])) return msPost(host, seg[2])
  // /{host}/statuses/{id} — the username-free form Mastodon serves, and the one msPost emits as a
  // pre-fetch canonical. Routing it keeps our own output round-trippable through our own router.
  if (seg.length === 3 && seg[1] === 'statuses' && MASTO_ID.test(seg[2])) return msPost(host, seg[2])
  return null
}

function masto(seg: string[]): Route | null {
  if (seg.length >= 4 && (seg[0] === 'https:' || seg[0] === 'http:')) return mastoArm(seg.slice(1))
  return mastoArm(seg)
}

/**
 * THE MISSKEY FAMILY — Misskey, Sharkey, Iceshrimp. ONE permalink shape, `/{host}/notes/{id}`, and
 * the id in it is verbatim the `noteId` the API takes on all three.
 *
 * IT IS A SEPARATE MATCHER FROM masto() BECAUSE IT IS A SEPARATE API — see the 'mk' PostRef arm for
 * the measurement (Misskey has no Mastodon compat layer at all; Sharkey 2025.4.7's answers only for
 * boosts). Routing `/notes/{id}` into the Mastodon client would mint refs that 404.
 */
const mkPost = (host: string, id: string): Route => ({
  kind: 'post',
  ref: { p: 'mk', host, id },
  canonical: canonical(`https://${host}/notes/${id}`),
})

function misskeyArm(seg: string[]): Route | null {
  if (seg.length !== 3 || seg[1] !== 'notes') return null
  const host = seg[0].toLowerCase()
  if (!FEDI_HOST.test(host) || reserved(seg[0]) || !MASTO_ID.test(seg[2])) return null
  return mkPost(host, seg[2])
}

function misskey(seg: string[]): Route | null {
  if (seg.length >= 4 && (seg[0] === 'https:' || seg[0] === 'http:')) return misskeyArm(seg.slice(1))
  return misskeyArm(seg)
}

/**
 * PEERTUBE. `/{host}/w/{shortUUID}` is what the share button emits; `/{host}/videos/watch/{uuid}` is
 * the older canonical and what `video.url` still carries, so both are routed and both fold to one ref
 * — the API resolves either id (verified byte-identical bodies).
 *
 * `/w/p/{id}` IS A PLAYLIST and is deliberately refused: it names a different object with no single
 * video to embed, and `p` cannot be a video id anyway (PEERTUBE_ID needs 16+ chars), so the guard is
 * structural rather than a special case.
 */
const ptPost = (host: string, id: string): Route => ({
  kind: 'post',
  ref: { p: 'pt', host, id },
  canonical: canonical(`https://${host}/w/${id}`),
})

function peertubeArm(seg: string[]): Route | null {
  const host = seg[0].toLowerCase()
  if (!FEDI_HOST.test(host) || reserved(seg[0])) return null
  // /{host}/w/{id}
  if (seg.length === 3 && seg[1] === 'w' && PEERTUBE_ID.test(seg[2])) return ptPost(host, seg[2])
  // /{host}/videos/watch/{uuid}
  if (seg.length === 4 && seg[1] === 'videos' && seg[2] === 'watch' && PEERTUBE_ID.test(seg[3])) {
    return ptPost(host, seg[3])
  }
  return null
}

function peertube(seg: string[]): Route | null {
  if (seg.length >= 4 && (seg[0] === 'https:' || seg[0] === 'http:')) return peertubeArm(seg.slice(1))
  return peertubeArm(seg)
}

/**
 * PINTEREST PINS. `/pin/{id}/`, and everything else Pinterest mints reduces to it.
 *
 * THE SLUG IS DECORATION, verified rather than assumed: `/pin/{slug}--{id}/` returns the SAME pin for
 * an invented slug, so only the trailing id after the last `--` is identity. Regional domains
 * (pinterest.de, de.pinterest.com, …) need no handling at all — this router never sees a host, and
 * every region serves the same numeric id.
 *
 * `/pin/{id}/sent/` is the "shared with you" spelling and carries `?invite_code=`/`?sender_id=`; the
 * trailing segment is a UI hint, not identity, so it maps to the same ref — the rule x() already
 * applies to `/photo/N`.
 *
 * NOTHING IS SHADOWED: every `/pin/...` shape was notfound before this existed, and `pin` is not a
 * token the ambiguity table names. A bare `/pin` stays the ['x','ig'] chooser it has always been.
 */
const PIN_SLUG_ID = /^(?:.*--)?([1-9][0-9]{4,21})$/
const pnPost = (id: string): Route => ({
  kind: 'post',
  ref: { p: 'pn', id },
  canonical: canonical(`https://www.pinterest.com/pin/${id}/`),
})

/**
 * The trailing UI segments Pinterest actually mints, as an ALLOWLIST rather than "any third segment".
 * A 185,056-path sweep showed the loose version claiming /pin/{id}/post, /pin/{id}/clip,
 * /pin/{id}/comments and every other third segment — the loose-matcher habit matchPost's own comment
 * warns about, where a future platform's shape gets shadowed by a matcher that reads one segment less
 * carefully than it should.
 */
const PIN_TRAILING = new Set(['sent', 'feedback', 'visual-search'])

function pinterest(seg: string[]): Route | null {
  // /pin/{id} and /pin/{slug}--{id}, plus one KNOWN trailing UI segment.
  if (seg.length < 2 || seg.length > 3 || seg[0] !== 'pin' || !seg[1]) return null
  if (seg.length === 3 && !PIN_TRAILING.has(seg[2])) return null
  const m = PIN_SLUG_ID.exec(seg[1])
  return m && PIN_ID.test(m[1]) ? pnPost(m[1]) : null
}

function spoofRef(id: string): PostRef | null {
  const key = decodeStatusId(id)
  return key === null ? null : parseRefKey(key)
}

/**
 * Which spoof endpoint a path SHAPE names, and where its {id} sits — decided WITHOUT
 * looking at whether that id decodes.
 *
 * Splitting shape from decodability is the whole point, and conflating them was a real bug:
 * when a mangled id made the matcher return null, the path fell through to 'notfound' and
 * the worker answered a JSON consumer with the HTML error embed at HTTP 200. The shape is
 * what says "this caller wanted JSON"; the id only says which post it wanted. One source of
 * truth so a future edit cannot drift the two apart.
 *
 *   /api/v1/statuses/{id}          the real Mastodon endpoint
 *   /users/{handle}/statuses/{id}  the alias we actually advertise, because it is the form
 *                                  FxEmbed proved Discord accepts. {handle} is DECORATION:
 *                                  the id already encodes the entire ref, so any handle
 *                                  resolves to the same post and none is ever parsed back out.
 *   /_oembed/{id}                  the oEmbed document whose author_name supplies the
 *                                  embed's top line.
 */
function spoofShape(seg: string[]): { kind: 'activity' | 'oembed'; at: number } | null {
  if (seg.length === 2) return seg[0] === '_oembed' && seg[1] !== '' ? { kind: 'oembed', at: 1 } : null
  if (seg.length !== 4) return null
  const real = seg[0] === 'api' && seg[1] === 'v1' && seg[2] === 'statuses'
  const alias = seg[0] === 'users' && seg[1] !== '' && seg[2] === 'statuses'
  return real || alias ? { kind: 'activity', at: 3 } : null
}

/** The spoof route itself. Null on a shape miss OR an id that does not decode — see route(). */
function spoof(seg: string[]): Route | null {
  const shape = spoofShape(seg)
  if (!shape) return null
  const ref = spoofRef(seg[shape.at])
  return ref ? { kind: shape.kind, ref } : null
}

/**
 * Phase 1 ships Bluesky and X's shape, Phase 3a adds TikTok, this phase adds Instagram; the
 * rest land in their own phases. Every forced arm must have an unforced twin: a forced miss
 * falls through in route(), so an arm present in only one of the two silently changes what
 * /{token}/… means.
 *
 * instagram() goes LAST in the unforced chain as a CONVENTION, not because of a live collision.
 * The four matchers are disjoint by construction today — x() requires seg[1] === 'status', which
 * is not in IG_SURFACE; tiktok() requires a leading '@', which instagram() explicitly refuses;
 * bluesky() is depth 4 while instagram() is depth 2–3 — and moving instagram() to the FRONT
 * changes 0 of 149,982 enumerated paths. Keep it last anyway, so that a future arm loosened to
 * match more cannot shadow a permalink an earlier matcher already claims.
 *
 * THE FORCED PATH GETS NO SUCH PROTECTION, and that is correct rather than an oversight: /ig/…
 * means "read this as Instagram", so instagram() runs ALONE with no chain in front of it. The
 * consequence is worth naming — /ig/status/{surface}/{x} resolves as Instagram, where unforced
 * it would be an X post by @ig. Harmless today, because that X reading's id would be the literal
 * string 'p'/'reel'/'reels'/'tv' and X ids are numeric, so no reachable permalink is affected.
 * It is a trap for whoever adds Threads or Reddit here, not a live defect.
 */
function matchPost(seg: string[], forced?: Platform): Route | null {
  if (forced === 'bs') return bluesky(seg)
  if (forced === 'x') return x(seg)
  if (forced === 'tt') return tiktok(seg)
  if (forced === 'ig') return instagram(seg)
  if (forced === 'th') return threads(seg)
  if (forced === 'rd') return reddit(seg)
  if (forced === 'yt') return youtube(seg)
  if (forced === 'fb') return facebook(seg)
  // The yt-dlp tier. `true` unlocks each one's DEPTH-1 arm, which is forced-only because bare /{id} is
  // measurably undecidable among the three — see the tier docstring above dailymotion().
  if (forced === 'dm') return dailymotion(seg, true)
  if (forced === 'st') return streamable(seg, true)
  if (forced === 'im') return imgur(seg, true)
  // `true` unlocks the depth-1 arm WITHOUT the shape gate — /tw/{slug} is the user naming the
  // platform, so an older or shorter slug the recogniser would refuse still resolves by hand.
  if (forced === 'tw') return twitch(seg, true)
  // Lemmy's shapes already name the platform (a dotted host plus a numeric id), so forcing adds no
  // discrimination — but the token exists so the escape hatch is uniform, and matchPost's rule that
  // every forced arm needs an unforced twin is satisfied by the same function.
  if (forced === 'lm') return lemmy(seg)
  // Same reasoning as 'lm': the shapes already name the platform, and the token exists so the escape
  // hatch stays uniform and every forced arm keeps its unforced twin.
  if (forced === 'ms') return masto(seg)
  if (forced === 'mk') return misskey(seg)
  if (forced === 'pt') return peertube(seg)
  if (forced === 'pn') return pinterest(seg)
  if (forced) return null
  // facebook() BEFORE instagram(): it claims a NUMERIC /reel/{id}, leaving the alphanumeric IG reels to
  // instagram(). Both are disjoint by the id shape, so the order is a guard, not a live collision today.
  //
  // THE yt-dlp TIER GOES LAST, after instagram(), and that ordering is load-bearing rather than
  // stylistic: a 178,964-path sweep found 232 currently-WORKING routes that a loosely-written Imgur
  // matcher shadows (/topic/status/{id} is a real Twitter permalink, /topic/reels/{id} a real
  // Instagram one). None of the three matchers here is that loose — but the convention is what keeps
  // a future loosening from shadowing a permalink an earlier matcher already claims.
  //
  // twitch() GOES LAST, and unlike the tier above it that placement is about a LIVE breadth
  // difference rather than a convention: its depth-1 arm is the only UNFORCED bare-/{segment} post
  // matcher in this chain (the yt-dlp tier's depth-1 arms are forced-only, precisely because bare
  // /{id} was undecidable among the three). A shape-gated matcher that reads one segment must not sit
  // in front of matchers that read three.
  //
  // masto() SITS BESIDE lemmy(), and both are safe this early for the same structural reason: each
  // requires seg[0] to satisfy FEDI_HOST — at least two labels with an alphabetic TLD — which no
  // handle-shaped first segment on any other platform here can meet. They discriminate on the host,
  // not on a surface token, so they cannot swallow a shape a later matcher owns.
  return bluesky(seg) ?? x(seg) ?? tiktok(seg) ?? threads(seg) ?? reddit(seg) ?? youtube(seg) ?? facebook(seg)
    ?? instagram(seg) ?? lemmy(seg) ?? masto(seg) ?? misskey(seg) ?? peertube(seg) ?? pinterest(seg) ?? dailymotion(seg) ?? streamable(seg)
    ?? imgur(seg) ?? twitch(seg)
}

/**
 * TikTok's short form, `/t/{code}`. Depth 2 ONLY: /t/status/123 is a real X permalink by @t, and
 * every caller runs this BELOW matchPost — the same fallthrough discipline as the ESCAPE and
 * spoof blocks, and the defect class fixed in 37386db (/x/status/123) and again for @api.
 *
 * Threads mints /t/{code} too, so this is NOT a claim that the code is TikTok's. It is a request
 * to ask TikTok, resolved asynchronously in worker.ts; a no-answer degrades to the ['tt','th']
 * chooser, which is exactly what this path served before the resolver existed. See the Route
 * kind's own comment in types.ts.
 *
 * A FUNCTION RATHER THAN AN INLINE BRANCH because it has two callers — here and the /tt/ escape
 * hatch — and matchPost's own comment states the rule they must obey: every forced arm needs an
 * unforced twin, or /{token}/… silently means two different things. One spelling makes that
 * structural.
 */
function shortlink(seg: string[]): Route | null {
  if (seg.length !== 2 || seg[0] !== 't' || !seg[1]) return null
  return {
    kind: 'shortlink',
    p: 'tt',
    code: seg[1],
    // Through canonical() like every other route, because worker.ts hands this to redirect() and
    // a decoded segment can carry a CR/LF that makes `new Headers` throw — the HTTP 500 fixed in
    // 4655ee8. This is the WIDEST canonical route() emits: the only requirement on the segment is
    // truthiness, so nothing else stands between a pasted URL and the Location header.
    // /t/%0d%0aX-Injected:%201 is a public URL anyone can paste, and without this wrapper it is a
    // 500 (verified by mutation, with the rest of the suite green).
    canonical: canonical(`https://www.tiktok.com/t/${seg[1]}`),
  }
}

/** decodeURIComponent throws URIError on malformed escapes (/%ZZ, /%E0%A4%A). */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

export function route(url: URL): Route {
  const path = url.pathname
  if (SITE_PATHS.has(path)) return { kind: 'site', path }

  const raw = path.split('/').filter(Boolean)
  if (raw.length === 0) return { kind: 'site', path: '/' }

  /**
   * /_prep?p={path} — the fixer page asking us to resolve a share code and warm the mux. See the
   * 'prep' arm of Route for why this is allowed to do real work.
   *
   * THE TARGET IS CARRIED IN A QUERY PARAMETER, not as a path suffix, and that is deliberate: a
   * suffix would make /_prep/_prep/... a shape this function has to reason about recursively, and the
   * target frequently carries its OWN query (/watch?v=…), which a suffix cannot hold. `p` is an
   * ordinary opaque string here — it is re-routed by route() in worker.ts, which is the same boundary
   * every other url crosses, so nothing is trusted about it at this point.
   */
  if (raw.length === 1 && raw[0] === '_prep') {
    const target = url.searchParams.get('p')
    return target ? { kind: 'prep', target } : { kind: 'notfound' }
  }

  /**
   * /_card?p={path} — the fixer page asking what Discord will actually draw, so it can show a preview
   * instead of a url and a promise. Same target-in-a-query-parameter reasoning as /_prep above.
   *
   * SEPARATE FROM /_prep ON PURPOSE. prep's contract is that the page NEVER waits for it — it answers
   * fast and does the expensive half in waitUntil. A card must be rendered before it can be described,
   * so folding it into prep would make the endpoint that must not block the one that always does.
   * Two endpoints keeps that property, and keeps the preview's cost explicit rather than hidden inside
   * an optimisation.
   */
  if (raw.length === 1 && raw[0] === '_card') {
    const target = url.searchParams.get('p')
    return target ? { kind: 'card', target } : { kind: 'notfound' }
  }

  /**
   * /_api/v1?url={the whole original url} — the public JSON API.
   *
   * THE VERSION IS IN THE PATH, not a header and not a query parameter, because it has to be visible
   * in a url somebody pastes into a bug report. `/_api/v2` deliberately falls through to notfound
   * rather than being silently served as v1: a consumer that asks for a version we do not have should
   * be told, not quietly handed a different contract.
   *
   * THE PARAMETER IS `url`, NOT `p`. /_prep and /_card take `p` because the page hands them a PATH on
   * our own origin — they are internal endpoints for a page that has already done the swap. This one
   * takes the whole original url including its host, because an API consumer has a link, not a path,
   * and making them strip the scheme and host first would be a transformation they could get wrong.
   *
   * THE HOST IN THAT URL IS STILL IGNORED, and that is not an oversight — see the api arm in
   * worker.ts. route() is host-agnostic by design; using the supplied host to break a `/gallery/abc`
   * tie would make this function's answer depend on an attacker-controlled string, and the fediverse
   * branch turns a hostname into a fetch. The value here is opaque and is re-routed through this very
   * function, which is the same boundary every other url crosses.
   *
   * A MISSING `url` IS STILL kind:'api', with a null target, rather than falling through to
   * notfound. The two answers a caller needs to tell apart are "you asked wrongly" and "this url has
   * no post", and notfound is the second — it renders the same 404 a typo in any path gets. Carrying
   * the null keeps the API's own arm the one place that decides what a bad REQUEST looks like, and it
   * costs one nullable field instead of a second Route kind and a second entry in every sweep.
   */
  if (raw.length === 2 && raw[0] === '_api' && raw[1] === 'v1') {
    return { kind: 'api', target: url.searchParams.get('url') }
  }

  // /_media/{encodeURIComponent(refKey)}/{index} — TWO encode layers, TWO decode layers.
  //
  // refKey() percent-encodes each component before joining with ':'. The renderer
  // then encodeURIComponent()s the WHOLE key on top of that, so the key that hits
  // the wire never contains a bare ':' — nothing is left for an edge/proxy (e.g.
  // Discord's media proxy) to percent-normalize. Symmetrically, this route does the
  // outer decode ONCE (undoing the renderer's whole-key encode) before handing the
  // result to parseRefKey, which does the (only remaining) decode per component
  // after splitting on ':'. safeDecode never throws: a malformed segment (e.g.
  // /_media/%ZZ/0) becomes notfound, not a 500.
  //
  // This is decode-then-split-then-decode, inverting encode-then-join-then-encode —
  // symmetric by construction. It is also backward-compatible with a literal,
  // unencoded refKey segment (no '%' in it): decodeURIComponent is a no-op on a
  // string with no percent-escapes, so an un-encoded key still round-trips.
  if (raw[0] === '_media') {
    if (raw.length !== 3) return { kind: 'notfound' }
    const outerDecoded = safeDecode(raw[1])
    if (outerDecoded === null) return { kind: 'notfound' }
    const ref = parseRefKey(outerDecoded)
    if (!ref) return { kind: 'notfound' }
    if (raw[2] === 'avatar') return { kind: 'media', ref, index: 'avatar' }

    // `poster{N}` — media[N]'s POSTER FRAME, a still image. Added 2026-07-19 with the
    // preview_url fix (see types.ts's Media.poster for the measured defect it answers).
    //
    // WHY THIS SHAPE. It has to be un-confusable with the two indices already parsed here, and
    // both properties are structural rather than lucky:
    //  - vs a NUMERIC index: it begins with a letter, so Number() is NaN no matter what follows.
    //    There is no digit string that spells a poster and no poster segment that spells an index.
    //  - vs 'avatar': matched above, on a full-segment equality, before this line is reached.
    // It carries N because a poster belongs to a specific entry; a bare 'poster' would have to
    // guess which one on any post with more than one video.
    //
    // MATCHED BEFORE THE INTEGER PARSE AND AFTER 'avatar', on a FULL-SEGMENT match with its own
    // extension allowlist — so a segment that is not poster-shaped reaches Number() byte-identical
    // to what it reached before this existed, and every /_media/ url ever minted routes unchanged.
    // The extensions are the IMAGE ones only: a poster is a still, and `poster0.mp4` is exactly
    // the video/poster confusion this whole change exists to remove, so it is deliberately absent
    // and 404s. `\d+` (not `\d*`) is what stops a bare 'poster' or 'poster.jpg' from resolving to
    // entry 0 — Number('') is 0, the same trap the .mp4 tolerance below documents.
    const poster = /^poster(\d+)(?:\.(?:jpg|jpeg|png|gif|webp))?$/.exec(raw[2])
    if (poster) return { kind: 'media', ref, index: { poster: Number(poster[1]) } }
    // A TRAILING MEDIA EXTENSION IS DECORATION, stripped before the integer parse — so
    // /_media/{key}/0.mp4 and /_media/{key}/0 are two spellings of one resource.
    //
    // WHY IT EXISTS: production fxtiktok's og:video / twitter:player URL ends in '.mp4' and ours
    // ended in a bare '/0'. That suffix is one delta in the production-parity head shipped
    // 2026-07-19 (see render/discord.ts's PRODUCTION PARITY docstring for why that head is
    // reproduced wholesale rather than bisected), and a URL we advertise has to resolve.
    //
    // THE EXTENSIONLESS FORM IS NOT LEGACY. It is what the plain-og head, the Bluesky path and
    // the Mastodon media_attachments all still emit — and media_attachments is what actually
    // draws Discord's inline player. Only the spoof head's og:video / twitter:player pair carries
    // the suffix. Neither spelling may be removed.
    //
    // FULL-SEGMENT MATCH ON DIGITS + AN ALLOWLISTED EXTENSION, which is the tightest rule that
    // does the job, and the tightness is load-bearing twice over:
    //  - a segment that does NOT match reaches Number() byte-identical to what it reached before,
    //    so this cannot change any routing that already worked (including the pre-existing
    //    Number() looseness that makes '0.' index 0 — untouched, deliberately).
    //  - Number('') is 0, NOT NaN. An unconditional strip would resolve /_media/{key}/.mp4 to the
    //    FIRST media entry, serving real bytes for a URL we never minted. `\d+` is what forbids
    //    that, and '0.exe' / 'x.mp4' / '0.mp4.mp4' fall out the same way.
    const suffixed = /^(\d+)\.(?:mp4|m4v|mov|webm|jpg|jpeg|png|gif|webp)$/.exec(raw[2])
    const i = Number(suffixed ? suffixed[1] : raw[2])
    if (!Number.isInteger(i) || i < 0) return { kind: 'notfound' }
    return { kind: 'media', ref, index: i }
  }

  // Platform paths carry ordinary URL-encoded segments, so they DO get decoded.
  const decoded = raw.map(safeDecode)
  // A malformed escape (/api/v1/statuses/%ZZ) is still a request to a spoof-shaped path, and
  // its caller is still parsing JSON. Decided on `raw` because `seg` does not exist yet —
  // sound, because every token spoofShape reads is pure ASCII with no escapes to decode, so
  // raw and seg agree on the shape positions. Without this, the single spoof id that dies
  // here rather than in decodeStatusId would be the one that still answered HTML.
  if (decoded.some(s => s === null)) return spoofShape(raw) ? { kind: 'badid' } : { kind: 'notfound' }
  /**
   * DISCORD'S SPOILER BARS ARE STRIPPED, because Discord sends them to us.
   *
   * REPORTED 2026-08-01: `||https://mbedfx.app/hepi01967211/status/2083545767893983385||` rendered
   * "Couldn't load this Twitter post" while the bare link worked. Reproduced against production —
   * the same id with `||` appended fails, and so does the percent-encoded `%7C%7C` form. Discord's
   * link detector does not treat `|` as a URL terminator, so the pipes ride along into the path and
   * the id upstream becomes `2083545767893983385||`.
   *
   * Stripped rather than rejected: a spoilered link is a perfectly ordinary request from a reader
   * who wants the card hidden behind a click, and answering it with a failure card is both wrong and
   * — since the card is the thing being spoilered — especially annoying.
   *
   * SAFE TO STRIP UNCONDITIONALLY. `|` is not legal unencoded in a path, no platform's id or handle
   * uses one, and a fediverse host cannot contain one either. Done after decoding so the encoded
   * spelling is caught by the same line.
   */
  const seg = (decoded as string[]).map(s => s.replace(/\|/g, ''))

  // /_alt/0 — the twitter:image suppression target. Exists only to be a dead end.
  if (seg[0] === '_alt') return { kind: 'notfound' }

  /**
   * The Mastodon-spoof callbacks. These are SHAPE matches, and — like the ESCAPE block
   * below and for exactly the same reason — they are tried first but are NOT final: every
   * miss returns null and control falls through to the normal interpretation.
   *
   * DO NOT "reserve" api / users / _oembed, and do not add them to the `known` set below.
   * That set is a dead-end list, and dead-ending a token that is also a real handle is the
   * Phase 1 bug fixed in 37386db, where /x/status/123 — a real post by @x — returned
   * notfound. @api is a LIVE X account (verified 2026-07-18 by content-probing x.com: live
   * handles return the React shell, dead ones a static error page, and the status codes
   * agree either way, so content is the load-bearing check). /api/status/123 is therefore a
   * real post permalink today and must keep routing as one. A token is consumed only at the
   * exact depth the spoof uses it, so a handle that goes live later costs us nothing either.
   *
   * The acceptance test is that the ambiguity table is UNCHANGED: /api, /users and /_oembed
   * stay ambiguous ['x','ig'], /api/v1 and /users/someone stay notfound. That invariant only
   * holds under fallthrough.
   */
  const hitSpoof = spoof(seg)
  if (hitSpoof) return hitSpoof

  const forced = ESCAPE[seg[0]]
  if (forced) {
    const forcedHit = matchPost(seg.slice(1), forced)
    if (forcedHit) return forcedHit
    // /tt/t/{code}. The escape hatch is documented as THE way to force a platform, and the short
    // form was the one TikTok shape with no forced twin — /tt/t/{code} was notfound while
    // /t/{code} resolved. Guarded on `forced === 'tt'` because it is TikTok's shape: /bs/t/{code}
    // must not mint a TikTok resolver call. Nothing is shadowed — unforced, /tt/t/{code} is a
    // depth-3 path no matcher claims — and the block's fallthrough below is untouched.
    if (forced === 'tt') {
      const forcedShort = shortlink(seg.slice(1))
      if (forcedShort) return forcedShort
    }
    // seg[0] may be a real handle rather than an escape token (e.g. x.com/x/status/…),
    // so fall through to the normal unforced interpretation instead of dead-ending.
  }

  // YouTube's /watch?v={id} — the id lives in the QUERY, which the segment matchers never see. Handled
  // here, where url.searchParams is in scope, at matchPost's priority (above the KNOWN dead-end set and
  // ambiguity). Guarded on the exact 11-char id, so a bare /watch or a junk `v` falls through to notfound.
  if (seg.length === 1 && seg[0] === 'watch') {
    // TOLERATE TRAILING JUNK on the v param: a real paste can carry `?v={id}/…` or a hand-appended
    // cache-buster, and a strict full-string match turned those into the ambiguity chooser (reported
    // 2026-07-24). The id is a FIXED 11 chars, so taking the leading 11 and requiring the next character
    // to be a non-id one is exact, not a guess — `?v={12-char-id}` still refuses rather than truncating a
    // longer token into a different video.
    const raw = url.searchParams.get('v') || ''
    const v = YT_ID.test(raw) ? raw
      : (raw.length > 11 && YT_ID.test(raw.slice(0, 11)) && !/[A-Za-z0-9_-]/.test(raw[11]) ? raw.slice(0, 11) : '')
    if (v) return ytPost(v)
    // Facebook's /watch/?v={id} shares the shape; a long NUMERIC v is Facebook's (YouTube's is the
    // 11-char id checked just above, so a real yt id never reaches here). Reads RAW, not the
    // YouTube-validated `v` — that one is empty for every Facebook id, which silently unrouted Facebook
    // when the tolerant-v parsing landed.
    const fbId = raw.replace(/\/.*$/, '')
    if (FB_NUM.test(fbId)) return fbPost('watch', fbId)
  }

  /**
   * `/story.php?story_fbid={post}&id={owner}` and `/permalink.php?…` — Facebook's LEGACY post
   * permalinks, handled here for the same reason /watch?v= is: the ids live in the QUERY, which the
   * segment matchers never see.
   *
   * REPORTED 2026-08-01, and the old behaviour was worse than a miss. `/story.php` is one segment, so
   * it fell through every platform matcher to the AMBIGUOUS chooser, which offered a human
   * "x.com/story.php or instagram.com/story.php" — two links that mean nothing, for a url that is
   * unambiguously Facebook's.
   *
   * IT IS ALSO WHERE FACEBOOK'S OWN SHARE RESOLUTION LANDS for some codes. Measured on the reported
   * link: /share/p/{code} 302s here, while three other share codes 302 to /{owner}/posts/{id}. So a
   * resolved share was being handed a permalink shape nothing could route — the reason
   * platforms/metashare's comment already lists story.php among "the shapes the router already
   * parses" while the router did not.
   *
   * BOTH IDS ARE REQUIRED. story_fbid alone does not name a post — the pair does, which is exactly
   * why the ref id is the composite. A url carrying only one is not routed rather than guessed at.
   */
  if (url.pathname === '/story.php' || url.pathname === '/permalink.php') {
    const post = url.searchParams.get('story_fbid') || ''
    const owner = url.searchParams.get('id') || ''
    if (FB_POST_ID.test(post) && FB_OWNER.test(owner)) return fbPost('post', `${owner}_${post}`)
  }

  /**
   * `/photo/?fbid={id}` and `/photo.php?fbid={id}` — the two QUERY spellings of a photo permalink,
   * here for the same reason /story.php is: the id lives in the query, which the segment matchers
   * never see. Facebook emits both, in the same document: measured 2026-08-11 on one page's own
   * markup, its album links spell `/photo/?fbid={id}&set=a.{albumId}` while its timeline links spell
   * `/photo.php?fbid={id}&set=pb.{pageId}.-2207520000&type=3`.
   *
   * THE OLD ANSWER WAS THE AMBIGUOUS CHOOSER, not a miss — /photo.php is one segment, so it fell
   * through every matcher to the bare-username row and offered a human "x.com/photo.php or
   * instagram.com/photo.php", two links that mean nothing, for a url that is unambiguously
   * Facebook's. That is the same defect /story.php had, fixed the same way and for the same reason.
   *
   * WHAT IS AND IS NOT CLAIMED. The chooser is only taken away when `fbid` is present AND numeric:
   * a bare /photo, /photo.php or a junk fbid still falls through to exactly today's answer. That
   * matters because @photo IS a plausible handle — /photo/status/{id} is a real Twitter permalink by
   * @photo and /photo/p/{code} a real Instagram one, and both are claimed by x() and instagram() at
   * depth 3, which this depth-1 arm never reaches. No X or Instagram profile url carries `?fbid=`.
   *
   * `set` AND `type` ARE IGNORED, not required. They are decoration on the id — measured: the plugin
   * returns the same fragment for `/photo/?fbid={id}` with no set at all as for the fully-qualified
   * spelling — and requiring them would refuse the shortest form Facebook itself emits.
   */
  if (seg.length === 1 && (seg[0] === 'photo' || seg[0] === 'photo.php')) {
    const fbid = url.searchParams.get('fbid') || ''
    if (FB_NUM.test(fbid)) return fbPost('photo', fbid)
  }

  /**
   * `clips.twitch.tv/embed?clip={slug}&parent=…` — the EMBED IFRAME url, handled here for the same
   * reason /watch?v= is: the id lives in the QUERY, which the segment matchers never see.
   *
   * It is worth claiming because that page carries NO og: metadata AT ALL (measured 2026-07-27: the
   * player shell titles itself 'Twitch' and emits no og:title/description/image), so a paste of it is
   * a link that previews as nothing anywhere — including on Twitch itself.
   *
   * NO SHAPE GATE, because there is no ambiguity to resolve: `?clip=` on /embed names the platform
   * outright. TWITCH_SLUG (the loose safety shape, not the tight recogniser) still bounds it, so a
   * junk parameter falls through to notfound rather than minting a ref.
   */
  if (seg.length === 1 && seg[0] === 'embed') {
    const clip = url.searchParams.get('clip') || ''
    if (TWITCH_SLUG.test(clip)) return twPost(clip, `https://clips.twitch.tv/${clip}`)
  }

  const hit = matchPost(seg)
  if (hit) return hit

  const short = shortlink(seg)
  if (short) return short

  // The dead-end set — hoisted to module scope as KNOWN, where its membership is argued, because
  // instagram() must consult it too. Reached only AFTER matchPost and shortlink(), so it can
  // never dead-end a shape a matcher claims; that ordering is what lets Instagram's four surface
  // tokens stay listed while /p/{code} still routes.
  if (KNOWN.has(seg[0])) return { kind: 'notfound' }

  const amb = ambiguity(seg)
  // A COPY, NEVER THE TABLE'S OWN ROW — the one place the spread happens, so a consumer that mutates
  // `candidates` cannot rewrite this isolate's routing table. See AMBIGUOUS.
  if (amb) return { kind: 'ambiguous', path, candidates: [...amb] }

  // Spoof-shaped, but the {id} did not decode — otherwise `spoof()` above would have
  // returned. Deliberately the LAST word, below matchPost / `known` / ambiguity, so it can
  // only ever replace a notfound: dead-ending the shape any earlier is precisely the
  // fallthrough violation the block above spends a paragraph refusing to commit.
  if (spoofShape(seg)) return { kind: 'badid' }

  return { kind: 'notfound' }
}
