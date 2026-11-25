import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { GUEST_MARK, guestHosts, guestServes, isGuestHost } from '../src/guesthost.ts'
import { fetchableInstance } from '../src/platforms/fedihost.ts'
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
 *
 * REWRITTEN 2026-11-25 (self-hosting phase 4): which hosts are guests used to be a constant in
 * src/guesthost.ts, imported here. It is now the GUEST_HOSTS var, so the tests that pinned the public
 * instance's behaviour run with wrangler.production.jsonc's own vars in `env`, read through the same
 * parser the Worker uses, and assert exactly what they asserted before. The tests at the bottom cover
 * what the var adds: unset means no guest hosts, and a self-hoster's value routes and refuses theirs.
 */

const PROD_VARS = JSON.parse(readFileSync('wrangler.production.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')).vars
const GUEST_HOSTS = guestHosts(PROD_VARS.GUEST_HOSTS)
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

// Production's vars, GUEST_HOSTS among them. `vars` replaces them, for the self-hoster tests below.
const env = (assets = async () => { throw new Error('ASSETS must not be reached on a guest host') }, vars = PROD_VARS) => ({
  ...vars,
  AE: { writeDataPoint() {} },
  ASSETS: { fetch: assets },
  TRANSLATE_GOOGLE: 'off',
})

test('production\'s GUEST_HOSTS var names exactly the two hosts the constant named', () => {
  /**
   * The var replaced `['sorryifuckedyour.mom', 'hotsinglesnear.you']` in src/guesthost.ts. Every test
   * above the self-hoster section runs on this value, so this is what makes them the same tests as
   * before: a third name, a lost one or a different spelling turns this red first.
   */
  assert.deepEqual(GUEST_HOSTS, ['sorryifuckedyour.mom', 'hotsinglesnear.you'])
  assert.ok(GUEST.endsWith(GUEST_HOSTS[1]))
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

test('the d. prefix works on a guest host: the post\'s file, marked, with its own hop kept on that d. host', async () => {
  /**
   * Since 2026-10-11 d.sorryifuckedyour.mom and d.hotsinglesnear.you are custom domains of you-stupid
   * (shamu4life/you-stupid#22), whose host checks take any subdomain of either, so a d. request reaches
   * this Worker through the same binding with its hostname intact. The worker reads `d.` off the hostname
   * on every domain (worker.ts DIRECT_MEDIA_HOST) and the guest gate matches subdomains (isGuestHost), so
   * the two compose with nothing new: a post link answers with the file instead of a card, marked, and the
   * file's /_media/ hop stays on the d. host, marked too. Before that the d. names had no DNS, and the
   * converter put a `.mp4` on the path instead; that spelling still answers the same file.
   */
  for (const g of GUEST_HOSTS) {
    const d = deps()
    for (const headers of [BOT, PERSON]) {
      const res = await handle(new Request(`https://d.${g}/jack/status/20`, { headers }), env(), ctx, d)
      assert.equal(res.status, 302)
      assert.equal(res.headers.get('location'), `https://d.${g}/_media/x%3A20/0`, `${g}: to the file, on the same d. host`)
      assert.equal(res.headers.get(GUEST_MARK), 'served', 'marked, or you-stupid would serve its own page instead')
    }
    const bytes = await handle(new Request(`https://d.${g}/_media/x%3A20/0`, { headers: BOT }), env(), ctx, d)
    assert.equal(bytes.headers.get(GUEST_MARK), 'served')
    assert.equal(bytes.headers.get('location'), 'https://example.invalid/one.jpg')
    const mp4 = await handle(new Request(`https://${g}/jack/status/20.mp4`, { headers: BOT }), env(), ctx, d)
    assert.equal(mp4.headers.get('location'), `https://${g}/_media/x%3A20/0`, 'the .mp4 spelling still answers the file')
    assert.equal(mp4.headers.get(GUEST_MARK), 'served')
    // The d. host's front page is still the other site's: declined, unmarked.
    const root = await handle(new Request(`https://d.${g}/`, { headers: PERSON }), env(), ctx, d)
    assert.equal(root.status, 404)
    assert.equal(root.headers.get(GUEST_MARK), null)
  }
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
  const spec = PROD_VARS.GUEST_HOSTS
  for (const h of GUEST_HOSTS) {
    assert.equal(isGuestHost(h, spec), true)
    assert.equal(isGuestHost(`www.${h}`, spec), true, 'a subdomain belongs to the same Worker')
    assert.equal(isGuestHost(h.toUpperCase() + '.', spec), true, 'case and a trailing dot are not a different host')
    assert.equal(isGuestHost(`not${h}`, spec), false)
    assert.equal(isGuestHost(`${h}.example.com`, spec), false)
  }
  assert.equal(isGuestHost('mbedfx.app', spec), false)
})

test('a guest host is never claimed as a route here, because another Worker owns it', () => {
  /**
   * A hostname is a custom domain of exactly one Worker, and wrangler.production.jsonc's routes are reconciled on
   * every deploy. Listing a guest host there would try to move the domain off you-stupid, taking the
   * owner's site down with it. The binding is how these hosts reach this Worker, and the only way.
   */
  const cfg = JSON.parse(readFileSync('wrangler.production.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const claimed = (cfg.routes ?? []).map(r => r.pattern.split('/')[0])
  for (const g of GUEST_HOSTS) {
    assert.ok(!claimed.some(h => h === g || h.endsWith(`.${g}`)), `${g} belongs to you-stupid, not to wrangler.production.jsonc`)
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

/* ============ GUEST_HOSTS IS A VAR (self-hosting phase 4, 2026-11-25) ============
 *
 * Until 2026-11-25 every deployment declined `/` on the owner's two domains and could have no guest host
 * of its own without editing src/guesthost.ts. These pin what the var changes for everyone else, and that
 * it changes nothing about the SSRF guard's built-in refusals.
 */

const SELF = 'guest.example'

test('UNSET MEANS NO GUEST HOSTS: the owner\'s two domains get mbedfx\'s front door, unmarked, and stay refused as instances', async () => {
  /**
   * A fork that never heard of you-stupid must not decline its own front page on somebody else's
   * domain because this repo's constant said so. Unset, handle() is serve() everywhere: `/` reaches
   * ASSETS and nothing is marked. The SSRF guard still refuses both names, because they are written
   * out in fedihost.ts's built-in list as well as read from the var, so losing the var never
   * re-opens the two-Worker loop.
   */
  for (const vars of [{}, { GUEST_HOSTS: '' }, { GUEST_HOSTS: '  , ' }]) {
    let asked = null
    const assets = async req => { asked = new URL(req.url).pathname; return new Response('page') }
    const root = await handle(new Request(`${GUEST}/`, { headers: PERSON }), env(assets, vars), ctx, deps())
    assert.equal(asked, '/', `${JSON.stringify(vars)}: the converter page is served`)
    assert.equal(root.headers.get(GUEST_MARK), null)
    const card = await handle(new Request(`${GUEST}/jack/status/20`, { headers: BOT }), env(undefined, vars), ctx, deps())
    assert.match(await card.text(), /og:title" content="jack \(@jack\)"/)
    assert.equal(card.headers.get(GUEST_MARK), null, 'a card on a host that is not a guest carries no mark')
    assert.equal(isGuestHost('hotsinglesnear.you', vars.GUEST_HOSTS), false)
  }
  for (const h of ['sorryifuckedyour.mom', 'hotsinglesnear.you', 'd.hotsinglesnear.you']) {
    assert.equal(fetchableInstance(h), false, `${h} stays a built-in refusal with no env at all`)
  }
  assert.equal(fetchableInstance(SELF), true, 'and no other host is refused on its account')
})

test('A SELF-HOSTER\'S GUEST_HOSTS routes their host as a guest: embeds answered and marked, everything else declined', async () => {
  /**
   * The same contract production's two get, on a host this repo has never heard of. The decline list is
   * a sample of the full one above; what is being shown is that the var, not a constant, decides it.
   */
  const vars = { GUEST_HOSTS: `https://${SELF.toUpperCase()}., other.example` }
  assert.deepEqual(guestHosts(vars.GUEST_HOSTS), [SELF, 'other.example'], 'an origin, case and a trailing dot all read as the host')
  const d = deps()
  const card = await handle(new Request(`https://${SELF}/jack/status/20`, { headers: BOT }), env(undefined, vars), ctx, d)
  assert.equal(card.headers.get(GUEST_MARK), 'served')
  const html = await card.text()
  assert.match(html, /og:title" content="jack \(@jack\)"/)
  const activity = html.match(/type="application\/activity\+json" href="([^"]+)"/)?.[1]
  assert.ok(activity?.startsWith(`https://${SELF}/`), `minted on the guest host, got ${activity}`)
  const file = await handle(new Request(`https://d.${SELF}/jack/status/20`, { headers: BOT }), env(undefined, vars), ctx, d)
  assert.equal(file.headers.get('location'), `https://d.${SELF}/_media/x%3A20/0`)
  assert.equal(file.headers.get(GUEST_MARK), 'served')
  const boom = async () => { throw new Error('a declined path must not fetch') }
  for (const path of ['/', '/robots.txt', '/foo', '/_smoke', '/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20']) {
    const res = await handle(new Request(`https://${SELF}${path}`, { headers: PERSON }), env(undefined, vars),
      ctx, { ...deps(boom), cache: { match: boom, put: boom } })
    assert.equal(res.status, 404, `${path} declined`)
    assert.equal(res.headers.get(GUEST_MARK), null, `${path} unmarked`)
  }
  // And with that value, the owner's two are ordinary hosts again for routing.
  const root = await handle(new Request(`${GUEST}/`, { headers: PERSON }), env(async () => new Response('page'), vars), ctx, deps())
  assert.equal(await root.text(), 'page')
})

test('EVERY HOST ROUTED AS A GUEST IS REFUSED AS AN INSTANCE, for any value of the var, junk included', () => {
  /**
   * The two halves read one var through one parser (fedihost.ts declaredHosts), and this is the
   * property that sharing buys: a value that routes a host as a guest also refuses it, so configuring a
   * guest host can never open the loop through the other Worker. Junk routes nothing and refuses
   * nothing extra, and it never takes a built-in refusal away.
   */
  const specs = [
    PROD_VARS.GUEST_HOSTS, SELF, `https://${SELF}/`, `${SELF}.`, ` ${SELF} ,other.example `,
    '', ' ', ',', 'https://', '*.guest.example', 'not a host', undefined,
  ]
  const probes = [SELF, `d.${SELF}`, `www.${SELF}`, 'other.example', ...GUEST_HOSTS, ...GUEST_HOSTS.map(h => `d.${h}`), 'lemmy.world']
  let routed = 0
  for (const spec of specs) {
    for (const h of probes) {
      if (isGuestHost(h, spec)) {
        routed++
        assert.equal(fetchableInstance(h, undefined, { GUEST_HOSTS: spec }), false,
          `${h} is routed as a guest under ${JSON.stringify(spec)} and must be refused under it too`)
      }
    }
    for (const h of ['mbedfx.app', 'forsen.sex', 'sorryifuckedyour.mom', 'hotsinglesnear.you']) {
      assert.equal(fetchableInstance(h, undefined, { GUEST_HOSTS: spec }), false,
        `${h} stays refused with GUEST_HOSTS=${JSON.stringify(spec)}`)
    }
    assert.equal(isGuestHost('lemmy.world', spec), false)
    assert.equal(fetchableInstance('lemmy.world', undefined, { GUEST_HOSTS: spec }), true,
      `a real instance is not refused because of ${JSON.stringify(spec)}`)
  }
  assert.ok(routed >= 15, `the sweep must actually route some hosts, routed ${routed}`)
})
