# Contributing to mbedfx

Bug reports, feature requests and pull requests are all welcome. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug

Open a [bug report](../../../issues/new/choose). **Include the link.** Almost every bug here is one specific post rather than a whole site, and without the link there's nothing to test against.

Check these first, because they look like bugs and are not:

- Cards are cached for about 15 minutes. A card that just failed may already be fixed.
- A cold video starts on its cover image. The first paste starts the mux, and that message keeps the cover for good, because Discord stores an embed in the message it was posted in. A later paste of the link plays the video, though Discord can reuse its own copy of the card for about 30 minutes.
- A bug on a copy that someone else runs, rather than mbedfx.app, may come from how they set it up. Say which deployment it was.

## Reporting a security problem

Do not open a public issue. [SECURITY.md](SECURITY.md) routes to GitHub's private advisory form, which only the maintainer can see.

## Development

```bash
# Node 22.18 or later (.node-version). Older versions can't load the .ts files.
npm install
npm test                  # about 2,000 tests, no network
npm run typecheck
npm run test:container    # the resolver's Python tests; needs python3
npx wrangler dev          # local Worker; needs Docker for the container, or add --enable-containers=false
```

Under `wrangler dev`, Workers AI always calls Cloudflare, so it uses your wrangler login and can bill. To run with no Cloudflare at all, start the Node adapter: `CONTAINER_URL=off node adapters/node/server.ts` ([docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md#run-it-on-node-without-docker)).

`npm run build` runs the suite and a type check. Cloudflare Workers Builds, the only system that deploys this Worker, runs it before deploying, so a red suite ships nothing. GitHub Actions runs the same two steps, plus the container's Python tests (`npm run test:container`), on pushes to `main` and on every pull request. Those checks don't gate the deploy.

Do **not** deploy mbedfx.app by hand. Workers Builds watches `main` and runs `npx wrangler deploy -c wrangler.production.jsonc` on each merge, so merging is the deploy. A hand deploy of that file overwrites whatever the build shipped, and prod goes on looking healthy while the pipeline is broken. That has cost the project real downtime once already.

`npm run deploy` deploys something else: the root `wrangler.jsonc`, a generic config that makes a separate Worker called `mbedfx-selfhost` in whatever Cloudflare account wrangler is logged into. It gets its own container, R2 bucket and half-hourly cron, and Cloudflare bills it like any other Worker. Self-hosters want exactly that. As a contributor, don't run it by accident. To check that a config change still deploys, use a dry run, which uploads nothing and needs no login:

```bash
npx wrangler deploy --dry-run                             # builds the container image, so Docker must be running
npx wrangler deploy --dry-run --containers-rollout=none   # without Docker
npx wrangler deploy --dry-run -c wrangler.production.jsonc --containers-rollout=none   # mbedfx.app's config
```

Nothing in CI builds the Docker images. If you change `adapters/node/` or `container/`, build them yourself:

```bash
docker compose -f adapters/node/compose.yaml build
```

## What gets a PR sent back

### Assert on content, never on status

Several upstreams here answer `HTTP 200` with a decoy. Instagram's is a 599 KB page with no post in it; others have been a login wall and an empty shell. `res.ok` is true for all of them. Check the body for the thing the code needs.

### Say where you measured

Measure from a Worker, and say so in the comment. A datacenter IP and a residential one get different bytes from the same URL. Facebook's 302, Reddit's anonymous reads and Google Translate's `sl=auto` all worked from a laptop and did nothing from a Worker.

### Comment the why, not the what

A comment carries what the code can't: the measurement behind a value, the approach that was tried and didn't work, and what breaks if this gets "simplified". If you call a rule deliberate, say what goes wrong without it.

### Don't guess

Never invent a title, an author or a thumbnail. When something cannot be determined the card says so: there are private and age-gated cards, and a plain "couldn't load" for everything else.

### Fetching and normalising are separate

Each platform has a `fetch.ts` that does I/O and a `normalize.ts` that is pure and tested against captured fixtures with no network. Keep judgement in the pure half.

### The converter page's wording

The visible copy in `public/index.html` has no em dashes and doesn't address the reader as "you". A test checks both.

## Tests

`node --test`, no framework. Fixtures live in `test/fixtures/`.

Test names are sentences that state the rule. The body explains the defect it prevents. Read an existing test before writing one, or the next reader can't tell a broken rule from one changed on purpose.

Tests must not touch the network. If your test needs an upstream, stub `fetch`.

## Pull requests

- One concern per PR.
- `npm run build` green.
- If you changed behaviour, **rewrite the test that pinned the old behaviour instead of deleting it**, and say in the comment what changed and why. A deleted assertion leaves no trace of having been wrong.
- Update `CHANGELOG.md` for anything user-visible.

There is no CLA. By opening a PR you agree your contribution is licensed under the [MIT License](../LICENSE).

## Adding a site

Roughly, in order:

1. The platform code in the `Platform` union and the `PostRef` and `Route` variants in `src/types.ts`, the matcher and a two-letter `ESCAPE` entry in `src/router.ts`, and the `parseRefKey` allowlist entry in `src/refkey.ts`. Forgetting the allowlist entry 404s every image on the new platform. Add the kind to the round-trip list in `test/refkey.test.mjs` too, because nothing catches its absence.
2. `src/platforms/<site>/fetch.ts` and `normalize.ts`.
3. A dispatch arm in `src/worker.ts`, and a known post for the scheduled check in `src/smoke.ts`.
4. A captured fixture and normalizer tests.
5. The code and name in `public/index.html` (the `PLATFORMS` list), `public/openapi.json` (the platform enum and names), the codes table in `docs/API.md`, the site dropdown in `.github/ISSUE_TEMPLATE/bug_report.yml`, and the README's site table, icon (`docs/images/sites/`) and force-code line, in table order.

All five assume there is a surface the platform will serve to a datacenter IP with no account. Finding one takes longer than writing any of them. Find it first, and bring the measurement with you.
