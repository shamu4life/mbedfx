# Self-hosting mbedfx

Nothing here has been run outside Cloudflare Workers: no Node adapter, no Dockerfile for the Worker,
no compose file. `container/` is the only piece that should run unchanged, in the three commands
below, and nobody has run it that way.

What HAS landed, 2026-08-12, is the set of corrections that would make exposing a self-hosted
instance safe rather than the adapter that would run one: the private-address guard the Worker half
never had (`src/netguard.ts`), a configurable `OWN_HOSTS`, a guest-token cache that works on both
runtimes, a bound on the mux buffering fallback, and the `CacheLike` contract written down. All of
it is code with offline tests and none of it is a deployment report. See
[Before a public deployment](#before-a-public-deployment).

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

`container/server.py`'s `do_POST` checks `X-Resolver-Secret` only when `RESOLVER_SECRET` is set.
Unset, that second command is an unauthenticated remuxer that fetches and downloads whatever any
caller names. Do not publish it or bind it to a public interface.

`container/Dockerfile:16` installs an x86_64 Deno binary and `container/README.md:264` requires
linux/amd64, which `--platform` pins above. What an arm64 build produces is unrecorded; nobody has
built or resolved on one.

**Size the host for yt-dlp's extraction, not for ffmpeg's remux.** The public instance ran the
resolver on a quarter of a vCPU until 2026-08-28 and paid 14-17 s per YouTube extract for it; on one
vCPU the same extract measured 3.1-4.7 s per client from the same egress that day. For a long time
that 15.9 s was read as YouTube throttling a datacenter IP, and it was our own CPU. The gain stops
dead at one vCPU, because the hot path is single-threaded Python and an `ffmpeg -c copy` remux, so
four cores buy nothing over one. `wrangler.jsonc` now asks for `standard-2` (1 vCPU, 6 GiB memory,
12 GB disk); a self-hoster wants at least one dedicated core and enough disk for `MAX_BYTES` plus the
unmerged tracks.

---

## The audit

### The test suite

`npm test` is `node --test` and nothing else (`package.json`): no loader, no flags, no build step, no
bundler, no `wrangler`, no network. Node strips the TypeScript types and imports `src/worker.ts` as
written.

Re-measured on this tree 2026-08-12: 1343 tests, 0 failures, 30.6-34.7 s across runs, on Node
v26.5.0 on a residential macOS laptop, replacing 1207 tests in 19.3-20.1 s measured 2026-08-05, and
1185 tests in 19.9 s on 2026-08-04. The +136 are this phase's self-hosting corrections and the
suite's own growth; the wall-clock difference is a different machine as much as a bigger suite, so
read the run time as "still well under a minute", not as a regression anybody measured. CI pins Node
22.18.0 (`.node-version`) and runs the same command, commented "No network, no container, no R2.
The whole suite runs on captured bytes and fake bindings" (`.github/workflows/ci.yml:44`).

Thirteen test files import the production handler itself (`import { handle } from
'../src/worker.ts'`) and drive the media/mux path, the translation deadline, the YouTube date path,
the media proxy and `/_prep`, with object literals standing in for the bindings. That proves the
module graph loads and executes under Node, and nothing more.

### The adapter entry point

`env`, `ctx` and `Deps` are ordinary parameters of `handle()` in `src/worker.ts`, and the
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
AE?: { writeDataPoint(x: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }  // :183
ASSETS: { fetch(req: Request): Promise<Response> }                                              // :184
AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }                   // :195
```

The other two are optional Cloudflare types, `MEDIA_RESOLVER?: DurableObjectNamespace` (`:188`) and
`MEDIA_CACHE?: R2Bucket` (`:189`). The suite fakes both with object literals and runs the entire
`/_media/` mux path against them under Node: `MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) }`
and a `fakeR2()` doing head / get / get-with-range / put over a `Map`
(`test/media-resolver.test.mjs`).

Outside `Env`, `caches.default` is reached only through the hand-written `CacheLike` injected via
`Deps` (`src/worker.ts`). `ExecutionContext` is
used for `ctx.waitUntil` and nothing else, across FIFTEEN call sites in `src/worker.ts`, with no
`passThroughOnException`, `ctx.props` or `ctx.exports`. Reproduce it with
`grep -cE 'ctx\??\.waitUntil\(' src/worker.ts` — the `\??` matters, because one site is
optional-chained and a literal grep for `ctx.waitUntil` misses it, and the `\(` matters because it
is what separates the invocations from the prose.

**Do not trust this number without re-running that.** It has been wrong twice: an early revision
printed 13 (the literal grep, comments included), a later one said nine, and the count has only gone
up since — every mux the alarm arms and every response-cache write adds one. Dropping the `\(`
matches 25 lines today, ten of them prose inside comments.

### Workers-only globals

Exactly one Workers-only global sits on the request path, feature-detected in `putMuxed`:

```ts
// src/worker.ts, putMuxed
if (typeof FixedLengthStream !== 'undefined' && len !== null) {
```

`FixedLengthStream` is absent under `node --test`. The streaming path serves production; below the
check are the two paths that serve the unit tests and every self-hosted runtime: `putStream` if the
store implements it, else a buffer bounded by `MUX_BUFFER_MAX`. See
[the mux buffering fallback](#the-mux-buffering-fallback-bounded).

`crypto.subtle.digest` (`src/worker.ts`) is standard in Node. The rest of `src/` reaches for no
runtime API: no `HTMLRewriter` or `WebSocketPair`, no `caches` inside `handle`, no read of
`request.cf`. No file under `src/` imports a `cloudflare:` module by name; the one
`@cloudflare/containers` import, which pulls `cloudflare:workers` in behind it, lives in
`src/container.ts:1`, a file that exists so it can be excluded:

> THE ONLY FILE THAT IMPORTS @cloudflare/containers. That package pulls in `cloudflare:workers`, a
> module that exists only in the Workers runtime, so importing it under `node --test` throws. Keeping
> it here, reached solely through the deploy entry src/index.ts and never through the test-imported
> worker.ts, is what lets the suite keep running in plain Node.
> Source: `src/container.ts`

A Node port needs the same boundary: nothing on the request path may import that file.

### The container has no Cloudflare surface

`container/server.py` imports only the standard library (`ipaddress`, `json`, `os`, `socket`,
`subprocess`, `tempfile`, `time`, `urllib.error`, `urllib.request`, `http.server`, `urllib.parse`);
the client probe added `time`, `urllib.error` and `urllib.request` and needed nothing outside that
library. The file's last three lines are the whole entry point:
`port = int(os.environ.get("PORT", "8080"))` under `if __name__ == "__main__":`, then
`ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()`. A line count used to stand here
and it was wrong by a third within a month, so the entry point is named rather than numbered.

`container/Dockerfile` is `python:3.12-slim` plus ffmpeg, `yt-dlp[default,curl-cffi]` pinned to an
exact STABLE release and a static Deno binary, `EXPOSE 8080`, `CMD ["python", "server.py"]`. None of
it needs porting.

The yt-dlp version is deliberately not repeated here. `.github/workflows/ytdlp-freshness.yml`
PROPOSES a bump weekly, so a number written into this page would be wrong within days and would send
self-hosters to a build that cannot play YouTube — read the pin off `container/Dockerfile`, which is
the only place it lives. The Dockerfile explains why the channel is stable rather than nightly (an
owner decision, 2026-08-18; the job reads PyPI's newest stable and refuses a pre-release string
outright), and why the pin is exact rather than a floor — reproducibility and a one-line revert, not
Docker layer caching, which the 2026-08-29 correction there retracts.

**What the weekly job cannot do is merge, and a pin nobody merges goes stale silently.** When a bump
did arrive — 2026.8.19, detected 2026-08-24 — the job pushed the branch, could not open a pull
request (the repository's "Allow GitHub Actions to create and approve pull requests" setting was
off) and fell back to raising an issue, exactly as designed. Branch and issue then sat four days.
The setting was turned on on 2026-08-28. If you fork this, the fallback matters more than the happy
path: check that the pin has actually moved rather than that the workflow is green.

The image has not been re-exercised outside Workers, though `server.py` itself has: it answered
`/health`, enforced `X-Resolver-Secret` and refused every SSRF probe on a stock interpreter with no
container at all, 2026-08-08 on macOS x86_64. `container/README.md` documents that path under
[Running it standalone](../container/README.md#running-it-standalone).

#### The `/resolve` contract

From the module docstring and `do_POST` in `container/server.py`. **`POST /resolve`**, JSON body:

```jsonc
{ "video": "<url>", "audio": "<url>"|null }   // ffmpeg -c copy mux of tracks already extracted
{ "page":  "<url>" }                          // yt-dlp resolves + merges (any yt-dlp-supported site)
{ "page":  "<url>", "meta": true }            // METADATA ONLY: one `yt-dlp -J`, no download
{ "probe": true }                             // DIAGNOSTIC: extract PROBE_VIDEO with every client in
                                              // PROBE_CLIENTS, then range-fetch each chosen format
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
| `200 application/json` | meta mode, a passthrough of `yt-dlp -J`; or probe mode, `{ok, video, ytdlp, ms, serving, clients}` |
| `4xx/5xx application/json` | `{"error": "..."}`. `400` bad json / `need 'page' or 'video'` / invalid source; `401` unauthorized; `404` not found; `502` mux failed, meta failed, empty or oversized result; `504` mux timed out, meta timed out; `500` internal error |
| `GET /health` | `200 ok` |

stderr is suppressed on failure; it can carry the source URL.

**Environment** (no longer one block: `MAX_SECONDS`, `MAX_BYTES` and `PROC_TIMEOUT` at the top of
`container/server.py`, `MUX_PAGE_TIMEOUT` under the note that argues it, `RESOLVER_SECRET` further
down among the module constants, `PROBE_TIMEOUT` beside the client probe, and `PORT` read once in
the entry point): `PORT` (8080), `RESOLVER_SECRET` (unset = no auth), `MAX_SECONDS` (1500),
`MAX_BYTES` (393216000, a 375 MB output ceiling), `PROC_TIMEOUT` (120 s, per subprocess EXCEPT the
page mux), `MUX_PAGE_TIMEOUT` (360 s, the `{page}` mux alone) and `PROBE_TIMEOUT` (45 s per client,
read only by the client probe). `server.py` is authoritative whenever
`container/README.md` disagrees, and the README has carried a stale pair before. `MAX_SECONDS` and
`MAX_BYTES` were raised together on 2026-08-03 and have to move together: the mux is `-c copy`, and
output size is the source bitrate times the duration.

`MUX_PAGE_TIMEOUT` is the one most worth setting deliberately. It was `PROC_TIMEOUT + 60` (180 s)
until 2026-08-29, which is less than the download a `MAX_SECONDS` video needs — so a long video was
SIGKILLed with nothing written, on every attempt, forever. If your egress is slower than
Cloudflare's, raise it or lower `MAX_SECONDS`; a video admitted and then killed is worse than one
refused.

**Security, already in the container** (docstring, `container/server.py`):

- `X-Resolver-Secret`, required on every `/resolve` when `RESOLVER_SECRET` is set
- the scheme checked to http/https
- every host resolved, and refused on a private, loopback, link-local, reserved or multicast address
- `-protocol_whitelist` on ffmpeg, with no `file:`, `concat:` or `data:`
- a URL beginning with `-` rejected outright, subprocesses as argv lists rather than a shell, and a
  `--` end-of-options guard on yt-dlp

---

## Egress IP

Platforms answer a datacenter IP differently from a residential one, in both directions. Some of
that difference is a FLAP rather than a rule, and since 1.11.0 the fetchers no longer take a single
refusal as the answer: `src/fetchretry.ts` carries one extra ask (`askTwice`, `ASK_ATTEMPTS = 2`,
retried on 408, 425, 429 and 5xx) across twenty-seven call sites in sixteen platform fetchers,
YouTube's among them since 1.12.0. So read the rows below as what a host is refused TWICE, not once.

| Platform / surface | Measured | Where |
|---|---|---|
| Reddit anonymous `.json` | Verified 2026-07-21: Workers egress gets a 403 "network security" block page. `embed.reddit.com` is not blocked, and is the primary credential-free path. | `src/platforms/reddit/fetch.ts` |
| Reddit embed with a placeholder subreddit | Measured from Workers egress 2026-07-22: a placeholder sub gets a stripped render. The real subreddit has to be passed. | `src/platforms/reddit/fetch.ts` |
| Facebook `/share/{code}` 302 | Measured on one share code: a browser-shaped request from a laptop gets `302 -> /posts/…`, the same request from Cloudflare's egress gets none. Confirmed by natural experiment against the live worker. | `src/platforms/metashare/fetch.ts` |
| Instagram embed | From datacenter egress the embed returned an ~81 KB "unavailable" shell and a public post rendered as private. Residential egress never reproduced it, and it reached production. | `src/worker.ts:368` |
| Threads video (`scontent*.cdninstagram.com`) | Meta blocks Cloudflare's datacenter egress for these bytes: "our container can't fetch it … that fetch is a datacenter IP; Discord's proxy is not". Threads video is a 302 to Discord's own proxy, never a remux or a byte proxy. | `src/platforms/threads/normalize.ts`, `src/mediaproxy.ts` |
| Google translate endpoint | Measured 2026-07-31 from a Worker: answers in 13-16 ms and is not blocked from Cloudflare's egress. It does rate-limit bursts, and ~30 requests in a few seconds drew HTTP 429 on every one. | `src/translate.ts` |
| Twitter guest endpoints | Byte-identical from residential and Cloudflare Workers egress in the 2026-07-19 recon; the activation and `TweetResultByRestId` were both measured working. | `src/platforms/twitter/fetch.ts`, `:129`, `:147` |
| YouTube via yt-dlp | Not datacenter-IP-blocked, and measured PER PLAYER CLIENT since 2026-08-28. A `{page}` resolve returned a real ad-free MP4 from Cloudflare Container egress on 2026-07-22; it needed Deno for the signature challenge, not a different IP. `/_clients` then extracted one video with six clients on that egress and range-fetched each chosen format: `default`, `web_embedded`, `tv_simply`, `mweb` and `web_safari` all served bytes with NO PO token, and only `android_vr` was refused (`http-403`). `tv_simply` and `mweb` are the two clients yt-dlp's PO Token Guide says require one, so a token provider buys a self-hoster on datacenter egress nothing. Refusals are intermittent rather than absolute — worth one retry, not a verdict. | `src/worker.ts` (`/_clients`), `container/README.md` |
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
| `ASSETS` | `Env`, `src/analytics.ts` | one call: `env.ASSETS.fetch(req)` (`src/worker.ts`) | any static file server over `public/`, taking a `Request` and returning a `Response` | Required, about six lines of Node. Only the landing and converter pages touch it; both throw without it. |
| `MEDIA_CACHE` (R2) | `Env`, `src/analytics.ts` | `head(key)`, `get(key)`, `get(key, {range:{offset,length}})`, `put(key, stream\|ArrayBuffer\|string)`, and OPTIONALLY `putStream(key, stream, length\|null)` | any S3-compatible store, or a directory on disk. The test fake is a `Map` in 15 lines (`test/media-resolver.test.mjs`) | Optional. The mux is never cached: remux videos re-mux forever or get stripped, the card falls back to its cover still on every view, translations lose their cross-request cache, and yt-dlp metadata is re-extracted every time (2.4-3.1 s per Facebook video). Implement `putStream` if your store takes a stream. Without it, muxes are buffered in memory up to `MUX_BUFFER_MAX` and refused above it. |
| `MEDIA_RESOLVER` (Durable Object) | `Env`, `src/analytics.ts` | `resolver.getByName(name).fetch(url, init)` and nothing else | an object whose `getByName(name)` returns `{ fetch }` pointed at the container. The name is a pooling slot (`resolver-{RESOLVER_GENERATION}-{0..N}` — that string names the instances and nothing stored; `META_GENERATION` is the one that scopes cached records), one container or several | Optional. Without it or without `MEDIA_CACHE`, `withResolver` strips every `remux` video and those platforms render a cover still (`src/worker.ts`). |
| `AE` (Analytics Engine) | `Env`, `src/analytics.ts` | one call: `env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })` (`src/analytics.ts`) | anything with a `writeDataPoint` method: a Prometheus counter, a StatsD client, a log line. The full schema is in `docs/METRICS.md` | Optional. Every card still renders, and the one signal that would report a refused egress is gone. |
| `AI` (Workers AI) | `Env`, `src/analytics.ts` | `ai.run(model, input)`, `FALLBACK_MODEL = '@cf/google/gemma-4-26b-a4b-it'` (`src/translate.ts:276`) | any model behind a `run(model, input)` shim | Optional. Translation falls back to Google's endpoint alone; if that is also refused from your egress, translation stops and every card renders untranslated. |
| `caches.default` | `src/worker.ts`, behind `CacheLike` (`src/worker.ts`) | `match(url)` / `put(url, Response)` with a synthetic `https://cache.mbedfx.internal/…` key (`src/cache.ts`) | a `Map` (what the tests use), Redis, or a disk cache. **Not** a per-process `Map` across more than one process. The five promises an implementation makes (honour `cache-control: max-age`, hand back a readable body, be shared across processes, never reject, key on the exact string) are the `CacheLike` docstring in `src/worker.ts`; `test/selfhost.test.mjs` fails if the worker starts calling a third method | Required by the type, trivial to satisfy. With a weak one, every paste refetches upstream, and Discord fetches roughly three times per paste (`src/worker.ts`). Cloudflare's Cache API is itself only per-datacenter: a self-hosted shared cache is arguably better than what the public instance has ([Cloudflare docs: "the contents of the cache do not replicate outside of the originating data center"](https://developers.cloudflare.com/workers/runtime-apis/cache/)). |
| `ExecutionContext` | parameter of `handle` | `ctx.waitUntil(p)` only, fifteen sites in `src/worker.ts` | `{ waitUntil(p) { … } }` that tracks the promise and keeps the process alive until it settles | Required. `waitUntil` is what releases in-flight container slots, keeps a mux running past the response, and writes the response cache. A no-op silently cancels all three, and the symptom is "videos never appear". |
| `OWN_HOSTS` | `src/analytics.ts` | added to the built-in own-zone list in `src/platforms/fedihost.ts` | every domain you serve from, comma- or whitespace-separated, hostname or origin | **Set it.** Unset, the fediverse routes will fetch your own domain if somebody asks them to. Additive, so a wrong value can only make the guard stricter. |
| `RESOLVE_HOST` | `src/analytics.ts` | `blockedResolvedHost` in `src/netguard.ts`, before every fediverse fetch | `async (host) => (await dns.lookup(host, { all: true })).map(a => a.address)` | Optional, strongly recommended off Cloudflare. Without it the address guard is literal-only, which is all a Worker can ever do, so `evil.example.com IN A 127.0.0.1` is not caught. |
| `MUX_BUFFER_MAX` | `src/analytics.ts` | `putMuxed` in `src/worker.ts` | bytes, as a string. Default 64 MB | Optional. Raise it if you have memory and no `putStream`; a video above it is not cached and its card degrades to the cover still. |
| `cf: { cacheEverything, cacheTtl }` | `src/platforms/twitter/fetch.ts` | reuses one Twitter guest-token activation for `GUEST_TOKEN_TTL` = 7200 s | nothing to supply any more: a process-local memo with a shared in-flight promise does the same job on both runtimes | Was silently ignored off Cloudflare, so every cold card minted a fresh guest token. A token has roughly a 500-request budget, so the cost was one extra request to Twitter per cold card and a source of rate-limiting invisible from the code. Now bounded to one activation per process per two hours. |

Secrets are plain strings on `Env` and map straight onto environment variables: `RESOLVER_SECRET`,
`IMGUR_CLIENT_ID`, `TRANSLATE_GOOGLE`, `IG_GRAPHQL_DOC_ID`, `X_ACCOUNTS`, `IG_ACCOUNTS`,
`YT_ACCOUNTS`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (all on `Env` in `src/analytics.ts`). A Worker
secret is encrypted at rest and never on disk (`src/analytics.ts`). On a self-hosted box the same
values sit in a plain file, the threat model FxEmbed's encrypted-bundle design was answering. Fill
`IG_ACCOUNTS` or `YT_ACCOUNTS` and you take that trade-off on.

---

## Before a public deployment

A private instance runs without any of this; a public one does not. Everything in this section is
code that is now in the tree. What is left is the settings you have to fill in and the one thing
that still cannot be fixed from inside a Worker.

Nothing below has been measured against a running self-hosted instance, because there is not one.
It is code with offline tests (`test/netguard.test.mjs`, `test/selfhost.test.mjs`), not a deployment
report.

### `OWN_HOSTS`, and setting it

The fediverse routes take an instance hostname straight from the URL path and make it the origin of
a fetch. `fetchableInstance` (`src/platforms/fedihost.ts`) refuses mbedfx's own zones:

```ts
const OWN_HOSTS = ['mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'workers.dev']
```

Serve on `embed.example.com` without declaring it, and `/…/embed.example.com/post/1` makes the
service fetch itself. On Cloudflare that re-enters through the edge and bypasses the zone's own WAF;
on a self-hosted box it is a self-request and, with the wrong DNS, an internal-service reach.

Set `OWN_HOSTS` on the env to every domain you serve from, whitespace- or comma-separated, as
hostnames or origins:

```sh
OWN_HOSTS="embed.example.com https://staging.embed.example.com"
```

- The value is **added** to the built-in list, never substituted for it. A typo, an empty value or a
  hostile one cannot un-block mbedfx's zones, so every way of getting this wrong is "too strict".
- One apex entry covers every subdomain: the test is `host === h || host.endsWith('.' + h)`.
- Unset is a **misconfiguration, not an open door**. The built-in list, the address guard below and
  the response-shape assert all still stand; what is left reachable is your own public domain, which
  resolves to your own public address, and the self-request lands on a path this Worker does not
  serve as an API and renders "couldn't load".
- `fetchableInstance` also takes an optional `self` origin, and the Worker still threads none in
  (`src/worker.ts`). Doing so would make the guard depend on a request field every test stub would
  then have to supply, for a host you can simply declare.

### DNS and private-range guarding in the Worker half

`src/netguard.ts` is the port of `container/server.py`'s `_safe_url`, in two halves.

**The literal half runs everywhere, including on Cloudflare.** It parses a hostname to bytes and
range-checks them, so every spelling of one address gets one verdict: `127.0.0.1`, `127.1`,
`2130706433`, `0177.0.0.1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, `64:ff9b::7f00:1` and
`2002:7f00:1::` are all loopback. Covered: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`
(including `169.254.169.254`), `172.16/12`, `192.168/16`, `198.18/15`, the documentation ranges,
`224/4`, `240/4`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, NAT64, 6to4, and the
IPv4-mapped/-compatible forms of all of the above. It also refuses `localhost`, `.local`,
`.internal`, `.lan`, `.home.arpa` and `.arpa` names, which `FEDI_HOST` admits as soon as they carry
a dot (`api.localhost` passes that regex; `localhost` does not).

**The DNS half is yours to wire.** `env.RESOLVE_HOST` is a function, not a wrangler binding. A
Worker has no resolver, so on Cloudflare it is permanently undefined and the literal check is the
whole guard. In a Node adapter it is three lines:

```ts
import dns from 'node:dns/promises'
env.RESOLVE_HOST = async (host) => (await dns.lookup(host, { all: true })).map(a => a.address)
```

With it wired, `evil.example.com IN A 127.0.0.1` is refused **before** the request is made, and a
name with one public address and one private one is refused too, because every address is checked, as
`getaddrinfo` is in the container. A resolver that throws or answers with nothing fails closed.

What it still cannot promise: DNS rebinding. Between the resolution and the fetch's own, a record
with a one-second TTL can change; closing that needs pinning the connection to the address that was
checked, which neither `fetch()` nor Workers exposes. The bound on the residual is unchanged: no
credential is attached, the body is capped, and the response must be the right shape, so the worst case
stays a blind GET.

### The Twitter guest token

`getGuestToken` kept its `cf: { cacheEverything, cacheTtl }` and gained a process-local memo with a
shared in-flight promise (`src/platforms/twitter/fetch.ts`). The `cf` option is a Cloudflare-only
field and is silently ignored elsewhere; without the memo, every cold card off Cloudflare minted a
fresh guest token. A token has roughly a 500-request budget, so the symptom was never an outage.
It was Twitter rate-limiting an instance for a reason invisible from the code. N processes still
hold N tokens, which is the same weakness the `cf` cache had (it is per-colo) and is bounded.

### The mux buffering fallback, bounded

`FixedLengthStream` is a Workers global, and `putMuxed` (`src/worker.ts`) used it to stream a muxed
MP4 into R2 without buffering. Off Cloudflare it does not exist, so every mux took the fallback:
`cache.put(key, await muxed.arrayBuffer())`, the whole video in memory. The comment called that
"bounded by the container's own MAX_BYTES output cap", which is true and is a bound of the wrong
size. `MAX_BYTES` is 393216000, a **375 MB** output ceiling, beside `MAX_SECONDS` 1500
(`container/server.py`), and `RESOLVER_SLOTS` is 4. Four ordinary long videos, no attacker: 1.5 GB
resident.

Three paths now, in order of how little memory they hold:

1. `FixedLengthStream` plus a `content-length` is the Workers production path, unchanged. The
   container always sends the header (`send_header("content-length", str(size))`).
2. `MEDIA_CACHE.putStream(key, stream, length)`: **implement this** if your store can take a
   stream (a file write, an S3 multipart upload). R2 cannot, which is why `FixedLengthStream` exists
   at all. A store that implements it never buffers and is not subject to the ceiling.
3. Buffering, capped at `MUX_BUFFER_MAX` (default 64 MB, env-overridable). Bodies with no
   `content-length` are read with a running total and abandoned at the cap rather than measured
   after the fact. Past the cap the object is **not stored**: that view degrades to the cover still,
   exactly as a failed mux does, and a line goes to stderr.

64 MB is chosen against the ~128 MB Workers isolate ceiling, not against a measured distribution of
video sizes, and nobody has measured that. The cost of the refusal is real: an over-ceiling video
re-muxes on every view. `putStream` is the fix; raising `MUX_BUFFER_MAX` is the workaround for an
operator with memory to spend.

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

Done, in the tree, with offline tests:

- `OWN_HOSTS` configurable and additive, documented as mandatory above.
- The private-range guard ported from `container/server.py` into `src/netguard.ts`, with a
  `RESOLVE_HOST` seam for the DNS half a Worker cannot do.
- The `cf` fetch-cache on the Twitter guest-token activation joined by a memo that works on both
  runtimes.
- `FixedLengthStream`'s buffering fallback bounded by `MUX_BUFFER_MAX`, with a `putStream` seam for
  a store that can take a stream.
- The `CacheLike` contract written down as five promises and pinned by a test.

Still open:

- An actual shared `CacheLike` implementation. Deliberately NOT in this repo: it would mean a client
  library and a dependency for one of two runtimes. The seam is two methods wide; the store is the
  operator's choice.
- Everything here is code and tests, not a deployment. None of it has been exercised against a
  running instance off Cloudflare, because there is not one yet.

### Measuring the egress

Run the fetchers from the host you plan to use and compare against the table above: Reddit's
anonymous `.json`, a Facebook `/share/{code}`, an Instagram embed for a known-public post, a Threads
`scontent` video URL, and a Google translate call. Record the results here with the date and the
host type.

**YouTube has an instrument rather than a procedure.** `GET /_clients` runs `container/server.py`'s
probe on your own resolver: it extracts one fixed video with each client in `PROBE_CLIENTS` and then
range-fetches the format each one chose, so it reports bytes rather than a format list. That
distinction is the point — a client can list formats and still be refused by googlevideo, and only the
range fetch tells them apart. Run it from the egress you intend to serve from before concluding
anything about YouTube on your host, because every claim in this project that was reasoned from a
laptop and not re-measured this way turned out to be wrong in one direction or the other.
