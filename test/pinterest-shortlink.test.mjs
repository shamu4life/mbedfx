import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, liveResolvePinShortlink } from '../src/worker.ts'
import { route } from '../src/router.ts'
import { guestServes } from '../src/guesthost.ts'
import { PIN_SHORT_CODE } from '../src/refkey.ts'
import { pinIdFromShortLocation } from '../src/platforms/pinterest/normalize.ts'
import { resolvePinShortlink } from '../src/platforms/pinterest/fetch.ts'

/**
 * PINTEREST'S SHORT LINK, pin.it/{code}, END TO END: the pure reading of the shortener's answer, the
 * one-hop resolver, the `/pin.it/{code}` route, and every surface that answers it.
 *
 * WHY IT EXISTS. Reported 2026-11-25: Pinterest's share button hands out pin.it/{code}, which lands on
 * pinterest.com/pin/{id}/sent/?invite_code=…&sender=…&sfo=1. `sender` is the sharer's Pinterest user id.
 * The converter refused pin.it outright, and swapping the host by hand gave a bare /{code}, the
 * ['x','ig'] chooser. Now the code is resolved, and only the pin id survives.
 *
 * WHAT WAS MEASURED, 2026-11-25, from the development host and not from a Worker: pin.it 308s every
 * code to api.pinterest.com/url_shortener/{code}/redirect/, which 302s a pin's code to the url above,
 * a board's code to a regional board url, and an unknown or mis-cased code to the bare homepage. The
 * fixtures below are shaped on those answers. Every code, pin id, invite code and sender id here is
 * INVENTED: the reported link names a real person's account.
 *
 * NEVER TOUCHES THE NETWORK. fetch is replaced for the whole file and throws on anything a test did
 * not answer. EVERY TEST HAS ITS OWN CODE AND PIN ID, because the post path parks in-flight loads in
 * module-level maps keyed on the ref, and a shared id would let one test's answer leak into another's.
 */

const offline = async url => { throw new Error(`unexpected network call in an offline test: ${url}`) }
globalThis.fetch = offline

const SENDER = '777000000000000123'
const INVITE = 'feedfacecafe0000feedfacecafe0001'
/** What the shortener's Location carries for a pin, per the 2026-11-25 measurement. */
const sentUrl = (id, host = 'www.pinterest.com') =>
  `https://${host}/pin/${id}/sent/?invite_code=${INVITE}&sender=${SENDER}&sfo=1`

/** Strings that must never reach anything we answer with: the per-share tokens and the share url. */
const leaks = code => [SENDER, INVITE, 'sender', 'invite_code', 'sfo=', code, 'pin.it/']

const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const HUMAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const req = (p, { ua = DISCORD_UA, host = 'mbedfx.app' } = {}) => new Request(`https://${host}${p}`, { headers: { 'user-agent': ua } })
const prepReq = p => new Request('https://mbedfx.app/_prep?p=' + encodeURIComponent(p))
const cardReq = p => new Request('https://mbedfx.app/_card?p=' + encodeURIComponent(p))
const apiReq = u => new Request('https://mbedfx.app/_api/v1?url=' + encodeURIComponent(u))

const ctx = () => {
  const pending = []
  return { ctx: { waitUntil(p) { pending.push(p) } }, settle: () => Promise.allSettled(pending) }
}
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const fakeR2 = () => {
  const store = new Map()
  return {
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length, uploaded: new Date() } : null },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new Uint8Array(await new Response(body).arrayBuffer())) },
  }
}
const env = () => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: fakeR2(),
  TRANSLATE_GOOGLE: 'off',
})

/**
 * A fetchPost that ECHOES THE REF into the content, so a card can only be right if the id the code
 * resolved to is the id that was fetched. `asked` records every ref, so a test can also prove that no
 * other pin was fetched.
 */
const pinFetcher = () => {
  const asked = []
  const fetchPost = async ref => {
    asked.push(ref)
    if (ref.p !== 'pn') return null
    return {
      ref,
      canonical: `https://www.pinterest.com/pin/${ref.id}/`,
      author: { name: `pinner of ${ref.id}`, handle: 'fixturepinner', url: 'https://www.pinterest.com/fixturepinner/' },
      title: `pin number ${ref.id}`,
      text: `the pin behind ${ref.id}`,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      counts: { likes: 4 },
      sensitive: false,
      media: [{ kind: 'image', url: `https://i.pinimg.com/originals/fixture/${ref.id}.jpg`, w: 600, h: 900 }],
    }
  }
  return { asked, fetchPost }
}

/** Deps with a pin.it resolver that answers `id` (or null, or throws) and records what it was asked. */
const depsWith = (resolve, over = {}) => {
  const pins = pinFetcher()
  const seen = []
  return {
    asked: pins.asked,
    seen,
    deps: {
      cache: fakeCache(),
      fetchPost: pins.fetchPost,
      resolveShortlink: async () => { throw new Error('the TikTok resolver must never run for a pin.it code') },
      resolveRedditShare: async () => null,
      resolveMetaShare: async () => null,
      resolvePinShortlink: async code => { seen.push(code); return typeof resolve === 'function' ? resolve(code) : resolve },
      ...over,
    },
  }
}

/** Replace fetch for one test with a shortener that answers `answer(url, init)`. */
async function withShortener(answer, body) {
  const asks = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (!u.startsWith('https://api.pinterest.com/url_shortener/')) return offline(u)
    asks.push({ url: u, init })
    return answer(u, init)
  }
  try {
    return await body(asks)
  } finally {
    globalThis.fetch = offline
  }
}
const redirectTo = loc => new Response('Redirecting', { status: 302, headers: { location: loc, 'content-type': 'text/html' } })

/* ===================== THE PURE HALF: what counts as an answer ===================== */

test('THE SHORTENER\'S ANSWER YIELDS THE PIN ID AND NOTHING ELSE, its query and /sent/ dropped', () => {
  // The measured shape of a pin's resolution, and the bare and slug spellings the router also reads.
  assert.equal(pinIdFromShortLocation(sentUrl('8800000000000000101')), '8800000000000000101')
  assert.equal(pinIdFromShortLocation('https://www.pinterest.com/pin/8800000000000000102/'), '8800000000000000102')
  assert.equal(pinIdFromShortLocation('https://www.pinterest.com/pin/8800000000000000103'), '8800000000000000103')
  assert.equal(pinIdFromShortLocation('https://www.pinterest.com/pin/a-made-up-slug--8800000000000000104/'), '8800000000000000104',
    'the slug is decoration (router.ts PIN_SLUG_ID), so it is not a reason to refuse')
  const got = pinIdFromShortLocation(sentUrl('8800000000000000105'))
  for (const junk of leaks('unused')) assert.ok(!String(got).includes(junk), `${junk} must not survive`)
})

test('A REGIONAL PINTEREST HOST IS ACCEPTED, because the shortener emits them', () => {
  /**
   * Measured 2026-11-25: a board's code resolved to www.pinterest.ru, so the host follows the sharer's
   * region. Only the id is kept, and the canonical is rebuilt on www.pinterest.com, so accepting the
   * region costs nothing.
   */
  for (const host of ['www.pinterest.ru', 'pinterest.de', 'www.pinterest.co.uk', 'www.pinterest.com.au', 'de.pinterest.com', 'pinterest.com']) {
    assert.equal(pinIdFromShortLocation(sentUrl('8800000000000000111', host)), '8800000000000000111', host)
  }
})

test('A LOCATION THAT NAMES NO PIN IS REFUSED, so a dead code can never become some pin', () => {
  /**
   * Each of these is "could not resolve", never a guess. The first three are what the shortener was
   * measured sending: the homepage for an unknown or mis-cased code, and a board. The rest are the
   * shapes a loosened check would let through.
   */
  for (const loc of [
    'https://www.pinterest.com',                                          // an unknown code, measured
    'https://www.pinterest.com/',
    `https://www.pinterest.ru/fixtureuser/fixtureboard/?invite_code=${INVITE}&sender=${SENDER}`, // a board, measured
    'https://evil.example/pin/8800000000000000121/',                       // another host: route() would take it
    'https://pinterest.com.evil.example/pin/8800000000000000122/',        // a lookalike, suffix
    'https://notpinterest.com/pin/8800000000000000123/',                  // a lookalike, prefix
    'https://api.pinterest.com/pin/8800000000000000124/',                 // not a pin page host
    'http://www.pinterest.com/pin/8800000000000000125/',                  // not https
    'https://www.pinterest.com:8443/pin/8800000000000000126/',            // a port
    'https://user@www.pinterest.com/pin/8800000000000000127/',            // credentials
    'https://www.pinterest.com/pin/not-a-number/',                        // non-numeric id
    'https://www.pinterest.com/pin/0880000000000000128/',                 // a zero-led id (a second spelling)
    'https://www.pinterest.com/pin/1234/',                                // too short to be a pin id
    'https://www.pinterest.com/pin/',                                     // no id at all
    'https://www.pinterest.com/fixtureuser/pin/8800000000000000129/',     // pin not first
    '/pin/8800000000000000130/',                                          // relative: no host to check
    '', null, undefined, 'not a url',
  ]) {
    assert.equal(pinIdFromShortLocation(loc), null, String(loc))
  }
})

test('ON A BOARD LINK, NO NUMBER IN THE QUERY IS EVER READ AS A PIN — the sender id least of all', () => {
  // The simplification pinIdFromShortLocation's comment warns about: "the long number in the Location".
  // On a board link the only long digit runs are in invite_code and sender, the sharer's own id.
  const board = `https://www.pinterest.ru/fixtureuser/fixtureboard/?invite_code=${INVITE}&sender=${SENDER}`
  assert.equal(pinIdFromShortLocation(board), null)
  assert.equal(pinIdFromShortLocation(`https://www.pinterest.com/?sender=${SENDER}`), null)
})

/* ===================== THE I/O HALF: one hop, through askTwice ===================== */

test('THE RESOLVER ASKS THE SHORTENER ONCE, DIRECTLY, WITHOUT FOLLOWING, and keeps only the id', async () => {
  await withShortener(() => redirectTo(sentUrl('8800000000000000201')), async asks => {
    const got = await resolvePinShortlink('Fx7Qa2Lp9')
    assert.deepEqual(got, { ok: true, id: '8800000000000000201' })
    assert.equal(asks.length, 1, 'one hop: pin.it itself is skipped, it only 308s to this url')
    assert.equal(asks[0].url, 'https://api.pinterest.com/url_shortener/Fx7Qa2Lp9/redirect/',
      'the code is sent exactly as given, case and all: codes are case-sensitive')
    assert.equal(asks[0].init.redirect, 'manual', 'the Location is the answer; following it would fetch the pin page as the sharer')
    assert.ok(asks[0].init.headers['user-agent'], 'a user-agent, as PinResource has needed one since 2026-10')
  })
})

test('A REDIRECT TO THE HOMEPAGE, A BOARD OR ANOTHER HOST IS not_a_pin', async () => {
  for (const [code, loc] of [
    ['Hm1Pg2Xx3', 'https://www.pinterest.com'],
    ['Bd1Rd2Xx3', `https://www.pinterest.ru/fixtureuser/fixtureboard/?invite_code=${INVITE}&sender=${SENDER}`],
    ['Ev1Lh2Xx3', 'https://evil.example/pin/8800000000000000211/'],
    ['Nn1Um2Xx3', 'https://www.pinterest.com/pin/not-a-number/sent/'],
  ]) {
    await withShortener(() => redirectTo(loc), async () => {
      assert.deepEqual(await resolvePinShortlink(code), { ok: false, reason: 'not_a_pin' }, loc)
    })
  }
})

test('A 200 DECOY, A 404 OR A 403 IS assert_fail, even when the body names a pin', async () => {
  /**
   * The body is never read, so a page that happens to carry a /pin/{id} url (a login wall, an app shell)
   * cannot become an answer. Only a redirect's Location is.
   */
  for (const [code, status] of [['Dc2Oy0Xx1', 200], ['Nf4Oh4Xx1', 404], ['Bk4Ox3Xx1', 403]]) {
    await withShortener(() => new Response(`<a href="${sentUrl('8800000000000000221')}">pin</a>`, {
      status, headers: { 'content-type': 'text/html', location: sentUrl('8800000000000000222') },
    }), async asks => {
      assert.deepEqual(await resolvePinShortlink(code), { ok: false, reason: 'assert_fail' }, `HTTP ${status}`)
      assert.equal(asks.length, 1, `HTTP ${status} is an answer about the code, not asked twice`)
    })
  }
})

test('A REFUSED FIRST ASK IS ASKED ONCE MORE, through askTwice, and a thrown fetch twice is assert_fail', async () => {
  let n = 0
  await withShortener(() => (++n === 1 ? new Response('busy', { status: 429 }) : redirectTo(sentUrl('8800000000000000231'))), async asks => {
    assert.deepEqual(await resolvePinShortlink('Rt1Ry2Xx3'), { ok: true, id: '8800000000000000231' })
    assert.equal(asks.length, 2)
  })
  await withShortener(() => { throw new TypeError('connection reset') }, async asks => {
    assert.deepEqual(await resolvePinShortlink('Th1Rw2Xx3'), { ok: false, reason: 'assert_fail' })
    assert.equal(asks.length, 2, 'two attempts, then the honest miss')
  })
})

test('A CODE OUTSIDE PIN_SHORT_CODE IS REFUSED BEFORE ANY REQUEST', async () => {
  await withShortener(() => { throw new Error('must not be asked') }, async asks => {
    for (const bad of ['short', 'has/slash', 'dot.ted1', 'per%2Fcent', 'thirteenchars', '', 'sp ace12']) {
      assert.deepEqual(await resolvePinShortlink(bad), { ok: false, reason: 'assert_fail' }, bad)
    }
    assert.equal(asks.length, 0)
  })
})

test('THE LIVE DEP COUNTS assert_fail AND NOT not_a_pin', async () => {
  const points = []
  const e = { AE: { writeDataPoint(p) { points.push(p) } } }
  await withShortener(() => redirectTo('https://www.pinterest.com'), async () => {
    assert.equal(await liveResolvePinShortlink('Cn1Ta2Xx3', e, 'discord'), null)
  })
  assert.ok(!points.some(p => JSON.stringify(p).includes('assert_fail')), 'a dead code is the shortener working')
  await withShortener(() => new Response('', { status: 503 }), async () => {
    assert.equal(await liveResolvePinShortlink('Cn2Tb2Xx3', e, 'discord'), null)
  })
  assert.ok(points.some(p => JSON.stringify(p).includes('assert_fail') && JSON.stringify(p).includes('pn')),
    'no answer at all is the signal that Pinterest or the egress changed')
})

/* ===================== THE ROUTE ===================== */

test('/pin.it/{code} IS A PINTEREST SHORT LINK, and so is /pn/pin.it/{code}', () => {
  const want = { kind: 'shortlink', p: 'pn', code: 'Rq7Lm3Zx9', canonical: 'https://pin.it/Rq7Lm3Zx9' }
  assert.deepEqual(route(new URL('https://mbedfx.app/pin.it/Rq7Lm3Zx9')), want)
  assert.deepEqual(route(new URL('https://mbedfx.app/pin.it/Rq7Lm3Zx9/')), want, 'a trailing slash is the same link')
  assert.deepEqual(route(new URL('https://mbedfx.app/pn/pin.it/Rq7Lm3Zx9')), want, 'the escape hatch reaches it too')
  assert.deepEqual(route(new URL('https://mbedfx.app/pin.it/Ab3dE5f')), { ...want, code: 'Ab3dE5f', canonical: 'https://pin.it/Ab3dE5f' },
    'seven characters, the other length seen live')
  assert.ok(guestServes(route(new URL('https://mbedfx.app/pin.it/Rq7Lm3Zx9'))), 'and the guest hosts serve it, as they do /t/{code}')
})

test('THE CODE KEEPS ITS CASE, and the shape is the allowlist', () => {
  assert.equal(route(new URL('https://mbedfx.app/pin.it/AbCdEfG1')).code, 'AbCdEfG1', 'never lowercased: codes are case-sensitive')
  for (const p of [
    '/PIN.IT/Rq7Lm3Zx9',          // the host segment is matched exactly
    '/pin.it/Rq7L',               // too short
    '/pin.it/Rq7Lm3Zx9Rq7Lm',     // too long
    '/pin.it/Rq7-m3Zx9',          // outside [A-Za-z0-9]
    '/pin.it/Rq7Lm3Zx9/extra',    // depth 3
    '/pin.it/Rq7Lm3Zx9/p',        // no gallery mode on a short link, as on /t/{code}
    '/pin.it',                    // no code
  ]) {
    const r = route(new URL('https://mbedfx.app' + p))
    assert.ok(!(r.kind === 'shortlink' && r.p === 'pn'), `${p} is not a pin.it short link (got ${JSON.stringify(r)})`)
  }
})

test('THE d. SUFFIX AND DISCORD\'S OVER-CAPTURE STILL READ AS THE SHORT LINK', () => {
  const mp4 = route(new URL('https://mbedfx.app/pin.it/Rq7Lm3Zx9.mp4'))
  assert.equal(mp4.kind, 'shortlink')
  assert.equal(mp4.code, 'Rq7Lm3Zx9')
  assert.equal(mp4.direct, true, 'a `.mp4` asks for the file, as on every post-yielding route')
  assert.equal(route(new URL('https://mbedfx.app/pin.it/Rq7Lm3Zx9).')).code, 'Rq7Lm3Zx9', 'a masked-link `).` tail is cut')
})

test('IT ONLY EVER REPLACES A notfound — every other reading of a pin.it path is what a sibling host gets', () => {
  /**
   * THE SHADOWING CHECK, by control rather than by memory. Nothing in the router names `pin.it` except
   * pinShortlink(), so `/pin.is/…`, a host of the same shape, is routed exactly as `/pin.it/…` was before
   * it existed. For every path below, the two must agree (host aside) unless the control is a plain
   * notfound and the new answer is the pin.it short link. That covers the fediverse readings at depth 3
   * (`/pin.it/@user/{id}`, `/pin.it/post/{id}`), the ambiguity rows at depth 2, and every token an
   * existing two-segment route keys on.
   */
  const seconds = [
    'Rq7Lm3Zx9', 'Ab3dE5f', 'followers', 'following', 'lists', 'status', 'p', 'reel', 'reels', 'tv', 'video',
    'post', 'notes', 'w', 'comments', 's', 't', 'share', 'profile', '@alice', 'hashtag', 'search', 'explore',
    '123456789012', 'v', 'a', 'gallery', 'watch', 'embed', 'photo', 'u', 'c', 'm', 'statuses',
  ]
  const thirds = ['', '/123456789012', '/status/20', '/p', '/v', '/Rq7Lm3Zx9', '/abc', '/videos/watch/9a8b7c6d-0000-4000-8000-000000000000']
  const prefixes = ['', '/pn', '/tt', '/x', '/ms', '/lm']
  let changed = 0
  for (const pre of prefixes) {
    for (const s of seconds) {
      for (const t of thirds) {
        const now = route(new URL(`https://mbedfx.app${pre}/pin.it/${s}${t}`))
        const control = JSON.parse(JSON.stringify(route(new URL(`https://mbedfx.app${pre}/pin.is/${s}${t}`))).replaceAll('pin.is', 'pin.it'))
        if (JSON.stringify(now) === JSON.stringify(control)) continue
        changed++
        assert.equal(control.kind, 'notfound', `${pre}/pin.it/${s}${t} used to be ${JSON.stringify(control)}`)
        assert.ok(now.kind === 'shortlink' && now.p === 'pn', `${pre}/pin.it/${s}${t} became ${JSON.stringify(now)}`)
      }
    }
  }
  assert.ok(changed > 0, 'the sweep reached the new shape at all')
  // And the two choosers it sits next to are untouched.
  assert.deepEqual(route(new URL('https://mbedfx.app/pin.it/followers')).candidates, route(new URL('https://mbedfx.app/somebody/followers')).candidates)
  assert.equal(route(new URL('https://mbedfx.app/pin.it/followers')).kind, 'ambiguous')
  assert.equal(route(new URL('https://mbedfx.app/Rq7Lm3Zx9')).kind, 'ambiguous', 'a bare /{code} is still a handle, and the chooser')
})

/* ===================== THE SURFACES ===================== */

test('DISCORD GETS THE RESOLVED PIN\'S OWN CARD, and nothing in it carries the share code', async () => {
  const { deps, asked, seen } = depsWith('8800000000000000301')
  const { ctx: c } = ctx()
  const res = await handle(req('/pin.it/Dc3Rd0Xx1'), env(), c, deps)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.deepEqual(seen, ['Dc3Rd0Xx1'], 'the code was resolved, exactly as pasted')
  assert.deepEqual(asked, [{ p: 'pn', id: '8800000000000000301' }], 'and only the pin it names was fetched')
  assert.ok(html.includes('the pin behind 8800000000000000301'), 'the card is that pin\'s')
  assert.ok(html.includes('https://www.pinterest.com/pin/8800000000000000301/'), 'with the bare canonical')
  for (const junk of leaks('Dc3Rd0Xx1')) assert.ok(!html.includes(junk), `the card must not carry ${junk}`)
})

test('A HUMAN IS SENT TO THE BARE PIN, never through pin.it', async () => {
  const { deps } = depsWith('8800000000000000311')
  const { ctx: c } = ctx()
  const res = await handle(req('/pin.it/Hm3Nn0Xx1', { ua: HUMAN_UA }), env(), c, deps)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.pinterest.com/pin/8800000000000000311/')
})

test('A pin.it CODE THAT WILL NOT RESOLVE: Pinterest\'s calm card for Discord, a plain 404 for a human, never the TikTok chooser', async () => {
  /**
   * The failure half, and the two mistakes it is shaped against. The TikTok arm falls back to the share
   * url for a human and to the ['tt','th'] chooser for a bot; both are wrong here. Following pin.it lands
   * on a url carrying the sharer's id, and a pin.it code is Pinterest's beyond doubt.
   *
   * A resolver that answers null, one that THROWS, and a Deps with no resolver at all (an older stub)
   * must all land in the same place, and none of them as a 500.
   */
  const variants = [
    ['Un1Rs0Xx1', depsWith(null).deps],
    ['Un2Rs0Xx1', depsWith(() => { throw new TypeError('shortener hung up') }).deps],
    ['Un3Rs0Xx1', { ...depsWith(null).deps, resolvePinShortlink: undefined }],
    ['Un4Rs0Xx1', depsWith('not-a-pin-id').deps],
  ]
  for (const [code, deps] of variants) {
    const { ctx: c } = ctx()
    const bot = await handle(req(`/pin.it/${code}`), env(), c, deps)
    assert.equal(bot.status, 200, code)
    const html = await bot.text()
    assert.ok(html.includes("Couldn't load this Pinterest post"), `${code}: the calm Pinterest card`)
    assert.ok(!/Ambiguous|threads|tiktok/i.test(html), `${code}: no chooser, no other platform`)
    for (const junk of leaks(code)) assert.ok(!html.includes(junk), `${code}: the card must not carry ${junk}`)

    const human = await handle(req(`/pin.it/${code}`, { ua: HUMAN_UA }), env(), c, deps)
    assert.equal(human.status, 404, `${code}: a human is told, not redirected`)
    assert.equal(human.headers.get('location'), null)
    assert.match(human.headers.get('content-type'), /text\/plain/)
    const text = await human.text()
    assert.ok(text.includes('paste the full /pin/'), 'and told what to do instead')
    assert.ok(!text.includes(code), 'without echoing the code back as a link')
  }
})

test('THE d. HOST AND .mp4 GET THE PIN\'S FILE, and a miss is the plain-text 404 the d. host documents', async () => {
  const { deps } = depsWith('8800000000000000321')
  const { ctx: c } = ctx()
  for (const r of [req('/pin.it/Dm3Rd0Xx1', { host: 'd.mbedfx.app' }), req('/pin.it/Dm3Rd0Xx1.mp4')]) {
    const res = await handle(r, env(), c, deps)
    assert.equal(res.status, 302, r.url)
    assert.match(res.headers.get('location'), /\/_media\/pn%3A8800000000000000321\/0$/, `${r.url}: the pin's own media url`)
  }
  for (const r of [req('/pin.it/Dm4Rd0Xx1', { host: 'd.mbedfx.app' }), req('/pin.it/Dm4Rd0Xx1.mp4', { ua: HUMAN_UA })]) {
    const res = await handle(r, env(), c, depsWith(null).deps)
    assert.equal(res.status, 404, r.url)
    assert.match(res.headers.get('content-type'), /text\/plain/)
    assert.ok(!(await res.text()).includes('<'), `${r.url}: no markup on a url that promises bytes`)
  }
})

test('/_prep HANDS BACK /pin/{id}/ ON OUR ORIGIN, so the converter replaces the code', async () => {
  const { deps } = depsWith('8800000000000000331')
  const { ctx: c, settle } = ctx()
  const j = await (await handle(prepReq('/pin.it/Pp3Rd0Xx1'), env(), c, deps)).json()
  await settle()
  assert.deepEqual(j, {
    ok: true,
    url: 'https://mbedfx.app/pin/8800000000000000331/',
    canonical: 'https://www.pinterest.com/pin/8800000000000000331/',
    platform: 'pn',
    warming: false,
  })
  // The answer routes back to the same pin, so the page can hand it out as it is.
  assert.deepEqual(route(new URL(j.url)).ref, { p: 'pn', id: '8800000000000000331' })
})

test('/_prep ON A CODE THAT WILL NOT RESOLVE ANSWERS `shortlink`, which the converter turns into its old refusal', async () => {
  const { ctx: c } = ctx()
  const j = await (await handle(prepReq('/pin.it/Pp4Rd0Xx1'), env(), c, depsWith(null).deps)).json()
  assert.deepEqual(j, { ok: false, reason: 'shortlink' })
})

test('/_card AND /_api/v1 DESCRIBE THE RESOLVED PIN, and a miss is fetch_fail on Pinterest, never the TikTok chooser', async () => {
  const { deps } = depsWith('8800000000000000341')
  const { ctx: c } = ctx()
  const cardJ = await (await handle(cardReq('/pin.it/Cd3Rd0Xx1'), env(), c, deps)).json()
  assert.equal(cardJ.ok, true, `the preview must draw a card, got ${cardJ.reason}`)
  assert.equal(cardJ.platform, 'pn')
  assert.equal(cardJ.canonical, 'https://www.pinterest.com/pin/8800000000000000341/')
  assert.equal(cardJ.text, 'the pin behind 8800000000000000341')

  const apiJ = await (await handle(apiReq('/pin.it/Ap3Rd0Xx1'), env(), c, depsWith('8800000000000000342').deps)).json()
  assert.equal(apiJ.ok, true)
  assert.equal(apiJ.post.canonical, 'https://www.pinterest.com/pin/8800000000000000342/')

  const missCard = await (await handle(cardReq('/pin.it/Cd4Rd0Xx1'), env(), c, depsWith(null).deps)).json()
  assert.deepEqual(missCard, { ok: false, reason: 'fetch_fail' }, 'what the card says: couldn\'t load, never ambiguous')
  const missApi = await (await handle(apiReq('/pin.it/Ap4Rd0Xx1'), env(), c, depsWith(null).deps)).json()
  assert.equal(missApi.error.code, 'fetch_fail')
  assert.equal(missApi.error.platform, 'pn', 'the code is Pinterest\'s beyond doubt')
  // The share url, the one the caller sent: docs/API.md promises a real canonical on fetch_fail, and the
  // /t/{code} rows give theirs the same way. It is JSON for the caller, never a Location we send.
  assert.equal(missApi.error.canonical, 'https://pin.it/Ap4Rd0Xx1')
  assert.ok(missApi.error.candidates == null, 'no tt/th chooser')
})

test('THE API IS HOST-BLIND: ?url=https://pin.it/{code} IS THE BARE /{code} CHOOSER, so docs/API.md says to send /pin.it/{code}', async () => {
  const { ctx: c } = ctx()
  const { deps, seen } = depsWith('8800000000000000351')
  const j = await (await handle(apiReq('https://pin.it/Hb3Ld0Xx1'), env(), c, deps)).json()
  assert.equal(j.error.code, 'ambiguous')
  assert.deepEqual(j.error.candidates, ['x', 'ig'])
  assert.deepEqual(seen, [], 'nothing was resolved for it')
})

test('NOTHING ANY SURFACE ANSWERS CARRIES THE SENDER OR THE INVITE CODE — through the real resolver', async () => {
  /**
   * The privacy property end to end, with the REAL resolver (liveResolvePinShortlink and
   * resolvePinShortlink) behind a stubbed fetch that answers what the shortener was measured answering:
   * a Location carrying `invite_code` and `sender`. Every surface is read in full and searched.
   */
  const pins = pinFetcher()
  const deps = {
    cache: fakeCache(),
    fetchPost: pins.fetchPost,
    resolveShortlink: async () => { throw new Error('not TikTok') },
    resolveRedditShare: async () => null,
    resolveMetaShare: async () => null,
    resolvePinShortlink: liveResolvePinShortlink,
  }
  await withShortener(u => redirectTo(sentUrl(`88000000000000004${u.includes('Pv1') ? '01' : '02'}`)), async () => {
    const { ctx: c, settle } = ctx()
    const outputs = []
    const bot = await handle(req('/pin.it/Pv1Rc0Xx1'), env(), c, deps)
    outputs.push(await bot.text())
    const human = await handle(req('/pin.it/Pv1Rc0Xx1', { ua: HUMAN_UA }), env(), c, deps)
    outputs.push(human.headers.get('location'), await human.text())
    outputs.push(JSON.stringify(await (await handle(prepReq('/pin.it/Pv2Rc0Xx1'), env(), c, deps)).json()))
    outputs.push(JSON.stringify(await (await handle(cardReq('/pin.it/Pv2Rc0Xx1'), env(), c, deps)).json()))
    outputs.push(JSON.stringify(await (await handle(apiReq('/pin.it/Pv2Rc0Xx1'), env(), c, deps)).json()))
    await settle()
    assert.equal(human.headers.get('location'), 'https://www.pinterest.com/pin/8800000000000000401/')
    for (const out of outputs) {
      for (const junk of [SENDER, INVITE, 'sender=', 'invite_code', 'sfo=', '/sent']) {
        assert.ok(!String(out).includes(junk), `${junk} leaked into ${String(out).slice(0, 120)}`)
      }
    }
  })
})

test('PIN_SHORT_CODE ALLOWS THE LENGTHS SEEN LIVE AND NOTHING BUT [A-Za-z0-9]', () => {
  for (const ok of ['Ab3dE5f', 'Rq7Lm3Zx9', 'a1b2c3', 'ABCDEFGHIJKL']) assert.ok(PIN_SHORT_CODE.test(ok), ok)
  for (const bad of ['Ab3dE', 'ABCDEFGHIJKLM', 'Ab3-E5f', 'Ab3_E5f', 'Ab3.E5f', 'Ab3%E5f', '']) assert.ok(!PIN_SHORT_CODE.test(bad), bad)
})
