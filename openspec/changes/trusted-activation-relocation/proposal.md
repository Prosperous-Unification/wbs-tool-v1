## Why

The base-owned `trusted-wiki` check extracts an activation pinned to one main SHA, whose policy selects `libs/domain/src/saved-plan` — a directory the namespace move relocated. Every candidate is refused with `trusted boundary selector selects no candidate input`, so the check is red on main. The policy format already models a move: `selector` names the new path, `sourceSelector` the old. Missing is a way to activate a candidate's own policy before it merges, and a refusal that names it. Every later boundary move hits this wall.

## What Changes

**Selector-miss refusal**

- From: `trusted boundary selector selects no candidate input: <boundary id>`
- To: the same refusal, also naming the selector that missed and `docs/runbook-tool-wiki-activation.md#relocation`
- Impact: non-breaking; the check is unchanged

**Relocation activation**

- From: nothing produces an activation from a candidate's own policy, so a move cannot land
- To: one command takes a candidate SHA and a base activation and writes an activation root, refusing an unknown or dirty SHA, a moved boundary without `sourceSelector`, an unresolved `predecessorModuleIds` chain, and a selector that selects nothing
- Impact: new operator command; admission is unchanged

**Landing a move**

- From: undocumented
- To: the runbook states the two-step landing — activate from the candidate head, then merge — and its limit: three single-valued repository variables serialize concurrent move candidates

## Non-Goals

Selectors resolving through untrusted candidate files. Weakening the digest pins that tie an activation to one candidate. Changing what admission accepts. Release automation. Changing the operator-only compatible-activation gate.

## Constraints

Candidate policy and mapping are read at a committed SHA, never a working tree. One authority snapshot certifies one candidate identity, so an activation is per-candidate. No design interview was held; this intent assumes:

- assumed: the activation regenerates policy, mapping, authority, both bindings and the review receipt from the candidate SHA, and copies launcher, snapshotter, validator and evidence.
- assumed: `manifest.sourceRevision` stays informational; the tie remains the authority's `candidateIdentity`.
- assumed: publishing the archive and setting the variables stays an admin operator step.
- assumed: `#relocation` is the stable anchor the refusal names.

## Capabilities

### New Capabilities

- `trusted-activation-relocation`: a moved trusted boundary has a named, executable path from refusal to an activation prepared from the candidate SHA.

### Modified Capabilities

None.

## Domain Terms

`Relocation activation` (CONTEXT.md).

## Decisions Recorded

None yet; see `design.md`.

## Impact

`tools/tool-wiki/src/policy`, `docs/runbook-tool-wiki-activation.md`, and the `TOOL_WIKI_ACTIVATION_*` repository variables CI reads.
