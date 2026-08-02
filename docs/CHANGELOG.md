# Changelog

All notable changes to mbedfx are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.2] — 2026-08-02

### Fixed
- **A copyright-blocked Instagram reel older than the account's last 12 posts rendered as a photo.**
  Instagram strips `video_url` from the embed payload when a post's audio is major-label catalogue,
  and the existing recovery asks the v1 user feed for the account's recent posts and picks ours out
  by shortcode. That feed is ACCOUNT-scoped and serves exactly 12 items whatever `count` requests
  (verified at 33 and 50), so anything further back fell outside the window — the case reported on
  `/reel/DX7byl-oyGR/`, which sits about 60 posts deep and which instagram7 played while we drew a
  still. Paging to it with `max_id` measured five sequential requests and 2.45 MB, which neither fits
  a 5s response ceiling nor is safe to expose to unauthenticated callers.

  It now falls through to the yt-dlp container — the same tier YouTube and Facebook already use.
  yt-dlp addresses the post by URL, so the window cannot apply to it, and on that reel it resolved
  cookie-free to a better rendition than the feed offers (1080x1920 against 720x1280) in one request.
  The cheap path still runs first, so a recent blocked reel resolves without booting a container.

### Notes
- The still's own dimensions now ride along as `posterW`/`posterH`. Both degrade paths rebuild the
  cover as `{ kind: 'image', w: posterW ?? w }`, and a remux video's own `w`/`h` are deliberately 0 —
  so omitting them would have produced a 0x0 image, which Discord draws as no picture at all. That is
  a blank card rather than a slightly wrong one, on exactly the deploys and races where the still is
  all that is left.
- yt-dlp's success here was measured from a RESIDENTIAL host and is not confirmed from Cloudflare's
  egress. It fails safe: no container, a refused extract or an oversized result all leave the cover
  still exactly as it is today. The precedent for optimism is Facebook, where Meta decoys the crawler
  from the datacenter and yt-dlp extracts the video anyway — precedent, not proof.

1131 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.1.1] — 2026-08-02

### Fixed
- **The footer only existed on `#nope`.** It was written when the page was one long scroll, where "at
  the bottom" and "under the last channel" were the same place. Once channels started hiding each
  other, the source link, the licence and the trademark disclaimer vanished from four channels out of
  five. It now sits outside every section — the only arrangement a future channel cannot take it away
  from — and is tighter, since it has to earn its height under a two-line channel. The one claim in it
  worth keeping ("reads the post itself rather than handing you off to someone else's fixer") moved
  into the `#convert` pitch, where it argues for the tool rather than sitting in small print.
- **The `fx` mark in the README banner was off centre**, and only for some readers. Measured in
  Chrome it was off by 0.75px in 112 — correct. It was wrong on the reporter's phone, and that gap is
  the whole bug: the SVG asked for `system-ui`, which is not embedded, so every viewer rendered the
  mark in whatever their OS supplied while the baseline had been hand-tuned to one font's metrics. A
  nudge tuned here would not have moved what they saw. The mark is now baked to a cropped PNG and
  placed dead centre, so it is identical everywhere. Its size was solved for the width the design
  actually rendered rather than copied from the old attribute, and landed within 1% of nominal —
  which confirms the bake reproduces the original rather than quietly redrawing it.
- **The README version badge was hardcoded** and still read 1.0.0 two releases later. It now reads
  the latest GitHub release, so it cannot go stale again.

### Changed
- The comparison table's footnotes are gone. They had been through three shapes — bunched paragraph,
  GitHub `[^n]`, numbered list — which is the tell that the apparatus was the problem rather than its
  rendering. The load-bearing qualifications moved into the cells they qualified, and the two fairness
  points a table cannot show (FxEmbed's depth on Twitter, and our remux being a workaround rather than
  an advantage) moved into the prose above it. Dropping them silently would have left the table
  overclaiming.
- **"How it works" now sits with Contributing, Security and Credits** instead of between Features and
  Caveats. It is architecture, and it was interrupting the part a visitor reads to decide whether to
  paste a link.

1130 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.1.0] — 2026-08-02

The page borrowed Discord's chrome without borrowing its behaviour. Four reports, all the same
observation from different angles.

### Added
- **The channels are real channels.** Every one used to render into a single long scroll with a
  scroll-spy renaming the sticky bar as each divider passed under it. One channel is now on screen at
  a time and the URL hash is the channel, which comes with the things people expect for free:
  `mbedfx.app/#limits` deep-links, the back button steps through channels, and a stale link to a
  channel that no longer exists falls back to the first one instead of rendering a blank page.
- **A channel drawer on portrait mobile.** Below 800px the sidebar was `display: none` with nothing
  in its place. That was survivable while everything was one scroll and became a dead end the moment
  channels started hiding each other — a phone could reach exactly the channel it landed on. There is
  now a toggle in the header opening the channel list as a drawer, closable by the scrim, by Escape,
  or by picking a channel. It reports its state with `aria-expanded`.
- **A version badge on the site**, beside the server name where Discord puts a server's own identity.
  The page is a static asset with no template step, so the number is in the markup — and pinned to
  `package.json` by a test, because a badge that silently disagrees with the release makes every bug
  report ambiguous.

### Fixed
- **The `convert` channel had no bold header.** Reported as an inconsistency and it was one, though
  not about boldness: every channel had a bold `# name` divider except `convert`, which sat at the
  top where the sticky bar already stood in for one. With a single channel on screen that divider
  repeats the bar directly above it, so the whole set went rather than `convert` gaining one — which
  is also what Discord does.

### Changed
- Channels are each a `<section class="chan">` around their own content. They were not wrapped at
  all: a channel's header bar was a *sibling* of the article holding its body, so there was no single
  element per channel to show or hide. A test now fails if a future channel is added unwrapped, or if
  the sidebar and the sections stop naming the same set.

1129 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.0.1] — 2026-08-02

Three defects found in the first day of real use, all on the converter page or the seam behind it.
Two share one shape: work that only ever got done by *Discord* unfurling a link, on a page where
nobody has unfurled anything yet.

### Fixed
- **The preview always said "no upload date".** YouTube's upload date comes from the container and
  is cached in R2 — but that cache is warmed by the activity route, i.e. by Discord unfurling the
  link. `/_card` only ever read it. So the record was cold for exactly the links a person previews:
  the ones they have not sent. Measured live: the same video returned the epoch on its first view
  and the correct 2009 date on its second and third. On the converter page every view is a first
  view, so the self-heal that hid this everywhere else could never fire. The preview now warms the
  record the same way the card does — which adds no container call, it moves the one the reader was
  about to trigger by pasting into Discord a few seconds earlier.
- **Translations arrived unreliably on the preview.** `/_card` awaited the mux and *then* asked for
  whatever was left of the deadline for the translation. A cold mux does not finish early — it
  spends whatever budget it is handed — so on any post with video the mux took the whole ceiling and
  the translation fell to its 300ms floor. Google is measured at 217–798ms, so a 300ms race wins
  *some* of the time: same link, two different answers. The two now run concurrently, on the
  preview's own ceiling rather than one borrowed from Discord's crawler.
- **The same defect on the OpenGraph seam.** Found while measuring a live Instagram reel: the
  activity document came back translated while the plain head, for the same post at the same
  moment, carried the raw Chinese caption. Two seams disagreeing about one post is the failure this
  project has repeated more than any other, and it is now asserted against in both directions.

### Added
- **`pending` in the `/_card` response.** A translation that loses its race already set this flag,
  and `renderPostRoute` already read it to suppress the response cache so the next render heals. The
  converter page has no next render — it fetches once and draws the answer. It now re-fetches once,
  2.5s later, when the flag is set; the losing work is still running and writes to R2 as the
  response goes out, so the retry reads a warm record rather than paying a second inference. One
  retry, never a poll.

### Changed
- Site copy moved out of second person into third — "when a link hits a wall" rather than "when you
  get a wall". First person stays: the page still says "slot me in" and "so I won't guess".
- The footer claimed a **"Zero-dependency Cloudflare Worker"**, which is not true — `package.json`
  carries `@cloudflare/containers`. It now says "No-framework", which is.
- The comparison table's footnotes sit under the table again. GitHub's own footnote syntax fixed
  their run-on rendering but relocated them below the licence, ~160 rendered lines from the table
  they annotate.
- Staging hostnames dropped from the published domain list.

### Notes
- **Not changed, deliberately:** the activity route's uncapped translation budget. It looks like the
  same bug and is not. There the mux and the translation are already concurrent on a 9s budget that
  a cold mux is expected to spend anyway, so capping the translation would abandon it early to save
  time the response spends regardless — it would make translations *worse*, which is the thing being
  fixed here.
- Each of the three fixes has a test that was verified to FAIL against the previous code. Two of
  them cost ~5s of wall clock each on purpose: the budget they prove cannot be exhausted is
  `HTML_DEADLINE_MS`, so the mux has to genuinely outlast it. A faster test passes either way and
  pins nothing.

1125 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.0.0] — 2026-08-01

The first public release. Everything below already ran in production; this is the point at
which the repository, the licence and the release history caught up with it.

### Added
- **Seventeen sites.** Twitter, TikTok, Instagram, Threads, Reddit, Bluesky, YouTube, Facebook,
  Twitch, Pinterest, Dailymotion, Streamable, Imgur, and any Mastodon, Misskey, Lemmy or PeerTube
  instance. Short links and share codes resolve before the card is drawn.
- **Inline video.** A companion container runs `yt-dlp` and `ffmpeg`, remuxes to a progressive MP4
  and caches it in R2; the worker serves it with byte-range support so Discord's own player seeks.
  A video still muxing degrades to its cover image, and that degraded card is deliberately not
  cached.
- **Translation.** A non-English caption is rendered in English above the author's own words, with
  the language named. Non-Latin scripts are detected locally; Latin-script languages are resolved by
  a detector rather than a heuristic, because guessing Spanish-from-English is how a marker ends up
  on an English post.
- **The converter page.** `mbedfx.app` rewrites a link in the browser, says which site it read it
  as and lets you correct it, unfurls share codes, and previews the Discord card before you send it.
- **Honest failure cards.** Private, age-gated, deleted and ambiguous each say what they are instead
  of rendering a blank or a plausible fabrication.
- **Tracking parameters stripped** from anything handed onward, including Meta share tokens, which
  are minted per sharing act and carry the sharer's identity.

### Fixed
Backfilled from the pull requests that got the project here. Written from the reader's side, because
every one of these was reported as "the card looks wrong" rather than as a stack trace.

- **Translation reached the card at all** (#21, #22, #26). It was being applied to the OpenGraph head
  while Discord, for a post with media, reads the Mastodon-shaped status — so it was written to a
  document nobody read. Then the cache was keyed on the post's raw text rather than on the question
  actually asked, so fixing the engine could not invalidate a stale answer; a generation in the key
  is what makes an engine change take effect.
- **The translation engine was chosen by measurement, not by argument** (#25, #29, #30, #31). Every
  candidate was raced on identical inputs from a Worker. The model we shipped with turned out to be
  the worst of five — "White is delicious." for 白菜おいしいね — and was replaced. The English
  translation now leads and the author's own words follow it, per the owner's call.
- **Every language, not just every script** (#41, #42). Script detection is free and certain but
  cannot see Spanish or Portuguese. A caption in a Latin-script language is now resolved by a
  detector rather than a heuristic, because guessing English-from-Spanish is how a "Translated from"
  marker ends up on an English post.
- **Card colours were never actually read** (#35). `theme-color` was spelled `property=` for the
  entire life of the feature; it is a standard HTML meta and takes `name=`. Every card had been
  falling back to Discord's default. Settled by a fixer that ships both spellings with different
  values, and renders the `name=` one.
- **Facebook's ordinary post permalink was unroutable** (#39, #40). The router knew Facebook's video
  shapes and no post shape at all, so `/story.php` offered a chooser between x.com and instagram.com
  and `/{owner}/posts/{id}` was "Not found". The same work fixed group-post media, which had been
  404ing since group posts shipped because the ref could not survive the wire.
- **Meta share links leaked the sharer** (#19, #20, #32). A resolved link forwarded the share token
  and its tracking parameters, which are minted per sharing act. Now stripped to an allowlist of the
  parameters that genuinely identify the post — a denylist could not keep up with what Meta invents.
- **YouTube cards were nearly empty** (#37, #38). No description, no counts, and a 1970 date. The
  description had been arriving from the container all along and was dropped on arrival for want of
  a field to put it in; the date was a deadline set below the time the extract actually takes.
- **A quote-tweet lost its video** (#28), **a byline rendered as a bare `(@)`** (#16), and **an image
  post drew nothing at all** when a degraded still was addressed at the video's dimensions (#17).
- **Imgur albums and single photos** (#17), and the four-image cap that never existed (the limit was
  misread from Mastodon's server-side rule, not ours).

### Changed
- **The converter page** grew from a placeholder into the site: a Discord-styled shell, a light and
  dark theme, the site it read your link as (correctable), share-code unfurling, and a preview of
  the actual card (#17, #18, #23, #24, #33, #36, #43).
- **Two back-to-back merges race their deploys and the older one can win** (#14). Discovered the hard
  way. Wait for one deploy before merging the next.

### Notes
- Two zones serve the identical worker. The original hostname is kept alive on purpose: a link
  already pasted into a channel resolves only while its host does.
- The container is optional. Without it bound, video degrades to a cover image and every other card
  renders normally.
- Deploys have exactly one deployer — Cloudflare Workers Builds, watching `main`. `npm run deploy`
  refuses on purpose.
- A throwaway worker (`bakeoff/`) existed briefly to race the translation engines and was deleted
  once it had answered (#29, #31). It is in the history and not in the tree, on purpose: a measuring
  instrument left lying around becomes a service nobody owns.

---

## [0.11.0] — 2026-08-01

### Changed
- **The translation engine was chosen by measurement.** A throwaway worker raced every candidate on
  identical inputs from a Worker. The model shipped with turned out to be the worst of five —
  "White is delicious." for 白菜おいしいね — and was replaced by `gemma-4-26b-a4b-it`. English now
  leads and the author's own words follow it. (#29, #30, #31)
- **Every language, not just every script.** A Latin-script caption is resolved by a detector rather
  than a heuristic, because guessing English-from-Spanish is how a "Translated from" marker ends up
  on an English post. (#41, #42)

### Fixed
- **Card colours were never read.** `theme-color` was spelled `property=` for the life of the
  feature; it is a standard HTML meta and takes `name=`. Every card had been falling back to
  Discord's default. Both spellings ship now, from one value. (#35)
- **Facebook's ordinary post permalink was unroutable** — `/story.php` offered a chooser between
  x.com and instagram.com, and `/{owner}/posts/{id}` was "Not found". The same work fixed group-post
  media, which had been 404ing since group posts shipped. (#39, #40)
- **YouTube cards were nearly empty**: no description, no counts, a 1970 date. The description had
  been arriving from the container all along and was dropped for want of a field to put it in. (#37, #38)
- **The card preview** landed, then had to be taught the stat order, the poster frame, the quoted
  post and the footer date — each caught by a side-by-side against the real card. (#33, #34, #36, #43)

## [0.10.0] — 2026-07-31

### Added
- **Translation.** Non-English captions rendered in English beside the original. (#17, #25)
- **The converter page.** A Discord-styled shell with light and dark themes, the site it read your
  link as (correctable), share-code unfurling and a background mux warm-up. (#17, #18, #23, #24)
- **Imgur albums and single photos**, uncapped — the four-image limit never existed; it was misread
  from Mastodon's server-side rule. (#17)

### Fixed
- **Translation reached the card at all.** It was written to the OpenGraph head while Discord, for a
  post with media, reads the Mastodon-shaped status. Then the cache was keyed on the post's raw text
  rather than the question asked, so fixing the engine could not invalidate a stale answer. (#21, #22, #26)
- **Meta share links leaked the sharer.** A resolved link forwarded the share token and its tracking
  parameters, which are minted per sharing act. (#19, #20)
- **A quote-tweet lost its video** (#28), and **an image post drew nothing at all** when a degraded
  still was addressed at the video's dimensions (#17).

## [0.9.0] — 2026-07-30

Renamed to **mbedfx**, on **mbedfx.app**. PeerTube joined as the fourth fediverse platform, YouTube
learned to say when a video is age-restricted, and Facebook group posts became routable. (#5–#16)

The project is **mbedfx**, served from **mbedfx.app**. The original zone is RETAINED and
still serves: a link already pasted into a Discord channel resolves only while its host
does, so cutting over would break every message anyone has already sent. Retiring it is a
later, separate decision.

- **Four routes across two zones** (`mbedfx.app`, `staging.mbedfx.app`, plus the two
  original hostnames). The response cache already keys on origin, so each hostname keeps
  its own rendered card and cannot serve another's urls — a property that was added for
  the 2026-07-25 apex cutover and is now load-bearing twice over.
- **`OWN_HOSTS` gained `mbedfx.app`, and a test now enforces the coupling.** A fediverse
  ref names its own origin, so `/{our-own-host}/post/1` would induce the Worker to fetch
  itself back through the edge, where Cloudflare's default subrequest behaviour bypasses
  the zone's own WAF. Adding a route while forgetting `OWN_HOSTS` is a *silent* SSRF hole —
  the domain serves normally and nothing fails. `test/smoke.test.mjs` now asserts every
  configured route is refused by `fetchableInstance`, verified to fail when the entry is
  removed. wrangler.jsonc claimed this coupling before; nothing made it true.
- **The R2 bucket and analytics dataset were renamed, and neither migrates.** R2 buckets
  cannot be renamed in Cloudflare: `mbedfx-media` is a NEW, EMPTY bucket and
  `fxeverything-media` keeps its objects. That is safe *only* because every object in it is
  a regenerable mux artefact keyed by refKey — the cost is that each video muxes once more.
  Delete the old bucket once traffic has moved or it bills for storage nobody reads.
  Likewise `mbedfx_counters` starts at zero; the history stays queryable in the old dataset.
- **The response-cache namespace moved** (`cache.fxeverything.internal` →
  `cache.mbedfx.internal`), which flushes every cached card. That is deliberate: the cached
  markup carries the old `og:site_name`, so the flush is what makes the rename visible
  rather than something to work around.
- **Dated docs under `docs/research/` and `docs/superpowers/` were deliberately NOT
  rewritten.** They record what was designed and measured on specific days, including the
  literal commands run; renaming inside them would falsify the record rather than update it.

## [0.8.0] — 2026-07-29

### Added
- **The fediverse family** — Mastodon, Pleroma, Akkoma, Misskey, Sharkey, Iceshrimp and PieFed, any
  instance, no per-instance configuration. (#4)

## [0.7.0] — 2026-07-27

### Added
- **Twitch clips, Lemmy and Pinterest.** (#3)

### Fixed
- Instagram false-private and copyright-blocked reels, Facebook share links, the Twitter age
  gate (#1), and an Instagram carousel that served a square crop instead of the whole thing (#2).

## [0.6.0] — 2026-07-26

### Added
- **Dailymotion, Streamable and Imgur** — the yt-dlp tier, where the platform hands out no useful
  metadata surface and the container does the extraction.

## [0.5.0] — 2026-07-24

### Added
- **YouTube** and **Facebook**.

## [0.4.0] — 2026-07-21

### Added
- **Twitter**, **Threads** and **Reddit**.

## [0.3.0] — 2026-07-19

### Added
- **TikTok** and **Instagram** — the first platforms needing a browser-shaped request rather than a
  crawler UA, which is where "assert on content, never on status" was learned.

## [0.2.0] — 2026-07-18

All four images, formatted text, quote and reply context in one Discord embed — by
advertising a Mastodon instance and letting Discord fetch the post as a Mastodon
`Status`. NOT YET VERIFIED IN A REAL DISCORD CLIENT (see the gate below).

- Discord (on a post with usable media) now gets a head with **zero `og:image`**, a
  `rel=alternate application/activity+json` link and a `json+oembed` link. Discord
  takes the last path segment of the activity href and calls
  `GET /api/v1/statuses/{id}`, which returns a Mastodon Status carrying every image in
  `media_attachments`. `/_oembed/{id}` supplies the author line.
- Every platform, phase and decision here was derived from **probing live FxEmbed** and
  reading its MIT source, not from the docs — see
  `docs/research/2026-07-18-phase-2-mastodon-spoof-wire-spec.md`. Four things the
  original plan had wrong are recorded there with the evidence that overturned them.
- The status id is **pure digits with a nonzero leading sentinel**, so it looks like a
  Mastodon snowflake and no layer can eat a leading zero by numeric normalization.
- `api`, `users` and `_oembed` are **shape-matched with fallthrough, never reserved**.
  `@api` is a live X account, so `/api/status/123` still routes as a real post — the
  same defect class Phase 1 had to fix for `/x/status/123`.
- Newlines use two U+FE00 per `<br>` (Discord trims a bare blank line); structural gaps
  use a bare `<br><br>`, which is how a user's blank line stays distinguishable.
- Counts live in the Mastodon `content` and the oEmbed `author_name`, and **never** in
  `og:description` — that pairing is the actual double-render trap.
- A quoted post's media is hoisted into the parent's attachments, so a quote-only post
  is no longer imageless. Parent indices are unchanged, so the change is purely additive.
- Telegram gets its own renderer: one image plus the richer text, no spoof. A mosaic
  composite (what FxEmbed serves Telegram) is an accepted divergence, not a gap.
- Text-only Discord posts deliberately stay on Phase 1's plain-og path — the one
  rendering a human has actually confirmed in a real client.

215 tests, `node --test`; `tsc --noEmit` clean. `megapenispoopenfarten.sex` untouched.

**REMAINING GATE (needs a human):** paste a multi-image Bluesky post into real Discord
clients — desktop, Android and iOS. The embed debugger does not render these paths
faithfully. If the gallery does not appear, revert the gate's second operand in
`src/render/discord.ts`; the plan's native-multi-og fallback was never built.

## [0.1.0] — 2026-07-17

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
- Bluesky HLS video renders as its thumbnail image (Discord can't play `.m3u8`); real
  playback deferred to Phase 2.
- Analytics are counters only — no URLs, post IDs, or IPs.
- Deployed to `staging.megapenispoopenfarten.sex` (a specific route that beats the fxtiktok `*.megapenispoopenfarten.sex/*` wildcard by specificity). `megapenispoopenfarten.sex` still serves the
  live `fxtiktok` worker, untouched — the Phase 3 cutover is when that changes.

95 tests, `node --test`; `tsc --noEmit` clean.
