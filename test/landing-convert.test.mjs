import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { guestHosts, guestServes } from '../src/guesthost.ts'

/**
 * THE LANDING PAGE IS TESTED AGAINST THE ROUTER, not against my memory of the router.
 *
 * A docs page is a coverage claim, and this project has been burned by coverage claims more than by
 * anything else — PieFed was announced as supported in our own source before it worked, and the
 * types file asserted GoToSocial and Pixelfed coverage that measurement showed was false. A landing
 * page repeats that mistake at a larger blast radius: a wrong example path teaches every visitor a
 * URL that does not work, and they blame the service rather than the page.
 *
 * So nothing here is asserted by hand. The page's converter and the page's own example paths are
 * LIFTED OUT OF public/index.html and pushed through the REAL route(). If the router changes shape
 * and the page is not updated, this goes red.
 *
 * The converter block is kept DOM-free in the HTML specifically so it can be lifted like this.
 *
 * ON THE `new Function` BELOW, since it is the shape of a real vulnerability and should not read as
 * carelessness. What is evaluated is a committed file from this repository, read off disk in a test —
 * not user input, not a network response, and never reached at runtime by the Worker. Anyone who can
 * change public/index.html can already change src/, so this grants no capability they lacked.
 *
 * The tidier alternative — a separate public/convert.js imported by both the page and this test — is
 * not available: SITE_PATHS in router.ts serves exactly '/', '/index.html', '/favicon.ico' and
 * '/robots.txt', and every other path is routed as a POST. A second asset file would 404 as an
 * unrecognised link unless the router's allow-list grew, and widening the router's path surface to
 * make a test prettier is a worse trade than evaluating our own committed file here.
 */

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

/**
 * THE WORKER'S GUEST HOSTS ON THE PUBLIC INSTANCE: wrangler.production.jsonc's GUEST_HOSTS var, read with
 * the Worker's own parser. A constant in src/guesthost.ts until 2026-11-25. The page keeps its own copy
 * until the Worker hands it the list (self-hosting phase 5), and the test that holds the two equal now
 * holds the page to this var.
 */
const GUEST_HOSTS = guestHosts(JSON.parse(readFileSync(new URL('../wrangler.production.jsonc', import.meta.url), 'utf8')
  .replace(/^\s*\/\/.*$/gm, '')).vars.GUEST_HOSTS)

/**
 * Lift the pure-logic block. Its id is a contract between the page and this file.
 *
 * `config` is what the Worker would have put in front of it (src/sitepage.ts, self-hosting phase 5),
 * passed in as the MBEDFX_CONFIG global the page reads. Omitted, it is the page as a file:// open or an
 * old cached copy sees it: no block, the literal arrays, mbedfx.app as the fallback. Every test in this
 * file that predates phase 5 runs that way, which is the fallback they were written against.
 */
function loadConverter(config) {
  const m = HTML.match(/<script id="mbedfx-convert">([\s\S]*?)<\/script>/)
  assert.ok(m, 'public/index.html must carry a <script id="mbedfx-convert"> block')
  const src = m[1]
  assert.ok(!/document\.|window\.|navigator\./.test(src),
    'the converter block must stay DOM-free so it can be tested in isolation')
  return new Function('MBEDFX_CONFIG', `${src}; return {
    convert: mbedfxConvert, defaultHost: mbedfxDefaultHost, mediaOnly: mbedfxMediaOnly,
    repoint: mbedfxRepoint, isGuest: mbedfxIsGuest, pageGuests: GUEST_HOSTS, publicHosts: PUBLIC_HOSTS,
    ourHosts: OUR_HOSTS, prepResolved: mbedfxPrepResolved, hasMediaOnly: mbedfxHasMediaOnly,
    pinId: mbedfxPinId, pinShortCode: PIN_SHORT_CODE, pinRefusal: PIN_IT_REFUSAL, forcedPath: mbedfxForcedPath,
  }`)(config)
}

/** Lift the documented example paths out of the page's own platform table. */
function loadPlatformTable() {
  const m = HTML.match(/var PLATFORMS = (\[[\s\S]*?\n {2}\]);/)
  assert.ok(m, 'public/index.html must carry the PLATFORMS table')
  // The table references MONO for the brands whose own colour is #000 and must flip with the
  // colour scheme. Supplying it here keeps that decision in the stylesheet where it belongs.
  return new Function(`const MONO = 'var(--brand-mono)'; return ${m[1]}`)()
}

const {
  convert, defaultHost, mediaOnly, repoint, isGuest, pageGuests, publicHosts, ourHosts, prepResolved, hasMediaOnly,
  pinId, pinShortCode, pinRefusal, forcedPath,
} = loadConverter()
const PLATFORMS = loadPlatformTable()

/** Display name on the embed -> the platform code the router mints. */
const CODE = {
  'Twitter': 'x', 'TikTok': 'tt', 'Instagram': 'ig', 'Threads': 'th', 'Reddit': 'rd',
  'Bluesky': 'bs', 'YouTube': 'yt', 'Facebook': 'fb', 'Twitch': 'tw', 'Pinterest': 'pn',
  'Dailymotion': 'dm', 'Streamable': 'st', 'Imgur': 'im',
  'Mastodon': 'ms', 'Misskey': 'mk', 'Lemmy': 'lm', 'PeerTube': 'pt',
}

/** Paths that deliberately reach a RESOLVING route rather than a post — see link-hygiene.test.mjs. */
const RESOLVES = {
  't/ZTSw2mYwR': 'shortlink',
  'share/Fixture08X': 'metashare',
  'r/BatmanArkham/s/uucSZtDEbI': 'redditshare',
}

const routed = p => route(new URL('https://mbedfx.app' + (p.startsWith('/') ? p : '/' + p)))

test('EVERY EXAMPLE PATH PRINTED ON THE PAGE ACTUALLY ROUTES', () => {
  /**
   * The documentation half. Each card advertises real paths; each one is pushed through the router
   * and must land on the platform the card claims. A typo in an id, a shape that was never routed,
   * or a platform that quietly stopped matching all fail here rather than in someone's Discord.
   */
  let checked = 0
  for (const { name, paths } of PLATFORMS) {
    const want = CODE[name]
    assert.ok(want, `the table lists "${name}" but this test has no code for it — add one`)
    for (const ex of paths) {
      const r = routed(ex)
      if (RESOLVES[ex]) {
        assert.equal(r.kind, RESOLVES[ex], `${name}: /${ex} must reach the ${RESOLVES[ex]} resolver`)
      } else {
        assert.equal(r.kind, 'post', `${name}: /${ex} must route to a post (got ${r.kind})`)
        assert.equal(r.ref.p, want, `${name}: /${ex} routed to "${r.ref.p}", not "${want}"`)
      }
      checked++
    }
  }
  assert.ok(checked >= 30, `the table must stay substantial to be worth publishing (was ${checked})`)
})

test('EVERY PLATFORM THE ROUTER SUPPORTS IS ON THE PAGE', () => {
  // The other direction: shipping a platform and never telling anyone is its own kind of wrong.
  const listed = new Set(PLATFORMS.map(p => CODE[p.name]))
  for (const p of ['x', 'tt', 'ig', 'th', 'rd', 'bs', 'yt', 'fb', 'dm', 'st', 'im', 'tw', 'lm', 'ms', 'mk', 'pt', 'pn']) {
    assert.ok(listed.has(p), `platform "${p}" routes but is not documented on the landing page`)
  }
})

/** [what a person pastes, the platform code the converted url must route to] */
const REAL_PASTES = [
  ['https://twitter.com/jack/status/20', 'x'],
  ['https://x.com/jack/status/20', 'x'],
  ['https://mobile.twitter.com/jack/status/20', 'x'],
  ['https://www.tiktok.com/@mysticaquarium/video/7660566211100511518', 'tt'],
  ['https://www.instagram.com/p/DbN6SsKum-9/', 'ig'],
  ['https://www.instagram.com/reel/Da5ynsiuAZ_/', 'ig'],
  ['https://www.threads.com/@dexerto/post/DbWxxQjFe4u', 'th'],
  ['https://www.reddit.com/r/pics/comments/haucpf', 'rd'],
  ['https://old.reddit.com/r/pics/comments/haucpf', 'rd'],
  ['https://redd.it/haucpf', 'rd'],
  ['https://bsky.app/profile/bsky.app/post/3labcdefghij', 'bs'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'yt'],
  ['https://youtu.be/dQw4w9WgXcQ', 'yt'],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'yt'],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'yt'],
  ['https://www.facebook.com/reel/2209468366484962', 'fb'],
  ['https://www.facebook.com/groups/328668786145521/permalink/1391536379858751/', 'fb'],
  ['https://www.dailymotion.com/video/xaqwy7q', 'dm'],
  ['https://dai.ly/xaqwy7q', 'dm'],
  ['https://streamable.com/e/moo', 'st'],
  ['https://streamable.com/moo', 'st'],
  ['https://i.imgur.com/A61SaA1.gifv', 'im'],
  ['https://imgur.com/A61SaA1', 'im'],
  ['https://clips.twitch.tv/DeliciousDelightfulPicklesWOOP', 'tw'],
  ['https://www.twitch.tv/xqc/clip/DeliciousDelightfulPicklesWOOP', 'tw'],
  ['https://www.pinterest.com/pin/66287425756772418/', 'pn'],
  ['https://pinterest.co.uk/pin/66287425756772418/', 'pn'],
  ['https://mstdn.social/@stux/116994812581955524', 'ms'],
  ['https://misskey.io/notes/ap7sliijot1f03nr', 'mk'],
  ['https://lemmy.world/post/49966212', 'lm'],
  ['https://framatube.org/w/vZNcho9kCoVzc8wZwacPtc', 'pt'],
]

test('WHAT THE CONVERTER HANDS BACK IS A URL THE WORKER ACCEPTS', () => {
  /**
   * The converter half, and the reason this file exists. Every result is fed to the real router;
   * a converted link that does not route is a link that fails in front of the person who trusted it.
   */
  for (const [paste, want] of REAL_PASTES) {
    const r = convert(paste, 'mbedfx.app')
    assert.ok(r.ok, `${paste} must convert (got ${r.kind}: ${r.why || ''})`)
    assert.ok(r.url.startsWith('https://mbedfx.app/'), `${paste} -> ${r.url}`)
    const got = routed(new URL(r.url).pathname + new URL(r.url).search)
    assert.equal(got.kind, 'post', `${paste} -> ${r.url} must route to a post (got ${got.kind})`)
    assert.equal(got.ref.p, want, `${paste} -> ${r.url} routed to "${got.ref.p}", not "${want}"`)
  }
})

test('THE SHARE-LINK SHAPES SURVIVE CONVERSION AND STILL RESOLVE', () => {
  // These have no post identity until a network hop, so "routes to a post" is the wrong assertion.
  for (const [paste, kind] of [
    ['https://www.tiktok.com/t/ZTSw2mYwR', 'shortlink'],
    ['https://www.threads.com/share/Fixture08X', 'metashare'],
    ['https://www.facebook.com/share/v/Fixture03X', 'post'],
    ['https://www.reddit.com/r/BatmanArkham/s/uucSZtDEbI', 'redditshare'],
  ]) {
    const r = convert(paste, 'mbedfx.app')
    assert.ok(r.ok, `${paste} must convert`)
    assert.equal(routed(new URL(r.url).pathname).kind, kind, `${paste} -> ${r.url}`)
  }
})

test('TRACKING JUNK NEVER SURVIVES THE CONVERTER', () => {
  /**
   * The page promises this in as many words ("tracking junk … is dropped on the way through"), so it
   * is pinned. route() would drop these anyway, but a converter that PRINTS them still teaches people
   * to paste them, and the printed link is the thing that gets forwarded.
   */
  const dirty = [
    'https://www.tiktok.com/@kfc.laos/video/7658012561153035542?_r=1&_t=ZP-98TYPziiUNL',
    'https://www.instagram.com/reel/DWtMh0dDXgk/?igsh=cGp1YXZqdzM5bGdv',
    'https://twitter.com/jack/status/20?s=20&t=AbCdEfGhIjKlMn',
    'https://www.reddit.com/r/pics/comments/haucpf?utm_source=share&utm_medium=web3x',
    'https://www.facebook.com/reel/2209468366484962/?rdid=rdidFixtureXXXXX',
    'https://www.pinterest.com/pin/66287425756772418/?invite_code=SECRET',
  ]
  for (const d of dirty) {
    const r = convert(d, 'mbedfx.app')
    assert.ok(r.ok, `${d} must still convert`)
    assert.equal(new URL(r.url).search, '', `${r.url} carried a query string`)
    for (const junk of ['_t=', 'igsh', 's=20', 'utm_', 'rdid', 'invite_code']) {
      assert.ok(!r.url.includes(junk), `${r.url} leaked ${junk}`)
    }
  }
})

test('YOUTUBE KEEPS ?v= — the one query parameter that is an id, not a tracker', () => {
  const r = convert('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&si=AbCdEfGhIjKl', 'mbedfx.app')
  assert.equal(r.url, 'https://mbedfx.app/watch?v=dQw4w9WgXcQ')
  assert.equal(routed('/watch?v=dQw4w9WgXcQ').ref.p, 'yt')
})

test('BOTH DOMAINS ARE OFFERED, AND BOTH ARE REAL', () => {
  // The toggle is only honest if the second domain is genuinely served — see wrangler.production.jsonc routes.
  for (const host of ['mbedfx.app', 'megapenispoopenfarten.sex']) {
    const r = convert('https://twitter.com/jack/status/20', host)
    assert.equal(r.url, `https://${host}/jack/status/20`)
  }
  assert.match(HTML, /data-host="mbedfx\.app"/)
  assert.match(HTML, /data-host="megapenispoopenfarten\.sex"/)
})

test('THE DOMAIN YOU ARRIVED ON IS THE ONE IT HANDS BACK', () => {
  /**
   * Owner's ask: "if I go to megapenispoopenfarten.sex I'd want it to default to using that." The
   * toggle used to start on mbedfx.app whatever door you came in, so arriving on the original domain
   * and copying a link silently switched you to the other one.
   */
  assert.equal(defaultHost('megapenispoopenfarten.sex').host, 'megapenispoopenfarten.sex')
  assert.equal(defaultHost('mbedfx.app').host, 'mbedfx.app')
  // And the toggle must reflect it, or the pressed button contradicts the link being emitted.
  assert.equal(defaultHost('megapenispoopenfarten.sex').family, 'megapenispoopenfarten.sex')
})

test('A PREVIEW DEPLOYMENT EMITS ITS OWN LINKS — a test environment handing out production links is worthless', () => {
  /**
   * REWRITTEN 2026-08-03. This pinned the same rule for staging.mbedfx.app, which is retired: testing
   * moved to Workers Builds previews, where every branch gets its own *-mbedfx.<account>.workers.dev.
   *
   * The RULE is unchanged and is the reason this test exists at all — being handed production links
   * while testing a branch means checking the live worker while believing you checked your change.
   * Only the hostname shape it applies to has moved.
   */
  const p = defaultHost('abc123-mbedfx.redevit.workers.dev')
  assert.equal(p.host, 'abc123-mbedfx.redevit.workers.dev', 'links stay in the build under test')
  assert.equal(p.preview, true, 'and it knows it is one')
  // The pressed toggle button still needs a sane answer; a preview belongs to no public family, so
  // the default one reads as pressed rather than neither.
  assert.equal(p.family, 'mbedfx.app')

  // staging.* is no longer special: it is simply not us any more, so it falls back like any stranger.
  assert.equal(defaultHost('staging.mbedfx.app').host, 'mbedfx.app',
    'a retired hostname must not keep emitting links to itself')
})

test('AN UNRECOGNISED HOST FALLS BACK — never emit links to a host that is not us', () => {
  /**
   * localhost, a file:// preview, someone mirroring the page, a hostname we add later and forget to
   * list here. Emitting `https://<whatever>/...` would hand out links to a site that cannot fix them.
   */
  for (const h of ['localhost', '127.0.0.1', '', null, undefined, 'evil.example',
    'mbedfx.app.evil.example', 'notmbedfx.app', 'staging.evil.example']) {
    assert.equal(defaultHost(h).host, 'mbedfx.app', `${String(h)} must fall back`)
    assert.equal(defaultHost(h).prefix, '', `${String(h)} must not invent a prefix`)
  }
  // Case and a trailing FQDN dot are both real ways a hostname arrives.
  assert.equal(defaultHost('MegaPenisPoopenFarten.SEX').host, 'megapenispoopenfarten.sex')
  assert.equal(defaultHost('mbedfx.app.').host, 'mbedfx.app')
})

test('THE PAGE ACTUALLY USES IT — the default is wired to the arrived-on host, not hardcoded', () => {
  /**
   * REWRITTEN 2026-11-25 (self-hosting phase 5). This pinned `mbedfxDefaultHost(location.hostname)`. The
   * Worker now sends the host the request arrived on, with one leading d. taken off (ARRIVED_HOST, from
   * src/sitepage.ts), and the page reads that first: on d.mbedfx.app location.hostname is the d. host,
   * and reading it is the d.d. defect that got the location-derived lists reverted in 2026-08. A copy
   * with no block still reads location.hostname, so the property this test exists for, that the default
   * follows the door the visitor came in and is not a constant, is unchanged.
   */
  assert.match(HTML, /mbedfxDefaultHost\(ARRIVED_HOST !== null \? ARRIVED_HOST : location\.hostname\)/,
    'the DOM half must consult the arrived-on host, and location.hostname without a block')
  assert.match(HTML, /origin\.prefix \+ b\.getAttribute\('data-host'\)/, 'a click must preserve staging')
})

test('WITH A BLOCK, THE FALLBACK IS THE DEPLOYMENT\'S PRIMARY, never mbedfx.app', () => {
  /**
   * The unrecognised-host test above pins mbedfx.app as the fallback, and on a copy with no block that
   * stays right. On a fork it was the defect self-hosting phase 5 exists for: a visitor on any host the
   * page did not list, every reader of a self-hosted instance included, was handed https://mbedfx.app/...
   * links, and the fork's own converter sent its readers to the owner's instance. With the Worker's
   * block the fallback is that deployment's primary, and its own links are recognised as already its own.
   */
  const fork = loadConverter({
    primary: 'https://embed.example.com', host: 'embed.example.com',
    ours: ['embed.example.com', 'other.example.com'], public: ['embed.example.com'], guests: [], direct: [],
  })
  for (const h of ['localhost', '', null, 'evil.example', 'mbedfx.app', 'abc-mbedfx.redevit.workers.dev.evil.example']) {
    assert.deepEqual(fork.defaultHost(h), { host: 'embed.example.com', prefix: '', family: 'embed.example.com' }, String(h))
  }
  assert.deepEqual(fork.defaultHost('other.example.com'), { host: 'other.example.com', prefix: '', family: 'embed.example.com' },
    'a served host the fork does not offer keeps its own links, as forsen.sex does on mbedfx.app')
  assert.equal(fork.defaultHost('x-mbedfx.acct.workers.dev').family, 'embed.example.com', 'a preview presses the first button')
  assert.equal(fork.convert('https://x.com/jack/status/20').url, 'https://embed.example.com/jack/status/20')
  const back = fork.convert('https://other.example.com/jack/status/20', 'embed.example.com')
  assert.equal(back.url, 'https://embed.example.com/jack/status/20', 'a link from one of its own hosts is re-pointed')
  assert.doesNotMatch(back.note, /fediverse/i)
  assert.equal(fork.convert('https://d.other.example.com/jack/status/20', 'embed.example.com').path, '/jack/status/20',
    'and so is its media-only link pasted back')
})

test('MEDIA ONLY IS OFFERED ONLY WHERE A d. NAME IS DECLARED, and everywhere on a copy with no block', () => {
  /**
   * A d. name works only once somebody has pointed DNS at it. Before phase 5 the box was offered on every
   * domain, which is true of all five on mbedfx.app and of no domain at all on a fork that never set one
   * up, where every media-only link the page handed out resolved nowhere. The Worker sends the d. names
   * its vars declare, and the page offers the box on exactly those domains. A copy with no block cannot
   * know, and keeps offering it, which is what it always did.
   */
  for (const h of ['mbedfx.app', 'forsen.sex', 'anything.example']) assert.equal(hasMediaOnly(h), true, `${h}, no block`)
  const fork = loadConverter({
    primary: 'https://embed.example.com', host: 'embed.example.com',
    ours: ['embed.example.com', 'guest.example'], public: ['embed.example.com', 'guest.example'],
    guests: ['guest.example'], direct: ['d.embed.example.com'],
  })
  assert.equal(fork.hasMediaOnly('embed.example.com'), true)
  assert.equal(fork.hasMediaOnly('EMBED.example.com.'), true, 'case and a trailing dot are the same domain')
  assert.equal(fork.hasMediaOnly('guest.example'), false, 'declared for one domain is not declared for the other')
  assert.equal(fork.hasMediaOnly('d.embed.example.com'), false, 'and a d. host has no d. of its own: no d.d.')
  const bare = loadConverter({ primary: 'https://embed.example.com', host: 'embed.example.com',
    ours: ['embed.example.com'], public: ['embed.example.com'], guests: [], direct: [] })
  assert.equal(bare.hasMediaOnly('embed.example.com'), false, 'a fork that declared none is offered none')
})

test('THE TOGGLE SHOWS THE DOMAINS, NOT A NICKNAME FOR THEM', () => {
  /**
   * Reported by the owner: the second option used to read "the original", which tells a first-time
   * visitor nothing — they cannot know what the original was, and the whole point of the control is
   * choosing which hostname ends up in the link they paste. Each button must say the domain it emits.
   */
  for (const host of ['mbedfx.app', 'megapenispoopenfarten.sex']) {
    const button = new RegExp(`data-host="${host.replace(/\./g, '\\.')}"[^>]*>\\s*${host.replace(/\./g, '\\.')}\\s*<`)
    assert.match(HTML, button, `the ${host} button must be labelled with ${host}`)
  }
  assert.ok(!/>\s*the original\s*</.test(HTML), '"the original" names nothing a visitor can act on')
})

test('EVERY PLATFORM CARRIES A MARK, AND NO MARK IS FETCHED', () => {
  /**
   * Also reported by the owner: a list of platform names with no logos is hard to scan. The obvious
   * implementations are the wrong ones — hotlinking each site's /favicon.ico tells seventeen
   * companies the IP of everyone who opens this page, and a favicon proxy tells one company all of
   * it. Both are exactly what this project spends its time removing from other people's links.
   * So the marks are inline SVG paths, and this pins that they exist AND stay local.
   */
  const icons = HTML.match(/var ICON = \{[\s\S]*?\n {2}\};/)
  assert.ok(icons, 'the inline mark set must be present')
  for (const { name, icon } of PLATFORMS) {
    assert.ok(icon, `${name} must name a mark`)
    assert.ok(new RegExp(`\\n\\s{4}(// [^\\n]*\\n\\s{4})*${icon}:`).test(icons[0]) || icons[0].includes(`${icon}:`),
      `${name} names mark "${icon}" but it is not in the inline set`)
  }
  assert.ok(!/favicon\.(ico|png)"[^>]*https?:/i.test(HTML), 'no remote favicons')
  assert.ok(!/s2\/favicons|favicone|icon\.horse|duckduckgo\.com\/ip3/i.test(HTML),
    'no third-party favicon service — that is one company logging every visitor')
})

test('AN ALREADY-CONVERTED LINK IS RE-POINTED, NOT DOUBLE-WRAPPED', () => {
  const r = convert('https://megapenispoopenfarten.sex/jack/status/20', 'mbedfx.app')
  assert.equal(r.url, 'https://mbedfx.app/jack/status/20')
  assert.equal(routed('/jack/status/20').ref.p, 'x')
})

test('A BARE PATH AND A SCHEMELESS PASTE BOTH WORK', () => {
  assert.equal(convert('twitter.com/jack/status/20', 'mbedfx.app').url, 'https://mbedfx.app/jack/status/20')
  assert.equal(convert('/jack/status/20', 'mbedfx.app').url, 'https://mbedfx.app/jack/status/20')
})

test('THE STILLS TOGGLE APPENDS /p, AND THE ROUTER READS BACK EXACTLY WHAT THE PAGE EMITTED', () => {
  /**
   * The page and the router are checked against EACH OTHER, never against a hand-written
   * expectation — this file's founding rule. A suffix the page appends but the router does not
   * strip would be a link that 404s, which is the one outcome the converter must never produce, and
   * only running both halves can catch it.
   */
  for (const pasted of [
    'https://www.instagram.com/p/DaQ5CPTki4E/',
    'https://x.com/jack/status/20',
    'https://www.reddit.com/r/pics/comments/haucpf/',
  ]) {
    const plain = convert(pasted, 'mbedfx.app')
    const stills = convert(pasted, 'mbedfx.app', 'stills')
    assert.equal(stills.path, `${plain.path}/p`, 'the toggle appends /p to the path the page already computes')
    // The suffixed link must name the SAME post the unsuffixed one does, and carry the mode.
    const a = routed(plain.path)
    const b = routed(stills.path)
    assert.deepEqual(b.ref, a.ref, `${stills.path} must resolve to the same post as ${plain.path}`)
    assert.equal(b.gallery, 'stills')
    assert.equal(a.gallery, undefined, 'and an unsuffixed link must name no mode at all')
  }

  // UNTICKED EMITS NOTHING, not /v. Videos-first is already the worker's default, and spelling it
  // out would freeze today's default into every link ever shared — Discord caches an embed from its
  // first crawl, so the link would keep rendering this default after the default moved.
  assert.equal(convert('https://x.com/jack/status/20', 'mbedfx.app').path, '/jack/status/20')
  assert.equal(convert('https://x.com/jack/status/20', 'mbedfx.app', undefined).path, '/jack/status/20')

  // THE QUERY SURVIVES, and the suffix lands on the PATH. /watch?v=abc/p would strand the suffix
  // inside the query string, where the router — which strips a trailing path segment — never sees it.
  const yt = convert('https://www.youtube.com/watch?v=jNQXAC9IVRw', 'mbedfx.app', 'stills')
  assert.equal(routed(yt.path).gallery, 'stills', `the youtube spelling must carry the mode: ${yt.path}`)
  assert.equal(routed(yt.path).ref.id, 'jNQXAC9IVRw', 'and still name the video')

  // IDEMPOTENT ROUND TRIP. Pasting one of our own suffixed links back in, with the box off, gives
  // the bare post — not /post/v/p, which the router would read as "mode p on a post whose id is v".
  assert.equal(convert('https://mbedfx.app/jack/status/20/p', 'mbedfx.app').path, '/jack/status/20')
  assert.equal(convert('https://mbedfx.app/jack/status/20/v', 'mbedfx.app', 'stills').path, '/jack/status/20/p')

  // AND /p ALONE IS STILL A REAL PATH, not a suffix on nothing — it is Instagram's shape.
  assert.equal(convert('https://mbedfx.app/p/DaQ5CPTki4E', 'mbedfx.app').path, '/p/DaQ5CPTki4E')
})

test('THE UNSUPPORTED SHORTENERS ARE REFUSED WITH A REASON, NOT A BROKEN LINK', () => {
  /**
   * THE POINT: these hide the post behind an opaque code, so there is nothing in the path that names
   * a site. Emitting a link anyway would produce a card that fails — worse than saying so up front.
   * Each refusal must explain what to do instead.
   */
  /**
   * REWRITTEN 2026-11-25. This listed `https://pin.it/3xK9dLm` as a link to refuse, because nothing in a
   * pin.it path names a pin. The worker now resolves the code (router.ts pinShortlink(), the pn arm in
   * worker.ts), so a well-shaped pin.it link converts and is pinned in the pin.it test below. What is
   * still refused is a pin.it link whose code is not a code (PIN_SHORT_CODE), with the old explanation.
   */
  for (const paste of [
    'https://vm.tiktok.com/ZMhqBqQFa/',
    'https://vt.tiktok.com/ZSMhqBqQF/',
    'https://fb.watch/x1Y2z3A4b/',
    'https://pin.it/3xK',
    'https://pin.it/3xK9dLm/extra',
  ]) {
    const r = convert(paste, 'mbedfx.app')
    assert.equal(r.ok, false, `${paste} must be refused rather than mis-converted`)
    assert.ok(r.why && r.why.length > 30, `${paste} must explain itself, got: ${r.why}`)
  }
})

test('A PINTEREST "SHARED WITH YOU" LINK COMES OUT AS THE BARE /pin/{id}, without sent or the tracking', () => {
  /**
   * Reported 2026-11-25: pinterest.com/pin/{id}/sent/?invite_code=…&sender=…&sfo=1 converted to
   * /pin/{id}/sent. The query was already gone and the worker already read `sent` as a UI hint, so the
   * card was right, but the link handed out still carried the word. Every id here is invented.
   */
  const id = '8800000000000000501'
  for (const paste of [
    `https://www.pinterest.com/pin/${id}/sent/?invite_code=feedfacecafe0000&sender=777000000000000123&sfo=1`,
    `https://www.pinterest.com/pin/${id}/sent`,
    `https://www.pinterest.com/pin/${id}/`,
    `https://pinterest.com/pin/${id}`,
    `https://www.pinterest.com/pin/a-made-up-slug--${id}/`,
    `https://www.pinterest.com/pin/${id}/feedback/`,
    `https://www.pinterest.com/pin/${id}/visual-search/?x=1`,
    `https://de.pinterest.com/pin/${id}/sent/`,
    `https://www.pinterest.co.uk/pin/${id}/sent/`,
    `https://www.pinterest.com.au/pin/${id}/sent/`,
  ]) {
    for (const host of ['mbedfx.app', ...GUEST_HOSTS]) {
      const r = convert(paste, host)
      assert.equal(r.url, `https://${host}/pin/${id}`, paste)
      assert.equal(r.code, 'pn')
      assert.deepEqual(routed(r.path).ref, { p: 'pn', id }, `${r.url} is the same pin`)
    }
  }
  // The gallery box still adds its mode to a pin, as before.
  assert.equal(convert(`https://www.pinterest.com/pin/${id}/sent/`, 'mbedfx.app', 'stills').path, `/pin/${id}/p`)
})

test('A /pin/ SHAPE THE ROUTER DOES NOT READ IS PASSED THROUGH AS IT WAS, never given an invented canonical', () => {
  // These are not pins to the worker, so the converter must not rewrite them into one.
  for (const p of [
    '/pin/8800000000000000511/comments',      // an unknown trailing segment
    '/pin/8800000000000000512/sent/extra',    // depth 4
    '/pin/0880000000000000513/sent',          // a zero-led id
    '/pin/1234/sent',                         // too short to be an id
    '/pin/not-a-pin/sent',
  ]) {
    const r = convert(`https://www.pinterest.com${p}/`, 'mbedfx.app')
    assert.equal(r.path, p, `${p} is left alone`)
  }
})

test('A PIN LINK PASTED BACK FROM ONE OF OUR OWN HOSTS DROPS /sent TOO, not only one pasted from pinterest.com', () => {
  /**
   * Review, 2026-11-25: the canonicalisation ran only in the direct-host branch, so the links the old
   * converter handed out (/pin/{id}/sent on a guest host), and a pinterest link with only its host
   * swapped by hand, came back unchanged as "already an mbedfx link", /sent and all. That is the
   * exact link the owner reported.
   */
  const id = '8800000000000000531'
  for (const from of ['mbedfx.app', ...GUEST_HOSTS, `d.${GUEST_HOSTS[0]}`]) {
    for (const p of [`/pin/${id}/sent`, `/pin/${id}/sent/?invite_code=feedfacecafe0000&sender=777000000000000123&sfo=1`,
      `/pin/slug--${id}/feedback/`, `/pin/${id}/visual-search/p`, `/pin/${id}`]) {
      const r = convert(`https://${from}${p}`, 'mbedfx.app')
      assert.equal(r.path, `/pin/${id}`, `${from}${p}`)
      assert.deepEqual(routed(r.path).ref, { p: 'pn', id })
      assert.doesNotMatch(r.url, /sent|invite_code|sender|sfo/)
    }
  }
  // The forced twin keeps its token, and a shape the router does not read still passes through.
  assert.equal(convert(`https://mbedfx.app/pn/pin/${id}/sent`, 'mbedfx.app').path, `/pn/pin/${id}`)
  assert.equal(convert(`https://mbedfx.app/pin/${id}/comments`, 'mbedfx.app').path, `/pin/${id}/comments`)
  // And the gallery box still adds its mode afterwards.
  assert.equal(convert(`https://mbedfx.app/pin/${id}/sent`, 'mbedfx.app', 'stills').path, `/pin/${id}/p`)
})

test('THE FORCED /pn/pin.it/{code} TWIN TAKES NO GALLERY MODE, like the plain short link', () => {
  // Review, 2026-11-25: withGallery exempted /pin.it/{code} but not /pn/pin.it/{code}, so "all as
  // stills" handed out /pn/pin.it/{code}/p, which the router reads as notfound on every host.
  for (const gallery of ['stills', 'videos']) {
    const r = convert('https://mbedfx.app/pn/pin.it/Zq7Wv3Kp9', 'mbedfx.app', gallery)
    assert.equal(r.path, '/pn/pin.it/Zq7Wv3Kp9', gallery)
    assert.notEqual(routed(r.path).kind, 'notfound')
  }
})

test('mbedfxPinId READS EXACTLY THE /pin/ SHAPES router.ts pinterest() READS', () => {
  // The page keeps a copy of the router's rule (no build step). Held equal over a sweep of spellings.
  const ids = ['8800000000000000521', '12345', '1234', '0880000000000000522', '1'.repeat(23), 'abc']
  const seconds = ids.flatMap(i => [i, `slug--${i}`, `a--b--${i}`, `${i}--slug`])
  // Not 'p' or 'v': those are the router's gallery suffix, peeled before pinterest() runs. A pasted
  // pinterest.com/pin/{id}/p is passed through unchanged, as it was before mbedfxPinId existed.
  const thirds = [null, 'sent', 'feedback', 'visual-search', 'comments', 'clip', '']
  for (const s of seconds) {
    for (const t of thirds) {
      const seg = t === null ? ['pin', s] : ['pin', s, t].filter(Boolean)
      const r = routed('/' + seg.join('/'))
      const want = r.kind === 'post' && r.ref.p === 'pn' ? r.ref.id : null
      assert.equal(pinId(seg), want, seg.join('/'))
    }
  }
})

test('pin.it/{code} CONVERTS TO /pin.it/{code}, THE PINTEREST SHORT LINK, with its case kept and its tracking dropped', () => {
  /**
   * The code names no pin until the worker asks Pinterest's shortener, so "routes to a post" is the wrong
   * assertion here, as for /t/{code}: it must reach the resolver, and prep() then swaps it for /pin/{id}.
   * Codes are case-sensitive (measured 2026-11-25), so the code must come out exactly as pasted.
   */
  for (const [paste, code] of [
    ['https://pin.it/Rq7Lm3Zx9', 'Rq7Lm3Zx9'],
    ['pin.it/Rq7Lm3Zx9', 'Rq7Lm3Zx9'],
    ['https://pin.it/Rq7Lm3Zx9/', 'Rq7Lm3Zx9'],
    ['https://pin.it/Ab3dE5f?utm_source=share', 'Ab3dE5f'],
    ['https://www.pin.it/AbCdEfG1', 'AbCdEfG1'],
  ]) {
    for (const host of ['mbedfx.app', ...GUEST_HOSTS]) {
      for (const gallery of [undefined, 'stills']) {
        const r = convert(paste, host, gallery)
        assert.equal(r.ok, true, `${paste} converts`)
        assert.equal(r.url, `https://${host}/pin.it/${code}`, `${paste} on ${host}${gallery ? ', all as stills' : ''}`)
        assert.equal(r.code, 'pn')
        const got = route(new URL(r.url))
        assert.deepEqual([got.kind, got.p, got.code], ['shortlink', 'pn', code], `${r.url} reaches the pin.it resolver`)
        assert.ok(guestServes(got), 'on every host the page offers')
        assert.ok(!r.url.includes('utm_'), 'and the tracking is gone')
      }
    }
  }
  // A code that is not a code keeps the refusal this branch used to give every pin.it link.
  for (const bad of ['https://pin.it/', 'https://pin.it/Ab3', 'https://pin.it/Ab3-dE5f', 'https://pin.it/a/b']) {
    const r = convert(bad, 'mbedfx.app')
    assert.equal(r.ok, false, bad)
    assert.equal(r.why, pinRefusal, `${bad}: the old explanation`)
  }
})

test('THE PAGE\'S PIN_SHORT_CODE IS refkey.ts\'s, character for character', () => {
  const refkey = readFileSync(new URL('../src/refkey.ts', import.meta.url), 'utf8')
  const src = (refkey.match(/export const PIN_SHORT_CODE = (\/.*\/)\n/) || [])[1]
  assert.ok(src, 'refkey.ts still declares PIN_SHORT_CODE')
  assert.equal(pinShortCode.source, src.slice(1, -1), 'the converter and the router accept the same codes')
})

test('A RESOLVED pin.it LINK STAYS RESOLVED ACROSS DOMAIN AND MEDIA-ONLY TOGGLES, the way a TikTok one does', () => {
  /**
   * resolvedTo is keyed on the BASE path the page asked about. For that to hold, the path must not change
   * with any toggle: the domain moves the host, media only adds `d.` to the host, and all as stills adds
   * nothing to a short link (withGallery). If any of them changed the path, render() would miss the
   * entry and put the share code back on screen. The /_prep answer, re-pointed, must name the pin and be
   * served on every host.
   */
  const asked = convert('https://pin.it/Rq7Lm3Zx9', 'mbedfx.app').url
  const key = asked.slice(asked.indexOf('/', 8))
  const answer = 'https://mbedfx.app/pin/8800000000000000531/'
  assert.equal(prepResolved(asked, answer), true, 'the answer is filed as a resolution')
  for (const host of [...publicHosts, 'forsen.sex']) {
    for (const gallery of [undefined, 'stills']) {
      const r = convert('https://pin.it/Rq7Lm3Zx9', host, gallery)
      assert.equal(r.url.slice(r.url.indexOf('/', 8)), key, `${host}${gallery ? ' stills' : ''}: same key, so render() finds the answer`)
    }
    for (const on of [false, true]) {
      const shown = repoint(answer, host, on)
      assert.equal(shown, `https://${on ? 'd.' : ''}${host}/pin/8800000000000000531/`)
      assert.deepEqual(route(new URL(shown)).ref, { p: 'pn', id: '8800000000000000531' })
      assert.ok(!shown.includes('Rq7Lm3Zx9'), 'the code is not put back')
    }
  }
})

test('A pin.it CODE /_prep COULD NOT RESOLVE SHOWS THE OLD REFUSAL, and keeps showing it through the toggles', () => {
  // The DOM half cannot run here, so its decision is pinned by text, as the resolvedTo tests above are.
  assert.match(HTML, /if \(!j\.ok && j\.reason === 'shortlink' && isPinShort\(path\)\) \{\s+pinUnresolved\[path\] = true;/)
  assert.match(HTML, /: pinUnresolved\[r\.path\] \? chip \+ '\. ' \+ esc\(PIN_IT_REFUSAL\)/,
    'render() reads it back, so a domain or media-only click keeps the warning')
  assert.equal((HTML.match(/pinUnresolved\[[^\]]+\] = /g) || []).length, 1, 'filed in one place')
  assert.ok(pinRefusal.length > 30 && !/—|\byou\b/i.test(pinRefusal), 'visible copy, held to the page rules')
})

test('THE THINGS THE PAGE SAYS WON\'T WORK ARE ALSO REFUSED BY THE CONVERTER', () => {
  // The "Won't work" section and the converter must not disagree with each other.
  for (const paste of [
    'https://www.instagram.com/stories/someone/3521234567890123456/',
    'https://www.twitch.tv/videos/1234567890',
    'https://www.twitch.tv/xqc',
  ]) {
    assert.equal(convert(paste, 'mbedfx.app').ok, false, `${paste} must be refused`)
  }
})

test('IMGUR ALBUMS AND GALLERIES CONVERT — they used to be on the refusal list', () => {
  /**
   * Both were "won't work" until 2026-07-31, for a reason that was about yt-dlp rather than about
   * Imgur: the extractor refuses a still outright and hands back a bare playlist for an album. Imgur's
   * own API answers both, so the page had to stop saying otherwise — and the converter and the
   * "#nope" list have to agree, which the test above is what enforces.
   *
   * The two shapes convert DIFFERENTLY on purpose. /a/ is Imgur's alone. /gallery/ is contested with
   * Reddit and Instagram, so it gets the /im/ prefix rather than silently claiming their row.
   */
  const album = convert('https://imgur.com/a/iX265HX', 'mbedfx.app')
  assert.equal(album.url, 'https://mbedfx.app/a/iX265HX')
  assert.deepEqual(routed('/a/iX265HX').ref, { p: 'im', kind: 'album', id: 'iX265HX' })

  const gallery = convert('https://imgur.com/gallery/YcAQlkx', 'mbedfx.app')
  assert.equal(gallery.url, 'https://mbedfx.app/im/gallery/YcAQlkx')
  assert.deepEqual(routed('/im/gallery/YcAQlkx').ref, { p: 'im', kind: 'gallery', id: 'YcAQlkx' })

  /**
   * THE SHAPE IMGUR ACTUALLY HANDS OUT. Both surfaces above carry an SEO slug in front of the id
   * (`{seo_title}-{id}`) — imgur.com's own og:url for gallery aZVXS is the slug form, from every
   * request path, and the bare spellings this file used to pin are no longer PRODUCED by the site
   * even though they still resolve. The page passes the segment through untouched, which is correct
   * and stays correct; it was the router that refused it, and a live 7-image album unfurled as
   * "Not found" in production (reported 2026-08-15). Pinned from the page's side as well as the
   * router's because this is the journey that actually broke: paste, copy the offered link, get a
   * failure card. Neither half is wrong alone.
   */
  const SLUG = 'black-lotus-magic-gathering-card-destroyed-accidentally-aZVXS'
  assert.equal(convert(`https://imgur.com/gallery/${SLUG}`, 'mbedfx.app').url,
    `https://mbedfx.app/im/gallery/${SLUG}`)
  assert.deepEqual(routed(`/im/gallery/${SLUG}`).ref, { p: 'im', kind: 'gallery', id: 'aZVXS' })

  assert.equal(convert(`https://imgur.com/a/${SLUG}`, 'mbedfx.app').url, `https://mbedfx.app/a/${SLUG}`)
  assert.deepEqual(routed(`/a/${SLUG}`).ref, { p: 'im', kind: 'album', id: 'aZVXS' })

  // A still photo still needs the prefix — a bare id is undecidable against Dailymotion.
  assert.equal(convert('https://imgur.com/QAcLnaf', 'mbedfx.app').url, 'https://mbedfx.app/im/QAcLnaf')
  assert.deepEqual(routed('/im/QAcLnaf').ref, { p: 'im', kind: 'post', id: 'QAcLnaf' })
})

test('AN UNKNOWN HOST IS TREATED AS A FEDIVERSE INSTANCE, and says so', () => {
  /**
   * The right default: there is no allow-list of instances (there cannot be — anyone can run one), so
   * an unrecognised host with a post-shaped path is exactly what a small Mastodon server looks like.
   */
  const r = convert('https://social.example.org/@someone/109876543210987654', 'mbedfx.app')
  assert.ok(r.ok)
  assert.equal(r.url, 'https://mbedfx.app/social.example.org/@someone/109876543210987654')
  assert.match(r.note, /fediverse/i, 'the guess must be visible to the person making it')
  assert.equal(routed('/social.example.org/@someone/109876543210987654').ref.p, 'ms')
})

test('JUNK IS REFUSED WITHOUT THROWING', () => {
  for (const junk of ['', '   ', 'hello world', 'ftp://', '::::', 'https://', '1.2.3.4/post/1']) {
    const r = convert(junk, 'mbedfx.app')
    assert.equal(typeof r, 'object')
    assert.equal(r.ok, false, `${JSON.stringify(junk)} must not produce a link`)
  }
  for (const junk of [undefined, null, 0, {}, []]) {
    assert.doesNotThrow(() => convert(junk, 'mbedfx.app'), `${String(junk)} must not throw`)
  }
})

test('A SITE FRONT PAGE IS NOT A POST', () => {
  for (const paste of ['https://twitter.com', 'https://www.instagram.com/', 'https://lemmy.world/']) {
    assert.equal(convert(paste, 'mbedfx.app').ok, false, `${paste} names no post`)
  }
})

test('LIGHT MODE IS REACHABLE, not just defined', () => {
  /**
   * Reported as "there's no light mode", and the report was exactly right in a way worth recording:
   * a full light palette existed, but it was keyed ONLY on prefers-color-scheme. Anyone whose machine
   * is set to dark could never see it, and I only ever reached it myself by editing a scratch copy of
   * this file — which should have been the tell.
   *
   * Three states, because a two-way toggle silently overrides the OS forever after one click.
   */
  for (const mode of ['system', 'light', 'dark']) {
    assert.match(HTML, new RegExp(`data-theme-set="${mode}"`), `the theme switch must offer ${mode}`)
  }
  assert.match(HTML, /\[data-theme="light"\]\s*\{\s*color-scheme:\s*light/, 'light must be forceable')
  assert.match(HTML, /\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark/, 'dark must be forceable')
  // Applied before first paint, or a stored choice flashes the wrong theme on every load.
  const head = HTML.slice(0, HTML.indexOf('<style'))
  assert.match(head, /localStorage\.getItem\('mbedfx-theme'\)/, 'the stored theme must apply pre-paint')
})

test('EVERY COLOUR TOKEN HAS A PLAIN FALLBACK BEFORE ITS light-dark()', () => {
  /**
   * light-dark() carries the whole palette, so a browser that does not understand it would otherwise
   * drop every colour and render unstyled text. Declaring the plain value first means an old browser
   * keeps a complete light theme instead.
   */
  const root = HTML.match(/:root \{[\s\S]*?\n\}/)
  assert.ok(root, ':root must define the palette')
  const tokens = [...root[0].matchAll(/(--[\w-]+):\s*light-dark\(/g)].map(m => m[1])
  assert.ok(tokens.length >= 15, `expected a full palette, found ${tokens.length}`)
  for (const t of tokens) {
    const fallback = new RegExp(`${t}:\\s*#[0-9a-f]{3,8};\\s*${t}:\\s*light-dark\\(`, 'i')
    assert.match(root[0], fallback, `${t} needs a plain value declared before its light-dark()`)
  }
})

test('EVERY TEXT COLOUR CLEARS WCAG AA IN BOTH THEMES', () => {
  /**
   * Reported as "the contrast is a bit off in dark mode", and measuring rather than squinting found
   * three separate failures — the secondary greys in BOTH themes, and then the refusal red at 4.47:1
   * on the dark chat background, which only showed up after the greys were fixed.
   *
   * This computes real relative luminance per WCAG 2.1 over every foreground/background pair the page
   * actually uses, in both halves of every light-dark(). Eyeballing is what let a 3.74:1 pair ship.
   */
  const root = HTML.match(/:root \{[\s\S]*?\n\}/)[0]
  const P = {}
  for (const m of root.matchAll(/(--[\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)) {
    P[m[1]] = [m[2], m[3]]
  }

  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const lum = hex => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  }
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  const PAIRS = [
    ['--text', '--chat-bg'], ['--head', '--chat-bg'], ['--muted', '--chat-bg'], ['--faint', '--chat-bg'],
    ['--text', '--embed-bg'], ['--muted', '--embed-bg'], ['--faint', '--embed-bg'],
    ['--faint', '--side-bg'], ['--faint', '--input-bg'],
    ['--link', '--chat-bg'], ['--red', '--chat-bg'], ['--red', '--embed-bg'],
    ['--brand-mono', '--embed-bg'],
  ]

  for (const [fg, bg] of PAIRS) {
    assert.ok(P[fg] && P[bg], `${fg}/${bg} must be defined as light-dark() pairs`)
    for (const [i, theme] of ['light', 'dark'].entries()) {
      const r = ratio(P[fg][i], P[bg][i])
      assert.ok(r >= 4.5, `${fg} on ${bg} in ${theme} is ${r.toFixed(2)}:1, below WCAG AA 4.5`)
    }
  }
})

test('THE PAGE FETCHES NOTHING FROM ANYONE', () => {
  /**
   * A page that advertises stripping other people's trackers does not get to load a font from a CDN
   * and hand every visitor's IP to a third party. Pinned so a later "just add a webfont" cannot land
   * quietly. Self-referential hrefs (the source link) are fine; subresources are not.
   */
  assert.ok(!/<link[^>]+href="https?:\/\//i.test(HTML), 'no external stylesheets or preconnects')
  assert.ok(!/<script[^>]+src=/i.test(HTML), 'no external scripts')
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(HTML), 'no remote CSS imports or assets')
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/i.test(HTML), 'no Google Fonts')
})

/**
 * SITE DETECTION — owner asked for BOTH halves: a detected-site chip on every conversion, AND a
 * picker when the input is genuinely ambiguous. A guess that is shown can be corrected; a guess made
 * silently costs a card and nobody learns why.
 */
test('THE CONVERTER HANDS BACK A PLATFORM CODE, not just a display name', () => {
  // The chip shows the NAME; forcing an override needs the router's ESCAPE token, which is the code.
  for (const [paste, code] of [
    ['https://www.tiktok.com/@kfc.laos/video/7658012561153035542', 'tt'],
    ['https://twitter.com/jack/status/20', 'x'],
    ['https://youtu.be/dQw4w9WgXcQ', 'yt'],
    ['https://imgur.com/a/iX265HX', 'im'],
    ['https://streamable.com/moo', 'st'],
    ['https://redd.it/haucpf', 'rd'],
  ]) {
    const r = convert(paste, 'mbedfx.app')
    assert.equal(r.ok, true, paste)
    assert.equal(r.code, code, `${paste} must report its platform code`)
    assert.ok(r.path && r.path.startsWith('/'), 'and the path an override would prefix')
  }
})

test('EVERY PLATFORM IN THE TABLE HAS A CODE THE ROUTER WILL FORCE', () => {
  /**
   * The override builds `/{code}{path}`, which only works if every code is a real ESCAPE token. A
   * missing or wrong one would silently emit a link that routes nowhere.
   */
  const m = HTML.match(/var CODE_OF = \{[\s\S]*?\};/)
  assert.ok(m, 'the page must carry a name -> code map')
  const CODE_OF = new Function(`${m[0]} return CODE_OF`)()
  for (const { name } of PLATFORMS) {
    const code = CODE_OF[name]
    assert.ok(code, `${name} has no code`)
    // Forcing must reach that platform: /{code}/... is the router's own escape hatch.
    const forced = routed(`/${code}/jack/status/20`)
    assert.ok(forced.kind === 'post' || forced.kind === 'notfound' || forced.kind === 'ambiguous',
      `/${code}/ must be a token the router recognises, got ${forced.kind}`)
  }
})

test('THE PAGE SHOWS THE CHIP AND OFFERS THE ROUTER\'S OWN CANDIDATES', () => {
  // Pinned by reading the page: a correct function nobody wires up is the likelier regression, which
  // is the same reason the origin-default test greps for its call site.
  assert.match(HTML, /id="siteChip"/, 'every conversion gets a chip')
  assert.match(HTML, /data-force="/, 'and the picker forces by platform code')
  assert.match(HTML, /j\.reason === 'ambiguous' && j\.candidates/, 'candidates come from /_prep, not a guess')
  assert.match(HTML, /showPicker\(ALL, 'Read it as:'\)/, 'and the chip opens the full list')
})

test("THE SITE'S OWN CARD IS COMPLETE, and the image it names is actually served", () => {
  /**
   * The head had a title, a one-line description and nothing else — no image, no url, no
   * twitter:card — so sharing mbedfx.app in Discord drew a bare strip of text. A conspicuous way for
   * an embed fixer to fail, and the first thing anyone sees when the link is passed around.
   *
   * THE ROUTE ASSERTION IS THE LOAD-BEARING HALF. SITE_PATHS is a CLOSED allowlist: an og:image
   * pointing at a path the worker does not serve 404s, and the card then draws no picture at all —
   * which looks identical to having no og:image and is much harder to notice.
   */
  const head = HTML.slice(0, HTML.indexOf('<style'))
  for (const tag of [
    'property="og:image"', 'property="og:image:width"', 'property="og:image:height"',
    'property="og:url"', 'property="og:site_name"', 'name="twitter:card"',
  ]) {
    assert.ok(head.includes(tag), `the site's own card needs ${tag}`)
  }
  const img = head.match(/property="og:image" content="([^"]+)"/)[1]
  const path = new URL(img).pathname
  assert.equal(route(new URL(`https://mbedfx.app${path}`)).kind, 'site',
    `${path} must be a served asset, not a 404`)
  // Dimensions are declared because Discord will not draw a large image without them.
  assert.match(head, /property="og:image:width" content="1200"/)
  assert.match(head, /property="og:image:height" content="630"/)
})

test('THE README\'S FORCING CODES ARE THE ROUTER\'S, in the table\'s own order', () => {
  /**
   * The README documents a two-letter code per site for forcing an interpretation. Two ways that
   * goes stale: a code is renamed in the router and the docs keep the old one, or a platform is
   * added and the list silently omits it. Both leave a reader typing a url that does not route.
   *
   * Asserted against route() itself rather than against a copy of the list, and against the site
   * table's ORDER, because the README claims the codes are given in that order.
   */
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

  const codes = (readme.match(/^`x` (?:`\w+` )+`pt`/m) || [''])[0]
    .split(/\s+/).map(c => c.replace(/`/g, '')).filter(Boolean)
  assert.ok(codes.length >= 17, `found ${codes.length} codes in the README`)

  // Every documented code must actually force something — route() falls through when a forced
  // matcher misses, so a dead code is silently indistinguishable from a typo.
  for (const c of codes) {
    const r = route(new URL(`https://mbedfx.app/${c}/status/20`))
    assert.ok(r && r.kind !== undefined, `/${c}/… must reach the router`)
  }

  // And the order must match the site table directly beneath it.
  const rows = [...readme.matchAll(/\| <img[^|]+\| ([A-Za-z]+) \|/g)].map(m => m[1])
  const EXPECT = {
    x: 'Twitter', tt: 'TikTok', ig: 'Instagram', th: 'Threads', rd: 'Reddit', bs: 'Bluesky',
    yt: 'YouTube', fb: 'Facebook', tw: 'Twitch', pn: 'Pinterest', dm: 'Dailymotion',
    st: 'Streamable', im: 'Imgur', ms: 'Mastodon', mk: 'Misskey', lm: 'Lemmy', pt: 'PeerTube',
  }
  assert.deepEqual(codes.map(c => EXPECT[c]), rows,
    'the code list and the site table must be in the same order — the README says they are')
})

/* ===================== THE CHANNELS, AND THE VERSION =====================
 *
 * Requested 2026-08-02: a version number on the live site, and "since we're mimicking the discord
 * layout we should make it so that it's really a mimick where the 'channels' don't all show as one
 * page".
 */

test('THE SITE\'S VERSION MATCHES package.json — a stale one is worse than none', () => {
  /**
   * The page is a static asset with no template step, so the version is hardcoded in the markup.
   * That is fine only if something fails when it drifts, which is this. A version badge that
   * disagrees with the release it shipped in makes every bug report ambiguous.
   */
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const shown = /<span class="ver" id="ver">v([^<]+)<\/span>/.exec(HTML)
  assert.ok(shown, 'the page carries a version badge')
  assert.equal(shown[1], pkg.version, 'and it is the version this build actually is')
})

test('EVERY CHANNEL IS ITS OWN SECTION, so one can be shown without showing the rest', () => {
  /**
   * The channels used to be UNWRAPPED — a `div.chanbar.chan#sites` was a sibling of the article
   * holding its content, so there was no single element per channel to toggle. Any future edit that
   * adds a channel has to wrap it, or it will render on every channel at once.
   */
  const ids = [...HTML.matchAll(/<section class="chan" id="([^"]+)" data-desc="([^"]*)"/g)]
  assert.ok(ids.length >= 5, `every channel is a <section class="chan">, found ${ids.length}`)
  for (const [, id, desc] of ids) {
    assert.ok(desc.trim(), `#${id} has a description for the channel bar to show`)
  }
  // The sidebar and the sections must name the same set: a link to a channel that does not exist
  // silently falls back to the first one, which looks like a broken link rather than a missing page.
  const linked = [...HTML.matchAll(/<a href="#([a-z]+)"><b>#<\/b>/g)].map(m => m[1])
  assert.deepEqual(linked.sort(), ids.map(m => m[1]).sort(),
    'the sidebar links and the channel sections are the same set')
})

test('THE IN-PAGE CHANNEL DIVIDERS ARE GONE — the sticky bar is the one place the name appears', () => {
  /**
   * Reported as "the 'convert' header isn't bold like the rest". It was never about boldness: every
   * channel had a bold `# name` divider EXCEPT convert, which sat at the top where the sticky bar
   * already stood in for one. With one channel on screen the divider repeats the bar directly above
   * it, so the whole set went rather than convert gaining one.
   */
  assert.equal(HTML.match(/class="chanbar chan"/g), null,
    'no channel repeats its own name immediately under the bar that already shows it')
  assert.ok(/<div class="chanbar top">/.test(HTML), 'the sticky bar is still there')
})

test('PORTRAIT MOBILE CAN STILL CHANGE CHANNEL', () => {
  /**
   * Reported: "there's no sidebar nav on portrait mobile". The 800px breakpoint hid `.rail, .side`
   * outright, which was survivable while every channel was on one scroll and became a dead end the
   * moment channels started hiding each other — you could reach exactly the one you landed on.
   */
  const mobile = /@media \(max-width: 800px\) \{[\s\S]*?\n\}/.exec(HTML)
  assert.ok(mobile, 'the mobile breakpoint exists')
  assert.ok(!/\.rail,\s*\.side \{ display: none/.test(mobile[0]),
    'the channel list is not hidden outright on mobile')
  assert.ok(/\.navtoggle \{ display: inline-flex/.test(mobile[0]), 'a channel-list toggle appears')
  assert.ok(/id="navToggle"/.test(HTML) && /id="scrim"/.test(HTML), 'the toggle and its scrim exist')
  assert.ok(/aria-expanded="false"/.test(HTML), 'and it reports its state to a screen reader')
})

test('THE FOOTER BELONGS TO THE PAGE, NOT TO A CHANNEL', () => {
  /**
   * Reported 2026-08-02: the footer "is only present on #nope ... should be present on every page".
   *
   * It was written when the page was one long scroll, where "at the bottom" and "under the last
   * channel" were the same place. Once channels started hiding each other it became a footer only
   * #nope had, so the source link, the licence and the trademark disclaimer disappeared from four
   * channels out of five. It now sits in .msgs, outside every section, which is the only arrangement
   * a future channel cannot take it away from.
   */
  const sections = [...HTML.matchAll(/<section class="chan" id="([^"]+)"[\s\S]*?<\/section>/g)]
  assert.ok(sections.length >= 5, 'the channels are still sections')
  for (const [block, id] of sections) {
    assert.ok(!block.includes('<footer'), `#${id} does not own the footer`)
  }
  assert.equal((HTML.match(/<footer/g) || []).length, 1, 'exactly one footer on the page')
  assert.match(HTML, /Not affiliated with Discord/, 'and it still carries the trademark note')
})

test('THE MEDIA-ONLY TOGGLE EMITS A d. LINK ON EVERY HOST, and composes with the domain toggle', () => {
  /**
   * Requested 2026-08-02. The d. host answers with the post's bytes instead of a card; this exposes
   * that on the page. The two controls are INDEPENDENT (media-only is an on/off, the domain is a
   * one-of-several) and the failure that matters is one silently replacing the other rather than
   * composing with it.
   *
   * REWRITTEN 2026-10-11, when the guest hosts became domain buttons. This pinned the source text
   * `function sendHost() { return mediaOnly ? 'd.' + host : host; }` and counted conversions that
   * bypassed sendHost(). A guest host has no d. (you-stupid owns the zone, src/guesthost.ts), so media
   * only moved into mbedfxMediaOnly in the pure block, which spells it per host, and sendHost() went:
   * the d. stays on the official hosts and a guest host gets a `.mp4` on the path (the guest-host tests
   * below). The property is unchanged and is now checked by RUNNING the page's function rather than by
   * matching its spelling: on every host that has a d., the WHOLE host is prefixed, byte for byte what
   * sendHost() produced, so it composes with whichever domain is selected.
   *
   * REWRITTEN AGAIN 2026-10-11, the same day, on the owner's ask ("fix the d. precursor for the new
   * domains"): d.sorryifuckedyour.mom and d.hotsinglesnear.you became custom domains of you-stupid
   * (shamu4life/you-stupid#22), so every host has a d. now and the guest hosts joined the loop below.
   */
  assert.match(HTML, /id="mediaOnly"/, 'the control exists')
  for (const h of ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', ...GUEST_HOSTS, 'abc123-mbedfx.redevit.workers.dev']) {
    for (const p of ['/jack/status/20', '/watch?v=dQw4w9WgXcQ', '/jack/status/20/p', '/X/status/20.mp4', '/']) {
      assert.equal(mediaOnly(`https://${h}${p}`), `https://d.${h}${p}`,
        `${h}: the d. prefix goes on the whole host and the path is left exactly as it was`)
    }
  }
  // Every link that reaches the screen goes through it, or the copied link and the previewed link can
  // disagree. setResult is the one writer of the result row, and it applies media only.
  assert.match(HTML, /function sendLink\(base\) \{ return mediaOnly \? mbedfxMediaOnly\(base\) : base; \}/)
  assert.deepEqual(HTML.match(/result\.textContent = [^;]*;/g), ['result.textContent = sendLink(base);'],
    'no line writes the result row except setResult, so no link reaches the screen without media only')
  assert.equal((HTML.match(/sendHost\(\)/g) || []).length, 0, 'and no caller is left on the host-only spelling')
})

test('MEDIA-ONLY PREVIEWS THE FILE — no Discord card, but not nothing either', () => {
  /**
   * REWRITTEN 2026-08-03, after the owner reported the first version "doesn't preview anything which
   * is antithetical to the purpose of previewing on the site". They were right, and the reasoning
   * behind the mistake is worth keeping because half of it still holds.
   *
   * A d. link does NOT unfurl — Discord fetches the url and attaches the file — so drawing the mock
   * Discord card would be a lie, and that part stands. The wrong conclusion was that the honest
   * alternative is a sentence. The honest preview of "Discord attaches this file" is THE FILE, which
   * is also the thing someone opened the page to check.
   *
   * So: still no card chrome (no byline, no stats, no colour bar), but the media itself is shown.
   */
  assert.match(HTML, /function drawMediaOnly\(/, 'a distinct media-only drawing exists')
  assert.match(HTML, /Discord attaches this file\. No card, no caption\./,
    'and it says what will happen alongside the file')
  // The SAME card payload feeds it — that is where the media urls come from. Skipping the fetch is
  // exactly what left the page previewing nothing. REWRITTEN 2026-10-04: the condition gained
  // `|| (j && j.direct)`, because a pasted `.mp4` link asks for the file exactly as the box does (see
  // the test below), and the early `return` went, so the file drawing keeps polling a video still being
  // prepared the way the card does. The property pinned, fetch-then-draw rather than skip, is unchanged.
  assert.match(HTML, /if \(mediaOnly \|\| \(j && j\.direct\)\) drawMediaOnly\(url, j\);\s*else drawCard\(url, j\);/,
    'the card payload is fetched and re-drawn, not skipped')
  // And the poll that follows the drawing is shared by both, rather than skipped by an early return.
  const body = HTML.slice(HTML.indexOf('function card(url, isRetry, muxSince)'))
  const draw = body.indexOf('if (mediaOnly || (j && j.direct)) drawMediaOnly(url, j);')
  assert.ok(draw > 0 && body.indexOf('if (j && j.muxing) muxSince') < draw && body.indexOf('if (j && j.muxing) {', draw) > draw,
    'the mux bookkeeping runs before the drawing, and the re-poll after it, for the file drawing too')
  assert.match(HTML, /The video is still being prepared\. Pasted right now, it may show nothing\./,
    'and while it is being prepared the file drawing says so, instead of promising the file')
  // Second review round: past the six-minute watch cap the drawing fell back to promising the file with
  // nothing polling behind it, and a post with no media at all was captioned as an attached file.
  assert.match(HTML, /Still being prepared after six minutes\. This preview has stopped checking\./)
  // The file line asks the mux state first (a posterless video still being prepared has its entry
  // dropped, third review round), then media presence, because a post with none answers a direct url 404.
  const lineAt = HTML.indexOf('var line = (j && j.ok && j.muxSlow)')
  assert.ok(lineAt > 0, 'the mux state is asked first')
  assert.ok(HTML.indexOf("        : has\n", lineAt) > HTML.indexOf('(j && j.ok && j.muxing)', lineAt),
    'then media presence decides between the file and nothing to attach')
  // And ticking the box for the SAME post must not kill a mux poll already armed for it.
  const toggle = HTML.slice(HTML.indexOf("mediaOnlyBox.addEventListener('change'"))
  const same = toggle.indexOf('if (lastCard && lastCard.path === path) {')
  assert.ok(same > 0 && toggle.indexOf('cardSeq++;') > toggle.indexOf('return;', same),
    'the sequence is bumped only after the same-post redraw has returned')
  assert.ok(!/function mediaNote\(\)/.test(HTML), 'the text-only state is gone')
})

test('A PASTED .mp4 LINK PREVIEWS AS THE FILE, from the ROUTER\'s verdict echoed by /_card, not a copy of it', () => {
  /**
   * Since 2026-10-04 a trailing `.mp4` on a post url is the path spelling of the d. host (router.ts
   * DIRECT_SUFFIX), and the converter passes a pasted fxtwitter-style path through untouched. Drawing the
   * mock card for it would preview something nobody will see, the exact mistake the media-only drawing
   * above was written to stop.
   *
   * THE PAGE ASKS, IT DOES NOT DECIDE. A first version re-derived the rule in a page regex, and an
   * adversarial review measured it already disagreeing with route(): `/A61SaA1.mp4` (a chooser) and
   * `/fxtwitter.com/…/{id}.mp4` (notfound) would have previewed as "Nothing to attach" files. /_card now
   * echoes the router's own `direct` (pinned in api.test.mjs), and the page reads that.
   */
  assert.ok(!/function mbedfxSendsFile\(/.test(HTML), 'no second copy of the router\'s suffix rule in the page')
  // Both draw decisions read it: the first fetch, and the redraw-from-lastCard on a toggle.
  assert.match(HTML, /if \(mediaOnly \|\| \(lastCard\.j && lastCard\.j\.direct\)\) drawMediaOnly\(url, lastCard\.j\);/)
  // The pasted suffix survives conversion, and the stills toggle composes with it into a path the router
  // reads as both, so the echoed flag is there to read.
  const { convert } = loadConverter()
  const plain = convert('https://x.com/X/status/2102147636702634195.mp4', 'mbedfx.app')
  assert.equal(plain.path, '/X/status/2102147636702634195.mp4')
  assert.equal(routed(plain.path).direct, true)
  const stills = convert('https://x.com/X/status/2102147636702634195.mp4', 'mbedfx.app', 'stills')
  assert.equal(routed(stills.path).direct, true, stills.path)
  assert.equal(routed(stills.path).gallery, 'stills', stills.path)
})

test('A .mp4 BEFORE THE QUERY OF A QUERY-ID LINK SURVIVES CONVERSION, and the id with it', () => {
  /**
   * Found by the completeness review, round four. The query branches matched exact paths, so
   * `youtube.com/watch.mp4?v={id}` fell through to the generic branch, which drops the query: the page
   * offered the X/Instagram chooser for a YouTube link. The router reads `/watch.mp4?v=` and
   * `/photo/.mp4?fbid=` as the file, so the converter has to hand those spellings out intact.
   */
  const { convert } = loadConverter()
  for (const [input, want] of [
    ['https://www.youtube.com/watch.mp4?v=dQw4w9WgXcQ', '/watch.mp4?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch/.mp4?v=dQw4w9WgXcQ', '/watch.mp4?v=dQw4w9WgXcQ'],
    ['https://www.facebook.com/photo/.mp4?fbid=1092409469807430', '/photo/.mp4?fbid=1092409469807430'],
    ['https://www.facebook.com/photo.mp4?fbid=1092409469807430', '/photo/.mp4?fbid=1092409469807430'],
    ['https://www.facebook.com/groups/328668786145521/.mp4?multi_permalinks=1391536379858751', '/groups/328668786145521/posts/1391536379858751/.mp4'],
  ]) {
    const got = convert(input, 'mbedfx.app')
    assert.equal(got.path, want, input)
    const r = routed(got.path)
    assert.equal(r.kind, 'post', input)
    assert.equal(r.direct, true, `${input}: and the router reads it as the file`)
  }
  // Without the suffix nothing changes.
  assert.equal(convert('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'mbedfx.app').path, '/watch?v=dQw4w9WgXcQ')
  assert.equal(convert('https://www.facebook.com/photo/?fbid=1092409469807430', 'mbedfx.app').path, '/photo/?fbid=1092409469807430')
})

test('A WORKER-SUPPLIED URL IS RE-POINTED AT THE CHOSEN HOST', () => {
  /**
   * Reported as media-only "intermittently not working when changing links". /_prep answers with a
   * url the WORKER built from the request's origin — the host serving the page — so it knows nothing
   * about the domain toggle or media-only. When a share code unfurled, that answer overwrote a
   * correct link and the d. silently vanished.
   *
   * PRE-EXISTING AND WIDER than media-only: the same line discarded the domain toggle too, which went
   * unnoticed because losing a whole `d.` is visible where losing a swap between two domains is not.
   */
  /*
   * REWRITTEN 2026-10-11. This matched `x.hostname = sendHost()` inside onChosenHost. sendHost() is gone
   * (a guest host had no d. that day, see the media-only test above), and the re-pointing moved into the pure
   * block as mbedfxRepoint so it can be RUN here instead of matched: onChosenHost hands it the selected
   * host and returns the base link, and setResult adds media only, the same last step a fresh
   * conversion takes. What is pinned is unchanged: one place re-points, it uses the host the reader
   * chose, and the raw worker url never reaches the row.
   */
  assert.match(HTML, /function onChosenHost\(u\) \{ return mbedfxRepoint\(u, host, false\); \}/,
    'there is one place that re-points such a url, and it uses the host the reader actually chose')
  assert.match(HTML, /setResult\(known \? onChosenHost\(known\) : r\.url\);/, 'render goes through it')
  // REWRITTEN 2026-10-11: the condition gained `resolved &&` (mbedfxPrepResolved, see the false-caption
  // test below), so an answer that resolved nothing rewrites nothing. What is pinned here is unchanged:
  // the answer goes through onChosenHost, compared base with base.
  assert.match(HTML, /var unfurled = onChosenHost\(j\.url\);\s+if \(resolved && unfurled && unfurled !== url\) \{\s+setResult\(unfurled\);/,
    'and so does a /_prep answer, compared base with base so media only cannot read as a resolution')
  assert.ok(!/result\.textContent = j\.url;/.test(HTML),
    'the raw worker url is never written straight to the result row')
  // The behaviour on the official hosts, run: the d. survives a re-point exactly as it did.
  const w = 'https://mbedfx.app/@mysticaquarium/video/7660566211100511518'
  assert.equal(repoint(w, 'megapenispoopenfarten.sex', false), 'https://megapenispoopenfarten.sex/@mysticaquarium/video/7660566211100511518')
  assert.equal(repoint(w, 'megapenispoopenfarten.sex', true), 'https://d.megapenispoopenfarten.sex/@mysticaquarium/video/7660566211100511518')
  assert.equal(repoint(w, 'hotsinglesnear.you', true), 'https://d.hotsinglesnear.you/@mysticaquarium/video/7660566211100511518',
    'and on a guest host, which has its own d. since you-stupid#22')
  assert.equal(repoint('not a url', 'mbedfx.app', true), 'not a url', 'a url it cannot parse comes back as it was')
})

test('THE PAGE STILL CARRIES NO VISIBLE EM DASH AND NO SECOND PERSON', () => {
  /**
   * Both were owner requests, and both were re-broken by later work — the media-only note arrived
   * with an em dash, and so did the pitch line and the document title added with the channel router.
   * A rule that is only ever applied by hand gets re-broken by the next edit, so it is asserted.
   *
   * Comments are exempt: they are not visible copy, and the file's explanatory density is deliberate.
   *
   * A HOSTNAME LISTED IN OUR_HOSTS IS A PROPER NOUN WHEREVER IT APPEARS, and is removed before the
   * check. REWRITTEN 2026-10-11. The first exemption that day covered only the two `var OUR_HOSTS` /
   * `var PUBLIC_HOSTS` lines, because the guest host hotsinglesnear.you ends in the label `you`, and
   * it said that advertising that domain "would still have to get past this test". Advertising it
   * then became the owner's call, the same day: "I would like to see it so that the two new domains
   * show up as options for selection on the site unlike forsen.sex". A domain button is labelled with
   * its domain (the nickname test above), so the name now sits in visible markup and in GUEST_HOSTS,
   * and a line-based exemption either fails the owner's request or grows a line per place the name is
   * written. A domain name is the page naming a site, not the page talking to its reader, so the names
   * are stripped instead. They are read from the page's own OUR_HOSTS rather than typed here, so only
   * a name the page actually serves is excused, a domain added later needs no second edit, and every
   * other sentence, including whatever surrounds a hostname, is still checked.
   */
  const names = ourHosts
  assert.ok(names.length > 0 && names.every(h => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)),
    'only whole dotted hostnames are excused, never a bare word like "you"')
  let body = HTML.slice(HTML.indexOf('<body'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  for (const h of names) body = body.split(h).join('')
  assert.equal((body.match(/—/g) || []).length, 0, 'no em dash in anything a visitor reads')
  assert.equal((body.match(/\b(you|your)\b/gi) || []).length, 0, 'and nothing addresses the reader')
})

test('TOGGLING MEDIA-ONLY NEVER HIDES THE LINK, and never refetches', () => {
  /**
   * Reported 2026-08-03: toggling media-only "just absolutely destroys the copyable link and the
   * preview". Two causes, both mine.
   *
   * THE LINK VANISHED because the handler called hidePreview(), whose name says card and whose body
   * also runs outClass(false) — hiding the result row and the Copy button. That is correct where it is
   * otherwise used ("the input does not parse, there is nothing to show") and wrong on a toggle, where
   * the link is valid and has merely changed host. Every toggle blanked the output until the next card
   * landed, and left it blank for good if that fetch was slow or failed.
   *
   * THE PREVIEW RACED because the toggle refetched. Both drawings come from ONE /_card payload — only
   * the rendering differs — so a second request bought nothing and could land out of order behind the
   * first. The payload in hand is redrawn instead: instant, and impossible to race.
   *
   * Verified in a browser at six rapid toggles: the row stayed visible at every step, the kind
   * alternated correctly, and the toggles caused ZERO extra fetches.
   */
  // Comments are stripped before this check: the handler's own comment EXPLAINS that it used to call
  // hidePreview, and a naive text search matches that prose and fails on a correct file.
  const handler = HTML.slice(HTML.indexOf("mediaOnlyBox.addEventListener"))
    .slice(0, 2000)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/hidePreview\(\)/.test(handler),
    'the toggle must not CALL hidePreview — that hides the link, not just the card')
  assert.match(HTML, /var lastCard = null;/, 'the last payload is kept')
  assert.match(HTML, /lastCard = \{ path: path, j: j \};/, 'and recorded on every answer')
  assert.match(HTML, /if \(lastCard && lastCard\.path === path\) \{/,
    'so a toggle redraws from it rather than issuing a second request')
  assert.match(HTML, /cardSeq\+\+;/,
    'and bumps the sequence so an in-flight fetch cannot land on top of the redraw')
})


/* ============ FACEBOOK'S ID-IN-THE-QUERY SHAPES, WHICH THIS PAGE USED TO THROW AWAY ============
 *
 * mbedfxConvert builds its answer from `u.pathname` and keeps the query for exactly two platforms:
 * YouTube's `?v=` and Twitch's `?clip=`. Facebook carries the post id in the query in three of its
 * spellings, so the page converted them to a bare `/photo`, `/photo.php` or `/story.php` — paths the
 * worker reads as the ['x','ig'] chooser, offering a human two links that cannot resolve for a url
 * that is unmistakably Facebook's.
 *
 * That is the SAME defect for /story.php that was reported on 2026-08-01 and fixed in the ROUTER
 * then; the page kept its half of it. CLAUDE.md names the converter as a third seam that has to be
 * checked whenever a route is fixed, and this is exactly the case it warns about: the worker handled
 * these urls while the page in front of it did not.
 *
 * These assert the CONVERTED PATH ROUTES, not merely that conversion succeeded — a page that emits a
 * tidy url the worker cannot read is the failure being prevented.
 */
test('THE PHOTO QUERY SPELLINGS CONVERT TO A PATH THE WORKER CLAIMS, not to the chooser', () => {
  const { convert } = loadConverter()
  for (const u of [
    'https://www.facebook.com/photo/?fbid=1596906755391068',
    'https://www.facebook.com/photo.php?fbid=1596906755391068&set=a.774304400984645&type=3',
  ]) {
    const r = convert(u, 'mbedfx.app')
    assert.ok(r.ok, `${u} must convert`)
    assert.match(r.url, /\/photo\/\?fbid=1596906755391068$/, 'the fbid survives into the converted url')
    const routed = route(new URL(r.url))
    assert.equal(routed.kind, 'post', `${r.url} must route to a post, not the chooser`)
    assert.equal(routed.ref.p, 'fb')
  }
})

test('story.php CONVERTS TO THE PERMALINK SHAPE, closing the page half of the 2026-08-01 report', () => {
  const { convert } = loadConverter()
  const r = convert('https://www.facebook.com/story.php?story_fbid=1596906778724399&id=100052152768666', 'mbedfx.app')
  assert.ok(r.ok, 'it must convert')
  const routed = route(new URL(r.url))
  assert.equal(routed.kind, 'post', 'and the converted url must name a post')
  assert.equal(routed.ref.p, 'fb')
})

test('A QUERY WITHOUT A USABLE ID IS STILL REFUSED, so the branch cannot invent a post', () => {
  // The guard is the id's SHAPE, not the presence of the parameter. Without this, `?fbid=abc` would
  // build /photo/?fbid=abc and hand the worker a ref that can never resolve.
  const { convert } = loadConverter()
  for (const u of [
    'https://www.facebook.com/photo/?fbid=abc',
    'https://www.facebook.com/photo/?fbid=12',
    'https://www.facebook.com/photo/',
  ]) {
    const r = convert(u, 'mbedfx.app')
    const routed = r.ok ? route(new URL(r.url)) : null
    assert.ok(!routed || routed.kind !== 'post' || routed.ref.p !== 'fb',
      `${u} must not become a Facebook photo post`)
  }
})

test('A SITE PICKED FROM "Read as" ROUTES EXACTLY AS THE LINK IT WAS PICKED FOR, on Facebook\'s query links and Meta\'s share links', () => {
  /**
   * FOUND 2026-11-26. The picker forces a reading by putting the site's code in front of the path it
   * already converted, and the router had no /fb/ twin for Facebook's query-id shapes and no /th/ twin
   * for the bare /share/{code}. So picking Facebook on a photo or watch paste, or Threads on a
   * threads.com/share/ paste, replaced a working link with one that answered "Not found". The router
   * half is pinned in test/router.test.mjs; this is the page half, run on the page's own output.
   *
   * The picker's string is read off the page first, so the reconstruction below cannot drift from what
   * the page actually builds. A Meta share link is forced both ways, because the code does not say
   * which site minted it and either pick has to keep working. story.php and permalink.php are in the
   * list though the converter rewrites them to /{owner}/posts/{id}/ first, so a converter that stopped
   * doing that would be caught here as well.
   *
   * Scoped to the two sites the defect was about. The same check over every paste in this file also
   * failed for /yt/watch?v=…, for /tw/embed?clip=… (read as a Twitch clip whose slug is "embed") and
   * for links that already carry their code (/dm/{id} forced to /dm/dm/{id}). Those were fixed the
   * same day, and the next test runs that check over every paste.
   *
   * REWRITTEN 2026-11-26 with that fix. This used to pin the picker's own string, '/' + code + r.path,
   * and rebuild it here. That string was the third defect, so the page now builds the forced path in
   * the pure block (mbedfxForcedPath), the handler is pinned to call it, and the check runs on what it
   * returns. None of these pastes carries a token of the converter's own, so the paths checked are the
   * same ones as before.
   */
  const picker = HTML.slice(HTML.indexOf("picker.addEventListener('click'"), HTML.indexOf('var forced = null;'))
  assert.match(picker, /var path = mbedfxForcedPath\(r, code, pathOf\(input\.value\)\);/, 'the forced path comes from the pure block')
  assert.match(picker, /setResult\(mbedfxScheme\(host\) \+ host \+ path\);/, 'and is handed out whole')

  const KINDS = ['post', 'metashare']
  let checked = 0
  for (const [paste, codes] of [
    ['https://www.facebook.com/photo/?fbid=1596906755391068', ['fb']],
    ['https://www.facebook.com/photo.php?fbid=1596906755391068&set=a.774304400984645&type=3', ['fb']],
    ['https://www.facebook.com/photo/.mp4?fbid=1092409469807430', ['fb']],
    ['https://www.facebook.com/watch/?v=10153231379946729', ['fb']],
    ['https://www.facebook.com/watch?v=10153231379946729', ['fb']],
    ['https://www.facebook.com/story.php?story_fbid=1596906778724399&id=100052152768666', ['fb']],
    ['https://www.facebook.com/permalink.php?story_fbid=1596906778724399&id=100052152768666', ['fb']],
    ['https://www.facebook.com/share/Fixture08X/', ['fb', 'th']],
    ['https://www.threads.com/share/Fixture08X', ['th', 'fb']],
    ['https://www.threads.net/share/_Fixture1X', ['th', 'fb']],
  ]) {
    for (const gallery of [undefined, 'stills', 'videos']) {
      const r = convert(paste, 'mbedfx.app', gallery)
      assert.ok(r.ok, `${paste} must convert`)
      assert.equal(r.code, codes[0], `${paste}: the chip names the site the link came from`)
      const plain = routed(r.path)
      assert.ok(KINDS.includes(plain.kind), `${r.path} names a post to begin with (got ${plain.kind})`)
      for (const code of codes) {
        const forced = forcedPath(r, code, null)
        assert.equal(forced, '/' + code + r.path, `${paste}: no token of the converter's own to replace`)
        assert.deepEqual(routed(forced), plain, `${paste}, read as ${code}: ${forced} must route exactly as ${r.path}`)
        checked++
      }
    }
  }
  assert.equal(checked, 39, 'every paste, every gallery mode, every code')
})

test('EVERY SITE IN "Read as", ON EVERY PASTE IN THIS FILE: the chip\'s own site routes as the link it converted, and no token is stacked', () => {
  /**
   * FOUND 2026-11-26 by running the check above over every paste in this file rather than the Facebook
   * ones. Three more defects, fixed the same day:
   *
   *   youtube.com/watch?v={id}, read as YouTube   /yt/watch?v={id}       notfound: the router had no /yt/
   *                                                                     twin for the query shape
   *   twitch.tv/embed?clip={slug}, read as Twitch /tw/embed?clip={slug}  a clip whose slug is "embed", the
   *                                                                     wrong post with no error
   *   dai.ly/{id}, streamable.com/{id}, imgur.com/{id}, imgur.com/gallery/{id}, clips.twitch.tv/{slug},
   *     read as the site the chip shows           /dm/dm/{id} and so on   notfound: the picker stacked a
   *                                                                     second token on the converter's own
   *
   * THE PASTES ARE READ OUT OF THIS FILE'S SOURCE, every quoted http(s) url in it, rather than listed
   * again here, so a paste added to any test above is checked here without a second edit. A hand-kept
   * list is how test/refkey.test.mjs stopped covering new ref kinds (CLAUDE.md).
   *
   * WHAT IS ASSERTED:
   *  - Every paste that shows a chip and names a post (or one of the share routes that resolve to one):
   *    picking the chip's own site routes deepEqual to the link it converted, in all three gallery
   *    modes. The chip's site is r.code, or for the fediverse guess, which has none, the platform the
   *    router read.
   *  - Every site in the picker, on every paste that converted: the converter's own token is never left
   *    behind the picked one. It is replaced, so picking the shown site gives back the converted path
   *    byte for byte, and another site's pick reads the same id under its own token.
   *  - A refusal forces the pasted path as it was, and a pasted mbedfx link shows no chip and carries no
   *    token. Both are the reasons mbedfxForcedPath leaves a first segment alone when it did not write it.
   *
   * NOT ASSERTED: that a DIFFERENT site's pick reaches the same post. No picker can promise that: forcing
   * Streamable on a YouTube watch link asks for Streamable's reading of /watch, and there is no YouTube
   * post in that answer to keep.
   */
  // What makes a pasted mbedfx link chipless: render() draws the chip only for a detected platform.
  assert.match(HTML, /var chip = r\.platform \? chipFor\(r\.code, r\.platform\) : '';/, 'no platform, no chip')

  const src = readFileSync(new URL(import.meta.url), 'utf8')
  const pastes = [...new Set([...src.matchAll(/['"`](https?:\/\/[^'"`\s$]+)['"`]/g)].map(m => m[1]))]
  assert.ok(pastes.length > 150, `the scan finds this file's pastes (found ${pastes.length})`)

  // The picker's list is CODE_OF's values, read off the page the way the site table is.
  const CODE_OF = new Function(`return ${HTML.match(/var CODE_OF = (\{[\s\S]*?\});/)[1]}`)()
  const PICKER = Object.values(CODE_OF)
  assert.deepEqual([...PICKER].sort(), Object.values(CODE).sort(), 'every site the page names, once')

  const NAMES_A_POST = ['post', 'metashare', 'shortlink', 'redditshare', 'profile']
  const pathOf = v => { try { const p = new URL(v).pathname; return p && p !== '/' ? p : null } catch { return null } }
  let same = 0, picks = 0, tokened = 0, refused = 0, chipless = 0
  for (const paste of pastes) {
    for (const gallery of [undefined, 'stills', 'videos']) {
      const r = convert(paste, 'mbedfx.app', gallery)
      if (!r.ok) {
        const raw = pathOf(paste)
        if (!raw) continue
        for (const code of PICKER) assert.equal(forcedPath(r, code, raw), '/' + code + raw, `${paste}: a refusal forces its own path`)
        refused++
        continue
      }
      if (!r.platform) {
        assert.equal(r.token, null, `${paste}: a pasted mbedfx link carries no token of the converter's own`)
        chipless++
        continue
      }
      if (r.token) {
        assert.equal(r.token, r.code, `${paste}: the token the converter wrote is the chip's own site`)
        assert.ok(r.path.startsWith(`/${r.token}/`), `${paste}: and it is at the front of ${r.path}`)
        tokened++
      }
      const rest = r.token ? r.path.slice(r.token.length + 1) : r.path
      for (const code of PICKER) {
        const forced = forcedPath(r, code, pathOf(paste))
        assert.ok(forced.startsWith(`/${code}/`), `${paste}, read as ${code}: ${forced} leads with the picked token`)
        if (r.token) assert.notEqual(forced.split('/')[2], r.token, `${paste}, read as ${code}: ${forced} stacks a token`)
        assert.equal(forced.slice(code.length + 1), rest, `${paste}, read as ${code}: the rest is the converted path`)
        if (code === r.token) assert.equal(forced, r.path, `${paste}: re-picking the shown site gives back ${r.path}`)
        picks++
      }
      const plain = routed(r.path)
      if (!NAMES_A_POST.includes(plain.kind)) continue
      const site = r.code || plain.ref?.p
      assert.ok(site, `${paste}: the chip names a site`)
      const forced = forcedPath(r, site, pathOf(paste))
      assert.deepEqual(routed(forced), plain, `${paste} [${gallery}], read as ${site}: ${forced} must route exactly as ${r.path}`)
      same++
    }
  }
  // Floors, not exact counts, because the paste list grows with this file. Measured 2026-11-26 over 172
  // pastes in three gallery modes: 261 same-site checks, 21 conversions carrying a token of the converter's
  // own (seven pastes), 5,202 picks, 36 refusals and 156 pasted mbedfx links.
  assert.ok(same >= 261, `same-site checks (${same})`)
  assert.ok(tokened >= 21, `conversions carrying the converter's own token (${tokened})`)
  assert.ok(refused > 0 && chipless > 0, `refusals (${refused}) and pasted mbedfx links (${chipless}) were both seen`)
  assert.ok(picks >= 5202, `picks (${picks})`)

  // The three defects by name, so a failure says which one came back.
  const yt = convert('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'mbedfx.app')
  assert.deepEqual(routed(forcedPath(yt, 'yt', null)).ref, { p: 'yt', id: 'dQw4w9WgXcQ' }, '/yt/watch?v= plays')
  const tw = convert('https://clips.twitch.tv/embed?clip=DeliciousDelightfulPicklesWOOP', 'mbedfx.app')
  assert.equal(routed(forcedPath(tw, 'tw', null)).ref.slug, 'DeliciousDelightfulPicklesWOOP', '/tw/embed?clip= is that clip')
  const dm = convert('https://dai.ly/xaqwy7q', 'mbedfx.app')
  assert.equal(forcedPath(dm, 'dm', null), '/dm/xaqwy7q', 'Dailymotion re-picked is the same link')
  assert.equal(forcedPath(dm, 'st', null), '/st/xaqwy7q', 'and Streamable reads the id under its own token')
  const gal = convert('https://imgur.com/gallery/YcAQlkx', 'mbedfx.app', 'stills')
  assert.equal(forcedPath(gal, 'im', null), '/im/gallery/YcAQlkx/p', 'an Imgur gallery re-picked keeps its mode')

  // A HANDLE THAT SPELLS A TOKEN IS NOT ONE. @tw is an X account name; its tweet converts to /tw/status/20,
  // and forcing X must keep the handle, which only works because the strip is keyed on r.token.
  const handle = convert('https://x.com/tw/status/20', 'mbedfx.app')
  assert.equal(handle.token, null, 'the converter did not write that tw')
  assert.equal(forcedPath(handle, 'x', null), '/x/tw/status/20')
  assert.deepEqual(routed(forcedPath(handle, 'x', null)), routed(handle.path), 'read as X, the same post by @tw')

  // The player with no clip is refused now, and forcing Twitch on it never reads "embed" as a slug.
  const player = convert('https://clips.twitch.tv/embed', 'mbedfx.app')
  assert.equal(player.ok, false, 'clips.twitch.tv/embed names no clip')
  assert.ok(!/—|\byou\b/i.test(player.why), 'visible copy, held to the page rules')
  assert.notEqual(routed(forcedPath(player, 'tw', '/embed')).ref?.slug, 'embed')
  // On twitch.tv a single segment is a channel, and "embed" is a legal login, so that paste keeps the
  // channel refusal it had before the player refusal existed.
  assert.equal(convert('https://www.twitch.tv/embed', 'mbedfx.app').why,
    'That looks like a Twitch channel rather than a clip. Clips only.')
})


/* ============ THE GUEST HOSTS AS DOMAIN BUTTONS (owner's call, 2026-10-11) ============
 *
 * "with mbedfx I would like to see it so that the two new domains show up as options for selection on
 * the site unlike forsen.sex". sorryifuckedyour.mom and hotsinglesnear.you are custom domains of the
 * owner's you-stupid Worker, which hands this one its embed paths over a service binding
 * (src/guesthost.ts). Two things made a guest host different from the official three, and each has a
 * test below, because each is a way for the page to hand out a link that does not do what it says:
 *
 *   - there was no d.<guest>, so for a day media only was the `.mp4` path spelling there. Since
 *     2026-10-11 (shamu4life/you-stupid#22) both have a d., and the tests that pinned the `.mp4` now pin
 *     that media only is the d. host there too, the path untouched;
 *   - only embed routes are answered (guestServes), and every other path opens the other site's page.
 *
 * Every link is checked the way this file checks everything: the PAGE's own output, fed through the
 * REAL router and the REAL guestServes, asserting on what comes back (kind, ref, direct, gallery).
 */

/** Every link KIND the converter emits: REAL_PASTES, the share and short links, the query-id links,
 *  and the pasted `.mp4` spellings it passes through. */
const GUEST_PASTES = [
  ...REAL_PASTES.map(([paste]) => paste),
  'https://www.tiktok.com/t/ZTSw2mYwR',
  'https://www.threads.com/share/Fixture08X',
  'https://www.facebook.com/share/v/Fixture03X',
  'https://www.reddit.com/r/BatmanArkham/s/uucSZtDEbI',
  'https://www.facebook.com/photo/?fbid=1596906755391068',
  'https://www.facebook.com/photo.php?fbid=1596906755391068&set=a.774304400984645&type=3',
  'https://www.facebook.com/story.php?story_fbid=1596906778724399&id=100052152768666',
  'https://www.facebook.com/permalink.php?story_fbid=1596906778724399&id=100052152768666',
  'https://www.facebook.com/story.php?story_fbid=pfbid02AbCdEfGhIjKlMnOpQrStUv&id=100052152768666',
  'https://www.facebook.com/watch/?v=10153231379946729',
  'https://www.facebook.com/groups/328668786145521/?multi_permalinks=1391536379858751',
  'https://www.twitch.tv/embed?clip=DeliciousDelightfulPicklesWOOP&parent=example.com',
  'https://imgur.com/a/abc12',
  'https://imgur.com/gallery/abc12',
  'https://x.com/X/status/2102147636702634195.mp4',
  'https://www.youtube.com/watch.mp4?v=dQw4w9WgXcQ',
  'https://www.facebook.com/photo/.mp4?fbid=1092409469807430',
  'https://www.instagram.com/p/DaQ5CPTki4E/.mp4',
  'https://www.instagram.com/p/DaQ5CPTki4E/v.mp4',
  'https://hotsinglesnear.you/jack/status/20/p',
  'https://sorryifuckedyour.mom/jack/status/20.mp4',
]

/** A route with the two suffix flags taken off, so "the same post" can be compared across spellings. */
const bare = r => { const { direct, gallery, ...rest } = r; return rest }
const NAMES_A_POST = ['post', 'shortlink', 'redditshare', 'metashare']

test('THE GUEST HOSTS ARE OFFERED AS BUTTONS LABELLED WITH THEIR DOMAINS, AND forsen.sex STILL IS NOT', () => {
  /**
   * The owner's request, pinned both ways round. Each guest host is in PUBLIC_HOSTS and has a button
   * labelled with the domain it emits (the nickname rule above); forsen.sex keeps the 2026-09-11
   * position, recognised and never offered. The page's GUEST_HOSTS must be the Worker's list exactly:
   * the page cannot import it (no build step), and a host in one list but not the other would get a d.
   * link that resolves nowhere, or lose its d. for nothing. Since 2026-11-25 the Worker's list is the
   * GUEST_HOSTS var, so this compares the page with the value wrangler.production.jsonc sets.
   */
  assert.ok(GUEST_HOSTS.length > 0, 'production sets GUEST_HOSTS, or this comparison is against nothing')
  assert.deepEqual([...pageGuests].sort(), [...GUEST_HOSTS].sort(), 'the page and the Worker agree on which hosts are guests')
  for (const g of GUEST_HOSTS) {
    assert.ok(publicHosts.includes(g), `${g} is offered`)
    const esc = g.replace(/\./g, '\\.')
    assert.match(HTML, new RegExp(`data-host="${esc}"[^>]*>\\s*${esc}\\s*<`), `the ${g} button is labelled ${g}`)
    assert.equal(defaultHost(g).family, g, 'a visitor on it would see its own button pressed, now that one exists')
    assert.equal(isGuest(g), true)
    assert.equal(convert('https://x.com/jack/status/20', g).url, `https://${g}/jack/status/20`)
  }
  assert.ok(!publicHosts.includes('forsen.sex'), 'forsen.sex is still not offered')
  assert.ok(!/data-host="forsen\.sex"/.test(HTML), 'and has no button')
  assert.ok(ourHosts.includes('forsen.sex'), 'though it is still recognised as ours')
  for (const h of ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex']) assert.equal(isGuest(h), false)
})

test('MEDIA ONLY ON A GUEST HOST IS ITS d. HOST, and every toggle combination is the file of the same post', () => {
  /**
   * REWRITTEN 2026-10-11, the day it was written. It pinned a `.mp4` on the path, NEVER d., because there
   * was no d.<guest>: sendHost() had put `d.` on whatever host was selected, and you-stupid owned those
   * zones with no record or route for one, so the media-only box handed out a link that resolved nowhere.
   * The owner then asked for the d. itself ("fix the d. precursor for the new domains"), and you-stupid
   * claims d.sorryifuckedyour.mom and d.hotsinglesnear.you since shamu4life/you-stupid#22. So media only
   * on a guest domain is the d. host, as on the official ones.
   *
   * The sweep is kept, because what it guards is unchanged: every link kind the converter emits, with
   * "all as stills" off and on, on both guest hosts. The plain link must be one the guest host serves.
   * The media-only link must be that guest host's d., with the path and query exactly as they were, so
   * the router (host-blind) reads the identical route: the same post, kind and gallery mode, and the
   * guest host still serves it. The `direct` itself is read off the hostname by the worker (worker.ts
   * DIRECT_MEDIA_HOST); that a d. on a guest host answers with the file through the binding, marked, is
   * pinned in test/guesthost.test.mjs.
   */
  let checked = 0
  for (const host of GUEST_HOSTS) {
    for (const paste of GUEST_PASTES) {
      for (const gallery of [undefined, 'stills']) {
        const r = convert(paste, host, gallery)
        assert.ok(r.ok, `${paste} must convert`)
        const plain = route(new URL(r.url))
        assert.ok(guestServes(plain), `${r.url} must be served on ${host} (got ${plain.kind})`)
        assert.ok(NAMES_A_POST.includes(plain.kind), `${r.url} names a post (got ${plain.kind})`)

        const file = mediaOnly(r.url)
        const u = new URL(file)
        const p = new URL(r.url)
        assert.equal(u.hostname, `d.${host}`, `${file}: media only is the guest host's d.`)
        assert.equal(u.pathname + u.search, p.pathname + p.search, `${file}: the path and query are untouched`)
        const got = route(u)
        assert.ok(guestServes(got), `${file} must be served on ${host} (got ${got.kind})`)
        assert.deepEqual(got, plain, `${file} reads exactly as ${r.url}: the same post, kind and mode`)
        // A TikTok short link takes no mode (see the short-link test below), so it is the one kind the
        // stills box leaves alone; everything else must still be asking for stills.
        if (gallery === 'stills' && plain.kind !== 'shortlink') assert.equal(got.gallery, 'stills', `${file} still asks for stills`)
        checked++
      }
    }
  }
  assert.ok(checked >= 4 * REAL_PASTES.length, `the sweep must stay wide to mean anything (was ${checked})`)

  // The shapes, spelled out once so a reader can see them: the d. on the host, and nothing else moves.
  const on = (paste, gallery) => mediaOnly(convert(paste, 'hotsinglesnear.you', gallery).url)
  assert.equal(on('https://x.com/jack/status/20'), 'https://d.hotsinglesnear.you/jack/status/20')
  assert.equal(on('https://x.com/jack/status/20', 'stills'), 'https://d.hotsinglesnear.you/jack/status/20/p')
  assert.equal(on('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://d.hotsinglesnear.you/watch?v=dQw4w9WgXcQ')
  assert.equal(on('https://www.instagram.com/p/DbN6SsKum-9/'), 'https://d.hotsinglesnear.you/p/DbN6SsKum-9')
  assert.equal(on('https://www.tiktok.com/t/ZTSw2mYwR'), 'https://d.hotsinglesnear.you/t/ZTSw2mYwR')
})

test('ON A GUEST HOST MEDIA ONLY NO LONGER TOUCHES THE PATH: a pasted .mp4, a ) and a /_media/ link keep theirs', () => {
  /**
   * REWRITTEN 2026-10-11 with the one above. This pinned the two placements the `.mp4` spelling got wrong
   * by default: a second `.mp4` on a pasted fxtwitter-style link (`20.mp4.mp4` is a failure id, the router
   * peels ONE), and a `.mp4` glued after a `)` (read as Discord's masked-link over-capture and dropped with
   * it, router.ts OVERCAPTURE). The d. host never touches the path, so neither can happen; what is pinned
   * now is exactly that, on the same links.
   */
  for (const [paste, gallery] of [
    ['https://x.com/X/status/2102147636702634195.mp4', undefined],
    ['https://x.com/X/status/2102147636702634195.mp4', 'stills'],
    ['https://www.instagram.com/p/DaQ5CPTki4E/.mp4', undefined],
    ['https://www.instagram.com/p/DaQ5CPTki4E/v.mp4', 'stills'],
    ['https://www.youtube.com/watch.mp4?v=dQw4w9WgXcQ', undefined],
    ['https://x.com/jack/status/20)', undefined],
    ['https://x.com/jack/status/20)', 'stills'],
  ]) {
    const base = convert(paste, 'sorryifuckedyour.mom', gallery).url
    const file = mediaOnly(base)
    assert.equal(file, base.replace('https://sorryifuckedyour.mom/', 'https://d.sorryifuckedyour.mom/'), `${paste}: only the host gains the d.`)
    const got = route(new URL(file))
    assert.equal(got.kind, 'post', `${file} names the post`)
    assert.deepEqual(got, route(new URL(base)), `${file} reads exactly as ${base}`)
    assert.equal(got.gallery, gallery, `${file} carries the mode it was given, and no other`)
  }
  // A /_media/ link pasted back in already IS a file; on the d. host it is still the media route.
  const media = mediaOnly(convert('https://mbedfx.app/_media/x%3A20/0.mp4', 'hotsinglesnear.you').url)
  assert.equal(media, 'https://d.hotsinglesnear.you/_media/x%3A20/0.mp4')
  assert.equal(route(new URL(media)).kind, 'media')
  assert.ok(guestServes(route(new URL(media))))
  // And the bare root is the d. host's root, which a guest host declines like its bare one (you-stupid's page).
  assert.equal(mediaOnly('https://hotsinglesnear.you/'), 'https://d.hotsinglesnear.you/')
})

test('A /_prep ANSWER IS RE-POINTED EXACTLY AS A FRESH CONVERSION IS, on every host, with media only on or off', () => {
  /**
   * /_prep answers with a url built on the request's origin (the official host serving the page), and
   * onChosenHost re-points it. That used to set `hostname = sendHost()`, which on a guest host produced
   * d.<guest> while that name had no DNS, and which could never have added the `.mp4` the guest spelling
   * needed that day. Now the answer is re-pointed to the BASE link and media only is added by the same
   * last step a fresh conversion takes. So for a worker url naming exactly what the converter would have
   * emitted, the two must be identical, character for character, on every host either control can
   * select. REWRITTEN 2026-10-11 for the guest hosts' d. (shamu4life/you-stupid#22): the guest branch
   * below asserted no d. and a `.mp4` file; it now asserts the d., as on every other host.
   */
  const pairs = [
    ['https://x.com/jack/status/20', 'https://mbedfx.app/jack/status/20'],
    ['https://www.tiktok.com/@mysticaquarium/video/7660566211100511518', 'https://mbedfx.app/@mysticaquarium/video/7660566211100511518'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://megapenispoopenfarten.sex/watch?v=dQw4w9WgXcQ'],
    ['https://www.facebook.com/photo/?fbid=1596906755391068', 'https://mbedfx.app/photo/?fbid=1596906755391068'],
    ['https://x.com/X/status/2102147636702634195.mp4', 'https://mbedfx.app/X/status/2102147636702634195.mp4'],
  ]
  const sendLink = (base, on) => (on ? mediaOnly(base) : base)
  for (const host of [...publicHosts, 'forsen.sex']) {
    for (const on of [false, true]) {
      for (const [paste, workerUrl] of pairs) {
        const fresh = sendLink(convert(paste, host).url, on)
        assert.equal(sendLink(repoint(workerUrl, host, false), on), fresh, `${host} ${on ? '+media only' : ''}: ${workerUrl}`)
        assert.equal(repoint(workerUrl, host, on), fresh, 'and mbedfxRepoint with media only says the same')
        if (on) assert.ok(fresh.startsWith(`https://d.${host}/`), `${fresh}: the d. survives a re-point on ${host}`)
      }
    }
  }
  // A resolved share code: the permalink /_prep hands back gets the guest host's d. too, and is served.
  const resolved = repoint('https://mbedfx.app/@mysticaquarium/video/7660566211100511518', 'hotsinglesnear.you', true)
  assert.equal(resolved, 'https://d.hotsinglesnear.you/@mysticaquarium/video/7660566211100511518')
  assert.ok(guestServes(route(new URL(resolved))))
})

test('THE PAGE ASKS THE WORKER ABOUT THE LINK WITHOUT MEDIA ONLY, so no media-only spelling can split one post into two', () => {
  /**
   * THE DEFECT THIS PREVENTS. /_prep, /_card, resolvedTo and lastCard were all keyed on the SHOWN link's
   * path, which was safe while media only meant `d.`, because d. is in the host and never touched the
   * path. A guest host's `.mp4` is in the path. Keyed that way, ticking the box made the same post look
   * like a new one: a /_card refetch on every toggle (the toggle promises a redraw from the payload in
   * hand, pinned above), and a resolved share code falling back to the code itself until /_prep was
   * asked again, the per-share-act token resolvedTo exists to keep off the screen.
   *
   * So `sentBase` holds the link on the chosen host WITHOUT media only, everything the page asks or
   * files goes by it, and setResult is the one place media only is added.
   *
   * KEPT WHEN THE GUEST HOSTS GOT THEIR d. (2026-10-11, shamu4life/you-stupid#22), which put media only
   * back in the host everywhere. The key is still the base, so a path spelling added later cannot bring
   * this back; the closing assertions changed from "the shown path differs" to "the host does".
   */
  assert.match(HTML, /function setResult\(base\) \{ sentBase = base; result\.textContent = sendLink\(base\); \}/)
  assert.match(HTML, /cardTimer = setTimeout\(function \(\) \{ card\(sentBase \|\| r\.url\); \}, 900\);/,
    'the card is asked about the base link')
  const handler = HTML.slice(HTML.indexOf("mediaOnlyBox.addEventListener('change'"))
  assert.match(handler.slice(0, 4000), /var url = sentBase \|\| '';/, 'the toggle compares the held card with the base link')
  const picker = HTML.slice(HTML.indexOf("picker.addEventListener('click'"), HTML.indexOf('var forced = null;'))
  assert.match(picker, /prep\(sentBase\);/, 'a forced reading is prepped by its base link')
  assert.match(picker, /card\(sentBase\);/, 'and previewed by it')
  assert.ok(!/prep\(result\.textContent\)|card\(result\.textContent/.test(HTML), 'nothing asks about the shown link')
  // And the base a guest host's media only is keyed on is the plain post's link; media only moves the host.
  const base = convert('https://x.com/jack/status/20', 'hotsinglesnear.you').url
  assert.equal(new URL(base).pathname, '/jack/status/20')
  assert.equal(new URL(mediaOnly(base)).pathname, '/jack/status/20', 'the d. host leaves the path alone')
  assert.equal(new URL(mediaOnly(base)).hostname, 'd.hotsinglesnear.you', 'so the shown link differs in the host, not the path')
})

test('ALL AS STILLS LEAVES A TIKTOK SHORT LINK ALONE, because the router reads no mode on one', () => {
  /**
   * Found 2026-10-11 by the sweep above. withGallery put `/p` on every path, and the router refuses a
   * mode on a TikTok short link on purpose (peelSuffixes: otherwise `/t/{code}/p` would start meaning
   * the short link). So with the box ticked before pasting, a share link came out `notfound` on EVERY
   * host, mbedfx.app included, and on a guest host it opened the other site's page.
   */
  assert.notEqual(routed('/t/ZTSw2mYwR/p').kind, 'shortlink', 'the router does not read /t/{code}/p as the short link')
  for (const host of ['mbedfx.app', ...GUEST_HOSTS]) {
    const r = convert('https://www.tiktok.com/t/ZTSw2mYwR', host, 'stills')
    assert.equal(r.path, '/t/ZTSw2mYwR', `${host}: no mode on the short link`)
    assert.equal(route(new URL(r.url)).kind, 'shortlink', 'so it still resolves')
  }
  // Only the short link. A post path still takes the mode, and so do the other share codes.
  assert.equal(convert('https://www.reddit.com/r/BatmanArkham/s/uucSZtDEbI', 'mbedfx.app', 'stills').path, '/r/BatmanArkham/s/uucSZtDEbI/p')
  assert.equal(convert('https://x.com/t/status/20', 'mbedfx.app', 'stills').path, '/t/status/20/p')
})

test('ALL AS STILLS LEAVES A BLUESKY PROFILE ALONE TOO, and media only leaves it the profile card on a guest host', () => {
  /**
   * Found by review 2026-10-11, the short-link defect above one shape over. withGallery put `/p` on
   * `/profile/{handle}`, and the router reads no mode on a profile (it has no gallery), so "all as
   * stills" ticked before pasting a Bluesky profile handed out `notfound` on every host, mbedfx.app
   * included, and on a guest host a link that opens the other site's page. Pinned here because the
   * GUEST_PASTES sweep asserts NAMES_A_POST and so cannot hold a profile.
   *
   * Media only was the same failure on a guest host while it was a `.mp4` on the path:
   * `/profile/bsky.app.mp4` is `notfound`, so the link was left as it was. REWRITTEN 2026-10-11 when the
   * guest hosts got their d. (shamu4life/you-stupid#22): media only is now the d. host there too, and the
   * d. host answers a profile with the same card on every domain (worker.ts, the profile case: "a d.
   * profile link renders the same card"), so the profile survives it with its path untouched.
   */
  assert.notEqual(routed('/profile/bsky.app/p').kind, 'profile', 'the router does not read /profile/{handle}/p as the profile')
  assert.notEqual(routed('/profile/bsky.app.mp4').kind, 'profile', 'nor /profile/{handle}.mp4')
  for (const host of ['mbedfx.app', ...GUEST_HOSTS]) {
    for (const paste of ['https://bsky.app/profile/bsky.app', 'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur',
      'https://mbedfx.app/bs/profile/bsky.app']) {
      const r = convert(paste, host, 'stills')
      assert.ok(r.ok, `${paste} converts`)
      assert.ok(!/\/p$/.test(r.path), `${host}: no mode on the profile (${r.path})`)
      const got = route(new URL(r.url))
      assert.equal(got.kind, 'profile', `${r.url} is still the profile`)
      assert.ok(guestServes(got), `${r.url} is answered on a guest host`)
      const file = mediaOnly(r.url)
      assert.equal(file, r.url.replace(`https://${host}/`, `https://d.${host}/`), `${host}: media only is the d. host, the path untouched`)
      assert.equal(route(new URL(file)).kind, 'profile', `${file} is still the profile with media only on`)
    }
  }
})

test('A LINK A GUEST HOST TURNS AWAY IS NAMED AS SUCH, from /_card\'s verdict rather than a copy of the rule', () => {
  /**
   * THE DECISION, 2026-10-11. The converter can emit paths a guest host declines: a profile pasted from
   * x.com, TikTok or Instagram is a bare `/{handle}`, which the router answers with a chooser; a page
   * like `/jack/likes` names nothing; our own front page is `site`. On mbedfx.app those draw the
   * chooser or a "Not found" card. On a guest host they never reach mbedfx: you-stupid serves its own
   * dating page, and that is what Discord unfurls.
   *
   * Those links are KEPT, not rewritten to another host or hidden. The reader picked the domain, the
   * other site answering is exactly what that domain does with a path that is not an embed, and
   * mbedfx.app has no better answer for the same path (a chooser, or "Not found"). What the page must
   * not do is call it a link to a post. Before /_card answers, an ambiguous path is already swapped for
   * the site picker by /_prep; after, the preview says "doesn't resolve to a post", and on a guest host
   * now adds where it lands instead.
   *
   * The page does not decide which paths those are: /_card echoes guestServes (`guestDeclines`, pinned
   * in test/guesthost.test.mjs), the way it echoes the router's `direct`.
   */
  for (const paste of ['https://x.com/jack', 'https://www.tiktok.com/@someone', 'https://www.instagram.com/someone/',
    'https://x.com/jack/likes', 'https://mbedfx.app/']) {
    const r = convert(paste, 'hotsinglesnear.you')
    assert.ok(r.ok, `${paste} still converts`)
    assert.equal(guestServes(route(new URL(r.url))), false, `${r.url} is a path a guest host declines`)
  }
  // And a Bluesky profile is NOT one of them: guestServes answers profiles.
  assert.equal(guestServes(route(new URL(convert('https://bsky.app/profile/bsky.app', 'hotsinglesnear.you').url))), true)

  assert.match(HTML, /function guestLine\(j\) \{\s*return j && j\.guestDeclines && mbedfxIsGuest\(host\)/,
    'the line is driven by the worker\'s verdict, and only on a guest host')
  assert.match(HTML, /"No preview\. This link doesn't resolve to a post\." \+ guestLine\(j\)/, 'the card drawing says it')
  assert.match(HTML, /guestLine\(j\) \? "Nothing to attach\. This link doesn't resolve to a post\." \+ guestLine\(j\)/,
    'and so does the media-only drawing, instead of "has no media" about a link that names no post')
  assert.match(HTML, /' On ' \+ host \+ " it opens that site's own page instead\."/, 'in words that say where it lands')
  // Switching domain redraws that one drawing from the payload in hand, so the line follows the button.
  const seg = HTML.slice(HTML.indexOf("var segs = document.querySelectorAll('.seg button');"))
  assert.match(seg.slice(0, 3000), /lastCard\.j\.guestDeclines/, 'the domain toggle redraws a declined answer')
})

/* ============ LINKS WHOSE ID IS IN THE QUERY, AND LINKS PASTED BACK (review, 2026-10-11) ============
 *
 * The converter keeps a query parameter only where the router reads a post id from it. Each test below
 * is a place it used to drop one, or to misread our own link, and each is checked on every host either
 * control can select, through the real router and the real guestServes: on mbedfx.app the dropped id
 * gave the ['x','ig'] chooser, and on a guest host a link that opens the other site's page.
 */

/** Every host the domain buttons can select, plus forsen.sex, which is recognised and not offered. */
const EVERY_HOST = [...publicHosts, 'forsen.sex']

test('A FACEBOOK WATCH LINK KEEPS ITS ?v=, on every host and with every toggle', () => {
  /**
   * facebook.com/watch/?v={id} converted to a bare /watch, on HEAD and before it: the Facebook branch
   * kept only ?fbid= and ?story_fbid=, and the YouTube branch, the only one that kept ?v=, does not see
   * a Facebook link. The router has read /watch?v={numeric} as the Facebook video all along, so the id
   * was the only thing missing. With media only on a guest host it came out /watch.mp4, also the chooser,
   * while the guest spelling was a `.mp4`; since 2026-10-11 it is the d. host on every domain.
   */
  for (const paste of ['https://www.facebook.com/watch/?v=10153231379946729', 'https://www.facebook.com/watch?v=10153231379946729&ref=sharing']) {
    for (const host of EVERY_HOST) {
      for (const gallery of [undefined, 'stills']) {
        for (const on of [false, true]) {
          const r = convert(paste, host, gallery)
          assert.ok(r.ok, `${paste} converts`)
          assert.equal(r.platform, 'Facebook')
          const link = on ? mediaOnly(r.url) : r.url
          const got = route(new URL(link))
          assert.equal(got.kind, 'post', `${link} names a post (got ${got.kind})`)
          assert.deepEqual(got.ref, { p: 'fb', kind: 'watch', id: '10153231379946729' }, `${link} is the Facebook video`)
          assert.ok(guestServes(got), `${link} is answered on a guest host`)
          assert.equal(got.gallery, gallery, `${link} carries the mode it was given`)
          if (on) assert.equal(new URL(link).hostname, `d.${host}`, `${link} is the file, on the d. host`)
        }
      }
    }
  }
  assert.equal(convert('https://www.facebook.com/watch?v=10153231379946729&ref=sharing', 'mbedfx.app').path,
    '/watch?v=10153231379946729', 'and only the id is kept')
})

test('permalink.php AND A pfbid story.php CONVERT TO THE PERMALINK SHAPE, like a numeric story.php', () => {
  /**
   * route() reads /permalink.php as the other spelling of /story.php, and takes a pfbid post id and a
   * vanity owner (FB_POST_ID, FB_OWNER). The converter matched /story.php only, with numeric ids only,
   * so the rest fell through to a bare /story.php or /permalink.php: the chooser.
   */
  for (const [paste, id] of [
    ['https://www.facebook.com/permalink.php?story_fbid=1596906778724399&id=100052152768666', '100052152768666_1596906778724399'],
    ['https://www.facebook.com/story.php?story_fbid=pfbid02AbCdEfGhIjKlMnOpQrStUv&id=100052152768666', '100052152768666_pfbid02AbCdEfGhIjKlMnOpQrStUv'],
    ['https://www.facebook.com/story.php?story_fbid=pfbid02AbCdEfGhIjKlMnOpQrStUv&id=some.page', 'some.page_pfbid02AbCdEfGhIjKlMnOpQrStUv'],
  ]) {
    for (const host of EVERY_HOST) {
      const r = convert(paste, host)
      const got = route(new URL(r.url))
      assert.equal(got.kind, 'post', `${paste} -> ${r.url} names a post (got ${got.kind})`)
      assert.deepEqual(got.ref, route(new URL(paste.replace('www.facebook.com', 'mbedfx.app'))).ref,
        `${r.url} is the post the router reads off the original link`)
      assert.equal(got.ref.id, id)
      assert.ok(guestServes(got))
    }
  }
})

test('A GROUP LINK WITH ?multi_permalinks= CONVERTS TO THE posts/ PATH, on every host and forced', () => {
  /**
   * Found 2026-11-26 checking FixTweetBot's FIXERS.md table against production. The converter kept
   * only ?v=, ?fbid= and ?story_fbid= with ?id= on a Facebook link, so this came out the bare
   * /groups/{gid}: the group home, which the worker leaves unclaimed, so "Not found". It now emits the
   * path spelling, which the router reads as the same post, and which the forced "Read as Facebook"
   * link can carry because on 2026-11-26 the worker's /fb/ prefix read paths only.
   */
  const want = route(new URL('https://mbedfx.app/groups/328668786145521/posts/1391536379858751/'))
  for (const paste of [
    'https://www.facebook.com/groups/328668786145521/?multi_permalinks=1391536379858751&hoisted_section_header_type=recently_seen',
    'https://m.facebook.com/groups/328668786145521?multi_permalinks=1391536379858751',
  ]) {
    for (const host of EVERY_HOST) {
      const r = convert(paste, host)
      assert.ok(r.ok, `${paste} converts`)
      assert.equal(r.platform, 'Facebook')
      assert.equal(r.path, '/groups/328668786145521/posts/1391536379858751/', 'only the two ids are kept')
      const got = route(new URL(r.url))
      assert.deepEqual(got, want, `${r.url} is the group post`)
      assert.ok(guestServes(got), `${r.url} is answered on a guest host`)
      // The picker's forced link is `/` + code + this path (public/index.html, the data-force handler).
      assert.deepEqual(route(new URL(`https://${host}/fb${r.path}`)), want, `/fb${r.path} is the same post`)
    }
  }
  // No usable id: the converter keeps today's answer, the bare home, rather than building a post.
  for (const paste of [
    'https://www.facebook.com/groups/328668786145521/',
    'https://www.facebook.com/groups/328668786145521/?multi_permalinks=abc',
    'https://www.facebook.com/groups/328668786145521/?multi_permalinks=1391536379858751,1391536379858752',
  ]) {
    assert.equal(convert(paste, 'mbedfx.app').path, '/groups/328668786145521', paste)
  }
  // A named group is not a shape the router reads, so it is not rewritten into one.
  assert.equal(convert('https://www.facebook.com/groups/somegroup/?multi_permalinks=1391536379858751', 'mbedfx.app').path,
    '/groups/somegroup')
  // A link with only its host swapped by hand keeps the id, and the tracking still drops.
  assert.equal(convert('https://mbedfx.app/groups/328668786145521/?multi_permalinks=1391536379858751&hoisted_section_header_type=recently_seen', 'hotsinglesnear.you').url,
    'https://hotsinglesnear.you/groups/328668786145521?multi_permalinks=1391536379858751')
  assert.deepEqual(route(new URL('https://hotsinglesnear.you/groups/328668786145521?multi_permalinks=1391536379858751')), want)
  // And a list is dropped there too, because route() does not read one.
  assert.equal(convert('https://mbedfx.app/groups/328668786145521/?multi_permalinks=1391536379858751,1391536379858752', 'mbedfx.app').url,
    'https://mbedfx.app/groups/328668786145521')
})

test("THE CONVERTER'S OWN QUERY-ID LINKS, PASTED BACK, NAME THE SAME POST on every host", () => {
  /**
   * The already-ours branch kept only ?v=, so re-pasting the page's own /photo/?fbid=… or
   * /embed?clip=… link gave /photo or /embed, the chooser. It now keeps the parameters route() reads
   * an id from (v, fbid, clip, story_fbid with id as a pair, and a numeric multi_permalinks since
   * 2026-11-26) and drops the rest.
   */
  const QUERY_ID = [
    'https://www.facebook.com/photo/?fbid=1596906755391068',
    'https://www.facebook.com/photo.php?fbid=1596906755391068&set=a.774304400984645&type=3',
    'https://www.facebook.com/watch/?v=10153231379946729',
    'https://www.facebook.com/permalink.php?story_fbid=1596906778724399&id=100052152768666',
    'https://www.facebook.com/groups/328668786145521/?multi_permalinks=1391536379858751',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.twitch.tv/embed?clip=DeliciousDelightfulPicklesWOOP&parent=example.com',
    'https://www.youtube.com/watch.mp4?v=dQw4w9WgXcQ',
  ]
  for (const paste of QUERY_ID) {
    for (const from of EVERY_HOST) {
      for (const gallery of [undefined, 'stills']) {
        const first = convert(paste, from, gallery)
        const a = route(new URL(first.url))
        assert.equal(a.kind, 'post', `${first.url} names a post`)
        for (const to of EVERY_HOST) {
          const again = convert(first.url, to, gallery)
          assert.equal(new URL(again.url).hostname, to)
          const b = route(new URL(again.url))
          assert.equal(b.kind, 'post', `${first.url} pasted back on ${to} -> ${again.url} (got ${b.kind})`)
          assert.deepEqual(bare(b), bare(a), `${again.url} names the same post as ${first.url}`)
          assert.equal(b.gallery, a.gallery, `${again.url} keeps the mode`)
          assert.equal(b.direct, a.direct, `${again.url} keeps the file spelling it was pasted with`)
          assert.ok(guestServes(b), `${again.url} is answered on a guest host`)
        }
      }
    }
  }
  // A Facebook link with only its host swapped: the id survives, the tracking does not.
  assert.equal(convert('https://mbedfx.app/permalink.php?story_fbid=1596906778724399&id=100052152768666&ref=embed_post', 'hotsinglesnear.you').url,
    'https://hotsinglesnear.you/permalink.php?story_fbid=1596906778724399&id=100052152768666')
  assert.equal(convert('https://mbedfx.app/photo/?fbid=1596906755391068&set=a.1&utm_source=x', 'mbedfx.app').url,
    'https://mbedfx.app/photo?fbid=1596906755391068')
  // Half of the story pair names nothing, so it is not carried as if it did.
  assert.equal(convert('https://mbedfx.app/story.php?story_fbid=1596906778724399', 'mbedfx.app').url, 'https://mbedfx.app/story.php')
})

test('A d. LINK PASTED BACK IS OURS, re-pointed at the selected domain rather than read as a fediverse server', () => {
  /**
   * mbedfxIsOurs('d.mbedfx.app') is false (OUR_HOSTS holds bare names), so the page's own media-only
   * link, pasted back, was treated as an unknown instance: /d.mbedfx.app/jack/status/20, `notfound` on
   * every host. One d. in front of an OUR_HOSTS name is now ours, and the media-only box decides the
   * spelling, as it does for a pasted /p or /v.
   */
  for (const ours of ourHosts) {
    for (const host of EVERY_HOST) {
      for (const gallery of [undefined, 'stills']) {
        const r = convert(`https://d.${ours}/jack/status/20`, host, gallery)
        assert.ok(r.ok)
        assert.match(r.note, /^Already an mbedfx link\./, `d.${ours} is recognised as ours`)
        assert.equal(r.url.split('/')[2], host, `re-pointed at ${host}`)
        for (const link of [r.url, mediaOnly(r.url)]) {
          const got = route(new URL(link))
          assert.equal(got.kind, 'post', `${link} names the post (got ${got.kind})`)
          assert.deepEqual(got.ref, { p: 'x', id: '20' })
          assert.equal(got.gallery, gallery)
          assert.ok(guestServes(got), `${link} is answered on a guest host`)
        }
      }
    }
  }
  // Exactly one label: anything deeper is still not a name this worker answers on.
  assert.equal(convert('https://d.d.mbedfx.app/jack/status/20', 'mbedfx.app').platform, 'Fediverse')
})

test('AN ANSWER THAT RESOLVED NOTHING IS NOT FILED, so a domain click cannot caption it "Share link resolved"', () => {
  /**
   * Found by review 2026-10-11, older than the guest hosts; the two new buttons only made it easy to hit.
   * prep filed EVERY successful /_prep answer in resolvedTo, and render() captions any filed entry "Share
   * link resolved to the real post". The worker echoes a link that was already right (pinned in
   * test/prep.test.mjs, "/_prep LEAVES A LINK ALONE WHEN IT ALREADY NAMES THE SAME POST"), so after an
   * ordinary post's answer, clicking any domain button put that line over a link nothing had resolved.
   *
   * The page half is a DOM closure this file cannot run, so the decision lives in the pure block
   * (mbedfxPrepResolved) and is run here; the closure's use of it is pinned by its text.
   */
  // The page: the one write to resolvedTo is gated on it, and render's caption reads resolvedTo alone.
  assert.match(HTML, /var resolved = mbedfxPrepResolved\(url, j\.url\);\s+if \(resolved\) resolvedTo\[path\] = j\.url;/)
  assert.equal((HTML.match(/resolvedTo\[[^\]]+\] = /g) || []).length, 1, 'nothing else files an answer')
  assert.match(HTML, /var known = resolvedTo\[r\.url\.slice\(r\.url\.indexOf\('\/', 8\)\)\];/)
  // REWRITTEN 2026-11-25: a middle arm now reads pinUnresolved, which only a pin.it path that /_prep
  // could not resolve is filed in (pinned in its own test). For every other link it is empty, so the
  // line still falls through to "Ready to paste." exactly as this pinned before.
  assert.match(HTML, /note\.innerHTML = known\s+\? chip \+ '\. Share link resolved to the real post\.'\s+: pinUnresolved\[r\.path\] \? chip \+ '\. ' \+ esc\(PIN_IT_REFUSAL\)\s+: chip \+ \(r\.note \? ' ' \+ esc\(r\.note\) : \(r\.platform \? '\. Ready to paste\.' : ''\)\);/,
    'so with nothing filed the line reads "Ready to paste."')

  // The flow, with the page's own functions. A plain post is pasted on mbedfx.app and /_prep echoes
  // the path it was asked about, on the request's origin, as the worker does for an already-right link.
  for (const [paste, gallery] of [['https://x.com/jack/status/20', undefined], ['https://x.com/jack/status/20', 'stills'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', undefined], ['https://youtu.be/dQw4w9WgXcQ', undefined]]) {
    const resolvedTo = Object.create(null)
    const asked = convert(paste, 'mbedfx.app', gallery).url
    const path = asked.slice(asked.indexOf('/', 8))
    const answer = 'https://mbedfx.app' + path
    if (prepResolved(asked, answer)) resolvedTo[path] = answer
    // Then each domain button: render() looks the new link up the way the page does.
    for (const host of EVERY_HOST) {
      const r = convert(paste, host, gallery)
      assert.equal(resolvedTo[r.url.slice(r.url.indexOf('/', 8))], undefined,
        `${paste} on ${host}: nothing was resolved, so the line still reads "Ready to paste."`)
      // The same echo landing after the click (the race): asked on the old host, compared on no host.
      assert.equal(prepResolved(asked, r.url), false, `an echo is not a resolution whichever host it is re-pointed to (${host})`)
    }
  }
  // A real resolution still is one: a share code answered with its permalink, and a different query id.
  assert.equal(prepResolved('https://hotsinglesnear.you/t/ZTSw2mYwR', 'https://mbedfx.app/@mysticaquarium/video/7660566211100511518'), true)
  assert.equal(prepResolved('https://mbedfx.app/share/v/Fixture03X', 'https://mbedfx.app/reel/2209468366484962'), true)
  assert.equal(prepResolved('https://mbedfx.app/watch?v=dQw4w9WgXcQ', 'https://mbedfx.app/watch?v=jNQXAC9IVRw'), true)
  // Both sides are normalised by URL, so one spelling percent-encoded and one not is the same path.
  assert.equal(prepResolved('https://mbedfx.app/a%20b', 'https://mbedfx.app/a b'), false)
  assert.equal(prepResolved('not a url', 'https://mbedfx.app/x'), false, 'and an answer it cannot read resolves nothing')
})
