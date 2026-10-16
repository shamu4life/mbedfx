import { SMOKE_CHECKS, type SmokeResult, type SmokeVerdict } from './smoke.ts'

/**
 * THE SCHEDULED CHECK'S MEMORY, and the reason it needs one.
 *
 * The half-hourly smoke run (src/smoke.ts, `scheduled()` in worker.ts) has counted its verdicts into
 * Analytics Engine since 2026-08-12, and nothing ever read them unprompted. When somebody finally did,
 * on 2026-10-14, the counters said TikTok had failed on essentially every tick since 2026-10-06 and
 * Instagram on about half, while a run of `/_smoke` from a residential connection that morning passed
 * all seventeen checks. Two facts followed: a break could sit for a week with nobody told, and a single
 * run at report time can be green in the middle of a red week.
 *
 * So each scheduled run is folded into one small R2 object, and `/_health` publishes it. The owner chose
 * this over handing GitHub a read-only Cloudflare token for Analytics Engine (2026-10-14): the record
 * lives where the check runs, and no credential leaves Cloudflare. .github/workflows/health-check.yml
 * reads it twice a week and files issues.
 *
 * WHAT IT HOLDS: per UTC day, per check name, ok/fail counts, the verdicts, and the Cloudflare location
 * (colo) each run came from; per check, the last verdict and how many runs in a row have failed. No url
 * a reader sent, no ip, no user agent: the check names and paths are constants, which is the same
 * boundary src/smoke.ts draws for its counters.
 *
 * ONE WRITER. Only the scheduled run records. `/_smoke` is public and takes no input, so letting it
 * write would let anybody skew the week, and a single writer every thirty minutes needs no locking for a
 * read-modify-write of a few kilobytes.
 */

/** The R2 key, in the media bucket beside the mux files: one object, rewritten by every scheduled run. */
export const HEALTH_KEY = 'health/smoke.json'

/** Whole UTC days kept: the seven a report reads, plus the one being written. */
export const HEALTH_DAYS = 8

type Counts = { ok: number; fail: number }
type CheckDay = Counts & { verdicts: Partial<Record<SmokeVerdict, number>>; colos: Record<string, Counts> }

export type HealthRecord = {
  v: 1
  /** When the last scheduled run started, ISO 8601. */
  updated: string
  /** The Cloudflare location that run executed in, when it could be read. */
  colo: string | null
  /** 'YYYY-MM-DD' (UTC) -> check name -> that day's counts. */
  days: Record<string, Record<string, CheckDay>>
  /** Check name -> its latest verdict and how many runs in a row have failed (0 after a pass). */
  last: Record<string, { at: string; verdict: SmokeVerdict; streak: number; colo: string | null }>
}

/**
 * EVERY SmokeVerdict, and a type error when smoke.ts gains one that is not listed here. readRecord drops
 * a `last` entry whose verdict it does not know, so a missing one would pin that check's streak at 1 on
 * every read and silently disable its streak alarm (review of PR #105, 2026-10-14). The same shape as
 * the parseRefKey allowlist in CLAUDE.md, closed by the compiler this time instead of by memory.
 */
const VERDICT_SET = {
  ok: true, 'failure-card': true, 'no-card': true, 'no-video': true, threw: true, timeout: true,
} satisfies Record<SmokeVerdict, true>
const VERDICTS = Object.keys(VERDICT_SET) as SmokeVerdict[]
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const COLO = /^[A-Z]{3}$/

/**
 * The stored object, re-validated. It comes back out of a bucket, so it is read the way worker.ts reads
 * a cached Post: anything that is not the expected shape is dropped rather than trusted, and a record
 * that is not one at all starts the week over instead of throwing inside a scheduled run.
 */
function readRecord(raw: unknown): HealthRecord | null {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.days) || !isObj(raw.last)) return null
  const days: HealthRecord['days'] = {}
  for (const [day, names] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObj(names)) continue
    const out: Record<string, CheckDay> = {}
    for (const [name, c] of Object.entries(names)) {
      if (!isObj(c)) continue
      const verdicts: CheckDay['verdicts'] = {}
      if (isObj(c.verdicts)) for (const v of VERDICTS) if (count(c.verdicts[v])) verdicts[v] = count(c.verdicts[v])
      const colos: CheckDay['colos'] = {}
      if (isObj(c.colos)) {
        for (const [k, cc] of Object.entries(c.colos)) if (COLO.test(k) && isObj(cc)) colos[k] = { ok: count(cc.ok), fail: count(cc.fail) }
      }
      out[name] = { ok: count(c.ok), fail: count(c.fail), verdicts, colos }
    }
    days[day] = out
  }
  const last: HealthRecord['last'] = {}
  for (const [name, l] of Object.entries(raw.last)) {
    if (!isObj(l) || typeof l.at !== 'string' || !VERDICTS.includes(l.verdict as SmokeVerdict)) continue
    last[name] = {
      at: l.at, verdict: l.verdict as SmokeVerdict, streak: count(l.streak),
      colo: typeof l.colo === 'string' && COLO.test(l.colo) ? l.colo : null,
    }
  }
  return {
    v: 1, updated: typeof raw.updated === 'string' ? raw.updated : '',
    colo: typeof raw.colo === 'string' && COLO.test(raw.colo) ? raw.colo : null, days, last,
  }
}

/** Fold one scheduled run into the record. Pure: the caller does the R2 read and write. */
export function foldSmoke(prev: unknown, results: readonly SmokeResult[], at: Date, colo: string | null): HealthRecord {
  const rec = readRecord(prev) ?? { v: 1, updated: '', colo: null, days: {}, last: {} }
  const where = colo && COLO.test(colo) ? colo : null
  const day = at.toISOString().slice(0, 10)
  const today = (rec.days[day] ??= {})
  for (const r of results) {
    const ok = r.verdict === 'ok'
    const c = (today[r.name] ??= { ok: 0, fail: 0, verdicts: {}, colos: {} })
    c[ok ? 'ok' : 'fail']++
    c.verdicts[r.verdict] = (c.verdicts[r.verdict] ?? 0) + 1
    if (where) {
      const cc = (c.colos[where] ??= { ok: 0, fail: 0 })
      cc[ok ? 'ok' : 'fail']++
    }
    const before = rec.last[r.name]
    rec.last[r.name] = {
      at: at.toISOString(), verdict: r.verdict, colo: where,
      streak: ok ? 0 : (before && before.verdict !== 'ok' ? before.streak : 0) + 1,
    }
  }
  // Keep the newest HEALTH_DAYS days. ISO dates sort as strings, so no date arithmetic is needed.
  for (const old of Object.keys(rec.days).sort().slice(0, -HEALTH_DAYS)) delete rec.days[old]
  rec.updated = at.toISOString()
  rec.colo = where
  return rec
}

/**
 * WHAT `/_health` PUBLISHES: the last seven UTC days, today included, summed per check. Facts only; what
 * counts as broken is decided by the reader (.github/scripts/health-lib.mjs), so a threshold can be tuned
 * without a deploy. `checks` follows SMOKE_CHECKS' order and names every row, including one with no runs
 * yet, so a check that silently stopped being run is visible as zero runs rather than as absence.
 */
export function healthSummary(raw: unknown, now: Date) {
  const rec = readRecord(raw)
  const days: string[] = []
  for (let i = 6; i >= 0; i--) days.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10))
  const checks = SMOKE_CHECKS.map(({ name, platform, path }) => {
    let ok = 0
    let fail = 0
    const verdicts: Partial<Record<SmokeVerdict, number>> = {}
    const colos: Record<string, Counts> = {}
    const perDay: Array<{ day: string } & Counts> = []
    for (const day of days) {
      const c = rec?.days[day]?.[name]
      perDay.push({ day, ok: c?.ok ?? 0, fail: c?.fail ?? 0 })
      if (!c) continue
      ok += c.ok
      fail += c.fail
      for (const [v, n] of Object.entries(c.verdicts)) verdicts[v as SmokeVerdict] = (verdicts[v as SmokeVerdict] ?? 0) + (n ?? 0)
      for (const [k, cc] of Object.entries(c.colos)) {
        const t = (colos[k] ??= { ok: 0, fail: 0 })
        t.ok += cc.ok
        t.fail += cc.fail
      }
    }
    const last = rec?.last[name]
    return {
      name, platform, path, runs: ok + fail, ok, fail,
      failRate: ok + fail ? Math.round((fail / (ok + fail)) * 1000) / 1000 : null,
      streak: last?.streak ?? 0, lastVerdict: last?.verdict ?? null, lastAt: last?.at ?? null, lastColo: last?.colo ?? null,
      verdicts, colos, perDay,
    }
  })
  return {
    updated: rec?.updated || null,
    ageMinutes: rec?.updated ? Math.round((now.getTime() - Date.parse(rec.updated)) / 60_000) : null,
    colo: rec?.colo ?? null,
    days,
    checks,
  }
}

/**
 * WHERE THIS SCHEDULED RUN IS EXECUTING. A scheduled invocation has no request, so no `request.cf.colo`;
 * Cloudflare's trace endpoint reports the location that served it, which for a subrequest is the one the
 * Worker runs in. Recorded because the 2026-10-14 reading suggested TikTok refuses the location the cron
 * runs from and not the readers' (a live run elsewhere passed), and only the colo can confirm or refute
 * that. Best effort: two seconds, and a miss records `null` rather than costing the run.
 */
export async function cronColo(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(2000) })
    const m = /^colo=([A-Z]{3})$/m.exec(await res.text())
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * Read, fold and write. Never throws.
 *
 * A READ THAT FAILS SKIPS THIS TICK; it never starts the week over. Writing after a failed read would
 * replace up to eight days and every streak with this one run, and for the hours until MIN_RUNS and
 * STREAK are reached again nothing could fire (review of PR #105, 2026-10-14). Only an absent object, or
 * one whose bytes are not JSON, starts a fresh week: the first is the first run ever, the second cannot
 * be recovered by waiting.
 */
export async function recordSmoke(bucket: R2Bucket, results: readonly SmokeResult[], at: Date, colo: string | null): Promise<void> {
  let prev: unknown = null
  try {
    const obj = await bucket.get(HEALTH_KEY)
    if (obj) {
      const text = await obj.text()
      try { prev = JSON.parse(text) } catch { prev = null }
    }
  } catch {
    return
  }
  try {
    await bucket.put(HEALTH_KEY, JSON.stringify(foldSmoke(prev, results, at, colo)), {
      httpMetadata: { contentType: 'application/json' },
    })
  } catch {
    // Nothing to do: the counters in Analytics Engine still have this run.
  }
}

/**
 * The stored record for `/_health`: `{ raw }` (null raw when no run has been recorded yet), or null when
 * the week COULD NOT BE READ. The two must not look alike: an unread week summarised as zeros reads as a
 * clean one, and the twice-weekly report would close every open check issue as passed.
 */
export async function readHealth(bucket: R2Bucket): Promise<{ raw: unknown } | null> {
  try {
    const obj = await bucket.get(HEALTH_KEY)
    return { raw: obj ? JSON.parse(await obj.text()) : null }
  } catch {
    return null
  }
}
