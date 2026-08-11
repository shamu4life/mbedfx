import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFacebook, fbPageUrl } from '../src/platforms/facebook/normalize.ts'

const REF = { p: 'fb', kind: 'watch', id: '10153231379946729' }
const WATCH = 'https://www.facebook.com/watch/?v=10153231379946729'
const THUMB = 'https://scontent.xx.fbcdn.net/v/t15.0-10/thumb.jpg'

/**
 * THE MEASURED POST, 2026-07-25 — https://www.facebook.com/share/v/Fixture03X/ through `yt-dlp -J`
 * (rc=0, 2.4-3.1s). The card it produced before this change read "Facebook (@facebook)" with the
 * PACKED title as its description, for a video whose real creator and caption were both sitting in
 * structured fields beside it, and whose real dimensions (576x1024, confirmed by ffprobe of the mp4 the
 * muxer actually produces) were being reported as 0x0.
 */
const PACKED_TITLE = '3.9K reactions · 292 shares | Are you “Disturbed” | PhillyBanana'
const MEASURED = {
  title: PACKED_TITLE,
  poster: THUMB,
  uploader: 'PhillyBanana ',   // WITH the measured trailing space
  uploaderId: '61554703834017',
  description: 'Are you “Disturbed”',
  w: 576, h: 1024, duration: 150.209,
}

test('fbPageUrl reconstructs the url the container is handed, per kind', () => {
  assert.equal(fbPageUrl({ p: 'fb', kind: 'watch', id: '123' }), 'https://www.facebook.com/watch/?v=123')
  assert.equal(fbPageUrl({ p: 'fb', kind: 'reel', id: '123' }), 'https://www.facebook.com/reel/123')
  assert.equal(fbPageUrl({ p: 'fb', kind: 'share', id: 'ab12' }), 'https://www.facebook.com/share/v/ab12')
  /**
   * A PHOTO REBUILDS INTO THE OWNERLESS SPELLING, and it is the only kind that can: two of the six
   * urls Facebook emits for a picture (/photo/?fbid= and /photo.php?fbid=) carry no owner at all, so
   * a rebuild that needed one would have a hole in it. Measured 2026-08-11 from Cloudflare egress —
   * handed to Meta's embed plugin, this spelling with no `set` and no owner returns the same fragment
   * as the fully qualified /{page}/photos/{fbid}/ one.
   */
  assert.equal(fbPageUrl({ p: 'fb', kind: 'photo', id: '1596906755391068' }),
    'https://www.facebook.com/photo/?fbid=1596906755391068')
})

test('the ref and canonical survive normalization unchanged', () => {
  // RESTORED 2026-07-25. These two assertions lived in the old 'container metadata -> remux {page}'
  // test, which was rewritten into the creator/caption tests above; they were dropped rather than
  // rehomed, leaving `canonical` and `ref.kind` asserted NOWHERE in this file. They are not
  // incidental: `canonical` is the url og:url advertises and the one Discord's activity+json and
  // oembed callbacks come back to, and `ref.kind` is what fbPageUrl re-derives the container's page
  // url from — so a normalizer that silently rewrote either would break the callback round-trip
  // while every remaining test in this file still passed.
  const post = normalizeFacebook({ title: 'A funny clip', poster: THUMB }, REF)
  assert.equal(post.canonical, WATCH)
  assert.equal(post.ref.kind, 'watch')
  // deepEqual, NOT equal: normalizeFacebook rebuilds the ref as a fresh {p, kind, id} literal rather
  // than passing the caller's object through, so identity is not the invariant — the VALUES are, and
  // they are what refKey() and fbPageUrl() consume.
  assert.deepEqual(post.ref, REF, 'every ref field survives the rebuild')
})

test('the REAL creator becomes the byline, trailing space and all', () => {
  const post = normalizeFacebook(MEASURED, REF)
  assert.equal(post.author.name, 'PhillyBanana', 'trimmed — yt-dlp returns it with a trailing space')
  // handle = the NAME, exactly as normalizeYouTube does: Facebook has no @handle on this surface.
  assert.equal(post.author.handle, 'PhillyBanana')
  // facebook.com/{id} 301s to the real profile — verified on this id 2026-07-25.
  assert.equal(post.author.url, 'https://www.facebook.com/61554703834017')
})

test('uploader_url wins over the id-derived url when the container reports one', () => {
  const post = normalizeFacebook({ ...MEASURED, uploaderUrl: 'https://www.facebook.com/people/PhillyBanana/61554703834017/' }, REF)
  assert.equal(post.author.url, 'https://www.facebook.com/people/PhillyBanana/61554703834017/')
})

test('THE PACKED-UPLOADER LEAK falls back to the platform byline and does NOT unpack the title', () => {
  // yt-dlp's extractor falls back to the page's og:title when the GraphQL owner has no name, and its
  // OWN test fixture for /reel/1195289147628387 records the leak — WITH a valid uploader_id beside it,
  // which is why uploader_id cannot be the discriminator and the SHAPE has to be.
  const leaked = '9.7K views &#xb7; 352 reactions | When your trying to … | Beast Camp Training'
  const post = normalizeFacebook({ title: PACKED_TITLE, uploader: leaked, uploaderId: '123' }, REF)
  assert.equal(post.author.name, 'Facebook')
  assert.equal(post.author.handle, 'facebook')
  // And with no trusted creator to key on, the title is NOT unpacked — the no-branch is exactly the
  // pre-2026-07-25 output, so a wrong guess can never be worse than shipping today's card.
  assert.equal(post.text, PACKED_TITLE)
})

test('a >64-char uploader is refused too — length is the other half of the shape test', () => {
  const post = normalizeFacebook({ title: 't', uploader: 'x'.repeat(65) }, REF)
  assert.equal(post.author.name, 'Facebook')
})

test('description is the caption, and the packed title never becomes the body', () => {
  const post = normalizeFacebook(MEASURED, REF)
  assert.equal(post.text, 'Are you “Disturbed”')
  // NO Post.title: render/text.ts prepends it to og:description, which is exactly how the packed
  // "3.9K reactions · 292 shares | …" reached the measured card.
  assert.equal(post.title, undefined)
  assert.ok(!post.text.includes('3.9K reactions'), 'the counts string must not reach the body')
})

test('an EMPTY description unpacks the packed title, but only on positive evidence of the shape', () => {
  const post = normalizeFacebook({ ...MEASURED, description: undefined }, REF)
  assert.equal(post.text, 'Are you “Disturbed”')
})

test('the unpack keys on startsWith, not equality — "…| Asif Nawab Butt on Reels"', () => {
  // yt-dlp's own fixture shape: the last segment decorates the creator name rather than equalling it.
  const post = normalizeFacebook({
    title: '1.2K views · 30 reactions | some caption | Asif Nawab Butt on Reels',
    uploader: 'Asif Nawab Butt',
  }, REF)
  assert.equal(post.text, 'some caption')
})

test('a title with fewer than 3 " | " segments is passed through VERBATIM', () => {
  const t = 'Just a plain title | PhillyBanana'
  const post = normalizeFacebook({ title: t, uploader: 'PhillyBanana' }, REF)
  assert.equal(post.text, t, 'the no-branch must be exactly the old behaviour')
})

test('the unpack refuses when the last segment is a DIFFERENT creator', () => {
  const t = '3.9K reactions | a caption | Somebody Else'
  const post = normalizeFacebook({ title: t, uploader: 'PhillyBanana', description: '' }, REF)
  assert.equal(post.text, t)
})

test('real dimensions and duration reach the media entry', () => {
  const post = normalizeFacebook(MEASURED, REF)
  assert.equal(post.media[0].w, 576)
  assert.equal(post.media[0].h, 1024)
  assert.equal(post.media[0].duration, 150.209)
})

// 0,0 is what YouTube — the other {page} remux platform — has always shipped, and Discord reads the
// muxed mp4's real dimensions. An earlier version of this line called it "the unknown sentinel dimTags
// now OMITS"; that gate was reverted the same day (see render/embed.ts's dimTags docstring), so the
// claim here is the one that survived: a dimension we do not have never becomes a fractional or
// half-known number, it becomes the pair every other remux platform ships.
test('missing or non-integer dimensions stay 0,0 — the shape every remux platform ships', () => {
  for (const m of [{ title: 't' }, { title: 't', w: 0, h: 0 }, { title: 't', w: 576.5, h: 1024 }]) {
    const post = normalizeFacebook(m, REF)
    assert.equal(post.media[0].w, 0)
    assert.equal(post.media[0].h, 0)
    assert.equal(post.media[0].duration, undefined, 'no duration key rather than a zero one')
  }
})

test('a HALF-known pair degrades to unknown on BOTH — never a 0-by-1024 video', () => {
  // Half a pair is neither a usable aspect ratio nor a clean "we don't know", and it would leave every
  // consumer to re-derive that per field.
  for (const m of [{ title: 't', w: -5, h: 1024 }, { title: 't', w: 576 }, { title: 't', h: 1024 }]) {
    const post = normalizeFacebook(m, REF)
    assert.equal(post.media[0].w, 0)
    assert.equal(post.media[0].h, 0)
  }
})

test('timestamp becomes createdAt; its absence keeps the epoch fallback', () => {
  const post = normalizeFacebook({ ...MEASURED, timestamp: 1784218446 }, REF)
  assert.equal(post.createdAt.toISOString(), '2026-07-16T16:14:06.000Z')
  assert.equal(normalizeFacebook({ title: 't' }, REF).createdAt.getTime(), 0)
})

test('THE NON-ATOMIC DEPLOY: the OLD {title, thumbnail, uploader} dict still makes a card', () => {
  // A pooled container instance keeps running the image it booted with until sleepAfter, so this dict
  // is live for up to ~10 minutes after a redeploy. It must degrade to the old card, never throw.
  const post = normalizeFacebook({ title: 'A funny clip', poster: THUMB, uploader: 'PhillyBanana' }, REF)
  assert.equal(post.author.name, 'PhillyBanana')
  assert.equal(post.text, 'A funny clip')
  assert.deepEqual(post.media, [{ kind: 'video', url: WATCH, w: 0, h: 0, remux: { page: WATCH }, poster: THUMB }])
})

test('normalizeFacebook: no thumbnail -> a posterless video that still plays, no poster key', () => {
  const post = normalizeFacebook({ title: 'clip' }, REF)
  assert.deepEqual(post.media, [{ kind: 'video', url: WATCH, w: 0, h: 0, remux: { page: WATCH } }])
  assert.equal(post.media[0].poster, undefined, 'poster omitted, not a dead /_media/poster target')
})

test('counts stay EMPTY — Facebook only offers a pre-abbreviated localized substring', () => {
  assert.deepEqual(normalizeFacebook(MEASURED, REF).counts, {})
})

test('normalizeFacebook: no metadata (container failed/absent) is a null Post', () => {
  assert.equal(normalizeFacebook(null, REF), null)
})

test('normalizeFacebook refuses a non-fb ref', () => {
  assert.equal(normalizeFacebook({ title: 't', poster: THUMB }, { p: 'yt', id: 'x' }), null)
})

test('normalizeFacebook is TOTAL over junk field types', () => {
  // The container is a passthrough of yt-dlp's JSON; the Worker coerces, but this half must not
  // depend on that having happened.
  const post = normalizeFacebook(
    { title: 't', uploader: 42, uploaderId: 'no spaces allowed!', uploaderUrl: 'javascript:x', description: {}, w: '576', h: null, duration: 'x', timestamp: 'y' },
    REF,
  )
  assert.equal(post.author.name, 'Facebook')
  assert.equal(post.author.url, 'https://www.facebook.com', 'a non-alphanumeric id builds no profile url')
  assert.equal(post.text, 't')
  assert.equal(post.media[0].w, 0)
  assert.equal(post.createdAt.getTime(), 0)
})
