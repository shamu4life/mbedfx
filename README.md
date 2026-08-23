<div align="center">

<img src=".github/social-preview.svg#gh-dark-mode-only" alt="mbedfx: social links that embed properly" width="720" />
<img src=".github/social-preview-light.svg#gh-light-mode-only" alt="mbedfx: social links that embed properly" width="720" />

[![License](https://img.shields.io/badge/license-MIT-5865f2?style=flat)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/shamu4life/mbedfx/ci.yml?branch=main&style=flat&label=CI&color=5865f2)](../../actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/shamu4life/mbedfx?style=flat&label=version&color=5865f2)](docs/CHANGELOG.md)
[![Cloudflare Workers](https://img.shields.io/badge/Deployed_on-Cloudflare_Workers-f38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)

</div>

<p align="center"><strong>Social links that embed properly.</strong> Paste a link, get one Discord can actually draw. 17 sites, no accounts, nothing to install.</p>

---

Discord builds a link preview from the page's `og:` tags. Most social sites don't serve them, or serve a login wall, and the preview comes out as a grey rectangle with a domain in it.

Swap the site's domain for **mbedfx.app** and the card appears: author, caption, counts, and a video that plays inline as a real MP4. Same post, same link.

---

## Get started

Take a link and swap the domain:

```
https://x.com/jack/status/20
https://mbedfx.app/jack/status/20
```

<https://mbedfx.app> does the same swap in the browser and draws the card before you send it. It also unfurls share codes.

> **<https://megapenispoopenfarten.sex>** runs the same worker. It's where this started, and links people already pasted still point at it.

### Forcing a site

Some paths belong to more than one site, and the domain that would have told them apart is gone. A two-letter code in front settles it:

```
https://mbedfx.app/im/gallery/YcAQlkx     Imgur
https://mbedfx.app/x/status/20            Twitter
```

`x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `tw` `pn` `dm` `st` `im` `ms` `mk` `lm` `pt`, in the order of the table below.

Rarely needed: the converter page names the site it read a link as, offers a one-click fix, and gives a chooser for an ambiguous path. [docs/API.md](docs/API.md#ambiguous) has which sites claim which shape. If you do have to force one, [file a bug](../../issues/new/choose).

### Bluesky profiles

A Bluesky profile link works the same way, with nothing else edited:

```
https://bsky.app/profile/bsky.app
https://mbedfx.app/profile/bsky.app
```

The card carries the display name, the bio, the avatar, the follower, following and post counts, and
the month the account was created. bsky.app itself gives a crawler only a title, which is the reason
this one is here.

No other site's profile links work, and that is measured rather than pending. Twitter, TikTok and
Instagram all already hand a crawler a complete profile card of their own, so there is nothing to
fix; and their profile urls are a bare handle, which names an account on more than one of them at
once. A bare handle therefore stays a chooser rather than a guess.

### Just the media

Put `d.` in front of the domain and you get the file itself, the video or the image, at its own URL, with byte-range support so it seeks and downloads properly.

```
https://d.megapenispoopenfarten.sex/jack/status/20
```

The converter page has a **media only** checkbox next to the domain buttons. A `d.` url renders no card; [docs/API.md](docs/API.md#the-d-host) has the rest.

## Supported sites

| | Site | Hosts |
|---|---|---|
| <img src="https://www.google.com/s2/favicons?domain=x.com&sz=32" width="16" height="16" alt="" /> | Twitter | `x.com` · `twitter.com` |
| <img src="https://www.google.com/s2/favicons?domain=tiktok.com&sz=32" width="16" height="16" alt="" /> | TikTok | `tiktok.com` |
| <img src="https://www.google.com/s2/favicons?domain=instagram.com&sz=32" width="16" height="16" alt="" /> | Instagram | `instagram.com` |
| <img src="https://www.google.com/s2/favicons?domain=threads.com&sz=32" width="16" height="16" alt="" /> | Threads | `threads.com` |
| <img src="https://www.google.com/s2/favicons?domain=reddit.com&sz=32" width="16" height="16" alt="" /> | Reddit | `reddit.com` |
| <img src="https://www.google.com/s2/favicons?domain=bsky.app&sz=32" width="16" height="16" alt="" /> | Bluesky | `bsky.app` |
| <img src="https://www.google.com/s2/favicons?domain=youtube.com&sz=32" width="16" height="16" alt="" /> | YouTube | `youtube.com` · `youtu.be` |
| <img src="https://www.google.com/s2/favicons?domain=facebook.com&sz=32" width="16" height="16" alt="" /> | Facebook | `facebook.com` |
| <img src="https://www.google.com/s2/favicons?domain=twitch.tv&sz=32" width="16" height="16" alt="" /> | Twitch | `twitch.tv` · `clips.twitch.tv` |
| <img src="https://www.google.com/s2/favicons?domain=pinterest.com&sz=32" width="16" height="16" alt="" /> | Pinterest | `pinterest.com` |
| <img src="https://www.google.com/s2/favicons?domain=dailymotion.com&sz=32" width="16" height="16" alt="" /> | Dailymotion | `dailymotion.com` · `dai.ly` |
| <img src="https://www.google.com/s2/favicons?domain=streamable.com&sz=32" width="16" height="16" alt="" /> | Streamable | `streamable.com` |
| <img src="https://www.google.com/s2/favicons?domain=imgur.com&sz=32" width="16" height="16" alt="" /> | Imgur | `imgur.com` · `i.imgur.com` |
| <img src="https://www.google.com/s2/favicons?domain=mastodon.social&sz=32" width="16" height="16" alt="" /> | Mastodon | any instance |
| <img src="https://www.google.com/s2/favicons?domain=misskey.io&sz=32" width="16" height="16" alt="" /> | Misskey | any instance |
| <img src="https://www.google.com/s2/favicons?domain=lemmy.world&sz=32" width="16" height="16" alt="" /> | Lemmy | any instance |
| <img src="https://www.google.com/s2/favicons?domain=joinpeertube.org&sz=32" width="16" height="16" alt="" /> | PeerTube | any instance |

A bare `dai.ly` or `redd.it` code names no site on its own, and the converter page rewrites those. The short links that do resolve as pasted are in [docs/API.md](docs/API.md#the-hosts-column).

## Features

The container remuxes the stream into one progressive faststart MP4, cached in R2 and served with `accept-ranges: bytes` for Discord's player to seek on. A cold video draws the cover image first, and the card is never response-cached, so a **later paste** of the same link plays. The message that was already posted does not heal: Discord caches an embed permanently in the message it was pasted into, and per-URL for about 30 minutes on top. For the reader who pasted first, the first paste is the only paste — which is why the mux is given a Durable Object alarm and 15 minutes rather than `waitUntil`'s 30 seconds, and why `card_degraded / ok` is the number that measures this. [container/README.md](container/README.md) has the resolver and its ceilings.

Posts that can't be read get a card naming the reason: 🔒 private or friends-only, 🔞 age-restricted, or deleted and never existed. Where the platform gives no reason the card lists the likely ones and picks none. A path two sites both claim is not guessed either ([docs/API.md](docs/API.md#failures) has the codes; `src/render/chooser.ts` draws the human version).

<details>
<summary><strong>Translation</strong></summary>

Captions that aren't in English get translated, with the original kept below it:

```
Chinese cabbage is delicious, isn't it?

🌐 Translated from Japanese
白菜おいしいね
```

Non-Latin scripts (Japanese, Korean, Chinese, Russian, Arabic, Thai, Greek, Hebrew, Hindi) are spotted from the characters alone. Latin-script languages have to be asked about: guessing by eye captions English posts as Portuguese. The cache is keyed on the caption text, and a post going around a lot is translated once.

</details>

<details>
<summary><strong>Tracking junk gets dropped</strong></summary>

`igsh`, `_t`, `si`, `utm_*` and Meta's share tokens are stripped before anything is handed onward. Meta mints a fresh share code on every share, which makes a pasted link traceable back to whoever shared it; those get cut to the part that names the post.

</details>

## JSON API

`/_api/v1?url=<the post url>` serves the post data the cards are drawn from, as JSON. No key or signup, and CORS is open to any origin.

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

Branch on `ok` and `error.code`, never on the HTTP status. The contract is [docs/API.md](docs/API.md) in prose and [`/openapi.json`](https://mbedfx.app/openapi.json) ([source](public/openapi.json)) in OpenAPI 3.1, covering every response shape, every error code and the nullability of every field, which a generator or a schema viewer reads directly.

## Caveats

- Every platform here is read through an endpoint nobody documents, and those change without warning. When one breaks, the card says so rather than showing a wrong card.
- An age-gated Instagram post needs an account to read. Nothing clever at the edge gets around that.
- Videos over 25 minutes come out as thumbnails. A mux that long doesn't fit inside a request deadline.
- Translation is machine translation. It gets things wrong, and the original sits underneath it.
- There is no uptime guarantee. This is a Cloudflare Worker on a hobby budget. It will probably be fine.

## Privacy

- The page sets no cookies, needs no account, and carries no analytics.
- The counters carry a platform code, an outcome and the caller's class, never a url, post id, IP or verbatim user agent ([docs/METRICS.md](docs/METRICS.md)).
- R2 holds remuxed video, container metadata and translations, keyed by the post and, for translations, by a hash of the text. All three expire after 60 days and can be regenerated from the platform.
- Cards cache for about 15 minutes, so a just-deleted post can linger that long.
- The Worker fetches from its own egress, and a reader's IP and user agent never reach the platform.

## How it compares

Checked 2026-08-01 against each project's docs, source and live service. **?** marks a cell that couldn't be established either way. The rival columns are frozen at that date; the mbedfx column is kept current.

| | **mbedfx** | [FxEmbed](https://github.com/FxEmbed/FxEmbed) | [vxTwitter](https://github.com/dylanpdx/BetterTwitFix) | [fxTikTok](https://github.com/okdargy/fxTikTok) | [InstaFix](https://github.com/Wikidepia/InstaFix) | [InstaFix Revived](https://github.com/Bl0ck154/InstaFix-Revived) |
|---|---|---|---|---|---|---|
| Sites covered | **17** | 2 documented, 4 live | Twitter | TikTok | Instagram | Instagram |
| Working public instance | ✅ | ✅ + status page | ✅ | ✅ | ❌ archived, self-host only | ✅ |
| How video reaches Discord | own remux | platform MP4 | CDN redirect | CDN redirect | CDN redirect | streamed |
| Caption translation | ✅ automatic | opt-in `/en` | opt-in `/en`, undocumented | ❌ | ❌ | ❌ |
| Card says *why* a post is missing | ✅ private / age / deleted | ? | ? | age only | ❌ redirects | one generic card |
| Public JSON API | [✅ documented](docs/API.md) + [OpenAPI](public/openapi.json) | ✅ OpenAPI | ✅ documented | ❌ | ❌ | undocumented |
| Self-host off Cloudflare | [no blockers, no adapter yet](docs/SELF-HOSTING.md) | ❌ Workers | ✅ Docker · systemd · Lambda | Docker, undocumented | ✅ Docker · K8s | ✅ Docker |
| Operator metrics | [documented queries](docs/METRICS.md), no scrape endpoint | ? | ? | ✅ Prometheus | pprof | pprof |

FxEmbed goes deeper on Twitter than mbedfx goes on any single site. The remux is a workaround: most of the seventeen won't hand a bot a playable file, and it buys nothing on Twitter or TikTok, which already serve one.

## Official domains

Only these two hosts run mbedfx:

`mbedfx.app` · `megapenispoopenfarten.sex`

`d.` works on both. A wildcard DNS record covers exactly one label; a deeper name such as `d.staging.mbedfx.app` would need a record of its own. Anything else using the name is not mbedfx.

### Optional configuration

Every setting below has a working default, and a fresh deploy needs none of them. Set one with `npx wrangler secret put <NAME>`.

`RESOLVER_SECRET` · `IMGUR_CLIENT_ID` · `IG_GRAPHQL_DOC_ID` · `TRANSLATE_GOOGLE` · `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` · `YT_ACCOUNTS` · `IG_ACCOUNTS` · `X_ACCOUNTS`

`IMGUR_CLIENT_ID` falls back to the id yt-dlp publishes. That id works, and its bucket is shared with every other tool using it; a free one of your own avoids the competition.

`IG_GRAPHQL_DOC_ID` pins Instagram's shortcode GraphQL query, which Meta rotates. When the pinned id dies, the older recoveries carry the card and the `copyright_gql` counter drops to zero. Re-pinning it is a config change and needs no release.

`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` turn on Reddit's OAuth fallback. Both must be set for it to run at all (`src/platforms/reddit/fetch.ts:128`), and it runs only after the credential-free embed read comes back empty.

`TRANSLATE_GOOGLE=off` leaves Workers AI serving translation on its own.

The three `*_ACCOUNTS` pools each buy something different. `YT_ACCOUNTS` turns an age-gated video into an ordinary card. `IG_ACCOUNTS` is spent only inside the container's mux. Instagram's gate verdict comes off the Worker's own page fetch, which carries no cookie jar, and the pool leaves that detection where it was. **Setting `X_ACCOUNTS` changes nothing today**: the call that would spend it is not built, and gated tweets keep getting the honest 🔞 card. [docs/CREDENTIALS.md](docs/CREDENTIALS.md) covers all three: the JSON each takes, how to export a `cookies.txt` without invalidating it, and the `pool_unused` counter that reports a configured pool going unspent. [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#what-replaces-each-binding-and-what-degrades-without-it) has what degrades without each binding; `RESOLVER_SECRET` is in [container/README.md](container/README.md#deploying-it).

## How it works

<details>
<summary><strong>Discord reads two different documents</strong></summary>

Both heads need the same fix, or half the posts stay broken. For a post with media it follows the `<link rel="alternate" type="application/activity+json">` tag and renders a Mastodon-shaped status. For a post without media it reads the plain OpenGraph head.

</details>

- `src/router.ts` reads the path and the query, never the host, and returns a `Route`.
- `src/refkey.ts` is the security boundary for what crosses the wire and back.
- `src/render/` draws the two heads, the Mastodon spoof and the failure cards.
- `src/translate.ts` holds detection, translation and the marker.
- `public/index.html` is the converter page: one file, no framework.

[CONTRIBUTING.md](.github/CONTRIBUTING.md) has the rest of the layout, the commands, the test count and why `npm run deploy` refuses on purpose. [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) walks `handle()` at `src/worker.ts:3358`, the eight Cloudflare surfaces behind it and `container/server.py`.

## Contributing

Bugs and feature requests go through the [issue templates](../../issues/new/choose); what to run before a PR is in [CONTRIBUTING.md](.github/CONTRIBUTING.md).

If your PR rests on what an upstream returned, say where you ran it. A datacenter IP and a residential one are served different bytes, and more than one feature here worked from a laptop and did nothing in production.

## Security

Do not open a public issue for a security problem. [SECURITY.md](.github/SECURITY.md) has the private route.

## Credits

Built by [**Claude**](https://claude.com/claude-code) (Anthropic), directed by [@shamu4life](https://github.com/shamu4life).

Prior art: [fxtwitter](https://github.com/FixTweet/FxTwitter), [vxtwitter](https://github.com/dylanpdx/BetterTwitFix), [InstaFix](https://github.com/Wikidepia/InstaFix) and the rest of the embed-fixer lineage. No code is shared with them apart from the Twitter GraphQL feature-flag table in [NOTICE.md](NOTICE.md). Icons from [Simple Icons](https://simpleicons.org). Video from [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org). Full notices in [NOTICE.md](NOTICE.md).

## Trademarks

All product and company names are trademarks of their respective owners. mbedfx is not affiliated with or endorsed by any of them.

## License

MIT. The full text is in [LICENSE](LICENSE).
