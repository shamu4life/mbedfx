import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { mediaUrl } from '../src/render/embed.ts'
import { encodeStatusId } from '../src/statusid.ts'

const r = (p) => route(new URL(`https://staging.megapenispoopenfarten.sex${p}`))

test('site paths are allowlisted explicitly', () => {
  for (const p of ['/', '/index.html', '/favicon.ico', '/robots.txt']) {
    assert.equal(r(p).kind, 'site', `${p} must be a site path`)
  }
})

test('root replacement works for Bluesky permalinks', () => {
  assert.deepEqual(r('/profile/alice.bsky.social/post/3k2a'), {
    kind: 'post',
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  })
})

test('DID-form Bluesky permalinks route', () => {
  const got = r('/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6o')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' })
})

test('the /bs/ escape hatch forces Bluesky', () => {
  assert.deepEqual(r('/bs/profile/alice.bsky.social/post/3k2a'), {
    kind: 'post',
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  })
})

test('a real handle that collides with an escape token (x.com/x/status/…) still routes as a post', () => {
  // @x is X Corp's own live account. The /x/ escape hatch must try forcing X first,
  // find no post there (['status','123'] is depth 2, below x()'s depth-3 floor), and
  // fall through to the unforced interpretation — not dead-end into notfound.
  assert.deepEqual(r('/x/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/x/status/123',
  })
})

test('the explicit /x/x/status/… escape form still resolves after the fallthrough fix', () => {
  // Same collision as above, but spelled with the escape hatch AND the handle both
  // present. Must still resolve to the same canonical post, proving the forced match
  // is still tried (and still wins) before any fallthrough happens.
  assert.deepEqual(r('/x/x/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/x/status/123',
  })
})

test('media routes carry the full ref via refKey — including DIDs', () => {
  // The wire format is encodeURIComponent(refKey(ref)) — the renderer's mediaUrl()
  // helper builds it this way (see src/render/discord.ts), so the test must too.
  // A bare refKey(ref) here (raw ':' delimiters) would NOT round-trip for a DID:
  // the router's single outer decodeURIComponent would also unwrap the DID's own
  // per-component '%3A', over-splitting it into too many parts.
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' }
  assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/0`), { kind: 'media', ref, index: 0 })
  assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/avatar`), { kind: 'media', ref, index: 'avatar' })
})

test('media URL survives the full renderer→router round-trip, including a DID handle', () => {
  // This is the exact wire format src/render/discord.ts's mediaUrl() emits:
  // `${origin}/_media/${encodeURIComponent(refKey(p.ref))}/${i}`. Building the URL
  // the same way the renderer does, then routing it, proves the two encoding
  // layers (refKey's per-component encode + the renderer's whole-key encode) and
  // the router's two decoding layers (outer decodeURIComponent + parseRefKey's
  // per-component decode) actually invert each other end to end.
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: 'k' }
  const origin = 'https://staging.megapenispoopenfarten.sex'
  const mediaUrl = `${origin}/_media/${encodeURIComponent(refKey(ref))}/0`
  const got = route(new URL(mediaUrl))
  assert.deepEqual(got, { kind: 'media', ref, index: 0 })
})

test('a media URL whose colons were percent-normalized to %3A by an edge/proxy still resolves', () => {
  // This is the actual point of the I-2 fix: colons are legal, undecoded, in a URL
  // path segment (RFC 3986), but Discord's media proxy or any edge in front of it
  // is free to normalize them to %3A. Simulate that by taking the RAW refKey (with
  // its literal ':' join delimiters) and replacing every ':' with '%3A' — as if an
  // edge had "helpfully" percent-encoded them after the renderer emitted them raw.
  // The router's single outer decodeURIComponent must undo exactly this.
  const ref = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }
  const rawKey = refKey(ref) // 'bs:alice.bsky.social:3k2a' — literal colons
  const proxied = rawKey.replace(/:/g, '%3A') // simulates edge normalization
  assert.deepEqual(r(`/_media/${proxied}/0`), { kind: 'media', ref, index: 0 })
})

test('AMBIGUOUS PATHS ARE NEVER GUESSED', () => {
  const cases = [
    ['/mrbeast', ['x', 'ig']],
    ['/hashtag/nfl', ['x', 'bs']],
    ['/jack/followers', ['x', 'ig']],
    ['/zuck/following', ['x', 'ig']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/explore', ['x', 'ig', 'tt']],
    ['/messages', ['x', 'bs', 'rd']],
    ['/notifications', ['x', 'bs', 'rd']],
    ['/settings', ['x', 'bs', 'rd']],
    ['/settings/account', ['x', 'bs', 'rd']],
    ['/i/lists', ['x', 'ig']],
    ['/i/bookmarks', ['x', 'ig']],
    ['/gallery/abc123', ['rd', 'ig', 'im']],
  ]
  for (const [path, candidates] of cases) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', `${path} must be ambiguous, got ${got.kind}`)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
})

test('/i/status/{id} is X, not ambiguous — Instagram 404s at depth 3', () => {
  // @i IS a live Instagram account, but IG cannot shadow depth-3 paths.
  const got = r('/i/status/123')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'x', id: '123' })
})

test('/comments/{id} is Reddit — @comments is NOT a live IG account (verified 2026-07-17)', () => {
  const got = r('/comments/abc123')
  assert.equal(got.kind, 'post', 'a bare /comments link is a Reddit post, never an IG-ambiguous chooser')
  assert.deepEqual(got.ref, { p: 'rd', sub: '', id: 'abc123' })
})

test('unknown paths are notfound, never a guess', () => {
  assert.equal(r('/totally/unknown/deep/path').kind, 'notfound')
  assert.equal(r('/_media/garbage/0').kind, 'notfound')
  assert.equal(r('/_media/bs:alice:3k2a/notanindex').kind, 'notfound')
  assert.equal(r('/_alt/0').kind, 'notfound')
})

test('malformed percent-escapes are notfound, not a 500', () => {
  // decodeURIComponent throws URIError on these; unhandled, they are a trivially
  // reachable crash.
  for (const p of ['/%ZZ', '/%E0%A4%A', '/profile/%/post/x', '/_media/%ZZ/0']) {
    assert.doesNotThrow(() => r(p), `${p} must not throw`)
    assert.equal(r(p).kind, 'notfound', p)
  }
})

// ---------------------------------------------------------------------------
// The Mastodon-spoof callback routes (/api/v1/statuses/{id}, its /users/ alias,
// and /_oembed/{id}). Every test below is about ONE property: they are shape
// matches that FALL THROUGH on a miss, never reserved tokens that dead-end.
// ---------------------------------------------------------------------------

test('/api/status/123 still routes as an X post — @api is a LIVE X account (verified 2026-07-18)', () => {
  // THE anti-regression test for this whole feature. Dead-ending 'api' to "reserve"
  // it for the spoof route would shadow a real post permalink — the identical defect
  // fixed in 37386db, where /x/status/123 (a real post by @x) returned notfound.
  // Depth 3 is not the spoof shape, so activity() must return null and control must
  // reach matchPost, which reads seg[1]==='status' and produces the post.
  assert.deepEqual(r('/api/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/api/status/123',
  })
})

test('/users/status/123 still routes as an X post', () => {
  // @users is NOT live on x.com today, but the rule is about shape, not about which
  // handles happen to exist this week: a token is only consumed at the exact depth
  // the spoof uses it. Anything else falls through, so a handle that goes live later
  // costs us nothing.
  assert.deepEqual(r('/users/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/users/status/123',
  })
})

test('/_oembed/status/123 still routes as an X post', () => {
  // oembed() takes depth 2 only. Depth 3 falls through — unlike /_alt/ and /_media/,
  // which dead-end unconditionally (see the KNOWN LIMITATION test below).
  assert.deepEqual(r('/_oembed/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/_oembed/status/123',
  })
})

test('/api/status/123/photo/1 still collapses to the same post ref', () => {
  // Depth 5 under the 'api' token. The trailing /photo/N UI hint must keep collapsing
  // to the bare post, exactly as it does under any other handle.
  assert.deepEqual(r('/api/status/123/photo/1'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/api/status/123',
  })
})

test('an activity URL survives the full renderer→router round-trip, including a DID handle', () => {
  // Built exactly as the renderer builds it — `/api/v1/statuses/${encodeStatusId(refKey(ref))}` —
  // so this proves the codec and the router actually invert each other end to end.
  //
  // The DID case is the load-bearing one. refKey percent-encodes each component, so the
  // decoded key still contains '%3A' inside the handle; parseRefKey's own per-component
  // decode is what turns that back into 'did:plc:…'. If the router safeDecode'd the key a
  // SECOND time before parseRefKey, those escapes would collapse to bare colons and the
  // split(':') would see 5 parts instead of 3 — silently 404ing every Bluesky DID URL.
  for (const ref of [
    { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' },
    { p: 'x', id: '1234567890' },
  ]) {
    const got = r(`/api/v1/statuses/${encodeStatusId(refKey(ref))}`)
    assert.equal(got.kind, 'activity', `${refKey(ref)} must route as activity`)
    assert.deepEqual(got.ref, ref, refKey(ref))
  }
})

test('/_oembed/{id} round-trips to the same ref, DID handle included', () => {
  for (const ref of [
    { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' },
  ]) {
    assert.deepEqual(r(`/_oembed/${encodeStatusId(refKey(ref))}`), { kind: 'oembed', ref })
  }
})

test('the /users/{handle}/statuses/{id} decoy yields the SAME ref — the handle is decoration', () => {
  // We advertise the /users/ alias in the head because that is the shape FxEmbed uses and
  // Discord accepts. The handle segment carries no identity: the id already encodes the
  // whole ref. Two different handles must therefore be indistinguishable, which is also
  // what makes it safe to build the alias from an author handle we never parse back.
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' }
  const id = encodeStatusId(refKey(ref))
  const real = r(`/api/v1/statuses/${id}`)
  assert.equal(real.kind, 'activity')
  assert.deepEqual(r(`/users/alice.bsky.social/statuses/${id}`), real)
  assert.deepEqual(r(`/users/somebody.entirely.else/statuses/${id}`), real)
})

test('malformed spoof ids never throw', () => {
  // The {id} segment is caller-chosen and reaches decodeStatusId raw, so a throw here is
  // a trivially reachable 500 on a public path. '%ZZ' dies at safeDecode, 'abc' fails the
  // all-digits shape check, '999' fails the nonzero sentinel, and the empty form never
  // reaches depth 4 at all (filter(Boolean) drops the trailing slash).
  for (const p of [
    '/api/v1/statuses/%ZZ',
    '/api/v1/statuses/abc',
    '/api/v1/statuses/',
    '/_oembed/999',
    '/_oembed/%ZZ',
  ]) {
    assert.doesNotThrow(() => r(p), `${p} must not throw`)
  }
  // Only the one that is not spoof-SHAPED stays a plain notfound: depth 3 is not the shape,
  // so nothing about it says its caller wanted JSON. The rest are 'badid' — see below.
  assert.equal(r('/api/v1/statuses/').kind, 'notfound')
})

test('a spoof-SHAPED path whose {id} does not decode is badid, never plain notfound', () => {
  // The C2 hazard in the flesh, and the reason 'badid' exists as a route kind at all.
  // statusid.ts says an intermediary treating {id} as a number is "plausible: real Mastodon
  // ids ARE numeric snowflakes" — String(Number(id)) on the canonical 133-digit id yields
  // '1.0981150580971081e+132', which fails the all-digits shape check. Every case below
  // used to fall through to 'notfound', and worker.ts then answered a JSON consumer with
  // the HTML OpenGraph error embed at HTTP 200 (proven: JSON.parse threw "Unexpected
  // token '<'"). The shape is what says the caller wanted JSON; whether the id decodes is
  // a separate question, and conflating the two is what produced that bug.
  const id = encodeStatusId(refKey({ p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }))
  for (const p of [
    `/api/v1/statuses/${String(Number(id))}`, // coerced through a float somewhere upstream
    `/api/v1/statuses/${id.slice(0, -1)}`,    // truncated: the 3-digit framing stops dividing
    `/users/alice/statuses/${id.slice(1)}`,   // sentinel stripped by a numeric normalizer
    `/_oembed/${id.slice(1)}`,
    '/api/v1/statuses/abc',
    '/_oembed/999',
    // Dies at safeDecode, BEFORE the decoded segments exist. Pinned because that early
    // return is a separate code path: miss it and the one spoof id that fails on a
    // malformed escape is the one that still answers HTML.
    '/api/v1/statuses/%ZZ',
    '/_oembed/%ZZ',
  ]) {
    assert.doesNotThrow(() => r(p), `${p} must not throw`)
    assert.equal(r(p).kind, 'badid', p)
  }
})

test('badid never steals a path another rule can claim', () => {
  // badid is decided LAST — after matchPost, the `known` dead-end set and the ambiguity
  // table — so by construction it can only ever replace what was already a notfound. These
  // are the paths where a spoof shape and a real interpretation overlap; if any of them
  // turns into badid, the shape check has been hoisted above a matcher it must stay below.
  assert.equal(r('/api/status/123').kind, 'post')             // depth 3: not the spoof shape
  assert.equal(r('/users/status/statuses/123').kind, 'post')  // matches x() AND the alias shape
  assert.equal(r('/_oembed/status/123').kind, 'post')
  for (const p of ['/api', '/users', '/_oembed']) assert.equal(r(p).kind, 'ambiguous', p)
})

test('wrong-depth spoof shapes fall through instead of dead-ending', () => {
  // These land on notfound, which LOOKS like a dead end — the difference is that they got
  // there through matchPost/known/ambiguity rather than by an early return, which is what
  // the /api/status/123 and ambiguity-table tests prove. Pinned here so a future "just
  // return notfound if seg[0]==='api'" shortcut fails these AND those.
  assert.equal(r('/api/v1').kind, 'notfound')
  assert.equal(r('/api/v1/statuses').kind, 'notfound')
  // Depth 5 with a PERFECTLY VALID id: the length check must run, not just the decode.
  const id = encodeStatusId(refKey({ p: 'bs', handle: 'a.bsky.social', rkey: 'k' }))
  assert.equal(r(`/users/x/statuses/${id}/extra`).kind, 'notfound')
  assert.equal(r('/users/x/statuses/k/extra').kind, 'notfound')
})

test('ACCEPTANCE: the ambiguity table is UNCHANGED by the spoof routes', () => {
  // This is the acceptance criterion for fallthrough, and it only holds if the new helpers
  // return null on a miss. If any of api/users/_oembed were added to the `known` dead-end
  // set, or dead-ended in their own branch, these bare tokens would become notfound and
  // stop telling a human which site their link came from.
  for (const p of ['/api', '/users', '/_oembed']) {
    const got = r(p)
    assert.equal(got.kind, 'ambiguous', `${p} must stay ambiguous`)
    assert.deepEqual(got.candidates.slice().sort(), ['ig', 'x'], p)
  }
  // And the depth-2 forms stay exactly as honest as they were in Phase 1.
  assert.equal(r('/api/v1').kind, 'notfound')
  assert.equal(r('/users/someone').kind, 'notfound')

  // The depth-2 forms WITH a valid id — the half the bare tokens above cannot reach. The
  // oembed shape is depth 2, so its `seg[0] === '_oembed'` token check is the only thing
  // standing between these paths and an oembed route. Proven necessary by mutation:
  // deleting that token check leaves all 176 other tests passing, while /gallery/{id}
  // silently stops being ambiguous and starts serving a post as JSON.
  const id = encodeStatusId(refKey({ p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }))
  for (const [p, want] of [
    ['/gallery', ['ig', 'im', 'rd']],
    ['/settings', ['bs', 'rd', 'x']],
    ['/hashtag', ['bs', 'x']],
  ]) {
    const got = r(`${p}/${id}`)
    assert.equal(got.kind, 'ambiguous', `${p}/{id} must stay ambiguous`)
    assert.deepEqual(got.candidates.slice().sort(), want, `${p}/{id}`)
  }
  // Depth-1 tokens that are neither ambiguous nor a spoof shape stay notfound, valid id or
  // not: /jack/{id} is a bare profile at depth 2, and /x/{id} forces the X interpretation.
  assert.equal(r(`/x/${id}`).kind, 'notfound')
})

test('a path matching BOTH the alias shape and an X permalink resolves to the spoof', () => {
  // Undocumented precedence, pinned rather than endorsed. At depth 4, activity()'s alias arm
  // (seg[0]==='users', seg[2]==='statuses') and x()'s generic arm (seg[1]==='status') can
  // both match, and the spoof block runs first so the spoof wins. Practically unreachable —
  // it needs the X handle to be literally 'users' AND the post id literally 'statuses' —
  // but if a future edit widens either shape, the overlap widens with it and this is the
  // only thing that will say so.
  const ref = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }
  const got = r(`/users/status/statuses/${encodeStatusId(refKey(ref))}`)
  assert.equal(got.kind, 'activity')
  assert.deepEqual(got.ref, ref)
  // The ordinary case is untouched: an id that does not decode still falls through to X.
  assert.deepEqual(r('/users/status/statuses/123'), {
    kind: 'post',
    ref: { p: 'x', id: 'statuses' },
    canonical: 'https://x.com/users/status/statuses',
  })
})

test('KNOWN LIMITATION: /_media/ and /_alt/ dead-end even though @_media and @_alt are live X accounts', () => {
  // Recorded, NOT endorsed. Both branches return before any post match is attempted, so a
  // real X permalink under either handle is shadowed — the same defect class the spoof
  // helpers above are written to avoid, already shipped in Phase 1. Verified live
  // 2026-07-18: @_media and @_alt both resolve on x.com (content-probed; the dead-handle
  // error page is the load-bearing signal, not the status code).
  //
  // Deliberately out of Phase 2 scope: fixing it means making /_media/ fall through, which
  // touches the media wire format. Pinned so a future fix is a deliberate act with a test
  // to update, not an accident.
  assert.equal(r('/_media/status/123').kind, 'notfound')
  assert.equal(r('/_alt/status/123').kind, 'notfound')
})

test('query params are ignored for identity', () => {
  const a = route(new URL('https://h.test/profile/alice.bsky.social/post/3k2a'))
  const b = route(new URL('https://h.test/profile/alice.bsky.social/post/3k2a?igshid=xyz&utm_source=q'))
  assert.deepEqual(a, b)
})

// ---------------------------------------------------------------------------
// TikTok post permalinks (Phase 3a Task 2). Short links (/t/{code}) are NOT
// here: route() is synchronous and a short code is not a post id, so they get
// their own Route kind and an async resolver in the next task.
// ---------------------------------------------------------------------------

test('TikTok video and photo permalinks route — depth 3, safe by the depth rule', () => {
  assert.deepEqual(r('/@mysticaquarium/video/7660566211100511518'), {
    kind: 'post',
    ref: { p: 'tt', id: '7660566211100511518' },
    canonical: 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518',
  })
  assert.deepEqual(r('/@someone/photo/7412345678901234567'), {
    kind: 'post',
    ref: { p: 'tt', id: '7412345678901234567' },
    canonical: 'https://www.tiktok.com/@someone/photo/7412345678901234567',
  })
})

test('/@i/video/{id} routes — the username is not needed to resolve a post', () => {
  // Verified 2026-07-18: tiktok.com/@i/video/{id} resolves without knowing the handle.
  // This is what makes PostRef {p:'tt', id} sufficient identity for the platform.
  const got = r('/@i/video/7660566211100511518')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'tt', id: '7660566211100511518' })
})

test('every TikTok path shape for one post collapses to the SAME cache key', () => {
  // refKey is the cache key AND the /_media/ identity. Two spellings of one post must not
  // cost two upstream fetches or split the media namespace.
  const a = r('/@mysticaquarium/video/7660566211100511518')
  const b = r('/@i/video/7660566211100511518')
  const c = r('/tt/@other/photo/7660566211100511518')
  assert.equal(refKey(a.ref), 'tt:7660566211100511518')
  assert.equal(refKey(a.ref), refKey(b.ref))
  assert.equal(refKey(a.ref), refKey(c.ref))
})

test('the /tt/ escape hatch forces TikTok, and FALLS THROUGH when it does not match', () => {
  assert.deepEqual(r('/tt/@u/video/123'), {
    kind: 'post',
    ref: { p: 'tt', id: '123' },
    canonical: 'https://www.tiktok.com/@u/video/123',
  })
  // @tt is a plausible X handle and /tt/status/123 is a real X permalink shape. Forcing
  // TikTok finds nothing there, and the router must fall through rather than dead-end —
  // the defect class fixed in 37386db (/x/status/123) and again for @api.
  assert.deepEqual(r('/tt/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/tt/status/123',
  })
})

test('a TikTok-shaped path is not confused with the Threads shape at the same depth', () => {
  // /@{user}/post/{code} is Threads; segment 2 (`post` vs `video`/`photo`) is the whole
  // discriminator against TikTok at the same depth. It must be a th post, NEVER a tt ref.
  const got = r('/@someone/post/DTI1vjIEi5y')
  assert.equal(got.kind, 'post')
  assert.equal(got.ref.p, 'th', 'a Threads permalink is a Threads post, not TikTok')
  assert.equal(got.ref.code, 'DTI1vjIEi5y')
})

test('Threads permalinks mint a th post from the shortcode, canonical kept', () => {
  assert.deepEqual(r('/@pmestevez/post/DDYEM_foiI1'), {
    kind: 'post',
    ref: { p: 'th', code: 'DDYEM_foiI1' },
    canonical: 'https://www.threads.com/@pmestevez/post/DDYEM_foiI1',
  })
  // Base64url shortcodes carry '-' and '_'; they must not be rejected.
  assert.equal(r('/@a/post/AbC-_123').ref.code, 'AbC-_123')
})

test('the Threads matcher requires the exact `post` segment, not just @ + depth 3', () => {
  // Segment 1 is the discriminator: `video`/`photo` are TikTok, anything else at this shape is not a
  // Threads post. A bare @-profile (depth 1) is the chooser, never a post.
  assert.equal(r('/@user/reel/123').kind, 'notfound', 'not a Threads shape')
  assert.notEqual(r('/@user/video/123').ref?.p, 'th', 'that is TikTok, not Threads')
  assert.notEqual(r('/@user').kind, 'post', 'a bare profile is not a post')
})

test('the /th/ escape hatch forces the Threads reading', () => {
  assert.deepEqual(r('/th/@u/post/ABC'), {
    kind: 'post',
    ref: { p: 'th', code: 'ABC' },
    canonical: 'https://www.threads.com/@u/post/ABC',
  })
})

test('Reddit permalinks mint an rd post; the slug and comment id are dropped', () => {
  assert.deepEqual(r('/r/pics/comments/haucpf/some_slug'), {
    kind: 'post',
    ref: { p: 'rd', sub: 'pics', id: 'haucpf' },
    canonical: 'https://www.reddit.com/r/pics/comments/haucpf',
  })
  // No slug is fine too.
  assert.deepEqual(r('/r/aww/comments/abc123').ref, { p: 'rd', sub: 'aww', id: 'abc123' })
  // A deeper path (a specific comment) is still the post.
  assert.equal(r('/r/pics/comments/haucpf/slug/cmntid').ref.id, 'haucpf')
})

test('bare /comments and /user post links resolve, subreddit recovered later from the payload', () => {
  assert.deepEqual(r('/comments/haucpf').ref, { p: 'rd', sub: '', id: 'haucpf' })
  assert.deepEqual(r('/user/spez/comments/xyz').ref, { p: 'rd', sub: '', id: 'xyz' })
  assert.deepEqual(r('/u/spez/comments/xyz').ref, { p: 'rd', sub: '', id: 'xyz' })
})

test('a subreddit LISTING (no comments segment) is not a post', () => {
  // /r/{sub} names a community, not a post — it must not be fetched as one.
  assert.equal(r('/r/pics').kind, 'notfound')
  assert.equal(r('/r/pics/hot').kind, 'notfound')
})

test('/r/{sub}/s/{code} is the app SHARE link — a redditshare route, not a post, not notfound', () => {
  // The Reddit mobile app's "copy link" hands out /r/{sub}/s/{code}. The code is an opaque share
  // token, so this cannot be a post ref (there is no id yet); the worker resolves the 301 to the
  // permalink. Before this route it fell through to 'r' in the KNOWN dead-end set and rendered
  // "not found" — the exact bug the two real links (BatmanArkham image, DankPods video) hit.
  assert.deepEqual(r('/r/BatmanArkham/s/uucSZtDEbI'), {
    kind: 'redditshare',
    sub: 'BatmanArkham',
    code: 'uucSZtDEbI',
    canonical: 'https://www.reddit.com/r/BatmanArkham/s/uucSZtDEbI',
  })
  // A /user or /u profile-post share link resolves the same way; the sub is unknown until the
  // redirect, so it is carried empty (the resolver reads it from the permalink).
  assert.deepEqual(r('/user/spez/s/x9jj4whH9W'), {
    kind: 'redditshare',
    sub: '',
    code: 'x9jj4whH9W',
    canonical: 'https://www.reddit.com/user/spez/s/x9jj4whH9W',
  })
  assert.equal(r('/u/spez/s/x9jj4whH9W').kind, 'redditshare')
})

test('a redditshare is NOT a post ref — an opaque share code must never enter a PostRef', () => {
  const got = r('/r/DankPods/s/x9jj4whH9W')
  assert.notEqual(got.kind, 'post', 'the code is not a post id until the redirect resolves it')
  assert.equal(got.ref, undefined, 'a share code is not identity')
})

test('the /s/ share match does not swallow a real permalink or a listing', () => {
  // seg[2] must be exactly 's' at length 4 — a /comments/ permalink and a bare listing are untouched.
  assert.equal(r('/r/pics/comments/haucpf').kind, 'post')
  assert.equal(r('/r/pics').kind, 'notfound')
  assert.equal(r('/r/pics/s').kind, 'notfound', 'no code after /s/ is not a share link')
})

test('the /rd/ escape hatch forces the Reddit reading', () => {
  assert.deepEqual(r('/rd/r/pics/comments/haucpf'), {
    kind: 'post',
    ref: { p: 'rd', sub: 'pics', id: 'haucpf' },
    canonical: 'https://www.reddit.com/r/pics/comments/haucpf',
  })
})

test('YouTube: /watch?v={id}, /shorts, /embed, /live, /v all resolve to one yt post by video id', () => {
  const ID = 'dQw4w9WgXcQ'
  const expect = { kind: 'post', ref: { p: 'yt', id: ID }, canonical: `https://www.youtube.com/watch?v=${ID}` }
  assert.deepEqual(r(`/watch?v=${ID}`), expect, 'the id lives in the QUERY for /watch')
  assert.deepEqual(r(`/shorts/${ID}`), expect)
  assert.deepEqual(r(`/embed/${ID}`), expect)
  assert.deepEqual(r(`/live/${ID}`), expect)
  assert.deepEqual(r(`/v/${ID}`), expect)
})

test('YouTube: the id must be EXACTLY 11 url-safe chars, else nothing is claimed', () => {
  // A /watch with a bad/absent v is NOT a yt post — it degrades to the bare-'watch' ambiguity chooser,
  // which is fine; the load-bearing invariant is that youtube is never MINTED by guess.
  assert.notEqual(r('/watch?v=short').ref?.p, 'yt', 'too short is not youtube')
  assert.notEqual(r('/watch').ref?.p, 'yt', 'no v is not youtube')
  assert.notEqual(r('/watch?v=twelvecharss1').ref?.p, 'yt', 'too long (13) is not youtube')
  assert.equal(r('/shorts/toolongforanid').kind, 'notfound', 'shorts needs an exactly-11-char id')
  assert.equal(r('/shorts/has.dot.bad').kind, 'notfound', 'a . is not in the id alphabet')
})

test('YouTube: trailing junk on ?v= still resolves (a pasted tail / cache-buster), but a longer id does not', () => {
  // Reported 2026-07-24: /watch?v={id}/??? rendered "Ambiguous link". The id is a FIXED 11 chars, so
  // taking the leading 11 when the next char cannot be part of an id is exact, not a guess.
  assert.deepEqual(r('/watch?v=dQw4w9WgXcQ/???').ref, { p: 'yt', id: 'dQw4w9WgXcQ' })
  assert.deepEqual(r('/watch?v=dQw4w9WgXcQ&t=42s').ref, { p: 'yt', id: 'dQw4w9WgXcQ' }, 'a normal &t= paste')
  // A 12+ char token is NOT truncated into a different video — it stays unrouted.
  assert.notEqual(r('/watch?v=dQw4w9WgXcQX').ref?.p, 'yt')
  // And Facebook's long numeric v still routes to Facebook, with or without a tail.
  assert.deepEqual(r('/watch/?v=10153231379946729').ref, { p: 'fb', kind: 'watch', id: '10153231379946729' })
  assert.deepEqual(r('/watch/?v=10153231379946729/???').ref, { p: 'fb', kind: 'watch', id: '10153231379946729' })
})

test('YouTube: a bare /{id} is the youtu.be short link (exactly 11 chars -> yt, else the chooser)', () => {
  // youtu.be/{id} domain-swaps to a BARE /{id}. Claimed for YouTube because the only other meaning of a
  // bare /{11-char} is an x/ig PROFILE, which we do not render (a dead-end chooser) — so this trades a
  // dead end for a working video. A bare handle of any OTHER length still chooses.
  assert.deepEqual(r('/9-nTGfTQ_zl'), {
    kind: 'post', ref: { p: 'yt', id: '9-nTGfTQ_zl' }, canonical: 'https://www.youtube.com/watch?v=9-nTGfTQ_zl',
  })
  assert.equal(r('/dQw4w9WgXcQ').ref?.p, 'yt', 'an all-alphanumeric 11-char bare id is YouTube too')
  assert.equal(r('/mrbeast').kind, 'ambiguous', 'a 7-char bare handle is untouched — still the chooser')
  assert.equal(r('/twelvecharsss').kind, 'ambiguous', 'a 13-char bare handle is not a video id')
})

test('YouTube: the /yt/ escape hatch forces the reading for a pathname form', () => {
  assert.deepEqual(r('/yt/shorts/dQw4w9WgXcQ'), {
    kind: 'post', ref: { p: 'yt', id: 'dQw4w9WgXcQ' }, canonical: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })
})

test('Facebook: watch / reel / share / page-videos forms resolve, disambiguated from YouTube and Instagram', () => {
  const FBID = '10153231379946729'
  assert.deepEqual(r(`/watch/?v=${FBID}`), {
    kind: 'post', ref: { p: 'fb', kind: 'watch', id: FBID }, canonical: `https://www.facebook.com/watch/?v=${FBID}`,
  }, 'a long NUMERIC /watch?v is Facebook (YouTube ids are 11 url-safe chars)')
  assert.deepEqual(r(`/reel/${FBID}`), {
    kind: 'post', ref: { p: 'fb', kind: 'reel', id: FBID }, canonical: `https://www.facebook.com/reel/${FBID}`,
  }, 'a NUMERIC /reel is Facebook')
  assert.deepEqual(r('/share/v/Fixture1'), {
    kind: 'post', ref: { p: 'fb', kind: 'share', id: 'Fixture1' }, canonical: 'https://www.facebook.com/share/v/Fixture1',
  })
  assert.equal(r('/share/r/Fixture1').ref?.p, 'fb', '/share/r is the same share form')
  assert.deepEqual(r(`/cnn/videos/${FBID}`).ref, { p: 'fb', kind: 'watch', id: FBID }, '/{page}/videos/{id} is a watch')
})

test('Facebook: the /watch and /reel shapes it shares stay with YouTube / Instagram for their own ids', () => {
  // /watch?v={11-char yt id} is still YouTube (checked before the Facebook numeric branch).
  assert.equal(r('/watch?v=dQw4w9WgXcQ').ref?.p, 'yt')
  // /reel/{alphanumeric IG code} is still Instagram (Facebook only claims all-numeric reels).
  assert.deepEqual(r('/reel/C1a2b3c4d5e').ref, { p: 'ig', kind: 'p', code: 'C1a2b3c4d5e' })
  // the /fb/ escape hatch forces Facebook for a pathname form.
  assert.deepEqual(r(`/fb/reel/10153231379946729`).ref, { p: 'fb', kind: 'reel', id: '10153231379946729' })
})

test('a bare @-prefixed segment offers the sites that actually use @ in a URL', () => {
  // Judgement call, not a measured fact: there is no profile Route kind, so this can only
  // ever be a chooser, and x.com/@user / instagram.com/@user are not real links. Revert by
  // deleting the '@' branch in ambiguity().
  const got = r('/@mysticaquarium')
  assert.equal(got.kind, 'ambiguous')
  assert.deepEqual(got.candidates.slice().sort(), ['th', 'tt'])
})

test('the two "@" rules agree on what counts as an @-handle', () => {
  // ambiguity()'s '@' row and tiktok()'s `seg[0].length > 1` are the same judgement made in
  // two different functions, and nothing but this test ties them together. The property is
  // agreement, NOT a specific candidate list: whatever tiktok() is willing to treat as a
  // handle at depth 3, the chooser must be willing to treat as an @-profile at depth 1.
  //
  // A bare '@' names no profile anywhere, so both must reject it; '@@' is a handle of '@',
  // which tiktok() accepts, so the chooser must accept it too. Asserting ['ig','x'] for '@@'
  // would re-create the drift in the opposite direction.
  const isAtProfile = p => {
    const got = r(p)
    assert.equal(got.kind, 'ambiguous', p)
    return got.candidates.slice().sort().join() === 'th,tt'
  }
  const isAtPost = p => r(`${p}/video/123`).kind === 'post'
  for (const p of ['/@', '/@@', '/@u', '/@mysticaquarium']) {
    assert.equal(isAtProfile(p), isAtPost(p), `${p}: the depth-1 and depth-3 '@' rules disagree`)
  }
  // Pin the bare-'@' end of it explicitly, since that is the row this task changed.
  assert.deepEqual(r('/@').candidates.slice().sort(), ['ig', 'x'])
  assert.equal(r('/@/video/123').kind, 'notfound')
})

test('ACCEPTANCE: the ambiguity table changes ONLY where this task says it does', () => {
  // Phase 2 shipped this invariant; this task amends it in exactly ONE row (bare /@{user})
  // and must leave every other row alone. EVERY other row of ambiguity() is re-asserted
  // below — enumerated against the function itself, not sampled — so an accidental second
  // change cannot ride along. (Task 6 adds /t/{code} as a `shortlink` ROUTE, not an
  // ambiguity row, so this table is still the whole table after Task 6 too.)
  const unchanged = [
    ['/mrbeast', ['x', 'ig']],
    ['/hashtag/nfl', ['x', 'bs']],
    ['/jack/followers', ['x', 'ig']],
    ['/zuck/following', ['x', 'ig']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/explore', ['x', 'ig', 'tt']],
    ['/messages', ['x', 'bs', 'rd']],
    ['/notifications', ['x', 'bs', 'rd']],
    ['/settings', ['x', 'bs', 'rd']],
    ['/settings/account', ['x', 'bs', 'rd']],
    ['/i/lists', ['x', 'ig']],
    ['/i/bookmarks', ['x', 'ig']],
    // /i/moments had NO assertion anywhere in the suite before this line — the one row of
    // ambiguity() that no test covered.
    ['/i/moments', ['x', 'ig']],
    ['/gallery/abc123', ['rd', 'ig', 'im']],
    ['/api', ['x', 'ig']],
    ['/users', ['x', 'ig']],
    ['/_oembed', ['x', 'ig']],
  ]
  for (const [path, candidates] of unchanged) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', `${path} must still be ambiguous, got ${got.kind}`)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
  assert.equal(r('/api/v1').kind, 'notfound')
  assert.equal(r('/users/someone').kind, 'notfound')
})

test('every canonical route() emits is a valid, header-safe URL', () => {
  // REGRESSION: canonical is built by interpolating segments route() has ALREADY
  // decodeURIComponent'd, and worker.ts puts it straight into a `location` header for human
  // clients. A segment decoding to CR, LF, NUL, or any codepoint > U+00FF therefore made
  // `new Headers({location})` throw — an uncaught TypeError surfacing as HTTP 500, because
  // handle() has no try/catch and the default export does not wrap it.
  //
  // Measured before the fix: injecting each codepoint 0x00..0x17F into the handle segment of
  // /@u{c}/video/123 turned 131 previously-notfound paths into a crash. tiktok() was the
  // widest entry point, but x() and bluesky() carry the identical defect and were already
  // live — so this asserts across ALL THREE matchers, not just the new one.
  const hostile = [
    '\r\nX-Injected: 1', // CRLF — the header-injection shape
    '\u0000',            // NUL — rejected by the header value grammar
    '\u{1F4A9}',         // > U+00FF — not representable as a ByteString
    'é',            // Latin-1 accented: representable, must still be encoded
  ]
  const shapes = [
    s => `/@u${s}/video/123`,          // tiktok(), handle segment
    s => `/@u/video/1${s}`,            // tiktok(), id segment
    s => `/u${s}/status/123`,          // x(), handle segment
    s => `/u/status/1${s}`,            // x(), id segment
    s => `/profile/a${s}/post/3k2a`,   // bluesky(), handle segment
    s => `/profile/a/post/3k2a${s}`,   // bluesky(), rkey segment
    /**
     * THE SHORTLINK ROUTE, and it is the WIDEST entry point of the lot. Every shape above
     * requires a literal 'video'/'status'/'post' segment beside the hostile one; this one
     * requires only that the code segment be TRUTHY, so a single decoded segment reaches
     * `canonical` with no validation of any kind — and worker.ts hands it to redirect() for
     * every human. Verified: with the canonical() wrapper reverted to a bare template literal
     * (the plan's Task 6 sketch), /t/%0d%0aX-Injected:%201 throws
     * `TypeError: Headers.append: … invalid header value` out of handle(), i.e. HTTP 500 on a
     * public URL, with the entire rest of the suite still green.
     */
    s => `/t/${s}`,                    // shortlink(), the code segment
    s => `/tt/t/${s}`,                 // shortlink() through the /tt/ escape hatch
    /**
     * instagram(), and it is now the widest post matcher in the file. The depth-3 arm sends
     * BOTH an arbitrary seg[0] (the username position) and an arbitrary seg[2] (the code) into
     * canonical() with no validation beyond truthiness and a leading-'@' refusal — two
     * injection sites where every shape above has one. Verified by mutation: with instagram()'s
     * two canonical() calls replaced by bare template literals and NOTHING else changed, all
     * 409 tests stayed green while these five paths threw
     * `TypeError: Headers.append: … is an invalid header value` out of handle() — HTTP 500 on a
     * public URL anyone can paste. Both positions are listed because they fail independently.
     */
    s => `/p/${s}`,                    // instagram(), depth-2 code segment
    s => `/someuser/p/${s}`,           // instagram(), depth-3 code segment
    s => `/u${s}/p/ABC`,               // instagram(), depth-3 USERNAME segment
  ]
  for (const shape of shapes) {
    for (const h of hostile) {
      const path = shape(encodeURIComponent(h))
      const got = r(path)
      // EVERY Route kind that carries a canonical, not just 'post'. The earlier spelling was
      // `got.kind !== 'post'`, which structurally excluded the shortlink route twice over — its
      // shapes were absent AND a shortlink Route would have been skipped had one been added.
      if (!('canonical' in got)) continue // notfound is a fine answer here; a crash is not
      // The two independent things a Location header needs, asserted separately so a
      // failure says which one broke.
      assert.doesNotThrow(
        () => new URL(got.canonical),
        `${path}: canonical must parse as a URL, got ${JSON.stringify(got.canonical)}`,
      )
      assert.doesNotThrow(
        () => new Headers({ location: got.canonical }),
        `${path}: canonical must be a legal header value, got ${JSON.stringify(got.canonical)}`,
      )
    }
  }
})

test('normalizing canonical does not disturb the URLs that were already valid', () => {
  // The obvious fix — encodeURIComponent per segment — is WRONG: it turns '@mysticaquarium'
  // into '%40mysticaquarium' and mangles a Bluesky DID's colons into %3A. This pins the exact
  // bytes of the ordinary cases so a future "hardening" edit that over-encodes goes red here
  // rather than silently changing every canonical we emit.
  assert.equal(
    r('/@mysticaquarium/video/7660566211100511518').canonical,
    'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518',
  )
  assert.equal(r('/jack/status/123').canonical, 'https://x.com/jack/status/123')
  assert.equal(
    r('/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6o').canonical,
    'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6o',
  )
})

// ---------------------------------------------------------------------------
// /t/{code} short links. A Route kind of their own, NOT a post ref — route() is
// synchronous and a short code names no post until something resolves it.
// ---------------------------------------------------------------------------

test('/t/{code} is a SHORTLINK route — not a post, not a guess, not a dead end', () => {
  // Today 't' sits in the `known` dead-end set, so a human pasting a TikTok short link is told
  // the link does not exist — while production serves that exact link correctly. The route
  // means "resolve this code"; p:'tt' names the RESOLVER to run, not the platform the link
  // belongs to. Threads mints /t/{code} too, and the resolver's no-answer is a chooser.
  assert.deepEqual(r('/t/ZTSw2mYwR'), {
    kind: 'shortlink',
    p: 'tt',
    code: 'ZTSw2mYwR',
    canonical: 'https://www.tiktok.com/t/ZTSw2mYwR',
  })
})

test('a shortlink is NOT a post ref — a short code must never enter a PostRef', () => {
  const got = r('/t/ZTSw2mYwR')
  assert.notEqual(got.kind, 'post', 'that would be guessing against Threads')
  assert.equal(got.ref, undefined, 'a short code is not identity until it is resolved')
})

test('the shortlink route does not shadow a real depth-3 permalink under @t', () => {
  // matchPost runs BEFORE the shortlink branch, so /t/status/123 — a real X permalink by @t —
  // still routes as X. This is the defect class fixed in 37386db and again for @api; removing
  // 't' from `known` must not reintroduce it at a different depth.
  assert.deepEqual(r('/t/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/t/status/123',
  })
})

test('/tt/t/{code} — the documented escape hatch reaches the shortlink route too', () => {
  // router.ts documents the ESCAPE tokens as THE way to force a platform interpretation, and
  // /t/{code} is the one TikTok shape that had no forced twin: /tt/t/ZTSw2mYwR was notfound
  // while /t/ZTSw2mYwR resolved. Nothing is shadowed by fixing that — unforced, /tt/t/{code} is
  // a depth-3 path no matcher claims — and the forced block keeps its fallthrough: a shape the
  // forced interpretation cannot claim still falls through to the unforced one below.
  assert.deepEqual(r('/tt/t/ZTSw2mYwR'), {
    kind: 'shortlink',
    p: 'tt',
    code: 'ZTSw2mYwR',
    canonical: 'https://www.tiktok.com/t/ZTSw2mYwR',
  })
  // Forcing a DIFFERENT platform must not mint a TikTok resolver call. /bs/t/{code} is not a
  // Bluesky shape and there is no Bluesky short form, so it stays what it was.
  assert.notEqual(r('/bs/t/ZTSw2mYwR').kind, 'shortlink')
})

test('/t alone is still not a shortlink', () => {
  // Depth 1. There is no code to resolve, so this falls through to the ordinary bare-segment
  // handling rather than resolving the empty string against TikTok.
  assert.notEqual(r('/t').kind, 'shortlink')
})

test('ACCEPTANCE: the ambiguity table is STILL unchanged by the shortlink route', () => {
  // /t/{code} became a Route kind, not an ambiguity row, so Task 2's table is still the whole
  // table. Re-asserted here because dropping 't' from `known` is exactly the kind of edit that
  // silently re-shapes a neighbouring row.
  for (const [path, candidates] of [
    ['/mrbeast', ['x', 'ig']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/gallery/abc123', ['rd', 'ig', 'im']],
  ]) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', path)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
})

// ---------------------------------------------------------------------------
// THE .mp4 SUFFIX ON /_media/{key}/{index}, added 2026-07-19 as part of the
// production-parity head (see src/render/discord.ts's PRODUCTION PARITY docstring).
//
// WHY THE ROUTER HAD TO MOVE AT ALL: production fxtiktok's og:video / twitter:player URL ends in
// '.mp4' and ours ended in a bare '/0'. That suffix is one of the deltas between the two heads,
// and the parity change stopped bisecting single tags — so the suffix ships with the rest of the
// head rather than being reasoned about on its own. A URL we advertise has to resolve, so the
// index segment learned to tolerate it.
//
// THE EXTENSIONLESS FORM IS NOT LEGACY and must never be removed: it is what every existing test
// asserts, what the Bluesky path emits, what the plain-og head still emits, and what the Mastodon
// media_attachments (which is what actually draws Discord's inline player) still emit. Only the
// spoof head's og:video / twitter:player pair gained the suffix.
// ---------------------------------------------------------------------------

test('/_media/{key}/0.mp4 resolves IDENTICALLY to /_media/{key}/0', () => {
  // Asserted as Route EQUALITY rather than as two separate shape checks, because "resolves to
  // the same bytes" is the actual requirement: the suffixed URL is a second spelling of one
  // resource, not a second resource.
  const ref = { p: 'tt', id: '777' }
  const key = encodeURIComponent(refKey(ref))
  assert.deepEqual(r(`/_media/${key}/0.mp4`), r(`/_media/${key}/0`))
  assert.deepEqual(r(`/_media/${key}/0.mp4`), { kind: 'media', ref, index: 0 })
})

test('the .mp4 tolerance covers a DID-handle Bluesky ref and a non-zero index too', () => {
  // The DID case is where the two decode layers live (see the _media branch's comment), so a
  // change to the INDEX segment gets asserted against the hardest KEY segment as well — the two
  // are parsed by the same branch and an edit that reordered them would pass a tt-only test.
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' }
  const key = encodeURIComponent(refKey(ref))
  assert.deepEqual(r(`/_media/${key}/2.mp4`), { kind: 'media', ref, index: 2 })
  assert.deepEqual(r(`/_media/${key}/2.mp4`), r(`/_media/${key}/2`))
})

test('the avatar index is UNTOUCHED by the extension tolerance', () => {
  // 'avatar' is matched before the integer parse and the strip happens after that match, so this
  // is a structural guarantee rather than a lucky ordering — but it is the index the spoof head's
  // og:image points at on a text-only post, so it gets its own assertion.
  const ref = { p: 'tt', id: '777' }
  const key = encodeURIComponent(refKey(ref))
  assert.deepEqual(r(`/_media/${key}/avatar`), { kind: 'media', ref, index: 'avatar' })
})

test('a bogus extension does NOT become index 0 by accident', () => {
  // The whole risk of this change: a permissive strip turns arbitrary junk into a valid media
  // index, and every one of these would then serve real bytes for a URL we never minted.
  //
  // '.mp4' with no digits is the sharp one — Number('') is 0, not NaN, so a strip that ran
  // unconditionally would resolve /_media/{key}/.mp4 to the FIRST media entry. The others pin
  // that the tolerance is an allowlisted media extension on a bare integer and nothing wider.
  //
  // NOT IN THIS LIST, deliberately: '0.' and '0.0', which resolve to index 0 TODAY and still do
  // — Number('0.') is 0. That is pre-existing Number() looseness in the branch, older than this
  // change and untouched by it; tightening it would be a change to shipped routing behaviour
  // riding along on a parity fix, which is exactly the coupling this commit exists to avoid.
  const key = encodeURIComponent(refKey({ p: 'tt', id: '777' }))
  for (const seg of ['0.exe', 'x.mp4', '.mp4', '0.mp4.mp4', 'avatar.mp4', '-1.mp4', '0.MP4']) {
    assert.equal(r(`/_media/${key}/${seg}`).kind, 'notfound', `/_media/{key}/${seg} must not resolve`)
  }
})

test('the extension tolerance changes NOTHING about a segment that has no extension', () => {
  // The regression guard for every /_media/ URL that existed before this change. The strip is
  // gated on a full-segment match, so a non-matching segment reaches Number() byte-identical to
  // what it reached before — including the pre-existing rejections.
  const key = encodeURIComponent(refKey({ p: 'tt', id: '777' }))
  assert.deepEqual(r(`/_media/${key}/0`), { kind: 'media', ref: { p: 'tt', id: '777' }, index: 0 })
  assert.deepEqual(r(`/_media/${key}/7`), { kind: 'media', ref: { p: 'tt', id: '777' }, index: 7 })
  assert.equal(r(`/_media/${key}/notanindex`).kind, 'notfound')
  assert.equal(r(`/_media/${key}/-1`).kind, 'notfound')
})

// ---------------------------------------------------------------------------
// THE POSTER INDEX, added 2026-07-19.
//
// Mastodon's `preview_url` on a VIDEO attachment is the POSTER FRAME, not a second copy of the
// video url. Ours pointed at the mp4, so Discord asked for a poster, got video bytes, and fell
// back to the plain OpenGraph card — measured against production, whose video attachment carries
// preview_url ".../generate/COVER/{id}", an IMAGE. Our slideshows were never affected because an
// image IS its own poster.
//
// The poster therefore needs a /_media/ address of its own: we never emit raw CDN urls, so
// "the cover" has to be reachable through the same 302 as everything else.
//
// SHAPE: `poster{N}`, addressing the poster of media entry N.
//   - It cannot collide with a NUMERIC index: it starts with a letter, so Number() is NaN. The
//     collision is structurally impossible rather than merely unlikely.
//   - It cannot collide with 'avatar': different literal prefix, and 'avatar' is matched first.
//   - It carries the entry index, so it still means something on a post with more than one video
//     — a bare 'poster' would have to guess which entry it meant.
// ---------------------------------------------------------------------------

test('/_media/{key}/poster0 addresses the POSTER of media 0, not media 0 itself', () => {
  const ref = { p: 'tt', id: '777' }
  const key = encodeURIComponent(refKey(ref))
  assert.deepEqual(r(`/_media/${key}/poster0`), { kind: 'media', ref, index: { poster: 0 } })
  // Distinct from the video's own url — that inequality IS the bug this shape exists to fix.
  assert.notDeepEqual(r(`/_media/${key}/poster0`), r(`/_media/${key}/0`))
  assert.deepEqual(r(`/_media/${key}/poster3`), { kind: 'media', ref, index: { poster: 3 } })
})

test('THE POSTER INDEX ROUND-TRIPS through mediaUrl back to the same ref', () => {
  // The renderer mints it and this branch parses it: one wire format, two sides. Built with the
  // renderer's OWN helper rather than a hand-written string, so this is an encoding test rather
  // than a transcription test — and asserted against the hardest key segment (a DID, whose
  // colons ride two encode layers) for the reason the .mp4 tests give.
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' }
  const origin = 'https://staging.megapenispoopenfarten.sex'
  const url = mediaUrl(origin, { ref }, { poster: 2 })
  assert.equal(url, `${origin}/_media/${encodeURIComponent(refKey(ref))}/poster2`)
  assert.deepEqual(route(new URL(url)), { kind: 'media', ref, index: { poster: 2 } })
  // And no bare colon reached the wire, same rule as every other /_media/ url.
  assert.ok(!url.slice(`${origin}/_media/`.length).includes(':'), `bare colon on the wire: ${url}`)
})

test('the poster segment tolerates an image extension, like the numeric one tolerates .mp4', () => {
  const ref = { p: 'tt', id: '777' }
  const key = encodeURIComponent(refKey(ref))
  assert.deepEqual(r(`/_media/${key}/poster0.jpg`), r(`/_media/${key}/poster0`))
  assert.deepEqual(r(`/_media/${key}/poster0.jpeg`), { kind: 'media', ref, index: { poster: 0 } })
  assert.deepEqual(r(`/_media/${key}/poster1.webp`), { kind: 'media', ref, index: { poster: 1 } })
})

test('a poster-SHAPED segment that is not one does NOT resolve', () => {
  // Same risk the .mp4 tolerance had: a permissive rule turns junk into a valid index and then
  // serves real bytes for a url we never minted. 'poster' with no digits is the sharp one —
  // Number('') is 0 — and 'poster0.mp4' matters because a poster is an IMAGE: handing a video
  // extension back for it is the confusion this whole fix is about.
  const key = encodeURIComponent(refKey({ p: 'tt', id: '777' }))
  for (const seg of ['poster', 'poster.jpg', 'posterx', 'poster-1', 'poster1.5', 'poster0.exe',
                     'poster0.mp4', 'posteravatar', 'Poster0', '0poster', 'poster 0']) {
    assert.equal(r(`/_media/${key}/${seg}`).kind, 'notfound', `/_media/{key}/${seg} must not resolve`)
  }
})

test('the poster index changes NOTHING about the numeric and avatar segments', () => {
  // The regression guard for every /_media/ url minted before this change. The poster branch is a
  // full-segment match placed after 'avatar' and before the integer parse, so a segment that is
  // not poster-shaped reaches Number() byte-identical to what it reached before.
  const ref = { p: 'tt', id: '777' }
  const key = encodeURIComponent(refKey(ref))
  assert.deepEqual(r(`/_media/${key}/0`), { kind: 'media', ref, index: 0 })
  assert.deepEqual(r(`/_media/${key}/0.mp4`), { kind: 'media', ref, index: 0 })
  assert.deepEqual(r(`/_media/${key}/avatar`), { kind: 'media', ref, index: 'avatar' })
  assert.equal(r(`/_media/${key}/avatar.mp4`).kind, 'notfound')
  assert.equal(r(`/_media/${key}/notanindex`).kind, 'notfound')
})

// ---------------------------------------------------------------------------
// Instagram post permalinks. Four surfaces, ONE ref — see router.ts's
// instagram() docstring for the verified fact that makes the collapse legal.
// ---------------------------------------------------------------------------

test('every Instagram post shape routes, at depth 2', () => {
  for (const [path, code] of [
    ['/p/DaQ5CPTki4E', 'DaQ5CPTki4E'],
    ['/reel/Da5ynsiuAZ_', 'Da5ynsiuAZ_'],
    ['/reels/Da5ynsiuAZ_', 'Da5ynsiuAZ_'],
    ['/tv/BsOGulcndj-', 'BsOGulcndj-'],
  ]) {
    const got = r(path)
    assert.equal(got.kind, 'post', path)
    assert.deepEqual(got.ref, { p: 'ig', kind: 'p', code }, path)
  }
})

test('the /{user}/p/{code} form routes, and keeps the pasted canonical', () => {
  const got = r('/mrbeast/p/DaQ5CPTki4E')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' })
  // canonical is what worker.ts 302s a HUMAN to, so it is the URL they pasted, not a rebuilt
  // one. The normalizer rebuilds its own from the payload — it has evidence; route() does not.
  assert.match(got.canonical, /instagram\.com\/mrbeast\/p\/DaQ5CPTki4E/)
})

test('EVERY SPELLING OF ONE POST COLLAPSES TO THE SAME CACHE KEY', () => {
  // THE POINT OF THIS TASK. /p/ and /reel/ embed endpoints are byte-identically interchangeable
  // (verified 2026-07-19), so these are provably one post. Left un-collapsed, pasting a reel two
  // ways costs TWO upstream fetches on the platform we rate most fragile, and splits its
  // /_media/ namespace so the two embeds carry different URLs naming the same bytes.
  const keys = ['/p/ABC123', '/reel/ABC123', '/reels/ABC123', '/tv/ABC123',
                '/ig/p/ABC123', '/someuser/p/ABC123'].map(p => refKey(r(p).ref))
  assert.deepEqual([...new Set(keys)], ['ig:p:ABC123'], `expected one key, got ${keys.join(', ')}`)
})

test('an ig:reel: key minted BEFORE this change still resolves — parseRefKey is untouched', () => {
  // The allowlist stays, but NOT for the backward-compatibility reason it looks like: no router
  // ever minted an ig ref (verified across every commit — the only `p: 'ig'` sites were inside
  // parseRefKey, reading), so the set of ig:reel: URLs in the wild is provably EMPTY. This pins
  // the allowlist because removing it would be gratuitous churn on a decoder, and because a
  // decoder that silently narrows is how /_media/ URLs die quietly.
  assert.deepEqual(parseRefKey('ig:reel:ABC'), { p: 'ig', kind: 'reel', code: 'ABC' })
  assert.deepEqual(parseRefKey('ig:tv:ABC'), { p: 'ig', kind: 'tv', code: 'ABC' })
})

test('the /ig/ escape hatch forces Instagram, and FALLS THROUGH when it does not match', () => {
  // ASSERT THE CANONICAL, NOT JUST THE REF. matchPost's own docstring states the rule this
  // pins — every forced arm needs an unforced twin — but the ref ALONE cannot detect the arm
  // going missing: with `if (forced === 'ig') return instagram(seg)` deleted, /ig/p/ABC falls
  // through to the UNFORCED depth-3 arm, which reads 'ig' as a username and mints a ref that
  // is deepEqual-identical. Only the canonical differs, and it differs into a dead link:
  // instagram.com/ig/p/ABC, which is where worker.ts 302s a human. Verified by mutation —
  // deleting that one line left all 409 tests green before this assertion existed.
  assert.deepEqual(r('/ig/p/ABC').ref, { p: 'ig', kind: 'p', code: 'ABC' })
  assert.equal(r('/ig/p/ABC').canonical, 'https://www.instagram.com/p/ABC/')
  // And the depth-3 form, which the unforced fallthrough cannot reach at all: seg.slice(1) is
  // depth 3 only when the hatch is consumed, so without the forced arm this is notfound.
  assert.deepEqual(r('/ig/someuser/p/ABC').ref, { p: 'ig', kind: 'p', code: 'ABC' })
  assert.equal(r('/ig/someuser/p/ABC').canonical, 'https://www.instagram.com/someuser/p/ABC/')
  // @ig is a plausible handle and /ig/status/123 is a real Twitter permalink shape. Forcing
  // Instagram finds nothing there, and the router must fall through rather than dead-end — the
  // defect class fixed in 37386db (/x/status/123) and again for @api.
  assert.deepEqual(r('/ig/status/123'), {
    kind: 'post', ref: { p: 'x', id: '123' }, canonical: 'https://x.com/ig/status/123',
  })
})

test('an @-prefixed depth-3 path is NOT claimed as Instagram', () => {
  // Instagram never puts '@' in a URL path; TikTok and Threads do. /@u/p/{code} is nobody's
  // shape and must stay notfound rather than being guessed into ig.
  assert.notEqual(r('/@someone/p/ABC').kind, 'post')
})

test('the depth-3 arm matches EXACTLY depth 3 — a fourth segment is not decoration', () => {
  // REGRESSION: relaxing `seg.length === 3` to `>= 3` left all 64 router tests green, which
  // made /someuser/p/ABC/anything a post at arbitrary depth. The depth-2 arm's equivalent guard
  // was already pinned (by /p/a/b below); this is the missing half of that pair. Unlike X,
  // Instagram has no trailing UI segment — there is no /p/{code}/photo/1 — so a fourth segment
  // means the path is not an Instagram permalink at all.
  assert.equal(r('/someuser/p/ABC/x').kind, 'notfound')
  assert.equal(r('/someuser/reel/ABC/x').kind, 'notfound')
})

test('STORIES ARE OUT OF SCOPE and stay an honest notfound — at EVERY username', () => {
  // No story equivalent of /embed/captioned/ exists, stories expire in 24h, and they are the one
  // IG shape that is plausibly private. See the plan's Task 2 for all three reasons.
  assert.equal(r('/stories/someone/123').kind, 'notfound')
  // REGRESSION, and the safe spelling above could not catch it. Instagram's story URL is
  // /stories/{username}/{story_id}, so when the username is one of the four surface tokens the
  // depth-3 arm matched: 'stories' is not '@'-prefixed and seg[1] ∈ IG_SURFACE. @p, @reel,
  // @reels and @tv are all plausible handles, and /stories/tv/{id} minted a POST ref whose
  // `code` was really a 19-digit story id — the exact shape this task spends a paragraph
  // declaring out of scope, aimed at the one platform we rate most fragile.
  //
  // `known` cannot defend this on its own: route() consults it AFTER matchPost, so the matcher
  // has to decline the token itself.
  for (const surface of ['p', 'reel', 'reels', 'tv']) {
    assert.equal(r(`/stories/${surface}/17912345678901234`).kind, 'notfound', `/stories/${surface}/…`)
  }
  // Reddit's dead-end tokens were reachable by the identical route (/r/p/ABC, /comments/p/ABC).
  assert.equal(r('/r/p/ABC').kind, 'notfound')
  assert.equal(r('/comments/p/ABC').kind, 'notfound')
  // But the refKey support already in the tree is untouched — it costs nothing and is tested.
  assert.equal(refKey({ p: 'ig', kind: 'story', user: 'u', id: '1' }), 'ig:story:u:1')
})

test('an AMBIGUOUS token is never consumed as an Instagram username — /settings at any depth', () => {
  // REGRESSION: ambiguity()'s settings rule is DEPTH-INDEPENDENT by design — `if (a ===
  // 'settings') return ['x','bs','rd']` sits above the length branches — but matchPost runs
  // BEFORE ambiguity(), so the depth-3 arm consumed 'settings' as a username and turned four
  // declared-undecidable paths into a guessed Instagram post. A human was 302'd to
  // instagram.com/settings/p/ABC, which cannot exist: 'settings' is a reserved Instagram path,
  // not a profile.
  //
  // ambiguity()'s own docstring states the rule that was broken: "We never guess: a guess serves
  // the wrong post and nobody notices, which is the one failure mode we cannot debug." Declining
  // is not a lost route — instagram.com/settings/{surface}/{code} is not a real URL.
  for (const surface of ['p', 'reel', 'reels', 'tv']) {
    const got = r(`/settings/${surface}/ABC`)
    assert.equal(got.kind, 'ambiguous', `/settings/${surface}/ABC must stay undecided, got ${got.kind}`)
    assert.deepEqual(got.candidates.slice().sort(), ['bs', 'rd', 'x'])
  }
})

test('ACCEPTANCE: the ambiguity table is COMPLETELY UNCHANGED by this task', () => {
  // Instagram is the platform the depth rule is written ABOUT, so the instinct to touch this
  // table is strongest here and is wrong: /p/ and /reel/ are Instagram's OWN routes, which makes
  // segment-1 shadowing moot by construction (spec §Routing). Re-asserted in full so an
  // accidental change cannot ride along — /gallery/{id} especially, which stays contested
  // because @gallery is a live Instagram account.
  const unchanged = [
    ['/mrbeast', ['x', 'ig']],
    ['/hashtag/nfl', ['x', 'bs']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/explore', ['x', 'ig', 'tt']],
    ['/settings/account', ['x', 'bs', 'rd']],
    ['/i/lists', ['x', 'ig']],
    ['/gallery/abc123', ['rd', 'ig', 'im']],
    ['/api', ['x', 'ig']],
    ['/users', ['x', 'ig']],
    ['/_oembed', ['x', 'ig']],
    ['/@mysticaquarium', ['tt', 'th']],
  ]
  for (const [path, candidates] of unchanged) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', `${path} must still be ambiguous, got ${got.kind}`)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
  assert.equal(r('/api/v1').kind, 'notfound')
  assert.equal(r('/users/someone').kind, 'notfound')
  // COMPLETELY unchanged means at EVERY DEPTH, and the settings rule is the one row that spans
  // all of them. Asserting only /settings/account pinned depth 2 while depth 3 silently left the
  // set; the dedicated test above covers all four surface tokens.
  assert.deepEqual(r('/settings/p/ABC').candidates.slice().sort(), ['bs', 'rd', 'x'])
  // And the Instagram tokens do not start resolving to something new at any OTHER depth.
  assert.equal(r('/p/a/b').kind, 'notfound')
  // DEPTH 1 IS PART OF THE TABLE TOO. A bare /reel must NOT become a chooser: it would offer
  // instagram.com/reel, and this task's own premise is that /reel is Instagram's ROUTE PREFIX,
  // not a username — so the chooser would assert a link is valid on a site where it cannot be.
  // notfound is what these answered before Instagram routing existed, and it is what 'comments',
  // 'stories' and 'r' answer for the identical reason (each is also a plausible Twitter handle).
  for (const p of ['/p', '/reel', '/reels', '/tv']) {
    assert.equal(r(p).kind, 'notfound', `${p} is a route prefix, not a profile — no chooser`)
  }
})

test('Reddit and TikTok shapes are untouched by the Instagram matcher', () => {
  assert.deepEqual(r('/comments/abc').ref, { p: 'rd', sub: '', id: 'abc' })   // Reddit's, not IG
  assert.deepEqual(r('/@u/video/123').ref, { p: 'tt', id: '123' })
  assert.deepEqual(r('/@u/photo/123').ref, { p: 'tt', id: '123' })
})

// ---------------------------------------------------------------------------
// Twitter permalink routing (Task 1). The router was already Twitter-complete;
// these tests convert "routing is free" from a claim into evidence. The suite
// already covered the /x/ escape-token and @api spoof-token forms — these pin
// the ORDINARY forms (a real handle, /i/web/status), the five-spelling collapse
// to one cache key x:{id}, and that the ambiguity table gains no new row.
// ---------------------------------------------------------------------------

test('an ordinary Twitter permalink routes, and /photo/N /video/N are UI hints that collapse', () => {
  // The recon: x() matches /{handle}/status/{id} at depth >=3 and treats a trailing /photo/N or
  // /video/N as decoration on the SAME post — same id, same ref. These are the ORDINARY forms; the
  // suite already covers the escape-token (/x/…) and spoof-token (@api) variants.
  for (const [path, canon] of [
    ['/jack/status/20',            'https://x.com/jack/status/20'],
    ['/jack/status/20/photo/1',    'https://x.com/jack/status/20'],
    ['/NASA/status/1491475671058681863/video/1', 'https://x.com/NASA/status/1491475671058681863'],
    ['/i/status/1491475671058681863', 'https://x.com/i/status/1491475671058681863'],
    ['/i/web/status/1491475671058681863', 'https://x.com/i/web/status/1491475671058681863'],
  ]) {
    const got = r(path)
    assert.equal(got.kind, 'post', path)
    assert.equal(got.ref.p, 'x', path)
    assert.equal(got.canonical, canon, path)
  }
  // The id is the identity; the trailing UI hint must not change it.
  assert.equal(r('/jack/status/20').ref.id, '20')
  assert.equal(r('/jack/status/20/photo/1').ref.id, '20')
})

test('EVERY spelling of one tweet collapses to the SAME cache key x:{id}', () => {
  // The Twitter analogue of the Instagram ig:p:{code} collapse. /photo/N, /video/N, /i/status,
  // /i/web/status and the /x/ escape are five spellings of one post; refKey must fold them to one
  // entry and one /_media/ namespace, or one tweet costs multiple upstream fetches and splits its
  // media URLs. This is already TRUE (x() emits {p:'x',id} for all of them) — this pins it.
  const keys = [
    '/jack/status/20', '/jack/status/20/photo/1', '/jack/status/20/video/1',
    '/i/status/20', '/i/web/status/20', '/x/status/20',
  ].map(p => refKey(r(p).ref))
  assert.deepEqual([...new Set(keys)], ['x:20'], `expected one key, got ${keys.join(', ')}`)
})

test('a Twitter /_media/ url round-trips through refKey', () => {
  const ref = { p: 'x', id: '1491475671058681863' }
  assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/0`), { kind: 'media', ref, index: 0 })
  assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/poster0`),
    { kind: 'media', ref, index: { poster: 0 } })
  assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/avatar`),
    { kind: 'media', ref, index: 'avatar' })
})

test('ACCEPTANCE: the ambiguity table is UNCHANGED — Twitter adds no new ambiguity', () => {
  // Twitter is already in half these rows. This task adds a PLATFORM, not a routing rule, so the
  // chooser table must be byte-identical. Re-asserted so an accidental change cannot ride along.
  for (const [path, cands] of [
    ['/mrbeast', ['x', 'ig']],
    ['/hashtag/nfl', ['x', 'bs']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/explore', ['x', 'ig', 'tt']],
    ['/i/lists', ['x', 'ig']],
    ['/settings/account', ['x', 'bs', 'rd']],
  ]) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', path)
    assert.deepEqual(got.candidates.slice().sort(), cands.slice().sort(), path)
  }
})

// ---------------------------------------------------------------------------
// THE yt-dlp TIER — Dailymotion, Streamable, Imgur (2026-07-26). Route shapes are the highest-risk
// part of adding a platform, so each claim below is paired with the measurement that says it is free,
// and the DELIBERATE NON-CLAIMS are pinned too — a later edit that quietly adds one of them would
// silently serve the wrong post, which is the one failure mode this router says it cannot debug.
// ---------------------------------------------------------------------------

test('the yt-dlp tier claims only shapes that were measured notfound', () => {
  assert.deepEqual(r('/video/xaqwy7q'), {
    kind: 'post', ref: { p: 'dm', id: 'xaqwy7q' },
    canonical: 'https://www.dailymotion.com/video/xaqwy7q',
  })
  assert.deepEqual(r('/embed/video/xaqwy7q').ref, { p: 'dm', id: 'xaqwy7q' })
  assert.deepEqual(r('/e/moo'), {
    kind: 'post', ref: { p: 'st', id: 'moo' }, canonical: 'https://streamable.com/moo',
  })
  assert.deepEqual(r('/s/moo').ref, { p: 'st', id: 'moo' }, 'the share form is the same post')
  assert.deepEqual(r('/A61SaA1.gifv'), {
    kind: 'post', ref: { p: 'im', kind: 'post', id: 'A61SaA1' }, canonical: 'https://i.imgur.com/A61SaA1.gifv',
  })
})

test('NO SHADOW: every neighbouring permalink shape still routes byte-identically', () => {
  /**
   * The measured hazards, not a sample. A 178,964-path sweep found 232 working routes that a loosely
   * written matcher in this tier shadows — /topic/status/{id} is a real Twitter permalink by @topic,
   * /topic/reels/{id} and /topic/tv/{id} are real Instagram permalinks by user @topic. The tokens each
   * new matcher consumes ('video', 'embed', 'e', 's') are pinned against their real neighbours here.
   */
  assert.deepEqual(r('/topic/status/A61SaA1').ref, { p: 'x', id: 'A61SaA1' })
  assert.deepEqual(r('/topic/reels/A61SaA1').ref, { p: 'ig', kind: 'p', code: 'A61SaA1' })
  assert.deepEqual(r('/topic/tv/A61SaA1').ref, { p: 'ig', kind: 'p', code: 'A61SaA1' })
  // 'video' at seg[1] is TikTok's; 'embed' at depth 2 is YouTube's; 's' at seg[2] of depth 4 is Reddit's.
  assert.deepEqual(r('/@user/video/7660566211100511518').ref, { p: 'tt', id: '7660566211100511518' })
  assert.deepEqual(r('/embed/dQw4w9WgXcQ').ref, { p: 'yt', id: 'dQw4w9WgXcQ' })
  assert.equal(r('/r/pics/s/uucSZtDEbI').kind, 'redditshare')
  assert.deepEqual(r('/user/spez/comments/abc123').ref, { p: 'rd', sub: '', id: 'abc123' })
  // /t/{code} at depth 2 is still the TikTok shortlink — the Imgur topic shape was NOT added.
  assert.equal(r('/t/ZTdrJUgb1').kind, 'shortlink')
  assert.deepEqual(r('/reel/123456789012345').ref, { p: 'fb', kind: 'reel', id: '123456789012345' })
  assert.deepEqual(r('/p/BsOGulcndj-').ref, { p: 'ig', kind: 'p', code: 'BsOGulcndj-' })
})

test('THE DELIBERATE NON-CLAIMS: bare ids, galleries and albums are left exactly as they were', () => {
  /**
   * route() is HOST-AGNOSTIC — it reads url.pathname and url.searchParams and nothing else — so
   * dai.ly/{id}, streamable.com/{id} and imgur.com/{id} all collapse onto ONE bare /{id}. That is
   * measurably undecidable: Dailymotion's real id 'xaqwy7q' also satisfies Imgur's 5-7 alnum shape,
   * and youtube() already owns every exactly-11-char bare segment. Anyone "fixing" this by claiming
   * bare ids for one of the three would silently serve the wrong post for the other two.
   */
  for (const p of ['/A61SaA1', '/moo', '/xaqwy7q', '/mrbeast']) {
    const got = r(p)
    assert.equal(got.kind, 'ambiguous', `${p} must stay the chooser`)
    assert.deepEqual(got.candidates, ['x', 'ig'], p)
  }
  /**
   * TWO OF THESE NON-CLAIMS WERE RETIRED ON 2026-07-31, when Imgur stopped being a yt-dlp platform.
   * Both original reasons were about the CONTAINER, not about the router:
   *
   *   "/a/{id} is ALWAYS a playlist — a title and nothing else" was true of yt-dlp's top-level
   *   object and false of the album. Measured: `yt-dlp -J imgur.com/a/iX265HX` returns _type
   *   'playlist' whose ENTRIES carry real mp4 urls, thumbnails and durations, and Imgur's own API
   *   returns image_count plus every item's type/mime/dimensions/url in one cookie-free request.
   *
   *   "yt-dlp answers /gallery/{id} video-or-playlist unpredictably" dissolved with the container.
   *
   * The ROUTER-level objection to /gallery/ did not dissolve, and is honoured: reddit.com/gallery
   * and @gallery on Instagram are both real, so the row is still a chooser. Imgur is ADDED to it
   * rather than taking it, which is additive — no existing link changes meaning.
   */
  assert.deepEqual(r('/gallery/YcAQlkx').candidates, ['rd', 'ig', 'im'])
  assert.deepEqual(r('/a/iX265HX'), {
    kind: 'post', ref: { p: 'im', kind: 'album', id: 'iX265HX' },
    canonical: 'https://imgur.com/a/iX265HX',
  })
  // Still unclaimed: 'a' at depth 2 is Imgur's, but only with an id-shaped second segment.
  assert.equal(r('/a/notanimgurid').kind, 'notfound')
  assert.equal(r('/a').kind, 'ambiguous', 'a bare /a is the profile chooser, as before')
  // The Imgur topic shapes, whose loose form shadows 232 working routes.
  assert.equal(r('/t/unmuted/6lAn9VQ').kind, 'notfound')
  assert.equal(r('/topic/Funny/N8rOudd').kind, 'notfound')
  // Newgrounds is measured BLOCKED (NG Guard), so its free shapes stay unclaimed.
  assert.equal(r('/portal/view/59593').kind, 'notfound')
  assert.equal(r('/audio/listen/1041929').kind, 'notfound')
  // youtube() still owns every exactly-11-char bare segment, including ones shaped like a dm id.
  assert.deepEqual(r('/abcdefghijk').ref, { p: 'yt', id: 'abcdefghijk' })
  assert.deepEqual(r('/xaqwy7qABCD').ref, { p: 'yt', id: 'xaqwy7qABCD' })
})

test('the id SHAPES are bounded — a non-matching segment falls through, it does not become a post', () => {
  assert.equal(r('/video/notadailymotionid').kind, 'notfound', 'dm ids are x + base36')
  assert.equal(r('/video/xa').kind, 'notfound', 'too short')
  // A trailing slash leaves ONE segment, so /e/ is the bare-token profile chooser it has always been.
  assert.equal(r('/e/').kind, 'ambiguous', 'an empty id is not a post — the shape is unchanged')
  assert.equal(r('/s/a').kind, 'notfound', 'a 1-char streamable id is not a shape we have seen')
  assert.equal(r('/abcd.gifv').kind, 'ambiguous', 'a 4-char imgur id is outside the measured 5-7')
  assert.equal(r('/A61SaA1.mp4').kind, 'ambiguous', 'only .gifv — a direct .mp4 needs no fixing')
  assert.equal(r('/embed/video/nope').kind, 'notfound')
})

test('the /dm/ /st/ /im/ escape hatches force the tier — and are the ONLY way to reach a bare id', () => {
  // The forced depth-1 arm is what serves dai.ly/{id}, streamable.com/{id} and imgur.com/{id}, which
  // the unforced router cannot decide. Every forced arm has an unforced twin except this one, and that
  // exception is the whole point: forcing is the user naming the platform the path cannot.
  assert.deepEqual(r('/dm/xaqwy7q').ref, { p: 'dm', id: 'xaqwy7q' })
  assert.deepEqual(r('/st/moo').ref, { p: 'st', id: 'moo' })
  assert.deepEqual(r('/im/A61SaA1').ref, { p: 'im', kind: 'post', id: 'A61SaA1' })
  // And the unforced twins of the unforced shapes.
  assert.deepEqual(r('/dm/video/xaqwy7q').ref, { p: 'dm', id: 'xaqwy7q' })
  assert.deepEqual(r('/dm/embed/video/xaqwy7q').ref, { p: 'dm', id: 'xaqwy7q' })
  assert.deepEqual(r('/st/e/moo').ref, { p: 'st', id: 'moo' })
  assert.deepEqual(r('/st/s/moo').ref, { p: 'st', id: 'moo' })
  assert.deepEqual(r('/im/A61SaA1.gifv').ref, { p: 'im', kind: 'post', id: 'A61SaA1' })
  // The album arm is unforced (nothing competes for 'a'), so forcing it must reach the same ref
  // rather than dead-ending — the ESCAPE block's fallthrough rule.
  assert.deepEqual(r('/im/a/iX265HX').ref, { p: 'im', kind: 'album', id: 'iX265HX' })
  // /gallery/ is the one Imgur shape that is FORCED-ONLY, because its unforced row is a live
  // three-way chooser rather than a dead end.
  assert.deepEqual(r('/im/gallery/YcAQlkx').ref, { p: 'im', kind: 'gallery', id: 'YcAQlkx' })
  assert.equal(r('/gallery/YcAQlkx').kind, 'ambiguous', 'unforced it stays the chooser')
})

test('AN IMGUR SEO SLUG IS DECORATION — the id is the last component, and the slug never enters the ref', () => {
  /**
   * MEASURED 2026-08-15 against imgur.com and api.imgur.com. Imgur's own og:url for gallery aZVXS is
   * the SAME string whether you ask for /gallery/aZVXS, /t/funny/aZVXS or the slug form itself:
   *
   *   https://imgur.com/gallery/black-lotus-magic-gathering-card-destroyed-accidentally-aZVXS
   *
   * so `{seo_title}-{id}` is not one spelling among several, it is THE url the site hands out. The
   * API confirms where the seam falls rather than leaving it to be guessed off a hyphen count:
   * `post/v1/albums/aZVXS` returns `"seo_title":"black-lotus-magic-gathering-card-destroyed-
   * accidentally"` beside `"id":"aZVXS"` — title first, id last, one '-' joining them.
   *
   * THE BARE FORM STILL RESOLVES, which is why this looked fine for so long: every fixture and every
   * example url in this repo is bare, and imgur.com serves those. But nothing on the site PRODUCES a
   * bare url any more, so the share button, the address bar and the chooser page all emitted the one
   * shape route() refused. In production it rendered "Not found" on a live 7-image album.
   *
   * THE SLUG DOES NOT ENTER THE REF, for the reason twitch()'s channel does not: it is decoration.
   * Holding the ref at `im:gallery:aZVXS` keeps ONE cache entry for both spellings, keeps parseRefKey
   * and its allowlist untouched, and keeps IM_ID — which is interpolated into i.imgur.com urls — as
   * tight as it was. A slug in the ref would have widened the security boundary to fix a router bug.
   */
  const SLUG = 'black-lotus-magic-gathering-card-destroyed-accidentally-aZVXS'
  assert.deepEqual(r(`/im/gallery/${SLUG}`).ref, { p: 'im', kind: 'gallery', id: 'aZVXS' })
  assert.deepEqual(r(`/im/a/${SLUG}`).ref, { p: 'im', kind: 'album', id: 'aZVXS' })
  // 'a' is unforced (nothing competes for it), so its slug form must resolve unforced too.
  assert.deepEqual(r(`/a/${SLUG}`).ref, { p: 'im', kind: 'album', id: 'aZVXS' })

  // The canonical is the bare permalink, not the pasted slug: both spellings normalise to one url,
  // and imgur.com serves it (measured — /gallery/aZVXS answers with the album).
  assert.equal(r(`/im/gallery/${SLUG}`).canonical, 'https://imgur.com/gallery/aZVXS')

  // Unforced /gallery/ stays the three-way chooser it was; the slug changes nothing about that row,
  // it only makes the 'im' candidate the chooser offers a link that actually resolves.
  assert.equal(r(`/gallery/${SLUG}`).kind, 'ambiguous')

  // REGRESSION: the bare forms every fixture uses keep working.
  assert.deepEqual(r('/im/gallery/YcAQlkx').ref, { p: 'im', kind: 'gallery', id: 'YcAQlkx' })
  assert.deepEqual(r('/im/a/iX265HX').ref, { p: 'im', kind: 'album', id: 'iX265HX' })

  // A slug whose last component is not an id shape is still notfound — the gate did not loosen, it
  // moved to the component that actually carries the id.
  assert.equal(r('/im/gallery/black-lotus-destroyed').kind, 'notfound', 'trailing word is 9 chars')
  assert.equal(r('/im/a/some-title-abcd').kind, 'notfound', 'trailing word is 4, under the 5-7 bound')
})

test('THE ESCAPE BLOCK STILL FALLS THROUGH — /dm/videos/{id} is Facebook today and stays Facebook', () => {
  /**
   * MEASURED BEFORE AND AFTER. facebook()'s /{page}/videos/{id} arm claims these with seg[0] as the
   * page name, so /dm/videos/{numeric}, /st/videos/{numeric} and /im/videos/{numeric} are live
   * Facebook watch posts. Adding a token to ESCAPE would REPOINT them if the block dead-ended on a
   * forced miss — it does not, and this is the assertion that keeps that true. (It is also why the
   * bare tokens below stay the profile chooser rather than becoming notfound.)
   */
  for (const t of ['dm', 'st', 'im']) {
    assert.deepEqual(r(`/${t}/videos/123456789012345`).ref, { p: 'fb', kind: 'watch', id: '123456789012345' },
      `/${t}/videos/{id} must still be the Facebook permalink it is today`)
    const bare = r(`/${t}`)
    assert.equal(bare.kind, 'ambiguous', `/${t} bare must stay the profile chooser`)
    assert.deepEqual(bare.candidates, ['x', 'ig'])
  }
  assert.deepEqual(r('/fb/videos/123456789012345').ref, { p: 'fb', kind: 'watch', id: '123456789012345' })
})

test('THE TIER NEVER CONSUMES A TOKEN THE AMBIGUITY TABLE RESERVES', () => {
  /**
   * THE REGRESSION, measured 2026-07-26 by running the real route() over a 219,660-path sweep with the
   * tier on and off. ST_ID is /^[A-Za-z0-9]{2,16}$/ — loose enough to match the table's OWN reserved
   * tokens — so SIX paths stopped being the ['x','ig'] chooser and became Streamable posts:
   *
   *   /e/followers  /s/followers  /st/followers  /e/following  /s/following  /st/following
   *
   * That is a GUESS on a path the table declares undecidable, which is the identical defect this file
   * already fixed once for /settings/{surface}/{code}, and which ambiguity()'s own docstring forbids in
   * as many words. Those six were the WHOLE diff — every other change the tier makes is notfound ->
   * post — so this test is the sweep's result, pinned.
   */
  for (const token of ['followers', 'following']) {
    for (const path of [`/e/${token}`, `/s/${token}`, `/st/${token}`]) {
      const got = r(path)
      assert.equal(got.kind, 'ambiguous', `${path} must still be the chooser, got ${got.kind}`)
      assert.deepEqual(got.candidates, ['x', 'ig'], path)
    }
  }
  /**
   * AND THE WHOLE RESERVED SET, not just the two rows that are reachable at these depths. The matchers
   * consult the ambiguity table's own token list rather than a hand-written copy of the reachable
   * subset, so a row that MOVES depth later cannot quietly become a Streamable id. A non-chooser here
   * is still an honest notfound — what it must never be is a post.
   */
  const RESERVED = ['settings', 'search', 'explore', 'messages', 'notifications', 'hashtag',
    'followers', 'following', 'i', 'lists', 'bookmarks', 'moments', 'gallery']
  for (const token of RESERVED) {
    for (const path of [`/e/${token}`, `/s/${token}`, `/st/${token}`, `/dm/${token}`, `/im/${token}`,
      `/video/${token}`, `/embed/video/${token}`]) {
      assert.notEqual(r(path).kind, 'post', `${path} must not be consumed as an id`)
    }
  }
  // AND THE PLATFORM STILL WORKS, or the refusal has eaten the thing it was protecting.
  assert.deepEqual(r('/e/moo').ref, { p: 'st', id: 'moo' })
  assert.deepEqual(r('/s/moo').ref, { p: 'st', id: 'moo' })
  assert.deepEqual(r('/st/moo').ref, { p: 'st', id: 'moo' })
  assert.deepEqual(r('/e/qX7fT2b').ref, { p: 'st', id: 'qX7fT2b' })
  assert.deepEqual(r('/video/xaqwy7q').ref, { p: 'dm', id: 'xaqwy7q' })
  assert.deepEqual(r('/im/A61SaA1').ref, { p: 'im', kind: 'post', id: 'A61SaA1' })
  // i.imgur.com/{id}.gifv is NOT a reserved position — the segment the table sees is '{id}.gifv',
  // which it never names — so a legal .gifv url keeps working whatever word the id happens to spell.
  assert.deepEqual(r('/search.gifv').ref, { p: 'im', kind: 'post', id: 'search' })
})

test('yt-dlp-tier /_media/ urls round-trip through refKey — both directions or the route is dead', () => {
  // parseRefKey's `default: return null` makes a missing arm fail as a SILENT 404: a card with a
  // poster and a video url that resolve to nothing, with no error anywhere.
  // Imgur carries a `kind` since albums shipped; dm and st still do not.
  for (const ref of [{ p: 'dm', id: 'xaqwy7q' }, { p: 'st', id: 'moo' },
                     { p: 'im', kind: 'post', id: 'A61SaA1' }, { p: 'im', kind: 'album', id: 'iX265HX' }]) {
    assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/0`), { kind: 'media', ref, index: 0 })
    assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/poster0`), { kind: 'media', ref, index: { poster: 0 } })
    assert.deepEqual(parseRefKey(refKey(ref)), ref)
  }
})

test('THE AMBIGUITY TABLE IS HANDED OUT BY VALUE — a mutated candidates array cannot rewrite routing', () => {
  /**
   * The rows were hoisted into a module-level AMBIGUOUS so reserved() could derive its token set from
   * the same object rather than a second hand-written list. Before that, every ambiguity() arm
   * returned a FRESH array literal; returning the row itself made `candidates` an alias for
   * isolate-lifetime state, on a Worker that auto-deploys to the apex. One consumer sorting, pushing
   * or splicing in place — none does today, which is exactly the kind of fact that changes without
   * anyone opening router.ts — and every later request for any path reading that row serves a
   * different chooser for the life of the isolate, with no error anywhere.
   *
   * Asserted on the 'settings' row because it is the one two different paths reach (depth 1 and
   * depth 2+), so a shared array is observable across paths and not just across calls.
   */
  const first = r('/settings/account')
  assert.equal(first.kind, 'ambiguous')
  first.candidates.push('yt')
  first.candidates.sort()
  first.candidates[0] = 'tt'
  assert.deepEqual(r('/settings/account').candidates, ['x', 'bs', 'rd'], 'the table itself must be unmoved')
  assert.deepEqual(r('/settings').candidates, ['x', 'bs', 'rd'], 'and so must every other path reading that row')
  // Not the same array twice, either: two callers must not be able to reach each other's.
  assert.notEqual(r('/i/lists').candidates, r('/i/lists').candidates, 'each route() gets its own array')
})

test('EVERY FACEBOOK SHARE SPELLING ROUTES — the bare form was notfound, and that hid VIDEOS', () => {
  /**
   * Reported 2026-07-26: facebook.com/share/Fixture02X/ returned "Not found". Facebook's share sheet
   * emits a BARE /share/{code} as well as the typed /share/{v|r|p}/{code}, and the code is OPAQUE in
   * all four — only the 302 knows what it names.
   *
   * REFUSING THE BARE FORM REFUSED THE VIDEOS TOO, which is why this is a real bug and not a cosmetic
   * one. Measured the same day: /share/Fixture03X/ 302s to /reel/2209468366484962/ and yt-dlp extracts
   * it cleanly (150.209s mp4, "Are you 'Disturbed' | PhillyBanana"). That link differs from a working
   * /share/v/Fixture03X/ ONLY by the absent segment.
   */
  // THE TYPED FORMS ARE STILL FACEBOOK'S OUTRIGHT — they name the platform in the url.
  for (const p of ['/share/v/Fixture03X', '/share/r/Fixture03X']) {
    const got = r(p)
    assert.equal(got.kind, 'post', `${p} must route`)
    assert.equal(got.ref.p, 'fb', `${p} is Facebook's`)
    assert.equal(got.ref.kind, 'share', 'one opaque-code ref shape serves the typed spellings')
  }

  /**
   * THE BARE FORM IS NO LONGER FACEBOOK'S, and this half of the test was REVERSED on 2026-07-30.
   *
   * The original claim above — "the code is OPAQUE in all four, only the 302 knows what it names" —
   * was right, and that is exactly why assigning it to Facebook was wrong. THREADS mints the same
   * bare shape, so this arm was 302ing Threads share tokens to facebook.com: a site the sharer never
   * pasted. Measured live on production before the fix:
   *
   *     mbedfx.app/share/Fixture08X/ -> 302 -> https://www.facebook.com/share/v/Fixture08X
   *
   * The reporter's other code for the SAME post, `_pqHlzmHj`, was notfound instead — it leads with an
   * underscore, which FB_CODE refuses. Two codes, one post, two different wrong answers.
   *
   * It is now a 'metashare': both hosts are asked and whichever 302s owns the code. Everything the
   * original bug report cared about still holds — the bare form still ROUTES, and a Facebook video
   * behind one still resolves — it just resolves by asking instead of by assuming.
   */
  for (const p of ['/share/Fixture02X', '/share/Fixture03X', '/share/Fixture08X', '/share/_pqHlzmHj']) {
    const got = r(p)
    assert.equal(got.kind, 'metashare', `${p} is resolved, not attributed by shape`)
    assert.ok(got.code, 'and carries the opaque code')
  }
  // The underscore form used to be notfound purely because FB_CODE excluded it.
  assert.equal(r('/share/_pqHlzmHj').code, '_pqHlzmHj')
  // Still bounded: too short, or carrying a separator, is nobody's.
  for (const bad of ['/share/abc', '/share/a.b/c']) {
    assert.notEqual(r(bad).kind, 'metashare', `${bad} must not resolve`)
  }
})

test('/share/p/{code} IS FACEBOOK, NOT INSTAGRAM — it used to mint an ig ref', () => {
  // instagram()'s depth-3 arm matches /{user}/p/{code} and nothing stopped it reading the literal
  // 'share' as a username, so a Facebook post-share fetched a nonexistent Instagram shortcode.
  // facebook() precedes instagram() in matchPost, so naming the segment there is the entire fix.
  const got = r('/share/p/Fixture03X')
  assert.equal(got.ref.p, 'fb', 'the defect was ig')
  assert.equal(got.ref.id, 'Fixture03X')
})

test('the share claim SHADOWS NOTHING — measured over its neighbours', () => {
  // A user genuinely named 'share' still gets their permalink: x() precedes facebook(), and the
  // depth-3 arm accepts only v/r/p at seg[1].
  assert.equal(r('/share/status/20').ref.p, 'x', 'a tweet by @share is still a tweet')
  // FB_CODE is 5+ chars, so short segments stay unclaimed rather than minting a bogus ref.
  assert.equal(r('/share/abc').kind, 'notfound')
  assert.equal(r('/share/a/b/c').kind, 'notfound')
  // Instagram's own permalinks are untouched.
  assert.equal(r('/p/DbN6SsKum-9/').ref.p, 'ig')
  assert.equal(r('/reel/DbN6SsKum-9/').ref.p, 'ig')
})

/**
 * TWITCH CLIPS. Three shapes, and the depth-1 one is the only shape-gated post matcher in this
 * router — so its blast radius was measured rather than reasoned about.
 */
const TW = 'DeliciousDelightfulPicklesWOOP'

test('all three Twitch clip shapes mint ONE ref — the channel is decoration', () => {
  // The GraphQL surface resolves by slug alone, and clips.twitch.tv/{slug} carries no channel at all,
  // so putting it in the ref would make one clip mint two cache entries.
  for (const p of [`/${TW}`, `/clip/${TW}`, `/xqc/clip/${TW}`, `/tw/${TW}`, `/embed?clip=${TW}`]) {
    const got = r(p)
    assert.equal(got.kind, 'post', `${p} routes`)
    assert.deepEqual(got.ref, { p: 'tw', kind: 'clip', slug: TW }, `${p} -> one ref`)
  }
  // Only the channel-qualified form can mint the channel-qualified canonical; the others use the
  // clips.twitch.tv spelling, which resolves, rather than inventing a channel segment.
  assert.equal(r(`/xqc/clip/${TW}`).canonical, `https://www.twitch.tv/xqc/clip/${TW}`)
  assert.equal(r(`/clip/${TW}`).canonical, `https://clips.twitch.tv/${TW}`)
})

test('THE DEPTH-1 GATE SHADOWS NO REAL HANDLE — 697 measured slugs in, usernames out', () => {
  /**
   * The gate exists because clips.twitch.tv/{slug} — the SHARE BUTTON'S OWN OUTPUT — becomes a bare
   * /{segment} when the host is replaced, and a bare segment is also every profile url on every other
   * platform. Measured over 697 real slugs (ten channels, all-time): length 18..61, always leading
   * uppercase, at least four uppercase in the head, charset [A-Za-z0-9_-], never a dot.
   *
   * A TWITTER HANDLE IS IMPOSSIBLE (max 15 chars, and this requires 16). An Instagram handle is
   * merely implausible — Instagram lowercases usernames at signup, which would make this a proof, but
   * that could NOT be verified (instagram.com answers 200 for every username including invented ones)
   * so it is claimed as a likelihood and nothing more.
   */
  for (const slug of [TW, 'NimbleProductiveAsparagusHeyGuys-s77ZvN10Yr-O2sfo', 'IcyNiceQuailWow-VAlCDDY9uFf5oLAz']) {
    assert.equal(r(`/${slug}`).ref.p, 'tw', `${slug} is a clip`)
  }
  // Real handles are never claimed as clips. Asserted as "not Twitch" rather than "ambiguous",
  // because a bare ELEVEN-character segment is YouTube's by a pre-existing rule that predates this
  // platform ("YouTube already owns every exactly-11-char bare segment") — BarackObama, MrBeast6000
  // and JennaOrtega are all exactly 11, and were YouTube posts before Twitch existed here.
  for (const handle of ['shamu4life', 'fixture8.example', 'Cristiano', 'BarackObama', 'MrBeast6000',
    'zackrawrr', 'caseoh_', 'JennaOrtega', 'KimKardashianWest', 'reallylongbutlowercaseuser']) {
    assert.notEqual(r(`/${handle}`).ref?.p, 'tw', `${handle} is not a clip`)
  }
  // And the ones the gate is actually about keep the chooser they have always had.
  for (const handle of ['shamu4life', 'fixture8.example', 'Cristiano', 'zackrawrr', 'caseoh_',
    'KimKardashianWest', 'reallylongbutlowercaseuser']) {
    assert.equal(r(`/${handle}`).kind, 'ambiguous', `${handle} stays the chooser`)
  }
})

test('the Twitch arms REFUSE a token the ambiguity table has spoken for', () => {
  /**
   * Caught by a 200,073-path before/after sweep, not by reading: without `reserved()`,
   * /clip/followers, /clip/following and 56 paths under /settings/clip/… stopped being the chooser
   * and became Twitch posts. Consuming a token the table declares undecidable is the defect this
   * router already fixed once for /settings/{surface}/{code}.
   */
  assert.equal(r('/clip/followers').kind, 'ambiguous')
  assert.equal(r('/clip/following').kind, 'ambiguous')
  assert.equal(r(`/settings/clip/${TW}`).kind, 'ambiguous', '/settings/* is the x/bs/rd chooser')
  assert.deepEqual(r('/settings').candidates, ['x', 'bs', 'rd'], 'the table itself is unchanged')
})

test('the router NEVER mints a slug parseRefKey would refuse', () => {
  // refkey.ts is the boundary /_media/{key}/{i} crosses. A ref this router can mint but that function
  // cannot parse renders a card whose every media url 404s, silently.
  for (const p of [`/${TW}`, `/clip/${TW}`, `/xqc/clip/${TW}`, `/tw/${TW}`]) {
    const { ref } = r(p)
    assert.deepEqual(parseRefKey(refKey(ref)), ref, `${p} round-trips`)
  }
  // Too short for TWITCH_SLUG -> notfound, not a ref /_media/ would then reject.
  assert.equal(r('/clip/ab').kind, 'notfound')
  assert.equal(r('/xqc/clip/ab').kind, 'notfound')
  // A junk ?clip= mints nothing; /embed then falls through to the chooser it was already.
  assert.equal(r('/embed?clip=ab').kind, 'ambiguous')
})

test('/tw/ forcing accepts a slug the RECOGNISER refuses, and shadows nothing', () => {
  // The escape hatch exists so an older or shorter slug still resolves by hand. It is NOT a bypass of
  // the refkey shape — that still binds.
  assert.equal(r('/tw/shortlowercaseslug').ref.slug, 'shortlowercaseslug', 'forced skips the gate')
  assert.equal(r('/shortlowercaseslug').kind, 'ambiguous', 'unforced, the same segment is a chooser')
  // ESCAPE falls through when the forced matcher misses, so a real permalink under the token survives.
  assert.equal(r('/tw/status/20').ref.p, 'x', 'a tweet by @tw is still a tweet')
})

test('Twitch does not disturb its neighbours at the shapes they share', () => {
  // twitch() runs LAST in the unforced chain, so every deeper matcher has already spoken.
  assert.equal(r('/xqc/status/20').ref.p, 'x')
  assert.equal(r('/p/DbN6SsKum-9/').ref.p, 'ig')
  assert.equal(r('/@user/post/C1234').ref.p, 'th')
  assert.equal(r('/r/pics/comments/abc123').ref.p, 'rd')
  assert.equal(r('/watch?v=dQw4w9WgXcQ').ref.p, 'yt')
  // /embed/{id} at depth 2 is YouTube's; the Twitch arm is depth 1 plus a ?clip= param.
  assert.equal(r('/embed/dQw4w9WgXcQ').ref.p, 'yt')
  // A bare /embed with no ?clip= is UNCHANGED by this platform: it falls through to the chooser it
  // has always been. Pinned because the Twitch arm reads seg[0] === 'embed' and could have claimed it.
  assert.equal(r('/embed').kind, 'ambiguous', 'no clip param, no claim')
})

/* ===================== FACEBOOK'S ORDINARY POST PERMALINK ==========================
 *
 * REPORTED 2026-08-01. Trying to work around a failing share link, the owner pasted the
 * two shapes a human actually copies out of Facebook's address bar and got:
 *
 *   /story.php?story_fbid={post}&id={owner}     -> the AMBIGUOUS CHOOSER, offering
 *                                                  "x.com/story.php or instagram.com/story.php"
 *   /{ownerId}/posts/{pfbid…}                   -> "Not found"
 *
 * Neither was routed at all. The router knew Facebook's VIDEO shapes (watch, reel,
 * /{page}/videos, group posts) and no post shape whatsoever — so the permalink for an
 * ordinary post was the one link we could not read, which is the worst way round.
 *
 * Worse than a miss in the story.php case: offering a human two links that mean nothing,
 * for a url that is unambiguously Facebook's.
 */

const fbRef = r => (r.kind === 'post' ? r.ref : null)

test('FACEBOOK: /{owner}/posts/{id} routes, in both depths Facebook emits', () => {
  const numeric = route(new URL('https://megapenispoopenfarten.sex/100071151613394/posts/1092409469807430/'))
  assert.deepEqual(fbRef(numeric), { p: 'fb', kind: 'post', id: '100071151613394_1092409469807430' })

  // Facebook's OWN og:url spelling carries a human-readable slug in the middle. Same post, same ref.
  const slugged = route(new URL('https://megapenispoopenfarten.sex/Mavitivo/posts/some-slug/1092409469807430/'))
  assert.deepEqual(fbRef(slugged), { p: 'fb', kind: 'post', id: 'Mavitivo_1092409469807430' })

  // The modern opaque id, which is what the share menu hands out.
  const pfbid = route(new URL('https://megapenispoopenfarten.sex/100071151613394/posts/pfbid02CJXS9HmCajRTMH32saTDvbWirGiKTnbzJvKaw7Bvc7Vy6LH32Lc8jrjC5nryXP8fl/'))
  assert.equal(pfbid.kind, 'post')
  assert.equal(pfbid.ref.p, 'fb')
})

test('FACEBOOK: story.php and permalink.php route, and are NOT ambiguous', () => {
  /**
   * The ids live in the QUERY, which the segment matchers never see — the same reason /watch?v= is
   * handled beside them rather than in facebook()'s segment ladder.
   */
  for (const path of ['/story.php', '/permalink.php']) {
    const r = route(new URL(`https://megapenispoopenfarten.sex${path}?story_fbid=1092409469807430&id=100071151613394`))
    assert.equal(r.kind, 'post', `${path} must not be ambiguous`)
    assert.deepEqual(r.ref, { p: 'fb', kind: 'post', id: '100071151613394_1092409469807430' })
  }
})

test('ALL THREE SPELLINGS CONVERGE ON ONE REF — one post, one cache entry', () => {
  // The whole point of the composite id. Three urls Facebook itself emits for one post must not race
  // each other into three cache entries.
  const a = route(new URL('https://megapenispoopenfarten.sex/100071151613394/posts/1092409469807430/'))
  const b = route(new URL('https://megapenispoopenfarten.sex/story.php?story_fbid=1092409469807430&id=100071151613394'))
  const c = route(new URL('https://megapenispoopenfarten.sex/permalink.php?story_fbid=1092409469807430&id=100071151613394'))
  assert.equal(refKey(a.ref), refKey(b.ref))
  assert.equal(refKey(b.ref), refKey(c.ref))
  // And the ref survives the wire, which is what /_media/ and the spoof callback depend on.
  assert.deepEqual(parseRefKey(refKey(a.ref)), a.ref)
})

test('THE POST ARM SHADOWS NOTHING — the reservation it makes, pinned', () => {
  /**
   * It claims a WILDCARD first segment followed by the literal 'posts', which is exactly the kind of
   * claim that quietly steals another platform's links. Checked against the neighbours it could
   * plausibly reach: every one of these is SINGULAR 'post' or differently shaped.
   */
  assert.notEqual(route(new URL('https://megapenispoopenfarten.sex/profile/alice.bsky.social/post/3k2a')).ref?.p, 'fb')
  assert.notEqual(route(new URL('https://megapenispoopenfarten.sex/@dexerto/post/DbWxxQjFe4u')).ref?.p, 'fb')
  // A group post keeps its OWN ref kind rather than being swallowed by the new arm.
  const group = route(new URL('https://megapenispoopenfarten.sex/groups/328668786145521/posts/1391536379858751/'))
  assert.equal(group.ref.kind, 'group', 'groups is excluded at seg[0]')
  // An incomplete story.php is not guessed at: the PAIR names the post, one id does not.
  assert.notEqual(route(new URL('https://megapenispoopenfarten.sex/story.php?story_fbid=1092409469807430')).kind, 'post')
  assert.notEqual(route(new URL('https://megapenispoopenfarten.sex/story.php?id=100071151613394')).kind, 'post')
})

/* ===================== FACEBOOK'S PHOTO PERMALINK ==================================
 *
 * REPORTED 2026-08-11: /_api/v1 for a photo permalink answered
 * {"ok":false,"error":{"code":"notfound"}}. Facebook spells ONE picture six ways and the
 * router claimed none of them; two of the six reached the ambiguous chooser instead, which
 * offered "x.com/photo.php or instagram.com/photo.php" for a url that is unambiguously
 * Facebook's — the same defect /story.php had, ten days earlier.
 *
 * MEASURED FROM CLOUDFLARE EGRESS with `wrangler dev --remote`, 2026-08-11, because that is
 * the only client whose answer this code will ever see. The photo page itself is stripped
 * (837,611 bytes with no og: tag in it), and Meta's embed plugin returns the post: eleven
 * photo permalinks across four pages, all eleven rendering a card with a byline, the picture
 * and its real dimensions.
 */

const PHOTO_FBID = '1596906755391068'

test('FACEBOOK: all six photo spellings name ONE photo, by its fbid', () => {
  /**
   * The fbid is the WHOLE identity, unlike every other fb kind whose id is the {owner}_{post}
   * pair — because two of the six spellings carry no owner at all. Measured: handed to the embed
   * plugin, `/photo/?fbid={id}` with no owner and no `set` returns the same fragment as the fully
   * qualified spellings do.
   */
  const want = { p: 'fb', kind: 'photo', id: PHOTO_FBID }
  for (const path of [
    `/WYFF4/photos/${PHOTO_FBID}/`,
    `/WYFF4/photos/exclusive-sky-4-footage-shows-the-scene/${PHOTO_FBID}/`,
    `/WYFF4/photos/a.416661013162614/${PHOTO_FBID}/`,
    `/WYFF4/photos/pcb.1596906778724399/${PHOTO_FBID}/`,
    `/photo.php?fbid=${PHOTO_FBID}&set=pb.100044561550831.-2207520000&type=3`,
    `/photo/?fbid=${PHOTO_FBID}`,
  ]) {
    const r = route(new URL(`https://megapenispoopenfarten.sex${path}`))
    assert.equal(r.kind, 'post', `${path} must not be notfound or ambiguous`)
    assert.deepEqual(r.ref, want, path)
    // ONE cache entry for six urls, which is the reason the id is the fbid alone.
    assert.equal(refKey(r.ref), `fb:photo:${PHOTO_FBID}`, path)
  }
})

test('THE TRAILING NUMBER IS THE PHOTO, NOT THE POST — a post ref from it names nothing', () => {
  /**
   * Measured on the reported link: photo 1596906755391068 belongs to post 1596906778724399, and on
   * a second page photo 1632169048280519 belongs to post 1632169068280517. The two id spaces look
   * alike and are not the same number, so the tempting reading — "reuse kind:'post' with
   * {owner}_{trailing}" — builds a permalink Facebook has never heard of.
   */
  const r = route(new URL(`https://megapenispoopenfarten.sex/WYFF4/photos/${PHOTO_FBID}/`))
  assert.equal(r.ref.kind, 'photo', 'a photo is its own kind')
  assert.ok(!r.ref.id.includes('_'), 'no owner is folded in: two spellings do not carry one')
  assert.equal(r.canonical, `https://www.facebook.com/photo/?fbid=${PHOTO_FBID}`)
})

test('THE PHOTO ARM SHADOWS NOTHING — the reservation it makes, pinned', () => {
  /**
   * Measured by running the real route() over 36,521 paths — every token this router names, crossed
   * with sixteen id shapes at both depths — before and after the arm. 534 answers changed: 518
   * notfound -> post and 16 ambiguous -> post, every one of them a /photos/ path or a /photo query.
   * Nothing that already worked moved. These are the four claims that measurement rests on.
   */
  // 'photo' SINGULAR IS TIKTOK'S — a live TikTok photo post — and the plural is Facebook's.
  const tt = route(new URL('https://megapenispoopenfarten.sex/@someone/photo/7660566211100511518'))
  assert.equal(tt.ref.p, 'tt', 'the singular segment must stay TikTok’s')

  // /settings is ambiguous at EVERY depth, and FB_OWNER would otherwise swallow it — the same defect
  // the yt-dlp tier had when ST_ID ate 'followers'. reserved() is what refuses it.
  const settings = route(new URL(`https://megapenispoopenfarten.sex/settings/photos/${PHOTO_FBID}`))
  assert.equal(settings.kind, 'ambiguous', 'a token the ambiguity table speaks for is never consumed')

  // A group post keeps its own kind: 'groups' is excluded at seg[0], as in the post arm.
  const group = route(new URL('https://megapenispoopenfarten.sex/groups/328668786145521/posts/1391536379858751/'))
  assert.equal(group.ref.kind, 'group')

  // The chooser is taken away ONLY when fbid is present and numeric. @photo is a plausible handle:
  // /photo/status/{id} is a real Twitter permalink by @photo and /photo/p/{code} a real Instagram
  // one, and both are claimed at depth 3 by matchers this depth-1 arm never reaches.
  assert.equal(route(new URL('https://megapenispoopenfarten.sex/photo')).kind, 'ambiguous')
  assert.equal(route(new URL('https://megapenispoopenfarten.sex/photo.php')).kind, 'ambiguous')
  assert.equal(route(new URL('https://megapenispoopenfarten.sex/photo/?fbid=abc')).kind, 'ambiguous')
  assert.equal(route(new URL('https://megapenispoopenfarten.sex/photo/?set=a.123')).kind, 'ambiguous')
  assert.equal(route(new URL('https://megapenispoopenfarten.sex/photo/status/1234')).ref.p, 'x')
  assert.equal(route(new URL('https://megapenispoopenfarten.sex/photo/p/BsOGulcndj-')).ref.p, 'ig')

  // A non-numeric trailing segment is not a photo — the shape is the whole discriminator at depth 3.
  assert.equal(route(new URL('https://megapenispoopenfarten.sex/WYFF4/photos/album')).kind, 'notfound')
})

test("DISCORD'S SPOILER BARS DO NOT BREAK A LINK", () => {
  /**
   * REPORTED 2026-08-01: `||https://mbedfx.app/hepi01967211/status/2083545767893983385||` rendered
   * "Couldn't load this Twitter post" while the bare link worked. Reproduced against production —
   * appending `||` to the id fails, and so does the percent-encoded `%7C%7C`.
   *
   * Discord's link detector does not treat `|` as a URL terminator, so the pipes ride along into the
   * path and the id we send upstream becomes `2083545767893983385||`.
   *
   * Stripping is safe unconditionally: `|` is not legal unencoded in a path, no platform's id or
   * handle contains one, and neither can a fediverse host.
   */
  const ID = '2083545767893983385'
  const want = route(new URL(`https://mbedfx.app/hepi01967211/status/${ID}`))
  assert.equal(want.kind, 'post')

  for (const p of [
    `/hepi01967211/status/${ID}||`,
    `/hepi01967211/status/${ID}%7C%7C`,
    `/%7C%7Chepi01967211/status/${ID}%7C%7C`,
    `/||hepi01967211/status/${ID}||`,
  ]) {
    const got = route(new URL(`https://mbedfx.app${p}`))
    assert.deepEqual(got.ref, want.ref, `${p} must reach the same post`)
  }

  /**
   * STRIPPING IS TRANSPARENT, NOT A RESCUE: a path with the bars must route exactly as the same
   * path without them, whatever that outcome is.
   *
   * Asserted as an equivalence rather than as "junk is refused", because junk is NOT refused here
   * and never was — /{handle}/status/abc already mints an x ref with id 'abc'. Writing the stricter
   * assertion would have pinned a behaviour this router does not have, and the test would have been
   * describing an imagined validator rather than the real one.
   */
  for (const junk of ['abc', '', '0', 'x'.repeat(40)]) {
    const bare = route(new URL(`https://mbedfx.app/hepi01967211/status/${junk}`))
    const barred = route(new URL(`https://mbedfx.app/hepi01967211/status/${junk}||`))
    assert.deepEqual(barred, bare, `bars must not change the outcome for ${JSON.stringify(junk)}`)
  }
})
