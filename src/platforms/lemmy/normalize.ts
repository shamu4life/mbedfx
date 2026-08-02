import type { Media, Post, PostRef } from '../../types.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'

/**
 * PURE: a Lemmy `post_view` / `comment_view` -> a Post. No I/O.
 */

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** Bodies are user-written markdown with no length limit upstream; the card shows a lead, not a page. */
const BODY_CAP = 1000
const capBody = (s: string): string => (s.length <= BODY_CAP ? s : `${s.slice(0, BODY_CAP - 1)}…`)

/**
 * THE INSTANCE AN ACTOR BELONGS TO, read off its `actor_id` rather than assumed to be the instance we
 * asked. On a federated post they differ and the difference is the whole point: reading sopuli.xyz
 * for post 49387259 returns a creator whose actor_id is `https://lemmy.dbzer0.com/u/technocrit` and a
 * community whose actor_id is `https://lemmy.world/c/news` — THREE instances in one card, none of
 * them wrong. Deriving either from `ref.host` would mislabel both.
 */
export function actorInstance(actorId: string): string {
  try {
    return new URL(actorId).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * `!community@instance` — the fediverse-canonical way to name a community, and the reason it leads
 * the card body rather than being dropped.
 *
 * IT IS ALSO THE SAFETY SIGNAL. This platform's central hazard is a post read from the wrong
 * instance (see the PostRef arm: ~20% of default-instance lookups return a real but different post).
 * The fully-qualified community is the field that makes such a mistake VISIBLE at a glance — a card
 * that says `!news@lemmy.world` when the reader expected `!memes@sopuli.xyz` is self-evidently wrong,
 * where a bare "News" would not be. That is worth two lines of body.
 */
export function communityHandle(community: Record<string, unknown> | null): string {
  const name = str(community?.name)
  const inst = actorInstance(str(community?.actor_id))
  if (!name) return ''
  return inst ? `!${name}@${inst}` : `!${name}`
}

/**
 * THE PICTURE. Lemmy posts are usually LINK posts, so there are two candidate urls and they are not
 * interchangeable:
 *
 *   thumbnail_url  the instance's own cached rendition when it has one, and the third-party original
 *                  when it does not. PREFERRED — measured, an origin instance serves its pict-rs copy
 *                  (`{instance}/pictrs/image/{uuid}`) where a mirror of the same post still points at
 *                  the publisher's CDN.
 *   url            the post's link target. Used ONLY when it is itself an image, because for a
 *                  normal link post it is an ARTICLE, and putting an article url in Media.url would
 *                  advertise a picture that is really an HTML page.
 *
 * NO HOST ALLOWLIST IS POSSIBLE HERE and that is measured rather than conceded: 2250 posts carried
 * 74 distinct thumbnail hosts and 122 distinct `post.url` hosts, 10.5% of thumbnails on arbitrary
 * third-party origins (gannett-cdn.com, i.guim.co.uk, upload.wikimedia.org, …). That is fine, because
 * /_media/ 302s images rather than proxying their bytes — the picture is fetched by Discord's own
 * media proxy, never by this Worker, so an arbitrary image host is not an egress of ours.
 */
export function lemmyMedia(view: Record<string, unknown>): Media[] {
  const post = obj(view.post)
  if (!post) return []
  /**
   * `image_details` SITS IN A DIFFERENT PLACE IN EACH SOFTWARE, and both are read because guessing
   * wrong is silent — it yields undefined and costs every dimension rather than failing.
   *
   *   Lemmy   a SIBLING of `post` on the view, shaped `{link, width, height, content_type}`. It is
   *           also INSTANCE-DEPENDENT: measured on the same post, lemmy.dbzer0.com sends it and
   *           sopuli.xyz sends nothing at all. So it is an enrichment, never a requirement.
   *   PieFed  a FIELD ON THE POST, and carries `{width, height}` with NO `link` — the dimensions
   *           describe `thumbnail_url`, which is why `sized` below cannot simply test `pick === detail`.
   */
  const d = obj(view.image_details) ?? obj(post.image_details)
  const detail = str(d?.link)
  const thumb = str(post.thumbnail_url)
  const url = str(post.url)
  const IMG = /\.(?:jpe?g|png|gif|webp|avif)(?:\?|$)/i
  // image_details first, because on Lemmy it is the only candidate that arrives WITH its dimensions.
  const pick = /^https:\/\//i.test(detail) ? detail
    : /^https:\/\//i.test(thumb) ? thumb
      : (/^https:\/\//i.test(url) && IMG.test(url) ? url : '')
  if (!pick) return []
  /**
   * DO THE MEASUREMENTS DESCRIBE THE PICTURE WE CHOSE? Only two cases say yes: we took the Lemmy
   * `link` those dimensions came with, or we took the thumbnail that PieFed's linkless
   * `image_details` is measuring. Applying them to a picture they do not describe would stretch it in
   * Discord — worse than the honest 0x0 below.
   */
  const sized = (!!detail && pick === detail) || (!detail && pick === thumb && !!d)
  // 0x0 when nothing sized it — this codebase's established "we do not know, let the client size it"
  // (reddit, youtube and every Bluesky entry with no aspectRatio do the same).
  return [{ kind: 'image', url: pick, w: (sized && num(d?.width)) || 0, h: (sized && num(d?.height)) || 0 }]
}

/**
 * A REMOVED OR DELETED POST IS A WALL, NOT A CARD. Lemmy still returns a `post_view` for both, with
 * the body and often the title blanked — so rendering it would produce an empty card that looks like
 * our bug. `removed` is a moderator action ON THE INSTANCE WE ASKED, which is exactly the answer the
 * pasting user should get: if the post is removed on their instance, that is what they see.
 */
export const lemmyGone = (post: Record<string, unknown>): boolean =>
  post.removed === true || post.deleted === true

export function normalizeLemmy(
  view: Record<string, unknown>,
  ref: Extract<PostRef, { p: 'lm' }>,
): Post | null {
  const post = obj(view.post)
  if (!post) return null
  if (lemmyGone(post)) return null

  const creator = obj(view.creator)
  const community = obj(view.community)
  const counts = obj(view.counts)

  /**
   * PIEFED SPELLS THE ACTOR'S TWO NAMES DIFFERENTLY, and the collision is the dangerous part:
   * PieFed's `creator.title` holds the DISPLAY name while Lemmy's `post.name` holds the post TITLE,
   * so a careless shared reader crosses them. Measured on piefed.social — handle in
   * `creator.user_name`, display in `creator.title`; Lemmy uses `creator.name` / `creator.display_name`.
   * The spellings are disjoint, so a fallback chain needs no software flag.
   */
  const handle = str(creator?.name) || str(creator?.user_name)
  const creatorInst = actorInstance(str(creator?.actor_id))
  /**
   * THE BODY, or the LINK PREVIEW when there is no body. Most Lemmy posts are link posts with an
   * empty `body`, and the instance has already fetched the target's OpenGraph into
   * `embed_description` — so using it turns a card that would read as just a headline into one
   * carrying the article's own summary. It is the instance's own field, not something we scrape.
   */
  const body = capBody(str(post.body) || str(post.embed_description))
  const com = communityHandle(community)

  return {
    ref,
    /**
     * THE PASTED INSTANCE'S PERMALINK, deliberately — NOT `post.ap_id`.
     *
     * ap_id is the canonical origin (`lemmy.dbzer0.com/post/72978307` for a post pasted from
     * sopuli.xyz) and it is tempting for exactly that reason. But `canonical` is where a HUMAN is
     * 302'd, and sending someone to a different instance than the one they pasted is a surprise: they
     * lose their session, their subscriptions and their vote state. The mirror's permalink renders the
     * same post perfectly well. The origin is not hidden — it is visible in the byline's
     * `name@instance` and in the community handle.
     */
    canonical: new URL(`https://${ref.host}/${ref.kind}/${encodeURIComponent(ref.id)}`).href,
    author: {
      name: str(creator?.display_name) || str(creator?.title) || handle || 'unknown',
      // FULLY QUALIFIED, always — `technocrit@lemmy.dbzer0.com`, never a bare `technocrit`. Two
      // different people can hold the same local name on two instances, so the bare form is not an
      // identity anywhere on the fediverse.
      handle: creatorInst ? `${handle}@${creatorInst}` : handle,
      url: str(creator?.actor_id) || `https://${ref.host}/u/${handle}`,
      ...(/^https:\/\//i.test(str(creator?.avatar)) ? { avatar: str(creator?.avatar) } : {}),
    },
    // Lemmy puts the post title in `name`; PieFed puts it in `title`. See the creator comment above
    // for why these two spellings are read on the POST and never on the creator.
    title: str(post.name) || str(post.title) || undefined,
    // The community leads, then the body. See communityHandle for why this is worth the two lines.
    text: [com, body].filter(Boolean).join('\n\n'),
    createdAt: uploadDateOrEpoch(str(post.published)),
    media: lemmyMedia(view),
    counts: {
      likes: num(counts?.score),
      replies: num(counts?.comments),
    },
    sensitive: post.nsfw === true,
  }
}
