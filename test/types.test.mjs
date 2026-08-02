import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/types.ts', 'utf8')

test('Platform covers exactly the supported platforms (six day-one, YouTube, Facebook, the yt-dlp tier, Twitch, Lemmy/PieFed, Pinterest, the Mastodon-API family)', () => {
  /**
   * THE UNION IS THE EXHAUSTIVENESS SPINE, which is why it is pinned by a test rather than left to
   * grow quietly: adding a token makes tsc force an arm into every switch in refkey.ts and worker.ts
   * AND a row into each of the four Record<Platform, string> maps in the renderers, so a half-added
   * platform cannot compile. The failure mode this guards is the opposite one — a token added to the
   * union and nowhere else, which compiles fine and 404s /_media/ silently.
   *
   * dm/st/im (2026-07-26) are the yt-dlp tier: Dailymotion, Streamable, Imgur. 'ng' (Newgrounds) is
   * DELIBERATELY ABSENT — every Newgrounds path 403s behind a JS challenge (NG Guard) that yt-dlp
   * cannot pass, measured 2026-07-26; see the PostRef arm's comment in src/types.ts.
   *
   * 'tw' (2026-07-27) is Twitch, and CLIPS ONLY. VODs are HLS with no progressive mp4 behind them and
   * live channels are a state that goes stale mid-card; both are named as out of scope in the PostRef
   * arm rather than left to look forgotten.
   *
   * 'lm' (2026-07-27) is Lemmy, and it is the ONLY platform here whose ref carries a HOSTNAME. The
   * fediverse is not one site: a post id is local to its instance, so host replacement alone loses
   * the identity and a default instance returns a real-but-different post ~20% of the time. The
   * instance therefore lives in the URL path, and refkey.ts shape-checks it because it becomes the
   * ORIGIN of a request rather than a path component of a fixed one.
   *
   * 'pn' (2026-07-27) is Pinterest. `pin.it/{code}` is DELIBERATELY ABSENT: it is an opaque short
   * code that collapses to a bare /{code} once the host is replaced — the shape the ambiguity chooser
   * already owns — and no live code could be captured to measure its success path.
   */
  const m = src.match(/export type Platform =([^\n]+)/)
  assert.ok(m, 'Platform type must exist')
  assert.deepEqual([...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort(),
    ['bs', 'dm', 'fb', 'ig', 'im', 'lm', 'mk', 'ms', 'pn', 'pt', 'rd', 'st', 'th', 'tt', 'tw', 'x', 'yt'])
})

test('Post has no separate platform field — identity lives in ref.p only', () => {
  // Anchor on 'export type Post = {' exactly: 'export type PostRef' would match first.
  const start = src.indexOf('export type Post = {')
  assert.ok(start > -1, 'Post must be declared as `export type Post = {`')
  const post = src.slice(start, src.indexOf('export type ClientClass'))
  assert.ok(!/^\s+platform:\s*Platform/m.test(post),
    'Post.platform would duplicate ref.p and could disagree with it')
  assert.match(post, /ref:\s*PostRef/)
})

test('PostRef carries every field needed to rebuild each canonical URL', () => {
  assert.match(src, /\{\s*p:\s*'bs';\s*handle:\s*string;\s*rkey:\s*string\s*\}/)
  assert.match(src, /\{\s*p:\s*'th';\s*code:\s*string\s*\}/)
})
