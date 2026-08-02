import type { Media, Post, PostRef } from '../../types.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'
import { htmlToText } from '../html.ts'

/** PURE: a Mastodon-API `Status` -> a Post. No I/O. */

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const https = (v: unknown): boolean => /^https:\/\//i.test(str(v))

/** Microblog bodies are short by design, but a Pleroma instance can raise the limit to 5000+. */
const BODY_CAP = 900
const capBody = (s: string): string => (s.length <= BODY_CAP ? s : `${s.slice(0, BODY_CAP - 1)}…`)

/**
 * An `acct` safe to place in a URL path RAW. Deliberately not encodeURIComponent, which escapes '@'
 * and turns the ordinary remote-account permalink into
 * `https://mstdn.social/@Portes_Thomas%40mastox.eu/…` — a URL Mastodon never mints, ugly in a card,
 * and needlessly different from the one the user pasted.
 *
 * The class admits exactly what a handle can contain and nothing that could change the URL's meaning:
 * no '/', '?', '#', ':' or '%', so a hostile acct cannot escape its segment or smuggle a query. An
 * acct that fails this falls back to the username-free permalink rather than being escaped into one.
 */
const ACCT_SAFE = /^[A-Za-z0-9_.-]{1,64}(?:@[A-Za-z0-9_.-]{1,253})?$/

/**
 * A BOOST CARRIES ITS PAYLOAD IN `reblog` AND NOTHING IN ITSELF — measured on a real boost
 * (mstdn.social 116987635278582716): the outer status's `content` is the EMPTY STRING and it has no
 * media. Rendering the outer object would produce a blank card, so the unwrap is not a nicety.
 *
 * The outer status is still the thing the user pasted, so `canonical` stays on it and the booster is
 * named in the body — but the content, media, counts and timestamp all come from the inner post,
 * which is where they exist.
 */
export function effectiveStatus(status: Record<string, unknown>): Record<string, unknown> {
  return obj(status.reblog) ?? status
}

/**
 * THE HANDLE, FULLY QUALIFIED — always `user@instance`, never a bare `user`.
 *
 * `account.acct` is ALREADY qualified for a remote account (`Portes_Thomas@mastox.eu`) and BARE for a
 * local one (`stux`), because it is written from the reading instance's point of view. A bare handle
 * is not an identity anywhere on the fediverse — two people can hold the same local name on two
 * instances — so the reading host is appended when the API omitted it. Same rule as Lemmy's byline.
 */
export function fullHandle(acct: string, host: string): string {
  if (!acct) return ''
  return acct.includes('@') ? acct : `${acct}@${host}`
}

/**
 * THE ATTACHMENTS.
 *
 * `gifv` MAPS TO 'video', NOT TO OUR 'gif', and the distinction is a defect waiting to happen. Our
 * `Media.kind === 'gif'` means THE URL IS AN ANIMATED .gif FILE, and render/mastodon.ts deliberately
 * maps it to an `image` attachment for that reason. Mastodon's `gifv` is the opposite: a soundless
 * looping MP4 produced by converting a GIF. Calling it 'gif' would hand Discord mp4 bytes labelled as
 * an image — the same class of mistake as the Phase 2 poster defect recorded in types.ts.
 *
 * `audio` AND `unknown` ARE DROPPED rather than guessed at. There is no audio kind in Media, and an
 * attachment whose type the instance itself could not determine is not something to advertise as a
 * picture.
 *
 * DIMENSIONS COME FROM `meta.original`, which is absent on remote attachments an instance has not
 * finished processing; 0x0 is this codebase's established "we do not know, let the client size it".
 */
export function mastoMedia(status: Record<string, unknown>): Media[] {
  const out: Media[] = []
  for (const raw of arr(status.media_attachments)) {
    const m = obj(raw)
    if (!m) continue
    const url = str(m.url)
    if (!https(url)) continue
    const type = str(m.type)
    const meta = obj(obj(m.meta)?.original)
    const w = num(meta?.width)
    const h = num(meta?.height)
    const alt = str(m.description).trim()
    const common = { url, w, h, ...(alt ? { alt } : {}) }
    if (type === 'image') {
      out.push({ kind: 'image', ...common })
    } else if (type === 'video' || type === 'gifv') {
      /**
       * THE POSTER IS REFUSED WHEN IT IS THE VIDEO ITSELF, and this guard is the whole reason this
       * branch is not two lines.
       *
       * On Mastodon `preview_url` is a real generated still. ON PLEROMA IT IS NOT: measured on
       * stereophonic.space, a video attachment returns `url`, `preview_url`, `remote_url` and
       * `text_url` all set to THE SAME .webm, and `meta` set to null. Passing that through would
       * hand Discord a poster that is really video bytes — precisely the Phase 2 defect recorded in
       * types.ts, where a bad poster dropped the rich activity card back to plain OpenGraph. A
       * posterless video is a worse card; a video whose poster IS the video is a broken one.
       */
      const poster = str(m.preview_url)
      const realPoster = https(poster) && poster !== url
      out.push({
        kind: 'video',
        ...common,
        ...(num(meta?.duration) ? { duration: num(meta?.duration) } : {}),
        // MANDATORY on a video when it exists — a posterless video drops Discord's rich card to
        // plain OpenGraph (types.ts, Media.poster).
        ...(realPoster ? { poster } : {}),
      })
    }
  }
  return out
}

export function normalizeMasto(
  status: Record<string, unknown>,
  ref: Extract<PostRef, { p: 'ms' }>,
): Post | null {
  const inner = effectiveStatus(status)
  const account = obj(inner.account)
  if (!account) return null

  const acct = str(account.acct)
  const handle = fullHandle(acct, ref.host)
  const booster = inner !== status ? str(obj(status.account)?.acct) : ''

  /**
   * A CONTENT WARNING LEADS THE BODY AND IS NOT SUPPRESSED.
   *
   * `spoiler_text` is the author's own summary of what follows, so it is the single most useful line
   * on the card and always shown. The text it guards is shown too: the flag below marks the post
   * sensitive, which is what drives the renderer's existing `[sensitive]` marker and Discord's blur —
   * hiding the body as well would leave a card that says nothing, and this project already treats a
   * blank card as worse than a warned one.
   */
  const cw = str(inner.spoiler_text).trim()
  const body = capBody(htmlToText(str(inner.content)))
  const text = [
    booster ? `🔁 boosted by @${fullHandle(booster, ref.host)}` : '',
    cw ? `⚠️ ${cw}` : '',
    body,
  ].filter(Boolean).join('\n\n')

  return {
    ref,
    /**
     * THE PASTED INSTANCE'S PERMALINK, NEVER `status.url` — and this one is not a preference, it is a
     * correctness bug avoided.
     *
     * `status.url` is the ORIGIN's url for the post, and on a bridged account the origin is not even
     * fediverse software. Measured on a real status read from mstdn.social:
     *
     *     status.url = https://twitter.com/somos_FOX/status/2081974010259104079
     *     status.uri = https://sportsbots.xyz/users/somos_FOX/statuses/2081974010259104079
     *
     * Using `url` as canonical would 302 someone who clicked a Mastodon link to TWITTER. A Pleroma
     * origin gives `/objects/{uuid}` — a different id space that our own router cannot route back.
     * The pasted host always renders the post, so it is what we send people to. (Same conclusion as
     * Lemmy's ap_id, reached for a stronger reason.)
     *
     * The username is decoration — verified, `/@anything/{id}` 302s to the same status — but the real
     * handle is used anyway so a human reading the URL sees something true.
     */
    canonical: new URL(
      ACCT_SAFE.test(acct)
        ? `https://${ref.host}/@${acct}/${encodeURIComponent(ref.id)}`
        // The username-free permalink, verified to 302 to the same status. Used when the acct is not
        // URL-safe, so a strange handle degrades to a working link rather than an escaped one.
        : `https://${ref.host}/statuses/${encodeURIComponent(ref.id)}`,
    ).href,
    author: {
      name: str(account.display_name) || str(account.username) || acct || handle || 'unknown',
      handle,
      // The account's OWN profile url, which for a remote account points at its home instance — the
      // right destination, and the one place an origin url is not a trap.
      url: https(account.url)
        ? str(account.url)
        : `https://${ref.host}/@${encodeURIComponent(acct)}`,
      ...(https(account.avatar) ? { avatar: str(account.avatar) } : {}),
    },
    // A microblog post has no title. Leaving it undefined keeps the card from opening with an empty
    // bold block.
    title: undefined,
    text,
    createdAt: uploadDateOrEpoch(str(inner.created_at)),
    media: mastoMedia(inner),
    counts: {
      likes: num(inner.favourites_count) || undefined,
      replies: num(inner.replies_count) || undefined,
      reposts: num(inner.reblogs_count) || undefined,
    },
    // `sensitive` is set by the instance whenever media is marked or a CW is present, but a CW alone
    // is checked too rather than trusting one field to imply the other.
    sensitive: inner.sensitive === true || !!cw,
  }
}
