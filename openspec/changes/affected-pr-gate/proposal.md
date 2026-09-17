## Why

Every pull request runs the whole workspace through `nx run-many -t test lint typecheck build`, and the merged tree runs it again. At PR #457 that cost 38 minutes per attempt, so the wait is dominated by targets the change cannot reach. Composition can only be proven on the merged tree — where the full run belongs and where it is redundant.

## What Changes

**Gate scope**

- From: every event runs the full `run-many`.
- To: an explicit per-event mapping. `pull_request` runs `nx affected` from its immutable base SHA; `merge_group`, `push` and `workflow_dispatch` keep the full `run-many`; an unmapped event is refused.
- Impact: non-breaking for `main`; a pull-request run reports a subset of a full run.

**Browser shards**

- From: four `pixels` shards boot the three-app stack on every event.
- To: they run when the mode is full, or when the pull request affects a project the stack boots; the required `pixels` check separates a deliberate skip from a failed shard.
- Impact: non-breaking; a pull request reaching none of the three reports `pixels` green without booting chromium.

## Non-Goals

No remote Nx cache. No change to what the full gate runs, to shard count, to timeouts, or to the h2puni gate. No weakening of `main`, of the merge queue, or of any step outside the Nx gate. No narrowing of any project's Nx inputs. No boundary inferred from a mutable ref.

## Constraints

Dany creates the `main` ruleset with a merge queue and the required checks `gate` and `pixels`; until then `merge_group` never fires and that arm is unexercised. `actions/checkout` keeps `fetch-depth: 0`, because `--base` cannot resolve against a shallow clone. `nx show projects` emits JSON on a non-TTY runner, so membership is read with `jq -s`. Assumed: the browser stack boots `wbs-fe-01`, `wbs-be-01` and `wbs-gw-01`, per `playwright.config.ts`; assumed: no human design interview was held, per controller ruling.

## Capabilities

### New Capabilities

- `affected-pr-gate`: per-event gate scope, boundary from the event payload, unmapped events refused.

### Modified Capabilities

None.

## Domain Terms

None.

## Decisions Recorded

None.

## Impact

`ci.yml` jobs `gate`, `pixels_shard`, `pixels` and the new `pixels_mode`; both pin suites; `test` inputs of `tool-git-hooks` and `tool-wiki`. No application or deployment change. Measured limit: `tool-wiki:lint` and `tool-devsync:test` declare `{workspaceRoot}/**/*`, so every file affects both and the saving stays well under 38 minutes until that is narrowed.
