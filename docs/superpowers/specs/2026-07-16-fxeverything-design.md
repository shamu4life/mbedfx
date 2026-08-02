# fxeverything — unified social embed fixer

**Date:** 2026-07-16
**Status:** Approved design
**Domain:** `megapenispoopenfarten.sex`
**Runtime:** Cloudflare Workers (Paid), account `<redacted>`

## Problem

Discord and Telegram render poor previews for X, TikTok, Instagram, Threads, Reddit, and
Bluesky links: no inline video, one image out of four, no quote-tweet context. Threads is the
worst — it withholds the post text from Discord specifically and hands back a JPEG with the
text baked into it, with no video at all.

The established fix is a substitute domain that serves crawler-friendly metadata for the same
content.

Existing tools each solve one platform (FxEmbed → X/Bluesky, fxTikTok → TikTok, InstaFix →
Instagram) with their own embed templates, so combining them by redirect yields a service
whose output looks like three different products. FixTweetBot covers many platforms but is a
Discord bot you must invite to a server, and it hosts no extraction of its own — it rewrites
links to other people's public fixers.

`fxeverything` serves all six platforms from one origin, with one embed renderer, owning its
own extraction.

## Goals

- Replace the domain in a social URL and get a correct, rich embed in Discord and Telegram.
- One coherent embed style across all six platforms.
- Own the extraction. No runtime dependency on any third-party fixer.
- Quality bar: inline video, **all** media (not just the first), quote/reply context, and
  author + engagement counts.
- A converter page for people who won't hand-edit a URL.

## Non-goals

- **Monetization now.** The option is preserved: we vendor no Commons-Clause code, so that
  clause never binds us. Nothing else in the design forecloses it.
- The long tail (Pixiv, Tumblr, YouTube, Twitch, DeviantArt…). Deferred until the core proves
  out. Each addition is one fetcher + one normalizer.
- Mastodon. Structurally impossible by find-replace — it is thousands of hosts, and replacing
  the domain destroys the only pointer to which instance holds the post.
- A Discord bot. The domain swap is the product.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Stack | TypeScript, multi-file, **no Hono**, **no containers** | See Stack below |
| Audience | Unannounced, built for public scale | See Audience below — no technical gate |
| Platforms (day one) | X, TikTok, Instagram, Threads, Reddit, Bluesky | Named scope; long tail deferred |
| Approach | Unified — own all six, one renderer | Only way to get one coherent embed style |
| Upstream code | **Ported**, with pinned read-only reference + resync ritual | See Upstream integration |
| Site | Converter on `/`, docs below | Reserved-path allowlist; see Site |
| Routing | Root replacement primary, prefixes as escape hatch | Root works for permalinks; see Routing |
| Ambiguous paths | Never guess | Guessing fails silently — the undetectable mode |
| Failure | Redirect humans, error-embed crawlers | Free: we already branch on client class |
| Media | `/_media/*` route → Post-cache read → 302 | 302 by default; see Media |
| X sensitive media | Build the credential seam, ship it empty | Defers a ToS decision at ~zero cost |
| Instagram, Threads | Own them — plain Worker `fetch()` + crawler UA | Empirically verified; see Instagram / Threads |
| Cloudflare account | Same account as the `uwutoowo.com` tools | User's call; risk stated in Deployment |
| Existing `fxtiktok` deploy | Keep live; cut over on absolute checklist | Zero-downtime sequencing |

## Stack

**TypeScript, multi-file, no framework, no containers.** Wrangler bundles and transpiles
natively, so there is no build config and **no runtime dependencies** — `wrangler` is the only
devDependency, matching the tool family's zero-deps rule. Tests run under `node --test`, same as
the rest of the family.

This departs from the family on two points, deliberately:

- **Multi-file rather than one `src/worker.js`.** Six fetchers, six normalizers, two renderers,
  a router, a cache and a media route is several thousand lines. Collapsing it into one file
  would destroy the "adding a platform is one fetcher + one normalizer" property that is the
  whole reason this project is a unified codebase instead of six redirects.
- **TypeScript rather than vanilla JS.** `PostRef` is a discriminated union and `Post` is the
  contract every platform meets — that union *is* the architecture. In JS a malformed ref
  surfaces at runtime as a blank Discord embed; in TS it is a compile error. Given the whole
  design turns on silent failures being the enemy, that is worth the departure. It also makes
  ports from FxEmbed and fxTikTok (both TS) a reading exercise rather than a rewrite.

**No Hono.** fxTikTok uses it, but our router does custom path analysis with ambiguity
detection and reserved-token handling — Hono's routing model does not express that, so it would
be a runtime dependency we route around. A plain `fetch()` handler plus our own router is
smaller and clearer.

**No Rust/Go/Python, and not by default.** The workload is ~99% network wait: fetch (~300ms),
parse (~1ms), render (~1ms). A faster language optimizes ~0.5% of the request while adding a
WASM toolchain and a JS↔WASM marshalling boundary. Throughput here is decided by network
latency and cache hit rate, both language-independent. Workers *is* a V8 runtime, so JS/TS is
the native path; Rust and Go reach it through WASM (TinyGo support is poor), and Python through
Pyodide, with bigger bundles and worse cold starts. Another language would only have won inside
a container — Go with uTLS is genuinely the right tool for TLS fingerprinting — and the
Instagram finding deleted the container.

**No containers, no VPC, no proxy.** Every request is one stateless Worker. This is what the
Instagram and Threads probes bought: the conventional design needs a container for TLS
impersonation and a proxy for non-datacenter egress, and both proved unnecessary. The TikTok
offload is deleted, not relocated.

## Audience

"Private" means **unannounced**, not gated. There is no auth, no allowlist, no unlisted
mechanism — the domain is already publicly routed and always will be. The design targets
public scale (caching, no open-proxy surface, no identifying logs) so that going public later
is a social decision, not an engineering one.

## Architecture

One normalized `Post`, one renderer.

```
request
  → classify                        UA → client class
  → route                           path → Route (union)
      ├── site        → env.ASSETS
      ├── notfound    → render(failure)      404 (no platform, no canonical)
      ├── ambiguous   → render(ambiguous)    chooser (human) | error embed (crawler)
      ├── media       → Post cache read → 302 to CDN, Cache-Control: max-age=300
      └── post
            ├── client = human → 302 to canonical          (no fetch — router knows it)
            └── crawler
                  → response cache hit? → return
                  → post cache hit? → render
                  → fetch (I/O) → normalize (pure) → cache Post → render (pure) → cache response
```

The human path never fetches: the router already knows `canonical`, so a human gets an
immediate 302. Only crawlers cost upstream requests.

Every platform module does exactly one job: fetch and normalize into a common shape.

```ts
type Platform = 'x' | 'tt' | 'ig' | 'th' | 'rd' | 'bs'

type Media = {
  kind: 'image' | 'video' | 'gif'
  url: string          // origin CDN URL as of this Post's fetch — may be signed and expiring;
                       // staleness is bounded by the Post cache TTL. See Media.
  w: number
  h: number
  duration?: number
  alt?: string
}

type Post = {
  ref: PostRef                      // identity AND platform — use ref.p; there is no
                                    // separate `platform` field, so the two cannot disagree
  canonical: string                 // original URL — the human redirect target
  author: {
    name: string
    handle: string
    url: string
    // CDN URL as of this Post's fetch — same staleness bound as Media.url.
    // Renderers MUST emit /_media/{refKey}/avatar, never this value directly.
    avatar?: string
  }
  text: string
  createdAt: Date
  media: Media[]
  counts: { likes?: number; reposts?: number; replies?: number; views?: number }
  quote?: Post                      // depth-limited to 1 — see below
  replyTo?: Post                    // depth-limited to 1
  sensitive: boolean
}
```

**Quote/reply depth is exactly 1.** `post.quote.quote` is always `undefined`. Unbounded
recursion means unbounded fetches per request; FxEmbed's answer is 1 and it is sufficient —
Discord has no room to render deeper.

Everything downstream is written **once**: the Discord renderer, the Telegram renderer, the
human redirect, the chooser, the error path. Adding platform #7 is a fetcher and a
normalizer, not another embed template.

Only fetchers do I/O. Normalizers and renderers are pure functions — the same modular,
portable core the rest of the tool family uses, testable without a network.

```
fxeverything/
├── src/
│   ├── index.ts              # Hono app; wires the pipeline
│   ├── classify.ts           # User-Agent → ClientClass
│   ├── router.ts             # path → Route
│   ├── cache.ts              # two-layer Cache API
│   ├── media.ts              # /_media/* → Post-cache read → 302
│   ├── platforms/
│   │   ├── x/{fetch,normalize}.ts
│   │   ├── bluesky/{fetch,normalize}.ts
│   │   ├── tiktok/{fetch,normalize}.ts
│   │   ├── instagram/{fetch,normalize}.ts
│   │   ├── threads/{fetch,normalize}.ts
│   │   └── reddit/{fetch,normalize}.ts
│   └── render/
│       ├── index.ts          # render(Outcome, ClientClass) → Response
│       ├── discord.ts        # plain og tags; Mastodon spoof evaluated in Phase 2
│       ├── telegram.ts       # og tags; never meta-refresh
│       ├── chooser.ts        # ambiguous-path interstitial (humans)
│       └── fail.ts           # error embed (crawler) | 302 (human)
├── vendor/                   # pinned read-only upstream refs; NOT compiled
├── public/
│   ├── index.html            # converter + docs, single file
│   ├── favicon.ico
│   └── robots.txt            # disallow all
├── test/                     # node:test
└── wrangler.jsonc
```

### Render input is a union

`render` never assumes a `Post` — the ambiguous path never resolved to one and the failure
path never got one.

```ts
type Outcome =
  | { kind: 'post';      post: Post }
  | { kind: 'ambiguous'; path: string; candidates: Platform[] }
  | { kind: 'failure';   canonical: string | null; platform: Platform | null; reason: string }

render(outcome: Outcome, client: ClientClass): Response
```

`platform` and `canonical` are both nullable: a `notfound` is a `failure` with neither. The
five `Route` kinds collapse to three `Outcome` kinds by construction — `site` is served by
ASSETS and `media` 302s, so neither reaches `render`; `notfound`, `ambiguous`, and `post` do.

`fail(canonical: string | null, platform: Platform | null, reason: string)` constructs the
failure case; its signature matches the union exactly.

## Upstream integration

**We port, we do not vendor-and-edit.** The earlier plan ("tracked subtree, never
hand-edited") is incoherent: TikTok requires deleting the offload, generating our own device
IDs, dropping `node_compat`, and swapping Redis for Cache API, and X requires adding a
syndication fallback upstream does not have. Those are edits. A subtree you edit cannot be
`git subtree pull`ed.

Instead:

- `vendor/fxembed` and `vendor/fxtiktok` are **git submodules pinned to a commit, read-only,
  and not compiled into the Worker.** They exist to diff against.
- `src/platforms/*/fetch.ts` is **our code**, ported from the pinned commit. Each file's
  header names the upstream path and commit it was ported from.
- `npm run check-upstream` diffs the pinned commit against upstream `HEAD` for **only** the
  files we ported, and prints what changed. This is how we learn X's GraphQL query IDs or
  feature flags moved.
- Resync is a deliberate act: read the diff, port the delta, bump the pin.

This trades automatic merges for honesty. We never pretend an edited fork is rebasable, and
we never lose sight of upstream.

## Routing

**Primary contract: wholesale root replacement.** Replace the social domain with
`megapenispoopenfarten.sex`, keep the path.

```
x.com/user/status/123          →  megapenispoopenfarten.sex/user/status/123
tiktok.com/@user/video/123     →  megapenispoopenfarten.sex/@user/video/123
instagram.com/p/ABC            →  megapenispoopenfarten.sex/p/ABC
reddit.com/r/aww/comments/…    →  megapenispoopenfarten.sex/r/aww/comments/…
bsky.app/profile/h/post/rkey   →  megapenispoopenfarten.sex/profile/h/post/rkey
```

This works because **post permalinks are disjoint** across these six platforms. The
disjointness rests on one verified mechanism and one standing condition:

**The depth rule.** Instagram **404s at depth 3**, but at depth 2 it has a *permissive
fallback* — `/{user}/{anything}` renders that user's profile rather than 404ing. Therefore:

- **Depth ≥3 is unconditionally safe.** Instagram cannot shadow it.
- **Depth 2 is safe only while segment 1 is not a live Instagram username.** This is a
  condition on a namespace we do not control, and it can be revoked by a stranger signing up.

| Path shape | Platform | Depth | Basis |
|---|---|---|---|
| `/{handle}/status/{id}`, `/i/status/{id}`, `/i/web/status/{id}` | X | 3+ | Safe by depth rule |
| `/@{user}/video/{id}`, `/@{user}/photo/{id}` | TikTok | 3 | Safe by depth rule; `@` also a clean marker (`reddit.com/@spez` 404s) |
| `/@{user}/post/{code}` | Threads | 3 | Safe by depth rule; segment 2 is `post` vs TikTok's `video`/`photo` |
| `/stories/{u}/{id}` | Instagram | 3 | Instagram's own |
| `/r/{sub}/comments/{id}/…`, `/r/{sub}/s/{code}` | Reddit | 4+ | Safe by depth rule |
| `/profile/{handle}/post/{rkey}`, `/starter-pack/{h}/{rkey}` | Bluesky | 4 / 3 | Safe by depth rule; from their open-source route table |
| `/p/{code}`, `/reel/{code}`, `/reels/{code}`, `/tv/{code}` | Instagram | 2 | Instagram's own routes — segment-1 shadowing is moot |
| `/comments/{id}` | Reddit | 2 | **Conditional but verified** — `@comments` is not a live IG account (checked 2026-07-17 against known-live `@gallery`/`@i` controls) |

`/t/{code}` is **contested between TikTok and Threads** and is resolved by probe, not by
guess — see below.

### `/t/{code}` — resolved, not guessed

Both TikTok and Threads mint `/t/{code}` short links. The code namespaces are different but we
do not rely on shape heuristics. Both platforms resolve a `/t/` code by redirect and both fail
detectably, so we **ask both and keep whichever answers**:

- TikTok: `www.tiktok.com/t/{code}` → 302 to the canonical video URL.
- Threads: `www.threads.com/t/{code}` → 301 to canonical when valid. **Invalid returns HTTP 200
  — a soft-404.** Check for `EmbedContainer` in `/t/{code}/embed` (~47KB present vs ~39KB
  absent), never the status code. This is the same assert-on-content rule Instagram forces.

Exactly one answering → that platform. Neither → `ambiguous`. Both → `ambiguous` (not observed;
the namespaces appear disjoint, but we do not assume it). Two subrequests, **cached
indefinitely** — a short code never re-targets.

This is resolution, not heuristic: we get the answer from the platforms themselves rather than
inferring it from the string. `/tt/t/{code}` and `/th/t/{code}` force the issue if ever needed.

In practice every real-world Threads link found during research was `/@{user}/post/{code}`;
Threads' `/t/` form appears mainly in its own oEmbed output. TikTok's `/t/` is common. But
frequency is not a routing rule, so we probe.

`/gallery/{id}` is **not** in this table: `@gallery` is a live Instagram account, so it is
ambiguous. See the ambiguity table.

Conditional rows are monitored, not trusted. If one flips, its escape-hatch prefix is the
recovery path and the change is a doc edit, not a redesign.

Subdomains survive the swap and are used as free hints:
`vm.tiktok.com/ZS1abc` → `vm.megapenispoopenfarten.sex/ZS1abc` still identifies TikTok. This
requires our wildcard route (see Deployment).

### Route type

`{platform, id}` is insufficient — Bluesky needs handle **and** rkey, Instagram stories need
user **and** id, Reddit comments carry a sub.

```ts
// Per-platform identity. Every field needed to both fetch the post and rebuild its
// canonical URL. Not optional — each platform's ref shape is fixed.
type PostRef =
  | { p: 'x';  id: string }                        // status id
  | { p: 'tt'; id: string }                        // video id (short codes resolve to this first)
  | { p: 'ig'; kind: 'p' | 'reel' | 'tv'; code: string }
  | { p: 'ig'; kind: 'story'; user: string; id: string }
  | { p: 'th'; code: string }                      // no user field — Threads ignores it entirely
  | { p: 'rd'; sub: string; id: string }
  | { p: 'bs'; handle: string; rkey: string }

type Route =
  | { kind: 'site';      path: string }
  | { kind: 'media';     ref: PostRef; index: number | 'avatar' }
  | { kind: 'post';      ref: PostRef; canonical: string }
  | { kind: 'ambiguous'; path: string; candidates: Platform[] }
  | { kind: 'notfound' }
```

**`refKey(ref)` is the cache and media-URL identity.** It is a deterministic, ordered
serialization of the ref's own fields — never the raw path:

```
x:123456                    tt:7660566211100511518
ig:p:BsOGulcndj-            ig:story:someuser:987
rd:aww:abc123               bs:alice.bsky.social:3k2a
```

Consequences this buys:

- `/p/ABC` and `/ig/p/ABC` produce the same key — one cache entry.
- `?igshid=…` and other tracking params cannot cause a miss; they are not in the ref.
- **Short links resolve before keying.** `/t/{code}` and `/@user/video/123` are the same post,
  so `/t/{code}` is resolved *first* and both yield `tt:{id}`. A `/t/` code that resolves to
  Threads instead yields `th:{code}`. Resolution is
  one request to the host named in the URL, cached indefinitely (a short code never
  re-targets).
- The media URL is `/_media/{refKey}/{index}`, so it carries every field — Bluesky and
  Instagram stories are addressable. A path-shaped `/_media/{platform}/{id}/{index}` would
  have re-introduced exactly the bug `PostRef` exists to fix.

**`canonical` for a short link is the reconstructed short URL** (`https://vm.tiktok.com/ZS1abc`),
not the expanded one — the human gets sent where they expected to go. This is why the human
path can still 302 without fetching: the router rebuilds `canonical` from the request alone.

### Reserved root tokens

These shadow same-named profiles at the root. Accepted and documented:

`x`, `tt`, `ig`, `th`, `rd`, `bs` (escape hatches), `_media`, `_alt`, and the site paths below.

`/ig` will not reach an X or Instagram account literally named "ig"; use `/x/ig` or `/ig/ig`.
This is the cost of having escape hatches at all, and it is cheap.

**If the Mastodon spoof wins Open question #1**, Discord will call `/api/v1/statuses/:id` on
our domain, and the spoof advertises a `/users/…` URL as a decoy. Both `api` and `users` must
then join this list. The reserved namespace is therefore **not final until OQ#1 is settled** —
do not treat this list as closed.

### Escape-hatch prefixes

`/x/`, `/tt/`, `/ig/`, `/rd/`, `/bs/` force a platform explicitly. (`/rd` not `/r`, so Reddit
links don't become `/r/r/aww/…`.) These are the stable fallback for ambiguity and the recovery
path when a namespace collision appears.

### Known ambiguity — never guessed

These path shapes are genuinely undecidable and must **not** be resolved by heuristic:

| Path | Collides between | Note |
|---|---|---|
| `/{username}` | X ↔ Instagram | Bare profile |
| `/hashtag/{tag}` | X ↔ Bluesky | A real, shared content URL |
| `/{name}/followers`, `/{name}/following` | X ↔ Instagram | |
| `/search`, `/explore` | up to 4-way | |
| `/messages`, `/notifications`, `/settings/*` | X ↔ Bluesky ↔ Reddit | |
| `/i/lists`, `/i/bookmarks`, `/i/moments` | X ↔ Instagram | `@i` is a real IG account |
| `/gallery/{id}` | Reddit ↔ Instagram | `@gallery` is a real IG account — a **content** URL we therefore cannot serve at the root |

Note the shape of the last row: it is a depth-2 Reddit permalink defeated by a live Instagram
username. It is the worked example of the depth rule's standing condition, and the reason
`/comments/{id}` needs verifying before it is trusted. Reach it via `/rd/gallery/{id}`.

Behaviour: **humans** get a chooser interstitial; **crawlers** get an error embed. Little is
lost — profile and hashtag links do not embed richly on any platform.

Two rejected resolutions, and why:

- **Probe-both is unimplementable.** X returns HTTP 200 with an SPA shell for *every* path,
  including garbage, and 404s all crawler UAs. X handle existence cannot be determined
  server-side.
- **The charset heuristic is one-directional.** X handles are `[A-Za-z0-9_]{1,15}`, a strict
  subset of Instagram's `[a-z0-9._]{1,30}`. A dot or >15 chars proves *not-X*; nothing ever
  proves *X*.

**Short links.** `vm.`/`vt.tiktok.com` work (subdomain survives). `redd.it`, `t.co`, and
`instagr.am` do not — replacing the whole domain leaves a bare opaque code indistinguishable
from a username. `t.co` shortens all outbound links, not just X posts, so replacing it is
incoherent in principle. Documented as unsupported; use the escape-hatch prefix.

**Standing risk:** root routing's correctness depends on a namespace we do not control — but
the depth rule bounds it precisely. Depth ≥3 permalinks are unconditionally safe; no
Instagram signup can shadow them. The exposure is exactly the two **conditional depth-2 rows**
(`/comments/{id}`): if `@comments` is ever registered, that path becomes ambiguous. (`/t/{code}`
is contested between TikTok and Threads and is probe-resolved, so an `@t` signup would add a
third claimant to a path that is already resolved rather than guessed.) `/gallery/{id}` is what this looks like when it has already happened.

Deliberately accepted — the prefixes exist precisely so that recovery is a documentation
change, not a redesign.

## Client classification

Matching is **lowercased substring, ordered, first match wins**.

| Order | Class | Detection | Gets |
|---|---|---|---|
| 1 | `discord` | `discordbot` | Discord embed markup |
| 2 | `telegram` | `telegrambot` | Telegram markup; **never** `meta http-equiv=refresh` |
| 3 | `other-bot` | `facebookexternalhit`, `slackbot`, `whatsapp`, or `/bot\|crawler\|spider\|preview/` | og tags |
| 4 | `human` | everything else | 302 to `canonical` |

**There is deliberately no `discord-media` class.** Discord's media proxy sends a fake browser
UA (`…Firefox/38.0`), and FxEmbed hardcodes `firefox/38|firefox/92|chrome/96.0.4664.110` to
catch it. Adopting that would misclassify a real human on Chrome 96 as a bot and deny them the
redirect. We avoid the problem structurally instead: **every media reference in an embed is a
`/_media/*` URL, and `/_media/*` behaves identically for all client classes** (Post-cache read
→ 302), so there is nothing to distinguish.

Three conditions keep that true. All three are invariants, not conveniences:

1. **Every media reference is `/_media/*`** — including `author.avatar`, which is why the media
   route's index accepts the literal `avatar` alongside numeric positions. An avatar emitted as
   a raw CDN URL would be both a non-`/_media/` proxy hit and a signed URL that expires.
2. **`twitter:image content="0"` is emitted absolute** (`/_alt/0`), not bare — see Discord
   rendering.
3. **Media is never served at an embed URL.** If those routes ever merge, this reasoning
   collapses and the media-proxy UA problem returns. Do not merge them.

`/favicon.ico` is exempt: it is allowlisted and served by ASSETS to every class.

**Telegram hangs on `<meta http-equiv="refresh">`** — the human-redirect mechanism must be
suppressed for `telegram`.

## Site

`/` serves the converter: paste a URL, get the fixed link with a copy button; the
find-replace table sits below as docs. Single `public/index.html`, inline `<style>` + one
vanilla-JS IIFE, no build step — the `cheer-splitter-9k` / `receipt-wrecker` pattern.

**The converter emits root-replaced URLs**, matching the primary contract. It emits a
prefixed URL only when the input is one of the known-ambiguous shapes, in which case it shows
both options and says why.

**Asset precedence.** The router owns the root namespace, so static assets cannot be allowed
to answer greedily. `wrangler.jsonc` sets `assets.run_worker_first = true` and
`assets.not_found_handling = "none"`. The Worker matches an explicit reserved allowlist and
delegates only those to `env.ASSETS`:

| Path | File |
|---|---|
| `/` | `public/index.html` |
| `/index.html` | `public/index.html` — allowlisted explicitly, or it falls through to the router and hits the bare-profile shape |
| `/favicon.ico` | `public/favicon.ico` |
| `/robots.txt` | `public/robots.txt` |

Four paths, **three files**. All three must exist by cutover (Phase 3) — with
`not_found_handling = "none"` a missing one 404s rather than falling back. Everything else goes
to the router. No other site paths exist: the page is one file with inlined CSS and JS
specifically so this list stays this short.

`robots.txt` disallows everything. We have nothing to gain from indexing and no wish to appear
in search results for other people's content.

## Platforms

| Platform | Mechanism | Fragility |
|---|---|---|
| X | Own port of FxEmbed's fetcher. `TweetResultByRestId` — **not** `TweetDetail` | Low-med |
| Bluesky | Own port of FxEmbed's fetcher. Public AT Protocol, no auth | Low |
| TikTok | Own port of fxTikTok's fetcher, offload deleted, own device IDs | High |
| Instagram | Own. Plain `fetch()` + crawler UA → `/p/{code}/embed/captioned/` | High |
| Threads | Own. Plain `fetch()` + crawler UA → `/t/{code}/embed` | High — but verified from Workers egress |
| Reddit | Own. Registered OAuth script app | **Unknown** — not covered by recon |

### X

Guest token + the public web bearer. Use `TweetResultByRestId`; cobalt's `TweetDetail` query
id currently 404s for guests.

Add a **syndication fallback** that FxEmbed does not have:
`cdn.syndication.twimg.com/tweet-result?id=…&token=…`, where
`token = ((id / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')` — verified live. It
returns SFW posts at full fidelity with no credentials, so it is a cheap second source when
the guest GraphQL path breaks.

**Sensitive media requires credentials — there is no bypass.** Verified empirically against a
confirmed age-restricted tweet: both the guest GraphQL path and syndication return
`TweetTombstone` with no media, while an SFW control returned full video variants on the same
token at the same instant. cobalt hits the identical wall and says so in its own error string
(`"this post is age-restricted, so i can't access it anonymously"`); FxEmbed escalates to a
credential pool on the same `NsfwLoggedOut` sentinel.

We build the seam (detect `NsfwLoggedOut` → escalate hook) and ship with zero accounts. Until
accounts exist, an age-restricted X post is an `Outcome.failure` with reason `age-restricted`:
the crawler gets an error embed saying so, the human gets a 302 to the real post. It cannot
degrade to "text without media" — a tombstone carries no text either. No rearchitecting is
needed to change this later; supplying accounts turns the same posts into ordinary successes.

### Instagram

**Plain Worker `fetch()` with a crawler User-Agent.** No container, no TLS impersonation, no
proxy.

The widely-repeated belief that Instagram gates on TLS/JA3 fingerprint is **false**. The gate
is the User-Agent, and it works the opposite way to expectation: claim to be a browser and
Instagram assumes you have JS and serves a large empty shell; claim to be a crawler and it
serves the content server-rendered. OGInstagram's source documents this (`config.go:62`:
*"embedUA is intentionally non-browser… a modern Chrome UA gets an empty JS shell"*).

Verified from **actual Cloudflare Workers egress** (IPv6 `2a06:98c0:3600::103`) on 2026-07-16,
against `/p/BsOGulcndj-/embed/captioned/`:

| UA | Bytes | `contextJSON` | Media | Verdict |
|---|---|---|---|---|
| `facebookexternalhit/1.1` | 98,682 | yes | 8 | REAL |
| `Discordbot/2.0` | 98,728 | yes | 8 | REAL |
| `curl/8.4.0` | 98,663 | yes | 8 | REAL |
| `Chrome/122` | 599,264 | no | 0 | DECOY |

`curl/8.4.0` succeeding is the decisive row: the least browser-like TLS fingerprint available
gets the real content. Cloudflare datacenter egress is **not** IP-penalized. Latency ~300ms.

This is why InstaFix died: its `curl_cffi` sidecar impersonates Chrome — the exact UA class
that gets served the decoy — and it is pinned to a stale `doc_id`.

**Non-negotiable: assert on content, never on status.** The decoy is `HTTP 200`. The fetcher
must require `contextJSON` present, caption non-empty, and ≥1 `display_url`, and fail
otherwise.

### TikTok

Port the fetcher from `okdargy/fxTikTok` (hono-rewrite). Required changes:

- **Delete the offload.** It is a billing hack, not an egress workaround: the introducing
  commit (`0c3bb25`) is titled *"chore: offload server for exceeding free tier"* and its diff
  is a rename of `BASE_URL` → `OFF_LOAD`. It exists to stay under the **free** plan's 100k/day
  request cap. We are on Paid, which has no request cap, so it solves a problem we do not have.

  **It does not proxy bytes** — verified 2026-07-16: `offload.tnktok.com/generate/video/{id}.mp4`
  returns a `302` to `v16m-default.tiktokcdn-us.com/...`, so video flows TikTok → Discord and
  never touches dargy's box. The cost of leaving it in place is therefore *not* his bandwidth;
  it is (a) a hard dependency on a third party's uptime for our video to work at all — upstream
  issues #32, #38, #51 are all offload downtime — and (b) a hostname a stranger controls sitting
  in the middle of our embeds. Worker egress mints working signed CDN URLs directly (verified:
  206 + real `ftypisom` bytes), so deleting it costs nothing and removes both.
- **Generate our own device IDs.** Upstream's `iid`/`device_id` are hardcoded and shared by
  every deployment on earth; we would inherit everyone's rate-limit blast radius.
- Target current `compatibility_date`; no `node_compat`.
- Cache via Cache API, not upstream's Redis shim. (That shim stubs `get()` to `null`, so
  upstream's Worker path currently runs uncached.)
- Workers Analytics, not `prom-client`.

**TikTok CDN URLs are signed and expire.** This is why media is a route, not a baked-in URL —
see Media.

### Threads

**Plain Worker `fetch()` with a crawler User-Agent** against `www.threads.com/t/{code}/embed` —
the same gate as Instagram, same company, same inverted logic.

Verified **from Cloudflare Workers egress**, 2026-07-17, on `/t/DTI1vjIEi5y/embed`:

| UA | Bytes | `EmbedContainer` | text | mp4 | Verdict |
|---|---|---|---|---|---|
| `facebookexternalhit/1.1` | 48,805 | yes | yes | yes | REAL |
| `Discordbot/2.0` | 48,805 | yes | yes | yes | REAL |
| `curl/8.4.0` | 48,799 | yes | yes | yes | REAL |
| `Chrome/122` | 259,884 | no | no | no | **DECOY** |

A second code (`CuP48CiS5sx`, a text post) reproduced the same split. Matches the residential
result, so Threads — like Instagram — does not penalize Cloudflare egress.

**Threads is the most broken of the six, and deliberately so.** It UA-sniffs the *bare* post URL
three ways:

- `facebookexternalhit` → real `og:description`, real `og:image`. No `og:video`.
- **`Discordbot` → `og:title` and a Meta-generated 1200×600 card JPEG, and no `og:description`
  at all.** Post text is withheld from Discord specifically, then handed back as *pixels* — the
  text is baked into the image, light-mode only, engagement counts clipped mid-render.
- `Chrome` → zero og tags.

So natively, Discord shows a picture of the text instead of the text. Never selectable, never
dark-mode aware. Additionally `og:video` is absent for **every** UA (the bare page contains no
video data at all — no `video_versions`, no `.mp4`), and carousels emit 1 `og:image` out of 20.

`/t/{code}/embed` fixes all three in one fetch: real text, the mp4, and all 20 images.

**No `/embed/captioned/`** — that is Instagram-only; Threads 404s it. Use `/embed`.

**The username is ignored.** `/@notarealuser/post/{code}/embed` returns the right post. Hence
`PostRef = { p: 'th', code }` with no user field, and `/t/{code}/embed` as the canonical fetch
form. Threads is the simplest ref of the six.

Parse targets: `.BodyTextContainer` → text; `<source src>` → mp4; `<img src="https://scontent…">`
minus `s100x100`/`s150x150` (those are avatars) → images; `.Timestamp`; `.UsernameText`;
`.ActionBarCount`. Media URLs are signed (`oh=`/`oe=`) and expiring — truncating one returns
`Bad URL hash` — so they must go through `/_media/` like every other platform.

**Slug forms:** `/@{user}/post/{code}/{slug}` is a valid link but `/{slug}/embed` **404s**.
Strip the slug before building the embed URL.

Existing Threads fixers are mostly dead: `fixthreads.net` is NXDOMAIN, `vxthreads.net` resolves
but refuses connections, `viewthreads.com` is alive but naive (empty `og:description`; it just
re-serves Meta's generated card). `milanmdev/fixthreads` is alive on plaintext HTTP at
`drhong.ddns.net:9813` and extracts correctly, but its oEmbed link points at the dead
fixthreads.net. Reference only; we vendor none of them.

`graph.threads.net/oembed?url=…` returns real oEmbed JSON with no auth token — useful for
author and permalink, but it yields blockquote HTML, not media URLs, so it does not fix video.

### Reddit

Registered OAuth script app. A registered app is free, documented, and sanctioned.

**The anonymous path is confirmed dead from Workers egress** — verified 2026-07-17: both
`reddit.com/r/{sub}/comments/{id}/.json` and `reddit.com/r/{sub}/.json` return **HTTP 403 with a
"Blocked" HTML page**, on every UA tried (Discordbot and a custom script UA). `oauth.reddit.com`
without credentials likewise refuses. So OAuth is not a preference, it is the only way in.

**Still unverified:** whether a *registered* app authenticates and reads successfully from
Workers egress. That needs an app registered against the user's Reddit account, so it cannot be
settled without them. Phase 5 registers the app and tests it **before** any Reddit code is
written. If it fails, Reddit drops; nothing else depends on it.

### Bluesky

Public AT Protocol. No auth, no anti-bot, no rate wall. The one non-adversarial platform —
which is why it is the end-to-end proof in Phase 1.

### `sensitive`

| Platform | Source | Notes |
|---|---|---|
| X | `possibly_sensitive` on a **successfully fetched** post | see below |
| Reddit | `over_18` | |
| Bluesky | label values on the record | |
| Instagram, TikTok, Threads | not exposed — always `false` | |

**`NsfwLoggedOut` is not a `sensitive` source — it is a fetch failure.** A tombstoned X post
returns no media, no author, no text, and no counts, so it never becomes a `Post` at all; it
becomes `Outcome.failure` with reason `age-restricted`. Once accounts are supplied, the same
post fetches successfully and *then* carries `possibly_sensitive: true`.

This corrects a claim made elsewhere in earlier drafts: "sensitive posts render text without
media" is **not** achievable via the guest path — there is no text to render.

Renderers surface `sensitive` as a text marker only. Discord has no spoiler mechanism for
embed media, so it cannot be enforced; do not imply otherwise in the UI.

## Media

**Media is a route, not a baked-in URL.** Every media reference in an embed points at
`/_media/{refKey}/{index}` on our domain (`index` is a 0-based position in `media[]`, or the
literal `avatar`). On hit, `media.ts` **reads the Post cache**, takes the URL, and **302s** to
it.

Why the indirection rather than the CDN URL straight in the og tag:

- **TikTok's and Instagram's CDN URLs are signed and expire.** A cached embed would outlive the
  URL inside it and render a dead image. A stable local URL with one resolution point fixes it.
- It keeps the classifier simple (see Client classification).

This design is not novel — it is what `InstaFix-Revived` does, and its comment states the
rationale exactly: *"Offload resolves a stable local media URL to the current Instagram CDN
URL. This keeps embed HTML stable and gives us one place to refresh cached scrape data before
redirecting bots to image/video bytes."* (`handlers/offload.go:14`). We follow its proven
shape, including the details below.

**`/_media/` reads the Post cache; it does not re-fetch per image.** This is load-bearing. A
Discord embed of an 8-image Instagram carousel triggers 8 media hits; re-resolving upstream on
each would mean 8 Instagram fetches per viewing client, on the platform we rate most fragile.
InstaFix-Revived reads its cache (`scraper.GetDataPreferVideo(postID)`) and refreshes only on
miss/stale. So do we: `/_media/` is a **Post-cache read**, and only a miss costs upstream.

**The 302 carries `Cache-Control: public, max-age=300`** (InstaFix-Revived's value), so
Discord's media proxy and the edge stop re-asking. This bounds media load independently of the
Post cache.

**The staleness window is real and bounded.** A cached `Post` holds CDN URLs up to its TTL old,
and the 302 we emit is itself cacheable for another 300s. So the oldest signature a client can
be using is **Post TTL + 300s = 20 minutes**, not 15. That sum — not the Post TTL alone — must
stay below the shortest CDN signature lifetime. **Verify TikTok's and Instagram's signature
TTLs during Phases 3/4 and lower the Post TTL if either is under 20 minutes.**

Index `avatar` resolves to `post.author.avatar`; numeric indices are 0-based positions in
`post.media[]`.

`Media.url` is documented as "the CDN URL as of the Post's fetch" — **not** "resolved fresh."
It is a cached value with a known staleness bound, and pretending otherwise is what makes this
subtle.

### Bytes: 302 by default, proxy only where forced

Default is **302, never proxy**. Worker egress is free; proxying invents a bandwidth bill and
walks into an unresolved ToS question — Cloudflare's Service-Specific Terms name the Developer
Platform as a Paid Service required for serving video, while the video-delivery policy page
names only Stream and never mentions Workers. The two docs contradict each other.

**But "never" is too strong, and the evidence says so.** InstaFix-Revived proxies video bytes
specifically for preview bots (`proxyOffloadVideo` when `isPreviewMediaBot`) — implying
Discord's media proxy will not play some videos from a redirect alone. fxTikTok's
`/generate/video/:id` mostly 302s (it re-emits the CDN's `Location` on 3xx) and proxies only in
the non-3xx branch.

Rule: **302 first. If a platform's video demonstrably will not play inline from a 302, proxy
that platform's video only, and record why.** Measure per platform in its phase; do not adopt
proxying globally or reject it dogmatically. Images are always 302.

### Discord rendering

From FxEmbed's hard-won behaviour:

- Lie about dimensions: halve if >1920 (Discord drops 4K), double if both <400 (Discord
  postage-stamps low-res).
- `twitter:image content="0"` suppresses the still so the player shows. **Emit this as an
  absolute URL** (`https://megapenispoopenfarten.sex/_alt/0`), never the bare string `0` — a
  relative `0` resolves against our origin to `/0`, which matches the bare-`/{username}` shape
  and would serve a chooser interstitial plus a bogus `ambiguous` datapoint on every video
  embed. `_alt` is reserved and returns 404 with no body.
- Discord's folklore limits (9500×9500, ~73MiB) come from a single self-disclaimed 2023 report
  closed as fixed the same day. Do not design against them.

**Plain `og:video` works for Discord in 2026 — verified.** `tnktok.com` emits plain
`og:video` and embeds correctly (confirmed live 2026-07-16 on
`tnktok.com/t/ZTSw2mYwR/`). So the Mastodon spoof is **not** needed for single-video embeds.
Open question #1 narrows to: is the spoof needed for *rich text plus multi-media* in one
embed? Ship plain og tags first; treat the spoof as a Phase-2 enhancement, not a prerequisite.

## Caching

Two layers, because they have different keys and different lifetimes.

| Layer | Key | Value | TTL |
|---|---|---|---|
| Post | `post:{refKey(ref)}` | serialized `Post` | 15 min |
| Response | `resp:{refKey(ref)}:{client}` | rendered `Response` | 15 min |

Both use `refKey(ref)` — the same function `/_media/` uses to address a post. They **must** key
identically, or a media hit would miss the Post entry the embed was rendered from. `refKey`
already embeds the platform (`tt:123`, `ig:p:ABC`), so no separate platform argument exists.

The Post layer is **shared across client classes**, so one upstream fetch serves Discord,
Telegram, and every other bot. Keying only the response layer on client class is what stops
class from multiplying upstream load.

Keys derive from `refKey(ref)` — **never the raw path**. So `/p/ABC` and `/ig/p/ABC` share an
entry, and `?igshid=…` tracking params cannot cause a miss.

**Do not `Vary: User-Agent`.** UA cardinality is unbounded — the hit rate would be ~0%.
Client class lives in the key instead. Same correctness, actually caches.

**The Cache API is a no-op on `workers.dev`.** Only the custom domain caches. Fine — that's
where it lives. Cache API is also best-effort and may evict at any time; everything cached
here is re-derivable, and nothing depends on a hit.

## Credentials

| Secret | Storage | Notes |
|---|---|---|
| Reddit client id / secret | `wrangler secret` | static |
| Reddit bearer token | Cache API, TTL 55 min | expires ~1h; re-fetch on miss |
| X guest token | Cache API, TTL 2h | rotates; re-fetch on miss |
| X account pool | `wrangler secret`, AES-GCM bundle | **empty day one**; FxEmbed's format |

No KV binding is required — every cached credential is re-derivable on miss, which is exactly
what Cache API's best-effort semantics allow.

## Error handling

One `fail(canonical, platform, reason)` used by every platform:

- **crawler** → error embed naming platform and reason (`"Instagram extraction failed — content assertion"`)
- **human** → 302 to `canonical`

Failures are loud to us and invisible to the person clicking. Never a blank card.

## Observability

The constraint: **log nothing identifying** (see Security), while still detecting silent
degradation. Reconciled by emitting counters with no identifiers.

Workers Analytics Engine, one datapoint per request:

| Field | Value |
|---|---|
| `blob1` | platform (`x`/`tt`/`ig`/`rd`/`bs`) |
| `blob2` | outcome (`ok`, `media_hit`, `media_miss`, `assert_fail`, `fetch_fail`, `age_restricted`, `ambiguous`, `notfound`) |
| `blob3` | client class |
| `double1` | `1` |

No URLs, no post IDs, no IPs, no user agents verbatim. Nothing here identifies a person or a
post.

**Alerts:**

- `assert_fail` rate > 10% of a platform's requests over 15 minutes. Not uptime — Instagram's
  decoy is `HTTP 200`, so a status-code check reads green while every embed is blank.
- `media_miss` / `media_hit` ratio climbing. `/_media/` is meant to be a Post-cache **read**; a
  rising miss rate means it is hitting upstream per image, which is the fetch-amplification
  failure the Media section exists to prevent. Invisible without this counter.

**Debugging without post IDs** is a deliberate trade. The counter tells you *which platform*
broke and *how*; you reproduce with a link you supply yourself. We accept slower debugging in
exchange for having nothing to leak.

## Security

- **Open-proxy defense:** suffix-anchored hostname allowlist, ported from FxEmbed's
  `isAllowedDomain()` — `h === allowed || h.endsWith('.' + allowed)`. It never parses IPs, so
  the IPv4-mapped-IPv6 SSRF class has no surface here.
- **Log nothing identifying.** The historically demonstrated way a fixer dies is not lawyers —
  it is logging. TwitFix (fxtwitter.com, May 2022) shut down over a public log of processed
  URLs and the harassment that followed, with zero legal contact from Twitter. For a service
  processing sensitive URLs, logging posture is the top risk. Say so publicly and verifiably.

## Testing

`node:test` for everything pure — which is most of it, by design.

| Target | How | Notes |
|---|---|---|
| Normalizers | fixture JSON → expected `Post` | pure |
| Renderers | `Outcome` → expected markup | pure |
| `classify.ts` | table-driven | includes ordering and the Chrome-96 non-collision |
| `router.ts` | real URLs → expected `Route` | plus an ambiguity table asserting `{kind:'ambiguous'}`, **never** a guess |
| `refKey()` | ref → expected key string | including `/t/{code}` and `/@u/video/{id}` collapsing to the same `tt:{id}` |
| Instagram assertion | the 599,264-byte decoy fixture must **fail** | guards the one silent failure mode |
| `cache.ts`, `index.ts` | `wrangler dev` smoke test | Cache API and Hono do not run under bare `node:test` |
| Fetchers | thin integration, network-allowed | the canary, not the safety net — expected to fail loudly when a platform changes |

## Licensing

Ported into our own code; upstream pinned read-only in `vendor/` for diffing.

| Source | License | Use |
|---|---|---|
| `FxEmbed/FxEmbed` | MIT | X + Bluesky fetch logic |
| `okdargy/fxTikTok` | MIT (+ appended attribution) | TikTok fetch logic |
| `Bl0ck154/InstaFix-Revived` | MIT | Instagram embed-tier approach; the `/offload/` media-route design |
| `seirenkr/OGInstagram` | MIT | Secondary Instagram reference; `config.go` documents the crawler-UA gate |

**On the Instagram lineage**, since it is easy to get wrong: `instagram7.com` runs
**InstaFix-Revived** (its homepage links `Bl0ck154/InstaFix-Revived` and `Wikidepia/InstaFix`,
and nothing else). Its media URLs point at `oginstagram.com` only because InstaFix-Revived's
own `/offload/{postID}/{mediaNum}` route takes a configurable `publicBaseURL` — the hostname
identifies the operator's media host, **not** the software. Do not infer the codebase from that
hostname; we did, and it was wrong.

Carry every notice, including fxTikTok's two copyright lines (dargy 2025, and dangered
wolf/FixTweet 2022-2024).

**Do not vendor:**

- `Kyrela/FixTweetBot` — MIT **+ Commons Clause**. Rebuilding the mapping facts is cheap, and
  vendoring would import a non-OSI clause constraining redistribution and monetization for no
  gain. The mapping *facts* are almost certainly not copyrightable; the regex route DSL and
  class structure are.
- `imputnet/cobalt` — **AGPL-3.0**, viral over the network; vendoring would copyleft this
  entire service. Its X approach informed this design; none of its code is used.
- `InstaFix-remote-scraper` and the unlicensed long tail (vxReddit, facebed, fixdeviantart,
  xfuraffinity) — all-rights-reserved, legally un-forkable.
- `Wikidepia/InstaFix` — MIT but **archived 2026-04**, with a stale `doc_id`. Superseded.

## Deployment

**Current domain state:** `megapenispoopenfarten.sex` routes entirely to the `fxtiktok`
worker — apex via custom domain, plus `*.megapenispoopenfarten.sex/*` via route. That wildcard
will ambush any new route on the zone.

**Routes fxeverything needs:**

- apex `megapenispoopenfarten.sex` (custom domain) — the primary contract
- `*.megapenispoopenfarten.sex/*` (route) — required for the `vm.`/`vt.` subdomain hints

Both currently belong to `fxtiktok`. The staging zone needs the same apex + wildcard shape, or
the subdomain-hint path cannot be tested at all.

**Sequencing:** keep `fxtiktok` live and untouched. Build on a staging subdomain on another
zone. Cut over in one move once the parity checklist passes — then move both routes to
`fxeverything` and unroute `fxtiktok` (the worker stays deployed; trivially reversible).

**Parity is an absolute checklist, not a comparison.** The current `fxtiktok` deploy does work
(verified — see Resolved), so a comparison gate is *possible*; it is still the wrong gate,
because matching it would mean matching a deploy whose `og:video` depends on a third party's
box. We are cutting over precisely to stop depending on it, so the target is correct behaviour,
not equivalent behaviour. Cut over only when all of these produce a correct
Discord embed on staging, with media served from our own `/_media/` route:

- a standard video post
- a photo/slideshow post
- a `vm.tiktok.com` short link (via the subdomain hint)
- a `/t/{code}` short link
- a deleted/invalid post → error embed for crawlers, 302 for humans

**Cost:** ~$5-6/mo — essentially the Workers Paid seat. Pure stateless Worker plus Cache API.
No containers, no KV, no bandwidth bill.

**Accepted risk:** this ships on the same Cloudflare account as the `uwutoowo.com` tools.
Workers is treated as content Cloudflare *hosts*, not pass-through CDN, so the "they forward
complaints upstream" shield does not apply and enforcement blast radius is undocumented. The
domain embeds no trademark, which is genuinely protective — but Meta *has* litigated this
naming pattern (`ddinstagram.com` appears as an accused domain in *Meta Platforms v.
Namecheap*). Decision made with this in view.

**`.sex` delivery:** not TLD-blocked. Not in HaGeZi's spam-TLD list; NSFW lists block `.sex`
domains individually, by submission. Expect gradual degradation on filtered networks over
time, not day-one failure. A neutral-TLD alias is worth planning before any public push —
the architecture already supports it (branding is not domain-coupled).

## Build order

This design is one architecture but more than one plan. Phases, each independently shippable
and each ending in something observably working:

1. **Skeleton + Bluesky, end to end.** `classify` → `router` → `cache` → `render/fail` →
   **a working Discord renderer with plain og tags** → `/_media/` route → Bluesky fetcher +
   normalizer. Bluesky is the only non-adversarial platform, so it proves the pipeline without
   fighting anyone, and it exercises the "platform #7 is just a fetcher + normalizer" claim at
   platform #1 rather than deferring it.
   **Exit:** a real Bluesky post renders a correct Discord embed on staging.
   *The Discord renderer and media route are in Phase 1, not Phase 2 — without them Phase 1 has
   no success path at all (the human path deliberately doesn't fetch), so it could only ever
   demonstrate failures.*
2. **Renderer depth.** Multi-media, quote/reply context, dimension lying, `/_alt/0`, Telegram
   renderer. The Mastodon spoof is evaluated here **as an enhancement** — plain `og:video` is
   already verified working (see Media), so this phase is about rich text + multi-media, not
   about whether embeds work at all.
3. **TikTok** + the parity checklist + cutover. Includes deleting the offload — note the
   current deploy's `og:video` points at `offload.tnktok.com`, so this phase is also what stops
   our video depending on dargy's box being up. Verify TikTok's CDN signature TTL against the
   Post TTL.
4. **Instagram + Threads + X.** Instagram and Threads share one mechanism (crawler UA → embed
   endpoint, assert on content), so they are one unit of work — Threads is genuinely close to
   free once Instagram's fetcher exists, and it is the platform whose embeds are worst today.
   X's credential seam lands here too. Also here: the `/t/{code}` TikTok-vs-Threads resolver, and
   verifying Instagram's and Threads' CDN signature TTLs. (Threads' Workers-egress viability is
   already settled — see Resolved.)
5. **Reddit + the site.** **First task: register a Reddit app and prove it authenticates from
   Workers egress** (OQ#2). Anonymous access is already confirmed dead, so if the registered app
   also fails, Reddit drops and only the site ships. No Reddit code before that check passes.

**The site lands in Phase 5 but cutover is Phase 3**, which would leave `/` 404ing on the
production apex in between. Phase 3 therefore ships all three `public/` files — a placeholder
`index.html`, plus `favicon.ico` and `robots.txt`, since `not_found_handling = "none"` makes a
missing one a hard 404. The *converter* is Phase 5; the files existing is Phase 3.

## Open questions

1. **Is the Mastodon spoof needed for rich text + multi-media?** Narrowed, not open in the
   original form: plain `og:video` **is verified working** for Discord in 2026 (`tnktok.com`
   emits it and embeds correctly — confirmed live 2026-07-16 on `tnktok.com/t/ZTSw2mYwR/`). So
   the spoof is not a prerequisite for embeds working at all. What remains unknown is whether
   rich text plus multiple media in one embed still requires it. FxEmbed switched on 2025-03-20
   (`<link rel="alternate" type="application/activity+json">`, after which Discord calls
   `/api/v1/statuses/:id` — not the advertised `/users/` URL, which is a decoy); InstaFix-Revived
   implements it too. **Evaluate in Phase 2 as an enhancement.** If adopted, `api` and `users`
   join the reserved root tokens.
2. **Does a *registered* Reddit app work from Workers egress?** Narrowed: the anonymous path is
   confirmed **dead** (HTTP 403 "Blocked" from Workers egress on every UA, verified 2026-07-17),
   so OAuth is mandatory. What remains needs an app registered against the user's Reddit
   account, so it cannot be settled without them. Register and test at the **start** of Phase 5,
   before any Reddit code exists.
3. **CDN signature TTLs for TikTok, Instagram, and Threads.** Post TTL (15 min) + the 302's
   `max-age=300` means a client can use a signature up to 20 minutes old. If any platform's
   signatures expire sooner than that, lower the Post TTL. Threads' are known to be signed
   (`oh=`/`oe=`; truncating one returns `Bad URL hash`). Measure in Phases 3 and 4.
4. **Does any platform's video refuse to play inline from a 302?** InstaFix-Revived proxies
   video bytes for preview bots, implying Discord's media proxy sometimes needs real bytes.
   Measure per platform; proxy only where forced (see Media).

None of the four blocks starting. Each is scoped to the phase that needs it.

**Resolved during design:**

- ~~Is the deployed `fxtiktok` working?~~ **Yes** — verified 2026-07-16 on
  `megapenispoopenfarten.sex/t/ZTSw2mYwR/`, byte-identical to `tnktok.com`. An earlier negative
  test used a genuinely dead video (TikTok's own oEmbed confirms). Note the deploy's `og:video`
  currently points at `offload.tnktok.com`, so our video today depends on a third party's box
  staying up and on a hostname we do not control. (It redirects rather than proxying, so this is
  a dependency and trust issue, not a bandwidth one.) Phase 3 ends it.
- ~~Does Instagram penalize Cloudflare Workers egress?~~ **No** — verified from Workers egress
  (see Instagram).
- ~~Does Threads serve the real embed to Workers egress?~~ **Yes** — verified 2026-07-17 from
  Workers egress; crawler UAs get the real embed with text + mp4, Chrome gets the decoy. Same
  split as residential (see Threads).
- ~~Is `@comments` a live Instagram account?~~ **No** — checked 2026-07-17 with known-live
  `@gallery`/`@i` as positive controls and a nonsense handle as a negative control. `@t`,
  `@profile`, and `@user` are also unregistered. So `/comments/{id}` routes to Reddit at the
  root. (The same check run from Workers egress returned 0 bytes for *every* handle including
  the controls — a broken test, not a finding. Worth knowing: Instagram serves profile pages
  differently to Cloudflare than it serves `/embed/captioned/`. We never fetch profile pages,
  so it does not affect the design.)
- ~~Is Reddit's anonymous `.json` usable?~~ **No** — HTTP 403 "Blocked" from Workers egress on
  every UA. OAuth is mandatory, not preferred.
