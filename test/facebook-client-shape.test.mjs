import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { liveFetchPost } from '../src/worker.ts'

/**
 * FACEBOOK IS READ IN MORE THAN ONE CLIENT SHAPE, and this is the test that says why.
 *
 * Between 2026-08-01 and 2026-08-08 the header set this project had always used stopped getting real
 * HTML from datacenter egress. Nothing here changed; Meta's gate did. The symptom was total for the
 * post surface — share, story.php, pfbid and numeric-owner spellings of the SAME post all answered
 * with the generic failure card — while the identical code against the identical url from a
 * residential IP built the card fine, which is what made it look like an outage rather than a bug.
 *
 * The failure mode this pins is the one that costs the most to diagnose: a fetch that returns a
 * PAGE, HTTP 200, with nothing in it. Asserting on status would call that a success. The only
 * evidence that separates the shell from the post is what the page carries, so the retry is driven
 * by whether facebookPostCard could read it, never by the response code.
 */

const REAL = readFileSync(new URL('./fixtures/facebook-post-page.html', import.meta.url), 'utf8')
/** What Meta hands a client shape it has decided against: HTTP 200, a title, and no post. */
const SHELL = '<html><head><title>Facebook</title></head><body>login</body></html>'
const REF = { p: 'fb', kind: 'post', id: '61557887564469_1222064236710626' }

/**
 * Stubs the page fetch and records which shape asked. `sec-ch-ua` is the discriminator because it is
 * present in the rich shape and absent from the lean one — the test does not care WHICH set is which,
 * only that a second one is tried when the first returns nothing readable.
 */
function stubFacebook({ rich, lean }) {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (u, init) => {
    const url = String(u)
    if (!url.startsWith('https://www.facebook.com/')) return real(u, init)
    const headers = init?.headers ?? {}
    const isRich = Boolean(headers['sec-ch-ua'])
    seen.push(isRich ? 'rich' : 'lean')
    return new Response(isRich ? rich : lean, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  return { seen, restore: () => { globalThis.fetch = real } }
}

test('A SHAPE THAT GETS A SHELL IS ASKED AGAIN IN ANOTHER — one client shape failing is not the post being gone', async () => {
  const { seen, restore } = stubFacebook({ rich: SHELL, lean: REAL })
  try {
    const post = await liveFetchPost(REF, {}, 'bot')
    assert.ok(post, 'the second shape read the page the first could not')
    assert.equal(post.author.name, 'InfoWars', 'and it is the real post, not a placeholder')
    assert.deepEqual(seen, ['rich', 'lean'], 'richest first, then the fallback — in that order')
  } finally {
    restore()
  }
})

test('THE RICH SHAPE STILL WINS WHEN IT CAN — the fallback costs nothing on a working path', async () => {
  // The richer header set is what makes a multi-image post render as a GALLERY rather than a cover,
  // so it must keep being asked first. A fallback that quietly became the primary would drop that
  // silently: every card would still render, and only multi-image posts would lose their pictures.
  const { seen, restore } = stubFacebook({ rich: REAL, lean: SHELL })
  try {
    const post = await liveFetchPost(REF, {}, 'bot')
    assert.ok(post, 'the first shape answered')
    assert.deepEqual(seen, ['rich'], 'and the second was never asked for')
  } finally {
    restore()
  }
})

test('EVERY SHAPE GETTING A SHELL IS AN HONEST FAILURE, not a card asserting an empty post', async () => {
  const { seen, restore } = stubFacebook({ rich: SHELL, lean: SHELL })
  try {
    const post = await liveFetchPost(REF, {}, 'bot')
    assert.equal(post, null, 'no shape read a post, so there is no post to show')
    assert.deepEqual(seen, ['rich', 'lean'], 'both were tried before giving up')
  } finally {
    restore()
  }
})
