# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
<https://github.com/JensPenneman/slipway/security/advisories/new>

Do not report security problems in public issues, pull requests or
discussions.

Please include:

- the affected component (API, agent, web UI, installer or images) and the
  version, image digest or commit;
- steps to reproduce, or a proof of concept;
- the impact as you understand it.

You will receive an acknowledgement within 3 business days. We will keep you
informed while a fix is prepared and agree on the disclosure with you.
Reporters are credited in the published advisory unless they prefer not to be.

## Supported versions

Slipway is pre-1.0. Security fixes are made for the latest minor release only;
upgrade to receive them.

| Version | Supported |
|---|---|
| Latest minor release | Yes |
| Older releases | No |
| `edge` images built from `main` | No, for testing only |

## Security model

This is a summary of the security requirements in section 14 of
[docs/architecture.md](docs/architecture.md).

### Trust boundaries

- **The agent is root-equivalent on its node**, because it owns the Docker
  socket. Protecting the node credential (stored in the agent's volume) and the
  TLS edge is what protects the node.
- **Deployed apps are trusted code.** The Compose policy limits what an app
  can request from Docker, but it is not a sandbox. Deploy only repositories
  you trust.
- **`SLIPWAY_SECRET_KEY` protects every secret at rest.** Anyone holding both
  the key and a database dump can decrypt the stored secrets.

### Secrets and credentials

- Secrets (environment variable values, DNS provider credentials, the GitHub
  App's private key and secrets) are encrypted with AES-256-GCM, with a random
  IV and a key derived from `SLIPWAY_SECRET_KEY`. Secrets are never returned in
  clear text after creation; only environment variables not marked `secret`
  are returned.
- Passwords are hashed with argon2id. API tokens, session tokens, join tokens,
  node credentials and invitation tokens are stored as SHA-256 hashes and
  compared in constant time. Plaintext tokens are shown once.
- Git credentials are passed to `git` per command and never written to disk.
  A deploying node receives, per deployment, a fresh GitHub App token limited
  to the app's repository and `contents: read`. With a personal access token
  connection the node receives that token itself, so use a fine-grained,
  read-only token; classic tokens with write scopes are refused.
- Logs never contain secrets, tokens or `Authorization` headers; environment
  values are never logged.

### Authentication and authorization

- Sessions use the cookie `slipway_session` (HttpOnly, SameSite=Lax, Secure
  when served over HTTPS), are stored server-side, are replaced on login
  (no session fixation) and can be revoked.
- Sign-in with passkeys (WebAuthn) or passwords. Setup, login, passkey and
  token endpoints are rate-limited.
- CSRF: cookie-authenticated requests that change state must carry an `Origin`
  or `Sec-Fetch-Site` header that matches the platform origin. Requests with a
  bearer token are exempt.
- Roles (`owner`, `admin`, `member`, `viewer`) are checked per route; a
  `viewer` cannot read secrets or tokens. API tokens carry scopes (`read`,
  `write`, `admin`) and an optional expiry.
- Every change is recorded in the audit log with actor, action, target, IP
  address and user agent.

### Input handling and execution

- All external input is validated with Zod.
- No shell strings: processes are started with `execFile` and argument
  arrays. Git refs must match `^[A-Za-z0-9._/-]+$` and must not start with
  `-`.
- GitHub webhooks: the `X-Hub-Signature-256` HMAC is verified before the body
  is parsed, and a delivery ID that was already processed is rejected.
- The Compose policy is enforced on the agent, not only in the UI: no host
  bind mounts or host-path volume drivers, no `privileged`, no devices or
  `device_cgroup_rules`, no `network_mode` or other namespace outside the
  project (only `none` or `service:<name>`), no networks or volumes named
  outside the project, no security options besides `no-new-privileges`, and no
  capabilities outside a small allow-list.

### Network exposure

- Agents connect outbound to the control plane; a node exposes no agent port.
- Internal endpoints (`/internal/*`) and agent WebSocket upgrades without a
  valid token are rejected from outside the Docker networks.
- PostgreSQL is reachable only on an internal Docker network shared with the
  API. Caddy's admin API listens only on a unix socket that the `caddy` and
  `slipway` containers share; app containers cannot reach it.
- Port 3000 serves plain HTTP for the first setup. Do not expose it to the
  internet; use the platform's HTTPS URL once it works.

### Containers and supply chain

- Platform containers drop the capabilities they do not need and run with
  `no-new-privileges`. The `slipway` container runs as a non-root user on a
  read-only root filesystem; the agent runs as root because it owns the
  Docker socket.
- Release images for `amd64` and `arm64` are signed with cosign (keyless) and
  carry SBOM and provenance attestations. Built images are scanned with Trivy.
- The repository uses CodeQL, Dependabot (grouped weekly updates, including
  GitHub Actions and Docker base images), secret scanning and push protection.

To verify the signature of an image:

```sh
cosign verify ghcr.io/jenspenneman/slipway:<tag> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/JensPenneman/slipway/'
```

The same command works for `ghcr.io/jenspenneman/slipway-agent`.

## Out of scope

- Vulnerabilities in apps deployed with Slipway, or in their upstream images.
- Findings that require root or Docker socket access on a node, which already
  grants full control of that node.
