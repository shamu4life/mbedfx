# Reading the counters

`src/worker.ts` calls `count()` from 49 sites into the `mbedfx_counters` Analytics Engine dataset.
Nothing in the Worker reads it back. The queries below do, run by hand from a laptop or a cron box
against Cloudflare's account-level SQL API.

None of it has been run against the live account: every query comes from this repo's source and from
Cloudflare's documentation, fetched 2026-08-03, those pages reading `Last updated Apr 23, 2026`.
Correct one when it comes back wrong.

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
Worker that url is the post somebody pasted, kept seven days. `src/analytics.ts:207` refuses to put
any of it in a counter and records the precedent: TwitFix shut down in 2022 over a public log of
processed urls, with zero legal contact.

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
// src/analytics.ts:225
env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })
```

| Column | Holds | Values |
|---|---|---|
| `blob1` | platform | `x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `dm` `st` `im` `tw` `lm` `pn` `ms` `mk` `pt`, or `none` |
| `blob2` | outcome | one of the 19 in `Outcome2` (`src/analytics.ts:54`) |
| `blob3` | client class | `discord` `telegram` `other-bot` `human` |
| `double1` | the literal `1` | always |
| `timestamp` | set by the runtime | `DateTime`, always UTC |

Columns are 1-based: the first `blobs` element is `blob1`, and there is no `blob0`. `writeDataPoint`
passes no `indexes` array, leaving no `index1` to filter or group on; `blob1`/`blob2`/`blob3` are the
only dimensions. `double1` is always 1, and there are no durations, byte counts, latencies or cache
ages. No urls, post ids, IPs or verbatim user agents either (`src/analytics.ts:207`). Adding a url
column breaks what that constraint protects.

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
`renderPostRoute`, `serveDirectMedia` and `handle()` from `src/worker.ts:3222` through `:4220`.
A ratio across the two compares unlike things.

---

## The counters

Most mean nothing as an absolute number, and several mislead alone.

| Counter | What a rise means | Read against |
|---|---|---|
| `ok` | A card was rendered and served. The health denominator. | — |
| `assert_fail` | The page didn't answer: upstream changed shape, blocked mbedfx, or served a decoy. Not "the post is gone". On `ig`, the only way to see the 599 KB HTTP-200 decoy. | `fetch_fail`; on `yt`, `ok` (the ratio is the oembed-miss rate) |
| `fetch_fail` | The generic failure card was served. Subtract the named failures to leave the ones with no name. | everything below that stacks on it |
| `age_restricted` | An age wall (🔞). Every emitter reads a positive signal out of the platform's payload; none infers a wall from missing tags. | `pool_unused`, same platform |
| `private` | A login or private wall (🔒). Instagram's is the one inferential emitter, and has produced a false 🔒 from datacenter egress once. | `fullpage_recovered`, which must move the opposite way |
| `pool_unused` | A credential pool is set and the gate held anyway. Means something different on each of three platforms, below. | `age_restricted`/`private`, same platform |
| `media_hit` / `media_miss` | On `/_media/`, cache-hit vs an upstream fetch. The miss/hit ratio is the fetch-amplification alert. | each other |
| `api_hit` / `api_miss` | The same for the Mastodon-spoof callbacks. Separate from `media_*`: a second traffic class in those counters would blind the amplification alert. | each other |
| `api_bad_id` | A spoof-shaped callback whose `{id}` did not decode. Kept out of `notfound`, where domain-wide 404s are noise, because this one says Discord's callbacks are arriving mangled. Always `blob1='none'`. | — |
| `ambiguous` | A chooser card was served. `blob1='none'` is the free router-level chooser, `blob1='tt'` one that cost an upstream fetch. The split separates a wave of Threads links from TikTok blocking mbedfx. | — |
| `notfound` | `blob1='none'` is a domain-wide 404 (noise). `ms`/`mk`/`pt` is an upstream 404/410, counted here so a deleted post does not inflate `assert_fail`. | — |
| `copyright_gql` / `copyright_recovered` / `copyright_remux` | The three Instagram copyright recoveries, cheapest first. The signal is the ratio across all three. | each other, and `ig`/`ok` |
| `fullpage_recovered` | The primary surface failed but the full page carried the whole post. On `ig`, every count is a post that would previously have shown a false 🔒. | `private` |
| `translated` / `translate_fallback` | Which engine served a translation, Google or Workers AI as the fallback. Only the ratio means anything. | each other |
| `smoke_ok` / `smoke_fail` | The scheduled self-check: did a known post on this platform still render a real card? Read per platform. | each other |
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
  `env.AE?.writeDataPoint` is optional-chained (`src/analytics.ts:225`): a deploy without it writes
  nothing and neither throws nor logs, and "zero rows" means "no traffic" or "no binding".
  `wrangler.jsonc:178` declares it, prod can diverge from `main` here, and the deployed bundle has
  not been checked.

### Known defects in the write shape

No query works around either of these.

- `media_hit`/`media_miss` carry two meanings. On `/_media/` (`src/worker.ts:3399`), cache-hit vs
  upstream-fetch. On the direct-media `d.` host, matched by `DIRECT_MEDIA_HOST` at
  `src/worker.ts:3306`, `media_miss` instead means the post has no usable media at all
  (`src/worker.ts:3346`), the request answering 404 `no media: this post has nothing to serve`. Both
  write identical blobs: no query separates them, and `d.` host traffic contaminates the
  fetch-amplification ratio with nothing in the data to mark it.
- `translated`/`translate_fallback`/`translate_pending` all say `discord`: `withTranslated` takes no client class and
  `src/worker.ts:2755` passes the literal `'discord'`. Three callers reach it. Two are the seams
  Discord really does read, where the label is accidentally true: `renderPostRoute`
  (`src/worker.ts:3268`) and the activity callback (`:3519`, via `translationFor` at `:2686`). The
  third is `describeTarget` (`:2936`), serving the converter preview (`:3723`) and `/_api/v1`
  (`:3911`), where it is a lie. Never split the translation ratio by client.

`src/analytics.ts:36` still calls `fullpage_recovered` Instagram-only. It fires for Facebook too
(`src/worker.ts:655`, `:709`), and a query filtered to `blob1='ig'` under-reports it.

---


### Reading `translate_pending`

A few percent is the design working: a post whose translation is cold defers it to the next reader
and self-heals, which is exactly what `pending` suppressing the response cache is for.

A large or rising share is the alarm, and it is not about translations. It means posts are **not**
self-healing — the R2 write is failing, or the model's latency has outgrown `XLATE_MAX_WAIT_MS` —
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
would have answered it and are off on purpose — they persist the pasted url, the IP and the
geolocation, which is the one thing this whole file refuses to collect. A counter answers the same
question without naming a single post.



## The self-check

Facebook embeds were broken for up to a week — Meta walled the post surfaces from datacenter egress
between 2026-08-01 and 2026-08-08 — and the way it was found was the owner pasting a link. The
counters would have shown it to anyone who went looking. Nobody had a reason to look.

A cron runs every thirty minutes and renders one known post per platform through this worker's own
handler, then counts whether a real card came back. `src/smoke.ts` holds the list and the assertion;
`/_smoke` runs the same checks on demand and answers JSON.

It asserts on CONTENT. Every interesting failure on this service answers HTTP 200 — the failure card,
Meta's login wall, TikTok's 404 page — so a monitor watching status codes would have reported perfect
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

`smoke_fail` sitting at zero forever is not automatically good news. It is also what "the cron is not
running" looks like, and the two are indistinguishable from the counters alone. Check that `smoke_ok`
is climbing, not merely that `smoke_fail` is flat.

### What it cannot tell you

It runs inside the worker it is checking, so it cannot report that the worker is unreachable: DNS, the
route binding, a failed deploy and a Cloudflare incident are all invisible to it. It is a
platform-breakage detector, not an uptime monitor, and treating it as the second thing would be a
worse mistake than not having it.

The check urls are a permanent list of real posts. When one is deleted, that platform fails forever
until somebody swaps the entry — the counter names the platform, which is the signal to go and look.
Each entry records the date it was last seen working.


## Diagnosing "the card never appeared"

Written 2026-08-08 from a report that took hours and self-healed before it could be caught. The order
matters: each step rules out a layer, and the expensive one is last.

The failure mode this is for is the worst one to chase — Discord shows nothing at all, this service
answers HTTP 200, and the post often works again by the time anyone looks. Assume nothing self-evident
and measure downward.

**1. Does the API answer, and is it degraded?**

```sh
curl -s 'https://mbedfx.app/_api/v1?url=<the post url>' | jq '{ok, pending, muxing, err: .error.code}'
```

`ok:false` names the layer immediately. `pending:true` is the one that matters here: the translation
lost its race, so the card went out untranslated and uncached, and every unfurl re-runs the whole
render. Check `translate_pending` against its siblings before concluding anything from one sample.

**2. What does Discord actually receive?**

```sh
curl -s -o /tmp/card.html -w '%{http_code} %{size_download}B %{time_total}s\n' '<the mbedfx url>' \
  -H 'user-agent: Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
```

A well-formed head is not proof: a post with media renders from the Mastodon-shaped document behind
`<link rel="alternate" type="application/activity+json">`, not from the og: tags. Fetch that too, and
check `media_attachments[].meta.original` is present — `render/mastodon.ts` drops it on a zero
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

They are the only record that survives the incident — Workers Logs are off on purpose and there is
nothing to go back to. `ok` broken down by `client` says whether Discord was served at all; the gate
counters say whether the post was walled rather than broken.

What cannot be answered after the fact, so nobody wastes time looking: whether Discord requested a
specific url, and what it did with the answer. That needs `event.request.url`, which is the pasted
post, and collecting it is the line this service does not cross. Ask the reporter whether a re-paste
still fails instead — Discord caches a failed unfurl per url, so a healed post can keep showing
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
       SUM(_sample_interval * (blob2 = 'fetch_fail')) AS fetch_fail
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY platform
ORDER BY assert_fail DESC
```

A moving `assert_fail`/`ok` ratio means that platform's upstream changed shape.

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

The ratio the spec's fetch-amplification alert watches, written at `src/worker.ts:3399` and `:3478`.

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
token already pulls this data from a laptop, where it is not exposed. `src/analytics.ts:195`
forbids the addition by name and records the precedent: the last secret-gated endpoint mounted here
fetched a caller-supplied shortcode from the Worker's egress, and was deleted with its module, its
mount in `worker.ts` and its wrangler secret. Its path stays unspelled in the source; a test fails
the suite for any comment naming it (`test/pipeline.test.mjs:2621`).

Three tests read the tree. `:1515` and `:2656` fail if the route returns; `:2621` fails if a comment
outlives the file it names, which is what catches a half-finished deletion. `:1515` is named
"THE PROBE IS GONE — a debug egress endpoint must not ship to a public origin". `:2656` widened it
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
