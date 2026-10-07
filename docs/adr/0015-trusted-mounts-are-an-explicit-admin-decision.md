# 15. Trusted mounts are an explicit admin decision

Date: 2026-10-07

## Status

Accepted

## Context

The Compose policy (architecture section 4) refuses every host bind mount,
every `external: true` volume and every custom volume `name:`. That keeps an
app inside its own project, but it also blocks stacks that already run on a
machine and should move under Launchway unchanged: the owner's Trail stack
bind-mounts a backup folder and reuses its existing database volume by name.

Copying data into a project-owned volume is possible but turns a move into a
migration. Loosening the policy for everyone would let any member (or anyone
who can push to a deployed repository) mount host directories.

## Decision

1. **Two admin-controlled settings.** `Node.allowedBindRoots` lists the
   directories, as the Docker daemon sees them, below which bind mounts may
   come from (absolute, normalized, never `/`, at most 32).
   `App.trustedMounts` (default `false`) opts one app in. Changing either
   needs the `admin` role; members get `403 forbidden` and keep editing every
   other field. Both changes are audited with their old and new values.
2. **The agent decides.** The control plane sends
   `DeployPayload.policy = { trustedMounts, allowedBindRoots }` from the app
   and the deployment's node. The field is optional, and an agent that
   receives none treats the deployment as untrusted, so mixed versions fail
   closed.
3. **What trust allows.** Bind mounts whose source, normalized (relative
   sources resolved against the Compose project directory), lies at or below
   an allowed root; `external: true` volumes; custom volume names.
4. **What trust never allows.** Any source containing `docker.sock`; `/`;
   anything below `/proc`, `/sys`, `/dev`, `/etc`, `/var/run` or `/run`,
   unless the matching allowed root is itself deeper than that path (Docker
   Desktop exposes Windows drives below `/run/desktop/mnt/host`); Docker's
   data directory `/var/lib/docker`; the agent workspace; bind propagation
   `shared`, `rshared`, `slave` or `rslave`; the platform's own volumes
   (`launchway_*`, `launchway-agent_*`); and everything the policy refuses
   for untrusted apps (host-path volume drivers, privileges, devices,
   namespaces and the rest). Refusals name the node's allowed roots.
5. **Visible.** The app header shows a "trusted mounts" badge and every
   deployment log lists the mounts that only trust allowed.

## Consequences

- Existing stacks can move under Launchway without copying data.
- Trust attaches to the app, not to a commit: whoever can change the app's
  repository, Compose files or connection, or push to the repository, gets
  the same host access below the roots. The settings page says so.
- The agent cannot see the host's file system, so it checks paths textually.
  A symlink below an allowed root that points elsewhere is followed by the
  daemon; keep allowed roots to directories you control.
- Moving a trusted app to another node applies that node's roots.
- Untrusted apps behave exactly as before, with the same messages.
