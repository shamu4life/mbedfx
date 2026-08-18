import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * THE yt-dlp PIN, AND THE JOB THAT BUMPS IT, PINNED TO EACH OTHER.
 *
 * WHAT WENT WRONG, measured 2026-08-17. container/Dockerfile carried
 * `yt-dlp[default,curl-cffi]>=2025.1.1`, which reads like "always current" and guarantees the
 * opposite. A floor is resolved ONCE, when the layer is first built; Docker then reuses that layer
 * on every later build because the instruction text never changed. So the running version froze on
 * the day the image was first built, and — because nothing recorded it — NOBODY COULD SAY WHICH
 * VERSION WAS LIVE.
 *
 * The bill for that was every NEW YouTube video rendering as a thumbnail with no player, for weeks,
 * while previously-cached ones kept playing. Two things hid it: the card looked healthy (title,
 * channel, upload date and counts were all correct, because the metadata call passes
 * `--ignore-no-formats-error`), and the outage monitor checks a CACHED video and accepts any card
 * that merely drew.
 *
 * SO THESE ARE NOT STYLE ASSERTIONS. An exact pin is the MECHANISM: rewriting that string is what
 * invalidates the cached pip layer, which is what makes the weekly bump reach production at all. A
 * floor is indistinguishable from a pin that never moves.
 *
 * THE THIRD TEST IS THE ONE THAT WILL ACTUALLY FIRE ONE DAY. The workflow finds the current version
 * with a `sed` expression written against this exact line. Reword the line — add an extra, move the
 * extras, change the quoting — and the sed silently matches nothing. The workflow does fail loudly
 * on an empty match rather than bumping blindly, but that failure arrives on a Monday in a job
 * nobody is watching, whereas this arrives in the PR that reworded the line. Same regex, both
 * places, checked against the real file.
 */

const DOCKERFILE = readFileSync(new URL('../container/Dockerfile', import.meta.url), 'utf8')
const WORKFLOW = readFileSync(new URL('../.github/workflows/ytdlp-freshness.yml', import.meta.url), 'utf8')

/** The install line, ignoring the essay of comments above it. */
const installLine = DOCKERFILE.split('\n').find(l => /^RUN pip install .*yt-dlp/.test(l))

test('yt-dlp IS PINNED EXACTLY — a floor here is a pin that never moves', () => {
  assert.ok(installLine, 'container/Dockerfile must still install yt-dlp with pip')

  assert.doesNotMatch(installLine, />=/,
    'a `>=` floor resolves once and then freezes behind Docker layer caching — that is the 2026-08-17 defect')
  assert.doesNotMatch(installLine, /yt-dlp\[[^\]]*\]"/,
    'an unversioned install freezes the same way, and additionally cannot be read back')
  assert.match(installLine, /yt-dlp\[[^\]]*\]==\d+\.\d+(\.\d+)*"/,
    'yt-dlp must carry an exact `==` version')
})

test('THE EXTRAS SURVIVE THE PIN — curl-cffi is what gives Vimeo an impersonation target', () => {
  // Measured 2026-07-22 and recorded in the Dockerfile: `[default]` alone does NOT pull curl_cffi,
  // and without it impersonation-gated sites fail "attempting impersonation, but no impersonate
  // target is available". A bump that drops the extras would take those platforms out silently.
  assert.match(installLine, /yt-dlp\[default,curl-cffi\]==/,
    'both extras must survive any version bump')
})

test('THE FRESHNESS JOB CAN ACTUALLY READ THE PIN IT BUMPS', () => {
  // The same expression the workflow runs, transcribed to JS. If this drifts from the sed, the
  // workflow stops finding a version and the pin quietly stops being maintained — which is the
  // failure this whole file exists to make loud.
  const sed = /yt-dlp\[default,curl-cffi\]==([0-9][0-9.]*)"/
  const found = sed.exec(DOCKERFILE)
  assert.ok(found, 'the workflow\'s extraction must match container/Dockerfile as it is written today')

  assert.ok(
    WORKFLOW.includes(String.raw`yt-dlp\[default,curl-cffi\]==\([0-9][0-9.]*\)`),
    'the workflow must still use the extraction this test mirrors — update both together or neither',
  )

  // And the version it reads is a real one, not a partial match ending mid-number.
  assert.match(found[1], /^\d+\.\d+(\.\d+)*$/, `extracted ${JSON.stringify(found[1])}, which is not a version`)
})

test('THE FRESHNESS JOB NEVER DEPLOYS — one deployer, always', () => {
  // ci.yml's header carries the argument in full: two systems deploying the same worker race on the
  // container image and on which version ends up live, and the loser silently overwrites the
  // winner. It has already cost this project once. A bump job is exactly the kind of place someone
  // would "helpfully" add a deploy step.
  assert.doesNotMatch(WORKFLOW, /wrangler\s+deploy/, 'this job must not deploy — merging is the deploy')
  assert.doesNotMatch(WORKFLOW, /npm run deploy/, 'this job must not deploy — merging is the deploy')
  assert.match(WORKFLOW, /gh pr create/, 'it opens a PR and stops there')
})
