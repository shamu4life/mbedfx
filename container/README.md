# media-resolver: the mbedfx video remux/resolve container

A small ffmpeg + yt-dlp service, a single-purpose Cobalt run in-house so nobody else's uptime or
extractor drift sits in the path. It turns a DASH/HLS video, or any yt-dlp-supported page, into one
progressive faststart MP4 the Worker serves as `og:video`. Reddit, Bluesky and Instagram video goes
through it, and best-effort so do YouTube, Vimeo, Dailymotion, Facebook and the ~1800 other sites
yt-dlp knows. Those posts are cover stills without it.

## Interface

`POST /resolve`, JSON body, reached over the Worker's container binding, never a public route.

```jsonc
{ "video": "<url>", "audio": "<url>"|null }  // mux tracks the Worker extracted (v.redd.it + DASH_audio,
                                             // a bare HLS .m3u8 or DASH .mpd as `video` with no `audio`)
{ "page": "<url>" }                          // yt-dlp resolves + merges (YouTube/Vimeo/FB/…)
{ "page": "<url>", "meta": true }            // METADATA ONLY (yt-dlp -J, no download) — see below
{ "probe": true }                            // DIAGNOSTIC (yt-dlp per client + a range fetch) — see below
```

- **200 `video/mp4`** is the muxed file, streamed. The Worker pipes it straight into R2 and serves
  range reads from there, so each video is muxed at most once.
- **4xx/5xx `application/json` `{"error"}`** means the Worker falls back to the cover still.
- `GET /health` → `200 ok`.

### Meta mode (`{"page": …, "meta": true}`)

`200 application/json`, a dumb passthrough of one `yt-dlp -J`, with no download and no second
subprocess. It exists for platforms whose crawler or oembed metadata is gated from datacenter egress
but whose video yt-dlp still resolves. Facebook is that case: Meta decoys `facebookexternalhit` from
datacenter. Shape:

```jsonc
{ "_type": …, "title": …, "thumbnail": …, "uploader": …, "uploader_id": …, "uploader_url": …,
  "description": …, "width": …, "height": …, "duration": …, "timestamp": …,
  // added 2026-08-01, g8 — a record written before that has none, which is why the generation moved
  "view_count": …, "like_count": …, "comment_count": …, "age_limit": …,
  // added 2026-08-22, g12 — the mux shortcut; see below
  "mux_video": …, "mux_audio": … }
```

Any field may be `null`; `src/worker.ts` treats every field but `title` as optional. Judgement lives
in `src/platforms/facebook/normalize.ts`.

#### `_type`

`_type` carries yt-dlp's own kind, the only field that tells a video from a playlist. Added
2026-07-26, g5. The Worker's content assertion is "`title` is a non-empty string", which an Imgur
album passes. Without `_type` the card would ship a headline over a video url that resolves to
nothing. Measured 2026-07-26, `imgur.com/a/iX265HX` returns `_type: "playlist"` with a title but no
thumbnail, no dimensions, no duration, no timestamp.

#### `width` / `height`

Both fall back to a sized entry in `formats` when the top level has none. A Facebook progressive
`sd`/`hd` format carries no height, and the card would otherwise ship `og:video:width="0"`. The
fallback prefers the tallest entry at or under 720, matching the selector's general `height<=?720` arms. On YouTube the selector's FIRST arm is the `134+140` itag pair (360p, avc1 Main — a third fewer bytes than format 18's Baseline for the same picture), so there the fallback is a looser bound than the truth; it can only over-state.

Since g12 the meta call passes that selector itself (`YT_FORMAT_SELECTOR`, hoisted so `_meta_page`
and `_mux_page` cannot state one rule two ways), so the top-level dimensions describe the format the
mux will pick rather than yt-dlp's default. Verified not to break the age-gated case, which is what
`--ignore-no-formats-error` exists for: measured 2026-08-22 on `yt:G0sORVBL4kM` (`age_limit` 18,
`formats: 0`), with and without `-f` the answer is identical, because the flag suppresses the
"no formats" exit before selection is reached.

#### `mux_video` / `mux_audio`

The direct format urls this same `-J` already resolved, so the Worker's `/_media/` mux can hand them
to `ffmpeg` instead of paying a second, byte-identical extraction. Added 2026-08-22, g12. Measured
2026-08-22 on YouTube: extraction is ~5.0s of player-API round trips plus a Deno JS challenge,
against a 1.8s download of the same 10 MB — and a cold card paid it twice.

A split selection reports both (video first, matching `_mux_tracks`' `0:v:0` / `1:a:0` mapping); a
progressive one reports `mux_video` alone.

**Both are `null` whenever the shortcut cannot be taken safely**, and `_mux_sources` decides that
before yt-dlp's own filter would: a livestream, a duration at or over `MAX_SECONDS`, and — stricter
than the `duration<?N` match filter it mirrors — an **unknown** duration. `duration<?N` admits an
unknown duration because yt-dlp still stops that download on `--max-filesize`; `ffmpeg` reading a
url has no equivalent stop, so handing one over would delete the ceiling silently and a livestream
would run until `PROC_TIMEOUT` burned a container slot.

The Worker treats them as optional at every step, so a pooled pre-g12 instance degrades to the
`{"page": …}` mux that shipped. It must send the tracks **without** `page` beside them: `do_POST`
checks `page` first, so a body carrying both takes the slow path every time.

**These urls are volatile and the meta record is not.** A resolved format url is bound to the egress
IP that resolved it and expires in hours, while the record it would ride in is read back for 30
minutes (Streamable) to 24 hours (Dailymotion, Imgur). `src/worker.ts` carries them beside the
record rather than inside it — see `cachedYtdlpMeta` — so a cache hit has no shortcut by
construction and muxes from the page. The mux tries the tracks and falls back to the page, which is
the only safe way to use a url that can go stale between the two calls.

### Probe mode (`{"probe": true}`)

`200 application/json`. A DIAGNOSTIC, not a serving path: it extracts one fixed video with each client
in `PROBE_CLIENTS` and then RANGE-FETCHES the format that client chose, reporting bytes.

```jsonc
{ "video": "jNQXAC9IVRw", "ytdlp": "2026.08.19", "ms": 20233,
  "serving": ["default", "web_embedded", "tv_simply", "mweb", "web_safari"],
  "clients": [ { "client": "default", "extracted": true, "formats": 24,
                 "gvs": "ok", "bytes": 65536, "ms": 3378 }, … ] }
```

**The range fetch is the whole point.** A client can extract happily and then be refused by
googlevideo, and only fetching bytes tells the two apart — `android_vr` reported `extracted: true,
formats: 1` and served nothing on the first production run. A probe that asserted on a format count
would have called it healthy. This is the same rule the rest of the repo follows: assert on content,
never on status.

It takes NO INPUT. The video id (`PROBE_VIDEO`) and the client list (`PROBE_CLIENTS`) are constants in
`server.py`, which is what makes two runs comparable rather than a measurement of whichever video was
passed. It rides this same authenticated `/resolve`, so it opens no new surface, and its range fetch
goes through `_safe_url` like every other fetch here. `PROBE_TIMEOUT` (45s) bounds each client
separately; the clients run SERIALLY on purpose, because they contend for the same CPU and running
them together would measure the contention rather than the clients.

It is reached in production as `GET /_clients` on the Worker, which wraps this body in an `ok` that
is true when `serving` came back non-empty. Run it when YouTube muxes are failing and `/_smoke` says
everything is fine: no smoke check dispatches a `{page}` remux, which is how a total container outage
stayed 17/17 green on 2026-08-28. Since 2026-08-29 the `yt` row asserts `og:video`, so a dead
container does surface there eventually, but only on the tick that finds R2's copy of that one video
swept by `expire-60d` — about one tick in sixty days. Every other tick reads a warm R2 head and says
nothing about this image.

## `RESOLVER_GENERATION` and `META_GENERATION`

> **Changing the meta-mode response shape above REQUIRES bumping BOTH of them in `src/worker.ts`.**

They were one string until 2026-08-29 and they answer two different questions:

- **`RESOLVER_GENERATION`** is part of the pooled instance NAME. Pooled instances have stable names
  and keep their booted image until `sleepAfter` (5m), so skip this bump and a redeploy under steady
  traffic keeps answering with the old dict, the new fields arrive `undefined`, and the change looks
  inert. Bumping it costs one cold boot per slot and invalidates nothing stored.
- **`META_GENERATION`** is the meta cache's key segment. Bumping it discards stored dates,
  descriptions, counts and gate verdicts across yt, fb, dm, st and im. The longest-lived is
  `YT_META_TTL_MS` at 30 days; fb, dm and im hold for 24h, st for 30 minutes.

So: a response-shape change needs both — the instances have to be replaced AND the records already
written in the old shape have to go. An image change that alters no stored shape needs only the
first. A change to what a stored record MEANS with no container change at all — the Innertube rung
writes these records too, without going near this image — needs only the second.

The rule that used to sit here read "changing the dict requires bumping `RESOLVER_GENERATION`, and so
does any other change to what the container does", which is input-shaped: it asks what changed rather
than what a stored record now says. `src/worker.ts` had to write down 1.9.0 as an exception under it
(the output dict changed and it stayed on g10, because the defect had stopped any record being
written and there was nothing stale to retire). Under the split that stops being an exception.

## The mux

The mux is a stream copy, `-c copy -movflags +faststart`, never a transcode. The caps are
env-overridable, in `container/server.py`: `MAX_SECONDS=1500`, `MAX_BYTES=393216000` (a 375 MB
output ceiling), `PROC_TIMEOUT=120`, and `MUX_PAGE_TIMEOUT=360` for the `{page}` mux alone. Both
size ceilings went up together on 2026-08-03: a stream copy makes output size the source bitrate
times the duration, and raising one alone only moves the refusal to the other filter.

`container/server.py` is the source of truth for all four, and this line has been wrong twice. It
read `MAX_SECONDS=1800` until 2026-07-26, long after the code said 1200, then `1200` / `300MB` until
2026-08-05. It said "all three" until 2026-08-29 and that was correct: `MUX_PAGE_TIMEOUT` and the
`four` here landed in the same commit, so there was never a window with four walls and three named.

The `{page}` mux's match filter is `duration<?{MAX_SECONDS} & !is_live`, currently
`duration<?1500 & !is_live`. The `<?` and `!is_live` shape arrived with g5 on 2026-07-26. `<?` is
yt-dlp's none-inclusive comparison, and the previous `duration < 1200 & duration > 0` silently
excluded every source that declares no duration. An Imgur gifv reports `duration: None` and was
skipped outright (`does not pass filter … skipping ..`, reproduced on `i.imgur.com/A61SaA1.gifv`).
`!is_live` preserves the livestream rejection that `duration > 0` had been providing by accident. A
live source that got through would download until `MUX_PAGE_TIMEOUT` and burn a container slot.

**There are now three guards against a livestream and they are not redundant**, so do not delete one
as a duplicate of another. `_mux_sources` refuses to hand ffmpeg a live source's format urls; the
match filter refuses the download; and since 2026-08-29 `src/worker.ts`'s `settleMux` refuses to
dispatch a YouTube one at all, off `Media.live`, which Innertube sets before the Post exists. The two
here are the container declining work it has been given; the Worker's is the request never being
made — which is the only one that saves the round trip, and the reason it exists is that the round
trip was being paid on every render of a permanently-live channel, forever.

## Deploying it

Merging to `main` builds this image and deploys it. Do **not** run `wrangler deploy` by hand: a hand
deploy overwrites whatever Workers Builds shipped while the dashboard still reports a healthy
Worker.

`wrangler.jsonc` gives `image` a Dockerfile path, `./container/Dockerfile`. Cloudflare's docs say a
Dockerfile `image` makes `wrangler deploy` build it and push it to Cloudflare's registry, and
Workers Builds runs `npx wrangler deploy`. A merge to `main` shows the whole job in the build log,
measured on this repo's own builds:

```
Executing user deploy command: npx wrangler deploy
 - fxeverything-mediaresolver (/opt/buildhome/repo/container/Dockerfile)
Building image fxeverything-mediaresolver:…
Image does not exist remotely, pushing: registry.cloudflare.com/…
digest: sha256:…
├ EDIT fxeverything-mediaresolver
SUCCESS  Modified application fxeverything-mediaresolver
```

None of it needs Docker, a registry login or a dashboard step on your machine.

If a change here didn't take effect, check the build log for `Building image` and
`Modified application`. If neither line is there, the image never shipped.

A preview build, meaning any branch that isn't `main`, runs `npx wrangler versions upload` instead
and doesn't build the image at all. A container change lands only on merge, untested until then. See
[Warm instances](#warm-instances).

The Worker side is already committed: the `@cloudflare/containers` dependency, `src/container.ts`
(the `MediaResolver` DO class), the deploy entry `src/index.ts`, the R2 bucket `mbedfx-media` and
the `containers` / `durable_objects` / `migrations` / `r2_buckets` blocks in `wrangler.jsonc`. Once
the container is live, `/_media/` serves muxed video for posts carrying a `remux` source. The Worker
checks the bindings first, so before provisioning finishes, or with no container, those videos
render the cover still.

To require the shared-secret header, run `npx wrangler secret put RESOLVER_SECRET` and set the same
`RESOLVER_SECRET` on the container as a container secret. Do not use `containers[].image_vars`.
Wrangler documents that as build-time only, and a value set there never reaches the running
instance.

Running it anywhere else is [Running it standalone](#running-it-standalone) below.
`docs/SELF-HOSTING.md` carries the wider plan, for the Worker half that has no adapter yet.

### Warm instances

Instances are pooled onto `RESOLVER_SLOTS` keys, not minted per post. A deploy starts a gradual
rollout that retires them over minutes, and an instance the rollout hasn't reached keeps the image
it booted with until it sleeps (`sleepAfter`, 5m) or is otherwise recycled. A fresh post will most
likely land on an existing warm slot, so it's an unreliable way to reach a new image. The
`RESOLVER_GENERATION` block in `src/worker.ts` has the note on the rollout.

**"Wait out `sleepAfter`" DOES NOT WORK UNDER LIVE TRAFFIC, and this was learned the hard way on
2026-08-28.** Any request resets the timer, so an instance serving a broken image is kept alive by the
very requests it is failing. A container image that was correct and deployed sat behind seven broken
instances for ten minutes, and six minutes of deliberately not touching the service did not clear it.

The lever that does work is **`RESOLVER_GENERATION`**. It names the Durable Objects, so bumping it
sends the next request to a brand-new instance, which boots on the current image. It costs the cached
meta records — that is a real price, and it is the right one to pay to end an outage. If this keeps
happening, a shorter `sleepAfter` is the cheaper permanent fix; `src/container.ts` already argues 3m
is available.

## Running it standalone

Outside Cloudflare is the one case that needs the image built by hand. Nothing in `server.py`
imports a Cloudflare module or expects a binding: it is stdlib-only Python over
`ThreadingHTTPServer`, and it holds no state, so there is no volume to mount and nothing to migrate.

```sh
docker build --platform linux/amd64 -t media-resolver container/
docker run --rm -p 8080:8080 -e RESOLVER_SECRET=<a long random string> media-resolver
```

`--platform linux/amd64` is not optional on an ARM host. The Dockerfile fetches
`deno-x86_64-unknown-linux-gnu.zip` by name, so an arm64 build lands an x86_64 binary that cannot
execute. Nothing fails at build time and nothing fails at boot. Only YouTube breaks, and only at the
moment a `{page}` resolve reaches for the JS runtime, which is a long way from the cause.

Check it answers:

```sh
curl -s localhost:8080/health                                  # -> ok
curl -s -X POST localhost:8080/resolve \
  -H 'X-Resolver-Secret: <the same string>' \
  -d '{"video":"https://v.redd.it/<id>/HLSPlaylist.m3u8"}' -o out.mp4
```

A few MB of `video/mp4` with a valid `ftyp` means the whole path works. A JSON `{"error"}` body
means it does not, and the code carries the reason: `401` the secret, `400` a source the SSRF gate
refused, `502` a failed or empty mux, `504` the wall clock — which is `PROC_TIMEOUT` (120s) on
`{video}` and `{page, meta}`, and `MUX_PAGE_TIMEOUT` (360s) on the `{page}` mux, because yt-dlp has
to extract and then download the whole file before it can send a byte. That was `PROC_TIMEOUT + 60`
(180s) until 2026-08-29; it is its own variable now because the two walls scale with different
things, and only one of them is a whole-video download.

**Set `RESOLVER_SECRET`.** Without it, `/resolve` is an open fetch-anything remuxer: it will pull
whatever url an anonymous caller names, from the host's own network position, and spend up to a
`MUX_PAGE_TIMEOUT` (360s) of CPU doing it. The Worker deployment can lean on the container binding
not being a public route; a standalone one is reachable by whatever the host's firewall allows, so
the secret is the only thing in front of it. `/health` stays unauthenticated by design, since a load
balancer has to reach it.

Give the host disk, not just memory. A mux streams to a temp file before a byte is returned, so
`/tmp` inside the container needs headroom to `MAX_BYTES` (375 MB) per concurrent call.

The listener is IPv4-only: `server.py`'s one `ThreadingHTTPServer(("0.0.0.0", port), …)` call is the
whole of it. (This read `server.py:430` until 2026-08-29, by which point the call had moved to 783 —
the name is cited rather than the line for that reason.) Nothing in the Cloudflare path cares, and
`docker run -p` hides it. An IPv6-only host, or a reverse proxy resolving the upstream to `::1`,
reaches a closed port and reports the container as down.

### Without Docker

The image exists for ffmpeg, yt-dlp and Deno, not for Python. Where those three are already on the
host, `server.py` runs against a stock interpreter with no venv, no `pip install` and no build step:

```sh
PORT=8080 RESOLVER_SECRET=<a long random string> python3 container/server.py
```

Verified 2026-08-08 on macOS x86_64, Python 3.14.6 and ffmpeg 8.1.2, off Cloudflare and outside a
container: `/health` answered `200 ok`; `/resolve` answered `401` with a missing and with a wrong
secret, and passed to argument parsing with the right one; and the SSRF gate refused
`169.254.169.254`, loopback, `file:///etc/passwd` and a leading-dash url with `400 invalid source`
apiece.

One caveat that build does not cover. `HTTP_OPTS` sends `-http_persistent 0` with every input, and
that option belongs to ffmpeg's HLS demuxer. On ffmpeg 8.1.2 the `dash` demuxer does not define it
and a plain MP4 has no demuxer that does, so either input dies at
`Option http_persistent not found` before a byte is read. Production never reaches it: `{video}` is
only ever set from `src/platforms/reddit/normalize.ts:102` and
`src/platforms/bluesky/normalize.ts:73`, both HLS playlists, and everything else arrives as `{page}`
where yt-dlp builds its own ffmpeg call.
The interface note above still advertises a bare `.mpd` as `video`, which is the shape to re-measure
before relying on it, and a self-hoster on a newer ffmpeg than the image's is who would find out.

## Status (2026-08-28)

Reddit and Bluesky single videos play in production, since their HLS muxes to a progressive
faststart MP4. Both were confirmed live against a real post: 200 `video/mp4` with a valid `ftyp`,
Range answered 206, the file cached in R2.

Since 2026-08-28 this runs on `standard-2` (1 vCPU) rather than `basic` (1/4 vCPU). Measured from
production egress the same day, a per-client YouTube extract takes 3.1-4.7 s; it took 14-17 s before,
and that figure had been read as YouTube throttling for weeks. Do not go past `standard-2`: the work
is single-threaded and the gain stops dead at one core.

Also measured 2026-08-28, from that egress, with no PO token anywhere: `default`, `web_embedded`,
`tv_simply`, `mweb` and `web_safari` all served bytes; only `android_vr` was refused. `tv_simply` and
`mweb` are the two clients yt-dlp's PO Token Guide lists as REQUIRING a token, so the token question
is closed for this container.

## Testing the container after deploy

Only the Worker can reach `/resolve`, so exercise it through a throwaway Worker route. Delete the
route afterwards and don't commit it; the pipeline tests forbid debug routes in `worker.ts`.

```ts
if (url.pathname === '/__muxtest') {
  const r = await env.MEDIA_RESOLVER.getByName('t').fetch('http://c/resolve', {
    method: 'POST',
    body: JSON.stringify({ video: 'https://v.redd.it/<id>/HLSPlaylist.m3u8' }),
  })
  return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || '' } })
}
```

A 200 `video/mp4` of a few MB means it works, and `GET /__muxtest` should play in a browser. Or
paste a Reddit or Bluesky video post at a deployed host, a Workers Builds preview or production, and
open `/_media/<refKey>/0`.

## Notes

- Bluesky's `video.bsky.app` playlist points at `video.cdn.bsky.app` segments. A segment on another
  host breaks HTTP keepalive reuse, and an older ffmpeg aborted the whole mux over it. The container
  now runs each input with `-http_persistent 0` plus reconnect flags (`HTTP_OPTS` in `server.py`).
  Reddit needs neither, having no host redirect.
- YouTube is not datacenter-IP-blocked, measured 2026-07-22. A `{page}` resolve of a YouTube watch
  url returns a real ad-free mp4 from Cloudflare Container egress. It needed only Deno in the image,
  yt-dlp's "EJS" JS-runtime requirement for YouTube's signature and n-param challenge (without it
  the extract fails `rc=1, "extraction without a JS runtime has been deprecated"`), and the `{page}`
  skip-bug fix. The caller pre-creates `out` via `tempfile.mkstemp`, so yt-dlp saw a file already
  there and skipped ("already downloaded", exit 0, 0-byte file → "empty or oversized result").
  `--force-overwrites` fixes it, and ffmpeg's `-y` already covered `_mux_tracks`. Facebook is
  untested here; Meta gates on TLS and UA.
  **"Not blocked" is still true and "it works" is not**, which is worth separating because this
  bullet has read as the second for a month. Measured 2026-08-28: roughly 40-50% of Cloudflare-egress
  YouTube requests are refused where residential succeeds every time — a RATE, so IP reputation
  rather than a missing credential, and a PO token buys nothing against it (see `container/Dockerfile`
  for that measurement). "Only Deno" is also no longer the whole list: `YT_PLAYER_CLIENTS` in
  `server.py` names the player clients rather than taking yt-dlp's defaults, and the pin in
  `container/Dockerfile` had to move forward to pick up yt-dlp's GVS PO-token handling. No version is
  quoted here on purpose: it is bumped weekly, and a copy in prose goes stale within days.
- yt-dlp ages fast, YouTube especially — and rebuilding the image does NOT pull a newer one. Since
  2026-08-17 the version is pinned exactly in `container/Dockerfile`, so every build installs that
  release and no other. This bullet said the opposite until 2026-08-29.
  What moves the pin is `.github/workflows/ytdlp-freshness.yml`: each Monday it reads PyPI's newest
  STABLE, and when that is ahead of the pin it pushes a branch and opens a PR, or raises an issue
  saying the branch is ready when the repository forbids it opening one. So to get a newer yt-dlp,
  merge that PR, or edit the pin yourself and merge — merging is what rebuilds and ships the image,
  and nothing else does. Do not put a `>=` floor back; `test/ytdlp-pin.test.mjs` refuses one and the
  Dockerfile carries the reasoning. Only `yt-dlp` itself is pinned: its dependencies, `yt-dlp-ejs`
  among them, still resolve fresh on every build.
- Some sites, Vimeo among them, fail `"attempting impersonation, but no impersonate target is
  available"` without curl_cffi. The image installs `yt-dlp[default,curl-cffi]`, because the plain
  `[default]` extra doesn't include it, and yt-dlp auto-uses it for extractors that request
  browser-TLS impersonation.
- Threads video doesn't come through here. A Threads post carries a progressive MP4 already, and
  Meta blocks Cloudflare's datacenter egress for those bytes, so `/_media/` 302s straight to the
  signed CDN url and Discord's own media proxy fetches it (`src/platforms/threads/normalize.ts`).
  The format was measured progressive on 2026-07-22 across four live posts, and the 302 is a settled
  route.
- The image must be linux/amd64, and is (`python:3.12-slim` plus a static Deno binary).
