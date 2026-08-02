# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting instead — [**Report a vulnerability**](../../security/advisories/new) — which opens a private advisory only the maintainer can see. If that is unavailable to you, contact [@shamu4life](https://github.com/shamu4life) through the contact details on the GitHub profile.

There is no bug-bounty program; this is a hobby project. Credit is gladly given in the advisory if you would like it.

I aim to acknowledge a report within a few days.

## What is in scope

This is an edge worker that fetches other people's pages and renders them into embed cards, so the interesting surface is mostly about what it can be made to fetch, serve, or leak:

- **SSRF** — inducing the worker to fetch an internal address, its own zone, or an arbitrary host. The fediverse routes are the sharp edge here, because a fediverse ref legitimately names its own origin.
- **Injection into a rendered card** — anything that escapes `og:` markup, the Mastodon-shaped JSON, or the converter page's DOM.
- **Cache poisoning** — making one post's card, media, or translation serve under another post's key.
- **Leaking a reader** — anything that carries information about *who is looking* to an upstream. The worker deliberately sends only the post's own public text and its own egress.
- **Serving unbounded bytes** — making the media proxy stream something it should have refused.

## What is *not* a vulnerability (by design)

- **It uses undocumented upstream endpoints.** That is the whole mechanism. The one that most needs an off switch has one: `TRANSLATE_GOOGLE=off` stops using Google's endpoint in seconds, no deploy, whether the reason is a 403 wave or a letter.
- **A card renders a post the poster later deleted.** Cards are cached for a bounded time; the cache expires.
- **A private or age-gated post fails to render.** That is correct behaviour, and the card says so.
- **The site has no accounts, so it has no auth bugs.** There is nothing to log in to and no user data at rest.
- **Rate limits.** There is no per-reader rate limiting and no promise of one.

## Supported versions

The deployed worker is whatever is on `main`. There are no maintained release branches — fixes go to `main` and deploy on merge.
