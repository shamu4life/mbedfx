import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseInnertube, fetchInnertube } from '../src/platforms/youtube/innertube.ts'
import { fetchYouTube } from '../src/platforms/youtube/fetch.ts'

/**
 * THE YOUTUBE DATE, FROM YOUTUBE'S OWN PLAYER API.
 *
 * WHAT THIS FIXES, so the tests below read as a defect report rather than a feature. Every YouTube
 * card rendered "1 January 1970" with an empty body from ~2026-08-18 to 2026-08-27. The date, the
 * description and the counts came from a `yt-dlp -J` extract inside the media container, and that
 * extract never finished for a caller still listening: measured 2026-08-25, the R2 meta record
 * existed under generations g8 and g10 and under NEITHER g11 nor g12 for any id checked, while
 * `wrangler tail` showed every request-scoped container call ending `canceled` at 1.3-1.8s.
 *
 * Discord caches the embed it gets permanently (jhgg, discord-api-docs#1663), so the first paste is
 * the only paste and a card cannot wait seconds for a date.
 *
 * THE FIXTURES ARE REAL, captured 2026-08-27 from the live endpoint and trimmed to the three subtrees
 * the parser reads with no value edited. The ordinary one is `dQw4w9WgXcQ`, chosen because this
 * repo's own R2 bucket still holds the container's answer for that id under generation g10 —
 * `{"timestamp":1256453853,"description":"The official video for “Never Gonna Give You Up” by Rick
 * Astley.",...}` — so the two independent sources can be asserted against each other rather than
 * against something this test made up.
 */

const fixture = name =>
  JSON.parse(readFileSync(new URL(`./fixtures/youtube-innertube-${name}.json`, import.meta.url), 'utf8'))

const REF = { p: 'yt', id: 'dQw4w9WgXcQ' }

test('THE TWO SOURCES AGREE EXACTLY — Innertube reproduces the container\'s own stored timestamp', () => {
  /**
   * 1256453853 is not a number this test chose. It is what `yt-dlp -J` returns for dQw4w9WgXcQ, it is
   * what is stored in this bucket's surviving g10 record, and it is what
   * `Date.parse('2009-10-24T23:57:33-07:00') / 1000` evaluates to. Three independent derivations, one
   * value — which is the entire argument for replacing a 15.9s container call with a 0.23s fetch.
   */
  const got = parseInnertube(fixture('ordinary'))
  assert.ok(got, 'an ordinary public video must parse')
  assert.equal(Date.parse(got.uploadedAt) / 1000, 1256453853)
  assert.equal(got.duration, 213)
  assert.equal(got.description, 'The official video for “Never Gonna Give You Up” by Rick Astley.',
    'byte-identical to the description the container stored in the g10 record')
  assert.equal(got.ageLimit, undefined, 'an ordinary video carries no age wall')
  assert.ok(got.views > 1_000_000_000)
})

test('THE METADATA SURVIVES A `playabilityStatus` YOUTUBE CALLS A FAILURE, and that is the whole trick', () => {
  /**
   * Asked this way, an ordinary public video answers `UNPLAYABLE / "Video unavailable"` while
   * `videoDetails` and `microformat` stay fully populated. We read the metadata and ignore the
   * verdict. This assertion exists because that is also the single fragile thing about the approach:
   * if Google ever empties videoDetails on a non-OK status — a sibling client, ANDROID_VR, already
   * does — this test is what says so out loud instead of the cards quietly going back to 1970.
   */
  const raw = fixture('ordinary')
  assert.equal(raw.playabilityStatus.status, 'UNPLAYABLE')
  assert.ok(parseInnertube(raw)?.uploadedAt, 'metadata must still be readable at UNPLAYABLE')
})

test('THE AGE WALL IS READ FROM status + reason, NOT from isFamilySafe', () => {
  /**
   * `LOGIN_REQUIRED` + "Sign in to confirm your age" reproduces the container's `age_limit: 18`
   * exactly. `isFamilySafe` is NOT the discriminator — an ordinary public video can report it false
   * and a gated one true — so keying on it would put the 🔞 note on cards that do not deserve one.
   */
  const got = parseInnertube(fixture('agegated'))
  assert.equal(got.ageLimit, 18)
  assert.equal(Date.parse(got.uploadedAt) / 1000, 1605871096, 'and the date still comes through')
})

test('LOGIN_REQUIRED WITHOUT AN AGE REASON IS NOT AN AGE WALL — private and members-only are different cards', () => {
  const raw = fixture('agegated')
  raw.playabilityStatus.reason = 'This video is private'
  assert.equal(parseInnertube(raw)?.ageLimit, undefined,
    'both halves are required, or a private video wears the 🔞 note')
})

test('A LIVESTREAM\'S ZERO DURATION IS ABSENT, NOT ZERO', () => {
  // settleMux reads `duration` to refuse an over-ceiling mux. A zero would read as "safely under the
  // ceiling", which is the opposite of what an unknown duration means.
  const raw = fixture('ordinary')
  raw.videoDetails.lengthSeconds = '0'
  assert.equal(parseInnertube(raw)?.duration, undefined)
})

// ── Is there a finished file to mux? (2026-08-29)

/**
 * THE FOUR BROADCAST STATES, ONE ID EACH, ALL CAPTURED THE SAME DAY. The two fixtures are real
 * captures trimmed to the subtrees the parser reads, with no value edited; the scheduled body below
 * is the measured shape written out inline, because it is four fields and a third fixture of a stream
 * that has since aired would be a fixture nobody can re-capture.
 *
 * THE DEFECT ALL FOUR EXIST FOR: a live stream reports `lengthSeconds: '0'`, so settleMux's
 * over-ceiling arm — the only refusal that existed — saw no duration and dispatched a mux the
 * container refuses on `!is_live`. Measured on yt:xDWQ3LkccY8: pinned at `muxing: true`, never
 * cached, every render, forever.
 */
test('A LIVE STREAM IS LIVE, AND ITS LENGTH IS STILL NOTHING', () => {
  const got = parseInnertube(fixture('live'))
  assert.equal(got.isLive, true, 'yt:xDWQ3LkccY8, Sky News, streaming when captured')
  assert.equal(got.duration, undefined, "lengthSeconds '0' is unknown, not a zero-second video")
  assert.ok(got.uploadedAt, 'and the rest of the card is perfectly readable')
  assert.ok(got.description)
})

test('AN ENDED STREAM IS AN ORDINARY VOD — isLiveContent IS NOT THE DISCRIMINATOR', () => {
  /**
   * The case that decides whether this guard is safe to ship. yt:0cVnt1bUzLI is a NASA broadcast that
   * ended an hour before it was captured: `isLiveContent: true`, `isLive` absent, and
   * `liveBroadcastDetails.endTimestamp` set. Keying on `isLiveContent` — the field that looks like the
   * obvious one — would refuse a mux for every past stream any channel has ever published.
   */
  const raw = fixture('endedlive')
  assert.equal(raw.videoDetails.isLiveContent, true, 'the trap is present in the fixture')
  const got = parseInnertube(raw)
  assert.equal(got.isLive, false, 'an ended stream muxes like any other video')
  assert.equal(got.duration, 3764, 'and it has a real length, which is what the ceiling then judges')
})

test('A SCHEDULED STREAM COUNTS AS LIVE — it fails the same way, so it is refused the same way', () => {
  /**
   * Measured on yt:wEpMzbXi1CM (Sky News "Mornings", captured the day before it aired). It reports
   * NEITHER `isLive` nor `isLiveNow` — the two fields the obvious implementation reads — so the third
   * arm is what catches it: a broadcast with no `endTimestamp` and no length. There is no file, so a
   * dispatched mux downloads nothing and the card spins until the broadcast starts.
   */
  const got = parseInnertube({
    videoDetails: { lengthSeconds: '0', isLiveContent: true, viewCount: '0', shortDescription: 'x' },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: '2026-08-29T02:22:54-07:00',
        liveBroadcastDetails: { isLiveNow: false, startTimestamp: '2026-08-30T05:00:00+00:00' },
      },
    },
  })
  assert.equal(got.isLive, true)
})

test('AN ORDINARY VIDEO ANSWERS FALSE, NOT ABSENT — that is what overrules a stale record', () => {
  /**
   * The record keeps `isLive` for 30 days and a stream ends long before that, so the fresh answer has
   * to be able to say NO. A missing field could not: absent means "this call learned nothing", and
   * those two must never collapse into one value. See worker.ts's yt arm for the merge.
   */
  assert.equal(parseInnertube(fixture('ordinary')).isLive, false)
  assert.equal(parseInnertube(fixture('agegated')).isLive, false, 'an age wall is not a broadcast')
})

test('A BODY WITH NO MICROFORMAT ABSTAINS — silence must not read as a fresh negative', () => {
  /**
   * THE COLLAPSE THIS PINS, found in review 2026-08-29. The verdict used to answer a confident
   * `false` for any body carrying a `videoDetails` block, so the three values were only ever three
   * for a response that happened to include a microformat. Every negative in liveVerdict's measured
   * table comes OUT of that block — a microformat with no `liveBroadcastDetails` (dQw4w9WgXcQ) or one
   * with an `endTimestamp` (0cVnt1bUzLI) — and no measured shape answers false from `videoDetails`
   * alone.
   *
   * WHY IT MATTERS RATHER THAN BEING TIDY: a `false` here is the one value allowed to clear a stored
   * `isLive: true` (worker.ts's yt arm merges `got.isLive ?? warm.isLive`). A client that answers
   * without a microformat would therefore un-mark a stream that is still running and re-arm the
   * pinned-`muxing: true` defect. INNERTUBE_CLIENTS asks MWEB second and its shape has not been
   * measured against these four states, which is exactly the case this covers.
   */
  const noMicro = parseInnertube({ videoDetails: { shortDescription: 'hello', viewCount: '3' } })
  assert.equal(noMicro.description, 'hello', 'the parts it can read are still read')
  assert.equal(noMicro.isLive, undefined, 'but it says nothing about liveness, because it saw nothing')
  // A microformat that HAS been read and carries no broadcast is still a real negative.
  const micro = parseInnertube({
    videoDetails: { shortDescription: 'hello' },
    microformat: { playerMicroformatRenderer: { publishDate: '2020-01-02T03:04:05-00:00' } },
  })
  assert.equal(micro.isLive, false)
  // And videoDetails.isLive alone is still believed — that is the field a live WEB response leads with.
  assert.equal(parseInnertube({ videoDetails: { isLive: true, shortDescription: 'x' } }).isLive, true)
})

test('A VERDICT ALONE IS NOT AN ANSWER — an empty videoDetails must still fall through to MWEB', () => {
  /**
   * `videoDetails: {}` reads as not-live, and if that counted as something learned, parseInnertube
   * would return a non-null object, fetchInnertube's `if (got) return got` would accept it, and the
   * MWEB fallback would be retired for every response that carries nothing — which is the half of
   * requests Cloudflare's egress gets refused on. Liveness is deliberately counted last and does not
   * make an answer real.
   */
  assert.equal(parseInnertube({ videoDetails: {} }), null)
  assert.equal(parseInnertube({ microformat: { playerMicroformatRenderer: {} } }), null)
})

test('JUNK PARSES TO NULL RATHER THAN TO A CARD — every read is guarded individually', () => {
  for (const junk of [null, undefined, 0, '', 'nope', [], {}, { videoDetails: 'string' },
    { videoDetails: { lengthSeconds: 'abc', viewCount: {} }, microformat: [] }]) {
    assert.equal(parseInnertube(junk), null, `${JSON.stringify(junk)} must not become a card`)
  }
})

test('A PARTIAL BODY YIELDS THE PARTS IT HAS — one bad field never suppresses the others', () => {
  const got = parseInnertube({
    videoDetails: { lengthSeconds: 'not-a-number', viewCount: '42', shortDescription: 'hello' },
    microformat: { playerMicroformatRenderer: { publishDate: '2020-01-02T03:04:05-00:00' } },
  })
  assert.equal(got.duration, undefined)
  assert.equal(got.views, 42)
  assert.equal(got.description, 'hello')
  assert.ok(got.uploadedAt)
})

// ── The load-bearing half: an Innertube failure must be indistinguishable from it never existing.

const oembedBody = () => new Response(
  JSON.stringify({ title: 'Never Gonna Give You Up', author_name: 'Rick Astley' }),
  { headers: { 'content-type': 'application/json' } })

/** A fetch stub that answers oembed normally and lets the caller decide what Innertube does. */
const stub = (innertube) => async (url) => {
  if (String(url).includes('/youtubei/')) return innertube()
  return oembedBody()
}

test('AN INNERTUBE FAILURE LEAVES fetchYouTube EXACTLY AS IT WAS — throw, non-2xx, junk, empty', async () => {
  /**
   * THE PROPERTY THE WHOLE CHANGE RESTS ON. This call was added to the FIRST-PASTE critical path of
   * every YouTube link. It is only safe there because it cannot make anything worse: whatever
   * `youtubei/v1/player` does — including being refused outright from Cloudflare's egress, which
   * could not be measured before shipping — the card is exactly the card that shipped before it.
   */
  const cases = {
    throws: () => { throw new Error('network') },
    'non-2xx': () => new Response('nope', { status: 403 }),
    'not json': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    'empty object': () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    'nulls': () => new Response(JSON.stringify({ videoDetails: null, microformat: null }),
      { headers: { 'content-type': 'application/json' } }),
  }
  for (const [name, innertube] of Object.entries(cases)) {
    const got = await fetchYouTube(REF, stub(innertube))
    assert.equal(got.ok, true, `${name}: oembed must still own the result`)
    assert.equal(got.oembed.title, 'Never Gonna Give You Up', `${name}: title intact`)
    assert.equal(got.uploadedAt, undefined, `${name}: no date invented`)
    assert.equal(got.description, undefined, `${name}: no body invented`)
    assert.equal(got.duration, undefined, `${name}: no duration invented`)
    assert.equal(got.counts, undefined, `${name}: no counts invented`)
  }
})

test('A SUCCESSFUL INNERTUBE CALL JOINS THE DATE ONTO THE OEMBED RESULT', async () => {
  const got = await fetchYouTube(REF, stub(() =>
    new Response(JSON.stringify(fixture('ordinary')), { headers: { 'content-type': 'application/json' } })))
  assert.equal(got.ok, true)
  assert.equal(got.oembed.title, 'Never Gonna Give You Up', 'oembed still owns the title')
  assert.equal(Date.parse(got.uploadedAt) / 1000, 1256453853)
  assert.equal(got.duration, 213)
  assert.deepEqual(got.counts, { views: parseInnertube(fixture('ordinary')).views })
})

test('THE LIVE VERDICT RIDES THE FETCH, BOTH WAYS — and a refusal carries neither', async () => {
  /**
   * The three values have to survive the enrichment block, not just the parser: `true` is what stops
   * the mux, `false` is what lets an ended stream out of a 30-day record that still says live, and
   * ABSENT is what makes that record the fallback rather than the loser. A truthiness test in the
   * spread would have collapsed the last two.
   */
  const answer = name => stub(() =>
    new Response(JSON.stringify(fixture(name)), { headers: { 'content-type': 'application/json' } }))
  assert.equal((await fetchYouTube(REF, answer('live'))).isLive, true)
  assert.equal((await fetchYouTube(REF, answer('ordinary'))).isLive, false)
  assert.equal((await fetchYouTube(REF, stub(() => { throw new Error('refused') }))).isLive, undefined,
    'no answer is not a "no" — the record has to be allowed to win')
})

test('AN OEMBED MISS STILL KEEPS THE INNERTUBE DATE — the union carries it on BOTH arms on purpose', async () => {
  /**
   * The defect this repo already records one field over: gating the date on `ok` throws away a
   * correct one. An embedding-disabled video misses oembed and is still a real video with a real
   * upload date, and the card should say so.
   */
  const got = await fetchYouTube(REF, async (url) => {
    if (String(url).includes('/youtubei/')) {
      return new Response(JSON.stringify(fixture('ordinary')), { headers: { 'content-type': 'application/json' } })
    }
    return new Response('nope', { status: 401, headers: { 'content-type': 'text/html' } })
  })
  assert.equal(got.ok, false, 'oembed missed')
  assert.equal(Date.parse(got.uploadedAt) / 1000, 1256453853, 'and the date survived it')
})

test('A BOGUS VIDEO ID NEVER LEAVES THE PROCESS', async () => {
  let asked = 0
  const got = await fetchYouTube({ p: 'yt', id: 'not-an-id!!' }, async () => { asked++; return oembedBody() })
  assert.equal(got.ok, false)
  assert.equal(asked, 0, 'the id guard runs before either fetch')
})

test('A REFUSED FIRST CLIENT FALLS THROUGH TO THE SECOND — they are gated independently', async () => {
  /**
   * WHY THERE IS A SECOND CLIENT AT ALL. Measured against live production 2026-08-27 on ten ids the
   * service had never seen: WEB alone answered 5 of 10. The other five did not time out — hits and
   * misses both came back at ~1700ms against a 2500ms budget — and every one of them answers WEB
   * perfectly from a residential IP. The egress is what is refused, on some fraction of requests, and
   * YouTube gates its clients independently (the container's own player_client list exists for that
   * exact reason). So a refusal of WEB is not evidence that MWEB is refused.
   */
  const seen = []
  const got = await fetchInnertube('dQw4w9WgXcQ', async (url, init) => {
    const name = JSON.parse(init.body).context.client.clientName
    seen.push(name)
    if (name === 'WEB') return new Response('nope', { status: 403 })
    return new Response(JSON.stringify(fixture('ordinary')), { headers: { 'content-type': 'application/json' } })
  })
  assert.deepEqual(seen, ['WEB', 'MWEB'], 'WEB first, then the fallback')
  assert.equal(Date.parse(got.uploadedAt) / 1000, 1256453853, 'and the fallback answer is used')
})

test('A FIRST CLIENT THAT ANSWERS COSTS EXACTLY ONE ROUND TRIP', async () => {
  // The fallback must be paid for only by the requests that need it. Firing both every time would
  // double this endpoint's traffic to buy nothing on the half that already succeed.
  const seen = []
  const got = await fetchInnertube('dQw4w9WgXcQ', async (url, init) => {
    seen.push(JSON.parse(init.body).context.client.clientName)
    return new Response(JSON.stringify(fixture('ordinary')), { headers: { 'content-type': 'application/json' } })
  })
  assert.deepEqual(seen, ['WEB'], 'the second client is never asked when the first answers')
  assert.ok(got.uploadedAt)
})

test('A THROW ON ONE CLIENT DOES NOT ABANDON THE OTHER', async () => {
  const seen = []
  const got = await fetchInnertube('dQw4w9WgXcQ', async (url, init) => {
    const name = JSON.parse(init.body).context.client.clientName
    seen.push(name)
    if (name === 'WEB') throw new Error('connection reset')
    return new Response(JSON.stringify(fixture('ordinary')), { headers: { 'content-type': 'application/json' } })
  })
  assert.deepEqual(seen, ['WEB', 'MWEB'])
  assert.ok(got.uploadedAt, 'a throw on the first says nothing about the second')
})

test('A 200 CARRYING NOTHING USABLE ALSO FALLS THROUGH — not just a non-2xx', async () => {
  // The specific failure mode a sibling client (ANDROID_VR) exhibits: HTTP 200 with videoDetails
  // emptied. Treating that as success would be the quiet version of the bug this file exists to fix.
  const seen = []
  const got = await fetchInnertube('dQw4w9WgXcQ', async (url, init) => {
    const name = JSON.parse(init.body).context.client.clientName
    seen.push(name)
    if (name === 'WEB') return new Response('{}', { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(fixture('ordinary')), { headers: { 'content-type': 'application/json' } })
  })
  assert.deepEqual(seen, ['WEB', 'MWEB'])
  assert.ok(got.uploadedAt)
})

test('BOTH CLIENTS REFUSED IS STILL JUST NULL — the card is unchanged, never wrong', async () => {
  const seen = []
  const got = await fetchInnertube('dQw4w9WgXcQ', async (url, init) => {
    seen.push(JSON.parse(init.body).context.client.clientName)
    return new Response('nope', { status: 403 })
  })
  assert.deepEqual(seen, ['WEB', 'MWEB'], 'both are tried')
  assert.equal(got, null)
})

test('fetchInnertube IS TOTAL — it answers null rather than throwing, whatever the transport does', async () => {
  assert.equal(await fetchInnertube('dQw4w9WgXcQ', async () => { throw new Error('boom') }), null)
  assert.equal(await fetchInnertube('dQw4w9WgXcQ', async () => new Response('', { status: 500 })), null)
  assert.equal(await fetchInnertube('dQw4w9WgXcQ', async () => new Response('not json')), null)
})

test('THE REQUEST IS THE PUBLIC WEB PLAYER\'S OWN — no key, no cookie, no token', async () => {
  let seen
  await fetchInnertube('dQw4w9WgXcQ', async (url, init) => {
    seen = { url: String(url), init }
    return new Response(JSON.stringify(fixture('ordinary')), { headers: { 'content-type': 'application/json' } })
  })
  assert.match(seen.url, /^https:\/\/www\.youtube\.com\/youtubei\/v1\/player/)
  assert.doesNotMatch(seen.url, /key=/, 'no API key — it is not required and must not be added')
  assert.equal(seen.init.method, 'POST')
  const body = JSON.parse(seen.init.body)
  assert.equal(body.videoId, 'dQw4w9WgXcQ')
  assert.equal(body.context.client.clientName, 'WEB')
  assert.equal(seen.init.headers.cookie, undefined, 'never a credential')
  assert.ok(seen.init.signal, 'and always a timeout, because this sits on the render path')
})
