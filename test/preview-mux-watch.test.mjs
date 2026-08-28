import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MUX_FIRST_ATTEMPT_MS, MUX_FIRST_ATTEMPT_TRACKS_MS, MUX_TOTAL_HORIZON_MS } from '../src/muxpolicy.ts'

/**
 * THE PREVIEW WATCHED FOR 25 SECONDS WHILE THE MUX RAN FOR UP TO 1460.
 *
 * The converter preview is the third seam this project keeps re-learning: `/_card` is fetched once per
 * typing-settle and drawn, and nobody re-pastes to heal it. Its mux indicator polled ten times at
 * 2.5s and then stopped, which is 1.7% of the time a mux may legitimately still be working. Worse, it
 * stopped SILENTLY: it never confirmed the video landed, so a reader who waited saw "still preparing"
 * indefinitely even when the video arrived two seconds after the page gave up.
 *
 * WHY THE NUMBERS ARE ASSERTED RATHER THAN TRUSTED. public/index.html ships as one hand-written page
 * with no build step, so it cannot import from src/. That leaves two literals mirroring
 * src/muxpolicy.ts, and a hand-picked number that drifts from the policy it mirrors is exactly the
 * defect the deadline constants argue about at length. So the policy is parsed and compared, the same
 * way test/prep.test.mjs parses the Route union rather than re-typing it.
 */

const HTML = readFileSync('public/index.html', 'utf8')
const num = (name) => {
  const m = HTML.match(new RegExp(`var ${name} = (\\d+);`))
  assert.ok(m, `${name} must exist in public/index.html`)
  return Number(m[1])
}

test('THE PREVIEW WATCHES THE WHOLE FIRST ATTEMPT, derived from the policy rather than picked', () => {
  /**
   * The window deliberately ends with the FIRST ATTEMPT rather than at MUX_TOTAL_HORIZON_MS: the
   * policy's own retries are 120s and 1200s away, and nobody watches a page for twenty minutes. What
   * matters is that the page covers the whole span in which a mux is actively working the first time,
   * which is 35s for a `{page}` source and 140s for the `{video}` tracks shape.
   */
  assert.equal(num('MUX_WATCH_FAST_MS'), MUX_FIRST_ATTEMPT_MS,
    'the fast poll window is the page-shape first attempt')
  assert.equal(num('MUX_WATCH_TOTAL_MS'), MUX_FIRST_ATTEMPT_TRACKS_MS,
    'and watching stops at the end of the slowest first attempt')
})

test('THE WINDOW IS LONGER THAN WHAT IT REPLACED, and shorter than the full horizon', () => {
  // Both halves matter. The old 25s was too short to see a normal mux finish; the full 1460s horizon
  // would be an indicator that spins for twenty minutes, which the file already argues is a lie of a
  // different kind.
  assert.ok(num('MUX_WATCH_TOTAL_MS') > 25_000, 'longer than the ten-poll cap this replaced')
  assert.ok(num('MUX_WATCH_TOTAL_MS') < MUX_TOTAL_HORIZON_MS,
    'but not the whole horizon, which no reader is present for')
})

test('THE POLL BACKS OFF, so a longer window is not a faster one', () => {
  // A 140s window at the old 2.5s interval would be 56 requests. The backoff keeps the early seconds
  // responsive, where most muxes land, and stops hovering after that.
  const fast = num('MUX_POLL_MS')
  const slow = num('MUX_POLL_SLOW_MS')
  assert.ok(slow > fast, 'the slow interval is slower than the fast one')
  const requests = MUX_FIRST_ATTEMPT_MS / fast
    + (num('MUX_WATCH_TOTAL_MS') - MUX_FIRST_ATTEMPT_MS) / slow
  assert.ok(requests < 30, `a full watch costs ${Math.ceil(requests)} polls, which stays affordable`)
})

test('THE PAGE CONFIRMS THE VIDEO LANDED — the state that did not exist before', () => {
  /**
   * The actual complaint: the page never said when the mux was done. `muxDone` is set only where the
   * page SAW the transition (it was muxing on an earlier poll and is not now, and there is video), so
   * a card that arrives already complete stays silent, because there was nothing to wait for.
   */
  assert.match(HTML, /j\.muxDone = true/, 'completion is detected')
  assert.match(HTML, /muxSince && j\.video/, 'and only when the page watched it happen')
  assert.match(HTML, /Video ready\./, 'and it is said in words')
})

test('GIVING UP SAYS SO, rather than looking like the work stopped', () => {
  // The old copy read as though the page were still watching. It was not. An indicator that quietly
  // stops is how a reader concludes the video failed when it is still on its way.
  assert.match(HTML, /This preview has stopped\s*'?\s*\+?\s*'?checking/,
    'the copy admits watching ended')
  assert.match(HTML, /The link works now and shows the video once it is ready/,
    'and repeats the thing that stays true either way')
})

test('THE OLD POLL-COUNT CAP IS GONE — elapsed time, not a number of tries', () => {
  /**
   * With a backing-off interval, counting polls means a different wall-clock window depending on where
   * the backoff falls, which is how a window silently becomes shorter than the one that was reasoned
   * about. Leaving the old constant behind would also leave a second, disagreeing answer to "how long
   * do we watch".
   */
  assert.ok(!/MUX_POLL_MAX/.test(HTML), 'no poll-count cap remains')
  assert.match(HTML, /muxSince \|\| Date\.now\(\)/, 'the window is anchored to a timestamp')
})

test('THE PAGE STILL CARRIES NO EM DASH AND NO SECOND PERSON in the new copy', () => {
  // Both were owner requests and both have been re-broken by later work before. The new strings are
  // exactly the kind of edit that re-breaks them.
  const body = HTML.slice(HTML.indexOf('<body'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  assert.equal((body.match(/—/g) || []).length, 0)
  assert.equal((body.match(/\b(you|your)\b/gi) || []).length, 0)
})
