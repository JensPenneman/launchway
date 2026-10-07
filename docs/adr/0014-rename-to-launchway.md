# 14. Rename the project to Launchway

Date: 2026-10-07

## Status

Accepted

## Context

The project's previous name is used by other software products, so it does not
identify this project unambiguously.

## Decision

The project is renamed to Launchway everywhere: packages (`@launchway/*`),
images, environment variables (`LAUNCHWAY_*`), Docker labels, networks and
volumes, the session cookie and the token prefixes (`lwy_`, `lwyn_`, `lwya_`,
`lwyi_`, `lwys_`).

## Consequences

Installations made before the rename are not upgraded in place; they are
reinstalled, because their configuration, tokens and encrypted secrets use the
old identifiers.
