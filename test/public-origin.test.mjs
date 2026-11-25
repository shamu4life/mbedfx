import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CRON_FALLBACK_ORIGIN, cronOrigin, smokeWhereReadersAre } from '../src/worker.ts'
import { SMOKE_CHECKS } from '../src/smoke.ts'
import { parseOrigins } from '../adapters/node/server.ts'

/**
 * PUBLIC_ORIGIN ON THE WORKER (self-hosting phase 4, 2026-11-25): the origin of the one thing that runs
 * without a request, the half-hourly check.
 *
 * Until then scheduledSmoke rendered every check on the constant 'https://mbedfx.app', on every
 * deployment, so a fork's check claimed to be the public instance. It now renders on the first usable
 * PUBLIC_ORIGIN entry, and on CRON_FALLBACK_ORIGIN when there is none. The guard's half of the var (every
 * host listed is refused) is pinned in test/selfhost.test.mjs, and production's value in
 * test/wrangler-configs.test.mjs.
 *
 * The origin a render ran on reaches fetchPost as its last argument (getPost's `origin`, which the four
 * fediverse fetchers use as `self`), so the stub below records it. Nothing here touches the network.
 */

const PROD_VARS = JSON.parse(readFileSync('wrangler.production.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')).vars

test('the fallback names no deployment: http://localhost, the Node adapter\'s own default without its port', () => {
  /**
   * Not mbedfx.app, which is somebody else's instance on every fork, and not a guess at the Worker's own
   * hostname, which it cannot know without a request. src/worker.ts CRON_FALLBACK_ORIGIN has the argument.
   */
  assert.equal(CRON_FALLBACK_ORIGIN, 'http://localhost')
  for (const PUBLIC_ORIGIN of [undefined, '', '   ', ',']) {
    assert.equal(cronOrigin({ PUBLIC_ORIGIN }), CRON_FALLBACK_ORIGIN, JSON.stringify(PUBLIC_ORIGIN))
  }
})

test('cronOrigin is the FIRST entry that is a bare http(s) origin; anything else is skipped, never thrown', () => {
  /**
   * The same rule the Node adapter's parseOrigins enforces (scheme http or https, no path, query or
   * fragment), but total: this runs inside the scheduled handler, where a throw is a tick with no record.
   * Skipping rather than stopping means a typo in the first entry falls through to the next real one
   * instead of to localhost.
   */
  const cases = [
    ['https://embed.example.com', 'https://embed.example.com'],
    ['https://embed.example.com/', 'https://embed.example.com'],
    ['https://Embed.Example.COM:8443', 'https://embed.example.com:8443'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['https://a.example,https://b.example', 'https://a.example'],
    ['  https://a.example \n https://d.a.example ', 'https://a.example'],
    ['embed.example.com https://b.example', 'https://b.example'],
    ['https://a.example/path https://b.example', 'https://b.example'],
    ['https://a.example/?q=1 https://a.example/#x https://b.example', 'https://b.example'],
    ['https://user:pw@a.example https://b.example', 'https://b.example'],
    ['ftp://a.example mailto:x@a.example https://b.example', 'https://b.example'],
    ['https:// not-a-url https://b.example', 'https://b.example'],
    ['embed.example.com', CRON_FALLBACK_ORIGIN],
    ['https://a.example/path', CRON_FALLBACK_ORIGIN],
  ]
  for (const [PUBLIC_ORIGIN, want] of cases) {
    assert.equal(cronOrigin({ PUBLIC_ORIGIN }), want, JSON.stringify(PUBLIC_ORIGIN))
  }
})

test('on any value the Node adapter accepts, cronOrigin picks the adapter\'s own primary', () => {
  /**
   * Two parsers of one var, one on each runtime. They need not agree on junk (the adapter refuses to
   * start, the Worker skips it), but on every value the adapter accepts they must name the same primary,
   * or one variable would put the check on different origins depending on where it runs.
   */
  for (const spec of [
    'https://embed.example.com', 'https://embed.example.com/', 'https://embed.example.com https://d.embed.example.com',
    'http://localhost:8787', 'https://A.example:8443,https://b.example', PROD_VARS.PUBLIC_ORIGIN,
  ]) {
    assert.equal(cronOrigin({ PUBLIC_ORIGIN: spec }), parseOrigins(spec)[0], spec)
  }
})

/** Runs one scheduled check in place (no SMOKE_RUNNER binding), and returns every origin it rendered on. */
async function originsOfOneRun(vars) {
  const seen = new Set()
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const u = String(typeof input === 'string' ? input : input.url)
    asked.push(u)
    return u.endsWith('/cdn-cgi/trace') ? new Response('colo=IAD\n') : new Response('gone', { status: 404 })
  }
  try {
    const deps = {
      cache: { async match() {}, async put() {} },
      fetchPost: async (ref, env, client, report, ctx, budget, self) => { seen.add(self); return null },
      fetchProfile: async () => null,
      resolveShortlink: async () => ({ kind: 'unresolved' }), resolveRedditShare: async () => null,
      resolveMetaShare: async () => null,
    }
    const ran = await smokeWhereReadersAre({ AE: { writeDataPoint() {} }, ...vars }, { waitUntil() {} }, () => deps)
    assert.deepEqual(ran.results.map(r => r.name), SMOKE_CHECKS.map(c => c.name), 'every check ran')
  } finally {
    globalThis.fetch = realFetch
  }
  return { origins: [...seen], asked }
}

test('THE CRON RENDERS ON THE PRIMARY PUBLIC_ORIGIN, and with none set on the fallback, never on mbedfx.app', async () => {
  const unset = await originsOfOneRun({})
  assert.deepEqual(unset.origins, [CRON_FALLBACK_ORIGIN], 'unset: the fallback, on every render')
  const set = await originsOfOneRun({ PUBLIC_ORIGIN: 'https://embed.example.com https://d.embed.example.com' })
  assert.deepEqual(set.origins, ['https://embed.example.com'], 'set: the primary, never the d. entry')
  for (const { asked } of [unset, set]) {
    // The check renders through handle() in this process. Nothing fetches the origin it renders on.
    assert.ok(!asked.some(u => /^https?:\/\/(localhost|embed\.example\.com|d\.embed\.example\.com)[:/]/.test(u)),
      `nothing may be fetched from the origin: ${JSON.stringify(asked)}`)
  }
})

test('PRODUCTION IS UNCHANGED: with wrangler.production.jsonc\'s vars the cron renders on https://mbedfx.app, as the constant did', async () => {
  const prod = await originsOfOneRun(PROD_VARS)
  assert.deepEqual(prod.origins, ['https://mbedfx.app'])
})
