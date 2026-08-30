#!/usr/bin/env python3
"""
media-resolver — the mbedfx remux/resolve container.

A PURE muxer: given a video source, it produces one progressive, faststart MP4 and streams it back.
It holds NO state. The Worker owns R2 and streams this response into it, so each video is muxed once.

Two input modes (POST /resolve, JSON body):
  { "video": "<url>", "audio": "<url>"|null }   -> ffmpeg -c copy mux of tracks we already extracted
  { "page": "<url>" }                           -> yt-dlp resolves + merges (yt-dlp-supported sites)

Either {page} mode also accepts an optional "cookies": the CONTENTS of a Netscape cookies.txt, which
becomes a 0600 temp jar for the length of the call and is unlinked after it, whether it succeeded or
raised. It is what makes an age-gated source resolvable at all -- without it yt-dlp answers
`formats: 0` for those and the card degrades honestly rather than wrongly. It is NEVER logged,
echoed into an error, or returned; see _CookieJar.

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
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

# 25 min. This bounds WORK, not the user's patience — and it is deliberately NOT set to "whatever plays on
# the first paste". A {page} mux downloads the whole video before we can serve a byte, so time-to-play
# scales with length; a 10-min ceiling made long videos fail FOREVER, which is strictly worse than making
# them arrive late. They now mux like anything else: the first paste renders the still card (the card only
# promises a video that exists), the mux keeps running, R2 keeps it, and every later view plays it
# instantly. Above this the download stops being worth a container slot at all.
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "1500"))
MAX_BYTES = int(os.environ.get("MAX_BYTES", "393216000"))     # 375 MB output ceiling
# RAISED WITH MAX_SECONDS, 2026-08-03, and they must move together. The mux is `-c copy`, so
# output size is the SOURCE bitrate times the duration — a 25% longer ceiling with an unchanged
# byte ceiling would just move the refusal from the duration filter to the size filter for the
# videos the duration change was meant to admit, and the symptom would be identical.
PROC_TIMEOUT = int(os.environ.get("PROC_TIMEOUT", "120"))     # per-subprocess wall clock

# THE {page} MUX GETS ITS OWN WALL, because PROC_TIMEOUT was one number doing three jobs and only one
# of the three is a whole-video download.
#
# WHAT PROC_TIMEOUT STILL DOES, AND WHY IT IS NOT THE THING BEING RAISED. It walls `_mux_tracks`
# (ffmpeg, given direct format urls) and `_meta_page` (a `-J` extract that downloads nothing), and
# src/muxpolicy.ts derives MUX_FIRST_ATTEMPT_TRACKS_MS = 140s from it so the tracks alarm cannot wake
# while that ffmpeg is still pulling. Raising PROC_TIMEOUT here would silently move that alarm's
# premise in another repo half, and a mux alarm that fires early is the double-mux muxOnce exists to
# prevent. So the page mux is split out instead of the shared number being nudged.
#
# WHAT THIS FIXES. `_mux_page` ran under PROC_TIMEOUT + 60 = 180s while MAX_SECONDS admits 1500s of
# video. That wall was UNREACHABLE until the MuxRunner alarm landed, because ctx.waitUntil cancelled
# the attempt at 30s first, so nothing ever hit it and nobody noticed. It is now the first ceiling
# that actually bites: a long video is SIGKILLed at 180s, the container buffers the whole file before
# sending a byte and writes to a fresh mkstemp, so R2 gets nothing, and all three alarm attempts
# restart from byte zero and die at the same wall. A 20-minute video never plays, on any paste, ever.
#
# 360 IS NOT A DERIVATION AND THIS COMMENT WILL NOT PRETEND IT IS. The arithmetic that would justify a
# specific number needs a throughput figure, and the one on file is ~267 KB/s measured 2026-08-23 on
# the OLD quarter-core container with yt-dlp 2026.7.4. Both terms have since moved: the container is
# standard-2 (extraction went 14-17s to 3.1-4.7s) and yt-dlp is 2026.8.19. 360 is a round number
# picked to be clearly past 180 and clearly short of holding a slot for the alarm's whole 15 minutes.
#
# THE DIRECTION IS WHAT IS DEFENSIBLE. Raising a wall spends slot-seconds only on videos that
# currently fail 100% of the time: a mux that finishes inside 180s is untouched by this, and one that
# does not currently produces nothing at any wall, so there is no case this makes worse. The blast
# radius stays bounded by RESOLVER_SLOTS (4) and MAX_BYTES, neither of which this touches.
#
# THE OPEN QUESTION, for whoever measures next: what is sustained yt-dlp throughput from Cloudflare
# egress on standard-2 with 2026.8.19, and does MAX_SECONDS (1500) still fit under a wall we are
# willing to hold a slot for? If it does not, the honest fix is lowering MAX_SECONDS to what this wall
# can finish, not raising the wall again — a video admitted and then killed is worse than one refused.
#
# WHAT WAS CHECKED ON THE WORKER SIDE BEFORE RAISING IT, and what was not. 360s is longer than any
# container subrequest this repo has previously exercised, so the question is whether something above
# the container cuts it off first. Three things say no and one is untested:
#   - the caller is the MuxRunner alarm handler, which Cloudflare gives 15 minutes.
#   - Cloudflare's limits page says "There is no set time limit on individual subrequests"
#     (quoted in src/smoke.ts, read 2026-08-12).
#   - `sleepAfter` (5m) is an IDLE timer; an instance serving a request is not idle.
#   - UNTESTED: no request through this binding has actually run past 180s in production. If some
#     ceiling does sit between the Worker and the container below 360s, the effective wall is that
#     one — the change is still a strict improvement over 180, but the arithmetic above would want a
#     correction, and mux_timeout on a {page} platform is where it would show.
# The DO runtime's own alarm retry is NOT a hazard here: `alarm()` in src/muxrunner.ts catches every
# throw precisely so that loop never runs, so a long attempt cannot be raced by a retried alarm.
MUX_PAGE_TIMEOUT = int(os.environ.get("MUX_PAGE_TIMEOUT", "360"))  # {page} mux only, see above

# THE YOUTUBE PLAYER CLIENTS, SPELLED OUT RATHER THAN LEFT TO yt-dlp's DEFAULT — and this is a
# workaround for a live upstream/YouTube fight, not a preference. Re-measure before touching it.
#
# WHAT BROKE. yt-dlp 2026.7.4 (the pinned stable) defaults to `android_vr, web_safari`. YouTube began
# enforcing GVS PO tokens on `android_vr` roughly two weeks AFTER 2026.7.4 shipped, so the default
# client now gets format urls that googlevideo answers with HTTP 403. Metadata is unaffected, because
# it comes from the Innertube `player` endpoint which needs no token — which is exactly why the cards
# looked healthy (right title, channel, date, counts) with no video for weeks.
#
# MEASURED 2026-08-18 with this file's own argv, on a video uploaded eight days earlier:
#   default (android_vr, web_safari)  -> 0 bytes, "unable to download video data: HTTP Error 403"
#   player_client=web_embedded        -> 37,601,278 bytes
# A members-only video failed on BOTH, which is the control: this changes which client asks, it does
# not bypass a gate YouTube means to enforce.
#
# RE-MEASURED 2026-08-28, AND UPSTREAM HAS FIXED THE DEFAULT. yt-dlp 2026.8.19 carries the POT handling
# that 2026.7.4 predated, and the two images side by side, same video, same minute, residential:
#   2026.7.4  default -> 0 bytes, HTTP 403          2026.8.19  default -> 11,829,048 bytes
#   2026.7.4  web_embedded -> 11,829,048 bytes      2026.8.19  web_embedded -> 11,829,048 bytes
#
# THE OVERRIDE STAYS ANYWAY, and this is a decision rather than inertia. It still buys the full format
# ladder — web_embedded returns 19-23 video formats where tv_simply and mweb return exactly one — so
# dropping it would cost headroom even on a release where the default works. And the measurement above
# is RESIDENTIAL: the egress that actually fails is Cloudflare's, where ~40-50% of YouTube requests are
# refused regardless of client. Removing the override is a separate change that needs its own
# production measurement; do not fold it into a version bump.
#
# ORDER MATTERS, AND `default` MUST NEVER APPEAR IN IT. `player_client=default,web_embedded` still
# 403s: android_vr's format 18 and web_embedded's format 18 are indistinguishable by format_id, so
# selection lands on the poisoned one. The list REPLACES yt-dlp's default; it does not extend it.
#
# web_embedded IS FIRST BECAUSE IT IS THE ONLY WORKING CLIENT THAT KEEPS THE FULL FORMAT LADDER —
# 19-23 video formats, the same count the old default returned. tv_simply and mweb expose exactly
# ONE format, so they are usable fallbacks but leave no headroom if that format is throttled. They
# follow web_embedded rather than replacing it. Upstream reached the same conclusion independently:
# master promoted `web_embedded` into its own `_DEFAULT_AUTHED_CLIENTS`.
#
# DO NOT PICK A CLIENT FROM yt-dlp's TABLE. 2026.7.4's own GVS_PO_TOKEN_POLICY was stale in BOTH
# directions: it said android_vr needs no token (it 403'd) and that android/mweb/tv_simply do (they
# worked). Only measurement decides this, and the same goes for the next time it moves — including
# after the 2026.8.19 bump, whose table has NOT been re-verified claim by claim against live behaviour.
#
# THIS CANNOT AFFECT ANY OTHER PLATFORM. `--extractor-args` is keyed by extractor, and the `youtube:`
# prefix scopes it to the YouTube extractor alone — Dailymotion, Streamable, Imgur and Facebook go
# through the same binary and are untouched by construction, not by luck.
#
# THE EVIDENCE GAP, STATED. Every number above was measured from a RESIDENTIAL ip. Production egress
# is Cloudflare's, which is the axis YouTube polices hardest, and no community report confirms this
# override from a datacenter ip on 2026.7.4 — upstream's answer to that symptom is "use nightly".
# So this is the best available fix, NOT a proven one. Confirm on a preview build before believing it.
YT_PLAYER_CLIENTS = "web_embedded,tv_simply,mweb"

# THE FORMAT SELECTOR, HOISTED SO _meta_page AND _mux_page CANNOT DRIFT APART. It used to live inline
# in _mux_page while _meta_page mirrored its `height<=?720` ceiling in PYTHON to guess the dimensions
# the mux would produce. Two expressions of one rule is the bug shape that comment was apologising
# for; now the meta call passes this string to yt-dlp and reads the answer instead of predicting it.
#
# RESOLUTION CAP — for a long time the single biggest lever on mux LATENCY, which is a correctness
# issue, not a nicety: Discord's media proxy fetches og:video within seconds of reading the head and
# CACHES a failure, so a slow first mux renders as "a still that never plays". Measured 2026-07-24: an
# uncapped 4K source took 27s (Discord had long given up) — capping to <=720p cuts the download to a
# fraction, and an embed is displayed far smaller than 720p anyway. `height<=?720` is NON-STRICT
# (the `?`), so a format with no height still qualifies rather than failing the whole selection.
#
# BUT THE LEVER IS BYTES, NOT RESOLUTION — and at the SAME resolution there is a third to give back on
# exactly the videos that need it.
#
# WHY THE SAME PICTURE COSTS LESS: it is the H.264 PROFILE, not the resolution. Format 18 is
# `avc1.42001E` — BASELINE, which is what it has always been, because it exists for players that
# predate everything else. Format 134 is `avc1.4d401e` — MAIN, which has CABAC and B-frames and so
# spends far fewer bits on the same frames. 140's AAC is slightly larger than 18's muxed audio, and
# that is the whole of the trade; it is written here rather than hidden behind "same resolution".
#
# IT IS NOT A UNIFORM WIN, AND THAT IS THE PART WORTH KNOWING. Measured 2026-08-24 across 27 real
# videos from nine channels (yt-dlp's reported source filesizes, pinned yt-dlp, this file's own
# player-client list; the muxed output differs by tens of KB of container overhead):
#
#   duration          pair smaller on   aggregate bytes
#   under 2 min           8 / 13            mixed, small either way
#   2 - 10 min            5 / 7             -30.8%
#   10 - 25 min           6 / 7             -30.6%     <- the band this exists for
#
#   Yid9cO7peXg  1008s  57,595,754 -> 34,783,673   (-39.6%)
#   7Wiw42ZlBKs  1060s  62,122,070 -> 36,935,926   (-40.5%)
#   I07RBedXRYA  1122s  67,125,390 -> 41,728,766   (-37.8%)
#   J1WoNuemKOg  1365s  66,276,948 -> 71,861,868   (+8.4%)   <- the one long regression measured
#
# THE REGRESSIONS CLUSTER WHERE BYTES DO NOT MATTER: short 202x360 news clips run +26% to +43%, and
# they are 1-4 MB files that finish in a second at any bitrate. Videos past MAX_SECONDS are excluded
# from the table above because the match filter refuses them regardless — a 2873s sample ran +28.5%
# and can never be muxed.
#
# SO DO NOT "FIX" THE SHORT-VIDEO REGRESSION by conditioning this arm on duration. `_mux_page` does
# not know the duration before it extracts, and buying back a megabyte on a clip that already works
# is not worth a second extraction on the videos that do not. If you want per-video optimality the
# honest form is a size-aware sort (`-S "res:360,+size"`), which needs measuring across all ten
# platforms this selector serves before it goes anywhere near here.
#
# WHAT IT BUYS. At the ~267 KB/s measured off Cloudflare's egress on 2026-08-23, ~31% fewer bytes on a
# 10-25 minute video is ~31% less wall clock on the only axis that was ever binding — and those are
# precisely the videos that could not finish at all.
#
# WHY ITAGS RATHER THAN A SORT KEY. `-S "res:360,vcodec:h264,acodec:aac"` is the principled form and
# needs no literal — but it would change selection on all ten platforms this container serves, and
# this change is meant to move YouTube only. The itag arm falls through everywhere else because 134
# and 140 do not exist there. Note that is a MEASURED fact, not a structural one: Imgur emits
# format_id '0', so the numeric namespace is not YouTube's alone. If a platform ever ships a format
# literally called 134, this arm will take it.
#
# TWO THINGS DELIBERATELY NOT DONE. Hoisting `bv*` above `b` selects AV1 at 720p and costs ~29% MORE
# bytes. Adding `height<=?360` breaks portrait video — see hFQ-UPZ77kA above, which is 360x640, so
# the 360 is its WIDTH and a height cap would refuse it or drop it to something far smaller.
#
# ALREADY-CACHED OBJECTS KEEP THE OLD BYTES: the R2 key is `mux/{refKey}/{index}` and carries no
# format, so this applies to new muxes only.
YT_FORMAT_SELECTOR = (
    "134+140"
    "/b[ext=mp4][height<=?720]"
    "/bv*[ext=mp4][height<=?720]+ba[ext=m4a]"
    "/b[height<=?720]"
    "/bv*[height<=?720]+ba"
    "/b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b"
)

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


class _CookieJar:
    """A yt-dlp --cookies file that exists only for the length of one call.

    WHY A FILE AT ALL. yt-dlp reads cookies from a path; there is no argv form, and there must not be
    one -- argv is world-readable in /proc on this box, so a cookie passed as a flag would be visible
    to every process in the container. A 0600 file in the private temp dir is the narrow version.

    WHY IT IS A CONTEXT MANAGER. The jar MUST be unlinked even when yt-dlp raises, times out, or the
    handler returns early; a leaked jar is a live session sitting on disk for the life of the
    container, which is the one outcome worse than the age gate it was meant to defeat.

    NOTHING HERE IS EVER LOGGED. The contents are not returned, not echoed into an error, and not put
    in the response -- see the bare `except Exception` arms in the handler, which deliberately answer
    with a fixed string rather than the exception text for exactly this reason.
    """

    def __init__(self, cookies):
        self.cookies = cookies if isinstance(cookies, str) and cookies.strip() else None
        self.path = None

    def __enter__(self):
        if not self.cookies:
            return self
        # mkstemp is 0600 by the OS and never follows a symlink, so this cannot be pre-created by
        # something else in the container and read back.
        fd, self.path = tempfile.mkstemp(prefix="ck", suffix=".txt")
        try:
            with os.fdopen(fd, "w") as f:
                # yt-dlp requires the Netscape header line; a jar without it is rejected outright
                # ("does not look like a Netscape format cookies file") and the gate stays up with no
                # sign of why. Prepended rather than demanded of the caller, so an operator can paste
                # a browser export whether or not their extension emitted the header.
                if not self.cookies.lstrip().startswith("# Netscape HTTP Cookie File"):
                    f.write("# Netscape HTTP Cookie File\n")
                f.write(self.cookies)
                if not self.cookies.endswith("\n"):
                    f.write("\n")
        except BaseException:
            self._unlink()
            raise
        return self

    def __exit__(self, *exc):
        self._unlink()
        return False

    def _unlink(self):
        if self.path:
            try:
                os.unlink(self.path)
            except OSError:
                pass
            self.path = None

    def args(self):
        """The argv fragment, empty when there is no jar -- so callers need no conditional."""
        return ["--cookies", self.path] if self.path else []


def _mux_page(page: str, out: str, jar=None) -> None:
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
        "--extractor-args", f"youtube:player_client={YT_PLAYER_CLIENTS}",
        "--match-filter", f"duration<?{MAX_SECONDS} & !is_live",
        "--max-filesize", str(MAX_BYTES),
        # The selector is YT_FORMAT_SELECTOR — see its definition for the resolution-cap argument.
        "-f", YT_FORMAT_SELECTOR,
        # DASH/fragmented sources download serially by default; 4 parallel fragments is a large latency win
        # on exactly the long-video case the cap above does not fully solve.
        "--concurrent-fragments", "4",
        "--merge-output-format", "mp4",
        "-o", out, "--", _safe_url(page),
    ]
    # RIGHT AFTER THE PROGRAM NAME, and deliberately not "just before the terminator".
    #
    # THE BUG THIS FIXES, caught by asserting on the built argv rather than by reading the code: the
    # first version spliced at a negative index counted from the end, and landed BETWEEN `-o` and its
    # value, producing `-o --cookies <path> <out> -- <url>`. yt-dlp reads that as an output TEMPLATE
    # named "--cookies", so every mux carrying a jar wrote to the wrong place and the jar path became a
    # stray positional. It could not fire until a pool was filled, so it would have shipped looking
    # fine and broken on the day the credentials arrived.
    #
    # Index 1 has no such hazard: yt-dlp options may appear anywhere before `--`, and nothing here is
    # positional except the url after it. It also cannot drift when the flag list below is edited,
    # which the negative index silently could.
    if jar is not None:
        cmd[1:1] = jar.args()
    # MUX_PAGE_TIMEOUT, NOT PROC_TIMEOUT + 60. This one call downloads the whole video before it can
    # write a byte, so its wall scales with the source; the other two subprocesses do not, and one of
    # them is what src/muxpolicy.ts's tracks alarm is timed against. See MUX_PAGE_TIMEOUT's own note.
    subprocess.run(cmd, check=True, timeout=MUX_PAGE_TIMEOUT, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mux_sources(d: dict) -> tuple[str | None, str | None]:
    """The direct format urls `_mux_page` would resolve, or (None, None) to make the Worker use it.

    WHY THIS RE-IMPLEMENTS AN ADMISSION RULE INSTEAD OF JUST FORWARDING A URL. The duration ceiling
    is enforced by `_mux_page`'s `--match-filter duration<?MAX_SECONDS & !is_live`, which is a
    yt-dlp flag. `_mux_tracks` is ffmpeg, and ffmpeg has no such filter — so handing the Worker a url
    for a source that filter would REFUSE deletes the ceiling silently. A livestream would then run
    until PROC_TIMEOUT burned a container slot, which is the exact failure the filter was added for.

    DELIBERATELY STRICTER THAN THE FILTER IT MIRRORS. `duration<?N` is non-strict — a source with NO
    duration passes it — because yt-dlp still stops such a download on `--max-filesize`. Here the
    unknown-duration case returns (None, None) and takes the slow path instead, because the fast path
    has no equivalent stop. Refusing to shortcut is always safe; the cost is one re-extraction.
    """
    if d.get("is_live"):
        return None, None
    duration = d.get("duration")
    if not (isinstance(duration, (int, float)) and 0 < duration < MAX_SECONDS):
        return None, None
    # A SPLIT SELECTION ARRIVES AS requested_formats (video first, audio second) and a progressive one
    # as a bare top-level `url` — the same two shapes `_mux_tracks(video, audio)` already takes.
    requested = d.get("requested_formats")
    if isinstance(requested, list) and requested:
        video = requested[0].get("url") if isinstance(requested[0], dict) else None
        audio = requested[1].get("url") if len(requested) > 1 and isinstance(requested[1], dict) else None
        return (video, audio) if isinstance(video, str) and video else (None, None)
    url = d.get("url")
    return (url, None) if isinstance(url, str) and url else (None, None)


def _meta_page(page: str, jar=None) -> dict:
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
    # THE SAME CLIENT LIST AS THE MUX, deliberately. RESOLVER_GENERATION g4 exists because the
    # width/height this call reports have to describe the format `_mux_page`'s selector will pick;
    # asking a different client here would reintroduce that disagreement, and a card would advertise
    # dimensions for a format nobody downloads.
    # -f YT_FORMAT_SELECTOR IS WHAT LETS THE MUX SKIP A SECOND EXTRACTION. Without it this call
    # returned yt-dlp's default pick and no url, so `_mux_page` re-ran the WHOLE extraction — measured
    # 2026-08-22, ~5.0s of YouTube player-API round trips plus a Deno JS challenge, paid twice on
    # every cold card (a 20.4s cold mux against a 1.8s download of the same bytes).
    #
    # IT DOES NOT BREAK THE AGE-GATED CASE, which is the thing --ignore-no-formats-error exists for.
    # Measured 2026-08-22 on yt:G0sORVBL4kM (age_limit 18, formats: 0): WITH and WITHOUT -f the answer
    # is identical — title present, formats 0, age_limit 18 — because the flag suppresses the "no
    # formats" exit before selection is ever reached.
    cmd = ["yt-dlp", "-J", "--no-warnings", "--no-playlist", "--ignore-no-formats-error",
           "-f", YT_FORMAT_SELECTOR,
           "--extractor-args", f"youtube:player_client={YT_PLAYER_CLIENTS}",
           "--", _safe_url(page)]
    # WITH A JAR THIS IS THE CALL THAT STOPS RETURNING `formats: 0`. The comment above records the
    # measurement anonymously (yt:G0sORVBL4kM, age_limit 18, formats: 0, "genuinely unplayable
    # without cookies"); a logged-in jar is what makes that same id resolvable, and it is why the
    # meta path takes cookies too rather than only the mux.
    #
    # Index 1, matching _mux_page. This one was correct as a negative splice and is changed anyway, so
    # the two cannot be reasoned about differently — see the note there for what that cost.
    if jar is not None:
        cmd[1:1] = jar.args()
    proc = subprocess.run(cmd, check=True, timeout=PROC_TIMEOUT, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    d = json.loads(proc.stdout or b"{}")
    # WIDTH/HEIGHT ARE NOT DECORATION — without them the card ships og:video:width="0" (measured
    # 2026-07-25 on /share/v/Fixture03X), and 0x0 tells a client nothing about the file it is about to
    # fetch. yt-dlp copies the SELECTED format's dimensions to the top level; a Facebook progressive
    # 'sd'/'hd' format carries no height at all, so fall back to a format that does.
    #
    # THE FALLBACK MIRRORS _mux_page's OWN SELECTOR, and that is the point of the `capped or sized`
    # line rather than a bare max(): the selector's general arms ask for `height<=?720`, so picking the
    # TALLEST format here with no ceiling could assert 1080x1920 on a card whose /_media/ url then
    # serves 405x720. Prefer the tallest format at or under 720, and fall back to the tallest overall
    # only when none qualifies — which is exactly what the selector's final `/b[ext=mp4]/…/b` arm does.
    #
    # ON YOUTUBE THE MUX NOW TAKES 360p, not "the tallest under 720", because the first arm is the
    # 134+140 itag pair. This fallback is therefore a LOOSER bound than the truth on that platform —
    # it can only over-state, never under-state. Not a live bug: normalizeYouTube hardcodes w:0/h:0 for
    # yt and this branch only runs when the top-level width/height are missing, so no YouTube card
    # reads these numbers. Written down because the next person to widen the fallback needs to know
    # the mirror is no longer exact.
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
    # CHANGING THIS DICT REQUIRES BUMPING BOTH GENERATIONS in src/worker.ts. RESOLVER_GENERATION,
    # because pooled instances keep running the image they booted with until sleepAfter, so otherwise
    # the new fields just stay undefined. And META_GENERATION, because records already persisted in the
    # OLD shape are read back for up to 30 days. They were one string until 2026-08-29 and the reason
    # given here only ever covered the first of the two.
    # _type DISTINGUISHES A VIDEO FROM A PLAYLIST, and without it the Worker cannot. Its content
    # assertion is "title is a non-empty string", which an Imgur ALBUM passes — measured 2026-07-26:
    # imgur.com/a/iX265HX yields _type='playlist' with a title and NOTHING else (no thumbnail, no
    # dimensions, no duration, no timestamp), so the card would ship as a bare headline with no
    # picture and a video url that resolves to nothing. It also keeps a playlist away from _mux_page,
    # which is untested on one and probably wrong (`-o out` + --force-overwrites means several entries
    # write over one path, and --no-playlist does not help — these are PURE playlists, not video+list).
    mux_video, mux_audio = _mux_sources(d)
    return {
        "_type": d.get("_type"),
        # THE TWO FIELDS THAT LET THE WORKER SKIP AN EXTRACTION. Absent/null means "no shortcut, mux
        # from the page" — every caller must treat them as optional, because they are null for a
        # livestream, an unknown duration, an age-gated source with no formats, and any older pooled
        # instance still running a pre-g12 image.
        "mux_video": mux_video, "mux_audio": mux_audio,
        "title": d.get("title"), "thumbnail": d.get("thumbnail"),
        "uploader": d.get("uploader"), "uploader_id": d.get("uploader_id"),
        "uploader_url": d.get("uploader_url"), "description": d.get("description"),
        "width": w, "height": h, "duration": d.get("duration"), "timestamp": d.get("timestamp"),
        # upload_date IS THE DATE THAT SURVIVES WHEN timestamp DOES NOT, and forwarding only the
        # latter was a live defect rather than an omission. yt-dlp builds `timestamp` solely from a
        # timezone-bearing microformat, and several of its YouTube player clients do not carry one --
        # so the dict comes back complete (title, description, counts, duration, age_limit) with
        # `timestamp: None` and `upload_date: '20091025'` sitting right beside it. The Worker requires
        # a numeric timestamp to accept a record at all, so it threw the WHOLE dict away, cached
        # nothing, and then read its own rejection as evidence the video was gone. Which client
        # answers varies per request, which is why the symptom was intermittent.
        #
        # YYYYMMDD, a plain string, no timezone. The Worker normalises it to UTC midnight and prefers
        # `timestamp` whenever it has one -- see uploadDateFrom.
        "upload_date": d.get("upload_date"),
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


# ===================================================================================================
# THE CLIENT PROBE — the instrument this project has never had.
# ===================================================================================================
#
# WHY IT EXISTS. Every question about WHICH YouTube player client works has been argued from a laptop,
# and a laptop is a residential IP. Measured 2026-08-28, our configured list answers 5 of 6 test videos
# residentially — and tells us nothing, because the failures that actually reach users are
# Cloudflare-egress-only: ~40-50% of Worker-egress YouTube requests are refused while every one of them
# succeeds residentially in the same minute. Three separate "fixes" have shipped on residential
# evidence and done nothing in production. This runs the same comparison INSIDE the container, ON that
# egress, and reports which clients answered.
#
# IT TAKES NO INPUT, and that is a property of the design rather than a promise — the same rule
# `/_smoke` keeps. The video id is a constant below and the client list is a constant below; there is
# no parameter a caller can point at anything. A version of this accepting `?url=` would be an open
# yt-dlp relay wearing a diagnostic badge.
#
# IT ASSERTS ON BYTES, NOT ON A FORMAT LIST. A client that lists twenty formats and then gets 403 from
# googlevideo is a BROKEN client that looks healthy — that is exactly the shape of the outage this
# project spent weeks on. So each client is asked to extract AND then the chosen format URL is
# range-fetched. `gvs` is the answer that matters; `formats` is context.
PROBE_VIDEO = "jNQXAC9IVRw"      # "Me at the zoo" — the same id src/smoke.ts pins, for the same reason
PROBE_RANGE = 65535              # bytes to pull; enough to prove GVS served us, cheap enough to spam
PROBE_TIMEOUT = int(os.environ.get("PROBE_TIMEOUT", "45"))   # per client, wall clock

# The clients worth asking about, and why each is here rather than a table copied from yt-dlp:
#   default        - what yt-dlp picks unaided. On 2026.7.4 this 403'd, which is the whole reason
#                    YT_PLAYER_CLIENTS exists; on 2026.8.19 it downloads. Worth watching from here.
#   web_embedded   - ours, first. No PO token needed, but EMBEDDABLE videos only.
#   tv_simply/mweb - ours, the fallbacks. yt-dlp's table says both need a GVS PO token we cannot mint.
#   web_safari     - not ours. Its HLS formats are documented as needing no GVS token; measured
#                    residentially it served a 720p muxed stream for one video out of six.
#   android_vr     - not ours. yt-dlp's table currently says "no token required", which CONTRADICTS
#                    this repo's own Dockerfile comment. Only production can settle that.
PROBE_CLIENTS = ("default", "web_embedded", "tv_simply", "mweb", "web_safari", "android_vr")


def _probe_one(client):
    """Ask ONE client for the probe video, then try to actually fetch bytes. Never raises."""
    row = {"client": client, "extracted": False, "formats": 0, "gvs": "not-reached", "bytes": 0,
           "error": "", "ms": 0}
    started = time.monotonic()
    try:
        cmd = ["yt-dlp", "--skip-download", "-J", "--no-warnings"]
        # `default` means "pass no override at all" — NOT the literal string "default", which yt-dlp
        # would treat as a client name and which this repo has already been bitten by: mixing
        # `default` into an explicit list re-poisons format selection (see YT_PLAYER_CLIENTS).
        if client != "default":
            cmd += ["--extractor-args", f"youtube:player_client={client}"]
        cmd += ["-f", YT_FORMAT_SELECTOR, "--", f"https://www.youtube.com/watch?v={PROBE_VIDEO}"]
        out = subprocess.run(cmd, capture_output=True, timeout=PROBE_TIMEOUT, stdin=subprocess.DEVNULL)
        if out.returncode != 0:
            row["error"] = _probe_error(out.stderr)
            return row
        info = json.loads(out.stdout or b"{}")
        row["extracted"] = True
        row["formats"] = len(info.get("formats") or [])
        url = info.get("url") or ((info.get("requested_formats") or [{}])[0].get("url"))
        if not isinstance(url, str) or not url:
            row["gvs"] = "no-url"
            return row
        # THE PART THAT COUNTS. Everything above is yt-dlp talking to itself; this is googlevideo
        # deciding whether THIS egress may have the bytes.
        # THROUGH THE SAME GATE AS EVERYTHING ELSE. This url is googlevideo's, derived from a
        # hardcoded video id, so it is not attacker-controlled — but that is a property of today's
        # code rather than of this function, and _safe_url costs one call. It also refuses a
        # `-`-prefixed string, which matters because this value reaches a network call.
        req = urllib.request.Request(_safe_url(url), headers={"range": f"bytes=0-{PROBE_RANGE}",
                                                              "user-agent": _PROBE_UA})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read(PROBE_RANGE + 1)
            row["bytes"] = len(body)
            row["gvs"] = "ok" if body else "empty"
        except urllib.error.HTTPError as e:
            row["gvs"] = f"http-{e.code}"
        except Exception as e:
            row["gvs"] = "fetch-failed"
            row["error"] = type(e).__name__
    except subprocess.TimeoutExpired:
        row["error"] = "timeout"
    except Exception as e:
        row["error"] = type(e).__name__
    finally:
        row["ms"] = int((time.monotonic() - started) * 1000)
    return row


_PROBE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
             "Chrome/131.0.0.0 Safari/537.36")


def _probe_error(stderr):
    """One short line from yt-dlp's stderr — never the whole thing, which can carry urls."""
    text = (stderr or b"").decode("utf-8", "replace")
    for line in text.splitlines():
        if "ERROR" in line:
            # Truncated deliberately: a yt-dlp error can echo a signed googlevideo url, and this
            # string ends up in an HTTP response.
            return line.strip()[:160]
    return text.strip().splitlines()[-1][:160] if text.strip() else "failed"


PROBE_TIKTOK = "https://www.tiktok.com/@.g.r.b/video/7246058829106973978"


def _probe_tiktok():
    """CAN THIS CONTAINER SERVE A TIKTOK VIDEO? The one question the Worker half cannot answer.

    WHY IT EXISTS, 2026-08-30. Every TikTok on the site hands Discord a TWO-HOP redirect, because
    src/platforms/tiktok/fetch.ts's resolveAwemeUrl returns null for all of them: it fetches
    `www.tiktok.com/aweme/v1/play/` expecting a 302 and gets a 404 HTML page instead. That is not our
    bug — the SAME failure was reproduced against fxTikTok's own Cloudflare Worker
    (fxtiktok-rewrite-dev.dargy.workers.dev, their `OFF_LOAD` staging target), which answered with
    `location: https://www.tiktok.com/404?fromUrl=/aweme/v1/play/...` for the same video. Cloudflare
    WORKER egress cannot resolve that endpoint, for them or for us.

    fxTikTok's production works because it does not try to: `wrangler.toml` sets
    `OFF_LOAD = "https://offload.tnktok.com"`, and `src/offload.ts` is a plain Bun server behind a
    Dockerfile, i.e. their own box behind Cloudflare's proxy. This container is the equivalent box we
    already own, so the whole question is whether ITS egress reaches TikTok where the Worker's does
    not. Nothing short of running here can answer that, which is why this is a probe and not a guess.

    WHAT IT REPORTS AND WHY IT IS TWO STEPS. `extracted` says yt-dlp got the metadata; `bytes` says a
    format url actually served. Both matter and they fail independently — yt-dlp returns
    `*-webapp-prime.us.tiktok.com` urls that tiktok/normalize.ts records as 403 WITHOUT A COOKIE, so
    an extract that yields urls nobody can fetch is a false positive. `host` is published because
    which CDN family answers is the thing a future reader needs; the url itself never is (it is
    signed, and this string goes into an HTTP response).

    Never raises: a diagnostic that 500s tells an operator less than one that says it could not run.
    """
    row = {"page": PROBE_TIKTOK, "extracted": False, "formats": 0, "host": "",
           "fetch": "not-reached", "bytes": 0, "error": "", "ms": 0}
    started = time.monotonic()
    try:
        cmd = ["yt-dlp", "--skip-download", "-J", "--no-warnings", "--", PROBE_TIKTOK]
        out = subprocess.run(cmd, capture_output=True, timeout=PROBE_TIMEOUT, stdin=subprocess.DEVNULL)
        if out.returncode != 0:
            row["error"] = _probe_error(out.stderr)
            return row
        info = json.loads(out.stdout or b"{}")
        row["extracted"] = True
        row["formats"] = len(info.get("formats") or [])
        # THE FORMAT, NOT JUST ITS URL, because the headers below live on the format object.
        fmt = info if info.get("url") else ((info.get("requested_formats") or [{}])[0])
        url = fmt.get("url")
        if not isinstance(url, str) or not url:
            row["fetch"] = "no-url"
            return row
        try:
            row["host"] = urlsplit(url).hostname or ""
        except Exception:
            row["host"] = ""
        # SEND YT-DLP'S OWN HEADERS, and this correction is the entire point of the second version
        # of this probe. The first one fetched with a bare UA and a Range and reported
        # `fetch: http-403` from production on 2026-08-30 -- which reads exactly like the
        # `*-webapp-prime` cookie gate tiktok/normalize.ts documents, and is NOT that. yt-dlp hands
        # back a `http_headers` dict per format (Referer, and whatever else the extractor negotiated)
        # and the real mux path uses them because yt-dlp does the downloading. A probe that omits
        # them measures a request nothing in this system ever makes, and answers 403 to a question
        # nobody asked. Control, same yt-dlp, same post, run locally: the download completes at
        # 2,321,023 bytes of valid ISO Media.
        #
        # `range` and the UA are set FIRST so a format that carries its own user-agent wins, and a
        # format that does not still gets the one the rest of this file uses.
        hdrs = {"range": f"bytes=0-{PROBE_RANGE}", "user-agent": _PROBE_UA}
        for k, val in (fmt.get("http_headers") or {}).items():
            # Never let an upstream header dictate the byte range we asked for.
            if isinstance(k, str) and isinstance(val, str) and k.lower() != "range":
                hdrs[k] = val
        row["hdrs"] = sorted(h.lower() for h in hdrs)
        req = urllib.request.Request(_safe_url(url), headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read(PROBE_RANGE + 1)
            row["bytes"] = len(body)
            row["fetch"] = "ok" if body else "empty"
        except urllib.error.HTTPError as e:
            # 403 here is the EXPECTED shape if the webapp-prime cookie gate applies to this egress
            # too — see tiktok/normalize.ts. It is a real answer, not an error.
            row["fetch"] = f"http-{e.code}"
        except Exception as e:
            row["fetch"] = "fetch-failed"
            row["error"] = type(e).__name__
    except subprocess.TimeoutExpired:
        row["error"] = "timeout"
    except Exception as e:
        row["error"] = type(e).__name__
    finally:
        row["ms"] = int((time.monotonic() - started) * 1000)
    return row


def _probe_clients():
    """Every client in PROBE_CLIENTS, serially. Serial ON PURPOSE: the instance this runs on has a
    QUARTER of a vCPU (measured 2026-08-28: extraction alone costs 14-17s there against 5.7s at 1
    vCPU), so parallel yt-dlp processes would contend for the one thing that is scarce and make the
    numbers meaningless as well as slower."""
    started = time.monotonic()
    rows = [_probe_one(c) for c in PROBE_CLIENTS]
    # SERIAL WITH THE REST, same one-vCPU reason as above. Last, so a TikTok change can never delay
    # or fail the YouTube rows this endpoint already existed to report.
    tiktok = _probe_tiktok()
    return {
        "video": PROBE_VIDEO,
        "ytdlp": _ytdlp_version(),
        "ms": int((time.monotonic() - started) * 1000),
        "serving": [r["client"] for r in rows if r["gvs"] == "ok"],
        "clients": rows,
        "tiktok": tiktok,
    }


def _ytdlp_version():
    try:
        out = subprocess.run(["yt-dlp", "--version"], capture_output=True, timeout=10)
        return (out.stdout or b"").decode().strip()[:32]
    except Exception:
        return "unknown"


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

        # THE PROBE rides the EXISTING authenticated endpoint rather than opening a new one: it is a
        # diagnostic, it is expensive, and RESOLVER_SECRET already guards this path. It reads NOTHING
        # from `req` beyond this flag — see _probe_clients for why it takes no input at all.
        if req.get("probe") is True:
            body = json.dumps(_probe_clients()).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        page, video = req.get("page"), req.get("video")
        # THE ONE FIELD THAT IS NEVER ECHOED. It is pulled out here and handed straight to _CookieJar;
        # it is not logged, not put in an error body, and not written anywhere but the 0600 jar the
        # context manager deletes. An absent or non-string value means "no jar", which is the
        # behaviour every call had before this existed.
        cookies = req.get("cookies")

        # Metadata-only mode: {page, meta: true} -> yt-dlp -J, return {title, thumbnail} JSON. No temp file.
        if isinstance(page, str) and page and req.get("meta") is True:
            try:
                with _CookieJar(cookies) as jar:
                    body = json.dumps(_meta_page(page, jar)).encode()
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
                with _CookieJar(cookies) as jar:
                    _mux_page(page, out, jar)
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
