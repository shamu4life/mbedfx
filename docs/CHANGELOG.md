# Changelog

All notable changes to mbedfx are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

Nothing yet.

---

## [1.14.1] - 2026-08-31

### Added — the crawler-patience experiment (`/_wait`)

**The owner's verdict on 1.14.0, same day it shipped: the stock player re-wraps the YouTube
playback Discord already has — the thing this project exists to replace. It stands as a stopgap
only.** The goal remains the native muxed mp4 on a COLD first paste, and the only blocker is
arithmetic against a number nobody has ever measured: mux p50 is 18.2s, Discord caches a message's
embed from its first crawl forever, and every crawler budget in `src/worker.ts` descends from
"Discord leaves at 3-4s" — folklore whose sole source is a commit message (553bd2e). The one real
observation (2026-08-30) is that a ~4.1s activity document drew a full card.

Three unlinked, `no-store` routes measure the real ceiling, one real-client paste per data point:

- `/_wait/a/{n}/{videoId}[/{tag}]` — the production-shaped question. Instant head, **playerless on
  purpose** (no `og:video`, no `twitter:player`), whose activity+json link points at a document
  held {n} seconds. On a warm video, a player in the drawn card can only mean Discord waited.
- `/_wait/h/{n}/{videoId}[/{tag}]` — the head itself held {n} seconds, ordinary instant activity
  link. Separates the head fetch's budget from the activity fetch's.
- `/_wait/act/{n}/{sid}` — the delayed activity document: sleeps, then re-enters `handle()` for
  the real `/users/youtube/statuses/{sid}` (the `/_smoke` re-entry pattern), so the delayed bytes
  cannot drift from the real ones. A test asserts the equality.

{n} is capped at 60 (refused with 400 above that, before any sleep — an open-ended sleep parameter
on a public route is an abuse handle). Humans are redirected to the real video. The optional {tag}
busts Discord's per-URL unfurl cache for re-tests.

**What the answer buys.** If Discord's real ceiling is ~20-30s, holding the activity document
until the mux lands converts most cold pastes to the real native card — no stock player, no photo
— and `YT_MUX_BOT_MS` gets re-sized around a measurement instead of folklore. If the ceiling is
short, the answer closes this door the way `/_clients` closed the PO-token door: permanently, with
data. Mutation-falsified before keeping: a player tag smuggled into the head fails 3 tests; a
removed sleep fails the hold assertion.

---

## [1.14.0] - 2026-08-31

### A cold YouTube paste plays, at full quality, for the first time

The 1.13.1 experiment came back from a real Discord client (owner's screenshots, 2026-08-30), and
its three variants decomposed the design exactly:

| variant | head | verdict |
|---|---|---|
| v1 | player tags alone | **playable** — Discord renders the `youtube.com/embed` iframe from our origin |
| v2 | + the oEmbed link | **playable, with the counts row beside it** |
| v3 | + the activity+json link | the **activity card** — the iframe is suppressed whenever the link is present |

v3 is the design constraint: the iframe and the activity card cannot coexist on one head. And v3's
inline playback in the screenshot was our own muxed mp4 (that video was warm), which the owner rated
the better experience — so the integration replaces nothing that works.

#### Changed
- **`stockPlayerTags` in the spoof head** (`src/render/discord.ts`): a yt post with NO playable
  video — the mux still racing on a cold first paste, a live stream, a video past
  `MUX_MAX_SECONDS` — now emits YouTube's own embed player (`twitter:card player`,
  `twitter:player` → `youtube.com/embed/{id}`, `og:video` type `text/html`) and OMITS the
  activity+json link, which v3 measured as the suppressor. The oEmbed link stays (v2). Full quality
  because it is YouTube's player; zero latency because the url derives from the id. Today all three
  states render a photo that Discord caches in the message forever.
- **Warm videos are byte-for-byte unchanged**: the gate is `p === 'yt' && no playable video`, so a
  settled mux keeps the activity card and the inline mp4. Later pastes of a video whose first paste
  drew the stock player get the inline player as before — per-message caching means each message
  keeps the best card available when it was pasted.
- **Age-gated videos are excluded** (`post.sensitive`): YouTube's embed refuses them with a sign-in
  wall, so stock would trade an honest note for a player that errors on tap. The note card stays.

#### Rewritten, not deleted
Two tests pinned `!html.includes('og:video')` on the cold/no-container yt head. The property they
protect is that no url of OURS promises bytes that do not exist (the poisoned-media defect); the
stock og:video points at youtube.com, cannot reach `/_media`, and cannot be a dead mp4 — so both now
assert the sharpened hazard (`no og:video at _media`) plus the stock shape. A third test pins the
gate's three boundaries, and all three were falsified by mutation before being kept: widening the
gate onto warm videos, dropping the age exclusion, and keeping the activity link each fail exactly
one named test.

#### Known trade, stated
The stock card has no author row and is click-to-play into YouTube's pop-out rather than inline.
That is the v2 card from the measurement, chosen over a frozen photo. Live streams and >25-minute
videos — never playable here before — now play through it.

---

## [1.13.1] - 2026-08-30

### The stock-player experiment: can Discord be handed YouTube's own player?

The cold-paste problem is arithmetic that no budget fixes: extraction alone costs 3.1-4.7 s, mux
p50 is 18.2 s, and the crawler window is ~5.8 s — so a first paste is a photo, and quality-lowering
formats are both refused by YouTube (itag 18 answers 403 even to yt-dlp itself, measured 2026-08-30
on three videos) and off the table anyway.

The remaining full-quality, zero-latency candidate is the one koutube ships as its `stock` mode and
its live-stream fallback: `twitter:player` pointing at `youtube.com/embed/{id}` — an iframe card
whose url derives from the id alone. No extraction, no mux, no container, nothing to time out, and
it is YouTube's own player, so the viewer gets every resolution the video has. It would work on a
stone-cold paste, on a live stream, and on a video past `MUX_MAX_SECONDS` — the three cards this
project cannot currently play.

**Whether Discord renders it from this origin is unknowable from a shell** — iframe support is
provider-whitelist-shaped, and the page carrying the tag is not youtube.com. koutube's users are
evidence, not proof.

#### Added
- **`/_stock/{1|2|3}/{videoId}`**, an experiment route outside every production path: `no-store`,
  never linked, touches no container and writes nothing, and `/watch` is byte-for-byte unchanged.
  Three variants so one paste session answers the whole design question — v1 the player tags alone,
  v2 plus the oEmbed callback (do the counts coexist with the iframe), v3 plus the activity+json
  link (does the Mastodon document suppress it, which decides whether an integration replaces the
  yt spoof or extends it). The title rides `fetchYouTube` — worker.ts performs no egress of its own,
  and the probe enforcer holds that invariant against exactly this kind of addition.

If the experiment wins, the integration is a separate, measured change. If it loses, the route is
deleted and the answer written down here.

---

## [1.13.0] - 2026-08-30

### TikTok's redirect is resolved by the container, because a Cloudflare Worker cannot resolve it

`resolveAwemeUrl` turns TikTok's playable url — the cookie-free `/aweme/v1/play/`, which is itself a
302 — into the CDN url behind it, so Discord sees ONE hop. Two hops and Discord draws the OpenGraph
card instead of the Mastodon activity card (measured 2026-07-19; the tt arm of `worker.ts` records
it). Since roughly 2026-08-08 it has returned `null` for **every** TikTok: from Cloudflare Worker
egress that endpoint answers a 404 HTML page instead of a 302. Production counters after 1.12.2 made
it visible: `tt_twohop` 3, `tt_onehop` 0.

**It is not a bug the Worker can fix, and that is why this is an architecture change.** The identical
failure reproduces against fxTikTok's OWN Cloudflare Worker — their `wrangler.toml` names
`fxtiktok-rewrite-dev.dargy.workers.dev` as the staging `OFF_LOAD`, and for the same video it answers
`location: https://www.tiktok.com/404?fromUrl=/aweme/v1/play/…`. Same algorithm, same UA, same 404.
Their production works only because `OFF_LOAD = "https://offload.tnktok.com"` is a Bun server behind
a `Dockerfile`: their own box, off Cloudflare.

This container is the box we already own, and its egress was **measured before this was written**:
`/_clients`' TikTok arm on production reported `extracted: true, formats: 10, ms: 2704`. It reaches
TikTok in under three seconds where the Worker gets a 404 page.

#### Added
- **`{redirect: <url>}` on the container's `/resolve`.** It follows exactly ONE hop and returns the
  `Location`; it never fetches a byte. One hop, not a chase: following redirects server-side is how
  an SSRF gate gets walked around one `Location` header at a time, so the caller gets the one answer
  and decides. Both ends go through `_safe_url` — the input because it arrives over the wire, the
  OUTPUT because a `Location` is attacker-influenced in exactly the same way.
- **`withResolvedVideo(post, viaContainer?)`.** The Worker's own fetch is tried FIRST, always: it is
  free when it works, it is the path every test drives, and on the day TikTok stops refusing this
  egress it silently becomes the only path taken again. The container is the fallback.

#### Changed
- **`RESOLVER_GENERATION` g13 → g14**, and it is the same use as the 2026-08-28 bump: ending a
  stale-image state, not invalidating a record. Every record is fine. After the 1.12.3 deploy the
  build log showed the image pushed, the application reported the new digest, the rollout reported
  `completed` with 7/7 and zero errors, and the instance census reported all twelve on it — and
  `/_clients` still ran 1.12.2's code. **Seven minutes of deliberate quiet did not clear it**, which
  is the same result the 2026-08-28 note records for six. Take the pair as the standing lesson: the
  instance census reports the DESIRED image, not the running one, and this constant is the only lever
  measured to work.

#### Deliberately not done
- **TikTok was NOT converted to a `{page}` remux.** It is the obvious change, it was written, and it
  was dropped: `settleMux` degrades to a cover still while a mux runs, so every TikTok's first paste
  would become a still. That regresses the posts that render today, and fxTikTok does not do it
  either — they resolve the redirect at request time, which is what this release copies.
- **The claim that every TikTok is BROKEN is withdrawn.** `tt_twohop` proves all of them are
  two-hop; it does not prove all of them fail. Two hops costs the richer Mastodon card, and an
  OpenGraph card still carries `og:video`. The reported post fails; how many others do is unmeasured.

#### Also written down, not fixed
`settleMux`'s over-length ceiling can never fire for TikTok: it returns early on
`if (!own.some(m => m?.remux))`, and a directly-playable source carries no `remux`. So
`m.duration > MUX_MAX_SECONDS` has never once applied to this platform, and the 2139-second post that
started this was being offered to Discord as a playable attachment.

---

## [1.12.3] - 2026-08-30

### The TikTok probe was measuring a request nothing in this system ever makes

1.12.2's container probe answered `fetch: http-403` from production. That reads exactly like the
`*-webapp-prime` cookie gate `tiktok/normalize.ts` documents, and it is **not** that — it is the
probe's own artifact. It pulled bytes with a bare UA and a `Range` and nothing else, while yt-dlp
returns a `http_headers` dict per format (Referer, and whatever else the extractor negotiated) and
the real mux path sends them, because yt-dlp does the downloading. Control, same yt-dlp and same
post, run locally: the download completes at **2,321,023 bytes of valid ISO Media**.

A 403 from a request the system never issues is a false negative on the one question the probe was
added to answer, and acting on it would have meant abandoning the container path for no reason.

#### Fixed
- **The probe sends yt-dlp's own per-format `http_headers`.** `range` and the UA are set first so a
  format carrying its own user-agent wins, and any upstream attempt to redefine `range` is dropped —
  an upstream header must not choose how many bytes we asked for. The headers actually sent are
  reported as `hdrs`, so the next reader can tell a real gate from a malformed request without
  guessing.
- **Only the TikTok arm changed.** `_probe_one`'s YouTube fetch is deliberately untouched:
  googlevideo serves it as-is today, and editing a green probe to make a point about a different
  platform is how a baseline gets lost.

### What is still true, and what comes next
The reading that matters from 1.12.2 stands: on production container egress the TikTok arm reported
`extracted: true, formats: 10, ms: 2704`. **The container reaches TikTok in under three seconds where
the Worker gets a 404 page.** If this release's corrected fetch also returns bytes, the container is
the box that can serve TikTok video — mbedfx's equivalent of fxTikTok's `offload.tnktok.com` — and
the fix is to route TikTok through it as a `{page}` remux like every other platform. That change is
written and held back deliberately: it turns seven tests that pin the aweme-302 design into tests of
a different architecture, and those get rewritten with a measurement in hand, not an inference.

---

## [1.12.2] - 2026-08-30

### Every TikTok has been handing Discord a two-hop redirect, and nothing counted it

Reported: `tiktok.com/t/ZTDT2xNn3/` does not embed here while fxTikTok plays the same post. It is not
that post. **Every TikTok video on the site is affected**, and has been since roughly 2026-08-08.

`resolveAwemeUrl` exists to turn two redirect hops into one — the normalizer picks the cookie-free
`/aweme/v1/play/` url, which is itself a 302, and the tt arm of `worker.ts` records the 2026-07-19
measurement that two hops make Discord draw the OpenGraph card instead of the Mastodon activity card.
It returns `null` for every TikTok in production. Verified by counting hops on the live `/_media/`
`Location`: 3 of 3 sampled were two-hop, **including `7246058829106973978`, the post `/_smoke` pins
and reports `ok`** — smoke only asserts a card came back, so it cannot see this.

**It is not our bug, and that is the important part.** The same failure reproduces against fxTikTok's
OWN Cloudflare Worker: their `wrangler.toml` names `fxtiktok-rewrite-dev.dargy.workers.dev` as the
staging `OFF_LOAD`, and asked for this video it answered
`location: https://www.tiktok.com/404?fromUrl=/aweme/v1/play/...` — the identical 404. Their algorithm
is also identical to ours (fetch with `redirect: 'manual'`, follow `Location`). **Cloudflare Worker
egress cannot resolve that endpoint, for them or for us.** Their production works because it does not
try to: `OFF_LOAD = "https://offload.tnktok.com"`, and `src/offload.ts` is a plain Bun server behind a
`Dockerfile` — their own box, behind Cloudflare's proxy.

This release does not fix the embed. It makes the failure **visible and measurable**, and answers the
one question that decides the fix, neither of which could be done from outside.

#### Added
- **`tt_onehop` / `tt_twohop` counters.** Read off the url actually shipped rather than a flag from
  the resolver, so they cannot drift from what Discord fetches. `tt_twohop` climbing while
  `tt_onehop` sits at zero is the signal that would have caught this on day one.
- **A TikTok arm on the container probe** (`/_clients`). The container is the box we already own, and
  the whole question is whether ITS egress reaches TikTok where the Worker's does not. The probe
  reports `extracted` and `bytes` separately on purpose: yt-dlp returns
  `*-webapp-prime.us.tiktok.com` urls that `tiktok/normalize.ts` records as **403 without a cookie**,
  so an extract yielding urls nobody can fetch is a false positive. It runs last so a TikTok change
  can never delay or fail the YouTube rows the endpoint already existed to report.

#### Measured, so nobody repeats it
- **The 35.7-minute / 206 MB length of the reported video is a red herring** (`duration: 2139`,
  `size: 206325559`). Short TikToks are equally two-hop.
- **TikTok's payload carries no direct CDN url.** Every entry in `playAddr`, `downloadAddr`,
  `PlayAddrStruct.UrlList` and all six `bitrateInfo[].PlayAddr.UrlList` is either a cookie-gated
  `*-webapp-prime` host or the same two-hop aweme url. Resolving the redirect is the only path.
- **The Cloudflare MCP `execute` sandbox cannot measure egress** and silently looks like a real
  answer. It refuses all outbound: `example.com` returns 403/50 bytes. Run that control first.

#### Fixed
- **`settleMux`'s over-length ceiling can never fire for TikTok**, found on the way. `settleMux`
  returns early on `if (!own.some(m => m?.remux))`, and a directly-playable source carries no
  `remux` — so `m.duration > MUX_MAX_SECONDS` only ever protected container-muxed video. Not changed
  here (it needs the embed decision first), but written down where the guard is.

---

## [1.12.1] - 2026-08-30

### A cold YouTube card still rendered 1 January 1970, and the arm that would have fixed it was budgeted under its own cost

Reported from a real Discord client: a cold paste of `youtu.be/MsqhUjjkDjI` drew correctly, with a
player, and carried the epoch as its timestamp.

The date has two sources and 1.12.0 sized the budget against the wrong one. The render's own
Innertube call answers in 281-1723 ms when it answers at all — but it is refused about half the
time from this egress (`yt_innertube_fail` 324 vs `yt_innertube_ok` 293 all-time; 170 vs 182 over the
24 h to 2026-08-30, a coin flip rather than the "9 of 10" an earlier note claimed). On the refused
half the arm falls through to the container's `yt-dlp -J`, which takes **3.1-4.7 s** on standard-2.
`YT_META_BOT_MS` was 2800 ms, which sits under the whole of that range, so the fall-through could
essentially never land and the card rendered the epoch instead. It is the same error as the 1500-ms
budget under a 1716-ms median that 1.12.0 fixed, one level down: sized against the FIRST source while
the cost on the failing path belongs to the SECOND.

#### Changed
- **`YT_META_BOT_MS` is 4000 ms**, level with `YT_MUX_BOT_MS` rather than under it. The raise is free
  on any card whose mux arm is running: the three arms race in one `Promise.all`, the response ends at
  the slowest, and the mux arm was already 4000. The max does not move. Where it is NOT free is stated
  in the docstring rather than glossed — when `settleMux` refuses to dispatch (a live stream, or a
  video over `MUX_MAX_SECONDS`) the mux arm returns in ~0.1 s and this arm alone sets the response, so
  such a card with no cached date now takes 4000 ms instead of 2800. That is the one regression, it is
  bounded by this constant, and it is paid exactly where the reader would otherwise be shown 1970.
- **The folklore bound stopped being the reason for the number, because it finally got tested.** 2800
  was chosen "to stay inside the 3-4 s everyone assumes is Discord's abandon point" while admitting in
  the same breath that nobody had ever measured that 3-4 s. The 2026-08-30 paste above is the first
  real-client observation on this seam in the project's history, and the card drew against activity
  documents measured at 4.03-4.15 s. It is ONE observation. It licenses staying level with the mux
  arm, where the response already ends; it does not license 9000, and the docstring says so.
- **`test/card-muxing.test.mjs` now asserts `YT_META_BOT_MS <= YT_MUX_BOT_MS`**, not `<`. The property
  guarded is that the response max does not move, and `Math.max(a, b) === b` when `a === b`. Equality
  is the largest value that still costs zero, so `<` would forbid the free case and permit nothing.

#### Fixed
- **The 1.12.0 entry denied a test that the same release merged in.** It said the version bump had
  "only the badge has a test holding it there". That was true at the release commit `76840ab` and was
  falsified an hour later by `73891c5`, the merge folding PR #72 in, which imported
  `test/version-consistency.test.mjs` — the test pinning the lockfile's two copies, the package name,
  `CLAUDE.md`'s version line and the existence of a dated changelog heading. A union merge that brings
  in a test needs a pass over the sentences asserting what is untested; no conflict marker points at
  one. Found by an adversarial audit of the shipped tree that re-verified ~25 constants against the
  changelog and found this the only outright false claim.

### Known, measured, and not fixed here
- **The 4000 ms mux budget converts far less than the 1.12.0 entry implies.** Probed faithfully — head
  and activity document issued back to back, as Discord issues them — **0 of 15 cold first pastes drew
  a player**; larger samples reporting 1 in 44 and 1 in 29 were measuring their own probe gap, into
  which a mux (p50 18.2 s) lands. It remains strictly better than 1500, where the race was
  arithmetically unwinnable (fastest mux ever recorded 4200 ms), but "catches the fast tail" overstates
  it. The lever worth pulling next is starting the mux earlier, not widening the budget further.

---

## [1.12.0] - 2026-08-29

### A cold YouTube paste could not carry a player, and the budget that decided it was arithmetically lost

The 2026-08-09 crawler cut collapsed a split budget — 5000 ms on the HTML head, 9000 ms on the
activity document — into one `MUX_WAIT_BOT_MS = 1500` on both. The activity document is where
`media_attachments[].type` is decided, which is whether Discord draws a player or a photo, and
Discord stores the embed it drew inside the message forever. So a cold first paste was structurally
unable to be a player, permanently, for the reader who pasted it.

The production counters now say how badly. Of the 139 successful YouTube muxes recorded since the
`mux_*` rows went live on 2026-08-24, weighted by `_sample_interval`: p10 6922 ms, p50 18219 ms,
p90 41254 ms, **minimum 4200 ms**. Zero finished inside 1500 ms. That is not a poor hit rate, it is
a race lost before it starts. The whole reading, the queries behind it and the archaeology on the
cut are in `docs/research/2026-08-29-the-1500ms-crawler-cut.md`.

#### Changed
- **The activity document's three arms have three budgets** (`src/worker.ts`). The mux arm gets
  `YT_MUX_BOT_MS` (4000 ms) on YouTube only; the metadata arm gets `YT_META_BOT_MS` (2800 ms),
  because `INNERTUBE_TIMEOUT_MS` is 2500 ms and 1500 sat below the 1716 ms median of that call's own
  successes; the translation keeps the shared 1500 ms. The HTML head and the `/_oembed` callback are
  untouched — `toOEmbed` reads two fields off the post and `settleMux` can change neither, so a
  bigger budget there would buy literally nothing on a third crawler request.
- **4000 is a tolerance step, not a win, and the ceiling is the argument.** The one number in this
  repository derived from Discord's own behaviour is the 2026-08-09 run where a 5.14 s head drew NO
  card: whatever the crawler's per-request tolerance is, it is under 5.14 s. 4000 plus the route's
  own work lands near 4.2-4.3 s. 8000 rebuilds the 8.19-8.29 s document the cut deleted. The
  widely-quoted "Discord leaves at 3-4 s" is folklore — until this release that phrase appeared
  exactly once anywhere here, in the commit message that made the cut, citing nothing. It is now
  written down as unsourced in two places instead of quoted as fact in one.
  `test/card-muxing.test.mjs` now holds both new budgets under the 5.14 s bound;
  neither had a guard, while the constant they were split from has had one since it was written.
- **Two comments that justified the cut are corrected in place.** "NOTHING IS ABANDONED" was false —
  `ctx.waitUntil` is a hard 30 s cancel on a budget shared across one request, and the MuxRunner
  alarm is what makes the claim true now. "It lasts exactly one view" was false the other way, and
  four other files in this tree already cited discord-api-docs#1663 saying so. That second one cuts
  both ways: it is why raising the budget matters, and why losing the bet is permanent.

### Live streams were muxed on every render, forever

Measured on `yt:xDWQ3LkccY8` (Sky News, permanently live): pinned at `muxing: true`, about 1.7 s of
container round trip per render, never cached, on every paste. A live stream reports
`lengthSeconds: '0'`, so it carries no duration, so `settleMux`'s over-ceiling arm — the only refusal
it had — waved it through to a container that refuses it on `--match-filter "… & !is_live"`. A
degraded card is deliberately not response-cached, so the next render repeated the whole thing. News
channels post these constantly.

#### Added
- **A liveness verdict from Innertube, and a `Media.live` flag settleMux refuses to dispatch.**
  `isLiveContent` is NOT the discriminator and keying on it would refuse a mux for every past
  broadcast a channel has ever published. Measured cookie-free 2026-08-29, one id per state:
  `xDWQ3LkccY8` streaming (`isLive` true), `wEpMzbXi1CM` scheduled (neither `isLive` nor `isLiveNow`,
  caught by a broadcast with no `endTimestamp` and no length), `0cVnt1bUzLI` ended (`isLiveContent`
  true, a real 3764 s length, muxes normally), `dQw4w9WgXcQ` never a broadcast. A scheduled stream is
  treated as live because it fails identically: no file, nothing to download, a card that spins.
- **`🔴 Live stream, so no preview here. Open it on YouTube`**, so the picture is not a silent
  degrade. It suppresses the length note — one reason per card, and this is the one the mux was
  actually refused on. The card CACHES, because the answer is final rather than incomplete; that is
  the half that stops the round trip repeating.
- **`YT_LIVE_TTL_MS`.** A stored record saying `isLive` expires in an hour rather than in
  `YT_META_TTL_MS`'s thirty days. Liveness is the one mutable field these records carry, and the
  record cannot heal itself: `metaAttempt` runs only on a read miss, and `youtubeMeta` returns null
  once the post has a real date, which a live stream always does. Without the split, a broadcast that
  ended went on claiming to be live for up to a month on every render whose own Innertube call was
  refused — roughly half of them from this egress.

### Fixed
- **The length note fired on other platforms' cards.** Both YouTube note overlays are applied at the
  activity callback, which is not scoped to `ref.p === 'yt'` the way `describeTarget` is. That was
  harmless while their only supply was a `YouTubeMeta` field, since `youtubeMeta` answers null
  everywhere else — the seam was safe by accident. Giving the notes a fallback that reads
  `Media.duration` off the post removed the accident, and `Media.duration` is written by the yt-dlp
  tier (Dailymotion, Streamable, Imgur), PeerTube, Twitch, Instagram, Facebook and the Mastodon API
  arm. A 4830 s Dailymotion video unfurled as "🎬 Too long to play here. Open it on YouTube", frozen
  in the message. Both notes now refuse a post from another platform, guarded in the functions rather
  than at the call site, because a call-site guard restores exactly the accident.
- **The length note ate the description.** It prepends into `text`, and `withDescription` refuses to
  write a body that already exists, so on a long video the card got the note or the description and
  never both. Fixed at BOTH seams; the ordering comment says so, because applying it at one is
  applying it at neither.
- **The note was unreachable on the path most pastes take.** `withLengthNote` read only its argument,
  and `youtubeMeta` returns null as soon as the post carries a real date — the common case since the
  Innertube source landed. The duration was not missing, only somewhere else: the fetch path stamps
  it onto the media entry. The fallback reads it back from there, and does not re-stamp what it read,
  because `withMuxDuration` writes one number onto every remux entry and the fallback takes the first.
- **A live card lost its description.** `LIVE_NOTE` is applied at build time inside
  `normalizeYouTube`, so `text` was non-empty by the time the overlay seam ran and the warm record's
  description was refused. `withDescription` now treats a bare live note as a marker rather than a
  body. The age note is deliberately still a body: that one is a decision about what to show.
- **A partial Innertube response answered a confident "not live".** `liveVerdict` returned `false` for
  any body carrying a `videoDetails` block, so the three-valued design collapsed to two on every
  response that happened to lack a microformat — and `false` is the one value allowed to clear a
  stored `isLive: true`. Every measured negative comes out of the microformat, so a body without one
  now abstains.

### Changed
- **The container's `{page}` mux has its own wall, `MUX_PAGE_TIMEOUT` (360 s).** It ran under
  `PROC_TIMEOUT + 60` = 180 s while `MAX_SECONDS` admits 1500 s of video. That wall was UNREACHABLE
  until the MuxRunner alarm landed, because `ctx.waitUntil` cancelled the attempt at 30 s first, so
  nothing ever hit it and nobody noticed. It is now the first ceiling that bites: a long video is
  SIGKILLed at 180 s, the container buffers the whole file before sending a byte and writes to a
  fresh `mkstemp`, so R2 gets nothing and all three alarm attempts restart from byte zero. A
  20-minute video never plays, on any paste, ever. `PROC_TIMEOUT` is deliberately NOT raised: it also
  walls the tracks mux, which `MUX_FIRST_ATTEMPT_TRACKS_MS` is timed against, and a mux alarm that
  fires early is the double-mux `muxOnce` exists to prevent. **360 is not a derivation and the
  comment does not pretend it is** — the only throughput figure on file is ~267 KB/s from the old
  quarter-core container on yt-dlp 2026.7.4, and both terms have since moved. The direction is what
  is defensible: a longer wall spends slot-seconds only on videos that currently fail 100% of the
  time. What it costs is written down beside `MUX_RETRY_MS` — a permanently-failing page video now
  burns 1080 slot-seconds instead of 540.
- **The converter preview watches the whole first attempt again.** `MUX_WATCH_TOTAL_MS` mirrored
  `MUX_FIRST_ATTEMPT_TRACKS_MS` (140 s) on the reasoning that the `{video}` tracks shape is the
  slowest. It stopped being the slowest the moment the page mux got a wall it could reach, and every
  YouTube link is a `{page}` source, so the page was giving up at 35% of the real first attempt — on
  exactly the long videos the raised wall exists to rescue. It is now
  `MUX_FIRST_ATTEMPT_PAGE_TOTAL_MS` (395 s), exported from `src/muxpolicy.ts` so the literal stays
  derived, with `MUX_PAGE_WALL_MS` pinned to `container/server.py` by a test the way `MAX_SECONDS`
  already is.
- **`RESOLVER_GENERATION` and `META_GENERATION` are two strings.** One names the pooled container
  instances; the other scopes the stored meta records. They were one, and the cost of that is
  recorded in the g13 note: the bump that ended the 2026-08-28 container outage (1.11.1) discarded
  every stored date, description, duration, count and gate verdict on five platforms, 40 hours after
  the Innertube corpus that was meant to make YouTube dates reliable shipped. Both hold `g13` today,
  so the split itself invalidates nothing. The rule changed shape with them: it used to ask what
  changed (bump whenever `container/` changes behaviour) and now asks what a record says (if one
  written yesterday is read tomorrow, does it say something false?). Under-invalidation is newly
  expressible and is the worse direction, so when it is unclear, bump `META_GENERATION`.
- **The outage detector can fail on YouTube.** Every Discord head this service emits carries a
  `rel=alternate` activity link unconditionally, and `cardVerdict` counts that link as "something to
  draw" — so the YouTube row was satisfied by the head's own boilerplate and could not go red short
  of YouTube disappearing, through the three weeks first pastes were structurally unable to carry a
  player. One row now carries `expect: 'video'` and reports a new `no-video` verdict. Expect one or
  two red ticks every 60 days from R2's `expire-60d` rule sweeping the muxed file; the alarm re-muxes
  it. The expectation is opt-in and a test pins the list to `['yt']`, so adding a platform stays a
  measured decision.
- **The retry lint sees every fetcher.** It matched the literal string `await fetch(`, which is not
  how two of them spell a fetch: `src/platforms/youtube/*` calls through an injected
  `fetchImpl: typeof fetch` (renamed the day before the lint landed) and the Threads OG fallback
  spells it `fetch(url, …).then(…)` inside a `Promise.all`. So the guard reached fifteen fetchers and
  zero YouTube files, on the platform with this repo's highest measured egress refusal rate, and
  reported nothing — which read exactly like coverage. Detection is now derived per file from `fetch`
  plus every identifier that file declares as `typeof fetch`, and the existing `NO-RETRY` exemption
  requires a stated reason rather than a bare marker. Both Threads OG fetches and the YouTube oembed
  call now retry; `askTwice` takes the injected seam as an optional third argument so the second
  could. Innertube keeps a NO-RETRY exemption: a refusal there is a prompt 403, which
  `worthAskingAgain` reads as an answer about the video, and asking again was measured as a no-op.
  The count moved from 24 call sites across 15 fetcher files to 27 across 16. The 1.11.0 entry said
  22, which undercounted its own work: that tag carries 24 call sites across 15 fetchers, and the
  entry below now says so.

### Documentation
- **The Analytics Engine queries in `docs/METRICS.md` had never been run, and none of the three
  worked.** The table is `mbedfx_counters`, not `mbedfx`; a backslash in a string literal is rejected
  outright with HTTP 422, so `LIKE 'mux\_%'` errors and the eight outcomes have to be enumerated; and
  the data is SAMPLED — `_sample_interval` took values from 1 to 12 in the first window read, so a
  bare `COUNT()` under-reports badly. Every query is fixed and weighted.
- **The Dockerfile's pin no longer blames Docker layer caching.** The argument for an exact pin cited
  a floor freezing behind a reused layer. There is no machine holding this repo's previous layers:
  every merge runs `wrangler deploy` in a Workers Builds runner off a fresh clone, and this repo's own
  logs report `Image does not exist remotely, pushing:`. A floor would not freeze, it would FLOAT.
  The pin is still right for the two reasons that survive — the image is reproducible and a bad
  release is one line to revert. The same paragraph also blamed the floor for the 2026-08-17 outage;
  the running version was 2026.7.4, the newest stable that day, and the cause was that release's
  default player clients. What the floor cost was the diagnosis. Mirrored into
  `test/ytdlp-pin.test.mjs`, which was repeating both.
- **`docs/SELF-HOSTING.md` described the pin as an exact NIGHTLY** and explained why the channel is
  nightly rather than stable. Both false, and against an owner decision from 2026-08-18. It also
  counted nine `ctx.waitUntil` sites where a grep that allows for the optional-chained one finds
  fifteen, and quoted a line count for `container/server.py` that was wrong by a third.
- **A new research note**, `docs/research/2026-08-29-the-1500ms-crawler-cut.md`, holding the counter
  reading, the queries that produced it, what the 2026-08-09 measurement does and does not prove, and
  the two open questions this release could not answer: what Discord's abandon threshold actually is,
  and whether Cloudflare's throughput limit is per-connection or per-egress. `docs/METRICS.md` now
  carries the mux-quantile query and the `card_degraded` reading, with the caveat that the smoke cron
  fires `ok` rows with a Discordbot user-agent and so biases the published ratio downward.
- **Site copy that had gone false.** The converter preview said "Still preparing after two minutes"
  while it now watches for six, and the YouTube row of the platform table said only age-restricted
  videos are thumbnail-only. The "Video came back as a still" card names live and scheduled streams
  as a fourth cause. PeerTube's row already carried the live sentence, so YouTube was the outlier the
  moment the guard landed.
- Corrected everywhere they appear: the 180 s page-mux wall (six documents), the single generation
  string (four), what `card_degraded` excludes (four), the smoke list's size (seventeen checks across
  sixteen platforms, one excused, not sixteen across fifteen with two excused), and every
  `src/worker.ts:NNNN` citation in `docs/METRICS.md` and `docs/CREDENTIALS.md`, which this release
  moved by 460 lines. Those now name the function instead, the way `docs/API.md` already did.
- **`src/fetchretry.ts` was inviting the change its own neighbour forbids.** Its docstring credited
  "a SECOND attempt" with lifting YouTube first-paste success from 0/14 to 9/10. That was persistence
  plus the activity route's later call; the same commit measured a second immediate ask as a no-op.
  As written it argued for wiring `askTwice` into Innertube, 200 lines from the NO-RETRY comment that
  refuses it.
- **`HANDOFF-youtube.md` is frozen into `docs/research/2026-08-23-youtube-mux-ceilings-and-bytes.md`**
  and gone from the repository root, where it was the first file an agent read. It was a handoff to a
  tree that stopped existing on 2026-08-24, when both PRs it was waiting on merged. Three of its
  claims had gone false and all three were load-bearing: "a first paste shows a thumbnail by design"
  is what this release reverses, its next step was a PO-token provider that a production probe closed
  on 2026-08-28, and its ~267 KB/s was measured on the quarter-core container against yt-dlp 2026.7.4.
  It keeps a dated header separating the reasoning, which holds, from the numbers, which do not, and
  is now frozen at its measurement date like the six other notes beside it.

### Notes
- `package-lock.json` was still on 1.10.1 at the 1.11.0 tag. npm writes the version in two places
  there and the cut moved neither, which nothing noticed because nothing reads it. Corrected with
  this release. Both copies, `package.json`, `CLAUDE.md` and the badge in `public/index.html` now say
  1.12.0, and two tests hold them there: `test/version-consistency.test.mjs` pins the lockfile's two
  copies, the package name, `CLAUDE.md`'s version line and the existence of a dated changelog
  heading, and `test/landing-convert.test.mjs` pins the badge. This sentence previously said only the
  badge was guarded, which was TRUE when it was written at the release commit and was falsified an
  hour later by the merge that folded PR #72 in — that merge imported the very test it denies. A
  union merge that brings in a test needs a pass over the sentences asserting what is untested.
- **A minor rather than a patch.** The live-stream guard, the 🔴 note, the three activity-document
  budgets and `MUX_PAGE_TIMEOUT` change what a reader sees on a card, and `META_GENERATION` is new
  public surface for anyone self-hosting. Not a major: no route, no field and no response shape
  changed, and every client written against 1.11.0 still parses 1.12.0.

---

## [1.11.1] - 2026-08-28

### Fixed
- **The 1.11.0 container answered every request with `501 Unsupported method`, and every mux on every
  platform broke together.** The patch that added the `/_clients` probe anchored on a class statement
  that does not exist in this file, took its fallback anchor, and spliced the module-level probe
  helpers into the middle of `Handler`'s body. A Python class ends at the first unindented line, so
  `do_GET` and `do_POST` stopped being methods and `BaseHTTPRequestHandler`'s own base implementation
  answered instead — which is a 501 for every verb. The helpers now sit above the class, and the
  patch script that placed them verifies with `ast` rather than with a string anchor.
- **The repair was live for ten minutes before production noticed it.** Container image 120 was
  correct and deployed; seven pooled instances kept serving the broken image because an instance runs
  the image it booted with until it idles out, `sleepAfter` is 5m, and *any* request resets that
  timer — so under live traffic the broken instances were kept alive by the very requests they were
  failing. Six minutes of deliberate quiet did not clear it. `RESOLVER_GENERATION` `g12` -> `g13`
  ended it, because that string names the Durable Objects and changing it forces brand-new instances.
  Recorded in `src/worker.ts` as the first time that constant has been spent to end an outage rather
  than to invalidate a wrong record. If it recurs, a shorter `sleepAfter` is the cheaper permanent
  answer than another bump; `src/container.ts` already argues 3m is available.

### Added
- **Three tests that assert the container's handler SHAPE**, not just its helpers
  (`container/test_server.py`). `do_GET` and `do_POST` must be attributes of `Handler`, and the probe
  helpers must be module-level. Nothing in 1448 Worker tests or 31 container tests could see this
  defect: the container suite calls the pure helpers, which were all fine, and the Worker suite stubs
  the container away entirely.

### Known gap
- **`/_smoke` stayed 17/17 green throughout a total container outage.** Most of its checks never reach
  the container, and YouTube metadata now comes from Innertube rather than from `yt-dlp`, so the one
  platform most likely to expose a dead container stopped depending on it. The breakage detector this
  project added *because* Facebook was once broken for a week could not see a worse break than that
  one. Nothing yet drives the container's HTTP surface end to end from the smoke path. Documented
  rather than fixed, because the fix is a design decision about what `/_smoke` is for.

---

## [1.11.0] - 2026-08-28

### Added
- **Every platform asks twice when the first answer carries no verdict** (`src/fetchretry.ts`). Every
  fetcher here asked its upstream exactly once, and Discord stores the embed it built INSIDE the
  message and never re-unfurls a link it has already drawn. So one refused request was not a bad
  minute, it was a permanently bad card for everyone who ever scrolled past that message. Reported
  2026-08-28 on a public Twitter video post that a self-hosted rival rendered correctly minutes
  apart; measured the same day, both of our Twitter paths answer that id perfectly from residential
  egress, so the card was lost to Cloudflare's egress being refused once.
  Only a REFUSED request is retried (408/425/429/5xx, or a thrown fetch). A parsed body is a verdict
  and is believed on the first ask, which is what keeps the cost bounded: a nonexistent Twitter id
  answers HTTP 200 with a parseable tombstone, so dead links still cost exactly one request. 24 call
  sites across 15 fetchers, and a source-derived test requires every `await fetch(` under
  `src/platforms` to be routed through it or carry a `NO-RETRY` comment saying why not.
- **`/_clients`, which answers which YouTube player client actually serves bytes from production
  egress.** Three YouTube fixes had shipped on residential evidence and done nothing, because the
  failure that reaches readers is Cloudflare-egress-only. This runs the comparison inside the
  container, on that egress, and asserts on BYTES rather than on a format list: each client extracts
  and then the chosen format url is range-fetched, so a client that lists formats and is then refused
  by googlevideo reports `gvs: "http-403"` instead of looking healthy. On the first run `android_vr`
  did exactly that, which also contradicts yt-dlp's own current PO Token table.
  It takes no input, the same property `/_smoke` has: the video id and the client list are constants
  in `container/server.py`. It rides the existing authenticated `/resolve`, so it opens no new
  container surface, and its range fetch goes through the same `_safe_url` SSRF gate.

### Changed
- **The container runs on `standard-2` (1 vCPU) instead of `basic` (1/4 vCPU).** The production
  `yt-dlp -J` extract had been recorded at 15.9s "from Cloudflare egress" for weeks and read as
  YouTube throttling. Measured on one connection with only `--cpus`/`--memory` varying, median of 3
  across two ids, extraction only: basic 14.1/16.9s, standard-1 9.1/9.3s, standard-2 5.7/5.7s,
  standard-4 5.4/5.4s. It matches `basic` almost exactly, residentially, with no gate involved. It
  was our own CPU.
  NOT past standard-2: the gain stops dead at 1 vCPU because the work is single-threaded, and the
  same flat top shows in two pure-CPU controls. Memory and disk bill on PROVISIONED size for the whole
  time an instance is alive, including `sleepAfter` idle, so this is a real cost increase and
  `sleepAfter` is the dial if it reads high.
- **yt-dlp 2026.7.4 -> 2026.8.19**, which repairs the default-client 403. Both images side by side,
  same video, same minute: 2026.7.4's default clients returned 0 bytes and HTTP 403, 2026.8.19's
  returned 11,829,048. The `YT_PLAYER_CLIENTS` override is deliberately kept anyway, because it still
  buys the full format ladder (19-23 formats against one) and removing it needs its own production
  measurement rather than riding a version bump.
  The weekly freshness job was not broken: on 2026-08-24 it detected the release, pushed a branch,
  could not open a PR because the repository setting forbade it, and raised an issue as designed.
- **The converter preview watches a mux to the end, and says when it lands.** It polled ten times at
  2.5s and stopped after 25 seconds, which is 1.7% of `MUX_TOTAL_HORIZON_MS`. It then went quiet and
  never confirmed the video arrived, so a reader who waited saw "still preparing" indefinitely even
  when the mux finished seconds later. The window now covers the whole first attempt, backing off from
  2.5s to 10s and stopping at 140s; completion is stated in words; and giving up says so rather than
  looking like the work stopped. The two window constants mirror `src/muxpolicy.ts` and a test fails
  when they drift, because the page ships with no build step and cannot import them.

### Fixed
- The format selector's measurement was one video presented as a result. Re-measured across 27:
  -30.6% on 10-25 min and -30.8% on 2-10 min, but +26-43% on short 202x360 clips. The in-code comment
  said 38% from a single sample.


### Security
- **An SSRF address guard in the Worker half** (`src/netguard.ts`), ported from the one
  `container/server.py` has always had. The fediverse routes take an instance hostname from the URL
  path and make it the origin of a fetch; on Cloudflare the surrounding clauses bound the worst case
  to a blind GET, but off Cloudflare that same GET reaches `127.0.0.1`, the LAN and the cloud
  metadata endpoint on `169.254.169.254`. The guard parses a host to BYTES and range-checks them, so
  `127.0.0.1`, `127.1`, `2130706433`, `0177.0.0.1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`,
  `64:ff9b::7f00:1` and `2002:7f00:1::` all get one verdict. A prefix blocklist on the text form
  passes six of those eight.
  `env.RESOLVE_HOST` is the DNS seam a self-hosted runtime plugs a resolver into; on Cloudflare there
  is none, and the literal check is the whole guard, which is stated rather than implied.
- **Fediverse LAN names are refused.** `FEDI_HOST` rejects the bare label `localhost` and admits
  `api.localhost`, `printer.local`, `db.internal` and `host.home.arpa`, found by running the regex
  rather than reading a comment that claimed otherwise. Academic on Cloudflare, where they resolve to
  nothing; the machine next door on a self-hosted box.
- **`OWN_HOSTS` is configurable** (`env.OWN_HOSTS`), so a self-hoster can declare the domains their
  instance is served from, which is the guard that stops the service being induced to fetch itself. The value
  is ADDED to the built-in list and never substituted for it, so every way of getting it wrong is
  "too strict", never "too open".

### Fixed
- **Every YouTube card said "1 January 1970" with no description, for nine days.** Fixed by taking
  the date from YouTube's own player API instead of from a subprocess
  (`src/platforms/youtube/innertube.ts`, `src/platforms/youtube/fetch.ts`).
  The date, description and counts all came from one place — a `yt-dlp -J` extract inside the media
  container — and that extract never finished for a caller still listening. Measured 2026-08-25: the
  R2 meta record exists under generations `g8` and `g10` and under **neither `g11` nor `g12`** for
  any id checked, so nothing had been written since about 2026-08-18; `wrangler tail` showed every
  request-scoped `MediaResolver` invocation ending `canceled` at 1.3–1.8s, which is the render's own
  budget rather than a platform fault. Discord caches an embed permanently in the message it was
  pasted into (jhgg, discord-api-docs#1663), so a card cannot wait seconds for a date — the first
  paste is the only paste.
  `POST youtubei/v1/player` is the endpoint youtube.com's own web player calls. Measured 2026-08-27,
  cookie-free, no API key, no PO token, no player JS, no Deno: **0.14–0.37s** for a ~10KB response
  carrying the publish date, description, duration, view count and age status.
  `Date.parse('2009-10-24T23:57:33-07:00')/1000` is **1256453853**, byte-identical to the `timestamp`
  in this bucket's surviving `g10` record for `dQw4w9WgXcQ` and to what `yt-dlp -J` returns — three
  independent derivations of one value, which is the argument for replacing a 15.9s container call
  with a 0.2s fetch.
  **Strictly additive.** `fetchInnertube` is total and answers null on a throw, a timeout, a non-2xx
  or an unusable body, and every field it supplies is optional on both arms of `YouTubeFetch`. So if
  the endpoint changes, or is refused from Cloudflare's egress — which could not be measured before
  shipping, because Access fronts the preview hosts and `npm run deploy` refuses on purpose — the card
  is exactly the card that shipped before it. `yt_innertube_ok` / `yt_innertube_fail` report which of
  the two we got, within an hour of the merge, with nothing at stake.
  Two consequences worth naming. The **age gate now resolves with zero container calls**
  (`LOGIN_REQUIRED` + "Sign in to confirm your age" reproduces `age_limit: 18` exactly; `isFamilySafe`
  is *not* the discriminator and keying on it would mislabel ordinary videos). And the **duration
  arrives on a cold paste**, which makes `settleMux`'s over-ceiling refusal reachable on this platform
  for the first time — it reads `m.duration`, and the only duration used to live in the record that
  was never written.
  The metadata is harvested from a response YouTube reports as `playabilityStatus: UNPLAYABLE`;
  `videoDetails` and `microformat` are populated anyway. That is the one fragile thing here, it is
  documented at the top of `innertube.ts`, and a test asserts it out loud so its removal is loud too.
  `ytDescription` moved to `src/platforms/youtube/description.ts` — two sources for one stored field
  must not clamp differently. Same precedent as `platforms/uploaddate.ts`.
- **Bluesky and Reddit videos had no durable mux path at all**, which the alarm above did not fix
  because it never reached them (`src/worker.ts`, `src/muxpolicy.ts`, `src/muxrunner.ts`). `settleMux`
  returned before its arming loop for any post whose remux carries no `page`, and `prewarmable()`
  answers `null` for `bs`/`rd` — so the two platforms whose video is an ordinary CDN HLS manifest were
  left with exactly one dispatcher: `serveMuxed`, running inside Discord's media-proxy request and
  taking no `ExecutionContext`. When that request was cancelled the container deleted its temp file in
  a `finally` and **zero bytes** reached R2, so the next paste started again from nothing, forever.
  `scheduleMux` had been *built* for this case — its own comment reasons about "a source with no page
  (Bluesky, Reddit)" — and no caller ever handed it one, so that branch shipped dead. Both dispatchers
  now arm: `settleMux` arms a page-less entry and returns it untouched (waiting on it would start
  degrading cards that render fine today), and `/_media/` arms before its own await.
  **The 35s first-attempt delay is wrong for these**, and that is a second constant rather than a
  tweak: 35s is derived from `waitUntil` being cancelled at 30s, which is only true of a `{page}`
  source. A `{video}` attempt is ceilinged by the container's `_mux_tracks` wall of `PROC_TIMEOUT`
  (120s) instead, so firing at 35s would wake the alarm mid-pull, in a DO isolate where `muxInflight`
  cannot dedupe and the R2 head still misses — two concurrent `ffmpeg` pulls of one video on one
  pooled instance, which is precisely the double-mux the 35s comment warns about. `firstMuxDelayMs`
  now holds both derivations, and `MUX_FIRST_ATTEMPT_TRACKS_MS` is 140s.
  The test that should have caught this read `if (jobs.length) assert.deepEqual(...)` — an assertion
  that passes when the feature is entirely absent, which it was. It is unconditional now.
- **A `bytes=-N` range returned the FIRST N+1 bytes** (`src/worker.ts`, `r2Range`). The range regex
  accepts an empty first group, so a suffix range parsed as `start=0, end=N` and the route answered a
  confident `206` labelled `bytes 0-N` containing the wrong bytes. A 416 would have been noticed; this
  was a lie a player would believe. `bytes=-0` is now a 416 and an oversized suffix clamps to the whole
  representation, both without a special case — the existing guard already got them right once the
  arithmetic did. Discord's proxy has not been observed sending one, which is why it survived; an
  ordinary MP4 player looking for a `moov` atom at the tail is exactly who does.
- **A long video can now actually finish muxing.** Reported as "a 10-minute video took nearly ten
  minutes to warm", and the cause was ours, not YouTube's. Every mux was dispatched through
  `ctx.waitUntil` — `settleMux`, the prewarm, and the site's own warm button `/_prep` — and
  Cloudflare documents that as a **hard 30-second ceiling**, shared across every `waitUntil` in the
  same request: *"If any Promises have not settled after 30 seconds, they are canceled."* So the
  container's own 180s wall (`PROC_TIMEOUT + 60`) and the 1500s of video the duration filter admits
  were both unreachable. Three ceilings, and only the smallest was ever real — while `settleMux`'s
  comment claimed the opposite, that the work "runs to completion regardless of who wins this race".
  Worse, a cancelled attempt left **nothing**: the container buffers the whole file before sending a
  byte, writes to a fresh `mkstemp` with `--force-overwrites`, and deletes it in a `finally`, so
  there is no partial R2 object and no resumable `.part`. `/_prep` returns in 23 ms and then gets
  exactly 30 seconds, so re-pressing it was a lottery that discarded 100% of its bytes every losing
  roll. That is the ten minutes.
  The mux now also goes to a **Durable Object alarm** (`src/muxrunner.ts`, `MUX_RUNNER`), whose
  handler gets **15 minutes** — the same budget as a cron trigger or a queue consumer. It fires at
  35s, deliberately after the inline attempt is dead: a mux that finished inline has already written
  to R2, so the alarm's first act is an R2 head check that hits and does no container work at all.
  Firing sooner would race a live attempt and mux one video twice on one pooled instance, which is
  the failure `muxOnce` exists to prevent. Two bounded retries follow (+2 min, +20 min, ~22 minutes
  total) so a reader pastes **once** instead of re-pressing; retrying forever would turn one
  permanently gated video into a scheduled drain on four container slots shared by every platform.
  Addressed by the mux key, so it is also the first **global** dedupe this path has had — `muxOnce`
  is isolate-local and always said so. `MUX_RUNNER` is optional like `MEDIA_RESOLVER`: with no
  binding, behaviour is exactly what shipped before.
  Measured while diagnosing, with the pinned yt-dlp 2026.7.4 and the production argv: a 625 s
  YouTube video selects format 18 as a **single progressive `https` stream, 32,347,090 bytes**. Two
  things follow. `--concurrent-fragments 4` is **inert on YouTube** — there are no fragments — so the
  one flag aimed at long-video latency does nothing on the platform that needs it most. And the same
  360p is available as a DASH pair at **19.2 MiB, 38% fewer bytes**, which under a throughput
  throttle is 38% less download. The `--concurrent-fragments` finding is recorded only, so nobody
  re-derives it; the DASH pair **is now the selector's first arm** — see below.

### Changed
- **YouTube muxes 38% fewer bytes for the same picture** (`container/server.py`,
  `YT_FORMAT_SELECTOR`). The selector's first arm is now the `134+140` DASH pair. It is the same
  640x360 as format 18 — the difference is the H.264 **profile**: 18 is `avc1.42001E` (Baseline, which
  it has always been, because it exists for players that predate everything else) and 134 is
  `avc1.4d401e` (Main, with CABAC and B-frames). Re-measured 2026-08-24 across **27 real videos from
  nine channels**, because the original justification rested on a single long landscape video and that
  overstated it. It is **not a uniform win**: the pair is smaller on 6/7 videos in the 10-25 minute
  band (**-30.6%** aggregate) and 5/7 in the 2-10 minute band (**-30.8%**), but short 202x360 news
  clips run **+26% to +43%** — 1-4 MB files that finish in a second at any bitrate. One long
  regression was measured (`J1WoNuemKOg`, 1365s, +8.4%). Cloudflare's egress measured ~267 KB/s
  against YouTube, and bytes are the only half of that throughput we control, so ~31% off a 10-25
  minute video is the largest lever available short of a PO-token provider — and it is a multiplier
  on the alarm, not a substitute for it. Do **not** condition the arm on duration to claw back the
  short-clip regression: `_mux_page` does not know the duration before it extracts. The honest form,
  if per-video optimality is ever wanted, is a size-aware sort (`-S "res:360,+size"`), which would
  change selection on all ten platforms and needs its own measurement.
  **Verified live in production 2026-08-24** on `wmaB6rEQVRM`: prod served 1,483,540 bytes where
  format 18 is 1,153,011 and the pair is 1,472,505.
  Deliberately **not** done: hoisting `bv*` selects AV1 at 720p and costs ~29% *more*; adding
  `height<=?360` breaks portrait video, where 360 is the width (see the 81s case above). The itag
  literal falls through on every other platform because 134/140 do not exist there — a measured fact,
  not a structural one, since Imgur emits `format_id '0'`. R2 keys carry no format
  (`mux/{refKey}/{index}`), so already-cached objects keep the old bytes; this applies to new muxes.
- **The degraded card is counted** (`card_degraded`, `src/analytics.ts`, `docs/METRICS.md`). The one
  outcome a reader actually sees — the player swapped for a still — was recorded nowhere, and the
  render that produced it went on to fire `ok`. So the dataset affirmatively reported the exact
  first-paste failure this workstream exists to fix as a **success**, twice. `mux_ok` cannot stand in
  for it either: a mux that finishes at T+40s is a `mux_ok` *and* a frozen card, because Discord
  caches an embed permanently in the message it was pasted into. `card_degraded / ok` on
  `blob3='discord'` is the first-paste failure rate, and it is the number that will say whether the
  alarm moved anything — which is why it ships alongside the alarm rather than after it, since a
  before/after with no "before" is not a measurement.
  Named `card_degraded`, **not** `mux_degraded`: `MuxOutcome` is derived from the `mux_` prefix, so
  that name would have joined the mux domain while being emitted through plain `count()` — a real
  `blob3` where `METRICS.md` promises `none`, an unset `double2` where it promises elapsed ms, and the
  operator's `LIKE 'mux\_%'` average quietly poisoned. The type system would not have caught it. The
  over-ceiling rewrite is excluded on purpose: it never calls the container and can never succeed, so
  counting it would put a permanent floor under the ratio.
- **An over-ceiling YouTube video is no longer dispatched to be refused** (`src/worker.ts`,
  `src/platforms/youtube/normalize.ts`). `settleMux` has always refused to mux a video past
  `MUX_MAX_SECONDS`, reading `m.duration` off the remux entry — and on YouTube that arm was **dead
  code**, because `normalizeYouTube` hardcodes `remux: { page }` and carried no duration. Every
  over-ceiling video was dispatched to be told what the 30-day meta record already knew, and with the
  alarm landed that is three container calls across a 22-minute horizon out of a pool of four slots
  shared by ten platforms, for an answer that is final. `withMuxDuration` (split out of
  `withLengthNote`, which also prepends a note that `withDescription` would then refuse to overwrite —
  baking it in at fetch time would have blanked the description on every long card) stamps the warm
  duration onto the entry. **The card is byte-identical**: same still, same "🎬 Too long to play here".
  What it buys is the container slots, and `/_card`'s `muxing` flipping true → false so the fixer page
  stops spinning for 25 seconds about a video it is simultaneously calling too long to play.
  It does nothing on a **cold** first paste — `warm` is a cache-only read — and the duration now also
  carries an upper sanity bound (24h), because a field that decided one sentence on a card now decides
  whether a player exists, and that verdict is response-cached.
- **Mux outcomes are counted, with their duration** (`src/analytics.ts`, `src/worker.ts`,
  `docs/METRICS.md`). The video half of this service had no telemetry at all: our own 180s timeout
  (504), YouTube's gate (502 `"mux failed"`), an empty result (502, *same status*), a cold container
  (503) and a refused store all reached the reader as one bodiless `503 no-store` and left one
  unstored `console.error` behind. `ensureMuxed` read the container's status and then **cancelled its
  error body unread**, throwing away the one account of what went wrong that already existed. Eight
  `mux_*` outcomes now separate them — `mux_timeout` is ours, `mux_gate` is theirs — and `double2`
  carries elapsed milliseconds, the field the incident had no answer for, since nothing recorded how
  long a mux took even when it succeeded. No url ever reaches a counter: the outcome is a fixed enum
  chosen from a closed allowlist of the container's own error strings, never its stderr.
- **A cold Dailymotion, Streamable or Imgur card no longer extracts the same video twice**
  (`container/server.py`, `src/worker.ts`, `RESOLVER_GENERATION` → `g12`). The card's metadata call
  and the video mux were two independent `yt-dlp` runs over the same page, and the metadata one
  already had the answer: it now asks with the same `-f` selector the mux uses — hoisted to
  `YT_FORMAT_SELECTOR` so one rule cannot be written two ways — and reports the format urls it
  picked as `mux_video` / `mux_audio`. The mux hands those straight to `ffmpeg`. Measured 2026-08-22
  on YouTube, which is the worst case: extraction is ~5.0s of player-API round trips plus a Deno JS
  challenge, against a 1.8s download of the same 10 MB.
  The shortcut is **declined** rather than risked wherever `ffmpeg` could not enforce a ceiling
  `yt-dlp` would have — a livestream, a duration over `MAX_SECONDS`, and, stricter than the
  `duration<?N` filter it mirrors, an **unknown** duration (`yt-dlp` still stops such a download on
  `--max-filesize`; `ffmpeg` reading a url has no equivalent stop, and a livestream would run until
  `PROC_TIMEOUT` burned a container slot).
  A resolved format url is bound to the egress IP that resolved it and dies in hours, so it travels
  **beside** the cached metadata record and never inside it — that record is read back for 30
  minutes on Streamable and 24 hours on Dailymotion and Imgur. A warm record therefore carries no
  shortcut and muxes from the page, honestly; this is a cold-path optimisation by design. And the
  mux falls back to the page whenever the tracks fail, which is what makes a url that goes stale
  between the two calls a slower card rather than no video at all.
  YouTube itself gets nothing from this: its cold card (1.70s) answers before the container is ever
  asked, so it was already paying one extraction, not two.
- **yt-dlp is pinned exactly, and a weekly job checks for a newer stable release**
  (`container/Dockerfile`, `.github/workflows/ytdlp-freshness.yml`). Stable releases only, by
  decision: one binary here serves Dailymotion, Streamable, Imgur, Facebook, TikTok and YouTube, so
  an untested build is not one degraded platform but all of them. Expect most Mondays to be quiet —
  stable ships sparsely (2026 gave five releases, with an eleven-week gap between March and June) —
  and read that as the job working rather than failing. What it buys is that a release is picked up
  within a week instead of never. A test refuses a pre-release pin, because when the YouTube
  failure below was first triaged the only known remedy looked nightly-only, which made nightlies
  tempting to slip in. The fix that landed needs no nightly — see below. It read `>=2025.1.1`, which looks like "always current"
  and guarantees the opposite: a floor is resolved once, when the layer is first built, and Docker
  reuses that layer forever after because the instruction text never changes. The running version
  froze on the day the image was first built and nothing recorded which version that was. Dependabot
  did not cover it and could not — it watches `npm` and `github-actions`, and no ecosystem parses a
  pip package named inside a `RUN pip install` line. Rewriting the pin is what invalidates the cached
  layer, so the exact version IS the update mechanism rather than paperwork around it. Four tests now
  hold the pin exact, keep the `[default,curl-cffi]` extras through any bump, check that the
  workflow's extraction still matches the line it edits, and refuse a deploy step in that job.
  *(Corrected 2026-08-29: the layer-caching mechanism in this entry is wrong. Every merge builds the
  image from scratch in a Workers Builds runner off a fresh clone, so a floor would FLOAT rather than
  freeze. The conclusion — pin exactly — survives, for reproducibility and a one-line revert. See the
  Dockerfile and the Documentation section of 1.12.0.)*
- **The media container now sleeps after 5 minutes idle instead of 10.** Measured from the bill:
  3.24M instance-seconds awake against 42.9k vCPU-seconds of work — a 5.3% duty cycle, so 94.7% of
  what was billed was an instance with nothing to do. With one dispatch every ~4.3 minutes per pool
  slot, a ten-minute idle timer could never fire, and the four slots stayed up ~43 hours a day
  between them. Those seconds bill THREE times — container memory, container disk, and Durable
  Objects compute duration, because a Container is a Durable Object underneath — which came to
  $21.23 of a $21.63 cycle against $0.41 of actual work. This is instance DURATION and not the
  instance COUNT the 2026-07-24 pooling fix was about: slots return to the pool sooner, so
  exhaustion gets strictly less likely. The cost is more cold boots, concentrated in quiet hours
  where the long gaps are.

### Fixed
- **Every new YouTube video was a card with no player.** yt-dlp 2026.7.4 defaults to the player
  clients `android_vr, web_safari`, and YouTube began enforcing GVS PO tokens on `android_vr` roughly
  two weeks after that release shipped, so googlevideo answered the format urls it handed back with
  HTTP 403. Metadata was untouched, because it comes from the Innertube `player` endpoint which needs
  no token — which is exactly why this hid for weeks. Right title, right channel, right upload date,
  right view and like counts, and no video. `container/server.py` now names the clients rather than
  leaving them to yt-dlp: `player_client=web_embedded,tv_simply,mweb`. `web_embedded` leads because it
  is the only working client that keeps the full format ladder — 19-23 formats, the same count the old
  default returned — while `tv_simply` and `mweb` expose exactly one each and follow as fallbacks. The
  list REPLACES yt-dlp's default rather than extending it, so `default` or `android_vr` appearing
  anywhere in it re-breaks this while looking like hardening; both are refused by name, with a test.
  `--extractor-args` is keyed by extractor and this one is scoped `youtube:`, so Dailymotion,
  Streamable, Imgur and Facebook go down untouched paths.
- **The YouTube fix was verified on Cloudflare egress after it shipped**, which is the measurement the
  change could not make beforehand and the reason it merged saying so. Container image 109 to 110: the
  same video that returned HTTP 503 and 0 bytes on 109 returned HTTP 200 and 12,714,536 bytes of
  `video/mp4` on 110, and two further never-muxed ids returned 3,862,327 and 32,347,122 bytes, each
  with `ftypmp42` at the head and `og:video` on the card. The stable channel is enough; the nightly
  question does not need reopening.

  Two things about this cost most of a night and are worth carrying. A `container/` change does not
  take effect until the image is rebuilt, and only `wrangler deploy` rebuilds it — promoting a branch
  version to production ran the NEW Worker against a two-day-old container and looked exactly like the
  fix failing. Confirm `wrangler containers info` reports a new image digest before believing any
  result. And the FIRST request after a container deploy can 503 on a cold start: one id did precisely
  that, then returned 32 MB on retry. Retry once before calling a mux failure.
- **An Imgur gallery could render a complete card for somebody else's photo.** Measured end to end
  2026-08-16: `/im/gallery/joNxn`, `/im/gallery/sh0Z6` and `/im/gallery/UwEpm` each returned a
  validating HTTP 200 card for AN UNRELATED IMAGE. Imgur's album and legacy-image namespaces share
  ids — `aZVXS` names both a 2013 seven-image album and an unrelated 300x415 jpeg — and the endpoint
  walk advanced on any miss, so an album that answered 200 but empty fell through to whatever the
  other namespace had under that id. Nothing reported it: the card had a picture, a byline and a
  link, and every field validated. The walk now advances only on a clean 404, which is the one
  answer meaning "no object of this kind carries that id"; an empty album, a throttle, a 5xx and an
  unparseable 200 all stop and render the neutral "couldn't load" card instead. A 404 still advances,
  because `ck58rrX` and `E7HlM3Q` are real gallery posts that only the `media` leg can answer — that
  leg is load-bearing and the tests now say so.
- **Imgur's own url shape rendered "Not found".** `imgur.com/gallery/{seo_title}-{id}` — the url the
  share button, the address bar and our own converter page all produce — was matched against the
  5-7 character id regex as a WHOLE path segment, so it never routed, and a live 7-image album
  unfurled as a failure card. The id is the last `-` component, confirmed against
  `post/v1/albums/{id}`'s own `seo_title` field rather than inferred from a hyphen count. Both
  `/gallery/` and `/a/` take it, and the slug is dropped rather than carried, so the two spellings
  share one cache entry and `IM_ID` stays as tight as it was. The bare form still resolves, which is
  why every fixture here has one and why the suite stayed green while the shape people actually
  paste was broken. `/t/{topic}/{slug}-{id}` remains unrouted.
- **The Twitter guest token is reused off Cloudflare too.** The activation was cached with
  `cf: { cacheEverything, cacheTtl }`, a Cloudflare-only fetch option that is silently ignored
  elsewhere, so a self-hosted instance minted a fresh guest token on every cold card. A process-local
  memo with a shared in-flight promise now collapses that to one activation per two hours, and a
  concurrent burst on one tweet to a single activation. Failed and thrown activations are not
  memoized, so one 503 cannot kill the guest path until the TTL lapses.
- **The mux buffering fallback is bounded.** Without `FixedLengthStream` (i.e. anywhere but Workers)
  every muxed video was read whole into memory; the container's own ceiling is a 375 MB output with
  four pool slots, so the real bound was ~1.5 GB resident. Now: stream into a store that implements
  the new optional `MEDIA_CACHE.putStream`, else buffer under `MUX_BUFFER_MAX` (64 MB default,
  env-overridable), else refuse to store and degrade that view to the cover still.

### Documentation
- The `CacheLike` seam a self-hoster implements is now a written contract. Honour
  `cache-control: max-age`, hand back a readable body, be shared across processes, never reject, key
  on the exact string, with a test that fails if the worker starts calling a third method.
- `docs/SELF-HOSTING.md` rewritten around what landed, with the stale `src/` line citations corrected
  (several predated this change) and the suite re-measured: 1343 tests, 0 failures, 30.6-34.7 s on a
  residential macOS laptop, Node v26.5.0.

---

## [1.10.1] - 2026-08-14

### Changed
- Every word a reader sees was rewritten to drop the tells of machine-written
  prose: em and en dashes, curly quotes, boldface applied out of habit, and
  headings in Title Case. This covers the converter page's on-screen copy and
  its card metadata, the README, `CLAUDE.md`, `NOTICE.md`, the container README,
  all five `docs/` files, the published OpenAPI document, and the contributor
  docs, issue templates and both social-preview cards.
- Three rendered card notes lost their em dash, because they are copy rather
  than comments: the YouTube length note, the YouTube age note and the PeerTube
  live note. Each is pinned by a test that matches on a prefix, so the wording
  ahead of the dash is unchanged.
- The 27 changelog version headings now use the hyphen form Keep a Changelog
  specifies rather than an em dash, numeric ranges use a hyphen or the word
  "to", and the `METRICS.md` "Read against" column says `nothing` where it used
  a bare em dash to mean it.

Untouched on purpose: the curly quotes in the character class at
`src/translate.ts:315`, which strip a model's surrounding quotes off a
translation and are a matcher rather than copy; the em dash in the translation
prompt below it, since editing a prompt is a behaviour change; and every
source-code comment, which is an engineering record.

## [1.10.0] - 2026-08-12

### Added
- **A published OpenAPI spec.** `public/openapi.json` (OpenAPI 3.1), served at `/openapi.json`, with a
  derive-and-compare drift test that checks it against the code that answers rather than against the
  prose. It was the most conspicuous remaining gap against the rival embed fixers.
- **Bluesky profile embeds.** `/profile/{handle}` renders an account card: display name, bio, avatar,
  follower/following/post counts and the join month. Built for one platform on purpose, measured from
  Cloudflare egress, x.com and tiktok.com already hand a crawler a complete profile card, so a route
  for them would duplicate what Discord draws, and instagram.com is walled from this egress entirely
  (HTTP 429, zero bytes, against a same-minute post-page control at 254 KB). Bare `/{handle}` and
  `/@{handle}` stay choosers: a handle names an account on two sites at once.
- **An outage detector.** A half-hourly cron renders one known post per platform through this worker's
  own handler and counts whether a real card came back, asserting on CONTENT because every interesting
  failure here answers HTTP 200. `/_smoke` runs the same checks on demand. Added because Facebook
  embeds were broken for up to a week and the way it was found was the owner pasting a link.

### Fixed
- **A walled TikTok share code was published as `not_a_post`**, meaning "that url resolves to something
  other than a post", about a post that demonstrably exists, on both `/_api/v1` and the converter preview,
  while Discord drew the correct 🔒/🔞 card. Its two siblings were closed in the same pass: a deleted
  post now answers `fetch_fail` with the platform it proved rather than `platform: null`, and a code
  TikTok does not claim answers `ambiguous` with the same chooser the render arm offers.
- **Facebook post coverage**, measured across 35 real urls and repaired where the count was hiding
  wrong cards rather than absent ones. See the Facebook section below.
- An uncaught **HTTP 500** on `/lm`, `/ms` and `/pt`, found by the router differential run over
  1,115,451 paths while proving the profile route shadows nothing.

### Facebook coverage, and the rest of this release

### Facebook post coverage, measured rather than assumed

The whole platform was sampled from Cloudflare egress on 2026-08-12: 35 real public post urls across
seven pages, four url shapes and at least twelve years of post ages, read through
`wrangler dev --remote`. The og: page surface answers 17 of the 35, the embed plugin answers 33, and
neither covers the platform alone. The plugin carries every `/photo/?fbid=` url, which the page
surface meets with a 438 KB login wall, and the page surface carries the two posts Meta refuses to
embed. Every url, both readings and the reproduction command are in
`docs/research/2026-08-12-facebook-post-coverage-from-cloudflare-egress.md`.

#### Fixed
- A post with a caption and no picture drew the failure card on both surfaces at once. The reported
  url is `/NASA/posts/1304655294363177`, a live public NASA post: its page carries `og:title` and
  `og:description` and no `og:image`, and Meta's plugin answers "This Facebook post is no longer
  available" for it. `facebookCaptionCard` reads that page for its words, runs after the plugin so it
  can never take a picture card away from one, and is counted as `caption_recovered`. Two of the 35
  sampled urls are answered by it, and it runs on one of them: the plugin answers the other first.
- A five-photo post rendered one photo. The `<img>` tag bound was sized against the signed CDN query
  at 1400 characters, and the tag is really sized by Facebook's auto-generated alt text, which
  transcribes the words inside the picture and is emitted twice. Measured across the 37 photo tags in
  the sample: 531 shortest, 1076 median, 1541 longest.
- A photo whose size is spelled `style="width:364px;height:364px"` rather than in width and height
  attributes shipped at 0x0, which `render/mastodon.ts` turns into an attachment with no
  `meta.original`, a picture Discord has been observed not to draw at all. Two of the 37 tags, both
  on single-picture posts.
- Every card off the og: page read `Name (@Name)`. `fbAuthor` emptied `handle` only on the packed
  `… | Facebook` title shape, and no og:title in the sample ended that way; on a reel-shaped title it
  doubled a view count and a whole caption with it.

#### Known
- Twelve of the 33 plugin cards carry no picture, because the plugin puts a link share's preview
  image on `external.*.fbcdn.net` and a video post's poster in the `t15.` bucket while the parser
  accepts only the `t39.30808-6` photo bucket. Invisible today because the og: page supplies an
  `og:image` for most of them and runs first; visible the next time Meta walls that surface, as it
  did for a week in August. The research note records what it would take.

---

## [1.9.1] - 2026-08-09

Five merges shipped under 1.9.0 without a bump. Nothing
forces one: `landing-convert.test.mjs` pins the site badge to package.json, so the four places the
number lives cannot disagree, but a release that changes none of them still looks like the last one
from the outside. Patch, because none of it is new public surface: the JSON API is unchanged.

Two upstreams changed under the service inside eight days, and three of these five are the answer to
that rather than to anything in the repo.

### Facebook posts stopped rendering, and now read off the embed plugin

#### Fixed
- Every spelling of a post (`/share/p/{code}`, `story.php`, `/{page}/posts/{pfbid}` and
  `/{ownerId}/posts/{id}`) answered the failure card. Meta began requiring a login for the post
  surfaces from datacenter egress: measured 2026-08-08 from Cloudflare, the permalink returns 324,247
  bytes with NO og: tags in four different client shapes, and `/share/{code}` and `mbasic` both
  redirect to a login wall. The same urls from a residential IP built the full card, which is what
  made it look like a code defect.

  `facebookPluginCard` reads the byline, caption, canonical and photos out of `/plugins/post.php`,
  Meta's own embed endpoint, which is not behind that wall. It runs after the og: surface, so a post
  that still renders the richer way keeps its multi-image gallery, and it costs one request only on a
  path that has already failed. Counted as `plugin_recovered`.

  Coverage is not universal: some fragments do not server-render, and those still land on the failure
  card. `/{page}/photos/{slug}/{id}/` remains unrouted and is unaffected by this.

### TikTok short links on the direct-media host

#### Fixed
- `d.<host>/t/{code}` bounced a person to tiktok.com instead of serving the file, while
  `d.<host>/@user/video/{id}` served it. `renderPostRoute` short-circuits a direct-media origin and
  its comment claims that covers every route because they all converge there; a shortlink does not
  converge, since a short code caches in its own namespace and renders in its own arm. The check is
  repeated there now. `prep.test.mjs` had pinned this rule for Reddit share links, which do reach
  `renderPostRoute`; the TikTok twin is written now.

- The converter page put a share code back into a resolved link. The resolution lived in the result
  field and nowhere else, so switching domain or toggling media-only rebuilt the link from the raw
  input, and `prepped` then refused to resolve it again. That is a privacy regression rather than a
  cosmetic one: the shortlink arm resolves the code precisely so the pasted link does not carry it
  onward, and someone who swaps the domain expects it to stay sanitised.

### A cold YouTube paste answered a crawler in thirteen seconds

#### Fixed
- YouTube links did not embed until they had been warmed on the converter page. Measured against
  production on four cold videos: the card took 5.14-5.18s and the activity document 8.19-8.29s,
  against a crawler that leaves at 3-4s. Every budget involved was individually argued: the head
  spends `HTML_DEADLINE_MS` on the mux, the activity route spends `MUX_WAIT_API_MS` on the mux,
  `META_WAIT_API_MS` on the date and a slice on the translation, and each was tuned to make the card
  right on the first paste. Together they made it absent.

  The wait bought nothing: a warm mux is a 300ms R2 head, and a cold one measured ~5s for a
  60-second Short, so no budget a crawler tolerates was going to catch it. `MUX_WAIT_BOT_MS` (1500)
  now caps the crawler-facing seams; measured after, the card is 0.36-1.84s and the activity document
  0.23-1.63s. `/_api/v1` and `/_card` keep the long budget: a human is watching a spinner there, and
  that surface is what warms a link deliberately.

  A first paste now shows the thumbnail rather than a player, without counts, and dated the epoch,
  the Mastodon document always emits a `created_at`, so an unknown date renders as 1 January 1970.
  Every later view has all three. Suppressing the field is the real fix and is deliberately not
  attempted: a document missing a required field may be rejected outright, which reintroduces exactly
  the defect this removes.

### An Instagram reel older than an account's last twelve posts rendered as a still

#### Fixed
- instagram.com/reel/DZxLuleoEoC/ rendered a frozen image while the same reel played on a rival. The
  account feed is the only video recovery this platform has, and it returns twelve posts and ignores
  `count` (measured: `count=50` still answers twelve, with `more_available: true`). Every post older
  than an account's last twelve was unrepairable, and nothing said so.

  The reporter's own observation located it: ten other Instagram videos worked the same day, which
  rules out the account, the format and the egress and leaves age. An earlier reading of this as a
  datacenter block was wrong and was discarded, because a control reel from the SAME account renders video
  from production. Instagram's `/embed/captioned/` answers `EmbedBrokenMedia` for both that control
  and the reported reel, so the embed is not what separated them.

  The recovery now follows `next_max_id`. Measured from Cloudflare egress, the reel is on page three
  carrying `video_versions` 3, 720x1280 and `like_count` 113,385, so pagination is not gated the way
  the surfaces around it are. The walk stops the moment it finds the post, so a recent post still
  costs one request.

  Bounded by pages AND by wall clock, because a page count is not a latency bound: a cold crawler
  card went 2.57s with no walk to 4.21s with one, and 3.79s once the clock was added. A page is
  ~0.8s and ~530 KB. An unfurl that answers too late is not a late card but no card, which would be
  worse than the bug being fixed. On a slow account the walk stops and the answer is page one, which
  is exactly what this path returned before.

  The copyright-recovery path is wired the same way, for the same reason.

### Diagnosis

#### Added
- `translate_pending` counts a translation that loses its deadline race. `translated` and
  `translate_fallback` fire only when one arrives, so the state that makes a post render uncached on
  every unfurl left no trace, and Workers Logs are off on purpose, because they persist the pasted
  url. Read as a ratio against its siblings; `docs/METRICS.md` carries the query.

- `docs/METRICS.md` gained a runbook for a "no card" report, written after one that self-healed
  before it could be diagnosed. It records the order to check things, the two mistakes that cost an
  afternoon (comparing posts that differ in more than one variable, and reasoning from a laptop about
  behaviour that depends on the caller), and what cannot be answered after the fact.

- `container/README.md` documents running the resolver outside Cloudflare, verified by running
  `server.py` on a stock interpreter: `/health`, the `X-Resolver-Secret` gate and every SSRF refusal.
  Three traps are recorded with it, including that `--platform linux/amd64` is load-bearing on an ARM
  host and that the listener is IPv4-only.

#### Corrected
- `tiktok/normalize.ts` recorded the aweme endpoint as serving datacenter egress 12,550,214 bytes of
  video. Measured 2026-08-09 from Cloudflare, it returns 33,227 bytes of `text/html`, a 404 page at
  HTTP 200, byte-identical across three videos and both user agents, while residential still gets
  the video. Discord's proxy is not Cloudflare and still plays these, so TikTok video is not broken;
  what it rules out is ever proxying or muxing that video through the Worker or the container.

---

## [1.9.0] - 2026-08-04

Five pieces of work in one release. Merging them back-to-back would have raced five Workers Builds
deploys against each other, where the older commit can win. Only 1.9.0 ever existed as a version.
Minor, because the public JSON API is new surface area. Everything else is a fix or a document.

Two things do not take effect on merge. The YouTube date fix stays inert until the container image is
rebuilt and redeployed. The age-gate pools do nothing until the secrets are filled. This release
fills none of them; filling `IG_ACCOUNTS` or `YT_ACCOUNTS` now takes effect, and `X_ACCOUNTS` still
does not.

### Age-gate account pools: filling one now takes effect

#### Fixed
- Filling an account pool now takes effect. A month-old answer had been hiding it. 1.8.0 bumped
  `RESOLVER_GENERATION` to g10 so no cached gate verdict predated the cookie code, which retired the
  records written before that deploy and nothing written after it and before an operator fills
  `YT_ACCOUNTS`. Those are g10 records too, from a jar-capable build with no jar to send, and each
  one persisted `age_limit: 18` for 30 days. No pool has ever been filled, so that's every record.

  Filling the secret wouldn't have healed any of them. The warm record is returned before a container
  call is considered, its validity test ignores `ageLimit`, and re-pasting reads the same record, on
  every colo, for up to a month, 🔞 note and all.

  A meta record now carries whether the extract that produced it was logged in. A gated record that
  wasn't is refused as soon as a jar is available, and the next view re-extracts it. That is a
  conditional invalidation, with no second generation bump. A deployment with no pool invalidates
  nothing, so this is free to merge and free for a fork. Ungated records are never touched, and you
  can fill a secret without timing it against a deploy.

- `pool_unused` no longer counts a working pool as dead on the day it is filled. The YouTube arm
  counted any positive `ageLimit` while a pool was set, on the stated grounds that the g10 bump made
  every readable record post-jar. That was false for the records written between the g10 deploy and
  the first filled secret, which never had a jar to send, and those are the ones an operator meets on
  fill-day. The first thing a correctly-configured pool did was tell its owner to rotate it. The read
  predicate `ytMetaUsable` now refuses a gated record carrying no jar flag while a jar is available.
  A tick of the counter now means what it says: the jar was spent and the wall held.

- The `Env` comment describing these bindings said they were inert. It claimed all three secrets were
  "READ BY NOTHING YET" and that setting them "CHANGES NOTHING TODAY", and it pointed at a
  `credentialSeamArmed` that no longer exists. A later paragraph in the same comment narrowed the
  claim correctly, to `X_ACCOUNTS` alone. That comment is what an operator reads before deciding
  whether a throwaway account is worth spending on a secret, and it was answering no. It now records
  that `IG_ACCOUNTS` and `YT_ACCOUNTS` are spent inside the container, on both the mux and the `-J`
  meta call, and that `X_ACCOUNTS` is not.

### Operator metrics, and Workers Logs turned off

#### Added
- `docs/METRICS.md`, the read path for the 49 counters this project has been writing and never
  reading: the dimension map (`blob1` platform, `blob2` outcome, `blob3` client class, `double1`
  always 1), a line on each counter and on which other counter it is only meaningful beside, eight
  Analytics Engine SQL recipes, and the Grafana pointer.

  Three traps come first, because each answers with a number and no error. `COUNT()` counts stored
  rows and not events, so every query uses `SUM(_sample_interval)`; read-time sampling responds to
  query cost, and a naive count under-reports more the further back the window reaches, which reads
  like a traffic decline. The dataset was renamed on 2026-08-01, and a rename doesn't migrate rows,
  so it holds about two days and every seven-day example returns a partial window that looks like a
  collapse. The counters stack by design, `fetch_fail` is a superset, and a total across outcomes is
  not a request count.

  `media_hit`/`media_miss` carry two meanings under one name (the `/_media/` route and the `d.`
  host). `translated`/`translate_fallback` are hardcoded to client `discord` while also being emitted
  from the converter preview, so those rows are mislabelled and must never be split by client.
  Neither is fixable from a query.

  There is no `/_metrics` endpoint. The `AE` binding is write-only and reading goes through the
  account-level SQL API, so an in-Worker route would hold an account-scoped Cloudflare API token on
  the public edge to serve data an operator can already get from a laptop. A public one would also
  publish `pool_unused`, a live readout of whether the age-gate pools are loaded and still passing,
  which is a feedback signal for the enforcement teams the pools exist to get past. The README row
  says "documented queries, no scrape endpoint", and doesn't claim Prometheus.

  Nothing in the file has been run against the live account. The unknowns it lists are whether any
  row is sampled, whether the old dataset still holds rows, the default row limit, identifier
  quoting, and write-to-query visibility lag.

- Workers Logs are off. With `observability` enabled, Cloudflare persisted an invocation log per
  request for seven days, each carrying the whole request url (on this Worker, the post somebody
  pasted) with the client IP, user agent and geolocation beside it. `src/analytics.ts` meanwhile
  says "no URLs, no post IDs, no IPs, no verbatim user agents… we have nothing to leak", and cites
  TwitFix dying over a public log of processed urls. Turning the setting off makes that claim true
  again, and the comment now records that the function and the deployment setting are one decision.

  The four `console.error` calls still run and nothing stores them, so a failure that happens while
  nobody is tailing can't be reconstructed afterwards. `wrangler tail` covers live debugging, the
  dashboard charts are a separate product and unaffected, and Analytics Engine is untouched.

#### Fixed
- `CLAUDE.md` claimed a safety net that does not exist. It said adding a `PostRef` kind is caught by
  "a sweep test that fails until you do". The refkey round-trip tests are hand-written lists
  (`test/refkey.test.mjs:177`) deriving nothing from the union, so a forgotten kind is still silent,
  which is the `fb:group:…` defect the paragraph is about. The `Route` kind sweep in
  `test/prep.test.mjs:791` is derived and does fail loudly. The guide now tells the two apart.

### A public JSON API

#### Added
- A public JSON API, `GET /_api/v1?url=<the post url>`. It was the most conspicuous omission in the
  comparison table, where two rivals publish one and FxEmbed ships OpenAPI specs. No key, no signup,
  CORS open, and it answers for every site the cards cover, including short links and share codes,
  because it's the same code path a pasted link takes. Documented in `docs/API.md`.

  It shares its pipeline with `/_card`. Fetching, waiting for the mux, waiting for the translation
  and applying the per-platform overlays live in one function, `describeTarget`, and the two arms
  differ only in how they serialise the result. This project's most repeated defect is teaching one
  surface something its twin did not learn: the translation went to the og head and not the Mastodon
  spoof, the YouTube date was warmed by the activity route so every preview showed 1970, and the
  quote block the card drew was one the preview did not.

  The decisions the contract locks in:
  - Every answer about a post is HTTP 200, including the gates, with `ok` and `error.code` carrying
    the verdict. The upstreams this Worker reads answer 200 with a login wall and 500 with a good
    JSON error, which is where "assert on content, never on status" comes from. The 4xx answers are
    about the request and never the post: 400 for a missing or unreadable `url`, 405 for a write verb.
  - The host in `url` is ignored, so an ambiguous path stays ambiguous. Reading it as free
    disambiguation for `/gallery/abc` would make the answer depend on a caller-controlled string, on
    a service where a hostname is also something the Worker fetches. The answer names its
    `candidates` and the caller re-asks with a two-letter prefix.
  - An unknown upload date is `null` and never the epoch. `/_card` serialises `new Date(0)` because
    the page draws a note beside it. An API consumer would sort by it and file every dateless post
    in 1970.
  - A count that is zero, `NaN`, `null` or a string is omitted, and an absent key says the count is
    unknown. Counts come out of the post cache, which validates three fields and not these, and
    upstreams use `0` for a genuinely uninteracted post and for a count they withhold.
  - Failures and incomplete answers are never cached. A private account goes public and an age gate
    lifts. `loadPost` already refuses to cache a null Post so the next view heals, and a max-age on
    the envelope would put that staleness back at an edge this Worker cannot invalidate.
  - `color`, `stats` and `byline` are absent: a stripe colour, a pre-rendered stat line and a
    pre-assembled author line are the card's answers, and a consumer drawing its own presentation
    wants the facts underneath them.

  An adversarial review before merge caught six things, all fixed here:
  - The fediverse form was undocumented, and four of the seventeen sites did not work as written. For
    Mastodon, Misskey, Lemmy and PeerTube the instance host is part of the post's identity and lives
    in the path, so `?url=https://lemmy.world/post/123456` answers notfound while
    `?url=/lemmy.world/post/123456` returns the post. The claim "all seventeen sites" was false, and
    the one paragraph a fediverse reader would have reached said the opposite of what to do.
  - A CORS preflight ran the whole pipeline and then failed. `OPTIONS` fell through to the fetch, the
    mux wait and the container call, and answered without `access-control-allow-methods`, so the
    preflight failed and the real GET never fired. Any consumer sending a custom header is
    preflighted. `OPTIONS` is now answered in place, and write verbs get a 405 before anything is
    spent.
  - `media[].still` was added. `muxing` covers only the video that is still coming, and a video past
    the conversion ceiling answers `muxing: false` on a cacheable 200 carrying a plain `image`. The
    only trace a video existed was an English sentence inside `text`, and a contract shouldn't ask a
    consumer to parse prose.
  - `text`, `width`, `height` and `quote.text` were published unguarded while `title`, `author` and
    `counts` beside them were defended. A cached record holding `text: {...}` or `w: '800'` went out
    verbatim, on a cacheable 200, under keys the docs type as a string and a number.
  - The ambiguity escape hatch pointed at a path that does not resolve. The message said to re-ask as
    `/im/gallery/abc`, and Imgur ids are five characters or more, so a caller following it verbatim
    got the same dead end twice. `candidates` is now documented as the sites a path could belong to,
    with no promise that every prefix resolves.
  - Two claims in `docs/API.md` were wrong about this Worker. Byte-range support is real for
    converted video out of R2, and absent for the images, avatars, posters and already-progressive
    video that 302 to the platform's CDN. The rate-limiting paragraph asserted a zone rule the
    repository cannot see. It now says there is none in the source, and that a self-hoster gets none.

  A second review, this one of the documentation, caught four more:
  - `platform` and `canonical` were absent rather than null on the three request-level errors,
    because those call sites pass no extras while the failure arm passes both. One envelope, two
    shapes, and the reference described only one of them. Fixed in the code.
  - Two error rows described behaviour the router does not have. A string that merely does not name a
    post is neither `unparseable` nor `notfound`, and one unrecognised path segment is the ambiguity
    chooser's own shape, so it answers `ambiguous`. The same false sentence was sitting unasserted in
    a test comment, which is how it got copied into the reference. It is now pinned.
  - `/_api/v2` is an unrouted path: HTTP 404 `text/plain`, not a JSON `notfound`. A client assuming
    every reply is JSON fails at the parse, with no code to read, and the reference now says so.
  - The field table had no types, and `media[].width`/`height` had no row at all. It now gives type,
    nullability and always-present for every key, plus the seventeen platform codes with the site
    each one means, a section on non-JSON responses, and the request budget, so you don't set a
    five-second client timeout on a path that can legitimately take longer.

#### Fixed
- `/_card` published media urls that could address the wrong bytes. It computed them as
  `mediaOf(post).filter(usable).map((m, i) => …)`, so the index was a position in the filtered list,
  while `/_media/` resolves an index against the unfiltered one (`pickMedia` reads `mediaList(post)`,
  and the media route's own `findIndex(usable)` returns an unfiltered position). The two agree only
  while every entry is usable, which is nearly always, so the defect stayed latent. Put one unusable
  entry in front of a usable one and every url after it is off by one: the payload describes entry N
  and the bytes at that index belong to entry N+1, or 404 past the end.

  Found while building the API on the card's shape, and fixed rather than documented, because the API
  publishes those urls as a contract. Both surfaces now pair each entry with its unfiltered position,
  and the test now drives the real `/_media/` route, since the claim is that the url serves those
  bytes.

### The YouTube upload date that arrives as `upload_date`

#### Fixed
- YouTube cards showed the 1970 epoch on a cold paste, intermittently, and the retry that would have
  healed them was refused. Reported as "occasionally, when cold", and narrowed by the owner
  confirming that a warm view of the same link is correct.

  yt-dlp builds `timestamp` only from a timezone-bearing microformat, and several of its YouTube
  player clients don't carry one. On those responses the `-J` dict comes back complete, with title,
  description, counts, duration and `age_limit`, and with `timestamp: null` and
  `upload_date: '20091025'` sitting beside each other. `container/server.py` forwarded `timestamp`
  and never `upload_date`, and the Worker required a numeric `timestamp` to accept a record at all,
  so it discarded the whole dict. The description, the counts and the age flag went with the date,
  because one validator gated the entire record. Which client answers varies per request, so the same
  video was fine on one paste and epoch on the next.

  Nothing was written to R2, so there was no record to self-heal from, and `metaAttempt` then made it
  worse. It reads a resolved null as the extract's own verdict, meaning the page is gone, blocked or
  unextractable, and negatively cached the id for `META_FAIL_TTL_MS` (60s per isolate). The
  validator's own rejection was filed as evidence about the video, and the re-extract that could
  have fixed the card was refused for a minute. The docstring four lines above `metaAttempt` names that
  exact split as what the code exists to prevent.

  Three changes break the chain:
  - `container/server.py` forwards `upload_date` alongside `timestamp`.
  - `uploadDateFrom` learns yt-dlp's compact `YYYYMMDD` shape, normalised to explicit UTC midnight.
    `Date.parse('20091025')` is `NaN`, and `Date.parse` on `YYYY-MM-DDT00:00:00` without a zone is
    local time, which is a whole day out west of Greenwich. The zone is spelled out and asserted.
  - An answer with no usable date in either field is now thrown instead of returned, so
    `metaAttempt`'s rejection arm, which does not mark and says so, is the one that runs.

  `timestamp` is still preferred where it exists. It carries a time of day and `upload_date` is a
  bare day. No card renders a clock time, so nothing shows a wrong hour, but the record is stored for
  30 days and a consumer may sort on it.

  A dateless answer is still not cached. Keeping the description and counts for 30 days would mean
  never asking for the date again, and the degraded answer would be the one that sticks.

#### Notes
- No `RESOLVER_GENERATION` bump. Every record already in R2 carries a numeric `timestamp` and stays
  correct, and the broken case wrote nothing, so there is nothing wrong to retire.
- This needs the container image rebuilt and redeployed to take effect. The Worker half is inert
  until `_meta_page` sends `upload_date`, and a pooled instance keeps the image it booted with until
  it recycles.
- There is still no counter for this failure. With Workers Logs off it is visible under
  `wrangler tail` and nowhere else. A counted outcome is the follow-up, not bundled here because
  adding an `Outcome2` member is not test-enforced and wants its own change alongside
  `docs/METRICS.md`.
- One thing is unverified, and it matters for fill-day. With a cookie jar present, yt-dlp switches to
  its authenticated client set, and the client carrying the timezone microformat may not be in it.
  That would make filling `YT_ACCOUNTS` more likely to produce an epoch date, not less. Measured
  residentially only, never from the container's own egress.

### Pre-flight findings, settled before the merge rather than after

- Merging rebuilds the container image, with no manual step. `wrangler.jsonc` points `image` at
  `./container/Dockerfile`, and Workers Builds' deploy command is `npx wrangler deploy`, which builds
  and pushes it. Confirmed in this repo's own build logs, which show
  `Building image fxeverything-mediaresolver`, a registry push and `Modified application`.
  `container/README.md` said to run `wrangler deploy` by hand, which CLAUDE.md forbids and which
  would overwrite whatever the build shipped. Corrected, and it now also records that a preview build
  runs `wrangler versions upload` and does not build the image, so a container change is untested by
  the preview and lands only on merge.

- `RESOLVER_GENERATION` stays `g10` even though `container/server.py`'s output dict changed, contrary
  to the rule at the top of its own log. There are no stale records to retire, because the defect
  made the Worker write nothing, and warm instances are replaced by the deploy's own gradual rollout.
  Bumping would discard up to 30 days of good dates, descriptions and counts across yt, fb, dm, st
  and im to shorten a few minutes of ambiguity. The reasoning sits in the code beside the constant,
  because an unbumped generation next to a container change reads as an oversight. The test it gives
  is what a stale record would say, not whether `container/` was touched.

- A cookie jar doesn't make the epoch bug worse, but a Premium account would. The earlier warning is
  refuted at yt-dlp's source: `web_safari`, the only client carrying the timezone-bearing microformat,
  sits in the same position of both the anonymous and the ordinary logged-in client lists. Premium
  selects a set that drops `web_safari` entirely, turning an intermittent missing date into a
  permanent one. `docs/CREDENTIALS.md` now says never to use one, and that an expired jar is worse
  than no jar, because yt-dlp decides "logged in" from cookie presence rather than validity.

### Self-hosting off Cloudflare is not blocked

#### Added
- `docs/SELF-HOSTING.md`, and a correction: running this off Cloudflare is not blocked. The README
  said "❌ Workers only" and an earlier internal assessment said it was not achievable. Both were
  wrong, and the evidence was already in the repo. The whole test suite (1185 tests) runs in stock
  Node importing `src/worker.ts` directly, `handle(req, env, ctx, deps)` is already an adapter entry
  point, six of the eight Cloudflare surfaces are declared in `Env` as hand-written structural
  interfaces, and `container/` is a stock Python HTTP server with no Cloudflare API surface
  in it at all. What's missing is an adapter and somebody to run it.

  No code ships here. The doc states what is true today, what replaces each binding and what degrades
  without it, and phases the work. It also names two things that must change before a self-hosted
  instance is exposed: a self-hoster's own hostname is not in `OWN_HOSTS`, and the Worker half leans
  on Cloudflare's egress in a way that matters more elsewhere.

  The open question is egress IP. Several fetchers were measured specifically against Cloudflare's
  egress, and Instagram, Facebook, Threads and Reddit answer datacenter addresses differently. Nobody
  has measured them from anywhere else, so "self-host and get the same cards" is unproven.

  The README row now reads "no blockers, no adapter yet" and links the doc. The comparison table's
  measurement date is qualified, so mbedfx's own column can be kept current without re-dating
  anybody else's.

## [1.8.0] - 2026-08-03

### Added
- Account pools for age-gated posts, staged, and wired for two of the three platforms. Age gates are
  the one failure class this project cannot degrade its way out of. Twitter's TweetTombstone,
  Instagram's `failure_reason:MA`, and a YouTube video reporting `age_limit:18` with `formats: 0` are
  all unreachable credential-free, measured on both egresses. The cards those produce are the correct
  answer without accounts, and not a bug in the fetchers.

  Three secrets, one per platform, each a JSON array so the pool size is data and a third account
  needs no deploy: `X_ACCOUNTS`, `IG_ACCOUNTS`, `YT_ACCOUNTS`. One account is picked at
  random per request. Round-robin needs state the edge does not share between isolates, and picking
  the first would put the whole load on one account and get it flagged.

- A cookie path into the container, which is what makes Instagram and YouTube work at all rather than
  merely look configurable. Their gates are beaten inside yt-dlp, not in the Worker, and the container
  protocol had no field for a credential and no `--cookies` anywhere in its argv, so filling those
  secrets would have done nothing. `{page}` calls now accept a `cookies` string, written to a 0600
  Netscape jar for the length of one call and unlinked afterwards even when yt-dlp raises or times
  out. Leave a jar behind and a live session sits on disk for the life of the container.

### Changed
- `CREDENTIAL_KEY` and `CREDENTIAL_BUNDLE` are replaced by the three per-platform secrets. The
  AES-256-GCM bundle was copied from FxEmbed, and it answers a threat this project doesn't have.
  FxEmbed self-hosts, where the bundle sits on a disk somebody else may read, while a Worker secret
  is encrypted at rest, unreadable from the dashboard and absent from the repo. The second layer
  bought no attacker-resistance, and cost a key stored beside the thing it protects plus a bespoke
  encrypt step on every rotation, which is the step most likely to be skipped.

- `RESOLVER_GENERATION` g9 → g10. Cookies change what the container returns for a gated id, and every
  warm meta record and the negative cache that suppresses re-dispatch for a failing id were produced
  without one. Without the bump, an age-gated video that failed before the pool existed would stay
  negatively cached and never be retried once it was filled.

### Fixed
- `credentialSeamArmed` was exported and never called from anywhere. It was written for the right
  reason, that "a variable that looks live and is inert is worse than one that does not exist", and
  then made nothing visible. It is replaced by a counted outcome, `pool_unused`, emitted in the arm
  that would have spent the credential. On `x` it is expected and marks the staging gap, since the
  Worker-side GraphQL call is a later phase. On `ig`/`yt` it is a real signal that the accounts need
  rotating.

### Notes
- Filling `X_ACCOUNTS` still changes nothing today. Twitter's gate is beaten in the Worker by a
  `TweetResultByRestId` call that is deliberately not built here, and `fetchWithCredentials` remains
  a real, tested seam returning null. Set the secret ahead of that work if you like. `pool_unused` is
  how the gap stays visible.
- The Instagram counter is weaker than the YouTube one and says so where it is emitted. `IG_ACCOUNTS`
  currently rides only the container path, while the `MA` gate is read off the Worker's own page
  fetch, which carries no jar. A rising `ig` count means the credential is not reaching the request
  that needs it, and not necessarily that the accounts are dead.

---

## [1.7.0] - 2026-08-03

### Added
- The Workers Builds preview url is pinned on. It needed a commit, not a dashboard click.
  `wrangler.jsonc` is desired state, every deploy reconciles Cloudflare to it, and merging is the
  deploy here, so anything set by hand in the dashboard survives until the next merge and no further.
  `preview_urls` had a wrinkle on top of that: it wasn't in the config at all, and a key the config
  doesn't mention gets wrangler's default reapplied. The config now records that an absent key is not
  an unchanged key.

  The same reconciliation governs the `routes` array, so a serving domain that is not in this file
  does not exist for longer than one merge. Adding one touches several places and most fail silently:
  the routes array; `OWN_HOSTS` in `src/platforms/fedihost.ts`, without which a fediverse ref naming
  this Worker's own origin makes it fetch itself back through the edge; and `OWN_HOSTS` in
  `public/index.html`, without which the page serves on the new domain while handing out links on a
  different one and calling its own links unsupported. All are pinned by tests now.

- A spinner while a video is being muxed. `settleMux` degrades an unfinished video to its poster
  still and keeps working in the background, which left the card payload indistinguishable from a
  post that only ever had a picture. A reader saw a frozen frame with no reason given, which is why
  "why is this just an image" kept being asked about links that were fine. `/_card` now reports
  `muxing`, and the page shows an indeterminate spinner and polls until it clears.

  It's not a progress bar and can't be: yt-dlp and ffmpeg run inside the container, and the Worker
  sees a Durable Object that has either finished or not. The label says the link is already correct
  and can be sent now. The poll is capped at 25s, after which a sentence replaces the spinner.

### Fixed
- A video too long to mux advertised a video url that could never resolve. The over-ceiling degrade
  was computed and then thrown away. `settleMux` ended with `if (!degraded) return { post }`,
  returning the original post, and that arm does not set `degraded`, because its verdict is permanent
  and re-deciding it every view was the cost the path exists to avoid. One flag was being asked to
  mean both "the array changed" and "the card is incomplete". The card went on naming `og:video` at
  `/_media/{key}/0`, which the container refuses forever, leaving a permanent 503 at a url the card
  promises. Caught by the Dailymotion fixture, 4830s against a 1500s ceiling.

  The still shape is now one function, `stillOf`. The over-ceiling arm had hand-rolled its own with a
  spread, which kept `remux` and lacked `posterOnly`, the combination that renders as nothing at all,
  and the defect `posterOnly` was introduced to fix.

- `settleMux` armed a 9-second timer it never cleared, on every render that reached the race, even
  when the container answered instantly. The `deadline()` helper already existed and already cleared
  its timer, and its own comment records that this cost the test suite 6 seconds before it was fixed
  there. Now used here too.

- The muxing spinner was drawn on the one entry that can never be it. Written first as
  `m.video ? (muxing ? spinner : play) : ''`, which never fired, because a degrading video becomes
  kind `image`. The entry the spinner exists for reported `video: false` and took the empty branch.

---

## [1.6.2] - 2026-08-03

### Fixed
- A `youtu.be` link came back as `/watch?v=`. The converter page already turns that short form into a
  bare `/{id}` correctly, and `/_prep` then overwrote it, because the link it returns was rebuilt
  from the platform's canonical every time, and YouTube's canonical is the long watch form. The
  rewrite learned nothing and handed back a longer link than the one pasted.

  The rewrite exists for a real case and is kept for it. A share code or a shortlink names no post
  until a hop resolves it, so the page must be given the resolved permalink. The test is now whether
  resolving changed which post the link addresses, and not whether the spelling is canonical. When it
  didn't, whatever was pasted comes back untouched. Both halves are pinned.

1154 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.6.1] - 2026-08-03

### Fixed
- Toggling media-only blanked the copyable link and the preview. Both causes were introduced with the
  toggle.

  The link vanished because the handler called `hidePreview()`, a name that says card and a body that
  also runs `outClass(false)`, hiding the result row and the Copy button. That's correct where it is
  otherwise used, when the input doesn't parse and there is nothing to show. On a toggle the link is
  valid and has merely changed host, so every toggle blanked the output until the next card landed,
  and left it blank for good if that fetch was slow or failed.

  The preview raced because the toggle refetched. Both drawings are built from one `/_card` payload
  and only the rendering differs, so a second request bought nothing and could land out of order
  behind the first. The payload already in hand is now redrawn instead, and `cardSeq` is bumped so an
  in-flight answer cannot land on top of it.

  Verified in a browser at six rapid toggles with a deliberately slow stub: the row stayed visible at
  every step, the kind alternated correctly, and the toggles caused zero extra requests.

1152 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.6.0] - 2026-08-03

Reported: a 24-minute YouTube video "still just pulling up as a frozen image". The still was correct.
The video is past the mux ceiling, which the README and the site both already documented. Three
things around it were not.

### Changed
- The mux ceiling is 25 minutes, up from 20 (`MAX_SECONDS` 1200 → 1500). `MAX_BYTES` moved with it,
  300 MB → 375 MB, and the two have to move together, because the mux is a stream copy so output size
  is source bitrate × duration. Raising only the duration would move the refusal from the duration
  filter to the size filter for exactly the videos the change was meant to admit, with an identical
  symptom.

### Added
- The card now says why a long video is a picture. The README promises that a post which cannot be
  shown says why, and private, age-gated and deleted all kept that promise where a too-long video
  did not. Applied on both seams, because the activity document is what Discord reads for a post
  with media, which is every video.
- `CREDENTIAL_KEY` and `CREDENTIAL_BUNDLE` are declared so the secrets can be set ahead of the work.
  They are read by nothing yet, and the type, the README and a `credentialSeamArmed` predicate all
  say so, because a variable that looks live and is inert is worse than one that does not exist.

### Fixed
- A video past the ceiling no longer costs a full deadline on every view. The duration is known, in
  the meta record kept 30 days, but nothing consulted it, so every render dispatched a mux the
  container refuses and then waited out the budget. Measured on the reported video: 5.2s on the HTML
  seam, 9.1s on the activity seam, and 5.1s again on a second view, because a degraded card is
  deliberately not response-cached. It now skips the dispatch and does not set `degraded`. That flag
  means "incomplete, something is still coming", true of a slow mux and false of a permanent verdict
  about an immutable property.
- The media-only toggle disables itself for a post with no media. A `d.` link to a text post can only
  404, and the page already had the card payload that says so. The toggle is disabled with a reason
  rather than hidden, and switched off if it was on.

### Notes
- `RESOLVER_GENERATION` g8 → g9. The stored record gained `duration`. A warm g8 record has none, and
  a long video would keep paying the full deadline this change exists to stop.

1151 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.5.0] - 2026-08-03

### Fixed
- `d.` did nothing on a share link. Reported on
  `d.megapenispoopenfarten.sex/r/linuxmemes/s/VRg1iSFn4k`, which behaved identically to the version
  without it. The host check had been wired into the pasted-permalink route only, and a Reddit
  `/r/{sub}/s/{code}`, a Meta `/share/` code and every shortlink are different route kinds, so three
  of the four ways to reach a post ignored the host entirely. The check moved into the one function
  they all converge on, so a future route that resolves to a post inherits it.

  The half that was easy to miss: every one of those routes bounces a person to the original post
  before rendering, since the card is only ever for a crawler. On a `d.` host that sent someone who
  asked for the file to the post they already had. Those redirects are now guarded too.
- Media-only intermittently lost its `d.`, reported as "it seems to intermittently not work when
  changing links". `/_prep` answers with a url the Worker built from the request's origin, the host
  serving the page, so it knows nothing about the domain toggle or media-only. When a share code
  unfurled, that answer overwrote a correct link and the `d.` reverted, with nothing on the page to
  show it.

  The same line discarded the domain toggle too, so the defect was pre-existing and wider than
  media-only. Nobody had noticed, because losing a whole `d.` is visible where losing a swap between
  two domains isn't. Both are fixed by re-pointing whatever `/_prep` returns at the host the reader
  chose.
- Media-only previewed nothing, reported as "antithetical to the purpose of previewing on the site".
  Half the original reasoning still holds, since a `d.` link does not unfurl and drawing the mock
  Discord card would be a lie. But the preview of "Discord attaches this file" is the file. It now
  shows the media itself, with no card chrome, and the payload fetch that used to be skipped runs.

### Changed
- Post bodies are capped at 253 characters, the last three being `...`. The cap was measured before
  it was built. Across the captured fixtures the median caption is 81 characters and two thirds are
  under 200, so Twitter, Instagram and Bluesky were never the problem.
  The walls are the long-form platforms, where Lemmy's median fixture is 3,239 characters and
  PieFed's 1,228. A real Lemmy post that rendered at 2,224 characters now renders at 252.

  Applied in one place and reached by both heads. Capping the Mastodon spoof and not the plain
  OpenGraph head would, from a reader's side, cap neither.

  It runs after translation. `withTranslation` composes English first, so a translated post long
  enough to hit the cap keeps the English and loses the original. There is a test for that ordering.
- YouTube's own clamp uses the same three dots as the render cap now, in place of `…`, leaving one
  truncation marker in the codebase. The clamp survives at 300 characters, since its job is bounding
  what is stored in R2 for 30 days. The render cap is tighter at 253, and the clamp's marker can no
  longer reach a card.
- The `staging.*` custom domains are retired. Testing is Workers Builds previews now, where each
  branch gets its own `*-mbedfx.<account>.workers.dev` and costs no DNS record, no route and no
  second certificate. The converter page's prefix logic moved with it, so a preview deployment emits
  its own links. A branch handed production links checks the live worker and leaves the change
  untested. The smoke test now asserts staging's absence, because a custom domain re-added by hand
  in a dashboard would serve on a hostname nobody is testing.
- The README's test-count badge became a last-commit badge. A test count says something about the
  project and nothing about what the project does, and a hand-maintained one only stays true while
  somebody remembers it. This one was already wrong, hardcoded at "1100+" against a suite of 1,145.
  Shields reads the commit date, so it cannot drift.

### Notes
- The SSRF own-host list needed no change, and that was checked.
  `platforms/fedihost.ts` already carries `workers.dev` and matches subdomains, so preview hosts were
  never fetchable as fediverse instances.
- The ~45 test files that use `staging.megapenispoopenfarten.sex` merely as a request hostname are
  left alone. `route()` is host-agnostic, so they assert nothing about staging, and rewriting them
  would be churn across 23 files for no change in behaviour.

1145 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.4.0] - 2026-08-02

### Added
- A "media only" checkbox on the converter, emitting the `d.` link from 1.3.0. It sits beside the
  domain buttons, because the two are different kinds of choice: the domain is one-of-two and this is
  an independent on/off. Every conversion routes through one function, so the two cannot disagree
  about the link.
- The preview stops drawing a card while it is on. A `d.` link doesn't unfurl. Discord fetches the
  url and attaches the file, and leaving the mock card up would be the largest disagreement between
  preview and reality this page could ship, against its own rule that a preview which re-implements
  the renderer drifts from it. It says what will happen instead, and the card fetch is skipped.

### Fixed
- Three visible em dashes that later work had re-introduced, one in the new media-only note, one in
  the `#convert` pitch and one in the document title added with the channel router. The no-em-dash
  and no-second-person rules are now asserted by a test over the page's visible copy, because a rule
  only ever enforced by memory gets re-broken by the next edit, which is exactly what happened here,
  twice, by later edits.

1141 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.3.0] - 2026-08-02

### Added
- A `d.` host that answers with the media itself, following fxTikTok's convention.
  `d.megapenispoopenfarten.sex/jack/status/20` redirects to that post's own `/_media/` url, the route
  that already owns byte-range serving, the R2 mux cache, the container dispatch and the degrade
  rules, so there is no second place for those four to disagree.

  It is the one route with no human/bot split. Everywhere else a person is redirected to the original
  post, because a card is for a crawler. Here the bytes are the product, and someone pasting a `d.`
  link wants the file and not the post they already had.

  A post with nothing to serve answers a plain-text 404, never an HTML card. Answering a failure with
  an embed hands a media player a document, and hands `curl -O` a page of markup saved under a
  video's name.

### Notes
- The host check lives in dispatch and not in `route()`. `route()` reads pathname and query and
  nothing else, a property it states and verifies by grep, and that property is load-bearing. It is
  why `/dm/`, `/st/` and `/im/` forcing can exist at all, since `dai.ly`, `streamable.com` and
  `imgur.com` all collapse onto one undecidable bare `/{id}`. A host-sensitive router would make
  every one of those decisions need re-measuring per domain. The route is decided host-blind, and the
  response shape is chosen afterwards. A test asserts that five paths route identically under `d.`
  and under the apex.
- The prefix is anchored, so a host merely containing `d.` keeps rendering cards. A substring test
  would have turned an ordinary domain into a file server, and nothing would have failed.
- `d.` works on `megapenispoopenfarten.sex` immediately, because that zone has a wildcard record
  which already reaches this Worker. `d.mbedfx.app` has no DNS record yet and won't resolve until
  someone adds one.

1138 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.2.1] - 2026-08-02

### Fixed
- The `fx` mark in the README banner still read as off centre. The previous fix baked it to a PNG so
  it no longer depended on the viewer's font, and centred it on its ink box, which measured exactly
  0.00, 0.00 against the tile and was still wrong to look at. "fx" has an ascender and no descender,
  so its visible weight is not where its bounding box is. The alpha-weighted centroid sat at 54.02,
  57.71 in a 112 tile, about two units left and 1.7 down. The mark is now placed on that centroid.

1133 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.2.0] - 2026-08-02

A copyright-blocked Instagram reel now has three independent recoveries, tried cheapest first.
Reported on `/reel/DX7byl-oyGR/`, which a competitor played and mbedfx drew as a photo.

### Added
- A shortcode-scoped GraphQL recovery, tried first. Instagram has an anonymous, cookie-free GraphQL
  query that answers with the same v1 media shape the user feed does, and unlike the feed it is
  addressed by the post. Measured with a real `fetch()` (not curl, which this project has been
  burned by on the neighbouring endpoint): HTTP 200, 21.6 KB, 429ms, `video_versions` intact, and no
  `copyright_blocked` key anywhere in the payload. Paging the account feed instead costs five
  requests and 2.45 MB, about 113 times the egress, and it does not fit the 5s response ceiling the
  GraphQL call meets.
- `IG_GRAPHQL_DOC_ID`, because the `doc_id` that query needs is rotated by Meta, and one is known to
  have died inside about a month. Re-pinning it is now a config change.

### Changed
- The recovery chain is GraphQL → account feed → yt-dlp container, and the tiers fail in different
  ways by design. The first dies to a rotated `doc_id`, the second to a post older than the account's
  twelve most recent, the third only to a missing container or an extractor break. Nothing short of
  Instagram refusing this Worker's egress outright takes all three, and that lands on the cover still
  that already ships. The yt-dlp tier is the durable floor because it isn't a private Instagram
  endpoint, and its maintainers chase Meta's changes for every user of it.
- Three counters (`copyright_gql`, `copyright_recovered`, `copyright_remux`) instead of one. The
  ratio is the only way a rotated `doc_id` announces itself, because the cards keep rendering from a
  slower tier and the failure is otherwise silent.

1133 tests, `node --test`; `tsc --noEmit` clean.

### Notes
- This entry absorbs what was briefly published as 1.1.2. That version was written up and then
  superseded before it ever shipped: no tag, no release, no deploy. Its content, and its
  measurements, are folded in below.


### Fixed
- A copyright-blocked Instagram reel older than the account's last 12 posts rendered as a photo.
  Instagram strips `video_url` from the embed payload when a post's audio is major-label catalogue,
  and the existing recovery asks the v1 user feed for the account's recent posts and picks the target
  post out by shortcode. That feed is account-scoped and serves exactly 12 items whatever `count`
  requests (verified at 33 and 50), so anything further back fell outside the window. That is the
  case reported on `/reel/DX7byl-oyGR/`, which sits about 60 posts deep and which instagram7 played
  while mbedfx drew a still. Paging to it with `max_id` measured five sequential requests and
  2.45 MB, which neither fits a 5s response ceiling nor is safe to expose to unauthenticated callers.

  It now falls through to the yt-dlp container, the same tier YouTube and Facebook already use.
  yt-dlp addresses the post by url and the window cannot apply to it. On that reel it resolved
  cookie-free to a better rendition than the feed offers (1080x1920 against 720x1280) in one request.
  The cheap path still runs first, so a recent blocked reel resolves without booting a container.

### Notes
- The still's own dimensions now ride along as `posterW`/`posterH`. Both degrade paths rebuild the
  cover as `{ kind: 'image', w: posterW ?? w }`, and a remux video's own `w`/`h` are 0 by design, so
  omitting them would have produced a 0x0 image. Discord draws that as no picture at all, on exactly
  the deploys and races where the still is all that is left.
- yt-dlp's success here was measured from a residential host and is not confirmed from Cloudflare's
  egress. It fails safe: no container, a refused extract or an oversized result all leave the cover
  still exactly as it is today. The one precedent for optimism is Facebook, where Meta decoys the
  crawler from the datacenter and yt-dlp extracts the video anyway. That is precedent, not proof.

---

## [1.1.1] - 2026-08-02

### Fixed
- The footer only existed on `#nope`. It was written when the page was one long scroll, where "at the
  bottom" and "under the last channel" were the same place. Once channels started hiding each other,
  the source link, the licence and the trademark disclaimer vanished from four channels out of five.
  It now sits outside every section, the only arrangement a future channel cannot take it away from,
  and is tighter, since it has to earn its height under a two-line channel. The one claim in it worth
  keeping ("reads the post itself rather than handing you off to someone else's fixer") moved into
  the `#convert` pitch.
- The `fx` mark in the README banner was off centre, and only for some readers. Measured in Chrome it
  was off by 0.75px in 112, which is correct. It was wrong on the reporter's phone, because the SVG
  asked for `system-ui`, which is not embedded, so every viewer rendered the mark in whatever their
  OS supplied while the baseline had been hand-tuned to one font's metrics. A nudge tuned in Chrome
  wouldn't have moved what the reporter saw. The mark is now baked to a cropped PNG and placed dead
  centre, so it is identical everywhere. Its size was solved for the width the design rendered, and
  it landed within 1% of nominal, close enough to confirm the bake reproduces the original.
- The README version badge was hardcoded and still read 1.0.0 two releases later. It now reads the
  latest GitHub release, so it cannot go stale again.

### Changed
- The comparison table's footnotes are gone. They had been through three shapes, a bunched paragraph,
  GitHub `[^n]` and a numbered list, which is the tell that the apparatus was the problem and not its
  rendering. The load-bearing qualifications moved into the cells they qualified, and the two
  fairness points a table cannot show, FxEmbed's depth on Twitter and mbedfx's remux being a
  workaround rather than an advantage, moved into the prose above it.
- "How it works" moved out from between Features and Caveats to sit with Contributing, Security and
  Credits. It is architecture, and it was interrupting the part a visitor reads to decide whether to
  paste a link.

1130 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.1.0] - 2026-08-02

The page borrowed Discord's chrome without borrowing its behaviour. Four reports, all the same
observation from different angles.

### Added
- The channels are real channels. Every one used to render into a single long scroll with a
  scroll-spy renaming the sticky bar as each divider passed under it. One channel is now on screen at
  a time and the URL hash is the channel, which brings the expected behaviours for free:
  `mbedfx.app/#limits` deep-links, the back button steps through channels, and a stale link to a
  channel that no longer exists falls back to the first one.
- A channel drawer on portrait mobile. Below 800px the sidebar was `display: none` with nothing in
  its place. That was survivable while everything was one scroll and became a dead end the moment
  channels started hiding each other, because a phone could reach exactly the channel it landed on.
  There is now a toggle in the header opening the channel list as a drawer, closable by the scrim, by
  Escape, or by picking a channel. It reports its state with `aria-expanded`.
- A version badge on the site, beside the server name where Discord puts a server's own identity. The
  page is a static asset with no template step, so the number is in the markup, pinned to
  `package.json` by a test, because a badge that disagrees with the release makes every bug report
  ambiguous.

### Fixed
- The `convert` channel had no bold header. Every other channel had a bold `# name` divider except
  `convert`, which sat at the top where the sticky bar already stood in for one. With a single
  channel on screen that divider repeats the bar directly above it, so the dividers went and
  `convert` never gained one. Discord does the same.

### Changed
- Channels are each a `<section class="chan">` around their own content. They were not wrapped at
  all: a channel's header bar was a sibling of the article holding its body, so there was no single
  element per channel to show or hide. A test now fails if a future channel is added unwrapped, or if
  the sidebar and the sections stop naming the same set.

1129 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.0.1] - 2026-08-02

Three defects found in the first day of real use, all on the converter page or the seam behind it.
Two of them share a shape: work that only ever got done by Discord unfurling a link, on a page where
nobody has unfurled anything yet.

### Fixed
- The preview always said "no upload date". YouTube's upload date comes from the container and is
  cached in R2, but that cache is warmed by the activity route, which is Discord unfurling the link.
  `/_card` only ever read it, so the record was cold for exactly the links a person previews, the
  ones they haven't sent. Measured live: the same video returned the epoch on its first view and the
  correct 2009 date on its second and third. On the converter page every view is a first view, so the
  self-heal that hid this everywhere else could never fire. The preview now warms the record the same
  way the card does, which adds no container call. It moves the one the reader was about to trigger
  by pasting into Discord a few seconds earlier.
- Translations arrived unreliably on the preview. `/_card` awaited the mux and then asked for
  whatever was left of the deadline for the translation. A cold mux doesn't finish early. It spends
  whatever budget it is handed, so on any post with video the mux took the whole ceiling and the
  translation fell to its 300ms floor. Google is measured at 217-798ms. A 300ms race wins some of the
  time, giving the same link two different answers. The two now run concurrently, on the preview's
  own ceiling.
- The same defect on the OpenGraph seam. Found while measuring a live Instagram reel: the activity
  document came back translated while the plain head, for the same post at the same moment, carried
  the raw Chinese caption. Two seams disagreeing about one post is the failure this project has
  repeated more than any other, and it is now asserted against in both directions.

### Added
- `pending` in the `/_card` response. A translation that loses its race already set this flag, and
  `renderPostRoute` already read it to suppress the response cache so the next render heals. The
  converter page has no next render, because it fetches once and draws the answer. It now re-fetches
  once, 2.5s later, when the flag is set, and never polls. The losing work is still running and
  writes to R2 as the response goes out, so the retry reads a warm record instead of paying a second
  inference.

### Changed
- Site copy moved out of second person into third: "when you get a wall" became "when a link hits a
  wall". First person stays, and the page still says "slot me in" and "so I won't guess".
- The footer claimed a "Zero-dependency Cloudflare Worker", which is not true, because
  `package.json` carries `@cloudflare/containers`. It now says "No-framework", which is true.
- The comparison table's footnotes sit under the table again. GitHub's own footnote syntax fixed
  their run-on rendering but relocated them below the licence, ~160 rendered lines from the table
  they annotate.
- Staging hostnames dropped from the published domain list.

### Notes
- The activity route's uncapped translation budget is unchanged. It looks like the same bug and isn't.
  There the mux and the translation are already concurrent on a 9s budget that a cold mux is expected
  to spend anyway, so capping the translation would abandon it early to save time the response spends
  regardless, making translations worse.
- Each of the three fixes has a test that was verified to fail against the previous code. Two of them
  cost ~5s of wall clock each by design. The budget they prove cannot be exhausted is
  `HTML_DEADLINE_MS`, so the mux has to genuinely outlast it, and a faster test would pass either
  way.

1125 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.0.0] - 2026-08-01

The first public release. Everything below already ran in production. This is where the repository,
the licence and the release history caught up.

### Added
- Seventeen sites: Twitter, TikTok, Instagram, Threads, Reddit, Bluesky, YouTube, Facebook, Twitch,
  Pinterest, Dailymotion, Streamable, Imgur, and any Mastodon, Misskey, Lemmy or PeerTube instance.
  Short links and share codes resolve before the card is drawn.
- Inline video. A companion container runs `yt-dlp` and `ffmpeg`, remuxes to a progressive MP4 and
  caches it in R2, and the worker serves it with byte-range support so Discord's own player seeks. A
  video still muxing degrades to its cover image, and that degraded card is deliberately not cached.
- Translation. A non-English caption is rendered in English above the author's own words, with the
  language named. Non-Latin scripts are detected locally, and Latin-script languages go to a
  detector, because guessing Spanish-from-English is how a marker ends up on an English post.
- The converter page. `mbedfx.app` rewrites a link in the browser, names the site it read the link
  as and allows a correction, unfurls share codes, and previews the Discord card before it is sent.
- Failure cards that say what happened. Private, age-gated, deleted and ambiguous each say which of
  those they are.
- Tracking parameters stripped from anything handed onward, including Meta share tokens, which are
  minted per sharing act and carry the sharer's identity.

### Fixed
Backfilled from the pull requests that got the project here. Written from the reader's side, because
every one of these was reported as "the card looks wrong" and not as a stack trace.

- Translation reached the card at all (#21, #22, #26). It went to the OpenGraph head while Discord,
  for a post with media, reads the Mastodon-shaped status, so it landed in a document nobody read.
  Then the cache was keyed on the post's raw text alone, so fixing the engine could not invalidate a
  stale answer. The key now carries a generation.
- The translation engine was chosen by measurement (#25, #29, #30, #31). Every candidate was raced on
  identical inputs from a Worker. The model shipped with turned out to be the worst of five, giving
  "White is delicious." for 白菜おいしいね, and was replaced. The English translation now leads and
  the author's own words follow it, per the owner's call.
- Every language, not just every script (#41, #42). Script detection is free and certain, and cannot
  see Spanish or Portuguese, so a caption in a Latin-script language now goes to a detector.
- Card colours were never read (#35). `theme-color` was spelled `property=` for the entire life of
  the feature; it is a standard HTML meta and takes `name=`. Every card had been falling back to
  Discord's default. Settled by a fixer that ships both spellings with different values, and renders
  the `name=` one.
- Facebook's ordinary post permalink was unroutable (#39, #40). The router knew Facebook's video
  shapes and no post shape at all, so `/story.php` offered a chooser between x.com and instagram.com
  and `/{owner}/posts/{id}` was "Not found". The same work fixed group-post media, which had been
  404ing since group posts shipped because the ref could not survive the wire.
- Meta share links leaked the sharer (#19, #20, #32). A resolved link forwarded the share token and
  its tracking parameters, which are minted per sharing act. Now stripped to an allowlist of the
  parameters that genuinely identify the post, because a denylist could not keep up with what Meta
  invents.
- YouTube cards were nearly empty (#37, #38): no description, no counts, and a 1970 date. The
  description had been arriving from the container all along and was dropped on arrival for want of a
  field to put it in, and the date was a deadline set below the time the extract takes.
- A quote-tweet lost its video (#28), a byline rendered as a bare `(@)` (#16), and an image post drew
  nothing at all when a degraded still was addressed at the video's dimensions (#17).
- Imgur albums and single photos (#17), and the four-image cap that never existed (the limit was
  misread from Mastodon's server-side rule).

### Changed
- The converter page grew from a placeholder into the site: a Discord-styled shell, a light and dark
  theme, the site it read the link as (correctable), share-code unfurling, and a preview of the
  actual card (#17, #18, #23, #24, #33, #36, #43).
- Two back-to-back merges race their deploys and the older one can win (#14). Discovered the hard
  way. Wait for one deploy before merging the next.

### Notes
- Two zones serve the identical worker. The original hostname is kept alive because a link already
  pasted into a channel resolves only while its host does.
- The container is optional. Without it bound, video degrades to a cover image and every other card
  renders normally.
- Deploys have exactly one deployer, Cloudflare Workers Builds, watching `main`. `npm run deploy`
  refuses on purpose.
- A throwaway worker (`bakeoff/`) existed briefly to race the translation engines and was deleted
  once it had answered (#29, #31). It is in the git history and not in the tree, on purpose: a
  measuring instrument left lying around becomes a service nobody owns.

---

## [0.11.0] - 2026-08-01

### Changed
- The translation engine was chosen by measurement. A throwaway worker raced every candidate on
  identical inputs from a Worker. The model shipped with turned out to be the worst of five, giving
  "White is delicious." for 白菜おいしいね, and was replaced by `gemma-4-26b-a4b-it`. English now
  leads and the author's own words follow it. (#29, #30, #31)
- Every language, not just every script. Script detection cannot see Spanish or Portuguese, and a
  Latin-script caption is resolved by a detector rather than a heuristic, because guessing
  English-from-Spanish is how a "Translated from" marker ends up on an English post. (#41, #42)

### Fixed
- Card colours were never read. `theme-color` was spelled `property=` for the life of the feature; it
  is a standard HTML meta and takes `name=`. Every card had been falling back to Discord's default.
  Both spellings ship now, from one value. (#35)
- Facebook's ordinary post permalink was unroutable. `/story.php` offered a chooser between x.com and
  instagram.com, and `/{owner}/posts/{id}` was "Not found". The same work fixed group-post media,
  which had been 404ing since group posts shipped. (#39, #40)
- YouTube cards were nearly empty: no description, no counts, a 1970 date. The description had been
  arriving from the container all along and was dropped for want of a field to put it in. (#37, #38)
- The card preview landed, then had to be taught the stat order, the poster frame, the quoted post
  and the footer date, each caught by a side-by-side against the real card. (#33, #34, #36, #43)

## [0.10.0] - 2026-07-31

### Added
- Translation. Non-English captions rendered in English beside the original. (#17, #25)
- The converter page. A Discord-styled shell with light and dark themes, the site it read the link as
  (correctable), share-code unfurling and a background mux warm-up. (#17, #18, #23, #24)
- Imgur albums and single photos, uncapped. The four-image limit never existed; it was misread from
  Mastodon's server-side rule. (#17)

### Fixed
- Translation reached the card at all. It was written to the OpenGraph head while Discord, for a post
  with media, reads the Mastodon-shaped status. Then the cache was keyed on the post's raw text
  alone, so fixing the engine could not invalidate a stale answer.
  (#21, #22, #26)
- Meta share links leaked the sharer. A resolved link forwarded the share token and its tracking
  parameters, which are minted per sharing act. (#19, #20)
- A quote-tweet lost its video (#28), and an image post drew nothing at all when a degraded still was
  addressed at the video's dimensions (#17).

## [0.9.0] - 2026-07-30

Renamed to mbedfx, on mbedfx.app. PeerTube joined as the fourth fediverse platform, YouTube
learned to say when a video is age-restricted, and Facebook group posts became routable. (#5-#16)

The original zone is retained and still serves. A link already pasted into a Discord
channel resolves only while its host does, so cutting over would break every message
anyone has already sent. Retiring it is a later, separate decision.

- Four routes across two zones (`mbedfx.app`, `staging.mbedfx.app`, plus the two original
  hostnames). The response cache already keys on origin, so each hostname keeps its own
  rendered card and cannot serve another's urls. That property was added for the 2026-07-25
  apex cutover and is now load-bearing twice over.
- `OWN_HOSTS` gained `mbedfx.app`, and a test now enforces the coupling. A fediverse ref
  names its own origin, so `/{own-host}/post/1` would induce the Worker to fetch
  itself back through the edge, where Cloudflare's default subrequest behaviour bypasses
  the zone's own WAF. Adding a route while forgetting `OWN_HOSTS` is a silent SSRF hole,
  because the domain serves normally and nothing fails. `test/smoke.test.mjs` now asserts
  every configured route is refused by `fetchableInstance`, verified to fail when the
  entry is removed. wrangler.jsonc claimed this coupling before, and nothing made it true.
- The R2 bucket and analytics dataset were renamed, and neither migrates. R2 buckets cannot
  be renamed in Cloudflare: `mbedfx-media` is a new, empty bucket and `fxeverything-media`
  keeps its objects. That is safe only because every object in it is a regenerable mux
  artefact keyed by refKey, at the cost of each video muxing once more. Delete the old
  bucket once traffic has moved or it bills for storage nobody reads. Likewise
  `mbedfx_counters` starts at zero, and the history stays queryable in the old dataset.
- The response-cache namespace moved (`cache.fxeverything.internal` →
  `cache.mbedfx.internal`), which flushes every cached card. That is deliberate: the cached
  markup carries the old `og:site_name`, so the flush is what makes the rename visible
  rather than something to work around.
- Dated docs under `docs/research/` and `docs/superpowers/` were not rewritten. They record
  what was designed and measured on specific days, including the literal commands run, so
  renaming inside them would falsify the record.

## [0.8.0] - 2026-07-29

### Added
- The fediverse family: Mastodon, Pleroma, Akkoma, Misskey, Sharkey, Iceshrimp and PieFed, any
  instance, no per-instance configuration. (#4)

## [0.7.0] - 2026-07-27

### Added
- Twitch clips, Lemmy and Pinterest. (#3)

### Fixed
- Instagram false-private and copyright-blocked reels, Facebook share links, the Twitter age
  gate (#1), and an Instagram carousel that served a square crop of a wider image (#2).

## [0.6.0] - 2026-07-26

### Added
- Dailymotion, Streamable and Imgur, the yt-dlp tier, where the platform hands out no useful
  metadata surface and the container does the extraction.

## [0.5.0] - 2026-07-24

### Added
- YouTube and Facebook.

## [0.4.0] - 2026-07-21

### Added
- Twitter, Threads and Reddit.

## [0.3.0] - 2026-07-19

### Added
- TikTok and Instagram, the first platforms needing a browser-shaped request, which is where
  "assert on content, never on status" was learned.

## [0.2.0] - 2026-07-18

All four images, formatted text, quote and reply context in one Discord embed, by
advertising a Mastodon instance and letting Discord fetch the post as a Mastodon
`Status`. NOT YET VERIFIED IN A REAL DISCORD CLIENT; see the gate below.

- Discord, on a post with usable media, now gets a head with **zero `og:image`**, a
  `rel=alternate application/activity+json` link and a `json+oembed` link. Discord
  takes the last path segment of the activity href and calls
  `GET /api/v1/statuses/{id}`, which returns a Mastodon Status carrying every image in
  `media_attachments`. `/_oembed/{id}` supplies the author line.
- Every platform, phase and decision here was derived from **probing live FxEmbed** and
  reading its MIT source rather than from the docs. See
  `docs/research/2026-07-18-phase-2-mastodon-spoof-wire-spec.md`, where four things the
  original plan had wrong are recorded with the evidence that overturned them.
- The status id is **pure digits with a nonzero leading sentinel**, so it looks like a
  Mastodon snowflake and no layer can eat a leading zero by numeric normalization.
- `api`, `users` and `_oembed` are **shape-matched with fallthrough, never reserved**.
  `@api` is a live X account, so `/api/status/123` still routes as a real post, which is
  the same defect class Phase 1 had to fix for `/x/status/123`.
- Newlines use two U+FE00 per `<br>`, because Discord trims a bare blank line. Structural
  gaps use a bare `<br><br>`, which is how a user's blank line stays distinguishable.
- Counts live in the Mastodon `content` and the oEmbed `author_name`, and **never** in
  `og:description`. That pairing is the double-render trap.
- A quoted post's media is hoisted into the parent's attachments, so a quote-only post
  is no longer imageless. Parent indices are unchanged, and the change is purely additive.
- Telegram gets its own renderer: one image plus the richer text, no spoof. A mosaic
  composite, which is what FxEmbed serves Telegram, is an accepted divergence.
- Text-only Discord posts stay on Phase 1's plain-og path, the one rendering a human has
  confirmed in a real client.

215 tests, `node --test`; `tsc --noEmit` clean. `megapenispoopenfarten.sex` untouched.

**REMAINING GATE (needs a human):** paste a multi-image Bluesky post into real Discord
clients, on desktop, Android and iOS. The embed debugger does not render these paths
faithfully. If the gallery does not appear, revert the gate's second operand in
`src/render/discord.ts`; the plan's native-multi-og fallback was never built.

## [0.1.0] - 2026-07-17

The full request pipeline, proven end to end with the one non-adversarial platform.

- `classify` (UA → client class) → `route` (path → Route) → two-layer Cache API →
  `fetch` → `normalize` → `render`, all wired in `src/worker.ts`.
- Bluesky posts render a correct Discord embed. Verified live on staging: a real post
  produces `og:title`/`og:image`, and the `/_media/` route 302s to a real `cdn.bsky.app`
  image (HTTP 200, `image/webp`).
- Root replacement works for permalinks; ambiguous paths (`/mrbeast`) return a chooser,
  never a guess.
- Media is served via `/_media/{refKey}/{index}` → 302, never proxied. The refKey segment
  is percent-encoded so it survives edge/proxy colon-normalization.
- Bluesky HLS video renders as its thumbnail image, because Discord can't play `.m3u8`. Real
  playback deferred to Phase 2.
- Analytics are counters only: no URLs, post IDs, or IPs.
- Deployed to `staging.megapenispoopenfarten.sex` (a specific route that beats the fxtiktok `*.megapenispoopenfarten.sex/*` wildcard by specificity). `megapenispoopenfarten.sex` still serves the
  live `fxtiktok` worker, untouched, until the Phase 3 cutover.

95 tests, `node --test`; `tsc --noEmit` clean.
