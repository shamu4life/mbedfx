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
