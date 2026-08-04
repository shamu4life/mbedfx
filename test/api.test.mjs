import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { route } from '../src/router.ts'
import { refKey } from '../src/refkey.ts'

/**
 * /_api/v1 — THE PUBLIC JSON API, AND THE FACT THAT IT IS A CONTRACT.
 *
 * Everything /_card returns can be renamed the afternoon it is regretted, because the only consumer
 * is a page in this repo. Nothing here can. So these tests pin the SHAPE as much as the values: a
 * field that quietly changes type, a url that resolves to the wrong bytes, or a status code that
 * invites a consumer to branch on it are all breaking changes to code we will never see.
 *
 * NO NETWORK ANYWHERE. Every post is injected through `deps.fetchPost`, so the whole file runs
 * offline like the rest of the suite.
 *
 * EVERY TEST GETS ITS OWN ID. muxInflight and metaInflight are module-level and isolate-lifetime, so
 * one test's parked promise otherwise becomes another test's answer.
 */

const ORIGIN = 'https://mbedfx.app'
const apiReq = url => new Request(`${ORIGIN}/_api/v1?url=${encodeURIComponent(url)}`)
const cardReq = path => new Request(`${ORIGIN}/_card?p=${encodeURIComponent(path)}`)

const ctx = { waitUntil() {} }
const retainingCtx = () => { const kept = []; return { waitUntil(p) { kept.push(p) } } }

const fakeCache = () => {
  const m = new Map()
  return {
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}

function fakeR2() {
  const store = new Map()
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) {
      const v = store.get(k)
      return v ? { body: new Response(v).body, size: v.length, uploaded: new Date(), async json() { return JSON.parse(v) } } : null
    },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}

// TRANSLATE_GOOGLE is off throughout: Google is tried first and it is the live internet. Nothing in
// this file is about the translation engine.
const envWith = (over = {}) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: fakeR2(),
  TRANSLATE_GOOGLE: 'off',
  ...over,
})

const depsFor = post => ({
  cache: fakeCache(),
  // EVERY ARGUMENT FORWARDED. fetchPost's real signature is (ref, env, client, report, ctx), and the
  // gate reason rides the `report` OUT-PARAM rather than the return value — loadPost's contract is
  // Post|null and the cache layer must not learn failure shapes. A stub that takes only `ref` makes
  // every gate test silently assert the generic failure instead.
  fetchPost: async (...args) => (typeof post === 'function' ? post(...args) : post),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

const twitterPost = (id, over = {}) => ({
  ref: { p: 'x', id },
  canonical: `https://x.com/apiwatch/status/${id}`,
  author: { name: 'api watch', handle: 'apiwatch', url: 'https://x.com/apiwatch', avatar: 'https://example.invalid/a.jpg' },
  text: 'a post that has to survive being published',
  createdAt: new Date('2026-08-02T12:00:00Z'),
  counts: { likes: 12, replies: 3 },
  sensitive: false,
  media: [{ kind: 'image', url: 'https://example.invalid/one.jpg', w: 800, h: 600 }],
  ...over,
})

const get = async (req, post, env = envWith(), c = ctx) => {
  const res = await handle(req, env, c, depsFor(post))
  return { res, body: await res.json() }
}

test('THE API ANSWERS A POST AS DATA, with OUR media urls and no card vocabulary in it', async () => {
  /**
   * The success shape, pinned field by field. Two things here are the whole point of the endpoint
   * existing separately from /_card rather than being a second name for it:
   *
   * EVERY URL IS OURS. `/_media/{refKey}/{i}`, never the upstream CDN url held in the Post. Several
   * platforms sign those and expire them within hours, and several are referer- or IP-locked, so
   * publishing one hands a consumer a link that either dies or never worked for them. The renderers
   * follow the same rule and Media.url's own docstring is where it is written down.
   *
   * NO `color`, NO `stats`, NO `byline`. Those are the CARD's answers — a stripe colour, a
   * pre-rendered stat line, a pre-assembled author line — and a consumer drawing its own presentation
   * wants the facts underneath them. Asserted as ABSENT rather than merely unused, because the cost
   * of publishing a field is that it can never be withdrawn.
   */
  const { res, body } = await get(apiReq('https://x.com/apiwatch/status/2000000000000000001'),
    twitterPost('2000000000000000001'))

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*',
    'a public read-only API a browser cannot call from script is most of an API missing')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(body.ok, true)
  assert.equal(body.muxing, false)
  assert.equal(body.pending, false)

  const p = body.post
  assert.equal(p.platform, 'x')
  assert.equal(p.canonical, 'https://x.com/apiwatch/status/2000000000000000001')
  assert.equal(p.createdAt, '2026-08-02T12:00:00.000Z')
  assert.equal(p.text, 'a post that has to survive being published')
  assert.equal(p.sensitive, false)
  assert.deepEqual(p.author, {
    name: 'api watch',
    handle: 'apiwatch',
    url: 'https://x.com/apiwatch',
    avatar: `${ORIGIN}/_media/${encodeURIComponent(refKey({ p: 'x', id: '2000000000000000001' }))}/avatar`,
  })
  assert.deepEqual(p.counts, { likes: 12, replies: 3 })
  assert.equal(p.media.length, 1)
  assert.equal(p.media[0].kind, 'image')
  assert.ok(p.media[0].url.startsWith(`${ORIGIN}/_media/`),
    `a published media url must be ours, got ${p.media[0].url}`)
  assert.ok(!JSON.stringify(body).includes('example.invalid'),
    'NO upstream CDN url may appear anywhere in the payload, under any key')
  assert.deepEqual([p.media[0].width, p.media[0].height], [800, 600])
  assert.equal(p.media[0].poster, null, 'an image carries no poster, and the key is present as null')
  assert.equal(p.quote, null)

  for (const gone of ['color', 'stats', 'byline']) {
    assert.ok(!(gone in p), `${gone} is the card's answer and must not become a published contract`)
  }
})

test('AN UNKNOWN UPLOAD DATE IS null, NOT THE EPOCH — the one place the API answers differently from the card', async () => {
  /**
   * THE DEFECT THIS PREVENTS IS A SILENT ONE IN SOMEBODY ELSE'S CODE. A Post with no known upload date
   * carries `new Date(0)`, and /_card serialises that faithfully as "1970-01-01T00:00:00.000Z" —
   * which is fine there, because the page draws a "no upload date" note beside it and a reader can
   * see what happened. An API consumer gets a well-formed timestamp, sorts by it, and silently files
   * every date-less post at the beginning of time.
   *
   * So the API refuses to fill the hole, which is the same rule the cards follow in words. Both
   * surfaces are asserted here together, because the difference is deliberate and the next person to
   * see it will otherwise "fix" one of them.
   */
  const dateless = twitterPost('2000000000000000002', { createdAt: new Date(0) })

  const { body: api } = await get(apiReq('https://x.com/apiwatch/status/2000000000000000002'), dateless)
  assert.equal(api.post.createdAt, null, 'the API says it does not know')

  const { body: card } = await get(cardReq('/apiwatch/status/2000000000000000002'), dateless)
  assert.equal(card.createdAt, '1970-01-01T00:00:00.000Z',
    'the card still serialises it faithfully, because the page renders a note next to it')
})

test('COUNTS THAT CANNOT BE TRUSTED ARE OMITTED, never published as a number', async () => {
  /**
   * `post.counts` comes out of the POST CACHE and `deserializePost` validates the ref, the canonical
   * and the date and NOTHING else. So every one of these shapes reaches the serialiser intact, and
   * `counts: post.counts || {}` — which is what /_card does — publishes them verbatim. A consumer
   * doing `likes.toLocaleString()` on the string, or rendering NaN, is then our bug.
   *
   * ZERO IS OMITTED TOO, and that is the judgement rather than the safety check. Upstreams report 0
   * both for a genuinely uninteracted post and for a count the platform WITHHOLDS — a hidden like
   * count, a video with comments switched off — and nothing tells them apart by the time the value
   * gets here. An absent key says "we do not know"; a published 0 would say "we know, and it is
   * none". ytCount already refuses to guess for the same reason.
   */
  const { body } = await get(
    apiReq('https://x.com/apiwatch/status/2000000000000000003'),
    twitterPost('2000000000000000003', {
      counts: { likes: 5, reposts: 0, replies: NaN, views: '900' },
    }))
  assert.deepEqual(body.post.counts, { likes: 5 },
    'only the count that is a finite positive number survives')
})

test('EVERY ANSWER ABOUT A POST IS 200, INCLUDING THE GATES — and a malformed REQUEST is the only 400', async () => {
  /**
   * RULE 1 OF THIS PROJECT, POINTED OUTWARD. "Assert on CONTENT, never on status" exists because our
   * own upstreams answer 200 with a login wall and 500 with a JSON error. Making a consumer branch on
   * OUR status would be telling them to do the thing we refuse to do, and it invites a CDN or an
   * over-helpful http client to special-case a 403 into a retry or a thrown exception. `ok` and
   * `error.code` are the contract.
   *
   * THE GATES KEEP THEIR OWN CODES. "This post is age-restricted" and "this post is private" are the
   * answers this project exists to give instead of a blank rectangle, and flattening them into a
   * generic failure in the API would undercut the one row of the comparison table we lead on.
   *
   * AND NONE OF IT IS CACHED. A private account goes public, a deleted post comes back as a repost,
   * an age gate lifts. `loadPost` deliberately never caches a null Post so the next view heals; a
   * max-age on the envelope would reintroduce that staleness one layer up, at an edge this worker
   * cannot invalidate.
   */
  const cases = [
    ['age_restricted', 'age_restricted'],
    ['private', 'private'],
    [undefined, 'fetch_fail'],
  ]
  let n = 0
  for (const [failReason, code] of cases) {
    const id = `20000000000000001${n++}`
    const { res, body } = await get(
      apiReq(`https://x.com/apiwatch/status/${id}`),
      // The reason is written to `report.reason` — the FetchReport out-param — and getPost surfaces it
      // as `failReason`. Two names for one value, which is exactly why this is worth a comment.
      async (_ref, _env, _client, report) => { if (report) report.reason = failReason; return null })
    assert.equal(res.status, 200, `${code} is an answer about a post, not a broken request`)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, code)
    assert.ok(body.error.message.length > 0, 'every code carries prose a human can read')
    assert.equal(res.headers.get('cache-control'), 'no-store',
      'a wall can come down, so the answer that there is one must never be cached')
  }

  // The two malformed-REQUEST cases, which are the only 400s this endpoint emits.
  const noUrl = await handle(new Request(`${ORIGIN}/_api/v1`), envWith(), ctx, depsFor(null))
  assert.equal(noUrl.status, 400)
  assert.equal((await noUrl.json()).error.code, 'no_url')

  /**
   * `unparseable` IS NARROWER THAN IT SOUNDS, and that is worth pinning rather than discovering.
   * describeTarget parses with `new URL(target, origin)` — WITH A BASE — so anything that looks like a
   * path resolves against our own origin instead of throwing. `:::not-a-url` becomes the path
   * `/:::not-a-url` and answers notfound, which is the honest answer: it is a url we do not route, not
   * a url we could not read. Only a string that fails URL parsing outright lands here.
   */
  const junk = await handle(new Request(`${ORIGIN}/_api/v1?url=${encodeURIComponent('http://[')}`),
    envWith(), ctx, depsFor(null))
  assert.equal(junk.status, 400)
  assert.equal((await junk.json()).error.code, 'unparseable')

  // The other side of that base-resolution, and it is a FEATURE rather than an accident: a caller who
  // passes a bare path — or one of our own converted links — gets the post rather than a lecture.
  const { body: bare } = await get(apiReq('/apiwatch/status/2000000000000000060'),
    twitterPost('2000000000000000060'))
  assert.equal(bare.ok, true, 'a path with no host resolves against our own origin and still works')
})

test('AN AMBIGUOUS PATH NAMES ITS CANDIDATES, and the host in `url` is deliberately NOT used to break the tie', async () => {
  /**
   * THE TEMPTING FEATURE THIS REFUSES. route() is host-agnostic, so `/gallery/abc` is Reddit,
   * Instagram or Imgur and the card surface genuinely cannot tell. This endpoint is handed a FULL url
   * that says which — so disambiguating from it looks free.
   *
   * It is not free. It would make the answer depend on a string the caller controls, on a service
   * where a hostname is a thing we FETCH: the fediverse arm turns one into a request, and refkey.ts
   * states plainly that Cloudflare is not relied on to block private addresses. "The host decides
   * which platform fetcher runs" is a sentence worth being frightened of. So the tie stays unbroken
   * and the caller re-asks with the two-letter prefix the site already documents.
   *
   * Pinned with two DIFFERENT hosts giving the SAME answer, because a future change that starts
   * trusting the host would pass a test that only ever sends one.
   */
  const path = route(new URL(`${ORIGIN}/mrbeast`))
  assert.equal(path.kind, 'ambiguous', 'precondition: a bare handle is the chooser')

  for (const host of ['https://x.com/mrbeast', 'https://www.instagram.com/mrbeast']) {
    const { res, body } = await get(apiReq(host), null)
    assert.equal(res.status, 200)
    assert.equal(body.error.code, 'ambiguous')
    assert.deepEqual(body.error.candidates, path.candidates,
      `${host} must get the same candidates as every other host for this path`)
    assert.ok(body.error.message.includes('prefix'), 'the message says how to resolve it')
  }
})

test('AN INCOMPLETE ANSWER IS NEVER CACHED — the muxing and pending flags are load-bearing, not decoration', async () => {
  /**
   * A video still muxing is serving its POSTER STILL, and the payload is otherwise indistinguishable
   * from a post that only ever had a picture: kind 'image', a url that resolves, correct dimensions.
   * Cache that and the real video never arrives — the rule CLAUDE.md states as "a degraded card must
   * not be response-cached", here applied to a payload rather than to markup.
   *
   * The flag is what makes the incompleteness legible to a consumer at all, so it is asserted as an
   * exact boolean rather than for truthiness: a consumer branching on `undefined` gets the same
   * silence the converter page used to.
   */
  const { res, body } = await get(
    apiReq('https://x.com/apiwatch/status/2000000000000000020'),
    twitterPost('2000000000000000020', {
      media: [{
        kind: 'video', url: 'https://example.invalid/v', w: 0, h: 0,
        poster: 'https://example.invalid/p.jpg', posterW: 480, posterH: 360,
        remux: { page: 'https://example.invalid/page' },
      }],
    }),
    envWith({ MEDIA_RESOLVER: { getByName: () => ({ fetch: () => new Promise(() => {}) }) } }),
    retainingCtx())

  assert.equal(body.ok, true)
  assert.equal(body.muxing, true, 'the container never answered, so the video is still coming')
  assert.equal(res.headers.get('cache-control'), 'no-store',
    'cache this and the finished video can never replace the still')
})

test('A COMPLETE ANSWER IS CACHEABLE — otherwise the API pays an upstream fetch for every caller', async () => {
  const { res, body } = await get(apiReq('https://x.com/apiwatch/status/2000000000000000021'),
    twitterPost('2000000000000000021'))
  assert.equal(body.muxing, false)
  assert.equal(body.pending, false)
  assert.match(res.headers.get('cache-control'), /^public, max-age=\d+$/)
})

test('THE API AND THE CARD DESCRIBE THE SAME POST — one pipeline, two serialisers', async () => {
  /**
   * THE DEFECT CLASS THIS EXISTS FOR IS THIS PROJECT'S MOST REPEATED ONE. The translation applied to
   * the og head and not the Mastodon spoof. The YouTube date warmed by the activity route and not the
   * preview, so every fresh link previewed as 1970. The quote block drawn on the card and missing
   * from the preview. Each was one surface being taught something its twin was not, and each was
   * invisible until two outputs were put side by side.
   *
   * A third surface makes that worse, not better — and this one is a published contract, so a
   * divergence would have to be lived with rather than fixed. describeTarget is the answer: both arms
   * call ONE function and differ only in how they serialise its result.
   *
   * SO THE FACTS ARE COMPARED, NOT THE FIELD NAMES. The two surfaces deliberately spell things
   * differently (w/h versus width/height, a byline versus its parts, an epoch versus null) — that is
   * serialisation and it is allowed to differ. What must never differ is what they say happened.
   */
  const post = twitterPost('2000000000000000030', {
    quote: {
      ref: { p: 'x', id: '2000000000000000031' },
      canonical: 'https://x.com/quoted/status/2000000000000000031',
      author: { name: 'quoted', handle: 'quoted', url: 'https://x.com/quoted' },
      text: 'the quoted post', createdAt: new Date('2026-08-01T00:00:00Z'),
      counts: {}, sensitive: false, media: [],
    },
  })
  const url = 'https://x.com/apiwatch/status/2000000000000000030'
  const { body: api } = await get(apiReq(url), post)
  const { body: card } = await get(cardReq('/apiwatch/status/2000000000000000030'), post)

  assert.equal(api.ok, true)
  assert.equal(card.ok, true)
  assert.equal(api.post.canonical, card.canonical, 'the same post')
  assert.equal(api.post.text, card.text, 'the same text, after the same overlays')
  assert.equal(api.post.platform, card.platform)
  assert.equal(api.post.sensitive, card.sensitive)
  assert.equal(api.muxing, card.muxing)
  assert.equal(api.pending, card.pending)
  assert.equal(api.post.media.length, card.media.length, 'the same media survive `usable`')
  assert.deepEqual(
    api.post.media.map(m => [m.kind, m.url]),
    card.media.map(m => [m.kind, m.url]),
    'and they address the SAME bytes — a url that differs between the two is one of them being wrong')
  assert.equal(api.post.quote.canonical, card.quote.canonical, 'both draw the quoted post')
  assert.ok(card.quote.byline.includes(api.post.quote.author.handle),
    'the card pre-assembles the byline the API publishes the parts of')
})

test('A PUBLISHED MEDIA URL RESOLVES TO THAT ENTRY\'S BYTES even when an unusable entry comes first', async () => {
  /**
   * THE OFF-BY-ONE, found 2026-08-03 while building this endpoint on the card's shape.
   *
   * /_media/{refKey}/{i} resolves `i` against the UNFILTERED media array — pickMedia reads
   * mediaList(post), and the media route's own `list.findIndex(usable)` returns an unfiltered
   * position. The card computed its urls as `mediaOf(post).filter(usable).map((m, i) => …)`, so `i`
   * was a position in the FILTERED list. The two agree only while every entry is usable, which is
   * almost always — `usable` drops entries with no url and normalizers rarely emit those — so this
   * was latent rather than visible.
   *
   * Put one unusable entry in front of a usable one and the published url is off by one: it names
   * index 0, and index 0 is the entry that was filtered out. A wrong picture, or a 404 past the end.
   *
   * PINNED BY DRIVING THE ACTUAL /_media/ ROUTE rather than by asserting an index, because the index
   * is not the contract — "this url serves those bytes" is, and only the route can answer that.
   */
  const id = '2000000000000000040'
  const post = twitterPost(id, {
    media: [
      // Unusable: no url. This is what shifts every position after it.
      { kind: 'image', url: '', w: 100, h: 100 },
      { kind: 'image', url: 'https://example.invalid/real.jpg', w: 640, h: 480 },
    ],
  })
  const { body } = await get(apiReq(`https://x.com/apiwatch/status/${id}`), post)
  assert.equal(body.post.media.length, 1, 'the unusable entry is not published')

  const served = await handle(new Request(body.post.media[0].url), envWith(), ctx, depsFor(post))
  assert.equal(served.status, 302, 'the published url resolves rather than 404ing')
  assert.equal(served.headers.get('location'), 'https://example.invalid/real.jpg',
    'and it serves the entry the payload described, not the one in front of it')
})

test('A CORRUPTED CACHED POST CANNOT THROW — the serialiser is total, like every other cache reader', async () => {
  /**
   * `deserializePost` validates ref, canonical and createdAt and NOTHING else, so a corrupted or
   * hostile record reaches the serialiser with `media: 42`, `author: null`, or a hole in the media
   * array, and the naive reads (`post.author.name`, `post.media[i].url`) each throw on one of them.
   * This route has no try/catch above it, so a throw here is an uncaught 500 on a public endpoint
   * whose input the caller chooses. cache.ts states the rule: the guard must be total between a
   * corrupted cache entry and served output.
   */
  const shapes = [
    { media: 42 },
    { media: [null] },
    { media: [{ kind: 'image' }] },
    { author: null },
    { counts: null },
    { quote: { ref: { p: 'x', id: '1' }, canonical: 'https://x.com/a/status/1' } },
    { text: undefined, title: 42 },
  ]
  let n = 0
  for (const over of shapes) {
    const id = `20000000000000005${n++}`
    const { res, body } = await get(
      apiReq(`https://x.com/apiwatch/status/${id}`), twitterPost(id, over))
    assert.equal(res.status, 200, `${JSON.stringify(over)} must not 500`)
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.post.media), 'media is always an array, whatever the record held')
    assert.equal(typeof body.post.text, 'string', 'text is always a string')
  }
})

test('A PREFLIGHT IS ANSWERED, NOT RUN — and a write verb is refused before anything is spent', async () => {
  /**
   * FOUND IN REVIEW, BEFORE THIS SHIPPED. `OPTIONS /_api/v1?url=…` fell through to the pipeline: the
   * browser's CORS preflight paid for a full upstream fetch, a mux wait and a container call, and was
   * then answered WITHOUT `access-control-allow-methods` — so the preflight failed, the real GET never
   * fired, and the whole request had been bought for a call the browser threw away. Any consumer
   * sending a custom header is preflighted, which is a large share of the ones a documented CORS-open
   * API invites.
   *
   * ASSERTED ON `fetchPost` NEVER BEING CALLED, not merely on the status, because a 204 that still ran
   * the pipeline would pass a status-only test while costing exactly what this exists to stop.
   */
  let fetched = 0
  const counting = { ...depsFor(twitterPost('2000000000000000070')) }
  const inner = counting.fetchPost
  counting.fetchPost = async (...a) => { fetched++; return inner(...a) }

  const pre = await handle(
    new Request(`${ORIGIN}/_api/v1?url=${encodeURIComponent('https://x.com/apiwatch/status/2000000000000000070')}`,
      { method: 'OPTIONS' }), envWith(), ctx, counting)
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS',
    'without this the preflight fails and the real request never happens')
  assert.equal(fetched, 0, 'a preflight must not cost an upstream fetch')

  const posted = await handle(
    new Request(`${ORIGIN}/_api/v1?url=${encodeURIComponent('https://x.com/apiwatch/status/2000000000000000071')}`,
      { method: 'POST' }), envWith(), ctx, counting)
  assert.equal(posted.status, 405)
  assert.equal((await posted.json()).error.code, 'method_not_allowed')
  assert.equal(fetched, 0, 'and neither must a write verb')
})

test('A STILL STANDING IN FOR A VIDEO SAYS SO, even when it will never become one', async () => {
  /**
   * `muxing` covers the video that is STILL COMING. It does not cover the video that never will: a
   * post past MUX_MAX_SECONDS is degraded to its poster permanently, and answers `muxing: false` on a
   * CACHEABLE 200 carrying a plain `kind: "image"`. Before this flag the only trace that a video
   * existed at all was an English sentence prepended to `text` — a card's answer, and a consumer
   * parsing prose to find it is a consumer we have failed.
   *
   * Both halves are pinned because they are the two ways to get it wrong: a still that does not say
   * it is one, and an ordinary photo that claims to be.
   */
  const overCeiling = twitterPost('2000000000000000080', {
    media: [{
      kind: 'image', url: 'https://example.invalid/p.jpg', poster: 'https://example.invalid/p.jpg',
      w: 480, h: 360, posterOnly: true,
    }],
  })
  const { body } = await get(apiReq('https://x.com/apiwatch/status/2000000000000000080'), overCeiling)
  assert.equal(body.muxing, false, 'nothing is coming — this is the permanent case')
  assert.equal(body.post.media[0].kind, 'image')
  assert.equal(body.post.media[0].still, true, 'and the payload says a video is behind it')

  const plain = await get(apiReq('https://x.com/apiwatch/status/2000000000000000081'),
    twitterPost('2000000000000000081'))
  assert.equal(plain.body.post.media[0].still, false, 'an ordinary photo must not claim to be a still')
})

test('A CACHED RECORD OF THE WRONG TYPE IS PUBLISHED AS null, NEVER VERBATIM', async () => {
  /**
   * FOUND IN REVIEW. `title`, `author` and `counts` were defended and `text`, `width`, `height` and
   * `quote.text` were not — which is what made it an oversight rather than a decision. A cached record
   * carrying `text: {evil: 1}` and `w: '800'` was published verbatim, at HTTP 200, with a fifteen
   * minute max-age, under keys docs/API.md types as a string and a number. Every consumer doing
   * `post.text.length` or arithmetic on `width` then breaks on a payload we promised them.
   */
  const { res, body } = await get(
    apiReq('https://x.com/apiwatch/status/2000000000000000090'),
    twitterPost('2000000000000000090', {
      text: { evil: 1 },
      media: [{ kind: 'image', url: 'https://example.invalid/x.jpg', w: '800', h: { a: 1 } }],
      quote: {
        ref: { p: 'x', id: '2000000000000000091' },
        canonical: 'https://x.com/quoted/status/2000000000000000091',
        author: { name: 'q', handle: 'q', url: 'https://x.com/q' },
        text: 42, createdAt: new Date('2026-08-01T00:00:00Z'), counts: {}, sensitive: false, media: [],
      },
    }))
  assert.equal(res.status, 200)
  assert.equal(body.post.text, '', 'a non-string text publishes as the empty string, never as an object')
  assert.equal(body.post.media[0].width, null, 'a stringy dimension is null, not "800"')
  assert.equal(body.post.media[0].height, null)
  assert.equal(body.post.quote.text, '', 'and the quote gets the same treatment as the post')
})

test('/_api/v2 IS NOT SILENTLY SERVED AS v1 — a version we do not have is an answer, not a guess', async () => {
  /**
   * The version is in the PATH so it is visible in a url somebody pastes into a bug report. The
   * failure worth ruling out is the friendly one: falling back to v1 for an unknown version would
   * hand a consumer asking for a contract we have not written a DIFFERENT contract, and they would
   * find out from the field that changed shape rather than from us.
   */
  assert.equal(route(new URL(`${ORIGIN}/_api/v2?url=https://x.com/a/status/1`)).kind, 'notfound',
    'v2 falls through to the ordinary path matchers, which do not claim it')
  assert.deepEqual(route(new URL(`${ORIGIN}/_api/v1?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1`)),
    { kind: 'api', target: 'https://x.com/a/status/1' })
  assert.deepEqual(route(new URL(`${ORIGIN}/_api/v1`)), { kind: 'api', target: null },
    'a missing url is still the api kind, so the api arm is what decides what a bad request looks like')
})
