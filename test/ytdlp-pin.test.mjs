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
 * invalidates the cached pip layer, which is what makes a bump reach production at all. A floor is
 * indistinguishable from a pin that never moves.
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
    'a `>=` floor resolves once and then freezes behind Docker layer caching — that is the 2026-08-17 defect')
})

test('THE PIN IS ON THE NIGHTLY CHANNEL, because stable cannot deliver "latest weekly"', () => {
  /**
   * MEASURED ON PyPI 2026-08-18. Stable shipped 2026.3.3, 2026.3.13, 2026.3.17, 2026.6.9 and
   * 2026.7.4 — an ELEVEN-WEEK gap between March and June — while nightlies land most days. A weekly
   * job pointed at stable would have reported "already current" every Monday for eleven weeks and
   * been telling the truth, which is the difference between doing what was asked and appearing to.
   *
   * It is also the only channel that can carry the fix for the outage this file describes: YouTube
   * began enforcing GVS PO tokens on `android_vr` — 2026.07.04's default client — about two weeks
   * AFTER 2026.07.04 shipped, and yt-dlp's handling merged 2026-07-20 into no stable release.
   *
   * If this ever has to move back to stable, delete this test WITH the reason, and change the
   * workflow's PyPI query in the same commit — it reads the newest `.dev`, not `info.version`.
   */
  const version = INSTALL.exec(DOCKERFILE)[1]
  assert.match(version, /\.dev\d+$/,
    `pinned to ${JSON.stringify(version)}, which is a stable release — stable ships too rarely to satisfy a weekly bump`)
  assert.match(WORKFLOW, /\.dev" in v/,
    'the workflow must still select from the nightly channel rather than info.version')
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
