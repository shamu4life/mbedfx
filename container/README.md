# media-resolver: the mbedfx video remux/resolve container

This is a small ffmpeg + yt-dlp service: a single-purpose Cobalt, run in-house so that nobody else's
uptime or extractor drift sits in the path. It turns a DASH/HLS video, or any page yt-dlp supports,
into one progressive faststart MP4, which the Worker serves as `og:video`. Reddit, Bluesky and
Instagram video goes through it, and so, on a best-effort basis, do YouTube, Vimeo, Dailymotion,
Facebook and the ~1800 other sites yt-dlp knows. Without it, those posts are cover stills.

## Interface

`POST /resolve` takes a JSON body. On Cloudflare the Worker reaches it over its container binding,
and off Cloudflare over the compose network. It is never a public route.

```jsonc
{ "video": "<url>", "audio": "<url>"|null }  // mux tracks the Worker extracted (a v.redd.it or Bluesky
                                             // HLS .m3u8 as `video` with no `audio`, or the yt-dlp tracks
                                             // shortcut's pair)
{ "page": "<url>" }                          // yt-dlp resolves + merges (YouTube/Vimeo/FB/…)
{ "page": "<url>", "meta": true }            // METADATA ONLY (yt-dlp -J, no download) — see below
{ "probe": true }                            // DIAGNOSTIC (yt-dlp per client + a range fetch) — see below
```

- 200 `video/mp4` is the muxed file, streamed. The Worker pipes it straight into R2 and serves
  range reads from there, so each video is muxed at most once. An ISO-BMFF result is sent only when
  every top-level box in it is whole and an mdat carries data (`_mux_result_verdict`). A file cut off
  inside a box, or with no moov or no media, answers `502 {"error":"incomplete result"}` instead,
  because R2 would otherwise keep it and serve it to every later view. A single-format `{page}`
  download that stops early leaves exactly that kind of file, since it is written verbatim. A short
  input that ffmpeg rewrites (a merge, a `{video}` tracks mux, the HLS fixup) comes out as whole
  boxes and passes unless no sample survived; whether that happens in production was not measured.
  WebM, FLV and MPEG-TS, which a single-format `{page}` download can write under the `.mp4` name,
  pass through unjudged.
- 4xx/5xx `application/json` `{"error"}` means the Worker falls back to the cover still.
- `GET /health` answers `200 ok`.

### Meta mode (`{"page": …, "meta": true}`)

This mode answers `200 application/json`, a dumb passthrough of one `yt-dlp -J` with no download and
no second subprocess. It exists for platforms whose crawler or oembed metadata is gated from
datacenter egress but whose video yt-dlp still resolves. Facebook is the case in point: Meta serves
`facebookexternalhit` a decoy from datacenter addresses. The shape:

```jsonc
{ "_type": …, "title": …, "thumbnail": …, "uploader": …, "uploader_id": …, "uploader_url": …,
  "description": …, "width": …, "height": …, "duration": …, "timestamp": …,
  // added 2026-08-01, g8 — a record written before that has none, which is why the generation moved
  "view_count": …, "like_count": …, "comment_count": …, "age_limit": …,
  // added 2026-08-22, g12 — the mux shortcut; see below
  "mux_video": …, "mux_audio": … }
```

Any field may be `null`; `src/worker.ts` treats every field but `title` as optional. The judgement
lives in `src/platforms/facebook/normalize.ts`.

#### `_type`

`_type` carries yt-dlp's own kind, and it is the only field that tells a video from a playlist. It
was added on 2026-07-26, in g5. The Worker's content assertion is "`title` is a non-empty string",
and an Imgur album passes that. Without `_type` the card would ship a headline over a video url that
resolves to nothing. Measured 2026-07-26, `imgur.com/a/iX265HX` returns `_type: "playlist"` with a
title but no thumbnail, no dimensions, no duration and no timestamp.

#### `width` / `height`

Both fall back to a sized entry in `formats` when the top level has none. A Facebook progressive
`sd`/`hd` format carries no height, and without the fallback the card would ship
`og:video:width="0"`. The fallback prefers the tallest entry at or under 720, matching the selector's
general `height<=?720` arms. On YouTube the selector's first arm is the `134+140` itag pair (360p,
avc1 Main, which takes a third fewer bytes than format 18's Baseline for the same picture). There
the fallback is a looser bound than the truth, and it can only over-state.

Since g12 the meta call passes that selector itself (`YT_FORMAT_SELECTOR`, hoisted so `_meta_page`
and `_mux_page` cannot state one rule two ways). The top-level dimensions therefore describe the
format the mux will pick, not yt-dlp's default. This does not break the age-gated case, which is what
`--ignore-no-formats-error` exists for. Measured 2026-08-22 on `yt:G0sORVBL4kM` (`age_limit` 18,
`formats: 0`), the answer is identical with and without `-f`, because the flag suppresses the
"no formats" exit before selection is reached.

#### `mux_video` / `mux_audio`

These are the direct format urls that the same `-J` already resolved, so the Worker's `/_media/` mux
can hand them to `ffmpeg` instead of paying for a second, byte-identical extraction. They were added
on 2026-08-22, in g12. Measured 2026-08-22 on YouTube, extraction is ~5.0s of player-API round trips
plus a Deno JS challenge, against a 1.8s download of the same 10 MB, and a cold card paid for the
extraction twice.

A split selection reports both (video first, matching `_mux_tracks`' `0:v:0` / `1:a:0` mapping); a
progressive one reports `mux_video` alone.

Both are `null` whenever the shortcut cannot be taken safely, and `_mux_sources` decides that before
yt-dlp's own filter would. It refuses a livestream, a duration at or over `MAX_SECONDS`, and an
unknown duration, which makes it stricter than the `duration<?N` match filter it mirrors.
`duration<?N` admits an unknown duration because yt-dlp still stops that download on
`--max-filesize`. `ffmpeg` reading a url has no equivalent stop, so handing one over would silently
delete the ceiling, and a livestream would run until `PROC_TIMEOUT` burned a container slot.

The Worker treats them as optional at every step, so a pooled pre-g12 instance degrades to the
`{"page": …}` mux that shipped. The Worker must send the tracks **without** `page` beside them.
`do_POST` checks `page` first, so a body carrying both takes the slow path every time.

The urls are volatile and the meta record is not. A resolved format url is bound to the egress IP
that resolved it and expires in hours, while the record it would ride in is read back for 30
minutes (Streamable) to 24 hours (Dailymotion, Imgur). So `src/worker.ts` carries them beside the
record instead of inside it (see `cachedYtdlpMeta`). By construction, a cache hit has no shortcut
and muxes from the page. The mux tries the tracks and falls back to the page, which is the only safe
way to use a url that can go stale between the two calls.

### Probe mode (`{"probe": true}`)

This mode answers `200 application/json`. It is a diagnostic and not a serving path: it extracts one
fixed video with each client in `PROBE_CLIENTS`, then range-fetches the format that client chose and
reports the bytes.

```jsonc
{ "video": "jNQXAC9IVRw", "ytdlp": "2026.08.19", "ms": 20233,
  "ffmpeg": "<version>", "hlsExtensionPicky": true,   // since 2026-10-04; null = probe could not run
  "muxCheck": "boxes",                                 // since 2026-10-05; absent = stores short muxes
  "serving": ["default", "web_embedded", "tv_simply", "mweb", "web_safari"],
  "clients": [ { "client": "default", "extracted": true, "formats": 24,
                 "gvs": "ok", "bytes": 65536, "ms": 3378 }, … ],
  "tiktok": { … },
  "hls": { "video": "zp8_bKhhnlw", "extracted": true, "picked": "95-21",   // since 2026-11-24
           "protocols": ["m3u8_native"], "host": "manifest.googlevideo.com",
           "playlist": "ok", "segment": "ok", "bytes": 65536, "ms": 5572 } }
```

`tiktok` is the TikTok probe, run on `PROBE_TIKTOK` (`_probe_tiktok` in `server.py`).

The `hls` object covers a path the `clients` rows can't see. Some videos give our three clients no
direct download at all, only HLS playlists, and `PROBE_VIDEO` isn't one of them. `hls` runs the mux's
own clients and format selector on a video that is (`PROBE_HLS_VIDEO`). `protocols` says what the
selector picked, `playlist` whether the playlist came back (`ok` means a 200 whose body starts with
`#EXTM3U`), and `segment` whether the first segment's bytes did. The sample above is from a home
connection. From production, an `http-403` in either field means googlevideo refuses HLS to the
container's network.

The range fetch holds the probe to the rule the rest of the repo follows: assert on content, never on
status. A client can extract happily and then be refused by googlevideo, and only fetching bytes tells the two
apart. On the first production run `android_vr` reported `extracted: true,
formats: 1` and served nothing, and a probe that asserted on a format count would have called it
healthy.

The probe takes no input. The video id (`PROBE_VIDEO`) and the client list (`PROBE_CLIENTS`) are
constants in `server.py`, so two runs are comparable instead of each measuring whichever video was
passed. It rides this same authenticated `/resolve`, so it opens no new surface, and its range fetch
goes through `_safe_url` like every other fetch here. `PROBE_TIMEOUT` (45s) bounds each client
separately. The clients run one at a time on purpose: they contend for the same CPU, and running
them together would measure the contention instead of the clients.

In production it is reached as `GET /_clients` on the Worker, which wraps this body in an `ok` that
is true when `serving` came back non-empty. Run it when YouTube muxes are failing and `/_smoke` says
everything is fine. No smoke check dispatches a `{page}` remux, which is how a total container outage
stayed 17/17 green on 2026-08-28. Since 2026-08-29 the `yt` row asserts `og:video`, so a dead
container does surface there eventually, but only on the tick that finds R2's copy of that one video
swept by `expire-60d`, which is about one tick in sixty days. Every other tick reads a warm R2 head
and says nothing about this image.

## `RESOLVER_GENERATION` and `META_GENERATION`

> **Changing the meta-mode response shape above requires bumping both of them in `src/worker.ts`.**

They were one string until 2026-08-29, and they answer two different questions:

- `RESOLVER_GENERATION` is part of the pooled instance name. Pooled instances have stable names
  and keep their booted image until `sleepAfter` (5m). Skip this bump and a redeploy under steady
  traffic keeps answering with the old dict: the new fields arrive `undefined`, and the change looks
  inert. Bumping it costs one cold boot per slot. The only stored objects it retires are the mux
  give-up marks, which `muxFailMarkKey` (`src/worker.ts`) keys under it on purpose.
- `META_GENERATION` is the meta cache's key segment. Bumping it discards stored dates,
  descriptions, counts and gate verdicts across yt, fb, dm, st and im. The longest-lived is
  `YT_META_TTL_MS`, at 30 days; fb, dm and im hold for 24h, and st for 30 minutes.

A response-shape change needs both, because the instances have to be replaced and the records
already written in the old shape have to go. An image change that alters no stored shape needs only
`RESOLVER_GENERATION`. A change to what a stored record means, with no container change at all,
needs only `META_GENERATION`; the Innertube rung writes these records too, without going near this
image.

The rule that used to sit here read "changing the dict requires bumping `RESOLVER_GENERATION`, and so
does any other change to what the container does". That rule is input-shaped: it asks what changed,
not what a stored record now says. `src/worker.ts` had to write down 1.9.0 as an exception to it. The
output dict changed and the generation stayed on g10, because the defect had stopped any record
being written and there was nothing stale to retire. Under the split, 1.9.0 is no longer an
exception.

## The mux

Wherever ffmpeg writes the file, the mux is a stream copy (`-c copy -movflags +faststart`) and never a
transcode. A single-format `{page}` download is the site's own file, written verbatim. The caps are
env-overridable and live in `container/server.py`: `MAX_SECONDS=1500`, `MAX_BYTES=393216000` (a 375 MB
output ceiling), `PROC_TIMEOUT=120`, and `MUX_PAGE_TIMEOUT=360` for the `{page}` mux alone. Both
size ceilings went up together on 2026-08-03. In a stream copy the output size is the source bitrate
times the duration, so raising one ceiling alone only moves the refusal to the other filter.

`container/server.py` is the source of truth for all four, and this line has been wrong twice: it
read `MAX_SECONDS=1800` until 2026-07-26, long after the code said 1200, and then `1200` / `300MB`
until 2026-08-05. It said "all three" until 2026-08-29, and that was correct, because
`MUX_PAGE_TIMEOUT` and the `four` here landed in the same commit. There was never a window with four
walls and three named.

The `{page}` mux's match filter is `duration<?{MAX_SECONDS} & !is_live`, currently
`duration<?1500 & !is_live`. The `<?` and `!is_live` shape arrived with g5 on 2026-07-26. `<?` is
yt-dlp's none-inclusive comparison, and the previous `duration < 1200 & duration > 0` silently
excluded every source that declares no duration. An Imgur gifv reports `duration: None` and was
skipped outright (`does not pass filter … skipping ..`, reproduced on `i.imgur.com/A61SaA1.gifv`).
`!is_live` keeps the livestream rejection that `duration > 0` had been providing by accident. A live
source that got through would download until `MUX_PAGE_TIMEOUT` and burn a container slot.

**There are now three guards against a livestream and they are not redundant**, so do not delete one
as a duplicate of another. `_mux_sources` refuses to hand ffmpeg a live source's format urls. The
match filter refuses the download. And since 2026-08-29 `src/worker.ts`'s `settleMux` refuses to
dispatch a YouTube one at all, off `Media.live`, which Innertube sets before the Post exists. The two
guards here are the container declining work it has been given. The Worker's guard means the request
is never made, so it is the only one that saves the round trip, and it exists because that round
trip was being paid on every render of a permanently-live channel, forever.

## Deploying it

Merging to `main` builds this image and deploys it. Do **not** run
`npx wrangler deploy -c wrangler.production.jsonc` by hand: a hand deploy overwrites whatever Workers
Builds shipped while the dashboard still reports a healthy Worker. A plain `npx wrangler deploy`
deploys the generic `wrangler.jsonc`, which is a separate Worker with its own container application.

Every wrangler config gives `image` a Dockerfile path, `./container/Dockerfile`. Cloudflare's docs say
that a Dockerfile `image` makes `wrangler deploy` build the image and push it to Cloudflare's
registry, and Workers Builds runs `npx wrangler deploy -c wrangler.production.jsonc`. A merge to
`main` shows the whole job in the build log. The log below is from mbedfx.app's builds before the
deploy command gained `-c`. The application name in it is production's pinned one; a generic deploy
shows `mbedfx-selfhost-mediaresolver` instead:

```
Executing user deploy command: npx wrangler deploy
 - fxeverything-mediaresolver (/opt/buildhome/repo/container/Dockerfile)
Building image fxeverything-mediaresolver:…
Image does not exist remotely, pushing: registry.cloudflare.com/…
digest: sha256:…
├ EDIT fxeverything-mediaresolver
SUCCESS  Modified application fxeverything-mediaresolver
```

Workers Builds does all of this on Cloudflare's side, with no Docker, registry login or dashboard
step on your machine. Run `wrangler deploy` on your own machine and the image builds there, which
needs a running Docker-compatible CLI.

If a change here didn't take effect, check the build log for `Building image` and
`Modified application`. If neither line is there, the image never shipped.

A branch other than `main` gets a Worker Preview instead, built by
`npx wrangler preview -c wrangler.production.jsonc` since 2026-11-25. Before then it ran
`versions upload`, which never built the image, so a container change went untested until it
merged. The `previews` block in that file gives every Preview one shared bucket,
`mbedfx-preview-media`, which has a 7-day expiry rule, and gives each Preview its own container
application, built from the branch's `container/Dockerfile`. The generic `wrangler.jsonc` gives
Previews no bucket, so a Preview there shows cover stills instead of muxed video. Nobody has
measured whether a Preview's container serves a mux from Cloudflare's network (the
"UPDATE 2026-11-25" note in `wrangler.production.jsonc`). See [Warm instances](#warm-instances).

The Worker side is already committed: the `@cloudflare/containers` dependency, `src/container.ts`
(the `MediaResolver` DO class), the deploy entry `src/index.ts`, and the `containers` /
`durable_objects` / `migrations` / `r2_buckets` blocks in `wrangler.production.jsonc` (bucket
`mbedfx-media`) and the generic `wrangler.jsonc` (bucket `mbedfx-selfhost-media`). Once the
container is live, `/_media/` serves muxed video for posts carrying a `remux` source. The Worker
checks the bindings first, so before provisioning finishes, or with no container, those videos
render the cover still.

On Cloudflare the container doesn't check `X-Resolver-Secret` today. A Cloudflare container gets
environment variables only through its Container class's `envVars`, and `MediaResolver` in
`src/container.ts` sets none, so @cloudflare/containers 0.3.7 starts it without any. `server.py`
then has no `RESOLVER_SECRET` and accepts every `/resolve` that reaches it. On Cloudflare the only
way in is the Durable Object binding. A Worker secret named `RESOLVER_SECRET` makes the Worker send
the header, and the container ignores it. Enforcing the secret there would take a code change
(`envVars` built from the Worker's secret), and nobody has written or tested one.

If you set the Worker secret anyway, the command for mbedfx.app is
`npx wrangler secret put RESOLVER_SECRET -c wrangler.production.jsonc`. Forget the `-c` and the
secret goes to `mbedfx-selfhost`, the root config's Worker. If that Worker doesn't exist, wrangler
asks whether to create it, with yes as the default, and when the value comes in on a pipe it creates
it without asking. "Pushing it" in `docs/CREDENTIALS.md` shows how little wrangler says when that
happens. A deployment of the generic file leaves the `-c` off.

Do not use `containers[].image_vars` for the secret. Wrangler documents that as build-time only, and
a value set there never reaches the running instance.

Off Cloudflare the secret is enforced. `adapters/node/compose.yaml` and the standalone `docker run`
below give both halves the same value.

For running it anywhere else, see [Running it standalone](#running-it-standalone) below.
`docs/SELF-HOSTING.md` covers the Worker half: the Node adapter in `adapters/node/` and a compose file
that runs it beside this container.

### Warm instances

Instances are pooled onto `RESOLVER_SLOTS` keys, not minted per post. A deploy starts a gradual
rollout that retires them over minutes, and an instance the rollout hasn't reached keeps the image
it booted with until it sleeps (`sleepAfter`, 5m) or is otherwise recycled. A fresh post will most
likely land on an existing warm slot, so pasting one is an unreliable way to reach a new image. The
`RESOLVER_GENERATION` block in `src/worker.ts` has the note on the rollout.

**Waiting out `sleepAfter` does not work under live traffic.** The outage of 2026-08-28 proved it.
Any request resets the timer, so an instance serving a broken image is kept alive by the
very requests it is failing. A correct, deployed container image sat behind seven broken instances
for ten minutes, and six minutes of deliberately not touching the service did not clear it.

The lever that does work is `RESOLVER_GENERATION`. It names the Durable Objects, so bumping it sends
the next request to a brand-new instance, which boots on the current image. It costs one cold boot
per slot. The cached meta records are keyed by `META_GENERATION` and stay. The mux give-up marks are
keyed under `RESOLVER_GENERATION` (`muxFailMarkKey`, `src/worker.ts`), so the bump also retires every
give-up verdict written under the old generation, including the ones a broken image wrote. If this
keeps happening, a shorter `sleepAfter` is the cheaper permanent fix; `src/container.ts` already
argues that 3m is available.

## Running it standalone

Outside Cloudflare, `adapters/node/compose.yaml` builds this image and runs it beside the Node
adapter with no published port (`docs/SELF-HOSTING.md`, "Host it with Docker Compose"). To run it on
its own, build it by hand. Nothing in `server.py` imports a Cloudflare module or expects a binding.
It is stdlib-only Python over `ThreadingHTTPServer`, and it holds no state, so there is no volume to
mount and nothing to migrate.

```sh
docker build --platform linux/amd64 -t media-resolver container/
docker run --rm -p 127.0.0.1:8080:8080 -e RESOLVER_SECRET=<a long random string> media-resolver
```

`--platform linux/amd64` is not optional on an ARM host. The Dockerfile fetches
`deno-x86_64-unknown-linux-gnu.zip` by name, so an arm64 build lands an x86_64 binary that cannot
execute. Nothing fails at build time or at boot. Only YouTube breaks, and only at the moment a
`{page}` resolve reaches for the JS runtime, which is a long way from the cause.

Check that it answers:

```sh
curl -s localhost:8080/health                                  # -> ok
curl -s -X POST localhost:8080/resolve \
  -H 'X-Resolver-Secret: <the same string>' \
  -d '{"video":"https://v.redd.it/<id>/HLSPlaylist.m3u8"}' -o out.mp4
```

A few MB of `video/mp4` with a valid `ftyp` means the whole path works. A JSON `{"error"}` body
means it does not, and the status code gives the reason: `401` is the secret, `400` a source the
SSRF gate refused, `502` a failed, empty or incomplete mux, and `504` the wall clock. The wall is
`PROC_TIMEOUT` (120s) on `{video}` and `{page, meta}`, and `MUX_PAGE_TIMEOUT` (360s) on the `{page}`
mux, because yt-dlp has to extract and then download the whole file before it can send a byte. That
was `PROC_TIMEOUT + 60` (180s) until 2026-08-29. It has its own variable now because the two walls
scale with different things, and only one of them is a whole-video download.

**Set `RESOLVER_SECRET`.** Without it, `/resolve` is an open fetch-anything remuxer: it will pull
whatever url an anonymous caller names, from the host's own network position, and spend up to a
`MUX_PAGE_TIMEOUT` (360s) of CPU doing it. On Cloudflare only the container binding reaches it. A
standalone one is reachable by whatever the host's firewall allows, so the secret is the only thing
in front of it. That is also why the command above publishes the port on `127.0.0.1` only. `/health`
stays unauthenticated by design, because a load balancer has to reach it.

Give the host disk, not just memory. A mux streams to a temp file before a byte is returned, so
`/tmp` inside the container needs headroom to `MAX_BYTES` (375 MB) per concurrent call.

The listener is IPv4-only, and `server.py`'s one `ThreadingHTTPServer(("0.0.0.0", port), …)` call is
all there is to it. (This line cited `server.py:430` until 2026-08-29, when the call had moved to 783,
so it now cites the name instead of the line.) Nothing in the Cloudflare path cares, and
`docker run -p` hides it. An IPv6-only host, or a reverse proxy that resolves the upstream to
`::1`, reaches a closed port and reports the container as down.

### Without Docker

The image exists for ffmpeg, yt-dlp and Deno, not for Python. Where those three are already on the
host, `server.py` runs against a stock interpreter with no venv, no `pip install` and no build step:

```sh
PORT=8080 RESOLVER_SECRET=<a long random string> python3 container/server.py
```

Verified 2026-08-08 on macOS x86_64, Python 3.14.6 and ffmpeg 8.1.2, off Cloudflare and outside a
container. `/health` answered `200 ok`. `/resolve` answered `401` with a missing secret and with a
wrong one, and passed to argument parsing with the right one. The SSRF gate refused
`169.254.169.254`, loopback, `file:///etc/passwd` and a leading-dash url, each with
`400 invalid source`.

One caveat that build does not cover: on ffmpeg 8.1.2, an input that is not an HLS playlist dies
before a byte is read. `HTTP_OPTS` sends `-http_persistent 0` with every input, and that option belongs to ffmpeg's
HLS demuxer. On ffmpeg 8.1.2 the `dash` demuxer does not define it and a plain MP4 has no demuxer
that does, so either input dies at `Option http_persistent not found`. Production does reach this,
and this paragraph used to say otherwise. The Reddit and Bluesky `{video}` sources are HLS playlists
(`src/platforms/reddit/normalize.ts`, `src/platforms/bluesky/normalize.ts`), but the yt-dlp tracks
shortcut (`src/platforms/ytdlp/normalize.ts`, used by Dailymotion, Streamable and the Imgur fallback)
sends whatever url `_mux_sources` picked. When that is not an HLS playlist (a progressive MP4, an
`.m4s`), the shortcut dies at this option and `ensureMuxed` falls back to `{page}`. Which formats each
platform's shortcut actually carries has not been checked, so how often that happens is unknown (an
HLS rendition would pass). This was found by reading the code on 2026-10-04. It was not measured in
production, and nothing counts it, because only the last attempt's failure is counted. Making the
option HLS-only would change what those platforms' muxes do and needs its own measurement, so it has
been left for a separate change.

The same per-input slot carries `-extension_picky 0`, for Reddit's HLS only, and only when the
installed ffmpeg's hls demuxer lists the option. Reddit videos with audio uploaded between about
2024-05 and 2025-11 store their audio as MPEG-TS in files named `.aac`, which the check refuses. So
before 2026-10-04 every one of them failed to mux on this image's ffmpeg (a 7.1 release no older
than 7.1.1). An ffmpeg that does not list the option (6.1.1 measured) has no check and muxes them as
is. The full measurement is in the comment at `REDDIT_HLS_HOST` in `server.py`.

## Status

By 2026-08-28 Reddit and Bluesky single videos played in production, because their HLS muxes to a
progressive faststart MP4. Both were confirmed live against a real post: 200 `video/mp4` with a
valid `ftyp`, a Range request answered 206, and the file cached in R2. For Reddit that held only for
some upload dates. Videos with audio uploaded between about 2024-05 and 2025-11 answered 503 for 8
of 8 when measured as Discordbot on 2026-10-04 (see the `-extension_picky` paragraph above). The fix
has not yet been measured in production.

Since 2026-08-28 this runs on `standard-2` (1 vCPU) instead of `basic` (1/4 vCPU). Measured from
production egress the same day, a per-client YouTube extract takes 3.1-4.7 s; it took 14-17 s before,
and for weeks that figure had been read as YouTube throttling. Do not go past `standard-2`: the work
is single-threaded, and the gain stops dead at one core.

Also measured 2026-08-28 from that egress, with no PO token anywhere: `default`, `web_embedded`,
`tv_simply`, `mweb` and `web_safari` all served bytes, and only `android_vr` was refused. `tv_simply`
and `mweb` are the two clients yt-dlp's PO Token Guide lists as requiring a token, so the token
question is closed for this container.

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

A 200 `video/mp4` of a few MB means it works, and `GET /__muxtest` should play in a browser.
Alternatively, paste a Reddit or Bluesky video post at a deployed host (a Workers Builds preview or
production) and open `/_media/<refKey>/0`.

## Notes

- Bluesky's `video.bsky.app` playlist points at `video.cdn.bsky.app` segments. A segment on another
  host breaks HTTP keepalive reuse, and an older ffmpeg aborted the whole mux over it. The container
  now runs each input with `-http_persistent 0` plus reconnect flags (`HTTP_OPTS` in `server.py`).
  Reddit needs neither, because it has no host redirect.
- YouTube is not datacenter-IP-blocked, measured 2026-07-22. A `{page}` resolve of a YouTube watch
  url returns a real ad-free mp4 from Cloudflare Container egress. It needed only Deno in the image
  and the `{page}` skip-bug fix. Deno meets yt-dlp's "EJS" JS-runtime requirement for YouTube's
  signature and n-param challenge; without it the extract fails
  `rc=1, "extraction without a JS runtime has been deprecated"`. The skip bug: the caller
  pre-creates `out` via `tempfile.mkstemp`, so yt-dlp saw a file already there and skipped the
  download ("already downloaded", exit 0, 0-byte file → "empty or oversized result").
  `--force-overwrites` fixes it, and ffmpeg's `-y` already covered `_mux_tracks`. Facebook is
  untested here; Meta gates on TLS and UA.
  **"Not blocked" is still true, and "it works" is not.** The two need separating because for a
  month this bullet read as the second. Measured 2026-08-28: roughly 40-50% of Cloudflare-egress
  YouTube requests are refused where residential succeeds every time. That is a rate, which points to
  IP reputation and not a missing credential, and a PO token buys nothing against it (see
  `container/Dockerfile` for that measurement). "Only Deno" is also no longer the whole list.
  `YT_PLAYER_CLIENTS` in `server.py` names the player clients instead of taking yt-dlp's defaults,
  and the pin in `container/Dockerfile` had to move forward to pick up yt-dlp's GVS PO-token
  handling. No version is quoted here on purpose: the pin is bumped weekly, and a copy in prose goes
  stale within days.
- yt-dlp ages fast, YouTube especially, and rebuilding the image does **not** pull a newer one. Since
  2026-08-17 the version is pinned exactly in `container/Dockerfile`, so every build installs that
  release and no other. This bullet said the opposite until 2026-08-29.
  What moves the pin is `.github/workflows/ytdlp-freshness.yml`. Each Monday it reads PyPI's newest
  stable release, and when that is ahead of the pin it pushes a branch and opens a PR. When the
  repository forbids it from opening one, it raises an issue saying the branch is ready instead. To
  get a newer yt-dlp, merge that PR, or edit the pin yourself and merge. Merging is the only thing
  that rebuilds and ships the image. Do not put a `>=` floor back; `test/ytdlp-pin.test.mjs` refuses
  one, and the Dockerfile carries the reasoning. Only `yt-dlp` itself is pinned: its dependencies,
  `yt-dlp-ejs` among them, still resolve fresh on every build.
- Some sites, Vimeo among them, fail `"attempting impersonation, but no impersonate target is
  available"` without curl_cffi. The image installs `yt-dlp[default,curl-cffi]`, because the plain
  `[default]` extra doesn't include it, and yt-dlp auto-uses it for extractors that request
  browser-TLS impersonation.
- Threads video doesn't come through here. A Threads post already carries a progressive MP4
  (measured on 2026-07-22 across four live posts). Since 2026-08-09 the Worker fetches those
  `scontent` bytes and serves them itself (`proxyableVideoUrl` in `src/mediaproxy.ts`), with a 302 to
  the signed CDN url as the fallback. This note used to say that Meta blocks Cloudflare's egress for
  those bytes, and that claim was retired when a Worker fetch of a Threads `scontent` url came back
  as real video (`src/platforms/threads/normalize.ts`).
- The image must be linux/amd64, and it is (`python:3.12-slim` plus a static Deno binary).
