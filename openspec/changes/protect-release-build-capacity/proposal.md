## Why

A three-image release build started while h2puni was already carrying unrelated
heavy gates. Memory reclaim and filesystem reads drove load above 165, starved
Caddy and SSH, and left a multi-gigabyte Dagger engine resident after the
publish was interrupted. The release path must refuse unsafe starts and return
the application host's capacity after every outcome.

## What Changes

**Release admission**

- From: every publish opens a Dagger session immediately.
- To: one host-wide non-blocking heavy-work lock and a capacity preflight admit
  the publish before any engine starts.
- Impact: a busy or low-capacity host receives an explicit refusal instead of a
  release attempt.

**Engine lifecycle**

- From: Dagger auto-provisions an unbounded engine that may remain resident.
- To: the release uses one named engine with explicit memory, CPU, and PID
  ceilings and stops it after success or failure while retaining its disk cache.
- Impact: release memory and CPU are bounded; the next release restarts the
  stopped engine.

## Non-Goals

- Purchasing, resizing, or provisioning another host.
- Changing image contents, release manifests, blue/green swap sequencing, or
  production routing.
- Automatically waiting for capacity; a refused release is retried explicitly.

## Constraints

- h2puni remains both application and build host for this change.
- Builds and autotests run only on h2puni or CI.
- The lock is fail-fast, the preflight is fail-closed, and registry secrets are
  never printed.
- The Dagger image stays pinned to v0.21.8 and builds stay linux/amd64.

## Capabilities

### New Capabilities

- `release-build-capacity`: admission and bounded lifecycle for release builds
  on a shared application host.

### Modified Capabilities

- none

## Domain Terms

none

## Decisions Recorded

none

## Impact

`tool-dagger` publish orchestration, h2puni gate commands, the production
deploy runbook, and the Dagger engine runbook.
