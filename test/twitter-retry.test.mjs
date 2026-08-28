import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchSyndication, fetchGuest, resetGuestToken } from '../src/platforms/twitter/fetch.ts'
import { worthAskingAgain } from '../src/fetchretry.ts'

/**
 * ONE REFUSED REQUEST MUST NOT COST A PERMANENT CARD.
 *
 * Reported 2026-08-28: a public video tweet drew the "couldn't load" card here while a self-hosted
 * rival drew the same id correctly from the same Discord message. Measured that day from residential
 * egress, BOTH of our paths are healthy for that id — syndication answered a full Tweet with video
 * 8/8, and guest TweetResultByRestId answered `__typename: Tweet` with `media: ['video']`. The post is
 * not sensitive, not protected and not deleted. The card was lost to Cloudflare's egress being refused
 * once, and Discord stores the embed it built inside the message permanently, so that one refusal is
 * permanent for every reader of that message.
 *
 * These tests pin the split that makes the retry safe: a VERDICT is believed on the first ask, and
 * only a verdict-LESS answer is asked again. Getting that wrong in the other direction would double
 * the cost of every dead link, which is why the no-retry cases are asserted as hard as the retry ones.
 */

const VIDEO = readFileSync('test/fixtures/twitter-video.json', 'utf8')
const REF = { p: 'x', id: '1491475671058681863' }

/**
 * Stub the network with a SCRIPT: one entry per expected call, consumed in order. Returning a
 * function lets a case throw instead of answering. `calls` is the assertion that matters most here —
 * this whole change is about HOW MANY times we ask, so a test that only checked the verdict would
 * pass just as well with the retry deleted.
 */
function scripted(steps) {
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    const step = steps[Math.min(seen.length, steps.length - 1)]
    seen.push(String(url))
    if (typeof step === 'function') return step()
    return new Response(step.body, { status: step.status })
  }
  return {
    calls: seen,
    restore() { globalThis.fetch = real },
  }
}

test('THE POLICY IS PURE: only a REFUSED request is worth asking again', () => {
  /**
   * The one question status can answer and content cannot. A 429 with an HTML body and a 404 with an
   * HTML body are identical to a content check and want opposite treatment — the first is about our
   * request, the second is about the post.
   */
  for (const refused of [408, 425, 429, 500, 502, 503, 504, 599]) {
    assert.equal(worthAskingAgain(refused), true, `${refused} means the endpoint refused the request`)
  }
  for (const answered of [200, 204, 301, 302, 400, 401, 403, 404, 410, 451]) {
    assert.equal(worthAskingAgain(answered), false,
      `${answered} is an answer about the POST; asking twice would only double the cost of a dead link`)
  }
})

test('A REFUSED SYNDICATION REQUEST IS ASKED AGAIN, and the second answer is the card', async () => {
  // The reported bug, reproduced: the first ask is refused, the post is perfectly fine, and before
  // this change the reader got a permanent "couldn't load" card for a tweet that was never gone.
  const net = scripted([
    { status: 503, body: '<html>edge refused</html>' },
    { status: 200, body: VIDEO },
  ])
  try {
    const out = await fetchSyndication(REF)
    assert.equal(out.ok, true, 'the second ask carries the tweet, so the card is drawn')
    assert.equal(net.calls.length, 2, 'exactly one EXTRA ask — not a loop')
  } finally { net.restore() }
})

test('A THROWN FETCH IS ASKED AGAIN — a reset is the most transient answer there is', async () => {
  const net = scripted([
    () => { throw new TypeError('network error') },
    { status: 200, body: VIDEO },
  ])
  try {
    const out = await fetchSyndication(REF)
    assert.equal(out.ok, true, 'a successful second ask wins over a remembered throw')
    assert.equal(net.calls.length, 2)
  } finally { net.restore() }
})

test('TWO THROWN FETCHES STILL THROW — the fetch_fail contract is not swallowed by the retry', async () => {
  /**
   * worker.ts turns a thrown fetch into null / fetch_fail, which is a DIFFERENT signal from "the
   * endpoint answered un-parseably" (assert_fail) and is counted separately. Quietly converting a
   * transport failure into assert_fail would move a real outage into the wrong bucket, so the retry
   * re-throws after the last attempt instead of returning.
   */
  const net = scripted([() => { throw new TypeError('network error') }])
  try {
    await assert.rejects(() => fetchSyndication(REF), /network error/)
    assert.equal(net.calls.length, 2, 'asked twice, then re-thrown — not swallowed')
  } finally { net.restore() }
})

test('A PARSED VERDICT IS BELIEVED ON THE FIRST ASK — a tombstone is never retried', async () => {
  /**
   * The cost guard, and the reason the retry keys on "no verdict" rather than "not ok". Measured
   * live 2026-08-28: a nonexistent id answers HTTP 200 with a PARSEABLE TweetTombstone reading
   * "This Post is from an account that no longer exists". Retrying on failure-of-any-kind would ask
   * twice for every deleted tweet anyone ever pastes, for an answer that cannot change.
   */
  const net = scripted([{ status: 200, body: JSON.stringify({ __typename: 'TweetTombstone' }) }])
  try {
    const out = await fetchSyndication(REF)
    assert.deepEqual(out, { ok: false, reason: 'age_restricted' })
    assert.equal(net.calls.length, 1, 'one ask: the endpoint gave a verdict and we believe it')
  } finally { net.restore() }
})

test('A 404 POODLE PAGE IS NOT RETRIED — an answer about the post, not about the request', async () => {
  const net = scripted([{ status: 404, body: '<html>not found</html>' }])
  try {
    const out = await fetchSyndication(REF)
    assert.deepEqual(out, { ok: false, reason: 'assert_fail' })
    assert.equal(net.calls.length, 1)
  } finally { net.restore() }
})

test('A REFUSED REQUEST THAT IS REFUSED TWICE GIVES UP — one extra ask, not a loop', async () => {
  // The bound matters as much as the retry: this path runs inside a 5s crawler deadline shared with
  // the guest fallback and the render, so an unbounded loop would trade a missing card for a missing
  // response.
  const net = scripted([{ status: 429, body: 'slow down' }])
  try {
    const out = await fetchSyndication(REF)
    assert.deepEqual(out, { ok: false, reason: 'assert_fail' })
    assert.equal(net.calls.length, 2, 'two asks total, then the honest failure')
  } finally { net.restore() }
})

test('THE GUEST FALLBACK GETS THE SAME EXTRA ASK — it is the path that runs when Path A already failed',
  async () => {
    /**
     * Path B is reached only after syndication has already failed, which makes it the LAST chance at a
     * card. Leaving it single-shot would mean the reader still loses the post whenever both the
     * primary and the one refused request land in the same paste.
     */
    resetGuestToken()
    const activate = { status: 200, body: JSON.stringify({ guest_token: '1234567890' }) }
    const net = scripted([
      activate,
      { status: 503, body: '<html>refused</html>' },
      { status: 200, body: JSON.stringify({ data: { tweetResult: { result: { legacy: { full_text: 'hi' } } } } }) },
    ])
    try {
      const out = await fetchGuest(REF, {})
      assert.equal(out.ok, true, 'the second ask answers, so the fallback still has a card to give')
      assert.equal(net.calls.length, 3, 'the activation, the refused ask, and the one that answered')
    } finally {
      net.restore()
      resetGuestToken()
    }
  })
