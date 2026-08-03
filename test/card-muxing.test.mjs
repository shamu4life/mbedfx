import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'

/**
 * `muxing` ON /_card — THE ONE WAY THE CONVERTER PAGE CAN KNOW A VIDEO IS COMING.
 *
 * THE DEFECT IT EXISTS FOR. settleMux degrades an unfinished remux to its POSTER STILL and keeps the
 * download alive in waitUntil. What comes back is a perfectly ordinary picture: kind 'image', a url
 * that resolves, correct dimensions, nothing wrong with it anywhere in the payload. So the reader who
 * has just pasted a YouTube link sees a frozen frame and no reason for it, and asks why a link that is
 * completely fine "is just an image". Every other surface self-heals — a degraded card is deliberately
 * not response-cached, so Discord's next unfurl promises the real video — but the page fetches /_card
 * once per typing-settle and draws the answer. It is the seam with no next render, so the incompleteness
 * has to be IN the answer.
 *
 * WHY BOTH DIRECTIONS ARE PINNED HERE, and why `false` matters as much as `true`. The page branches on
 * the field directly (`j.muxing ? spinner : play`) and, when it is true, sets a timer to re-fetch
 * /_card up to MUX_POLL_MAX times. So the two ways to get this wrong are symmetric and both bad:
 *   - false-negative -> the spinner never appears, and the reported "why is this just an image" stands.
 *   - false-positive, or `undefined` where the page expected a boolean -> a spinner over a card that is
 *     already final, plus ten needless round-trips behind it. An indicator that spins forever is a lie
 *     of a different kind from no indicator at all.
 * `settled.degraded === true` is written with an explicit comparison for exactly that reason, and these
 * tests pin the shape of the field, not merely its truthiness.
 *
 * AND IT IS NOT `pending`. That flag means a TRANSLATION lost its race; this one means a VIDEO has not
 * landed. They are produced by two different halves of one Promise.all, they clear on different
 * schedules, and the page reacts to them differently (one re-fetch, versus a capped poll). Conflating
 * them was the risk worth writing a test against.
 *
 * Every test gets its OWN status id. muxInflight is a module-level map keyed on `mux/{refKey}/{i}`, so
 * a shared id would hand one test's parked promise to another test as its answer — and the whole point
 * of the never-answering container below is that its promise stays parked for the life of the process.
 */

// NO CRAWLER UA ANYWHERE IN THIS FILE. /_card is an XHR from the converter page, classified `human`,
// which is the whole reason the endpoint exists: a browser fetching the converted url gets a 302, not
// an embed, so the preview has to be described as data.
const cardReq = path => new Request(`https://mbedfx.app/_card?p=${encodeURIComponent(path)}`)
const pathFor = id => `/muxwatch/status/${id}`

/**
 * A ctx that RETAINS background work and never awaits it, which is deliberate rather than lazy here: a
 * mux that has not finished is modelled by a promise that never settles, so a `settle()` helper of the
 * kind the translation tests use would hang this file forever. What outlives the response is exactly
 * what these tests are about; none of them needs it to finish.
 */
const retainingCtx = () => {
  const kept = []
  return { waitUntil(p) { kept.push(p) } }
}

const fakeCache = () => {
  const m = new Map()
  return {
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}

/** MEDIA_CACHE stands in for R2, which here holds BOTH muxed mp4s and translation records. */
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

/**
 * TRANSLATE_GOOGLE IS OFF THROUGHOUT, for translate-deadline.test.mjs's reason: Google is tried first
 * and it is the live internet. Nothing in this file is about the translation ENGINE, only about whether
 * its flag can be told apart from the mux's.
 */
const envWith = ({ resolver, r2 = fakeR2(), ai } = {}) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: r2,
  MEDIA_RESOLVER: resolver,
  AI: ai ? { run: ai } : undefined,
  TRANSLATE_GOOGLE: 'off',
})

const depsFor = post => ({
  cache: fakeCache(),
  fetchPost: async ref => post(ref),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

/** A post carrying a `{page}` remux video — the only shape settleMux does anything at all for. */
const videoPost = (ref, over = {}) => ({
  ref,
  canonical: `https://twitter.com/muxwatch/status/${ref.id}`,
  author: { name: 'mux watch', handle: 'muxwatch', url: 'https://twitter.com/muxwatch' },
  text: 'a clip that has to be muxed before anyone can play it',
  createdAt: new Date('2026-08-02T00:00:00Z'),
  counts: {}, sensitive: false,
  media: [{
    kind: 'video',
    url: 'https://example.invalid/v',
    // 0x0 is CORRECT on a remux video and is not the bug it looks like — the poster's own size rides
    // separately, which is what the degraded still inherits. See Media.posterW.
    w: 0, h: 0,
    poster: 'https://example.invalid/p.jpg', posterW: 480, posterH: 360,
    remux: { page: 'https://example.invalid/page/1' },
    ...over,
  }],
})

/**
 * A CONTAINER THAT NEVER ANSWERS — the honest shape of a cold mux. No timer of its own: the budget's
 * own `setTimeout` is what decides the race, so this measures settleMux's deadline rather than racing
 * a second clock against it.
 */
const silentResolver = () => ({ getByName: () => ({ fetch: () => new Promise(() => {}) }) })

/** A container that refuses. Fast, and indistinguishable to settleMux from the one above — see below. */
const failingResolver = () => ({ getByName: () => ({ fetch: async () => new Response('', { status: 502 }) }) })

/**
 * WHAT THIS FILE'S WALL CLOCK IS MADE OF, and one thing it used to be made of. The only case here that
 * SHOULD cost real time is the deadline test below, which has to outlast the mux budget.
 *
 * It cost eight seconds more than that when it was written, and the reason was in settleMux rather than
 * in the tests: it raced its work against a bare `setTimeout(resolve, budgetMs)` and never cleared it,
 * so every case that reached the race left a 9-second timer armed even when the container answered in a
 * millisecond, and `node --test` holds the process open until the last one fires. That is the same
 * defect the `deadline()` helper carries a comment about ("an uncleared one … added 6s to this suite
 * before it was cleared, which is how it was noticed"). settleMux now uses that helper, and this file
 * exits when its last test does — so if it ever idles again, the timer is the first place to look.
 */

const JA = '今夜はラテちゃんお昼寝サービス動画 需要があれば今度ノーカット版もどこかで'

test('A VIDEO STILL MUXING IS REPORTED AS SUCH — the page cannot see it any other way', async () => {
  /**
   * THE HEADLINE CONTRACT, and the one that has to survive the budget expiring rather than a container
   * error. The mux here is simply not finished: the resolver holds its answer forever, settleMux's own
   * timer wins the race, and the entry is swapped down to the still.
   *
   * The assertions after the flag are the reason the flag is needed. Read the payload with `muxing`
   * removed and there is NOTHING in it that says this card is not final: an image entry, a poster that
   * resolves, real dimensions. That is what the reader was being shown, with no explanation.
   *
   * COSTS THE MUX BUDGET IN WALL CLOCK, on purpose (CARD_DEADLINE_MS, currently aliased to
   * MUX_WAIT_API_MS = 9s). A container that answers quickly, even with a failure, exercises a different
   * branch — see the next test. Shortening this by making the container fail fast would leave the
   * deadline path, which is the one every real cold video takes, untested.
   */
  const id = '2090000000000000001'
  const res = await handle(
    cardReq(pathFor(id)),
    envWith({ resolver: silentResolver() }),
    retainingCtx(),
    depsFor(ref => videoPost(ref)),
  )
  const j = await res.json()

  assert.equal(j.ok, true)
  assert.equal(j.muxing, true, 'the one fact the payload could not previously carry')

  // And the rest of the answer, which is why it could not be inferred from anything else.
  assert.equal(j.media.length, 1)
  assert.equal(j.media[0].kind, 'image', 'the degrade produces an ordinary picture entry')
  assert.match(j.media[0].poster, /\/poster0$/, 'addressed at the poster slot, not the 503-ing video one')
  assert.equal(j.media[0].w, 480, 'and it carries the POSTER\'s size, not the video\'s 0x0')
  assert.equal(j.media[0].h, 360)
  assert.equal(j.pending, false, 'nothing about the translation is being reported here')
})

test('A CONTAINER THAT REFUSED IS muxing:true TOO — settleMux cannot tell "not yet" from "not ever"', async () => {
  /**
   * PINNING A LIMITATION RATHER THAN A DESIGN, so the next reader does not discover it in production.
   *
   * `degraded` answers one question — "is the video on this card?" — and a 502 from the resolver and a
   * download that is still running produce the identical answer through the identical line. So the page
   * will show "Preparing the video" for a mux that is never going to arrive.
   *
   * WHY THAT IS ACCEPTABLE HERE and not merely unfixed: the page's poll is capped (MUX_POLL_MAX = 10,
   * 25s) and at the cap the spinner is replaced with a sentence rather than removed, so the failure mode
   * of guessing wrong is a stale reassurance for half a minute, not an indicator spinning forever. The
   * alternative — reporting a refusal as "final" — would need settleMux to distinguish a transient
   * container error from a permanent one, which it cannot do from a status code (an exhausted instance
   * pool and a broken video both 502).
   *
   * Cheap, unlike the test above, precisely BECAUSE the answer arrives: this is the `head === null`
   * branch, not the deadline branch. Both set the flag; only one of them costs nine seconds to reach.
   */
  const id = '2090000000000000002'
  const j = await (await handle(
    cardReq(pathFor(id)),
    envWith({ resolver: failingResolver() }),
    retainingCtx(),
    depsFor(ref => videoPost(ref)),
  )).json()

  assert.equal(j.ok, true)
  assert.equal(j.muxing, true)
  assert.equal(j.media[0].kind, 'image')
})

test('NOTHING TO MUX IS muxing:false, NOT undefined AND NOT ABSENT — the page branches on the field', async () => {
  /**
   * `settled.degraded === true` rather than `settled.degraded`, and this is the test that would fail if
   * anyone "simplified" it back. settleMux's early returns are already `{degraded: false}`, so the
   * comparison looks redundant — until the day a fourth early return forgets the field, at which point
   * the page reads `undefined`, which is falsy and therefore silently right for the spinner and silently
   * WRONG for anything that checks the field's presence (a JSON consumer, or a future `muxing === false`
   * branch meaning "confirmed final"). Response.json also DROPS an undefined value entirely, so the
   * field would not merely be false, it would be gone.
   *
   * Two shapes, because they short-circuit at different points: a post with a plain image never reaches
   * the remux scan, and a post with no media at all never reaches the media loop.
   */
  const still = { kind: 'image', url: 'https://example.invalid/a.jpg', w: 1152, h: 620 }
  const shapes = [
    ['a plain image post', '2090000000000000003', ref => ({ ...videoPost(ref), media: [still] })],
    ['a text-only post', '2090000000000000004', ref => ({ ...videoPost(ref), media: [] })],
  ]
  for (const [what, id, post] of shapes) {
    const j = await (await handle(
      cardReq(pathFor(id)),
      envWith({ resolver: failingResolver() }),
      retainingCtx(),
      depsFor(post),
    )).json()
    assert.equal(j.ok, true, what)
    assert.equal(j.muxing, false, `${what}: false, not undefined`)
    assert.equal(typeof j.muxing, 'boolean', `${what}: the page reads a boolean`)
    assert.ok(Object.hasOwn(j, 'muxing'), `${what}: and Response.json must have serialized it at all`)
  }
})

test('A MUX ALREADY IN R2 CLEARS THE FLAG — a warm video is not "preparing"', async () => {
  /**
   * THE OTHER DIRECTION OF THE SAME MISTAKE. The page polls /_card while this is true, so a flag that
   * stayed set once the mp4 landed would poll ten times and then tell the reader their finished video is
   * still being prepared — on the one surface where nothing later corrects it.
   *
   * The warm object is seeded directly, which is exactly what the SECOND view of any video sees:
   * ensureMuxed's first step is an R2 head, and a hit returns before the container is ever addressed.
   * The resolver is deliberately the FAILING one — if it is asked anything at all, this test is not
   * measuring the warm path.
   */
  const id = '2090000000000000005'
  const r2 = fakeR2()
  // `mux/{refKey}/{index}` — the key ensureMuxed reads. refKey is imported rather than spelled out so a
  // change to the key SHAPE cannot leave this test quietly seeding a key nobody looks at.
  r2.store.set(`mux/${refKey({ p: 'x', id })}/0`, 'MP4')
  const j = await (await handle(
    cardReq(pathFor(id)),
    envWith({ resolver: failingResolver(), r2 }),
    retainingCtx(),
    depsFor(ref => videoPost(ref)),
  )).json()

  assert.equal(j.ok, true)
  assert.equal(j.muxing, false, 'the video is here; there is nothing to wait for')
  assert.equal(j.media[0].kind, 'video', 'and the card promises the player, not a still')
})

test('A DEPLOY WITH NO CONTAINER IS muxing:false — a spinner for work that will never start', async () => {
  /**
   * withResolver degrades every remux video to its still INSIDE getPost when the bindings are absent, so
   * settleMux sees no `remux.page` at all and returns early. The card is a picture and that is final:
   * nothing is running in waitUntil, nothing will land, and a poll would ask the same question ten times
   * for an answer that cannot change. This is the shape `wrangler dev` has by default and the shape the
   * README's self-hosting section produces, so it is not a hypothetical.
   */
  const id = '2090000000000000006'
  const env = envWith({ resolver: undefined })
  const j = await (await handle(cardReq(pathFor(id)), env, retainingCtx(), depsFor(ref => videoPost(ref)))).json()

  assert.equal(j.ok, true)
  assert.equal(j.muxing, false)
  assert.equal(j.media[0].kind, 'image', 'the cover still, exactly as before playback existed')
})

test('A VIDEO OVER THE MUX CEILING IS muxing:false — that answer is FINAL, and the spinner would never stop', async () => {
  /**
   * THE CASE MOST LIKELY TO BE "FIXED" INTO A BUG, because from the outside it looks like the first test
   * in this file: a remux video whose mp4 is not on the card. It is the opposite situation. The
   * container refuses anything over MUX_MAX_SECONDS with its own match filter, so no mux is dispatched
   * and nothing is running in waitUntil — settleMux returns WITHOUT setting `degraded`, deliberately, so
   * the card stays response-cacheable instead of re-paying the whole slow path forever for an outcome
   * that will be identical in thirty days.
   *
   * On this surface that decision has a second consequence, which is what this test is for: `muxing`
   * must stay false, or the page spins for 25 seconds and then says "still preparing" about a video
   * nobody is preparing. The card already tells the reader the truth in WORDS (the length note); a
   * spinner would be the same payload contradicting it.
   *
   * 4000s is comfortably over the ceiling (1500 at the time of writing) — "over it" is the contract, not
   * the number, so this does not import a constant it would then be pinning in two places.
   *
   * THE MEDIA ASSERTIONS ARE REWRITTEN, 2026-08-03, and the first version of them is worth knowing about
   * because it was TRUE. settleMux's over-ceiling arm built the poster still and then threw it away:
   * the rewritten array was only used on the `degraded` return, and this arm deliberately does not set
   * that flag, so a single-video post (i.e. every one of these) kept its remux VIDEO entry and both heads
   * went on advertising a player whose bytes the container refuses forever. Reachable on the yt-dlp tier,
   * whose normalizer puts `duration` on the media entry at FETCH time — see the Dailymotion pair in
   * test/ytdlp-tier.test.mjs, whose fixture is 4830s and which asserted that dead og:video until the same
   * day. settleMux now carries a second flag for "changed" alongside "incomplete", so the still is
   * applied, and both arms build it with one `stillOf` so their shapes cannot drift.
   *
   * WHAT DID NOT CHANGE, and is the whole reason this test lives in this file: `muxing` stays FALSE
   * through all of it. The still is now the final answer instead of an intended one, and neither shape
   * was ever waiting for anything.
   */
  const id = '2090000000000000007'
  const j = await (await handle(
    cardReq(pathFor(id)),
    envWith({ resolver: failingResolver() }),
    retainingCtx(),
    depsFor(ref => videoPost(ref, { duration: 4000 })),
  )).json()

  assert.equal(j.ok, true)
  assert.equal(j.muxing, false, 'nothing is coming to replace this card')
  assert.equal(j.media[0].kind, 'image', 'the still is applied now, not computed and discarded')
  // BOTH keys name the poster slot, which is what says `posterOnly` survived: bytesIndex moves a flagged
  // still off the numeric slot, and the numeric slot is video-bytes-or-503 forever.
  assert.match(j.media[0].url, /\/poster0$/, 'addressed where the picture actually is')
  assert.match(j.media[0].poster, /\/poster0$/)
  assert.doesNotMatch(j.media[0].url, /\/0$/, 'never the video slot the container will not fill')
  assert.equal(j.media[0].w, 480, 'and the POSTER\'s size, or Discord lays out nothing at all')
  assert.equal(j.media[0].h, 360)
})

test('muxing AND pending ARE INDEPENDENT — two failure modes, and each needs its own flag', async () => {
  /**
   * THE CONFLATION THIS PREVENTS. Both flags mean "this answer is incomplete", and a single `incomplete`
   * boolean would have been the obvious economy. It is wrong in both directions and the page proves it:
   * `pending` earns exactly ONE re-fetch (a second inference costs real money and a translation that
   * misses two races is not worth waiting for), while `muxing` earns a capped POLL (a mux is bounded by
   * the source, not by us — a 40-second clip is ready almost immediately and a 20-minute one is not).
   * Merged, a slow translation would poll ten times and a cold video would be given up on after one.
   *
   * All three combinations are asserted because the failure that matters is one flag LEAKING into the
   * other, and a test of only the corners could pass while `muxing` was simply `pending` spelled twice.
   */
  /**
   * A MODEL THAT NEVER ANSWERS, for silentResolver's reason and one more: a `setTimeout` long enough to
   * lose the race is still a live handle when the test ends, and node keeps the process alive for it —
   * this file would otherwise idle for seconds after its last assertion, paying wall clock for nothing.
   * XLATE_MAX_WAIT_MS is the clock that decides this race; it does not need a second one to run against.
   */
  const slowModel = () => new Promise(() => {})

  // 1. A mux that has not landed, on an English post: the translation is never even attempted.
  const a = await (await handle(
    cardReq(pathFor('2090000000000000008')),
    envWith({ resolver: failingResolver(), ai: slowModel }),
    retainingCtx(),
    depsFor(ref => videoPost(ref)),
  )).json()
  assert.equal(a.muxing, true, 'the video is not here')
  assert.equal(a.pending, false, 'and the text is complete — a mux must not report a translation')

  // 2. A translation that lost its race, on a post with NO media: nothing was ever muxed.
  const b = await (await handle(
    cardReq(pathFor('2090000000000000009')),
    envWith({ resolver: failingResolver(), ai: slowModel }),
    retainingCtx(),
    depsFor(ref => ({ ...videoPost(ref), text: JA, media: [] })),
  )).json()
  assert.equal(b.pending, true, 'the translation is still coming')
  assert.equal(b.muxing, false, 'and a lost translation must not put a spinner on a picture')

  // 3. BOTH AT ONCE, which is the combination a merged flag makes unrepresentable: the page needs to
  //    poll for the video AND re-ask for the translation, and it can only do that if it is told twice.
  const c = await (await handle(
    cardReq(pathFor('2090000000000000010')),
    envWith({ resolver: failingResolver(), ai: slowModel }),
    retainingCtx(),
    depsFor(ref => ({ ...videoPost(ref), text: JA })),
  )).json()
  assert.equal(c.muxing, true, 'a foreign-language video post is incomplete in two independent ways')
  assert.equal(c.pending, true)
})
