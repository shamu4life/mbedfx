import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cronOrigin, handle } from '../src/worker.ts'
import {
  CONFIG_ANCHOR, HEAD_SELF_LINKS, PAGE_ORIGIN, configBlock, declaredOrigins, injectPage, pageConfig, scriptJson, stripD,
} from '../src/sitepage.ts'
import { guestHosts } from '../src/guesthost.ts'
import { publicAssets } from '../adapters/node/bindings.ts'

/**
 * THE CONVERTER PAGE, SERVED WITH THE DEPLOYMENT'S OWN LISTS (self-hosting phase 5, src/sitepage.ts).
 *
 * Two promises are tested here. On mbedfx.app nothing changes: with wrangler.production.jsonc's vars,
 * the page served on every production hostname is public/index.html byte for byte plus one block, and the
 * lists in that block are the page's own literal arrays, order included. Everywhere else the page stops
 * naming mbedfx.app: a fork gets its own primary, its own buttons, and media only only where it declared
 * a d. name.
 *
 * Every page here is rendered through handle(), the entry both runtimes use, with the Node adapter's
 * publicAssets() as ASSETS. That stand-in honours If-None-Match the way Cloudflare's asset server does,
 * so the 304 path is exercised for real rather than stubbed. No network: the site route fetches nothing.
 */

const FILE = readFileSync(new URL('../public/index.html', import.meta.url))
const HTML = FILE.toString('utf8')
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))
const read = f => JSON.parse(readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const PROD = read('wrangler.production.jsonc')
const PROD_VARS = PROD.vars

/** The page's own literal arrays, as the file spells them. */
const literal = name => {
  const m = HTML.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`))
  assert.ok(m, `the page declares ${name}`)
  return m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
}
const OUR = literal('OUR_HOSTS')
const PUB = literal('PUBLIC_HOSTS')
const GUESTS = literal('GUEST_HOSTS')

/** The hostnames production serves the page on: its routes, and the d. name of each. */
const ROUTED = PROD.routes.map(r => r.pattern.split('/')[0])
const PAGE_HOSTS = [...ROUTED, ...ROUTED.map(h => `d.${h}`)]

const BLOCK = /<script id="mbedfx-config">var MBEDFX_CONFIG = ([^\n]*);<\/script>\n/g
const boom = async () => { throw new Error('the site route must not fetch a post') }
const deps = () => ({ cache: { match: boom, put: boom }, fetchPost: boom, resolveShortlink: boom, resolveRedditShare: boom })
const env = (vars = PROD_VARS, assets = publicAssets(PUBLIC)) => ({ ...vars, AE: { writeDataPoint() {} }, ASSETS: assets })
const serve = (url, vars, init) => handle(new Request(url, init), env(vars), { waitUntil() {} }, deps())

/** The block the page was served with, and the page with it taken back out. */
function split(page) {
  const found = [...page.matchAll(BLOCK)]
  assert.equal(found.length, 1, 'exactly one config block')
  return { cfg: JSON.parse(found[0][1]), script: found[0][0], rest: page.replace(BLOCK, '') }
}

/**
 * Run the served page's two scripts in the order a browser does: the injected block, then the converter
 * block, both lifted from the SERVED bytes. What comes back is what the page computed from what it got.
 */
function runServed(page) {
  const cfgJs = page.match(/<script id="mbedfx-config">(var MBEDFX_CONFIG = [^\n]*;)<\/script>\n/)
  const conv = page.match(/<script id="mbedfx-convert">([\s\S]*?)<\/script>/)
  assert.ok(conv, 'the served page still carries the converter block')
  return new Function(`${cfgJs ? cfgJs[1] : ''}\n${conv[1]}; return {
    ours: OUR_HOSTS, pub: PUBLIC_HOSTS, guests: GUEST_HOSTS, primary: PRIMARY_HOST, arrived: ARRIVED_HOST,
    direct: DIRECT_HOSTS, defaultHost: mbedfxDefaultHost, convert: mbedfxConvert, hasMediaOnly: mbedfxHasMediaOnly,
    mediaOnly: mbedfxMediaOnly,
  }`)()
}

test('ON EVERY PRODUCTION HOSTNAME THE SERVED PAGE IS public/index.html BYTE FOR BYTE, plus one block', async () => {
  /**
   * The owner's condition for this phase: mbedfx.app must not change. The primary there is
   * https://mbedfx.app, which is what the head is written for, so no substitution may happen at all, and
   * taking the one block back out must leave the file exactly. Compared as bytes, not as text, so an
   * encoding change (a BOM, a re-encoded emoji in a comment) fails here too.
   */
  assert.ok(PAGE_HOSTS.includes('forsen.sex') && PAGE_HOSTS.includes('d.mbedfx.app'), 'served-but-unadvertised and d. hosts are covered')
  for (const h of PAGE_HOSTS) {
    const res = await serve(`https://${h}/`)
    assert.equal(res.status, 200, h)
    const page = await res.text()
    const { rest } = split(page)
    assert.ok(Buffer.from(rest, 'utf8').equals(FILE), `${h}: the page minus its block is the file, byte for byte`)
    for (const tag of HEAD_SELF_LINKS) assert.ok(page.includes(tag), `${h}: ${tag} is left as written`)
  }
})

test('WITH PRODUCTION\'S VARS THE PAGE COMPUTES TODAY\'S ARRAYS EXACTLY, in order, on every production hostname', async () => {
  /**
   * The block replaces the page's literals, so a list that differs by one host or by order changes what
   * mbedfx.app does: a missing forsen.sex brings back the 2026-09-11 defect (its links read as a
   * fediverse instance), and a reordered PUBLIC_HOSTS moves the buttons. This runs the served bytes, the
   * block and the converter block together, as the browser does.
   */
  for (const h of PAGE_HOSTS) {
    const page = await (await serve(`https://${h}/`)).text()
    const p = runServed(page)
    assert.deepEqual(p.ours, OUR, `${h}: OUR_HOSTS`)
    assert.deepEqual(p.pub, PUB, `${h}: PUBLIC_HOSTS`)
    assert.deepEqual(p.guests, GUESTS, `${h}: GUEST_HOSTS`)
    assert.equal(p.primary, 'mbedfx.app', `${h}: the primary`)
    assert.equal(p.arrived, stripD(h), `${h}: the arrived-on host, one d. off`)
    assert.equal(p.defaultHost(p.arrived).host, stripD(h), `${h}: the visitor is handed this domain's links`)
    // Media only is offered on every domain today, and must stay offered on each of them.
    for (const o of OUR) assert.equal(p.hasMediaOnly(o), true, `${h}: media only stays on ${o}`)
  }
})

test('THE PAGE\'S PRIMARY IS THE SCHEDULED CHECK\'S ORIGIN, read by the same function', () => {
  /**
   * Two readers of PUBLIC_ORIGIN that disagreed about which entry comes first would put the check on one
   * origin and the page's head on another. cronOrigin now calls declaredOrigins, which the page uses too.
   */
  assert.equal(pageConfig(PROD_VARS, new URL('https://megapenispoopenfarten.sex/')).primary, cronOrigin(PROD_VARS))
  assert.equal(cronOrigin(PROD_VARS), PAGE_ORIGIN)
  for (const spec of [undefined, '', 'junk', 'https://a.example/path https://b.example', 'http://c.example:8080']) {
    assert.equal(declaredOrigins(spec)[0]?.origin ?? 'http://localhost', cronOrigin({ PUBLIC_ORIGIN: spec }), String(spec))
  }
})

test('A GUEST HOST IS NEVER SERVED THE PAGE, so the byte comparison there can only be the decline', async () => {
  /**
   * handle() declines `site` on a guest host before serve() runs (src/guesthost.ts), and ASSETS throws
   * here to prove it is not reached. That is unchanged by this phase and proves nothing about bytes, so
   * the injector is also run directly on a guest request: should you-stupid ever pass `/` through, the
   * page it gets is still the file plus a block, with the primary's head untouched.
   */
  const refuse = { fetch: async () => { throw new Error('ASSETS must not be reached on a guest host') } }
  for (const g of guestHosts(PROD_VARS.GUEST_HOSTS)) {
    for (const h of [g, `d.${g}`]) {
      const res = await handle(new Request(`https://${h}/`), env(PROD_VARS, refuse), { waitUntil() {} }, deps())
      assert.equal(res.status, 404, `${h}: / is declined`)
      assert.equal(await res.text(), 'not served on this host\n')
      const page = injectPage(HTML, pageConfig(PROD_VARS, new URL(`https://${h}/`)))
      assert.ok(Buffer.from(split(page).rest, 'utf8').equals(FILE), `${h}: file plus block, nothing else`)
    }
  }
})

test('A CONDITIONAL REQUEST STILL GETS THE PAGE WITH ITS BLOCK, and the answer carries no validator', async () => {
  /**
   * A browser revalidates with the ETag it was given. Passed through, ASSETS would answer 304 and the
   * browser would keep the copy it had, which may be one with no block (cached before this shipped) or
   * one with another host's. And an ETag on the injected page would be the FILE's, so a later block change
   * would revalidate as unchanged. So the conditional headers are dropped before ASSETS, and the
   * validators are dropped from the answer. Range is dropped for the same reason: a block spliced into
   * part of a file is a corrupt page.
   */
  const probe = await publicAssets(PUBLIC).fetch(new Request('https://mbedfx.app/'))
  const etag = probe.headers.get('etag')
  assert.ok(etag, 'the asset server sends an ETag, so this checks something')
  const again = await publicAssets(PUBLIC).fetch(new Request('https://mbedfx.app/', { headers: { 'if-none-match': etag } }))
  assert.equal(again.status, 304, 'and answers 304 to it, which is what must not reach a reader')

  const res = await serve('https://mbedfx.app/', PROD_VARS, {
    headers: { 'if-none-match': etag, 'if-modified-since': 'Wed, 25 Nov 2026 00:00:00 GMT', range: 'bytes=0-99' },
  })
  assert.equal(res.status, 200)
  assert.equal(split(await res.text()).rest, HTML)
  assert.equal(res.headers.get('etag'), null)
  assert.equal(res.headers.get('last-modified'), null)
  assert.equal(res.headers.get('content-encoding'), null)
  assert.match(res.headers.get('content-type'), /^text\/html/)
  // Kept as the asset server sent it: the host is in every cache key, so it cannot cross hosts.
  assert.equal(res.headers.get('cache-control'), probe.headers.get('cache-control'))

  // Every other site path is ASSETS' answer untouched, conditional headers included.
  const robotsTag = (await publicAssets(PUBLIC).fetch(new Request('https://mbedfx.app/robots.txt'))).headers.get('etag')
  const robots = await serve('https://mbedfx.app/robots.txt', PROD_VARS, { headers: { 'if-none-match': robotsTag } })
  assert.equal(robots.status, 304, 'robots.txt still revalidates')
  const moved = await serve('https://mbedfx.app/index.html')
  assert.equal(moved.status, 307, '/index.html still redirects to /')
})

test('HEAD on the page answers its headers with no body and no stale length', async () => {
  const res = await serve('https://mbedfx.app/', PROD_VARS, { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(res.body, null)
  assert.equal(res.headers.get('content-length'), null, 'the file\'s length is not the page\'s')
  assert.equal(res.headers.get('etag'), null)
  assert.match(res.headers.get('content-type'), /^text\/html/)
})

test('A SELF-HOSTER WITH NO VARS: the request host is the primary and the only button, no guests, no media only', async () => {
  /**
   * The fork that set nothing, on Cloudflare (the generic wrangler.jsonc sets no vars). Before this phase
   * its converter handed out https://mbedfx.app/... links, said "Swap the site's domain for mbedfx.app",
   * and unfurled with mbedfx.app's og:url and og:image. Now the request is the only source there is, so
   * it is the answer. Media only needs a d. name nobody declared, so it is not offered.
   */
  const vars = read('wrangler.jsonc').vars ?? {}
  for (const k of ['PUBLIC_ORIGIN', 'GUEST_HOSTS', 'OWN_HOSTS']) assert.equal(vars[k], undefined, `the generic file sets no ${k}`)
  const res = await serve('https://embed.example.com/', vars)
  const page = await res.text()
  const { cfg, rest } = split(page)
  assert.deepEqual(cfg, {
    primary: 'https://embed.example.com', host: 'embed.example.com',
    ours: ['embed.example.com'], public: ['embed.example.com'], guests: [], direct: [],
  })
  // The head points at the fork, exactly three tags, and nothing else in the file moved.
  const expected = HEAD_SELF_LINKS.reduce((s, t) => s.replace(t, t.replace(PAGE_ORIGIN, 'https://embed.example.com')), HTML)
  assert.equal(rest, expected)
  assert.equal(rest.split('https://embed.example.com').length - 1, 3)
  assert.ok(!rest.slice(0, rest.indexOf('</head>')).includes(`content="${PAGE_ORIGIN}`), 'no head link names mbedfx.app')

  const p = runServed(page)
  assert.equal(p.primary, 'embed.example.com')
  assert.deepEqual(p.pub, ['embed.example.com'])
  assert.deepEqual(p.guests, [])
  assert.deepEqual(p.defaultHost(p.arrived), { host: 'embed.example.com', prefix: '', family: 'embed.example.com' })
  assert.deepEqual(p.defaultHost('stranger.example'), { host: 'embed.example.com', prefix: '', family: 'embed.example.com' },
    'a host that is not this deployment falls back to its primary, never to mbedfx.app')
  assert.equal(p.convert('https://x.com/jack/status/20').url, 'https://embed.example.com/jack/status/20')
  assert.equal(p.convert('https://embed.example.com/jack/status/20').path, '/jack/status/20', 'its own links are recognised')
  assert.equal(p.hasMediaOnly('embed.example.com'), false)
})

test('A d. REQUEST HOST IS STRIPPED ON THE SERVER, so the page never composes d.d.', async () => {
  /**
   * The reason the page stopped reading location.hostname (2026-08-03, baff668): on d.mbedfx.app the page
   * took the d. host for its own domain, and media only put another d. in front of it. The server now
   * takes one d. off before the page sees the host, and the d. name appears in no list the page builds
   * links from. A host that merely starts with `d.` and has one label after it (`d.com`) is its own host,
   * as it is to DIRECT_MEDIA_HOST in src/worker.ts.
   */
  const page = await (await serve('https://d.embed.example.com/', {})).text()
  const p = runServed(page)
  assert.equal(p.arrived, 'embed.example.com')
  assert.equal(p.primary, 'embed.example.com')
  for (const list of [p.ours, p.pub]) assert.ok(!list.some(h => h.startsWith('d.')), `no d. host in ${list}`)
  const link = p.convert('https://x.com/jack/status/20', p.defaultHost(p.arrived).host).url
  assert.equal(p.mediaOnly(link), 'https://d.embed.example.com/jack/status/20', 'one d., never two')
  assert.equal(stripD('d.com'), 'd.com')
  assert.equal(stripD('d.d.example.com'), 'd.example.com', 'exactly one label comes off')
})

test('A SELF-HOSTER WITH PUBLIC_ORIGIN SET gets its own primary, buttons, guests, and media only where a d. is declared', async () => {
  const vars = {
    PUBLIC_ORIGIN: 'https://embed.example.com, https://second.example https://d.embed.example.com',
    GUEST_HOSTS: 'guest.example', OWN_HOSTS: 'quiet.example',
  }
  const page = await (await serve('https://second.example/', vars)).text()
  const { cfg, rest } = split(page)
  assert.deepEqual(cfg, {
    primary: 'https://embed.example.com', host: 'second.example',
    ours: ['embed.example.com', 'second.example', 'quiet.example', 'guest.example'],
    public: ['embed.example.com', 'second.example', 'guest.example'],
    guests: ['guest.example'], direct: ['d.embed.example.com'],
  })
  assert.ok(rest.includes('<meta property="og:image" content="https://embed.example.com/og.jpg">'), 'the head names the primary')
  const p = runServed(page)
  assert.deepEqual(p.defaultHost(p.arrived), { host: 'second.example', prefix: '', family: 'second.example' })
  assert.deepEqual(p.defaultHost('quiet.example'), { host: 'quiet.example', prefix: '', family: 'embed.example.com' },
    'a served host with no button keeps its own links and presses the primary\'s button')
  assert.equal(p.hasMediaOnly('embed.example.com'), true)
  assert.equal(p.hasMediaOnly('second.example'), false, 'no d. name declared for it, so no box')
  assert.equal(p.hasMediaOnly('guest.example'), false)

  // A host the deployment answers on but does not list (its workers.dev name, say) is ours and not offered.
  const other = split(await (await serve('https://mbedfx-fork.acct.workers.dev/', vars)).text()).cfg
  assert.ok(other.ours.includes('mbedfx-fork.acct.workers.dev'))
  assert.ok(!other.public.includes('mbedfx-fork.acct.workers.dev'))
  // A d. name listed first is still the primary's d. name, and the primary is the domain under it.
  const dFirst = pageConfig({ PUBLIC_ORIGIN: 'https://d.embed.example.com' }, new URL('https://embed.example.com/'))
  assert.equal(dFirst.primary, 'https://embed.example.com')
  assert.deepEqual(dFirst.public, ['embed.example.com'])
  assert.deepEqual(dFirst.direct, ['d.embed.example.com'])
})

test('JUNK IN A VAR NEVER REACHES THE PAGE AS A HOST', () => {
  /**
   * declaredHosts passes a token with no `/` or `@` through as written, so `<b>` in OWN_HOSTS was a
   * "host" to it. The guard only ever compares such a token, so it could not matter there; the page
   * writes these names into buttons and links. pageConfig keeps only what the URL parser gives back
   * unchanged as a host and what has a hostname's shape: the parser itself accepts `a"b` and `x..y`
   * (found writing this test), and a quote in a host is one step from an attribute.
   */
  const cfg = pageConfig({
    PUBLIC_ORIGIN: 'not-an-origin https://ok.example/path javascript:alert(1)',
    OWN_HOSTS: '<b> </script> a"b x..y ok.example',
    GUEST_HOSTS: '<img src=x> guest.example',
  }, new URL('https://embed.example.com/'))
  const all = [...cfg.ours, ...cfg.public, ...cfg.guests, ...cfg.direct]
  for (const h of all) assert.match(h, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${h} is a hostname`)
  assert.deepEqual(cfg.ours, ['ok.example', 'guest.example', 'embed.example.com'])
  assert.equal(cfg.primary, 'https://embed.example.com', 'no entry was a usable origin, so the request is the primary')
  // An origin whose host is junk cannot be the primary either: the next usable entry is.
  assert.equal(pageConfig({ PUBLIC_ORIGIN: 'https://a"b https://ok.example' }, new URL('https://ok.example/')).primary, 'https://ok.example')
})

test('THE BLOCK IS SAFE INSIDE AN INLINE SCRIPT, and parses back to the same value', () => {
  /**
   * No end-to-end path can put a `<` into the block (every host is parsed first), so the escape is tested
   * on its own. Each sequence here changes how the HTML parser or an older JS engine reads a script.
   */
  const value = { s: '</script><script>alert(1)</script><!-- -->\u2028\u2029&amp;', n: ['</SCRIPT', '<!--'] }
  const out = scriptJson(value)
  for (const bad of ['<', '>', '&', '\u2028', '\u2029']) assert.ok(!out.includes(bad), `${JSON.stringify(bad)} is escaped`)
  assert.deepEqual(JSON.parse(out), value)
  assert.deepEqual(new Function(`return ${out}`)(), value, 'and as JavaScript, which is how the page reads it')
  const block = configBlock({ primary: 'https://a.example', host: 'a.example', ours: ['</script>'], public: [], guests: [], direct: [] })
  assert.equal(block.split('</script>').length - 1, 1, 'the block closes exactly once, at its end')
  assert.ok(block.endsWith('</script>\n'))
})

test('A PAGE WITHOUT THE ANCHOR IS SERVED AS IT IS, and the anchor is in the page exactly once', () => {
  /**
   * The literals are the page's own fallback, so a page the injector cannot place a block in still
   * works; a block spliced somewhere else would not. The anchor is the converter block's opening tag,
   * which the tests already lift by its id, so it cannot quietly disappear.
   */
  const cfg = pageConfig({}, new URL('https://embed.example.com/'))
  assert.equal(injectPage('<html><head></head><body>no anchor</body></html>', cfg), '<html><head></head><body>no anchor</body></html>')
  assert.equal(HTML.split(CONFIG_ANCHOR).length - 1, 1)
  for (const tag of HEAD_SELF_LINKS) {
    assert.equal(HTML.split(tag).length - 1, 1, `${tag} is in the page once`)
    assert.ok(HTML.indexOf(tag) < HTML.indexOf('</head>'), `${tag} is in the head`)
  }
})

test('A COPY WITH NO BLOCK, OR A BLOCK OF THE WRONG SHAPE, IS THE PAGE AS IT WAS', () => {
  /**
   * The fallback is every copy with no block: a file:// open, a browser's copy from before this shipped,
   * the lifted-block tests. A malformed block is treated the same way, whole: a half-applied one (lists
   * from the block, primary from the literal) would be the partial-list defect the nesting assert exists
   * for.
   */
  const bare = runServed(HTML)
  assert.deepEqual([bare.ours, bare.pub, bare.guests, bare.primary, bare.arrived, bare.direct], [OUR, PUB, GUESTS, 'mbedfx.app', null, null])
  assert.equal(bare.hasMediaOnly('anything.example'), true, 'with no block, media only is offered as it always was')
  for (const bad of ['null', '{}', '{"primary":"mbedfx.app","host":"x","ours":[],"public":["x"],"guests":[],"direct":[]}',
    '{"primary":"https://x.example","host":"x.example","ours":["x.example"],"public":[],"guests":[],"direct":[]}',
    '{"primary":"https://x.example","host":"x.example","ours":[1],"public":["x.example"],"guests":[],"direct":[]}']) {
    const page = HTML.replace(CONFIG_ANCHOR, `<script id="mbedfx-config">var MBEDFX_CONFIG = ${bad};</script>\n${CONFIG_ANCHOR}`)
    const p = runServed(page)
    assert.deepEqual([p.ours, p.pub, p.primary], [OUR, PUB, 'mbedfx.app'], bad)
  }
})

test('THE DOM HALF READS THE BLOCK: the arrived-on host, the primary in the copy, the buttons, and the d. gate', () => {
  /**
   * The DOM half cannot run here, so its wiring is pinned by spelling. Each line is one of the four
   * places a fork's page used to name mbedfx.app or offer something it does not have.
   */
  assert.match(HTML, /mbedfxDefaultHost\(ARRIVED_HOST !== null \? ARRIVED_HOST : location\.hostname\)/)
  assert.match(HTML, /querySelectorAll\('\[data-primary-host\]'\)[\s\S]{0,120}el\.textContent = PRIMARY_HOST;/)
  assert.equal((HTML.match(/data-primary-host>mbedfx\.app</g) || []).length, 5, 'the five spots in the visible copy that named mbedfx.app')
  assert.match(HTML, /if \(have\.join\(' '\) === PUBLIC_HOSTS\.join\(' '\)\) return;/, 'buttons equal to the list are left as written')
  const seg = HTML.indexOf("var segs = document.querySelectorAll('.seg button');")
  assert.ok(HTML.lastIndexOf('PUBLIC_HOSTS.forEach(function (h) {', seg) > 0 && HTML.lastIndexOf('PUBLIC_HOSTS.forEach', seg) < seg,
    'the buttons are rebuilt before the handlers are attached')
  assert.match(HTML.slice(seg, seg + 1500), /syncMediaOnlyHost\(\);\s*render\(\);/, 'a domain click re-checks the d. name before drawing')
  assert.match(HTML, /hostHasMedia = mbedfxHasMediaOnly\(host\);/)
})
