# Can a Worker resolve the aweme URL to a CDN URL? — the header sweep

**Measured 2026-07-19 from `staging.megapenispoopenfarten.sex`** (a real deployed Cloudflare
Worker, not `wrangler dev --remote`), with a residential-US-IP control arm taken against the
**same URL, minutes apart and in one case seconds apart**.

## Verdict: NO. Not under any request shape.

**One-hop via server-side resolution is not achievable from Workers egress.** Twelve request
shapes — every header axis the question named, plus two beyond it — produced **one distinct
`Location` value between them**, and it is not a CDN:

```
https://www.tiktok.com/404?fromUrl=/aweme/v1/play/?faid=1988&file_id=<REDACTED>
  &is_play_url=1&item_id=7660566211100511518&line=0&ply_type=2
  &signaturev3=<REDACTED>&tk=tt_chain_token&video_id=v15044gf0000d97soa7og65p2qmqtldg
```

TikTok redirects datacenter egress to **its own 404 page**, carrying the original request as a
`fromUrl` query param. The header is not the variable. **The egress IP is**, and that is not
something a request shape can change.

`resolveAwemeUrl`'s existing degrade path — return null, keep handing Discord the aweme URL — is
therefore the permanent behaviour on this route, not a temporary one awaiting the right header.

---

## The measurement that settles it

Everything else here is supporting detail; this one control is the whole answer. A **single
aweme URL, minted residentially**, fetched from both egresses within seconds of each other:

| | Residential US IP | Workers egress (staging) |
|---|---|---|
| HTTP status | 302 | 302 |
| `Location` host | **`v16m-default.tiktokcdn-us.com`** | **`www.tiktok.com`** (a `/404` page) |
| following it | 1 redirect → HTTP 206, `ftyp` at 4-8 **true** | HTTP 200 `text/html`, `ftyp` **false** |

The URL is byte-identical across both arms, so **the URL is not the variable and neither is its
freshness**. This also answers a question the id-mode sweep structurally could not: the aweme URL
is **not** bound to the IP that minted it. A residentially-minted URL fails from Workers exactly
as a Workers-minted one does. **The IP that FETCHES is what is checked.**

That closes the last door. There is no "mint it somewhere friendlier and resolve it later"
architecture hiding behind this, because the resolution step itself is what gets refused.

---

## Raw per-variant results

Post id `7660566211100511518` (video, @mysticaquariumct). Page fetch: HTTP 200, marker present,
`statusCode: 0`, `itemStruct` present, aweme URL found, three cookies set (`ttwid`,
`tt_csrf_token`, `tt_chain_token`). Every row below is the SAME aweme URL from that page, with
`redirect: 'manual'`.

| # | variant | status | Location host | content-type | body octets | `ftyp` 4-8 |
|---|---|---|---|---|---|---|
| 1 | no headers at all | 302 | www.tiktok.com | text/html | 136 | false |
| 2 | Chrome UA | 302 | www.tiktok.com | text/html | 136 | false |
| 3 | Discordbot UA | 302 | www.tiktok.com | text/html | 136 | false |
| 4 | Chrome + `Referer: tiktok.com` | 302 | www.tiktok.com | text/html | 136 | false |
| 5 | Chrome + `tt_chain_token` cookie | 302 | www.tiktok.com | text/html | 136 | false |
| 6 | Chrome + `Accept: video/mp4,…` | 302 | www.tiktok.com | text/html | 136 | false |
| 7 | Chrome + `Range: bytes=0-1` | 302 | www.tiktok.com | text/html | 136 | false |
| 8 | Chrome + `Accept-Encoding: identity` | 302 | www.tiktok.com | text/html | 136 | false |
| 9 | HEAD instead of GET (Chrome) | 302 | www.tiktok.com | text/html | 0 (HEAD) | false |
| 10 | Chrome + `Sec-Fetch-Dest: video` etc. | 302 | www.tiktok.com | text/html | 136 | false |
| 11 | Chrome + **all three** cookies | 302 | www.tiktok.com | text/html | 136 | false |
| 12 | full browser impersonation † | 302 | www.tiktok.com | text/html | 136 | false |

† UA, `accept`, `accept-language`, `referer`, `origin`, `range: bytes=0-`, all three `sec-ch-ua*`,
all three `sec-fetch-*`, and the full cookie jar — simultaneously.

**Distinct `Location` values across all twelve: 1.** Not merely "all failed" — all failed
*identically*, byte for byte, including the `signaturev3` echo. The endpoint is not weighing these
headers at all on this code path.

First 16 bytes of the 136-byte body, every variant:
`3c68746d6c3e0d0a3c686561643e3c74` = `<html>\r\n<head><t` — a redirect stub, not video.

### Following each Location (no cookies, as Discord's proxy would)

All twelve targets: **HTTP 200, `text/html; charset=utf-8`, first bytes
`3c21646f63747970652068746d6c3e3c` (`<!doctype html><`), `ftyp` false.** Every redirect leads to
an HTML 404 page. **A redirect that leads to a 404 is worth nothing to us** — which is why the
"did it 302?" question had to be asked as "did it 302 *to a CDN that serves bytes*".

### The `bitrateInfo[].PlayAddr.UrlList[]` alternatives, cookie-free

Six non-aweme URLs from the same blob, all on `*-webapp-prime.tiktok.com`:

| host | status | content-type | body octets | `ftyp` |
|---|---|---|---|---|
| v16-webapp-prime.tiktok.com (×3) | 403 | text/html | 506 | false |
| v19-webapp-prime.tiktok.com (×3) | 403 | text/html; charset=utf-8 | 423 | false |

**None is directly fetchable.** This reproduces the recon's cookie gate from Workers egress:
`v16`/`v19-webapp-prime` are the gated branch and they 403 without the cookie. There is no
one-hop URL to hand out directly.

---

## What changed since the Task 1 probe, and what did not

The earlier probe recorded the aweme URL answering **HTTP 200 `text/html` with no redirect at
all**. Today it answers **302 to a 404 page**. So the *shape* of the refusal moved — a redirect
now exists where there was none — and anyone re-reading the old document should not trust its
"there is no 302" wording as current.

**The conclusion is unchanged and is now much better supported.** The old measurement was one
request shape and could not distinguish "wrong headers" from "wrong IP". This one sweeps twelve
shapes and adds a same-URL residential control, and it lands harder: the refusal is not
header-sensitive in any degree, and it survives a URL minted on a residential IP.

**One transient worth recording, because it would mislead a re-run.** The very first probe call
returned **HTTP 403 with no rehydration marker on the PAGE fetch** — the fetch that normally
works. Three immediate retries all returned 200 with the marker, `statusCode: 0` and an
`itemStruct`, as did every subsequent call. The page path is not broken; TikTok occasionally
throws a 403 at a Worker colo. **Do not read a single 403 as the page gate closing** — retry
before concluding anything, and note the page fetch is the arm this project actually depends on.

Also incidentally reconfirmed: the deleted-post trap (id `7660566180852435743` → HTTP 200,
`statusCode: 10204`, no `itemStruct`) and the photo-post case (id `7663591047909379341` → 200,
`itemStruct` present, **no** aweme URL, correctly — a slideshow has no `bitrateInfo`).

---

## What this decides

**The two-hop video chain cannot be collapsed by resolving server-side.** That option is closed,
and the architecture should stop treating it as pending work.

- `resolveAwemeUrl` returning null **is** the steady state on this route. It costs one upstream
  request per video post fetch and buys nothing. Whether to keep paying that for the chance
  TikTok's posture changes, or to delete it and reclaim the request, is a judgement call this
  measurement does not make — but it should be made knowingly, not left as an assumed-temporary
  degrade.
- **Nothing here says the video is broken.** Our Worker never fetches the aweme URL in
  production; Discord's media proxy does, from Discord's IPs. This measures our egress only. The
  standing caution from the Task 1 document still applies in both directions: Discord's proxy is
  also datacenter-egress, so the same treatment is plausible — and only a real Discord embed
  settles that.
- **The remaining route to one hop, if one is wanted, is to change what we hand out, not how we
  ask for it.** Every option in that direction (proxying bytes, an offload service like
  production fxtiktok's) is a different architecture with its own costs, and this document does
  not recommend one. It only rules out the cheap fix.

**No TTL changes.** Nothing measured here touches the 900 + 300 s window.

---

## Reproducing this

**The probe is deleted.** `src/probe.ts`, its mount in `worker.ts`, the `PROBE_TOKEN` field in
`analytics.ts`, and the staging secret are all gone; `test/pipeline.test.mjs`'s "THE PROBE IS
GONE" test fails if any of them returns. Rebuild it from this document's variant table if the
question is ever reopened — and if you do, note that its `q` mode (host and path hardcoded, only
the query string caller-supplied, so it cannot leave `www.tiktok.com/aweme/v1/play/`) is what made
the mint-IP-vs-fetch-IP control possible.

**Treat `PROBE_TOKEN` as burned after any run.** The token is a **path segment** and
`wrangler.jsonc` sets `"observability": { "enabled": true }`, so Workers Logs captures the request
URL — the only thing protecting the endpoint lands in the log store. The token used here was
deleted with `wrangler secret delete PROBE_TOKEN` immediately after the run.

`megapenispoopenfarten.sex` was never touched. All measurement was against
`staging.megapenispoopenfarten.sex`.
