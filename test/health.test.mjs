import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldSmoke, healthSummary, cronColo, recordSmoke, HEALTH_KEY, HEALTH_DAYS } from '../src/health.ts'
import { SMOKE_CHECKS } from '../src/smoke.ts'
import worker, { handle, smokeWhereReadersAre, SMOKE_RUNNER_NAME } from '../src/worker.ts'

/**
 * THE SCHEDULED CHECK'S MEMORY (src/health.ts) and `/_health`, which publishes it. Added 2026-10-14 when the
 * counters showed TikTok failing on almost every half-hourly tick for a week with nobody told, while a live
 * `/_smoke` run passed. The twice-weekly report (.github/workflows/health-check.yml) reads this.
 */

const run = (verdicts) => Object.entries(verdicts).map(([name, verdict]) => ({
  name, verdict, ms: 1, platform: SMOKE_CHECKS.find(c => c.name === name)?.platform ?? 'x',
}))
const at = (iso) => new Date(iso)

test('A RUN IS COUNTED PER DAY AND PER CHECK, with its verdict and the location it ran from', () => {
  let rec = foldSmoke(null, run({ tt: 'failure-card', x: 'ok' }), at('2026-10-14T11:00:00Z'), 'LHR')
  rec = foldSmoke(rec, run({ tt: 'failure-card', x: 'ok' }), at('2026-10-14T11:30:00Z'), 'LHR')
  rec = foldSmoke(rec, run({ tt: 'ok', x: 'ok' }), at('2026-10-14T12:00:00Z'), 'IAD')
  const tt = rec.days['2026-10-14'].tt
  assert.deepEqual({ ok: tt.ok, fail: tt.fail }, { ok: 1, fail: 2 })
  assert.deepEqual(tt.verdicts, { 'failure-card': 2, ok: 1 })
  assert.deepEqual(tt.colos, { LHR: { ok: 0, fail: 2 }, IAD: { ok: 1, fail: 0 } }, 'where it failed is what tells a blocked location from a broken platform')
  assert.equal(rec.updated, '2026-10-14T12:00:00.000Z')
  assert.equal(rec.colo, 'IAD')
})

test('THE STREAK COUNTS FAILURES IN A ROW and a pass resets it', () => {
  let rec = null
  for (let i = 0; i < 5; i++) rec = foldSmoke(rec, run({ tt: i === 0 ? 'ok' : 'timeout' }), at(`2026-10-14T0${i}:00:00Z`), null)
  assert.equal(rec.last.tt.streak, 4)
  assert.equal(rec.last.tt.verdict, 'timeout')
  rec = foldSmoke(rec, run({ tt: 'ok' }), at('2026-10-14T06:00:00Z'), null)
  assert.equal(rec.last.tt.streak, 0)
})

test('ONLY THE NEWEST EIGHT DAYS ARE KEPT, so the object stays a few kilobytes forever', () => {
  let rec = null
  for (let d = 1; d <= 12; d++) rec = foldSmoke(rec, run({ x: 'ok' }), at(`2026-10-${String(d).padStart(2, '0')}T12:00:00Z`), null)
  assert.equal(Object.keys(rec.days).length, HEALTH_DAYS)
  assert.deepEqual(Object.keys(rec.days).sort()[0], '2026-10-05')
})

test('A STORED OBJECT THAT IS NOT A RECORD STARTS THE WEEK OVER instead of throwing in a scheduled run', () => {
  for (const junk of [null, 'nope', 42, [], { v: 2 }, { v: 1, days: 'x', last: {} }]) {
    const rec = foldSmoke(junk, run({ x: 'ok' }), at('2026-10-14T00:00:00Z'), null)
    assert.equal(rec.days['2026-10-14'].x.ok, 1, JSON.stringify(junk))
  }
  // Fields that are the wrong shape inside a real record are dropped, not trusted.
  const rec = foldSmoke({ v: 1, updated: 'x', days: { 'bad-day': {}, '2026-10-13': { x: { ok: 'many', fail: -3, colos: { lhr: {} } } } }, last: { x: { at: 1, verdict: 'ok' } } },
    run({ x: 'ok' }), at('2026-10-14T00:00:00Z'), 'not a colo')
  assert.deepEqual(Object.keys(rec.days).sort(), ['2026-10-13', '2026-10-14'])
  assert.deepEqual(rec.days['2026-10-13'].x, { ok: 0, fail: 0, verdicts: {}, colos: {} })
  assert.equal(rec.colo, null)
})

test('THE SUMMARY IS THE LAST SEVEN UTC DAYS, every check named, a check with no runs shown as zero', () => {
  let rec = null
  rec = foldSmoke(rec, run({ tt: 'failure-card', x: 'ok' }), at('2026-10-06T12:00:00Z'), 'LHR') // outside the window
  rec = foldSmoke(rec, run({ tt: 'failure-card', x: 'ok' }), at('2026-10-13T12:00:00Z'), 'LHR')
  rec = foldSmoke(rec, run({ tt: 'failure-card', x: 'ok' }), at('2026-10-14T12:00:00Z'), 'LHR')
  const s = healthSummary(rec, at('2026-10-14T12:30:00Z'))
  assert.deepEqual(s.days, ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'])
  assert.equal(s.ageMinutes, 30)
  assert.deepEqual(s.checks.map(c => c.name), SMOKE_CHECKS.map(c => c.name), 'every row, in SMOKE_CHECKS order')
  const tt = s.checks.find(c => c.name === 'tt')
  assert.deepEqual({ runs: tt.runs, fail: tt.fail, failRate: tt.failRate, streak: tt.streak, lastColo: tt.lastColo }, { runs: 2, fail: 2, failRate: 1, streak: 3, lastColo: 'LHR' })
  assert.equal(tt.path, SMOKE_CHECKS.find(c => c.name === 'tt').path)
  const ig = s.checks.find(c => c.name === 'ig')
  assert.deepEqual({ runs: ig.runs, failRate: ig.failRate, lastVerdict: ig.lastVerdict }, { runs: 0, failRate: null, lastVerdict: null })
  assert.deepEqual(healthSummary(null, at('2026-10-14T00:00:00Z')).updated, null, 'no record yet is a summary, not an error')
})

test('THE CRON\'S LOCATION IS READ FROM CLOUDFLARE\'S TRACE, and a miss is null rather than a failed run', async () => {
  const trace = 'fl=1\nh=cloudflare.com\nip=2a06::1\nts=1\nvisit_scheme=https\ncolo=LHR\nsliver=none\n'
  assert.equal(await cronColo(async () => new Response(trace)), 'LHR')
  assert.equal(await cronColo(async () => new Response('<html>blocked</html>')), null)
  assert.equal(await cronColo(async () => { throw new TypeError('reset') }), null)
})

const fakeR2 = () => {
  const store = new Map()
  return {
    store,
    async get(k) {
      const v = store.get(k)
      return v === undefined ? null : { async text() { return v }, async json() { return JSON.parse(v) } }
    },
    async put(k, v) { store.set(k, v) },
  }
}

/** A bucket whose reads fail and whose writes succeed: the partial outage that used to wipe the week. */
const failingReads = () => {
  const r2 = fakeR2()
  return { ...r2, store: r2.store, async get() { throw new Error('R2 read failed') } }
}

test('A FAILED READ SKIPS THE TICK, so one transient R2 error cannot replace eight days with one run', async () => {
  // Review of PR #105: the read error set the previous record to null and the write went ahead, erasing
  // the week and every streak, and for hours afterwards no rate or streak could fire.
  const r2 = failingReads()
  r2.store.set(HEALTH_KEY, JSON.stringify(foldSmoke(null, run({ tt: 'failure-card' }), at('2026-10-13T12:00:00Z'), 'IAD')))
  const before = r2.store.get(HEALTH_KEY)
  await recordSmoke(r2, run({ tt: 'ok' }), at('2026-10-14T12:00:00Z'), 'IAD')
  assert.equal(r2.store.get(HEALTH_KEY), before, 'untouched: this tick is lost, the week is not')
})

test('A STORED OBJECT THAT IS NOT JSON STARTS THE WEEK OVER, because waiting cannot repair it', async () => {
  const r2 = fakeR2()
  r2.store.set(HEALTH_KEY, 'not json at all')
  await recordSmoke(r2, run({ x: 'ok' }), at('2026-10-14T12:00:00Z'), 'IAD')
  const rec = JSON.parse(r2.store.get(HEALTH_KEY))
  assert.equal(rec.days['2026-10-14'].x.ok, 1)
})

test('/_health ANSWERS 503 WHEN THE WEEK CANNOT BE READ, never a summary of zeros that reads as a clean week', async () => {
  const deps = { cache: { async match() {}, async put() {} }, fetchPost: async () => null, resolveShortlink: async () => ({}), resolveRedditShare: async () => null }
  const res = await handle(new Request('https://mbedfx.app/_health'), { AE: { writeDataPoint() {} }, MEDIA_CACHE: failingReads() }, { waitUntil() {} }, deps)
  assert.equal(res.status, 503)
  assert.equal((await res.json()).ok, false)
  const empty = await handle(new Request('https://mbedfx.app/_health'), { AE: { writeDataPoint() {} }, MEDIA_CACHE: fakeR2() }, { waitUntil() {} }, deps)
  assert.equal(empty.status, 200, 'no record yet is still a summary: that is the first deploy, and it says so')
  assert.equal((await empty.json()).updated, null)
})

test('THE SCHEDULED RUN\'S RECORD ROUND-TRIPS THROUGH R2 and /_health publishes it', async () => {
  const r2 = fakeR2()
  await recordSmoke(r2, run({ tt: 'failure-card', x: 'ok' }), new Date(Date.now() - 60_000), 'LHR')
  await recordSmoke(r2, run({ tt: 'failure-card', x: 'ok' }), new Date(), 'LHR')
  assert.ok(r2.store.has(HEALTH_KEY))
  const env = { AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } }, MEDIA_CACHE: r2 }
  const deps = { cache: { async match() {}, async put() {} }, fetchPost: async () => { throw new Error('no fetch') }, resolveShortlink: async () => ({}), resolveRedditShare: async () => null }
  const res = await handle(new Request('https://mbedfx.app/_health'), env, { waitUntil() {} }, deps)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const j = await res.json()
  const tt = j.checks.find(c => c.name === 'tt')
  assert.equal(tt.fail, 2)
  assert.equal(tt.streak, 2)
  assert.equal(j.colo, 'LHR')
})

/** Runs the cron handler with a stand-in runner, and keeps what it counted, kept and printed. */
async function tick(runner) {
  const points = []
  const errors = []
  const pending = []
  const r2 = fakeR2()
  const env = { AE: { writeDataPoint(p) { points.push(p) } }, MEDIA_CACHE: r2, SMOKE_RUNNER: runner }
  const error = console.error
  console.error = (line) => { errors.push(line) }
  try {
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-14T12:00:00Z') }, env, { waitUntil(p) { pending.push(p) } })
    await Promise.all(pending)
  } finally {
    console.error = error
  }
  return { points, errors, r2 }
}

test('THE SCHEDULED CHECK RUNS FROM EASTERN NORTH AMERICA, where Discord\'s crawler is, and what it found there is what is kept', async () => {
  // From 2026-10-05 the cron ran mostly in Mumbai and Osaka, where TikTok and Instagram answer what they
  // do not answer Discord's crawler, and TikTok's row went red for a week with readers unaffected.
  const calls = []
  const results = run({ tt: 'ok', ig: 'failure-card' })
  const runner = {
    idFromName(name) { calls.push(['idFromName', name]); return `id:${name}` },
    get(id, options) { calls.push(['get', id, options]); return { async run() { return { results, colo: 'IAD' } } } },
  }
  const { points, errors, r2 } = await tick(runner)
  assert.deepEqual(calls, [['idFromName', SMOKE_RUNNER_NAME], ['get', `id:${SMOKE_RUNNER_NAME}`, { locationHint: 'enam' }]])
  assert.equal(points.length, results.length, 'one counter per check the runner reported')
  const rec = JSON.parse(r2.store.get(HEALTH_KEY))
  assert.equal(rec.colo, 'IAD', 'the location kept is where the runner ran, not where the cron landed')
  assert.equal(rec.last.ig.verdict, 'failure-card')
  assert.ok(errors.includes('smoke ig failure-card'))
})

test('A RUNNER THAT CANNOT BE REACHED RECORDS NOTHING, rather than measuring from wherever the cron landed', async () => {
  // Running the check in place instead would put the Mumbai measurement back into the week. A tick
  // that is missing costs nothing; one that stays missing is reported as the check having stopped.
  const runner = { idFromName: name => name, get: () => ({ async run() { throw new Error('overloaded') } }) }
  const { points, errors, r2 } = await tick(runner)
  assert.equal(points.length, 0)
  assert.equal(r2.store.size, 0)
  assert.deepEqual(errors, ['smoke runner unreachable'])
})

test('WITHOUT THE BINDING THE CHECK RUNS IN PLACE, as a self-hosted deploy needs, through the same body', async () => {
  const fetch = globalThis.fetch
  globalThis.fetch = async (u) => (String(u).endsWith('/cdn-cgi/trace') ? new Response('colo=LAX\n') : new Response('gone', { status: 404 }))
  try {
    const deps = {
      cache: { async match() {}, async put() {} }, fetchPost: async () => null, fetchProfile: async () => null,
      resolveShortlink: async () => ({}), resolveRedditShare: async () => null, resolveMetaShare: async () => null,
    }
    const ran = await smokeWhereReadersAre({ AE: { writeDataPoint() {} } }, { waitUntil() {} }, () => deps)
    assert.equal(ran.colo, 'LAX')
    assert.deepEqual(ran.results.map(r => r.name), SMOKE_CHECKS.map(c => c.name), 'every check, in order')
    assert.ok(ran.results.every(r => r.verdict !== 'ok'), 'with every upstream gone, nothing passes')
  } finally {
    globalThis.fetch = fetch
  }
})

test('/_health WITH NO BUCKET SAYS SO, and a guest domain declines it like every other diagnostic', async () => {
  const deps = { cache: { async match() {}, async put() {} }, fetchPost: async () => null, resolveShortlink: async () => ({}), resolveRedditShare: async () => null }
  const none = await handle(new Request('https://mbedfx.app/_health'), { AE: { writeDataPoint() {} } }, { waitUntil() {} }, deps)
  assert.equal(none.status, 503)
  const guest = await handle(new Request('https://hotsinglesnear.you/_health'), { AE: { writeDataPoint() {} }, MEDIA_CACHE: fakeR2() }, { waitUntil() {} }, deps)
  assert.equal(guest.status, 404)
  assert.equal(guest.headers.get('x-mbedfx-guest'), null, 'unmarked, so you-stupid serves its own page')
})
