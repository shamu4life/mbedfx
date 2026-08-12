import type { Profile } from '../types.ts'
import { esc, html } from './fail.ts'
import { themeOf } from './embed.ts'
import { abbrev } from './text.ts'

/**
 * THE PROFILE CARD — ONE head, for every bot client, and that is a decision rather than an
 * omission.
 *
 * A post gets two documents (see the file header of discord.ts): Discord reads the Mastodon-shaped
 * status behind `<link rel="alternate" type="application/activity+json">` when there is media to
 * lay out, and the plain OpenGraph head otherwise. The spoof exists to draw ATTACHMENTS — a gallery,
 * an inline player, an author row above them. A profile has none of that: it is a name, a picture,
 * a bio and three numbers. Spoofing a status to carry it would mean minting a status id, which
 * means minting a refKey, which means teaching parseRefKey a new kind (see types.ts's ProfileRef)
 * to gain a layout for content that is not there.
 *
 * SO THERE IS ONE SEAM HERE, not two, and the thing CLAUDE.md warns about — fixing one head and
 * leaving the other broken — cannot happen to this card. What it costs is stated rather than
 * discovered later: no counts row in Discord's own artwork, because that row is the Mastodon
 * `content` block. The counts ride og:description as text instead.
 */

/** Month names, spelled here rather than taken from Intl. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * "Joined April 2023" — MONTH AND YEAR ONLY, in UTC.
 *
 * NOT toLocaleDateString: this string is rendered on Cloudflare and asserted in Node, and the two
 * runtimes are two ICU builds. A card whose text depends on which one drew it is a card no test can
 * pin, and the failure would be invisible until somebody compared prod against a fixture.
 *
 * The DAY is dropped deliberately. It is in the payload and it is true, but a join date is context,
 * not news — and a UTC day is the wrong day for half the planet, which is a small lie on a card
 * whose whole claim is that it does not make them.
 */
function joined(d: Date | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return ''
  return `Joined ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/**
 * The numbers a profile actually has, each present only if the platform stated it.
 *
 * ZERO IS PRINTED. `0 following` is true of plenty of real accounts (bsky.app follows 11; brand
 * accounts commonly follow none) and hiding it would make an account look like one we could not
 * read. That is the opposite of statParts(), which DROPS a zero count on a post — and the
 * difference is deliberate: `❤️ 0` on a post is noise about engagement that did not happen, while
 * `0 followers` is a fact about the account. Absent stays absent either way; see the normalizer's
 * count() for why undefined and 0 are kept apart all the way from the wire.
 *
 * SINGULARS ARE NOT ATTEMPTED. "1 followers" is wrong and "1 follower" needs a rule per label per
 * platform; the counts are abbreviated above a thousand anyway, so the plural form is what almost
 * every card carries. Pluralising is a later cosmetic fix, not a truth fix.
 */
export function profileStats(p: Profile): string[] {
  const parts: string[] = []
  const c = p?.counts
  const add = (n: unknown, label: string) => {
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) parts.push(`${abbrev(n)} ${label}`)
  }
  add(c?.posts, 'posts')
  add(c?.followers, 'followers')
  add(c?.following, 'following')
  const j = joined(p?.createdAt instanceof Date ? p.createdAt : undefined)
  if (j) parts.push(j)
  return parts
}

/**
 * `Name (@handle)`, or `@handle` when the account has no display name.
 *
 * NOT byline() from embed.ts, and the difference is measured rather than stylistic: byline assumes
 * a name is always there — every post normalizer defaults one — and renders `${name} (@${handle})`,
 * which for an empty name is a card titled with a LEADING SPACE. On Bluesky a display name is
 * optional and plenty of accounts have none, so the empty case is ordinary here rather than a
 * corrupted record.
 */
export function profileTitle(p: Profile): string {
  const name = typeof p?.name === 'string' ? p.name : ''
  const handle = typeof p?.handle === 'string' ? p.handle : ''
  if (!handle) return name
  return name ? `${name} (@${handle})` : `@${handle}`
}

/**
 * The description body: the bio, then the numbers, with a blank line between them so a client that
 * renders newlines shows two blocks and one that does not still reads as a sentence.
 *
 * The bio is NEVER truncated here. Discord truncates its own description and does it better than a
 * character count would; a fixer that cuts first cuts twice.
 */
export function profileDescription(p: Profile): string {
  const bio = typeof p?.bio === 'string' ? p.bio.trim() : ''
  const stats = profileStats(p).join(' · ')
  return bio && stats ? `${bio}\n\n${stats}` : bio || stats
}

/**
 * Every tag on this head, and why each is here:
 *
 *   og:title        `Name (@handle)` — the account, named the way the platform names it now.
 *   og:description  bio + counts.
 *   og:url          the canonical the NORMALIZER built, so a DID url shows the current handle.
 *   og:site_name    'mbedfx', matching both post heads.
 *   og:image        the avatar, as an ORIGIN url — the one place in this codebase that emits one,
 *                   admitted only under the CDN allowlist in the normalizer, which is what makes
 *                   the "no signed url reaches Discord's cache" rule structural. ABSENT rather
 *                   than a placeholder when the account has no avatar: a 404 image is worse than
 *                   no image, the og:image=".../undefined/avatar" scar.
 *   twitter:card    'summary' — the small-thumbnail layout, which is what an avatar is. The post
 *                   heads use summary_large_image for a post's own picture; using it here would
 *                   ask Discord to draw a 128px avatar as a banner.
 *   theme-color     BOTH spellings from ONE value, exactly as the two post heads do. name= is the
 *                   standard and the one Discord reads; property= is what the fxtwitter forks
 *                   emit. One call, so they cannot disagree.
 *
 * NO og:type=profile, deliberately. OGP defines the type and it takes first_name/last_name/username
 * — a Western name split this card cannot fill for a display name, and Discord does not draw
 * anything extra for it. An unsupported type with unfillable required properties is markup that
 * claims a shape it does not have.
 */
export function renderProfile(p: Profile, _origin: string): Response {
  const colour = themeOf(p?.ref?.p)
  const avatar = typeof p?.avatar === 'string' ? p.avatar : ''
  return html(
    `<meta property="og:title" content="${esc(profileTitle(p))}"/>` +
    `<meta property="og:description" content="${esc(profileDescription(p))}"/>` +
    `<meta property="og:url" content="${esc(typeof p?.canonical === 'string' ? p.canonical : '')}"/>` +
    `<meta property="og:site_name" content="mbedfx"/>` +
    (avatar ? `<meta property="og:image" content="${esc(avatar)}"/>` : '') +
    `<meta name="twitter:card" content="summary"/>` +
    `<meta name="theme-color" content="${colour}"/>` +
    `<meta property="theme-color" content="${colour}"/>`,
  )
}
