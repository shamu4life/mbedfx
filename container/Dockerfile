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
RUN pip install --no-cache-dir "yt-dlp[default,curl-cffi]>=2025.1.1"

WORKDIR /app
COPY server.py .

# The Worker's container binding talks to this port. Not a public route.
EXPOSE 8080
CMD ["python", "server.py"]
