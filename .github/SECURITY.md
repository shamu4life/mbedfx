# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting instead. [Report a vulnerability](https://github.com/shamu4life/mbedfx/security/advisories/new) opens an advisory only the maintainer can see. If private reporting is unavailable, use the contact details on the [@shamu4life](https://github.com/shamu4life) GitHub profile.

There's no bug-bounty program. It's a hobby project. Credit in the advisory is gladly given on request. The aim is to acknowledge a report within a few days.

## What is in scope

mbedfx is an edge Worker that fetches other people's pages and renders them into embed cards. The interesting surface is mostly what it can be made to fetch, serve, or leak:

- **SSRF.** Inducing the Worker to fetch an internal address, its own zone, or an arbitrary host. The fediverse routes are the hard case, since a fediverse ref legitimately names its own origin.
- **Injection into a rendered card.** Breaking out of `og:` markup, the Mastodon-shaped JSON, or the converter page's DOM.
- **Cache poisoning.** One post's card, media, or translation comes back under another post's key.
- **Leaking a reader.** Anything that carries information about who is looking to an upstream. From its own egress, the Worker deliberately sends only the post's own public text.
- **Serving unbounded bytes.** The media proxy streaming something it should have refused.

## What is not a vulnerability (by design)

- **Undocumented upstream endpoints.** That's how mbedfx reads a post. The endpoint that most needs an off switch has one. `TRANSLATE_GOOGLE=off` stops the calls to Google in seconds and needs no deploy, whether the reason is a 403 wave or a letter.
- **Deleted posts.** A card is cached for a bounded time. It can outlive the post it drew from.
- **Private or age-gated posts.** Not rendering them is correct behaviour. The card says so.
- **No accounts means no auth bugs.** Nothing to log in to, no user data at rest.
- **Rate limits.** There is no per-reader rate limiting, and no promise of one.

## Supported versions

The deployed Worker is whatever's on `main`. There are no maintained release branches: a fix goes to `main` and deploys on merge.
