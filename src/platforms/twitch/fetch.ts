import type { PostRef } from '../../types.ts'
import { TWITCH_SLUG } from '../../refkey.ts'
import { askTwice } from '../../fetchretry.ts'

/**
 * I/O ONLY. Twitch's public web GraphQL endpoint, unauthenticated.
 *
 * THE SURFACE. `POST https://gql.twitch.tv/gql` with the PUBLIC WEB Client-ID that twitch.tv's own
 * player sends. It is not a secret and not ours: it is the same literal every logged-out browser tab
 * presents, which is why this platform needs no stored credential (contrast twitter/fetch.ts, where
 * the equivalent surface genuinely does).
 *
 * PERSISTED QUERIES ARE DEAD — do not "optimise" this back into one. Sending the
 * `extensions.persistedQuery.sha256Hash` form that most Twitch scrapers use answers
 * `PersistedQueryNotFound`; the hashes rotate with Twitch's web build and we have no way to learn the
 * current one. A RAW query string works and is what is sent below (verified 2026-07-27).
 *
 * ONE CALL GETS EVERYTHING, and that is the whole reason clips are cheap here: the clip metadata, the
 * rendition list AND the playback token come back together, so there is no second round trip between
 * "what is this clip" and "how do I play it".
 *
 * ASSERT ON CONTENT, NEVER ON STATUS. Every failure shape measured 2026-07-27 — a slug that does not
 * exist, an empty slug, a path-traversal string — is HTTP 200 with `{"data":{"clip":null}}` and NO
 * `errors` array. So liveness is `data.clip` being an object carrying its own slug, and nothing else.
 */

const GQL = 'https://gql.twitch.tv/gql'

/**
 * The public web client's id, as sent by every logged-out twitch.tv tab. Verified live 2026-07-27
 * against four real clips. If Twitch ever rotates it the symptom is a uniform `data.clip: null` on
 * every slug, which reads here as assert_fail — the honest "couldn't load" card, never a wrong clip.
 */
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

export type TwitchClip = {
  slug: string
  title: string
  createdAt: string
  durationSeconds: number
  viewCount: number
  thumbnailURL: string
  /** Twitch's own advisory labels — see twitchSensitive() in normalize.ts for which ones we act on. */
  labels: string[]
  broadcaster: { login: string; displayName: string; profileImageURL: string }
  curator: { login: string; displayName: string } | null
  game: { name: string } | null
  videoQualities: { quality: string; sourceURL: string }[]
  playbackAccessToken: { signature: string; value: string } | null
}

export type TwitchFetch =
  | { ok: true; clip: TwitchClip }
  | { ok: false; reason: 'assert_fail' | 'age_restricted' }

/**
 * RAW GraphQL, one call. `playbackAccessToken`'s params are the web player's own
 * (platform/playerBackend/playerType); they are what make Twitch mint a token valid for the clip's
 * `/nauth/` renditions, which answer 401 without one (measured on all four qualities).
 */
const CLIP_QUERY = `query($slug:ID!){
  clip(slug:$slug){
    slug title createdAt durationSeconds viewCount thumbnailURL
    contentClassificationLabels{id}
    broadcaster{login displayName profileImageURL(width:150)}
    curator{login displayName}
    game{name}
    videoQualities{quality sourceURL}
    playbackAccessToken(params:{platform:"web",playerBackend:"mediaplayer",playerType:"site"}){signature value}
  }
}`

/** Narrow an unknown to a record without asserting its field types. */
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * THE ONE GATE TWITCH ACTUALLY REPORTS. The playback token's `value` is a JSON *string* carrying
 * `authorization: {forbidden, reason}`. A healthy clip measured `{"forbidden":false,"reason":""}`.
 * A refusal is therefore a POSITIVE signal we can read rather than an absence we would have to infer
 * from — the distinction instagram/normalize.ts's false-🔒 defect was about, and the reason this is
 * read here instead of "no playable rendition => probably age-gated".
 *
 * TOTAL OVER JUNK: the value is upstream JSON inside upstream JSON, so a parse failure must mean
 * "no gate reported", never a throw.
 */
export function twitchForbidden(token: { value?: unknown } | null | undefined): boolean {
  const v = str(token?.value)
  if (!v) return false
  try {
    const a = obj(obj(JSON.parse(v))?.authorization)
    return a?.forbidden === true
  } catch {
    return false
  }
}

/**
 * A thrown fetch is NOT caught — the worker treats a thrown live fetch as null, exactly as the sibling
 * platform fetchers do. Only *upstream answers* are classified here.
 */
export async function fetchTwitchClip(ref: Extract<PostRef, { p: 'tw' }>): Promise<TwitchFetch> {
  if (!TWITCH_SLUG.test(ref.slug)) return { ok: false, reason: 'assert_fail' }
  const res = await askTwice(GQL, {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': BROWSER_UA,
    },
    body: JSON.stringify({ query: CLIP_QUERY, variables: { slug: ref.slug } }),
  })
  // Status is checked only to avoid parsing an edge/error page as JSON; the REAL assertion is below.
  if (!res.ok) return { ok: false, reason: 'assert_fail' }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'assert_fail' }
  }
  const clip = obj(obj(obj(body)?.data)?.clip)
  // The measured miss shape: data.clip === null at HTTP 200, no errors array.
  if (!clip || !str(clip.slug)) return { ok: false, reason: 'assert_fail' }

  const token = obj(clip.playbackAccessToken)
  if (twitchForbidden(token)) return { ok: false, reason: 'age_restricted' }

  const bc = obj(clip.broadcaster)
  // The broadcaster is the byline; without a login there is no author and no canonical, so this is a
  // miss rather than a partially-filled card.
  if (!bc || !str(bc.login)) return { ok: false, reason: 'assert_fail' }
  const cur = obj(clip.curator)
  const game = obj(clip.game)

  const quals = Array.isArray(clip.videoQualities) ? clip.videoQualities : []
  return {
    ok: true,
    clip: {
      slug: str(clip.slug),
      title: str(clip.title),
      createdAt: str(clip.createdAt),
      durationSeconds: num(clip.durationSeconds),
      viewCount: num(clip.viewCount),
      thumbnailURL: str(clip.thumbnailURL),
      labels: (Array.isArray(clip.contentClassificationLabels) ? clip.contentClassificationLabels : [])
        .flatMap(l => {
          const id = str(obj(l)?.id)
          return id ? [id] : []
        }),
      broadcaster: {
        login: str(bc.login),
        displayName: str(bc.displayName) || str(bc.login),
        profileImageURL: str(bc.profileImageURL),
      },
      curator: cur && str(cur.login)
        ? { login: str(cur.login), displayName: str(cur.displayName) || str(cur.login) }
        : null,
      game: game && str(game.name) ? { name: str(game.name) } : null,
      videoQualities: quals.flatMap(q => {
        const r = obj(q)
        const quality = str(r?.quality)
        const sourceURL = str(r?.sourceURL)
        return quality && sourceURL ? [{ quality, sourceURL }] : []
      }),
      playbackAccessToken: token && str(token.signature) && str(token.value)
        ? { signature: str(token.signature), value: str(token.value) }
        : null,
    },
  }
}
