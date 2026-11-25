import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'
import { promisable, ytPromiseOn, YT_PROMISE } from '../src/muxpolicy.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'

/**
 * `YT_PROMISE: "off"` (wrangler.production.jsonc, 2026-11-24): a cold short YouTube video keeps YouTube's own embed
 * player instead of a promised mp4. Measured that day: the promise reached Discord in time 1 time in 8.
 *
 * REWRITTEN 2026-11-25, WHEN THE PROMISE BECAME OPT-IN. This file used to pin "off is off, anything else
 * leaves the build default", and its two "ON (no var)" tests pinned an env WITHOUT the var as promise
 * mode. That was the defect: a self-hoster who omitted the var got the setting production had measured
 * and turned off. Now only `YT_PROMISE: 'on'` turns it on, so:
 *   - the predicate test asserts the new truth table (unset, empty, 'off', 'ON' and junk are off);
 *   - the two ON tests set 'on', and assert exactly what they asserted before;
 *   - two UNSET tests are new, asserting the OFF behaviour end to end with no var at all, because that
 *     is the case the change is for.
 * card-promise.test.mjs still pins promise mode in full, with 'on' set on its env.
 */

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const bot = url => new Request(url, { headers: { 'user-agent': DISCORD } })
const ytRef = id => ({ p: 'yt', id })
const activityUrl = ref => `https://mbedfx.app/users/anyone/statuses/${encodeStatusId(refKey(ref))}`
const headUrl = ref => `https://mbedfx.app/watch?v=${ref.id}`

const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const fakeR2 = () => {
  const store = new Map()
  return {
    async head(k) { const v = store.get(k); return v ? { size: v.length, uploaded: new Date() } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length } : null },
    async put(k, body) { store.set(k, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
  }
}
const rowsOf = (ae, o) => ae.rows.filter(r => r.blobs?.[1] === o)
const envWith = (vars = {}) => {
  const ae = { rows: [], writeDataPoint(d) { this.rows.push(d) } }
  return {
    ae,
    env: {
      AE: ae, ASSETS: { async fetch() { return new Response('a') } }, TRANSLATE_GOOGLE: 'off',
      MEDIA_CACHE: fakeR2(),
      // A mux that is still running: it never answers inside the test's budget.
      MEDIA_RESOLVER: { getByName: () => ({ fetch: () => new Promise(() => {}) }) },
      ...vars,
    },
  }
}
const ytPost = ref => ({
  ref, canonical: `https://www.youtube.com/watch?v=${ref.id}`,
  author: { name: 'promise off', handle: 'promiseoff', url: 'https://www.youtube.com/@promiseoff' },
  text: 'a short clip that would have been promised', createdAt: new Date('2026-11-24T00:00:00Z'),
  counts: {}, sensitive: false,
  media: [{
    kind: 'video', url: `https://www.youtube.com/watch?v=${ref.id}`, w: 0, h: 0,
    poster: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`, posterW: 480, posterH: 360,
    remux: { page: `https://www.youtube.com/watch?v=${ref.id}` }, duration: 120,
  }],
})
const deps = () => ({
  cache: fakeCache(), fetchPost: async ref => ytPost(ref),
  resolveShortlink: async () => ({ kind: 'unresolved' }), resolveRedditShare: async () => null,
})
const ctx = { waitUntil() {} }

test('ytPromiseOn and promisable read the var: ONLY "on" is on, and unset, "off" and anything else are off', () => {
  const m = { duration: 120 }
  assert.equal(YT_PROMISE, true, 'the master switch is unchanged; the var still decides, and now opts in')
  assert.equal(ytPromiseOn({ YT_PROMISE: 'on' }), true)
  assert.equal(promisable(m, { YT_PROMISE: 'on' }), true, 'and a vouched-for video is promised')
  // Off, for every spelling that is not exactly "on". Strict on purpose: a near miss lands on the side
  // production measured as the better one.
  assert.equal(ytPromiseOn(), false, 'no env at all')
  assert.equal(ytPromiseOn(null), false)
  assert.equal(ytPromiseOn({}), false, 'the var unset: the case a self-hoster who copied the Worker is in')
  for (const v of ['', 'off', 'ON', 'On', ' on', 'on ', 'true', '1', 'yes', true, 1]) {
    assert.equal(ytPromiseOn({ YT_PROMISE: v }), false, `YT_PROMISE=${JSON.stringify(v)}`)
  }
  assert.equal(promisable(m), false)
  assert.equal(promisable(m, {}), false)
  assert.equal(promisable(m, { YT_PROMISE: 'off' }), false)
})

test('OFF: the activity document of a cold short video carries the poster, promises nothing, and waits the restored budget', async () => {
  const { env, ae } = envWith({ YT_PROMISE: 'off' })
  const t0 = Date.now()
  const j = await (await handle(bot(activityUrl(ytRef('promoff0001'))), env, ctx, deps())).json()
  const ms = Date.now() - t0
  // A real document, not a not-found one: the post is there, with exactly its one entry as a picture.
  assert.ok(typeof j.content === 'string' && j.content.length > 0, 'the post rendered')
  assert.equal(j.media_attachments.length, 1)
  assert.equal(j.media_attachments[0].type, 'image', 'the poster, not a player Discord would freeze dead')
  assert.equal(rowsOf(ae, 'card_promised').length, 0)
  // THE ROLLBACK RESTORES THE DOCUMENT'S OWN WAIT (muxpolicy.ts YT_PROMISE): with the promise on, a
  // promisable document answers at the ~300 ms floor; off, it waits for the mux. The silent resolver
  // never answers, so the whole budget is spent. This is what fails if the serve-side `promising` stops
  // reading the var.
  assert.ok(ms > 2000, `the document waited for the mux instead of answering at the floor (${ms}ms)`)
})

test('ON (YT_PROMISE=on): the same document answers at the floor and promises the video', async () => {
  // Was "ON (no var)" until 2026-11-25; the assertions are the same and the var now has to say so.
  const { env, ae } = envWith({ YT_PROMISE: 'on' })
  const t0 = Date.now()
  const j = await (await handle(bot(activityUrl(ytRef('promoff0004'))), env, ctx, deps())).json()
  assert.ok(Date.now() - t0 < 2000, 'the floor, not the restored wait')
  assert.equal(j.media_attachments[0].type, 'video')
  assert.equal(rowsOf(ae, 'card_promised').length, 1)
})

test('OFF: the head of a cold short video keeps YouTube\'s own embed player, after the restored head wait', async () => {
  const { env } = envWith({ YT_PROMISE: 'off' })
  const t0 = Date.now()
  const html = await (await handle(bot(headUrl(ytRef('promoff0002'))), env, ctx, deps())).text()
  // With the promise on, a known duration takes the ~300 ms floor; off, the head waits MUX_WAIT_BOT_MS.
  assert.ok(Date.now() - t0 > 1000, 'the head waited for the mux before giving up to the stock gate')
  assert.match(html, /og:video" content="https:\/\/www\.youtube\.com\/embed\/promoff0002/,
    'the stock gate: Discord plays YouTube\'s player at once, with nothing to wait for')
})

test('ON (YT_PROMISE=on): the same head stands the stock player down for the promise, as card-promise.test.mjs pins', async () => {
  // Was "ON (no var)" until 2026-11-25; the assertions are the same and the var now has to say so.
  const { env } = envWith({ YT_PROMISE: 'on' })
  const html = await (await handle(bot(headUrl(ytRef('promoff0003'))), env, ctx, deps())).text()
  assert.match(html, /og:title/, 'a real card, not a not-found head')
  assert.match(html, /application\/activity\+json/, 'it keeps the activity link Discord must follow')
  assert.match(html, /poster0/, 'and the poster on its own slot')
  assert.doesNotMatch(html, /og:video" content="https:\/\/www\.youtube\.com\/embed\//)
})

test('UNSET: the activity document of a cold short video promises nothing, exactly as "off" does', async () => {
  // THE CASE THE 2026-11-25 CHANGE IS FOR: a deployment that never set the var. Before it this document
  // promised the video at the floor; now it is the OFF document, poster and the restored wait.
  const { env, ae } = envWith()
  assert.equal('YT_PROMISE' in env, false, 'no var at all, not an empty one')
  const t0 = Date.now()
  const j = await (await handle(bot(activityUrl(ytRef('promoff0005'))), env, ctx, deps())).json()
  const ms = Date.now() - t0
  assert.ok(typeof j.content === 'string' && j.content.length > 0, 'the post rendered')
  assert.equal(j.media_attachments.length, 1)
  assert.equal(j.media_attachments[0].type, 'image', 'the poster, not a promised player')
  assert.equal(rowsOf(ae, 'card_promised').length, 0)
  assert.ok(ms > 2000, `the document waited for the mux, as with "off" (${ms}ms)`)
})

test('UNSET: the head of a cold short video keeps YouTube\'s own embed player, exactly as "off" does', async () => {
  const { env } = envWith()
  const t0 = Date.now()
  const html = await (await handle(bot(headUrl(ytRef('promoff0006'))), env, ctx, deps())).text()
  assert.ok(Date.now() - t0 > 1000, 'the head waited for the mux before giving up to the stock gate')
  assert.match(html, /og:video" content="https:\/\/www\.youtube\.com\/embed\/promoff0006/,
    'the stock gate, with no var set')
})

test('production ships with the promise off (wrangler.production.jsonc vars)', () => {
  // Parsed, the way the other config tests read it, so a commented-out line or a second var is read right.
  const cfg = JSON.parse(readFileSync(new URL('../wrangler.production.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  assert.equal(cfg.vars?.YT_PROMISE, 'off',
    'turning it back on is a decision: change this test with the config and say why in the commit')
})
