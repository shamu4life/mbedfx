import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fetchableInstance } from '../src/platforms/fedihost.ts'

/** The zones this project owns and serves. Both are live; see wrangler.jsonc's routes comment. */
const OUR_ZONES = ['mbedfx.app', 'megapenispoopenfarten.sex']

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
  // TWO ZONES since the 2026-07-30 rename. mbedfx.app is the project's domain; the original zone is
  // RETAINED rather than cut over, because a link already pasted into Discord resolves only while its
  // host does. Everything the original single-zone test protected is preserved, per zone.
  for (const p of patterns) {
    assert.ok(!p.includes('*'), 'never a wildcard — that would swallow the whole zone')
    const host = p.split('/')[0]
    assert.ok(
      OUR_ZONES.some(z => host === z || host.endsWith(`.${z}`)),
      `route must be on a zone we own, got ${host}`,
    )
    assert.equal(p, host, 'a route must be a bare hostname, with no path')
  }
  // The cutover itself, pinned so an accidental revert is loud: the apex is ours, as a custom
  // domain (not a path route), and staging still exists alongside it for pre-prod verification.
  for (const zone of OUR_ZONES) {
    const apex = (cfg.routes ?? []).find(r => r.pattern === zone)
    assert.ok(apex, `the apex is claimed for ${zone}`)
    assert.equal(apex.custom_domain, true, `${zone} apex is a custom domain — the mechanism the rollback note assumes`)
    assert.ok(
      patterns.includes(`staging.${zone}`),
      `staging.${zone} survives — it is where changes are verified before the apex sees them`,
    )
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
