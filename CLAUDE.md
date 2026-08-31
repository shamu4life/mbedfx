# mbedfx AI assistant guide

mbedfx turns a social-media link into an embed card Discord can draw. Swap the site's domain for
`mbedfx.app` and the same post unfurls with the author, the caption, the counts, and a video that
plays inline.

- Stack: Cloudflare Workers + R2 + Durable Objects + a `yt-dlp`/`ffmpeg` container.
- Language: TypeScript, no framework, no bundler. Workers runs the modules directly.
- UI: `public/index.html`, one file of hand-written vanilla JS and CSS. Its visible copy carries no
  em dashes and no second person. The owner asked for that, later edits re-broke it within a day,
  and a test now asserts it.
- Version: 1.13.1 (`package.json` is authoritative; this line has been stale before).

## What gets a PR sent back

- Assert on content, never on status. Several upstreams answer `HTTP 200` with a decoy: a login
  wall, an empty shell, a 599 KB page with no post in it. `res.ok` proves nothing. Check for the
  thing you actually need.
- Measure from a Worker, and say in the comment where you measured. A datacenter IP and a
  residential one get different bytes from the same URL. Facebook's 302, Reddit's anonymous reads
  and Google Translate's `sl=auto` each worked from a laptop and did nothing in production.
- Comment the why, not the what. Record what can't be recovered later: what was measured, what was
  tried and failed, and what breaks if this gets "simplified". A comment calling a rule deliberate
  should say what goes wrong without it.
- Do not guess. If something can't be determined, say so on the card. Never invent a plausible value
  to fill a hole.
- Keep fetching and normalising separate. Every platform has a `fetch.ts` for the I/O and a pure
  `normalize.ts`. Captured fixtures test the pure half, and the whole suite runs offline in ~30s.
  Keep the judgement in the pure half.

## Layout

| Path | What lives there |
|---|---|
| `src/router.ts` | url → `Route`. **Host-agnostic.** Reads only pathname and query |
| `src/refkey.ts` | **the security boundary.** What crosses the wire and comes back; kind lists are allowlists |
| `src/worker.ts` | dispatch, caching, deadlines, the container calls |
| `src/platforms/<site>/` | `fetch.ts` (I/O) + `normalize.ts` (pure) |
| `src/fetchretry.ts` | `askTwice`, the one extra ask every platform fetcher goes through. The three exempt call sites say `NO-RETRY` and why |
| `src/render/` | the two heads, the Mastodon spoof, failure cards |
| `src/render/embed.ts` | shared predicates: `usable`, `mediaOf`, `themeColor`, `byline` |
| `src/render/text.ts` | `statParts`, the quote block, the plain-text builders |
| `src/translate.ts` | detection, translation, the marker |
| `container/server.py` | the `yt-dlp` + `ffmpeg` resolver |
| `public/index.html` | the converter page |
| `docs/API.md` | the published `/_api/v1` contract. Read it before changing anything it names |

## Things that have bitten this project, so you do not repeat them

- Discord reads two documents. A post with media renders from the Mastodon-shaped status behind
  `<link rel="alternate" type="application/activity+json">`, one without renders from the plain
  OpenGraph head. Fix one head and half the cards still break. The translation bug and the YouTube
  age-note bug were both this shape.
- `theme-color` is a standard HTML meta, not an og tag, and takes `name=`. The `property=` spelling
  shipped for the entire life of the feature and left every card uncoloured. Both spellings are
  emitted now, from one value.
- `parseRefKey` is an allowlist, and forgetting a kind is silent. `fb:group:…` was unparseable for
  weeks, every group-post image 404'd at `/_media/`, and nothing failed loudly. Adding a `PostRef`
  kind means adding it here too.
- Nothing catches that omission, and this guide used to claim otherwise. The round-trip tests in
  `test/refkey.test.mjs` are hand-enumerated (`['watch','reel','share','group','post','photo']` at
  `:177`), so a new kind stays uncovered until you add it in both places. `test/prep.test.mjs:873`
  parses the `Route` union out of `src/types.ts` and fails on an unlisted kind. Until the refkey
  tests derive their list the same way, treat the allowlist as unguarded.
- A cache key has to capture what produced the answer. The translation cache was keyed on the post
  text alone, so changing the model couldn't invalidate a stale answer. Hence `XLATE_GENERATION`,
  `META_GENERATION` and `RESOLVER_GENERATION`. Bump `XLATE_GENERATION` when the engine or prompt
  changes, `META_GENERATION` when a stored record's shape or meaning changes, `RESOLVER_GENERATION`
  to force pooled container instances onto a new image. `RESOLVER_GENERATION` does that by naming
  the Durable Objects, which makes it the lever that ends a bad-image outage: it was spent for
  exactly that on 2026-08-28 with every record perfectly fine, because a pooled instance keeps
  running the image it booted with until it idles out, `sleepAfter` is five minutes that ANY request
  resets, and under live traffic the broken instances were being held open by the very requests they
  were failing. The last two were one string until 2026-08-29; splitting them made
  UNDER-invalidation possible for the first time, and that is the worse direction, so when it is
  unclear, bump `META_GENERATION`.
- And a TTL has to match how long the answer stays true, not how long it is convenient to keep.
  YouTube meta records hold for 30 days because an upload date cannot change — then one mutable
  field (`isLive`) moved in and a finished broadcast kept saying "live" for a month. `YT_LIVE_TTL_MS`
  is the fix and the shape to copy: expire on the record's content, not on one number for the file.
- A degraded card must not be response-cached. A video still muxing renders its cover image, and
  caching that means the real video never appears. Same for a translation that lost its race.
- Every deadline is a budget on the whole response, not on one step of it. `META_WAIT_API_MS` sat at
  4000 while the extract it waited for took 2.3 to 6.7s. First pastes rendered the epoch and
  self-healed on the second view, which is why the defect survived so long. The activity route's
  three per-arm budgets (`YT_MUX_BOT_MS`, `YT_META_BOT_MS`, `MUX_WAIT_BOT_MS`) are not that mistake
  and the difference is why: they race in one `Promise.all`, so the response still ends at the
  slowest of them, and the number that has to stay under Discord's tolerance is the max, not the sum.
  `test/card-muxing.test.mjs` asserts that.
- The converter preview is a third seam. Two of the lessons above assume a next render: the
  uncached degraded card, and the translation that lands in R2 for the next reader. `/_card` is
  fetched once per typing-settle and drawn, and nobody re-pastes to heal it. When you fix a head,
  check what the preview does. Skipping that shipped two defects in one day: the 1970 epoch on every
  YouTube preview, because only Discord's own unfurl warmed the date, and translations that looked
  unreliable because the preview's budget went to a mux queued ahead of it.
- Python ends a class at the first unindented line, so an edit that lands below `class Handler`
  silently stops being a method. 1.11.0 shipped a container whose `do_GET` and `do_POST` had been
  demoted that way, and `BaseHTTPRequestHandler` answered every request with `501 Unsupported
  method`: `/health` and every mux on every platform broke together. `container/test_server.py`
  now asserts the SHAPE rather than the behaviour, because shape is what the bad edit changed —
  the request methods must belong to `Handler`, and the probe helpers must not.
- A green `/_smoke` does not mean the container is alive. It stayed 17 of 17 green through that
  entire outage, because most of its checks never reach the resolver and YouTube's metadata now
  comes from Innertube rather than from `yt-dlp` — so the one platform most likely to expose a
  dead container had stopped depending on it. 1448 tests passed alongside it: the Worker suite
  stubs the container out, and the Python suite exercises the pure helpers, which were never the
  broken part. `/_smoke` says the heads still render. `/_clients` is the check that reaches the
  container. Since 2026-08-29 the yt row asks for one thing more: `expect: 'video'` reports
  `no-video` on a YouTube card that came back with no player, which is the state a cut crawler
  budget leaves it in. That does not close this gap, because a warm mux in R2 answers the check
  whether or not the container is running.
- A PO token minter buys this project nothing, and re-opening that question costs weeks. Measured
  2026-08-28 through `/_clients` on production egress: five of six player clients served bytes
  with no token at all, including `tv_simply` and `mweb`, which are precisely the two yt-dlp's own
  PO Token Guide says require one. Five minters were built and tested before that, and every
  positive result had an equally green no-token control. Two readings from the same run are worth
  keeping because both contradict the published table: `web_safari` works from Cloudflare where it
  failed residentially on the same video, and `android_vr` is refused from this egress although
  the table lists it as needing nothing. There is also no working YouTube age-gate bypass — 68
  candidate repositories were checked and none works.
- `git add -A` sweeps in agent scratch. `.gitignore` has four essays about this. Always use
  slashless patterns. A `dir/` pattern won't match a symlink or a path that doesn't exist yet.

## Testing

`node --test`, no test framework. Test names are sentences stating the rule, and the body
explains the defect it prevents.

- Never touch the network. Stub `fetch`.
- Where module-level in-flight maps are involved, give every test you write its own id, or one
  test's parked promise becomes another test's answer.
- When behaviour changes, rewrite the test that pinned the old behaviour instead of deleting it, and
  say what you changed and why.

## Deploying

Do **not** run `wrangler deploy` by hand. Cloudflare Workers Builds watches `main`, and what you
merge is what deploys. `npm run deploy` refuses on purpose. A hand deploy overwrites whatever the
build shipped, and prod goes on looking healthy. That has cost this project real downtime.

`npm run build` (tests + typecheck) is the gate Workers Builds runs. A red suite ships nothing.

Merging two PRs back-to-back races their builds, and the older commit can win. Wait for one deploy
before you merge the next, and verify against the deployed bundle. A green check doesn't say which
commit is live.

## Against the other embed fixers

Measured 2026-08-01 against FxEmbed, vxTwitter, fxTikTok, InstaFix and InstaFix Revived. The README
carries the feature table, and this section is not for publishing.

FxEmbed has three years of production traffic behind it, vxTwitter four. This project is the newest
of the six by years, and no crowd has hit it yet. Treat "it works" as provisional until it has
survived a crowd, and expect first real traffic to find what the test suite cannot.

Breadth is the differentiator and the liability at once. Seventeen platforms of undocumented
endpoints break independently, on their own schedule. Nobody else runs more than four live embed
domains, which is the genuine advantage and also why failure cards and degrade paths matter more
here than in a single-platform fixer.

| Gap | Where it stands |
|---|---|
| No public JSON API | Closed. `/_api/v1?url=…` is documented in `docs/API.md` and shares `describeTarget` with `/_card`, so it cannot drift from the other three surfaces. Two rivals publish an API and FxEmbed ships OpenAPI specs; `public/openapi.json` (OpenAPI 3.1) is served at `/openapi.json` since 2026-08-12, and a derive-and-compare test fails when it drifts from the code that answers. Writing it is what found a live wrong answer: a walled TikTok share code was published as `not_a_post` about a post that exists. |
| No realistic self-hosting | Open, with no known blocker, and the SAFETY half is now closed. The suite runs in stock Node against `src/worker.ts`, `handle()` is already an adapter entry point, six of the eight Cloudflare surfaces it touches need only an object literal, and `container/` has no Cloudflare surface at all. Since 2026-08-12 the corrections that stood between "it would run" and "it would be safe to expose" have landed: the private-address guard the Worker half never had (`src/netguard.ts`, ported from `container/server.py`, with a `RESOLVE_HOST` seam for the DNS half a Worker cannot do), a configurable and additive `OWN_HOSTS`, a Twitter guest-token cache that works where the `cf` fetch option is ignored, a bound on the mux buffering fallback, and the `CacheLike` contract written down. Three rivals hand over a container and this repo documents `wrangler dev`. What's missing is an adapter and somebody to run it. The unknown is egress IP. Plan in `docs/SELF-HOSTING.md`. |
| No profile embeds | Closed where it was real, and measured closed where it was not. `/profile/{handle}` renders a Bluesky account (bio, avatar, three counts, join month) because bsky.app hands a crawler `og:title` and nothing else. Measured 2026-08-11 from Cloudflare egress, x.com, tiktok.com and instagram.com all already answer a crawler with a complete profile card, so a route for them would duplicate what Discord draws; Instagram's profile surfaces are additionally walled from this egress (HTTP 429, zero bytes, with a post-page control at 254 KB). Bare `/{handle}` and `/@{handle}` stay choosers: each names an account on two sites at once, so claiming one serves a card from a site nobody pasted. vxTwitter can claim bare handles because it serves one platform. |
| No operator metrics | Half closed. `docs/METRICS.md` documents the Analytics Engine SQL read path, and since 2026-08-12 a half-hourly cron renders one known post per platform through this worker's own handler and counts whether a real card came back (`src/smoke.ts`, `/_smoke`), added because Facebook was broken for up to a week and the detector was the owner pasting a link. That is a breakage detector, not an uptime monitor: it runs inside the worker it checks. There is deliberately no scrape endpoint: an in-Worker one would need an account-scoped API token at the edge, and `pool_unused` publishes whether the account pools are loaded. `/_clients` joined it on 2026-08-28, a sibling probe that runs inside the container on production egress and reports which YouTube player clients actually serve bytes; it takes no input and rides the existing authenticated `/resolve`, so it opens no new surface, and it degrades to 503 or 502 rather than 500 because a diagnostic that crashes tells an operator less than one that says it could not reach the container. It exists because `/_smoke` stayed green through a total container outage the same week. fxTikTok has a `/metrics`; this Worker doesn't. |
| No card screenshots in the README | Four of the five show the card their project produces. The README shows a designed banner. |

Do not assume the converter page is unique. InstaFix Revived ships one. This one adds cross-site
detection, the ambiguity chooser, share-code unfurling, and a preview of the card before the link is
sent.

## Identity

This repo sits under a folder pinned to the `shamu4life` GitHub identity. Use `gh` for issues and
PRs. Do not switch accounts or override the token env. If the identity guard blocks something,
surface it. Do not route around it.

**One sanctioned exception, and it is not a violation to be tidied away.**
`.github/workflows/ytdlp-freshness.yml` commits and opens its weekly bump PR as
`github-actions[bot]`. The owner chose that on 2026-08-17, over an issue-only variant and over
adding a PAT, and it is recorded in the workflow's own header. The exception is narrow by
construction: the job only rewrites a version string in `container/Dockerfile` on a side branch, and
it cannot merge, cannot deploy, and touches nothing else. Leave it alone, or ask before changing it.
Do not restore it to the owner's account unasked, and do not widen it to any other job.

Editing that file from a shell trips the identity guard, which pattern-matches the git
author-configuration lines it CONTAINS without being able to tell a workflow's contents from a
command being run. That is the guard working as designed rather than a bug to evade: surface it, as
above, and edit the file with a file-editing tool instead of a shell heredoc. Rewording prose to
dodge a false positive is fine; disabling or bypassing the guard is not.
