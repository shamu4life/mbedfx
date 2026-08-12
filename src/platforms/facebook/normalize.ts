import type { Post, PostRef } from '../../types.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'

/**
 * Pure: container-extracted metadata -> a REMUX-video Post. Facebook video plays from Cloudflare
 * datacenter egress via the container's yt-dlp (measured 2026-07-22: a public watch/reel url muxes to a
 * real mp4 — Meta does NOT gate our egress there). But the crawler-UA / oembed metadata surface IS
 * decoyed from datacenter (measured: facebookexternalhit gets a contentless shell), so the byline,
 * caption, poster and dimensions all come from the SAME yt-dlp that resolves the video (a `-J` metadata
 * call in the container) — the one source that works. No I/O — the container call lives in worker.ts.
 *
 * IT READS THE CLOCK ONCE (uploadDateOrEpoch's future bound), and this docstring used to claim it did
 * not — see platforms/uploaddate.ts. Nothing else here is clock-dependent.
 */

/**
 * What the container's `{page, meta:true}` mode yields, mapped for the card.
 *
 * EVERYTHING PAST `title` IS OPTIONAL, and that is a deploy-ordering requirement rather than
 * tidiness: a deploy is not atomic and a pooled container instance keeps running the image it booted
 * with until sleepAfter, so an OLD instance still answers with only {title, thumbnail, uploader}.
 * That response must degrade to the pre-2026-07-25 card, never to a throw.
 */
export type FacebookMeta = {
  title: string
  poster?: string
  uploader?: string
  uploaderId?: string
  uploaderUrl?: string
  description?: string
  w?: number
  h?: number
  duration?: number
  timestamp?: number
}

/** The url the container's yt-dlp is handed (both the meta call and the /_media mux) — from the ref. */
export function fbPageUrl(ref: Extract<PostRef, { p: 'fb' }>): string {
  if (ref.kind === 'photo') {
    // The one spelling of the six that needs nothing but the fbid — no owner, no album, no `set`.
    // Measured 2026-08-11 from Cloudflare egress: `plugins/post.php?href=` this returns the same 74 KB
    // fragment as the owner-bearing spellings do, so the two query forms (which carry no owner at all)
    // and the four path forms can all rebuild into it. See the PostRef arm in types.ts.
    return `https://www.facebook.com/photo/?fbid=${ref.id}`
  }
  if (ref.kind === 'post') {
    // `{ownerId}_{postId}` -> the /{owner}/posts/{id}/ spelling, which is BOTH what Facebook's own
    // og:url uses and — measured 2026-08-01 — the shape that answers our datacenter egress with a
    // complete og: set, where the legacy story.php spelling for the same post does not.
    const [owner, post] = ref.id.split('_')
    return `https://www.facebook.com/${owner}/posts/${post}/`
  }
  if (ref.kind === 'group') {
    // `{groupId}_{postId}` -> the /posts/ spelling, which is what Facebook's own share code resolves
    // to (measured: /share/p/Fixture01X/ -> /groups/328668786145521/posts/1391536379858751/). The
    // /permalink/ spelling is accepted by the router and normalises to this one.
    const [gid, pid] = ref.id.split('_')
    return `https://www.facebook.com/groups/${gid}/posts/${pid}/`
  }
  return ref.kind === 'reel' ? `https://www.facebook.com/reel/${ref.id}`
    : ref.kind === 'share' ? `https://www.facebook.com/share/v/${ref.id}`
      : `https://www.facebook.com/watch/?v=${ref.id}`
}

/**
 * yt-dlp's `uploader` IS the creator — WHEN IT CAME FROM THE STRUCTURED OWNER. Its extractor falls
 * back to the PAGE'S og:title when the GraphQL owner has no name (facebook.py: `uploader =
 * uploader_data.get('name') or ... _search_regex((r'ownerName…', *self._og_regexes('title')))`), and
 * Facebook's og:title on a reel is the PACKED "<counts> | <caption> | <creator>" line. yt-dlp's OWN
 * test fixture for /reel/1195289147628387 records that leak: uploader = "9.7K views &#xb7; 352
 * reactions | When your trying to … | Beast Camp Training", WITH a valid uploader_id beside it — so
 * uploader_id is not a discriminator and the SHAPE is. A real name is short, has no ' | ' and no HTML
 * entity escapes; anything else is the fallback leaking, and we keep the platform byline (the
 * pre-2026-07-25 card). Heuristic, and deliberately biased to the safe direction: a false negative is
 * today's behaviour, a false positive is a wrong creator on the card.
 */
function usableUploader(raw: unknown): string | undefined {
  // .trim(): measured 2026-07-25, yt-dlp returns 'PhillyBanana ' WITH a trailing space.
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s || s.length > 64 || s.includes('|') || s.includes('&#')) return undefined
  return s
}

/**
 * THE CAPTION. `description` is the post's own message text and is the right body — measured
 * 2026-07-25: description 'Are you “Disturbed”' beside a title of '3.9K reactions · 292 shares | Are
 * you “Disturbed” | PhillyBanana'. Shipping the TITLE as the body is the measured defect (that packed
 * counts-string is what reached the real card's og:description).
 *
 * When description is empty (yt-dlp's own fixtures show it happens) unpack the title, but ONLY on
 * POSITIVE evidence of the packed shape: >= 3 ' | ' segments whose LAST one starts with the creator we
 * already trusted (the fixture's last segment is 'Asif Nawab Butt on Reels' for uploader 'Asif Nawab
 * Butt', hence startsWith, not equality). Otherwise the title goes out verbatim — the pre-2026-07-25
 * behaviour — so a differently-shaped title can never be mangled by this.
 */
function caption(meta: FacebookMeta, who: string | undefined): string {
  const d = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (d) return d
  const t = typeof meta.title === 'string' ? meta.title.trim() : ''
  const parts = t.split(' | ')
  return who && parts.length >= 3 && parts[parts.length - 1].startsWith(who)
    ? parts.slice(1, -1).join(' | ')
    : t
}

/**
 * BOTH OR NEITHER. 0,0 is the shape EVERY remux platform ships when it does not know a size —
 * youtube/normalize.ts sets exactly that, with the note "Discord reads the muxed mp4's real
 * dimensions" — and a HALF-known pair (w:0, h:1024) is neither that nor a usable aspect ratio: it is
 * a size no consumer can act on, and every one of them would have to re-derive that per field. So one
 * usable dimension without its partner degrades to the known-unknown pair on both.
 *
 * THE MEASURED DEFECT IS FIXED HERE, AT THE SOURCE, not in the renderer. og:video:width="0" reached a
 * real card on 2026-07-25 for a video that is really 576x1024 — because the container was not
 * REPORTING the dimensions it had, not because 0 is rendered wrongly. render/embed.ts's dimTags is a
 * shared primitive across eight platforms and briefly grew a `<= 0` gate for this; see its docstring
 * for why that was reverted rather than kept.
 */
function dims(w: unknown, h: unknown): [number, number] {
  const ok = (v: unknown) => Number.isInteger(v) && (v as number) > 0
  return ok(w) && ok(h) ? [w as number, h as number] : [0, 0]
}

export function normalizeFacebook(meta: FacebookMeta | null, ref: PostRef): Post | null {
  if (ref.p !== 'fb' || !meta) return null
  const url = fbPageUrl(ref)
  const [w, h] = dims(meta.w, meta.h)
  const who = usableUploader(meta.uploader)
  // facebook.com/{id} 301s to the real profile — verified 2026-07-25 on 61554703834017 ->
  // /people/PhillyBanana/61554703834017/. Covers pfbid ids too (alphanumeric, dots).
  const id = typeof meta.uploaderId === 'string' && /^[A-Za-z0-9.]+$/.test(meta.uploaderId) ? meta.uploaderId : ''
  const uploaderUrl = typeof meta.uploaderUrl === 'string' && /^https?:\/\//.test(meta.uploaderUrl)
    ? meta.uploaderUrl
    : ''
  return {
    ref: { p: 'fb', kind: ref.kind, id: ref.id },
    canonical: url,
    /**
     * handle = the NAME, exactly as normalizeYouTube does: Facebook has no @handle concept on this
     * surface, and this repo's established answer for a platform without one is name-as-handle (the
     * renderer's handleSegment encodes it for the url). When the uploader is missing or is the packed
     * og:title leaking through, this falls back to the platform byline — the pre-2026-07-25 card.
     */
    author: {
      name: who || 'Facebook',
      handle: who || 'facebook',
      url: uploaderUrl || (id ? `https://www.facebook.com/${id}` : 'https://www.facebook.com'),
    },
    /**
     * NO `title`, deliberately, and this is the fix for the packed og:description. A Facebook video
     * has no headline distinct from its body, and the only 'title' on offer is that packed og:title —
     * render/text.ts prepends Post.title to og:description, which is precisely how "3.9K reactions ·
     * 292 shares | …" reached the card the human measured.
     */
    text: caption(meta, who),
    // Upstream's timestamp, RANGE-CHECKED by the one shared rule rather than by a bare isFinite guard —
    // see platforms/uploaddate.ts for the Invalid-Date-throws-on-toISOString defect that guard admits.
    // 0 keeps the old epoch fallback, which the activity JSON renders as 1970 exactly as it did before.
    createdAt: uploadDateOrEpoch(meta.timestamp),
    /**
     * Remux the watch/reel/share PAGE (yt-dlp resolves it, including share redirects). w/h are the
     * REAL dimensions when the container reported them (2026-07-25: 576x1024 on the measured reel, and
     * ffprobe of the mp4 the muxer produces agrees) and 0,0 when it did not — which is byte-for-byte
     * what YouTube, the other {page} remux platform, has always shipped, and is the ONLY case a
     * pre-g4 pooled instance can still produce. url is the page placeholder (never served; /_media
     * uses `remux`). poster = yt-dlp's thumbnail when present.
     */
    media: [{
      kind: 'video', url, w, h,
      ...(typeof meta.duration === 'number' && Number.isFinite(meta.duration) && meta.duration > 0
        ? { duration: meta.duration } : {}),
      remux: { page: url },
      ...(meta.poster ? { poster: meta.poster } : {}),
    }],
    /**
     * DELIBERATELY EMPTY. The only counts Facebook offers are pre-abbreviated, localized substrings of
     * the packed title ('3.9K reactions'), and un-abbreviating them to re-abbreviate through the
     * renderer's abbrev() is a lossy round trip on a localized string. yt-dlp's like_count /
     * comment_count are null on this path (verified 2026-07-25).
     */
    counts: {},
    sensitive: false,
  }
}

/* ------------------------------------------------------------------------------------------- *
 * THE POST CARD — Facebook's non-video surface, which this platform never rendered before.
 * ------------------------------------------------------------------------------------------- */

/**
 * META SERVES ITS OWN CRAWLER AN EMPTY BODY AND A COMPETITOR'S THE REAL PAGE. Measured 2026-07-26 on
 * one post url, same second, only the UA differing:
 *
 *   facebookexternalhit/1.1  -> HTTP 200, ZERO BYTES        <- the UA this project sends everywhere
 *   Twitterbot/1.0           -> HTTP 200, 319,851 bytes, full og: set
 *   Discordbot/2.0           -> HTTP 200, 322,740 bytes
 *
 * That is why this file's own header says the metadata surface is "decoyed from datacenter" and why
 * Facebook was VIDEO-ONLY: the decoy was real, but it was a property of ONE user-agent, not of the
 * surface. The roadmap's crawler-UA plan was measured dead against `facebookexternalhit` and the
 * conclusion generalised further than the measurement did.
 *
 * Twitterbot is chosen over Discordbot deliberately: both work today, and picking the one that is NOT
 * the client we are impersonating downstream keeps our upstream identity independent of whichever
 * client happens to be unfurling.
 */
/**
 * BOTH NUMERIC ENTITY FORMS, and the decimal one is not hypothetical: Facebook writes apostrophes as
 * `&#039;` and emoji as `&#x1f600;` in the SAME document, so a hex-only decoder ships cards reading
 * "Don&#039;t be complicit" — caught end-to-end on a real post before this shipped.
 *
 * `&amp;` IS DECODED LAST, deliberately. Decoding it first would let a literal "&amp;#039;" in the
 * post's own text become "&#039;" and then an apostrophe, i.e. one round of user-controlled
 * double-decoding. Numeric escapes are resolved against the RAW text first, so nothing a poster writes
 * can be promoted into an entity by our own decoding.
 *
 * codePointAt-safe: parseInt on a bounded [0-9a-f]{1,6} can still exceed the Unicode maximum
 * (0x10FFFF), which makes String.fromCodePoint THROW a RangeError — on a public response path, that is
 * a 500. Out-of-range escapes are left as written instead.
 */
const ENTITY = /&#(x)?([0-9a-f]{1,6});/gi
/**
 * SHARED WITH THE PLUGIN SURFACE BELOW, which is why this is a function rather than inlined into
 * FB_OG. The ordering rules above are the whole value of it, and a second decoder written for the
 * second surface is exactly the "two copies of one rule" this file avoids everywhere else.
 */
function fbDecode(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(ENTITY, (whole, hex, digits) => {
      const n = parseInt(digits, hex ? 16 : 10)
      return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : whole
    })
    .replace(/&amp;/g, '&')
}
const FB_OG = (html: string, prop: string): string => {
  const m = html.match(new RegExp(`<meta property="og:${prop}" content="([^"]{0,2000})"`))
  return m ? fbDecode(m[1]) : ''
}

/** Meta's image CDNs. The og:image url reaches the renderer and can be fetched, so it is range-checked. */
const FB_IMG_HOSTS = ['fbcdn.net', 'cdninstagram.com']
function fbImage(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const h = u.hostname.toLowerCase()
    return FB_IMG_HOSTS.some(x => h === x || h.endsWith(`.${x}`))
  } catch {
    return false
  }
}

/**
 * A CARD BUILT FROM A FACEBOOK POST PAGE's og: SET — pure, total, and the ONLY non-video path this
 * platform has. Reached only after the container's yt-dlp declines the url (a post is not a video), so
 * it costs nothing on the video path it does not serve.
 *
 * WHAT IT UNLOCKS AND WHAT IT DOES NOT, measured over the three links reported 2026-07-26:
 *   /share/Fixture06X/  multi-image post -> renders (ONE image)
 *   /share/Fixture07X/  single image     -> renders
 *   /share/Fixture02X/  text post        -> NO og tags at all, 3/3 tries -> still null
 *
 * MULTI-IMAGE IS A COVER, NOT A GALLERY. The multi-image post's page exposes exactly ONE distinct
 * scontent url (measured by deduping every scontent link in the body), so there is no second picture to
 * emit. Stated because "Facebook posts work now" would otherwise imply carousel support that is absent.
 *
 * og:title IS THE PAGE NAME on this surface, not the post title — the post's words are in
 * og:description. So the byline comes from og:title and the body from og:description, which is the
 * opposite of most platforms and the kind of thing that reads as a bug when skimmed.
 *
 * THE REF IS PRESERVED UNCHANGED. This page is reached by following the share redirect, so it is
 * tempting to re-canonicalise onto the resolved /{page}/posts/{id}/ url — but refKey(ref) is the cache
 * key AND the /_media/{refKey}/ namespace, and a ref that changed identity mid-request would strand
 * both. The resolved url goes in `canonical`, which is what a human clicks; the ref never moves.
 */
/**
 * THE BYLINE, and the reason it is not simply `og:title`.
 *
 * Reported 2026-07-30 on a group post: the card read
 *
 *   "GMT800s With Threatening Auras v2 | GOT THREATENED AT THE CORN STAN TODAY | Facebook
 *    (@GMT800s With Threatening Auras v2 | GOT THREATENED AT THE CORN STAN TODAY | Facebook)"
 *
 * because `name` and `handle` were BOTH the raw og:title. On a group post Facebook packs
 * `{group} | {post excerpt} | Facebook` into that field, so the byline became the whole post, twice.
 *
 * THE ` | Facebook` SUFFIX IS THE DISCRIMINATOR, and this is deliberately narrow. Facebook packs
 * og:title differently per surface — a REEL's is `<counts> | <caption> | <creator>`, with the creator
 * LAST (see the yt-dlp uploader comment below). A blanket "take the first segment" would therefore
 * turn a reel's view count into its author. Only the page-title form, which is the one that ends in
 * ` | Facebook`, is unpacked; every other shape is left exactly as it was.
 *
 * THE HANDLE IS NOT A COPY OF THE NAME. There is no @-handle on this surface — a group has an id,
 * not a username — so it is left EMPTY rather than duplicated, and the renderers already omit an
 * empty one instead of printing `(@)`.
 *
 * THAT LAST PARAGRAPH DESCRIBED ONE BRANCH AND THE CODE HAD TWO, which is how the defect it was
 * written to fix survived everywhere except group posts. `handle` was emptied only on the packed
 * ` | Facebook` shape and left as the raw og:title otherwise — and og:title on an ordinary page post
 * IS the page name, so `name` and `handle` were the same string and every card read
 *
 *   "NASA - National Aeronautics and Space Administration
 *    (@NASA - National Aeronautics and Space Administration)"
 *
 * MEASURED FROM CLOUDFLARE EGRESS 2026-08-12: of 35 sampled post urls, 17 rendered from this surface
 * and NOT ONE og:title ended in ` | Facebook`, so all 17 carried the doubled byline. The reel shape
 * doubled a whole caption and a view count with it.
 *
 * SO IT IS UNCONDITIONAL NOW. There is no @-handle anywhere on the og: surface — packed or not,
 * page, group or reel — and emitting the name twice is not a smaller wrong answer than emitting it
 * once. facebookPluginCard has always spelled the same field the same way.
 */
export function fbAuthor(title: string, canonical: string): Post['author'] {
  const url = canonical.replace(/\/(?:posts|permalink)\/.*$/, '/') || 'https://www.facebook.com'
  const parts = title.split(' | ')
  const packed = parts.length > 1 && parts[parts.length - 1].trim() === 'Facebook'
  const name = packed ? (parts[0].trim() || title) : title
  return { name, handle: '', url }
}

/**
 * `captionOnly` ADMITS A POST WHOSE PAGE HAS WORDS BUT NO PICTURE, and it is off by default because
 * the ORDER matters more than the rule — see facebookCaptionCard below, which is the only caller
 * that turns it on and runs only after the plugin fragment has already declined.
 */
/**
 * DOES FACEBOOK CLAIM THIS PAGE? The structural binding under the caption read, and the reason that
 * read is not simply "any document with two og tags".
 *
 * THE OTHER TWO READS ARE ANCHORED TO SOMETHING and this one was not. The strict read requires a
 * picture that passes `fbImage`, which range-checks the CDN host. The plugin read requires an anchor
 * to facebook.com/{page}. The caption read, by dropping the picture requirement, dropped the only
 * structural check it had — leaving `og:title` non-empty AND `og:description` non-empty as the whole
 * test, which any page on the internet can satisfy.
 *
 * WHAT WAS HOLDING IT UP WAS A MEASUREMENT, and measurements of somebody else's product rot. The
 * safety argument was that Meta's login wall, its stripped page and a deleted post all carry no og
 * tags at all, verified over 35 urls on 2026-08-12. That was true when measured and it is not a
 * property Meta has promised anyone: a wall that starts emitting a generic `og:title`/`og:description`
 * pair would turn this read into a card asserting a post that was never read. Checking the host makes
 * the refusal structural, so it survives Meta changing the shape of the wall.
 *
 * HOST ONLY, NOT THE POST ID, and that restraint is deliberate. Facebook rewrites permalinks into the
 * opaque `pfbid…` form, so the numeric id in the ref is frequently absent from the canonical url it
 * publishes — binding to the id would reject live posts to catch a hypothetical one. The host is the
 * part that is stable, and it is the part an unrelated document cannot forge into being.
 */
function fbOwnsUrl(ogUrl: string): boolean {
  if (!ogUrl) return false
  try {
    const h = new URL(ogUrl).hostname.toLowerCase()
    return h === 'facebook.com' || h.endsWith('.facebook.com')
  } catch {
    // A canonical url that will not parse is not a claim of ownership. The strict read never needed
    // this branch because it never trusted og:url for anything load-bearing.
    return false
  }
}

export function facebookPostCard(html: unknown, ref: PostRef, captionOnly = false): Post | null {
  if (ref.p !== 'fb') return null
  if (typeof html !== 'string' || !html) return null

  const image = FB_OG(html, 'image')
  const title = FB_OG(html, 'title')
  const text = FB_OG(html, 'description')
  const ogUrl = FB_OG(html, 'url')
  const picture = fbImage(image)
  // A BYLINE AND SOMETHING TO SAY. og:title is the byline on this surface, and a page carrying no
  // byline at all is the login wall or the stripped shell — a card asserting an empty post is worse
  // than an honest failure. Measured from Cloudflare egress 2026-08-12 over 35 real post urls: all
  // three non-post shapes carry NO og tags whatsoever (a login wall at 438 KB, a stripped page at
  // 325 KB, a deleted post at 325 KB), so this refuses every one of them on either setting.
  if (!title) return null
  if (!picture && !(captionOnly && text && fbOwnsUrl(ogUrl))) return null

  const canonical = ogUrl || fbPageUrl(ref as Extract<PostRef, { p: 'fb' }>)
  const gallery = fbGallery(html)

  return {
    ref: { p: 'fb', kind: ref.kind, id: ref.id },
    canonical,
    author: fbAuthor(title, canonical),
    text,
    // NO DATE ON THIS SURFACE. og carries none, and the resolved url's post id is not the snowflake
    // shape createdAtFromId-style decoding needs. The epoch is the established fallback here
    // (uploadDateOrEpoch does the same for the video path) rather than a guessed "now", which would
    // be a WRONG date rather than an absent one.
    createdAt: new Date(0),
    /**
     * THE GALLERY WHEN THE PAGE PRELOADS ONE, the og:image otherwise. og:image is the post's COVER and
     * is usually present, so it is the floor rather than an extra entry — appending it to a gallery it
     * is already the first member of would ship a duplicate first picture.
     *
     * AN ABSENT og:image YIELDS NO MEDIA AT ALL, not one entry holding the empty string. That used to
     * be unreachable because the guard above required a picture; under `captionOnly` it is the whole
     * point, and an attachment with no url is a picture-shaped hole in the card — the same defect
     * shape as the `og:image=".../_media/undefined/avatar"` this project shipped once already.
     */
    media: (gallery.length ? gallery : picture ? [image] : [])
      .map(url => ({ kind: 'image' as const, url, w: 0, h: 0 })),
    counts: {},
    sensitive: false,
  }
}

/**
 * THE SAME PAGE, READ FOR ITS WORDS — a post that has a byline and a caption but no picture.
 *
 * REPORTED, AND MEASURED FROM CLOUDFLARE EGRESS 2026-08-12 with `wrangler dev --remote`. The url is
 * /NASA/posts/1304655294363177, and it drew the generic failure card while being a perfectly ordinary
 * live public post:
 *
 *   the page   952,579 bytes, og:title "NASA - National Aeronautics and Space Administration",
 *              og:description "Go, Comet 3I/ATLAS, go! ☄️ …", og:url — and NO og:image
 *   the plugin  38,448 bytes, "This Facebook post is no longer available"
 *
 * So BOTH Facebook surfaces answered, neither was walled, and the post was unrenderable anyway: the
 * plugin refuses to embed it, and facebookPostCard's picture requirement refused the page. The
 * caption was sitting in og:description the whole time.
 *
 * IT IS NOT A GUESS ABOUT AN EMPTY PAGE. The rule is og:title AND og:description, both present and
 * both content — the identical shape of facebookPluginCard's "a byline, and either a caption or a
 * picture", which was relaxed the same way on 2026-08-11 for a photo posted with no words. Measured
 * over the same 35 urls: the login wall, the stripped page and a genuinely deleted post carry no og
 * tags at all, so none of them reaches this.
 *
 * LAST, AFTER THE PLUGIN, and that ordering is the safety property rather than a preference. The
 * plugin fragment carries real photos with real dimensions; this carries words. Running it before the
 * plugin would let a page that merely FORGOT its og:image win over a fragment that has the pictures,
 * turning a picture card into a text card. Placed here it can only run where the card was going to be
 * a failure card, so it cannot regress anything that renders today.
 *
 * TWO OF THIRTY-FIVE SAMPLED URLS NEED IT, and both are ordinary text-with-a-link NASA posts —
 * 1304655294363177 and 10150113094966772. That is the honest size of the win: small, and the
 * difference between an honest failure card and the post.
 */
export function facebookCaptionCard(html: unknown, ref: PostRef): Post | null {
  return facebookPostCard(html, ref, true)
}

/**
 * THE GALLERY — every photo on a multi-image post, read from the page's own PRELOAD links.
 *
 * THIS WAS CALLED IMPOSSIBLE AND IT WAS NOT. A crawler UA yields the og: set and exactly one image, so
 * the first conclusion here was that a multi-image post could only render its cover and that a real
 * gallery would need account credentials. The owner disproved it the obvious way — the post shows all
 * its pictures in a logged-out incognito window. The missing piece was the request, not permission:
 * with a full browser header set (see fetch.ts) the page arrives complete.
 *
 * PRELOAD LINKS, NOT <img> TAGS, and the difference is measured rather than stylistic. On the
 * multi-image post the `<img>` elements carry the 5 post photos AND 4 unrelated ones from the
 * surrounding feed, in that order — so any img-based rule needs a "stop after the post" heuristic that
 * nothing in the markup actually supports. `<link rel="preload">` carries EXACTLY the 5, zero
 * strangers, because Facebook preloads precisely what it is about to paint for the main story.
 * Verified against a single-image control on the same page type: 5 photos vs 1.
 *
 * `t39.30808-6` IS THE PHOTO BUCKET; `-1` is the avatar bucket (the commenters' profile pictures live
 * there and would otherwise be scraped in as post media). Filtering on the bucket is what keeps faces
 * out of the gallery.
 *
 * DEDUPED BY MEDIA ID, IN DOCUMENT ORDER. The same photo is preloaded several times at different sizes
 * and the FIRST occurrence wins, which keeps the post's own ordering — a gallery whose pictures shuffle
 * between requests would be worse than one image.
 *
 * BOUNDED AT 10: Discord renders at most a handful, and an unbounded loop over a hostile document is
 * the kind of thing this file's other regexes are all bounded to avoid.
 */
/**
 * The bound is SIZED FROM A REAL TAG, not guessed: the measured link element is 614 bytes because the
 * signed CDN query alone runs ~500 (`stp`, `cstp`, `_nc_ohc`, `oh`, `oe`, …). An earlier 400-char tail
 * silently matched NOTHING and the gallery quietly stayed at one image — a regex that is too tight
 * fails exactly like a feature that was never written, which is why the count is asserted in a test
 * rather than the presence of a gallery.
 *
 * These tags also carry `data-preloader="adp_CometSinglePostDialogContentQuery…"`, which independently
 * confirms the scope is the post's own dialog content. It is deliberately NOT matched on: it is a
 * generated Relay identifier, far likelier to churn than the stable `rel="preload"` + bucket pair.
 */
const FB_PRELOAD = /<link rel="preload" href="(https:\/\/[^"]{20,200}?t39\.30808-6\/\d+_(\d+)_[^"]{0,900}?)"/g
function fbGallery(html: string): string[] {
  const byId = new Map<string, string>()
  for (const m of html.matchAll(FB_PRELOAD)) {
    if (byId.has(m[2])) continue
    // The href is an HTML attribute, so every '&' in the signed query arrives as '&amp;'. Decoding it
    // is what makes the url actually fetchable; a raw one 403s on the signature.
    const url = m[1].replace(/&amp;/g, '&')
    if (fbImage(url)) byId.set(m[2], url)
    if (byId.size >= 10) break
  }
  /**
   * SORTED BY MEDIA ID, which recovers the post's own ordering — DOCUMENT order does not.
   *
   * Measured on the five-photo post: the preload tags appear as 830, 926, 782, 734, 878 while the ids
   * themselves are evenly spaced (…734, …782, …830, …878, …926, step 48) and the LOWEST is exactly the
   * one Facebook publishes as og:image, i.e. the cover. So ascending id gives the real sequence and
   * puts the cover first for free — which matters because the first attachment is the one Discord
   * shows largest. Preload order is a fetch-priority artefact and would shuffle the gallery.
   *
   * Numeric compare via padded string: these ids are 18 digits, past Number.MAX_SAFE_INTEGER, so
   * subtracting them as numbers loses precision exactly where the ids differ.
   */
  return [...byId.entries()]
    .sort((a, b) => (a[0].length - b[0].length) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, url]) => url)
}

/**
 * THE AGE GATE — 'age_restricted' or undefined. POSITIVE, and that word is the whole point.
 *
 * Reported 2026-07-26: /share/Fixture02X/ rendered a generic failure, and the owner supplied the fact
 * this file could not observe — the post is behind an 18+ gate. The page that comes back is NOT empty
 * (304,440 bytes) but carries no og: set and no scontent url at all, so facebookPostCard correctly
 * declines it and, before this, the arm simply gave up.
 *
 * THE TEMPTING FIX WAS THE WRONG ONE, and it is worth naming because this codebase just paid for it:
 * "a substantial page with no og tags is age-gated" is an inference from ABSENT evidence, exactly the
 * shape of instagramPrivateGate's "a username with no data-media-type is private" — which produced a
 * FALSE 🔒 on public posts and took two bug reports to surface. Deleted, geo-blocked and login-walled
 * posts would all land in the same bucket here. A guess that is right about one sample is not a rule.
 *
 * SO THIS KEYS ON FACEBOOK'S OWN NAME FOR THE ERROR instead. `CometAgeInappropriateLoggedOutErrorRoot`
 * / `...Route` are the React route identifiers Meta ships for precisely this state, found by diffing
 * the token sets of a gated page against a working one — the two were the ONLY age-related tokens
 * unique to it. Measured stable and discriminating: 16 occurrences on the gated post across repeat
 * fetches, 0 on both working image posts across repeat fetches.
 *
 * The prefix is matched rather than either full identifier, so a Root/Route rename or a new sibling
 * still trips it; `Comet` scopes it tightly enough that the substring cannot appear incidentally.
 */
const FB_AGE_GATE = 'CometAgeInappropriate'
export function facebookAgeGate(html: unknown): 'age_restricted' | undefined {
  return typeof html === 'string' && html.includes(FB_AGE_GATE) ? 'age_restricted' : undefined
}


/**
 * THE EMBED-PLUGIN SURFACE — the only Facebook post surface measured reachable from this project's
 * datacenter egress, and the reason there is a second Facebook parser at all.
 *
 * WHAT BROKE. On 2026-08-08 every spelling of a reported post answered with the failure card:
 * /share/p/{code}, story.php, /{page}/posts/{pfbid} and /{ownerId}/posts/{id}. The same code against
 * the same url from a RESIDENTIAL ip built the full card — confirmed by running the shipped worker
 * under `wrangler dev`, which holds the runtime constant and moves only the egress.
 *
 * MEASURED FROM CLOUDFLARE EGRESS, 2026-08-08, with `wrangler dev --remote` — which runs this worker
 * on Cloudflare and so answers the question a laptop curl cannot:
 *
 *   /{ownerId}/posts/{id}, rich headers   200, 324,247 bytes, NO og: tags at all
 *   ditto, Twitterbot UA                  200, 307,396 bytes, NO og: tags
 *   ditto, current-Chrome lean headers    200, 322,749 bytes, NO og: tags
 *   /share/p/{code}                       200 -> facebook.com/login/?next=...      A LOGIN WALL
 *   mbasic.facebook.com/{owner}/posts/    200 -> facebook.com/login.php?next=...   A LOGIN WALL
 *   /plugins/post.php?href=...            200,  74,434 bytes, THE POST
 *
 * FOUR CLIENT SHAPES GOT THE SAME STRIPPED PAGE, which is what rules out the tempting header theory —
 * an earlier attempt at this bug added a second header set and was measured to change nothing. Meta
 * now wants a login for the post surfaces from this egress. The plugin endpoint is Meta's own
 * documented embed surface and is not behind that wall.
 *
 * NO og: TAGS HERE, so facebookPostCard cannot be reused: a plugin renders a FRAGMENT, not a document
 * with a head. Every field is read out of the markup instead.
 *
 * WHY IT IS A FALLBACK AND NOT THE FRONT DOOR. The og: surface, when it answers, carries the whole
 * multi-image gallery from its preload links; this one carries what the embed paints. Placed after
 * it, this costs one request on a path that has already failed and cannot regress a post that still
 * renders the richer way.
 *
 * REGEXES ARE BOUNDED, and with a lesson of its own behind it: an unbounded match over this 74 KB
 * single-line document hung a grep hard enough to need killing while it was being explored.
 */
export function fbPluginUrl(pageUrl: string): string {
  return 'https://www.facebook.com/plugins/post.php?href=' + encodeURIComponent(pageUrl)
}

/** The permalink the plugin links back to. `?ref=embed_post` is Meta's marker, not part of the url. */
const FB_PLUGIN_PERMALINK = /href="(https:\/\/www\.facebook\.com\/[^"]{1,200}\/posts\/\d{5,25})\?ref=embed_post"/
/**
 * The byline. TWO anchors carry this marker and BOTH point at the same page: the avatar wraps an
 * <img> and has no text, the byline wraps the name. So the first anchor with actual TEXT is the
 * answer, not the first anchor found.
 *
 * THE NAME IS NESTED, which is the whole reason this captures markup and strips it afterwards. The
 * byline is `<a href="…"><span class="…">WYFF News 4</span></a>`, so a `[^<]` capture matches the
 * empty string before the <span> and the byline reads as textless — which is exactly how the first
 * version of this regex failed, silently, against the real fragment.
 */
const FB_PLUGIN_AUTHOR = /<a[^>]{0,400}?href="(https:\/\/www\.facebook\.com\/[^"?]{1,80})\?ref=embed_post"[^>]{0,200}?>([\s\S]{0,200}?)<\/a>/g
/** The caption sits in a bare <p>. Emoji arrive as <span> wrappers around the character itself. */
const FB_PLUGIN_TEXT = /<p>([\s\S]{0,4000}?)<\/p>/
/**
 * `t39.30808-6` IS THE PHOTO BUCKET and `-1` is the avatar bucket — the SAME discriminator fbGallery
 * documents, reused rather than re-derived. Without it the poster's profile picture is the first
 * image scraped in, and it sits EARLIER in the document than the post's own photo: measured on the
 * reported post, avatar at offset 46,200 and the photo at 47,703.
 */
/**
 * THE TAG BOUND IS SIZED FOR THE ALT TEXT, NOT FOR THE URL, and the previous 1400 was sized for the
 * url — which is why a five-photo post shipped ONE photo.
 *
 * MEASURED FROM CLOUDFLARE EGRESS 2026-08-12 over the 37 photo-bucket <img> tags in 35 real
 * fragments: 531 bytes at the shortest, 1076 median, 1541 at the longest. FOUR exceeded 1400 and all
 * four were in one post — /photo/?fbid=1404157071581288, an NPR five-photo post whose card carried
 * exactly one picture because the other four tags were never matched.
 *
 * WHAT MAKES A TAG LONG is Facebook's own alt text, emitted TWICE: `alt="May be an image of text
 * that says '…'"` and an identical `caption="…"`, both containing a transcription of every word in
 * the picture. A photo of a page of text therefore produces a tag whose length has nothing to do
 * with the signed CDN query the old bound was measured against, and no ceiling worth guessing at.
 * These four also carry `data-src` duplicating the `src`, which alone adds ~700.
 *
 * SO THE BOUND IS HEADROOM OVER THE ATTRIBUTE THAT GROWS, not a measured maximum, and it is stated
 * that way rather than dressed up: two transcriptions of a dense picture can run past 1541 and
 * nothing stops them. `[^>]` cannot cross the tag's own `>`, so the bound is a guard against a
 * hostile document rather than the thing that ends the match — which is why widening it costs
 * nothing and narrowing it silently deletes photos.
 *
 * NOTHING NEW GETS IN. The bucket filter, the dedupe by media id, the ten cap and fbImage's host
 * range-check are all downstream of this and unchanged; a wider tag match can only find MORE of the
 * post's own pictures.
 */
const FB_PLUGIN_IMG = /<img\s[^>]{0,4000}?>/g
/** The photo bucket, and the media id inside it that dedupes one photo across its sizes. */
const FB_PLUGIN_SRC = /src="(https:\/\/[^"]{20,200}?t39\.30808-6\/\d+_(\d+)_[^"]{0,900}?)"/
/**
 * REAL DIMENSIONS, WHICH THE og: SURFACE NEVER HAD. The plugin prints width/height on the <img> —
 * usually: 35 of 37 measured tags, with the other two putting the size in `style` instead, which is
 * what FB_PLUGIN_STYLE_W below exists for. render/mastodon.ts drops `meta.original` entirely when
 * either is 0 — so a card built without these hands Discord an attachment with no size and no aspect
 * ratio. Reading them is the difference between the client sizing the photo correctly and it
 * guessing.
 *
 * Attribute ORDER is not assumed: the whole tag is matched first and these are pulled out of it,
 * because width/height sit after `src` on the measured fragment and nothing promises they stay there.
 */
const FB_PLUGIN_W = /\swidth="(\d{1,5})"/
const FB_PLUGIN_H = /\sheight="(\d{1,5})"/
/**
 * THE OTHER PLACE FACEBOOK PUTS THE SIZE — `style="width:364px;height:364px"`, no width/height
 * attributes anywhere on the tag.
 *
 * MEASURED FROM CLOUDFLARE EGRESS 2026-08-12: two of the 37 photo-bucket tags in the 35-url sample
 * spell it this way, and in both the picture is the WHOLE card — /photo/?fbid=1015656923764640 and
 * /photo/?fbid=1182307926599969, one image each. Both shipped w=0,h=0.
 *
 * ZERO IS NOT A COSMETIC LOSS HERE. render/mastodon.ts drops `meta.original` entirely when either
 * dimension is 0 — deliberately, because "0x0" tells a client the image has no area — and an image
 * attachment with no `meta.original` is one Discord has been observed to draw as NOTHING. So the
 * card that looked like it worked was a card with an invisible picture.
 *
 * IT IS A FALLBACK, tried only when the attribute form is absent, so every tag that renders
 * correctly today keeps the exact numbers it has.
 *
 * THE STYLE IS MATCHED NARROWLY, on `width:<n>px` inside the style attribute, because a style
 * attribute is NOT reliably a size: the same fragment carries `style="left:-3px; top:0px;"` on other
 * photos, and a looser read of it would hand the card a position as a dimension.
 */
const FB_PLUGIN_STYLE = /\sstyle="([^"]{0,300})"/
/**
 * THE PROPERTY IS MATCHED AT A DECLARATION BOUNDARY, and `\b` is not one.
 *
 * The first version of this read `/\bwidth:\s*(\d+)px/` over the whole attribute, which is wrong in a
 * way that produces a plausible number rather than no number. `\b` matches after a HYPHEN, so
 * `max-width:658px` read as width=658 and `line-height:16px` read as height=16 — both verified. Every
 * one of those is a size Discord would have been handed for an image that is not that size, and an
 * invented dimension is worse than the zero this fallback exists to avoid, because a wrong size draws
 * a wrongly-cropped card while a zero at least declines to draw.
 *
 * A CSS declaration starts at the beginning of the attribute or after a `;`, so that is what this
 * anchors on. `max-width`, `min-width` and `line-height` all fail it; `width:398px;height:498px` and
 * `left:-3px; width:398px` both still read correctly.
 */
const fbStyleDim = (style: string, prop: 'width' | 'height'): string | undefined =>
  style.match(new RegExp(String.raw`(?:^|;)\s*${prop}\s*:\s*(\d{1,5})px`))?.[1]
/** One <img> tag's pixel size: the attributes when it has them, the style when it does not. */
function fbPluginDims(tag: string): [number, number] {
  const style = tag.match(FB_PLUGIN_STYLE)?.[1] ?? ''
  const w = Number(tag.match(FB_PLUGIN_W)?.[1] ?? fbStyleDim(style, 'width') ?? 0)
  const h = Number(tag.match(FB_PLUGIN_H)?.[1] ?? fbStyleDim(style, 'height') ?? 0)
  return [w, h]
}
/**
 * THE BYLINE FACEBOOK DOES NOT LINK — the avatar's own label, and the reason the anchor above is not
 * enough on its own.
 *
 * MEASURED FROM CLOUDFLARE EGRESS 2026-08-11, over six real fragments: Facebook emits the poster's
 * name in TWO different shapes and only one of them is inside an anchor.
 *
 *   <a href="…/WYFF4?ref=embed_post"><span class="_2_79 _50f7">WYFF News 4</span></a>   linked
 *   <div class="_2iem"><span class="_2_79 _50f7">Humans of New York</span>…             NOT linked
 *
 * The unlinked shape is not an edge case: every fragment measured for @NASA and @humansofnewyork
 * carried it, so facebookPluginCard returned null for all four of them — INCLUDING for
 * /NASA/posts/1583701703125200, an ordinary post permalink this router has claimed since 2026-08-01.
 * The photo work only found it; the defect is older and wider than photos.
 *
 * WHY THE AVATAR'S LABEL AND NOT THE SPAN. `_2_79` is a generated class of exactly the kind
 * fbGallery's docstring refuses to match on — it churns. `aria-label` on the avatar image is a
 * semantic attribute, it carried the page name in ALL SIX fragments (both shapes), and it is in the
 * `t39.30808-1` avatar bucket, which is the discriminator this file already uses twice.
 *
 * THE FIRST ONE IS THE POSTER'S, and that is not merely an ordering assumption: the plugin renders a
 * post's header and its pictures and no comment thread, and every one of the six fragments carried
 * EXACTLY ONE labelled image in that bucket. If Meta ever server-renders commenters here, the header
 * still comes first in document order and `!labelled` keeps the first.
 *
 * IT IS A FALLBACK, NOT THE FRONT DOOR. Every post that renders today keeps the exact byline it has:
 * the anchor is still tried first, and this only runs when no anchor carried text. Additive by
 * construction, so it cannot regress a card that already works.
 *
 * IT DOES NOT WEAKEN THE FAILURE CHECK. The plugin's own error state carries no avatar at all —
 * measured on a bogus fbid: 38,109 bytes, "This Facebook post is no longer available", zero images in
 * either bucket — so a fragment with no post still yields no name and still returns null.
 */
const FB_PLUGIN_AVATAR = /src="https:\/\/[^"]{20,200}?t39\.30808-1\/[^"]{0,900}?"/
const FB_PLUGIN_LABEL = /\saria-label="([^"]{1,120})"/
/**
 * THE PAGE URL FOR THE UNLINKED SHAPE — an href with no anchor CONTENTS attached to it, which is the
 * whole difference from FB_PLUGIN_AUTHOR above.
 *
 * FB_PLUGIN_AUTHOR cannot serve here: it must reach `</a>` within 200 characters to match at all, and
 * the avatar anchor it would have to match wraps an <img> whose signed CDN query alone runs ~500. So
 * the anchor that names the page is invisible to it, by construction rather than by accident.
 *
 * THE FIRST MATCH IS THE HEADER'S, in document order, which is what makes this the poster's page and
 * not somebody else's: a MENTION inside the caption spells its href `…/{handle}?fref=mentions&ref=…`,
 * and the `[^"?]` class refuses anything with a parameter in front of `ref=embed_post`.
 *
 * IT IS ALSO WHY SOME CARDS GET NO PAGE AT ALL, stated rather than discovered later. Measured
 * 2026-08-11 across six fragments: four spell the page exactly this way, one spells it only as the
 * permalink `…/{page}/posts/{id}?ref=embed_post` (hence the tail strip at the call site), and one
 * spells it ONLY as `…/{page}?fref=nf&ref=embed_post`. Admitting that sixth form would mean admitting
 * `fref=mentions` too, which points at a DIFFERENT account — a wrong byline url is worse than the
 * honest facebook.com fallback the caller already has, so that one is left unclaimed.
 */
const FB_PLUGIN_PAGE = /href="(https:\/\/www\.facebook\.com\/[^"?]{1,80})\?ref=embed_post"/

export function facebookPluginCard(html: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'fb') return null
  if (typeof html !== 'string' || !html) return null

  let name = ''
  let page = ''
  for (const m of html.matchAll(FB_PLUGIN_AUTHOR)) {
    const text = fbDecode(m[2].replace(/<[^>]{0,400}>/g, '')).trim()
    if (text) { page = m[1]; name = text; break }
  }

  const body = html.match(FB_PLUGIN_TEXT)
  // Tags are STRIPPED rather than parsed: the only markup inside a caption is the emoji <span>s, whose
  // text content is the emoji character itself, so dropping the tags keeps it.
  const text = body ? fbDecode(body[1].replace(/<[^>]{0,400}>/g, '')).trim() : ''

  const byId = new Map<string, { url: string, w: number, h: number }>()
  // The avatar's aria-label, kept only if no anchor gave a name — see FB_PLUGIN_AVATAR.
  let labelled = ''
  for (const tag of html.matchAll(FB_PLUGIN_IMG)) {
    const src = tag[0].match(FB_PLUGIN_SRC)
    if (!src) {
      if (!labelled && FB_PLUGIN_AVATAR.test(tag[0])) {
        labelled = fbDecode(tag[0].match(FB_PLUGIN_LABEL)?.[1] ?? '').trim()
      }
      continue
    }
    // The cap is checked BEFORE the insert and skips rather than breaks — it used to `break` after
    // the tenth, which now would end the walk before the avatar is read on any fragment that puts the
    // pictures first. Ten stays the media bound; the walk itself is bounded by the document and by
    // each regex's own length limits.
    if (byId.size >= 10 || byId.has(src[2])) continue
    // The src is an HTML attribute, so every '&' in the signed CDN query arrives as '&amp;'. Decoding
    // it is what makes the url fetchable; a raw one 403s on the signature.
    const url = src[1].replace(/&amp;/g, '&')
    if (!fbImage(url)) continue
    const [w, h] = fbPluginDims(tag[0])
    byId.set(src[2], { url, w, h })
  }
  if (!name && labelled) {
    name = labelled
    // The permalink tail is stripped for the reason fbAuthor strips it on the og: surface: one of the
    // six measured fragments spells the page only as `…/{page}/posts/{id}?ref=embed_post`, and a
    // byline url pointing at a single post rather than at the page is a wrong link, not a shorter one.
    page = (html.match(FB_PLUGIN_PAGE)?.[1] ?? '').replace(/\/posts\/\d{5,25}$/, '')
  }

  /**
   * A BYLINE, AND EITHER A CAPTION OR A PICTURE. The old rule was byline AND caption, and it refused
   * real posts: measured 2026-08-11 from Cloudflare egress, a photo post carrying a byline, one
   * 552x414 photo and ZERO <p> elements (a picture posted with no words, which is an ordinary thing
   * for a photo to be) returned null and drew the failure card.
   *
   * IT IS STILL AN ASSERTION ON CONTENT, not a relaxation into guessing. The plugin's own error state
   * has neither half — measured on a bogus fbid: 38,109 bytes, "This Facebook post is no longer
   * available", no byline anchor, no avatar label, and zero urls in the photo bucket — so it still
   * returns null here. What changed is only that ONE of the two kinds of post content is now enough,
   * where before a post had to have both.
   */
  if (!name || (!text && byId.size === 0)) return null

  const permalink = html.match(FB_PLUGIN_PERMALINK)
  return {
    ref: { p: 'fb', kind: ref.kind, id: ref.id },
    canonical: permalink ? permalink[1] : fbPageUrl(ref as Extract<PostRef, { p: 'fb' }>),
    // No @-handle on this surface, same as the og: one — the renderers omit an empty handle rather
    // than printing "(@)".
    author: { name, handle: '', url: page || 'https://www.facebook.com' },
    text,
    // NO DATE HERE EITHER. The plugin prints a RELATIVE age ("2d"), and a relative age cannot become a
    // timestamp without knowing when the fragment was rendered. The epoch is what the other Facebook
    // surfaces already use for absent, rather than a guessed "now" that would be a WRONG date.
    createdAt: new Date(0),
    media: [...byId.values()].map(m => ({ kind: 'image' as const, url: m.url, w: m.w, h: m.h })),
    counts: {},
    sensitive: false,
  }
}
