import type { Media, Post, PostRef } from '../../types.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'

/** PURE: a Misskey `Note` -> a Post. No I/O. */

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const https = (v: unknown): boolean => /^https:\/\//i.test(str(v))

const BODY_CAP = 900
const capBody = (s: string): string => (s.length <= BODY_CAP ? s : `${s.slice(0, BODY_CAP - 1)}…`)

/**
 * A PURE RENOTE CARRIES ITS PAYLOAD IN `renote` — Misskey's boost, and the same unwrap the Mastodon
 * client does for `reblog`.
 *
 * THE DISTINCTION MISSKEY HAS AND MASTODON DOES NOT: a note with BOTH `renote` and its own `text` is
 * a QUOTE, not a boost, and its own text is the point. So the unwrap is conditional on the outer note
 * being empty — unwrapping a quote would silently discard the quoter's commentary, which is usually
 * the only reason the link was shared.
 */
export function effectiveNote(note: Record<string, unknown>): Record<string, unknown> {
  const renote = obj(note.renote)
  if (!renote) return note
  const ownText = str(note.text).trim()
  const ownFiles = arr(note.files).length
  return ownText || ownFiles ? note : renote
}

/**
 * THE ATTACHMENTS, and every field name differs from Mastodon's.
 *
 * `type` IS A MIME STRING (`image/webp`, `video/mp4`), not an enum — so the kind is read off the
 * prefix. Treating it as Mastodon's `image`/`video` enum would match nothing and drop all media.
 *
 * DIMENSIONS ARE IN `properties`, and are `{}` FOR VIDEO on every instance measured — so a Misskey
 * video is always 0x0 here, this codebase's established "we do not know, let the client size it".
 *
 * A VIDEO OFTEN HAS NO POSTER AT ALL: `thumbnailUrl` was null on the video sampled from
 * transfem.social. That is honest — types.ts notes a posterless video drops Discord to plain
 * OpenGraph — but inventing one by reusing the video url would be the worse failure, so it is left
 * absent. `thumbnailUrl` is also refused when it equals `url`, the same guard the Mastodon client
 * needs for Pleroma.
 *
 * `isSensitive` IS PER FILE. There is no note-level flag in this API, so the post is sensitive if any
 * attachment is (or if the note carries a CW) — computed in normalizeMisskey.
 */
export function misskeyMedia(note: Record<string, unknown>): Media[] {
  const out: Media[] = []
  for (const raw of arr(note.files)) {
    const f = obj(raw)
    if (!f) continue
    const url = str(f.url)
    if (!https(url)) continue
    const mime = str(f.type).toLowerCase()
    const props = obj(f.properties)
    const w = num(props?.width)
    const h = num(props?.height)
    const alt = str(f.comment).trim()
    const common = { url, w, h, ...(alt ? { alt } : {}) }
    if (mime.startsWith('image/')) {
      // An animated GIF really is a .gif file here, which is exactly what Media.kind 'gif' means.
      out.push({ kind: mime === 'image/gif' ? 'gif' : 'image', ...common })
    } else if (mime.startsWith('video/')) {
      const thumb = str(f.thumbnailUrl)
      const realPoster = https(thumb) && thumb !== url
      out.push({ kind: 'video', ...common, ...(realPoster ? { poster: thumb } : {}) })
    }
    // audio/* and everything else is dropped: there is no Media kind for it, and advertising an
    // audio file as a picture is worse than omitting it.
  }
  return out
}

export function normalizeMisskey(
  note: Record<string, unknown>,
  ref: Extract<PostRef, { p: 'mk' }>,
): Post | null {
  const inner = effectiveNote(note)
  const user = obj(inner.user)
  if (!user) return null

  const username = str(user.username)
  /**
   * `user.host` IS NULL FOR A LOCAL ACCOUNT and carries the origin domain for a remote one — the same
   * information Mastodon packs into `acct`, spelled as a separate field. Fully qualifying it is the
   * same rule as everywhere else in this project: a bare username is not an identity on the fediverse.
   */
  const handle = `${username}@${str(user.host) || ref.host}`
  const boosted = inner !== note

  const cw = str(inner.cw).trim()
  // `text` IS PLAIN TEXT, not HTML — Misskey stores MFM source, so there are no tags to strip and
  // running it through an HTML-to-text pass would eat literal '<' characters an author wrote.
  const body = capBody(str(inner.text).trim())
  const text = [
    boosted ? `🔁 boosted by @${str(obj(note.user)?.username)}@${str(obj(note.user)?.host) || ref.host}` : '',
    cw ? `⚠️ ${cw}` : '',
    body,
  ].filter(Boolean).join('\n\n')

  const media = misskeyMedia(inner)

  return {
    ref,
    // The PASTED instance's permalink, for the same reason as Lemmy and the Mastodon family: sending
    // someone to a different instance than the one they pasted costs them their session and votes.
    canonical: new URL(`https://${ref.host}/notes/${encodeURIComponent(ref.id)}`).href,
    author: {
      // `name` is the display name and is frequently null; `username` is the fallback.
      name: str(user.name) || username || 'unknown',
      handle,
      url: https(user.avatarUrl) && str(user.host)
        ? `https://${str(user.host)}/@${encodeURIComponent(username)}`
        : `https://${ref.host}/@${encodeURIComponent(username)}`,
      ...(https(user.avatarUrl) ? { avatar: str(user.avatarUrl) } : {}),
    },
    title: undefined,
    text,
    createdAt: uploadDateOrEpoch(str(inner.createdAt)),
    media,
    counts: {
      /**
       * MISSKEY HAS NO FAVOURITES — it has emoji REACTIONS, and `reactionCount` is their total. That
       * is the closest analogue to a like and is what the card shows, the same judgement Pinterest's
       * `saves` gets.
       */
      likes: num(inner.reactionCount) || undefined,
      replies: num(inner.repliesCount) || undefined,
      reposts: num(inner.renoteCount) || undefined,
    },
    // No note-level flag exists in this API — see misskeyMedia. A CW counts, and so does any single
    // attachment the author marked.
    sensitive: !!cw || arr(inner.files).some(f => obj(f)?.isSensitive === true),
  }
}
