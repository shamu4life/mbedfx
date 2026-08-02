import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickMedia } from '../src/media.ts'
import { serializePost, deserializePost } from '../src/cache.ts'

const post = {
  ref: { p: 'bs', handle: 'a.bsky.social', rkey: '3k2a' },
  canonical: 'https://bsky.app/x',
  author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social', avatar: 'https://cdn/avatar.jpg' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [
    { kind: 'image', url: 'https://cdn/0.jpg', w: 1, h: 1 },
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1, h: 1 },
  ],
}

test('numeric index picks from media[]', () => {
  assert.equal(pickMedia(post, 0), 'https://cdn/0.jpg')
  assert.equal(pickMedia(post, 1), 'https://cdn/1.jpg')
})

test('avatar index resolves to author.avatar', () => {
  assert.equal(pickMedia(post, 'avatar'), 'https://cdn/avatar.jpg')
})

test('out-of-range returns null, never a wrong URL', () => {
  assert.equal(pickMedia(post, 2), null)
  assert.equal(pickMedia(post, -1), null)
  assert.equal(pickMedia(post, 1.5), null)
  assert.equal(pickMedia({ ...post, media: [] }, 0), null)
})

test('missing avatar returns null', () => {
  assert.equal(pickMedia({ ...post, author: { ...post.author, avatar: undefined } }, 'avatar'), null)
})

test('a corrupted cached Post resolves to null instead of THROWING a 500', () => {
  // media[] and author are exactly the two fields the cache guard never inspects —
  // deserializePost validates ref, canonical and createdAt and nothing else — so a corrupted
  // record carrying media:[null,…] or author:null passes it and lands here intact. The round
  // trip below is the reachability proof, not decoration: it is the real guard, not a mock.
  //
  // Before this was total, each of these reads threw out of worker.ts's media branch, which
  // has no try/catch: `Cannot read properties of null (reading 'url')`, `… (reading 'avatar')`
  // and `Cannot read properties of undefined (reading 'length')`. That is an uncaught 500 on a
  // public path whose index segment the CALLER chooses (the router accepts any non-negative
  // integer), on a route whose entire contract is to degrade.
  const corrupt = deserializePost(serializePost({ ...post, media: [null, post.media[1]], author: null }))
  assert.ok(corrupt !== null, 'the cache guard accepts this shape, so pickMedia must too')
  assert.equal(pickMedia(corrupt, 0), null)
  // The entry AFTER the hole keeps its own index. Compacting on read would serve image 1's
  // bytes for the /_media/…/0 url the Mastodon mapper deliberately preserved.
  assert.equal(pickMedia(corrupt, 1), 'https://cdn/1.jpg')
  assert.equal(pickMedia(corrupt, 'avatar'), null)

  for (const bad of [undefined, null, 'not an array', 42, {}]) {
    assert.equal(pickMedia({ ...post, media: bad }, 0), null, `media ${JSON.stringify(bad) ?? 'undefined'}`)
  }
  for (const bad of [undefined, null, 42, 'nope']) {
    assert.equal(pickMedia({ ...post, author: bad }, 'avatar'), null, `author ${JSON.stringify(bad) ?? 'undefined'}`)
  }
})

test('a non-string media url is a hole, never a Location header', () => {
  // `url || null` returns a NUMBER for url:42, and worker.ts feeds the result straight into a
  // 302 Location. A non-string there is either a coerced nonsense redirect or a throw inside
  // Response construction — both worse than the 404 this route already knows how to emit.
  for (const bad of [{}, { kind: 'image', w: 1, h: 1 }, { kind: 'image', url: 42 }, { kind: 'image', url: null }, 'https://evil/', 7]) {
    assert.equal(pickMedia({ ...post, media: [bad] }, 0), null, `media[0] = ${JSON.stringify(bad)}`)
  }
})

// ---------------------------------------------------------------------------
// THE POSTER INDEX. `{poster: n}` resolves media[n]'s POSTER FRAME — a still image — where the
// bare `n` resolves the video itself. Mastodon's preview_url on a video attachment wants the
// former; ours used to send the latter, which is what cost us Discord's activity card.
// ---------------------------------------------------------------------------

const videoPost = {
  ...post,
  media: [
    { kind: 'video', url: 'https://cdn/v0.mp4', w: 720, h: 1280, poster: 'https://cdn/cover0.jpg' },
    { kind: 'video', url: 'https://cdn/v1.mp4', w: 720, h: 1280 },
  ],
}

test('a poster index resolves the POSTER, and never the video url', () => {
  assert.equal(pickMedia(videoPost, { poster: 0 }), 'https://cdn/cover0.jpg')
  // The inequality is the whole point: these two indices must name different bytes.
  assert.notEqual(pickMedia(videoPost, { poster: 0 }), pickMedia(videoPost, 0))
  assert.equal(pickMedia(videoPost, 0), 'https://cdn/v0.mp4', 'the bare index still names the video')
})

test('A POSTERLESS ENTRY IS NULL, NEVER A FALLBACK TO THE VIDEO', () => {
  // Falling back to m.url here would reinstate the exact defect — Discord asking for a poster
  // and receiving video bytes — through a different door. A 404 is the correct answer; the
  // renderer's job is to not advertise the url at all, and it is tested there too.
  assert.equal(pickMedia(videoPost, { poster: 1 }), null)
  assert.equal(pickMedia(post, { poster: 0 }), null, 'an image entry carries no poster')
})

test('a poster index is range-checked and type-checked like a numeric one', () => {
  assert.equal(pickMedia(videoPost, { poster: 2 }), null)
  assert.equal(pickMedia(videoPost, { poster: -1 }), null)
  assert.equal(pickMedia(videoPost, { poster: 1.5 }), null)
  assert.equal(pickMedia({ ...videoPost, media: [] }, { poster: 0 }), null)
})

test('a CORRUPTED poster resolves to null instead of throwing a 500', () => {
  // Same reachability argument as the sibling test above: deserializePost validates ref,
  // canonical and createdAt and nothing else, so media[].poster arrives from the cache
  // completely unvalidated, on a route whose index segment the caller chooses and which
  // worker.ts calls outside any try/catch.
  for (const bad of [42, null, {}, '', [], true]) {
    const p = deserializePost(serializePost({ ...post, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 1, h: 1, poster: bad }] }))
    assert.equal(pickMedia(p, { poster: 0 }), null, `poster = ${JSON.stringify(bad)}`)
  }
  for (const bad of [undefined, null, 'not an array', 42, {}]) {
    assert.equal(pickMedia({ ...post, media: bad }, { poster: 0 }), null, `media ${JSON.stringify(bad) ?? 'undefined'}`)
  }
  // A hole in media[] must not throw on the poster path either.
  const holed = deserializePost(serializePost({ ...post, media: [null] }))
  assert.equal(pickMedia(holed, { poster: 0 }), null)
})

test('the poster SURVIVES the cache round trip — it is a Media field like any other', () => {
  // serializePost is a plain JSON.stringify, so this is really asserting that nothing strips
  // unknown Media fields on the way through. If it ever did, every video would silently lose
  // its poster on a cache HIT only — the worst possible shape for this bug, since the miss
  // path would keep working and the failure would look intermittent.
  const revived = deserializePost(serializePost(videoPost))
  assert.equal(pickMedia(revived, { poster: 0 }), 'https://cdn/cover0.jpg')
})
