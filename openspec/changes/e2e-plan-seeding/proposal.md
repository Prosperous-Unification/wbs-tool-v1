## Why

Browser scenarios spend time repeating setup gestures even when those gestures are not under test. The old plan overstated identical seed functions and assumed separate accounts; current local mode shares an account and a deployment-wide directory. Faster setup must preserve each scenario's fault sensitivity and state independence.

## What Changes

A typed same-origin API fixture creates selected prerequisites, verifies the server's actual tree, and then opens the tested plan. Specs whose setup exercises focus, editing or live writes retain those UI gestures. A measured one-versus-four-worker decision replaces the assumed concurrency speedup.

## Non-Goals

No direct database writes, seed-only endpoints, blanket conversion of layout/keyboard cases, account model change, retries, or automatic four-worker default without evidence.

## Constraints

Use the existing HTTP command contract and create-project helper where UI creation is part of the scenario. Scope projects and global names to test identity. Own server ports and the run database. Whole browser suites, not only new fixture cases, prove the change.

## Capabilities

### New Capabilities

- `e2e-plan-seeding`: verified prerequisites with explicit scenario ownership and measured concurrency.

## Domain Terms

None.

## Decisions Recorded

None.

## Impact

fe-01 e2e helpers, explicitly selected specs, Playwright configuration only if concurrency earns its measured acceptance rule. No application behavior or migration.
