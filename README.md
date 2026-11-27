<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/social-preview.svg">
  <img src=".github/social-preview-light.svg" alt="mbedfx: social links that embed properly" width="720">
</picture>

<h1 align="center">mbedfx</h1>

[![License](https://img.shields.io/badge/license-MIT-5865f2?style=flat)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/shamu4life/mbedfx/ci.yml?branch=main&style=flat&label=CI&color=5865f2)](../../actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/shamu4life/mbedfx?style=flat&label=version&color=5865f2)](../../releases)
[![Cloudflare Workers](https://img.shields.io/badge/Deployed_on-Cloudflare_Workers-f38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)

</div>

<p align="center"><strong>Social links that embed properly.</strong> Change a post link's domain to mbedfx.app and Discord shows the post: who wrote it, what it says, the counts, and a video that plays right there in the chat.</p>

---

Paste a TikTok or Instagram link into Discord and you usually get a grey box with a domain name in it. Those sites hand Discord's link previewer a login wall or an empty page. mbedfx fetches the post itself and gives Discord something it can draw. It works for 17 sites, and there's nothing to sign up for or install.

## Try it

Swap the domain and leave the rest of the link alone:

```text
https://x.com/jack/status/20
https://mbedfx.app/jack/status/20
```

Or paste the link into [mbedfx.app](https://mbedfx.app). It does the swap for you, previews the card before you send it, and turns app share links into the real post link first.

## Supported sites

| | Site | Hosts |
|---|---|---|
| <img src="docs/images/sites/twitter.svg" width="16" height="16" alt="" /> | Twitter | `x.com` · `twitter.com` |
| <img src="docs/images/sites/tiktok.svg" width="16" height="16" alt="" /> | TikTok | `tiktok.com` |
| <img src="docs/images/sites/instagram.svg" width="16" height="16" alt="" /> | Instagram | `instagram.com` |
| <img src="docs/images/sites/threads.svg" width="16" height="16" alt="" /> | Threads | `threads.com` |
| <img src="docs/images/sites/reddit.svg" width="16" height="16" alt="" /> | Reddit | `reddit.com` |
| <img src="docs/images/sites/bluesky.svg" width="16" height="16" alt="" /> | Bluesky | `bsky.app` |
| <img src="docs/images/sites/youtube.svg" width="16" height="16" alt="" /> | YouTube | `youtube.com` · `youtu.be` |
| <img src="docs/images/sites/facebook.svg" width="16" height="16" alt="" /> | Facebook | `facebook.com` |
| <img src="docs/images/sites/twitch.svg" width="16" height="16" alt="" /> | Twitch | `twitch.tv` · `clips.twitch.tv` |
| <img src="docs/images/sites/pinterest.svg" width="16" height="16" alt="" /> | Pinterest | `pinterest.com` · `pin.it` |
| <img src="docs/images/sites/dailymotion.svg" width="16" height="16" alt="" /> | Dailymotion | `dailymotion.com` · `dai.ly` |
| <img src="docs/images/sites/streamable.svg" width="16" height="16" alt="" /> | Streamable | `streamable.com` |
| <img src="docs/images/sites/imgur.svg" width="16" height="16" alt="" /> | Imgur | `imgur.com` · `i.imgur.com` |
| <img src="docs/images/sites/mastodon.svg" width="16" height="16" alt="" /> | Mastodon | any instance |
| <img src="docs/images/sites/misskey.svg" width="16" height="16" alt="" /> | Misskey | any instance |
| <img src="docs/images/sites/lemmy.svg" width="16" height="16" alt="" /> | Lemmy | any instance |
| <img src="docs/images/sites/peertube.svg" width="16" height="16" alt="" /> | PeerTube | any instance |

A bare `dai.ly`, `redd.it` or `pin.it` code doesn't say which site it came from once the domain is swapped, so run those through the converter page. [docs/API.md](docs/API.md#the-hosts-column) lists the short links that work as pasted.

## What you get

- The author, the caption, and the like, reply and repost counts.
- Video that plays inside Discord. Most of these sites won't give a bot a playable file, so mbedfx downloads the video and repackages it as an MP4 you can seek through.
- Captions in another language translated into English, with the original underneath. Japanese, Korean, Chinese, Russian, Arabic and other non-Latin scripts are spotted from the characters alone.
- When a post can't be shown, a card that says why: 🔒 private, 🔞 age-restricted, or deleted. If the site won't say, the card lists the likely reasons and leaves it there.
- Tracking parameters (`igsh`, `_t`, `si`, `utm_*`) stripped. Meta's share links can be traced back to whoever shared them, so those are cut down to the post itself.

## Good to know

- The first paste of a video nobody has shared yet can show the cover image while the video is still being prepared. Discord keeps that first card in the message and caches the link for about half an hour, so a repost after that plays the video.
- Videos over 25 minutes come through as a thumbnail.
- Age-gated Instagram posts need a logged-in account to read, so they get the 🔞 card.
- Every site here is read through endpoints nobody documents, and they change without warning. When one breaks, the card tells you the post couldn't be loaded.
- Translations come from a machine. Check the original underneath.
- There's no uptime guarantee. It's a hobby project on Cloudflare Workers. It will probably be fine.

## Tricks

### Just the video or image

Put `d.` in front of the domain and the link opens the file itself, with seeking and downloads that work:

```text
https://d.mbedfx.app/jack/status/20
```

Ending the path with `.mp4` does the same thing, fxtwitter style: `https://mbedfx.app/jack/status/20.mp4`. When the post id is in the query, the `.mp4` goes before the `?`, as in `/watch.mp4?v=…`. The converter page has a "media only" checkbox for all of this, and [docs/API.md](docs/API.md#the-d-host) has the details.

### Bluesky profiles

`https://mbedfx.app/profile/bsky.app` shows the account's name, bio, avatar, follower, following and post counts, and the month it joined. Bluesky gives link previewers only a title. Twitter, TikTok and Instagram already send Discord a full profile card, so mbedfx doesn't handle their profile links, and a bare `/name` gets the which-site chooser.

### Picking the site

Once the domain is gone, a few paths could belong to more than one site. The converter page asks which one you meant. To settle it in the link itself, put the site's two-letter code first:

```text
https://mbedfx.app/im/gallery/YcAQlkx     Imgur
https://mbedfx.app/x/status/20            Twitter
```

The codes, in the same order as the site table:

`x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `tw` `pn` `dm` `st` `im` `ms` `mk` `lm` `pt`

If you keep needing one, [file a bug](../../issues/new/choose). [docs/API.md](docs/API.md#ambiguous) has which sites claim which paths.

## JSON API

`/_api/v1?url=<post url>` returns the data a card is drawn from. No key, and CORS is open, so a web page can call it directly.

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

Check `ok` and `error.code`, not the HTTP status. [docs/API.md](docs/API.md) is the full contract, and [`/openapi.json`](https://mbedfx.app/openapi.json) ([source](public/openapi.json)) describes it in OpenAPI 3.1 for code generators.

## Privacy

The converter page sets no cookies and runs no analytics. The Worker keeps counters of what happened on each platform (whether the card loaded, whether the video played, and whether Discord, a browser or another bot asked). It never stores the link, the post id, an IP address or a user agent ([docs/METRICS.md](docs/METRICS.md)). The site only ever sees mbedfx asking for the post.

On mbedfx.app, stored videos, translations and post data are deleted after 60 days, and all of it can be fetched again. Cards are cached for about 15 minutes, so a post deleted a moment ago can still show up for that long.

## Run your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shamu4life/mbedfx)

mbedfx runs on your own Cloudflare account or on any machine with Docker. [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) walks through each way, what it costs, and every setting.

| Way | You need | Video | Tried |
|---|---|---|---|
| Deploy to Cloudflare button | A GitHub account and Cloudflare Workers Paid | Yes | Not yet |
| Cloudflare, from a checkout | Workers Paid, Node 22.18 or later, and Docker while you deploy | Yes | Not yet |
| Docker Compose | Docker with Compose v2 on x86_64, and a reverse proxy for HTTPS | Yes | Yes, 2026-11-26 |
| Node, without Docker | Node 22.18 or later, plus the resolver if you want video | With the resolver | Only inside Compose |

> [!WARNING]
> Nobody has used the button or the Workers Free plan for real yet. Both follow Cloudflare's documentation, so expect a rough edge or two, and please [open an issue](../../issues/new/choose) if something breaks.

The button copies this repository into your GitHub account and sets up the Worker, an R2 bucket, three Durable Objects, Workers AI, an Analytics Engine dataset and the video container. Your Worker is called `mbedfx-selfhost` and lives on workers.dev. On the free plan, change the deploy command on the setup page to `npx wrangler deploy -c wrangler.free.jsonc` before the first build (and the branch command too). Everything works there except videos that need repackaging, which show their cover image.

### From a checkout, on Cloudflare

```bash
git clone https://github.com/shamu4life/mbedfx.git && cd mbedfx
npm ci
npx wrangler login
npm run deploy    # needs Workers Paid, and Docker running to build the video container
curl -s 'https://mbedfx-selfhost.<YOUR_SUBDOMAIN>.workers.dev/_api/v1?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fbsky.app%2Fpost%2F3msqpuobiwk2t' | jq .ok
```

The last line prints `true` once your Worker answers. Your workers.dev subdomain is in the URL the deploy printed. Then give the media bucket a 60-day expiry, once, because nothing else ever deletes from it:

```bash
npx wrangler r2 bucket lifecycle add mbedfx-selfhost-media expire-60d --expire-days 60
```

### With Docker

```bash
git clone https://github.com/shamu4life/mbedfx.git && cd mbedfx
(umask 077 && printf 'PUBLIC_ORIGIN=https://<YOUR_DOMAIN>\nRESOLVER_SECRET=%s\n' "$(openssl rand -hex 32)" > adapters/node/.env)
docker compose -f adapters/node/compose.yaml up --build -d
curl -s 'http://127.0.0.1:8787/_api/v1?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fbsky.app%2Fpost%2F3msqpuobiwk2t' | jq .ok
```

That prints `true` once the stack is up. The app listens on `127.0.0.1:8787` only, so put your HTTPS proxy in front of it and pass the client's `Host` header through. [The guide](docs/SELF-HOSTING.md#host-it-with-docker-compose) covers logs, updates and where the media goes.

Your copy also gets this repository's GitHub workflows. One of them proposes a yt-dlp update every Monday that a new release is out. The health check stays off until you set the `HEALTH_BASE` repository variable.

### Settings

None are required on Cloudflare. Docker Compose needs `PUBLIC_ORIGIN` and `RESOLVER_SECRET`, as in the snippet above. The ones most people touch:

| Name | What it does |
|---|---|
| `PUBLIC_ORIGIN` | Your domain or domains, main one first. The converter page offers each one as a button |
| `SITE_NAME` | The name your cards show, `mbedfx` by default |
| `REDDIT_USER_AGENT` | How your copy introduces itself to Reddit, if you add Reddit credentials |
| `YT_ACCOUNTS` | Logged-in YouTube accounts, so an age-gated video gets a normal card ([docs/CREDENTIALS.md](docs/CREDENTIALS.md) covers this and the other account pools) |

On Cloudflare, set plain settings as variables in the dashboard and credentials with `npx wrangler secret put <NAME>`. Under Docker Compose they all go in `adapters/node/.env`. [The full list](docs/SELF-HOSTING.md#settings) has the rest, including what each one does on each setup.

## How it compares

Checked on 2026-11-26 against each project's docs, source and live service, with the live checks run from a home connection using Discord's user agent. The other projects' columns are frozen at that date.

| | **mbedfx** | [FxEmbed](https://github.com/FxEmbed/FxEmbed) | [vxTwitter](https://github.com/dylanpdx/BetterTwitFix) | [fxTikTok](https://github.com/okdargy/fxTikTok) | [InstaFix](https://github.com/Wikidepia/InstaFix) | [InstaFix Revived](https://github.com/Bl0ck154/InstaFix-Revived) | [embeds.now](https://embeds.now/) |
|---|---|---|---|---|---|---|---|
| Sites covered | 17 | 2 documented, 4 live | Twitter | TikTok | Instagram | Instagram | 14 |
| Working public instance | ✅ | ✅ + status page | ✅ | ✅ | ❌ archived, domain on hold | ❌ both domains on hold | ✅ closed source |
| How video reaches Discord | own remux | varies: X redirect, Instagram MP4, TikTok streamed | platform MP4 | CDN redirect | CDN redirect | CDN redirect | varies by site |
| Caption translation | ✅ automatic | opt-in `/en` | opt-in `/en`, undocumented | ❌ | ❌ | ❌ | ❌ |
| Card says *why* a post is missing | ✅ private / age / deleted | deleted / private / suspended | one generic card | age, or one deleted-or-private card | ❌ redirects | age / region / unavailable | one generic card |
| Discord component embeds | for galleries over 4 pictures | in code, switched off | for big or mixed galleries | ❌ | ❌ | ❌ | ✅ every card |
| Public JSON API | [✅ documented](docs/API.md) + [OpenAPI](public/openapi.json) | ✅ OpenAPI | ✅ documented | ❌ | ❌ | minimal, 3 fields | ❌ |
| Self-host off Cloudflare | [Node adapter, Docker compose](docs/SELF-HOSTING.md#host-it-with-docker-compose) | Docker (runs workerd) | ✅ Docker · systemd · Lambda | ✅ Bun · Docker | ✅ Docker · K8s | ✅ Docker | ❌ closed source |
| Operator metrics | [documented queries](docs/METRICS.md), no scrape endpoint | Analytics Engine, error reports | stdout logs | ✅ Prometheus, opt-in | pprof | pprof, Telegram report | internal only |

FxEmbed goes deeper on Twitter than mbedfx goes on any one site. The remux exists because most of the seventeen won't hand a bot a playable file, and on Twitter and TikTok, which already do, it buys nothing.

Since August both Instagram fixers lost their public domains to registrar holds, and embeds.now (launched October 2026) became the other multi-site fixer with a public instance. Discord's component embeds, documented in October 2026, are the biggest change. A paste test on 2026-11-26 found that when a page carries one, Discord draws it and skips the Mastodon-style document mbedfx builds its cards from, and the video in the test lost its poster frame. So mbedfx sends one only for a post with more than four pictures and no video, where it shows up to nine of them in a 3x3 grid, and leaves every other card as it was.

## Domains

`mbedfx.app` and `megapenispoopenfarten.sex` run the whole thing. megapenispoopenfarten.sex is where it started, so links people already shared there keep working.

`forsen.sex`, `sorryifuckedyour.mom` and `hotsinglesnear.you` work for post links (and Bluesky profiles), with `d.` and `.mp4` too. Their front pages are other sites, so for the converter page and the JSON API, use mbedfx.app.

Other people can run copies on their own domains. This project doesn't run or vouch for them, so a problem with one goes to whoever runs it.

## How it works

Discord reads one of two documents for a link. For a post with media it follows a `<link rel="alternate" type="application/activity+json">` tag and renders a Mastodon-style status. Without media it reads the page's OpenGraph tags. mbedfx serves both. Videos a site won't hand over as a file are fetched with [yt-dlp](https://github.com/yt-dlp/yt-dlp), repackaged with [FFmpeg](https://ffmpeg.org) in a container, and stored in Cloudflare R2.

It's TypeScript on Cloudflare Workers. [CONTRIBUTING.md](.github/CONTRIBUTING.md) has the commands, what CI runs, and how to add a site.

## Contributing

Bugs and feature requests go through the [issue templates](../../issues/new/choose), and [CONTRIBUTING.md](.github/CONTRIBUTING.md) says what to run before a pull request. Everyone taking part follows the [Code of Conduct](.github/CODE_OF_CONDUCT.md).

If your change depends on what a site returned, say where you ran it from. A datacenter and a home connection get different answers from the same URL, and more than one feature here worked on a laptop and did nothing in production.

For a security problem, don't open a public issue. [SECURITY.md](.github/SECURITY.md) has the private route.

## Changelog

Every release is in [CHANGELOG.md](CHANGELOG.md), and tagged versions are on the [Releases](../../releases) page.

## Credits

Built by [Claude](https://claude.com/claude-code) (Anthropic), directed by [@shamu4life](https://github.com/shamu4life).

The idea comes from [fxtwitter](https://github.com/FixTweet/FxTwitter), [vxtwitter](https://github.com/dylanpdx/BetterTwitFix), [InstaFix](https://github.com/Wikidepia/InstaFix) and the rest of the embed-fixer family. The only code shared with any of them is the Twitter GraphQL feature-flag table credited in [NOTICE.md](NOTICE.md). Icons come from [Simple Icons](https://simpleicons.org), and the full notices are in [NOTICE.md](NOTICE.md).

All product and company names are trademarks of their respective owners. mbedfx isn't affiliated with or endorsed by any of them.

## License

[MIT](LICENSE)
