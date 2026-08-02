import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { guestOutcome } from '../src/platforms/twitter/fetch.ts'

/**
 * THE RICH TOMBSTONE, captured live 2026-07-26 from the guest TweetResultByRestId path on
 * tweet 2081088993219710978 — the post reported as "fxtwitter can retrieve it, ours says
 * age-restricted".
 *
 * WHY THIS FIXTURE EXISTS AT ALL. guestGateReason has always read `tombstone.text` to tell a private
 * wall from an age wall, but on the qid this project shipped until now Twitter answered with a BARE
 * `{"__typename":"TweetTombstone"}` — no reason, no text, no image. So the private branch was
 * UNREACHABLE and every tombstone fell through to the age DEFAULT. The verdict happened to be right
 * for this post and was not *read* from anything.
 *
 * Switching to the older qid (0aTrQMKgj95K791yXeNDRA, the one vxtwitter uses) makes the same endpoint
 * answer with a BlurredMediaTombstone carrying Twitter's own copy — so the classifier that was already
 * written finally receives its input. This fixture is the proof, and it is why the qid must not be
 * "modernised" back without re-checking these assertions.
 *
 * IT DOES NOT UNLOCK THE VIDEO. Nothing credential-free does: both fxtwitter and vxtwitter fetch
 * age-restricted media with pools of real logged-in accounts. See fetchWithCredentials.
 */
const BLURRED = readFileSync(new URL('./fixtures/twitter-guest-blurred-tombstone.json', import.meta.url), 'utf8')

test('THE AGE GATE IS NOW READ, NOT DEFAULTED — the real BlurredMediaTombstone classifies', () => {
  const out = guestOutcome(JSON.parse(BLURRED))
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'age_restricted')
})

test('the captured tombstone actually carries the text the classifier needs', () => {
  // Pins the SHAPE, not just the verdict. If Twitter renames these fields the verdict above would
  // silently revert to the age default and still pass — this is the assertion that would not.
  const ts = JSON.parse(BLURRED).data.tweetResult.result.tombstone
  assert.equal(ts.__typename, 'BlurredMediaTombstone')
  assert.match(ts.text.text, /age-restricted adult content/i, 'Twitter names the gate in its own words')
  // A real, fetchable blurred still of the post. Not used by the card yet; captured because it is the
  // one piece of the actual media a logged-out client is allowed to see, and the gate card is the
  // obvious place for it.
  assert.match(ts.blurred_image_url, /^https:\/\/pbs\.twimg\.com\//)
})

test('A PRIVATE-NAMING TOMBSTONE IS NOT AGE — the branch that was unreachable before', () => {
  /**
   * The regression this prevents is a silent one: with a bare tombstone this arm could not fire, so
   * a protected account would have rendered 🔞 "age-restricted" — wrong, and wrong in a way no test
   * could see, because the input never contained the distinguishing text.
   *
   * The tombstone body here is SYNTHETIC and says so. This project has not captured a real protected
   * tweet's guest body (fetch.ts's guestGateReason docstring records that gap), so this pins the
   * MECHANISM on the real envelope shape rather than claiming a measured protected-account capture.
   */
  const doc = JSON.parse(BLURRED)
  doc.data.tweetResult.result.tombstone.text.text =
    'This Post is from an account you don’t have access to. It is protected.'
  assert.equal(guestOutcome(doc).reason, 'private')
})

test('guestOutcome stays TOTAL over junk — a gate classifier must never throw on a public path', () => {
  for (const bad of [null, undefined, 42, '', {}, [], { data: null }, { data: { tweetResult: {} } }]) {
    const out = guestOutcome(bad)
    assert.equal(out.ok, false, `${JSON.stringify(bad)} is not a tweet`)
    assert.equal(out.reason, 'assert_fail', 'junk is assert_fail, never a fabricated gate')
  }
})

test('A REAL TWEET IS STILL A TWEET — the older qid is not a happy-path downgrade', () => {
  // The risk in pinning an OLDER qid is that it stops serving ordinary tweets. Verified live across
  // every media shape this project renders (text 20, animated_gif 1479837621337657345, video
  // 1491475671058681863, photo+quote 1823076043017630114, multi-photo 1376712834269159425) — all
  // returned __typename Tweet with media intact. This pins the classifier half of that.
  const tweet = { data: { tweetResult: { result: { __typename: 'Tweet', legacy: { full_text: 'hi' } } } } }
  assert.equal(guestOutcome(tweet).ok, true, 'a Tweet must not be mistaken for a gate')
})
