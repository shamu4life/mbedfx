import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  cardVerdict, runSmoke, smokeOutcome, SMOKE_CHECKS, SMOKE_UNCHECKED,
  SMOKE_BUDGET_MS, CRON_WALL_LIMIT_MS, smokeRunCeilingMs,
} from '../src/smoke.ts'

/**
 * THE OUTAGE NOBODY NOTICED, which is what this detector is for.
 *
 * Facebook embeds were completely broken for up to a week — Meta walled the post surfaces from
 * datacenter egress between 2026-08-01 and 2026-08-08 — and the way it was discovered was the OWNER
 * pasting a link and seeing a failure card. The counters would have shown it to anyone who went
 * looking; nobody had a reason to look.
 *
 * The rule these pin is the one the whole service turns on: ASSERT ON CONTENT, NEVER ON STATUS. Every
 * interesting failure here answers HTTP 200 — the failure card is a 200, Meta's login wall is a 200,
 * TikTok's 404 page is a 200 — so a monitor that watched status codes would have reported perfect
 * health for the entire week Facebook was down.
 */

const REAL_MEDIA_CARD = '<html><head>'
  + '<meta property="og:title" content="Someone (@someone)"/>'
  + '<meta property="og:description" content="a caption"/>'
  + '<link rel="alternate" type="application/activity+json" href="https://mbedfx.app/users/x/statuses/1"/>'
  + '</head><body></body></html>'

const REAL_IMAGE_CARD = '<html><head>'
  + '<meta property="og:title" content="Someone (@someone)"/>'
  + '<meta property="og:image" content="https://scontent.cdninstagram.com/x.jpg"/>'
  + '</head><body></body></html>'

/** The exact shape render/fail.ts emits, which is the thing being detected. */
const FAILURE_CARD = '<html><head>'
  + '<meta property="og:title" content="Couldn\'t load this Facebook post"/>'
  + '<meta property="og:description" content="It may be private, removed, or unavailable."/>'
  + '<meta name="theme-color" content="#657786"/>'
  + '</head><body></body></html>'

/**
 * A WARM YOUTUBE CARD, trimmed from the real bytes. Captured 2026-08-29 by fetching
 * https://mbedfx.app/jNQXAC9IVRw with a Discordbot UA: 200, 1573 bytes, 0.50s, and a HEAD on the
 * og:video url answered 200 with content-length 629172.
 *
 * THE og:video:* TAGS ARE KEPT DELIBERATELY. `og:video:width` is 0 on every remux platform (Discord
 * reads the muxed mp4's own dimensions) and it is not a defect — but it means a sloppier regex than
 * cardVerdict's could pass this fixture on the width tag alone while failing the degraded one below
 * for the wrong reason. Keeping both spellings in the fixture is what makes that a real test.
 */
const WARM_VIDEO_CARD = '<html><head>'
  + '<meta property="og:title" content="jawed (@jawed)"/>'
  + '<meta property="og:description" content="Me at the zoo"/>'
  + '<meta property="og:type" content="video.other"/>'
  + '<meta property="og:video" content="https://mbedfx.app/_media/yt%3AjNQXAC9IVRw/0.mp4"/>'
  + '<meta property="og:video:type" content="video/mp4"/>'
  + '<meta property="og:video:width" content="0"/>'
  + '<meta property="og:video:height" content="0"/>'
  + '<link rel="alternate" type="application/activity+json" href="https://mbedfx.app/users/jawed/statuses/1"/>'
  + '</head><body></body></html>'

/**
 * THE SAME CARD WITH NO PLAYER IN IT, which is what a cold mux produces and what this whole
 * expectation exists to catch. It is the head renderSpoof emits when settleMux degraded the video to
 * its poster still: the activity link, NO og:video, and NO og:image either — renderSpoof emits
 * og:image only on a post with no media at all, and a degraded video post still has media.
 *
 * IT IS INDISTINGUISHABLE FROM A HEALTHY MEDIA POST to the default assertion, and that is the defect.
 * Discord reads the picture off the activity document; the card looks fine and can never play.
 */
const DEGRADED_VIDEO_CARD = '<html><head>'
  + '<meta property="og:title" content="jawed (@jawed)"/>'
  + '<meta property="og:description" content="Me at the zoo"/>'
  + '<link rel="alternate" type="application/activity+json" href="https://mbedfx.app/users/jawed/statuses/1"/>'
  + '</head><body></body></html>'

/**
 * The healthy head for whatever row a url belongs to, so a test about SOMETHING ELSE does not
 * accidentally become a test of the video expectation. Handing every row one fixture would report the
 * yt row as `no-video` in tests whose subject is "every check ran" or "the timer is per check", and
 * the failure would read as a bug in the thing being tested.
 */
const healthyCard = (url) =>
  SMOKE_CHECKS.find(c => url.endsWith(c.path))?.expect === 'video' ? WARM_VIDEO_CARD : REAL_MEDIA_CARD

test('THE FAILURE CARD IS CAUGHT, and it answers 200 with a title like any healthy card', () => {
  // This is the whole point. A monitor that checked status, or merely checked that og:title exists,
  // would have called the week Facebook was down a week of perfect health.
  assert.equal(cardVerdict(FAILURE_CARD), 'failure-card')
  assert.equal(smokeOutcome(cardVerdict(FAILURE_CARD)), 'smoke_fail')
})

test('BOTH HEALTHY HEAD SHAPES PASS — a media post deliberately carries NO og:image', () => {
  // render/discord.ts forbids og:image on a post WITH media, because Discord draws that from the
  // Mastodon-shaped document behind the activity link instead. A check that required og:image would
  // fail every working video post on the service, which is the opposite of useful.
  assert.equal(cardVerdict(REAL_MEDIA_CARD), 'ok')
  assert.equal(cardVerdict(REAL_IMAGE_CARD), 'ok')
})

test('A ROW THAT EXPECTS A VIDEO GOES RED ON A CARD WITH NO PLAYER', () => {
  /**
   * THE HOLE THIS CLOSES. Every Discord head this service emits carries the activity link
   * unconditionally, and cardVerdict counts that link as "something to draw" — so on YouTube the
   * default assertion was met by the head's own boilerplate and the row could not fail short of the
   * upstream vanishing — through the three weeks after 553bd2e (2026-08-09) cut the crawler's mux
   * budget and left first pastes structurally unable to carry a player.
   *
   * BOTH PLAYERLESS SHAPES ARE PINNED, and the first is the one that actually happens: renderSpoof
   * emits og:image only on a post with no media at all, so a degraded video post carries the activity
   * link and nothing else drawable. The og:image variant is checked too because a future normalizer
   * change could start emitting one, and "there is a picture" must still not count as "there is a
   * player" on a row that asked for a player.
   */
  assert.equal(cardVerdict(WARM_VIDEO_CARD, 'video'), 'ok')
  assert.equal(cardVerdict(DEGRADED_VIDEO_CARD, 'video'), 'no-video')
  assert.equal(cardVerdict(REAL_IMAGE_CARD, 'video'), 'no-video')
  // Both count as smoke_fail, and the counter is the only thing the cron writes down. `no-video`
  // exists so the log line and /_smoke can say WHICH half of the service to look at — the same reason
  // `timeout` is not a second spelling of `threw`.
  assert.equal(smokeOutcome(cardVerdict(DEGRADED_VIDEO_CARD, 'video')), 'smoke_fail')

  // AND THE FAILURE CARD STILL WINS. "The upstream is gone" is a different repair from "the mux is
  // cold", and an expectation must not relabel the first as the second.
  assert.equal(cardVerdict(FAILURE_CARD, 'video'), 'failure-card')
  assert.equal(cardVerdict('', 'video'), 'no-card')

  /**
   * THE CLOSING QUOTE IN THE og:video MATCH IS LOAD-BEARING, and the code says so — but nothing held
   * it, because every fixture carrying `og:video:width` also carries a bare `og:video`. Dropping the
   * quote left the whole suite green. This is the shape that can tell them apart: the satellite tags
   * with no player tag between them. It cannot arise from spoofVideoTags, which emits the family
   * together, and that is the point — a regex loose enough to pass this is loose enough to report a
   * player on any head whose og:video was dropped while its siblings survived a future edit.
   */
  const SATELLITES_ONLY = '<html><head>'
    + '<meta property="og:title" content="jawed (@jawed)"/>'
    + '<meta property="og:video:type" content="video/mp4"/>'
    + '<meta property="og:video:width" content="0"/>'
    + '<link rel="alternate" type="application/activity+json" href="https://mbedfx.app/u/1"/>'
    + '</head><body></body></html>'
  assert.equal(cardVerdict(SATELLITES_ONLY, 'video'), 'no-video',
    'og:video:width is not a player')
  assert.equal(cardVerdict(SATELLITES_ONLY), 'ok', 'and without an expectation it is judged as before')
})

test('THE EXPECTATION IS OPT-IN, and every row without one is judged exactly as before', () => {
  /**
   * THE CONSTRAINT THAT MATTERS AS MUCH AS THE CHECK ITSELF. og:video must never become universal:
   * the plain OpenGraph head carries og:image and no video, several platforms are image-only, and the
   * Bluesky profile row is a profile. Eleven of the seventeen rows name no video in their own notes,
   * so requiring it everywhere would turn most of the list red — the "alarm nobody believes" failure
   * that keeps Streamable out of it entirely.
   */
  assert.equal(cardVerdict(DEGRADED_VIDEO_CARD), 'ok', 'no expectation, no video needed')
  assert.equal(cardVerdict(REAL_MEDIA_CARD, undefined), 'ok')
  assert.equal(cardVerdict(REAL_IMAGE_CARD), 'ok')

  const strict = SMOKE_CHECKS.filter(c => c.expect)
  assert.deepEqual(strict.map(c => c.name), ['yt'],
    'exactly one row demands a player. Adding another is a decision to defend in SmokeExpect, not a '
    + 'tidy-up: it must be a row whose media is durably warm, or the monitor starts crying on a timer.')
  for (const c of strict) assert.equal(c.expect, 'video', 'the only expectation this file knows')
})

test('cardVerdict IS TOTAL OVER JUNK — a monitor must not throw on a bad answer', () => {
  // It runs unattended on a timer. A throw here is an alert nobody receives.
  for (const bad of [null, undefined, 42, '', {}, [], '<html></html>', '<!doctype html>']) {
    assert.equal(cardVerdict(bad), 'no-card', `${JSON.stringify(bad)} is not a card`)
    // The strict row runs on the same timer and gets the same junk when an upstream misbehaves.
    assert.equal(cardVerdict(bad, 'video'), 'no-card', `${JSON.stringify(bad)} is not a card`)
  }
})

test('EVERY CHECK IS RUN AND EACH VERDICT IS REPORTED, so one broken platform cannot mask another', () => {
  // Not `Promise.all` with a throwing member, and not a loop that stops at the first failure: the
  // question is which platforms are broken, not whether any is.
  const seen = []
  const render = async (u) => {
    seen.push(u)
    return new Response(u.includes('/WYFF4/') ? FAILURE_CARD : healthyCard(u), { status: 200 })
  }
  return runSmoke('https://mbedfx.app', render).then(results => {
    assert.equal(results.length, SMOKE_CHECKS.length, 'every check ran')
    assert.equal(seen.length, SMOKE_CHECKS.length)
    const fb = results.find(r => r.platform === 'fb')
    assert.equal(fb.verdict, 'failure-card', 'the broken platform is named')
    assert.ok(results.filter(r => r.platform !== 'fb').every(r => r.verdict === 'ok'),
      'and the healthy ones are still reported as healthy')
  })
})

test('A RENDER THAT THROWS IS A FAILED CHECK, not a dead run', () => {
  // An upstream that hangs up mid-render is exactly the kind of outage this exists to catch, so a
  // throw must be counted rather than propagated.
  let calls = 0
  const render = async () => { calls++; throw new Error('connection reset') }
  return runSmoke('https://mbedfx.app', render).then(results => {
    assert.equal(calls, SMOKE_CHECKS.length, 'it kept going after the first throw')
    assert.ok(results.every(r => r.verdict === 'threw'))
    assert.ok(results.every(r => smokeOutcome(r.verdict) === 'smoke_fail'))
  })
})

test('runSmoke CARRIES EACH ROW\'S EXPECTATION, so the strict row is the only one that goes red', () => {
  /**
   * THE WIRING, END TO END, because a per-row expectation that cardVerdict honours and runSmoke never
   * passes is a check that only exists in its own unit test. The head below is the SAME playerless
   * shape for every row — the one a cold mux produces — and exactly one row must report it.
   */
  const render = async () => new Response(DEGRADED_VIDEO_CARD, { status: 200 })
  return runSmoke('https://mbedfx.app', render).then(results => {
    const yt = results.find(r => r.name === 'yt')
    assert.equal(yt.verdict, 'no-video', 'the row that asked for a player is told it did not get one')
    assert.equal(smokeOutcome(yt.verdict), 'smoke_fail')
    assert.ok(results.filter(r => r.name !== 'yt').every(r => r.verdict === 'ok'),
      'and no other row is made stricter by it — this head is a perfectly healthy media post for them')
  })
})

test('THE CHECK LIST TAKES NO INPUT, which is what makes the endpoint safe to expose', () => {
  /**
   * `/_smoke` renders these paths and nothing else. The property that keeps it from being an open
   * fetch relay wearing a monitoring badge is that a caller cannot influence the target: the paths
   * are constants and the origin is the request's own. A future version that accepted `?url=` would
   * hand the internet a proxy on our egress, which reaches surfaces a stranger's IP cannot.
   */
  for (const c of SMOKE_CHECKS) {
    assert.ok(c.path.startsWith('/'), 'a check is a PATH on our own origin, never a url')
    assert.ok(!/^https?:/i.test(c.path), 'and never an absolute url')
    assert.ok(!c.path.includes('..'), 'and cannot traverse')
    assert.match(c.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, 'each entry records when it was last seen working')
  }
  assert.ok(SMOKE_CHECKS.length >= 4, 'a detector covering one platform is not a detector')
})

test('EVERY PLATFORM IS EITHER CHECKED OR NAMED AS UNCHECKED, so "unwatched" cannot go unnoticed again', () => {
  /**
   * THE DEFECT THIS PREVENTS, which is the one that produced this test. SMOKE_CHECKS covered six of
   * seventeen platforms for the first day of its life, and the way anybody found out was an audit
   * rendering all seventeen through production by hand on 2026-08-12. Nothing in the repo said which
   * platforms had no detector; you had to read the list and hold the seventeen in your head.
   *
   * DERIVED, NOT LISTED, for the same reason test/prep.test.mjs parses the Route union rather than
   * copying it: a hand-written roll call here would be a second list to keep in step with the first,
   * and CLAUDE.md's own account of parseRefKey is what happens when one of those two goes stale.
   * The Platform union in src/types.ts is the source, so an eighteenth platform fails this test the
   * moment it is declared — which forces a decision (write a check, or write down why not) instead
   * of an oversight.
   *
   * IT SLICES TO THE NEXT DECLARATION RATHER THAN READING ONE LINE, and that is the difference
   * between this guard working and only appearing to. The first version matched
   * /export type Platform =([^\n]*)/ — a single line — and the union is already 150 characters, so
   * the natural way to add an eighteenth platform is a continuation line. Reproduced: with `| 'zz'`
   * on line 2 the parse still yields 17 names, `zz` is absent from the roll call, a `>= 17`
   * assertion passes, and the new platform is silently unwatched. That is precisely the defect the
   * paragraph above says is now impossible. test/prep.test.mjs, cited here as the precedent, was
   * multi-line safe all along; this now does what that one does.
   *
   * AND THE COUNT IS EXACT, not `>= 17`. A floor cannot fail when the union GROWS, which is the only
   * direction it ever moves — so the floor was unfalsifiable in practice. An exact count means
   * adding a platform breaks this test on purpose.
   */
  const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
  const start = types.indexOf('export type Platform =')
  assert.notEqual(start, -1, 'src/types.ts still declares the Platform union')
  const rest = types.slice(start + 'export type Platform ='.length)
  // To the next top-level declaration, so a union spread over any number of lines is read whole.
  const end = rest.search(/\n\s*(?:export |\/\*\*|type |const |interface )/)
  const decl = end === -1 ? rest : rest.slice(0, end)
  const all = [...decl.matchAll(/'([a-z]+)'/g)].map(m => m[1])
  assert.equal(all.length, 17,
    `the Platform union holds ${all.length} platforms; if that is deliberate, update this count AND `
    + 'give the new platform a row in SMOKE_CHECKS or a reason in SMOKE_UNCHECKED')

  const checked = new Set(SMOKE_CHECKS.map(c => c.platform))
  const excused = new Set(SMOKE_UNCHECKED.map(u => u.platform))
  const both = all.filter(p => checked.has(p) && excused.has(p))
  assert.deepEqual(both, [], 'a platform cannot be both checked and excused — delete the SMOKE_UNCHECKED row')
  const orphans = all.filter(p => !checked.has(p) && !excused.has(p))
  assert.deepEqual(orphans, [],
    `${orphans.join(', ')} has no smoke check and no reason on record. Verify a post for it through `
    + 'production and add a row, or add it to SMOKE_UNCHECKED saying what would have to change first.')

  for (const u of SMOKE_UNCHECKED) {
    assert.ok(all.includes(u.platform), `${u.platform} is excused from a list it is not on`)
    assert.ok(u.why.length > 20, 'an excuse with no reason in it is the thing this list exists to stop')
  }
})

test('EVERY ROW HAS A UNIQUE NAME, because the counter cannot tell two rows on one platform apart', () => {
  /**
   * `bs` has two rows — the profile route and a post — and Analytics Engine's blob1 is the platform,
   * so both sum into one `bs` pair in the query in docs/METRICS.md. `/_smoke` and the cron's log
   * line report `name` for exactly that reason. Two rows sharing a name would put the reader back
   * where the counter leaves them: told that something on this platform broke, and not which.
   */
  const names = SMOKE_CHECKS.map(c => c.name)
  assert.equal(new Set(names).size, names.length, `duplicate check name in ${names.join(', ')}`)
  for (const c of SMOKE_CHECKS) {
    assert.ok(c.name === c.platform || c.name.startsWith(`${c.platform}:`),
      `${c.name} should read as its platform or ${c.platform}:something, so a log line stays greppable`)
  }
})

test('A CHECK THAT NEVER ANSWERS IS A TIMEOUT, AND THE CHECKS BEHIND IT STILL RUN', () => {
  /**
   * THE FAILURE THIS EXISTS FOR. Cloudflare's limits page (read 2026-08-12) says there is no time
   * limit on an individual subrequest, and no platform fetcher in this repo passes an AbortSignal —
   * so an upstream that accepts the connection and then says nothing stalls its render for as long
   * as the invocation lives. A scheduled invocation is killed at 15 minutes. Without a per-check
   * budget, one such upstream eats the rest of the list, every check behind it goes uncounted, and
   * docs/METRICS.md says that reads exactly like "the cron is not running".
   *
   * The verdict is `timeout` rather than `threw` on purpose: both count as `smoke_fail`, and only
   * one of them tells the reader the upstream is hanging rather than refusing.
   */
  const seen = []
  const render = async (u) => {
    seen.push(u)
    if (u.includes('/WYFF4/')) return new Promise(() => {})
    return new Response(healthyCard(u), { status: 200 })
  }
  return runSmoke('https://mbedfx.app', render, 20).then(results => {
    assert.equal(seen.length, SMOKE_CHECKS.length, 'the hung check did not eat the ones behind it')
    const fb = results.find(r => r.name === 'fb')
    assert.equal(fb.verdict, 'timeout')
    assert.equal(smokeOutcome(fb.verdict), 'smoke_fail', 'a hang is a failure, not a pass')
    assert.ok(results.filter(r => r.name !== 'fb').every(r => r.verdict === 'ok'))
  })
})

test('A RENDER THAT REJECTS AFTER LOSING THE RACE IS NOT AN UNHANDLED REJECTION', () => {
  /**
   * The abandoned half of the timeout race keeps running — a Worker cannot cancel a fetch in flight
   * — so it can still reject, seconds after runSmoke stopped waiting for it. `Promise.race` attaches
   * a rejection handler to both members, which is what keeps that late rejection handled; a spelling
   * that unwound the race (an `await` with a bare `.then` beside it) would turn one slow upstream
   * into a dead invocation, and the monitor would go quiet in exactly the outage it exists for.
   */
  const late = []
  const onUnhandled = (err) => { if (String(err?.message).includes('late-reset')) late.push(err) }
  process.on('unhandledRejection', onUnhandled)
  const render = async (u) => u.includes('/WYFF4/')
    ? new Promise((_, reject) => setTimeout(() => reject(new Error('late-reset')), 15))
    : new Response(healthyCard(u), { status: 200 })
  return runSmoke('https://mbedfx.app', render, 5)
    .then(results => new Promise(done => setTimeout(() => done(results), 60)))
    .then(results => {
      assert.deepEqual(late, [], 'the late rejection escaped runSmoke')
      assert.equal(results.find(r => r.name === 'fb').verdict, 'timeout')
      assert.equal(results.length, SMOKE_CHECKS.length)
    })
    .finally(() => process.off('unhandledRejection', onUnhandled))
})

test('EVERY RESULT CARRIES ITS OWN ELAPSED TIME, so the budget can be re-measured instead of remembered', () => {
  /**
   * The serial loop is safe because of an arithmetic claim about how long a run takes, and this
   * project's most repeated defect is a budget that was true when it was written and never checked
   * again (META_WAIT_API_MS at 4000 against a 2.3-6.7s extract). `/_smoke` reports these so the next
   * person to widen the list reads the real cost instead of inheriting a number.
   *
   * ONE RENDER IS DELIBERATELY SLOW, and that is what makes this a test rather than a shape check.
   * The first version asserted only `Number.isFinite(r.ms) && r.ms >= 0` against renders that all
   * resolve instantly, so a hardcoded `ms: 0` in runSmoke would have passed it — a field whose whole
   * purpose is carrying a REAL duration, pinned by an assertion that cannot tell a duration from a
   * constant. Holding exactly one check for ~30ms also pins that the timer is PER CHECK and not per
   * run: the others must still report near zero, which a single run-level stopwatch could not do.
   */
  const SLOW = SMOKE_CHECKS[1].path
  const render = async url => {
    if (url.endsWith(SLOW)) await new Promise(r => setTimeout(r, 30))
    return new Response(healthyCard(url), { status: 200 })
  }
  return runSmoke('https://mbedfx.app', render).then(results => {
    assert.ok(results.every(r => Number.isFinite(r.ms) && r.ms >= 0), 'every check reports a duration')
    assert.ok(results.every(r => typeof r.name === 'string' && r.name), 'and names itself')
    const slow = results[1]
    assert.ok(slow.ms >= 25, `the slow check must report its real cost, got ${slow.ms}ms`)
    const others = results.filter((_, i) => i !== 1)
    assert.ok(others.every(r => r.ms < 25),
      'and the others must not inherit it — the timer is per check, not per run')
  })
})

test('THE WORST-CASE RUN FITS INSIDE ONE SCHEDULED INVOCATION, with the whole list hung', () => {
  /**
   * The bound that makes "keep it serial" a decision rather than a hope: every check hanging until
   * its budget expires, one after another, must still finish inside Cloudflare's 15-minute wall
   * clock for a Cron Trigger. At sixteen checks and a 20s budget that is 320s, about a third of the
   * ceiling.
   *
   * THIS IS THE TEST THAT FAILS when someone doubles the list or raises the budget without doing the
   * arithmetic. Doing it in a test rather than in a comment is deliberate: a comment claiming a
   * number cannot notice that the number stopped being true, and a run that overruns the ceiling
   * fails SILENTLY — the invocation is killed and the checks after the kill simply never counted.
   */
  assert.ok(smokeRunCeilingMs() <= CRON_WALL_LIMIT_MS / 2,
    `${SMOKE_CHECKS.length} checks x ${SMOKE_BUDGET_MS}ms = ${smokeRunCeilingMs()}ms, which leaves no `
    + `margin under the ${CRON_WALL_LIMIT_MS}ms ceiling. Shorten the budget, split the list across `
    + 'ticks, or measure again and say why this is still safe.')
  assert.ok(SMOKE_BUDGET_MS >= 10_000,
    'the budget is meant to catch a hung upstream, not a slow one — the slowest cold render measured '
    + 'through production on 2026-08-12 was Facebook at 4.0s, and a budget close to that would turn '
    + 'a slow day into a false alarm')
})
