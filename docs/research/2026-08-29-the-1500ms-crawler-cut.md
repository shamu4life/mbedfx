# The 1500 ms crawler cut, and why it could never have worked

Measured 2026-08-29 against the live `mbedfx_counters` Analytics Engine dataset and against the
source and history of this repository. This note records why `MUX_WAIT_BOT_MS = 1500` was chosen, why
the two claims that justified it are now false, and what the counters say about the choice.

It is frozen at its measurement date. The changes it led to are in `docs/CHANGELOG.md` under 1.12.0.

## What the cut did

`553bd2e` (2026-08-09, PR #35, "Answer a crawler in a second, instead of spending thirteen and losing
it") replaced two budgets with one. Discord fetches two documents for a card: the HTML head, and the
Mastodon-shaped activity document the head advertises at `rel=alternate application/activity+json`.
Before the cut they had separate ceilings.

| Document | Budget before | Budget after |
|---|---|---|
| HTML head | `HTML_DEADLINE_MS` (5000 ms) minus elapsed | `min(MUX_WAIT_BOT_MS, HTML_DEADLINE_MS − elapsed)` = 1500 ms |
| Activity document, mux arm | `MUX_WAIT_API_MS` (9000 ms) | `min(MUX_WAIT_BOT_MS, MUX_WAIT_API_MS)` = 1500 ms |
| Activity document, metadata arm | no route-level cap; `META_WAIT_API_MS` (8000 ms) inside `youtubeMeta` | wrapped in `deadline(…, 1500 ms)` |
| Activity document, translation arm | `MUX_WAIT_API_MS` (9000 ms) | 1500 ms |
| `/_api/v1` and `/_card` | 9000 ms | unchanged |

The activity document is the one that matters. It decides `media_attachments[].type`, which is
whether Discord draws a player or a photograph. The head cannot decide it: `renderSpoof`
(`src/render/discord.ts`) emits `og:video` only for a media entry whose `kind` is `video`, and a mux
that has not finished is degraded to a still before the head is written.

## The evidence the cut was built on

Four cold videos, timed by the engineer against production on 2026-08-09, quoted from the commit
message:

```
card, fully cold          5.14 - 5.18s   no media on it
activity document, cold   8.19 - 8.29s
card, second view         0.19 - 0.29s   with og:video
```

The reported symptom was "YouTube links fail to embed until warmed on the site", meaning no card at
all. The commit added the two rows together, called it "~13s across the two documents Discord
fetches", and concluded "It leaves at 3-4s, so the reader gets nothing at all."

Two problems with that inference, both visible without any new measurement.

**The two rows are two independent requests, and only the first one is implicated.** The activity URL
exists nowhere but inside the head, so Discord cannot issue that request until it has received and
parsed the head in full. If the head was abandoned, Discord never parsed it, never issued the second
request, and the 8.2 s row was never in the causal path. What the report actually bounds is the
head: Discord's tolerance for it is under 5.14 s. That is the only number in this repository derived
from Discord's own behaviour, and it is a bound on one request, not a budget for two.

**"It leaves at 3-4s" cites nothing.** Before this note was written, that phrase appeared exactly
once anywhere in the repository, in this commit message, with no source. It is the load-bearing
number under the whole cut.

## The two claims that justified the cost, and how each went false

The commit was explicit that the cut had a price, and argued the price was small for two reasons.

**"NOTHING IS ABANDONED. Both the mux and the meta extract run under `ctx.waitUntil` with the R2
write inside the raced work, so a deadline this side of the answer still lands the record."** False.
Cloudflare cancels unsettled `waitUntil` promises 30 seconds after the response, on a budget shared
across every `waitUntil` in the same request. A YouTube mux has a p50 of 18.2 s and a p90 of 41.3 s
(below), so a large share of the work the cut was banking on was killed, and a killed attempt leaves
zero bytes: the container buffers the whole file before sending one and writes to an `mkstemp` it
deletes in a `finally`, so there is no partial object and no resumable `.part`. This was found on
2026-08-23 and fixed by moving the mux onto a MuxRunner Durable Object alarm, which gets fifteen
minutes. The claim is true again now, by a different mechanism than the one it named.

**"It is accepted only because the alternative is NO CARD AT ALL and it lasts one view."** False, and
false in the direction that matters. Discord stores the embed it drew inside the message and does not
re-unfurl a link it has already drawn (jhgg, discord-api-docs#1663). Four files in this tree cite
that issue — `src/fetchretry.ts`, `src/worker.ts`, `src/platforms/twitter/fetch.ts`,
`src/platforms/youtube/innertube.ts` — and `src/analytics.ts` states the consequence plainly:
"Discord caches an embed permanently in the message, so `card_degraded/ok` on `blob3='discord'` IS
the first-paste failure rate." A degraded first paste is not one bad view. It is that message,
forever, for everyone who ever scrolls past it.

Note that this one cuts both ways. It is why raising the budget is worth doing, and it is why losing
the bet is permanent.

## What the counters say

Read 2026-08-29 through Cloudflare's account-level SQL API. Every figure weights by
`_sample_interval`, because the data is sampled and that interval took values from 1 to 12 in this
window. A bare `COUNT()` under-reports badly.

Successful YouTube muxes, all of them since the `mux_*` rows went live on 2026-08-24 (n = 139):

```
p10  6922 ms      p50  18219 ms      p90  41254 ms      min  4200 ms      max  168851 ms

finished within  1500 ms (MUX_WAIT_BOT_MS)         0 of 139
finished within  5000 ms (the old head budget)     4 of 139
finished within  9000 ms (the old activity budget) 23 of 139
finished within 15000 ms                          52 of 139
```

**No successful YouTube mux in the counter's entire history finished inside 1500 ms.** The fastest
one ever recorded is 4200 ms. This is not a poor hit rate to be improved, it is a race lost before it
starts, and it has been for three weeks. The 9000 ms activity budget the cut removed would have
caught 17% of them.

Restricted to 2026-08-29, the same rows are faster and still out of reach: n = 61, p10 5493 ms, p50
10745 ms, p90 19411 ms, min 4200 ms, max 31645 ms. Failure is common independently of any budget:
in that window `mux_ok` 61 (mean 12.0 s), `mux_empty` 32 (mean 3.8 s), `mux_gate` 5 (mean 1.0 s), so
38% of dispatched YouTube muxes produce nothing at all.

`card_degraded` versus `ok` on `blob1='yt'`, `blob3='discord'`, all time: **336 degraded, 583 ok.**
Hour by hour the shape is more useful than the ratio. There is a flat floor of 1 to 8 `ok` per hour
with `degraded` at zero, punctuated by five bursts where the two are roughly equal:

```
08-27 03:00  111 / 111   (1.00)
08-27 04:00   30 /  26   (1.15)
08-27 05:00   62 /  43   (1.44)
08-29 01:00   34 /  52   (0.65)
08-29 02:00   44 /  33   (1.33)
```

During real YouTube paste activity the ratio runs 0.65 to 1.44 and clusters on 1.0. The 111/111 hour
is the cleanest reading in the set: cold first pastes and degraded cards arriving in pairs.

`card_degraded` all time by platform is `yt`/discord 336 and `yt`/human 69, then Instagram 2,
Dailymotion 2, Facebook 1. This is a YouTube problem and nothing else's.

### Four caveats, and two of them are defects

1. **The smoke cron is in the `ok` denominator.** `src/smoke.ts` sets `SMOKE_CLIENT = 'other-bot'`
   "so a monitor's traffic never dilutes a reader's", and that is true only of the outer
   `smoke_ok`/`smoke_fail` pair. The inner render is driven with a Discordbot user-agent, so every
   cron tick fires `ok` with `blob3='discord'`. At two ticks an hour the cron alone is roughly 38 of
   the 144 `ok` rows in the 2026-08-29 window, and its YouTube check runs off a warm R2 object so it
   can never degrade. The published ratio is biased downward by it.
2. **There is very little organic YouTube traffic here.** Every burst above sits minutes after a
   deploy. These are cold-paste verification sessions, which bias the ratio upward. So 0.59 is too
   low and 1.0 is too high, and neither should be quoted as the production failure rate. Quote
   "0 of 139 muxes beat 1500 ms" instead, which is not a rate and does not care about the mix.
3. `card_degraded` has one emit site, inside a per-media-item map. A YouTube post is one video, so
   degraded-to-render is about 1:1 there and the ratio does not inflate the way it would on a
   multi-image Instagram post. Consistent with the observed 111/111.
4. Three of the queries published in `docs/METRICS.md` had never been run and none of them worked:
   the table is `mbedfx_counters`, not `mbedfx`, and Analytics Engine SQL rejects a backslash in a
   string literal outright with HTTP 422, so `LIKE 'mux\_%'` errors. Both fixed with this release.

### The query

```sql
SELECT SUM(IF(blob2 = 'card_degraded', _sample_interval, 0)) AS degraded,
       SUM(IF(blob2 = 'ok', _sample_interval, 0)) AS ok
FROM mbedfx_counters
WHERE timestamp >= toDateTime('2026-08-29 00:00:00')
  AND blob1 = 'yt' AND blob3 = 'discord'
  AND blob2 IN ('card_degraded', 'ok')
```

`toDateTime('YYYY-MM-DD HH:MM:SS')` pins an absolute window. `NOW() - INTERVAL 'N' HOUR`,
`toStartOfHour()` and `quantileExactWeighted()` all work; `toStartOfInterval(timestamp, INTERVAL 30
MINUTE)` does not.

## What losing the activity fetch actually costs

The optimistic reading of an abandoned activity fetch is that Discord already holds the head, so it
loses only the upgrade from photograph to player. That is wrong for the cold YouTube case, and it is
the reason 4000 ms was chosen over 8000.

`renderSpoof` emits `og:image` only when the post has no usable media, and a YouTube post always has
usable media, warm or cold. So the cold head carries a title, a colour stripe, a canonical link, the
`twitter:card` boilerplate, and a description about half the time — `post.text` is empty whenever the
Innertube call was refused, which is 40 to 50% of the time from this egress. No picture of any kind.
The commit's own measurement table says it in four words, against the cold-card row: **"no media on
it."**

So the trade is real rather than free. What the budget risks is not the player, which is lost either
way on a cold paste. It is the thumbnail. Losing the activity fetch turns a frozen thumbnail card
into a frozen title-only card, and that is worse. The ceiling argument is therefore the argument, and
it is why the budget landed at 4000 ms rather than the 8000 ms that would catch a great deal more.

## What shipped

`YT_MUX_BOT_MS = 4000` on the mux arm of the activity document, YouTube only. `YT_META_BOT_MS =
2800` on its metadata arm, sized off `INNERTUBE_TIMEOUT_MS` (2500 ms) plus a floor, because 1500 sat
below the 1716 ms median of that call's own successes. The head, the `/_oembed` callback and every
non-YouTube activity document keep `MUX_WAIT_BOT_MS = 1500`. The three arms race in one
`Promise.all`, so the response ends at the largest of them and not at their sum, and the number that
has to stay under Discord's tolerance is 4000 plus serialisation, near 4.2-4.3 s.

At 4000 the mux has roughly 5.3 s elapsed when the deadline fires, counting the head's own duration
and the gap before the second request. Against the distribution above that is the fast tail: perhaps
5 of 139, where 1500 catches zero. It is a tolerance step, not a fix. What fixes a cold paste is the
mux getting faster or the crawler waiting longer, and only one of those is ours.

## Open questions

**What is Discord's real abandon threshold, and what does an abandoned fetch render?** Nobody has
measured either. Everything above rests on one data point (a 5.14 s head drew no card) and one
unsourced phrase ("it leaves at 3-4s"). The experiment is cheap and is the same
human-with-a-Discord-client oracle the head-parity work already used: make the activity route sleep
N seconds for one designated ref, paste that link into a real client, and record what draws at N = 3,
5, 8 and 12. That answers the tolerance and the fallback in one pass. With it, 8000 is probably
defensible and the cold-paste player comes back for most videos. Without it, 4000 is as far as the
evidence reaches.

**Is Cloudflare's throughput limit per-connection or per-egress?** The 267 KB/s figure that raised
this question is retired: it was measured on the quarter-core `basic` container against yt-dlp
2026.7.4, and both terms have since moved (`standard-2`, 2026.8.19). The question survives the
number. If the limit is per-connection, a parallel-fragment download is worth building and would move
the p50 directly. If it is per-egress, it is a wall and the only lever left is not downloading as
much. Re-measure before quoting anything from the old note
(`docs/research/2026-08-23-youtube-mux-ceilings-and-bytes.md`).

**Does `card_degraded / ok` need the monitor separated out before it can answer whether this worked?**
As it stands the cron contributes `ok` rows it can never pair a degrade with, so the ratio improves
whenever the cron runs more often. Either give the inner render its own client tag or subtract the
cron's known rate. Until then the honest instrument for this change is the mux distribution, not the
ratio.

**`card_degraded / ok` cannot see the failure this change risks.** A degrade is a card we rendered; an
abandon is Discord hanging up on us. The counter moves only on the success side, so a raised budget
that loses more cards than it wins would show up here as an improvement. Watching it has to be paired
with client disconnects on the activity route.
