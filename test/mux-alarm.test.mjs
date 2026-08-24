import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, runMuxJob } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import {
  MUX_FIRST_ATTEMPT_MS, MUX_FIRST_ATTEMPT_TRACKS_MS, MUX_RETRY_MS, MUX_TOTAL_HORIZON_MS,
  firstMuxDelayMs, nextMuxDelayMs,
} from '../src/muxpolicy.ts'

/**
 * THE MUX ALARM — the fix for a defect that had been mis-stated in this file's own comments for a
 * month, and which cost a reader ten minutes on 2026-08-23.
 *
 * WHAT WAS WRONG. Every mux was dispatched through `ctx.waitUntil`, and settleMux's comment claimed
 * the work therefore "runs to completion regardless of who wins this race". Cloudflare documents the
 * opposite: `waitUntil` extends execution for AT MOST 30 seconds after the response, on a budget
 * shared across every waitUntil in the same request, and unsettled promises are then CANCELLED. So
 * the container's 180s ceiling and the 1500s of video the duration filter admits were both
 * unreachable — three ceilings, only the smallest real.
 *
 * AND A KILLED ATTEMPT LEFT NOTHING. The container buffers the whole file before sending a byte and
 * writes to a fresh mkstemp it deletes in a `finally`, so there is no partial R2 object and no
 * resumable `.part`. `/_prep` returns in 23ms and then gets exactly 30 seconds; re-pressing it was a
 * lottery that discarded 100% of its bytes on every losing roll. That is the reported ten minutes.
 *
 * A Durable Object alarm handler gets FIFTEEN MINUTES. These tests pin the seam, not the runtime:
 * src/muxrunner.ts imports `cloudflare:workers` and cannot be loaded here at all, which is exactly
 * why its one piece of judgement lives in the pure src/muxpolicy.ts.
 */

const ctx = { waitUntil(p) { if (p && typeof p.catch === 'function') p.catch(() => {}) } }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
function fakeR2() {
  const store = new Map()
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length } : null },
    async put(k, body) { store.set(k, new Uint8Array(await new Response(body).arrayBuffer())) },
  }
}

const ST_REF = { p: 'st', id: 'alarm001' }
const PAGE = 'https://streamable.com/alarm001'
const stPost = (remux) => ({
  ref: ST_REF, canonical: PAGE,
  author: { name: 'Streamable', handle: 'streamable', url: 'https://streamable.com' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [{
    kind: 'video', url: PAGE, w: 0, h: 0, poster: 'https://cdn.example/thumb.jpg',
    remux: remux ?? { page: PAGE },
  }],
})
const cardReq = () =>
  new Request(`https://staging.megapenispoopenfarten.sex/e/${ST_REF.id}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  })

/** Records every schedule() the render makes, so the job can be inspected rather than assumed. */
function recordingRunner(impl) {
  const jobs = []
  return {
    jobs,
    binding: {
      getByName(name) {
        return {
          async schedule(job) {
            jobs.push({ name, job })
            if (impl) await impl()
          },
        }
      },
    },
  }
}
const envWith = (runner, muxImpl) => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: { getByName: () => ({ fetch: muxImpl ?? (async () => new Response('nope', { status: 502 })) }) },
  MEDIA_CACHE: fakeR2(),
  ...(runner ? { MUX_RUNNER: runner } : {}),
})
const deps = () => ({
  cache: fakeCache(),
  fetchPost: async () => stPost(),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
})

// ── The seam: does a render actually hand the video to something with a 15-minute budget?

test('A RENDER ARMS THE ALARM — the video is handed to a budget that can actually finish it', async () => {
  const { jobs, binding } = recordingRunner()
  await handle(cardReq(), envWith(binding), ctx, deps())

  assert.equal(jobs.length >= 1, true, 'the render must arm the alarm; without it a slow mux is simply lost')
  const { name, job } = jobs[0]
  assert.equal(name, `mux/${refKey(ST_REF)}/0`,
    'the DO is addressed BY THE MUX KEY — one object per video worldwide, which is the global dedupe ' +
    'muxInflight has never provided (it is isolate-local and says so)')
  assert.equal(job.key, `mux/${refKey(ST_REF)}/0`)
  assert.equal(job.slotKey, refKey(ST_REF), 'the slot key is what the platform and credential pool are re-derived from')
  assert.deepEqual(job.source, { page: PAGE })
})

test('THE JOB CARRIES THE PAGE, NOT THE RESOLVED TRACKS — those urls will be dead by the time it runs', async () => {
  /**
   * remux.video/audio are format urls the metadata call already resolved, and inside a request they
   * are a real saving. This job may not run for twenty minutes, and those urls are bound to the
   * egress IP that resolved them and expire in hours — so sending them would buy a guaranteed wasted
   * container call followed by the page fallback anyway.
   */
  const { jobs, binding } = recordingRunner()
  const d = { ...deps(), fetchPost: async () => stPost({ page: PAGE, video: 'https://cdn.example/v.m4s', audio: 'https://cdn.example/a.m4s' }) }
  await handle(cardReq(), envWith(binding), ctx, d)

  assert.deepEqual(jobs[0].job.source, { page: PAGE },
    'the page alone — a stale signed url is worse than no shortcut')
})

test('A SOURCE WITH NO PAGE KEEPS ITS video — Bluesky and Reddit have no page to fall back to', async () => {
  // Their remux.video is an ordinary CDN manifest url, not a signed one, so it is the durable form.
  const { jobs, binding } = recordingRunner()
  const hls = 'https://cdn.bsky.app/v.m3u8'
  const d = { ...deps(), fetchPost: async () => stPost({ video: hls }) }
  await handle(cardReq(), envWith(binding), ctx, d)

  /**
   * UNCONDITIONAL, DELIBERATELY. This assertion used to read `if (jobs.length) assert...`, which is a
   * test that passes when the feature is entirely absent — and it WAS entirely absent: settleMux
   * returned at `!own.some(m => m?.remux?.page)` before it could arm anything without a page, so
   * Bluesky and Reddit had no alarm coverage at all and this test said nothing about it.
   */
  assert.equal(jobs.length, 1, 'a page-less source must be armed, not skipped')
  assert.deepEqual(jobs[0].job.source, { video: hls })
})

test('NO BINDING MEANS NO CHANGE — the service behaves exactly as it did before the alarm existed', async () => {
  /**
   * MUX_RUNNER is optional exactly as MEDIA_RESOLVER is, and this is what makes it safe to ship the
   * code ahead of the binding, and what a self-hosted deploy gets for free: the inline attempt still
   * runs, it is just still capped at thirty seconds.
   */
  const res = await handle(cardReq(), envWith(null), ctx, deps())
  assert.equal(res.status, 200, 'the card still renders with no runner bound')
})

test('A RUNNER THAT THROWS MUST NOT TAKE THE CARD DOWN WITH IT', async () => {
  // Arming the alarm is a best-effort upgrade, not a dependency: the inline attempt is still running
  // and the next paste arms it again. A card is never worth losing to a failed RPC.
  const { binding } = recordingRunner(async () => { throw new Error('DO unavailable') })
  const res = await handle(cardReq(), envWith(binding), ctx, deps())
  assert.equal(res.status, 200)
})

// ── runMuxJob: the alarm's half, which must be able to run with nothing but a serialized job.

test('runMuxJob REPORTS WHETHER THE BYTES ARE IN R2 — not whether a container answered', async () => {
  // The retry decision turns on this boolean, so it has to mean the thing the reader cares about:
  // that the next view can play it.
  const env = envWith(null, async () => new Response('MP4', { headers: { 'content-type': 'video/mp4' } }))
  const job = { key: `mux/${refKey(ST_REF)}/0`, slotKey: refKey(ST_REF), source: { page: PAGE } }
  assert.equal(await runMuxJob(env, job), true)
  assert.ok(env.MEDIA_CACHE.store.has(job.key), 'and the bytes really landed')

  const failing = envWith(null, async () => new Response('{"error":"mux failed"}', { status: 502 }))
  assert.equal(await runMuxJob(failing, job), false)
})

test('AN UNPARSEABLE slotKey IS REFUSED, never muxed blind', async () => {
  /**
   * A job can outlive the build that wrote it — it sits in Durable Object storage across deploys. If
   * the refKey allowlist has changed underneath it, the platform and the credential pool cannot be
   * re-derived, and muxing anyway would spend a container slot with no attribution and no jar.
   * parseRefKey is this repo's existing allowlist and forgetting a kind there is already documented
   * as silent, so this refuses rather than guesses.
   */
  let called = false
  const env = envWith(null, async () => { called = true; return new Response('MP4') })
  const job = { key: 'mux/nonsense/0', slotKey: 'not-a-real-refkey', source: { page: PAGE } }
  assert.equal(await runMuxJob(env, job), false)
  assert.equal(called, false, 'and the container was never asked')
})

// ── The retry policy, which is the only judgement in the runner and therefore the only part testable.

test('THE FIRST ATTEMPT FIRES PAST THE waitUntil CEILING, or it races the attempt it exists to replace', () => {
  /**
   * THE DERIVATION, not a taste. The inline attempt is killed by the runtime at 30s. Firing before
   * that would mux the same video TWICE on the same pooled container instance, competing for the very
   * bandwidth that decides whether the card gets a player — which is the failure muxOnce was written
   * to prevent, reintroduced by its own fix. Firing after it means a mux that finished inline has
   * already written to R2, so the alarm's R2 head check hits and it does no container work at all.
   */
  assert.ok(MUX_FIRST_ATTEMPT_MS > 30_000,
    'Cloudflare cancels an unsettled waitUntil at 30s; the alarm must fire after that, not during')
  assert.ok(MUX_FIRST_ATTEMPT_MS < 60_000, 'but not so late that a reader has given up and re-pasted')
})

test('RETRY IS BOUNDED — an unbounded one turns a permanently gated video into a service-wide outage', () => {
  /**
   * Retrying on the reader's behalf is most of the fix: they should press once, not for ten minutes.
   * Retrying FOREVER is a different bug — RESOLVER_SLOTS is 4 and the pool is shared by every
   * platform, so one dead video on a schedule degrades every other platform's cards.
   */
  let spent = 0
  const delays = []
  for (;;) {
    const d = nextMuxDelayMs(spent)
    if (d === null) break
    delays.push(d)
    spent++
    assert.ok(spent < 50, 'the retry schedule must terminate')
  }
  assert.deepEqual(delays, [...MUX_RETRY_MS], 'the schedule is exactly what the constant declares')
  assert.ok(delays.every((d, i) => i === 0 || d > delays[i - 1]), 'and it backs off rather than hammering')
})

test('nextMuxDelayMs IS TOTAL OVER JUNK — the counter comes back from storage a past deploy wrote', () => {
  // Refusing to retry costs one cold card. Reading junk as a fresh start is an unbounded loop against
  // a shared container pool, so every unusable value must mean "stop", never "start over".
  for (const junk of [-1, 1.5, NaN, Infinity, -Infinity, '0', null, undefined, {}, [], true]) {
    assert.equal(nextMuxDelayMs(junk), null, `${String(junk)} must not restart the schedule`)
  }
})

test('THE FIRST ATTEMPT WAITS FOR THE RIGHT CEILING — 35s is wrong for a source with no page', () => {
  /**
   * THE BUG THIS PINS. MUX_FIRST_ATTEMPT_MS = 35s is derived from ONE fact: `waitUntil` is cancelled
   * at 30s, so at 35s the inline attempt is certainly dead and the alarm cannot race it. That
   * derivation only holds for a `{page}` source, which settleMux and the prewarm dispatch INTO
   * waitUntil.
   *
   * A `{video}` source has exactly one dispatcher — serveMuxed, inside Discord's media-proxy request
   * — and that attempt is ceilinged by the container instead, at `_mux_tracks`'s PROC_TIMEOUT of
   * 120s. Firing at 35s would wake the alarm mid-pull, in a DO isolate where muxInflight cannot
   * dedupe and the R2 head still misses because nothing is written until the mux finishes: two
   * concurrent ffmpeg pulls of one video on one pooled instance, competing for the exact bandwidth
   * that decides whether the card gets a player. Precisely the double-mux the 35s comment warns about,
   * reintroduced by widening the alarm to the platforms that needed it most.
   */
  assert.equal(firstMuxDelayMs(true), MUX_FIRST_ATTEMPT_MS)
  assert.equal(firstMuxDelayMs(false), MUX_FIRST_ATTEMPT_TRACKS_MS)
  assert.ok(MUX_FIRST_ATTEMPT_TRACKS_MS > 120_000,
    'it must outlast _mux_tracks\'s PROC_TIMEOUT (120s), or the alarm races a live ffmpeg')
  assert.ok(MUX_FIRST_ATTEMPT_MS > 30_000,
    'and the page form must outlast the waitUntil ceiling it is derived from')
})

test('THE HORIZON IS STATED, so nobody has to add the constants up to know what a reader is promised', () => {
  // Quoted for the SLOWEST shape — the tracks path, whose first attempt waits out the container's own
  // 120s wall rather than waitUntil's 30s. A {page} source's horizon is 105s shorter.
  assert.equal(MUX_TOTAL_HORIZON_MS, MUX_FIRST_ATTEMPT_TRACKS_MS + MUX_RETRY_MS.reduce((a, b) => a + b, 0))
  // ~22 minutes. Long enough to outlast a throttle, short enough that a hard gate is established
  // quickly rather than proved all afternoon.
  assert.ok(MUX_TOTAL_HORIZON_MS > 15 * 60_000 && MUX_TOTAL_HORIZON_MS < 45 * 60_000)
})
