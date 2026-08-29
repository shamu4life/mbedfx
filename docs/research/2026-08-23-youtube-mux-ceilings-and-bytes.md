# YouTube mux ceilings and bytes — investigation, 2026-08-23

**FROZEN 2026-08-29. This is a dated record, not a plan, and it was moved here from the repository
root because it had stopped being one.** It was written as a handoff while two PRs were open. Both
merged on 2026-08-24, everything it proposed shipped, and its measurements are pinned to a rig that
no longer exists. Read it for the reasoning, which is still good, and for the numbers only with the
corrections below applied. What supersedes it as current guidance is
`docs/research/2026-08-29-the-1500ms-crawler-cut.md`.

It sat at the repository root, where an agent reads it first, telling that agent to chase PO tokens
and to accept a thumbnail on the first paste. Both were wrong by the time anyone read them. It is
dated 2026-08-23 because that is when it was measured; like the other notes in `docs/research/` it
is frozen at that date and cited from prose rather than maintained.

Goal at the time: replace Discord's built-in YouTube embed (ads regardless of length or Premium)
with our own ad-free MP4. That needed the mux to succeed reliably and quickly.

**What has changed since, in the order it matters:**

- **"A first paste shows a thumbnail by design" is no longer the design.** That is the claim the
  2026-08-29 work reverses. The mux arm of the crawler's activity document now has a budget of its
  own, `YT_MUX_BOT_MS` (4000 ms, YouTube only), because the production counters showed the 1500 ms it
  replaced could never be won: 0 of 139 successful YouTube muxes finished inside it, and the fastest
  one ever recorded took 4200 ms. The rest of that line still holds — `og:video` width=0 is fine, do
  not re-litigate it.
- **PRs #57 and #58 both merged on 2026-08-24** (`81e9f37`, `4db8cc8`) and have been running ever
  since. Everything below filed as "in the tree (uncommitted)" or "in review" is live, and the
  `Commit / PR` half of "Two open decisions" went with them. The repo was consolidated to a single
  `main` branch on 2026-08-28, so neither `perf/mux-without-re-extracting` nor
  `fix/mux-durability-and-bytes` exists on the remote any more. The observability half is still open:
  `wrangler.jsonc` still reads `"observability": { "enabled": false }`.
- **The `ctx.waitUntil` 30-second ceiling — the central finding below — was lifted by #57.** The
  `MuxRunner` Durable Object alarm gets 15 minutes. Every conclusion here that reasons from "~8 MB is
  the most any attempt can finish" was true of the old dispatcher and is not true now.
- **The 180 s page-mux wall is gone.** `_mux_page` runs under its own `MUX_PAGE_TIMEOUT`, 360 s,
  since 2026-08-29. It was split out of `PROC_TIMEOUT` because it became the first ceiling that
  actually bit once the alarm made it reachable: `MAX_SECONDS` admits 1500 s of video, and a video
  that needed longer than 180 s was SIGKILLed with nothing written, on every attempt. "Do NOT raise
  `PROC_TIMEOUT`" below is still correct and was honoured — `PROC_TIMEOUT` (120 s) still walls the
  tracks mux that `MUX_FIRST_ATTEMPT_TRACKS_MS` is derived from, so the page mux got its own variable
  instead of that shared number being nudged.
- **Every timing here was taken on `instance_type: basic`, a quarter of a vCPU.** That was itself the
  finding of 2026-08-28: the "15.9s from Cloudflare egress" extract was our own CPU, not YouTube
  throttling. The container runs `standard-2` now and production measures 3.1-4.7s per client.
- **The pinned yt-dlp here is 2026.7.4, which returned 0 bytes and HTTP 403 on the default clients.**
  The image pins 2026.8.19, which returned 11,829,048 bytes on the same video in the same minute. So
  a 503 recorded below is not cleanly attributable to egress.
- **The ~267 KB/s figure is retired rather than updated**, because both terms under it moved: the
  quarter-core container and yt-dlp 2026.7.4, above. The question it raises — per-connection or
  per-egress — is still open and still worth the one measurement it needs. The number is not evidence
  for anything.
- **The PO token thread is closed, and the answer is no.** `/_clients` measured five of six player
  clients serving bytes from production egress with no token at all, including the two yt-dlp's own
  guide says require one. No minter buys anything and there is no age-gate bypass, so item 1 under
  "Next, in order" is not where to start. Recorded in `CLAUDE.md`.

A branch build's Workers Builds check went red on both PRs, benignly: branch builds run
`wrangler versions upload`, which cannot apply a Durable Object migration (error 10211). `main` runs
`wrangler deploy`, which can. That mechanism is unchanged and is still worth knowing.

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
| `subprocess.run(timeout=PROC_TIMEOUT + 60)` | 180 s of container work | no (see the header) |
| `ctx.waitUntil` | **~30 s, shared** | **this is the one** |

`settleMux`'s own comment claimed the opposite — that the mux "runs to completion
regardless of who wins this race". It was false. Corrected in place.

**And a cancelled attempt left nothing.** The container buffers the whole file before
sending a byte, writes to a fresh `tempfile.mkstemp` with `--force-overwrites`, and
deletes it in a `finally`. No partial R2 object, no resumable `.part`. `/_prep` returns
in 23 ms and then gets exactly 30 s, so re-pressing it was a lottery discarding 100% of
its bytes on every losing roll. That is the ten minutes, and why it never converged.

## Measured 2026-08-23, so nobody re-derives it

With **yt-dlp 2026.7.4** — what the image pinned at the time, replaced by 2026.8.19 on 2026-08-28 —
and the exact production argv, on `Qy2DltXI3Fc` (625 s — a 10-minute video):

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

## What shipped in PR #57, and lifted the 30 s ceiling above

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
  table above was CORRECT as of this date (1500 s of video, 180 s on the `{page}` mux; that
  wall is `MUX_PAGE_TIMEOUT` = 360 s since 2026-08-29, and the "reachable? no" column went
  false with it). What was imprecise was `container/README.md`'s 504 line, which named
  `PROC_TIMEOUT` without saying the `{page}` path gets its own wall. Fixed. **Do NOT raise
  `PROC_TIMEOUT`** hoping it helps: before the alarm it did nothing, and it is shared with
  the tracks mux that `MUX_FIRST_ATTEMPT_TRACKS_MS` is timed against. The page mux got its
  own variable instead, which is what that advice was pointing at.
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
