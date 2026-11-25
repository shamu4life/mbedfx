# THE NODE ADAPTER: src/worker.ts behind node:http, off Cloudflare. docs/SELF-HOSTING.md has the
# variables and what each stand-in degrades.
#
# Build from the REPOSITORY ROOT, because the image needs src/ and public/ as well as this folder:
#   docker build -f adapters/node/Dockerfile -t mbedfx-adapter .
# adapters/node/compose.yaml does that for you and stands the resolver container up beside it.
#
# NOT BUILT BY WORKERS BUILDS and not exercised by CI. Built by hand on 2026-11-25 through compose.yaml
# (docs/SELF-HOSTING.md, "The Docker run"): 226 MB, and the image held no adapters/node/.env although
# one sat in the build context.

# 22.18.0 is .node-version, and the first 22.x that runs .ts files with no flag. Older Nodes refuse
# them with ERR_UNKNOWN_FILE_EXTENSION.
FROM node:22.18.0-slim

WORKDIR /app

# NO `npm ci`. Nothing src/worker.ts imports comes from node_modules: the npm and `cloudflare:`
# imports sit in src/container.ts, src/muxrunner.ts and src/smokerunner.ts, which only the Workers
# entry (src/index.ts) loads. package.json is copied for one field, `"type": "module"`, which makes
# Node read the .ts files as ES modules.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY adapters/node ./adapters/node

# MEDIA_CACHE lives here; compose mounts a named volume over it. A new named volume takes the owner of
# the directory it is mounted on, so the chown is what lets the unprivileged user write to it.
RUN mkdir -p /data/media && chown node:node /data/media
USER node

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 MEDIA_CACHE_DIR=/data/media
EXPOSE 8787
# server.ts drains its waitUntil work on SIGTERM. Give it longer than DRAIN_MS (25 s by default):
# `docker stop` sends SIGKILL after 10 s unless told otherwise (compose sets stop_grace_period).
STOPSIGNAL SIGTERM
CMD ["node", "adapters/node/server.ts"]
