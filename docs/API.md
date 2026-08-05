# The JSON API

`/_api/v1` serves the post data the cards are drawn from, as JSON. Shipped in 1.9.0
(`docs/CHANGELOG.md`, 2026-08-04).

```
GET https://mbedfx.app/_api/v1?url=<the post url>
```

No key, no signup, no required headers. Every answer carries `access-control-allow-origin: *` and
`x-content-type-options: nosniff` (`apiHeaders`, `src/worker.ts:3008`), so a page can call it from
script.

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

It answers for the thirteen single-host sites the cards cover, plus short links and share codes. The
four fediverse platforms need the request form [below](#mastodon-misskey-lemmy-and-peertube).

`GET` and `HEAD` are answered. `OPTIONS` returns `204` with
`access-control-allow-methods: GET, HEAD, OPTIONS`, `access-control-allow-headers: *` and
`access-control-max-age: 86400`, before any work is spent (`src/worker.ts:3894`); every other method
is `405` `method_not_allowed` (`3905`). 1.9.0's review had neither branch: a preflight paid for an
upstream fetch, a mux wait and a `yt-dlp -J`, then failed for want of
`access-control-allow-methods`.

---

## The request

One parameter, `url`, carrying the whole original link. Percent-encode it, or a raw `?` or `&` in
the post url ends the parameter early.

The host is ignored: routing reads the path and the query, so `https://x.com/jack/status/20`,
`https://mbedfx.app/jack/status/20` and `?url=/jack/status/20` are one request. Some paths belong to
more than one site, and the host does not break the tie ([`ambiguous`](#ambiguous)).

### Mastodon, Misskey, Lemmy and PeerTube

Those four have no single host. The instance is part of the post's identity, and routing ignores the
host, so sending the whole url loses it:

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

`test/link-hygiene.test.mjs:71-74` drives those four through the router, with ids from
`test/fixtures/`. The cards mint the same shape: `https://mbedfx.app/lemmy.world/post/49966212`.

---

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

### Field by field

`post` comes from `toApiPost` (`src/worker.ts:3105-3171`), the envelope from the arm wrapping it
(`3932-3939`). Input answers were driven offline through `route()` and `handle()` on 2026-08-04, and
again 2026-08-05.

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
| `author` | object | no |
| `author.name` | string | **yes** |
| `author.handle` | string | **yes** |
| `author.url` | string | **yes** |
| `author.avatar` | string, absolute url on the mbedfx origin | **yes** |
| `counts` | object | no |
| `counts.likes` | integer > 0 | no |
| `counts.reposts` | integer > 0 | no |
| `counts.replies` | integer > 0 | no |
| `counts.views` | integer > 0 | no |
| `media` | array of objects | no |
| `media[].kind` | string, `"video"` or `"image"` | no |
| `media[].url` | string, absolute url on the mbedfx origin | no |
| `media[].poster` | string, absolute url on the mbedfx origin | **yes** |
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

Every key there is always present except the four under `counts`, **omitted when unknown** and the
only place an absent key carries meaning. With nothing to report, `title` is `null` where `text` is
`""`, `counts` is `{}` and `media` is `[]`; the `quote.*` keys are present whenever `quote` is an
object.

### `createdAt`

Some platforms publish no post date, and for others it arrives on a second, slower call. A Post
without one holds `new Date(0)`, which `/_card` draws as `"1970-01-01T00:00:00.000Z"` beside a
`⚠ no upload date` note and `src/worker.ts:3117` sends as `null`. Sort a `null` as unknown, never as
old (`test/api.test.mjs:142`).

### `counts`

`apiCounts` (`src/worker.ts:3079-3086`) copies `likes`, `reposts`, `replies` and `views` only for a
finite number above zero, so a key exists only when the count is known. A `0` reaches that filter
from a post nobody has touched and from a count the platform withholds (a hidden like count, a video
with comments switched off), and the filter cannot tell them apart. An absent key means unknown, v1
has no encoding for a count known to be zero, and which of the four keys exist varies by site.

### `text`

`text` is what the card shows, with the card's overlays composed in. v1 gives none of them a
structured field of its own:

- a translation, followed by a `🌐 Translated from …` marker and then the original text;
- `🔞 Age-restricted on …` on a gated YouTube video (`sensitive` is also `true`);
- `🎬 Too long to play here — open it on …` on a video past the length ceiling for a remux.

v1 has no field carrying the author's untouched words. Splitting them out is additive, and it's on
the list.

`deserializePost` validates the ref, the canonical and the date and nothing else, so `text` goes out
through `str()` (`src/worker.ts:3129`). A cached value of the wrong type is published as `""`, never
verbatim (`test/api.test.mjs:497`).

### `width` and `height`

`0` is far more common than `null`. Reddit, TikTok covers, Threads, Facebook galleries and every
remuxed video emit `0` for a size the platform did not report. A remux carries `w: 0, h: 0` so a
player reads the real dimensions out of the file. `null` happens only when the cached value wasn't a
finite number at all (`num`, `src/worker.ts:3089`). Both mean unknown, so don't divide by either.

The pair describes the bytes at `url`, not the original video. The values are `posterW ?? w` and
`posterH ?? h` (`src/worker.ts:3149-3150`), so a `still` entry reports the poster frame's size. Both
gained their rows above on 2026-08-04 (`3a2406f`).

### `media`

`media` drops any entry with no servable url. The rest keep their position in the unfiltered array
(`usableWithIndex`, `src/worker.ts:2998`), which is the index `/_media/` resolves against; taking
the position after the filter publishes entry N at entry N+1's bytes, or a 404 past the end, and
`test/api.test.mjs:372` pins that off-by-one. A degraded still is then addressed through its poster
slot, never through that bare number (`bytesIndex`, `src/render/embed.ts:52`): the still lives in
the poster slot while the bare index goes on naming the video entry, which answers `503`. `kind`
collapses the three values of `Media.kind` (`src/types.ts:229`) to two, and a `gif` is published as
`"video"` (`src/worker.ts:3140`).

### `still`

A video that hasn't finished muxing, or one too long to mux at all, is published as an `image` entry
carrying `still: true`. `url` and `poster` are both the poster frame, where the bytes are. Read it
with the top-level `muxing` flag:

| `still` | `muxing` | Meaning |
|---|---|---|
| `false` | `false` | An ordinary picture. |
| `true` | `true` | A video is still muxing. Ask again in a few seconds. |
| `true` | `false` | A video exists that cannot be served, usually because it is too long. This is final. |

Without `still`, that last row is indistinguishable from an ordinary photo except by reading the
English in `text`.

### `quote`

`quote` is `null` unless the quoted post carries an author object (`src/worker.ts:3167`); the
normalizers cap depth at 1, so `quote.quote` is always absent. `quote.author` has no `avatar`, and
`quote` has no `media`. Those entries live at indices after the outer post's in `mediaList`, and
getting that arithmetic wrong publishes urls that resolve to the wrong bytes.

### Media urls

Every url in the payload is on `mbedfx.app`, never the platform's CDN, which hands out signed,
short-lived and sometimes IP-locked urls. An mbedfx url carries no expiry, so they're safe to store.

Remuxed video comes from R2 and answers range requests, so a player can seek. Images, avatars,
posters and already-progressive video get a `302` to the CDN under
`cache-control: public, max-age=300` (`MEDIA_MAX_AGE`, `src/cache.ts:8`), and the mbedfx url stays
valid as the destination changes. Past that hop, range support and reachability belong to the
platform. Instagram and Twitch video is proxied instead (`src/worker.ts:3451-3457`).

### The `d.` host

`d.` in front of either official host serves the file itself, the video or the image, at its own
url: `https://d.mbedfx.app/jack/status/20`, `https://d.megapenispoopenfarten.sex/jack/status/20`.
Those bytes answer range requests, so a client seeks and resumes properly. A `d.` url renders no
card, and a crawler and a person are served the same bytes from it.

With nothing to serve, `d.` answers a plain-text 404. An HTML body in that slot leaves a downloader
holding a file full of markup. `media_miss` on this host means the post has no usable media at all,
a second meaning `docs/METRICS.md` records under "Known defects in the write shape"
(`src/worker.ts:3346`).

---

## The seventeen platform codes

`platform` is the two-letter code. `tw` is Twitch, Twitter is `x`, and the two sit next to each
other in every list in this repo.

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
| `tw` | **Twitch** | `twitch.tv` · `clips.twitch.tv` |
| `pn` | Pinterest | `pinterest.com` |
| `dm` | Dailymotion | `dailymotion.com` · `dai.ly` |
| `st` | Streamable | `streamable.com` |
| `im` | Imgur | `imgur.com` · `i.imgur.com` |
| `ms` | Mastodon | any instance |
| `mk` | Misskey | any instance |
| `lm` | Lemmy | any instance |
| `pt` | PeerTube | any instance |

The order is the README's, and the codes are the seventeen in `Platform` (`src/types.ts:1`). The
canonical url the router rebuilds fixes which site each one means (`src/router.ts`: `bs` 197, `x`
205/210, `tt` 240, `th` 357, `rd` 387, `ig` 414, `yt` 435, `fb` 489-499, `dm` 651, `st` 672, `im`
698-700, `tw` 845/852/858, `pn` 1078; the four fediverse arms at 895/971/1011/1038 take their host
from the path instead).

### The Hosts column

That column records where a link came from, and routing never reads it.

- A short link whose code is a bare single path segment doesn't resolve here.
  `?url=https://redd.it/haucpf` and `?url=https://dai.ly/xaqwy7q` answer `ambiguous` with candidates
  `["x","ig"]`, measured 2026-08-05: `/haucpf` is also the shape of an X or Instagram profile.
- The ones that do work carry their own shape: `youtu.be/dQw4w9WgXcQ` (an 11-character segment is a
  YouTube id outright), `tiktok.com/t/ZTSw2mYwR`, `reddit.com/r/{sub}/s/{code}`, and Meta's
  `/share/…` codes. Each is resolved with the hop a pasted link gets.

---

## When the answer is not JSON

Every code in the [failure table](#failures) arrives inside the envelope; the answers in this
section don't, and `.json()` on one of them throws. Cloudflare's own edge errors are the same: 502,
520, 522, 524 and friends come back from the proxy as HTML, without the Worker running at all.

### A path that is not exactly `/_api/v1`

`/_api/v2`, `/_api/v1/anything` and `/_api` never reach the API arm. Measured offline 2026-08-04 and
re-measured 2026-08-05: `/_api/v2?url=…` and `/_api/v1/anything?url=…` return HTTP 404 to an
ordinary client, body `not found\n`, carrying exactly one header,
`content-type: text/plain;charset=UTF-8`. That header is the runtime's own default:
`src/render/index.ts:51` builds the response as `new Response('not found\n', { status: 404 })` with
no headers object, so no `cache-control` reaches the client and an intermediary applies whatever it
defaults to. A user agent classified as Discord gets an HTML embed at HTTP 200 on the same path,
`og:title` `Not found`, minted by the `notfound` arm's `render()` call (`src/worker.ts:3377`) and
split from the human 404 at `src/render/index.ts:49-53`. `/_api` returns an HTML chooser page at
HTTP 300 (`src/render/chooser.ts:72`). Pin the path exactly; `test/api.test.mjs:524` refuses to
serve `/_api/v2` as v1.

### An unhandled exception

Line numbers below are `src/worker.ts`.

- No `try`/`catch` wraps the API arm, `handle()` (`3358`) or the module's `fetch` handler
  (`4226-4236`) — verified by reading all three.
- Guarded per call, each turning a throw into a normal answer: the live upstream fetch (`loadPost`,
  `2532-2536`), the three share-code and short-link resolvers (`unwrapToPost`, `2819-2851`), the mux
  (`1485`), the translation (`2709`). A down or blocking upstream becomes `fetch_fail` at HTTP 200
  there.
- Unguarded: the post-cache read and write (`2520-2523`, `2542`, `2558`) and the R2 record read on
  the YouTube path. `loadPost`'s wrap covers only the live fetch, and its comment records that a
  corrupt cache read is meant to propagate.

A throw in that last group leaves the Worker, and Cloudflare answers with its own error page: Error
1101, "Worker threw a JavaScript exception", HTML with a 5xx status ([Cloudflare Workers
errors](https://developers.cloudflare.com/workers/observability/errors/)). Error 1102 ("Worker
exceeded CPU time limit") is the other runtime code that can appear. Neither page is JSON.

### Guarding the parse

Confirm the response is JSON before you parse it, then branch on `ok` and `error.code`:

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

Checking `res.status >= 500` isn't enough. The plain-text 404 above is a 4xx and still isn't JSON.

---

## How long a request can take

There's no timeout parameter and no per-step limit. One budget is taken at the top of the shared
pipeline (`describeTarget`, `src/worker.ts:2881`), bounds the whole response, and leaves each step
whatever is left of it.

| Constant | Value | What it bounds |
|---|---|---|
| `CARD_DEADLINE_MS` (= `MUX_WAIT_API_MS`) | **9000 ms** (`1345`, `1359`) | everything after the upstream fetch: the deadline the mux wait is measured against |
| `MUX_WAIT_FLOOR_MS` | **300 ms** (`1344`) | the floor under that wait, so a spent budget still leaves time to pick up a video already in storage |
| `XLATE_MAX_WAIT_MS` | **1500 ms** (`2665`) | the translation's share of the budget |
| `XLATE_WAIT_FLOOR_MS` | **300 ms** (`2651`) | the floor under the translation's wait |
| `META_WAIT_API_MS` | **8000 ms** (`2316`) | **YouTube only**: the metadata extract, awaited after the two above |

All five are in `src/worker.ts`. The mux and the translation race concurrently (`2932-2940`),
costing `max(300, 9000 − elapsed)` between them and not the sum. The YouTube metadata warm runs
after them (`2960-2975`), only when the post has no known date yet. It adds up to 8000 ms on a first
request for a YouTube link and nothing thereafter.

The upstream fetch itself is unbounded. Nothing in `src/` sets an `AbortSignal` (verified by grep),
and Cloudflare places no wall-clock limit on an HTTP-triggered Worker ([Workers
limits](https://developers.cloudflare.com/workers/platform/limits/): "No limit … as long as the
client remains connected"). Only CPU time is capped, and this endpoint spends almost none of it.

```
total ≈ upstream fetch + max(300 ms, 9000 ms − upstream fetch) + (YouTube only: up to 8000 ms)
```

An upstream answering within 8.7 s gives 9.0 s, or 17.0 s on a cold YouTube link. Slower than that,
the mux drops to its 300 ms floor and the total tracks the upstream. Set the client timeout to 20 s:
the 17.0 s worst case plus roughly 3 s for connection setup and a slower upstream. 12 s covers a
client that never sends YouTube links, and at 5 or 10 s a client cuts off requests that were about
to answer.

Measured, all in `src/worker.ts`: a cold video remux is 6-9 s at ≤480p (`1313`, 2026-07-24),
`yt-dlp -J` on YouTube is 2.3-6.7 s over five runs (`2299`, 2026-07-26), a Facebook metadata extract
is ~3.0 s (`1508`, 2026-07-25), and a translation is 217-798 ms (`2924`).

The post is cached for 900 s (`POST_TTL`, `src/cache.ts:5`) independently of the response, so a
second request skips the upstream fetch even when the first answer wasn't cacheable. `/_api/v1`
never consults the response cache, only the post cache, and a cold post pays the upstream fetch
until that entry is warm.

---

## `muxing` and `pending`

Either flag means an incomplete answer, and both carry `cache-control: no-store` to keep a
half-answer out of any cache in between.

- `muxing: true`: a video is still being remuxed into the progressive MP4 mbedfx serves, and what
  arrived is its poster still. A re-request in a few seconds returns a `video`.
- `pending: true`: a translation lost its race and `text` is the original. The translation is still
  being written, and a re-request carries it.

Neither is an error, and both clear on their own, the work behind each running on in `waitUntil`.
Ignore them and the answer is still correct, just less complete. `test/api.test.mjs:288` asserts the
`no-store`, `317` the `max-age=900` on a complete answer.

---

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

Confirm the reply is JSON ([above](#when-the-answer-is-not-json)), then branch on `ok` and
`error.code`, never on the HTTP status. Every answer about a post is `200`, including the ones
saying it can't be read. The `4xx`s are about the request itself: `400` for a missing or unreadable
`url`, `405` for a write verb. Several platforms mbedfx reads answer `200` with a login wall or
`500` with a perfectly good JSON error. Match on `code`; `message` is prose for humans and may be
reworded.

| `code` | Status | Means |
|---|---|---|
| `age_restricted` | 200 | The post exists behind an age gate. |
| `private` | 200 | The post exists behind a private account or a login wall. |
| `fetch_fail` | 200 | Could not be loaded — deleted, or the platform did not answer. |
| `ambiguous` | 200 | That path belongs to more than one site. Carries `candidates`. Every profile url, bare handle and unrecognised one-segment path also lands here, as described below. |
| `notfound` | 200 | The path has a shape mbedfx routes for nobody. |
| `bad_id` | 200 | A Mastodon-spoof-shaped path (`/users/{handle}/statuses/{id}`, `/api/v1/statuses/{id}`, `/_oembed/{id}`) whose id did not decode. Not reachable from an ordinary post url. |
| `not_a_post` | 200 | The path routes to something that is not a post: a site page (`/`, `/index.html`), one of this service's own endpoints (`/_media/…`, `/_prep`, `/_card`, `/_api/v1`), or an internal route kind that is not named here. |
| `no_url` | 400 | No `url` parameter, **or an empty one**. `?url=` and no `url=` at all are the same answer. |
| `unparseable` | 400 | `new URL(target, origin)` threw, with `origin` the mbedfx origin. Only a malformed **absolute** url does that. Anything that can be read as a path resolves against that origin and gets a 200 answer instead. |
| `method_not_allowed` | 405 | This endpoint reads. Use `GET`. |

`platform` and `canonical` carry real values on `age_restricted`, `private` and `fetch_fail`, and
are `null` whenever the request didn't get far enough to establish them; they are never guessed.
`candidates` appears on `ambiguous` and nowhere else. Until 2026-08-04 (`3a2406f`) both were absent
on `no_url`, `unparseable` and `method_not_allowed` and `null` on every other code — one envelope,
two shapes, and this document described one. `apiError` defaults them to `null` now
(`src/worker.ts:3020-3028`).

No failure is cached, not even `private`, since accounts go public and gates lift and a deleted post
can come back as somebody's repost.

### What common inputs return

Measured offline 2026-08-04, re-driven 2026-08-05:

| Sent | Answer | Why |
|---|---|---|
| a bare handle — `?url=jack` | `200` `ambiguous`, `candidates: ["x","ig"]` | one path segment, and both X and Instagram mint profiles at that shape |
| a profile url — `?url=https://x.com/jack` | `200` `ambiguous`, `candidates: ["x","ig"]` | the host is ignored, so this is the same request as the line above |
| a TikTok or Threads profile — `?url=https://www.tiktok.com/@charlidamelio` | `200` `ambiguous`, `candidates: ["tt","th"]` | the `@` narrows it to the two sites that use one |
| a junk string — `?url=not a url at all` | `200` `ambiguous`, `candidates: ["x","ig"]` | it resolves to the one-segment path `/not%20a%20url%20at%20all` |
| `?url=:::not-a-url` | `200` `ambiguous`, `candidates: ["x","ig"]` | one unrecognised segment, the chooser's own shape; a source comment claimed `notfound` until 2026-08-04 (`test/api.test.mjs:233-249`) |
| `?url=javascript:alert(1)` | `200` `ambiguous`, `candidates: ["x","ig"]` | `javascript:` parses fine as an absolute url; its path is `alert(1)`, one segment |
| an empty url — `?url=` | `400` `no_url` | the empty string is falsy, so it takes the missing-parameter branch |
| a malformed absolute url — `?url=http://[` | `400` `unparseable` | `new URL` throws. `https://` and `http://:` are the other spellings that do |

That `:::not-a-url` row read `notfound` in this file too, copied from the comment.

`/gallery/YcAQlkx` is the case `ambiguous` was built for; a handle or a typo lands there too,
nothing in one unrecognised segment narrowing it. The code says only that the shape belongs to more
than one site and none has been asked. Walk the candidates on a contested path; on a profile url
every one answers `notfound`, there being no profile route (`?url=/x/jack` → `notfound`, verified
2026-08-05).

### `ambiguous`

```json
{
  "ok": false,
  "error": {
    "code": "ambiguous",
    "message": "That path belongs to more than one site. Re-ask with a two-letter site prefix, e.g. /im/gallery/YcAQlkx.",
    "platform": null,
    "canonical": null,
    "candidates": ["rd", "ig", "im"]
  }
}
```

`/gallery/YcAQlkx` could be Reddit, Instagram or Imgur. Re-ask with the site code in front of the
path:

```
?url=/im/gallery/YcAQlkx
```

That message read `/im/gallery/abc` during 1.9.0's review. `?url=/im/gallery/abc` answers
`notfound`, Imgur ids running five characters or more, so a caller following it verbatim reached the
same dead end twice (`src/worker.ts:3053-3056`).

`candidates` is which sites claim that path shape; whether one accepts that id is a second question.
`/rd/gallery/…` is the clearest case, Reddit's own gallery links being deprecated upstream and
deliberately unrouted. Expect a few `notfound`s while walking the list, and take the first success.

The host in a caller's `url` never breaks the tie, even though it usually could. A hostname here is
a thing the Worker fetches: the fediverse arm turns one into a request. `src/refkey.ts` states
outright that Cloudflare is not relied on to block private addresses. The two-letter prefix can only
name one of the seventeen codes above.

---

## Caching and limits

A complete answer is sent `cache-control: public, max-age=900` (`RESP_TTL`, `src/cache.ts:6`), so a
cache in front of the caller can absorb repeats. An incomplete answer is `no-store`
(`src/worker.ts:3939`), and so is every failure envelope (`3020-3028`).

`src/` holds no API key, no quota and no rate limiting. Any limit on the public instance is a zone
rule in the Cloudflare dashboard, which the source cannot see. A fork inherits none of it: put
something in front of a self-hosted instance before pointing traffic at it, and read
`docs/SELF-HOSTING.md` first.

A cold request costs the upstream fetch, the video remux and the translation, out of the same budget
the cards draw from: 9000 ms, or 17.0 s on a first YouTube link. A warm post is free for 900 s
(`POST_TTL`, `src/cache.ts:5`), so repeat one url as often as you like and space out distinct ones.

---

## Stability

`v1` is in the path so it shows up in a url pasted into a bug report, and `/_api/v2` is never
answered with v1. An unrecognised path is the plain-text 404
([above](#when-the-answer-is-not-json)).

Within `v1`:

- Fields will be **added**, never removed or retyped.
- `error.code` values will be added; existing ones keep their meaning.
- `error.message` wording may change. Do not match on it.
- Two-letter platform codes are stable.

Not in v1, and each is additive if it lands later: media on a quoted post (see [`quote`](#quote)),
an opt-in translation parameter, profile lookups, and any form of batch request.

---

## What this is built on

The card, the converter preview and this endpoint share one pipeline: teaching one surface what its
twin never learns is the defect this project repeats most. `describeTarget` (`src/worker.ts:2881`)
fetches the post, waits for the video and the translation and applies the per-platform overlays; the
three differ only in serialisation (`test/api.test.mjs:325`).
