<div align="center">

<img src=".github/social-preview.svg#gh-dark-mode-only" alt="mbedfx — social links that embed properly" width="720" />
<img src=".github/social-preview-light.svg#gh-light-mode-only" alt="mbedfx — social links that embed properly" width="720" />

[![License](https://img.shields.io/badge/license-MIT-5865f2?style=flat)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/shamu4life/mbedfx/ci.yml?branch=main&style=flat&label=CI&color=5865f2)](../../actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/shamu4life/mbedfx?style=flat&label=version&color=5865f2)](docs/CHANGELOG.md)

[![Cloudflare Workers](https://img.shields.io/badge/Deployed_on-Cloudflare_Workers-f38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Tests](https://img.shields.io/badge/tests-1100%2B-22c55e?style=flat)](test)

</div>

<p align="center"><strong>Social links that embed properly.</strong> Paste a link, get one Discord can actually draw — 17 sites, no accounts, nothing to install.</p>

---

Discord builds a link preview out of the page's `og:` tags. Most social sites either don't serve them or serve a login wall instead, so you get a grey rectangle with a domain in it.

Swap the site's domain for **mbedfx.app** and you get the card: author, caption, counts, and a video that plays inline. Same post, same link, it just works now.

[fxtwitter](https://github.com/FxEmbed/FxEmbed), [vxtwitter](https://github.com/dylanpdx/BetterTwitFix) and [InstaFix](https://github.com/Wikidepia/InstaFix) got here first and are why anyone expects this to work at all. They go deep on one or two sites; mbedfx goes wide on seventeen, fetching each one itself rather than handing you off to somebody else's fixer. See [how it compares](#how-it-compares).

---

## Why

- **One domain.** Seventeen sites, not a different fixer to remember per platform.
- **Video actually plays.** A real MP4 with range support, so Discord's own player scrubs it.
- **Foreign captions get translated,** with the original kept underneath.
- **When a post can't be shown, the card says why.** Private, age-gated, deleted — not a blank rectangle.

## Get started

Nothing to install. Take a link and swap the domain:

```
https://x.com/jack/status/20
https://mbedfx.app/jack/status/20
```

Or paste it into **<https://mbedfx.app>**, which does the swap and shows you the card before you send it.

> **<https://megapenispoopenfarten.sex>** runs the same worker. It's where this started, and links people already pasted still point at it.

### Forcing a site

Some paths belong to more than one site. `/gallery/abc` could be Reddit, Instagram or Imgur, and once the domain is gone there's nothing left to tell them apart. Put a two-letter code first and it stops guessing:

```
https://mbedfx.app/im/gallery/YcAQlkx     Imgur
https://mbedfx.app/x/status/20            Twitter
```

`x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `tw` `pn` `dm` `st` `im` `ms` `mk` `lm` `pt` — in the order of the table below.

**You shouldn't need this.** The converter page names the site it read your link as and lets you change it with a click, and an ambiguous path gets you a chooser rather than a wrong guess. If you had to force one by hand, something's wrong on our end — please [file a bug](../../issues/new/choose) with the link.

### Just the media

Put `d.` in front and you get the file itself instead of a card — the video or image, at its own URL, with byte-range support so it seeks and downloads properly.

```
https://d.megapenispoopenfarten.sex/jack/status/20
```

The converter page has a **media only** checkbox that does the same thing, next to the domain buttons. It composes with them, so you can have either domain either way.

Handy for saving a clip, or for anywhere that wants a media URL rather than a link preview. It serves people and crawlers the same bytes — there's no card to render, so there's nothing to tell them apart for.

A post with nothing to serve answers a plain-text 404 rather than an HTML page, so a downloader never ends up with a file full of markup.

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

Short links resolve too — `youtu.be`, `dai.ly`, `redd.it`, `tiktok.com/t/…`, and Meta's `/share/…` codes. Every path shape it accepts is listed on the [site](https://mbedfx.app).

## How it compares

Checked 2026-08-01 against each project's docs, source and live service. **?** means we could not
establish it either way — not that the answer is no.

These are all good projects, and two things the table cannot show are worth saying plainly. FxEmbed's
depth on Twitter far exceeds ours on any single site. And our own remux is a workaround, not a
feature to be proud of — it exists because most of our seventeen won't hand a bot a playable file,
and it buys nothing on Twitter or TikTok, where the platform already serves one.

| | **mbedfx** | [FxEmbed](https://github.com/FxEmbed/FxEmbed) | [vxTwitter](https://github.com/dylanpdx/BetterTwitFix) | [fxTikTok](https://github.com/okdargy/fxTikTok) | [InstaFix](https://github.com/Wikidepia/InstaFix) | [InstaFix Revived](https://github.com/Bl0ck154/InstaFix-Revived) |
|---|---|---|---|---|---|---|
| Sites covered | **17** | 2 documented, 4 live | Twitter | TikTok | Instagram | Instagram |
| Working public instance | ✅ | ✅ + status page | ✅ | ✅ | ❌ archived, self-host only | ✅ |
| How video reaches Discord | own remux | platform MP4 | CDN redirect | CDN redirect | CDN redirect | streamed |
| Caption translation | ✅ automatic | opt-in `/en` | opt-in `/en`, undocumented | ❌ | ❌ | ❌ |
| Card says *why* a post is missing | ✅ private / age / deleted | ? | ? | age only | ❌ redirects | one generic card |
| Public JSON API | ❌ | ✅ OpenAPI | ✅ documented | ❌ | ❌ | undocumented |
| Self-host off Cloudflare | ❌ Workers only | ❌ Workers | ✅ Docker · systemd · Lambda | Docker, undocumented | ✅ Docker · K8s | ✅ Docker |
| Operator metrics | ❌ | ? | ? | ✅ Prometheus | pprof | pprof |


## Features

<details>
<summary><strong>Inline video</strong></summary>

Most platforms won't hand a bot a playable file, so a companion container runs `yt-dlp` and `ffmpeg`, remuxes the stream to a progressive MP4, and caches it in R2. The worker serves it with `Accept-Ranges: bytes` so Discord's player can seek.

The first view of a cold video shows the cover image while the mux finishes. Look again a moment later and it plays.

</details>

<details>
<summary><strong>Translation</strong></summary>

A caption that isn't in English gets translated, with the original kept below it:

```
Chinese cabbage is delicious, isn't it?

🌐 Translated from Japanese
白菜おいしいね
```

Non-Latin scripts — Japanese, Korean, Chinese, Russian, Arabic, Thai, Greek, Hebrew, Hindi — are spotted from the characters. Latin-script languages like Spanish and Portuguese get asked about, because telling those apart from English by eye is how you end up captioning an English post as Portuguese.

Translations are cached by content, so a post going around a lot only gets translated once.

</details>

<details>
<summary><strong>When it can't show the post</strong></summary>

| | |
|---|---|
| Private or friends-only | 🔒 |
| Age-restricted | 🔞 |
| Deleted, or never existed | says so |
| A path two sites both use | asks which one you meant |

Nothing here guesses. When a platform won't say what happened, that's what the card says.

</details>

<details>
<summary><strong>Tracking junk gets dropped</strong></summary>

`igsh`, `_t`, `si`, `utm_*` and Meta's share tokens are stripped before anything is handed onward. Meta mints a share code per share, so the link you paste can point back at you — those get cleaned down to the bits that name the post.

</details>

<details>
<summary><strong>The converter page</strong></summary>

<https://mbedfx.app> rewrites the link in your browser, tells you which site it read it as (and lets you correct it), unfurls share codes, and draws the card — stat line, thumbnail and all — before you paste it anywhere.

</details>


## Caveats

Know what you're getting:

- **No uptime guarantee.** It's a Cloudflare Worker on a hobby budget. It'll probably be fine.
- **Some posts can't be fixed.** An age-gated Instagram post needs an account, and nothing clever at the edge changes that.
- **Videos over 20 minutes come out as thumbnails.** Muxing one inside a request deadline isn't realistic.
- **It leans on undocumented endpoints.** Platforms change them without warning. When one goes you get a card saying it broke, not a wrong one.
- **Translation is machine translation.** It gets things wrong; the original's right underneath.

## Privacy

- **No accounts, no cookies, no analytics on the page.** Nothing identifies who pasted a link.
- **Counters only.** The worker records which platform was asked for and whether it worked. Not urls, not ids, not addresses.
- **R2 holds two things:** remuxed video, keyed by the post; and translations, keyed by a hash of the text. Both expire after 60 days, and both are regenerable from the platform they came from.
- **Cards cache for about 15 minutes**, which is why a post you just deleted can linger briefly.
- **Nothing about you reaches the platform.** The worker fetches from its own egress; your IP and user agent stay with us.

## Official domains

Only these run mbedfx:

`mbedfx.app` · `megapenispoopenfarten.sex`

`d.` works on `megapenispoopenfarten.sex` today. On `mbedfx.app` it needs a DNS record that doesn't exist yet, so `d.mbedfx.app` won't resolve until that's added.

Anything else using the name isn't us.

## Contributing

Bug reports and feature requests are welcome — see [CONTRIBUTING.md](.github/CONTRIBUTING.md) and the [issue templates](../../issues/new/choose).

One thing before a PR: if you change something based on what an upstream returned, say where you ran it from. A datacenter IP and your laptop get served different bytes. It's bitten this project before.

## Security

Please don't open a public issue for a security problem — [SECURITY.md](.github/SECURITY.md) has the private route.

## How it works

<details>
<summary><strong>Discord reads two different documents</strong></summary>

For a post with media it follows the `<link rel="alternate" type="application/activity+json">` tag and renders a Mastodon-shaped status. For a post without media it reads the plain OpenGraph head.

Change one head and forget the other and half the posts never see the fix. Both heads, every time.

</details>

<details>
<summary><strong>Project structure</strong></summary>

| Path | |
|---|---|
| `src/router.ts` | url → `Route`. Reads the path and query, never the host |
| `src/refkey.ts` | what crosses the wire and back — the security boundary |
| `src/platforms/*/` | `fetch.ts` does I/O, `normalize.ts` is pure |
| `src/render/` | the two heads, the Mastodon spoof, failure cards |
| `src/translate.ts` | detection, translation, the marker |
| `container/` | the `yt-dlp` + `ffmpeg` resolver |
| `public/index.html` | the converter page — one file, no framework |
| `test/` | 1117 tests, `node --test`, no network |

Fetch is split from normalize so the suite can run against captured fixtures instead of live sites.

</details>

<details>
<summary><strong>Running it</strong></summary>

```bash
npm install
npm test              # 1117 tests, no network
npx wrangler dev      # local worker
```

Deploys aren't run by hand — Cloudflare Workers Builds watches `main`, so merging is the deploy. `npm run deploy` refuses on purpose: a hand deploy overwrites whatever the build shipped, and prod goes on looking healthy while the pipeline is broken. That's happened here once already.

The container is optional. Without it, video falls back to a cover image and everything else is unchanged.

</details>

## Credits

Built by [**Claude**](https://claude.com/claude-code) (Anthropic), directed by [@shamu4life](https://github.com/shamu4life).

After [fxtwitter](https://github.com/FixTweet/FxTwitter), [vxtwitter](https://github.com/dylanpdx/BetterTwitFix), [InstaFix](https://github.com/Wikidepia/InstaFix) and the rest of the embed-fixer lineage — different code, same idea. Icons from [Simple Icons](https://simpleicons.org), video from [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FFmpeg](https://ffmpeg.org). Full notices in [NOTICE.md](NOTICE.md).

## Trademarks

Every platform named here is a trademark of its owner. mbedfx isn't affiliated with, endorsed by, or connected to any of them — the names and icons identify which site a link came from, and nothing more.

## License

MIT. Do whatever you want. We're not your parents.
