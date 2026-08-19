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
# intermittent/selective POT enforcement has been observed for non-HLS formats") and is in NO stable
# release as of 2026-08-18. So no bump on this channel can resolve the outage described above; that
# needs a PO-token provider, a different egress, or accepting the thumbnail-card degrade. Do not read
# a future green bump here as having fixed it.
#
# yt-dlp[default,curl-cffi] — the extras are unchanged and argued above. Do not relax this to a
# floor again; a floor here is indistinguishable from a pin that never moves.
RUN pip install --no-cache-dir "yt-dlp[default,curl-cffi]==2026.7.4"

WORKDIR /app
COPY server.py .

# The Worker's container binding talks to this port. Not a public route.
EXPOSE 8080
CMD ["python", "server.py"]
