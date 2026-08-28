# media-resolver — the mbedfx remux/resolve container (ffmpeg + yt-dlp).
# Debian slim over Alpine deliberately: ffmpeg and yt-dlp are far better exercised on glibc, and this
# is a media tool where robustness beats image size. yt-dlp comes from pip (not apt) so it stays
# current — YouTube in particular needs frequent yt-dlp updates; rebuild the image to pick them up.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# Deno — the JS runtime yt-dlp needs to solve YouTube's signature / n-param challenges (the "EJS"
# requirement, https://github.com/yt-dlp/yt-dlp/wiki/EJS). Measured 2026-07-22: WITHOUT a JS runtime a
# {page} resolve of a YouTube url fails "extraction without a JS runtime has been deprecated" (rc=1) —
# it is NOT an IP block (yt-dlp reached YouTube and pulled the player), just a missing dependency. A
# single static binary on PATH; yt-dlp auto-detects it.
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && unzip -o /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && chmod +x /usr/local/bin/deno

# yt-dlp[default,curl-cffi] — the curl-cffi extra gives --impersonate a browser-TLS target, which
# Vimeo (and other impersonation-gated sites) need: without it they fail "attempting impersonation, but
# no impersonate target is available" (measured 2026-07-22; [default] alone does NOT pull curl_cffi).
# yt-dlp auto-uses it for extractors that request impersonation. YouTube does not need it (Deno covers
# that), so it is a long-tail robustness dep, not a YouTube one.
# PINNED EXACTLY, AND BUMPED WEEKLY by .github/workflows/ytdlp-freshness.yml. The `>=2025.1.1` that
# stood here read like "always current" and did the opposite. It is a FLOOR, not a target: pip
# resolves it once, at the moment this layer is first built, and Docker then reuses that layer on
# every later build because the instruction text never changed. The version therefore froze at
# whatever was newest the day the image was first built and never moved again — and because nothing
# records or reports it, NOBODY COULD TELL WHICH VERSION WAS RUNNING.
#
# WHAT THAT COST, measured 2026-08-17: every NEW YouTube video on the site was a thumbnail with no
# player, while older ones kept playing from the R2 cache. Metadata was fine — title, channel, upload
# date, view and like counts all correct — because the metadata call passes
# `--ignore-no-formats-error` (see server.py, where it is what makes an age-gated video render at
# all). So YouTube withheld the FORMATS, the meta call papered over it, and the mux had nothing to
# select. Reproduced locally by forcing a client YouTube gates: `-J` returns a complete metadata
# object while the same selector fails "Requested format is not available".
#
# AN EXACT PIN IS WHAT MAKES THE WEEKLY BUMP WORK, and the two are one mechanism rather than two
# ideas: changing this string is what invalidates the layer, so the pin is not bureaucracy around the
# update, it IS the update. It also makes the running version answerable from the repo alone.
#
# STABLE RELEASES ONLY. THIS IS A DECISION, NOT AN OVERSIGHT — owner, 2026-08-18: "nightly is not
# acceptable for the pipeline releases only." Nightlies are not release-tested, and ONE binary here
# serves Dailymotion, Streamable, Imgur, Facebook, TikTok and YouTube: a bad build does not degrade
# one platform, it takes every yt-dlp platform out at once. The weekly job below therefore reads
# PyPI's `info.version`, which is the newest STABLE, and must not be repointed at the `.dev` channel
# without asking.
#
# WHAT THAT COSTS, WRITTEN DOWN SO NOBODY LATER READS THE QUIET AS A BROKEN JOB. Stable ships
# sparsely: measured on PyPI 2026-08-18, this year gave 2026.3.3, 2026.3.13, 2026.3.17, 2026.6.9 and
# 2026.7.4 — an ELEVEN-WEEK gap between March and June. So the weekly check will report "already
# current" most Mondays and open nothing. That is the job working. What it buys is that when a stable
# release does land, it is picked up within a week instead of never, which is the actual defect this
# replaced.
#
# AND IT DOES NOT FIX YOUTUBE, which has to be said here rather than discovered later. YouTube began
# enforcing GVS PO tokens on the `android_vr` client — 2026.07.04's own default — about two weeks
# AFTER 2026.07.04 shipped. yt-dlp's handling merged 2026-07-20 (commit 69ea20006, "Since 2026.07,
# intermittent/selective POT enforcement has been observed for non-HLS formats").
#
# THAT PARAGRAPH USED TO END "and is in NO stable release as of 2026-08-18", and it was true when
# written and false the very next day: **2026.8.19 shipped on 2026-08-19**, the first stable carrying
# the POT handling.
#
# THE WEEKLY JOB WORKED. It is worth writing down, because the obvious reading of a nine-day-stale pin
# is "the automation is broken" and that reading is wrong. On 2026-08-24 the job detected the release,
# pushed `chore/ytdlp-2026.8.19`, could not open a pull request (the repo setting "Allow GitHub Actions
# to create and approve pull requests" is off), and did exactly what it was designed to do instead:
# raised issue #59 saying the branch was ready and why the PR could not be opened. The branch and the
# issue both sat untouched for four days. The gap was follow-through, not detection — so the fix is to
# turn that setting on (or to watch the issues), NOT to change the job.
#
# WHAT THE BUMP BUYS, measured 2026-08-28 on one machine in one minute, both images side by side:
#
#   yt-dlp 2026.7.4   default clients -> 0 bytes, "HTTP Error 403: Forbidden"
#   yt-dlp 2026.8.19  default clients -> 11,829,048 bytes
#   (web_embedded, our override, downloads 11,829,048 bytes on BOTH)
#
# So this release repairs the exact 403 that container/server.py's YT_PLAYER_CLIENTS override was
# written to work around — the POT handling landed and it works. The override is deliberately LEFT IN
# PLACE by this change: it is measured, it keeps the full format ladder (19-23 formats vs one), and
# removing it is a separate decision that needs its own measurement from PRODUCTION egress, not from a
# laptop. See the note in server.py.
#
# IT IS NOT A REGRESSION either: same argv, same downloads, and an identical CPU profile (extraction
# median-of-3 across four instance sizes: 16.8 / 9.1 / 5.9 / 5.2s, matching 2026.7.4 within noise).
#
# WHAT IT DOES NOT FIX, said plainly so a green bump is not misread as an all-clear: the egress. About
# 40-50% of Cloudflare-egress YouTube requests are refused where residential succeeds every time — a
# RATE, not a block, which is IP reputation rather than a missing credential. And a PO token is not the
# missing piece: measured the same day, pytubefix minted a valid one, attached it as `pot=` in the media
# url, and STILL got 403 residentially, while a token-free client downloaded 11.8 MB from the same
# container in the same second.
#
# yt-dlp[default,curl-cffi] — the extras are unchanged and argued above. Do not relax this to a
# floor again; a floor here is indistinguishable from a pin that never moves.
RUN pip install --no-cache-dir "yt-dlp[default,curl-cffi]==2026.8.19"

WORKDIR /app
COPY server.py .

# The Worker's container binding talks to this port. Not a public route.
EXPOSE 8080
CMD ["python", "server.py"]
