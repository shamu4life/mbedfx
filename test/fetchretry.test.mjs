import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { askTwice, worthAskingAgain, ASK_ATTEMPTS } from '../src/fetchretry.ts'

/**
 * ONE REFUSED REQUEST MUST NOT COST A PERMANENT CARD.
 *
 * On the open web a refused fetch is a bad minute: the reader reloads and gets the page. On Discord
 * it is forever — Discord stores the embed it built INSIDE the message and does not re-unfurl a link
 * it has already drawn (discord-api-docs#1663). Every fetcher here asked once, so a 300ms hiccup
 * produced a "couldn't load" card that stayed wrong for everyone who ever scrolled past that message.
 *
 * Reported 2026-08-28 on a public Twitter video post, and measured the same day: both of this
 * project's Twitter paths answer that id perfectly from residential egress (syndication 8/8 with
 * video; guest `__typename: Tweet` with `media: ['video']`). The post is not sensitive, not
 * protected and not deleted. Cloudflare's egress was refused once.
 *
 * These tests pin the COUNT, not just the verdict — a test that only checked the answer would pass
 * just as well with the retry deleted — and they pin the no-retry cases as hard as the retry ones,
 * because retrying a verdict would double the cost of every dead link anyone pastes.
 */

/** Script the network: one entry per expected call, consumed in order, last entry repeating. */
function scripted(steps) {
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    const step = steps[Math.min(seen.length, steps.length - 1)]
    seen.push(String(url))
    if (typeof step === 'function') return step()
    return new Response(step.body ?? 'x', { status: step.status })
  }
  return { calls: seen, restore() { globalThis.fetch = real } }
}

test('THE POLICY IS PURE: only a REFUSED request is worth asking again', () => {
  /**
   * The one question status can answer and content cannot. A 429 with an HTML body and a 404 with an
   * HTML body are byte-indistinguishable to a content check and want opposite treatment: the first is
   * about our request, the second is about the post.
   */
  for (const refused of [408, 425, 429, 500, 502, 503, 504, 599]) {
    assert.equal(worthAskingAgain(refused), true, `${refused} means the endpoint refused the request`)
  }
  for (const answered of [200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 410, 451]) {
    assert.equal(worthAskingAgain(answered), false,
      `${answered} is an answer about the POST; asking twice would only double the cost of a dead link`)
  }
})

test('A GOOD ANSWER COSTS EXACTLY ONE REQUEST — the happy path is untouched', async () => {
  // The cost guard that matters most: every card that works today must still cost what it cost.
  const net = scripted([{ status: 200, body: 'ok' }])
  try {
    const res = await askTwice('https://example.test/a')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ok', 'the body is returned UNCONSUMED, so callers are unchanged')
    assert.equal(net.calls.length, 1)
  } finally { net.restore() }
})

test('A REFUSED REQUEST IS ASKED AGAIN, and the second answer is the one returned', async () => {
  const net = scripted([{ status: 503, body: 'edge refused' }, { status: 200, body: 'the post' }])
  try {
    const res = await askTwice('https://example.test/a')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'the post')
    assert.equal(net.calls.length, 2, 'exactly one EXTRA ask')
  } finally { net.restore() }
})

test('A VERDICT IS BELIEVED AT ONCE — 404 and 403 are answers about the post, not the request', async () => {
  /**
   * Measured 2026-08-28 on Twitter: a nonexistent id answers HTTP 200 with a parseable TweetTombstone
   * reading "This Post is from an account that no longer exists". Dead links are common and their
   * answer cannot change, so retrying on failure-of-any-kind would be a permanent tax for nothing.
   */
  for (const status of [200, 400, 403, 404, 410]) {
    const net = scripted([{ status, body: 'verdict' }])
    try {
      const res = await askTwice('https://example.test/a')
      assert.equal(res.status, status)
      assert.equal(net.calls.length, 1, `HTTP ${status} must not cost a second request`)
    } finally { net.restore() }
  }
})

test('REFUSED TWICE GIVES UP AND RETURNS THE REFUSAL — one extra ask, not a loop', async () => {
  /**
   * The bound matters as much as the retry. These fetchers run inside a 5s crawler deadline shared
   * with fallbacks, the render and (on some platforms) a mux wait, so an unbounded loop would trade a
   * missing card for a missing response — strictly worse.
   */
  const net = scripted([{ status: 429, body: 'slow down' }])
  try {
    const res = await askTwice('https://example.test/a')
    assert.equal(res.status, 429, 'the refusal is RETURNED, not thrown — callers classify it as they always did')
    assert.equal(net.calls.length, ASK_ATTEMPTS)
    assert.equal(ASK_ATTEMPTS, 2)
  } finally { net.restore() }
})

test('THE REFUSED BODY IS CANCELLED before the retry — this path runs on every refusal', async () => {
  /**
   * A Response whose body is never read and never cancelled holds its stream open for the life of the
   * request. Leaking one per refusal, on every platform, is the kind of thing that only shows up under
   * the traffic this project has not had yet.
   */
  let cancelled = false
  const real = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    if (n++ === 0) {
      const body = new ReadableStream({ start() {}, cancel() { cancelled = true } })
      return new Response(body, { status: 503 })
    }
    return new Response('ok', { status: 200 })
  }
  try {
    const res = await askTwice('https://example.test/a')
    assert.equal(res.status, 200)
    assert.equal(cancelled, true, 'the abandoned response released its stream')
  } finally { globalThis.fetch = real }
})

test('A THROWN FETCH IS ASKED AGAIN — a reset is the most transient answer there is', async () => {
  const net = scripted([() => { throw new TypeError('connection reset') }, { status: 200, body: 'ok' }])
  try {
    const res = await askTwice('https://example.test/a')
    assert.equal(res.status, 200, 'a successful second ask wins over a remembered throw')
    assert.equal(net.calls.length, 2)
  } finally { net.restore() }
})

test('TWO THROWN FETCHES STILL THROW — fetch_fail must not be laundered into assert_fail', async () => {
  /**
   * worker.ts turns a thrown fetch into null / `fetch_fail`, a DIFFERENT signal from "the endpoint
   * answered un-parseably" (`assert_fail`), and the two are counted separately in
   * src/analytics.ts. Swallowing the throw would move a real outage into the wrong bucket and make it
   * look like an upstream shape change.
   */
  const net = scripted([() => { throw new TypeError('connection reset') }])
  try {
    await assert.rejects(() => askTwice('https://example.test/a'), /connection reset/)
    assert.equal(net.calls.length, 2, 'asked twice, then re-thrown — not swallowed')
  } finally { net.restore() }
})

test('EVERY PLATFORM FETCH EITHER RETRIES OR SAYS WHY NOT — derived from the source, not a hand list',
  () => {
    /**
     * THE TEST THAT KEEPS THIS FROM ROTTING, and it exists because CLAUDE.md records exactly this
     * failure once already: `parseRefKey`'s kind allowlist went stale, `fb:group:…` was unparseable
     * for weeks, every group-post image 404'd, and nothing failed loudly — because the coverage was a
     * hand-enumerated list in a test rather than something derived from the code.
     *
     * A retry wired into fifteen files by hand has the same shape of problem: the sixteenth platform
     * gets written, nobody remembers, and its cards quietly start dying to blips that every other
     * platform survives. So this reads the fetchers off disk and requires every raw `fetch(` in them
     * to be a DECISION — either routed through askTwice, or carrying a NO-RETRY comment that says
     * why. It cannot pass by being forgotten.
     */
    const dir = 'src/platforms'
    // EVERY .ts under src/platforms, not just the files named fetch.ts — a fetch that grows in a
    // normalize.ts or a helper is exactly the one nobody would think to check.
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.ts') ? [`${d}/${e.name}`] : [])
    const files = walk(dir)
    assert.ok(files.length >= 20, `expected the platform sources; found ${files.length}`)

    const unexplained = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\bawait fetch\(/.test(line)) return
        // A NO-RETRY marker anywhere in the preceding comment block is the exemption. Six lines is
        // enough for a paragraph explaining one, and short enough that it has to sit on the call.
        const near = lines.slice(Math.max(0, i - 6), i).join('\n')
        if (!/NO-RETRY/.test(near)) unexplained.push(`${file}:${i + 1}  ${line.trim()}`)
      })
    }
    assert.deepEqual(unexplained, [],
      'every upstream fetch must go through askTwice or carry a NO-RETRY comment saying why not')
  })
