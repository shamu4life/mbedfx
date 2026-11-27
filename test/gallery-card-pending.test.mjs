import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, XLATE_MAX_WAIT_MS } from '../src/worker.ts'
import { TRANSLATION_MARKER } from '../src/translate.ts'

/**
 * THE GALLERY CARD MUST NOT FREEZE WHAT TODAY'S CARD WOULD STILL FIX, driven through the worker.
 *
 * Measured 2026-11-26: with a component embed in the head, Discord draws it and never fetches the activity
 * document (render/componentembed.ts has the reading). Today's card leans on that fetch in two ways the
 * gallery card took away, both found in review of the gallery branch:
 *
 *   - THE SECOND CHANCE. A translation that misses the head's slice still reaches the activity document,
 *     which asks again a moment later. Reproduced on the branch: a six-picture post with a Japanese
 *     caption arriving at 4600 ms and a model answering at 800 ms drew a gallery card with the raw
 *     caption, while /api/v1/statuses/{id} fetched straight after carried the translation and its marker.
 *     The tests below use a model slower than XLATE_MAX_WAIT_MS instead, which loses the same race in a
 *     fraction of the wall clock.
 *   - THE QUOTE'S VIDEO. The activity card hoists it in as a still and says "🎬 Contains video" on /p. The
 *     gallery card shows none of the quote's media, so that line would vanish.
 *
 * test/component-embed.test.mjs pins the predicate itself; these pin that the worker hands it the right
 * answer on every surface that asks: the head, the short-link head, and the converter's /_card.
 *
 * No network: fetch throws. Every test has its own post ids, so the in-flight maps and the caches below
 * cannot carry one test's answer into another.
 */
globalThis.fetch = async u => { throw new Error(`network touched: ${u}`) }

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const SCRIPT = /<script id="discord:component-embed" type="application\/json">([^<]*)<\/script>/
const JA = '白菜おいしいね、今日は畑で六枚撮りました'
const EN = 'Chinese cabbage is delicious, I took six pictures in the field today'
const when = new Date('2026-10-30T18:00:00Z')

const pictures = (base, n) => Array.from({ length: n }, (_, i) => ({ kind: 'image', url: `${base}/${i}.jpg`, w: 1080, h: 1350 }))

/** Six pictures of its own: the gallery card's shape, unless something below says otherwise. */
const igSix = (ref, text = JA) => ({
  ref,
  canonical: `https://www.instagram.com/p/${ref.code}/`,
  author: { name: 'Example Gallery', handle: 'example.gallery', url: 'https://www.instagram.com/example.gallery/' },
  text,
  createdAt: when,
  media: pictures(`https://scontent.cdninstagram.com/v/${ref.code}`, 6),
  counts: { likes: 20900, replies: 82 },
  sensitive: false,
})

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

/** A ctx that keeps background work, so a test can wait for the translation the head lost to land in R2. */
function trackingCtx() {
  const pending = []
  return { ctx: { waitUntil(p) { pending.push(p) } }, settle: () => Promise.allSettled(pending) }
}

/**
 * A model that answers after `ms`, counting its calls. TRANSLATE_GOOGLE is off, as in
 * test/translate-deadline.test.mjs, so the model is the only translator and nothing reaches the internet.
 */
function model(ms) {
  const m = {
    calls: 0,
    async run() {
      m.calls++
      if (ms) await new Promise(r => setTimeout(r, ms))
      return { response: EN }
    },
  }
  return m
}
const envWith = ai => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('asset') } },
  MEDIA_CACHE: fakeR2(),
  AI: ai,
  TRANSLATE_GOOGLE: 'off',
})

const ask = (path, ua = DISCORD) => new Request(ORIGIN + path, { headers: { 'user-agent': ua } })
const scriptOf = html => {
  const m = SCRIPT.exec(html)
  return m ? JSON.parse(m[1]) : null
}
const textOf = card => card.component.components.filter(n => n.type === 10).map(n => n.content).join('\n')
/** The document Discord fetches for this head: /api/v1/statuses/{id}, the id read off the head's own link. */
const documentFor = (html, env, ctx, d) => {
  const sid = /activity\+json" href="[^"]*\/statuses\/(\d+)"/.exec(html)[1]
  return handle(ask(`/api/v1/statuses/${sid}`), env, ctx, d).then(r => r.json())
}
const LOSES = XLATE_MAX_WAIT_MS + 300

test('A TRANSLATION THAT LOST THE HEAD\'S RACE KEEPS TODAY\'S CARD, so the activity document can still carry it', async () => {
  const ai = model(LOSES)
  const env = envWith(ai)
  const { ctx, settle } = trackingCtx()
  const d = { cache: fakeCache(), fetchPost: async ref => igSix(ref) }
  const path = '/p/GaLPend00001'

  const first = await (await handle(ask(path), env, ctx, d)).text()
  assert.equal(scriptOf(first), null, 'no gallery card: it would replace the one document that can still bring the translation')
  assert.match(first, /<link rel="alternate" type="application\/activity\+json"/, 'today\'s head, activity link and all')
  assert.ok(!first.includes(TRANSLATION_MARKER), 'the translation did lose the race')

  // The model's answer lands in R2 behind the response, as it does in production, and the document
  // Discord fetches next carries it. That is the second chance a gallery card would have taken away.
  await settle()
  const doc = await documentFor(first, env, ctx, d)
  assert.ok(String(doc.content).includes(EN), 'the document has the translation')
  assert.ok(String(doc.content).includes(`${TRANSLATION_MARKER} from Japanese`), 'and the marker')

  // The pending head was not response-cached, so the next paste renders again, finds the translation in
  // R2, and gets the gallery card with the translation in it.
  const again = await (await handle(ask(path), env, ctx, d)).text()
  const card = scriptOf(again)
  assert.ok(card, 'the next paste draws the gallery card')
  assert.ok(textOf(card).includes(EN) && textOf(card).includes(`${TRANSLATION_MARKER} from Japanese`), 'translated, with the marker')
  assert.ok(textOf(card).includes(JA), 'and the author\'s own words under it')
  assert.equal(ai.calls, 1, 'the document and the second paste read R2; only the first head asked the model')
})

test('A TRANSLATION THAT LANDED IN TIME GOES INTO THE GALLERY CARD', async () => {
  const env = envWith(model(0))
  const { ctx } = trackingCtx()
  const d = { cache: fakeCache(), fetchPost: async ref => igSix(ref) }
  const html = await (await handle(ask('/p/GaLPend00002'), env, ctx, d)).text()
  const card = scriptOf(html)
  assert.ok(card, 'settled, so the gallery card is drawn')
  const text = textOf(card)
  assert.ok(text.startsWith(`**Example Gallery** (@example.gallery)\n${EN}`), 'the English first, as the activity card has it')
  assert.ok(text.includes(`${TRANSLATION_MARKER} from Japanese\n${JA}`), 'then the marker over the original')
})

test('A POST THAT LOADED INCOMPLETE KEEPS TODAY\'S CARD, for the same reason', async () => {
  /**
   * FetchReport.incomplete: the post loaded with a part that may still arrive (on Reddit, a placeholder
   * render that lacks the body, the author, the counts and the spoiler tag the full page has). The head
   * is not response-cached and the activity document reads the post again. The gallery card would freeze
   * the placeholder, pictures included, into the message, and a spoiler tag that arrives later could not
   * blur them any more.
   */
  const env = envWith(undefined)
  const { ctx } = trackingCtx()
  const rd = (ref, report, complete) => {
    if (!complete && report) report.incomplete = true
    return {
      ref,
      canonical: `https://www.reddit.com/r/${ref.sub}/comments/${ref.id}`,
      author: { name: 'u/example', handle: 'example', url: 'https://www.reddit.com/user/example' },
      title: 'Six photos from the coast', text: '', createdAt: when,
      media: pictures(`https://i.redd.it/${ref.id}`, 6),
      counts: { likes: 4100, replies: 260 }, sensitive: false,
    }
  }
  const partial = { cache: fakeCache(), fetchPost: async (ref, _e, _c, report) => rd(ref, report, false) }
  const html = await (await handle(ask('/r/pics/comments/galpnd1/six_photos/'), env, ctx, partial)).text()
  assert.equal(scriptOf(html), null, 'incomplete: no gallery card')
  assert.match(html, /application\/activity\+json/)

  const whole = { cache: fakeCache(), fetchPost: async (ref, _e, _c, report) => rd(ref, report, true) }
  const control = await (await handle(ask('/r/pics/comments/galpnd2/six_photos/'), env, ctx, whole)).text()
  assert.ok(scriptOf(control), 'the control: the same post, complete, gets the card')
})

test('THE PREVIEW AGREES WITH THE HEAD: no grid while its translation is pending, the grid once it lands', async () => {
  const env = envWith(model(LOSES))
  const { ctx, settle } = trackingCtx()
  const d = { cache: fakeCache(), fetchPost: async ref => igSix(ref) }
  const card = () => handle(ask(`/_card?p=${encodeURIComponent('/p/GaLPend00003')}`, BROWSER), env, ctx, d).then(r => r.json())

  const first = await card()
  assert.equal(first.ok, true)
  assert.equal(first.pending, true, 'the page is told to ask again')
  assert.equal(first.componentGallery, undefined, 'and draws today\'s card meanwhile, as Discord would for that head')

  await settle()
  const second = await card()
  assert.equal(second.pending, false)
  assert.equal(second.componentGallery, true, 'the re-ask finds the translation and draws the grid')
  assert.ok(second.text.includes(EN))
})

test('A TIKTOK SHORT LINK, WHOSE HEAD NEVER TRANSLATES, KEEPS TODAY\'S CARD FOR A CAPTION THAT AWAITS TRANSLATION', async () => {
  /**
   * The short-link arm renders the resolved post without running the translation step, while the
   * activity document behind it does run it. Passing that arm's head through the gallery card would put
   * the raw caption into a card Discord never re-reads. It passes no `pending`, so the card judges from
   * the caption: a Japanese one keeps today's card, and an English one gets the grid.
   */
  const ai = model(0)
  const env = envWith(ai)
  const { ctx } = trackingCtx()
  const slides = (id, text) => ({
    ref: { p: 'tt', id },
    canonical: `https://www.tiktok.com/@someone/photo/${id}`,
    author: { name: 'someone', handle: 'someone', url: 'https://www.tiktok.com/@someone' },
    text, createdAt: when,
    media: pictures(`https://p16-sign.tiktokcdn-us.com/${id}`, 7),
    counts: { likes: 9100, replies: 40, reposts: 12 }, sensitive: false,
  })
  const ja = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'post', post: slides('7000000000000000301', JA) }) }
  const head = await (await handle(ask('/t/GaLPndTT01'), env, ctx, ja)).text()
  assert.equal(scriptOf(head), null, 'a Japanese caption on an untranslated head: no gallery card')
  const doc = await documentFor(head, env, ctx, ja)
  assert.ok(String(doc.content).includes(EN), 'and the document Discord fetches instead translates it')

  const en = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'post', post: slides('7000000000000000302', 'seven slides from the trip') }) }
  const control = await (await handle(ask('/t/GaLPndTT02'), env, ctx, en)).text()
  assert.ok(scriptOf(control), 'an English caption: nothing to wait for, so the grid')

  /**
   * AND THE PREVIEW SAYS THE SAME. /_card resolves the short code and runs the translation, so its post
   * arrives translated, with the marker, and the builder alone would call it settled and answer with
   * the grid that the head above leaves out. The preview has to answer for the head this link gets.
   */
  // The preview loads the resolved post through the post route, so the stub answers there too.
  const preview = async (code, post) => (await handle(ask(`/_card?p=${encodeURIComponent(`/t/${code}`)}`, BROWSER), env, ctx, {
    cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'post', post }),
  })).json()
  const jaPreview = await preview('GaLPndTT03', slides('7000000000000000303', JA))
  assert.equal(jaPreview.ok, true)
  assert.ok(jaPreview.text.includes(EN), 'the preview did translate it')
  assert.equal(jaPreview.componentGallery, undefined, 'but draws no grid, because the short link\'s head carries none')
  const enPreview = await preview('GaLPndTT04', slides('7000000000000000304', 'seven slides from the trip'))
  assert.equal(enPreview.componentGallery, true, 'an English caption: the grid on both')
})

test('SIX PICTURES QUOTING A VIDEO KEEP TODAY\'S CARD, and with it the /p card\'s "Contains video" line', async () => {
  /**
   * A Threads carousel of six quoting a post with a video, shared as /p: the activity card hoists the
   * quote's video in as a still and adds "🎬 Contains video" under the counts. The gallery card has
   * nowhere to say that, so it would leave the reader with no hint there is a video one tap away.
   */
  const env = envWith(undefined)
  const { ctx } = trackingCtx()
  const th = ref => ({
    ref,
    canonical: `https://www.threads.com/@someone/post/${ref.code}`,
    author: { name: 'Someone', handle: 'someone', url: 'https://www.threads.com/@someone' },
    text: 'six from today, and the clip that started it', createdAt: when,
    media: pictures(`https://scontent.cdninstagram.com/v/${ref.code}`, 6),
    counts: { likes: 51 }, sensitive: false,
    quote: {
      ref: { p: 'th', code: `${ref.code}Q` },
      canonical: `https://www.threads.com/@quoted/post/${ref.code}Q`,
      author: { name: 'Quoted', handle: 'quoted', url: 'https://www.threads.com/@quoted' },
      text: 'the clip', createdAt: when, counts: {}, sensitive: false,
      media: [{ kind: 'video', url: 'https://scontent.cdninstagram.com/v/q.mp4', w: 720, h: 1280, poster: 'https://scontent.cdninstagram.com/v/q.jpg' }],
    },
  })
  const d = { cache: fakeCache(), fetchPost: async ref => th(ref) }
  const stills = await (await handle(ask('/@someone/post/GaLPndThr1/p'), env, ctx, d)).text()
  assert.equal(scriptOf(stills), null, '/p: no gallery card')
  const doc = await documentFor(stills, env, ctx, d)
  assert.ok(String(doc.content).includes('Contains video'), 'so the card Discord draws still says the post leads to a video')

  const videos = await (await handle(ask('/@someone/post/GaLPndThr2/v'), env, ctx, d)).text()
  assert.equal(scriptOf(videos), null, '/v: today\'s card too, so /p and /v still differ')
})
