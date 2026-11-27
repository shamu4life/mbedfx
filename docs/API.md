# The JSON API

`/_api/v1` serves the post data the cards are drawn from, as JSON. It shipped in 1.9.0
(`CHANGELOG.md`, 2026-08-04).

```
GET https://mbedfx.app/_api/v1?url=<the post url>
```

On another deployment, use its own origin. Every url in an answer is minted from it.

It needs no key, no signup and no required headers. Every answer carries
`access-control-allow-origin: *` and `x-content-type-options: nosniff` (`apiHeaders`, `src/worker.ts`).

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

It answers for the thirteen single-host sites the cards cover, plus short links and share codes. The
four fediverse platforms need the request form [below](#mastodon-misskey-lemmy-and-peertube).

The machine-readable half of this contract is `public/openapi.json`, served at
`https://mbedfx.app/openapi.json` and at `/openapi.json` on every other deployment. Its only server
is the relative `/`, so a client generated from any copy talks to the deployment that served it.
It is OpenAPI 3.1 and holds every response shape, every error code and the exact nullability of
every field, in the form a generator or a schema viewer reads. It is JSON because this toolchain has
no YAML parser, and the suite cannot check a spec it cannot read. `test/openapi.test.mjs` derives
what can be derived (the `Platform` union, `API_COUNTS`, the error codes and their statuses read out
of the `api` arm, the router's own answer for the documented path, and `RESP_TTL`). It then drives
real answers offline through `handle()` and validates them against the schemas with
`additionalProperties: false`, so a field added to `toApiPost` and not to the document fails the
build. Prose can't be derived, so the prose in both files is unchecked, and that test names what it
does not cover.

This file is the longer half, because a schema cannot hold what was measured, what was tried and
failed, or what a rule costs.

Source citations below name symbols rather than lines. The line numbers were right when 1.9.0
shipped on 2026-08-04, and by 2026-08-11 every one of them pointed into the wrong part of
`src/worker.ts`, because the file had grown around 140 lines underneath them. A name survives a
merge, and `test/openapi.test.mjs` fails when a symbol cited beside its `src/` file stops existing.
Citations into `test/` and `public/` are not checked, so they name the test or the list instead of
a line.

The endpoint answers `GET` and `HEAD`. `OPTIONS` returns `204` with
`access-control-allow-methods: GET, HEAD, OPTIONS`, `access-control-allow-headers: *` and
`access-control-max-age: 86400`, before any work is spent (the `OPTIONS` branch of the `api` arm,
`src/worker.ts`). Every other method is `405` `method_not_allowed` (the method check beside it).
Neither branch existed at 1.9.0's review: a preflight paid for an upstream fetch, a mux wait and a
`yt-dlp -J`, then failed for want of `access-control-allow-methods`.

## The request

The request has one parameter, `url`, carrying the whole original link. Percent-encode it: a raw `?`
or `&` in the post url ends the parameter early.

Routing reads the path and the query and ignores the host. `https://x.com/jack/status/20`,
`https://mbedfx.app/jack/status/20` and `?url=/jack/status/20` are one request, and a host cannot
break the tie on a path two sites claim ([`ambiguous`](#ambiguous)).

### Mastodon, Misskey, Lemmy and PeerTube

Those four have no single host. The instance is part of the post's identity, and routing drops it:

```
?url=https://lemmy.world/post/49966212      ->  notfound
?url=/lemmy.world/post/49966212             ->  the post
```

Move the instance into the path and drop the scheme:

| Site | Send |
|---|---|
| Mastodon | `?url=/mstdn.social/@stux/116994812581955524` |
| Misskey | `?url=/misskey.io/notes/ap7sliijot1f03nr` |
| Lemmy | `?url=/lemmy.world/post/49966212` |
| PeerTube | `?url=/framatube.org/w/vZNcho9kCoVzc8wZwacPtc` |

`test/link-hygiene.test.mjs:71-74` drives those four through the router, with the Lemmy, Misskey and
PeerTube ids from `test/fixtures/` and the Mastodon one from the converter page's example list
(the Mastodon entry of `PLATFORMS` in `public/index.html`). The cards mint the same shape:
`https://mbedfx.app/lemmy.world/post/49966212`.

## The answer

```json
{
  "ok": true,
  "muxing": false,
  "pending": false,
  "post": {
    "platform": "x",
    "canonical": "https://x.com/jack/status/20",
    "createdAt": "2006-03-21T20:50:14.000Z",
    "title": null,
    "text": "just setting up my twttr",
    "sensitive": false,
    "spoiler": false,
    "author": {
      "name": "jack",
      "handle": "jack",
      "url": "https://x.com/jack",
      "avatar": "https://mbedfx.app/_media/x%3A20/avatar"
    },
    "counts": { "likes": 183000, "reposts": 121000, "replies": 25000 },
    "media": [
      {
        "kind": "video",
        "url": "https://mbedfx.app/_media/x%3A20/0",
        "poster": "https://mbedfx.app/_media/x%3A20/poster0",
        "width": 1280,
        "height": 720,
        "still": false
      }
    ],
    "quote": null
  }
}
```

`post` comes from `toApiPost` (`src/worker.ts`), and the envelope from the `api` arm that wraps it.
The answers here were driven offline through `route()` and `handle()` on 2026-08-04, again on
2026-08-05, and again on 2026-08-11 against every shape in `public/openapi.json`.

### The envelope

| Field | Type | Nullable |
|---|---|---|
| `ok` | boolean | no |
| `muxing` | boolean | no |
| `pending` | boolean | no |
| `post` | object | no |

`ok` is `true` on this shape and `false` on a failure envelope, where `post` is absent.

### `post`

| Field | Type | Nullable |
|---|---|---|
| `platform` | string, one of the seventeen two-letter codes | no |
| `canonical` | string, absolute url | no |
| `createdAt` | string, ISO 8601 UTC | **yes** |
| `title` | string | **yes** |
| `text` | string | no |
| `sensitive` | boolean | no |
| `spoiler` | boolean | no |
| `author` | object | no |
| `author.name` | string | **yes** |
| `author.handle` | string | **yes** |
| `author.url` | string | **yes** |
| `author.avatar` | string, absolute url on the answering origin | **yes** |
| `counts` | object | no |
| `counts.likes` | integer > 0 | no |
| `counts.reposts` | integer > 0 | no |
| `counts.replies` | integer > 0 | no |
| `counts.views` | integer > 0 | no |
| `media` | array of objects | no |
| `media[].kind` | string, `"video"` or `"image"` | no |
| `media[].url` | string, absolute url on the answering origin | no |
| `media[].poster` | string, absolute url on the answering origin | **yes** |
| `media[].width` | number | **yes** |
| `media[].height` | number | **yes** |
| `media[].still` | boolean | no |
| `quote` | object | **yes** |
| `quote.canonical` | string, absolute url | **yes** |
| `quote.text` | string | no |
| `quote.author` | object | no |
| `quote.author.name` | string | **yes** |
| `quote.author.handle` | string | **yes** |
| `quote.author.url` | string | **yes** |

Every key is always present except the four under `counts`, which are **omitted when unknown**. That
is the only place an absent key carries meaning. With nothing to report, `title` is `null`, `text`
is `""`, `counts` is `{}` and `media` is `[]`. The `quote.*` keys are present whenever `quote` is an
object.

### `createdAt`

`null` where a platform publishes no post date, and until a second, slower call brings one. A Post
without one holds `new Date(0)` internally. `toApiPost` and `/_card` both send that as `null`, and
the Discord card leaves the date out. Sort a `null` as unknown, never as old
(the test "AN UNKNOWN UPLOAD DATE IS null, NOT THE EPOCH" in `test/api.test.mjs`).

### `counts`

`apiCounts` (`src/worker.ts`) copies `likes`, `reposts`, `replies` and `views` only when each is a
finite number above zero. A `0` reaches that filter both from an untouched post and from a count the
platform withholds (a hidden like count, comments switched off), and the filter cannot tell the two
apart. An absent key means unknown; v1 cannot encode a count known to be zero. Which of the four keys
exist varies by site.

A Reddit post read through the archive path (since 2026-10-22, when embed.reddit.com began refusing
this service's egress; `src/platforms/reddit/normalize.ts`) carries the counts Reddit's own page
prints, which Reddit rounds: `12K votes` is published as `12000`. When that page prints none, as for
a post whose description is its body, both keys are absent. The archive's own counts are never
published, because they froze when the archive read the post.

### `text`

What the card shows, with the card's overlays composed in. v1 gives none of the overlays a field of
its own:

- a translation, followed by a `🌐 Translated from …` marker and then the original text;
- `🔞 Age-restricted on …` on a gated YouTube video (`sensitive` is also `true`);
- `🎬 Too long to play here. Open it on …` on a video past the length ceiling for a remux;
- `🔴 Live stream, so no preview here. Open it on …` on a broadcast with no finished file behind
  it, streaming now or scheduled. It suppresses the length note: a card carries at most one of the
  two, and this is the more specific verdict because it is the one the mux was refused on.

No v1 field carries the author's untouched words. Splitting them out is additive and on the list.

`text` is the whole stored body, which can be longer than what the card shows: the card stops at
500 characters or 10 lines, whichever comes first, on every platform (`clampText`,
`src/render/text.ts`; the owner's numbers since 2026-10-11, replacing 253 characters). A Reddit body
is stored up to 4000 characters. A Reddit post whose page carries no body (a picture, gallery, video,
link or crosspost post) takes it from Reddit's crawler page, Reddit's feed, or the Arctic Shift
archive, in that order (`src/platforms/reddit/caption.ts`), and a body Reddit cut short ends in `…`.
On the archive path every post's body is chosen that way, from Reddit's crawler page and the archive
(the feed refuses this service's egress too).

A spoiler is `[spoiler]` wherever the source marks it (the post page, Reddit's feed, the archive). A
short caption read from Reddit's crawler description alone shows one in the clear, as Reddit's own
link preview does, because Reddit drops the markers there (measured on r/Jujutsufolk/comments/1x2vdbg,
2026-10-11).

`deserializePost` validates the ref, the canonical and the date, nothing else. `text` goes out
through `str()` (`src/render/embed.ts`, applied in `toApiPost`): a cached value of the wrong type is
published as `""`, never verbatim. The test "A CACHED RECORD OF THE WRONG TYPE IS PUBLISHED AS null, NEVER VERBATIM" in
`test/api.test.mjs` pins it, asserting `""` for `text` and `quote.text`; the `null` in its title is
what a wrong-typed `width` or `height` becomes.

### `spoiler`

`true` when the whole post is tagged a spoiler, which only Reddit's tag sets today. `text` is then
exactly `[spoiler]`, whatever the post says, and `media` is unchanged: the cards ask Discord to blur
it rather than leave it out. `spoiler` is separate from `sensitive`, which says the content is adult.
A Reddit post that is both is published as `sensitive` only, because Reddit's page names the adult
content and not the spoiler.

### `width` and `height`

`0` is far more common than `null`. Reddit, TikTok covers, Threads, Facebook galleries and every
remuxed video emit `0` for an unreported size, and a remux carries `w: 0, h: 0` so that a player
reads the real dimensions out of the file. `null` means the cached value wasn't a finite number
(`num`, `src/worker.ts`). Both mean unknown; divide by neither.

The pair describes the bytes at `url`, not the original video: `posterW ?? w` and `posterH ?? h`
(`toApiPost`, `src/worker.ts`), and a `still` entry reports the poster frame's size. Both rows were
added 2026-08-04 (`3a2406f`).

A Reddit GIF's pair is the size its own file states: the first ten bytes of the .gif, read with one
ranged request when the post is fetched (`gifSize`, `src/platforms/reddit/normalize.ts`). If that read
fails or times out, the pair is `0` and the entry's kind and url are unchanged. The card can still
differ: without a size the Discord attachment carries no `meta.original`, which has been measured to
leave Discord drawing no picture (a YouTube poster, 2026-07-31; unmeasured for Reddit).

### `media`

Entries with no servable url are dropped. The rest keep their position in the unfiltered array
(`usableWithIndex`, `src/worker.ts`), which is the index `/_media/` resolves against. Taking the
position after the filter would publish entry N at entry N+1's bytes, or a 404 past the end. The
test "A PUBLISHED MEDIA URL RESOLVES TO THAT ENTRY'S BYTES" in `test/api.test.mjs` pins that
off-by-one. A degraded still is addressed through its poster slot, never that bare number
(`bytesIndex`, `src/render/embed.ts:74`), which goes on naming the video entry and answers `503`.

`kind` collapses `Media.kind`'s three values (`src/types.ts`) to two, publishing a `gif` as
`"image"` (`toApiPost`, `src/worker.ts`). The bytes at `url` are an animated .gif file, which an
`<img>` animates and a `<video>` cannot play, and the entry carries no `poster`. Until 2026-10-05 a
`gif` was published as `"video"`, which told every consumer, the converter page included, to draw
nothing. Reddit GIF posts have been the common case since that date, served as their original .gif
so that Discord loops them (expected, and checked by a real paste rather than measured here). Misskey
GIFs and Reddit posts labelled `image` with a .gif were always `gif`.

### `still`

A video is published as an `image` entry carrying `still: true` when it hasn't finished muxing, is
too long to mux at all, is a live broadcast with no finished file behind it, or has failed every mux
attempt. `url` and `poster` are then both the poster frame, which is where the bytes are. Read it
with the top-level `muxing` flag:

| `still` | `muxing` | Meaning |
|---|---|---|
| `false` | `false` | An ordinary picture. |
| `true` | `true` | A video is still muxing. Ask again on the horizon under [`muxing` and `pending`](#muxing-and-pending): seconds for a short video, minutes for a long one. |
| `true` | `false` | A video exists that cannot be served. If it is too long to mux, the verdict is permanent. If it is a live or scheduled broadcast, the verdict is final for as long as this card is cached, and the archive will mux normally once the stream ends. If every scheduled mux attempt failed, `text` starts with "The video couldn't be loaded here" and the verdict holds for six hours, after which the next request tries again. |

Without `still`, only the English in `text` would tell that last row apart from an ordinary photo.

On a deployment with no video container or no media bucket (the Free config, a Worker Preview with
no bucket, or the Node adapter with no container), a video that needs muxing is published as an
ordinary picture: `kind: "image"`, `still: false`, `poster: null` (`withResolver`, `src/worker.ts`).
That comes from reading the code and has not been measured. Nothing in v1 tells it apart from a
photo.

### `quote`

`null` unless the quoted post carries an author object (`toApiPost`, `src/worker.ts`). The
normalizers cap depth at 1, which leaves `quote.quote` always absent. `quote.author` has no `avatar`, and
`quote` has no `media`: those entries live at indices after the outer post's in `mediaList`, and
getting that arithmetic wrong would publish urls that resolve to the wrong bytes.

### Media urls

Every url in the payload is on the origin that answered (`mbedfx.app` on the public instance), never
on the platform's CDN, which hands out signed, short-lived and sometimes IP-locked urls. An mbedfx
url carries no expiry, stays valid as its destination changes, and is safe to store. Once a url
redirects, range support and reachability belong to the platform.

| Media | Served as |
|---|---|
| remuxed video | R2 bytes, answering range requests, so a player can seek |
| images, avatars, posters, already-progressive video | `302` to the CDN under `cache-control: public, max-age=300` (`MEDIA_MAX_AGE`, `src/cache.ts:9`) |
| Instagram, Twitch and Threads video | proxied rather than redirected (the `media` arm of `src/worker.ts`; the three platforms are scoped in `proxyableVideoUrl`, `src/mediaproxy.ts`) |

A Reddit link post (a post whose content is a link to a YouTube video, a tweet, a clip) carries the
linked post's media, and its urls name the linked post's key, not the Reddit post's:
`/_media/yt%3A{id}/0` for a Reddit post linking a YouTube video. They are exactly that post's urls,
with its mux, its poster slot and its range serving, so a consumer that already has them from a
direct read of the linked url holds the same ones. `platform` and `canonical` stay Reddit's. Only
links to a fixed set of hosts are followed (`linkedRef`, `src/linkref.ts`); a link to anything else
carries no media, as before.

The payload's urls carry no extension. The card's `og:video` adds `.mp4` to the same url, a GIF's
Mastodon attachment adds `.gif`, and either spelling is a promise. A media url ending in a video
extension (`.mp4`, `.m4v`, `.mov`, `.webm`) whose entry is not a video, or in an image extension
(`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) whose entry is a video, answers `503` with
`cache-control: no-store`, never a redirect to the other kind of bytes. Those are the `asVideo` and
`asImage` guards in the `media` arm, added 2026-10-05 when Reddit GIF posts moved from an mp4 to their
original .gif under urls a day of cards had promised as video.

### The `/v` and `/p` gallery suffix

A trailing `/v` or `/p` on any post url picks how a multi-item gallery holding a video is drawn.

| url | what the card holds |
|---|---|
| `mbedfx.app/{post}` | the default, which is `/v` |
| `mbedfx.app/{post}/v` | the first video of the post's own media plays; every other item is a still, and the body carries a fixed note that the post holds more |
| `mbedfx.app/{post}/p` | every item is a still, marked "Contains video"; nothing plays |

Neither suffix changes a single-item post or a gallery with no video in it: both render identically
under either spelling. Only one video ever plays, whatever the gallery holds, because Discord draws a
single player from a `media_attachments` array and discards the rest (measured 2026-07-20;
`src/render/mastodon.ts` carries the evidence).

`/_api/v1` deliberately takes no such suffix and is unaffected by it. It publishes each entry's true
`kind` plus the `still` flag described above, which is the post as fetched. The mode is a property of
one rendered card, not of the post, and a JSON consumer wants the post.

The suffix is stripped ahead of every route matcher, and routing falls back to the unstripped path
when the stripped one names no post. That keeps the handful of live permalinks whose own last segment
is `p` or `v` working (`/p/v` is an Instagram shortcode; `/{host}/@user/v` is a fediverse id).

A `)` at the end of a post url's path, and anything after it, is dropped the same way (strip first,
keep it only when what remains names a post), whether it is glued to the id or sits in a segment of
its own after a trailing `/`. Discord appends exactly that when a masked link `[text](url)` is
followed directly by punctuation: `[text](url).` fetches `url).` (discord-api-docs issue 6279).
Without the trim the `)` became part of the post id. This applies to `url` here too:
`?url=https://x.com/jack/status/20).` describes post 20. A post whose id is in the query
(`/photo/?fbid=`, `/story.php?…`, `/embed?clip=`) is not covered: the tail lands in the query value,
which routing does not trim.

### The `d.` host

`d.` in front of any of the three official hosts serves the file itself, video or image, at its own
url: `https://d.mbedfx.app/jack/status/20`, `https://d.megapenispoopenfarten.sex/jack/status/20`,
`https://d.forsen.sex/jack/status/20`. It does the same on mbedfx.app's two guest domains
(`GUEST_HOSTS` in `wrangler.production.jsonc`), which serve post links only
(`https://d.hotsinglesnear.you/jack/status/20`, `https://d.sorryifuckedyour.mom/…`). Those
bytes answer range requests, so a client can seek and resume. A `d.` url renders no card and serves
crawlers and people the same bytes.

With nothing to serve, `d.` answers a plain-text 404; an HTML body there would leave a
downloader holding a file full of markup. `media_miss` on this host means the post has no usable
media at all, a second meaning that `docs/METRICS.md` records under
"Known defects in the write shape" (`serveDirectMedia`, `src/worker.ts`).

On another deployment, `d.` works on any domain it serves (`DIRECT_MEDIA_HOST`, `src/worker.ts`) once
that name reaches it. On Cloudflare, add `d.<your domain>` as a custom domain. On the Node adapter,
list `https://d.<your domain>` in `PUBLIC_ORIGIN`, because the adapter answers an unlisted host as its
first origin. Listing it there also shows the converter page's media-only box. The `.mp4` suffix
below needs neither.

A trailing `.mp4` on the post url's path does the same on any host. It is the spelling fxtwitter
users already type: `https://mbedfx.app/jack/status/20.mp4`. It is read off the path (`DIRECT_SUFFIX`,
`src/router.ts`), so it works on every post `d.` works on, share codes and short links included. It
can be glued to the last path segment or follow a trailing `/` (`/p/{code}/.mp4`), come before or
after a `/v` or `/p`, and sit on the path of a link whose id is in the query (`/watch.mp4?v={id}`,
`/photo/.mp4?fbid={id}`). The answer is identical to `d.`'s: the post's first usable media, a
plain-text 404 when there is none (or when a share code or short link does not resolve), and no split
between crawlers and people. Only `.mp4` is read, in any letter case. On the query value it is
ignored: `/watch?v={id}.mp4` is still a card for a YouTube id and a chooser for a Facebook numeric
one. `/_api/v1` ignores the suffix, as it ignores `/v` and `/p`, and describes the post.

Both spellings have one cost a card does not. A card answers at once and Discord fetches its video
later. A direct url makes Discord follow the redirect into `/_media/` straight away, so the first
paste of a video that still has to be muxed (YouTube, Reddit, Facebook and the other container
platforms) can draw nothing while the mux runs, where the card would have shown the title and the
poster. A later paste plays.

## The seventeen platform codes

`platform` is the two-letter code. `tw` is Twitch. Twitter is `x`.

| Code | Site | Hosts |
|---|---|---|
| `x` | Twitter | `x.com` · `twitter.com` |
| `tt` | TikTok | `tiktok.com` |
| `ig` | Instagram | `instagram.com` |
| `th` | Threads | `threads.com` |
| `rd` | Reddit | `reddit.com` |
| `bs` | Bluesky | `bsky.app` |
| `yt` | YouTube | `youtube.com` · `youtu.be` |
| `fb` | Facebook | `facebook.com` |
| `tw` | Twitch | `twitch.tv` · `clips.twitch.tv` |
| `pn` | Pinterest | `pinterest.com` · `pin.it` |
| `dm` | Dailymotion | `dailymotion.com` · `dai.ly` |
| `st` | Streamable | `streamable.com` |
| `im` | Imgur | `imgur.com` · `i.imgur.com` |
| `ms` | Mastodon | any instance |
| `mk` | Misskey | any instance |
| `lm` | Lemmy | any instance |
| `pt` | PeerTube | any instance |

The codes are the seventeen in `Platform` (`src/types.ts:1`), in the README's order. The canonical
url the router rebuilds fixes which site each code means (`src/router.ts`: `bluesky`, `x`, `tiktok`,
`threads`, `reddit`, `instagram`, `ytPost`, `fbCanonical`, `dmPost`, `stPost`, `IM_CANONICAL`,
`twPost`, `pnPost`; the four fediverse arms, `lmPost`, `msPost`, `mkPost` and `ptPost`, take their
host from the path instead).

### The Hosts column

That column records where a link came from. Routing never reads it.

- A short link whose code is a bare single path segment doesn't resolve here.
  `?url=https://redd.it/haucpf` and `?url=https://dai.ly/x8ocv9e` answer `ambiguous` with candidates
  `["x","ig"]` (re-measured 2026-08-12), because `/haucpf` is also the shape of an X or Instagram
  profile. The Dailymotion id here was `xaqwy7q` until that one went HTTP 410 Gone. The answer does
  not depend on the id, because the path shape decides ambiguity before anything is fetched, so both
  ids give the same `["x","ig"]`. The id was changed anyway, because a published example that 404s
  sends a reader debugging a problem that isn't there.
- The ones that do work carry their own shape, and each is resolved with the hop a pasted link gets:
  `youtu.be/dQw4w9WgXcQ` (an 11-character segment is a YouTube id outright),
  `tiktok.com/t/ZTSw2mYwR`, `reddit.com/r/{sub}/s/{code}`, and Meta's `/share/…` codes.
- `pin.it/{code}` sent whole is one of the bare ones: `?url=https://pin.it/{code}` loses its host,
  becomes `/{code}`, and gets the `["x","ig"]` chooser. Send `?url=/pin.it/{code}` instead, with the
  host moved into the path the way the fediverse sites need. That costs one hop to Pinterest's
  shortener, and the answer is the pin, with `canonical` on `www.pinterest.com/pin/{id}/`. A code that
  doesn't point to a pin answers `fetch_fail` with `platform: "pn"` and the share url as `canonical`.

## When the answer is not JSON

Every code in the [failure table](#failures) arrives inside the envelope. The answers below do not,
and `.json()` on one of them throws. Cloudflare's own edge errors are the same: 502, 520, 522, 524
and the rest come back from the proxy as HTML, and the Worker never runs.

### A path that is not exactly `/_api/v1`

`/_api/v2`, `/_api/v1/anything` and `/_api` never reach the API arm. Measured offline 2026-08-04 and
re-measured 2026-08-05, `/_api/v2?url=…` and `/_api/v1/anything?url=…` return HTTP 404 to an
ordinary client, with the body `not found\n` and exactly one header,
`content-type: text/plain;charset=UTF-8`. That header is the runtime's own default:
`src/render/index.ts:89` builds the response as `new Response('not found\n', { status: 404 })` with
no headers object, so no `cache-control` reaches the client and an intermediary applies whatever it
defaults to.

A user agent classified as Discord gets an HTML embed at HTTP 200 on the same path, with `og:title`
`Not found`, minted by the `notfound` arm's `render()` call (`src/worker.ts`) and split from the human
404 at `src/render/index.ts:87-89`. `/_api` returns an HTML chooser page at HTTP 300
(`src/render/chooser.ts:72`). Pin the path exactly. The test "/_api/v2 IS NOT SILENTLY SERVED AS v1" in
`test/api.test.mjs` refuses to serve `/_api/v2` as v1.

### An unhandled exception

- No `try`/`catch` wraps the API arm, `handle()` or the module's default `fetch` handler (verified
  by reading all three).
- Guarded per call, so that each throw becomes a normal answer: the live upstream fetch
  (`loadPost`), the three share-code and short-link resolvers (`unwrapToPost`), the mux
  (`settleMux`) and the translation (`withTranslated`). A down or blocking upstream becomes
  `fetch_fail` at HTTP 200.
- Unguarded: the post-cache read and both writes, all three inside `loadPost`, and the R2 record
  read on the YouTube path. `loadPost`'s wrap covers only the live fetch, and its comment records
  that a corrupt cache read is meant to propagate.

A throw in that last group leaves the Worker for Cloudflare's own error page: Error 1101, "Worker
threw a JavaScript exception", HTML with a 5xx status ([Cloudflare Workers
errors](https://developers.cloudflare.com/workers/observability/errors/)). Error 1102, "Worker
exceeded CPU time limit", is the other runtime code that appears. Neither is JSON.

On the Node adapter (`adapters/node/server.ts`) the same throw is HTTP 500 with a `text/plain` body,
`internal error`, and the 502 and 504 pages come from the reverse proxy in front of it. Neither is
JSON either, and the guard below covers both.

### Guarding the parse

```js
const res = await fetch(endpoint)
const type = res.headers.get('content-type') || ''
if (!type.startsWith('application/json')) {
  // 404 text/plain, a Cloudflare error page, or an edge failure. Not a contract response.
  throw new Error(`mbedfx: non-JSON ${res.status} (${type})`)
}
const body = await res.json()
if (!body.ok) { /* body.error.code */ }
```

`res.status >= 500` is not enough of a check: the plain-text 404 above is a 4xx and is not JSON.

## How long a request can take

Set the client timeout to 20 s: the 17.0 s worst case worked out below, plus roughly 3 s for
connection setup and a slower upstream. 12 s covers a client that never sends YouTube links. 5 or
10 s cuts off requests about to answer.

There is no timeout parameter and no per-step limit. One budget, taken at the top of the shared
pipeline (`describeTarget`, `src/worker.ts`), bounds the whole response and leaves each step whatever
is left. The converter preview (`/_card`) runs the same pipeline, and the two differ only in
serialisation (the test "THE API AND THE CARD DESCRIBE THE SAME POST" in `test/api.test.mjs`).

| Constant | Value | What it bounds |
|---|---|---|
| `CARD_DEADLINE_MS` (= `MUX_WAIT_API_MS`) | 9000 ms | everything after the upstream fetch; the mux wait is measured against it |
| `MUX_WAIT_FLOOR_MS` | 300 ms | the floor under that wait, leaving a spent budget time to pick up a video already in storage |
| `XLATE_MAX_WAIT_MS` | 1500 ms | the translation's share of the budget |
| `XLATE_WAIT_FLOOR_MS` | 300 ms | the floor under the translation's wait |
| `META_WAIT_API_MS` | 8000 ms | **YouTube only**: the metadata extract, awaited after the two above |
| `META_TIMEOUT_API_MS` | 8700 ms | **Dailymotion, Streamable, Imgur only**: the container metadata extract, which on the first two *is* the upstream fetch and on Imgur is the fallback behind its own API |

All six are in `src/worker.ts`. The mux and the translation race concurrently (the `Promise.all` in
`describeTarget`), costing `max(300, 9000 − elapsed)` between them rather than the sum. The YouTube
metadata warm runs after them, only when the post has no known date yet: up to 8000 ms on a first
YouTube link, and nothing after that.

**The crawler seams are not on this budget and never were.** Until 2026-08-29 this section's account
of the shared pipeline said they were, counting the Discord card as a third caller of
`describeTarget`. It is not one: the
HTML head Discord fetches is rendered by `renderPostRoute`, and the Mastodon-shaped documents behind
it are their own route. Their numbers are smaller because a crawler leaves, and they are listed here
so nobody sizes a client timeout against the wrong table.

| Constant | Value | What it bounds |
|---|---|---|
| `HTML_DEADLINE_MS` | 5000 ms | the whole crawler-facing HTML head |
| `MUX_WAIT_BOT_MS` | 1500 ms | the mux wait on the head, on the `/_oembed` callback, and on every non-YouTube activity document |
| `YT_META_BOT_MS` | 4000 ms | **YouTube only**: the metadata arm of the activity document |
| `YT_MUX_BOT_MS` | 4000 ms | **YouTube only**: the mux arm of the activity document, which is where a player is won or lost |
| `META_TIMEOUT_MS` | 4700 ms (derived) | the container metadata extract on the head, `HTML_DEADLINE_MS − MUX_WAIT_FLOOR_MS` |

The three activity-document budgets race in one `Promise.all`, so that response ends at the largest
of them plus its own serialisation, not at their sum. Both YouTube arms are 4000 ms, so YouTube's
activity document ends at about 4 s plus serialisation.

The upstream fetch is unbounded on fourteen of the seventeen platforms, and since 1.11.0 it can be
two requests rather than one. `askTwice` (`src/fetchretry.ts`) asks a second time when the first was
refused with 408, 425, 429 or a 5xx, or threw, which is the shape of a Cloudflare-egress refusal
rather than of a verdict. Every other status is an answer about the post, 404, 403 and 410 included,
so a dead link still costs exactly one request. 1.12.0 widened the retry to the YouTube oembed leg,
where a single refusal costs the vouch and leaves the card without a date, and to both Threads
fetches, which the retry lint could not see because they are `fetch(…).then(…)` inside a
`Promise.all`.

Several calls in `src/` set an `AbortSignal`, and none of them changes that count, because each
bounds one optional leg rather than the post fetch. `fetchInnertube`
(`src/platforms/youtube/innertube.ts`) caps its YouTube player-API request at
`INNERTUBE_TIMEOUT_MS`, 2500 ms shared across the two clients it tries in turn. A metadata answer
arriving after the card is drawn has nobody to take it, and releasing the connection is better than
leaving it holding the isolate. That bounds one leg, not the fetch: `fetchYouTube`
(`src/platforms/youtube/fetch.ts`) races Innertube against the oembed call in one `Promise.all`,
oembed carries no signal, and the Innertube arm is total, so a timeout there returns null and the
card is built without the date.

`src/platforms/reddit/fetch.ts` bounds four optional legs: the GIF size read
(`GIF_HEAD_TIMEOUT_MS`, 1000 ms), the caption sources (`CAPTION_BUDGET_MS`, 2000 ms), the archive
path (`ARCHIVE_PATH_BUDGET_MS`, 3000 ms) and crosspost slides (`PARENT_BUDGET_MS`, 2000 ms). The
Reddit relay call stops at `RELAY_TIMEOUT_MS`, 2500 ms (`src/platforms/reddit/relay.ts`),
Instagram's oEmbed ask for a reel's audience gate at `IG_GATE_MS`, 1500 ms
(`fetchInstagramAudienceGate` in `src/platforms/instagram/fetch.ts`), and the scheduled check's
location lookup at 2 s (`cronColo` in `src/health.ts`). Reddit's own embed page fetch carries none,
except through the relay when `REDDIT_RELAY_URL` is set. Cloudflare places no wall-clock limit on an
HTTP-triggered Worker ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
"No limit … as long as the client remains connected"). Only CPU time is capped, and this endpoint
spends almost none.

Dailymotion and Streamable are the two exceptions, because their "upstream fetch" is a `yt-dlp`
extract inside our own container rather than a request to the site. Imgur was a third until
2026-08-16, when its own JSON API took that job (`fetchImgur`, `src/platforms/imgur/fetch.ts`). The
container is still its fallback, so the bound below still applies to it. That call is bounded
because the container's own process timeout is 120 s, and a wedged instance would otherwise hold the
whole response. Past `META_TIMEOUT_API_MS` this endpoint answers `fetch_fail` for a post that may be
perfectly fine. The extract keeps running and lands in storage, so asking again a few seconds later
is the documented way to get the answer, exactly as it is for a video still muxing. Until 2026-08-12
that bound was 4700 ms, borrowed from the crawler's 5 s ceiling, and a healthy Dailymotion extract
measured 3.3 s to over 4.7 s from production, so this endpoint reported "couldn't load" about live
posts.

**Facebook makes the same container call and is not one of them.** The first version of this section
counted it as a fourth. Losing that call on Facebook is not a failure: the arm falls through to the
page and to Meta's embed-plugin fragment, and the fragment alone rendered 33 of 35 sampled post urls
on 2026-08-12 (`plugin_recovered` in `docs/METRICS.md`). Those two surfaces carry no deadline of their
own, so Facebook's answer is bounded by nothing this table names, and widening the container call
would only make the fall-through start later.

```
total ≈ upstream fetch + max(300 ms, 9000 ms − upstream fetch) + (YouTube only: up to 8000 ms)
```

An upstream answering within 8.7 s gives 9.0 s, or 17.0 s on a cold YouTube link. Slower than that,
the mux drops to its 300 ms floor and the total tracks the upstream, except on Dailymotion and
Streamable, and on Imgur when it falls through to the container, where 8.7 s is also where the answer
stops arriving at all. (This paragraph said "the four container platforms" until 2026-08-29, the same
miscount the Facebook paragraph above corrects: Facebook makes the call and is not bounded by it.)

This page quotes two measured costs, each recorded in a comment beside the code it bounds in
`src/worker.ts`: a Facebook metadata extract at ~3.0 s (2026-07-25) and a translation at 217-798 ms.

The paragraph above also used to quote two YouTube figures, a cold remux at 6-9 s (2026-07-24) and
`yt-dlp -J` at 2.3-6.7 s (2026-07-26). Both are retired from this page, not updated: they were
taken on the quarter-core container with an older yt-dlp. Extraction alone is 3.1-4.7 s on
`standard-2` now, and the production counters put a completed YouTube mux at p50 18.2 s, p90 41.3 s,
minimum 4.2 s over 139 samples, so a client timeout sized to a figure below the p10 would fail.

A post is held 900 s (`POST_TTL`, `src/cache.ts:6`) independently of the response, and a second
request skips the upstream fetch even when the first answer wasn't cacheable. `/_api/v1` never
consults the response cache, so a cold post pays the upstream fetch until that entry is warm.

## `muxing` and `pending`

Either flag means an incomplete answer, and both carry `cache-control: no-store` to keep a
half-answer out of any cache in between.

- `muxing: true`: a video is still being remuxed into the progressive MP4 mbedfx serves, and what
  arrived is its poster still. A re-request a few seconds later carries the `video` for every mux
  that finishes inline, which is most of them. This bullet once said "a few seconds" and nothing
  more, which is only right for those. A mux that does not finish inline is picked up by an alarm
  instead, first at 35 s where the source is a page and 140 s where it is separate tracks, then again
  at +2 min and +20 min (`MUX_RETRY_MS`, `src/muxpolicy.ts`). Each attempt may itself run to the
  container's wall, 360 s on a page mux. For a cold long video, expect minutes rather than seconds.
- `pending: true`: a translation lost its race and `text` is the original. The translation is still
  being written, and a re-request carries it. `pending` is also set when a Reddit link post's linked
  post (see [Media urls](#media-urls)) did not load in time, or came back empty without a private or
  age-restricted wall, and `media` is empty for now; a re-request asks for it again. That case is the
  one exception to "both clear on their own" below: a linked post that is gone for good cannot be
  told from one that failed once, so it keeps `pending` set. Ask again once, not in a loop. It is
  also set when a Reddit post loaded with a part Reddit did not answer for: a crosspost's video
  poster or gallery slides (`media` is empty for now), or Reddit's stripped render (no body, author
  or counts), which a link without the post's own subreddit gets when the second ask, under that
  subreddit, failed. Nothing of that answer is cached, so a re-request asks again.

Neither is an error. Both clear on their own, and an answer that ignores them is still correct. The
work behind them runs in two different places, which sets the horizons above. A translation runs on
`ctx.waitUntil`, which Cloudflare cancels 30 s after the response, while a mux is handed to a Durable
Object alarm (`MuxRunner`, `src/muxrunner.ts`) and gets fifteen minutes. That alarm is armed before
the race rather than after it, because the videos needing longer than the `waitUntil` ceiling are
exactly the ones it exists for. (This paragraph said `waitUntil` for both until 2026-08-29, which is
the mis-statement the alarm was written to fix.) The test "AN INCOMPLETE ANSWER IS NEVER CACHED" in
`test/api.test.mjs` asserts the `no-store` on an incomplete answer and a `public, max-age` on a
complete one. The 900 in that max-age is `RESP_TTL`, which `test/openapi.test.mjs` derives.

These are Cloudflare's limits. On the Node adapter, `waitUntil` work runs until it settles and the
mux alarm is a timer in the adapter's own process (`docs/SELF-HOSTING.md`). The flags mean the same
thing there, and the horizon can be longer or shorter.

## Failures

```json
{
  "ok": false,
  "error": {
    "code": "age_restricted",
    "message": "That post is age-restricted, so it cannot be read without an account.",
    "platform": "x",
    "canonical": "https://x.com/i/status/1799212343123456789"
  }
}
```

Branch on `ok` and `error.code`, never on the HTTP status. Every answer about a post is `200`,
including the ones saying it can't be read; the `4xx`s are about the request itself. Several
platforms mbedfx reads answer `200` with a login wall, or `500` with a good JSON error. Match on
`code`, because `message` is prose for humans and may be reworded.

| `code` | Status | Means |
|---|---|---|
| `age_restricted` | 200 | The post exists behind an age gate. |
| `private` | 200 | The post exists behind a private account or a login wall. |
| `fetch_fail` | 200 | Not loadable: deleted, or the platform did not answer. |
| `ambiguous` | 200 | The path belongs to more than one site. Carries `candidates`. A bare handle (`/{handle}`, `/@{handle}`) and an unrecognised one-segment path land here, because a handle names an account on more than one site and picking one would be a guess. |
| `notfound` | 200 | A shape mbedfx routes for nobody, including a site prefix forced onto a path that site does not claim (`/x/jack`) and `/_prep` or `/_card` without their own `p` parameter. |
| `bad_id` | 200 | A Mastodon-spoof-shaped path (`/users/{handle}/statuses/{id}`, `/api/v1/statuses/{id}`, `/_oembed/{id}`) whose id did not decode. Not reachable from an ordinary post url. |
| `not_a_post` | 200 | Routes to something that is not a post: a site page (`/`, `/index.html`, `/robots.txt`), one of this service's own endpoints (`/_media/…`, `/_prep?p=…`, `/_card?p=…`, `/_api/v1`), a profile url (see below), or a Meta or Reddit share code that did not resolve to one. A TikTok `/t/{code}` never lands here (see below), and neither does a `/pin.it/{code}`, which answers `fetch_fail` when it names no pin. |
| `no_url` | 400 | No `url` parameter, or an empty one. `?url=` and no `url=` at all get the same answer. |
| `unparseable` | 400 | `new URL(target, origin)` threw, `origin` being the origin the request arrived on. Only a malformed absolute url does that. Anything readable as a path resolves against that origin and gets a 200 instead. |
| `method_not_allowed` | 405 | This endpoint reads. Use `GET`. |

`platform` and `canonical` carry real values on `age_restricted`, `private` and `fetch_fail`, and
are `null` whenever the request didn't get far enough to establish them. They are never guessed.
Until 2026-08-04 (`3a2406f`) both were absent on `no_url`, `unparseable` and `method_not_allowed` and
`null` on every other code; `apiError` defaults them to `null` now (`apiError`, `src/worker.ts`).

`candidates` appears on `ambiguous` and nowhere else.

No failure is cached, not even `private`: accounts go public, gates lift, and a deleted post can
come back as somebody's repost.

#### A TikTok `/t/{code}` answers what it renders

A short code names no post until a network hop resolves it, and that hop has four outcomes. Each one
is answered here with the code that matches the card the same url draws, so one post does not get
two answers depending on which url shape was pasted.

| The resolution | This endpoint answers | `platform` / `canonical` |
|---|---|---|
| The post, resolved | the post | the post's |
| Private or age-restricted | `private` / `age_restricted` | `tt`, the share url |
| TikTok claims the code and cannot serve it | `fetch_fail` | `tt`, the share url |
| TikTok does not claim the code | `ambiguous`, `candidates: ["tt","th"]` | absent |

`canonical` is the share url on the middle two rows because it is the only url that exists before a
code resolves: a deleted post has no id to build a permalink out of, and `/t/{code}` is a real link
that lands on TikTok's own "video currently unavailable" page.

The last row is `ambiguous` rather than a dead end because `tiktok.com/t/` and `threads.com/t/` are
the same path on two different products, so a code TikTok disclaims may well be Threads'. The render
arm has offered that chooser since the route was written.

All four rows used to answer `not_a_post`. The walls were corrected on 2026-08-11 and the other two
rows on 2026-08-12, each after measuring the same code through both surfaces. On a walled code that
answer was a false statement about a post that demonstrably exists, and one the render path never
made.

### Profile urls

`/profile/{handle}` renders a Bluesky profile card, and this endpoint answers it `not_a_post`. This
is a deliberate boundary: a profile is an account, not a post, so it carries no `text`, no
`createdAt` and none of the four engagement counts this endpoint publishes. Serving one through the
post payload would mean either omitting most of it or filling those fields with values nobody
measured.

Every other profile url (`x.com/{handle}`, `instagram.com/{handle}`, `tiktok.com/@{handle}`) is
`ambiguous` or `notfound`, unchanged: a bare handle names an account on more than one site, so the
router does not resolve it at all. A profile payload will be a versioned addition when there is a
second platform to shape it around.

### What common inputs return

Measured offline 2026-08-04 and re-driven 2026-08-05. Every row but the last two answers `200`
`ambiguous`.

| Sent | `candidates` | Why |
|---|---|---|
| a bare handle: `?url=jack` | `["x","ig"]` | one path segment; both mint profiles at that shape |
| a profile url: `?url=https://x.com/jack` | `["x","ig"]` | the host is ignored; same request as above |
| a TikTok or Threads profile: `?url=https://www.tiktok.com/@charlidamelio` | `["tt","th"]` | the `@` narrows it to the two sites that use one |
| junk: `?url=not a url at all`, `?url=:::not-a-url`, `?url=javascript:alert(1)` | `["x","ig"]` | one unrecognised segment each: `/not%20a%20url%20at%20all`, `/:::not-a-url`, `alert(1)` (`javascript:` parses fine as an absolute url). A source comment claimed `notfound` for the middle one until 2026-08-04 (the test "EVERY ANSWER ABOUT A POST IS 200, INCLUDING THE GATES" in `test/api.test.mjs`) |
| an empty url: `?url=` | `400` `no_url` | the empty string is falsy and takes the missing-parameter branch |
| a malformed absolute url: `?url=http://[` | `400` `unparseable` | `new URL` throws. `https://` and `http://:` are the other spellings that do |

### `ambiguous`

```json
{
  "ok": false,
  "error": {
    "code": "ambiguous",
    "message": "That path belongs to more than one site. Re-ask with a two-letter site prefix, e.g. /im/gallery/YcAQlkx.",
    "platform": null,
    "canonical": null,
    "candidates": ["rd", "im"]
  }
}
```

`/gallery/YcAQlkx` could be Reddit or Imgur, and is the case the code was built for.
Re-ask with the site code in front of the path:

```
?url=/im/gallery/YcAQlkx
```

At 1.9.0's review that message read `/im/gallery/abc`. `?url=/im/gallery/abc` answers `notfound`
(Imgur ids run five characters or more), so a caller following it verbatim reached the same dead
end twice (`apiFailure`, `src/worker.ts`).

`candidates` is which sites claim that path shape; whether one accepts that id is a second question.
`?url=/im/gallery/abc` above shows the difference: Imgur has the shape and refuses the id.
`?url=/rd/gallery/abc` gets the Reddit post that `?url=/comments/abc` gets. Expect a few
`notfound`s while walking the list, and take the first success. On a profile
url every candidate answers `notfound` (`?url=/x/jack` → `notfound`, verified 2026-08-05). There is
no bare-handle profile route, because a bare handle names an account on more than one site, so a
forced site prefix has nothing to resolve to. `/profile/{handle}` is a different shape and does
route; see "Profile urls" above.

A hostname never breaks the tie, even though it usually could. A hostname here is a thing the Worker
fetches (the fediverse arm turns one into a request), and `src/refkey.ts` states outright that
Cloudflare is not relied on to block private addresses. The prefix names one of the seventeen codes
and nothing else.

## Caching and limits

A complete answer is sent `cache-control: public, max-age=900` (`RESP_TTL`, `src/cache.ts:7`), and an
incomplete one `no-store` (the `api` arm), as is every failure envelope (`apiError`).

`src/` holds no API key, no quota and no rate limiting. Any limit on the public instance is a zone
rule in the Cloudflare dashboard, which the source cannot see. A fork inherits none of it: put
something in front of a self-hosted instance before pointing traffic at it, and read
`docs/SELF-HOSTING.md` first. A cold request pays the whole budget in
[How long a request can take](#how-long-a-request-can-take). Repeating one url is free
while its post is warm, so space out distinct ones.

## Stability

`/_api/v2` is never answered with v1, and an unrecognised path gets the plain-text 404
([above](#when-the-answer-is-not-json)). Within `v1`:

- Fields will be added, never removed or retyped.
- `error.code` values will be added; existing ones keep their meaning.
- `error.message` wording may change. Do not match on it.
- Two-letter platform codes are stable.

Four things are absent from v1, and each would be additive if it landed later: media on a quoted post
(see [`quote`](#quote)), an opt-in translation parameter, profile lookups, and batch requests.
