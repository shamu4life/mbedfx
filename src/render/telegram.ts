import type { Post } from '../types.ts'
import { esc, html } from './fail.ts'
import { byline, bytesIndex, describe, dimTags, mediaOf, mediaUrl, str, usable } from './embed.ts'
import { buildPlainText } from './text.ts'

/**
 * Telegram's head: plain OpenGraph, ONE picture, and nothing else at all.
 *
 * Split out of discord.ts (plan §10, Task 5) because the two clients stopped wanting the same
 * document. discord.ts now owns a two-headed decision — Mastodon spoof vs plain-og — that
 * Telegram must never take part in, and every tag below is here because of something Telegram
 * specifically does:
 *
 * - NO <link rel="alternate"> of either flavour. The activity+json bet is placed on DISCORD's
 *   behaviour (spec §9), and the oEmbed document we serve is spec-invalid — type 'rich' with
 *   no `html`, which Discord demonstrably tolerates and nothing else is known to. A client
 *   that follows a link and then rejects what it finds can end up worse off than one that
 *   never saw it, so with no evidence there is no link.
 * - NO <meta http-equiv="refresh"> — Telegram HANGS on one. That is why fail.ts's redirect()
 *   is a 302 and why this module cannot grow a "bounce humans" shortcut later.
 * - ONE og:image, never several. Telegram picks a single preview picture; FxEmbed feeds it a
 *   MOSAIC composite of the post's images instead, which needs an image service we do not
 *   have. Our single image is therefore an ACCEPTED DIVERGENCE (wire spec C3), not an
 *   unfinished feature, and Instant View — the other route to multi-image — is out of scope.
 */

/**
 * Build Telegram's head. Total by construction: every input here arrives from the KV cache,
 * which deserializePost validates for ref, canonical and createdAt and nothing else, so this
 * function must not throw on any shape a corrupted record can carry — it is the whole contract
 * of the route, and worker.ts calls render() outside any try/catch.
 */
export function renderTelegram(post: Post, origin: string): Response {
  const media = mediaOf(post)
  const tags = [
    // str(post.author?.…) IS a crash fix, not only a cosmetic one. `author` can be absent from
    // a cache record entirely — deserializePost accepts one, confirmed by round-tripping an
    // author-less record through it — and the raw read this replaced was `Cannot read
    // properties of undefined (reading 'name')`, an uncaught 500 on the degrade path.
    // discord.ts's plain path carried the identical crash until it was fixed alongside this.
    //
    // It is a degradation choice TOO: str() renders a non-string as '' rather than letting a
    // template literal print the literal "undefined" or "[object Object]" at the viewer.
    `<meta property="og:title" content="${esc(byline(post.author))}"/>`,
    // buildPlainText, so reply and quote context survive — this attribute is the ONLY surface
    // either can reach on this head, since Telegram gets no oEmbed document and no activity
    // JSON. Counts-free by that builder's contract (spec §3), which is correct here for a
    // simpler reason than on Discord: there is no second surface for them to appear on.
    //
    // REAL NEWLINES, not <br>. Task 5 says to put <br> in this value for an Instant-View
    // template quirk; doing that is a defect either way it is spelled.
    //
    // NOT because esc() would make it visible as '&lt;br&gt;' — an earlier version of this
    // comment claimed that and it is wrong. Character references ARE decoded inside attribute
    // values, so `content="&lt;br&gt;"` hands the consumer the value `<br>`. The proof is
    // internal: esc() rewrites '&' and '"' precisely BECAUSE the consumer decodes them back,
    // and the whitelist test asserts `&amp;` on the wire on the assumption it reaches Telegram
    // as '&'. Both cannot be true at once.
    //
    // The real reason is the field, not the encoding: og:description is plain text. Whatever
    // spelling reaches the client, nothing parses this attribute as HTML, so a <br> is visible
    // junk in the middle of a standard preview. Instant View — the one consumer that would
    // template it — is explicitly out of scope. A bare \n is legal inside a double-quoted
    // attribute value, so the separation survives with nothing to decode. Every attribute here
    // stays double-quoted for a matching reason: esc() does not escape "'" or a backtick.
    `<meta property="og:description" content="${esc(describe(post, buildPlainText(post)))}"/>`,
    `<meta property="og:url" content="${esc(str(post.canonical))}"/>`,
    `<meta property="og:site_name" content="mbedfx"/>`,
  ]

  // The subject picture, or the absence of one. The property this branch has to hold is
  // "exactly one og:image": OGP resolves duplicates by taking the FIRST tag, so an avatar
  // emitted alongside a post image does not merely add noise, it WINS, and every media post
  // shows the author's face instead of its own picture. Hence one if/else chain, never two
  // independent pushes.
  //
  // usable() before any `.kind` read, in both finds, and mediaOf() around the list itself.
  // media[] survives the JSON cache round trip unvalidated: `media: [null]` makes a raw
  // `m.kind` a TypeError, and a non-array `media` makes `.find` one — 500s out of the module
  // whose entire contract is to degrade. usable() also keeps the promise its url clause makes:
  // an entry with no url resolves through pickMedia to null, so advertising it guarantees a
  // 404, and a broken picture is worse than the avatar this then falls through to.
  //
  // indexOf, never the position in a filtered list. /_media/{key}/{i} is resolved by pickMedia
  // against the raw, uncompacted list, so a corrupt leading entry must not shift the index of
  // the entry we point at — compacting would serve the wrong image for every entry after it.
  //
  // mediaOf(post) and NOT mediaList(post), which is the §7 decision this head also makes and
  // which discord.ts spells out at length: the hoist appends a quoted post's media to the list
  // pickMedia and the Mastodon mapper index, so an index taken here still means the right bytes
  // either way — but the SELECTION must stay the post's own. The video find below prefers a
  // video found ANYWHERE in the list over an image, so a hoisted quote video would take the
  // og:video branch and suppress the parent's own og:image entirely. What keeps that unreachable
  // is THIS mediaOf(post) — a quote's video is never in the list this head selects from. (Do not
  // lean on "Bluesky has no video": that WAS a second guard until 2026-07-22, when Bluesky video
  // became a remux kind:'video', so a quoted Bluesky video is now exactly the hijack this prevents.)
  // Written down in BOTH heads rather than only the one that argued it: a future tidy toward
  // mediaList "for consistency" is what reintroduces the hijack.
  //
  // The cost is recorded rather than hidden: a QUOTE-ONLY post therefore still advertises the
  // author's avatar here, while Discord now shows the quoted picture. Spec §7 names only
  // pickMedia and the Mastodon mapper, and C3 already files Telegram's single-image output as an
  // accepted divergence, so this is in scope — but "no hijack possible when the parent has no
  // media of its own" is a real argument for revisiting it, and it needs its own evidence.
  //
  // Video is preferred over an image ANYWHERE in the list, matching the plain-og path Phase 1
  // shipped rather than the plan's literal "first media". No Bluesky post mixes the two, so the
  // two rules cannot disagree on today's inputs; when a platform that does mix them lands, this
  // is the line that has to make the call, and it should make it deliberately.
  const video = media.find(m => usable(m) && m.kind === 'video')
  if (video) {
    // esc() on the url like every other attribute in this file. mediaUrl interpolates `origin`,
    // which worker.ts derives from the REQUEST (the Host header at the edge), so it is not a
    // constant we control — and Node's URL parser preserves a '"' in a host verbatim, which
    // breaks straight out of the attribute. Production reachability through Cloudflare is
    // unproven, so this is defence in depth rather than a demonstrated hole; esc() is correct
    // for a URL regardless, since '&' in an attribute value belongs as '&amp;' anyway.
    const url = esc(mediaUrl(origin, post, media.indexOf(video)))
    tags.push(`<meta property="og:type" content="video.other"/>`)
    tags.push(`<meta property="og:video" content="${url}"/>`)
    tags.push(`<meta property="og:video:secure_url" content="${url}"/>`)
    tags.push(`<meta property="og:video:type" content="video/mp4"/>`)
    tags.push(...dimTags('og:video', video.w, video.h))
    tags.push(`<meta name="twitter:card" content="player"/>`)
    // Deliberately NO twitter:image="{origin}/_alt/0" here, which is where this head parts
    // company with discord.ts's plain-og path. That trick suppresses DISCORD's still so the
    // player shows — the design spec files it under "Discord rendering" — and it works by
    // pointing at /_alt/0, a path router.ts reserves to dead-end. Handing a client we have
    // never measured a URL we guarantee is dead buys nothing and can only cost.
    //
    // No og:image either. With no still frame of our own the only candidate is the mp4
    // itself, and an og:image that cannot decode is a broken picture, not a fallback.
  } else {
    const img = media.find(m => usable(m) && (m.kind === 'image' || m.kind === 'gif'))
    if (img) {
      // The dimension lie is Discord folklore that Telegram was never measured against, and it
      // is applied anyway — one shared dimTags()/fudge() (embed.ts) is what stops two renderers
      // drifting into disagreeing about the same picture, and halving a 4K image is harmless to
      // a client that did not need the help. dimTags also drops both tags outright when the
      // entry carries no real dimensions, rather than shipping content="undefined".
      // bytesIndex, for the reason discord.ts's og:image gives. Telegram is not a bystander: the post
      // route runs settleMux before render() for EVERY bot class, so a long YouTube video degrades on
      // this head too and its og:image pointed at the same 503-ing video slot.
      tags.push(`<meta property="og:image" content="${esc(mediaUrl(origin, post, bytesIndex(img, media.indexOf(img))))}"/>`)
      tags.push(...dimTags('og:image', img.w, img.h))
      tags.push(`<meta name="twitter:card" content="summary_large_image"/>`)
    } else if (post.author?.avatar) {
      // Only with no usable post media does the avatar become the picture — and it is emitted
      // through /_media/{key}/avatar like everything else, never as the raw CDN url, which is
      // signed, expiring, and would be the one embed reference Discord's media proxy could
      // tell apart from the rest (design spec: that invariant is what lets us skip a
      // 'discord-media' client class entirely).
      tags.push(`<meta property="og:image" content="${esc(mediaUrl(origin, post, 'avatar'))}"/>`)
      tags.push(`<meta name="twitter:card" content="summary"/>`)
    }
  }

  return html(tags.join(''))
}
