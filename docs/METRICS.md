# Reading the counters

`src/worker.ts` calls `count()` from 62 sites and `countMux()` from 3 more, writing into the
`mbedfx_counters` Analytics Engine dataset. Nothing in the Worker reads it back. The queries below
do that, run by hand from a laptop or a cron box against Cloudflare's account-level SQL API. (This
file said 49 for some time, until 2026-08-29; `grep -c 'count(env' src/worker.ts` checks the number.)

The queries were written from this repo's source and from Cloudflare's documentation (fetched
2026-08-03, its pages reading `Last updated Apr 23, 2026`), and first run against the live account on
2026-08-29. That run turned up three things the documentation did not say, and the queries here now
account for them:

- the table is `mbedfx_counters`, matching the binding in `wrangler.production.jsonc`. Every query
  here said `FROM mbedfx` at the time and errored. A deployment of the generic `wrangler.jsonc`
  writes to `mbedfx_selfhost_counters` instead, so put that name in the `FROM` clauses;
- a backslash in a string literal is rejected outright (HTTP 422), so `LIKE 'mux\_%'` never ran;
- **the data is sampled.** `_sample_interval` took values from 1 to 12 in the first window read, so
  a bare `COUNT()` under-reports badly. Every query below weights by it, and in a ratio of two such
  sums the sampling largely cancels out.

`toDateTime('YYYY-MM-DD HH:MM:SS')` pins an absolute window. `NOW() - INTERVAL 'N' HOUR`,
`toStartOfHour()` and `quantileExactWeighted()` all work; `toStartOfInterval(timestamp, INTERVAL 30
MINUTE)` does not. If a query here comes back wrong, correct it.

---

## Cloudflare's observability surfaces

Cloudflare has seven of them, and no single screen covers all seven. Each one is switched on, billed
and retained separately. Below, per-request means one record per request, including what the request
was, and streamed means the events are kept nowhere.

- Workers Logs (stored, per-request, off): one invocation log per request plus every
  `console.log`/`console.error`, indexed and queryable in the dashboard for 7 days. It is the only
  surface `observability.enabled` (`wrangler.production.jsonc:44`) controls.
- Real-time logs / `wrangler tail` (streamed, per-request, always available, no setting): the same
  events in a terminal or the dashboard's Live tab, stored nowhere. Four of the five `console.error`
  calls in `worker.ts` were written for it. Each is commented `SERVER-SIDE ONLY`, and three of them
  read `SERVER-SIDE ONLY (wrangler tail)`.
- Workers Metrics (stored, aggregate, automatic): request / error / CPU / wall-time charts on the
  Worker's dashboard page, with three months of history and no per-request detail. It needs no
  configuration and costs nothing.
- Analytics Engine (stored, aggregate, on): the `mbedfx_counters` dataset that `src/analytics.ts`
  writes into (`analytics_engine_datasets` in `wrangler.production.jsonc`). It has its own config
  key, its own write and read APIs and three months of retention, and `observability.enabled` does
  not reach it.
- Workers Logpush (export, off, own flag): ships the same trace events off Cloudflare to R2, S3 or a
  log vendor.
- Tail Workers (export, off, own config key): a second Worker that receives the telemetry stream and
  can filter or transform it before anything is stored.
- Workers Traces (stored, per-request, beta, off): spans showing where the time went inside one
  request, behind `observability.traces.enabled`. Turning on `observability.enabled` does not turn
  this on.

Dashboard → Workers & Pages → Overview → mbedfx reaches every surface except Analytics Engine, which
has no dashboard page. Metrics are on that page, Workers Logs under Observability, and real-time logs
under Logs → Live.

### Why Workers Logs are off

`observability: { enabled: false }` at `wrangler.production.jsonc:44` is there for privacy. It read
`true` until 2026-08-04 (`398f971`). Measured against this account that day, a stored invocation log
carries the full request URL including the query string, the client IP (`cf-connecting-ip`), the
verbatim user agent, the referer, and Cloudflare's geolocation block (city, latitude/longitude, ASN,
timezone). On this Worker that url is the post somebody pasted, and the log keeps it for seven days.
`count()` in `src/analytics.ts` refuses to put any of it in a counter, and records the precedent:
TwitFix shut down in 2022 over a public log of processed urls, with zero legal contact.

The cost is that a request that has already failed cannot be searched for afterwards. The five
`console.error` calls still run, but nothing stores them, so reproduce the problem with
`npx wrangler tail mbedfx` running. The dashboard charts and everything in this document work the
same with logs on or off.

`wrangler tail` still works with `observability.enabled` off, because streaming and storage are
independent consumers of one trace-event stream. Cloudflare's docs don't say either way, so this was
an inference until 2026-08-05 (`64ff6f8`). That day `npx wrangler tail mbedfx --format json` ran
against the live Worker with `observability: { enabled: false }` deployed while three uncacheable
requests went through, and it returned trace records carrying `scriptName: mbedfx`, `outcome: ok`
and the request url. Their `logs` array was empty because those requests missed every
`console.error` path, so the run shows the tail session delivering, not `console` output reaching it.
To check that, tail a failing path once. A cached response never invokes the Worker and produces no
record, which looks like a broken tail, so test with an uncacheable request.

A middle setting exists and was not taken: `observability.logs.invocation_logs = false` drops the
url/IP/user-agent record and keeps `console` output stored and searchable. Turning logs fully off is
stricter, and it stays strict if Cloudflare changes which fields the record carries.

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
| `blob3` | client class | `discord` `telegram` `other-bot` `human`, or `none` on a `mux_*` row (`card_degraded` carries a real one; see below) |
| `double1` | the literal `1` | always |
| `double2` | elapsed milliseconds, a code, or a duration | `mux_*` rows carry milliseconds; `wait_users`/`wait_api` rows carry the digits between the wait id's `9` and the real id (`105` = a/5, `50406` = p/4/6; `600`/`601` were d's control and variant, used once on 2026-11-25 for issue #49 and retired that day); `wait_media` rows carry the slot digit × 100 + n (`206` = media/6, `506` = mediap/6); since 1.15.0 `card_promised` carries the video's duration in seconds, `video_wait` a join code (3 warm, 0 held here, 1 polling another isolate), `video_ok`/`video_fail` the milliseconds the client waited; `0` on every other row |
| `timestamp` | set by the runtime | `DateTime`, always UTC |

Columns are 1-based: the first `blobs` element is `blob1`, and there is no `blob0`. `writeDataPoint`
passes no `indexes` array, so there is no `index1` to filter or group on, and `blob1`/`blob2`/`blob3`
are the only dimensions. The dataset holds no urls, post ids, IPs or verbatim user agents (`count()`,
`src/analytics.ts`), and adding a url column would undo what that rule protects.

`double1` is always 1. `double2` is the one exception to "there are no durations here". It was added
on 2026-08-23 with the `mux_*` outcomes and carries the elapsed milliseconds of a video mux. Before
that, nothing recorded how long a mux took even when it succeeded, so a report that a ten-minute video
took ten minutes to warm could only be answered with arithmetic. Since 1.14.6 the `wait_*` rows use it
too, for the wait experiment's surface-and-hold code rather than a duration (`countWait`). Every other
row leaves it unset, which reads as `0`, so filter to the mux rows before averaging it or the zeros
will drag every average toward zero. **Not with `LIKE 'mux\_%'`**: Analytics Engine SQL rejects a
backslash in a string literal outright (HTTP 422,
`backslash and single-quote characters in strings are unsupported`), so the escape that makes the
underscore literal is not available. Enumerate the ten outcomes instead, as the query below does.

### The mux rows

`blob3` is `'none'` on every mux row, deliberately. Within ~2s of a single paste, the prewarm, the
HTML render and the activity render all ask for a cold video, and `muxOnce` collapses the three onto
one piece of work. No single client owns the mux, so naming one would be arbitrary.

The ten outcomes are documented at their definition (`src/analytics.ts`). For deciding whose problem a
failure is, `mux_timeout` is ours and `mux_gate` is usually the platform's. The container answers 502
for a non-zero exit, for an empty result, and since 2026-10-05 for a file its box walk refuses. Those
three are counted separately, as `mux_gate`, `mux_empty` and `mux_incomplete`, because one combined
number would point at the wrong system.

The rows `mux_incomplete` counts were not failures before it existed. A download that exited 0 with a
short file answered 200, was counted `mux_ok`, and was stored for good. Measured 2026-10-05 from a dev
sandbox (not a Worker), production's `mux/yt:txqiwrbYGrs/0` is 59,576 bytes of an mp4 whose mdat
declares 4,398,607. So `mux_ok` from before that date can include videos that never play, and a
`mux_incomplete` count after it is a rate that was invisible before, not a new regression. `mux_ok`
after that date can still include a short video. The walk refuses a file cut off inside a box, or one
with no moov or no media, but a short input that ffmpeg rewrites (a merge, a tracks mux, the HLS
fixup) comes out as whole boxes. The full rule list is at `_mux_result_verdict` in
`container/server.py`, and one of its refusals, the box cap, has nothing to do with length. Whose
fault a short download is was not determined.

It is only "usually" because `mux_gate` means the process exited non-zero, and on a `{video}` source
that process is the container's own ffmpeg. Until 2026-10-04, every Reddit video with audio uploaded
between about 2024-05 and 2025-11 would have counted here: the image's ffmpeg refused Reddit's
MPEG-TS-in-`.aac` audio, and Reddit had changed nothing. (That count is read from the code path; the
dataset was not queried, and those `/_media/` 503s took 1.4-3.0 s as Discordbot.) Before blaming the platform
for a steady `mux_gate` on `rd` or `bs`, reproduce it against the image's ffmpeg.

```sql
-- Which half of the video pipeline is failing, per platform, and how slow the good ones are.
SELECT blob1 AS platform, blob2 AS outcome,
       SUM(_sample_interval) AS n,
       SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_ms
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND blob2 IN ('mux_ok','mux_gate','mux_timeout','mux_empty','mux_incomplete','mux_pool','mux_badsource','mux_error','mux_refused','mux_joined')
GROUP BY platform, outcome ORDER BY platform, n DESC
```

An average hides the shape of the distribution, and the shape decides whether a crawler budget can
ever be met. Use `quantileExactWeighted`, which works here:

```sql
-- How long a SUCCESSFUL YouTube mux takes, weighted for sampling. Compare against the budget.
SELECT quantileExactWeighted(0.10)(double2, _sample_interval) AS p10,
       quantileExactWeighted(0.50)(double2, _sample_interval) AS p50,
       quantileExactWeighted(0.90)(double2, _sample_interval) AS p90,
       MIN(double2) AS fastest, SUM(_sample_interval) AS n
FROM mbedfx_counters
WHERE blob1 = 'yt' AND blob2 = 'mux_ok'
```

Read on 2026-08-29 over the counter's whole history (n=139): p10 6922 ms, p50 18219 ms,
p90 41254 ms, fastest 4200 ms. None of the 139 finished inside `MUX_WAIT_BOT_MS` (1500 ms), which
was the crawler budget for three weeks. This is the measurement `YT_MUX_BOT_MS` was sized against.
It is a better instrument than the `card_degraded` ratio below because the traffic mix does not
affect it.
The full working is in `docs/research/2026-08-29-the-1500ms-crawler-cut.md`.

### When `mux_gate` rises on `yt`: `/_clients`

The counters say which half of the pipeline failed. They cannot say which player client failed, and
on YouTube that is usually the question. `/_clients` answers it. It is also the only instrument here
that measures player clients from the container's own egress: every earlier argument in this project
about `player_client` was settled on a laptop, and a laptop has a residential IP.

```sh
curl -s 'https://mbedfx.app/_clients' | jq '{ok, ms, ytdlp, ffmpeg, hlsExtensionPicky, muxCheck, serving, clients}'
```

`ffmpeg` and `hlsExtensionPicky` (since 2026-10-04) say which image the probed instance is running:
the ffmpeg version, and whether its hls demuxer has the extension check that Reddit's playlists are
opened without. If both keys are missing, the instance predates that change, which is the stale-image
state `RESOLVER_GENERATION` exists to end. `muxCheck: "boxes"` (since 2026-10-05) says the instance
walks every mux result's boxes and refuses a short file instead of handing it to R2. If that key is
missing, the image would still store one.

It takes no input. The video id and the client list are constants in `container/server.py`, which is
also what makes `/_smoke` comparable from run to run. It rides the existing authenticated `/resolve`,
so it opens no new container surface, and its range fetch goes through the same `_safe_url` SSRF gate
as everything else the container fetches. It runs on a fixed resolver slot (`client-probe`) so that
two runs are comparable, instead of each landing on whichever instance was warm.

It checks for bytes, not for a format count. Each client extracts, and then the chosen format url is
range-fetched, so a client that lists formats and is then refused by googlevideo reports
`gvs: "http-403"` instead of looking healthy. The first run caught exactly that: `android_vr` reported
`extracted: true, formats: 1` and served zero bytes.

It costs a real extraction per client on a shared container slot, so the Worker's own cron never
runs it. `.github/workflows/health-check.yml` asks it every Monday and Thursday at 13:23 UTC, and once
more a minute later when the first answer is not serving
([The week it keeps, and who is told](#the-week-it-keeps-and-who-is-told)). Otherwise it is run by
hand. Use it when the mux counters show `mux_gate` on `yt` while `/_smoke` says everything is fine.
Every YouTube incident this project has had looked like that.

When it cannot do its job it says so: 503 when there is no container binding, 502 when the container
is unreachable or answers non-ok. It never 500s, because a diagnostic that crashes tells an operator
less than one that says it could not reach what it was asked about.

Its first run, on 2026-08-28, closed the PO token question. Five of six clients served bytes from
Cloudflare egress with no token at all, including `tv_simply` and `mweb`, the two that yt-dlp's own PO
Token Guide lists as requiring one. See `CLAUDE.md`.

### Reading `yt_innertube_ok` / `yt_innertube_fail`

The YouTube date, description, duration and age status come from `POST youtubei/v1/player`, not from
the media container (see `src/platforms/youtube/innertube.ts`). Every timing behind that change was
taken residentially. Nobody can measure what that endpoint does from a Cloudflare Worker's egress
without shipping it, because Access fronts the preview hosts and `npm run deploy` refuses on purpose.

It has since shipped and been measured. On ten ids the service had never seen, WEB alone answered 5
of 10, and hits and misses both returned near 1700 ms, which is why MWEB was added as a second client
instead of raising the timeout. Compare against 40 to 50% egress refusal, and treat a sustained move
away from that as news.

If the change fails, the cards look exactly as if it had never shipped, and this pair is how you find
out which happened. Read it as a ratio, as with `translate_*` and `smoke_*`:

```sql
SELECT SUM(IF(blob2 = 'yt_innertube_ok', _sample_interval, 0)) AS ok,
       SUM(IF(blob2 = 'yt_innertube_fail', _sample_interval, 0)) AS fail
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' HOUR AND blob1 = 'yt'
```

`ok` counts a usable date, not merely a 200. A sibling client (ANDROID_VR) already answers 200 with an
empty `videoDetails`, and counting that as success would hide the one failure worth watching. `fail`
climbing toward the total is the state this counter exists to make loud: the cards have silently lost
their dates (1 January 1970 until 2026-11-25, no date at all since).

### Reading the promise funnel (1.15.0)

This funnel only fills where the promise is on, meaning `YT_PROMISE` is set to exactly `on`. Without
the var it is off. mbedfx.app has run with it off since 2026-11-24, so there `card_promised` stays at
zero.

Since 1.15.0, a cold YouTube paste whose duration is known and under `YT_PROMISE_MAX_SECONDS`
(`src/muxpolicy.ts`) is promised: the head stands the stock player down and keeps the activity
link, the activity document keeps `type:'video'`, and `/_media` waits for the mux. Discord gives
the whole card one ~10 s budget and downloads the whole video inside it (measured 2026-09-02; see
[Reading a hang-up](#reading-a-hang-up-the-invocation-analytics) below), so the conversion rate is
the share of promises whose bytes were served in time:

```sql
-- The cold-paste conversion rate on YouTube, and where the misses went.
SELECT SUM(IF(blob2 = 'card_promised', _sample_interval, 0)) AS promised,
       SUM(IF(blob2 = 'video_wait',    _sample_interval, 0)) AS asked,
       SUM(IF(blob2 = 'video_ok',      _sample_interval, 0)) AS served,
       SUM(IF(blob2 = 'video_fail',    _sample_interval, 0)) AS refused,
       SUM(IF(blob2 = 'video_dispatch', _sample_interval, 0)) AS dispatched_here
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob1 = 'yt'
  AND blob2 IN ('card_promised', 'video_wait', 'video_ok', 'video_fail', 'video_dispatch')
```

`served / promised` is the conversion rate. `promised - asked` counts documents Discord read without
asking for the video. `asked - served - refused` counts hang-ups, and each one pairs with a
`clientDisconnected` invocation row at the same second (below) whose wall time is how long Discord
waited. That pairing is why `video_wait` is written before the wait starts. `blob3` is `human` on the
`video_*` rows, because Discord's media proxy sends a browser UA on purpose (`src/classify.ts`).
`card_promised` carries the duration in `double2`, so the ceiling can be widened per length, from
data instead of argument:

```sql
SELECT quantileExactWeighted(0.5)(double2, _sample_interval) AS wait_p50_ms,
       quantileExactWeighted(0.9)(double2, _sample_interval) AS wait_p90_ms
FROM mbedfx_counters WHERE blob1 = 'yt' AND blob2 = 'video_ok' AND timestamp > NOW() - INTERVAL '24' HOUR
```

### `stage_times`

Since 2026-11-24 one of these rows is written per container attempt, failed ones included, to find
where a cold mux's seconds go. Cold Reddit muxes ran 8-11 s and YouTube ones about 11 s, while
Discord stops waiting for the video about 10 s after it reads the card. It is not one of the `mux_*`
rows, so it never affects their average.

| Column | Holds |
|---|---|
| `blob4` | `tracks` (ffmpeg from URLs) or `page` (yt-dlp) |
| `blob5` | `ok`, `fail`, `refused` (bytes not stored) |
| `blob6` | `reuse` or `fallback` (Reddit's connection reuse, and whether it had to retry without it), `default`, `page`, or `unknown` from an older container image |
| `double2` | ms from the Worker's request to the container's answer: boot, queueing and the run |
| `double3` | the container's own run time in ms, or `-1` when unknown |
| `double4` | ms to stream the file into R2 and check it |
| `double5` | seconds the container process had been up, or `-1`. A small number means a cold boot |

`double2 - double3` is the time spent before the run started.

```sql
SELECT blob1 AS platform, blob4 AS route, blob6 AS variant,
  SUM(_sample_interval) AS n,
  SUM(double2 * _sample_interval) / SUM(_sample_interval) AS fetch_ms,
  SUM(double3 * _sample_interval) / SUM(_sample_interval) AS run_ms,
  SUM(double4 * _sample_interval) / SUM(_sample_interval) AS r2_ms
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob2 = 'stage_times' AND blob5 = 'ok'
GROUP BY platform, route, variant
```

### `card_gave_up`

A render drew the poster because the mux alarm had already used every attempt on this video in the
last six hours (`MUX_GIVE_UP_WINDOW_MS` in `src/muxpolicy.ts`). It is counted per render, with a real
client in `blob3` and `0` in `double2`, the same shape as `card_degraded`. These renders used to be
`card_degraded` rows, so read the two together; `card_degraded / ok` alone would improve without
anything getting better:

```sql
SELECT blob1 AS platform,
  SUM(IF(blob2 IN ('card_degraded', 'card_gave_up'), _sample_interval, 0)) AS still,
  SUM(IF(blob2 = 'ok', _sample_interval, 0)) AS ok
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob3 = 'discord'
GROUP BY platform
```

### Reading `card_degraded`

**`mux_ok` can be high while every card is still a picture.** The two counters answer different
questions, and this row exists so that nobody can confuse them.

**Since 1.15.0 the yt head still degrades by design while the document promises the player**, so on
`blob1='yt'` the `card_degraded / ok` ratio below no longer reads as the first-paste failure rate.
For YouTube, read the funnel above; this section still holds for every other platform.

`mux_ok` says the container produced bytes and R2 stored them. `card_degraded` says the render gave up
waiting and served the poster still instead of the player. A mux that finishes at T+40s is both: a
`mux_ok`, and a card that has already been frozen. Discord caches an embed permanently in the message
it was pasted into, so that reader never sees the video, whatever happens afterwards.

Before this row existed the degrade was counted nowhere, and the render that produced it went on to
fire `ok`, so the dataset reported the first-paste failure as a success.

It is deliberately not a `mux_*` row. Unlike a mux, a degrade belongs to exactly one render for exactly
one audience, so it carries a real `blob3`. It also leaves `double2` unset. A `mux_`-prefixed name
would have falsified both columns and silently poisoned the `avg_ms` average in the mux query above.

Two rewrites are deliberately excluded: a video past `MUX_MAX_SECONDS`, and a live or scheduled
broadcast (added 2026-08-29). Neither ever calls the container and neither can ever succeed.
Counting them would put a permanent floor under the ratio, made entirely of videos that are too long
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

The first time anyone ran it, on 2026-08-29, it read 336 degraded against 583 ok over all time for
`blob1='yt'`, `blob3='discord'`. Every other platform together contributed 5 degrades.
`docs/research/2026-08-29-the-1500ms-crawler-cut.md` sets this ratio beside the `mux_*` distribution
above, with the queries for both. Three caveats apply before the number is quoted anywhere.

*The smoke cron is in the `ok` denominator.* `SMOKE_CLIENT` is `'other-bot'` so that a monitor never
dilutes reader traffic, but that covers only the outer `smoke_ok`/`smoke_fail` pair. The inner render
is driven with a Discordbot user-agent, so every tick fires `ok` with `blob3='discord'`. At two ticks
an hour that was roughly 38 of the 144 `ok` rows in one measured day, and the YouTube check runs off a
warm R2 object, so it can never contribute a degrade. The cron biases the published ratio downward,
and more so when traffic is thin. Before quoting a ratio, either give the inner render a client class
of its own or subtract the cron's known rate.

*Two interventions now move it*: the MuxRunner alarm (2026-08-23) and the raised YouTube crawler
budget (2026-08-29). The alarm heals a later paste and the budget aims at the first, but the ratio
moves for either, so on its own it cannot say which one worked. Cut it by day and read it beside the
deploy dates.

*It cannot see the failure a raised budget risks.* A degrade is a card we rendered; an abandon is
Discord hanging up before we answer. Only degrades are countable here, so a budget that loses more
cards than it wins would look like an improvement. Pair the ratio with client disconnects on the
activity route. To decide whether a budget can win, read the `mux_*` distribution above instead of
this ratio.

---

## Connecting to the SQL API

Reads go through the account-level Analytics Engine SQL API, separate from the write-only `AE`
Worker binding.

```sh
CF_ACCOUNT_ID="<the 32-character account id from the dashboard>"
CF_API_TOKEN="<a Custom Token: Account | Account Analytics | Read>"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql"
```

The query text is the POST body, with no JSON wrapper and no `query` field. Every POST is billed as
one read query, whatever its complexity and however many rows come back, so a dashboard polling every
10s costs about 8,640 queries a day. A 200 does not distinguish a query that matched nothing from one
that failed; read `rows` in the JSON envelope.

Run `SHOW TABLES` before any `SELECT`. A dataset does not exist as a table until the first data point
lands, and the docs don't say what a `SELECT` against a table that was never created returns.

```sh
curl -s "$API" -H "Authorization: Bearer ${CF_API_TOKEN}" --data "SHOW TABLES"
```

Cloudflare's SQL reference leaves these undocumented:

- the write-to-query visibility lag. Write a test point, query it immediately, and nothing may come
  back even though the binding is fine;
- the default row limit. Put an explicit `LIMIT` on exploratory queries, or an undocumented one
  decides where results stop;
- quoting syntax for table or column names. It is irrelevant for `mbedfx_counters`, a plain
  identifier, and unknown for any dataset named with a hyphen or a dot;
- the accepted `Content-Type`, whether `GET` works, a body size limit, a query timeout, rate limits
  distinct from the billed quota, and the error-response shape.

The docs show `--data` with an `Authorization` header and say success is a 200.

---

## Traps that make a query wrong

Each of these returns a wrong number instead of an error.

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

The interval varies per row, and Cloudflare's docs say explicitly that multiplying a `COUNT()` by a
constant factor does not work. Read-time sampling responds to query cost, so a longer window makes a
naive `COUNT()` under-report more, and on a chart that looks exactly like a traffic decline.

mbedfx rows have been seen sampled: `_sample_interval` read 1 to 12 in the first window queried on
2026-08-29, and 2-5 on the half-hourly smoke burst. What `index1` holds when no `indexes` array is
passed has not been checked; Cloudflare's docs only ever describe the index as present. The query
under [Is any of this being sampled](#is-any-of-this-being-sampled) shows the current intervals and
answers the `index1` question too. At low volume
`_sample_interval` may be uniformly `1`, which agrees with `COUNT()`. Use `SUM` anyway, because that
agreement can stop holding without any change to the written data.

### The dataset rename

The dataset was renamed from `fxeverything_counters` to `mbedfx_counters` on 2026-08-01 (commit
`99e88f8`), and a rename doesn't migrate rows. As of 2026-08-03 `mbedfx_counters` holds at most about
two days of data, so every `INTERVAL '7' DAY` example below returns a partial window that looks like a
traffic collapse.

The comment on `analytics_engine_datasets` in `wrangler.production.jsonc` records that the historical
counters "stay in `fxeverything_counters` and are still queryable there". Neither table has been
confirmed to exist, and one `SHOW TABLES` call settles both. The Worker was renamed in the same
commit, and the repo has no evidence that the old script ever deployed and wrote a point. Retention
is three months either way, so anything before 2026-05-03 is gone whichever table held it.

Cloudflare's limits page says, verbatim, "Data written to Workers Analytics Engine is stored for three
months". It does not say whether that means 90 days, 92, or calendar months, whether expiry is exact
or lazy, or what a query reaching past the window returns, so don't convert it into a day count.

### Stacked counters

`fetch_fail` is a superset. Every gate counter and every `assert_fail` is counted on top of it by
design (the `Outcome2` docstring, `src/analytics.ts`), so one age-gated Instagram request can emit
four points: `assert_fail`, `age_restricted`, `pool_unused` and `fetch_fail`. A total across `blob2`
is therefore not a request count; compare named pairs instead.

Two counting rates also mix. Counters inside `liveFetchPost` (`src/worker.ts`) fire once per
post-cache miss. The route-level ones (`ok`, `media_hit`/`media_miss`, `api_hit`/`api_miss`,
`fetch_fail`, `ambiguous`, `notfound`, `api_bad_id`) fire once per request, from `renderPostRoute`,
`serveDirectMedia` and `handle()`. A ratio across the two groups compares unlike things. (Those three
functions used to be cited by line range, but `src/worker.ts` gained 460 lines on 2026-08-29 and the
range stopped pointing at any of them, so this file cites `src/` symbols by name throughout.)

---

## The counters

Most of these mean nothing as absolute numbers, and several mislead when read alone.

| Counter | What a rise means | Read against |
|---|---|---|
| `ok` | A card was rendered and served. The health denominator. | nothing |
| `assert_fail` | The page didn't answer: upstream changed shape, blocked mbedfx, or served a decoy. Not "the post is gone". On `ig`, the only way to see the 599 KB HTTP-200 decoy. On `pn` it has two sources since 2026-11-25: the pin fetch, and the pin.it shortener giving no redirect at all. If pasted `/pin/…` links still draw cards, the rise is the shortener's. | `fetch_fail`; on `yt`, `ok` (the ratio is the oembed-miss rate); on `dm`/`st`/`im`, `meta_timeout` |
| `meta_timeout` | Our fault, not the upstream's: the container metadata call was still extracting when our budget ran out. Fires on `dm`/`st`/`im`, where that call is the card, so the reader got the generic "couldn't load" for a post that is fine. The result lands in R2 under `waitUntil` a moment later, so the next unfurl is a warm hit and a re-paste heals; a first paste does not. | `assert_fail` on the same platform: this one is a budget to fix, that one an upstream that moved |
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
| `fullpage_recovered` | The primary surface failed but the full page carried the whole post. On `ig`, every count is a post that would previously have shown a false 🔒. Since 2026-10-14 it counts only the Instagram posts `graphql_recovered` could not answer. | `private` |
| `reel_age_gated` | An Instagram reel drawn as its cover with "🔞 Age-restricted on Instagram", because no recovery found its video and Instagram's oEmbed gate answer called it age-restricted (`instagramAudienceGate`, since 2026-10-30). Not a gate counter: the card renders, so it does not stack on `fetch_fail`. | `fullpage_recovered`, which counted each of these too |
| `graphql_recovered` | An Instagram post whose embed failed, drawn whole from the shortcode GraphQL query before the full page was asked for. Added because the full page is refused to Cloudflare's egress in bursts (302 then 429), and nothing measured whether the query is refused in the same windows. | `fullpage_recovered` and `ig` `fetch_fail`, which should fall as it rises |
| `plugin_recovered` / `caption_recovered` | The second and third Facebook post surfaces. `plugin_recovered` is Meta's embed fragment, which measured 33 of 35 sampled post urls on 2026-08-12 and carries every `/photo/?fbid=` url the page surface answers with a login wall. `caption_recovered` is the narrow last resort (a page with a byline and a caption and no `og:image`), answers 2 of those 35 and fires on 1 of them, because the plugin reaches the other first and returns before this read runs. Expect it to stay small. | each other, and `fb`/`ok` |
| `body_feed` / `body_crawler` / `body_archive` / `body_cut` / `body_none` / `body_unknown` | Where a Reddit post's body came from when its embed page carried none (picture, gallery, video, link and crosspost posts; `src/platforms/reddit/caption.ts`), once per post-cache miss on `rd`. `feed` and `crawler` are Reddit's whole text, `archive` the Arctic Shift archive completing a body Reddit cut (on the embed path, the one outcome that sent a post id to a third party; on the archive path every card already has, see `embed_refused`), `cut` Reddit's text ending in `…`, `none` a post with no body. Counted on the archive path too, for every card whose body is not `[spoiler]`. `body_unknown` rising means Reddit stopped answering Worker egress on its crawler page, and every such card has quietly lost its caption, and every crosspost of a Reddit video its video (the poster is that page's og:image). | each other; `body_archive` against `body_feed` (the feed's one-request-per-minute ration being spent by other tenants) |
| `embed_refused` | embed.reddit.com refused the request (its block page, or a 403, 429 or 5xx with no post in it) rather than answering about the post, once per post-cache miss on `rd`, so the card went to the archive path: the Arctic Shift archive's record, rendered only when Reddit's live crawler page shows the same title (`src/platforms/reddit/normalize.ts`, "Archive path"). Every such miss sends the post id to that third party. Added 2026-10-25; the block began on 2026-10-22 and only the scheduled check noticed. Falling to zero means Reddit lifted the block and the full embed render is back by itself. | `assert_fail` on `rd` beside it: a refusal the archive could not carry either (no record yet, the archive or the crawler page down, or a title Reddit no longer shows) |
| `relay_ok` / `relay_fallback` | A Reddit request through the owner's relay on Google Cloud Run (`src/platforms/reddit/relay.ts`, `relay/server.mjs`), one per request, on `rd` with client `none`: the embed page, the archive and the feed go through it once `REDDIT_RELAY_URL` and `REDDIT_RELAY_KEY` are set. `relay_ok` is an answer the relay marked as the upstream's; `relay_fallback` one it could not give (a wrong key, the relay down or slower than 2.5 s, Cloud Run's own error page), after which the request went direct. Added 2026-10-26. A failing relay falls back silently by design, so `relay_fallback` rising is the only sign of it: those cards are back on the rate-limited archive path. | each other; `embed_refused` falling once the relay carries the embed page, if Reddit serves that address |
| `link_ok` / `link_fail` / `link_pending` | A Reddit link post's linked post, per render (`linkedFor`, `src/worker.ts`): its media went on the card, it came back empty, or it missed the render's budget. Either of the last two leaves the card uncached unless the linked post is behind a private or age wall, so the next render asks again. A composed card's `card_degraded` is counted under `rd`, beside its `ok`; its `card_promised` under the video's platform, beside `video_ok`. | each other; `link_pending` against `link_ok` is the share of first pastes that lose the video to the extra fetch |
| `translated` / `translate_fallback` | Which engine served a translation, Google or Workers AI as the fallback. Only the ratio means anything. | each other |
| `smoke_ok` / `smoke_fail` | The scheduled self-check: did a known post on this platform still render a real card (and, on `yt` and `th`, one with a player in it)? Read per platform. | each other |
| `translate_pending` | A translation that lost its deadline race. The card went out untranslated and uncached, so every unfurl of that post re-runs the full render until the R2 entry lands. | `translated` + `translate_fallback` |

### `pool_unused` by platform

| `blob1` | What it means |
|---|---|
| `x` | Expected. The secret can be filled today; the Worker-side call that would spend it is a later phase. This counts the staging gap. |
| `yt` | A real fault (the YouTube arm of `liveFetchPost`, `src/worker.ts`). The jar went with the container extract and the age wall held anyway: the accounts are signed out, rate-limited or flagged, and need rotating. |
| `ig` | Neither (the Instagram arm of `liveFetchPost`, `src/worker.ts`). `IG_ACCOUNTS` is spent in the container, not on the page fetch that reads the gate. A rise means the credential is not reaching the request that needs it, and says nothing about whether the accounts are alive. |

### Zeros that do not mean health

- `rd`/`private` only fires on the Reddit OAuth fallback, which runs only when `REDDIT_CLIENT_ID` and
  `REDDIT_CLIENT_SECRET` are set.
- `pool_unused` needs a non-empty matching account secret, and for `x` an entry carrying both
  `auth_token` and `ct0` (`twitterAccounts`, `src/credentials.ts:162`). An unparseable secret counts as an empty pool.
- `copyright_gql` depends on a `doc_id` Meta rotates.
- Every counter is zero if the `AE` binding is absent from the deployed bundle.
  `env.AE?.writeDataPoint` is optional-chained inside `count()` and `countMux()`
  (`src/analytics.ts`): a deploy without it writes nothing and neither throws nor logs, so
  "zero rows" can mean "no traffic" or "no binding". `analytics_engine_datasets` in
  `wrangler.production.jsonc` declares the binding, but prod can diverge from `main` here, and the
  deployed bundle has not been checked.

### Known defects in the write shape

No query works around these.

- `media_hit`/`media_miss` carry two meanings. On the `/_media/` arm of `handle()`, cache-hit vs
  upstream-fetch. On a direct-media request (the `d.` host, matched by `DIRECT_MEDIA_HOST`, or since
  2026-10-04 a trailing `.mp4` on the post url on any host, `Route.direct`), `media_miss` instead
  means the post has no usable media at all, the request answering 404 `no media: this post has
  nothing to serve` inside `serveDirectMedia`. Both write identical blobs: no query separates them,
  and direct-media traffic contaminates the fetch-amplification ratio with nothing in the data to
  mark it. The `.mp4` spelling arrives on the ordinary hosts, so not even the host separates it.
- `ambiguous` with `blob1='tt'` carries two answers since 2026-10-04. A short link TikTok does not claim
  serves the chooser on an ordinary request, and on a direct one (the `d.` host or a `.mp4` suffix) the
  plain-text 404 `no media: this short link could not be resolved to a post`, because a direct url
  promises bytes. Both write the same blobs. Kept deliberately: the split this counter exists for (a
  wave of Threads links against TikTok blocking us) means the same thing on both, and folding the 404
  into `fetch_fail` would break that series.
- `translated`/`translate_fallback`/`translate_pending` all say `discord`: `withTranslated` takes no
  client class and passes the literal `'discord'` to `count()` itself. Three callers reach it. Two are
  the seams Discord really does read, where the label is accidentally true: `renderPostRoute`, and
  the activity arm of `handle()` by way of `translationFor`. The third is `describeTarget`, serving
  the converter preview and `/_api/v1`, where the label is false. Never split the translation ratio
  by client.

The `Outcome2` docstring in `src/analytics.ts` still calls `fullpage_recovered` Instagram-only. It
fires for Facebook too, from two sites in the Facebook arm of `liveFetchPost` (`src/worker.ts`), and
a query filtered to `blob1='ig'` under-reports it.

---


### Reading `translate_pending`

A TikTok post rendered no Discord card at all on 2026-08-08. By the time anyone looked, its
translation had landed and every url worked. The only measurable difference from a working post was
the pending state, and nothing recorded whether that state had been rare or constant. Workers Logs
would have answered the question, but they are off on purpose: they persist the pasted url, the IP
and the geolocation, the one thing this whole file refuses to collect. That incident is why this
counter exists.

```sql
SELECT
  SUM(_sample_interval * (blob2 = 'translate_pending')) AS pending,
  SUM(_sample_interval * (blob2 IN ('translated', 'translate_fallback'))) AS landed
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '24' HOUR
```

A few percent is the design working. A post whose translation is cold defers it to the next reader
and heals itself, which is what `pending` suppressing the response cache is for.

A large or rising share is the alarm, and the trouble is not the translations themselves: posts are
not healing. Either the R2 write is failing or the model's latency has outgrown `XLATE_MAX_WAIT_MS`,
and every affected unfurl is a full uncached render of a post that will never get cheaper.

## The self-check

Facebook embeds were broken for up to a week when Meta walled the post surfaces from datacenter
egress between 2026-08-01 and 2026-08-08, and the breakage was found when the owner pasted a link.
The counters would have shown it to anyone who went looking, but nobody had a reason to look.

A cron runs every thirty minutes, renders a list of known posts through this worker's own handler,
and counts whether a real card came back. `src/smoke.ts` holds the list and the assertion; `/_smoke`
runs the same checks on demand and answers JSON.

As of 2026-08-29 there are seventeen checks across sixteen of the seventeen platforms. On the first
day there were six, which left eleven platforms with no detector at all, the same position Facebook
had been in, and nobody would have known which eleven without rendering all seventeen by hand. One
platform is deliberately unchecked, and `SMOKE_UNCHECKED` says why. Streamable returns the failure
card on a cold first render (measured 2026-08-12), and `ST_META_TTL_MS` is 1_800_000 ms, exactly the
cron interval, so a scheduled check would find the meta record freshly expired on almost every tick
and sit permanently on that cold path. A row for it would alarm every half hour while the platform
works, and its only reader would learn to ignore the one instrument that has to be believed when the
Facebook row fires. Dailymotion was excluded alongside it until 2026-08-12, on a rationale this repo's
own constants contradicted (`DM_META_TTL_MS` is 86_400_000, a full day). It is checked now, but read
its note in `src/smoke.ts` before treating a red tick there as an outage: one cold tick a day is the
expected rate. A platform that is neither checked nor excused fails the test suite.

The check asserts on content. Every interesting failure on this service answers HTTP 200, whether it
is the failure card, Meta's login wall or TikTok's 404 page, so a monitor watching status codes would
have reported perfect health for the whole week Facebook was down.

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

One platform failing while the others pass points at either that platform's upstream or a check url
that has rotted, and both need a person to look. Every platform failing at once points at this
service, not the platforms.

Two rows ask for more than a card, and their `no-video` verdicts point in opposite directions. Both
exist because every Discord head this worker emits carries an activity link unconditionally. The
ordinary assertion was satisfied by the head's own boilerplate, so neither row could go red unless
its platform disappeared.

- `yt` reports `no-video` when the head renders without an `og:video`: a real card with no player.
  That is neither of the two causes above. It is the mux path or the crawler's mux budget, which means
  this service. The YouTube row stayed green through the three weeks in which first pastes were
  structurally unable to carry a player. Expect one or two `no-video` ticks roughly every 60 days, when
  R2's `expire-60d` lifecycle rule sweeps the muxed mp4; the MuxRunner alarm re-muxes it and the next
  tick is green.
- `th` (added 2026-10-04) reports `no-video` when its smoke post, a video, came back as a still.
  Threads has no mux, so this points at the upstream: the server-rendered post did not arrive or was
  not read, and the card fell to the OG fallback. Look at `SSR_PRELOADERS` in
  `src/platforms/threads/normalize.ts` (a rename is what put every Threads post on the fallback,
  unseen, until 2026-10-04) and at Threads throttling from Worker egress. How often that throttle
  fires has not been measured yet, so the row's noise rate is unknown. A red tick is still always a
  card that went out without its player.

`smoke_fail` sitting at zero forever is also what "the cron is not running" looks like, and the
counters alone cannot tell the two apart. Check that `smoke_ok` is climbing, not merely that
`smoke_fail` is flat.

`bs` is two checks, the profile route and a post. The query above groups by platform, so a Bluesky
row reading `ok 1, fail 1` per tick means one of the two broke, and the counters cannot say which.
`/_smoke` names them (`bs:profile`, `bs:post`), and so does the cron's `wrangler tail` line. Every
other platform is one check, so its pair is 1 and 0 or 0 and 1.

### What it cannot tell you

It runs inside the worker it is checking, so it cannot report that the worker is unreachable: DNS, the
route binding, a failed deploy and a Cloudflare incident are all invisible to it. It detects platform
breakage. Treating it as an uptime monitor would be a worse mistake than not having it.

**It also cannot see the container.** On 2026-08-28 the resolver answered every request with
`501 Unsupported method` for roughly forty minutes, so every mux on every platform failed, and the
self-check stayed 17/17 green throughout. There were two reasons. Most checks never reach the
container at all, and YouTube's, which used to, now takes its metadata from Innertube in the Worker
rather than from `yt-dlp` in the container, so the platform most likely to expose a dead resolver had
stopped depending on it. And `cardVerdict` passed any card carrying a title and one thing to draw. A
video degraded to its poster still carries both, so a still and a player got the same verdict.

Since 2026-08-29 the `yt` row carries `expect: 'video'`, and `cardVerdict` answers `no-video` on a
playerless card (`src/smoke.ts`). That fixes the second reason but not the first. The pinned video's
mp4 is durable in R2, and a warm mux is one R2 head, so the row goes green whether or not the
container is running. The only tick that reaches this image is the one that finds the mp4 swept by
`expire-60d`, roughly one in sixty days. A green `/_smoke` therefore means the heads render, not that
the resolver is alive. `/_clients` is the check that reaches the container; run it when the counters
point at the mux and this check says fine.

The check urls are a fixed list of real posts. When one is deleted, that platform fails on every tick
until somebody swaps the entry, and the counter names the platform so you know where to look. Each
entry records the date it was last seen working. `src/smoke.ts` notes three of them as likelier than
the rest to disappear (Imgur's anonymous album, a Pinterest pin, a Lemmy post); read that block before
treating one of those as an outage.

### What a run costs

Measured 2026-08-12 by timing production from outside: a `/_smoke` run with every cache cold took
10.4s for the six checks that existed that morning, and 0.10-0.13s once they were warm. The ten checks
added the same day sum to 6.4s cold, 0.14-2.7s each, so a full tick takes fifteen to twenty seconds.
A scheduled tick always pays the cold cost: `POST_TTL` and `RESP_TTL` are 900s against a 30-minute
schedule, and `caches.default` is per-colo besides, so the entries one tick writes are rarely the
ones the next tick would read.

Facebook is the slowest single check at 4.0s cold, which is the number to compare against if one of
these ever needs a budget of its own.

The run is serial and stays serial. `/_smoke` reports its own elapsed `ms`, and each check reports
its own, so whoever next widens the list can read the cost instead of inheriting a number that was
true once. Each check has a 20s budget. A check that overruns it is reported as `timeout` and counted
as `smoke_fail`, which bounds a whole run at 17 x 20s = 340s, under Cloudflare's 15-minute ceiling on
a scheduled invocation. The bound matters because an individual subrequest has no time limit of its
own. Without it, one hung upstream could consume the invocation, and every check behind it would go
uncounted, which looks exactly like the "cron is not running" case above.

### The week it keeps, and who is told

The counters above alert nobody. On 2026-10-14 they showed TikTok failing on almost every tick since
2026-10-06 and Instagram on about half, unread for a week, while a `/_smoke` run from a residential
connection that morning passed all seventeen checks. A single run at report time can be green in the
middle of a red week. (TikTok's red week then turned out to be the cron's location, not a break; see
[Where it runs](#where-it-runs) below.)

So each scheduled run is also folded into one R2 object, `health/smoke.json` in the media bucket
(`src/health.ts`). It holds, per UTC day and per check, the ok/fail counts, the verdicts and the
Cloudflare location (colo) the run executed in, plus each check's last verdict and how many runs in a
row have failed. Eight days are kept. Only the cron writes it; `/_smoke` never does, since it is
public. Like the counters, it holds no url a reader sent, no ip and no user agent.

`/_health` publishes the last seven days of it, per check (`runs`, `fail`, `failRate`, `streak`,
`lastVerdict`, `colos`, `perDay`). It takes no input, answers JSON, is not cached, and is declined on
the guest domains like every other diagnostic.

`.github/workflows/health-check.yml` reads it every Monday and Thursday at 13:23 UTC. It also runs
`/_smoke` twice, a minute apart, from GitHub's network, which catches DNS, routes and a failed deploy
that a check running inside the Worker cannot see. It asks `/_clients` about the container, and
checks both guest domains and their `d.` names.

Anything broken becomes an issue labelled `health-check`, commented on every run while it stays
broken and closed when it passes again. Only a run that was able to check a problem closes its issue.
When `/_health` does not answer, no scheduled check can fail, so the open check issues are left as
they are and the run page lists them. Closing a check's issue also needs evidence that the check
passed: a week recorded within two hours with at least ten runs of that check, plus the live run.
`/_health` answers 503 when the week cannot be read, rather than a summary of zeros, and a scheduled
run whose read of the record fails skips its write rather than starting the week over. Each answer is
judged on what it says, not on its status, since `/_clients` answers 200 with `ok: false` when the
container serves nothing.

What counts as broken lives in `.github/scripts/health-lib.mjs`:

- more than 20% of a check's runs failing over the week (Dailymotion's expected cold tick is about 2%);
- six failures in a row;
- a failure that held across both live runs;
- the cron not having recorded a run for two hours;
- `/_clients` not serving;
- a guest domain answering wrong.

Run it by hand from the Actions tab (`workflow_dispatch`), or locally without filing anything:
`node .github/scripts/health-check.mjs`.

#### Where it runs

A Cron Trigger runs wherever Cloudflare puts it, and the upstreams answer by location. Measured
2026-10-14 from the subrequest analytics (`workersSubrequestsAdaptiveGroups`, which carries the colo,
host, status and body size of every request the Worker makes): the cron ran from LHR, FRA and SIN,
then from Mumbai (BOM) from 2026-10-05 20:30, Osaka (KIX) from 10-06 18:00, BOM again from 10-11
12:00, and LAX for one tick on 10-14. TikTok's row went red on the first BOM tick. From Mumbai, TikTok
answers a 76 KB page with no video in it; from Osaka, the post reads as unavailable. Real Discord
pastes of TikTok, which mostly leave from ATL, failed zero times in the same weeks. Instagram refuses
the full post page from BOM on every request, from KIX in Japanese daytime, and in bursts from ATL.

So the scheduled check runs inside a Durable Object (`SMOKE_RUNNER`, `src/smokerunner.ts`) created with
`locationHint: "enam"`, and its requests leave from eastern North America, where Discord's crawler
meets the same upstreams. A hint is best effort and only the first `get()` places the object, so the
record keeps each run's colo anyway. After a deploy, `colo` in `/_health` should be an eastern US code
(IAD, EWR, ATL and the like). If it is not, the object landed somewhere else, and changing
`SMOKE_RUNNER_NAME` creates a new one with the hint applied again. When the runner cannot be reached,
the tick is not recorded at all, rather than run from the cron's own location, so a runner that stays
unreachable shows up as the check having stopped. `/_smoke`, run by hand, still runs in the caller's
colo, which is why it passed from a residential connection while the cron was red.

The `colos` field answers whether a check fails only from one place. When an issue says the scheduled
run failed and the live run from GitHub passed, the location list says where the scheduled one ran.


## Diagnosing "the card never appeared"

Written 2026-08-08 from a report that took hours to chase and healed itself before it could be
caught. Follow the steps in order: each one rules out a layer, and the expensive one comes last.

This is for the hardest failure to chase. Discord shows nothing at all, this service answers HTTP 200,
and the post often works again by the time anyone looks. Take nothing as self-evident, and measure
one layer down at a time.

**1. Does the API answer, and is it degraded?**

```sh
curl -s 'https://mbedfx.app/_api/v1?url=<the post url>' | jq '{ok, pending, muxing, err: .error.code}'
```

`ok:false` names the layer immediately. `pending:true` matters most here: the translation lost its
race, so the card went out untranslated and uncached, and every unfurl re-runs the whole render.
Check `translate_pending` against its siblings before concluding anything from one sample.

`muxing:true` is not a fault by itself, and the real wait behind it is minutes, not seconds
(`docs/API.md`, "`muxing` and `pending`"). Ask again after the alarm's first wake at 35 s before
treating it as one. A `muxing:true` that never cleared on repeated asks used to be the signature of a
live stream, dispatched to a container that refuses it on every render. Since 2026-08-29 that case
answers `still:true, muxing:false` with a 🔴 note in `text`, so a stuck `muxing:true` on YouTube now
means something else and is worth chasing.

**2. What does Discord actually receive?**

```sh
curl -s -o /tmp/card.html -w '%{http_code} %{size_download}B %{time_total}s\n' '<the mbedfx url>' \
  -H 'user-agent: Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
```

A well-formed head is not proof: a post with media renders from the Mastodon-shaped document behind
`<link rel="alternate" type="application/activity+json">`, not from the og: tags. Fetch that too, and
check that `media_attachments[].meta.original` is present: `render/mastodon.ts` drops it on a zero
dimension, and an attachment with no size is a real cause of nothing being drawn.

**3. Compare against a post that works.**

Change one variable at a time. A report naming a different post on a different domain settles
nothing, and a whole afternoon was once lost to exactly that. Run the same post on both domains, and
both posts on one domain, before believing either result.

**4. Follow the media.**

```sh
curl -sL -o /dev/null -w '%{http_code} %{content_type} %{size_download}B\n' '<the og:video or og:image url>'
```

Assert on the content type, never the status. Every interesting failure on this service answers 200:
TikTok hands a 404 page as `text/html`, Meta hands a metadata-stripped shell, Instagram hands a decoy.

**5. If any of it depends on where the request comes from, measure from Cloudflare.**

`curl` from a laptop is a residential client and routinely gets a different answer than this Worker
does. `wrangler dev --remote` runs the real worker on Cloudflare, and it is the only way to get the
answer the Worker gets:

```sh
npx wrangler dev --remote --enable-containers=false
```

Both the Meta wall and the TikTok 404 were invisible until measured this way, and both had already
been reasoned about wrongly from a laptop. Preview URLs are behind Access and are not a substitute.

**6. Then read the counters.**

They are the only record that survives the incident, because Workers Logs are off on purpose.
`ok` broken down by `client` says whether Discord was served at all; the gate counters say whether
the post was walled rather than broken.

Two things cannot be answered after the fact, so don't spend time looking: whether Discord requested a
specific url, and what it did with the answer. Both need `event.request.url`, which is the pasted
post, and this service will not collect it. Instead, ask the reporter whether a re-paste still fails.
Discord caches a failed unfurl per url, so a healed post can keep showing nothing to the person who
first hit it.


## Recipes

Every recipe uses `SUM(_sample_interval)`. Shorten `INTERVAL '7' DAY` until the dataset has aged past
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

A platform can also be missing because it fell below the `LIMIT 200` cut.

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

**`meta_timeout` is in this query because leaving it out hid a defect for weeks.** The reader sees
the same failure card, but it gives the opposite answer to "who is broken": the container was still
extracting when our own budget ran out. Before `meta_timeout` existed those requests were counted as
`assert_fail`, so on `dm`, `st` and `im` this query answered "their upstream changed shape" about a
Dailymotion that was healthy at that instant. A rise in `meta_timeout` with `assert_fail` flat is a
budget or a cold container, and it is ours; the reverse is theirs. Both rising together is a slow
upstream.

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

Emitted by the `count(env, 'ig', …)` calls in `src/worker.ts` that name `copyright_gql` (two of
them), `copyright_recovered` and `copyright_remux`.

```sql
SELECT SUM(_sample_interval * (blob2 = 'copyright_gql')) AS gql,
       SUM(_sample_interval * (blob2 = 'copyright_recovered')) AS feed,
       SUM(_sample_interval * (blob2 = 'copyright_remux')) AS container,
       SUM(_sample_interval * (blob2 = 'fullpage_recovered')) AS fullpage,
       SUM(_sample_interval * (blob2 = 'graphql_recovered')) AS graphql,
       SUM(_sample_interval * (blob2 = 'fetch_fail')) AS fetch_fail,
       SUM(_sample_interval * (blob2 = 'ok')) AS ok
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 = 'ig'
```

All three at zero while `ok` keeps climbing means Instagram closed the recovery and every blocked
reel is a photo again. The cards render either way.

`graphql` against `fullpage` and `fetch_fail` says whether asking the shortcode query first (since
2026-10-14) is working. In the week to 10-13, before that change, real pastes failed about one time
in four, mostly on a full page Instagram refused. If `graphql` stays near zero while `fetch_fail` does
not fall, the query is being refused in the same windows as the page, which is the one thing nobody
measured when it shipped.

### Is Google refusing the Worker's egress

```sql
SELECT SUM(_sample_interval * (blob2 = 'translated')) AS google,
       SUM(_sample_interval * (blob2 = 'translate_fallback')) AS workers_ai
FROM mbedfx_counters
WHERE timestamp > NOW() - INTERVAL '7' DAY
```

`google` at zero while `workers_ai` climbs means the weaker fallback model (`FALLBACK_MODEL`,
`@cf/google/gemma-4-26b-a4b-it`, `FALLBACK_MODEL` in `src/translate.ts`) is carrying the feature. Nothing on the card
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

This is the ratio the spec's fetch-amplification alert watches. `handle()` writes it on the
`/_media/` and `/_api/v1` arms, and `serveDirectMedia` writes it too.

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
that route. It covers dashboards and alerting, and this repo needs no changes for it.

For a Prometheus scrape target, run a small exporter on your own network that queries this API and
emits Prometheus text. Off the public edge, none of the exposure described below applies.

---

## Why there is no `/_metrics`

The `AE` binding is write-only, and reads need the account-level SQL API and a bearer token. Adding
the route would give `Env` an account-scoped Cloudflare API token, live on the public edge, when the
same token already pulls this data from a laptop where it is not exposed. The `Env` docstring in
`src/analytics.ts` forbids the addition by name and records the precedent. The last secret-gated
endpoint mounted here fetched a caller-supplied shortcode from the Worker's egress, and was deleted
along with its module, its mount in `worker.ts` and its wrangler secret. Its path stays unspelled in
the source, and a test fails the suite for any comment naming it ("THE PROBE IS GONE" in
`test/pipeline.test.mjs`).

Three tests read the tree. `:1515` and `:2656` fail if the route returns, and `:2621` fails if a
comment outlives the file it names, which catches a half-finished deletion. `:1515` is named
"THE PROBE IS GONE: a debug egress endpoint must not ship to a public origin". `:2656` widened it
beyond the three strings `_probe`, `PROBE_TOKEN` and `runProbe` after an identical caller-driven
egress endpoint, added as `src/diag.ts` and mounted at `/_diag/`, passed the whole suite green with no
token gate. A fourth test, `:1541`, drives `/_probe/t?code=AAAAAAAAAAA` through `handle()` with
`PROBE_TOKEN: 't'` in env and asserts on the body. The code is eleven characters because `runProbe`
rejected anything failing `/^[A-Za-z0-9_-]{5,32}$/` with a 400 before emitting a report, so a shorter
code would pass even against a live mounted probe.

An ungated route would leak, and worst at `pool_unused`. `poolSetButUnused` is literally
`accountPool(env, platform).length > 0` (`src/credentials.ts:200`), so publishing it would publish
that mbedfx has logged-in IG/YT/X accounts loaded, and the `yt` arm would report whether they still
pass the age gate. The audience is the platform's enforcement team, who could turn a ban wave into an
experiment run against mbedfx's own endpoint. The Instagram copyright trio does the same for Meta, and
the translation pair for Google: each shows an outcome the card hides, and publishing it hands that
outcome to the party being measured. `api_bad_id` is a decode oracle for the `statusid.ts` SENTINEL
hazard, separating decode success from decode failure for a crafted callback id. Since anyone can
make the public Worker render any URL, a readable counter surface becomes a property oracle for
whichever post the observer picks.

The gap the README's table names is counters nobody can read. The documented SQL and the Grafana
pointer close it, for mbedfx and for any self-hoster, each with its own dataset and token. The row
should still not read "✅ Prometheus", because documented Analytics Engine access is not a scrape
endpoint. Whether fxTikTok's ✅ names the same feature is unestablished, since nobody here has read
their metrics handler.

If a route is wanted anyway, keep it off this Worker: a separate unrouted Worker or a cron job holds
the read token and writes a pre-aggregated summary, with no public surface and no account token at
the edge.

## Reading a hang-up: the invocation analytics

The counters say when a fetch started. They cannot say when the client left, because the runtime
cancels the invocation the moment it does, and anything the handler would have written after that
point never gets written (`workerd` `drain()`; the Workers limits page: "when the client disconnects
or the response is complete, tasks associated with that request may be canceled"). That is why the
`wait_*` rows are written before any hold.

The other half is in Cloudflare's own invocation analytics, which record every invocation's
status and wall time with no url, no post id and no user agent. Query them with GraphQL at account
scope:

```graphql
query($acct: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
  workersInvocationsAdaptive(limit: 500, filter: {datetime_geq: $from, datetime_leq: $to, scriptName_like: "%mbedfx%"},
                             orderBy: [datetime_ASC]) {
    dimensions { datetime status }
    sum { requests wallTime }
    quantiles { wallTimeP50 wallTimeP99 }
} } } }
```

`status` is `success`, `clientDisconnected`, `scriptThrewException` or `exceededResources`;
`wallTime` is in microseconds. A `clientDisconnected` row is a fetch the caller abandoned, and its
wall time is how long the caller waited. Pair it with the `wait_*` row at the same second to know
which fetch it was. That is how Discord's deadline was measured on 2026-09-02: four held fetches, four
`clientDisconnected` rows, wall times 9.67 s, 9.66 s (documents) and 9.15 s, 9.41 s (videos).

Read the counters at least three minutes after the last event, and away from :00 and :30. The
half-hourly smoke burst is sampled (`_sample_interval` 2-5), and a row written at t has been seen
absent 45 s later and present at two minutes.

**Never fire `/_smoke` yourself in the same minute as a single-row measurement.** Analytics Engine
samples at write time when the write rate spikes, and the sampling covers the whole window, not only
the burst. On 2026-09-03 a verification script called `/_smoke` right after a cold-paste proof, and
the proof's `video_wait`, `video_ok` and `mux_ok` rows were dropped while the rows beside them read
`_sample_interval` 2-4. Aggregates over many events survive sampling (the weighted sums above), but a
single proof does not.
