import type { ClientClass } from './types.ts'

const GENERIC_BOT = /bot|crawler|spider|preview/

/**
 * Lowercased substring match, ordered, first match wins.
 *
 * There is deliberately no `discord-media` class. Discord's media proxy sends a
 * fake browser UA (Firefox/38), but it only ever fetches /_media/* URLs, which
 * behave identically for every client class. Detecting it would require matching
 * chrome/96.0.4664.110 — a real Chrome build — and denying real people the redirect.
 */
export function classify(ua: string | null): ClientClass {
  if (!ua) return 'human'
  const s = ua.toLowerCase()
  if (s.includes('discordbot')) return 'discord'
  if (s.includes('telegrambot')) return 'telegram'
  if (
    s.includes('facebookexternalhit') ||
    s.includes('slackbot') ||
    s.includes('whatsapp') ||
    GENERIC_BOT.test(s)
  ) {
    return 'other-bot'
  }
  return 'human'
}
