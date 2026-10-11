import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { GUEST_HOSTS, GUEST_MARK, guestServes, isGuestHost } from '../src/guesthost.ts'
import { route } from '../src/router.ts'

/**
 * GUEST HOSTS: sorryifuckedyour.mom and hotsinglesnear.you belong to the owner's you-stupid Worker,
 * which serves its own page at `/` and hands every path it has no file for to this Worker through a
 * service binding. src/guesthost.ts has the argument. These tests pin the two halves of the contract
 * that Worker relies on: an embed path is answered exactly as on mbedfx.app and carries the mark, and
 * everything else is declined, unmarked, before any work is spent on it.
 *
 * Every request here goes through handle(), the same entry the binding reaches. No network: the post
 * is a stub, and ASSETS throws, because a guest host must never be served mbedfx's own files.
 */

const GUEST = 'https://hotsinglesnear.you'
const BOT = { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }
const PERSON = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }
const ctx = { waitUntil() {} }

const fakeCache = () => {
  const m = new Map()
  return {
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}

const jack = () => ({
  ref: { p: 'x', id: '20' },
  canonical: 'https://x.com/jack/status/20',
  author: { name: 'jack', handle: 'jack', url: 'https://x.com/jack', avatar: 'https://example.invalid/a.jpg' },
  text: 'just setting up my twttr',
  createdAt: new Date('2006-03-21T20:50:14Z'),
  counts: { likes: 1 },
  sensitive: false,
  media: [{ kind: 'image', url: 'https://example.invalid/one.jpg', w: 800, h: 600 }],
})

const env = (assets = async () => { throw new Error('ASSETS must not be reached on a guest host') }) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { fetch: assets },
  TRANSLATE_GOOGLE: 'off',
})

const deps = (fetchPost = async () => jack()) => ({
  cache: fakeCache(),
  fetchPost,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

test('a post link on a guest host unfurls as the post, and every callback the card names stays on that host', async () => {
  /**
   * THE FEATURE. `x.com` swapped for `hotsinglesnear.you` has to draw the same card mbedfx.app does,
   * and the card has to send Discord back to the SAME host for its activity document and its media,
   * because those callbacks arrive at you-stupid first and only reach here through the binding. A card
   * that named mbedfx.app would still work, but it would publish mbedfx.app in a link the owner chose
   * a different domain for. The origin has always been the request's own (worker.ts, `origin`), and
   * this pins that it survives the binding.
   *
   * Each answer must carry the mark, or you-stupid throws it away and serves the dating page instead.
   */
  const d = deps()
  const card = await handle(new Request(`${GUEST}/jack/status/20`, { headers: BOT }), env(), ctx, d)
  assert.equal(card.headers.get(GUEST_MARK), 'served')
  const html = await card.text()
  assert.match(html, /<meta property="og:title" content="jack \(@jack\)"\/>/)
  assert.match(html, /<meta property="og:url" content="https:\/\/x\.com\/jack\/status\/20"\/>/)
  assert.doesNotMatch(html, /mbedfx\.app/, 'nothing in the card may point at another of our hosts')

  const activity = html.match(/type="application\/activity\+json" href="([^"]+)"/)?.[1]
  assert.ok(activity?.startsWith(`${GUEST}/`), `the activity link is minted on the guest host, got ${activity}`)
  const status = await handle(new Request(activity, { headers: BOT }), env(), ctx, d)
  assert.equal(status.headers.get(GUEST_MARK), 'served')
  const doc = await status.json()
  assert.equal(doc.url, 'https://x.com/jack/status/20')
  const media = doc.media_attachments?.[0]?.url
  assert.ok(media?.startsWith(`${GUEST}/_media/`), `media is fetched back through the guest host, got ${media}`)

  const bytes = await handle(new Request(media, { headers: BOT }), env(), ctx, d)
  assert.equal(bytes.headers.get(GUEST_MARK), 'served')
  assert.equal(bytes.headers.get('location'), 'https://example.invalid/one.jpg')
})

test('a person who opens a guest-host post link is sent to the original post, as on every serving domain', async () => {
  /**
   * A card is for a crawler. A person clicking the link in Discord wants the post, and on mbedfx.app
   * they get a 302 to it. A guest host must not change that into something else, and the redirect
   * must be marked like any other answer, or you-stupid would show the dating page to the one reader
   * who asked for the post.
   */
  const res = await handle(new Request(`${GUEST}/jack/status/20`, { headers: PERSON }), env(), ctx, deps())
  assert.equal(res.headers.get('location'), 'https://x.com/jack/status/20')
  assert.equal(res.headers.get(GUEST_MARK), 'served')
})

test('a guest host declines everything that is not an embed, unmarked, before spending a fetch', async () => {
  /**
   * THE OTHER HALF, and the one that keeps the owner's site working. you-stupid serves its own page for
   * any unknown path, so a typo on the dating domain still lands on the joke. If this Worker answered
   * `/foo` with its chooser, `/robots.txt` with its own robots file, or `/` with the converter, those
   * would replace the dating site's own answers. The diagnostics and the experiments are in the list
   * because they reach upstreams or the container, and a domain that is not ours is not where they
   * are run from.
   *
   * Nothing may be spent on a decline: ASSETS and fetchPost throw, and the cache would too if read.
   */
  const boom = async () => { throw new Error('a declined path must not fetch') }
  const d = { ...deps(boom), cache: { match: boom, put: boom } }
  const declined = [
    '/', '/index.html', '/robots.txt', '/favicon.ico', '/og.jpg', '/openapi.json',
    '/foo', '/whoami', '/@jack', '/images/nope.png',
    '/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20', '/_card?p=%2Fjack%2Fstatus%2F20',
    '/_prep?p=%2Fjack%2Fstatus%2F20',
    '/_smoke', '/_clients', '/_stock/1/dQw4w9WgXcQ', '/_wait/a/5/dQw4w9WgXcQ', '/_wait/media/3/x',
    '/users/youtube/statuses/910511', '/_oembed/nope',
  ]
  for (const path of declined) {
    for (const headers of [BOT, PERSON]) {
      const res = await handle(new Request(`${GUEST}${path}`, { headers }), env(), ctx, d)
      assert.equal(await res.text(), 'not served on this host\n', `${path} must be declined on a guest host`)
      assert.equal(res.headers.get(GUEST_MARK), null, `${path} must come back unmarked`)
      assert.equal(res.status, 404)
    }
  }
})

test('mbedfx own domains are untouched: no decline, and no mark', async () => {
  /**
   * The gate runs on every request, so it must be a no-op off a guest host. /robots.txt reaches
   * ASSETS as it always has, and a card carries no guest mark, which would otherwise tell any reader
   * of the headers about a domain this one has nothing to do with.
   */
  let asked = null
  const assets = async req => { asked = new URL(req.url).pathname; return new Response('User-agent: *\nDisallow: /\n') }
  const robots = await handle(new Request('https://mbedfx.app/robots.txt'), env(assets), ctx, deps())
  assert.equal(asked, '/robots.txt')
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n')

  const card = await handle(new Request('https://mbedfx.app/jack/status/20', { headers: BOT }), env(), ctx, deps())
  assert.match(await card.text(), /og:title" content="jack \(@jack\)"/)
  assert.equal(card.headers.get(GUEST_MARK), null)
})

test('a guest host is matched on whole labels, so a lookalike domain is not one', () => {
  /**
   * isGuestHost decides which requests lose their front door, so a loose match would decline `/` on a
   * domain that has nothing to do with you-stupid. The anchoring is the same `.endsWith('.' + h)` rule
   * fedihost.ts uses.
   */
  for (const h of GUEST_HOSTS) {
    assert.equal(isGuestHost(h), true)
    assert.equal(isGuestHost(`www.${h}`), true, 'a subdomain belongs to the same Worker')
    assert.equal(isGuestHost(h.toUpperCase() + '.'), true, 'case and a trailing dot are not a different host')
    assert.equal(isGuestHost(`not${h}`), false)
    assert.equal(isGuestHost(`${h}.example.com`), false)
  }
  assert.equal(isGuestHost('mbedfx.app'), false)
})

test('a guest host is never claimed as a route here, because another Worker owns it', () => {
  /**
   * A hostname is a custom domain of exactly one Worker, and wrangler.jsonc's routes are reconciled on
   * every deploy. Listing a guest host there would try to move the domain off you-stupid, taking the
   * owner's site down with it. The binding is how these hosts reach this Worker, and the only way.
   */
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const claimed = (cfg.routes ?? []).map(r => r.pattern.split('/')[0])
  for (const g of GUEST_HOSTS) {
    assert.ok(!claimed.some(h => h === g || h.endsWith(`.${g}`)), `${g} belongs to you-stupid, not to wrangler.jsonc`)
  }
})

test('/_card says when a guest host would pass the path to the other site, and only then', async () => {
  /**
   * Since 2026-10-11 the converter offers the guest hosts as domain buttons (owner's call), and it can
   * emit a path a guest host declines: a profile pasted from x.com is a bare `/{handle}`, which the
   * router answers with a chooser. On mbedfx.app that draws the chooser or "Not found"; on a guest host
   * it is the other site's own page that Discord unfurls. The converter's preview says so, and it learns
   * which paths those are HERE rather than from a copy of guestServes' list in the page, which a new
   * Route kind would silently fall out of (the converter's `direct` lesson). So `guestDeclines` must be
   * exactly `!guestServes(route(path))`, present only when true, so every answer about a path a guest
   * host serves is byte-identical to what it was.
   *
   * Asked on mbedfx.app, where the page lives: the router is host-blind, so the answer does not depend
   * on which of our domains served the page.
   */
  const cardOf = async p => {
    const res = await handle(new Request(`https://mbedfx.app/_card?p=${encodeURIComponent(p)}`), env(), ctx, deps())
    return res.json()
  }
  const cases = ['/jack', '/@jack', '/x/jack', '/', '/jack/likes', '/jack/status/20', '/jack/status/20.mp4', '/profile/bsky.app']
  for (const p of cases) {
    const j = await cardOf(p)
    const declines = !guestServes(route(new URL(p, 'https://mbedfx.app')))
    if (declines) assert.equal(j.guestDeclines, true, `${p}: a guest host declines it, and /_card says so`)
    else assert.ok(!('guestDeclines' in j), `${p}: a guest host serves it, so the key is absent, not false`)
  }
  // The cases must cover both answers, or the loop above proves nothing.
  assert.equal((await cardOf('/jack')).guestDeclines, true)
  assert.equal((await cardOf('/jack')).reason, 'ambiguous', 'the reason it always had is unchanged beside it')
  const post = await cardOf('/jack/status/20')
  assert.equal(post.ok, true)
  assert.ok(!('guestDeclines' in post))
  const profile = await cardOf('/profile/bsky.app')
  assert.equal(profile.reason, 'profile')
  assert.ok(!('guestDeclines' in profile), 'a profile is answered on a guest host, so it is not flagged')
})
