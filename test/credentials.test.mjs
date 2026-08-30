import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { accountPool, cookiesFor, parseAccounts, pickAccount, poolSetButUnused, twitterAccounts } from '../src/credentials.ts'
import { handle, metaCacheKey, META_GENERATION } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
import { normalizeYouTube } from '../src/platforms/youtube/normalize.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync as _rf } from 'node:fs'

/**
 * THE ACCOUNT POOLS — reading them, and WHICH CONTAINER CALLS MAY SPEND THEM.
 *
 * NOT ONE REAL CREDENTIAL ANYWHERE IN THIS FILE, and that is a rule rather than a convenience. Every
 * value below is a shouty dummy ('COOKIE-FIXTURE', 'AUTH-FIXTURE'), and every assertion is about a
 * value's PRESENCE, ABSENCE or identity with a dummy — never about printing one. A fixture that looks
 * like a session is a session as far as a leaked repo, a CI log or a screenshot is concerned, and this
 * is the one test file where somebody would think to paste a real one to "make it realistic".
 */

const COOKIE = '# Netscape HTTP Cookie File\n.example\tTRUE\t/\tTRUE\t0\tsid\tCOOKIE-FIXTURE\n'
const COOKIE_TWO = '# Netscape HTTP Cookie File\n.example\tTRUE\t/\tTRUE\t0\tsid\tCOOKIE-FIXTURE-2\n'
const pool = (...accounts) => JSON.stringify(accounts)

// ── The pure half: reading a secret can never be the thing that breaks a platform.

test('parseAccounts IS TOTAL — every malformed secret is an EMPTY POOL and NOTHING throws', () => {
  /**
   * THE DEFECT THIS PREVENTS IS AN OUTAGE, not a missing feature. These pools are consulted on the
   * request path for ORDINARY posts — every yt meta call and every ig/yt mux asks for a jar first —
   * so a stray comma in a secret nobody has looked at for a month would 500 every card on the
   * platform, turning a credential typo into downtime on the one path that has nothing to do with
   * credentials. An empty pool is the SAME behaviour as an unset secret, which is the honest verdict
   * for a secret we cannot read.
   */
  const junk = [
    undefined, null, '', '   ', 'not json', '{', '[',
    '[1,2,3]', '["a","b"]', '[null]', '[[]]', '[true]',
    // A BARE OBJECT is the plausible paste — one account, no array — and it is REFUSED rather than
    // coerced. Accepting it would mean a pool of one that silently never rotates, which is the
    // failure that gets an account flagged; refusing is the loudest signal available here.
    JSON.stringify({ cookies: COOKIE }),
    // JSON that parses to a scalar. `JSON.parse('"x"')` and `JSON.parse('42')` both succeed, so the
    // array check is what refuses them, not the try/catch.
    '"COOKIE-FIXTURE"', '42', 'true', 'null',
  ]
  for (const raw of junk) {
    assert.doesNotThrow(() => parseAccounts(raw), `${String(raw)} must not throw`)
    assert.deepEqual(parseAccounts(raw), [], `${String(raw)} is not a pool`)
  }
  // A non-string input at all — the shape a mis-typed binding (an R2 bucket, a KV namespace) arrives
  // as. Same answer, still no throw.
  for (const notAString of [{}, [], 7, Symbol.iterator ? () => {} : null]) {
    assert.deepEqual(parseAccounts(notAString), [])
  }
})

test('an entry carrying NO CREDENTIAL is DROPPED, and it does not take the rest of the pool with it', () => {
  /**
   * A pool is edited by hand, so a half-filled entry (a label typed before the token was pasted) is
   * the realistic mistake. Dropping ONLY that entry keeps the accounts that ARE usable in play — the
   * alternative, refusing the whole array, would turn one typo into "the credentials stopped working"
   * with no way to tell which line did it. It also keeps the pool count honest: `poolSetButUnused`
   * and `twitterAccounts` both read this length as "how many accounts could be spent".
   */
  const parsed = parseAccounts(pool(
    { label: 'nothing-but-a-name' },          // no credential at all
    { cookies: '' },                          // present but empty is not a credential
    { cookies: 42 },                          // wrong type
    { label: 'real', cookies: COOKIE },       // the one that counts
  ))
  assert.equal(parsed.length, 1, 'only the entry with a credential survives')
  assert.equal(parsed[0].label, 'real')
  assert.equal(parsed[0].cookies, COOKIE)
  // Unknown keys are not carried through — the type is the contract, and a stray field would ride
  // into whatever a later phase serializes.
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['cookies', 'label'])
})

test('pickAccount NEVER INDEXES OFF THE END, whatever the picker returns', () => {
  /**
   * `Math.floor(pick() * len)` is `len` exactly when pick() returns 1, which yields `undefined` and
   * would hand a caller an account-shaped hole — for `cookiesFor` that reads as "no jar" (a silently
   * unauthenticated call), and for a filled Twitter seam it would be a property read on undefined
   * inside a request. Math.random() never returns 1, so this is unreachable from production TODAY and
   * one injected picker away from being reachable, which is exactly the kind of hole worth pinning
   * before somebody supplies a deterministic picker for a different reason.
   */
  const two = parseAccounts(pool({ cookies: COOKIE }, { cookies: COOKIE_TWO }))
  assert.equal(pickAccount(two, () => 1)?.cookies, COOKIE_TWO, 'a picker of exactly 1 lands on the last')
  assert.equal(pickAccount(two, () => 0)?.cookies, COOKIE, 'and 0 on the first')
  assert.equal(pickAccount(two, () => 1.9)?.cookies, COOKIE_TWO, 'an out-of-range picker is clamped')
  assert.equal(pickAccount(two, () => -3)?.cookies, COOKIE, 'and so is a negative one')
  // A NaN picker degrades to NO ACCOUNT rather than to an out-of-range read. That is the safe half of
  // the property — a null means an unauthenticated call, which is what every deploy with no pool
  // already does — and it is asserted as `null` rather than as an account so nobody "fixes" it into
  // silently picking index 0 on a picker that has told us nothing.
  assert.equal(pickAccount(two, () => NaN), null, 'a NaN picker yields no account, never a hole')
  assert.equal(pickAccount([], () => 0), null, 'an empty pool is null, never undefined')
  // Both accounts are reachable — a pool that always returns one account is the load concentration
  // the pool exists to avoid.
  assert.equal(pickAccount(two, () => 0.6)?.cookies, COOKIE_TWO)
})

test('cookiesFor REFUSES TWITTER even when the X pool is fully populated', () => {
  /**
   * Twitter's gate is beaten in the WORKER (a logged-in GraphQL call), never inside yt-dlp — so a
   * Twitter session in the container is a credential handed to a subprocess that has no use for it,
   * which is a pure widening of where it can leak (an argv, a temp file, a crash dump) for zero
   * benefit. Pinned here rather than trusted to the call sites because there is exactly one function
   * that turns a pool into bytes on the wire, and this is the refusal that has to hold in it.
   */
  const env = { X_ACCOUNTS: pool({ label: 'x1', auth_token: 'AUTH-FIXTURE', ct0: 'CT0-FIXTURE', cookies: COOKIE }) }
  assert.equal(cookiesFor(env, 'x'), null, 'no jar for x, with a pool that has one to give')
  assert.equal(cookiesFor(env, 'x', () => 0), null, 'and not for any picker either')
  // The SAME secret is readable by the path that is allowed to read it — so the null above is a
  // refusal, not an accident of an unparseable pool.
  assert.equal(accountPool(env, 'x').length, 1)
  assert.equal(twitterAccounts(env).length, 1, 'auth_token + ct0 together make a usable Twitter account')
})

test('twitterAccounts requires BOTH halves of the session pair, and poolSetButUnused does not', () => {
  /**
   * The two predicates answer different questions and the difference is what the `pool_unused`
   * counter means. A TweetResultByRestId call needs auth_token AND ct0; an entry with one of them is
   * not an account that arm could ever have spent, so counting it would report a staging gap where
   * the honest answer is "that secret is the wrong shape".
   */
  const env = {
    X_ACCOUNTS: pool(
      { label: 'half', auth_token: 'AUTH-FIXTURE' },
      { label: 'other-half', ct0: 'CT0-FIXTURE', cookies: COOKIE },
      { label: 'whole', auth_token: 'AUTH-FIXTURE', ct0: 'CT0-FIXTURE' },
    ),
  }
  assert.equal(twitterAccounts(env).length, 1, 'only the entry with both halves')
  assert.equal(twitterAccounts(env)[0].label, 'whole')
  assert.equal(poolSetButUnused(env, 'x'), true, 'the pool is set — that is all this one claims')
  assert.equal(poolSetButUnused({}, 'ig'), false, 'an unset secret is not a set pool')
  assert.equal(poolSetButUnused({ IG_ACCOUNTS: 'not json' }, 'ig'), false,
    'and neither is an unreadable one — a malformed secret must not look configured')
})

// ── The wire half: which container calls carry a jar, driven through the REAL dispatcher.
//
// Asserted on the BODY THE FAKE RESOLVER ACTUALLY RECEIVES, never on the code path that built it. A
// test that read the source, or trusted a helper's return value, would pass while the value was
// dropped at the JSON.stringify — which is the only place that matters, because it is the wire.

const ctx = { waitUntil() {} }
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}

/** Minimal R2: the mux object is always COLD, so every /_media/ hit really dispatches a container call. */
function fakeR2(seed = []) {
  const store = new Map()
  for (const [k, v] of seed) store.set(k, { bytes: new TextEncoder().encode(v), uploaded: new Date() })
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.bytes.length } : null },
    async get(k, opts) {
      const v = store.get(k)
      if (!v) return null
      const off = opts?.range?.offset ?? 0
      return {
        body: new Response(v.bytes.slice(off)).body, size: v.bytes.length, uploaded: v.uploaded,
        async json() { return JSON.parse(new TextDecoder().decode(v.bytes)) },
      }
    },
    async put(k, body) {
      const bytes = typeof body === 'string'
        ? new TextEncoder().encode(body)
        : new Uint8Array(await new Response(body).arrayBuffer())
      store.set(k, { bytes, uploaded: new Date() })
    },
  }
}

/** Records every body the container is handed. `bodies` is the whole assertion surface below. */
function fakeResolver(meta = { title: 'ignored', timestamp: 1256453853 }) {
  const bodies = []
  return {
    bodies,
    binding: {
      getByName: () => ({
        async fetch(_url, init) {
          const body = JSON.parse(init.body)
          bodies.push(body)
          if (body.meta === true) return Response.json(meta)
          return new Response('MP4', { headers: { 'content-type': 'video/mp4', 'content-length': '3' } })
        },
      }),
    },
  }
}

const envWith = (binding, r2, secrets = {}) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: binding, MEDIA_CACHE: r2, ...secrets,
})

/** A post whose single video is a `{page}` remux — the shape fb, yt, ig and the yt-dlp tier all ship. */
const remuxPost = (ref, page) => ({
  ref, canonical: page,
  author: { name: 'A', handle: 'a', url: 'https://example.invalid/a' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [{ kind: 'video', url: page, w: 0, h: 0, poster: 'https://example.invalid/p.jpg', remux: { page } }],
})

const mediaReq = ref =>
  new Request(`https://staging.megapenispoopenfarten.sex/_media/${encodeURIComponent(refKey(ref))}/0`,
    { headers: { 'user-agent': DISCORD } })

/** Drive ONE /_media/ mux and hand back every body the container saw. */
async function muxBodies(ref, page, secrets) {
  const { bodies, binding } = fakeResolver()
  await handle(mediaReq(ref), envWith(binding, fakeR2(), secrets), ctx,
    { cache: fakeCache(), fetchPost: async () => remuxPost(ref, page) })
  return bodies
}

const ALL_THREE = {
  X_ACCOUNTS: pool({ label: 'x1', auth_token: 'AUTH-FIXTURE', ct0: 'CT0-FIXTURE', cookies: COOKIE }),
  IG_ACCOUNTS: pool({ label: 'ig1', cookies: COOKIE }),
  YT_ACCOUNTS: pool({ label: 'yt1', cookies: COOKIE }),
}

// EVERY TEST GETS ITS OWN ID. muxInflight and metaInflight are module-level and isolate-lifetime, so
// one test's in-flight promise under a shared key becomes the next test's answer — and a test that
// never dispatches has no body to assert on, which reads as "the jar was not sent".

test('A YOUTUBE MUX CARRIES THE JAR when YT_ACCOUNTS is set, and carries NO cookies key when it is not', async () => {
  /**
   * The two halves belong in one test because the second is what makes the first safe to ship. An
   * age-gated video answers `formats: 0` cookie-free, so the jar is the whole feature; but the jar is
   * also a session, and the deploys with no pool (every fork, every self-host, this repo until an
   * operator fills a secret) must send a body that is byte-for-byte the one they always sent. `cookies:
   * null` would satisfy the container and still put a field on the wire that a log or an error body
   * could echo — so the key is ABSENT, not empty, and that is what is asserted.
   */
  const withPool = await muxBodies({ p: 'yt', id: 'JARyt000001' }, 'https://www.youtube.com/watch?v=JARyt000001', ALL_THREE)
  assert.equal(withPool.length, 1, 'one mux call')
  assert.equal(withPool[0].cookies, COOKIE, 'the jar reaches the container')
  assert.equal(withPool[0].page, 'https://www.youtube.com/watch?v=JARyt000001', 'and the source is untouched')

  const without = await muxBodies({ p: 'yt', id: 'JARyt000002' }, 'https://www.youtube.com/watch?v=JARyt000002', {})
  assert.equal(without.length, 1)
  assert.ok(!('cookies' in without[0]), 'NO cookies key at all — absent, not null')
  assert.deepEqual(without[0], { page: 'https://www.youtube.com/watch?v=JARyt000002' },
    'the body an operator with no pool sends is exactly the body this call always sent')
})

test('AN INSTAGRAM MUX CARRIES THE JAR — the copyright-remux recovery is the path that can spend it', async () => {
  /**
   * Instagram's remux is a `{page}` handed to yt-dlp (withCopyrightRemux), which is precisely where a
   * logged-in session changes the answer: the reels this recovers are ones the embed serializer
   * stripped, and a jar is what lets the extract see the rendition. Pinned because the platform
   * allowlist is a two-name list and Instagram is the name most likely to be dropped from it by
   * somebody reasoning only about YouTube's age gate.
   */
  const bodies = await muxBodies({ p: 'ig', kind: 'reel', code: 'JARig00001' },
    'https://www.instagram.com/reel/JARig00001/', ALL_THREE)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].cookies, COOKIE)
})

test('FACEBOOK, DAILYMOTION, STREAMABLE AND IMGUR NEVER RECEIVE A JAR, with all three pools populated', async () => {
  /**
   * THE SECURITY PROPERTY OF THE WHOLE FEATURE, and the only one that cannot be recovered after it is
   * broken. None of these four has a gate yt-dlp beats with a login, so a session sent to their
   * extract is spent nowhere and exposed everywhere — an argv, a temp jar, a crash dump — and a
   * credential that has been in a subprocess it had no business being in cannot be un-sent.
   *
   * ALL THREE POOLS ARE FILLED deliberately: the failure this catches is a jar attached at the
   * SHARED call site (ensureMuxed, or the `{page, meta:true}` shape these copy from YouTube's) rather
   * than per platform, and that mistake is invisible against an env with only YT_ACCOUNTS set.
   */
  const cases = [
    [{ p: 'fb', kind: 'watch', id: 'JARfb00001' }, 'https://www.facebook.com/watch/?v=JARfb00001'],
    [{ p: 'dm', id: 'xjarab' }, 'https://www.dailymotion.com/video/xjarab'],
    [{ p: 'st', id: 'jarst1' }, 'https://streamable.com/jarst1'],
    [{ p: 'im', kind: 'post', id: 'JARim01' }, 'https://i.imgur.com/JARim01.gifv'],
  ]
  for (const [ref, page] of cases) {
    const bodies = await muxBodies(ref, page, ALL_THREE)
    assert.equal(bodies.length, 1, `${ref.p} dispatched exactly one call`)
    assert.ok(!('cookies' in bodies[0]), `${ref.p} must never carry a cookie jar`)
    // Asserted on the WHOLE body, not just the missing key: a jar smuggled under any other name
    // (auth, headers, session) is the same leak with a different spelling.
    assert.deepEqual(bodies[0], { page }, `${ref.p} sends the page and nothing else`)
  }
})

test('THE YOUTUBE META CALL CARRIES THE JAR TOO — the record it writes lives for 30 days', async () => {
  /**
   * The mux alone is not enough, and the reason is the cache rather than the extract: `yt-dlp -J` on a
   * gated id returns `age_limit: 18` with `formats: 0`, and that record is PERSISTED for YT_META_TTL_MS.
   * A cookie-free meta call would therefore keep the 🔞 note on a card whose video a filled pool can
   * play, for a month, on every colo, unfixable by re-pasting — the exact shape of staleness this
   * project's generation switch exists to stop.
   */
  const ref = { p: 'yt', id: 'JARyt000003' }
  const { bodies, binding } = fakeResolver({ title: 't', timestamp: 1256453853 })
  // The mux object is seeded WARM so the only cold work on this route is the meta call — otherwise a
  // mux body would be the first thing recorded and the assertion would be about the wrong call.
  const r2 = fakeR2([[`mux/${refKey(ref)}/0`, 'MP4']])
  const req = new Request(
    `https://staging.megapenispoopenfarten.sex/users/anyone/statuses/${encodeStatusId(refKey(ref))}`,
    { headers: { 'user-agent': DISCORD } })
  /**
   * BUILT BY THE REAL NORMALIZER, not by hand, because youtubeMeta's gate chain reads two things a
   * synthetic post gets wrong in opposite directions: it declines when the post ALREADY carries a real
   * date (a hand-rolled `new Date()` is one, and the call is skipped), and it declines when oembed
   * never vouched for the id (a hand-rolled author.url is not the fallback constant, which would hide
   * the opposite mistake). An oembed-answered post with no date is the state a first paste is in.
   */
  const post = normalizeYouTube({
    ok: true,
    oembed: {
      title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley',
      author_url: 'https://www.youtube.com/@RickAstley',
      thumbnail_url: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`,
    },
  }, ref)
  await handle(req, envWith(binding, r2, ALL_THREE), ctx, {
    cache: fakeCache(),
    fetchPost: async () => post,
    resolveShortlink: async () => ({ kind: 'unresolved' }),
    resolveRedditShare: async () => null,
  })
  const metaBodies = bodies.filter(b => b.meta === true)
  assert.equal(metaBodies.length, 1, 'the activity route made the meta call')
  assert.equal(metaBodies[0].cookies, COOKIE, 'and it carried the jar')
  assert.equal(metaBodies[0].page, `https://www.youtube.com/watch?v=${ref.id}`)
})

// ── Fill-day: a gate verdict reached WITHOUT a jar must not outlive the day a jar arrives.

test('A GATED RECORD WRITTEN WITH NO JAR IS REFUSED once a pool is filled, and kept when there is none', async () => {
  /**
   * THE HOLE g10 COULD NOT REACH, found 2026-08-03. The generation bump retired every record written
   * before the cookie CODE shipped. The records written AFTER that deploy and BEFORE an operator fills
   * YT_ACCOUNTS are g10 records too — a jar-capable build with no jar to send — so no bump retires them,
   * and that window is every day until fill-day rather than a moment. Each one persists `ageLimit: 18`
   * for 30 days, on every colo. Filling the secret would heal none of them: the warm record is returned
   * before any container call is considered, ytMetaValid deliberately does not test `ageLimit`, and
   * re-pasting reads the same record. The operator would see no change, then see `pool_unused` and be
   * told by docs/CREDENTIALS.md that their brand-new accounts are dead.
   *
   * THE THIRD CASE IS WHAT KEEPS THIS FROM BEING A GENERATION BUMP IN DISGUISE. A record that DID carry
   * a jar and still says gated is a measured answer — "logged in, still walled" — and re-extracting it
   * would spend a container call per gated video per cold view, forever, to re-learn one fact.
   *
   * Asserted through the REAL platform arm, on the Post it builds, because that read is the one every
   * renderer and the post cache see — a record refused there is a post with no date rather than a card
   * with a wrong note.
   */
  const dated = async (id, record, secrets) => {
    const ref = { p: 'yt', id }
    const env = countingEnv(secrets, {
      MEDIA_CACHE: fakeR2([[metaCacheKey(ref), JSON.stringify(record)]]),
    })
    const post = await offline(
      { title: 't', author_name: 'a', author_url: 'https://www.youtube.com/@a' },
      () => import('../src/worker.ts').then(m => m.liveFetchPost(ref, env, 'discord')))
    return post.createdAt.getTime()
  }
  const YT = { YT_ACCOUNTS: pool({ label: 'yt1', cookies: COOKIE }) }
  const GATED = { timestamp: 1256453853, ageLimit: 18 }

  assert.equal(await dated('FILLday0001', GATED, YT), 0,
    'a jar-free GATED record is refused once a pool exists — the post falls back to no date, and the '
    + 'next activity callback re-extracts it WITH the jar')
  assert.equal(await dated('FILLday0002', GATED, {}), 1256453853000,
    'with NO pool configured nothing is invalidated — every fork and every deploy that will never set a '
    + 'secret keeps its whole cache, which is what makes this free to merge')
  assert.equal(await dated('FILLday0003', { ...GATED, jarred: true }, YT), 1256453853000,
    'a record that CARRIED a jar and still said gated is a measured answer, not an unanswered question')
  assert.equal(await dated('FILLday0004', { timestamp: 1256453853 }, YT), 1256453853000,
    'an UNGATED record is never touched — ordinary traffic must not pay for this')
})

test('THE ACTIVITY ROUTE RE-EXTRACTS a jar-free gated record, and the fresh one records that it was jarred', async () => {
  /**
   * The other half of the test above: refusing the record is only useful if something then goes and
   * asks again. youtubeMeta's warm read is what stood between a filled pool and a corrected card, so
   * this asserts the container call actually happens — and that it carries the jar, since a re-extract
   * that went out cookie-free would write the identical stale record and loop.
   *
   * `jarred` IS ASSERTED ON THE STORED OBJECT rather than on a return value, because the flag's whole
   * job is to survive into R2 and be read back in 30 days by a different isolate. A field that is
   * computed correctly and dropped at the JSON.stringify would pass every other check in this file.
   */
  const ref = { p: 'yt', id: 'FILLday0005' }
  const { bodies, binding } = fakeResolver({ title: 't', timestamp: 1256453853, age_limit: 18 })
  const r2 = fakeR2([
    [`mux/${refKey(ref)}/0`, 'MP4'],
    [metaCacheKey(ref), JSON.stringify({ timestamp: 1256453853, ageLimit: 18 })],
  ])
  const post = normalizeYouTube({
    ok: true,
    oembed: {
      title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley',
      author_url: 'https://www.youtube.com/@RickAstley',
      thumbnail_url: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`,
    },
  }, ref)
  await handle(
    new Request(
      `https://staging.megapenispoopenfarten.sex/users/anyone/statuses/${encodeStatusId(refKey(ref))}`,
      { headers: { 'user-agent': DISCORD } }),
    envWith(binding, r2, { YT_ACCOUNTS: pool({ label: 'yt1', cookies: COOKIE }) }), ctx,
    {
      cache: fakeCache(),
      fetchPost: async () => post,
      resolveShortlink: async () => ({ kind: 'unresolved' }),
      resolveRedditShare: async () => null,
    })
  const metaBodies = bodies.filter(b => b.meta === true)
  assert.equal(metaBodies.length, 1, 'the stale record did NOT satisfy the warm read — the extract ran')
  assert.equal(metaBodies[0].cookies, COOKIE, 'and it went out logged in, or it would write the same record back')

  const stored = await r2.get(metaCacheKey(ref)).then(o => o.json())
  assert.equal(stored.jarred, true, 'the fresh record carries its provenance into R2')
  assert.equal(stored.ageLimit, 18, 'and the gate verdict it measured WITH the jar is kept, not discarded')
})

test('ALL THREE READS OF THE YT META RECORD USE THE POOL-AWARE VALIDATOR — the sweep that stops one seam being fixed alone', () => {
  /**
   * THE DEFECT SHAPE THIS PROJECT REPEATS. A yt meta record is read in three places — the platform arm
   * that builds the Post, youtubeMeta on the activity route, and the converter preview's own fallback —
   * and the preview is the seam with no second chance, because /_card is fetched once per typing-settle
   * and nobody re-pastes to heal it. Fixing the staleness at one read and not the others would leave a
   * card that corrects itself in Discord and never corrects itself in the preview, which is exactly the
   * pair of defects the YouTube epoch bug shipped.
   *
   * Written as a grep over the source rather than three behavioural tests because the property IS
   * "there is no fourth spelling": a new read site added later has to opt IN to the bare validator
   * deliberately, and this fails until it does. Same instrument, and the same reason, as the argv-splice
   * pin in test/ytdlp-tier.test.mjs.
   */
  const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const reads = [...src.matchAll(/readCachedMeta<YouTubeMeta>\([^)]*\)/g)].map(m => m[0])
  assert.ok(reads.length >= 3, `expected every yt meta read to be found, saw ${reads.length}`)
  for (const read of reads) {
    assert.match(read, /ytMetaUsable\(env\)/,
      `a yt meta read is using a validator that cannot tell a pre-jar gate verdict from a measured one: ${read}`)
  }
})

// ── The counter: `pool_unused` is emitted in the arm that would have spent a credential and could not.

/**
 * `env.AE?.writeDataPoint(p)` is the whole analytics surface, so collecting `p` is collecting every
 * counter the request emitted — see pipeline.test.mjs, which uses the same receiver.
 */
const countingEnv = (secrets = {}, extra = {}) => {
  const points = []
  return {
    points,
    AE: { writeDataPoint(p) { points.push(p) } },
    ASSETS: { async fetch() { return new Response('a') } },
    ...secrets, ...extra,
  }
}
const outcomes = (env, platform) => env.points.filter(p => p.blobs[0] === platform).map(p => p.blobs[1])

/** Stub the network for one call. Nothing in this file may reach a real host. */
async function offline(body, run) {
  const real = globalThis.fetch
  globalThis.fetch = async () => (typeof body === 'string'
    ? new Response(body, { status: 200 })
    : Response.json(body))
  try { return await run() } finally { globalThis.fetch = real }
}

test('TWITTER COUNTS pool_unused WHEN X_ACCOUNTS IS SET AND THE WALL STILL HELD', async () => {
  /**
   * THE DEFECT THIS PREVENTS IS A SILENT STAGING GAP. X_ACCOUNTS can be filled today and the Worker-side
   * GraphQL call that would spend it is a later phase, so the gated tweet stays a 🔞 card — and without
   * a counter an operator has no way to tell "my accounts are dead" from "the code does not read them
   * yet". The predicate this replaced (`credentialSeamArmed`) was written for exactly this and was
   * called from nowhere, which made it visible to nobody.
   *
   * A bare TweetTombstone on the syndication path is the MEASURED age-wall shape (recon 2026-07-19);
   * the guest path is stubbed to the same body, which it cannot read, so the gate defaults to age —
   * the documented behaviour, and the state a real gated tweet arrives in.
   */
  const { liveFetchPost } = await import('../src/worker.ts')
  const gated = { __typename: 'TweetTombstone' }

  const withPool = countingEnv({ X_ACCOUNTS: pool({ label: 'x1', auth_token: 'AUTH-FIXTURE', ct0: 'CT0-FIXTURE' }) })
  await offline(gated, () => liveFetchPost({ p: 'x', id: '1000000000000000001' }, withPool, 'discord'))
  assert.deepEqual(outcomes(withPool, 'x').sort(), ['age_restricted', 'pool_unused'],
    'the gate AND the unused pool, as two distinct points — folding them would blunt the age rate')

  const noPool = countingEnv()
  await offline(gated, () => liveFetchPost({ p: 'x', id: '1000000000000000002' }, noPool, 'discord'))
  assert.deepEqual(outcomes(noPool, 'x'), ['age_restricted'],
    'no pool, no pool_unused — the counter means "configured and still walled", not "walled"')

  // A pool of the WRONG SHAPE is not a configured pool. auth_token without ct0 cannot make the
  // logged-in call, so reporting a staging gap for it would send an operator looking for the wrong bug.
  const halfPool = countingEnv({ X_ACCOUNTS: pool({ label: 'half', auth_token: 'AUTH-FIXTURE' }) })
  await offline(gated, () => liveFetchPost({ p: 'x', id: '1000000000000000003' }, halfPool, 'discord'))
  assert.deepEqual(outcomes(halfPool, 'x'), ['age_restricted'], 'half an account is not an account')
})

test('YOUTUBE COUNTS pool_unused WHEN THE JAR WAS SENT AND age_limit CAME BACK ANYWAY', async () => {
  /**
   * THE ONE ARM WHERE THIS IS A REAL FAULT rather than a staging note: a positive `ageLimit` on a
   * readable record means the LOGGED-IN extract still saw a wall, so the accounts are signed out,
   * rate-limited or flagged. That is a rotation somebody has to perform, and it is invisible from the
   * card — which keeps rendering the honest 🔞 note either way.
   *
   * REWRITTEN 2026-08-03, and the seeded record is the change. This test used to seed
   * `{timestamp, ageLimit}` with no provenance and assert the counter fired, on the strength of a
   * docstring that said "since the generation bump every readable record was produced by a call that
   * carried the jar". That was true of records written before the g10 DEPLOY and false of the ones
   * written between that deploy and the day a secret is filled — which is most of them, since no pool
   * has ever been filled. So the old shape of this test asserted the counter fires on exactly the
   * records that prove nothing, i.e. it pinned the fill-day false alarm as correct behaviour: an
   * operator fills a pool, sees `pool_unused` climb, reads docs/CREDENTIALS.md, and burns fresh
   * throwaway accounts chasing a cache. The fourth case below is the one that was missing.
   */
  const run = async (secrets, id, record) => {
    const ref = { p: 'yt', id }
    const env = countingEnv(secrets, {
      MEDIA_CACHE: fakeR2([[metaCacheKey(ref), JSON.stringify({ timestamp: 1256453853, ...record })]]),
    })
    await offline({ title: 't', author_name: 'a', author_url: 'https://www.youtube.com/@a' },
      () => import('../src/worker.ts').then(m => m.liveFetchPost(ref, env, 'discord')))
    return outcomes(env, 'yt')
  }
  const YT = { YT_ACCOUNTS: pool({ cookies: COOKIE }) }
  assert.ok((await run(YT, 'JARyt000004', { ageLimit: 18, jarred: true })).includes('pool_unused'),
    'the jar was spent and the wall held anyway = the signal')
  assert.ok(!(await run({}, 'JARyt000005', { ageLimit: 18, jarred: true })).includes('pool_unused'),
    'no pool, no signal — an age-gated video with no accounts configured is expected, not a fault')
  assert.ok(!(await run(YT, 'JARyt000006', { ageLimit: 0, jarred: true })).includes('pool_unused'),
    'an UNGATED video must not count — the counter would drown in ordinary traffic')
  assert.ok(!(await run(YT, 'JARyt000007', { ageLimit: 18 })).includes('pool_unused'),
    'AND a gated record with no jar behind it must not count on fill-day: nothing has asked this '
    + 'question with a credential yet, so reporting the accounts as dead would be a guess')
})

test('INSTAGRAM COUNTS pool_unused ON THE AGE WALL, and the counter says LESS than it looks like it says', async () => {
  /**
   * WHAT IT MEANS HERE, written down because the honest reading is narrower than the other two arms'
   * and reading it wrong would send somebody rotating healthy accounts. IG_ACCOUNTS is spent in the
   * CONTAINER (the copyright-remux mux); this gate is `failure_reason":"MA"` read off Instagram's
   * answer to the WORKER's own page fetch, which carries no jar. So the count is not evidence the
   * accounts are dead — it is evidence that somebody with accounts configured is still being walled,
   * i.e. that the credential is not reaching the request that needs it.
   *
   * Driven through the real dispatcher against the REAL captured page (the 25+ account reported
   * 2026-07-28), because the arm is reached only after the embed surface fails AND the full page
   * yields no card — a stub of the gate function alone could not witness that ordering.
   */
  const { liveFetchPost } = await import('../src/worker.ts')
  const AGE_GATED = readFileSync(new URL('./fixtures/instagram-fullpage-agegated.html', import.meta.url), 'utf8')

  const withPool = countingEnv({ IG_ACCOUNTS: pool({ label: 'ig1', cookies: COOKIE }) })
  await offline(AGE_GATED, () => liveFetchPost({ p: 'ig', kind: 'post', code: 'DZFDtEhoNPy' }, withPool, 'discord'))
  const got = outcomes(withPool, 'ig')
  assert.ok(got.includes('age_restricted'), 'the gate is still counted exactly once, unchanged')
  assert.ok(got.includes('pool_unused'), 'and the configured-but-still-walled pool alongside it')

  const noPool = countingEnv()
  await offline(AGE_GATED, () => liveFetchPost({ p: 'ig', kind: 'post', code: 'DZPWDqmIIld' }, noPool, 'discord'))
  assert.ok(!outcomes(noPool, 'ig').includes('pool_unused'),
    'an age wall with no accounts configured is the expected answer, not a fault to alert on')
})

test('NO COUNTER, ANYWHERE, EVER CARRIES THE CREDENTIAL ITSELF', async () => {
  /**
   * THE PROPERTY THAT CANNOT BE RECOVERED AFTER IT IS BROKEN. `count()` takes fixed enum strings by
   * design, but the defect this guards is one edit away — someone adds the account `label` "so we can
   * see which one died", and the next person adds the token "so we can see whether it is the right
   * one". An analytics blob is written to a store this project does not control and cannot redact.
   *
   * Asserted over the WHOLE data point rather than over the outcome field, and against the dummy
   * values themselves: any future field that ships a credential fails this regardless of what it is
   * called.
   */
  const { liveFetchPost } = await import('../src/worker.ts')
  const env = countingEnv(ALL_THREE)
  await offline({ __typename: 'TweetTombstone' },
    () => liveFetchPost({ p: 'x', id: '1000000000000000004' }, env, 'discord'))
  assert.ok(env.points.length > 0, 'the request really did emit counters — an empty list proves nothing')
  const serialized = JSON.stringify(env.points)
  for (const secret of ['COOKIE-FIXTURE', 'AUTH-FIXTURE', 'CT0-FIXTURE', 'Netscape']) {
    assert.ok(!serialized.includes(secret), `a credential reached an analytics blob (${secret})`)
  }
})

test('THE META CACHE KEY IS SCOPED BY META_GENERATION — a pre-cookie record is invisible, and the DO name is not what decides it', () => {
  /**
   * WHY THE GENERATION HAD TO MOVE FOR THE COOKIE CHANGE, expressed as the thing that would break
   * without it. Every warm meta record in R2 was produced by a container call that sent NO cookies, so
   * a gated video's record says `age_limit: 18` and no jar can change that answer for the 30 days the
   * record lives. Renaming the key is the single documented invalidation switch for the answers we
   * kept.
   *
   * REWRITTEN 2026-08-29 FOR THE SPLIT, not deleted, because what it guards is real and unchanged: the
   * key must carry a generation, it must be one generation across every platform in the bucket, and g9
   * must stay unreadable forever. What moved is WHICH constant supplies the segment. `metaCacheKey`
   * used to interpolate RESOLVER_GENERATION, which also names the Durable Objects — so a bump aimed at
   * evicting a broken container instance emptied this cache too, five times in 27 days against a
   * 30-day TTL that was never once reached. Now it interpolates META_GENERATION.
   *
   * THE OLD GENERATION IS NAMED LITERALLY, and that is the point rather than brittleness: this test
   * says "g9 records must not be readable", which stays true forever. It must NOT pin the current
   * generation, which is expected to move again — so the current one is asserted to BE META_GENERATION
   * rather than to be any particular string.
   */
  const ref = { p: 'yt', id: 'M7lc1UVf-VE' }
  const key = metaCacheKey(ref)
  assert.match(key, /^meta\/g\d+\/yt:M7lc1UVf-VE\.json$/, 'still generation-scoped and namespaced by refKey')
  assert.equal(key, `meta/${META_GENERATION}/yt:M7lc1UVf-VE.json`, 'and the segment is META_GENERATION')
  assert.ok(!key.startsWith('meta/g9/'),
    'the cookie jar changed what the container returns for a gated id, so every pre-cookie record ' +
    'must be unreadable — a bump that did not happen is a month of 🔞 cards a filled pool cannot fix')

  // ONE GENERATION ACROSS THE WHOLE BUCKET. Every record here is a container answer of the same
  // vintage, and a per-platform generation would be five things to keep in step instead of one — the
  // yt-dlp tier's four platforms share a code path with Facebook and would drift silently.
  const gen = key.split('/')[1]
  for (const other of [
    { p: 'fb', kind: 'watch', id: 'x' }, { p: 'dm', id: 'xabcde' },
    { p: 'st', id: 'st0001' }, { p: 'im', kind: 'post', id: 'im0001' },
  ]) {
    assert.equal(metaCacheKey(other).split('/')[1], gen, `${other.p} shares the one generation`)
  }

  /**
   * THE DECOUPLING ITSELF, and it cannot be asserted on the key's VALUE. META_GENERATION and
   * RESOLVER_GENERATION both hold 'g13' — the split was pinned at the shared value on purpose, so that
   * splitting them invalidated nothing — which means every string this function returns is byte-identical
   * either way and no comparison can tell which constant produced it. The function's own source can.
   *
   * The failure this catches is the whole point of the change: someone re-couples the meta key to the
   * DO name (or writes a third call site that does), the two constants drift on the next container
   * incident, and 30 days of dates, descriptions, durations, counts and gate verdicts across five
   * platforms are thrown away to reboot a container. Silent, unfixable by re-pasting, and the reason
   * production reads "9/10 correct on first paste".
   */
  const src = metaCacheKey.toString()
  assert.match(src, /META_GENERATION/, 'metaCacheKey reads META_GENERATION')
  assert.doesNotMatch(src, /RESOLVER_GENERATION/,
    'and NOT the constant that names the container instances — bumping that must leave every stored ' +
    'record readable, because evicting a bad instance says nothing about whether a record is wrong')
})

test('A META_GENERATION BUMP IS THE ONLY THING THAT THROWS THE RECORDS AWAY, and the mux bytes survive both', async () => {
  /**
   * THE TWO DIRECTIONS, behaviourally, through the real read path rather than off the key string.
   *
   * Records are seeded at HAND-BUILT keys, never through `metaCacheKey`, because a test that builds
   * its fixture with the function under test passes no matter what that function returns. The keys
   * here are what an object in the live bucket actually looks like the morning after a bump.
   *
   * WHY THERE IS NO "BUMP RESOLVER_GENERATION AND SEE" ARM: the constants are module-level and cannot
   * be moved from a test. The property is proved as a conjunction instead — `metaCacheKey` contains no
   * reference to RESOLVER_GENERATION (asserted above, on the function's source, for the reason given
   * there), and the record under the CURRENT META_GENERATION hits (asserted here). A string that does
   * not mention the constant cannot change when the constant does.
   */
  const TS = 1256453853
  const nextGen = `g${Number(META_GENERATION.slice(1)) + 1}`
  const datedFrom = async (id, keyFor) => {
    const ref = { p: 'yt', id }
    const env = countingEnv({}, {
      MEDIA_CACHE: fakeR2([[keyFor(ref), JSON.stringify({ timestamp: TS })]]),
    })
    const post = await offline(
      { title: 't', author_name: 'a', author_url: 'https://www.youtube.com/@a' },
      () => import('../src/worker.ts').then(m => m.liveFetchPost(ref, env, 'discord')))
    return post.createdAt.getTime()
  }

  assert.equal(await datedFrom('GENkey000001', r => `meta/${META_GENERATION}/${refKey(r)}.json`), TS * 1000,
    'a record under the CURRENT meta generation is read — this is the state a RESOLVER_GENERATION bump ' +
    'leaves behind, because it renames the Durable Objects and touches no key in R2')
  assert.equal(await datedFrom('GENkey000002', r => `meta/${nextGen}/${refKey(r)}.json`), 0,
    'a record under a DIFFERENT meta generation is invisible — which is what a META_GENERATION bump ' +
    'does to every record already written, and the cost the split exists to stop paying by accident')
  assert.equal(await datedFrom('GENkey000003', r => `meta/${refKey(r)}.json`), 0,
    'and an ungenerationed key — the pre-g3 shape — stays unreadable')

  /**
   * PLAYBACK IS UNTOUCHED BY EITHER CONSTANT, which is worth a test rather than a comment because two
   * separate analyses of the generation churn assumed a bump cost muxed video. `mux/{refKey}/{index}`
   * has no generation segment at all: this seeds the key WITHOUT one and the /_media/ route serves it
   * warm, so no bump can orphan a muxed mp4 or make one re-mux.
   */
  const muxRef = { p: 'yt', id: 'GENkey000004' }
  const page = `https://www.youtube.com/watch?v=${muxRef.id}`
  const { bodies, binding } = fakeResolver()
  const r2 = fakeR2([[`mux/${refKey(muxRef)}/0`, 'MP4']])
  const res = await handle(mediaReq(muxRef), envWith(binding, r2), ctx,
    { cache: fakeCache(), fetchPost: async () => remuxPost(muxRef, page) })
  assert.equal(res.status, 200, 'the generation-free mux key is served')
  assert.equal(await res.text(), 'MP4', 'and it is the bytes that were already there')
  assert.equal(bodies.length, 0, 'no container call — a bump cannot make a muxed video re-mux')
})

test('THE FILES THIS FEATURE MAKES SOMEBODY DOWNLOAD ARE GITIGNORED — .dev.vars matched none of them', () => {
  /**
   * THE FOOTGUN THIS FEATURE INTRODUCED. Filling the pools requires exporting a cookies.txt from a
   * logged-in browser, saving it, and pasting its contents into `wrangler secret put`. Every step ends
   * with a live session in a file, and the obvious place to save one is whatever directory the terminal
   * is already in — which is the repo.
   *
   * `.dev.vars`, `.env` and `.env.*` were already ignored and matched NONE of these names. A leaked jar
   * is not a config value: it is a bearer credential that works from anywhere until the session is
   * revoked, and it cannot be rotated by changing a password somebody would notice.
   *
   * Asserted through `git check-ignore` rather than by reading .gitignore for a substring, because a
   * pattern that LOOKS right is exactly the trap the file's own comments describe — `cookies.txt` at the
   * root and `container/cookies.txt` are the same mistake, and the second is likelier.
   */
  const ignored = p => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', p], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  for (const p of [
    'cookies.txt', 'container/cookies.txt', 'yt-cookies.txt', 'ig-cookies.txt',
    'accounts.json', 'src/accounts.json', 'secrets.json', 'alt1.cookies', 'cookies-alt1.json',
  ]) {
    assert.ok(ignored(p), `${p} holds a live session and must never be committable`)
  }
  // And the example must stay committable, or it stops being an example.
  assert.equal(ignored('accounts.example.json'), false, 'the invented-value example is not a secret')
})

test('THE COMMITTED EXAMPLE IS A POOL THE CODE ACTUALLY ACCEPTS, and carries no real-looking value', () => {
  /**
   * An example that does not parse teaches the wrong shape, and it rots silently: nothing else reads
   * this file, so a change to parseAccounts or to the documented shape would leave it quietly wrong
   * while still looking authoritative. docs/CREDENTIALS.md points at it by name.
   *
   * The second assertion is the one that matters more. A worked example is the single likeliest place
   * for a real credential to get committed by someone "just filling it in to test" — so the values are
   * pinned as obviously invented, and this fails if they ever stop being.
   */
  const raw = _rf('accounts.example.json', 'utf8')
  const pool = parseAccounts(raw)
  assert.equal(pool.length, 2, 'it must show a POOL, since picking at random is the whole design')
  assert.ok(pool.every(a => a.label), 'every entry is labelled — the only field safe to log')
  assert.ok(pool.every(a => a.cookies?.startsWith('# Netscape')), 'and carries a Netscape-shaped jar')
  for (const a of pool) {
    assert.match(a.cookies, /EXAMPLE-NOT-A-REAL-VALUE/,
      'example cookie values must be self-evidently fake')
  }
})
