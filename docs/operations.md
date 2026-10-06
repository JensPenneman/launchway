# Operations

How to install, configure, upgrade, back up and extend a Slipway installation.

> **Skeleton.** This guide follows the v0.1 specification in
> [architecture.md](architecture.md). Parts marked *To be completed* depend on
> pieces that are still being built and will be filled in as they land.

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
`compose.override.yaml` next to it.

## Requirements

- Linux (`amd64` or `arm64`) with Docker Engine and the Compose plugin, or
  Docker Desktop on macOS or Windows.
- For public domains: a public IPv4 address, with TCP ports 80 and 443
  (and UDP 443 for HTTP/3) forwarded to the edge node.
- Outbound HTTPS to GitHub, `ghcr.io`, your DNS provider and Let's Encrypt.

## Install

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.sh | sh -s -- --email you@example.com
```

| Flag | Purpose |
|---|---|
| `--dir <path>` | Install directory. Default: `/opt/slipway` when run as root on Linux, otherwise `~/slipway`. |
| `--email <address>` | E-mail address of the Let's Encrypt (ACME) account. |
| `--port <port>` | Host port of the API and web UI. Default: `3000`. |
| `--version <version>` | Slipway version to install. |

Windows (Docker Desktop, PowerShell):

```powershell
$env:SLIPWAY_ACME_EMAIL = 'you@example.com'
irm https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.ps1 | iex
```

The installer:

1. checks that Docker and Docker Compose are available;
2. creates the `slipway-proxy` network (`10.210.0.0/24`);
3. writes `.env` in the install directory and generates `SLIPWAY_SECRET_KEY`,
   `POSTGRES_PASSWORD` and `SLIPWAY_LOCAL_JOIN_TOKEN`;
4. runs `docker compose up -d --wait`;
5. prints the setup URL on port 3000.

Running the installer again is safe: it never overwrites a value that is
already set in `.env`.

Port 3000 serves plain HTTP so that the first setup works before any domain
exists. Do not forward it on your router; once the platform domain works, use
its HTTPS URL.

## First-run setup

1. Open the setup URL and create the owner account. This is only possible
   while no user exists (`GET` and `POST /api/v1/setup`).
2. In the platform settings, set the public URL (for example
   `https://deploy.example.com`), the ACME e-mail address and the edge node.
3. Add a DNS provider account and set the anchor hostname, the name whose `A`
   record follows your public IPv4.
4. Connect GitHub, preferably by letting Slipway create its GitHub App.

*To be completed:* a walkthrough of the setup wizard.

## Configuration

Docker Compose reads `.env` from the install directory:

| Variable | Purpose |
|---|---|
| `SLIPWAY_VERSION` | Image tag to run: `latest` (default), a release version or `edge`. |
| `SLIPWAY_PORT` | Host port of the API and web UI (default `3000`). |
| `SLIPWAY_PUBLIC_URL` | Optional. Overrides the public URL from the settings. |
| `SLIPWAY_ACME_EMAIL` | Required. Default ACME e-mail address; also used by Caddy's bootstrap configuration. |
| `SLIPWAY_SECRET_KEY` | Generated. 32 random bytes, base64. All encryption and cookie-signing keys are derived from it. Never change it, never lose it. |
| `SLIPWAY_LOCAL_JOIN_TOKEN` | Generated. Lets the bundled agent register the local node, once. |
| `POSTGRES_PASSWORD` | Generated. The database only accepts the password it was created with. |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info` (default), `debug` or `trace`. |

All API and agent variables are described in section 13 of the architecture
and in [ADR 0009](adr/0009-v0-1-specification-interpretations.md). After
editing `.env`, apply the change with `docker compose up -d --wait`.

## Upgrade

In the install directory:

```sh
docker compose pull
docker compose up -d --wait
```

With `SLIPWAY_VERSION=latest`, this moves to the newest release. If `.env`
pins a version, change `SLIPWAY_VERSION` first. Release images are also
tagged with their minor version (for example `0.1`), which receives patch
releases only.

The API applies database migrations when it starts. Migrations only move
forward, so take a [backup](#backup) before upgrading: going back to an older
version means restoring that backup.

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
   credentials, GitHub App credentials) cannot be recovered, even from a
   complete dump. Store the file separately from the dump and treat it as a
   secret.

3. **The `caddy-data` volume**, which holds the certificates and the ACME
   account (mounted at `/data` in the `caddy` container):

   ```sh
   docker compose exec -T caddy tar -czf - -C /data . > caddy-data.tar.gz
   ```

   Without it, Caddy requests new certificates, which can run into Let's
   Encrypt rate limits when you serve many domains.

Slipway v0.1 does not back up the volumes of deployed apps. Use your own
tooling for app data; scheduled, encrypted volume backups are planned for a
later release.

*To be completed:* recommended schedule and retention.

## Restore

*Outline; to be verified once the installer is final.* On the target machine:

1. Install the same Slipway version that made the backup (`--version`).
2. Stop the services that use the database:

   ```sh
   docker compose stop slipway slipway-agent
   ```

3. Restore the dump:

   ```sh
   docker compose exec -T db pg_restore -U slipway -d slipway --clean --if-exists --no-owner < slipway.dump
   ```

4. Copy `SLIPWAY_SECRET_KEY` from the backed-up `.env` into the new `.env`.
   Keep the new `POSTGRES_PASSWORD`: it belongs to the new database volume.
5. Optionally restore the certificates:

   ```sh
   docker compose exec -T caddy tar -xzf - -C /data < caddy-data.tar.gz
   ```

6. Start everything with `docker compose up -d --wait`, check
   `/api/health/ready` and sign in.

*To be completed:* reconnecting nodes after a restore. The restored database
refers to node credentials that a newly installed agent does not have.

## Add a node

A node is any machine with Docker that runs the agent. The agent connects
outbound, so the node needs no inbound port for the agent itself. For routed
apps on the node, the edge node must reach the node's LAN IP on the ports
Slipway publishes there.

1. In the UI, open **Nodes**, then **Add node**. Slipway shows a one-time join
   token (`slpn_…`, valid for 15 minutes) and a Compose snippet based on
   `deploy/compose.agent.yaml`.
2. On the new machine, save the snippet as `compose.agent.yaml` and put the
   values the UI shows in a `.env` file next to it:

   ```dotenv
   SLIPWAY_SERVER_URL=wss://deploy.example.com
   SLIPWAY_JOIN_TOKEN=slpn_…
   ```

   Optional: `SLIPWAY_VERSION` (keep it equal to the control plane's),
   `SLIPWAY_NODE_LAN_IP` (the address the edge uses to reach this node;
   detected automatically, set it when detection picks the wrong interface,
   for example under Docker Desktop) and `LOG_LEVEL`.
3. Start the agent from that directory:

   ```sh
   docker compose -f compose.agent.yaml up -d
   ```

On its first start, the agent exchanges the join token for a long-lived node
credential and stores it in its `agent-data` volume at
`/var/lib/slipway/agent/credentials.json` (mode `0600`). The join token is not
needed after that and can be removed from `.env`; `SLIPWAY_SERVER_URL` is
needed on every start. The node shows as online once its first heartbeat
arrives.

Node credentials can be rotated and revoked in the UI. Whoever can read the
agent's volume can act as that node, and the agent is root-equivalent on its
machine: protect both.

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
- `GET /api/v1/apps/{id}/logs?service=<service>&follow=true`

On a node, the containers of an app belong to the Compose project
`slipway-<app-slug>`:

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

*To be completed.* First things to check:

- **A node is offline.** A node is marked offline after 45 seconds without a
  heartbeat. Check the agent's logs on that node and whether it can reach
  `SLIPWAY_SERVER_URL`. Deployments for an offline node wait in `queued` for
  10 minutes, then fail.
- **A domain gets no certificate.** Routes are only rendered once their
  domain passes the DNS preflight. Check the domain's status in the UI, that
  ports 80 and 443 reach the edge node, and `docker compose logs caddy`. If
  the zone has CAA records, they must allow `letsencrypt.org`.
- **A deployment is rejected by the policy.** The deployment log shows the
  reason. Replace host bind mounts with named volumes or with `configs:` that
  use inline `content`, and remove `privileged`, `network_mode: host` and
  `pid: host`.
- **The edge serves something unexpected.** `GET /api/v1/edge/config` returns
  the Caddyfile that the API rendered.

## Uninstall

1. Delete your apps in the UI first, so their Compose projects are removed from
   the nodes. Choose to delete their data if you also want their volumes gone.
2. In the install directory, `docker compose down` removes the platform
   containers and keeps the volumes; `docker compose down --volumes` also
   deletes the database, the certificates and the agent's data.
3. Remove the network with `docker network rm slipway-proxy`.
4. On other nodes, run `docker compose -f compose.agent.yaml down --volumes`.
