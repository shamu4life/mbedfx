# The JSON API

`/_api/v1` serves the post data the cards are drawn from, as JSON.

```
GET https://mbedfx.app/_api/v1?url=<the post url>
```

No key, no signup, no required headers. CORS is open to any origin, so a page can call the endpoint
from script.

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

It answers for the thirteen single-host sites the cards cover, and for short links and share codes.
The four fediverse platforms need a different request form, described under
[Mastodon, Misskey, Lemmy and PeerTube](#mastodon-misskey-lemmy-and-peertube).

Methods: `GET` and `HEAD`. `OPTIONS` is answered as a CORS preflight without running anything.
Anything else is `405`.

---

## The request

One parameter, `url`, carrying the whole original link. Percent-encode it, or a raw `?` or `&` in the
post url ends the parameter early.

The host in that url is ignored. Routing reads the path and the query, so
`https://x.com/jack/status/20` and `https://mbedfx.app/jack/status/20` are the same request, and a
bare path (`?url=/jack/status/20`) works too. Some paths belong to more than one site, and the host
doesn't break the tie. See [`ambiguous`](#ambiguous).

### Mastodon, Misskey, Lemmy and PeerTube

Those four have no single host. The instance is part of the post's identity, and routing ignores the
host, so sending the whole url loses it:

```
?url=https://lemmy.world/post/123456        ->  notfound
?url=/lemmy.world/post/123456               ->  the post
```

Move the instance into the path and drop the scheme:

| Site | Send |
|---|---|
| Mastodon | `?url=/mastodon.social/@Gargron/109384049300000000` |
| Misskey | `?url=/misskey.io/notes/9abcdefghi` |
| Lemmy | `?url=/lemmy.world/post/123456` |
| PeerTube | `?url=/tilvids.com/w/abcdefghijklmnop` |

The cards use the same shape: a swapped fediverse link reads
`https://mbedfx.app/lemmy.world/post/123456`.

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

Every key listed below is always present, and a value that can be missing is spelled `null`, `""`, or
an empty object or array. `counts` is the one exception, and the only place an absent key carries
meaning.

The `post` fields come from `toApiPost` (`src/worker.ts:3105-3171`), the envelope from the API arm
that wraps it (`src/worker.ts:3932-3939`). Everything below about what an input returns was driven
offline through `route()` and `handle()` on 2026-08-04.

### The envelope

| Field | Type | Nullable | Always present |
|---|---|---|---|
| `ok` | boolean | no | yes — `true` on this shape, `false` on a failure envelope |
| `muxing` | boolean | no | yes |
| `pending` | boolean | no | yes |
| `post` | object | no | yes when `ok` is `true`; absent when `ok` is `false` |

### `post`

| Field | Type | Nullable | Always present |
|---|---|---|---|
| `platform` | string, one of the seventeen two-letter codes | no | yes |
| `canonical` | string, absolute url | no | yes |
| `createdAt` | string, ISO 8601 UTC | **yes** | yes |
| `title` | string | **yes** | yes — `null` rather than `""` when there is none |
| `text` | string | no | yes — `""` when there is none |
| `sensitive` | boolean | no | yes |
| `author` | object | no | yes |
| `author.name` | string | **yes** | yes |
| `author.handle` | string | **yes** | yes |
| `author.url` | string | **yes** | yes |
| `author.avatar` | string, absolute url on the mbedfx origin | **yes** | yes |
| `counts` | object | no | yes — may be `{}` |
| `counts.likes` | integer > 0 | no | **no — key omitted when unknown** |
| `counts.reposts` | integer > 0 | no | **no — key omitted when unknown** |
| `counts.replies` | integer > 0 | no | **no — key omitted when unknown** |
| `counts.views` | integer > 0 | no | **no — key omitted when unknown** |
| `media` | array of objects | no | yes — may be `[]` |
| `media[].kind` | string, `"video"` or `"image"` | no | yes |
| `media[].url` | string, absolute url on the mbedfx origin | no | yes |
| `media[].poster` | string, absolute url on the mbedfx origin | **yes** | yes |
| `media[].width` | number | **yes** | yes |
| `media[].height` | number | **yes** | yes |
| `media[].still` | boolean | no | yes |
| `quote` | object | **yes** | yes |
| `quote.canonical` | string, absolute url | **yes** | yes when `quote` is an object |
| `quote.text` | string | no | yes when `quote` is an object — `""` when there is none |
| `quote.author` | object | no | yes when `quote` is an object |
| `quote.author.name` | string | **yes** | yes |
| `quote.author.handle` | string | **yes** | yes |
| `quote.author.url` | string | **yes** | yes |

### `createdAt`

It can be `null`. Some platforms don't publish a post date, and for others it arrives on a second,
slower call. Sort a `null` as unknown, never as old.

### `counts`

A key is present only when the count is known. `apiCounts` (`src/worker.ts:3079-3086`) copies one
only for a finite number above zero, so a zero is omitted. Upstreams report `0` both for a post
nobody has touched and for a count the platform withholds, such as a hidden like count or a video
with comments switched off, and nothing tells the two apart by the time they reach that filter. An
absent key means unknown, and v1 has no encoding for a count known to be zero.

Which of the four keys exist varies by site.

### `text`

`text` is what the card shows, with the card's overlays composed in. None of them has a structured
field of its own in v1:

- a translation, followed by a `🌐 Translated from …` marker and then the original text;
- `🔞 Age-restricted on …` on a gated YouTube video (`sensitive` is also `true`);
- `🎬 Too long to play here — open it on …` on a video past the length ceiling for a remux.

v1 has no field carrying the author's untouched words. Splitting them out is additive, and it's on
the list.

### `width` and `height`

`0` is far more common than `null`. Several normalizers emit `0` for a size the platform did not
report: Reddit, TikTok covers, Threads, Facebook galleries, and every remuxed video. A remux carries
`w: 0, h: 0` so a player reads the real dimensions out of the file. `null` happens only when the
cached value wasn't a finite number at all. Both mean unknown, so don't divide by either.

The pair describes the bytes at `url`, not the original video. The published values are
`posterW ?? w` and `posterH ?? h` (`src/worker.ts:3149-3150`), so a `still` entry reports the poster
frame's size.

### `media`

`media` lists only entries that resolve to something servable, and an entry with no url is dropped.
The ones that remain are addressed by their position in the unfiltered list, which keeps the
published urls correct.

### `still`

A video that hasn't finished muxing, or one too long to mux at all, is published as an `image` entry
pointing at its poster frame, carrying `still: true`. On such an entry `url` and `poster` are the
same url, because the poster slot is where the bytes are. Read it with the top-level `muxing` flag:

| `still` | `muxing` | Meaning |
|---|---|---|
| `false` | `false` | An ordinary picture. |
| `true` | `true` | A video is still muxing. Ask again in a few seconds. |
| `true` | `false` | A video exists that cannot be served, usually because it is too long. This is final. |

Without `still`, that last row is indistinguishable from an ordinary photo except by reading the
English in `text`.

### `quote`

`quote` is `null` unless the quoted post carries an author object (`src/worker.ts:3167`).

`quote.author` has no `avatar`, and `quote` has no `media`. A quoted post's media entries live at
indices after the outer post's, and getting that arithmetic wrong would publish urls that resolve to
the wrong bytes, so v1 leaves them out.

### Media urls

Every url in the payload is on `mbedfx.app`, not the platform's CDN. Nothing in it expires, so
they're safe to store.

Remuxed video comes from R2 and answers range requests, so a player can seek. Images, avatars,
posters and already-progressive video get a `302` to the platform's CDN, and the mbedfx url stays
valid as the destination behind it changes. Past that hop, range support and whether the bytes are
reachable at all belong to the platform. Instagram and Twitch are proxied instead of redirected.

---

## The seventeen platform codes

`platform` is the two-letter code. `tw` is Twitch, Twitter is `x`, and the two sit next to each other
in every list in this repo.

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

The order is the README's, and the codes are the seventeen in `Platform` (`src/types.ts:1`). Which
site each one means is fixed by the canonical url the router rebuilds for it (`src/router.ts`: `bs`
197, `x` 205/210, `tt` 240, `th` 357, `rd` 387, `ig` 414, `yt` 435, `fb` 489-499, `dm` 651, `st` 672,
`im` 698-700, `tw` 845/852/858, `pn` 1078; the four fediverse arms at 895/971/1011/1038 take their
host from the path instead).

### The Hosts column

That column records where a link came from, and routing never reads it.

- A short link whose code is a bare single path segment doesn't resolve through this endpoint.
  `?url=https://redd.it/1abc23` and `?url=https://dai.ly/x7abcde` answer `ambiguous` with candidates
  `["x","ig"]`, because `/1abc23` is also the shape of an X or Instagram profile.
- The short links that do work are the ones whose path carries its own shape: `youtu.be/{11-char id}`
  (an 11-character segment is a YouTube id outright), `tiktok.com/t/{code}`, `reddit.com/r/{sub}/s/{code}`,
  and Meta's `/share/…` codes. Those are resolved with the same hop a pasted link gets.

---

## When the answer is not JSON

Every code in the [failure table](#failures) below arrives inside the envelope. The answers in this
section don't, and calling `.json()` on one of them throws. Cloudflare's own edge errors are the same
story. This Worker runs behind Cloudflare's proxy, and 502, 520, 522, 524 and friends come back as
HTML without it running at all.

### A path that is not exactly `/_api/v1`

`/_api/v2`, `/_api/v1/anything` and `/_api` never reach the API arm. They answer the way any unrouted
path answers. Measured offline, 2026-08-04: `/_api/v2?url=…` returns HTTP 404,
`content-type: text/plain`, body `not found\n` to an ordinary client, and an HTML embed at HTTP 200
to a user agent classified as Discord. `/_api` returns an HTML chooser page at HTTP 300. Pin the
path exactly.

### An unhandled exception

The API arm has no `try`/`catch` around it, and neither does `handle()` (`src/worker.ts:3358`) or
the module's `fetch` handler (`src/worker.ts:4226-4236`) — verified by reading all three.

The guards sit on individual calls. The live upstream fetch (`loadPost`,
`src/worker.ts:2532-2536`), the three share-code and short-link resolvers (`unwrapToPost`,
`src/worker.ts:2819-2851`), the mux (`src/worker.ts:1485`) and the translation
(`src/worker.ts:2709`) each turn a throw into a normal answer, which is why an upstream that's down
or blocking mbedfx becomes `fetch_fail` at HTTP 200.

The storage layer isn't guarded. Inside `loadPost` the wrap covers only the live fetch, and the
comment there records that a corrupt cache read is meant to propagate. The post-cache read and write
(`src/worker.ts:2520-2523`, `2542`, `2558`) are uncaught, as is the R2 record read on the YouTube
path. A throw there leaves the Worker, and Cloudflare answers with its own error page: Error 1101,
"Worker threw a JavaScript exception", HTML with a 5xx status
([Cloudflare Workers errors](https://developers.cloudflare.com/workers/observability/errors/)). Error
1102 ("Worker exceeded CPU time limit") is the other runtime code that can appear. Neither page is
JSON.

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
pipeline (`describeTarget`, `src/worker.ts:2881`). It's a deadline on the whole response, and each
step gets whatever is left of it.

The constants, all in `src/worker.ts`:

| Constant | Value | What it bounds |
|---|---|---|
| `CARD_DEADLINE_MS` (= `MUX_WAIT_API_MS`) | **9000 ms** (`1345`, `1359`) | everything after the upstream fetch: the deadline the mux wait is measured against |
| `MUX_WAIT_FLOOR_MS` | **300 ms** (`1344`) | the floor under that wait, so a spent budget still leaves time to pick up a video already in storage |
| `XLATE_MAX_WAIT_MS` | **1500 ms** (`2665`) | the translation's share of the budget |
| `XLATE_WAIT_FLOOR_MS` | **300 ms** (`2651`) | the floor under the translation's wait |
| `META_WAIT_API_MS` | **8000 ms** (`2316`) | **YouTube only**: the metadata extract, awaited after the two above |

The mux and the translation race concurrently (`src/worker.ts:2932-2940`), so between them they cost
`max(300, 9000 − elapsed)` and not the sum. The YouTube metadata warm runs after them
(`src/worker.ts:2960-2975`) and only when the post has no known date yet, so it adds up to 8000 ms on
a first request for a YouTube link and nothing thereafter.

The upstream fetch itself is unbounded. Nothing in `src/` sets an `AbortSignal` (verified by grep),
and Cloudflare places no wall-clock limit on an HTTP-triggered Worker
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/): "No limit … as long
as the client remains connected"). Only CPU time is capped, and this endpoint spends almost none of
it. The arithmetic:

```
total ≈ upstream fetch + max(300 ms, 9000 ms − upstream fetch) + (YouTube only: up to 8000 ms)
```

An upstream that answers within 8.7 s gives 9.0 s, or 17.0 s on a cold YouTube link. An upstream
slower than that drops the mux to its 300 ms floor, and the total tracks the upstream.

20 seconds is the recommended client timeout. That covers the 17.0 s worst case in the code plus
roughly 3 s for connection setup and for an upstream slower than 8.7 s. 12 seconds is enough for a
client that never sends YouTube links. At 5 or 10 seconds a client cuts off requests that were about
to answer.

The measurements behind those budgets, all in the source: a cold video remux is 6-9 s at ≤480p
(`src/worker.ts:1313`, measured 2026-07-24), `yt-dlp -J` on YouTube is 2.3-6.7 s over five runs
(`src/worker.ts:2299`, 2026-07-26), a Facebook metadata extract is ~3.0 s (`src/worker.ts:1508`,
2026-07-25), and a translation is 217-798 ms (`src/worker.ts:2924`).

Repeats are cheaper than that arithmetic suggests. The post is cached for 900 s (`POST_TTL`,
`src/cache.ts:5`) independently of the response, so a second request skips the upstream fetch even
when the first answer wasn't cacheable. `/_api/v1` never consults the response cache, only the post
cache, and a cold post pays the upstream fetch every time until that entry is warm.

---

## `muxing` and `pending`

Either flag means the answer is incomplete, and both responses carry `cache-control: no-store` to
keep a half-answer out of any cache in between.

- `muxing: true` means a video is still being remuxed into the progressive MP4 mbedfx serves. What
  arrived is its poster still. A re-request in a few seconds returns a `video`.
- `pending: true` means a translation lost its race. `text` is the original. The translation is still
  being written, and a re-request carries it.

Neither is an error, and both clear on their own. Ignore them and the answer is still correct, just
less complete.

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

Once the reply is confirmed to be JSON (see
[When the answer is not JSON](#when-the-answer-is-not-json)), branch on `ok` and `error.code`, not on
the HTTP status. Every answer about a post is `200`, including the ones that say the post can't be
read. The `4xx`s are about the request itself (`400` for a missing or unreadable `url`, `405` for a
write verb) and never about the post. Several of the platforms mbedfx reads do the same thing,
answering `200` with a login wall or `500` with a perfectly good JSON error.

Match on `code`. `message` is prose for humans and may be reworded.

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

`platform` and `canonical` carry real values on `age_restricted`, `private` and `fetch_fail`, and are
`null` whenever the request didn't get far enough to establish them. They're never guessed.
`candidates` appears on `ambiguous` and nowhere else.

No failure is cached, not even `private`, because accounts go public and gates lift and a deleted
post can come back as somebody's repost.

### What common inputs return

Measured offline, 2026-08-04:

| Sent | Answer | Why |
|---|---|---|
| a bare handle — `?url=jack` | `200` `ambiguous`, `candidates: ["x","ig"]` | one path segment, and both X and Instagram mint profiles at that shape |
| a profile url — `?url=https://x.com/jack` | `200` `ambiguous`, `candidates: ["x","ig"]` | the host is ignored, so this is the same request as the line above |
| a TikTok or Threads profile — `?url=https://www.tiktok.com/@charlidamelio` | `200` `ambiguous`, `candidates: ["tt","th"]` | the `@` narrows it to the two sites that use one |
| a junk string — `?url=not a url at all` | `200` `ambiguous`, `candidates: ["x","ig"]` | it resolves to the one-segment path `/not%20a%20url%20at%20all` |
| `?url=javascript:alert(1)` | `200` `ambiguous`, `candidates: ["x","ig"]` | `javascript:` parses fine as an absolute url; its path is `alert(1)`, one segment |
| an empty url — `?url=` | `400` `no_url` | the empty string is falsy, so it takes the missing-parameter branch |
| a malformed absolute url — `?url=http://[` | `400` `unparseable` | `new URL` throws. `https://` and `http://:` are the other spellings that do |

`unparseable` is narrower than it sounds. The target is parsed with the mbedfx origin as a base, so a
string reaches that code only by failing url parsing outright, which in practice means a malformed
absolute url. Junk that merely doesn't name a post never reaches it.

`ambiguous` is the catch-all for anything one segment long, not only the contested paths the chooser
was built for. `/gallery/YcAQlkx` is the designed case; a handle or a typo lands there because
nothing in a single unrecognised segment narrows it.

The code says only that the path shape belongs to more than one site and that none of them has been
asked. On a genuinely contested path, walking the candidates is the right move. On a profile url
every one of them answers `notfound`, since there's no profile route to reach
(`/x/jack` → `notfound`, verified).

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

`candidates` is which sites claim that path shape. Whether one then accepts that particular id is a
second question. `/rd/gallery/…` is the clearest case, because Reddit's own gallery links are
deprecated upstream and the router deliberately does not route them. Expect a few `notfound`s while
walking the list, and take the first success.

The host in a caller's `url` is not used to break the tie, even though it usually could. Letting a
caller-supplied hostname decide which site's fetcher runs is a decision this project would rather not
make on a service where a hostname is also a thing it fetches. The two-letter prefix can only name
one of the codes above.

---

## Caching and limits

A complete answer is sent `cache-control: public, max-age=900`, so a cache in front of the caller can
absorb repeats. Incomplete answers and failures are `no-store`.

There is no API key, no quota and no rate limiting in this repository. Any limit in front of the
public instance is a rule on the zone, configured in the Cloudflare dashboard. Nothing in the source
establishes whether one exists or what its thresholds are, and this document does not claim one. A
fork inherits no rate limiting, so put something in front of a self-hosted instance before you point
traffic at it.

Please be reasonable. The expensive parts of a request are the upstream fetch, the video remux and
the translation, and all three are shared with the people using the cards.

---

## Stability

`v1` is in the path so it shows up in a url pasted into a bug report. A request for `/_api/v2` is
never answered with v1.

An unrecognised path is HTTP 404 `text/plain`, the same answer any unrouted url gets. Assume every
reply is JSON and you'll fail at the parse. See
[When the answer is not JSON](#when-the-answer-is-not-json).

Within `v1`:

- Fields will be **added**, never removed or retyped.
- `error.code` values will be added; existing ones keep their meaning.
- `error.message` wording may change. Do not match on it.
- Two-letter platform codes are stable.

Not in v1, and each is additive if it lands later: media on a quoted post (see [`quote`](#quote)), an
opt-in translation parameter, profile lookups, and any form of batch request.

---

## What this is built on

Teaching one surface something its twin never learned is the defect this project repeats most. So the
card, the converter preview and this endpoint run through one pipeline. A single function fetches the
post, waits for the video, waits for the translation and applies the per-platform overlays, and the
three surfaces differ only in how they serialise the result.
