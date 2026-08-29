# media-resolver — the mbedfx remux/resolve container (ffmpeg + yt-dlp).
# Debian slim over Alpine deliberately: ffmpeg and yt-dlp are far better exercised on glibc, and this
# is a media tool where robustness beats image size. yt-dlp comes from pip (not apt) because apt's
# copy lags releases badly and YouTube needs frequent yt-dlp updates. It is PINNED below, so a
# rebuild does NOT pick up a newer one: the version moves only when the pin moves.
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
# stood here read like "always current" and bought nothing. It is a FLOOR, not a target: pip picks
# whatever satisfies it at build time, and NOTHING ANYWHERE RECORDED WHAT THAT WAS — not the repo,
# not a commit, not a build log. NOBODY COULD TELL WHICH VERSION WAS RUNNING.
#
# THE ORIGINAL ARGUMENT FOR THE PIN CITED DOCKER LAYER CACHING — a floor resolves once, Docker reuses
# the layer forever because the instruction text never changes, so the version freezes — AND THAT IS
# NOT HOW THIS IMAGE IS BUILT. There is no machine holding this repo's previous layers. Every merge
# to main runs `wrangler deploy` in a Cloudflare Workers Builds runner off a fresh clone at
# `/opt/buildhome/repo`, and this repo's own build logs report `Image does not exist remotely,
# pushing:` on that build — a from-scratch build and a new digest each time (container/README.md
# quotes the log). So a floor here would not freeze, it would FLOAT: each merge silently installs
# whatever pip resolves that day, two builds of one commit can ship different yt-dlp, and a release
# that breaks a platform arrives with no commit to revert.
#
# THE PIN IS STILL RIGHT, for the two reasons that survive the correction. The image is
# REPRODUCIBLE — a commit names exactly one yt-dlp, so "which version ran when that card broke" is
# answerable from the repo alone. And it is ROLLBACK-ABLE — a bad release is one one-line revert
# away instead of something to wait out. Both were unavailable under the floor, and the second is
# what matters most here: ONE binary serves six platforms (see below).
#
# WHAT THE MISSING RECORD COST, 2026-08-17: every NEW YouTube video on the site was a thumbnail with
# no player, while older ones kept playing from the R2 cache. Metadata was fine — title, channel,
# upload date, view and like counts all correct — because the metadata call passes
# `--ignore-no-formats-error` (see server.py, where it is what makes an age-gated video render at
# all). So YouTube withheld the FORMATS, the meta call papered over it, and the mux had nothing to
# select. Reproduced locally by forcing a client YouTube gates: `-J` returns a complete metadata
# object while the same selector fails "Requested format is not available".
#
# THE FLOOR DID NOT CAUSE THAT OUTAGE, and this paragraph used to imply it did. The version running
# was 2026.7.4 — the newest STABLE at the time, and what this pin first named, so the pin changed
# nothing about what was installed. The cause was that release's DEFAULT player clients: YouTube
# began enforcing GVS PO tokens on `android_vr` about two weeks after 2026.7.4 shipped, and
# googlevideo answered the format urls it handed back with 403. The fix was container/server.py
# naming `player_client=web_embedded,tv_simply,mweb`, not a version bump. See the 2026-08-17 "Fixed"
# entry in docs/CHANGELOG.md. What the floor cost was the DIAGNOSIS: with no record of the installed
# version, "is yt-dlp simply stale?" could be neither confirmed nor ruled out, and it was the first
# thing everybody asked.
#
# AN EXACT PIN IS ALSO WHAT GIVES THE WEEKLY BUMP SOMETHING TO DO — not because rewriting the string
# invalidates a layer (there is no cached layer to invalidate), but because the pin is the only place
# the version is written down. Bumping it is therefore a reviewable one-line commit with a date on
# it. Under the floor the job had nothing to compare against and nothing to change. Note what that
# review does NOT include: CI never installs yt-dlp (ci.yml runs the suites with no network and no
# container) and a branch build ships the Worker alone, so the new release is unexercised until the
# merge — which is exactly why the revert has to be one line.
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
# floor again: a floor makes the running version unrecorded and un-revertable, which is the state the
# 2026-08 diagnosis had to work around.
RUN pip install --no-cache-dir "yt-dlp[default,curl-cffi]==2026.8.19"

WORKDIR /app
COPY server.py .

# The Worker's container binding talks to this port. Not a public route.
EXPOSE 8080
CMD ["python", "server.py"]
