# Contributing to Slipway

Thank you for helping. Slipway is pre-1.0 and changes quickly. The
specification of the first release is
[docs/architecture.md](docs/architecture.md); design questions are settled
there or in an [architecture decision record](docs/adr/).

## Before you start

- **Bugs and small fixes:** open a pull request, or an issue first if you are
  unsure about the cause.
- **Features and larger changes:** open an issue first, so the approach is
  agreed before you write code. Check that the change fits v0.1; section 15 of
  the architecture lists what is deliberately left for later.
- **Architecture changes** (the REST API or agent protocol conventions, the
  security model, dependencies with wide impact) need an ADR in `docs/adr/`.
  See [ADR 0001](docs/adr/0001-record-architecture-decisions.md).
- **Security vulnerabilities:** do not open an issue or a pull request. Follow
  [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 24 LTS, pnpm 11.21.0, Docker (for the development database
and the integration tests) and OpenSSL.

```sh
corepack enable          # activates the pnpm version pinned in package.json
pnpm install             # installs dependencies and the Git hooks
docker compose -f compose.dev.yaml up -d
cp apps/api/.env.example apps/api/.env
echo "SLIPWAY_SECRET_KEY=$(openssl rand -base64 32)" >> apps/api/.env
pnpm dev
```

The API runs on <http://localhost:3000> and the UI dev server on
<http://localhost:5173>. How the code is organized, and the conventions for
modules, are described in [docs/development.md](docs/development.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Start the development servers |
| `pnpm build` | Build all packages |
| `pnpm lint` | Lint and check formatting with Biome |
| `pnpm lint:fix` | Apply Biome's fixes and formatting |
| `pnpm lint:ci` | `biome ci`, as run in CI |
| `pnpm typecheck` | Type-check all packages |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:integration` | Integration tests against PostgreSQL (Testcontainers, or the database in `TEST_DATABASE_URL`) |
| `pnpm test:e2e` | UI smoke tests (Playwright) |
| `pnpm knip` | Report unused files, exports and dependencies |
| `pnpm check` | Lint, type checking, knip and unit tests; run it before you push |
| `pnpm db:generate` | Generate a SQL migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations to the development database |
| `pnpm openapi:generate` | Regenerate the web UI's API types from the OpenAPI document |

## Workflow

Development is trunk-based on `main`:

1. Create a short-lived branch from `main`.
2. Commit in small, focused steps. The Git hooks check formatting and commit
   messages as you go.
3. Open a pull request against `main` and link the related issue.
4. CI must pass. After review, the pull request is squash-merged.

A ruleset protects `main`: pull requests are required, CI must be green,
history stays linear and force-pushes are blocked. Because of the squash
merge, **the pull request title becomes the commit message on `main`**, so it
must follow the same convention as commits.

## Commit messages

Commits and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <summary>
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
  `chore`, `revert`.
- **Scopes** are advisory: `api`, `agent`, `web`, `contracts`, `tsconfig`,
  `deploy`, `ci`, `deps`, `docs`. commitlint warns about other scopes but does
  not reject them. Leave the scope out when a change spans several areas.
- Mark a breaking change with `!` after the type or scope and describe it in a
  `BREAKING CHANGE:` footer.

Examples:

```text
feat(api): add cursor pagination to the deployments list
fix(agent): reset the reconnect backoff after a successful hello
docs: describe restoring a database backup
feat(agent)!: require agent protocol version 2
```

`feat` and `fix` commits and breaking changes determine the next version;
before 1.0, a breaking change raises the minor version. The changelog lists
`feat`, `fix`, `perf`, `revert` and `docs` commits, so write the summary for
the people who run Slipway.

## Git hooks

`pnpm install` installs the hooks with lefthook, through the `prepare` script:

| Hook | Runs |
|---|---|
| `pre-commit` | Biome on the staged files; its fixes are staged again |
| `commit-msg` | commitlint |
| `pre-push` | `pnpm typecheck`, then the unit tests |

`LEFTHOOK=0` skips the hooks for one command. CI runs the same checks, so
skipping a hook only moves the failure to the pull request.

## Tests

- **Unit tests** (`pnpm test`) must run without Docker or a database; tests
  that need PostgreSQL are integration tests.
- **Integration tests** (`pnpm test:integration`) run against a real
  PostgreSQL started with Testcontainers. Set `TEST_DATABASE_URL` to use an
  existing database instead.
- **End-to-end tests** (`pnpm test:e2e`) are Playwright smoke tests of the web
  UI.

Change tests together with the behavior they cover. A bug fix should come with
a test that fails without the fix.

## Database changes

1. Change the schema in the module that owns the table.
2. Run `pnpm db:generate` and review the generated SQL.
3. Commit the migration under `apps/api/drizzle` together with the schema
   change.

The API applies pending migrations when it starts. Never edit or delete a
migration that has been merged to `main`; add a new one instead.

## API and protocol changes

- The OpenAPI document is generated from the Zod route schemas, and the web
  UI's API types are generated from that document. Both are build output and
  are not committed. After changing a route or a schema, run
  `pnpm openapi:generate` and `pnpm typecheck`.
- Problem `type` slugs are stable: add new ones, never rename existing ones.
- Agent protocol messages are defined in `@slipway/contracts`. Additive
  changes stay compatible because unknown message types are ignored; an
  incompatible change needs a new protocol version
  ([ADR 0004](docs/adr/0004-agent-outbound-websocket.md)).

## Dependencies

- Versions are exact. pnpm reads its settings from `pnpm-workspace.yaml`, and
  versions shared by several packages are defined once in its `catalog`.
- Add a dependency only to the package that uses it, for example
  `pnpm --filter @slipway/api add <name>`.
- pnpm holds back versions younger than its minimum release age, and runs
  install scripts only for packages allowed in `allowBuilds`.
- TypeScript is deliberately pinned to 5.9.3; do not upgrade it to 7.x
  ([ADR 0008](docs/adr/0008-pnpm-turborepo-biome-toolchain.md)).
- Dependabot opens grouped dependency updates every week.

## Releases

Releases are automated with release-please. It keeps a release pull request
open that collects the changelog from the Conventional Commits on `main`.
Merging that pull request tags `vX.Y.Z`, publishes the GitHub Release and
builds the multi-arch, signed images `ghcr.io/jenspenneman/slipway` and
`ghcr.io/jenspenneman/slipway-agent`. Every merge to `main` also publishes
`edge` images. Rebuilding an older release (Images workflow, `version` input)
moves `latest`, `X.Y` and `X` only when no newer release has them.

`release-please-config.json` pins the first release with `"release-as":
"0.1.0"`; remove that line in the first commit after `v0.1.0` is tagged, or
every later release pull request will propose 0.1.0 again.

One-time repository settings, checked before a release is announced:

- **Private vulnerability reporting** is on (Settings → Code security), so
  the form [SECURITY.md](SECURITY.md) links to exists.
- **Package visibility:** GHCR creates `slipway` and `slipway-agent` as
  private packages on their first push. Make both public (Package settings →
  Change visibility) and link them to the repository; check with
  `docker logout ghcr.io && docker manifest inspect ghcr.io/jenspenneman/slipway:edge`.
- **Release pull request CI:** a pull request opened with `GITHUB_TOKEN`
  starts no workflows. Store a GitHub App or fine-grained token with
  `contents` and `pull-requests` write access as the `RELEASE_PLEASE_TOKEN`
  secret, so CI runs on the release pull request; otherwise a ruleset that
  requires CI needs a bypass for it.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the license of this project.
