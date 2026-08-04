import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeYouTube, uploadDateFrom, withCounts, withDescription, withUploadDate, youtubeVouched,
  ytHandle,
  YT_FALLBACK_AUTHOR_URL,
} from '../src/platforms/youtube/normalize.ts'

const REF = { p: 'yt', id: 'dQw4w9WgXcQ' }
const CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const THUMB = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'

test('normalizeYouTube: oembed enriches title/author; the video is a remux {page} with the thumbnail poster', () => {
  const oembed = {
    title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley',
    author_url: 'https://www.youtube.com/@RickAstley', thumbnail_url: THUMB, type: 'video',
  }
  const post = normalizeYouTube({ ok: true, oembed }, REF)
  assert.equal(post.title, 'Rick Astley - Never Gonna Give You Up')
  assert.equal(post.author.name, 'Rick Astley')
  assert.equal(post.author.url, 'https://www.youtube.com/@RickAstley')
  assert.equal(post.canonical, CANON)
  // The container's yt-dlp resolves the watch PAGE to a real (ad-free) mp4 → Discord's native player.
  // posterW/posterH are the POSTER's size, not the video's. A remux video keeps w/h of 0 so Discord
  // reads the muxed mp4 and a Short plays portrait; the STILL that settleMux degrades it to needs a
  // size of its own, or mastodon.ts omits meta.original and Discord draws no picture. See Media.posterW.
  assert.deepEqual(post.media, [{ kind: 'video', url: CANON, w: 0, h: 0, poster: THUMB, posterW: 480, posterH: 360, remux: { page: CANON } }])
  assert.equal(post.ref.p, 'yt')
})

test('THE UPLOAD DATE REACHES THE CARD — it used to always render 1 January 1970', () => {
  /**
   * The defect this pins, reported from a live embed 2026-07-25: createdAt was a hardcoded
   * `new Date(0)`, render/mastodon.ts maps it straight into the spoof's `created_at`, and that is
   * the field Discord draws the card timestamp from — so EVERY YouTube embed displayed the Unix
   * epoch. oembed genuinely has no date field, so the value now comes from the watch page's own
   * <meta itemprop="datePublished">, captured verbatim here from the real markup.
   */
  const oembed = { title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley' }
  const post = normalizeYouTube({ ok: true, oembed, uploadedAt: '2009-10-24T23:57:33-07:00' }, REF)
  assert.equal(post.createdAt.toISOString(), '2009-10-25T06:57:33.000Z', 'the offset is honoured, not dropped')
  assert.notEqual(post.createdAt.getTime(), 0, 'the whole point: not the epoch')
})

test('uploadDateFrom: the container NUMBER and the watch-page STRING pin to the SAME instant', () => {
  /**
   * Both values are REAL CAPTURES, 2026-07-26. The string is the watch-page markup the first fix read
   * (still the fixture in the test above); the numbers are `yt-dlp -J`'s `timestamp` for the same and
   * the oldest video on the platform. Asserting them side by side is what proves the container is a
   * DROP-IN for the source it replaced rather than a different notion of "the date":
   *   Date.parse('2009-10-24T23:57:33-07:00') / 1000 === 1256453853.
   */
  assert.equal(uploadDateFrom(1256453853).toISOString(), '2009-10-25T06:57:33.000Z', 'dQw4w9WgXcQ')
  assert.equal(uploadDateFrom(1114313512).toISOString(), '2005-04-24T03:31:52.000Z', 'jNQXAC9IVRw, 2005')
  assert.equal(
    uploadDateFrom('2009-10-24T23:57:33-07:00').getTime(), uploadDateFrom(1256453853).getTime(),
    'the retired watch-page string and the container number are the same instant',
  )
})

test('uploadDateFrom is TOTAL over junk — every non-date is null, and nothing throws', () => {
  const junk = [
    NaN, Infinity, -Infinity, 0, -1, '', null, undefined, {}, [], true,
    'not a date', '2026-13-45T99:99:99Z',
    // MILLISECONDS MISTAKEN FOR SECONDS — the unit slip a numeric field invites, and the reason the
    // range guard exists at all: worker.ts PERSISTS a validated value for 30 days.
    4102444800000, 1_000_000_000_000,
  ]
  for (const bad of junk) {
    assert.equal(uploadDateFrom(bad), null, `${JSON.stringify(bad) ?? String(bad)} is not a date`)
  }
})

test('uploadDateFrom: the RANGE guard — before YouTube existed, or in the future, is refused', () => {
  const now = Date.UTC(2026, 6, 26)
  // 2005-02-14 is the day youtube.com was registered; nothing uploaded there predates it.
  assert.equal(uploadDateFrom(Date.UTC(2005, 1, 13) / 1000, now), null, 'a day before the floor')
  assert.ok(uploadDateFrom(Date.UTC(2005, 1, 15) / 1000, now), 'a day after the floor is fine')
  assert.equal(uploadDateFrom(now / 1000 + 86_400 * 2, now), null, 'two days in the future')
  assert.ok(uploadDateFrom(now / 1000 - 60, now), 'a minute ago is fine')
  // The string path gets the identical guard — one function, one rule, both sources.
  assert.equal(uploadDateFrom('1999-01-01T00:00:00Z', now), null, 'an in-range-looking string is still ranged')
})

test('withUploadDate is TOTAL and NON-DESTRUCTIVE — junk returns the same object reference', () => {
  const epochPost = normalizeYouTube({ ok: true, oembed: { title: 't' } }, REF)
  assert.equal(epochPost.createdAt.getTime(), 0)
  for (const bad of [null, undefined, 'nope', NaN, 0, {}]) {
    assert.equal(withUploadDate(epochPost, bad), epochPost, `${String(bad)} must not clone the post`)
  }
  const filled = withUploadDate(epochPost, 1256453853)
  assert.equal(filled.createdAt.toISOString(), '2009-10-25T06:57:33.000Z')
  assert.equal(epochPost.createdAt.getTime(), 0, 'the input is not mutated')

  // A post that ALREADY has a real date is never overwritten — the fetch-time cache read fills most
  // of them, and this seam exists only for the ones whose container answer landed late.
  assert.equal(withUploadDate(filled, 1114313512), filled, 'a real date wins over a later answer')
})

test('youtubeVouched: only oembed answering for the id unlocks a container call', () => {
  const real = normalizeYouTube({
    ok: true, oembed: { title: 'Rick Astley', author_url: 'https://www.youtube.com/@RickAstley' },
  }, REF)
  assert.equal(youtubeVouched(real), true, 'a real oembed author_url is the vouch')

  const miss = normalizeYouTube({ ok: false }, REF)
  assert.equal(miss.author.url, YT_FALLBACK_AUTHOR_URL, 'the fallback is the exported constant')
  assert.equal(youtubeVouched(miss), false, 'the oembed-miss fallback post must NOT be vouched')

  // Total over the shapes a cache record can hold, and refuses a foreign platform outright.
  for (const bad of [null, undefined, {}, { ref: { p: 'yt' } }, { ref: { p: 'x' }, author: { url: 'https://x.com/a' } }]) {
    assert.equal(youtubeVouched(bad), false, `${JSON.stringify(bad)} is not a vouched yt post`)
  }
})

test('the date is TOTAL over junk — an unparseable one can never throw on the response path', () => {
  // `new Date(NaN).toISOString()` THROWS, and render/mastodon.ts calls exactly that while building
  // the response — so an unparseable date would be a 500 on a public route, not a missing timestamp.
  for (const bad of ['not a date', '', null, undefined, 42, {}, '2026-13-45T99:99:99Z']) {
    const post = normalizeYouTube({ ok: true, oembed: { title: 't' }, uploadedAt: bad }, REF)
    assert.equal(post.createdAt.getTime(), 0, `${JSON.stringify(bad)} falls back to the epoch`)
    assert.doesNotThrow(() => post.createdAt.toISOString(), 'must never be an Invalid Date')
  }
})

test('a fetch miss keeps the epoch fallback — reached on failure now, not on every video', () => {
  const post = normalizeYouTube({ ok: false }, REF)
  assert.equal(post.createdAt.getTime(), 0)
  assert.doesNotThrow(() => post.createdAt.toISOString())
})

test('normalizeYouTube: a fetch MISS still renders — id-derived thumbnail + remux, fallback copy', () => {
  const post = normalizeYouTube({ ok: false }, REF)
  assert.equal(post.title, 'YouTube video')
  assert.equal(post.author.name, 'YouTube')
  // Even with no oEmbed answer the poster size is known: hqdefault is always 480x360, verified by
  // decoding the JPEG's own SOF header rather than trusting the API that did not respond.
  assert.deepEqual(post.media[0], { kind: 'video', url: CANON, w: 0, h: 0, poster: THUMB, posterW: 480, posterH: 360, remux: { page: CANON } })
})

test('normalizeYouTube is TOTAL over junk oembed and refuses a non-yt ref', () => {
  for (const bad of [{ ok: true, oembed: null }, { ok: true, oembed: 42 }, { ok: true, oembed: {} }, { ok: true, oembed: [] }]) {
    const p = normalizeYouTube(bad, REF)
    assert.equal(p.title, 'YouTube video', 'junk oembed degrades to the fallback title, never throws')
    assert.equal(p.media[0].remux.page, CANON)
    assert.equal(p.media[0].poster, THUMB)
  }
  assert.equal(normalizeYouTube({ ok: false }, { p: 'rd', sub: 'x', id: 'y' }), null, 'a non-yt ref is not ours')
})

/**
 * THE DUPLICATED HANDLE, reported 2026-07-29 on /wIfvcWCZZ7w.
 *
 * `author: { name, handle: author }` rendered EVERY YouTube card as "Name (@Name)" —
 * `Rick Astley (@Rick Astley)` on prod — and on a channel whose display name carries punctuation it
 * reads as a broken card: `uwu • (@uwu •)`. It also shipped that string into twitter:site and
 * twitter:creator, where a handle containing a SPACE and a bullet is malformed outright.
 *
 * oEmbed had the real handle the whole time. Measured on the reported video:
 *   author_name "uwu •"   author_url "https://www.youtube.com/@uwu-lf9yw"
 */
test('ytHandle reads the @handle out of author_url', () => {
  assert.equal(ytHandle('https://www.youtube.com/@uwu-lf9yw'), 'uwu-lf9yw')
  assert.equal(ytHandle('https://www.youtube.com/@RickAstleyYT'), 'RickAstleyYT')
  assert.equal(ytHandle('https://www.youtube.com/@a.b_c-d'), 'a.b_c-d')
})

test('ytHandle returns it WITHOUT the @ — every consumer re-adds one', () => {
  // Returning '@uwu-lf9yw' here ships `(@@uwu-lf9yw)` in the byline and `@@…` in twitter:site.
  assert.doesNotMatch(ytHandle('https://www.youtube.com/@uwu-lf9yw'), /^@/)
})

test('ytHandle declines anything that is not a first-segment handle', () => {
  // A channel addressed the old way has no @ form at all.
  assert.equal(ytHandle('https://www.youtube.com/channel/UCuld1tLZbOcL08Cn1TqhbUg'), '')
  assert.equal(ytHandle('https://www.youtube.com/user/somebody'), '')
  assert.equal(ytHandle(YT_FALLBACK_AUTHOR_URL), '', 'the oembed-missed fallback has none')
  // Only the FIRST segment counts, so a later @ is not a handle.
  assert.equal(ytHandle('https://www.youtube.com/watch/@notahandle'), '')
  // Outside YouTube's handle alphabet, or outside its length bounds.
  assert.equal(ytHandle('https://www.youtube.com/@ab'), '', 'too short')
  assert.equal(ytHandle('https://www.youtube.com/@' + 'x'.repeat(31)), '', 'too long')
  assert.equal(ytHandle('https://www.youtube.com/@uwu •'), '', 'a space is not in the alphabet')
  assert.equal(ytHandle('https://www.youtube.com/@a/../b'), '')
})

test('ytHandle is TOTAL over junk — a malformed author_url is empty, not a throw', () => {
  for (const junk of ['', 'not a url', '///', 'javascript:alert(1)', '@bare']) {
    assert.doesNotThrow(() => ytHandle(junk))
    assert.equal(ytHandle(junk), '', `${JSON.stringify(junk)} yields no handle`)
  }
})

test('the card carries the real handle, and falls back to the NAME rather than blanking', () => {
  const withHandle = normalizeYouTube(
    { ok: true, oembed: { title: 't', author_name: 'uwu •', author_url: 'https://www.youtube.com/@uwu-lf9yw' } },
    { p: 'yt', id: 'wIfvcWCZZ7w' },
  )
  assert.equal(withHandle.author.name, 'uwu •', 'the display name is untouched')
  assert.equal(withHandle.author.handle, 'uwu-lf9yw', 'and the handle is no longer a copy of it')
  assert.notEqual(withHandle.author.handle, withHandle.author.name)

  // TODAY'S OUTPUT IS THE FLOOR: a channel with no @ form keeps the old behaviour rather than
  // rendering an empty `(@)`. This can only improve a card, never blank one.
  const noHandle = normalizeYouTube(
    { ok: true, oembed: { title: 't', author_name: 'Some Channel', author_url: 'https://www.youtube.com/channel/UC123' } },
    REF,
  )
  assert.equal(noHandle.author.handle, 'Some Channel')
  // And with no oembed at all, the whole author degrades exactly as before.
  const bare = normalizeYouTube({ ok: false }, REF)
  assert.equal(bare.author.name, 'YouTube')
  assert.equal(bare.author.handle, 'YouTube')
  assert.equal(bare.author.url, YT_FALLBACK_AUTHOR_URL)
})

/* ===================== THE DESCRIPTION ============================================
 *
 * REPORTED 2026-08-01: a YouTube card in Discord showed a title and an uploader and
 * NOTHING ELSE. normalizeYouTube hardcoded `text: ''` for every ordinary video, so no
 * description could render on any route, for any video, ever — while the container had
 * been sending one the whole time (container/server.py's _meta_page carries
 * `description`; the worker's YouTubeMeta type simply had no field to receive it).
 */

const OE = {
  title: 'Rick Astley - Never Gonna Give You Up', author_name: 'Rick Astley',
  author_url: 'https://www.youtube.com/@RickAstley', thumbnail_url: THUMB, type: 'video',
}

test('THE DESCRIPTION BECOMES THE BODY', () => {
  const post = normalizeYouTube({ ok: true, oembed: OE, description: 'The official video.' }, REF)
  assert.equal(post.text, 'The official video.')
  assert.equal(post.title, 'Rick Astley - Never Gonna Give You Up', 'the title is untouched')
})

test('NO DESCRIPTION IS STILL AN EMPTY BODY, not the string "undefined"', () => {
  for (const got of [
    { ok: true, oembed: OE },
    { ok: true, oembed: OE, description: null },
    { ok: true, oembed: OE, description: '' },
    { ok: true, oembed: OE, description: '   ' },
    { ok: true, oembed: OE, description: 42 },
    { ok: false },
  ]) {
    assert.equal(normalizeYouTube(got, REF).text, '', `${JSON.stringify(got.description)} is no body`)
  }
})

test('A DESCRIPTION SURVIVES AN OEMBED MISS — the two facts are independent', () => {
  /**
   * The same argument the date already makes in this file. The description comes from the
   * container's meta record, which the worker may hold when oembed transiently fails; gating one on
   * the other would throw away a body we are already holding, for the whole POST_TTL.
   */
  const post = normalizeYouTube({ ok: false, description: 'Still a description.' }, REF)
  assert.equal(post.text, 'Still a description.')
})

test('THE AGE NOTE KEEPS THE TOP, and does not lose the description', () => {
  const post = normalizeYouTube({ ok: true, oembed: OE, ageLimit: 18, description: 'Ignore me.' }, REF)
  assert.match(post.text, /^🔞 Age-restricted/, 'the note leads')
  assert.equal(post.sensitive, true)
})

// ---- withDescription: the first-paste overlay -------------------------------------

test('withDescription FILLS AN EMPTY BODY, which is the whole point of the overlay', () => {
  /**
   * The Post is built by getPost BEFORE the container's meta extract resolves, so on a cold video
   * the body is empty at build time. Without this overlay the description stays invisible for the
   * whole POST_TTL even though the worker is holding it — the defect withAgeNote's history records.
   */
  const base = { text: '', ref: { p: 'yt', id: 'x' } }
  assert.equal(withDescription(base, 'hello').text, 'hello')
})

test('withDescription NEVER OVERWRITES A BODY THAT EXISTS', () => {
  // The only writer that gets in first is the age note, and it must keep the top.
  const gatedPost = { text: '🔞 Age-restricted on YouTube — sign-in required, so no preview here.', ref: { p: 'yt', id: 'x' } }
  assert.equal(withDescription(gatedPost, 'a description'), gatedPost, 'same reference back')
})

test('withDescription IS TOTAL OVER JUNK and returns the SAME reference when idle', () => {
  const base = { text: '', ref: { p: 'yt', id: 'x' } }
  for (const junk of [undefined, null, '', '   ', 42, {}, []]) {
    assert.equal(withDescription(base, junk), base, `${String(junk)} changes nothing`)
  }
  assert.equal(withDescription(null, 'x'), null, 'a null post must not throw')
})

/* ===================== THE COUNTS ==================================================
 *
 * `counts: {}` was hardcoded until 2026-08-01, and unlike the description that was not
 * an oversight: there was nowhere to get them. oEmbed carries none and the container's
 * meta dict did not either. Both ends were added together.
 */

test('COUNTS COME THROUGH, and a zero is DROPPED rather than drawn', () => {
  /**
   * THE LIE THIS PREVENTS. yt-dlp reports null for a like count a channel has hidden and for a
   * comment count on a video with comments disabled — those are NOT zero. "0 comments" on a video
   * where commenting is switched off is a confident falsehood; an absent count renders as nothing,
   * which is the truth.
   */
  const got = { ok: true, oembed: OE, counts: { views: 1000, likes: 50, replies: 0 } }
  const post = normalizeYouTube(got, REF)
  assert.equal(post.counts.views, 1000)
  assert.equal(post.counts.likes, 50)
  assert.equal(post.counts.replies, undefined, 'a zero is absence, not a count')
})

test('NO COUNTS IS AN EMPTY OBJECT, never NaN or a string', () => {
  for (const counts of [undefined, null, {}, 'nope', 42, { likes: 'many' }, { likes: NaN }, { likes: -3 }]) {
    const post = normalizeYouTube({ ok: true, oembed: OE, counts }, REF)
    assert.deepEqual(post.counts, {}, `${JSON.stringify(counts)} yields no counts`)
  }
})

test('withCounts FILLS ONLY WHAT IS MISSING — the first-paste overlay', () => {
  const base = { text: '', counts: { likes: 7 }, ref: { p: 'yt', id: 'x' } }
  const out = withCounts(base, { likes: 999, views: 12, replies: 3 })
  assert.equal(out.counts.likes, 7, 'an existing count is never overwritten')
  assert.equal(out.counts.views, 12)
  assert.equal(out.counts.replies, 3)
})

test('withCounts IS TOTAL and returns the SAME reference when idle', () => {
  const base = { text: '', counts: {}, ref: { p: 'yt', id: 'x' } }
  for (const junk of [undefined, null, 'x', 42, {}, { likes: 0 }, { likes: null }]) {
    assert.equal(withCounts(base, junk), base, `${JSON.stringify(junk)} changes nothing`)
  }
  assert.equal(withCounts(null, { likes: 1 }), null, 'a null post must not throw')
})

test('uploadDateFrom READS yt-dlp\'s COMPACT YYYYMMDD, at UTC midnight', () => {
  /**
   * THE THIRD SHAPE, added 2026-08-04. yt-dlp's `upload_date` is a bare `'20091025'`, and
   * `Date.parse('20091025')` is NaN — so a perfectly good date read as no date at all, on every
   * response where `timestamp` was absent.
   *
   * UTC IS THE ASSERTION, not an implementation detail. `Date.parse` on a bare `YYYY-MM-DD` is
   * defined as UTC while `YYYY-MM-DDT00:00:00` without a zone is LOCAL — one character apart, and the
   * difference is a whole day's error for anyone west of Greenwich. This test fails on a machine in
   * any timezone if that ever gets "tidied".
   */
  assert.equal(uploadDateFrom('20091025')?.toISOString(), '2009-10-25T00:00:00.000Z')
  assert.equal(uploadDateFrom('20050214')?.toISOString(), '2005-02-14T00:00:00.000Z', 'the floor day itself')

  // The existing shapes are untouched — this is an addition, not a replacement.
  assert.equal(uploadDateFrom(1256453853)?.toISOString(), '2009-10-25T06:57:33.000Z', 'epoch seconds')
  assert.equal(uploadDateFrom('2009-10-25T06:57:33Z')?.toISOString(), '2009-10-25T06:57:33.000Z', 'ISO')

  // And the guards still hold. An 8-digit string that is not a date must not become one.
  assert.equal(uploadDateFrom('20091345'), null, 'month 13 is not a date')
  assert.equal(uploadDateFrom('00000000'), null, 'and neither is this')
  assert.equal(uploadDateFrom('19991231'), null, 'below the 2005 floor — before any of these sites existed')
  assert.equal(uploadDateFrom('12345678'), null)
  // A NUMBER of eight digits is still epoch SECONDS (1975), not a packed date — the two shapes must
  // not blur into each other. Rejected by the floor, as it always was.
  assert.equal(uploadDateFrom(20091025), null)
})
