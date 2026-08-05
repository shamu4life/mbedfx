# Reading the counters

mbedfx writes counters into a Cloudflare Analytics Engine dataset from 50 call sites, and nothing
reads them back. This file is a cookbook of SQL to run by hand, from a laptop or a cron box, against
Cloudflare's SQL API. [Why there is no `/_metrics`](#why-there-is-no-_metrics) is at the bottom.

**Where this was measured: nowhere.** No query below has been run against the live account. They are
written from Cloudflare's documentation (fetched 2026-08-03; those pages read "Last updated Apr 23,
2026") and from this repo's source. If you run one and it's wrong, correct it here.

---

## Cloudflare's observability surfaces

Cloudflare has no single monitoring screen. Several separate products sit near each other in the
dashboard, each switched on, billed and retained on its own, so turning one off leaves the rest
running.

Two tags on each surface below. Aggregate counts events; per-request keeps one record per request,
including what the request was. Stored can be read back tomorrow, streamed is kept nowhere.

- **Workers Logs** — stored, per-request. One invocation log per request plus every
  `console.log`/`console.error` the code emitted, indexed and queryable in the dashboard for 7 days.
  The only surface `observability.enabled` in `wrangler.jsonc` controls, and the one turned off.
  Measured against this account on 2026-08-04, the stored records carry the full request URL
  including query string, the client IP (`cf-connecting-ip`), the verbatim user agent, the referer,
  and Cloudflare's geolocation block (city, latitude/longitude, ASN, timezone).
- **Real-time logs / `wrangler tail`** — streamed, per-request. The same events, live in a terminal
  or the dashboard's Live tab, stored nowhere. Four of the five `console.error` calls in `worker.ts`
  were written for it, and each carries a comment marking it `SERVER-SIDE ONLY`, three of them as
  `SERVER-SIDE ONLY (wrangler tail)`.
- **Workers Metrics** — stored, aggregate. The request / error / CPU / wall-time charts on the
  Worker's dashboard page. No per-request detail, three months of history, no configuration, no
  price. It answers "is it up and is it erroring", and it is separate from logs.
- **Analytics Engine** — stored, aggregate, and mbedfx's own. The `mbedfx_counters` dataset that
  `src/analytics.ts` writes into. A separate product with its own config key, its own write and read
  APIs, three months of retention, and the observability setting does not reach it.
- **Workers Logpush** — export, off. Ships the same trace events off Cloudflare to R2, S3 or a log
  vendor, behind its own flag.
- **Tail Workers** — export with code in front of it, off. A second Worker that receives the
  telemetry stream and can filter or transform it before anything is stored, behind its own config
  key.
- **Workers Traces** — stored, per-request, beta, off. Spans showing where time went inside one
  request, behind `observability.traces.enabled`, which `observability.enabled` does not imply.

On today: Workers Metrics (automatic) and Analytics Engine writes (`wrangler.jsonc:178`). Workers
Logs is off (`wrangler.jsonc:44`), for the reasons below. Real-time logs is always available and
needs no setting.

Everything except Analytics Engine starts at Cloudflare dashboard → Workers & Pages → Overview →
mbedfx. Metrics are on that page, Workers Logs is the Observability tab, real-time logs is
Logs → Live. Analytics Engine has no dashboard page at all, and is read over an HTTP SQL API with an
account token.

### Why Workers Logs are off

`wrangler.jsonc` sets `observability: { enabled: false }`, for privacy. The url in those seven days
of invocation logs is the post somebody pasted, sitting next to their IP, user agent and
geolocation. `src/analytics.ts` refuses to put any of that in a counter, and its reason (TwitFix died
over a public log of processed urls) doesn't stop applying because the log belongs to Cloudflare.

The cost:

| | |
|---|---|
| **Lost** | Searching after the fact for a request that already failed. The five `console.error` calls still run, and nothing stores them. |
| **Kept** | `npx wrangler tail mbedfx` for live debugging. Reproduce the problem with a tail running. |
| **Kept** | The dashboard traffic / error-rate / CPU charts. Separate product, separate pipeline, unaffected. |
| **Kept** | Everything in this document. `observability.enabled` does not reach Analytics Engine. |

`wrangler tail` still works with `observability.enabled` off, because streaming and storage are
independent consumers of the same trace-event stream. Cloudflare's docs don't state it either way,
which left it an inference. It was checked against the live Worker on 2026-08-05, with
`observability: { enabled: false }` already deployed: a run of
`npx wrangler tail mbedfx --format json`, alongside three uncacheable requests, returned trace
records carrying `scriptName: mbedfx`, `outcome: ok` and the request url.

The `logs` array in those records was empty, because the requests did not hit a `console.error` path.
The check covers the tail session delivering, and nothing about whether `console` output reaches the
tail. Tail a failing path once to settle that. A cached response is the other thing to watch for: it
never invokes the Worker and produces no record at all, which looks exactly like a broken tail. Use
an uncacheable request when testing.

`observability.logs.invocation_logs = false` is the middle position, and it was not taken. It drops
the record carrying the url, IP and user agent while keeping `console` output stored and searchable.
Full off is stricter, and it doesn't depend on Cloudflare's field selection staying where it is.

---

## What the Worker writes

One function, one call:

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

Columns are 1-based. The first element of the `blobs` array is `blob1`, and there is no `blob0`.

`writeDataPoint` is called with no `indexes` array, so there is no `index1` to filter or group on and
`blob1`/`blob2`/`blob3` are the only dimensions.

`double1` is always 1. The dataset carries no durations, byte counts, latencies or cache ages, so
nothing here answers "how long" or "how big".

It also holds no urls, post ids, IPs or verbatim user agents. `src/analytics.ts:207` states that
constraint and records the reason: fixers die of their logs, not of lawyers. There is no url column
to query, and adding one would break what that protects.

---

## Connecting to the SQL API

The dataset is read through Cloudflare's Analytics Engine SQL API, which is account-level and
separate from the write-only `AE` Worker binding.

```sh
CF_ACCOUNT_ID="<the 32-character account id from the dashboard>"
CF_API_TOKEN="<a Custom Token: Account | Account Analytics | Read>"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql"
```

The query text is the POST body. There is no JSON wrapper and no `query` field.

Every POST is one billed read query, flat, whatever the complexity and however many rows come back. A
dashboard polling every 10s costs about 8,640 queries a day.

A 200 is necessary but not sufficient. Read `rows` in the JSON envelope, because the status alone
won't separate a query that matched nothing from one that failed.

Run `SHOW TABLES` before any `SELECT`. A dataset does not exist as a table until the first data point
lands, and the docs don't say what a `SELECT` against a table that was never created returns.

```sh
curl -s "$API" -H "Authorization: Bearer ${CF_API_TOKEN}" --data "SHOW TABLES"
```

Cloudflare's SQL reference does not state:

- The write-to-query visibility lag. Write a test point, query it immediately, and you can get
  nothing back while the binding is perfectly fine.
- The default row limit. Put an explicit `LIMIT` on exploratory queries, or an undocumented default
  decides where your results stop.
- Any quoting syntax for table or column names. Irrelevant for `mbedfx_counters`, a plain identifier,
  and unknown for any dataset named with a hyphen or a dot.
- The accepted `Content-Type`, whether `GET` works, a body size limit, a query timeout, SQL API rate
  limits distinct from the billed quota, or the shape of an error response. The docs show `--data`
  with an `Authorization` header, and say success is a 200.

---

## Traps that make a query wrong

Each of these returns a number instead of an error. Read all three before you run anything below.

### 1. Sampling

`COUNT()` counts stored rows, not events. Analytics Engine samples twice: at write time when points
arrive too fast into one index, and again at read time when a query is too complex. Each stored row
carries `_sample_interval`, the number of original rows it stands for.

| Do not write | Write |
|---|---|
| `SELECT COUNT()` | `SELECT SUM(_sample_interval)` |
| `SELECT SUM(double1)` | `SELECT SUM(_sample_interval * double1)` |
| `SELECT AVG(double1)` | `SELECT SUM(_sample_interval * double1) / SUM(_sample_interval)` |
| `quantile(0.5)(col)` | `quantileExactWeighted(0.5)(col, _sample_interval)` |

The sample interval varies per row, so multiplying a `COUNT()` by a constant factor does not work.
Cloudflare's docs say that explicitly. Read-time sampling also responds to query cost, so the further
back the window reaches, the more a naive `COUNT()` under-reports, and on a chart that is
indistinguishable from a traffic decline.

Whether any mbedfx row is sampled today is unknown, and so is how `index1` is populated when
`writeDataPoint` passes no `indexes` array, since Cloudflare's docs only ever describe the index as
present. At low volume `_sample_interval` may be uniformly `1`, so `SUM(_sample_interval)` and
`COUNT()` agree. Use `SUM` anyway, because that agreement can stop holding without anything about the
written data changing. [Recipe 6](#6-is-any-of-this-being-sampled) answers both questions.

### 2. The dataset rename

The dataset was renamed `fxeverything_counters` → `mbedfx_counters` on 2026-08-01 (commit `99e88f8`),
and a rename doesn't migrate rows. As of 2026-08-03, `mbedfx_counters` holds at most about two days
of data, so every `INTERVAL '7' DAY` example below returns a partial window that looks like a traffic
collapse.

`wrangler.jsonc:176` records that the historical counters "stay in `fxeverything_counters` and are
still queryable there". Nobody has confirmed that. The Worker itself was renamed in the same commit,
and nothing in the repo shows the old script ever deployed and wrote a point. Neither table has been
confirmed to exist, and `SHOW TABLES` settles both in one call. Retention is three months either way,
so anything before 2026-05-03 is gone whichever table held it.

"Data written to Workers Analytics Engine is stored for three months" is verbatim from Cloudflare's
limits page. Whether that means 90 days, 92, or calendar months is unstated, as is whether expiry is
exact or lazy and what a query reaching past the window returns. Don't convert it into a day count as
though the day count were documented.

### 3. Stacked counters

`fetch_fail` is a superset, not a disjoint bucket. Every gate counter and every `assert_fail` is
counted on top of it by design (`src/worker.ts:204`), and one age-gated Instagram request can emit
four points: `assert_fail`, `age_restricted`, `pool_unused` and `fetch_fail`. A total across `blob2`
is therefore not a request count. Compare named pairs instead.

The dataset also mixes two counting rates. Counters inside `liveFetchPost` fire once per post-cache
miss, and the route-level ones (`ok`, `media_hit`/`media_miss`, `api_hit`/`api_miss`, `fetch_fail`,
`ambiguous`, `notfound`, `api_bad_id`) fire once per request. A ratio built across the two compares
unlike things.

---

## The counters

Read each counter against the column on the right. Most mean nothing as an absolute number, and
several mislead alone.

| Counter | What a rise means | Read against |
|---|---|---|
| `ok` | A card was rendered and served. The health denominator for the project. | — |
| `assert_fail` | The page didn't answer: the upstream changed shape, blocked mbedfx, or served a decoy. None of that means the post is gone. On `ig` this is the only way to see the 599 KB HTTP-200 decoy. | `fetch_fail`; on `yt`, `ok` (the ratio is the oembed-miss rate) |
| `fetch_fail` | The route served the generic failure card. Subtracting the named failures from it leaves the ones with no name. | everything below that stacks on it |
| `age_restricted` | The post is behind an age wall (🔞). Every emitter reads a positive signal out of the platform's payload, and none infers a wall from missing tags. | `pool_unused` on the same platform |
| `private` | The post is behind a login or private wall (🔒). Instagram's is the one inferential emitter, and it has already produced a false 🔒 from datacenter egress once. | `fullpage_recovered`, which must move in the opposite direction |
| `pool_unused` | A credential pool is set and the gate held anyway. It means something different on each of three platforms, below. | `age_restricted`/`private` on the same platform |
| `media_hit` / `media_miss` | On `/_media/`, cache-hit vs "this cost an upstream fetch". The miss/hit ratio is the fetch-amplification alert. | each other |
| `api_hit` / `api_miss` | The same, for the Mastodon-spoof callbacks. Separate from `media_*` because a second traffic class in those counters would blind the amplification alert. | each other |
| `api_bad_id` | A spoof-shaped callback arrived whose `{id}` did not decode. Kept out of `notfound`, where domain-wide 404s are noise, because this one says Discord's callbacks are arriving mangled. Always `blob1='none'`. | — |
| `ambiguous` | A chooser card was served. `blob1='none'` is the free router-level chooser, `blob1='tt'` one that cost an upstream fetch. The split separates a wave of Threads links from TikTok blocking mbedfx. | — |
| `notfound` | `blob1='none'` is a domain-wide 404 (noise). `ms`/`mk`/`pt` is an upstream 404/410, counted here so a deleted post does not inflate `assert_fail`. | — |
| `copyright_gql` / `copyright_recovered` / `copyright_remux` | The three Instagram copyright recoveries, cheapest first. The signal is the ratio across all three. | each other, and `ig`/`ok` |
| `fullpage_recovered` | The primary surface failed but the full page carried the whole post. On `ig`, every count is a post that would previously have shown a false 🔒. | `private` |
| `translated` / `translate_fallback` | Which engine served a translation, Google or Workers AI as the fallback. Only the ratio means anything. | each other |

### `pool_unused` by platform

| `blob1` | What it means |
|---|---|
| `x` | Expected. The secret can be filled today, and the Worker-side call that would spend it belongs to a later phase. This counts the staging gap. |
| `yt` | A real fault. The jar was sent with the container extract and the age wall held anyway. The accounts are signed out, rate-limited or flagged, and need rotating. |
| `ig` | Neither. `IG_ACCOUNTS` is spent in the container, not on the page fetch that reads the gate. A rise means the credential is not reaching the request that needs it, and says nothing about whether the accounts are alive. |

### Zeros that do not mean health

- `rd`/`private` only fires on the Reddit OAuth fallback, which only runs when `REDDIT_CLIENT_ID` and
  `REDDIT_CLIENT_SECRET` are set.
- `pool_unused` only fires when the matching account secret is non-empty, and for `x` only when an
  entry carries both `auth_token` and `ct0`. An unparseable secret counts as an empty pool.
- `copyright_gql` depends on a `doc_id` Meta rotates.
- Everything is zero if the `AE` binding is absent from the deployed bundle. `env.AE?.writeDataPoint`
  is optional-chained (`src/analytics.ts:225`), so a deploy without it writes nothing and neither
  throws nor logs. "Zero rows" means "no traffic" or "no binding". The binding is declared in
  `wrangler.jsonc:178`, but prod can diverge from `main` in this project and nobody has confirmed the
  deployed bundle carries it.

### Known defects in the write shape

No query works around either of these.

- `media_hit`/`media_miss` carry two meanings. On `/_media/` they mean cache-hit vs upstream-fetch. On
  the direct-media `d.` host (`src/worker.ts:3346`) `media_miss` instead means the post has no usable
  media at all. Both write identical blobs, so no query separates them, and `d.` host traffic
  contaminates the fetch-amplification ratio with nothing in the data to mark it.
- `translated`/`translate_fallback` all say `discord`, because `withTranslated` takes no client class
  and `src/worker.ts:2755` passes the literal `'discord'`. That path runs for both surfaces
  `describeTarget` serves, the converter preview (`src/worker.ts:3723`) and `/_api/v1`
  (`src/worker.ts:3911`), and neither is Discord. Never split the translation ratio by client.

`src/analytics.ts:36` still calls `fullpage_recovered` Instagram-only. It fires for Facebook too
(`src/worker.ts:655`, `:709`), and a query filtered to `blob1='ig'` under-reports it.

---

## Recipes

Every one uses `SUM(_sample_interval)`. Shorten `INTERVAL '7' DAY` until the dataset has aged past the
rename (trap 2).

### 1. Everything, once

The orientation query. Run it first and read the shape before asking anything narrower.

```sql
SELECT blob1 AS platform, blob2 AS outcome, blob3 AS client,
       SUM(_sample_interval) AS events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY platform, outcome, client
ORDER BY events DESC
LIMIT 200
```

No column here is a request count, because the outcomes stack. A platform that does not appear either
had no traffic in the window or fell below the `LIMIT 200` cut.

### 2. Which platform is broken

`assert_fail` against `ok`, per platform. A ratio that moves means that platform's upstream changed
shape.

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

A platform missing from the results has had no traffic, which is not the same as healthy.

### 3. Are the account pools working

Run this after filling a secret. Read `yt` as a real fault, `ig` as a plumbing signal and `x` as
expected, per [`pool_unused` by platform](#pool_unused-by-platform).

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

A zero can mean the gate stopped holding, which is the pool working, or any of the readings under
[Zeros that do not mean health](#zeros-that-do-not-mean-health), and this dataset cannot separate
them.

### 4. Is the Instagram copyright recovery still alive

The three copyright recoveries and `fullpage_recovered`, against Instagram's `ok` count.

```sql
SELECT SUM(_sample_interval * (blob2 = 'copyright_gql')) AS gql,
       SUM(_sample_interval * (blob2 = 'copyright_recovered')) AS feed,
       SUM(_sample_interval * (blob2 = 'copyright_remux')) AS container,
       SUM(_sample_interval * (blob2 = 'fullpage_recovered')) AS fullpage,
       SUM(_sample_interval * (blob2 = 'ok')) AS ok
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'ig'
```

All three recoveries at zero while `ok` keeps climbing means Instagram closed the recovery and every
blocked reel is a photo again, though the cards keep rendering either way.

### 5. Is Google refusing the Worker's egress

Which engine served each translation over the window.

```sql
SELECT SUM(_sample_interval * (blob2 = 'translated')) AS google,
       SUM(_sample_interval * (blob2 = 'translate_fallback')) AS workers_ai
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
```

`google` at zero while `workers_ai` climbs means the weaker model is carrying the feature, and
nothing on the card changes when the fallback takes over.

### 6. Is any of this being sampled

Settles whether `SUM(_sample_interval)` and `COUNT()` currently agree, and what `index1` holds when
no index is written.

```sql
SELECT _sample_interval AS sample_interval,
       COUNT() AS stored_rows,
       SUM(_sample_interval) AS represented_events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY sample_interval
ORDER BY sample_interval
```

A single row with `sample_interval` of 1, where `stored_rows` equals `represented_events`, means
nothing is sampled today. Any value above 1 means every `COUNT()` written elsewhere is under-reporting.

### 7. Fetch amplification

The miss/hit ratio the spec's fetch-amplification alert watches.

```sql
SELECT SUM(_sample_interval * (blob2 = 'media_hit')) AS media_hit,
       SUM(_sample_interval * (blob2 = 'media_miss')) AS media_miss,
       SUM(_sample_interval * (blob2 = 'api_hit'))   AS api_hit,
       SUM(_sample_interval * (blob2 = 'api_miss'))  AS api_miss
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
```

A rising `media_miss` may be nothing but `d.` host traffic, which no query separates out (see the
known defects above).

### 8. As a time series

The documented bucketing idiom, hourly buckets of `ok` per platform.

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

`timestamp` is UTC and `SHOW TIMEZONE` returns `Etc/UTC`. A daily shape that looks shifted by a local
offset is the bucketing, not a traffic pattern.

---

## Grafana

Point the Altinity ClickHouse plugin at the same SQL API URL with the same bearer token. Cloudflare
documents that route, it covers dashboards and alerting, and it needs nothing added to this repo.

For a Prometheus scrape target, write a small exporter that queries this API and emits Prometheus
text, and run it on your own network. None of the exposure under
[Why there is no `/_metrics`](#why-there-is-no-_metrics) applies, because the endpoint is not on the
public edge.

---

## Why there is no `/_metrics`

The Worker is the wrong place to read from, gated or not. The `AE` binding is write-only, and reads go
through the account-level SQL API with a bearer token. An in-Worker route would have to carry an
account-scoped Cloudflare API token as a Worker secret on the public edge, to serve data an operator
can already pull from a laptop with that same token and no new attack surface. That is account-wide
blast radius bought for nothing. `src/analytics.ts:195` forbids exactly this addition, and records that the
last secret-gated endpoint mounted here was deleted for being a caller-driven egress hole.

An ungated route leaks, and the worst of it is `pool_unused`. `poolSetButUnused` is literally
`accountPool(env, platform).length > 0`, so publishing it publishes that mbedfx has logged-in IG/YT/X
accounts loaded, and the `yt` arm reports whether those accounts still pass the age gate. The
platform's enforcement team is the audience for that, and it turns a ban wave into an experiment they
can run against mbedfx's own endpoint and read the result of.

The Instagram copyright trio has the same shape for Meta, and the translation pair for Google. All of
them exist to show outcomes the card hides, and publishing them hands those outcomes to the party
being measured. `api_bad_id` is a decode oracle for the `statusid.ts` SENTINEL hazard. Craft a
callback id, watch which counter moves, and decode-success is distinguishable from decode-failure.
Anyone can also make the public Worker render any URL they choose, which makes a readable counter
surface a property oracle for whichever post the observer picks.

The gap the README's table names is counters that nobody can read, and documented SQL plus the
Grafana pointer closes it, for mbedfx and for any self-hoster, since each gets its own dataset and
token. The row should still not read "✅ Prometheus", because documented Analytics Engine access is
not a scrape endpoint. Nobody on this project has read fxTikTok's metrics handler, so whether their
✅ names the same feature is also unestablished.

If you want a route anyway, put it off this Worker. A separate unrouted Worker or a cron job holds
the read token and writes a pre-aggregated summary: same data, no public surface, no account token at
the edge.
