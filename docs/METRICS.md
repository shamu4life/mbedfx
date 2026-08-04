# Reading the counters

mbedfx writes counters into a Cloudflare Analytics Engine dataset from 50 call sites, and has never
had a way to read them back. This is that way.

It is a **cookbook, not an endpoint**, and that is a decision rather than a shortcut — see
[Why there is no `/_metrics`](#why-there-is-no-_metrics) at the bottom. Everything here runs from your
laptop or a cron box against Cloudflare's SQL API.

**Where this was measured: nowhere.** Every query below is written from Cloudflare's documentation
(fetched 2026-08-03; those pages read "Last updated Apr 23, 2026") and from this repo's source. None
has been run against the live account. The first person to run them should correct whatever is wrong
here rather than assume it was verified.

---

## What Cloudflare actually gives you to look at

Cloudflare does not have one "monitoring" screen. It has several separate products that sit near each other in the dashboard but are switched on, billed and retained independently. Turning one off does not touch the others, and most of the confusion here comes from assuming it does.

Two distinctions carry the whole picture.

**Aggregate versus per-request.** Some surfaces count things (a chart of requests per hour, a table of counters). Others keep a record of individual requests, which necessarily means keeping what those requests were. The privacy question and the debugging question live on opposite sides of that line.

**Stored versus streamed.** Some surfaces write a record to Cloudflare that you can come back to tomorrow. Others show you events as they happen and keep nothing. A streamed surface cannot leak later, because there is nothing there later.

With that, the seven surfaces:

- **Workers Logs** — stored, per-request. Cloudflare writes one "invocation log" per request plus every `console.log`/`console.error` the code emitted, indexes them, and lets you query them in the dashboard for 7 days. This is the only surface controlled by `observability.enabled` in `wrangler.jsonc`, and it is the one being turned off. Measured against this account on 2026-08-04, the stored records carry the full request URL including query string, the client IP (`cf-connecting-ip`), the verbatim user agent, the referer, and Cloudflare's geolocation block (city, latitude/longitude, ASN, timezone).
- **Real-time logs / `wrangler tail`** — streamed, per-request. The same events, shown live in a terminal or the dashboard's Live tab, stored nowhere. This is what the four `console.error` calls in `worker.ts` were written for; their comments already say "SERVER-SIDE ONLY (wrangler tail)".
- **Workers Metrics** — stored, aggregate. The request / error / CPU / wall-time charts on the Worker's dashboard page. No per-request detail, three months of history, no configuration, no price. This is the surface that answers "is it up and is it erroring", and it is entirely separate from logs.
- **Analytics Engine** — stored, aggregate, ours. The `mbedfx_counters` dataset that `src/analytics.ts` writes counters into. Its own product, its own config key, its own read API. Three months of retention. Nothing about it is affected by the observability setting.
- **Workers Logpush** — export. Ships the same trace events off Cloudflare to R2, S3 or a log vendor. Off; its own flag.
- **Tail Workers** — export with code in front of it. A second Worker that receives the telemetry stream and can filter or transform it before anything is stored. Off; its own config key.
- **Workers Traces** — stored, per-request, beta. Spans showing where time went inside one request. Off; needs its own `observability.traces.enabled`, which `observability.enabled` does not imply.

**On for this Worker today:** Workers Logs (`wrangler.jsonc:27`), Workers Metrics (automatic), Analytics Engine writes (`wrangler.jsonc:161`). Real-time logs is always available and needs no setting. Logpush, Tail Workers and Traces are all off.

**Where to click:** everything except Analytics Engine starts at **Cloudflare dashboard → Workers & Pages → Overview → mbedfx**. Metrics are on that page. Workers Logs is the **Observability** tab. Real-time logs is **Logs → Live**. Analytics Engine has no dashboard page at all; it is read over an HTTP SQL API with an account token, which is what `docs/METRICS.md` is a cookbook for.

### Workers Logs are off here, on purpose

`wrangler.jsonc` sets `observability: { enabled: false }`, and it is a privacy boundary rather than a
debugging preference. With it on, Cloudflare persists one invocation log per request for seven days,
and those records carry the whole request url. On this Worker the url **is** the post somebody
pasted, alongside their IP, user agent and geolocation. That is exactly what `src/analytics.ts`
refuses to put in a counter, and its reason (TwitFix died over a public log of processed urls) does
not stop applying because the log belongs to Cloudflare rather than to us.

What that costs, and what it does not:

| | |
|---|---|
| **Lost** | Searching *after the fact* for a request that already failed. The four `console.error` calls still run; nothing stores them. |
| **Kept** | `npx wrangler tail mbedfx` for live debugging. Reproduce the problem with a tail running. |
| **Kept** | The dashboard traffic / error-rate / CPU charts. Separate product, separate pipeline, unaffected. |
| **Kept** | Everything in this document. Analytics Engine is a different product with its own key, its own write API and its own retention. |

One honest gap: **Cloudflare's docs never state whether `wrangler tail` works with observability
disabled.** The real-time logs page says it "does not store Workers Logs", and the config field is
defined in terms of *persisting*, which reads as two independent consumers of the same trace-event
stream — but that is an inference, not a quoted guarantee. Settle it in thirty seconds after the next
deploy: run `npx wrangler tail mbedfx` and load a card. If lines appear, it is answered.

The middle position that was not taken, recorded so the choice is legible rather than to reopen it:
`observability.logs.invocation_logs = false` drops the record carrying the url, IP and user agent
while keeping `console` output stored and searchable. Full off is stricter, and needs no trust in
Cloudflare's field selection staying where it is.


---

## What is actually written

One function, one call, and that is the whole surface:

```ts
// src/analytics.ts:204
env.AE?.writeDataPoint({ blobs: [platform, outcome, client], doubles: [1] })
```

| Column | Holds | Values |
|---|---|---|
| `blob1` | platform | `x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `dm` `st` `im` `tw` `lm` `pn` `ms` `mk` `pt`, or `none` |
| `blob2` | outcome | one of the 19 in `Outcome2` (`src/analytics.ts:54`) |
| `blob3` | client class | `discord` `telegram` `other-bot` `human` |
| `double1` | the literal `1` | always |
| `timestamp` | set by the runtime | `DateTime`, always UTC |

**Columns are 1-based.** There is no `blob0`. The first element of the `blobs` array is `blob1`.

**No index is written.** `writeDataPoint` is called with no `indexes` array, so there is no `index1` to
filter or group on. `blob1`/`blob2`/`blob3` are the only dimensions this dataset has.

**`double1` is always 1**, so there is no duration, no byte count, no latency and no cache age
anywhere in here. Any "how long" or "how big" question is unanswerable from this dataset as written,
and no query below can be talked into answering one.

**Counters only** — no URLs, no post ids, no IPs, no verbatim user agents. That is a deliberate
constraint with a reason attached (`src/analytics.ts:197`): the demonstrated way a fixer dies is not
lawyers, it is logging. A query that asks for a URL is asking for a column that does not exist, and
adding one would break the thing the constraint protects.

---

## Reading it

The dataset is read through Cloudflare's Analytics Engine SQL API — an account-level API, not the
Worker binding. The `AE` binding is write-only.

```sh
CF_ACCOUNT_ID="<the 32-character account id from the dashboard>"
CF_API_TOKEN="<a Custom Token: Account | Account Analytics | Read>"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql"
```

The query text **is** the POST body. It is not JSON-wrapped and there is no `query` field.

**Start with `SHOW TABLES`, not a `SELECT`.** A dataset does not exist as a table until the first
data point lands, and the docs do not say what a `SELECT` against a table that was never created
returns. So confirm it is there first:

```sh
curl -s "$API" -H "Authorization: Bearer ${CF_API_TOKEN}" --data "SHOW TABLES"
```

Two more things worth knowing before the first real query. Every POST to this API is **one billed read
query**, flat, regardless of complexity or rows returned — a dashboard polling every 10s is ~8,640
queries a day. And a query "succeeding" is a 200 *plus* a readable body: the JSON envelope carries
`rows`, so a syntactically fine query returning nothing is only distinguishable from a failure by
reading the body.

---

## Three things that make a first query confidently wrong

Each of these returns a number rather than an error, which is why they are here and not in a footnote.

### 1. `COUNT()` counts stored rows, not events

Analytics Engine samples twice — at write time if points arrive too fast into one index, and again at
**query time if the query is too complex**. Each stored row carries `_sample_interval`, the number of
original rows it represents. So:

| Do not write | Write |
|---|---|
| `SELECT COUNT()` | `SELECT SUM(_sample_interval)` |
| `SELECT SUM(double1)` | `SELECT SUM(_sample_interval * double1)` |
| `SELECT AVG(double1)` | `SELECT SUM(_sample_interval * double1) / SUM(_sample_interval)` |
| `quantile(0.5)(col)` | `quantileExactWeighted(0.5)(col, _sample_interval)` |

The sample interval varies per row, so multiplying a `COUNT()` by a constant factor does not work —
Cloudflare's docs say so explicitly. And because read-time sampling responds to query cost, **a naive
`COUNT()` under-reports more the further back you look**, which reads exactly like a traffic decline.

Whether any mbedfx row is sampled today is unknown. At low volume `_sample_interval` may be uniformly
`1`, in which case `SUM(_sample_interval)` and `COUNT()` agree — use `SUM` anyway, because that stops
being true without anything about the written data changing. [Recipe 6](#6-is-any-of-this-being-sampled)
answers it for real.

### 2. The dataset is two days old, and the old rows are in a different table

The dataset was renamed `fxeverything_counters` → `mbedfx_counters` on **2026-08-01** (commit
`99e88f8`), and a rename does not migrate rows. So as of 2026-08-03, `mbedfx_counters` holds at most
about two days of data, and **every `INTERVAL '7' DAY` example below will return a partial window that
looks like a traffic collapse.** Shorten the range until the dataset has aged, or you will diagnose a
cliff that is just the rename.

`wrangler.jsonc:159` records that the historical counters "stay in `fxeverything_counters` and are
still queryable there". That is a note the author wrote, not something anyone has confirmed — the
Worker itself was renamed in the same commit, so nothing in the repo shows the old script ever
deployed and wrote a point. `SHOW TABLES` settles it in one call. Retention is three months either
way, so anything before 2026-05-03 is gone regardless of which table it was in.

### 3. Counters stack, so never `SUM` across outcomes

`fetch_fail` is a **superset**, not a disjoint bucket. Every gate counter and every `assert_fail` is
counted *on top of* it, deliberately (`src/worker.ts:204`). One age-gated Instagram request can emit
four points: `assert_fail` + `age_restricted` + `pool_unused` + `fetch_fail`.

So a total across `blob2` is not a request count and never was. Compare named pairs instead. And note
there are **two counting rates mixed in one dataset**: the counters inside `liveFetchPost` fire once
per *post-cache miss*, while the route-level ones (`ok`, `media_hit`/`media_miss`, `api_hit`/`api_miss`,
`fetch_fail`, `ambiguous`, `notfound`, `api_bad_id`) fire once per *request*. A ratio built across the
two is not a ratio of comparable things.

---

## The counters

Read the "against" column as mandatory, not advisory. Most of these are meaningless as an absolute
number and several are actively misleading alone.

| Counter | What a rise means | Read against |
|---|---|---|
| `ok` | A card was rendered and served. The health denominator for the whole project. | — |
| `assert_fail` | The page did not answer — upstream changed shape, blocked us, or served a decoy. **Not** "the post is gone". On `ig` this is the only way to see the 599 KB HTTP-200 decoy at all. | `fetch_fail`; on `yt`, `ok` (the ratio is the oembed-miss rate) |
| `fetch_fail` | The route served the generic failure card. Superset — subtract the named failures to get "failures we have no name for". | everything below that stacks on it |
| `age_restricted` | The post exists behind an age wall (🔞). Every emitter reads a *positive* signal from the platform's own payload rather than inferring a wall from missing tags. | `pool_unused` on the same platform |
| `private` | The post exists behind a login/private wall (🔒). Instagram's is the one **inferential** emitter, and it has already produced a false 🔒 from datacenter egress once. | `fullpage_recovered` — these must move in **opposite** directions |
| `pool_unused` | A credential pool is set and the gate held anyway. **Means three different things by platform** — see below. | `age_restricted`/`private` on the same platform |
| `media_hit` / `media_miss` | On `/_media/`, cache-hit vs "this cost an upstream fetch". The miss/hit ratio is the fetch-amplification alert. | each other |
| `api_hit` / `api_miss` | The same, for the Mastodon-spoof callbacks. Kept separate from `media_*` on purpose: a second traffic class sharing those counters would blind the amplification alert. | each other |
| `api_bad_id` | A spoof-shaped callback arrived whose `{id}` did not decode. Kept out of `notfound` because domain-wide 404s are noise and this one says Discord's callbacks are arriving mangled. Always `blob1='none'`. | — |
| `ambiguous` | A chooser card was served. `blob1='none'` is the free router-level chooser; `blob1='tt'` is one that **cost an upstream fetch**. The split is why a wave of Threads links is distinguishable from TikTok blocking us. | — |
| `notfound` | `blob1='none'` is a domain-wide 404 (noise). `ms`/`mk`/`pt` is an upstream 404/410, counted here so a deleted post does not inflate `assert_fail`. | — |
| `copyright_gql` / `copyright_recovered` / `copyright_remux` | The three Instagram copyright recoveries, cheapest first. **The ratio across all three is the signal**; none means anything alone. | each other, and `ig`/`ok` |
| `fullpage_recovered` | The primary surface failed but the full page carried the whole post. On `ig`, every count is a post that would previously have shown a **false** 🔒. | `private` |
| `translated` / `translate_fallback` | Which engine served a translation — Google, or Workers AI as the fallback. **Only the ratio means anything.** | each other |

### `pool_unused` is three different counters wearing one name

| `blob1` | What it means |
|---|---|
| `x` | **Expected.** The secret can be filled today and the Worker-side call that would spend it is a later phase. This counts the staging gap, not a fault. |
| `yt` | **A real fault.** The jar was sent with the container extract and the age wall held anyway: the accounts are signed out, rate-limited or flagged, and need rotating. |
| `ig` | **Neither.** `IG_ACCOUNTS` is spent in the container, not on the page fetch that reads the gate — so a rise means the credential is not reaching the request that needs it, *not* that the accounts are dead. |

### Counters that can read zero for a reason other than health

A zero here is not evidence the platform is fine:

- `rd`/`private` only fires on the Reddit OAuth fallback, which only runs when `REDDIT_CLIENT_ID` and
  `REDDIT_CLIENT_SECRET` are set.
- `pool_unused` only fires when the matching account secret is non-empty — and for `x`, only when an
  entry carries **both** `auth_token` and `ct0`.
- `copyright_gql` depends on a `doc_id` Meta rotates.
- Everything is zero if the `AE` binding is absent from the deployed bundle. `env.AE?.writeDataPoint`
  is optional-chained (`src/analytics.ts:205`), so a deploy without it records nothing, throws nothing
  and logs nothing. "Zero rows" means "no traffic" **or** "no binding".

### Two known defects in the write shape

Documented because a query cannot work around either, and someone will otherwise spend an afternoon
on it:

- **`media_hit`/`media_miss` carry two meanings.** On `/_media/` they mean cache-hit vs upstream-fetch.
  On the direct-media `d.` host (`src/worker.ts:2861`) `media_miss` instead means "this post has no
  usable media at all". Both write identical blobs, so no query separates them, and `d.` host traffic
  silently contaminates the fetch-amplification ratio.
- **`translated`/`translate_fallback` are mislabelled `discord`.** The literal `'discord'` is passed
  at `src/worker.ts:2585` because `withTranslated` takes no client class. It is also called from the
  converter preview (`src/worker.ts:3284`), which is a person with a browser — so those rows are not
  merely un-breakdownable by `blob3`, they are actively wrong about who asked. Never split the
  translation ratio by client.

Also stale: the comment at `src/analytics.ts:36` calls `fullpage_recovered` Instagram-only. It fires
for Facebook too (`src/worker.ts:646`, `:700`), so a query filtered to `blob1='ig'` under-reports it.

---

## Recipes

Every one uses `SUM(_sample_interval)`. Shorten `INTERVAL '7' DAY` until the dataset has aged past the
rename — see trap 2.

### 1. Everything, once

The orientation query. Run this first and read the shape before asking anything narrower.

```sql
SELECT blob1 AS platform, blob2 AS outcome, blob3 AS client,
       SUM(_sample_interval) AS events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY platform, outcome, client
ORDER BY events DESC
LIMIT 200
```

### 2. Which platform is broken

`assert_fail` against `ok`, per platform. A platform whose ratio moves is a platform whose upstream
changed shape — which is the failure this project expects to happen on somebody else's schedule.

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

### 3. Are the account pools working

The one that matters after filling a secret. Read `yt` as a real fault, `ig` as a plumbing signal and
`x` as expected — [see above](#pool_unused-is-three-different-counters-wearing-one-name).

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

### 4. Is the Instagram copyright recovery still alive

All three at zero while `ig`/`ok` keeps climbing means Instagram closed the recovery and every blocked
reel is quietly a photo again — which no card will ever say, because they all still render.

```sql
SELECT SUM(_sample_interval * (blob2 = 'copyright_gql')) AS gql,
       SUM(_sample_interval * (blob2 = 'copyright_recovered')) AS feed,
       SUM(_sample_interval * (blob2 = 'copyright_remux')) AS container,
       SUM(_sample_interval * (blob2 = 'fullpage_recovered')) AS fullpage,
       SUM(_sample_interval * (blob2 = 'ok')) AS ok
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'ig'
```

### 5. Is Google refusing our egress

`translated` at zero while `translate_fallback` climbs means the weaker model is quietly carrying the
feature. Cards render either way, which is what makes it invisible without this.

```sql
SELECT SUM(_sample_interval * (blob2 = 'translated')) AS google,
       SUM(_sample_interval * (blob2 = 'translate_fallback')) AS workers_ai
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
```

### 6. Is any of this being sampled

Settles whether `SUM(_sample_interval)` and `COUNT()` currently agree, and what `index1` holds when no
index is written — which the Cloudflare docs do not describe.

```sql
SELECT _sample_interval AS sample_interval,
       COUNT() AS stored_rows,
       SUM(_sample_interval) AS represented_events
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY sample_interval
ORDER BY sample_interval
```

### 7. Fetch amplification

The miss/hit ratio the spec's alert watches. Remember `d.` host traffic contaminates the `media_*`
half — see the known defects above.

```sql
SELECT SUM(_sample_interval * (blob2 = 'media_hit')) AS media_hit,
       SUM(_sample_interval * (blob2 = 'media_miss')) AS media_miss,
       SUM(_sample_interval * (blob2 = 'api_hit'))   AS api_hit,
       SUM(_sample_interval * (blob2 = 'api_miss'))  AS api_miss
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY
```

### 8. As a time series

The documented bucketing idiom. `timestamp` is UTC — `SHOW TIMEZONE` returns `Etc/UTC` — so a report
that looks off by your local offset is this.

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

---

## Grafana

Cloudflare documents pointing the Altinity ClickHouse plugin at the same SQL API URL with the same
bearer token, which gives you dashboards and alerting without anything running here. That is the
supported path and there is nothing to add to this repo for it.

If a Prometheus scrape target is genuinely wanted, write a small exporter that queries this API and
emits Prometheus text, and run it **on your own network**. That is a normal Prometheus story with none
of the exposure below, because the endpoint is not on the public edge.

---

## Why there is no `/_metrics`

Three reasons, in order of weight.

**The Worker is the wrong place to read from — gated or not.** The `AE` binding is write-only; reading
goes through the account-level SQL API with a bearer token. So any in-Worker metrics route has to
carry an **account-scoped** Cloudflare API token as a Worker secret, on the public edge, to serve data
an operator can already get from a laptop with that same token and no new attack surface. That is a
credential with account-wide blast radius bought for nothing. `src/analytics.ts:186` forbids exactly
this kind of addition, and records that the last secret-gated endpoint mounted here was deleted for
being a caller-driven egress hole.

**A public one leaks, and the worst of it is `pool_unused`.** `poolSetButUnused` is literally
`accountPool(env, platform).length > 0`, so publishing that counter publishes "mbedfx has logged-in
IG/YT/X accounts loaded" — and the `yt` arm additionally reports whether those accounts are *still
passing the age gate*. The audience for that is the platform's enforcement team, and it turns a ban
wave into an experiment they can run against our own endpoint and read the result of. The Instagram
copyright trio is the same shape for Meta and the translation pair for Google: those counters exist
*because* the outcomes they measure are invisible in the rendered card, and publishing them makes them
visible to the party being measured. `api_bad_id` is a decode oracle for the `statusid.ts` SENTINEL
hazard — craft a callback id, watch which counter moves, learn decode-success from decode-failure.
And because anyone can make the public Worker render any URL they choose, a readable counter surface
is a general property oracle: the observer picks the post, the counter names the property.

**A cookbook is what closes the gap honestly.** The gap in the README's table is "we have counters and
no way to read them". The missing thing is a *read path for an operator*, and documented SQL plus the
Grafana pointer is a complete one — for us and for any self-hoster, since each gets their own dataset
and their own token.

So: **the README row should not become "✅ Prometheus".** What ships is documented Analytics Engine
access, not a scrape endpoint, and the row should say that. (Nobody here has read fxTikTok's metrics
handler, so whether their ✅ is even the same feature is also unestablished.)

If a route is ever wanted anyway, the cheapest safe version is not on this Worker: a separate unrouted
Worker or a cron job holding the read token, writing a pre-aggregated summary. Same data, no public
surface, no account token at the edge.

---

## What is not established

Written down rather than smoothed over, because a metrics doc that guesses is worse than none.

- **Nothing here has been run.** No query in this file has touched the live account. `mbedfx_counters`
  has not been confirmed to exist as a table, and neither has `fxeverything_counters`.
- **Whether the `AE` binding is attached in the deployed bundle.** It is declared in
  `wrangler.jsonc:161`, but prod can diverge from `main` in this project, and a missing binding looks
  exactly like no traffic.
- **Whether any row is sampled**, and how `index1` is populated when `writeDataPoint` passes no
  `indexes` array. Cloudflare's docs only ever describe the index as present. Recipe 6 answers both.
- **Retention mechanics.** "Data written to Workers Analytics Engine is stored for three months" is
  verbatim from Cloudflare's limits page. Whether that is 90 days, 92, or calendar months; whether
  expiry is exact or lazy; and what a query reaching past the window returns — none of that is stated.
  Do not convert "three months" into a day count as though the day count were documented.
- **Identifier quoting.** There is no documented quoting syntax for table or column names anywhere in
  Cloudflare's SQL reference. Irrelevant for `mbedfx_counters`, which is a plain identifier; unknown
  for any dataset named with a hyphen or a dot.
- **Default row limit.** Not documented. Put an explicit `LIMIT` on exploratory queries so the cap is
  yours rather than an undocumented one.
- **Write-to-query visibility lag.** Not stated. Write a test point, query immediately, see nothing,
  and the binding may be perfectly fine.
- **HTTP details**: accepted `Content-Type`, whether `GET` works, body size limit, query timeout, SQL
  API rate limits distinct from the billed quota, and the error-response shape. The docs show
  `--data` with an `Authorization` header and say success is a 200.
