import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { fetchLemmy } from '../src/platforms/lemmy/fetch.ts'
import { lemmyMedia, normalizeLemmy } from '../src/platforms/lemmy/normalize.ts'

/**
 * PIEFED — the second software family answering a Lemmy-shaped URL, and a correction rather than a
 * new platform.
 *
 * THE FALSE CLAIM THIS FILE EXISTS TO PIN. The Lemmy fetcher's docstring asserted PieFed "also serves
 * /api/v3/*, so this one client covers it." Measured 2026-07-28, that is wrong in the ONE place that
 * matters:
 *
 *   piefed.social/api/v3/site        200 application/json   <- the reason it LOOKED covered
 *   piefed.social/api/v3/post?id=…   404 text/html          <- the only endpoint we actually call
 *   piefed.social/api/alpha/post?id= 200 application/json   <- its real post API
 *
 * `/api/v3/site` is a compatibility shim so Lemmy APPS can fingerprint the instance. Believing it
 * meant every PieFed link rendered "couldn't load" while the code claimed support.
 *
 * The `post_view` envelope, `creator.actor_id` and `community.actor_id` are identical to Lemmy's, so
 * one client really can cover both — but only after four field spellings are reconciled, below.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => JSON.parse(readFileSync(new URL(n, F), 'utf8'))

const POST = load('piefed-post.json').post_view
const COMMENT = load('piefed-comment.json').comment_view

const REF = { p: 'lm', host: 'piefed.social', kind: 'post', id: '2240362' }
const r = p => route(new URL(`https://staging.megapenispoopenfarten.sex${p}`))

test('PIEFED IS THE SAME REF AS LEMMY — the software is discovered, never spelled in the URL', () => {
  /**
   * A user pasting `/piefed.social/post/123` cannot be expected to know which software serves it, and
   * nothing in the URL says. So the ref stays `lm` and the FETCHER probes. Minting a separate platform
   * code would have forced the router to guess something the router cannot know.
   */
  assert.deepEqual(r('/piefed.social/post/2240362').ref, REF)
  assert.equal(refKey(r('/piefed.social/post/2240362').ref), 'lm:piefed.social:post:2240362')
  assert.deepEqual(parseRefKey('lm:piefed.social:post:2240362'), REF)
})

test("PIEFED'S CANONICAL SPELLING ROUTES — it is what its own share button emits", () => {
  /**
   * Measured: PieFed's `rel="canonical"` is `/c/{community}@{instance}/p/{id}/{full-slug}`, NOT the
   * bare `/post/{id}`. Both work on PieFed, but only the long one is handed to users — so supporting
   * only the short form would have covered the shape nobody pastes.
   *
   * The slug is required BY PIEFED (full slug 200, truncated slug 404) but is decoration to US: only
   * the trailing id is identity, and canonical() is rebuilt from the id form.
   */
  const long = '/piefed.social/c/technology@lemmy.world/p/2240362/professor-s-invisible-prompt-trap-catches-32'
  assert.deepEqual(r(long).ref, REF, 'the canonical form folds to the same ref')
  assert.deepEqual(r('/piefed.social/c/technology@lemmy.world/p/2240362').ref, REF, 'slugless too')
  assert.deepEqual(r('/piefed.social/c/memes/p/2240362/a/b').ref, REF, 'and any trailing depth')
  // The community segment is an ACTOR HANDLE (`technology@lemmy.world`), not a host — FEDI_HOST would
  // reject its '@'. Only seg[0] is ever fetched, so it is never validated as one.
  assert.equal(r(long).ref.host, 'piefed.social')
})

test('THE /c/…/p/ ARM CLAIMS NOTHING ELSE — proven by a 683,613-path sweep', () => {
  /**
   * The whole sweep produced 1,211 differences and every one was `notfound -> post:lm` on this exact
   * shape. These assertions pin the guards that kept it that tight.
   */
  assert.equal(r('/notahost/c/x/p/2240362').kind, 'notfound', 'seg[0] must be a real host')
  assert.equal(r('/piefed.social/c/x/q/2240362').kind, 'notfound', "seg[3] must be exactly 'p'")
  assert.equal(r('/piefed.social/x/y/p/2240362').kind, 'notfound', "seg[1] must be exactly 'c'")
  assert.equal(r('/piefed.social/c/x/p/abc').kind, 'notfound', 'the id must be a bare integer')
  assert.equal(r('/piefed.social/c/x/p/0').kind, 'notfound', 'and carry no leading zero')
  assert.equal(r('/piefed.social/c/x/p').kind, 'notfound', 'depth 4 is not enough')
  // Neighbours are undisturbed.
  assert.equal(r('/p/DbN6SsKum-9').ref.p, 'ig')
  assert.equal(r('/r/pics/comments/abc123').ref.p, 'rd')
  assert.equal(r('/pin/66287425756772418').ref.p, 'pn')
})

test('THE TITLE IS post.title — Lemmy uses post.name, and reading one alone gives a titleless card', () => {
  assert.equal(POST.post.name, undefined, 'PieFed genuinely has no post.name')
  assert.ok(POST.post.title, 'it carries the headline in post.title')
  const p = normalizeLemmy(POST, REF)
  assert.match(p.title, /^Professor's invisible prompt trap/)
})

test('THE TWO `title` FIELDS MUST NOT CROSS — the trap in porting this', () => {
  /**
   * PieFed's `creator.title` is the DISPLAY NAME while its `post.title` is the POST HEADLINE. A shared
   * reader that grabs `title` off whichever object is to hand produces a card whose headline is the
   * author's name — plausible enough to survive review. This test is the tripwire.
   */
  assert.equal(POST.creator.title, 'Nobody_Special', 'creator.title is a person')
  const p = normalizeLemmy(POST, REF)
  assert.equal(p.author.name, 'Nobody_Special')
  assert.notEqual(p.title, p.author.name, 'the headline is NOT the author')
  assert.match(p.title, /prompt trap/)
})

test('THE HANDLE IS creator.user_name, and stays FULLY QUALIFIED', () => {
  assert.equal(POST.creator.name, undefined, 'PieFed has no creator.name')
  assert.equal(POST.creator.user_name, 'Nobody_Special')
  const p = normalizeLemmy(POST, REF)
  // Two people may hold the same local name on two instances, so the bare form is not an identity.
  assert.equal(p.author.handle, 'Nobody_Special@piefed.social')
  assert.equal(p.author.url, 'https://piefed.social/u/Nobody_Special')
})

test('image_details SITS ON THE POST, NOT THE VIEW — and carries NO link', () => {
  /**
   * The mirror image of the bug already fixed on the Lemmy side, where image_details is a sibling of
   * `post`. PieFed puts it ON the post AND omits `link`, so its width/height describe
   * `thumbnail_url` — which is why `sized` cannot simply test `pick === detail`.
   */
  assert.equal(POST.image_details, undefined, 'not on the view')
  assert.deepEqual(POST.post.image_details, { width: 512, height: 341 })
  assert.equal(POST.post.image_details.link, undefined, 'and no link to point at')
  const [m] = lemmyMedia(POST)
  assert.equal(m.kind, 'image')
  assert.equal(m.url, POST.post.thumbnail_url, 'the picture is the thumbnail')
  assert.equal(m.w, 512, 'and it is sized by the post-level image_details')
  assert.equal(m.h, 341)
})

test('DIMENSIONS ARE NEVER APPLIED TO A PICTURE THEY DO NOT DESCRIBE', () => {
  /**
   * If PieFed sends image_details but the thumbnail is missing, we fall through to `post.url` — and
   * those measurements describe the thumbnail, not the link target. Stretching a picture in Discord is
   * worse than the honest 0x0 this codebase uses everywhere it does not know.
   */
  const view = {
    post: {
      id: 1,
      image_details: { width: 512, height: 341 },
      url: 'https://example.com/other.jpg',
    },
  }
  const [m] = lemmyMedia(view)
  assert.equal(m.url, 'https://example.com/other.jpg')
  assert.equal(m.w, 0, 'unsized rather than mis-sized')
  assert.equal(m.h, 0)
})

test('A PIEFED COMMENT CARRIES ITS POST — the same liveness assert holds', () => {
  assert.ok(COMMENT.post, 'comment_view carries the post')
  assert.equal(typeof COMMENT.post.id, 'number', 'which is what the fetcher asserts on')
  const p = normalizeLemmy(COMMENT, { ...REF, kind: 'comment', id: '12285388' })
  assert.ok(p, 'and it normalizes')
  assert.equal(p.canonical, 'https://piefed.social/comment/12285388')
})

test('LEMMY IS TRIED FIRST AND PIEFED SECOND — bounded at two subrequests', async () => {
  /**
   * The flavour cannot be read off the URL and no cheap header gives it away (PieFed answers
   * /api/v3/site precisely so Lemmy clients fingerprint it as Lemmy). So it is discovered by ASKING.
   * Lemmy — far the larger population — costs one request; PieFed costs two. A NodeInfo lookup would
   * identify the software up front but would tax every Lemmy request to save PieFed one.
   */
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async u => {
    seen.push(new URL(u).pathname + new URL(u).search)
    if (String(u).includes('/api/v3/')) {
      // PieFed's real 404 shape: text/html, caught before any body is read.
      return new Response('<p>Oops</p>', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return new Response(JSON.stringify({ post_view: POST }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const got = await fetchLemmy(REF)
    assert.equal(got.ok, true, 'the PieFed answer is accepted')
    assert.deepEqual(seen, ['/api/v3/post?id=2240362', '/api/alpha/post?id=2240362'], 'in that order')
  } finally {
    globalThis.fetch = real
  }
})

test('A LEMMY HIT COSTS EXACTLY ONE REQUEST — the fallback is not a tax on the common case', async () => {
  let calls = 0
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ post_view: { post: { id: 1, name: 'hi', published: '2026-01-01T00:00:00Z' } } }),
      { headers: { 'content-type': 'application/json' } })
  }
  try {
    const got = await fetchLemmy({ p: 'lm', host: 'lemmy.world', kind: 'post', id: '1' })
    assert.equal(got.ok, true)
    assert.equal(calls, 1, 'PieFed is never asked when Lemmy answered')
  } finally {
    globalThis.fetch = real
  }
})

test('A PRIVATE INSTANCE IS A FINAL ANSWER — it does not fall through to the other flavour', async () => {
  /**
   * Falling through would turn a truthful "this instance is private" into a generic "couldn't load",
   * losing the one upstream error string worth telling apart.
   */
  let calls = 0
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ error: 'instance_is_private' }),
      { headers: { 'content-type': 'application/json' } })
  }
  try {
    const got = await fetchLemmy(REF)
    assert.deepEqual(got, { ok: false, reason: 'private' })
    assert.equal(calls, 1, 'and it stops there')
  } finally {
    globalThis.fetch = real
  }
})

test('A THROW ON THE FIRST FLAVOUR STILL TRIES THE SECOND', async () => {
  /**
   * A connection reset is a property of the attempt, not a verdict on the instance. Giving up there
   * would make PieFed's support depend on how Lemmy's endpoint happened to fail.
   */
  const real = globalThis.fetch
  globalThis.fetch = async u => {
    if (String(u).includes('/api/v3/')) throw new TypeError('network')
    return new Response(JSON.stringify({ post_view: POST }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    assert.equal((await fetchLemmy(REF)).ok, true)
  } finally {
    globalThis.fetch = real
  }
})

test('A THROW ON THE LAST FLAVOUR PROPAGATES — worker.ts owns that contract', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('network') }
  try {
    await assert.rejects(() => fetchLemmy(REF), /network/)
  } finally {
    globalThis.fetch = real
  }
})

test('the real PieFed post normalizes end to end', () => {
  const p = normalizeLemmy(POST, REF)
  assert.equal(p.author.name, 'Nobody_Special')
  assert.equal(p.author.handle, 'Nobody_Special@piefed.social')
  assert.match(p.author.avatar, /^https:\/\/media\.piefed\.social\//)
  // The community is FEDERATED — it lives on lemmy.world though we read piefed.social. That
  // three-instances-in-one-card case is exactly what the fully-qualified handle exists to make visible.
  assert.match(p.text, /!technology@lemmy\.world/)
  assert.equal(p.counts.replies, 92)
  assert.ok(p.counts.likes > 0)
  assert.equal(p.sensitive, false)
  assert.equal(p.createdAt.getUTCFullYear(), 2026)
  assert.equal(p.canonical, 'https://piefed.social/post/2240362')
})
