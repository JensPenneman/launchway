# 1. Record architecture decisions

Date: 2026-10-06

## Status

Accepted

## Context

Slipway is built by several contributors, people and automated agents, working
in parallel against one specification, [architecture.md](../architecture.md).
That document describes *what* v0.1 is. It does not record *why* a choice was
made, which alternatives were rejected, or how an ambiguous point was settled
during implementation. Without that record, decisions are argued again, or
reversed by someone who never knew the reason behind them.

## Decision

We record architecturally significant decisions as Architecture Decision
Records (ADRs) in the format described by Michael Nygard: title, date, status,
context, decision and consequences.

- ADRs live in `docs/adr/` as `NNNN-short-title.md`, numbered in sequence.
  Numbers are never reused.
- A decision is significant when it shapes the structure of the system, an
  external interface (REST API, agent protocol, configuration, stored
  formats), the security model or the toolchain, or when it is expensive to
  reverse.
- The status is `Proposed`, `Accepted`, `Deprecated` or
  `Superseded by NNNN`. An accepted ADR is not rewritten: changing a decision
  means writing a new ADR and marking the old one as superseded. Fixing typos
  and links is fine.
- An ADR is added in the pull request that makes the decision.
- `architecture.md` remains the specification. ADRs explain it and settle its
  open points; they never contradict it. When a decision changes the
  specification, the same pull request updates `architecture.md`.

ADRs 0002 to 0008 record decisions that the specification already made.
ADR 0009 records how its ambiguous points are interpreted.

## Consequences

- Contributors find the reasoning behind the main choices without digging
  through pull request history.
- Each significant decision costs a short document. Reviewers ask for one when
  a pull request makes such a decision without it.
- Superseded ADRs stay in the repository, so the history of a decision remains
  readable.
