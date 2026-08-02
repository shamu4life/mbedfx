import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toMastodonStatus } from '../src/render/mastodon.ts'
import { render } from '../src/render/index.ts'
import { bytesIndex } from '../src/render/embed.ts'

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'

/**
 * THE INVISIBLE YOUTUBE CARD, reported 2026-07-29 on /watch?v=Jky5ZXI0axc — a card with NO og:video
 * AND NO picture, i.e. a bare title+description box in Discord.
 *
 * THE CHAIN, all measured:
 *  1. container/server.py caps MAX_SECONDS=1200. That video is 1431s (public, 20 formats, nothing
 *     gated), so yt-dlp's own --match-filter refuses it — correctly, and permanently: the mux can
 *     never land, so this is not the cold-start race settleMux was built for.
 *  2. settleMux degrades the entry to its poster still. Correct.
 *  3. But it rewrote the entry WITHOUT MOVING IT, and every renderer mints a picture url from the
 *     array POSITION. Position 0 is the VIDEO slot.
 *  4. The /_media/ route re-derives the post (a degraded card is deliberately not response-cached),
 *     finds the remux video at 0, fails the mux again, and answers notReady() — 503 no-store. That
 *     503 is CORRECT and must stay: it is the 2026-07-24 fix for a video url that 302'd to an image
 *     and got permanently cached by Discord as "this video is an image".
 *  5. So the card advertised an IMAGE url that 503s. Measured on prod:
 *         /_media/yt%3AJky5ZXI0axc/0        -> 503  (three times; permanent)
 *         /_media/yt%3AJky5ZXI0axc/poster0  -> 302 -> i.ytimg.com/.../hqdefault.jpg
 *     The right still was reachable the whole time; the card named the wrong one of two correct urls.
 *
 * THE FIX CHANGES NO URL'S CONTENTS — only which url a DEGRADED card names. `{i}` stays
 * video-bytes-or-503 forever; `poster{i}` stays an image. The two classes remain disjoint, which is
 * what Discord's per-url media cache needs.
 */

/** The exact shape settleMux now produces for a degraded `{page}` remux. */
const DEGRADED = {
  ref: { p: 'yt', id: 'Jky5ZXI0axc' },
  canonical: 'https://www.youtube.com/watch?v=Jky5ZXI0axc',
  author: { name: 'zekerags', handle: 'zekerags', url: 'https://www.youtube.com/@zekerags' },
  title: 'Waffle House Training - Pull Drop Mark Order Calling Method',
  text: '',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [{
    kind: 'image',
    url: 'https://i.ytimg.com/vi/Jky5ZXI0axc/hqdefault.jpg',
    poster: 'https://i.ytimg.com/vi/Jky5ZXI0axc/hqdefault.jpg',
    w: 0,
    h: 0,
    posterOnly: true,
  }],
  counts: {},
  sensitive: false,
}

/** An ordinary image post — the regression control. It must keep the BARE index. */
const PLAIN_IMAGE = {
  ...DEGRADED,
  ref: { p: 'pn', id: '66287425756772418' },
  media: [{ kind: 'image', url: 'https://i.pinimg.com/originals/a.jpg', w: 1152, h: 620 }],
}

test('THE DEGRADED STILL IS ADDRESSED AT poster0, NOT AT THE 503-ING VIDEO SLOT', () => {
  /**
   * This is the assertion that FAILS on the pre-fix code, where the attachment url was
   * `/_media/yt%3AJky5ZXI0axc/0` — verified against production, which answered it 503.
   */
  const status = toMastodonStatus(DEGRADED, ORIGIN)
  const [a] = status.media_attachments
  assert.equal(a.type, 'image', 'the degrade produces an image attachment')
  assert.match(a.url, /\/poster0$/, 'its bytes are at the poster slot')
  assert.doesNotMatch(a.url, /\/0$/, 'and NOT at the video slot, which answers 503 no-store')
  assert.match(a.preview_url, /\/poster0$/, 'the preview too — both keys were pointing at /0')
})

test('AN ORDINARY IMAGE KEEPS THE BARE INDEX — no regression on the common case', () => {
  const [a] = toMastodonStatus(PLAIN_IMAGE, ORIGIN).media_attachments
  assert.match(a.url, /\/0$/, 'a normal image is still addressed by its array position')
  assert.doesNotMatch(a.url, /poster0/)
})

test('bytesIndex: ALL THREE GUARDS ARE LOAD-BEARING', () => {
  const still = { kind: 'image', url: 'https://x.tld/a.jpg', poster: 'https://x.tld/a.jpg', posterOnly: true }
  assert.deepEqual(bytesIndex(still, 0), { poster: 0 }, 'the flagged still gets the poster slot')

  // 1. The flag is the signal — without it, nothing changes.
  assert.equal(bytesIndex({ kind: 'image', url: 'https://x.tld/a.jpg', poster: 'https://x.tld/a.jpg' }, 0), 0)

  // 2. A poster is REQUIRED: pickMedia's poster branch has no fallback to m.url, so minting a slot
  //    for a posterless entry would advertise a guaranteed 404 — the og:image=".../undefined/avatar"
  //    scar this codebase already wears.
  assert.equal(bytesIndex({ kind: 'image', url: 'https://x.tld/a.jpg', posterOnly: true }, 0), 0)
  assert.equal(bytesIndex({ kind: 'image', url: 'https://x.tld/a.jpg', poster: '', posterOnly: true }, 0), 0)

  // 3. A VIDEO CAN NEVER BE MOVED TO A POSTER SLOT. This is what keeps the 2026-07-24 rule
  //    structural rather than merely true today: even a corrupt record carrying the flag on a video
  //    entry keeps the numeric index, so og:video can never be handed an image url.
  assert.equal(
    bytesIndex({ kind: 'video', url: 'https://x.tld/v.mp4', poster: 'https://x.tld/p.jpg', posterOnly: true }, 0),
    0,
    'a video entry keeps the bare index whatever the flag says',
  )

  // Total over junk rather than a throw — deserializePost validates nothing about media[].
  assert.equal(bytesIndex(null, 0), 0)
  assert.equal(bytesIndex(undefined, 3), 3)
  assert.equal(bytesIndex({}, 2), 2)
})

test('THE OG HEADS AGREE WITH THE ATTACHMENT — all three minting sites were wrong together', async () => {
  /**
   * Three heads mint a picture url from an array position, and all three shipped this defect.
   * Telegram is not a bystander: the post route runs settleMux before render() for every bot class.
   */
  for (const client of ['telegram', 'other-bot']) {
    const html = await render({ kind: 'post', post: DEGRADED }, client, ORIGIN).text()
    const m = html.match(/property="og:image" content="([^"]*)"/)
    if (!m) continue   // a head that ships no og:image at all cannot ship a broken one
    assert.match(m[1], /poster0/, `${client}: og:image must name the poster slot`)
    assert.doesNotMatch(m[1], /\/0"/, `${client}: never the 503-ing video slot`)
  }
})

test('NO og:video IS PROMISED FOR A DEGRADED STILL — the card must not advertise a dead player', async () => {
  // The entry is kind:'image', so playableVideo() rejects it and no player tag is minted. That is
  // what makes "a video url never becomes an image" hold from the other direction too.
  const html = await render({ kind: 'post', post: DEGRADED }, 'other-bot', ORIGIN).text()
  assert.doesNotMatch(html, /property="og:video"/, 'no player is promised')
})

/**
 * THE BLANK CARD, reported 2026-07-31: "I've got a YouTube video that refuses to work on discord and
 * I've now tried all the permutations … not a single one has generated a card." Same video as above.
 *
 * THE SLOT FIX ABOVE WAS NECESSARY AND NOT SUFFICIENT. Measured on production the day it was
 * reported: the head carried og:title and og:description but NO og:image and NO og:video (correct —
 * Discord takes its picture from the Mastodon spoof), the spoof carried exactly one attachment, and
 * `/_media/yt%3AJky5ZXI0axc/poster0` 302'd to a real 20,338-byte JPEG. Every piece worked.
 *
 * What was missing was `meta.original`. mastodon.ts omits that block when the dimensions are unknown,
 * and Discord will not lay out an IMAGE attachment it has no size for — so it drew nothing at all.
 * The comparison that proved it: Pinterest's plain image carries meta 1152x620 and renders; this
 * carried none. A remux video deliberately has w/h of 0 (so Discord reads the muxed mp4 and a Short
 * plays portrait), and BOTH degrades copied that 0 onto the still they produced.
 */
test('A DEGRADED STILL CARRIES THE POSTER\'S SIZE — 0x0 is a card Discord will not draw', () => {
  const sized = { ...DEGRADED, media: [{ ...DEGRADED.media[0], w: 480, h: 360 }] }
  const meta = toMastodonStatus(sized, ORIGIN).media_attachments[0].meta
  assert.ok(meta && meta.original, 'a sized still must carry meta.original')
  assert.equal(meta.original.size, '480x360')

  // And the shape that shipped, pinned as the failure it was: no dimensions, no meta, no picture.
  const blank = toMastodonStatus(DEGRADED, ORIGIN).media_attachments[0]
  assert.equal(blank.meta, undefined, 'this is what an unrenderable attachment looks like')
})

test('THE POSTER SIZE SURVIVES THE POST CACHE — it is useless if it does not round-trip', async () => {
  // media[] is re-read from the cache on the /_media/ route and on the spoof callback, so a field the
  // serializer drops would fix the first render and break every one after it.
  const { serializePost, deserializePost } = await import('../src/cache.ts')
  const withPoster = {
    ...DEGRADED,
    media: [{ ...DEGRADED.media[0], kind: 'video', w: 0, h: 0, posterW: 480, posterH: 360, remux: { page: 'https://www.youtube.com/watch?v=Jky5ZXI0axc' } }],
  }
  const back = deserializePost(serializePost(withPoster))
  assert.equal(back.media[0].posterW, 480, 'posterW must survive serialization')
  assert.equal(back.media[0].posterH, 360)
})
