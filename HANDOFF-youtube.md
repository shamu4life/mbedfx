# Parked: YouTube playback on mbedfx — 2026-08-22

Goal behind this work: replace Discord's built-in YouTube embed (ads regardless of
length or Premium) with our own ad-free MP4. That needs the mux to succeed reliably.

## Shipped and verified

- **#55** `web_embedded,tv_simply,mweb` — merged `191c4ed3`, verified on Cloudflare
  egress: same video 503/0 bytes before, 200/12,714,536 bytes after.
- **#54** yt-dlp pinned `==2026.7.4` + weekly stable check — merged `b104afdc`.
- **#56** changelog + corrected the `wrangler.jsonc` comments that pointed at
  preview URLs as a pre-merge test — merged `6d1b691d`.

## The blocker, measured 2026-08-22

YouTube refuses extraction from Cloudflare egress. Not us:

    new YouTube mux, 4 fresh ids   -> 502 (yt-dlp non-zero exit)
    same ids, residential IP       -> fine, format 18, url present
    Dailymotion, same container    -> 200, 76,661,890 bytes
    cached YouTube from R2         -> 200
    container health               -> 4 active, 3 healthy, 0 failed

It served real bytes hours earlier the same day. #55 dodged GVS PO-token
enforcement with a not-yet-enforced client; YouTube caught up.

## Next, in order

1. **Make failures legible.** `container/server.py` suppresses yt-dlp stderr, so every
   gate reads `{"error": "mux failed"}`. A sanitized error class into the existing
   analytics counters is small and makes every future recurrence a one-line answer.
2. **PO token provider** (`bgutil-ytdlp-pot-provider`) — addresses the root cause, no
   account risk. Cookies are faster (plumbing exists: `_CookieJar`, `withCookieJar`,
   credential pool, `docs/CREDENTIALS.md`) but risk the account.
3. **Cold paste / latency last.** First paste shows a thumbnail by design (PR #46);
   optimistic `og:video` is the only fix and is unsafe until the gate is reliable.

## Parked branch: `perf/mux-without-re-extracting` (pushed, no PR)

Green — 29 container tests, 1363 Worker tests, tsc clean — but **incomplete**: the
Worker never sets `remux.video`, so the fast path is unused. Finish by attaching
`mux_video`/`mux_audio` to the Post's remux entry for the yt-dlp tier.

Parked because YouTube's cold card never calls the container (1.70s card vs ~5.0s
extraction), so YouTube pays ONE extraction, not two — this helps dm/st/im, not
YouTube.

## Do not re-derive

- Both client sets pick the byte-identical format 18 (360x640, 596 kbps). Format
  choice is not a lever. Client-list trimming saves 0.4s; yt-dlp cache 0.2s.
- Preview URLs serve nothing (all three forms, incl. the live prod version's) despite
  `previews_enabled: true`. Cause unknown — Cloudflare support question.
- Every merge rebuilds the container image, including docs-only ones.
- A cold container start can 503 the first request. Retry once.
