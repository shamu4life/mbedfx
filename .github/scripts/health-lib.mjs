/**
 * THE TWICE-WEEKLY HEALTH CHECK'S JUDGEMENT, kept pure so test/health-check.test.mjs can run it with no
 * network and no GitHub. health-check.mjs does the I/O and calls these; the workflow is
 * .github/workflows/health-check.yml.
 *
 * WHAT COUNTS AS BROKEN, and why the numbers are these:
 *   - A scheduled check that failed more than WEEK_FAIL_RATE of its runs over the last seven days, or the
 *     last STREAK runs in a row. Dailymotion is the floor this has to clear: its row fails about once a
 *     day by design (src/smoke.ts, the cold meta record), roughly 2%, and must never open an issue.
 *     Six in a row is three hours of the half-hourly check failing, long enough that a blip is ruled out.
 *   - The scheduled check itself stopping (no run recorded for STALE_MINUTES), which reads like health
 *     everywhere else because a stopped monitor reports nothing.
 *   - A failure that persisted across two live runs from GitHub's network, a minute apart, which also
 *     covers what the scheduled check cannot see from inside the Worker: DNS, routes, a failed deploy.
 *   - The video container not serving YouTube bytes (`/_clients`), which `/_smoke` cannot see either: it
 *     stayed green through a total container outage in August.
 *   - Either guest domain no longer showing its own site at `/`, or its `d.` name no longer answering a
 *     post with its file.
 *
 * EVERY ANSWER IS JUDGED ON WHAT IT SAYS, NEVER ON ITS STATUS. `/_clients` answers HTTP 200 with
 * `ok: false` when the container replies but serves nothing, and a 200 from `/_health` or `/_smoke`
 * that is not the expected report would otherwise read as "nothing failed".
 *
 * AND AN ISSUE IS CLOSED ONLY BY A RUN THAT CHECKED IT (`judged`). A problem being absent means it
 * passed only if it was looked for: when `/_health` does not answer, no scheduled check can fail, and
 * closing every open check issue on the day the site is down would be the worst possible all-clear.
 */

export const WEEK_FAIL_RATE = 0.2
export const MIN_RUNS = 10
export const STREAK = 6
export const STALE_MINUTES = 120
export const LABEL = 'health-check'
export const marker = key => `<!-- health-check:${key} -->`

/** Platform names as the owner says them: Twitter, not "X". */
const NAMES = {
  x: 'Twitter', tt: 'TikTok', ig: 'Instagram', yt: 'YouTube', th: 'Threads', bs: 'Bluesky', rd: 'Reddit',
  fb: 'Facebook', dm: 'Dailymotion', st: 'Streamable', tw: 'Twitch', ms: 'Mastodon', pt: 'PeerTube',
  mk: 'Misskey', im: 'Imgur', pn: 'Pinterest', lm: 'Lemmy',
}
export const platformName = p => NAMES[p] ?? p

const VERDICT_MEANING = {
  'failure-card': 'the card said it could not load the post',
  'no-card': 'no card came back at all',
  'no-video': 'a card came back without a player',
  timeout: 'the render did not finish in 20 s',
  threw: 'the render threw',
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a')

/**
 * A `/_health` answer that carries the week: the checks (src/health.ts lists every one, with zeros before
 * the first run, so an empty list is not a week) and the age of the record.
 */
export function readableWeek(health) {
  const h = health?.json
  return !!(health?.ok && h && Array.isArray(h.checks) && h.checks.length > 0 && 'ageMinutes' in h)
}

/**
 * The checks a `/_smoke` answer says failed, as name -> verdict, or null when the answer is not a smoke
 * report (src/worker.ts: `ok`, `checked`, `failed: [{ name, verdict }]`). A missing or renamed list
 * must not read as "nothing failed", and neither may a report that contradicts itself.
 */
export function smokeFailures(json) {
  if (!json || typeof json.checked !== 'number' || json.checked < 1 || !Array.isArray(json.failed)) return null
  if (json.ok !== (json.failed.length === 0)) return null
  const out = new Map()
  for (const f of json.failed) {
    if (!f || typeof f.name !== 'string' || !f.name) return null
    out.set(f.name, typeof f.verdict === 'string' ? f.verdict : 'unknown')
  }
  return out
}

/** `/_clients` answers 200 with `ok: false` when the container replies but serves nothing (src/worker.ts). */
export const containerServing = c => c?.json?.ok === true && Array.isArray(c.json.serving) && c.json.serving.length > 0

/** A guest domain shows the you-stupid site at `/`: a 200 HTML page that mbedfx did not mark as its own. */
const guestRootOk = g => g.root?.status === 200 && /text\/html/.test(g.root?.contentType ?? '') && !g.root?.marked
/** Its `d.` name answers a post with a marked 302 to its own `/_media/` file. */
const guestDOk = g => g.d?.status === 302 && !!g.d?.marked && (g.d?.location ?? '').startsWith(`https://d.${g.host}/_media/`)

/**
 * WHETHER THIS RUN CHECKED A PROBLEM, so that its issue may be closed when the problem is absent. `site`
 * and `clients` are asked every run. The week's problems need the week. A key this file no longer raises
 * is never closed by it.
 *
 * A CHECK'S ISSUE NEEDS EVIDENCE THAT IT PASSED, not an absence of failures: the live run (some issues
 * are opened by it alone), a week recorded within STALE_MINUTES, and at least MIN_RUNS runs of that check
 * in it. Zeros measured nothing. Without this, a week that was never written, one that stopped being
 * written, or a check renamed out of the list all closed their issues as "passed again" (review of PR
 * #105, 2026-10-14) — the false all-clear this file's header says cannot happen.
 */
export function judged(key, { health, live, guests } = {}) {
  if (key === 'site' || key === 'clients') return true
  if (key === 'cron') return readableWeek(health)
  if (key.startsWith('check:')) {
    if (!readableWeek(health) || !live?.ran) return false
    const h = health.json
    if (h.ageMinutes === null || h.ageMinutes > STALE_MINUTES) return false
    const row = h.checks.find(c => `check:${c.name}` === key)
    return !!row && row.runs >= MIN_RUNS
  }
  if (key.startsWith('guest:')) return (guests ?? []).some(g => key === `guest:${g.host}`)
  return false
}

function checkBody(c, liveVerdict, liveRan) {
  const lines = []
  lines.push(`**${platformName(c.platform)}** (check \`${c.name}\`, \`${c.path}\`)`)
  lines.push('')
  if (c.runs) {
    lines.push(`Failed **${c.fail} of ${c.runs}** scheduled runs in the last 7 days (${pct(c.fail, c.runs)}), and the last **${c.streak}** in a row.`)
  } else {
    lines.push('No scheduled run of this check was recorded in the last 7 days.')
  }
  if (c.lastVerdict && c.lastVerdict !== 'ok') {
    lines.push(`Last verdict \`${c.lastVerdict}\` (${VERDICT_MEANING[c.lastVerdict] ?? 'unknown'}) at ${c.lastAt}${c.lastColo ? `, from Cloudflare location \`${c.lastColo}\`` : ''}.`)
  }
  const colos = Object.entries(c.colos ?? {})
  if (colos.length) {
    lines.push(`By Cloudflare location this week: ${colos.map(([k, v]) => `\`${k}\` ${v.fail}/${v.ok + v.fail} failed`).join(', ')}.`)
  }
  lines.push('')
  lines.push('| Day (UTC) | Runs | Failed |')
  lines.push('|---|---|---|')
  for (const d of c.perDay ?? []) lines.push(`| ${d.day} | ${d.ok + d.fail} | ${d.fail} |`)
  lines.push('')
  if (!liveRan) {
    lines.push('The live check from GitHub\'s network did not run, so there is no second vantage point this time.')
  } else if (liveVerdict) {
    lines.push(`**From GitHub's network:** failed twice a minute apart (\`${liveVerdict}\`), so readers are likely affected too.`)
  } else {
    lines.push('**From GitHub\'s network:** passed. When the scheduled run fails and this passes, the break may be specific to where Cloudflare runs the scheduled check rather than what readers see; the locations above say where that was.')
  }
  return lines.join('\n')
}

/**
 * Every problem this run found, each with a stable `key` (one issue per key) and the issue text.
 * `live` is `{ ran, failed: Map(name -> verdict) }`: only checks that failed in BOTH live runs.
 */
export function evaluate({ health, live, clients, guests }) {
  const problems = []
  const liveFailed = live?.failed ?? new Map()

  if (!readableWeek(health)) {
    const liveToo = live && !live.ran ? ` \`/_smoke\` did not answer from GitHub's network either: ${live.error ?? 'no answer'}.` : ''
    const unread = `Without it this run could not judge the scheduled checks, so their open issues were left as they were.${liveToo}`
    problems.push({
      key: 'site', title: 'mbedfx.app did not answer the health check',
      body: health?.json
        ? `\`/_health\` answered HTTP ${health.status}, but not with the week's checks:\n\n\`\`\`json\n${JSON.stringify(health.json, null, 2).slice(0, 3000)}\n\`\`\`\n\n${unread}`
        : `\`/_health\` failed: ${health?.error ?? 'no answer'}. ${unread}`,
    })
  } else {
    const h = health.json
    if (h.ageMinutes === null || h.ageMinutes > STALE_MINUTES) {
      problems.push({
        key: 'cron', title: 'The half-hourly check has stopped running',
        body: h.updated
          ? `The last scheduled run was recorded at ${h.updated}, ${h.ageMinutes} minutes ago. It runs every 30 minutes (\`scheduled()\` in src/worker.ts), so it has stopped, or it can no longer write its record to R2.`
          : 'No scheduled run has ever been recorded. If this deploy is new, the first one lands within 30 minutes; otherwise the cron, or its write to R2, is not running.',
      })
    }
    for (const c of h.checks ?? []) {
      const weekBad = c.runs >= MIN_RUNS && c.failRate !== null && c.failRate > WEEK_FAIL_RATE
      const streakBad = c.streak >= STREAK
      const liveVerdict = liveFailed.get(c.name)
      if (weekBad || streakBad || liveVerdict) {
        problems.push({
          key: `check:${c.name}`,
          title: `${platformName(c.platform)} is failing (check ${c.name})`,
          body: checkBody(c, liveVerdict, !!live?.ran),
        })
      }
    }
  }

  // A live failure on a check /_health does not list (it cannot happen today, since both come from
  // SMOKE_CHECKS, but the two endpoints are separate code) still has to be reported somewhere.
  const known = new Set(problems.map(p => p.key))
  for (const [name, verdict] of liveFailed) {
    if (!known.has(`check:${name}`)) {
      problems.push({
        key: `check:${name}`, title: `Check ${name} is failing`,
        body: `Failed twice a minute apart from GitHub's network (\`${verdict}\`: ${VERDICT_MEANING[verdict] ?? 'unknown'}).`,
      })
    }
  }
  if (live && !live.ran && readableWeek(health)) {
    problems.push({
      key: 'site', title: 'mbedfx.app did not answer the health check',
      body: `\`/_smoke\` failed from GitHub's network: ${live.error ?? 'no answer'}. The week's record answered, so the Worker is up; this may be a timeout of the live run itself. The open check issues were left as they were, since some are opened by the live run alone.`,
    })
  }

  if (!containerServing(clients)) {
    problems.push({
      key: 'clients', title: 'The video container is not serving YouTube',
      body: `\`/_clients\` answered ${clients?.status ? `HTTP ${clients.status}` : 'nothing'}${clients?.error ? ` (${clients.error})` : ''}${clients?.json ? `:\n\n\`\`\`json\n${JSON.stringify(clients.json, null, 2).slice(0, 3000)}\n\`\`\`` : '.'}\n\nThis checks the container on production egress (container/server.py). \`/_smoke\` cannot see it: it stayed green through a total container outage in August.`,
    })
  }

  for (const g of guests ?? []) {
    const rootOk = guestRootOk(g)
    const dOk = guestDOk(g)
    if (!rootOk || !dOk) {
      problems.push({
        key: `guest:${g.host}`, title: `${g.host} is not working as an embed domain`,
        body: [
          `\`https://${g.host}/\` should be the you-stupid site (200, HTML, no \`x-mbedfx-guest\` mark): ${rootOk ? 'yes' : `got ${JSON.stringify(g.root)}`}.`,
          `\`https://d.${g.host}${g.path}\` should be a 302 to its own \`/_media/\` url, marked \`x-mbedfx-guest: served\`: ${dOk ? 'yes' : `got ${JSON.stringify(g.d)}`}.`,
          '',
          'These domains belong to shamu4life/you-stupid, which hands mbedfx its embed paths over a service binding (src/guesthost.ts). A break here is usually that Worker, its custom domains, or the binding.',
        ].join('\n'),
      })
    }
  }
  // One issue per key, the first wins: `site` can be raised twice above.
  const seen = new Set()
  return problems.filter(p => (seen.has(p.key) ? false : (seen.add(p.key), true)))
}

/** The issue text: the problem, where it came from, and the marker that ties later runs to it. */
export function issueBody(p, runUrl) {
  return `${marker(p.key)}\n${p.body}\n\n---\nFiled by the twice-weekly health check (\`.github/workflows/health-check.yml\`)${runUrl ? `, [this run](${runUrl})` : ''}. It comments here on every run while this stays broken and closes the issue when it passes again.`
}

/**
 * WHAT TO DO WITH THE OPEN ISSUES: comment on the one already open for a problem, open one for a new
 * problem, and close the ones whose problem has gone, if `isJudged(key)` says this run looked; the rest
 * are a `skip`, which writes nothing. With no judgement given nothing is closed, because closing is the
 * one action here that can tell the owner something false. An issue is matched by its marker, never by
 * its title, so editing a title by hand does not make the next run open a duplicate.
 */
export function planIssues(problems, openIssues, runUrl, isJudged = () => false) {
  const byKey = new Map()
  for (const i of openIssues ?? []) {
    const m = /<!-- health-check:([^ ]+) -->/.exec(i.body ?? '')
    if (m && !byKey.has(m[1])) byKey.set(m[1], i.number)
  }
  const actions = []
  for (const p of problems) {
    const body = issueBody(p, runUrl)
    if (byKey.has(p.key)) actions.push({ type: 'comment', number: byKey.get(p.key), body })
    else actions.push({ type: 'create', title: `[health-check] ${p.title}`, body })
  }
  const raised = new Set(problems.map(p => p.key))
  for (const [key, number] of byKey) {
    if (raised.has(key)) continue
    if (isJudged(key)) {
      actions.push({ type: 'resolve', number, body: `Passed again on this run${runUrl ? ` ([run](${runUrl}))` : ''}. Closing; the next failure opens a new issue.` })
    } else {
      actions.push({ type: 'skip', number, key })
    }
  }
  return actions
}

/** What each vantage point said, so a run page never leaves a reader guessing what was looked at. */
function lookedAt({ health, live, clients, guests }) {
  const h = health?.json
  const week = readableWeek(health)
    ? `read, last scheduled run ${h.ageMinutes ?? 'never'}${h.ageMinutes === null ? '' : ' min ago'}${h.colo ? ` from \`${h.colo}\`` : ''}`
    : `not readable (${health?.error ?? `HTTP ${health?.status}`})`
  const liveLine = !live ? 'not run'
    : !live.ran ? `did not run (${live.error ?? 'no answer'})`
      : live.failed.size ? `failed twice: ${[...live.failed.keys()].join(', ')}` : 'passed'
  const container = containerServing(clients)
    ? `serving ${clients.json.serving.join(', ')}`
    : `not serving (${clients?.error ?? `HTTP ${clients?.status}`})`
  const broken = (guests ?? []).filter(g => !guestRootOk(g) || !guestDOk(g))
  const guestLine = !guests?.length ? 'not checked'
    : broken.length ? `broken: ${broken.map(g => g.host).join(', ')}` : `${guests.length} of ${guests.length} answering`
  return [
    '', '**Looked at**', '',
    `- The scheduled check's week (\`/_health\`): ${week}`,
    `- \`/_smoke\` from GitHub's network: ${liveLine}`,
    `- The video container (\`/_clients\`): ${container}`,
    `- Guest domains: ${guestLine}`,
  ]
}

/** The run's own page: one line per problem or the all-clear, what was looked at, and the week's table. */
export function renderSummary(problems, inputs) {
  const { health } = inputs
  const out = ['## mbedfx health check', '']
  if (!problems.length) out.push('Everything passed.')
  for (const p of problems) out.push(`- **${p.title}** (\`${p.key}\`)`)
  out.push(...lookedAt(inputs))
  if (readableWeek(health)) {
    out.push('', '| Check | Runs (7 d) | Failed | Streak | Last |', '|---|---|---|---|---|')
    for (const c of health.json.checks ?? []) {
      out.push(`| ${platformName(c.platform)} \`${c.name}\` | ${c.runs} | ${pct(c.fail, c.runs)} | ${c.streak} | ${c.lastVerdict ?? '-'} |`)
    }
  }
  return out.join('\n')
}
