# Instagram from Cloudflare Workers egress — what was measured, and what was not

**Written 2026-07-20, after the fact.** This document exists because three places in the plan
(lines 217, 229, 648) and one comment block in `src/platforms/instagram/fetch.ts` cited it as a
phase deliverable, and it had never been written. A dangling citation in a source comment is worse
than no citation: it reads as a live pointer, and the block that carried it is the documented
escalation path for a production-only Instagram failure.

**It is deliberately not a reconstruction.** Task 1 deployed a probe to staging and Task 8 deleted
it (commit `0a32bbc`) without recording its output. That output is gone. What follows separates
what the repo can still evidence from what it cannot, because the failure mode this phase is most
exposed to — believing a residential measurement transfers to Cloudflare egress — is made worse,
not better, by a confident-sounding document.

---

## Verdict

**The one row this platform depends on is confirmed from Workers egress. The rest of the table is
unmeasured and should not be cited as if it were.**

---

## Confirmed: the crawler UA gets the real payload from Workers egress

Not asserted from the probe — asserted from the deployed pipeline, end to end.

```
$ curl -sS -A 'Discordbot/2.0' https://staging.megapenispoopenfarten.sex/reel/Da5ynsiuAZ_
og:title" content="nasajpl (@nasajpl)
og:video" content="https://staging.megapenispoopenfarten.sex/_media/ig%3Ap%3ADa5ynsiuAZ_/0
raw CDN hosts in the document: 0
```

```
$ LOC=$(curl -sS -o /dev/null -D - "$S/_media/ig%3Ap%3ADa5ynsiuAZ_/0" | awk '/^location:/{print $2}')
scontent-bos5-1.cdninstagram.com
$ curl -sL -r 0-1023 "$LOC" | xxd -l 12
00000000: 0000 0020 6674 7970 6973 6f6d            ... ftypisom
```

**Why this is a Workers-egress result and not a restatement of the residential one.** Our Worker
never proxies media bytes; `/_media/` reads the Post cache and 302s. So a CDN URL can only be in
that cache if `fetchInstagram` parsed a real embed payload, and that fetch left from Cloudflare.
A decoy response carries no payload at all (it is a contentless shell — see
`test/fixtures/instagram-decoy.html`), so this path cannot be reached by a decoy being mistaken
for content. The author name `nasajpl` and the `ftypisom` magic bytes are content assertions, not
status or content-type assertions, per the project's standing rule.

## Confirmed: the CDN signature outlives our cache by two orders of magnitude

The `oe` query parameter on the returned CDN URL is a hex Unix expiry. Measured live 2026-07-20:

```
oe hex:           6A5FB14A
expiresAt:        1784656202  ->  2026-07-21 17:50:02 UTC
measured at:      1784527193  ->  2026-07-20 06:00 UTC
secondsRemaining: 129009      (~35.8 h)
```

An independent sample taken ~25 minutes earlier during code review read `6A5F790A`, ~32.1 h
remaining — a different signature from a later re-mint, consistent band.

**Why it matters, and it is the number Task 9 escalates to.** `POST_TTL` is 900 s and
`MEDIA_MAX_AGE` is 300 s (`src/cache.ts`), so a handed-out URL can be at most ~20 minutes old when
Discord's media proxy resolves it, against a signature good for ~32–36 hours. If the human gate
reports that video does not play, **signature expiry is not the cause** and `POST_TTL` is not the
knob — the margin is roughly 100×. Look at Discord's egress instead, which no test here reaches.

---

## NOT measured: the rest of the four-UA table, from Workers

`src/platforms/instagram/fetch.ts` documents an inverted UA gate:

| UA | result |
| --- | --- |
| `facebookexternalhit/1.1` | real, server-rendered payload |
| `Discordbot/2.0` | real, server-rendered payload |
| `curl/8.4.0` | real, server-rendered payload |
| `Chrome/122` | ~598 KB empty shell, no payload, HTTP 200 — **decoy** |

**Every row of that table was measured from a RESIDENTIAL IP on 2026-07-19**, and the fixtures in
`test/fixtures/` are the captured bytes for two of them. Only the `Discordbot/2.0` row has since
been confirmed from Workers egress, by the section above. The plan's fact 11 states that
Instagram's behaviour toward Cloudflare is **path-dependent**, so the other three rows do not
transfer for free — in particular, *nothing here establishes that Chrome-from-Workers gets the
decoy rather than something else*. We simply never look: the fetcher pins the crawler UA.

This is a documentation gap, not a shipping risk, because the pinned UA is the confirmed row.

### If you do need the full table

The probe is gone and its reintroduction now fails the suite (three tests in
`test/pipeline.test.mjs`, including under a different filename — the name-scoped version of that
enforcer was shown by review to be bypassable by renaming the file). Re-adding one is a deliberate,
temporary act, not an accident. Two traps, both paid for once already:

1. **Do not point it at a single-image post.** The old probe asserted on `shortcode_media`, a
   marker Task 3 disproved, and a single image carries none — so against a single image it reported
   a false *"blocked from Workers egress"*, the most damaging wrong answer available here. Probe a
   **reel** or a **carousel**.
2. **Assert on content, never on status.** A nonexistent shortcode returns HTTP 200. So does the
   decoy. So does the 80,319-byte "post unavailable" page.

---

## Correction to the plan's edge-cache model — measured 2026-07-20

The plan's *THE EDGE-CACHE HAZARD* section says the edge key is **the path alone**, and offers as a
workaround: *"the same shortcode under a different path spelling (`/p/X` vs `/reel/X` vs
`/instagram/p/X` are three distinct edge keys)."*

**That workaround does not exist, and the mechanism is ours, not Cloudflare's.** Measured against
staging, three spellings of one post return one entry whose `age` climbs in lockstep:

```
/p/Da5ynsiuAZ_     HIT age=125 → 130 → 135
/reel/Da5ynsiuAZ_  HIT age=125 → 130 → 136
/tv/Da5ynsiuAZ_    HIT age=125 → 130 → 136     (identical last-modified throughout)
```

Three independent entries could not share one monotonic age counter. The cause is not a zone rule:
`respCacheKey(ref, client)` is `resp:{refKey(ref)}:{client}` (`src/cache.ts`), and `refKey`
collapses `/p/`, `/reel/`, `/reels/` and `/tv/` onto one ref **by design** — that is Task 2's
stated goal, locked by *"EVERY SPELLING OF ONE POST COLLAPSES TO THE SAME CACHE KEY"* in
`test/router.test.mjs`. The review that found the shared entry read it as a Cloudflare cache rule;
it is our own two-layer cache working correctly.

Two consequences, in opposite directions:

- **Against the workaround:** re-fetching a burned shortcode under another spelling buys nothing.
  Neither does a query string. A fresh **shortcode** is the only reset.
- **In mitigation:** the entry is bounded by `RESP_TTL = 900 s`, not by the zone's four hours. A
  burned shortcode is reusable after ~15 minutes, not ~4. This does not license reuse inside the
  window; it does mean a phase is never blocked for four hours by one curl.

**The 900 s bound was observed directly, not inferred from the constant.** Polling one URL across
the boundary:

```
06:06:08  cf-cache-status: HIT  age: 895  cache-control: max-age=14400  last-modified: 05:51:13
06:06:28  (no cf-cache-status)            cache-control: public, max-age=0, must-revalidate
06:06:49  cf-cache-status: HIT  age:  20  cache-control: max-age=14400  last-modified: 06:06:29
06:07:09  cf-cache-status: HIT  age:  40                               last-modified: 06:06:29
```

The middle row is the whole result: at ~915 s the entry was gone and the request reached the
origin, which answered with **its own** `public, max-age=0, must-revalidate` and no cache status.
A new entry was then minted at 06:06:29 and its age restarted from zero.

**So `cache-control: max-age=14400` on a hit is cosmetic** — a zone Browser-Cache-TTL rewrite
applied on the way out to the client. It is *not* the edge lifetime, and reading it as one is what
produced the "burned for four hours" conclusion. The measured edge lifetime is our `RESP_TTL`.
This is a case where the header lies and only the behaviour is evidence, which is the same rule
this project already applies to status codes and content types.

A failure render is never `cache.put` at all (`src/worker.ts`), which is why a nonexistent
shortcode stays uncached no matter how many times it is fetched — verified over five consecutive
requests. Nonexistent codes are therefore free to use for cache-key experiments, which is how the
measurements above were taken without spending shortcode budget.
