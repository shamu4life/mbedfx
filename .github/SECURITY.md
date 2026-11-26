# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting instead. [Report a vulnerability](https://github.com/shamu4life/mbedfx/security/advisories/new) opens an advisory only the maintainer can see. If private reporting is unavailable, use the contact details on the [@shamu4life](https://github.com/shamu4life) GitHub profile.

There's no bug-bounty program, since it's a hobby project. Credit in the advisory is gladly given on request, and the aim is to acknowledge a report within a few days.

## What is in scope

mbedfx fetches other people's pages and renders them into embed cards, as a Cloudflare Worker or, through `adapters/node/` and its Docker images, on any host. The interesting surface is mostly what it can be made to fetch, serve, or leak:

- SSRF: inducing the Worker to fetch an internal address, its own zone, or an arbitrary host. The fediverse routes are the hard case, since a fediverse ref legitimately names its own origin.
- Injection into a rendered card: breaking out of `og:` markup, the Mastodon-shaped JSON, or the converter page's DOM.
- Cache poisoning: one post's card, media, or translation comes back under another post's key.
- Leaking a reader: anything that carries information about who is looking to an upstream. From its own egress, the Worker deliberately sends only the post's own public text.
- Serving unbounded bytes: the media proxy streaming something it should have refused.
- The resolver's and the relay's locks: reaching the container's `/resolve` without `RESOLVER_SECRET` where it is set, or the Reddit relay without its key.
- Secrets where they shouldn't be: an account pool (`*_ACCOUNTS`), a client secret or `RESOLVER_SECRET` showing up in a response, a card, a counter, a log line or the adapter image.
- The converter page's config block: a value that breaks out of the script block `src/sitepage.ts` writes into the page.

## What is not a vulnerability (by design)

- Undocumented upstream endpoints: that's how mbedfx reads a post. The endpoint that most needs an off switch has one. `TRANSLATE_GOOGLE=off` stops the calls to Google in seconds and needs no deploy, whether the reason is a 403 wave or a letter.
- Deleted posts: a card is cached for a bounded time, so it can outlive the post it drew from.
- Private or age-gated posts: not rendering them is correct behaviour, and the card says so.
- Reader accounts: there is nothing for a reader to log in to and no reader data at rest. The resolver's shared secret, the relay key and an operator's account pools are in scope (above).
- Rate limits: there is no per-reader rate limiting, and no promise of one.

## Supported versions

mbedfx.app runs whatever is on `main`, and a fix deploys when it merges. If you run your own copy, the supported version is the latest release (the `vX.Y.Z` tags, with notes in CHANGELOG.md). There are no maintained release branches. A problem in someone else's deployment that isn't in this code, such as a setting they chose, goes to whoever runs it.
