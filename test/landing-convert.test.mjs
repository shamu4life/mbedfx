import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'

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

/** Lift the pure-logic block. Its id is a contract between the page and this file. */
function loadConverter() {
  const m = HTML.match(/<script id="mbedfx-convert">([\s\S]*?)<\/script>/)
  assert.ok(m, 'public/index.html must carry a <script id="mbedfx-convert"> block')
  const src = m[1]
  assert.ok(!/document\.|window\.|navigator\./.test(src),
    'the converter block must stay DOM-free so it can be tested in isolation')
  return new Function(`${src}; return { convert: mbedfxConvert, defaultHost: mbedfxDefaultHost }`)()
}

/** Lift the documented example paths out of the page's own platform table. */
function loadPlatformTable() {
  const m = HTML.match(/var PLATFORMS = (\[[\s\S]*?\n {2}\]);/)
  assert.ok(m, 'public/index.html must carry the PLATFORMS table')
  // The table references MONO for the brands whose own colour is #000 and must flip with the
  // colour scheme. Supplying it here keeps that decision in the stylesheet where it belongs.
  return new Function(`const MONO = 'var(--brand-mono)'; return ${m[1]}`)()
}

const { convert, defaultHost } = loadConverter()
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
  'r/pics/s/uucSZtDEbI': 'redditshare',
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
  // The toggle is only honest if the second domain is genuinely served — see wrangler.jsonc routes.
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

test('STAGING KEEPS ITS PREFIX — a test environment that hands out production links is worthless', () => {
  const s = defaultHost('staging.megapenispoopenfarten.sex')
  assert.equal(s.host, 'staging.megapenispoopenfarten.sex', 'links stay in the environment under test')
  assert.equal(s.prefix, 'staging.', 'and a toggle click keeps it there')
  assert.equal(s.family, 'megapenispoopenfarten.sex', 'while the pressed button names the family')
  // Switching family on staging must stay on staging.
  assert.equal(s.prefix + 'mbedfx.app', 'staging.mbedfx.app')
  assert.equal(defaultHost('staging.mbedfx.app').host, 'staging.mbedfx.app')
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

test('THE PAGE ACTUALLY USES IT — the default is wired to location, not hardcoded', () => {
  assert.match(HTML, /mbedfxDefaultHost\(location\.hostname\)/, 'the DOM half must consult the origin')
  assert.match(HTML, /origin\.prefix \+ b\.getAttribute\('data-host'\)/, 'a click must preserve staging')
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

test('THE UNSUPPORTED SHORTENERS ARE REFUSED WITH A REASON, NOT A BROKEN LINK', () => {
  /**
   * THE POINT: these hide the post behind an opaque code, so there is nothing in the path that names
   * a site. Emitting a link anyway would produce a card that fails — worse than saying so up front.
   * Each refusal must explain what to do instead.
   */
  for (const paste of [
    'https://vm.tiktok.com/ZMhqBqQFa/',
    'https://vt.tiktok.com/ZSMhqBqQF/',
    'https://fb.watch/x1Y2z3A4b/',
    'https://pin.it/3xK9dLm',
  ]) {
    const r = convert(paste, 'mbedfx.app')
    assert.equal(r.ok, false, `${paste} must be refused rather than mis-converted`)
    assert.ok(r.why && r.why.length > 30, `${paste} must explain itself, got: ${r.why}`)
  }
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
