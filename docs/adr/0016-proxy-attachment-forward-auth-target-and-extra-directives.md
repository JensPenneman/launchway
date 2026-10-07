# 16. Proxy attachment, forward-auth app target and extra directives

Date: 2026-10-07

## Status

Accepted

## Context

A passkey gate (Pocket ID behind oauth2-proxy) is meant to run as an ordinary
Launchway app and guard other apps through Caddy's `forward_auth`. Three gaps
stood in the way:

- Only services with a route joined the proxy network. oauth2-proxy has no
  public host name of its own, so the edge could not reach it by its alias.
- The forward-auth setting was a bare URL. Pointing it at an app service meant
  typing the alias by hand, and nothing kept it in step with the app's slug,
  node or deployment.
- Routes were host-only. The login host has to send `/oauth2/*` to
  oauth2-proxy and everything else to Pocket ID, and a few admin paths of
  Pocket ID have to be closed.

Apps also had no standard way to learn which release they run.

## Decision

1. **Attach without a route.** `App.proxyServices` lists services that join the
   proxy network as `<slug>-<service>` without a route. The deploy payload gets
   an additive `attach` list: the services of the app's routes, its
   `proxyServices` and the forward-auth target service when it belongs to the
   app. The agent attaches them with their alias and publishes nothing for
   them. Only routed ports are published on a non-edge node. Old agents ignore
   `attach`. The protocol version stays the same because the field is additive
   and defaults to an empty list.
2. **One alias space.** Route targets, `proxyServices` and the forward-auth
   target share the alias collision check and its advisory lock. An alias may
   belong to one app only.
3. **Forward-auth target.** `Setting.forwardAuthTarget` is
   `{ appId, service, port, uri }`. It sits next to `forwardAuthUrl`, and at
   most one of the two is set (validation and a CHECK constraint). The
   renderer's `(gate)` calls `http://<alias>:<port>` with `uri`. Protected
   routes fail closed when the target cannot be reached by alias: the app is
   gone, the app is not on the edge node, or the alias is too long. The update
   answer carries `hints`. `redeploy-required` means the service only joins the
   proxy network with the app's next deployment. `gate-unreachable` means the
   app runs off the edge node.
4. **Extra directives.** `Route.extraDirectives` is admin-only Caddyfile text.
   It is rendered verbatim inside the site block, after the option directives
   and before the upstream. On save the API first runs a structural check:
   quotes are closed, block braces are balanced and the text never closes the
   enclosing site. Then Caddy's `/adapt` checks a throwaway Caddyfile with just
   that site, and Caddy's line numbers are mapped to lines of the directives.
   When Caddy cannot be reached, the structural check stands and the answer
   carries a warning.
5. **Platform variables.** Every deployment's environment gets `LAUNCHWAY_APP`,
   `LAUNCHWAY_APP_ID`, `LAUNCHWAY_DEPLOYMENT_ID`, `LAUNCHWAY_REF`,
   `LAUNCHWAY_COMMIT_SHA`, `LAUNCHWAY_COMMIT_SHA_SHORT` and `LAUNCHWAY_NODE`.
   User variables may not start with `LAUNCHWAY_`. Stored rows that predate the
   rule are dropped from the payload so they cannot shadow the platform values.

## Consequences

- The gate is configured in Launchway terms (app, service, port), follows the
  app's slug and fails closed when it moves off the edge node.
- Extra directives are trusted admin configuration with the reach of the
  Caddyfile, including Caddy placeholders and `import`. Members cannot set
  them, and a broken one is rejected before it reaches the running edge. If
  Caddy was down at save time, the next load can still fail. Caddy then keeps
  the previous configuration and `GET /edge/config` shows the error.
- Whether a gate service is attached is judged from the configuration (routes,
  `proxyServices`, the previous target), not from the containers on the node.
  The hint can be conservative.
- Attaching a service to a running app still takes effect with the next
  deployment ([ADR 0011](0011-domain-activation-and-edge-rules.md)).
