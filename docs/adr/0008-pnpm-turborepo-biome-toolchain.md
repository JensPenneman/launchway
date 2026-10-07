# 8. pnpm, Turborepo and Biome as the toolchain

Date: 2026-10-06

## Status

Accepted

## Context

The repository holds three applications and two shared packages
([architecture.md](../architecture.md) §12). Several contributors, including
automated agents, change it at the same time, so installs must be
reproducible, checks fast and identical locally and in CI, and the commit
history machine-readable for releases. Shared packages should be usable from
source in development without a separate build step, yet ship compiled code
in the images.

## Decision

- **Package manager:** pnpm 11 workspaces, pinned to 11.21.0 through
  `packageManager` and activated with corepack, on Node 24 LTS
  (`.node-version`, `engines`). pnpm 11 reads its settings (`saveExact`,
  `strictPeerDependencies`, `engineStrict`, …) from `pnpm-workspace.yaml`
  rather than `.npmrc`, so they live there, together with the version
  `catalog`, the minimum release age and the `allowBuilds` list of packages
  that may run install scripts.
- **Tasks:** Turborepo 2.11 runs package tasks in dependency order and caches
  their results.
- **Lint and format:** Biome 2.5 is the only linter and formatter; CI runs
  `biome ci`.
- **Tests:** Vitest 5 for unit tests and for integration tests against
  PostgreSQL in Testcontainers (or `TEST_DATABASE_URL`); Playwright for UI
  smoke tests. knip finds unused files, exports and dependencies.
- **Hooks and releases:** lefthook runs Biome on staged files (pre-commit),
  commitlint with the conventional configuration (commit-msg), and type
  checking plus unit tests (pre-push). release-please turns Conventional
  Commits into release pull requests, tags and changelogs.
- **TypeScript 5.9.3, pinned.** TypeScript 7.0.2, the native compiler, is the
  latest stable release, but it no longer ships the JavaScript compiler API:
  the `typescript` package exports only `./lib/version.cjs` and `./unstable/*`.
  `openapi-typescript` 7.13 (peer dependency `typescript ^5.x`), which
  generates the UI's API types, builds its output with `ts.factory` and crashes
  under TypeScript 7 (verified):
  `TypeError: Cannot read properties of undefined (reading 'createKeywordTypeNode')`.
  The workspace therefore pins TypeScript 5.9.3. We revisit this when
  `openapi-typescript` supports TypeScript 7.
- **Shared configuration:** `@launchway/tsconfig` enables `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`, with `NodeNext` resolution
  for Node packages and `Bundler` for the web app. Packages are connected with
  project references.
- **Live types:** workspace packages export `src/*.ts` under the custom
  condition `@launchway/source` and compiled `dist/` by default. Vite, Vitest
  and tsx enable the condition in development; production builds and Docker
  images resolve `dist/`. Type checking goes through the project references.

## Consequences

- One lockfile, exact versions, strict peer and engine checks. Settings placed
  in `.npmrc` are not read by pnpm 11.
- One fast tool and one configuration for linting and formatting, at the cost
  of rules that only exist in larger plugin ecosystems.
- Changes to `@launchway/contracts` reach the API, the agent and the UI
  immediately in development. Because development and production resolve
  different files, the `exports` maps must list every entry point for both.
- `erasableSyntaxOnly` rules out enums, namespaces and parameter properties,
  which keeps sources compatible with type stripping.
- The pin gives up the native compiler's speed, and dependency updates must
  not move TypeScript to 7.x while this ADR stands.
- Hooks give fast local feedback but can be skipped; CI runs the same checks
  and is authoritative.
