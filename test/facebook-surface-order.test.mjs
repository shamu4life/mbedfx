import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handle, liveFetchPost } from '../src/worker.ts'

/**
 * THE ORDER THE THREE FACEBOOK POST SURFACES ARE TRIED IN, which is a correctness property and not a
 * style choice — and which nothing tested before this file.
 *
 * A Facebook post that is not a video reaches, in this order:
 *
 *   1. the og: PAGE, strict     facebookPostCard  — a byline and a picture. Carries the gallery from
 *                                                   the page's preload links when there is one.
 *   2. the EMBED PLUGIN         facebookPluginCard — real photos at real pixel sizes.
 *   3. the og: PAGE, relaxed    facebookCaptionCard — a byline and a caption, no picture required.
 *
 * WHY 3 IS LAST. It accepts a page that has words and no og:image. If it ran at position 1 it would
 * also accept a page that merely LOST its og:image, and a post whose plugin fragment carries five
 * photos would render as a text card instead. Placed last it can only run where the answer was
 * otherwise the failure card, so it cannot take anything away from a card that renders today.
 *
 * MEASURED FROM CLOUDFLARE EGRESS 2026-08-12, 35 real public post urls across seven pages and four
 * url shapes: the page surface answered 17 of 35 (all fourteen /photo/?fbid= urls got a 438 KB login
 * wall), the plugin answered 33 of 35, and the relaxed page read adds the 2 the plugin declines minus
 * the one that is genuinely deleted. There is no single surface that covers this platform, which is
 * why the order exists at all.
 *
 * THE NETWORK IS STUBBED, as everywhere in this suite. Both Facebook fetchers go through global
 * fetch, so answering by url is enough to place a given post on a given surface.
 */
const load = n => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')
const CAPTION_ONLY = load('facebook-page-caption-only.html')   // og:title + og:description, NO og:image
const PLUGIN_PHOTO = load('facebook-plugin-photo-nocaption.html') // one photo, no caption
const PAGE_WITH_IMAGE = load('facebook-post-page.html')         // the full og: set

/** Meta's own answer for a post it refuses to embed — measured at 38,448 bytes from egress. */
const PLUGIN_GONE = '<html><body><div role="feed"><div class="pam uiBoxWhite"><p class="_1q3v">This Facebook '
  + 'post is no longer available. It may have been removed or the privacy settings of the post may have '
  + 'changed.</p></div></div></body></html>'

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const ctx = { waitUntil() {} }
const fakeCache = () => {
  const m = new Map()
  return { async match(k) { const v = m.get(k); return v ? v.clone() : undefined }, async put(k, v) { m.set(k, v.clone()) } }
}
// NO MEDIA_RESOLVER: a post is not a video, so the container declines it in production too, and the
// arm under test is exactly the one reached after that decline.
const env = () => ({ AE: { writeDataPoint() {} }, ASSETS: { async fetch() { return new Response('a') } } })
const deps = () => ({
  cache: fakeCache(),
  // THE REAL fetcher, not a stub: the three-surface arm under test lives inside it, so a stub
  // returning null would make every assertion in this file about the failure card instead.
  fetchPost: liveFetchPost,
  resolveShortlink: async () => ({ kind: 'unresolved' }),
  resolveRedditShare: async () => null,
  resolveMetaShare: async () => null,
})
const req = p => new Request('https://mbedfx.app' + p, { headers: { 'user-agent': DISCORD } })

/** Answers the page url with `page` and the plugin url with `plugin`, and records what was asked. */
function stubFacebook(page, plugin) {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url
    asked.push(url)
    if (url.includes('/plugins/post.php')) return new Response(plugin ?? '', { headers: { 'content-type': 'text/html' } })
    return new Response(page ?? '', { headers: { 'content-type': 'text/html' } })
  }
  return { asked, restore() { globalThis.fetch = real } }
}

test('A CAPTION-ONLY POST RENDERS, and only after the plugin has been asked and declined', async () => {
  /**
   * /NASA/posts/1304655294363177 — reported as a Facebook post that still drew the failure card.
   * Measured from Cloudflare egress 2026-08-12: the page is 952,579 bytes with og:title and
   * og:description and no og:image, and the plugin answers Meta's own "no longer available". Both
   * surfaces answered; neither produced a card, and the caption was in og:description the whole time.
   */
  const stub = stubFacebook(CAPTION_ONLY, PLUGIN_GONE)
  try {
    const html = await (await handle(req('/NASA/posts/1304655294363177'), env(), ctx, deps())).text()
    assert.match(html, /Go, Comet 3I\/ATLAS, go/, 'the caption is on the card')
    assert.match(html, /NASA - National Aeronautics/, 'and so is the byline')
    assert.ok(!/could not be loaded|couldn.t/i.test(html), 'this is a post, not a failure card')
  } finally { stub.restore() }
  assert.ok(stub.asked.some(u => u.includes('/plugins/post.php')), 'the plugin was tried first')
})

test('THE PLUGIN STILL WINS WHERE IT ANSWERS — the relaxed page read cannot pre-empt it', async () => {
  /**
   * The regression this order exists to prevent: a page that carries a caption and no og:image while
   * the plugin fragment carries the post's actual photo at its actual size. If the relaxed read ran
   * before the plugin, this card would lose its picture and its dimensions.
   */
  const stub = stubFacebook(CAPTION_ONLY, PLUGIN_PHOTO)
  try {
    const html = await (await handle(req('/photo/?fbid=3333333333333333'), env(), ctx, deps())).text()
    assert.match(html, /National Geographic/, 'the plugin fragment supplied the byline')
    assert.ok(!/Go, Comet 3I\/ATLAS/.test(html), 'and the page caption did not take the card')
    // The picture itself is not in THIS head by design — a post with media renders from the
    // Mastodon-shaped status behind the activity+json alternate, and the plain head deliberately
    // leaves og:image to it. The alternate's presence is what says a media card was built.
    assert.match(html, /application\/activity\+json/, 'a card with media, not a text card')
  } finally { stub.restore() }
})

test('A PAGE WITH ITS og:image IS ANSWERED WITHOUT ASKING THE PLUGIN AT ALL', async () => {
  // The strict read is still first, so a post that renders the richer way costs no extra request —
  // the same rule the plugin arm was added under, restated here because the caption arm sits below
  // both and would otherwise look like a third unconditional fetch.
  const stub = stubFacebook(PAGE_WITH_IMAGE, PLUGIN_GONE)
  try {
    const html = await (await handle(req('/RealInfoWars/posts/122206800968682898'), env(), ctx, deps())).text()
    assert.match(html, /InfoWars/, 'the og: page carried the post')
  } finally { stub.restore() }
  assert.ok(!stub.asked.some(u => u.includes('/plugins/post.php')), 'and the plugin was never asked')
})

test('NOTHING ON EITHER SURFACE IS STILL AN HONEST FAILURE', async () => {
  // A genuinely deleted post — measured 2026-08-12 as a 325,556-byte page with no og tags and a
  // 38,107-byte plugin error. Three surfaces that each refuse must not add up to a card.
  const stub = stubFacebook('<html><head><title>Facebook</title></head><body></body></html>', PLUGIN_GONE)
  try {
    const res = await handle(req('/NASA/posts/10153395671266772'), env(), ctx, deps())
    const html = await res.text()
    assert.ok(!/NASA - National Aeronautics/.test(html), 'no byline was invented')
    assert.match(html, /could not be loaded|couldn.t load/i, 'it says so instead')
  } finally { stub.restore() }
})
