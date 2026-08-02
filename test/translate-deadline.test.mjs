import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, HTML_DEADLINE_MS, XLATE_MAX_WAIT_MS } from '../src/worker.ts'

/**
 * THE TRANSLATION DEADLINE — a defect caught in review of the translation PR itself, before it shipped.
 *
 * THE DEFECT. HTML_DEADLINE_MS is a ceiling on the WHOLE bot response, not an amount added after the
 * fetch (see its own comment, and the deadline tests in facebook-meta.test.mjs). settleMux already
 * spends whatever the upstream fetch left of it. The first draft of withTranslated then ran an
 * UNRACED Workers AI call after settleMux — stacking an unbounded inference on top of an
 * already-spent ceiling. A slow model would therefore not merely delay a translation, it would cost
 * the card, and it would do so on exactly the posts with the least budget left to give.
 *
 * The original comment argued FOR that, on an assumption never measured: "an m2m100 call on <=600
 * characters is [not seconds]". Maybe usually true. The budget does not care about usually.
 *
 * WHAT THESE PIN, in order: the card survives a slow model; the work that lost the race is not thrown
 * away; a lost race does not get its incomplete card pinned in the response cache; and — the
 * distinction that needed a sentinel rather than a null check — a model that DECLINES is final, not
 * pending, so it must not defeat the response cache forever.
 */

const JA = '今夜はラテちゃんお昼寝サービス動画 需要があれば今度ノーカット版もどこかで'
const PATH = '/mission_shige/status/2082797559819432173'
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const req = () => new Request(`https://mbedfx.app${PATH}`, { headers: { 'user-agent': DISCORD } })

/** A ctx that RETAINS background work, so a test can assert on what outlived the response. */
function trackingCtx() {
  const pending = []
  return { ctx: { waitUntil(p) { pending.push(p) } }, settle: () => Promise.allSettled(pending) }
}

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

/** A post with NO media, so settleMux is a no-op and the only thing under test is the translation. */
const jaPost = ref => ({
  ref,
  canonical: 'https://twitter.com/mission_shige/status/2082797559819432173',
  author: { name: '出越 茂毅(Shige)', handle: 'mission_shige', url: 'https://twitter.com/mission_shige' },
  text: JA,
  createdAt: new Date('2026-07-29T00:00:00Z'),
  counts: {}, sensitive: false, media: [],
})

/**
 * `run` is the whole point of each test, so every case supplies its own.
 *
 * TRANSLATE_GOOGLE IS OFF THROUGHOUT THIS FILE. Translation now tries Google's endpoint first and
 * falls back to Workers AI, and every test here is about the MODEL path — the deadline race, the
 * cache, the sentinel. Leaving Google on would make them reach the live internet, which is both
 * non-hermetic and no longer a test of the thing named in the title. The Google half has its own
 * file, with fetch stubbed.
 */
const envWith = (run, r2 = fakeR2()) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: r2,
  AI: run ? { run } : undefined,
  TRANSLATE_GOOGLE: 'off',
})

const deps = () => ({
  cache: fakeCache(),
  fetchPost: async ref => jaPost(ref),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

const xlateKeys = r2 => [...r2.store.keys()].filter(k => k.startsWith('xlate/'))

test('A SLOW MODEL MUST NOT COST THE CARD', async () => {
  // The defect, stated as a stopwatch. An unraced inference put this at HTML_DEADLINE_MS * 3.
  const slow = async () => {
    await new Promise(r => setTimeout(r, HTML_DEADLINE_MS * 3))
    return { response: 'Tonight, a Latte-chan nap service video' }
  }
  const { ctx } = trackingCtx()
  const t0 = Date.now()
  const res = await handle(req(), envWith(slow), ctx, deps())
  const elapsed = Date.now() - t0
  const html = await res.text()

  assert.equal(res.status, 200)
  /**
   * BOUNDED BY THE TRANSLATION'S OWN SLICE, not merely by the response ceiling — and the difference is
   * what the first run of this test found. Capping only at HTML_DEADLINE_MS let this render take
   * 5036ms, because a fast fetch and an empty mux leave the whole budget unspent and the model
   * cheerfully took all of it. Respecting the ceiling while spending it entirely on the least
   * important element of the card is not the behaviour this test is asking for.
   */
  assert.ok(elapsed < XLATE_MAX_WAIT_MS + 500, `the model gets a slice, not the rest (elapsed ${elapsed}ms)`)
  assert.ok(XLATE_MAX_WAIT_MS < HTML_DEADLINE_MS, 'and that slice is a fraction of the whole response')
  assert.ok(html.includes('今夜は'), 'and it is a REAL card: the author\'s own words are still on it')
  assert.ok(!/Translated from/.test(html), 'the translation that lost the race is simply absent')
})

test('THE WORK THAT LOST THE RACE IS NOT THROWN AWAY — it lands in R2 for the next reader', async () => {
  /**
   * The half the original comment got backwards: "a translation that arrives after the card is a
   * translation nobody sees." It is content-addressed, so a late translation is exactly what makes the
   * NEXT unfurl of this post — or of any post quoting the same text — instant and free. This is
   * settleMux's waitUntil discipline applied to the model.
   */
  const r2 = fakeR2()
  const slow = async () => {
    await new Promise(r => setTimeout(r, 50))
    return { response: 'Tonight, a Latte-chan nap service video' }
  }
  const { ctx, settle } = trackingCtx()
  // A budget of zero is what a blown deadline looks like; the floor is all this render gets.
  await handle(req(), envWith(slow, r2), ctx, deps())
  await settle()

  const keys = xlateKeys(r2)
  assert.equal(keys.length, 1, `the inference must be persisted, got ${JSON.stringify(keys)}`)
  assert.match(keys[0], /^xlate\/x\d+\/ja\/[0-9a-f]{64}\.json$/,
    'content-addressed under a GENERATION and its source language — see XLATE_GENERATION')
})

test('A LOST RACE IS NOT RESPONSE-CACHED, so the next reader gets the translation', async () => {
  /**
   * `pending` joins `degraded`. Without it the untranslated card would be pinned for RESP_TTL and the
   * translation landing in R2 as we answer would be invisible for fifteen minutes.
   */
  const r2 = fakeR2()
  let calls = 0
  const slow = async () => {
    calls++
    await new Promise(r => setTimeout(r, HTML_DEADLINE_MS * 3))
    return { response: 'Tonight, a Latte-chan nap service video' }
  }
  const d = deps()
  const { ctx } = trackingCtx()
  const first = await (await handle(req(), envWith(slow, r2), ctx, d)).text()
  assert.ok(!/Translated from/.test(first), 'the first reader loses the race')

  // Seed R2 the way the background write eventually would, then re-render through the SAME caches.
  await r2.put(`xlate/x3/ja/${await sha256(JA)}.json`, JSON.stringify({ t: 'Tonight, a Latte-chan nap service video' }))
  const second = await (await handle(req(), envWith(slow, r2), ctx, d)).text()

  assert.match(second, /Translated from Japanese/, 'a warm translation must reach the second card')
  assert.equal(calls, 1, 'and the warm path costs no second inference')
})

test('A MODEL THAT DECLINES IS FINAL, NOT PENDING — it must not defeat the cache forever', async () => {
  /**
   * WHY THE RACE USES A SENTINEL rather than testing the result for null. Null is not "late", it is
   * "never": a misdetected post, or a string this model will not translate. Reporting that as pending
   * would suppress the response cache on every single unfurl of that post, permanently, in service of
   * a translation that is never coming.
   */
  const r2 = fakeR2()
  let calls = 0
  const declines = async () => { calls++; return { response: '' } }
  const d = deps()
  const { ctx } = trackingCtx()

  await handle(req(), envWith(declines, r2), ctx, d)
  // ONE, where this used to be two. The old model took the language as a `source_lang` string whose
  // spelling Cloudflare's docs contradicted, so a decline cost two inferences — names, then codes.
  // A chat model is told the language in English, so a decline is believed the first time.
  assert.equal(calls, 1, 'a decline costs exactly one inference')
  // The second request must be served from the RESPONSE cache — proven by it costing no inference.
  const again = await (await handle(req(), envWith(declines, r2), ctx, d)).text()
  assert.equal(calls, 1, 'a declined translation must still leave a cacheable card')
  assert.ok(again.includes('今夜は'), 'and the card itself is unharmed')
  assert.equal(xlateKeys(r2).length, 0, 'nothing worth remembering was written')
})

test('A FAST MODEL TRANSLATES INLINE — the race is a ceiling, not a background seam', async () => {
  // The control. If this ever goes red the deadline has swallowed the feature rather than bounded it.
  const r2 = fakeR2()
  const fast = async () => ({ response: 'Tonight, a Latte-chan nap service video' })
  const { ctx } = trackingCtx()
  const html = await (await handle(req(), envWith(fast, r2), ctx, deps())).text()
  assert.match(html, /Translated from Japanese/)
  assert.ok(html.includes('今夜は'), 'the original still leads')
})

test('NO AI BINDING IS STILL A PERFECT CARD, and costs no R2 traffic', async () => {
  const r2 = fakeR2()
  const { ctx } = trackingCtx()
  const html = await (await handle(req(), envWith(undefined, r2), ctx, deps())).text()
  assert.equal(html.includes('今夜は'), true)
  assert.ok(!/Translated from/.test(html))
  assert.equal(xlateKeys(r2).length, 0)
})

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * THE TRANSLATION THAT NOBODY SAW — reported 2026-07-31 on x:2082851272315834575, a Japanese post
 * that rendered with no translation at all. It was being translated the whole time, into the one
 * document Discord does not read for a post with media:
 *
 *   og:description  "白菜おいしいね …  🌐 Translated from Japanese  It is delicious …"
 *   spoof content   "白菜おいしいね …  ❤️ 561 🔁 40"          <- what Discord actually renders
 *
 * withTranslated ran only in renderPostRoute. The /users/{handle}/statuses/{id} callback re-derives
 * the post from cache and renders it independently, so an overlay applied on one of the two seams is
 * applied on neither, from the reader's side. Exactly the YouTube age note's defect.
 */
test('THE SPOOF CALLBACK CARRIES THE TRANSLATION — it is the document Discord reads', async () => {
  const r2 = fakeR2()
  const fast = async () => ({ response: 'Chinese cabbage is delicious' })
  const { ctx } = trackingCtx()
  const d = deps()
  const env = envWith(fast, r2)

  const html = await (await handle(req(), env, ctx, d)).text()
  assert.match(html, /Translated from Japanese/, 'the head has it (this always worked)')

  const link = html.match(/activity\+json" href="([^"]+)"/)
  assert.ok(link, 'the head must advertise the spoof')
  const j = await (await handle(new Request(link[1], { headers: { 'user-agent': DISCORD } }), env, ctx, d)).json()

  assert.match(String(j.content), /Translated from Japanese/, 'and so must the spoof')
  assert.match(String(j.content), /Chinese cabbage is delicious/)
  assert.ok(String(j.content).includes('今夜は'), 'with the author\'s own words still leading')
})

test('A POST WITH NO TRANSLATION IS UNTOUCHED ON THE SPOOF SEAM TOO', async () => {
  // The regression guard for the change above: an English post must not gain a marker or a blank
  // block just because the callback now asks.
  const r2 = fakeR2()
  const { ctx } = trackingCtx()
  const d = { ...deps(), fetchPost: async ref => ({ ...jaPost(ref), text: 'Just a normal english post' }) }
  const env = envWith(async () => ({ response: 'should never be asked for' }), r2)
  const html = await (await handle(req(), env, ctx, d)).text()
  const link = html.match(/activity\+json" href="([^"]+)"/)[1]
  const j = await (await handle(new Request(link, { headers: { 'user-agent': DISCORD } }), env, ctx, d)).json()
  assert.doesNotMatch(String(j.content), /Translated/, 'English is not foreign')
})

test('THE CACHE IS KEYED ON WHAT WE ASKED, so changing the question invalidates the answer', async () => {
  /**
   * FOUND IN PRODUCTION, minutes after the url-stripping fix deployed. The translation reached the
   * card at last — and it was still the POISONED one, "It is delicious https://t.co/TNMl0cLOY0",
   * because the R2 cache was keyed on the RAW post text. That text had not changed, so the old answer
   * was still the value under the unchanged key and the improvement could never take effect.
   *
   * The cache maps WHAT WE ASKED to WHAT WE GOT. Anything else means a change to the question cannot
   * invalidate a stale answer — a cache that is content-addressed on the wrong content.
   */
  const { modelInput } = await import('../src/translate.ts')
  const r2 = fakeR2()
  const { ctx, settle } = trackingCtx()
  const withUrl = ref => ({ ...jaPost(ref), text: '白菜おいしいね https://t.co/TNMl0cLOY0' })
  const d = { ...deps(), fetchPost: async ref => withUrl(ref) }
  await handle(req(), envWith(async () => ({ response: 'Chinese cabbage is delicious' }), r2), ctx, d)
  await settle()

  const keys = xlateKeys(r2)
  assert.equal(keys.length, 1)
  const stripped = modelInput('白菜おいしいね https://t.co/TNMl0cLOY0')
  assert.equal(stripped, '白菜おいしいね', 'the question has the url removed')
  assert.equal(keys[0], `xlate/x3/ja/${await sha256(stripped)}.json`, 'and the key is the sha of THAT')
  assert.notEqual(keys[0], `xlate/x3/ja/${await sha256('白菜おいしいね https://t.co/TNMl0cLOY0')}.json`,
    'not the sha of the raw post text, which is what pinned the poisoned answer')
  /**
   * AND THE GENERATION IS IN THERE, which the first version of this test could not have caught. The
   * question alone is not the whole cache key: the answer also depends on WHO WAS ASKED, so moving
   * from m2m100 to Google left every already-translated post serving its old text under an unchanged
   * key. Measured in production on x:2082851272315834575, still saying "White is delicious." after
   * the better engine was live.
   */
  assert.match(keys[0], /^xlate\/x\d+\//, 'an engine change must be able to invalidate this')
})

/* ============ THE PREVIEW, WHERE THE MUX USED TO EAT THE TRANSLATION'S BUDGET ============
 *
 * REPORTED 2026-08-02: "the translations don't really show up super reliably on the preview site".
 *
 * Every test above uses a post with NO MEDIA, deliberately — "so settleMux is a no-op and the only
 * thing under test is the translation". That is exactly the blind spot the report landed in. The
 * defect needs a mux to wait for, so no fixture in this file could reach it.
 *
 * WHAT WAS WRONG. /_card awaited settleMux FIRST and then re-evaluated `HTML_DEADLINE_MS - elapsed`
 * for the translation. settleMux does not return early on a cold mux — it races muxOnce against a
 * timer and spends whatever it is given. So on a post carrying remux media the mux consumed the whole
 * ceiling, the subtraction went to zero, and the translation fell to its 300ms floor. The activity
 * route never had this: it runs the two in Promise.all on a flat MUX_WAIT_API_MS.
 *
 * WHY "UNRELIABLE" AND NOT "BROKEN". 300ms is not zero. Google is measured at 217-798ms and is tried
 * first, so the race won some of the time. Same link, two different answers.
 *
 * THIS TEST COSTS ~5s OF WALL CLOCK, on purpose. The budget it is proving cannot be exhausted is
 * HTML_DEADLINE_MS, so the mux has to actually outlast it; a shorter delay would leave budget
 * unspent and the test would pass against the broken code. Verified by reverting.
 */

/** The same Japanese post, but carrying remux media — which is what makes settleMux actually wait. */
const jaVideoPost = ref => ({
  ...jaPost(ref),
  media: [{
    kind: 'video', url: 'https://example.invalid/v', w: 0, h: 0,
    poster: 'https://example.invalid/p.jpg',
    remux: { page: 'https://example.invalid/page/1' },
  }],
})

/** A resolver whose MUX is slower than the old whole-response ceiling; its meta answers instantly. */
const slowMuxBinding = ms => ({
  getByName() {
    return {
      async fetch(_u, init) {
        const body = JSON.parse(init.body)
        if (body.meta === true) return Response.json({ title: 'a video', width: 1, height: 1 })
        await new Promise(r => setTimeout(r, ms))
        return new Response('MP4', { headers: { 'content-type': 'video/mp4', 'content-length': '3' } })
      },
    }
  },
})

const cardReq = () => new Request('https://mbedfx.app/_card?p=' + encodeURIComponent(PATH))

test('THE PREVIEW TRANSLATES A VIDEO POST EVEN WHEN THE MUX IS SLOW — the two race, they do not queue', async () => {
  // 800ms: comfortably inside the translation's own 1500ms slice, and comfortably OUTSIDE the 300ms
  // floor it was being squeezed into. That gap is the whole difference between the two behaviours.
  const model = async () => {
    await new Promise(r => setTimeout(r, 800))
    return { response: 'Tonight, a Latte-chan nap service video' }
  }
  const { ctx } = trackingCtx()
  const env = { ...envWith(model), MEDIA_RESOLVER: slowMuxBinding(HTML_DEADLINE_MS) }
  const res = await handle(cardReq(), env, ctx, { ...deps(), fetchPost: async ref => jaVideoPost(ref) })
  const j = await res.json()

  assert.equal(j.ok, true)
  assert.match(j.text, /Latte-chan nap service video/,
    'the translation survived a mux that used to consume the entire budget before it started')
  assert.equal(j.pending, false, 'and it is not reported as still pending')
})

test('A PREVIEW THAT LOST THE RACE SAYS SO, so the page knows to ask once more', async () => {
  /**
   * The other half. /_card returns exactly one answer per typing-settle and the page draws it; there
   * is no next render to heal on, which is why `pending` had to become part of the response rather
   * than staying an internal signal that only renderPostRoute consumed.
   */
  const tooSlow = async () => {
    await new Promise(r => setTimeout(r, XLATE_MAX_WAIT_MS * 4))
    return { response: 'Tonight, a Latte-chan nap service video' }
  }
  const { ctx } = trackingCtx()
  const j = await (await handle(cardReq(), envWith(tooSlow), ctx, deps())).json()

  assert.equal(j.ok, true)
  assert.equal(j.pending, true, 'the page is told the answer is incomplete')
  assert.ok(!/Latte-chan/.test(j.text), 'and it is not pretending to have a translation it lost')
})

test('THE HTML SEAM TRANSLATES A VIDEO POST TOO — the two seams must not disagree about one post', async () => {
  /**
   * The counterpart to the /_card test above, on the seam DISCORD reads for a post with no media —
   * and the one that proves the pair cannot drift.
   *
   * Found by measuring a live cold Instagram reel: the activity document came back translated while
   * this document, for the SAME post at the SAME moment, carried the raw Chinese caption. Same
   * defect as the preview's — settleMux was awaited first and spent the budget the translation then
   * asked for what was left of.
   *
   * "Fix one head and not the other and half the cards still break" is the oldest note in this
   * repo's guide. This is that note as an assertion.
   */
  const model = async () => {
    await new Promise(r => setTimeout(r, 800))
    return { response: 'Tonight, a Latte-chan nap service video' }
  }
  const { ctx } = trackingCtx()
  const env = { ...envWith(model), MEDIA_RESOLVER: slowMuxBinding(HTML_DEADLINE_MS) }
  const res = await handle(req(), env, ctx, { ...deps(), fetchPost: async ref => jaVideoPost(ref) })
  const html = await res.text()

  assert.equal(res.status, 200)
  assert.match(html, /Latte-chan nap service video/,
    'the og:description carries the translation instead of the budget going entirely to the mux')
})
