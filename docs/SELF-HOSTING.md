# Self-hosting mbedfx

Nothing here has been run outside Cloudflare Workers: no Node adapter, no Dockerfile for the Worker,
no compose file. `container/` is the only piece that should run unchanged, in the three commands
below, and nobody has run it that way. Implementation is parked, no timeline.

The audit reads the code and finds no *known* blocker in it: a claim about the code, not a
demonstration of it, and not a claim that the port is small. Every claim cites its file. Whether a
self-hosted instance draws the same cards is unmeasured. The egress table measures ten surfaces for
whether the answer changes with the IP the fetch leaves from; three of the ten answer the same
either way.

An earlier revision of this project's notes said self-hosting was not achievable, and the README
comparison table said "Workers only". The README's `Self-host off Cloudflare` row now carries the
corrected value and links here.

---

## The container, on its own

From the repository root, with a Docker-compatible CLI, no Cloudflare account and no `wrangler`
login:

```sh
docker build --platform linux/amd64 -t media-resolver container/
docker run -p 8080:8080 -e RESOLVER_SECRET="$(openssl rand -hex 32)" media-resolver
curl localhost:8080/health
```

`container/server.py:350` checks `X-Resolver-Secret` only when `RESOLVER_SECRET` is set. Unset, that
second command is an unauthenticated remuxer that fetches and downloads whatever any caller names.
Do not publish it or bind it to a public interface.

`container/Dockerfile:16` installs an x86_64 Deno binary and `container/README.md:264` requires
linux/amd64, which `--platform` pins above. What an arm64 build produces is unrecorded; nobody has
built or resolved on one.

---

## The audit

### The test suite

`npm test` is `node --test` and nothing else (`package.json`): no loader, no flags, no build step, no
bundler, no `wrangler`, no network. Node strips the TypeScript types and imports `src/worker.ts` as
written.

Re-measured on this tree 2026-08-05: 1207 tests, 0 failures, 19.3-20.1 s across runs, on Node
v26.5.0, replacing 1185 tests in 19.9 s measured 2026-08-04. CI pins Node 22.18.0 (`.node-version`)
and runs the same command, commented "No network, no container, no R2 — the whole suite runs on
captured bytes and fake bindings" (`.github/workflows/ci.yml:44`).

Thirteen test files import the production handler itself (`import { handle } from
'../src/worker.ts'`) and drive the media/mux path, the translation deadline, the YouTube date path,
the media proxy and `/_prep`, with object literals standing in for the bindings. That proves the
module graph loads and executes under Node, and nothing more.

### The adapter entry point

`env`, `ctx` and `Deps` are ordinary parameters of `handle()` at `src/worker.ts:3358`, and the
Workers-specific default export is nine lines wrapped around it:

```ts
// src/worker.ts
export async function handle(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response>

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

The `caches.default` cast is the only Cloudflare-shaped thing in that block. All four live
dependencies are already exported: `liveFetchPost`, `liveResolveShortlink` and
`liveResolveRedditShare` from `src/worker.ts`, `resolveMetaShare` from
`src/platforms/metashare/fetch.ts`.

### The eight Cloudflare surfaces

Six of the eight need only an object literal: `AE`, `ASSETS`, `AI`, the `CacheLike`, the `ctx`, and
the `cf` fetch option. `Env` lives in `src/analytics.ts`, where three of its five object-shaped
bindings are interfaces hand-written in that file with no Cloudflare type in them:

```ts
AE?: { writeDataPoint(x: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }  // :90
ASSETS: { fetch(req: Request): Promise<Response> }                                              // :91
AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }                   // :102
```

The other two are optional Cloudflare types, `MEDIA_RESOLVER?: DurableObjectNamespace` (`:95`) and
`MEDIA_CACHE?: R2Bucket` (`:96`). The suite fakes both with object literals and runs the entire
`/_media/` mux path against them under Node: `MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) }`
and a `fakeR2()` doing head / get / get-with-range / put over a `Map`
(`test/media-resolver.test.mjs`).

Outside `Env`, `caches.default` is reached only through the hand-written `CacheLike` injected via
`Deps` (`src/worker.ts`). `ExecutionContext` is
used for `ctx.waitUntil` and nothing else, across nine call sites in `src/worker.ts`, with no
`passThroughOnException`, `ctx.props` or `ctx.exports`. Nine is the count of invocations; a grep for
`ctx.waitUntil` returns 13, five of which are prose inside comments, and the ninth invocation is the
optional-chained `ctx?.waitUntil` at `src/worker.ts:1980` that the literal grep never matched. An
earlier revision of this file printed that 13.

### Workers-only globals

Exactly one Workers-only global sits on the request path, feature-detected at `src/worker.ts:2473`:

```ts
// src/worker.ts, putMuxed
if (typeof FixedLengthStream !== 'undefined' && Number.isInteger(len) && len > 0) {
```

`FixedLengthStream` is absent under `node --test`. The buffer path below the check serves the unit
tests; the streaming path serves production.

`crypto.subtle.digest` (`src/worker.ts`) is standard in Node. The rest of `src/` reaches for no
runtime API: no `HTMLRewriter` or `WebSocketPair`, no `caches` inside `handle`, no read of
`request.cf`. No file under `src/` imports a `cloudflare:` module by name; the one
`@cloudflare/containers` import, which pulls `cloudflare:workers` in behind it, lives in
`src/container.ts:1`, a file that exists so it can be excluded:

> THE ONLY FILE THAT IMPORTS @cloudflare/containers. That package pulls in `cloudflare:workers`, a
> module that exists only in the Workers runtime, so importing it under `node --test` throws. Keeping
> it here — reached solely through the deploy entry src/index.ts, never through the test-imported
> worker.ts — is what lets the suite keep running in plain Node.
> — `src/container.ts`

A Node port needs the same boundary: nothing on the request path may import that file.

### The container has no Cloudflare surface

`container/server.py` is 430 lines and imports only the standard library (`ipaddress`, `json`, `os`,
`socket`, `subprocess`, `tempfile`, `http.server`, `urllib.parse`). Lines `:428-430` are the whole
entry point: `port = int(os.environ.get("PORT", "8080"))` under `if __name__ == "__main__":`, then
`ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()`.

`container/Dockerfile` is `python:3.12-slim` plus ffmpeg, `yt-dlp[default,curl-cffi]>=2025.1.1` and
a static Deno binary, `EXPOSE 8080`, `CMD ["python", "server.py"]`. None of it needs porting. The
image has not been re-exercised outside Workers, though `server.py` itself has: it answered
`/health`, enforced `X-Resolver-Secret` and refused every SSRF probe on a stock interpreter with no
container at all, 2026-08-08 on macOS x86_64. `container/README.md` documents that path under
[Running it standalone](../container/README.md#running-it-standalone).

#### The `/resolve` contract

From the module docstring and `do_POST` in `container/server.py`. **`POST /resolve`**, JSON body:

```jsonc
{ "video": "<url>", "audio": "<url>"|null }   // ffmpeg -c copy mux of tracks already extracted
{ "page":  "<url>" }                          // yt-dlp resolves + merges (any yt-dlp-supported site)
{ "page":  "<url>", "meta": true }            // METADATA ONLY: one `yt-dlp -J`, no download
```

Any shape also accepts `"cookies"`, the contents of a Netscape `cookies.txt`. The jar is
written `0600` for the length of the call, unlinked afterwards whether the call succeeded or raised,
and never logged, echoed into an error, or returned. Without a jar, yt-dlp answers `formats: 0` for
age-gated sources inside the container (`container/server.py`), and the Worker falls back to the
cover image (`src/worker.ts`).

**Responses**

| | |
|---|---|
| `200 video/mp4` | the muxed file, streamed. Remux, never transcode: `-c copy -movflags +faststart` |
| `200 application/json` | meta mode only, a passthrough of `yt-dlp -J` |
| `4xx/5xx application/json` | `{"error": "..."}`. `400` bad json / `need 'page' or 'video'` / invalid source; `401` unauthorized; `404` not found; `502` mux failed, meta failed, empty or oversized result; `504` mux timed out, meta timed out; `500` internal error |
| `GET /health` | `200 ok` |

stderr is suppressed on failure; it can carry the source URL.

**Environment** (`container/server.py:46-53`, `PORT` read once at `:429`): `PORT` (8080),
`RESOLVER_SECRET` (unset = no auth), `MAX_SECONDS` (1500), `MAX_BYTES` (393216000, a 375 MB output
ceiling), `PROC_TIMEOUT` (120 s per subprocess). `server.py` is authoritative whenever
`container/README.md` disagrees, and the README has carried a stale pair before. `MAX_SECONDS` and
`MAX_BYTES` were raised together on 2026-08-03 (`container/server.py:48`) and have to move together:
the mux is `-c copy`, and output size is the source bitrate times the duration.

**Security, already in the container** (docstring, `container/server.py`):

- `X-Resolver-Secret`, required on every `/resolve` when `RESOLVER_SECRET` is set
- the scheme checked to http/https
- every host resolved, and refused on a private, loopback, link-local, reserved or multicast address
- `-protocol_whitelist` on ffmpeg, with no `file:`, `concat:` or `data:`
- a URL beginning with `-` rejected outright, subprocesses as argv lists rather than a shell, and a
  `--` end-of-options guard on yt-dlp

---

## Egress IP

Platforms answer a datacenter IP differently from a residential one, in both directions.

| Platform / surface | Measured | Where |
|---|---|---|
| Reddit anonymous `.json` | Verified 2026-07-21: Workers egress gets a 403 "network security" block page. `embed.reddit.com` is not blocked, and is the primary credential-free path. | `src/platforms/reddit/fetch.ts` |
| Reddit embed with a placeholder subreddit | Measured from Workers egress 2026-07-22: a placeholder sub gets a stripped render. The real subreddit has to be passed. | `src/platforms/reddit/fetch.ts` |
| Facebook `/share/{code}` 302 | Measured on one share code: a browser-shaped request from a laptop gets `302 -> /posts/…`, the same request from Cloudflare's egress gets none. Confirmed by natural experiment against the live worker. | `src/platforms/metashare/fetch.ts` |
| Instagram embed | From datacenter egress the embed returned an ~81 KB "unavailable" shell and a public post rendered as private. Residential egress never reproduced it, and it reached production. | `src/worker.ts:293` |
| Threads video (`scontent*.cdninstagram.com`) | Meta blocks Cloudflare's datacenter egress for these bytes: "our container can't fetch it … that fetch is a datacenter IP; Discord's proxy is not". Threads video is a 302 to Discord's own proxy, never a remux or a byte proxy. | `src/platforms/threads/normalize.ts`, `src/mediaproxy.ts` |
| Google translate endpoint | Measured 2026-07-31 from a Worker: answers in 13-16 ms and is not blocked from Cloudflare's egress. It does rate-limit bursts, and ~30 requests in a few seconds drew HTTP 429 on every one. | `src/translate.ts` |
| Twitter guest endpoints | Byte-identical from residential and Cloudflare Workers egress in the 2026-07-19 recon; the activation and `TweetResultByRestId` were both measured working. | `src/platforms/twitter/fetch.ts`, `:129`, `:147` |
| YouTube via yt-dlp | Not datacenter-IP-blocked. Measured 2026-07-22 from Cloudflare Container egress: a `{page}` resolve returns a real ad-free MP4. It needed Deno for the signature challenge, not a different IP. | `container/README.md` |
| Instagram copyright recovery (`copyright_recovered`) | Unconfirmed from Cloudflare egress. Every measurement behind it is residential, and the recovery fails silently into a cover still. The counter exists so the failure is visible at all. | `src/analytics.ts` |
| Instagram generally | Instagram's behaviour toward Cloudflare is PATH-DEPENDENT: a residential result does not transfer to Workers egress by itself. | `src/platforms/instagram/fetch.ts` |

### What changes on a different host

A residential connection would probably get the Facebook `/share` 302 the public instance cannot,
and avoid the ~81 KB Instagram shell. Threads video bytes may be fetchable directly, which mbedfx
does not attempt. Reddit's anonymous `.json` would most likely stay blocked, that block looking as
much like bot detection as datacenter detection, and nothing measures it either way. Google's limit
is on burst rate and not on address. A move buys nothing there, and an instance with a cold cache
bursts harder than the public one.

A VPS or cloud host sits in the same category as the public instance, possibly worse: a smaller
provider's ranges are often blocked more aggressively than Cloudflare's. None of the ten rows above
transfer to a different datacenter operator. Every one was taken from a residential laptop or from
Cloudflare, none from AWS, Hetzner, a home server or anywhere else.

`translate_fallback`, `copyright_gql` / `copyright_recovered` / `copyright_remux` and
`fullpage_recovered` exist to make an egress-wide block visible, where the cards keep rendering and
the failure is otherwise silent (`src/analytics.ts`).

---

## What replaces each binding, and what degrades without it

| Surface | Where it is declared | What the code calls | Replace with | Without it |
|---|---|---|---|---|
| `ASSETS` | `src/analytics.ts:91` | one call: `env.ASSETS.fetch(req)` (`src/worker.ts:3373`) | any static file server over `public/`, taking a `Request` and returning a `Response` | Required, about six lines of Node. Only the landing and converter pages touch it; both throw without it. |
| `MEDIA_CACHE` (R2) | `src/analytics.ts:96` | `head(key)`, `get(key)`, `get(key, {range:{offset,length}})`, `put(key, stream\|ArrayBuffer\|string)` | any S3-compatible store, or a directory on disk. The test fake is a `Map` in 15 lines (`test/media-resolver.test.mjs`) | Optional. The mux is never cached: remux videos re-mux forever or get stripped, the card falls back to its cover still on every view, translations lose their cross-request cache, and yt-dlp metadata is re-extracted every time (2.4-3.1 s per Facebook video). |
| `MEDIA_RESOLVER` (Durable Object) | `src/analytics.ts:95` | `resolver.getByName(name).fetch(url, init)` and nothing else | an object whose `getByName(name)` returns `{ fetch }` pointed at the container. The name is a pooling slot (`resolver-{generation}-{0..N}`), one container or several | Optional. Without it or without `MEDIA_CACHE`, `withResolver` strips every `remux` video and those platforms render a cover still (`src/worker.ts`). |
| `AE` (Analytics Engine) | `src/analytics.ts:90` | one call: `env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })` (`src/analytics.ts`) | anything with a `writeDataPoint` method: a Prometheus counter, a StatsD client, a log line. The full schema is in `docs/METRICS.md` | Optional. Every card still renders, and the one signal that would report a refused egress is gone. |
| `AI` (Workers AI) | `src/analytics.ts:102` | `ai.run(model, input)`, `FALLBACK_MODEL = '@cf/google/gemma-4-26b-a4b-it'` (`src/translate.ts:276`) | any model behind a `run(model, input)` shim | Optional. Translation falls back to Google's endpoint alone; if that is also refused from your egress, translation stops and every card renders untranslated. |
| `caches.default` | `src/worker.ts`, behind `CacheLike` (`src/worker.ts`) | `match(url)` / `put(url, Response)` with a synthetic `https://cache.mbedfx.internal/…` key (`src/cache.ts`) | a `Map` (what the tests use), Redis, or a disk cache. **Not** a per-process `Map` across more than one process | Required by the type, trivial to satisfy. With a weak one, every paste refetches upstream, and Discord fetches roughly three times per paste (`src/worker.ts`). Cloudflare's Cache API is itself only per-datacenter: a self-hosted shared cache is arguably better than what the public instance has ([Cloudflare docs: "the contents of the cache do not replicate outside of the originating data center"](https://developers.cloudflare.com/workers/runtime-apis/cache/)). |
| `ExecutionContext` | parameter of `handle` | `ctx.waitUntil(p)` only, nine sites in `src/worker.ts` | `{ waitUntil(p) { … } }` that tracks the promise and keeps the process alive until it settles | Required. `waitUntil` is what releases in-flight container slots, keeps a mux running past the response, and writes the response cache. A no-op silently cancels all three, and the symptom is "videos never appear". |
| `cf: { cacheEverything, cacheTtl }` | `src/platforms/twitter/fetch.ts:349` | reuses one Twitter guest-token activation for `GUEST_TOKEN_TTL` = 7200 s (`:160`) | any 2-hour cache wrapped around that one POST | Silently ignored off Cloudflare: every request mints a fresh guest token. A token has roughly a 500-request budget, which keeps this from being fatal. The cost is one extra request to Twitter per cold card, and a plausible source of rate-limiting that does not show up here. |

Secrets are plain strings on `Env` and map straight onto environment variables: `RESOLVER_SECRET`,
`IMGUR_CLIENT_ID`, `TRANSLATE_GOOGLE`, `IG_GRAPHQL_DOC_ID`, `X_ACCOUNTS`, `IG_ACCOUNTS`,
`YT_ACCOUNTS`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (`src/analytics.ts:106-194`). A Worker
secret is encrypted at rest and never on disk (`src/analytics.ts`). On a self-hosted box the same
values sit in a plain file, the threat model FxEmbed's encrypted-bundle design was answering. Fill
`IG_ACCOUNTS` or `YT_ACCOUNTS` and you take that trade-off on.

---

## Two corrections before a public deployment

A private instance runs without either one; a public one does not.

### `OWN_HOSTS`

The fediverse routes take an instance hostname straight from the URL path and make it the origin of
a fetch. `fetchableInstance` (`src/platforms/fedihost.ts`) refuses mbedfx's own zones, and the list
is the whole guard:

```ts
const OWN_HOSTS = ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'workers.dev']  // :53
```

Serve on `embed.example.com` without adding it, and `/…/embed.example.com/post/1` makes the service
fetch itself. On Cloudflare that re-enters through the edge and bypasses the zone's own WAF; on a
self-hosted box it is a self-request loop and an internal-service reach. Whatever domain you serve
from has to be in that list. The test is `host === h || host.endsWith('.' + h)`: one apex entry per
zone covers every subdomain. `fetchableInstance` also takes an optional `self` origin, and the
Worker threads none in (`src/worker.ts`). Doing so would make the guard depend on a request field
every test stub would then have to supply.

### DNS and private-range guarding in the Worker half

The Worker half has no DNS or private-range guard. `src/platforms/fedihost.ts` records the gap:

> WHAT THIS DOES NOT COVER, said plainly: a PUBLIC hostname that resolves to a private address. No
> DNS resolution happens here and there is no TOCTOU-free way to add one in a Worker; Cloudflare's
> docs are silent on whether `fetch()` blocks private ranges at all.

Three other clauses bound what is left: no credential is ever attached, the body is capped, and the
response must be the right shape. On Cloudflare that leaves a blind GET as the worst case. On a Node
host inside your network the same blind GET reaches `127.0.0.1`, the LAN, and the link-local cloud
metadata endpoint on `169.254.169.254`.

`container/server.py` already resolves each host and refuses those ranges. The Worker half needs the
same check, which nobody has written; Cloudflare has never needed it.

---

## The plan

### The container alone, today

No code required: the three commands above, with `RESOLVER_SECRET` set.

### A Node adapter, with no changes under `src/`

One new file, plus packaging, against exports that already exist:

- an `env` object literal: `ASSETS` over `public/`, optional `AE` / `AI` / `MEDIA_CACHE` /
  `MEDIA_RESOLVER`, secrets read from `process.env`;
- a `ctx` whose `waitUntil` is the tracking one above, never a no-op;
- a `CacheLike`: a `Map` to start, something shared before it is more than one process;
- `Deps` copied verbatim from the default export;
- HTTP glue: `IncomingMessage` → `Request`, `Response` → `ServerResponse`, streaming the body.

That lands as `adapters/node/server.ts`, a Dockerfile for it, and a compose file next to the resolver
container. The adapter is finished when the same paste renders the same card from it as from
production, on the platforms the egress table does not affect.

### The corrections that make it safe to expose

- `OWN_HOSTS` configurable, and documented as mandatory.
- A DNS-resolution private-range guard in the Worker half, ported from `container/server.py`.
- A replacement for the `cf` fetch-cache on the Twitter guest-token activation.
- A persistent, shared `CacheLike` in place of a per-process `Map`.
- `FixedLengthStream`'s buffering fallback reviewed under real load: off Cloudflare, every mux is
  buffered into memory up to the container's own 375 MB ceiling (`src/worker.ts`).

### Measuring the egress

Run the fetchers from the host you plan to use and compare against the table above: Reddit's
anonymous `.json`, a Facebook `/share/{code}`, an Instagram embed for a known-public post, a Threads
`scontent` video URL, and a Google translate call. Record the results here with the date and the
host type.
