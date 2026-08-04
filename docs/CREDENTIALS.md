# Account pools for age-gated posts

Age gates are the one failure this project cannot degrade its way out of. Twitter's tombstone,
Instagram's `failure_reason:"MA"`, and a YouTube video reporting `age_limit:18` with `formats: 0` are
all unreachable without being logged in — measured on both a laptop and the Worker's own egress. The
"this post is age-restricted" card is the **correct** answer without accounts, not a bug.

Setting these turns those posts into ordinary cards. Nothing else changes.

---

## Before anything else

**Use throwaway accounts.** Never a personal or primary account. A pooled account gets used from a
datacenter IP at whatever rate the service sees traffic, which is exactly the pattern that gets an
account flagged, rate-limited, or locked. Assume any account you put here will eventually be lost.

**A cookie jar is a bearer credential, not a config value.** Anyone holding the file is logged in as
that account, from anywhere, until the session is revoked. It cannot be rotated by changing a
password without noticing something is wrong first.

**The files are gitignored, and that was added for this.** `cookies.txt`, `*cookies.txt`,
`*.cookies`, `accounts.json`, `secrets.json` and friends are ignored at any depth. `.dev.vars`
matched none of those names before, and the natural place to save a browser export is whatever
directory the terminal is already in.

---

## Which platforms actually use them

| Secret | Used today | Where the gate is beaten |
|---|---|---|
| `YT_ACCOUNTS` | **Yes** | Inside yt-dlp, in the video container |
| `IG_ACCOUNTS` | **Partly** — see below | Inside yt-dlp, in the video container |
| `X_ACCOUNTS` | **No, not yet** | In the Worker, and that call is not built |

**`X_ACCOUNTS` can be filled today and will do nothing.** Twitter's gate needs a `TweetResultByRestId`
call that is deliberately unbuilt — a half-built login path is worse than none. The secret exists so
it can be put in place ahead of that work. If you fill it and gated tweets still fail, that is
expected, and it is counted as `pool_unused` rather than left as a mystery.

**`IG_ACCOUNTS` only reaches the container path.** Instagram's `MA` gate is read off the Worker's own
page fetch, which carries no cookie jar, so a filled Instagram pool helps the video-resolution path
and not the gate detection. A rising `ig` `pool_unused` count means the credential is not reaching the
request that needs it.

---

## Getting a cookies.txt

Use a browser extension that exports **Netscape format** — "Get cookies.txt LOCALLY" is the usual
one. A JSON cookie export will not work.

**Do it in a private window, and this part matters more than it looks:**

1. Open a **private / incognito** window.
2. Log into the throwaway account.
3. Open a new tab, then **close the tab you logged in on**.
4. Export cookies for the site.
5. **Close the private window without logging out.**

Logging out invalidates the session you just exported, and you will have a file full of dead cookies
that fails in a way that looks like the gate never lifted. A private window also keeps the session
from being rotated out from under you by ordinary browsing in your main profile.

For YouTube specifically: do not keep using that account in a browser afterwards. YouTube rotates
cookies, and a session used in two places tends to invalidate the older one.

---

## Building the JSON

The secret is a JSON array. A cookies.txt is multi-line and tab-separated, so it **cannot be pasted
into a JSON string by hand** — the newlines and tabs have to be escaped. Let `jq` do it:

```sh
jq -n --rawfile a alt1-cookies.txt --rawfile b alt2-cookies.txt \
  '[{label:"alt1",cookies:$a},{label:"alt2",cookies:$b}]' > accounts.json
```

Check it looks right (this prints the labels only, never the cookies):

```sh
jq '[.[].label]' accounts.json
```

`accounts.example.json` in the repo root shows the finished shape with invented values.

---

## Pushing it

```sh
npx wrangler secret put YT_ACCOUNTS < accounts.json
rm accounts.json
```

Same for `IG_ACCOUNTS`. For Twitter the entries are a session pair rather than a jar:

```json
[ { "label": "alt1", "auth_token": "...", "ct0": "..." } ]
```

**Delete the local files when you are done.** They are gitignored, not encrypted, and there is no
reason to keep a live session on disk once Cloudflare has it.

Secrets are per-Worker and encrypted at rest. They cannot be read back from the dashboard or the CLI —
which is the point, and also why there is no "check what I set" command. To confirm a pool is being
read, watch the analytics counters rather than trying to print the value.

**Nothing has to be deployed on the day you fill a pool**, and that took a fix rather than being free.
A YouTube gate verdict is cached for 30 days, so every age-gated video anyone viewed before you filled
the secret had a record saying "gated" — written by a build that could send a jar but had none to send.
Those records now carry whether the extract that produced them was logged in, and a gated one that was
not is refused as soon as a pool exists, so the next view re-extracts it with the jar. You do not have
to wait out the TTL, ask for a cache flush, or time your `wrangler secret put` against a merge.

The one case that is still a manual invalidation: **rotating a pool that has gone dead.** A record that
was measured *with* a jar and still says gated is believed, because that is what it is — logged in and
still walled. Swapping in working accounts does not make it look stale, so bump `RESOLVER_GENERATION`.

---

## When something is wrong

**A malformed secret is silently an empty pool.** `parseAccounts` never throws, deliberately: these
are read on the path for ordinary posts too, and a stray comma must not take down a whole platform
over a credential typo. The cost of that choice is that a bad paste looks identical to an unset
secret. If filling a pool changes nothing, suspect the JSON first:

```sh
jq . accounts.json    # if this errors, so did the Worker, just quietly
```

**An entry with no credential is dropped.** `{"label":"alt1"}` on its own is not an account. A pool of
two where one entry is malformed is a pool of one, and it will work — just at twice the load on the
survivor.

**yt-dlp rejects a jar with no Netscape header**, so the container prepends
`# Netscape HTTP Cookie File` if your export lacks it. You do not need to add it yourself.

---

## Rotating

Replace the whole array and push again; there is no partial update. Then bump `RESOLVER_GENERATION`,
for the reason in "Pushing it" above — a gated verdict that a jar already measured is believed until
the generation changes.

`label` is for **you**, not for the code: it is the only field here safe to write down, so it is how
you keep track of which throwaway is which between exports. Nothing reads it at runtime and no counter
carries it, so it will not tell you which account died — the pool is not per-account observable, and
adding that would mean putting an account identifier somewhere a log could reach. What you get instead
is `pool_unused`, which says the jar was spent and the wall held without saying by whom. Everything
else in the pool is never written to a log line, an analytics blob, a cache key, an error body, or a
card.
