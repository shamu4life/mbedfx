import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { fetchPeerTube } from '../src/platforms/peertube/fetch.ts'
import { normalizePeerTube, peertubeFile, peertubeThumb } from '../src/platforms/peertube/normalize.ts'
import { proxyableVideoUrl } from '../src/mediaproxy.ts'

/**
 * PEERTUBE — the fourth fediverse platform here, and the one whose file layout defeated two separate
 * surveys because each saw only half of it.
 *
 * BOTH SHAPES EXIST, and which one an instance publishes is an ADMIN SETTING:
 *
 *   framatube.org      files[]: 1080p (185 MB), 480p 854x480 (25 MB), 360p, Audio only
 *   video.blender.org  files[]: 1080p, 480p, Audio only
 *   tilvids.com        files[]: **Audio only and nothing else**
 *                      streamingPlaylists[0].files[]: 1080p, 360p (33 MB), 144p — FRAGMENTED
 *
 * An earlier survey saw only tilvids' shape and reported PeerTube as "HLS + fragmented mp4 only, no
 * progressive rendition". A later one saw only framatube's and called that wrong. Both were reporting
 * a real instance. Reading either list alone loses a whole class of instances.
 *
 * BOTH ARE REAL MP4s, which is what makes serving either safe — measured 2026-07-30:
 *   progressive (framatube 480p)  206, video/mp4, `ftypisom`, ranges honoured, no UA needed
 *   fragmented  (tilvids 360p)    206, video/mp4, `ftypiso5` (CMAF), ranges honoured, and ffprobe
 *                                 decodes it as h264 + aac
 * The HLS MASTER beside them (`playlistUrl`, an .m3u8) is never used: Discord cannot play a manifest.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => JSON.parse(readFileSync(new URL(n, F), 'utf8'))

const VIDEO = load('peertube-video.json')          // framatube.org — progressive files[]
const BLENDER = load('peertube-video-noaudio.json')

const HOST = 'framatube.org'
const REF = { p: 'pt', host: HOST, id: 'vZNcho9kCoVzc8wZwacPtc' }
const r = p => route(new URL(`https://staging.mbedfx.app${p}`))

test('BOTH PERMALINK SHAPES FOLD TO ONE REF', () => {
  // /w/{shortUUID} is what the share button emits; /videos/watch/{uuid} is the older canonical and
  // what `video.url` still carries. The API resolves either id — verified byte-identical bodies.
  assert.deepEqual(r(`/${HOST}/w/vZNcho9kCoVzc8wZwacPtc`).ref, REF)
  assert.deepEqual(
    r(`/${HOST}/videos/watch/f2eae269-2996-44fe-9040-af57e241be0d`).ref,
    { p: 'pt', host: HOST, id: 'f2eae269-2996-44fe-9040-af57e241be0d' },
  )
  assert.deepEqual(r(`/https://${HOST}/w/vZNcho9kCoVzc8wZwacPtc`).ref, REF, 'the prepend alias')
  assert.deepEqual(r(`/pt/${HOST}/w/vZNcho9kCoVzc8wZwacPtc`).ref, REF, 'the escape hatch')
  assert.equal(refKey(REF), 'pt:framatube.org:vZNcho9kCoVzc8wZwacPtc')
  assert.deepEqual(parseRefKey('pt:framatube.org:vZNcho9kCoVzc8wZwacPtc'), REF)
})

test('THE ID ADMITS A shortUUID AND A UUID, and nothing dangerous', () => {
  assert.equal(r(`/${HOST}/w/vZNcho9kCoVzc8wZwacPtc`).kind, 'post', 'base58 shortUUID')
  assert.equal(r(`/${HOST}/w/f2eae269-2996-44fe-9040-af57e241be0d`).kind, 'post', 'full UUID')
  // Dashes are admitted ONLY because a UUID cannot be written without them. Everything that makes
  // that safe still holds — no separator can climb out of the path segment.
  for (const bad of ['a/b', 'a.b', 'a%2fb', 'a:b', 'short', '', '-leading-dash-is-refused', 'x'.repeat(41)]) {
    assert.notEqual(r(`/${HOST}/w/${bad}`).kind, 'post', `${JSON.stringify(bad)} must not route`)
    assert.equal(parseRefKey(`pt:${HOST}:${bad}`), null, 'nor parse as a refKey')
  }
})

test('A PLAYLIST IS NOT A VIDEO — /w/p/{id} is refused structurally', () => {
  // `p` cannot satisfy PEERTUBE_ID (16 chars minimum), so the guard is structural rather than a
  // special case someone can delete by accident.
  assert.equal(r(`/${HOST}/w/p/vZNcho9kCoVzc8wZwacPtc`).kind, 'notfound')
})

test('THE HOST IS RE-VALIDATED IN parseRefKey — it decides who the Worker talks to', () => {
  for (const bad of ['localhost', '127.0.0.1', '[::1]', 'a', 'host:8080', 'u@host.com', '']) {
    assert.equal(parseRefKey(`pt:${bad}:vZNcho9kCoVzc8wZwacPtc`), null, `${bad} must not parse`)
  }
  assert.equal(parseRefKey('pt:framatube.org'), null)
})

test('"AUDIO ONLY" IS A REAL MP4 AND MUST NEVER BE CHOSEN', () => {
  /**
   * Every instance sampled ships one, at 0x0. It is a genuine mp4, so a naive "first .mp4 wins"
   * selects a file with no picture in it — which Discord renders as a broken player.
   */
  const audio = VIDEO.files.find(f => f.height === 0)
  assert.ok(audio, 'the fixture really carries an Audio only entry')
  assert.match(audio.fileUrl, /\.mp4$/, 'and it really is an mp4')
  assert.notEqual(peertubeFile(VIDEO).url, audio.fileUrl)
  // Nothing but the audio entry yields NOTHING, rather than a picture-less player.
  assert.equal(peertubeFile({ files: [audio] }), null)
})

test('THE CEILINGS ARE HEIGHT AND BYTES — a 185 MB 1080p is not an embed', () => {
  // The framatube fixture offers 1080p/480p/360p; 720 is the height ceiling, so 480p wins.
  const got = peertubeFile(VIDEO)
  assert.equal(got.h, 480)
  assert.equal(got.w, 854)
  assert.ok(!VIDEO.files.some(f => f.height === got.h && f.size > 100 * 1024 * 1024))

  // Only an over-tall file -> nothing, so the card degrades to its cover rather than a dead player.
  assert.equal(peertubeFile({ files: [{ fileUrl: 'https://x.tld/a-1080.mp4', width: 1920, height: 1080, size: 10 }] }), null)
  // Inside the height ceiling but enormous -> also nothing. PeerTube hosts long videos; this is the
  // ceiling the other direct-serve platforms in this project never needed.
  assert.equal(peertubeFile({ files: [{ fileUrl: 'https://x.tld/a-480.mp4', width: 854, height: 480, size: 200 * 1024 * 1024 }] }), null)
})

test('PROGRESSIVE IS PREFERRED, THE HLS RENDITIONS ARE THE FALLBACK', () => {
  /**
   * tilvids.com publishes NOTHING but "Audio only" in files[] and puts its real renditions under
   * streamingPlaylists[0].files[] as fragmented mp4s. Reading only files[] makes every such instance
   * a cover-still platform.
   */
  const hlsOnly = {
    files: [{ fileUrl: 'https://x.tld/audio-0.mp4', width: 0, height: 0, size: 10 }],
    streamingPlaylists: [{
      playlistUrl: 'https://x.tld/master.m3u8',
      files: [
        { fileUrl: 'https://x.tld/a-1080-fragmented.mp4', width: 1920, height: 1080, size: 62279121 },
        { fileUrl: 'https://x.tld/a-360-fragmented.mp4', width: 640, height: 360, size: 32897168 },
      ],
    }],
  }
  const got = peertubeFile(hlsOnly)
  assert.equal(got.h, 360, 'the 1080p is over the height ceiling, so the 360p is taken')
  assert.match(got.url, /fragmented\.mp4$/)

  // Where BOTH exist, the progressive list wins — it is the better file.
  const both = { ...hlsOnly, files: [{ fileUrl: 'https://x.tld/a-480.mp4', width: 854, height: 480, size: 100 }] }
  assert.match(peertubeFile(both).url, /a-480\.mp4$/)
})

test('THE HLS MASTER IS NEVER SELECTED — a manifest is the dead-player defect', () => {
  const manifestOnly = {
    files: [],
    streamingPlaylists: [{
      playlistUrl: 'https://x.tld/master.m3u8',
      files: [{ fileUrl: 'https://x.tld/master.m3u8', width: 1280, height: 720, size: 10 }],
    }],
  }
  assert.equal(peertubeFile(manifestOnly), null, '.mp4 is asserted on the URL, not the label')
})

test('THE THUMBNAIL IS A PATH AND MUST BE MADE ABSOLUTE', () => {
  // The one field here that is not a url. Shipping it raw puts a relative path into og:image.
  assert.match(VIDEO.thumbnailPath, /^\//, 'the fixture really is a bare path')
  assert.equal(peertubeThumb(VIDEO, HOST), `https://${HOST}${VIDEO.thumbnailPath}`)
  assert.equal(peertubeThumb({ thumbnailPath: 'https://cdn.tld/a.jpg' }, HOST), 'https://cdn.tld/a.jpg')
  assert.equal(peertubeThumb({}, HOST), '')
})

test('THE AUTHOR IS FEDERATED — account.host, not the instance we asked', () => {
  /**
   * framatube.org serves a video whose account lives on tube.tchncs.de. Deriving the handle from
   * ref.host would mislabel it — the same trap Lemmy's actor_id comment records.
   */
  assert.equal(VIDEO.account.host, 'tube.tchncs.de')
  const post = normalizePeerTube(VIDEO, REF)
  assert.equal(post.author.handle, 'guyjantic@tube.tchncs.de')
  assert.notEqual(post.author.handle, `guyjantic@${HOST}`)
})

test('A LIVE STREAM DEGRADES TO ITS COVER — there is no file to serve', () => {
  const live = { ...VIDEO, isLive: true }
  const post = normalizePeerTube(live, REF)
  assert.equal(post.media[0].kind, 'image', 'the cover, never a player')
  assert.match(post.text, /^🔴 Live/)
})

test('PEERTUBE KEEPS THE 302 — no byte proxy, like Pinterest', () => {
  // Measured: 206 with content-type video/mp4 to a Discordbot UA and to no UA at all, ranges
  // honoured. Instagram is proxied for missing accept-ranges and Twitch for a mislabelled
  // content-type; PeerTube needs neither.
  const post = normalizePeerTube(VIDEO, REF)
  assert.equal(proxyableVideoUrl(post, 0), null)
})

test('the real videos normalize end to end', () => {
  const p1 = normalizePeerTube(VIDEO, REF)
  assert.equal(p1.title, '2026 POrtal effigy burn')
  assert.equal(p1.media[0].kind, 'video')
  assert.ok(p1.media[0].poster, 'a video always carries its still')
  assert.equal(p1.media[0].duration, 215)
  assert.equal(p1.createdAt.getUTCFullYear(), 2026)
  assert.equal(p1.sensitive, false)
  assert.match(p1.canonical, /^https:\/\/framatube\.org\/w\//, 'the PASTED instance, not the origin')

  const p2 = normalizePeerTube(BLENDER, { p: 'pt', host: 'video.blender.org', id: '8wqZmey8w3MAWcbK5kSTMV' })
  assert.equal(p2.author.handle, 'blender@video.blender.org')
  assert.equal(p2.media[0].kind, 'video')
})

test('normalizePeerTube is TOTAL over a video with holes', () => {
  const bare = normalizePeerTube({ id: 1, uuid: 'x', name: 'x' }, REF)
  assert.equal(bare.media.length, 0)
  assert.equal(bare.text, '')
  assert.equal(bare.author.name, 'PeerTube')
  assert.doesNotThrow(() => bare.createdAt.toISOString())
})

test('THE FETCHER ASSERTS ON CONTENT AND REFUSES OUR OWN ZONES', async () => {
  const real = globalThis.fetch
  const ref = { p: 'pt', host: 'framatube.org', id: 'vZNcho9kCoVzc8wZwacPtc' }
  const json = b => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
  try {
    globalThis.fetch = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
    assert.deepEqual(await fetchPeerTube(ref), { ok: false, reason: 'assert_fail' })

    globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    assert.deepEqual(await fetchPeerTube(ref), { ok: false, reason: 'notfound' }, 'a deleted video is a wall')

    // JSON at 200 that is not a video — each liveness field independently.
    globalThis.fetch = async () => json({ hello: 'world' })
    assert.deepEqual(await fetchPeerTube(ref), { ok: false, reason: 'assert_fail' })
    globalThis.fetch = async () => json({ id: 1, uuid: 'x' })
    assert.deepEqual(await fetchPeerTube(ref), { ok: false, reason: 'assert_fail' }, 'no name')
    globalThis.fetch = async () => json({ id: '1', uuid: 'x', name: 'n' })
    assert.deepEqual(await fetchPeerTube(ref), { ok: false, reason: 'assert_fail' }, 'id must be a number')

    globalThis.fetch = async () => json(VIDEO)
    assert.equal((await fetchPeerTube(ref)).ok, true)

    // Our own zones are refused before any request is made.
    let called = 0
    globalThis.fetch = async () => { called++; return json(VIDEO) }
    for (const host of ['mbedfx.app', 'a.mbedfx.app', 'megapenispoopenfarten.sex', 'x.workers.dev']) {
      assert.deepEqual(await fetchPeerTube({ p: 'pt', host, id: 'vZNcho9kCoVzc8wZwacPtc' }),
        { ok: false, reason: 'assert_fail' })
    }
    assert.equal(called, 0, 'and no request was made at all')
  } finally {
    globalThis.fetch = real
  }
})

test('PeerTube disturbs no neighbour', () => {
  assert.equal(r('/lemmy.world/post/49966212').ref.p, 'lm')
  assert.equal(r('/mstdn.social/@stux/116994812581955524').ref.p, 'ms')
  assert.equal(r('/misskey.io/notes/ap7sliijot1f03nr').ref.p, 'mk')
  assert.equal(r('/pin/66287425756772418').ref.p, 'pn')
  assert.equal(r('/p/DbN6SsKum-9').ref.p, 'ig')
  assert.equal(r('/xqc/status/20').ref.p, 'x')
})
