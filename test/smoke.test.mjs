import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fetchableInstance } from '../src/platforms/fedihost.ts'

/**
 * The zones this project owns and serves. All three are live; see wrangler.jsonc's routes comment.
 *
 * DELIBERATELY NOT DERIVED FROM wrangler.jsonc, even though the SSRF test below reads that file. The
 * check this feeds — "a route is on a zone we own" — becomes vacuous the moment the list of zones we
 * own is read out of the list of routes. Keeping it a separate declaration is the whole mechanism: a
 * route added without a human deciding it belongs here fails, loudly, in a test named for the rule.
 */
const OUR_ZONES = ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex']

test('the only runtime dependency is the container helper, isolated from the fetch path', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  // The 6-platform fetch path stays zero-dep. The ONE runtime dependency is @cloudflare/containers,
  // which the media-resolver Durable Object cannot be written without (its Container base owns the
  // container lifecycle). It is confined to src/container.ts and reached only through the deploy entry
  // src/index.ts — never src/worker.ts, whose whole test suite runs under plain `node --test`.
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@cloudflare/containers'], 'exactly one runtime dep')
  // workers-types is types-only (erased at build); it is not a runtime dep.
  assert.deepEqual(
    Object.keys(pkg.devDependencies).sort(),
    ['@cloudflare/workers-types', 'typescript', 'wrangler'],
  )
  // Enforce the isolation: if worker.ts (or anything the tests import) pulled in the container helper,
  // `node --test` would try to load `cloudflare:workers` and die. Only src/container.ts may import it.
  assert.ok(!readFileSync('src/worker.ts', 'utf8').includes('@cloudflare/containers'),
    'worker.ts must not import the container helper')
})

test('worker name matches repo name', () => {
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  // MUST MATCH THE LIVE SERVICE. Cloudflare CAN rename a Worker in place (done 2026-07-30, same
  // service tag), and a mismatch here forks a second empty service that claims the routes.
  assert.equal(cfg.name, 'mbedfx')
})

test('routes are bare hostnames on our own zone — apex claimed, wildcard never', () => {
  /**
   * REVERSED 2026-07-25, DELIBERATELY. This test used to assert the opposite — that the apex was
   * NOT claimed — because the apex served the live fxtiktok worker and taking it was a pending
   * Phase 3 step. That cutover has now happened (see wrangler.jsonc's routes comment), so the old
   * assertion was guarding a state we intentionally left. What survives is everything the old test
   * was ACTUALLY protecting, which was never "the apex specifically":
   *
   *   - NO WILDCARDS. `*.megapenispoopenfarten.sex/*` would swallow every subdomain on the zone,
   *     including hostnames belonging to other workers and any future one nobody has thought of.
   *     Claiming the apex is a decision; claiming everything is an accident.
   *   - NO PATH COMPONENTS. PROVEN GAP, kept verbatim from the original: three earlier
   *     equality/prefix checks all passed 'megapenispoopenfarten.sex/profile' — the natural shape
   *     of an incremental "just point one path at fxeverything" edit. A path-scoped route is a
   *     different precedence mechanism from a custom domain, so it should be a deliberate edit
   *     here rather than something that slips in.
   *   - OUR ZONE ONLY. A route on a domain this project does not own is always a mistake.
   */
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const patterns = (cfg.routes ?? []).map(r => r.pattern)
  assert.ok(patterns.length > 0, 'the worker must claim at least one hostname')
  // THREE ZONES. mbedfx.app is the project's domain; megapenispoopenfarten.sex is the original, kept
  // rather than cut over because a link already pasted into Discord resolves only while its host does;
  // forsen.sex was added 2026-08-03. Everything the original single-zone test protected holds per zone.
  for (const p of patterns) {
    assert.ok(!p.includes('*'), 'never a wildcard — that would swallow the whole zone')
    const host = p.split('/')[0]
    assert.ok(
      OUR_ZONES.some(z => host === z || host.endsWith(`.${z}`)),
      `route must be on a zone we own, got ${host}`,
    )
    assert.equal(p, host, 'a route must be a bare hostname, with no path')
  }
  // The cutover itself, pinned so an accidental revert is loud: the apex is ours, as a custom domain
  // rather than a path route.
  for (const zone of OUR_ZONES) {
    const apex = (cfg.routes ?? []).find(r => r.pattern === zone)
    assert.ok(apex, `the apex is claimed for ${zone}`)
    assert.equal(apex.custom_domain, true, `${zone} apex is a custom domain — the mechanism the rollback note assumes`)
  }

  /**
   * STAGING IS GONE, and this asserts its absence rather than merely stopping asserting its presence.
   * It used to require staging.<zone> to survive "because it is where changes are verified before the
   * apex sees them". That role moved to Workers Builds previews, which give every branch its own
   * *-mbedfx.<account>.workers.dev url and cost no DNS record, no route and no second certificate.
   *
   * Asserted as an absence because a custom domain is exactly the kind of thing that gets added back
   * by a hand edit in the dashboard and then re-serialised into this file, and nothing else would
   * notice: it would simply start serving again, quietly, on a hostname nobody is testing.
   */
  for (const p of patterns) {
    assert.ok(!p.startsWith('staging.'), `staging.* is retired, found ${p}`)
  }
})

test('THE MUX CEILING IS ONE NUMBER IN TWO FILES — the worker must not refuse what the container allows', () => {
  /**
   * MUX_MAX_SECONDS in src/worker.ts is a COPY of MAX_SECONDS in container/server.py, duplicated
   * because the container is reached over a binding rather than imported: there is no build step that
   * could share a constant. Nothing but this test makes them agree.
   *
   * THE COST OF DISAGREEING IS ASYMMETRIC, which is why "they are close enough" is not good enough:
   *   - worker LOWER than container: a video that would mux perfectly is refused a mux it never
   *     attempts, and degrades to a still forever. Silent, and it looks exactly like a slow mux.
   *   - worker HIGHER than container: the pre-2026-08-03 behaviour returns, where a full response
   *     deadline is spent dispatching a mux the container's own match filter was always going to
   *     refuse — 5.2s on the HTML seam and 9.1s on the activity seam, measured, on EVERY view.
   *
   * The existing argv test next door pins the SHAPE of the match filter (`duration<?{MAX_SECONDS}`)
   * and deliberately not its value, so it cannot catch this. Raising the ceiling means editing two
   * files, and this is what says so at the moment it is forgotten.
   */
  const py = readFileSync('container/server.py', 'utf8')
  const ts = readFileSync('src/worker.ts', 'utf8')
  const pyMax = py.match(/MAX_SECONDS = int\(os\.environ\.get\("MAX_SECONDS", "(\d+)"\)\)/)
  const tsMax = ts.match(/const MUX_MAX_SECONDS = (\d+)/)
  assert.ok(pyMax, 'container/server.py declares a MAX_SECONDS default')
  assert.ok(tsMax, 'src/worker.ts declares MUX_MAX_SECONDS')
  assert.equal(tsMax[1], pyMax[1],
    `the worker's ceiling (${tsMax?.[1]}s) must equal the container's (${pyMax?.[1]}s)`)

  /**
   * AND THE BYTE CEILING MOVES WITH IT. The mux is `-c copy`, so output size is the SOURCE bitrate
   * times the duration: raising MAX_SECONDS without raising MAX_BYTES just moves the refusal from the
   * duration filter to the size filter, for exactly the videos the change was meant to admit, and the
   * symptom is identical. Pinned as a RATIO rather than a value so the pair can be raised together
   * without editing this number too.
   */
  const pyBytes = py.match(/MAX_BYTES = int\(os\.environ\.get\("MAX_BYTES", "(\d+)"\)\)/)
  assert.ok(pyBytes, 'container/server.py declares a MAX_BYTES default')
  const bytesPerSec = Number(pyBytes[1]) / Number(pyMax[1])
  assert.ok(bytesPerSec > 200_000,
    `the byte ceiling must allow a real bitrate across the whole duration, got ${Math.round(bytesPerSec)} B/s`)
})

test('THE CONVERTER PAGE KNOWS EVERY DOMAIN THE WORKER SERVES — routes vs OWN_HOSTS', () => {
  /**
   * A THIRD PLACE THE DOMAIN LIST LIVES, and the one with the quietest failure.
   *
   * public/index.html keeps its own OWN_HOSTS, because the page must answer two questions the worker
   * cannot answer for it: which domain to hand out by default (the one you arrived on), and whether a
   * pasted link is already ours. A domain in wrangler.jsonc but not in that list does not break — it
   * serves the page perfectly, then hands out links on a DIFFERENT domain, and tells anyone who pastes
   * one of its own links back in that the site is unsupported.
   *
   * That is invisible from the worker side and invisible in the tests that read wrangler.jsonc, which
   * is why it gets its own assertion rather than a comment asking the next person to remember.
   */
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const served = (cfg.routes ?? []).map(r => r.pattern.split('/')[0]).sort()
  const page = readFileSync('public/index.html', 'utf8')
  const m = page.match(/var OWN_HOSTS = \[([^\]]*)\]/)
  assert.ok(m, 'the page declares OWN_HOSTS')
  const listed = m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort()
  assert.deepEqual(listed, served, 'the page must list exactly the domains wrangler.jsonc serves')

  // And each one needs a toggle button, or arriving there leaves the pressed state lying about which
  // domain is in the box. Hidden is fine — unadvertised is not the same as absent.
  for (const host of served) {
    assert.ok(page.includes(`data-host="${host}"`), `${host} has a domain button`)
  }
})

test('EVERY SERVING ZONE IS REFUSED BY THE SSRF GUARD — the coupling wrangler.jsonc claims', () => {
  /**
   * THE HOLE THIS CLOSES. A fediverse ref NAMES ITS OWN ORIGIN, so `/{our-own-host}/post/1` would
   * induce the Worker to fetch itself back through the edge — where Cloudflare's default subrequest
   * behaviour bypasses the zone's own WAF. fedihost.ts's clause 2 exists to refuse exactly that, and
   * it can only refuse hosts it has been told about.
   *
   * Adding a route to wrangler.jsonc while forgetting OWN_HOSTS is therefore a SILENT SSRF hole: the
   * new domain serves normally and nothing fails, so nothing catches it. wrangler.jsonc's routes
   * comment asserts the two lists are coupled; before this test, nothing made that true. The
   * 2026-07-30 rename is exactly the kind of change that would have opened it.
   *
   * Asserted through fetchableInstance rather than by reading the constant, so it pins the BEHAVIOUR
   * (including the subdomain rule) rather than the spelling of a private array.
   */
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  for (const { pattern } of cfg.routes ?? []) {
    const host = pattern.split('/')[0]
    assert.equal(fetchableInstance(host), false, `${host} serves this Worker and must never be fetchable`)
    assert.equal(fetchableInstance(`sub.${host}`), false, 'and neither may a subdomain of it')
  }
  // The guard must still admit ordinary instances, or it would refuse the whole fediverse.
  assert.equal(fetchableInstance('lemmy.world'), true)
  assert.equal(fetchableInstance('mstdn.social'), true)
})

test('.node-version pins a Node new enough to IMPORT the .ts sources directly', () => {
  /**
   * THE WHOLE SUITE IMPORTS TYPESCRIPT. Every test here does `import { … } from '../src/*.ts'`, which
   * works only because modern Node strips types natively — there is no build step and no loader.
   * That silently makes the Node VERSION a hard dependency of the test suite, and nothing declared it
   * until Cloudflare's builder proved it the expensive way.
   *
   * MEASURED 2026-07-26: Workers Builds runs Node 22.16.0, where type stripping is still behind a
   * flag. 22 of 30 test FILES died at
   *     ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"
   * so the build command failed and the auto-deploy never shipped anything — while the same suite was
   * green locally on Node 26 and green in GitHub Actions (whose `node-version: 22` resolves to the
   * LATEST 22.x, which is new enough). Two green CIs and a broken deploy, from one unpinned tool.
   *
   * Unflagged `.ts` import landed in 22.18.0, so that is the floor. The pin also removes the drift
   * that hid this: local, GitHub Actions and Cloudflare now agree on one version.
   */
  const pinned = readFileSync('.node-version', 'utf8').trim()
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'pin an exact version — "22" resolves differently per tool')
  const [maj, min] = pinned.split('.').map(Number)
  assert.ok(
    maj > 22 || (maj === 22 && min >= 18),
    `Node ${pinned} cannot import .ts unflagged; 22.18.0 is the floor`,
  )
})

test('all allowlisted site assets exist', () => {
  // not_found_handling: "none" makes a missing file a hard 404, not a fallback.
  for (const f of ['public/index.html', 'public/robots.txt', 'public/favicon.ico']) {
    assert.ok(existsSync(f), `${f} must exist`)
  }
})

test('robots.txt disallows everything', () => {
  const r = readFileSync('public/robots.txt', 'utf8')
  assert.match(r, /User-agent:\s*\*/i)
  assert.match(r, /Disallow:\s*\//)
})
