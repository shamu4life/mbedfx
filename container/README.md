# media-resolver — the mbedfx video remux/resolve container

A tiny **ffmpeg + yt-dlp** service that turns a DASH/HLS video (or any yt-dlp-supported page) into one
**progressive, faststart MP4** the Worker can serve as `og:video`. It's how Reddit / Bluesky / Instagram
(and, best-effort, YouTube / Vimeo / Dailymotion / Facebook / ~1800 more) get *playable* video instead
of a cover still. It is our own self-hosted, single-purpose Cobalt — we own it, so no third-party uptime
or extractor-drift dependency.

## Interface (the contract the Worker calls)

`POST /resolve` (JSON body), reached only by the Worker via its container binding — never a public route:

```jsonc
{ "video": "<url>", "audio": "<url>"|null }  // mux tracks we already extracted (v.redd.it + DASH_audio,
                                             // a bare HLS .m3u8 or DASH .mpd as `video` with no `audio`)
{ "page": "<url>" }                          // yt-dlp resolves + merges (YouTube/Vimeo/FB/…)
{ "page": "<url>", "meta": true }            // METADATA ONLY (yt-dlp -J, no download) — see below
```

- **200 `video/mp4`** — the muxed file, streamed. The Worker pipes this straight into R2 and serves range
  reads from there, so each video is muxed **at most once**.
- **4xx/5xx `application/json` `{"error"}`** — the Worker falls back to the cover still.
- `GET /health` → `200 ok`.

### Meta mode (`{"page": …, "meta": true}`)

**200 `application/json`**, a dumb passthrough of one `yt-dlp -J` — no download, no second subprocess.
It exists for platforms whose crawler/oembed metadata surface is gated from datacenter egress but whose
video yt-dlp still resolves (Facebook: Meta decoys `facebookexternalhit` from datacenter). Shape:

```jsonc
{ "_type": …, "title": …, "thumbnail": …, "uploader": …, "uploader_id": …, "uploader_url": …,
  "description": …, "width": …, "height": …, "duration": …, "timestamp": …,
  // added 2026-08-01, g8 — a record written before that has none, which is why the generation moved
  "view_count": …, "like_count": …, "comment_count": …, "age_limit": … }
```

`_type` (added 2026-07-26, g5) is yt-dlp's own kind and is the ONLY field that tells a video from a
**playlist**. It matters because the Worker's content assertion is "`title` is a non-empty string",
which an Imgur album PASSES — measured 2026-07-26, `imgur.com/a/iX265HX` returns `_type: "playlist"`
with a title and nothing else (no thumbnail, no dimensions, no duration, no timestamp), so without it
the card ships as a bare headline over a video url that resolves to nothing.

Any field may be `null` — all judgement lives in `src/platforms/facebook/normalize.ts` (pure, unit-tested
with no network), and `src/worker.ts` treats every field but `title` as optional. `width`/`height` fall
back to a sized entry in `formats` when the top level has none (a Facebook progressive `sd`/`hd` format
carries no height), preferring the tallest **at or under 720** so the number matches the format the mux's
own `height<=?720` selector will pick; without them the card ships `og:video:width="0"`, which tells a
client nothing about the file it is about to fetch.

> **Changing this response shape REQUIRES bumping `RESOLVER_GENERATION` in `src/worker.ts`.** Pooled
> instances have stable names and keep running the image they booted with until `sleepAfter` (10m), so
> without the bump a redeploy under steady traffic keeps answering with the OLD dict and the new fields
> are silently `undefined` — the change looks inert. The generation string is part of the instance name,
> so changing it forces the new image in immediately.

It is a **remux** (`-c copy -movflags +faststart`), never a transcode — milliseconds of CPU, lossless.
Caps (env-overridable): `MAX_SECONDS=1200`, `MAX_BYTES=300MB`, `PROC_TIMEOUT=120`. (This line read
`MAX_SECONDS=1800` until 2026-07-26; the code has said 1200 since the 20-minute ceiling landed.)

The `{page}` mux's match filter is **`duration<?1200 & !is_live`** (g5, 2026-07-26). `<?` is yt-dlp's
none-inclusive comparison: the previous `duration < 1200 & duration > 0` silently excluded every source
that declares NO duration, which is a class rather than an edge case — an Imgur gifv reports
`duration: None` and was skipped outright (`does not pass filter … skipping ..`, reproduced on
`i.imgur.com/A61SaA1.gifv`). `!is_live` is not decoration: it PRESERVES the livestream rejection that
`duration > 0` was providing by accident, so a live source cannot now download until `PROC_TIMEOUT` and
burn a container slot.

## Deploying it

**MERGING TO `main` IS THE DEPLOY, AND IT BUILDS THIS IMAGE. Do not run `wrangler deploy` by hand.**

This section used to give a two-command manual deploy, which contradicted the project's hard rule
that Cloudflare Workers Builds is the only deployer — and a hand deploy overwrites whatever the build
shipped while prod goes on looking healthy. Corrected 2026-08-04 after reading an actual build log.

`wrangler.jsonc` points `image` at `./container/Dockerfile` rather than at a registry tag, and
Cloudflare's own docs say that when `image` is a Dockerfile path, `wrangler deploy` builds it and
pushes it to Cloudflare's registry. Workers Builds' deploy command **is** `npx wrangler deploy`. So
the build log for a merge to `main` shows the whole job — measured on this repo's own builds:

```
Executing user deploy command: npx wrangler deploy
 - fxeverything-mediaresolver (/opt/buildhome/repo/container/Dockerfile)
Building image fxeverything-mediaresolver:…
Image does not exist remotely, pushing: registry.cloudflare.com/…
digest: sha256:…
├ EDIT fxeverything-mediaresolver
SUCCESS  Modified application fxeverything-mediaresolver
```

Nothing is needed on your machine: no Docker, no login, no dashboard step. **If a change to this
directory did not take effect, read the build log for `Building image` and `Modified application`
before suspecting anything else** — their absence means the image did not ship.

Note the asymmetry: a **preview** build (any branch that is not `main`) runs
`npx wrangler versions upload` instead, which does **not** build the image. A container change is
therefore untested by the preview build and lands only on merge.

Running instances are replaced by a gradual rollout rather than instantly, so allow a few minutes
after the build finishes before judging whether a container change worked.

**Everything else is already wired**: the `@cloudflare/containers` dependency, `src/container.ts`
(the `MediaResolver` DO class), the deploy entry `src/index.ts`, the R2 bucket `mbedfx-media`, and
the `wrangler.jsonc` `containers` / `durable_objects` / `migrations` / `r2_buckets` config.

**Running it outside Cloudflare** — the one case where you do build it yourself, because `server.py`
is a plain HTTP server with no Cloudflare surface in it. See `docs/SELF-HOSTING.md`; set
`RESOLVER_SECRET` or you have published an unauthenticated fetch-anything remuxer.

Once the container is live, the Worker's `/_media/` route automatically serves muxed video for posts that
carry a `remux` source; without it (or before it finishes provisioning) those videos render the cover
still — the Worker checks the bindings and degrades safely, so a card is never broken.

**Redeploys don't recycle running instances.** Instances are POOLED onto `RESOLVER_SLOTS` keys, not
minted per post, and one keeps the OLD image until it sleeps (`sleepAfter`, 10m) or is otherwise
recycled. So a fresh post is NOT a reliable way to reach the new image — it will most likely land on
an existing warm slot. This contradicted the pooling description earlier in this file; that one was
right. To test a rebuild, wait out `sleepAfter` or recycle the instances.

Optional: `npx wrangler secret put RESOLVER_SECRET` and set the same `RESOLVER_SECRET` on the container
(as a container secret — NOT `containers[].image_vars`, which wrangler documents as build-time only,
so a value set there never reaches the running instance) to require the shared-secret header.

## Status (2026-08-03)

Deployed to **production** and validated end-to-end; the staging environment it was
originally verified on has since been retired in favour of Workers Builds previews. **Reddit** and **Bluesky** single videos play (their
HLS muxes to a progressive faststart MP4); each was confirmed live — a real post → 200 `video/mp4`, valid
`ftyp`, Range 206, cached in R2 so it muxes once. **Threads** (DASH) is not wired yet.

## Testing the container after deploy

It isn't a public route, so exercise it through a throwaway Worker route (remove after — do NOT commit it;
the pipeline tests forbid debug routes in worker.ts):
```ts
if (url.pathname === '/__muxtest') {
  const r = await env.MEDIA_RESOLVER.getByName('t').fetch('http://c/resolve', {
    method: 'POST',
    body: JSON.stringify({ video: 'https://v.redd.it/<id>/HLSPlaylist.m3u8' }),
  })
  return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || '' } })
}
```
A 200 `video/mp4` of a few MB means it works. `GET /__muxtest` should play in a browser. Or just paste a
Reddit/Bluesky video post at the staging host and open `/_media/<refKey>/0`.

## Notes
- **HLS whose segments redirect hosts** (Bluesky: `video.bsky.app` playlist → `video.cdn.bsky.app`
  segments) breaks HTTP keepalive reuse and made an older ffmpeg abort the mux. The muxer runs each input
  with `-http_persistent 0` + reconnect flags (`HTTP_OPTS` in `server.py`) — a fresh connection per
  segment — which fixes it. Reddit needs neither (no host redirect).
- **YouTube is NOT datacenter-IP-blocked** (measured 2026-07-22, corrected from an earlier assumption).
  A `{page}` resolve of a YouTube watch url returns a real ad-free mp4 from Cloudflare Container egress —
  it needed only (a) **Deno** in the image (yt-dlp's "EJS" JS-runtime requirement for YouTube's signature /
  n-param challenge — without it: `rc=1, "extraction without a JS runtime has been deprecated"`), and (b)
  the `{page}` **skip-bug fix**: the caller pre-creates `out` via `tempfile.mkstemp`, so yt-dlp saw a file
  already there and skipped ("already downloaded", exit 0, 0-byte file → "empty or oversized result");
  `--force-overwrites` fixes it (ffmpeg's `-y` already covered `_mux_tracks`). Facebook is a separate story
  (Meta TLS/UA gating) — untested here. **yt-dlp ages fast** (YouTube especially); rebuild the image
  (`wrangler deploy`) to pull a newer `yt-dlp` + `yt-dlp-ejs`.
- **Impersonation.** Some sites (Vimeo, …) fail `"attempting impersonation, but no impersonate target is
  available"` without **curl_cffi** — the image installs `yt-dlp[default,curl-cffi]` (the plain `[default]`
  extra does NOT include it); yt-dlp auto-uses it for extractors that request browser-TLS impersonation.
- Image must be **linux/amd64** (it is — `python:3.12-slim` + a static Deno binary).
