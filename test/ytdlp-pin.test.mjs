import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * THE yt-dlp PIN, AND THE JOB THAT BUMPS IT, PINNED TO EACH OTHER.
 *
 * WHAT WENT WRONG, 2026-08-17. container/Dockerfile carried `yt-dlp[default,curl-cffi]>=2025.1.1`,
 * which reads like "always current" and buys nothing. It is a FLOOR: pip picks whatever satisfies it
 * at build time, and NOTHING ANYWHERE RECORDED WHAT THAT WAS — not the repo, not a commit, not a
 * build log. NOBODY COULD TELL WHICH VERSION WAS RUNNING.
 *
 * TWO CORRECTIONS TO THE STORY THIS FILE USED TO TELL, both made in the Dockerfile on 2026-08-29 and
 * mirrored here because the assertion messages below were repeating the old version:
 *
 *   1. IT WAS NOT DOCKER LAYER CACHING. There is no machine holding this repo's previous layers:
 *      every merge runs `wrangler deploy` in a Workers Builds runner off a fresh clone, and this
 *      repo's own build logs report `Image does not exist remotely, pushing:`. A floor here would
 *      not freeze, it would FLOAT — each merge installs whatever pip resolves that day, two builds
 *      of one commit can differ, and a bad release arrives with no commit to revert.
 *   2. THE FLOOR DID NOT CAUSE THE 2026-08-17 OUTAGE. The running version was 2026.7.4, the newest
 *      stable that day and what the pin first named, so pinning changed nothing installed. The cause
 *      was that release's DEFAULT player clients — YouTube enforcing GVS PO tokens on `android_vr` —
 *      and the fix was container/server.py naming `player_client=...`, not a version bump.
 *
 * The outage itself is real and worth keeping: every NEW YouTube video rendered as a thumbnail with
 * no player for weeks while previously-cached ones kept playing. Two things hid it — the card looked
 * healthy (title, channel, upload date and counts all correct, because the metadata call passes
 * `--ignore-no-formats-error`), and the outage monitor checks a CACHED video. What the FLOOR cost was
 * the diagnosis: "is yt-dlp simply stale?" could be neither confirmed nor ruled out.
 *
 * SO THESE ARE NOT STYLE ASSERTIONS. An exact pin makes the image reproducible (a commit names
 * exactly one yt-dlp) and rollback-able (one line), and it is the only place the version is written
 * down, which is what gives the weekly bump something to change.
 */

const DOCKERFILE = readFileSync(new URL('../container/Dockerfile', import.meta.url), 'utf8')
const WORKFLOW = readFileSync(new URL('../.github/workflows/ytdlp-freshness.yml', import.meta.url), 'utf8')
const SELFHOST = readFileSync(new URL('../docs/SELF-HOSTING.md', import.meta.url), 'utf8')

/** The install INSTRUCTION, anchored — see the third test for why anchoring is the whole game. */
const INSTALL = /^RUN pip install .*yt-dlp\[default,curl-cffi\]==([0-9][0-9A-Za-z.]*)"/m

test('yt-dlp IS PINNED EXACTLY — a floor here is a pin that never moves', () => {
  const m = INSTALL.exec(DOCKERFILE)
  assert.ok(m, 'container/Dockerfile must install yt-dlp at an exact `==` version')
  assert.doesNotMatch(DOCKERFILE, /^RUN pip install .*yt-dlp\[[^\]]*\]>=/m,
    'a `>=` floor leaves the installed version unrecorded and un-revertable — see the header')
})

test('THE PIN IS A STABLE RELEASE — this pipeline does not run nightlies', () => {
  /**
   * OWNER'S DECISION, 2026-08-18: "nightly is not acceptable for the pipeline releases only."
   *
   * WHY IT NEEDS A TEST RATHER THAN A COMMENT. Nightlies are genuinely tempting here, and the
   * temptation has a specific shape: when the 2026-08 YouTube outage was being debugged, the GVS
   * PO-token handling for `android_vr` (merged 2026-07-20) was in no stable release, so the nightly
   * channel appeared to solve it and PyPI serves nightlies under the same package name. One `.dev0`
   * string in the Dockerfile is all it takes. That particular fix HAS shipped stable since (the pin
   * is 2026.8.19), but the shape recurs on every upstream fight, which is why this is a guard rather
   * than a note.
   *
   * WHAT IT COSTS, so the cost is not rediscovered as a bug: stable ships sparsely — 2026 gave
   * 2026.3.3, 2026.3.13, 2026.3.17, 2026.6.9 and 2026.7.4, an eleven-week gap between March and
   * June — so the weekly job will find nothing most Mondays. That is the job working, not failing.
   *
   * If this is ever revisited, change the Dockerfile, this test AND the workflow's PyPI query in one
   * commit. They are three statements of one decision, and the workflow reads `info.version`.
   */
  const version = INSTALL.exec(DOCKERFILE)[1]
  assert.doesNotMatch(version, /\.dev|rc|[ab]\d+$/,
    `pinned to ${JSON.stringify(version)}, which is a pre-release — this pipeline is stable-only by decision`)
  assert.match(WORKFLOW, /info"\]\["version"\]/,
    'the workflow must read PyPI info.version (newest stable), not scan releases for nightlies')
  assert.match(WORKFLOW, /is a pre-release/,
    'and must refuse a pre-release outright rather than trusting the query to have asked correctly')
})

test('THE EXTRAS SURVIVE THE PIN — curl-cffi is what gives Vimeo an impersonation target', () => {
  // Measured 2026-07-22 and recorded in the Dockerfile: `[default]` alone does NOT pull curl_cffi,
  // and without it impersonation-gated sites fail "attempting impersonation, but no impersonate
  // target is available". A bump that dropped the extras would take those platforms out silently.
  assert.match(DOCKERFILE, /yt-dlp\[default,curl-cffi\]==/,
    'both extras must survive any version bump')
})

test('THE FRESHNESS JOB CAN READ THE PIN IT BUMPS — and finds exactly ONE line', () => {
  /**
   * THIS IS THE TEST THAT WILL ACTUALLY FIRE ONE DAY, and the count is the point rather than the
   * match. The workflow reads the version with a `sed` written against this exact instruction, and
   * this Dockerfile QUOTES ITS OWN PACKAGE SPEC in the essay above the line — as does
   * docs/SELF-HOSTING.md. An unanchored expression would pick up prose: `current` becomes a
   * two-line string, the equality test is then permanently false, and a newline lands in a branch
   * name. Anchoring to `^RUN pip install` is what keeps prose and instruction apart, so a future
   * comment edit cannot quietly break the automation.
   */
  const lines = DOCKERFILE.split('\n').filter(l => /^RUN pip install .*yt-dlp\[default,curl-cffi\]==/.test(l))
  assert.equal(lines.length, 1, 'exactly one pinned install instruction, or the workflow refuses to run')

  assert.ok(
    WORKFLOW.includes(String.raw`^RUN pip install .*yt-dlp\[default,curl-cffi\]==`),
    'the workflow must still use the anchored extraction this test mirrors — change both together or neither',
  )

  const version = INSTALL.exec(DOCKERFILE)[1]
  assert.match(version, /^\d+\.\d+\.\d+(\.\d+)?(\.dev\d+)?$/,
    `extracted ${JSON.stringify(version)}, which is not a version`)
})

test('THE DOCS DO NOT SECOND-SOURCE THE VERSION', () => {
  /**
   * docs/SELF-HOSTING.md tells a self-hoster what to install, and it quoted `>=2025.1.1` for as long
   * as the Dockerfile did — so it would have gone on advertising the exact spec that cannot play
   * YouTube after the Dockerfile moved on.
   *
   * THE FIX IS NOT TO COPY THE NEW NUMBER THERE. A version repeated in prose is a version that goes
   * stale, and this one is bumped WEEKLY, so a copy would be wrong within days and would make the
   * suite red on main after every routine bump — punishing the automation for working. The page
   * points at container/Dockerfile instead, which is the only place the pin lives.
   */
  assert.doesNotMatch(SELFHOST, /yt-dlp\[default,curl-cffi\][>=]=\s*\d/,
    'the docs must not pin a version of their own — it will drift within days of the next weekly bump')
  assert.match(SELFHOST, /container\/Dockerfile/,
    'they must send the reader to the file that does carry the pin')
})

test('THE FRESHNESS JOB NEVER DEPLOYS — one deployer, always', () => {
  // ci.yml's header carries the argument in full: two systems deploying the same worker race on the
  // container image and on which version ends up live, and the loser silently overwrites the
  // winner. It has already cost this project once. A bump job is exactly where someone would
  // "helpfully" add a deploy step.
  assert.doesNotMatch(WORKFLOW, /wrangler\s+deploy/, 'this job must not deploy — merging is the deploy')
  assert.doesNotMatch(WORKFLOW, /npm run deploy/, 'this job must not deploy — merging is the deploy')
  assert.match(WORKFLOW, /gh pr create/, 'it opens a PR')
  assert.match(WORKFLOW, /gh issue create/,
    'and falls back to an issue, because a PR it is not permitted to open would otherwise fail silently every Monday')
})
