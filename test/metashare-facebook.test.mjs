import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle } from '../src/worker.ts'

/**
 * "COULDN'T LOAD THIS THREADS POST" ON A FACEBOOK LINK — reported 2026-07-31 on
 * megapenispoopenfarten.sex/share/Fixture05X, pasted from facebook.com/share/Fixture05X.
 *
 * The owner's question was the right one: *"I thought the url was supposed to be unfurled first to
 * see if it was Facebook or threads?"* It is, and it was — the resolution FAILED, and the failure
 * branch then hardcoded `platform: 'th'`, turning "we could not find out" into a confident wrong
 * answer naming a platform the sharer never mentioned.
 *
 * WHY IT FAILED, measured the same day. The resolver disambiguates on a 302, and Facebook withholds
 * that redirect from Cloudflare's egress while Threads does not:
 *
 *   from a laptop            facebook.com/share/Fixture05X  302 -> /61557887564469/posts/1222…
 *   from the live worker     (no redirect)                  -> resolution returns null
 *   natural experiment       /share/Fixture08X (Threads)    resolved fine on prod the whole time
 *
 * So every unresolved code was blamed on Threads, which is exactly backwards: Threads is the one
 * that always worked. Two fixes, tested here: the failure names nothing it did not determine, and
 * `og:url` is read as a second signal when no Location comes back.
 */

const load = n => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')
// Real captured heads, 2026-07-31. Only the <head> is kept — it is all ogUrlOf reads, and Threads'
// full app shell is 258 KB of nothing.
const FB_OWNS = load('metashare-fb-owns.html')     // facebook.com/share/Fixture05X  -> og:url present
const TH_DISOWNS = load('metashare-th-disowns.html') // threads.com/share/Fixture05X -> og:url absent

const UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const env = { AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } }
const deps = over => ({
  cache: fakeCache(),
  fetchPost: async () => null,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
  ...over,
})
const req = p => new Request('https://mbedfx.app' + p, { headers: { 'user-agent': UA } })

test('AN UNRESOLVABLE SHARE CODE NAMES NO PLATFORM — it used to say Threads', async () => {
  /**
   * THE REPORTED CARD. A share code that resolves to nothing tells us nothing about who owns it, so
   * the card must not pick one. Naming Threads on a Facebook link is worse than saying nothing: it
   * sends the reader to check the wrong account.
   */
  const html = await (await handle(req('/share/Fixture05X'), env, ctx,
    deps({ resolveMetaShare: async () => null }))).text()
  assert.doesNotMatch(html, /Threads/i, 'the platform we did not determine must not be named')
  assert.doesNotMatch(html, /Facebook/i, 'nor the other one — we do not know')
  assert.match(html, /could not resolve this share link|couldn.t resolve/i, 'and it says what happened')
})

test('A RESOLVED CODE STILL NAMES THE RIGHT PLATFORM WHEN THE POST CANNOT BE FETCHED', async () => {
  // The other half: once the hop DID tell us, the failure card should say so. This is the case the
  // hardcoded 'th' was right about by accident, and it must survive the fix.
  const html = await (await handle(req('/share/Fixture08X'), env, ctx, deps({
    resolveMetaShare: async () => 'https://www.threads.com/@dexerto/post/DbWxxQjFe4u?xmt=AQG0',
    fetchPost: async () => null,
  }))).text()
  assert.match(html, /Threads/i, 'a resolved Threads code is still a Threads failure')
})

test('A RESOLVED FACEBOOK CODE IS A FACEBOOK FAILURE, not a Threads one', async () => {
  const html = await (await handle(req('/share/Fixture05X'), env, ctx, deps({
    resolveMetaShare: async () => 'https://www.facebook.com/reel/2209468366484962/?rdid=x',
    fetchPost: async () => null,
  }))).text()
  assert.match(html, /Facebook/i)
  assert.doesNotMatch(html, /Threads/i)
})

test('og:url IS THE SECOND SIGNAL — the owning host answers with one, the other does not', async () => {
  /**
   * Asserted against the REAL captured heads rather than a hand-written mock, because the whole claim
   * is about what Meta actually serves. Facebook's 200 carries og:url pointing at the permalink;
   * Threads' 258 KB app shell, served for a code it does not own, carries none.
   */
  const { resolveMetaShare } = await import('../src/platforms/metashare/fetch.ts')
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async u => {
    const url = String(u)
    seen.push(url)
    // Neither host redirects — the Cloudflare-egress case that broke this.
    if (url.includes('threads.com')) return new Response(TH_DISOWNS, { status: 200 })
    if (url.includes('facebook.com')) return new Response(FB_OWNS, { status: 200 })
    return real(u)
  }
  try {
    const loc = await resolveMetaShare('Fixture05X')
    assert.ok(loc, 'a 200 from the owning host must still resolve')
    assert.match(loc, /^https:\/\/www\.facebook\.com\//, 'and it must be Facebook, not Threads')
    assert.equal(seen.length, 2, 'Threads is asked first and disowns it, then Facebook answers')
  } finally { globalThis.fetch = real }
})

test('A NON-META og:url IS REFUSED — the code is attacker-supplied and this becomes a route() input', async () => {
  const { resolveMetaShare } = await import('../src/platforms/metashare/fetch.ts')
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(
    '<html><head><meta property="og:url" content="https://evil.example/pwn"></head>', { status: 200 })
  try {
    assert.equal(await resolveMetaShare('Fixture05X'), null, 'an off-Meta destination is not an answer')
  } finally { globalThis.fetch = real }
})

test('A HUGE BODY IS NOT READ — Threads answers 258 KB of app shell for codes it does not own', async () => {
  const { resolveMetaShare } = await import('../src/platforms/metashare/fetch.ts')
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('x'.repeat(300 * 1024), {
    status: 200, headers: { 'content-length': String(300 * 1024) },
  })
  try {
    assert.equal(await resolveMetaShare('Fixture05X'), null)
  } finally { globalThis.fetch = real }
})

/**
 * THE NAME LEAK, reported 2026-07-31 by the person it names.
 *
 * Following facebook.com/share/Fixture05X lands on a page headed "see what Alex Fixture shared". The
 * Location we were forwarding a human to carried the share link back in plaintext:
 *
 *     ?rdid=rdidFixtureXXXXX&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F18pJs2hmTD%2F
 *
 * A share code is minted per SHARING ACT, so that is a handle on WHO shared -- real name and profile
 * -- handed to the destination by someone who swapped our host in precisely to avoid that.
 */
import { stripMetaTracking, metaPlatformOf } from '../src/platforms/metashare/fetch.ts'

test('A HUMAN IS NEVER FORWARDED THE SHARE TOKEN', async () => {
  const raw = 'https://www.facebook.com/61557887564469/posts/122245445522262918/'
    + '?rdid=rdidFixtureXXXXX&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F18pJs2hmTD%2F'
  const res = await handle(
    new Request('https://mbedfx.app/share/Fixture05X', {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' },
    }),
    env, ctx, deps({ resolveMetaShare: async () => raw }),
  )
  assert.equal(res.status, 302)
  const to = res.headers.get('location')
  assert.equal(to, 'https://www.facebook.com/61557887564469/posts/122245445522262918/',
    'the permalink, and nothing else')
  for (const leak of ['share_url', 'rdid', 'Fixture05X']) {
    assert.ok(!to.includes(leak), `${leak} must not reach the destination`)
  }
})

test('STRIPPING KEEPS THE IDS THAT ARE THE POST — an allowlist, since 2026-08-01', () => {
  // Facebook carries real ids in the query on shapes we must not break. Dropping the whole query
  // would break the post instead of cleaning it, which is why this is not simply `u.search = ''`.
  assert.equal(stripMetaTracking('https://www.facebook.com/watch?v=10153231379946729&rdid=x'),
    'https://www.facebook.com/watch?v=10153231379946729')
  assert.equal(
    stripMetaTracking('https://www.facebook.com/story.php?story_fbid=122245445522262918&id=61557887564469&mibextid=zz'),
    'https://www.facebook.com/story.php?story_fbid=122245445522262918&id=61557887564469',
    'the owner\'s own resolved form keeps both ids')
  // A url whose entire query was tracking keeps no dangling '?'.
  assert.equal(stripMetaTracking('https://www.threads.com/@dexerto/post/DbWxxQjFe4u?xmt=AQG0&slof=1'),
    'https://www.threads.com/@dexerto/post/DbWxxQjFe4u')
  // Unparseable input is returned untouched rather than half-rewritten.
  assert.equal(stripMetaTracking('not a url'), 'not a url')
})

test('THE REPORTED THREADS LINK — the leak a denylist could not have caught', () => {
  /**
   * REPORTED 2026-08-01. threads.com/share/Fixture09X resolved to a permalink carrying
   *
   *     ?hwta=1&http_ref=eyJ0cyI6MTc4NTU0OTA4MDAwMCwiciI6IiJ9
   *
   * and BOTH SURVIVED, because neither name was on the denylist this function used to consult.
   * `http_ref` is base64 JSON — {"ts":1785549080000,"r":""} — a per-click timestamp.
   *
   * This is the second dirty-link report against a function whose whole job is cleaning them, which
   * is the argument the code now makes: a denylist enumerates a set only Meta can change, so every
   * addition is invisible until somebody notices a dirty url in their address bar.
   */
  const got = stripMetaTracking(
    'https://www.threads.com/@_soul_solace_/post/DbcSwYaEa9r?hwta=1&http_ref=eyJ0cyI6MTc4NTU0OTA4MDAwMCwiciI6IiJ9')
  assert.equal(got, 'https://www.threads.com/@_soul_solace_/post/DbcSwYaEa9r')
  for (const leak of ['hwta', 'http_ref', 'eyJ0cyI']) {
    assert.ok(!got.includes(leak), `${leak} must not reach the destination`)
  }
})

test('AN UNKNOWN PARAMETER IS DROPPED BY DEFAULT — the point of the flip', () => {
  /**
   * The property the denylist could never have: a parameter nobody has seen before does not need to
   * be enumerated to be removed. Meta mints these continuously; this test stands in for the ones that
   * do not exist yet.
   */
  assert.equal(
    stripMetaTracking('https://www.threads.com/@a/post/B?utterly_new_2027=1&another_one=xyz'),
    'https://www.threads.com/@a/post/B')
  // And a STRUCTURAL id still survives beside an unknown one — the allowlist is not a blanket wipe.
  assert.equal(
    stripMetaTracking('https://www.facebook.com/watch?v=123&brand_new_tracker=zzz'),
    'https://www.facebook.com/watch?v=123')
})

test('THE FAILURE CARD NAMES THE HOST THE HOP ESTABLISHED, not "Not found"', async () => {
  /**
   * The regression my first fix caused. Asking route() for a post ref and falling back to null
   * renders the plain red "Not found" -- which means "this is not a link we handle", and is false:
   * it IS a Facebook post, at a permalink shape we do not route. The host is what the hop proved.
   */
  const html = await (await handle(req('/share/Fixture05X'), env, ctx, deps({
    resolveMetaShare: async () => 'https://www.facebook.com/61557887564469/posts/122245445522262918/?rdid=x',
  }))).text()
  assert.match(html, /Facebook/i, 'the resolved host is named')
  assert.doesNotMatch(html, /Not found/i, '"not a link we handle" is the wrong thing to say')
  assert.doesNotMatch(html, /rdid|share_url/, 'and the canonical on the card is clean too')
})

test('metaPlatformOf reads the host, and refuses anything else', () => {
  assert.equal(metaPlatformOf('https://www.facebook.com/x'), 'fb')
  assert.equal(metaPlatformOf('https://www.threads.com/x'), 'th')
  assert.equal(metaPlatformOf('https://threads.net/x'), 'th')
  assert.equal(metaPlatformOf('https://evil.example/x'), null)
  assert.equal(metaPlatformOf('https://facebook.com.evil.example/x'), null, 'suffix tricks refused')
  assert.equal(metaPlatformOf('nonsense'), null)
})
