#!/usr/bin/env node
/**
 * The twice-weekly health check's I/O: read mbedfx's week (`/_health`), run the checks live from here,
 * test the container and the guest domains, then report. The judgement is health-lib.mjs, which the
 * test suite runs; this file only fetches and writes. Run by .github/workflows/health-check.yml.
 *
 *   node .github/scripts/health-check.mjs                 report only (the run's summary page)
 *   node .github/scripts/health-check.mjs --file-issues   also open, comment on and close issues
 *
 * It exits non-zero only when it could not do its job (a crash, or `gh` refusing). A broken PLATFORM is
 * an issue, not a red run: the issue is the notification, and a red run would send a second one.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, judged, planIssues, renderSummary, smokeFailures, LABEL } from './health-lib.mjs'

const BASE = (process.env.HEALTH_BASE || 'https://mbedfx.app').replace(/\/+$/, '')
const GUESTS = ['sorryifuckedyour.mom', 'hotsinglesnear.you']
// An image post from src/smoke.ts's list, verified answering a marked 302 on both d. names (2026-10-14).
const GUEST_POST = '/r/pics/comments/haucpf'
const CRAWLER = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getJson(url, ms) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON: reported below */ }
    if (!json) return { ok: false, status: res.status, error: `HTTP ${res.status}, not JSON` }
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    return { ok: false, status: null, error: String(e?.message ?? e) }
  }
}

async function probe(url, ua) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': ua } })
    await res.arrayBuffer().catch(() => {})
    return {
      status: res.status, location: res.headers.get('location'),
      marked: res.headers.get('x-mbedfx-guest') === 'served', contentType: res.headers.get('content-type'),
    }
  } catch (e) {
    return { status: null, error: String(e?.message ?? e) }
  }
}

/** Two live runs a minute apart; only a check that failed in both counts, so one blip opens nothing. */
async function liveRuns() {
  const notRun = r => ({ ran: false, error: r.error ?? `HTTP ${r.status}, not a smoke report`, failed: new Map() })
  const first = await getJson(`${BASE}/_smoke`, 150_000)
  const once = smokeFailures(first.json)
  if (!once) return notRun(first)
  if (!once.size) return { ran: true, failed: new Map() }
  await sleep(60_000)
  const second = await getJson(`${BASE}/_smoke`, 150_000)
  const twice = smokeFailures(second.json)
  if (!twice) return notRun(second)
  const failed = new Map()
  for (const [name, verdict] of twice) if (once.has(name)) failed.set(name, verdict)
  return { ran: true, failed }
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

const health = await getJson(`${BASE}/_health`, 30_000)
const live = await liveRuns()
const clients = await getJson(`${BASE}/_clients`, 240_000)
const guests = []
for (const host of GUESTS) {
  guests.push({
    host, path: GUEST_POST,
    root: await probe(`https://${host}/`, BROWSER),
    d: await probe(`https://d.${host}${GUEST_POST}`, CRAWLER),
  })
}

const problems = evaluate({ health, live, clients, guests })
const summary = renderSummary(problems, { health, live, clients, guests })
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)

if (process.argv.includes('--file-issues')) {
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null
  // Idempotent: --force updates the label if it already exists.
  gh(['label', 'create', LABEL, '--force', '--color', 'B60205', '--description', 'Opened by the twice-weekly health check'])
  const open = JSON.parse(gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title,body']))
  const file = join(tmpdir(), 'health-issue.md')
  const skipped = []
  for (const a of planIssues(problems, open, runUrl, key => judged(key, { health, live, guests }))) {
    if (a.type === 'skip') {
      skipped.push(`#${a.number} (\`${a.key}\`)`)
      console.log(`skip ${a.number}: not checked this run, left open`)
      continue
    }
    writeFileSync(file, a.body)
    if (a.type === 'create') gh(['issue', 'create', '--title', a.title, '--label', LABEL, '--body-file', file])
    else if (a.type === 'comment') gh(['issue', 'comment', String(a.number), '--body-file', file])
    else {
      gh(['issue', 'comment', String(a.number), '--body-file', file])
      gh(['issue', 'close', String(a.number), '--reason', 'completed'])
    }
    console.log(`${a.type} ${a.number ?? a.title}`)
  }
  if (skipped.length && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nLeft open because this run could not check them: ${skipped.join(', ')}.\n`)
  }
}
