# Twitter extraction — the mechanism, measured from residential AND Cloudflare Workers egress

**Measured live 2026-07-19, from BOTH residential AND real Cloudflare Workers egress; results byte-identical.**
FxEmbed source read at HEAD `9f57d264` (dated 2026-07-18 — current). This document distils the load-bearing
facts out of the transient recon (`/tmp/twitter-recon.txt`) so the tree carries them and nobody re-derives
them. The fetcher headers in `src/platforms/twitter/fetch.ts` cite THIS file, not `/tmp`.

Naming note, load-bearing: this project calls the platform **Twitter** in all prose, but the platform **code
stays `'x'`** — `{p:'x'}`, `refKey` `x:{id}`, `x.com` URLs, `THEME.x`/`APPLICATION.x` keys. Those are
identifiers, not names. Directories/functions use the full name (`src/platforms/twitter/`, `fetchTwitter`).

---

## Why there was NO Workers-egress probe this phase (a decision, not an omission)

Instagram and TikTok each opened with a blocking Workers-egress probe because every fact they rested on came
from a residential IP and the platform was known to treat Cloudflare differently (IG's 599 KB decoy; TikTok's
aweme 404). **Twitter has no such gap.** The recon measured **both** fetch paths from real Cloudflare Workers
egress and got results byte-identical to residential. The scratch measurement Worker (`xprobe-scratch`) and its
KV namespace were deleted afterward; the user's Cloudflare Access configuration was never touched. There was
therefore nothing for a `/_probe/` endpoint to settle that the recon had not already settled from the same
network our Worker runs on — standing one up would have been pure risk (a caller-supplied-id fetch on a public
origin) for zero information.

The one thing the recon could NOT measure is what only a real Discord client can: does Discord's media proxy
(its IPs, not ours) play the `video.twimg.com` mp4, and does the `THEME.x` accent colour look right. That is
the human gate (Task 9), not this document.

---

## Verdict

- **Ordinary (non-age-gated) posts: VIABLE, credential-free, today**, via TWO independent uncredentialed paths,
  both confirmed from Workers egress. Media is 0-hop, unsigned, cookie-free.
- **Age-gated posts: BLOCKED credential-free** — confirmed by live measurement on both paths and both egresses.
  Build the credential seam, ship it EMPTY; an age-gated tweet becomes an honest `age_restricted` failure.

---

## Path A — syndication is PRIMARY. One GET, no credentials.

```
https://cdn.syndication.twimg.com/tweet-result?id={ID}&lang=en&token={TOKEN}
```

`token` is **derived client-side, not issued**:

```js
token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
```

- **The float imprecision is INTENDED.** `Number(id)` loses precision on a 19-digit id, but Twitter's own web
  client computes the token with the identical IEEE-754 JS math, so our token matches theirs exactly. Do NOT
  "fix" this to BigInt — a "more correct" token is the *wrong* token. Verified: `id=20 → token=6dq1a2xwd93`
  returns jack's "just setting up my twttr".
- Returns full text, author, photos as `pbs.twimg.com/media` URLs, and video as **unsigned** mp4 variants
  (multiple resolutions) plus an HLS `m3u8` we ignore.
- No `x-rate-limit-*` headers; `cache-control: must-revalidate, max-age=60`, Fastly-fronted (`x-served-by:
  cache-iad-…`), cheap. 15 rapid sequential calls: 15/15 × HTTP 200. This is the primary path **because** it is
  the cheapest and needs no token dance, no bearer, no cookie.
- A related endpoint does NOT work: `syndication.twitter.com/srv/timeline-profile/screen-name/{name}` returned
  **HTTP 429** on the very first residential request. Profile timelines are not available this way.

## Path B — guest GraphQL is the FALLBACK.

```
POST https://api.x.com/1.1/guest/activate.json   -> {"guest_token": "..."}
GET  https://api.x.com/graphql/{qid}/TweetResultByRestId?variables=...&features=...&fieldToggles=...
```

with the **public web bearer** (hardcoded, a public constant — NOT a secret — FxEmbed `src/constants.ts:60`),
plus `x-guest-token`, a random `x-csrf-token`, `x-twitter-active-user: yes`, and
`Cookie: guest_id=v1%3A{gt}; ct0={csrf}` (FxEmbed `packages/atmosphere/src/providers/twitter/fetch.ts` ~126-135).

- The guest token is **free and reusable** — `x-rate-limit-remaining: 499` per freshly minted token, a ~500-request
  budget. Reuse it through the **runtime fetch cache**, the FxEmbed form: `cf: { cacheEverything: true, cacheTtl }`
  on the `activate.json` fetch Request, so workerd serves the cached activation until the TTL lapses (spec
  §Credentials sets that TTL to 2 hours). Assert the activation on the presence of the `guest_token` STRING field,
  never on `res.ok` — a 200 carrying no token is still a failure.
- **`qid` is `TweetResultByRestId`'s query id** (recon observed `f2sagi1jweVHFkTUIHzmMQ`). qids and the
  `features`/`fieldToggles` sets DRIFT — Twitter rotates them. This is the single most fragile thing in the phase,
  which is exactly why it is the **fallback**, not the primary.
- **GOTCHA 1 — `TweetWithVisibilityResults`.** Some posts return `result.__typename ===
  "TweetWithVisibilityResults"`, where the payload is at `result.tweet.legacy`, **NOT** `result.legacy`. Hit live
  on `1884695849596576004`: naive `result.legacy` yielded empty text; unwrap both.
- **GOTCHA 2 — single-status only.** `TweetResultByRestId` is the **only** query in FxEmbed's catalog with
  `requiresAccount: false`. Every other (`TweetDetail`, `UserTweets`, `UserByScreenName`, `SearchTimeline`,
  `ConversationTimeline`, …) is `requiresAccount: true`. Threads, profiles, and search require an account.
  Single-status fetch is exactly this project's surface.

## Age gate — CONFIRMED, ship the seam EMPTY

An age-gated post returns **`__typename: "TweetTombstone"`** with no text, no media, no author, no counts — on
**both** paths and **both** egresses:

```
[SYN 1763230707432751435] 200 {"__typename":"TweetTombstone","tombstone":{}}
[GQL 1763230707432751435] 200 {"data":{"tweetResult":{"result":{"__typename":"TweetTombstone"}}}}
```

Same for `1990531719930524084` and `1940161393384464703`. **Proof the wall is credential-surmountable, not IP-based:**
the same IDs through *credentialed* FxEmbed return full text and media. Uncredentialed = tombstone; credentialed =
full content.

- **Detect the gate on `__typename === 'TweetTombstone'`, on both paths.** The recon CORRECTS the spec here: the
  current shape is `TweetTombstone`, **NOT** `TweetUnavailable`/`NsfwLoggedOut`, and it carries **no `reason` field
  and no `errors` array**. FxEmbed's escalation branch (`fetch.ts:252`) keys on `result.reason === 'NsfwLoggedOut'`,
  which would **not** fire on this shape — keying on `reason` would silently miss every gated post the recon measured.
- A tombstone is **NOT a `sensitive` post**: it carries no text to render, so it never becomes a `Post`. It is an
  `Outcome.failure` routed to `age_restricted`. Do not confuse it with `possibly_sensitive` (an ordinary, fetchable,
  sensitive post that we DO render with the `[sensitive]` marker).
- **Seam design reference:** FxEmbed `src/providers/twitter/proxy/credentials.ts` — real logged-in accounts,
  AES-256-GCM-encrypted into the bundle at build time, decrypted via `crypto.subtle` with a `CREDENTIAL_KEY`,
  `getRandomTwitterAccount()` per request, triggered only on the gate. Phase-now ships the seam EMPTY: a named
  function that returns `null` because there are no accounts. This is a tested boundary, not a TODO.

---

## The THREE traps — status and content-type discriminate NONE of them

Assert on the presence of real post fields (`__typename === 'Tweet'`, non-empty text, a `user`), never on status
or `content-type`. Twitter makes both lie, in three distinct ways on the syndication endpoint alone:

| Trap | Wire | Meaning |
|---|---|---|
| Missing/wrong token | **200** + body `{}` | the derived token is missing/wrong → `assert_fail` |
| Age gate | **200** + `TweetTombstone` | credential wall → `age_restricted` |
| No such post | **404** + an HTML "Nothing to see here" poodle page | the id names no post (404 status from a JSON endpoint, serving HTML) |

`200 + TweetTombstone` = gated; `404 + HTML` = missing. Both are content-assert traps; neither is safe to branch
on by status or content-type.

---

## Media — the best of any platform here: 0 hops, unsigned, no `POST_TTL` constraint

Measured cookie-free, `redirect: 'manual'`, magic-byte-asserted, from both egresses:

| Asset | Hops | Bytes | Magic | Verdict |
|---|---|---|---|---|
| video mp4 720p (2022) | **0** | 17,929,563 | `00 00 00 18 66 74 79 70` (`ftypisom`) | real MP4 |
| photo `?name=orig` | **0** | 1,131,387 | `ff d8 ff e0 … JFIF` (1920×1080) | real JPEG |
| video mp4 720p (**Jul 2026**) | **0** | 15,537,449 | `ftypisom` | real MP4 |

- **Zero redirects.** Our `/_media/` 302 → CDN is therefore the ONLY hop Discord's proxy sees — comfortably
  inside the one-hop budget whose violation broke TikTok video. **There is no `withResolvedVideo` analogue and
  there must not be one:** TikTok needed one because its playable URL is itself a 302; Twitter's is not.
- **No signing, no expiry, no IP binding.** The only query param is `?tag=14`, and the recent (Jul 2026) video
  fetched **identically with `tag` stripped entirely** (same 15,537,449 bytes, HTTP 200). Twitter puts NO
  constraint on `POST_TTL` — do not lower it, and do not add an `oe=` expiry check (that was Instagram's concern;
  Twitter has no signature).
- **Media selection:** from `video_info.variants`, filter to `content_type === 'video/mp4'` FIRST, then pick the
  max `bitrate` among those (default to the sole mp4 when there is only one). Ignore `application/x-mpegURL` (the
  HLS `m3u8` — Discord cannot play it). Do NOT gate on a truthy `bitrate`: a Twitter `animated_gif` mp4 frequently
  carries `bitrate: 0` or omits it, and a truthy-bitrate filter discards the only playable url, leaving a dead player.
- **The animated-GIF trap:** `type: "animated_gif"` maps to **`{kind:'video', …}`, NOT `kind:'gif'`.** A Twitter
  "GIF" is delivered as an **mp4 with no audio**, not a `.gif` file. `Media.kind` `'gif'` maps to a Mastodon `image`
  attachment; an mp4 URL in an image attachment is the exact 2026-07-19 poster defect (Discord requests a still,
  receives mp4 bytes, drops the rich card). `preview_url`/poster is MANDATORY on a video/gif attachment and must be
  the still (`media_url_https`), NEVER the mp4.

## Crawler-UA fetch — text only, media unusable. Build NOTHING on it.

`x.com/{user}/status/{id}` is UA-gated and the gate is narrow: `Discordbot/2.0` and `TelegramBot` get 200 with a
full `og:description`; **Googlebot and facebookexternalhit/1.1 get 404.** For allowed UAs `og:description` carries
the complete text, but `og:title` is the generic `"NASA (@NASA) on X"`, and `og:image` is an unusable indirection
stub (`jf.x.com/images/media-preview/{id}`). The HTML contains **no** `pbs.twimg.com/media` and **no** `video.twimg`
reference at all. Both API paths dominate it. Usable as a last-ditch text-only degrade; build nothing on it.

---

## FxEmbed file:line references (the citation for the seam)

- `src/constants.ts:60` — the hardcoded public web bearer (`GUEST_BEARER_TOKEN`), a public constant.
- `packages/atmosphere/src/providers/twitter/fetch.ts:48` — `Authorization: env.guestBearerToken`.
- `packages/atmosphere/src/providers/twitter/fetch.ts` ~126-135 — the per-attempt guest headers/cookie assembly.
- `packages/atmosphere/src/providers/twitter/fetch.ts:180` — `'CREDENTIAL_KEY set but no bundled accounts; using
  guest API'` — proves guest is a real fallback, not vestigial.
- `packages/atmosphere/src/providers/twitter/fetch.ts:248-256` — the credential escalation ("elongator"); keys on
  `reason === 'NsfwLoggedOut'` (which the current `TweetTombstone` shape does NOT carry — see the age-gate note).
- `src/providers/twitter/proxy/credentials.ts` — the encrypted-account-bundle design to copy when the seam is filled.

---

## TRIAGE CHECKLIST — THREE independent whim-of-Twitter fragilities

These rotate **independently**. A future triager who checks only one will miss the others. Any one can break while
the other two still work — which is exactly why syndication (Path A) and guest (Path B) are a primary/fallback pair.

1. **The syndication token algorithm** — `((Number(id)/1e15)*Math.PI).toString(36).replace(/(0+|\.)/g,'')`. If
   Twitter changes it, **Path A `assert_fail`s (200 + `{}`)**. Fix: re-derive the formula from Twitter's current web
   client; do NOT "correct" the float math.
2. **The guest GraphQL `qid` + the `features`/`fieldToggles` set** — Twitter rotates these. A drift makes **Path B
   `400`/`404`**. Fix: refresh `qid`/`features`/`fieldToggles` from FxEmbed's source — it is a drift, not a redesign.
3. **The hardcoded public web bearer token** — if Twitter rotates the public bearer, **Path B's guest
   activation/GraphQL stops authorizing**. Fix: refresh `GUEST_BEARER_TOKEN` from FxEmbed `src/constants.ts`.

When both paths fail at once, suspect the age gate broadening (fact 3) — guest coverage shrinks and the empty
credential seam becomes load-bearing sooner — before suspecting all three fragilities rotated simultaneously.

## Residual risks

- Both paths are undocumented/unsanctioned; Twitter has broken them before and can again. Keep both, and keep the
  crawler-UA `og:description` as a degraded text-only third fallback.
- Rate limits under real Discord-scale load are unmeasured (500/guest-token on GraphQL, no limiting seen at 15 rapid
  syndication requests; not load-tested, deliberately, to avoid flagging the user's egress). Validate with a staged ramp.
- Age-gate scope may broaden. If Twitter starts gating more content, guest coverage shrinks and the empty credential
  seam becomes load-bearing sooner.
