import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fromSyndication, syndicationHasTweet } from '../src/platforms/twitter/normalize.ts'
import { serializePost, deserializePost } from '../src/cache.ts'  // for the quote/reply cache round-trip

const json = f => JSON.parse(readFileSync(`test/fixtures/twitter-${f}.json`, 'utf8'))
const TEXT = json('text'), PHOTO = json('photo'), MULTI = json('multiphoto')
const VIDEO = json('video'), GIF = json('gif'), TOMB = json('tombstone')
const QUOTE = json('quote'), REPLY = json('reply')

// Filled from Step 1's capture: the real tweet id behind each fixture.
const REF = id => ({ p: 'x', id })
const TEXT_REF = REF('20')                    // jack — "just setting up my twttr"
const PHOTO_REF = REF('440322224407314432')   // TheEllenShow — one photo
const MULTI_REF = REF('1376712834269159425')  // BTS_twt — two photos
const VIDEO_REF = REF('1491475671058681863')  // NASA — a video
const GIF_REF = REF('1479837621337657345')    // Astropartigirl — an animated_gif (mp4, no audio)
const QUOTE_REF = REF('1823076043017630114')  // elonmusk quoting ThierryBreton (quoted tweet has a photo)
const REPLY_REF = REF('1816211874012098692')  // elonmusk replying to StephenKing

test('a text tweet normalizes into a well-formed Post', () => {
  const post = fromSyndication(TEXT, TEXT_REF)
  assert.ok(post)
  assert.deepEqual(post.ref, TEXT_REF)
  assert.ok(post.author.handle.length > 0)
  assert.match(post.author.url, /^https:\/\/x\.com\//, 'author url is on x.com — the CODE stays x')
  assert.ok(post.createdAt instanceof Date && !Number.isNaN(post.createdAt.getTime()))
  assert.ok(post.createdAt.getUTCFullYear() > 2005, `created_at must parse; got ${post.createdAt.toISOString()}`)
  assert.equal(typeof post.text, 'string')
  assert.ok(post.text.length > 0)
  assert.equal(post.media.length, 0)
  assert.equal(post.sensitive, false)
  assert.match(post.canonical, /^https:\/\/x\.com\/[^/]+\/status\/20$/)
})

test('Post.text is HTML-entity-DECODED — syndication delivers &amp;/&lt;/&gt; pre-encoded', () => {
  // REGRESSION: Twitter's syndication `text` field HTML-encodes &, <, > (and ONLY those three —
  // it leaves " and ' literal). The video fixture carries the literal 5-char sequence "&amp;"
  // (real captured bytes: "...plains &amp; plateaus..."). The shared renderer's contract requires
  // ALREADY-decoded text and escapes ONCE at its boundary (render/text.ts esc()), so if the
  // normalizer leaves the entity in place, esc() produces "&amp;amp;" on the wire and the client
  // decodes one level, showing the user a literal "&amp;". Measured double-encode before the fix:
  //   Post.text = "plains &amp; plateaus"  ->  esc(buildPlainText) = "plains &amp;amp; plateaus".
  // This is the exact hazard instagram/normalize.ts already decodes for (TikTok/Bluesky don't,
  // because their JSON text is not entity-encoded — Twitter syndication's is). The plan is silent
  // on it. This test pins that build() decodes, so the renderer's single esc() is correct.
  const post = fromSyndication(VIDEO, VIDEO_REF)
  assert.ok(post.text.includes('plains & plateaus'), `expected decoded '&'; got: ${post.text}`)
  assert.ok(!/&amp;/.test(post.text), `no HTML entity may survive into Post.text; got: ${post.text}`)
})

test('entity decode covers &lt;/&gt; and unescapes &amp; LAST (the ordering hazard)', () => {
  // Synthetic, because no fixture guarantees < / > in its text. Two things pinned:
  //  1) all three of Twitter's entities decode: "R&amp;D <b>&lt;tag&gt;</b>" -> "R&D <b><tag></b>".
  //  2) &amp; is unescaped LAST. A user who literally typed "&lt;" has it delivered as "&amp;lt;"
  //     (Twitter escapes the leading &). Decoding &amp; first would corrupt that to "<"; decoding
  //     &lt;/&gt; first then &amp; recovers the literal "&lt;" the user actually typed. This is the
  //     same amp-LAST ordering instagram/normalize.ts's unentity() documents.
  const base = { __typename: 'Tweet', id_str: 'X', created_at: '2020-01-01T00:00:00.000Z',
    user: { screen_name: 'u', name: 'U' } }
  const p = fromSyndication({ ...base, text: 'R&amp;D <b>&lt;tag&gt;</b>' }, REF('X'))
  assert.equal(p.text, 'R&D <b><tag></b>', 'all three entities decode')
  const q = fromSyndication({ ...base, text: 'user typed &amp;lt; here' }, REF('X'))
  assert.equal(q.text, 'user typed &lt; here', '&amp; must unescape LAST or &amp;lt; corrupts to <')
})

test('the quoted body is decoded too — same shared build() path as the root', () => {
  // build() is shared by the root post and the depth-1 quoted tweet, so the decode must reach the
  // quote body as well (a quoted tweet with "&amp;" would otherwise double-encode identically).
  // The real quote fixture's quoted text happens to carry no entity, so this is synthetic.
  const j = { __typename: 'Tweet', id_str: 'R', text: 'root', created_at: '2020-01-01T00:00:00.000Z',
    user: { screen_name: 'u', name: 'U' },
    quoted_tweet: { id_str: 'Q', text: 'AT&amp;T &lt;3', created_at: '2020-01-01T00:00:00.000Z',
      user: { screen_name: 'q', name: 'Q' } } }
  const post = fromSyndication(j, REF('R'))
  assert.ok(post.quote, 'a quote was built')
  assert.equal(post.quote.text, 'AT&T <3', 'the quoted body is decoded, not left as an entity')
})

test('a single photo becomes one image Media on our-eventual-origin CDN url', () => {
  const post = fromSyndication(PHOTO, PHOTO_REF)
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'image')
  assert.match(post.media[0].url, /^https:\/\/pbs\.twimg\.com\//)
  assert.ok(post.media[0].w > 0 && post.media[0].h > 0)
})

test('a multi-photo tweet keeps EVERY photo, in order', () => {
  const post = fromSyndication(MULTI, MULTI_REF)
  assert.ok(post.media.length >= 2, `expected a multi-photo tweet, got ${post.media.length}`)
  assert.ok(post.media.every(m => m.kind === 'image'))
  for (const m of post.media) assert.match(m.url, /^https:\/\//)
})

test('a video tweet yields ONE video, the HIGHEST-bitrate mp4, with a poster that is NOT the mp4', () => {
  const post = fromSyndication(VIDEO, VIDEO_REF)
  const v = post.media.find(m => m.kind === 'video')
  assert.ok(v, 'a video tweet must yield a video Media')
  assert.match(v.url, /^https:\/\/video\.twimg\.com\/.*\.mp4/, 'must be the mp4, never the m3u8')
  assert.ok(!/\.m3u8/.test(v.url), 'the HLS manifest must never be selected — Discord cannot play it')
  assert.ok(typeof v.poster === 'string' && v.poster.startsWith('https://'), 'a poster is mandatory')
  assert.notEqual(v.poster, v.url, 'the poster is the STILL image, never the video file')
})

test('an animated_gif is a VIDEO, never kind:gif — Twitter delivers it as an mp4', () => {
  // The trap: kind:'gif' maps to Mastodon attachment "image" (see ATTACHMENT_TYPE), so an mp4 url
  // there is the exact preview_url-is-the-video defect. It must be kind:'video' with a poster.
  const post = fromSyndication(GIF, GIF_REF)
  const g = post.media[0]
  assert.equal(g.kind, 'video', 'animated_gif must map to video, not gif')
  assert.match(g.url, /\.mp4/)
  assert.ok(typeof g.poster === 'string' && g.poster.startsWith('https://'))
})

test('pickMp4 selects the lone mp4 even when its bitrate is 0/absent — the animated_gif shape', () => {
  // Twitter animated_gif variants frequently carry bitrate:0 or omit bitrate. Selection filters by
  // content_type FIRST, then max bitrate among the mp4s (defaulting to the only one) — never a
  // truthy-bitrate filter, which would drop this variant and leave a dead player. Synthetic, because
  // no fixture guarantees a bitrate:0 variant.
  const j = { __typename: 'Tweet', id_str: 'X', text: '', created_at: '2020-01-01T00:00:00.000Z',
    user: { screen_name: 'u', name: 'U' },
    mediaDetails: [{ type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/g.jpg',
      video_info: { variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/g.m3u8' },
        { content_type: 'video/mp4', bitrate: 0, url: 'https://video.twimg.com/g.mp4' },
      ] } }] }
  const g = fromSyndication(j, REF('X')).media[0]
  assert.equal(g.kind, 'video')
  assert.equal(g.url, 'https://video.twimg.com/g.mp4', 'the bitrate:0 mp4 is still selected')
})

test('a quote-tweet yields a Post with .quote populated (author + text + media), depth-capped', () => {
  // The owner chose to BUILD quote extraction now. The renderer already consumes post.quote
  // (text.ts quoteHtml, media.ts mediaList hoist) — the normalizer just has to populate it.
  const post = fromSyndication(QUOTE, QUOTE_REF)
  assert.ok(post.quote, 'a quote-tweet must carry .quote')
  assert.ok(post.quote.author.handle.length > 0, 'the quoted author')
  assert.equal(typeof post.quote.text, 'string')
  assert.match(post.quote.canonical, /^https:\/\/x\.com\//)
  // Its own media are populated (this fixture's quoted tweet has a photo).
  assert.ok(post.quote.media.length >= 1 && post.quote.media.every(m => m.url.startsWith('https://')))
  // DEPTH-CAPPED to exactly 1 (types.ts): the quote never carries its own quote/replyTo.
  assert.equal(post.quote.quote, undefined, 'post.quote.quote must be undefined — depth 1')
  assert.equal(post.quote.replyTo, undefined)
})

test('a reply yields .replyTo with at least the parent author, built from the handle+id we have', () => {
  // Syndication gives the parent HANDLE (in_reply_to_screen_name) and ID (in_reply_to_status_id_str),
  // not the full parent post. The renderer only needs replyTo.author (name/handle/url — see
  // mastodon.ts authorName and text.ts replyPrefix). We populate exactly that and do NOT fabricate
  // the parent's text.
  const post = fromSyndication(REPLY, REPLY_REF)
  assert.ok(post.replyTo, 'a reply must carry .replyTo')
  assert.ok(post.replyTo.author.handle.length > 0, 'the parent handle')
  assert.match(post.replyTo.author.url, /^https:\/\/x\.com\//)
  assert.equal(post.replyTo.text, '', 'no parent text was available — do not invent it')
  assert.equal(post.replyTo.replyTo, undefined, 'depth 1')
  // The ref carries a NON-EMPTY parent id, so the whole post survives the cache round-trip — an
  // empty id fails isValidRef and deserializePost would reject the entire record (cache.ts).
  assert.ok(post.replyTo.ref.id.length > 0, 'replyTo.ref.id must be non-empty for the cache guard')
})

test('quote/reply survive the cache round-trip (nested identity is validated on deserialize)', () => {
  // cache.ts hasValidIdentity re-checks a nested quote/replyTo's ref, canonical and createdAt. A
  // half-built nested Post (empty id, missing canonical, unparseable date) would make the ENTIRE
  // post deserialize to null. This pins that our quote and replyTo are cache-valid.
  for (const [raw, ref] of [[QUOTE, QUOTE_REF], [REPLY, REPLY_REF]]) {
    const post = fromSyndication(raw, ref)
    const back = deserializePost(serializePost(post))
    assert.ok(back, 'the post round-trips through the cache intact')
    if (post.quote) assert.ok(back.quote, 'the quote survived')
    if (post.replyTo) assert.ok(back.replyTo, 'the replyTo survived')
  }
})

test('a plain tweet has NO quote and NO replyTo — both fields stay undefined (unchanged)', () => {
  const post = fromSyndication(TEXT, TEXT_REF)
  assert.equal(post.quote, undefined)
  assert.equal(post.replyTo, undefined)
})

test('possibly_sensitive drives sensitive — unlike TikTok/Instagram which are always false', () => {
  // Synthetic, because a fixture may or may not carry the flag. This pins that the field is READ,
  // and read from the SUCCESSFULLY-fetched post (spec sec. sensitive), not confused with the age gate.
  const base = { __typename: 'Tweet', id_str: 'X', text: 'hi',
    created_at: '2020-01-01T00:00:00.000Z', user: { screen_name: 'u', name: 'U' } }
  assert.equal(fromSyndication({ ...base, possibly_sensitive: true }, REF('X')).sensitive, true)
  assert.equal(fromSyndication({ ...base, possibly_sensitive: false }, REF('X')).sensitive, false)
  assert.equal(fromSyndication(base, REF('X')).sensitive, false, 'absent means not sensitive')
})

test('a TweetTombstone is NOT a Post — syndicationHasTweet is false and fromSyndication is null', () => {
  // The age gate. It carries no text/author/media, so it can never become a Post; the fetcher
  // routes it to age_restricted (Task 3/5). Here we only pin that the normalizer refuses it.
  assert.equal(syndicationHasTweet(TOMB), false)
  assert.equal(fromSyndication(TOMB, REF('X')), null)
})

test('syndicationHasTweet is the ONE content assertion, and the {} trap fails it', () => {
  assert.equal(syndicationHasTweet(TEXT), true)
  assert.equal(syndicationHasTweet(VIDEO), true)
  assert.equal(syndicationHasTweet({}), false, 'the missing-token 200-with-{} trap')
  assert.equal(syndicationHasTweet(''), false)
  assert.equal(syndicationHasTweet(null), false)
  assert.equal(syndicationHasTweet(TOMB), false)
})

test('an unparseable created_at is NULL, not a 1970 post', () => {
  const bad = { __typename: 'Tweet', id_str: 'X', text: 'hi', created_at: 'not-a-date',
    user: { screen_name: 'u', name: 'U' } }
  assert.equal(fromSyndication(bad, REF('X')), null)
})

test('a non-https media url is skipped, never emitted', () => {
  const j = { __typename: 'Tweet', id_str: 'X', text: '', created_at: '2020-01-01T00:00:00.000Z',
    user: { screen_name: 'u' },
    mediaDetails: [{ type: 'photo', media_url_https: 'http://pbs.twimg.com/insecure.jpg' }] }
  const post = fromSyndication(j, REF('X'))
  assert.ok(!post || post.media.every(m => m.url.startsWith('https://')))
})

test('returns null on junk, and refuses a non-x ref, without throwing', () => {
  for (const junk of [null, undefined, 42, '', '{}', { foo: 1 }])
    assert.doesNotThrow(() => assert.equal(fromSyndication(junk, REF('X')), null), String(junk))
  assert.equal(fromSyndication(TEXT, { p: 'tt', id: '1' }), null)
})

// ── Task 3: the syndication FETCHER's pure pieces (the token math + the three-way classifier).
// These are testable with no network; fetchSyndication's I/O is exercised live at staging (Task 8).
import { deriveSyndicationToken, syndicationOutcome } from '../src/platforms/twitter/fetch.ts'

test("the token formula matches Twitter's own web-client math, float imprecision INCLUDED", () => {
  // Verified against a live request in the recon: id 20 -> token 6dq1a2xwd93. The float loss on a
  // 19-digit id is INTENDED — Twitter computes it the same way, so ours matches theirs. Do NOT BigInt it.
  assert.equal(deriveSyndicationToken('20'), '6dq1a2xwd93')
  assert.match(deriveSyndicationToken('1491475671058681863'), /^[a-z0-9]+$/, 'base36, no 0s or dots')
  assert.ok(!deriveSyndicationToken('1491475671058681863').includes('.'))
})

test('syndicationOutcome: Tweet is ok, TweetTombstone is age_restricted, {} is assert_fail', () => {
  // PURE — no network. The three trap-states of one endpoint, each a different downstream response.
  assert.equal(syndicationOutcome(TEXT).ok, true)
  assert.deepEqual(syndicationOutcome(TOMB), { ok: false, reason: 'age_restricted' })
  assert.deepEqual(syndicationOutcome({}), { ok: false, reason: 'assert_fail' })    // missing-token trap
  // A 404 HTML poodle page parsed as a string, junk, and null all fail closed to assert_fail.
  for (const junk of ['<html>Nothing to see here</html>', null, undefined, 42, []])
    assert.deepEqual(syndicationOutcome(junk), { ok: false, reason: 'assert_fail' }, String(junk))
})

test('a real ok result carries the parsed data through for the normalizer', () => {
  const got = syndicationOutcome(VIDEO)
  assert.equal(got.ok, true)
  assert.equal(got.data, VIDEO)
})

// ── Task 4: the GUEST fallback (Path B) — the pure parse (fromGuest, normalizeTwitter) and the
// classifier (guestOutcome). The live GraphQL surface (getGuestToken/fetchGuest) is exercised at
// staging (Task 8); these fixtures pin the PARSE against real captured guest bytes with no network.
import { fromGuest, normalizeTwitter } from '../src/platforms/twitter/normalize.ts'
import { guestOutcome } from '../src/platforms/twitter/fetch.ts'  // guestOutcome is I/O-adjacent — it lives beside fetchGuest

const GUEST = json('guest-tweet'), VIS = json('guest-visibility')
const GUEST_QUOTE = json('guest-quote'), GUEST_REPLY = json('guest-reply')

// The real tweet id behind each guest fixture (captured live for Task 4).
const GUEST_REF = REF('20')                       // jack — ordinary Tweet, result.legacy
const VIS_REF = REF('1884695849596576004')        // TweetWithVisibilityResults — result.tweet.legacy
const GUEST_QUOTE_REF = REF('1823076043017630114')// elonmusk quoting ThierryBreton (quoted tweet has a photo)
const GUEST_REPLY_REF = REF('1816211874012098692')// elonmusk replying to StephenKing

test('fromGuest reads result.legacy AND result.tweet.legacy (TweetWithVisibilityResults)', () => {
  const a = fromGuest(GUEST, GUEST_REF)
  assert.ok(a && a.text.length > 0, 'ordinary Tweet: result.legacy')
  const b = fromGuest(VIS, VIS_REF)
  assert.ok(b && b.text.length > 0, 'TweetWithVisibilityResults: result.tweet.legacy, NOT result.legacy')
})

test('fromGuest builds the same shape of Media as syndication (shared mp4 selection)', () => {
  // The root of the quote fixture carries a real photo, so this actually exercises the shared
  // mediaFrom/pickMp4 on guest bytes rather than passing vacuously on a media-less tweet.
  const post = fromGuest(GUEST_QUOTE, GUEST_QUOTE_REF)
  assert.ok(post.media.length >= 1, 'the elonmusk quote fixture carries a root photo')
  for (const m of post.media) {
    assert.match(m.url, /^https:\/\//)
    if (m.kind === 'video') {
      assert.ok(!/\.m3u8/.test(m.url))
      assert.ok(typeof m.poster === 'string' && m.poster !== m.url)
    }
  }
})

test('a guest quote-tweet and reply populate .quote / .replyTo, depth-capped', () => {
  const q = fromGuest(GUEST_QUOTE, GUEST_QUOTE_REF)
  assert.ok(q.quote && q.quote.author.handle.length > 0, 'guest quote from result.quoted_status_result.result')
  assert.equal(q.quote.quote, undefined, 'depth 1')
  const rp = fromGuest(GUEST_REPLY, GUEST_REPLY_REF)
  assert.ok(rp.replyTo && rp.replyTo.author.handle.length > 0, 'guest reply parent author')
  assert.equal(rp.replyTo.text, '', 'no fabricated parent text')
  assert.ok(rp.replyTo.ref.id.length > 0, 'a real parent id, for the cache guard')
})

test('guestOutcome: Tweet/TweetWithVisibilityResults ok, TweetTombstone age_restricted', () => {
  assert.equal(guestOutcome(GUEST).ok, true)
  assert.equal(guestOutcome(VIS).ok, true)
  // A guest-shaped tombstone: result.__typename TweetTombstone.
  assert.deepEqual(guestOutcome({ data: { tweetResult: { result: { __typename: 'TweetTombstone' } } } }),
    { ok: false, reason: 'age_restricted' })
  // OPTIONAL-CHAIN TOTALITY: a missing tweetResult/result must fail closed to assert_fail,
  // NEVER throw. {} and {data:{}} have no result; null/junk have no path at all.
  for (const junk of [{}, { data: {} }, { data: { tweetResult: {} } }, null, undefined, 42, []])
    assert.deepEqual(guestOutcome(junk), { ok: false, reason: 'assert_fail' }, String(junk))
})

test('gated-post scheme: guestOutcome splits age vs private on the guest reason', () => {
  const mk = result => ({ data: { tweetResult: { result } } })
  // TweetUnavailable.reason: 'Protected' -> private, 'NsfwLoggedOut' -> age (confirmed strings).
  assert.deepEqual(guestOutcome(mk({ __typename: 'TweetUnavailable', reason: 'Protected' })),
    { ok: false, reason: 'private' })
  assert.deepEqual(guestOutcome(mk({ __typename: 'TweetUnavailable', reason: 'NsfwLoggedOut' })),
    { ok: false, reason: 'age_restricted' })
  // A bare TweetTombstone (the MEASURED age-wall shape, no reason) DEFAULTS to age_restricted.
  assert.deepEqual(guestOutcome(mk({ __typename: 'TweetTombstone' })), { ok: false, reason: 'age_restricted' })
  // A tombstone whose text NAMES a protected account -> private (best-effort text match).
  assert.deepEqual(guestOutcome(mk({ __typename: 'TweetTombstone', tombstone: { text: { text: 'This Post is from a private account' } } })),
    { ok: false, reason: 'private' })
  // FALSE-POSITIVE GUARD: an UNRECOGNISED reason (Suspended, a moderated/deleted account) is NOT a
  // gate — it falls through to assert_fail so a genuinely gone post renders the GENERIC failure.
  assert.deepEqual(guestOutcome(mk({ __typename: 'TweetUnavailable', reason: 'Suspended' })),
    { ok: false, reason: 'assert_fail' })
})

test('fromGuest never throws on a result with neither legacy nor .tweet', () => {
  // result.legacy ?? result.tweet.legacy throws if result has no .tweet object. The unwrap must
  // optional-chain the whole path (data?.tweetResult?.result, result?.legacy ?? result?.tweet?.legacy)
  // and return null, so a future TweetUnavailable or a {} totality input degrades, not 500s.
  for (const junk of [{}, { data: {} }, { data: { tweetResult: { result: {} } } }, null, 42])
    assert.doesNotThrow(() => assert.equal(fromGuest(junk, REF('X')), null), String(junk))
})

test('normalizeTwitter dispatches on source', () => {
  assert.ok(normalizeTwitter({ source: 'syndication', data: TEXT }, TEXT_REF))
  assert.ok(normalizeTwitter({ source: 'guest', data: GUEST }, GUEST_REF))
  assert.equal(normalizeTwitter({ source: 'guest', data: {} }, REF('X')), null)
})

test('guest quote/reply survive the cache round-trip (nested identity validated on deserialize)', () => {
  // Same guard as the syndication quote/reply: cache.ts hasValidIdentity re-checks the nested
  // quote/replyTo's ref, canonical and createdAt, so a half-built nested Post would null the WHOLE
  // record. The guest path builds them from a DIFFERENT shape (quoted_status_result.result and
  // legacy.in_reply_to_*), so it needs its own round-trip pin.
  for (const [raw, ref] of [[GUEST_QUOTE, GUEST_QUOTE_REF], [GUEST_REPLY, GUEST_REPLY_REF]]) {
    const post = fromGuest(raw, ref)
    const back = deserializePost(serializePost(post))
    assert.ok(back, 'the guest post round-trips through the cache intact')
    if (post.quote) assert.ok(back.quote, 'the quote survived')
    if (post.replyTo) assert.ok(back.replyTo, 'the replyTo survived')
  }
})

// ── Task 5: the ORCHESTRATOR (fetchTwitter) and the EMPTY credential seam (fetchWithCredentials).
// fetchTwitter is I/O over the two path fetchers, so — unlike every test above — these stub
// globalThis.fetch. That is deliberate: the thing under test is the ORCHESTRATION LOGIC (which path
// runs, and WHEN the seam is reached vs. the guest fallback), which can only be observed across a real
// fetch boundary, not from a fixture.
import { fetchTwitter, fetchWithCredentials } from '../src/platforms/twitter/fetch.ts'

// Swap globalThis.fetch for the duration of one test body and ALWAYS restore it, even when the body
// throws — a leaked stub would silently corrupt every later network-touching test in this process.
const withFetch = (fn, body) => async () => {
  const real = globalThis.fetch; globalThis.fetch = fn
  try { return await body() } finally { globalThis.fetch = real }
}

test('the credential seam is EMPTY — returns null with no accounts', async () => {
  // THE SEAM IS A TESTED BOUNDARY, NOT A TODO. Shipped empty (no CREDENTIAL_KEY, no bundled accounts)
  // it returns null, and that null is exactly what turns an age-gated tweet into an honest
  // age_restricted failure instead of a half-built credential system. A later phase fills it to return
  // { source:'guest', data } — the same shape fetchGuest returns — and these gated posts become
  // ordinary successes with zero rearchitecting.
  assert.equal(await fetchWithCredentials({ p: 'x', id: '1' }, {}), null)
})

// ── gated-post scheme: the syndication tombstone is EMPTY {} — it cannot tell age from private. The
// DISTINCTION lives on the guest path's reason, so the orchestrator now CONSULTS guest on a tombstone
// purely to classify (a bare/unreadable guest reason defaults to age — the pre-existing behavior).
// A URL-aware stub so syndication, the guest activate.json, and the guest GraphQL answer distinctly.
const twStub = ({ syndication, activate, graphql, onGraphql }) => async (url) => {
  const u = String(url)
  if (u.includes('cdn.syndication.twimg.com')) return new Response(JSON.stringify(syndication), { status: 200 })
  if (u.includes('guest/activate.json')) return new Response(JSON.stringify(activate ?? { guest_token: 'gt' }), { status: 200 })
  if (u.includes('TweetResultByRestId')) { onGraphql?.(); return new Response(JSON.stringify(graphql ?? {}), { status: 200 }) }
  throw new Error('unexpected url ' + u)
}

test('gated-post scheme: a syndication tombstone CONSULTS guest to read the reason, defaulting to age', async () => {
  // CHANGED from "does NOT waste a guest fetch": the empty syndication tombstone cannot tell age from
  // private, so the orchestrator consults the guest path to classify. Guest walls too (a bare
  // TweetTombstone), which DEFAULTS to age_restricted — the documented, pre-existing fallback. The
  // guest GraphQL IS reached, unlike a normal tweet (which never leaves syndication).
  let graphqlCalled = false
  const stub = twStub({
    syndication: TOMB,
    graphql: { data: { tweetResult: { result: { __typename: 'TweetTombstone' } } } },
    onGraphql: () => { graphqlCalled = true },
  })
  await withFetch(stub, async () => {
    const got = await fetchTwitter({ p: 'x', id: '1' }, {})
    assert.deepEqual(got, { ok: false, reason: 'age_restricted' })
  })()
  assert.ok(graphqlCalled, 'the guest path IS consulted on a tombstone to read the reason')
})

test('gated-post scheme: a tombstone whose guest reason is Protected classifies PRIVATE', async () => {
  // The private third case. The guest TweetUnavailable.reason 'Protected' is the protected-account
  // wall (confirmed strings: yt-dlp / twitter-openapi). Twitter private-detection is BEST-EFFORT
  // pending a live protected-tweet capture; a non-positive match falls back to age.
  const stub = twStub({
    syndication: TOMB,
    graphql: { data: { tweetResult: { result: { __typename: 'TweetUnavailable', reason: 'Protected' } } } },
  })
  await withFetch(stub, async () => {
    assert.deepEqual(await fetchTwitter({ p: 'x', id: '1' }, {}), { ok: false, reason: 'private' })
  })()
})

test('gated-post scheme: a NORMAL tweet never consults guest — syndication alone', async () => {
  // The extra guest fetch is scoped to the tombstone case ONLY. A real syndication tweet returns ok
  // and the guest GraphQL is never reached.
  let graphqlCalled = false
  const stub = twStub({ syndication: TEXT, onGraphql: () => { graphqlCalled = true } })
  await withFetch(stub, async () => {
    const got = await fetchTwitter(TEXT_REF, {})
    assert.equal(got.ok, true)
    assert.equal(got.source, 'syndication')
  })()
  assert.equal(graphqlCalled, false, 'a normal tweet costs no guest fetch')
})
