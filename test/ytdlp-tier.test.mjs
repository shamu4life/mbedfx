import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
import { normalizeYtdlp } from '../src/platforms/ytdlp/normalize.ts'
import { normalizeDailymotion } from '../src/platforms/dailymotion/normalize.ts'
import { normalizeStreamable } from '../src/platforms/streamable/normalize.ts'
import { normalizeImgur } from '../src/platforms/imgur/normalize.ts'

/**
 * THE yt-dlp TIER — Dailymotion, Streamable and Imgur.
 *
 * THE FIXTURES ARE REAL BYTES, TWICE OVER. Each `test/fixtures/*.json` here was produced by running
 * the REAL `container/server.py:_meta_page` over a REAL `yt-dlp -J` capture of the live page
 * (2026-07-26, yt-dlp 2026.07.04) with only the subprocess stubbed out — so they are exactly what the
 * container returns, including the `_type` field and the width/height "capped or sized" formats
 * fallback that recovers Imgur's 916x390 from a dict whose top-level dimensions are null.
 *
 * TWO HALVES, deliberately, and the split is the one facebook-meta.test.mjs argues for: the pure
 * normalizer is total over junk on its own, and the END-TO-END path is exercised through the real
 * dispatcher because the snake_case container dict is mapped to camelCase in worker.ts — a unit test
 * on either half alone cannot see a field dropped at that seam.
 */

const fixture = name => readFileSync(`test/fixtures/${name}`, 'utf8')
const DM_META = JSON.parse(fixture('dailymotion-video.json'))
const ST_META = JSON.parse(fixture('streamable-video.json'))
const IM_META = JSON.parse(fixture('imgur-gifv.json'))
const IM_ALBUM = JSON.parse(fixture('imgur-album.json'))

// ── The container's own argv. Cheap, and it is the ONE regression that silently un-ships Imgur.

test('the container match filter admits a duration-less source and still rejects live + long ones', () => {
  const py = readFileSync('container/server.py', 'utf8')
  // ON THE ARGV, NOT THE FILE. The comments beside it QUOTE the old filter verbatim as the evidence
  // for the change (house style: cite the measurement), so a whole-file substring search for the old
  // form would fail on its own documentation.
  const filters = [...py.matchAll(/"--match-filter",\s*f"([^"]*)"/g)].map(m => m[1])
  assert.deepEqual(filters, ['duration<?{MAX_SECONDS} & !is_live'],
    'the ONE match filter the muxer ships. `<?` is yt-dlp\'s none-inclusive comparison, and it is what ' +
    'lets an Imgur gifv through at all: the old `duration < 1200 & duration > 0` answered "does not pass ' +
    'filter … skipping .." on every source declaring no duration (reproduced 2026-07-26 on ' +
    'i.imgur.com/A61SaA1.gifv). `!is_live` replaces the livestream rejection that lower bound was ' +
    'providing by accident — without it a live source downloads until PROC_TIMEOUT and burns a slot.')
  assert.ok(/"_type": d\.get\("_type"\)/.test(py),
    '_type is the only field that tells a video from a playlist; the title assertion passes on an album')
})

// ── The pure half.

const DM_REF = { p: 'dm', id: 'xaqwy7q' }
const ST_REF = { p: 'st', id: 'moo' }
const IM_REF = { p: 'im', kind: 'post', id: 'A61SaA1' }
const SITE = { name: 'Site', handle: 'site', home: 'https://site.example' }

test('normalizeYtdlp is TOTAL — junk, a playlist and a title-less extract all return null, never throw', () => {
  const junk = [
    null, undefined, 42, 'nope', [], {}, { title: '' }, { title: 42 }, { title: null },
    // A PLAYLIST. It carries a real title and nothing else, so the "title is non-empty" content
    // assertion PASSES on it — _type is the only thing that can refuse it.
    { title: 'enen-no-shouboutai', type: 'playlist' },
  ]
  for (const bad of junk) {
    assert.equal(normalizeYtdlp(bad, DM_REF, SITE, 'https://p'), null, `${JSON.stringify(bad)} is not a card`)
  }
  // An ABSENT _type is a pre-g5 pooled instance, which must DEGRADE to the old behaviour, not fail.
  assert.ok(normalizeYtdlp({ title: 't' }, DM_REF, SITE, 'https://p'), 'a pre-g5 dict still renders')
})

test('normalizeYtdlp degrades each optional field independently and never emits a half-known size', () => {
  const post = normalizeYtdlp(
    { title: 't', w: 916, h: 0, duration: 0, poster: 'ftp://nope', uploaderUrl: 'javascript:x' },
    DM_REF, SITE, 'https://p',
  )
  assert.deepEqual([post.media[0].w, post.media[0].h], [0, 0], 'BOTH or NEITHER — a half-known pair is unusable')
  assert.ok(!('duration' in post.media[0]), 'a zero duration is omitted, not shipped as 0')
  assert.ok(!('poster' in post.media[0]), 'a non-http poster is dropped rather than emitted')
  assert.equal(post.author.url, SITE.home, 'a non-http uploader url falls back to the platform home')
  assert.equal(post.createdAt.getTime(), 0, 'no timestamp keeps the epoch fallback')
  assert.doesNotThrow(() => post.createdAt.toISOString(), 'never an Invalid Date on the response path')
})

test('A JUNK OR OUT-OF-RANGE timestamp can NEVER become an Invalid Date — it 500s the activity route', () => {
  /**
   * `new Date(meta.timestamp * 1000)` behind a Number.isFinite guard is NOT total, and the gap is not
   * academic. isFinite admits 1e13; 1e13 seconds is 1e16 ms; Date's range is ±8.64e15 ms; so the result
   * is an INVALID DATE, and render/mastodon.ts's `post.createdAt.toISOString()` throws RangeError on it
   * — uncaught, on the public /users/{h}/statuses/{id} route, out of a function whose own docstring
   * promises it is TOTAL. The value is whatever the extracted page declared, so it is not ours.
   *
   * The guard is the SAME one YouTube's date already used (platforms/uploaddate.ts), not a second
   * implementation of the same rule — a second range check is a second chance to get the range wrong,
   * and the symptom is a crashed response rather than a wrong date.
   */
  const junk = [
    NaN, Infinity, -Infinity, 1e13, -1e13, 1e308, -1e308, 8.64e15, Number.MAX_SAFE_INTEGER,
    0, -1, 1, 4102444800000,           // epoch-0, negative, and ms-read-as-seconds
    '2009-10-25T06:57:33Z', 'yesterday', '', null, undefined, {}, [], true, () => 1,
  ]
  for (const timestamp of junk) {
    const post = normalizeYtdlp({ title: 't', timestamp }, DM_REF, SITE, 'https://p')
    assert.ok(post, `${String(timestamp)} must still produce a card`)
    assert.doesNotThrow(() => post.createdAt.toISOString(),
      `${String(timestamp)} must never reach the response path as an Invalid Date`)
  }
  // The out-of-range ones fall back to the epoch rather than rendering a year-131971 card...
  assert.equal(normalizeYtdlp({ title: 't', timestamp: 4102444800000 }, DM_REF, SITE, 'https://p')
    .createdAt.toISOString(), '1970-01-01T00:00:00.000Z')
  // ...and a REAL one still renders to the second (dQw4w9WgXcQ's captured `yt-dlp -J` timestamp).
  assert.equal(normalizeYtdlp({ title: 't', timestamp: 1256453853 }, DM_REF, SITE, 'https://p')
    .createdAt.toISOString(), '2009-10-25T06:57:33.000Z')
})

test('each normalizer refuses a foreign ref — the platform half of the pair', () => {
  assert.equal(normalizeDailymotion({ title: 't' }, ST_REF), null)
  assert.equal(normalizeStreamable({ title: 't' }, IM_REF), null)
  assert.equal(normalizeImgur({ title: 't' }, DM_REF), null)
  assert.equal(normalizeDailymotion({ title: 't' }, { p: 'yt', id: 'dQw4w9WgXcQ' }), null)
  // And each claims its own, building the canonical from the ref alone.
  assert.equal(normalizeDailymotion({ title: 't' }, DM_REF).canonical, 'https://www.dailymotion.com/video/xaqwy7q')
  assert.equal(normalizeStreamable({ title: 't' }, ST_REF).canonical, 'https://streamable.com/moo')
  assert.equal(normalizeImgur({ title: 't' }, IM_REF).canonical, 'https://i.imgur.com/A61SaA1.gifv')
})

test('STREAMABLE HAS NO AUTHOR AT ALL — the byline is a real name, never an empty one', () => {
  // Measured 2026-07-26: uploader, uploader_id and uploader_url are ALL null on streamable.com/moo. An
  // author whose name is '' renders as a blank line above the title, so the fallback must be a word.
  const post = normalizeStreamable({ title: 'me irl', uploader: '   ' }, ST_REF)
  assert.equal(post.author.name, 'Streamable')
  assert.equal(post.author.handle, 'streamable')
  assert.equal(post.author.url, 'https://streamable.com')
})

// ── The end-to-end half: the REAL container dict through the REAL dispatcher.

const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
function fakeR2() {
  const store = new Map()
  return {
    store,
    async head() { return { size: 4494401 } },   // the mux is always warm: this file is about metadata
    async get(k) {
      const v = store.get(k)
      return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null
    },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(await new Response(body).arrayBuffer())) },
  }
}
/**
 * `hold` is an optional promise the META call waits on before answering — the only way to observe a
 * BURST, because without it the first extract finishes before the second request has started and
 * "one call" would be proved by the R2 cache rather than by the in-flight dedupe under test.
 */
function fakeResolver(metaJson, hold) {
  const seen = { meta: 0, pages: [], names: [] }
  return {
    seen,
    binding: {
      getByName(name) {
        seen.names.push(name)
        return {
          async fetch(_url, init) {
            const body = JSON.parse(init.body)
            if (body.meta !== true) return new Response('MP4', { headers: { 'content-type': 'video/mp4', 'content-length': '3' } })
            seen.meta++
            seen.pages.push(body.page)
            if (hold) await hold
            return Response.json(metaJson)
          },
        }
      },
    },
  }
}
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const req = path => new Request(`https://staging.megapenispoopenfarten.sex${path}`, { headers: { 'user-agent': DISCORD } })
const envWith = (resolver, r2 = fakeR2()) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: resolver, MEDIA_CACHE: r2,
})
const deps = () => ({
  cache: fakeCache(),
  fetchPost: undefined,   // replaced below — the real liveFetchPost is what we are exercising
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})
const liveDeps = async () => {
  const { liveFetchPost } = await import('../src/worker.ts')
  return { ...deps(), fetchPost: liveFetchPost }
}

/**
 * REWRITTEN 2026-08-03, because this test pinned a card that could not work.
 *
 * WHAT IT USED TO ASSERT: `og:video:width 544`, `og:video:height 960`, and an `og:video` pointing at
 * `/_media/dm%3Axaqwy7q/0`. WHAT THE FIXTURE SAYS: `"duration": 4830` — 80.5 minutes, against
 * MUX_MAX_SECONDS 1500. The container refuses anything over that with its own match filter (see the
 * argv test at the top of this file), so those bytes can never exist and that url is a permanent 503.
 * The test was asserting that the card promises a player nobody can ever play, which is the exact
 * defect serveMuxed's 503 rule exists to contain rather than something to pin.
 *
 * WHAT CHANGED IN THE CODE: settleMux's over-ceiling arm always built the poster still, but the
 * rewritten media array was discarded unless something ELSE on the post degraded — so the remux video
 * survived and both heads went on advertising it. The arm's result is now applied.
 *
 * WHAT THIS TEST ASSERTS INSTEAD: the same thing it always meant to — that the real container dict
 * reaches the reader. Creator, caption and the no-raw-CDN rule are unchanged; the DIMENSIONS and the
 * DATE simply had to move to the document that actually carries them for a post with media. Discord
 * reads the Mastodon spoof there and the og head deliberately ships no og:image (see discord.ts), so
 * asserting a picture on the head would be asserting against the design.
 *
 * NOT A PLATFORM-WIDE CHANGE: Streamable's fixture is 12s and Imgur's declares none, so both keep
 * their og:video and their test below is the control that says so.
 */
test('DAILYMOTION: the real container dict reaches the card — creator, caption, dimensions, date', async () => {
  const { seen, binding } = fakeResolver(DM_META)
  const env = envWith(binding)
  const d = await liveDeps()
  const html = await (await handle(req('/video/xaqwy7q'), env, ctx, d)).text()
  assert.equal(seen.pages[0], 'https://www.dailymotion.com/video/xaqwy7q', 'the page comes from the ref alone')
  assert.match(html, /og:title" content="Winter\.Desire \(@Winter\.Desire\)"/, 'the real uploader, not the byline')
  assert.match(html, /og:description" content="Zero to Alpha: Return of the Wolf King"/)
  assert.ok(!html.includes('dmcdn.net'), 'no raw CDN url leaks into the head')

  // THE SAME env AND deps, so this is the warm post the callback really re-derives rather than a
  // second independent extract that could disagree with the head.
  const link = html.match(/activity\+json" href="([^"]+)"/)
  assert.ok(link, 'a post with media must advertise the spoof — it is where its picture lives')
  const j = await (await handle(new Request(link[1], { headers: { 'user-agent': DISCORD } }), env, ctx, d)).json()

  assert.equal(j.account.display_name, 'Winter.Desire', 'the uploader survives the seam')
  // timestamp 1784619335, straight off the container dict — the field the test name has always
  // claimed and nothing actually checked.
  assert.equal(String(j.created_at), '2026-07-21T07:35:35.000Z')
  assert.equal(j.media_attachments[0].meta.original.size, '544x960', 'the dimensions, on the seam that draws them')
})

test('A VIDEO OVER THE MUX CEILING SHIPS ITS STILL, NOT A PLAYER THAT CAN NEVER EXIST', async () => {
  /**
   * THE RULE THE REWRITE ABOVE IS ABOUT, stated on its own so it cannot be lost inside a test named
   * for something else. 4830s against MUX_MAX_SECONDS 1500: no mux is dispatched (the duration is
   * already in the meta record, so paying a full deadline to be refused buys nothing), the entry
   * becomes its poster still, and the card is left CACHEABLE — this verdict is permanent, unlike an
   * unfinished mux, so `degraded` stays false and /_card reports muxing:false. See test/card-muxing.
   *
   * THE PICTURE MUST STILL REACH THE READER, which is the half worth measuring rather than assuming:
   * a degrade that silently produced a card with no image anywhere would be a worse bug than the dead
   * player it replaced. Verified end to end here — the attachment is an IMAGE, it is addressed at the
   * `poster0` slot (bytesIndex moves a `posterOnly` still off the video slot, which answers 503 by
   * design), it carries `meta.original` (Discord draws NOTHING for an unsized image attachment), and
   * the slot really 302s to the thumbnail the container reported.
   */
  const { binding } = fakeResolver(DM_META)
  const env = envWith(binding)
  const d = await liveDeps()
  const html = await (await handle(req('/video/xaqwy7q'), env, ctx, d)).text()

  assert.doesNotMatch(html, /og:video/, 'no player is promised, at any spelling')
  assert.doesNotMatch(html, new RegExp(`/_media/${encodeURIComponent(refKey(DM_REF))}/0`),
    'and nothing on the head names the video slot, which is a permanent 503 for this duration')

  const link = html.match(/activity\+json" href="([^"]+)"/)[1]
  const j = await (await handle(new Request(link, { headers: { 'user-agent': DISCORD } }), env, ctx, d)).json()
  assert.equal(j.media_attachments.length, 1)
  const [a] = j.media_attachments
  assert.equal(a.type, 'image', 'the still, never a dead player')
  assert.match(a.url, new RegExp(`/_media/${encodeURIComponent(refKey(DM_REF))}/poster0$`))
  assert.equal(a.preview_url, a.url, 'both keys, or Discord picks the one that was left behind')
  assert.ok(a.meta && a.meta.original, 'an image attachment with no size renders as no picture at all')

  // The last hop, because every url above is only a promise until something serves it.
  const hop = await handle(new Request(a.url, { headers: { 'user-agent': DISCORD } }), env, ctx, d)
  assert.equal(hop.status, 302, 'the poster slot resolves')
  assert.equal(hop.headers.get('location'), 'https://s1.dmcdn.net/v/cl3Ss1gPDqxVwKrv7/x1080',
    'to the thumbnail the container reported — which is why the head is allowed to carry no CDN url')
})

test('STREAMABLE: no uploader anywhere, so the card carries the platform byline and still plays', async () => {
  const { seen, binding } = fakeResolver(ST_META)
  const html = await (await handle(req('/e/moo'), envWith(binding), ctx, await liveDeps())).text()
  assert.equal(seen.pages[0], 'https://streamable.com/moo')
  assert.match(html, /og:title" content="Streamable \(@streamable\)"/)
  assert.match(html, /og:description" content="me irl"/, 'no description upstream -> the title is the body')
  assert.match(html, /og:video:width" content="852"/)
  assert.match(html, new RegExp(`og:video" content="[^"]*/_media/${encodeURIComponent(refKey(ST_REF))}/0`))
})

/**
 * Imgur now asks its own API FIRST and only falls back to the container (see worker.ts's `im` arm),
 * so an Imgur test that wants the container path has to make the API miss. Swapping global fetch is
 * also what keeps this suite hermetic: without it these tests reach api.imgur.com for real.
 */
async function withApiDown(fn) {
  const real = globalThis.fetch
  globalThis.fetch = async (u, init) =>
    String(u).startsWith('https://api.imgur.com/')
      ? new Response('{"errors":[]}', { status: 503 })
      : real(u, init)
  try { return await fn() } finally { globalThis.fetch = real }
}

test('IMGUR: the container is still the FALLBACK for a single when the API is down', async () => {
  const { seen, binding } = fakeResolver(IM_META)
  const html = await withApiDown(async () =>
    (await handle(req('/A61SaA1.gifv'), envWith(binding), ctx, await liveDeps())).text())
  assert.equal(seen.pages[0], 'https://i.imgur.com/A61SaA1.gifv', 'always the .gifv page — the only VIDEO surface')
  assert.match(html, /og:title" content="Imgur \(@imgur\)"/)
  assert.match(html, /og:description" content="MRW gifv is up and running without any bugs"/)
  assert.match(html, /og:video:width" content="916"/)
  assert.match(html, /og:video:height" content="390"/)
})

test('AN IMGUR ALBUM IS A FAILURE CARD, not a title-only one — the whole reason _type was added', async () => {
  /**
   * imgur.com/a/iX265HX returns _type='playlist' with a REAL title and nothing else: no thumbnail, no
   * dimensions, no duration, no timestamp. The Worker's content assertion is "title is a non-empty
   * string", which that PASSES — so before _type existed this shipped as a bare headline over a video
   * url resolving to nothing. It must also never be WRITTEN: a cached playlist would serve that card
   * for a day.
   */
  const r2 = fakeR2()
  const { binding } = fakeResolver(IM_ALBUM)
  const html = await (await handle(req('/im/iX265HX'), envWith(binding, r2), ctx, await liveDeps())).text()
  assert.match(html, /couldn't load/i)
  assert.ok(!html.includes('enen-no-shouboutai'), 'a playlist title must never reach a card')
  assert.equal(r2.store.size, 0, 'and a playlist extract is never cached')
})

test('A yt-dlp-tier post SURVIVES the post cache — serialize/deserialize round-trips its ref', async () => {
  /**
   * cache.ts's hasValidIdentity validates a cached record by round-tripping its ref through
   * refKey -> parseRefKey and comparing shallowly, so a platform added to refKey but NOT to
   * parseRefKey deserializes as null — every read misses, every request re-extracts, and nothing
   * anywhere reports it. A second request costing ZERO container calls is what proves both arms grew.
   */
  const { seen, binding } = fakeResolver(DM_META)
  const env = envWith(binding)
  const d = await liveDeps()
  await handle(req('/video/xaqwy7q'), env, ctx, d)
  const before = seen.meta
  // The ACTIVITY callback, not the same HTML url: it has its own response-cache key, so a hit here
  // can only come from the POST cache — which is the entry that has to deserialize.
  const json = await (await handle(req(`/users/x/statuses/${encodeStatusId(refKey(DM_REF))}`), env, ctx, d)).json()
  assert.equal(seen.meta, before, 'the cached POST must deserialize — a missing parseRefKey arm re-extracts silently')
  assert.equal(json.account.display_name, 'Winter.Desire', 'and it is the same post, not a rebuilt one')
})

test('SLOT AFFINITY: a yt-dlp-tier post\'s meta call and its mux land on ONE container instance', async () => {
  const { seen, binding } = fakeResolver(DM_META)
  await handle(req('/video/xaqwy7q'), envWith(binding), ctx, await liveDeps())
  assert.ok(seen.meta >= 1)
  assert.equal(new Set(seen.names).size, 1, `one ref, one slot: ${[...new Set(seen.names)]}`)
})

test('NO CONTAINER BOUND: the tier fails cleanly rather than 500ing or inventing a card', async () => {
  const env = { AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } }
  const html = await (await handle(req('/video/xaqwy7q'), env, ctx, await liveDeps())).text()
  assert.match(html, /couldn't load/i, 'no container means no metadata source at all on this tier')
})

// ── The container-dispatch bounds. Every call below is reachable by an unauthenticated request.

test('AN OUT-OF-RANGE UPSTREAM TIMESTAMP IS A CARD, NOT A 500, on the activity route', async () => {
  /**
   * The end-to-end half of the Invalid-Date test above, and it is REACHABLE rather than theoretical:
   * resolveYtdlpMeta's own filter is `typeof number && isFinite && > 0`, which 1e13 passes, so the value
   * reaches the normalizer exactly as the container reported it. This route is the one whose output
   * carries `created_at`, i.e. the one that calls toISOString() on it.
   */
  const ref = { p: 'dm', id: 'xrange1' }
  const { binding } = fakeResolver({ ...DM_META, timestamp: 1e13 })
  const res = await handle(req(`/users/x/statuses/${encodeStatusId(refKey(ref))}`), envWith(binding), ctx, await liveDeps())
  assert.equal(res.status, 200, 'an upstream timestamp must never crash a public route')
  const json = await res.json()
  assert.equal(json.created_at, '1970-01-01T00:00:00.000Z', 'and the fallback is the honest epoch')
  assert.equal(json.account.display_name, 'Winter.Desire', 'the rest of the card is unaffected')
})

test('A BURST ON ONE ID IS EXACTLY ONE CONTAINER CALL — metaOnce, not one extract per request', async () => {
  /**
   * The R2 record only dedupes work that has already FINISHED. One paste produces up to three requests
   * within ~2s (the crawler's HTML, its activity callback, the media proxy), and before metaOnce covered
   * this tier each of them started its OWN `yt-dlp -J` on the same pooled instance — a 4-slot pool that
   * one popular link could exhaust by itself. The container is HELD here so every request is in flight at
   * once: without the hold, "one call" would be proved by the R2 write rather than by the dedupe.
   */
  let release
  const hold = new Promise(r => { release = r })
  const { seen, binding } = fakeResolver(DM_META, hold)
  const env = envWith(binding)
  const d = await liveDeps()
  const burst = Array.from({ length: 8 }, () => handle(req('/video/xburst1'), env, ctx, d))
  release()
  const bodies = await Promise.all((await Promise.all(burst)).map(res => res.text()))
  assert.equal(seen.meta, 1, `8 concurrent requests, ONE extract — got ${seen.meta}`)
  for (const html of bodies) assert.match(html, /og:title" content="Winter\.Desire/, 'and each still gets the card')
})

test('A FAILING ID IS NOT A FREE CONTAINER TRIGGER — the negative cache', async () => {
  /**
   * NOTHING ABOUT A FAILING ID IS CACHED ANYWHERE ELSE: getPost caches only a non-null Post and
   * renderPostRoute caches only a non-degraded response, so before this every single request for one
   * unroutable id re-dispatched `yt-dlp -J` against a page the requester chose. `/e/{2-16 alnum}` is
   * cheap to enumerate, and this tier has no second upstream that could vouch for an id first (the
   * container IS its only source), so nothing else closes the loop — see worker.ts's metaRecentlyFailed
   * for why the window is short, and why a TIMEOUT deliberately does not mark.
   */
  const { seen, binding } = fakeResolver({ title: '' })   // the container answers, with nothing usable
  const env = envWith(binding)
  const d = await liveDeps()
  for (let i = 0; i < 6; i++) {
    const html = await (await handle(req('/video/xfail01'), env, ctx, d)).text()
    assert.match(html, /couldn't load/i, 'and every attempt is still answered honestly')
  }
  assert.equal(seen.meta, 1, `6 requests for one dead id must cost ONE extract, not 6 — got ${seen.meta}`)
})

test('A FLOOD OF DISTINCT IDS IS CAPPED — the bound the other two do not cover', async () => {
  /**
   * Rotating the id defeats both the dedupe and the negative cache, and that is the case that actually
   * saturates the pool: RESOLVER_SLOTS is 4, an instance lingers ~10min, and "Maximum number of running
   * container instances exceeded" degrades EVERY platform's card to a video-less still.
   * SPECULATIVE_META_CAP is the isolate-local bound on DISTINCT extracts in flight — the same constant,
   * and now the same gate, the YouTube date path uses, because they share one four-slot pool.
   *
   * THE TRADE, stated where it is paid: a refused request renders the generic failure. It is not cached
   * (neither the null Post nor the response), so a real post caught by the cap is right again on the very
   * next unfurl, and reaching it at all takes SPECULATIVE_META_CAP+1 DISTINCT tier ids on ONE isolate at
   * one instant.
   */
  let release
  const hold = new Promise(r => { release = r })
  const { seen, binding } = fakeResolver(DM_META, hold)
  const env = envWith(binding)
  const d = await liveDeps()
  const ids = ['xflood1', 'xflood2', 'xflood3', 'xflood4', 'xflood5', 'xflood6', 'xflood7', 'xflood8']
  const flood = ids.map(id => handle(req(`/video/${id}`), env, ctx, d))
  release()
  await Promise.all(flood)
  assert.ok(seen.meta >= 1, 'the cap must not refuse everything')
  assert.ok(seen.meta <= 2, `8 distinct ids at once must not dispatch 8 extracts — got ${seen.meta}`)
})

test('AN R2 WRITE FAILURE IS A CACHING PROBLEM, NOT AN EXTRACTION VERDICT', async () => {
  /**
   * metaWork used to end in a blanket `.catch(() => null)`, which folded a failed MEDIA_CACHE.put into
   * the SAME null a gone page produces. So a container call that extracted the card PERFECTLY was
   * discarded (the generic "couldn't load" on a video that is fine) and — through metaAttempt — its id
   * was marked failed, so the retry that would have fixed the card was refused for 60s. One R2 blip
   * therefore cost a full minute of wrong cards per id per isolate, and nothing anywhere reported it.
   *
   * BOTH SPELLINGS OF A BROKEN WRITE, because they fail through different guards: a put that REJECTS
   * (R2 unavailable) and a stand-in with no put at all, which throws SYNCHRONOUSLY where a
   * rejected-promise guard never sees it — the exact hazard readCachedMeta's try/catch is written for.
   *
   * A FRESH deps per request, so the second one really re-enters the fetcher: the post cache would
   * otherwise answer it and the assertion would prove nothing.
   */
  const broken = [
    ['a REJECTING put', 'xnowrit1', { ...fakeR2(), async put() { throw new Error('R2 unavailable') } }],
    ['a MISSING put', 'xnowrit2', { ...fakeR2(), put: undefined }],
  ]
  for (const [what, id, r2] of broken) {
    const { seen, binding } = fakeResolver(DM_META)
    const env = envWith(binding, r2)
    const first = await (await handle(req(`/video/${id}`), env, ctx, await liveDeps())).text()
    assert.match(first, /og:title" content="Winter\.Desire/,
      `${what}: the value was obtained — failing to cache it must not discard it`)
    const second = await (await handle(req(`/video/${id}`), env, ctx, await liveDeps())).text()
    assert.equal(seen.meta, 2, `${what}: a failed WRITE must not poison the id for 60s`)
    assert.match(second, /og:title" content="Winter\.Desire/, `${what}: and the retry renders`)
  }
})

test('THE META EXTRACT SURVIVES THE RESPONSE — waitUntil is what releases its in-flight slot', async () => {
  /**
   * cachedMeta raced the work against a deadline and kept NOTHING alive, so on Workers the
   * deadline-losing case — the common one on a cold container call — was also the CANCELLED case:
   * the R2 write inside the raced work never landed (so the next unfurl repeated the extract), the
   * promise never settled (so its metaInflight entry leaked, and TWO of those exhaust
   * SPECULATIVE_META_CAP and silently disable metadata for every platform on that isolate), and the
   * cancellation was recorded as the id's own failure.
   *
   * ASSERTED AS BEHAVIOUR, NOT AS A COUNT (rewritten 2026-07-26). The first version of this test
   * asserted `waits.length === 1` on the reasoning that a title-less extract yields no post, so no mux
   * and no cached response, so the meta attempt is the only thing handed to waitUntil. That reasoning
   * is right about the mechanism and WRONG as an assertion: waitUntil is a shared side-channel that any
   * other code on the request path may legitimately use, so an exact count pins an implementation
   * detail rather than the invariant — and it went red intermittently under load during review, on a
   * test that IS the deploy gate (`npm run build` = `npm test && tsc --noEmit`, which Cloudflare runs
   * before every deploy). A flaky gate blocks good deploys and teaches people to re-run until green,
   * which is exactly how a real failure gets waved through.
   *
   * What actually matters is the CONSEQUENCE the fix exists for: the work survives the response and
   * settles, so its slot is freed and the NEXT id can still reach the container. SPECULATIVE_META_CAP
   * is 2, so a leak shows up as the third distinct id being silently refused — which is what the
   * second half of this test drives, and it fails if the keep-alive is removed.
   */
  const waits = []
  const { seen, binding } = fakeResolver({ title: '' })
  const ctx = { waitUntil: p => waits.push(p) }
  const html = await (await handle(
    req('/video/xwait001'), envWith(binding), ctx, await liveDeps(),
  )).text()
  assert.match(html, /couldn't load/i, 'the request is still answered honestly and immediately')
  assert.equal(seen.meta, 1)
  assert.ok(waits.length >= 1, 'the meta attempt is kept alive past the response')
  // Every kept-alive promise SETTLES — that is what runs metaOnce's .finally and frees the slot.
  // Promise.all, not waits[0]: the assertion is about all of them, and it does not care which index
  // the meta attempt landed on.
  await assert.doesNotReject(Promise.all(waits), 'kept-alive work must settle, not hang')

  // THE CONSEQUENCE, which is the real invariant: with the slot freed, two further DISTINCT ids still
  // reach the container. If the entry leaked, the cap (2) would be exhausted and these would be
  // refused with zero dispatch — the silent fleet-wide metadata outage this fix is about.
  for (const id of ['xwait002', 'xwait003']) {
    await handle(req(`/video/${id}`), envWith(binding), { waitUntil: p => waits.push(p) }, await liveDeps())
  }
  await assert.doesNotReject(Promise.all(waits))
  assert.equal(seen.meta, 3, 'a freed slot lets the next ids dispatch; a leaked one would refuse them')
})
