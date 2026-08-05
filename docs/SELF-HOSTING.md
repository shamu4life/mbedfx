# Self-hosting mbedfx

Nobody has run mbedfx off Cloudflare Workers. There is no Node adapter, no Dockerfile for the Worker
and no compose file, and nothing below has been run end to end outside Workers. The audit found no
*known* blocker in the code — a weaker claim than "the port is small", and a claim about the code
rather than a demonstration of it, cited throughout so it can be checked. Nobody has measured
whether a self-hosted instance would draw the same cards (§2). Implementation is parked with no
timeline.

An earlier version of this project's notes said self-hosting was not achievable, and the README
comparison table said "Workers only". That was wrong. The correction is the reason this file exists.

---

## 0. The container, on its own

`container/` is self-hostable today. It's the only part that should work with no changes, and nobody
has run it that way.

Run these from the repository root. You need a Docker-compatible CLI and nothing else: no Cloudflare
account, no `wrangler` login. `server.py` enforces the shared secret only when one is present, so set
`RESOLVER_SECRET`:

```sh
docker build --platform linux/amd64 -t media-resolver container/
docker run -p 8080:8080 -e RESOLVER_SECRET="$(openssl rand -hex 32)" media-resolver
curl localhost:8080/health
```

`container/Dockerfile:16` installs an x86_64 Deno binary, and `container/README.md:214` states the
image must be linux/amd64, which `--platform` pins above. What an arm64 build produces is
unrecorded; nobody has built or resolved on one.

With no secret set, that command stands up an unauthenticated remuxer that will fetch and download
whatever any caller names. Do not publish it, and do not bind it to a public interface.

`/health` answers `200 ok` once the image is up. The request contract is in §1.5.

---

## 1. The audit

### 1.1 The test suite

The suite runs in stock Node. `npm test` is `node --test` and nothing else (`package.json`): no
loader, no flags, no build step, no bundler, no `wrangler`, no network. Node strips the TypeScript
types itself.

Re-measured on this tree, 2026-08-05: 1207 tests, 0 failures, 19.3-20.1s across runs, on Node
v26.5.0. The figure this replaces was 1185 tests in 19.9s, measured 2026-08-04. CI pins Node
22.18.0 (`.node-version`) and runs the same command. The workflow's own comment reads "No network, no
container, no R2 — the whole suite runs on captured bytes and fake bindings"
(`.github/workflows/ci.yml`).

Thirteen test files import the production request handler directly:

```js
import { handle } from '../src/worker.ts'
```

The routes are real: the media/mux path, the translation deadline, the YouTube date path, the media
proxy, `/_prep`, with object literals standing in for the bindings. That much proves the module graph
loads and executes under Node, and nothing more.

### 1.2 The adapter entry point

`env`, `ctx` and `Deps` are all ordinary parameters of `handle()`:

```ts
// src/worker.ts
export async function handle(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response>
```

The Workers-specific default export is nine lines wrapped around it:

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

The `caches.default` cast is the only Cloudflare-shaped thing in that block, and all four live
dependencies are already exported: `liveFetchPost`, `liveResolveShortlink` and
`liveResolveRedditShare` from `src/worker.ts`, `resolveMetaShare` from
`src/platforms/metashare/fetch.ts`. A Node adapter imports the same four and writes no new fetching
or normalising logic.

### 1.3 The eight Cloudflare surfaces

Six of the eight need only an object literal: `AE`, `ASSETS`, `AI`, the `CacheLike`, the `ctx`, and
the `cf` fetch option covered in §3.

`Env` lives in `src/analytics.ts`. Of its five object-shaped bindings, three are interfaces
hand-written in that file with no Cloudflare type in them:

```ts
AE?: { writeDataPoint(x: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }  // :90
ASSETS: { fetch(req: Request): Promise<Response> }                                              // :91
AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }                   // :102
```

The other two are optional Cloudflare types:

```ts
MEDIA_RESOLVER?: DurableObjectNamespace   // :95
MEDIA_CACHE?: R2Bucket                    // :96
```

Nothing uses either one beyond its shape. The suite fakes both with object literals and runs the
entire `/_media/` mux path against them under Node:

```js
// test/media-resolver.test.mjs
MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) },
MEDIA_CACHE: fakeR2(),          // head / get / get-with-range / put over a Map
```

Outside `Env`, `caches.default` is reached only through the hand-written `CacheLike`, injected
through `Deps` (`src/worker.ts`), so the runtime cache never appears inside `handle`.
`ExecutionContext` is used for `ctx.waitUntil` and nothing else, across nine call sites in
`src/worker.ts`, with no `passThroughOnException`, `ctx.props` or `ctx.exports`. Nine is the count of
invocations; a grep for `ctx.waitUntil` returns 13, five of which are prose inside comments, and the
ninth invocation is the optional-chained `ctx?.waitUntil` at `src/worker.ts:1980` that the literal
grep never matched. An earlier revision of this file printed that 13.

### 1.4 Workers-only globals

Exactly one Workers-only global sits on the request path, and it's already feature-detected:

```ts
// src/worker.ts, putMuxed
// FixedLengthStream is a Workers-runtime global; under `node --test` it is absent, so the buffer
// path below serves the unit tests while the streaming path serves production.
if (typeof FixedLengthStream !== 'undefined' && Number.isInteger(len) && len > 0) {
```

`crypto.subtle.digest` (`src/worker.ts`) is standard in Node. Nothing else under `src/` reaches for
the runtime: no `HTMLRewriter` or `WebSocketPair`, no `caches` inside `handle`, no read of
`request.cf`, and no `cloudflare:` import outside `src/container.ts`, which exists so it can be
excluded:

> THE ONLY FILE THAT IMPORTS @cloudflare/containers. That package pulls in `cloudflare:workers`, a
> module that exists only in the Workers runtime, so importing it under `node --test` throws. Keeping
> it here — reached solely through the deploy entry src/index.ts, never through the test-imported
> worker.ts — is what lets the suite keep running in plain Node.
> — `src/container.ts`

A Node port needs the same boundary.

### 1.5 The container has no Cloudflare surface

`server.py` imports only the standard library (`ipaddress`, `json`, `os`, `socket`, `subprocess`,
`tempfile`, `http.server`, `urllib.parse`) and ends:

```python
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
```

The Dockerfile is `python:3.12-slim` plus ffmpeg, `yt-dlp[default,curl-cffi]` and a static Deno
binary, `EXPOSE 8080`, `CMD ["python", "server.py"]`, and none of it needs porting. The image has not
been re-exercised outside Workers, and `container/README.md` documents only the `wrangler deploy`
path.

#### The `/resolve` contract

From the module docstring at `container/server.py` and the handler at `do_POST`:

**`POST /resolve`**, JSON body, three shapes:

```jsonc
{ "video": "<url>", "audio": "<url>"|null }   // ffmpeg -c copy mux of tracks already extracted
{ "page":  "<url>" }                          // yt-dlp resolves + merges (any yt-dlp-supported site)
{ "page":  "<url>", "meta": true }            // METADATA ONLY: one `yt-dlp -J`, no download
```

Any shape also accepts an optional `"cookies"`, the contents of a Netscape `cookies.txt`. It becomes
a `0600` temp jar for the length of the call, unlinked afterwards whether the call succeeded or
raised, and never logged, echoed into an error, or returned. Without a jar, yt-dlp answers `formats:
0` for age-gated sources inside the container (`container/server.py`) and the Worker falls back to
the cover image (`src/worker.ts`).

**Responses**

| | |
|---|---|
| `200 video/mp4` | the muxed file, streamed. Remux, never transcode: `-c copy -movflags +faststart` |
| `200 application/json` | meta mode only, a passthrough of `yt-dlp -J` |
| `4xx/5xx application/json` | `{"error": "..."}`. `400` bad json / `need 'page' or 'video'` / invalid source; `401` unauthorized; `404` not found; `502` mux failed, meta failed, empty or oversized result; `504` mux timed out, meta timed out; `500` internal error |
| `GET /health` | `200 ok` |

stderr is suppressed on failure because it can carry the source URL.

**Environment** (`container/server.py`): `PORT` (8080), `RESOLVER_SECRET` (unset = no auth),
`MAX_SECONDS` (1500), `MAX_BYTES` (393216000, a 375 MB output ceiling), `PROC_TIMEOUT` (120s per
subprocess). `server.py` is authoritative on these numbers whenever `container/README.md` disagrees;
the README has carried a stale pair before. `MAX_SECONDS` and `MAX_BYTES` were raised together on
2026-08-03 and have to move together. The mux is `-c copy`, so output size is the source bitrate
times the duration.

**Security, already in the container** (docstring, `container/server.py`):

- the shared-secret header `X-Resolver-Secret`, required on every `/resolve` when `RESOLVER_SECRET` is
  set
- the scheme checked to http/https
- every host resolved, and refused if it lands on a private, loopback, link-local, reserved or
  multicast address
- `-protocol_whitelist` on ffmpeg, with no `file:`, `concat:` or `data:`
- a URL beginning with `-` rejected outright, subprocesses as argv lists rather than a shell, and a
  `--` end-of-options guard on yt-dlp

---

## 2. Egress IP

Platforms have repeatedly answered a datacenter IP differently from a residential one, in both
directions, so the address the fetches leave from decides what a self-hosted instance can draw. Every
row below is from the source named, with the date it was measured.

| Platform / surface | Measured | Where |
|---|---|---|
| Reddit anonymous `.json` | Blocked from datacenter. Verified 2026-07-21: the Workers egress gets a 403 "network security" block page. `embed.reddit.com` is not blocked and is therefore the primary, credential-free path. | `src/platforms/reddit/fetch.ts` |
| Reddit embed with a placeholder subreddit | Measured from Workers egress 2026-07-22: a placeholder sub gets a stripped render, so the real subreddit has to be passed. | `src/platforms/reddit/fetch.ts` |
| Facebook `/share/{code}` 302 | Residential gets the redirect and Cloudflare egress does not. Measured on one share code: a browser-shaped request from a laptop gets `302 -> /posts/…`, the same request from Cloudflare's egress gets no redirect. Confirmed by natural experiment against the live worker. | `src/platforms/metashare/fetch.ts` |
| Instagram embed | From datacenter egress the embed returned an ~81 KB "unavailable" shell, which made a public post render as private. From residential egress the same page does not reproduce it. This shipped to production because it never reproduced off-datacenter. | `src/worker.ts` |
| Threads video (`scontent*.cdninstagram.com`) | Meta blocks Cloudflare's datacenter egress for these bytes. The source records it as "our container can't fetch it … that fetch is a datacenter IP; Discord's proxy is not". Threads video is therefore a 302 to Discord's own proxy rather than a remux or a byte proxy. | `src/platforms/threads/normalize.ts`, `src/mediaproxy.ts` |
| Google translate endpoint | Measured 2026-07-31 from a Worker, the only place the question can be settled: answers in 13-16 ms and is not blocked from Cloudflare's egress. It does rate-limit bursts, and ~30 requests in a few seconds drew HTTP 429 on every one. | `src/translate.ts` |
| Twitter guest endpoints | Answered byte-identically from residential and Cloudflare Workers egress in the 2026-07-19 recon; the activation and `TweetResultByRestId` were measured working from Workers egress. | `src/platforms/twitter/fetch.ts`, `:129`, `:147` |
| YouTube via yt-dlp | Not datacenter-IP-blocked. Measured 2026-07-22 from Cloudflare Container egress: a `{page}` resolve returns a real ad-free MP4. It needed Deno for the signature challenge, not a different IP. | `container/README.md` |
| Instagram copyright recovery (`copyright_recovered`) | Unconfirmed from Cloudflare egress. Every measurement behind it is residential, and the recovery fails silently into a cover still. The counter exists so the failure is visible at all. | `src/analytics.ts` |
| Instagram generally | "Instagram's behaviour toward Cloudflare is PATH-DEPENDENT, so a residential result does not transfer to Workers egress by itself." | `src/platforms/instagram/fetch.ts` |

### Reading the table

A residential connection would probably get Facebook's `/share` 302 that the public instance can't
get, and would probably avoid the Instagram "unavailable" shell that made a public post render as
private here. Threads video bytes may be fetchable directly, which mbedfx doesn't attempt. Reddit's
anonymous `.json` would most likely still be blocked, since that block looks as much like bot
detection as datacenter detection, but nothing measures it either way.

A VPS or cloud host sits in the same category as the public instance, possibly worse. A smaller
provider's ranges are often blocked more aggressively than Cloudflare's, and none of the measurements
above transfer to a different datacenter operator.

Google rate-limits bursts rather than IPs, and an instance with a cold cache will burst more than
the public one does.

Every number in the table is from a residential laptop or from Cloudflare. Nothing has been measured
from AWS, Hetzner, a home server or anywhere else, and whether a self-hosted instance renders the
same cards is unknown until somebody takes that measurement.

`translate_fallback`, `copyright_gql` / `copyright_recovered` / `copyright_remux` and
`fullpage_recovered` exist to make an egress-wide block visible, since in each case the cards keep
rendering and the failure is otherwise silent (`src/analytics.ts`). An instance wired to no counter
sink would never see a refused egress.

---

## 3. What replaces each binding, and what degrades without it

| Surface | Where it is declared | What the code calls | Replace with | Without it |
|---|---|---|---|---|
| `ASSETS` | `src/analytics.ts` | one call: `env.ASSETS.fetch(req)` (`src/worker.ts`) | any static file server over `public/`, wrapped to take a `Request` and return a `Response` | Required, and about six lines of Node. The landing page and the converter page are the only routes that touch it, and they throw without it. |
| `MEDIA_CACHE` (R2) | `src/analytics.ts` | `head(key)`, `get(key)`, `get(key, {range:{offset,length}})`, `put(key, stream\|ArrayBuffer\|string)` | any S3-compatible store, or a directory on disk. The test fake is a `Map` in 15 lines (`test/media-resolver.test.mjs`) | Optional. The mux is never cached, so remux videos either re-mux forever or get stripped, and the card falls back to its cover still on every view. Translations lose their cross-request cache. yt-dlp metadata is re-extracted every time (2.4-3.1 s per Facebook video). |
| `MEDIA_RESOLVER` (Durable Object) | `src/analytics.ts` | `resolver.getByName(name).fetch(url, init)` and nothing else | an object whose `getByName(name)` returns `{ fetch }` pointed at the container. The name is a pooling slot (`resolver-{generation}-{0..N}`), so it can map to one container or several | Optional. Without it or without `MEDIA_CACHE`, `withResolver` strips every `remux` video and those platforms render a cover still, the same as before playback existed (`src/worker.ts`). |
| `AE` (Analytics Engine) | `src/analytics.ts` | one call: `env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })` (`src/analytics.ts`) | anything with a `writeDataPoint` method, such as a Prometheus counter, a StatsD client or a log line. The full schema is in `docs/METRICS.md` | Optional. Every card still renders, and the one signal that would report a refused egress is gone (§2). |
| `AI` (Workers AI) | `src/analytics.ts` | `ai.run(model, input)`, model `@cf/google/gemma-4-26b-a4b-it` (`src/translate.ts`) | any model behind a `run(model, input)` shim | Optional. Translation falls back to Google's endpoint alone; if that is also refused from your egress, translation stops and every card renders untranslated. |
| `caches.default` | `src/worker.ts`, behind `CacheLike` (`src/worker.ts`) | `match(url)` / `put(url, Response)` with a synthetic `https://cache.mbedfx.internal/…` key (`src/cache.ts`) | a `Map` (what the tests use), Redis, or a disk cache. **Not** a per-process `Map` across more than one process | Required by the type, trivial to satisfy. With a weak one, every paste refetches upstream, and Discord fetches roughly three times per paste (`src/worker.ts`). Cloudflare's Cache API is itself only per-datacenter, so a self-hosted shared cache is arguably better than what the public instance has ([Cloudflare docs: "the contents of the cache do not replicate outside of the originating data center"](https://developers.cloudflare.com/workers/runtime-apis/cache/)). |
| `ExecutionContext` | parameter of `handle` | `ctx.waitUntil(p)` only, nine sites in `src/worker.ts` | `{ waitUntil(p) { … } }` that tracks the promise and keeps the process alive until it settles | Required. `waitUntil` is what releases in-flight container slots, keeps a mux running past the response, and writes the response cache. A no-op silently cancels all three, and the symptom is "videos never appear". |
| `cf: { cacheEverything, cacheTtl }` | `src/platforms/twitter/fetch.ts` | reuses one Twitter guest-token activation for `GUEST_TOKEN_TTL` = 7200 s | any 2-hour cache wrapped around that one POST | Silently ignored off Cloudflare. Every request mints a fresh guest token. A token has roughly a 500-request budget (`src/platforms/twitter/fetch.ts`), so this is not fatal, but it is one extra request to Twitter per cold card and a plausible source of rate-limiting that does not show up here. |

Secrets are all plain strings on `Env` (`RESOLVER_SECRET`, `IMGUR_CLIENT_ID`, `TRANSLATE_GOOGLE`,
`IG_GRAPHQL_DOC_ID`, `X_ACCOUNTS`, `IG_ACCOUNTS`, `YT_ACCOUNTS`, `REDDIT_CLIENT_ID`,
`REDDIT_CLIENT_SECRET`) and map straight onto environment variables. A Worker secret is encrypted at
rest and never on disk (`src/analytics.ts`). On a self-hosted box the same values sit in a plain
file, which is the threat model FxEmbed's encrypted-bundle design was answering. Fill
`IG_ACCOUNTS` or `YT_ACCOUNTS` and you take that trade-off on.

---

## 4. Code changes required before a public deployment

Two things must change, and neither blocks running an instance privately.

### 4.1 `OWN_HOSTS`

The fediverse routes take an instance hostname straight from the URL path and make it the origin of a
fetch. `fetchableInstance` (`src/platforms/fedihost.ts`) refuses mbedfx's own zones so the Worker
cannot be induced to fetch itself:

```ts
const OWN_HOSTS = ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'workers.dev']  // :53
```

It takes an optional `self` origin, and the Worker does not thread one in (`src/worker.ts`),
because that would make the guard depend on a request field every test stub would then have to
supply. The list is the whole guard. If your instance answers on `embed.example.com` and that host
isn't in the list, `/…/embed.example.com/post/1` can make the service fetch itself. On Cloudflare
that re-enters through the edge and bypasses the zone's own WAF, which is why the clause exists; on
a self-hosted box it is a self-request loop and an internal-service reach.

Whatever domain you serve from has to be in that list. The adapter phase should make it configurable
instead of a constant.

### 4.2 DNS and private-range guarding in the Worker half

The Worker half has no DNS or private-range guard. `src/platforms/fedihost.ts` records the gap:

> WHAT THIS DOES NOT COVER, said plainly: a PUBLIC hostname that resolves to a private address. No
> DNS resolution happens here and there is no TOCTOU-free way to add one in a Worker; Cloudflare's
> docs are silent on whether `fetch()` blocks private ranges at all.

Three other clauses bound what is left: no credential is ever attached, the body is capped, and the
response must be the right shape. On Cloudflare that leaves a blind GET as the worst case. On a Node
host inside your network the same blind GET reaches `127.0.0.1`, the LAN and the cloud metadata
endpoint.

The container already resolves each host and refuses private, loopback, link-local, reserved and
multicast addresses (`container/server.py`). The Worker half needs the same check, which nobody has
written because Cloudflare has never needed it.

---

## 5. The plan, in phases

### Phase 0. The container alone, today

No code required. The commands in §0 stand the remux and resolve service up on any Docker host, with
`RESOLVER_SECRET` set.

### Phase 1. A Node adapter, with no changes under `src/`

One new file, plus packaging. Everything it needs is already exported:

- an `env` object literal: `ASSETS` over `public/`, optional `AE` / `AI` / `MEDIA_CACHE` /
  `MEDIA_RESOLVER`, secrets read from `process.env`;
- a `ctx` whose `waitUntil` tracks the promise and keeps the process alive until it settles. Make it
  a no-op and videos never appear (§3);
- a `CacheLike`: a `Map` to start, something shared before it is more than one process;
- `Deps` copied verbatim from the default export: `liveFetchPost`, `liveResolveShortlink`,
  `liveResolveRedditShare`, `resolveMetaShare`;
- HTTP glue: `IncomingMessage` → `Request`, `Response` → `ServerResponse`, streaming the body.

That lands as `adapters/node/server.ts`, a Dockerfile for it, and a compose file next to the resolver
container. It is done when the same paste renders the same card from the adapter as from production,
on the platforms §2 doesn't affect.

### Phase 2. The corrections that make it safe to expose

- `OWN_HOSTS` configurable, and documented as mandatory (§4.1).
- A DNS-resolution private-range guard in the Worker half, ported from `container/server.py` (§4.2).
- A replacement for the `cf` fetch-cache on the Twitter guest-token activation (§3).
- A persistent, shared `CacheLike` instead of a per-process `Map`.
- `FixedLengthStream`'s buffering fallback reviewed under real load: off Cloudflare, every mux is
  buffered into memory up to the container's own 375 MB ceiling (`src/worker.ts`).

### Phase 3. Measure the egress

Run the fetchers from the host you plan to use and compare against the table in §2: Reddit's
anonymous `.json`, a Facebook `/share/{code}`, an Instagram embed for a known-public post, a Threads
`scontent` video URL, and a Google translate call. Record the results here with the date and the host
type, in the same form as §2.
