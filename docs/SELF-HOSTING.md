# Self-hosting mbedfx

You can run your own mbedfx on your own Cloudflare account, or off Cloudflare with Docker Compose or
plain Node. The first half of this page is the guide: choose a way to run it, follow its steps, and
look up settings as you need them. The second half is reference: the measurements and code reading
behind each claim, each with its date.

> [!WARNING]
> Nobody has deployed mbedfx with the Deploy to Cloudflare button, on Workers Free, or from the generic
> `wrangler.jsonc` on a real account. Those paths are written from Cloudflare's documentation and this
> repo's configs, not from a run. The Docker Compose setup was built and run by hand on one residential
> Linux host twice: at `90fb2d8` on 2026-11-25, and at `b0c7b31` on 2026-11-26 after the self-hosting
> changes. CI builds none of the images ([The Docker run](#the-docker-run)).

## Pick a way to run it

| Way | What you need | Video | Cost | Tested |
|---|---|---|---|---|
| [Deploy to Cloudflare button](#with-the-deploy-to-cloudflare-button) | A GitHub account, and a Cloudflare account on Workers Paid (Containers need it) | Yes | Workers Paid, plus the container's time awake ([What it costs](#what-it-costs)) | No |
| [Cloudflare, by hand](#by-hand-from-a-checkout) | Workers Paid, Node 22.18 or later, and Docker running while you deploy | Yes | The same | No |
| [Docker Compose](#host-it-with-docker-compose) | Docker Engine with Compose v2, an x86_64 host, a domain, and a reverse proxy that terminates TLS | Yes | Your own host | Twice by hand, most recently on 2026-11-26 at `b0c7b31`, after the self-hosting changes ([The Docker run](#the-docker-run)) |
| [Node without Docker](#run-it-on-node-without-docker) | Node 22.18 or later. For video, the resolver too: its image, or Python with ffmpeg, yt-dlp and Deno | Only with the resolver | Your own host | The adapter ran once, on 2026-11-25, beside a local `server.py`, before those same adapter changes |

Both Cloudflare ways also deploy on Workers Free through `wrangler.free.jsonc`, which leaves the
container out. Videos that need muxing then show their cover image, and Free's limits haven't been
measured against this Worker. See [On Workers Free](#on-workers-free).

Every copy calls itself `mbedfx` on its cards until you set `SITE_NAME`.

---

## On Cloudflare

### What a deploy creates

Both Cloudflare ways deploy the root `wrangler.jsonc` into your account. It names nothing of
mbedfx.app's, so a deploy from the account that runs mbedfx.app makes a second, separate Worker.

| What | Name | Binding |
|---|---|---|
| The Worker | `mbedfx-selfhost`, on `mbedfx-selfhost.<your-subdomain>.workers.dev`, with no routes and Workers Logs off | |
| R2 bucket, created on the first deploy | `mbedfx-selfhost-media` | `MEDIA_CACHE` |
| Container application, built from `container/Dockerfile`, `standard-2` (1 vCPU, 6 GiB, 12 GB), at most 10 instances | `mbedfx-selfhost-mediaresolver` | `MEDIA_RESOLVER` |
| Durable Objects, all SQLite-backed | `MediaResolver`, `MuxRunner`, `SmokeRunner` | `MEDIA_RESOLVER`, `MUX_RUNNER`, `SMOKE_RUNNER` |
| Workers AI, for translation | | `AI` |
| Analytics Engine dataset | `mbedfx_selfhost_counters` | `AE` |
| Cron Trigger, every 30 minutes, for the scheduled check | | |

Rename the Worker in `wrangler.jsonc` if you like. The container application's name follows it.

### With the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shamu4life/mbedfx)

According to Cloudflare's documentation, the button:

1. Copies this repository into your GitHub account and connects the copy to Workers Builds.
2. Fills in the build and deploy commands from `package.json`: `npm run build`, which runs the test
   suite and a type check, and `npm run deploy`, which is `wrangler deploy` on `wrangler.jsonc`.
3. Creates what `wrangler.jsonc` asks for: the table above.
4. Shows a description for each binding, read from the `cloudflare.bindings` key in `package.json`.

What to expect (none of it has been tried yet):

- The button needs Workers Paid, because Containers do. On Workers Free, change the commands first
  ([next section](#on-workers-free)).
- Workers Builds stops a build after 20 minutes, and the first build compiles the container image on
  Cloudflare's side. Nobody has timed that there. The test suite took 81 s on one Debian Linux
  machine on 2026-11-25. On a home Linux host Docker Compose built both images in 50 s, which says
  little about Cloudflare's builders.
- The button asks for no secrets. It asks for the names listed in a `.dev.vars.example` or
  `.env.example`, and this repo has neither on purpose. Every mbedfx secret is optional, and nobody
  has checked whether the setup page accepts one left blank. Set the ones you want after the first
  deploy ([After the first deploy](#after-the-first-deploy)).
- If you rename the Worker on the setup page, note the name. Cloudflare's docs say the page writes
  it into your copy's `wrangler.jsonc`; nobody here has checked. If it didn't, a
  `wrangler secret put` from a checkout of that copy needs `--name <your-worker>`. Those docs name
  only the one config file, so expect `wrangler.free.jsonc` to keep the old name
  ([On Workers Free](#on-workers-free)).
- This project's own Worker builds every branch except `main` with `npx wrangler preview`. Whether a
  Worker the button makes gets the same command is unchecked. Where it does, a Preview reads the
  `previews` block in `wrangler.jsonc`, which includes the container but no R2 bucket, so videos in
  a Preview show their cover still.
- Your copy carries this repo's GitHub workflows, and whether Actions run in a repository the button
  creates is unchecked. If they do, `ytdlp-freshness.yml` pushes a `chore/ytdlp-<version>` branch
  every Monday that yt-dlp has a new release and opens a pull request for it. A new repository
  doesn't let Actions open pull requests until you turn on "Allow GitHub Actions to create and
  approve pull requests" (Settings, Actions, General), and until then the job opens an issue
  instead. Workers Builds builds the branch either way. Turn the workflow off under Actions if you
  don't want it. `health-check.yml` skips until you set the repository variable `HEALTH_BASE` to
  your primary origin (and `HEALTH_GUESTS` if you have guest hosts). From then on it checks your
  instance twice a week and opens issues labelled `health-check`.

### On Workers Free

Workers Free has no Containers. With the button, keep the default Worker and bucket names on the
setup page, or make the same renames in `wrangler.free.jsonc` in your copy before the first build.
Cloudflare's docs say setup-page names are written into the copy's Wrangler config, and they mention
only one config file, which here is `wrangler.jsonc`. They also say Workers Builds fails a build
whose config names a different Worker from the one it builds. Nobody here has tried either. Then
change two commands on the setup page before the first build:

| Command | Change it to |
|---|---|
| Deploy command | `npx wrangler deploy -c wrangler.free.jsonc` |
| Non-production branch deploy command | `npx wrangler preview -c wrangler.free.jsonc` |

If the setup page doesn't show the second one, set it afterwards in the Worker's build settings.
Without it a branch build reads `wrangler.jsonc`, and that file's `previews` block includes the
container.

What a Free deployment does without the container (`wrangler.free.jsonc` explains each):

- A video that needs muxing shows its cover image, YouTube cards use YouTube's own player, and
  `/_clients` answers 503.
- `YT_ACCOUNTS` and `IG_ACCOUNTS` do nothing, because both are spent inside the container.

What nobody has checked:

- Free's limits against this Worker: 10 ms of CPU and 50 subrequests per request, and 100,000
  requests a day (Cloudflare's limits page, read 2026-11-25). A card that fans out to several
  upstreams, a translation, or the half-hourly check rendering its whole list may go over.
- Whether a Free account has to turn on R2 before the bucket can be created.
- Whether Free runs Worker Previews at all, and what the button does with a container on a Free
  account.
- Moving to Workers Paid later. The two files ship with the same Worker and resource names, so if you
  kept both files' names in step it should be a deploy of `wrangler.jsonc` onto the same Worker,
  keeping its cache and its workers.dev URL.

### By hand, from a checkout

```bash
git clone https://github.com/shamu4life/mbedfx.git && cd mbedfx
npm ci
npx wrangler login
npm run deploy    # Workers Paid. It builds the container image, so Docker must be running
```

On Workers Free, run this instead of the last line:

```bash
npx wrangler deploy -c wrangler.free.jsonc
```

You need Node 22.18 or later (`.node-version`). Older versions can't load the `.ts` files the tests
import, and wrangler 4.167 refuses anything below 22.12. To see what a deploy would do without
uploading anything, `npx wrangler deploy --dry-run` builds the image (Docker again), and adding
`--containers-rollout=none` skips it.

`npm run dev` is `wrangler dev`, which also needs Docker for the container, or
`--enable-containers=false`. Under `wrangler dev`, Workers AI always calls Cloudflare, so it uses your
login and can bill.

If you are the owner of mbedfx.app: run from a checkout without `-c`, these commands reach
`mbedfx-selfhost` and never mbedfx.app. Anything aimed at mbedfx.app takes
`-c wrangler.production.jsonc`.

### After the first deploy

First check that the Worker answers. `<YOUR_SUBDOMAIN>` is your account's workers.dev subdomain,
which is in the URL the deploy printed and on the Worker's page in the dashboard. Use your Worker's
name if you changed it. Both commands need `curl` and `jq`:

```bash
curl -s 'https://mbedfx-selfhost.<YOUR_SUBDOMAIN>.workers.dev/_api/v1?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fbsky.app%2Fpost%2F3msqpuobiwk2t' | jq .ok
curl -s https://mbedfx-selfhost.<YOUR_SUBDOMAIN>.workers.dev/_clients | jq '{ok, ytdlp, serving}'
```

The first prints `true` when the Bluesky post loaded. On Workers Paid the second reaches the
container and reports which YouTube player clients served bytes, which can take 20 seconds or more.
On Workers Free there is no container, so `/_clients` answers 503 and the second prints `"ok": false`
with `null` for the other two.

Then:

1. Give the bucket its 60-day expiry, once. Nothing in the code deletes from it, and a config file
   can't hold a lifecycle rule. Use your bucket's name if you changed it:

   ```bash
   npx wrangler r2 bucket lifecycle add mbedfx-selfhost-media expire-60d --expire-days 60
   ```

2. Add your domain. In the dashboard, add it to the Worker as a custom domain, and its `d.` name
   too if you want direct media links. `wrangler.jsonc` lists no routes, so a domain added in the
   dashboard survives every deploy.
3. Set the plain settings in the dashboard (Workers & Pages, your Worker, Settings, Variables and
   Secrets): `PUBLIC_ORIGIN` once you have a domain, and `OWN_HOSTS`, `SITE_NAME` or
   `REDDIT_USER_AGENT` if you need them ([Settings](#settings)). `keep_vars` in `wrangler.jsonc` keeps
   dashboard variables across deploys.
4. Set the secrets you want, from a checkout:

   ```bash
   npx wrangler secret put IMGUR_CLIENT_ID
   ```

   That reaches the Worker named in your `wrangler.jsonc`. If yours has another name, add
   `--name <your-worker>`, or set the secret in the dashboard instead. Fed from a pipe, `secret put`
   for a Worker that doesn't exist creates it to hold the secret, and your real Worker never gets it.
5. Replace `public/og.jpg` with a 1200x630 JPEG of your own. It is the front page's link preview,
   and it carries the mbedfx.app wordmark ([The front page's link preview](#the-front-pages-link-preview)).

`RESOLVER_SECRET` does nothing on Cloudflare today. The Worker sends it, but `MediaResolver` in
`src/container.ts` passes the container no environment, so the container never checks it. Only the
Durable Object binding reaches that container. `container/README.md`, "Deploying it", has the detail.

### What it costs

Cloudflare bills a container instance for the wall-clock time it is awake, idle included, and bills
memory and disk on their provisioned size. `src/container.ts` puts one to sleep after 5 minutes
without a request. The Worker spreads its container calls over 4 pooled instances
(`RESOLVER_SLOTS`), so four awake around the clock is the ceiling to plan for. `wrangler.jsonc`
models that at about $166 a month on `standard-2` and $29 on `basic`, on top of Workers Paid. A quiet
instance costs a fraction of that, but the half-hourly check can wake a container too.

For scale, mbedfx.app's own container bill for 2026-07-27 to 2026-08-26, read on 2026-08-16 with 21
of the 31 days in, was $21.63: $21.23 of uptime and $0.41 of work. That cycle ran on `basic` (1/4
vCPU, 1 GiB, 4 GB) with a 10-minute sleep timer, before production moved to `standard-2` on
2026-08-28. On `standard-2`, which provisions 6 GiB and 12 GB, the same hours cost several times as
much. The measurement and the reasoning for 5 minutes are the comment on `sleepAfter` in
`src/container.ts`.

`basic` is cheaper and slower. The measured YouTube extract is 14.1 s on `basic`, 9.1 s on
`standard-1` and 5.7 s on `standard-2`, and a slower extract makes a first paste more likely to miss
Discord's window and show the cover still. Nothing faster than one vCPU helps
([Size the host](#size-the-host)).

---

## Host it with Docker Compose

`adapters/node/compose.yaml` builds and runs two containers: the Node adapter, which serves the
production handler, and the resolver, which muxes video. Only the adapter's port is published, and
only on `127.0.0.1`.

### What the host needs

- Docker Engine with the Compose v2 plugin. The one measured run used Docker 26.1.5 and Compose
  2.26.1.
- An x86_64 host. `container/Dockerfile` downloads the x86_64 Deno build by name, so the resolver
  image is `linux/amd64` and compose pins that. On ARM it runs under emulation, which nobody has
  measured.
- About 1 GB for the two images (226 MB and 761 MB), plus disk for the media cache, which never
  expires on its own ([Where the media goes](#where-the-media-goes)).
- One dedicated CPU core is worth more than several shared ones ([Size the host](#size-the-host)).
- A domain, DNS pointing at the host, and a reverse proxy that terminates TLS
  ([Put it behind HTTPS](#put-it-behind-https)).
- `git`, `openssl`, `curl` and `jq` for the commands below.

### Start it

```bash
git clone https://github.com/shamu4life/mbedfx.git && cd mbedfx
(umask 077 && cat > adapters/node/.env <<EOF
PUBLIC_ORIGIN=https://<YOUR_DOMAIN>
RESOLVER_SECRET=$(openssl rand -hex 32)
EOF
)
docker compose -f adapters/node/compose.yaml up --build -d
```

The parentheses limit `umask 077` to the command that writes `.env`, so only you can read that file.
Left set in your shell, it would apply to a later `git pull` as well. The files that pull rewrites
would reach the adapter image owned by root and unreadable to `node`, the user the adapter runs as.
That follows from how git and Docker set file modes, and nobody has reproduced it.

Replace `<YOUR_DOMAIN>` before you start: the adapter refuses a `PUBLIC_ORIGIN` that isn't a bare
`http` or `https` origin. Compose won't start without `PUBLIC_ORIGIN` and `RESOLVER_SECRET`. To serve
direct media on a `d.` name as well, list both, separated by a comma:
`PUBLIC_ORIGIN=https://<YOUR_DOMAIN>,https://d.<YOUR_DOMAIN>`.

`adapters/node/.env` stays out of git (`.gitignore`) and out of the adapter image
(`adapters/node/Dockerfile.dockerignore`). Every other line is optional. This is all of them, blank
meaning unset, with what each does in [Settings](#settings):

```ini
# Your other domains, the name on your cards, guest hosts
OWN_HOSTS=
SITE_NAME=
GUEST_HOSTS=
# Behaviour
YT_PROMISE=
TRANSLATE_GOOGLE=
IG_GRAPHQL_DOC_ID=
MUX_BUFFER_MAX=
SMOKE_CRON=
ANALYTICS_LOG=
# Credentials
IMGUR_CLIENT_ID=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=
REDDIT_RELAY_URL=
REDDIT_RELAY_KEY=
YT_ACCOUNTS=
YT_ACCOUNTS_2=
YT_ACCOUNTS_3=
IG_ACCOUNTS=
IG_ACCOUNTS_2=
IG_ACCOUNTS_3=
X_ACCOUNTS=
X_ACCOUNTS_2=
X_ACCOUNTS_3=
```

An account pool is JSON holding `cookies.txt` text, so put it on one line in single quotes.
`jq -c` makes the line ([docs/CREDENTIALS.md](CREDENTIALS.md) has the JSON's shape):

```bash
printf "YT_ACCOUNTS='%s'\n" "$(jq -c . accounts.json)" >> adapters/node/.env
```

Nobody has tried a pool under compose yet.

### Check it works

```bash
docker compose -f adapters/node/compose.yaml ps        # both services "healthy" after a minute
curl -s 'http://127.0.0.1:8787/_api/v1?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fbsky.app%2Fpost%2F3msqpuobiwk2t' | jq .ok
curl -s -A 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' \
  http://127.0.0.1:8787/jack/status/20 | grep -o '<meta property="og:[a-z:]*" content="[^"]*"'
curl -s http://127.0.0.1:8787/_clients | jq '{ok, ytdlp, serving}'
```

The API call prints `true` when the Bluesky post loaded. The second prints the card's `og:` tags as
Discord would see them. `/_clients` asks the resolver to fetch one YouTube video with each player
client and reports which ones served bytes. It can take 20 seconds or more. `/_health` shows no runs until
the first scheduled check, at the next :00 or :30.

### Put it behind HTTPS

Run the reverse proxy on the host itself. The adapter listens on `127.0.0.1:8787`, which a proxy in
another container can't reach unless it shares the host's network. Point DNS for every name at the
host, the `d.` one included.

The proxy has to pass on the `Host` header the client sent. The adapter picks each request's origin by
matching `Host` exactly against `PUBLIC_ORIGIN` and `GUEST_HOSTS`, and anything else becomes the
primary. A proxy that rewrites `Host` silently breaks `d.` links (they serve cards instead of files)
and makes guest hosts answer as yours. Caddy passes `Host` by default:

```caddyfile
<YOUR_DOMAIN>, d.<YOUR_DOMAIN> {
	reverse_proxy 127.0.0.1:8787
}
```

nginx needs it set, inside the `location` that proxies to the adapter:

```nginx
proxy_set_header Host $host;
proxy_pass http://127.0.0.1:8787;
```

Neither example has been tested.

Before you share the domain, replace `public/og.jpg`, which carries the mbedfx.app wordmark, then
rebuild with `docker compose -f adapters/node/compose.yaml up --build -d`. Set `OWN_HOSTS` for any
domain you serve that isn't in `PUBLIC_ORIGIN`.
[Before a public deployment](#before-a-public-deployment) has both steps.

### Logs, updates and stopping

```bash
docker compose -f adapters/node/compose.yaml logs -f adapter      # or resolver
git pull && docker compose -f adapters/node/compose.yaml up --build -d
docker compose -f adapters/node/compose.yaml down                 # keeps the media cache
docker compose -f adapters/node/compose.yaml down -v              # deletes it too
```

Rebuilding is the only way a new yt-dlp reaches the resolver. The version is pinned in
`container/Dockerfile`, and this repo's weekly `ytdlp-freshness.yml` job proposes each new release.
Old yt-dlp releases often stop working on YouTube, so pull and rebuild about that often.

A stop sends SIGTERM. The adapter stops taking requests and waits up to 25 s (`DRAIN_MS`) for running
muxes and cache writes, and compose gives it 40 s (`stop_grace_period`) before SIGKILL.

### Where the media goes

The adapter keeps its R2 stand-in in the named volume `mbedfx_media`, mounted at `/data/media`, one
file per key: muxed MP4s, container metadata, translations, Reddit archive copies, mux give-up marks
and the scheduled check's week. Nothing expires. mbedfx.app's bucket deletes anything older than 60
days, and the same rule here, which nobody has run yet, is:

```bash
docker compose -f adapters/node/compose.yaml exec adapter \
  find /data/media -maxdepth 1 -type f -mtime +60 -delete
```

Every file can be fetched again from its platform, so pruning loses nothing but time. The muxed
videos (names starting `mux%2f`) are the large ones.

### What compose passes through

Compose reads `adapters/node/.env` only to fill in the `${...}` values in `compose.yaml`; it has no
`env_file`. A variable reaches a container only if that service lists it under `environment:`.

- The adapter gets every Worker setting ([Settings](#settings)), plus `SMOKE_CRON` and
  `ANALYTICS_LOG`.
- `CONTAINER_URL` is fixed at `http://resolver:8080`, and the image fixes `MEDIA_CACHE_DIR` at
  `/data/media`, `HOST` at `0.0.0.0` and `PORT` at `8787`.
- `DRAIN_MS` and `RESOLVER_TIMEOUT_MS` aren't passed, so setting them in `.env` does nothing until
  `compose.yaml` lists them. Keep `DRAIN_MS` below the 40 s `stop_grace_period`, or raise both.
- The resolver gets `RESOLVER_SECRET` and nothing else. To change one of its limits, add a line to
  its `environment:` in `compose.yaml`, for example `MUX_PAGE_TIMEOUT: ${MUX_PAGE_TIMEOUT:-360}`. If
  you raise `MUX_PAGE_TIMEOUT` past 360, raise the adapter's `RESOLVER_TIMEOUT_MS` (default 420000)
  with it, to stay a minute above.

---

## Run it on Node, without Docker

Node 22.18 or later runs the TypeScript as written. There is no build step and no `npm install`,
because nothing `src/worker.ts` imports comes from `node_modules`.

### Start the resolver

The resolver is what muxes video. Run its image on its own, published on loopback only:

```bash
git clone https://github.com/shamu4life/mbedfx.git && cd mbedfx
SECRET=$(openssl rand -hex 32)
docker build --platform linux/amd64 -t media-resolver container/
docker run -d -p 127.0.0.1:8080:8080 -e RESOLVER_SECRET="$SECRET" media-resolver
curl localhost:8080/health    # prints ok
```

Or skip Docker entirely: where ffmpeg, yt-dlp and Deno are installed, `server.py` runs on a stock
Python. `container/README.md`, "Without Docker", has the command and one ffmpeg caveat. Without any
resolver, start the adapter with `CONTAINER_URL=off`, and videos that need muxing show their cover
still.

`server.py` always listens on 0.0.0.0, every IPv4 interface, and has no setting to change that.
Under Docker, `-p 127.0.0.1:8080:8080` keeps it on loopback. Without Docker, always set
`RESOLVER_SECRET`, and firewall port 8080 so only the adapter's host can reach it. The resolver
checks `X-Resolver-Secret` only when `RESOLVER_SECRET` is set. Without it, the resolver is an
unauthenticated remuxer that fetches whatever any caller names.

### Start the adapter

In the same shell, so `$SECRET` is still set:

```bash
sudo install -d -o "$USER" /var/lib/mbedfx
PUBLIC_ORIGIN=https://<YOUR_DOMAIN> \
RESOLVER_SECRET="$SECRET" \
MEDIA_CACHE_DIR=/var/lib/mbedfx \
node adapters/node/server.ts
```

`MEDIA_CACHE_DIR` has to be writable by the user running `node`. The adapter creates the directory but
not its parents, which is what the `install -d` line is for. The adapter listens on `127.0.0.1:8787`;
put a reverse proxy in front of it as in [Put it behind HTTPS](#put-it-behind-https), and keep it
running with whatever supervises processes on your host. Nobody has written a systemd unit for it
yet. To update, `git pull`, rebuild the resolver image, and restart both.

Two steps from [Before a public deployment](#before-a-public-deployment) come before you share the
domain: replace `public/og.jpg`, which carries the mbedfx.app wordmark, and set `OWN_HOSTS` for any
domain you serve that isn't in `PUBLIC_ORIGIN`. The adapter reads `public/` on every request, so the
new picture is served without a restart.

### What each stand-in gives up

The stand-ins are in `adapters/node/bindings.ts` and `adapters/node/r2dir.ts`, and each one's comment
says what it replaces. The trade-offs, the same under compose:

- Run one process. The response cache is a `Map` (5000 entries at most, `max-age` honoured), the
  mux runner's alarms are timers, and `waitUntil` is a set of promises. A second process would hold a
  second copy of each.
- The mux runner forgets on restart. It is `MuxRunner` rebuilt from the functions that class uses,
  so the retry schedule and the give-up rule are production's. An armed alarm is a `setTimeout`, though,
  and the next paste of that video arms it again.
- `waitUntil` has no 30-second ceiling. Work runs until it settles, so a long mux finishes inline
  more often than it does on Cloudflare.
- `SMOKE_RUNNER` is bound. Without it the cron falls back to `liveDeps()`, whose default argument
  reads `caches.default`, and Node has no such global. The check runs from your host either way. The
  colo `/_health` records is the Cloudflare data center nearest your egress, not your host.
- There is no Workers AI, so translation uses Google's endpoint alone, and `TRANSLATE_GOOGLE=off`
  turns translation off.
- Cloudflare compresses `/`. The adapter sends it plain.
- `RESOLVE_HOST` is wired to `dns.lookup`, so the address guard's DNS half is on.
- The media directory never expires ([Where the media goes](#where-the-media-goes)).

`test/node-adapter.test.mjs` starts the adapter on a random port against a fake container and runs
offline with the rest of the suite.

---

## Settings

Every setting is optional on Cloudflare. Compose requires `PUBLIC_ORIGIN` and `RESOLVER_SECRET`.

Where to set one:

| Runtime | A plain setting | A secret |
|---|---|---|
| Cloudflare | A variable in the dashboard (Workers & Pages, your Worker, Settings, Variables and Secrets). `keep_vars` keeps it across deploys | `npx wrangler secret put <NAME>`, or a secret in the dashboard |
| Docker Compose | A line in `adapters/node/.env` | The same |
| Node | An environment variable | The same |

### Worker settings, on every runtime

These are the string fields of `Env` in `src/analytics.ts`. The Node adapter reads each from the
environment under its own name (`ENV_VARS` in `adapters/node/bindings.ts`), compose forwards each one,
and an empty value counts as unset.

| Name | Kind | Default | What it does |
|---|---|---|---|
| `PUBLIC_ORIGIN` | variable | unset; on Node `http://localhost:$PORT` | Your origins, space- or comma-separated, primary first. The half-hourly check renders on the primary, the fediverse guard refuses every host listed, and the converter page offers each as a domain button. A `d.` entry turns on the media-only box for the domain under it. On Node it is also what every card URL is built on: the adapter uses the entry whose host matches the request's `Host` exactly, and otherwise the primary. Leave guest hosts out |
| `OWN_HOSTS` | variable | unset | Any other hostname you serve from, which the fediverse guard then refuses too. Needed once you serve a domain that isn't in `PUBLIC_ORIGIN` or `GUEST_HOSTS` ([`OWN_HOSTS`, and setting it](#own_hosts-and-setting-it)) |
| `GUEST_HOSTS` | variable | unset (none) | Domains of another Worker of yours that passes this one its post links over a service binding (`src/guesthost.ts`). A guest host answers only embed paths |
| `SITE_NAME` | variable | `mbedfx` | The name on your cards: `og:site_name`, the oEmbed `provider_name`, and the converter preview's footer |
| `REDDIT_USER_AGENT` | variable | `web:<primary host>:v0.1` | Sent only to Reddit's OAuth API, so it matters only with the Reddit credentials. Reddit asks for `web:<host>:<version> (by /u/<you>)` |
| `YT_PROMISE` | variable | off | `on` promises Discord an MP4 for a cold YouTube video whose length is known and at most 240 s, before the mux finishes. Anything else leaves it off, as on mbedfx.app |
| `TRANSLATE_GOOGLE` | variable | on | `off` stops the calls to Google's translate endpoint. Workers AI then translates alone, and where there is none (Node), translation stops |
| `IG_GRAPHQL_DOC_ID` | variable | built in | Pins Instagram's shortcode GraphQL query id, which Meta rotates. Re-pinning it needs no release |
| `MUX_BUFFER_MAX` | variable | 64 MiB | Bytes. The most one muxed MP4 may be buffered in memory on its way to a store without `putStream`. Neither shipped runtime takes that path: Workers streams through `FixedLengthStream`, and the adapter's directory has `putStream` |
| `RESOLVER_SECRET` | secret | unset | Locks the resolver's `/resolve`. Compose requires it and gives both services the same value. On Cloudflare it has no effect today: the container never receives it |
| `IMGUR_CLIENT_ID` | secret | yt-dlp's public id | Your own Imgur API client id. The public one works, and its rate limit is shared with every tool using it |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | secret | unset | Reddit's OAuth fallback. It needs both (`fetchReddit` in `src/platforms/reddit/fetch.ts`), and runs only after the credential-free read comes back empty |
| `REDDIT_RELAY_URL`, `REDDIT_RELAY_KEY` | secret | unset | Sends Reddit and archive reads through `relay/` ([relay/README.md](../relay/README.md)). With either missing, Reddit is read directly |
| `YT_ACCOUNTS`, `YT_ACCOUNTS_2`, `YT_ACCOUNTS_3` | secret | unset | Cookie jars that turn an age-gated YouTube video into an ordinary card. Spent inside the container, so they need one |
| `IG_ACCOUNTS`, `IG_ACCOUNTS_2`, `IG_ACCOUNTS_3` | secret | unset | Cookie jars spent only inside the container's Instagram mux |
| `X_ACCOUNTS`, `X_ACCOUNTS_2`, `X_ACCOUNTS_3` | secret | unset | Changes nothing today: the call that would spend it isn't built |

[docs/CREDENTIALS.md](CREDENTIALS.md) covers the three pools: the JSON each takes, how to export a
`cookies.txt` without invalidating it, and why the `_2` and `_3` overflow secrets exist (one secret
holds about 5.1 kB). A Worker secret is encrypted at rest. On a self-hosted box the same values sit in
a plain file, which is the threat model FxEmbed's encrypted-bundle design was answering. Fill
`IG_ACCOUNTS` or `YT_ACCOUNTS` and you take that trade-off on.

### The Node adapter only

| Name | Default | What it does | Under compose |
|---|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Where the adapter listens | The image sets `8787` and `0.0.0.0`; compose publishes it on `127.0.0.1:8787` |
| `CONTAINER_URL` | `http://127.0.0.1:8080` | The resolver. `off` leaves `MEDIA_RESOLVER` unbound, and videos that need muxing show their cover still | Fixed at `http://resolver:8080` |
| `MEDIA_CACHE_DIR` | `mbedfx-media` in the system temp directory | The R2 stand-in, one file per key. `off` leaves `MEDIA_CACHE` unbound | Fixed at `/data/media`, on the `media` volume |
| `RESOLVER_TIMEOUT_MS` | `420000` | How long a call to the resolver may sit idle. It sits above the resolver's 360 s `MUX_PAGE_TIMEOUT` because the resolver sends nothing until a mux is done | Not passed |
| `DRAIN_MS` | `25000` | How long SIGTERM waits for `waitUntil` work before the process exits | Not passed |
| `SMOKE_CRON` | on | The half-hourly scheduled check. Each run renders 17 known posts from your egress. `off` stops it | Passed |
| `ANALYTICS_LOG` | off | `1` prints each Analytics Engine data point as one JSON line on stdout | Passed |

### The resolver

`container/server.py` reads these. `server.py` is authoritative whenever `container/README.md`
disagrees.

| Name | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Where it listens, on 0.0.0.0 (all IPv4 interfaces, no IPv6) |
| `RESOLVER_SECRET` | unset, meaning no auth | Required in `X-Resolver-Secret` on every `/resolve` when set |
| `MAX_SECONDS` | `1500` | The longest video it will mux |
| `MAX_BYTES` | `393216000` (375 MB) | The output ceiling. Move it with `MAX_SECONDS`: the mux is `-c copy`, so output size is the source bitrate times the duration |
| `PROC_TIMEOUT` | `120` s | The wall clock per subprocess, except the `{page}` mux |
| `MUX_PAGE_TIMEOUT` | `360` s | The wall clock for a `{page}` mux, which downloads the whole video |
| `PROBE_TIMEOUT` | `45` s | Per player client, read only by the `/_clients` probe |

On Cloudflare none of these can be set: the container gets no environment from the Worker. Under
compose only `RESOLVER_SECRET` is passed ([What compose passes through](#what-compose-passes-through)).

`MUX_PAGE_TIMEOUT` is the one most worth setting deliberately. It was `PROC_TIMEOUT + 60` (180 s)
until 2026-08-29, less than the download a `MAX_SECONDS` video needs, so a long video was SIGKILLed
with nothing written, on every attempt. If your egress is slower than Cloudflare's, raise it or lower
`MAX_SECONDS`, since a video admitted and then killed is worse than one refused.

### Size the host

Size it for yt-dlp's extraction, not for ffmpeg's remux. The public instance ran the resolver on a
quarter of a vCPU until 2026-08-28 and paid 14-17 s per YouTube extract for it. On one vCPU the same
extract measured 3.1-4.7 s per client from the same egress that day. For a long time that 15.9 s was
read as YouTube throttling a datacenter IP, when it was our own CPU. The gain stops at one vCPU,
because the hot path is single-threaded Python and an `ffmpeg -c copy` remux, so four cores buy
nothing over one. Both `wrangler.production.jsonc` and the generic `wrangler.jsonc` ask for
`standard-2` (1 vCPU, 6 GiB memory, 12 GB disk). A self-hoster wants at least one dedicated core and
enough disk for `MAX_BYTES` plus the unmerged tracks, per concurrent mux.

---

## Before a public deployment

A private instance runs without these steps, and a public one needs all three. The code behind them
is in the tree with offline tests (`test/netguard.test.mjs`, `test/selfhost.test.mjs`). None of it
has run on a public instance yet.

1. Set `OWN_HOSTS` to every domain you serve from that isn't already in `PUBLIC_ORIGIN` or
   `GUEST_HOSTS`, whitespace- or comma-separated, as hostnames or origins:

   ```sh
   OWN_HOSTS="embed.example.com https://staging.embed.example.com"
   ```

   The value is added to the built-in list and never replaces it, so a typo or an empty value can
   only make the guard stricter. One apex entry covers all of its subdomains. Leaving it unset is a
   misconfiguration with a narrow reach: a request on one of your domains can make the fediverse
   routes fetch another of them, and the rest of the guard still stands
   ([`OWN_HOSTS`, and setting it](#own_hosts-and-setting-it)).
2. Replace `public/og.jpg` with a 1200×630 JPEG of your own. It is the front page's link preview,
   and it carries the mbedfx.app wordmark. If yours has another size or type, change
   `og:image:width`, `og:image:height` and `og:image:type` in `public/index.html` to match, because
   Discord won't draw a large image without a declared size. On Cloudflare, deploy again. Under
   Docker Compose, rebuild the adapter image with
   `docker compose -f adapters/node/compose.yaml up --build -d`, because its Dockerfile copies
   `public/` in. On Node without Docker the adapter reads `public/` on every request, so the new
   files are served at once ([The front page's link preview](#the-front-pages-link-preview)).
3. Off Cloudflare, keep `RESOLVE_HOST` wired. The Node adapter wires it to `dns.lookup` by
   default, which turns on the DNS half of the private-address guard. An adapter of your own has to
   supply it. Even wired, it can't stop DNS rebinding
   ([DNS and private-range guarding in the Worker half](#dns-and-private-range-guarding-in-the-worker-half)).

---

## Reference: how the port was checked

Everything below is the evidence behind the guide: what was read in the code, what was measured, and
where. An earlier revision of this project's notes said self-hosting was not achievable, and the
README's comparison table said "Workers only". Both were corrected once the adapter ran.

The corrections that make exposing an instance safe landed on 2026-08-12: the private-address guard
the Worker half never had (`src/netguard.ts`), a configurable `OWN_HOSTS`, a guest-token cache that
works on both runtimes, a bound on the mux buffering fallback, and the `CacheLike` contract written
down. They are code with offline tests, and each has a section below, from
[`OWN_HOSTS`, and setting it](#own_hosts-and-setting-it) to
[The front page's link preview](#the-front-pages-link-preview).
[Before a public deployment](#before-a-public-deployment) lists what an operator has to set.

### What the first run measured

On 2026-11-25 the adapter ran on a residential Linux host under Node 22.18.0, started from a copy of
exactly the files `adapters/node/Dockerfile` copies, before the adapter changes listed under
[The Docker run](#the-docker-run). Beside it ran `container/server.py` with yt-dlp 2026.11.23,
which `container/Dockerfile` pinned that day, ffmpeg 7.1.5 and Deno 2.9.8. Each post was fetched with
Discord's user agent through the adapter and through mbedfx.app, and `og:title`, `og:description`,
`og:image`, `og:video`, the activity document and the `/_api/v1` JSON were compared with the origins
stripped. Like and view counts moved between the two reads and are left out below.

| Post | Result |
|---|---|
| Bluesky `/profile/bsky.app/post/3msqpuobiwk2t` | Identical: the head, the activity document and all 25 API fields. |
| Reddit `/r/pics/comments/haucpf` | Identical, all 24 API fields, with no relay and no OAuth app configured. |
| Mastodon `/mstdn.social/@stux/116994812581955524` | Identical. |
| Twitter `/jack/status/20` | Same head, but no repost count. From this host the syndication endpoint, the primary path, answered without `retweet_count` (checked by calling it directly), so `reposts` is absent. mbedfx.app shows 126.3K. Which path production's answer came from can't be seen from outside. |
| YouTube `/jNQXAC9IVRw` | The first view differed. The video was cold here and warm on production, so the adapter drew the degraded card (YouTube's own player, never cached) while the mux ran, which took 3.6 s. On the second view the head and the activity document matched, `og:video` included. The two MP4s are different muxes of the same 19-second video: 629,172 bytes here, 633,710 there. |

### The Docker run

On 2026-11-25 Docker 26.1.5 and Compose 2.26.1 went onto the residential Linux host from
[What the first run measured](#what-the-first-run-measured), and the stack was built from a clean
checkout of `main` at `90fb2d8` with a throwaway `.env` holding only `PUBLIC_ORIGIN` and
`RESOLVER_SECRET`.

| Check | Result |
|---|---|
| `docker compose build` | Both images built in 50 s: `mbedfx-adapter` 226 MB, `mbedfx-resolver` 761 MB. |
| `.env` kept out of the image | `adapters/node/.env` sat in the build context and is absent from the image. |
| The resolver's port | Not published. The adapter answered on `127.0.0.1:8787`; nothing answered on the host's 8080. |
| `/_clients` through the adapter | yt-dlp 2026.11.23, ffmpeg 7.1.5, four YouTube player clients served bytes (`default`, `web_embedded`, `tv_simply`, `mweb`), and the HLS playlist and segment probes passed. |
| Cards against mbedfx.app | `og:title` and `og:description` matched for a Bluesky post, a Bluesky profile, Reddit and Mastodon. YouTube's first view was the degraded card again while the video was cold. |
| A muxed video | `/_media/yt%3AjNQXAC9IVRw/0.mp4` served 629,172 bytes. |
| `docker compose stop adapter` | Under a second, logging `SIGTERM: requests finished, 0 background task(s) pending at stop, all settled`. |

#140, #144, #145, #146 and #148 then changed `compose.yaml`, `adapters/node/bindings.ts` or
`adapters/node/server.ts`, so on 2026-11-26 the stack was rebuilt at `b0c7b31` and the same checks
ran again. Everything above held: the same image sizes, no `.env` in the image, the resolver off the
host's ports, the same four YouTube clients and passing HLS probes, a 629,172-byte mux and a clean
stop. The Bluesky, Reddit, Mastodon and Twitter cards matched mbedfx.app's titles. The converter page
named the deployment: primary `http://127.0.0.1:8787`, `http` links, and no mbedfx.app in its og tags.
Nothing builds or runs the images in CI, so a later change can break them without a red check.

### The container, on its own

From the repository root, with a Docker-compatible CLI, no Cloudflare account and no `wrangler`
login:

```sh
SECRET=$(openssl rand -hex 32)
docker build --platform linux/amd64 -t media-resolver container/
docker run -p 127.0.0.1:8080:8080 -e RESOLVER_SECRET="$SECRET" media-resolver
curl localhost:8080/health
```

`container/Dockerfile` installs an x86_64 Deno binary and `container/README.md` requires
linux/amd64, which `--platform` pins above. What an arm64 build produces is unrecorded; nobody has
built or resolved on one.

### The test suite

`npm test` is `node --test` and nothing else (`package.json`): no loader, no flags, no build step, no
bundler, no `wrangler`, no network. Node strips the TypeScript types and imports `src/worker.ts` as
written.

Measured 2026-08-12: 1343 tests, 0 failures, 30.6-34.7 s across runs, on Node v26.5.0 on a
residential macOS laptop, replacing 1207 tests in 19.3-20.1 s measured 2026-08-05, and 1185 tests in
19.9 s on 2026-08-04. On 2026-11-25 the same command ran 2021 tests, 0 failures, in 81 s, under Node
22.18.0 on a Debian Linux machine. The suite grew and the machine changed, so read the run time as
"under a minute and a half", not as a regression anybody measured. CI pins Node 22.18.0
(`.node-version`) and runs the same command, under a comment saying the whole suite runs on captured
bytes and fake bindings, with no network, container or R2 (`.github/workflows/ci.yml:53`).

Thirty-six test files import the production handler itself (counted 2026-11-25) and drive the
media/mux path, the translation deadline, the YouTube date path, the media proxy and `/_prep`, with
object literals standing in for the bindings. A one-line count,
`grep -lE "import \{[^}]*\bhandle\b[^}]*\} from '../src/worker.ts'" test/*.mjs | wc -l`, finds 35,
because one of the imports spans several lines. That proves the module graph loads and executes
under Node, and nothing more.

### The adapter entry point

`env`, `ctx` and `Deps` are ordinary parameters of `handle()` in `src/worker.ts`, and the
Workers-specific default export is a thin wrapper around it:

```ts
// src/worker.ts
export async function handle(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response>

const liveDeps = (cache: CacheLike = caches.default as unknown as CacheLike): Deps => ({
  cache,
  fetchPost: liveFetchPost,
  fetchProfile: liveFetchProfile,
  resolveShortlink: liveResolveShortlink,
  resolveRedditShare: liveResolveRedditShare,
  resolvePinShortlink: liveResolvePinShortlink,
  resolveMetaShare,
})
export const scheduledDeps = (): Deps => liveDeps(COLD_CACHE)

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, ctx, liveDeps())
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // smokeWhereReadersAre(env, ctx), then the week into MEDIA_CACHE
  },
}
```

`caches.default` is the only Cloudflare-shaped thing in that block, and it is a default argument, so it
is read only when `liveDeps()` is called without one. The Node adapter never makes that call. It spreads
`scheduledDeps()` and swaps in its own cache, `{ ...scheduledDeps(), cache }`, so a fetcher added to
`liveDeps` later reaches the adapter without anyone copying it. Every live dependency is exported:
`liveFetchPost`, `liveFetchProfile`, `liveResolveShortlink`, `liveResolveRedditShare` and
`liveResolvePinShortlink` from `src/worker.ts`, `resolveMetaShare` from
`src/platforms/metashare/fetch.ts`.

### The eight Cloudflare surfaces

Six of the eight need only an object literal: `AE`, `ASSETS`, `AI`, the `CacheLike`, the `ctx`, and
the `cf` fetch option. `Env` lives in `src/analytics.ts`, where three of its object-shaped bindings
are interfaces hand-written in that file with no Cloudflare type in them. `MUX_RUNNER` and
`SMOKE_RUNNER` are typed the same way, by their methods:

```ts
AE?: { writeDataPoint(x: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }
ASSETS: { fetch(req: Request): Promise<Response> }
AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }
```

The other two are optional Cloudflare types, `MEDIA_RESOLVER?: DurableObjectNamespace` and
`MEDIA_CACHE?: R2Bucket`. The suite fakes both with object literals and runs the entire
`/_media/` mux path against them under Node: `MEDIA_RESOLVER: { getByName: () => ({ fetch: impl }) }`
and a `fakeR2()` doing head / get / get-with-range / put over a `Map`
(`test/media-resolver.test.mjs`).

Outside `Env`, `caches.default` is reached only through the hand-written `CacheLike` injected via
`Deps` (`src/worker.ts`). `ExecutionContext` is used for `ctx.waitUntil` and nothing else, at 24 call
sites in `src/worker.ts` (counted 2026-11-25), with no `passThroughOnException`, `ctx.props` or
`ctx.exports`. Reproduce it with `grep -cE 'ctx\??\.waitUntil\(' src/worker.ts`. The `\??` matters,
because one site is optional-chained and a literal grep for `ctx.waitUntil` misses it, and the `\(`
matters because it is what separates the invocations from the prose.

Re-run that before trusting the number. Earlier revisions printed 13 (the literal grep, comments
included), then nine, then fifteen, while the code had 24. The count only goes up, because every mux
the alarm arms and every response-cache write adds one. Dropping the `\(` matches 34 lines today, ten
of them prose inside comments.

### Workers-only globals

Exactly one Workers-only global sits on the request path, feature-detected in `putMuxed`:

```ts
// src/worker.ts, putMuxed
if (typeof FixedLengthStream !== 'undefined' && len !== null) {
```

`FixedLengthStream` is absent under `node --test`. The streaming path serves production; below the
check are the two paths that serve the unit tests and every self-hosted runtime: `putStream` if the
store implements it, else a buffer bounded by `MUX_BUFFER_MAX`. See
[the mux buffering fallback](#the-mux-buffering-fallback-bounded).

`crypto.subtle.digest` (`src/worker.ts`) is standard in Node. The rest of `src/` reaches for no
runtime API: no `HTMLRewriter` or `WebSocketPair`, no `caches` inside `handle`, no read of
`request.cf`.

Three files under `src/` import modules that exist only on Workers, and only the deploy entry,
`src/index.ts`, loads them. `src/container.ts` imports `@cloudflare/containers`, which pulls in
`cloudflare:workers` behind it, and `src/muxrunner.ts` and `src/smokerunner.ts` import
`DurableObject` from `cloudflare:workers`. Importing any of them under `node --test` throws, which is
why `src/container.ts` says it is the only file that imports the containers package, and why nothing
the tests import reaches it. The adapter rebuilds the two Durable Objects in
`adapters/node/bindings.ts` instead. A Node port needs the same boundary: nothing on the request path
may import any of the three.

### The container has no Cloudflare surface

`container/server.py` imports only the standard library (`ipaddress`, `json`, `os`, `re`, `socket`,
`struct`, `subprocess`, `tempfile`, `time`, `urllib.error`, `urllib.request`, `http.server`,
`urllib.parse`); the client probe added `time`, `urllib.error` and `urllib.request` and needed nothing
outside that library. The file's last three lines are the whole entry point:
`port = int(os.environ.get("PORT", "8080"))` under `if __name__ == "__main__":`, then
`ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()`. The entry point is named rather
than numbered because a line count that used to stand here was wrong by a third within a month.

`container/Dockerfile` is `python:3.12-slim` plus ffmpeg, `yt-dlp[default,curl-cffi]` pinned to an
exact stable release and a static Deno binary, `EXPOSE 8080`, `CMD ["python", "server.py"]`. None of
it needs porting.

This page deliberately doesn't repeat the yt-dlp version. `.github/workflows/ytdlp-freshness.yml`
proposes a bump every week, so a number written here would be wrong within days and would send
self-hosters to a build that can't play YouTube. Read the pin off `container/Dockerfile`, which is
the only place it lives. The Dockerfile explains why the channel is stable rather than nightly (an
owner decision, 2026-08-18; the job reads PyPI's newest stable and refuses a pre-release string
outright), and why the pin is exact rather than a floor: reproducibility and a one-line revert. Docker
layer caching was the reason once, and the 2026-08-29 correction there retracts it.

**The weekly job can't merge, and a pin nobody merges goes stale silently.** When a bump
did arrive (2026.8.19, detected 2026-08-24), the job pushed the branch, could not open a pull request
(the repository's "Allow GitHub Actions to create and approve pull requests" setting was off) and
fell back to raising an issue, exactly as designed. Branch and issue then sat four days. The setting
was turned on on 2026-08-28. If you fork this, the fallback matters more than the happy path. Check
that the pin has actually moved; a green workflow doesn't show that.

On 2026-11-25 the image was built and run outside Workers under compose ([The Docker run](#the-docker-run)):
`/_clients` reached it through the adapter, and it muxed a YouTube video. Before that, `server.py`
alone had run on a stock interpreter with no container at all, on 2026-08-08 on macOS x86_64: it
answered `/health`, enforced `X-Resolver-Secret` and refused every SSRF probe. `container/README.md`
documents that path under [Running it standalone](../container/README.md#running-it-standalone).

#### The `/resolve` contract

From the module docstring and `do_POST` in `container/server.py`. `POST /resolve` takes a JSON body:

```jsonc
{ "video": "<url>", "audio": "<url>"|null }   // ffmpeg -c copy mux of tracks already extracted
{ "page":  "<url>" }                          // yt-dlp resolves + merges (any yt-dlp-supported site)
{ "page":  "<url>", "meta": true }            // METADATA ONLY: one `yt-dlp -J`, no download
{ "probe": true }                             // DIAGNOSTIC: extract PROBE_VIDEO with every client in
                                              // PROBE_CLIENTS, then range-fetch each chosen format
```

Any shape also accepts `"cookies"`, the contents of a Netscape `cookies.txt`. The jar is
written `0600` for the length of the call, unlinked afterwards whether the call succeeded or raised,
and never logged, echoed into an error, or returned. Without a jar, yt-dlp answers `formats: 0` for
age-gated sources inside the container (`container/server.py`), and the Worker falls back to the
cover image (`src/worker.ts`).

The resolver's responses:

| | |
|---|---|
| `200 video/mp4` | the result file, streamed. Where ffmpeg writes it (a `{video}` tracks mux, a yt-dlp merge, the HLS fixup) it is a remux, never a transcode: `-c copy -movflags +faststart`. A single-format `{page}` download is the site's own file written verbatim, so not necessarily faststart. An ISO-BMFF result is sent only once its top-level boxes all walk as whole and an mdat carries data, else `502 incomplete result`; that catches a file cut off inside a box, not a short input ffmpeg rewrote into whole boxes. WebM, FLV and MPEG-TS are passed through unjudged |
| `200 application/json` | meta mode, a passthrough of `yt-dlp -J`; or probe mode, `{video, ytdlp, ffmpeg, hlsExtensionPicky, muxCheck, ms, serving, clients, tiktok, hls}`. `GET /_clients` on the Worker wraps that in an `ok` |
| `4xx/5xx application/json` | `{"error": "..."}`, plus a `detail` line and `run_ms`, `uptime_s`, `variant` on a `502` mux failed. A `200` mux carries the same three as `x-mux-run-ms`, `x-mux-uptime-s` and `x-mux-variant` headers. `400` bad json / `need 'page' or 'video'` / invalid source; `401` unauthorized; `404` not found; `502` mux failed, meta failed, empty or oversized result, incomplete result; `504` mux timed out, meta timed out; `500` internal error |
| `GET /health` | `200 ok` |

A failed mux's stderr can carry the source URL, so it is never passed through. The container keeps
its last error line, replaces every URL in it with `<url>`, and cuts it to 160 characters; that is `detail`.
The Worker strips URLs again and writes it only to its log.

The resolver's environment variables aren't in one block. `MAX_SECONDS`, `MAX_BYTES` and
`PROC_TIMEOUT` sit at the top of `container/server.py`, `MUX_PAGE_TIMEOUT` under the note that argues
it, `RESOLVER_SECRET` further down among the module constants and `PROBE_TIMEOUT` beside the client
probe, and `PORT` is read once in the entry point. [The resolver](#the-resolver) has the defaults. The
README has carried stale values for one pair before: `MAX_SECONDS` and `MAX_BYTES`, which were raised
together on 2026-08-03.

Security the container already has (docstring, `container/server.py`):

- `X-Resolver-Secret`, required on every `/resolve` when `RESOLVER_SECRET` is set
- the scheme checked to http/https
- every host resolved, and refused on a private, loopback, link-local, reserved or multicast address
- `-protocol_whitelist` on ffmpeg, with no `file:`, `concat:` or `data:`
- a URL beginning with `-` rejected outright, subprocesses as argv lists rather than a shell, and a
  `--` end-of-options guard on yt-dlp

### What replaces each binding, and what degrades without it

| Surface | Where it is declared | What the code calls | Replace with | Without it |
|---|---|---|---|---|
| `ASSETS` | `Env`, `src/analytics.ts` | two calls, both in `pageResponse` (`src/sitepage.ts`): `/` is fetched without the conditional headers and gets the page's config block added; every other site path (`SITE_PATHS` in `src/router.ts`: `/index.html`, `/favicon.ico`, `/robots.txt`, `/og.jpg`, `/openapi.json`) passes straight through | any static file server over `public/`, taking a `Request` and returning a `Response`. It needs no template step. The adapter's is `publicAssets` in `adapters/node/bindings.ts` | Required. Every site path throws without it. |
| `MEDIA_CACHE` (R2) | `Env`, `src/analytics.ts` | `head(key)`, `get(key)`, `get(key, {range:{offset,length}})`, `put(key, stream\|ArrayBuffer\|string)`, `delete?.(key)` for the mux give-up mark (`clearMuxGiveUp`, `src/worker.ts`), and optionally `putStream(key, stream, length\|null)` | any S3-compatible store, or a directory on disk. The adapter's is `DirBucket` in `adapters/node/r2dir.ts`, one file per key, with `putStream`. The test fake is a `Map` in 15 lines (`test/media-resolver.test.mjs`) | Optional. The mux is never cached: remux videos re-mux forever or get stripped, the card falls back to its cover still on every view, translations lose their cross-request cache, and yt-dlp metadata is re-extracted every time (2.4-3.1 s per Facebook video). Implement `putStream` if your store takes a stream. Without it, muxes are buffered in memory up to `MUX_BUFFER_MAX` and refused above it. |
| `MEDIA_RESOLVER` (Durable Object) | `Env`, `src/analytics.ts` | `resolver.getByName(name).fetch(url, init)` and nothing else | an object whose `getByName(name)` returns `{ fetch }` pointed at the container. The name is a pooling slot, `resolver-{RESOLVER_GENERATION}-{0..N}`, and that string names the instances and nothing stored (`META_GENERATION` is the one that scopes cached records). One container or several | Optional. Without it or without `MEDIA_CACHE`, `withResolver` strips every `remux` video and those platforms render a cover still (`src/worker.ts`). |
| `SMOKE_RUNNER` (Durable Object) | `Env`, `src/analytics.ts` | `idFromName(name)`, then `get(id, { locationHint })` and its `run()` (`smokeWhereReadersAre`, `src/worker.ts`) | an object whose `get(id).run()` calls `scheduledSmoke(env, ctx, scheduledDeps())`, as `SmokeRunner` does. The adapter's is `inProcessSmokeRunner` in `adapters/node/bindings.ts` | Required off Cloudflare, though `Env` marks it optional. Without it the cron runs the check in place through `liveDeps()`, whose default argument reads `caches.default`, a global Node does not have, so every tick throws. On Cloudflare the binding moves the check to eastern North America; off it, the check runs from your host either way. |
| `MUX_RUNNER` (Durable Object) | `Env`, `src/analytics.ts` | `getByName(key)`, then `schedule(job)`, and `claim()` / `release()` where present (`src/worker.ts`) | the in-process runner in `adapters/node/bindings.ts`, built from `runMuxJob`, `recordMuxGiveUp`, `clearMuxGiveUp` and the `src/muxpolicy.ts` helpers | Optional. The inline attempt is then the only one, with no retry schedule and no give-up mark, so a video whose mux fails keeps being retried by each new paste. |
| `AE` (Analytics Engine) | `Env`, `src/analytics.ts` | five calls, all in `src/analytics.ts` (`count` and its siblings): `writeDataPoint({ blobs: [three strings], doubles: [1] or [1, n] })`. `docs/METRICS.md` has the schema | anything with a `writeDataPoint` method: a Prometheus counter, a StatsD client, a log line | Optional. Every card still renders, and the one signal that would report a refused egress is gone. |
| `AI` (Workers AI) | `Env`, `src/analytics.ts` | `ai.run(model, input)`, with `FALLBACK_MODEL` in `src/translate.ts` | any model behind a `run(model, input)` shim | Optional. Translation falls back to Google's endpoint alone; if that is also refused from your egress, translation stops and every card renders untranslated. |
| `caches.default` | `src/worker.ts`, behind `CacheLike` (`src/worker.ts`) | `match(url)` / `put(url, Response)` with a synthetic `https://cache.mbedfx.internal/…` key (`src/cache.ts`) | a `Map` (what the tests use), Redis, or a disk cache. **Not** a per-process `Map` across more than one process. The five promises an implementation makes (honour `cache-control: max-age`, hand back a readable body, be shared across processes, never reject, key on the exact string) are the `CacheLike` docstring in `src/worker.ts`; `test/selfhost.test.mjs` fails if the worker starts calling a third method | Required by the type, trivial to satisfy. With a weak one, every paste refetches upstream, and Discord fetches roughly three times per paste (`src/worker.ts`). Cloudflare's Cache API is itself only per-datacenter: a self-hosted shared cache is arguably better than what the public instance has ([Cloudflare docs: "the contents of the cache do not replicate outside of the originating data center"](https://developers.cloudflare.com/workers/runtime-apis/cache/)). |
| `ExecutionContext` | parameter of `handle` | `ctx.waitUntil(p)` only, 24 sites in `src/worker.ts` | `{ waitUntil(p) { … } }` that tracks the promise and keeps the process alive until it settles | Required. `waitUntil` is what releases in-flight container slots, keeps a mux running past the response, and writes the response cache. A no-op silently cancels all three, and the symptom is "videos never appear". The adapter's is `trackingContext` in `adapters/node/bindings.ts`, drained on SIGTERM. |
| `OWN_HOSTS` | `src/analytics.ts` | added to the built-in own-zone list in `src/platforms/fedihost.ts`; also the domains the converter page counts as its own (`pageConfig` in `src/sitepage.ts`) | every domain you serve from, comma- or whitespace-separated, hostname or origin. A `d.` name here turns on the media-only box for the domain under it | **Set it**, unless `PUBLIC_ORIGIN` already lists every domain. Unset, a request on one of your domains can make the fediverse routes fetch another one. The domain the request came in on is refused either way. Additive, so a wrong value can only make the guard stricter. |
| `PUBLIC_ORIGIN` | `src/analytics.ts` | `cronOrigin` in `src/worker.ts`, the origin the half-hourly check renders on; also added to the own-zone list in `src/platforms/fedihost.ts`; and the converter page's buttons, primary and link schemes (`pageConfig` in `src/sitepage.ts`). The primary's host also starts the user agent sent to the Arctic Shift archive (`archiveUserAgent` in `src/instance.ts`) | your origins, space- or comma-separated, primary first: `https://embed.example.com https://d.embed.example.com`. On Workers, a plain var in the dashboard, which the generic config's `keep_vars` keeps. The Node adapter fills it from its own `PUBLIC_ORIGIN` | Optional. The check renders on `http://localhost` instead, and its results are the same. The converter page offers only the domain it was opened on, without the media-only box. Cards always take their links from the origin each request arrived on. The archive's user agent starts with `mbedfx` instead of a host, as it also does for a `localhost` or IP-address primary. The page writes each domain's links with its entry's scheme, so the Node default `http://localhost:8787` gets `http://` links. |
| `GUEST_HOSTS` | `src/analytics.ts` | `isGuestHost` in `src/guesthost.ts`, called by `handle()`; also added to the own-zone list, and offered as buttons by the converter page | hostnames of another Worker of yours that passes this one its embed paths over a service binding | Optional. Unset, no host is a guest. A guest host answers only embed paths and marks them `x-mbedfx-guest: served`. On Node, the adapter takes a `Host` header naming a guest host or its `d.` name as that host's own `https://` origin, without the domain being in `PUBLIC_ORIGIN`. Keep guest hosts out of `PUBLIC_ORIGIN`: a host listed there is one of your own, and is never treated as a guest. |
| `SITE_NAME` | `src/analytics.ts` | `siteName` in `src/instance.ts`, read once per request in `src/worker.ts`; it becomes `og:site_name` on every head and `provider_name` in the oEmbed document. The converter page gets it in its config block (`pageConfig` in `src/sitepage.ts`) for its preview footer | the name your cards show, such as `Embed Corner`. A plain var | Optional. Cards and the converter page's preview footer say `mbedfx`, like the public instance's. |
| `REDDIT_USER_AGENT` | `src/analytics.ts` | `redditUserAgent` in `src/instance.ts`, sent only by the OAuth fallback in `src/platforms/reddit/fetch.ts` | Reddit's format, with your domain and your Reddit account: `web:embed.example.com:v0.1 (by /u/yourname)`. Reddit's API rules ask for a unique, descriptive user agent that includes your Reddit username as the contact | Optional, and read only when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are set. Unset, it's `web:<primary host>:v0.1`, or `web:mbedfx-selfhost:v0.1` with no usable `PUBLIC_ORIGIN`. Neither names an account, so set this when you set the credentials. |
| `REDDIT_RELAY_URL`, `REDDIT_RELAY_KEY` | `src/analytics.ts` | `src/platforms/reddit/relay.ts`, for Reddit's embed reads and the archive | the Service URL and key of a `relay/` deployment ([relay/README.md](../relay/README.md)) | Optional. With either missing, every Reddit request goes direct. |
| `RESOLVE_HOST` | `src/analytics.ts` | `blockedResolvedHost` in `src/netguard.ts`, before every fediverse fetch | `async (host) => (await dns.lookup(host, { all: true })).map(a => a.address)` | Optional, strongly recommended off Cloudflare. Without it the address guard is literal-only, which is all a Worker can ever do, so `evil.example.com IN A 127.0.0.1` is not caught. |
| `MUX_BUFFER_MAX` | `src/analytics.ts` | `putMuxed` in `src/worker.ts` | bytes, as a string. Default 64 MB | Optional. Raise it if you have memory and no `putStream`; a video above it is not cached and its card degrades to the cover still. |
| `cf: { cacheEverything, cacheTtl }` | `src/platforms/twitter/fetch.ts` | reuses one Twitter guest-token activation for `GUEST_TOKEN_TTL` = 7200 s | nothing to supply any more: a process-local memo with a shared in-flight promise does the same job on both runtimes | Was silently ignored off Cloudflare, so every cold card minted a fresh guest token. A token has roughly a 500-request budget, so the cost was one extra request to Twitter per cold card and a source of rate-limiting invisible from the code. Now bounded to one activation per process per two hours. |

Secrets are plain strings on `Env` and map straight onto environment variables: `RESOLVER_SECRET`,
`IMGUR_CLIENT_ID`, `IG_GRAPHQL_DOC_ID`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`,
`REDDIT_RELAY_URL`, `REDDIT_RELAY_KEY`, and the three pools with their overflow secrets, `X_ACCOUNTS`,
`IG_ACCOUNTS` and `YT_ACCOUNTS` with `_2` and `_3` each (all on `Env` in `src/analytics.ts`).
`TRANSLATE_GOOGLE` is read the same way. [Settings](#settings) has what each does.

### `OWN_HOSTS`, and setting it

The fediverse routes take an instance hostname straight from the URL path and make it the origin of
a fetch. `fetchableInstance` (`src/platforms/fedihost.ts`) refuses mbedfx's own zones:

```ts
const OWN_HOSTS = [
  'mbedfx.app', 'megapenispoopenfarten.sex', 'forsen.sex', 'workers.dev',
  'sorryifuckedyour.mom', 'hotsinglesnear.you',
]
```

The last two are mbedfx.app's guest hosts (`src/guesthost.ts`), domains of another Worker that hands
mbedfx its post links through a service binding. mbedfx.app's `GUEST_HOSTS` var names them, and they
are written out here too so they stay refused if that var is ever lost. A self-hosted instance never
sees a request on them.

The domain a request came in on is refused with no setting at all. On `embed.example.com`, or on
`d.embed.example.com`, `/embed.example.com/post/1` fetches nothing. Your other domains are not covered
that way. Serve on `embed.example.com` and `cards.example.net` without declaring either, and
`/embed.example.com/post/1` requested on `cards.example.net` makes the service fetch itself. On
Cloudflare that re-enters through the edge and bypasses the zone's own WAF; on a self-hosted box it is
a self-request and, with the wrong DNS, an internal-service reach.

`OWN_HOSTS` closes that gap. [Before a public deployment](#before-a-public-deployment) has the
example. How the value is read:

- The value is added to the built-in list, never substituted for it. A typo, an empty value or a
  hostile one can't un-block mbedfx's zones, so every way of getting this wrong is "too strict".
- One apex entry covers every subdomain: the test is `host === h || host.endsWith('.' + h)`.
- Unset is a misconfiguration with a narrow reach. The built-in list, the address guard below and
  the response-shape assert all still stand. What is left reachable is your other public domains,
  which resolve to your own public address, and the self-request lands on a path this Worker does not
  serve as an API and renders "couldn't load".
- The domain a request came in on is read off the request itself. Since 2026-11-25 the Worker hands
  each request's origin to `fetchableInstance` as `self` (`getPost` in `src/worker.ts`). On a `d.`
  host the domain under it is refused as well, since a `d.` host is an alias of that domain.
- Every host in `PUBLIC_ORIGIN` and `GUEST_HOSTS` is refused too, on Workers and on Node, so a domain
  listed in either needs no second entry here. Any other domain you serve goes here.

The converter page counts `OWN_HOSTS` domains as its own without offering them as buttons: a link
pasted from one is pointed at the chosen domain instead of being read as a fediverse server.

### DNS and private-range guarding in the Worker half

`src/netguard.ts` is the port of `container/server.py`'s `_safe_url`, in two halves.

The literal half runs everywhere, including on Cloudflare. It parses a hostname to bytes and
range-checks them, so every spelling of one address gets one verdict: `127.0.0.1`, `127.1`,
`2130706433`, `0177.0.0.1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, `64:ff9b::7f00:1` and
`2002:7f00:1::` are all loopback. Covered: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`
(including `169.254.169.254`), `172.16/12`, `192.168/16`, `198.18/15`, the documentation ranges,
`224/4`, `240/4`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, NAT64, 6to4, and the
IPv4-mapped/-compatible forms of all of the above. It also refuses `localhost`, `.local`,
`.internal`, `.lan`, `.home.arpa` and `.arpa` names, which `FEDI_HOST` admits as soon as they carry
a dot (`api.localhost` passes that regex; `localhost` does not).

The DNS half needs a resolver. `env.RESOLVE_HOST` is a function, not a wrangler binding. A Worker
has no resolver, so on Cloudflare it is permanently undefined and the literal check is the whole guard.
The Node adapter sets it (`resolveHost` in `adapters/node/bindings.ts`):

```ts
import dns from 'node:dns/promises'
env.RESOLVE_HOST = async (host) => (await dns.lookup(host, { all: true })).map(a => a.address)
```

With it wired, `evil.example.com IN A 127.0.0.1` is refused before the request is made, and a
name with one public address and one private one is refused too, because every address is checked, as
`getaddrinfo` is in the container. A resolver that throws or answers with nothing fails closed.

It still can't stop DNS rebinding. Between the resolution and the fetch's own, a record
with a one-second TTL can change; closing that needs pinning the connection to the address that was
checked, which neither `fetch()` nor Workers exposes. The bound on the residual is unchanged: no
credential is attached, the body is capped, and the response must be the right shape, so the worst case
stays a blind GET.

### The Twitter guest token

`getGuestToken` kept its `cf: { cacheEverything, cacheTtl }` and gained a process-local memo with a
shared in-flight promise (`src/platforms/twitter/fetch.ts`). The `cf` option is a Cloudflare-only
field and is silently ignored elsewhere; without the memo, every cold card off Cloudflare minted a
fresh guest token. A token has roughly a 500-request budget, so the symptom was never an outage:
Twitter would rate-limit an instance for a reason invisible from the code. N processes still
hold N tokens, which is the same weakness the `cf` cache had (it is per-colo) and is bounded.

### The mux buffering fallback, bounded

`FixedLengthStream` is a Workers global, and `putMuxed` (`src/worker.ts`) used it to stream a muxed
MP4 into R2 without buffering. Off Cloudflare it doesn't exist, so every mux took the fallback:
`cache.put(key, await muxed.arrayBuffer())`, the whole video in memory. The comment called that
"bounded by the container's own MAX_BYTES output cap", which is true and is a bound of the wrong
size. `MAX_BYTES` is 393216000, a 375 MB output ceiling, beside `MAX_SECONDS` 1500
(`container/server.py`), and `RESOLVER_SLOTS` is 4. Four ordinary long videos, with no attacker
involved, would hold 1.5 GB resident.

Three paths now, in order of how little memory they hold:

1. `FixedLengthStream` plus a `content-length` is the Workers production path, unchanged. The
   container always sends the header (`send_header("content-length", str(size))`).
2. `MEDIA_CACHE.putStream(key, stream, length)`: implement this if your store can take a
   stream (a file write, an S3 multipart upload). R2 can't, which is why `FixedLengthStream` exists
   at all. A store that implements it never buffers and is not subject to the ceiling. The Node
   adapter's directory store implements it.
3. Buffering, capped at `MUX_BUFFER_MAX` (default 64 MB, env-overridable). Bodies with no
   `content-length` are read with a running total and abandoned at the cap rather than measured
   after the fact. Past the cap the object is not stored: that view degrades to the cover still,
   exactly as a failed mux does, and a line goes to stderr.

64 MB was chosen against the ~128 MB Workers isolate ceiling. Nobody has measured the distribution
of video sizes. The refusal has a cost: an over-ceiling video re-muxes on every view. `putStream` is
the fix; raising `MUX_BUFFER_MAX` is the workaround for an operator with memory to spend.

### The front page's link preview

Paste your instance's front page into Discord and it unfurls from the page's own head. The Worker
points `og:url`, `og:image` and `twitter:image` at your primary `PUBLIC_ORIGIN` entry and drops the
domain from `og:image:alt` (`injectPage` in `src/sitepage.ts`). It can't redraw the picture itself:
`public/og.jpg` is mbedfx.app's artwork, with the mbedfx.app wordmark across the middle. Until you
replace the file, your front page unfurls with somebody else's domain on it.

The head declares the picture's size and type in `og:image:width`, `og:image:height` and
`og:image:type`, and Discord won't draw a large image without a declared size. That is why a
replacement of another size needs those three tags changed as well (step 2 of
[Before a public deployment](#before-a-public-deployment)). Nobody has measured how long Discord
keeps showing the old picture for a link it unfurled before the swap.

### Egress IP

Platforms answer a datacenter IP differently from a residential one, in both directions. Some of
that difference is a flap rather than a rule, and since 1.11.0 the fetchers no longer take a single
refusal as the answer: `src/fetchretry.ts` carries one extra ask (`askTwice`, `ASK_ATTEMPTS = 2`,
retried on 408, 425, 429 and 5xx) across thirty call sites in sixteen platform fetchers (counted
2026-11-25; `grep -rnE "askTwice\(" src/platforms | grep -vE ":[0-9]+:\s*(\*|//)" | wc -l`),
YouTube's among them since 1.12.0. So a refusal in the rows below means a host was refused twice,
not once.

Each of the ten surfaces below was measured for whether the answer changes with the IP the fetch
leaves from.

| Platform / surface | Measured | Where |
|---|---|---|
| Reddit anonymous `.json` | Verified 2026-07-21: Workers egress gets a 403 "network security" block page. A residential host got the same 403 on 2026-11-25. `embed.reddit.com` refused Workers egress from 2026-10-22 (403, measured 2026-10-25), which is why the archive path and the relay exist. From a residential host it is refused to curl and served to Node's `fetch` (see below). | `src/platforms/reddit/fetch.ts` |
| Reddit embed with a placeholder subreddit | Measured from Workers egress 2026-07-22: a placeholder sub gets a stripped render. The real subreddit has to be passed. | `src/platforms/reddit/fetch.ts` |
| Facebook `/share/{code}` 302 | Measured on one share code: a browser-shaped request from a laptop gets `302 -> /posts/…`, the same request from Cloudflare's egress gets none. Confirmed by natural experiment against the live worker. On 2026-11-25 a residential host got it too, for a reel's `/share/v/{code}` (to `/reel/{id}/`). | `src/platforms/metashare/fetch.ts` |
| Instagram embed | From datacenter egress the embed returned an ~81 KB "unavailable" shell and a public post rendered as private. Residential egress never reproduced it, and it reached production. The shell is about 183 KB as of 2026-11-25, so judge it with `hasEmbedPayload`, never by size. | `src/worker.ts` (the note near `fullpage_recovered`) |
| Threads video (`scontent*.cdninstagram.com`) | Once blocked for the container's egress. A Worker fetch on 2026-08-09 got 200 `video/mp4` (8,990,730 bytes), and the Worker now serves those bytes itself. A residential host got the same file on 2026-11-25. | `src/platforms/threads/normalize.ts`, `src/mediaproxy.ts` |
| Google translate endpoint | Measured 2026-07-31 from a Worker: answers in 13-16 ms and is not blocked from Cloudflare's egress. It does rate-limit bursts, and ~30 requests in a few seconds drew HTTP 429 on every one. | `src/translate.ts` |
| Twitter guest endpoints | Byte-identical from residential and Cloudflare Workers egress in the 2026-07-19 recon; the activation and `TweetResultByRestId` were both measured working. On 2026-11-25 from a residential host, syndication (the primary path) answered `/jack/status/20` without `retweet_count`, while mbedfx.app's card for it showed a repost count. The Cloudflare side of that was not measured. | `src/platforms/twitter/fetch.ts` (`activateGuestToken`, `fetchGuest`, and the recon note before `GUEST_BEARER`) |
| YouTube via yt-dlp | Not datacenter-IP-blocked, and measured per player client since 2026-08-28. A `{page}` resolve returned a real ad-free MP4 from Cloudflare Container egress on 2026-07-22; it needed Deno for the signature challenge, not a different IP. `/_clients` then extracted one video with six clients on that egress and range-fetched each chosen format: `default`, `web_embedded`, `tv_simply`, `mweb` and `web_safari` all served bytes with no PO token, and only `android_vr` was refused (`http-403`). `tv_simply` and `mweb` are the two clients yt-dlp's PO Token Guide says require one, so a token provider buys a self-hoster on datacenter egress nothing. Refusals are intermittent rather than absolute: worth one retry, not a verdict. | `src/worker.ts` (`/_clients`), `container/README.md` |
| Instagram copyright recovery (`copyright_recovered`) | Unconfirmed from Cloudflare egress. Every measurement behind it is residential, and the recovery fails silently into a cover still. The counter exists so the failure is visible at all. | `src/analytics.ts` |
| Instagram generally | Instagram's behaviour toward Cloudflare is path-dependent: a residential result does not transfer to Workers egress by itself. | `src/platforms/instagram/fetch.ts` |

#### Measured from a residential host, 2026-11-25

The first probes from somewhere other than Cloudflare or a laptop: a Debian box on a home connection,
curl 8.14.1 and Node's `fetch`, with the header sets the fetchers send. Each result was judged by the
repo's own checks (`hasEmbedPayload`, `hasThreadsSSR`, the Reddit embed markers) rather than by status code.

| Probe | Result | What it means |
|---|---|---|
| Reddit `.json` | 403 block page, for curl and for Node | Blocked from a home line too. Nothing uses it. |
| Reddit embed | 403 to curl, 200 with the full post to Node, same IP and headers | Reddit's gate is keyed on the client. The address made no difference. A Node self-host on a home line gets the embed that Cloudflare's egress lost on 2026-10-22. Other runtimes were not measured. |
| Facebook `/share/v/{code}`, a public reel | 302 to `/reel/{id}/`, asked with the resolver's `SHARE_HEADERS` | A home line gets the redirect. Earlier that day mbedfx.app drew the share link as an image and the reel's own link as a video. By 19:35 UTC both drew a video, and that answer came from yt-dlp, which production asks first. Why the earlier paste drew an image wasn't recorded. The image card doesn't show whether Cloudflare's egress got the 302 for this code: production reads the share page before it asks for a redirect, and that read follows one if it comes. |
| Instagram embed | 200 with a real payload for a normal post (`DaQ5CPTki4E`) | Works. The usual sample, `DZxLuleoEoC`, fails its embed from anywhere (a fake code gets the same page), so it is a poor egress probe. |
| Threads SSR, then its `scontent` video | 200 SSR with one video; then 200 `video/mp4`, 8,990,784 bytes | Both work from a home line. |
| Google translate | 200, the expected translation | No address block. The burst limit was not tested. |

#### What changes on a different host

A home line gets the Facebook `/share` 302 that the public instance doesn't, though for a video it
matters only after yt-dlp misses. The Instagram embed and Threads video both answered from a home line
on 2026-11-25, and Threads isn't a difference at all, since the Worker has served those bytes itself
since 2026-08-09 (`src/mediaproxy.ts`). Reddit's anonymous `.json` is refused from a home line too.
Reddit's embed answered Node's `fetch` and refused curl from the same address, so there the client
decided, not the address. Google's limit is on burst rate, not on address, and an instance with a cold
cache bursts harder than the public one.

A VPS or cloud host sits in the same category as the public instance, possibly worse: a smaller
provider's ranges are often blocked more aggressively than Cloudflare's. None of the rows above
transfer to a different datacenter operator. Every one was taken from a residential laptop, one home
Debian box or Cloudflare, none from AWS, Hetzner or any other provider.

`translate_fallback`, `copyright_gql` / `copyright_recovered` / `copyright_remux` and
`fullpage_recovered` exist to make an egress-wide block visible, where the cards keep rendering and
the failure is otherwise silent (`src/analytics.ts`).

#### Measuring your own egress

Run the fetchers from the host you plan to use and compare against the tables above: Reddit's
anonymous `.json`, a Facebook `/share/{code}`, an Instagram embed for a known-public post, a Threads
`scontent` video URL, and a Google translate call. Record the results here with the date and the
host type.

YouTube needs no manual procedure, because it has an instrument. `GET /_clients` runs
`container/server.py`'s probe on your own resolver: it extracts one fixed video with each client in
`PROBE_CLIENTS` and then range-fetches the format each one chose, so it reports bytes rather than a
format list. A client can list formats and still be refused by googlevideo, and only the range fetch
tells the two apart. Run it from the egress you intend to serve from before concluding anything
about YouTube on your host, because every claim in this project that was reasoned from a laptop and
not re-measured this way turned out to be wrong in one direction or the other.

### History

Issue #27 tracked the port. Its first phase, the Node adapter with no change under `src/`, is done:
`adapters/node/server.ts` turns each `IncomingMessage` into a `Request` on the configured origin and
streams the `Response` back; the `env` literal carries `ASSETS` over `public/`, `MEDIA_CACHE` as a
directory, `MEDIA_RESOLVER` at the container, `MUX_RUNNER` and `SMOKE_RUNNER` in process, `AE` off or
on stdout and `AI` unbound; a tracking `waitUntil` drains on SIGTERM; the `CacheLike` is a `Map` that
honours `max-age`; and `Deps` comes from `{ ...scheduledDeps(), cache }`, not a hand copy. The
Dockerfile and compose file in `adapters/node/` were built and run by hand on 2026-11-25
([The Docker run](#the-docker-run)), and five posts were checked against production
([What the first run measured](#what-the-first-run-measured)). The generic and Free Cloudflare configs
followed in #144.

Still open:

- An actual shared `CacheLike`. Deliberately not in this repo: it would mean a client library and a
  dependency for one of two runtimes. The seam is two methods wide, and the store is the operator's
  choice.
- A CI job that builds both images.
- A public instance off Cloudflare, and a first real deploy of the button, the generic config and the
  Free config. None of the safety corrections has been tested under real traffic off Cloudflare yet.
