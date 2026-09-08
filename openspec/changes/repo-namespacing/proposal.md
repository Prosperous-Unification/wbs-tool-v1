## Why

The workspace still gives WBS projects unqualified top-level identities. Moving them after core extraction will change paths used by development, checks and image builds; today's shallow project discovery would also stop seeing the moved projects. The namespace must become an enforced boundary without losing those callers or safety checks.

## What Changes

Apply D18/D19 from the [ports plan](../../../docs/2026-09-05-ports-and-adapters-plan.md): WBS applications live under `apps/wbs`, libraries under `libs/wbs/{domain,application,adapters}`, and their Nx names gain `wbs-`. Existing `@wbs/*` aliases retain their identities. Every application/library has one product tag, every project retains one scope/ring/runtime tag, and checks reject a mismatched directory or forbidden cross-product dependency.

All affected commands, caches, development restart rules, migration discovery and image inputs follow the new layout. Production deployment names and wire behavior stay stable.

## Non-Goals

No second product, runtime source, HTTP adapter, schema migration, deployment identity rename, solver redesign or performance optimization. No migration or CLI move before core extraction finishes.

## Constraints

`core-lib-extraction` must finish first. Reconcile active solver ownership before moving its paths. Use Bun/Nx and the existing host lock. Preserve applied SQL bytes, down scripts, aliases, runtime tags and external container/image/DNS/environment identities. Prove recursive discovery and product/layout guards before the move; prove the moved production targets afterward. Full workspace/browser checks and a production dry-run remain implementation obligations, not claims from this preparation.

## Capabilities

### New Capabilities

- `repo-namespacing`: Complete project discovery, product/ring layout enforcement and operational continuity across the workspace move.

### Modified Capabilities

None.

## Domain Terms

None newly defined here; the existing Ring terminology applies.

## Decisions Recorded

[ADR 0014](../../../docs/adr/0014-ports-live-in-a-framework-free-core-lib.md); D18/D19 in the linked ports plan.

## Impact

Every WBS project, root aliases/scripts/lint, CI/hooks, development setup/sync, migration tooling and Dagger Dockerfile paths. `tools/*` remains infrastructure.
