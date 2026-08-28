import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'

/**
 * `/_clients` — THE INSTRUMENT THAT SETTLES WHICH PLAYER CLIENT ACTUALLY WORKS.
 *
 * Three YouTube "fixes" have shipped on residential evidence and done nothing in production, because
 * the failure that reaches users is Cloudflare-egress-only: measured 2026-08-28, ~40-50% of
 * Worker-egress YouTube requests are refused while every one succeeds residentially in the same
 * minute, and our configured client list answers 5 of 6 test videos from a laptop. This route runs the
 * comparison inside the container, on that egress.
 *
 * WHAT THESE TESTS PIN is the two properties that make it worth having rather than the numbers it
 * returns (which are live and cannot be asserted offline):
 *   1. IT TAKES NO INPUT. The video id and client list are constants in container/server.py, so there
 *      is no parameter a caller can point anywhere. A regression here turns a diagnostic into an open
 *      yt-dlp relay, which is why the request body is asserted EXACTLY rather than loosely.
 *   2. IT DEGRADES, NEVER CRASHES. An operator reaching for a diagnostic during an outage is the worst
 *      possible time to answer 500.
 */

const ctx = { waitUntil() {} }
const deps = {}
const req = (path, init) => new Request(`https://mbedfx.app${path}`, init)

/** A resolver binding that records exactly what the route asked it, and answers what the test wants. */
function fakeResolver(reply) {
  const seen = { names: [], bodies: [], headers: [] }
  return {
    seen,
    binding: {
      getByName(name) {
        seen.names.push(name)
        return {
          async fetch(_url, init) {
            seen.bodies.push(JSON.parse(init.body))
            seen.headers.push(init.headers)
            if (typeof reply === 'function') return reply()
            return Response.json(reply)
          },
        }
      },
    },
  }
}

const PROBE_REPLY = {
  video: 'jNQXAC9IVRw',
  ytdlp: '2026.08.19',
  ms: 68000,
  serving: ['default', 'web_embedded', 'tv_simply', 'mweb'],
  clients: [
    { client: 'default', extracted: true, formats: 24, gvs: 'ok', bytes: 65536, error: '', ms: 6908 },
    { client: 'android_vr', extracted: true, formats: 1, gvs: 'http-403', bytes: 0, error: '', ms: 6035 },
  ],
}

test('THE PROBE TAKES NO INPUT — the body is exactly {probe:true}, and nothing from the url', async () => {
  /**
   * THE SECURITY PROPERTY, asserted rather than promised. `/_smoke` earns the same one by construction
   * and says so: "a version of this that accepted ?url= would be an open relay wearing a monitoring
   * badge". This route reaches yt-dlp, so the same mistake here would be worse — an arbitrary-url
   * fetcher with a diagnostic name.
   *
   * The query string below is the attack: if any of it reaches the container, this fails.
   */
  const r = fakeResolver(PROBE_REPLY)
  const res = await handle(
    req('/_clients?url=https://evil.example/&video=SOMETHINGELSE&id=../../etc/passwd'),
    { MEDIA_RESOLVER: r.binding }, ctx, deps)

  assert.equal(res.status, 200)
  assert.equal(r.seen.bodies.length, 1, 'exactly one call to the container')
  assert.deepEqual(r.seen.bodies[0], { probe: true },
    'the ONLY field sent is the flag — no url, no video id, nothing a caller supplied')
})

test('A CLIENT THAT SERVES BYTES IS THE ONLY KIND THAT COUNTS AS SERVING', async () => {
  /**
   * The distinction the whole route exists for. On the first live run, `android_vr` returned
   * `extracted: true, formats: 1` and then 403'd at googlevideo — healthy-looking and useless, which
   * is the exact shape of the outage this project spent weeks on. The route reports `ok` off
   * `serving`, which the container fills only from a real byte fetch.
   */
  const r = fakeResolver(PROBE_REPLY)
  const res = await handle(req('/_clients'), { MEDIA_RESOLVER: r.binding }, ctx, deps)
  const j = await res.json()

  assert.equal(j.ok, true)
  assert.deepEqual(j.serving, ['default', 'web_embedded', 'tv_simply', 'mweb'])
  const vr = j.clients.find(c => c.client === 'android_vr')
  assert.equal(vr.extracted, true, 'it extracted fine')
  assert.equal(vr.gvs, 'http-403', 'and was refused the bytes — which is what makes it broken')
  assert.ok(!j.serving.includes('android_vr'), 'so it must NOT be reported as serving')
})

test('NOTHING SERVING IS ok:false — a probe that finds no working client is a RED result', async () => {
  // The alarm case. If every client is refused from production egress, that is the outage, and an
  // endpoint that answered ok:true with an empty list would hide exactly the thing it exists to find.
  const r = fakeResolver({ ...PROBE_REPLY, serving: [] })
  const res = await handle(req('/_clients'), { MEDIA_RESOLVER: r.binding }, ctx, deps)
  const j = await res.json()
  assert.equal(j.ok, false)
  assert.equal(res.status, 200, 'still 200 — the probe RAN; its finding is in the body')
})

test('NO MEDIA_RESOLVER SAYS SO, rather than pretending or crashing', async () => {
  // The self-hosting and no-container deployments. "503 plus a sentence" is a usable answer; a stack
  // trace or a silent ok is not.
  const res = await handle(req('/_clients'), {}, ctx, deps)
  assert.equal(res.status, 503)
  const j = await res.json()
  assert.equal(j.ok, false)
  assert.match(j.error, /MEDIA_RESOLVER/)
})

test('AN UNREACHABLE CONTAINER IS 502, NEVER 500 — a diagnostic must not need a diagnostic', async () => {
  /**
   * An operator reaches for this DURING an outage, which is the worst possible moment to answer with
   * an unhandled exception. The container being down is a normal thing for this route to report.
   */
  const r = fakeResolver(() => { throw new TypeError('connection reset') })
  const res = await handle(req('/_clients'), { MEDIA_RESOLVER: r.binding }, ctx, deps)
  assert.equal(res.status, 502)
  const j = await res.json()
  assert.equal(j.ok, false)
  assert.match(j.error, /unreachable/)
})

test('A NON-OK CONTAINER RESPONSE REPORTS ITS STATUS instead of being read as a result', async () => {
  // A 401 here means RESOLVER_SECRET is misconfigured — a real and likely operator error. Parsing that
  // body as a probe result would report "no clients serving" and send someone hunting YouTube.
  const r = fakeResolver(() => new Response('unauthorized', { status: 401 }))
  const res = await handle(req('/_clients'), { MEDIA_RESOLVER: r.binding }, ctx, deps)
  assert.equal(res.status, 502)
  assert.equal((await res.json()).status, 401, 'the container status is surfaced, not swallowed')
})

test('THE RESOLVER SECRET IS FORWARDED when the deployment sets one', async () => {
  const r = fakeResolver(PROBE_REPLY)
  await handle(req('/_clients'), { MEDIA_RESOLVER: r.binding, RESOLVER_SECRET: 'SECRET-FIXTURE' },
    ctx, deps)
  assert.equal(r.seen.headers[0]['x-resolver-secret'], 'SECRET-FIXTURE')
})

test('THE PROBE USES ONE FIXED SLOT, so two runs are comparable', async () => {
  /**
   * Not a hashed slot. This is a diagnostic ABOUT THE CLIENTS, and spreading it across the instance
   * pool the way post traffic is spread would answer about a different container each run — which
   * would make a change between two runs unattributable, and that is the only thing anyone would use
   * this for.
   */
  const a = fakeResolver(PROBE_REPLY)
  const b = fakeResolver(PROBE_REPLY)
  await handle(req('/_clients'), { MEDIA_RESOLVER: a.binding }, ctx, deps)
  await handle(req('/_clients'), { MEDIA_RESOLVER: b.binding }, ctx, deps)
  assert.equal(a.seen.names[0], b.seen.names[0], 'the same slot every time')
})
