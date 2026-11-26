# Account pools for age-gated posts

For an age-gated post, Twitter answers a `TweetTombstone`, Instagram answers `"failure_reason":"MA"`
beside `"restricted_age":\d{1,3}`, and YouTube answers `age_limit: 18` with `formats: 0`. Each was
measured from a laptop and from the Worker's own egress: Twitter on 2026-07-19, `yt:G0sORVBL4kM` on
2026-07-30. That video returns a title, thumbnail, `duration=177` and `timestamp=1605871096` with
`formats: 0`. With no pool filled, those posts render `🔞 This post is age-restricted` over "Can't
preview age-restricted posts." in `#657786` (`src/render/index.ts:99`), which is the correct answer
when there are no accounts. A filled secret turns them into ordinary cards and changes nothing else.

**A pool is for the age gate and for nothing else, and a PO token is not one of these.** An operator
arriving from yt-dlp's PO Token Guide will reasonably assume that a token provider belongs beside
these pools. It does not, and this was measured. On 2026-08-28 `/_clients` extracted one video with
six player clients from the production container and range-fetched each chosen format. Five of the
six served bytes with no token at all, including `tv_simply` and `mweb`, the two clients that guide
lists as requiring a GVS token. Ordinary YouTube playback from this egress needs no credential and no
token. Five minters were built and tested before that measurement existed, and every positive result
had an equally green no-token control.

## Throwaways only

Every account in a pool is eventually lost. Use a throwaway, never a personal or primary account. A
pooled jar is spent from Cloudflare's datacenter egress at whatever rate mbedfx sees traffic, and
that gets an account flagged, rate-limited or locked.

The exported `cookies.txt` is the credential. Whoever holds the file is that account, from any IP,
until the account's session is revoked, and revoking that session is the only thing that helps. A
fresh export does not invalidate a leaked copy, and nobody changes the password until somebody has
already noticed something is wrong (`.gitignore:51-53`). `.gitignore:58-65` covers `cookies.txt`,
`*cookies.txt`, `*.cookies`, `cookies*.json`, `accounts.json`, `*accounts.json`, `secrets.json` and
`*.secrets`. The patterns are slashless so they match at any depth, and `!accounts.example.json` at
`:70` keeps the example committable. Those eight arrived with the pools in `75c2e7a` on 2026-08-03;
`.dev.vars`, `.env` and `.env.*` matched none of them. A browser export lands in whatever directory
the terminal was already in, which is `container/cookies.txt` more often than the repo root.
`test/credentials.test.mjs` asserts that each path is ignored and that `accounts.example.json` is
not.

## Which platforms spend them

| Secret | Spent today | Where the gate is beaten | Fields an entry must carry |
|---|---|---|---|
| `YT_ACCOUNTS` | Yes, since `g10` | inside yt-dlp, `container/server.py` | `cookies` |
| `IG_ACCOUNTS` | Container path only | inside yt-dlp, the copyright-remux mux | `cookies` |
| `X_ACCOUNTS` | No | `fetchWithCredentials`, `src/platforms/twitter/fetch.ts` | `auth_token` + `ct0` |

`fetchWithCredentials` returns `null` today, so `X_ACCOUNTS` is staged ahead of the logged-in
`TweetResultByRestId` call that would spend it. The seam stays empty on purpose: a half-built path
returns *something*, and a wrong answer from a logged-in request is what gets a pool flagged. A
gated tweet still fails once the secret is set, and each one increments `x`/`pool_unused`
(`src/worker.ts`) through `twitterAccounts()` (`src/credentials.ts:162`). That function keeps only
entries holding both `auth_token` and `ct0`, so an entry with only a cookie jar counts for nothing
there.

The `MA` verdict comes off the Worker's own page fetch, which carries no jar (`instagramAgeGate`,
`src/platforms/instagram/normalize.ts:643`). A filled `IG_ACCOUNTS` reaches only the container mux,
and gate detection stays where it was. `ig`/`pool_unused` (`src/worker.ts`) counts a post that the
jarless page fetch found walled while `IG_ACCOUNTS` holds an account. If it climbs, the credential is
not reaching the request that reads the `MA` verdict, and the count says nothing about whether the
accounts are still logged in.

## Getting a cookies.txt

Use a browser extension that exports Netscape format; "Get cookies.txt LOCALLY" is the usual one. A
JSON cookie export will not work.

1. Open a private / incognito window.
2. Log into the throwaway account.
3. Open a new tab, then close the login tab.
4. Export cookies for the site.
5. Close the private window without logging out.

Logging out at step 5 invalidates the session just exported, and a jar of dead cookies fails exactly
as if the gate had never lifted. The private window also stops ordinary browsing in the main profile
from rotating that session out. Once a YouTube account is exported, stop using it in a browser:
YouTube rotates cookies, and a session used in two places tends to invalidate the older one.

### YouTube Premium accounts

**Never use a Premium account.** `9cab036` added this section on 2026-08-04, the first time this
file mentioned upload dates at all, and recorded the mechanism. yt-dlp picks its player clients from
the cookies, and a Premium session selects a set with no `web_safari` (checked against yt-dlp
2026.07.04's source). Only `web_safari` carries the timezone-bearing microformat that
`ytDateSeconds` (`src/worker.ts`) parses `timestamp` from. A free throwaway was safe because
`web_safari` sits in the same position in both the anonymous and the ordinary logged-in client
lists. A Premium jar made the intermittent missing-date bug permanent on every YouTube video, and the
card read as a broken extract.

Two changes since then have put that mechanism out of reach, so today this is a standing precaution
and not a live defect. Since 2026-08-18 the container names its own clients on both the mux and the
meta call (`player_client=web_embedded,tv_simply,mweb`, `YT_PLAYER_CLIENTS`,
`container/server.py`). That list replaces yt-dlp's default instead of extending it, so cookies
choose nothing, and no `web_safari` is asked for with or without a jar. On the rung above the
container, the date, description, duration and view count come from `youtubei/v1/player` first
(`fetchInnertube`, `src/platforms/youtube/innertube.ts`), which is cookie-free and touches no client
list at all. Both are reversible. `container/server.py` argues that dropping the client override
needs its own production measurement, and Innertube is refused often enough from Cloudflare's egress
that the container fallback is ordinary traffic (WEB answered 5 of 10 ids there on 2026-08-27). So
keep using a free throwaway. The warning this section supersedes, that any cookie jar worsened the
epoch bug, was never written here; the 1.9.0 entry in `CHANGELOG.md` records how yt-dlp's source
refuted it.

### Dead jars

**An expired jar is worse than no jar.** yt-dlp decides whether it is logged in from the presence of
cookies, never from whether they work, and this service records the same thing. `jarred` is set from
`'cookies' in body` (`youtubeMeta`, `src/worker.ts`), so it says a credential was sent, not that it
was accepted. A dead jar therefore writes a gated record that looks like a measured "logged in, still
walled" answer, and `ytMetaUsable` trusts it for the full 30 days. Putting working accounts in the
pool afterwards heals nothing. Only a `META_GENERATION` bump does, per "Rotating" below. This warning
used to make a client-coverage argument as well; the pinned `YT_PLAYER_CLIENTS` list above
superseded it, because that list chooses the clients whatever the jar says. Watch `pool_unused`
after filling a pool, and rotate a stale jar out.

## Building the JSON

Each secret is a JSON array of entries. A cookies.txt is multi-line and tab-separated, so
hand-pasting one into a JSON string means escaping every newline and tab. The commands below need
`jq`.

```sh
jq -n --rawfile a alt1-cookies.txt --rawfile b alt2-cookies.txt \
  '[{label:"alt1",cookies:$a},{label:"alt2",cookies:$b}]' > accounts.json
```

This prints the labels and no cookie values:

```sh
jq '[.[].label]' accounts.json
```

`accounts.example.json` in the repo root has the finished shape: two labelled entries, each jar
starting `# Netscape HTTP Cookie File`, and every value spelled `EXAMPLE-NOT-A-REAL-VALUE`.
`test/credentials.test.mjs` parses it with `parseAccounts` and fails if a value stops looking
invented.

## Pushing it

```sh
npx wrangler secret put YT_ACCOUNTS -c wrangler.production.jsonc < accounts.json
rm accounts.json
```

The `-c` is what sends this to mbedfx.app. Leave it off and wrangler reads the root
`wrangler.jsonc`, the generic config, whose Worker is `mbedfx-selfhost`. If that Worker doesn't
exist yet, wrangler would normally ask before creating it, but with the value coming from a file
there is no prompt and the answer defaults to yes. Either way the pool lands on `mbedfx-selfhost` and
wrangler prints `Success!`. Only the output line naming the Worker shows the mistake, and mbedfx.app
keeps the old pool. On your own deployment of the generic file, drop the `-c`.

`IG_ACCOUNTS` takes the same command. Twitter entries hold a session pair:

```json
[ { "label": "alt1", "auth_token": "...", "ct0": "..." } ]
```

Delete the cookie exports afterwards. Nothing encrypts them, and Cloudflare now holds the copy the
Worker reads. A Worker secret is per-Worker and encrypted at rest, and it cannot be read back from the
dashboard or the CLI, so no command reports what was set. To check a pool, use the `docs/METRICS.md`
recipe "Are the account pools working", which reads the analytics counters.

### Cached gate verdicts

Filling a pool needs no deploy, no TTL wait and no cache flush, and `wrangler secret put` does not
have to be timed against a merge. `ytMetaUsable` (`src/worker.ts`) refuses a gated record carrying no
`jarred` flag while `jarAvailable(env, 'yt')` holds, and the next view re-extracts with the jar. That
conditional shipped in 1.9.0 on 2026-08-04 (its entry in `CHANGELOG.md`) and adds no second bump.
Without it, filling a secret heals none of the gated records written while the pool was empty, and
`pool_unused` reports the fresh accounts as dead.

`YT_META_TTL_MS` is 30 days (`src/worker.ts`; a record that says `isLive` expires in an hour
instead, which is the only exception and does not apply to a gate verdict). So every age-gated video
viewed before fill-day left a record saying `ageLimit: 18`, written by a jar-capable build with no
jar to send. Those were `g10` records, the generation the build of the day still wrote, so 1.8.0's
bump to `g10` retired nothing here. `metaCacheKey` (`src/worker.ts`) namespaces every record by
generation, and a bump would orphan these along with a month of good dates, descriptions and counts.

Three bumps have landed since, and the running build writes `g13`: `g11` on 2026-08-18 for the
player-client change, `g12` on 2026-08-28 with 1.11.0's single-extraction change, then `g13` the same
day. Each one paid that cost, so the pre-fill-day records are long gone. The `g13` bump was not spent
to invalidate a wrong record. It forced brand-new container instances out of a 501 outage, so keep
that outage in mind before reading a bump as evidence that the records were suspect. The 2026-08-29
split moved exactly that case to `RESOLVER_GENERATION`, where it costs no meta record.

Rotating a dead pool leaves the cached verdicts in place. A record measured with a jar that still
says gated is treated as correct, because the extract was logged in and walled anyway. Only a
`META_GENERATION` bump (`metaCacheKey`, `src/worker.ts`) clears it, **not** `RESOLVER_GENERATION`.
Since the two split on 2026-08-29, `RESOLVER_GENERATION` renames the pooled container instances and
invalidates no meta record. They held the same value on the day they were split, so a reader coming
from an older copy of this page will find both saying `g13`, with no way to tell from the value alone
which one matters.

## When something is wrong

`parseAccounts` (`src/credentials.ts:83`) never throws, and every malformed secret becomes an empty
pool with nothing reported. It runs on the request path for ordinary posts too, where a stray comma
in a credential nobody has looked at for a month would otherwise 500 every card on that platform. If
filling a pool changes nothing, check the JSON first:

```sh
jq . accounts.json    # if this errors, so did the Worker, just quietly
```

- A non-array is not coerced: a bare `{…}` object is an empty pool (`src/credentials.ts:91`).
- An entry carrying neither `cookies` nor `auth_token` is dropped (`src/credentials.ts:109`), so
  `{"label":"alt1"}` is not an account. A pool of two with one bad entry runs as a pool of one, at
  twice the load on the survivor.
- yt-dlp rejects a jar whose first line is not `# Netscape HTTP Cookie File`, answering `does not
  look like a Netscape format cookies file` with no other symptom. `_CookieJar.__enter__`
  (`container/server.py`) prepends the line and adds a trailing newline.
- The jar is a `tempfile.mkstemp` file at 0600, unlinked in `__exit__` even when yt-dlp raises or
  times out (`_CookieJar.__exit__`, `container/server.py`). yt-dlp reads cookies from a path and has
  no argv form, and must not gain one here. argv is world-readable in `/proc` on this box, so a jar
  passed as a flag would be readable by every process in the container (`_CookieJar`'s own note,
  `container/server.py`).
- `--cookies` splices at `cmd[1:1]` in both `_mux_page` and `_meta_page`, fixed in
  `d2c0b85` on 2026-08-03. The first version spliced at a negative index and landed between `-o` and
  its value, producing `-o --cookies <path> <out> -- <url>`. yt-dlp read `--cookies` as the output
  template, so every jarred mux wrote to the wrong place, and the bug could not show until a pool was
  filled.

## Rotating

### When one secret is not enough

A Worker secret holds about 5.1 kB, and Cloudflare refuses a bigger one with code 10054. A YouTube
jar trimmed to its sign-in cookies is about 2.3 kB, so `YT_ACCOUNTS` fits two accounts. Put the
rest in `YT_ACCOUNTS_2` and `YT_ACCOUNTS_3`, in the same JSON shape. The Worker reads all three and
joins them into one pool (`OVERFLOW_SUFFIXES`, `src/credentials.ts`), and a broken overflow empties
only itself. `IG_ACCOUNTS_2`/`_3` and `X_ACCOUNTS_2`/`_3` work the same way.

Replace the whole array and push it again. `wrangler secret put` has no partial update, so one dead
account means re-pushing every entry, then bumping `META_GENERATION` per "Cached gate verdicts"
above.

`pickAccount` (`src/credentials.ts:138`) picks an account at random on each request. Round-robin
needs state the edge does not share between isolates, and taking the first entry puts the whole load
on one account.

`label` is for the operator, to tell one throwaway from another between exports, and it is the only
field here safe to write down. The runtime never reads it and no counter carries it. The other
fields never reach a log line, an analytics blob, a cache key, an error body or a card: `count()`
(`src/analytics.ts`) accepts fixed enum strings only. `pool_unused` records, per platform, that a
jar was spent and the gate held. Making it per-account would put an account identifier where a log
could reach.
