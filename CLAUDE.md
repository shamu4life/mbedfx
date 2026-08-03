# mbedfx — AI Assistant Guide

A Cloudflare Worker that turns a social-media link into an embed card Discord can draw. Swap the
site's domain for `mbedfx.app` and the link still points at the same post, but now it unfurls with
the author, the caption, the counts, and a video that plays inline.

**Stack:** Cloudflare Workers + R2 + Durable Objects + a `yt-dlp`/`ffmpeg` container
**Language:** TypeScript, no framework, no bundler — Workers runs the modules directly
**UI:** `public/index.html`, hand-written vanilla JS and CSS, one file — its VISIBLE copy carries no
em dashes and no second person (owner's call; asserted by a test, because both were re-broken by
later edits within a day of being asked for)
**Tests:** `node --test`, no test framework, no network
**Deploy:** Cloudflare Workers Builds on merge to `main` — **merging is the deploy**
**Version:** 1.8.0

---

## Five things that get PRs sent back

**1. Assert on CONTENT, never on status.** Several upstreams here answer `HTTP 200` with a decoy — a
login wall, an empty shell, a 599 KB page containing no post. `res.ok` proves nothing. Check for the
thing you actually need.

**2. Say WHERE you measured.** A datacenter IP and a residential one get different bytes from the
same URL. It has happened with Facebook's 302, Reddit's anonymous reads, and Google Translate's
`sl=auto` — each worked from a laptop and did nothing in production. Measure from a Worker, and say
so in the comment.

**3. Comment the WHY, not the what.** The code says what it does. Comments record what cannot be
recovered later: what was measured, what was tried and failed, and what breaks if this is
"simplified". A comment claiming a rule is deliberate should say what goes wrong without it.

**4. Don't guess.** If something cannot be determined, say so on the card. Never invent a plausible
value to fill a hole.

**5. Fetching and normalising are separate.** Every platform has a `fetch.ts` (I/O) and a
`normalize.ts` (pure). The pure half is tested against captured fixtures, so the whole suite runs
offline in ~20s. Keep judgement in the pure half.

---

## Layout

| Path | What lives there |
|---|---|
| `src/router.ts` | url → `Route`. **Host-agnostic** — reads only pathname and query |
| `src/refkey.ts` | **the security boundary.** What crosses the wire and back. Kind lists are allowlists |
| `src/worker.ts` | dispatch, caching, deadlines, the container calls |
| `src/platforms/<site>/` | `fetch.ts` (I/O) + `normalize.ts` (pure) |
| `src/render/` | the two heads, the Mastodon spoof, failure cards |
| `src/render/embed.ts` | shared predicates — `usable`, `mediaOf`, `themeColor`, `byline` |
| `src/render/text.ts` | `statParts`, the quote block, the plain-text builders |
| `src/translate.ts` | detection, translation, the marker |
| `container/server.py` | the `yt-dlp` + `ffmpeg` resolver |
| `public/index.html` | the converter page |

---

## Things that have bitten this project, so you do not repeat them

**Discord reads TWO documents.** A post *with media* is drawn from the Mastodon-shaped status behind
`<link rel="alternate" type="application/activity+json">`; a post *without* is drawn from the plain
OpenGraph head. **Fix one head and not the other and half the cards still break.**
The translation bug and the YouTube age-note bug were both this.

**`theme-color` takes `name=`, not `property=`.** It is a standard HTML meta, not an og tag. We
shipped `property=` for the entire life of the feature and every card was uncoloured. Both spellings
are emitted now, from one value.

**`parseRefKey` is an allowlist, and forgetting a kind is silent.** `fb:group:…` was unparseable for
weeks — every group-post image 404'd at `/_media/` and nothing failed loudly. Adding a `PostRef`
kind means adding it here too, and there is a sweep test that fails until you do.

**Cache keys must capture what PRODUCED the answer, not just the question.** The translation cache
was keyed on the post text; changing the model then could not invalidate a stale answer. Hence
`XLATE_GENERATION` / `RESOLVER_GENERATION` — **bump them when the engine, prompt or stored shape
changes.**

**A degraded card must not be response-cached.** A video still muxing renders its cover image; if
that were cached, the real video would never appear. Same for a translation that lost its race.

**Deadlines are budgets on the WHOLE response, not per-step.** `META_WAIT_API_MS` sat at 4000 while
the extract it waited for took 2.3–6.7s, so first pastes rendered the epoch — and self-healed on the
second view, which is why it survived so long.

**The converter preview is a THIRD seam, and it never gets a second chance.** Both self-heal lessons
above — a degraded card is not cached so the next render fixes it, a lost translation lands in R2 for
the next reader — quietly assume there IS a next render. `/_card` is fetched once per typing-settle
and drawn; nobody re-pastes to heal it. That assumption shipped two defects in one day: every YouTube
preview showed the 1970 epoch because only Discord's own unfurl warmed the date, and translations
looked "unreliable" because the preview's budget was spent by a mux it queued behind. **When you fix
something on the two Discord heads, ask what the preview does — it is the surface where "it heals
next time" means "it never heals".**

**`git add -A` sweeps in agent scratch.** `.gitignore` has four essays about this. Slashless
patterns, always: a `dir/` pattern does not match a symlink or a not-yet-existent path.

---

## Testing

`node --test`. Test names are sentences stating the rule; the body explains the defect it prevents.

- **Never touch the network.** Stub `fetch`.
- **Every test gets its own id** where module-level in-flight maps are involved — one test's parked
  promise otherwise becomes another test's answer.
- **When behaviour changes, REWRITE the test that pinned the old behaviour** — do not delete it. Say
  what changed and why.

---

## Deploying

**Never `wrangler deploy` by hand.** Cloudflare Workers Builds watches `main`; merging is the
deploy. `npm run deploy` refuses on purpose — a hand deploy overwrites whatever the build shipped
and prod goes on looking healthy. That has cost this project real downtime.

`npm run build` (tests + typecheck) is the gate Workers Builds runs. Red suite → nothing ships.

Merging two PRs back-to-back races their builds and the **older** commit can win. Wait for one
deploy before merging the next, and verify against the deployed bundle rather than a green check.

---

## Where this sits against the other embed fixers

Measured 2026-08-01 against FxEmbed, vxTwitter, fxTikTok, InstaFix and InstaFix Revived. The README
carries the feature table; this is the part that is useful to work from rather than to publish.

**We are the newest of the six by years.** FxEmbed has three years of production traffic behind it,
vxTwitter four. Every one of these has been beaten on by real users and this has not — so treat
"it works" as provisional until it has survived a crowd, and expect the first real traffic to find
things the test suite cannot.

**Breadth is both the differentiator and the liability.** Seventeen platforms of undocumented
endpoints is seventeen things that break independently, on their schedule. Nobody else runs more
than four live embed domains, which is the genuine advantage — but it is also why the failure cards
and the degrade paths matter more here than they would in a single-platform fixer.

**The gaps, in the order a reader of their READMEs would notice:**

| Gap | Where it stands |
|---|---|
| No public JSON API | Two rivals publish one; FxEmbed ships OpenAPI specs. The most conspicuous omission. |
| No realistic self-hosting | Three rivals hand you a container. We document `wrangler dev`. |
| No profile embeds | vxTwitter renders bare profiles. Our router has no profile route kind at all. |
| No operator metrics | fxTikTok documents Prometheus scraping. We have counters and no way to read them. |
| No card screenshots in the README | Four of the five show the card their project produces. We show a designed banner. |

**Do not assume the converter page is unique.** InstaFix Revived ships one too. What is actually
ours is cross-site detection, the ambiguity chooser, share-code unfurling, and previewing the card
before you send it.

---

## Identity

This repo lives under a folder pinned to the **`shamu4life`** GitHub identity. Use `gh` for issues
and PRs. Do not switch accounts or override `GH_TOKEN`. If the identity guard blocks something,
surface it rather than routing around it.
