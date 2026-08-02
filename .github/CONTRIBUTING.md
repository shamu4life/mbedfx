# Contributing to mbedfx

Bug reports, feature requests and pull requests are all welcome. This file is the short version of how the codebase thinks, so a PR does not get surprised by it.

## Reporting a bug

Open a [bug report](../../issues/new/choose). **Include the link.** Almost every bug here is one specific post rather than a whole site, and without the link there is nothing to test against.

Two things worth checking first, because they look like bugs and are not:

- **Cards are cached for about 15 minutes.** A card you just saw fail may already be fixed.
- **A cold video takes a view or two.** The first request starts the mux; the card degrades to the cover image until it finishes, then plays.

## Reporting a security problem

Do not open a public issue — see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm test              # 1117 tests, no network
npm run typecheck
npx wrangler dev      # local worker
```

`npm run build` is what CI runs: the suite plus a type check. If it passes locally it passes in CI.

**Deploys are not run by hand.** Cloudflare Workers Builds watches `main` and merging is the deploy. `npm run deploy` refuses on purpose — a hand deploy overwrites whatever the build shipped, and prod goes on looking healthy while the pipeline is broken. This has cost the project real downtime once already.

## Five things that get PRs sent back

**1. Assert on content, never on status.** Several upstreams here answer `HTTP 200` with a decoy — a login wall, an empty shell, a 599 KB page that contains no post. `res.ok` proves nothing. Check for the thing you actually need.

**2. Say where you measured it.** A datacenter IP and a residential one get different bytes from the same URL. More than one feature here worked perfectly from a laptop and did nothing in production. If your change rests on what an upstream returned, say where you ran it from.

**3. Comment the why, not the what.** The code says what it does. Comments exist to record the thing the next person cannot recover: what was measured, what was tried and failed, and what will break if this is "simplified". A comment that says a rule is deliberate should also say what goes wrong without it.

**4. Fetching and normalising are separate.** Each platform has a `fetch.ts` that does I/O and a `normalize.ts` that is pure. The pure half is tested against captured fixtures with no network. Keep judgement in the pure half.

**5. Don't guess.** If something cannot be determined the card says so — there's a private card, an age-gated one, and a plain "couldn't load" for everything else. A fallback that invents a title, an author or a thumbnail gets sent back.

## Tests

`node --test`, no framework. Fixtures live in `test/fixtures/`.

Test names are sentences that state the rule, and the body explains the defect it prevents — look at any existing test before writing one. Skip that and the next person cannot tell a broken rule from one you changed on purpose.

Tests must not touch the network. If yours needs an upstream, stub `fetch`.

## Pull requests

- One concern per PR.
- `npm run build` green.
- If you changed behaviour, change the test that pinned the old behaviour — **rewrite it rather than deleting it**, and say in the comment what changed and why. A deleted assertion leaves no trace of having been wrong.
- Update `docs/CHANGELOG.md` for anything user-visible.

There is no CLA. By opening a PR you agree your contribution is licensed under the [MIT License](../LICENSE).

## Adding a site

Roughly, in order:

1. A `Route` arm in `src/router.ts`, plus a `PostRef` variant, plus the `parseRefKey` allowlist entry — that last one is easy to forget and its absence 404s every image on the new platform.
2. `src/platforms/<site>/fetch.ts` and `normalize.ts`.
3. A dispatch arm in `src/worker.ts`.
4. A captured fixture and normalizer tests.
5. A row in the converter page's site table and in the README.

The code is the easy part. The hard part is finding a surface the platform will serve to a datacenter IP with no account. Do that first, and bring the measurement with you.
