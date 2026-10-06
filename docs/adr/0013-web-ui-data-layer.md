# 13. The web UI validates responses with the contract schemas

Date: 2026-10-07

## Status

Accepted

## Context

[architecture.md](../architecture.md) §11 asks for a UI client generated from
the OpenAPI document, so that the UI cannot drift from the API. The UI was
built in parallel with the API modules, before their routes existed, and the
contract package already holds the Zod schema of every request and response.

## Decision

- Resource modules in `apps/web/src/api` call the API through one `request()`
  helper. It sends the session cookie, turns problem documents into
  `ApiError`, and parses every response with the `@slipway/contracts` schema
  for that endpoint. A response that does not match raises
  `ContractDriftError`. Request bodies are typed with the contract input
  types.
- The openapi-fetch client generated from the OpenAPI document stays in
  `src/lib/api` and is used for the health probe. `pnpm openapi:generate`
  still runs before the web build and type check.
- An MSW mock of the whole API (`VITE_API_MOCK=1`, `pnpm --filter @slipway/web
  dev:mock`) backs the Playwright smoke tests; production builds contain no
  mock code.
- At integration, a script compared every call of the resource modules with
  the merged OpenAPI document (method, path, query parameters, body
  properties, response schema). It found one difference, which was fixed.

## Consequences

- Drift is caught at run time by schema validation and at build time by the
  shared contract types, not by generated path types. A path or method typo
  in a resource module is only caught by tests; repeating the comparison
  script in CI would close that gap (roadmap).
- The contract package, Zod included, ships in the UI bundle.
