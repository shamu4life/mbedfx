import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../src/router.ts'

const ORIGIN = 'https://mbedfx.app'
const r = p => route(new URL(ORIGIN + p))

/**
 * LINK HYGIENE — the whole-surface guard, added 2026-07-30 after a user asked the right question:
 * "can we test that everything is correctly cleaning and resolving links now?"
 *
 * WHAT THIS FILE IS FOR, and why it is one file rather than a case in each platform's suite. Every
 * platform test asserts that ITS urls route. None of them asserted the cross-cutting property that
 * actually matters to a person sharing a link: THAT NOTHING THEY PASTE COMES BACK OUT. A tracking
 * parameter only has to survive on ONE platform to leak, so the guard has to be a sweep, not a
 * collection of per-platform habits.
 *
 * THE TWO PROPERTIES, stated once:
 *
 *   1. NOTHING FROM THE PASTED QUERY STRING SURVIVES INTO THE CANONICAL. router.ts's canonical()
 *      rebuilds from REF FIELDS with a literal scheme and host, so this is true by construction —
 *      but "true by construction" is exactly the kind of claim that quietly stops being true when
 *      someone threads a url through instead of a field. This test is what makes it stay true.
 *
 *   2. AN OPAQUE SHARE CODE IS RESOLVED, NEVER FORWARDED. A share code is minted per SHARING ACT.
 *      Forwarding one hands the destination a token that the platform can join back to the share
 *      event server-side. Codes must therefore reach a resolving route kind, never a 'post' ref that
 *      merely echoes them.
 *
 * WHAT WAS ACTUALLY MEASURED (2026-07-30), so nobody has to re-derive the stakes:
 *   /t/ZTAUdx7dv       -> /@kfc.laos/video/7658012561153035542?_r=1&_t=ZT-98PbBJ7V0JR
 *   /share/v/1Hk3d…    -> /reel/971477999277129/?rdid=…&share_url=<THE ENTIRE SHARE URL, plaintext>
 *   /share/Fixture08X  -> threads.com/@dexerto/post/DbWxxQjFe4u?xmt=…&slof=1
 * `share_url` is the loudest of these: the destination is handed the share link verbatim.
 *
 * ONE THING THIS FILE DELIBERATELY DOES NOT CLAIM. `_t` is NOT a sharer fingerprint travelling in the
 * link — measured, the same code resolved repeatedly from one machine yields the SAME `_t` while a
 * different resolver gets a different one, so it is minted for whoever RESOLVES. The residual is the
 * CODE, which the platform can join server-side. We cannot unmake that join. We can decline to carry
 * it, and that is the entire claim these tests enforce.
 */

/** Every tracking parameter observed in the wild on a link someone actually pasted. */
const TRACKERS = [
  '_t=ZT-98PbBJ7V0JR', '_r=1',                          // TikTok share
  'is_from_webapp=1', 'sender_device=pc',                // TikTok web
  'web_id=7300000000000000000',                          // TikTok DEVICE id — the loudest one
  'igsh=MWxxTRACKINGxx%3D%3D', 'img_index=1',            // Instagram
  's=20', 't=AbCdEfGhIjKlMn',                            // Twitter
  'utm_source=share', 'utm_medium=web3x', 'share_id=SECRET',  // Reddit
  'rdid=rdidFixtureXXXXX',                               // Facebook redirect id
  'share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2Fv%2F1Hk3dBbUyJ%2F',  // FB: the share link itself
  'xmt=AQG0jYx9nY3h5cV', 'slof=1',                       // Threads
  'feature=share', 'si=AbCdEfGhIjKl',                    // YouTube
  'referral_source=external_link', 'surface_type=tab',   // Facebook reel
]

/** One real permalink per platform, in the shape a person pastes. */
const PERMALINKS = [
  ['tiktok',    '/@kfc.laos/video/7658012561153035542'],
  ['twitter',   '/xqc/status/20'],
  ['instagram', '/p/DbN6SsKum-9'],
  ['instagram reel', '/reel/DZFDtEhoNPy'],
  ['threads',   '/@dexerto/post/DbWxxQjFe4u'],
  ['reddit',    '/r/pics/comments/abc123'],
  ['youtube',   '/9bZkp7q19f0'],
  ['youtube watch', '/watch?v=9bZkp7q19f0'],
  ['facebook',  '/reel/2209468366484962'],
  ['twitch',    '/DeliciousDelightfulPicklesWOOP'],
  ['pinterest', '/pin/66287425756772418'],
  ['lemmy',     '/lemmy.world/post/49966212'],
  ['mastodon',  '/mstdn.social/@stux/116994812581955524'],
  ['misskey',   '/misskey.io/notes/ap7sliijot1f03nr'],
  ['peertube',  '/framatube.org/w/vZNcho9kCoVzc8wZwacPtc'],
  ['bluesky',   '/profile/bsky.app/post/3labcdefghij'],
]

test('NO PASTED QUERY PARAMETER EVER REACHES THE CANONICAL — every platform, every tracker', () => {
  /**
   * The sweep. Each permalink is pasted once per tracking parameter, and the emitted canonical must
   * be byte-identical to the clean one. A single survivor on a single platform is a leak.
   */
  let checked = 0
  for (const [name, path] of PERMALINKS) {
    const clean = r(path)
    assert.equal(clean.kind, 'post', `${name}: the clean permalink must route (${path})`)
    const want = clean.canonical
    assert.ok(want, `${name}: routes with a canonical`)

    for (const q of TRACKERS) {
      const joined = path.includes('?') ? `${path}&${q}` : `${path}?${q}`
      const got = r(joined)
      assert.equal(got.kind, 'post', `${name}: still routes with ?${q.slice(0, 24)}`)
      assert.equal(got.canonical, want, `${name}: ?${q.slice(0, 24)} must not change the canonical`)
      checked++
    }
  }
  assert.ok(checked >= 250, `the sweep must be wide to mean anything (was ${checked})`)
})

test('NO CANONICAL THIS ROUTER EMITS CARRIES A QUERY STRING AT ALL — except where the platform needs one', () => {
  /**
   * Stronger and simpler than matching a tracker denylist: a canonical should have no query at all,
   * so a NEW parameter nobody has heard of cannot slip through a list that was written in 2026.
   *
   * YouTube's /watch?v= is the one legitimate exception — the id lives IN the query there, and it is
   * asserted to carry exactly that one key and nothing else.
   */
  for (const [name, path] of PERMALINKS) {
    for (const q of ['', '?utm_source=share&_t=ZT-98x&web_id=73000', '?igsh=XX&s=20&rdid=YY']) {
      const got = r(path + (path.includes('?') && q ? q.replace('?', '&') : q))
      if (got.kind !== 'post') continue
      const u = new URL(got.canonical)
      const keys = [...u.searchParams.keys()]
      if (keys.length === 0) continue
      assert.deepEqual(keys, ['v'], `${name}: only YouTube's ?v= may remain, got ${keys.join(',')}`)
      assert.match(u.href, /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/, `${name}: and nothing else`)
    }
  }
})

test('AN OPAQUE SHARE CODE IS RESOLVED, NEVER ECHOED AS A POST', () => {
  /**
   * A share code names no post until a network hop resolves it, and it is minted per SHARING ACT.
   * Minting a 'post' ref from one means the code becomes the identity — cached under it, echoed in
   * the canonical, and handed to whoever clicks. These shapes must reach a RESOLVING route kind.
   */
  const RESOLVING = new Set(['shortlink', 'redditshare', 'metashare'])
  for (const [name, path, kind] of [
    ['tiktok /t/',        '/t/ZTAUdx7dv',               'shortlink'],
    ['reddit /s/',        '/r/pics/s/abc123def',        'redditshare'],
    ['meta bare /share/', '/share/Fixture08X',          'metashare'],
    ['meta bare /share/', '/share/_pqHlzmHj',           'metashare'],
    ['meta bare /share/', '/share/Fixture03X',          'metashare'],
  ]) {
    const got = r(path)
    assert.equal(got.kind, kind, `${name} ${path} must resolve, not be attributed by shape`)
    assert.ok(RESOLVING.has(got.kind))
  }
})

test('THE TWO CODES FOR ONE POST NO LONGER TAKE TWO DIFFERENT WRONG PATHS', () => {
  /**
   * The reported defect, pinned. One Threads post yielded /share/_pqHlzmHj and /share/Fixture08X.
   * Before the fix the first was notfound (a leading underscore fails FB_CODE) and the second was
   * routed to FACEBOOK — two codes, one post, two different wrong answers, and the second one 302'd
   * a Threads token to a site the sharer never pasted.
   */
  const a = r('/share/_pqHlzmHj')
  const b = r('/share/Fixture08X')
  assert.equal(a.kind, 'metashare')
  assert.equal(b.kind, 'metashare')
  assert.doesNotMatch(a.canonical, /facebook\.com/, 'never assumed to be Facebook')
  assert.doesNotMatch(b.canonical, /facebook\.com/)
})

test('THE TYPED FACEBOOK SHARE FORMS ARE STILL FACEBOOK — only the bare one was ambiguous', () => {
  for (const p of ['/share/v/Fixture03X', '/share/r/Fixture03X', '/share/p/Fixture03X']) {
    const got = r(p)
    assert.equal(got.kind, 'post', `${p} routes`)
    assert.equal(got.ref.p, 'fb', `${p} names Facebook in the url itself`)
  }
})

test('A TRACKING PARAMETER CANNOT SMUGGLE A DIFFERENT POST', () => {
  /**
   * The inverse worry, and worth pinning separately: the canonical must come from the PATH, so a
   * query parameter cannot redirect a viewer to a post other than the one that was pasted.
   */
  const honest = r('/@kfc.laos/video/7658012561153035542').canonical
  for (const q of [
    '?u=https://evil.example/',
    '?v=OTHERVIDEOID1',
    '?redirect=https%3A%2F%2Fevil.example',
    '?_t=../../../@someoneelse/video/1111111111111111111',
  ]) {
    const got = r(`/@kfc.laos/video/7658012561153035542${q}`)
    assert.equal(got.canonical, honest, `${q} must not move the destination`)
    assert.doesNotMatch(got.canonical, /evil\.example/)
  }
})

/**
 * THE BYLINE, added 2026-07-30 after a defect I shipped one commit earlier.
 *
 * fbAuthor started leaving `handle` EMPTY for a Facebook group post — a group has an id, not a
 * username — and its comment asserted "the renderers already omit an empty one instead of printing
 * `(@)`". They did not. Production rendered the literal
 *
 *     GMT800s With Threatening Auras v2 (@)
 *
 * because SIX separate sites each built `${name} (@${handle})` by hand: discord.ts twice,
 * telegram.ts once, text.ts three times. byline() is now the one spelling, and this pins it.
 */
import { byline } from '../src/render/embed.ts'

test('byline: no handle means no parenthetical', () => {
  assert.equal(byline({ name: 'GMT800s With Threatening Auras v2', handle: '' }),
    'GMT800s With Threatening Auras v2', 'the (@) is gone')
  assert.equal(byline({ name: 'stux', handle: 'stux@mstdn.social' }), 'stux (@stux@mstdn.social)')
})

test('byline is TOTAL — a corrupted cache record must not print "undefined"', () => {
  // deserializePost validates ref, canonical and createdAt and NOTHING else, so author can be
  // absent entirely. That is the path this whole family of guards exists for.
  for (const junk of [undefined, null, {}, { name: 'x' }, { handle: 'y' }, 0, 'str']) {
    const got = byline(junk)
    assert.equal(typeof got, 'string', `${String(junk)} yields a string`)
    assert.doesNotMatch(got, /undefined|null|\[object/, `${String(junk)} leaked a raw value`)
  }
  assert.equal(byline(undefined), '', 'no author at all is empty, not " (@)"')
  assert.equal(byline({ handle: 'y' }), ' (@y)', 'a handle with no name still renders the handle')
})
