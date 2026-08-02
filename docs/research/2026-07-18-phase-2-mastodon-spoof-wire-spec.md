# Phase 2 — authoritative wire spec (evidence-derived, 2026-07-18)

This supersedes the Phase 2 plan wherever they disagree. Everything below marked
VERIFIED was observed live against `fxbsky.app` (FxEmbed build
`fixtweet-main-9f57d26-2026-07-18T05:27:37`) or read from FxEmbed's MIT source at
commit `9f57d264`. FxEmbed ships this spoof to 100% of its Discord traffic, so
"what FxEmbed does" is the strongest available evidence about what Discord accepts.

Where we deliberately differ from FxEmbed, it is called out as DEVIATION with a reason.

---

## 1. The status id must be NUMERIC (plan was risky)

VERIFIED, two independent ways:

- Live decode: the advertised id for the 4-image fixture is 78 digits. Each *pair*
  of digits indexes a base64-ish alphabet (a/A→00 … z/Z→25, 0-9→52-61, `"`→66,
  `:`→67, `,`→68, `.`→69). It decodes to exactly
  `"i":"3mqscrhxmsc2v","h":"timosborne.ca"` — the brace-stripped body of
  `{"i":"<rkey>","h":"<handle>"}`. Confirmed on 4 handles; length varies with
  handle length (78 digits for a 13-char handle, 74 for an 11-char one).
- Source: `src/helpers/snowcode.ts` JSON-stringifies a params object, strips the
  outer braces, and maps each char to its 2-digit index in a 72-char alphabet.

The point is not the exact alphabet — it is that FxEmbed goes to real trouble to make
the segment **pure digits, so it looks like a Mastodon snowflake id**. Real Mastodon
ids are numeric. The plan's "pack `refKey` into `{id}`" would put letters, `:` and
`%3A` there.

The risk is asymmetric and severe: if Discord requires a numeric-looking id and we
emit `bs%3Aalice…`, the spoof silently does nothing — and because the spoof path
emits ZERO `og:image`, the fallback is *worse* than Phase 1 ships today. Emitting
numeric when Discord doesn't care costs nothing.

**DECISION — new module `src/statusid.ts`:**

```
encodeStatusId(key: string): string   // UTF-8 bytes -> 3-digit zero-padded decimal each
decodeStatusId(id: string): string | null   // total; null on junk, never throws
```

DEVIATION from FxEmbed: 3-digit-per-byte instead of their 2-digit-per-char alphabet.
Simpler, total over all byte values (no "disallowed char" retry path like theirs), and
equally pure-digit. Reject on: empty, any non-digit, `length % 3 !== 0`, any group
> 255, or invalid UTF-8. Must be an exact inverse of `encodeStatusId` — test with a
round-trip over the same 7-variant `PostRef` table `cache.test.mjs` already uses,
DID handles included.

**Bonus:** because the wire form is now pure digits, it contains no `%` at all, so
the double-decode hazard below disappears for these routes.

---

## 2. Router — shape-match with FALLTHROUGH, never "reserve" (plan wording is dangerous)

The plan says *"Reserve `api`, `users`, `_oembed` as root tokens."* **Do not.**
"Reserve" means dead-end, and dead-ending is precisely the Phase 1 bug fixed in
`37386db` (`/x/status/123` — a real post by @x — returned notfound).

VERIFIED by content-probing x.com (live handles return the React SPA shell; dead ones
return the static `<html class="dog">` error page — status codes agree but content is
the load-bearing check):

| handle | live on x.com? |
|---|---|
| `api` | **YES** |
| `_media` | **YES** |
| `_alt` | **YES** |
| `users` | no |
| `_oembed` | no |

So `/api/status/123` routes as a real X post **today** and must keep doing so.

Add two helpers beside `bluesky()`/`x()`, called **after** the `_alt` dead-end and
**before** the `ESCAPE` block. Both return `null` on any miss so control falls through
to `ESCAPE` → `matchPost` → `known` → `ambiguity()`:

- `activity(seg)`: `seg.length === 4` and either
  (`seg[0]==='api' && seg[1]==='v1' && seg[2]==='statuses'`) or
  (`seg[0]==='users' && seg[1] && seg[2]==='statuses'`), then
  `decodeStatusId(seg[3])` → `parseRefKey` → `{kind:'activity', ref}` or `null`.
- `oembed(seg)`: `seg.length === 2 && seg[0]==='_oembed' && seg[1]`, then the same
  decode chain → `{kind:'oembed', ref}` or `null`.

Both read **`seg`** (already decoded once at the `raw.map(safeDecode)` line), and must
**not** call `safeDecode` themselves. The plan's phrase "identical handling to
`/_media/`" invites a second decode; that is a real bug, proven by execution:

```
wire     : bs%3Adid%253Aplc%253Az72i…%3A3l6o
decode x1: bs:did%3Aplc%3Az72i…:3l6o   -> parseRefKey OK
decode x2: bs:did:plc:z72i…:3l6o       -> split(':') = 5 parts -> NULL
```

That would 404 every Bluesky DID-handle URL, silently.

Do **not** add these tokens to the `known` set — that set is a dead-end list.

The ambiguity table must be a strict no-op: `/api`, `/users`, `/_oembed` stay
`ambiguous ['x','ig']`; `/api/v1`, `/users/someone` stay `notfound`. That invariant is
only true under fallthrough, which makes it the acceptance test for this task.

**TS2366:** `worker.ts`'s `switch (r.kind)` has no `default` and tsconfig is `strict`,
so adding two `Route` kinds without their `case`s is a compile error. Router + worker
must land in ONE commit.

### Pre-existing bug found, NOT fixed here (out of scope — flagged for the user)

`@_media` and `@_alt` are live X accounts, and both branches dead-end, so
`/_media/status/123` is notfound today — shadowing a real post permalink and falsifying
the invariant claimed at `router.ts:12`. Same bug class, already shipped. Pin current
behavior with a `KNOWN:` test so a future fix is deliberate, and leave it alone.

---

## 3. Counts placement — ONE SLOT PER CONSUMER SURFACE (settles the plan's ambiguity)

VERIFIED across 6 posts. FxEmbed puts counts in **both** oEmbed `author_name` **and**
Mastodon `content` — and this does *not* double-render, because the two surfaces have
disjoint consumers:

- **OpenGraph path:** body from `og:description` (**no counts**) + author line from
  oEmbed `author_name` (counts). One render.
- **Mastodon path:** counts inline in `content`. Discord prefers activity data and
  does not use oEmbed for the body. One render.

**The trap is therefore `og:description` + `author_name`, not `content` + `author_name`.**
Our spoof path emits an `og:description` fallback, so: **`og:description` must never
carry counts.** `buildPlainText` is used for `og:description` and must stay counts-free.

`author_name` is a single-purpose priority slot, VERIFIED (counts win over reply
context; zero-valued metrics are omitted entirely):

1. any nonzero count → `💬 5   🔁 14   ❤️ 140` (three literal spaces between; omit any
   metric that is 0 or absent)
2. else if reply → `↪ Replying to @handle`
3. else → the literal string `Embed`

---

## 4. Newlines — U+FE00 pairs, not a hair space (plan is wrong)

The plan says insert `&hairsp;`/a space between *consecutive* `<br>`. FxEmbed actually
appends **two U+FE00 (VARIATION SELECTOR-1)** after **every** newline-derived `<br>`,
unconditionally. VERIFIED by codepoint dump and by isolating a single-newline post:

```
…DDoS) attacks.<br>︀︀We have not seen…
```

U+FE00 is invisible and non-whitespace, so a blank line is never trimmed or collapsed.

- Text newlines: `esc(text).replace(/\n/g, '<br>︀︀')`
- FxEmbed's own **structural** separators use bare `<br><br>` with **no** U+FE00 —
  that is how you tell a user's blank line from a generated gap. Match this.

---

## 5. Gate the spoof on HAS-MEDIA, not on multi-image (plan implied always-for-discord)

VERIFIED by sweeping 0/1/2/3/4-image posts from one author:

- post **with** 1+ images → ZERO `og:image`, `twitter:card=summary_large_image`, activity link present
- post with **0** images → exactly ONE `og:image` (the author avatar), `twitter:card=summary`

So: `spoof = client === 'discord' && post.media.length > 0`.

This is also the low-risk choice: it leaves text-only posts on the exact plain-og path
a human already confirmed rendering correctly in a real Discord client at the end of
Phase 1 (see the GATE PASSED note in `progress.md`). Quote context still reaches those
posts through `og:description`, which FxEmbed also does (its quote page's
`og:description` carries a plaintext `Quoting Name (@handle)` rendering).

---

## 6. Exact payloads

### 6a. HTML head, spoof path (`discord` + has media)

Emit ONLY:
```
<meta property="og:title" content="{Name} (@{handle})"/>
<meta property="og:description" content="{buildPlainText(post)}"/>   <-- NO counts
<meta property="og:url" content="{canonical}"/>
<meta property="og:site_name" content="fxeverything"/>
<meta name="theme-color" content="#0085ff"/>
<link rel="alternate" type="application/activity+json" href="{origin}/users/{handle}/statuses/{numericId}"/>
<link rel="alternate" type="application/json+oembed" href="{origin}/_oembed/{numericId}"/>
```
**No `og:image`, no `og:video`, no `twitter:card`, no `twitter:image`.**
VERIFIED as the suppression mechanism in source — `src/embed/status.ts:449` skips the
entire media block: `if (!useActivity && !flags?.textOnly) {`.

Keep every attribute **double-quoted** — `esc()` does not escape `'`.

### 6b. Non-spoof path (`other-bot`, and `discord` with no media)

Unchanged Phase 1 `renderPost` output. Additionally, for `discord` only, emit the
oEmbed link so counts reach the author line. Do NOT emit it for `other-bot` — an
oEmbed with `type:"rich"` and no `html` violates the oEmbed spec and we have no
evidence about how Slack/Facebook react.

### 6c. `GET /api/v1/statuses/{numericId}` and the `/users/…` alias

`Content-Type: application/json` (VERIFIED: no charset parameter).

```jsonc
{
  "id": "{numericId}",
  "url": "{canonical}", "uri": "{canonical}",
  "created_at": "{post.createdAt.toISOString()}",
  "edited_at": null, "reblog": null,
  "in_reply_to_id": null, "in_reply_to_account_id": null,
  "language": null,
  "content": "{buildContentHtml(post)}",
  "spoiler_text": "",
  "visibility": "public",
  "application": { "name": "Bluesky Social", "website": null },
  "media_attachments": [ /* see below */ ],
  "account": {
    "id": "{handle}", "display_name": "{name}",
    "username": "{handle}", "acct": "{handle}",
    "url": "{author.url}", "uri": "{author.url}",       // DEVIATION: FxEmbed wrongly puts the POST url here
    "created_at": "{post.createdAt.toISOString()}",     // we have no join date; deterministic stand-in keeps the mapper pure
    "locked": false, "bot": false, "discoverable": true,
    "indexable": false, "group": false,
    "avatar": "{/_media/{key}/avatar}", "avatar_static": "same",  // omit both if no avatar
    "followers_count": 0, "following_count": 0, "statuses_count": 0,
    "hide_collections": false, "noindex": false,
    "emojis": [], "roles": [], "fields": []
  },
  "mentions": [], "tags": [], "emojis": [], "card": null, "poll": null
}
```

`media_attachments[i]`:
```jsonc
{
  "id": "{i}",                       // DEVIATION: FxEmbed hardcodes ONE id for all 4; distinct is strictly safer
  "type": "image" | "video" | "gifv",
  "url": "{origin}/_media/{encodeURIComponent(refKey)}/{i}",   // NEVER a raw CDN url (project constraint)
  "preview_url": "{same}",
  "remote_url": null, "preview_remote_url": null, "text_url": null,
  "description": "{alt ?? null}",
  "meta": { "original": { "width": w, "height": h, "size": "{w}x{h}", "aspect": w/h } }
}
```
DEVIATION on dimensions: the plan says apply Phase 1's `fudge()`. Evidence says
FxEmbed sends **true** dimensions for images (4000x2250 etc. — mixed orientations
preserved, all 4 render) and only size-multiplies **video**. Follow the evidence:
images true, video fudged. Guard `aspect` against `h === 0` (JSON.stringify(Infinity)
silently becomes `null`).

DEVIATION on media urls: FxEmbed emits raw `cdn.bsky.app` URLs. We must not — signed
URLs expire, and `/_media/` is a hard project constraint. Phase 1 already proved
Discord's media proxy follows our percent-encoded `/_media/` 302 to a real image.

### 6d. `GET /_oembed/{numericId}`

`Content-Type: application/json`. Exactly these 7 fields (FxEmbed omits
`html`/`width`/`height` despite `type:"rich"` because Discord reads only these):

```json
{ "author_name": "…", "author_url": "{canonical}", "provider_name": "fxeverything",
  "provider_url": "{origin}", "title": "Embed", "type": "rich", "version": "1.0" }
```

### 6e. `buildContentHtml(post)` — Mastodon `content`

Composition order, matching FxEmbed:
1. reply prefix, if any:
   `<sub>↩ <a href="{author.url}" class="u-url mention">{Name} (@{handle})</a></sub><br>`
   (plain `<br>`, no U+FE00 — structural)
2. post text with `\n` → `<br>︀︀`
3. quote, if any — preceded by bare `<br><br>`:
   `<blockquote><b><a href="{quote.canonical}">Quoting</a> {Name} (<a href="{quote.author.url}">@{handle}</a>)</b><br>︀<br>{quoted text}</blockquote>`
   (note: exactly ONE U+FE00 in the quote's internal separator — verified)
4. counts, if any nonzero — preceded by bare `<br><br>`:
   `<b>💬 5&ensp;🔁 14&ensp;❤️ 140&ensp;</b>` (trailing `&ensp;` included; omit zero metrics)

Discord renders `<b> <i> <a> <blockquote> <br> <code> <pre>`; `<img> <ul> <h1>` do not
render. `<sub>` is used by FxEmbed and evidently renders acceptably.

Counts are abbreviated at scale by FxEmbed (`1.1K`, `8.1K`) — implement `abbrev(n)`.

Depth is 1: `post.quote.quote` is always undefined (normalizer guarantee). The builder
must not assume it, but need not recurse.

### 6f. `buildPlainText(post)` — `og:description`, COUNTS-FREE

```
{↩ Name (@handle)\n}?  {text}  {\n\nQuoting Name (@handle)\n\n{quote text}}?
```
Sensitive marker stays Phase 1's `[sensitive] ` prefix, applied by the renderer.

---

## 7. Quote media hoisting (own task, own commit)

VERIFIED: FxEmbed hoists a quoted post's images into the **parent's**
`media_attachments`. Proven by resolving the attachment's DID — it belongs to the
quoted author, not the post author — and matching the CID byte-for-byte.

Phase 1 fought a real bug to *extract* this data (Task 6: quote media was always
dropped because `viewRecord` uses plural `embeds`). Dropping it at render would waste
that fix, and a quote-only post would otherwise render with no image at all.

Cheapest correct implementation, requiring **no** router or type change: introduce
`mediaList(post) = [...post.media, ...(post.quote?.media ?? [])]` and have BOTH
`pickMedia` and the Mastodon mapper index into it. Parent media keeps indices
0..n-1, so every existing `/_media/` URL and Phase 1's `og:image` path are unchanged —
this is purely additive.

Land it as a separate commit so it is independently revertible.

---

## 8. Analytics

Add `api_hit` / `api_miss` to `Outcome2` for the two new routes. Do NOT reuse
`media_hit`/`media_miss` — the spec's fetch-amplification alert watches that ratio and
folding a second traffic class into it would blind the alert. Do not reuse `ok` either;
that tracks post-HTML renders.

---

## 9. Known-unverifiable until a real Discord client sees it

- That Discord accepts our **numeric-but-not-FxEmbed-scheme** id.
- That Discord's media proxy resolves `/_media/` URLs inside `media_attachments`
  (it does for `og:image` — proven live in Phase 1 — but the gallery path is untested).
- iOS multi-image rendering (the plan calls this the known weak spot).
- That `<sub>` and `<blockquote>` render as expected in current Discord builds.

The embed debugger does NOT render these paths faithfully. Desktop + Android + iOS.

---

# CORRECTIONS (added after the recon synthesis, same day)

The synthesis agent re-measured several things live and overturned two claims above.
**These corrections win over anything earlier in this document.**

## C1. §5 was WRONG — the activity link is ALWAYS emitted for Discord

§5 above said `spoof = discord && post.media.length > 0`. That was my inference from
"text-only posts emit one og:image", and it is wrong. The synthesis fetched 5 fixtures
(0/1/4 images, quote, reply) and measured `activity=1` on **all five**.

Two independent gates, not one:

- **The activity+json and json+oembed links: emitted for EVERY `discord` response**,
  regardless of media. Gating them on media would silently drop rich text, reply
  context, quote blockquotes and counts from every text-only post.
- **`og:image` is what's gated on media**, and the trigger is `>= 1` media, not `> 1`:

| media count | og:image | twitter:card |
|---|---|---|
| >= 1 | **zero** | `summary_large_image` |
| 0 | **exactly one** (the avatar) | `summary` |

`mediaCount` must include **hoisted quote media** (§7), or a quote-only post gets both
an avatar og:image and a populated `media_attachments`.

This also means the earlier claim "no twitter:card on the spoof path" is wrong —
`twitter:card` IS emitted on both branches, with the value from the table.

## C2. The status id needs a NONZERO LEADING SENTINEL

A real hazard my §1 scheme missed. 3-digit-per-byte encoding of a refKey beginning with
`b` (98) starts `098…`. Any layer that treats the segment as a number — and Discord may
well, since real Mastodon ids are numeric snowflakes — eats the leading zero via
`parseInt`, after which `length % 3 !== 0` and decode fails.

**Prefix the encoded string with a constant nonzero digit (`1`) and strip it on decode.**
`decodeStatusId` must reject anything not starting with that sentinel. Cheap insurance
against a failure mode that would be invisible in local tests and total in production.

## C3. Smaller corrections

- **`theme-color`**: the proven head uses `property="theme-color"`. Our existing
  `errorEmbed()` in `src/render/fail.ts` uses `name="theme-color"`. Use `property=` on
  the spoof path; note the `fail.ts` inconsistency rather than silently diverging.
- **`<link rel="canonical" href="{canonical}"/>`** is present in the proven head. Emit it.
- **`media_attachments[].id`**: keep unique ids, but add a comment recording that
  FxEmbed's hardcoded `"114163769487684704"` is the production-proven value and is the
  first thing to try if multi-image fails in a real client.
- **oEmbed `title`**: the constant string `"Embed"` (already correct in §6d). It doubles
  as the `author_name` fallback. Empty string is untested — do not use it.
- **Never emit `replies_count` / `reblogs_count` / `favourites_count`.** Verified absent
  from FxEmbed's payload. Keeping them absent makes a third count-render structurally
  impossible.
- **Telegram**: FxEmbed serves Telegram a *mosaic* composite plus
  `al:android:app_name="Medium"`. We have no mosaic service, so our single-image Telegram
  output is an **accepted divergence**, not an unfinished feature. Record it as such.

## C4. The one thing that stays genuinely unresolved

**Does Discord read oEmbed `author_name` while also consuming the activity Status JSON?**
Both links are present in the same head (re-confirmed live), so if Discord consumes both,
counts render twice — once in the author line, once in the body tail.

No probe opened a real Discord client, so this cannot be settled from here. It is the
first thing to look at during the Task 7 live gate: post a link with nonzero
likes/reposts/replies and check whether the stats string appears once or twice.

If it appears twice, the fix is one line — drop the counts suffix from
`buildContentHtml`, since `author_name` is the surface FxEmbed proved works on the
OpenGraph path. Structure the code so that is a one-line change.
