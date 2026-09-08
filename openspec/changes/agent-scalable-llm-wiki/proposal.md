## Why

The refactoring programme lacks executable machinery for locating boundaries, recording current review evidence, coordinating ownership and measuring useful parallel work. The refined Radical Modularity design specifies that machinery but has no implementation packet. Workers need bounded contracts and acceptance conditions before they can build it without reopening the design.

## What Changes

Implement the [Radical Modularity delivery sequence](../../../docs/plans/2026-09-08-agent-scalable-llm-wiki.md): pin baseline outcomes and usage, add recursive indexes and finite review evidence, enforce work-packet admission through one shared Git authority, complete the exhaustive review/correction sweep, and run controlled one/two/four/eight-session experiments before selecting an enforce policy.

Tooling reports inventory coverage, required review debt, unresolved findings and measurement completeness separately. Candidate admission validates the exact combined candidate and its trusted policy. Experiment results retain failed trials and full cost; supported scaling claims require measured outcomes.

## Non-Goals

No embedding service, third-party search, second wiki tree, permanent model ownership, guaranteed semantic understanding, universal scaling guarantee, multi-host lease authority or unproved filesystem-write prevention. No unrelated product behavior changes discovered during the sweep; those need their own OpenSpec changes.

## Constraints

Preserve R1–R5 and existing repository gates. Inventory exact tracked tuples; classify content and evidence separately. Keep source authority and knowledge colocated. Preserve historical migration/evidence bytes. Coordinate root edits and eventual namespace mappings with `repo-namespacing`. Missing telemetry and unavailable eight-session capacity remain explicit incomplete evidence. Preparation runs no experiments and certifies no operational capability.

## Capabilities

### New Capabilities

- `index-conventions`: Recursive navigation with exact membership and authority references.
- `wiki-ledger`: Finite content/evidence accounting and scoped review currency.
- `wiki-lint`: Candidate-specific deterministic validation and trusted rollout policy.
- `work-admission`: Atomic ownership claims, fenced submissions and combined integration checks.
- `scalability-measurement`: Fixed-outcome, full-cost experiments and honest adoption reporting.

### Modified Capabilities

None.

## Domain Terms

Use the existing architecture glossary; new distinctions are recorded there by the coordinating design owner.

## Decisions Recorded

[ADR 0020](../../../docs/adr/0020-module-identities-and-finite-evidence.md) and
[ADR 0021](../../../docs/adr/0021-shared-git-admission-authority.md).

## Impact

New infrastructure tooling, repository indexes and review artifacts, root gate/CI/hooks, worktree integration and experiment evidence. Product runtime contracts remain unchanged.
