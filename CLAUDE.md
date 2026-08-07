# mbedfx AI assistant guide

mbedfx turns a social-media link into an embed card Discord can draw. Swap the site's domain for
`mbedfx.app` and the same post unfurls with the author, the caption, the counts, and a video that
plays inline.

- Stack: Cloudflare Workers + R2 + Durable Objects + a `yt-dlp`/`ffmpeg` container.
- Language: TypeScript, no framework, no bundler. Workers runs the modules directly.
- UI: `public/index.html`, one file of hand-written vanilla JS and CSS. Its visible copy carries no
  em dashes and no second person. The owner asked for that, later edits re-broke it within a day,
  and a test now asserts it.
- Version: 1.9.0.

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
  `normalize.ts`. Captured fixtures test the pure half, and the whole suite runs offline in ~20s.
  Keep the judgement in the pure half.

## Layout

| Path | What lives there |
|---|---|
| `src/router.ts` | url → `Route`. **Host-agnostic.** Reads only pathname and query |
| `src/refkey.ts` | **the security boundary.** What crosses the wire and comes back; kind lists are allowlists |
| `src/worker.ts` | dispatch, caching, deadlines, the container calls |
| `src/platforms/<site>/` | `fetch.ts` (I/O) + `normalize.ts` (pure) |
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
  `test/refkey.test.mjs` are hand-enumerated (`['watch','reel','share','group','post']` at `:177`),
  so a new kind stays uncovered until you add it in both places. `test/prep.test.mjs:791` parses the
  `Route` union out of `src/types.ts` and fails on an unlisted kind. Until the refkey tests derive
  their list the same way, treat the allowlist as unguarded.
- A cache key has to capture what produced the answer. The translation cache was keyed on the post
  text alone, so changing the model couldn't invalidate a stale answer. Hence `XLATE_GENERATION` and
  `RESOLVER_GENERATION`. Bump them when the engine, prompt or stored shape changes.
- A degraded card must not be response-cached. A video still muxing renders its cover image, and
  caching that means the real video never appears. Same for a translation that lost its race.
- Every deadline is a budget on the whole response, not on one step of it. `META_WAIT_API_MS` sat at
  4000 while the extract it waited for took 2.3–6.7s. First pastes rendered the epoch and
  self-healed on the second view, which is why the defect survived so long.
- The converter preview is a third seam. Two of the lessons above assume a next render: the
  uncached degraded card, and the translation that lands in R2 for the next reader. `/_card` is
  fetched once per typing-settle and drawn, and nobody re-pastes to heal it. When you fix a head,
  check what the preview does. Skipping that shipped two defects in one day: the 1970 epoch on every
  YouTube preview, because only Discord's own unfurl warmed the date, and translations that looked
  unreliable because the preview's budget went to a mux queued ahead of it.
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
| No public JSON API | Closed. `/_api/v1?url=…` is documented in `docs/API.md` and shares `describeTarget` with `/_card`, so it cannot drift from the other three surfaces. Two rivals publish an API, FxEmbed ships OpenAPI specs, and there is no spec here yet, which is the most conspicuous omission left. |
| No realistic self-hosting | Open, with no known blocker. The suite runs in stock Node against `src/worker.ts`, `handle()` is already an adapter entry point, six of the eight Cloudflare surfaces it touches need only an object literal, and `container/` has no Cloudflare surface at all. Three rivals hand over a container and this repo documents `wrangler dev`. What's missing is an adapter and somebody to run it. The unknown is egress IP. Plan in `docs/SELF-HOSTING.md`. |
| No profile embeds | vxTwitter renders bare profiles. The router has no profile route kind. |
| No operator metrics | Half closed. `docs/METRICS.md` documents the Analytics Engine SQL read path. There is deliberately no scrape endpoint: an in-Worker one would need an account-scoped API token at the edge, and `pool_unused` publishes whether the account pools are loaded. fxTikTok has a `/metrics`; this Worker doesn't. |
| No card screenshots in the README | Four of the five show the card their project produces. The README shows a designed banner. |

Do not assume the converter page is unique. InstaFix Revived ships one. This one adds cross-site
detection, the ambiguity chooser, share-code unfurling, and a preview of the card before the link is
sent.

## Identity

This repo sits under a folder pinned to the `shamu4life` GitHub identity. Use `gh` for issues and
PRs. Do not switch accounts or override `GH_TOKEN`. If the identity guard blocks something, surface
it. Do not route around it.
