# Account pools for age-gated posts

Three platforms hide a post behind an age gate, and only a logged-in session gets past. Twitter
serves a tombstone, Instagram reports `failure_reason:"MA"`, and YouTube reports `age_limit:18` with
`formats: 0`, measured from a laptop and from the Worker's own egress. Without accounts those posts
get the "this post is age-restricted" card. That card is the correct answer without accounts, not a
bug. Fill these secrets and they render as ordinary cards, and nothing else changes.

---

## Before anything else

Any account in a pool will eventually be lost. It gets used from a datacenter IP at whatever rate the
service sees traffic, which is what gets accounts flagged, rate-limited or locked. Use throwaways,
never a personal or primary account.

A cookie jar is a bearer credential. Whoever has the file is logged in as that account, from
anywhere, until the session is revoked. It cannot be rotated by changing a password without somebody
noticing something is wrong first.

Git ignores the local files. `cookies.txt`, `*cookies.txt`, `*.cookies`, `accounts.json`,
`secrets.json` and friends are ignored at any depth. The patterns were added because `.dev.vars`
matched none of those names, and a browser export lands in whatever directory the terminal is
already in.

---

## Which platforms use them

Only two of the three do anything yet.

| Secret | Used today | Where the gate is beaten |
|---|---|---|
| `YT_ACCOUNTS` | Yes | Inside yt-dlp, in the video container |
| `IG_ACCOUNTS` | Partly (see below) | Inside yt-dlp, in the video container |
| `X_ACCOUNTS` | No, not yet | In the Worker, and that call is not built |

`X_ACCOUNTS` can be filled today and will do nothing. Twitter's gate needs a `TweetResultByRestId`
call that is deliberately unbuilt — a half-built login path is worse than none. The secret exists so
it can be put in place ahead of that work. A gated tweet will still fail once the pool is filled, and
each failure increments `pool_unused` for `x`, provided the entry carries both `auth_token` and
`ct0`.

`IG_ACCOUNTS` only reaches the container path. Instagram's `MA` gate is read off the Worker's own
page fetch, which carries no cookie jar, so a filled pool helps video resolution and leaves the gate
detection where it was. A rising `ig` `pool_unused` count means the credential isn't reaching the
request that needs it.

---

## Getting a cookies.txt

Use a browser extension that exports Netscape format. "Get cookies.txt LOCALLY" is the usual one. A
JSON cookie export will not work.

Export from a private window:

1. Open a private / incognito window.
2. Log into the throwaway account.
3. Open a new tab, then close the login tab.
4. Export cookies for the site.
5. Close the private window without logging out.

Logging out at step 5 invalidates the session you just exported, and you will have a file full of
dead cookies that fails exactly as if the gate had never lifted. A private window also keeps ordinary
browsing in your main profile from rotating the session out from under you.

Don't keep using a YouTube account in a browser after you export it. YouTube rotates cookies, and a
session used in two places tends to invalidate the older one.

### YouTube Premium accounts

Never use a Premium account. yt-dlp picks its player clients from the cookies, and a Premium session
selects a set with no `web_safari` (checked against yt-dlp 2026.07.04's source). That's the only
client carrying the timezone-bearing microformat the upload date is parsed from, so a Premium jar
makes the intermittent missing-date bug permanent on every YouTube video, and it looks like the
extract is broken.

An ordinary free throwaway is fine. `web_safari` sits in the same position of both the anonymous and
the ordinary logged-in client lists.

### Dead jars

yt-dlp decides whether it's logged in from the presence of cookies, not from whether they work. An
expired jar still selects the logged-in client set, where one client requires auth and fails,
leaving less format coverage than an anonymous extract. A dead jar is worse than no jar. Watch
`pool_unused` after you fill a pool, and rotate a stale jar out.

---

## Building the JSON

All three secrets are a JSON array of entries, and the commands below need `jq`.

A cookies.txt is multi-line and tab-separated, so pasting one into a JSON string by hand means
escaping every newline and tab. Let `jq` do it:

```sh
jq -n --rawfile a alt1-cookies.txt --rawfile b alt2-cookies.txt \
  '[{label:"alt1",cookies:$a},{label:"alt2",cookies:$b}]' > accounts.json
```

This prints the labels and no cookie values:

```sh
jq '[.[].label]' accounts.json
```

`accounts.example.json` in the repo root shows the finished shape with invented values.

---

## Pushing it

Push the array into the secret, then delete the local copy:

```sh
npx wrangler secret put YT_ACCOUNTS < accounts.json
rm accounts.json
```

`IG_ACCOUNTS` takes the same command. Twitter entries hold a session pair:

```json
[ { "label": "alt1", "auth_token": "...", "ct0": "..." } ]
```

Delete your cookie exports too when you are done. Nothing encrypts them, and Cloudflare now holds
the copy the Worker reads.

Secrets are per-Worker and encrypted at rest, and cannot be read back from the dashboard or the CLI —
which is the point, and why there is no command to check what you set. To confirm a pool is being
read, watch the analytics counters. `docs/METRICS.md` has that query as recipe 3, "Are the account
pools working".

### Cached gate verdicts

Filling a pool needs no deploy. You don't have to wait out a TTL, flush a cache, or time your
`wrangler secret put` against a merge.

A YouTube gate verdict is cached for 30 days, so every age-gated video viewed before the secret was
filled left a record saying gated, written by a build with no jar to send. Those records now carry
whether the extract was logged in, and once a pool exists the resolver refuses any gated record
whose extract was not. The next view re-extracts that video with the jar.

If you rotate a dead pool out, the cached verdicts don't move with it. A record measured with a jar
that still says gated describes an extract that was logged in and walled anyway. Only a
`RESOLVER_GENERATION` bump clears it.

---

## When something is wrong

`parseAccounts` never throws. A malformed secret becomes an empty pool and nothing reports an error.
The function runs on the request path for ordinary posts too, and a stray comma in one credential
must not take a whole platform down. If filling a pool changes nothing, check the JSON first:

```sh
jq . accounts.json    # if this errors, so did the Worker, just quietly
```

An entry with no credential is dropped, so `{"label":"alt1"}` on its own is not an account, and a
pool of two with one bad entry runs as a pool of one — it works, at twice the load on the survivor.

yt-dlp rejects a jar with no Netscape header. The container prepends `# Netscape HTTP Cookie File`
when your export lacks it. You do not need to add it yourself.

---

## Rotating

Replace the whole array and push it again. `wrangler secret put` has no partial update, so one dead
account means re-pushing every entry. Then bump `RESOLVER_GENERATION`, for the reason under "Cached
gate verdicts" above.

`label` is operator-facing, the only field here safe to write down, and it exists for telling one
throwaway from another between exports. Nothing reads it at runtime and no counter carries it.

None of the other fields is logged, sent to analytics, used in a cache key, or written into an error
body or a card. `pool_unused` records that a jar was spent and the gate still held, and making it
per-account would put an account identifier where a log could reach.
