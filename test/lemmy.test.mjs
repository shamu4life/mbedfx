import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { refKey, parseRefKey } from '../src/refkey.ts'
import { fetchableInstance } from '../src/platforms/lemmy/fetch.ts'
import {
  actorInstance, communityHandle, lemmyGone, lemmyMedia, normalizeLemmy,
} from '../src/platforms/lemmy/normalize.ts'
import { decodeStatusId, encodeStatusId } from '../src/statusid.ts'

/**
 * LEMMY — the first fediverse platform here, and the only one whose ref carries a HOSTNAME.
 *
 * THE PROBLEM THIS SOLVES, measured 2026-07-27. Every other platform in this project is ONE site, so
 * replacing the host is lossless. The fediverse is not one site: a Lemmy post id is local to the
 * instance serving it, and the same post is sopuli.xyz/post/49387259 AND
 * lemmy.dbzer0.com/post/72978307. Ids are per-instance DENSE, so resolving a bare /post/{id} against
 * some default instance does not usually 404 — it returns a REAL BUT COMPLETELY DIFFERENT POST. Ten
 * of fifty lookups in the shared dense range; two of twelve current lemmy.world ids against
 * lemmy.dbzer0.com. ROUGHLY ONE IN FIVE, silently, which is the worst failure mode this project
 * recognises.
 *
 * So the instance lives in the URL and there is no default. That is the one ergonomic cost, and it is
 * smaller than it looks: inserting our domain lands the cursor at a FIXED offset (right after
 * `https://`) where host replacement requires selecting a variable-length token.
 *
 * WHY NOT AN ALLOWLIST, which was the obvious answer. Precedent argues against it: FixTweetBot
 * hardcodes exactly ten Mastodon instances and the fixer those ten point at is now DEAD (connection
 * refused on 443). A curated list rots, and it truncates a genuinely long tail — 481 instances in the
 * public census. The guard is syntactic + behavioural instead: the host must LOOK like a public
 * domain, and the response must BE a Lemmy document.
 */
const F = new URL('./fixtures/', import.meta.url)
const load = n => JSON.parse(readFileSync(new URL(n, F), 'utf8'))

// The same post read from a MIRROR (sopuli.xyz) — created on lemmy.dbzer0.com, posted to a community
// that lives on a THIRD instance (lemmy.world). Three instances in one payload, none of them wrong.
const FED = load('lemmy-post-federated.json').post_view
const LOCAL = load('lemmy-post-local.json').post_view
const MISSING = load('lemmy-post-missing.json')

const REF = { p: 'lm', host: 'sopuli.xyz', kind: 'post', id: '49387259' }
const r = p => route(new URL(`https://staging.megapenispoopenfarten.sex${p}`))

test('THE MISS SHAPE IS A TYPED ERROR, not an empty view', () => {
  assert.deepEqual(MISSING, { error: 'couldnt_find_post' })
  assert.equal(MISSING.post_view, undefined, 'no view at all — so the liveness assertion is a view')
})

test('A FEDERATED POST NAMES ALL THREE INSTANCES CORRECTLY', () => {
  /**
   * The heart of this platform. Read from sopuli.xyz, this post was written by an account on
   * lemmy.dbzer0.com, in a community hosted on lemmy.world. Deriving either identity from `ref.host`
   * — the obvious shortcut — mislabels BOTH, and the mislabel is invisible because it still looks
   * like a plausible handle.
   */
  const post = normalizeLemmy(FED, REF)
  assert.equal(post.author.handle, 'technocrit@lemmy.dbzer0.com', 'the AUTHOR is not on the instance we asked')
  assert.match(post.text, /^!news@lemmy\.world/, 'and the COMMUNITY is on a third instance again')
  assert.equal(post.ref.host, 'sopuli.xyz', 'while the ref stays the instance the user pasted')
  assert.match(post.title, /Man Accused of Horrific Crimes/)
})

test('THE HANDLE IS ALWAYS FULLY QUALIFIED — a bare local name is not an identity', () => {
  // Two different people can hold the same local name on two instances, so `@technocrit` names
  // nobody on the fediverse. Both the federated and the local case carry the instance.
  assert.equal(normalizeLemmy(FED, REF).author.handle, 'technocrit@lemmy.dbzer0.com')
  assert.equal(
    normalizeLemmy(LOCAL, { p: 'lm', host: 'lemmy.world', kind: 'post', id: '49966212' }).author.handle,
    'snooptodd@lemmy.world',
  )
})

test('THE COMMUNITY LEADS THE BODY, and it is the SAFETY signal', () => {
  /**
   * Not decoration. The central hazard here is a post read from the wrong instance, and
   * `!community@instance` is the field that makes such a mistake visible at a glance — a card reading
   * `!news@lemmy.world` when the reader expected `!memes@sopuli.xyz` is self-evidently wrong, where a
   * bare "News" would not be.
   */
  assert.equal(communityHandle(FED.community), '!news@lemmy.world')
  assert.equal(communityHandle({ name: 'x' }), '!x', 'no actor_id -> no instance, not a fabricated one')
  assert.equal(communityHandle({ actor_id: 'https://a.test/c/x' }), '', 'no name -> nothing at all')
  assert.equal(communityHandle(null), '')
  assert.equal(actorInstance('not a url'), '', 'total over junk')
})

test('BOTH URL SPELLINGS MINT ONE REF, and the host case-folds to ONE cache entry', () => {
  const want = { p: 'lm', host: 'sopuli.xyz', kind: 'post', id: '49387259' }
  for (const p of [
    '/sopuli.xyz/post/49387259',           // insert our domain — fixed cursor offset
    '/https://sopuli.xyz/post/49387259',   // prepend it — one Home keypress (FixBluesky ships this)
    '/http://sopuli.xyz/post/49387259',    // accepted as an input SPELLING; the ref carries no scheme
    '/SOPULI.xyz/post/49387259',           // hostnames are case-insensitive
    '/lm/sopuli.xyz/post/49387259',        // the uniform escape hatch
  ]) {
    assert.deepEqual(r(p).ref, want, `${p} -> one ref`)
  }
  // …and therefore ONE cache key, which is the point of folding case at the router.
  assert.equal(refKey(r('/SOPULI.xyz/post/49387259').ref), 'lm:sopuli.xyz:post:49387259')
})

test('THERE IS NO DEFAULT-INSTANCE ARM, and there must never be one', () => {
  // /post/{id} with an assumed host is the shape that returns a real-but-different post ~20% of the
  // time. It stays unrouted; a Lemmy link without its instance is not a link we can answer.
  assert.equal(r('/post/49387259').kind, 'notfound')
  assert.equal(r('/comment/123').kind, 'notfound')
})

test('A PRIVATE OR LOOPBACK HOST NEVER EVEN ROUTES — the syntactic half of the SSRF guard', () => {
  /**
   * FEDI_HOST requires at least two labels AND an alphabetic final label, which excludes every IP
   * literal in one stroke: v4 forms end in digits, and every v6 form (including the `::ffff:`-mapped
   * and NAT64 spellings that defeat naive prefix-based guards) is bracketed or full of colons.
   * `localhost` is one label. A port or userinfo cannot appear because those characters are not in
   * the class.
   *
   * This matters more here than anywhere else in the router: `host` is the only ref field in this
   * codebase that becomes the ORIGIN of a request rather than a path component of a fixed one.
   */
  for (const h of [
    '127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    'localhost', 'metadata', '[::1]', '[::ffff:127.0.0.1]', '[64:ff9b::7f00:1]',
    'lemmy.world:8080', 'user@lemmy.world', 'lemmy.world.', '-lemmy.world', 'lemmy..world',
  ]) {
    assert.notEqual(r(`/${h}/post/1`).kind, 'post', `${h} must not route`)
    assert.equal(fetchableInstance(h), false, `${h} must not be fetchable`)
  }
})

test('OUR OWN ZONE IS REFUSED — a Worker fetching itself bypasses its own WAF', () => {
  // Cloudflare's default subrequest behaviour re-enters through the edge without the zone's WAF, so
  // the one host that must never be reachable is the one an attacker would most like to aim at.
  for (const h of ['megapenispoopenfarten.sex', 'staging.megapenispoopenfarten.sex', 'x.workers.dev']) {
    assert.equal(fetchableInstance(h), false, `${h} is ours`)
  }
  assert.equal(fetchableInstance('lemmy.world', 'https://staging.megapenispoopenfarten.sex'), true)
  assert.equal(fetchableInstance('example.test', 'https://example.test'), false, 'the passed origin counts too')
  assert.equal(fetchableInstance('lemmy.world', 'not a url'), true, 'a junk origin is no extra information')
})

test('REAL INSTANCES ARE FETCHABLE — the guard must not be so tight it blocks the platform', () => {
  for (const h of ['lemmy.world', 'sopuli.xyz', 'sh.itjust.works', 'lemmy.dbzer0.com',
    'discuss.tchncs.de', 'programming.dev', 'beehaw.org', 'piefed.social', 'lemmy.ca',
    'a.co', 'sub.domain.example.museum']) {
    assert.equal(fetchableInstance(h), true, `${h} is a plausible instance`)
    assert.equal(r(`/${h}/post/1`).kind, 'post', `${h} routes`)
  }
})

test('THE ID IS A CANONICAL INTEGER — /post/007 must not be a second cache entry', () => {
  assert.equal(r('/lemmy.world/post/007').kind, 'notfound', 'leading zeros are not a Lemmy id')
  assert.equal(r('/lemmy.world/post/0').kind, 'notfound')
  assert.equal(r('/lemmy.world/post/abc').kind, 'notfound')
  assert.equal(r('/lemmy.world/post/-1').kind, 'notfound')
  assert.equal(r('/lemmy.world/post/9999999999999').kind, 'notfound', 'bounded well above any real id')
  assert.equal(r('/lemmy.world/post/49966212').ref.id, '49966212')
})

test('THE REF ROUND-TRIPS, and parseRefKey RE-VALIDATES the host', () => {
  /**
   * refkey.ts, not the router, is the boundary a `/_media/{key}/{i}` segment crosses — and for this
   * platform the ref it mints decides WHO THE WORKER TALKS TO. So the host shape is enforced again
   * there, and a key naming a private address must produce null even though no router arm mints one.
   */
  const key = refKey(REF)
  assert.equal(key, 'lm:sopuli.xyz:post:49387259')
  assert.deepEqual(parseRefKey(key), REF)
  for (const bad of [
    'lm:127.0.0.1:post:1', 'lm:localhost:post:1', 'lm:%5B%3A%3A1%5D:post:1',
    'lm:lemmy.world:post:0', 'lm:lemmy.world:post:abc', 'lm:lemmy.world:profile:1',
    'lm:lemmy.world:post', 'lm::post:1', 'lm:lemmy.world::1', 'lm',
  ]) {
    assert.equal(parseRefKey(bad), null, `${bad} must not parse`)
  }
})

test('THE SPOOF ID ROUND-TRIPS — the activity route carries this ref too', () => {
  // The Mastodon-spoof callbacks encode the whole refKey into a numeric {id}. A host with dots must
  // survive that, or Discord's callback 404s on every Lemmy card that has media.
  const key = refKey(REF)
  assert.equal(decodeStatusId(encodeStatusId(key)), key)
})

test('image_details IS ON THE VIEW, NOT THE POST — reading it off the post costs every dimension', () => {
  // Measured on the same post: lemmy.dbzer0.com sends {link, width, height, content_type} and
  // sopuli.xyz sends nothing. So it is an enrichment, and its ABSENCE must still yield a picture.
  const sized = lemmyMedia({ post: { thumbnail_url: 'https://a.test/t.jpg' },
    image_details: { link: 'https://a.test/i.webp', width: 512, height: 341 } })
  assert.deepEqual(sized, [{ kind: 'image', url: 'https://a.test/i.webp', w: 512, h: 341 }])
  // Absent -> the thumbnail, at 0x0 ("we do not know, let the client size it" — the same choice
  // reddit, youtube and dimensionless Bluesky entries already make).
  const unsized = lemmyMedia(FED)
  assert.equal(unsized.length, 1)
  assert.equal(unsized[0].w, 0)
  assert.match(unsized[0].url, /^https:\/\//)
})

test('A LINK POST\'S TARGET IS NOT A PICTURE unless it looks like one', () => {
  // Putting an ARTICLE url in Media.url would advertise a picture that is really an HTML page.
  assert.deepEqual(lemmyMedia({ post: { url: 'https://news.test/story' } }), [])
  assert.equal(lemmyMedia({ post: { url: 'https://news.test/a.jpg' } })[0].url, 'https://news.test/a.jpg')
  assert.deepEqual(lemmyMedia({ post: { url: 'http://news.test/a.jpg' } }), [], 'https only')
  assert.deepEqual(lemmyMedia({}), [], 'total over a viewless input')
  assert.deepEqual(lemmyMedia({ post: {} }), [])
})

test('A REMOVED OR DELETED POST IS A WALL, NOT AN EMPTY CARD', () => {
  // Lemmy still returns a post_view for both, with the body blanked — rendering it would produce an
  // empty card that reads as OUR bug rather than as a moderator's decision.
  assert.equal(lemmyGone({ removed: true }), true)
  assert.equal(lemmyGone({ deleted: true }), true)
  assert.equal(lemmyGone({ removed: false, deleted: false }), false)
  assert.equal(normalizeLemmy({ ...FED, post: { ...FED.post, removed: true } }, REF), null)
  assert.equal(normalizeLemmy({ ...FED, post: { ...FED.post, deleted: true } }, REF), null)
})

test('normalizeLemmy is TOTAL over a payload with holes', () => {
  assert.equal(normalizeLemmy({}, REF), null, 'no post, no card')
  const bare = normalizeLemmy({ post: { id: 1, name: 'x' } }, REF)
  assert.equal(bare.author.name, 'unknown', 'rather than an empty byline')
  assert.equal(bare.author.handle, '')
  assert.equal(bare.media.length, 0)
  assert.equal(bare.text, '', 'no community and no body is empty, not "!undefined"')
  assert.equal(bare.counts.likes, undefined)
  // createdAt is a required Date and render/mastodon.ts calls toISOString() on it — an Invalid Date
  // there is a 500 on the activity route.
  assert.doesNotThrow(() => bare.createdAt.toISOString())
  assert.equal(bare.canonical, 'https://sopuli.xyz/post/49387259', 'built from the REF, not the payload')
})

test('THE CANONICAL IS THE PASTED INSTANCE, deliberately — not the origin', () => {
  /**
   * `post.ap_id` is the canonical origin and is tempting for that reason. But `canonical` is where a
   * HUMAN is 302'd, and sending someone to an instance they did not paste loses their session, their
   * subscriptions and their vote state. The mirror renders the same post fine, and the origin is not
   * hidden — it is right there in the byline and the community handle.
   */
  assert.equal(FED.post.ap_id, 'https://lemmy.dbzer0.com/post/72978307', 'the payload really is federated')
  assert.equal(normalizeLemmy(FED, REF).canonical, 'https://sopuli.xyz/post/49387259')
})

test('NSFW and the counts come through', () => {
  const post = normalizeLemmy(FED, REF)
  assert.equal(post.sensitive, false)
  assert.equal(typeof post.counts.likes, 'number')
  assert.equal(typeof post.counts.replies, 'number')
  assert.equal(normalizeLemmy({ ...FED, post: { ...FED.post, nsfw: true } }, REF).sensitive, true)
})

test('Lemmy disturbs no neighbour — the depth-3 shape it shares with Threads and Instagram', () => {
  // Threads' /{user}/post/{code} needs a leading '@' AND a base64-ish code; Instagram's depth-3 arm
  // needs p/reel/reels/tv at seg[1]. Lemmy needs a DOTTED host and a bare integer. Disjoint on both.
  assert.equal(r('/@user/post/C1234abc').ref.p, 'th')
  assert.equal(r('/someuser/p/DbN6SsKum-9').ref.p, 'ig')
  assert.equal(r('/xqc/status/20').ref.p, 'x')
  assert.equal(r('/r/pics/comments/abc123').ref.p, 'rd')
  // A dotted handle with a NUMERIC id is the one genuinely new claim, and it was notfound before.
  assert.equal(r('/fixture8.example/post/123').ref.p, 'lm')
  assert.equal(r('/fixture8.example/post/abc').kind, 'notfound', 'a non-numeric id is nobody\'s')
})
