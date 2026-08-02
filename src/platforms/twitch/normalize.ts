import type { Media, Post, PostRef } from '../../types.ts'
import { twitchMediaHost } from '../../mediaproxy.ts'
import { uploadDateOrEpoch } from '../uploaddate.ts'
import type { TwitchClip } from './fetch.ts'

/**
 * PURE: a clip payload -> a Post. No I/O, no clock except uploadDateOrEpoch's future bound (see
 * uploaddate.ts for why that read is named rather than hidden).
 */

/**
 * THE RENDITION WE HAND DISCORD, and the number is measured rather than chosen for taste.
 *
 * Clip DeliciousDelightfulPicklesWOOP (44 seconds) measured 2026-07-27:
 *
 *     1080p  44,778,948 bytes
 *      720p  14,054,837 bytes
 *      480p   4,225,487 bytes
 *      360p   3,274,116 bytes
 *
 * 1080p is 44MB for forty-four seconds. mediaproxy.ts's module docstring records what a 38MB file did
 * on the Instagram path — Discord drew NO CARD AT ALL for the reel that size, while the small one
 * rendered — and although the Twitch CDN advertises `accept-ranges: bytes` (which Instagram's big file
 * did not) and the mp4 is faststart (`moov` immediately after `ftyp`, so ~128KB answers a metadata
 * probe), asking a chat client to pull 44MB to preview a joke clip is the wrong default at three times
 * the bytes for a size nobody views full-screen in Discord.
 *
 * So: the HIGHEST rendition at or below 720. Not "the first one Twitch listed" (that is 1080), and not
 * a hardcoded '720' string (a clip whose source was captured at 480 offers no 720 at all, and an exact
 * match would then find nothing and fall to whatever the fallback was).
 */
const MAX_HEIGHT = 720

/**
 * `sourceURL` under `/nauth/` is 401 WITHOUT a token — measured on all four renditions of a healthy
 * public clip, so this is not an edge case but the normal path. The signed form is the one Twitch's
 * own player builds: the signature and the token's raw JSON *value*, the latter percent-encoded
 * because it is a JSON document (braces, quotes, colons) going into a query parameter.
 *
 * ONE SIGNATURE COVERS EVERY RENDITION. The token's embedded `clip_uri` names the 360 file, which
 * reads as if the token were scoped to it; it is not — the same sig returned 206 on 1080, 720, 480 and
 * 360 alike. Worth stating, because "the token names 360 so we must serve 360" is the obvious wrong
 * conclusion from looking at the payload.
 */
export function signedClipUrl(sourceURL: string, token: { signature: string; value: string } | null): string | null {
  if (!token || !sourceURL) return null
  // The host check is mediaproxy's own predicate, IMPORTED rather than respelled: this url goes into
  // Media.url, which /_media/ streams, so it is the same SSRF-relevant question that route asks. Two
  // copies of one boundary is two places for one of them to drift, and the drift is the vulnerability
  // — the rule allowedHost's docstring already states for the Instagram recovery path.
  if (!twitchMediaHost(sourceURL)) return null
  return `${sourceURL}?sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`
}

/** `…/thumb/thumb-0000000000-1920x1080.jpg` — the only place the clip's real aspect is stated. */
const THUMB_DIMS = /-(\d{2,5})x(\d{2,5})\.(?:jpg|jpeg|png|webp)(?:\?|$)/i

/**
 * WIDTH AND HEIGHT, derived rather than assumed 16:9.
 *
 * `videoQualities[].quality` is a HEIGHT ('720'), and the payload states no width anywhere. The
 * thumbnail url does: its filename ends `-1920x1080.jpg`, and its path segment names the orientation
 * (`/landscape/`). Portrait clips exist — Twitch has had mobile broadcasting since 2019 — so hardcoding
 * 16:9 would letterbox them in Discord, which sizes the player from these numbers.
 *
 * Falls back to 16:9 only when the thumbnail carries no dimensions at all, which is the honest default
 * for a platform whose desktop broadcast is 16:9.
 */
export function clipDimensions(quality: string, thumbnailURL: string): { w: number; h: number } {
  const h = Number.parseInt(quality, 10)
  const height = Number.isFinite(h) && h > 0 && h <= 4320 ? h : 720
  const m = THUMB_DIMS.exec(thumbnailURL || '')
  const tw = m ? Number.parseInt(m[1], 10) : 0
  const th = m ? Number.parseInt(m[2], 10) : 0
  const aspect = tw > 0 && th > 0 ? tw / th : 16 / 9
  return { w: Math.round(height * aspect), h: height }
}

/**
 * WHICH OF TWITCH'S OWN LABELS MEAN "SPOILER THIS IN DISCORD".
 *
 * `Clip.contentClassificationLabels` is real and it stacks; six ids were observed across a live
 * census (2026-07-27): MatureGame, DebatedSocialIssuesAndPolitics, ProfanityVulgarity, SexualThemes,
 * DrugsIntoxication, Gambling. They are ADVISORY, not a gate — every labelled clip still returned
 * `authorization.forbidden: false` and played — so they belong on Post.sensitive, which is a
 * presentation flag, and NOT on the failure path.
 *
 * ONLY TWO ARE ACTED ON, and the other four are excluded on purpose rather than overlooked:
 *   - MatureGame is attached to any M-rated title, which is a large share of all of Twitch. Marking
 *     every Call of Duty clip sensitive would make the flag meaningless.
 *   - ProfanityVulgarity is near-universal on the channels that produce the most clips.
 *   - DebatedSocialIssuesAndPolitics is a topic label, not a content warning; spoilering political
 *     discussion is an editorial act this tool has no business performing.
 *   - Gambling is a real concern but it is a subject, not depiction, and it is the one most likely to
 *     be attached to ordinary slot-stream reaction clips.
 * SexualThemes and DrugsIntoxication are the two that match what every other platform here means by
 * `sensitive`, which is what keeps this field comparable across platforms.
 *
 * DO NOT USE broadcaster.broadcastSettings.isMature FOR THIS. It is the channel's CURRENT stream
 * flag, not the clip's: measured, xQc's channel reads `isMature: false` while his clips carry
 * ProfanityVulgarity. It describes a live broadcast that may be years newer than the clip.
 */
const SENSITIVE_LABELS = new Set(['SexualThemes', 'DrugsIntoxication'])

export const twitchSensitive = (labels: string[]): boolean =>
  labels.some(l => SENSITIVE_LABELS.has(l))

/** The highest rendition at or below MAX_HEIGHT; the lowest available if every one exceeds it. */
export function pickRendition(
  qualities: { quality: string; sourceURL: string }[],
): { quality: string; sourceURL: string } | null {
  const ranked = qualities
    .map(q => ({ ...q, n: Number.parseInt(q.quality, 10) }))
    .filter(q => Number.isFinite(q.n) && q.n > 0 && q.sourceURL)
    .sort((a, b) => b.n - a.n)
  if (!ranked.length) return null
  return ranked.find(q => q.n <= MAX_HEIGHT) ?? ranked[ranked.length - 1]
}

export function twitchClipUrl(login: string, slug: string): string {
  // The CANONICAL a human is 302'd to. clips.twitch.tv/{slug} also resolves, but the channel-qualified
  // form is what Twitch itself puts in the address bar, and it survives with the channel visible in
  // the link text.
  return new URL(`https://www.twitch.tv/${login}/clip/${slug}`).href
}

/**
 * A CLIP ALWAYS RENDERS SOMETHING, and the three-way degradation below is measured rather than
 * defensive boilerplate.
 *
 *   VIDEO   a rendition on the live fleet plus a token — the normal case.
 *   STILL   a rendition on the live fleet but NO token. The token is the only missing piece, so the
 *           thumbnail is live and the card degrades to its cover, exactly as the Instagram copyright
 *           path does (a video we cannot play becomes its cover, never a dead player).
 *   NOTHING every rendition is off the live fleet — the TOMBSTONE (see twitchMediaHost). On those
 *           clips the THUMBNAIL IS DEAD TOO: it 302s to Twitch's own `404_preview.jpg`. So this
 *           branch deliberately emits NO media rather than falling back to the poster, because the
 *           poster fallback would render a grey Twitch placeholder and look like our bug. The title,
 *           broadcaster, game and view count are all still real, so a text card is the honest answer.
 *
 * The distinction between STILL and NOTHING is exactly why this reads the rendition HOST rather than
 * just asking "did signedClipUrl return null" — both cases produce a null url, and collapsing them
 * would either lose a good cover or ship a broken one.
 */
export function normalizeTwitchClip(clip: TwitchClip, ref: Extract<PostRef, { p: 'tw' }>): Post {
  const rendition = pickRendition(clip.videoQualities)
  const onLiveFleet = !!rendition && twitchMediaHost(rendition.sourceURL)
  const signed = rendition ? signedClipUrl(rendition.sourceURL, clip.playbackAccessToken) : null
  // A rendition list that exists but is entirely off the live fleet is the tombstone; its thumbnail
  // is a 404 placeholder, so it is not offered as a cover. An EMPTY rendition list is a different
  // (unmeasured) shape and keeps the cover, which is the safer direction for an unknown.
  const tombstoned = clip.videoQualities.length > 0 && !onLiveFleet
  const poster = !tombstoned && /^https:\/\//i.test(clip.thumbnailURL) ? clip.thumbnailURL : undefined

  const media: Media[] = []
  if (signed && rendition) {
    const { w, h } = clipDimensions(rendition.quality, clip.thumbnailURL)
    media.push({
      kind: 'video',
      url: signed,
      w,
      h,
      duration: clip.durationSeconds > 0 ? clip.durationSeconds : undefined,
      // MANDATORY on a video: types.ts records that a posterless video drops Discord's rich card back
      // to plain OpenGraph. Twitch always supplies one, so this is never the undefined branch in
      // practice — the guard is for a payload that omitted it.
      ...(poster ? { poster } : {}),
    })
  } else if (poster) {
    const { w, h } = clipDimensions('1080', clip.thumbnailURL)
    media.push({ kind: 'image', url: poster, w, h })
  }

  // The game is the one piece of context a clip title usually omits, and the curator is the person
  // Twitch itself credits under "Clipped by". Both are optional; neither invents text when absent.
  const parts: string[] = []
  if (clip.game) parts.push(clip.game.name)
  if (clip.curator && clip.curator.login !== clip.broadcaster.login) {
    parts.push(`Clipped by ${clip.curator.displayName}`)
  }

  return {
    ref,
    canonical: twitchClipUrl(clip.broadcaster.login, clip.slug),
    author: {
      name: clip.broadcaster.displayName,
      handle: clip.broadcaster.login,
      url: new URL(`https://www.twitch.tv/${clip.broadcaster.login}`).href,
      ...(/^https:\/\//i.test(clip.broadcaster.profileImageURL)
        ? { avatar: clip.broadcaster.profileImageURL }
        : {}),
    },
    title: clip.title || undefined,
    text: parts.join(' · '),
    createdAt: uploadDateOrEpoch(clip.createdAt),
    media,
    counts: { views: clip.viewCount > 0 ? clip.viewCount : undefined },
    // Twitch's OWN advisory labels, filtered to the two that mean what every other platform here
    // means by `sensitive` — see SENSITIVE_LABELS for why the other four are excluded. A hard refusal
    // is a different mechanism entirely (the playback token's `authorization.forbidden`, read by
    // fetch.ts's twitchForbidden) and never reaches this function.
    sensitive: twitchSensitive(clip.labels),
  }
}
