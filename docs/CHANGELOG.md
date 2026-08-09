# Changelog

All notable changes to mbedfx are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.9.1] — 2026-08-09

Five merges shipped under 1.9.0 without a bump, which is the defect this entry opens with. Nothing
forces one: `landing-convert.test.mjs` pins the site badge to package.json, so the four places the
number lives cannot DISAGREE, but a release that changes none of them still looks like the last one
from the outside. Patch, because none of it is new public surface — the JSON API is unchanged.

Two upstreams changed under the service inside eight days, and three of these five are the answer to
that rather than to anything in the repo.

### Facebook posts stopped rendering, and now read off the embed plugin

#### Fixed
- Every spelling of a post — `/share/p/{code}`, `story.php`, `/{page}/posts/{pfbid}` and
  `/{ownerId}/posts/{id}` — answered the failure card. Meta began requiring a login for the post
  surfaces from datacenter egress: measured 2026-08-08 from Cloudflare, the permalink returns 324,247
  bytes with NO og: tags in four different client shapes, and `/share/{code}` and `mbasic` both
  redirect to a login wall. The same urls from a residential ip built the full card, which is what
  made it look like a code defect.

  `facebookPluginCard` reads the byline, caption, canonical and photos out of `/plugins/post.php`,
  Meta's own embed endpoint, which is not behind that wall. It runs AFTER the og: surface, so a post
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
  production on four cold videos: the card took 5.14–5.18s and the activity document 8.19–8.29s,
  against a crawler that leaves at 3–4s. Every budget involved was individually argued — the head
  spends `HTML_DEADLINE_MS` on the mux, the activity route spends `MUX_WAIT_API_MS` on the mux,
  `META_WAIT_API_MS` on the date and a slice on the translation — and each was tuned to make the card
  RIGHT on the first paste. Together they made it absent.

  The wait bought nothing: a warm mux is a 300ms R2 head, and a cold one measured ~5s for a
  60-second Short, so no budget a crawler tolerates was going to catch it. `MUX_WAIT_BOT_MS` (1500)
  now caps the crawler-facing seams; measured after, the card is 0.36–1.84s and the activity document
  0.23–1.63s. `/_api/v1` and `/_card` keep the long budget: a human is watching a spinner there, and
  that surface is what warms a link deliberately.

  A first paste now shows the thumbnail rather than a player, without counts, and dated the epoch —
  the Mastodon document always emits a `created_at`, so an unknown date renders as 1 January 1970.
  Every later view has all three. Suppressing the field is the real fix and is deliberately not
  attempted: a document missing a required field may be rejected outright, which reintroduces exactly
  the defect this removes.

### Diagnosis

#### Added
- `translate_pending` counts a translation that loses its deadline race. `translated` and
  `translate_fallback` fire only when one ARRIVES, so the state that makes a post render uncached on
  every unfurl left no trace — and Workers Logs are off on purpose, because they persist the pasted
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
  video. Measured 2026-08-09 from Cloudflare, it returns 33,227 bytes of `text/html` — a 404 page at
  HTTP 200 — byte-identical across three videos and both user agents, while residential still gets
  the video. Discord's proxy is not Cloudflare and still plays these, so TikTok video is not broken;
  what it rules out is ever proxying or muxing that video through the Worker or the container.

---

## [1.9.0] — 2026-08-04

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
  request for seven days, each carrying the whole request url — on this Worker, the post somebody
  pasted — with the client IP, user agent and geolocation beside it. `src/analytics.ts` meanwhile
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

## [1.8.0] — 2026-08-03

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

## [1.7.0] — 2026-08-03

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
  spread, which kept `remux` and lacked `posterOnly` — the combination that renders as nothing at all,
  and the defect `posterOnly` was introduced to fix.

- `settleMux` armed a 9-second timer it never cleared, on every render that reached the race, even
  when the container answered instantly. The `deadline()` helper already existed and already cleared
  its timer, and its own comment records that this cost the test suite 6 seconds before it was fixed
  there. Now used here too.

- The muxing spinner was drawn on the one entry that can never be it. Written first as
  `m.video ? (muxing ? spinner : play) : ''`, which never fired, because a degrading video becomes
  kind `image`. The entry the spinner exists for reported `video: false` and took the empty branch.

---

## [1.6.2] — 2026-08-03

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

## [1.6.1] — 2026-08-03

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

## [1.6.0] — 2026-08-03

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

## [1.5.0] — 2026-08-03

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

## [1.4.0] — 2026-08-02

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

## [1.3.0] — 2026-08-02

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

## [1.2.1] — 2026-08-02

### Fixed
- The `fx` mark in the README banner still read as off centre. The previous fix baked it to a PNG so
  it no longer depended on the viewer's font, and centred it on its ink box, which measured exactly
  0.00, 0.00 against the tile and was still wrong to look at. "fx" has an ascender and no descender,
  so its visible weight is not where its bounding box is. The alpha-weighted centroid sat at 54.02,
  57.71 in a 112 tile, about two units left and 1.7 down. The mark is now placed on that centroid.

1133 tests, `node --test`; `tsc --noEmit` clean.

---

## [1.2.0] — 2026-08-02

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
  crawler from the datacenter and yt-dlp extracts the video anyway — precedent, not proof.

---

## [1.1.1] — 2026-08-02

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

## [1.1.0] — 2026-08-02

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

## [1.0.1] — 2026-08-02

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
  translation fell to its 300ms floor. Google is measured at 217–798ms. A 300ms race wins some of the
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

## [1.0.0] — 2026-08-01

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

## [0.11.0] — 2026-08-01

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

## [0.10.0] — 2026-07-31

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

## [0.9.0] — 2026-07-30

Renamed to mbedfx, on mbedfx.app. PeerTube joined as the fourth fediverse platform, YouTube
learned to say when a video is age-restricted, and Facebook group posts became routable. (#5–#16)

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

## [0.8.0] — 2026-07-29

### Added
- The fediverse family: Mastodon, Pleroma, Akkoma, Misskey, Sharkey, Iceshrimp and PieFed, any
  instance, no per-instance configuration. (#4)

## [0.7.0] — 2026-07-27

### Added
- Twitch clips, Lemmy and Pinterest. (#3)

### Fixed
- Instagram false-private and copyright-blocked reels, Facebook share links, the Twitter age
  gate (#1), and an Instagram carousel that served a square crop of a wider image (#2).

## [0.6.0] — 2026-07-26

### Added
- Dailymotion, Streamable and Imgur, the yt-dlp tier, where the platform hands out no useful
  metadata surface and the container does the extraction.

## [0.5.0] — 2026-07-24

### Added
- YouTube and Facebook.

## [0.4.0] — 2026-07-21

### Added
- Twitter, Threads and Reddit.

## [0.3.0] — 2026-07-19

### Added
- TikTok and Instagram, the first platforms needing a browser-shaped request, which is where
  "assert on content, never on status" was learned.

## [0.2.0] — 2026-07-18

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
- Bluesky HLS video renders as its thumbnail image, because Discord can't play `.m3u8`. Real
  playback deferred to Phase 2.
- Analytics are counters only: no URLs, post IDs, or IPs.
- Deployed to `staging.megapenispoopenfarten.sex` (a specific route that beats the fxtiktok `*.megapenispoopenfarten.sex/*` wildcard by specificity). `megapenispoopenfarten.sex` still serves the
  live `fxtiktok` worker, untouched, until the Phase 3 cutover.

95 tests, `node --test`; `tsc --noEmit` clean.
