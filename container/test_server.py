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
import os
import socket
import unittest


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
    """Stub for subprocess.run that records argv instead of running anything."""

    def __init__(self):
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)

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


if __name__ == "__main__":
    unittest.main()
