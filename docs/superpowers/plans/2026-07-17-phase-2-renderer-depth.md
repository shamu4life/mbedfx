# fxeverything Phase 2 — Renderer Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Bluesky post render a *rich* Discord embed — all images (up to 4), formatted text, quote-tweet and reply context — via the Mastodon-instance spoof, with plain-og and native-multi-image fallbacks, plus improved Telegram text.

**Architecture:** Phase 1 emits plain single-media OpenGraph tags. Phase 2 adds a second Discord path: when the client is `discord`, the HTML advertises a `<link rel="alternate" type="application/activity+json">` pointing at a Mastodon-shaped status URL. Discord then fetches `GET /api/v1/statuses/{refKey}` and `GET /_oembed`, and renders the entire embed — text, quote, reply, and every image — from that JSON. The plain-og tags stay in the HTML as a silent fallback. This is verified-live FxEmbed behaviour (2026-07-17), shipped to 100% of their Discord traffic.

**Tech Stack:** TypeScript, Cloudflare Workers, `wrangler`, `node --test`. No runtime dependencies, no framework, no containers. Builds on the Phase 1 branch.

**Spec:** `docs/superpowers/specs/2026-07-16-fxeverything-design.md` (Open question #1 reserved this decision; adopting the spoof resolves it and reserves `api`/`users` as root tokens.)

## Global Constraints

(Inherited from Phase 1 — every task's requirements implicitly include these.)

- Zero runtime dependencies. devDependencies exactly: `@cloudflare/workers-types`, `typescript`, `wrangler`.
- Never guess an ambiguous path. Ambiguity resolves to `{kind:'ambiguous'}`, never a platform.
- Assert on content, never on status code.
- Log nothing identifying. No URLs, post IDs, or IPs. Counters only.
- Never proxy media bytes. `/_media/*` reads the Post cache and 302s.
- Never `Vary: User-Agent`. Client class goes in the cache key.
- Cache keys derive from `refKey(ref)`, never the raw path.
- Renderers emit `/_media/{refKey}/{index}` URLs, never raw CDN URLs — including in `media_attachments`.
- The refKey in a URL segment is `encodeURIComponent`-ed (Phase 1 I-2 fix) so colons survive proxy normalization.
- Origin always derived from the request, never hardcoded.
- Do not touch `megapenispoopenfarten.sex`. Deploy to `staging.megapenispoopenfarten.sex` only.
- Pure core: text builders, the Mastodon mapper, and the oEmbed builder do no I/O.
- Commit identity is pinned to `Shamu4Life`. Never pass `-c`, `--author`, or set `user.email`.

## Phase 2 verified facts (from live research 2026-07-17 — the load-bearing gotchas)

1. **Discord requests `/api/v1/statuses/{id}`, NOT the advertised `/users/.../statuses/{id}`.** The `/users/...` href is a decoy; Discord extracts the last path segment (the "status id") and calls the Mastodon REST endpoint. So `{id}` is the ONLY channel back — pack `refKey` into it. Register BOTH routes to the same handler for safety.
2. **When spoofing, emit ZERO `og:image`/`og:video`.** If both og:image and media_attachments are present, behaviour is inconsistent. The spoof path emits `theme-color`, the activity link, the oembed link, and a minimal `og:title`/`og:description` fallback ONLY.
3. **The Mastodon JSON is a Mastodon API v1 `Status` object** (not raw ActivityStreams). `media_attachments[]` carries ALL images — verified 4 rendering from one post. `content` is HTML (`<b> <i> <a> <blockquote> <br> <code> <pre>` render; `<img> <ul> <h1>` do not).
4. **oEmbed `author_name` OVERRIDES the Mastodon `account.display_name`** on the top line — this is how engagement counts / "Replying to @x" get there. `provider_name` is the footer.
5. **Content-Type MUST be `application/json`** on both the status endpoint and the oembed endpoint.
6. **Consecutive `<br>` collapse** in Discord — inject a variation selector (`️`-class) or ` ` between them to force real double breaks.
7. **Discord's embed debugger does NOT render these paths faithfully.** Final verification MUST be in a real Discord client (desktop + Android; iOS is the known weak spot for multi-image — test it).
8. **The spoof is undocumented Discord behaviour** — the og fallback is the insurance. Keep it.
9. **Native multi-`og:image` also works now** (Discord added it ~Jan 2024) for `discordbot`/`matrixpreviewbot` UAs — images-only, no rich text. Keep as the non-spoof fallback; it's ~10 lines.
10. **Telegram (`TelegramBot`) gets NO activity+json and NO oembed.** It gets one image + improved text. Instant View (multi-image for Telegram) is a separate platform integration — DEFERRED, out of Phase 2.

---

## File Structure

| File | Change |
|---|---|
| `src/render/text.ts` | NEW — pure builders: `buildContentHtml(post)`, `buildPlainText(post)`, `escapeHtml` reuse |
| `src/render/mastodon.ts` | NEW — pure `toMastodonStatus(post, origin)` → Mastodon Status object; `toOEmbed(post)` |
| `src/render/discord.ts` | MODIFY — add the spoof branch (activity+oembed links, drop og:image) + native-multi-og fallback |
| `src/render/telegram.ts` | NEW — Telegram-specific og (single image + rich text), split from discord.ts |
| `src/render/index.ts` | MODIFY — route `telegram` to the new telegram renderer; pass a `spoof` flag for discord |
| `src/router.ts` | MODIFY — add `activity` and `oembed` Route kinds; reserve `api`/`users`/`_oembed` tokens |
| `src/types.ts` | MODIFY — add `{kind:'activity', ref}` and `{kind:'oembed', ref}` to `Route` |
| `src/worker.ts` | MODIFY — handle the two new routes (read Post cache → JSON) |
| `test/*` | NEW/MODIFY — text, mastodon, discord-spoof, telegram, router, pipeline |

---

### Task 1: Rich-text builders

**Files:**
- Create: `src/render/text.ts`
- Test: `test/text.test.mjs`

**Interfaces:**
- Consumes: `Post` from `types.ts`; `esc` from `render/fail.ts`.
- Produces: `buildContentHtml(post: Post): string` (Discord/Mastodon HTML `content`), `buildPlainText(post: Post): string` (Telegram/og description).

`buildContentHtml` composes: optional reply prefix (`↩ {name} (@{handle})`), the post text (HTML-escaped, newlines → `<br>`), engagement counts line, optional quote block (`<blockquote><b>{author}</b><br>{quoted text}</blockquote>`). Depth is 1 — quote/reply never nest further (guaranteed by the normalizer). Consecutive `<br>` get a ` ` inserted to defeat Discord's collapse.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContentHtml, buildPlainText } from '../src/render/text.ts'

const base = {
  ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
  canonical: 'https://bsky.app/x',
  author: { name: 'Alice', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social' },
  text: 'hello <world>\n\nsecond line',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [], counts: { likes: 5, reposts: 2, replies: 1 }, sensitive: false,
}

test('content escapes text and converts newlines to <br>', () => {
  const h = buildContentHtml(base)
  assert.ok(!h.includes('<world>'), 'raw angle brackets must be escaped')
  assert.match(h, /&lt;world&gt;/)
  assert.match(h, /<br>/)
})

test('consecutive breaks are de-collapsed', () => {
  // Discord collapses consecutive <br>; a hair space between them forces the real double break.
  const h = buildContentHtml(base)
  assert.match(h, /<br> <br>|<br><br> /, 'double newline must survive as two visual breaks')
})

test('quote renders as a blockquote with the quoted author', () => {
  const q = { ...base, quote: { ...base, ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' }, author: { name: 'Quoter', handle: 'q.bsky.social', url: 'u' }, text: 'quoted text', counts: {} } }
  const h = buildContentHtml(q)
  assert.match(h, /<blockquote>/)
  assert.match(h, /Quoter/)
  assert.match(h, /quoted text/)
})

test('reply renders a prefix naming the parent author', () => {
  const r = { ...base, replyTo: { ...base, ref: { p: 'bs', handle: 'p.bsky.social', rkey: 'pk' }, author: { name: 'Parent', handle: 'p.bsky.social', url: 'u' }, text: 'parent', counts: {} } }
  const h = buildContentHtml(r)
  assert.match(h, /Parent|@p\.bsky\.social/)
})

test('quote depth never exceeds 1 in output (normalizer guarantees it, builder must not assume otherwise)', () => {
  const q = { ...base, quote: { ...base, ref: { p: 'bs', handle: 'q', rkey: 'qk' }, author: { name: 'Q', handle: 'q', url: 'u' }, text: 'q', counts: {}, quote: undefined } }
  assert.doesNotThrow(() => buildContentHtml(q))
})

test('plain text has no HTML tags', () => {
  const t = buildPlainText(base)
  assert.ok(!/<[a-z]/i.test(t), 'plain text must contain no tags')
  assert.ok(t.includes('hello'))
})
```

- [ ] **Step 2: Run to verify it fails** — `node --test test/text.test.mjs` → cannot find module.

- [ ] **Step 3: Implement** `src/render/text.ts`:

```ts
import type { Post } from '../types.ts'
import { esc } from './fail.ts'

/** Discord collapses consecutive <br>; a hair space between them forces two visual breaks. */
function textToHtml(text: string): string {
  return esc(text).replace(/\n/g, '<br>').replace(/(<br>)(<br>)/g, '$1 $2')
}

function countsLine(post: Post): string {
  const c = post.counts
  const parts: string[] = []
  if (c.replies != null) parts.push(`💬 ${c.replies}`)
  if (c.reposts != null) parts.push(`🔁 ${c.reposts}`)
  if (c.likes != null) parts.push(`❤️ ${c.likes}`)
  return parts.length ? `<b>${parts.join('  ')}</b>` : ''
}

export function buildContentHtml(post: Post): string {
  const chunks: string[] = []
  if (post.replyTo) {
    chunks.push(`<sub>↩ ${esc(post.replyTo.author.name)} (@${esc(post.replyTo.author.handle)})</sub>`)
  }
  if (post.text) chunks.push(textToHtml(post.text))
  const counts = countsLine(post)
  if (counts) chunks.push(counts)
  if (post.quote) {
    chunks.push(
      `<blockquote><b>${esc(post.quote.author.name)} (@${esc(post.quote.author.handle)})</b><br>` +
      `${textToHtml(post.quote.text)}</blockquote>`,
    )
  }
  return chunks.join('<br> <br>')
}

export function buildPlainText(post: Post): string {
  const parts: string[] = []
  if (post.replyTo) parts.push(`↩ ${post.replyTo.author.name} (@${post.replyTo.author.handle})`)
  if (post.text) parts.push(post.text)
  if (post.quote) parts.push(`\n❝ ${post.quote.author.name}: ${post.quote.text}`)
  return parts.join('\n')
}
```

- [ ] **Step 4: Run** — `node --test test/text.test.mjs && npm run typecheck` → PASS 6 tests.
- [ ] **Step 5: Commit** — `feat: rich-text builders for quote/reply/counts`.

---

### Task 2: Mastodon Status + oEmbed mappers

**Files:**
- Create: `src/render/mastodon.ts`
- Test: `test/mastodon.test.mjs`

**Interfaces:**
- Consumes: `Post`; `refKey`; `buildContentHtml`.
- Produces: `toMastodonStatus(post: Post, origin: string): object`, `toOEmbed(post: Post): object`. Both pure.

Maps `Post.media[]` → `media_attachments[]` with `url: {origin}/_media/{encodeURIComponent(refKey)}/{i}`, `type` from `media.kind`, `meta.original.{width,height}` with the same `fudge()` dimension-lying as Phase 1. `account.avatar` → `/_media/{...}/avatar`. `content` ← `buildContentHtml`. oEmbed `author_name` ← engagement/reply summary, `provider_name` ← `"fxeverything"`.

- [ ] **Step 1: Write the failing test** (assert: 4 media → 4 `media_attachments`; all urls are `/_media/` and none raw CDN; `content` present and HTML; `created_at` is ISO; `account.username` set; oEmbed `type:"rich"` + `provider_name`; video media maps to `type:"image"` pointing at the thumbnail per Phase 1 I-1, OR is omitted — match the normalizer's actual behaviour).

- [ ] **Step 2-5:** implement, test, commit. `feat: Mastodon Status + oEmbed mappers`.

*(Full test + impl code to be written by the implementer following the Task 1 pattern and the §"verified facts" JSON shape. The Mastodon Status shape is documented in the research: `{id, url, uri, created_at, language, content, visibility:'public', media_attachments:[{id,type,url,preview_url,meta:{original:{width,height}}}], account:{display_name,username,acct,url,avatar}, mentions:[],tags:[],emojis:[],card:null,poll:null}`. oEmbed: `{author_name, author_url, provider_name:'fxeverything', provider_url, title:'', type:'rich', version:'1.0'}`.)*

---

### Task 3: Router — activity + oembed routes

**Files:**
- Modify: `src/types.ts` (add `{kind:'activity',ref}` and `{kind:'oembed',ref}` to `Route`)
- Modify: `src/router.ts`
- Test: `test/router.test.mjs` (extend)

**Interfaces:**
- Produces: `route()` now recognises `GET /api/v1/statuses/{encodedRefKey}`, `GET /users/{handle}/statuses/{encodedRefKey}` (decoy alias), and the oembed path (e.g. `/_oembed?url=...` or `/_oembed/{encodedRefKey}` — pick one and be consistent with what discord.ts advertises).

Reserve `api`, `users`, `_oembed` as root tokens. The `{encodedRefKey}` segment is decoded once (`safeDecode`) then `parseRefKey`'d — identical handling to `/_media/`.

- [ ] Steps: failing test (assert `/api/v1/statuses/{enc}` → `{kind:'activity', ref}`; decoy `/users/x/statuses/{enc}` → same; malformed → notfound, no throw; the new tokens don't break the ambiguity table), implement, test, commit.

---

### Task 4: Discord renderer — spoof branch + native-multi-og fallback

**Files:**
- Modify: `src/render/discord.ts`
- Modify: `src/render/index.ts` (pass whether to spoof)
- Test: `test/render.test.mjs` (extend)

Discord branch: emit `<link rel="alternate" type="application/activity+json" href="{origin}/users/{handle}/statuses/{encodedRefKey}">`, `<link rel="alternate" type="application/json+oembed" href="{origin}/_oembed/...">`, `<meta name="theme-color">`, and a minimal `og:title`/`og:description` (from `buildPlainText`) fallback ONLY — **no og:image/og:video** on the spoof path. Keep a separate native-multi-og path (N `og:image` for `discordbot` UA) behind a flag as the documented fallback.

- [ ] Steps: failing test (spoof path has the activity link, the oembed link, ZERO og:image, and a fallback og:title; native-multi path emits N og:image), implement, test, commit.

---

### Task 5: Telegram renderer

**Files:**
- Create: `src/render/telegram.ts`
- Modify: `src/render/index.ts` (route `client==='telegram'` here)
- Test: `test/render.test.mjs` (extend)

Telegram: plain og with ONE image (first media), `og:description` from `buildPlainText` (with `<br>` for newlines — the Medium-template quirk), NO activity+json, NO oembed, NO meta-refresh. Instant View is explicitly out of scope.

- [ ] Steps: failing test (telegram output has exactly one og:image, no activity+json, no meta-refresh, and the quote/reply text is present), implement, test, commit.

---

### Task 6: Wire the new routes into the pipeline

**Files:**
- Modify: `src/worker.ts`
- Test: `test/pipeline.test.mjs` (extend)

`activity` and `oembed` routes: read the Post cache (same `getPost` as media — it's a cache read, cold-miss re-fetches once), map via `toMastodonStatus`/`toOEmbed`, return `Response.json(...)` with `content-type: application/json`. Count `ok`/`fetch_fail`. Class-agnostic (Discord calls these with its own UA; the mapping is identical regardless). A missing post → an empty-but-valid Mastodon error shape or a 404 — decide and test.

- [ ] Steps: failing test (invoke `handle()` with `/api/v1/statuses/{enc}` and an injected fetchPost → JSON body with 4 media_attachments; a throwing fetchPost → graceful, not 500; the oembed route → rich JSON), implement, test, commit.

---

### Task 7: Deploy to staging + verify in REAL Discord clients

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] Deploy: `npm run deploy`. Confirm `megapenispoopenfarten.sex` untouched.
- [ ] `curl -A Discordbot` the fixture post → HTML has the activity+json link, zero og:image, minimal og fallback.
- [ ] `curl {origin}/api/v1/statuses/{encodedRefKey}` → `application/json`, a Mastodon Status with `media_attachments`.
- [ ] **THE GATE:** paste a Bluesky post *with multiple images* into real Discord clients — **desktop AND Android AND iOS**. Confirm all images render, text is formatted, and a quote (if present) shows. The developer embed debugger does NOT render this faithfully — use real clients. iOS multi-image is the known risk; if it shows one image on iOS, that's a documented platform limit, not a bug.
- [ ] Changelog + commit.

---

## Phase 2 Exit Criteria

- [ ] `npm test` passes; `npm run typecheck` clean.
- [ ] A multi-image Bluesky post shows ALL images in a Discord embed (desktop + Android).
- [ ] Formatted text, quote, and reply context render.
- [ ] The plain-og fallback still exists in the HTML (insurance if Discord changes the spoof).
- [ ] Telegram shows one image + the improved text, no hang.
- [ ] `megapenispoopenfarten.sex` untouched.

## Not in Phase 2 (deferred)

| Deferred | To | Why |
|---|---|---|
| Telegram Instant View (multi-image, threads) | later | Separate Telegram platform integration; masquerade-as-Medium is a large effort |
| Mosaic composite image service | later / never | Needs an external Rust service or CF Images; the spoof makes it unnecessary for Discord |
| TikTok, Instagram, Threads, X, Reddit | Phases 3-5 | Per the spec's build order |
