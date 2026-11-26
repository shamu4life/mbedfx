# mbedfx relay

A small forwarder that sends mbedfx's Reddit and archive requests from a Google Cloud Run address
instead of Cloudflare's. Reddit blocks every request from Cloudflare (since 2026-10-22), and the
Arctic Shift archive rate-limits the one address every Cloudflare Worker shares, so where a request
comes from decides whether a Reddit card works. `server.mjs` says what was measured.

It is not an open proxy. It asks only three hosts (`embed.reddit.com`, `www.reddit.com`,
`arctic-shift.photon-reddit.com`), only over https, only for a caller holding the key, and it
follows a redirect only to one of those hosts. `/selftest` takes no input and no key, asks three
fixed urls, and keeps its answer for a minute.

| Route | What it answers |
|---|---|
| `GET /` | `mbedfx relay`, as a health check |
| `GET /selftest` | What this address gets from Reddit's embed page, Reddit's crawler page and the archive, as JSON |
| `GET /fetch?url=…&redirect=manual\|follow` | The upstream's answer, marked `x-relay: upstream`. Needs `x-relay-key` |

Anything the relay says itself (a missing key, a refused host, an upstream that did not answer) is
marked `x-relay: error`, so mbedfx can fall back to asking directly.

## Deploying it on Google Cloud Run

Everything happens in Google Cloud Shell, a terminal in the browser with Google's tools already
signed in. Nothing to install. Cloud Run's free tier (2 million requests a month) covers this
relay's traffic, but Google requires a billing account on the project anyway.

1. Open <https://shell.cloud.google.com> and sign in with your Google account.

2. Create a project for the relay and point Cloud Shell at it. The project id must be unique across
   Google, so this one ends in random digits:

   ```sh
   PROJECT=mbedfx-relay-$RANDOM
   gcloud projects create $PROJECT
   gcloud config set project $PROJECT
   ```

3. Link a billing account. The first command lists yours; put its `ACCOUNT_ID` into the second. If
   the list is empty, create one at <https://console.cloud.google.com/billing> and come back.

   ```sh
   gcloud billing accounts list
   gcloud billing projects link $PROJECT --billing-account=ACCOUNT_ID
   ```

4. Get the code and make a key. **Copy the key it prints somewhere safe**: Cloudflare needs the same
   one, and it is the only thing that stops strangers using the relay.

   ```sh
   git clone https://github.com/shamu4life/mbedfx.git
   cd mbedfx/relay
   KEY=$(openssl rand -hex 32); echo "$KEY"
   ```

5. Deploy. Answer `y` if it offers to enable APIs (Cloud Run, Cloud Build, Artifact Registry). It
   takes two or three minutes and ends by printing a `Service URL`.

   ```sh
   gcloud run deploy mbedfx-relay --source . --region us-east1 \
     --allow-unauthenticated --set-env-vars RELAY_KEY=$KEY \
     --max-instances 2 --memory 256Mi --timeout 30
   ```

   `--allow-unauthenticated` lets Cloudflare reach it; the key does the locking. `us-east1` is close
   to the Cloudflare locations mbedfx's requests leave from (ATL, IAD). `--max-instances 2` caps what
   it can ever cost.

6. Check it: open `<Service URL>/selftest` in a browser. `embed.post: true` means Reddit gives this
   address the full embed page, which is the best case.

7. Give your mbedfx the two values:

   - `REDDIT_RELAY_URL` = the Service URL
   - `REDDIT_RELAY_KEY` = the key from step 4

   On Cloudflare, use the dashboard: Workers & Pages, then your Worker (`mbedfx-selfhost` from the
   generic `wrangler.jsonc` unless you renamed it, `mbedfx` for mbedfx.app), Settings, Variables and
   Secrets, Add. Add both as type **Secret**. A secret survives every deploy, which a plain variable
   does only under the generic config's `keep_vars`. From a checkout,
   `npx wrangler secret put REDDIT_RELAY_URL` and then the same for `REDDIT_RELAY_KEY` do the same
   job; for mbedfx.app add `-c wrangler.production.jsonc`.

   Under Docker Compose, put both lines in `adapters/node/.env`, and compose passes them to the
   adapter. On the Node adapter without Docker, set them as environment variables of the `node`
   process: the adapter reads no `.env` file.

Off Cloudflare you may not need a relay at all. On 2026-11-25, Node's `fetch` got Reddit's embed
from a home connection, where curl from the same address was refused (docs/SELF-HOSTING.md, "Egress
IP").

## A relay for a different mbedfx

`/selftest` sends the archive the same user agent as mbedfx.app's Worker. If your Worker serves
another domain, it sends its own instead: your primary `PUBLIC_ORIGIN` host, then
`(embed fixer; +https://github.com/shamu4life/mbedfx)`. Set `ARCHIVE_USER_AGENT` to that string so
the self-test measures the request your Worker makes. In step 5, put it in `--set-env-vars`
with the whole list in double quotes, because the value has spaces:

```sh
--set-env-vars "RELAY_KEY=$KEY,ARCHIVE_USER_AGENT=embed.example.com (embed fixer; +https://github.com/shamu4life/mbedfx)"
```

Nothing else reads it. A request through `/fetch` carries your Worker's own user agent.

## Updating it

From Cloud Shell, in `mbedfx/relay`: `git pull`, then `KEY=` followed by the key you saved, then
step 5 again. Keeping the same key means nothing changes on the Cloudflare side. If you set
`ARCHIVE_USER_AGENT`, keep it in the list too: `--set-env-vars` replaces every variable the
service had.
