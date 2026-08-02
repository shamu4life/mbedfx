# fxeverything Phase 1 — Skeleton + Bluesky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full request pipeline end to end and prove it by rendering a real Bluesky post as a correct Discord embed on a staging domain.

**Architecture:** One stateless Cloudflare Worker. A request is classified by User-Agent, routed by path to a `Route` union, served from a two-layer Cache API, fetched and normalized into a common `Post` shape by a per-platform module, then rendered to markup by a shared renderer. Bluesky is the only platform in this phase because it is the only non-adversarial one — if something fails here it is our bug, not a platform fighting us.

**Tech Stack:** TypeScript, Cloudflare Workers, `wrangler`, `node --test` (Node ≥24 strips types natively — verified on v26.3.1, no loader or flag needed). No runtime dependencies, no framework, no build config, no containers.

**Spec:** `docs/superpowers/specs/2026-07-16-fxeverything-design.md`

## Global Constraints

- **Zero runtime dependencies.** devDependencies are exactly `typescript`, `wrangler`, `@cloudflare/workers-types`. No Hono, no framework.
- **Worker name = repo name = `fxeverything`.**
- **Never guess an ambiguous path.** Ambiguity resolves to `{kind:'ambiguous'}`, never to a platform.
- **Assert on content, never on status code.**
- **Log nothing identifying.** No URLs, no post IDs, no IPs. Counters only.
- **Never proxy media bytes.** `/_media/*` reads the Post cache and 302s.
- **Never `Vary: User-Agent`.** Client class goes in the cache key.
- **Cache keys derive from `refKey(ref)`, never the raw path.**
- **Renderers emit `/_media/{refKey}/{index}` URLs, never raw CDN URLs** — including avatars.
- **Origin is always derived from the request URL, never hardcoded.** A hardcoded production origin would make staging embeds point Discord's media proxy at the live prod worker.
- **Do not touch `megapenispoopenfarten.sex`.** It serves the live `fxtiktok` worker. Phase 1 is staging-only.
- **Pure core:** normalizers and renderers do no I/O.
- **Commit identity is pinned** to `Shamu4Life`. Never pass `-c`, `--author`, or set `user.email`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `wrangler.jsonc`, `.gitignore` | scaffold |
| `public/{index.html,robots.txt,favicon.ico}` | site assets (all three must exist) |
| `src/types.ts` | `Platform`, `PostRef`, `Post`, `Media`, `Route`, `Outcome`, `ClientClass` |
| `src/refkey.ts` | `refKey` / `parseRefKey` — cache + media-URL identity |
| `src/classify.ts` | UA → `ClientClass` |
| `src/router.ts` | path → `Route` |
| `src/cache.ts` | two-layer Cache API keys + Post serialization |
| `src/media.ts` | media selection |
| `src/analytics.ts` | counters, no identifiers |
| `src/platforms/bluesky/{fetch,normalize}.ts` | AT Protocol I/O + pure normalize |
| `src/render/{fail,discord,chooser,index}.ts` | shared render layer |
| `src/worker.ts` | entry point |
| `test/*.test.mjs` | `node --test` |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `.gitignore`
- Create: `public/index.html`, `public/robots.txt`, `public/favicon.ico`
- Create: `src/worker.ts`
- Test: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a deployable Worker; `npm test` and `npm run typecheck` run.

- [ ] **Step 1: Write the failing test**

`test/smoke.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

test('zero runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(pkg.dependencies, undefined, 'must have zero runtime deps')
  // workers-types is types-only (erased at build); it is not a runtime dep.
  assert.deepEqual(
    Object.keys(pkg.devDependencies).sort(),
    ['@cloudflare/workers-types', 'typescript', 'wrangler'],
  )
})

test('worker name matches repo name', () => {
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  assert.equal(cfg.name, 'fxeverything')
})

test('does not route the prod apex or wildcard — only a staging subdomain', () => {
  // The prod apex and *.megapenispoopenfarten.sex/* wildcard serve the live fxtiktok
  // worker and must not be claimed until the Phase 3 cutover. A specific `staging.`
  // subdomain custom domain is allowed. Exact check, not a substring blacklist —
  // staging is itself a subdomain of the prod domain.
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  const patterns = (cfg.routes ?? []).map(r => r.pattern)
  for (const p of patterns) {
    assert.notEqual(p, 'megapenispoopenfarten.sex', 'must not claim the prod apex')
    assert.ok(!p.startsWith('*.megapenispoopenfarten.sex'), 'must not claim the prod wildcard')
    assert.ok(!p.includes('*'), 'staging must be a specific hostname, never a wildcard')
  }
})

test('all allowlisted site assets exist', () => {
  // not_found_handling: "none" makes a missing file a hard 404, not a fallback.
  for (const f of ['public/index.html', 'public/robots.txt', 'public/favicon.ico']) {
    assert.ok(existsSync(f), `${f} must exist`)
  }
})

test('robots.txt disallows everything', () => {
  const r = readFileSync('public/robots.txt', 'utf8')
  assert.match(r, /User-agent:\s*\*/i)
  assert.match(r, /Disallow:\s*\//)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — ENOENT on `package.json`.

- [ ] **Step 3: Write minimal implementation**

`package.json`:
```json
{
  "name": "fxeverything",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "node --test"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5",
    "typescript": "^5",
    "wrangler": "^4"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts"]
}
```

`wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "fxeverything",
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-01",
  "observability": { "enabled": true },
  "workers_dev": false,
  // STAGING ONLY. megapenispoopenfarten.sex serves the live fxtiktok worker and is
  // not touched until the Phase 3 cutover checklist passes.
  "routes": [
    { "pattern": "staging.megapenispoopenfarten.sex", "custom_domain": true }
  ],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": true,
    "not_found_handling": "none"
  },
  "analytics_engine_datasets": [
    { "binding": "AE", "dataset": "fxeverything_counters" }
  ]
}
```

`.gitignore`:
```
node_modules/
.wrangler/
dist/
.dev.vars
```

`public/robots.txt`:
```
User-agent: *
Disallow: /
```

`public/index.html`:
```html
<!doctype html>
<meta charset="utf-8">
<title>fxeverything</title>
<p>Placeholder. The converter lands in Phase 5.</p>
```

`src/worker.ts` (stub, replaced entirely in Task 10):
```ts
export default {
  async fetch(): Promise<Response> {
    return new Response('fxeverything: phase 1 scaffold\n')
  },
}
```

Create the favicon (any valid .ico; a 1×1 is fine):
```bash
printf '\x00\x00\x01\x00\x01\x00\x01\x01\x00\x00\x01\x00\x18\x00\x30\x00\x00\x00\x16\x00\x00\x00\x28\x00\x00\x00\x01\x00\x00\x00\x02\x00\x00\x00\x01\x00\x18\x00\x00\x00\x00\x00\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00' > public/favicon.ico
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && npm test && npm run typecheck`
Expected: PASS — 5 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json wrangler.jsonc .gitignore public/ src/worker.ts test/smoke.test.mjs
git commit -m "feat: scaffold fxeverything worker

TypeScript, zero runtime deps, staging-only route. A test asserts the config
never routes megapenispoopenfarten.sex, which still serves live fxtiktok.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Types

**Files:**
- Create: `src/types.ts`
- Test: `test/types.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `Platform`, `PostRef`, `Media`, `Post`, `ClientClass`, `Route`, `Outcome`.

- [ ] **Step 1: Write the failing test**

Types erase at runtime, so this asserts on source text — legitimate here precisely because there is no runtime artifact. (Behavioural code is tested behaviourally; see Tasks 3-10.)

`test/types.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/types.ts', 'utf8')

test('Platform covers exactly the six day-one platforms', () => {
  const m = src.match(/export type Platform =([^\n]+)/)
  assert.ok(m, 'Platform type must exist')
  assert.deepEqual([...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort(),
    ['bs', 'ig', 'rd', 'th', 'tt', 'x'])
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/types.test.mjs`
Expected: FAIL — ENOENT `src/types.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/types.ts`:
```ts
export type Platform = 'x' | 'tt' | 'ig' | 'th' | 'rd' | 'bs'

/**
 * Per-platform identity. Carries every field needed to both fetch the post and
 * rebuild its canonical URL. A bare {platform, id} cannot express Bluesky
 * (handle + rkey) or Instagram stories (user + id).
 *
 * Note `bs.handle` may be a DID (`did:plc:…`), which contains colons — see refkey.ts.
 */
export type PostRef =
  | { p: 'x'; id: string }
  | { p: 'tt'; id: string }
  | { p: 'ig'; kind: 'p' | 'reel' | 'tv'; code: string }
  | { p: 'ig'; kind: 'story'; user: string; id: string }
  | { p: 'th'; code: string }
  | { p: 'rd'; sub: string; id: string }
  | { p: 'bs'; handle: string; rkey: string }

export type Media = {
  kind: 'image' | 'video' | 'gif'
  /**
   * Origin CDN URL as of this Post's fetch. May be signed and expiring; staleness
   * is bounded by the Post cache TTL plus the /_media/ 302's max-age.
   * Never emitted to a client — always via /_media/{refKey}/{index}.
   */
  url: string
  w: number
  h: number
  duration?: number
  alt?: string
}

export type Post = {
  /** Identity AND platform. Use ref.p; there is deliberately no `platform` field. */
  ref: PostRef
  canonical: string
  author: {
    name: string
    handle: string
    url: string
    /** Same staleness bound as Media.url. Renderers MUST emit /_media/{refKey}/avatar. */
    avatar?: string
  }
  text: string
  createdAt: Date
  media: Media[]
  counts: { likes?: number; reposts?: number; replies?: number; views?: number }
  /** Depth-limited to exactly 1: post.quote.quote is always undefined. */
  quote?: Post
  /** Depth-limited to exactly 1: post.replyTo.replyTo is always undefined. */
  replyTo?: Post
  sensitive: boolean
}

export type ClientClass = 'discord' | 'telegram' | 'other-bot' | 'human'

export type Route =
  | { kind: 'site'; path: string }
  | { kind: 'media'; ref: PostRef; index: number | 'avatar' }
  | { kind: 'post'; ref: PostRef; canonical: string }
  | { kind: 'ambiguous'; path: string; candidates: Platform[] }
  | { kind: 'notfound' }

export type Outcome =
  | { kind: 'post'; post: Post }
  | { kind: 'ambiguous'; path: string; candidates: Platform[] }
  | { kind: 'failure'; canonical: string | null; platform: Platform | null; reason: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/types.test.mjs && npm run typecheck`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types.test.mjs
git commit -m "feat: core types — Post, PostRef, Route, Outcome

Post has no separate platform field: identity lives in ref.p only, so the
two cannot disagree.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: refKey

**Files:**
- Create: `src/refkey.ts`
- Test: `test/refkey.test.mjs`

**Interfaces:**
- Consumes: `PostRef`.
- Produces: `refKey(ref: PostRef): string`, `parseRefKey(key: string): PostRef | null`. Exact inverses.

**Critical:** Bluesky permalinks accept a **DID** in the handle position, and DIDs contain colons — verified live: `at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l`. A naive `split(':')` breaks on these, and refKey is interpolated into a URL path, so components must also be path-safe. Every component is therefore `encodeURIComponent`-ed.

- [ ] **Step 1: Write the failing test**

`test/refkey.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refKey, parseRefKey } from '../src/refkey.ts'

test('refKey is deterministic and platform-prefixed', () => {
  assert.equal(refKey({ p: 'x', id: '123' }), 'x:123')
  assert.equal(refKey({ p: 'tt', id: '7660566211100511518' }), 'tt:7660566211100511518')
  assert.equal(refKey({ p: 'ig', kind: 'p', code: 'BsOGulcndj-' }), 'ig:p:BsOGulcndj-')
  assert.equal(refKey({ p: 'th', code: 'DTI1vjIEi5y' }), 'th:DTI1vjIEi5y')
  assert.equal(refKey({ p: 'rd', sub: 'aww', id: 'abc123' }), 'rd:aww:abc123')
  assert.equal(refKey({ p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }), 'bs:alice.bsky.social:3k2a')
})

test('DID handles round-trip — DIDs contain colons, which is the delimiter', () => {
  // Verified live: at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6oveex3ii2l' }
  const key = refKey(ref)
  assert.ok(!key.includes('did:plc:'), 'raw colons would make parseRefKey ambiguous')
  assert.deepEqual(parseRefKey(key), ref)
})

test('refKey is path-safe — it is interpolated into /_media/{refKey}/{i}', () => {
  const ref = { p: 'bs', handle: 'weird/handle with spaces', rkey: 'a?b#c' }
  const key = refKey(ref)
  assert.ok(!/[/?#\s]/.test(key), `must not contain path-breaking chars: ${key}`)
  assert.deepEqual(parseRefKey(key), ref)
})

test('parseRefKey round-trips every ref shape', () => {
  const refs = [
    { p: 'x', id: '123' },
    { p: 'tt', id: '7660566211100511518' },
    { p: 'ig', kind: 'p', code: 'BsOGulcndj-' },
    { p: 'ig', kind: 'story', user: 'someuser', id: '987' },
    { p: 'th', code: 'DTI1vjIEi5y' },
    { p: 'rd', sub: 'aww', id: 'abc123' },
    { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' },
  ]
  for (const r of refs) assert.deepEqual(parseRefKey(refKey(r)), r)
})

test('parseRefKey rejects junk rather than guessing', () => {
  for (const junk of ['', 'nope', 'zz:123', 'x', 'x:', 'bs:onlyhandle', 'ig:badkind:x', 'x:1:2']) {
    assert.equal(parseRefKey(junk), null, `${junk} must not parse`)
  }
})

test('parseRefKey returns null (never throws) on malformed percent-encoding', () => {
  // The router passes the RAW, undecoded URL path segment straight to parseRefKey,
  // so attacker-influenced bytes reach it directly. decodeURIComponent throws
  // URIError on malformed escapes — that must be caught and turned into a null
  // (→ 404), never allowed to propagate (→ 500).
  for (const bad of [
    'x:100%', // valid tag, malformed escape (lone '%')
    'bs:did%3Aplc%3Aabc:%ZZ', // valid tag, valid first component, malformed second
    'ig:p:%E0%A4%A', // truncated multi-byte escape
  ]) {
    assert.doesNotThrow(() => parseRefKey(bad), `${bad} must not throw`)
    assert.equal(parseRefKey(bad), null, `${bad} must not parse`)
  }
})

test('refKey ignores fields that are not identity', () => {
  // Two refs for the same post must key identically regardless of how they were
  // built. (Asserting refKey(X) === refKey(X) on identical literals would only
  // test that === is reflexive.)
  const a = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }
  const b = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a', extra: 'ignored' }
  assert.equal(refKey(a), refKey(b))
})

test('different posts never collide, even when components concatenate alike', () => {
  // Without per-component encoding, {sub:'a:b', id:'c'} and {sub:'a', id:'b:c'}
  // would both flatten to 'rd:a:b:c'.
  assert.notEqual(
    refKey({ p: 'rd', sub: 'a:b', id: 'c' }),
    refKey({ p: 'rd', sub: 'a', id: 'b:c' }),
  )
  assert.deepEqual(parseRefKey(refKey({ p: 'rd', sub: 'a:b', id: 'c' })), { p: 'rd', sub: 'a:b', id: 'c' })
  assert.deepEqual(parseRefKey(refKey({ p: 'rd', sub: 'a', id: 'b:c' })), { p: 'rd', sub: 'a', id: 'b:c' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/refkey.test.mjs`
Expected: FAIL — cannot find `../src/refkey.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/refkey.ts`:
```ts
import type { PostRef } from './types.ts'

// Every component is percent-encoded before joining. Two reasons:
//   1. Bluesky handles may be DIDs (did:plc:…), which contain the ':' delimiter.
//   2. refKey is interpolated into /_media/{refKey}/{index}, so it must be path-safe.
const enc = (s: string) => encodeURIComponent(s)
const dec = (s: string) => decodeURIComponent(s)

/**
 * The cache and media-URL identity for a post. Derived from the ref's own fields
 * in a fixed order — never from the request path — so /p/ABC and /ig/p/ABC share
 * one cache entry and tracking params cannot cause a miss.
 */
export function refKey(ref: PostRef): string {
  switch (ref.p) {
    case 'x':
    case 'tt':
      return `${ref.p}:${enc(ref.id)}`
    case 'ig':
      return ref.kind === 'story'
        ? `ig:story:${enc(ref.user)}:${enc(ref.id)}`
        : `ig:${ref.kind}:${enc(ref.code)}`
    case 'th':
      return `th:${enc(ref.code)}`
    case 'rd':
      return `rd:${enc(ref.sub)}:${enc(ref.id)}`
    case 'bs':
      return `bs:${enc(ref.handle)}:${enc(ref.rkey)}`
  }
}

/** Exact inverse of refKey. Returns null for anything malformed — never guesses. */
export function parseRefKey(key: string): PostRef | null {
  // decodeURIComponent (via dec) throws URIError on malformed percent-encoding
  // (e.g. a lone '%' or a truncated multi-byte escape). Since the raw, undecoded
  // request path reaches this function, that input is attacker-influenced and
  // must produce null (→ 404), never an uncaught exception (→ 500).
  try {
    const p = key.split(':')
    const ok = (i: number) => typeof p[i] === 'string' && p[i].length > 0
    switch (p[0]) {
      case 'x':
        return p.length === 2 && ok(1) ? { p: 'x', id: dec(p[1]) } : null
      case 'tt':
        return p.length === 2 && ok(1) ? { p: 'tt', id: dec(p[1]) } : null
      case 'th':
        return p.length === 2 && ok(1) ? { p: 'th', code: dec(p[1]) } : null
      case 'rd':
        return p.length === 3 && ok(1) && ok(2) ? { p: 'rd', sub: dec(p[1]), id: dec(p[2]) } : null
      case 'bs':
        return p.length === 3 && ok(1) && ok(2) ? { p: 'bs', handle: dec(p[1]), rkey: dec(p[2]) } : null
      case 'ig':
        if (p[1] === 'story') {
          return p.length === 4 && ok(2) && ok(3)
            ? { p: 'ig', kind: 'story', user: dec(p[2]), id: dec(p[3]) }
            : null
        }
        if (p[1] === 'p' || p[1] === 'reel' || p[1] === 'tv') {
          return p.length === 3 && ok(2) ? { p: 'ig', kind: p[1], code: dec(p[2]) } : null
        }
        return null
      default:
        return null
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/refkey.test.mjs && npm run typecheck`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/refkey.ts test/refkey.test.mjs
git commit -m "feat: refKey — cache and media-URL identity

Components are percent-encoded before joining: Bluesky handles may be DIDs
(did:plc:...) which contain the ':' delimiter, and refKey is interpolated
into a URL path so it must be path-safe.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client classifier

**Files:**
- Create: `src/classify.ts`
- Test: `test/classify.test.mjs`

**Interfaces:**
- Consumes: `ClientClass`.
- Produces: `classify(ua: string | null): ClientClass`.

- [ ] **Step 1: Write the failing test**

`test/classify.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/classify.ts'

test('recognises Discord and Telegram crawlers', () => {
  assert.equal(classify('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), 'discord')
  assert.equal(classify('TelegramBot (like TwitterBot)'), 'telegram')
})

test('matching is case-insensitive substring', () => {
  assert.equal(classify('DISCORDBOT/2.0'), 'discord')
  assert.equal(classify('telegrambot'), 'telegram')
})

test('recognises other bots', () => {
  for (const ua of ['facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'WhatsApp/2.19',
                    'SomeRandomCrawler/1.0', 'generic-spider', 'PreviewFetcher/2']) {
    assert.equal(classify(ua), 'other-bot', ua)
  }
})

test('real humans are humans', () => {
  assert.equal(classify('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'), 'human')
  assert.equal(classify('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'), 'human')
  assert.equal(classify(null), 'human')
  assert.equal(classify(''), 'human')
  assert.equal(classify('curl/8.4.0'), 'human')
})

test('Discord media-proxy UAs are NOT special-cased — a real Chrome 96 human stays human', () => {
  // Discord's media proxy sends a fake Firefox/38 UA. We do not detect it: it only
  // ever hits /_media/*, which behaves identically for every class. FxEmbed hardcodes
  // firefox/38|firefox/92|chrome/96.0.4664.110 — and chrome/96.0.4664.110 is a REAL
  // Chrome build, so that approach denies real people the redirect.
  assert.equal(classify('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:38.0) Gecko/20100101 Firefox/38.0'), 'human')
  assert.equal(classify('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'), 'human')
})

test('ordering: Discordbot wins even when the UA also looks generic', () => {
  assert.equal(classify('Discordbot/2.0 crawler'), 'discord')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/classify.test.mjs`
Expected: FAIL — cannot find `../src/classify.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/classify.ts`:
```ts
import type { ClientClass } from './types.ts'

const GENERIC_BOT = /bot|crawler|spider|preview/

/**
 * Lowercased substring match, ordered, first match wins.
 *
 * There is deliberately no `discord-media` class. Discord's media proxy sends a
 * fake browser UA (Firefox/38), but it only ever fetches /_media/* URLs, which
 * behave identically for every client class. Detecting it would require matching
 * chrome/96.0.4664.110 — a real Chrome build — and denying real people the redirect.
 */
export function classify(ua: string | null): ClientClass {
  if (!ua) return 'human'
  const s = ua.toLowerCase()
  if (s.includes('discordbot')) return 'discord'
  if (s.includes('telegrambot')) return 'telegram'
  if (
    s.includes('facebookexternalhit') ||
    s.includes('slackbot') ||
    s.includes('whatsapp') ||
    GENERIC_BOT.test(s)
  ) {
    return 'other-bot'
  }
  return 'human'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/classify.test.mjs && npm run typecheck`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.mjs
git commit -m "feat: client classifier

No discord-media class by design: the media proxy only hits /_media/*, which
is class-agnostic. Matching chrome/96.0.4664.110 like FxEmbed does would
misclassify real humans as bots.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Router

**Files:**
- Create: `src/router.ts`
- Test: `test/router.test.mjs`

**Interfaces:**
- Consumes: `Route`, `PostRef`, `Platform`; `parseRefKey`.
- Produces: `route(url: URL): Route`.

- [ ] **Step 1: Write the failing test**

`test/router.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../src/router.ts'
import { refKey } from '../src/refkey.ts'

const r = (p) => route(new URL(`https://staging.megapenispoopenfarten.sex${p}`))

test('site paths are allowlisted explicitly', () => {
  for (const p of ['/', '/index.html', '/favicon.ico', '/robots.txt']) {
    assert.equal(r(p).kind, 'site', `${p} must be a site path`)
  }
})

test('root replacement works for Bluesky permalinks', () => {
  assert.deepEqual(r('/profile/alice.bsky.social/post/3k2a'), {
    kind: 'post',
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  })
})

test('DID-form Bluesky permalinks route', () => {
  const got = r('/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6o')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' })
})

test('the /bs/ escape hatch forces Bluesky', () => {
  assert.deepEqual(r('/bs/profile/alice.bsky.social/post/3k2a'), {
    kind: 'post',
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  })
})

test('a real handle that collides with an escape token (x.com/x/status/…) still routes as a post', () => {
  // @x is X Corp's own live account. The /x/ escape hatch must try forcing X first,
  // find no post there (['status','123'] is depth 2, below x()'s depth-3 floor), and
  // fall through to the unforced interpretation — not dead-end into notfound.
  assert.deepEqual(r('/x/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/x/status/123',
  })
})

test('the explicit /x/x/status/… escape form still resolves after the fallthrough fix', () => {
  // Same collision as above, but spelled with the escape hatch AND the handle both
  // present. Must still resolve to the same canonical post, proving the forced match
  // is still tried (and still wins) before any fallthrough happens.
  assert.deepEqual(r('/x/x/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/x/status/123',
  })
})

test('media routes carry the full ref via refKey — including DIDs', () => {
  // The wire format is encodeURIComponent(refKey(ref)) — the renderer's mediaUrl()
  // helper builds it this way (see src/render/discord.ts), so the test must too.
  // A bare refKey(ref) here (raw ':' delimiters) would NOT round-trip for a DID:
  // the router's single outer decodeURIComponent would also unwrap the DID's own
  // per-component '%3A', over-splitting it into too many parts.
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3l6o' }
  assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/0`), { kind: 'media', ref, index: 0 })
  assert.deepEqual(r(`/_media/${encodeURIComponent(refKey(ref))}/avatar`), { kind: 'media', ref, index: 'avatar' })
})

test('media URL survives the full renderer→router round-trip, including a DID handle', () => {
  // This is the exact wire format src/render/discord.ts's mediaUrl() emits:
  // `${origin}/_media/${encodeURIComponent(refKey(p.ref))}/${i}`. Building the URL
  // the same way the renderer does, then routing it, proves the two encoding
  // layers (refKey's per-component encode + the renderer's whole-key encode) and
  // the router's two decoding layers (outer decodeURIComponent + parseRefKey's
  // per-component decode) actually invert each other end to end.
  const ref = { p: 'bs', handle: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: 'k' }
  const origin = 'https://staging.megapenispoopenfarten.sex'
  const mediaUrl = `${origin}/_media/${encodeURIComponent(refKey(ref))}/0`
  const got = route(new URL(mediaUrl))
  assert.deepEqual(got, { kind: 'media', ref, index: 0 })
})

test('a media URL whose colons were percent-normalized to %3A by an edge/proxy still resolves', () => {
  // This is the actual point of the I-2 fix: colons are legal, undecoded, in a URL
  // path segment (RFC 3986), but Discord's media proxy or any edge in front of it
  // is free to normalize them to %3A. Simulate that by taking the RAW refKey (with
  // its literal ':' join delimiters) and replacing every ':' with '%3A' — as if an
  // edge had "helpfully" percent-encoded them after the renderer emitted them raw.
  // The router's single outer decodeURIComponent must undo exactly this.
  const ref = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }
  const rawKey = refKey(ref) // 'bs:alice.bsky.social:3k2a' — literal colons
  const proxied = rawKey.replace(/:/g, '%3A') // simulates edge normalization
  assert.deepEqual(r(`/_media/${proxied}/0`), { kind: 'media', ref, index: 0 })
})

test('AMBIGUOUS PATHS ARE NEVER GUESSED', () => {
  const cases = [
    ['/mrbeast', ['x', 'ig']],
    ['/hashtag/nfl', ['x', 'bs']],
    ['/jack/followers', ['x', 'ig']],
    ['/zuck/following', ['x', 'ig']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/explore', ['x', 'ig', 'tt']],
    ['/messages', ['x', 'bs', 'rd']],
    ['/notifications', ['x', 'bs', 'rd']],
    ['/settings', ['x', 'bs', 'rd']],
    ['/settings/account', ['x', 'bs', 'rd']],
    ['/i/lists', ['x', 'ig']],
    ['/i/bookmarks', ['x', 'ig']],
    ['/gallery/abc123', ['rd', 'ig']],
  ]
  for (const [path, candidates] of cases) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', `${path} must be ambiguous, got ${got.kind}`)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
})

test('/i/status/{id} is X, not ambiguous — Instagram 404s at depth 3', () => {
  // @i IS a live Instagram account, but IG cannot shadow depth-3 paths.
  const got = r('/i/status/123')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'x', id: '123' })
})

test('/comments/{id} is Reddit — @comments is NOT a live IG account (verified 2026-07-17)', () => {
  const got = r('/comments/abc123')
  assert.equal(got.kind, 'notfound', 'Reddit post shapes land in Phase 5, but it must not be ambiguous')
})

test('unknown paths are notfound, never a guess', () => {
  assert.equal(r('/totally/unknown/deep/path').kind, 'notfound')
  assert.equal(r('/_media/garbage/0').kind, 'notfound')
  assert.equal(r('/_media/bs:alice:3k2a/notanindex').kind, 'notfound')
  assert.equal(r('/_alt/0').kind, 'notfound')
})

test('malformed percent-escapes are notfound, not a 500', () => {
  // decodeURIComponent throws URIError on these; unhandled, they are a trivially
  // reachable crash.
  for (const p of ['/%ZZ', '/%E0%A4%A', '/profile/%/post/x', '/_media/%ZZ/0']) {
    assert.doesNotThrow(() => r(p), `${p} must not throw`)
    assert.equal(r(p).kind, 'notfound', p)
  }
})

test('query params are ignored for identity', () => {
  const a = route(new URL('https://h.test/profile/alice.bsky.social/post/3k2a'))
  const b = route(new URL('https://h.test/profile/alice.bsky.social/post/3k2a?igshid=xyz&utm_source=q'))
  assert.deepEqual(a, b)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/router.test.mjs`
Expected: FAIL — cannot find `../src/router.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/router.ts`:
```ts
import type { Platform, PostRef, Route } from './types.ts'
import { parseRefKey } from './refkey.ts'

const SITE_PATHS = new Set(['/', '/index.html', '/favicon.ico', '/robots.txt'])

/**
 * Root tokens we claim as escape hatches (e.g. /x/status/123 forces the X interpretation).
 * A real handle can equal one of these tokens (x.com/x/status/123 is X Corp's own account),
 * so the escape hatch is tried FIRST but is not final: if forcing the token as a platform
 * yields no match, `route()` falls through to the normal unforced interpretation instead of
 * dead-ending. This shadows bare profiles under these names (no profile Route kind exists, so
 * that costs nothing) without ever shadowing a real post permalink.
 */
const ESCAPE: Record<string, Platform> = { x: 'x', tt: 'tt', ig: 'ig', th: 'th', rd: 'rd', bs: 'bs' }

/**
 * Genuinely undecidable paths. We never guess: a guess serves the wrong post and
 * nobody notices, which is the one failure mode we cannot debug.
 */
function ambiguity(seg: string[]): Platform[] | null {
  const [a, b] = seg
  if (a === 'settings') return ['x', 'bs', 'rd'] // /settings and /settings/*
  if (seg.length === 1) {
    if (a === 'search') return ['x', 'tt', 'bs', 'rd']
    if (a === 'explore') return ['x', 'ig', 'tt']
    if (a === 'messages') return ['x', 'bs', 'rd']
    if (a === 'notifications') return ['x', 'bs', 'rd']
    return ['x', 'ig'] // bare /{username}: X and Instagram both mint these
  }
  if (seg.length === 2) {
    if (a === 'hashtag') return ['x', 'bs']
    if (b === 'followers' || b === 'following') return ['x', 'ig']
    // @i is a live Instagram account and IG's depth-2 fallback renders its profile.
    if (a === 'i' && (b === 'lists' || b === 'bookmarks' || b === 'moments')) return ['x', 'ig']
    // @gallery is a live Instagram account, so Reddit's /gallery/{id} is contested.
    if (a === 'gallery') return ['rd', 'ig']
  }
  return null
}

function bluesky(seg: string[]): Route | null {
  // bsky.app/profile/{handle}/post/{rkey} — depth 4, unconditionally safe.
  if (seg.length === 4 && seg[0] === 'profile' && seg[2] === 'post' && seg[1] && seg[3]) {
    const ref: PostRef = { p: 'bs', handle: seg[1], rkey: seg[3] }
    return { kind: 'post', ref, canonical: `https://bsky.app/profile/${seg[1]}/post/${seg[3]}` }
  }
  return null
}

function x(seg: string[]): Route | null {
  // /i/web/status/{id} — check before the generic form, which would also match.
  if (seg.length === 4 && seg[0] === 'i' && seg[1] === 'web' && seg[2] === 'status' && seg[3]) {
    return { kind: 'post', ref: { p: 'x', id: seg[3] }, canonical: `https://x.com/i/web/status/${seg[3]}` }
  }
  // /{handle}/status/{id} and /i/status/{id} — depth 3+, safe by the depth rule.
  // Trailing /photo/N and /video/N are UI hints, not identity: same post, same ref.
  if (seg.length >= 3 && seg[1] === 'status' && seg[0] && seg[2]) {
    return { kind: 'post', ref: { p: 'x', id: seg[2] }, canonical: `https://x.com/${seg[0]}/status/${seg[2]}` }
  }
  return null
}

/** Phase 1 ships Bluesky and X's shape; the other platforms land in their own phases. */
function matchPost(seg: string[], forced?: Platform): Route | null {
  if (forced === 'bs') return bluesky(seg)
  if (forced === 'x') return x(seg)
  if (forced) return null
  return bluesky(seg) ?? x(seg)
}

/** decodeURIComponent throws URIError on malformed escapes (/%ZZ, /%E0%A4%A). */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

export function route(url: URL): Route {
  const path = url.pathname
  if (SITE_PATHS.has(path)) return { kind: 'site', path }

  const raw = path.split('/').filter(Boolean)
  if (raw.length === 0) return { kind: 'site', path: '/' }

  // /_media/{encodeURIComponent(refKey)}/{index} — TWO encode layers, TWO decode layers.
  //
  // refKey() percent-encodes each component before joining with ':'. The renderer
  // then encodeURIComponent()s the WHOLE key on top of that, so the key that hits
  // the wire never contains a bare ':' — nothing is left for an edge/proxy (e.g.
  // Discord's media proxy) to percent-normalize. Symmetrically, this route does the
  // outer decode ONCE (undoing the renderer's whole-key encode) before handing the
  // result to parseRefKey, which does the (only remaining) decode per component
  // after splitting on ':'. safeDecode never throws: a malformed segment (e.g.
  // /_media/%ZZ/0) becomes notfound, not a 500.
  //
  // This is decode-then-split-then-decode, inverting encode-then-join-then-encode —
  // symmetric by construction. It is also backward-compatible with a literal,
  // unencoded refKey segment (no '%' in it): decodeURIComponent is a no-op on a
  // string with no percent-escapes, so an un-encoded key still round-trips.
  if (raw[0] === '_media') {
    if (raw.length !== 3) return { kind: 'notfound' }
    const outerDecoded = safeDecode(raw[1])
    if (outerDecoded === null) return { kind: 'notfound' }
    const ref = parseRefKey(outerDecoded)
    if (!ref) return { kind: 'notfound' }
    if (raw[2] === 'avatar') return { kind: 'media', ref, index: 'avatar' }
    const i = Number(raw[2])
    if (!Number.isInteger(i) || i < 0) return { kind: 'notfound' }
    return { kind: 'media', ref, index: i }
  }

  // Platform paths carry ordinary URL-encoded segments, so they DO get decoded.
  const decoded = raw.map(safeDecode)
  if (decoded.some(s => s === null)) return { kind: 'notfound' } // malformed escape
  const seg = decoded as string[]

  // /_alt/0 — the twitter:image suppression target. Exists only to be a dead end.
  if (seg[0] === '_alt') return { kind: 'notfound' }

  const forced = ESCAPE[seg[0]]
  if (forced) {
    const forcedHit = matchPost(seg.slice(1), forced)
    if (forcedHit) return forcedHit
    // seg[0] may be a real handle rather than an escape token (e.g. x.com/x/status/…),
    // so fall through to the normal unforced interpretation instead of dead-ending.
  }

  const hit = matchPost(seg)
  if (hit) return hit

  // Reddit/IG/TikTok/Threads post shapes land in their own phases. Until then those
  // paths are notfound — honest — but must never be *guessed* into a platform.
  const known = new Set(['comments', 'p', 'reel', 'reels', 'tv', 'stories', 'r', 't'])
  if (known.has(seg[0])) return { kind: 'notfound' }

  const amb = ambiguity(seg)
  if (amb) return { kind: 'ambiguous', path, candidates: amb }

  return { kind: 'notfound' }
}
```

**Note on `/_media/{refKey}/…`:** there are **two** encoding layers, and two matching decode layers. `refKey` percent-encodes each component before joining with `:`. On top of that, the renderer's `mediaUrl()` helper (Task 7) `encodeURIComponent`s the **whole key**, so the value that actually reaches the wire never contains a bare `:` — there is nothing left for an edge or proxy (e.g. Discord's media proxy) to percent-normalize. The router reverses this once with `safeDecode(raw[1])` — undoing the renderer's whole-key encode — before handing the result to `parseRefKey`, which does the remaining per-component decode after splitting on `:`. This is `decode → split → decode`, the exact inverse of `encode(join(encode(component)))`, so it is symmetric by construction. It also stays backward-compatible with a literal, unencoded refKey segment (no `%` in it) — decodeURIComponent is a no-op on a string with no percent-escapes.

This design exists because colons are legal, undecoded, in a URL path segment (RFC 3986) — but not everything downstream is that faithful. Discord's media proxy, a CDN, or any edge in front of it is free to percent-normalize a bare `:` to `%3A`. Emitting the refKey raw (one encoding layer only, as this task originally shipped it) meant the media URL's correctness depended on every hop preserving a literal colon — a silent-total-failure mode if any one of them didn't. Wrapping the whole key in `encodeURIComponent` removes that dependency entirely: the wire format is `%3A` from the moment the renderer emits it, so there is no unstable bare colon for anything to normalize.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/router.test.mjs && npm run typecheck`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router.test.mjs
git commit -m "feat: router with explicit ambiguity table

Root replacement for permalinks; /x/ /bs/ as escape hatches. Ambiguous paths
resolve to {kind:'ambiguous'}, never a guess. /i/status/{id} routes to X
despite @i being a live IG account, because Instagram 404s at depth 3.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Bluesky fetch + normalize

**Files:**
- Create: `src/platforms/bluesky/fetch.ts`, `src/platforms/bluesky/normalize.ts`
- Test: `test/bluesky-normalize.test.mjs`, `test/fixtures/bluesky-post.json`

**Interfaces:**
- Consumes: `Post`, `PostRef`, `Media`.
- Produces: `fetchBluesky(ref): Promise<unknown>` (I/O), `normalizeBluesky(raw, ref): Post | null` (pure).

- [ ] **Step 1: Capture the fixture, then write the failing test**

```bash
mkdir -p test/fixtures
curl -s 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://bsky.app/app.bsky.feed.post/3l6oveex3ii2l&depth=0&parentHeight=1' \
  > test/fixtures/bluesky-post.json
python3 -c "
import json; d=json.load(open('test/fixtures/bluesky-post.json'))
p=d['thread']['post']; print('uri   :', p['uri']); print('author:', p['author']['handle']); print('text  :', p['record']['text'][:60])
"
```
Expected: `uri` is `at://did:plc:…/app.bsky.feed.post/3l6oveex3ii2l`, author `bsky.app`, non-empty text. If that post is gone, pick any live post, convert `bsky.app/profile/{h}/post/{rkey}` → `at://{h}/app.bsky.feed.post/{rkey}`, re-capture, and update the `rkey`/handle in the test below.

`test/bluesky-normalize.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeBluesky } from '../src/platforms/bluesky/normalize.ts'
import { refKey } from '../src/refkey.ts'

const raw = JSON.parse(readFileSync('test/fixtures/bluesky-post.json', 'utf8'))
const ref = { p: 'bs', handle: 'bsky.app', rkey: '3l6oveex3ii2l' }

/**
 * The live fixture has no embed and no parent, so quote/reply assertions against
 * it would run vacuously. This synthetic thread exercises both branches.
 */
const withQuoteAndParent = () => ({
  thread: {
    post: {
      uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
      author: { handle: 'root.bsky.social', displayName: 'Root' },
      record: { text: 'root post', createdAt: '2026-07-01T00:00:00Z' },
      embed: {
        record: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedkey',
          author: { handle: 'quoted.bsky.social', displayName: 'Quoted' },
          value: { text: 'quoted post', createdAt: '2026-06-01T00:00:00Z' },
        },
      },
    },
    parent: {
      post: {
        uri: 'at://did:plc:parent/app.bsky.feed.post/parentkey',
        author: { handle: 'parent.bsky.social', displayName: 'Parent' },
        record: { text: 'parent post', createdAt: '2026-05-01T00:00:00Z' },
      },
    },
  },
})

test('normalize is pure and produces a well-formed Post', () => {
  const post = normalizeBluesky(raw, ref)
  assert.ok(post, 'must normalize')
  assert.deepEqual(post.ref, ref, 'the root post keeps the ref the router produced')
  assert.equal(typeof post.text, 'string')
  assert.ok(post.text.length > 0, 'text must be present')
  assert.ok(post.author.handle.length > 0)
  assert.ok(post.createdAt instanceof Date)
  assert.ok(!Number.isNaN(post.createdAt.getTime()), 'createdAt must be a valid Date')
  assert.ok(Array.isArray(post.media))
  assert.equal(typeof post.sensitive, 'boolean')
})

test('canonical is rebuilt from the ref, so it matches the URL the user had', () => {
  const post = normalizeBluesky(raw, ref)
  assert.equal(post.canonical, 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l')
})

test('counts are numbers when present', () => {
  const post = normalizeBluesky(raw, ref)
  for (const k of ['likes', 'reposts', 'replies']) {
    if (post.counts[k] !== undefined) assert.equal(typeof post.counts[k], 'number')
  }
})

test('QUOTE AND REPLY GET THEIR OWN REF, NOT THE ROOT POST\'S', () => {
  // If a quote inherited the root's ref, refKey(quote.ref) === refKey(post.ref)
  // and /_media/{refKey}/{i} for the quote would resolve against the ROOT post's
  // media[] — serving the wrong image. This is exactly what PostRef exists to prevent.
  const post = normalizeBluesky(withQuoteAndParent(), ref)
  assert.ok(post.quote, 'quote must be present')
  assert.notEqual(refKey(post.quote.ref), refKey(post.ref), 'quote must NOT share the root ref')
  assert.deepEqual(post.quote.ref, { p: 'bs', handle: 'quoted.bsky.social', rkey: 'quotedkey' })
  assert.ok(post.replyTo, 'replyTo must be present')
  assert.deepEqual(post.replyTo.ref, { p: 'bs', handle: 'parent.bsky.social', rkey: 'parentkey' })
})

test('quote and reply depth is capped at exactly 1', () => {
  // Built from the synthetic fixture, not the live one: the live post has no embed
  // and no parent, so `if (post.quote)` guards would make this test run zero
  // assertions and pass vacuously.
  const post = normalizeBluesky(withQuoteAndParent(), ref)
  assert.ok(post.quote && post.replyTo, 'fixture must exercise both branches')
  assert.equal(post.quote.quote, undefined)
  assert.equal(post.quote.replyTo, undefined)
  assert.equal(post.replyTo.replyTo, undefined)
  assert.equal(post.replyTo.quote, undefined)
})

test('media extraction: images and video are pulled out of the embed', () => {
  // The live fixture has media: [], so without this the code behind every
  // og:image is never exercised.
  const withImages = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social', displayName: 'Root' },
        record: { text: 'has media', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          images: [
            { fullsize: 'https://cdn.bsky.app/one.jpg', alt: 'first', aspectRatio: { width: 800, height: 600 } },
            { fullsize: 'https://cdn.bsky.app/two.jpg', aspectRatio: { width: 400, height: 400 } },
            { notfullsize: 'skip me' },
          ],
        },
      },
    },
  }
  const p = normalizeBluesky(withImages, ref)
  assert.equal(p.media.length, 2, 'entries without fullsize are skipped, not emitted as undefined')
  assert.deepEqual(p.media[0], { kind: 'image', url: 'https://cdn.bsky.app/one.jpg', w: 800, h: 600, alt: 'first' })
  assert.equal(p.media[1].alt, undefined, 'missing alt must be undefined, not empty string')

  const withVideo = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'has video', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          video: {
            playlist: 'https://cdn.bsky.app/v.m3u8',
            thumbnail: 'https://cdn.bsky.app/v-thumb.jpg',
            aspectRatio: { width: 1280, height: 720 },
          },
        },
      },
    },
  }
  const v = normalizeBluesky(withVideo, ref)
  // Discord cannot play HLS (.m3u8): the video becomes its still thumbnail, emitted
  // as a plain IMAGE Media entry, never a 'video' entry pointing at the manifest.
  assert.deepEqual(v.media, [{ kind: 'image', url: 'https://cdn.bsky.app/v-thumb.jpg', w: 1280, h: 720 }])
  assert.ok(!v.media.some(m => m.url.includes('.m3u8')), 'the unplayable HLS playlist must never be surfaced as media')
})

test('missing aspectRatio degrades to 0x0 rather than throwing', () => {
  const noAr = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'x', createdAt: '2026-07-01T00:00:00Z' },
        embed: { images: [{ fullsize: 'https://cdn.bsky.app/a.jpg' }] },
      },
    },
  }
  const p = normalizeBluesky(noAr, ref)
  assert.equal(p.media[0].w, 0)
  assert.equal(p.media[0].h, 0)
})

test('quote media: viewRecord embeds[] (plural, no singular embed) still yields images', () => {
  // Regression test for the "quote media always dropped" defect: viewRecord's
  // lexicon shape carries `embeds` (an array), never a singular `embed`. Reaching
  // into rec.embed (singular) is always undefined, so quote.media was always [].
  const withQuoteImage = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social', displayName: 'Root' },
        record: { text: 'root post', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          record: {
            uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedkey',
            author: { handle: 'quoted.bsky.social', displayName: 'Quoted' },
            value: { text: 'quoted post', createdAt: '2026-06-01T00:00:00Z' },
            embeds: [
              {
                images: [
                  { fullsize: 'https://cdn.bsky.app/quoted.jpg', alt: 'q', aspectRatio: { width: 500, height: 500 } },
                ],
              },
            ],
          },
        },
      },
    },
  }
  const post = normalizeBluesky(withQuoteImage, ref)
  assert.ok(post.quote, 'quote must be present')
  assert.equal(post.quote.media.length, 1, 'quote media must be extracted from viewRecord.embeds[]')
  assert.deepEqual(post.quote.media[0], {
    kind: 'image',
    url: 'https://cdn.bsky.app/quoted.jpg',
    w: 500,
    h: 500,
    alt: 'q',
  })
})

test('gallery#view embeds are extracted as images', () => {
  const withGallery = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'has gallery', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          items: [
            { thumbnail: 'https://cdn.bsky.app/thumb1.jpg', fullsize: 'https://cdn.bsky.app/g1.jpg', alt: 'one', aspectRatio: { width: 300, height: 200 } },
            { thumbnail: 'https://cdn.bsky.app/thumb2.jpg', fullsize: 'https://cdn.bsky.app/g2.jpg', aspectRatio: { width: 300, height: 200 } },
          ],
        },
      },
    },
  }
  const post = normalizeBluesky(withGallery, ref)
  assert.equal(post.media.length, 2, 'gallery#view items must be extracted, not dropped')
  assert.deepEqual(post.media[0], { kind: 'image', url: 'https://cdn.bsky.app/g1.jpg', w: 300, h: 200, alt: 'one' })
  assert.equal(post.media[1].alt, undefined)
})

test('sensitive reflects label VALUES, not mere presence of any label', () => {
  const withLabel = (val) => ({
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'labeled', createdAt: '2026-07-01T00:00:00Z' },
        labels: [{ val, src: 'did:plc:labeler', uri: 'at://did:plc:root/app.bsky.feed.post/rootkey' }],
      },
    },
  })

  const porn = normalizeBluesky(withLabel('porn'), ref)
  assert.equal(porn.sensitive, true, 'porn is in the content-warning vocabulary')

  const nudity = normalizeBluesky(withLabel('nudity'), ref)
  assert.equal(nudity.sensitive, true, 'nudity is in the content-warning vocabulary')

  const spam = normalizeBluesky(withLabel('spam'), ref)
  assert.equal(spam.sensitive, false, 'a benign third-party label must NOT mark the post sensitive')
})

test('video alt text is preserved, not dropped', () => {
  const withVideoAlt = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'has video', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          video: {
            playlist: 'https://cdn.bsky.app/v.m3u8',
            thumbnail: 'https://cdn.bsky.app/v-thumb.jpg',
            alt: 'a video of a cat',
            aspectRatio: { width: 1280, height: 720 },
          },
        },
      },
    },
  }
  const post = normalizeBluesky(withVideoAlt, ref)
  assert.deepEqual(post.media, [
    { kind: 'image', url: 'https://cdn.bsky.app/v-thumb.jpg', w: 1280, h: 720, alt: 'a video of a cat' },
  ])
})

test('Bluesky video (HLS, unplayable in Discord) becomes a thumbnail image, not an og:video', () => {
  // Phase-1-correct outcome: Discord's embed player cannot play an HLS .m3u8
  // manifest, so a video post must show its still thumbnail as a large image
  // rather than an og:video that renders blank. If there is no thumbnail either,
  // it must emit NO media for that item — never a broken video reference.
  const withThumb = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'video post', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          video: {
            playlist: 'https://cdn.bsky.app/v2.m3u8',
            thumbnail: 'https://cdn.bsky.app/v2-thumb.jpg',
            aspectRatio: { width: 640, height: 360 },
          },
        },
      },
    },
  }
  const withThumbPost = normalizeBluesky(withThumb, ref)
  assert.equal(withThumbPost.media.length, 1, 'a video with a thumbnail must yield exactly one media entry')
  assert.equal(withThumbPost.media[0].kind, 'image', 'must be an image entry, never an unplayable video entry')
  assert.equal(withThumbPost.media[0].url, 'https://cdn.bsky.app/v2-thumb.jpg')

  const noThumb = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social' },
        record: { text: 'video post, no thumbnail', createdAt: '2026-07-01T00:00:00Z' },
        embed: { video: { playlist: 'https://cdn.bsky.app/v3.m3u8', aspectRatio: { width: 640, height: 360 } } },
      },
    },
  }
  const noThumbPost = normalizeBluesky(noThumb, ref)
  assert.deepEqual(noThumbPost.media, [], 'no thumbnail must mean no media entry, never a broken video reference')
})

test('recordWithMedia#view: quote with gallery loses no images — fallback required', () => {
  // Regression test: a post that quotes another post AND attaches a gallery — via
  // recordWithMedia#view shape {record, media: {items:[...]} } — must not silently
  // drop the gallery's images. recordWithMedia#view.media accepts gallery#view,
  // so the e.items fallback must check e.media?.items.
  const withQuoteGallery = {
    thread: {
      post: {
        uri: 'at://did:plc:root/app.bsky.feed.post/rootkey',
        author: { handle: 'root.bsky.social', displayName: 'Root' },
        record: { text: 'root post with gallery quote', createdAt: '2026-07-01T00:00:00Z' },
        embed: {
          record: {
            uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedkey',
            author: { handle: 'quoted.bsky.social', displayName: 'Quoted' },
            value: { text: 'quoted post', createdAt: '2026-06-01T00:00:00Z' },
          },
          media: {
            items: [
              { thumbnail: 'https://cdn.bsky.app/thumb1.jpg', fullsize: 'https://cdn.bsky.app/g1.jpg', alt: 'first', aspectRatio: { width: 600, height: 400 } },
              { thumbnail: 'https://cdn.bsky.app/thumb2.jpg', fullsize: 'https://cdn.bsky.app/g2.jpg', alt: 'second', aspectRatio: { width: 600, height: 400 } },
            ],
          },
        },
      },
    },
  }
  const post = normalizeBluesky(withQuoteGallery, ref)
  assert.ok(post, 'root post must normalize')
  // The gallery is in the recordWithMedia's media field, not in embeds[] as a separate view
  assert.equal(post.media.length, 2, 'gallery in recordWithMedia#view.media must not be dropped')
  assert.deepEqual(post.media[0], { kind: 'image', url: 'https://cdn.bsky.app/g1.jpg', w: 600, h: 400, alt: 'first' })
  assert.deepEqual(post.media[1], { kind: 'image', url: 'https://cdn.bsky.app/g2.jpg', w: 600, h: 400, alt: 'second' })
})

test('returns null on junk rather than throwing or inventing a Post', () => {
  for (const junk of [null, {}, { thread: {} }, { thread: { post: { record: {} } } },
                      { thread: { post: { record: { text: 'x' }, author: {} } } }]) {
    assert.equal(normalizeBluesky(junk, ref), null, JSON.stringify(junk))
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bluesky-normalize.test.mjs`
Expected: FAIL — cannot find `normalize.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/platforms/bluesky/fetch.ts`:
```ts
import type { PostRef } from '../../types.ts'

const API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread'

/**
 * Bluesky's public AT Protocol: no auth, no anti-bot, no rate wall.
 * The only non-adversarial platform of the six.
 */
export async function fetchBluesky(ref: Extract<PostRef, { p: 'bs' }>): Promise<unknown> {
  const uri = `at://${ref.handle}/app.bsky.feed.post/${ref.rkey}`
  const url = `${API}?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=1`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) return null
  // Never JSON.parse an unvalidated body — platforms return HTML error pages with 200s.
  if (!(res.headers.get('content-type') || '').includes('json')) return null
  return res.json()
}
```

`src/platforms/bluesky/normalize.ts`:
```ts
import type { Media, Post, PostRef } from '../../types.ts'

type Any = Record<string, any>

// Bluesky's self-label content-warning vocabulary (the `val` values a labeler
// attaches via com.atproto.label.defs#label). Third-party labelers can apply
// arbitrary non-sensitive labels (spam, community moderation, etc.), so we key
// off these specific values rather than "any label is present".
const SENSITIVE_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media'])

/** at://{did-or-handle}/app.bsky.feed.post/{rkey} -> a ref of that post's own identity. */
function refFromUri(uri: unknown, fallbackHandle: string): Extract<PostRef, { p: 'bs' }> | null {
  if (typeof uri !== 'string') return null
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/)
  if (!m) return null
  return { p: 'bs', handle: fallbackHandle || m[1], rkey: m[2] }
}

/**
 * Builds a Media object, omitting `alt` entirely (never `alt: undefined`) when
 * there is no non-empty alt text — Media.alt is optional, and a Post is expected
 * to structurally match whether alt was absent from the source or merely blank.
 */
function mediaObj(kind: 'image' | 'video', url: string, w: number, h: number, rawAlt: unknown): Media {
  const alt = typeof rawAlt === 'string' && rawAlt ? rawAlt : undefined
  return alt === undefined ? { kind, url, w, h } : { kind, url, w, h, alt }
}

/** Pushes any `{fullsize, alt, aspectRatio}` entries (images[] or gallery#view items[]) as image Media. */
function pushImages(out: Media[], imgs: unknown): void {
  if (!Array.isArray(imgs)) return
  for (const im of imgs) {
    if (typeof im?.fullsize !== 'string') continue
    out.push(mediaObj('image', im.fullsize, im.aspectRatio?.width ?? 0, im.aspectRatio?.height ?? 0, im.alt))
  }
}

/**
 * `embed` is either a single view (postView.embed, viewRecord's outer embed) or an
 * array of views (viewRecord.embeds[] — the lexicon gives quoted posts a PLURAL
 * `embeds` array, unlike postView's singular `embed`). Both shapes parse the same way.
 */
function mediaFrom(embed: Any | Any[] | undefined): Media[] {
  if (!embed) return []
  const out: Media[] = []
  for (const e of Array.isArray(embed) ? embed : [embed]) {
    if (!e) continue
    pushImages(out, e.images ?? e.media?.images)
    // app.bsky.embed.gallery#view: { items: [{ thumbnail, fullsize, alt, aspectRatio }] }
    // recordWithMedia#view.media also carries gallery#view with items, so fallback needed here too
    pushImages(out, e.items ?? e.media?.items)
    // Bluesky video embeds carry `playlist`, an HLS (.m3u8) MANIFEST — not a
    // progressive file — which Discord's embed player cannot play. Emitting it as
    // og:video would render a blank/broken player with no fallback image at all
    // (the video branch suppresses og:image). Proper HLS support (transcode, or a
    // dedicated player page) is a Phase 2 concern. For Phase 1 we show something
    // true instead of something broken: the video's own still `thumbnail` becomes
    // a plain IMAGE Media entry, so the renderer's existing image path renders it
    // as a large picture. The playlist URL is intentionally never surfaced. If
    // there is no thumbnail either, we emit nothing for this item rather than a
    // broken video.
    const v = e.video ?? e.media?.video
    if (v && typeof v.thumbnail === 'string') {
      out.push(mediaObj('image', v.thumbnail, v.aspectRatio?.width ?? 0, v.aspectRatio?.height ?? 0, v.alt))
    }
  }
  return out
}

/**
 * Build a Post from an AT post object. `ref` is that post's OWN identity — never
 * the root's. A quote sharing the root's ref would make /_media/{refKey}/{i}
 * resolve against the root's media[], serving the wrong image.
 *
 * `embed` is passed in rather than read off `p.embed`, because the shape of "this
 * post's embed(s)" differs by caller: postView (root/parent) has singular `embed`,
 * but app.bsky.embed.record#viewRecord (quote) has a plural `embeds` array and no
 * singular `embed` at all. mediaFrom() accepts either shape.
 */
function build(p: Any, ref: Extract<PostRef, { p: 'bs' }>, record: Any, embed: Any | Any[] | undefined): Post | null {
  const author = p?.author
  if (!record || typeof record.text !== 'string' || !author?.handle) return null
  const created = new Date(record.createdAt ?? p.indexedAt ?? NaN)
  if (Number.isNaN(created.getTime())) return null
  return {
    ref,
    canonical: `https://bsky.app/profile/${ref.handle}/post/${ref.rkey}`,
    author: {
      name: author.displayName || author.handle,
      handle: author.handle,
      url: `https://bsky.app/profile/${author.handle}`,
      avatar: typeof author.avatar === 'string' ? author.avatar : undefined,
    },
    text: record.text,
    createdAt: created,
    media: mediaFrom(embed),
    counts: { likes: p.likeCount, reposts: p.repostCount, replies: p.replyCount },
    // Bluesky exposes moderation labels on the record; only specific label VALUES
    // mean sensitive — a third-party labeler's "spam" tag must not count.
    sensitive: Array.isArray(p.labels) && p.labels.some((l: Any) => SENSITIVE_LABELS.has(l?.val)),
  }
}

/**
 * Pure: raw AT Protocol JSON -> Post. No I/O. Returns null rather than inventing
 * a Post, because a half-built Post renders as a broken embed.
 * Quote and replyTo are capped at depth 1 — build() never recurses.
 */
export function normalizeBluesky(raw: unknown, ref: PostRef): Post | null {
  if (ref.p !== 'bs') return null
  const r = raw as Any
  const p = r?.thread?.post
  if (!p) return null

  const post = build(p, ref, p.record, p.embed)
  if (!post) return null

  const parent = r.thread?.parent?.post
  if (parent) {
    const pref = refFromUri(parent.uri, parent.author?.handle)
    if (pref) {
      const rp = build(parent, pref, parent.record, parent.embed)
      if (rp) post.replyTo = rp // depth 1: build() never sets replyTo/quote
    }
  }

  const rec = p.embed?.record?.record ?? p.embed?.record
  if (rec?.value?.text && rec?.author?.handle) {
    const qref = refFromUri(rec.uri, rec.author.handle)
    if (qref) {
      // viewRecord carries its media as `embeds` (plural array), not `embed`.
      const q = build(rec, qref, rec.value, rec.embeds)
      if (q) post.quote = q // depth 1
    }
  }

  return post
}
```

**Note on Bluesky video:** Bluesky's video embed carries `playlist`, an HLS (`.m3u8`) manifest, never a progressive file. Discord's embed player cannot play HLS, so surfacing it as `og:video` renders a blank/broken player — and worse, the video branch suppresses `og:image` entirely, so the post shows nothing at all. Proper HLS delivery (transcoding, or a dedicated player page) is deferred to Phase 2. For Phase 1, `mediaFrom()` represents a Bluesky video as an **image** Media entry pointing at the video's own `thumbnail` still, not a `video` entry pointing at the playlist — a still is strictly better than a blank player, and the renderer's existing "first image → og:image" path renders it with no renderer changes needed. If there is no thumbnail either, no media entry is emitted for that item, never a broken video reference. The real `playlist` URL is intentionally never surfaced.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bluesky-normalize.test.mjs && npm run typecheck`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/bluesky/ test/bluesky-normalize.test.mjs test/fixtures/bluesky-post.json
git commit -m "feat: Bluesky fetcher and normalizer

Quotes and replies get their OWN ref derived from their at:// uri, not the
root's — sharing a ref would make /_media/{refKey}/{i} resolve against the
root post's media and serve the wrong image.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Renderers

**Files:**
- Create: `src/render/fail.ts`, `src/render/discord.ts`, `src/render/chooser.ts`, `src/render/index.ts`
- Test: `test/render.test.mjs`

**Interfaces:**
- Consumes: `Post`, `Outcome`, `ClientClass`, `Platform`; `refKey`.
- Produces: `render(outcome: Outcome, client: ClientClass, origin: string): Response`.

**`origin` is a parameter, not a constant.** Hardcoding the production origin would make every staging embed point Discord's media proxy at the live prod worker.

- [ ] **Step 1: Write the failing test**

`test/render.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../src/render/index.ts'

const ORIGIN = 'https://staging.megapenispoopenfarten.sex'

const base = {
  ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
  canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
  author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social', avatar: 'https://cdn.bsky.app/avatar.jpg' },
  text: 'hello <world> & "friends"',
  createdAt: new Date('2026-07-01T12:00:00Z'),
  media: [
    { kind: 'image', url: 'https://cdn.bsky.app/a.jpg', w: 800, h: 600 },
    { kind: 'image', url: 'https://cdn.bsky.app/b.jpg', w: 800, h: 600 },
  ],
  counts: { likes: 5, reposts: 2, replies: 1 },
  sensitive: false,
}
const body = (r) => r.text()
const tagsOf = (html, prop) =>
  [...html.matchAll(new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'g'))].map(m => m[1])

test('humans are redirected to the original post, never rendered', () => {
  const r = render({ kind: 'post', post: base }, 'human', ORIGIN)
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), base.canonical)
})

test('media URLs use the REQUEST origin, never a hardcoded one', async () => {
  // Guard is "emitted origin equals the origin passed to render()", not a substring
  // blacklist — staging is a subdomain of the prod domain. Render with a foreign origin
  // and confirm every /_media/ URL carries THAT origin and no other.
  const FOREIGN = 'https://some-other-host.example'
  const html = await body(render({ kind: 'post', post: base }, 'discord', FOREIGN))
  assert.ok(html.includes(`${FOREIGN}/_media/`), 'must use the origin it was called with')
  const mediaHosts = [...html.matchAll(/https?:\/\/([^/"]+)\/_media\//g)].map(m => m[1])
  assert.ok(mediaHosts.length > 0, 'expected at least one /_media/ URL')
  for (const h of mediaHosts) {
    assert.equal(h, 'some-other-host.example', `every media host must be the passed origin, got ${h}`)
  }
})

test('raw CDN URLs never reach the client — they expire and bypass /_media/', async () => {
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.ok(!html.includes('cdn.bsky.app'), 'no raw CDN URLs')
  // The media key is encodeURIComponent(refKey(ref)) — '%3A' for the ':' delimiters,
  // never a bare colon — so the wire format survives an edge/proxy percent-normalizing
  // path segments (I-2). A bare-colon match here would silently tolerate a regression
  // back to the fragile raw-refKey wire format.
  assert.match(html, /\/_media\/bs%3Aalice\.bsky\.social%3A3k2a\/0/)
  assert.ok(!html.includes('/_media/bs:alice'), 'the media URL must not contain a bare, unencoded colon')
})

test('EXACTLY ONE og:image — a second one wins and shows the wrong picture', async () => {
  // OGP takes the first occurrence. Emitting the avatar AND the post image means
  // Discord renders the avatar as the embed image, and og:image:width/height
  // (computed from the post image) attach to the wrong one.
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  const imgs = tagsOf(html, 'og:image')
  assert.equal(imgs.length, 1, `expected exactly 1 og:image, got ${imgs.length}: ${imgs}`)
  assert.match(imgs[0], /\/_media\/bs%3Aalice\.bsky\.social%3A3k2a\/0$/, 'must be the post image, not the avatar')
})

test('avatar becomes og:image only when the post has no media', async () => {
  const noMedia = { ...base, media: [] }
  const imgs = tagsOf(await body(render({ kind: 'post', post: noMedia }, 'discord', ORIGIN)), 'og:image')
  assert.equal(imgs.length, 1)
  assert.match(imgs[0], /\/avatar$/)
})

test('EXACTLY ONE og:description, and sensitive actually marks it', async () => {
  const plain = tagsOf(await body(render({ kind: 'post', post: base }, 'discord', ORIGIN)), 'og:description')
  assert.equal(plain.length, 1)
  assert.ok(!plain[0].includes('[sensitive]'))

  const sens = tagsOf(await body(render({ kind: 'post', post: { ...base, sensitive: true } }, 'discord', ORIGIN)), 'og:description')
  assert.equal(sens.length, 1, 'a second og:description would be ignored and the marker lost')
  assert.match(sens[0], /\[sensitive\]/)
})

test('post text is HTML-escaped', async () => {
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.ok(!html.includes('<world>'))
  assert.match(html, /&lt;world&gt;/)
  assert.match(html, /&amp;/)
  assert.match(html, /&quot;friends&quot;/)
})

test('Telegram gets og tags and never a meta refresh — it hangs on them', async () => {
  const html = await body(render({ kind: 'post', post: base }, 'telegram', ORIGIN))
  assert.ok(!/http-equiv=["']?refresh/i.test(html))
  assert.equal(tagsOf(html, 'og:title').length, 1)
})

test('failure: crawler gets an honest error embed, human gets the real post', async () => {
  const f = { kind: 'failure', canonical: 'https://bsky.app/x', platform: 'bs', reason: 'fetch failed' }
  const h = render(f, 'human', ORIGIN)
  assert.equal(h.status, 302)
  assert.equal(h.headers.get('location'), 'https://bsky.app/x')
  const d = await body(render(f, 'discord', ORIGIN))
  assert.match(d, /fetch failed/i)
})

test('a failure with no canonical is a 404, not a redirect to null', () => {
  const r = render({ kind: 'failure', canonical: null, platform: null, reason: 'not found' }, 'human', ORIGIN)
  assert.equal(r.status, 404)
})

test('ambiguous: human gets a chooser; crawler is told plainly and given no dead advice', async () => {
  const a = { kind: 'ambiguous', path: '/mrbeast', candidates: ['x', 'ig'] }
  const h = await body(render(a, 'human', ORIGIN))
  assert.match(h, /x\.com\/mrbeast/)
  assert.match(h, /instagram\.com\/mrbeast/)

  const d = await body(render(a, 'discord', ORIGIN))
  assert.match(d, /ambiguous/i)
  // Must NOT advise "/x/mrbeast": bare profiles are not a post shape in any phase,
  // so that prefix 404s. Advice that doesn't work is worse than none.
  assert.ok(!/\/x\/mrbeast/.test(d), 'must not advise a prefix that 404s')
})

test('video dimensions are lied about for Discord', async () => {
  const big = { ...base, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 3840, h: 2160 }] }
  const h1 = await body(render({ kind: 'post', post: big }, 'discord', ORIGIN))
  assert.match(h1, /og:video:width" content="1920"/) // halved: Discord drops 4K
  assert.match(h1, /og:video:height" content="1080"/)

  const small = { ...base, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 200, h: 300 }] }
  const h2 = await body(render({ kind: 'post', post: small }, 'discord', ORIGIN))
  assert.match(h2, /og:video:width" content="400"/) // doubled: Discord postage-stamps low-res
  assert.match(h2, /og:video:height" content="600"/)
})

test('video: twitter:image is absolute and there is no og:image to outrank it', async () => {
  const vid = { ...base, media: [{ kind: 'video', url: 'https://cdn/v.mp4', w: 1280, h: 720 }] }
  const html = await body(render({ kind: 'post', post: vid }, 'discord', ORIGIN))
  // A bare "0" resolves to /0 on our origin — the bare-username shape — which would
  // serve a chooser and a bogus ambiguous datapoint on every video embed.
  assert.ok(!/twitter:image" content="0"/.test(html))
  assert.match(html, new RegExp(`twitter:image" content="${ORIGIN}/_alt/0"`))
  // An og:image (e.g. the avatar) would defeat the suppression the /_alt/0 trick exists for.
  assert.equal(tagsOf(html, 'og:image').length, 0, 'video embeds must not carry an og:image')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/render.test.mjs`
Expected: FAIL — cannot find `../src/render/index.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/render/fail.ts`:
```ts
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function html(head: string, status = 200): Response {
  return new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/** 302, never a meta refresh: Telegram hangs on meta refresh. */
export function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } })
}

export function errorEmbed(title: string, reason: string): Response {
  return html(
    `<meta property="og:title" content="${esc(title)}"/>` +
    `<meta property="og:description" content="${esc(reason)}"/>` +
    `<meta name="theme-color" content="#d33"/>`,
  )
}
```

`src/render/discord.ts`:
```ts
import type { ClientClass, Post } from '../types.ts'
import { refKey } from '../refkey.ts'
import { esc, html } from './fail.ts'

// refKey() joins components with a literal ':', which is legal in a path segment
// (RFC 3986) but not guaranteed to survive every edge/proxy unmolested. Discord's
// media proxy (and any CDN in front of it) is free to percent-normalize ':' to
// '%3A'. encodeURIComponent-ing the WHOLE key here means the wire format never
// contains a bare colon in the first place, so there is nothing left for an edge
// to normalize — the router reverses this with a single decodeURIComponent
// before handing the key to parseRefKey (see the `_media` branch in router.ts).
const mediaUrl = (origin: string, p: Post, i: number | 'avatar') =>
  `${origin}/_media/${encodeURIComponent(refKey(p.ref))}/${i}`

/** Discord drops 4K and postage-stamps low-res, so we lie about dimensions. */
function fudge(w: number, h: number): [number, number] {
  if (w > 1920 || h > 1920) return [Math.round(w / 2), Math.round(h / 2)]
  if (w < 400 && h < 400 && w > 0 && h > 0) return [w * 2, h * 2]
  return [w, h]
}

export function renderPost(post: Post, _client: ClientClass, origin: string): Response {
  const tags: string[] = []
  tags.push(`<meta property="og:title" content="${esc(`${post.author.name} (@${post.author.handle})`)}"/>`)

  // Exactly one og:description. OGP takes the FIRST occurrence, so a second tag
  // would be silently ignored — which is how a sensitive marker gets lost.
  const desc = post.sensitive ? `[sensitive] ${post.text}` : post.text
  tags.push(`<meta property="og:description" content="${esc(desc)}"/>`)

  tags.push(`<meta property="og:url" content="${esc(post.canonical)}"/>`)
  tags.push(`<meta property="og:site_name" content="fxeverything"/>`)

  // Exactly one og:image, or none. Emitting both the avatar and the post image
  // means the avatar wins and Discord shows the wrong picture.
  const video = post.media.find(m => m.kind === 'video')
  if (video) {
    const i = post.media.indexOf(video)
    const [w, h] = fudge(video.w, video.h)
    tags.push(`<meta property="og:type" content="video.other"/>`)
    tags.push(`<meta property="og:video" content="${mediaUrl(origin, post, i)}"/>`)
    tags.push(`<meta property="og:video:secure_url" content="${mediaUrl(origin, post, i)}"/>`)
    tags.push(`<meta property="og:video:type" content="video/mp4"/>`)
    tags.push(`<meta property="og:video:width" content="${w}"/>`)
    tags.push(`<meta property="og:video:height" content="${h}"/>`)
    tags.push(`<meta name="twitter:card" content="player"/>`)
    // Absolute, never the bare string "0": a relative "0" resolves to /0 on our
    // origin, which is the bare-username shape, and would serve a chooser.
    // No og:image here — it would outrank this and defeat the suppression.
    tags.push(`<meta name="twitter:image" content="${origin}/_alt/0"/>`)
  } else {
    const img = post.media.find(m => m.kind === 'image' || m.kind === 'gif')
    if (img) {
      const [w, h] = fudge(img.w, img.h)
      tags.push(`<meta property="og:image" content="${mediaUrl(origin, post, post.media.indexOf(img))}"/>`)
      tags.push(`<meta property="og:image:width" content="${w}"/>`)
      tags.push(`<meta property="og:image:height" content="${h}"/>`)
      tags.push(`<meta name="twitter:card" content="summary_large_image"/>`)
    } else if (post.author.avatar) {
      // Only when there is no post media does the avatar become the embed image.
      tags.push(`<meta property="og:image" content="${mediaUrl(origin, post, 'avatar')}"/>`)
      tags.push(`<meta name="twitter:card" content="summary"/>`)
    }
  }
  return html(tags.join(''))
}
```

`src/render/chooser.ts`:
```ts
import type { Platform } from '../types.ts'
import { esc, html } from './fail.ts'

export const HOST: Record<Platform, string> = {
  x: 'x.com',
  tt: 'tiktok.com',
  ig: 'instagram.com',
  th: 'threads.com',
  rd: 'reddit.com',
  bs: 'bsky.app',
}

/**
 * Ambiguous paths are never guessed. A human picks; a crawler is told plainly.
 * Guessing would sometimes serve the wrong post and nobody would notice.
 */
export function renderChooser(path: string, candidates: Platform[]): Response {
  const links = candidates
    .map(p => `<li><a href="https://${HOST[p]}${esc(path)}">${esc(HOST[p] + path)}</a></li>`)
    .join('')
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Which site?</title></head>` +
    `<body><h1>Which site did you mean?</h1>` +
    `<p><code>${esc(path)}</code> is a valid link on more than one site, and replacing the ` +
    `domain threw away which one. Pick:</p><ul>${links}</ul></body></html>`,
    { status: 300, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}
```

`src/render/index.ts`:
```ts
import type { ClientClass, Outcome } from '../types.ts'
import { renderPost } from './discord.ts'
import { HOST, renderChooser } from './chooser.ts'
import { errorEmbed, redirect } from './fail.ts'

/**
 * The only entry point. Never assumes a Post: the ambiguous path never resolved
 * to one and the failure path never got one.
 *
 * `origin` comes from the request, never a constant — a hardcoded prod origin
 * would make staging embeds point Discord's media proxy at the live prod worker.
 */
export function render(outcome: Outcome, client: ClientClass, origin: string): Response {
  const isHuman = client === 'human'

  switch (outcome.kind) {
    case 'post':
      // worker.ts 302s humans before fetching; this keeps it correct if one arrives here.
      return isHuman ? redirect(outcome.post.canonical) : renderPost(outcome.post, client, origin)

    case 'ambiguous': {
      if (isHuman) return renderChooser(outcome.path, outcome.candidates)
      // No prefix advice: bare profiles are not a post shape in any phase, so
      // "/x/mrbeast" would 404. Name the sites instead.
      const names = outcome.candidates.map(c => HOST[c]).join(' or ')
      return errorEmbed(
        'Ambiguous link',
        `${outcome.path} is a valid link on ${names}, and replacing the domain threw away which. ` +
        `Post links work; bare profile links cannot.`,
      )
    }

    case 'failure':
      if (isHuman) {
        return outcome.canonical ? redirect(outcome.canonical) : new Response('not found\n', { status: 404 })
      }
      return errorEmbed(
        outcome.platform ? `${outcome.platform} extraction failed` : 'Not found',
        outcome.reason,
      )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/render.test.mjs && npm run typecheck`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/ test/render.test.mjs
git commit -m "feat: renderers — Discord, chooser, failure

origin is a parameter, not a constant: hardcoding prod would make staging
embeds point Discord's media proxy at the live prod worker. Exactly one
og:image and one og:description — OGP takes the first occurrence, so a
second tag is silently ignored (which is how a sensitive marker gets lost,
and how an avatar outranks the post's own image).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Cache + analytics

**Files:**
- Create: `src/cache.ts`, `src/analytics.ts`
- Test: `test/cache.test.mjs`

**Interfaces:**
- Consumes: `Post`, `PostRef`, `ClientClass`, `Platform`; `refKey`.
- Produces: `postCacheKey`, `respCacheKey`, `cacheUrl`, `serializePost`, `deserializePost`, `POST_TTL`, `RESP_TTL`, `MEDIA_MAX_AGE`; `count`, `Env`, `Outcome2`.

- [ ] **Step 1: Write the failing test**

`test/cache.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postCacheKey, respCacheKey, serializePost, deserializePost, cacheUrl } from '../src/cache.ts'

const ref = { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' }

test('the Post layer is shared across client classes', () => {
  // One upstream fetch must serve discord, telegram and every other bot.
  assert.equal(postCacheKey(ref), 'post:bs:alice.bsky.social:3k2a')
})

test('only the response layer varies by client class', () => {
  assert.equal(respCacheKey(ref, 'discord'), 'resp:bs:alice.bsky.social:3k2a:discord')
  assert.notEqual(respCacheKey(ref, 'discord'), respCacheKey(ref, 'telegram'))
})

test('the media route and the post cache agree on identity', () => {
  // /_media/ reads the Post cache; if the keys diverged, every media hit would miss.
  assert.ok(postCacheKey(ref).endsWith('bs:alice.bsky.social:3k2a'))
})

test('cacheUrl is a valid URL even for keys with colons and slashes', () => {
  const weird = { p: 'bs', handle: 'did:plc:abc/def', rkey: 'r k' }
  assert.doesNotThrow(() => new URL(cacheUrl(postCacheKey(weird))))
})

test('Post survives a serialize/deserialize round trip, Date included', () => {
  const post = {
    ref,
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'hi',
    createdAt: new Date('2026-07-01T12:00:00Z'),
    media: [{ kind: 'image', url: 'https://cdn/a.jpg', w: 1, h: 2 }],
    counts: { likes: 1 },
    sensitive: false,
  }
  const back = deserializePost(serializePost(post))
  assert.ok(back.createdAt instanceof Date, 'createdAt must survive as a Date, not a string')
  assert.equal(back.createdAt.toISOString(), post.createdAt.toISOString())
  assert.deepEqual(back.ref, post.ref)
  assert.deepEqual(back.media, post.media)
})

test('nested quote Dates also survive the round trip', () => {
  const inner = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 'https://bsky.app/profile/q.bsky.social/post/qk',
    author: { name: 'Q', handle: 'q.bsky.social', url: 'https://bsky.app/profile/q.bsky.social' },
    text: 'quoted', createdAt: new Date('2026-06-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const outer = { ...inner, ref, text: 'root', createdAt: new Date('2026-07-01T00:00:00Z'), quote: inner }
  const back = deserializePost(serializePost(outer))
  assert.ok(back.quote.createdAt instanceof Date, 'a nested Date must not come back as a string')
})

test('deserialize returns null on junk rather than throwing', () => {
  assert.equal(deserializePost('not json'), null)
  assert.equal(deserializePost('{}'), null)
  assert.equal(deserializePost('null'), null)
})

// --- Regression: shallow validation let junk through disguised as a Post. ---
// The docstring promises "null on junk, never throws." The old checks were
// type-only (typeof createdAt === 'string') or truthy-only (!o?.ref), so a
// stale/corrupted cache entry could deserialize successfully and then render
// as garbage in served markup — e.g. /_media/undefined/avatar in an og:image.

const validAuthor = { name: 'a', handle: 'a', url: 'a' }

test('rejects a createdAt that does not parse as a date, not just non-string', () => {
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: 'garbage',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a ref with no recognizable shape at all ({})', () => {
  // !o?.ref is a truthy check only — {} is truthy and used to sail through.
  const s = JSON.stringify({
    ref: {}, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a ref with a valid platform tag but missing required fields', () => {
  // refKey({p:'bs'}) is the STRING 'bs:undefined:undefined' (encodeURIComponent(undefined)
  // === 'undefined'), not undefined — so a naive `typeof refKey(ref) === 'string'`
  // check does not catch this. Only the round trip through parseRefKey does.
  const s = JSON.stringify({
    ref: { p: 'bs' }, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a ref with an unknown platform tag', () => {
  const s = JSON.stringify({
    ref: { p: 'zz', id: '1' }, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
  })
  assert.equal(deserializePost(s), null)
})

test('a malformed quote ref is rejected too, not just a malformed root ref', () => {
  // reviveDates already recurses into quote/replyTo; a bad quote ref produces the
  // same /_media/undefined/ bug one level down. Depth is capped at 1 — no recursion
  // problem in the validator either.
  const badQuote = {
    ref: { p: 'bs' }, canonical: 'q', createdAt: '2026-06-01T00:00:00Z',
    author: validAuthor, text: 'quoted', media: [], counts: {}, sensitive: false,
  }
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
    quote: badQuote,
  })
  assert.equal(deserializePost(s), null)
})

test('a fully valid Post with a well-formed quote still round-trips (positive control)', () => {
  // Guards against over-rejection: the stricter validation must not reject good data.
  const quote = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 'https://bsky.app/profile/q.bsky.social/post/qk',
    author: { name: 'Q', handle: 'q.bsky.social', url: 'https://bsky.app/profile/q.bsky.social' },
    text: 'quoted', createdAt: new Date('2026-06-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const post = {
    ref, canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'root', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false, quote,
  }
  const back = deserializePost(serializePost(post))
  assert.ok(back, 'a fully well-formed Post must not be rejected')
  assert.deepEqual(back.ref, post.ref)
  assert.ok(back.quote, 'a well-formed quote must not be rejected')
  assert.deepEqual(back.quote.ref, quote.ref)
})

// --- Regression: canonical was validated on the root but NEVER on a nested
// quote/replyTo. hasValidIdentity (what nested posts go through) checked only ref
// shape + createdAt — never canonical, the exact field render/discord.ts drops
// into og:-tag markup via esc(post.canonical). A corrupted quote.canonical sailed
// through deserializePost and came back out the other side untouched. Dormant only
// because quote/replyTo layout is Phase 2 — the guard must be total between a
// corrupted cache entry and served output regardless of what today's renderer draws.

test('rejects a quote whose canonical is not a string', () => {
  const badQuote = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 12345, // a number, not a string
    createdAt: '2026-06-01T00:00:00Z',
    author: validAuthor, text: 'quoted', media: [], counts: {}, sensitive: false,
  }
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
    quote: badQuote,
  })
  assert.equal(deserializePost(s), null)
})

test('rejects a replyTo whose canonical is missing entirely', () => {
  const badReplyTo = {
    ref: { p: 'bs', handle: 'p.bsky.social', rkey: 'pk' },
    // canonical omitted entirely
    createdAt: '2026-05-01T00:00:00Z',
    author: validAuthor, text: 'parent', media: [], counts: {}, sensitive: false,
  }
  const s = JSON.stringify({
    ref, canonical: 'x', createdAt: '2026-07-01T00:00:00Z',
    author: validAuthor, text: 't', media: [], counts: {}, sensitive: false,
    replyTo: badReplyTo,
  })
  assert.equal(deserializePost(s), null)
})

test('a Post with both a valid quote AND a valid replyTo still round-trips (positive control)', () => {
  // Guards against over-rejection: validating canonical on nested posts too must
  // not reject a Post whose quote and replyTo are both genuinely well-formed.
  const quote = {
    ref: { p: 'bs', handle: 'q.bsky.social', rkey: 'qk' },
    canonical: 'https://bsky.app/profile/q.bsky.social/post/qk',
    author: { name: 'Q', handle: 'q.bsky.social', url: 'https://bsky.app/profile/q.bsky.social' },
    text: 'quoted', createdAt: new Date('2026-06-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const replyTo = {
    ref: { p: 'bs', handle: 'p.bsky.social', rkey: 'pk' },
    canonical: 'https://bsky.app/profile/p.bsky.social/post/pk',
    author: { name: 'P', handle: 'p.bsky.social', url: 'https://bsky.app/profile/p.bsky.social' },
    text: 'parent', createdAt: new Date('2026-05-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false,
  }
  const post = {
    ref, canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'root', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [], counts: {}, sensitive: false, quote, replyTo,
  }
  const back = deserializePost(serializePost(post))
  assert.ok(back, 'a fully well-formed Post with quote+replyTo must not be rejected')
  assert.ok(back.quote, 'a well-formed quote must not be rejected')
  assert.ok(back.replyTo, 'a well-formed replyTo must not be rejected')
  assert.deepEqual(back.quote.ref, quote.ref)
  assert.deepEqual(back.replyTo.ref, replyTo.ref)
})

// --- Coverage gap: positive controls only ever exercised the 'bs' PostRef variant.
// Over-rejection is the dangerous direction here: it would silently disable the
// cache for a whole platform (or a subset of handles) and hammer upstream — and no
// test would fail, it would just get slow. This exercises all seven PostRef union
// members, plus "weird but legal" Bluesky handles that a naive validator might
// wrongly flag.

test('all seven PostRef variants, plus known-good edge-case handles, round-trip through deserializePost', () => {
  const cases = [
    { p: 'x', id: '123' },
    { p: 'tt', id: '456' },
    { p: 'ig', kind: 'p', code: 'BsOGulcndj-' },
    { p: 'ig', kind: 'reel', code: 'CxReelCode1' },
    { p: 'ig', kind: 'tv', code: 'DzTvCode123' },
    { p: 'ig', kind: 'story', user: 'someuser', id: '987' },
    { p: 'th', code: 'DTI1vjIEi5y' },
    { p: 'rd', sub: 'aww', id: 'abc123' },
    { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    // Known-good edge cases: legal Bluesky handles that must not be over-rejected.
    { p: 'bs', handle: 'did:plc:abcdef123456', rkey: 'edgekey1' }, // DID handle — contains ':'
    { p: 'bs', handle: 'weird%handle', rkey: 'edgekey2' }, // contains a raw '%'
    { p: 'bs', handle: 'weird/handle', rkey: 'edgekey3' }, // contains a raw '/'
  ]
  for (const r of cases) {
    const post = {
      ref: r,
      canonical: 'https://example.test/canonical',
      author: validAuthor,
      text: 't',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      media: [], counts: {}, sensitive: false,
    }
    const back = deserializePost(serializePost(post))
    assert.ok(back, `over-rejected a valid ref: ${JSON.stringify(r)}`)
    assert.deepEqual(back.ref, r, `ref corrupted in round trip: ${JSON.stringify(r)}`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cache.test.mjs`
Expected: FAIL — cannot find `../src/cache.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/cache.ts`:
```ts
import type { ClientClass, Post, PostRef } from './types.ts'
import { refKey, parseRefKey } from './refkey.ts'

/** 15 min. Also the max age of a signed CDN URL we hand out (plus MEDIA_MAX_AGE). */
export const POST_TTL = 900
export const RESP_TTL = 900
/** On the /_media/ 302 itself, bounding repeat media hits. Matches InstaFix-Revived. */
export const MEDIA_MAX_AGE = 300

/** Shared across client classes: one upstream fetch serves every bot. */
export const postCacheKey = (ref: PostRef) => `post:${refKey(ref)}`

/** Only the rendered response varies by client. Never Vary: User-Agent — cardinality is unbounded. */
export const respCacheKey = (ref: PostRef, client: ClientClass) => `resp:${refKey(ref)}:${client}`

/** The Cache API needs a full URL as its key; this namespaces ours onto a fake origin. */
export const cacheUrl = (key: string) => `https://cache.fxeverything.internal/${encodeURIComponent(key)}`

function reviveDates(p: any): any {
  if (!p) return p
  p.createdAt = new Date(p.createdAt)
  if (p.quote) reviveDates(p.quote)
  if (p.replyTo) reviveDates(p.replyTo)
  return p
}

/** Structural equality for the flat, all-primitive shape of a PostRef. */
function shallowEqual(a: object, b: object): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every(k => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

/**
 * A ref is well-formed only if it round-trips through refKey → parseRefKey back to
 * itself — the strongest check available with zero new dependencies, and it reuses
 * the two functions that already define ref identity rather than hand-rolling a
 * parallel per-platform validator that could drift from them.
 *
 * `typeof refKey(ref) === 'string'` is NOT sufficient. refKey's switch has no
 * default case, so an unknown platform tag (`{p:'zz'}`) silently returns
 * `undefined` (caught by the typeof check below) — but a KNOWN tag with missing
 * fields (`{p:'bs'}`) does NOT: `encodeURIComponent(undefined) === 'undefined'`,
 * so it returns the literal string `'bs:undefined:undefined'`. Only the round
 * trip through parseRefKey — which requires every component to be non-empty —
 * catches that second case.
 */
function isValidRef(ref: unknown): ref is PostRef {
  if (!ref || typeof ref !== 'object') return false
  const key = refKey(ref as PostRef)
  if (typeof key !== 'string') return false
  const parsed = parseRefKey(key)
  return parsed !== null && shallowEqual(parsed, ref)
}

/**
 * Ref shape + a non-empty canonical string + a Date that actually parses. Applied
 * identically to the root post AND, since reviveDates already recurses into them,
 * to a nested quote/replyTo too — a corrupted canonical one level down reaches the
 * exact same served markup (render/discord.ts's `esc(post.canonical)`) as a
 * corrupted root canonical would. It is dormant only because quote/replyTo layout
 * is Phase 2; the guard must be total between a corrupted cache entry and served
 * output regardless of what today's renderer happens to draw.
 * Depth is capped at 1 (Post.quote.quote is always undefined), so this is never
 * called more than two levels deep and needs no recursion of its own.
 */
function hasValidIdentity(o: any): boolean {
  return (
    isValidRef(o?.ref) &&
    typeof o?.canonical === 'string' && o.canonical.length > 0 &&
    typeof o?.createdAt === 'string' && !Number.isNaN(Date.parse(o.createdAt))
  )
}

export function serializePost(p: Post): string {
  // JSON.stringify turns Date into an ISO string automatically, including nested ones.
  return JSON.stringify(p)
}

export function deserializePost(s: string): Post | null {
  try {
    const o = JSON.parse(s)
    // hasValidIdentity covers the root the same way it covers quote/replyTo — no
    // separate `typeof o.canonical === 'string'` check here, so root and nested
    // posts can never drift out of sync again.
    if (!hasValidIdentity(o)) return null
    if (o.quote != null && !hasValidIdentity(o.quote)) return null
    if (o.replyTo != null && !hasValidIdentity(o.replyTo)) return null
    return reviveDates(o) as Post
  } catch {
    return null
  }
}
```

`src/analytics.ts`:
```ts
import type { ClientClass, Platform } from './types.ts'

export type Outcome2 =
  | 'ok' | 'media_hit' | 'media_miss' | 'assert_fail'
  | 'fetch_fail' | 'age_restricted' | 'ambiguous' | 'notfound'

export interface Env {
  AE?: { writeDataPoint(x: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }
  ASSETS: { fetch(req: Request): Promise<Response> }
}

/**
 * Counters only. No URLs, no post IDs, no IPs, no verbatim user agents.
 *
 * The historically demonstrated way a fixer dies is not lawyers — it is logging.
 * TwitFix shut down in 2022 over a public log of processed URLs and the harassment
 * that followed, with zero legal contact. We have nothing to leak.
 */
export function count(env: Env, platform: Platform | 'none', outcome: Outcome2, client: ClientClass): void {
  env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cache.test.mjs && npm run typecheck`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts src/analytics.ts test/cache.test.mjs
git commit -m "feat: two-layer cache keys and identifier-free analytics

Post layer is shared across client classes so one fetch serves every bot;
only the response layer varies by client. Nested quote/replyTo Dates are
revived on deserialize. Analytics emits counters with no URLs, post IDs or
IPs — logging is what killed TwitFix, not lawyers.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Media selection

**Files:**
- Create: `src/media.ts`
- Test: `test/media.test.mjs`

**Interfaces:**
- Consumes: `Post`.
- Produces: `pickMedia(post: Post, index: number | 'avatar'): string | null`.

- [ ] **Step 1: Write the failing test**

`test/media.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickMedia } from '../src/media.ts'

const post = {
  ref: { p: 'bs', handle: 'a.bsky.social', rkey: '3k2a' },
  canonical: 'https://bsky.app/x',
  author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social', avatar: 'https://cdn/avatar.jpg' },
  text: 't', createdAt: new Date(), counts: {}, sensitive: false,
  media: [
    { kind: 'image', url: 'https://cdn/0.jpg', w: 1, h: 1 },
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1, h: 1 },
  ],
}

test('numeric index picks from media[]', () => {
  assert.equal(pickMedia(post, 0), 'https://cdn/0.jpg')
  assert.equal(pickMedia(post, 1), 'https://cdn/1.jpg')
})

test('avatar index resolves to author.avatar', () => {
  assert.equal(pickMedia(post, 'avatar'), 'https://cdn/avatar.jpg')
})

test('out-of-range returns null, never a wrong URL', () => {
  assert.equal(pickMedia(post, 2), null)
  assert.equal(pickMedia(post, -1), null)
  assert.equal(pickMedia(post, 1.5), null)
  assert.equal(pickMedia({ ...post, media: [] }, 0), null)
})

test('missing avatar returns null', () => {
  assert.equal(pickMedia({ ...post, author: { ...post.author, avatar: undefined } }, 'avatar'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/media.test.mjs`
Expected: FAIL — cannot find `../src/media.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/media.ts`:
```ts
import type { Post } from './types.ts'

/**
 * Resolve a /_media/{refKey}/{index} URL to the origin CDN URL held in the cached Post.
 *
 * The caller reads the Post CACHE — it does not re-fetch upstream per image. An
 * 8-image carousel triggers 8 media hits; re-resolving each would mean 8 upstream
 * fetches per viewing client, on the platforms we rate most fragile.
 * InstaFix-Revived's offload handler does the same and states the rationale:
 * "one place to refresh cached scrape data before redirecting bots to image/video bytes."
 */
export function pickMedia(post: Post, index: number | 'avatar'): string | null {
  if (index === 'avatar') return post.author.avatar ?? null
  if (!Number.isInteger(index) || index < 0 || index >= post.media.length) return null
  return post.media[index].url || null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/media.test.mjs && npm run typecheck`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/media.ts test/media.test.mjs
git commit -m "feat: media selection

Returns null rather than a wrong URL when out of range. The caller reads the
Post cache rather than re-fetching: an 8-image carousel would otherwise cost
8 upstream fetches per viewing client.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Wire the pipeline

**Files:**
- Modify: `src/worker.ts` (replace the Task 1 stub entirely)
- Test: `test/pipeline.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: the deployable Worker.

**This task's tests invoke the real `fetch` handler** with real `Request` objects and a fake `env`. The previous approach — grepping `worker.ts` source text — was how two broken assertions shipped in an earlier draft of this plan. `caches.default` is unavailable under `node --test`, so the handler takes an injectable cache and the test supplies an in-memory one.

- [ ] **Step 1: Write the failing test**

`test/pipeline.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { handle } from '../src/worker.ts'

/** Minimal in-memory stand-in for the Cache API. */
function fakeCache() {
  const m = new Map()
  return {
    store: m,
    async match(k) { const v = m.get(k); return v ? v.clone() : undefined },
    async put(k, v) { m.set(k, v.clone()) },
  }
}
/**
 * `points` is captured in a closure, NOT via `this`. analytics.ts calls
 * `env.AE?.writeDataPoint(x)`, so the receiver is `env.AE` — a `this.points`
 * would resolve against AE, which has no such field, and throw on every count().
 */
const fakeEnv = () => {
  const points = []
  return {
    points,
    AE: { writeDataPoint(p) { points.push(p) } },
    ASSETS: { async fetch() { return new Response('asset', { status: 200 }) } },
  }
}
const ctx = { waitUntil() {} }
const req = (path, ua) =>
  new Request(`https://staging.megapenispoopenfarten.sex${path}`, { headers: ua ? { 'user-agent': ua } : {} })

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const BS_POST = '/profile/alice.bsky.social/post/3k2a'

test('humans NEVER trigger an upstream fetch — the router already knows canonical', async () => {
  let fetched = false
  const res = await handle(req(BS_POST), fakeEnv(), ctx, {
    cache: fakeCache(),
    fetchPost: async () => { fetched = true; return null },
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://bsky.app/profile/alice.bsky.social/post/3k2a')
  assert.equal(fetched, false, 'the human short-circuit must precede any fetch')
})

test('a crawler DOES fetch, and gets an embed', async () => {
  const post = {
    ref: { p: 'bs', handle: 'alice.bsky.social', rkey: '3k2a' },
    canonical: 'https://bsky.app/profile/alice.bsky.social/post/3k2a',
    author: { name: 'Alice', handle: 'alice.bsky.social', url: 'https://bsky.app/profile/alice.bsky.social' },
    text: 'hello', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const res = await handle(req(BS_POST, DISCORD), fakeEnv(), ctx, {
    cache: fakeCache(),
    fetchPost: async () => post,
  })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /og:title/)
})

test('the response body is still readable after being cached', async () => {
  // new Response(res.clone().body, res) is easy to get wrong and silently
  // returns an empty body to Discord.
  const post = {
    ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
    canonical: 'https://bsky.app/x',
    author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social' },
    text: 'body must survive', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const cache = fakeCache()
  const res = await handle(req('/profile/a.bsky.social/post/k', DISCORD), fakeEnv(), ctx,
    { cache, fetchPost: async () => post })
  const text = await res.text()
  assert.ok(text.length > 0, 'returned body must not be empty')
  assert.match(text, /body must survive/)
})

test('a warm cache hit serves the STORED body without re-fetching', async () => {
  // The previous test only ever reads the immediately-returned `res`. It never
  // proves the copy written to cache is itself readable on a second request —
  // a corrupt stored body would "silently return an empty body to Discord".
  const post = {
    ref: { p: 'bs', handle: 'c.bsky.social', rkey: 'k3' },
    canonical: 'https://bsky.app/profile/c.bsky.social/post/k3',
    author: { name: 'C', handle: 'c.bsky.social', url: 'https://bsky.app/profile/c.bsky.social' },
    text: 'warm hit must be readable too', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  let calls = 0
  const cache = fakeCache()
  const opts = { cache, fetchPost: async () => { calls++; return post } }
  const url = '/profile/c.bsky.social/post/k3'

  const first = await handle(req(url, DISCORD), fakeEnv(), ctx, opts)
  assert.equal(first.status, 200)

  const second = await handle(req(url, DISCORD), fakeEnv(), ctx, opts)
  assert.equal(calls, 1, 'the warm hit must be served from cache, not a second fetch')

  const text = await second.text()
  assert.ok(text.length > 0, 'the cached body must not be empty')
  assert.match(text, /og:title/)
  assert.match(text, /warm hit must be readable too/)
})

test('a fetchPost that THROWS on a crawler post-route request yields a graceful error embed, not an uncaught throw', async () => {
  // A real network failure (DNS, timeout, connection reset) makes fetch() itself
  // REJECT — fetchBluesky only guards `!res.ok` and content-type, so a rejection
  // must not propagate uncaught out of the handler.
  const opts = { cache: fakeCache(), fetchPost: async () => { throw new Error('ECONNRESET') } }
  const pending = handle(req('/profile/d.bsky.social/post/k4', DISCORD), fakeEnv(), ctx, opts)
  await assert.doesNotReject(pending)
  const res = await pending
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /og:title/)
  assert.match(text, /could not fetch post/)
})

test('media is class-agnostic — every client gets the same 302', async () => {
  const post = {
    ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
    canonical: 'https://bsky.app/x',
    author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social', avatar: 'https://cdn/av.jpg' },
    text: 't', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const opts = { cache: fakeCache(), fetchPost: async () => post }
  const outs = []
  for (const ua of [DISCORD, 'Mozilla/5.0 Firefox/38.0', undefined, 'TelegramBot']) {
    const r = await handle(req('/_media/bs:a.bsky.social:k/avatar', ua), fakeEnv(), ctx, opts)
    outs.push([r.status, r.headers.get('location')])
  }
  for (const o of outs) assert.deepEqual(o, [302, 'https://cdn/av.jpg'])
})

test('media_miss fires on a POST-CACHE miss, not only on a 404', async () => {
  // The spec's alert watches media_miss/media_hit to detect fetch amplification.
  // If media_miss only fired on 404s, the very failure it exists to catch is invisible.
  const post = {
    ref: { p: 'bs', handle: 'a.bsky.social', rkey: 'k' },
    canonical: 'https://bsky.app/x',
    author: { name: 'A', handle: 'a.bsky.social', url: 'https://bsky.app/profile/a.bsky.social', avatar: 'https://cdn/av.jpg' },
    text: 't', createdAt: new Date(), media: [], counts: {}, sensitive: false,
  }
  const cache = fakeCache()
  const env = fakeEnv()
  const opts = { cache, fetchPost: async () => post }
  const url = '/_media/bs:a.bsky.social:k/avatar'

  await handle(req(url, DISCORD), env, ctx, opts)     // cold: had to fetch
  await handle(req(url, DISCORD), env, ctx, opts)     // warm: served from cache

  const outcomes = env.points.map(p => p.blobs[1])
  assert.ok(outcomes.includes('media_miss'), 'the cold hit must count as a miss')
  assert.ok(outcomes.includes('media_hit'), 'the warm hit must count as a hit')
})

test('ambiguous and notfound never reach a fetch', async () => {
  let fetched = false
  const opts = { cache: fakeCache(), fetchPost: async () => { fetched = true; return null } }
  const amb = await handle(req('/mrbeast'), fakeEnv(), ctx, opts)
  assert.equal(amb.status, 300)
  const nf = await handle(req('/totally/unknown/deep/path'), fakeEnv(), ctx, opts)
  assert.equal(nf.status, 404)
  assert.equal(fetched, false)
})

test('site paths are served from ASSETS', async () => {
  const res = await handle(req('/'), fakeEnv(), ctx, { cache: fakeCache(), fetchPost: async () => null })
  assert.equal(await res.text(), 'asset')
})

test('the default export exposes a fetch handler', () => {
  assert.equal(typeof worker.fetch, 'function')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL — `worker.ts` has no named export `handle`.

- [ ] **Step 3: Write minimal implementation**

`src/worker.ts`:
```ts
import type { Post, PostRef } from './types.ts'
import { classify } from './classify.ts'
import { route } from './router.ts'
import { render } from './render/index.ts'
import { redirect } from './render/fail.ts'
import { pickMedia } from './media.ts'
import { count, type Env } from './analytics.ts'
import {
  cacheUrl, deserializePost, postCacheKey, respCacheKey,
  serializePost, POST_TTL, RESP_TTL, MEDIA_MAX_AGE,
} from './cache.ts'
import { fetchBluesky } from './platforms/bluesky/fetch.ts'
import { normalizeBluesky } from './platforms/bluesky/normalize.ts'

/** Minimal shape of the Cache API we use, so tests can inject an in-memory stand-in. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>
  put(key: string, res: Response): Promise<void>
}

export interface Deps {
  cache: CacheLike
  /** Live upstream fetch+normalize. Injectable so tests need no network. */
  fetchPost(ref: PostRef): Promise<Post | null>
}

async function liveFetchPost(ref: PostRef): Promise<Post | null> {
  if (ref.p !== 'bs') return null // other platforms land in their own phases
  const raw = await fetchBluesky(ref)
  if (!raw) return null
  return normalizeBluesky(raw, ref)
}

/** Returns the post plus whether it came from cache — the media counter needs that bit. */
async function getPost(ref: PostRef, d: Deps): Promise<{ post: Post | null; cached: boolean }> {
  const key = cacheUrl(postCacheKey(ref))
  const hit = await d.cache.match(key)
  if (hit) {
    const p = deserializePost(await hit.text())
    if (p) return { post: p, cached: true }
  }
  // A genuine upstream failure (DNS, timeout, connection reset) makes fetch()
  // itself REJECT, not resolve with a falsy value — fetchBluesky only guards
  // `!res.ok` and content-type. Treat a thrown fetch like a null one, so it
  // routes into the same fetch_fail / errorEmbed path instead of crashing the
  // Worker with an uncaught 500. Scoped to just the live-fetch call: a corrupt
  // cache-read error above is intentionally NOT caught here.
  let post: Post | null
  try {
    post = await d.fetchPost(ref)
  } catch {
    return { post: null, cached: false }
  }
  if (post) {
    await d.cache.put(
      key,
      new Response(serializePost(post), {
        headers: { 'cache-control': `max-age=${POST_TTL}`, 'content-type': 'application/json' },
      }),
    )
  }
  return { post, cached: false }
}

export async function handle(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response> {
  const url = new URL(req.url)
  // Always the request's own origin — never a constant. A hardcoded prod origin
  // would make staging embeds point Discord's media proxy at the live prod worker.
  const origin = url.origin
  const client = classify(req.headers.get('user-agent'))
  const r = route(url)

  switch (r.kind) {
    case 'site':
      return env.ASSETS.fetch(req)

    case 'notfound':
      count(env, 'none', 'notfound', client)
      return render({ kind: 'failure', canonical: null, platform: null, reason: 'not found' }, client, origin)

    case 'ambiguous':
      count(env, 'none', 'ambiguous', client)
      return render(r, client, origin)

    case 'media': {
      // Deliberately does NOT branch on client class: every class gets the same 302.
      // That is what lets us skip detecting Discord's fake-Firefox media proxy.
      const { post, cached } = await getPost(r.ref, d)
      // media_miss means "this cost an upstream fetch", not "404". The spec's alert
      // watches the miss/hit ratio to detect fetch amplification; keying it on 404s
      // would make that failure invisible.
      count(env, r.ref.p, cached ? 'media_hit' : 'media_miss', client)
      const target = post ? pickMedia(post, r.index) : null
      if (!target) return new Response('media unavailable\n', { status: 404 })
      return new Response(null, {
        status: 302,
        headers: { location: target, 'cache-control': `public, max-age=${MEDIA_MAX_AGE}` },
      })
    }

    case 'post': {
      // Humans never cost us an upstream fetch: the router already knows canonical.
      if (client === 'human') return redirect(r.canonical)

      const rkey = cacheUrl(respCacheKey(r.ref, client))
      const cached = await d.cache.match(rkey)
      if (cached) return cached

      const { post } = await getPost(r.ref, d)
      if (!post) {
        count(env, r.ref.p, 'fetch_fail', client)
        return render(
          { kind: 'failure', canonical: r.canonical, platform: r.ref.p, reason: 'could not fetch post' },
          client, origin,
        )
      }

      const res = render({ kind: 'post', post }, client, origin)
      // clone() tees the body, so `res` stays readable after we cache a copy.
      const toCache = new Response(res.clone().body, res)
      toCache.headers.set('cache-control', `max-age=${RESP_TTL}`)
      ctx.waitUntil(d.cache.put(rkey, toCache))
      count(env, r.ref.p, 'ok', client)
      return res
    }
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, ctx, { cache: caches.default as unknown as CacheLike, fetchPost: liveFetchPost })
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test && npm run typecheck`
Expected: PASS — 95 tests across all suites (smoke 5, types 3, refkey 8, classify 6, router 15, bluesky 14, render 13, cache 17, media 4, pipeline 10).

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/pipeline.test.mjs
git commit -m "feat: wire the pipeline

classify -> route -> cache -> fetch -> normalize -> render. Humans 302 before
any fetch. Media is class-agnostic by construction. Origin comes from the
request, never a constant. media_miss counts post-cache misses (the fetch
amplification the spec's alert watches for), not 404s.

Cache and upstream fetch are injected, so the handler is tested by invoking
it with real Requests rather than grepping its source.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Deploy to staging and verify in Discord

**Files:**
- Create: `docs/CHANGELOG.md`

**Interfaces:**
- Consumes: everything.
- Produces: a live staging deployment; the Phase 1 exit criterion met.

- [ ] **Step 1: Deploy to staging**

```bash
npm run deploy
```
Expected: `Deployed fxeverything` with `staging.megapenispoopenfarten.sex (custom domain)`.

Confirm prod is untouched:
```bash
curl -sI https://megapenispoopenfarten.sex/t/ZTSw2mYwR/ | head -1
```
Expected: `HTTP/2 200` — still the live fxtiktok worker.

- [ ] **Step 2: Verify the human and crawler paths differ**

Pick a real Bluesky post, then substitute `{handle}` and `{rkey}`:
```bash
S=https://staging.megapenispoopenfarten.sex

# Human: 302 to bsky.app, no fetch
curl -sI "$S/profile/{handle}/post/{rkey}" | grep -iE '^(HTTP|location)'

# Discord crawler: og tags, /_media/ URLs, and NO raw cdn.bsky.app
curl -s -A "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" \
  "$S/profile/{handle}/post/{rkey}" | grep -oE '<meta property="og:[^>]*>'

# Exactly one og:image
curl -s -A "Mozilla/5.0 (compatible; Discordbot/2.0)" "$S/profile/{handle}/post/{rkey}" \
  | grep -c 'property="og:image"'

# Media: 302 to a real CDN URL
curl -sI "$S/_media/bs:{handle}:{rkey}/avatar" | grep -iE '^(HTTP|location)'

# Ambiguous: chooser for humans
curl -s "$S/mrbeast" | grep -oE '<h1>[^<]*</h1>'
```
Expected: 302 to bsky.app; og tags whose media URLs are `staging.megapenispoopenfarten.sex/_media/…` and contain **no** `cdn.bsky.app` and **no** `megapenispoopenfarten.sex`; exactly `1` og:image; media 302 to a `cdn.bsky.app` URL; chooser heading.

- [ ] **Step 3: THE EXIT CRITERION — look at it in Discord**

Paste `https://staging.megapenispoopenfarten.sex/profile/{handle}/post/{rkey}` into any Discord channel.

Expected: an embed with the author name and handle, the post text, and the post's image if it has one.

**This is the gate.** Tests passing is not the same as the embed being right — what Discord renders *is* the product.

If it doesn't appear, check in order: (1) `curl -A Discordbot` — is it HTML with og tags? (2) do the `/_media/` URLs 302 to something real? (3) `https://discord.com/developers/embeds` will say what it dislikes.

- [ ] **Step 4: Write the changelog and commit**

`docs/CHANGELOG.md`:
```markdown
# Changelog

## Phase 1 — skeleton + Bluesky (2026-07-17)

The full pipeline, proven end to end with the one non-adversarial platform.

- classify → route → cache → fetch → normalize → render, all wired.
- Bluesky posts render correct Discord embeds.
- Root replacement works for permalinks; ambiguous paths are never guessed.
- Media is served via `/_media/{refKey}/{index}` → 302, never proxied.
- Analytics are counters only — no URLs, post IDs, or IPs.
- Deployed to staging. `megapenispoopenfarten.sex` still serves `fxtiktok`, untouched.
```

```bash
git add docs/CHANGELOG.md
git commit -m "docs: Phase 1 changelog

Bluesky posts render correct Discord embeds end to end on staging.
megapenispoopenfarten.sex is untouched and still serves live fxtiktok.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 1 Exit Criteria

- [ ] `npm test` passes; `npm run typecheck` is clean.
- [ ] A real Bluesky post renders a correct Discord embed on staging.
- [ ] A human clicking the same link lands on the real post at bsky.app.
- [ ] `/mrbeast` shows a chooser, not a guess.
- [ ] Media loads via `/_media/`; no raw CDN URL and no `megapenispoopenfarten.sex` appears in any rendered response.
- [ ] Exactly one `og:image` per embed.
- [ ] `megapenispoopenfarten.sex` is unchanged and still serving `fxtiktok`.

## Not in Phase 1 (and why)

| Deferred | Phase | Why |
|---|---|---|
| Multi-image, quote/reply rendering | 2 | Phase 1 proves the pipeline; depth is polish. The *data* is correct — quotes carry their own ref, and quote media (viewRecord's `embeds[]`) and gallery embeds normalize correctly — only the renderer doesn't yet lay any of it out. |
| Telegram renderer specifics | 2 | Telegram currently gets the same og tags as Discord, which is valid but unpolished |
| Mastodon spoof evaluation | 2 | Plain `og:video` is verified working, so this is an enhancement |
| TikTok, cutover | 3 | Needs its own parity checklist |
| Instagram, Threads, X | 4 | Adversarial; IG+Threads share one mechanism |
| Reddit, the converter page | 5 | Reddit's registered-app path must be verified first |
