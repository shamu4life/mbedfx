# Reading the counters

`src/worker.ts` calls `count()` from 62 sites and `countMux()` from 3 more, into the
`mbedfx_counters` Analytics Engine dataset. Nothing in the Worker reads it back. The queries below
do, run by hand from a laptop or a cron box against Cloudflare's account-level SQL API. (This said
49 until 2026-08-29 and had for some time; `grep -c 'count(env' src/worker.ts` is the check.)

These were written from this repo's source and from Cloudflare's documentation (fetched 2026-08-03,
those pages reading `Last updated Apr 23, 2026`) and were first run against the live account on
2026-08-29. Three things that page could not tell us, learned that day and now folded in above and
below:

- the table is `mbedfx_counters`, matching the binding in `wrangler.jsonc`. Every query here said
  `FROM mbedfx` and errored;
- a backslash in a string literal is rejected outright (HTTP 422), so `LIKE 'mux\_%'` never ran;
- **the data is sampled.** `_sample_interval` took values from 1 to 12 in the first window read, so
  a bare `COUNT()` under-reports badly. Every query below weights by it, and a ratio of two such
  sums is why sampling largely cancels.

`toDateTime('YYYY-MM-DD HH:MM:SS')` pins an absolute window; `NOW() - INTERVAL 'N' HOUR`,
`toStartOfHour()` and `quantileExactWeighted()` all work. `toStartOfInterval(timestamp, INTERVAL 30
MINUTE)` does not. Correct a query here when it comes back wrong.

---

## Cloudflare's observability surfaces

No single screen covers all seven. Each is switched on, billed and retained on its own.
Per-request means one record per request, including what the request was; streamed means kept
nowhere.

- **Workers Logs** (stored, per-request, off): one invocation log per request plus every
  `console.log`/`console.error`, indexed and queryable in the dashboard for 7 days. The only surface
  `observability.enabled` (`wrangler.jsonc:44`) controls.
- **Real-time logs / `wrangler tail`** (streamed, per-request, always available, no setting): the
  same events in a terminal or the dashboard's Live tab, stored nowhere. Four of the five
  `console.error` calls in `worker.ts` were written for it, each commented `SERVER-SIDE ONLY`, three
  of them `SERVER-SIDE ONLY (wrangler tail)`.
- **Workers Metrics** (stored, aggregate, automatic): request / error / CPU / wall-time charts on the
  Worker's dashboard page. No per-request detail, three months of history, no configuration, no
  price.
- **Analytics Engine** (stored, aggregate, on): the `mbedfx_counters` dataset `src/analytics.ts`
  writes into (`wrangler.jsonc:178`). Own config key, own write and read APIs, three months of
  retention, out of `observability.enabled`'s reach.
- **Workers Logpush** (export, off, own flag): the same trace events shipped off Cloudflare to R2, S3
  or a log vendor.
- **Tail Workers** (export, off, own config key): a second Worker receiving the telemetry stream,
  able to filter or transform before anything is stored.
- **Workers Traces** (stored, per-request, beta, off): spans of where time went inside one request,
  behind `observability.traces.enabled`, which `observability.enabled` does not imply.

Dashboard → Workers & Pages → Overview → mbedfx reaches all but one: metrics on that page, Workers
Logs under Observability, real-time logs under Logs → Live. Analytics Engine has no dashboard page.

### Why Workers Logs are off

`observability: { enabled: false }` sits at `wrangler.jsonc:44` for privacy, and read `true` until
2026-08-04 (`398f971`). Measured against this account that day, a stored invocation log carries the
full request URL including query string, the client IP (`cf-connecting-ip`), the verbatim user agent,
the referer, and Cloudflare's geolocation block (city, latitude/longitude, ASN, timezone). On this
Worker that url is the post somebody pasted, kept seven days. `count()` in `src/analytics.ts`
refuses to put any of it in a counter and records the precedent: TwitFix shut down in 2022 over a
public log of processed urls, with zero legal contact.

In exchange, a request that already failed cannot be searched for after the fact. The five
`console.error` calls still run, and nothing stores them. Reproduce the problem with
`npx wrangler tail mbedfx` running instead; the dashboard charts and everything in this document are
unaffected either way.

`wrangler tail` still works with `observability.enabled` off: streaming and storage are independent
consumers of one trace-event stream. Cloudflare's docs state it neither way. That left an
inference until 2026-08-05 (`64ff6f8`), when `npx wrangler tail mbedfx --format json` ran against the
live Worker with `observability: { enabled: false }` deployed, alongside three uncacheable requests,
and returned trace records carrying `scriptName: mbedfx`, `outcome: ok` and the request url. Their
`logs` array was empty, those requests having missed every `console.error` path: the run covers the
tail session delivering, not `console` output reaching it. Tail a failing path once for that. A
cached response never invokes the Worker and produces no record, which looks like a broken tail; test
with an uncacheable request.

`observability.logs.invocation_logs = false` is the middle position, not taken. It drops the
url/IP/user-agent record while keeping `console` output stored and searchable. Full off is stricter
and survives Cloudflare moving its field selection.

---

## What the Worker writes

```ts
// count(), src/analytics.ts
env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })
```

| Column | Holds | Values |
|---|---|---|
| `blob1` | platform | `x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `dm` `st` `im` `tw` `lm` `pn` `ms` `mk` `pt`, or `none` |
| `blob2` | outcome | one of the values in the `Outcome2` union (`src/analytics.ts`) |
| `blob3` | client class | `discord` `telegram` `other-bot` `human`, or `none` on a `mux_*` row (`card_degraded` carries a real one — see below) |
| `double1` | the literal `1` | always |
| `double2` | elapsed milliseconds | `mux_*` rows only; `0` on every other row |
| `timestamp` | set by the runtime | `DateTime`, always UTC |

Columns are 1-based: the first `blobs` element is `blob1`, and there is no `blob0`. `writeDataPoint`
passes no `indexes` array, leaving no `index1` to filter or group on; `blob1`/`blob2`/`blob3` are the
only dimensions. No urls, post ids, IPs or verbatim user agents (`count()`, `src/analytics.ts`).
Adding a url column breaks what that constraint protects.

`double1` is always 1. **`double2` is the one exception to "there are no durations here"**, added
2026-08-23 with the `mux_*` outcomes: it carries the elapsed milliseconds of a video mux. Before it,
nothing recorded how long a mux took even when it SUCCEEDED, so a report that a ten-minute video took
ten minutes to warm could only be answered with arithmetic. Every non-`mux_*` row leaves it unset,
which reads as `0` — so filter to the mux rows before averaging it, or the zeros will drag every
average to nothing. **Not with `LIKE 'mux\_%'`**: Analytics Engine SQL rejects a backslash in a
string literal outright (HTTP 422, `backslash and single-quote characters in strings are
unsupported`), so the escape that makes the underscore literal is not available. Enumerate the eight
outcomes instead, as the query below does.

### The mux rows

`blob3` is `'none'` on every one of them, deliberately. A cold video is asked for by the prewarm, the
HTML render and the activity render within ~2s of a single paste and `muxOnce` collapses all three
onto one piece of work, so no single client owns the mux and naming one would be arbitrary.

The eight outcomes are documented at their definition (`src/analytics.ts`). The split that matters
most: **`mux_timeout` is ours and `mux_gate` is theirs.** The container answers 502 for both a
non-zero yt-dlp exit and an empty result, so those are separated here into `mux_gate` and `mux_empty`
rather than left as one number that points at the wrong system.

```sql
-- Which half of the video pipeline is failing, per platform, and how slow the good ones are.
SELECT blob1 AS platform, blob2 AS outcome,
       SUM(_sample_interval) AS n,
       SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_ms
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob2 IN ('mux_ok','mux_gate','mux_timeout','mux_empty','mux_pool','mux_badsource','mux_error','mux_refused')
GROUP BY platform, outcome ORDER BY platform, n DESC
```

An average hides the shape here, and the shape is what decides whether a crawler budget can ever be
met. Use `quantileExactWeighted`, which works:

```sql
-- How long a SUCCESSFUL YouTube mux takes, weighted for sampling. Compare against the budget.
SELECT quantileExactWeighted(0.10)(double2, _sample_interval) AS p10,
       quantileExactWeighted(0.50)(double2, _sample_interval) AS p50,
       quantileExactWeighted(0.90)(double2, _sample_interval) AS p90,
       MIN(double2) AS fastest, SUM(_sample_interval) AS n
FROM mbedfx_counters
WHERE blob1 = 'yt' AND blob2 = 'mux_ok'
```

Read 2026-08-29 over the counter's whole history (n=139): p10 6922 ms, p50 18219 ms, p90 41254 ms,
fastest 4200 ms. **Zero of the 139 finished inside `MUX_WAIT_BOT_MS` (1500 ms), which was the crawler
budget for three weeks.** That is the measurement `YT_MUX_BOT_MS` was sized against, and it is a
better instrument than the `card_degraded` ratio below because it does not care about the traffic
mix. Full working in `docs/research/2026-08-29-the-1500ms-crawler-cut.md`.

### Reading `yt_innertube_ok` / `yt_innertube_fail`

The YouTube date, description, duration and age status come from `POST youtubei/v1/player` rather than
from the media container (see `src/platforms/youtube/innertube.ts`). Every timing behind that change
was taken residentially — nobody can measure what that endpoint does from a Cloudflare Worker's egress
without shipping it, because Access fronts the preview hosts and `npm run deploy` refuses on purpose.

It has shipped and it has been measured, so this is no longer a pending experiment: on ten ids the
service had never seen, WEB alone answered 5 of 10, and hits and misses both returned near 1700 ms,
which is why MWEB was added as a second client rather than the timeout being raised. Treat 40 to 50%
egress refusal as the number to compare against, and read a sustained move away from it as news.

The change was built to be indistinguishable from never having shipped if it fails, and **this pair
is how you find out which happened.** Read it as a ratio, per the house rule for `translate_*` and
`smoke_*`:

```sql
SELECT SUM(IF(blob2 = 'yt_innertube_ok', _sample_interval, 0)) AS ok,
       SUM(IF(blob2 = 'yt_innertube_fail', _sample_interval, 0)) AS fail
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' HOUR AND blob1 = 'yt'
```

`ok` counts a usable **date**, not merely a 200 — a 200 carrying an empty `videoDetails` is the exact
failure mode a sibling client (ANDROID_VR) already exhibits, and counting it as success would hide the
one thing worth watching. `fail` climbing toward the total means the cards have silently gone back to
1 January 1970, which is the state this counter exists to make loud.

### Reading `card_degraded`

**`mux_ok` can be high while every card is still a picture.** The two answer different questions, and
conflating them is the mistake this row exists to make impossible.

`mux_ok` says the container produced bytes and R2 stored them. `card_degraded` says the render gave up
waiting and served the poster still instead of the player. A mux that finishes at T+40s is *both* — a
`mux_ok`, and a card that has already been frozen. Discord caches an embed permanently in the message
it was pasted into, so for that reader the video never appears no matter what happens afterwards.

Before this row existed the degrade was counted nowhere, and the render that produced it went on to
fire `ok`. The dataset therefore reported the first-paste failure as a success. That is worse than a
gap: it is a number that points the wrong way.

It is **not** a `mux_*` row, on purpose. It carries a real `blob3` — unlike a mux, a degrade is owned
by exactly one render for exactly one audience — and it leaves `double2` unset, so a `mux_`-prefixed
name would have falsified both columns and silently poisoned the average in the query above.

Two rewrites are deliberately **excluded**: a video past `MUX_MAX_SECONDS`, and a live or scheduled
broadcast (added 2026-08-29). Neither ever calls the container and neither can ever succeed, so
counting them would put a permanent floor under the ratio made entirely of videos that are too long,
and of news channels that stream around the clock.

```sql
-- The first-paste failure rate, per platform. This is the number the mux alarm has to move.
SELECT blob1 AS platform,
       SUM(IF(blob2 = 'card_degraded', _sample_interval, 0)) AS degraded,
       SUM(IF(blob2 = 'ok', _sample_interval, 0)) AS ok
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob3 = 'discord' AND blob2 IN ('card_degraded', 'ok')
GROUP BY platform ORDER BY degraded DESC
```

**Read 2026-08-29, the first time anyone ran it.** All time, `blob1='yt'`, `blob3='discord'`: 336
degraded against 583 ok. Every other platform together contributes 5 degrades. Three things about
that number before it is quoted anywhere.

*The smoke cron is in the `ok` denominator.* `SMOKE_CLIENT` is `'other-bot'` so that a monitor never
dilutes a reader, and that covers only the outer `smoke_ok`/`smoke_fail` pair. The inner render is
driven with a Discordbot user-agent, so every tick fires `ok` with `blob3='discord'`. At two ticks an
hour that was roughly 38 of the 144 `ok` rows in one measured day, and the YouTube check runs off a
warm R2 object so it can never contribute a degrade. The published ratio is biased downward by it,
and by more when traffic is thin. Either give the inner render a client class of its own or subtract
the cron's known rate before quoting a ratio.

*It now has two interventions to separate*, the MuxRunner alarm (2026-08-23) and the raised YouTube
crawler budget (2026-08-29). They aim at different pastes: the alarm heals a LATER one, the budget
aims at the FIRST. The ratio moves for either, so it cannot attribute on its own. Cut by day and read
it beside the deploy dates.

*It cannot see the failure a raised budget risks.* A degrade is a card we rendered; an abandon is
Discord hanging up before we answer. Only the first is countable here, so a budget that loses more
cards than it wins would show up as an improvement. Pair it with client disconnects on the activity
route.

The distribution that actually decides whether a budget can win is the `mux_*` one above, not this
ratio. `docs/research/2026-08-29-the-1500ms-crawler-cut.md` has both, with the queries.

---

## Connecting to the SQL API

Reads go through the account-level Analytics Engine SQL API, separate from the write-only `AE`
Worker binding.

```sh
CF_ACCOUNT_ID="<the 32-character account id from the dashboard>"
CF_API_TOKEN="<a Custom Token: Account | Account Analytics | Read>"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql"
```

The query text is the POST body, with no JSON wrapper and no `query` field. Every POST is one billed
read query, flat, whatever the complexity and however many rows come back; a dashboard polling every
10s costs about 8,640 queries a day. A 200 will not separate a query that matched nothing from one
that failed, so read `rows` in the JSON envelope.

Run `SHOW TABLES` before any `SELECT`. A dataset does not exist as a table until the first data point
lands, and the docs don't say what a `SELECT` against a table that was never created returns.

```sh
curl -s "$API" -H "Authorization: Bearer ${CF_API_TOKEN}" --data "SHOW TABLES"
```

Undocumented in Cloudflare's SQL reference: the write-to-query visibility lag (write a test point,
query it immediately, and nothing may come back while the binding is fine); the default row limit
(put an explicit `LIMIT` on exploratory queries, or an undocumented one decides where results stop);
quoting syntax for table or column names (irrelevant for `mbedfx_counters`, a plain identifier,
unknown for any dataset named with a hyphen or a dot); the accepted `Content-Type`, whether `GET`
works, a body size limit, a query timeout, rate limits distinct from the billed quota, and the
error-response shape. The docs show `--data` with an `Authorization` header and say success is a 200.

---

## Traps that make a query wrong

Each returns a number instead of an error.

### Sampling

`COUNT()` counts stored rows, not events. Analytics Engine samples twice: at write time when points
arrive too fast into one index, and again at read time when a query is too complex. Each stored row
carries `_sample_interval`, the number of original rows it stands for.

| Do not write | Write |
|---|---|
| `SELECT COUNT()` | `SELECT SUM(_sample_interval)` |
| `SELECT SUM(double1)` | `SELECT SUM(_sample_interval * double1)` |
| `SELECT AVG(double1)` | `SELECT SUM(_sample_interval * double1) / SUM(_sample_interval)` |
| `quantile(0.5)(col)` | `quantileExactWeighted(0.5)(col, _sample_interval)` |

The interval varies per row; Cloudflare's docs say explicitly that multiplying a `COUNT()` by a
constant factor does not work. Read-time sampling responds to query cost. A longer window makes a
naive `COUNT()` under-report more, which on a chart is indistinguishable from a traffic decline.

Nobody has checked whether mbedfx rows are sampled today, or what `index1` holds when no `indexes`
array is passed. Cloudflare's docs only ever describe the index as present.
[Is any of this being sampled](#is-any-of-this-being-sampled) answers both. At low volume
`_sample_interval` may be uniformly `1`, agreeing with `COUNT()`; use `SUM` anyway, since that
agreement can stop holding without the written data changing.

### The dataset rename

`fxeverything_counters` → `mbedfx_counters` on 2026-08-01 (commit `99e88f8`), and a rename doesn't
migrate rows. As of 2026-08-03 `mbedfx_counters` holds at most about two days of data, so every
`INTERVAL '7' DAY` example below returns a partial window that looks like a traffic collapse.

`wrangler.jsonc:176` records that the historical counters "stay in `fxeverything_counters` and are
still queryable there". Neither table has been confirmed to exist; `SHOW TABLES` settles both in one
call. The Worker was renamed in the same commit, and the repo has no evidence the old script ever
deployed and wrote a point. Retention is three months either way: anything before 2026-05-03 is gone
whichever table held it.

"Data written to Workers Analytics Engine is stored for three months" is verbatim from Cloudflare's
limits page. Whether that means 90 days, 92, or calendar months is unstated, as is whether expiry is
exact or lazy and what a query reaching past the window returns. Don't convert it into a day count.

### Stacked counters

`fetch_fail` is a superset, not a disjoint bucket. Every gate counter and every `assert_fail` is
counted on top of it by design (`src/worker.ts:204`); one age-gated Instagram request can emit four
points, `assert_fail`, `age_restricted`, `pool_unused` and `fetch_fail`. A total across `blob2` is
therefore not a request count. Compare named pairs.

Two counting rates also mix. Counters inside `liveFetchPost` (`src/worker.ts:209`) fire once per
post-cache miss; the route-level ones (`ok`, `media_hit`/`media_miss`, `api_hit`/`api_miss`,
`fetch_fail`, `ambiguous`, `notfound`, `api_bad_id`) fire once per request, spread across
`renderPostRoute`, `serveDirectMedia` and `handle()`. A ratio across the two compares unlike things.
(Those three used to be cited by line range. `src/worker.ts` gained 460 lines on 2026-08-29 and the
range stopped pointing at any of them, so this file cites the functions by name from here down.)

---

## The counters

Most mean nothing as an absolute number, and several mislead alone.

| Counter | What a rise means | Read against |
|---|---|---|
| `ok` | A card was rendered and served. The health denominator. | nothing |
| `assert_fail` | The page didn't answer: upstream changed shape, blocked mbedfx, or served a decoy. Not "the post is gone". On `ig`, the only way to see the 599 KB HTTP-200 decoy. | `fetch_fail`; on `yt`, `ok` (the ratio is the oembed-miss rate); on `dm`/`st`/`im`, `meta_timeout` |
| `meta_timeout` | **Ours, not theirs.** The container metadata call was still extracting when our budget ran out. Fires on `dm`/`st`/`im`, where that call *is* the card, so the reader got the generic "couldn't load" for a post that is fine. It lands in R2 under `waitUntil` a moment later, so the next unfurl is a warm hit and a re-paste heals. A first paste does not. | `assert_fail` on the same platform: this one is a budget to fix, that one an upstream that moved |
| `fetch_fail` | The generic failure card was served. Subtract the named failures to leave the ones with no name. | everything below that stacks on it |
| `age_restricted` | An age wall (🔞). Every emitter reads a positive signal out of the platform's payload; none infers a wall from missing tags. | `pool_unused`, same platform |
| `private` | A login or private wall (🔒). Instagram's is the one inferential emitter, and has produced a false 🔒 from datacenter egress once. | `fullpage_recovered`, which must move the opposite way |
| `pool_unused` | A credential pool is set and the gate held anyway. Means something different on each of three platforms, below. | `age_restricted`/`private`, same platform |
| `media_hit` / `media_miss` | On `/_media/`, cache-hit vs an upstream fetch. The miss/hit ratio is the fetch-amplification alert. | each other |
| `api_hit` / `api_miss` | The same for the Mastodon-spoof callbacks. Separate from `media_*`: a second traffic class in those counters would blind the amplification alert. | each other |
| `api_bad_id` | A spoof-shaped callback whose `{id}` did not decode. Kept out of `notfound`, where domain-wide 404s are noise, because this one says Discord's callbacks are arriving mangled. Always `blob1='none'`. | nothing |
| `ambiguous` | A chooser card was served. `blob1='none'` is the free router-level chooser, `blob1='tt'` one that cost an upstream fetch. The split separates a wave of Threads links from TikTok blocking mbedfx. | nothing |
| `notfound` | `blob1='none'` is a domain-wide 404 (noise). `ms`/`mk`/`pt` is an upstream 404/410, counted here so a deleted post does not inflate `assert_fail`. | nothing |
| `copyright_gql` / `copyright_recovered` / `copyright_remux` | The three Instagram copyright recoveries, cheapest first. The signal is the ratio across all three. | each other, and `ig`/`ok` |
| `fullpage_recovered` | The primary surface failed but the full page carried the whole post. On `ig`, every count is a post that would previously have shown a false 🔒. | `private` |
| `plugin_recovered` / `caption_recovered` | The second and third Facebook post surfaces. `plugin_recovered` is Meta's embed fragment, which measured 33 of 35 sampled post urls on 2026-08-12 and carries every `/photo/?fbid=` url the page surface answers with a login wall. `caption_recovered` is the narrow last resort (a page with a byline and a caption and no `og:image`), answers 2 of those 35 and fires on 1 of them, because the plugin reaches the other first and returns before this read runs. Expect it small. | each other, and `fb`/`ok` |
| `translated` / `translate_fallback` | Which engine served a translation, Google or Workers AI as the fallback. Only the ratio means anything. | each other |
| `smoke_ok` / `smoke_fail` | The scheduled self-check: did a known post on this platform still render a real card — and, on `yt` alone, one with a player in it? Read per platform. | each other |
| `translate_pending` | A translation that lost its deadline race. The card went out untranslated **and uncached**, so every unfurl of that post re-runs the full render until the R2 entry lands. | `translated` + `translate_fallback` |

### `pool_unused` by platform

| `blob1` | What it means |
|---|---|
| `x` | Expected. The secret can be filled today; the Worker-side call that would spend it is a later phase. This counts the staging gap. |
| `yt` | A real fault (`src/worker.ts:601`). The jar went with the container extract and the age wall held anyway: the accounts are signed out, rate-limited or flagged, and need rotating. |
| `ig` | Neither (`src/worker.ts:351`). `IG_ACCOUNTS` is spent in the container, not on the page fetch that reads the gate. A rise means the credential is not reaching the request that needs it, and says nothing about whether the accounts are alive. |

### Zeros that do not mean health

- `rd`/`private` only fires on the Reddit OAuth fallback, which runs only when `REDDIT_CLIENT_ID` and
  `REDDIT_CLIENT_SECRET` are set.
- `pool_unused` needs a non-empty matching account secret, and for `x` an entry carrying both
  `auth_token` and `ct0` (`src/credentials.ts:146`). An unparseable secret counts as an empty pool.
- `copyright_gql` depends on a `doc_id` Meta rotates.
- Every counter is zero if the `AE` binding is absent from the deployed bundle.
  `env.AE?.writeDataPoint` is optional-chained inside `count()` and `countMux()`
  (`src/analytics.ts`): a deploy without it writes nothing and neither throws nor logs, and
  "zero rows" means "no traffic" or "no binding".
  `wrangler.jsonc:178` declares it, prod can diverge from `main` here, and the deployed bundle has
  not been checked.

### Known defects in the write shape

No query works around either of these.

- `media_hit`/`media_miss` carry two meanings. On the `/_media/` arm of `handle()`, cache-hit vs
  upstream-fetch. On the direct-media `d.` host, matched by `DIRECT_MEDIA_HOST`, `media_miss` instead
  means the post has no usable media at all, the request answering 404 `no media: this post has
  nothing to serve` inside `serveDirectMedia`. Both write identical blobs: no query separates them,
  and `d.` host traffic contaminates the fetch-amplification ratio with nothing in the data to mark
  it.
- `translated`/`translate_fallback`/`translate_pending` all say `discord`: `withTranslated` takes no
  client class and passes the literal `'discord'` to `count()` itself. Three callers reach it. Two are
  the seams Discord really does read, where the label is accidentally true: `renderPostRoute`, and
  the activity arm of `handle()` by way of `translationFor`. The third is `describeTarget`, serving
  the converter preview and `/_api/v1`, where it is a lie. Never split the translation ratio by
  client.

The `Outcome2` docstring in `src/analytics.ts` still calls `fullpage_recovered` Instagram-only. It fires for Facebook too
(`src/worker.ts:655`, `:709`), and a query filtered to `blob1='ig'` under-reports it.

---


### Reading `translate_pending`

A few percent is the design working: a post whose translation is cold defers it to the next reader
and self-heals, which is exactly what `pending` suppressing the response cache is for.

A large or rising share is the alarm, and it is not about translations. It means posts are **not**
self-healing. Either the R2 write is failing, or the model's latency has outgrown `XLATE_MAX_WAIT_MS`, and
and every affected unfurl is a full uncached render of a post that will never get cheaper.

```sql
SELECT
  SUM(_sample_interval * (blob2 = 'translate_pending')) AS pending,
  SUM(_sample_interval * (blob2 IN ('translated', 'translate_fallback'))) AS landed
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '24' HOUR
```

WHY IT EXISTS. A TikTok post rendered no Discord card at all on 2026-08-08. By the time it was
looked at, its translation had landed and every url worked; the only measurable difference from a
working post was this state, and nothing recorded whether it had been rare or constant. Workers Logs
would have answered it and are off on purpose, because they persist the pasted url, the IP and the
geolocation, which is the one thing this whole file refuses to collect. A counter answers the same
question without naming a single post.



## The self-check

Facebook embeds were broken for up to a week, because Meta walled the post surfaces from datacenter
egress between 2026-08-01 and 2026-08-08, and the way it was found was the owner pasting a link. The
counters would have shown it to anyone who went looking. Nobody had a reason to look.

A cron runs every thirty minutes and renders a list of known posts through this worker's own handler,
then counts whether a real card came back. `src/smoke.ts` holds the list and the assertion; `/_smoke`
runs the same checks on demand and answers JSON.

Seventeen checks across sixteen of the seventeen platforms, as of 2026-08-29. It was six for the
first day, which left eleven platforms with no detector at all, the same position Facebook was in,
and nobody would have known which eleven without rendering all seventeen by hand. ONE platform is
deliberately unchecked and says so in `SMOKE_UNCHECKED`: Streamable returns the failure card on a
COLD first render (measured 2026-08-12), its meta TTL equals the cron interval so a tick is always
cold, and a row for it would alarm most ticks while the platform works. Dailymotion was excused for
the same reason and has since been checked anyway — read its note in `src/smoke.ts` before treating
an occasional red tick there as an outage. A platform that is neither checked nor excused fails the
test suite.

It asserts on CONTENT. Every interesting failure on this service answers HTTP 200, whether the failure
card, Meta's login wall or TikTok's 404 page, so a monitor watching status codes would have reported perfect
health for the whole week Facebook was down.

```sql
SELECT blob1 AS platform,
       SUM(_sample_interval * (blob2 = 'smoke_ok'))   AS ok,
       SUM(_sample_interval * (blob2 = 'smoke_fail')) AS fail
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob2 IN ('smoke_ok', 'smoke_fail')
GROUP BY platform
ORDER BY fail DESC
```

### Reading it

One platform failing while the others pass is either that platform's upstream or a check url that has
rotted, and both want a human. Every platform failing at once is this service rather than the
platforms.

ONE ROW ASKS FOR MORE THAN A CARD. `yt` carries `expect: 'video'` and reports `no-video` when the
head renders without an `og:video` — a real card, no player. That is neither of the two causes above:
it is the mux path or the crawler's mux budget, i.e. this service. It exists because every Discord
head this worker emits carries an activity link unconditionally, so the ordinary assertion was met by
the head's own boilerplate and the YouTube row could not go red short of YouTube disappearing —
through the three weeks first pastes were structurally unable to carry a player. Expect one or two
`no-video` ticks roughly every 60 days from R2's `expire-60d` lifecycle rule sweeping the muxed mp4;
the MuxRunner alarm re-muxes it and the next tick is green.

`smoke_fail` sitting at zero forever is not automatically good news. It is also what "the cron is not
running" looks like, and the two are indistinguishable from the counters alone. Check that `smoke_ok`
is climbing, not merely that `smoke_fail` is flat.

`bs` is TWO checks, the profile route and a post, and the query above groups by platform, so a
Bluesky row reading `ok 1, fail 1` per tick means one of the two broke and the counters cannot say
which. `/_smoke` names them (`bs:profile`, `bs:post`), and so does the cron's `wrangler tail` line.
Every other platform is one check, so its pair is 1 and 0 or 0 and 1.

### What it cannot tell you

It runs inside the worker it is checking, so it cannot report that the worker is unreachable: DNS, the
route binding, a failed deploy and a Cloudflare incident are all invisible to it. It is a
platform-breakage detector, not an uptime monitor, and treating it as the second thing would be a
worse mistake than not having it.

The check urls are a permanent list of real posts. When one is deleted, that platform fails forever
until somebody swaps the entry. The counter names the platform, which is the signal to go and look.
Each entry records the date it was last seen working. Three of them are noted in `src/smoke.ts` as
likelier than the rest to disappear (Imgur's anonymous album, a Pinterest pin, a Lemmy post); read
that block before treating one of those as an outage.

### What a run costs

Measured 2026-08-12 by timing production from outside: a `/_smoke` run whose caches were all cold took
10.4s for the six checks that existed that morning, and 0.10-0.13s once they were warm. The ten checks
added the same day sum to 6.4s cold, 0.14-2.7s each. A full tick is therefore fifteen to twenty
seconds, and a tick is always the cold number, since `POST_TTL` and `RESP_TTL` are 900s against a 30-minute
schedule, and `caches.default` is per-colo besides, so the entries a tick writes are rarely the ones
the next tick would read.

Facebook is the slowest single check at 4.0s cold, which is the number to compare against if one of
these ever needs a budget of its own.

The run is SERIAL and stays that way. `/_smoke` reports its own elapsed `ms`, and each check reports
its own, so the next person to widen the list can read the cost instead of inheriting a number that
was true once. Each check has a 20s budget; a check that overruns it is reported as `timeout` and
counted as `smoke_fail`, which bounds a whole run at 17 x 20s = 340s against Cloudflare's 15-minute
ceiling on a scheduled invocation. That bound is not decoration: an individual subrequest has no time
limit of its own, so without it one hung upstream could consume the invocation and every check behind
it would go uncounted, which looks exactly like the "cron is not running" case above.


## Diagnosing "the card never appeared"

Written 2026-08-08 from a report that took hours and self-healed before it could be caught. The order
matters: each step rules out a layer, and the expensive one is last.

The failure mode this is for is the worst one to chase. Discord shows nothing at all, this service
answers HTTP 200, and the post often works again by the time anyone looks. Assume nothing self-evident
and measure downward.

**1. Does the API answer, and is it degraded?**

```sh
curl -s 'https://mbedfx.app/_api/v1?url=<the post url>' | jq '{ok, pending, muxing, err: .error.code}'
```

`ok:false` names the layer immediately. `pending:true` is the one that matters here: the translation
lost its race, so the card went out untranslated and uncached, and every unfurl re-runs the whole
render. Check `translate_pending` against its siblings before concluding anything from one sample.

`muxing:true` is not by itself a fault, and the honest wait behind it is minutes rather than seconds
(`docs/API.md`, "`muxing` and `pending`"). Ask again after the alarm's first wake at 35 s before
treating it as one. A `muxing:true` that never clears on repeated asks used to be the signature of a
live stream, which was dispatched to a container that refuses it on every render; since 2026-08-29
that case answers `still:true, muxing:false` with a 🔴 note in `text`, so a stuck `muxing:true` on
YouTube now means something else and is worth chasing.

**2. What does Discord actually receive?**

```sh
curl -s -o /tmp/card.html -w '%{http_code} %{size_download}B %{time_total}s\n' '<the mbedfx url>' \
  -H 'user-agent: Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
```

A well-formed head is not proof: a post with media renders from the Mastodon-shaped document behind
`<link rel="alternate" type="application/activity+json">`, not from the og: tags. Fetch that too, and
check `media_attachments[].meta.original` is present, because `render/mastodon.ts` drops it on a zero
dimension, and an attachment with no size is a real cause of nothing being drawn.

**3. Compare against a post that works.**

Change one variable at a time. A report naming a different post on a different domain settles nothing, which is
exactly how a whole afternoon went once. Run the same post on both domains, and both posts on one
domain, before believing either.

**4. Follow the media.**

```sh
curl -sL -o /dev/null -w '%{http_code} %{content_type} %{size_download}B\n' '<the og:video or og:image url>'
```

Assert on the content type, never the status. Every interesting failure on this service answers 200:
TikTok hands a 404 page as `text/html`, Meta hands a metadata-stripped shell, Instagram hands a decoy.

**5. If any of it depends on where the request comes from, measure from Cloudflare.**

`curl` from a laptop is a residential client and routinely gets a different answer than this Worker
does. `wrangler dev --remote` runs the real worker on Cloudflare and is the only way to ask that
question honestly:

```sh
npx wrangler dev --remote --enable-containers=false
```

Both the Meta wall and the TikTok 404 were invisible until measured this way, and both had already
been reasoned about wrongly from a laptop. Preview URLs are behind Access and are not a substitute.

**6. Then read the counters.**

They are the only record that survives the incident, since Workers Logs are off on purpose and there is
nothing to go back to. `ok` broken down by `client` says whether Discord was served at all; the gate
counters say whether the post was walled rather than broken.

What cannot be answered after the fact, so nobody wastes time looking: whether Discord requested a
specific url, and what it did with the answer. That needs `event.request.url`, which is the pasted
post, and collecting it is the line this service does not cross. Ask the reporter whether a re-paste
still fails instead. Discord caches a failed unfurl per url, so a healed post can keep showing
nothing to the person who first hit it.


## Recipes

Every one uses `SUM(_sample_interval)`. Shorten `INTERVAL '7' DAY` until the dataset has aged past
[the rename](#the-dataset-rename). A platform absent from a result had no traffic in the window,
which is not the same as healthy.

### Everything, once

Run this first.

```sql
SELECT blob1 AS platform, blob2 AS outcome, blob3 AS client,
       SUM(_sample_interval) AS events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY platform, outcome, client
ORDER BY events DESC
LIMIT 200
```

A platform can also be missing for falling below the `LIMIT 200` cut.

### Which platform is broken

```sql
SELECT blob1 AS platform,
       SUM(_sample_interval * (blob2 = 'ok')) AS ok,
       SUM(_sample_interval * (blob2 = 'assert_fail')) AS assert_fail,
       SUM(_sample_interval * (blob2 = 'meta_timeout')) AS meta_timeout,
       SUM(_sample_interval * (blob2 = 'fetch_fail')) AS fetch_fail
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY platform
ORDER BY assert_fail DESC
```

A moving `assert_fail`/`ok` ratio means that platform's upstream changed shape.

`meta_timeout` IS IN THIS QUERY BECAUSE LEAVING IT OUT IS HOW A DEFECT HID FOR WEEKS. It is the same
failure card to the reader and the opposite answer to "who is broken": the container was still
extracting when our own budget ran out. Before it existed those requests were counted as
`assert_fail`, so on `dm`, `st` and `im` this query answered "their upstream changed shape" about a
Dailymotion that was healthy at that instant. A rise in `meta_timeout` with `assert_fail` flat is a
budget or a cold container, and it is ours; the reverse is theirs. Both together is a slow upstream.

### Are the account pools working

Run after filling a secret.

```sql
SELECT blob1 AS platform,
       SUM(_sample_interval * (blob2 = 'pool_unused')) AS pool_unused,
       SUM(_sample_interval * (blob2 = 'age_restricted')) AS age_restricted,
       SUM(_sample_interval * (blob2 = 'private')) AS private
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob1 IN ('x', 'ig', 'yt')
GROUP BY platform
```

Read `yt` as a real fault, `ig` as a plumbing signal and `x` as expected, per
[`pool_unused` by platform](#pool_unused-by-platform). A zero can mean the gate stopped holding,
which is the pool working, or any reading under
[Zeros that do not mean health](#zeros-that-do-not-mean-health); the dataset cannot separate them.

### Is the Instagram copyright recovery still alive

Emitted at `src/worker.ts:439`, `:445` and `:463`.

```sql
SELECT SUM(_sample_interval * (blob2 = 'copyright_gql')) AS gql,
       SUM(_sample_interval * (blob2 = 'copyright_recovered')) AS feed,
       SUM(_sample_interval * (blob2 = 'copyright_remux')) AS container,
       SUM(_sample_interval * (blob2 = 'fullpage_recovered')) AS fullpage,
       SUM(_sample_interval * (blob2 = 'ok')) AS ok
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'ig'
```

All three at zero while `ok` keeps climbing means Instagram closed the recovery and every blocked
reel is a photo again. The cards render either way.

### Is Google refusing the Worker's egress

```sql
SELECT SUM(_sample_interval * (blob2 = 'translated')) AS google,
       SUM(_sample_interval * (blob2 = 'translate_fallback')) AS workers_ai
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
```

`google` at zero while `workers_ai` climbs means the weaker fallback model (`FALLBACK_MODEL`,
`@cf/google/gemma-4-26b-a4b-it`, `src/translate.ts:276`) is carrying the feature. Nothing on the card
changes when it takes over.

### Is any of this being sampled

```sql
SELECT _sample_interval AS sample_interval,
       COUNT() AS stored_rows,
       SUM(_sample_interval) AS represented_events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY sample_interval
ORDER BY sample_interval
```

One row with `sample_interval` of 1 and `stored_rows` equal to `represented_events` means nothing is
sampled today. Any value above 1 means every `COUNT()` written elsewhere under-reports. The same run
shows what `index1` holds when no index is written.

### Fetch amplification

The ratio the spec's fetch-amplification alert watches, written by `handle()` on the `/_media/` and
`/_api/v1` arms and by `serveDirectMedia`.

```sql
SELECT SUM(_sample_interval * (blob2 = 'media_hit')) AS media_hit,
       SUM(_sample_interval * (blob2 = 'media_miss')) AS media_miss,
       SUM(_sample_interval * (blob2 = 'api_hit'))   AS api_hit,
       SUM(_sample_interval * (blob2 = 'api_miss'))  AS api_miss
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
```

A rising `media_miss` may be nothing but `d.` host traffic, which no query separates out (see
[Known defects in the write shape](#known-defects-in-the-write-shape)).

### As a time series

Cloudflare documents this bucketing idiom.

```sql
SELECT intDiv(toUInt32(timestamp), 3600) * 3600 AS t,
       blob1 AS platform,
       SUM(_sample_interval) AS events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob2 = 'ok'
GROUP BY t, platform
ORDER BY t
FORMAT JSONEachRow
```

`timestamp` is UTC and `SHOW TIMEZONE` returns `Etc/UTC`. A daily shape shifted by a local offset is
the bucketing, not a traffic pattern.

---

## Grafana

Point the Altinity ClickHouse plugin at the same SQL API URL and bearer token. Cloudflare documents
that route; it covers dashboards and alerting and adds nothing to this repo.

A Prometheus scrape target means a small exporter that queries this API and emits Prometheus text,
run on your own network. Off the public edge, none of the exposure below applies.

---

## Why there is no `/_metrics`

The `AE` binding is write-only; reads need the account-level SQL API and a bearer token. Add the
route and `Env` grows an account-scoped Cloudflare API token, live on the public edge. The same
token already pulls this data from a laptop, where it is not exposed. The `Env` docstring
in `src/analytics.ts` forbids the addition by name and records the precedent: the last secret-gated endpoint mounted here
fetched a caller-supplied shortcode from the Worker's egress, and was deleted with its module, its
mount in `worker.ts` and its wrangler secret. Its path stays unspelled in the source; a test fails
the suite for any comment naming it (`test/pipeline.test.mjs:2621`).

Three tests read the tree. `:1515` and `:2656` fail if the route returns; `:2621` fails if a comment
outlives the file it names, which is what catches a half-finished deletion. `:1515` is named
"THE PROBE IS GONE: a debug egress endpoint must not ship to a public origin". `:2656` widened it
beyond the three strings `_probe`, `PROBE_TOKEN` and `runProbe`, after an identical caller-driven
egress endpoint added as `src/diag.ts` and mounted at `/_diag/` passed the whole suite green with no
token gate. A fourth, `:1541`, drives `/_probe/t?code=AAAAAAAAAAA` through `handle()` with
`PROBE_TOKEN: 't'` in env and asserts on the body; the code is eleven characters because `runProbe`
rejected anything failing `/^[A-Za-z0-9_-]{5,32}$/` with a 400 before emitting a report, and a
shorter code would pass against a live mounted probe.

An ungated route leaks, worst at `pool_unused`. `poolSetButUnused` is literally
`accountPool(env, platform).length > 0` (`src/credentials.ts:182`), so publishing it publishes that
mbedfx has logged-in IG/YT/X accounts loaded, and the `yt` arm reports whether they still pass the
age gate. The audience is the platform's enforcement team, and it turns a ban wave into an experiment
they run against mbedfx's own endpoint. The Instagram copyright trio is the same shape for Meta, the
translation pair for Google: each shows an outcome the card hides, and publishing hands that outcome
to the party being measured. `api_bad_id` is a decode oracle for the `statusid.ts` SENTINEL hazard,
separating decode-success from decode-failure for a crafted callback id. Anyone can make the public
Worker render any URL, which makes a readable counter surface a property oracle for whichever post
the observer picks.

The gap the README's table names is counters nobody can read. Documented SQL plus the Grafana pointer
closes it, for mbedfx and for any self-hoster, each with its own dataset and token. The row should
still not read "✅ Prometheus": documented Analytics Engine access is not a scrape endpoint. Whether
fxTikTok's ✅ names the same feature is unestablished, their metrics handler being unread here.

For a route anyway, put it off this Worker: a separate unrouted Worker or a cron job holds the read
token and writes a pre-aggregated summary, with no public surface and no account token at the edge.
