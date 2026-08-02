# fxeverything — Instagram extraction (staging only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real Instagram **single image**, a real **carousel that mixes images and videos**, and a real **reel** each render correctly in a Discord embed on `staging.megapenispoopenfarten.sex` — with media served from our own `/_media/` route, video that actually plays, and **zero production risk**.

**Architecture:** Unchanged. Instagram is platform #3 and is meant to cost a fetcher, a normalizer, a router matcher and a handful of small edits. `fetchInstagram` pulls `/p/{shortcode}/embed/captioned/` with a **crawler UA**, `normalizeInstagram` parses the embedded `shortcode_media` GraphQL object into the shared `Post`, and — unusually — almost everything downstream is *already* `ig`-aware, including the two lookup tables that cost TikTok a whole task. The genuinely new work is small and is named honestly in Task 6.

**Tech Stack:** TypeScript, Cloudflare Workers, `wrangler`, `node --test` (Node ≥24 strips types natively). No runtime dependencies, no framework, no containers. Builds on the Phase 2 / 3a branch.

**Spec:** `docs/superpowers/specs/2026-07-16-fxeverything-design.md` — §Platforms/Instagram, §Media, §Routing, §Testing.
**Prior plans:** `docs/superpowers/plans/2026-07-17-phase-1-skeleton-bluesky.md`, `…-phase-2-renderer-depth.md`, `…-2026-07-18-phase-3a-tiktok.md`.
**Prior research:** `docs/research/2026-07-18-phase-2-mastodon-spoof-wire-spec.md`, `docs/research/2026-07-18-tiktok-workers-egress-probe.md`, `docs/research/2026-07-19-aweme-resolution-from-workers.md`.

---

## Why Instagram now

The owner's stated priority is **TikTok and Instagram first, then everything else**. TikTok ships. Instagram is therefore next, ahead of Twitter, and this is not re-argued anywhere in this document. Twitter is cheaper to build; that is not the ordering criterion and no task here should reopen it.

**One naming rule, applied throughout:** the platform is called **Twitter** in all prose. The internal platform code stays `'x'` — that is an identifier, not a name, and renaming it would churn `PostRef`, `refKey`, every cache key and the router for nothing.

---

## Global Constraints

(Inherited from Phases 1–3a — every task's requirements implicitly include all of these.)

- Zero runtime dependencies. devDependencies exactly: `@cloudflare/workers-types`, `typescript`, `wrangler`.
- **Assert on CONTENT, never on status code — and never on `content-type` either.** Instagram makes both lie: the decoy shell is served at **HTTP 200** with a perfectly ordinary `text/html`. This is the one silent failure mode the spec's testing table names by itself.
- Never guess an ambiguous path. Ambiguity resolves to `{kind:'ambiguous'}`, never a platform.
- **Never dead-end a root token.** Shape-match with fallthrough. This project has shadowed real post permalinks twice by reserving a token (`/x/status/123` under `@x`, then `@api`).
- Never proxy media bytes. `/_media/*` reads the Post cache and 302s.
- Renderers emit `/_media/{refKey}/{index}` URLs, never raw CDN URLs — including in `media_attachments`.
- Never `Vary: User-Agent`. Client class goes in the cache key.
- Cache keys derive from `refKey(ref)`, never the raw path.
- Origin always derived from the request, never hardcoded.
- Log nothing identifying. No URLs, no post IDs, no shortcodes, no IPs. Counters only.
- **Pure core:** fetchers do I/O; normalizers and renderers are pure and test with **no network**.
- **Do not touch `megapenispoopenfarten.sex`.** Staging only, for the entire phase.
- TDD: write the failing test, **RUN it**, confirm it fails for the right reason, then implement.
- Commit identity is pinned to `shamu4life`. Never pass `-c`, `--author`, or set `user.email`.

---

## THE EDGE-CACHE HAZARD — read before you run a single live test

This is a hard requirement on every verification step in this plan, not a footnote. It cost a full day on TikTok.

Our embed HTML was being cached at Cloudflare's edge for **FOUR HOURS** — `cf-cache-status: HIT`, `age: 871`, `cache-control: max-age=14400` — because we set no `Cache-Control` and the zone applied a default. The testing loop was: curl a URL (**which populates the edge cache**), deploy a fix, hand the same URL to a human, and Cloudflare serves them the **pre-deploy** document. Four separate hypotheses about Discord's card selection were recorded as "refuted by measurement" when the measurement never saw the new code at all.

`src/render/fail.ts` now sets `public, max-age=0, must-revalidate` on every HTML response, which fixes the origin's side of it. **It does not fix the zone.** A zone-level cache rule still overrides the origin header and ignores query strings, so **the edge cache key is the PATH alone** — appending `?v=2` buys nothing.

Therefore, until a cache-bypass rule exists for staging:

> **EVERY LIVE TEST MUST USE A POST URL THAT HAS NEVER BEEN FETCHED BEFORE.**

Not a new query string. Not a new UA. A **different shortcode** — and see the correction below before reaching for a different path spelling.

A corollary that matters more than it looks: **any conclusion drawn from a same-URL retest inside the cache window is void.** If you find yourself writing "I tried it again and it still does X", check what URL you used first.

Budget shortcodes accordingly. Collect **at least six** live posts before Task 8 (two single-image, two carousels, two reels) so the staging pass and the human gate each get fresh ones.

> #### CORRECTION, measured against staging 2026-07-20 — read this instead of the paragraph above
>
> The original text said `/p/X`, `/reel/X` and `/instagram/p/X` are **three distinct edge keys**, and offered a different path spelling as a way to get a clean read on a burned shortcode. **That workaround does not exist.** Measured live, three spellings of one post return ONE entry whose `age` climbs in lockstep (`/p/` 125→130→135, `/reel/` 125→130→136, `/tv/` 125→130→136, identical `last-modified` throughout). Independent entries cannot share a monotonic age counter.
>
> **The mechanism is ours, not Cloudflare's**, which is why no zone change can restore the workaround: `respCacheKey(ref, client)` is `resp:{refKey(ref)}:{client}`, and `refKey` collapses every spelling onto one ref **by design** — Task 2's stated goal, locked by *"EVERY SPELLING OF ONE POST COLLAPSES TO THE SAME CACHE KEY"* in `test/router.test.mjs`. Query strings do nothing for the same reason.
>
> **In mitigation, the window is 15 minutes, not 4 hours.** Observed directly across the boundary, not inferred from the constant: `HIT age:895` → (next request) a fresh origin render carrying `public, max-age=0, must-revalidate` and no cache status → a new entry whose age restarts at 20. The entry is bounded by `RESP_TTL = 900 s` (`src/cache.ts`). **The `cache-control: max-age=14400` on a hit is cosmetic** — a zone Browser-Cache-TTL rewrite applied on the way out, not the edge lifetime; reading it as one is what produced the "burned for four hours" belief. So a burned shortcode is reusable after ~15 minutes and **no phase is ever blocked for four hours by one curl**. This does not license reuse inside the window.
>
> **Failure renders are never cached at all** (`src/worker.ts` returns the error embed without a `cache.put`), verified over five consecutive requests to a nonexistent shortcode. Nonexistent codes are therefore free — use them for any cache-key or routing experiment rather than spending real shortcode budget, which is how this correction was measured.
>
> Full working: `docs/research/2026-07-19-instagram-workers-egress-probe.md`.

---

## Instagram verified facts

Read from **InstaFix's source** and **confirmed live on 2026-07-19**, from a residential IP unless stated otherwise. Cite these; do not re-derive them and do not contradict them. Where something is *not* verified it says so — those are the only places judgement is required.

### 1. THE ENDPOINT, and it needs nothing

```
https://www.instagram.com/p/{shortcode}/embed/captioned/
```

**NO credentials, NO cookie, NO `x-ig-app-id`, NO CSRF token, NO session.** InstaFix sends only Go's default User-Agent and gets the real payload. There is no auth handshake to port, nothing to rotate, and no device identity to generate — the Instagram analogue of the TikTok note that upstream's "generate our own device IDs" requirement was moot for the page-scrape path.

`/reel/{code}/embed/captioned/` and `/p/{code}/embed/captioned/` are **INTERCHANGEABLE** — byte-for-byte the same payload. So the fetcher has exactly **one** spelling of the URL and never has to know which surface the link came from. This is load-bearing for Task 2's cache-key decision.

### 2. THE UA GATE IS INVERTED FROM TIKTOK'S. Read this twice.

| UA | Bytes | Payload | Verdict |
|---|---|---|---|
| `facebookexternalhit/1.1` | 98,682 | yes | **REAL** |
| `Discordbot/2.0` | 98,728 | yes | **REAL** |
| `curl/8.4.0` | 98,663 | yes | **REAL** |
| `Chrome/122` | **599,264** | **no** | **DECOY** |

Claim to be a browser and Instagram assumes you have JavaScript and serves a large empty shell. Claim to be a crawler and it server-renders the content. OGInstagram's source documents it outright (`config.go:62`: *"embedUA is intentionally non-browser… a modern Chrome UA gets an empty JS shell"*).

**This is the exact opposite of TikTok**, where a crawler UA gets a ~7KB decoy and a plain Chrome UA gets the real page. Both facts are true, about different platforms, and this repo already carries the TikTok half in language that reads almost identically — `src/platforms/tiktok/fetch.ts` and `src/platforms/tiktok/normalize.ts` both open with a paragraph warning about precisely this conflation. **A future reader will conflate them.** So Task 4 asserts mechanically that `INSTAGRAM_UA` **is** crawler-shaped, mirroring the existing TikTok test that asserts `TIKTOK_UA` is **not**. Two tests pointing in opposite directions is what makes the inversion impossible to "fix" silently in either direction.

`curl/8.4.0` succeeding is the decisive row: the least browser-like TLS fingerprint available gets the real content. **The widely-repeated belief that Instagram gates on TLS/JA3 fingerprint is FALSE.** The gate is the User-Agent. This is why InstaFix died — its `curl_cffi` sidecar impersonates Chrome, which is the exact UA class that gets served the decoy.

### 3. THE PAYLOAD: the whole `shortcode_media` object, inline

The response HTML embeds the **entire GraphQL `shortcode_media` object** as escaped JSON inside a `TimeSliceImpl` script line. Extract that, unescape it, `JSON.parse` it, walk to `shortcode_media`.

`shortcode_media` carries the caption, the owner, the dimensions, `display_url`, `video_url` when there is one, and — for a carousel — `edge_sidecar_to_children.edges`, which contains **EVERY child, not just the cover**.

**Do not write the extractor from this paragraph.** Task 3, Step 1 captures a real fixture and *prints its structure*, and the normalizer is written against what that prints. The field names above are the ones we have evidence for; the interior shapes of `edge_media_to_caption`, `owner` and the children are things you will read off the capture. This is the same discipline the TikTok plan enforced for `imagePost` and for the same reason: upstream's field names are a different snapshot of the same adversarial platform, and the fixture in front of you is the evidence.

### 4. VIDEO WORKS, COOKIE-FREE, AT ZERO REDIRECT HOPS

**VERIFIED LIVE, cookie-free:** reel `Da5ynsiuAZ_` yielded a `video_url` that downloaded as **6,887,308 bytes**, h264/aac, 720×1280, 75.58s — a real, playable MP4 — at **ZERO redirect hops**.

That last clause is the most valuable fact in this document, and it is best understood against TikTok's scar. TikTok's playable URL is the `/aweme/v1/play/` endpoint, which is itself a **302** to the real CDN bytes. Discord therefore saw **two** hops between it and the video and drew the plain OpenGraph card instead of the rich activity card. We tried to collapse it by resolving the 302 server-side and `docs/research/2026-07-19-aweme-resolution-from-workers.md` settled that we cannot: twelve request shapes, one distinct `Location` between them, and it is TikTok's own 404 page. The egress IP is the variable and a request shape cannot change it.

**Instagram's `video_url` has no hop to collapse.** It is a direct CDN URL. So Instagram video should reach Discord in the shape TikTok's cannot — *if* the CDN serves the fetching client, which is Task 1's job to probe and the human gate's job to settle.

`display_url` is present alongside `video_url` and is the **poster frame**. See fact 7 for why that is not optional.

### 5. CAROUSELS ENUMERATE COMPLETELY, AND MIX FREELY

**VERIFIED LIVE:** mixed carousel `DaQ5CPTki4E` — **10 children, 4 of them video** — all 10 fetched correctly as JPEG or MP4 from the single embed response. The embed carries every child. There is no pagination, no second request, no `doc_id` to keep current.

### 6. THE UPSTREAM BUG WE MUST NOT INHERIT: use `is_video`, never `__typename`

Sidecar children in the **embed** payload have **no `__typename` field at all**. Their keys are:

```
accessibility_caption, dimensions, display_resources, display_url, id, is_video, owner, shortcode
```

Upstream reads `__typename` to decide image-vs-video, so on this endpoint it reads `undefined` and **mislabels every carousel video as an image**. That is the exact defect fact 5's fixture exists to catch.

> **Use `is_video` as the discriminator.** Everywhere. Top-level and children.

This fails **asymmetrically**, which is why it gets its own fact: a mislabelled video still produces a *plausible* Post — the entry has a `display_url`, so the gallery renders a still and nothing looks broken. It is only wrong in the way that matters (no player, and `preview_url` logic never engages). A hand-written synthetic fixture will naturally include `__typename` because that is what the GraphQL docs show, so the synthetic tests pass and only the real-fixture test fails. **Task 3 therefore requires at least one synthetic carousel fixture whose video child carries `is_video: true` and NO `__typename`**, so the discriminator is exercised by the tests that are easiest to write, not only by the ones that are hardest to debug.

### 7. THE POSTER IS MANDATORY ON A VIDEO ATTACHMENT

Not an Instagram fact — a **measured Discord fact**, from 2026-07-19, and the reason this plan spends a whole section on `display_url`:

```
PROD video    (rich card)  type "video"  preview_url ".../generate/COVER/{id}"  <- an IMAGE
OUR slideshow (rich card)  type "image"  preview_url the image itself           <- fine
OUR video     (PLAIN card) type "video"  preview_url THE VIDEO FILE             <- the bug
```

Discord requests the poster, receives mp4 bytes, and **abandons the rich activity card for the plain OpenGraph one**. The whole embed degrades — no avatar row, no caption, counts in the viewer's system emoji font.

The mechanism to fix it already exists and **must be reused, not reinvented**: `Media.poster` (see `src/types.ts`), the `{poster: N}` member of `MediaIndex`, the `poster{N}` segment already parsed in `src/router.ts`, `pickMedia`'s poster branch in `src/media.ts`, and `posterUrl()` in `src/render/mastodon.ts`. All of it is built, tested and live. **Instagram's only job is to populate `Media.poster` from `display_url` on every video entry.** Do not invent a second mechanism, do not add a parallel field, and do not fall back to `url` when there is no poster — `mastodon.ts` omits the key deliberately and that omission is the fix.

### 8. WHAT IS *NOT* THE MECHANISM — the recorded dead end

Nobody should re-derive these. An earlier probe tested **only** these two and wrongly concluded Instagram video was impossible:

| Attempt | Result |
|---|---|
| Crawler-UA fetch of the **normal post page** (`/p/{code}/`) | Meta tags only. **No JSON blob. Cover image only. NO video URL.** |
| `i.instagram.com/api/v1/media/{id}/info/` | **302 to login**, with or without `x-ig-app-id` |

Both are dead. The `/embed/captioned/` endpoint is a **different surface** with a different gate, and it is the only one in this plan. If a future agent finds a note saying "Instagram video is not available anonymously", that note was written from these two probes and is superseded by fact 4.

### 9. WHAT ALREADY HANDLES `ig` FOR FREE — verify, then collect

More than TikTok got, and this is the phase where the "platform #N is just a fetcher plus a normalizer" claim finally gets a fair test.

**Verified present in the tree today, no changes needed:**

- `src/types.ts` — `PostRef` already declares **both** `{p:'ig'; kind:'p'|'reel'|'tv'; code}` and `{p:'ig'; kind:'story'; user; id}`. **No type change in this entire phase.**
- `src/refkey.ts` — `refKey()` mints `ig:{kind}:{code}` and `ig:story:{user}:{id}`; `parseRefKey()` inverts both, including the `p`/`reel`/`tv` allowlist. Round-trips already.
- `src/render/embed.ts` — `THEME` already carries `ig: '#c13584'`.
- `src/render/mastodon.ts` — `APPLICATION` already carries `ig: 'Instagram'`.
- `src/cache.ts`, `src/statusid.ts`, `src/media.ts`, `src/classify.ts`, `src/analytics.ts`, `src/render/{chooser,text,embed,index,fail,telegram,discord}.ts` — all platform-agnostic, all already exercised by two platforms.

**Those two lookup tables are the sharpest illustration of the point.** They cost Phase 3a an entire task (Task 8) because Phase 2 had hardcoded Bluesky into both. Phase 3a fixed them *generically*, with `ig` rows already filled in and marked as unverified placeholders. This phase's job is to **verify** them (the colour and the name are now reachable by a real Post) and collect the payoff — not to re-do the work.

Both rows are UNVERIFIED as *values* — nobody has confirmed `#c13584` is a colour a real Discord client renders well for Instagram, and unlike TikTok's `#ff0050` there is no production fxtiktok head to read it off. **That is a human-gate item, not a blocker**, and it is one line to change if the human says it looks wrong.

### 10. THE CACHE-KEY SPLIT NOBODY HAS NOTICED YET

`refKey()` puts `kind` in the key, so today:

```
/p/ABC     -> ig:p:ABC
/reel/ABC  -> ig:reel:ABC      <- SAME POST. Two cache entries.
/tv/ABC    -> ig:tv:ABC        <- SAME POST. Three.
```

Fact 1 established that the embed endpoints are byte-identically interchangeable, so these are provably one post. Left alone, pasting the same reel two ways would cost **two upstream fetches on the platform we rate most fragile**, and would split its `/_media/` namespace so the two embeds' image URLs are different strings naming the same bytes.

This is the identical problem TikTok solved by making `video` and `photo` produce the same `{p:'tt', id}` ref, and it gets the identical answer — **at route time, in one line, with no type change**. Task 2 owns it.

### 11. THE ONE BLOCKING UNKNOWN — Workers egress

**Everything above was measured from a RESIDENTIAL IP.** Cloudflare Workers egress is **UNVERIFIED for this payload**, and that exact gap has bitten this project twice:

- **TikTok answers Workers differently than a home connection for a byte-identical URL.** Not the request shape — the *egress IP*. Twelve header variants, one answer, and it was TikTok's 404 page (`docs/research/2026-07-19-aweme-resolution-from-workers.md`).
- **Instagram is known to serve a 597KB decoy shell at HTTP 200 to the wrong requester** (fact 2). A decoy is the worst possible failure: it is a 200, with a valid content-type, and it is large — every lazy health check passes.

**There is partial prior evidence, and it is worth knowing but does NOT settle this.** The spec records a 2026-07-16 Workers-egress probe (IPv6 `2a06:98c0:3600::103`) against `/p/BsOGulcndj-/embed/captioned/` that produced the fact-2 table above — real content from Workers, ~300ms, "Cloudflare datacenter egress is not IP-penalized". That genuinely de-risks Task 1. It does not replace it, for three reasons:

1. It asserted on **`contextJSON`**, which is a *different marker* from the `TimeSliceImpl` / `shortcode_media` path this plan depends on. Whether those are the same blob under two names or two different things is unknown, and Task 1 must report both so we learn which assertion to build the fetcher on.
2. It measured **no video** and **fetched no CDN bytes**. Fact 4 is entirely residential.
3. The **same spec** records that a Workers-egress probe of Instagram *profile* pages returned 0 bytes for every handle including the known-live controls, and concludes: *"Instagram serves profile pages differently to Cloudflare than it serves `/embed/captioned/`."* That is direct evidence that Instagram's behaviour toward Cloudflare is **path-dependent**. A three-day-old positive result on one path is not a blank cheque for a different payload on it.

**Task 1 measures it before any dependent work exists.**

---

## File Structure

| File | Change |
|---|---|
| `src/probe.ts` | **NEW, THROWAWAY** — Task 1's Workers-egress measurement. Deleted in Task 8. |
| `src/platforms/instagram/fetch.ts` | NEW — I/O: embed fetch with a crawler UA, content-asserted |
| `src/platforms/instagram/normalize.ts` | NEW — pure: embed HTML → `Post`; single, carousel, reel |
| `src/router.ts` | MODIFY — `instagram(seg)` matcher in both arms; `known` set shrinks |
| `src/worker.ts` | MODIFY — `liveFetchPost` gains an `ig` case; mount/unmount the probe |
| `src/analytics.ts` | MODIFY — `PROBE_TOKEN?: string` on `Env`, added in Task 1 and removed in Task 8 |
| `src/types.ts` | **UNCHANGED** — and that is a deliverable, not an omission (fact 9) |
| `test/fixtures/instagram-{single,carousel,reel,decoy,gone}.html` | NEW — real captures, minimally re-wrapped |
| `test/instagram-normalize.test.mjs` | NEW |
| `test/{router,render,mastodon,pipeline}.test.mjs` | MODIFY |
| `docs/research/2026-07-19-instagram-workers-egress-probe.md` | NEW — Task 1's measured result |
| `docs/CHANGELOG.md` | MODIFY |

---

### Task 1: Workers-egress probe — BLOCKING, do this first

**Nothing else in this plan may start until this task's result is recorded.** Every Instagram fact in the recon came from a residential IP, and the one prior Workers datapoint asserted a different marker on a payload we are not the ones consuming (fact 11). If Instagram answers a Cloudflare datacenter IP with the decoy, the fetcher we would otherwise write is built on sand and we would find out only at the human gate — after seven tasks of work.

**Files:**
- Create: `src/probe.ts` (throwaway — Task 8 deletes it)
- Modify: `src/worker.ts` (mount the probe behind a staging-only secret), `src/analytics.ts` (`PROBE_TOKEN`)
- Create: `docs/research/2026-07-19-instagram-workers-egress-probe.md`
- Test: `test/probe.test.mjs`

**Interfaces:**
- Consumes: `Env` (a new optional `PROBE_TOKEN`), a shortcode-shaped `code` from the query string.
- Produces: `runProbe(url: URL): Promise<Response>` — a JSON report. And a **decision**, written down.

> **USE THE EXISTING STAGING WORKER.** `wrangler.jsonc` already routes `staging.megapenispoopenfarten.sex` to this worker; the probe is a path on it. **Do NOT create a new Worker in the owner's Cloudflare account.** A previous agent did that without asking and it should not be repeated. If you believe you need a new Worker, stop and ask.

#### What the probe can and cannot settle

Be precise, because the obvious reading is wrong:

- **The EMBED fetch is the blocking measurement.** Our Worker is the only thing that ever fetches `instagram.com/p/{code}/embed/captioned/`. If Workers egress cannot get a real `shortcode_media`, this phase as designed does not work, full stop.
- **The CDN fetch is informative, NOT decisive.** In production our Worker never fetches `video_url` or `display_url` — it hands the URL to Discord in a 302, and **Discord's media proxy** fetches it, from **Discord's** IPs. So the probe's media result measures a different network path than production's. A failure there does not by itself condemn the design; a success does not guarantee Discord's proxy succeeds. **Only Task 9, in a real client, settles playback.** The probe fetches anyway because it is cheap and because the TikTok result taught us that *the IP that fetches is what is checked* — so a Workers-side CDN failure is a genuine warning even when it is not a verdict.
- **The `oe=` expiry is a free bonus and should be collected.** Meta CDN URLs carry a hex Unix timestamp in `oe=`. Decoding it closes a spec open question outright: §Media requires Post TTL + `MEDIA_MAX_AGE` (900 + 300 = **20 minutes**) to stay under the shortest CDN signature lifetime, and flags *"verify TikTok's and Instagram's signature TTLs during Phases 3/4"*. One `parseInt(oe, 16)` answers it. If the window is under 20 minutes, **lower `POST_TTL` and say so** — do not ship a design whose own spec says it will serve dead images.

#### The decision tree — write the outcome into the research doc, then act

1. **Embed probe returns a real `shortcode_media`** (owner present, a caption or an explicit empty one, ≥1 `display_url`, and for the reel a `video_url`). **Proceed to Task 2 unchanged.** This is the expected outcome and the 2026-07-16 datapoint predicts it.
2. **Embed probe returns the ~599KB decoy on the crawler UA.** Try the probe's other UA variants first — it reports all of them in one call for exactly this reason, including `curl/8.4.0`, which fact 2 identifies as the decisive row. If a *different* crawler-ish UA works, take it and record which one; that is a one-constant change to Task 4, not a redesign. If **every** variant returns the decoy, **STOP and escalate to the human.** Do not start Task 3. The options from there — a different header set, a residential-egress hop, or abandoning Instagram video for a meta-tag-only embed — are a redesign, not a step, and choosing among them is not an agent's call.
3. **Embed probe works but carries `contextJSON` and NOT a `TimeSliceImpl` / `shortcode_media` blob.** Proceed, with the marker corrected: whichever container actually holds the GraphQL object from Workers egress is the one Task 3's extractor targets and Task 4's assertion names. **Record both, and record which one the fetcher now asserts on.** This is a live possibility rather than a hypothetical — fact 11 flags it as the specific gap in the prior evidence — and it changes one regex, not the design.
4. **Embed probe works; the CDN media 403s or returns HTML from Workers egress.** Proceed to Task 2, and **flag it prominently in the research doc as the top risk for the human gate.** Do not build a workaround yet: Discord's proxy is a different IP, and TikTok's own history shows a Workers-side CDN refusal that Discord's proxy is unaffected by (Discord plays TikTok video from the aweme URL today, which our Worker cannot resolve at all). If the gate then shows video not playing, that is when spec §Media's per-platform byte-proxying escape hatch gets put to the human — with a bandwidth bill and an unresolved ToS question attached, so it is explicitly a human's decision.
5. **Embed probe works; the post is a carousel and only ONE child comes back.** Not a network problem — an extraction problem, and it belongs to Task 3. Note it and proceed.

- [ ] **Step 1: Write the failing test**

`test/probe.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/worker.ts'

const ctx = { waitUntil() {} }
const cache = { async match() { return undefined }, async put() {} }
const deps = { cache, fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }) }
const env = (extra = {}) => ({ ASSETS: { async fetch() { return new Response('asset') } }, ...extra })
const req = p => new Request(`https://staging.megapenispoopenfarten.sex${p}`)

// SHORTCODE-SHAPED, and this is the single most important character in the gate tests. runProbe
// rejects anything failing /^[A-Za-z0-9_-]{5,32}$/ with a 400 BEFORE emitting a report, so the
// obvious-looking `?code=ABC` makes both guards below hold whether or not the token gate exists.
// Proved by mutation: with the mount replaced by a bare `url.pathname.startsWith('/_probe/')` the
// full suite stayed green at 389 pass while `/_probe/anything?code=<shaped>` returned a complete
// report from an env carrying no PROBE_TOKEN at all. Not a real post — nothing here should reach
// Instagram, and fetch is stubbed so a regression fails offline instead of hanging on five
// real requests.
const SHAPED = 'AAAAAAAAAAA'
async function withNoNetwork(fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('stub', { status: 200 })
  try { return await fn() } finally { globalThis.fetch = real }
}

test('the probe does not exist when PROBE_TOKEN is unset — production can never reach it', async () => {
  // Prod has no PROBE_TOKEN, so this is the property that makes a throwaway debug endpoint safe
  // to deploy at all. Asserted on the RESPONSE, not on a config file: the guard has to be in the
  // code path, because that is what a cutover would carry over if Task 8 slipped.
  const res = await withNoNetwork(() => handle(req(`/_probe/anything?code=${SHAPED}`), env(), ctx, deps))
  assert.ok(!(await res.text()).includes('"embed"'), 'no probe report may be emitted')
})

test('the probe is unreachable at /_probe/undefined when PROBE_TOKEN is unset', async () => {
  // THE OTHER WAY TO LOSE THE GATE, and the test above cannot see it. Delete just the
  // `env.PROBE_TOKEN &&` conjunct and the template literal stringifies undefined, so the live
  // mount becomes exactly `/_probe/undefined` — a path no other test requests. Without this case
  // that mutation stayed green at 389 pass while the endpoint was open and unauthenticated.
  const res = await withNoNetwork(() => handle(req(`/_probe/undefined?code=${SHAPED}`), env(), ctx, deps))
  assert.ok(!(await res.text()).includes('"embed"'), 'an unset token must not mint a live path')
})

test('the probe requires the exact token', async () => {
  const res = await withNoNetwork(() =>
    handle(req(`/_probe/wrong?code=${SHAPED}`), env({ PROBE_TOKEN: 'right' }), ctx, deps))
  assert.ok(!(await res.text()).includes('"embed"'))
})

test('the probe refuses a code that is not shortcode-shaped', async () => {
  // The code is interpolated into https://www.instagram.com/p/{code}/embed/captioned/. A strict
  // shape rule is what keeps a caller from steering our egress somewhere else; `new URL` would
  // happily accept path traversal or an @-host trick.
  for (const bad of ['', 'a/../../x', 'a b', 'a%2fb', '../../evil.com', 'x'.repeat(64)]) {
    const res = await handle(req(`/_probe/t?code=${bad}`), env({ PROBE_TOKEN: 't' }), ctx, deps)
    assert.equal(res.status, 400, `code=${bad} must be rejected before any fetch`)
  }
})

test('the decoy is detected by CONTENT, never by size, status or content-type', async () => {
  // The decoy is HTTP 200, text/html, and LARGER than the real thing (599,264 vs ~98,700). Every
  // instinct that reaches for a size or status check gets this backwards.
  const { hasShortcodeMedia } = await import('../src/probe.ts')
  assert.equal(hasShortcodeMedia('…"shortcode_media":{"id":"1"}…'), true)
  assert.equal(hasShortcodeMedia('<html><body>' + 'x'.repeat(599_264) + '</body></html>'), false)
  assert.equal(hasShortcodeMedia(''), false)
  assert.equal(hasShortcodeMedia(null), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/probe.test.mjs`

Expected: FAIL on **tests 3 and 4 specifically**:
- **test 3** fails because `/_probe/t?code=abc` falls through to the router as an unknown path and answers `notfound`, not 400.
- **test 4** fails because `../src/probe.ts` does not exist.

**Tests 1-3 already PASS, and that is correct** — with no probe mounted, `/_probe/anything` is just an unknown path and emits no report. They are **regression guards on the token gate**, and they become load-bearing the moment Step 3 mounts the endpoint. Red means "the guard is missing", not "the feature is missing". Do not "fix" them now.

> **VERIFY THAT CLAIM BY MUTATION BEFORE YOU BELIEVE IT.** An earlier draft of this plan asserted that "an implementation that forgot `env.PROBE_TOKEN &&` turns them red" and **that was false**, because the guards used `?code=ABC` and the shape check short-circuited them. After Step 3, run both mutations and confirm each goes red:
> - replace the mount with `if (url.pathname.startsWith('/_probe/'))` → tests 1, 2 and 3 must fail;
> - drop only the `env.PROBE_TOKEN &&` conjunct → test 2 must fail.
>
> A guard that cannot fail is worse than no guard, because it is *reported* as coverage. This one was about to gate a public origin.

- [ ] **Step 3: Write minimal implementation**

`src/probe.ts` — a throwaway. It is written to be *deleted*, so it deliberately shares nothing with the real fetcher: the point is to measure what the network does, not to smuggle in half of Task 4 untested.

```ts
/**
 * THROWAWAY. Task 1 of the Instagram plan; Task 8 deletes this file.
 *
 * Every Instagram fact the plan rests on came from a residential IP, and the one prior
 * Workers-egress datapoint (2026-07-16) asserted a DIFFERENT marker (contextJSON) on a payload
 * we are not the ones consuming. Instagram serves a 599KB decoy at HTTP 200 to the wrong
 * requester, and this project has already been bitten twice by Workers egress differing from a
 * home connection for a byte-identical URL.
 *
 * It writes nothing to analytics and calls no logger: counters only is the rule, and a shortcode
 * is an identifier. THAT IS NOT THE WHOLE STORY, and the earlier draft of this comment overclaimed
 * it. `wrangler.jsonc` sets `observability: { enabled: true }`, and Workers Logs record the
 * REQUEST URL of every invocation — so the token (a path segment) and the shortcode (a query
 * param) land in Cloudflare's log retention no matter what this code does. Acceptable only
 * because the token is throwaway, staging-only, and deleted in Task 8; if this pattern is ever
 * reused, put the token in a header.
 */

const UAS: Record<string, string | null> = {
  facebook: 'facebookexternalhit/1.1',
  discordbot: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  // The DECISIVE row of the recon: the least browser-like fingerprint available gets the real
  // content, which is what disproves the TLS/JA3 theory.
  curl: 'curl/8.4.0',
  none: null,
  // The DECOY, probed on purpose so the report proves the inversion from Workers egress too.
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
}

/** THE assertion. Not size, not status, not content-type — all three lie here. */
export function hasShortcodeMedia(body: unknown): boolean {
  return typeof body === 'string' && body.includes('shortcode_media')
}

/**
 * Fact 11 asks which marker Task 4 should assert on, and the honest answer measured here is
 * NEITHER of the candidates. A nonexistent-but-well-formed shortcode returns an 80KB "post
 * unavailable" page at HTTP 200 carrying BOTH `contextJSON` and `TimeSliceImpl` and no
 * `shortcode_media`. Reported so the research doc can record that, not so either becomes an
 * assertion — Step 5 now runs a deliberately dead code as a negative control for exactly this.
 */
function hasContextJson(body: string): boolean {
  return body.includes('contextJSON')
}

/**
 * Only Meta's own CDN. `harvest` searches the WHOLE document, which is what makes the CDN half of
 * the probe work at all — and the whole document includes `edge_media_to_caption`, i.e. text an
 * arbitrary stranger wrote. A caption carrying the escaped bytes of a `display_url` pair would
 * otherwise hand `probeCdn` an attacker-chosen URL and our Worker would fetch it. Suffix match on
 * a DOT boundary, so `notcdninstagram.com` does not slip through.
 */
const CDN_HOSTS = ['cdninstagram.com', 'fbcdn.net']
function allowedHost(u: string): boolean {
  try {
    const h = new URL(u).host.toLowerCase()
    return CDN_HOSTS.some(d => h === d || h.endsWith('.' + d))
  } catch { return false }
}

/**
 * Pull every value of `key` out of the embed document.
 *
 * THE ESCAPING IS THE WHOLE DIFFICULTY, and the first draft got it wrong in three independent
 * ways, each fatal alone. Transcribed one character at a time from a live capture, the wire is:
 *
 *   ,  \  "  d i s p l a y _ u r l  \  "  :  \  "  h t t p s  :  \ \ \  /  \ \ \  /
 *
 * 1. The separator is `\":\"`, NOT `":"`. The blob is escaped JSON inside a JS call argument, so
 *    the literal string `"display_url":"` never occurs — a regex written for unescaped JSON
 *    matched nothing anywhere in the 214KB body, not merely nothing in a window.
 * 2. It must search the FULL body. `video_url` sits 21,052 chars past the `shortcode_media`
 *    marker on a reel and 39,680 past it on a carousel, against a 400-char sample window.
 * 3. Real values are LONG: `video_url` measured 1,049-1,071 chars and `display_url` up to 604,
 *    so a 600-char cap truncated even the ones it found.
 */
export function harvest(body: string, key: string): string[] {
  // `\\?"` on each delimiter tolerates both the escaped wire form and a plain-JSON fixture. The
  // value is captured lazily up to the next (optionally escaped) quote: it contains backslashes
  // but never a bare quote, so `[^"]` is the correct character class and laziness is what stops
  // the capture from swallowing the trailing backslash of the closing `\"`.
  const re = new RegExp(String.raw`\\?"` + key + String.raw`\\?"\s*:\s*\\?"(https:[^"]{20,4000}?)\\?"`, 'g')
  const out: string[] = []
  for (const m of body.matchAll(re)) {
    // Collapse every escape level at once rather than guessing the depth: `\\\/` -> `/`.
    const url = m[1].replace(/\\+\//g, '/').replace(/\\+u0026/gi, '&').replace(/\\+/g, '')
    if (allowedHost(url) && !out.includes(url)) out.push(url)
  }
  return out
}

/**
 * PURE, so the counting rules are testable with no network — which matters because one of them
 * was answering a different question than its own label claimed.
 */
export function describeBody(body: string) {
  const counts = (needle: string, hay: string = body) => hay.split(needle).length - 1
  const sidecarAt = body.indexOf('edge_sidecar_to_children')
  // Fact 6's question is about the CHILDREN, so the count has to be scoped to them. A
  // whole-document count is always >= 1 on a carousel, because the top-level shortcode_media
  // object carries its own __typename — so the old field reported 1 on a live carousel whose
  // children provably had none, i.e. the exact opposite of the fact it was labelled with.
  const sidecar = sidecarAt < 0 ? '' : body.slice(sidecarAt)
  const markerAt = body.indexOf('shortcode_media')
  return {
    // Real UTF-8 bytes. `body.length` is UTF-16 code units and Step 6 compares this number to
    // curl's: on the live carousel that gap was 214,240 vs 214,245.
    bytes: new TextEncoder().encode(body).length,
    hasShortcodeMedia: hasShortcodeMedia(body),
    hasContextJson: hasContextJson(body),
    hasTimeSlice: body.includes('TimeSliceImpl'),
    videoUrlCount: counts('video_url'),
    displayUrlCount: counts('display_url'),
    isVideoCount: counts('is_video'),
    isVideoCountInSidecar: counts('is_video', sidecar),
    typenameCountTotal: counts('__typename'),
    typenameCountInSidecar: counts('__typename', sidecar), // fact 6 predicts 0
    sidecarPresent: sidecarAt >= 0,
    // The first 400 chars AFTER the marker, so a human can eyeball the real shape without
    // shipping 200KB through a curl. EYEBALLING ONLY — nothing is extracted from this window
    // any more, which is the bug that made the CDN half dead code.
    sample: markerAt < 0 ? null : body.slice(markerAt, markerAt + 400),
  }
}

async function probeEmbed(code: string, ua: string | null) {
  try {
    const res = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, {
      headers: ua ? { 'user-agent': ua } : {},
    })
    const body = await res.text()
    return {
      body,
      report: {
        httpStatus: res.status,        // reported, never asserted on
        contentType: res.headers.get('content-type'), // reported; it does NOT distinguish the decoy
        ...describeBody(body),
      },
    }
  } catch (e) {
    return { body: '', report: { error: String(e) } }
  }
}

/**
 * First `n` bytes, then cancel — never pull 7MB into a Worker to look at twelve of them.
 *
 * IT MUST LOOP. A single read() returns whatever the first chunk happens to hold, and a chunk
 * shorter than 8 bytes is legal for any stream — which made magic() return 'none' for a valid
 * MP4. That failure is silent and inverted: http=200 magic=none reads as decision-tree branch 4,
 * a CDN refusal, and gets escalated to the human as the phase's top risk. On a working CDN.
 */
export async function head(res: Response, n = 32): Promise<Uint8Array> {
  const r = res.body?.getReader()
  if (!r) return new Uint8Array(0)
  const out = new Uint8Array(n)
  let got = 0
  while (got < n) {
    const { value, done } = await r.read()
    if (done) break
    if (value) {
      const take = Math.min(value.length, n - got)
      out.set(value.subarray(0, take), got)
      got += take
    }
  }
  await r.cancel().catch(() => {})
  return out.subarray(0, got)
}

/** MAGIC BYTES ONLY. TikTok taught us a gated 403 can be served AS video/mp4. */
export function magic(b: Uint8Array): string {
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50) return 'png'
  return 'none'
}

async function probeCdn(url: string) {
  try {
    // NO headers at all — the shape of Discord's cookie-free media-proxy request.
    const res = await fetch(url)
    const b = await head(res)
    // `oe` is a hex Unix timestamp. Decoding it closes the spec's open question about whether
    // POST_TTL + MEDIA_MAX_AGE (20 min) fits inside Instagram's signature lifetime.
    const oe = new URL(url).searchParams.get('oe')
    const expiresAt = oe && /^[0-9a-fA-F]+$/.test(oe) ? parseInt(oe, 16) : null
    return {
      httpStatus: res.status,
      contentType: res.headers.get('content-type'), // reported; NOT evidence
      contentLength: res.headers.get('content-length'),
      redirected: res.redirected,
      finalHost: (() => { try { return new URL(res.url).host } catch { return null } })(),
      magic: magic(b),              // THE assertion
      headBytes: b.length,          // so a 'none' verdict can be told apart from a short read
      oeHex: oe,
      expiresAt,
      secondsRemaining: expiresAt ? expiresAt - Math.floor(Date.now() / 1000) : null,
    }
  } catch (e) {
    return { error: String(e) }
  }
}

/**
 * NEVER CACHE A MEASUREMENT.
 *
 * Step 5 loops three shortcodes over the identical path `/_probe/{token}`, varying only the query
 * string — and this plan's own EDGE-CACHE HAZARD section establishes that the zone's cache key is
 * the PATH ALONE and that "appending ?v=2 buys nothing". Response.json() sets no cache-control,
 * which is exactly the condition ("we set no Cache-Control and the zone applied a default") that
 * produced the four-hour edge HIT that cost a day on TikTok. Without this header codes 2 and 3
 * can be served code 1's report, and the research doc records one post's numbers three times.
 */
function noStore(res: Response): Response {
  res.headers.set('cache-control', 'no-store, max-age=0')
  return res
}

/** GET /_probe/{PROBE_TOKEN}?code={shortcode} */
export async function runProbe(url: URL): Promise<Response> {
  const code = url.searchParams.get('code') ?? ''
  // Instagram shortcodes are base64url-ish and short. This value is interpolated into an upstream
  // URL; anything else lets a caller steer our egress.
  if (!/^[A-Za-z0-9_-]{5,32}$/.test(code)) return noStore(new Response('bad code\n', { status: 400 }))

  const embed: Record<string, unknown> = {}
  const bodies: string[] = []
  for (const [name, ua] of Object.entries(UAS)) {
    const { body, report } = await probeEmbed(code, ua)
    embed[name] = report
    if (hasShortcodeMedia(body)) bodies.push(body)
  }

  // Harvest from whichever variant got the real payload, over the WHOLE document.
  const winner = bodies[0] ?? ''
  const videoUrl = harvest(winner, 'video_url')[0]
  const imageUrl = harvest(winner, 'display_url')[0]

  return noStore(Response.json({
    embed,
    // Counts, so a "skipped" can be told apart from "there genuinely were none" — the old report
    // said skipped on a carousel that carried four video URLs, which reads as "Workers egress
    // returns no video URLs" to anyone writing the research doc from it.
    harvested: { video: harvest(winner, 'video_url').length, image: harvest(winner, 'display_url').length },
    video: videoUrl ? await probeCdn(videoUrl) : { skipped: 'no allowlisted video_url in the document' },
    image: imageUrl ? await probeCdn(imageUrl) : { skipped: 'no allowlisted display_url in the document' },
  }))
}
```

`src/worker.ts` — mount it, behind a token that only staging has:

```ts
// TASK 1 THROWAWAY. Deleted in Task 8. Mounted before route() because /_probe/ is not a Route
// kind and must never become one. PROBE_TOKEN is a staging-only secret: with it unset — which is
// every environment except staging — this branch is unreachable and the path falls through to the
// router like any other unknown path.
if (env.PROBE_TOKEN && url.pathname === `/_probe/${env.PROBE_TOKEN}`) {
  return runProbe(url)
}
```

and in `analytics.ts`'s `Env`: `PROBE_TOKEN?: string`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/probe.test.mjs && npm test && npm run typecheck`
Expected: PASS — 4 new tests, the whole suite still green, typecheck clean.

- [ ] **Step 5: Deploy to staging and MEASURE**

**Generate a FRESH token at deploy time.** Do not reuse a value that has been sitting in a file — an earlier run of this task left the live token in world-readable plaintext at `/tmp/ig-probe-token` and `/tmp/ig-probe-secrets.json` (mode 0644). This token is the sole gate on a public origin the moment the deploy lands.

```bash
PROBE_TOKEN=$(openssl rand -hex 24)
printf '%s' "$PROBE_TOKEN" | npx wrangler secret put PROBE_TOKEN
npm run deploy
rm -f /tmp/ig-probe-token /tmp/ig-probe-secrets.json   # kill any stale copy on disk
# Sanity: prod is untouched. This must still be the fxtiktok worker's output.
curl -sI https://megapenispoopenfarten.sex/t/ZTSw2mYwR/ | head -3
```

Collect **four shortcodes**: a single image, a mixed carousel, a reel — fresh, never fetched by this project — **and one deliberately dead one** (a well-formed code that is not a real post, e.g. `ZZZZZZZZZZZ`). The two named in the recon (`DaQ5CPTki4E` mixed carousel, `Da5ynsiuAZ_` reel) are fine here because the probe path is not the embed path and carries no edge-cache history, but **do not reuse them for Task 8's staging verification.**

> **THE DEAD CODE IS A NEGATIVE CONTROL, AND WITHOUT IT STEP 6 CANNOT ANSWER ITS OWN QUESTION.** Measured 2026-07-19: a nonexistent shortcode returns an **80,321-byte "post unavailable" page at HTTP 200** carrying **both `contextJSON` and `TimeSliceImpl`** and **no `shortcode_media`**. Against three *live* posts all three markers read `true` in every row, so the table alone gives no basis to prefer one — and handing Task 4 either candidate would make it report a deleted or private post as a successful fetch, which is the decoy-class failure this whole task exists to prevent. Only `shortcode_media` discriminates.

**Check `cf-cache-status` on every request.** All four calls hit the identical path `/_probe/$PROBE_TOKEN` and differ only in query string — and this plan's own EDGE-CACHE HAZARD section establishes that the zone's cache key is the **path alone** and that "appending `?v=2` buys nothing". `runProbe` now sends `cache-control: no-store`, which fixes the origin's side; it does **not** bind a zone-level rule. If any response after the first shows a `HIT`, you are reading code 1's report under code 2's name — stop and use a distinct path per code.

```bash
S=https://staging.megapenispoopenfarten.sex
for C in $SINGLE_CODE $CAROUSEL_CODE $REEL_CODE ZZZZZZZZZZZ; do
  # -D- so the cache status is visible: a HIT here voids the reading.
  curl -sD /tmp/h-$C.txt "$S/_probe/$PROBE_TOKEN?code=$C" | tee /tmp/ig-probe-$C.json | python3 -m json.tool | head -60
  grep -iE 'cf-cache-status|age:' /tmp/h-$C.txt || echo "  (no cf-cache-status header — good)"
done
```

- [ ] **Step 6: Record the result and take the decision**

Write `docs/research/2026-07-19-instagram-workers-egress-probe.md` with:

- The raw JSON for all four codes, **including the dead one**.
- **Which UA variants produced `hasShortcodeMedia: true`**, and their byte counts beside the decoy's — the inversion, reproduced from Workers egress or refuted. Record the byte counts as **observations, not as agreement with fact 2's table**: payload size varies by post and drifts run to run (measured 2026-07-19 residentially: reel 133,246, carousel 214,245, decoy 597,847 — none of which match fact 2's 98,682/599,264). A size delta is not signal. `hasShortcodeMedia` is.
- **The dead code's row, explicitly.** It is the negative control and it is the row that answers the marker question: if `contextJSON` and `TimeSliceImpl` are `true` there too, then **neither is a liveness marker and Task 4 asserts on `shortcode_media`**. This is the specific gap fact 11 names; naming the answer is half this document's value.
- **`typenameCountInSidecar` on the carousel — NOT `typenameCountTotal`.** Fact 6 is a claim about the sidecar *children*, and the top-level `shortcode_media` object always carries its own `__typename`, so the total is ≥1 on every carousel and answers a different question. Report `isVideoCountInSidecar` beside it (measured residentially on `DaQ5CPTki4E`: total 1, in-sidecar 0, `is_video` in-sidecar 10 — fact 6 holds). If `__typename` *is* present **in the sidecar** from Workers egress, say so loudly — it does not change the decision (`is_video` is still correct and still more robust) but it means the upstream bug would not have reproduced here, and a future reader deserves to know the fact was tested rather than assumed.
- The video and image blocks' `magic`, `redirected`, `finalHost` and `httpStatus`, **with the note that content-type is not evidence**. Also report `harvested` (the count of allowlisted media URLs found) — a `{skipped}` beside a nonzero `videoUrlCount` means the extractor failed, not that the payload had no video, and those two readings must never be confused in the doc.
- **`secondsRemaining` from the `oe=` decode, and an explicit verdict on the 20-minute window.** If it is under 20 minutes, state the new `POST_TTL` this phase must ship and carry it into Task 5. (Residential reference, 2026-07-19: video `oe` ≈ **33.4 h**, image `oe` ≈ **105.6 h** — both far outside the 20-minute window, so the expected verdict is "no `POST_TTL` change". Confirm from Workers egress rather than inheriting this.)

State plainly which branch of the decision tree applies and what Task 2 therefore does. **If branch 2 applies, stop here and escalate** — the document is the deliverable and Tasks 2–9 do not start.

- [ ] **Step 7: Commit**

```bash
git add src/probe.ts src/worker.ts src/analytics.ts test/probe.test.mjs \
        docs/research/2026-07-19-instagram-workers-egress-probe.md
git commit -m "chore: probe Instagram from real Workers egress before building on residential facts

Every Instagram fact this phase rests on was measured from a residential IP. The
one prior Workers-egress datapoint (2026-07-16) is real and encouraging but does
not settle it: it asserted contextJSON, a different marker from the
TimeSliceImpl/shortcode_media path we now depend on, it fetched no CDN bytes, and
the same spec records Instagram serving PROFILE pages differently to Cloudflare
than it serves /embed/captioned/ — so its behaviour toward us is path-dependent.

Instagram answers the wrong requester with a 599KB decoy at HTTP 200, which is the
worst possible failure: valid status, valid content-type, and LARGER than the real
payload, so every instinct that reaches for a size or status check gets it
backwards. The probe asserts on shortcode_media and on magic bytes only.

A throwaway /_probe/{token} endpoint asks the questions from staging and reports in
the response body — counters only in analytics, and a shortcode is an identifier.
Unreachable without PROBE_TOKEN, which only staging has; Task 8 deletes the file.
It runs on the EXISTING staging worker; no new Worker was created.

The embed fetch is the blocking measurement. The CDN fetch is informative only: in
production our Worker never fetches the media, Discord's proxy does, from Discord's
IPs. It also decodes the oe= expiry, which closes the spec's open question about
whether POST_TTL + MEDIA_MAX_AGE fits inside Instagram's signature lifetime.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Routing — Instagram path shapes, one cache key, no new ambiguity

**Files:**
- Modify: `src/router.ts`
- Test: `test/router.test.mjs` (extend)

**Interfaces:**
- Consumes: `Route`, `PostRef`, `Platform`.
- Produces: `instagram(seg): Route | null`, wired into `matchPost`'s forced and unforced arms.

#### Decisions this task makes, and why

**1. Every post shape collapses to ONE ref, and the `kind` is normalized to `'p'`.**

Fact 10 laid out the split. The fix is one line and it needs **no type change**: the matcher always emits `{p:'ig', kind:'p', code}` regardless of which surface the URL named, exactly as TikTok's matcher emits the same `{p:'tt', id}` for `/video/` and `/photo/`.

```
/p/ABC     ->  ig:p:ABC
/reel/ABC  ->  ig:p:ABC     one cache entry, one /_media/ namespace
/tv/ABC    ->  ig:p:ABC
/reels/ABC ->  ig:p:ABC
```

`parseRefKey` still *accepts* `ig:reel:` and `ig:tv:` keys — that allowlist is untouched, so any URL ever minted still resolves. Those keys simply stop being **minted**. Backward compatible in the only direction that can hurt.

**The surface is not lost, it moves to where the evidence is.** `route()`'s `canonical` keeps the caller's original spelling, because that is the URL `worker.ts` 302s a human to and a human should land on exactly what they pasted. The *normalizer* rebuilds its own canonical from the **payload** (it only has the ref), choosing `/reel/{code}/` when the payload says the post is a reel and `/p/{code}/` otherwise — the same division of labour TikTok uses, where `route()` keeps the pasted `@handle` and `normalizeTikTok` rebuilds `/@{uniqueId}/{video|photo}/{id}`.

**2. `known` shrinks; `ambiguity()` is UNCHANGED.**

`known` is the dead-end set, consulted **after** `matchPost`. It currently holds:

```ts
const known = new Set(['comments', 'p', 'reel', 'reels', 'tv', 'stories', 'r'])
```

`p`, `reel`, `reels` and `tv` come out — the matcher claims them now, so leaving them would be dead-ending a token whose shape we serve, which is the defect class fixed for `/x/status/123` and again for `@api`. **`stories` stays** (out of scope — see below), as do `comments` and `r`, which are Reddit's.

Removing them is **behaviour-neutral for every path the matcher does not claim**, and that is worth verifying rather than asserting: at depth 2 the matcher takes `/p/{code}`; at depth ≥3 `ambiguity()` has no row for these tokens, so `/p/a/b` still lands on `notfound` exactly as it does today. The acceptance test re-asserts the whole ambiguity table so an accidental second change cannot ride along.

**Nothing in `ambiguity()` changes, and the reason is already in the spec.** The depth rule says depth-2 is safe only while segment 1 is not a live Instagram username — but here segment 1 **is Instagram's own route**, so segment-1 shadowing is moot by construction (spec §Routing, the `/p/`, `/reel/`, `/reels/`, `/tv/` row). And the contested rows stay contested: **`/gallery/{id}` remains `['rd','ig']`** and this task does not claim it, because `@gallery` is a live Instagram account and a depth-2 Reddit permalink defeated by a live IG username is exactly the case the table exists for.

**3. `/{user}/p/{code}` requires a NON-`@` user segment.**

Instagram does not put `@` in a URL path. TikTok and Threads do, and `/@{user}/…` at depth 3 is their territory — TikTok's matcher already requires `seg[1] ∈ {video, photo}` there. Requiring `!seg[0].startsWith('@')` on the Instagram depth-3 arm is a **shape match**, not a guess, and it keeps the two families from reaching into each other. `matchPost` order puts `instagram()` last, after `x()` claims `seg[1] === 'status'`, so there is no collision at that depth either.

**4. Stories are OUT of scope for this plan, and this is where that is enforced.**

`PostRef` declares `{p:'ig'; kind:'story'; user; id}` and `refKey`/`parseRefKey` already round-trip it, so it *looks* nearly free. It is not, for three independent reasons:

- **There is no story equivalent of `/embed/captioned/`.** The entire mechanism this plan is built on — one unauthenticated endpoint carrying the whole GraphQL object — does not exist for stories. It would be a different fetcher against a different surface, which means a different recon.
- **Stories expire in 24 hours.** A 15-minute Post cache in front of a 24-hour object is fine; an embed pasted into Discord that renders correctly and then permanently 404s is a support burden nobody asked for.
- **They are the one shape that is plausibly private.** `/stories/{user}/{id}` is viewable-by-followers on many accounts, and a public embed service that resolves them is a different product with a different ethics conversation. That conversation is a human's, not this plan's.

So `'stories'` stays in `known` and `/stories/{u}/{id}` stays an honest `notfound`. **The `ig:story:` refKey support already in the tree is left exactly as it is** — it costs nothing, it is already tested, and deleting it would be churn.

- [ ] **Step 1: Write the failing test**

Append to `test/router.test.mjs`:
```js
test('every Instagram post shape routes, at depth 2', () => {
  for (const [path, code] of [
    ['/p/DaQ5CPTki4E', 'DaQ5CPTki4E'],
    ['/reel/Da5ynsiuAZ_', 'Da5ynsiuAZ_'],
    ['/reels/Da5ynsiuAZ_', 'Da5ynsiuAZ_'],
    ['/tv/BsOGulcndj-', 'BsOGulcndj-'],
  ]) {
    const got = r(path)
    assert.equal(got.kind, 'post', path)
    assert.deepEqual(got.ref, { p: 'ig', kind: 'p', code }, path)
  }
})

test('the /{user}/p/{code} form routes, and keeps the pasted canonical', () => {
  const got = r('/mrbeast/p/DaQ5CPTki4E')
  assert.equal(got.kind, 'post')
  assert.deepEqual(got.ref, { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' })
  // canonical is what worker.ts 302s a HUMAN to, so it is the URL they pasted, not a rebuilt
  // one. The normalizer rebuilds its own from the payload — it has evidence; route() does not.
  assert.match(got.canonical, /instagram\.com\/mrbeast\/p\/DaQ5CPTki4E/)
})

test('EVERY SPELLING OF ONE POST COLLAPSES TO THE SAME CACHE KEY', () => {
  // THE POINT OF THIS TASK. /p/ and /reel/ embed endpoints are byte-identically interchangeable
  // (verified 2026-07-19), so these are provably one post. Left un-collapsed, pasting a reel two
  // ways costs TWO upstream fetches on the platform we rate most fragile, and splits its
  // /_media/ namespace so the two embeds carry different URLs naming the same bytes.
  const keys = ['/p/ABC123', '/reel/ABC123', '/reels/ABC123', '/tv/ABC123',
                '/ig/p/ABC123', '/someuser/p/ABC123'].map(p => refKey(r(p).ref))
  assert.deepEqual([...new Set(keys)], ['ig:p:ABC123'], `expected one key, got ${keys.join(', ')}`)
})

test('an ig:reel: key minted BEFORE this change still resolves — parseRefKey is untouched', () => {
  // The allowlist stays. Those keys stop being MINTED; they must not stop being READABLE, or
  // every /_media/ URL in a Discord message older than this deploy 404s.
  assert.deepEqual(parseRefKey('ig:reel:ABC'), { p: 'ig', kind: 'reel', code: 'ABC' })
  assert.deepEqual(parseRefKey('ig:tv:ABC'), { p: 'ig', kind: 'tv', code: 'ABC' })
})

test('the /ig/ escape hatch forces Instagram, and FALLS THROUGH when it does not match', () => {
  assert.deepEqual(r('/ig/p/ABC').ref, { p: 'ig', kind: 'p', code: 'ABC' })
  // @ig is a plausible handle and /ig/status/123 is a real Twitter permalink shape. Forcing
  // Instagram finds nothing there, and the router must fall through rather than dead-end — the
  // defect class fixed in 37386db (/x/status/123) and again for @api.
  assert.deepEqual(r('/ig/status/123'), {
    kind: 'post', ref: { p: 'x', id: '123' }, canonical: 'https://x.com/ig/status/123',
  })
})

test('an @-prefixed depth-3 path is NOT claimed as Instagram', () => {
  // Instagram never puts '@' in a URL path; TikTok and Threads do. /@u/p/{code} is nobody's
  // shape and must stay notfound rather than being guessed into ig.
  assert.notEqual(r('/@someone/p/ABC').kind, 'post')
})

test('STORIES ARE OUT OF SCOPE and stay an honest notfound', () => {
  // No story equivalent of /embed/captioned/ exists, stories expire in 24h, and they are the one
  // IG shape that is plausibly private. See the plan's Task 2 for all three reasons.
  assert.equal(r('/stories/someone/123').kind, 'notfound')
  // But the refKey support already in the tree is untouched — it costs nothing and is tested.
  assert.equal(refKey({ p: 'ig', kind: 'story', user: 'u', id: '1' }), 'ig:story:u:1')
})

test('ACCEPTANCE: the ambiguity table is COMPLETELY UNCHANGED by this task', () => {
  // Instagram is the platform the depth rule is written ABOUT, so the instinct to touch this
  // table is strongest here and is wrong: /p/ and /reel/ are Instagram's OWN routes, which makes
  // segment-1 shadowing moot by construction (spec §Routing). Re-asserted in full so an
  // accidental change cannot ride along — /gallery/{id} especially, which stays contested
  // because @gallery is a live Instagram account.
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
    ['/@mysticaquarium', ['tt', 'th']],
  ]
  for (const [path, candidates] of unchanged) {
    const got = r(path)
    assert.equal(got.kind, 'ambiguous', `${path} must still be ambiguous, got ${got.kind}`)
    assert.deepEqual(got.candidates.slice().sort(), candidates.slice().sort(), path)
  }
  assert.equal(r('/api/v1').kind, 'notfound')
  assert.equal(r('/users/someone').kind, 'notfound')
  // And the tokens leaving `known` do not start resolving to something new at other depths.
  assert.equal(r('/p/a/b').kind, 'notfound')
  assert.equal(r('/reel').kind, 'ambiguous', 'a bare /reel is still the generic profile chooser')
})

test('Reddit and TikTok shapes are untouched by the Instagram matcher', () => {
  assert.equal(r('/comments/abc').kind, 'notfound')      // Reddit's, still unbuilt
  assert.deepEqual(r('/@u/video/123').ref, { p: 'tt', id: '123' })
  assert.deepEqual(r('/@u/photo/123').ref, { p: 'tt', id: '123' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/router.test.mjs`
Expected: FAIL — every Instagram shape returns `notfound` (they are dead-ended by `known`). The `@`-prefixed, stories, Reddit/TikTok and ambiguity-table tests already pass; they are regression guards on behaviour this task must not break. **Read which ones are red.** If the ambiguity-table test is red at this point, something else in the tree drifted and this task is not the cause.

- [ ] **Step 3: Write minimal implementation**

In `src/router.ts`:

```ts
/**
 * Instagram post permalinks.
 *
 * ONE REF FOR EVERY SURFACE. /p/, /reel/, /reels/ and /tv/ are four spellings of one post —
 * verified 2026-07-19: /p/{code}/embed/captioned/ and /reel/{code}/embed/captioned/ return
 * byte-identical payloads. So they all mint `kind: 'p'`, and refKey collapses them onto one
 * cache entry and one /_media/ namespace. Un-collapsed, pasting a reel two ways costs two
 * upstream fetches on the platform we rate most fragile.
 *
 * NO TYPE CHANGE. PostRef's ig arm already declares kind 'p'|'reel'|'tv', and parseRefKey still
 * ACCEPTS ig:reel: and ig:tv: keys — they simply stop being minted, so every /_media/ URL that
 * already exists in a Discord message keeps resolving.
 *
 * THE SURFACE IS NOT LOST, IT MOVES. `canonical` here keeps the caller's spelling, because that
 * is where worker.ts 302s a human and they should land on what they pasted. normalizeInstagram
 * rebuilds its own canonical from the PAYLOAD (it has only the ref), picking /reel/ or /p/ from
 * evidence — the same split TikTok uses.
 *
 * DEPTH 2 IS SAFE HERE SPECIFICALLY. The spec's depth rule warns that depth 2 is safe only while
 * segment 1 is not a live Instagram username — but these ARE Instagram's own routes, so
 * segment-1 shadowing is moot by construction (spec §Routing). This is why the ambiguity table
 * needs no new row, and it is the one place that argument holds.
 *
 * THE DEPTH-3 ARM REFUSES AN '@' USER. Instagram never puts '@' in a path; TikTok and Threads do,
 * and /@{user}/… at depth 3 is theirs. Refusing it is a shape match, not a guess, and it keeps
 * the two families from reaching into each other.
 *
 * STORIES ARE DELIBERATELY ABSENT. There is no story equivalent of /embed/captioned/, stories
 * expire in 24h, and they are the one IG shape that is plausibly private — all three are reasons
 * of a different kind, and any one of them is enough. 'stories' stays in `known`.
 */
const IG_SURFACE = new Set(['p', 'reel', 'reels', 'tv'])

function instagram(seg: string[]): Route | null {
  // /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}
  if (seg.length === 2 && IG_SURFACE.has(seg[0]) && seg[1]) {
    return {
      kind: 'post',
      ref: { p: 'ig', kind: 'p', code: seg[1] },
      canonical: canonical(`https://www.instagram.com/${seg[0]}/${seg[1]}/`),
    }
  }
  // /{user}/p/{code} and friends.
  if (seg.length === 3 && seg[0] && !seg[0].startsWith('@') && IG_SURFACE.has(seg[1]) && seg[2]) {
    return {
      kind: 'post',
      ref: { p: 'ig', kind: 'p', code: seg[2] },
      canonical: canonical(`https://www.instagram.com/${seg[0]}/${seg[1]}/${seg[2]}/`),
    }
  }
  return null
}
```

`matchPost` gains the arm — forced **and** unforced, per the rule its own comment states:
```ts
function matchPost(seg: string[], forced?: Platform): Route | null {
  if (forced === 'bs') return bluesky(seg)
  if (forced === 'x') return x(seg)
  if (forced === 'tt') return tiktok(seg)
  if (forced === 'ig') return instagram(seg)
  if (forced) return null
  return bluesky(seg) ?? x(seg) ?? tiktok(seg) ?? instagram(seg)
}
```

`instagram()` goes **last** in the unforced chain: `x()` claims `seg[1] === 'status'` at depth ≥3 and must keep doing so, and Instagram's tokens are specific enough that order is not otherwise load-bearing.

And `known` shrinks, with the reason recorded in place:
```ts
  // 'p', 'reel', 'reels' and 'tv' left this set when instagram() claimed them: `known` is
  // consulted AFTER matchPost, so it was only ever dead-ending the shapes we now serve — the
  // same edit the shortlink branch made for 't'. 'stories' STAYS: stories are out of scope
  // (no /embed/captioned/ equivalent, 24h expiry, plausibly private), so notfound is honest.
  const known = new Set(['comments', 'stories', 'r'])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/router.test.mjs && npm test && npm run typecheck`
Expected: PASS — 9 new tests, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router.test.mjs
git commit -m "feat: route Instagram post permalinks, with every surface on one cache key

/p/, /reel/, /reels/ and /tv/ are four spellings of one post — verified
2026-07-19, /p/{code}/embed/captioned/ and /reel/{code}/embed/captioned/ return
byte-identical payloads — so all four mint kind:'p' and refKey collapses them onto
one cache entry and one /_media/ namespace. Un-collapsed they were three keys for
one post: two upstream fetches on the platform we rate most fragile, and a split
media namespace where two embeds carry different URLs naming the same bytes.

NO TYPE CHANGE. PostRef's ig arm already declared this shape, and parseRefKey still
ACCEPTS ig:reel: and ig:tv: keys — they stop being minted, not read, so every
/_media/ URL already sitting in a Discord message keeps resolving.

route()'s canonical keeps the caller's spelling, because that is where a human gets
302'd. The normalizer rebuilds its own from the payload, which is the only place
with evidence about which surface the post really is.

'p', 'reel', 'reels' and 'tv' leave the `known` dead-end set — it is consulted
after matchPost, so it was only ever dead-ending shapes we now serve, the same edit
't' got for short links. 'stories' STAYS: no /embed/captioned/ equivalent exists,
stories expire in 24h, and they are the one IG shape that is plausibly private.

The ambiguity table is COMPLETELY unchanged, re-asserted in full by an acceptance
test. Instagram is the platform the depth rule is written about, so the instinct to
touch it is strongest here and is wrong: /p/ and /reel/ are Instagram's OWN routes,
which makes segment-1 shadowing moot. /gallery/{id} stays contested ['rd','ig'].

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Fixtures + normalizer (pure, no network)

**Files:**
- Create: `test/fixtures/instagram-{single,carousel,reel,decoy,gone}.html`
- Create: `src/platforms/instagram/normalize.ts`
- Test: `test/instagram-normalize.test.mjs`

**Interfaces:**
- Consumes: `Post`, `PostRef`, `Media`; an embed-page HTML string.
- Produces: `normalizeInstagram(html: unknown, ref: PostRef): Post | null` — pure, total, returns `null` rather than inventing a Post. Plus `shortcodeMedia(html): object | null`, exported for the fetcher's assertion.

**Why the normalizer takes HTML rather than a parsed blob:** finding the blob, unescaping it and walking to `shortcode_media` is pure, and it is exactly where a platform change will break us first. Keeping it inside the pure module makes it testable against real captured bytes with no network. `fetch.ts` (Task 4) does nothing but I/O and a content assertion. This is the shape both existing platforms use; mirror `src/platforms/tiktok/normalize.ts` for tone and defensiveness.

- [ ] **Step 1: Capture five fixtures, then LOOK at what you actually got**

```bash
mkdir -p test/fixtures
UA='facebookexternalhit/1.1'
cap() {  # cap <shortcode> <outfile>
  curl -s -A "$UA" "https://www.instagram.com/p/$1/embed/captioned/" > "$2"
  wc -c "$2"
  grep -c shortcode_media "$2" || echo 'NO PAYLOAD — check the UA'
}
cap "$SINGLE_CODE"   test/fixtures/instagram-single.html
cap "$CAROUSEL_CODE" test/fixtures/instagram-carousel.html    # MUST be a MIXED image+video one
cap "$REEL_CODE"     test/fixtures/instagram-reel.html

# THE DECOY. A Chrome UA, deliberately. The spec's testing table names this fixture explicitly:
# "the 599,264-byte decoy fixture must FAIL — guards the one silent failure mode."
curl -s -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' \
  "https://www.instagram.com/p/$SINGLE_CODE/embed/captioned/" > test/fixtures/instagram-decoy.html
wc -c test/fixtures/instagram-decoy.html   # expect ~599KB, and HTTP 200 on the way in

# A DELETED / UNAVAILABLE post. Mutate one character of a real shortcode; the space is sparse.
# VERIFY it is really gone before keeping it — a mutant that hits a live post gives you a fixture
# that silently tests nothing. (Same procedure, same trap, as the TikTok deleted fixture.)
cap "$GONE_CODE" test/fixtures/instagram-gone.html
grep -c shortcode_media test/fixtures/instagram-gone.html   # expect 0 — if not, mutate again
```

**The fixtures are captured whole and NOT re-wrapped**, which is a deliberate divergence from the TikTok plan and the reason is worth stating: TikTok's blob is 91% of the page and sits in one `<script id=…>` element, so re-wrapping left exactly one thing for the extractor to find. Instagram's payload is embedded in a `TimeSliceImpl` **call argument**, escaped, alongside other scripts — the surrounding context *is* part of what the extractor has to survive. Trimming it would test an idealisation. **They are large (~100KB each, ~600KB for the decoy) and that is accepted**; the decoy in particular has no value at any smaller size.

Now **inspect** before writing a single line:

```bash
python3 - <<'PY'
import json, re, sys
for f in ('single', 'carousel', 'reel'):
    raw = open(f'test/fixtures/instagram-{f}.html', encoding='utf-8').read()
    print('==', f, len(raw), 'bytes')
    i = raw.find('shortcode_media')
    print('   marker at', i)
    print('   TimeSliceImpl?', 'TimeSliceImpl' in raw, ' contextJSON?', 'contextJSON' in raw)
    print('   raw window:', raw[i-80:i+300] if i > 0 else 'ABSENT')
    print('   counts: video_url', raw.count('video_url'),
          ' display_url', raw.count('display_url'),
          ' is_video', raw.count('is_video'),
          ' __typename', raw.count('__typename'),
          ' sidecar', raw.count('edge_sidecar_to_children'))
PY
```

**Write the extractor and the branches against what this prints, not from memory and not from upstream.** Facts 3, 5 and 6 tell you which *fields* carry meaning; they do not tell you the exact escaping, nesting or key order, and those are what the extractor has to handle. Upstream's field names are a different snapshot of the same adversarial platform.

Three things to settle from the output before writing code, and to record as comments in the file:

1. **The escaping.** The JSON is embedded in JavaScript, so it is backslash-escaped at least once (`\"`, `\/`, `&`). Determine whether the object is a JSON *string* inside an outer JSON (parse twice) or inline-escaped (unescape, then parse once). Do not guess — the fixture answers it.
2. **`__typename` on children.** Fact 6 predicts it is absent. Confirm against your own carousel. If it is present, still use `is_video`: it is the field that is present on *both* the top level and the children, so one discriminator covers both.
3. **The caption path.** `edge_media_to_caption.edges[0].node.text` is the conventional shape. Confirm it, and confirm what a **caption-less** post looks like — an empty `edges: []` must produce `text: ''`, not a `null` Post.

- [ ] **Step 2: Write the failing test**

`test/instagram-normalize.test.mjs`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeInstagram, shortcodeMedia } from '../src/platforms/instagram/normalize.ts'

const html = f => readFileSync(`test/fixtures/instagram-${f}.html`, 'utf8')
const SINGLE = html('single')
const CAROUSEL = html('carousel')
const REEL = html('reel')
const DECOY = html('decoy')
const GONE = html('gone')

// Fill these in from the Step 1 inspection output.
const SINGLE_REF = { p: 'ig', kind: 'p', code: 'REPLACE_SINGLE' }
const CAROUSEL_REF = { p: 'ig', kind: 'p', code: 'REPLACE_CAROUSEL' }
const REEL_REF = { p: 'ig', kind: 'p', code: 'REPLACE_REEL' }

test('a single-image post normalizes into a well-formed Post', () => {
  const post = normalizeInstagram(SINGLE, SINGLE_REF)
  assert.ok(post, 'must normalize')
  assert.deepEqual(post.ref, SINGLE_REF)
  assert.ok(post.author.handle.length > 0)
  assert.ok(post.createdAt instanceof Date)
  assert.ok(!Number.isNaN(post.createdAt.getTime()))
  assert.ok(post.createdAt.getUTCFullYear() > 2010, `taken_at_timestamp is SECONDS; got ${post.createdAt.toISOString()}`)
  assert.equal(typeof post.text, 'string')
  assert.equal(post.sensitive, false, 'Instagram exposes no sensitivity signal — spec says always false')
  assert.equal(post.media.length, 1)
  assert.equal(post.media[0].kind, 'image')
  assert.match(post.media[0].url, /^https:\/\//)
  assert.ok(post.media[0].w > 0 && post.media[0].h > 0, 'dimensions come from dimensions.{width,height}')
})

test('THE MIXED CAROUSEL YIELDS EVERY CHILD, AND THE VIDEOS ARE LABELLED VIDEO', () => {
  // THE HEADLINE TEST OF THIS PHASE. Verified live: DaQ5CPTki4E has 10 children, 4 of them video,
  // and the embed carries all 10. Upstream reads __typename, which sidecar children DO NOT HAVE,
  // so it mislabels every carousel video as an image — and that failure is INVISIBLE, because a
  // mislabelled video still has a display_url and still renders a still.
  const post = normalizeInstagram(CAROUSEL, CAROUSEL_REF)
  assert.ok(post, 'must normalize')
  assert.ok(post.media.length >= 2, `expected a carousel, got ${post.media.length}`)
  const videos = post.media.filter(m => m.kind === 'video')
  const images = post.media.filter(m => m.kind === 'image')
  assert.ok(videos.length > 0, 'at least one child MUST be a video — is_video is the discriminator, not __typename')
  assert.ok(images.length > 0, 'and at least one MUST be an image, or this is not a MIXED carousel')
  assert.equal(videos.length + images.length, post.media.length, 'no child may be dropped or gain a third kind')
  for (const m of post.media) assert.match(m.url, /^https:\/\//)
})

test('EVERY VIDEO ENTRY CARRIES A POSTER — the rich card depends on it', () => {
  // MEASURED 2026-07-19: preview_url pointing at the video made Discord request a poster, receive
  // mp4 bytes, and abandon the rich activity card for the plain OpenGraph one. Media.poster and
  // the /_media/{key}/poster{N} route already exist and are already tested; Instagram's whole job
  // is to POPULATE poster from display_url. Do not invent a second mechanism.
  for (const [name, h, ref] of [['reel', REEL, REEL_REF], ['carousel', CAROUSEL, CAROUSEL_REF]]) {
    const post = normalizeInstagram(h, ref)
    for (const m of post.media.filter(x => x.kind === 'video')) {
      assert.ok(typeof m.poster === 'string' && m.poster.startsWith('https://'),
        `${name}: a video entry with no poster costs the rich card`)
      assert.notEqual(m.poster, m.url, `${name}: the poster must be the IMAGE, never the video`)
    }
  }
})

test('a reel yields ONE video entry, on a direct CDN url with no hop to collapse', () => {
  // Verified live cookie-free: video_url downloaded 6,887,308 bytes, h264/aac 720x1280, 75.58s,
  // at ZERO redirect hops. That is strictly better than TikTok, whose playable url is itself a
  // 302 that Workers egress provably cannot resolve (docs/research/2026-07-19-aweme-…).
  const post = normalizeInstagram(REEL, REEL_REF)
  assert.ok(post)
  const v = post.media.find(m => m.kind === 'video')
  assert.ok(v, 'a reel must yield a video Media entry')
  assert.match(v.url, /^https:\/\//)
  assert.ok(v.w > 0 && v.h > 0)
})

test('canonical is rebuilt from the PAYLOAD, and a reel gets the /reel/ form', () => {
  // The ref carries only kind:'p' (every surface collapses onto one cache key — Task 2), so the
  // payload is the ONLY evidence about which surface this post really is.
  assert.match(normalizeInstagram(SINGLE, SINGLE_REF).canonical, /instagram\.com\/p\/REPLACE_SINGLE/)
  assert.match(normalizeInstagram(REEL, REEL_REF).canonical, /instagram\.com\/reel\/REPLACE_REEL/)
})

test('IS_VIDEO IS THE DISCRIMINATOR, PROVEN ON A CHILD WITH NO __typename AT ALL', () => {
  // Synthetic and deliberate. Sidecar children in the EMBED payload carry no __typename — their
  // keys are accessibility_caption, dimensions, display_resources, display_url, id, is_video,
  // owner, shortcode. A hand-written fixture naturally includes __typename because that is what
  // the GraphQL docs show, so the synthetic test passes against a __typename normalizer while
  // only the real fixture fails. This one is written the way the WIRE spells it.
  const media = {
    shortcode: 'X', taken_at_timestamp: 1750000000,
    owner: { username: 'u', full_name: 'U' },
    dimensions: { width: 1080, height: 1080 },
    display_url: 'https://cdn/cover.jpg',
    edge_media_to_caption: { edges: [{ node: { text: 'hi' } }] },
    edge_sidecar_to_children: { edges: [
      { node: { id: '1', is_video: false, display_url: 'https://cdn/1.jpg',
                dimensions: { width: 1080, height: 1080 } } },
      { node: { id: '2', is_video: true, video_url: 'https://cdn/2.mp4',
                display_url: 'https://cdn/2.jpg',
                dimensions: { width: 720, height: 1280 } } },
    ] },
  }
  const post = normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(post.media.length, 2)
  assert.equal(post.media[0].kind, 'image')
  assert.equal(post.media[1].kind, 'video', 'is_video:true with NO __typename must still be a video')
  assert.equal(post.media[1].url, 'https://cdn/2.mp4')
  assert.equal(post.media[1].poster, 'https://cdn/2.jpg')
})

test('a video child with NO video_url degrades to its still, never to a dead player', () => {
  // Phase 1's I-1 lesson, restated for a third platform: an og:video pointing at something that
  // cannot play renders a DEAD player AND suppresses og:image, so the post shows nothing at all.
  const media = {
    shortcode: 'X', taken_at_timestamp: 1750000000, owner: { username: 'u' },
    dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg',
    edge_sidecar_to_children: { edges: [
      { node: { id: '1', is_video: true, display_url: 'https://cdn/1.jpg',
                dimensions: { width: 720, height: 1280 } } },
    ] },
  }
  const post = normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' })
  assert.equal(post.media.length, 1, 'the still must still produce an entry')
  assert.equal(post.media[0].kind, 'image')
  assert.equal(post.media[0].url, 'https://cdn/1.jpg')
})

test('THE 599KB DECOY MUST FAIL — the one silent failure mode', () => {
  // Named by the spec's own testing table. HTTP 200, valid content-type, and SIX TIMES LARGER
  // than the real payload, so every instinct that reaches for a size or status check is
  // backwards. Only the absence of the object distinguishes it.
  assert.equal(shortcodeMedia(DECOY), null)
  assert.equal(normalizeInstagram(DECOY, SINGLE_REF), null)
  assert.ok(DECOY.length > 300_000, 'fixture sanity: this really is the big shell')
})

test('an unavailable post is null, not a blank embed', () => {
  assert.equal(normalizeInstagram(GONE, SINGLE_REF), null)
})

test('a caption-less post is text:"" and still a Post', () => {
  const media = {
    shortcode: 'X', taken_at_timestamp: 1750000000, owner: { username: 'u' },
    dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg',
    edge_media_to_caption: { edges: [] },
  }
  const post = normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' })
  assert.ok(post, 'no caption is not a reason to reject a post')
  assert.equal(post.text, '')
})

test('a non-https media url is SKIPPED, never emitted', () => {
  // These strings become og:image and og:video. A protocol-relative or http URL there is a
  // mixed-content hole we would be authoring ourselves.
  const media = {
    shortcode: 'X', taken_at_timestamp: 1750000000, owner: { username: 'u' },
    dimensions: { width: 1, height: 1 }, display_url: 'http://cdn/insecure.jpg',
  }
  const post = normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' })
  assert.ok(!post || post.media.every(m => m.url.startsWith('https://')))
})

test('an unparseable timestamp is NULL, not a 1970 post', () => {
  const media = {
    shortcode: 'X', taken_at_timestamp: 'not-a-time', owner: { username: 'u' },
    dimensions: { width: 1, height: 1 }, display_url: 'https://cdn/c.jpg',
  }
  assert.equal(normalizeInstagram(wrap(media), { p: 'ig', kind: 'p', code: 'X' }), null)
})

test('returns null on junk rather than throwing or inventing a Post', () => {
  for (const junk of [null, undefined, 42, '', '<html></html>', '{}', '<script>not json</script>']) {
    assert.doesNotThrow(() => normalizeInstagram(junk, SINGLE_REF), String(junk).slice(0, 40))
    assert.equal(normalizeInstagram(junk, SINGLE_REF), null, String(junk).slice(0, 40))
  }
})

test('normalizeInstagram refuses a ref that is not an ig ref', () => {
  assert.equal(normalizeInstagram(SINGLE, { p: 'tt', id: '1' }), null)
  assert.equal(normalizeInstagram(SINGLE, { p: 'bs', handle: 'a', rkey: 'b' }), null)
})
```

with a `wrap()` helper at the top of the file that embeds a `shortcode_media` object in the **same escaping the real fixture uses** — write it after Step 1 tells you what that is, and put a comment on it saying so. A `wrap()` that produces easier bytes than the wire is a test that passes for the wrong reason.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/instagram-normalize.test.mjs`
Expected: FAIL — cannot find `../src/platforms/instagram/normalize.ts`.

- [ ] **Step 4: Write minimal implementation**

`src/platforms/instagram/normalize.ts`. The load-bearing decisions, each of which has a test above:

- **Extraction:** locate the `shortcode_media` object, unescape per Step 1's finding, `JSON.parse` inside a `try`. **The regex MUST be bounded.** `src/platforms/tiktok/normalize.ts` carries a measured scar on exactly this: an unbounded `[^>]*` attribute scan is quadratic, and 1 MB of input took **23 seconds** of Worker CPU against Cloudflare's 30s ceiling. **The Instagram decoy is 599KB**, so this is not a hypothetical here — the pathological input is the one the platform serves us on the wrong UA. Bound every quantifier and put the measurement in the comment.
- **`shortcodeMedia(html)` is exported** and is the ONE spelling of the extraction, because `fetch.ts`'s content assertion needs the same question answered. Two spellings is two things to keep in step when Instagram renames something — the rule `videoDetailScope` already states for TikTok.
- **`is_video`, never `__typename`.** Both at the top level and per child. Carry fact 6 as a comment with the upstream citation.
- **`taken_at_timestamp` is Unix SECONDS.** Coerce, scale by 1000, then **validate the Date object**, not the number: the ECMAScript Date range is ±8.64e15 ms, so a large finite timestamp still yields an Invalid Date, and `render/mastodon.ts` calls `post.createdAt.toISOString()` bare on a route with no `try/catch` — an escaped Invalid Date is an uncaught `RangeError` 500. TikTok's normalizer documents this exact trap; mirror it.
- **Media:**
  - No sidecar → one entry from the top level: `is_video ? {kind:'video', url: video_url, poster: display_url} : {kind:'image', url: display_url}`.
  - Sidecar → one entry per child, same rule per child.
  - **A video with no usable `video_url` degrades to its `display_url` as a plain `kind:'image'` entry.** Never a dead player.
  - Dimensions from `dimensions.{width,height}`, with the same `dim()` → 0-for-unknown convention both existing normalizers use.
  - Non-https entries are **skipped**, not emitted.
- **`poster`:** set from `display_url` on every video entry, **omitted entirely** (not `undefined`) when there is none — `mastodon.ts` omits `preview_url` on a posterless video deliberately and a fallback here would reinstate the measured defect behind the renderer's back.
- **`canonical`:** `https://www.instagram.com/{reel|p}/{ref.code}/`, chosen from the payload, built through `new URL().href` so a hostile code cannot put a raw CR/LF into the `location` header `worker.ts` builds from it (the HTTP 500 fixed in 4655ee8).
- **`counts`:** `likes ← edge_media_preview_like.count`, `replies ← edge_media_to_comment.count`, if present. Route every one through a `count()` helper that rejects NaN, negatives and non-integers and **omits the key** rather than emitting `NaN` — `JSON.stringify(NaN)` is `null`, which reaches `mastodon.ts`'s payload as a null where a number belongs. Copy TikTok's `num()`/`count()` pair rather than re-deriving it; it has three separate scars in its comments.
- **`sensitive: false`,** always — Instagram exposes no per-post signal (spec §Sensitivity).
- **Totality:** every read defensive, `null` over a half-built Post.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/instagram-normalize.test.mjs && npm test && npm run typecheck`
Expected: PASS — 14 new tests, full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/platforms/instagram/normalize.ts test/instagram-normalize.test.mjs test/fixtures/instagram-*.html
git commit -m "feat: Instagram normalizer — single, mixed carousel and reel, from real captures

Parses the shortcode_media GraphQL object embedded in /p/{code}/embed/captioned/.
The regex is BOUNDED: an unbounded quantifier is quadratic, and this platform hands
us a 599KB decoy on the wrong UA, so the pathological input is one Instagram serves
on purpose. TikTok's normalizer measured 23s of Worker CPU on 1MB unbounded.

IS_VIDEO IS THE DISCRIMINATOR, NEVER __typename. Sidecar children in the EMBED
payload have no __typename field at all — their keys are accessibility_caption,
dimensions, display_resources, display_url, id, is_video, owner, shortcode — so
upstream, which reads __typename, mislabels every carousel video as an image. That
failure is invisible: a mislabelled video still has a display_url and still renders
a still. A synthetic fixture whose video child carries is_video and NO __typename
pins it, because a hand-written fixture naturally includes __typename and would
pass against the broken reader.

Every video entry carries poster = display_url. preview_url pointing at the video
is a MEASURED defect (2026-07-19): Discord requests a poster, receives mp4 bytes,
and abandons the rich activity card. Media.poster and the /_media/{key}/poster{N}
route already exist and are already tested — this populates them and invents
nothing. A video with no video_url degrades to its still, never to a dead player.

The 599KB decoy fixture must FAIL the extraction, which is the spec's own named
test for the one silent failure mode: HTTP 200, valid content-type, and six times
LARGER than the real payload.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Instagram fetcher (I/O only)

**Files:**
- Create: `src/platforms/instagram/fetch.ts`
- Test: `test/instagram-normalize.test.mjs` (extend — the fetcher's contract is testable with no network)

**Interfaces:**
- Consumes: `Extract<PostRef, {p:'ig'}>`.
- Produces: `fetchInstagram(ref): Promise<InstagramFetch>` — the embed HTML, or a **reason** it is absent.

#### Why this returns a reason and not `null`

Same split TikTok made, for the same reason, and it matters *more* here. `Outcome2` declares `assert_fail` and Phase 3a made TikTok the first thing to emit it. Without the split, a renamed blob, a 429, an edge block and a wave of genuinely deleted links all collapse into one `fetch_fail` counter — and they call for opposite responses.

| What happened | Counter |
|---|---|
| The **PAGE** did not answer: no `shortcode_media` — **including the decoy**, a block page, a 429 | **`assert_fail`** |
| The **POST** was rejected: the object is there but yields no usable Post (deleted, private) | `fetch_fail` |
| A thrown `fetch()` (DNS, timeout, reset) | `fetch_fail` |

**The decoy is the reason this split earns its keep on Instagram specifically.** A UA gate that silently flips is the single most likely way this platform dies, and it produces a *200 with valid HTML*. Folded into `fetch_fail`, "Instagram started serving us the shell" would be indistinguishable from "people are pasting dead links", and the spec's alert (*`assert_fail` > 10% of a platform's requests over 15 minutes*) would never fire.

The counters **stack**, they do not replace: an `assert_fail` is also counted as a `fetch_fail` by the worker's existing null path. That is this file's established pattern — `worker.ts`'s activity/oembed case already layers `fetch_fail` on top of `api_miss` — so `assert_fail / fetch_fail` reads as *"of the failures, this fraction were the page assertion"*.

- [ ] **Step 1: Write the failing test**

Append to `test/instagram-normalize.test.mjs`:
```js
import { INSTAGRAM_UA, hasEmbedPayload, pageOutcome } from '../src/platforms/instagram/fetch.ts'
import { TIKTOK_UA } from '../src/platforms/tiktok/fetch.ts'

test('THE UA IS CRAWLER-SHAPED — INSTAGRAM IS INVERTED FROM TIKTOK', () => {
  // The mirror image of the TikTok test that asserts TIKTOK_UA is NOT crawler-shaped. Both
  // assertions exist so the inversion cannot be "fixed" silently in EITHER direction, which is a
  // live risk: this repo carries the TikTok warning in language that reads almost identically to
  // Instagram's, and both normalizers open with a paragraph about not conflating them.
  //
  // Verified: facebookexternalhit (98,682 bytes, payload), Discordbot (98,728, payload),
  // curl/8.4.0 (98,663, payload), Chrome/122 (599,264, NO payload — the decoy). curl succeeding
  // is the decisive row: the least browser-like fingerprint available gets the real content,
  // which is what disproves the widely-repeated TLS/JA3 theory.
  assert.ok(/bot|crawler|external|curl/i.test(INSTAGRAM_UA), `INSTAGRAM_UA must be crawler-shaped, got ${INSTAGRAM_UA}`)
  assert.ok(!/Mozilla\/5\.0 \(Macintosh|Windows NT/.test(INSTAGRAM_UA), 'and must not be a browser UA')
  assert.notEqual(INSTAGRAM_UA, TIKTOK_UA, 'the two platforms gate in OPPOSITE directions')
})

test('the fetcher asserts on CONTENT — and the 599KB decoy fails that assertion', () => {
  // Status is 200 and content-type is text/html for BOTH. Size is not a signal either, and it
  // points the wrong way: the decoy is the BIGGER document.
  assert.equal(hasEmbedPayload(SINGLE), true)
  assert.equal(hasEmbedPayload(REEL), true)
  assert.equal(hasEmbedPayload(DECOY), false, 'the decoy must not pass the page assertion')
  assert.equal(hasEmbedPayload(''), false)
  assert.equal(hasEmbedPayload(null), false)
})

test('A DECOY, A BLOCK PAGE OR A CHANGED MARKER IS assert_fail — and never throws', () => {
  // pageOutcome is PURE, so this needs no network and no stubbed global fetch.
  const cases = {
    decoy: DECOY,
    '429': '<html><head><title>429 Too Many Requests</title></head><body>rate limited</body></html>',
    // The marker RENAMED — the single most likely way this platform dies.
    renamed: SINGLE.replaceAll('shortcode_media', 'shortcode_media_v2_renamed'),
    login: '<html><body>Log in to Instagram</body></html>',
    empty: '',
  }
  for (const [name, body] of Object.entries(cases)) {
    let got
    assert.doesNotThrow(() => { got = pageOutcome(body) }, name)
    assert.equal(got.ok, false, name)
    assert.equal(got.reason, 'assert_fail', name)
  }
  for (const junk of [null, undefined, 42, {}]) {
    assert.equal(pageOutcome(junk).ok, false, String(junk))
    assert.equal(pageOutcome(junk).reason, 'assert_fail', String(junk))
  }
})

test('a real page is ok:true and carries the body through unmodified', () => {
  const got = pageOutcome(SINGLE)
  assert.equal(got.ok, true)
  assert.equal(got.html, SINGLE, 'the body must reach the normalizer byte-for-byte')
})
```

> **Note on the `renamed` case.** `hasEmbedPayload` is a substring test, so renaming *by appending* (`shortcode_media_v2`) still contains the old name and still matches — correctly, since the object is still there. The test above renames the whole token so the case is genuinely a miss. If the real rename is an append, the assertion still holds and nothing breaks; that is the intended behaviour, not a gap.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/instagram-normalize.test.mjs`
Expected: FAIL — cannot find `../src/platforms/instagram/fetch.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/platforms/instagram/fetch.ts`:

```ts
import type { PostRef } from '../../types.ts'
import { shortcodeMedia } from './normalize.ts'

/**
 * INSTAGRAM'S UA GATE IS INVERTED FROM TIKTOK'S. Verified live and from Workers egress:
 *
 *   facebookexternalhit/1.1  -> 98,682 bytes, payload present   REAL
 *   Discordbot/2.0           -> 98,728 bytes, payload present   REAL
 *   curl/8.4.0               -> 98,663 bytes, payload present   REAL
 *   Chrome/122               -> 599,264 bytes, NO payload       DECOY, at HTTP 200
 *
 * Claim to be a browser and Instagram assumes you have JS and serves a large empty shell; claim
 * to be a crawler and it server-renders the content. OGInstagram documents it (config.go:62).
 * curl/8.4.0 succeeding is the decisive row — the least browser-like fingerprint available gets
 * the real content, which disproves the widely-repeated TLS/JA3 theory. The gate is the UA.
 *
 * TIKTOK IS THE EXACT OPPOSITE — there a crawler UA gets a ~7KB decoy and a plain Chrome UA gets
 * the real page — and src/platforms/tiktok/fetch.ts says so in language that reads almost
 * identically to this paragraph. Do not "fix" this file to match it. A test asserts mechanically
 * that this UA IS crawler-shaped and that one is NOT, so the conflation cannot be made silently
 * in either direction.
 *
 * NO CREDENTIALS OF ANY KIND. No cookie, no x-ig-app-id, no CSRF token, no session. There is
 * nothing to rotate and no device identity to generate.
 */
export const INSTAGRAM_UA = 'facebookexternalhit/1.1'

/**
 * "This is a real embed page." The ONE spelling of the extraction is shortcodeMedia() in
 * normalize.ts, reused here rather than re-implemented: two spellings is two things to keep in
 * step when Instagram renames something, and the extraction is where a platform change breaks us
 * first. (Same rule videoDetailScope states for TikTok.)
 *
 * NOT "there is a post in it" — a private or unavailable post may still return a page. Deciding
 * that is the normalizer's job, and two places answering it is two places that can disagree.
 */
export function hasEmbedPayload(body: unknown): boolean {
  return shortcodeMedia(body) !== null
}

/**
 * "The PAGE did not answer" vs "the POST was rejected" — two different failures that would
 * otherwise share one counter.
 *
 * assert_fail means WE are broken: the decoy, a block page, a rate limit, or Instagram renaming
 * the object. THE DECOY IS WHY THIS EARNS ITS KEEP HERE SPECIFICALLY — a silently-flipped UA gate
 * returns HTTP 200 with valid HTML, so folded into fetch_fail it would be indistinguishable from
 * people pasting dead links, and the spec's assert_fail alert would never fire.
 */
export type InstagramFetch =
  | { ok: true; html: string }
  | { ok: false; reason: 'assert_fail' }

/** PURE, so the classification is testable with no network and no stubbed globals. */
export function pageOutcome(body: unknown): InstagramFetch {
  return hasEmbedPayload(body) ? { ok: true, html: body as string } : { ok: false, reason: 'assert_fail' }
}

/**
 * ASSERT ON CONTENT, NEVER ON STATUS, NEVER ON CONTENT-TYPE, AND NEVER ON SIZE. The decoy is
 * HTTP 200 text/html and is SIX TIMES LARGER than the real payload, so every one of those checks
 * is either uninformative or actively backwards.
 *
 * /p/{code}/embed/captioned/ is used for EVERY surface, because /reel/{code}/embed/captioned/
 * returns a byte-identical payload (verified 2026-07-19). One spelling, and the router's
 * kind-collapsing (Task 2) is what makes that sound.
 *
 * A THROWN fetch is deliberately not caught here: worker.ts's loadPost already treats a thrown
 * live-fetch as a null, and a transport failure is not evidence about Instagram's gate. Catching
 * it here to relabel it assert_fail would dilute the one signal this type exists to carry.
 */
export async function fetchInstagram(ref: Extract<PostRef, { p: 'ig' }>): Promise<InstagramFetch> {
  // Stories have no /embed/captioned/ equivalent and are out of scope; the router never mints a
  // story ref today, and this narrows rather than guesses if one ever arrives from a stale cache.
  if (ref.kind === 'story') return { ok: false, reason: 'assert_fail' }
  const res = await fetch(
    `https://www.instagram.com/p/${encodeURIComponent(ref.code)}/embed/captioned/`,
    { headers: { 'user-agent': INSTAGRAM_UA, accept: 'text/html' } },
  )
  return pageOutcome(await res.text())
}
```

**If Task 1 landed on decision-tree branch 3** (the payload arrives under `contextJSON` rather than `TimeSliceImpl`/`shortcode_media` from Workers egress), the marker Task 3's extractor targets changes and this file follows it automatically — `hasEmbedPayload` delegates to `shortcodeMedia`, which is the single point of change. Record which branch was taken in the file's header comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/instagram-normalize.test.mjs && npm test && npm run typecheck`
Expected: PASS — 4 new tests, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/platforms/instagram/fetch.ts test/instagram-normalize.test.mjs
git commit -m "feat: Instagram fetcher — a crawler UA, because a browser UA gets the decoy

Verified: facebookexternalhit, Discordbot and curl/8.4.0 all get the real ~98KB
payload; Chrome/122 gets a 599,264-byte empty shell at HTTP 200. curl succeeding is
the decisive row — the least browser-like fingerprint available gets the real
content, which disproves the widely-repeated TLS/JA3 theory. The gate is the UA.

This is INVERTED from TikTok, where a crawler UA gets a ~7KB decoy and Chrome gets
the real page, and this repo already carries that warning in nearly identical
language. Two tests now point in opposite directions — one asserts INSTAGRAM_UA IS
crawler-shaped, the other that TIKTOK_UA is NOT — so the conflation cannot be made
silently in either direction.

No credentials of any kind: no cookie, no x-ig-app-id, no CSRF, no session. Nothing
to rotate and no device identity to generate.

The page assertion delegates to the normalizer's shortcodeMedia() rather than
re-implementing the extraction, so there is ONE spelling to keep in step when
Instagram renames something. It asserts on content only — never status, never
content-type, and never size, which points backwards here since the decoy is the
BIGGER document.

It returns a REASON rather than null so the decoy counts assert_fail rather than
fetch_fail. That split earns its keep on this platform specifically: a silently
flipped UA gate returns HTTP 200 with valid HTML, so folded into fetch_fail it
would be indistinguishable from people pasting dead links and the spec's
assert_fail alert would never fire.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Dispatch Instagram in the pipeline

**Files:**
- Modify: `src/worker.ts`
- Test: `test/pipeline.test.mjs` (extend)

**Interfaces:**
- Consumes: `PostRef`, `Env`, `ClientClass`.
- Produces: an `ig` case in `liveFetchPost`.

`liveFetchPost`'s `default` arm currently swallows `ig` — a correct fetcher and normalizer would still render "could not fetch post". The signature already carries `env` and `client` (Phase 3a paid for that), so this is genuinely a small task: one `case`, mirroring the `tt` one, minus the video-resolution step.

**There is no `withResolvedVideo` analogue and that is the point.** TikTok needs one because its playable URL is itself a 302 and Discord seeing two hops costs the rich card. Instagram's `video_url` is a direct CDN URL at **zero hops** (fact 4), so there is nothing to collapse and no upstream fetch to pay. If Task 1's probe came back with the CDN refusing Workers egress, **that still does not add a resolution step** — there is no redirect to resolve. It is a human-gate risk, recorded in the research doc, not a code change.

- [ ] **Step 1: Write the failing test**

Append to `test/pipeline.test.mjs`:
```js
const IG_POST = '/p/DaQ5CPTki4E'

test('an Instagram post reaches the renderer as an ig post, leaking no CDN url', async () => {
  const post = {
    ref: { p: 'ig', kind: 'p', code: 'DaQ5CPTki4E' },
    canonical: 'https://www.instagram.com/p/DaQ5CPTki4E/',
    author: { name: 'Someone', handle: 'someone', url: 'https://www.instagram.com/someone/' },
    text: 'a caption', createdAt: new Date('2026-07-01T00:00:00Z'),
    media: [
      { kind: 'image', url: 'https://scontent.cdninstagram.com/a.jpg', w: 1080, h: 1080 },
      { kind: 'video', url: 'https://scontent.cdninstagram.com/b.mp4', w: 720, h: 1280,
        poster: 'https://scontent.cdninstagram.com/b.jpg' },
    ],
    counts: { likes: 5 }, sensitive: false,
  }
  const res = await handle(req(IG_POST, DISCORD), fakeEnv(), ctx, {
    cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }),
  })
  const html = await res.text()
  assert.equal(res.status, 200)
  assert.ok(!html.includes('cdninstagram'), 'a raw CDN url must never reach a client')
  assert.ok(!html.includes('scontent'), 'nor any other raw CDN host')
  assert.match(html, new RegExp(`statuses/${encodeStatusId(refKey(post.ref))}`))
  assert.ok(!/could not fetch post/i.test(html), 'the dispatch must not fall through to fetch_fail')
})

test('/_media/ resolves an Instagram image AND its video poster with 302s, never a proxy', async () => {
  const post = { /* …the same post… */ }
  const deps = { cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const key = encodeURIComponent(refKey(post.ref))

  const img = await handle(req(`/_media/${key}/0`), fakeEnv(), ctx, deps)
  assert.equal(img.status, 302)
  assert.equal(img.headers.get('location'), 'https://scontent.cdninstagram.com/a.jpg')
  assert.match(img.headers.get('cache-control'), /max-age=300/)

  // THE POSTER ROUTE, already built and already tested — this proves ig reaches it.
  const poster = await handle(req(`/_media/${key}/poster1`), fakeEnv(), ctx, deps)
  assert.equal(poster.status, 302)
  assert.equal(poster.headers.get('location'), 'https://scontent.cdninstagram.com/b.jpg',
    'poster{N} must resolve to the IMAGE, never the mp4')
})

test('an Instagram fetch failure degrades: error embed for a crawler, 302 for a human', async () => {
  const bad = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }) }
  assert.match(await (await handle(req(IG_POST, DISCORD), fakeEnv(), ctx, bad)).text(), /could not fetch post/i)
  const human = await handle(req(IG_POST), fakeEnv(), ctx, bad)
  assert.equal(human.status, 302)
  assert.equal(human.headers.get('location'), 'https://www.instagram.com/p/DaQ5CPTki4E/')
})

test('liveFetchPost dispatches ig, and still returns null for platforms with no fetcher', async () => {
  for (const ref of [{ p: 'th', code: 'A' }, { p: 'rd', sub: 'aww', id: 'a' }, { p: 'x', id: '1' }]) {
    assert.equal(await liveFetchPost(ref, fakeEnv(), 'other-bot'), null, ref.p)
  }
})

test('THE DECOY LANDS IN assert_fail, distinguishably from a post that is simply gone', async () => {
  // The counter half of Task 4's split. Without it, "Instagram flipped the UA gate" and "people
  // are pasting dead links" emit byte-identical analytics — and the decoy is an HTTP 200, so
  // nothing else would ever reveal it.
  const real = globalThis.fetch
  try {
    const run = async body => {
      globalThis.fetch = async () => new Response(body, { status: 200 })
      const env = fakeEnv()
      await liveFetchPost({ p: 'ig', kind: 'p', code: 'ABC' }, env, 'discord')
      return env.points.filter(p => p.blobs[0] === 'ig').map(p => p.blobs[1])
    }
    const decoy = await run(readFileSync('test/fixtures/instagram-decoy.html', 'utf8'))
    assert.ok(decoy.includes('assert_fail'), 'the 599KB decoy must be assert_fail')

    const gone = await run(readFileSync('test/fixtures/instagram-gone.html', 'utf8'))
    // A page with no payload at all is also assert_fail — which is correct and worth pinning:
    // Instagram does not distinguish "gone" from "shell" on this endpoint, so we do not invent
    // a distinction we cannot observe. Recorded here so nobody later "fixes" it into fetch_fail.
    assert.ok(gone.includes('assert_fail'))
  } finally {
    globalThis.fetch = real
  }
})

test('counters attribute the platform, so ig traffic is visible separately', async () => {
  const env = fakeEnv()
  await handle(req(IG_POST, DISCORD), env, ctx, {
    cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }),
  })
  assert.ok(env.points.some(p => p.blobs[0] === 'ig' && p.blobs[1] === 'fetch_fail'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL — the render and media tests get a failure embed because `liveFetchPost`'s `default` arm swallows `ig`. The two degrade tests (`fetch failure degrades`, `counters attribute the platform`) **already pass**: with no dispatch, an ig post is a `fetch_fail`, which is exactly what they assert. They stay as regression guards on the path that must keep working after the dispatch exists.

- [ ] **Step 3: Write minimal implementation**

In `src/worker.ts`, a new case beside `tt`:
```ts
    case 'ig': {
      const got = await fetchInstagram(ref)
      if (!got.ok) {
        // Instagram served the decoy, blocked us, or renamed the object. NOT the same event as a
        // deleted post — and on this platform that distinction is invisible without the counter,
        // because the decoy is an HTTP 200 with valid HTML.
        count(env, 'ig', got.reason, client)
        return null
      }
      /**
       * NO VIDEO-RESOLUTION STEP, and its absence is a fact rather than an omission. TikTok needs
       * withResolvedVideo because its playable url is itself a 302, and Discord seeing two hops
       * costs the rich activity card. Instagram's video_url is a DIRECT CDN url at zero redirect
       * hops (verified 2026-07-19: 6,887,308 bytes, h264/aac 720x1280, cookie-free), so there is
       * nothing to collapse and no upstream fetch to pay for on this path.
       */
      return normalizeInstagram(got.html, ref)
    }
```
plus the two imports.

**If Task 1's probe found an `oe=` window under 20 minutes**, lower `POST_TTL` in `src/cache.ts` in this task and state the measured number in the commit message. Spec §Media requires `POST_TTL + MEDIA_MAX_AGE` to stay under the shortest CDN signature lifetime, and shipping past it means serving embeds whose images are already dead.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pipeline.test.mjs && npm test && npm run typecheck`
Expected: PASS — 6 new tests, full suite green. **Confirm the whole suite**, not just this file.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/pipeline.test.mjs
git commit -m "feat: dispatch Instagram in liveFetchPost

liveFetchPost's default arm was swallowing ig, so a correct fetcher and normalizer
would still have rendered 'could not fetch post'. One case beside tt; the env and
client parameters Phase 3a added are what let it count assert_fail.

NO video-resolution step, and the absence is a fact rather than an omission. TikTok
needs withResolvedVideo because its playable url is itself a 302 and Discord seeing
two hops costs the rich activity card — and Workers egress provably cannot resolve
that hop (docs/research/2026-07-19-aweme-resolution-from-workers.md). Instagram's
video_url is a DIRECT CDN url at zero redirect hops, so there is nothing to
collapse and no upstream fetch to pay on this path.

The decoy counts assert_fail. On this platform that distinction is invisible
without the counter, because the decoy is an HTTP 200 carrying valid HTML.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: The mixed carousel — what is genuinely free, and what is genuinely new

**Files:**
- Test: `test/render.test.mjs`, `test/mastodon.test.mjs` (extend)
- Modify: only whatever the tests below prove is broken. **Expect that to be little or nothing.**

**Interfaces:** none new.

This task is deliberately test-first-and-maybe-nothing-else. Its job is to convert "the gallery is free" from a claim into evidence, and to draw a hard line under the one shape nobody has rendered before.

#### GENUINELY FREE — inherited, already tested, zero new lines

Everything below already works for `ig` because it is platform-agnostic and two platforms already exercise it. **Verify by test; do not re-implement.**

- **The gallery itself.** `mediaList` → `attachment()` → `media_attachments`, the spoof head's `og:image` suppression, `/_media/{key}/{i}` resolution. This is Phase 2's work, and a TikTok slideshow already collects it. An Instagram carousel of images is *the same shape* and costs nothing.
- **The poster route.** `Media.poster`, `MediaIndex`'s `{poster: N}`, `router.ts`'s `poster{N}` segment with its image-only extension allowlist, `pickMedia`'s poster branch, `posterUrl()` in `mastodon.ts`. All built 2026-07-19. Task 3 populates the field; nothing else needed.
- **Platform identity.** `THEME.ig = '#c13584'` and `APPLICATION.ig = 'Instagram'` are already in the tables, already string-result-guarded against the `Object.prototype` hazard. This phase is the first time a real Post can reach them — so **verify**, and treat the colour *value* as a human-gate item (fact 9).
- **The video head.** `playableVideo()`, `videoTags()`, the spoof head's production-parity video block. Built for TikTok, platform-agnostic.
- **Everything else:** `refKey`/`parseRefKey`, cache, `statusid`, `classify`, `analytics`, the chooser, the text renderers, Telegram.

#### GENUINELY NEW — and it is exactly one shape

> **A `media_attachments` array that mixes `type:"image"` and `type:"video"` entries has NEVER been rendered by this service.**

Every gallery to date is homogeneous: Bluesky is all images (max 4), a TikTok slideshow is all images, a TikTok video post is exactly one video. An Instagram carousel can be **10 entries, 4 of them video, interleaved** — which is simultaneously the first mixed gallery, the first gallery with more than one video, and (at 10) past the largest gallery any fixture has measured.

Three consequences, in descending order of confidence:

1. **`videoTags()` picks the FIRST playable video and uses its index.** On a carousel whose first video sits at position 3, `og:video` points at `/_media/{key}/3` while the gallery advertises all ten. That is *coherent* — index 3 really is that video — but it has never been exercised, and it is the assertion most worth pinning. Test it.
2. **`originalMeta()` applies `fudge()` to video and true dimensions to images**, so a mixed array now carries both conventions side by side in one payload for the first time. Nothing suggests that is wrong; nothing has ever checked it.
3. **Whether Discord renders a mixed gallery at all is UNKNOWN and cannot be settled locally.** Phase 2 established that Discord's embed debugger does not render the spoof path faithfully, and the Phase 2 gate was passed by a human looking at a phone. This is a **human-gate item** (Task 9) and it is stated as unknown rather than assumed to work. **If it degrades, the fallback is not a code change to guess at** — capture what the client shows and take it to the human, exactly as the TikTok video-card investigation did.

- [ ] **Step 1: Write the failing test**

Append to `test/mastodon.test.mjs`:
```js
const igMixed = () => ({
  ref: { p: 'ig', kind: 'p', code: 'ABC' },
  canonical: 'https://www.instagram.com/p/ABC/',
  author: { name: 'A', handle: 'a', url: 'https://www.instagram.com/a/' },
  text: 'x', createdAt: new Date('2026-07-01T00:00:00Z'), counts: {}, sensitive: false,
  media: [
    { kind: 'image', url: 'https://cdn/0.jpg', w: 1080, h: 1080 },
    { kind: 'image', url: 'https://cdn/1.jpg', w: 1080, h: 1350 },
    { kind: 'video', url: 'https://cdn/2.mp4', w: 720, h: 1280, poster: 'https://cdn/2.jpg' },
    { kind: 'image', url: 'https://cdn/3.jpg', w: 1080, h: 1080 },
    { kind: 'video', url: 'https://cdn/4.mp4', w: 720, h: 1280, poster: 'https://cdn/4.jpg' },
  ],
})

test('A MIXED CAROUSEL KEEPS EVERY ENTRY, IN ORDER, WITH ITS OWN TYPE', () => {
  // The first heterogeneous media_attachments array this service has ever produced. Bluesky is
  // all images, a TikTok slideshow is all images, a TikTok video is exactly one video.
  const s = toMastodonStatus(igMixed(), ORIGIN)
  assert.equal(s.media_attachments.length, 5)
  assert.deepEqual(s.media_attachments.map(a => a.type),
    ['image', 'image', 'video', 'image', 'video'], 'order and type must both survive')
  for (const [i, a] of s.media_attachments.entries()) {
    assert.match(a.url, new RegExp(`/_media/ig%3Ap%3AABC/${i}$`), `attachment ${i} must be on our origin`)
    assert.ok(!a.url.includes('cdn/'), 'no raw CDN url may reach a client')
  }
  assert.equal(s.application.name, 'Instagram', 'the APPLICATION table row is now reachable')
})

test('EVERY video attachment gets a POSTER url, and every image keeps its own', () => {
  // preview_url = the video file is the measured defect that cost the rich card. Two videos at
  // DIFFERENT indices is the case a single-video platform could never have caught: an off-by-one
  // here would give attachment 4 attachment 2's poster and look entirely plausible.
  const s = toMastodonStatus(igMixed(), ORIGIN)
  assert.match(s.media_attachments[2].preview_url, /\/poster2$/)
  assert.match(s.media_attachments[4].preview_url, /\/poster4$/)
  assert.ok(!s.media_attachments[2].preview_url.endsWith('/2'), 'preview_url must NOT be the video itself')
  // Images are deliberately untouched: an image IS its own poster.
  assert.equal(s.media_attachments[0].preview_url, s.media_attachments[0].url)
})

test('a video attachment with NO poster OMITS preview_url rather than falling back to the video', () => {
  const p = igMixed()
  delete p.media[2].poster
  const s = toMastodonStatus(p, ORIGIN)
  assert.ok(!('preview_url' in s.media_attachments[2]) || s.media_attachments[2].preview_url == null,
    'omission is the fix; falling back to url reinstates the defect')
})
```

Append to `test/render.test.mjs`:
```js
test('THE HEAD OF A MIXED CAROUSEL: og:video is the FIRST video, at ITS OWN index', () => {
  // Never exercised. Every video post to date had its video at index 0. Here the first playable
  // video is at index 2, and og:video must name /_media/{key}/2 — coherent with the gallery,
  // which advertises all five.
  const html = await body(render({ kind: 'post', post: igMixed() }, 'discord', ORIGIN))
  assert.match(html, /property="og:video"/)
  assert.match(html, /\/_media\/ig%3Ap%3AABC\/2/, 'og:video must point at the first VIDEO index')
  assert.ok(!html.includes('cdn/'), 'no raw CDN url in the head either')
  // Still the spoof path: the activity link and og:video ship together (measured against
  // production 2026-07-19), and the gallery comes from media_attachments, not from og:image.
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:image'), 'the og:image suppression on a media post is the mechanism')
})

test('theme-color and the platform name follow ref.p for Instagram', () => {
  // These table rows have existed since Phase 3a as UNVERIFIED placeholders — no ig Post could
  // reach them. This is the first time one can. The VALUE is a human-gate item; that it is
  // wired at all is this test's job.
  const html = await body(render({ kind: 'post', post: igMixed() }, 'discord', ORIGIN))
  assert.match(html, /theme-color" content="#c13584"/)
  assert.ok(!html.includes('#0085ff'), 'Bluesky blue must not ship on Instagram')
  assert.ok(!html.includes('#ff0050'), 'nor TikTok pink')
})

test('a single-image Instagram post takes the same path Bluesky already proved', async () => {
  // The regression guard: adding a platform must not perturb the shape a human already signed off.
  const single = { ...igMixed(), media: [{ kind: 'image', url: 'https://cdn/0.jpg', w: 1080, h: 1080 }] }
  const html = await body(render({ kind: 'post', post: single }, 'discord', ORIGIN))
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:video'), 'no video entry means no video tags')
})
```

- [ ] **Step 2: Run the tests and READ WHAT FAILS**

Run: `node --test test/mastodon.test.mjs test/render.test.mjs`

**This is the one task in this plan whose expected outcome is "mostly green".** That is the deliverable: the free-list above is a claim, and these tests are the evidence for it. Interpret the result honestly:

- **All green** — the free-list is correct, this task ships tests only, and the commit says so.
- **A poster/index test is red** — real bug, in `mastodon.ts` or `media.ts`, exposed by the first multi-video gallery. Fix it there, not in the Instagram normalizer.
- **A theme/application test is red** — the tables drifted since Phase 3a. One line.
- **An ordering test is red** — something compacts `mediaList`, which `media.ts` explicitly forbids (compacting makes every attachment after a corrupt entry serve the wrong image). Fix at the source.

**Do not "fix" a red test by changing the test.** Each assertion above corresponds to a specific measured defect or a specific documented invariant.

- [ ] **Step 3: Commit**

```bash
git add test/render.test.mjs test/mastodon.test.mjs src/render/*.ts src/media.ts
git commit -m "test: pin the mixed image+video carousel, the one genuinely new render shape

A media_attachments array mixing type:image and type:video has never been rendered
by this service. Bluesky is all images (max 4), a TikTok slideshow is all images, a
TikTok video post is exactly one video. An Instagram carousel is up to 10 entries
with videos interleaved — simultaneously the first mixed gallery, the first gallery
with more than one video, and larger than any fixture measured.

Three things that had never been exercised are now pinned: og:video names the FIRST
video at ITS OWN index (every video post to date had its video at index 0); two
videos at DIFFERENT indices each get their own poster{N} (an off-by-one here would
give attachment 4 attachment 2's poster and look entirely plausible); and the ig
rows of THEME and APPLICATION, unverified placeholders since Phase 3a because no ig
Post could reach them, are now reachable and correct.

Everything else really was free — the gallery, the poster route, the video head,
refKey, cache, statusid, classify, analytics, the chooser, text, Telegram — and
this commit is the evidence for that claim rather than a restatement of it.

Whether Discord renders a MIXED gallery is still unknown and cannot be settled
locally: the embed debugger does not render the spoof path faithfully. It is a
human-gate item, stated as unknown rather than assumed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end, with no network

**Files:**
- Test: `test/pipeline.test.mjs` (extend)

**Interfaces:** none new. This task proves the seams line up, using the real fixtures and the real normalizer with an injected fetch.

- [ ] **Step 1: Write the failing test**

```js
import { normalizeInstagram } from '../src/platforms/instagram/normalize.ts'

const igPost = (f, code) => normalizeInstagram(readFileSync(`test/fixtures/instagram-${f}.html`, 'utf8'),
                                               { p: 'ig', kind: 'p', code })

test('REAL FIXTURE: a mixed carousel becomes a gallery, all on our own origin', async () => {
  const post = igPost('carousel', 'REPLACE_CAROUSEL')
  const deps = { cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const id = encodeStatusId(refKey(post.ref))
  const res = await handle(req(`/api/v1/statuses/${id}`, DISCORD), fakeEnv(), ctx, deps)
  assert.equal(res.headers.get('content-type'), 'application/json')
  const json = await res.json()
  assert.equal(json.media_attachments.length, post.media.length)
  assert.ok(json.media_attachments.length >= 2)
  assert.ok(json.media_attachments.some(a => a.type === 'video'), 'the real carousel HAS videos in it')
  assert.ok(json.media_attachments.some(a => a.type === 'image'))
  for (const a of json.media_attachments) {
    assert.match(a.url, /\/_media\/ig%3Ap%3A/)
    assert.ok(!a.url.includes('cdninstagram'))
    if (a.type === 'video') assert.match(a.preview_url, /\/poster\d+$/)
  }
  assert.equal(json.application.name, 'Instagram')
})

test('REAL FIXTURE: a reel renders a player and /_media/ 302s to the direct CDN url', async () => {
  const post = igPost('reel', 'REPLACE_REEL')
  const deps = { cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const html = await (await handle(req(`/reel/${post.ref.code}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, /property="og:video"/)
  assert.match(html, /\/_media\/ig%3Ap%3A/, 'og:video must point at OUR origin')
  assert.ok(!html.includes('cdninstagram'))
  assert.match(html, /theme-color" content="#c13584"/)

  const key = encodeURIComponent(refKey(post.ref))
  const i = post.media.findIndex(m => m.kind === 'video')
  const m = await handle(req(`/_media/${key}/${i}`), fakeEnv(), ctx, deps)
  assert.equal(m.status, 302)
  assert.match(m.headers.get('location'), /^https:\/\//)
  // ZERO HOPS is the Instagram advantage over TikTok: this Location is the CDN itself, not
  // another redirect. Nothing to collapse, nothing for Workers egress to be refused at.
  const p = await handle(req(`/_media/${key}/poster${i}`), fakeEnv(), ctx, deps)
  assert.equal(p.status, 302)
  assert.notEqual(p.headers.get('location'), m.headers.get('location'), 'the poster is NOT the video')
})

test('REAL FIXTURE: /p/ and /reel/ of ONE post render IDENTICALLY, off ONE cache entry', async () => {
  // The Task 2 invariant, driven end to end. This is the assertion that would catch a regression
  // reintroducing the ig:reel: key split — two upstream fetches and two /_media/ namespaces for
  // one post, which is invisible from any single request.
  const post = igPost('reel', 'REPLACE_REEL')
  let fetches = 0
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => { fetches++; return post },
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  const a = await (await handle(req(`/p/${post.ref.code}`, DISCORD), fakeEnv(), ctx, deps)).text()
  const b = await (await handle(req(`/reel/${post.ref.code}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.equal(a, b, 'both spellings of one post must render byte-identically')
  assert.equal(fetches, 1, 'and must cost exactly ONE upstream fetch')
})

test('REAL FIXTURE: the decoy is an honest failure, not a blank embed', async () => {
  const deps = {
    cache: fakeCache(),
    fetchPost: async () => normalizeInstagram(readFileSync('test/fixtures/instagram-decoy.html', 'utf8'),
                                              { p: 'ig', kind: 'p', code: 'X' }),
    resolveShortlink: async () => ({ kind: 'unresolved' }),
  }
  assert.match(await (await handle(req('/p/X', DISCORD), fakeEnv(), ctx, deps)).text(), /could not fetch post/i)
})

test('REAL FIXTURE: a single-image post still takes the path a human already signed off', async () => {
  const post = igPost('single', 'REPLACE_SINGLE')
  const deps = { cache: fakeCache(), fetchPost: async () => post, resolveShortlink: async () => ({ kind: 'unresolved' }) }
  const html = await (await handle(req(`/p/${post.ref.code}`, DISCORD), fakeEnv(), ctx, deps)).text()
  assert.match(html, /application\/activity\+json/)
  assert.ok(!html.includes('og:image'))
})

test('Bluesky and TikTok did not regress', async () => {
  // A third platform landing must not perturb the two that already work.
  const bs = await (await handle(req('/profile/a.bsky.social/post/xyz', DISCORD), fakeEnv(), ctx,
    { cache: fakeCache(), fetchPost: async () => base, resolveShortlink: async () => ({ kind: 'unresolved' }) })).text()
  assert.match(bs, /theme-color" content="#0085ff"/)
})
```

- [ ] **Step 2: Run, fix the seams, commit**

Run: `npm test && npm run typecheck`
Expected: PASS. If any of these fail, the failure is in a **seam** — a wire format two modules spell differently — and that is exactly what this task exists to catch before staging.

```bash
git add test/pipeline.test.mjs
git commit -m "test: Instagram end to end through the real fixtures, with no network

A mixed carousel becomes a Mastodon gallery with every child on our own origin and
every video child carrying a poster{N} preview_url; a reel reaches a player whose
og:video is our url and whose /_media/ 302 lands on the CDN directly, with a poster
that is provably not the video; the 599KB decoy is an honest failure embed rather
than a blank one; and Bluesky and TikTok are unperturbed.

The load-bearing one is /p/ and /reel/ of ONE post rendering byte-identically off
ONE upstream fetch. That is the Task 2 invariant driven end to end, and it is the
assertion that would catch a regression reintroducing the ig:reel: cache-key split
— two fetches and two /_media/ namespaces for one post, which is invisible from any
single request.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Deploy to staging, delete the probe, verify by curl

**Files:**
- Delete: `src/probe.ts`, `test/probe.test.mjs`
- Modify: `src/worker.ts` (unmount), `src/analytics.ts` (drop `PROBE_TOKEN`)
- Test: `test/pipeline.test.mjs` (extend — the deletion needs an enforcer that OUTLIVES it)

The probe is a debug endpoint that fetches an arbitrary caller-supplied shortcode from our egress. It existed for one measurement, that measurement is recorded, and the safest moment to remove it is **before** the deploy this phase is judged on — not after, when "it's only on staging" starts sounding like a reason.

#### The deletion must be ENFORCED, not requested

`git rm` deletes the files. **Nothing deletes the mount.** An agent that runs the `git rm` and skips the unmount leaves `import { runProbe } from './probe.ts'` failing typecheck — but one that skips *both* edits, or removes the import and leaves a dead `PROBE_TOKEN` branch, keeps `npm test` and `npm run typecheck` green **while the endpoint ships to a public staging origin**. A comment in a bash block is not a check; it is a hope.

So the enforcement is a test in a **surviving** file — one `git rm` cannot take with it — written FIRST, in this plan's usual TDD order.

- [ ] **Step 1: Write the enforcing test, and watch it FAIL**

> **DO NOT APPEND. THESE TWO TESTS ALREADY EXIST IN `test/pipeline.test.mjs`** — they are the TikTok phase's enforcer, which this plan did not anticipate, and Instagram Task 1 **suspended** them with `{ skip: PROBE_PHASE }` because Task 1 deliberately re-mounts a probe of exactly the shape they forbid. As of this writing they sit at **lines ~1160-1220** of a **1,447-line** file, so an append lands **227 lines away from the note explaining them** and an agent following an "append" instruction literally would leave the originals **skipped forever** — plus two duplicate test names in the suite. `import { existsSync, readFileSync } from 'node:fs'` is already at line 3; do not add it again.
>
> **What to actually do:** delete the `PROBE_PHASE` comment block and constant, delete the `{ skip: PROBE_PHASE }` argument from both tests, and update the stale TikTok field names to the Instagram spellings below (`?code=` not `?id=123`; `"embed"` not `"page"`; `hasShortcodeMedia` not `markerPresent`). The result should read exactly as follows.

```js
test('THE PROBE IS GONE — a debug egress endpoint must not ship to a public origin', () => {
  // Source-level, deliberately: the MOUNT is what survives a partial deletion, and it is what a
  // cutover would carry into production.
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
  // The behavioural half. It does NOT assert a non-200: after the unmount /_probe/t is a depth-2
  // unknown path, which route() answers notfound and render() answers with an error embed at 200
  // for a crawler. The assertion is on the BODY.
  //
  // THE CODE MUST BE SHORTCODE-SHAPED, and this is not cosmetic. runProbe rejects anything failing
  // /^[A-Za-z0-9_-]{5,32}$/ with a 400 BEFORE emitting a report, so `?code=ABC` — three characters
  // — makes every assertion below hold against a live, mounted, reachable probe. That exact defect
  // shipped once already in Task 1's guards and was caught only by mutation testing: the suite
  // stayed green at 389 pass with the token gate deleted outright. A false green here is worse
  // than a red, because this test is the ONLY thing standing between "the agent meant to unmount
  // the probe" and "the agent unmounted the probe".
  //
  // fetch is stubbed so that a regression fails offline and fast instead of making five real
  // Instagram requests from the test suite.
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('stub', { status: 200 })
  try {
    const env = { ...fakeEnv(), PROBE_TOKEN: 't' }
    const deps = { cache: fakeCache(), fetchPost: async () => null, resolveShortlink: async () => ({ kind: 'unresolved' }) }
    const text = await (await handle(req('/_probe/t?code=AAAAAAAAAAA', DISCORD), env, ctx, deps)).text()
    assert.ok(!text.includes('"embed"'), 'no probe report may be emitted')
    assert.ok(!text.includes('hasShortcodeMedia'), 'nor any field of one')
  } finally { globalThis.fetch = realFetch }
})
```

Run: `node --test test/pipeline.test.mjs`
Expected: **FAIL** — the probe still exists at this point. Both tests turn red, which is the point: they are the only thing standing between "the agent meant to unmount it" and "the agent unmounted it".

- [ ] **Step 2: Delete the probe FIRST, then deploy**

```bash
git rm src/probe.ts test/probe.test.mjs
# Now make the test above pass. BOTH edits, and the test is what proves both happened:
#   - src/worker.ts    — remove the `if (env.PROBE_TOKEN && …) return runProbe(url)` branch AND the import
#   - src/analytics.ts — remove `PROBE_TOKEN?: string` from Env
npx wrangler secret delete PROBE_TOKEN
# VERIFY IT, do not assume it. wrangler.jsonc declares ZERO `env` stanzas, so there is exactly one
# secret store on the `fxeverything` worker — and Phase 3's cutover moves the APEX onto this same
# worker. A PROBE_TOKEN left behind is a live secret on production the day that cutover lands.
npx wrangler secret list | grep -i PROBE_TOKEN && echo "STOP: the secret is still set" || echo "ok: no PROBE_TOKEN"
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

> ### USE FRESH SHORTCODES. THIS IS A HARD REQUIREMENT, NOT A SUGGESTION.
>
> A zone-level cache rule keys the edge on the **PATH ALONE** and ignores query strings. Any URL you curl is populated in the edge cache for up to four hours, and a later test of the same URL — including the human's, in Task 9 — is served the **pre-deploy** document. This invalidated a full day of TikTok A/B testing, during which four hypotheses were recorded as "refuted by measurement" when the measurement never saw the new code.
>
> **Every URL below must use a shortcode this project has never fetched**, and the shortcodes used here must NOT be reused in Task 9. Adding `?v=2` does nothing. If you are unsure whether a code is fresh, treat it as dirty and get another.

Everything here asserts on **content**, never on status, never on content-type, and never on size.

```bash
S=https://staging.megapenispoopenfarten.sex
SINGLE=/p/$FRESH_SINGLE
CAROUSEL=/p/$FRESH_CAROUSEL      # a MIXED image+video one
REEL=/reel/$FRESH_REEL

# 0. Confirm the edge is not answering from cache. If this says HIT, the URL is dirty — STOP and
#    use a different shortcode. Everything below is meaningless otherwise.
curl -s -o /dev/null -D - -A 'Discordbot/2.0' "$S$REEL" | grep -i 'cf-cache-status\|age:'

# 1. A reel -> the spoof head with a video block.
curl -s -A 'Discordbot/2.0' "$S$REEL" | tee /tmp/ig-reel.html | grep -E 'og:video|activity\+json|theme-color|og:image'
#    Expect: og:video on /_media/ig%3Ap%3A…, the activity link, theme-color #c13584, NO og:image.
#    Expect: NO cdninstagram, NO scontent — grep for them and expect zero:
grep -c 'cdninstagram\|scontent' /tmp/ig-reel.html    # expect 0

# 2. The video media URL 302s to a DIRECT CDN url — zero further hops.
LOC=$(curl -s -o /dev/null -D - "$S/_media/ig%3Ap%3A$FRESH_REEL/0" | tr -d '\r' | awk '/^location:/{print $2}')
echo "$LOC"
#    Expect: an scontent/cdninstagram host, NOT another instagram.com redirect.

# 3. THE BYTES. Cookie-free, exactly like Discord's media proxy. Magic bytes are the ONLY
#    reliable check — TikTok taught us a gated 403 can be served AS video/mp4.
curl -sL --max-filesize 400000 -r 0-1023 "$LOC" | xxd -l 16 | head -1
#    Expect '....ftyp' — bytes 4-8 are 66 74 79 70.

# 4. THE POSTER. It must be an IMAGE, and it must not be the video.
PLOC=$(curl -s -o /dev/null -D - "$S/_media/ig%3Ap%3A$FRESH_REEL/poster0" | tr -d '\r' | awk '/^location:/{print $2}')
[ "$PLOC" != "$LOC" ] && echo OK-poster-differs || echo FAIL-poster-is-the-video
curl -sL --max-filesize 400000 -r 0-1023 "$PLOC" | xxd -l 4 | head -1
#    Expect 'ffd8 ff' — a JPEG. If this is mp4 bytes, the rich card is lost and Task 3 is wrong.

# 5. THE MIXED CAROUSEL -> every child, with types preserved.
ID=$(curl -s -A 'Discordbot/2.0' "$S$CAROUSEL" | grep -o 'statuses/[0-9]*' | head -1 | cut -d/ -f2)
curl -s "$S/api/v1/statuses/$ID" | python3 -c '
import json,sys
d = json.load(sys.stdin)
a = d["media_attachments"]
print("attachments:", len(a))
print("types:", [x["type"] for x in a])
print("application:", d["application"]["name"])
assert any(x["type"]=="video" for x in a), "FAIL: no video child — is_video discriminator broken"
assert any(x["type"]=="image" for x in a), "FAIL: not a mixed carousel, pick another post"
for x in a:
    assert "/_media/" in x["url"], "FAIL: raw CDN url in media_attachments"
    if x["type"]=="video":
        assert "poster" in x.get("preview_url",""), "FAIL: video preview_url is not a poster"
print("OK")'

# 6. ONE POST, TWO SPELLINGS, IDENTICAL OUTPUT. Use a code fresh for BOTH paths — /p/X and
#    /reel/X are different EDGE keys, which is why this comparison is legal at all.
diff <(curl -s -A 'Discordbot/2.0' "$S/p/$FRESH_BOTH") \
     <(curl -s -A 'Discordbot/2.0' "$S/reel/$FRESH_BOTH") && echo OK-identical || echo FAIL-diverged

# 7. A human gets a 302 to what they pasted.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$S/reel/$FRESH_REEL"
#    Expect: 302 https://www.instagram.com/reel/{code}/

# 8. An unavailable post -> error embed for a crawler, 302 for a human.
curl -s -A 'Discordbot/2.0' "$S/p/$GONE_CODE" | grep -i 'could not fetch'

# 9. THE PROBE IS UNREACHABLE on the deployed worker, not just in the source tree.
curl -s "$S/_probe/anything?code=ABC" | grep -q '"embed"' && echo FAIL-probe-live || echo OK-probe-gone

# 10. Bluesky and TikTok did not regress.
curl -s -A 'Discordbot/2.0' "$S/profile/bsky.app/post/3l6oveex3ii2l" | grep -c activity+json
curl -s -A 'Discordbot/2.0' "$S/t/$A_FRESH_TIKTOK_SHORTCODE" | grep -c 'theme-color" content="#ff0050"'
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove the Workers-egress probe and deploy Instagram to staging

The probe answered its one question and the answer is in
docs/research/2026-07-19-instagram-workers-egress-probe.md. It fetched a
caller-supplied shortcode from our egress, so it goes before the deploy this phase
is judged on, not after.

The removal is ENFORCED by a test in a surviving file, not requested by a comment
in a shell block. `git rm` takes the probe's own files; nothing took the MOUNT, and
a run that deleted the files but skipped the unmount would leave the endpoint live
on a public origin with a green suite and a clean typecheck.

Staging verified by curl, on shortcodes never fetched before — a zone cache rule
keys the edge on the PATH ALONE and ignores query strings, so a reused URL is
served the pre-deploy document for up to four hours, which is how a full day of
TikTok A/B testing was invalidated. The reel head carries og:video on our origin
with no raw CDN host anywhere in it, /_media/{key}/0 302s to a DIRECT CDN url whose
first bytes are ftyp, and /_media/{key}/poster0 302s somewhere ELSE whose first
bytes are ffd8ff — a JPEG, not the video, which is the whole rich-card mechanism.
The mixed carousel's Mastodon status carries every child with its own type and a
poster preview_url on each video.

megapenispoopenfarten.sex untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: THE HUMAN GATE — and the changelog

**Files:**
- Modify: `docs/CHANGELOG.md`

**This cannot be settled locally, and it cannot be settled by curl.** Everything Task 8 checked is *necessary* and none of it is *sufficient*:

- **Does the video actually PLAY?** Our Worker never fetches `video_url` in production — **Discord's media proxy does, from Discord's IPs.** No test we can run measures that network path. Task 1's probe measured Workers egress, which is a different network. The magic-byte check in Task 8 proves *a* cookie-free client gets bytes; it does not prove *Discord's* cookie-free client does.
- **Does a MIXED gallery render?** Nobody knows. It has never existed here. Discord's embed debugger does not render the Mastodon-spoof path faithfully — Phase 2 recorded this, then confirmed it, and the Phase 2 gate was passed by a human looking at a phone.
- **Is `#c13584` right?** It is an unverified placeholder that has never reached a real client. Only a human can say whether it looks like Instagram.

So: a human, in a real client. There is no substitute and pretending otherwise is how this ships broken.

> **EVERY POST PASTED BELOW MUST USE A SHORTCODE NOT USED IN TASK 8.** If the human is handed a URL that Task 8 curled, they may be looking at the pre-deploy document, and their verdict — positive or negative — is void. This is not paranoia; it is the exact failure that cost a day on TikTok.
>
> **Two corrections to how this was originally stated, both measured 2026-07-20 — see the CORRECTION box in *THE EDGE-CACHE HAZARD* for the working.** (1) The window is **`RESP_TTL` = 15 minutes**, not four hours, so a shortcode Task 8 burned is usable again after ~15 minutes rather than blocking the gate for an afternoon. (2) There is **no alternate-spelling workaround**: `/p/X`, `/reel/X`, `/reels/X` and `/tv/X` share ONE cache entry, because `refKey` collapses them by design. A fresh shortcode, or 15 minutes, are the only two resets — a different spelling and a query string are neither.
>
> **Task 8 as executed burned all four shortcodes in the repo** (`C79gQqLpkul`, `DaQ5CPTki4E`, `Da5ynsiuAZ_`, `DaQ5CPTkiAE`), against this plan's own instruction at Task 8 Step 4 not to reuse the recon pair. The prerequisite at line 62 — collect at least six posts BEFORE Task 8 — was skipped rather than surfaced. Given correction (1) this is recoverable rather than fatal, but **collect fresh codes first anyway**: the 15-minute window is a floor on safety, not a plan, and the gate is worth more when nothing about it is arguable.

- [ ] **Step 1: THE GATE — paste into real Discord clients (desktop AND Android; iOS if available)**

- [ ] A **single-image** Instagram post: the image renders, with the caption, the author and an avatar row.
- [ ] A **reel**: an inline **player appears** and **the video plays**. Not a thumbnail, not a blank box, not a plain link card.
- [ ] A **mixed carousel** (images *and* videos): **how many items render, and are the videos playable or stills?** Record the actual answer even if it is disappointing — this is a first, and "it shows 4 of 10" is a finding, not a failure to report.
- [ ] The **accent colour** is Instagram's and looks right. `#c13584` is an unverified placeholder; if it looks wrong, say what would look better — it is one line in `src/render/embed.ts`.
- [ ] **`/p/{code}` and `/reel/{code}` of the same post** produce the same embed.
- [ ] A **Bluesky** multi-image post still renders its 2×2 gallery, and a **TikTok** video still plays — the regression checks.
- [ ] An **unavailable** post shows the error embed, and clicking through as a human lands on Instagram.

**If the video does not play:** the head is correct (Task 8 proved og:video is on our origin and the bytes are real mp4), so Discord's media proxy is the problem — either it cannot reach Instagram's CDN, or the signature expired. Check Task 1's `secondsRemaining` first; if the window is short, that is a `POST_TTL` change, not a redesign. Otherwise capture what the client shows and take it to the human alongside spec §Media's per-platform byte-proxying escape hatch, which is explicitly a human's call because it invents a bandwidth bill and touches an unresolved ToS question.

**If the mixed carousel shows only some items:** compare against a TikTok slideshow in the same client. If the slideshow also degraded, something in the shared spoof path broke and the Instagram normalizer is not the cause. If only the mixed one degrades, that is a genuine new finding about Discord's handling of heterogeneous `media_attachments` — **record it, do not guess at a fix.** Three speculative single-tag subtractions were already wrong once on the TikTok video head.

**If the poster is missing and the card is plain:** that is the measured 2026-07-19 defect returning. Check `preview_url` in the `/api/v1/statuses/` payload before touching anything else.

- [ ] **Step 2: Changelog**

Add an Instagram section to `docs/CHANGELOG.md`, matching the existing style: what shipped, the facts a future reader must not re-derive, what the human gate showed, the test count, and that `megapenispoopenfarten.sex` is untouched.

The facts worth the words, in rough priority:

1. **The UA gate is INVERTED from TikTok's** — the one most likely to be "fixed" backwards, and now guarded by two tests pointing in opposite directions.
2. **The decoy is HTTP 200, valid `text/html`, and SIX TIMES LARGER than the real payload** — so status, content-type and size are all either useless or actively backwards.
3. **`is_video`, never `__typename`** — sidecar children in the embed payload have no `__typename` at all, which is why upstream mislabels every carousel video as an image, invisibly.
4. **`/p/` and `/reel/` embed endpoints are byte-identical**, which is why every surface collapses onto one `ig:p:{code}` cache key — and why doing so cost no type change.
5. **`video_url` is a DIRECT CDN url at zero redirect hops**, unlike TikTok's, whose one hop Workers egress provably cannot collapse.
6. **The two dead ends** (fact 8): the normal post page under a crawler UA gives meta tags and no video; `i.instagram.com/api/v1/media/{id}/info/` 302s to login regardless of `x-ig-app-id`. An earlier probe tested only these and wrongly concluded Instagram video was impossible.
7. **The edge caches on the PATH ALONE for up to four hours**, so every live test needs a never-fetched URL. This belongs in the changelog because it is a *process* fact that outlives this phase and has already invalidated a day of work once.

Also record, so nobody goes hunting: **stories are out of scope and why** — no `/embed/captioned/` equivalent, 24-hour expiry, and plausibly private. The `ig:story:` refKey support already in the tree is deliberately left in place.

- [ ] **Step 3: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "docs: Instagram changelog — extraction verified on staging

Records the facts a future reader must not re-derive: the UA gate is INVERTED from
TikTok's, and is now guarded by two tests pointing in opposite directions; the
decoy is HTTP 200, valid text/html, and SIX TIMES LARGER than the real payload, so
status, content-type and size are all useless or backwards; is_video is the
image/video discriminator because sidecar children in the embed payload carry no
__typename at all, which is why upstream mislabels every carousel video as an image
invisibly; /p/ and /reel/ embed endpoints are byte-identical, which is why every
surface collapses onto one ig:p:{code} cache key with no type change; and video_url
is a DIRECT CDN url at zero redirect hops, unlike TikTok's single hop that Workers
egress provably cannot collapse.

Records the two DEAD ENDS so nobody re-derives them: the normal post page under a
crawler UA yields meta tags and no video url, and i.instagram.com's media info
endpoint 302s to login with or without x-ig-app-id. An earlier probe tested only
those two and wrongly concluded Instagram video was impossible.

Records that Cloudflare's edge caches our HTML on the PATH ALONE for up to four
hours, ignoring query strings — so every live test needs a URL never fetched
before. That is a process fact that outlives this phase and has already invalidated
a full day of A/B testing once.

Stories are out of scope: no /embed/captioned/ equivalent, 24h expiry, plausibly
private. The ig:story: refKey support already in the tree is left in place.

megapenispoopenfarten.sex untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Exit Criteria

- [ ] `npm test` passes; `npm run typecheck` clean.
- [ ] The Workers-egress probe result is recorded in `docs/research/`, the probe is **deleted from the code**, and a surviving test **fails if it comes back**.
- [ ] A single-image Instagram post renders correctly in a real Discord client.
- [ ] A **reel plays inline** in a real Discord client, with media served from `/_media/`.
- [ ] A **mixed image+video carousel**'s behaviour in a real Discord client is **recorded** — rendering fully is the goal; recording what actually happens is the requirement.
- [ ] `/p/{code}` and `/reel/{code}` of one post render identically and cost **one** upstream fetch.
- [ ] Every video attachment carries a **poster** `preview_url` that resolves to image bytes, never to the video.
- [ ] No raw CDN URL (`cdninstagram`, `scontent`) appears in any rendered output.
- [ ] `application.name` is `Instagram` and `theme-color` is the ig row — both previously-unreachable table entries, now verified.
- [ ] The **599KB decoy fixture fails** the content assertion and counts `assert_fail`, distinguishably from an ordinary fetch failure.
- [ ] `src/types.ts` is **unchanged**.
- [ ] The **ambiguity table is unchanged**, re-asserted in full.
- [ ] Bluesky and TikTok show no regression.
- [ ] **`megapenispoopenfarten.sex` is untouched and still serves `fxtiktok`.**

## Not in this phase (deferred)

| Deferred | To | Why |
|---|---|---|
| **Instagram stories** (`/stories/{u}/{id}`) | unscheduled | No `/embed/captioned/` equivalent exists — it would be a different fetcher against a different surface, i.e. a fresh recon. Plus 24-hour expiry and a genuine privacy question that is a human's to answer. `known` keeps `'stories'` as an honest `notfound`; the `ig:story:` refKey support stays in the tree, unused and costing nothing. |
| Instagram **profiles** | unscheduled | There is no profile `Route` kind on any platform, and Workers egress is separately known to be treated differently on IG profile pages (spec, 2026-07-17). |
| `ddinstagram.com`-style **hostname** shortcuts | with the wildcard | A hostname, not a path — needs the `*.megapenispoopenfarten.sex/*` wildcard, which the live `fxtiktok` worker still owns. Same blocker as `vm.tiktok.com`. |
| **Byte-proxying** Instagram video | only if forced | Spec permits it per-platform with a recorded reason; it invents a bandwidth bill and touches an unresolved ToS question — a human's call, and only after the gate shows it is needed. |
| The **production cutover** | Phase 3b | Separately gated, needs explicit human sign-off, and unchanged by this phase. |
| Twitter, Threads, Reddit | later | Per the owner's stated ordering. |

---

## Notes for whoever picks this up next

**On the two "already free" lookup tables.** `THEME.ig` and `APPLICATION.ig` existing before Instagram did is the clearest evidence this project's platform abstraction is real. Phase 3a fixed both generically rather than adding a TikTok special case, and this phase collects the interest. If a future platform finds those tables *not* ready for it, that is a signal the abstraction leaked somewhere — worth chasing rather than patching.

**On the inversion.** There are now two platforms in this tree with opposite UA gates, each carrying a paragraph warning about the other. That is sustainable at two. At four it will not be, and the right move then is a single documented table of per-platform gates rather than four cross-referencing paragraphs. Not yet — a table with two rows is worse than the paragraphs, because the paragraphs carry the *evidence* and a table would carry only the conclusion.

**On what this phase deliberately did not build.** No new `Route` kind, no `PostRef` change, no renderer rewrite, no second poster mechanism, no video-resolution step. If an implementer finds themselves adding any of those, the plan has been misread — every one of them was considered and has a named reason for its absence.
