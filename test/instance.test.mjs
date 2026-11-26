import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CRON_FALLBACK_ORIGIN, cronOrigin, handle } from '../src/worker.ts'
import { refKey } from '../src/refkey.ts'
import { encodeStatusId } from '../src/statusid.ts'
import { respCacheKey, shortRespCacheKey } from '../src/cache.ts'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'
import {
  ARCHIVE_UA_PRODUCT, DEFAULT_SITE_NAME, REDDIT_UA_FALLBACK, archiveUserAgent, primaryHost, primaryOrigin,
  redditUserAgent, siteLabel, siteName,
} from '../src/instance.ts'
import { DEFAULT_ARCHIVE_USER_AGENT, archiveUserAgent as relayArchiveUserAgent, selftest } from '../relay/server.mjs'

/**
 * WHO AN INSTANCE SAYS IT IS (self-hosting phase 6, 2026-11-25; src/instance.ts).
 *
 * Three strings were constants until then, so every fork shipped the public instance's identity:
 * 'mbedfx' on every card, the owner's Reddit app and account on Reddit's OAuth API, and mbedfx.app on
 * every request to the Arctic Shift archive. They now come from SITE_NAME, REDDIT_USER_AGENT and the
 * PUBLIC_ORIGIN primary. These tests hold three things:
 *   - the public instance's vars, read from wrangler.production.jsonc, give back the exact constants, and
 *     every head it renders is byte for byte what the defaults render, which render.test.mjs pins;
 *   - an unset deployment claims nothing of the owner's;
 *   - a configured value reaches every surface, through handle(), so a call site in worker.ts that
 *     forgot to pass the name fails here.
 * Nothing touches the network: handle() runs on stub Deps, and the Reddit and relay requests on a stub
 * fetch.
 */

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const PROD_VARS = read('wrangler.production.jsonc').vars

/** The three constants these vars replaced, as they stood in src/ on 2026-11-24. */
const OLD_SITE_NAME = 'mbedfx'
const OLD_REDDIT_UA = 'web:mbedfx.app:v0.1 (by /u/shamu4life)'
const OLD_ARCHIVE_UA = 'mbedfx.app (embed fixer; +https://github.com/shamu4life/mbedfx)'

/** Deployments that set none of the identity vars, as each runtime presents them. */
const UNSET = [
  {},
  { PUBLIC_ORIGIN: '' },
  { SITE_NAME: '', REDDIT_USER_AGENT: '   ' },
  // What the Node adapter hands the Worker when the operator sets no PUBLIC_ORIGIN (adapters/node/server.ts).
  { PUBLIC_ORIGIN: 'http://localhost:8787' },
  { PUBLIC_ORIGIN: 'https://embed.example.com https://d.embed.example.com' },
]

// ── the public instance ──────────────────────────────────────────────────────────────────────────────

test('the public instance\'s vars give back the three constants they replaced, byte for byte', () => {
  assert.equal(siteName(PROD_VARS), OLD_SITE_NAME)
  assert.equal(redditUserAgent(PROD_VARS), OLD_REDDIT_UA)
  assert.equal(archiveUserAgent(PROD_VARS), OLD_ARCHIVE_UA, 'built from the PUBLIC_ORIGIN primary, with no var of its own')
  // SITE_NAME is set explicitly even though it equals the default (wrangler.production.jsonc says why),
  // and REDDIT_USER_AGENT must be, because the default can never name an account.
  assert.equal(PROD_VARS.SITE_NAME, OLD_SITE_NAME)
  assert.equal(PROD_VARS.REDDIT_USER_AGENT, OLD_REDDIT_UA)
})

test('the relay\'s self-test sends what the Worker sends to the archive, unset and configured', async () => {
  /**
   * relay/server.mjs keeps its own copy of the archive's user agent, because the relay cannot read the
   * Worker's vars. If the two drift, /selftest measures a request mbedfx never makes, which is the one
   * thing the self-test exists to show. Unset, the relay's is the public instance's, so the owner's
   * relay needed no new setting.
   */
  assert.equal(DEFAULT_ARCHIVE_USER_AGENT, archiveUserAgent(PROD_VARS))
  assert.equal(relayArchiveUserAgent({}), DEFAULT_ARCHIVE_USER_AGENT)
  assert.equal(relayArchiveUserAgent({ ARCHIVE_USER_AGENT: '  ' }), DEFAULT_ARCHIVE_USER_AGENT, 'blank is unset')
  const fork = { PUBLIC_ORIGIN: 'https://embed.example.com' }
  const sent = []
  const impl = async (url, init) => {
    sent.push({ url: String(url), ua: new Headers(init?.headers).get('user-agent') })
    return new Response('{}', { status: 200 })
  }
  // A `now` of its own, so the self-test's one-minute memo cannot answer from another test's run.
  await selftest(impl, 5_000_000_000, { ARCHIVE_USER_AGENT: ` ${archiveUserAgent(fork)} ` })
  const archive = sent.find(s => s.url.startsWith('https://arctic-shift.photon-reddit.com/'))
  assert.ok(archive, 'the self-test asked the archive')
  assert.equal(archive.ua, 'embed.example.com ' + ARCHIVE_UA_PRODUCT, 'the fork\'s own string, trimmed')
  for (const s of sent.filter(x => x !== archive)) assert.doesNotMatch(s.ua, /embed fixer/, 'the other two keep their own')
})

// ── unset ───────────────────────────────────────────────────────────────────────────────────────────

test('unset, nothing claims the owner: no Reddit account, no mbedfx.app, and the name is the software\'s', () => {
  for (const env of UNSET) {
    const label = JSON.stringify(env)
    assert.equal(siteName(env), DEFAULT_SITE_NAME, label)
    const reddit = redditUserAgent(env)
    assert.doesNotMatch(reddit, /shamu4life|mbedfx\.app|\/u\//, `${label}: ${reddit}`)
    assert.match(reddit, /^web:[^:\s]+:v0\.1$/, `${label}: Reddit's platform:app-id:version shape`)
    /**
     * THE ARCHIVE'S STRING KEEPS THE REPOSITORY URL, which names the owner's GitHub account, and that is
     * deliberate: the brief was to keep the product token and the source link, and the link is where the
     * archive's maintainer finds out what is asking. What must never appear unset is the owner's
     * DEPLOYMENT, mbedfx.app, as the leading token.
     */
    const archive = archiveUserAgent(env)
    assert.ok(archive.endsWith(` ${ARCHIVE_UA_PRODUCT}`), `${label}: ${archive}`)
    const lead = archive.slice(0, -ARCHIVE_UA_PRODUCT.length - 1)
    assert.notEqual(lead, 'mbedfx.app', label)
    assert.doesNotMatch(lead, /shamu4life|\s/, label)
  }
  assert.equal(siteName(undefined), DEFAULT_SITE_NAME)
  assert.equal(DEFAULT_SITE_NAME, OLD_SITE_NAME, 'the default is the public instance\'s name, so its cards are unchanged')
})

test('with no usable primary the user agents name the software, and with one they name that host', () => {
  assert.equal(redditUserAgent({}), REDDIT_UA_FALLBACK)
  assert.equal(REDDIT_UA_FALLBACK, 'web:mbedfx-selfhost:v0.1')
  assert.equal(archiveUserAgent({}), `mbedfx ${ARCHIVE_UA_PRODUCT}`)
  const fork = { PUBLIC_ORIGIN: 'https://Embed.Example.com:8443 https://d.embed.example.com' }
  assert.equal(redditUserAgent(fork), 'web:embed.example.com:v0.1', 'lowercased, and no port: Reddit separates its fields with colons')
  assert.equal(archiveUserAgent(fork), `embed.example.com ${ARCHIVE_UA_PRODUCT}`)
})

test('a primary that names nobody to a stranger reads as no primary: localhost and IP literals', () => {
  /**
   * localhost is what the Node adapter fills in when PUBLIC_ORIGIN is unset, so it means "unset" there.
   * An IP literal is usually an address on the operator's own network, which a user agent would hand to
   * Reddit's and the archive's logs. Both fall back to the software's name. cronOrigin still uses them:
   * it needs an origin to render on, not a name to give a stranger.
   */
  for (const PUBLIC_ORIGIN of ['http://localhost:8787', 'http://app.localhost', 'http://192.168.1.20:8787', 'http://[::1]:8787']) {
    assert.equal(primaryHost({ PUBLIC_ORIGIN }), null, PUBLIC_ORIGIN)
    assert.equal(redditUserAgent({ PUBLIC_ORIGIN }), REDDIT_UA_FALLBACK, PUBLIC_ORIGIN)
    assert.equal(archiveUserAgent({ PUBLIC_ORIGIN }), `mbedfx ${ARCHIVE_UA_PRODUCT}`, PUBLIC_ORIGIN)
    assert.equal(cronOrigin({ PUBLIC_ORIGIN }), new URL(PUBLIC_ORIGIN).origin, `${PUBLIC_ORIGIN}: the cron still renders there`)
  }
})

test('the user agents and the scheduled check read the same primary, and only cronOrigin falls back to localhost', () => {
  /**
   * The parse moved out of cronOrigin into primaryOrigin (src/instance.ts) so there is one reading of
   * "primary". This is the evidence it moved unchanged: on every value, cronOrigin is primaryOrigin or
   * the fallback, and the user agents' host is that origin's.
   */
  for (const PUBLIC_ORIGIN of [undefined, '', 'junk https://b.example', 'https://a.example/path https://c.example', 'https://mbedfx.app https://d.mbedfx.app']) {
    const env = { PUBLIC_ORIGIN }
    assert.equal(cronOrigin(env), primaryOrigin(env) ?? CRON_FALLBACK_ORIGIN, String(PUBLIC_ORIGIN))
    if (primaryOrigin(env)) assert.equal(primaryHost(env), new URL(primaryOrigin(env)).hostname)
  }
  assert.equal(primaryOrigin({}), null, 'no fallback here: a user agent must be able to tell there is no primary')
})

test('a configured value wins, trimmed; blank means unset; and a non-string never throws', () => {
  assert.equal(siteName({ SITE_NAME: '  Embed Corner ' }), 'Embed Corner')
  assert.equal(siteName({ SITE_NAME: '\t\n' }), DEFAULT_SITE_NAME)
  assert.equal(siteLabel(undefined), DEFAULT_SITE_NAME, 'what the renderers print when a test calls them with three arguments')
  assert.equal(siteLabel(42), DEFAULT_SITE_NAME)
  const own = 'web:embed.example.com:v1.0 (by /u/someone)'
  assert.equal(redditUserAgent({ REDDIT_USER_AGENT: ` ${own} `, PUBLIC_ORIGIN: 'https://other.example' }), own)
  assert.equal(redditUserAgent({ REDDIT_USER_AGENT: 7, PUBLIC_ORIGIN: 'https://other.example' }), 'web:other.example:v0.1')
})

// ── the Reddit requests ─────────────────────────────────────────────────────────────────────────────

/** Global fetch answered by `answer`, every request recorded with its user agent. */
async function withFetch(answer, fn) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    asked.push({ url, ua: new Headers(init.headers).get('user-agent') })
    return answer(url)
  }
  try { return await fn(asked) } finally { globalThis.fetch = real }
}

test('Reddit\'s OAuth API is told REDDIT_USER_AGENT, or the neutral default, and nothing else is', async () => {
  /**
   * The OAuth fallback runs when the embed page fails its content check and the app credentials are set
   * (fetchReddit in src/platforms/reddit/fetch.ts). Its token is memoised in module scope, so only the
   * first case below asks for one; every case asks for the listing, and both requests carry the agent.
   */
  const listing = [{ kind: 'Listing', data: { children: [{ kind: 't3', data: {
    title: 'a title', author: 'someone', subreddit: 'aww', permalink: '/r/aww/comments/1instua/x/',
    selftext: 'body', score: 1, num_comments: 0, created_utc: 1700000000, over_18: false, url: 'https://www.reddit.com/r/aww/comments/1instua/x/',
  } }] } }, { kind: 'Listing', data: { children: [] } }]
  const answer = url => {
    // A 200 with no canonical: Reddit's "not here" page, which is no refusal, so the archive is not asked.
    if (url.startsWith('https://embed.reddit.com/')) return new Response('<html><body>nothing</body></html>', { status: 200 })
    if (url === 'https://www.reddit.com/api/v1/access_token') return Response.json({ access_token: 'tok', expires_in: 3600 })
    if (url.startsWith('https://oauth.reddit.com/comments/1instua')) return Response.json(listing)
    throw new Error(`unexpected fetch ${url}`)
  }
  const creds = { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret' }
  const cases = [
    [{ ...creds, ...PROD_VARS }, OLD_REDDIT_UA],
    [{ ...creds }, REDDIT_UA_FALLBACK],
    [{ ...creds, PUBLIC_ORIGIN: 'https://embed.example.com' }, 'web:embed.example.com:v0.1'],
    [{ ...creds, PUBLIC_ORIGIN: 'https://embed.example.com', REDDIT_USER_AGENT: 'web:embed.example.com:v2 (by /u/someone)' }, 'web:embed.example.com:v2 (by /u/someone)'],
  ]
  for (const [env, want] of cases) {
    await withFetch(answer, async asked => {
      const got = await fetchReddit({ p: 'rd', sub: 'aww', id: '1instua' }, env)
      assert.equal(got.ok, true, 'precondition: the OAuth listing loaded')
      assert.equal(got.source, 'json', 'precondition: this is the OAuth render')
      const oauth = asked.filter(a => a.url.startsWith('https://oauth.reddit.com/') || a.url.startsWith('https://www.reddit.com/api/'))
      assert.ok(oauth.length >= 1)
      for (const a of oauth) assert.equal(a.ua, want, `${a.url} with ${JSON.stringify(env.REDDIT_USER_AGENT ?? env.PUBLIC_ORIGIN ?? null)}`)
      for (const a of asked.filter(x => !oauth.includes(x))) assert.notEqual(a.ua, want, `${a.url} keeps its own agent`)
    })
  }
})

test('the archive is told the primary host and the project, and on the public instance exactly what it was told before', async () => {
  /**
   * Only a REFUSED embed page reaches the archive path (fetchReddit), so the embed answers 403 here, and
   * with no credentials the OAuth fallback is skipped. The archive record does not matter; the request
   * does.
   */
  const answer = url => {
    if (url.startsWith('https://embed.reddit.com/')) return new Response("You've been blocked by network security.", { status: 403 })
    if (url.startsWith('https://www.reddit.com/')) return new Response('<html></html>', { status: 200 })
    if (url.startsWith('https://arctic-shift.photon-reddit.com/')) return new Response('{"data":[]}', { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }
  const cases = [
    [PROD_VARS, OLD_ARCHIVE_UA],
    [{}, `mbedfx ${ARCHIVE_UA_PRODUCT}`],
    [{ PUBLIC_ORIGIN: 'https://embed.example.com' }, `embed.example.com ${ARCHIVE_UA_PRODUCT}`],
  ]
  for (const [i, [env, want]] of cases.entries()) {
    await withFetch(answer, async asked => {
      // An id of its own per case, so no module-level memo of an earlier case's archive answer applies.
      await fetchReddit({ p: 'rd', sub: 'aww', id: `1arch${i}` }, env)
      const archive = asked.filter(a => a.url.startsWith('https://arctic-shift.photon-reddit.com/'))
      assert.ok(archive.length >= 1, 'precondition: the archive was asked')
      for (const a of archive) assert.equal(a.ua, want)
    })
  }
})

// ── the cards, through handle() ─────────────────────────────────────────────────────────────────────

const HOST = 'https://mbedfx.app'
const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const TELEGRAM = 'TelegramBot (like TwitterBot)'
const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'

function fakeCache() {
  const m = new Map()
  return {
    store: m,
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}
const ctx = { waitUntil() {} }
const baseEnv = vars => ({ AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('asset') } }, ...vars })

const postFor = ref => ({
  ref,
  canonical: `https://bsky.app/profile/${ref.handle}/post/${ref.rkey}`,
  author: { name: 'Alice', handle: ref.handle, url: `https://bsky.app/profile/${ref.handle}` },
  text: 'two pictures',
  createdAt: new Date('2026-07-18T12:00:00.000Z'),
  media: [0, 1].map(i => ({ kind: 'image', url: `https://cdn.bsky.app/img/${i}.jpg`, w: 800, h: 600 })),
  counts: { likes: 3 },
  sensitive: false,
})
const profileFor = ref => ({
  ref, canonical: `https://bsky.app/profile/${ref.handle}`, handle: ref.handle, name: 'Alice', bio: 'a bio',
  counts: { followers: 10, following: 2, posts: 5 },
})
const ttPost = id => ({
  ref: { p: 'tt', id },
  canonical: `https://www.tiktok.com/@someone/video/${id}`,
  author: { name: 'Someone', handle: 'someone', url: 'https://www.tiktok.com/@someone' },
  text: 'a short link', createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [{ kind: 'image', url: 'https://p16-sign.tiktokcdn.com/obj/cover.jpg', w: 720, h: 1280 }],
  counts: { likes: 5 }, sensitive: false,
})
const deps = (cache = fakeCache()) => ({
  cache,
  fetchPost: async ref => postFor(ref),
  fetchProfile: async ref => profileFor(ref),
  resolveShortlink: async (_p, code) => ({ kind: 'post', post: ttPost(`76600000000000000${code.length}`) }),
  resolveRedditShare: async () => null,
  resolveMetaShare: async () => null,
})

/**
 * Every surface that carries the instance's name, plus the activity document, rendered through handle()
 * on one env. `tag` makes the ids this run uses its own (CLAUDE.md, in-flight maps); two runs given the
 * same tag render the same posts, which the byte-identity test needs.
 */
async function surfaces(vars, tag) {
  const env = baseEnv(vars)
  const ref = { p: 'bs', handle: 'alice.bsky.social', rkey: `3inst${tag}` }
  const id = encodeStatusId(refKey(ref))
  const post = `/profile/alice.bsky.social/post/${ref.rkey}`
  const get = async (path, ua) => (await handle(new Request(HOST + path, { headers: { 'user-agent': ua } }), env, ctx, deps())).text()
  return {
    spoof: await get(post, DISCORD),
    plain: await get(post, SLACK),
    telegram: await get(post, TELEGRAM),
    profile: await get(`/profile/inst${tag}.bsky.social`, DISCORD),
    short: await get(`/t/ZTinst${tag}`, DISCORD),
    oembed: await get(`/_oembed/${id}`, DISCORD),
    activity: await get(`/api/v1/statuses/${id}`, DISCORD),
  }
}
const siteNameTag = html => [...html.matchAll(/<meta property="og:site_name" content="([^"]*)"\/>/g)].map(m => m[1])
const HEADS = ['spoof', 'plain', 'telegram', 'profile', 'short']

test('a configured SITE_NAME reaches every head and the oEmbed document, escaped, and "mbedfx" is left nowhere', async () => {
  /**
   * One request per surface, through the front door, because the likely defect is not a renderer that
   * ignores the name but a render() call in worker.ts that never passed it: the spoof head (Discord, a
   * post with media), the plain head (any other bot), Telegram's, the profile card, a TikTok short link
   * (it renders at its own call site), and the oEmbed document. The name carries every character esc()
   * exists for, so an unescaped interpolation shows up as broken markup.
   */
  const NAME = 'Embed "Corner" <&>'
  const got = await surfaces({ SITE_NAME: `  ${NAME} ` }, 'cfg')
  for (const k of HEADS) {
    assert.deepEqual(siteNameTag(got[k]), ['Embed &quot;Corner&quot; &lt;&amp;&gt;'], `${k}: exactly one og:site_name, escaped`)
    assert.doesNotMatch(got[k], /content="mbedfx"/, `${k}: no default left behind`)
  }
  const oembed = JSON.parse(got.oembed)
  assert.equal(oembed.provider_name, NAME, 'JSON needs no HTML escaping, and gets none')
  assert.equal(oembed.provider_url, HOST, 'the url half still comes from the request')
  // The activity document names the platform, not the instance (src/render/mastodon.ts toMastodonStatus).
  assert.equal(JSON.parse(got.activity).application.name, 'Bluesky Social')
})

test('unset, every head says "mbedfx" and oEmbed\'s provider_name is "mbedfx", as before SITE_NAME existed', async () => {
  for (const [label, vars] of [['no vars', {}], ['blank', { SITE_NAME: '   ' }]]) {
    const got = await surfaces(vars, label === 'no vars' ? 'dflt' : 'blnk')
    for (const k of HEADS) assert.deepEqual(siteNameTag(got[k]), ['mbedfx'], `${label}, ${k}`)
    assert.equal(JSON.parse(got.oembed).provider_name, 'mbedfx', label)
  }
})

test('the public instance\'s vars render every surface byte for byte as the defaults do', async () => {
  /**
   * The production half of "nothing changes": render.test.mjs, mastodon.test.mjs and pipeline.test.mjs pin
   * the default output to exact strings, so equal bytes here mean the public instance's cards are the
   * ones those tests already hold. Same ids in both runs, sequentially, each on a fresh cache.
   */
  const withProd = await surfaces(PROD_VARS, 'prod')
  const without = await surfaces({}, 'prod')
  for (const k of Object.keys(withProd)) assert.equal(withProd[k], without[k], k)
  for (const k of HEADS) assert.ok(withProd[k].includes('<meta property="og:site_name" content="mbedfx"/>'), k)
})

test('a renamed instance is not served the old name from the response cache, and the default keeps its keys', async () => {
  /**
   * The response cache stores rendered markup, and the name is in the markup, so the key carries it
   * (cache.ts siteKeyPart). Without that, a rename kept serving the old name for RESP_TTL, and Discord
   * would freeze it into every message crawled in that window. One cache, two names, same post.
   */
  const cache = fakeCache()
  const ref = { p: 'bs', handle: 'alice.bsky.social', rkey: '3instren' }
  const path = `/profile/alice.bsky.social/post/${ref.rkey}`
  const get = async (vars, ua = DISCORD) => (await handle(new Request(HOST + path, { headers: { 'user-agent': ua } }), baseEnv(vars), ctx, deps(cache))).text()
  assert.deepEqual(siteNameTag(await get({ SITE_NAME: 'First' })), ['First'])
  assert.deepEqual(siteNameTag(await get({ SITE_NAME: 'Second' })), ['Second'], 'not First, from the cache')
  assert.deepEqual(siteNameTag(await get({})), ['mbedfx'])
  const keys = [...cache.store.keys()].map(k => decodeURIComponent(k))
  assert.ok(keys.some(k => k.endsWith(`:${HOST}`) && k.startsWith('https://cache.mbedfx.internal/resp:bs:')), 'the default\'s key is spelled as before')
  assert.ok(keys.some(k => k.endsWith(`:${HOST}:site:First`)))

  // The key functions themselves: the default and an unset name produce the spelling every key had.
  const r = { p: 'bs', handle: 'a.example', rkey: '3k2a' }
  assert.equal(respCacheKey(r, 'discord', HOST, undefined, 'mbedfx'), respCacheKey(r, 'discord', HOST))
  assert.equal(respCacheKey(r, 'discord', HOST, 'stills', 'Our Place'), `${respCacheKey(r, 'discord', HOST, 'stills')}:site:Our%20Place`)
  assert.equal(shortRespCacheKey('tt', 'abc', 'discord', HOST, undefined, 'x:y'), `${shortRespCacheKey('tt', 'abc', 'discord', HOST)}:site:x%3Ay`)
})
