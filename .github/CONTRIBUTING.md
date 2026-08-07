# Contributing to mbedfx

Bug reports, feature requests and pull requests are all welcome.

## Reporting a bug

Open a [bug report](../../../issues/new/choose). **Include the link.** Almost every bug here is one specific post rather than a whole site, and without the link there's nothing to test against.

Check these first, because they look like bugs and are not:

- Cards are cached for about 15 minutes. A card that just failed may already be fixed.
- A cold video takes a view or two. The first request starts the mux, the card shows the cover image while it runs, and the next view plays the video.

## Reporting a security problem

Do not open a public issue. [SECURITY.md](SECURITY.md) routes to GitHub's private advisory form, which only the maintainer can see.

## Development

```bash
npm install
npm test              # 1207 tests, no network
npm run typecheck
npx wrangler dev      # local worker
```

`npm run build` runs the suite and a type check. Cloudflare Workers Builds, the only system that deploys this Worker, runs it before deploying, so a red suite ships nothing. GitHub Actions runs the same two steps on pushes to `main` and `staging` and on every pull request; those checks do not gate the deploy.

Do **not** deploy by hand. Workers Builds watches `main`, so merging is the deploy, and `npm run deploy` refuses on purpose. A hand deploy overwrites whatever the build shipped, and prod goes on looking healthy while the pipeline is broken. That has cost the project real downtime once already.

## What gets a PR sent back

### Assert on content, never on status

Several upstreams here answer `HTTP 200` with a decoy. Instagram's is a 599 KB page with no post in it; others have been a login wall and an empty shell. `res.ok` is true for all of them. Check the body for the thing the code needs.

### Say where you measured

Measure from a Worker, and say so in the comment. A datacenter IP and a residential one get different bytes from the same URL. Facebook's 302, Reddit's anonymous reads and Google Translate's `sl=auto` all worked from a laptop and did nothing from a Worker.

### Comment the why, not the what

The code says what it does. A comment carries the measurement behind a value, the approach that was tried and didn't work, and what breaks if this gets "simplified". If you call a rule deliberate, say what goes wrong without it.

### Don't guess

Never invent a title, an author or a thumbnail. When something cannot be determined the card says so: there are private and age-gated cards, and a plain "couldn't load" for everything else.

### Fetching and normalising are separate

Keep judgement in the pure half. Each platform has a `fetch.ts` that does I/O and a `normalize.ts` that is pure and tested against captured fixtures with no network.

## Tests

`node --test`, no framework. Fixtures live in `test/fixtures/`.

Test names are sentences that state the rule. The body explains the defect it prevents. Read an existing test before writing one, or the next reader can't tell a broken rule from one changed on purpose.

Tests must not touch the network. If your test needs an upstream, stub `fetch`.

## Pull requests

- One concern per PR.
- `npm run build` green.
- If you changed behaviour, **rewrite the test that pinned the old behaviour instead of deleting it**, and say in the comment what changed and why. A deleted assertion leaves no trace of having been wrong.
- Update `docs/CHANGELOG.md` for anything user-visible.

There is no CLA. By opening a PR you agree your contribution is licensed under the [MIT License](../LICENSE).

## Adding a site

Roughly, in order:

1. A `Route` arm in `src/router.ts`, plus a `PostRef` variant, plus the `parseRefKey` allowlist entry. Forgetting the allowlist entry 404s every image on the new platform.
2. `src/platforms/<site>/fetch.ts` and `normalize.ts`.
3. A dispatch arm in `src/worker.ts`.
4. A captured fixture and normalizer tests.
5. A row in the converter page's site table and in the README.

All five assume there is a surface the platform will serve to a datacenter IP with no account. Finding one takes longer than writing any of them. Find it first, and bring the measurement with you.
