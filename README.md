<div align="center">

<img src=".github/social-preview.svg#gh-dark-mode-only" alt="mbedfx — social links that embed properly" width="720" />
<img src=".github/social-preview-light.svg#gh-light-mode-only" alt="mbedfx — social links that embed properly" width="720" />

[![License](https://img.shields.io/badge/license-MIT-5865f2?style=flat)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/shamu4life/mbedfx/ci.yml?branch=main&style=flat&label=CI&color=5865f2)](../../actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/shamu4life/mbedfx?style=flat&label=version&color=5865f2)](docs/CHANGELOG.md)

[![Cloudflare Workers](https://img.shields.io/badge/Deployed_on-Cloudflare_Workers-f38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Last commit](https://img.shields.io/github/last-commit/shamu4life/mbedfx?style=flat&label=updated&color=22c55e)](../../commits/main)

</div>

<p align="center"><strong>Social links that embed properly.</strong> Paste a link, get one Discord can actually draw. 17 sites, no accounts, nothing to install.</p>

---

Discord builds a link preview from the page's `og:` tags. Most social sites don't serve them, or serve a login wall, and the preview comes out as a grey rectangle with a domain in it.

Swap the site's domain for **mbedfx.app** and the card appears: author, caption, counts, and a video that plays inline as a real MP4. Same post, same link. Captions that aren't in English get translated with the original kept underneath, and a post that can't be shown gets a card saying why.

[fxtwitter](https://github.com/FxEmbed/FxEmbed), [vxtwitter](https://github.com/dylanpdx/BetterTwitFix) and [InstaFix](https://github.com/Wikidepia/InstaFix) got here first and are why anyone expects this to work at all. They go deep on one or two sites; mbedfx covers seventeen and fetches each itself. See [how it compares](#how-it-compares).

---

## Get started

Take a link and swap the domain:

```
https://x.com/jack/status/20
https://mbedfx.app/jack/status/20
```

<https://mbedfx.app> does the same swap in the browser, unfurls share codes, and draws the finished card, stat line and thumbnail included, before you send it.

> **<https://megapenispoopenfarten.sex>** runs the same worker. It's where this started, and links people already pasted still point at it.

### Forcing a site

Some paths belong to more than one site, and the domain that would have told them apart is gone. A two-letter code in front settles it:

```
https://mbedfx.app/im/gallery/YcAQlkx     Imgur
https://mbedfx.app/x/status/20            Twitter
```

`x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `tw` `pn` `dm` `st` `im` `ms` `mk` `lm` `pt`, in the order of the table below.

You shouldn't need it often. The converter page names the site it read a link as, offers a one-click fix, and gives a chooser for an ambiguous path. If you ever have to force one, [file a bug](../../issues/new/choose) with the link. [docs/API.md](docs/API.md#ambiguous) has which sites claim which path shape.

### Just the media

Put `d.` in front of the domain and you get the file itself — the video or image — at its own URL, with byte-range support so it seeks and downloads properly.

```
https://d.megapenispoopenfarten.sex/jack/status/20
```

The converter page has a **media only** checkbox next to the domain buttons, so either domain works either way. A `d.` url renders no card, and people and crawlers get the same bytes. [docs/API.md](docs/API.md#the-d-host) has what it answers with nothing to serve.

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

A bare `dai.ly` or `redd.it` code names no site on its own, so the converter page rewrites those. The short links that resolve as pasted are in [docs/API.md](docs/API.md#the-hosts-column). The [site](https://mbedfx.app) lists every path shape mbedfx accepts.

## How it compares

Checked 2026-08-01 against each project's docs, source and live service. **?** marks a cell that couldn't be established either way. The rival columns are frozen at that date; the mbedfx column is kept current.

FxEmbed goes deeper on Twitter than mbedfx goes on any single site. And the remux here is a workaround rather than a feature to be proud of: it exists because most of the seventeen won't hand a bot a playable file, and it buys nothing on Twitter or TikTok, where the platform already serves one.

| | **mbedfx** | [FxEmbed](https://github.com/FxEmbed/FxEmbed) | [vxTwitter](https://github.com/dylanpdx/BetterTwitFix) | [fxTikTok](https://github.com/okdargy/fxTikTok) | [InstaFix](https://github.com/Wikidepia/InstaFix) | [InstaFix Revived](https://github.com/Bl0ck154/InstaFix-Revived) |
|---|---|---|---|---|---|---|
| Sites covered | **17** | 2 documented, 4 live | Twitter | TikTok | Instagram | Instagram |
| Working public instance | ✅ | ✅ + status page | ✅ | ✅ | ❌ archived, self-host only | ✅ |
| How video reaches Discord | own remux | platform MP4 | CDN redirect | CDN redirect | CDN redirect | streamed |
| Caption translation | ✅ automatic | opt-in `/en` | opt-in `/en`, undocumented | ❌ | ❌ | ❌ |
| Card says *why* a post is missing | ✅ private / age / deleted | ? | ? | age only | ❌ redirects | one generic card |
| Public JSON API | [✅ documented](docs/API.md) | ✅ OpenAPI | ✅ documented | ❌ | ❌ | undocumented |
| Self-host off Cloudflare | [no blockers, no adapter yet](docs/SELF-HOSTING.md) | ❌ Workers | ✅ Docker · systemd · Lambda | Docker, undocumented | ✅ Docker · K8s | ✅ Docker |
| Operator metrics | [documented queries](docs/METRICS.md), no scrape endpoint | ? | ? | ✅ Prometheus | pprof | pprof |

## Features

A companion container remuxes the stream into one progressive faststart MP4, cached in R2 and served with `accept-ranges: bytes` for Discord's player to seek on. A cold video draws its cover image on the first view and plays on the next, and that first card is never response-cached. [container/README.md](container/README.md) has the resolver and its ceilings.

A post that can't be read gets a card naming the reason: 🔒 private or friends-only, 🔞 age-restricted, or deleted and never existed. Where the platform gives no reason the card lists the likely ones and picks none. A path two sites both claim is never guessed either: a bot gets an `Ambiguous link` card naming the candidate hosts, and a person gets an HTTP 300 "Which site did you mean?" page listing each candidate as a link (`src/render/chooser.ts`). [docs/API.md](docs/API.md#failures) has every code by name.

<details>
<summary><strong>Translation</strong></summary>

A caption that isn't in English gets translated, with the original kept below it:

```
Chinese cabbage is delicious, isn't it?

🌐 Translated from Japanese
白菜おいしいね
```

Non-Latin scripts (Japanese, Korean, Chinese, Russian, Arabic, Thai, Greek, Hebrew, Hindi) are spotted from the characters alone. Spanish, Portuguese and the other Latin-script languages have to be asked about, since guessing them by eye is how an English post ends up captioned as Portuguese.

The cache is keyed on the caption text, so a post going around a lot is translated once.

</details>

<details>
<summary><strong>Tracking junk gets dropped</strong></summary>

`igsh`, `_t`, `si`, `utm_*` and Meta's share tokens are stripped before anything is handed onward. Meta mints a fresh share code on every share, which makes a pasted link traceable back to whoever shared it, so those get cut down to the part that names the post.

</details>

## JSON API

`/_api/v1?url=<the post url>` serves the post data the cards are drawn from, as JSON. No key, no signup, and CORS is open to any origin.

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

Branch on `ok` and `error.code`, never on the HTTP status. Every answer about a post is a `200`, including "this one is age-restricted". **[docs/API.md](docs/API.md)** is the contract: the field table, the fediverse instance-in-path form, which short links answer `ambiguous`, what `muxing` and `pending` mean, why `createdAt` can be `null`, and how long a request is allowed to take.

## Caveats

- Every platform here is read through an endpoint nobody documents, and those change without warning. When one goes, the card says it broke rather than showing a wrong one.
- An age-gated Instagram post needs an account to read, and nothing clever at the edge gets around that.
- Videos over 25 minutes come out as thumbnails, because a mux that long doesn't fit inside a request deadline.
- Translation is machine translation. It gets things wrong, and the original sits underneath it.
- There is no uptime guarantee. This is a Cloudflare Worker on a hobby budget. It will probably be fine.

## Privacy

- The page sets no cookies, needs no account, and carries no analytics.
- The Worker keeps counters: a platform code, an outcome, and whether the caller looked like Discord, Telegram, another bot or a person. No url, post id, IP or verbatim user agent goes into one ([docs/METRICS.md](docs/METRICS.md)).
- R2 holds remuxed video, the metadata the container read back (title, uploader, description, poster, timestamp, counts), and translations. Video and metadata are keyed by the post, translations by a hash of the text. **All three expire after 60 days** and can be regenerated from the platform.
- Cards cache for about 15 minutes, so a just-deleted post can linger briefly.
- The Worker fetches from its own egress. A reader's IP and user agent stop there and never reach the platform.

## Official domains

Only these two hosts run mbedfx:

`mbedfx.app` · `megapenispoopenfarten.sex`

`d.` works on both, as `d.mbedfx.app` and `d.megapenispoopenfarten.sex`. A wildcard DNS record covers exactly one label, so a deeper name — `d.staging.mbedfx.app`, say — would need a record of its own.

Anything else using the name is not mbedfx.

### Optional configuration

Every setting below has a working default, and a fresh deploy needs none of them.

`RESOLVER_SECRET` · `IMGUR_CLIENT_ID` · `IG_GRAPHQL_DOC_ID` · `TRANSLATE_GOOGLE` · `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` · `YT_ACCOUNTS` · `IG_ACCOUNTS` · `X_ACCOUNTS`

`IMGUR_CLIENT_ID` falls back to the id yt-dlp publishes. That id works, and its bucket is shared with every other tool using it; a free one of your own avoids the competition.

`IG_GRAPHQL_DOC_ID` pins Instagram's shortcode GraphQL query, which Meta rotates. When the pinned id dies, the older recoveries carry the card and the `copyright_gql` counter drops to zero. **Re-pinning it is a config change and needs no release.**

`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` turn on Reddit's OAuth fallback. Both must be set for it to run at all (`src/platforms/reddit/fetch.ts:128`), and it runs only after the credential-free embed read comes back empty.

`TRANSLATE_GOOGLE=off` leaves Workers AI serving translation on its own.

Set them with `npx wrangler secret put <NAME>`.

**[docs/CREDENTIALS.md](docs/CREDENTIALS.md)** covers the three `*_ACCOUNTS` pools, which turn an age-gate card into an ordinary one: the JSON each takes, how to export a `cookies.txt` without invalidating it, what `X_ACCOUNTS` does and doesn't do today, what a malformed value costs, why the local files are gitignored, and `accounts.example.json`'s finished shape. **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#what-replaces-each-binding-and-what-degrades-without-it)** has what degrades without each binding; `RESOLVER_SECRET` is in [container/README.md](container/README.md#deploying-it).

## Contributing

File bugs and feature requests through the [issue templates](../../issues/new/choose). [CONTRIBUTING.md](.github/CONTRIBUTING.md) has what to run before a PR.

If your PR rests on what an upstream returned, say where you ran it. A datacenter IP and a residential one are served different bytes, and more than one feature here worked from a laptop and did nothing in production.

## Security

Don't open a public issue for a security problem. [SECURITY.md](.github/SECURITY.md) has the private route.

## How it works

<details>
<summary><strong>Discord reads two different documents</strong></summary>

For a post with media it follows the `<link rel="alternate" type="application/activity+json">` tag and renders a Mastodon-shaped status. For a post without media it reads the plain OpenGraph head. A fix applied to one head and not the other leaves half the posts unfixed.

</details>

`src/router.ts` turns a url into a `Route` from the path and the query, never the host. `src/refkey.ts` is the security boundary for what crosses the wire and back. Every `src/platforms/<site>/` splits `fetch.ts`, which does I/O, from `normalize.ts`, which is pure and tested against captured fixtures. `src/render/` draws the two heads, the Mastodon spoof and the failure cards. `src/translate.ts` holds detection, translation and the marker. `container/` is the `yt-dlp` + `ffmpeg` resolver, optional, and video falls back to a cover image without it. `public/index.html` is the converter page, one file, no framework. `test/` runs on `node --test` and touches no network.

[CONTRIBUTING.md](.github/CONTRIBUTING.md) has the commands, the test count and why `npm run deploy` refuses on purpose. [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) walks `handle()` at `src/worker.ts:3358`, the eight Cloudflare surfaces behind it and `container/server.py`, with line numbers.

## Credits

Built by [**Claude**](https://claude.com/claude-code) (Anthropic), directed by [@shamu4life](https://github.com/shamu4life).

After [fxtwitter](https://github.com/FixTweet/FxTwitter), [vxtwitter](https://github.com/dylanpdx/BetterTwitFix), [InstaFix](https://github.com/Wikidepia/InstaFix) and the rest of the embed-fixer lineage, which share the idea here and, apart from the Twitter GraphQL feature-flag table recorded in [NOTICE.md](NOTICE.md), none of the code. Icons from [Simple Icons](https://simpleicons.org), video from [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org). Full notices in [NOTICE.md](NOTICE.md).

## Trademarks

Every platform named here is a trademark of its owner. mbedfx isn't affiliated with, endorsed by, or connected to any of them. The names and icons identify which site a link came from, and nothing more.

## License

MIT. The full text is in [LICENSE](LICENSE).
