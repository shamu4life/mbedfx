import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { fetchImgur, imThumb } from '../src/platforms/imgur/fetch.ts'
import { normalizeImgurApi } from '../src/platforms/imgur/normalize.ts'

/**
 * IMGUR ALBUMS AND STILL PHOTOS, requested 2026-07-31: "I'd like to be able to handle imgur albums
 * and present the images easily on discord like we do with other platforms."
 *
 * WHY THIS NEEDED A NEW SOURCE RATHER THAN A FIX. Imgur was a yt-dlp platform, and yt-dlp's Imgur
 * extractor opens by refusing anything that is not moving. Measured against a real 1275x1234 JPEG:
 *
 *     $ yt-dlp -J https://imgur.com/QAcLnaf
 *     ERROR: [Imgur] QAcLnaf: QAcLnaf is not a video or animated image      (exit 1)
 *
 * So every photo on the site was unreachable by construction, and an album arrived as a playlist
 * whose top-level object carries a title and nothing else. Scraping is not the alternative either:
 * the Imgur page emits exactly ONE og:image (the cover) under a browser UA and under Discordbot
 * alike, which is precisely what Discord already does with a raw Imgur link.
 *
 * The fixtures beside this file are real API responses captured 2026-07-31.
 */

const load = n => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))
const ALBUM = load('imgur-api-album.json')     // imgur.com/a/iX265HX — 2 animated gifs
const STILL = load('imgur-api-still.json')     // imgur.com/QAcLnaf   — one 1275x1234 jpeg
const ANIMATED = load('imgur-api-animated.json') // imgur.com/Aa2IZ5m — one animated gif

const r = p => route(new URL('https://mbedfx.app' + p))

/** A fetch that answers only api.imgur.com, from a fixture, and records what was asked for. */
function fakeApi(byEndpoint) {
  const seen = []
  return {
    seen,
    env: { IMGUR_CLIENT_ID: 'test-client-id' },
    install() {
      const real = globalThis.fetch
      globalThis.fetch = async (u, init) => {
        const url = String(u)
        if (!url.startsWith('https://api.imgur.com/')) return real(u, init)
        seen.push(url)
        const kind = url.match(/post\/v1\/(\w+)\//)[1]
        const body = byEndpoint[kind]
        return body
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response('{"errors":[]}', { status: 404 })
      }
      return () => { globalThis.fetch = real }
    },
  }
}

// ── Routing ────────────────────────────────────────────────────────────────

test('AN ALBUM URL ROUTES, and carries the kind that picks its API endpoint', () => {
  assert.deepEqual(r('/a/iX265HX'), {
    kind: 'post',
    ref: { p: 'im', kind: 'album', id: 'iX265HX' },
    canonical: 'https://imgur.com/a/iX265HX',
  })
  // The kind survives the /_media/ round trip, or every picture in the album 404s silently.
  const ref = { p: 'im', kind: 'album', id: 'iX265HX' }
  assert.equal(refKey(ref), 'im:album:iX265HX')
  assert.deepEqual(parseRefKey(refKey(ref)), ref)
})

test('/gallery/ IS OFFERED, NOT TAKEN — Reddit and Instagram galleries are real posts', () => {
  /**
   * The .gifv arm could claim the bare-username row because that row is a DEAD END: no profile route
   * exists, so the chooser could only ever hand a human two links. /gallery/{id} is not that —
   * reddit.com/gallery/{id} is a live permalink — so Imgur joins the chooser instead of stealing it.
   * Before this, an Imgur gallery link reached a chooser that could not resolve it at all.
   */
  const got = r('/gallery/YcAQlkx')
  assert.equal(got.kind, 'ambiguous')
  assert.deepEqual(got.candidates, ['rd', 'ig', 'im'])
  // And naming the platform resolves it.
  assert.deepEqual(r('/im/gallery/YcAQlkx').ref, { p: 'im', kind: 'gallery', id: 'YcAQlkx' })
})

test('A BARE IMGUR ID IS STILL FORCED-ONLY, stills included', () => {
  // route() is host-agnostic, so imgur.com/{id}, dai.ly/{id} and streamable.com/{id} collapse onto
  // ONE bare /{id}. A still photo does not make that decidable — Dailymotion's real id 'xaqwy7q'
  // still satisfies Imgur's shape — so the escape hatch remains the answer.
  assert.equal(r('/QAcLnaf').kind, 'ambiguous')
  assert.deepEqual(r('/im/QAcLnaf').ref, { p: 'im', kind: 'post', id: 'QAcLnaf' })
})

// ── Fetch ──────────────────────────────────────────────────────────────────

test('AN ALBUM IS FETCHED FROM THE albums ENDPOINT, and a single from media', async () => {
  for (const [kind, endpoint, fixture] of [
    ['album', 'albums', ALBUM],
    ['post', 'media', STILL],
  ]) {
    const api = fakeApi({ [endpoint]: fixture })
    const restore = api.install()
    try {
      const got = await fetchImgur({ p: 'im', kind, id: fixture.id }, api.env)
      assert.equal(got.ok, true, `${kind} must fetch`)
      assert.equal(api.seen.length, 1, `${kind} must cost exactly one request`)
      assert.match(api.seen[0], new RegExp(`/post/v1/${endpoint}/`))
      assert.match(api.seen[0], /client_id=test-client-id/, 'the configured id must be used')
    } finally { restore() }
  }
})

test('A GALLERY TRIES albums THEN media — the two endpoints 404 on each other', async () => {
  /**
   * Measured 2026-07-31: `media/{id}` 404s on an album id and `albums/{id}` 404s on a single, and
   * there is no unified endpoint. A /gallery/ link can legally be either, so it must try both.
   */
  const api = fakeApi({ media: STILL })   // albums/ will 404
  const restore = api.install()
  try {
    const got = await fetchImgur({ p: 'im', kind: 'gallery', id: 'QAcLnaf' }, api.env)
    assert.equal(got.ok, true)
    assert.equal(api.seen.length, 2, 'albums first, then media')
    assert.match(api.seen[0], /\/albums\//)
    assert.match(api.seen[1], /\/media\//)
  } finally { restore() }
})

test('A DELETED POST IS assert_fail, NOT A GATE — Imgur does not say "private"', async () => {
  const api = fakeApi({})   // everything 404s
  const restore = api.install()
  try {
    const got = await fetchImgur({ p: 'im', kind: 'album', id: 'iX265HX' }, api.env)
    assert.deepEqual(got, { ok: false, reason: 'assert_fail' })
  } finally { restore() }
})

test('A HOSTILE ITEM URL NEVER REACHES THE CARD — /_media/ 302s to whatever this returns', async () => {
  /**
   * THE SECURITY PIN. media[].url is echoed into a 302 from our own origin, so an item url on a host
   * we do not control would be an open redirect wearing mbedfx.app's name.
   */
  const evil = JSON.parse(JSON.stringify(ALBUM))
  evil.media[0].url = 'https://evil.example/x.jpg'
  evil.media[1].url = 'http://i.imgur.com/plain.jpg'     // http, not https
  const api = fakeApi({ albums: evil })
  const restore = api.install()
  try {
    const got = await fetchImgur({ p: 'im', kind: 'album', id: 'iX265HX' }, api.env)
    assert.equal(got.ok, false, 'with every item refused there is nothing to show')
  } finally { restore() }
})

// ── Normalize ──────────────────────────────────────────────────────────────

const REF = { p: 'im', kind: 'album', id: 'iX265HX' }

test('AN ALBUM BECOMES A GALLERY POST — one media entry per image', () => {
  const api = { ...ALBUM }
  const post = normalizeImgurApi({
    id: api.id,
    title: api.title,
    description: api.description || undefined,
    createdAt: api.created_at,
    uploader: api.account?.username,
    mature: api.is_mature === true,
    total: api.image_count,
    items: api.media.map(m => ({
      id: m.id, url: m.url, kind: m.mime_type.startsWith('video/') ? 'video' : 'image',
      w: m.width, h: m.height, animated: m.metadata?.is_animated === true,
      description: m.metadata?.description || undefined,
    })),
  }, REF)

  assert.ok(post, 'an album must produce a card')
  assert.equal(post.media.length, 2, 'both images, in album order')
  assert.equal(post.title, 'enen-no-shouboutai')
  assert.equal(post.canonical, 'https://imgur.com/a/iX265HX')
  assert.equal(post.sensitive, false)
  // These two are animated, so they carry a poster and a remux page rather than being flattened here
  // — mastodon.ts flattens a multi-item gallery to posters and adds the "Contains video" marker.
  assert.equal(post.media[0].kind, 'video')
  assert.equal(post.media[0].poster, imThumb('Aa2IZ5m'))
  assert.equal(post.media[1].poster, imThumb('TO52EIJ'))
})

test('A MULTI-ITEM ALBUM CARRIES NO remux — settleMux would wait on every one of them', () => {
  /**
   * THE LATENCY BUG THIS PREVENTS, found by rendering a real 12-item album end to end. settleMux
   * waits on EVERY entry with a `remux.page`, so a four-video album blocked the render on four
   * container muxes — for videos mastodon.ts then flattens to their posters anyway, because Discord
   * draws at most one player. Four muxes, nothing gained, the whole HTML deadline spent.
   *
   * The entries stay `kind: 'video'`, which is what keeps the flattening and its "Contains video"
   * marker honest; only the mux request goes away.
   */
  const two = normalizeImgurApi({
    id: 'x', mature: false, total: 2,
    items: ['Aa2IZ5m', 'TO52EIJ'].map(id => ({
      id, url: `https://i.imgur.com/${id}.mp4`, kind: 'video', w: 4, h: 4, animated: true,
    })),
  }, REF)
  assert.equal(two.media.length, 2)
  for (const m of two.media) {
    assert.equal(m.kind, 'video', 'still a video, so the gallery marker stays correct')
    assert.ok(m.poster, 'and it still has the still that gets shown')
    assert.equal(m.remux, undefined, 'but nothing for settleMux to wait on')
  }

  // A LONE video is the opposite case: it renders a real inline player, so it keeps its mux.
  const one = normalizeImgurApi({
    id: 'x', mature: false, total: 1,
    items: [{ id: 'Aa2IZ5m', url: 'https://i.imgur.com/Aa2IZ5m.mp4', kind: 'video', w: 4, h: 4, animated: true }],
  }, { p: 'im', kind: 'post', id: 'Aa2IZ5m' })
  assert.match(one.media[0].remux.page, /Aa2IZ5m\.gifv$/, 'each item remuxes from its OWN id')
})

test('A STILL PHOTO IS AN IMAGE WITH NO POSTER — an image is its own poster', () => {
  const m = STILL.media[0]
  const post = normalizeImgurApi({
    id: STILL.id, mature: false, total: 1,
    items: [{ id: m.id, url: m.url, kind: 'image', w: m.width, h: m.height, animated: false }],
  }, { p: 'im', kind: 'post', id: STILL.id })

  assert.equal(post.media.length, 1)
  assert.deepEqual(post.media[0], { kind: 'image', url: m.url, w: 1275, h: 1234 })
  assert.equal(post.canonical, `https://imgur.com/${STILL.id}`)
  assert.equal(post.author.name, 'Imgur', 'an anonymous upload gets the platform byline')
  assert.equal(post.author.handle, 'imgur')
})

test('AN ANIMATED SINGLE KEEPS ITS PLAYBACK — a gif is a video with a poster, not a still', () => {
  /**
   * The case that already worked and must not regress. Imgur calls an animated GIF `type: 'image'`
   * with `is_animated: true`, so a mapper keyed on `type` alone would quietly turn every gif on the
   * site into a still picture — the exact regression this platform existed to avoid.
   */
  const m = ANIMATED.media[0]
  assert.equal(m.type, 'image', 'Imgur really does call it an image')
  assert.equal(m.metadata.is_animated, true)

  const post = normalizeImgurApi({
    id: ANIMATED.id, mature: false, total: 1,
    items: [{ id: m.id, url: m.url, kind: 'image', w: m.width, h: m.height, animated: true }],
  }, { p: 'im', kind: 'post', id: ANIMATED.id })

  assert.equal(post.media[0].kind, 'video', 'animated means it moves, whatever Imgur calls it')
  assert.equal(post.media[0].poster, imThumb('Aa2IZ5m'))
  assert.match(post.media[0].remux.page, /Aa2IZ5m\.gifv$/, 'a lone video keeps its player')
})

test('THE UPLOADER IS USED WHEN THERE IS ONE — the container never reported this', () => {
  const post = normalizeImgurApi({
    id: 'x', mature: false, total: 1, uploader: 'Swiggy1957',
    uploaderAvatar: 'https://i.imgur.com/2p0E8T8_d.png',
    items: [{ id: 'A61SaA1', url: 'https://i.imgur.com/A61SaA1.jpeg', kind: 'image', w: 1, h: 1, animated: false }],
  }, { p: 'im', kind: 'post', id: 'x' })
  assert.equal(post.author.name, 'Swiggy1957')
  assert.equal(post.author.handle, 'Swiggy1957')
  assert.equal(post.author.url, 'https://imgur.com/user/Swiggy1957')
})

const many = n => Array.from({ length: n }, (_, i) => ({
  id: `abcd${String(i).padStart(3, '0')}`,
  url: `https://i.imgur.com/abcd${String(i).padStart(3, '0')}.jpeg`,
  kind: 'image', w: 10, h: 10, animated: false,
}))

test('A TWELVE-IMAGE ALBUM SHIPS ALL TWELVE — Imgur is not capped where other galleries are not', () => {
  /**
   * THE OWNER'S QUESTION, and he was right: "why is it that we can do more than 4 images in a gallery
   * for other sites but you're saying imgur is limited to 4?"
   *
   * It was capped at 4 because I misread mastodon.ts's note that Status::MEDIA_ATTACHMENTS_LIMIT is 4.
   * That is MASTODON'S server-side validation, quoted there to explain why Discord's consumer had
   * never seen a mixed gallery — not a rule this service applies. attachments() iterates the whole
   * list uncapped, which is how an Instagram carousel ships twelve slides. Imgur was the one platform
   * throwing images away.
   */
  const post = normalizeImgurApi({ id: 'x', mature: false, total: 12, items: many(12) }, REF)
  assert.equal(post.media.length, 12, 'every slide, exactly like an Instagram carousel')
  assert.doesNotMatch(post.text, /more images/, 'nothing was left out, so nothing is claimed')
})

test('AN UNBOUNDED ALBUM IS STILL BOUNDED, and says what it left out', () => {
  // Imgur albums, unlike every other gallery here, have no platform maximum — a few hundred images is
  // ordinary, and each one costs a /_media/ slot and a line of JSON.
  const post = normalizeImgurApi({ id: 'x', mature: false, total: 240, items: many(240) }, REF)
  assert.equal(post.media.length, 20)
  assert.match(post.text, /\+220 more images on Imgur/)
})

test('AN EXACTLY-FULL ALBUM SAYS NOTHING ABOUT OVERFLOW — "+0 more" is a lie by rounding', () => {
  const post = normalizeImgurApi({ id: 'x', mature: false, total: 20, items: many(20) }, REF)
  assert.equal(post.media.length, 20)
  assert.doesNotMatch(post.text, /more images/)
})

test('is_mature MARKS THE POST SENSITIVE', () => {
  const post = normalizeImgurApi({
    id: 'x', mature: true, total: 1,
    items: [{ id: 'A61SaA1', url: 'https://i.imgur.com/A61SaA1.jpeg', kind: 'image', w: 1, h: 1, animated: false }],
  }, REF)
  assert.equal(post.sensitive, true)
})

test('normalizeImgurApi IS TOTAL OVER JUNK', () => {
  for (const junk of [null, undefined, 42, 'nope', [], {}, { items: [] }, { items: 'no' }]) {
    assert.equal(normalizeImgurApi(junk, REF), null, `${JSON.stringify(junk)} must not become a card`)
  }
  // A foreign ref is refused by type, like every other normalizer here.
  assert.equal(normalizeImgurApi({ id: 'x', mature: false, total: 1, items: [] }, { p: 'yt', id: 'a' }), null)
})

test('AN UNPARSEABLE TIMESTAMP NEVER RENDERS AS "Invalid Date"', () => {
  const items = [{ id: 'A61SaA1', url: 'https://i.imgur.com/A61SaA1.jpeg', kind: 'image', w: 1, h: 1, animated: false }]
  for (const createdAt of [undefined, '', 'not a date', '0000-00-00']) {
    const post = normalizeImgurApi({ id: 'x', mature: false, total: 1, items, createdAt }, REF)
    assert.ok(Number.isFinite(post.createdAt.getTime()), `${createdAt} must degrade to a real Date`)
  }
  const real = normalizeImgurApi({ id: 'x', mature: false, total: 1, items, createdAt: ALBUM.created_at }, REF)
  assert.equal(real.createdAt.toISOString(), new Date(ALBUM.created_at).toISOString())
})

/**
 * THE ENDPOINT WALK MAY ONLY ADVANCE ON A CLEAN 404 — the fix for a live wrong-post defect.
 *
 * WHAT WAS BROKEN, measured 2026-08-16 end to end through this Worker's own handler:
 * /im/gallery/joNxn, /im/gallery/sh0Z6 and /im/gallery/UwEpm each returned a complete, validating
 * HTTP 200 card FOR AN UNRELATED IMAGE. api.imgur.com answers `albums/joNxn` with 200 and an EMPTY
 * album (is_album:true, image_count:0, no usable media); the old `if (!items.length) continue` read
 * that as "ask the next endpoint", and `media/joNxn` answers 200 with a colliding legacy photo,
 * because the album and legacy-image namespaces SHARE ids. `aZVXS` is the same collision with the
 * roles reversed: a real 7-image album on albums/, an unrelated 300x415 jpeg on media/.
 *
 * Nothing reported it. The card had a picture, a byline and a link, and every field validated —
 * they were simply about a post nobody asked for. This suite is the only thing that can catch it,
 * which is why the cases below assert on WHICH ENDPOINTS WERE ASKED and not just on the result.
 *
 * The two directions are genuinely different and both are pinned: a 404 MUST still advance (real
 * gallery posts ck58rrX and E7HlM3Q 404 on albums/ and are served only by media/, so refusing to
 * advance would unroute them), while every other outcome must stop.
 */
function stubApi(byEndpoint) {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (u, init) => {
    const url = String(u)
    if (!url.startsWith('https://api.imgur.com/')) return real(u, init)
    const kind = url.match(/post\/v1\/(\w+)\//)[1]
    seen.push(kind)
    const r = byEndpoint[kind]
    if (!r) return new Response('{"errors":[]}', { status: 404 })
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  }
  return { seen, restore: () => { globalThis.fetch = real } }
}
const EMPTY_ALBUM = { id: 'joNxn', is_album: true, image_count: 0, title: '', account: {} }
const COLLIDING = {
  id: 'joNxn', is_album: false, image_count: 1, title: 'an unrelated legacy photo', account: {},
  media: [{ id: 'joNxn', url: 'https://i.imgur.com/joNxn.jpeg', mime_type: 'image/jpeg', type: 'image', width: 300, height: 400, metadata: {} }],
}

test('AN EMPTY ALBUM STOPS THE WALK — it must not be answered with a colliding legacy image', async () => {
  const api = stubApi({ albums: { status: 200, body: EMPTY_ALBUM }, media: { status: 200, body: COLLIDING } })
  try {
    const got = await fetchImgur({ p: 'im', kind: 'gallery', id: 'joNxn' }, { IMGUR_CLIENT_ID: 'test' })
    assert.equal(got.ok, false, 'an empty album is a failure card, never somebody else’s photo')
    assert.deepEqual(api.seen, ['albums'], 'media/ must NOT be asked: albums/ answered 200, so it KNOWS this id')
  } finally { api.restore() }
})

test('A 404 STILL ADVANCES — ck58rrX and E7HlM3Q are real gallery posts only media/ can answer', async () => {
  const api = stubApi({ media: { status: 200, body: { ...COLLIDING, id: 'ck58rrX', title: 'Molly Carlson diving from 72' } } })
  try {
    const got = await fetchImgur({ p: 'im', kind: 'gallery', id: 'ck58rrX' }, { IMGUR_CLIENT_ID: 'test' })
    assert.equal(got.ok, true, 'a 404 from albums/ is an honest miss, and the media leg is load-bearing')
    assert.deepEqual(api.seen, ['albums', 'media'], 'both legs, in order')
  } finally { api.restore() }
})

test('A THROTTLE STOPS THE WALK — not-knowing must never license asking about a different post', async () => {
  // The shared PUBLIC_CLIENT_ID an unconfigured deploy runs on is where this pressure lands, and a
  // 429 says nothing about whether the id names an album. Under the old `status !== 200` test this
  // fell straight into media/ and drew the colliding image — a permanently wrong card produced by a
  // transient upstream problem, exactly when traffic is highest.
  for (const status of [429, 500, 403]) {
    const api = stubApi({ albums: { status, body: '{}' }, media: { status: 200, body: COLLIDING } })
    try {
      const got = await fetchImgur({ p: 'im', kind: 'gallery', id: 'joNxn' }, { IMGUR_CLIENT_ID: 'test' })
      assert.equal(got.ok, false, `HTTP ${status} must not become a card`)
      assert.deepEqual(api.seen, ['albums'], `HTTP ${status} must not advance to media/`)
    } finally { api.restore() }
  }
})

test('A 200 THAT IS NOT JSON STOPS THE WALK — it is not an answer about anything', async () => {
  const api = stubApi({ albums: { status: 200, body: '<html>nope' }, media: { status: 200, body: COLLIDING } })
  try {
    const got = await fetchImgur({ p: 'im', kind: 'gallery', id: 'joNxn' }, { IMGUR_CLIENT_ID: 'test' })
    assert.equal(got.ok, false)
    assert.deepEqual(api.seen, ['albums'], 'unparseable is not a 404, so it grants no licence to ask elsewhere')
  } finally { api.restore() }
})
