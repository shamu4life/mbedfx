import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { fetchMisskey } from '../src/platforms/misskey/fetch.ts'
import { effectiveNote, misskeyMedia, normalizeMisskey } from '../src/platforms/misskey/normalize.ts'

/**
 * THE MISSKEY FAMILY — Misskey, Sharkey, Iceshrimp — and the reason it is a SECOND client rather than
 * a few more shapes on the Mastodon one.
 *
 * MEASURED 2026-07-28, against ids taken from real `/notes/{id}` permalinks:
 *
 *   Misskey            `/api/v1/statuses/{id}` -> 404 `UNKNOWN_API_ENDPOINT`. No compat layer at all.
 *   Sharkey 2025.4.7   404 `NO_SUCH_NOTE` for ORIGINAL notes while BOOSTS succeed — the same split on
 *                      three separate instances over 60 notes (blahaj.zone 13/20, transfem.social
 *                      6/20, woem.men 10/20 through the Mastodon API; 20/20 through notes/show).
 *   Sharkey 2025.5.2+  both work.   Iceshrimp   both work.
 *
 * So `notes/show` is preferred for the whole family rather than trying the Mastodon endpoint first:
 * every one of them answers it, every one takes the id straight from the URL, and it has no version
 * hole. The version correlation on the Sharkey failure is measured; its CAUSE is not, which is
 * exactly why the safe endpoint is the default rather than a fallback.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => JSON.parse(readFileSync(new URL(n, F), 'utf8'))

const IMAGES = load('misskey-note-images.json')     // misskey.io, 2 images
const VIDEO = load('misskey-note-video.json')       // transfem.social (Sharkey), video/mp4
const CW = load('misskey-note-cw.json')             // a real content warning
const RENOTE = load('misskey-note-renote.json')     // a pure boost

const HOST = 'misskey.io'
const REF = { p: 'mk', host: HOST, id: 'ap7sliijot1f03nr' }
const r = p => route(new URL(`https://staging.megapenispoopenfarten.sex${p}`))

test('ONE PERMALINK SHAPE, AND THE ID IN IT IS THE API ID ON ALL THREE SOFTWARES', () => {
  for (const p of [
    `/${HOST}/notes/ap7sliijot1f03nr`,
    `/https://${HOST}/notes/ap7sliijot1f03nr`,   // the prepend alias
    `/mk/${HOST}/notes/ap7sliijot1f03nr`,        // the escape hatch
  ]) {
    assert.deepEqual(r(p).ref, REF, `${p} -> one ref`)
  }
  assert.equal(refKey(REF), 'mk:misskey.io:ap7sliijot1f03nr')
  assert.deepEqual(parseRefKey('mk:misskey.io:ap7sliijot1f03nr'), REF)
  assert.equal(parseRefKey('mk:misskey.io'), null)
  assert.equal(parseRefKey('mk:localhost:abc'), null, 'the host is re-validated here too')
})

test('/notes/ IS NOT ROUTED INTO THE MASTODON CLIENT', () => {
  // Routing it there would mint refs that 404 on Misskey and on Sharkey 2025.4.7 — the
  // looks-supported-but-never-works shape this project refuses.
  assert.equal(r(`/${HOST}/notes/ap7sliijot1f03nr`).ref.p, 'mk')
  assert.equal(r('/mstdn.social/@stux/116994812581955524').ref.p, 'ms')
  // And the two matchers do not overlap: Misskey needs 'notes' at seg[1], Mastodon never claims it.
  assert.equal(r(`/${HOST}/notes/abc/extra`).kind, 'notfound', 'depth is exact')
  assert.equal(r('/notahost/notes/abc').kind, 'notfound', 'seg[0] must be a real host')
  assert.equal(r(`/${HOST}/notes/a/b`).kind, 'notfound')
  assert.equal(r(`/${HOST}/note/abc`).kind, 'notfound', "'note' singular is nobody's")
})

test('THE ATTACHMENT TYPE IS A MIME STRING, NOT AN ENUM', () => {
  /**
   * The trap that would drop ALL Misskey media. Mastodon sends `type: "image"`; Misskey sends
   * `type: "image/webp"`. Comparing against the Mastodon enum matches nothing.
   */
  assert.equal(IMAGES.files[0].type, 'image/webp', 'the fixture really is a MIME string')
  const media = misskeyMedia(IMAGES)
  assert.equal(media.length, 2)
  assert.ok(media.every(m => m.kind === 'image'))
  assert.equal(VIDEO.files[0].type, 'video/mp4')
  assert.equal(misskeyMedia(VIDEO)[0].kind, 'video')
  // An actual .gif file IS our 'gif' kind — here the MIME really does say so.
  assert.equal(misskeyMedia({ files: [{ type: 'image/gif', url: 'https://x.tld/a.gif' }] })[0].kind, 'gif')
})

test('DIMENSIONS LIVE IN `properties`, AND ARE EMPTY FOR VIDEO', () => {
  assert.deepEqual(IMAGES.files[0].properties, { width: 3000, height: 4000 })
  const [img] = misskeyMedia(IMAGES)
  assert.equal(img.w, 3000)
  assert.equal(img.h, 4000)
  // Measured on every instance sampled: video carries `properties: {}`.
  assert.deepEqual(VIDEO.files[0].properties, {})
  const [vid] = misskeyMedia(VIDEO)
  assert.equal(vid.w, 0, 'unsized rather than invented')
  assert.equal(vid.h, 0)
})

test('A MISSKEY VIDEO OFTEN HAS NO POSTER — and none is invented', () => {
  /**
   * `thumbnailUrl` was null on the sampled Sharkey video. A posterless video drops Discord to plain
   * OpenGraph (types.ts), which is a worse card — but reusing the video url as its own poster is a
   * BROKEN card, the Phase 2 defect. Absent is the honest answer.
   */
  assert.equal(VIDEO.files[0].thumbnailUrl, null, 'the fixture really has none')
  assert.equal(misskeyMedia(VIDEO)[0].poster, undefined)
  // A real thumbnail is kept...
  const withThumb = { files: [{ type: 'video/mp4', url: 'https://x.tld/v.mp4', thumbnailUrl: 'https://x.tld/t.webp' }] }
  assert.equal(misskeyMedia(withThumb)[0].poster, 'https://x.tld/t.webp')
  // ...but one that is really the video is refused, the same guard Pleroma forces on the other client.
  const selfThumb = { files: [{ type: 'video/mp4', url: 'https://x.tld/v.mp4', thumbnailUrl: 'https://x.tld/v.mp4' }] }
  assert.equal(misskeyMedia(selfThumb)[0].poster, undefined)
})

test('A PURE RENOTE IS UNWRAPPED — but a QUOTE IS NOT', () => {
  /**
   * The distinction Misskey has and Mastodon does not. A note carrying BOTH `renote` and its own
   * `text` is a QUOTE, and the quoter's commentary is usually the whole reason it was shared.
   * Unwrapping it would silently discard that.
   */
  assert.ok(RENOTE.renote, 'the fixture is a boost')
  assert.equal((RENOTE.text || '').trim(), '', 'with no text of its own')
  assert.equal(effectiveNote(RENOTE).id, RENOTE.renote.id, 'so it unwraps')

  const quote = { ...RENOTE, text: 'look at this' }
  assert.equal(effectiveNote(quote).id, quote.id, 'a quote keeps its own identity')
  const quotePost = normalizeMisskey(quote, { p: 'mk', host: HOST, id: quote.id })
  assert.match(quotePost.text, /look at this/, "and the quoter's words survive")
  assert.doesNotMatch(quotePost.text, /^🔁/, 'a quote is not labelled a boost')

  const boostPost = normalizeMisskey(RENOTE, { p: 'mk', host: HOST, id: RENOTE.id })
  assert.match(boostPost.text, /^🔁 boosted by @/)
})

test('`text` IS PLAIN TEXT — running it through an HTML pass would eat literal angle brackets', () => {
  // Misskey stores MFM source, not HTML. There are no tags to strip.
  const note = { id: '1', user: { username: 'u' }, text: 'a < b and 5 > 3 <notatag>' }
  const post = normalizeMisskey(note, { p: 'mk', host: HOST, id: '1' })
  assert.equal(post.text, 'a < b and 5 > 3 <notatag>')
})

test('THE CW LEADS AND MARKS THE POST SENSITIVE — there is NO note-level flag', () => {
  /**
   * Misskey has no `sensitive` on the note at all; the only flag is per FILE (`isSensitive`). So the
   * post is sensitive if it carries a CW or if ANY attachment is marked.
   */
  assert.equal(CW.cw, 'Begpost for friend')
  assert.equal(CW.sensitive, undefined, 'the note itself has no such field')
  const post = normalizeMisskey(CW, { p: 'mk', host: HOST, id: CW.id })
  assert.match(post.text, /^⚠️ Begpost for friend/)
  assert.equal(post.sensitive, true)

  const flagged = { id: '1', user: { username: 'u' }, files: [{ type: 'image/png', url: 'https://x.tld/a.png', isSensitive: true }] }
  assert.equal(normalizeMisskey(flagged, REF).sensitive, true, 'a marked FILE is enough')
  const clean = { id: '1', user: { username: 'u' }, files: [{ type: 'image/png', url: 'https://x.tld/a.png', isSensitive: false }] }
  assert.equal(normalizeMisskey(clean, REF).sensitive, false)
})

test('THE HANDLE IS FULLY QUALIFIED FROM user.host', () => {
  // `user.host` is null for a local account and carries the origin for a remote one — the same
  // information Mastodon packs into `acct`, spelled as a separate field.
  const local = normalizeMisskey({ id: '1', user: { username: 'u', host: null } }, REF)
  assert.equal(local.author.handle, 'u@misskey.io', 'the reading host fills in')
  const remote = normalizeMisskey({ id: '1', user: { username: 'u', host: 'other.tld' } }, REF)
  assert.equal(remote.author.handle, 'u@other.tld')
  assert.equal(normalizeMisskey(IMAGES, REF).author.handle, 'fixture_user_2@misskey.io')
})

test('REACTIONS ARE THE LIKE ANALOGUE — Misskey has no favourites', () => {
  /**
   * Misskey has emoji REACTIONS rather than favourites, and `reactionCount` is their total — the
   * closest analogue to a like, the same judgement Pinterest's `saves` gets.
   */
  const busy = { ...IMAGES, reactionCount: 12, repliesCount: 3, renoteCount: 7 }
  const post = normalizeMisskey(busy, REF)
  assert.equal(post.counts.likes, 12)
  assert.equal(post.counts.replies, 3)
  assert.equal(post.counts.reposts, 7)
  // A ZERO COUNT IS ABSENT, not a rendered "0" — the fixture is a fresh note with no engagement, and
  // this is the whole-project convention for counts nobody has contributed to yet.
  assert.deepEqual(IMAGES.reactionCount, 0, 'the fixture really is at zero')
  assert.deepEqual(normalizeMisskey(IMAGES, REF).counts,
    { likes: undefined, replies: undefined, reposts: undefined })
})

test('normalizeMisskey is TOTAL over a note with holes', () => {
  const bare = normalizeMisskey({ id: '1', user: { username: 'u' } }, { p: 'mk', host: HOST, id: '1' })
  assert.equal(bare.media.length, 0)
  assert.equal(bare.title, undefined)
  assert.equal(bare.text, '')
  assert.equal(bare.author.name, 'u', 'display name falls back to the username')
  assert.ok(!bare.author.avatar)
  assert.doesNotThrow(() => bare.createdAt.toISOString())
  assert.equal(bare.canonical, 'https://misskey.io/notes/1')
  assert.equal(normalizeMisskey({ id: '1' }, REF), null, 'no user at all is null, not a blank card')
})

test('THE FETCHER ASSERTS ON CONTENT AND DISTINGUISHES TWO WALLS', async () => {
  const real = globalThis.fetch
  const ref = { p: 'mk', host: 'misskey.io', id: 'abc' }
  const json = b => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
  try {
    globalThis.fetch = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
    assert.deepEqual(await fetchMisskey(ref), { ok: false, reason: 'assert_fail' })

    // A deleted note is a WALL, not a fetch failure.
    globalThis.fetch = async () => json({ error: { code: 'NO_SUCH_NOTE', message: 'No such note.' } })
    assert.deepEqual(await fetchMisskey(ref), { ok: false, reason: 'notfound' })

    // An author-level privacy setting (requireSigninToViewContents) is a PRIVACY wall, measured live.
    globalThis.fetch = async () => json({ error: { code: 'SIGNIN_REQUIRED', message: 'Signin required.' } })
    assert.deepEqual(await fetchMisskey(ref), { ok: false, reason: 'private' })

    // Anything else typed is the generic couldn't-load.
    globalThis.fetch = async () => json({ error: { code: 'SOMETHING_ELSE' } })
    assert.deepEqual(await fetchMisskey(ref), { ok: false, reason: 'assert_fail' })

    // JSON at 200 that is not a note.
    globalThis.fetch = async () => json({ hello: 'world' })
    assert.deepEqual(await fetchMisskey(ref), { ok: false, reason: 'assert_fail' })
    globalThis.fetch = async () => json({ id: 'x' })
    assert.deepEqual(await fetchMisskey(ref), { ok: false, reason: 'assert_fail' }, 'a note with no user')

    globalThis.fetch = async () => json(IMAGES)
    assert.equal((await fetchMisskey(ref)).ok, true)
  } finally {
    globalThis.fetch = real
  }
})

test('IT IS A POST, AND CARRIES THE NOTE ID AND NOTHING ELSE', async () => {
  const real = globalThis.fetch
  let seen = null
  globalThis.fetch = async (u, init) => {
    seen = { url: String(u), method: init?.method, body: init?.body, redirect: init?.redirect }
    return new Response(JSON.stringify(IMAGES), { headers: { 'content-type': 'application/json' } })
  }
  try {
    await fetchMisskey({ p: 'mk', host: 'misskey.io', id: 'abc' })
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, 'https://misskey.io/api/notes/show')
    // NO CREDENTIAL: the body is the note id alone, so there is nothing to leak to whatever origin
    // the ref names — clause 3 of the shared SSRF contract.
    assert.deepEqual(JSON.parse(seen.body), { noteId: 'abc' })
    assert.equal(seen.redirect, 'manual', 'clause 4: an instance may not 3xx us off its own host')
  } finally {
    globalThis.fetch = real
  }
})

test('THE SSRF GUARD REFUSES OUR OWN ZONE', async () => {
  const real = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => { called++; return new Response('{}') }
  try {
    for (const host of ['megapenispoopenfarten.sex', 'a.megapenispoopenfarten.sex', 'x.workers.dev', 'localhost']) {
      assert.deepEqual(await fetchMisskey({ p: 'mk', host, id: 'abc' }), { ok: false, reason: 'assert_fail' })
    }
    assert.equal(called, 0, 'and no request was made at all')
  } finally {
    globalThis.fetch = real
  }
})

test('Misskey disturbs no neighbour', () => {
  assert.equal(r('/p/DbN6SsKum-9').ref.p, 'ig')
  assert.equal(r('/lemmy.world/post/49966212').ref.p, 'lm')
  assert.equal(r('/mstdn.social/@stux/116994812581955524').ref.p, 'ms')
  assert.equal(r('/pin/66287425756772418').ref.p, 'pn')
  assert.equal(r('/xqc/status/20').ref.p, 'x')
})
