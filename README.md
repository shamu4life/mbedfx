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

Some paths belong to more than one site. `/gallery/abc` could be Reddit, Instagram or Imgur, and the domain that would have told them apart is gone. A two-letter code in front settles it:

```
https://mbedfx.app/im/gallery/YcAQlkx     Imgur
https://mbedfx.app/x/status/20            Twitter
```

`x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `tw` `pn` `dm` `st` `im` `ms` `mk` `lm` `pt`, in the order of the table below.

You shouldn't need it often. The converter page names the site it read a link as, offers a one-click fix, and gives a chooser for an ambiguous path. If you ever have to force one, [file a bug](../../issues/new/choose) with the link.

### Just the media

Put `d.` in front of the domain and you get the file itself — the video or image — at its own URL, with byte-range support so it seeks and downloads properly.

```
https://d.megapenispoopenfarten.sex/jack/status/20
```

The converter page has a **media only** checkbox next to the domain buttons, so either domain works either way.

A `d.` url has no card to render, so people and crawlers get the same bytes. With nothing to serve, it answers a plain-text 404, because an HTML page would leave a downloader holding a file full of markup.

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

Short links resolve too: `youtu.be`, `tiktok.com/t/…`, Reddit's `/s/…` links and Meta's `/share/…` codes. A bare `dai.ly` or `redd.it` code names no site on its own, so the converter page rewrites those. The [site](https://mbedfx.app) lists every path shape mbedfx accepts.

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

<details>
<summary><strong>Inline video</strong></summary>

A companion container runs `yt-dlp` and `ffmpeg`, remuxes the stream to a progressive MP4, and caches it in R2. The Worker serves it with `Accept-Ranges: bytes`, which is what Discord's player seeks on.

A mux takes longer than a card is allowed to take, so the first view of a cold video draws the cover image and the next one plays it. That first card is never response-cached, because a cached cover would outlive the video it stood in for.

</details>

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
<summary><strong>When it can't show the post</strong></summary>

| | |
|---|---|
| Private or friends-only | 🔒 |
| Age-restricted | 🔞 |
| Deleted, or never existed | says so |
| A path two sites both use | lists the candidates to pick from |

Where the platform gives no reason, the card says the post couldn't be loaded and lists the likely reasons instead of picking one.

</details>

<details>
<summary><strong>Tracking junk gets dropped</strong></summary>

`igsh`, `_t`, `si`, `utm_*` and Meta's share tokens are stripped before anything is handed onward. Meta mints a fresh share code on every share, which makes a pasted link traceable back to whoever shared it, so those get cut down to the part that names the post.

</details>

## JSON API

The API serves the same data the card is built from, for anything you're building that isn't Discord. No key, no signup, and CORS is open.

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

It answers for every site the cards cover, plus share codes and short links whose path carries its own shape, and runs the same code path a pasted link takes. A bare `dai.ly` or `redd.it` code answers `ambiguous`, since that path shape is also an X or Instagram profile. Media urls come back pointing at mbedfx and not at the platform's CDN, which keeps them from expiring out from under you.

Mastodon, Misskey, Lemmy and PeerTube need the instance in the path (`?url=/lemmy.world/post/123456`), for the same reason their converted links do. Routing ignores the host, and for those four the host is part of the post's identity.

Branch on `ok` and `error.code`, never on the HTTP status. Every answer about a post is a `200`, including "this one is age-restricted". **[docs/API.md](docs/API.md)** covers the rest: what `muxing` and `pending` mean, and why a date can be `null`.

## Caveats

- Every platform here is read through an endpoint nobody documents, and those change without warning. When one goes, the card says it broke rather than showing a wrong one.
- An age-gated Instagram post needs an account to read, and nothing clever at the edge gets around that.
- Videos over 25 minutes come out as thumbnails, because a mux that long doesn't fit inside a request deadline.
- Translation is machine translation. It gets things wrong, and the original sits underneath it.
- There is no uptime guarantee. This is a Cloudflare Worker on a hobby budget. It will probably be fine.

## Privacy

- The page sets no cookies, needs no account, and carries no analytics.
- The Worker keeps counters: which platform was asked for, whether it worked, and whether the caller looked like Discord, Telegram, another bot or a person. None of it carries a url, an id or an address.
- R2 holds remuxed video, the metadata the container read back (title, uploader, description, poster, timestamp, counts), and translations. Video and metadata are keyed by the post, translations by a hash of the text. All three expire after 60 days and can be regenerated from the platform.
- Cards cache for about 15 minutes, so a just-deleted post can linger briefly.
- The Worker fetches from its own egress. A reader's IP and user agent stop there and never reach the platform.

## Official domains

Only these two hosts run mbedfx:

`mbedfx.app` · `megapenispoopenfarten.sex`

`d.` works on both, as `d.mbedfx.app` and `d.megapenispoopenfarten.sex`. A wildcard DNS record covers exactly one label, so a deeper name — `d.staging.mbedfx.app`, say — would need a record of its own.

Anything else using the name is not mbedfx.

### Optional configuration

Everything below has a working default, and you need none of it for a fresh deploy.

| Setting | What it does |
|---|---|
| `IMGUR_CLIENT_ID` | Imgur's API needs a client id. Without one, mbedfx falls back to the id yt-dlp publishes. That works, but the bucket is shared with every other tool using that id, and a free one of your own avoids the competition. |
| `IG_GRAPHQL_DOC_ID` | Pins Instagram's shortcode GraphQL query, which Meta rotates. When the pinned id dies, the older recoveries carry the card and the `copyright_gql` counter drops to zero. Re-pinning it is a config change and needs no release. |
| `TRANSLATE_GOOGLE` | Set to `off` to stop using Google's endpoint and fall back to Workers AI alone. |
| `RESOLVER_SECRET` | Shared secret the video container requires on every call. |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Reddit OAuth, if you have credentials. |
| `YT_ACCOUNTS` / `IG_ACCOUNTS` | A JSON array of accounts, each `{"label": "...", "cookies": "<the contents of a Netscape cookies.txt>"}`. Age-gated and login-walled videos are unreachable without one. The jar is written to a private temp file inside the container for the length of one call and deleted afterwards, and it's never logged, cached or put on a card. A malformed value is read as no accounts. A typo there costs the gated posts and leaves everything else working. |
| `X_ACCOUNTS` | The same array shape, but each entry is `{"label": "...", "auth_token": "...", "ct0": "..."}`, because Twitter's wall is beaten by a logged-in API call and not inside the downloader. Setting it changes **nothing** today. The call that spends it is not built yet, and gated tweets keep getting an accurate 🔞 card. The `pool_unused` counter reports when a configured pool goes unspent, which separates a deliberately idle pool from a broken one. |

Set them with `npx wrangler secret put <NAME>`.

**[docs/CREDENTIALS.md](docs/CREDENTIALS.md)** covers the three `*_ACCOUNTS` pools: how to export a cookies.txt without invalidating it, how to turn one into JSON, what is and isn't wired up yet, and why the local files are gitignored. `accounts.example.json` shows the finished shape with invented values.

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

<details>
<summary><strong>Project structure</strong></summary>

| Path | |
|---|---|
| `src/router.ts` | url → `Route`. Reads the path and query, never the host |
| `src/refkey.ts` | the security boundary for what crosses the wire and back |
| `src/platforms/*/` | `fetch.ts` does I/O, `normalize.ts` is pure, and that split is what lets the suite run against captured fixtures |
| `src/render/` | the two heads, the Mastodon spoof, failure cards |
| `src/translate.ts` | detection, translation, the marker |
| `container/` | the `yt-dlp` + `ffmpeg` resolver |
| `public/index.html` | the converter page, one file, no framework |
| `test/` | 1207 tests, `node --test`, no network |

</details>

<details>
<summary><strong>Running it</strong></summary>

```bash
npm install
npm test              # 1207 tests, no network
npx wrangler dev      # local worker
```

Don't deploy by hand. Cloudflare Workers Builds watches `main`, so merging is the deploy. `npm run deploy` refuses on purpose, because a hand deploy overwrites whatever the build shipped and the dashboard goes on showing a healthy Worker while the pipeline is broken. That has happened here once already.

The container is optional. Without it, video falls back to a cover image and nothing else changes. [container/README.md](container/README.md) covers what it answers and how it ships.

</details>

## Credits

Built by [**Claude**](https://claude.com/claude-code) (Anthropic), directed by [@shamu4life](https://github.com/shamu4life).

After [fxtwitter](https://github.com/FixTweet/FxTwitter), [vxtwitter](https://github.com/dylanpdx/BetterTwitFix), [InstaFix](https://github.com/Wikidepia/InstaFix) and the rest of the embed-fixer lineage, which share the idea here and none of the code. Icons from [Simple Icons](https://simpleicons.org), video from [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org). Full notices in [NOTICE.md](NOTICE.md).

## Trademarks

Every platform named here is a trademark of its owner. mbedfx isn't affiliated with, endorsed by, or connected to any of them. The names and icons identify which site a link came from, and nothing more.

## License

MIT. The full text is in [LICENSE](LICENSE).
