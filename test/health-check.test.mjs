import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, judged, planIssues, renderSummary, issueBody, marker, platformName, smokeFailures, WEEK_FAIL_RATE, STREAK } from '../.github/scripts/health-lib.mjs'

/**
 * THE TWICE-WEEKLY REPORT'S JUDGEMENT (.github/scripts/health-lib.mjs), which decides what opens an issue.
 * The numbers in these tests are the week the check was built for: 2026-10-08 to 2026-10-14, TikTok 369 of
 * 380 scheduled runs failed, Instagram 198 of 322, Dailymotion about once a day by design.
 */

const check = (name, platform, fail, runs, extra = {}) => ({
  name, platform, path: `/${name}`, runs, ok: runs - fail, fail,
  failRate: runs ? Math.round((fail / runs) * 1000) / 1000 : null, streak: 0, lastVerdict: fail ? 'failure-card' : 'ok',
  lastAt: '2026-10-14T11:00:00.000Z', lastColo: 'LHR', verdicts: {}, colos: {}, perDay: [], ...extra,
})
const healthy = (checks, ageMinutes = 10) => ({ ok: true, status: 200, json: { updated: '2026-10-14T11:00:00.000Z', ageMinutes, colo: 'LHR', days: [], checks } })
const liveOk = { ran: true, failed: new Map() }
const clientsOk = { ok: true, status: 200, json: { ok: true, serving: ['web_safari'] } }
const guestsOk = ['sorryifuckedyour.mom', 'hotsinglesnear.you'].map(host => ({
  host, path: '/r/pics/comments/haucpf',
  root: { status: 200, contentType: 'text/html; charset=utf-8', marked: false },
  d: { status: 302, marked: true, location: `https://d.${host}/_media/rd%3Apics%3Ahaucpf/0` },
}))
const keys = (problems) => problems.map(p => p.key)
// A week in which nothing failed. Never an empty list: src/health.ts names every check even before the
// first run, so an empty list is not a week, and readableWeek treats it as the site not answering.
const quiet = [check('x', 'x', 0, 380)]

test('THIS WEEK OPENS TIKTOK AND INSTAGRAM, and Dailymotion\'s known daily cold miss opens nothing', () => {
  const problems = evaluate({
    health: healthy([
      check('tt', 'tt', 369, 380), check('ig', 'ig', 198, 322), check('dm', 'dm', 7, 336), check('x', 'x', 0, 380),
    ]),
    live: liveOk, clients: clientsOk, guests: guestsOk,
  })
  assert.deepEqual(keys(problems), ['check:tt', 'check:ig'])
  assert.ok(7 / 336 < WEEK_FAIL_RATE, 'precondition: Dailymotion\'s ~2% is under the line by a wide margin')
  const tt = problems[0]
  assert.match(tt.title, /^TikTok is failing/)
  assert.match(tt.body, /Failed \*\*369 of 380\*\*/)
  assert.match(tt.body, /From GitHub's network:\*\* passed/, 'and says the live run passed, which points at the cron\'s location')
})

test('A FAILURE STREAK OPENS AN ISSUE even before it moves the week\'s rate', () => {
  const problems = evaluate({
    health: healthy([check('th', 'th', STREAK, 300, { streak: STREAK })]), live: liveOk, clients: clientsOk, guests: guestsOk,
  })
  assert.deepEqual(keys(problems), ['check:th'])
  const short = evaluate({
    health: healthy([check('th', 'th', STREAK - 1, 300, { streak: STREAK - 1 })]), live: liveOk, clients: clientsOk, guests: guestsOk,
  })
  assert.deepEqual(keys(short), [], 'two and a half hours is still a blip')
})

test('TOO FEW RUNS TO JUDGE A RATE IS NOT A FAILURE, so a fresh deploy does not open seventeen issues', () => {
  const problems = evaluate({ health: healthy([check('tt', 'tt', 3, 3)]), live: liveOk, clients: clientsOk, guests: guestsOk })
  assert.deepEqual(keys(problems), [])
})

test('A STOPPED CRON IS A PROBLEM OF ITS OWN, because a stopped monitor otherwise reads as health', () => {
  assert.deepEqual(keys(evaluate({ health: healthy(quiet, 600), live: liveOk, clients: clientsOk, guests: guestsOk })), ['cron'])
  // Before the first run the summary still names every check, each with zero runs.
  const never = evaluate({ health: { ok: true, status: 200, json: { updated: null, ageMinutes: null, checks: [check('x', 'x', 0, 0)] } }, live: liveOk, clients: clientsOk, guests: guestsOk })
  assert.deepEqual(keys(never), ['cron'])
  assert.match(never[0].body, /No scheduled run has ever been recorded/)
})

test('A LIVE FAILURE COUNTS ONLY WHEN IT FAILED TWICE, and it is folded into that check\'s issue', () => {
  const live = { ran: true, failed: new Map([['ig', 'failure-card']]) }
  const problems = evaluate({ health: healthy([check('ig', 'ig', 0, 300)]), live, clients: clientsOk, guests: guestsOk })
  assert.deepEqual(keys(problems), ['check:ig'])
  assert.match(problems[0].body, /failed twice a minute apart/)
})

test('THE SITE NOT ANSWERING, THE CONTAINER AND THE GUEST DOMAINS each have a problem of their own', () => {
  const down = evaluate({ health: { ok: false, error: 'fetch failed' }, live: { ran: false, error: 'fetch failed', failed: new Map() }, clients: { ok: false, error: 'fetch failed' }, guests: guestsOk })
  assert.deepEqual(keys(down), ['site', 'clients'], 'one site problem, not one per endpoint')
  const container = evaluate({ health: healthy(quiet), live: liveOk, clients: { ok: false, status: 502, json: { ok: false, error: 'resolver unreachable' } }, guests: guestsOk })
  assert.deepEqual(keys(container), ['clients'])
  const guests = structuredClone(guestsOk)
  guests[1].d = { status: 404, marked: false, location: null }
  guests[0].root = { status: 200, contentType: 'text/html', marked: true }
  assert.deepEqual(keys(evaluate({ health: healthy(quiet), live: liveOk, clients: clientsOk, guests })),
    ['guest:sorryifuckedyour.mom', 'guest:hotsinglesnear.you'])
})

test('A 200 IS NOT A PASS: each answer is judged on what it says, never on its status', () => {
  // /_clients answers 200 with ok:false when the container replies but serves no client (src/worker.ts).
  // The first draft read the HTTP status and would have called that container healthy.
  const empty = { ok: true, status: 200, json: { ok: false, serving: [], ms: 900 } }
  assert.deepEqual(keys(evaluate({ health: healthy(quiet), live: liveOk, clients: empty, guests: guestsOk })), ['clients'])
  // A 200 from /_health that is not the week cannot be judged, and is said to be so.
  const decoy = { ok: true, status: 200, json: { hello: 'not a week' } }
  const problems = evaluate({ health: decoy, live: liveOk, clients: clientsOk, guests: guestsOk })
  assert.deepEqual(keys(problems), ['site'])
  assert.match(problems[0].body, /answered HTTP 200, but not with the week's checks/)
})

test('A /_smoke ANSWER IS READ FOR ITS FAILURE LIST, and an answer without one is not a pass', () => {
  assert.deepEqual([...smokeFailures({ ok: false, checked: 17, failed: [{ name: 'tt', verdict: 'failure-card' }] })], [['tt', 'failure-card']])
  assert.equal(smokeFailures({ ok: true, checked: 17, failed: [] }).size, 0)
  for (const junk of [
    null, {}, { ok: true, checked: 17 }, { ok: true, checked: 0, failed: [] },
    { ok: false, checked: 17, failed: [] }, { ok: true, checked: 17, failed: [{ name: 'tt', verdict: 'timeout' }] },
    { ok: false, checked: 17, failed: [{ verdict: 'timeout' }] },
  ]) {
    assert.equal(smokeFailures(junk), null, JSON.stringify(junk))
  }
})

test('AN ISSUE IS CLOSED ONLY BY A RUN THAT CHECKED IT, so the day the site is down is never an all-clear', () => {
  // The first draft closed every open issue whose problem was absent. With /_health down no scheduled
  // check can be raised at all, so it would have closed TikTok's and Instagram's issues as "passed again".
  const down = { health: { ok: false, status: null, error: 'fetch failed' }, live: { ran: false, error: 'fetch failed', failed: new Map() }, clients: clientsOk, guests: guestsOk }
  const problems = evaluate(down)
  assert.deepEqual(keys(problems), ['site'])
  const open = ['check:tt', 'cron', 'clients', 'guest:hotsinglesnear.you', 'guest:retired.example']
    .map((key, i) => ({ number: 30 + i, title: key, body: `${marker(key)}\nold` }))
  const actions = planIssues(problems, open, null, k => judged(k, down))
  assert.deepEqual(actions.map(a => [a.type, a.number ?? a.title]), [
    ['create', '[health-check] mbedfx.app did not answer the health check'],
    ['skip', 30], ['skip', 31], ['resolve', 32], ['resolve', 33],
    ['skip', 34], // a domain no longer checked is left for a person to close, never declared healthy
  ])
  // The week answered but the live run did not: a check issue may have been opened by the live run alone.
  const noLive = { health: healthy(quiet), live: { ran: false, error: 'timeout', failed: new Map() }, guests: guestsOk }
  assert.equal(judged('check:tt', noLive), false)
  assert.equal(judged('cron', noLive), true)
  // And with no judgement at all, nothing is closed.
  assert.deepEqual(planIssues([], [{ number: 1, title: 't', body: marker('site') }], null).map(a => a.type), ['skip'])
})

test('ZEROS MEASURED NOTHING: a week never written, a stale one, a thin one or a renamed check closes no check issue', () => {
  // Review of PR #105: /_health summarised an unread week as zeros, every check then looked judged, and an
  // open TikTok issue (a failure only the scheduled run sees) was closed as "passed again" by a run whose
  // live check passed. The 503 for an unread week is in src/health.ts; this is the reader's half.
  const open = [{ number: 41, title: 't', body: `${marker('check:tt')}\nold` }]
  const verdict = (health) => planIssues([], open, null, k => judged(k, { health, live: liveOk, guests: guestsOk }))[0].type
  const never = { ok: true, status: 200, json: { updated: null, ageMinutes: null, checks: [check('tt', 'tt', 0, 0)] } }
  assert.equal(verdict(never), 'skip', 'no run ever recorded')
  assert.equal(verdict(healthy([check('tt', 'tt', 0, 300)], 600)), 'skip', 'the record stopped being written ten hours ago')
  assert.equal(verdict(healthy([check('tt', 'tt', 0, 4)])), 'skip', 'four runs is not a week')
  assert.equal(verdict(healthy([check('x', 'x', 0, 380)])), 'skip', 'a check no longer in the list was never looked at')
  assert.equal(verdict(healthy([check('tt', 'tt', 0, 300)])), 'resolve', 'and a fresh week of passes still closes it')
})

test('ISSUES: OPEN A NEW ONE, COMMENT ON THE OPEN ONE, CLOSE THE ONE THAT PASSED, matched by marker not title', () => {
  const problems = [{ key: 'check:tt', title: 'TikTok is failing', body: 'b' }, { key: 'check:ig', title: 'Instagram is failing', body: 'b' }]
  const open = [
    { number: 7, title: 'renamed by hand', body: `${marker('check:tt')}\nold` },
    { number: 9, title: '[health-check] YouTube is failing', body: `${marker('check:yt')}\nold` },
    { number: 11, title: 'an unrelated issue with the label', body: 'no marker' },
  ]
  // A yt row with a full week of passes: since the review of PR #105 a check issue closes only on evidence
  // that the check passed, and the `quiet` week alone has no yt row at all.
  const checked = { health: healthy([...quiet, check('yt', 'yt', 0, 300)]), live: liveOk, guests: guestsOk }
  const actions = planIssues(problems, open, 'https://example.invalid/run/1', k => judged(k, checked))
  assert.deepEqual(actions.map(a => [a.type, a.number ?? a.title]), [
    ['comment', 7], ['create', '[health-check] Instagram is failing'], ['resolve', 9],
  ])
  assert.ok(actions.every(a => !a.body || a.body.includes('example.invalid/run/1') || a.type === 'resolve'))
  assert.ok(issueBody(problems[0], null).startsWith(marker('check:tt')), 'the marker leads, so the next run finds it')
})

test('NOTHING BROKEN, NOTHING FILED, and the run page says so', () => {
  const problems = evaluate({ health: healthy([check('x', 'x', 0, 380)]), live: liveOk, clients: clientsOk, guests: guestsOk })
  assert.deepEqual(problems, [])
  assert.deepEqual(planIssues(problems, [], null), [])
  const page = renderSummary(problems, { health: healthy([check('x', 'x', 0, 380)]), live: liveOk, clients: clientsOk, guests: guestsOk })
  assert.match(page, /Everything passed\./)
  assert.match(page, /`\/_smoke` from GitHub's network: passed/)
  assert.match(page, /\(`\/_clients`\): serving web_safari/)
  assert.match(page, /Guest domains: 2 of 2 answering/)
})

test('THE RUN PAGE SAYS WHAT IT COULD NOT LOOK AT, instead of one line that hides the rest', () => {
  // Measured 2026-10-14 against production before /_health existed: the page said only that the site did
  // not answer, and nothing about whether the live run, the container or the guest domains had passed.
  const inputs = {
    health: { ok: false, status: 404, error: 'HTTP 404, not JSON' },
    live: { ran: false, error: 'The operation was aborted due to timeout', failed: new Map() },
    clients: { ok: true, status: 200, json: { ok: false, serving: [] } },
    guests: [guestsOk[0], { ...guestsOk[1], d: { status: 404, marked: false, location: null } }],
  }
  const problems = evaluate(inputs)
  assert.match(problems[0].body, /did not answer from GitHub's network either: The operation was aborted/)
  const page = renderSummary(problems, inputs)
  assert.match(page, /week \(`\/_health`\): not readable \(HTTP 404, not JSON\)/)
  assert.match(page, /network: did not run \(The operation was aborted due to timeout\)/)
  assert.match(page, /\(`\/_clients`\): not serving \(HTTP 200\)/)
  assert.match(page, /Guest domains: broken: hotsinglesnear\.you/)
})

test('THE PLATFORM IS CALLED TWITTER, the owner\'s preference, wherever the report names it', () => {
  assert.equal(platformName('x'), 'Twitter')
  const problems = evaluate({ health: healthy([check('x', 'x', 300, 380)]), live: liveOk, clients: clientsOk, guests: guestsOk })
  assert.match(problems[0].title, /^Twitter is failing/)
})
