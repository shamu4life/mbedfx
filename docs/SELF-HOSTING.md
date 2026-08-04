« # Self-hosting mbedfx

**Status: nobody has done this.** There is no Node adapter, no Dockerfile for the Worker, no compose
file, and no instance of mbedfx running anywhere except Cloudflare Workers. Nothing below has been
run end to end off Cloudflare.

What this document *is*: an audit of how far the code already is, an honest statement of the one risk
that actually matters, and a phased plan. The audit found **no blockers**. That is a claim about the
code, not a demonstration, and every part of it is cited so the next person can check it rather than
trust it.

An earlier version of this project's notes said self-hosting was not achievable and the README
comparison table said "Workers only". That was wrong. The correction is the reason this file exists.

---

## 1. What is true today

### 1.1 The whole test suite runs in stock Node, importing the real handler

`npm test` is `node --test` and nothing else (`package.json`). No loader, no flags, no build step, no
bundler, no `wrangler`, no network. Node strips the TypeScript types itself.

Measured on this tree, 2026-08-04: **1185 tests, 0 failures, 19.9s**, on Node v26.5.0. CI pins Node
22.18.0 (`.node-version`) and runs the same command; the workflow's own comment reads "No network, no
container, no R2 — the whole suite runs on captured bytes and fake bindings"
(`.github/workflows/ci.yml`).

Thirteen test files import the production request handler directly:

```js
import { handle } from '../src/worker.ts'
```

They then drive real routes — the media/mux path, the translation deadline, the YouTube date path,
the media proxy, `/_prep` — against plain object literals standing in for the bindings. That is not a
proof that mbedfx runs under Node in production. It is a proof that **the module graph loads and
executes under Node**, which is the thing usually in doubt.

### 1.2 `handle()` is already an adapter entry point

```ts
// src/worker.ts
export async function handle(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response>
```

`env`, `ctx` and `Deps` are all ordinary parameters. The Workers-specific default export is nine
lines wrapped around it:

```ts
// src/worker.ts, the default export
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, ctx, {
      cache: caches.default as unknown as CacheLike,
      fetchPost: liveFetchPost,
      resolveShortlink: liveResolveShortlink,
      resolveRedditShare: liveResolveRedditShare,
      resolveMetaShare,
    })
  },
}
```

Every Cloudflare-shaped thing in that block is the single `caches.default` cast. All four live
dependencies are already exported (`liveFetchPost`, `liveResolveShortlink` and `liveResolveRedditShare` from `src/worker.ts`,
`resolveMetaShare` from `src/platforms/metashare/fetch.ts`), so a Node
adapter imports the same four and writes **no new fetching or normalising logic at all**. It is a
second caller of an existing function.

### 1.3 Six of the eight Cloudflare surfaces are already plain structural shapes

`Env` lives in `src/analytics.ts`. Of its five object-shaped bindings, three are interfaces
hand-written in that file with no Cloudflare type in them:

```ts
AE?: { writeDataPoint(x: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }  // :90
ASSETS: { fetch(req: Request): Promise<Response> }                                              // :91
AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }                   // :102
```

Two name Cloudflare types, and both are optional:

```ts
MEDIA_RESOLVER?: DurableObjectNamespace   // :95
MEDIA_CACHE?: R2Bucket                    // :96
```

Both of those are nominal rather than real. The suite already satisfies them with object literals and
runs the entire `/_media/` mux path against them under Node:

```js
// test/media-resolver.test.mjs
MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) },
MEDIA_CACHE: fakeR2(),          // head / get / get-with-range / put over a Map
```

The two surfaces outside `Env` are the same story. `caches.default` is reached only through the
hand-written `CacheLike` (`src/worker.ts`) and is *injected* through `Deps` (`src/worker.ts`),
so the runtime cache never appears inside `handle`. `ExecutionContext` is used for `ctx.waitUntil`
and nothing else — 13 call sites, no `passThroughOnException`, no `ctx.props`, no `ctx.exports`.

So of the eight Cloudflare surfaces this Worker touches, **six need only an object literal**
(`AE`, `ASSETS`, `AI`, the `CacheLike`, the `ctx`, and the `cf` fetch option discussed in §3), and the
two that name Cloudflare types are optional and already faked in tests.

### 1.4 There is one Workers-only global on the request path, and it is already feature-detected

```ts
// src/worker.ts, putMuxed
// FixedLengthStream is a Workers-runtime global; under `node --test` it is absent, so the buffer
// path below serves the unit tests while the streaming path serves production.
if (typeof FixedLengthStream !== 'undefined' && Number.isInteger(len) && len > 0) {
```

That is the complete list. `crypto.subtle.digest` (`src/worker.ts`) is standard in Node.
There is no `HTMLRewriter`, no `WebSocketPair`, no `caches` reference inside `handle`, no read of
`request.cf`, and no `cloudflare:` module import anywhere under `src/` except `src/container.ts` —
which exists solely so that it *can* be excluded:

> THE ONLY FILE THAT IMPORTS @cloudflare/containers. That package pulls in `cloudflare:workers`, a
> module that exists only in the Workers runtime, so importing it under `node --test` throws. Keeping
> it here — reached solely through the deploy entry src/index.ts, never through the test-imported
> worker.ts — is what lets the suite keep running in plain Node.
> — `src/container.ts`

The separation that makes the tests work is exactly the separation a Node port needs. It already
exists, and it was built for a different reason.

### 1.5 The container is self-hostable **today**, and nobody wrote that down

`container/` has no Cloudflare surface at all. `server.py` imports only the standard library
(`ipaddress`, `json`, `os`, `socket`, `subprocess`, `tempfile`, `http.server`, `urllib.parse`) and
ends:

```python
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
```

The Dockerfile is `python:3.12-slim` plus ffmpeg, `yt-dlp[default,curl-cffi]` and a static Deno
binary, `EXPOSE 8080`, `CMD ["python", "server.py"]`. So:

```sh
docker build -t media-resolver container/
docker run -p 8080:8080 -e RESOLVER_SECRET=... media-resolver
curl localhost:8080/health          # -> 200 "ok"
```

Nothing in `container/` touches a Cloudflare API, so there is no porting work in it. The image has not been re-exercised outside Workers, though. `container/README.md` documents only the
`wrangler deploy` path, which is why this has never been said out loud.

#### The `/resolve` contract

From the module docstring at `container/server.py` and the handler at `do_POST`:

**`POST /resolve`**, JSON body, three shapes:

```jsonc
{ "video": "<url>", "audio": "<url>"|null }   // ffmpeg -c copy mux of tracks already extracted
{ "page":  "<url>" }                          // yt-dlp resolves + merges (any yt-dlp-supported site)
{ "page":  "<url>", "meta": true }            // METADATA ONLY: one `yt-dlp -J`, no download
```

Any shape also accepts an optional `"cookies"`: the *contents* of a Netscape `cookies.txt`. It
becomes a `0600` temp jar for the length of the call and is unlinked afterwards whether the call
succeeded or raised. It is never logged, echoed into an error, or returned. It is what makes an
age-gated source resolvable at all; without it yt-dlp answers `formats: 0` and the card degrades
honestly instead of wrongly.

**Responses**

| | |
|---|---|
| `200 video/mp4` | the muxed file, streamed. Remux, never transcode: `-c copy -movflags +faststart` |
| `200 application/json` | meta mode only — a passthrough of `yt-dlp -J` |
| `4xx/5xx application/json` | `{"error": "..."}`. `400` bad json / `need 'page' or 'video'` / invalid source; `401` unauthorized; `404` not found; `502` mux failed, meta failed, empty or oversized result; `504` mux timed out, meta timed out; `500` internal error |
| `GET /health` | `200 ok` |

stderr is deliberately suppressed on failure because it can carry the source URL.

**Environment** (`container/server.py`): `PORT` (8080), `RESOLVER_SECRET` (unset = no auth),
`MAX_SECONDS` (1500), `MAX_BYTES` (393216000, a 375 MB output ceiling), `PROC_TIMEOUT` (120s per
subprocess). Note `container/README.md` still says `MAX_SECONDS=1200` and 300 MB; `server.py` is
authoritative and was raised 2026-08-03.

**Security, already in the container** (docstring, `container/server.py`): the shared-secret header
`X-Resolver-Secret` when `RESOLVER_SECRET` is set; scheme checked to http/https; every host resolved
and refused if it lands on a private, loopback, link-local, reserved or multicast address;
`-protocol_whitelist` on ffmpeg with no `file:`/`concat:`/`data:`; a URL beginning with `-` rejected
outright, subprocesses as argv lists never a shell, and a `--` end-of-options guard on yt-dlp.

That SSRF guard matters for §4.2 below: **the container has one and the Worker does not.**

---

## 2. The caveat that decides everything: egress IP

The runtime port is the easy half. The hard question is whether a self-hosted instance produces the
*same cards*, and that is decided by the IP address the fetches leave from, not by the language they
are written in.

This project has repeatedly measured platforms answering a datacenter IP differently from a
residential one — in both directions. Everything in this table is from the source, with the date the
measurement was taken.

| Platform / surface | Measured | Where |
|---|---|---|
| Reddit anonymous `.json` | **Blocked from datacenter.** Verified 2026-07-21: our Workers egress gets a 403 "network security" block page. `embed.reddit.com` is not blocked and is therefore the primary, credential-free path. | `src/platforms/reddit/fetch.ts` |
| Reddit embed with a placeholder subreddit | Measured from Workers egress 2026-07-22: a placeholder sub gets a **stripped** render, so the real subreddit has to be passed. | `src/platforms/reddit/fetch.ts` |
| Facebook `/share/{code}` 302 | **Residential gets the redirect; Cloudflare egress does not.** Measured on one share code: a browser-shaped request from a laptop gets `302 -> /posts/…`, the same request from Cloudflare's egress gets no redirect. Confirmed by natural experiment against the live worker. | `src/platforms/metashare/fetch.ts` |
| Instagram embed | From **datacenter** egress the embed returned an ~81 KB "unavailable" shell, which made a public post render as private. From **residential** egress the same page does not reproduce it. This shipped to production precisely because it never reproduced off-datacenter. | `src/worker.ts` |
| Threads video (`scontent*.cdninstagram.com`) | **Meta blocks Cloudflare's datacenter egress** for these bytes — "our container can't fetch it … that fetch is a datacenter IP; Discord's proxy is not". Hence Threads video is a 302 to Discord's own proxy rather than a remux or a byte proxy. | `src/platforms/threads/normalize.ts`, `src/mediaproxy.ts` |
| Google translate endpoint | **Measured 2026-07-31 from a Worker** — the only place the question can be settled: answers in 13-16 ms and is **not** blocked from Cloudflare's egress. It does rate-limit bursts: ~30 requests in a few seconds drew HTTP 429 on every one. | `src/translate.ts` |
| Twitter guest endpoints | Answered **byte-identically from residential and Cloudflare Workers egress** in the 2026-07-19 recon; the activation and `TweetResultByRestId` were measured working from Workers egress. | `src/platforms/twitter/fetch.ts`, `:129`, `:147` |
| YouTube via yt-dlp | **Not** datacenter-IP-blocked. Measured 2026-07-22 from Cloudflare Container egress: a `{page}` resolve returns a real ad-free MP4. It needed Deno for the signature challenge, not a different IP. | `container/README.md` |
| Instagram copyright recovery (`copyright_recovered`) | **Unconfirmed from Cloudflare egress** — every measurement behind it is residential, and the recovery fails silently into a cover still. The counter exists so the failure is visible at all. | `src/analytics.ts` |
| Instagram generally | "Instagram's behaviour toward Cloudflare is PATH-DEPENDENT, so a residential result does not transfer to Workers egress by itself." | `src/platforms/instagram/fetch.ts` |

### What that means for you

**The direction is not uniform.** A self-hosted instance is not simply worse or simply better:

- **On a residential connection** you would likely get Facebook's `/share` 302 that we cannot get, and
  you would likely not hit the Instagram "unavailable shell" that produced a false 🔒 here. You might
  be able to fetch Threads video bytes directly, which we deliberately do not attempt. You would
  probably still be blocked on Reddit's anonymous `.json`, since that block is about being a bot as
  much as being a datacenter — but that is not measured either way.
- **On a VPS or cloud host** you are in the same category as us, and possibly worse: a smaller
  provider's ranges are often blocked more aggressively than Cloudflare's, and none of the
  measurements above transfer to a different datacenter operator.
- **Anything Google-facing** (translation) rate-limits bursts rather than IPs, and a self-hosted
  instance with a cold cache will burst more than ours does.

**Nobody has measured any of this from a third egress.** Every number in the table above is from
either a residential laptop or Cloudflare. There is no measurement from AWS, Hetzner, a home server,
or anywhere else. Until someone takes one, "will my self-hosted instance render the same cards?"
**cannot be determined** — and it is not a question the code can answer, only a probe can.

This is also why the analytics counters are shaped the way they are. `translate_fallback`,
`copyright_gql` / `copyright_recovered` / `copyright_remux`, and `fullpage_recovered` all exist
specifically to make an egress-wide block visible, because in every one of those cases **the cards
keep rendering** and the failure is otherwise silent (`src/analytics.ts`). A self-hoster who
wires up no counter sink at all loses the only instrument that can tell them their egress is being
refused.

---

## 3. What replaces each binding, and what degrades without it

| Surface | Where it is declared | What the code actually calls | Replace with | If you do not |
|---|---|---|---|---|
| `ASSETS` | `src/analytics.ts` | one call: `env.ASSETS.fetch(req)` (`src/worker.ts`) | any static file server over `public/`, wrapped to take a `Request` and return a `Response` | **Required.** The landing page and the converter page are the only routes that use it, and the route throws without it. Roughly six lines of Node. |
| `MEDIA_CACHE` (R2) | `src/analytics.ts` | `head(key)`, `get(key)`, `get(key, {range:{offset,length}})`, `put(key, stream\|ArrayBuffer\|string)` | any S3-compatible store, or a directory on disk. The test fake is a `Map` in 15 lines (`test/media-resolver.test.mjs`) | **Optional.** Remux videos degrade to their cover still on every view — the mux is never cached, so it either re-muxes forever or is stripped entirely. Translations lose their cross-request cache. yt-dlp metadata is re-extracted every time (2.4-3.1 s per Facebook video). |
| `MEDIA_RESOLVER` (Durable Object) | `src/analytics.ts` | `resolver.getByName(name).fetch(url, init)` — nothing else | an object whose `getByName(name)` returns `{ fetch }` pointed at your container. The name is a pooling slot (`resolver-{generation}-{0..N}`), so it can map to one container or several | **Optional.** Without it *or* without `MEDIA_CACHE`, `withResolver` strips every `remux` video and those platforms render a cover still — the same as before playback existed (`src/worker.ts`). |
| `AE` (Analytics Engine) | `src/analytics.ts` | one call: `env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })` (`src/analytics.ts`) | anything with a `writeDataPoint` method — a Prometheus counter, a StatsD client, a log line. The full schema is in `docs/METRICS.md` (branch `docs/metrics-cookbook`) | **Optional.** Every card still renders. You lose the only signal that would tell you your egress is being refused (see §2). |
| `AI` (Workers AI) | `src/analytics.ts` | `ai.run(model, input)`, model `@cf/google/gemma-4-26b-a4b-it` (`src/translate.ts`) | any model behind a `run(model, input)` shim | **Optional.** Translation falls back to Google's endpoint alone; if that is also refused from your egress, translation stops and every card renders untranslated. |
| `caches.default` | `src/worker.ts`, behind `CacheLike` (`src/worker.ts`) | `match(url)` / `put(url, Response)` with a synthetic `https://cache.mbedfx.internal/…` key (`src/cache.ts`) | a `Map` (what the tests use), Redis, or a disk cache. **Not** a per-process `Map` if you run more than one process | **Required by the type, trivial to satisfy.** With a weak one, every paste refetches upstream — and Discord fetches roughly three times per paste (`src/worker.ts`), so the amplification is immediate. Note Cloudflare's Cache API is itself only per-datacenter, so a self-hosted shared cache is arguably *better* than what we have ([Cloudflare docs: "the contents of the cache do not replicate outside of the originating data center"](https://developers.cloudflare.com/workers/runtime-apis/cache/)). |
| `ExecutionContext` | parameter of `handle` | `ctx.waitUntil(p)` only, 13 sites | `{ waitUntil(p) { … } }` that tracks the promise and keeps the process alive until it settles | **Required, and a no-op is a trap.** `waitUntil` is what releases in-flight container slots, keeps a mux running past the response, and writes the response cache. A no-op silently cancels all three and the symptom is "videos never appear". |
| `cf: { cacheEverything, cacheTtl }` | `src/platforms/twitter/fetch.ts` | reuses one Twitter guest-token activation for `GUEST_TOKEN_TTL` = 7200 s | any 2-hour cache wrapped around that one POST | **Silently ignored off Cloudflare.** Every request mints a fresh guest token. A token has roughly a 500-request budget (`src/platforms/twitter/fetch.ts`), so this is not fatal, but it is one extra request to Twitter per cold card and a plausible source of rate-limiting you would not see here. |

Secrets are all plain strings on `Env` (`RESOLVER_SECRET`, `IMGUR_CLIENT_ID`, `TRANSLATE_GOOGLE`,
`IG_GRAPHQL_DOC_ID`, `X_ACCOUNTS`, `IG_ACCOUNTS`, `YT_ACCOUNTS`, `REDDIT_CLIENT_ID`,
`REDDIT_CLIENT_SECRET`) and map straight onto environment variables. One warning carried over from
`src/analytics.ts`: those are stored as Worker secrets here specifically because a Worker secret
is encrypted at rest and absent from disk. On a self-hosted box they sit in a file somebody may read,
which is the threat model FxEmbed's encrypted-bundle design was answering. If you fill
`IG_ACCOUNTS` / `YT_ACCOUNTS` on a self-hosted instance, that trade-off is now yours.

---

## 4. Two things that must change in the code before a self-hosted instance is exposed

Neither is a blocker to *running* it. Both are blockers to running it *safely on a public host*, and
neither is hypothetical.

### 4.1 Your own hostname is not in `OWN_HOSTS`

The fediverse routes take an instance hostname straight from the URL path and make it the origin of a
fetch. `fetchableInstance` (`src/platforms/fedihost.ts`) refuses our own zones so the Worker cannot
be induced to fetch itself:

```ts
const OWN_HOSTS = ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'workers.dev']  // :53
```

It takes an optional `self` origin, but the Worker deliberately does not thread one in
(`src/worker.ts`), so **the module-level list is the whole guard**. A self-hoster on
`embed.example.com` who does not add it to `OWN_HOSTS` leaves `/…/embed.example.com/post/1` able to
make the service fetch itself. On Cloudflare that re-enters through the edge and bypasses the zone's
own WAF, which is the documented reason the clause exists; on a self-hosted box it is a self-request
loop and an internal-service reach.

**Adding your domain to `OWN_HOSTS` is a mandatory step, not a nicety.** The right fix in the adapter
phase is to make the list configurable rather than a constant.

### 4.2 The Worker half has no DNS/private-range guard, and off Cloudflare that matters more

`src/platforms/fedihost.ts` says so plainly:

> WHAT THIS DOES NOT COVER, said plainly: a PUBLIC hostname that resolves to a private address. No
> DNS resolution happens here and there is no TOCTOU-free way to add one in a Worker; Cloudflare's
> docs are silent on whether `fetch()` blocks private ranges at all.

The residual is bounded by three other clauses — no credential is ever attached, the body is capped,
and the response must be the right shape — so on Cloudflare the worst case is a blind GET. On a
Node host inside your own network, `fetch()` reaches `127.0.0.1`, your LAN, and your cloud metadata
endpoint, so "a blind GET" is a materially worse worst case than it is here.

The container already solves exactly this problem: it resolves each host and refuses private,
loopback, link-local, reserved and multicast addresses (`container/server.py`). **The same check
has to be ported into the Worker half of a self-hosted deployment.** It is not needed on Cloudflare,
which is why it does not exist yet.

---

## 5. The plan, in phases

### Phase 0 — today, no code required

Run the container by itself:

```sh
docker build -t media-resolver container/
docker run -p 8080:8080 -e RESOLVER_SECRET="$(openssl rand -hex 32)" media-resolver
curl localhost:8080/health
```

**Set `RESOLVER_SECRET`.** `server.py` enforces the shared secret only when one is present, so without
it that command stands up an unauthenticated remuxer that will fetch and download whatever any caller
names. Do not publish it, and do not bind it to a public interface. It is a general-purpose remux/resolve service with
the contract in §1.5 and it is useful on its own, whether or not you ever run the Worker off
Cloudflare. This is the only part of self-hosting that should work with no changes, though nobody has run it that way.

### Phase 1 — a Node adapter (no changes under `src/`)

One new file, plus packaging. Everything it needs is already exported:

- an `env` object literal: `ASSETS` over `public/`, optional `AE` / `AI` / `MEDIA_CACHE` /
  `MEDIA_RESOLVER`, secrets read from `process.env`;
- a `ctx` with a **real** `waitUntil` that tracks promises and does not let the process exit under
  them (see §3 — a no-op here is the classic silent failure);
- a `CacheLike` — a `Map` to start, something shared before it is more than one process;
- `Deps` copied verbatim from the default export: `liveFetchPost`, `liveResolveShortlink`,
  `liveResolveRedditShare`, `resolveMetaShare`;
- HTTP glue: `IncomingMessage` → `Request`, `Response` → `ServerResponse`, streaming the body.

Deliverable: `adapters/node/server.ts`, a Dockerfile for it, and a compose file that stands it up
next to the resolver container. Success criterion: the same paste renders the same card from the
adapter as from production, on the platforms not affected by §2.

### Phase 2 — the corrections that make it safe to expose

- `OWN_HOSTS` configurable, and documented as mandatory (§4.1).
- A DNS-resolution private-range guard in the Worker half, ported from `container/server.py` (§4.2).
- A replacement for the `cf` fetch-cache on the Twitter guest-token activation (§3).
- A persistent, shared `CacheLike` instead of a per-process `Map`.
- `FixedLengthStream`'s buffering fallback reviewed under real load: off Cloudflare, every mux is
  buffered into memory up to the container's own 375 MB ceiling (`src/worker.ts`).

### Phase 3 — measure the egress, which is the only thing that settles it

Run the fetchers from the target host and compare against the table in §2. Specifically: Reddit's
anonymous `.json`, a Facebook `/share/{code}`, an Instagram embed for a known-public post, a Threads
`scontent` video URL, and a Google translate call. Then write the results down here with the date and
the host type, in the same form as §2. Until someone does this, the honest answer to "does a
self-hosted mbedfx render the same cards" is that **it cannot be determined**.

---

## 6. What this document does not claim

- It does not claim mbedfx runs off Cloudflare. Nobody has run it.
- It does not claim the port is small. It claims the port has **no known blocker**, which is a
  different and weaker statement, and everything supporting it is cited above so it can be checked.
- It does not claim a self-hosted instance will behave like the public one. §2 is the reason, and the
  measurement that would settle it has not been taken from any third egress.
- It does not promise a timeline. Implementation is parked; this is the audit and the plan. »
