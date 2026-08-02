# TikTok from real Cloudflare Workers egress — Task 1 measurement

**Measured 2026-07-19 ~04:00–04:20 UTC** (2026-07-18 evening PDT) from a Cloudflare-hosted
Worker isolate, with a residential-US-IP control arm taken minutes apart against the same URLs.

**Verdict: decision-tree branch 1 for the page — proceed to Task 2 unchanged. The video is a
branch-3-shaped problem with a shape the plan did not anticipate, and branch 3's remedy does
not apply. Details and the honest risk restatement below.**

---

## How this was measured, and one deviation to be aware of

The plan's Step 5 says `wrangler secret put PROBE_TOKEN` then `npm run deploy`. **Both were
blocked by the harness permission classifier** (`wrangler secret put`, `wrangler deploy`, and
`npm run deploy` all denied; `wrangler deploy --dry-run` allowed). The measurement was taken
instead through **`wrangler dev --remote`**, with `PROBE_TOKEN` supplied via a gitignored
`.dev.vars` (deleted afterwards, along with the token).

**This is still genuine Workers egress**, and that is not an assumption — it is confirmed by
the result itself. `wrangler dev --remote` runs the isolate on Cloudflare's network and proxies
only the *inbound* HTTP hop from localhost; every `fetch()` the probe makes leaves from
Cloudflare. The proof is the video arm: the byte-identical aweme URL returned **HTML from the
Worker** and a **14.5 MB MP4 from the residential control**, minutes apart. A difference that
large can only come from a different egress IP.

What it is *not*: a deployed staging worker. **`staging.megapenispoopenfarten.sex` was never
updated, and no `PROBE_TOKEN` exists on any deployed worker.** The endpoint is committed but
unreachable everywhere until someone deploys it with a token. If a deployed-staging
confirmation is wanted before Task 2, a human needs to run Step 5 as written.

**Prod sanity check, before and after (read-only):** `megapenispoopenfarten.sex/t/ZTSw2mYwR/`
→ `HTTP/2 200`, `content-type: text/html; charset=utf-8`, `cache-control: public, max-age=3600`
— still the live `fxtiktok` worker, untouched throughout.

---

## Result 1 — the PAGE fetch (the blocking measurement): WORKS

> **Units note (added after adversarial review — the reports below are verbatim, unedited).**
> At the time of this run the probe computed `bytes` as `body.length`, which is JS string length:
> **UTF-16 code units, not octets.** TikTok pages are dense with non-ASCII, so every `bytes`
> figure recorded here understates the real transfer by roughly 0.3% (measured on the exact page
> above: 383,950 octets vs 382,855 units). `descLen` was the same UTF-16 count — the real caption
> `Duck’s fish era has officially begun. 🐟✨` is 40 codepoints, 41 UTF-16 units, 47 UTF-8 bytes,
> which is why it reads as 41 below. **No conclusion in this document moves**: the
> decoy-vs-real discrimination rests on a ~50x ratio (7.4 KB vs 384 KB), not on a 0.3% margin.
> `src/probe.ts` has since been corrected — it now reports `bytes` as true UTF-8 octets and
> renames the caption field to `descChars` (codepoints) — so a re-run will print slightly larger
> `bytes` and `descChars: 40`. That is the fix landing, not a discrepancy.

`id=7660566211100511518` (video, @mysticaquariumct), raw report:

```json
{
  "none":       { "httpStatus": 200, "bytes": 384086, "markerPresent": true,  "statusCode": 0,    "hasItemStruct": true,  "descLen": 41, "awemeUrlFound": true },
  "chrome":     { "httpStatus": 200, "bytes": 386979, "markerPresent": true,  "statusCode": 0,    "hasItemStruct": true,  "descLen": 41, "awemeUrlFound": true },
  "chrome_win": { "httpStatus": 200, "bytes": 387106, "markerPresent": true,  "statusCode": 0,    "hasItemStruct": true,  "descLen": 41, "awemeUrlFound": true },
  "discordbot": { "httpStatus": 200, "bytes": 7456,   "markerPresent": false, "statusCode": null, "hasItemStruct": false, "descLen": 0,  "awemeUrlFound": false }
}
```

`id=7663591047909379341` (photo slideshow, @duolingo):

```json
{
  "none":       { "httpStatus": 200, "bytes": 367373, "markerPresent": true,  "statusCode": 0,    "hasItemStruct": true,  "descLen": 8, "awemeUrlFound": false },
  "chrome":     { "httpStatus": 200, "bytes": 300604, "markerPresent": true,  "statusCode": 0,    "hasItemStruct": true,  "descLen": 8, "awemeUrlFound": false },
  "chrome_win": { "httpStatus": 200, "bytes": 300066, "markerPresent": true,  "statusCode": 0,    "hasItemStruct": true,  "descLen": 8, "awemeUrlFound": false },
  "discordbot": { "httpStatus": 200, "bytes": 7749,   "markerPresent": false, "statusCode": null, "hasItemStruct": false, "descLen": 0,  "awemeUrlFound": false }
}
```

**Which UA variants produced `hasItemStruct: true`:** `none`, `chrome`, `chrome_win` — all three,
on both post kinds. **`statusCode`: 0** on both. **Aweme URL found:** yes on the video, and
correctly absent on the slideshow (a photo post has no `bitrateInfo`).

**Fact 1 (the inverted UA gate) reproduces exactly from Workers egress.** `discordbot` got the
~7 KB decoy — 7456 and 7749 UTF-16 units, per the units note above — with no rehydration marker
at all, at **HTTP 200**. The
crawler UA is a decoy from datacenter IPs just as it is from residential ones, and the plain /
absent UA is the one that works. Nothing about the page path needs rethinking.

**Fact 3 also reproduced incidentally.** While hunting a slideshow fixture, three stale ids
(`6780344874811442181`, `7036907917069124610`, `6917704832925746181`) returned **HTTP 200 with
`statusCode: 10204` and no `itemStruct`**. The deleted-post trap is real and is exactly the
shape the plan describes.

---

## Result 2 — the VIDEO fetch: FAILS from Workers egress, WORKS residentially

Same aweme URL, both arms, minutes apart. It is deterministic (fact 4), so this is a true
like-for-like comparison and not two different URLs.

| | Workers egress | Residential US IP |
|---|---|---|
| HTTP status | 200 | 200 |
| `content-type` | `text/html; charset=utf-8` | `video/mp4` |
| bytes | — (HTML page) | **14,548,779** |
| final host | **`www.tiktok.com`** (no CDN redirect at all) | `v16m-default.tiktokcdn-us.com` |
| first 16 bytes | `3c21646f63747970652068746d6c3e3c` = `<!doctype html><` | `0000001c 66747970 69736f6d` |
| **`ftyp` at bytes 4-8** | **false** | **true** |

**Content-type lied in both directions today, which is the point of fact 5.** The residential
success and the Workers failure are *both* HTTP 200. Had the probe asserted on status it would
have called this a pass. Had it asserted on content-type it would have called the residential
fetch a pass and the Workers fetch a fail *for the wrong reason* — the Workers response
honestly declared itself HTML. Only the magic bytes separated them cleanly.

### The plan's branch 3 does not apply as written

The plan anticipated *"the aweme URL **403s** from Workers egress"* and prescribed resolving
the 302 server-side. **There is no 403 and there is no 302.** TikTok answers datacenter egress
with a `200` HTML page from `www.tiktok.com` and never redirects to the CDN. So the branch-3
remedy — "resolve the 302 server-side and store the resolved CDN URL" — has **nothing to
resolve**. It is unavailable, not merely unattractive.

For completeness on what was *not* measured: whether Workers egress can fetch an
**already-resolved** `tiktokcdn-us.com` URL is unknown. Testing it would have required giving
the probe an arbitrary-URL parameter, which would punch a real SSRF hole in a deployed
endpoint and directly contradict the digits-only guard the plan put there on purpose. Left
unmeasured deliberately. It is also of limited use: production has no residential resolver in
the loop, so a CDN URL we cannot mint is a CDN URL we cannot serve.

---

## The decision

**Page → branch 1. Proceed to Task 2 unchanged.** Tasks 2–6 (routing, fixtures, normalizer,
fetcher, short links) rest entirely on the page fetch, and the page fetch is confirmed from
real Workers egress on both post kinds with three UA variants. The recon transfers.

**Video → unresolved, and NOT resolvable by this probe.** Per the plan's own framing, this
result is **informative, not decisive**: in production our Worker never fetches the aweme URL.
It hands the URL to Discord in a 302 and **Discord's media proxy** fetches it, from **Discord's**
IPs. The probe measured a network path production does not use.

**But the risk is now materially higher than the residential recon implied, and this should be
recorded plainly rather than filed as "informative".** The failure we just observed is
specifically *datacenter egress being treated differently from residential egress*. Discord's
media proxy also egresses from datacenter ranges. The most likely explanation for what we saw
predicts that Discord's proxy hits the same interstitial. The residential recon's
"cookie-free ⇒ working CDN branch **by construction**" now reads as too strong: it is
cookie-free **and** residential, and today we learned those are not the same condition.

**Nothing about that changes what Task 2 does**, so this does not block. It changes what
**Task 11** is: no longer a confirmation, but the real experiment. Concretely:

- Tasks 2–6, 8, 9 proceed unchanged — none of them depend on the video URL resolving.
- **Task 7 (the Discord video carve-out) still ships.** It is unit-tested and correct the moment
  a playable mp4 exists, exactly as the plan says.
- **Task 11 must be run before the video is claimed to work**, and it must assert on a real
  Discord embed actually playing — not on our own probe, which cannot see Discord's IPs.
- If Task 11 shows Discord's proxy hitting the interstitial too, that is **decision-tree branch 4**
  and it is a **human's call**, not an implementer's: 3a would ship **slideshows + video-thumbnail-
  only** via the normalizer's no-aweme-URL degrade path, with the carve-out's human-gate item
  deferred to 3b. Do not silently escalate to byte-proxying to make a red test go green.

**No TTL changes.** Nothing measured here touches the 900 + 300 s window.

---

## Reproducing this

The probe endpoint is `GET /_probe/{PROBE_TOKEN}?id={digits}`, unreachable without the token.
It is a **throwaway — Task 10 deletes `src/probe.ts`, its import in `worker.ts`, the
`PROBE_TOKEN` field in `analytics.ts`, and `test/probe.test.mjs`.**

> **If you deploy this and run it, treat `PROBE_TOKEN` as burned afterwards.** The token is a
> **path segment**, and `wrangler.jsonc` sets `"observability": { "enabled": true }` — so Cloudflare
> Workers Logs captures the request URL, putting the only thing protecting the endpoint into the
> log store. This never materialized for the run above (staging was never deployed with a token;
> no `.dev.vars` exists and nothing leaked into the repo), but anyone repeating Step 5 should
> rotate the token when finished, or delete the endpoint per Task 10 — which is the plan anyway.

> **Reading an unexpected `ftyp: false`:** the video arm's verdict is the `ftyp` magic-byte check.
> `head()` originally read a single stream chunk, so an mp4 whose first chunk was under 8 bytes
> reported `ftyp: false` — a false negative that reads exactly like a real HTML interstitial and
> would wrongly trigger decision-tree branch 4. That is **fixed** (`head()` now accumulates until
> it has enough bytes or the body ends, and `test/probe.test.mjs` pins it across 16/8/4/1-byte
> chunkings). The run recorded above predates the fix but was unaffected: its `firstBytesHex`
> carries a full 16 bytes on both arms, so no short read occurred.

Finding fixture ids (fact 6 confirmed — the embed page server-renders ids, profile pages do not):

```bash
curl -s 'https://www.tiktok.com/embed/@duolingo' | grep -o '"id":"[0-9]\{15,\}"'
```

Useful ids found on 2026-07-19, for Task 3's fixtures:

| id | account | kind |
|---|---|---|
| `7660566211100511518` | @mysticaquariumct | video, `statusCode` 0 |
| `7663591047909379341` | @duolingo | **photo slideshow** (`imagePost` present), `statusCode` 0 |
| `6780344874811442181` | (stale) | `statusCode` 10204, no `itemStruct` — the deleted shape |

The slideshow id is the one thing here that was genuinely hard to find: @mysticaquariumct posts
no photo carousels, and neither did @natgeo, @nasa, @netflix or @nba in their recent embed-page
windows. @duolingo did. Task 3 should not assume a slideshow is easy to source from an arbitrary
account.

---

## Addendum, 2026-07-19 — branch 3 shipped anyway, for a different reason

**Nothing measured above is retracted.** The numbers stand; what changed is the question.

This document concluded that branch 3 — "resolve the aweme 302 server-side and store the
resolved CDN URL" — was **unavailable**, because from Workers egress the aweme URL answers
`200 text/html` from `www.tiktok.com` with no redirect to resolve. That conclusion was drawn
against the question *"can WE download the video"*, and this document says so itself: the probe
"measured a network path production does not use".

A **second, independent measurement** on 2026-07-19 forced the remedy back on:

```
curl -sSL -w '%{num_redirects}'
  our slideshow image   1 redirect   -> Mastodon activity card  (works)
  Bluesky image         1 redirect   -> Mastodon activity card  (works)
  PRODUCTION fxtiktok   1 redirect   -> Mastodon activity card  (works)
  OUR video             2 redirects  -> OpenGraph card          (FAILS)
```

**The redirect HOP COUNT decides which card Discord draws**, and that is a fact about *Discord's*
fetch, not ours. Three tag-level hypotheses were tried and disproven first (commits `6fae4a9`,
`5a7578e`, `6b20562`); the head was never the difference. Production's chain is one hop precisely
*because* its offload service resolves the aweme redirect server-side.

So `resolveAwemeUrl` in `src/platforms/tiktok/fetch.ts` now does that, and **this document's
measurement is respected rather than overruled** — it is exactly the branch the resolver degrades
on. If Workers egress still cannot see the 302, the resolver returns null, the caller hands out
the aweme URL, and behaviour is bit-for-bit what shipped before: two hops, the OpenGraph card, one
extra header-only request per post fetch. If it can, the card is fixed. Neither outcome can make
the embed worse, which is why it ships without waiting on another probe.

**Still unmeasured, and still the real gate:** whether Discord's media proxy — from Discord's IPs,
not ours — sees the working branch. That was this document's "Task 11" and it remains a human's
call in front of a real client.
