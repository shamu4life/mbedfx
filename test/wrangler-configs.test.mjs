import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { guestHosts } from '../src/guesthost.ts'
import { cronOrigin } from '../src/worker.ts'

/**
 * THE THREE WRANGLER CONFIGS (self-hosting phase 3, 2026-11-25).
 *
 *   wrangler.production.jsonc  the public instance. Workers Builds deploys it with `-c` on main and
 *                              builds a Worker Preview from it with `-c` on other branches (`npx
 *                              wrangler preview`, since 2026-11-25). Its own facts (name, domains,
 *                              pinned container application, vars) are pinned by the smoke, guesthost,
 *                              openapi and yt-promise-off tests, which read it and nothing else.
 *   wrangler.jsonc             the generic config: `npx wrangler deploy` from a checkout, `npm run
 *                              deploy`, and the Deploy to Cloudflare button.
 *   wrangler.free.jsonc        the generic config without the container, for Workers Free. Untested on
 *                              that plan.
 *
 * Until phase 3 the root file WAS production's, and a byte-equality test held the two together while
 * Workers Builds might still be deploying the root. The main build log showed the `-c` deploy command
 * on 2026-11-25, so the root is free to differ and that test is gone.
 *
 * WHAT THESE TESTS GUARD is the one way the split can hurt production: a generic file that names
 * something of production's. Deployed into the owner's account (by `npm run deploy`, by a test, by the
 * button), a generic file carrying production's Worker name replaces the public instance's code; one
 * carrying its bucket shares its cache; one carrying its dataset writes into its counters; one carrying
 * its container application name collides with the application the MediaResolver class is attached to.
 * The names are read out of the production file rather than listed here, so renaming a production
 * resource cannot leave this test checking for the old name.
 *
 * WHAT THEY DO NOT PIN: the generic file's own name, bucket, dataset or sizing. A self-hoster edits
 * those, and their `npm run build` runs this file.
 */

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const raw = file => readFileSync(file, 'utf8')

const PROD_FILE = 'wrangler.production.jsonc'
const prod = read(PROD_FILE)
const GENERIC = ['wrangler.jsonc', 'wrangler.free.jsonc']
// Production's guest hosts, from its own GUEST_HOSTS var (a constant in src/guesthost.ts until 2026-11-25).
const GUEST_HOSTS = guestHosts(prod.vars?.GUEST_HOSTS)

// Production's zones, from its routes (`mbedfx.app/*` and `mbedfx.app` both reduce to the host).
const prodZones = (prod.routes ?? []).map(r => (typeof r === 'string' ? r : r.pattern).split('/')[0].replace(/^\*\.?/, ''))
// Production's resource names. Every one is a distinctive string, so the scan below can search for it
// in the raw text, comments included. The Worker name is not ("mbedfx" is in every file name here), so
// it is compared by value.
// Production's Preview bucket and dataset count too. They live in the owner's account as well, so a
// generic file deployed there must not name them either.
const prodResources = [
  ...(prod.r2_buckets ?? []).map(b => b.bucket_name),
  ...(prod.analytics_engine_datasets ?? []).map(d => d.dataset),
  ...(prod.containers ?? []).map(c => c.name).filter(Boolean),
  ...(prod.previews?.r2_buckets ?? []).map(b => b.bucket_name),
  ...(prod.previews?.analytics_engine_datasets ?? []).map(d => d.dataset),
]
// The DO classes production's migrations create, in order. A fresh account replays every tag.
const doClasses = cfg => (cfg.migrations ?? []).flatMap(m => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])])

test('the production file still names what the scans below search for', () => {
  /**
   * The scans are only as good as the names they search for. If the production file lost its routes
   * or its resource blocks (a bad merge, a parse that silently returned less), every scan would pass
   * against an empty list.
   */
  assert.ok(prodZones.length > 0, 'production must route at least one zone')
  assert.ok(prodResources.length >= 3, 'bucket, dataset and the pinned container application')
  assert.ok(prod.name, 'production must have a Worker name')
  assert.ok(GUEST_HOSTS.length > 0)
})

for (const file of GENERIC) {
  test(`${file} names no production zone, guest host or production resource anywhere, comments included`, () => {
    /**
     * A zone in a generic file is a deploy that tries to take a domain off the public instance (or,
     * for a guest host, off the owner's other Worker). A resource name is a deploy into the owner's
     * account that shares production's bucket, writes into its counters, or fights over its container
     * application. Comments are scanned too: a comment naming production's bucket in a lifecycle
     * command is copied and run against production's bucket.
     */
    const text = raw(file).toLowerCase()
    for (const name of [...prodZones, ...GUEST_HOSTS, ...prodResources]) {
      assert.ok(!text.includes(name.toLowerCase()), `${file} mentions ${name}, which belongs to ${PROD_FILE}`)
    }
  })

  test(`${file} deploys under a Worker name other than production's`, () => {
    /**
     * `wrangler deploy` updates the Worker it names. Under production's name, a deploy of the generic
     * file from a checkout logged into the owner's account would replace the public instance's code
     * and turn on workers.dev there. Under any other name it makes a separate Worker.
     */
    const cfg = read(file)
    assert.ok(cfg.name, `${file} needs a name, or the container application has nothing to derive from`)
    assert.notEqual(cfg.name.toLowerCase(), prod.name.toLowerCase())
  })

  test(`${file} keeps production's Durable Object classes and migrations, tag for tag`, () => {
    /**
     * A fresh account applies every migration tag in order. A generic file missing a tag, or carrying
     * one production never had, deploys a class list the code was not written for: a binding to a
     * class no migration created fails the deploy, and an account that applied a tag the other files
     * lack cannot be brought back in line by editing it. A new class goes into all three files at once.
     */
    const cfg = read(file)
    assert.deepEqual(cfg.migrations, prod.migrations)
    assert.deepEqual(doClasses(cfg), doClasses(prod))
  })

  test(`${file} keeps Workers Logs off`, () => {
    /**
     * Workers Logs store each request's whole url, and here the url is the post somebody pasted. An
     * absent block is not off (new Workers default to on), so the key must say false.
     */
    assert.deepEqual(read(file).observability, { enabled: false })
  })
}

test('the production file keeps Workers Logs off', () => {
  assert.deepEqual(prod.observability, { enabled: false })
})

test('wrangler.jsonc binds the same Durable Objects as production', () => {
  /**
   * The code reads three bindings by name (MEDIA_RESOLVER, MUX_RUNNER, SMOKE_RUNNER). A generic file
   * that drops one deploys fine and quietly loses the container, the 15-minute mux alarm or the
   * scheduled check's location.
   */
  assert.deepEqual(read('wrangler.jsonc').durable_objects, prod.durable_objects)
})

test('wrangler.jsonc has no routes and serves on workers.dev', () => {
  /**
   * A route in the generic file is a domain the deploying account must own, so a fresh account's
   * deploy fails or claims somebody else's zone. With none, the Worker answers on
   * <name>.<subdomain>.workers.dev, and that only if workers_dev is true.
   *
   * A self-hoster's own domain goes in the dashboard as a custom domain, not here: wrangler publishes
   * routes and custom domains only when the file lists some, so with no `routes` key a dashboard
   * domain survives every deploy.
   */
  const cfg = read('wrangler.jsonc')
  assert.equal(cfg.routes, undefined)
  assert.equal(cfg.route, undefined)
  assert.equal(cfg.workers_dev, true)
})

test('wrangler.jsonc leaves the container application unnamed, so its name follows the Worker name', () => {
  /**
   * The production file pins its application's name because its MediaResolver class is attached to an
   * application created under an older Worker name, and a Durable Object class can own exactly one.
   * Copied into the generic file, that pin names production's application from any account. Without
   * `name`, wrangler derives `<worker name>-<class name>`, lowercased (validateContainerApp in
   * wrangler 4.167), and the check below holds that derived name apart from production's too.
   */
  const cfg = read('wrangler.jsonc')
  assert.ok((cfg.containers ?? []).length > 0, 'the generic config runs the container')
  for (const c of cfg.containers) {
    assert.equal(c.name, undefined, 'containers[].name pins an application; leave it to wrangler')
    const derived = `${cfg.name}-${c.class_name}`.toLowerCase().replace(/ /g, '-')
    assert.ok(!prodResources.includes(derived), `${derived} is production's application`)
    assert.notEqual(derived, `${prod.name}-${c.class_name}`.toLowerCase())
  }
})

test('wrangler.free.jsonc has no container and no MEDIA_RESOLVER binding, and keeps the other two', () => {
  /**
   * Workers Free has no Containers, so a `containers` block fails the deploy there, and a
   * MEDIA_RESOLVER binding would point at a class whose Container base throws on construction without
   * one. The code checks for the binding before every container call; unbound, remux videos render
   * their cover still (test/pipeline.test.mjs covers YouTube and Facebook). The other two objects need
   * no container and stay.
   */
  const cfg = read('wrangler.free.jsonc')
  assert.equal(cfg.containers, undefined)
  const bound = cfg.durable_objects.bindings
  assert.ok(!bound.some(b => b.name === 'MEDIA_RESOLVER'))
  assert.deepEqual(bound, prod.durable_objects.bindings.filter(b => b.name !== 'MEDIA_RESOLVER'))
})

/**
 * THE GENERIC FILES' PREVIEWS BLOCKS (2026-11-25). Workers Builds on a new Worker, which is what the
 * Deploy to Cloudflare button makes, runs `npx wrangler preview` for every branch other than main. That
 * reads the root file, and wrangler stops with an error when the file has no `previews` block. A Preview
 * gets only what the block lists, so a Durable Object binding it leaves out does not exist there, and
 * code that reaches for it can fail with a 1101.
 *
 * No test here requires or forbids an R2 bucket in a generic Preview. The blocks leave MEDIA_CACHE out
 * so that a Preview needs no setup (wrangler.jsonc says what that costs), and a self-hoster who creates
 * a Preview bucket may add one. The test checks only that such a bucket is not the one the Worker
 * itself serves from. The scan above keeps out production's resources, its Preview ones included.
 */
for (const file of GENERIC) {
  test(`${file} has a previews block that keeps the Worker's own bindings and keeps off its data`, () => {
    const cfg = read(file)
    const pv = cfg.previews
    assert.ok(pv, 'wrangler preview refuses to run without a previews block')
    // Branch traffic stays out of the Worker's own counters, and a branch's mux or record out of the
    // cache the Worker serves.
    const ownDatasets = (cfg.analytics_engine_datasets ?? []).map(d => d.dataset)
    for (const d of pv.analytics_engine_datasets ?? []) {
      assert.ok(!ownDatasets.includes(d.dataset), `${file}: preview dataset ${d.dataset} is the Worker's own`)
    }
    const ownBuckets = (cfg.r2_buckets ?? []).map(b => b.bucket_name)
    for (const b of pv.r2_buckets ?? []) {
      assert.ok(!ownBuckets.includes(b.bucket_name), `${file}: preview bucket ${b.bucket_name} is the Worker's own`)
    }
    // The bindings the code reads, except MEDIA_CACHE, exist in a Preview too.
    const names = list => (list ?? []).map(x => x.binding).sort()
    assert.deepEqual(names(pv.analytics_engine_datasets), names(cfg.analytics_engine_datasets))
    assert.deepEqual(pv.ai, cfg.ai)
    assert.deepEqual(pv.durable_objects?.bindings, cfg.durable_objects.bindings)
    // Cron and routes never apply to a Preview.
    assert.equal(pv.routes, undefined)
    assert.equal(pv.triggers, undefined)
  })
}

test('wrangler.jsonc gives each Preview the container, unnamed', () => {
  /**
   * The MEDIA_RESOLVER binding above is in the block, and its class extends a Container base that
   * throws when no container backs it. A `name` would pin every Preview to one application; wrangler
   * rejects it and names each Preview's application itself.
   */
  const cfg = read('wrangler.jsonc')
  const pc = cfg.previews.containers ?? []
  assert.deepEqual(pc.map(c => c.class_name).sort(), cfg.containers.map(c => c.class_name).sort())
  for (const c of pc) assert.equal(c.name, undefined, 'a preview container takes no fixed name')
})

test('wrangler.free.jsonc keeps the container out of its Previews too', () => {
  /** Workers Free has no Containers, in a Preview no more than at the top level. */
  const pv = read('wrangler.free.jsonc').previews
  assert.equal(pv.containers, undefined)
  assert.ok(!pv.durable_objects.bindings.some(b => b.name === 'MEDIA_RESOLVER'))
})

test('npm run deploy does not name the production config', () => {
  /**
   * `npm run deploy` deploys the generic file, and that is safe only because the generic file's name
   * is not production's. Pointed at the production file, the script would be a hand deploy of the
   * public instance: it races Workers Builds and leaves production looking healthy while it runs
   * whatever was on somebody's laptop. Production deploys from Workers Builds alone.
   */
  const pkg = JSON.parse(raw('package.json'))
  assert.ok(pkg.scripts.deploy, 'the script exists')
  assert.ok(!pkg.scripts.deploy.includes(PROD_FILE), `npm run deploy must not deploy ${PROD_FILE}`)
})

/**
 * THE OWNER'S RECIPES HAVE TO NAME PRODUCTION. Since phase 3 a wrangler command run from a checkout
 * without `-c` reads the root file and acts on `mbedfx-selfhost`. For `secret put` the failure is quiet:
 * wrangler 4.167.0 looks the Worker up, and when it is missing asks "create it?" through a prompt whose
 * non-interactive answer is yes (createDraftWorker, `fallbackValue: true`; interactive needs stdin AND
 * stdout on a TTY). So `secret put X < file` creates a stub mbedfx-selfhost, stores the secret on it
 * and prints Success, and production keeps the old value.
 *
 * `wrangler preview` joined the list when main's Workers Builds moved to Worker Previews (#143). It
 * takes its Worker from `--worker-name` or the config, and its `--name` names the Preview, not the
 * Worker. A missing Worker gets the same kind of prompt with the same yes ("does not exist yet. Would
 * you like to create it for this Preview?", `fallbackValue: true`), so a bare `npx wrangler preview`
 * from a checkout creates mbedfx-selfhost and previews that.
 *
 * What counts as a command: an inline code span starting `npx wrangler`, and any line of a fenced
 * block that runs wrangler, with backslash continuations joined. A bare inline `wrangler tail` is the
 * docs naming the tool ("`wrangler tail` still works with Workers Logs off") and is not checked. That
 * is the one hole: a recipe written that way slips through, so write recipes with `npx`.
 */
const OWNER_DOCS = ['CLAUDE.md', 'docs/CREDENTIALS.md', 'docs/METRICS.md', 'container/README.md', PROD_FILE]
// The subcommands whose Worker is `args.name ?? config.name` (tail: its positional; preview:
// `--worker-name`). `containers list` and `containers info` are account-wide and read no Worker name;
// `deploy` is the tests above.
const PICKS_BY_NAME = /^(?:npx\s+)?wrangler\s+(?:secret|tail|deployments|versions|rollback|preview)\b/
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function wranglerCommands(text) {
  const found = []
  // Fences may be indented (inside a list item); a fence left in the prose would flip the backtick
  // parity below and hide every span after it.
  const prose = text.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm, (_, body) => {
    for (const line of body.replace(/\\\n\s*/g, ' ').split('\n')) {
      const m = line.match(/(?:npx\s+)?wrangler\s.*$/)
      if (m) found.push(m[0].trim())
    }
    return ''
  })
  // Single-backtick spans are the odd segments. A span may wrap a line, and in a .jsonc comment the
  // wrapped part starts with the next line's `//`.
  prose.split('`').forEach((seg, i) => {
    if (i % 2 === 1 && /^npx\s+wrangler\s/.test(seg)) found.push(seg.replace(/\s*\n\s*(?:\/\/)?\s*/g, ' ').trim())
  })
  return found
}

const reachesProduction = cmd =>
  new RegExp(`(?:^|\\s)(?:-c|--config)(?:\\s+|=)${esc(PROD_FILE)}(?:\\s|$)`).test(cmd) ||
  new RegExp(`(?:^|\\s)--${/\bwrangler\s+preview\b/.test(cmd) ? 'worker-name' : 'name'}(?:\\s+|=)${esc(prod.name)}(?:\\s|$)`).test(cmd) ||
  new RegExp(`^(?:npx\\s+)?wrangler\\s+tail\\s+${esc(prod.name)}(?:\\s|$)`).test(cmd)

test('the owner-doc scan finds the recipes it checks, and tells a targeted command from a bare one', () => {
  /**
   * Without this, a parse that found nothing (a changed fence style, a renamed file) would leave the
   * per-file tests below passing on an empty list.
   */
  const cmds = OWNER_DOCS.flatMap(f => wranglerCommands(raw(f))).filter(c => PICKS_BY_NAME.test(c))
  assert.ok(cmds.length >= 6, `expected the owner docs' secret/tail/preview recipes, found ${JSON.stringify(cmds)}`)
  assert.ok(!reachesProduction('npx wrangler secret put YT_ACCOUNTS < accounts.json'))
  assert.ok(!reachesProduction('npx wrangler tail'))
  assert.ok(!reachesProduction('npx wrangler secret put X -c wrangler.jsonc'))
  assert.ok(reachesProduction(`npx wrangler secret put YT_ACCOUNTS -c ${PROD_FILE} < accounts.json`))
  assert.ok(reachesProduction(`npx wrangler versions list --name ${prod.name}`))
  assert.ok(reachesProduction(`npx wrangler tail ${prod.name} --format json`))
  // preview's --name names the Preview; its Worker comes from --worker-name or the config.
  assert.ok(!reachesProduction('npx wrangler preview'))
  assert.ok(!reachesProduction(`npx wrangler preview --name ${prod.name}`))
  assert.ok(reachesProduction(`npx wrangler preview -c ${PROD_FILE}`))
  assert.ok(reachesProduction(`npx wrangler preview --worker-name ${prod.name}`))
})

for (const file of OWNER_DOCS) {
  test(`${file}: every wrangler command that takes its Worker from the config names production's config or Worker`, () => {
    for (const cmd of wranglerCommands(raw(file)).filter(c => PICKS_BY_NAME.test(c))) {
      assert.ok(reachesProduction(cmd),
        `${file}: \`${cmd}\` reaches mbedfx-selfhost from a checkout. Add -c ${PROD_FILE}, or --name ${prod.name} (--worker-name for preview)`)
    }
  })
}

/**
 * THE PREVIEWS BLOCK NEVER REACHES PRODUCTION'S DATA (2026-11-25).
 *
 * Every non-main branch push runs `npx wrangler preview -c wrangler.production.jsonc`, and a Preview
 * inherits nothing, so wrangler.production.jsonc carries its own `previews` block. The two things it must
 * never share are production's R2 bucket (a branch's half-finished mux or record would land in the cache
 * production serves from) and production's Analytics Engine dataset (branch traffic would count in
 * production's numbers). The names are read from the production file itself, not listed here, so a
 * renamed production resource is still guarded. And a binding production's code reads but the block
 * leaves out does not exist in a Preview at all (Cloudflare: "your Worker can return a 1101 error"), so
 * the Durable Object bindings and the container must mirror the top level.
 */
test('THE PREVIEWS BLOCK NEVER NAMES PRODUCTION\'S BUCKET OR DATASET, and mirrors its Durable Objects and container', () => {
  const cfg = JSON.parse(readFileSync('wrangler.production.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const pv = cfg.previews
  assert.ok(pv, 'wrangler preview refuses to run without a previews block')
  const prodBuckets = cfg.r2_buckets.map(b => b.bucket_name)
  const prodDatasets = cfg.analytics_engine_datasets.map(d => d.dataset)
  for (const b of pv.r2_buckets ?? []) assert.ok(!prodBuckets.includes(b.bucket_name), `preview bucket ${b.bucket_name} is production's`)
  for (const d of pv.analytics_engine_datasets ?? []) assert.ok(!prodDatasets.includes(d.dataset), `preview dataset ${d.dataset} is production's`)
  // Every binding production's code reads exists in a Preview too.
  const names = list => (list ?? []).map(x => x.binding).sort()
  assert.deepEqual(names(pv.r2_buckets), names(cfg.r2_buckets))
  assert.deepEqual(names(pv.analytics_engine_datasets), names(cfg.analytics_engine_datasets))
  assert.deepEqual(pv.ai, cfg.ai)
  assert.deepEqual(pv.durable_objects.bindings, cfg.durable_objects.bindings)
  // One preview container per production container class, with no fixed application name: each
  // Preview gets its own container app, and a name would pin them all to one.
  assert.deepEqual(pv.containers.map(c => c.class_name).sort(), cfg.containers.map(c => c.class_name).sort())
  for (const c of pv.containers) assert.equal(c.name, undefined, 'a preview container takes no fixed name')
  // Production's triggers never belong to a Preview.
  assert.equal(pv.routes, undefined)
  assert.equal(pv.triggers, undefined)
})

/**
 * PUBLIC_ORIGIN AND GUEST_HOSTS (self-hosting phase 4, 2026-11-25). Both were constants in src/ until
 * then: the scheduled check rendered on 'https://mbedfx.app' (src/worker.ts scheduledSmoke) and the guest
 * hosts were a list in src/guesthost.ts. The production file now sets them, and these tests are the
 * evidence that the values reproduce the constants. The generic files set neither: a self-hoster sets them
 * in the dashboard, and keep_vars keeps them there.
 */
test('production\'s PUBLIC_ORIGIN and GUEST_HOSTS reproduce the two constants they replaced', () => {
  assert.equal(cronOrigin(prod.vars), 'https://mbedfx.app', 'the scheduled check renders on the apex, as the constant did')
  assert.deepEqual(GUEST_HOSTS, ['sorryifuckedyour.mom', 'hotsinglesnear.you'], 'src/guesthost.ts\'s old list, in its order')
})

test('production\'s PUBLIC_ORIGIN is bare https origins on its own zones, and names what the converter offers, no more', () => {
  /**
   * Every entry must be an origin the scheduled check could use (scheme and host, nothing else), so a
   * typo cannot silently move the primary down the list. Every host must be one of production's zones or
   * the `d.` name of one. And the non-`d.` hosts, with the guest hosts, must be exactly the domains the
   * converter page offers (its PUBLIC_HOSTS): forsen.sex is served and refused but not advertised
   * (owner's call, 2026-09-11), and the page is meant to take this list from the Worker (phase 5), so a
   * forsen.sex entry here would start advertising it.
   */
  const entries = prod.vars.PUBLIC_ORIGIN.split(/[\s,]+/).filter(Boolean)
  assert.ok(entries.length > 0)
  for (const e of entries) {
    const u = new URL(e)
    assert.equal(u.origin, e, `${e} is a bare origin, written as one`)
    assert.equal(u.protocol, 'https:', `${e} is https`)
    const apex = u.hostname.replace(/^d\./, '')
    assert.ok(prodZones.includes(apex), `${e} is on a production zone`)
  }
  const page = readFileSync('public/index.html', 'utf8').match(/var PUBLIC_HOSTS = \[([^\]]*)\]/)
  assert.ok(page, 'the page declares PUBLIC_HOSTS')
  const offered = page[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
  const published = entries.map(e => new URL(e).hostname).filter(h => !h.startsWith('d.'))
  assert.deepEqual([...published, ...GUEST_HOSTS].sort(), [...offered].sort())
  for (const e of entries.filter(x => new URL(x).hostname.startsWith('d.'))) {
    assert.ok(published.includes(new URL(e).hostname.slice(2)), `${e} is the d. name of a published origin`)
  }
})

test('a Preview runs production\'s vars, all of them', () => {
  /**
   * A Preview is how a branch is measured before it merges, so a var that differs is something measured
   * there that production will not run. The production file's comment on `previews` says why the two
   * vars that change nothing in a Preview today are kept anyway.
   */
  assert.deepEqual(prod.previews.vars, prod.vars)
})

for (const file of GENERIC) {
  test(`${file} sets neither PUBLIC_ORIGIN nor GUEST_HOSTS, at the top level or for Previews`, () => {
    /**
     * Either one in a generic file is a deploy that names somebody's domain: an origin the scheduled check
     * renders on and the guard refuses, or a host whose front page this Worker declines. The scan above
     * keeps production's own values out; this keeps out any value, because the right one is per
     * deployment and goes in the dashboard, where keep_vars leaves it alone.
     */
    const cfg = read(file)
    for (const vars of [cfg.vars, cfg.previews?.vars]) {
      for (const k of ['PUBLIC_ORIGIN', 'GUEST_HOSTS']) assert.equal(vars?.[k], undefined, `${file} sets ${k}`)
    }
    assert.equal(cfg.keep_vars, true, 'dashboard vars must survive a deploy of this file')
  })
}
