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
