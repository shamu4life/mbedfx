import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * THE VERSION, PINNED ACROSS THE SURFACES THAT CARRY A COPY OF IT.
 *
 * WHAT WENT WRONG, found 2026-08-28. `package.json` was cut to 1.11.0 and released; the lockfile
 * kept saying 1.10.1. Nothing failed, because nothing reads it: the release notes are hand-written,
 * the deploy is Workers Builds running `npm run build`, and the one existing version assertion
 * (test/landing-convert.test.mjs, the page badge) reads `package.json` and never the lock. The drift
 * was found by grepping for a version string, which is not a control.
 *
 * WHY IT IS WORTH A TEST AT ALL, given a wrong lockfile version breaks no install. A release here is
 * one commit that has to move several files at once, and the failure mode of that shape is always
 * the same: whoever cuts it updates the ones they remember. `npm version` would move package.json
 * and the lock together, but this project cuts releases by hand — deliberately, because the
 * changelog entry is the real work and it is written before the number is chosen. So the guard
 * belongs here rather than in a convention nobody is enforcing.
 *
 * THE PAGE BADGE IS DELIBERATELY NOT RE-ASSERTED HERE. test/landing-convert.test.mjs already pins
 * it, next to the request that asked for it, and one rule stated twice is the bug shape this repo
 * keeps writing comments about.
 */

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')

const PKG = JSON.parse(read('../package.json'))
const LOCK = JSON.parse(read('../package-lock.json'))
const GUIDE = read('../CLAUDE.md')

test('THE LOCKFILE CARRIES THE VERSION package.json WAS CUT TO — both of its copies', () => {
  /**
   * A lockfile states the root version twice: once at the top level, and once inside
   * `packages[""]`, which is the root package's own entry. npm writes both and they are one fact,
   * so asserting only the first would miss a hand edit that fixed the copy someone happened to see.
   */
  assert.equal(LOCK.version, PKG.version,
    'package-lock.json\'s top-level version is the version package.json says this is')
  assert.equal(LOCK.packages['']?.version, PKG.version,
    'and so is the root entry inside "packages" — npm writes both, so both have to move')
})

test('THE LOCKFILE IS STILL FOR THIS PACKAGE — a name mismatch means it was copied in', () => {
  /**
   * Cheap, and it catches the one way the assertion above could pass while being meaningless: a
   * lockfile belonging to some other project that happens to sit at the same version.
   */
  assert.equal(LOCK.name, PKG.name, 'the lockfile names the package it locks')
  assert.equal(LOCK.packages['']?.name, PKG.name)
})

test('THE ASSISTANT GUIDE\'S VERSION LINE IS NOT STALE — it has been, twice, and says so itself', () => {
  /**
   * CLAUDE.md states the version in prose and admits in the same sentence that the line has gone
   * stale before. That admission is the reason for this test: a guide that is wrong about which
   * release it describes sends every reader — human or agent — looking for behaviour that shipped
   * somewhere else. The line names package.json as authoritative, so this only checks it agrees.
   */
  const m = /^- Version: (\d+\.\d+\.\d+) \(`package\.json` is authoritative/m.exec(GUIDE)
  assert.ok(m, 'CLAUDE.md carries a `- Version: x.y.z (`package.json` is authoritative…)` line')
  assert.equal(m[1], PKG.version, 'and it names the version package.json actually is')
})

test('THE CHANGELOG HAS AN ENTRY FOR THE VERSION THIS IS — a release with no notes is not a release', () => {
  /**
   * The changelog is the only place a reader can learn what a version changed, and it is written by
   * hand before the number is picked. The failure this prevents is the ordinary one: bumping
   * package.json as the last step of a busy branch and never coming back to write the section.
   *
   * It asserts the heading exists, not that it says anything in particular. Judging the prose is
   * not a test's job; noticing there is none is.
   */
  const changelog = read('../docs/CHANGELOG.md')
  const heading = new RegExp(`^## \\[${PKG.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm')
  assert.match(changelog, heading,
    `docs/CHANGELOG.md has a dated "## [${PKG.version}]" section for the version package.json is`)
})
