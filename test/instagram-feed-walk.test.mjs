import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchInstagramUserFeed } from '../src/platforms/instagram/fetch.ts'

/**
 * THE ACCOUNT FEED IS THE ONLY VIDEO RECOVERY THIS PLATFORM HAS, AND IT COULD ONLY SEE TWELVE POSTS.
 *
 * Reported from production 2026-08-09: instagram.com/reel/DZxLuleoEoC/ rendered a frozen image while
 * the same reel played on a rival. The reporter's own observation is what located it — ten other
 * Instagram videos worked that same day, which rules out the account, the format and the egress and
 * leaves AGE.
 *
 * The endpoint returns twelve posts and ignores `count` (measured: `count=50` still answers twelve,
 * with `more_available: true`). Instagram's `/embed/captioned/` was returning `EmbedBrokenMedia` for
 * BOTH the reported reel and a working control from the same account, so the embed is not what
 * separated them: the control was inside the twelve and the reported reel, from June, was not. Every
 * post older than an account's last twelve was unrepairable, and nothing said so.
 *
 * Measured from Cloudflare egress with `wrangler dev --remote`, walking `next_max_id`: the reel is on
 * page three, carrying video_versions 3, 720x1280 and like_count 113,385. Pagination is not gated the
 * way the surfaces around it are.
 *
 * NO NETWORK HERE. `fetch` is stubbed, and each test gets its own handle so one test's pages can
 * never be another's answer.
 */

/** A feed page carrying `codes`, in the shape the walk actually reads. */
const page = (codes, next) => JSON.stringify({
  items: codes.map(c => ({ code: c, media_type: 2, video_versions: [{ url: `https://x.invalid/${c}.mp4` }] })),
  more_available: Boolean(next),
  next_max_id: next || undefined,
})

function stubFeed(pages) {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (u) => {
    const url = String(u)
    seen.push(url)
    const m = url.match(/max_id=([^&]+)/)
    const key = m ? decodeURIComponent(m[1]) : 'p1'
    const body = pages[key]
    if (body === undefined) return new Response('{}', { status: 200 })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { seen, restore: () => { globalThis.fetch = real } }
}

test('A POST ON PAGE ONE COSTS EXACTLY ONE REQUEST — the common case pays nothing for the walk', async () => {
  const { seen, restore } = stubFeed({ p1: page(['AAA', 'WANTED'], 'c2') })
  try {
    const body = await fetchInstagramUserFeed('someone', 'WANTED')
    assert.match(body, /WANTED/)
    assert.equal(seen.length, 1, 'no second page was fetched')
  } finally { restore() }
})

test('A POST BEYOND THE FIRST TWELVE IS REACHED BY FOLLOWING next_max_id — the reported defect', async () => {
  const { seen, restore } = stubFeed({
    p1: page(['A1'], 'c2'),
    c2: page(['B1'], 'c3'),
    c3: page(['WANTED'], 'c4'),
  })
  try {
    const body = await fetchInstagramUserFeed('someone', 'WANTED')
    assert.match(body, /WANTED/, 'the third page is returned, not the first')
    assert.equal(seen.length, 3)
  } finally { restore() }
})

test('THE WALK STOPS AT ITS PAGE CEILING and answers with page one, not with the last page tried', async () => {
  // A miss must leave the caller exactly where it was before pagination existed: recoveredMediaFrom
  // is pure and simply finds nothing, so the card degrades to the cover still it ships today rather
  // than to some other page's post.
  const { seen, restore } = stubFeed({
    p1: page(['A1'], 'c2'), c2: page(['B1'], 'c3'), c3: page(['C1'], 'c4'), c4: page(['WANTED'], null),
  })
  try {
    const body = await fetchInstagramUserFeed('someone', 'MISSING')
    assert.ok(!/WANTED/.test(body), 'it did not walk past its ceiling')
    assert.match(body, /A1/, 'and it answered with page one')
    assert.equal(seen.length, 3, 'three pages is the ceiling')
  } finally { restore() }
})

test('NO SHORTCODE MEANS NO WALK — the copyright path and any other caller keep their old cost', async () => {
  const { seen, restore } = stubFeed({ p1: page(['A1'], 'c2'), c2: page(['WANTED'], null) })
  try {
    const body = await fetchInstagramUserFeed('someone')
    assert.match(body, /A1/)
    assert.equal(seen.length, 1, 'without a code to look for there is nothing to page towards')
  } finally { restore() }
})

test('A FEED THAT SAYS THERE IS NO NEXT PAGE IS NOT PAGED', async () => {
  // more_available:false, or a missing next_max_id, ends the walk. Asking again would be a request
  // that cannot answer anything.
  const { seen, restore } = stubFeed({ p1: page(['A1'], null) })
  try {
    await fetchInstagramUserFeed('someone', 'WANTED')
    assert.equal(seen.length, 1)
  } finally { restore() }
})

test('A HANDLE THAT IS NOT A HANDLE IS STILL REFUSED BEFORE ANY REQUEST', async () => {
  // The walk must not weaken the shape check: this value reaches here off a PARSED payload, and `.`
  // is not escaped by encodeURIComponent.
  const { seen, restore } = stubFeed({ p1: page(['A1'], null) })
  try {
    assert.equal(await fetchInstagramUserFeed('../../etc', 'WANTED'), null)
    assert.equal(await fetchInstagramUserFeed(42, 'WANTED'), null)
    assert.equal(seen.length, 0, 'nothing was fetched')
  } finally { restore() }
})
