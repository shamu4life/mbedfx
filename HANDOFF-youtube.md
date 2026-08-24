# YouTube playback on mbedfx — handoff, 2026-08-23

Goal: replace Discord's built-in YouTube embed (ads regardless of length or Premium)
with our own ad-free MP4. That needs the mux to succeed reliably and quickly.

**State: uncommitted work sits in the tree on branch `perf/mux-without-re-extracting`.**
Nothing is committed, no PR is open. `npm run build` is green (1388 Worker tests,
tsc clean), `npm run test:container` green (29), and `npx wrangler deploy --dry-run
--containers-rollout=none` validates the new binding.

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

## Next, in order

1. **PO token provider** (`bgutil-ytdlp-pot-provider`) — the only thing that changes what
   googlevideo actually gives us. The alarm makes a slow mux FINISH; it cannot make a
   throttled stream fast. Container-side, so it ships on merge to main or via
   `wrangler dev --remote` with Docker running. **Docker was not running on 2026-08-23**,
   so this could not be tested.
2. **Prefer the 360p DASH pair** — 38% fewer bytes, no PO token needed, measured above.
3. **Reconcile the three ceilings** in `container/server.py` and
   `container/README.md:211` (which documents the `{page}` 504 as 120 s — it is 180 s).
   Do NOT raise `PROC_TIMEOUT` hoping it helps; before the alarm it did nothing, and
   after the alarm it only matters for videos that need >180 s of download.

## Do not re-derive

- Both client sets pick the byte-identical format 18. Format choice is not a lever for
  ACCESS (it is for BYTES — see the DASH pair above). Client-list trimming saves 0.4s;
  yt-dlp's cache 0.2s.
- YouTube gates/throttles Cloudflare egress; measured 2026-08-22 (4 fresh ids → 502 from
  Workers, same ids fine residentially, Dailymotion 200/76.6 MB through the same
  container the same day). PR #55's client switch bought hours, not a fix.
- Preview URLs serve nothing, all three forms, despite `previews_enabled: true`.
- Every merge rebuilds the container image, including docs-only ones.
- A cold container start can 503 the first request. Retry once.
- A first paste shows a thumbnail by design (PR #46). `og:video` width=0 is fine.
