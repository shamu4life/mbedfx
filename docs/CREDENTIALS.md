# Account pools for age-gated posts

Twitter answers a `TweetTombstone`, Instagram `"failure_reason":"MA"` beside
`"restricted_age":\d{1,3}`, YouTube `age_limit: 18` with `formats: 0`. Each was measured from a
laptop and from the Worker's own egress: Twitter on 2026-07-19, `yt:G0sORVBL4kM` on 2026-07-30. That
video returns a title, thumbnail, `duration=177` and `timestamp=1605871096` with `formats: 0`.
Unfilled, those posts render `🔞 This post is age-restricted` over "Can't preview age-restricted
posts." in `#657786` (`src/render/index.ts:61`), the correct answer without accounts. A filled
secret turns them into ordinary cards and changes nothing else.

---

## Throwaways only

Every account in a pool is eventually lost. Use a throwaway, never a personal or primary one: a
pooled jar is spent from Cloudflare's datacenter egress at whatever rate mbedfx sees traffic, and
that pattern is what gets an account flagged, rate-limited or locked.

The exported `cookies.txt` is the credential. Whoever holds the file is that account, from any IP,
until the account's session is revoked, and revoking that session is the only thing that helps: a
fresh export does not invalidate the leaked copy, and a password change is a rotation nobody makes
until somebody has already noticed something is wrong (`.gitignore:51-53`). `.gitignore:58-65`
covers `cookies.txt`, `*cookies.txt`, `*.cookies`, `cookies*.json`, `accounts.json`,
`*accounts.json`, `secrets.json` and `*.secrets`, slashless so they match at any depth, with
`!accounts.example.json` at `:70` keeping the example committable. Those eight arrived with the
pools in `75c2e7a` on 2026-08-03, and `.dev.vars`, `.env` and `.env.*` matched none of them. A
browser export lands in whatever directory the terminal was already in, `container/cookies.txt` more
often than the repo root. `test/credentials.test.mjs` asserts each path is ignored and
`accounts.example.json` is not.

---

## Which platforms spend them

| Secret | Spent today | Where the gate is beaten | Fields an entry must carry |
|---|---|---|---|
| `YT_ACCOUNTS` | Yes, since `g10` | inside yt-dlp, `container/server.py` | `cookies` |
| `IG_ACCOUNTS` | Container path only | inside yt-dlp, the copyright-remux mux | `cookies` |
| `X_ACCOUNTS` | No | `fetchWithCredentials`, `src/platforms/twitter/fetch.ts:468` | `auth_token` + `ct0` |

`fetchWithCredentials` returns `null` today, so `X_ACCOUNTS` stages ahead of the logged-in
`TweetResultByRestId` call that would spend it. The seam stays empty on purpose: a half-built path
returns *something*, and a wrong answer from a logged-in request is what gets a pool flagged. A
gated tweet still fails once the secret is set, and each one increments `x`/`pool_unused`
(`src/worker.ts:515`) through `twitterAccounts()` (`src/credentials.ts:146`), which keeps only
entries holding both `auth_token` and `ct0`; a cookie jar alone counts nothing there.

`instagramAgeGate` (`src/platforms/instagram/normalize.ts:643`) reads the `MA` verdict off the
Worker's own page fetch, which carries no jar. A filled `IG_ACCOUNTS` reaches only the container
mux, and gate detection stays where it was. A climbing `ig`/`pool_unused` (`src/worker.ts:351`) says
the credential is not reaching the request that needs it.

---

## Getting a cookies.txt

Use a browser extension that exports Netscape format. "Get cookies.txt LOCALLY" is the usual one,
and a JSON cookie export will not work.

1. Open a private / incognito window.
2. Log into the throwaway account.
3. Open a new tab, then close the login tab.
4. Export cookies for the site.
5. Close the private window without logging out.

Logging out at step 5 invalidates the session just exported, and a jar of dead cookies fails exactly
as if the gate had never lifted. The private window also keeps ordinary browsing in the main profile
from rotating that session out. Stop using a YouTube account in a browser once it is exported;
YouTube rotates cookies, and a session used in two places tends to invalidate the older one.

### YouTube Premium accounts

**Never use a Premium account.** yt-dlp picks its player clients from the cookies, and a Premium
session selects a set with no `web_safari`, checked against yt-dlp 2026.07.04's source. `web_safari`
alone carries the timezone-bearing microformat that `ytDateSeconds` (`src/worker.ts:2264`) parses
`timestamp` from. A Premium jar makes the intermittent missing-date bug permanent on every YouTube
video, and the card reads as a broken extract. An ordinary free throwaway is fine: `web_safari` sits
in the same position of both the anonymous and the ordinary logged-in client lists. `9cab036` added
this section on 2026-08-04, the first time this file mentioned upload dates at all; the warning it
supersedes, that any cookie jar worsened the epoch bug, was never written here, and
`docs/CHANGELOG.md:266` records its refutation at yt-dlp's source.

### Dead jars

**An expired jar is worse than no jar.** yt-dlp decides whether it is logged in from the presence of
cookies, never from whether they work. A dead jar still selects the logged-in client set, where one
client requires auth and fails, leaving less format coverage than an anonymous extract. Watch
`pool_unused` after filling a pool, and rotate a stale jar out.

---

## Building the JSON

Each secret is a JSON array of entries, and the commands below need `jq`. A cookies.txt is
multi-line and tab-separated, so hand-pasting one into a JSON string means escaping every newline
and tab.

```sh
jq -n --rawfile a alt1-cookies.txt --rawfile b alt2-cookies.txt \
  '[{label:"alt1",cookies:$a},{label:"alt2",cookies:$b}]' > accounts.json
```

This prints the labels and no cookie values:

```sh
jq '[.[].label]' accounts.json
```

`accounts.example.json` in the repo root carries the finished shape: two labelled entries, each jar
starting `# Netscape HTTP Cookie File`, every value spelled `EXAMPLE-NOT-A-REAL-VALUE`.
`test/credentials.test.mjs` parses it with `parseAccounts` and fails if a value stops looking
invented.

---

## Pushing it

```sh
npx wrangler secret put YT_ACCOUNTS < accounts.json
rm accounts.json
```

`IG_ACCOUNTS` takes the same command. Twitter entries hold a session pair:

```json
[ { "label": "alt1", "auth_token": "...", "ct0": "..." } ]
```

Delete the cookie exports afterwards; no encryption covers them, and Cloudflare now holds the copy
the Worker reads. A Worker secret is per-Worker and encrypted at rest, and cannot be read back from
the dashboard or the CLI, so no command reports what was set. The read is the `docs/METRICS.md`
recipe "Are the account pools working", against the analytics counters.

### Cached gate verdicts

Filling a pool needs no deploy, no TTL wait, no cache flush, and no timing of `wrangler secret put`
against a merge. `YT_META_TTL_MS` is 30 days (`src/worker.ts:2118`), so every age-gated video viewed
before fill-day left a record saying `ageLimit: 18`, written by a jar-capable build with no jar to
send. Those are `g10` records too, the generation the running build still writes, so 1.8.0's bump to
`g10` retired nothing here: `metaCacheKey` (`src/worker.ts:1657`) namespaces every record by
generation, and a bump to `g11` would orphan these along with a month of good dates, descriptions
and counts. `ytMetaUsable` (`src/worker.ts:2240`) refuses a gated record carrying no `jarred` flag
while `jarAvailable(env, 'yt')` holds, and the next view re-extracts with the jar. That conditional
shipped in 1.9.0 on 2026-08-04 (`docs/CHANGELOG.md:8`, `:42`) and adds no second bump. Without it,
filling a secret heals none of those records, and `pool_unused` reports the fresh accounts as dead.

Rotating a dead pool leaves the cached verdicts in place. A record measured with a jar that still
says gated describes an extract that was logged in and walled anyway, so it is believed. Only a
`RESOLVER_GENERATION` bump (`src/worker.ts:1187`, currently `g10`) clears it.

---

## When something is wrong

`parseAccounts` (`src/credentials.ts:76`) never throws, and every malformed secret becomes an empty
pool with nothing reported. It runs on the request path for ordinary posts too, where a stray comma
in a credential nobody has looked at for a month would otherwise 500 every card on that platform. If
filling a pool changes nothing, check the JSON first:

```sh
jq . accounts.json    # if this errors, so did the Worker, just quietly
```

- A non-array is not coerced: a bare `{…}` object is an empty pool (`src/credentials.ts:84`).
- An entry carrying neither `cookies` nor `auth_token` is dropped (`src/credentials.ts:102`), so
  `{"label":"alt1"}` is not an account. A pool of two with one bad entry runs as a pool of one, at
  twice the load on the survivor.
- yt-dlp rejects a jar whose first line is not `# Netscape HTTP Cookie File`, answering `does not
  look like a Netscape format cookies file` with no other symptom. `container/server.py:125`
  prepends the line and adds a trailing newline.
- The jar is a `tempfile.mkstemp` file at 0600, unlinked in `__exit__` even when yt-dlp raises or
  times out (`container/server.py:118`). yt-dlp reads cookies from a path and has no argv form, and
  must not gain one here: argv is world-readable in `/proc` on this box, and a jar passed as a flag
  would be readable by every process in the container (`container/server.py:96-98`).
- `--cookies` splices at `cmd[1:1]` in `_mux_page` (`:215`) and `_meta_page` (`:241`), fixed in
  `d2c0b85` on 2026-08-03. The first version spliced at a negative index and landed between `-o` and
  its value, producing `-o --cookies <path> <out> -- <url>`. yt-dlp read `--cookies` as the output
  template, so every jarred mux wrote to the wrong place, and it could not fire until a pool was
  filled.

---

## Rotating

Replace the whole array and push it again. `wrangler secret put` has no partial update, so one dead
account means re-pushing every entry, then bumping `RESOLVER_GENERATION` per "Cached gate verdicts"
above.

`pickAccount` (`src/credentials.ts:121`) picks per request at random. Round-robin needs state the
edge does not share between isolates, and taking the first entry puts the whole load on one account.

`label` is operator-facing and the only field here safe to write down, for telling one throwaway
from another between exports. The runtime never reads it and no counter carries it. The other fields
never reach a log line, an analytics blob, a cache key, an error body or a card: `count()`
(`src/analytics.ts:224`) accepts fixed enum strings only. `pool_unused` records that a jar was spent
and the gate held, per platform, and making it per-account would put an account identifier where a
log could reach.
