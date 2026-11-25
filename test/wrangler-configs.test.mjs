import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GUEST_HOSTS } from '../src/guesthost.ts'

/**
 * THE THREE WRANGLER CONFIGS (self-hosting phase 3, 2026-11-25).
 *
 *   wrangler.production.jsonc  the public instance. Workers Builds deploys it with `-c` on main and
 *                              uploads it with `-c` on other branches. Its own facts (name, domains,
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

// Production's zones, from its routes (`mbedfx.app/*` and `mbedfx.app` both reduce to the host).
const prodZones = (prod.routes ?? []).map(r => (typeof r === 'string' ? r : r.pattern).split('/')[0].replace(/^\*\.?/, ''))
// Production's resource names. Every one is a distinctive string, so the scan below can search for it
// in the raw text, comments included. The Worker name is not ("mbedfx" is in every file name here), so
// it is compared by value.
const prodResources = [
  ...(prod.r2_buckets ?? []).map(b => b.bucket_name),
  ...(prod.analytics_engine_datasets ?? []).map(d => d.dataset),
  ...(prod.containers ?? []).map(c => c.name).filter(Boolean),
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
      assert.ok(!text.includes(name.toLowerCase()), `${file} mentions ${name}, which belongs to ${PROD_FILE} or src/guesthost.ts`)
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
 * What counts as a command: an inline code span starting `npx wrangler`, and any line of a fenced
 * block that runs wrangler, with backslash continuations joined. A bare inline `wrangler tail` is the
 * docs naming the tool ("`wrangler tail` still works with Workers Logs off") and is not checked. That
 * is the one hole: a recipe written that way slips through, so write recipes with `npx`.
 */
const OWNER_DOCS = ['CLAUDE.md', 'docs/CREDENTIALS.md', 'docs/METRICS.md', 'container/README.md', PROD_FILE]
// The subcommands whose Worker is `args.name ?? config.name` (tail: its positional). `containers list`
// and `containers info` are account-wide and read no Worker name; `deploy` is the tests above.
const PICKS_BY_NAME = /^(?:npx\s+)?wrangler\s+(?:secret|tail|deployments|versions|rollback)\b/
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function wranglerCommands(text) {
  const found = []
  const prose = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_, body) => {
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
  new RegExp(`(?:^|\\s)--name(?:\\s+|=)${esc(prod.name)}(?:\\s|$)`).test(cmd) ||
  new RegExp(`^(?:npx\\s+)?wrangler\\s+tail\\s+${esc(prod.name)}(?:\\s|$)`).test(cmd)

test('the owner-doc scan finds the recipes it checks, and tells a targeted command from a bare one', () => {
  /**
   * Without this, a parse that found nothing (a changed fence style, a renamed file) would leave the
   * per-file tests below passing on an empty list.
   */
  const cmds = OWNER_DOCS.flatMap(f => wranglerCommands(raw(f))).filter(c => PICKS_BY_NAME.test(c))
  assert.ok(cmds.length >= 6, `expected the owner docs' secret/tail/versions recipes, found ${JSON.stringify(cmds)}`)
  assert.ok(!reachesProduction('npx wrangler secret put YT_ACCOUNTS < accounts.json'))
  assert.ok(!reachesProduction('npx wrangler tail'))
  assert.ok(!reachesProduction('npx wrangler secret put X -c wrangler.jsonc'))
  assert.ok(reachesProduction(`npx wrangler secret put YT_ACCOUNTS -c ${PROD_FILE} < accounts.json`))
  assert.ok(reachesProduction(`npx wrangler versions list --name ${prod.name}`))
  assert.ok(reachesProduction(`npx wrangler tail ${prod.name} --format json`))
})

for (const file of OWNER_DOCS) {
  test(`${file}: every wrangler command that takes its Worker from the config names production's config or Worker`, () => {
    for (const cmd of wranglerCommands(raw(file)).filter(c => PICKS_BY_NAME.test(c))) {
      assert.ok(reachesProduction(cmd),
        `${file}: \`${cmd}\` reaches mbedfx-selfhost from a checkout. Add -c ${PROD_FILE}, or --name ${prod.name}`)
    }
  })
}
