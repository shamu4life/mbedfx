import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeYouTube, withAgeNote, ytAgeRestricted } from '../src/platforms/youtube/normalize.ts'
import { promisable } from '../src/muxpolicy.ts'
import { render } from '../src/render/index.ts'

const ORIGIN = 'https://mbedfx.app'
const REF = { p: 'yt', id: 'G0sORVBL4kM' }

/**
 * THE UNEXPLAINED STILL, reported 2026-07-30 on mbedfx.app/G0sORVBL4kM. The card showed the title
 * and a thumbnail, no player, and a footer date of **12/31/1969** — which reads as our bug rather
 * than as YouTube refusing us.
 *
 * IT WAS TWO SYMPTOMS OF ONE CAUSE. The container's meta call was plain `yt-dlp -J`, which exits
 * non-zero when it can extract no formats, so `check=True` raised and the Worker got NOTHING — no
 * timestamp (hence the epoch date) and no way to tell "gated" from "extraction broke". Adding
 * `--ignore-no-formats-error` returns the whole record anyway. Measured on this exact video:
 *
 *     _type=video  title="E-rotic - Help me Dr. Dick (original music video)"
 *     duration=177  timestamp=1605871096  age_limit=18  formats=0
 *
 * WHY IT WILL NEVER PLAY, so nobody re-tests hoping. yt-dlp's age-gate bypass died in 2024.10.22
 * (`ec2f4bf08`, "Remove broken age-restriction workaround") when YouTube made
 * TVHTML5_SIMPLY_EMBEDDED_PLAYER require sign-in for every video; `tv_embedded` was deleted in
 * 2026.01.31. A partial bypass survives via `web_embedded` — but ONLY for videos whose uploader
 * allows embedding, verified working cookie-free on 2026-07-30. This video has embedding disabled,
 * so it is unplayable without a credential, reproduced from residential egress too.
 */

const gated = extra => ({ ok: true, oembed: {
  title: 'E-rotic - Help me Dr. Dick (original music video)',
  author_name: 'E-rotic - official',
  author_url: 'https://www.youtube.com/@e-rotic-official8316',
  thumbnail_url: 'https://i.ytimg.com/vi/G0sORVBL4kM/hqdefault.jpg',
}, uploadedAt: 1605871096, ...extra })

test('ytAgeRestricted: ANY threshold above zero is a gate, and junk is not', () => {
  // Not hardcoded to 18 — yt-dlp reports the uploader's actual threshold.
  assert.equal(ytAgeRestricted({ ok: true, oembed: {}, ageLimit: 18 }), true)
  assert.equal(ytAgeRestricted({ ok: true, oembed: {}, ageLimit: 21 }), true)
  assert.equal(ytAgeRestricted({ ok: true, oembed: {}, ageLimit: 0 }), false, 'zero is the normal case')
  for (const junk of [undefined, null, NaN, Infinity, '18', {}]) {
    assert.equal(ytAgeRestricted({ ok: true, oembed: {}, ageLimit: junk }), false, `${String(junk)} is not a gate`)
  }
  assert.equal(ytAgeRestricted({ ok: false }), false)
  assert.doesNotThrow(() => ytAgeRestricted(undefined))
})

test('THE CARD KEEPS EVERYTHING AND GAINS A NOTE — not a wall', () => {
  /**
   * The owner's call, and the right one: a wall card (Instagram's shape, where the whole post is
   * replaced) would throw away title, author, thumbnail and date that we can see perfectly well.
   */
  const post = normalizeYouTube(gated({ ageLimit: 18 }), REF)
  assert.equal(post.title, 'E-rotic - Help me Dr. Dick (original music video)', 'the title survives')
  assert.equal(post.author.name, 'E-rotic - official', 'the author survives')
  assert.equal(post.author.handle, 'e-rotic-official8316', 'and the real handle, not the display name')
  assert.ok(post.media[0]?.poster, 'the thumbnail survives')
  assert.match(post.text, /^🔞 Age-restricted on YouTube/, 'and the note is added')
})

test('THE NOTE IS IN THE BODY, NEVER THE TITLE', () => {
  // Overwriting the title would lose the one thing the reader came for.
  const post = normalizeYouTube(gated({ ageLimit: 18 }), REF)
  assert.doesNotMatch(post.title, /🔞|age/i)
})

test('THE DATE IS REAL — the 12/31/1969 in the report is gone', () => {
  const post = normalizeYouTube(gated({ ageLimit: 18 }), REF)
  assert.notEqual(post.createdAt.getTime(), 0, 'not the epoch that produced 12/31/1969')
  assert.equal(post.createdAt.toISOString().slice(0, 10), '2020-11-20')
})

test('AN ORDINARY VIDEO IS COMPLETELY UNTOUCHED', () => {
  // The whole change is additive; it must be invisible unless the gate is real.
  const plain = normalizeYouTube(gated({}), REF)
  assert.equal(plain.text, '', 'no note')
  assert.equal(plain.sensitive, false, 'not flagged')
  assert.equal(plain.title, 'E-rotic - Help me Dr. Dick (original music video)')
  assert.equal(normalizeYouTube(gated({ ageLimit: 0 }), REF).text, '', 'age_limit 0 is the normal case')
})

test('AN AGE-GATED POST IS MARKED SENSITIVE — the platform said so', () => {
  assert.equal(normalizeYouTube(gated({ ageLimit: 18 }), REF).sensitive, true)
})

test('THE NOTE REACHES A RENDERED CARD, and promises no retry', async () => {
  /**
   * The note must not imply a warm-up state. This is not the mux race that self-heals on a second
   * paste — the video is permanently unfetchable — and a hopeful message costs someone a re-test.
   */
  const post = normalizeYouTube(gated({ ageLimit: 18 }), REF)
  const html = await render({ kind: 'post', post }, 'other-bot', ORIGIN).text()
  assert.match(html, /Age-restricted on YouTube/, 'the reader is told why')
  assert.doesNotMatch(html, /try again|retry|loading|processing/i, 'and is not promised a retry')
  // The title is still the headline of the card.
  assert.match(html, /Help me Dr\. Dick/)
})

test('AN AGE-GATED ENTRY IS MARKED gated, AND IS THEREFORE NEVER PROMISED', () => {
  /**
   * THE PLAY BUTTON THAT PLAYED NOTHING — reported by the owner 2026-09-12, measured the same day
   * against production on this exact video:
   *
   *   activity doc  type:"video"  url .../_media/yt%3AG0sORVBL4kM/0  meta:null
   *   GET that url  ->  HTTP 503, 0 bytes  (and always will: there is no age-gate bypass)
   *   GET poster0   ->  302 to i.ytimg.com/vi/G0sORVBL4kM/hqdefault.jpg, fine
   *
   * Discord drew a player over a slot that can never answer, and with meta:null it had no size to
   * lay the attachment out with either — types.ts's 2026-07-31 measurement is that Discord "will not
   * lay out an IMAGE attachment it has no size for, so it drew nothing at all". Hence the second
   * half of the report: "and then the gallery has nothing".
   *
   * THE CAUSE WAS promisable(). 1.15.0 lets the activity document PROMISE a video whose mux is still
   * running, and the promise is gated on `!live` and a duration inside 240s. This video's duration is
   * 177s (recorded in the header above, straight off yt-dlp) — an ordinary number, comfortably inside
   * the window — so it was promised. promisable()'s own docstring already stated the rule it was
   * missing: "A promise that cannot be kept is frozen in Discord's message forever."
   *
   * MUTATION-CHECKED: dropping `m.gated` from either promisable() or normalizeYouTube's media entry
   * turns this red.
   */
  const post = normalizeYouTube(gated({ ageLimit: 18, duration: 177 }), REF)
  const m = post.media[0]
  assert.equal(m.gated, true, 'the entry itself must carry the fact, not just the post')
  assert.equal(m.kind, 'video', 'it is still a video in the POST — the degrade is the renderer\'s job')
  assert.ok(m.remux?.page, 'and it keeps its remux, exactly as a live entry does')
  assert.equal(promisable(m), false, 'but it must never be promised: the mux can never succeed')

  // An ordinary video carries no flag at all — the change is additive and invisible without a gate.
  assert.equal(normalizeYouTube(gated({}), REF).media[0].gated, undefined)
  assert.equal(normalizeYouTube(gated({ ageLimit: 0 }), REF).media[0].gated, undefined, 'age_limit 0 is normal')

  /**
   * THE CONTROL, and it must be built by hand rather than by the normalizer: normalizeYouTube does
   * NOT stamp `duration` onto the entry (withMuxDuration does that later, from the container's
   * answer), so `normalizeYouTube(...).media[0]` is unpromisable for a reason that has nothing to do
   * with the gate. Asserting promisable()===false on it would have been a test that passed without
   * the fix. The duration is the one from the fixture header: 177s, straight off yt-dlp, comfortably
   * inside the 240s window — which is exactly why this video was promised before the fix.
   */
  assert.equal(promisable({ ...m, duration: 177 }), false, 'gated: refused despite an ordinary duration')
  assert.equal(promisable({ ...m, duration: 177, gated: undefined }), true,
    'the SAME entry without the gate is promised, so the gate is what refused it')
})

test('ONCE DEGRADED, AN AGE-GATED CARD IS A PICTURE AND NO PLAYER', async () => {
  /**
   * The rendered half of the report. The DOCUMENT half — the seam Discord actually draws, and the
   * one that was broken — is asserted in test/card-promise.test.mjs beside the safety valve that let
   * it through, because only that file drives the real settleMux.
   *
   * RENDERED FROM THE DEGRADED ENTRY, which is what every production render is handed: settleMux's
   * `gated` arm rewrites the video to a posterOnly still before any renderer sees it. Feeding
   * render() the RAW normalizer output instead would assert a state the Worker never produces, and
   * it is a state whose head is wrong in an uninteresting way (og:video at the video slot, w=0) for
   * a reason no live path can reach.
   */
  const raw = normalizeYouTube(gated({ ageLimit: 18, duration: 177 }), REF)
  const m = raw.media[0]
  // The exact shape stillOf produces, spelled here rather than imported: worker.ts does not export
  // it, and test/degraded-still-slot.test.mjs already keeps a hand-written copy for the same reason.
  const post = { ...raw, media: [{ kind: 'image', url: m.poster, poster: m.poster, w: m.posterW, h: m.posterH, posterOnly: true, gated: true }] }

  const html = await render({ kind: 'post', post }, 'other-bot', ORIGIN).text()
  assert.doesNotMatch(html, /og:video/, 'no og:video on a card whose video can never exist')
  assert.doesNotMatch(html, /twitter:player/, 'and no player card either')
  assert.match(html, /og:image[^>]*\/poster0"/, 'the picture is the POSTER slot, which serves real bytes')
  assert.match(html, /og:image:width" content="480"/, 'with the poster\'s own dimensions, not the video\'s 0x0')
  assert.match(html, /Age-restricted on YouTube/, 'and the reason is on the card')
})

test('normalizeYouTube stays TOTAL when the meta call gave nothing at all', () => {
  // The container can still fail outright (no binding, timeout). That path is unchanged: no note,
  // and the pre-existing epoch fallback rather than a throw.
  const bare = normalizeYouTube({ ok: false }, REF)
  assert.equal(bare.text, '')
  assert.equal(bare.sensitive, false)
  assert.equal(bare.createdAt.getTime(), 0)
  assert.doesNotThrow(() => bare.createdAt.toISOString())
})

/**
 * THE LATE OVERLAY, and without it the note MOSTLY NEVER FIRES.
 *
 * `ageLimit` reaches normalizeYouTube only from the WARM meta record, and on a FIRST paste there is
 * no warm record: the container call is dispatched and lands after the Post is built. Measured on
 * prod 2026-07-30 immediately after the container rebuild — the date had corrected itself to
 * 2020-11-20 (it already had this seam, youtubeMeta -> withUploadDate) while the note was still
 * absent, because only the date rode the overlay. Without the sibling below, the note appears only
 * once POST_TTL (900s) expires and the post is re-normalized: fifteen minutes later, which is
 * exactly when nobody is looking at the card.
 */
test('withAgeNote: prepends, keeps existing body, and never double-marks', () => {
  const base = { text: '', sensitive: false }
  const marked = withAgeNote(base, 18)
  assert.match(marked.text, /^🔞 Age-restricted on YouTube/)
  assert.equal(marked.sensitive, true)

  // The owner's requirement was KEEP THE CARD AND ADD TO IT — an existing body survives, below the note.
  const withBody = withAgeNote({ text: 'a real caption', sensitive: false }, 18)
  assert.match(withBody.text, /^🔞 Age-restricted on YouTube/)
  assert.match(withBody.text, /a real caption$/)

  // Idempotent: the overlay can run on a post normalizeYouTube already marked.
  assert.equal(withAgeNote(marked, 18).text, marked.text, 'not double-marked')
  assert.equal(withAgeNote(marked, 18), marked, 'and the same object reference back')
})

test('withAgeNote is TOTAL and NON-DESTRUCTIVE — same contract as withUploadDate', () => {
  const base = { text: 'keep me', sensitive: false }
  for (const junk of [undefined, null, 0, -1, NaN, Infinity, '18', {}]) {
    assert.equal(withAgeNote(base, junk), base, `${String(junk)} returns the SAME object reference`)
  }
  assert.equal(withAgeNote(null, 18), null)
  assert.equal(withAgeNote(undefined, 18), undefined)
  assert.doesNotThrow(() => withAgeNote({}, 18))
})
