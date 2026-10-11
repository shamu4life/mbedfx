import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { crawlerCaption, feedCaption, archiveCaption, pickCaption } from '../src/platforms/reddit/caption.ts'
import { fetchReddit } from '../src/platforms/reddit/fetch.ts'
import { normalizeReddit, redditCaptionSource } from '../src/platforms/reddit/normalize.ts'

/**
 * THE BODY OF A POST WHOSE EMBED PAGE CARRIES NONE. Reported 2026-10-11 on r/DeadlockTheGame/comments/1x1xajw:
 * an image post whose 176-character caption explains the picture, and whose card showed only the title. Of 72
 * picture, video, link and crosspost posts with a body sampled that day, embed.reddit.com carried none.
 *
 * The owner chose the sources and their order (caption.ts): Reddit's crawler page first, Reddit's feed when it
 * answers, and the Arctic Shift archive only to complete a body Reddit cut short, and only when Reddit's cut
 * text is a prefix of it. Fixtures: the real answers for 1x1xajw (crawler 301 body, feed entry, archive record)
 * and 1mizdfz (a post with NO body, whose crawler description is the subreddit's tagline), captured from a
 * residential IP; a Cloudflare Worker got the same bytes for each the same day. The archive record was asked
 * with `fields=id,selftext`, exactly as fetch.ts asks it.
 */

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const CRAWLER = fx('reddit-crawler-caption.html')
const TAGLINE = fx('reddit-crawler-tagline.html')
const FEED = fx('reddit-feed-caption.xml')
const ARCHIVE = fx('reddit-archive-caption.json')
const IMAGE_PAGE = fx('reddit-embed-image-caption.html')
const FULL = 'If you reload with max ammo, which for him is 32 with all the ammo increasing items and kenetic dash, you end up in a board state where both players play the bong cloud opening'
const CUT = 'If you reload with max ammo, which for him is 32 with all the ammo increasing items and kenetic dash, you end up in a board…'

test("THE CRAWLER PAGE'S DESCRIPTION IS THE BODY, its counts prefix dropped and its cut kept", () => {
  assert.deepEqual(crawlerCaption(CRAWLER, 'DeadlockTheGame'), { kind: 'body', text: CUT, cut: true })
})

test("A SUBREDDIT'S TAGLINE IS NOT A BODY — the shape Reddit uses for a post that has none", () => {
  // "76 votes, 28 comments. 2.4M subscribers in the theydidthemath community. And they said math has no real
  // world applications": it reads like a caption and is the subreddit's description. Shown, it would put the
  // same sentence on every body-less post in the subreddit.
  assert.deepEqual(crawlerCaption(TAGLINE, 'theydidthemath'), { kind: 'none' })
  assert.deepEqual(crawlerCaption(TAGLINE, 'THEYDIDTHEMATH'), { kind: 'none' }, 'the subreddit match ignores case')
})

test('A TAGLINE IS RECOGNISED BY THIS POST\'S SUBREDDIT ONLY, so a body naming another community survives', () => {
  const page = '<meta name="description" content="3 votes, 1 comment. 40 members in the pics community. joined today">'
  assert.equal(crawlerCaption(page, 'gaming').kind, 'body')
  assert.equal(crawlerCaption(page, 'pics').kind, 'none')
})

test('THE COUNTS PREFIX IS OPTIONAL — a post with few votes has none', () => {
  // Measured from a Worker on r/Minecraft/comments/1x2voz0: the description started with the body itself.
  const page = '<meta name="description" content="Hello! I&#x27;ve spent the past few months working on a project, long term goal is to…">'
  assert.deepEqual(crawlerCaption(page, 'Minecraft'),
    { kind: 'body', text: "Hello! I've spent the past few months working on a project, long term goal is to…", cut: true })
})

test('A BLOCK PAGE OR A PAGE WITH NO DESCRIPTION SAYS NOTHING — never "no body"', () => {
  // Each of these has been seen from Reddit (caption-source research, 2026-10-11). Reading any of them as
  // "this post has no body" would cache a captionless card for a post that has one.
  for (const page of [
    '<html><body>You\'ve been blocked by network security.</body></html>',
    '<html><body>whoa there, pardner! blocked due to a network policy</body></html>',
    '<html><title>Reddit</title><form><input type="hidden" name="js_challenge" value="1"></form></html>',
    '<html><head><title>Reddit</title></head></html>',
    '',
  ]) assert.deepEqual(crawlerCaption(page, 'pics'), { kind: 'unknown' }, page.slice(0, 40))
})

test('THE FEED IS READ ONLY FROM THE ENTRY THAT NAMES THIS POST', () => {
  assert.deepEqual(feedCaption(FEED, '1x1xajw'), { kind: 'body', text: FULL })
  assert.equal(feedCaption(FEED, 'abc123'), null, 'another id is not this post')
  assert.equal(feedCaption('', '1x1xajw'), null, 'a 429 answers with an empty body')
  const noBody = FEED.replace(/&lt;!-- SC_OFF --&gt;[\s\S]*?&lt;!-- SC_ON --&gt;/, '')
  assert.notEqual(noBody, FEED, 'precondition: the md block was removed')
  assert.deepEqual(feedCaption(noBody, '1x1xajw'), { kind: 'none' }, 'an entry with no md block is a post with no body')
})

test('THE ARCHIVE RECORD COUNTS ONLY FOR ITS OWN ID, and a removed body is no body', () => {
  assert.deepEqual(archiveCaption(ARCHIVE, '1x1xajw'), { masked: FULL, plain: FULL })
  assert.equal(archiveCaption(ARCHIVE, 'zzzzzzz'), null)
  assert.equal(archiveCaption('{"data":[]}', '1x1xajw'), null, 'not archived yet (a post under ~30 s old)')
  assert.equal(archiveCaption('{"data":[{"id":"1x1xajw","selftext":"[removed]"}]}', '1x1xajw'), null)
  assert.equal(archiveCaption('<html>error 522</html>', '1x1xajw'), null)
})

test("THE ORDER: Reddit's whole text first, Reddit's own cut text over an archive that disagrees with it", () => {
  const crawler = crawlerCaption(CRAWLER, 'DeadlockTheGame')
  const arch = (t) => ({ masked: t, plain: t })
  assert.deepEqual(pickCaption(crawler, feedCaption(FEED, '1x1xajw'), arch(FULL)), { text: FULL, source: 'feed' }, 'the feed wins')
  assert.deepEqual(pickCaption(crawler, null, arch(FULL)), { text: FULL, source: 'archive' }, 'the archive completes a cut it agrees with')
  const edited = 'If you reload with max ammo you lose. EDIT: never mind'
  assert.deepEqual(pickCaption(crawler, null, arch(edited)), { text: CUT, source: 'cut' }, 'an archive that disagrees is never shown')
  assert.deepEqual(pickCaption(crawler, null, null), { text: CUT, source: 'cut' }, 'with nothing else, Reddit\'s cut text')
  assert.deepEqual(pickCaption({ kind: 'body', text: 'short and whole', cut: false }, null, arch('other')), { text: 'short and whole', source: 'crawler' })
  assert.deepEqual(pickCaption({ kind: 'none' }, null, arch(FULL)), { text: '', source: 'none' }, 'the archive never overrules "no body"')
  assert.deepEqual(pickCaption({ kind: 'unknown' }, null, arch(FULL)), { text: '', source: 'unknown' }, 'nor speaks when Reddit said nothing')
})

/** Global fetch answered per host; every request recorded. */
async function withHosts(routes, fn) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u)
    asked.push({ url, init })
    for (const [prefix, answer] of routes) if (url.startsWith(prefix)) return answer(url, init)
    throw new Error(`unexpected fetch ${url}`)
  }
  try { return await fn(asked) } finally { globalThis.fetch = real }
}
const html = (body, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html' } })
const REF = { p: 'rd', sub: 'DeadlockTheGame', id: '1x1xajw' }

test("THE DEADLOCK REPORT, END TO END: Reddit cut the caption, the feed answered, the card carries all of it", async () => {
  await withHosts([
    ['https://embed.reddit.com/', html(IMAGE_PAGE)],
    ['https://www.reddit.com/r/', html(CRAWLER, 301)],
    ['https://www.reddit.com/by_id/', () => new Response(FEED, { status: 200 })],
  ], async (asked) => {
    const got = await fetchReddit(REF, {})
    const post = normalizeReddit(got, REF)
    assert.equal(post.text, FULL)
    assert.equal(redditCaptionSource(got), 'feed')
    assert.deepEqual(asked.map(a => new URL(a.url).pathname), [
      '/r/DeadlockTheGame/comments/1x1xajw/', '/r/DeadlockTheGame/comments/1x1xajw/', '/by_id/t3_1x1xajw/.rss',
    ], 'embed, crawler, feed; the archive is not asked once Reddit answered')
    const crawl = asked[1].init
    assert.equal(crawl.redirect, 'manual', 'the 301 carries the description; following it costs a second request')
    assert.match(new Headers(crawl.headers).get('user-agent'), /Discordbot/)
    assert.ok(crawl.signal, 'bounded')
  })
})

test('THE FEED RATIONED OUT (429): the archive completes the caption because it agrees with Reddit', async () => {
  await withHosts([
    ['https://embed.reddit.com/', html(IMAGE_PAGE)],
    ['https://www.reddit.com/r/', html(CRAWLER, 301)],
    ['https://www.reddit.com/by_id/', () => new Response('', { status: 429 })],
    ['https://arctic-shift.photon-reddit.com/', () => new Response(ARCHIVE, { status: 200 })],
  ], async (asked) => {
    const got = await fetchReddit(REF, {})
    assert.equal(normalizeReddit(got, REF).text, FULL)
    assert.equal(redditCaptionSource(got), 'archive')
    const arch = asked.find(a => a.url.startsWith('https://arctic-shift'))
    assert.equal(arch.url, 'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=1x1xajw&fields=id,selftext')
    assert.match(new Headers(arch.init.headers).get('user-agent'), /mbedfx/, 'it says who is asking')
  })
})

test('EVERY SOURCE BUT THE CRAWLER DOWN: the card carries Reddit\'s cut caption rather than none', async () => {
  await withHosts([
    ['https://embed.reddit.com/', html(IMAGE_PAGE)],
    ['https://www.reddit.com/r/', html(CRAWLER, 301)],
    ['https://www.reddit.com/by_id/', () => { throw new TypeError('connection reset') }],
    ['https://arctic-shift.photon-reddit.com/', () => new Response('<html>522</html>', { status: 522 })],
  ], async () => {
    const got = await fetchReddit(REF, {})
    assert.equal(normalizeReddit(got, REF).text, CUT)
    assert.equal(redditCaptionSource(got), 'cut')
  })
})

test('A POST WITH NO BODY COSTS ONE CRAWLER REQUEST, and the archive is never asked', async () => {
  const noBodyPage = IMAGE_PAGE // the tagline answer is what makes it body-less here
  await withHosts([
    ['https://embed.reddit.com/', html(noBodyPage)],
    ['https://www.reddit.com/r/', html(TAGLINE.replace(/theydidthemath/g, 'DeadlockTheGame'), 301)],
  ], async (asked) => {
    const got = await fetchReddit(REF, {})
    assert.equal(normalizeReddit(got, REF).text, '')
    assert.equal(redditCaptionSource(got), 'none')
    assert.equal(asked.length, 2, 'embed and crawler, nothing else')
  })
})

test('A BLOCKED CRAWLER ASKS THE FEED, and nothing third-party', async () => {
  await withHosts([
    ['https://embed.reddit.com/', html(IMAGE_PAGE)],
    ['https://www.reddit.com/r/', html('<html>blocked by network security</html>', 403)],
    ['https://www.reddit.com/by_id/', () => new Response('', { status: 429 })],
  ], async (asked) => {
    const got = await fetchReddit(REF, {})
    assert.equal(normalizeReddit(got, REF).text, '')
    assert.equal(redditCaptionSource(got), 'unknown')
    assert.ok(!asked.some(a => a.url.includes('arctic-shift')), 'without Reddit\'s text there is nothing to check the archive against')
  })
})

test('A POST WHOSE PAGE CARRIES ITS BODY ASKS NOTHING ELSE', async () => {
  const pyrex = fx('reddit-embed-multimedia.html')
  await withHosts([['https://embed.reddit.com/', html(pyrex)]], async (asked) => {
    const ref = { p: 'rd', sub: 'YouShouldKnow', id: '8xq8ac' }
    const got = await fetchReddit(ref, {})
    assert.ok(normalizeReddit(got, ref).text.includes('TLDR'))
    assert.equal(redditCaptionSource(got), null)
    assert.equal(asked.length, 1)
  })
})

test('A SLOW SOURCE COSTS AT MOST ITS SHARE: the whole lookup stays inside its budget', async () => {
  // Each source is bounded by its own timeout and all of them by one budget, so a hanging Reddit cannot
  // hold the card past it. The stub honours the abort signal the way fetch does.
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  await withHosts([
    ['https://embed.reddit.com/', html(IMAGE_PAGE)],
    ['https://www.reddit.com/', hang],
  ], async () => {
    const t0 = Date.now()
    const got = await fetchReddit(REF, {})
    const ms = Date.now() - t0
    assert.equal(got.ok, true, 'the post still loads')
    assert.ok(ms < 2600, `bounded by the caption budget, took ${ms}ms`)
    assert.equal(normalizeReddit(got, REF).title, 'Solomon does the bong cloud opening if you reload with max ammo')
  })
})

test('A BARE /comments/{id} LINK IS ASKED AGAIN UNDER ITS REAL SUBREDDIT, so its card is the full one', async () => {
  /**
   * Measured in production 2026-10-11: the bare form got the stripped render (title rebuilt from the slug,
   * u/[unknown], no counts, no body), and because normalize keys the post under the page's canonical sub,
   * that card was then served for the ORDINARY link too, for up to 900 s in that colo.
   */
  const stripped = '<html><body><div id="canonical-url-updater" value="https://www.reddit.com/r/YouShouldKnow/comments/8xq8ac/ysk_pyrex_and_pyrex_are_not_the_same_thing/"></div>'
    + '<shreddit-screenview-data data="{&quot;post&quot;:{&quot;type&quot;:&quot;multi_media&quot;,&quot;created_timestamp&quot;:1531236634453}}"></body></html>'
  const full = fx('reddit-embed-multimedia.html')
  await withHosts([
    ['https://embed.reddit.com/r/_/', html(stripped)],
    ['https://embed.reddit.com/r/YouShouldKnow/', html(full)],
  ], async (asked) => {
    const ref = { p: 'rd', sub: '', id: '8xq8ac' }
    const got = await fetchReddit(ref, {})
    const post = normalizeReddit(got, ref)
    assert.equal(post.title, 'YSK: PYREX and pyrex are not the same thing.', 'the real title, not the slug')
    assert.equal(post.author.name, 'u/speedy_162005')
    assert.ok(post.text.includes('TLDR'))
    assert.deepEqual(asked.map(a => new URL(a.url).pathname), ['/r/_/comments/8xq8ac/', '/r/YouShouldKnow/comments/8xq8ac/'])
  })
})

test('THE SUB ALREADY ASKED IS NOT ASKED AGAIN, whatever its case', async () => {
  await withHosts([['https://embed.reddit.com/', html(fx('reddit-embed-multimedia.html'))]], async (asked) => {
    await fetchReddit({ p: 'rd', sub: 'youshouldknow', id: '8xq8ac' }, {})
    assert.equal(asked.length, 1)
  })
})

test('A BARE LINK WHOSE RE-ASK FAILS KEEPS THE FIRST ANSWER — a thinner card, never "couldn\'t load"', async () => {
  // Review, 2026-10-11: askTwice rethrows a transport failure, and the re-ask used to turn a renderable
  // placeholder answer into the failure card, which Discord then freezes.
  const stripped = '<html><body><div id="canonical-url-updater" value="https://www.reddit.com/r/YouShouldKnow/comments/8xq8ac/ysk_pyrex/"></div>'
    + '<h1 class="line-clamp-3">YSK: PYREX</h1>'
    + '<shreddit-screenview-data data="{&quot;post&quot;:{&quot;type&quot;:&quot;text&quot;,&quot;created_timestamp&quot;:1531236634453}}"></body></html>'
  await withHosts([
    ['https://embed.reddit.com/r/_/', html(stripped)],
    ['https://embed.reddit.com/r/YouShouldKnow/', () => { throw new TypeError('connection reset') }],
  ], async () => {
    const ref = { p: 'rd', sub: '', id: '8xq8ac' }
    const got = await fetchReddit(ref, {})
    assert.equal(got.ok, true)
    assert.equal(normalizeReddit(got, ref).title, 'YSK: PYREX')
  })
})

test('A CUT CAPTION WHOSE FEED AND ARCHIVE HANG STILL ENDS INSIDE THE CAPTION BUDGET', async () => {
  // Review, 2026-10-11: the first budget test hung the crawler, which never reaches the archive, so a
  // lookup with only per-source caps (1.5 + 0.8 + 1.5 s) would still have passed it.
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  await withHosts([
    ['https://embed.reddit.com/', html(IMAGE_PAGE)],
    ['https://www.reddit.com/r/', html(CRAWLER, 301)],
    ['https://www.reddit.com/by_id/', hang],
    ['https://arctic-shift.photon-reddit.com/', hang],
  ], async () => {
    const t0 = Date.now()
    const got = await fetchReddit(REF, {})
    const ms = Date.now() - t0
    assert.ok(ms < 2200, `one budget for every source, took ${ms}ms`)
    assert.equal(normalizeReddit(got, REF).text, CUT, "Reddit's cut text, which was already in hand")
  })
})

/* ===================== SPOILERS ON THE DESCRIPTION PATH =====================
 * Reddit flattens its description from the rendered post and drops a spoiler's markers while keeping what
 * it hid (measured 2026-10-11 on r/Jujutsufolk/comments/1x2vdbg: `>!&#x200B;!<` became a bare zero-width
 * space). The description alone therefore cannot mask a spoiler, exactly as Reddit's own Discord preview of
 * the same link does not. These pin what CAN be done: raw markers are masked, and any second source's
 * markers win.
 */

const meta = (s) => `<meta name="description" content="${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`

test('A CLOSED SPOILER PAIR IN A DESCRIPTION IS MASKED; A LONE >! THERE IS LITERAL TEXT', () => {
  /**
   * REWRITTEN 2026-10-11 after the second review. This first masked an unclosed `>!` to the end of the
   * description too, as if Reddit's cut had landed inside a spoiler. But Reddit drops a real spoiler's
   * markers from the description (measured), so a lone `>!` there is something the poster typed, and
   * masking it hid the rest of the caption. A closed pair is still masked: it costs nothing if literal.
   */
  assert.deepEqual(crawlerCaption(meta('Ep 12: >!Solomon dies!< GG'), 's'), { kind: 'body', text: 'Ep 12: [spoiler] GG', cut: false })
  assert.deepEqual(crawlerCaption(meta('wow >! that ending, and the rest of the caption is still here…'), 's'),
    { kind: 'body', text: 'wow >! that ending, and the rest of the caption is still here…', cut: true })
})

test('INVISIBLE CHARACTERS IN A DESCRIPTION DO NOT STOP IT MATCHING THE ARCHIVE', () => {
  // The measured spoiler-led caption opens with the zero-width text its spoiler hid; the archive's converted
  // text drops zero-width characters, so the description has to as well, or the two never agree.
  const crawler = crawlerCaption(meta('\u200b Even though it is clearly never stated that Sukuna has, or would have, a maximum technique I think it is interesting to debate atleast between his…'), 's')
  const archived = archiveCaption(JSON.stringify({ data: [{ id: 'z', selftext: '>!&#x200B;!<Even though it is clearly never stated that Sukuna has, or would have, a maximum technique I think it is interesting to debate atleast between his two strongest attacks.' }] }), 'z')
  assert.equal(pickCaption(crawler, null, archived).source, 'archive')
})

test('A DESCRIPTION THAT SHOWS A SPOILER IN THE CLEAR IS COMPLETED FROM THE ARCHIVE WITH IT MASKED', () => {
  // The description reads the hidden text plainly; the archive has the markers. Compared with its spoiler
  // unwrapped, it agrees, and what is shown is the archive's masked text.
  const crawler = crawlerCaption(meta('The twist: Solomon was the narrator all along, and honestly the board was his memory of the whole match, which nobody saw coming at all…'), 's')
  const archived = archiveCaption(JSON.stringify({ data: [{ id: 'abc', selftext: 'The twist: >!Solomon was the narrator all along!<, and honestly the board was his memory of the whole match, which nobody saw coming at all. More here.' }] }), 'abc')
  const picked = pickCaption(crawler, null, archived)
  assert.equal(picked.source, 'archive')
  assert.ok(picked.text.startsWith('The twist: [spoiler], and honestly'), picked.text)
  assert.ok(!picked.text.includes('narrator'))
})
