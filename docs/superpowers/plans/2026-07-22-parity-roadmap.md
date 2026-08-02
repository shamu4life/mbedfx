# fxeverything — Parity & Long-Tail Roadmap (staging only)

A prioritized roadmap for closing the site-coverage gap between fxeverything and the two reference
Discord embed-fixer bots — **seriaati/embed-fixer** (~19 sites) and **Kyrela/FixTweetBot** (~24) — while
staying true to fxeverything's identity: a **native extractor** (a peer of fxtwitter / fxbsky / fxreddit),
never a router that swaps a user's link to someone else's fix-service.

This is a roadmap, not a single-platform plan. Each platform that graduates from here gets its own
`docs/superpowers/plans/YYYY-MM-DD-<platform>.md` in the established per-platform structure (Global
Constraints → verified facts → File Structure table → Task 1 = **Workers-egress probe (blocking)** → …).
Scope is **staging only**; the irreversible prod-apex cutover is a separate phase and out of scope here.

---

## Where we are

Natively covered today, at or above the reference bots on the mainstream set (native video plays on
three of them): **Twitter · Instagram · TikTok · Threads · Reddit · Bluesky**. All six are covered by both
reference bots too — so the entire parity gap is the **long tail**, plus the four platforms the owner
specifically called out: **Facebook, Twitch, YouTube, LinkedIn**.

**Shipped this session (Wave 0):** Reddit `/r/{sub}/s/{code}` app share links now resolve
(commit `b32f648`). See [Reddit completeness](#reddit-completeness) below for what remains there.

---

## ⚑ EMPIRICAL UPDATE (2026-07-24) — the "datacenter-blocked tier" was mostly WRONG

Measured through the media container's yt-dlp `{page}` path from real Cloudflare datacenter egress (a
temporary `/__ytprobe` route + stderr-surfacing `server.py`, both reverted after — never commit them). This
**supersedes the video-extraction assumptions in the sections below.** Two container fixes unlocked it —
`--force-overwrites` (an mkstemp pre-create made yt-dlp skip every download) and **Deno** (yt-dlp's JS-runtime
requirement for YouTube-class signature challenges), plus **curl_cffi** (`yt-dlp[default,curl-cffi]`) for
impersonation.

- **Shipped:** **YouTube** now plays a real, ad-free MP4 via `remux:{page}` → Discord's native player (commits
  `cd56b32`, `d3bc438`; the iframe approach was scrapped — it *was* Discord's native ad-riddled embed). The
  earlier "YouTube ad-free stream is blocked from datacenter" claim in the YouTube section is **false**: it was
  a missing JS runtime, not an IP block.
- **Works from datacenter FOR FREE (no proxy) — wire as `remux:{page}` video:** **Facebook** (`200 video/mp4`
  on a public watch url — Meta did NOT gate our egress, so the "experimental / likely-blocked" call in the
  Facebook section is **false for video**), **Dailymotion**, **Streamable**, **Imgur** (extractor resolves;
  only our own `--match-filter duration > 0` skips no-duration gifvs — small container fix: allow non-live
  duration-less clips, capped by `MAX_BYTES`), and **TikTok** via `{page}` (an alternative to today's aweme
  direct-302).
- **GENUINELY blocked from datacenter (a residential proxy is the only path):** **Vimeo** (`HTTP 401` fetching
  the anon OAuth token — curl_cffi did NOT flip it), **Weibo** (guest metadata → null media dict → `NoneType`),
  **Bilibili** (`HTTP 412` risk-control, as predicted). This is the *entire* real proxy tier — three sites, not
  the dozen the tiering below assumed.
- **Extractor gap (not a block, not proxy-fixable):** **Snapchat** (no working yt-dlp Spotlight extractor).

Net: the container `{page}` path (with Deno + curl_cffi) is far more capable than the sections below assume.
**Facebook video is now a free `remux:{page}` wire-up** (its posts/photos still want the separate metadata
path). The blocked tier shrank to Vimeo / Weibo / Bilibili. Re-read the per-site tiering below through this lens.

---

## Guiding principles (inherited from Phases 1–2 — every task implicitly includes all of these)

- **Native extraction only.** We `fetch()`+parse ourselves; we never proxy a user's post to a community
  fixer. The design spec is explicit ("We port, we do not vendor-and-edit"). The *one* sanctioned
  exception this roadmap adds is a narrow, opt-in [route-fallback](#the-generic-route-fallback-opt-in)
  for the provably datacenter-blocked tail — off by default, native-first, transparently attributed.
- **Assert on CONTENT, never HTTP status.** Gated pages (login walls, decoys, deleted posts) return
  `200` with junk. Every fetcher's liveness check is a content assertion.
- **Egress-probe first, and it is BLOCKING.** Residential measurements do **not** transfer — behaviour
  toward Cloudflare datacenter IPs is path-dependent (Meta and YouTube actively gate them). Before wiring
  any platform, a throwaway `src/probe.ts` (gated behind `env.PROBE_TOKEN`, **never committed** — the
  pipeline test enforces its removal) confirms the mechanism from real Workers egress, asserting on
  content. Notes land in `docs/research/YYYY-MM-DD-<platform>-workers-egress-probe.md`.
- **The media model.** Direct-CDN, cookie-free, 0-redirect video → `{kind:'video', url, w, h, poster}`
  served by a bare **302** to the origin CDN (Discord's proxy fetches it). HLS/DASH/redirect-hop/yt-dlp
  video → `remux: {video|audio|page}` muxed once by the container into a faststart MP4 in R2, served via
  `/_media/`. `withResolver` degrades any remux video to its **poster still** when the container isn't
  bound — never a dead player. A video attachment's `poster` is **mandatory** (a posterless video drops
  Discord's rich card to plain OG).
- **Zero runtime deps; PURE core** (fetchers do I/O, normalizers + renderers are pure/no-network);
  renderers emit `/_media/{refKey}/…`, never a raw CDN url; TDD (write the failing test, run it, confirm
  it fails for the right reason, then implement); commit identity pinned to Shamu4Life.

---

## The four called-out platforms

### Facebook — posts / photos / videos

**Verdict: `experimental` — playback is solved, extraction from CF datacenter is the make-or-break unknown.**

Facebook is Instagram's backend twin: same Meta relay JSON, same `videoDeliveryLegacyFields.browser_native_hd_url`
progressive MP4 on `*.fbcdn.net`, same **direct-302** playback model. Playback itself is a *solved*
problem — the `browser_native_hd_url` is a bare progressive faststart MP4, not IP/cookie/referer-locked
(residentially verified: range-GET with a plain Discord UA → `206 video/mp4`, `ftypisom`), with a ~5-day
signature well beyond our cache TTL. It's **ad-free** (FB injects ad-breaks client-side, not into the file).
So mirror the Instagram integration almost exactly: og:video → `/_media/{ref}` → 302 to fbcdn. **Do not**
route FB video through the container (unnecessary for an already-progressive file, and the container's
Meta-datacenter-IP block would defeat it anyway — exactly as with IG).

The entire risk is the **extraction fetch**, and it splits into two tiers gated on the probe:

- **Tier A (video).** Desktop Chrome UA + full `sec-ch-ua`/`sec-fetch` header set → SSR page → parse the
  `<script type="application/json">` relay blocks for `browser_native_hd_url` + `short_form_video_context`
  (author/text/reactions). This is how facebed (the open-source model) does it — but facebed uses
  `curl_cffi` **TLS impersonation** on a VPS, and **a Cloudflare Worker cannot impersonate Chrome's
  JA3/JA4** (it uses CF's TLS stack). A datacenter fetch of the reel URL already returned the contentless
  "Facebook" decoy shell. So Tier A is the exposed step and the likely failure point. Ship it **only if
  the egress probe passes.**
- **Tier B (fallback, always ships).** Crawler UA `facebookexternalhit/1.1` → real `og:title`/`og:description`
  + `og:image` (`lookaside.fbsbx.com`). Meta wants its own crawler to reach pages, so this is far more
  egress-tolerant (the FB parallel to our confirmed IG crawler-UA result) — but the crawler page **never**
  emits `og:video`. So Tier B buys a rich **image + caption card** (good for posts/photos) and degrades
  video to a **cover still** — consistent with how we already treat DASH-only media.
- **Tier C (long tail).** If native SSR is blocked and video really matters, route to facebed.com (open,
  replicable) via the opt-in route-fallback — acceptable for a low-value tail, not the default.

**First step:** the standard Workers-egress probe. *Probe A (decisive):* Chrome-UA + full header set on a
known public reel; PASS iff the body contains **both** `browser_native_hd_url` **and** `videoDeliveryLegacyFields`
(ignore the 200 — decoy and login wall are also 200). *Probe B (baseline):* `facebookexternalhit/1.1` on the
same URL; PASS iff `og:image` on `lookaside.fbsbx.com` + `og:title` present. Expected: A likely fails → ship
Tier B; B likely passes. Probe a reel/carousel, **never** a single image; record bytes to a fixture; delete
the probe. `share/v` short links are flaky (resolve via HEAD first). `mbasic` is dead (`400`); `m.facebook.com/reel`
walls to login; `?_fb_noscript=1` does not unlock video.

### Twitch — clips (ad-free) + full streams

**Verdict: clips = `cheap`, native, ad-free. Live streams = not embeddable as ad-free video; metadata card + link-out.**

Three sub-cases, wildly different difficulty:

- **CLIPS (the win).** A clip is a single pre-rendered progressive MP4 on Twitch's own clip CDN
  (`production.assets.clips.twitchcdn.net`) — **inherently ad-free** (ad stitching only happens in live/VOD
  HLS). Extraction is one batched `POST` to `gql.twitch.tv/gql` with the well-known **public web Client-ID**
  `kimne78kx3ncx6brgo4mv6wki5h1ko` (no OAuth, no secret): `VideoPlayerStreamInfoOverlayClip` (title/streamer/
  views) + `VideoAccessToken_Clip` (`videoQualities[0].sourceURL` + `playbackAccessToken{signature,value}`).
  Assemble `sourceURL?sig=<signature>&token=<urlencoded value>` and serve it as `og:video` via a **direct
  302** (no container, no remux — it's already faststart). Mint the signed URL **fresh per crawler hit**
  (sig/token expire in hours). This is a peer-grade native extractor, cheap.
- **LIVE channel.** An infinite HLS playlist (`usher.ttvnw.net`) with **SureStream server-side ad insertion**
  stitched inline — not a finite file, and impossible to serve ad-free (community ad-blockers only swap in
  backup streams and break within days; TwitchAdSolutions was archived). So "linking to full streams" means
  a **rich metadata card + link out** — `og:title` (channel + title + game), live preview thumbnail
  (`static-cdn.jtvnw.net`), viewer count — **no `og:video`**. Be explicit to users that live playback isn't
  embeddable. (Note: `twitch.tv` is already on Discord's native provider allowlist, so bare links get a
  native card; our added value for clips is inline MP4 autoplay.)
- **VOD.** A finite HLS whose raw stored segments are ad-free; default to the same metadata card, with an
  **optional** container remux for *short* VODs only (hard duration guard — VODs are commonly multi-hour/GB).

**Ad-free reality:** free for clips, achievable-but-expensive for VOD, effectively impossible for live.
**First step:** egress-probe the gql clip flow + the signed MP4 from CF (assert `data.clip.videoQualities[0].sourceURL`
present, then `200 video/mp4` + `ftyp` from the CDN). Do **not** copy fxtwitch's app-secret or spoo.me
shortener — both are unnecessary and violate the zero-dep house style. Risk: the two gql sha256 hashes rotate
every few months — keep them in one patchable constant tracking yt-dlp's `twitch.py`.

### YouTube — ad-free and/or iframe player

**Verdict: `cheap` as a metadata-card + iframe-player wrapper. Ad-free native stream is effectively blocked from datacenter.**

Two separable layers; only one is datacenter-viable:

- **Metadata (viable, keyless, datacenter-OK — empirically confirmed).** `youtube.com/oembed?url=…&format=json`
  returns `{title, author_name, author_url, thumbnail_url}` at `200` with no key/cookies/UA tricks, for both
  `/watch` and `/shorts`. `i.ytimg.com/vi/{id}/maxresdefault.jpg` thumbnails are a plain public CDN. Enough
  for a rich card. (oembed omits description/duration/views — those need the bot-gated InnerTube endpoint; skip.)
- **Ad-free native stream (blocked).** `googlevideo` streams are behind BotGuard/PO-Token and are **IP-locked
  to the extracting client**, so a server-extracted URL often won't even play from Discord's proxy IP. yt-dlp's
  own wiki says PO tokens no longer bypass the bot check for most cases from datacenter IPs. Koutube only gets
  an ad-free MP4 by running a private Invidious on residential egress — which we don't have. **Conclusion: no
  ad-free self-served stream from CF.** And ads on the embed player are creator-controlled — `nocookie`,
  `rel=0`, `modestbranding` do **not** remove them.
- **Iframe player (the recommended path, viable).** `twitter:card=player` + `twitter:player=https://www.youtube-nocookie.com/embed/{id}`
  (+ `twitter:player:width/height`) renders an **inline player** in Discord, because `youtube.com` is on
  Discord's iframe-player allowlist. This is the Koutube fallback, minus the private-Invidious `directUrl`.

**Cross-cutting dependency:** this is the first platform that needs a **`twitter:player` iframe head**, which
our renderer doesn't emit today (see [cross-cutting infra](#cross-cutting-infrastructure)). **Value framing:**
Discord already auto-embeds bare YouTube links with an inline player, so our net-new value is narrow — **Shorts**
(which render as a tall thumbnail-only card natively — the genuine gap), age-gated videos, and the nocookie
privacy angle. Ship Shorts first. If we emit a *worse* card than Discord's native one, we're net-negative —
test side-by-side. **First step:** probe oembed from the Worker (assert `author_name === 'Rick Astley'` on the
canonical test id); don't bother probing googlevideo — assume blocked. Detect embedding-disabled videos via
oembed `401` and fall back to a plain thumbnail card.

### LinkedIn

**Verdict: `experimental / probe-first` — but with a real, SSR-clean mechanism (better than expected).**

The naive path is a trap: fetching a public `/posts/…` or `/feed/update/…` URL logged-out returns `HTTP 200`
serving an **authwall** page (with SEO-bait title text embedded — the golden-rule trap: 200 status, login-wall
content). And the old `linkedin.com/embeds/oembed.json` endpoint is **dead** (`404`) — no public API, no AMP.

The win is LinkedIn's **official public embed iframe**: `https://www.linkedin.com/embed/feed/update/urn:li:activity:{ID}`
returns a **clean, no-login, server-side-rendered** widget — author, full post text, hashtags, the article/image,
and engagement counts — parseable by a zero-dep Worker (verified without JS execution). It's LinkedIn's sanctioned
"Embed this post" surface, exists **only for public posts** (private/connections-only posts have no embed — the
correct behaviour for a fix-service), and the activity ID is sitting right in the `/posts/…-activity-{ID}-…` slug,
so the URL→embed transform is trivial string extraction. **Native video** lives on `dms.licdn.com`/`media.licdn.com`
as signed, expiring MP4/DASH — the same shape we already solve: route it through the container → remux → R2 →
stable `/_media/`. No new mechanism.

**The deciding unknown is datacenter egress.** LinkedIn is the most scraping-hostile major platform (hiQ v.
LinkedIn; aggressive `HTTP 999 Request Denied` targeting cloud ASNs — AWS/GCP/DO/**Cloudflare** all low-reputation),
which is why the main site 999-blocks datacenter IPs and why neither reference bot bothers (that, plus low Discord
demand). **However**, the `/embed/feed/update/` endpoint is *designed* to be fetched server-side by arbitrary
third-party sites (WordPress preview crawlers etc.), so it's plausibly far more tolerant of datacenter IPs than the
profile/feed surface. Plausibly, not proven — everything hinges on one probe.

**First step:** a Workers-egress probe (real CF edge — `wrangler dev --remote` or a throwaway route, *not* local
dev) against `https://www.linkedin.com/embed/feed/update/urn:li:activity:{ID}` (crawler UA, then a plain Chrome
UA). **Content assertion:** pass only if the body contains the known post's author + a distinctive content string
— never the status. Pass → feasible-cheap (text/image now, video via the container). A `999`/authwall body at 200
→ shelved (it would need a residential proxy, which violates the native/zero-dep ethos).

---

## The long tail (everything else the reference bots cover)

Tiered by how fxeverything's architecture reaches each. **The single best ROI in the whole tail is the booru
family.**

### Tier A — cheap via the existing yt-dlp `{page}` container path

The container already exposes a `{page}` resolve — these are drop-ins that just need a card wired and a probe:

- **Newgrounds** — yt-dlp video/audio/portal; **low** block risk; cheapest Tier-A win.
- **Imgur** — yt-dlp for animated gifv/mp4 (static images → Tier B); **low** risk.
- **Tumblr (video)** — yt-dlp native-video extractor; low-moderate risk (NSFW blogs need a cookie).
- **Pinterest (video/idea-pins)** — yt-dlp MP4s; low-moderate (most pins are static → Tier B).
- **Iwara** — yt-dlp NSFW video; moderate (Cloudflare interstitial + login-gated posts); niche.
- **Bilibili / Weibo — yt-dlp exists but datacenter-blocked** (Bilibili: 352 risk-control + `412`; Weibo:
  `429`/CAPTCHA + CN geo-fence). Realistically **demote to Tier C** (route-fallback) rather than ship a flaky
  native path.
- **Snapchat** — yt-dlp Spotlight support is fragile; borderline, treat as Tier C if it flaps.

### Tier B — bespoke native metadata/image scraper (public APIs, no yt-dlp)

- **Booru family** (rule34 / gelbooru / danbooru / e621 / konachan / derpibooru·Philomena / paheal) — **all
  expose a public read JSON API** (`/posts.json?tags=` etc.) returning direct file URLs + tags/rating. **ONE
  shared scraper with per-host adapters covers ~7 sites; low block risk; highest value-per-effort of the whole
  tail.** Do this early.
- **Mastodon SOURCE links** (mastodon.social etc. — distinct from our Mastodon *renderer*) — any instance
  serves public `/api/v1/statuses/{id}` JSON with `media_attachments`; **near-free because it reuses the
  renderer we already ship.**
- **Tumblr (image/text)** — API v2 `/posts` or og-scrape; pairs with the Tier-A video path.
- **DeviantArt** — og:image / oEmbed reader with a mature-content gated fallback; moderate.
- **Imgur (static)** — public API or og-scrape for the direct `i.imgur.com` url; pairs with Tier A.
- **Pinterest (images)** — pin JSON / og-scrape; moderate (DC bot-gate).
- **FurAffinity** — HTML scrape for the full-res CDN url; mature content needs an `a`/`b` cookie; moderate-high
  (cookie management is the cost).
- **Pixiv** — `/ajax/illust/{id}` JSON, **but** `i.pximg.net` `403`s without a pixiv `Referer` (bytes must be
  re-proxied through the Worker) **and** datacenter egress is heavily bot/login-gated; **high effort, probe first.**

### Tier C — opt-in route-to-fixer fallback only

**Bilibili, Weibo** (provably DC-blocked), **Snapchat** (fragile), **iFunny** (low demand). Ship native only if
a probe ever proves egress works; otherwise a labeled route beats a broken native attempt.

### Tier D — skip / no-op

**Spotify** (Discord/Telegram already unfurl it with a playable card — nothing to fix), **PTT** (niche text BBS),
**Kemono** (archives paywalled content — legal/ToS liability on a public service), **iFunny** (watermarked reposts).

### Long-tail effort ranking (best ROI first)

1. **Booru ×7** (one shared JSON scraper) · 2. **Mastodon source** (reuses renderer) · 3. **Newgrounds** ·
4. **Imgur** · 5. **Tumblr** · 6. **DeviantArt** · 7. **Pinterest** · 8. **FurAffinity** · 9. **Iwara** ·
10. **Pixiv** (high effort, probe first) · 11. **Bilibili / Weibo** (route-fallback, not native) ·
12. Snapchat / iFunny / Kemono / PTT / Spotify (skip or thin route).

---

## Reddit completeness

The share-link fix shipped this session covers the case the owner actually hit (`/r/{sub}/s/{code}`). The two
remaining Reddit short forms the router still defers:

- **`redd.it/{id}` short links.** Investigated: `redd.it/{id}` `301`s to `reddit.com/comments/{id}`, and the
  code **is** the base36 post id — so *no network unfurl is even needed*; the id is already in hand. The only
  blocker is **routing**: a `redd.it` link mapped onto our host arrives as a bare single-segment path
  (`/{id}`), which is ambiguous with every other platform's short codes and cannot be safely claimed as Reddit.
  **Design decision needed:** either (a) support it only under the existing `/rd/` escape hatch by adding a
  bare-base36 matcher to the forced-Reddit context (`/rd/{id}` → `/comments/{id}`), which is clean and
  unambiguous; or (b) accept a bare `/{id}` as Reddit-by-id (risky — collides with IG codes etc.). Recommend
  (a). Low effort once decided; low priority (uncertain real-world usage).
- **`/gallery/{id}` and poll links — SKIP (deprecated).** Confirmed via the r/bugs post the owner surfaced
  (*"Desktop web: old gallery links no longer work…"*, u/jardeon, resolved live through our new `/s/` fix):
  old gallery links and polls are effectively deprecated/unused upstream. Not worth building.

---

## Cross-cutting infrastructure

Some platforms need capabilities we don't ship yet — build these once, reuse across the roadmap:

1. **`twitter:player` iframe head.** Our renderer emits `og:video`/`og:image` + the Mastodon-spoof head, but
   not a `twitter:card=player` + `twitter:player` iframe. **Required for YouTube** (and usable for Twitch/other
   consumers on Telegram/Mastodon). One renderer feature; gate it to the platforms that need it.
2. **Metadata-only card path** for link-out platforms with no embeddable media (Twitch live/VOD, YouTube
   fallback, DeviantArt gated, Spotify). A first-class "rich card, no `og:video`, links out" render mode.
3. **The generic route-fallback (opt-in).** See below.
4. **yt-dlp `{page}`** — already in the container; Tier-A platforms consume it unchanged.

### The generic route-fallback (opt-in)

Build a **single** `route-to-known-fixer` module, but keep it narrow and off by default — do **not** let it
become the philosophy:

- **OFF by default per platform**; only wired for the **provably un-fetchable** DC-blocked sites (Bilibili,
  Weibo) and **user-custom domains** (the reference bots' custom-site feature — a config-driven route table).
- **Native-first, always:** attempt native extraction, and only route on **empirically-confirmed** egress
  failure (assert on content, not status).
- **Transparently attribute** the downstream fixer.

Everything cleanly fetchable (the booru family, Mastodon source, Newgrounds, Imgur, Tumblr, DeviantArt) stays
**native** — that's the whole identity of the project.

---

## Prioritized build order (waves)

| Wave | Platforms | Why this grouping |
|---|---|---|
| **0 ✅ done** | Reddit `/s/` share links | Shipped `b32f648` |
| **1 — cheap native, high-confidence egress** | **Twitch clips** · **booru ×7** · **Mastodon source** · **Newgrounds** · **Imgur** | Direct-302 / public JSON APIs / drop-in yt-dlp; best ROI; no new render capability |
| **2 — cheap, needs `twitter:player`** | **YouTube** (Shorts-first) | Build the iframe-head capability once; narrow net-new value over Discord's native embed |
| **3 — probe-gated, mirror-IG** | **Facebook** | Tier B image cards always ship; Tier A native video only if the SSR egress probe passes |
| **4 — moderate scrapers** | Tumblr · DeviantArt · Pinterest · FurAffinity · **Pixiv** (probe first) | Bespoke metadata/image scrapers; escalating cost |
| **5 — route-fallback (opt-in)** | Bilibili · Weibo · user-custom sites | Provably DC-blocked; labeled route beats a broken native path |
| **Decide-later / experimental** | **LinkedIn** (probe first) · redd.it (routing decision) · Snapchat/iFunny (thin route) | Uncertain yield or a pending design call |
| **Explicitly skip** | Kemono · PTT · Spotify · gallery/poll links | Legal liability / niche / already-native / deprecated |

Each wave item, when picked up, follows the per-platform plan structure with **Task 1 = the blocking
Workers-egress probe** — no platform is wired before its mechanism is confirmed from real CF egress on content.

---

## Honest non-goals

- **No ad-free YouTube stream** and **no ad-free Twitch live** — both are structurally blocked (BotGuard/PO-token
  from datacenter; SSAI stitched into live HLS). We ship the iframe player / metadata card and say so plainly.
- **No inline Discord playback for Twitch live or Facebook via iframe** — neither `player.twitch.tv` (needs a
  matching `parent=`) nor `facebook.com/plugins/video.php` is on Discord's iframe allowlist.
- **We do not become a router.** The route-fallback exists only for the provably un-fetchable tail and
  user-custom sites, native-first and attributed.

---

## Correction, 2026-07-26 — measured, not planned

- **The container match-filter fix in the "Works from datacenter FOR FREE" bullet above is SHIPPED**
  (`duration<?1200 & !is_live`, `RESOLVER_GENERATION` g4 → g5), and **Dailymotion, Streamable and
  Imgur are wired** as `remux:{page}` platforms (`dm`/`st`/`im`) reusing the Facebook metadata path.
  Routing is deliberately narrow — `/video/{id}`, `/embed/video/{id}`, `/e/{id}`, `/s/{id}`,
  `/{id}.gifv`, plus the `/dm/ /st/ /im/` escape hatches. **Bare `/{id}` is NOT claimed**: `route()`
  is host-agnostic, so `dai.ly/{id}`, `streamable.com/{id}` and `imgur.com/{id}` collapse onto one
  undecidable segment that `youtube()` already partly owns. Users must paste the long form.
- **Newgrounds is BLOCKED, contradicting the "low block risk; cheapest Tier-A win" call above.** Every
  path 403s — including the site root — behind a JS challenge served by Newgrounds' own proxy
  (`<title>NG Guard</title>`, `/_guard/assets/main-*.js`), independent of UA, with no cookie set.
  yt-dlp cannot pass it because it cannot execute the guard's JS. Measured from a RESIDENTIAL host,
  which bot guards normally treat more favourably than datacenter, so Cloudflare egress is very
  unlikely to be better. Its route shapes (`/portal/view/{digits}`, `/audio/listen/{digits}`) are free
  and collision-proof, so adding it later costs nothing — but it must not be shipped on the strength
  of the older measurement.
- **Twitch clips (Tier 1 above) were NOT shipped, deliberately** — see the notes in this change's
  hand-off. The GQL surface still works and the signed MP4 is faststart, but three links in the chain
  are unmeasurable without Cloudflare egress, and Discord already draws a working native Twitch card,
  so a failed extract would be a visible regression rather than a neutral miss.
