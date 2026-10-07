# Operations

How to install, set up, extend, upgrade, back up, restore and troubleshoot a
Launchway installation.

The installation, first-run setup, a deployment with a domain, and a backup
followed by a restore into a fresh installation were run end to end on Docker
Desktop for macOS with images built from this repository. Linux and Windows
use the same Compose file and equivalent installers.

## What gets installed

The installer copies `deploy/compose.yaml` and the bootstrap `Caddyfile` into
the install directory and generates `.env` next to them. The Compose project
`launchway` runs on one machine, the *edge node*:

| Service | Image | Role |
|---|---|---|
| `launchway` | `ghcr.io/jenspenneman/launchway` | API and web UI; published on host port 3000 by default |
| `launchway-agent` | `ghcr.io/jenspenneman/launchway-agent` | Agent of the local node; uses the Docker socket |
| `caddy` | `caddy:2-alpine` | Edge proxy; owns ports 80 and 443 (and 443/UDP) |
| `db` | `postgres:18-alpine` | PostgreSQL |

- **Networks:** the external network `launchway-proxy` (`10.210.0.0/24`, Caddy
  at `10.210.0.2`), which routed app services join under the alias
  `<app-slug>-<service>`; and the internal network `database`, shared only by
  `launchway` and `db`.
- **Volumes:** `db-data` (PostgreSQL), `caddy-data` (certificates and ACME
  account), `caddy-config` (Caddy's last loaded configuration) and
  `agent-data` (the agent's `/var/lib/launchway`: checkouts and the node
  credential).
- **Apps:** each app is a separate Compose project, `launchway-<app-slug>`,
  managed by the agent of the app's node.

The installer replaces `compose.yaml` on every run. Put local changes in
`compose.override.yaml` next to it; the installer and `docker compose` pick it
up automatically.

## Requirements

- Linux (`amd64` or `arm64`) with Docker Engine and the Compose plugin, or
  Docker Desktop on macOS or Windows (Linux containers).
- Free ports 80 and 443 for Caddy, and a free port for the web UI (3000 by
  default).
- For public domains: a public IPv4 address, with TCP ports 80 and 443
  (and UDP 443 for HTTP/3) forwarded to the edge node.
- Outbound HTTPS to GitHub, `ghcr.io`, your DNS provider and Let's Encrypt.

## Install

### Linux and macOS

```sh
curl -fsSL https://raw.githubusercontent.com/JensPenneman/launchway/main/deploy/install.sh | sh -s -- --email you@example.com
```

To read the script first, download it and run `sh install.sh --email
you@example.com`. Run it as root (or a user in the `docker` group) on Linux.

| Flag | Purpose |
|---|---|
| `--dir <path>` | Install directory. Default: `/opt/launchway` when run as root on Linux, otherwise `~/launchway`. |
| `--email <address>` | E-mail address of the Let's Encrypt (ACME) account. Required on the first install; asked for when a terminal is available. Let's Encrypt refuses addresses at `example.com`. |
| `--port <port>` | Host port of the API and web UI. Default: `3000`. Not 80 or 443. |
| `--version <version>` | Image tag to install, for example `0.1.0`. Default: `latest`. |

`LAUNCHWAY_DIR`, `LAUNCHWAY_ACME_EMAIL`, `LAUNCHWAY_PORT` and `LAUNCHWAY_VERSION` stand
in for the flags. The installer:

1. checks that Docker, the Compose plugin and the daemon are available;
2. creates the `launchway-proxy` network (`10.210.0.0/24`, dynamic addresses
   from `10.210.0.128/25` so nothing takes Caddy's `10.210.0.2`);
3. copies `compose.yaml` and the `Caddyfile` from next to the script (when run
   from a checkout) or downloads them from GitHub (`LAUNCHWAY_REF`; default
   the release tag `vX.Y.Z` when a release version is pinned, `main` for
   `latest` and `edge`);
4. writes `.env` (mode `0600`) and generates `LAUNCHWAY_SECRET_KEY`,
   `POSTGRES_PASSWORD`, `LAUNCHWAY_LOCAL_JOIN_TOKEN` and `LAUNCHWAY_SETUP_TOKEN`;
   values already in `.env` are kept;
5. pulls the images and runs `docker compose up -d --wait`;
6. prints the web UI address on the chosen port and, on a fresh install, the
   one-time setup link (`/setup#token=...`). The first-run setup refuses to
   create the owner without that token.

Running the installer again is safe: it keeps the secrets and upgrades the
images. It refuses to continue when a Launchway database volume exists but
`.env` lacks its secrets, instead of generating keys that cannot open it.

### Windows with Docker Desktop

Requirements: Docker Desktop with the WSL 2 backend in **Linux containers**
mode, and Windows PowerShell 5.1 or PowerShell 7. In PowerShell:

```powershell
$env:LAUNCHWAY_ACME_EMAIL = 'you@example.com'
irm https://raw.githubusercontent.com/JensPenneman/launchway/main/deploy/install.ps1 | iex
```

Or download `install.ps1` and run `.\install.ps1 -Email you@example.com`, with
the optional parameters `-Dir` (default `%USERPROFILE%\launchway`), `-Port`
(default `3000`) and `-Version`. The installer does the same as `install.sh`;
`.env` is readable by the current user only.

Windows specifics:

- Ports 80 and 443 must be free on Windows itself. Stop IIS or any other web
  server that holds them, and allow Docker Desktop through the Windows
  firewall when asked.
- Routes of kind `external` can reach services on the Windows host as
  `host.docker.internal:<port>`.
- The bundled agent runs inside Docker Desktop's VM and cannot see the
  machine's LAN address, so it reports none and logs a warning. That does not
  matter on the edge node. When a Windows machine is an *additional* node, set
  `LAUNCHWAY_NODE_LAN_IP` to its LAN address (see [Add a node](#add-a-node)).
- Keep the machine from sleeping; the platform stops with Docker Desktop.

### Running images you built yourself

From a checkout, build the images and point the stack at them with an
override, then run the installer from the checkout:

```sh
docker build -f apps/api/Dockerfile -t launchway:local .
docker build -f apps/agent/Dockerfile -t launchway-agent:local .
mkdir -p ~/launchway && cat > ~/launchway/compose.override.yaml <<'YAML'
services:
  launchway:
    image: launchway:local
    pull_policy: never
  launchway-agent:
    image: launchway-agent:local
    pull_policy: never
YAML
sh deploy/install.sh --dir ~/launchway --email you@example.com
```

## First-run setup

Port 3000 serves plain HTTP so that the first setup works before any domain
exists. Do not forward it on your router; once the platform domain works, use
its HTTPS URL. To stop serving the API on the LAN over plain HTTP afterwards,
bind the port to the loopback interface in `compose.override.yaml` (reach it
through an SSH tunnel when you need it):

```yaml
services:
  launchway:
    ports: !override
      - "127.0.0.1:3000:3000"
```

### In the browser

1. Open the setup link the installer printed (`http://<host>:3000/setup#token=…`)
   and create the owner account in the setup wizard (name, e-mail, password),
   then enter the platform URL and the ACME e-mail. Setup requires the token
   in that link (`LAUNCHWAY_SETUP_TOKEN` in `.env`), so nobody else who reaches
   the port can claim the instance.
2. **Account:** add a passkey (Settings → Account). Passkeys are bound to the
   platform URL, so register them on the URL you will keep using.
3. **GitHub** (Settings → GitHub): connect with a fine-grained personal access
   token (`Contents: read`, `Metadata: read`), or let Launchway create its GitHub
   App. The App flow needs the public URL to be set, because GitHub sends your
   browser back to it; after creating the App, install it on your account and
   pick the repositories. Release webhooks only arrive when GitHub can reach
   that URL; token connections poll for new releases every 5 minutes
   instead.
4. **DNS** (Settings → DNS): add a provider account, for example Cloudflare
   with an API token that can read zones and edit DNS, or `manual` (Launchway
   then only verifies the records you create). In Settings → Platform, set the
   anchor hostname (the name whose `A` record follows your public IPv4) and
   enable dynamic DNS.
5. **Nodes:** the local node (`local`) is online and is the edge node.
6. **Apps → New app:** pick the connection, the repository, the Compose files
   or the `Dockerfile` and build context, and the node. Deploy a release from
   the Deployments tab, then add a domain under Domains & routes and redeploy
   (routed services join the edge network when they are deployed).

### With the API

Everything the UI does is available over HTTP. The same steps with `curl`,
as run in the smoke test (the OpenAPI document is at `/api/openapi.json`, the
interactive reference at `/api/docs`):

```sh
API=http://localhost:3000/api/v1
curl -fsS "$API/setup"                                      # {"setupRequired":true,"setupTokenRequired":true}
curl -fsS -H 'content-type: application/json' -d '{"email":"you@example.com","name":"You","password":"…","setupToken":"lwys_…"}' "$API/setup"
# Sign in; cookie-authenticated changes must carry the platform Origin (CSRF protection).
curl -fsS -c cookies -H 'content-type: application/json' -d '{"email":"you@example.com","password":"…"}' "$API/auth/login"
curl -fsS -b cookies -H 'origin: http://localhost:3000' -H 'content-type: application/json' \
  -d '{"name":"cli","scopes":["admin"]}' "$API/tokens"           # .secret is the lwy_… token, shown once
H="authorization: Bearer lwy_…"
curl -fsS -X PATCH -H "$H" -H 'content-type: application/json' \
  -d '{"publicUrl":"https://deploy.example.com","acmeEmail":"you@example.com"}' "$API/settings"
curl -fsS -H "$H" "$API/nodes"                                # the local node is online
curl -fsS -H "$H" -H 'content-type: application/json' -d '{"name":"GitHub","token":"github_pat_…"}' "$API/github/connections/pat"
curl -fsS -H "$H" "$API/github/repos/traefik/whoami/releases?connectionId=gh_…"
curl -fsS -H "$H" -H 'content-type: application/json' \
  -d '{"name":"whoami","connectionId":"gh_…","repository":{"owner":"traefik","name":"whoami"},"dockerfile":"Dockerfile","context":".","nodeId":"node_…"}' "$API/apps"
curl -fsS -X PUT -H "$H" -H 'content-type: application/json' -d '{"value":"hello","secret":false}' "$API/apps/app_…/env/WHOAMI_NAME"
curl -fsS -H "$H" -H 'content-type: application/json' -d '{"ref":"v1.12.0"}' "$API/apps/app_…/deployments"
curl -fsSN -H "$H" "$API/deployments/dep_…/logs?follow=true"    # SSE until event: end
curl -fsS -H "$H" -H 'content-type: application/json' -d '{"hostname":"whoami.example.com"}' "$API/domains"
curl -fsS -H "$H" -H 'content-type: application/json' \
  -d '{"domainId":"dom_…","target":{"kind":"app","appId":"app_…","service":"app","port":80}}' "$API/routes"
curl -fsS -H "$H" "$API/edge/config"                          # rendered Caddyfile, inSync, lastError
```

A domain without a DNS zone is served once `POST /domains/{id}/verify` finds
its record pointing at your public IPv4 or anchor, or right away with
`"force": true`.

## Configuration

Docker Compose reads `.env` from the install directory:

| Variable | Purpose |
|---|---|
| `LAUNCHWAY_VERSION` | Image tag to run: `latest` (default), a release version or `edge`. |
| `LAUNCHWAY_PORT` | Host port of the API and web UI (default `3000`). |
| `LAUNCHWAY_PUBLIC_URL` | Optional. Overrides the public URL from the settings. |
| `LAUNCHWAY_ACME_EMAIL` | Required. Default ACME e-mail address; also used by Caddy's bootstrap configuration. |
| `LAUNCHWAY_SECRET_KEY` | Generated. 32 random bytes, base64. All encryption and cookie-signing keys are derived from it. Never change it, never lose it. |
| `LAUNCHWAY_LOCAL_JOIN_TOKEN` | Generated. Lets the bundled agent join, and rejoin, as the local node. Keep it secret. |
| `LAUNCHWAY_SETUP_TOKEN` | Generated. Required to create the owner account in the first-run setup; unused afterwards. |
| `POSTGRES_PASSWORD` | Generated. The database only accepts the password it was created with. |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info` (default), `debug` or `trace`. |
| `LAUNCHWAY_NODE_LAN_IP` | Optional. This machine's LAN address, reported by the bundled agent, which cannot detect it from the proxy network. The edge node works without it. |

All API and agent variables are described in section 13 of the architecture
and in [ADR 0009](adr/0009-v0-1-specification-interpretations.md). After
editing `.env`, apply the change with `docker compose up -d --wait`.

## Forward auth and extra directives

Protected routes ask a gate whether a request may pass. Set it under
Settings → Platform → Forward auth, either as an external URL or as a service
of a Launchway app. A passkey gate built from Pocket ID and oauth2-proxy runs
as one app (here with the slug `login`) and is wired up like this:

1. In the app's settings, an admin adds `oauth2-proxy` to **Proxy network
   services**. The service then joins the proxy network as
   `login-oauth2-proxy` without a public route.
2. Route the login host name (for example `login.example.com`) to the
   `pocket-id` service.
3. Under Settings → Platform, choose **App service**: app `login`, service
   `oauth2-proxy`, port `4180`, URI `/oauth2/auth`. The answer says when the
   app has to be redeployed before the edge can reach the service.
4. Redeploy the app if asked, then mark routes as protected.

Over the API, step 1 is `PATCH /api/v1/apps/{id}` with `proxyServices`
(admin role) and step 3 is `PATCH /api/v1/settings` with `forwardAuthTarget`
(`{appId, service, port, uri}`). `forwardAuthTarget` and `forwardAuthUrl`
exclude each other: set the one you do not use to `null`. The answer carries
`hints` (`redeploy-required`, `gate-unreachable`). While the target cannot be
reached (app deleted, app not on the edge node), protected routes are not
served. Nodes need the matching agent version before services without a route
are attached.

Admins can add **extra Caddy directives** to a route (route editor → Extra
Caddy directives). They go verbatim inside the site block, after the option
directives and before the upstream, and Caddy checks them when you save. For
the login host:

```caddy
# oauth2-proxy answers its own endpoints; everything else goes to Pocket ID.
handle /oauth2/* {
	reverse_proxy login-oauth2-proxy:4180
}

# Close the sign-up and setup pages to the internet.
@closed path /setup* /signup* /api/signup*
respond @closed 404

# Never pass a client-supplied API key through.
request_header -X-API-KEY
```

`respond` only takes one path, so several paths need a named matcher
(`@closed`) as above. Over the API the same text is the route's
`extraDirectives` (`PATCH /api/v1/routes/{id}`, admin role). The answer
lists `warnings` when Caddy could not be reached and only the structural
check ran.

## Platform variables

Every deployment writes these variables into the app's environment, next to
the variables you set: `LAUNCHWAY_APP` (slug), `LAUNCHWAY_APP_ID`,
`LAUNCHWAY_DEPLOYMENT_ID`, `LAUNCHWAY_REF`, `LAUNCHWAY_COMMIT_SHA`,
`LAUNCHWAY_COMMIT_SHA_SHORT` and `LAUNCHWAY_NODE` (node name). The
`LAUNCHWAY_` prefix is reserved: the API refuses app variables that start with
it. They reach the containers the same way as your own variables: a
single-`Dockerfile` app gets them in its environment, and Compose files can
reference them like any other variable (for example `${LAUNCHWAY_REF}`).

## Add a node

A node is any machine with Docker that runs the agent. The agent connects
outbound, so the node needs no inbound port for the agent itself. For routed
apps on the node, the edge node must reach the node's LAN address on the
ports Launchway publishes there (ephemeral host ports, one per routed service
port): allow that traffic from the edge in the node's firewall.

1. Set the public URL first (Settings → Platform): it becomes the agent's
   `LAUNCHWAY_SERVER_URL` (`https://…` turns into `wss://…`). A node on the same
   LAN without a public URL can use `ws://<edge-lan-ip>:3000`.
2. In the UI, open **Nodes → Add node**. Launchway shows a one-time join token
   (`lwyn_…`, valid for 15 minutes) with a ready-made `docker run` command and
   a Compose file. Over the API: `POST /api/v1/nodes` with `{"name": "…"}`
   returns `{ node, joinToken: { token, expiresAt, serverUrl,
   dockerRunCommand, composeSnippet } }`; `POST /api/v1/nodes/{id}/join-token`
   issues a new token for an existing node.
3. On the new machine, run the `docker run` command, or save the Compose file
   as `compose.agent.yaml` and start it:

   ```sh
   docker compose -f compose.agent.yaml up -d
   ```

   Optional variables: `LAUNCHWAY_VERSION` (keep it equal to the control
   plane's), `LAUNCHWAY_NODE_LAN_IP` (the address the edge uses to reach this
   node, see below) and `LOG_LEVEL`.

On its first start the agent exchanges the join token for a long-lived node
credential, stores it in its `agent-data` volume at
`/var/lib/launchway/agent/credentials.json` (mode `0600`); it creates the
`launchway-proxy` network on the node with the first deployment. The join token
is not needed after that;
`LAUNCHWAY_SERVER_URL` is needed on every start. The node shows as online once
the handshake completes, and queued deployments for it are sent right away.

The agent reports the node's LAN address each time it connects, taking the
first of:

1. `LAUNCHWAY_NODE_LAN_IP`;
2. a private IPv4 address the Docker daemon reports for its host (the node
   address, when the daemon is in swarm mode, except on Docker Desktop, whose
   daemon runs in a VM);
3. the first IPv4 address of the agent's network interfaces, skipping
   loopback and link-local addresses, Docker, CNI and VPN interfaces, and
   addresses inside the subnet of a Docker bridge network on the node. With
   host networking, as in the commands above, that is the machine's own
   address.

Inside a bridge network (the bundled agent on the proxy network) and in any
container on Docker Desktop, the agent only sees addresses that other
machines cannot reach. It then reports no LAN address and logs a warning that
asks for `LAUNCHWAY_NODE_LAN_IP`. Set it as well when the detected address is
the wrong one (`GET /api/v1/nodes` shows `lanIp`). Without a LAN address,
routes to apps on the node are left out of the edge configuration, and
`GET /api/v1/edge/config` says so; the edge node itself needs none.

Node credentials can be rotated (the agent must be online) and revoked in the
UI. To reconnect a node whose credential was revoked or lost, issue a new join
token, put it in `LAUNCHWAY_JOIN_TOKEN` and restart the agent: when the server
refuses the stored credential, the agent joins again with the token. Whoever
can read the agent's volume can act as that node, and the agent is
root-equivalent on its machine: protect both.

### Trusted mounts (bind mounts and existing volumes)

The Compose policy refuses host bind mounts, `external: true` volumes and
custom volume names. To run a stack that needs them (for example one that
bind-mounts a backup folder and reuses an existing database volume):

1. As an admin, open the node and add its **Allowed bind-mount roots**, one
   absolute directory per line, or `PATCH /api/v1/nodes/{id}` with
   `{"allowedBindRoots": ["/srv/backups"]}`.
2. As an admin, open the app's **Settings → Mounts** and turn on **Trusted
   mounts**, or `PATCH /api/v1/apps/{id}` with `{"trustedMounts": true}`.
3. Deploy again. The deployment log lists each mount that trust allowed; a
   refused mount names the node's allowed roots.

Roots and bind sources are paths **as the Docker daemon sees them**, which is
not always the path on the machine:

- On Linux it is the host path, e.g. `/srv/backups`.
- On Windows with Docker Desktop (WSL 2), a Windows drive is mounted below
  `/run/desktop/mnt/host/<drive letter in lower case>/`: `D:\Backups\trail`
  is `/run/desktop/mnt/host/d/Backups/trail`. Use that form both as the root
  and in the Compose file. To check a path, list it from a container:

  ```powershell
  docker run --rm -v /run/desktop/mnt/host/d/Backups:/probe alpine ls /probe
  ```

To reuse an existing volume, declare it `external: true` with its real name
(`docker volume ls` lists the names), for example
`volumes: { pgdata: { external: true, name: trail_pgdata } }`.

Even trusted apps cannot mount the Docker socket, `/`, `/proc`, `/sys`,
`/dev`, `/etc`, `/var/run` or `/run` (except below a deeper allowed root such
as Docker Desktop's drive path), Docker's data directory, the agent workspace
or the platform's own volumes, and cannot use `shared`/`slave` mount
propagation. See [ADR 0015](adr/0015-trusted-mounts-are-an-explicit-admin-decision.md).

## Automatic deployments

An app deploys by itself in three cases (Settings → Runtime, or `PATCH
/api/v1/apps/{id}`):

- **Releases** (`autoDeployReleases`): every published GitHub release. Drafts
  never deploy; prereleases only with `autoDeployPrereleases`.
- **Branch pushes** (`autoDeployBranch`, e.g. `"main"`): every push to that
  branch deploys the pushed commit. This needs a GitHub App connection whose
  App subscribes to **push** events (GitHub → the App's settings →
  Permissions & events → Subscribe to events → Push). Token connections only
  poll releases.
- **Release polling**: token connections check the latest release every 5
  minutes.

### Apps whose images CI builds

When the Compose file references an image that CI builds, for example
`image: ghcr.io/acme/trail:${LAUNCHWAY_REF}`, the release webhook and the
image build start at the same moment and the deployment can reach
`docker compose pull` before the image exists. Two things handle this:

1. **Publish the release after the image.** Let release-please (or your
   release tool) create the release as a **draft**, build and push the image
   in CI, and publish the draft as the last CI step. GitHub then sends the
   release webhook when the image exists. Launchway ignores drafts and deploys
   when the draft is published.

   In `release-please-config.json`:

   ```json
   { "draft": true, "force-tag-creation": true, "packages": { ".": {} } }
   ```

   `force-tag-creation` makes release-please create the tag for the draft, so
   CI can build `ghcr.io/acme/trail:<tag>` from it. Then, in the workflow:

   ```yaml
   on:
     push:
       branches: [main]
   permissions:
     contents: write
     packages: write
   jobs:
     release:
       runs-on: ubuntu-latest
       outputs:
         created: ${{ steps.rp.outputs.release_created }}
         tag: ${{ steps.rp.outputs.tag_name }}
       steps:
         - id: rp
           uses: googleapis/release-please-action@v4
     image:
       needs: release
       if: needs.release.outputs.created == 'true'
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v5
           with: { ref: "${{ needs.release.outputs.tag }}" }
         - uses: docker/login-action@v3
           with:
             registry: ghcr.io
             username: ${{ github.actor }}
             password: ${{ secrets.GITHUB_TOKEN }}
         - uses: docker/build-push-action@v6
           with:
             push: true
             tags: ghcr.io/${{ github.repository }}:${{ needs.release.outputs.tag }}
         # Last step: publishing the draft sends the webhook that deploys it.
         - run: gh release edit "$TAG" --draft=false --repo "$GITHUB_REPOSITORY"
           env:
             GH_TOKEN: ${{ github.token }}
             TAG: ${{ needs.release.outputs.tag }}
   ```

   A release published by `GITHUB_TOKEN` does trigger the GitHub App's
   webhook (only other workflows are not triggered by it).

2. **Retries as the safety net.** An automatic deployment (release, push or
   poll) that fails because the registry does not know the image
   (`manifest unknown`, `name unknown`, a registry 404) goes back to the queue
   and is retried after 1, 2, 4, 8, 15, 15 and 15 minutes. The Deployments
   tab shows "Waiting for image, retry n at …"; cancelling it there stops the
   retries. After 60 minutes of waiting it fails with the original error. When
   a newer deployment of the app starts meanwhile, the waiting one is
   cancelled. A deployment you start by hand fails at once and asks you to
   deploy again once the image exists. Access errors (`denied`,
   `unauthorized`) are never retried: log the node's Docker in to the registry
   (`docker login ghcr.io`) instead. See
   [ADR 0019](adr/0019-retry-automatic-deployments-until-the-image-exists.md).

For branch pushes, tag the image with the commit
(`ghcr.io/acme/trail:sha-${LAUNCHWAY_COMMIT_SHA_SHORT}` in Compose and
`sha-${GITHUB_SHA::7}` in CI); the retries cover the time the build takes.

## Upgrade

In the install directory:

```sh
docker compose pull
docker compose up -d --wait
```

Running the installer again does the same and also refreshes `compose.yaml`
and the `Caddyfile`. With `LAUNCHWAY_VERSION=latest`, this moves to the newest
release. If `.env` pins a version, change `LAUNCHWAY_VERSION` first. Release
images are also tagged with their minor version (for example `0.1`), which
receives patch releases only. Every release is a GPG-signed tag `vX.Y.Z` with
a GitHub release that carries its changelog; its images are built from that
tag and signed with cosign ([SECURITY.md](../SECURITY.md) shows how to verify
them).

The API applies database migrations when it starts. Migrations only move
forward, so take a [backup](#backup) before upgrading: going back to an older
version means restoring that backup. Avoid upgrading while a deployment runs:
deployments in progress when the API restarts are marked failed ("node went
offline") and need to be started again.

Upgrade the agents on other nodes as well, keeping their `LAUNCHWAY_VERSION`
equal to the control plane's:

```sh
docker compose -f compose.agent.yaml pull
docker compose -f compose.agent.yaml up -d
```

The control plane refuses agents that speak an incompatible protocol version;
the UI shows those nodes with an error until they are upgraded.

## Backup

Back up three things.

1. **The database.** From the install directory:

   ```sh
   docker compose exec -T db pg_dump -U launchway -Fc launchway > launchway.dump
   ```

2. **The `.env` file.** It holds `LAUNCHWAY_SECRET_KEY`. Without that key, the
   encrypted values in the database (environment variables, DNS provider
   credentials, GitHub tokens and App credentials) cannot be recovered, even
   from a complete dump. Store the file separately from the dump and treat it
   as a secret.

3. **The `caddy-data` volume**, which holds the certificates and the ACME
   account (mounted at `/data` in the `caddy` container):

   ```sh
   docker compose exec -T caddy tar -czf - -C /data . > caddy-data.tar.gz
   ```

   Without it, Caddy requests new certificates, which can run into Let's
   Encrypt rate limits when you serve many domains.

A daily database dump kept for a few weeks, plus a copy of `.env` taken once,
covers most setups. Launchway v0.1 does not back up the volumes of deployed
apps; use your own tooling for app data. Scheduled, encrypted volume backups
are planned (see [roadmap.md](roadmap.md)).

## Restore

On the target machine:

1. Install the same Launchway version that made the backup (`--version`). The
   fresh installation generates its own secrets; that is expected.
2. Stop the services that use the database:

   ```sh
   docker compose stop launchway launchway-agent
   ```

3. Restore the dump into the new database:

   ```sh
   docker compose exec -T db pg_restore -U launchway -d launchway --clean --if-exists --no-owner < launchway.dump
   ```

4. Replace `LAUNCHWAY_SECRET_KEY` in the new `.env` with the backed-up value.
   Keep the new `POSTGRES_PASSWORD`: it belongs to the new database volume.
5. Optionally restore the certificates:

   ```sh
   docker compose exec -T caddy tar -xzf - -C /data < caddy-data.tar.gz
   ```

6. Start everything with `docker compose up -d --wait`, check
   `/api/health/ready` and sign in with your existing account.

After the restore, users, API tokens, apps, encrypted secrets and settings are
back. The bundled agent rejoins as the restored `local` node with the new
installation's `LAUNCHWAY_LOCAL_JOIN_TOKEN` (the API registers it at start and
the agent falls back to it when its stored credential is refused). Agents on
other nodes keep working with their stored credentials as soon as their
`LAUNCHWAY_SERVER_URL` reaches the new machine, for example once the platform
domain points at it.

## Logs

Platform logs, from the install directory:

```sh
docker compose logs -f launchway    # or launchway-agent, caddy, db
```

The level is set with `LOG_LEVEL`. Container logs are rotated by Docker
(five files of 10 MB per container).

Deployment and app logs are shown in the UI and are available from the API as
Server-Sent Events:

- `GET /api/v1/deployments/{id}/logs?follow=true`
- `GET /api/v1/apps/{id}/logs?service=<service>&tail=200&follow=true`

On a node, the containers of an app belong to the Compose project
`launchway-<app-slug>` and carry the labels `launchway.app`, `launchway.deployment`
and `launchway.service`:

```sh
docker ps --filter label=com.docker.compose.project=launchway-<app-slug>
docker logs -f <container>
```

## Health checks

```sh
curl -fsS http://localhost:3000/api/health/live    # the process is up
curl -fsS http://localhost:3000/api/health/ready   # the database is reachable
docker compose ps                                  # container health
```

## Troubleshooting

- **A node is offline.** A node is marked offline after 45 seconds without a
  heartbeat. Check the agent's logs on that node and whether it can reach
  `LAUNCHWAY_SERVER_URL`. Deployments for an offline node wait in `queued`
  until the node has been gone for 10 minutes, then fail. Deployments in
  progress fail when the node does not reconnect within 45 seconds.
- **The API logs `agent socket refused: invalid token`.** An agent presents a
  join token or credential the server does not know (expired token, revoked
  credential, restored or reset database). Issue a new join token for that
  node, set it as `LAUNCHWAY_JOIN_TOKEN` and restart the agent.
- **A script gets `403 Cross-site request rejected`.** Changes made with the
  session cookie must carry the platform `Origin` (browsers send it). Use an
  API token (`Authorization: Bearer lwy_…`) for scripts.
- **`429 rate-limited`.** Setup, sign-in, passkey, invitation and token
  endpoints are rate-limited per client address; wait for `Retry-After`.
- **A new route answers 502.** Routed services join the edge network when they
  are deployed: redeploy the app after adding its first route. The same
  applies to proxy network services and to the forward-auth app service.
- **Protected routes are not served.** `GET /api/v1/edge/config` says why in
  the Caddyfile comments. `forward auth: unavailable` means the gate app is
  gone or does not run on the edge node.
- **A domain gets no certificate.** Routes are only rendered once their
  domain passes the DNS check, unless it is forced; `active` means the edge
  serves the domain. Certificate errors show in `docker compose logs caddy`
  (look for `tls.obtain`). Check that ports 80 and 443 reach the edge node,
  that the ACME e-mail is a real address, and that the zone's CAA records (if
  any) allow `letsencrypt.org`.
- **A domain is `misconfigured`.** The message names the record that was
  expected (`A <public IPv4>` or `CNAME <anchor>`) and what was found. Fix
  the record, then press Verify (`POST /api/v1/domains/{id}/verify`); domains
  are also re-checked every two minutes.
- **A deployment is rejected by the policy.** The deployment log shows the
  reason. Replace host bind mounts with named volumes or with `configs:` that
  use inline `content`, and remove `privileged`, `network_mode: host`,
  `pid: host` and references to the `launchway-proxy` network.
- **A deployment says "Waiting for image".** The registry did not have the
  image yet; see [Automatic deployments](#automatic-deployments). If CI is
  done, check that the tag in the Compose file matches the one CI pushed.
- **The edge serves something unexpected.** `GET /api/v1/edge/config` returns
  the Caddyfile the API rendered, whether Caddy holds it (`inSync`) and the
  last load error; `POST /api/v1/edge/reload` loads it again.
- **The installer stops with "holds an existing Launchway database".** The
  database volume exists but `.env` is missing its secrets. Restore `.env`
  from your backup, or remove the old containers and the volume to start over.

## Uninstall

1. Delete your apps in the UI first, so their Compose projects are removed from
   the nodes. Choose to delete their data if you also want their volumes gone.
2. In the install directory, `docker compose down` removes the platform
   containers and keeps the volumes; `docker compose down --volumes` also
   deletes the database, the certificates and the agent's data.
3. Remove the network with `docker network rm launchway-proxy`.
4. On other nodes, run `docker compose -f compose.agent.yaml down --volumes`.
