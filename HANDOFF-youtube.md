# YouTube playback on mbedfx — handoff, 2026-08-23

Goal: replace Discord's built-in YouTube embed (ads regardless of length or Premium)
with our own ad-free MP4. That needs the mux to succeed reliably and quickly.

**State, 2026-08-23: committed and in review.** `9e2a1dc` on
`perf/mux-without-re-extracting` (PR #57, the alarm + telemetry) and
`fix/mux-durability-and-bytes` stacked on top of it (PR #58, the four items below).
Neither is merged, and merging is the deploy. Both are green.

Its Workers Builds check is RED on both, benignly: branch builds run
`wrangler versions upload`, which cannot apply a Durable Object migration (error
10211). `main` runs `wrangler deploy`, which can. See the memory note
`do-migrations-fail-branch-builds`.

---

## The 2026-08-23 finding, which corrects a month of comments

**The reported symptom** — "a 10-minute video took nearly ten minutes to warm on the
site" — was OURS, not YouTube's.

Every mux was dispatched through `ctx.waitUntil`: `settleMux`, the prewarm in
`renderPostRoute`, and the site's warm button `/_prep`. Cloudflare documents that as a
**hard 30-second ceiling**, shared across every `waitUntil` in one request:

> "`waitUntil()` can extend execution for up to 30 seconds after the response is sent or
> the client disconnects. This time limit is shared across all `waitUntil()` calls within
> the same request. If any Promises have not settled after 30 seconds, they are canceled."
> — developers.cloudflare.com/workers/runtime-apis/context/

So there were **three ceilings and only the smallest was real**:

| ceiling | value | reachable? |
|---|---|---|
| `--match-filter duration<?MAX_SECONDS` | 1500 s of video | no |
| `subprocess.run(timeout=PROC_TIMEOUT + 60)` | 180 s of container work | no |
| `ctx.waitUntil` | **~30 s, shared** | **this is the one** |

`settleMux`'s own comment claimed the opposite — that the mux "runs to completion
regardless of who wins this race". It was false. Corrected in place.

**And a cancelled attempt left nothing.** The container buffers the whole file before
sending a byte, writes to a fresh `tempfile.mkstemp` with `--force-overwrites`, and
deletes it in a `finally`. No partial R2 object, no resumable `.part`. `/_prep` returns
in 23 ms and then gets exactly 30 s, so re-pressing it was a lottery discarding 100% of
its bytes on every losing roll. That is the ten minutes, and why it never converged.

## Measured 2026-08-23, so nobody re-derives it

With the **pinned yt-dlp 2026.7.4** (installed locally, same version as the image) and
the exact production argv, on `Qy2DltXI3Fc` (625 s — a 10-minute video):

- format **18**, `640x360`, 414 kbps, **`proto=https`**, **32,347,090 bytes**
- residential throughput on the resolved url: **17.2 MB/s** (8 MB range fetch, 0.49 s)
- **`--concurrent-fragments 4` is INERT on YouTube.** Every format lists `PROTO https`,
  including the `_dash` ones; the flag is documented as "fragments of a dash/hlsnative".
  There are no fragments. The one flag aimed at long-video latency does nothing on the
  platform that needs it most. It still has live consumers on the HLS/DASH platforms, so
  scope the comment rather than deleting the flag.
- **The selector picks the expensive format.** Format 18 is 30.85 MiB; the DASH pair
  `134`+`140` is the *same* 640x360 at **19.2 MiB — 38% fewer bytes**. Under a throughput
  throttle, bytes are the binding constraint. Not acted on.

## What is in the tree (uncommitted)

1. **`MuxRunner`** (`src/muxrunner.ts` + `src/muxpolicy.ts`, binding `MUX_RUNNER`,
   migration `v2`) — a Durable Object whose **alarm gets 15 minutes**. Fires at 35 s,
   deliberately after the inline attempt is dead: a fast mux has already written to R2,
   so the alarm's first act is an R2 head check that hits and does no container work.
   Firing sooner would race a live attempt and mux one video twice on one pooled
   instance — the failure `muxOnce` exists to prevent. Two bounded retries (+2 min,
   +20 min, ~22 min horizon) so a reader pastes ONCE. Addressed by the mux key, so it is
   also the first **global** dedupe this path has had (`muxOnce` is isolate-local).
   `MUX_RUNNER` is optional like `MEDIA_RESOLVER` — no binding, old behaviour.
   The retry policy lives in the pure `muxpolicy.ts` because `muxrunner.ts` imports
   `cloudflare:workers` and cannot be loaded under `node --test`.
2. **Mux telemetry** — `ensureMuxed` was reading the container's status and then
   cancelling its error body **unread**. Eight `mux_*` outcomes now separate
   `mux_timeout` (ours) from `mux_gate` (theirs) from `mux_empty` (same 502, different
   cause), plus `double2` = elapsed ms. Documented in `docs/METRICS.md`. No url reaches a
   counter — fixed enum from a closed allowlist of the container's own error strings.
3. **The finished `perf/mux-without-re-extracting` work** — the Worker half that was
   missing. `mux_video`/`mux_audio` now reach the Post's `remux` entry for dm/st/im,
   carried BESIDE the R2 meta record (they are IP-bound and expire in hours; the record
   lives 30 min to 24 h). Helps dm/st/im, not YouTube.

## Two open decisions

- **Observability is still OFF, deliberately, pending a call.** The owner approved
  turning it on, but `wrangler.jsonc:24-43` argues against it in detail and that argument
  was not in front of them: Workers Logs stores the request URL — *which is the post
  somebody pasted* — plus client IP, UA, referer and geo, citing TwitFix dying over a
  public log of processed urls. The `mux_*` counters carry none of that and answer
  "which gate, per platform, how slow" on their own. A Tail Worker that redacts before
  storing is the middle path if logs are wanted.
- **Commit / PR.** Nothing committed. Branch `perf/mux-without-re-extracting`.

## Done since (PR #58, `fix/mux-durability-and-bytes`)

- ~~**Prefer the 360p DASH pair**~~ — DONE and VERIFIED LIVE. `134+140` is the
  selector's first arm. The cause is the H.264 PROFILE, not the resolution: 18 is
  `avc1.42001E` (Baseline), 134 is `avc1.4d401e` (Main).
  **Confirmed running in production 2026-08-24** on `wmaB6rEQVRM`: prod served
  1,483,540 bytes where format 18 is 1,153,011 and the pair is 1,472,505 (the ~11 KB
  excess is ffmpeg's mp4 remux overhead). NOTE the trap that cost an hour: for ~15
  minutes after the merge, cold muxes came back at format 18's EXACT byte count,
  because old-image container instances were still serving. `wrangler containers list`
  showed `provisioning`; wait for `active` AND for the digest in
  `wrangler containers info` to change before concluding anything about a container change.
  Re-measured across 27 videos: it is NOT a uniform win — -30.6% on 10-25 min (6/7),
  -30.8% on 2-10 min (5/7), but +26% to +43% on short 202x360 clips. See the table in
  `container/server.py` next to the selector.
- ~~**Reconcile the ceilings**~~ — DONE, and the finding was smaller than expected. The
  table above is CORRECT (1500 s of video, 180 s on the `{page}` mux). What was imprecise
  was `container/README.md`'s 504 line, which named `PROC_TIMEOUT` without saying the
  `{page}` path gets `PROC_TIMEOUT + 60`. Fixed. **Do NOT raise `PROC_TIMEOUT`** hoping it
  helps: before the alarm it did nothing, and after the alarm it only matters for videos
  needing >180 s of download.
- **Bluesky and Reddit had NO alarm coverage** — found while checking the above, and
  bigger than either. `settleMux` returns before its arming loop for any page-less remux
  and `prewarmable()` is null for `bs`/`rd`, so their only dispatcher was `serveMuxed`,
  inside Discord's request, with no `ExecutionContext`. Cancelled = zero bytes = every
  paste restarting from nothing. Both dispatchers now arm, and the tracks path gets its
  own first-attempt delay (`MUX_FIRST_ATTEMPT_TRACKS_MS = 140_000`) because 35 s is
  derived from a `waitUntil` ceiling that path does not have.
- **`card_degraded`** — the degrade was counted nowhere and the same render fired `ok`.
- **The over-ceiling skip was dead code on yt** — `normalizeYouTube` carried no duration.

## Next, in order

1. **PO token provider** (`bgutil-ytdlp-pot-provider`) — the only thing that changes what
   googlevideo actually gives us. The alarm makes a slow mux FINISH and the DASH pair makes
   it shorter; neither makes a throttled stream fast. Container-side, so it ships on merge
   to main or via `wrangler dev --remote` with Docker running.
2. **Settle whether Cloudflare's ~267 KB/s is per-CONNECTION or per-EGRESS.** This is the
   highest-value unknown left and it is one measurement. googlevideo serves parallel Range
   requests at full speed residentially. If the throttle is per-connection, N-way parallel
   ranges inside the container collapse a 120 s download to ~15 s and every ceiling above
   stops mattering. If it is per-egress, drop the idea. It cannot be answered from a laptop:
   it needs a request issued from Cloudflare's egress, so it waits on a merge or on
   `wrangler dev --remote`.
3. **Read `card_degraded / ok` on `blob3='discord'`** once #57 and #58 are live. That is the
   before/after this whole workstream has been arguing about without data.

## Do not re-derive

- Both client sets pick the byte-identical format 18. Format choice is not a lever for
  ACCESS (it is for BYTES — see the DASH pair above). Client-list trimming saves 0.4s;
  yt-dlp's cache 0.2s.
- YouTube THROTTLES Cloudflare egress but does NOT block it — **corrected 2026-08-23**, and
  the earlier "gates" reading was drawn from evidence that cannot carry it. Head-to-head on
  same-day uploads, prod vs this same container code on a laptop: `hFQ-UPZ77kA` muxed cold
  from production, HTTP 200, 6,011,494 bytes, byte-identical to the local run — but 22.5 s
  against 7.1 s (3.2x), and two other short videos were refused 6/6 from Cloudflare while
  muxing residentially in ~8 s. ~267 KB/s against a 30 s `waitUntil` ceiling is ~8 MB max
  per attempt, which is why a 10-minute video could never finish. The 2026-08-22 inference
  ("4 fresh ids -> 502, therefore gated") was read off `notReady()`, which returns the same
  bodiless 503 for our own timeout, a cold container, a pool exhaustion and their gate
  alike. That is what `card_degraded` and the `mux_*` counters exist to answer.
- Preview URLs serve nothing, all three forms, despite `previews_enabled: true`.
- Every merge rebuilds the container image, including docs-only ones.
- A cold container start can 503 the first request. Retry once.
- A first paste shows a thumbnail by design (PR #46). `og:video` width=0 is fine.
