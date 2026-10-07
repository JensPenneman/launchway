# Operations

How to install, set up, extend, upgrade, back up, restore and troubleshoot a
Slipway installation.

The installation, first-run setup, a deployment with a domain, and a backup
followed by a restore into a fresh installation were run end to end on Docker
Desktop for macOS with images built from this repository. Linux and Windows
use the same Compose file and equivalent installers.

## What gets installed

The installer copies `deploy/compose.yaml` and the bootstrap `Caddyfile` into
the install directory and generates `.env` next to them. The Compose project
`slipway` runs on one machine, the *edge node*:

| Service | Image | Role |
|---|---|---|
| `slipway` | `ghcr.io/jenspenneman/slipway` | API and web UI; published on host port 3000 by default |
| `slipway-agent` | `ghcr.io/jenspenneman/slipway-agent` | Agent of the local node; uses the Docker socket |
| `caddy` | `caddy:2-alpine` | Edge proxy; owns ports 80 and 443 (and 443/UDP) |
| `db` | `postgres:18-alpine` | PostgreSQL |

- **Networks:** the external network `slipway-proxy` (`10.210.0.0/24`, Caddy
  at `10.210.0.2`), which routed app services join under the alias
  `<app-slug>-<service>`; and the internal network `database`, shared only by
  `slipway` and `db`.
- **Volumes:** `db-data` (PostgreSQL), `caddy-data` (certificates and ACME
  account), `caddy-config` (Caddy's last loaded configuration) and
  `agent-data` (the agent's `/var/lib/slipway`: checkouts and the node
  credential).
- **Apps:** each app is a separate Compose project, `slipway-<app-slug>`,
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
curl -fsSL https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.sh | sh -s -- --email you@example.com
```

To read the script first, download it and run `sh install.sh --email
you@example.com`. Run it as root (or a user in the `docker` group) on Linux.

| Flag | Purpose |
|---|---|
| `--dir <path>` | Install directory. Default: `/opt/slipway` when run as root on Linux, otherwise `~/slipway`. |
| `--email <address>` | E-mail address of the Let's Encrypt (ACME) account. Required on the first install; asked for when a terminal is available. Let's Encrypt refuses addresses at `example.com`. |
| `--port <port>` | Host port of the API and web UI. Default: `3000`. Not 80 or 443. |
| `--version <version>` | Image tag to install, for example `0.1.0`. Default: `latest`. |

`SLIPWAY_DIR`, `SLIPWAY_ACME_EMAIL`, `SLIPWAY_PORT` and `SLIPWAY_VERSION` stand
in for the flags. The installer:

1. checks that Docker, the Compose plugin and the daemon are available;
2. creates the `slipway-proxy` network (`10.210.0.0/24`, dynamic addresses
   from `10.210.0.128/25` so nothing takes Caddy's `10.210.0.2`);
3. copies `compose.yaml` and the `Caddyfile` from next to the script (when run
   from a checkout) or downloads them from GitHub (`SLIPWAY_REF`; default
   the release tag `vX.Y.Z` when a release version is pinned, `main` for
   `latest` and `edge`);
4. writes `.env` (mode `0600`) and generates `SLIPWAY_SECRET_KEY`,
   `POSTGRES_PASSWORD`, `SLIPWAY_LOCAL_JOIN_TOKEN` and `SLIPWAY_SETUP_TOKEN`;
   values already in `.env` are kept;
5. pulls the images and runs `docker compose up -d --wait`;
6. prints the web UI address on the chosen port and, on a fresh install, the
   one-time setup link (`/setup#token=...`). The first-run setup refuses to
   create the owner without that token.

Running the installer again is safe: it keeps the secrets and upgrades the
images. It refuses to continue when a Slipway database volume exists but
`.env` lacks its secrets, instead of generating keys that cannot open it.

### Windows with Docker Desktop

Requirements: Docker Desktop with the WSL 2 backend in **Linux containers**
mode, and Windows PowerShell 5.1 or PowerShell 7. In PowerShell:

```powershell
$env:SLIPWAY_ACME_EMAIL = 'you@example.com'
irm https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.ps1 | iex
```

Or download `install.ps1` and run `.\install.ps1 -Email you@example.com`, with
the optional parameters `-Dir` (default `%USERPROFILE%\slipway`), `-Port`
(default `3000`) and `-Version`. The installer does the same as `install.sh`;
`.env` is readable by the current user only.

Windows specifics:

- Ports 80 and 443 must be free on Windows itself. Stop IIS or any other web
  server that holds them, and allow Docker Desktop through the Windows
  firewall when asked.
- Routes of kind `external` can reach services on the Windows host as
  `host.docker.internal:<port>`.
- The bundled agent runs inside Docker Desktop's VM, so the LAN address it
  reports is internal. That does not matter on the edge node. When a Windows
  machine is an *additional* node, set `SLIPWAY_NODE_LAN_IP` to its LAN
  address (see [Add a node](#add-a-node)).
- Keep the machine from sleeping; the platform stops with Docker Desktop.

### Running images you built yourself

From a checkout, build the images and point the stack at them with an
override, then run the installer from the checkout:

```sh
docker build -f apps/api/Dockerfile -t slipway:local .
docker build -f apps/agent/Dockerfile -t slipway-agent:local .
mkdir -p ~/slipway && cat > ~/slipway/compose.override.yaml <<'YAML'
services:
  slipway:
    image: slipway:local
    pull_policy: never
  slipway-agent:
    image: slipway-agent:local
    pull_policy: never
YAML
sh deploy/install.sh --dir ~/slipway --email you@example.com
```

## First-run setup

Port 3000 serves plain HTTP so that the first setup works before any domain
exists. Do not forward it on your router; once the platform domain works, use
its HTTPS URL. To stop serving the API on the LAN over plain HTTP afterwards,
bind the port to the loopback interface in `compose.override.yaml` (reach it
through an SSH tunnel when you need it):

```yaml
services:
  slipway:
    ports: !override
      - "127.0.0.1:3000:3000"
```

### In the browser

1. Open the setup link the installer printed (`http://<host>:3000/setup#token=…`)
   and create the owner account in the setup wizard (name, e-mail, password),
   then enter the platform URL and the ACME e-mail. Setup requires the token
   in that link (`SLIPWAY_SETUP_TOKEN` in `.env`), so nobody else who reaches
   the port can claim the instance.
2. **Account:** add a passkey (Settings → Account). Passkeys are bound to the
   platform URL, so register them on the URL you will keep using.
3. **GitHub** (Settings → GitHub): connect with a fine-grained personal access
   token (`Contents: read`, `Metadata: read`), or let Slipway create its GitHub
   App. The App flow needs the public URL to be set, because GitHub sends your
   browser back to it; after creating the App, install it on your account and
   pick the repositories. Release webhooks only arrive when GitHub can reach
   that URL; token connections poll for new releases every 5 minutes
   instead.
4. **DNS** (Settings → DNS): add a provider account, for example Cloudflare
   with an API token that can read zones and edit DNS, or `manual` (Slipway
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
curl -fsS -H 'content-type: application/json' -d '{"email":"you@example.com","name":"You","password":"…","setupToken":"slps_…"}' "$API/setup"
# Sign in; cookie-authenticated changes must carry the platform Origin (CSRF protection).
curl -fsS -c cookies -H 'content-type: application/json' -d '{"email":"you@example.com","password":"…"}' "$API/auth/login"
curl -fsS -b cookies -H 'origin: http://localhost:3000' -H 'content-type: application/json' \
  -d '{"name":"cli","scopes":["admin"]}' "$API/tokens"           # .secret is the slp_… token, shown once
H="authorization: Bearer slp_…"
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
| `SLIPWAY_VERSION` | Image tag to run: `latest` (default), a release version or `edge`. |
| `SLIPWAY_PORT` | Host port of the API and web UI (default `3000`). |
| `SLIPWAY_PUBLIC_URL` | Optional. Overrides the public URL from the settings. |
| `SLIPWAY_ACME_EMAIL` | Required. Default ACME e-mail address; also used by Caddy's bootstrap configuration. |
| `SLIPWAY_SECRET_KEY` | Generated. 32 random bytes, base64. All encryption and cookie-signing keys are derived from it. Never change it, never lose it. |
| `SLIPWAY_LOCAL_JOIN_TOKEN` | Generated. Lets the bundled agent join, and rejoin, as the local node. Keep it secret. |
| `SLIPWAY_SETUP_TOKEN` | Generated. Required to create the owner account in the first-run setup; unused afterwards. |
| `POSTGRES_PASSWORD` | Generated. The database only accepts the password it was created with. |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info` (default), `debug` or `trace`. |

All API and agent variables are described in section 13 of the architecture
and in [ADR 0009](adr/0009-v0-1-specification-interpretations.md). After
editing `.env`, apply the change with `docker compose up -d --wait`.

## Add a node

A node is any machine with Docker that runs the agent. The agent connects
outbound, so the node needs no inbound port for the agent itself. For routed
apps on the node, the edge node must reach the node's LAN address on the
ports Slipway publishes there (ephemeral host ports, one per routed service
port): allow that traffic from the edge in the node's firewall.

1. Set the public URL first (Settings → Platform): it becomes the agent's
   `SLIPWAY_SERVER_URL` (`https://…` turns into `wss://…`). A node on the same
   LAN without a public URL can use `ws://<edge-lan-ip>:3000`.
2. In the UI, open **Nodes → Add node**. Slipway shows a one-time join token
   (`slpn_…`, valid for 15 minutes) with a ready-made `docker run` command and
   a Compose file. Over the API: `POST /api/v1/nodes` with `{"name": "…"}`
   returns `{ node, joinToken: { token, expiresAt, serverUrl,
   dockerRunCommand, composeSnippet } }`; `POST /api/v1/nodes/{id}/join-token`
   issues a new token for an existing node.
3. On the new machine, run the `docker run` command, or save the Compose file
   as `compose.agent.yaml` and start it:

   ```sh
   docker compose -f compose.agent.yaml up -d
   ```

   Optional variables: `SLIPWAY_VERSION` (keep it equal to the control
   plane's), `SLIPWAY_NODE_LAN_IP` (the address the edge uses to reach this
   node; detected automatically with host networking, set it on Docker Desktop
   or when detection picks the wrong interface) and `LOG_LEVEL`.

On its first start the agent exchanges the join token for a long-lived node
credential, stores it in its `agent-data` volume at
`/var/lib/slipway/agent/credentials.json` (mode `0600`); it creates the
`slipway-proxy` network on the node with the first deployment. The join token
is not needed after that;
`SLIPWAY_SERVER_URL` is needed on every start. The node shows as online once
the handshake completes, and queued deployments for it are sent right away.

Node credentials can be rotated (the agent must be online) and revoked in the
UI. To reconnect a node whose credential was revoked or lost, issue a new join
token, put it in `SLIPWAY_JOIN_TOKEN` and restart the agent: when the server
refuses the stored credential, the agent joins again with the token. Whoever
can read the agent's volume can act as that node, and the agent is
root-equivalent on its machine: protect both.

## Upgrade

In the install directory:

```sh
docker compose pull
docker compose up -d --wait
```

Running the installer again does the same and also refreshes `compose.yaml`
and the `Caddyfile`. With `SLIPWAY_VERSION=latest`, this moves to the newest
release. If `.env` pins a version, change `SLIPWAY_VERSION` first. Release
images are also tagged with their minor version (for example `0.1`), which
receives patch releases only.

The API applies database migrations when it starts. Migrations only move
forward, so take a [backup](#backup) before upgrading: going back to an older
version means restoring that backup. Avoid upgrading while a deployment runs:
deployments in progress when the API restarts are marked failed ("node went
offline") and need to be started again.

Upgrade the agents on other nodes as well, keeping their `SLIPWAY_VERSION`
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
   docker compose exec -T db pg_dump -U slipway -Fc slipway > slipway.dump
   ```

2. **The `.env` file.** It holds `SLIPWAY_SECRET_KEY`. Without that key, the
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
covers most setups. Slipway v0.1 does not back up the volumes of deployed
apps; use your own tooling for app data. Scheduled, encrypted volume backups
are planned (see [roadmap.md](roadmap.md)).

## Restore

On the target machine:

1. Install the same Slipway version that made the backup (`--version`). The
   fresh installation generates its own secrets; that is expected.
2. Stop the services that use the database:

   ```sh
   docker compose stop slipway slipway-agent
   ```

3. Restore the dump into the new database:

   ```sh
   docker compose exec -T db pg_restore -U slipway -d slipway --clean --if-exists --no-owner < slipway.dump
   ```

4. Replace `SLIPWAY_SECRET_KEY` in the new `.env` with the backed-up value.
   Keep the new `POSTGRES_PASSWORD`: it belongs to the new database volume.
5. Optionally restore the certificates:

   ```sh
   docker compose exec -T caddy tar -xzf - -C /data < caddy-data.tar.gz
   ```

6. Start everything with `docker compose up -d --wait`, check
   `/api/health/ready` and sign in with your existing account.

After the restore, users, API tokens, apps, encrypted secrets and settings are
back. The bundled agent rejoins as the restored `local` node with the new
installation's `SLIPWAY_LOCAL_JOIN_TOKEN` (the API registers it at start and
the agent falls back to it when its stored credential is refused). Agents on
other nodes keep working with their stored credentials as soon as their
`SLIPWAY_SERVER_URL` reaches the new machine, for example once the platform
domain points at it.

## Logs

Platform logs, from the install directory:

```sh
docker compose logs -f slipway    # or slipway-agent, caddy, db
```

The level is set with `LOG_LEVEL`. Container logs are rotated by Docker
(five files of 10 MB per container).

Deployment and app logs are shown in the UI and are available from the API as
Server-Sent Events:

- `GET /api/v1/deployments/{id}/logs?follow=true`
- `GET /api/v1/apps/{id}/logs?service=<service>&tail=200&follow=true`

On a node, the containers of an app belong to the Compose project
`slipway-<app-slug>` and carry the labels `slipway.app`, `slipway.deployment`
and `slipway.service`:

```sh
docker ps --filter label=com.docker.compose.project=slipway-<app-slug>
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
  `SLIPWAY_SERVER_URL`. Deployments for an offline node wait in `queued`
  until the node has been gone for 10 minutes, then fail. Deployments in
  progress fail when the node does not reconnect within 45 seconds.
- **The API logs `agent socket refused: invalid token`.** An agent presents a
  join token or credential the server does not know (expired token, revoked
  credential, restored or reset database). Issue a new join token for that
  node, set it as `SLIPWAY_JOIN_TOKEN` and restart the agent.
- **A script gets `403 Cross-site request rejected`.** Changes made with the
  session cookie must carry the platform `Origin` (browsers send it). Use an
  API token (`Authorization: Bearer slp_…`) for scripts.
- **`429 rate-limited`.** Setup, sign-in, passkey, invitation and token
  endpoints are rate-limited per client address; wait for `Retry-After`.
- **A new route answers 502.** Routed services join the edge network when they
  are deployed: redeploy the app after adding its first route.
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
  `pid: host` and references to the `slipway-proxy` network.
- **The edge serves something unexpected.** `GET /api/v1/edge/config` returns
  the Caddyfile the API rendered, whether Caddy holds it (`inSync`) and the
  last load error; `POST /api/v1/edge/reload` loads it again.
- **The installer stops with "holds an existing Slipway database".** The
  database volume exists but `.env` is missing its secrets. Restore `.env`
  from your backup, or remove the old containers and the volume to start over.

## Uninstall

1. Delete your apps in the UI first, so their Compose projects are removed from
   the nodes. Choose to delete their data if you also want their volumes gone.
2. In the install directory, `docker compose down` removes the platform
   containers and keeps the volumes; `docker compose down --volumes` also
   deletes the database, the certificates and the agent's data.
3. Remove the network with `docker network rm slipway-proxy`.
4. On other nodes, run `docker compose -f compose.agent.yaml down --volumes`.
