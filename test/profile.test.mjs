import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { route } from '../src/router.ts'
import { handle } from '../src/worker.ts'
import { render } from '../src/render/index.ts'
import { normalizeBlueskyProfile } from '../src/platforms/bluesky/normalize.ts'
import { PROFILE_TTL, RESP_TTL } from '../src/cache.ts'

/**
 * PROFILE EMBEDS — the route, the normalizer, the card and the seam between them.
 *
 * WHY ONLY BLUESKY IS HERE, since the gap this closes names vxTwitter. Measured 2026-08-11 from
 * CLOUDFLARE EGRESS, and the full transcript is in router.ts's profile(): x.com, tiktok.com and
 * instagram.com all already answer a crawler with a real profile card of their own, so a route for
 * them would duplicate what Discord already draws; bsky.app answers a crawler with og:title and
 * NOTHING ELSE — no bio, no avatar, no counts — which is the gap. Instagram's profile surfaces are
 * additionally WALLED from this egress (429 with a zero-byte body on the page, 401 require_login on
 * the API), with a same-minute control proving the egress itself is fine.
 *
 * The two shapes deliberately NOT claimed are the reason this file leads with a sweep: a bare
 * /{handle} is the ['x','ig'] chooser and a bare /@{handle} the ['tt','th'] one, and both name a
 * real account on BOTH candidates, so claiming either would serve a card from a site the reader
 * never pasted.
 */

const HOST = 'https://mbedfx.app'
const r = p => route(new URL(HOST + p))

// The real payload, captured 2026-08-11 from Cloudflare egress:
//   GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app
//   -> 200, application/json, 1,052 bytes
const REAL = JSON.parse(readFileSync(new URL('./fixtures/bluesky-profile.json', import.meta.url), 'utf8'))
const REF = { p: 'bs', handle: 'bsky.app' }

// ---------------------------------------------------------------------------
// The router. The dangerous half.
// ---------------------------------------------------------------------------

test('/profile/{handle} is a PROFILE route — bsky.app\'s own url with only the host swapped', () => {
  assert.deepEqual(r('/profile/bsky.app'), {
    kind: 'profile',
    ref: { p: 'bs', handle: 'bsky.app' },
    canonical: 'https://bsky.app/profile/bsky.app',
  })
  // The forced twin, which matchPost's rule requires: an arm reachable only through /bs/ would make
  // the escape hatch mean something the bare spelling does not.
  assert.deepEqual(r('/bs/profile/bsky.app').ref, { p: 'bs', handle: 'bsky.app' })
})

test('the DID spelling routes and KEEPS ITS CASE, because a DID is not a hostname', () => {
  // bsky.app links a renamed account by DID, so this is a url a human really pastes. Verified from
  // Cloudflare egress that ?actor={did} answers with the account's CURRENT handle, which is why the
  // normalizer rebuilds the canonical rather than trusting this one.
  const got = r('/profile/did:plc:z72i7hdynmk6r22z27h6tvur')
  assert.equal(got.kind, 'profile')
  assert.equal(got.ref.handle, 'did:plc:z72i7hdynmk6r22z27h6tvur')
  // A DID's method-specific id is case-bearing; lowercasing it would name a different account.
  assert.equal(r('/profile/did:plc:AbCdEf12345').ref.handle, 'did:plc:AbCdEf12345')
})

test('a DNS handle is lowercased, so Bsky.App and bsky.app are ONE account and ONE cache entry', () => {
  // The rule lemmyArm already applies to an instance host, for the same reason: two spellings of one
  // name would otherwise mint two response-cache entries and two upstream fetches.
  assert.equal(r('/profile/Bsky.App').ref.handle, 'bsky.app')
})

test('/profile/{handle}/post/{rkey} is still a POST — the profile arm is depth 2 EXACTLY', () => {
  // The one collision that would matter, and the reason the arm tests seg.length === 2 rather than
  // >= 2. A post must always beat a profile for the same url.
  const post = r('/profile/alice.bsky.social/post/3k2a')
  assert.equal(post.kind, 'post')
  assert.deepEqual(post.ref, { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' })
})

test('the profile arm consumes NO token the ambiguity table has spoken for', () => {
  /**
   * @profile is a plausible X handle, so /profile/followers and /profile/following are that
   * account's follower pages and ambiguity() reserves them at seg[1] — the identical defect this
   * router already fixed twice, once when ST_ID ate 'followers' and once when the Twitch matcher ate
   * /clip/followers. reserved() is the shared guard and this is its third caller.
   *
   * THE BEHAVIOURAL HALF CANNOT FAIL TODAY, and saying so is the point rather than a caveat. Every
   * token in the ambiguity table is a dotless word, and BS_ACTOR refuses a dotless word anyway (a
   * Bluesky handle is a domain), so these two paths stay the chooser with or without the call. A
   * test that passes for a reason other than the one it names is the false green this repo's probe
   * enforcer exists to prevent — so the RULE is pinned structurally beside it. The day someone adds
   * a table row that is actor-shaped, the call is what stops this matcher eating it, and the grep
   * is what stops the call being tidied away first.
   */
  for (const t of ['followers', 'following']) {
    assert.deepEqual(r(`/profile/${t}`), { kind: 'ambiguous', path: `/profile/${t}`, candidates: ['x', 'ig'] })
  }
  const src = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('function profile('), src.indexOf('function x('))
  assert.ok(fn.includes('reserved(seg[1])'), 'profile() must consult reserved() on the handle segment')
})

test('a segment that is not a Bluesky actor stays NOTFOUND rather than becoming a failure card', () => {
  // A Bluesky handle is a domain name or a DID; a dotless word is neither, and minting a ref for one
  // would cost an upstream fetch and render "couldn't load this Bluesky profile" for a url that
  // never named one. An honest notfound is the better card.
  for (const p of ['/profile/x', '/profile/notahandle', '/profile/did:', '/profile/-a.b']) {
    assert.equal(r(p).kind, 'notfound', `${p} must not mint a profile ref`)
  }
  // '/profile/.' is deliberately NOT in that list: the URL parser resolves the dot segment away
  // before route() sees anything, so the path is '/profile/' — depth 1, the bare-username chooser.
  // Asserting notfound there would be asserting against `new URL`, not against this matcher.
  assert.equal(r('/profile/.').kind, 'ambiguous')
})

test('the ONLY paths that route to a profile are depth-2 /profile/{actor} and its forced twin', () => {
  /**
   * THE SHADOWING INVARIANT, as a sweep rather than as a claim.
   *
   * The one-off differential that authorised this arm ran the pre-change router beside this one over
   * 1,115,451 paths and found ELEVEN differences: eight notfound -> profile (the actor-shaped
   * segments, bare and forced) and three THREW -> ambiguous (the /lm, /ms, /pt crash fixed in the
   * same commit). It cannot be committed as a test — it needs the previous commit's router — so what
   * is pinned here is the property it proved: nothing else in this router can answer 'profile'.
   */
  const TOKENS = [
    'settings', 'search', 'explore', 'messages', 'notifications', 'hashtag', 'followers', 'following',
    'i', 'lists', 'bookmarks', 'moments', 'gallery', 'comments', 'stories', 'r', 'p', 'reel', 'reels',
    'tv', 'shorts', 'embed', 'live', 'v', 'watch', 'x', 'tt', 'ig', 'th', 'rd', 'bs', 'yt', 'fb', 'dm',
    'st', 'im', 'tw', 'lm', 'ms', 'mk', 'pt', 'pn', 'status', 'post', 'posts', 'photo', 'photos',
    'videos', 'video', 'groups', 'share', 'clip', 'pin', 'notes', 'notice', 'statuses', 'users', 'user',
    'u', 'w', 'a', 'e', 's', 't', 'c', 'profile', '@user', 'jack', 'bsky.app', 'alice.bsky.social',
    'did:plc:z72i7hdynmk6r22z27h6tvur', 'lemmy.world', '3k2a', '20', 'dQw4w9WgXcQ', 'https:',
  ]
  let seen = 0
  for (const a of TOKENS) {
    for (const b of TOKENS) {
      for (const c of ['', ...TOKENS]) {
        const path = c ? `/${a}/${b}/${c}` : `/${a}/${b}`
        // route() is TOTAL. It threw on three paths until 2026-08-11 and handle() has no try/catch,
        // so a throw here is a public HTTP 500 — see lemmyArm.
        let got
        assert.doesNotThrow(() => { got = route(new URL(HOST + path)) }, `route() threw on ${path}`)
        if (got.kind !== 'profile') continue
        seen++
        const seg = path.split('/').filter(Boolean)
        const bare = seg[0] === 'profile' && seg.length === 2
        const forced = seg[0] === 'bs' && seg[1] === 'profile' && seg.length === 3
        assert.ok(bare || forced, `${path} answered 'profile' and is neither spelling`)
      }
    }
  }
  assert.ok(seen >= 8, `the sweep should reach the profile arm, saw ${seen}`)
})

test('every ESCAPE token ALONE is an answer and never a throw — the /lm, /ms, /pt 500', () => {
  /**
   * Measured on the edge 2026-08-11 through `wrangler dev --remote`: `/lm`, `/ms` and `/pt` each
   * answered HTTP 500 before the guards in lemmyArm, mastoArm and peertubeArm. The ESCAPE block
   * hands a bare token's matchPost an EMPTY segment array and those three read seg[0] before
   * testing the length; misskeyArm tested the length first and was the only one of the four that
   * survived, which is why this asserts over the whole set rather than the three that broke.
   */
  for (const t of ['x', 'tt', 'ig', 'th', 'rd', 'bs', 'yt', 'fb', 'dm', 'st', 'im', 'tw', 'lm', 'ms', 'mk', 'pt', 'pn']) {
    let got
    assert.doesNotThrow(() => { got = route(new URL(`${HOST}/${t}`)) }, `/${t} threw`)
    assert.ok(got.kind === 'ambiguous' || got.kind === 'notfound' || got.kind === 'post',
      `/${t} answered ${got.kind}`)
  }
})

// ---------------------------------------------------------------------------
// The normalizer. Pure, against the captured bytes.
// ---------------------------------------------------------------------------

test('REAL FIXTURE: the captured getProfile payload becomes a Profile with counts, avatar and a join date', () => {
  const p = normalizeBlueskyProfile(REAL, REF)
  assert.equal(p.handle, 'bsky.app')
  assert.equal(p.name, 'Bluesky')
  assert.match(p.bio, /official Bluesky account/)
  assert.equal(p.avatar, REAL.avatar)
  assert.equal(p.canonical, 'https://bsky.app/profile/bsky.app')
  assert.equal(p.counts.posts, REAL.postsCount)
  assert.equal(p.counts.followers, REAL.followersCount)
  assert.equal(p.counts.following, REAL.followsCount)
  assert.equal(p.createdAt.toISOString(), new Date(REAL.createdAt).toISOString())
})

test('the canonical is rebuilt from the PAYLOAD handle, so a DID url names the account as Bluesky does', () => {
  // Verified from Cloudflare egress: ?actor=did:plc:z72i7… answers with handle "bsky.app". The ref
  // still carries the DID (it is what the url said and what the cache is keyed on) and the card
  // still says the handle.
  const p = normalizeBlueskyProfile(REAL, { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur' })
  assert.equal(p.canonical, 'https://bsky.app/profile/bsky.app')
  assert.equal(p.ref.handle, 'did:plc:z72i7hdynmk6r22z27h6tvur')
})

test('a count the payload does not carry is ABSENT, and a zero count is kept', () => {
  /**
   * The honesty rule, at the one place it can be enforced. `undefined ?? 0` and `Number(undefined)`
   * are the two obvious spellings and both turn "nobody told us" into a claim; a zero is a real
   * answer about a real account and must survive.
   */
  const none = normalizeBlueskyProfile({ handle: 'a.bsky.social' }, REF)
  assert.deepEqual(none.counts, {}, 'no count is invented')
  assert.equal('createdAt' in none, false, 'and no date')
  const zero = normalizeBlueskyProfile(
    { handle: 'a.bsky.social', followersCount: 0, followsCount: 0, postsCount: 0 }, REF,
  )
  assert.deepEqual(zero.counts, { followers: 0, following: 0, posts: 0 })
  const junk = normalizeBlueskyProfile(
    { handle: 'a.bsky.social', followersCount: 'lots', followsCount: null, postsCount: -3 }, REF,
  )
  assert.deepEqual(junk.counts, {}, 'a count that is not a non-negative number is not a count')
})

test('a junk createdAt is ABSENT, never the epoch', () => {
  // The 1970 card this project has already shipped once, refused at the type level: Profile.createdAt
  // is optional precisely so a missing or unparseable date has somewhere honest to go.
  for (const bad of ['', 'yesterday', '2026-13-45T99:99:99Z', 42, null]) {
    const p = normalizeBlueskyProfile({ handle: 'a.bsky.social', createdAt: bad }, REF)
    assert.equal('createdAt' in p, false, `createdAt ${JSON.stringify(bad)} must not become a date`)
  }
})

test('an avatar from a host we have NOT measured as unsigned is dropped rather than shipped', () => {
  /**
   * Profile.avatar is the one origin url this codebase emits to a client, and the allowlist is what
   * makes that safe rather than a habit: Discord caches an og:image BY URL, so a signed, expiring
   * url (TikTok's avatars carry x-expires and x-signature) becomes a broken picture on a card that
   * outlives it. Bluesky's is content-addressed with no query string, measured 2026-08-11.
   */
  const off = normalizeBlueskyProfile(
    { handle: 'a.bsky.social', avatar: 'https://evil.example/img.jpg?sig=1' }, REF,
  )
  assert.equal('avatar' in off, false, 'an off-allowlist avatar is not emitted')
  const on = normalizeBlueskyProfile(
    { handle: 'a.bsky.social', avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/y@jpeg' }, REF,
  )
  assert.equal(on.avatar, 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/y@jpeg')
})

test('a body with no handle is NOT a profile — the assertion that survives a 200 carrying an error', () => {
  // Bluesky answers a missing account with an honest HTTP 400 today. That is the exception on this
  // project rather than the rule, so the content assertion is what the card actually rests on.
  for (const junk of [null, {}, { error: 'InvalidRequest', message: 'Profile not found' }, 'nope', 42]) {
    assert.equal(normalizeBlueskyProfile(junk, REF), null, `${JSON.stringify(junk)} is not a profile`)
  }
})

// ---------------------------------------------------------------------------
// The card.
// ---------------------------------------------------------------------------

const body = res => res.text()
const cardOf = async (over = {}) => body(render(
  { kind: 'profile', profile: { ...normalizeBlueskyProfile(REAL, REF), ...over } },
  'discord', HOST,
))

test('the card states the counts and the join date it was given, and nothing it was not', async () => {
  const html = await cardOf()
  assert.match(html, /og:title" content="Bluesky \(@bsky\.app\)"/)
  assert.match(html, /806 posts/)
  assert.match(html, /34\.4M followers/)
  assert.match(html, /11 following/)
  assert.match(html, /Joined April 2023/)
  // The avatar is the origin url, not a /_media/ one — see the normalizer's allowlist.
  assert.match(html, /og:image" content="https:\/\/cdn\.bsky\.app\//)
  assert.ok(!html.includes('/_media/'), 'a profile mints no /_media/ url and therefore no refKey')
})

test('an absent count prints NOTHING, and a zero prints as a zero', async () => {
  const bare = await cardOf({ counts: {}, createdAt: undefined })
  assert.ok(!/followers/.test(bare), 'no count is invented for a payload that carried none')
  assert.ok(!/Joined/.test(bare), 'and no join date')
  assert.ok(!/1970/.test(bare), 'and certainly not the epoch')
  const zero = await cardOf({ counts: { followers: 0, following: 0, posts: 0 } })
  assert.match(zero, /0 followers/, 'a real zero is a real answer about a real account')
})

test('an account with no display name is titled @handle, never " (@handle)"', async () => {
  // byline() from embed.ts would render the leading space, because every POST normalizer defaults a
  // name and it was written for that. A Bluesky display name is optional and often absent.
  const html = await cardOf({ name: '' })
  assert.match(html, /og:title" content="@bsky\.app"/)
})

test('no avatar means NO og:image at all, not a placeholder', async () => {
  // The og:image=".../undefined/avatar" scar: a 404 image is worse than no image.
  const html = await cardOf({ avatar: undefined })
  assert.ok(!/og:image/.test(html), 'nothing is promised that cannot be drawn')
})

test('the two theme-color spellings carry ONE value, which is the platform\'s own', async () => {
  const html = await cardOf()
  const name = html.match(/<meta name="theme-color" content="([^"]+)"/)[1]
  const prop = html.match(/<meta property="theme-color" content="([^"]+)"/)[1]
  assert.equal(name, prop, 'one themeOf() call feeds both, so they cannot disagree')
  assert.equal(name, '#0085ff', 'the Bluesky blue from the shared table, not a second copy of it')
})

test('a bot with no Discord in it gets the SAME single head — a profile has no second seam', async () => {
  // A post has two documents and fixing one leaves the other broken; a profile has one, because the
  // Mastodon spoof exists to lay out attachments a profile does not have.
  const a = await cardOf()
  const b = await body(render(
    { kind: 'profile', profile: normalizeBlueskyProfile(REAL, REF) }, 'other-bot', HOST,
  ))
  const c = await body(render(
    { kind: 'profile', profile: normalizeBlueskyProfile(REAL, REF) }, 'telegram', HOST,
  ))
  assert.equal(a, b)
  assert.equal(a, c)
  assert.ok(!a.includes('activity+json'), 'no spoof link, so no second document to keep in step')
})

// ---------------------------------------------------------------------------
// The route through the worker.
// ---------------------------------------------------------------------------

const ctx = () => {
  const pending = []
  return { ctx: { waitUntil(p) { pending.push(p) } }, settle: () => Promise.allSettled(pending) }
}
const fakeCache = () => {
  const m = new Map()
  const puts = []
  return {
    puts,
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { puts.push([k, v.headers.get('cache-control')]); m.set(k, v.clone()) },
  }
}
const env = () => ({ AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } })
const deps = over => ({
  cache: fakeCache(),
  fetchPost: async () => { throw new Error('the profile route must not fetch a POST') },
  fetchProfile: async ref => normalizeBlueskyProfile(REAL, ref),
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
  resolveMetaShare: async () => null,
  ...over,
})
const get = (path, ua) => new Request(HOST + path, { headers: { 'user-agent': ua } })
const BOT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'

test('a crawler gets the profile card and a human is 302d to bsky.app, costing us no fetch', async () => {
  const { ctx: c } = ctx()
  const d = deps()
  const bot = await handle(get('/profile/bsky.app', BOT), env(), c, d)
  assert.match(await bot.text(), /og:title" content="Bluesky \(@bsky\.app\)"/)

  let asked = 0
  const d2 = deps({ fetchProfile: async ref => { asked++; return normalizeBlueskyProfile(REAL, ref) } })
  const human = await handle(get('/profile/bsky.app', HUMAN), env(), c, d2)
  assert.equal(human.status, 302)
  assert.equal(human.headers.get('location'), 'https://bsky.app/profile/bsky.app')
  assert.equal(asked, 0, 'a human costs us no upstream call — the router already knows the canonical')
})

test('a profile that cannot be read renders a card that says PROFILE, not post', async () => {
  /**
   * The default failure card names the noun in words. Before Outcome carried `subject`, a failed
   * profile fetch rendered "Couldn't load this Bluesky post" for a url that names an account and no
   * post at all — measured against the real appview with a handle that does not exist.
   */
  const { ctx: c } = ctx()
  const res = await handle(get('/profile/nobody.bsky.social', BOT), env(), c, deps({ fetchProfile: async () => null }))
  const html = await res.text()
  assert.match(html, /Couldn't load this Bluesky profile/)
  assert.ok(!/Bluesky post/.test(html), 'the noun must follow the route')
})

test('the rendered profile card is cached for PROFILE_TTL, which is SHORTER than a post card\'s', async () => {
  /**
   * A post is finished and RESP_TTL's fifteen minutes serve the same answer the upstream would. An
   * account is a live surface: its counts move continuously, so the same TTL would publish a stale
   * number under a label that reads as current.
   */
  assert.ok(PROFILE_TTL < RESP_TTL, 'a live surface must not inherit a finished post\'s TTL')
  const { ctx: c, settle } = ctx()
  const d = deps()
  await handle(get('/profile/bsky.app', BOT), env(), c, d)
  await settle()
  assert.equal(d.cache.puts.length, 1, 'exactly one cache write, and it is the response')
  assert.equal(d.cache.puts[0][1], `max-age=${PROFILE_TTL}`)
  assert.match(d.cache.puts[0][0], /resp%3Aprofile%3Abs%3Absky\.app/, 'in its own namespace, keyed by client and origin')

  // And the second request is served from it, with no second upstream call.
  let asked = 0
  const d2 = { ...d, fetchProfile: async ref => { asked++; return normalizeBlueskyProfile(REAL, ref) } }
  await handle(get('/profile/bsky.app', BOT), env(), c, d2)
  assert.equal(asked, 0, 'the cached card answered')
})

test('the profile route touches NO post machinery — no post fetch, no post cache, no container', async () => {
  /**
   * The reason this is its own route arm rather than a branch inside renderPostRoute: that function
   * prewarms a container mux keyed on a refKey a profile cannot mint, races a translation against a
   * body that is a bio, and writes a POST cache entry whose TTL assumes the thing it stores does not
   * change. deps().fetchPost throws, so any of that reaching in fails this test loudly.
   */
  const { ctx: c, settle } = ctx()
  const d = deps()
  const res = await handle(get('/profile/bsky.app', BOT), env(), c, d)
  await settle()
  assert.equal(res.status, 200)
  for (const [key] of d.cache.puts) {
    assert.ok(!key.includes('post%3A'), `the profile route wrote a post cache entry: ${key}`)
  }
})

test('/_api/v1 answers a profile url not_a_post, which is the documented boundary', async () => {
  /**
   * The published contract is post-shaped end to end: `post.text`, `post.createdAt` and four
   * engagement counts, none of which an account has. Serving a profile through it would mean either
   * a mostly-empty post or fields nobody measured, so the endpoint says what it means and
   * docs/API.md carries the same sentence.
   */
  const { ctx: c } = ctx()
  const req = new Request(`${HOST}/_api/v1?url=${encodeURIComponent('https://bsky.app/profile/bsky.app')}`)
  const j = await (await handle(req, env(), c, deps())).json()
  assert.equal(j.ok, false)
  assert.equal(j.error.code, 'not_a_post')
  const doc = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8')
  assert.match(doc, /### Profile urls/, 'the contract documents the boundary it enforces')
})

test('the converter preview says a profile has no preview YET, rather than that the link is broken', async () => {
  /**
   * THE THIRD SEAM. /_card describes a Post and nothing else, so a profile link comes back
   * `{ok:false, reason:'profile'}` — and the page's generic line, "this link doesn't resolve to a
   * post", would be false: Discord draws a card for it. Skipping this check is what shipped two
   * defects in one day (the 1970 YouTube preview and the unreliable translations), so the reason is
   * asserted on both sides of the seam.
   */
  const { ctx: c } = ctx()
  const req = new Request(`${HOST}/_card?p=${encodeURIComponent('/profile/bsky.app')}`)
  const j = await (await handle(req, env(), c, deps())).json()
  assert.deepEqual(j, { ok: false, reason: 'profile' })
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.ok(page.includes("j.reason === 'profile'"), 'the page must branch on that exact reason')
  assert.match(page, /No preview for a profile link yet/)
})
