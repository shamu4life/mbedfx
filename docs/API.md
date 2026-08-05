# The JSON API

Everything the card knows about a post, as data, for anything that is not Discord.

```
GET https://mbedfx.app/_api/v1?url=<the post url>
```

No key, no signup, no headers. CORS is open, so a page can call it from script.

```sh
curl -s 'https://mbedfx.app/_api/v1?url=https%3A%2F%2Fx.com%2Fjack%2Fstatus%2F20' | jq
```

It answers for the thirteen single-host sites the cards cover, including their short links and share
codes — the same resolution a pasted link gets, because it is the same code path. The four
**fediverse** platforms need a different request form; see below.

Methods: `GET` and `HEAD`. `OPTIONS` is answered as a CORS preflight without running anything;
anything else is `405`.

---

## The request

One parameter, `url`, and it is the whole original link. Percent-encode it; a raw `?` or `&` in the
post url will otherwise be read as the end of it.

The **host in that url is ignored.** Routing here reads the path and the query only, exactly as it
does when you swap a domain — so `https://x.com/jack/status/20` and `https://mbedfx.app/jack/status/20`
are the same request, and a bare path (`?url=/jack/status/20`) works too.

That has two consequences, and both bite.

### Mastodon, Misskey, Lemmy and PeerTube: put the instance in the path

For those four there is no single host — the instance *is* part of the post's identity, and because
the host is ignored, passing the whole url loses it:

```
?url=https://lemmy.world/post/123456        ->  notfound
?url=/lemmy.world/post/123456               ->  the post
```

So move the instance into the path and drop the scheme:

| Site | Send |
|---|---|
| Mastodon | `?url=/mastodon.social/@Gargron/109384049300000000` |
| Misskey | `?url=/misskey.io/notes/9abcdefghi` |
| Lemmy | `?url=/lemmy.world/post/123456` |
| PeerTube | `?url=/tilvids.com/w/abcdefghijklmnop` |

This is the same shape the cards use — `https://mbedfx.app/lemmy.world/post/123456` is how a
fediverse link is swapped — so it is not a special case for the API so much as the general rule
showing through.

### Some paths belong to more than one site

Supplying the host does **not** break that tie. See [`ambiguous`](#ambiguous) below.

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

Two tables: the envelope, then `post`. **Every key listed here is always present.** Where a value can
be missing it is spelled `null` (or `""`, or an empty object/array) rather than by dropping the key —
with exactly one exception, `counts`, which is documented below and is the only place in the payload
where a key's absence carries meaning.

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
| `author.avatar` | string, absolute url on our origin | **yes** | yes |
| `counts` | object | no | yes — may be `{}` |
| `counts.likes` | integer > 0 | no | **no — key omitted when unknown** |
| `counts.reposts` | integer > 0 | no | **no — key omitted when unknown** |
| `counts.replies` | integer > 0 | no | **no — key omitted when unknown** |
| `counts.views` | integer > 0 | no | **no — key omitted when unknown** |
| `media` | array of objects | no | yes — may be `[]` |
| `media[].kind` | string, `"video"` or `"image"` | no | yes |
| `media[].url` | string, absolute url on our origin | no | yes |
| `media[].poster` | string, absolute url on our origin | **yes** | yes |
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

Derived by reading `toApiPost` (`src/worker.ts:2921-2987`) line by line and confirmed by driving the
endpoint offline through `handle()` with an injected post, 2026-08-04.

**Notes that are easy to get wrong from the table alone:**

- **`counts` is the one place a key disappears.** `apiCounts` (`src/worker.ts:2894-2902`) copies a key
  only when the value is a finite number greater than zero, so a count of zero is omitted rather than
  published. Upstreams use `0` for two different things — a genuinely uninteracted post, and a count
  the platform withholds — and nothing distinguishes them by the time it reaches us. An absent key
  means "we do not know". There is deliberately no way to say "we know, and it is none".
- **`width` and `height` are `0` far more often than they are `null`.** `0` is what several
  normalizers emit for "the platform did not tell us the size" (Reddit, TikTok covers, Threads,
  Facebook galleries, and every remuxed video, which carries `w: 0, h: 0` on purpose so a player reads
  the real dimensions out of the file). `null` only happens when the cached value was not a finite
  number at all. **Treat `0` and `null` the same: unknown. Do not divide by either.**
- **`width`/`height` describe the bytes at `url`, not the original video.** The published value is
  `posterW ?? w` and `posterH ?? h` (`src/worker.ts:2965-2966`), so a `still` entry reports the poster
  frame's size and not the video's.
- **On a `still: true` entry, `url` and `poster` are the same url.** Both address the poster slot,
  because that is where the bytes are.
- **`quote.author` has no `avatar`**, and `quote` has no `media`. The quoted post's own media is not
  published in v1; its entries live at indices after the outer post's and getting that arithmetic
  wrong would publish urls that resolve to the wrong bytes.
- **`quote` is `null` unless the quoted post carries an author object** (`src/worker.ts:2983`). A
  quote we could not attribute is not published as a half-quote.
- **`media` only contains entries that resolve to something servable.** An entry with no url is
  dropped, and the remaining entries are still addressed by their position in the *unfiltered* list,
  so the published urls stay correct.

### `createdAt` can be `null`, and that is not a bug

Some platforms do not tell us when a post was made, and for others the date arrives on a second,
slower call. When the date is genuinely unknown this says `null` rather than a plausible-looking
timestamp. Sort accordingly, and treat `null` as "unknown", never as "old".

### `counts` only contains what we know

A key is **absent** when the number is unavailable — including when the platform reports zero.
Upstreams use `0` for two different things, a genuinely uninteracted post and a count the platform
withholds (a hidden like count, a video with comments switched off), and nothing distinguishes them
by the time it reaches us. So an absent key means "we do not know", and there is deliberately no way
to say "we know, and it is none".

The possible keys are `likes`, `reposts`, `replies`, `views`. Which ones exist varies by site.

### `text` is display text, not just the author's words

`text` is what the card shows, which is not always only what the author typed. Three things can be
composed into it, and none of them has a structured field of its own in v1:

- a **translation**, followed by a `🌐 Translated from …` marker and then the original text;
- `🔞 Age-restricted on …` on a gated YouTube video (`sensitive` is also `true`);
- `🎬 Too long to play here — open it on …` on a video past the conversion ceiling.

If you need the author's untouched words, v1 cannot give them to you. Splitting them out is additive
and on the list.

### `still`: an image that is really a video

A video that has not finished converting, or one too long to convert at all, is published as an
`image` entry pointing at its poster frame. `still: true` marks those. Pair it with the top-level
`muxing` flag:

| `still` | `muxing` | |
|---|---|---|
| `false` | `false` | An ordinary picture. |
| `true` | `true` | A video is still converting. Ask again in a few seconds. |
| `true` | `false` | A video exists that we will not be able to serve — usually too long. This is final. |

Without `still`, that last row is indistinguishable from an ordinary photo except by reading English
prose out of `text`, which is not something a contract should ask of anyone.

### Media urls are ours

Every url in the payload points at `mbedfx.app`, never at the platform's CDN — so nothing in the
payload expires, and you have a stable url to hold on to.

Be aware of what that url does, because it varies: **converted video is served from our storage with
byte-range support**, so it seeks and downloads properly. **Images, avatars, posters and
already-progressive video are a `302` to the platform's CDN** — the redirect is stable even though
its destination is not, but the range support and the reachability past that hop are the platform's,
not ours. Two platforms (Instagram, Twitch) are proxied rather than redirected.

---


## The seventeen platform codes

`platform` is the two-letter code. **`tw` is Twitch. Twitter is `x`.** The two sit next to each other
in every list in this repo and that is the one pair worth reading twice.

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

The order is the README's. The codes are the seventeen in `Platform` (`src/types.ts:1`); the site each
one means is fixed by the canonical url the router rebuilds for it (`src/router.ts`: `bs` 197, `x`
205/210, `tt` 240, `th` 357, `rd` 387, `ig` 414, `yt` 435, `fb` 489-499, `dm` 651, `st` 672, `im`
698-700, `tw` 845/852/858, `pn` 1078; the four fediverse arms at 895/971/1011/1038 take their host
from the path instead).

**The Hosts column is where the link came from, not something the API reads.** Routing here is
host-agnostic, so what actually decides the answer is the path. Two consequences worth knowing before
you send anything:

- A short link whose code is a bare single path segment does **not** resolve through this endpoint.
  `?url=https://redd.it/1abc23` and `?url=https://dai.ly/x7abcde` answer `ambiguous` with candidates
  `["x","ig"]`, because `/1abc23` is also the shape of an X or Instagram profile and nothing in the
  path says otherwise. Driven offline against `route()`, 2026-08-04.
- The short links that *do* work are the ones whose path carries its own shape: `youtu.be/{11-char id}`
  (an 11-character segment is a YouTube id outright), `tiktok.com/t/{code}`, `reddit.com/r/{sub}/s/{code}`,
  and Meta's `/share/…` codes. Those are resolved with the same hop a pasted link gets.

## When the answer is not JSON

Every code in the table above arrives inside the envelope. Three things do not, and a client that
calls `.json()` unconditionally breaks on all three.

**A path that is not exactly `/_api/v1`.** `/_api/v2`, `/_api/v1/anything` and `/_api` never reach the
API arm at all — they are ordinary routes, and they answer the way any unrouted path answers. Measured
offline, 2026-08-04: `/_api/v2?url=…` returns **HTTP 404, `content-type: text/plain`, body
`not found\n`** to an ordinary client, and an HTML embed at HTTP 200 to a user agent we classify as
Discord. `/_api` returns an HTML chooser page at HTTP 300. None of them is the JSON contract. Pin the
path exactly.

**An unhandled exception.** There is no `try`/`catch` around the API arm, around `handle()`
(`src/worker.ts:3174`) or around the module's `fetch` handler (`src/worker.ts:4042-4051`) — verified by
reading all three. What is guarded is guarded individually and deliberately: the live upstream fetch
(`loadPost`, `src/worker.ts:2362-2366`), the three share-code and short-link resolvers
(`unwrapToPost`, `src/worker.ts:2649-2681`), the mux (`src/worker.ts:1445`) and the translation
(`src/worker.ts:2539`) all turn a throw into a normal answer, which is why an upstream that is down or
blocking us becomes `fetch_fail` at HTTP 200 rather than an error. What is **not** guarded is the
storage layer: the post-cache read and write in `loadPost` (`src/worker.ts:2350-2353`, `2372`, `2388`)
are left uncaught on purpose — its own comment says so — as is the R2 record read on the YouTube path.
If one of those throws, it propagates out of the Worker and Cloudflare answers with its own error page:
**Error 1101, "Worker threw a JavaScript exception"**, served as HTML with a 5xx status
([Cloudflare Workers errors](https://developers.cloudflare.com/workers/observability/errors/)). Error
1102 ("Worker exceeded CPU time limit") is the other runtime code you could see. Neither is ours and
neither is JSON.

**Anything Cloudflare answers on our behalf.** This runs behind Cloudflare's proxy, so the usual edge
errors (502, 520, 522, 524 and friends) can be returned as HTML without the Worker running at all.

So guard the parse. Branch on `ok` and `error.code` **after** you have confirmed you were given JSON,
not before:

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

Checking `res.status >= 500` is not enough on its own: the plain-text 404 above is a 4xx and still is
not JSON.

## How long a request can take

There is no timeout you can pass and no per-step limit. What bounds a request is a single budget taken
at the top of the shared pipeline (`describeTarget`, `src/worker.ts:2717`) and spent as a deadline on
the whole response rather than as an amount added after each step.

The constants, all in `src/worker.ts`:

| Constant | Value | What it bounds |
|---|---|---|
| `CARD_DEADLINE_MS` (= `MUX_WAIT_API_MS`) | **9000 ms** (`1307`, `1321`) | everything after the upstream fetch: the deadline the mux wait is measured against |
| `MUX_WAIT_FLOOR_MS` | **300 ms** (`1306`) | the floor under that wait, so a video already sitting in storage is not thrown away by a spent budget |
| `XLATE_MAX_WAIT_MS` | **1500 ms** (`2495`) | the translation's share of the budget |
| `XLATE_WAIT_FLOOR_MS` | **300 ms** (`2481`) | the floor under the translation's wait |
| `META_WAIT_API_MS` | **8000 ms** (`2185`) | **YouTube only**: the metadata extract, awaited after the two above |

The mux and the translation race concurrently (`src/worker.ts:2762-2770`), so they cost
`max(300, 9000 − elapsed)` between them, not the sum. The YouTube metadata warm runs after them
(`src/worker.ts:2790-2800`) and only when the post has no known date yet, so it adds up to 8000 ms on a
first request for a YouTube link and nothing thereafter.

**The upstream fetch itself is unbounded by this repository.** There is no `AbortSignal` anywhere in
`src/` — verified by grep — and Cloudflare places no wall-clock limit on an HTTP-triggered Worker
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/): "No limit … as long as
the client remains connected"). Only CPU time is capped, and this endpoint spends almost none of it.
So the arithmetic is:

```
total ≈ upstream fetch + max(300 ms, 9000 ms − upstream fetch) + (YouTube only: up to 8000 ms)
```

If the upstream answers within 8.7 s, that is **9.0 s**, or **17.0 s** on a cold YouTube link. If the
upstream is slower than that, the mux drops to its 300 ms floor and the total tracks the upstream.

**Recommend a 20-second client timeout**: 17.0 s worst case in the code, plus roughly 3 s for
connection setup and for an upstream slower than 8.7 s. **12 seconds** is enough if you never send
YouTube links. Do not set 5 or 10 seconds and conclude the service is down — you will be cutting off
requests that were about to answer.

For scale, the measurements those budgets were built from, all recorded in the source: a cold video
conversion is 6-9 s at ≤480p (`src/worker.ts:1275`, measured 2026-07-24), `yt-dlp -J` on YouTube is
2.3-6.7 s over five runs (`src/worker.ts:2168`, 2026-07-26), a Facebook metadata extract is ~3.0 s
(`src/worker.ts:1470`, 2026-07-25), and a translation is 217-798 ms (`src/worker.ts:2754`).

Two things make the slow case rarer than it looks. A complete answer is sent
`cache-control: public, max-age=900`, so anything caching in front of you absorbs repeats. And the post
itself is cached for 900 s (`POST_TTL`, `src/cache.ts:5`) independently of the response, so a second
request for the same post skips the upstream fetch even when the first answer was not cacheable. Note
that `/_api/v1` does not consult the response cache at all — only the post cache — so a cold post pays
the upstream fetch every time until that entry is warm.

## `muxing` and `pending`

Two flags that mean **the answer is incomplete, ask again in a moment**. Both responses are sent
`cache-control: no-store` so nothing between us caches a half-answer.

**`muxing: true`** — a video is still being converted. What you got is its poster still, published as
an `image` entry. The conversion is still running; re-request in a few seconds and it will be a
`video`.

**`pending: true`** — a translation lost its race. `text` is the original. The translation is still
being written; re-request and it will be there.

Neither is an error, and both clear on their own. A caller that ignores them gets a correct but less
complete answer.

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

**Branch on `ok` and `error.code`, not on the HTTP status.** Every answer *about a post* is `200`,
including the ones that say the post cannot be read. The `4xx`s are all about the request itself —
`400` for a missing or unreadable `url`, `405` for a write verb — and never about the post. This is the same rule we apply to the platforms we read: several of
them answer `200` with a login wall and `500` with a perfectly good JSON error, so a status code is
not where the answer lives.

`message` is prose for humans and may be reworded. `code` is the contract.

| `code` | Status | Means |
|---|---|---|
| `age_restricted` | 200 | The post exists behind an age gate. |
| `private` | 200 | The post exists behind a private account or a login wall. |
| `fetch_fail` | 200 | Could not be loaded — deleted, or the platform did not answer. |
| `ambiguous` | 200 | That path belongs to more than one site. Carries `candidates`. **Also where every profile url, bare handle and unrecognised one-segment path lands** — see below. |
| `notfound` | 200 | The path has a shape we route for nobody. |
| `bad_id` | 200 | A Mastodon-spoof-shaped path (`/users/{handle}/statuses/{id}`, `/api/v1/statuses/{id}`, `/_oembed/{id}`) whose id did not decode. Not reachable from an ordinary post url. |
| `not_a_post` | 200 | The path routes to something that is not a post: a site page (`/`, `/index.html`), one of our own endpoints (`/_media/…`, `/_prep`, `/_card`, `/_api/v1`), or an internal route kind we do not name. |
| `no_url` | 400 | No `url` parameter, **or an empty one**. `?url=` and no `url=` at all are the same answer. |
| `unparseable` | 400 | `new URL(value, our origin)` threw. Only a malformed **absolute** url does that. Anything that can be read as a path resolves against our own origin and gets a 200 answer instead. |
| `method_not_allowed` | 405 | This endpoint reads. Use `GET`. |

`platform` and `canonical` are `null` whenever the request did not get far enough to establish them,
and carry real values on `age_restricted`, `private` and `fetch_fail`. They are never guessed.
`candidates` appears on `ambiguous` and nowhere else.

### What these actually return

Driven offline through `route()` and `handle()`, 2026-08-04. This is the part most likely to surprise
you, so it is written down rather than left to be discovered.

| You send | You get | Why |
|---|---|---|
| a bare handle — `?url=jack` | `200` `ambiguous`, `candidates: ["x","ig"]` | one path segment, and both X and Instagram mint profiles at that shape |
| a profile url — `?url=https://x.com/jack` | `200` `ambiguous`, `candidates: ["x","ig"]` | the host is ignored, so this is the same request as the line above |
| a TikTok or Threads profile — `?url=https://www.tiktok.com/@charlidamelio` | `200` `ambiguous`, `candidates: ["tt","th"]` | the `@` narrows it to the two sites that use one |
| a junk string — `?url=not a url at all` | `200` `ambiguous`, `candidates: ["x","ig"]` | it resolves to the one-segment path `/not%20a%20url%20at%20all` |
| `?url=javascript:alert(1)` | `200` `ambiguous`, `candidates: ["x","ig"]` | `javascript:` parses fine as an absolute url; its path is `alert(1)`, one segment |
| an empty url — `?url=` | `400` `no_url` | the empty string is falsy, so it takes the missing-parameter branch |
| a malformed absolute url — `?url=http://[` | `400` `unparseable` | `new URL` throws. `https://` and `http://:` are the other spellings that do |

Two rules fall out of that, and they are the ones to design a client around.

**`unparseable` is much narrower than it sounds.** The target is parsed with a base — our own origin —
so a string only lands here if it fails url parsing outright, which in practice means a malformed
absolute url. Junk that merely does not name a post does not reach it.

**`ambiguous` is the catch-all for anything one segment long**, not just the contested paths the
chooser was built for. `/gallery/YcAQlkx` is the designed case; a handle, a profile url and a typo all
arrive at the same code with `["x","ig"]` because nothing in a single unrecognised segment says
otherwise. So: **`ambiguous` does not mean "this is a post on one of these sites"** — it means "this
path shape belongs to more than one site, and none of them has been asked". Walking the candidate list
is still the right move for a real contested path, and for a profile url every candidate will answer
`notfound`, because there is no profile route to reach (`/x/jack` → `notfound`, verified).

`platform` and `canonical` are `null` whenever the request did not get far enough to establish them.
They are never guessed.

**Failures are never cached** — not even `private`, which looks permanent. Accounts go public, gates
lift, deleted posts come back as reposts. Ask again whenever you like.

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

**A candidate is a site the path could belong to, not a promise the prefix will resolve.** `candidates`
comes from which sites claim that path *shape*; whether a given site then accepts that particular id
is a second question. `/rd/gallery/…` is the clearest case — Reddit's own gallery links are
deprecated upstream and we deliberately do not route them — so a caller walking the candidate list
should expect some of them to answer `notfound` and treat the first success as the answer.

**We do not use the host in your `url` to resolve this**, even though it would usually work. Letting
a caller-supplied hostname decide which site's fetcher runs is a decision we would rather not make on
a service where a hostname is also a thing we fetch. Sending the prefix is explicit and cannot be
turned into something else.

---

## Caching and limits

A complete answer is sent `cache-control: public, max-age=900`. Incomplete answers and failures are
`no-store`.

There is **no API key, no quota and no rate limiting in this repository.** Any limit in front of the
public instance is a rule on the zone, configured in the Cloudflare dashboard — nothing in the source
can tell you whether one exists or what its thresholds are, so this document does not claim one. If
you are self-hosting, you get no rate limiting by forking; add your own before you point anything at
it.

Please be reasonable. The expensive parts of a request are the upstream fetch, the video conversion
and the translation, and all three are shared with the people using the cards.

---

## Stability

`v1` is in the path so it is visible in a url you paste into a bug report. `/_api/v2` is deliberately
**not** served as v1 — asking for a version we do not have gets you a different contract than you
asked for, which is worse than an error.

What you get instead is not an API response at all: an unrecognised path is HTTP 404 with a
`text/plain` body of `not found`, the same answer any unrouted url gets. So a client that assumes
every reply is JSON will fail parsing rather than reading a code — see the non-JSON section above.

Within `v1`:

- Fields will be **added**, never removed or retyped.
- `error.code` values will be added; existing ones keep their meaning.
- `error.message` wording may change. Do not match on it.
- Two-letter platform codes are stable.

Not in v1, and each is additive if it lands later: media on a **quoted** post (its entries live at
indices after the outer post's, and getting that arithmetic wrong would publish urls that resolve to
the wrong bytes), an opt-in translation parameter, profile lookups, and any form of batch request.

---

## What this is built on

The same pipeline as the card and the converter preview — one function fetches, waits for the video,
waits for the translation and applies the per-platform overlays, and the three surfaces differ only
in how they serialise the result. That is not an implementation detail so much as the point: this
project's most repeated defect has been teaching one surface something its twin did not learn, and a
published contract is the worst place to discover a new instance of it.
