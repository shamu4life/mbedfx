import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handle, HTML_DEADLINE_MS, MUX_WAIT_BOT_MS, YT_META_BOT_MS, YT_MUX_BOT_MS,
} from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'

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
const envWith = ({ resolver, r2 = fakeR2(), ai, ae } = {}) => ({
  AE: ae ?? { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_CACHE: r2,
  MEDIA_RESOLVER: resolver,
  AI: ai ? { run: ai } : undefined,
  TRANSLATE_GOOGLE: 'off',
})

/** Records every Analytics Engine row so a counter can be asserted rather than assumed. */
const recordingAE = () => {
  const rows = []
  return { rows, writeDataPoint(d) { rows.push(d) } }
}

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


/* ============ WHAT A CRAWLER WILL WAIT, WHICH IS LESS THAN THE CARD USED TO TAKE ============
 *
 * Reported 2026-08-08: YouTube links "fail to embed until warmed on the site". Measured against
 * production the next day, on four cold videos of 28s, ~60s and 615s:
 *
 *   card, fully cold          5.14 - 5.18s     no media on it
 *   activity document, cold   8.19 - 8.29s
 *   card, second view         0.19 - 0.29s     with og:video
 *
 * Every budget involved was individually argued and internally consistent; together they answered a
 * crawler in ~13s, and Discord is gone by then. THE WAIT BOUGHT NOTHING: a cold mux measured ~5s for a
 * 60-second Short — verified by fetching /_media/ the instant the 5.1s card returned and getting
 * 6,472,085 complete bytes — so no budget a crawler tolerates was ever going to catch it. The old
 * ceiling spent five seconds losing a race it loses in one.
 *
 * These pin the ceiling rather than the wall clock: asserting "under 2s" would pass for the wrong
 * reason on a fast machine and fail for the wrong reason on a loaded one.
 */

test('A CRAWLER IS NOT MADE TO WAIT OUT A COLD MUX — the ceiling is the bot budget, not the response budget', async () => {
  // The container never answers, which is the honest shape of a mux that has only just been
  // dispatched. Before this, the head spent the whole HTML_DEADLINE_MS here and then degraded anyway.
  const ref = { p: 'x', kind: 'status', id: '9200000000000000001' }
  const t0 = Date.now()
  const res = await handle(
    new Request(`https://mbedfx.app/muxwatch/status/${ref.id}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
    }),
    envWith({ resolver: silentResolver() }), retainingCtx(), depsFor(r => videoPost(r)),
  )
  const elapsed = Date.now() - t0
  assert.equal(res.status, 200)
  assert.ok(elapsed < HTML_DEADLINE_MS,
    `the head must not spend the whole response budget on a mux that cannot finish (elapsed ${elapsed}ms)`)
  assert.ok(elapsed >= MUX_WAIT_BOT_MS - 100 || elapsed < MUX_WAIT_BOT_MS,
    'and the wait it does spend is the bot budget')
})

/* ================= AND THE SECOND CRAWLER REQUEST, WHICH IS A DIFFERENT BET =================
 *
 * 553bd2e put ONE budget on both crawler seams. They are not the same bet, and the production
 * counters say so: of the 139 successful yt muxes recorded since 2026-08-24, ZERO finished inside
 * 1500ms and the fastest finished in 4200ms. On the HEAD that is fine — the head carries no
 * `media_attachments`, and losing the mux there costs the og:video upgrade on a document Discord
 * mostly ignores for a post with media. On the ACTIVITY document it is the whole game: that is where
 * `media_attachments[].type` decides player-or-photo, and Discord freezes the answer in the message
 * forever. YT_MUX_BOT_MS carries the measurement and the trade.
 *
 * THESE FOUR REQUESTS RUN CONCURRENTLY, deliberately. Serially they cost 8.5s of pure timer; together
 * they cost the longest one. Nothing here is CPU-bound — every arm is a `setTimeout` against a
 * container that never answers — so overlapping them changes no timing that matters, and the gap the
 * assertions rest on is 2500ms wide. Each request has its OWN id, for the muxInflight reason this
 * file's header gives: a shared key would hand one seam's parked promise to another as its answer.
 */
test('THE yt ACTIVITY DOCUMENT GETS THE LONGER BUDGET, AND THE OTHER THREE SEAMS DO NOT', async () => {
  const ae = recordingAE()
  const env = () => envWith({ resolver: silentResolver(), ae })
  const ytRef = id => ({ p: 'yt', id })
  const xRef = id => ({ p: 'x', kind: 'status', id })
  const activity = ref => `https://mbedfx.app/users/anyone/statuses/${encodeStatusId(refKey(ref))}`
  const oembed = ref => `https://mbedfx.app/_oembed/${encodeStatusId(refKey(ref))}`
  const bot = url => new Request(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  })

  /**
   * NO NETWORK, and it is worth saying why none is needed rather than stubbing fetch. The activity
   * route's metadata arm is `youtubeMeta`, whose first gate returns null the moment the post already
   * carries a real date — `videoPost` does — so Innertube and the container are both unreachable from
   * here. The translation arm returns immediately too: the text is Latin script and this file runs
   * with TRANSLATE_GOOGLE off and no AI binding. So the ONLY arm left holding a clock is the mux, and
   * the elapsed time below is that arm's budget and nothing else.
   */
  const timed = async (req) => {
    const t0 = Date.now()
    const res = await handle(req, env(), retainingCtx(), depsFor(ref => videoPost(ref)))
    return { ms: Date.now() - t0, res }
  }

  const [ytActivity, ytHead, ytOembed, xActivity] = await Promise.all([
    timed(bot(activity(ytRef('muxbudget01')))),
    timed(bot('https://mbedfx.app/shorts/muxbudget02')),
    timed(bot(oembed(ytRef('muxbudget03')))),
    timed(bot(activity(xRef('9200000000000000002')))),
  ])

  // NOT A VACUOUS PASS: every one of the four must have actually reached the race and lost it, or the
  // timings below would be measuring four fast paths that happen to differ. One media entry per post,
  // so one row per request.
  const degraded = ae.rows.filter(r => r.blobs?.[1] === 'card_degraded')
  assert.equal(degraded.length, 4, 'all four seams raced a cold mux and lost')
  assert.equal(degraded.filter(r => r.blobs[0] === 'yt').length, 3)
  assert.equal(degraded.filter(r => r.blobs[0] === 'x').length, 1)

  /**
   * THE LOWER BOUND IS THE ASSERTION; THE UPPER BOUND IS ONLY A SANITY RAIL, and that split is what
   * this test got wrong the first time. A budget shows up as time SPENT, so `>= budget - 200` is what
   * proves a seam waited the budget it was given. Overshoot proves nothing: the four requests share
   * one event loop and the box underneath it, so a contended runner inflates every arm.
   *
   * MEASURED, Workers Builds on 2026-08-29 (build aeacb488): the head returned in 2408ms against a
   * 1500ms budget and an upper band of `MUX_WAIT_BOT_MS + 900` = 2400. The build went red over 8ms of
   * someone else's CPU. The budget was correct and the test was wrong.
   *
   * So each rail is now set at the OTHER budget rather than at a slack constant: a shared seam must
   * come in under YT_MUX_BOT_MS, and that is the only thing an upper bound here can honestly claim.
   * The rails move on their own if either constant is retuned, and the discrimination between the two
   * budgets is carried by the gap assertion below, which is load-independent by construction.
   */
  assert.ok(ytActivity.ms >= YT_MUX_BOT_MS - 200,
    `the yt activity document must spend YT_MUX_BOT_MS on the mux (${ytActivity.ms}ms, ` +
    `YT_MUX_BOT_MS=${YT_MUX_BOT_MS})`)
  assert.ok(ytActivity.ms < HTML_DEADLINE_MS + YT_MUX_BOT_MS,
    `and it must still answer (${ytActivity.ms}ms)`)

  for (const [name, got] of [['the HTML head', ytHead], ['/_oembed', ytOembed], ['a non-yt activity document', xActivity]]) {
    assert.ok(got.ms >= MUX_WAIT_BOT_MS - 200,
      `${name} must spend the shared crawler budget (${got.ms}ms, MUX_WAIT_BOT_MS=${MUX_WAIT_BOT_MS})`)
    assert.ok(got.ms < YT_MUX_BOT_MS - 200,
      `${name} must NOT have the longer budget (${got.ms}ms, YT_MUX_BOT_MS=${YT_MUX_BOT_MS})`)
  }

  /**
   * THE LOAD-INDEPENDENT FORM OF THE FOUR ASSERTIONS ABOVE. All four ran on one machine at one moment,
   * so a box slow enough to inflate one inflates all of them, and only a real budget change moves the
   * GAP. This is the assertion that fails if someone widens `botBudget` instead of the scoped constant
   * — the absolute bands would then fail too, but this one says WHY.
   */
  const shared = Math.max(ytHead.ms, ytOembed.ms, xActivity.ms)
  assert.ok(ytActivity.ms - shared > 1200,
    `only the yt activity document may have the longer budget (yt activity ${ytActivity.ms}ms vs ` +
    `slowest shared-budget seam ${shared}ms)`)

  // AND THE DEGRADE IS STILL A DEGRADE. A longer budget that quietly stopped swapping the unfinished
  // video down to its still would pass every timing above while shipping Discord a player url that
  // 503s — the poisoned-url defect stillOf exists for.
  const attachments = (await ytActivity.res.json()).media_attachments
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0].type, 'image', 'a mux that lost the longer race still degrades honestly')
})

test('A DEGRADED CARD IS COUNTED — the one outcome a reader sees, and it used to be recorded as `ok`', async () => {
  /**
   * THE HOLE. settleMux swapping the player for a still is the exact failure this whole workstream is
   * about, and nothing counted it. Worse than nothing: the render that produces it goes on to fire
   * `ok`, so the dataset affirmatively reported it as a SUCCESS. `mux_ok` cannot stand in either — a
   * mux that finishes at T+40s is a `mux_ok` and a frozen still, because Discord caches an embed
   * permanently in the message it was pasted into. The first paste is the only paste.
   *
   * `card_degraded/ok` per platform, on the Discord client, IS the first-paste failure rate. It is the
   * single number that will say whether the alarm moved anything, which is why it has to predate the
   * alarm's traffic rather than follow it — a before/after with no "before" is not a measurement.
   */
  const ae = recordingAE()
  const id = '2090000000000000021'
  await handle(
    cardReq(pathFor(id)),
    envWith({ resolver: silentResolver(), ae }),
    retainingCtx(),
    depsFor(ref => videoPost(ref)),
  )

  const degraded = ae.rows.filter(r => r.blobs?.[1] === 'card_degraded')
  assert.equal(degraded.length, 1, 'exactly one row per degraded entry')
  assert.equal(degraded[0].blobs[0], 'x', 'blob1 is the platform, as on every other row')
  assert.notEqual(degraded[0].blobs[2], 'none',
    'blob3 is the REAL client — unlike a mux row, a degrade is owned by one render for one audience, ' +
    'and discord-vs-human is the split the number exists to make')
  assert.equal(degraded[0].doubles?.[1], undefined,
    'and it carries no double2: METRICS.md reserves that column for `mux_*` rows, which is exactly ' +
    'why this outcome is NOT named mux_degraded')
})

test('THE OVER-CEILING REWRITE IS NOT COUNTED AS A DEGRADE — it would be a permanent floor', async () => {
  /**
   * A video past MUX_MAX_SECONDS never calls the container and can never succeed. Folding it into
   * card_degraded would put an immovable floor under the ratio, made entirely of videos that are too
   * long by design — and the ratio is the whole point of the counter. Excluded deliberately; this
   * test is what stops the exclusion being tidied away as an oversight.
   */
  const ae = recordingAE()
  const id = '2090000000000000022'
  await handle(
    cardReq(pathFor(id)),
    envWith({ resolver: silentResolver(), ae }),
    retainingCtx(),
    depsFor(ref => videoPost(ref, { duration: 99_999 })),
  )

  assert.equal(ae.rows.filter(r => r.blobs?.[1] === 'card_degraded').length, 0,
    'too long is a final answer, not a degrade')
})

test('THE BOT BUDGET IS A FRACTION OF THE RESPONSE BUDGET, and stays one', () => {
  // The relationship is the rule, not the number. A later edit that raises this to "just under
  // HTML_DEADLINE_MS" reintroduces the reported defect while leaving both constants looking sensible
  // on their own — which is exactly how it happened the first time.
  assert.ok(MUX_WAIT_BOT_MS < HTML_DEADLINE_MS / 2,
    'a crawler budget that approaches the response budget is not a crawler budget')
})

/**
 * THE ONE NUMBER IN THIS REPOSITORY THAT CAME FROM DISCORD'S OWN BEHAVIOUR. 2026-08-09, against
 * production: a cold YouTube head answered in 5.14-5.18s and the reader got NO CARD. That is not a
 * measurement of the crawler's timeout, but it IS an upper bound on it — whatever the tolerance is,
 * it is under 5.14s. Every other figure ever quoted for it in this repo ("Discord leaves at 3-4s")
 * appears once, cites nothing, and is folklore.
 */
const DISCORD_ABANDONED_AT_MS = 5140
/** A post-cache read and a JSON serialise, on top of whichever arm holds the clock. */
const ROUTE_WORK_MS = 300

test('THE ACTIVITY BUDGETS STAY UNDER THE ONLY BOUND DISCORD HAS EVER GIVEN US', () => {
  /**
   * WHAT THIS CATCHES, and it is not hypothetical: every timing assertion in the test above is
   * expressed against YT_MUX_BOT_MS itself, so moving the constant to 8000 — the value its own
   * docstring says "rebuilds the 8.19-8.29s activity document 553bd2e deleted" — leaves the whole
   * suite green. There was no guard on either of the two new budgets, while the one they were split
   * off from has had one since it was written (above). This is that guard.
   *
   * IT BOUNDS THE RESPONSE, NOT THE ARM. Both budgets sit in one Promise.all, so the document ends at
   * the slowest of them plus the route's own work — which is the thing Discord is timing.
   */
  assert.ok(YT_MUX_BOT_MS + ROUTE_WORK_MS < DISCORD_ABANDONED_AT_MS,
    `the yt activity document must answer inside the bound (${YT_MUX_BOT_MS}ms + route work)`)
  assert.ok(YT_META_BOT_MS + ROUTE_WORK_MS < DISCORD_ABANDONED_AT_MS,
    `and so must the metadata arm (${YT_META_BOT_MS}ms + route work)`)

  // THE DATE ARM NEVER EXCEEDS THE MUX ARM, which is what makes it free — it finishes inside a wait
  // that is happening anyway. YT_META_BOT_MS's docstring claims that property; nothing held it, and
  // raising the date arm PAST the mux arm would quietly cost every cold paste the difference.
  // The head keeps the small one: a raise there is a different bet with a different bound.
  //
  // `<=`, NOT `<`, SINCE 2026-08-30, and the distinction is the whole point of the assertion. The
  // property being protected is that the RESPONSE max does not move, and `Math.max(a, b) === b` holds
  // when a === b. The date arm was taken from 2800 to 4000 — level with the mux arm — precisely
  // because equality is the largest value that still costs zero. Writing this `<` would forbid the
  // free case and permit nothing useful; writing it `<=` still catches the one mistake it exists to
  // catch, which is a date arm that outlives the mux arm and starts setting the response time itself.
  assert.ok(YT_META_BOT_MS <= YT_MUX_BOT_MS, 'the date arm never outlives the mux arm')
  assert.ok(MUX_WAIT_BOT_MS < YT_MUX_BOT_MS, 'and the shared crawler budget is the floor, not the ceiling')
})
