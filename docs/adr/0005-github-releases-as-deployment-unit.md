# 5. GitHub releases are the unit of deployment

Date: 2026-10-06

## Status

Accepted

## Context

Slipway must always be able to say what is running: a version that a person
chose, with release notes, that does not move underneath a deployment
([architecture.md](../architecture.md) §1, §4). Branch heads move; commit SHAs
are exact but mean little to people. GitHub offers several ways to integrate:
GitHub Apps (short-lived installation tokens, webhooks, per-repository
access), OAuth apps, personal access tokens and deploy keys. Some users can
create an app; others only want to paste a token.

## Decision

- Releases (tags) are first-class: the UI lists a repository's releases and
  deploys the one the user picks. Branch heads and commit SHAs are accepted as
  `ref` as well. The API resolves every ref to a commit SHA when it creates
  the deployment, so a deployment records exactly what it ran.
- Per app, `autoDeployReleases: true` deploys every published release.
- Preferred connection: a GitHub App that Slipway creates through the manifest
  flow (§8). The API exchanges the returned `code`
  (`POST /app-manifests/{code}/conversions`) and stores `appId`, `clientId`,
  `clientSecret`, `privateKey` and `webhookSecret` encrypted. The user installs
  the app on selected repositories; listing, cloning and webhooks use
  short-lived installation tokens.
- Fallback connection: a fine-grained personal access token with
  `Contents: read` and `Metadata: read`. It has no webhooks; for apps with
  auto-deploy, releases are polled every 5 minutes.
- Webhooks arrive at `POST /api/v1/webhooks/github`. The `X-Hub-Signature-256`
  HMAC is verified with a timing-safe comparison before the body is parsed,
  and every delivery ID is recorded so that a replayed delivery is ignored.
  Handled events: `release`, `installation`, `installation_repositories` and
  `ping`.
- Clone credentials are passed to `git` per invocation
  (`-c http.extraHeader=…`) and never written to disk.
- All GitHub access goes through
  `interface GitProvider { listRepos; listReleases; resolveRef; cloneCredentials; }`.

## Consequences

- Everything Slipway deploys has a repository, third-party software included
  (a small repository with a Compose file), so its configuration is versioned
  and reviewed like code.
- Each installation owns its GitHub App; no shared app or intermediary service
  sits between GitHub and the installation.
- Webhooks need the platform URL to be reachable from the internet; token
  connections poll instead.
- Moving a tag or a branch later does not change what an existing deployment
  ran. Deploying the new state is a new deployment.
- The GitHub App's private key and secrets are encrypted with a key derived
  from `SLIPWAY_SECRET_KEY` (ADR 0009).
- Another Git host means another `GitProvider` implementation; that is
  deliberately left for later (§15).
