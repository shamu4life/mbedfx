import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeBluesky } from '../src/platforms/bluesky/normalize.ts'
import { refKey } from '../src/refkey.ts'

const raw = JSON.parse(readFileSync('test/fixtures/bluesky-post.json', 'utf8'))
const ref = { p: 'bs', handle: 'bsky.app', rkey: '3l6oveex3ii2l' }

/**
 * The live fixture has no embed and no parent, so quote/reply assertions against
 * it would run vacuously. This synthetic thread exercises both branches.
 */
const withQuoteAndParent = () => ({
  thread: {
    post: {
      uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
      author: { handle: 'root.bsky.social', displayName: 'Root' },
      record: { text: 'root post', createdAt: '2026-07-01T00:00:00Z' },
      embed: {
        record: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedkey',
          author: { handle: 'quoted.bsky.social', displayName: 'Quoted' },
          value: { text: 'quoted post', createdAt: '2026-06-01T00:00:00Z' },
        },
      },
    },
    parent: {
      post: {
        uri: 'at://did:plc:parent/app.bsky.feed.post/parentkey',
        author: { handle: 'parent.bsky.social', displayName: 'Parent' },
        record: { text: 'parent post', createdAt: '2026-05-01T00:00:00Z' },
      },
    },
  },
})

test('normalize is pure and produces a well-formed Post', () => {
  const post = normalizeBluesky(raw, ref)
  assert.ok(post, 'must normalize')
  assert.deepEqual(post.ref, ref, 'the root post keeps the ref the router produced')
  assert.equal(typeof post.text, 'string')
  assert.ok(post.text.length > 0, 'text must be present')
  assert.ok(post.author.handle.length > 0)
  assert.ok(post.createdAt instanceof Date)
  assert.ok(!Number.isNaN(post.createdAt.getTime()), 'createdAt must be a valid Date')
  assert.ok(Array.isArray(post.media))
  assert.equal(typeof post.sensitive, 'boolean')
})

test('canonical is rebuilt from the ref, so it matches the URL the user had', () => {
  const post = normalizeBluesky(raw, ref)
  assert.equal(post.canonical, 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l')
})

test('counts are numbers when present', () => {
  const post = normalizeBluesky(raw, ref)
  for (const k of ['likes', 'reposts', 'replies']) {
    if (post.counts[k] !== undefined) assert.equal(typeof post.counts[k], 'number')
  }
})

test('QUOTE AND REPLY GET THEIR OWN REF, NOT THE ROOT POST\'S', () => {
  // If a quote inherited the root's ref, refKey(quote.ref) === refKey(post.ref)
  // and /_media/{refKey}/{i} for the quote would resolve against the ROOT post's
  // media[] — serving the wrong image. This is exactly what PostRef exists to prevent.
  const post = normalizeBluesky(withQuoteAndParent(), ref)
  assert.ok(post.quote, 'quote must be present')
  assert.notEqual(refKey(post.quote.ref), refKey(post.ref), 'quote must NOT share the root ref')
  assert.deepEqual(post.quote.ref, { p: 'bs', handle: 'quoted.bsky.social', rkey: 'quotedkey' })
  assert.ok(post.replyTo, 'replyTo must be present')
  assert.deepEqual(post.replyTo.ref, { p: 'bs', handle: 'parent.bsky.social', rkey: 'parentkey' })
})

test('quote and reply depth is capped at exactly 1', () => {
  // Built from the synthetic fixture, not the live one: the live post has no embed
  // and no parent, so `if (post.quote)` guards would make this test run zero
  // assertions and pass vacuously.
  const post = normalizeBluesky(withQuoteAndParent(), ref)
  assert.ok(post.quote && post.replyTo, 'fixture must exercise both branches')
  assert.equal(post.quote.quote, undefined)
  assert.equal(post.quote.replyTo, undefined)
  assert.equal(post.replyTo.replyTo, undefined)
  assert.equal(post.replyTo.quote, undefined)
})

test('media extraction: images and video are pulled out of the embed', () => {
  // The live fixture has media: [], so without this the code behind every
  // og:image is never exercised.
  const withImages = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social', displayName: 'Root' },
        record: { text: 'has media', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          images: [
            { fullsize: 'https://cdn.bsky.app/one.jpg', alt: 'first', aspectRatio: { width: 800, height: 600 } },
            { fullsize: 'https://cdn.bsky.app/two.jpg', aspectRatio: { width: 400, height: 400 } },
            { notfullsize: 'skip me' },
          ],
        },
      },
    },
  }
  const p = normalizeBluesky(withImages, ref)
  assert.equal(p.media.length, 2, 'entries without fullsize are skipped, not emitted as undefined')
  assert.deepEqual(p.media[0], { kind: 'image', url: 'https://cdn.bsky.app/one.jpg', w: 800, h: 600, alt: 'first' })
  assert.equal(p.media[1].alt, undefined, 'missing alt must be undefined, not empty string')

  const withVideo = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'has video', createdAt: '2026-07-01T00:00:00Z' },
        // The REAL hydrated shape: app.bsky.embed.video#view carries playlist/thumbnail at the
        // embed's TOP LEVEL, not under a nested `.video` (a live capture confirmed this).
        embed: {
          $type: 'app.bsky.embed.video#view',
          playlist: 'https://cdn.bsky.app/v.m3u8',
          thumbnail: 'https://cdn.bsky.app/v-thumb.jpg',
          aspectRatio: { width: 1280, height: 720 },
        },
      },
    },
  }
  const v = normalizeBluesky(withVideo, ref)
  // HLS (.m3u8) is unplayable directly, so the video is a REMUX entry: the /_media/ route muxes the
  // playlist to a progressive MP4 via the container, with the thumbnail as the poster. Without the
  // container, withResolver degrades it to that poster still.
  assert.deepEqual(v.media, [{
    kind: 'video', url: 'https://cdn.bsky.app/v.m3u8', w: 1280, h: 720,
    poster: 'https://cdn.bsky.app/v-thumb.jpg', remux: { video: 'https://cdn.bsky.app/v.m3u8' },
  }])
})

test('missing aspectRatio degrades to 0x0 rather than throwing', () => {
  const noAr = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'x', createdAt: '2026-07-01T00:00:00Z' },
        embed: { images: [{ fullsize: 'https://cdn.bsky.app/a.jpg' }] },
      },
    },
  }
  const p = normalizeBluesky(noAr, ref)
  assert.equal(p.media[0].w, 0)
  assert.equal(p.media[0].h, 0)
})

test('quote media: viewRecord embeds[] (plural, no singular embed) still yields images', () => {
  // Regression test for the "quote media always dropped" defect: viewRecord's
  // lexicon shape carries `embeds` (an array), never a singular `embed`. Reaching
  // into rec.embed (singular) is always undefined, so quote.media was always [].
  const withQuoteImage = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social', displayName: 'Root' },
        record: { text: 'root post', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          record: {
            uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedkey',
            author: { handle: 'quoted.bsky.social', displayName: 'Quoted' },
            value: { text: 'quoted post', createdAt: '2026-06-01T00:00:00Z' },
            embeds: [
              {
                images: [
                  { fullsize: 'https://cdn.bsky.app/quoted.jpg', alt: 'q', aspectRatio: { width: 500, height: 500 } },
                ],
              },
            ],
          },
        },
      },
    },
  }
  const post = normalizeBluesky(withQuoteImage, ref)
  assert.ok(post.quote, 'quote must be present')
  assert.equal(post.quote.media.length, 1, 'quote media must be extracted from viewRecord.embeds[]')
  assert.deepEqual(post.quote.media[0], {
    kind: 'image',
    url: 'https://cdn.bsky.app/quoted.jpg',
    w: 500,
    h: 500,
    alt: 'q',
  })
})

test('gallery#view embeds are extracted as images', () => {
  const withGallery = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'has gallery', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          items: [
            { thumbnail: 'https://cdn.bsky.app/thumb1.jpg', fullsize: 'https://cdn.bsky.app/g1.jpg', alt: 'one', aspectRatio: { width: 300, height: 200 } },
            { thumbnail: 'https://cdn.bsky.app/thumb2.jpg', fullsize: 'https://cdn.bsky.app/g2.jpg', aspectRatio: { width: 300, height: 200 } },
          ],
        },
      },
    },
  }
  const post = normalizeBluesky(withGallery, ref)
  assert.equal(post.media.length, 2, 'gallery#view items must be extracted, not dropped')
  assert.deepEqual(post.media[0], { kind: 'image', url: 'https://cdn.bsky.app/g1.jpg', w: 300, h: 200, alt: 'one' })
  assert.equal(post.media[1].alt, undefined)
})

test('sensitive reflects label VALUES, not mere presence of any label', () => {
  const withLabel = (val) => ({
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'labeled', createdAt: '2026-07-01T00:00:00Z' },
        labels: [{ val, src: 'did:plc:labeler', uri: 'at://did:plc:root/app.bsky.feed.post/rootkey' }],
      },
    },
  })

  const porn = normalizeBluesky(withLabel('porn'), ref)
  assert.equal(porn.sensitive, true, 'porn is in the content-warning vocabulary')

  const nudity = normalizeBluesky(withLabel('nudity'), ref)
  assert.equal(nudity.sensitive, true, 'nudity is in the content-warning vocabulary')

  const spam = normalizeBluesky(withLabel('spam'), ref)
  assert.equal(spam.sensitive, false, 'a benign third-party label must NOT mark the post sensitive')
})

test('video alt text is preserved, not dropped', () => {
  const withVideoAlt = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'has video', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          $type: 'app.bsky.embed.video#view',
          playlist: 'https://cdn.bsky.app/v.m3u8',
          thumbnail: 'https://cdn.bsky.app/v-thumb.jpg',
          alt: 'a video of a cat',
          aspectRatio: { width: 1280, height: 720 },
        },
      },
    },
  }
  const post = normalizeBluesky(withVideoAlt, ref)
  assert.deepEqual(post.media, [{
    kind: 'video', url: 'https://cdn.bsky.app/v.m3u8', w: 1280, h: 720,
    poster: 'https://cdn.bsky.app/v-thumb.jpg', remux: { video: 'https://cdn.bsky.app/v.m3u8' },
    alt: 'a video of a cat',
  }])
})

test('Bluesky video is a remux video (poster = thumbnail); no thumbnail means no media', () => {
  // HLS (.m3u8) is unplayable directly, so a video post is a REMUX entry — the /_media/ route muxes
  // the playlist to a progressive MP4 via the container, poster = the video's still thumbnail (which
  // also carries the whole card when no container is bound). The thumbnail is REQUIRED as that
  // guaranteed still: without it we emit NO media, never a video with no fallback frame.
  const withThumb = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'video post', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          $type: 'app.bsky.embed.video#view',
          playlist: 'https://cdn.bsky.app/v2.m3u8',
          thumbnail: 'https://cdn.bsky.app/v2-thumb.jpg',
          aspectRatio: { width: 640, height: 360 },
        },
      },
    },
  }
  const withThumbPost = normalizeBluesky(withThumb, ref)
  assert.deepEqual(withThumbPost.media, [{
    kind: 'video', url: 'https://cdn.bsky.app/v2.m3u8', w: 640, h: 360,
    poster: 'https://cdn.bsky.app/v2-thumb.jpg', remux: { video: 'https://cdn.bsky.app/v2.m3u8' },
  }])

  const noThumb = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'video post, no thumbnail', createdAt: '2026-07-01T00:00:00Z' },
        embed: { $type: 'app.bsky.embed.video#view', playlist: 'https://cdn.bsky.app/v3.m3u8', aspectRatio: { width: 640, height: 360 } },
      },
    },
  }
  const noThumbPost = normalizeBluesky(noThumb, ref)
  assert.deepEqual(noThumbPost.media, [], 'no thumbnail must mean no media entry, never a video with no fallback frame')
})

test('recordWithMedia#view: quote with gallery loses no images — fallback required', () => {
  // Regression test: a post that quotes another post AND attaches a gallery — via
  // recordWithMedia#view shape {record, media: {items:[...]} } — must not silently
  // drop the gallery's images. recordWithMedia#view.media accepts gallery#view,
  // so the e.items fallback must check e.media?.items.
  const withQuoteGallery = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social', displayName: 'Root' },
        record: { text: 'root post with gallery quote', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          record: {
            uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedkey',
            author: { handle: 'quoted.bsky.social', displayName: 'Quoted' },
            value: { text: 'quoted post', createdAt: '2026-06-01T00:00:00Z' },
          },
          media: {
            items: [
              { thumbnail: 'https://cdn.bsky.app/thumb1.jpg', fullsize: 'https://cdn.bsky.app/g1.jpg', alt: 'first', aspectRatio: { width: 600, height: 400 } },
              { thumbnail: 'https://cdn.bsky.app/thumb2.jpg', fullsize: 'https://cdn.bsky.app/g2.jpg', alt: 'second', aspectRatio: { width: 600, height: 400 } },
            ],
          },
        },
      },
    },
  }
  const post = normalizeBluesky(withQuoteGallery, ref)
  assert.ok(post, 'root post must normalize')
  // The gallery is in the recordWithMedia's media field, not in embeds[] as a separate view
  assert.equal(post.media.length, 2, 'gallery in recordWithMedia#view.media must not be dropped')
  assert.deepEqual(post.media[0], { kind: 'image', url: 'https://cdn.bsky.app/g1.jpg', w: 600, h: 400, alt: 'first' })
  assert.deepEqual(post.media[1], { kind: 'image', url: 'https://cdn.bsky.app/g2.jpg', w: 600, h: 400, alt: 'second' })
})

test('returns null on junk rather than throwing or inventing a Post', () => {
  for (const junk of [null, {}, { thread: {} }, { thread: { post: { record: {} } } },
                      { thread: { post: { record: { text: 'x' }, author: {} } } }]) {
    assert.equal(normalizeBluesky(junk, ref), null, JSON.stringify(junk))
  }
})
