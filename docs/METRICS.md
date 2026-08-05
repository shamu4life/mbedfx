# Reading the counters

`src/worker.ts` calls `count()` from 49 sites into the `mbedfx_counters` Analytics Engine dataset,
and nothing reads it back. The SQL below runs by hand, from a laptop or a cron box, against
Cloudflare's account-level SQL API.

No query here has been run against the live account; each comes from this repo's source and from
Cloudflare's documentation, fetched 2026-08-03, those pages reading `Last updated Apr 23, 2026`.
Correct one here when it comes back wrong.

---

## Cloudflare's observability surfaces

Seven products sit near each other in the dashboard, with no single screen over them. Each is
switched on, billed and retained on its own, so turning one off leaves the rest running. Each is
tagged aggregate (counts events) or per-request (one record per request, including what the request
was), and stored (readable tomorrow) or streamed (kept nowhere).

- **Workers Logs** — stored, per-request, off. One invocation log per request plus every
  `console.log`/`console.error` emitted, indexed and queryable in the dashboard for 7 days, and the
  only surface `observability.enabled` (`wrangler.jsonc:44`) controls. Measured against this account
  on 2026-08-04, the stored records carry the full request URL including query string, the client IP
  (`cf-connecting-ip`), the verbatim user agent, the referer, and Cloudflare's geolocation block
  (city, latitude/longitude, ASN, timezone).
- **Real-time logs / `wrangler tail`** — streamed, per-request, always available and needing no
  setting. The same events, live in a terminal or the dashboard's Live tab, stored nowhere. Four of
  the five `console.error` calls in `worker.ts` were written for it, each commented
  `SERVER-SIDE ONLY`, three of them `SERVER-SIDE ONLY (wrangler tail)`.
- **Workers Metrics** — stored, aggregate, automatic. The request / error / CPU / wall-time charts on
  the Worker's dashboard page: no per-request detail, three months of history, no configuration, no
  price. The charts answer "is it up and is it erroring", and nothing past that.
- **Analytics Engine** — stored, aggregate, on, and mbedfx's own. The `mbedfx_counters` dataset
  `src/analytics.ts` writes into (`wrangler.jsonc:178`), with its own config key, its own write and
  read APIs, three months of retention, and the observability setting does not reach it.
- **Workers Logpush** — export, off. Ships the same trace events off Cloudflare to R2, S3 or a log
  vendor, behind its own flag.
- **Tail Workers** — export with code in front of it, off. A second Worker receiving the telemetry
  stream, able to filter or transform before anything is stored, behind its own config key.
- **Workers Traces** — stored, per-request, beta, off. Spans showing where time went inside one
  request, behind `observability.traces.enabled`, which `observability.enabled` does not imply.

Cloudflare dashboard → Workers & Pages → Overview → mbedfx reaches every surface but one: metrics on
that page, Workers Logs under the Observability tab, real-time logs under Logs → Live. Analytics
Engine has no dashboard page at all.

### Why Workers Logs are off

`observability: { enabled: false }` sits at `wrangler.jsonc:44` for privacy, and read `true` until
2026-08-04 (`398f971`). The url in a stored invocation log is, on this Worker, the post somebody
pasted, kept seven days beside the IP, user agent and geolocation above. `src/analytics.ts:207`
refuses to put any of it in a
counter, and records the precedent: TwitFix shut down in 2022 over a public log of processed urls,
with zero legal contact. The same comment convicts itself, the claim having held for the counters
and been false of the deployment beneath them until that date.

The cost:

| | |
|---|---|
| **Lost** | Searching after the fact for a request that already failed. The five `console.error` calls still run, and nothing stores them. |
| **Kept** | `npx wrangler tail mbedfx` for live debugging. Reproduce the problem with a tail running. |
| **Kept** | The dashboard traffic / error-rate / CPU charts. Separate product, separate pipeline, unaffected. |
| **Kept** | Everything in this document. `observability.enabled` does not reach Analytics Engine. |

`wrangler tail` still works with `observability.enabled` off: streaming and storage are independent
consumers of one trace-event stream. Cloudflare's docs state it neither way, so it stayed an
inference until 2026-08-05 (`64ff6f8`). That day `npx wrangler tail mbedfx --format json` ran against
the live Worker with `observability: { enabled: false }` already deployed, alongside three
uncacheable requests. It returned trace records carrying `scriptName: mbedfx`, `outcome: ok` and the
request url.

Their `logs` array was empty, those three requests having missed every `console.error` path. The run
covers the tail session delivering, and settles nothing about `console` output reaching the tail.
Tail a failing path once for that. A cached response never invokes the Worker and produces no record
at all, which looks exactly like a broken tail, so test with an uncacheable request.

`observability.logs.invocation_logs = false` is the middle position, and it was not taken: it drops
the record carrying the url, IP and user agent while keeping `console` output stored and searchable.
Full off is stricter, and survives Cloudflare moving its field selection.

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
is called with no `indexes` array, so there is no `index1` to filter or group on, and
`blob1`/`blob2`/`blob3` are the only dimensions. `double1` is always 1, and the dataset carries no
durations, byte counts, latencies or cache ages, so nothing answers "how long" or "how big". It holds
no urls, post ids, IPs or verbatim user agents either, a constraint `src/analytics.ts:207` states.
There is no url column to query, and adding one breaks what that constraint protects.

---

## Connecting to the SQL API

Reads go through Cloudflare's Analytics Engine SQL API, account-level and separate from the
write-only `AE` Worker binding.

```sh
CF_ACCOUNT_ID="<the 32-character account id from the dashboard>"
CF_API_TOKEN="<a Custom Token: Account | Account Analytics | Read>"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql"
```

The query text is the POST body, with no JSON wrapper and no `query` field. Every POST is one billed
read query, flat, whatever the complexity and however many rows come back, so a dashboard polling
every 10s costs about 8,640 queries a day. A 200 is necessary and not sufficient: read `rows` in the
JSON envelope, since the status alone will not separate a query that matched nothing from one that
failed.

Run `SHOW TABLES` before any `SELECT`. A dataset does not exist as a table until the first data point
lands, and the docs don't say what a `SELECT` against a table that was never created returns.

```sh
curl -s "$API" -H "Authorization: Bearer ${CF_API_TOKEN}" --data "SHOW TABLES"
```

Cloudflare's SQL reference does not state:

- The write-to-query visibility lag. Write a test point, query it immediately, and nothing may come
  back while the binding is fine.
- The default row limit. Put an explicit `LIMIT` on exploratory queries, or an undocumented default
  decides where results stop.
- Any quoting syntax for table or column names. Irrelevant for `mbedfx_counters`, a plain identifier,
  unknown for any dataset named with a hyphen or a dot.
- The accepted `Content-Type`, whether `GET` works, a body size limit, a query timeout, SQL API rate
  limits distinct from the billed quota, or the shape of an error response. The docs show `--data`
  with an `Authorization` header, and say success is a 200.

---

## Traps that make a query wrong

Each returns a number instead of an error. Read all three before running anything below.

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

The interval varies per row, so multiplying a `COUNT()` by a constant factor does not work, which
Cloudflare's docs say explicitly. Read-time sampling responds to query cost: the further back the
window reaches, the more a naive `COUNT()` under-reports, indistinguishable on a chart from a traffic
decline.

Whether any mbedfx row is sampled today is unknown, as is what `index1` holds when `writeDataPoint`
passes no `indexes` array, Cloudflare's docs only ever describing the index as present. At low volume
`_sample_interval` may be uniformly `1`, making `SUM(_sample_interval)` and `COUNT()` agree; use
`SUM` anyway, since that agreement can stop holding without the written data changing.
[Is any of this being sampled](#is-any-of-this-being-sampled) answers both.

### The dataset rename

`fxeverything_counters` → `mbedfx_counters` on 2026-08-01 (commit `99e88f8`), and a rename doesn't
migrate rows. As of 2026-08-03 `mbedfx_counters` holds at most about two days of data, so every
`INTERVAL '7' DAY` example below returns a partial window that looks like a traffic collapse.

`wrangler.jsonc:176` records that the historical counters "stay in `fxeverything_counters` and are
still queryable there"; neither table has been confirmed to exist, and `SHOW TABLES` settles both in
one call. The Worker was renamed in the same commit, and the repo carries no evidence the old script
ever deployed and wrote a point. Retention is three months either way, so anything before 2026-05-03
is gone whichever table held it.

"Data written to Workers Analytics Engine is stored for three months" is verbatim from Cloudflare's
limits page. Whether that means 90 days, 92, or calendar months is unstated, as is whether expiry is
exact or lazy and what a query reaching past the window returns. Don't convert it into a day count as
though the day count were documented.

### Stacked counters

`fetch_fail` is a superset, not a disjoint bucket. Every gate counter and every `assert_fail` is
counted on top of it by design (`src/worker.ts:204`), and one age-gated Instagram request can emit
four points: `assert_fail`, `age_restricted`, `pool_unused` and `fetch_fail`. A total across `blob2`
is therefore not a request count. Compare named pairs.

Two counting rates also mix. Counters inside `liveFetchPost` (`src/worker.ts:209`) fire once per
post-cache miss; the route-level ones (`ok`, `media_hit`/`media_miss`, `api_hit`/`api_miss`,
`fetch_fail`, `ambiguous`, `notfound`, `api_bad_id`) fire once per request, spread across
`renderPostRoute`, `serveDirectMedia` and `handle()` from `src/worker.ts:3222` through `:4220`.
A ratio built across the two compares unlike things.

---

## The counters

Most mean nothing as an absolute number, and several mislead alone.

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
| `yt` | A real fault (`src/worker.ts:601`). The jar was sent with the container extract and the age wall held anyway. The accounts are signed out, rate-limited or flagged, and need rotating. |
| `ig` | Neither (`src/worker.ts:351`). `IG_ACCOUNTS` is spent in the container, not on the page fetch that reads the gate. A rise means the credential is not reaching the request that needs it, and says nothing about whether the accounts are alive. |

### Zeros that do not mean health

- `rd`/`private` only fires on the Reddit OAuth fallback, which runs only when `REDDIT_CLIENT_ID` and
  `REDDIT_CLIENT_SECRET` are set.
- `pool_unused` only fires when the matching account secret is non-empty, and for `x` only when an
  entry carries both `auth_token` and `ct0` (`src/credentials.ts:146`). An unparseable secret counts
  as an empty pool.
- `copyright_gql` depends on a `doc_id` Meta rotates.
- Every counter is zero if the `AE` binding is absent from the deployed bundle.
  `env.AE?.writeDataPoint` is optional-chained (`src/analytics.ts:225`), so a deploy without it
  writes nothing and neither throws nor logs, and "zero rows" means "no traffic" or "no binding".
  `wrangler.jsonc:178` declares the binding; prod can diverge from `main` here, and the deployed
  bundle has not been checked for it.

### Known defects in the write shape

No query works around either of these.

- `media_hit`/`media_miss` carry two meanings. On `/_media/` (`src/worker.ts:3399`), cache-hit vs
  upstream-fetch. On the direct-media `d.` host, matched by `DIRECT_MEDIA_HOST` at
  `src/worker.ts:3306`, `media_miss` instead means the post has no usable media at all
  (`src/worker.ts:3346`), the request answering 404 `no media: this post has nothing to serve`. Both
  write identical blobs, so no query separates them, and `d.` host traffic contaminates the
  fetch-amplification ratio with nothing in the data to mark it.
- `translated`/`translate_fallback` all say `discord`: `withTranslated` takes no client class and
  `src/worker.ts:2755` passes the literal `'discord'`. That path runs for both surfaces
  `describeTarget` serves, the converter preview (`src/worker.ts:3723`) and `/_api/v1`
  (`src/worker.ts:3911`), and neither is Discord. Never split the translation ratio by client.

`src/analytics.ts:36` still calls `fullpage_recovered` Instagram-only. It fires for Facebook too
(`src/worker.ts:655`, `:709`), and a query filtered to `blob1='ig'` under-reports it.

---

## Recipes

Every one uses `SUM(_sample_interval)`. Shorten `INTERVAL '7' DAY` until the dataset has aged past
[the rename](#the-dataset-rename), and run [Everything, once](#everything-once) first. A platform
absent from any result below had no traffic in the window, which is not the same as healthy.

### Everything, once

```sql
SELECT blob1 AS platform, blob2 AS outcome, blob3 AS client,
       SUM(_sample_interval) AS events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY platform, outcome, client
ORDER BY events DESC
LIMIT 200
```

Read the shape here before asking anything narrower. No column is a request count: the outcomes
stack, and a platform can also be missing for falling below the `LIMIT 200` cut.

### Which platform is broken

A moving `assert_fail`/`ok` ratio means that platform's upstream changed shape.

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

### Are the account pools working

Run after filling a secret, reading `yt` as a real fault, `ig` as a plumbing signal and `x` as
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

### Is the Instagram copyright recovery still alive

The three recoveries are emitted at `src/worker.ts:439`, `:445` and `:463`.

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
reel is a photo again, though the cards keep rendering either way.

### Is Google refusing the Worker's egress

```sql
SELECT SUM(_sample_interval * (blob2 = 'translated')) AS google,
       SUM(_sample_interval * (blob2 = 'translate_fallback')) AS workers_ai
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
```

`google` at zero while `workers_ai` climbs means the weaker fallback model
(`FALLBACK_MODEL`, `@cf/google/gemma-4-26b-a4b-it`, `src/translate.ts:276`) is carrying the feature,
and nothing on the card changes when the fallback takes over.

### Is any of this being sampled

Settles whether `SUM(_sample_interval)` and `COUNT()` agree today, and what `index1` holds when no
index is written.

```sql
SELECT _sample_interval AS sample_interval,
       COUNT() AS stored_rows,
       SUM(_sample_interval) AS represented_events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY sample_interval
ORDER BY sample_interval
```

One row with `sample_interval` of 1, `stored_rows` equal to `represented_events`, means nothing is
sampled today. Any value above 1 means every `COUNT()` written elsewhere under-reports.

### Fetch amplification

The miss/hit ratio the spec's fetch-amplification alert watches, written at `src/worker.ts:3399`
and `:3478`.

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

`timestamp` is UTC and `SHOW TIMEZONE` returns `Etc/UTC`. A daily shape that looks shifted by a local
offset is the bucketing, not a traffic pattern.

---

## Grafana

Point the Altinity ClickHouse plugin at the same SQL API URL with the same bearer token. Cloudflare
documents that route, it covers dashboards and alerting, and it needs nothing added to this repo.

For a Prometheus scrape target, write a small exporter that queries this API, emits Prometheus text,
and runs on your own network. None of the exposure below applies to it, the endpoint being off the
public edge.

---

## Why there is no `/_metrics`

The `AE` binding is write-only, and reads go through the account-level SQL API with a bearer token.
Add the route and `Env` grows an account-scoped Cloudflare API token, live on the public edge. That
token already pulls the same data from a laptop, with no new attack surface. `src/analytics.ts:195`
forbids the addition by name and records the precedent. The last secret-gated endpoint mounted here
fetched a caller-supplied shortcode from the Worker's egress; it was deleted with its module, its
mount in `worker.ts` and its wrangler secret. That module's path stays unspelled in the source, and
a test fails the suite for any comment naming it, `test/pipeline.test.mjs:2621`. That is one of the
three tests that read the tree and fail the suite if the route returns. The other two are `:1515`,
named "THE PROBE IS GONE — a debug egress endpoint must not ship to a public origin", and `:2656`,
which widened it from the three strings `_probe`, `PROBE_TOKEN` and `runProbe` after an identical
caller-driven egress endpoint added as `src/diag.ts` and mounted at `/_diag/` passed the whole suite
green with no token gate. A fourth, `:1541`, drives `/_probe/t?code=AAAAAAAAAAA` through `handle()`
with `PROBE_TOKEN: 't'` in env and asserts on the body: eleven characters, since `runProbe` rejected
anything failing `/^[A-Za-z0-9_-]{5,32}$/` with a 400 before emitting a report, and a shorter code
would pass against a live mounted probe.

An ungated route leaks, and the worst of it is `pool_unused`. `poolSetButUnused` is literally
`accountPool(env, platform).length > 0` (`src/credentials.ts:182`). Publishing it publishes that
mbedfx has logged-in IG/YT/X accounts loaded, and the `yt` arm reports whether they still pass the
age gate. The platform's enforcement team is the audience, and it turns a ban wave into an experiment
they can run against mbedfx's own endpoint and read the result of.

The Instagram copyright trio has the same shape for Meta, the translation pair for Google. Each
exists to show an outcome the card hides, and publishing it hands that outcome to the party being
measured. `api_bad_id` is a decode oracle for the `statusid.ts` SENTINEL hazard, since crafting a
callback id and watching which counter moves separates decode-success from decode-failure. Anyone can
make the public Worker render any URL they choose, so a readable counter surface is a property oracle
for whichever post the observer picks.

The gap the README's table names is counters that nobody can read. Documented SQL plus the Grafana
pointer closes it, for mbedfx and for any self-hoster, each getting its own dataset and token. The
row should still not read "✅ Prometheus", since documented Analytics Engine access is not a scrape
endpoint. Whether fxTikTok's ✅ names the same feature is unestablished, their metrics handler being
unread here.

For a route anyway, put it off this Worker. A separate unrouted Worker or a cron job holds the read
token and writes a pre-aggregated summary: the same data, no public surface, no account token at the
edge.
