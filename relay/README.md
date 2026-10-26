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

7. Give mbedfx the two values, in the Cloudflare dashboard: Workers & Pages, `mbedfx`, Settings,
   Variables and Secrets, Add. Add both as type **Secret** (a secret survives every deploy; a
   plain variable set in the dashboard is replaced by the next one):

   - `REDDIT_RELAY_URL` = the Service URL
   - `REDDIT_RELAY_KEY` = the key from step 4

## Updating it

From Cloud Shell, in `mbedfx/relay`: `git pull`, then `KEY=` followed by the key you saved, then
step 5 again. Keeping the same key means nothing changes on the Cloudflare side.
