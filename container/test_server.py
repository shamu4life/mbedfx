"""Tests that EXECUTE server.py, rather than reading it as text.

WHY THIS FILE EXISTS. Until it did, 419 lines of Python — including the SSRF gate and every yt-dlp
invocation — were covered only by Node tests that read this file as a STRING and asserted on
substrings. That kind of test can confirm a line is present. It cannot tell you what the line
produces, and the difference is not academic:

  * A cookie jar was spliced at a negative index "just before the -- terminator". In _meta_page that
    was right; in _mux_page the argv ends `-o <out> -- <url>`, so the same reasoning put the flag
    BETWEEN -o and its value and built `-o --cookies <path> <out> -- <url>`. yt-dlp reads that as an
    output template named "--cookies". Every mux carrying a jar would have written to the wrong path.
    The whole suite passed, the build passed, and production was fine — because it could not fire
    until an account pool was filled. It was armed to break on the day the credentials arrived.

  * _safe_url is the container's SSRF gate, and it was verified by grep. A security control nothing
    executes is a security control nobody has checked.

RUN: `python3 -m unittest discover -s container -p 'test_*.py'`, or `npm run test:container`.

DELIBERATELY NOT PART OF `npm run build`. That script is the Cloudflare Workers Builds gate, and
python3 is not guaranteed in that image — a test that failed there would block the deploy rather than
catch a bug. GitHub Actions runs it on ubuntu-latest, where python3 always exists, so it gates the PR.

NO NETWORK. Every test either avoids _safe_url's DNS lookup or stubs the resolver, matching the Node
suite's rule. subprocess.run is stubbed everywhere so no yt-dlp or ffmpeg ever runs.
"""
import importlib.util
import io
import json
import os
import shutil
import socket
import struct
import tempfile
import unittest
import urllib.request


def _load():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("srv", os.path.join(here, "server.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


srv = _load()

PAGE = "https://www.youtube.com/watch?v=abc123"
OUT = "/tmp/out.mp4"
JAR_TEXT = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tFIXTURE\n"


class ArgvRecorder:
    """Stub for subprocess.run that records argv instead of running anything.

    THE KWARGS ARE RECORDED TOO, because `timeout=` is an argument like any other and the walls are a
    thing this file has to be able to assert on. They live in a parallel list so `calls[i]` stays the
    argv every other test in this file already reads.
    """

    def __init__(self):
        self.calls = []
        self.kwargs = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        self.kwargs.append(kwargs)

        class Result:
            stdout = b"{}"
            returncode = 0

        return Result()


class YtDlpArgv(unittest.TestCase):
    """The argv actually handed to yt-dlp. This is the class of bug that shipped."""

    def setUp(self):
        self.rec = ArgvRecorder()
        self._real = srv.subprocess.run
        srv.subprocess.run = self.rec

    def tearDown(self):
        srv.subprocess.run = self._real

    def test_mux_output_pair_is_never_split_by_the_jar(self):
        """`-o` and its value must stay adjacent, which is exactly what the shipped bug broke.

        A flag landing between them makes yt-dlp treat the flag as the output TEMPLATE, so the mux
        writes somewhere nobody looks and the real path becomes a stray positional. Asserted on the
        built list, because reading the source is how it was written wrong in the first place.
        """
        with srv._CookieJar(JAR_TEXT) as jar:
            srv._mux_page(PAGE, OUT, jar)
        cmd = self.rec.calls[0]
        self.assertEqual(cmd[cmd.index("-o") + 1], OUT, "-o must be followed by the output path")
        self.assertEqual(cmd[-2:], ["--", PAGE], "the terminator and url stay last")

    def test_the_youtube_client_override_is_on_both_calls_and_agrees(self):
        """The player-client override, and the trap that makes a plausible version of it useless.

        WHY IT EXISTS: yt-dlp 2026.7.4's default clients (android_vr, web_safari) get HTTP 403 from
        googlevideo for anything recent, because YouTube began enforcing GVS PO tokens on android_vr
        two weeks after that release shipped. Measured 2026-08-18 with this file's own argv on a video
        uploaded eight days earlier: default -> 0 bytes and "HTTP Error 403", web_embedded -> 37.6 MB.

        THE TRAP, and the reason this asserts on the VALUE and not just the flag's presence:
        `player_client=default,web_embedded` still 403s. android_vr's format 18 and web_embedded's are
        indistinguishable by format_id, so selection can land on the poisoned one. The list has to
        REPLACE yt-dlp's default rather than extend it, and "default" appearing anywhere in it is the
        single most likely way somebody re-breaks this while believing they made it more robust.

        BOTH CALLS, deliberately: RESOLVER_GENERATION g4 exists because the dimensions the meta call
        reports must describe the format the mux selector will pick. Different clients, different
        ladder, and the card would advertise a shape nobody delivers.
        """
        srv._mux_page(PAGE, OUT, None)
        srv._meta_page(PAGE, None)
        self.assertEqual(len(self.rec.calls), 2, "one mux call and one meta call")

        for label, cmd in (("mux", self.rec.calls[0]), ("meta", self.rec.calls[1])):
            self.assertIn("--extractor-args", cmd, f"{label}: the override must be present")
            value = cmd[cmd.index("--extractor-args") + 1]
            self.assertTrue(
                value.startswith("youtube:player_client="),
                f"{label}: the arg must be scoped to the youtube extractor, got {value!r}",
            )
            clients = value.split("=", 1)[1].split(",")
            self.assertNotIn(
                "default", clients,
                f"{label}: 'default' re-admits android_vr and the 403 comes back — replace the list, never extend it",
            )
            self.assertNotIn(
                "android_vr", clients,
                f"{label}: android_vr is the client YouTube is gating; naming it defeats the override",
            )
            self.assertEqual(
                clients[0], "web_embedded",
                f"{label}: web_embedded leads because it is the only working client that keeps the full "
                f"format ladder (19-23 formats); tv_simply and mweb expose exactly one",
            )

        mux_value = self.rec.calls[0][self.rec.calls[0].index("--extractor-args") + 1]
        meta_value = self.rec.calls[1][self.rec.calls[1].index("--extractor-args") + 1]
        self.assertEqual(mux_value, meta_value, "the two calls must ask the same client, or g4's guarantee is void")

    def test_the_client_override_is_scoped_so_other_platforms_cannot_be_touched(self):
        """Dailymotion, Streamable, Imgur and Facebook go through this same binary.

        `--extractor-args` is keyed by extractor name, so a `youtube:` prefix cannot reach them. This
        asserts the prefix rather than trusting it, because an unprefixed value would silently apply
        the client list everywhere and break platforms that have no such concept.
        """
        srv._mux_page(PAGE, OUT, None)
        value = self.rec.calls[0][self.rec.calls[0].index("--extractor-args") + 1]
        self.assertRegex(value, r"^youtube:", "an unprefixed extractor-arg would apply to every extractor")
        self.assertNotIn(" ", value, "a space would split the arg and change which extractor it binds to")

    def test_the_jar_flag_carries_the_jar_path(self):
        with srv._CookieJar(JAR_TEXT) as jar:
            srv._mux_page(PAGE, OUT, jar)
            cmd = self.rec.calls[0]
            self.assertIn("--cookies", cmd)
            self.assertEqual(cmd[cmd.index("--cookies") + 1], jar.path)

    def test_no_jar_means_no_flag_and_an_otherwise_identical_call(self):
        """The uncredentialed call must be byte-for-byte what it was before cookies existed.

        Every ordinary post goes through this path, so a jar that changes the argv when absent would
        make a credential feature into a change to everything.
        """
        with srv._CookieJar(JAR_TEXT) as jar:
            srv._mux_page(PAGE, OUT, jar)
        with srv._CookieJar(None) as empty:
            srv._mux_page(PAGE, OUT, empty)
            srv._meta_page(PAGE, empty)
        with_jar, without_jar, meta = self.rec.calls
        self.assertNotIn("--cookies", without_jar)
        self.assertNotIn("--cookies", meta)
        self.assertEqual([a for a in with_jar if a != "--cookies" and not a.endswith(".txt")],
                         without_jar, "the jar adds exactly two arguments and changes nothing else")

    def test_meta_keeps_its_terminator_last(self):
        with srv._CookieJar(JAR_TEXT) as jar:
            srv._meta_page(PAGE, jar)
        cmd = self.rec.calls[0]
        self.assertEqual(cmd[-2:], ["--", PAGE])
        self.assertIn("--cookies", cmd)

    def test_the_url_is_always_last_and_always_after_the_terminator(self):
        """`--` is what stops a url that begins with a dash being read as a flag.

        Any splice that lands after it turns an option into a positional and vice versa, so this is
        pinned for every combination rather than for the one that broke.
        """
        for jar_text in (JAR_TEXT, None):
            with srv._CookieJar(jar_text) as jar:
                srv._mux_page(PAGE, OUT, jar)
                srv._meta_page(PAGE, jar)
        for cmd in self.rec.calls:
            self.assertEqual(cmd[-1], PAGE)
            self.assertEqual(cmd[-2], "--")


    def test_meta_and_mux_ask_for_exactly_the_same_format(self):
        """One rule, one expression.

        The meta call used to pass no -f at all and MIRROR the mux's `height<=?720` ceiling in Python
        to guess the dimensions the mux would produce. Two statements of one rule drift; this asserts
        they cannot. It also guards the new shortcut: the Worker muxes from the url this call
        resolved, so a meta call selecting a DIFFERENT format than the mux would is not a slow card,
        it is the wrong bytes.
        """
        srv._mux_page(PAGE, OUT, None)
        srv._meta_page(PAGE, None)
        mux, meta = self.rec.calls[0], self.rec.calls[1]
        self.assertEqual(mux[mux.index("-f") + 1], srv.YT_FORMAT_SELECTOR)
        self.assertEqual(meta[meta.index("-f") + 1], srv.YT_FORMAT_SELECTOR)


    def test_the_cheap_360p_pair_is_tried_first(self):
        """The byte lever, pinned so a tidy-up cannot silently undo it.

        Format 18 and the 134+140 pair are the SAME 640x360 picture, but 18 is avc1 Baseline and 134
        is avc1 Main — CABAC and B-frames, so a third fewer bytes for the same frames. Measured
        2026-08-23: 32,347,122 -> 20,164,682 on a 625s video. Cloudflare's egress throughput is the
        binding constraint on whether a mux finishes at all, and bytes are the only half of that we
        control, so the ORDER of these arms is a correctness property rather than a preference.

        Asserted as a prefix, not as the whole string: the fallback chain behind it is free to change.
        """
        self.assertTrue(
            srv.YT_FORMAT_SELECTOR.startswith("134+140/"),
            "the cheap pair must be the FIRST arm, or every YouTube mux silently pays 60% more bytes",
        )

    def test_the_selector_still_falls_back_to_a_general_form(self):
        """An itag literal must never be the ONLY thing offered.

        134/140 are YouTube's numbering. Nine other platforms go through this same selector, and a
        chain that ended at the itag arm would fail selection outright on every one of them.
        """
        arms = srv.YT_FORMAT_SELECTOR.split("/")
        self.assertGreater(len(arms), 1, "an itag-only selector breaks every non-YouTube platform")
        self.assertTrue(
            any("ext=mp4" in a or a in ("b", "bv*+ba") for a in arms[1:]),
            "a general fallback must survive behind the itag arm",
        )


class CookieJar(unittest.TestCase):
    """The jar is a live session on disk. Its lifetime and permissions are the security surface."""

    def test_the_file_is_private_and_removed_afterwards(self):
        with srv._CookieJar(JAR_TEXT) as jar:
            path = jar.path
            self.assertTrue(os.path.exists(path))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600,
                             "a jar readable by anything else on the box is a leaked account")
        self.assertFalse(os.path.exists(path), "the jar must not outlive the call")

    def test_it_is_removed_even_when_the_body_raises(self):
        """The case that matters: yt-dlp times out or raises far more often than it succeeds cleanly.

        A jar leaked on the error path sits there for the life of the container, which is the one
        outcome worse than the age gate it was meant to defeat.
        """
        path = None
        try:
            with srv._CookieJar(JAR_TEXT) as jar:
                path = jar.path
                raise RuntimeError("yt-dlp blew up")
        except RuntimeError:
            pass
        self.assertIsNotNone(path)
        self.assertFalse(os.path.exists(path))

    def test_a_missing_netscape_header_is_added(self):
        """yt-dlp rejects a headerless jar outright, and the gate then stays up with no sign of why.

        Browser extensions differ on whether they emit it, so this is fixed here rather than being
        demanded of whoever exported the cookies.
        """
        with srv._CookieJar(".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tFIXTURE") as jar:
            with open(jar.path) as f:
                body = f.read()
        self.assertTrue(body.startswith("# Netscape HTTP Cookie File"))
        self.assertTrue(body.endswith("\n"), "a jar without a trailing newline loses its last cookie")

    def test_an_existing_header_is_not_duplicated(self):
        with srv._CookieJar(JAR_TEXT) as jar:
            with open(jar.path) as f:
                body = f.read()
        self.assertEqual(body.count("# Netscape HTTP Cookie File"), 1)

    def test_absent_blank_and_non_string_cookies_all_mean_no_jar(self):
        """A pool that is unset, empty, or malformed must degrade to an anonymous call, never a crash.

        The Worker already omits the key entirely when there is no jar; this is the container refusing
        to be the place where a bad value becomes an exception on the request path.
        """
        for value in (None, "", "   \n  ", 42, {"a": 1}, [], True):
            with srv._CookieJar(value) as jar:
                self.assertIsNone(jar.path, f"{value!r} must not produce a jar")
                self.assertEqual(jar.args(), [])


class SafeUrl(unittest.TestCase):
    """The SSRF gate. Previously verified by grep, which is to say not verified."""

    def setUp(self):
        self._real = srv.socket.getaddrinfo

    def tearDown(self):
        srv.socket.getaddrinfo = self._real

    def _resolve_to(self, addr):
        def fake(host, port, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (addr, port))]
        srv.socket.getaddrinfo = fake

    def test_a_name_resolving_to_the_cloud_metadata_address_is_refused(self):
        """169.254.169.254 is the reason this gate exists: it hands out cloud credentials to anything
        that can make it issue a request. DNS rebinding means the HOSTNAME proves nothing, so the
        check has to be on the resolved address, which is what makes a stub the honest test here.
        """
        self._resolve_to("169.254.169.254")
        with self.assertRaises(ValueError):
            srv._safe_url("https://totally-normal.example/video.mp4")

    def test_every_non_public_range_is_refused(self):
        for addr in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1",
                     "169.254.1.1", "0.0.0.0", "224.0.0.1", "240.0.0.1"):
            self._resolve_to(addr)
            with self.assertRaises(ValueError, msg=f"{addr} must be refused"):
                srv._safe_url("https://example.com/x.mp4")

    def test_a_public_address_is_allowed_through_unchanged(self):
        """The gate must not be so eager it refuses the whole internet — the failure nobody notices
        until every video stops resolving.
        """
        self._resolve_to("93.184.216.34")
        url = "https://example.com/x.mp4"
        self.assertEqual(srv._safe_url(url), url)

    def test_non_http_schemes_are_refused_before_any_lookup(self):
        """file: and data: are how a crafted source reads the container's own disk. Refused on the
        scheme, so no name is ever resolved for them.
        """
        for url in ("file:///etc/passwd", "data:text/plain,hi", "ftp://example.com/x",
                    "gopher://example.com", "//example.com/x"):
            with self.assertRaises(ValueError, msg=f"{url} must be refused"):
                srv._safe_url(url)

    def test_a_url_beginning_with_a_dash_is_refused(self):
        """`--` in the argv stops a dashy url being parsed as a flag, and this refuses it a second
        time. Both matter: the terminator can be lost by an edit, and this cannot.
        """
        for url in ("-oh-no", "--config-location=/etc/x", "-"):
            with self.assertRaises(ValueError):
                srv._safe_url(url)

    def test_non_strings_and_empties_are_refused_rather_than_crashing(self):
        for value in (None, 42, b"https://example.com", "", [], {}):
            with self.assertRaises(ValueError):
                srv._safe_url(value)


class Ceilings(unittest.TestCase):
    """The two limits that must move together, asserted on the values the process actually loaded."""

    def test_the_byte_ceiling_allows_a_real_bitrate_across_the_whole_duration(self):
        """`-c copy` means output size is SOURCE BITRATE times duration. Raising the seconds ceiling
        without the byte ceiling just moves the refusal from the duration filter to the size filter,
        for exactly the videos the change was meant to admit, and the symptom is identical.
        """
        self.assertGreater(srv.MAX_BYTES / srv.MAX_SECONDS, 200_000)

    def test_the_match_filter_is_none_inclusive_on_duration(self):
        """`duration<?N` and not `duration < N`: a source declaring no duration (an Imgur gifv) fails a
        strict comparison and the video simply never exists as far as the card is concerned.
        """
        self.assertIn("duration<?", f"duration<?{srv.MAX_SECONDS} & !is_live")


class Walls(unittest.TestCase):
    """WHICH SUBPROCESS RUNS UNDER WHICH WALL, read off the kwargs the call actually receives.

    PROC_TIMEOUT was one number doing three jobs, and only one of the three downloads a whole video
    before it can write a byte. The `{page}` mux ran under PROC_TIMEOUT + 60 = 180s while MAX_SECONDS
    admits 1500s of video, so a long one was SIGKILLed with nothing in R2 — and because the container
    buffers to a fresh mkstemp, every alarm retry restarted at byte zero and died at the same wall. A
    20-minute video never played on any paste. MUX_PAGE_TIMEOUT is that wall, split out.

    THE OTHER HALF MATTERS AS MUCH, which is why this class asserts the split from both sides.
    src/muxpolicy.ts derives MUX_FIRST_ATTEMPT_TRACKS_MS (140s) from `_mux_tracks` running under
    PROC_TIMEOUT: the tracks alarm waits for that ffmpeg to be CERTAINLY dead before it wakes. Point
    the tracks path at the longer wall and the alarm lands inside a live pull, which is two concurrent
    pulls of one video on one pooled instance — the double-mux muxOnce was written to prevent. That
    regression would be invisible in the argv, so it is asserted here.
    """

    def setUp(self):
        self.rec = ArgvRecorder()
        self._run = srv.subprocess.run
        self._resolve = srv.socket.getaddrinfo
        srv.subprocess.run = self.rec
        # No DNS: _safe_url resolves every host, and these tests are about walls, not the SSRF gate.
        srv.socket.getaddrinfo = lambda host, port, **kw: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port))
        ]

    def tearDown(self):
        srv.subprocess.run = self._run
        srv.socket.getaddrinfo = self._resolve

    def test_the_page_mux_runs_under_the_page_wall(self):
        srv._mux_page(PAGE, OUT, None)
        self.assertEqual(
            self.rec.kwargs[0].get("timeout"), srv.MUX_PAGE_TIMEOUT,
            "the {page} mux is the call that downloads the whole video, so it gets the long wall",
        )

    def test_the_tracks_mux_still_runs_under_proc_timeout(self):
        """Moving this one silently moves src/muxpolicy.ts's tracks alarm off its premise."""
        srv._mux_tracks("https://example.com/v.m4s", "https://example.com/a.m4s", OUT)
        self.assertEqual(
            self.rec.kwargs[0].get("timeout"), srv.PROC_TIMEOUT,
            "MUX_FIRST_ATTEMPT_TRACKS_MS (140s) = this number + slack; they are one number twice",
        )

    def test_the_meta_extract_still_runs_under_proc_timeout(self):
        """`-J` downloads nothing, so it has no reason to inherit a download's wall."""
        srv._meta_page(PAGE, None)
        self.assertEqual(self.rec.kwargs[0].get("timeout"), srv.PROC_TIMEOUT)

    def test_the_page_wall_outlasts_the_one_it_replaced(self):
        """The direction is the defensible part: a longer wall only spends slot-seconds on videos that
        currently fail 100% of the time. A wall at or below 180 would be this change undone.
        """
        self.assertGreater(srv.MUX_PAGE_TIMEOUT, srv.PROC_TIMEOUT + 60)

    def test_the_page_wall_is_env_overridable_like_the_ceilings_around_it(self):
        """Every other ceiling in this file can be tuned without a rebuild, and a self-hoster on a
        slower egress is exactly who needs to move this one.
        """
        os.environ["MUX_PAGE_TIMEOUT"] = "45"
        try:
            self.assertEqual(_load().MUX_PAGE_TIMEOUT, 45)
        finally:
            del os.environ["MUX_PAGE_TIMEOUT"]


class MuxSources(unittest.TestCase):
    """_mux_sources decides whether the Worker may skip a second extraction.

    Saying "no" costs one re-extraction. Saying "yes" wrongly hands ffmpeg a source that yt-dlp's
    --match-filter would have refused, and ffmpeg has no such filter — so every case here expecting
    (None, None) is guarding a ceiling, not declining an optimisation.
    """

    def test_a_progressive_selection_yields_one_url_and_no_audio(self):
        self.assertEqual(
            srv._mux_sources({"duration": 120, "url": "https://cdn.example/v.mp4"}),
            ("https://cdn.example/v.mp4", None),
        )

    def test_a_split_selection_yields_video_first_then_audio(self):
        """_mux_tracks maps 0:v:0 and 1:a:0, so the order is load-bearing, not cosmetic."""
        self.assertEqual(
            srv._mux_sources({"duration": 120, "requested_formats": [
                {"url": "https://cdn.example/v.m4s"}, {"url": "https://cdn.example/a.m4s"}]}),
            ("https://cdn.example/v.m4s", "https://cdn.example/a.m4s"),
        )

    def test_a_livestream_is_refused(self):
        """The filter this mirrors exists because a livestream downloads until PROC_TIMEOUT."""
        self.assertEqual(
            srv._mux_sources({"is_live": True, "duration": 60, "url": "https://cdn.example/v.mp4"}),
            (None, None),
        )

    def test_a_duration_over_the_ceiling_is_refused(self):
        self.assertEqual(
            srv._mux_sources({"duration": srv.MAX_SECONDS + 1, "url": "https://cdn.example/v.mp4"}),
            (None, None),
        )

    def test_an_unknown_duration_takes_the_slow_path(self):
        """DELIBERATELY STRICTER than `duration<?N`, which admits an unknown duration.

        yt-dlp still stops such a download on --max-filesize; ffmpeg reading a url has no equivalent
        stop, so the shortcut declines and the slow path applies the real filter.
        """
        self.assertEqual(srv._mux_sources({"url": "https://cdn.example/v.mp4"}), (None, None))

    def test_a_zero_or_negative_duration_is_refused(self):
        for duration in (0, -1):
            self.assertEqual(
                srv._mux_sources({"duration": duration, "url": "https://cdn.example/v.mp4"}),
                (None, None), f"duration={duration}",
            )

    def test_no_url_anywhere_is_a_declined_shortcut_rather_than_a_crash(self):
        """An age-gated source parses to formats: 0 and reaches here with nothing to offer."""
        self.assertEqual(srv._mux_sources({"duration": 10}), (None, None))
        self.assertEqual(srv._mux_sources({}), (None, None))

    def test_a_malformed_requested_formats_declines_rather_than_raising(self):
        for bad in ([], [None], [{"no_url": 1}], "not-a-list"):
            self.assertEqual(
                srv._mux_sources({"duration": 10, "requested_formats": bad}),
                (None, None), f"requested_formats={bad!r}",
            )


REDDIT_MASTER = "https://v.redd.it/muy8yipuynid1/HLSPlaylist.m3u8"

# Lines from `ffmpeg -hide_banner -h demuxer=hls`, trimmed (other options and the long default lists
# cut): the first from a 7.1.5 built from Debian's source, the second from Ubuntu's 6.1.1-3ubuntu5.
# The 6.1.1 listing is the negative control.
HLS_HELP_7_1_5 = b"""Demuxer hls [Apple HTTP Live Streaming]:
hls demuxer AVOptions:
  -allowed_extensions <string>     .D......... List of file extensions that hls is allowed to access (default "3gp,aac")
  -allowed_segment_extensions <string>     .D......... List of file extensions that hls is allowed to access (default "3gp,aac,html")
  -extension_picky   <boolean>    .D......... Be picky with all extensions matching (default true)
  -http_persistent   <boolean>    .D......... Use persistent HTTP connections (default true)
"""
HLS_HELP_6_1_1 = b"""Demuxer hls [Apple HTTP Live Streaming]:
hls demuxer AVOptions:
  -allowed_extensions <string>     .D......... List of file extensions that hls is allowed to access (default "3gp,aac")
  -http_persistent   <boolean>    .D......... Use persistent HTTP connections (default true)
"""


class RedditHls(unittest.TestCase):
    """REDDIT'S PLAYLISTS ARE OPENED WITH THE HLS EXTENSION CHECK OFF, and nothing else is.

    THE DEFECT. Reddit videos with audio uploaded between about 2024-05 and 2025-11 carry their audio
    as MPEG-TS in files named .aac. FFmpeg 7.1.1 added `extension_picky` to the hls demuxer, on by
    default, and it refuses exactly that: ffmpeg exits 183 while opening the input, the container
    answers 502, the Worker counts `mux_gate` and serves a 503, and the alarm's retries fail the same
    way. The image runs a 7.1 release no older than 7.1.1, so, by inference, none of those videos
    played. Measured in the dev sandbox on 2026-10-04 against the Raygun post; see the comment at
    server.py's REDDIT_HLS_HOST.

    THE OTHER HALF IS AS LOAD-BEARING. The option arrived with the check in 7.1.1, and an unknown
    option aborts the whole mux (6.1.1: "Unrecognized option 'extension_picky'", rc 8), the same
    shape of trap container/README.md already records for `-http_persistent`. So the flag must never reach an ffmpeg that lacks it, and it must
    stay off every input that is not Reddit HLS, where the check still does its job.
    """

    def setUp(self):
        self.rec = ArgvRecorder()
        self._run = srv.subprocess.run
        self._resolve = srv.socket.getaddrinfo
        self._probe = srv._ffmpeg_has_extension_picky
        srv.subprocess.run = self.rec
        srv.socket.getaddrinfo = lambda host, port, **kw: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port))
        ]
        srv._hls_picky_known = None

    def tearDown(self):
        srv.subprocess.run = self._run
        srv.socket.getaddrinfo = self._resolve
        srv._ffmpeg_has_extension_picky = self._probe
        srv._hls_picky_known = None

    def _flag_spans(self, argv):
        """Each input's option span, i.e. the args between the previous `-i <url>` and this `-i`."""
        spans, start = {}, 0
        for i, a in enumerate(argv):
            if a == "-i":
                spans[argv[i + 1]] = argv[start:i]
                start = i + 2
        return spans

    def test_a_reddit_hls_master_is_opened_with_the_extension_check_off(self):
        srv._ffmpeg_has_extension_picky = lambda: True
        srv._mux_tracks(REDDIT_MASTER, None, OUT)
        span = self._flag_spans(self.rec.calls[0])[REDDIT_MASTER]
        self.assertIn("-extension_picky", span, "the flag must sit before the master's own -i")
        self.assertEqual(span[span.index("-extension_picky") + 1], "0")

    def test_the_reddit_mux_is_still_the_one_recorded_call_and_still_under_proc_timeout(self):
        """With the probe answered, the mux is the only call, and it keeps the wall src/muxpolicy.ts's
        tracks alarm is derived from (see Walls). Unpatched, the probe's own call comes first, once
        per instance."""
        srv._ffmpeg_has_extension_picky = lambda: True
        srv._mux_tracks(REDDIT_MASTER, None, OUT)
        self.assertEqual(len(self.rec.calls), 1)
        self.assertEqual(self.rec.calls[0][0], "ffmpeg")
        self.assertEqual(self.rec.kwargs[0].get("timeout"), srv.PROC_TIMEOUT)

    def test_an_input_that_is_not_reddit_hls_never_carries_the_flag(self):
        srv._ffmpeg_has_extension_picky = lambda: True
        for video, audio in (
            ("https://video.bsky.app/watch/did%3Aplc%3Ax/bafy/playlist.m3u8", None),  # Bluesky: .ts passes
            ("https://v.redd.it/muy8yipuynid1/DASH_360.mp4", None),  # Reddit, but no hls demuxer
            ("https://cdn.example/v.m4s", "https://cdn.example/a.m4s"),  # the yt-dlp tracks pair
            ("https://v.redd.it.evil.example/x/HLSPlaylist.m3u8", None),  # a lookalike host
            ("https://notv.redd.it/x/HLSPlaylist.m3u8", None),
        ):
            self.rec.calls.clear()
            srv._mux_tracks(video, audio, OUT)
            self.assertNotIn("-extension_picky", self.rec.calls[0], video)

    def test_an_ffmpeg_without_the_option_never_gets_the_flag(self):
        """6.1.1 has neither the check nor the option; passing it there would break every Reddit mux."""
        srv._ffmpeg_has_extension_picky = lambda: False
        srv._mux_tracks(REDDIT_MASTER, None, OUT)
        self.assertNotIn("-extension_picky", self.rec.calls[0])

    def test_a_refused_source_never_reaches_the_probe(self):
        asked = []
        srv._ffmpeg_has_extension_picky = lambda: asked.append(1) or True
        srv.socket.getaddrinfo = lambda host, port, **kw: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))
        ]
        with self.assertRaises(ValueError):
            srv._mux_tracks(REDDIT_MASTER, None, OUT)
        self.assertEqual(asked, [])
        self.assertEqual(self.rec.calls, [])

    def _answer(self, stdout=b"", returncode=0, raises=None):
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            if raises:
                raise raises

            class Result:
                pass
            r = Result()
            r.stdout, r.returncode = stdout, returncode
            return r
        srv.subprocess.run = run
        return calls

    def test_the_probe_reads_the_option_off_a_7_1_5_listing_and_asks_once(self):
        calls = self._answer(HLS_HELP_7_1_5)
        self.assertTrue(srv._ffmpeg_has_extension_picky())
        self.assertTrue(srv._ffmpeg_has_extension_picky())
        self.assertEqual(calls, [["ffmpeg", "-hide_banner", "-h", "demuxer=hls"]])

    def test_the_probe_says_no_for_a_6_1_1_listing_that_still_says_extensions(self):
        calls = self._answer(HLS_HELP_6_1_1)
        self.assertFalse(srv._ffmpeg_has_extension_picky())
        self.assertFalse(srv._ffmpeg_has_extension_picky())
        self.assertEqual(len(calls), 1, "a real 'no' is an answer, and answers are kept")

    def test_a_probe_that_could_not_run_is_asked_again_rather_than_remembered(self):
        """Remembering a failed probe would pin every 2024-05..2025-11 Reddit video with audio to a
        503 for the instance's life."""
        for kwargs in ({"raises": OSError("no ffmpeg")},
                       {"raises": srv.subprocess.TimeoutExpired("ffmpeg", 10)},
                       {"stdout": HLS_HELP_7_1_5, "returncode": 1}):
            srv._hls_picky_known = None
            calls = self._answer(**kwargs)
            self.assertFalse(srv._ffmpeg_has_extension_picky(), kwargs)
            self.assertFalse(srv._ffmpeg_has_extension_picky(), kwargs)
            self.assertEqual(len(calls), 2, kwargs)

    def test_the_probe_has_a_short_wall_of_its_own(self):
        """It runs ahead of the tracks mux on the request path, so its wall comes out of the 20 s
        src/muxpolicy.ts keeps between PROC_TIMEOUT and MUX_FIRST_ATTEMPT_TRACKS_MS."""
        kwargs = []
        srv.subprocess.run = lambda cmd, **kw: kwargs.append(kw) or type("R", (), {
            "stdout": HLS_HELP_7_1_5, "returncode": 0})()
        srv._ffmpeg_has_extension_picky()
        self.assertEqual(kwargs[0].get("timeout"), srv.HLS_PROBE_TIMEOUT)
        self.assertLessEqual(srv.HLS_PROBE_TIMEOUT, 5)

    def test_clients_reports_the_marker_and_says_unknown_when_the_probe_could_not_run(self):
        """/_clients is how an operator tells a stale instance from a fix that failed, so the two keys
        must be there, and a probe that never answered must read as null, not as an ffmpeg without the
        check (which is what a stale image looks like)."""
        real = (srv._probe_one, srv._probe_tiktok)
        srv._probe_one = lambda c: {"client": c, "gvs": "ok"}
        srv._probe_tiktok = lambda: {}
        try:
            for answer, want in (({"stdout": HLS_HELP_7_1_5}, True),
                                 ({"stdout": HLS_HELP_6_1_1}, False),
                                 ({"raises": srv.subprocess.TimeoutExpired("ffmpeg", 3)}, None)):
                srv._hls_picky_known = None
                self._answer(**answer)
                out = srv._probe_clients()
                self.assertIn("ffmpeg", out)
                self.assertIs(out["hlsExtensionPicky"], want, answer)
        finally:
            srv._probe_one, srv._probe_tiktok = real

    def test_the_marker_reports_the_ffmpeg_version_or_unknown(self):
        """/_clients carries this so an operator can tell a stale instance from a fix that failed."""
        self._answer(b"ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers\n")
        self.assertEqual(srv._ffmpeg_version(), "6.1.1-3ubuntu5")
        self._answer(b"something else entirely\n")
        self.assertEqual(srv._ffmpeg_version(), "unknown")
        self._answer(raises=OSError("no ffmpeg"))
        self.assertEqual(srv._ffmpeg_version(), "unknown")



class NoRedirectOpener(unittest.TestCase):
    """The redirect-resolve mode's one load-bearing piece, exercised rather than read.

    `{redirect: <url>}` exists because Cloudflare WORKER egress gets a 404 HTML page from TikTok's
    /aweme/v1/play/ while this container reaches TikTok fine, and collapsing that 302 is what keeps
    Discord to ONE hop. The whole mode depends on urllib REFUSING to follow the redirect so the
    Location survives to be read; if _NoRedirect silently started following again, the endpoint would
    return `location: null` for every input and the Worker would degrade to two hops forever --
    silently, which is exactly how the original defect survived three weeks.
    """

    def test_every_redirect_code_is_refused(self):
        """redirect_request returning None is urllib's documented way to REFUSE a redirect.

        Asserted directly rather than through an opener: driving it end to end needs a socket, and
        the rule in this repo is that no test touches the network. This is the whole contract --
        the default HTTPRedirectHandler returns a Request here, and returning one again is precisely
        the regression that would make the endpoint answer `location: null` for every input.
        """
        h = srv._NoRedirect()
        req = urllib.request.Request("https://example.invalid/start")
        for code in (301, 302, 303, 307, 308):
            self.assertIsNone(
                h.redirect_request(req, None, code, "Found",
                                   {"location": "https://example.invalid/final.mp4"},
                                   "https://example.invalid/final.mp4"),
                f"HTTP {code} must be refused, not followed",
            )

    def test_it_really_is_a_redirect_handler(self):
        """Subclassing HTTPRedirectHandler is what puts it in the opener's redirect slot at all.

        If it stopped being one, build_opener would add the DEFAULT handler alongside it, redirects
        would be followed again, and the refusal above would still pass while the endpoint silently
        broke.
        """
        self.assertTrue(issubclass(srv._NoRedirect, urllib.request.HTTPRedirectHandler))


def _box(kind, payload=b""):
    """One ISO-BMFF box with a 32-bit size: 4-byte size, 4-byte type, payload."""
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


FTYP = _box(b"ftyp", b"mp42" + b"\0\0\0\0" + b"isommp42")   # 24 bytes, as YouTube's format 18 has
MOOV = _box(b"moov", b"\0" * 64)
MDAT = _box(b"mdat", b"\x11" * 256)
WHOLE = FTYP + MOOV + _box(b"free") + MDAT                  # the faststart shape ffmpeg writes


def _production_short_file():
    """The exact shape production served for yt:txqiwrbYGrs/0 on 2026-10-05 (dev sandbox, read as
    Discordbot): ftyp(24) + moov(59,536) + free(8) + an mdat header declaring 4,398,607 bytes, and
    nothing after it. The moov's contents are zeroes here; only its size matters to the walk."""
    return (FTYP + _box(b"moov", b"\0" * (59_536 - 8)) + _box(b"free")
            + struct.pack(">I4s", 4_398_607, b"mdat"))


class _TempFiles(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def verdict(self, data):
        path = os.path.join(self.dir, f"f{len(os.listdir(self.dir))}.mp4")
        with open(path, "wb") as f:
            f.write(data)
        return srv._mux_result_verdict(path)


class MuxCompleteness(_TempFiles):
    """A MUX RESULT IS ONLY SERVED WHEN EVERY TOP-LEVEL BOX IS WHOLE.

    THE DEFECT. Production stored, and serves to every unfurl, a 59,576-byte YouTube mp4 whose mdat
    header declares 4,398,607 bytes with not one of them present (measured 2026-10-05 from the dev
    sandbox). yt-dlp exited 0 and the handler refused only size 0 or size > MAX_BYTES, so the Worker
    stored it under a key with no generation in it. ffprobe calls that file healthy (exit 0, duration
    118.96s), so these cases are about box sizes, the one thing the short file gets wrong.

    BOTH DIRECTIONS ARE PINNED. A walk that refused a legal size-0 box, a 64-bit largesize or a
    fragmented file would turn playable videos into 503s, which is the same failure from the other side.
    """

    def test_a_whole_faststart_mp4_is_complete(self):
        self.assertEqual(self.verdict(WHOLE), srv.MP4_COMPLETE)

    def test_the_exact_file_production_stored_is_incomplete(self):
        data = _production_short_file()
        self.assertEqual(len(data), 59_576, "the fixture must be the measured length to the byte")
        self.assertEqual(self.verdict(data), srv.MP4_INCOMPLETE)

    def test_a_box_running_past_the_end_of_the_file_is_incomplete(self):
        overrun = struct.pack(">I4s", 8 + 500, b"moov") + b"\0" * 100
        self.assertEqual(self.verdict(FTYP + overrun), srv.MP4_INCOMPLETE)

    def test_a_last_box_of_size_zero_runs_to_the_end_and_is_complete(self):
        """Size 0 means "to the end of the file" (ISO/IEC 14496-12); it is legal on the last box."""
        to_eof = struct.pack(">I4s", 0, b"mdat") + b"\x11" * 300
        self.assertEqual(self.verdict(FTYP + MOOV + to_eof), srv.MP4_COMPLETE)

    def test_a_64_bit_largesize_box_is_read_and_complete(self):
        payload = b"\x11" * 300
        large = struct.pack(">I4sQ", 1, b"mdat", 16 + len(payload)) + payload
        self.assertEqual(self.verdict(FTYP + MOOV + large), srv.MP4_COMPLETE)

    def test_a_largesize_that_overruns_is_incomplete(self):
        large = struct.pack(">I4sQ", 1, b"mdat", 16 + 4_398_607) + b"\x11" * 300
        self.assertEqual(self.verdict(FTYP + MOOV + large), srv.MP4_INCOMPLETE)

    def test_a_fragmented_mp4_is_complete(self):
        """moof+mdat pairs after the moov are how fragmented HLS and DASH downloads arrive."""
        frag = FTYP + MOOV + b"".join(_box(b"moof", b"\0" * 40) + MDAT for _ in range(3)) + _box(b"mfra")
        self.assertEqual(self.verdict(frag), srv.MP4_COMPLETE)

    def test_a_fragmented_mp4_cut_inside_its_last_fragment_is_incomplete(self):
        frag = FTYP + MOOV + _box(b"moof", b"\0" * 40) + MDAT + _box(b"moof", b"\0" * 40) + MDAT[:100]
        self.assertEqual(self.verdict(frag), srv.MP4_INCOMPLETE)

    def test_no_moov_is_incomplete(self):
        self.assertEqual(self.verdict(FTYP + _box(b"free") + MDAT), srv.MP4_INCOMPLETE)

    def test_no_mdat_is_incomplete(self):
        self.assertEqual(self.verdict(FTYP + MOOV), srv.MP4_INCOMPLETE)

    def test_trailing_bytes_that_do_not_form_a_box_are_incomplete(self):
        """A few bytes after the last whole box look exactly like a download that stopped inside the
        next box's header, so they are refused. Eight zero bytes are the sneaky case: read as a box
        they are size 0, "to the end of the file", and only the type rule stops them passing."""
        self.assertEqual(self.verdict(WHOLE + b"junk"), srv.MP4_INCOMPLETE)
        self.assertEqual(self.verdict(WHOLE + b"\0" * 8), srv.MP4_INCOMPLETE)

    def test_a_box_smaller_than_its_own_header_is_incomplete(self):
        """Following a size under the header would loop on one offset or walk backwards."""
        for bad in (struct.pack(">I4s", 4, b"free"), struct.pack(">I4sQ", 1, b"free", 8),
                    _box(b"uuid", b"\0" * 8)):  # uuid's header is 24: 8 + its 16-byte extended type
            self.assertEqual(self.verdict(FTYP + bad + MOOV + MDAT), srv.MP4_INCOMPLETE, bad)

    def test_a_file_past_the_box_cap_is_refused_and_the_cap_clears_any_real_layout(self):
        real = srv.MP4_MAX_BOXES
        try:
            srv.MP4_MAX_BOXES = 5
            self.assertEqual(self.verdict(FTYP + MOOV + _box(b"free") * 10 + MDAT), srv.MP4_INCOMPLETE)
        finally:
            srv.MP4_MAX_BOXES = real
        # One moof+mdat pair per frame at 60 fps for the longest video the match filter admits.
        self.assertGreater(srv.MP4_MAX_BOXES, srv.MAX_SECONDS * 60 * 2)

    def test_webm_flv_and_mpeg_ts_are_recognised_as_foreign_rather_than_called_incomplete(self):
        """A single-format {page} download is written verbatim, and the `b[height<=?720]` and `b`
        arms admit any ext, so these can arrive under a .mp4 name. The walk cannot judge them, and
        calling them "incomplete" would refuse a file on a reading the walk never made."""
        ts_packet = b"\x47" + b"\0" * 187
        for data in (b"\x1aE\xdf\xa3" + b"\0" * 64, b"FLV\x01\x05\0\0\0\x09" + b"\0" * 64, ts_packet * 3):
            self.assertEqual(self.verdict(data), srv.MP4_FOREIGN, data[:8])
        self.assertEqual(self.verdict(ts_packet[:100]), srv.MP4_INCOMPLETE,
                         "one sync byte in a file too short to show a second is not a stream")


def _drive_post(body):
    """Run Handler.do_POST without a socket and return (status, headers, body).

    BaseHTTPRequestHandler needs only these attributes to answer, and everything it writes lands in
    `wfile`. This drives the real method, so the status and the error string are what production
    would send rather than a reading of the source.
    """
    raw = json.dumps(body).encode()
    h = srv.Handler.__new__(srv.Handler)
    h.rfile, h.wfile = io.BytesIO(raw), io.BytesIO()
    h.headers = {"content-length": str(len(raw))}
    h.path, h.command, h.request_version = "/resolve", "POST", "HTTP/1.1"
    h.requestline, h.client_address, h.close_connection = "POST /resolve HTTP/1.1", ("127.0.0.1", 0), False
    h.do_POST()
    head, _, payload = h.wfile.getvalue().partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    headers = {k.lower(): v for k, v in (line.split(": ", 1) for line in lines[1:])}
    return int(lines[0].split()[1]), headers, payload


class DoPostCompleteness(unittest.TestCase):
    """THE HANDLER REFUSES A SHORT FILE WITH ITS OWN 502, so the Worker neither stores nor miscounts it.

    THE DEFECT, from the other end: the walk is worthless unless do_POST acts on it, and the error
    string is worthless unless it differs from "empty or oversized result", because the Worker's
    muxOutcomeOf tells failures apart by that string alone. subprocess.run is stubbed to write the
    file yt-dlp or ffmpeg would have written; no process runs and no name is resolved.
    """

    def setUp(self):
        self._run, self._resolve, self._secret = srv.subprocess.run, srv.socket.getaddrinfo, srv.RESOLVER_SECRET
        srv.RESOLVER_SECRET = None
        srv.socket.getaddrinfo = lambda host, port, **kw: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port))
        ]

    def tearDown(self):
        srv.subprocess.run, srv.socket.getaddrinfo, srv.RESOLVER_SECRET = self._run, self._resolve, self._secret

    def _writes(self, data):
        def run(cmd, **kwargs):
            out = cmd[cmd.index("-o") + 1] if "-o" in cmd else cmd[-1]  # yt-dlp's -o, ffmpeg's last arg
            with open(out, "wb") as f:
                f.write(data)
            return type("Result", (), {"returncode": 0, "stdout": b""})()
        srv.subprocess.run = run

    def test_a_short_page_mux_answers_502_incomplete_result(self):
        self._writes(_production_short_file())
        status, _, body = _drive_post({"page": PAGE})
        self.assertEqual((status, json.loads(body)), (502, {"error": "incomplete result"}))

    def test_a_short_tracks_mux_answers_the_same(self):
        self._writes(FTYP + MOOV + MDAT[:40])
        status, _, body = _drive_post({"video": "https://cdn.example/v.mp4"})
        self.assertEqual((status, json.loads(body)), (502, {"error": "incomplete result"}))

    def test_a_whole_file_is_still_served_byte_for_byte(self):
        """The control: without it, a handler that refused everything would pass the two above."""
        self._writes(WHOLE)
        status, headers, body = _drive_post({"page": PAGE})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "video/mp4")
        self.assertEqual(int(headers["content-length"]), len(WHOLE))
        self.assertEqual(body, WHOLE)

    def test_an_empty_file_keeps_its_own_string(self):
        self._writes(b"")
        status, _, body = _drive_post({"page": PAGE})
        self.assertEqual((status, json.loads(body)), (502, {"error": "empty or oversized result"}))

    def test_a_foreign_container_is_passed_through_as_before(self):
        """The explicit decision in _mux_result_verdict's note: not judged, so not refused."""
        webm = b"\x1aE\xdf\xa3" + b"\0" * 64
        self._writes(webm)
        status, _, body = _drive_post({"page": PAGE})
        self.assertEqual((status, body), (200, webm))

    def test_clients_carries_the_marker_that_says_this_instance_walks_its_output(self):
        """A pooled instance can keep an old image after a deploy reports done (worker.ts
        RESOLVER_GENERATION), and an old one would store short files again. The key's presence is how
        an operator tells the two apart from outside."""
        real = (srv._probe_one, srv._probe_tiktok, srv._hls_picky_known)
        srv._probe_one = lambda c: {"client": c, "gvs": "ok"}
        srv._probe_tiktok = lambda: {}
        srv._hls_picky_known = True
        srv.subprocess.run = lambda cmd, **kw: type("R", (), {"stdout": b"", "returncode": 0})()
        try:
            self.assertEqual(srv._probe_clients().get("muxCheck"), "boxes")
        finally:
            srv._probe_one, srv._probe_tiktok, srv._hls_picky_known = real


class HandlerShape(unittest.TestCase):
    """THE HTTP SURFACE IS A METHOD TABLE, and nothing here was checking it was still one.

    THE OUTAGE THIS PREVENTS, shipped 2026-08-28 and caught only by hitting production. A patch that
    added the client probe anchored on `class _Handler(...)`, fell through to its fallback anchor
    because the class is called `Handler`, and spliced module-level functions INTO the class body just
    above `do_GET`. Python ends a class at the first unindented line, so `do_GET` and `do_POST` stopped
    being methods and became module-level functions. BaseHTTPRequestHandler then answered EVERY
    request with 501 "Unsupported method" — GET and POST alike, so /health and every mux on every
    platform broke together.

    Nothing caught it. This file imports and calls the pure helpers, which all still worked perfectly
    because they were never the broken part; the Worker suite stubs the container out entirely; and
    the smoke run stayed green because most of its checks never reach the container and YouTube's
    metadata now comes from Innertube rather than yt-dlp. A 501 on the one surface that matters was
    invisible to 1448 passing tests.

    These assertions are deliberately about SHAPE rather than behaviour: they would have failed on the
    exact edit that caused it, they cost nothing, and they cannot be satisfied by a helper that merely
    exists somewhere in the file.
    """

    def test_request_methods_are_methods_of_the_handler(self):
        for name in ("do_GET", "do_POST"):
            self.assertTrue(
                callable(getattr(srv.Handler, name, None)),
                f"{name} must be a METHOD of Handler; module-level makes every request a 501",
            )

    def test_probe_helpers_are_module_level_and_not_swallowed_by_the_class(self):
        # The mirror of the above, and the half that localises the failure: if these ever became
        # attributes of Handler, the class body has eaten them again.
        for name in ("_probe_one", "_probe_clients", "_probe_error", "_probe_tiktok",
                     "_ffmpeg_has_extension_picky", "_ffmpeg_version", "_input_opts",
                     "_mux_result_verdict"):
            self.assertTrue(callable(getattr(srv, name, None)), f"{name} must be module level")
            self.assertFalse(hasattr(srv.Handler, name), f"{name} must NOT be inside Handler")

    def test_the_probe_takes_no_input(self):
        """The security property, asserted rather than promised. This route reaches yt-dlp, so a video
        id read from the request would be an arbitrary-url fetcher wearing a diagnostic name."""
        self.assertIsInstance(srv.PROBE_VIDEO, str)
        self.assertTrue(srv.PROBE_VIDEO)
        self.assertIsInstance(srv.PROBE_CLIENTS, tuple)
        self.assertIn("web_embedded", srv.PROBE_CLIENTS)


if __name__ == "__main__":
    unittest.main()
