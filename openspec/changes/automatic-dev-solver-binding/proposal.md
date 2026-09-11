## Why

Dev promises that `origin/main` reaches h2puni without a human. That promise
currently breaks whenever `libs/solver-py` or `apps/be-01/Dockerfile` moves:
`preflightSolver` correctly requires a source-compatible digest-pinned solver
image, but publishing the image and installing its host binding are manual.
The first enforced change produced 420 consecutive failed poll ticks and parked
the dev queue. A ten-tick alarm now exposes a recurrence but does not deploy it.

## What Changes

- The dev Deploy trigger detects a moved solver compatibility input before the
  checkout reset.
- Under the same exclusion boundary as the deploy, it prepares the target in a
  clean target-revision checkout, publishes one immutable solver image,
  materializes and installs the host-owned Solver compatibility binding, then
  runs the existing preflight.
- Preparation is idempotent by target compatibility identity. A retry reuses a
  verified published digest and never installs a binding for different source
  bytes. Revisions with no compatibility change reuse the installed binding.
- Any preparation failure remains before reset and is reported by the existing
  deploy-health alarm.

## Non-Goals

Changing prod deploys; granting registry, Docker, systemd, or image-selection
authority to CI or an application container; weakening source/image
compatibility; replacing the alarm; registry retention.

## Constraints

The repo is public and CI receives no host mutation authority. The live dev
checkout cannot move before the binding is verified. Builds run only on h2puni.
An interrupted publish or install must be safe to retry, and the target
candidate must not resolve implementation modules from the older live checkout.

## Capabilities

### Modified Capabilities

- `deployment-pipeline`: solver compatibility preparation becomes an automatic,
  host-owned pre-reset phase of the dev Deploy trigger.

## Domain Terms

Solver compatibility binding.

## Decisions Recorded

- [ADR 0018](../../../docs/adr/0018-the-dev-deploy-trigger-owns-solver-compatibility-preparation.md)
