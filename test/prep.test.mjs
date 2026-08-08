import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'
import { route } from '../src/router.ts'
import { readFileSync } from 'node:fs'

/**
 * /_prep — THE FIXER PAGE GETTING READY. Requested 2026-07-31: "if someone puts in a video which
 * would be going through yt-dlp then when they submit the link it kicks off the download/mux in the
 * background", plus the earlier ask to unfurl a share url "to the full thing instead of just
 * replacing the url".
 *
 * WHY AN ENDPOINT MAY DO REAL WORK, which is the thing to re-read before widening it. Everything
 * /_prep does is what a Discordbot GET of the same url already does seconds later, reachable by
 * anyone who sets a User-Agent: the same fetch, the same container dispatch, behind the same
 * SPECULATIVE_MUX_CAP and the same muxOnce dedupe. It buys LATENCY, NOT PERMISSION. If a change ever
 * makes that sentence false, the endpoint has become an amplifier and needs its own gate.
 *
 * The prewarm the worker already had is gated on the post cache holding the ref — deliberately, so a
 * never-fetched id cannot boot a container. That gate makes it USELESS for the case here, which is a
 * link nobody has fetched yet, so this path runs the full render and discards it.
 */

const ctx = () => {
  const pending = []
  return { ctx: { waitUntil(p) { pending.push(p) } }, settle: () => Promise.allSettled(pending) }
}
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
const fakeR2 = () => {
  const store = new Map()
  return {
    store,
    async head(k) { const v = store.get(k); return v ? { size: v.length } : null },
    async get(k) { const v = store.get(k); return v ? { body: new Response(v).body, size: v.length, uploaded: new Date() } : null },
    // MUST CONSUME THE BODY. muxOnce streams the container's response into R2, so a put that stores
    // the ReadableStream without draining it leaves the pipe open forever and the test hangs.
    async put(k, body) {
      const bytes = typeof body === 'string' ? body : new Uint8Array(await new Response(body).arrayBuffer())
      store.set(k, bytes)
    },
  }
}

/** Records every container call so a test can prove work did or did not start. */
function fakeResolver() {
  const seen = { meta: 0, mux: 0, pages: [] }
  return {
    seen,
    binding: {
      getByName() {
        return {
          async fetch(_u, init) {
            const body = JSON.parse(init.body)
            if (body.page) seen.pages.push(body.page)
            if (body.meta === true) { seen.meta++; return Response.json({ title: 'a video', width: 1, height: 1 }) }
            seen.mux++
            return new Response('MP4', { headers: { 'content-type': 'video/mp4', 'content-length': '3' } })
          },
        }
      },
    },
  }
}

const envWith = binding => ({
  AE: { writeDataPoint() {} },
  ASSETS: { async fetch() { return new Response('a') } },
  MEDIA_RESOLVER: binding,
  MEDIA_CACHE: fakeR2(),
})
/**
 * A STUBBED fetchPost, because these tests must reach no network. It mints a post whose media matches
 * what the ref implies — a remux video for the platforms prewarmable() names, a plain image otherwise
 * — which is the only property the prep path actually reads.
 */
const REMUX = new Set(['yt', 'fb', 'dm', 'st', 'im'])
const stubFetchPost = async ref => ({
  ref,
  canonical: 'https://example.invalid/post',
  author: { name: 'n', handle: 'h', url: 'https://example.invalid' },
  text: '',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  counts: {},
  sensitive: false,
  media: REMUX.has(ref.p)
    ? [{ kind: 'video', url: 'https://example.invalid/v', w: 0, h: 0, poster: 'https://example.invalid/p.jpg', remux: { page: `https://example.invalid/page/${ref.id ?? ref.code ?? 'x'}` } }]
    : [{ kind: 'image', url: 'https://example.invalid/i.jpg', w: 10, h: 10 }],
})

const deps = over => ({
  cache: fakeCache(),
  fetchPost: stubFetchPost,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
  resolveMetaShare: async () => null,
  ...over,
})
const prep = p => new Request('https://mbedfx.app/_prep?p=' + encodeURIComponent(p))

test('THE ROUTER RECOGNISES /_prep, and refuses it with no target', () => {
  assert.deepEqual(route(new URL('https://mbedfx.app/_prep?p=/jack/status/20')),
    { kind: 'prep', target: '/jack/status/20' })
  assert.equal(route(new URL('https://mbedfx.app/_prep')).kind, 'notfound')
  assert.equal(route(new URL('https://mbedfx.app/_prep?p=')).kind, 'notfound')
})

test('IT ANSWERS WITH THE CANONICAL, ON OUR OWN ORIGIN', async () => {
  const { ctx: c } = ctx()
  const j = await (await handle(prep('/jack/status/20'), envWith(fakeResolver().binding), c, deps())).json()
  assert.equal(j.ok, true)
  assert.equal(j.platform, 'x')
  assert.equal(j.url, 'https://mbedfx.app/jack/status/20', 'the link the page should show')
  assert.equal(j.canonical, 'https://x.com/jack/status/20')
})

test('A VIDEO STARTS ITS MUX — the whole point of the request', async () => {
  /**
   * The reported problem: the FIRST paste of a cold video degrades to a still, because the mux only
   * starts when Discord arrives. The page knows a link is about to be shared, so the download starts
   * then instead.
   */
  const { seen, binding } = fakeResolver()
  const { ctx: c, settle } = ctx()
  const j = await (await handle(prep('/watch?v=dQw4w9WgXcQ'), envWith(binding), c, deps())).json()
  assert.equal(j.warming, true, 'the page is told, so it can explain the wait')
  await settle()
  assert.ok(seen.mux >= 1, 'the container was actually asked for the video')
  assert.ok(seen.pages.some(p => p.includes('dQw4w9WgXcQ')), 'and for the right one')
})

test('A PLATFORM WITH NO MUX COSTS NO CONTAINER CALL AT ALL', async () => {
  /**
   * A page that fired a full render at every pasted link would spend an upstream fetch on every
   * debounced keystroke for platforms that have no video path. prewarmable() is the existing answer
   * to "does this ref imply a mux", reused rather than re-spelled.
   */
  const { seen, binding } = fakeResolver()
  const { ctx: c, settle } = ctx()
  const j = await (await handle(prep('/pin/66287425756772418'), envWith(binding), c, deps())).json()
  assert.equal(j.ok, true)
  assert.equal(j.warming, false, 'nothing to warm')
  await settle()
  assert.equal(seen.mux, 0, 'and nothing was warmed')
  assert.equal(seen.meta, 0)
})

test('A SHARE CODE IS RESOLVED TO THE REAL POST — "the full thing, not just the url"', async () => {
  const { ctx: c } = ctx()
  const j = await (await handle(prep('/share/Fixture03X'), envWith(fakeResolver().binding), c, deps({
    resolveMetaShare: async () => 'https://www.threads.com/@dexerto/post/DbWxxQjFe4u?xmt=AQG0&slof=1',
  }))).json()
  assert.equal(j.ok, true)
  assert.equal(j.platform, 'th')
  assert.equal(j.url, 'https://mbedfx.app/@dexerto/post/DbWxxQjFe4u', 'the permalink, not the share code')
  for (const junk of ['xmt', 'slof', 'Fixture03X']) {
    assert.ok(!j.url.includes(junk) && !j.canonical.includes(junk), `${junk} must not survive`)
  }
})

test('AN UNRESOLVABLE SHARE CODE IS AN HONEST no, not a guess', async () => {
  const { ctx: c } = ctx()
  const j = await (await handle(prep('/share/Fixture03X'), envWith(fakeResolver().binding), c,
    deps({ resolveMetaShare: async () => null }))).json()
  assert.equal(j.ok, false)
  assert.equal(j.reason, 'metashare', 'it stayed an unresolved share code')
})

test('JUNK AND NON-POSTS ARE REFUSED WITHOUT SIDE EFFECTS', async () => {
  const { seen, binding } = fakeResolver()
  const { ctx: c, settle } = ctx()
  for (const target of ['/', '/mrbeast', '/definitely/not/a/post', '/gallery/YcAQlkx', 'not a path', '']) {
    const res = await handle(prep(target), envWith(binding), c, deps())
    const j = await res.json().catch(() => null)
    if (j) assert.equal(j.ok, false, `${JSON.stringify(target)} must not claim success`)
  }
  await settle()
  assert.equal(seen.mux, 0, 'nothing unroutable may reach the container')
  assert.equal(seen.meta, 0)
})

test('IT CANNOT BE NESTED INTO ITSELF', async () => {
  // /_prep?p=/_prep?p=… must not recurse. The inner route is 'prep', which is not a post.
  const { ctx: c } = ctx()
  const j = await (await handle(prep('/_prep?p=/watch?v=dQw4w9WgXcQ'), envWith(fakeResolver().binding), c, deps())).json()
  assert.equal(j.ok, false)
  assert.equal(j.reason, 'prep', 'one level, and it stops there')
})

test('AN ABSOLUTE TARGET CANNOT POINT AT ANOTHER ORIGIN', async () => {
  /**
   * THE SECURITY PIN. `p` is attacker-supplied and is turned into a URL. Resolving it against our own
   * origin is what keeps it a PATH — a target that names another host must not become a fetch we
   * make on someone's behalf, and must not have its host echoed back as though it were ours.
   */
  const { seen, binding } = fakeResolver()
  const { ctx: c, settle } = ctx()
  for (const target of [
    'https://evil.example/watch?v=dQw4w9WgXcQ',
    '//evil.example/watch?v=dQw4w9WgXcQ',
    'http://evil.example/jack/status/20',
  ]) {
    const res = await handle(prep(target), envWith(binding), c, deps())
    const j = await res.json().catch(() => null)
    if (j && j.ok) {
      assert.ok(j.url.startsWith('https://mbedfx.app/'), `${target} leaked an origin: ${j.url}`)
      assert.ok(!j.canonical.includes('evil.example'), `${target} leaked into canonical`)
    }
  }
  await settle()
  assert.ok(!seen.pages.some(p => p.includes('evil.example')), 'no upstream fetch at an attacker host')
})

test('THE SAME LINK TWICE IS ONE MUX — muxOnce already dedupes, and the page also remembers', async () => {
  const { seen, binding } = fakeResolver()
  const { ctx: c, settle } = ctx()
  const env = envWith(binding)
  const d = deps()
  await handle(prep('/watch?v=dQw4w9WgXcQ'), env, c, d)
  await handle(prep('/watch?v=dQw4w9WgXcQ'), env, c, d)
  await settle()
  assert.ok(seen.mux <= 1, `a repeated prep must not re-download, got ${seen.mux}`)
})

test('THE PAGE DEBOUNCES AND DOES NOT REPEAT ITSELF', () => {
  // Pinned in the page rather than the worker: this is what stops a fetch per keystroke.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(html, /setTimeout\(function \(\) \{ prep\(r\.url\); \}, 600\)/, 'debounced, not per keystroke')
  assert.match(html, /if \(prepped\[path\]\) return;/, 'and each link is prepped at most once')
  assert.match(html, /'\/_prep\?p=' \+ encodeURIComponent\(path\)/, 'the target is encoded')
})

test('AN AMBIGUOUS PATH HANDS BACK THE ROUTER\'S OWN CANDIDATES', () => {
  /**
   * The picker on the fixer page is only honest if its options come from route() rather than from
   * anything the page guesses — only the router knows /gallery/{id} is contested between Reddit,
   * Instagram and Imgur, and that Imgur joined that row when albums shipped.
   */
  return (async () => {
    const { ctx: c } = ctx()
    const j = await (await handle(prep('/gallery/YcAQlkx'), envWith(fakeResolver().binding), c, deps())).json()
    assert.equal(j.ok, false)
    assert.equal(j.reason, 'ambiguous')
    assert.deepEqual(j.candidates.map(x => x.platform), ['rd', 'ig', 'im'])
    assert.deepEqual(j.candidates.map(x => x.name), ['Reddit', 'Instagram', 'Imgur'],
      'named for a human, not by code')
    for (const cand of j.candidates) {
      assert.equal(cand.url, `https://mbedfx.app/${cand.platform}/gallery/YcAQlkx`,
        'and each option is the forced url, built from router vocabulary')
    }
  })()
})

/* ===================== /_card — the fixer page's preview ==========================
 *
 * WHY THE ENDPOINT EXISTS AT ALL. A browser fetching the converted url is classified `human` and
 * 302s to the platform; there is no user-agent a page can set from script, so the fields Discord
 * reads are simply not reachable from the client. /_card renders as Discord and describes the post.
 *
 * WHAT THESE PIN. That it describes the POST rather than one seam's markup — the preview must be
 * right for a card with media (which Discord draws from the Mastodon spoof) and one without (which
 * it draws from the og head), and parsing either document would have been right for only one.
 */

const card = p => new Request('https://mbedfx.app/_card?p=' + encodeURIComponent(p))

test('THE ROUTER RECOGNISES /_card, and refuses it with no target', () => {
  assert.deepEqual(route(new URL('https://mbedfx.app/_card?p=/jack/status/20')),
    { kind: 'card', target: '/jack/status/20' })
  assert.equal(route(new URL('https://mbedfx.app/_card')).kind, 'notfound')
  assert.equal(route(new URL('https://mbedfx.app/_card?p=')).kind, 'notfound')
})

test('IT DESCRIBES THE POST — author, text, counts, canonical', async () => {
  const { ctx: c } = ctx()
  const j = await (await handle(card('/jack/status/20'), envWith(fakeResolver().binding), c, deps())).json()
  assert.equal(j.ok, true)
  assert.equal(j.platform, 'x')
  /**
   * THE POST'S CANONICAL, NOT THE ROUTER'S — the stub's placeholder is what makes the difference
   * visible, and the difference is deliberate. The router's canonical is derived from the url that
   * was pasted; the post's is what normalize resolved it to, and it is what the CARD links to. They
   * agree for a plain permalink and diverge for anything that resolved (a share code, a shortlink),
   * which is exactly the case the preview exists to show.
   */
  assert.equal(j.canonical, 'https://example.invalid/post')
  assert.equal(typeof j.author.name, 'string')
  // The line Discord draws, named for what it is — see the worker's card arm.
  assert.equal(typeof j.author.byline, 'string')
  assert.equal(typeof j.text, 'string')
  assert.ok(j.counts && typeof j.counts === 'object')
  assert.ok(Array.isArray(j.media))
})

test('MEDIA IS ADDRESSED THROUGH OUR OWN ORIGIN, never the platform cdn', async () => {
  /**
   * The same rule every renderer follows: a platform media url is short-lived and often
   * hotlink-blocked, so the card points at /_media/{refKey}/{i} and we serve the bytes. A preview
   * that used the raw upstream url would look right today and break exactly when the real card does
   * not — which would make it worse than no preview at all.
   */
  const { ctx: c } = ctx()
  const j = await (await handle(card('/jack/status/20'), envWith(fakeResolver().binding), c, deps())).json()
  for (const m of j.media) {
    assert.ok(m.url.startsWith('https://mbedfx.app/_media/'), `${m.url} must be ours`)
    assert.ok(m.kind === 'image' || m.kind === 'video', 'every entry is one or the other')
  }
})

test('IT REPORTS THE STRIPE COLOUR, which Discord really does honour', async () => {
  /**
   * THIS TEST USED TO ASSERT THE OPPOSITE, and the opposite was wrong. It pinned a `colorHonoured`
   * flag on the theory that a card with media takes the Mastodon spoof and the spoof carries no
   * colour — inferred from one reel rendering in Discord's default.
   *
   * The spoof was never involved: the head spelled the tag `property="theme-color"`, which Discord
   * does not read, so it found no colour at all. Established by comparing live heads against the
   * fixers that DO get coloured stripes, and settled by lgb45 — an fxtwitter fork that ships BOTH
   * spellings with different values on one head, and renders the name= one. See discord.ts.
   *
   * Kept as a test rather than deleted because the field is still worth pinning, and because a
   * removed assertion leaves no trace of having been wrong.
   */
  const { ctx: c } = ctx()
  const j = await (await handle(card('/jack/status/20'), envWith(fakeResolver().binding), c, deps())).json()
  assert.equal(typeof j.color, 'string')
  assert.match(j.color, /^#[0-9a-f]{6}$/i)
})

test('AN UNROUTABLE TARGET IS A REASON, NOT A CARD', async () => {
  const { ctx: c } = ctx()
  for (const [target, reason] of [['/_card?p=/x', 'card'], ['/', 'site']]) {
    const j = await (await handle(card(target), envWith(fakeResolver().binding), c, deps())).json()
    assert.equal(j.ok, false)
    assert.equal(j.reason, reason, `${target} reports what it actually is`)
  }
})

test('A TYPED FACEBOOK SHARE IS UNFURLED — the link shown is the real permalink', async () => {
  /**
   * REPORTED 2026-08-01: "it's also not unfurling the url as I'd expect". /share/p/{code} routes
   * straight to a post ref, so prep answered with the share url itself — and with the WRONG LETTER,
   * because fbCanonical rebuilds every typed share as /share/v/. A reader who pasted a `p` link was
   * shown a `v` link they never asked for.
   */
  const { ctx: c } = ctx()
  const resolved = 'https://www.facebook.com/100071151613394/posts/1092409469807430/?rdid=junk'
  const d = deps({ resolveMetaShare: async () => resolved })
  const j = await (await handle(prep('/share/p/Fixture04X'), envWith(fakeResolver().binding), c, d)).json()
  assert.equal(j.ok, true)
  assert.equal(j.canonical, 'https://www.facebook.com/100071151613394/posts/1092409469807430/',
    'the real permalink, with the tracking stripped')
  assert.ok(!j.url.includes('/share/'), 'and never the share code the reader pasted')
})

test('A SHARE THAT WILL NOT RESOLVE STILL ANSWERS — the unfurl is enrichment', async () => {
  // A resolution miss must cost the page nothing: it still gets a usable link, exactly as before.
  const { ctx: c } = ctx()
  const d = deps({ resolveMetaShare: async () => null })
  const j = await (await handle(prep('/share/p/Fixture04X'), envWith(fakeResolver().binding), c, d)).json()
  assert.equal(j.ok, true)
  assert.equal(j.platform, 'fb')
  assert.ok(j.url, 'a link is still offered')
})

/* ===================== SHORT LINKS ON THE PAGE'S OWN ENDPOINTS =====================
 *
 * REPORTED 2026-08-01: tiktok.com/t/ZTAxTF9aD showed "unresolved" on the fixer page
 * while the SAME link rendered a correct card in Discord. Both were true, and that is
 * the bug — the page refused to preview a link that works perfectly when pasted, which
 * is worse than a broken link because it talks the reader out of a good one.
 *
 * These two arms learned to unfurl 'metashare' and never learned 'shortlink'.
 */

const shortResolved = {
  kind: 'post',
  post: { canonical: 'https://www.tiktok.com/@fatboiitit/video/7650584217042144526' },
}

test('/_prep RESOLVES A SHORT LINK — it must not answer "unresolved" for a link that works', async () => {
  const { ctx: c } = ctx()
  const d = deps({ resolveShortlink: async () => shortResolved })
  const j = await (await handle(prep('/t/ZTAxTF9aD'), envWith(fakeResolver().binding), c, d)).json()
  assert.equal(j.ok, true, 'the page gets a usable answer')
  assert.equal(j.platform, 'tt')
  assert.equal(j.canonical, 'https://www.tiktok.com/@fatboiitit/video/7650584217042144526')
  assert.ok(!j.url.includes('/t/'), 'and the share code is gone from what it shows')
})

test('/_card RESOLVES A SHORT LINK, so the preview draws the real post', async () => {
  const { ctx: c } = ctx()
  const d = deps({ resolveShortlink: async () => shortResolved })
  const j = await (await handle(card('/t/ZTAxTF9aD'), envWith(fakeResolver().binding), c, d)).json()
  assert.equal(j.ok, true)
  assert.equal(j.platform, 'tt')
})

test('A SHORT LINK THAT WILL NOT RESOLVE DEGRADES, it does not throw', async () => {
  // A miss must leave the answer exactly as it was before this path existed.
  const { ctx: c } = ctx()
  for (const stub of [
    async () => ({ kind: 'unresolved' }),
    async () => null,
    async () => { throw new TypeError('upstream blew up') },
  ]) {
    const j = await (await handle(prep('/t/ZTAxTF9aD'), envWith(fakeResolver().binding), c, deps({ resolveShortlink: stub }))).json()
    assert.equal(j.ok, false)
    assert.equal(j.reason, 'shortlink', 'honest about what it could not do')
  }
})

test('/_card SENDS THE RENDERER\'S OWN STAT LINE, so the preview cannot drift from the card', async () => {
  /**
   * REPORTED 2026-08-01 with a side-by-side screenshot. The real card reads
   * "❤️ 204.5K  💬 1.3K  🔁 69.2K"; the preview read "❤️ 204.5K  🔁 69.2K  💬 1.3K". The page had
   * invented its own ORDER, and its own ABBREVIATION — toFixed rounds, abbrev truncates, so 999,950
   * renders "1000K" one way and "999.9K" the other.
   *
   * One mistake, twice: a preview that re-implements a renderer drifts from it. statParts is now the
   * single source, and this asserts the endpoint actually sends it rather than the raw numbers.
   */
  const { ctx: c } = ctx()
  const j = await (await handle(card('/jack/status/20'), envWith(fakeResolver().binding), c, deps())).json()
  assert.ok(Array.isArray(j.stats), 'pre-formatted parts, not counts for the page to re-assemble')
  if (j.stats.length) {
    // The order is the renderer's: likes, then replies, then reposts.
    const emoji = j.stats.map(x => Array.from(x)[0])
    const rank = { '❤': 0, '💬': 1, '🔁': 2 }
    const seen = emoji.map(e => rank[e]).filter(n => n !== undefined)
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'likes, replies, reposts — the card order')
  }
})

test('/_card CARRIES THE QUOTED POST — a quote-tweet previewed as a different card without it', async () => {
  /**
   * REPORTED 2026-08-01 with a side-by-side. Discord drew "Quoting <name> (@handle)" and the quoted
   * text as an indented block; the preview showed the outer post alone. A quote-tweet therefore
   * previewed as a substantially emptier card than the one that would actually be posted — which is
   * the one thing a preview must never do.
   *
   * The byline is sent PRE-FORMATTED, by the same byline() the card's own quote header uses, so the
   * two surfaces cannot disagree about how an author is written. That drift is exactly what produced
   * the wrong stat order in the same report.
   */
  const { ctx: c } = ctx()
  const j = await (await handle(card('/jack/status/20'), envWith(fakeResolver().binding), c, deps())).json()
  assert.ok('quote' in j, 'the field is always present, null when there is no quote')
  if (j.quote) {
    assert.equal(typeof j.quote.byline, 'string')
    assert.equal(typeof j.quote.text, 'string')
    assert.ok(!/<[a-z]/i.test(j.quote.byline), 'pre-formatted text, never markup for the page to trust')
  }
})

/* ===================== THE PREVIEW'S OWN DATE =====================
 *
 * REPORTED 2026-08-02: "the website seems to always say no upload date".
 *
 * It did, and the word ALWAYS is the whole diagnosis. /_card read the yt meta record out of R2 and
 * never dispatched an extract, on a rule written here as "a cache read, NEVER a container call".
 * But the record is warmed by the ACTIVITY route — by Discord unfurling the link — so it is cold for
 * precisely the links a person previews: the ones they have not sent yet. Every fresh YouTube link
 * previewed as createdAt 1970, drew the page's "⚠ no upload date" flag, and then rendered a correct
 * date the instant it was pasted into Discord.
 *
 * The self-heal that hid this everywhere else cannot fire here, because on this page EVERY view is a
 * first view. That is why it read as always broken rather than as an occasional cold-cache miss.
 *
 * The cost objection that motivated the old rule does not survive being stated: the visitor
 * previewing this link is about to paste it into Discord, which dispatches the identical
 * `yt-dlp -J`. Warming here does not ADD a container call, it moves the one already coming.
 */
test('/_card WARMS THE YOUTUBE META, so a link nobody has sent yet still previews with its real date', async () => {
  const { ctx: c } = ctx()
  let meta = 0
  const binding = {
    getByName() {
      return {
        async fetch(_u, init) {
          const body = JSON.parse(init.body)
          if (body.meta !== true) {
            return new Response('MP4', { headers: { 'content-type': 'video/mp4', 'content-length': '3' } })
          }
          meta++
          // Epoch SECONDS, as the container's dict carries it. 1256453853 -> 2009-10-25T06:57:33Z,
          // captured from a real `yt-dlp -J` run.
          return Response.json({ title: 'a video', width: 1, height: 1, timestamp: 1256453853 })
        },
      }
    },
  }
  // new Date(0) is the state every fresh paste is in: a post built before anything knew its date.
  // uploadDateFrom rejects the epoch as below the 2005 floor, so this is "unknown", not "1970".
  const cold = async ref => ({ ...(await stubFetchPost(ref)), createdAt: new Date(0) })
  const j = await (await handle(card('/watch?v=dQw4w9WgXcQ'), envWith(binding), c, deps({ fetchPost: cold }))).json()

  assert.equal(j.ok, true)
  assert.equal(meta, 1, 'the preview dispatched the extract instead of reading an empty cache and giving up')
  assert.equal(j.createdAt, '2009-10-25T06:57:33.000Z', 'and it reports the real upload date, not the epoch')
})

test('IT DOES NOT DISPATCH WHEN THE DATE IS ALREADY KNOWN — the gate that keeps this from costing a call per view', async () => {
  // The counterpart to the test above, and the reason that one is not simply "always call the
  // container". A post that already carries a real date was built from a warm record, so there is
  // nothing to fetch; without this gate every preview of every ordinary video would pay an extract.
  const { ctx: c } = ctx()
  const { seen, binding } = fakeResolver()
  const j = await (await handle(card('/watch?v=dQw4w9WgXcQ'), envWith(binding), c, deps())).json()
  assert.equal(j.ok, true)
  assert.equal(seen.meta, 0, 'no extract for a post whose date is already known')
  assert.equal(j.createdAt, '2026-07-01T00:00:00.000Z', 'and the known date survives untouched')
})

/* ===================== THE d. DIRECT-MEDIA HOST =====================
 *
 * Requested 2026-08-02: "the d. subdomain showing just the media like fxTikTok does". A d.-prefixed
 * serving domain answers with the post's BYTES rather than a card.
 */

const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const dReq = (p, host = 'd.mbedfx.app') =>
  new Request(`https://${host}${p}`, { headers: { 'user-agent': DISCORD_UA } })

test('THE d. HOST REDIRECTS TO THE POST\'S OWN MEDIA, not to a card', async () => {
  const { ctx: c } = ctx()
  const res = await handle(dReq('/jack/status/20'), envWith(fakeResolver().binding), c, deps())
  assert.equal(res.status, 302, 'bytes, via the route that already owns byte-range serving')
  const loc = res.headers.get('location')
  assert.match(loc, /\/_media\//, 'it hands off to /_media/ rather than proxying a second way')
  // The redirect STAYS on d., so a reader who lands there is not bounced to the apex mid-download.
  assert.match(loc, /^https:\/\/d\.mbedfx\.app\//, `stays on the d. host, got ${loc}`)
})

test('THE d. HOST SERVES A HUMAN THE SAME BYTES — the one route with no human/bot split', async () => {
  /**
   * Everywhere else a human is redirected to the original post, because a card is for a crawler. Here
   * the bytes ARE the product: someone pasting a d. link wants the file, not the post they already
   * had. Pinned because "humans get redirected to canonical" is the pattern every other arm follows,
   * and a well-meaning refactor would happily add it here.
   */
  const { ctx: c } = ctx()
  const human = new Request('https://d.mbedfx.app/jack/status/20', {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
  })
  const res = await handle(human, envWith(fakeResolver().binding), c, deps())
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location'), /\/_media\//,
    'a person gets the media too, not a bounce to x.com')
})

test('route() STAYS HOST-AGNOSTIC — the d. decision is about the RESPONSE, never the ROUTE', () => {
  /**
   * This is the invariant the feature was built around rather than through. route() reads pathname
   * and query and nothing else, which is why /dm/, /st/ and /im/ forcing can exist: dai.ly,
   * streamable.com and imgur.com all collapse onto one undecidable bare /{id}, and forcing is the
   * reader saying which they meant. If the host could change routing, every one of those decisions
   * would need re-measuring per domain.
   *
   * So: the same path must route identically under every host, and the d. host chooses only what
   * shape of RESPONSE comes back.
   */
  for (const p of ['/jack/status/20', '/watch?v=dQw4w9WgXcQ', '/reel/DX7byl-oyGR/', '/dm/xaqwy7q', '/_prep?p=/x']) {
    const apex = route(new URL(`https://mbedfx.app${p}`))
    const direct = route(new URL(`https://d.mbedfx.app${p}`))
    assert.deepEqual(direct, apex, `${p} must route identically under d.`)
  }
})

test('A d. LINK WITH NOTHING TO SERVE ANSWERS PLAIN TEXT, never an HTML card', async () => {
  /**
   * This host promises bytes. Answering a failure with an embed hands a media player a document, and
   * `curl -O` a page of markup saved under a video's name. The status has to be a real 404 too — a
   * 200 with an apology is how a downloader ends up with a "video" that will not open.
   */
  const { ctx: c } = ctx()
  const d2 = deps({ fetchPost: async () => null })
  const res = await handle(dReq('/jack/status/20'), envWith(fakeResolver().binding), c, d2)
  assert.equal(res.status, 404)
  assert.match(res.headers.get('content-type'), /text\/plain/)
  assert.equal(res.headers.get('cache-control'), 'no-store', 'a failure must not be pinned in cache')
  assert.ok(!(await res.text()).includes('<meta'), 'no markup')
})

test('ONLY A d. PREFIX COUNTS — a host merely containing "d." is the ordinary card host', async () => {
  // Anchored so staging.mbedfx.app, and any future host with a d-containing label, keep rendering
  // cards. A substring test here would silently turn a normal domain into a file server.
  const { ctx: c } = ctx()
  for (const host of ['mbedfx.app', 'staging.mbedfx.app', 'old.mbedfx.app']) {
    const res = await handle(dReq('/jack/status/20', host), envWith(fakeResolver().binding), c, deps())
    assert.equal(res.status, 200, `${host} still renders a card`)
    assert.match(res.headers.get('content-type') || '', /text\/html/, `${host} is HTML`)
  }
})

test('THE d. HOST WORKS ON A SHARE LINK TOO, not only a pasted permalink', async () => {
  /**
   * Reported 2026-08-03: d.megapenispoopenfarten.sex/r/linuxmemes/s/VRg1iSFn4k "does nothing
   * different from the version without d.". Exactly right, and the reason was that the host check
   * was wired into the `post` route only. A Reddit /r/{sub}/s/{code} is a DIFFERENT route kind — it
   * resolves a share token to a permalink first — as are Meta /share/ codes and every shortlink, so
   * three of the four ways to reach a post ignored the host entirely.
   *
   * The check now lives in renderPostRoute, where all of them converge once a ref is known, so a
   * future route that resolves to a post inherits it rather than having to remember.
   */
  const { ctx: c } = ctx()
  const resolved = { ref: { p: 'rd', kind: 'comments', id: 'abc123' }, canonical: 'https://www.reddit.com/r/linuxmemes/comments/abc123/x/' }
  const res = await handle(
    dReq('/r/linuxmemes/s/VRg1iSFn4k'),
    envWith(fakeResolver().binding), c,
    deps({ resolveRedditShare: async () => resolved }),
  )
  assert.equal(res.status, 302, 'a share link on d. serves bytes, not a card')
  assert.match(res.headers.get('location'), /\/_media\//)
})

test('A HUMAN ON d. GETS THE FILE FROM A SHARE LINK, not a bounce to the original post', async () => {
  /**
   * The half that is easy to miss. Every post-yielding route bounces a PERSON to the original post
   * before rendering, because a card is for a crawler. On a d. host that would send someone who asked
   * for the file to the post they already had — defeating the feature for its most likely audience.
   */
  const { ctx: c } = ctx()
  const resolved = { ref: { p: 'rd', kind: 'comments', id: 'abc123' }, canonical: 'https://www.reddit.com/r/linuxmemes/comments/abc123/x/' }
  const human = new Request('https://d.mbedfx.app/r/linuxmemes/s/VRg1iSFn4k', {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
  })
  const res = await handle(human, envWith(fakeResolver().binding), c, deps({ resolveRedditShare: async () => resolved }))
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location'), /\/_media\//,
    'the redirect is to our own bytes, not out to reddit.com')
})

test('A HUMAN ON d. GETS THE FILE FROM A TIKTOK SHORT LINK TOO — the one kind that never reaches renderPostRoute', async () => {
  /**
   * THE SAME RULE AS THE REDDIT TEST ABOVE, AND IT WAS NOT TRUE FOR THIS ROUTE.
   *
   * renderPostRoute short-circuits a d. origin for every route that reaches it, and its comment says
   * the convergence is what makes remembering unnecessary. A shortlink does not converge on it — a
   * short code caches in its own namespace, so that arm renders the post itself — so the check was
   * simply absent there. Reported and reproduced against production, 2026-08-08:
   *
   *   d.<host>/@user/video/{id}   302 -> /_media/tt:{id}/0     the file
   *   d.<host>/t/{code}           302 -> tiktok.com/@user/...  the POST
   *
   * One post, one host, two answers, decided only by which url shape someone pasted.
   */
  const { ctx: c } = ctx()
  const resolved = {
    kind: 'post',
    post: {
      ref: { p: 'tt', id: '7246058829106973978' },
      canonical: 'https://www.tiktok.com/@someone/video/7246058829106973978',
      author: { name: 'n', handle: 'h', url: 'https://example.invalid' },
      text: '', createdAt: new Date('2026-07-01T00:00:00Z'), counts: {}, sensitive: false,
      media: [{ kind: 'video', url: 'https://example.invalid/v.mp4', w: 5, h: 5 }],
    },
  }
  const human = new Request('https://d.mbedfx.app/t/ZTAvgEAL3', {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
  })
  const res = await handle(human, envWith(fakeResolver().binding), c,
    deps({ resolveShortlink: async () => resolved }))
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location'), /\/_media\//,
    'the redirect is to our own bytes, not out to tiktok.com')
})

test('A SHORT LINK ON THE APEX IS UNTOUCHED BY THAT — a person is still bounced to the real post', async () => {
  // The share code is resolved away first, which is the privacy behaviour the shortlink arm exists
  // for; the point here is only that adding the d. branch did not change what the apex does.
  const { ctx: c } = ctx()
  const resolved = {
    kind: 'post',
    post: {
      ref: { p: 'tt', id: '7246058829106973978' },
      canonical: 'https://www.tiktok.com/@someone/video/7246058829106973978',
      author: { name: 'n', handle: 'h', url: 'https://example.invalid' },
      text: '', createdAt: new Date('2026-07-01T00:00:00Z'), counts: {}, sensitive: false,
      media: [{ kind: 'video', url: 'https://example.invalid/v.mp4', w: 5, h: 5 }],
    },
  }
  const human = new Request('https://mbedfx.app/t/ZTAvgEAL3', {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
  })
  const res = await handle(human, envWith(fakeResolver().binding), c,
    deps({ resolveShortlink: async () => resolved }))
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.tiktok.com/@someone/video/7246058829106973978',
    'the sanitised permalink, not our own bytes and not the share code')
})

test('THE APEX IS UNCHANGED BY ALL OF THAT — a share link still renders a card', async () => {
  // The guard is "human AND NOT a direct host", so ordinary hosts must keep bouncing people to the
  // post and rendering cards for crawlers exactly as before.
  const { ctx: c } = ctx()
  const resolved = { ref: { p: 'rd', kind: 'comments', id: 'abc123' }, canonical: 'https://www.reddit.com/r/linuxmemes/comments/abc123/x/' }
  const bot = new Request('https://mbedfx.app/r/linuxmemes/s/VRg1iSFn4k', {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  })
  const res = await handle(bot, envWith(fakeResolver().binding), c, deps({ resolveRedditShare: async () => resolved }))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/html/, 'still a card on the apex')
})

test('/_prep LEAVES A LINK ALONE WHEN IT ALREADY NAMES THE SAME POST', async () => {
  /**
   * Reported 2026-08-03: pasting youtu.be/{id} came back as /watch?v={id}. The page converts that short
   * form to a bare /{id} correctly on its own, and /_prep then overwrote it — because the url was
   * rebuilt from the PLATFORM'S canonical every time, and YouTube's canonical is the long watch form.
   *
   * Nothing is learned by that rewrite. It only hands back a longer link than the one pasted, on the
   * one screen whose whole job is handing back a tidy one.
   */
  const { ctx: c } = ctx()
  const j = await (await handle(prep('/Jky5ZXI0axc'), envWith(fakeResolver().binding), c, deps())).json()
  assert.equal(j.ok, true)
  assert.equal(j.url, 'https://mbedfx.app/Jky5ZXI0axc', 'the pasted shape survives')
  assert.equal(j.canonical, 'https://www.youtube.com/watch?v=Jky5ZXI0axc',
    'while `canonical` still reports the platform form, which is what it is for')
})

/* ===================== REDDIT SHARE LINKS ON THE PAGE'S OWN ENDPOINTS =====================
 *
 * REPORTED FROM PRODUCTION 2026-08-03 with a screenshot: pasting
 * https://www.reddit.com/r/linuxmemes/s/QHrYqsQGGY into the converter page answered "No preview.
 * This link doesn't resolve to a post." The same link, pasted into Discord, unfurls correctly —
 * the render path has resolved 'redditshare' since the day that route kind shipped. Reproduced
 * against prod: both /_prep and /_card answered {"ok":false,"reason":"redditshare"}.
 *
 * SAME DEFECT, THIRD TIME. Each arm carried its own inline unwrap, taught 'metashare' first and
 * 'shortlink' after the tiktok.com/t/ report above, and never taught 'redditshare' at all — so the
 * one route kind whose url comes out of the Reddit app's OWN share button fell through to
 * `if (inner.kind !== 'post')` and was reported back verbatim as the reason. Worse than a broken
 * link, because it talks a reader out of a link that works, on the screen whose entire job is to
 * reassure them before they send it.
 *
 * The unwrap is one shared function now (unwrapToPost in src/worker.ts) and the sweep at the bottom
 * of this file fails until every indirect kind is handled there.
 */

/**
 * A resolved /s/ token: what a 301 follow hands back. The RESOLVER'S canonical is what unwrapToPost
 * routes from — deliberately, so this seam and the render path cannot derive different refs from one
 * code — so the slug is left on it exactly as Reddit's own redirect carries it.
 */
const redditShareResolved = (sub, id) => ({
  ref: { p: 'rd', sub, id },
  canonical: `https://www.reddit.com/r/${sub}/comments/${id}/a_penguin_writes_bash/`,
})

/**
 * A fetchPost that ECHOES THE REF back as content. Asserting `ok: true` alone would pass for a card
 * describing the wrong post, so every field a test reads here is derived from the id the resolver
 * produced — which is the only way to show the resolved permalink is what actually got fetched.
 */
const echoRedditPost = async ref => ({
  ref,
  canonical: `https://www.reddit.com/r/${ref.sub}/comments/${ref.id}/a_penguin_writes_bash/`,
  author: {
    name: `author_of_${ref.id}`,
    handle: `u/author_of_${ref.id}`,
    url: 'https://www.reddit.com/user/author',
  },
  text: `the post behind ${ref.id}`,
  createdAt: new Date('2026-08-03T12:00:00Z'),
  counts: { likes: 12, replies: 3 },
  sensitive: false,
  media: [{ kind: 'image', url: 'https://i.redd.it/fixture.jpg', w: 640, h: 480 }],
})

test('/_card RESOLVES A REDDIT /s/ SHARE LINK, so the app\'s own share button previews instead of being refused', async () => {
  /**
   * THE REPORTED BUG, pinned at the endpoint that drew the screenshot. /_card answered
   * {ok:false, reason:'redditshare'} and the page rendered "This link doesn't resolve to a post" —
   * about a link Discord unfurls perfectly, because only this seam had never learned the kind.
   *
   * ASSERTED ON CONTENT, NOT ON A FLAG. `ok: true` is satisfied by a card describing anything at
   * all; what has to be true is that the card describes the post the /s/ token RESOLVED TO, so the
   * author line, the text and the canonical are all checked against the id the resolver returned.
   */
  const { ctx: c } = ctx()
  const d = deps({
    fetchPost: echoRedditPost,
    resolveRedditShare: async () => redditShareResolved('linuxmemes', 'card1rd'),
  })
  const j = await (await handle(card('/r/linuxmemes/s/QHrYqsQGGY'), envWith(fakeResolver().binding), c, d)).json()
  assert.equal(j.ok, true, `the preview must draw a card, got reason ${j.reason}`)
  assert.equal(j.platform, 'rd')
  assert.equal(j.text, 'the post behind card1rd', 'the resolved post\'s own text, not a stand-in')
  assert.match(j.author.byline, /author_of_card1rd/, 'and its own author line')
  assert.ok(j.canonical.includes('/comments/card1rd/'), `the permalink, got ${j.canonical}`)
  assert.ok(!j.canonical.includes('QHrYqsQGGY'), 'the opaque share token is gone')
})

test('/_prep HANDS BACK THE RESOLVED PERMALINK for a Reddit /s/ link, never the opaque token', async () => {
  /**
   * The other half of the same report. /_prep is what the page shows in the box and what a reader
   * copies out of it, so answering {ok:false, reason:'redditshare'} left them with nothing to send
   * — and answering with the /s/ url would be no better, because unfurling the share code to the
   * full permalink is the ask this endpoint exists for ("the full thing instead of just replacing
   * the url", 2026-07-31).
   */
  const { ctx: c, settle } = ctx()
  const d = deps({
    fetchPost: echoRedditPost,
    resolveRedditShare: async () => redditShareResolved('linuxmemes', 'prep1rd'),
  })
  const j = await (await handle(prep('/r/linuxmemes/s/9CxZq7wTvB'), envWith(fakeResolver().binding), c, d)).json()
  await settle()
  assert.equal(j.ok, true, `the page must get a usable answer, got reason ${j.reason}`)
  assert.equal(j.platform, 'rd')
  assert.equal(j.url, 'https://mbedfx.app/r/linuxmemes/comments/prep1rd', 'the permalink on our own origin')
  assert.equal(j.canonical, 'https://www.reddit.com/r/linuxmemes/comments/prep1rd')
  for (const junk of ['/s/', '9CxZq7wTvB']) {
    assert.ok(!j.url.includes(junk) && !j.canonical.includes(junk), `${junk} must not survive`)
  }
})

test('A REDDIT SHARE THAT WILL NOT RESOLVE IS AN HONEST no on BOTH endpoints, never a 500', async () => {
  /**
   * The degrade path, which is what makes the fix safe to have made at all: unwrapToPost hands back
   * the route UNTOUCHED on any miss, so the answer is exactly the one both arms gave before they
   * learned the kind. A resolver that returns null and one that THROWS have to land in the same
   * place — /_prep and /_card are public paths with no try/catch above them, so an unhandled
   * rejection here is an HTTP 500 on the converter page rather than a card that says "couldn't
   * load", and the reason field is the only thing the page can explain itself with.
   */
  const { ctx: c } = ctx()
  const stubs = [
    async () => null,
    async () => { throw new TypeError('reddit hung up mid-redirect') },
  ]
  for (const [i, stub] of stubs.entries()) {
    for (const make of [prep, card]) {
      const req = make(`/r/linuxmemes/s/MissFixture${i}`)
      const res = await handle(req, envWith(fakeResolver().binding), c,
        deps({ fetchPost: echoRedditPost, resolveRedditShare: stub }))
      assert.equal(res.status, 200, 'a resolver miss is an answer, not a crash')
      const j = await res.json()
      assert.equal(j.ok, false)
      assert.equal(j.reason, 'redditshare', 'honest about what it could not do')
    }
  }
})

test('EVERY INDIRECT POST-YIELDING ROUTE KIND IS UNWRAPPED — the sweep that stops a FOURTH being forgotten', () => {
  /**
   * THE POINT OF THIS FILE'S LAST THREE BUGS, WRITTEN AS AN ASSERTION.
   *
   * 'metashare' was taught to these two arms, then 'shortlink' after tiktok.com/t/ZTAxTF9aD
   * previewed as "unresolved", then 'redditshare' after /r/{sub}/s/{code} said the link doesn't
   * resolve to a post. Three times the render path already handled the kind and the converter
   * preview did not, and three times nothing failed until a human pasted a link and filed a report.
   * That is the same silent-omission shape as parseRefKey's allowlist, which is why it gets the same
   * answer: a sweep that fails until the new kind is a DECISION rather than an oversight.
   *
   * DERIVED, NOT LISTED. The set is read out of the Route union in src/types.ts — every kind that
   * carries a `canonical`, minus 'post' itself. `canonical` is the discriminator because it is
   * exactly what unwrapToPost needs: a url a resolver can hop from and route() can turn into a ref.
   * A hardcoded trio here would be a second copy of the very list that keeps going stale.
   *
   * AND THE WHOLE UNION IS PINNED TOO, for the case the derivation cannot see: a future
   * post-yielding kind that carries no `canonical` would slip through the filter silently. Any new
   * arm at all fails the first assertion instead, which forces someone to say which sort it is.
   */
  const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
  const from = types.indexOf('export type Route =')
  const to = types.indexOf('export type Outcome')
  assert.ok(from > 0 && to > from, 'src/types.ts still declares Route above Outcome')
  const union = types.slice(from, to)
  const arms = [...union.matchAll(/^\s*\|\s*\{\s*kind: '([a-z]+)'([^}]*)\}/gm)]
    .map(m => ({ kind: m[1], fields: m[2] }))

  const ALL_KINDS = [
    // 'api' added 2026-08-03 with /_api/v1. It can NEVER yield a post through a network hop: like
    // 'card' and 'prep' it carries an opaque target that it re-routes through route() itself, and the
    // route that comes back is what unwrapToPost is then handed. Listing it here is the whole change.
    'activity', 'ambiguous', 'api', 'badid', 'card', 'media', 'metashare', 'notfound',
    'oembed', 'post', 'prep', 'redditshare', 'shortlink', 'site',
  ]
  assert.deepEqual(arms.map(a => a.kind).sort(), ALL_KINDS,
    'A Route kind was added or removed. If it can resolve to a post through a network hop, teach '
    + 'unwrapToPost in src/worker.ts as well as adding it here; if it can never yield a post, adding '
    + 'it to ALL_KINDS is the whole change.')

  // Every derived kind must be one the ROUTER actually mints, or the derivation is over-reporting
  // and this test would start demanding an unwrap for a shape no url can reach.
  const router = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8')
  const indirect = arms
    .filter(a => a.kind !== 'post' && /canonical\s*:/.test(a.fields))
    .map(a => a.kind)
    .sort()
  assert.ok(indirect.length >= 3, `the derivation found ${indirect.length} indirect kinds, expected at least 3`)
  for (const kind of indirect) {
    assert.ok(router.includes(`kind: '${kind}'`), `src/router.ts must actually mint ${kind}`)
  }

  // What unwrapToPost handles, read out of the function itself rather than trusted.
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const start = worker.indexOf('async function unwrapToPost(')
  assert.ok(start > 0, 'src/worker.ts still declares unwrapToPost — if it was renamed, rename it here too')
  const end = worker.indexOf('\n}\n', start)
  assert.ok(end > start, 'the unwrapToPost body is delimited by a column-0 closing brace')
  const body = worker.slice(start, end)
  const handled = [...new Set([...body.matchAll(/inner\.kind === '([a-z]+)'/g)].map(m => m[1]))].sort()

  assert.deepEqual(handled, indirect,
    `unwrapToPost handles [${handled}] and the Route union says the indirect post-yielding kinds are `
    + `[${indirect}]. Add the missing branch to unwrapToPost in src/worker.ts: resolve the code, then `
    + `route() the resolved url and return it when it is a post, returning \`inner\` on any miss. `
    + `(If the branch exists but is not spelled \`inner.kind === '<kind>'\`, this test cannot see it — `
    + `fix the spelling or the matcher above.)`)
})

test('/_prep STILL UNFURLS A LINK THAT NAMES NO POST UNTIL IT IS RESOLVED', async () => {
  /**
   * The other half, and the reason the rewrite exists at all. A share code or a shortlink is an opaque
   * token — the page cannot know which post it addresses, so being handed the permalink is the entire
   * point of asking. The fix must not turn that off, which is why the test is "did resolving CHANGE
   * which post this addresses" rather than "is this the canonical spelling".
   */
  const { ctx: c } = ctx()
  const d2 = deps({ resolveShortlink: async () => shortResolved })
  const j = await (await handle(prep('/t/ZTAxTF9aD'), envWith(fakeResolver().binding), c, d2)).json()
  assert.equal(j.ok, true)
  assert.ok(!j.url.includes('/t/'), `the opaque code is replaced, got ${j.url}`)
  assert.match(j.url, /7650584217042144526/, 'with the real post it resolved to')
})
