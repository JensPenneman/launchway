# 3. Caddy is the edge, configured through its admin API

Date: 2026-10-06

## Status

Accepted

## Context

The edge node terminates TLS for every public domain, obtains certificates
automatically, routes by host name to app containers on the same node or to
`<lan-ip>:<port>` on other nodes, and applies per-route options: forward
authentication, compression and HSTS ([architecture.md](../architecture.md)
§2, §5). Its configuration changes whenever a route or a deployment changes,
must not interrupt open connections, and must survive restarts of the API.
Discovering routes from container labels would only see containers on the
local Docker host, and would give the proxy access to the Docker socket.

## Decision

- Caddy (`caddy:2-alpine`) is the only process bound to ports 80 and 443
  (plus 443/UDP for HTTP/3) on the edge node. Its address on `slipway-proxy`
  is `10.210.0.2`.
- The API is the only writer of the edge configuration. It renders a complete
  Caddyfile from the settings and the active routes: the platform's own domain
  (`Setting.publicUrl`, upstream `slipway:3000`), app routes (upstream
  `<slug>-<service>:<port>` on the edge node, `<node.lanIp>:<publishedPort>`
  elsewhere), `external` routes and redirects. Per route it adds
  `import gate` when `protected`, `encode zstd gzip` when `compress`, and
  `header ?Strict-Transport-Security "max-age=31536000"` when `hsts`.
- The API validates the file with `POST /adapt` and only then loads it with
  `POST /load` (`Content-Type: text/caddyfile`). A file that fails to adapt is
  never loaded: the running configuration stays and the error is reported.
  `GET /api/v1/edge/config` returns the rendered file.
- Caddy runs with `--resume`, so after a restart it serves the last loaded
  configuration (autosaved in the `caddy-config` volume), even while the API
  is down. The bootstrap Caddyfile in `deploy/` holds only global options and
  is read when nothing was loaded yet.
- The admin API listens on a unix socket, `/run/caddy-admin/admin.sock`, in
  the `caddy-admin` volume that only the `caddy` and `slipway` containers
  mount. It never listens on a TCP port. *(Amended during the v0.1 review: the
  first version listened on `0.0.0.0:2019`, which every app container on
  `slipway-proxy` could reach.)*
- Certificates come from Let's Encrypt only: the global options set `email`
  and `cert_issuer acme`, so Caddy tries no fallback CA (the zone's CAA records
  may allow only Let's Encrypt).
- A route is rendered only after its domain passes the DNS preflight: the
  name resolves to the current public IPv4 or to the anchor hostname. The user
  can force it. This avoids spending ACME attempts and rate limits on names
  that cannot validate.
- Forward authentication is one snippet, `(gate)`, defined as
  `forward_auth <Setting.forwardAuthUrl>`. The gate itself is deployed as a
  normal Slipway app on `slipway-proxy`.

## Consequences

- The edge always reflects the database. Every change renders the whole file,
  so there is no incremental state to drift, and rendering can be tested
  without Caddy.
- Broken configurations are rejected before they reach traffic, and the
  rendered file can be inspected through the API.
- The edge keeps serving while the API is stopped or being upgraded.
- The admin API has no authentication. Only processes that can open the
  socket file (the `caddy` and `slipway` containers) can change the edge
  configuration; app containers on `slipway-proxy` cannot reach it.
- Certificates live in the `caddy-data` volume, which must be backed up.
- A new domain is not served until its DNS is correct, unless forced.
- Only HTTP and HTTPS are routed in v0.1. Apps that need other protocols
  publish ports directly; TCP/UDP routing at the edge is planned for later
  (§15).
