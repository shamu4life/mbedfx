import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/classify.ts'

test('recognises Discord and Telegram crawlers', () => {
  assert.equal(classify('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), 'discord')
  assert.equal(classify('TelegramBot (like TwitterBot)'), 'telegram')
})

test('matching is case-insensitive substring', () => {
  assert.equal(classify('DISCORDBOT/2.0'), 'discord')
  assert.equal(classify('telegrambot'), 'telegram')
})

test('recognises other bots', () => {
  for (const ua of ['facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'WhatsApp/2.19',
                    'SomeRandomCrawler/1.0', 'generic-spider', 'PreviewFetcher/2']) {
    assert.equal(classify(ua), 'other-bot', ua)
  }
})

test('real humans are humans', () => {
  assert.equal(classify('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'), 'human')
  assert.equal(classify('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'), 'human')
  assert.equal(classify(null), 'human')
  assert.equal(classify(''), 'human')
  assert.equal(classify('curl/8.4.0'), 'human')
})

test('Discord media-proxy UAs are NOT special-cased — a real Chrome 96 human stays human', () => {
  // Discord's media proxy sends a fake Firefox/38 UA. We do not detect it: it only
  // ever hits /_media/*, which behaves identically for every class. FxEmbed hardcodes
  // firefox/38|firefox/92|chrome/96.0.4664.110 — and chrome/96.0.4664.110 is a REAL
  // Chrome build, so that approach denies real people the redirect.
  assert.equal(classify('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:38.0) Gecko/20100101 Firefox/38.0'), 'human')
  assert.equal(classify('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'), 'human')
})

test('ordering: Discordbot wins even when the UA also looks generic', () => {
  assert.equal(classify('Discordbot/2.0 crawler'), 'discord')
})
