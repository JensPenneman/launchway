# Slipway

[![CI](https://github.com/JensPenneman/slipway/actions/workflows/ci.yml/badge.svg)](https://github.com/JensPenneman/slipway/actions/workflows/ci.yml)

Slipway is a self-hosted deployment platform. Link a GitHub repository, pick a
release, and Slipway builds it, runs it on one of your machines, gives it a
domain with TLS, and keeps DNS pointed at your home connection. Everything is
reachable through a REST API; the web UI is only a client of that API.

> **Status:** pre-1.0. Every v0.1 feature of the specification in
> [docs/architecture.md](docs/architecture.md) is implemented, and the whole
> flow below (install, setup, deploying a GitHub release, a domain on the
> edge) has been tested end to end with images built from this repository.
> No release has been tagged yet. Until 1.0, the REST API, the agent protocol
> and the configuration may change between minor versions; known gaps are in
> [docs/roadmap.md](docs/roadmap.md).

## Principles

- **The API is the single source of truth.** The web UI, the node agent and
  (later) a CLI all use the same HTTP API. Anything the UI can do is possible
  with `curl`, first-run setup included.
- **Apps come from GitHub.** Every deployable thing is a GitHub repository,
  and a deployment is a specific release of it. Third-party software is
  deployed the same way, from a small repository with a Compose file that
  pulls the upstream images.
- **Compose is the runtime contract.** An app repository carries a Compose
  file, or only a `Dockerfile`. Slipway adds routing, networks, environment
  and lifecycle; it does not define an app manifest of its own.
- **Multi-node by design.** The control plane manages nodes, and each node
  runs an agent that owns Docker on that machine. A new installation runs the
  control plane and one agent on the same machine.
- **Pluggable providers.** DNS providers are plugins behind one interface.
  Git hosting is GitHub only, behind a thin interface of its own.
- **Your data stays with you.** State lives in PostgreSQL, secrets are
  encrypted at rest, and there are no external services besides GitHub, your
  DNS provider and Let's Encrypt.

## Features in v0.1

- **Deployments from GitHub.** Connect through a GitHub App that Slipway
  creates for you (with signed, deduplicated webhooks), or through a
  fine-grained personal access token. Deploy a release, a branch or a commit;
  every deployment is pinned to a commit SHA, one deployment per app runs at a
  time, and queued or running deployments can be cancelled. Published
  releases can be deployed automatically (webhooks, or polling for token
  connections).
- **Compose runtime.** One or more Compose files, or a single `Dockerfile`.
  Before anything runs, the node's agent checks the configuration against a
  policy: no host bind mounts, no privileged containers, no host network or
  PID namespace, no capabilities outside a small allow-list.
- **Rollback** by redeploying an older release; images cached on the node
  make it fast.
- **Live logs.** Deployment output and container logs stream to the UI and
  the API as Server-Sent Events; a change feed keeps every open page current.
- **Edge with automatic TLS.** Caddy on the edge node, configured by the API
  from your routes, with Let's Encrypt certificates and a DNS check before a
  domain is served. A route points at an app service, an external
  `host:port` or a redirect, with optional forward authentication,
  compression and HSTS.
- **DNS management.** Cloudflare and manual providers behind a plugin
  interface. An anchor hostname follows your public IPv4 (dynamic DNS); app
  domains are CNAME records pointing at it.
- **Nodes.** Agents connect outbound over WebSocket, so nodes behind NAT
  work. A node joins with a one-time token and a ready-made `docker run` or
  Compose snippet; each app runs on the node you choose. Node credentials can
  be rotated and revoked.
- **Accounts.** Passkeys and passwords, roles (`owner`, `admin`, `member`,
  `viewer`), invitations, scoped API tokens, rate limits and an audit log of
  every change.
- **Environment variables** per app, encrypted at rest. Values marked secret
  are never returned by the API.
- **API first.** REST under `/api/v1`, an OpenAPI 3.1 document and
  interactive API docs. The web UI is a client of that API and validates every
  response against the shared contract schemas.
- **Signed images** for `amd64` and `arm64`, with SBOM and provenance
  attestations.

Planned for later releases: blue/green deployments, preview deployments from
pull requests, a CLI, sign-in with an external OIDC provider, metrics and
alerts, scheduled volume backups, TCP/UDP routing at the edge and other Git
hosts. See
[section 15 of the architecture](docs/architecture.md#15-deliberately-later).

## Architecture

```text
  internet                    GitHub (API, webhooks, git)
     │ 80/443 (router port forward)        ▲
     ▼                                     │
┌──────────── edge node ───────────────────┼───────────────────────────────────┐
│                                          │                                   │
│  caddy ◀── Caddyfile via admin API ── slipway (API + web UI) ──▶ PostgreSQL  │
│    │                                            ▲                            │
│    │ slipway-proxy network                      │ WebSocket                  │
│    ├──▶ app containers on this node             │                            │
│    └──▶ <lan-ip>:<port> on other nodes          │                            │
│                                                 │                            │
│  slipway-agent ── Docker socket ── Docker       │                            │
│        └────────────────────────────────────────┘                            │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────── node 2 ───────────┐   Agents connect outbound over WebSocket,
│  slipway-agent ── Docker  │   so nodes behind NAT or on other networks
└───────────────────────────┘   need no inbound port for the agent.
```

| Component | Source | Runs as |
|---|---|---|
| Control plane API | `apps/api` | Container `slipway`. Serves the API at `/api/v1` and the web UI at `/`. |
| Web UI | `apps/web` | Static files built into the `slipway` image; same origin as the API. |
| Node agent | `apps/agent` | Container `slipway-agent` on every node, with access to the Docker socket. |
| Edge proxy | `caddy:2-alpine` | Container on the edge node; the only owner of ports 80 and 443. |
| Database | `postgres:18-alpine` | Container on the control-plane node. |

To deploy, the API resolves the chosen release to a commit and sends a
`deploy` message to the agent of the app's node. The agent clones that
commit, checks the Compose policy, adds an override file that attaches the
routed services to the `slipway-proxy` network, then builds and starts the
project with `docker compose`, streaming every line of output back. Once the
deployment is `running`, the API supersedes the previous one and loads a new
Caddyfile into the edge.

The full design is in [docs/architecture.md](docs/architecture.md).

## Quick start

You need a 64-bit Linux machine with Docker Engine and the Compose plugin, or
Docker Desktop on macOS or Windows. To serve public domains, forward TCP ports
80 and 443 from your router to that machine.

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.sh | sh -s -- --email you@example.com
```

Windows (Docker Desktop, PowerShell):

```powershell
$env:SLIPWAY_ACME_EMAIL = 'you@example.com'
irm https://raw.githubusercontent.com/JensPenneman/slipway/main/deploy/install.ps1 | iex
```

The e-mail address is used for the Let's Encrypt account. The installer
checks Docker, creates the `slipway-proxy` network (`10.210.0.0/24`), writes
an `.env` file with generated secrets (`SLIPWAY_SECRET_KEY`,
`POSTGRES_PASSWORD`, `SLIPWAY_LOCAL_JOIN_TOKEN`, `SLIPWAY_SETUP_TOKEN`),
pulls the images, starts the stack with `docker compose up -d --wait` and
prints a one-time setup link on port 3000. Open it and create the owner
account; setup refuses to run without the token in that link.

`install.sh` accepts `--dir` (install directory; `/opt/slipway` when run as
root on Linux, otherwise `~/slipway`), `--email`, `--port` (host port of the
API and UI, default `3000`) and `--version`. To read the script before
running it, download it first, then run
`sh install.sh --email you@example.com`.

Keep the `.env` file safe: without `SLIPWAY_SECRET_KEY`, the encrypted secrets
in the database cannot be recovered. Upgrades, backups and adding nodes are
covered in [docs/operations.md](docs/operations.md).

### Your first deployment

1. Create the owner account in the setup wizard and set the platform URL and
   the Let's Encrypt e-mail.
2. Connect GitHub under Settings → GitHub (a fine-grained token with
   `Contents: read` and `Metadata: read` is enough to start).
3. Create an app: pick the repository, its Compose files or `Dockerfile`, and
   the node (`local`, the machine you installed on). Add environment variables
   if the app needs them; values marked secret are never shown again.
4. Deploy a release from the Deployments tab and watch the live log until it
   is `running`. Deploying an older release later is the rollback.
5. Add a domain and a route to the app's service port under Domains & routes,
   point the DNS record at your public IPv4 (or let a DNS provider account do
   it), and redeploy so the service joins the edge network. Caddy obtains the
   certificate once the DNS check passes.

The same steps work with `curl` against `/api/v1` and an API token; the
operations guide lists the exact calls.

## Development

You need Node.js 24 LTS, pnpm 11 (through corepack), Docker and OpenSSL.

```sh
corepack enable                            # or install pnpm 11 yourself
pnpm install                               # also installs the Git hooks
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 on localhost:5432
cp apps/api/.env.example apps/api/.env
echo "SLIPWAY_SECRET_KEY=$(openssl rand -base64 32)" >> apps/api/.env
pnpm dev
```

- API: <http://localhost:3000>, with the OpenAPI document at
  `/api/openapi.json` and interactive docs at `/api/docs`.
- Web UI dev server: <http://localhost:5173>, which proxies `/api` to the API.

The development database uses `slipway` as user, password and database name.
`pnpm check` runs linting, type checking, knip and the unit tests. Read
[docs/development.md](docs/development.md) for the code conventions and
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## Project layout

```text
apps/
  api/          @slipway/api         Control plane: Hono on Node 24, Drizzle ORM, PostgreSQL
  agent/        @slipway/agent       Node agent: clones, checks, builds and runs Compose projects
  web/          @slipway/web         Web UI: React 19, Vite, TanStack Router and Query, Tailwind CSS v4
packages/
  contracts/    @slipway/contracts   Zod schemas and types shared by the API, the agent and the UI
  tsconfig/     @slipway/tsconfig    Shared TypeScript configuration
deploy/                              Production Compose files, Caddyfile, .env.example, installers
docs/                                Architecture, development and operations guides, ADRs
compose.dev.yaml                     PostgreSQL for local development
```

## Documentation

- [Architecture](docs/architecture.md): the v0.1 specification and the
  reference for design questions.
- [Development guide](docs/development.md): working on the code base.
- [Operations guide](docs/operations.md): installing (Linux, macOS, Windows),
  first setup, adding nodes, upgrading, backup and restore, troubleshooting.
- [Roadmap](docs/roadmap.md): known gaps and follow-ups after v0.1.
- [Architecture decision records](docs/adr/): why the main technical choices
  were made.
- [Contributing](CONTRIBUTING.md): workflow, commit conventions and releases.
- [Security policy](SECURITY.md): reporting vulnerabilities and the security
  model.

## License

Slipway is licensed under the [Apache License 2.0](LICENSE).
Copyright 2026 Jens Penneman.
