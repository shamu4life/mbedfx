# media-resolver — the mbedfx video remux/resolve container

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
```

- **200 `video/mp4`** — the muxed file, streamed. The Worker pipes it straight into R2 and serves
  range reads from there, so each video is muxed at most once.
- **4xx/5xx `application/json` `{"error"}`** — the Worker falls back to the cover still.
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
  "view_count": …, "like_count": …, "comment_count": …, "age_limit": … }
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
fallback prefers the tallest entry at or under 720, matching the mux's own `height<=?720` selector.

## `RESOLVER_GENERATION`

> **Changing the meta-mode response shape above REQUIRES bumping `RESOLVER_GENERATION` in
> `src/worker.ts`.** So does any other change to what the container does.

Pooled instances have stable names and keep their booted image until `sleepAfter` (10m). Skip the
bump and a redeploy under steady traffic keeps answering with the old dict, the new fields arrive
`undefined`, and the change looks inert. The generation string is part of the instance name, so
changing it forces the new image in immediately.

The same string is the meta cache's generation, so a bump discards stored dates, descriptions and
counts across yt, fb, dm, st and im. The longest-lived is `YT_META_TTL_MS` at 30 days; fb, dm and im
hold for 24h, st for 30 minutes. `src/worker.ts` writes down one exception: 1.9.0 changed the
container's output dict and stayed on g10. The defect it fixed had stopped the Worker writing any
record at all, and there was nothing stale to retire.

## The mux

The mux is a stream copy, `-c copy -movflags +faststart`, never a transcode. The caps are
env-overridable, in `container/server.py`: `MAX_SECONDS=1500`, `MAX_BYTES=393216000` (a 375 MB
output ceiling), `PROC_TIMEOUT=120`. Both ceilings went up together on 2026-08-03: a stream copy
makes output size the source bitrate times the duration, and raising one alone only moves the
refusal to the other filter.

`container/server.py` is the source of truth for all three, and this line has now been wrong twice.
It read `MAX_SECONDS=1800` until 2026-07-26, long after the code said 1200, then `1200` / `300MB`
until 2026-08-05.

The `{page}` mux's match filter is `duration<?{MAX_SECONDS} & !is_live`, currently
`duration<?1500 & !is_live`. The `<?` and `!is_live` shape arrived with g5 on 2026-07-26. `<?` is
yt-dlp's none-inclusive comparison, and the previous `duration < 1200 & duration > 0` silently
excluded every source that declares no duration. An Imgur gifv reports `duration: None` and was
skipped outright (`does not pass filter … skipping ..`, reproduced on `i.imgur.com/A61SaA1.gifv`).
`!is_live` preserves the livestream rejection that `duration > 0` had been providing by accident. A
live source that got through would download until `PROC_TIMEOUT` and burn a container slot.

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

Outside Cloudflare is the one case where you build the image yourself. `server.py` is a plain HTTP
server with no Cloudflare surface in it, and `docs/SELF-HOSTING.md` has the plan. Set
`RESOLVER_SECRET`. Without it, the deployment is an unauthenticated fetch-anything remuxer.

### Warm instances

Instances are pooled onto `RESOLVER_SLOTS` keys, not minted per post. A deploy starts a gradual
rollout that retires them over minutes, and an instance the rollout hasn't reached keeps the image
it booted with until it sleeps (`sleepAfter`, 10m) or is otherwise recycled. A fresh post will most
likely land on an existing warm slot, so it's an unreliable way to reach a new image. The g10 block
in `src/worker.ts` has the note on the rollout.

To reach a rebuild sooner, wait out `sleepAfter` or recycle the instances.

## Status (2026-08-03)

Reddit and Bluesky single videos play in production, since their HLS muxes to a progressive
faststart MP4. Both were confirmed live against a real post: 200 `video/mp4` with a valid `ftyp`,
Range answered 206, the file cached in R2.

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
- yt-dlp ages fast, YouTube especially. Rebuilding the image pulls a newer `yt-dlp` and
  `yt-dlp-ejs`.
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
