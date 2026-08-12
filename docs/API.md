# The JSON API

`/_api/v1` serves the post data the cards are drawn from, as JSON. Shipped in 1.9.0
(`docs/CHANGELOG.md`, 2026-08-04).

```
GET https://mbedfx.app/_api/v1?url=<the post url>
```

No key, no signup, no required headers. Every answer carries `access-control-allow-origin: *` and
`x-content-type-options: nosniff` (`apiHeaders`, `src/worker.ts`).

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

It answers for the thirteen single-host sites the cards cover, plus short links and share codes. The
four fediverse platforms need the request form [below](#mastodon-misskey-lemmy-and-peertube).

The machine-readable half of this contract is `public/openapi.json`, served at
`https://mbedfx.app/openapi.json`: OpenAPI 3.1, every response shape, every error code and the exact
nullability of every field, in the form a generator or a schema viewer reads. It is JSON rather than
YAML because there is no YAML parser in this toolchain, and a spec the suite cannot read is a spec
nothing checks. `test/openapi.test.mjs` derives what can be derived — the `Platform` union,
`API_COUNTS`, the error codes and their statuses read out of the `api` arm, the router's own answer
for the documented path, `RESP_TTL` — and then validates real answers, driven offline through
`handle()`, against the schemas with `additionalProperties: false`, so a field added to `toApiPost`
and not to the document fails the build. Prose is not derivable and stays unguarded in both files;
that test names what it does not cover.

This file stays the longer half. A schema cannot hold what was measured, what was tried and failed,
or what a rule costs.

Source citations below name symbols rather than lines. The line numbers were right when 1.9.0
shipped on 2026-08-04 and every one of them pointed into the wrong part of `src/worker.ts` by
2026-08-11, the file having grown around 140 lines underneath them. A name survives a merge, and
`test/openapi.test.mjs` fails when a cited one stops existing.

`GET` and `HEAD` are answered. `OPTIONS` returns `204` with
`access-control-allow-methods: GET, HEAD, OPTIONS`, `access-control-allow-headers: *` and
`access-control-max-age: 86400`, before any work is spent (the `OPTIONS` branch of the `api` arm,
`src/worker.ts`). Every other method is `405` `method_not_allowed` (the method check beside it).
Neither branch existed at 1.9.0's review: a preflight paid for an upstream fetch, a mux wait and a
`yt-dlp -J`, then failed for want of `access-control-allow-methods`.

---

## The request

One parameter, `url`, carrying the whole original link. Percent-encode it. A raw `?` or `&` in the
post url ends the parameter early.

Routing reads the path and the query. The host is ignored. `https://x.com/jack/status/20`,
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
(`public/index.html:976`). The cards mint the same shape:
`https://mbedfx.app/lemmy.world/post/49966212`.

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

`post` comes from `toApiPost` (`src/worker.ts`), the envelope from the `api` arm that wraps it.
Answers here were driven offline through `route()` and `handle()`, 2026-08-04, again 2026-08-05, and
again 2026-08-11 against every shape in `public/openapi.json`.

### The envelope

| Field | Type | Nullable |
|---|---|---|
| `ok` | boolean | no |
| `muxing` | boolean | no |
| `pending` | boolean | no |
| `post` | object | no |

`ok` is `true` on this shape, `false` on a failure envelope, where `post` is absent.

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

Every key is always present except the four under `counts`, **omitted when unknown** and the only
place an absent key carries meaning. With nothing to report: `title` is `null`, `text` is `""`,
`counts` is `{}`, `media` is `[]`. The `quote.*` keys are present whenever `quote` is an object.

### `createdAt`

`null` where a platform publishes no post date, and until a second, slower call brings one. A Post
without one holds `new Date(0)`, which `/_card` draws as `"1970-01-01T00:00:00.000Z"` beside a
`⚠ no upload date` note and `toApiPost` sends as `null`. Sort a `null` as unknown, never as old
(`test/api.test.mjs:142`).

### `counts`

`apiCounts` (`src/worker.ts`) copies `likes`, `reposts`, `replies` and `views` only for a finite
number above zero. A `0` reaches that filter both from an untouched post and from a count the
platform withholds (a hidden like count, comments switched off), indistinguishable there. An absent
key means unknown; v1 cannot encode a count known to be zero. Which of the four keys exist varies by
site.

### `text`

What the card shows, the card's overlays composed in. v1 gives none of them a field of its own:

- a translation, followed by a `🌐 Translated from …` marker and then the original text;
- `🔞 Age-restricted on …` on a gated YouTube video (`sensitive` is also `true`);
- `🎬 Too long to play here — open it on …` on a video past the length ceiling for a remux.

No v1 field carries the author's untouched words; splitting them out is additive and on the list.

`deserializePost` validates the ref, the canonical and the date, nothing else. `text` goes out
through `str()` (`src/render/embed.ts`, applied in `toApiPost`): a cached value of the wrong type is
published as `""`, never verbatim (`test/api.test.mjs:497`).

### `width` and `height`

`0` is far more common than `null`. Reddit, TikTok covers, Threads, Facebook galleries and every
remuxed video emit `0` for an unreported size; a remux carries `w: 0, h: 0` to make a player read
the real dimensions out of the file. `null` means the cached value wasn't a finite number (`num`,
`src/worker.ts`). Both mean unknown; divide by neither.

The pair describes the bytes at `url`, not the original video: `posterW ?? w` and `posterH ?? h`
(`toApiPost`, `src/worker.ts`), and a `still` entry reports the poster frame's size. Both rows were
added 2026-08-04 (`3a2406f`).

### `media`

Entries with no servable url are dropped. The rest keep their position in the unfiltered array
(`usableWithIndex`, `src/worker.ts`), which is the index `/_media/` resolves against. Taking the
position after the filter publishes entry N at entry N+1's bytes, or a 404 past the end;
`test/api.test.mjs:372` pins that off-by-one. A degraded still is addressed through its poster slot,
never that bare number (`bytesIndex`, `src/render/embed.ts:52`), which goes on naming the video
entry and answers `503`. `kind` collapses `Media.kind`'s three values (`src/types.ts`) to two,
publishing a `gif` as `"video"` (`toApiPost`, `src/worker.ts`).

### `still`

A video that hasn't finished muxing, or one too long to mux at all, is published as an `image` entry
carrying `still: true`; `url` and `poster` are both the poster frame, where the bytes are. Read it
with the top-level `muxing` flag:

| `still` | `muxing` | Meaning |
|---|---|---|
| `false` | `false` | An ordinary picture. |
| `true` | `true` | A video is still muxing. Ask again in a few seconds. |
| `true` | `false` | A video exists that cannot be served, usually because it is too long. This is final. |

Without `still`, that last row is indistinguishable from an ordinary photo except by reading the
English in `text`.

### `quote`

`null` unless the quoted post carries an author object (`toApiPost`, `src/worker.ts`). The
normalizers cap depth at 1, leaving `quote.quote` always absent. `quote.author` has no `avatar`, and
`quote` has no `media`: those entries live at indices after the outer post's in `mediaList`, and
getting that arithmetic wrong publishes urls that resolve to the wrong bytes.

### Media urls

Every url in the payload is on `mbedfx.app`, never the platform's CDN, which hands out signed,
short-lived and sometimes IP-locked urls. An mbedfx url carries no expiry, stays valid as its
destination changes, and is safe to store. Past a redirect, range support and reachability belong to
the platform.

| Media | Served as |
|---|---|
| remuxed video | R2 bytes, answering range requests, so a player can seek |
| images, avatars, posters, already-progressive video | `302` to the CDN under `cache-control: public, max-age=300` (`MEDIA_MAX_AGE`, `src/cache.ts:8`) |
| Instagram, Twitch and Threads video | proxied rather than redirected (the `media` arm of `src/worker.ts`; the three platforms are scoped in `proxyableVideoUrl`, `src/mediaproxy.ts`) |

### The `d.` host

`d.` in front of either official host serves the file itself, video or image, at its own url:
`https://d.mbedfx.app/jack/status/20`, `https://d.megapenispoopenfarten.sex/jack/status/20`. Those
bytes answer range requests, and a client seeks and resumes properly. A `d.` url renders no card,
and it serves crawlers and people the same bytes.

With nothing to serve, `d.` answers a plain-text 404; an HTML body there leaves a downloader holding
a file full of markup. `media_miss` on this host means the post has no usable media at all, a second
meaning `docs/METRICS.md` records under "Known defects in the write shape" (`serveDirectMedia`,
`src/worker.ts`).

---

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
| `tw` | **Twitch** | `twitch.tv` · `clips.twitch.tv` |
| `pn` | Pinterest | `pinterest.com` |
| `dm` | Dailymotion | `dailymotion.com` · `dai.ly` |
| `st` | Streamable | `streamable.com` |
| `im` | Imgur | `imgur.com` · `i.imgur.com` |
| `ms` | Mastodon | any instance |
| `mk` | Misskey | any instance |
| `lm` | Lemmy | any instance |
| `pt` | PeerTube | any instance |

The codes are the seventeen in `Platform` (`src/types.ts:1`), in the README's order. The canonical
url the router rebuilds fixes which site each one means (`src/router.ts`: `bs` 197, `x` 205/210,
`tt` 240, `th` 357, `rd` 387, `ig` 414, `yt` 435, `fb` 489-499, `dm` 651, `st` 672, `im` 698-700,
`tw` 845/852/858, `pn` 1078; the four fediverse arms at 895/971/1011/1038 take their host from the
path instead).

### The Hosts column

That column records where a link came from. Routing never reads it.

- A short link whose code is a bare single path segment doesn't resolve here.
  `?url=https://redd.it/haucpf` and `?url=https://dai.ly/x8ocv9e` answer `ambiguous` with candidates
  `["x","ig"]`, re-measured 2026-08-12: `/haucpf` is also the shape of an X or Instagram profile.
  The Dailymotion id here changed from `xaqwy7q`, which went HTTP 410 Gone. The answer does not
  depend on it — the path shape decides ambiguity before anything is fetched, so both ids give the
  same `["x","ig"]` — but a published example that 404s under a reader sends them debugging nothing.
- The ones that do work carry their own shape, each resolved with the hop a pasted link gets:
  `youtu.be/dQw4w9WgXcQ` (an 11-character segment is a YouTube id outright),
  `tiktok.com/t/ZTSw2mYwR`, `reddit.com/r/{sub}/s/{code}`, and Meta's `/share/…` codes.

---

## When the answer is not JSON

Every code in the [failure table](#failures) arrives inside the envelope. The answers below do not,
and `.json()` on one of them throws. Cloudflare's own edge errors are the same. 502, 520, 522, 524
and the rest come back from the proxy as HTML and the Worker never runs.

### A path that is not exactly `/_api/v1`

`/_api/v2`, `/_api/v1/anything` and `/_api` never reach the API arm. Measured offline 2026-08-04,
re-measured 2026-08-05: `/_api/v2?url=…` and `/_api/v1/anything?url=…` return HTTP 404 to an
ordinary client, body `not found\n`, carrying exactly one header,
`content-type: text/plain;charset=UTF-8`. That header is the runtime's own default;
`src/render/index.ts:51` builds the response as `new Response('not found\n', { status: 404 })` with
no headers object, so no `cache-control` reaches the client and an intermediary applies whatever it
defaults to. A user agent classified as Discord gets an HTML embed at HTTP 200 on the same path,
`og:title` `Not found`, minted by the `notfound` arm's `render()` call (`src/worker.ts`) and
split from the human 404 at `src/render/index.ts:49-53`. `/_api` returns an HTML chooser page at
HTTP 300 (`src/render/chooser.ts:72`). Pin the path exactly; `test/api.test.mjs:524` refuses to
serve `/_api/v2` as v1.

### An unhandled exception

- No `try`/`catch` wraps the API arm, `handle()` or the module's default `fetch` handler, verified
  by reading all three.
- Guarded per call, each throw becoming a normal answer: the live upstream fetch (`loadPost`), the
  three share-code and short-link resolvers (`unwrapToPost`), the mux (`settleMux`), the translation
  (`withTranslated`). A down or blocking upstream becomes `fetch_fail` at HTTP 200.
- Unguarded: the post-cache read and both writes, all three inside `loadPost`, and the R2 record
  read on the YouTube path. `loadPost`'s wrap covers only the live fetch; its comment records that a
  corrupt cache read is meant to propagate.

A throw in that last group leaves the Worker for Cloudflare's own error page: Error 1101, "Worker
threw a JavaScript exception", HTML with a 5xx status ([Cloudflare Workers
errors](https://developers.cloudflare.com/workers/observability/errors/)). Error 1102, "Worker
exceeded CPU time limit", is the other runtime code that appears. Neither is JSON.

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

---

## How long a request can take

No timeout parameter, no per-step limit. One budget, taken at the top of the shared pipeline
(`describeTarget`, `src/worker.ts`), bounds the whole response and leaves each step whatever is
left. The card and the converter preview run that pipeline too, the three differing only in
serialisation (`test/api.test.mjs:325`).

| Constant | Value | What it bounds |
|---|---|---|
| `CARD_DEADLINE_MS` (= `MUX_WAIT_API_MS`) | **9000 ms** | everything after the upstream fetch; the mux wait is measured against it |
| `MUX_WAIT_FLOOR_MS` | **300 ms** | the floor under that wait, leaving a spent budget time to pick up a video already in storage |
| `XLATE_MAX_WAIT_MS` | **1500 ms** | the translation's share of the budget |
| `XLATE_WAIT_FLOOR_MS` | **300 ms** | the floor under the translation's wait |
| `META_WAIT_API_MS` | **8000 ms** | **YouTube only**: the metadata extract, awaited after the two above |

All five are in `src/worker.ts`. The mux and the translation race concurrently (the `Promise.all` in
`describeTarget`), costing `max(300, 9000 − elapsed)` between them rather than the sum. The YouTube
metadata warm runs after them, only when the post has no known date yet: up to 8000 ms on a first
YouTube link, nothing thereafter.

The upstream fetch is unbounded. Nothing in `src/` sets an `AbortSignal` (verified by grep), and
Cloudflare places no wall-clock limit on an HTTP-triggered Worker ([Workers
limits](https://developers.cloudflare.com/workers/platform/limits/): "No limit … as long as the
client remains connected"). Only CPU time is capped, and this endpoint spends almost none.

```
total ≈ upstream fetch + max(300 ms, 9000 ms − upstream fetch) + (YouTube only: up to 8000 ms)
```

An upstream answering within 8.7 s gives 9.0 s, 17.0 s on a cold YouTube link; slower, the mux drops
to its 300 ms floor and the total tracks the upstream. Set the client timeout to 20 s: the 17.0 s
worst case plus roughly 3 s for connection setup and a slower upstream. 12 s covers a client that
never sends YouTube links. 5 or 10 s cuts off requests about to answer.

Measured, each recorded in a comment beside the code it bounds in `src/worker.ts`: a cold video
remux 6-9 s at ≤480p (2026-07-24), `yt-dlp -J` on YouTube 2.3-6.7 s over five runs (2026-07-26), a
Facebook metadata extract ~3.0 s (2026-07-25), a translation 217-798 ms.

A post is held 900 s (`POST_TTL`, `src/cache.ts:5`) independently of the response, and a second
request skips the upstream fetch even when the first answer wasn't cacheable. `/_api/v1` never
consults the response cache; a cold post pays the upstream fetch until that entry is warm.

---

## `muxing` and `pending`

Either flag means an incomplete answer, and both carry `cache-control: no-store` to keep a
half-answer out of any cache in between.

- `muxing: true`: a video is still being remuxed into the progressive MP4 mbedfx serves, and what
  arrived is its poster still. A re-request in a few seconds returns a `video`.
- `pending: true`: a translation lost its race and `text` is the original. The translation is still
  being written; a re-request carries it.

Neither is an error. Both clear on their own, the work behind each running on in `waitUntil`, and an
answer that ignores them is still correct. `test/api.test.mjs:288` asserts the `no-store`, `317` the
`max-age=900`.

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

Branch on `ok` and `error.code`, never on the HTTP status. Every answer about a post is `200`,
including the ones saying it can't be read; the `4xx`s are about the request itself. Several
platforms mbedfx reads answer `200` with a login wall, or `500` with a good JSON error. Match on
`code`; `message` is prose for humans and may be reworded.

| `code` | Status | Means |
|---|---|---|
| `age_restricted` | 200 | The post exists behind an age gate. |
| `private` | 200 | The post exists behind a private account or a login wall. |
| `fetch_fail` | 200 | Not loadable: deleted, or the platform did not answer. |
| `ambiguous` | 200 | The path belongs to more than one site. Carries `candidates`. A bare handle (`/{handle}`, `/@{handle}`) and an unrecognised one-segment path land here, because a handle names an account on more than one site and picking one would be a guess. |
| `notfound` | 200 | A shape mbedfx routes for nobody, including a site prefix forced onto a path that site does not claim (`/x/jack`) and `/_prep` or `/_card` **without** their own `p` parameter. |
| `bad_id` | 200 | A Mastodon-spoof-shaped path (`/users/{handle}/statuses/{id}`, `/api/v1/statuses/{id}`, `/_oembed/{id}`) whose id did not decode. Not reachable from an ordinary post url. |
| `not_a_post` | 200 | Routes to something that is not a post: a site page (`/`, `/index.html`, `/robots.txt`), one of this service's own endpoints (`/_media/…`, `/_prep?p=…`, `/_card?p=…`, `/_api/v1`), a **profile** url (see below), or a **Meta or Reddit** share code that did not resolve to one. A TikTok `/t/{code}` never lands here; see below. |
| `no_url` | 400 | No `url` parameter, **or an empty one**. `?url=` and no `url=` at all are the same answer. |
| `unparseable` | 400 | `new URL(target, origin)` threw, `origin` being the mbedfx origin. Only a malformed **absolute** url does that; anything readable as a path resolves against that origin and gets a 200 instead. |
| `method_not_allowed` | 405 | This endpoint reads. Use `GET`. |

#### A TikTok `/t/{code}` answers what it renders

A short code names no post until a network hop resolves it, and that hop has four outcomes. Each one
is answered here with the code that matches the **card the same url draws**, which is the property
worth relying on: one post does not get two answers depending on which url shape was pasted.

| The resolution | This endpoint answers | `platform` / `canonical` |
|---|---|---|
| The post, resolved | the post | the post's |
| Private or age-restricted | `private` / `age_restricted` | `tt`, the share url |
| TikTok claims the code and cannot serve it | `fetch_fail` | `tt`, the share url |
| TikTok does not claim the code | `ambiguous`, `candidates: ["tt","th"]` | absent |

`canonical` is the share url on the middle two rows because it is the only one that exists before a
code resolves: a deleted post has no id to build a permalink out of, and `/t/{code}` is a real link
that lands on TikTok's own "video currently unavailable" page.

The last row is `ambiguous` rather than a dead end because `tiktok.com/t/` and `threads.com/t/` are
the same path on two different products, so a code TikTok disclaims may well be Threads'. The render
arm has offered that chooser since the route was written.

All four rows used to answer `not_a_post`. The walls were corrected on 2026-08-11 and the other two
on 2026-08-12, each after measuring the same code through both surfaces — a false statement about a
post that demonstrably exists, and one the render path never made.

`platform` and `canonical` carry real values on `age_restricted`, `private` and `fetch_fail`, and
are `null` whenever the request didn't get far enough to establish them. They are never guessed.

`candidates` appears on `ambiguous` and nowhere else. Until 2026-08-04 (`3a2406f`) both were absent
on `no_url`, `unparseable` and `method_not_allowed` and `null` on every other code; `apiError`
defaults them to `null` now (`apiError`, `src/worker.ts`).

### Profile urls

`/profile/{handle}` renders a Bluesky **profile** card, and this endpoint answers it `not_a_post`.
That is a boundary rather than a failure: a profile is an account, not a post, so it carries no
`text`, no `createdAt` and none of the four engagement counts this endpoint publishes. Serving one
through the post payload would mean either omitting most of it or filling those fields with values
nobody measured.

Every other profile url — `x.com/{handle}`, `instagram.com/{handle}`, `tiktok.com/@{handle}` — is
`ambiguous` or `notfound`, unchanged: a bare handle names an account on more than one site, so the
router does not resolve it at all. A profile payload will be a versioned addition when there is a
second platform to shape it around.

No failure is cached, not even `private`: accounts go public, gates lift, and a deleted post can
come back as somebody's repost.

### What common inputs return

Measured offline 2026-08-04, re-driven 2026-08-05. Every row but the last two answers `200`
`ambiguous`.

| Sent | `candidates` | Why |
|---|---|---|
| a bare handle: `?url=jack` | `["x","ig"]` | one path segment; both mint profiles at that shape |
| a profile url: `?url=https://x.com/jack` | `["x","ig"]` | the host is ignored; same request as above |
| a TikTok or Threads profile: `?url=https://www.tiktok.com/@charlidamelio` | `["tt","th"]` | the `@` narrows it to the two sites that use one |
| junk: `?url=not a url at all`, `?url=:::not-a-url`, `?url=javascript:alert(1)` | `["x","ig"]` | one unrecognised segment each: `/not%20a%20url%20at%20all`, `/:::not-a-url`, `alert(1)` (`javascript:` parses fine as an absolute url). A source comment claimed `notfound` for the middle one until 2026-08-04 (`test/api.test.mjs:233-249`) |
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
    "candidates": ["rd", "ig", "im"]
  }
}
```

`/gallery/YcAQlkx` could be Reddit, Instagram or Imgur, and is the case the code was built for.
Re-ask with the site code in front of the path:

```
?url=/im/gallery/YcAQlkx
```

That message read `/im/gallery/abc` at 1.9.0's review. `?url=/im/gallery/abc` answers `notfound`
(Imgur ids run five characters or more), and a caller following it verbatim reached the same dead
end twice (`apiFailure`, `src/worker.ts`).

`candidates` is which sites claim that path shape; whether one accepts that id is a second question.
`/rd/gallery/…` is the clearest case, Reddit's gallery links being deprecated upstream and
deliberately unrouted. Expect a few `notfound`s while walking the list, and take the first success.
On a profile url every candidate answers `notfound` (`?url=/x/jack` → `notfound`, verified
2026-08-05). There is no BARE-HANDLE profile route — a bare handle names an account on more than one
site — so a forced site prefix has nothing to resolve to. `/profile/{handle}` is a different shape and
does route; see "Profile urls" above.

A hostname never breaks the tie, even though it usually could. A hostname here is a thing the Worker
fetches, the fediverse arm turning one into a request, and `src/refkey.ts` states outright that
Cloudflare is not relied on to block private addresses. The prefix names one of the seventeen codes
and nothing else.

---

## Caching and limits

A complete answer is sent `cache-control: public, max-age=900` (`RESP_TTL`, `src/cache.ts:6`); an
incomplete one `no-store` (the `api` arm), as is every failure envelope (`apiError`).

`src/` holds no API key, no quota and no rate limiting. Any limit on the public instance is a zone
rule in the Cloudflare dashboard, which the source cannot see. A fork inherits none of it: put
something in front of a self-hosted instance before pointing traffic at it, and read
`docs/SELF-HOSTING.md` first. A cold request pays the whole budget above. Repeating one url is free
while its post is warm; space out distinct ones.

---

## Stability

`/_api/v2` is never answered with v1, and an unrecognised path is the plain-text 404
([above](#when-the-answer-is-not-json)). Within `v1`:

- Fields will be added, never removed or retyped.
- `error.code` values will be added; existing ones keep their meaning.
- `error.message` wording may change. Do not match on it.
- Two-letter platform codes are stable.

Four things are absent from v1, each additive if it lands later: media on a quoted post (see
[`quote`](#quote)), an opt-in translation parameter, profile lookups, and batch requests.
