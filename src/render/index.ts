import type { ClientClass, Outcome } from '../types.ts'
import { renderPost } from './discord.ts'
import { renderTelegram } from './telegram.ts'
import { HOST, displayName, renderChooser } from './chooser.ts'
import { errorEmbed, redirect } from './fail.ts'

/**
 * The only entry point. Never assumes a Post: the ambiguous path never resolved
 * to one and the failure path never got one.
 *
 * `origin` comes from the request, never a constant — a hardcoded prod origin
 * would make staging embeds point Discord's media proxy at the live prod worker.
 */
export function render(outcome: Outcome, client: ClientClass, origin: string): Response {
  const isHuman = client === 'human'

  switch (outcome.kind) {
    case 'post':
      // worker.ts 302s humans before fetching; this keeps it correct if one arrives here.
      if (isHuman) return redirect(outcome.post.canonical)

      // Telegram has its own renderer (Task 6), and the split is by CLIENT — the one thing
      // this function legitimately knows — not by anything about the post. What that module
      // owes Telegram is a list of absences (no callback links, no meta refresh, exactly one
      // picture, no /_alt/0), and absences are the failure mode a shared renderer full of
      // `if (client === …)` produces by accident: a tag added for Discord reaches Telegram
      // unless someone remembers it must not. Two modules make that structural.
      if (client === 'telegram') return renderTelegram(outcome.post, origin)

      // Discord and every other bot go to renderPost, which branches on `client` itself since
      // Task 5 — Discord with media gets the Mastodon-spoof head, everything else the plain-og
      // one. That gate deliberately does NOT live here: it is a statement about which meta
      // tags suppress which others, so it belongs beside the tags, and hoisting it would put a
      // Discord-shaped concern in front of 'ambiguous' and 'failure', which must ignore it.
      return renderPost(outcome.post, client, origin)

    case 'ambiguous': {
      if (isHuman) return renderChooser(outcome.path, outcome.candidates)
      // No prefix advice: bare profiles are not a post shape in any phase, so
      // "/x/mrbeast" would 404. Name the sites instead.
      const names = outcome.candidates.map(c => HOST[c]).join(' or ')
      return errorEmbed(
        'Ambiguous link',
        `${outcome.path} is a valid link on ${names}, and replacing the domain threw away which. ` +
        `Post links work; bare profile links cannot.`,
      )
    }

    case 'failure':
      if (isHuman) {
        return outcome.canonical ? redirect(outcome.canonical) : new Response('not found\n', { status: 404 })
      }
      // A DISTINCT, calmer embed PER GATE, checked AFTER the human short-circuit so a human still 302s
      // to the canonical (where they can log in) and never sees these cards. A gated post is a known
      // limit, not a fetch error — hence the owner's calmer copy and a neutral grey (#657786, Twitter's
      // muted grey) in place of errorEmbed's alarm red. Glyphs: 🔞 U+1F51E (age), 🔒 U+1F512 (private).
      // worker.ts sets outcome.gate only for a RECOGNIZED wall (Twitter tombstone / guest reason;
      // TikTok status codes / isContentClassified); every other failure leaves gate undefined and falls
      // through to the LOUD DEFAULT below.
      if (outcome.gate === 'age') {
        return errorEmbed('🔞 This post is age-restricted', "Can't preview age-restricted posts.", '#657786')
      }
      if (outcome.gate === 'private') {
        return errorEmbed('🔒 This post is private', "Can't preview posts from a private account.", '#657786')
      }
      // LOUD DEFAULT. A recognized post we could not load is almost never OUR bug — it is a wall we did
      // not specifically classify (a deleted post, a private/age shape we don't yet detect, a region
      // block). The old copy, "{Platform} extraction failed" in alarm red, read as a tool error and
      // taught users the fixer was broken. Render it instead as the SAME calm neutral (#657786) the
      // 🔞/🔒 cards use, with honest hedged copy — we genuinely don't know which limit it is, so we
      // name the likely ones. A real outage still shows up for the operator in analytics (fetch_fail /
      // assert_fail fire upstream regardless of card); the user just sees an honest "couldn't load".
      if (outcome.platform) {
        // displayName, NOT the raw outcome.platform: the CODE ('x') must never reach a user — titling
        // with it read "x …" on every platform. The code identifier stays 'x'; only the DISPLAYED
        // string maps to prose ('x' -> 'Twitter'), via the shared per-platform map (never a hardcode).
        return errorEmbed(`Couldn't load this ${displayName(outcome.platform)} post`,
          'It may be private, removed, or unavailable.', '#657786')
      }
      // A genuinely unrecognizable ROUTE (no platform) is not "a post we couldn't load" — it is "this
      // is not a link we handle". That stays the plain red "Not found": there is nothing to hedge about.
      return errorEmbed('Not found', outcome.reason)
  }
}
