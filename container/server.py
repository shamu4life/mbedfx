#!/usr/bin/env python3
"""
media-resolver — the mbedfx remux/resolve container.

A PURE muxer: given a video source, it produces one progressive, faststart MP4 and streams it back.
It holds NO state. The Worker owns R2 and streams this response into it, so each video is muxed once.

Two input modes (POST /resolve, JSON body):
  { "video": "<url>", "audio": "<url>"|null }   -> ffmpeg -c copy mux of tracks we already extracted
  { "page": "<url>" }                           -> yt-dlp resolves + merges (yt-dlp-supported sites)

Response: 200 video/mp4 (streamed) on success; 4xx/5xx application/json {"error"} on failure. GET
/health -> 200. REMUX not transcode: `-c copy -movflags +faststart` — lossless, milliseconds of CPU.

SECURITY. The Worker reaches this over its container binding (an internal path, not a public route),
but this defends in depth anyway:
  * AUTH — if RESOLVER_SECRET is set, every /resolve must present it in X-Resolver-Secret, else 401.
  * SSRF — every url is scheme-checked (http/https only) and its host is resolved and REFUSED if it
    lands on a private / loopback / link-local / reserved / multicast address (e.g. 169.254.169.254).
    That, plus ffmpeg's -protocol_whitelist (no file:/concat:/data:), stops a crafted manifest or url
    from reading local files or hitting internal services.
  * ARGUMENT INJECTION — a url beginning with '-' is rejected outright, subprocesses are argv lists
    (never a shell), and yt-dlp gets a `--` end-of-options guard so a url is never parsed as a flag.
"""
import ipaddress
import json
import os
import socket
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# 20 min. This bounds WORK, not the user's patience — and it is deliberately NOT set to "whatever plays on
# the first paste". A {page} mux downloads the whole video before we can serve a byte, so time-to-play
# scales with length; a 10-min ceiling made long videos fail FOREVER, which is strictly worse than making
# them arrive late. They now mux like anything else: the first paste renders the still card (the card only
# promises a video that exists), the mux keeps running, R2 keeps it, and every later view plays it
# instantly. Above this the download stops being worth a container slot at all.
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "1200"))
MAX_BYTES = int(os.environ.get("MAX_BYTES", "314572800"))     # 300 MB output ceiling
PROC_TIMEOUT = int(os.environ.get("PROC_TIMEOUT", "120"))     # per-subprocess wall clock
RESOLVER_SECRET = os.environ.get("RESOLVER_SECRET")           # shared secret; enforced when set
# ffmpeg protocols we permit: enough for http(s) media and HLS/DASH segment fetches, and NOTHING that
# reaches the local filesystem (no file, concat, subfile, data, pipe).
FFMPEG_PROTOCOLS = "http,https,tcp,tls,crypto"
# HTTP robustness for HLS/DASH whose segments redirect to ANOTHER host or drop mid-stream. Bluesky
# serves the playlist from video.bsky.app but its segments 302 to video.cdn.bsky.app, and a persistent
# connection cannot be reused across hosts — an older ffmpeg aborts the whole mux on the first such
# segment ("Cannot reuse HTTP connection for different host"). `-http_persistent 0` uses a fresh
# connection per segment (one extra handshake per ~6s chunk, negligible); the reconnect flags retry a
# dropped read rather than failing. Verified 2026-07-22: turns a failing Bluesky mux clean. Applied per
# INPUT (before each -i), which is where ffmpeg reads http options.
HTTP_OPTS = ["-http_persistent", "0", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
CHUNK = 1 << 16


def _safe_url(url: object) -> str:
    """Return the url if it is a public http(s) url, else raise ValueError. The SSRF gate."""
    if not isinstance(url, str) or not url or url.startswith("-"):
        raise ValueError("bad url")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("bad scheme")
    # Resolve every address the host maps to and refuse any that is not globally routable.
    for info in socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80),
                                   proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ValueError("blocked host")
    return url


def _mux_tracks(video: str, audio: str | None, out: str) -> None:
    cmd = ["ffmpeg", "-nostdin", "-y", "-protocol_whitelist", FFMPEG_PROTOCOLS, *HTTP_OPTS, "-i", _safe_url(video)]
    if audio:
        cmd += ["-protocol_whitelist", FFMPEG_PROTOCOLS, *HTTP_OPTS, "-i", _safe_url(audio), "-map", "0:v:0", "-map", "1:a:0"]
    cmd += ["-c", "copy", "-movflags", "+faststart", "-fs", str(MAX_BYTES), "-f", "mp4", out]
    subprocess.run(cmd, check=True, timeout=PROC_TIMEOUT, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mux_page(page: str, out: str) -> None:
    # `--` ends option parsing so the (validated) url can never be read as a flag. yt-dlp shells out
    # to the ffmpeg in the image for the merge; it fetches media urls the site returns, which is why
    # the WORKER only ever hands this a page on an allowlisted site.
    cmd = [
        # --force-overwrites is LOAD-BEARING: the caller pre-creates `out` via tempfile.mkstemp, and
        # without this yt-dlp sees a file already at the output path, logs "already downloaded" and
        # SKIPS — exiting 0 with the 0-byte mkstemp file left in place, which the caller then reports as
        # "empty or oversized result". _mux_tracks does not need it (ffmpeg's -y overwrites); yt-dlp has
        # no -y, so this is the equivalent. (Measured 2026-07-22: every {page} resolve returned empty
        # until this was added — the bug masked whether the SITE was reachable at all.)
        "yt-dlp", "--no-playlist", "--no-warnings", "--quiet", "--force-overwrites",
        # `duration > 0` SILENTLY EXCLUDED EVERY SOURCE THAT DECLARES NO DURATION, and that is a class,
        # not an edge case: an Imgur gifv reports duration=None, so the old filter answered
        # `does not pass filter (duration < 1200 & duration > 0), skipping ..` and the video simply never
        # existed as far as the card was concerned (reproduced verbatim on i.imgur.com/A61SaA1.gifv,
        # 2026-07-26). `<?` is yt-dlp's own none-inclusive comparison ("use a '?' after the operator to
        # also match videos where the field is not present"), so the 1200s ceiling still binds everything
        # that DOES declare a duration — verified the same day: the gifv passes with dur=NA, a 12.0s
        # Streamable passes, and a 4830s Dailymotion is still rejected BY THIS FILTER (the same url
        # passes with no filter at all, so the rejection is the ceiling, not a dead link).
        #
        # `!is_live` IS NOT DECORATION — it PRESERVES a guarantee `duration > 0` was providing by
        # accident. A live stream reports duration=None, so the old lower bound rejected it; dropping
        # that bound without this would let a livestream through and it would download until
        # PROC_TIMEOUT burns a container slot. yt-dlp's unary `!` on a bool field is `v is False`, so
        # ordinary non-live videos pass. (There is no `|` operator inside a match-filter string —
        # `!duration | duration < 1200` is `ERROR: Invalid filter part`; OR exists only across
        # repeated --match-filter flags.)
        "--match-filter", f"duration<?{MAX_SECONDS} & !is_live",
        "--max-filesize", str(MAX_BYTES),
        # RESOLUTION CAP — the single biggest lever on mux LATENCY, which is a correctness issue, not a
        # nicety: Discord's media proxy fetches og:video within seconds of reading the head and CACHES a
        # failure, so a slow first mux renders as "a still that never plays". Measured 2026-07-24: an
        # uncapped 4K source took 27s (Discord had long given up) — capping to <=720p cuts the download to a
        # fraction, and an embed is displayed far smaller than 720p anyway. `height<=?720` is NON-STRICT
        # (the `?`), so a format with no height still qualifies rather than failing the whole selection.
        "-f", (
            "b[ext=mp4][height<=?720]"
            "/bv*[ext=mp4][height<=?720]+ba[ext=m4a]"
            "/b[height<=?720]"
            "/bv*[height<=?720]+ba"
            "/b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b"
        ),
        # DASH/fragmented sources download serially by default; 4 parallel fragments is a large latency win
        # on exactly the long-video case the cap above does not fully solve.
        "--concurrent-fragments", "4",
        "--merge-output-format", "mp4",
        "-o", out, "--", _safe_url(page),
    ]
    subprocess.run(cmd, check=True, timeout=PROC_TIMEOUT + 60, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _meta_page(page: str) -> dict:
    # Metadata ONLY (no download) — the title + thumbnail for the card, for platforms whose crawler/oembed
    # surface is gated from datacenter egress but whose video yt-dlp still resolves (Facebook: Meta decoys
    # facebookexternalhit from datacenter, but yt-dlp extracts the video). Same SSRF guard + `--` as the mux.
    # --ignore-no-formats-error IS WHAT MAKES AN AGE-GATED VIDEO RENDER AT ALL. Without it, a video
    # yt-dlp cannot get formats for exits non-zero and `check=True` raises, so the Worker gets NOTHING:
    # no title, no thumbnail, and no timestamp -- which is why an age-restricted YouTube card showed
    # 1 January 1970. Measured 2026-07-30 on yt:G0sORVBL4kM (age_limit 18, embedding disabled, so
    # genuinely unplayable without cookies): WITH the flag the same call returns _type=video,
    # title, uploader, thumbnail, duration=177, timestamp=1605871096 and age_limit=18, with
    # formats: 0. The post is still correctly unplayable -- it just stops being anonymous.
    cmd = ["yt-dlp", "-J", "--no-warnings", "--no-playlist", "--ignore-no-formats-error",
           "--", _safe_url(page)]
    proc = subprocess.run(cmd, check=True, timeout=PROC_TIMEOUT, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    d = json.loads(proc.stdout or b"{}")
    # WIDTH/HEIGHT ARE NOT DECORATION — without them the card ships og:video:width="0" (measured
    # 2026-07-25 on /share/v/Fixture03X), and 0x0 tells a client nothing about the file it is about to
    # fetch. yt-dlp copies the SELECTED format's dimensions to the top level; a Facebook progressive
    # 'sd'/'hd' format carries no height at all, so fall back to a format that does.
    #
    # THE FALLBACK MIRRORS _mux_page's OWN SELECTOR, and that is the point of the `capped or sized`
    # line rather than a bare max(): _mux_page asks for `height<=?720`, so picking the TALLEST format
    # here with no ceiling could assert 1080x1920 on a card whose /_media/ url then serves 405x720.
    # Prefer the tallest format at or under 720, and fall back to the tallest overall only when none
    # qualifies — which is exactly what the mux's final `/b[ext=mp4]/…/b` arm does.
    #
    # WHAT THESE NUMBERS DESCRIBE, stated exactly: the format we EXPECT the mux to select. It is not a
    # probe of the produced file. The residual gap is the `?` in `height<=?720`, which is non-strict —
    # a format carrying NO height qualifies regardless of its real size — and that is not hypothetical:
    # on /share/v/Fixture03X the top level says 576x1024 (height > 720) and ffprobe of the mp4
    # _mux_page actually produced also says 576x1024, because the Facebook progressive format it chose
    # declares no height. So the two agree there, and the ceiling below only ever removes a claim we
    # could not have kept.
    w, h = d.get("width"), d.get("height")
    if not (isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0):
        sized = [f for f in (d.get("formats") or [])
                 if isinstance(f.get("width"), int) and isinstance(f.get("height"), int)
                 and f["width"] > 0 and f["height"] > 0]
        capped = [f for f in sized if f["height"] <= 720]
        best = max(capped or sized, key=lambda f: f["height"], default=None)
        w, h = (best["width"], best["height"]) if best else (None, None)
    # A DUMB PASSTHROUGH — every field below is already in the JSON we parse, no second yt-dlp call.
    # All judgement (which uploader strings are real names, how a packed title is unpacked) lives in
    # src/platforms/facebook/normalize.ts, because that half is pure and unit-testable with no network.
    # uploader/description/uploader_id: Facebook packs "<counts> | <caption> | <creator>" into its
    # og:title, which is what `title` falls back to — the STRUCTURED fields are the only clean creator
    # and caption available (measured 2026-07-25: uploader 'PhillyBanana ', description 'Are you
    # "Disturbed"', against a title of '3.9K reactions · 292 shares | Are you "Disturbed" | PhillyBanana').
    # CHANGING THIS DICT REQUIRES BUMPING RESOLVER_GENERATION in src/worker.ts — pooled instances keep
    # running the image they booted with until sleepAfter, so otherwise the new fields stay undefined.
    # _type DISTINGUISHES A VIDEO FROM A PLAYLIST, and without it the Worker cannot. Its content
    # assertion is "title is a non-empty string", which an Imgur ALBUM passes — measured 2026-07-26:
    # imgur.com/a/iX265HX yields _type='playlist' with a title and NOTHING else (no thumbnail, no
    # dimensions, no duration, no timestamp), so the card would ship as a bare headline with no
    # picture and a video url that resolves to nothing. It also keeps a playlist away from _mux_page,
    # which is untested on one and probably wrong (`-o out` + --force-overwrites means several entries
    # write over one path, and --no-playlist does not help — these are PURE playlists, not video+list).
    return {
        "_type": d.get("_type"),
        "title": d.get("title"), "thumbnail": d.get("thumbnail"),
        "uploader": d.get("uploader"), "uploader_id": d.get("uploader_id"),
        "uploader_url": d.get("uploader_url"), "description": d.get("description"),
        "width": w, "height": h, "duration": d.get("duration"), "timestamp": d.get("timestamp"),
        # age_limit LETS THE CARD SAY WHY IT CANNOT PLAY. yt-dlp reports 18 for an age-restricted
        # video even when it can fetch no formats for it, so this is the one signal that separates
        # "gated" from "extraction broke" -- which look identical to the Worker otherwise.
        "age_limit": d.get("age_limit"),
        # THE COUNTS, added 2026-08-01 because a YouTube card had none and there was nowhere to get
        # them: oEmbed carries no counts and this dict did not either, so `counts: {}` was not a
        # normalizer oversight, it was the whole supply.
        #
        # ALREADY IN THE JSON WE PARSE -- no second yt-dlp call, same dumb passthrough as everything
        # above. NULL IS NORMAL AND MUST STAY NULL: a channel can hide its like count, and comments
        # can be disabled entirely, in which case yt-dlp reports None rather than 0. The Worker's
        # renderer already drops a count that is not a positive finite number, so passing the None
        # through says "unknown" while coercing it to 0 would render a confident lie.
        "view_count": d.get("view_count"),
        "like_count": d.get("like_count"),
        "comment_count": d.get("comment_count"),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # no request logging (privacy: no urls in logs)
        pass

    def _json_error(self, code: int, msg: str) -> None:
        body = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("content-length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self._json_error(404, "not found")

    def do_POST(self):
        if self.path != "/resolve":
            return self._json_error(404, "not found")
        if RESOLVER_SECRET and self.headers.get("x-resolver-secret") != RESOLVER_SECRET:
            return self._json_error(401, "unauthorized")
        try:
            length = int(self.headers.get("content-length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json_error(400, "bad json")

        page, video = req.get("page"), req.get("video")

        # Metadata-only mode: {page, meta: true} -> yt-dlp -J, return {title, thumbnail} JSON. No temp file.
        if isinstance(page, str) and page and req.get("meta") is True:
            try:
                body = json.dumps(_meta_page(page)).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except ValueError:
                self._json_error(400, "invalid source")
            except subprocess.TimeoutExpired:
                self._json_error(504, "meta timed out")
            except (subprocess.CalledProcessError, json.JSONDecodeError):
                self._json_error(502, "meta failed")
            except Exception:
                self._json_error(500, "internal error")
            return

        fd, out = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        try:
            if isinstance(page, str) and page:
                _mux_page(page, out)
            elif isinstance(video, str) and video:
                _mux_tracks(video, req.get("audio") if isinstance(req.get("audio"), str) else None, out)
            else:
                return self._json_error(400, "need 'page' or 'video'")

            size = os.path.getsize(out)
            if size == 0 or size > MAX_BYTES:
                return self._json_error(502, "empty or oversized result")

            self.send_response(200)
            self.send_header("content-type", "video/mp4")
            self.send_header("content-length", str(size))
            self.end_headers()
            with open(out, "rb") as f:
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except ValueError:
            # _safe_url rejected the source (bad scheme / blocked host / dashy url).
            self._json_error(400, "invalid source")
        except subprocess.TimeoutExpired:
            self._json_error(504, "mux timed out")
        except subprocess.CalledProcessError:
            # stderr is suppressed on purpose — it can carry the source url. Any non-200 tells the
            # Worker to fall back to the cover still.
            self._json_error(502, "mux failed")
        except Exception:
            self._json_error(500, "internal error")
        finally:
            try:
                os.remove(out)
            except OSError:
                pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
