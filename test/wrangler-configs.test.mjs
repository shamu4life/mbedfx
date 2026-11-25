import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * THE TWO WRANGLER CONFIGS, WHILE THEY ARE STILL ONE FILE.
 *
 * Self-hosting phase 2 (2026-11-25). wrangler.production.jsonc is mbedfx.app's config: its name, the
 * three custom domains, workers_dev off, the pinned container application, the production vars. Every
 * test that pins a production fact now reads it (smoke, guesthost, openapi, yt-promise-off). Phase 3
 * turns the root wrangler.jsonc into the generic config the Deploy to Cloudflare button and
 * self-hosters start from.
 *
 * Between the two phases Workers Builds may still deploy the ROOT file: it does until the owner
 * changes the deploy command to `npx wrangler deploy -c wrangler.production.jsonc`, a dashboard
 * setting this repo cannot see. So until phase 3 the files must be identical, byte for byte. If they
 * drifted in that window, the production pins would be guarding a file that is not the one
 * deploying, and a passing suite would say nothing about what ships.
 *
 * Phase 3 deletes this test in the same change that makes the root generic, and only after a main
 * build log shows the `-c` deploy command. Do not "fix" a failure here by editing one file: make the
 * same edit in both.
 */
test('wrangler.production.jsonc IS BYTE FOR BYTE wrangler.jsonc until the root config goes generic', () => {
  assert.equal(
    readFileSync('wrangler.production.jsonc', 'utf8'),
    readFileSync('wrangler.jsonc', 'utf8'),
    'edit both files the same way until self-hosting phase 3',
  )
})

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
