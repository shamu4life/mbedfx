# fxeverything Phase 3a — TikTok extraction (staging only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real TikTok **video** post plays inline, and a real TikTok **photo slideshow** renders as a gallery, in a Discord embed on `staging.megapenispoopenfarten.sex` — with media served from our own `/_media/` route and **zero production risk**.

**Architecture:** Unchanged. TikTok is platform #2 and is meant to cost a fetcher, a normalizer, a router matcher and three small edits — that claim is what this phase tests. `fetchTikTok` pulls the post page with a **plain browser UA**, `normalizeTikTok` parses `__UNIVERSAL_DATA_FOR_REHYDRATION__` into the shared `Post`, and everything downstream is already `tt`-aware. The one genuinely new thing is a **video carve-out** in the Discord renderer: commit `3bda8e4` put every Discord response on the Mastodon-spoof path, and that path deliberately emits no `og:video`, so a playable mp4 would be swallowed.

**Tech Stack:** TypeScript, Cloudflare Workers, `wrangler`, `node --test` (Node ≥24 strips types natively — verified on v26.3.1). No runtime dependencies, no framework, no containers. Builds on the Phase 2 branch.

**Spec:** `docs/superpowers/specs/2026-07-16-fxeverything-design.md` — §Platforms/TikTok, §Media, §Routing, §Build order Phase 3.
**Prior plans:** `docs/superpowers/plans/2026-07-17-phase-1-skeleton-bluesky.md`, `…-phase-2-renderer-depth.md`.
**Prior research:** `docs/research/2026-07-18-phase-2-mastodon-spoof-wire-spec.md`.

---

## The scope split — read this before anything else

The spec's build order bundles **TikTok extraction** with **the production cutover** into one "Phase 3". This plan splits them, deliberately:

| | Contents | Gate |
|---|---|---|
| **Phase 3a — this plan** | TikTok fetcher, normalizer, routing, the video carve-out, platform identity in the spoof payload, verified on staging | `npm test` + a human looking at two real Discord embeds on staging |
| **Phase 3b — NOT this plan** | Move the apex + `*.megapenispoopenfarten.sex/*` wildcard from `fxtiktok` to `fxeverything`, unroute `fxtiktok`, ship `public/` | **Explicit human sign-off**, against the spec's absolute parity checklist |

**Why split.** The cutover is the only irreversible-feeling step in the whole project and the only one that can break something that works today. Bundling it with the extraction means the extraction's own bugs get discovered *while* production is in motion, and it means a "Phase 3 is done" claim can be made with the risky half unstarted. Split, 3a is a phase that can fail loudly and cost nothing: `megapenispoopenfarten.sex` still serves the live `fxtiktok` worker throughout, untouched, and 3a's exit criteria are all observable on staging.

**Nothing is lost by splitting** — the parity baseline that 3b will be measured against is recorded at the end of this document, in *What Phase 3b will need*. Read that section, do not act on it, and do not touch `megapenispoopenfarten.sex` in this phase for any reason.

---

## Global Constraints

(Inherited from Phases 1-2 — every task's requirements implicitly include all of these.)

- Zero runtime dependencies. devDependencies exactly: `@cloudflare/workers-types`, `typescript`, `wrangler`.
- **Assert on CONTENT, never on status code — and never on `content-type` either.** TikTok makes both lie; see verified fact 4.
- Never guess an ambiguous path. Ambiguity resolves to `{kind:'ambiguous'}`, never a platform.
- **Never dead-end a root token.** Shape-match with fallthrough. This project has shadowed real post permalinks twice by reserving a token (`/x/status/123` under `@x`, then `@api`).
- Never proxy media bytes. `/_media/*` reads the Post cache and 302s.
- Renderers emit `/_media/{refKey}/{index}` URLs, never raw CDN URLs — including in `media_attachments`.
- Never `Vary: User-Agent`. Client class goes in the cache key.
- Cache keys derive from `refKey(ref)`, never the raw path.
- Origin always derived from the request, never hardcoded.
- Log nothing identifying. No URLs, no post IDs, no IPs. Counters only.
- **Pure core:** fetchers do I/O; normalizers and renderers are pure and test with **no network**.
- **Do not touch `megapenispoopenfarten.sex`.** Staging only, for the entire phase.
- TDD: write the failing test, **RUN it**, confirm it fails for the right reason, then implement.
- Commit identity is pinned to `Shamu4Life`. Never pass `-c`, `--author`, or set `user.email`.

---

## Phase 3a verified facts

Measured live 2026-07-18 from a **residential US IP**. Cite these; do not re-derive them and do not contradict them. Where something is *not* verified it says so — those are the only places judgement is required.

### 1. THE UA GATE IS INVERTED FROM INSTAGRAM. Read this twice.

Fetch the post page with a **plain Chrome UA, or no UA at all**. A **crawler UA is a decoy**:

| UA | Result |
|---|---|
| `facebookexternalhit` / `Discordbot` / `Twitterbot` | **HTTP 200**, ~7KB stub, **no caption, no playAddr**, `og:title` "TikTok · Mystic Aquarium", `og:description` "TikTok \| Make Your Day" |
| `bingbot` | HTTP 403 |
| plain Chrome UA, or none | full page, real payload |

**This is the exact opposite of Instagram**, where the crawler UA is the one that works and a Chrome UA gets a 599KB decoy at HTTP 200. Both facts are true, about different platforms, and the project's Instagram notes say the opposite of this page in language that reads identically. A future reader *will* conflate them. The fetcher carries this warning in a comment, and a test asserts the UA it sends is not crawler-shaped, precisely so the conflation cannot be made silently.

### 2. The payload lives in `__UNIVERSAL_DATA_FOR_REHYDRATION__`. `SIGI_STATE` is GONE.

Parse the `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">` element, then walk:

```
__DEFAULT_SCOPE__["webapp.video-detail"].statusCode      // assert this, see fact 3
__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct
```

`itemStruct` carries: `desc` (the caption), `createTime`, `author.{uniqueId,nickname,verified}`, `stats.{playCount,diggCount,commentCount,shareCount,collectCount}`, `music.{title,authorName}`, `video.{playAddr,downloadAddr,cover,dynamicCover,duration,width,height,bitrateInfo[]}`. **The presence of an `imagePost` key distinguishes a photo SLIDESHOW from a video post.** Do not reference `SIGI_STATE` anywhere — it no longer exists.

**These fields are NOT the types you would guess. Read fact 9 before writing a single line of the normalizer.**

### 3. `statusCode` must be asserted. The HTTP status tells you nothing.

A **deleted** post returns **HTTP 200** with a full 287KB page and a structurally **valid** blob carrying `statusCode: 10204`, `statusMsg: "item doesn't exist"`, and **no `itemStruct`**. `statusCode !== 0` → the normalizer returns `null`, which routes into the existing `fetch_fail` → error-embed path.

### 4. THE VIDEO URL — the decisive finding.

- `video.playAddr` and the `*-webapp-prime.*` hosts are **cookie-gated** (the query even names its own gate: `tk=tt_chain_token`). No cookie → **403**. Unusable via a 302, because Discord's media proxy sends no cookies.
- **USE INSTEAD:** every `PlayAddr.UrlList[]` contains an entry on `https://www.tiktok.com/aweme/v1/play/?...`. That endpoint **content-negotiates on cookies**: with **no** cookies it 302s to `v16m-default.tiktokcdn-us.com` and serves real MP4 bytes; with **any** TikTok cookie it 302s to the gated `webapp-prime` host. Discord's media proxy is cookie-free, so it lands on the working branch **by construction**. Verified: HTTP 200, `video/mp4`, **12,550,214 bytes**, `ftyp` at bytes 4-8 — byte-identical to what production's offload serves today.
- **Select it by substring** `.includes('/aweme/v1/play/')`. **Never by array index** — upstream `okdargy/fxTikTok` selects by substring too (`src/generate.ts:63`), and index position is not guaranteed stable.
- The aweme URL is **deterministic and session-independent**: two independent page fetches produced **byte-identical** URLs, while `playAddr` differed every time. Its `signaturev3` base64-decodes to `video_id;file_id;item_id.<mac>` — stable identifiers only, no timestamp, no session token. **It is therefore safe to cache for the full 900s Post TTL and beyond.** Each call to it mints a *fresh* CDN URL with ~21,667s (~6h) TTL.
- **Cross-CDN-family hostname rewriting DOES NOT WORK** (403; signatures are family-scoped). `v16`→`v19` works only *within* the prime family. Do not build anything on rewriting.
- `offload.tnktok.com` **redirects, it does not proxy** — so deleting it (spec §TikTok) costs no bytes and removes a stranger's hostname from the middle of our embeds. This phase never introduces it.

**This retires the spec's TikTok staleness open question.** §Media requires Post TTL + `MEDIA_MAX_AGE` (900 + 300 = 20 min) to stay under the shortest CDN signature lifetime. What we store in `Media.url` is the *aweme* URL, which carries no expiry at all; the ~6h CDN URL is minted downstream of us, by the client's own request. 20 minutes ≪ both. Record it; change no TTLs.

### 5. Content-type lies as loudly as status does.

A gated CDN 403 is served with **`content-type: video/mp4`** and a 522-byte `<HTML><HEAD><TITLE>Access Denied` body. The only reliable check on video bytes is **magic bytes: `ftyp` at bytes 4-8**. Every probe and every manual verification step in this plan asserts on that, never on status and never on content-type.

### 6. URL shapes and useful oddities.

- Post shapes: `/@{user}/video/{id}`, `/@{user}/photo/{id}`, `/@i/video/{id}`, plus the short links `/t/{shortcode}` and `vm.tiktok.com/{code}`.
- **`https://www.tiktok.com/@i/video/{id}` resolves without knowing the username.** This is what makes `PostRef = {p:'tt', id}` sufficient: the normalizer can always rebuild a working canonical even when the payload has no `author.uniqueId`.
- **`https://www.tiktok.com/embed/@user` DOES server-render post IDs.** Profile pages and `/explore` do not. This is the way to find fixtures.

### 7. THE UNVERIFIED RISK — everything above is residential-IP evidence.

None of it was measured from **Cloudflare Workers egress**, and TikTok is demonstrably IP/edge-reputation sensitive: a correctly-signed URL 403'd on `v16-webapp-prime` while the *identical signature* succeeded on `v19-webapp-prime`, reproduced **6/6** — per-edge IP policy, not a fluke. Workers egress from datacenter ranges. **Task 1 measures this before any dependent work exists.**

### 8. What already handles `tt` for free — verified by pushing a synthetic TikTok `Post` through every renderer.

**Zero changes needed:** `src/types.ts` (`{p:'tt'; id}` already in `PostRef`), `refkey.ts`, `cache.ts`, `statusid.ts`, `media.ts`, `classify.ts`, `analytics.ts`, `render/chooser.ts`, `render/text.ts`, `render/embed.ts`, `render/index.ts`, `render/fail.ts`, `render/telegram.ts`.

**TikTok photo slideshows already flow through the Phase 2 Mastodon-spoof gallery path unchanged.** That is the Phase 2 payoff arriving: the multi-image work done for Bluesky is exactly the work a TikTok slideshow needs, and this phase spends nothing to collect it. The only slideshow-specific code in the entire phase is the normalizer branch that produces the `Media[]`.

### 9. `createTime` IS A STRING, AND `stats` IS MIXED-TYPED. Do not type-guard on `number`.

Measured on a live payload 2026-07-18 (`itemStruct` for `7660566211100511518`):

```
createTime: '1783614572'        <- a decimal STRING of Unix SECONDS, not a number
stats: { diggCount: 21000, shareCount: 4056, commentCount: 82,
         playCount: 75900, collectCount: '2996' }   <- numbers AND strings, in one object
```

**Coerce with `Number()` and reject `NaN`. NEVER type-guard on `number`.** The natural defensive write in this repo's style — `typeof item.createTime === 'number' ? … : NaN` — is the shape `build()` uses for Bluesky, and here it returns `null` for **every real post**.

This fails **asymmetrically**, which is why it is called out as its own fact rather than left to the implementer: a hand-written synthetic fixture naturally spells `createTime: 1750000000` as a number, so the synthetic tests pass and only the real-fixture tests fail. An agent that reads a green synthetic test first will conclude the fixture is wrong. It is not. **Task 3 therefore requires at least one synthetic fixture to carry a STRING `createTime` and a STRING count**, so the coercion is exercised by the tests that are easiest to write, not only by the ones that are hardest to debug.

`collectCount` is not mapped to any `Post.counts` field, but its type is the evidence that the whole `stats` object is untrustworthy per-key: TikTok changed one key's type and left the rest, so "the ones we read happen to be numbers today" is a property with no guarantee behind it.

### 10. SHORT LINKS RESOLVE IN ONE FETCH, AND THE ANSWER IS UNAMBIGUOUS.

Measured 2026-07-18, plain Chrome UA, redirect-following (`curl -sL`):

| `/t/{code}` | final URL | `webapp.video-detail` | `statusCode` | verdict |
|---|---|---|---|---|
| `ZTSw2mYwR` (real TikTok) | `…/@mysticaquariumct/video/7660566211100511518?_r=1&_t=…` | **present** | `0` | it is TikTok, and the whole post is already in hand |
| `ZS1abcNOTREAL` (invented) | `https://www.tiktok.com/?_r=1` | **absent** | — | not TikTok |
| `DTI1vjIEi5y` (a real THREADS code) | `https://www.tiktok.com/?_r=1` | **absent** | — | not TikTok |

Three things follow, and they retire the deferral the first draft of this plan argued for:

- **One fetch, not two.** Redirect-following and the payload come from the *same* request: `redirects=1`, `http=200`, and a 286KB rehydration blob carrying `itemStruct.id`, `desc`, `author.uniqueId` and five aweme URLs. There is no resolve-then-fetch round trip to pay for.
- **The negative branch is clean and self-announcing.** A dead code and a real Threads code both land on the TikTok **homepage**, which carries a rehydration blob of its own (257KB) — so the marker's mere *presence* proves nothing. The discriminator is the **`webapp.video-detail` scope**, which the homepage does not have. A resolver that asserts on the marker alone would accept the homepage as a post.
- **Read the id from the PAYLOAD, never from the resolved URL.** The final URL carries a `?_r=1&_t=ZT-985wP6Q4qoX` session tail, and parsing an id back out of a URL is a second, driftable spelling of the router. `itemStruct.id` is the canonical numeric id, verbatim.

**This matters because production serves `/t/{code}` correctly TODAY** — verified 2026-07-18: `megapenispoopenfarten.sex/t/ZTSw2mYwR/` returns the 18-tag video head with `og:video` → `offload.tnktok.com` and `theme-color #ff0050`. Shipping 3a with `/t/{code}` unresolved is a **regression against live behaviour** and a self-inflicted blocker on the 3b cutover. So 3a builds it.

---

## File Structure

| File | Change |
|---|---|
| `src/probe.ts` | **NEW, THROWAWAY** — Task 1's Workers-egress measurement. Deleted in Task 10. |
| `src/platforms/tiktok/fetch.ts` | NEW — I/O: page fetch with a browser UA, content-asserted; short-code resolution |
| `src/platforms/tiktok/normalize.ts` | NEW — pure: HTML → `Post`, both post kinds; `tiktokRefFrom` |
| `src/types.ts` | MODIFY — the `shortlink` `Route` kind (the ONLY type change this phase) |
| `src/router.ts` | MODIFY — `tiktok(seg)` matcher in both arms; `/t/{code}` → `shortlink` |
| `src/worker.ts` | MODIFY — `liveFetchPost` dispatches on `ref.p`; the `shortlink` case; mount/unmount the probe |
| `src/render/embed.ts` | MODIFY — `playableVideo(post)`, shared by the carve-out gate and the plain head |
| `src/render/discord.ts` | MODIFY — the video carve-out; `theme-color` on the plain head too |
| `src/render/mastodon.ts` | MODIFY — `application.name` and `theme-color` per `ref.p`, not hardcoded Bluesky |
| `test/fixtures/tiktok-{video,slideshow,deleted}.html` | NEW — real captures, minimally re-wrapped |
| `test/tiktok-normalize.test.mjs` | NEW |
| `test/{router,render,mastodon,pipeline}.test.mjs` | MODIFY |
| `docs/research/2026-07-18-tiktok-workers-egress-probe.md` | NEW — Task 1's measured result |
| `docs/CHANGELOG.md` | MODIFY |

---

### Task 1: Workers-egress probe — BLOCKING, do this first

**Nothing else in this plan may start until this task's result is recorded.** Every fact in the recon came from a residential IP. If TikTok answers a Cloudflare datacenter IP differently, the fetcher we would otherwise write is built on sand, and we would find out only at the human gate — after eight tasks of work.

**Files:**
- Create: `src/probe.ts` (throwaway — Task 10 deletes it)
- Modify: `src/worker.ts` (mount the probe behind a staging-only secret)
- Create: `docs/research/2026-07-18-tiktok-workers-egress-probe.md`
- Test: `test/probe.test.mjs`

**Interfaces:**
- Consumes: `Env` (a new optional `PROBE_TOKEN`), a digits-only `id` from the query string.
- Produces: `runProbe(url: URL): Promise<Response>` — a JSON report. And a **decision**, written down.

#### What the probe can and cannot settle

Be precise about this, because the obvious reading is wrong:

- **The PAGE fetch is the blocking measurement.** Our Worker is the only thing that ever fetches `www.tiktok.com/@i/video/{id}`. If Workers egress cannot get a real `itemStruct`, Phase 3a as designed does not work, full stop.
- **The VIDEO fetch is informative, NOT decisive.** In production our Worker *never* fetches the aweme URL — it hands the URL to Discord in a 302, and **Discord's media proxy** fetches it, from **Discord's** IPs. So the probe's video result measures a different network path than production's. A failure there does not by itself condemn the design, and a success there does not guarantee Discord's proxy succeeds. **Only Task 11, in a real client, settles the video.** The probe fetches it anyway because "Workers egress can also get bytes" is a cheap, useful signal — and because if the page probe forces us onto the resolve-the-302-server-side fallback below, the video fetch *becomes* production's path and its result becomes decisive.

#### The decision tree — write the outcome into the research doc, then act

1. **Page probe returns a real `itemStruct` (statusCode 0, non-empty `desc`, an aweme URL present).** Proceed to Task 2 unchanged. This is the expected outcome.
2. **Page probe returns the ~7KB decoy, a 403, or a blob with no `itemStruct`.** Try the probe's other UA variants (Chrome UA / no UA / a second Chrome build) before concluding anything — the probe reports all of them in one call for exactly this reason. If *every* variant fails, **STOP and escalate to the human.** Do not start Task 3. Phase 3a does not ship; the options are a different UA/header set, an entirely different fetch path (upstream's API route), or an egress workaround, and choosing among those is a redesign, not a step.
3. **Page probe works; the aweme URL 403s from Workers egress.** Proceed, with one documented change: the fetcher **resolves the 302 server-side** and stores the *resolved* CDN URL in `Media.url` (this is what upstream fxTikTok does). Staleness stays comfortable — the resolved URL carries ~21,667s (~6h) versus our 900 + 300s window (fact 4) — so no TTL changes. Note the trade: the stored URL is then *not* the deterministic one, so two fetches of the same post produce different `Media.url`, and the cache entry is the only thing that keeps that stable.
4. **Page probe works; the aweme URL 403s AND the resolved CDN URL also 403s from Workers egress.** Video may need its own decision, and it is a human's: spec §Media permits per-platform byte proxying (*"302 first. If a platform's video demonstrably will not play inline from a 302, proxy that platform's video only, and record why"*), but that invents a bandwidth bill and touches an unresolved ToS question. **Escalate.** In that case Phase 3a ships **slideshows + video-thumbnail-only** — the normalizer's no-aweme-URL degrade path (Task 3) already produces exactly that, and Task 7's carve-out still ships (it is unit-tested and correct the moment a playable mp4 exists), with its human-gate item deferred to 3b.

- [ ] **Step 1: Write the failing test**

`test/probe.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'

const ctx = { waitUntil() {} }
const cache = { async match() { return undefined }, async put() {} }
const deps = { cache, fetchPost: async () => null }
const env = (extra = {}) => ({ ASSETS: { async fetch() { return new Response('asset') } }, ...extra })
const req = p => new Request(`https://staging.megapenispoopenfarten.sex${p}`)

test('the probe does not exist when PROBE_TOKEN is unset — production can never reach it', async () => {
  // Prod has no PROBE_TOKEN, so this is the property that makes a throwaway debug endpoint
  // safe to deploy at all. Asserted on the RESPONSE, not on a config file: the guard has to
  // be in the code path, because that is what the cutover would carry over if Task 10 slipped.
  const res = await handle(req('/_probe/anything?id=123'), env(), ctx, deps)
  assert.notEqual(res.status, 200, 'an unset token must not yield a probe response')
  assert.ok(!(await res.text()).includes('"page"'), 'no probe report may be emitted')
})

test('the probe requires the exact token', async () => {
  const res = await handle(req('/_probe/wrong?id=123'), env({ PROBE_TOKEN: 'right' }), ctx, deps)
  assert.notEqual(res.status, 200)
})

test('the probe refuses a non-numeric id — it builds an upstream URL out of it', async () => {
  // The id is interpolated into https://www.tiktok.com/@i/video/{id}. A digits-only rule is
  // what keeps a caller from steering our egress somewhere else; `new URL` would happily
  // accept path traversal or an @-host trick.
  for (const bad of ['abc', '1/../../x', '', '12 34', '1%2f2']) {
    const res = await handle(req(`/_probe/t?id=${bad}`), env({ PROBE_TOKEN: 't' }), ctx, deps)
    assert.equal(res.status, 400, `id=${bad} must be rejected before any fetch`)
  }
})

test('ftyp detection asserts on BYTES, never on status or content-type', async () => {
  // Verified: a gated CDN 403 is served as content-type video/mp4 with a 522-byte HTML body.
  const { looksLikeMp4 } = await import('../src/probe.ts')
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  const denied = new TextEncoder().encode('<HTML><HEAD><TITLE>Access Denied')
  assert.equal(looksLikeMp4(mp4), true)
  assert.equal(looksLikeMp4(denied), false)
  assert.equal(looksLikeMp4(new Uint8Array(3)), false, 'a short read must not throw')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/probe.test.mjs`

Expected: FAIL, on **tests 3 and 4 specifically**:
- **test 3** (`refuses a non-numeric id`) fails because `/_probe/t?id=abc` falls through to the router as an unknown path and answers **404**, not 400.
- **test 4** (`ftyp detection`) fails because `../src/probe.ts` does not exist.

**Tests 1 and 2 already PASS, and that is correct** — do not "fix" them and do not read their passing as the implementation existing. With no probe mounted, `/_probe/anything` is just an unknown path: `route()` returns `notfound`, the request carries no UA so `classify(null)` is `'human'`, and `render()`'s failure case with a null canonical returns `new Response('not found\n', {status: 404})` — which satisfies `notEqual(res.status, 200)` and emits no report. They are **regression guards on the token gate**, and they become load-bearing the moment Step 3 mounts the endpoint: after the mount, an implementation that forgot `env.PROBE_TOKEN &&` turns them red. Red means "the guard is missing", not "the feature is missing".

- [ ] **Step 3: Write minimal implementation**

`src/probe.ts` — a throwaway. It is written to be *deleted*, so it deliberately shares nothing with the real fetcher: the point is to measure what the network does, not to smuggle in half of Task 4 untested.

```ts
/**
 * THROWAWAY. Task 1 of the Phase 3a plan; Task 10 deletes this file.
 *
 * Everything the TikTok recon measured came from a residential US IP. TikTok is
 * demonstrably per-edge IP-sensitive (a correctly-signed URL 403'd on v16-webapp-prime
 * while the identical signature succeeded on v19-webapp-prime, 6/6). This endpoint asks
 * the same questions from real Workers egress, before any code depends on the answers.
 *
 * It reports in the RESPONSE BODY, never to logs: analytics carry counters only.
 */

const UAS: Record<string, string | null> = {
  none: null,
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chrome_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // The DECOY, probed on purpose so the report proves the inversion from Workers egress too.
  discordbot: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
}

const MARKER = '__UNIVERSAL_DATA_FOR_REHYDRATION__'

/** `ftyp` at bytes 4-8. The ONLY reliable mp4 check: a gated 403 is served as video/mp4. */
export function looksLikeMp4(b: Uint8Array): boolean {
  if (b.length < 8) return false
  return b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
}

/** First `n` bytes, then cancel — never pull 12MB into a Worker to look at eight of them. */
async function head(res: Response, n = 64): Promise<Uint8Array> {
  const r = res.body?.getReader()
  if (!r) return new Uint8Array(0)
  const { value } = await r.read()
  await r.cancel().catch(() => {})
  return (value ?? new Uint8Array(0)).slice(0, n)
}

async function probePage(id: string, ua: string | null) {
  try {
    const res = await fetch(`https://www.tiktok.com/@i/video/${id}`, {
      headers: ua ? { 'user-agent': ua } : {},
    })
    const body = await res.text()
    const m = body.match(new RegExp(`<script id="${MARKER}"[^>]*>([\\s\\S]*?)</script>`))
    let statusCode: unknown = null
    let hasItem = false
    let descLen = 0
    let awemeUrl: string | null = null
    if (m) {
      try {
        const j: any = JSON.parse(m[1])
        const d = j?.__DEFAULT_SCOPE__?.['webapp.video-detail']
        statusCode = d?.statusCode ?? null
        const item = d?.itemInfo?.itemStruct
        hasItem = !!item
        descLen = typeof item?.desc === 'string' ? item.desc.length : 0
        const urls: string[] = [
          ...(item?.video?.playAddr ? [item.video.playAddr] : []),
          ...(Array.isArray(item?.video?.bitrateInfo)
            ? item.video.bitrateInfo.flatMap((b: any) => (Array.isArray(b?.PlayAddr?.UrlList) ? b.PlayAddr.UrlList : []))
            : []),
        ].filter((u): u is string => typeof u === 'string')
        awemeUrl = urls.find(u => u.includes('/aweme/v1/play/')) ?? null
      } catch { /* report the parse failure as hasItem:false rather than 500 */ }
    }
    return {
      httpStatus: res.status, // reported, never asserted on
      bytes: body.length,
      markerPresent: !!m,
      statusCode,
      hasItemStruct: hasItem,
      descLen,
      awemeUrlFound: !!awemeUrl,
      awemeUrl,
    }
  } catch (e) {
    return { error: String(e) }
  }
}

async function probeVideo(url: string) {
  try {
    const res = await fetch(url)
    const b = await head(res)
    return {
      httpStatus: res.status,
      contentType: res.headers.get('content-type'), // reported; it LIES (a 403 says video/mp4)
      contentLength: res.headers.get('content-length'),
      finalUrlHost: (() => { try { return new URL(res.url).host } catch { return null } })(),
      ftyp: looksLikeMp4(b), // THE assertion
      firstBytesHex: [...b.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join(''),
    }
  } catch (e) {
    return { error: String(e) }
  }
}

/** GET /_probe/{PROBE_TOKEN}?id={digits} */
export async function runProbe(url: URL): Promise<Response> {
  const id = url.searchParams.get('id') ?? ''
  // Digits only. This value is interpolated into an upstream URL; anything else lets a
  // caller steer our egress.
  if (!/^\d+$/.test(id)) return new Response('id must be digits\n', { status: 400 })

  const page: Record<string, unknown> = {}
  for (const [name, ua] of Object.entries(UAS)) page[name] = await probePage(id, ua)

  const found = Object.values(page).find((p: any) => p?.awemeUrl) as any
  const video = found?.awemeUrl ? await probeVideo(found.awemeUrl) : { skipped: 'no aweme url found' }

  return Response.json({ page, video })
}
```

`src/worker.ts` — mount it, behind a token that only staging has:

```ts
// TASK 1 THROWAWAY. Deleted in Task 10. Mounted before route() because /_probe/ is not a
// Route kind and must never become one. PROBE_TOKEN is a staging-only secret: with it
// unset — which is every environment except staging — this branch is unreachable and the
// path falls through to the router like any other unknown path.
if (env.PROBE_TOKEN && url.pathname === `/_probe/${env.PROBE_TOKEN}`) {
  return runProbe(url)
}
```

and in `analytics.ts`'s `Env`: `PROBE_TOKEN?: string`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/probe.test.mjs && npm test && npm run typecheck`
Expected: PASS — 4 new tests, the whole suite still green, typecheck clean.

- [ ] **Step 5: Deploy to staging and MEASURE**

```bash
npx wrangler secret put PROBE_TOKEN          # a long random string
npm run deploy
# Sanity: prod is untouched. This must still be the fxtiktok worker's output.
curl -sI https://megapenispoopenfarten.sex/t/ZTSw2mYwR/ | head -3
```

Find a live post id (a profile page will not give you one — fact 6):
```bash
curl -s 'https://www.tiktok.com/embed/@mysticaquarium' | grep -o '"id":"[0-9]\{15,\}"' | head -5
```
Then, from **real Workers egress**:
```bash
curl -s "https://staging.megapenispoopenfarten.sex/_probe/$PROBE_TOKEN?id=$VIDEO_ID" | tee /tmp/probe-video.json
curl -s "https://staging.megapenispoopenfarten.sex/_probe/$PROBE_TOKEN?id=$SLIDESHOW_ID" | tee /tmp/probe-slideshow.json
```

- [ ] **Step 6: Record the result and take the decision**

Write `docs/research/2026-07-18-tiktok-workers-egress-probe.md` with: the raw JSON for both ids; which UA variants produced `hasItemStruct: true`; the `statusCode`; whether an aweme URL was found; and the video block's `ftyp`, `finalUrlHost` and `contentType` **with the note that content-type is not evidence**. State plainly which branch of the decision tree above applies and what the next task therefore does. If branch 2 applies, **stop here and escalate** — the document is the deliverable and Tasks 2-10 do not start.

- [ ] **Step 7: Commit**

```bash
git add src/probe.ts src/worker.ts src/analytics.ts test/probe.test.mjs docs/research/2026-07-18-tiktok-workers-egress-probe.md
git commit -m "chore: probe TikTok from real Workers egress before building on residential-IP facts

Every TikTok fact the plan rests on was measured from a residential US IP, and
TikTok is demonstrably per-edge IP-sensitive: a correctly-signed URL 403'd on
v16-webapp-prime while the identical signature succeeded on v19-webapp-prime,
6/6. Workers egress from datacenter ranges, so the recon may not transfer.

A throwaway /_probe/{token} endpoint asks the same questions from staging and
reports in the response body — counters only in analytics, and no identifiers.
Unreachable without PROBE_TOKEN, which only staging has; Task 10 deletes the file.

The page fetch is the blocking measurement. The video fetch is informative only:
in production our Worker never fetches the aweme URL, Discord's media proxy does,
from Discord's IPs. Only a real client settles the video.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Routing — TikTok path shapes, with fallthrough

**Files:**
- Modify: `src/router.ts`
- Test: `test/router.test.mjs` (extend)

**Interfaces:**
- Consumes: `Route`, `PostRef`, `Platform`.
- Produces: `tiktok(seg): Route | null`, wired into `matchPost`'s forced and unforced arms.

#### Decisions this task makes, and why

**Scope: post permalinks only. Short links get their own task (Task 6), in this phase.** This task does not touch `'t'` in the `known` set and does not add a `/t/` ambiguity row — Task 6 owns both edits, together with the resolver that makes them mean something. Splitting it that way keeps each task's tests honest: a routing change whose worker half does not exist yet is a test asserting a shape nobody consumes.

`vm.tiktok.com` **stays out of 3a**, and for a reason this task cannot fix: the `vm.` subdomain hint needs the `*.megapenispoopenfarten.sex/*` wildcard, which belongs to the live `fxtiktok` worker. Staging is a single specific hostname, deliberately (Phase 1's smoke test forbids a wildcard route). Spec §Deployment says it outright: *"The staging zone needs the same apex + wildcard shape, or the subdomain-hint path cannot be tested at all."* Shipping untestable routing code is how you ship broken routing code. That one stays recorded in *What Phase 3b will need*.

**Bare `/@{user}` gets honest candidates.** `ambiguity()` currently answers `['x','ig']` for any single segment, but an `@`-prefixed one names a TikTok or Threads profile — X and Instagram do not put `@` in a URL. There is no profile `Route` kind, so this can only ever be a chooser, and the chooser currently offers two links that cannot be right. This is a judgement call, not a measured fact: it is cheap, tested, and reversible in one line. It is the **only** ambiguity-table row this task changes.

- [ ] **Step 1: Write the failing test**

Append to `test/router.test.mjs`:
```js
test('TikTok video and photo permalinks route — depth 3, safe by the depth rule', () => {
  assert.deepEqual(r('/@mysticaquarium/video/7660566211100511518'), {
    kind: 'post',
    ref: { p: 'tt', id: '7660566211100511518' },
    canonical: 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518',
  })
  assert.deepEqual(r('/@someone/photo/7412345678901234567'), {
    kind: 'post',
    ref: { p: 'tt', id: '7412345678901234567' },
    canonical: 'https://www.tiktok.com/@someone/photo/7412345678901234567',
  })
})

test('/@i/video/{id} routes — the username is not needed to resolve a post', () => {
  // Verified 2026-07-18: tiktok.com/@i/video/{id} resolves without knowing the handle.
  // This is what makes PostRef {p:'tt', id} sufficient identity for the platform.
  const got = r('/@i/video/7660566211100511518')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'tt', id: '7660566211100511518' })
})

test('every TikTok path shape for one post collapses to the SAME cache key', () => {
  // refKey is the cache key AND the /_media/ identity. Two spellings of one post must not
  // cost two upstream fetches or split the media namespace.
  const a = r('/@mysticaquarium/video/7660566211100511518')
  const b = r('/@i/video/7660566211100511518')
  const c = r('/tt/@other/photo/7660566211100511518')
  assert.equal(refKey(a.ref), 'tt:7660566211100511518')
  assert.equal(refKey(a.ref), refKey(b.ref))
  assert.equal(refKey(a.ref), refKey(c.ref))
})

test('the /tt/ escape hatch forces TikTok, and FALLS THROUGH when it does not match', () => {
  assert.deepEqual(r('/tt/@u/video/123'), {
    kind: 'post',
    ref: { p: 'tt', id: '123' },
    canonical: 'https://www.tiktok.com/@u/video/123',
  })
  // @tt is a plausible X handle and /tt/status/123 is a real X permalink shape. Forcing
  // TikTok finds nothing there, and the router must fall through rather than dead-end —
  // the defect class fixed in 37386db (/x/status/123) and again for @api.
  assert.deepEqual(r('/tt/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/tt/status/123',
  })
})

test('a TikTok-shaped path is not confused with the Threads shape at the same depth', () => {
  // /@{user}/post/{code} is Threads; segment 2 is the whole discriminator. Threads has no
  // fetcher until Phase 4, so it must be notfound — honest — and NEVER a tt ref.
  const got = r('/@someone/post/DTI1vjIEi5y')
  assert.notEqual(got.kind, 'post', 'a Threads permalink must not be claimed as TikTok')
})

test('a bare @-prefixed segment offers the sites that actually use @ in a URL', () => {
  // Judgement call, not a measured fact: there is no profile Route kind, so this can only
  // ever be a chooser, and x.com//@user / instagram.com/@user are not real links. Revert by
  // deleting the '@' branch in ambiguity().
  const got = r('/@mysticaquarium')
  assert.equal(got.kind, 'ambiguous')
  assert.deepEqual(got.candidates.slice().sort(), ['th', 'tt'])
})

test('ACCEPTANCE: the ambiguity table changes ONLY where this task says it does', () => {
  // Phase 2 shipped this invariant; this task amends it in exactly ONE row (bare /@{user})
  // and must leave every other row alone. Re-asserted in full so an accidental second change
  // cannot ride along. (Task 6 adds /t/{code} as a `shortlink` ROUTE, not an ambiguity row,
  // so this table is still the whole table after Task 6 too.)
  const unchanged = [
    ['/mrbeast', ['x', 'ig']],
    ['/hashtag/nfl', ['x', 'bs']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/explore', ['x', 'ig', 'tt']],
    ['/settings/account', ['x', 'bs', 'rd']],
    ['/i/lists', ['x', 'ig']],
    ['/gallery/abc123', ['rd', 'ig']],
    ['/api', ['x', 'ig']],
    ['/users', ['x', 'ig']],
    ['/_oembed', ['x', 'ig']],
  ]
  for (const [path, candidates] of unchanged) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', `${path} must still be ambiguous, got ${got.kind}`)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
  assert.equal(r('/api/v1').kind, 'notfound')
  assert.equal(r('/users/someone').kind, 'notfound')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/router.test.mjs`
Expected: FAIL — the TikTok shapes return `notfound`, and `/@mysticaquarium` returns `['x','ig']`. The Threads-shape test and the `/tt/status/123` fallthrough half already pass; they are regression guards on behaviour this task must not break.

- [ ] **Step 3: Write minimal implementation**

In `src/router.ts`:

```ts
/**
 * TikTok post permalinks. Depth 3, unconditionally safe by the spec's depth rule —
 * Instagram 404s at depth 3 — and the leading '@' is a second, independent marker
 * (reddit.com/@spez 404s).
 *
 * `video` vs `photo` is a UI distinction, not identity: both mint the same numeric id and
 * both must produce the SAME ref, so refKey collapses every spelling of one post onto one
 * cache entry and one /_media/ namespace. Segment 2 is also the entire discriminator against
 * Threads' /@{user}/post/{code} at the same depth — so match it exactly, never loosely.
 *
 * canonical keeps the user segment the caller gave us, because that is where worker.ts 302s
 * a human. The normalizer rebuilds its own canonical from the payload instead (it only has
 * the ref), which is why /@i/video/{id} resolving without a username is load-bearing there.
 *
 * SHORT LINKS (/t/{code}) ARE NOT HERE, and never will be. route() is synchronous, so a short
 * code cannot become a PostRef in this function — it is not a post id and pretending otherwise
 * would be guessing against Threads, which mints the same shape. They get their own Route kind
 * instead, resolved asynchronously in worker.ts: see the `shortlink` branch below.
 */
function tiktok(seg: string[]): Route | null {
  if (seg.length === 3 && seg[0].startsWith('@') && seg[0].length > 1 && seg[2]) {
    if (seg[1] !== 'video' && seg[1] !== 'photo') return null
    return {
      kind: 'post',
      ref: { p: 'tt', id: seg[2] },
      canonical: `https://www.tiktok.com/${seg[0]}/${seg[1]}/${seg[2]}`,
    }
  }
  return null
}
```

`matchPost` gains the arm — forced *and* unforced:
```ts
function matchPost(seg: string[], forced?: Platform): Route | null {
  if (forced === 'bs') return bluesky(seg)
  if (forced === 'x') return x(seg)
  if (forced === 'tt') return tiktok(seg)
  if (forced) return null
  return bluesky(seg) ?? x(seg) ?? tiktok(seg)
}
```

`ambiguity()` gains exactly one row:
```ts
  if (seg.length === 1) {
    ...
    // Only TikTok and Threads put '@' in a profile URL; x.com/@user and instagram.com/@user
    // are not real links, so offering them in a chooser is offering two dead ends.
    if (a.startsWith('@')) return ['tt', 'th']
    return ['x', 'ig']
  }
```

`known` is **not** touched here — `'t'` stays in the dead-end set until Task 6 replaces it with the resolver.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/router.test.mjs && npm test && npm run typecheck`
Expected: PASS — 7 new tests, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router.test.mjs
git commit -m "feat: route TikTok video and photo permalinks

/@{user}/video/{id} and /@{user}/photo/{id} are depth 3 — unconditionally safe by
the depth rule — and segment 2 is the whole discriminator against Threads'
/@{user}/post/{code} at the same depth, so it is matched exactly. Both kinds
produce the same {p:'tt', id} ref, so every spelling of one post collapses onto
one cache entry and one /_media/ namespace.

The /tt/ escape hatch falls through on a miss rather than dead-ending, so
/tt/status/123 still routes as a real X post — the defect fixed once for
/x/status/123 and again for @api.

A bare @-prefixed segment now offers TikTok and Threads rather than X and
Instagram: neither of the latter puts '@' in a URL, so the chooser was offering
two links that cannot resolve. That is the only ambiguity-table row this commit
changes, and the acceptance test re-asserts the rest of the table in full.

Short links are deliberately absent from this commit: route() is synchronous, so
a short code cannot become a PostRef here at all — it is not a post id, and
Threads mints the same shape. They get their own Route kind and their own
resolver in the next commit.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: TikTok fixtures + normalizer (pure, no network)

**Files:**
- Create: `test/fixtures/tiktok-video.html`, `test/fixtures/tiktok-slideshow.html`, `test/fixtures/tiktok-deleted.html`
- Create: `src/platforms/tiktok/normalize.ts`
- Test: `test/tiktok-normalize.test.mjs`

**Interfaces:**
- Consumes: `Post`, `PostRef`, `Media`; a page HTML string.
- Produces: `normalizeTikTok(html: unknown, ref: PostRef): Post | null` — pure, total, returns `null` rather than inventing a Post.

**Why the normalizer takes HTML rather than a parsed blob:** the extraction (find the script element, `JSON.parse` it, walk to `itemStruct`) is pure and is exactly where a platform change will break us first. Keeping it inside the pure module makes it testable against real captured bytes with no network — which is the whole reason Bluesky's normalizer has fourteen tests and zero mocks. `fetch.ts` (Task 4) does nothing but I/O and a content assertion.

- [ ] **Step 1: Capture three fixtures, then look at what you actually got**

Find ids (profile pages and `/explore` do NOT server-render them; the embed page does — fact 6):
```bash
curl -s 'https://www.tiktok.com/embed/@mysticaquarium' | grep -o '"id":"[0-9]\{15,\}"' | head -10
```

Capture with a **plain Chrome UA** (a crawler UA returns the ~7KB decoy — fact 1). Extract the blob and re-wrap it minimally.

**Why re-wrap — and it is NOT about size.** Measured 2026-07-18: the blob is **286,362 of 314,695 bytes, or 91% of the page**, so re-wrapping strips roughly **9%**, not "250KB of React shell". The practice is still right, for two reasons that have nothing to do with bytes: it makes the fixture a **self-contained, stable** artifact (no `<link>`s to dead CDN builds, no A/B-varying markup, nothing that changes between two captures of the same post), and it keeps the extractor honest by leaving exactly one thing in the file for it to find. Do not drop the re-wrapping, and do not justify it with a size claim.

```bash
mkdir -p test/fixtures
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
cap() {  # cap <id> <outfile>
  curl -s -A "$UA" "https://www.tiktok.com/@i/video/$1" > /tmp/raw.html
  python3 - "$2" <<'PY'
import re, sys
raw = open('/tmp/raw.html', encoding='utf-8').read()
m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', raw, re.S)
assert m, 'no rehydration blob — check the UA, a crawler UA gets a 7KB decoy'
blob = m.group(1)
assert '</script>' not in blob, 'blob contains a literal </script>; the extractor regex must stay non-greedy AND this fixture must preserve it verbatim'
open(sys.argv[1], 'w', encoding='utf-8').write(
  '<!doctype html><html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" '
  'type="application/json">' + blob + '</script></head><body></body></html>')
print(sys.argv[1], len(blob), 'bytes of blob')
PY
}
cap "$VIDEO_ID"     test/fixtures/tiktok-video.html
cap "$SLIDESHOW_ID" test/fixtures/tiktok-slideshow.html
```

**Getting a `$DELETED_ID` — a concrete, verified procedure, not "any id known to be gone".** You do not need to find a post that was actually deleted. Take a real id and **mutate its last digit**; the id space is sparse, so the mutant names nothing. Verified 2026-07-18:

```
@i/video/7660566211100511518  ->  http 200, 385,903 bytes, statusCode 0,     itemStruct present
@i/video/7660566211100511517  ->  http 200, 358,278 bytes, statusCode 10204, itemStruct ABSENT
                                  statusMsg "item doesn't exist"
```

So: mutate, then **verify before keeping it** — a mutant that happens to hit a live post would give you a fixture that silently tests nothing.

```bash
DELETED_ID=$(python3 -c "i='$VIDEO_ID'; print(i[:-1] + str((int(i[-1]) + 1) % 10))")
cap "$DELETED_ID" test/fixtures/tiktok-deleted.html
python3 - <<'PY'
import json, re
raw = open('test/fixtures/tiktok-deleted.html', encoding='utf-8').read()
d = json.loads(re.search(r'type="application/json">(.*?)</script>', raw, re.S).group(1))
d = d['__DEFAULT_SCOPE__']['webapp.video-detail']
assert d.get('statusCode') == 10204, f"not the deleted shape: statusCode={d.get('statusCode')!r} — mutate a different digit"
assert not d.get('itemInfo', {}).get('itemStruct'), 'this id is LIVE — mutate a different digit'
print('deleted fixture OK:', d.get('statusCode'), repr(d.get('statusMsg')))
PY
```

**The blob is re-wrapped, never reformatted** — no `json.dumps`, no re-indent. The bytes between the tags are exactly what TikTok sent, so escaping quirks (notably `<` for `<`) are preserved and the extractor is tested against them rather than against a prettified idealisation. If the `</script>` assertion ever fires, keep the fixture verbatim and make the extractor's regex non-greedy to the *first* `</script>` — do not "fix" the fixture.

Now **inspect** the two live shapes before writing a single line of the branch:
```bash
python3 - <<'PY'
import json, re
for f in ('video', 'slideshow', 'deleted'):
    raw = open(f'test/fixtures/tiktok-{f}.html', encoding='utf-8').read()
    blob = re.search(r'type="application/json">(.*?)</script>', raw, re.S).group(1)
    d = json.loads(blob)['__DEFAULT_SCOPE__']['webapp.video-detail']
    print('==', f, 'statusCode:', d.get('statusCode'), 'statusMsg:', d.get('statusMsg'))
    it = d.get('itemInfo', {}).get('itemStruct')
    if not it: print('   no itemStruct'); continue
    print('   keys:', sorted(it.keys()))
    print('   imagePost?', 'imagePost' in it)
    print('   desc:', it.get('desc', '')[:60])
    # FACT 9, in your own data. createTime is a STRING; stats mixes str and int.
    print('   createTime:', repr(it.get('createTime')), type(it.get('createTime')).__name__)
    print('   stats types:', {k: type(v).__name__ for k, v in it.get('stats', {}).items()})
    if 'imagePost' in it: print('   imagePost:', json.dumps(it['imagePost'])[:800])
    v = it.get('video', {})
    print('   video w/h/dur:', v.get('width'), v.get('height'), v.get('duration'))
    urls = [u for b in v.get('bitrateInfo', []) for u in b.get('PlayAddr', {}).get('UrlList', [])]
    print('   aweme urls:', sum('/aweme/v1/play/' in u for u in urls), 'of', len(urls))
PY
```

**Write the slideshow branch against what this prints, not from memory.** Recon verified the *presence of an `imagePost` key* as the video/slideshow discriminator; it did **not** enumerate that object's interior. Whatever `imagePost` actually contains is what the branch reads. Do not port upstream fxTikTok's field names on faith — they are a different snapshot of the same adversarial platform, and the fixture in front of you is the evidence.

- [ ] **Step 2: Write the failing test**

`test/tiktok-normalize.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeTikTok } from '../src/platforms/tiktok/normalize.ts'

const html = f => readFileSync(`test/fixtures/tiktok-${f}.html`, 'utf8')
const VIDEO = html('video')
const SLIDES = html('slideshow')
const DELETED = html('deleted')

// Fill these in from the Step 1 inspection output.
const VIDEO_REF = { p: 'tt', id: 'REPLACE_WITH_VIDEO_ID' }
const SLIDES_REF = { p: 'tt', id: 'REPLACE_WITH_SLIDESHOW_ID' }

test('a video post normalizes into a well-formed Post', () => {
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  assert.ok(post, 'must normalize')
  assert.deepEqual(post.ref, VIDEO_REF)
  assert.ok(post.author.handle.length > 0)
  assert.ok(post.createdAt instanceof Date)
  // Fact 9: createTime is a decimal STRING of Unix SECONDS ('1783614572'). A `typeof === 'number'`
  // guard returns null here for every real post; `new Date(str)` without *1000 is 1970.
  assert.ok(!Number.isNaN(post.createdAt.getTime()), 'createTime is a STRING of SECONDS — Number() it, then *1000')
  assert.ok(post.createdAt.getUTCFullYear() > 2015, `a bare new Date(seconds) lands in 1970, got ${post.createdAt.toISOString()}`)
  assert.equal(typeof post.text, 'string')
  assert.equal(post.sensitive, false, 'TikTok does not expose a sensitivity signal — spec says always false')
})

test('canonical is rebuilt from the PAYLOAD, since the ref carries only an id', () => {
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  assert.match(post.canonical, /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/REPLACE_WITH_VIDEO_ID$/)
})

test('canonical degrades to the @i form when the payload has no uniqueId', () => {
  // Verified 2026-07-18: tiktok.com/@i/video/{id} resolves without knowing the username, so
  // the degrade is a WORKING link rather than a plausible-looking dead one.
  const stripped = VIDEO.replace(/"uniqueId":"[^"]*"/, '"uniqueId":""')
  const post = normalizeTikTok(stripped, VIDEO_REF)
  assert.equal(post.canonical, 'https://www.tiktok.com/@i/video/REPLACE_WITH_VIDEO_ID')
})

test('THE VIDEO URL IS THE /aweme/v1/play/ ONE, selected by substring and never by index', () => {
  // playAddr and the *-webapp-prime hosts are cookie-gated (tk=tt_chain_token) and 403 without
  // a cookie, which is exactly what Discord's media proxy sends. The aweme endpoint
  // content-negotiates on cookies: cookie-free it 302s to a working tiktokcdn-us host.
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  const v = post.media.find(m => m.kind === 'video')
  assert.ok(v, 'a video post must yield a video Media entry')
  assert.ok(v.url.includes('/aweme/v1/play/'), `must be the aweme URL, got ${v.url}`)
  assert.ok(!v.url.includes('webapp-prime'), 'a cookie-gated host must never be handed out')
  assert.ok(v.w > 0 && v.h > 0, 'dimensions come from video.width/height')
})

test('the aweme URL is picked by CONTENT even when it is not first in the list', () => {
  // Upstream okdargy/fxTikTok selects by substring (src/generate.ts:63) and index position is
  // not guaranteed stable. Proven on a synthetic list rather than by trusting the fixture's
  // current ordering, which would make this test pass for the wrong reason.
  const raw = {
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': {
        statusCode: 0,
        itemInfo: { itemStruct: {
          // STRING createTime and a MIXED stats object, exactly as the live payload spells them
          // (fact 9). Written this way deliberately: a synthetic fixture with a NUMBER here
          // passes against a `typeof === 'number'` normalizer that returns null for every real
          // post, so the green synthetic test would argue the real fixture was wrong.
          id: '1', desc: 'x', createTime: '1750000000',
          author: { uniqueId: 'u', nickname: 'U' },
          stats: { diggCount: 21000, playCount: '75900' },
          video: {
            width: 720, height: 1280, duration: 10, cover: 'https://cdn/c.jpg',
            playAddr: 'https://v16-webapp-prime.tiktok.com/gated.mp4?tk=tt_chain_token',
            bitrateInfo: [{ PlayAddr: { UrlList: [
              'https://v16-webapp-prime.tiktok.com/a.mp4?tk=tt_chain_token',
              'https://v19-webapp-prime.tiktok.com/b.mp4?tk=tt_chain_token',
              'https://www.tiktok.com/aweme/v1/play/?video_id=v&file_id=f',
            ] } }],
          },
        } },
      },
    },
  }
  const wrapped = `<!doctype html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`
  const post = normalizeTikTok(wrapped, { p: 'tt', id: '1' })
  assert.equal(post.media[0].url, 'https://www.tiktok.com/aweme/v1/play/?video_id=v&file_id=f')
})

test('STRING createTime and STRING counts COERCE — the live payload spells them that way', () => {
  // The same synthetic post as above, re-asserted for fact 9. This is the test that fails if
  // anyone "tightens" the normalizer to `typeof x === 'number'`: that guard is the natural
  // defensive write in this repo, it matches build()'s Bluesky shape, and it returns null for
  // 100% of real TikTok posts. Coerce with Number() and reject NaN — never type-guard.
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000',
      author: { uniqueId: 'u', nickname: 'U' },
      stats: { diggCount: 21000, playCount: '75900', commentCount: '7' },
      video: { width: 720, height: 1280, cover: 'https://cdn/c.jpg',
        bitrateInfo: [{ PlayAddr: { UrlList: ['https://www.tiktok.com/aweme/v1/play/?video_id=v'] } }] },
    } } } },
  }
  const post = normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  )
  assert.ok(post, 'a STRING createTime must not make the whole post null')
  assert.equal(post.createdAt.getTime(), 1750000000 * 1000)
  assert.equal(post.counts.likes, 21000, 'a NUMBER count survives')
  assert.equal(post.counts.views, 75900, 'a STRING count is coerced, not dropped and not kept as a string')
  assert.equal(post.counts.replies, 7)
})

test('a count that cannot be a number is ABSENT, never NaN and never a string', () => {
  // NaN JSON-serializes to null and would reach a renderer as a count of "null"; a string
  // would reach mastodon.ts's payload as a quoted value where a number is required.
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: '1750000000', author: { uniqueId: 'u' },
      stats: { diggCount: 'lots', playCount: null, commentCount: {} },
      video: { width: 720, height: 1280, cover: 'https://cdn/c.jpg' },
    } } } },
  }
  const post = normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  )
  assert.ok(post)
  for (const k of ['likes', 'reposts', 'replies', 'views']) {
    assert.ok(!(k in post.counts) || typeof post.counts[k] === 'number', k)
    assert.ok(!Number.isNaN(post.counts[k]), `${k} must be absent, not NaN`)
  }
})

test('an unparseable createTime is NULL, not a 1970 post', () => {
  const raw = {
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: {
      id: '1', desc: 'x', createTime: 'not-a-time', author: { uniqueId: 'u' }, stats: {}, video: {},
    } } } },
  }
  assert.equal(normalizeTikTok(
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(raw)}</script>`,
    { p: 'tt', id: '1' },
  ), null)
})

test('NO aweme URL degrades to the cover image, never to a gated URL', () => {
  // Phase 1's I-1 lesson, restated for a new platform: an og:video pointing at something that
  // cannot play renders a DEAD player and suppresses og:image, so the post shows nothing at
  // all. A still is strictly better than a blank player. Bluesky's HLS handling is the same
  // rule with a different cause.
  const noAweme = VIDEO.replace(/https:\\?\/\\?\/www\.tiktok\.com\\?\/aweme\\?\/v1\\?\/play\\?\/[^"]*/g, 'https://v16-webapp-prime.tiktok.com/gated.mp4')
  const post = normalizeTikTok(noAweme, VIDEO_REF)
  assert.ok(!post.media.some(m => m.kind === 'video'), 'no playable url must mean no video entry')
  assert.ok(!post.media.some(m => m.url.includes('webapp-prime')), 'a gated url must never be surfaced')
  // NOT `if (post.media.length)`. Behind that guard, media:[] passes with zero assertions run —
  // the silently-vacuous shape Phase 2 only caught by mutation testing. The fixture HAS a
  // video.cover, so the degrade must produce exactly one image entry; asserting the count first
  // is what makes the kind assertion able to fail.
  assert.equal(post.media.length, 1, 'the cover must still produce one entry — a video post is not media-less')
  assert.equal(post.media[0].kind, 'image', 'the cover becomes a plain image entry')
  assert.match(post.media[0].url, /^https:\/\//)
})

test('a video post emits EXACTLY ONE media entry — the video, with no trailing cover', () => {
  // A second entry would be a picture nothing selects on the carve-out path (Task 7 finds the
  // video first) and a spurious second gallery item if the spoof ever ran on it.
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  assert.equal(post.media.length, 1)
})

test('A SLIDESHOW YIELDS EVERY IMAGE — this is the Phase 2 gallery path, for free', () => {
  const post = normalizeTikTok(SLIDES, SLIDES_REF)
  assert.ok(post, 'must normalize')
  assert.ok(post.media.length >= 2, `expected a multi-image slideshow, got ${post.media.length}`)
  for (const m of post.media) {
    assert.equal(m.kind, 'image')
    assert.match(m.url, /^https:\/\//)
  }
  assert.ok(!post.media.some(m => m.kind === 'video'), 'a slideshow has no video entry')
  assert.match(post.canonical, /\/photo\//, 'a slideshow canonical uses the /photo/ form')
})

test('the video/slideshow discriminator is the imagePost KEY, not a guess about media', () => {
  assert.ok(SLIDES.includes('imagePost'), 'fixture sanity: the slideshow carries imagePost')
  assert.ok(!VIDEO.includes('"imagePost"'), 'fixture sanity: the video post does not')
})

test('A DELETED POST IS NULL — HTTP 200 and a 287KB page prove nothing', () => {
  // Verified 2026-07-18: a deleted post returns HTTP 200 with a full page and a VALID blob
  // carrying statusCode 10204 / "item doesn't exist" and no itemStruct. Status is not evidence.
  assert.equal(normalizeTikTok(DELETED, { p: 'tt', id: '1' }), null)
  assert.ok(DELETED.includes('10204'), 'fixture sanity: this really is the deleted shape')
})

test('a nonzero statusCode is null even when an itemStruct is somehow present', () => {
  // Belt and braces: the assertion is on statusCode, not on "did we find something usable".
  const raw = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 10204, itemInfo: { itemStruct: {
      id: '1', desc: 'ghost', createTime: 1750000000, author: { uniqueId: 'u' }, stats: {}, video: {},
    } } } },
  })}</script>`
  assert.equal(normalizeTikTok(raw, { p: 'tt', id: '1' }), null)
})

test('counts map to the shared shape — and AT LEAST ONE really arrives', () => {
  // Every assertion in the first draft of this test sat behind `!== undefined`, so counts:{}
  // passed it with zero assertions executed. That is the silently-vacuous pattern Phase 2 only
  // caught by mutation testing, and it is the WORST test in this file to leave toothless:
  // TikTok's stats are genuinely mixed-typed (fact 9), so this is the assertion standing
  // between a string count and mastodon.ts's payload.
  const post = normalizeTikTok(VIDEO, VIDEO_REF)
  // The live payload always carries diggCount and playCount. Unconditional, so a normalizer
  // that dropped every count on the floor turns this red instead of green.
  assert.equal(typeof post.counts.likes, 'number', 'likes <- stats.diggCount must be present and numeric')
  assert.ok(Number.isFinite(post.counts.likes) && post.counts.likes > 0)
  assert.equal(typeof post.counts.views, 'number', 'views <- stats.playCount must be present and numeric')
  assert.ok(Number.isFinite(post.counts.views) && post.counts.views > 0)
  // The rest are optional in shape, but never the WRONG type when present.
  for (const k of ['likes', 'reposts', 'replies', 'views']) {
    if (post.counts[k] !== undefined) {
      assert.equal(typeof post.counts[k], 'number', `${k} must be a number, not the string TikTok may have sent`)
      assert.ok(Number.isFinite(post.counts[k]), `${k} must not be NaN`)
    }
  }
})

test('returns null on junk rather than throwing or inventing a Post', () => {
  for (const junk of [
    null, undefined, 42, '', '<html></html>',
    '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">not json</script>',
    '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{}</script>',
    // The ~7KB crawler decoy: HTTP 200, no blob at all.
    '<html><head><meta property="og:title" content="TikTok · Mystic Aquarium"></head></html>',
  ]) {
    assert.doesNotThrow(() => normalizeTikTok(junk, { p: 'tt', id: '1' }), String(junk).slice(0, 40))
    assert.equal(normalizeTikTok(junk, { p: 'tt', id: '1' }), null, String(junk).slice(0, 40))
  }
})

test('normalizeTikTok refuses a ref that is not a tt ref', () => {
  assert.equal(normalizeTikTok(VIDEO, { p: 'bs', handle: 'a', rkey: 'b' }), null)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/tiktok-normalize.test.mjs`
Expected: FAIL — cannot find `../src/platforms/tiktok/normalize.ts`.

- [ ] **Step 4: Write minimal implementation**

`src/platforms/tiktok/normalize.ts`. The load-bearing decisions, each of which has a test above:

- **Extraction:** non-greedy match to the *first* `</script>`, `JSON.parse` inside a `try`, walk `__DEFAULT_SCOPE__["webapp.video-detail"]`. No `SIGI_STATE` anywhere.
- **`statusCode !== 0` → `null`.** Checked before anything is read out of `itemInfo`. Note the check is on `statusCode`, so an **absent** `webapp.video-detail` scope (`undefined !== 0`) returns null too — which is exactly what Task 6's short-link resolver relies on when a code turns out not to be TikTok.
- **`createTime` is a decimal STRING of SECONDS (fact 9).** Coerce, then scale, then reject:
  ```ts
  const t = Number(item?.createTime)          // '1783614572' -> 1783614572
  if (!Number.isFinite(t)) return null        // NOT typeof === 'number'
  const createdAt = new Date(t * 1000)
  ```
  **Do not write `typeof item.createTime === 'number' ? … : NaN`.** It is the natural defensive shape in this repo — it is what `build()` does for Bluesky — and here it rejects **every real post** while every synthetic fixture keeps passing. `Number(null)` is `0` and `Number('')` is `0`, so guard the *absent* case on `item?.createTime == null` as well if you want a null rather than a 1970 post.
- **`stats` is MIXED-TYPED (fact 9): `diggCount: 21000` beside `collectCount: '2996'`.** Map each count through one helper, not four inline reads:
  ```ts
  /** A count, or ABSENT. Never NaN (it serializes to null) and never a string. */
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return typeof v !== 'object' && v !== null && v !== '' && Number.isFinite(n) ? n : undefined
  }
  ```
  `likes ← diggCount`, `views ← playCount`, `replies ← commentCount`, `reposts ← shareCount`. Omit a key entirely rather than emitting `NaN` — `JSON.stringify(NaN)` is `null`, which reaches a renderer as a count of nothing and a Mastodon payload with a null where a number belongs.
- **Video URL:** flatten every `bitrateInfo[].PlayAddr.UrlList` (plus `playAddr` itself, so the search is over everything available) and `find(u => u.includes('/aweme/v1/play/'))`. **Never an index.** No match → **no video entry**; fall back to `video.cover` as a plain `kind:'image'` entry, or nothing.
- **Slideshow:** `'imagePost' in item` → images only, written against the Step 1 inspection output.
- **`canonical`:** `https://www.tiktok.com/@{uniqueId}/{video|photo}/{ref.id}`, degrading to `@i` when `uniqueId` is missing or empty.
- **`sensitive: false`,** always — TikTok exposes no signal (spec §Sensitivity).
- **Totality:** every read defensive, `null` over a half-built Post. The reference implementation for the shape and the tone of the comments is `src/platforms/bluesky/normalize.ts`; mirror it.

Carry a comment at the top of the file recording fact 1 (the UA inversion) in one sentence, and a comment on the URL selection recording fact 4 and the upstream citation (`okdargy/fxTikTok src/generate.ts:63`, and the cookie-behaviour comment at `src/generate.ts:91-92`).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/tiktok-normalize.test.mjs && npm test && npm run typecheck`
Expected: PASS — 17 new tests, full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/platforms/tiktok/normalize.ts test/tiktok-normalize.test.mjs test/fixtures/tiktok-*.html
git commit -m "feat: TikTok normalizer — video and slideshow, from real captured payloads

Parses __UNIVERSAL_DATA_FOR_REHYDRATION__ (SIGI_STATE is gone) and asserts on
statusCode, not HTTP status: a deleted post returns 200 with a full 287KB page and
a structurally valid blob carrying statusCode 10204 and no itemStruct.

The video URL is the /aweme/v1/play/ entry, selected by SUBSTRING and never by
index. playAddr and the *-webapp-prime hosts are cookie-gated (tk=tt_chain_token)
and 403 without a cookie — which is exactly what Discord's media proxy sends. The
aweme endpoint content-negotiates on cookies and, cookie-free, 302s to a working
tiktokcdn-us host: verified 200, video/mp4, 12,550,214 bytes, ftyp at 4-8. It is
also deterministic across sessions (two fetches, byte-identical URLs; its
signaturev3 decodes to stable ids with no timestamp), so it is safe to cache for
the full Post TTL. No aweme URL degrades to the cover image, never to a gated URL
— Phase 1's I-1 lesson: a dead player also suppresses og:image, so the post shows
nothing at all.

An imagePost key discriminates a slideshow, whose images flow through Phase 2's
Mastodon-spoof gallery path with no renderer changes at all.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: TikTok fetcher (I/O only)

**Files:**
- Create: `src/platforms/tiktok/fetch.ts`
- Test: `test/tiktok-normalize.test.mjs` (extend — the fetcher's own assertions are testable without network)

**Interfaces:**
- Consumes: `Extract<PostRef, {p:'tt'}>`.
- Produces: `fetchTikTok(ref): Promise<TikTokFetch>` — the page HTML, or a **reason** it is absent.

#### Why this returns a reason and not `null`

Right now every way a TikTok fetch can fail collapses into one counter, `fetch_fail`. A renamed rehydration blob, a 429, an edge block and a wave of genuinely deleted links would all look **identical** in analytics — and they call for opposite responses. The first three mean *we* are broken and 3a's core assumption has expired; the last means the platform is working exactly as designed.

`Outcome2` already declares **`assert_fail`** and it is used nowhere in the codebase (`src/analytics.ts:17`). This is what it was declared for. The split is:

| What happened | Counter |
|---|---|
| The **PAGE** did not answer: no rehydration marker — blob renamed, block page, 429, edge interstitial | **`assert_fail`** |
| The **POST** was rejected: `statusCode != 0`, deleted, no `itemStruct` | `fetch_fail` |
| A thrown `fetch()` (DNS, timeout, reset) | `fetch_fail` |

A thrown fetch stays `fetch_fail` deliberately: `getPost`'s existing `try/catch` cannot tell a transport failure from anything else, and folding it into `assert_fail` would dilute the one signal that counter exists to carry — *TikTok changed something*.

The counters **stack**, they do not replace: an `assert_fail` is also counted as a `fetch_fail` by the worker's existing null path. That is this file's established pattern, not an accident — `worker.ts`'s activity/oembed case already counts `fetch_fail` on top of `api_miss` for exactly this reason ("without it a cold success and a cold failure emit byte-identical analytics"). So `assert_fail / fetch_fail` reads as *"of the failures, this fraction were the page assertion"*, and the alert to write later is on that ratio moving.

- [ ] **Step 1: Write the failing test**

The fetcher does I/O, so what is testable offline is its *contract*: the UA it sends, its content assertion, and — new here — how it **classifies** a body it does not like. All three are the things most likely to be edited wrongly later, and the classification is pure, so it needs no network and no stubbed globals.

Append to `test/tiktok-normalize.test.mjs`:
```js
import { TIKTOK_UA, hasRehydrationPayload, pageOutcome } from '../src/platforms/tiktok/fetch.ts'

test('THE UA IS NOT CRAWLER-SHAPED — TikTok is INVERTED from Instagram', () => {
  // Verified 2026-07-18: facebookexternalhit / Discordbot / Twitterbot all get HTTP 200 with
  // a ~7KB stub — no caption, no playAddr, og:title "TikTok · Mystic Aquarium". bingbot gets
  // 403. Instagram is the OPPOSITE: there the crawler UA works and Chrome gets a decoy. A
  // future reader WILL conflate the two, so this asserts the difference mechanically.
  const s = TIKTOK_UA.toLowerCase()
  for (const bad of ['bot', 'crawler', 'spider', 'preview', 'facebookexternalhit', 'discord']) {
    assert.ok(!s.includes(bad), `TIKTOK_UA must not look like a crawler (contains "${bad}")`)
  }
  assert.match(TIKTOK_UA, /Mozilla\/5\.0/)
})

test('the fetcher asserts on CONTENT, and the crawler decoy fails that assertion', () => {
  // The decoy is HTTP 200 with a valid content-type. Only the payload distinguishes it.
  assert.equal(hasRehydrationPayload(VIDEO), true)
  assert.equal(hasRehydrationPayload('<html><head><meta property="og:title" content="TikTok · Mystic Aquarium"><meta property="og:description" content="TikTok | Make Your Day"></head></html>'), false)
  assert.equal(hasRehydrationPayload(''), false)
  assert.equal(hasRehydrationPayload(null), false)
})

test('the DELETED page still passes the fetch-layer assertion — rejection is the normalizer\'s job', () => {
  // Deliberate division of labour: the fetcher only asks "did I get a real page", because a
  // deleted post DOES return one. "Is there a post in it" is a statusCode question, and
  // putting it in the fetcher would mean parsing the blob twice and having two places that
  // can disagree about what "no post" means.
  assert.equal(hasRehydrationPayload(DELETED), true)
  assert.equal(normalizeTikTok(DELETED, { p: 'tt', id: '1' }), null)
})

test('A BLOCKED OR CHANGED PAGE IS assert_fail, NOT fetch_fail — and never throws', () => {
  // The whole point of the split. Today all three of these look identical to a wave of
  // genuinely deleted posts, which is how "TikTok renamed the blob" would go unnoticed for a
  // week. pageOutcome is PURE, so this needs no network and no stubbed global fetch.
  const cases = {
    '429': '<html><head><title>429 Too Many Requests</title></head><body>rate limited</body></html>',
    // The marker RENAMED — the single most likely way this phase dies. Note the rename must
    // not merely append: hasRehydrationPayload is a substring test, so '..._V2' with the old
    // name still inside it would (correctly) still match.
    renamed: VIDEO.replaceAll('__UNIVERSAL_DATA_FOR_REHYDRATION__', '__UNIVERSAL_DATA_2__'),
    interstitial: '<html><body>Access Denied</body></html>',
    empty: '',
    // The crawler decoy from fact 1: HTTP 200, plausible content-type, ~7KB, no payload.
    decoy: '<html><head><meta property="og:title" content="TikTok · Mystic Aquarium"></head></html>',
  }
  for (const [name, body] of Object.entries(cases)) {
    let got
    assert.doesNotThrow(() => { got = pageOutcome(body) }, name)
    assert.equal(got.ok, false, name)
    assert.equal(got.reason, 'assert_fail', name)
  }
  // Non-strings from a hostile or broken caller degrade the same way.
  for (const junk of [null, undefined, 42, {}]) {
    assert.equal(pageOutcome(junk).ok, false, String(junk))
    assert.equal(pageOutcome(junk).reason, 'assert_fail', String(junk))
  }
})

test('a real page is ok:true and carries the body through unmodified', () => {
  const got = pageOutcome(VIDEO)
  assert.equal(got.ok, true)
  assert.equal(got.html, VIDEO, 'the body must reach the normalizer byte-for-byte')
  // A deleted post is a REAL page. It is ok at this layer and null at the next one.
  assert.equal(pageOutcome(DELETED).ok, true, 'a deleted post is not an assertion failure')
})
```

and add `pageOutcome` to the import at the top of the block.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tiktok-normalize.test.mjs`
Expected: FAIL — cannot find `../src/platforms/tiktok/fetch.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/platforms/tiktok/fetch.ts`:
```ts
import type { PostRef } from '../../types.ts'

/**
 * TIKTOK'S UA GATE IS INVERTED FROM INSTAGRAM'S. Verified live 2026-07-18:
 *
 *   facebookexternalhit / Discordbot / Twitterbot -> HTTP 200, ~7KB stub, NO caption,
 *     NO playAddr, og:title "TikTok · Mystic Aquarium", og:description "TikTok | Make Your Day"
 *   bingbot                                        -> HTTP 403
 *   a plain Chrome UA, or no UA at all             -> the real page
 *
 * Instagram is the exact opposite — there the CRAWLER UA is the one that works and a Chrome
 * UA gets a 599KB decoy at HTTP 200 — and this project's Instagram notes say so in language
 * that reads almost identically to this paragraph. Do not "fix" this file to match them.
 *
 * An explicit UA rather than relying on sending none: both were verified to work, but "none"
 * makes our behaviour depend on whatever the runtime does or does not add by default, which
 * is not a property we control or can test.
 */
export const TIKTOK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MARKER = '__UNIVERSAL_DATA_FOR_REHYDRATION__'

/**
 * "This is a real post page." NOT "there is a post in it" — a DELETED post returns a full
 * 287KB page with a valid blob (statusCode 10204, no itemStruct), and deciding that is the
 * normalizer's job. Two places answering it is two places that can disagree.
 */
export function hasRehydrationPayload(body: unknown): boolean {
  return typeof body === 'string' && body.includes(MARKER)
}

/**
 * "The PAGE did not answer" vs "the POST was rejected" — two different failures that used to
 * share one counter, so a renamed blob, a 429 and a wave of deleted links were indistinguishable.
 *
 * assert_fail means WE are broken: the marker is gone, so this is a block page, a rate limit, an
 * interstitial, or TikTok renaming the rehydration blob. fetch_fail (decided one layer up, by the
 * normalizer's statusCode check) means the PLATFORM is working correctly and the post is not
 * there. Outcome2 has declared assert_fail since Phase 1 and nothing has ever emitted it.
 */
export type TikTokFetch =
  | { ok: true; html: string }
  | { ok: false; reason: 'assert_fail' }

/** PURE, so the classification is testable with no network and no stubbed globals. */
export function pageOutcome(body: unknown): TikTokFetch {
  return hasRehydrationPayload(body)
    ? { ok: true, html: body as string }
    : { ok: false, reason: 'assert_fail' }
}

/**
 * ASSERT ON CONTENT, NEVER ON STATUS. The decoy above is HTTP 200 with a plausible
 * content-type, so neither is evidence of anything. `/@i/video/{id}` is used because it
 * resolves without knowing the username (verified 2026-07-18) — which is what lets
 * PostRef {p:'tt', id} be sufficient identity for the platform.
 *
 * A THROWN fetch is deliberately not caught here: worker.ts's getPost already treats a thrown
 * live-fetch as a null, and that is a transport failure rather than evidence about TikTok's
 * gate. Catching it here to relabel it assert_fail would dilute the one signal this type exists
 * to carry.
 */
export async function fetchTikTok(ref: Extract<PostRef, { p: 'tt' }>): Promise<TikTokFetch> {
  const res = await fetch(`https://www.tiktok.com/@i/video/${encodeURIComponent(ref.id)}`, {
    headers: { 'user-agent': TIKTOK_UA, accept: 'text/html' },
  })
  return pageOutcome(await res.text())
}
```

**If Task 1 landed on decision-tree branch 3** (page works, aweme URL 403s from our egress), this is where the resolve-the-302-server-side fallback goes — as a second exported function the normalizer's caller applies to the selected URL — and Task 3's `Media.url` becomes the resolved CDN URL. Record which branch was taken in the file's header comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tiktok-normalize.test.mjs && npm test && npm run typecheck`
Expected: PASS — 5 new tests, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/tiktok/fetch.ts test/tiktok-normalize.test.mjs
git commit -m "feat: TikTok fetcher — a browser UA, because the crawler UA is a decoy

Verified 2026-07-18: facebookexternalhit, Discordbot and Twitterbot all get HTTP
200 with a ~7KB stub carrying no caption and no playAddr; bingbot gets 403; a
plain Chrome UA or no UA gets the real page. This is INVERTED from Instagram,
where the crawler UA is the one that works — and this repo's Instagram notes say
the opposite in nearly identical language, so a test asserts mechanically that
TIKTOK_UA is not crawler-shaped.

The fetch layer asserts on content (the rehydration marker), never on status. It
deliberately does NOT reject a deleted post: that page is real and full-sized, and
statusCode is the normalizer's assertion — two places answering it is two places
that can disagree.

It returns a REASON rather than null, so 'the page did not answer' (renamed blob,
block page, 429) counts as assert_fail while 'the post was rejected' (statusCode
!= 0, deleted) stays fetch_fail. Outcome2 has declared assert_fail since Phase 1
and nothing had ever emitted it, so a platform change and a wave of deleted links
were indistinguishable in the counters. The classification is a pure function, so
a 429-shaped body and a marker-renamed body are tested with no network at all.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Dispatch TikTok in the pipeline

**Files:**
- Modify: `src/worker.ts`
- Test: `test/pipeline.test.mjs` (extend)

**Interfaces:**
- Consumes: `PostRef`, `Env`, `ClientClass`.
- Produces: `liveFetchPost(ref, env, client)` (now exported) dispatching on `ref.p`.

`liveFetchPost` currently reads `if (ref.p !== 'bs') return null`. That single line is why a correct TikTok fetcher and normalizer would still produce a "could not fetch post" embed.

#### The signature change, and why it is spelled out here rather than discovered

`liveFetchPost(ref)` takes no `env`, so it cannot call `count()` — and `count()` also needs the `ClientClass`, which it does not have either. Task 4's `assert_fail` is therefore unreachable without a signature change, so make it deliberately:

```ts
export interface Deps {
  cache: CacheLike
  fetchPost(ref: PostRef, env: Env, client: ClientClass): Promise<Post | null>
}
```

`getPost(ref, d)` becomes `getPost(ref, d, env, client)` and threads both through; all three call sites in `handle` already have `env` and `client` in scope.

**This breaks nothing.** `tsconfig.json` is `include: ["src/**/*.ts"]`, so the `.mjs` test files are not typechecked, and every existing stub is written `fetchPost: async () => post` — JavaScript ignores extra arguments. Verify that claim by running the full suite, not by reasoning about it.

The alternative — returning a discriminated `{post, fail}` from `fetchPost` — was rejected because it changes the value every existing test stub returns, for no gain: `count()` is already called from `handle` for every other outcome, and the one exception (this) is the fetcher attributing a failure only it can see.

- [ ] **Step 1: Write the failing test**

Append to `test/pipeline.test.mjs`:
```js
import { liveFetchPost } from '../src/worker.ts'

const TT_POST = '/@mysticaquarium/video/7660566211100511518'

test('a TikTok video post reaches the renderer as a tt post, and leaks no CDN url', async () => {
  // WHAT THIS TASK CAN ASSERT, AND WHAT IT CANNOT.
  //
  // The video carve-out does not exist yet (Task 7). Until it does, a tt VIDEO post on Discord
  // takes renderSpoof, and renderSpoof emits ZERO /_media/ urls when hasMedia is true — the C1
  // suppression is the entire mechanism, not an oversight (src/render/discord.ts). So an
  // assertion like /\/_media\/tt%3A…\/0/ CANNOT PASS HERE, and writing one would produce a task
  // that is red no matter how correctly it is implemented.
  //
  // The media-on-our-origin assertion therefore lives in Task 7 (the carve-out's own test) and
  // Task 9 (end to end, on the real fixture). What THIS task owns is the dispatch: a tt ref now
  // reaches the renderer at all, as a tt post, with nothing raw leaking out of it.
  const post = {
    ref: { p: 'tt', id: '7660566211100511518' },
    canonical: 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518',
    author: { name: 'Mystic Aquarium', handle: 'mysticaquarium', url: 'https://www.tiktok.com/@mysticaquarium' },
    text: 'a beluga', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280, duration: 10 }],
    counts: { likes: 5, views: 900 }, sensitive: false,
  }
  const res = await handle(req(TT_POST, DISCORD), fakeEnv(), ctx, { cache: fakeCache(), fetchPost: async () => post })
  const html = await res.text()
  assert.equal(res.status, 200)
  assert.ok(!html.includes('aweme/v1/play'), 'a raw CDN url must never reach a client')
  assert.ok(!html.includes('tiktokcdn'), 'nor any other raw CDN host')
  // The spoof head's callback id encodes the ref, so this proves the tt post — not a failure
  // embed — is what got rendered.
  assert.match(html, new RegExp(`statuses/${encodeStatusId(refKey(post.ref))}`))
  assert.ok(!/could not fetch post/i.test(html), 'the dispatch must not fall through to fetch_fail')
})

test('/_media/ resolves a TikTok video to the aweme url with a 302, never a proxy', async () => {
  const cache = fakeCache()
  const post = {
    ref: { p: 'tt', id: '777' },
    canonical: 'https://www.tiktok.com/@u/video/777',
    author: { name: 'U', handle: 'u', url: 'https://www.tiktok.com/@u' },
    text: '', createdAt: new Date(),
    media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280 }],
    counts: {}, sensitive: false,
  }
  const res = await handle(req('/_media/tt%3A777/0'), fakeEnv(), ctx, { cache, fetchPost: async () => post })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.tiktok.com/aweme/v1/play/?video_id=v')
  assert.match(res.headers.get('cache-control'), /max-age=300/)
})

test('a TikTok fetch failure degrades: error embed for a crawler, 302 for a human', async () => {
  const bad = { cache: fakeCache(), fetchPost: async () => null }
  const crawler = await handle(req(TT_POST, DISCORD), fakeEnv(), ctx, bad)
  assert.match(await crawler.text(), /could not fetch post/i)
  const human = await handle(req(TT_POST), fakeEnv(), ctx, bad)
  assert.equal(human.status, 302)
  assert.equal(human.headers.get('location'), 'https://www.tiktok.com/@mysticaquarium/video/7660566211100511518')
})

test('liveFetchPost dispatches on ref.p and returns null for platforms with no fetcher', async () => {
  // No network: every ref here belongs to a platform whose fetcher lands in Phase 4-5, so the
  // dispatch returns before any I/O. This is the line that made a correct TikTok fetcher
  // invisible — `if (ref.p !== 'bs') return null` — and it is worth a test of its own.
  for (const ref of [
    { p: 'x', id: '1' },
    { p: 'ig', kind: 'p', code: 'A' },
    { p: 'th', code: 'A' },
    { p: 'rd', sub: 'aww', id: 'a' },
  ]) {
    assert.equal(await liveFetchPost(ref, fakeEnv(), 'other-bot'), null, ref.p)
  }
})

test('counters attribute the platform, so tt traffic is visible separately', async () => {
  const env = fakeEnv()
  await handle(req(TT_POST, DISCORD), env, ctx, { cache: fakeCache(), fetchPost: async () => null })
  assert.ok(env.points.some(p => p.blobs[0] === 'tt' && p.blobs[1] === 'fetch_fail'))
})

test('A BLOCKED PAGE LANDS IN assert_fail, A DELETED POST IN fetch_fail ALONE', async () => {
  // The counter half of Task 4's split, and the reason it is worth a signature change: without
  // this, "TikTok renamed the rehydration blob" and "someone pasted a deleted link" emit
  // byte-identical analytics. Global fetch is stubbed rather than mocked at a module boundary,
  // because the thing under test is precisely what liveFetchPost does with a real response body.
  const real = globalThis.fetch
  try {
    const run = async body => {
      globalThis.fetch = async () => new Response(body, { status: 200 })
      const env = fakeEnv()
      await liveFetchPost({ p: 'tt', id: '7660566211100511518' }, env, 'discord')
      return env.points.filter(p => p.blobs[0] === 'tt').map(p => p.blobs[1])
    }

    // A 429 body: no marker, so the PAGE assertion failed.
    const blocked = await run('<html><head><title>429 Too Many Requests</title></head></html>')
    assert.ok(blocked.includes('assert_fail'), 'a rate-limited page must be assert_fail')

    // A real page carrying a real "this post is gone" answer: the assertion PASSED.
    const deletedBody = readFileSync('test/fixtures/tiktok-deleted.html', 'utf8')
    const deleted = await run(deletedBody)
    assert.ok(!deleted.includes('assert_fail'), 'a deleted post is NOT an assertion failure')
  } finally {
    globalThis.fetch = real
  }

  // And the worker still counts fetch_fail on the resulting null, for both — the counters
  // STACK, matching how worker.ts already layers fetch_fail on top of api_miss.
  const env = fakeEnv()
  await handle(req(TT_POST, DISCORD), env, ctx, { cache: fakeCache(), fetchPost: async () => null })
  assert.ok(env.points.some(p => p.blobs[0] === 'tt' && p.blobs[1] === 'fetch_fail'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL — `liveFetchPost` is not exported (so both dispatch tests cannot even import it), and the TikTok paths already route (Task 2) but nothing dispatches them, so the render test gets a failure embed. The two degrade tests (`fetch failure degrades`, `counters attribute the platform`) already pass: with no dispatch, a tt post is a `fetch_fail`, which is exactly what they assert. They stay as regression guards on the path that must keep working after the dispatch exists.

- [ ] **Step 3: Write minimal implementation**

In `src/worker.ts`:
```ts
/**
 * Exported for the dispatch test. A `ref.p !== 'bs'` guard here is what made Phase 1's
 * "platform #7 is just a fetcher plus a normalizer" claim false in practice: the fetcher and
 * normalizer can be perfect and the post still renders "could not fetch post".
 *
 * A switch, deliberately, rather than a lookup table: TypeScript narrows `ref` per case, so
 * each fetcher gets its own Extract<PostRef, …> for free and a new platform cannot be wired
 * up with the wrong ref shape. The default arm is the honest one — those platforms land in
 * Phases 4-5 and until then a null routes into the existing fetch_fail path.
 *
 * `env` and `client` exist only so a fetcher can attribute a failure the worker cannot see:
 * "the PAGE did not answer" (assert_fail) versus "the POST was rejected" (fetch_fail). It
 * COUNTS ON TOP of the worker's own fetch_fail rather than instead of it — the same layering
 * the activity/oembed case already does with api_miss, so the ratio is the readable signal.
 */
export async function liveFetchPost(ref: PostRef, env: Env, client: ClientClass): Promise<Post | null> {
  switch (ref.p) {
    case 'bs': {
      const raw = await fetchBluesky(ref)
      return raw ? normalizeBluesky(raw, ref) : null
    }
    case 'tt': {
      const got = await fetchTikTok(ref)
      if (!got.ok) {
        // TikTok changed, blocked us, or rate-limited us. NOT the same event as a deleted post,
        // and the whole reason Outcome2 declared assert_fail in Phase 1.
        count(env, 'tt', got.reason, client)
        return null
      }
      return normalizeTikTok(got.html, ref)
    }
    default:
      return null
  }
}
```
plus the imports (`fetchTikTok`, `normalizeTikTok`, and `ClientClass` from `types.ts`; `count` is already imported).

`getPost` threads the two new arguments through, and the default export becomes
`fetchPost: liveFetchPost` unchanged — the signature now matches `Deps.fetchPost` exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pipeline.test.mjs && npm test && npm run typecheck`
Expected: PASS — 6 new tests, full suite green. **Confirm the whole suite, not just this file** — the `Deps.fetchPost` signature change is the thing most likely to have broken an unrelated test, and the argument that it cannot (extra args are ignored; tests are not typechecked) is exactly the kind of argument that wants evidence.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/pipeline.test.mjs
git commit -m "feat: dispatch TikTok in liveFetchPost, and split assert_fail from fetch_fail

`if (ref.p !== 'bs') return null` was the single line that would have made a
correct TikTok fetcher and normalizer render 'could not fetch post'. A switch
rather than a table, so TypeScript narrows the ref per case and a new platform
cannot be wired up with the wrong ref shape.

liveFetchPost now takes env and client so it can count assert_fail — 'the page
did not answer' — separately from fetch_fail, 'the post was rejected'. Without it
a renamed rehydration blob, a 429 and a wave of deleted links are one number.
Deps.fetchPost gains the two parameters; no test stub breaks, because tests are
.mjs (tsconfig includes src only) and JS ignores extra arguments.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `/t/{code}` short links — resolved, not deferred

**Files:**
- Modify: `src/types.ts` (the `shortlink` `Route` kind), `src/router.ts`, `src/worker.ts`
- Modify: `src/platforms/tiktok/fetch.ts` (`resolveTikTokShortlink`), `src/platforms/tiktok/normalize.ts` (`tiktokRefFrom`)
- Test: `test/router.test.mjs`, `test/pipeline.test.mjs` (extend)

**Interfaces:**
- Consumes: a `{code}` from `/t/{code}`.
- Produces: `Route = {kind:'shortlink'; p:'tt'; code; canonical}`; `resolveTikTokShortlink(code): Promise<TikTokFetch>`; `tiktokRefFrom(html): Extract<PostRef,{p:'tt'}> | null`; a `shortlink` case in `handle`.

#### Why this is in 3a, when the first draft of this plan deferred it

The first draft argued short links had **no architectural home**, because `route()` is synchronous and resolving a code needs a round trip. **The premise was wrong, and it was disproved by running it** — see verified fact 10. Restating the measurement because a future reader must not re-litigate this from the old, false version:

```
/t/ZTSw2mYwR    -> 1 redirect -> @mysticaquariumct/video/7660566211100511518
                   statusCode 0, itemStruct.id 7660566211100511518, 5 aweme urls
/t/ZS1abcNOTREAL -> 1 redirect -> https://www.tiktok.com/?_r=1   video-detail scope ABSENT
/t/DTI1vjIEi5y   -> 1 redirect -> https://www.tiktok.com/?_r=1   video-detail scope ABSENT
                                                                 (and that is a real THREADS code)
```

- **It costs ONE fetch, not two.** Redirect-following and the payload arrive together, so "resolve then fetch" was never the shape of the work.
- **It is not a guess.** `webapp.video-detail` present **and** `statusCode === 0` → it is a TikTok post, and the whole post is already in hand. Scope absent → it is not TikTok. This *is* the spec's own resolver ("ask both and keep whichever answers… Neither → ambiguous", spec §293-302); the TikTok half alone decides the **yes** case, and the **no** case degrades to exactly the `['tt','th']` chooser 3a would have shipped anyway. Nothing about the no-case behaviour changes by building this.
- **Deferring it is a REGRESSION.** Production serves `/t/ZTSw2mYwR/` as a working video embed today (verified: `og:video` → `offload.tnktok.com`, `theme-color #ff0050`). Shipping 3a with it dead-ended blocks the 3b cutover on a checklist item that used to work.

`vm.tiktok.com` is a **HOSTNAME**, not a path, and still cannot be exercised on staging — staging is a single specific hostname and the wildcard belongs to the live `fxtiktok` worker. That one stays in *What Phase 3b will need*, unchanged.

#### The two decisions that are easy to get wrong

**1. The Route means "resolve this", not "this is a TikTok post."** It must NOT be `{kind:'post', ref:{p:'tt', id:code}}` — that would be guessing against Threads, which mints the identical shape, and it would put a short code into a `PostRef`, where every downstream consumer would treat it as a post id. `p:'tt'` on the `shortlink` Route names **which resolver to run**, not which platform the link belongs to. If the resolver says no, the answer is the chooser.

**2. THE CACHE KEY. Solve this explicitly or it contradicts Task 2's own test.** `refKey({p:'tt', id:'ZTSw2mYwR'})` is `tt:ZTSw2mYwR`, which is not `tt:7660566211100511518` — so a naive implementation splits one post across two cache entries and two `/_media/` namespaces, directly contradicting Task 2's *"every TikTok path shape for one post collapses to the SAME cache key"*.

The resolution, in three parts:

- **The resolved `Post.ref` carries the CANONICAL numeric id**, read from `itemStruct.id` — never parsed out of the resolved URL, which carries a `?_r=1&_t=…` session tail. Every `/_media/` URL a renderer emits comes from `post.ref`, so they are canonical and shared with the long-form URL for free.
- **The short code is a LOOKUP key only.** `{p:'tt', id: code}` is constructed in `handle` and used for `postCacheKey`/`respCacheKey`; it is never rendered and never reaches a `Media` URL.
- **`getPost` writes the post under BOTH keys.** Under the lookup key, so a repeat `/t/{code}` costs no upstream fetch; under `postCacheKey(post.ref)`, so the **first** `/_media/{canonical}/0` hit — whose ref comes from `post.ref`, not from the path that resolved it — finds it warm instead of triggering a second fetch. This is the cheapest correct answer and it generalises: any future ref that is a lookup key rather than an identity gets it automatically.

**The one thing that is NOT shared, stated plainly:** the *rendered response* cache is keyed on the short ref, so a short link and a long link render twice. That costs one extra cached response and **zero** extra upstream fetches — and the two renders are byte-identical, because everything in them derives from `post`, never from the request path. Sharing it would mean resolving the code before the response-cache lookup, which inverts the cheap-check-first order the post route is built around, for no fetch saved.

- [ ] **Step 1: Write the failing test**

Append to `test/router.test.mjs`:
```js
test('/t/{code} is a SHORTLINK route — not a post, not a guess, not a dead end', () => {
  // Today 't' sits in the `known` dead-end set, so a human pasting a TikTok short link is told
  // the link does not exist — while production serves that exact link correctly. The route
  // means "resolve this code"; p:'tt' names the RESOLVER to run, not the platform the link
  // belongs to. Threads mints /t/{code} too, and the resolver's no-answer is a chooser.
  assert.deepEqual(r('/t/ZTSw2mYwR'), {
    kind: 'shortlink',
    p: 'tt',
    code: 'ZTSw2mYwR',
    canonical: 'https://www.tiktok.com/t/ZTSw2mYwR',
  })
})

test('a shortlink is NOT a post ref — a short code must never enter a PostRef', () => {
  const got = r('/t/ZTSw2mYwR')
  assert.notEqual(got.kind, 'post', 'that would be guessing against Threads')
  assert.equal(got.ref, undefined, 'a short code is not identity until it is resolved')
})

test('the shortlink route does not shadow a real depth-3 permalink under @t', () => {
  // matchPost runs BEFORE the shortlink branch, so /t/status/123 — a real X permalink by @t —
  // still routes as X. This is the defect class fixed in 37386db and again for @api; removing
  // 't' from `known` must not reintroduce it at a different depth.
  assert.deepEqual(r('/t/status/123'), {
    kind: 'post',
    ref: { p: 'x', id: '123' },
    canonical: 'https://x.com/t/status/123',
  })
})

test('/t alone is still not a shortlink', () => {
  // Depth 1. There is no code to resolve, so this falls through to the ordinary bare-segment
  // handling rather than resolving the empty string against TikTok.
  assert.notEqual(r('/t').kind, 'shortlink')
})

test('ACCEPTANCE: the ambiguity table is STILL unchanged by the shortlink route', () => {
  // /t/{code} became a Route kind, not an ambiguity row, so Task 2's table is still the whole
  // table. Re-asserted here because dropping 't' from `known` is exactly the kind of edit that
  // silently re-shapes a neighbouring row.
  for (const [path, candidates] of [
    ['/mrbeast', ['x', 'ig']],
    ['/search', ['x', 'tt', 'bs', 'rd']],
    ['/gallery/abc123', ['rd', 'ig']],
  ]) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', path)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
})
```

Append to `test/pipeline.test.mjs`:
```js
const TT_CANON = { p: 'tt', id: '7660566211100511518' }
const ttResolved = {
  ref: TT_CANON,
  canonical: 'https://www.tiktok.com/@mysticaquariumct/video/7660566211100511518',
  author: { name: 'Mystic Aquarium', handle: 'mysticaquariumct', url: 'https://www.tiktok.com/@mysticaquariumct' },
  text: 'a beluga', createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280 }],
  counts: { likes: 5 }, sensitive: false,
}

test('A RESOLVED SHORT LINK CARRIES THE CANONICAL REF, NEVER THE SHORT CODE', async () => {
  // The short code is a lookup key. If it reached post.ref, every /_media/ url would be minted
  // under tt:ZTSw2mYwR while the long-form url minted tt:7660… — two cache entries and two
  // media namespaces for one post, which is precisely what Task 2's "same cache key" test
  // forbids. Asserted on the SPOOF CALLBACK ID, because at this task the carve-out (Task 7)
  // does not exist yet and renderSpoof emits no /_media/ urls on a media post at all.
  const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ttResolved }
  const html = await (await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, new RegExp(`statuses/${encodeStatusId(refKey(TT_CANON))}`))
  assert.ok(!html.includes('ZTSw2mYwR'), 'the short code must not appear anywhere in the output')
  assert.match(html, /www\.tiktok\.com\/@mysticaquariumct\/video\/7660566211100511518/)
})

test('THE CACHE: a resolved short link lands under BOTH keys, so /_media/ costs no refetch', async () => {
  // The load-bearing cache assertion. fetchPost THROWS here: any path that reaches it means the
  // canonical key was never written and a short link would cost a second upstream fetch on its
  // very first media hit.
  const cache = fakeCache()
  let resolves = 0
  const deps = {
    cache,
    fetchPost: async () => { throw new Error('the canonical post key must already be warm') },
    resolveShortlink: async () => { resolves++; return ttResolved },
  }

  await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)
  assert.equal(resolves, 1)

  // A DIFFERENT client class misses the response cache but must still hit the POST cache under
  // the short key — otherwise the short code is only ever as warm as one rendered response.
  await handle(req('/t/ZTSw2mYwR', OTHER_BOT), fakeEnv(), ctx, deps)
  assert.equal(resolves, 1, 'a second client class must not cost a second resolve')

  // And the canonical key: /_media/ derives its ref from post.ref, which is the numeric id.
  const m = await handle(req(`/_media/${encodeURIComponent(refKey(TT_CANON))}/0`), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.equal(m.headers.get('location'), 'https://www.tiktok.com/aweme/v1/play/?video_id=v')
  assert.equal(resolves, 1, 'the first media hit must not cost an upstream fetch')

  // The long-form permalink shares that same warm entry — the invariant Task 2 asserts on refKey,
  // now asserted end to end through the cache.
  const long = await handle(req('/@mysticaquariumct/video/7660566211100511518', DISCORD), fakeEnv(), ctx, deps)
  assert.equal(long.status, 200)
})

test('A NON-TIKTOK CODE DEGRADES TO AMBIGUOUS — no throw, no guess', async () => {
  // Verified 2026-07-18: a dead code AND a real Threads code both land on the TikTok homepage
  // with the webapp.video-detail scope ABSENT. The resolver returns null and the answer is the
  // chooser — exactly what this path would have shipped with no resolver at all, so the
  // no-case behaviour is unchanged by building the yes-case.
  const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => null }

  const crawler = await handle(req('/t/DTI1vjIEi5y', DISCORD), fakeEnv(), ctx, deps)
  const html = await crawler.text()
  assert.match(html, /Ambiguous link/i)
  assert.match(html, /tiktok\.com/)
  assert.match(html, /threads\.com/)

  const human = await handle(req('/t/DTI1vjIEi5y'), fakeEnv(), ctx, deps)
  assert.equal(human.status, 300, 'a human gets the chooser, with both real links')
})

test('a resolver that THROWS degrades the same way, rather than 500ing', async () => {
  const deps = {
    cache: fakeCache(), fetchPost: async () => null,
    resolveShortlink: async () => { throw new Error('upstream reset') },
  }
  const res = await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)
  assert.match(await res.text(), /Ambiguous link/i)
})

test('A HUMAN ON A SHORT LINK COSTS US NOTHING — 302 to the short url itself', async () => {
  // The same invariant the post route keeps: humans never trigger an upstream fetch, because
  // the router already knows a URL that works. A short link resolves in their own browser.
  let resolves = 0
  const deps = {
    cache: fakeCache(), fetchPost: async () => null,
    resolveShortlink: async () => { resolves++; return ttResolved },
  }
  const res = await handle(req('/t/ZTSw2mYwR'), fakeEnv(), ctx, deps)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://www.tiktok.com/t/ZTSw2mYwR')
  assert.equal(resolves, 0, 'a human must not cost an upstream fetch')
})

test('tiktokRefFrom reads the id from the PAYLOAD, and refuses everything else', async () => {
  const { tiktokRefFrom } = await import('../src/platforms/tiktok/normalize.ts')
  const VIDEO = readFileSync('test/fixtures/tiktok-video.html', 'utf8')
  assert.deepEqual(tiktokRefFrom(VIDEO), { p: 'tt', id: 'REPLACE_WITH_VIDEO_ID' })
  // The homepage: a rehydration blob IS present (measured: 257KB of it), but no video-detail
  // scope. A resolver asserting on the marker alone would accept this as a post.
  const homepage = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
    JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': {}, 'seo.abtest': {} } }) + '</script>'
  assert.equal(tiktokRefFrom(homepage), null, 'no video-detail scope means NOT a TikTok post')
  assert.equal(tiktokRefFrom(readFileSync('test/fixtures/tiktok-deleted.html', 'utf8')), null)
  for (const junk of [null, undefined, 42, '', '<html></html>']) {
    assert.doesNotThrow(() => tiktokRefFrom(junk))
    assert.equal(tiktokRefFrom(junk), null)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/router.test.mjs test/pipeline.test.mjs`

Expected: FAIL — `/t/ZTSw2mYwR` returns `notfound` (dead-ended by `'t'` in `known`), there is no `shortlink` Route kind for `handle` to switch on, and `tiktokRefFrom` does not exist. The `/t/status/123` and ambiguity-table tests already pass; they are the regression guards on removing `'t'` from `known`.

- [ ] **Step 3: Write minimal implementation**

`src/types.ts` — the one type change this phase makes:
```ts
  /**
   * A short code that NAMES no post yet. Deliberately not a 'post' with a ref: a short code is
   * not a post id, and TikTok and Threads mint the identical /t/{code} shape — putting one into
   * a PostRef would be guessing, and every downstream consumer would then treat it as an id.
   *
   * `p` names WHICH RESOLVER TO RUN, not which platform the link belongs to. worker.ts resolves
   * it asynchronously (route() is synchronous and always will be); if the resolver says no, the
   * answer is the ambiguous chooser, which is what this path would have served with no resolver
   * at all.
   *
   * `canonical` is the short URL itself, so a human costs us zero upstream fetches — it resolves
   * in their browser exactly as it does in ours.
   */
  | { kind: 'shortlink'; p: 'tt'; code: string; canonical: string }
```

`src/router.ts` — after the `matchPost(seg)` fallthrough, and BEFORE `known`:
```ts
  // TikTok's short form. Depth 2 ONLY: /t/status/123 is a real X permalink by @t and matchPost
  // above has already claimed it, which is why this sits below matchPost rather than above it.
  // Threads mints /t/{code} too — see the Route kind's comment for why that does not make this
  // a guess.
  if (seg.length === 2 && seg[0] === 't' && seg[1]) {
    return { kind: 'shortlink', p: 'tt', code: seg[1], canonical: `https://www.tiktok.com/t/${seg[1]}` }
  }
```
and `known` drops `'t'` — it was only ever dead-ending this one shape, because `known` is consulted after `matchPost`:
```ts
  const known = new Set(['comments', 'p', 'reel', 'reels', 'tv', 'stories', 'r'])
```

`src/platforms/tiktok/normalize.ts` gains the ref extractor:
```ts
/**
 * The canonical {p:'tt', id} a page payload names, or null.
 *
 * Short-link resolution needs this BEFORE it can build a Post: the /t/{code} route knows a code,
 * not an id. The id comes from itemStruct.id and NEVER from the resolved URL — that URL carries
 * a `?_r=1&_t=…` session tail (measured 2026-07-18), and parsing an id back out of a URL would
 * be a second, driftable spelling of the router.
 *
 * Returning null is the "this is not a TikTok post" answer, and it is load-bearing: a dead code
 * and a real Threads code both land on the TikTok HOMEPAGE, which carries a rehydration blob of
 * its own. The marker's presence proves nothing; the webapp.video-detail scope is the
 * discriminator, and statusCode === 0 is the second half of it.
 */
export function tiktokRefFrom(html: unknown): Extract<PostRef, { p: 'tt' }> | null
```
It shares the extract-and-assert path with `normalizeTikTok` — one parse helper, two callers, so the two cannot disagree about what "no post here" means. The id must be a non-empty string of digits; anything else is null.

`src/platforms/tiktok/fetch.ts` gains the resolver:
```ts
/**
 * ONE fetch. fetch() follows redirects by default and the redirect TARGET's body is the post
 * page — verified 2026-07-18: /t/ZTSw2mYwR/ -> redirects=1 -> the @user/video/{id} page with
 * statusCode 0 and a full itemStruct. There is no second round trip to make, which is the
 * measurement that retired this feature's deferral.
 *
 * Same UA and same content assertion as the normal path, deliberately: a short link is the same
 * page fetch with a different starting URL, so a divergence here is a second UA gate to keep in
 * sync with fact 1.
 */
export async function resolveTikTokShortlink(code: string): Promise<TikTokFetch> {
  const res = await fetch(`https://www.tiktok.com/t/${encodeURIComponent(code)}`, {
    headers: { 'user-agent': TIKTOK_UA, accept: 'text/html' },
  })
  return pageOutcome(await res.text())
}
```

`src/worker.ts` — the resolver, and the `shortlink` case:
```ts
/**
 * Resolve a short code to a Post. Separate from fetchPost because the INPUT is not a PostRef —
 * a short code names no post until it is resolved — and forcing it into one would mean
 * fetchPost guessing, from an id's shape, which upstream URL to build.
 *
 * A null here is NOT necessarily a failure: scope-absent means "this code is not TikTok", which
 * is a legitimate answer and the caller's cue to serve the chooser. Only a failed PAGE assertion
 * (no marker at all — a block page, a 429) is counted, and it is counted as assert_fail for the
 * same reason liveFetchPost does it.
 */
export async function liveResolveShortlink(
  p: 'tt', code: string, env: Env, client: ClientClass,
): Promise<Post | null> {
  if (p !== 'tt') return null
  const got = await resolveTikTokShortlink(code)
  if (!got.ok) {
    count(env, 'tt', got.reason, client)
    return null
  }
  const ref = tiktokRefFrom(got.html)
  // Scope absent -> not a TikTok post. Deliberately NOT counted as assert_fail: this is the
  // resolver working correctly, and counting it would swamp the signal that TikTok changed.
  return ref ? normalizeTikTok(got.html, ref) : null
}
```

`Deps` gains it, and `getPost` gains a loader and the both-keys write:
```ts
export interface Deps {
  cache: CacheLike
  fetchPost(ref: PostRef, env: Env, client: ClientClass): Promise<Post | null>
  resolveShortlink(p: 'tt', code: string, env: Env, client: ClientClass): Promise<Post | null>
}

async function getPost(
  ref: PostRef, d: Deps, env: Env, client: ClientClass,
  /**
   * Cache-miss loader. Defaults to the normal per-ref fetch; the shortlink route passes its own,
   * because a short code names no post until it is resolved and `ref` here is a LOOKUP KEY
   * rather than the post's identity.
   */
  load: () => Promise<Post | null> = () => d.fetchPost(ref, env, client),
): Promise<{ post: Post | null; cached: boolean }> {
  // …unchanged cache read, unchanged try/catch around load()…
  if (post) {
    const headers = { 'cache-control': `max-age=${POST_TTL}`, 'content-type': 'application/json' }
    await d.cache.put(key, new Response(serializePost(post), { headers }))
    // A ref that was a LOOKUP KEY rather than the post's own identity — today only a resolved
    // short code — must ALSO land under the canonical key, or the first /_media/ hit (whose ref
    // comes from post.ref) costs a second upstream fetch and splits the post across two entries.
    // Awaited, not waitUntil'd: it is a cache write we are about to depend on in the same
    // second, and the tests that prove it would otherwise race.
    const canonical = cacheUrl(postCacheKey(post.ref))
    if (canonical !== key) await d.cache.put(canonical, new Response(serializePost(post), { headers }))
  }
  return { post, cached: false }
}
```

and the case itself, beside `'post'`:
```ts
    case 'shortlink': {
      // Humans cost us nothing: the short link resolves in their own browser. Same invariant as
      // the post route, and the reason the Route carries a canonical at all.
      if (client === 'human') return redirect(r.canonical)

      // A LOOKUP key, never a rendered one. It never reaches post.ref, so no /_media/ url and no
      // canonical is ever minted from a short code.
      const lookup: PostRef = { p: r.p, id: r.code }
      const rkey = cacheUrl(respCacheKey(lookup, client))
      const hit = await d.cache.match(rkey)
      if (hit) return hit

      const { post } = await getPost(lookup, d, env, client, () => d.resolveShortlink(r.p, r.code, env, client))
      if (!post) {
        // NOT TikTok, or TikTok has no such post. Nothing is guessed: this is the chooser the
        // path would have served with no resolver at all, so the no-case is unchanged.
        count(env, 'none', 'ambiguous', client)
        return render({ kind: 'ambiguous', path: url.pathname, candidates: ['tt', 'th'] }, client, origin)
      }

      const res = render({ kind: 'post', post }, client, origin)
      const toCache = new Response(res.clone().body, res)
      toCache.headers.set('cache-control', `max-age=${RESP_TTL}`)
      ctx.waitUntil(d.cache.put(rkey, toCache))
      count(env, r.p, 'ok', client)
      return res
    }
```

The default export wires `resolveShortlink: liveResolveShortlink`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/router.test.mjs test/pipeline.test.mjs && npm test && npm run typecheck`
Expected: PASS — 11 new tests, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/router.ts src/worker.ts src/platforms/tiktok/fetch.ts \
        src/platforms/tiktok/normalize.ts test/router.test.mjs test/pipeline.test.mjs
git commit -m "feat: resolve /t/{code} short links instead of dead-ending them

The first draft of the plan deferred this, arguing a short link had no
architectural home because route() is synchronous. The premise was wrong and
measurement disproved it: /t/ZTSw2mYwR follows ONE redirect and the same response
carries the full rehydration payload — statusCode 0, itemStruct.id, five aweme
urls. There is no resolve-then-fetch round trip to pay for.

Nor is it a guess. A dead code and a real THREADS code both land on the TikTok
homepage with the webapp.video-detail scope ABSENT, so scope-present +
statusCode 0 decides the yes case and everything else degrades to the ['tt','th']
chooser this path would have served anyway. The no-case behaviour is unchanged.

It also stops a regression: production serves /t/ZTSw2mYwR/ as a working video
embed today, and shipping 3a with it dead-ended would have blocked the 3b cutover
on a checklist item that already worked.

The Route is {kind:'shortlink', p:'tt', code} — deliberately NOT a post ref, since
a short code is not a post id and Threads mints the same shape; p names which
resolver to run. The resolved Post carries the CANONICAL numeric id, read from
itemStruct.id rather than parsed out of the resolved URL (which carries a session
tail), so every /_media/ url is canonical and shared with the long-form link. The
post is cached under BOTH the short code and the canonical ref, so a short link
costs no second upstream fetch on its first media hit.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: THE VIDEO CARVE-OUT — the interaction commit 3bda8e4 created

**Files:**
- Modify: `src/render/embed.ts`, `src/render/discord.ts`
- Test: `test/render.test.mjs` (extend)

**Interfaces:**
- Consumes: `Post`.
- Produces: `playableVideo(post): Media | undefined` in `embed.ts`; a gate in `renderPost`.

#### The problem, precisely

Commit `3bda8e4` made **every** Discord response take the Mastodon-spoof path, and `renderSpoof` deliberately emits **no `og:video`** — the whole point of that head is to suppress OpenGraph media so Discord prefers the activity JSON's gallery. A TikTok **video** post would therefore have its video **swallowed**: Discord would draw a title, a description, and no player.

Bluesky is unaffected and that is why nobody has noticed: its video is HLS, and `normalizeBluesky` already turns it into a still thumbnail with `kind: 'image'`. TikTok is the first platform that produces a genuinely playable `kind: 'video'` entry — and `embed.ts` predicted this in writing (*"Unreachable today … which is exactly why it needs writing down now rather than discovering it when a platform that really carries video lands in Phase 3"*).

**Upstream FxEmbed does exactly this carve-out** — it disables the activity path when there is an external player URL. We are not inventing a mechanism; we are adopting a proven one.

**Slideshows must STILL take the spoof path.** They are the gallery case, and the gallery is what Phase 2 bought.

**And the third case — a video post with only a thumbnail — is already correct, by construction.** When Task 1's decision tree lands on the no-playable-URL branch, `normalizeTikTok` emits the cover as a single `kind:'image'` entry and no video entry at all. `playableVideo(post)` is then `undefined`, the gate falls through to `renderSpoof`, `hasMedia` is true, so zero `og:image` is emitted and **the cover renders through the activity gallery** exactly as a one-image slideshow does. Nothing extra is needed for it and no branch handles it specially — but it is worth stating, because "video post, no player" looks like a hole in this task's coverage and it is not one.

#### The one subtlety that will bite

The gate must ask the **same list, with the same predicate**, as the plain head's own video selection. The plain head selects from `mediaOf(post)` — the post's **own** media, quote media deliberately excluded. If the gate asked `mediaList(post)` (which includes hoisted quote media), a post whose *quote* carried a video would take the carve-out and then find no video in `mediaOf(post)` — rendering an image head with no gallery and no player, worse than either branch. `embed.ts` already names this defect class by name: *"two consumers disagreeing about it is a live defect class rather than a tidiness argument."* So the predicate is extracted into **one** exported function and both call it.

- [ ] **Step 1: Write the failing test**

Append to `test/render.test.mjs`:
```js
const ttVideo = {
  ref: { p: 'tt', id: '777' },
  canonical: 'https://www.tiktok.com/@u/video/777',
  author: { name: 'U', handle: 'u', url: 'https://www.tiktok.com/@u', avatar: 'https://cdn/a.jpg' },
  text: 'a beluga', createdAt: new Date('2026-07-01T00:00:00Z'),
  media: [{ kind: 'video', url: 'https://www.tiktok.com/aweme/v1/play/?video_id=v', w: 720, h: 1280, duration: 10 }],
  counts: { likes: 5 }, sensitive: false,
}
const ttSlides = {
  ...ttVideo,
  canonical: 'https://www.tiktok.com/@u/photo/778',
  ref: { p: 'tt', id: '778' },
  media: [
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1080, h: 1920 },
    { kind: 'image', url: 'https://cdn/2.jpg', w: 1080, h: 1920 },
    { kind: 'image', url: 'https://cdn/3.jpg', w: 1080, h: 1920 },
  ],
}

test('A PLAYABLE VIDEO TAKES THE PLAIN og:video PATH, NOT THE SPOOF', async () => {
  // 3bda8e4 put every Discord response on the spoof head, and that head emits NO og:video by
  // design (it suppresses OpenGraph media so Discord prefers the activity gallery). Without
  // this carve-out a TikTok video renders as a title and a description with no player at all.
  // Upstream FxEmbed does the same thing: it disables the activity path when an external
  // player URL exists.
  const html = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.match(html, /property="og:video" content="[^"]*\/_media\/tt%3A777\/0"/)
  assert.match(html, /og:type" content="video\.other"/)
  assert.ok(!html.includes('application/activity+json'), 'the spoof link would compete with og:video')
  assert.equal(tagsOf(html, 'og:image').length, 0, 'og:image would outrank the player')
  assert.match(html, new RegExp(`twitter:image" content="${ORIGIN}/_alt/0"`))
})

test('A SLIDESHOW STILL TAKES THE SPOOF — the gallery is what Phase 2 bought', async () => {
  const html = await body(render({ kind: 'post', post: ttSlides }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.equal(tagsOf(html, 'og:image').length, 0, 'the spoof suppresses og:image on a media post')
  assert.ok(!html.includes('og:video'), 'a slideshow has no video to play')
})

test('REGRESSION: Bluesky is untouched — its HLS video is already a thumbnail image', async () => {
  // The carve-out must be invisible to every post that existed before TikTok. Bluesky video
  // is normalized to kind:'image', so it takes the spoof exactly as it did yesterday.
  const html = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.equal(tagsOf(html, 'og:image').length, 0)
})

test('the gate and the plain head ask the SAME question of the SAME list', async () => {
  // If the gate asked mediaList (post + hoisted quote media) while the plain head selects from
  // mediaOf (the post's own), a post whose QUOTE carried a video would take the carve-out and
  // then find no video to emit — an image head with no gallery and no player, worse than
  // either branch. embed.ts names this defect class explicitly.
  const quotedVideo = {
    ...base,
    media: [{ kind: 'image', url: 'https://cdn.bsky.app/a.jpg', w: 800, h: 600 }],
    quote: { ...ttVideo, quote: undefined, replyTo: undefined },
  }
  const html = await body(render({ kind: 'post', post: quotedVideo }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/, 'a hoisted quote video must NOT trigger the carve-out')
  assert.ok(!html.includes('og:video'))
})

test('a video entry with no url does not trigger the carve-out', async () => {
  // usable() is the shared predicate: an object with no url resolves through pickMedia to
  // null, so a carve-out on it would advertise a player guaranteed to 404 — and the spoof
  // path, which would at least have shown an avatar, was skipped to get there.
  const broken = { ...ttVideo, media: [{ kind: 'video', w: 720, h: 1280 }] }
  const html = await body(render({ kind: 'post', post: broken }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:video'))
})

test('other-bot and telegram are unaffected by the carve-out', async () => {
  const other = await body(render({ kind: 'post', post: ttVideo }, 'other-bot', ORIGIN))
  assert.match(other, /og:video/, 'the plain head already emitted og:video for other bots')
  const tg = await body(render({ kind: 'post', post: ttVideo }, 'telegram', ORIGIN))
  assert.ok(!/http-equiv=["']?refresh/i.test(tg))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/render.test.mjs`

Expected: FAIL, on **exactly one test** — `A PLAYABLE VIDEO TAKES THE PLAIN og:video PATH, NOT THE SPOOF`. `ttVideo` on `discord` currently returns the spoof head: no `og:video`, and an `application/activity+json` link.

**Every other test in this block already passes, and that is correct.** Before the carve-out, *everything* Discord takes the spoof — so "a slideshow still takes the spoof", "Bluesky is untouched", "a hoisted quote video does not trigger the carve-out" and "a urlless video entry does not trigger it" are all trivially true today. They are **regression guards**: their job is to turn red if Step 3's gate is written too broadly, and a gate of `if (client === 'discord' && !post.media.length)` or one over `mediaList` would do exactly that. Do not read their green as the feature existing, and do not delete them for being green.

- [ ] **Step 3: Write minimal implementation**

`src/render/embed.ts` gains the shared predicate:
```ts
/**
 * "This post has a video Discord can actually play." ONE definition, because the C1 gate in
 * discord.ts and the plain head's own video selection must not answer it differently — the
 * same rule usable() and mediaOf() exist for.
 *
 * mediaOf(post), NOT mediaList(post): the plain head selects a video from the post's OWN media
 * with quote media deliberately excluded, so a gate over the hoisted list would send a post
 * whose QUOTE carries a video down the carve-out and leave the head with nothing to emit — an
 * image head, no gallery, no player, worse than either branch.
 *
 * Returns the Media rather than a boolean so the caller can take its index off the same array
 * it was found in. An index recomputed against a different list is the other half of this bug.
 */
export const playableVideo = (post: Post): Media | undefined =>
  mediaOf(post).find(m => usable(m) && m.kind === 'video')
```

`src/render/discord.ts`:
```ts
  // THE C1 GATE, plus Phase 3a's video carve-out.
  //
  // 3bda8e4 put every Discord response on the spoof head. That head emits NO og:video by
  // design — suppressing OpenGraph media is the mechanism that makes Discord prefer the
  // activity JSON's gallery — so a post with a genuinely playable mp4 would have its video
  // SWALLOWED: a title, a description, and no player.
  //
  // Bluesky never exposed this because normalize.ts turns its HLS video into a still
  // thumbnail with kind:'image'. TikTok is the first platform to produce a real kind:'video'
  // entry, which embed.ts predicted in writing before it existed.
  //
  // Upstream FxEmbed does exactly this: it disables the activity path when there is an
  // external player URL. A slideshow has no video, so it still takes the spoof — which is the
  // whole point, since the gallery is what Phase 2 bought and a TikTok slideshow gets it free.
  //
  // playableVideo() rather than a local find, so this gate and the plain head below cannot
  // disagree about which list or which predicate decides.
  if (client === 'discord' && !playableVideo(post)) return renderSpoof(post, origin)
```
and the plain head's video selection becomes `const video = playableVideo(post)` with `media.indexOf(video)` unchanged (`media` is `mediaOf(post)`, the same array `playableVideo` searched).

**The oEmbed link is deliberately NOT added to the carve-out path in this commit.** With the gate no longer narrowing `client` away from `'discord'`, the `if (client === 'discord') tags.push(oembedLink(...))` line that Phase 2 deleted becomes type-legal again, and adding it would put engagement counts on the author line of a video embed. It is left out because *no measurement exists* for how an oEmbed document interacts with `og:video` in a real client, and the cost of guessing wrong is the player — the one thing this task exists to protect. If Task 11 shows the video plays but the author line is bare, the fix is exactly one line, in this spot, and it is named here so it does not have to be rediscovered.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/render.test.mjs && npm test && npm run typecheck`
Expected: PASS — 6 new tests, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/render/embed.ts src/render/discord.ts test/render.test.mjs
git commit -m "fix: carve playable video out of the spoof path, or TikTok loses its player

3bda8e4 put every Discord response on the Mastodon-spoof head, and that head
emits no og:video by design — suppressing OpenGraph media is the mechanism that
makes Discord prefer the activity JSON's gallery. A post with a genuinely playable
mp4 therefore rendered as a title and a description with no player at all.

Bluesky never exposed this: normalize.ts turns its HLS video into a still
thumbnail with kind:'image'. TikTok is the first platform producing a real
kind:'video' entry, and embed.ts predicted this interaction in writing before it
existed. Upstream FxEmbed does the same carve-out — it disables the activity path
when an external player URL exists.

Slideshows still take the spoof: they have no video, and the gallery is exactly
what Phase 2 bought.

The predicate is extracted to embed.ts and shared, because the gate and the plain
head must ask the same question of the same list. A gate over mediaList would send
a post whose QUOTE carries a video down the carve-out, leaving the head with
nothing to emit — an image head, no gallery, no player.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Platform identity — in the spoof payload AND on the plain head

**Files:**
- Modify: `src/render/mastodon.ts`, `src/render/discord.ts`
- Test: `test/mastodon.test.mjs`, `test/render.test.mjs` (extend)

**Interfaces:**
- Consumes: `Platform`, `Post`.
- Produces: per-`ref.p` lookups for `application.name` and `theme-color`, used by **both** Discord heads.

`mastodon.ts` hardcodes `application: { name: 'Bluesky Social', website: null }`, with a comment saying in as many words that this becomes a per-`ref.p` lookup when Phase 3 lands TikTok. Left alone it ships "Bluesky Social" on **every TikTok embed**. `discord.ts`'s spoof head hardcodes `theme-color #0085ff` — Bluesky blue — which is the same defect with a different symptom; production `fxtiktok` emits `#ff0050` for TikTok, so we have a measured value to use.

#### THE PLAIN HEAD HAS NEVER EMITTED `theme-color` AT ALL

This is the half that a per-`ref.p` lookup in `renderSpoof` alone does not fix, and it is not cosmetic:

**Since Task 7, a TikTok VIDEO post takes the carve-out to the plain-og head** (`src/render/discord.ts`, the `renderPost` body below the gate) — and that head emits `og:title`, `og:description`, `og:url`, `og:site_name`, the video tags… and **no `theme-color`, ever**. So without this change, Task 11's gate item *"the accent colour is TikTok's, not Bluesky's blue"* is **unachievable for exactly the post kind this phase exists to ship**, and the exit criterion *"`theme-color` follows `ref.p`"* would be false. The slideshow would be pink and the video would have no accent at all.

**The spelling is `property=`, and that is MEASURED, not chosen.** Production `fxtiktok` serves this on the same plain-og video head Discord renders with the TikTok accent today (verified 2026-07-18):

```html
<meta property="og:site_name" content="fxTikTok"/>
<meta property="og:title" content="Mystic Aquarium (@mysticaquariumct)"/>
<meta property="theme-color" content="#ff0050"/>
```

That matches the spoof head's existing spelling, so both Discord heads agree. `fail.ts`'s `errorEmbed` keeps `name=` — that divergence stays **recorded rather than unified**, exactly as the spoof head's comment already argues: each spelling is the one its own head was observed working with, and neither observation transfers for free.

One line, beside `og:site_name`, using the same shared lookup.

**Corrupt-key safety, copied from the pattern beside it:** `ATTACHMENT_TYPE` in this same file carries a scar comment about raw lookups on object literals inheriting `Object.prototype` — a corrupt `kind` of `'constructor'` resolved to a *function*, which `JSON.stringify` silently dropped. `ref.p` arrives from the cache with the same absence of validation, so both new lookups check that the **result is a string** rather than falling back on absence.

- [ ] **Step 1: Write the failing test**

Append to `test/mastodon.test.mjs`:
```js
test('application.name follows ref.p — not hardcoded Bluesky on every platform', () => {
  const bs = toMastodonStatus(post(), ORIGIN)
  assert.equal(bs.application.name, 'Bluesky Social')
  const tt = toMastodonStatus({ ...post(), ref: { p: 'tt', id: '777' } }, ORIGIN)
  assert.equal(tt.application.name, 'TikTok')
  assert.equal(tt.application.website, null)
})

test('a corrupt ref.p degrades to a neutral name instead of a function or {}', () => {
  // Same hazard ATTACHMENT_TYPE carries a scar comment for: a raw lookup on an object literal
  // inherits Object.prototype, so 'constructor' resolves to a FUNCTION (silently dropped by
  // JSON.stringify) and '__proto__' to {} where a string is required. deserializePost
  // validates that the ref ROUND-TRIPS, so this is defence in depth — but it is one line.
  for (const p of ['constructor', '__proto__', 'toString', 'nope', 42, null]) {
    const s = toMastodonStatus({ ...post(), ref: { p, id: '1' } }, ORIGIN)
    assert.equal(typeof s.application.name, 'string', String(p))
    assert.ok(s.application.name.length > 0, String(p))
  }
})
```

Append to `test/render.test.mjs`:
```js
test('theme-color follows ref.p on the SPOOF head — Bluesky blue must not ship on TikTok', async () => {
  const bs = await body(render({ kind: 'post', post: base }, 'discord', ORIGIN))
  assert.match(bs, /theme-color" content="#0085ff"/)
  const tt = await body(render({ kind: 'post', post: ttSlides }, 'discord', ORIGIN))
  // #ff0050 is production fxtiktok's measured value (see the Phase 3b parity baseline).
  assert.match(tt, /theme-color" content="#ff0050"/)
  assert.ok(!tt.includes('#0085ff'))
})

test('THE PLAIN HEAD EMITS theme-color TOO — the carve-out path had NONE', async () => {
  // Since Task 7 a TikTok VIDEO post takes the carve-out to the plain-og head, and that head
  // has never emitted theme-color at all. Fixing only renderSpoof leaves the accent colour
  // missing on exactly the post kind this phase exists to ship, which makes the human gate's
  // "the accent colour is TikTok's" item unachievable and the exit criterion false.
  //
  // property=, not name=: measured on production fxtiktok's own plain-og video head, which is
  // the head Discord renders with #ff0050 today. It also matches the spoof head, so the two
  // Discord heads agree. (fail.ts's errorEmbed keeps name= — recorded, not unified.)
  const ttv = await body(render({ kind: 'post', post: ttVideo }, 'discord', ORIGIN))
  assert.match(ttv, /property="theme-color" content="#ff0050"/)
  assert.ok(!ttv.includes('#0085ff'))
  // Still the carve-out path, so this is genuinely the plain head and not the spoof.
  assert.match(ttv, /property="og:video"/)
  assert.ok(!ttv.includes('application/activity+json'))

  // And it follows ref.p there too, rather than being a hardcoded pink.
  const bsv = await body(render({ kind: 'post', post: base }, 'other-bot', ORIGIN))
  assert.match(bsv, /property="theme-color" content="#0085ff"/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mastodon.test.mjs test/render.test.mjs`
Expected: FAIL — every post reports `Bluesky Social`; the spoof head reports `#0085ff` for TikTok; and the plain head reports **no `theme-color` at all**, so the carve-out test fails on an absent tag rather than a wrong colour. Read the failure message: "expected #ff0050, got #0085ff" means only the lookup is missing, while a match failure on a head containing no `theme-color` substring at all means the plain-head line was never added.

- [ ] **Step 3: Write minimal implementation**

In `src/render/mastodon.ts`:
```ts
/**
 * `application.name` per platform. Phase 2 hardcoded 'Bluesky Social' with a note that this
 * becomes a per-ref.p lookup when Phase 3 lands TikTok — left alone it ships "Bluesky Social"
 * on every TikTok embed.
 *
 * The x/ig/th/rd rows are UNVERIFIED placeholders: those platforms have no fetcher, so no
 * Post can reach here carrying them, and the cost of a wrong guess is zero until the phase
 * that verifies it. 'Bluesky Social' and 'TikTok' are the two that are real.
 */
const APPLICATION: Record<Platform, string> = {
  bs: 'Bluesky Social', tt: 'TikTok', x: 'X', ig: 'Instagram', th: 'Threads', rd: 'Reddit',
}

/**
 * Checking the RESULT is a string, not falling back on absence — the same total-over-every-key
 * rule ATTACHMENT_TYPE states two functions up, and for the same reason: a raw lookup on an
 * object literal inherits Object.prototype, where 'constructor' is a function and '__proto__'
 * is an object, and neither is undefined so `??` never fires.
 */
function applicationName(post: Post): string {
  const v: unknown = APPLICATION[(post?.ref as { p?: Platform } | undefined)?.p as Platform]
  return typeof v === 'string' ? v : 'fxeverything'
}
```
used as `application: { name: applicationName(post), website: null }`.

The same shape, exported from `embed.ts` — the module both heads already share their primitives with — and imported by `discord.ts`, for `theme-color`:
```ts
/** #0085ff is the verified Bluesky head; #ff0050 is production fxtiktok's measured value. */
const THEME: Record<Platform, string> = {
  bs: '#0085ff', tt: '#ff0050', x: '#000000', ig: '#c13584', th: '#000000', rd: '#ff4500',
}

/**
 * ONE definition, imported by BOTH Discord heads. The spoof head has always had a theme-color
 * (hardcoded Bluesky blue); the plain head has never had one at all, which since Task 7's
 * carve-out means a TikTok VIDEO post — the whole point of this phase — would render with no
 * accent colour whatever. Two heads spelling this separately is how one of them ends up
 * without it again.
 */
export function themeColor(post: Post): string {
  const v: unknown = THEME[(post?.ref as { p?: Platform } | undefined)?.p as Platform]
  return typeof v === 'string' ? v : '#0085ff'
}
```
with the identical string-result guard, defaulting to `#0085ff` (the one colour a real client has been observed rendering).

Then `discord.ts` uses it in **both** heads. In `renderSpoof`, replacing the hardcoded literal:
```ts
    `<meta property="theme-color" content="${themeColor(post)}"/>`,
```
and in `renderPost`'s plain head, one new line beside `og:site_name`:
```ts
  tags.push(`<meta property="og:site_name" content="fxeverything"/>`)
  // NEW. This head has never emitted theme-color, and since Task 7 it is what a TikTok VIDEO
  // post renders through — so without this line the phase's headline post kind ships with no
  // accent colour. property=, not name=: measured on production fxtiktok's own plain-og video
  // head, and it matches the spoof head above so the two Discord heads agree. No esc(): the
  // value comes from a closed Record<Platform, string>, never from a Post.
  tags.push(`<meta property="theme-color" content="${themeColor(post)}"/>`)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — 4 new tests, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/render/mastodon.ts src/render/embed.ts src/render/discord.ts \
        test/mastodon.test.mjs test/render.test.mjs
git commit -m "fix: platform identity on both heads, instead of hardcoded Bluesky

application.name was the literal 'Bluesky Social' with a comment saying it becomes
a per-ref.p lookup when Phase 3 lands TikTok; left alone it would have shipped on
every TikTok embed. theme-color #0085ff — Bluesky blue — is the same defect with a
different symptom, and production fxtiktok gives us a measured #ff0050 to use.

The PLAIN head had no theme-color at all, and since the video carve-out that head
is what a TikTok video post renders through — so a per-ref.p lookup in renderSpoof
alone would have shipped this phase's headline post kind with no accent colour and
made the human gate's colour check unachievable. It is emitted with property=,
matching both the spoof head and production fxtiktok's own measured plain-og video
head. fail.ts's errorEmbed keeps name=; that divergence stays recorded.

Both lookups check that the RESULT is a string rather than falling back on
absence: ref.p arrives from the cache unvalidated, and a raw lookup on an object
literal inherits Object.prototype, where 'constructor' is a function
(JSON.stringify drops it silently) and '__proto__' is an object. Same rule as
ATTACHMENT_TYPE two functions up, and the same scar behind it.

Rows for x/ig/th/rd are marked unverified placeholders — those platforms have no
fetcher, so nothing can reach them yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end, with no network

**Files:**
- Test: `test/pipeline.test.mjs` (extend)

**Interfaces:** none new. This task proves the seams line up, using the real fixtures and the real normalizer with an injected fetch.

- [ ] **Step 1: Write the failing test**

```js
import { readFileSync } from 'node:fs'
import { normalizeTikTok } from '../src/platforms/tiktok/normalize.ts'

const ttPost = f => normalizeTikTok(readFileSync(`test/fixtures/tiktok-${f}.html`, 'utf8'), { p: 'tt', id: 'REPLACE' })

test('REAL FIXTURE: a TikTok video renders a player, WITH MEDIA ON OUR OWN ORIGIN', async () => {
  // THE ASSERTION TASK 5 COULD NOT MAKE. Before the carve-out (Task 7), a tt video post took
  // renderSpoof, which emits ZERO /_media/ urls on a media post — the C1 suppression is the
  // whole mechanism. Here the carve-out exists, so og:video must be OUR url, not TikTok's.
  const post = ttPost('video')
  const cache = fakeCache()
  const deps = { cache, fetchPost: async () => post, resolveShortlink: async () => null }
  const html = await (await handle(req(`/@u/video/${post.ref.id}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, /property="og:video"/)
  assert.match(html, new RegExp(`/_media/tt%3A${post.ref.id}/0`), 'og:video must point at OUR origin')
  assert.ok(!html.includes('tiktokcdn'), 'no raw CDN url may reach a client')
  assert.ok(!html.includes('aweme/v1/play'))
  assert.ok(!html.includes('webapp-prime'), 'and never a cookie-gated host')
  assert.match(html, /property="theme-color" content="#ff0050"/, 'the carve-out head carries the accent too')

  const key = encodeURIComponent(refKey(post.ref))
  const m = await handle(req(`/_media/${key}/0`), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.ok(m.headers.get('location').includes('/aweme/v1/play/'))
})

test('REAL FIXTURE: a TikTok slideshow becomes a Mastodon gallery, all images, all on our origin', async () => {
  // THE PHASE 2 PAYOFF. Not one line of gallery code was written this phase.
  const post = ttPost('slideshow')
  const deps = { cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => null }
  const id = encodeStatusId(refKey(post.ref))
  const res = await handle(req(`/api/v1/statuses/${id}`, DISCORD), fakeEnv(), ctx, deps)
  assert.equal(res.headers.get('content-type'), 'application/json')
  const json = await res.json()
  assert.equal(json.media_attachments.length, post.media.length)
  assert.ok(json.media_attachments.length >= 2)
  for (const a of json.media_attachments) {
    assert.equal(a.type, 'image')
    assert.match(a.url, /\/_media\/tt%3A/)
  }
  assert.equal(json.application.name, 'TikTok')
})

test('REAL FIXTURE: a deleted TikTok post is an honest failure, not a blank embed', async () => {
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => normalizeTikTok(readFileSync('test/fixtures/tiktok-deleted.html', 'utf8'), { p: 'tt', id: '1' }),
    resolveShortlink: async () => null,
  }
  const res = await handle(req('/@u/video/1', DISCORD), fakeEnv(), ctx, deps)
  assert.match(await res.text(), /could not fetch post/i)
})

test('REAL FIXTURE: a SHORT LINK reaches the same player, on the same canonical media urls', async () => {
  // The seam Task 6 built, driven through the real fixture and the real normalizer: the short
  // code resolves to the canonical ref, and every url it mints is the one the long-form
  // permalink mints. This is the assertion that would catch a resolver quietly storing the
  // short code as the post's identity.
  const post = ttPost('video')
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => { throw new Error('a short link must resolve, not fall through to fetchPost') },
    resolveShortlink: async () => post,
  }
  const short = await (await handle(req('/t/ZTSw2mYwR', DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(short, new RegExp(`/_media/tt%3A${post.ref.id}/0`))
  assert.ok(!short.includes('ZTSw2mYwR'), 'the short code must not survive into the output')

  // Same warm cache entry, same bytes, from the long-form permalink.
  const long = await (await handle(req(`/@u/video/${post.ref.id}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.equal(long, short, 'both spellings of one post must render identically')
})
```

- [ ] **Step 2: Run, fix the seams, commit**

Run: `npm test && npm run typecheck`
Expected: PASS. If any of these fail, the failure is in a *seam* — a wire format two modules spell differently — and that is exactly what this task exists to catch before staging.

```bash
git add test/pipeline.test.mjs
git commit -m "test: TikTok end to end through the real fixtures, with no network

A video post reaches a player whose og:video is on OUR origin — the assertion the
dispatch task could not make, because before the carve-out a tt video took the
spoof head, which emits zero /_media/ urls on a media post by design. /_media/0
302s to the aweme url; a slideshow becomes a Mastodon gallery with every image on
our own origin; a deleted post is an honest failure embed rather than a blank one;
and a short link renders byte-identically to the long-form permalink, on the same
canonical media urls.

The slideshow case is the Phase 2 payoff arriving: not one line of gallery code
was written this phase.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Deploy to staging, delete the probe, verify by curl

**Files:**
- Delete: `src/probe.ts`, `test/probe.test.mjs`
- Modify: `src/worker.ts` (unmount), `src/analytics.ts` (drop `PROBE_TOKEN`)
- Test: `test/pipeline.test.mjs` (extend — the deletion needs an enforcer that OUTLIVES it)

The probe is a debug endpoint that fetches an arbitrary caller-supplied id from our egress. It existed for one measurement, that measurement is recorded in `docs/research/2026-07-18-tiktok-workers-egress-probe.md`, and the safest moment to remove it is before the deploy this phase is judged on — not after, when "it's only on staging" starts sounding like a reason.

#### The deletion must be ENFORCED, not requested

`git rm` deletes the files. **Nothing deletes the mount.** If an agent runs the `git rm` and skips the unmount, `src/probe.ts` is gone, `import { runProbe } from './probe.ts'` fails typecheck — but if it skips *both* edits, or removes the import and leaves a dead `PROBE_TOKEN` branch, `npm test` and `npm run typecheck` both stay green **and the endpoint ships to a public staging origin**. A comment in a bash block (`# unmount from worker.ts`) is not a check; it is a hope.

So the enforcement is a test in a **surviving** test file — one that `git rm` cannot take with it — and it is written FIRST, in the TDD order this plan uses everywhere else.

- [ ] **Step 1: Write the enforcing test, and watch it FAIL**

Append to `test/pipeline.test.mjs` (which survives this task):
```js
import { existsSync, readFileSync } from 'node:fs'

test('THE PROBE IS GONE — a debug egress endpoint must not ship to a public origin', () => {
  // This test exists because the probe's removal was, in the first draft of this plan, a BASH
  // COMMENT. An agent that ran `git rm` and skipped the unmount left a token-gated endpoint
  // that fetches a caller-supplied id from our egress, on a public staging hostname, with a
  // green suite and a clean typecheck. Source-level, deliberately: the mount is the thing that
  // survives a partial deletion, and it is what a cutover would carry into production.
  assert.equal(existsSync('src/probe.ts'), false, 'src/probe.ts must be deleted')
  assert.equal(existsSync('test/probe.test.mjs'), false, 'test/probe.test.mjs must be deleted')
  for (const f of ['src/worker.ts', 'src/analytics.ts']) {
    const src = readFileSync(f, 'utf8')
    assert.ok(!src.includes('_probe'), `${f} still mounts the probe`)
    assert.ok(!src.includes('PROBE_TOKEN'), `${f} still references PROBE_TOKEN`)
    assert.ok(!src.includes('runProbe'), `${f} still imports runProbe`)
  }
})

test('and the probe PATH is now just an unknown path, even with a token in env', async () => {
  // The behavioural half. Note it does NOT assert a non-200: after the unmount, /_probe/t is a
  // depth-2 unknown path, which route() answers `notfound` and render() answers with an error
  // embed at HTTP 200 for a crawler. The assertion is on the BODY — no probe report may exist.
  const env = { ...fakeEnv(), PROBE_TOKEN: 't' }
  const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => null }
  const res = await handle(req('/_probe/t?id=123', DISCORD), env, ctx, deps)
  const text = await res.text()
  assert.ok(!text.includes('"page"'), 'no probe report may be emitted')
  assert.ok(!text.includes('markerPresent'), 'nor any field of one')
})
```

Run: `node --test test/pipeline.test.mjs`

Expected: **FAIL** — the probe still exists at this point in the plan. Both tests turn red, which is the point: they are the only thing standing between "the agent meant to unmount it" and "the agent unmounted it".

- [ ] **Step 2: Delete the probe FIRST, then deploy**

```bash
git rm src/probe.ts test/probe.test.mjs
# Now make the test above pass. BOTH edits, and the test is what proves both happened:
#   - src/worker.ts   — remove the `if (env.PROBE_TOKEN && …) return runProbe(url)` branch
#                       AND its import
#   - src/analytics.ts — remove `PROBE_TOKEN?: string` from Env
npx wrangler secret delete PROBE_TOKEN
npm test && npm run typecheck
```

Expected: PASS — and the suite is now permanently unable to go green with the probe mounted.

- [ ] **Step 3: Deploy and confirm production is untouched**

```bash
npm run deploy
# The wrangler output must list ONLY staging.megapenispoopenfarten.sex.
# Prod must still be the live fxtiktok worker — its 18-tag video head, unchanged:
curl -s -A 'Discordbot/2.0' https://megapenispoopenfarten.sex/t/ZTSw2mYwR/ | grep -c '<meta'
```

- [ ] **Step 4: Machine-checkable staging verification**

Everything here asserts on **content**, never on status and never on content-type.

```bash
S=https://staging.megapenispoopenfarten.sex
V=/@USER/video/VIDEO_ID
P=/@USER/photo/SLIDESHOW_ID

# 1. Video post -> the carve-out head: og:video present, NO activity link.
curl -s -A 'Discordbot/2.0' "$S$V" | tee /tmp/v.html | grep -E 'og:video|activity\+json|og:image'
#    Expect: og:video, og:video:secure_url, og:video:type, og:video:width/height.
#    Expect: NO application/activity+json, NO og:image.

# 2. The media URL 302s to the aweme endpoint — and NOT to a webapp-prime host.
LOC=$(curl -s -o /dev/null -D - "$S/_media/tt%3AVIDEO_ID/0" | tr -d '\r' | awk '/^location:/{print $2}')
echo "$LOC" | grep -q '/aweme/v1/play/' && echo OK-aweme || echo FAIL
echo "$LOC" | grep -q 'webapp-prime' && echo FAIL-gated || echo OK-not-gated

# 3. THE BYTES. Cookie-free, exactly like Discord's media proxy. ftyp at 4-8 is the ONLY
#    reliable check: a gated 403 is served AS video/mp4 with a 522-byte Access Denied body.
curl -sL --max-filesize 200000 -r 0-1023 "$LOC" | xxd -l 16 | head -1
#    Expect '....ftypisom' — bytes 4-8 are 66 74 79 70.

# 4. Slideshow -> the spoof head, then the gallery itself.
curl -s -A 'Discordbot/2.0' "$S$P" | grep -E 'activity\+json|og:image|theme-color'
#    Expect: the activity link, theme-color #ff0050, and ZERO og:image.
ID=$(curl -s -A 'Discordbot/2.0' "$S$P" | grep -o 'statuses/[0-9]*' | head -1 | cut -d/ -f2)
curl -s "$S/api/v1/statuses/$ID" | python3 -m json.tool | head -40
#    Expect: application.name "TikTok", media_attachments with one /_media/ url per image.

# 5. A deleted post -> error embed for a crawler, 302 for a human.
curl -s -A 'Discordbot/2.0' "$S/@u/video/DELETED_ID" | grep -i 'could not fetch'
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$S/@u/video/DELETED_ID"

# 6. A REAL SHORT LINK RESOLVES — the same embed as the long-form permalink.
curl -s -A 'Discordbot/2.0' "$S/t/ZTSw2mYwR" | tee /tmp/short.html | grep -E 'og:video|_media|theme-color'
#    Expect: og:video on OUR /_media/tt%3A{numeric id}/0 — the CANONICAL numeric id, never the
#    short code — plus theme-color #ff0050. Then prove both spellings agree byte for byte:
diff <(cat /tmp/v.html) <(cat /tmp/short.html) && echo OK-identical || echo FAIL-diverged
#    (Use the same post for $V and the short link, or this diff is meaningless.)

# 7. AND A NON-TIKTOK CODE STILL DEGRADES — never guessed, never dead-ended.
#    DTI1vjIEi5y is a real THREADS code; verified 2026-07-18 to land on the TikTok homepage
#    with the webapp.video-detail scope absent.
curl -s -o /dev/null -w '%{http_code}\n' "$S/t/DTI1vjIEi5y"      # expect 300 (the chooser)
curl -s -A 'Discordbot/2.0' "$S/t/DTI1vjIEi5y" | grep -i 'ambiguous'

# 8. THE PROBE IS UNREACHABLE on the deployed worker, not just in the source tree.
curl -s "$S/_probe/anything?id=123" | grep -q '"page"' && echo FAIL-probe-live || echo OK-probe-gone

# 9. Bluesky did not regress.
curl -s -A 'Discordbot/2.0' "$S/profile/bsky.app/post/3l6oveex3ii2l" | grep -c activity+json
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove the Workers-egress probe and deploy TikTok to staging

The probe answered its one question and the answer is in
docs/research/2026-07-18-tiktok-workers-egress-probe.md. It fetched a
caller-supplied id from our egress, so it goes before the deploy this phase is
judged on, not after.

The removal is ENFORCED by a test in a surviving file, not requested by a comment
in a shell block. `git rm` takes the probe's own files; nothing took the MOUNT,
and a run that deleted the files but skipped the unmount left the endpoint live
on a public origin with a green suite and a clean typecheck. The suite can no
longer go green with `_probe` or `PROBE_TOKEN` anywhere in worker.ts or
analytics.ts.

Staging verified by curl: the video head carries og:video and no activity link,
/_media/{key}/0 302s to the /aweme/v1/play/ endpoint and never to a gated
webapp-prime host, and a cookie-free range request on that location returns bytes
with ftyp at 4-8 — the only reliable check, since a gated 403 is served AS
video/mp4 with a 522-byte Access Denied body. The slideshow takes the spoof and
its Mastodon status carries one /_media/ url per image.

megapenispoopenfarten.sex untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: THE HUMAN GATE — and the changelog

**Files:**
- Modify: `docs/CHANGELOG.md`

**This cannot be settled locally, and it cannot be settled by curl.** Everything Task 10 checked is *necessary* and none of it is *sufficient*:

- **Does the video actually PLAY?** Our Worker never fetches the aweme URL in production — **Discord's media proxy does, from Discord's IPs.** No test we can run measures that network path. Task 1's probe measured Workers egress, which is a different network. The `ftyp` check in Task 10 proves *a* cookie-free client gets bytes; it does not prove *Discord's* cookie-free client does.
- **Does the slideshow render as a gallery?** Discord's embed debugger does **not** render the Mastodon-spoof path faithfully — Phase 2 recorded this and then confirmed it, and the Phase 2 gate was passed by a human looking at a phone.

So: a human, in a real client. There is no substitute and pretending otherwise is how this ships broken.

- [ ] **Step 1: THE GATE — paste into real Discord clients (desktop AND Android; iOS if available)**

- [ ] A TikTok **video** post: an inline **player appears** and **the video plays**. Not a thumbnail, not a blank box.
- [ ] The same post's **title, caption and author** are right, and **the accent colour is TikTok's pink `#ff0050`, not Bluesky's blue** — this is the plain-og carve-out head, which gained `theme-color` in Task 8 and had none before it.
- [ ] A TikTok **photo slideshow**: **every image** renders as a gallery, not one image and not none, **and its accent is pink too** (that one is the spoof head — two different code paths, both checked).
- [ ] A **`/t/{code}` short link**: the same embed as the long-form permalink, player and all. This is the one production serves today, so it is a regression check as much as a feature check.
- [ ] A **Bluesky** multi-image post still renders its 2×2 gallery — the regression check on Task 7's gate.
- [ ] A **deleted** TikTok post shows the error embed, and clicking through as a human lands on TikTok.

**If the video does not play:** the carve-out worked (og:video is in the HTML — Task 10 proved that) and Discord's media proxy is the problem. Do **not** revert Task 7; capture what the client shows and take decision-tree branch 4 from Task 1 to the human. If it plays but the author line is bare, the oEmbed link is the one-line change named in Task 7, Step 3.

**If the slideshow shows one image or none:** the spoof path is at fault, not TikTok. Compare against the Bluesky gallery in the same client — if Bluesky also degraded, something in Task 7 or 8 broke the shared path and the revert is `src/render/discord.ts`'s gate.

- [ ] **Step 2: Changelog**

Add a Phase 3a section to `docs/CHANGELOG.md`, matching the existing style: what shipped, the facts a future reader must not re-derive, what the human gate showed, and — stated plainly — that **the production cutover is Phase 3b and did not happen**. Record the test count and that `megapenispoopenfarten.sex` is untouched.

The facts worth the words, in rough priority:

1. **The UA gate is INVERTED from Instagram's** — the one most likely to be "fixed" backwards.
2. **`statusCode` beats HTTP status**: a deleted post is HTTP 200 with a full valid page.
3. **The aweme URL**, why `playAddr` and `*-webapp-prime` are unusable (cookie-gated), and why selection is by substring and never by index.
4. **`ftyp` at bytes 4-8 beats content-type**, because a gated 403 is served *as* `video/mp4`.
5. **`createTime` is a STRING and `stats` is mixed-typed** — and that a `typeof === 'number'` guard passes every synthetic test while rejecting every real post.
6. **A `/t/{code}` short link resolves in ONE redirect-following fetch**, and `webapp.video-detail` present + `statusCode 0` is the whole discriminator — the homepage carries a rehydration blob too, so the marker alone proves nothing.

Also record, so a 3b reader does not go hunting for it: **the spec's "generate our own device IDs" requirement (spec §585) is MOOT for us.** That requirement belongs to upstream fxTikTok's *API* path, which needs a plausible device identity to call TikTok's internal endpoints. We take the **page-scrape** path instead — a plain browser UA against the public post page — so there is no device ID to generate, nothing to rotate, and no fingerprint to maintain. It is not skipped or deferred; it does not apply.

- [ ] **Step 3: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "docs: Phase 3a changelog — TikTok extraction, verified on staging

Records the facts a future reader must not re-derive: TikTok's UA gate is INVERTED
from Instagram's; statusCode beats HTTP status on a deleted post; the
/aweme/v1/play/ URL is the only cookie-free playable one; ftyp at bytes 4-8 is the
only reliable check because a gated 403 is served as video/mp4; createTime is a
STRING and stats is mixed-typed, so a typeof-number guard passes every synthetic
test while rejecting every real post; and a /t/{code} short link resolves in ONE
redirect-following fetch, discriminated by the webapp.video-detail scope rather
than by the rehydration marker, which the TikTok homepage carries too.

Also records that the spec's 'generate our own device IDs' requirement is MOOT for
us: it belongs to upstream's API path, and we take the page-scrape path.

The production cutover is Phase 3b and did not happen.
megapenispoopenfarten.sex still serves the live fxtiktok worker.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 3a Exit Criteria

- [ ] `npm test` passes; `npm run typecheck` clean.
- [ ] The Workers-egress probe result is recorded in `docs/research/`, the probe is **deleted from the code**, and a surviving test **fails if it comes back**.
- [ ] A TikTok video post **plays inline** in a real Discord client, with media served from `/_media/`.
- [ ] A TikTok photo slideshow renders as a **gallery** in a real Discord client.
- [ ] A **`/t/{code}` short link renders the same embed as the long-form permalink**, on the same canonical `/_media/` URLs — and a non-TikTok code degrades to the chooser without guessing.
- [ ] A Bluesky multi-image post still renders its gallery — no regression from the carve-out.
- [ ] A deleted TikTok post gives a crawler an error embed and a human a 302.
- [ ] No raw CDN URL and no cookie-gated `webapp-prime` URL appears in any rendered output.
- [ ] `application.name` follows `ref.p`; no TikTok embed says "Bluesky Social".
- [ ] `theme-color` follows `ref.p` **on BOTH Discord heads** — the spoof head *and* the plain-og carve-out head a video post renders through.
- [ ] A blocked or changed TikTok page counts `assert_fail`, distinguishably from a deleted post's `fetch_fail`.
- [ ] **`megapenispoopenfarten.sex` is untouched and still serves `fxtiktok`.**

## Not in Phase 3a (deferred)

| Deferred | To | Why |
|---|---|---|
| The production cutover, `public/` files, unrouting `fxtiktok` | **3b** | Separately gated; needs explicit human sign-off |
| The Threads *half* of the `/t/{code}` resolver | 4 | 3a resolves the TikTok half, which decides the yes case on its own; a code TikTok does not claim degrades to the `['tt','th']` chooser until Threads has a fetcher. **`/t/{code}` itself is NOT deferred — see Task 6.** |
| `vm.`/`vt.tiktok.com` short links | 3b/4 | A HOSTNAME, not a path: needs the `*.megapenispoopenfarten.sex/*` wildcard, which staging does not have and prod's `fxtiktok` still owns. Unrelated to `/t/{code}`, which 3a ships. |
| Byte-proxying TikTok video | only if forced | Spec permits it per-platform with a recorded reason; it invents a bandwidth bill and touches an unresolved ToS question — a human's call |
| oEmbed link on the video carve-out path | after the gate | One line, named in Task 7; unmeasured against `og:video`, and the cost of guessing wrong is the player |
| Instagram, Threads, X, Reddit | 4-5 | Per the spec's build order |

---

## What Phase 3b will need

**Recorded, not acted on.** Do not do any of this in Phase 3a.

### The parity baseline — what production `fxtiktok` does today

Measured before this phase. 3b is judged against the spec's **absolute checklist** ("correct behaviour, not equivalent behaviour"), so this is the baseline to *understand*, not a target to match — but nothing here may be lost by accident.

**Transport:**
- Crawler UA → HTTP 200, head-only HTML, `cache-control: public, max-age=3600`.
- Human UA → 302 to `www.tiktok.com` with the **verbatim** request path.

**A video post emits 18 meta tags:** `og:site_name`, `og:title`, `theme-color #ff0050`, `twitter:site`, `twitter:creator`, `twitter:title`, `og:url`, `og:description`, `og:video` → **`offload.tnktok.com`**, `og:video:type` **×2 (a real duplicate bug upstream — do not reproduce it)**, `og:video:width 720`, `og:video:height 1280`, `og:type video.other`, `twitter:player:*`. Plus **oembed** and **activity+json** links.

**A slideshow post repeats a 6-tag block PER IMAGE:** `og:image` ×3, `og:image:type` ×3, `og:image:width` ×3, `og:image:height` ×3, `og:type` ×3, `twitter:card` ×3. (Our Mastodon-spoof gallery is a different and better mechanism; this is what it replaces.)

**Failure modes today:** missing video → **HTTP 500** with `og:title` "❌ Could not find video data"; bad short link → **HTTP 400** "❌ Invalid vm link"; image index out of range → **500 text/plain**. Ours degrade instead — that is an improvement, and it is also a *difference*, which is why the gate is a checklist and not a diff.

### The spec's cutover checklist — one item left, and it is not the one you would expect

Cut over only when **all** of these produce a correct Discord embed on staging, with media from our own `/_media/`:

- [ ] a standard video post — **3a delivers this**
- [ ] a photo/slideshow post — **3a delivers this**
- [ ] a `/t/{code}` short link — **3a delivers this** (Task 6; it was resolved, not deferred)
- [ ] a deleted/invalid post → error embed for crawlers, 302 for humans — **3a delivers this**
- [ ] a `vm.tiktok.com` short link (via the subdomain hint) — **3a does NOT deliver this**

**The `/t/{code}` blocker is RESOLVED. Do not re-litigate it.** An earlier draft of this plan deferred it on the premise that a short code could not be resolved without a second round trip and a Threads fetcher. Both halves were false, and measurement disproved them (verified fact 10): resolution is one redirect-following fetch, and `webapp.video-detail` present + `statusCode 0` decides the yes case with no Threads probe involved. The Threads half only ever mattered for the **no** case, which degrades to the chooser either way.

**One item remains, and it is a deployment-topology problem, not a code problem.** `vm.tiktok.com` is a **HOSTNAME**. Reaching it needs the `*.megapenispoopenfarten.sex/*` wildcard, which belongs to the live `fxtiktok` worker; staging is a single specific hostname, deliberately (Phase 1's smoke test forbids a wildcard route), and spec §Deployment says so outright: *"The staging zone needs the same apex + wildcard shape, or the subdomain-hint path cannot be tested at all."*

So 3b's actual choice, to put to the human before starting:
1. give staging the apex + wildcard shape, so the subdomain hint can be exercised before the cutover; or
2. accept that this one item is verified **after** the route move rather than before, on production, with `fxtiktok` still deployed and one command from being re-routed.

That is a real decision with a real trade, and it is a much smaller one than the checklist looked like before Task 6 existed.

### Mechanics 3b will have to get right

- **Route move:** apex `megapenispoopenfarten.sex` (custom domain) **and** `*.megapenispoopenfarten.sex/*` (route) both currently belong to `fxtiktok`. The wildcard will ambush any new route on the zone. Move both, then unroute `fxtiktok` — the worker stays deployed, so the whole thing is trivially reversible.
- **`public/` must ship in the same move.** With `not_found_handling: "none"`, a missing `index.html`, `favicon.ico` or `robots.txt` is a hard 404 on the production apex. The *converter* is Phase 5; the three files existing is 3b's problem.
- **Prod may diverge from `main`.** Hash live production against the branch before merging anything — a docs-only PR is not a no-op deploy if prod has diverged.
- **Deleting the offload is the point.** Production's `og:video` currently points at `offload.tnktok.com`, a hostname a stranger controls; it redirects rather than proxies, so removing it costs no bytes and ends a dependency on a third party's uptime (upstream issues #32, #38, #51 are all offload downtime). Phase 3a already never introduces it.
- **Licensing:** carry `okdargy/fxTikTok`'s MIT notice and both copyright lines (dargy 2025, dangered) with the ported logic.
- **The spec's "generate our own device IDs" requirement (spec §585) is MOOT — do not go looking for it.** It belongs to upstream fxTikTok's **API** path, which needs a plausible device identity to call TikTok's internal endpoints. Phase 3a takes the **page-scrape** path instead: a plain browser UA against the public post page, with no device ID, nothing to rotate and no fingerprint to maintain. A 3b reader auditing spec conformance will find this requirement unimplemented and should record it as *not applicable*, not as a gap. If a future phase is ever forced onto the API path (Task 1's decision-tree branch 2), the requirement comes back with it.
