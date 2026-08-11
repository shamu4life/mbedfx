import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { route } from '../src/router.ts'

test('refKey is deterministic and platform-prefixed', () => {
  assert.equal(refKey({ p: 'x', id: '123' }), 'x:123')
  assert.equal(refKey({ p: 'tt', id: '7660566211100511518' }), 'tt:7660566211100511518')
  assert.equal(refKey({ p: 'ig', kind: 'p', code: 'BsOGulcndj-' }), 'ig:p:BsOGulcndj-')
  assert.equal(refKey({ p: 'th', code: 'DTI1vjIEi5y' }), 'th:DTI1vjIEi5y')
  assert.equal(refKey({ p: 'rd', sub: 'aww', id: 'abc123' }), 'rd:aww:abc123')
  assert.equal(refKey({ p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }), 'bs:alice.bsky.social:3k2a')
})

test('DID handles round-trip — DIDs contain colons, which is the delimiter', () => {
  // Verified live: at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6oveex3ii2l' }
  const key = refKey(ref)
  assert.ok(!key.includes('did:plc:'), 'raw colons would make parseRefKey ambiguous')
  assert.deepEqual(parseRefKey(key), ref)
})

test('refKey is path-safe — it is interpolated into /_media/{refKey}/{i}', () => {
  const ref = { p: 'bs', handle: 'weird/handle with spaces', rkey: 'a?b#c' }
  const key = refKey(ref)
  assert.ok(!/[/?#\s]/.test(key), `must not contain path-breaking chars: ${key}`)
  assert.deepEqual(parseRefKey(key), ref)
})

test('parseRefKey round-trips every ref shape', () => {
  const refs = [
    { p: 'x', id: '123' },
    { p: 'tt', id: '7660566211100511518' },
    { p: 'ig', kind: 'p', code: 'BsOGulcndj-' },
    { p: 'ig', kind: 'story', user: 'someuser', id: '987' },
    { p: 'th', code: 'DTI1vjIEi5y' },
    { p: 'rd', sub: 'aww', id: 'abc123' },
    { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' },
  ]
  for (const r of refs) assert.deepEqual(parseRefKey(refKey(r)), r)
})

test('parseRefKey rejects junk rather than guessing', () => {
  for (const junk of ['', 'nope', 'zz:123', 'x', 'x:', 'bs:onlyhandle', 'ig:badkind:x', 'x:1:2']) {
    assert.equal(parseRefKey(junk), null, `${junk} must not parse`)
  }
})

test('parseRefKey returns null (never throws) on malformed percent-encoding', () => {
  // The router passes the RAW, undecoded URL path segment straight to parseRefKey,
  // so attacker-influenced bytes reach it directly. decodeURIComponent throws
  // URIError on malformed escapes — that must be caught and turned into a null
  // (→ 404), never allowed to propagate (→ 500).
  for (const bad of [
    'x:100%', // valid tag, malformed escape (lone '%')
    'bs:did%3Aplc%3Aabc:%ZZ', // valid tag, valid first component, malformed second
    'ig:p:%E0%A4%A', // truncated multi-byte escape
  ]) {
    assert.doesNotThrow(() => parseRefKey(bad), `${bad} must not throw`)
    assert.equal(parseRefKey(bad), null, `${bad} must not parse`)
  }
})

test('refKey ignores fields that are not identity', () => {
  // Two refs for the same post must key identically regardless of how they were
  // built. (Asserting refKey(X) === refKey(X) on identical literals would only
  // test that === is reflexive.)
  const a = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }
  const b = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a', extra: 'ignored' }
  assert.equal(refKey(a), refKey(b))
})

test('different posts never collide, even when components concatenate alike', () => {
  // Without per-component encoding, {sub:'a:b', id:'c'} and {sub:'a', id:'b:c'}
  // would both flatten to 'rd:a:b:c'.
  assert.notEqual(
    refKey({ p: 'rd', sub: 'a:b', id: 'c' }),
    refKey({ p: 'rd', sub: 'a', id: 'b:c' }),
  )
  assert.deepEqual(parseRefKey(refKey({ p: 'rd', sub: 'a:b', id: 'c' })), { p: 'rd', sub: 'a:b', id: 'c' })
  assert.deepEqual(parseRefKey(refKey({ p: 'rd', sub: 'a', id: 'b:c' })), { p: 'rd', sub: 'a', id: 'b:c' })
})

test('the yt-dlp tier round-trips — one opaque id apiece, like yt', () => {
  // BOTH DIRECTIONS OR THE ROUTE IS DEAD: parseRefKey's `default: return null` turns a missing arm
  // into a silent 404 on /_media/{refKey}/{i}, i.e. a card whose poster and video url resolve to
  // nothing with no error anywhere.
  assert.equal(refKey({ p: 'dm', id: 'xaqwy7q' }), 'dm:xaqwy7q')
  assert.equal(refKey({ p: 'st', id: 'moo' }), 'st:moo')
  // Imgur LEFT this tier when albums shipped and carries a `kind`, so its key gained a component.
  // That invalidates cached im: entries by design — isValidRef re-parses, an old key fails, the
  // post refetches. Asserted here so the shape change is a deliberate line rather than a surprise.
  assert.equal(refKey({ p: 'im', kind: 'post', id: 'A61SaA1' }), 'im:post:A61SaA1')
  assert.equal(refKey({ p: 'im', kind: 'album', id: 'iX265HX' }), 'im:album:iX265HX')
  assert.equal(refKey({ p: 'im', kind: 'gallery', id: 'YcAQlkx' }), 'im:gallery:YcAQlkx')
  assert.equal(parseRefKey('im:A61SaA1'), null, 'the OLD key shape must no longer parse')
  for (const ref of [{ p: 'dm', id: 'xaqwy7q' }, { p: 'st', id: 'moo' },
                     { p: 'im', kind: 'post', id: 'A61SaA1' }, { p: 'im', kind: 'album', id: 'iX265HX' }]) {
    assert.deepEqual(parseRefKey(refKey(ref)), ref)
  }
  // Ids needing percent-encoding survive the /_media/ interpolation both ways. Asserted on a THREADS
  // code, not a dm id: this is a claim about refKey's encode/decode symmetry, and the yt-dlp arms now
  // refuse a shape like this outright (see the hostile-id test below) — which would make a dm ref prove
  // the wrong thing here.
  const odd = { p: 'th', code: 'a/b?c#d e' }
  assert.ok(!/[/?#\s]/.test(refKey(odd)), `must stay path-safe: ${refKey(odd)}`)
  assert.deepEqual(parseRefKey(refKey(odd)), odd)
  // Malformed keys are null, never a guess.
  for (const bad of ['dm', 'dm:', 'st:a:b', 'im:a:b:c', 'ng:x']) {
    assert.equal(parseRefKey(bad), null, `${bad} names no post`)
  }
})

test('A HOSTILE yt-dlp-tier ID NEVER SURVIVES parseRefKey — the container is downstream of this', () => {
  /**
   * THIS FUNCTION IS THE BOUNDARY, NOT THE ROUTER. A refKey reaches parseRefKey from two places the
   * router's regexes never see — the `/_media/{key}/{i}` segment and the Mastodon-spoof {id}
   * (decodeStatusId -> parseRefKey) — and worker.ts turns a dm/st/im ref straight into a page url the
   * CONTAINER fetches (`ytdlpPageUrl`). Before the shape check these arms accepted ANY non-empty id,
   * so an attacker chose the page yt-dlp was pointed at, via a public url, with no fetch in between.
   *
   * The refusal is asserted through the ROUND TRIP because that is what the rest of the system
   * depends on: cache.ts::isValidRef revalidates a cached record by refKey -> parseRefKey -> compare,
   * so "parseRefKey returns null" is also "this ref can never come back out of the post cache".
   */
  const hostile = [
    '../../admin', '..%2f..%2fadmin', 'a/b?c#d e', 'http://evil.example/x', 'moo/../../x',
    'a\x00b', 'a\nb', 'a b', 'A61SaA1.gifv', 'x'.repeat(4096), '%2e%2e%2f', 'moo?a=1', '',
  ]
  for (const p of ['dm', 'st', 'im']) {
    for (const id of hostile) {
      assert.equal(parseRefKey(`${p}:${encodeURIComponent(id)}`), null, `${p}:${id} must not name a post`)
      // The raw, un-encoded spelling too — /_media/ tolerates a literal key with no percent-escapes.
      assert.equal(parseRefKey(`${p}:${id}`), null, `${p}:${id} (raw) must not name a post`)
    }
  }
  // And the real shapes still pass, or the refusal has eaten the platform it was protecting.
  assert.deepEqual(parseRefKey('dm:xaqwy7q'), { p: 'dm', id: 'xaqwy7q' })
  assert.deepEqual(parseRefKey('st:moo'), { p: 'st', id: 'moo' })
  assert.deepEqual(parseRefKey('im:post:A61SaA1'), { p: 'im', kind: 'post', id: 'A61SaA1' })
  assert.deepEqual(parseRefKey('im:album:iX265HX'), { p: 'im', kind: 'album', id: 'iX265HX' })
  // An unknown kind is refused rather than defaulted: the kind picks the API ENDPOINT, so a
  // silently-defaulted one would query the wrong surface for an attacker-chosen id.
  assert.equal(parseRefKey('im:playlist:A61SaA1'), null)
  assert.equal(parseRefKey('im:post:not-an-id'), null, 'the shape check still applies')
})

test('THE ROUTER AND parseRefKey APPLY THE SAME SHAPE — one regex, imported, not two copies', () => {
  /**
   * The round trip is load-bearing in BOTH directions: an id the router mints and parseRefKey refuses
   * deserializes as null on every post-cache read (every request re-extracting, silently), and an id
   * parseRefKey accepts that the router would never mint is a page the container fetches for free.
   * Asserted behaviourally over the router's own output rather than by comparing regex sources.
   */
  const ids = [['/video/xaqwy7q', 'dm'], ['/e/moo', 'st'], ['/A61SaA1.gifv', 'im'], ['/dm/xaqwy7q', 'dm'],
    ['/st/e/moo', 'st'], ['/im/A61SaA1', 'im'], ['/a/iX265HX', 'im'], ['/im/gallery/YcAQlkx', 'im']]
  for (const [path, p] of ids) {
    const got = route(new URL(`https://h${path}`))
    assert.equal(got.kind, 'post', path)
    assert.equal(got.ref.p, p, path)
    assert.deepEqual(parseRefKey(refKey(got.ref)), got.ref, `${path} must survive its own cache key`)
  }
})

test('EVERY FACEBOOK REF KIND SURVIVES THE WIRE — the assertion "group" never had', () => {
  /**
   * FOUND 2026-08-01, and it had been live since the group feature shipped: parseRefKey's fb allowlist
   * was watch|reel|share, so refKey wrote `fb:group:{gid}_{pid}` and this refused to read it back.
   * Consequence — every /_media/{refKey}/{i} on a Facebook GROUP post 404s and its Mastodon spoof
   * callback is unroutable. Silent, because nothing asserted the round trip for that kind.
   *
   * Written as a sweep over EVERY kind rather than one case per kind, so the next kind added to the
   * PostRef union fails here until it is allowlisted deliberately — this function is the security
   * boundary, and its list must stay a decision rather than an oversight.
   */
  for (const kind of ['watch', 'reel', 'share', 'group', 'post', 'photo']) {
    const ref = { p: 'fb', kind, id: '328668786145521_1391536379858751' }
    assert.deepEqual(parseRefKey(refKey(ref)), ref, `fb:${kind} must round-trip`)
  }
  // And an unknown kind is still REFUSED — the allowlist is not merely decorative.
  assert.equal(parseRefKey('fb:nonsense:123'), null)
  /**
   * THE ROUND TRIP THE ROUTER ACTUALLY MINTS for the kind added 2026-08-11, driven through route()
   * rather than a hand-built ref: a photo card is ALL images, so every picture on it is served from
   * /_media/{refKey}/{i}, and a kind missing from the allowlist above would 404 every one of them
   * while the card itself still rendered — exactly the shape the `group` omission had.
   */
  const photo = route(new URL('https://www.facebook.com/WYFF4/photos/1596906755391068/'))
  assert.equal(photo.kind, 'post')
  assert.equal(refKey(photo.ref), 'fb:photo:1596906755391068')
  assert.deepEqual(parseRefKey(refKey(photo.ref)), photo.ref, 'a routed photo must survive its own cache key')
})
