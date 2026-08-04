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

| Field | |
|---|---|
| `platform` | Two-letter site code — `x` `tt` `ig` `th` `rd` `bs` `yt` `fb` `tw` `pn` `dm` `st` `im` `ms` `mk` `lm` `pt`. |
| `canonical` | The post's own url on its own site, with tracking parameters stripped. |
| `createdAt` | ISO 8601 UTC, **or `null`** — see below. |
| `title` | A headline distinct from the body. Reddit has one; most sites do not, and it is `null` there. |
| `text` | The caption or body — **as the card displays it**, notes included. See below. `""` when there is none, or when the cached value was not a string. |
| `sensitive` | Whether the platform marked the post sensitive. |
| `author.avatar` | `null` when the platform did not give us one. |
| `counts` | **Only the counts we actually have** — see below. |
| `media` | Only entries that resolve to something servable. `kind` is `"video"` or `"image"`; a GIF is a video. |
| `media[].poster` | The still frame. `null` when the entry has none. Non-`null` on an `image` entry when that image is a video's stand-in — see `still`. |
| `media[].still` | `true` when this `image` is standing in for a video. See below. |
| `quote` | The quoted post — `canonical`, `text`, `author`. Depth is capped at 1, so it never nests. |

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
| `ambiguous` | 200 | That path belongs to more than one site. Carries `candidates`. |
| `notfound` | 200 | The url does not name a post on any site we read. |
| `bad_id` | 200 | The right url shape, but the id in it is not valid for that site. |
| `not_a_post` | 200 | The url resolves to something else — a profile, a home page, one of our own endpoints. |
| `no_url` | 400 | No `url` parameter. |
| `unparseable` | 400 | The `url` value could not be read as a url at all. A value that merely does not name a post is `notfound`, not this. |
| `method_not_allowed` | 405 | This endpoint reads. Use `GET`. |

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
**not** served as v1 — asking for a version that does not exist gets you a `notfound`, not a
different contract.

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
