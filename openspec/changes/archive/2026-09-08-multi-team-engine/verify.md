# Verify — recovered `multi-team-engine` record

## TASK-364 present-tense reconciliation

Inspected current `main@0cb148afe85fb307effb7e4bae90968d65177b6b`
before writing this record.

| Claim                                         | Current evidence                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A slice carries all sized pools               | `libs/domain/src/schedule.ts` declares `poolIds: readonly string[]`; placement passes the complete set to `jointWindowFor` and `reserve`.          |
| A block spends slots in every team            | `reserve` iterates every `poolId`; `libs/domain/src/schedule-joint-capacity.test.ts` asserts later single-pool work waits behind a two-pool block. |
| The search waits for all teams                | `jointWindowFor` advances to the latest pool answer and loops until stable; the focused test covers the required re-ask.                           |
| Width uses the narrowest team                 | `apps/be-01/src/service/work-item.service.ts` exports `poolsFor`, whose fold uses `Math.min`; focused service tests cover both input orders.       |
| The binding team is carried to readers        | `capacityTeamId` is on `ScheduledSlice`, the shared HTTP response, fe-01's `SliceView`, and the Gantt capacity explanation.                        |
| Focused coverage exists on the current layout | `libs/domain/src/schedule-joint-capacity.test.ts` contains the ported August suite plus later regression cases.                                    |

### History proof

- Original focused-test commit: `d8a09ce2` (`tests: the joint window search,
seven behaviours`, 2026-08-14).
- Landed route: TASK-182 / PR #175 at `14b9ffa5`, whose commit message explicitly
  records the joint-window port and multi-team scheduling engine.
- Domain move: `eeaac94d`, which moved the engine and tests from
  `apps/be-01/src/service` to `libs/domain/src`.
- Current focused refinements include `96e1424b`, aligning capacity referent
  ties with placement order while keeping the binding-team rule.

This history corrects TASK-364's intake statement that a file named
`apps/be-01/src/service/schedule-joint-capacity.test.ts` was absent and therefore
coverage had not landed. The path was obsolete; `git log --follow` connects the
current file to the original one.

## Failure-proof mapping

The focused test file contains adjacent `Proof:` comments for the mutations that
were watched red before the implementation was accepted. TASK-364 relies on
that landed evidence and re-runs one representative negative remotely.

| Contract              | Injected historical fault                                | Recorded failure                                    |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| Wait for every pool   | choose the earlier rather than latest pool answer        | accepted start moved from day 5 to day 2            |
| Name the binding team | always read `poolIds[0]`                                 | Alpha was named where Beta was owed                 |
| Spend in every pool   | reserve only the first pool                              | work behind Beta started at day 0 rather than day 3 |
| Keep causal blockers  | keep only the final round's empty scans                  | the predecessor union was empty                     |
| Re-ask after movement | replace the fixpoint with one pass                       | accepted start was day 3 rather than day 6          |
| Exclude overlap       | promote a reservation continuing past the accepted start | backward edges produced negative public float       |

## Fresh TASK-364 gates

All commands in this section run on h2puni. Nothing was built or autotested on
the queue-worker host.

At `21eb4c0b` with Bun 1.4.2:

- **Watched red:** changed `reserve` to iterate `poolIds.slice(0, 1)` and ran
  `bun test libs/domain/src/schedule-joint-capacity.test.ts`. Result: **8 pass /
  1 fail / 38 expect()**. The named case `takes a slot from every pool it names`
  failed on `after-beta`: it started at day 0 with no capacity predecessor where
  day 3 and Beta were owed.
- Restored `libs/domain/src/schedule.ts`, proved it had no diff, and ran the same
  file. Result: **9 pass / 0 fail / 38 expect()**.
- `bunx @fission-ai/openspec@1.3.0 validate --all --json`: **52 passed / 0
  failed** (51 changes and 1 spec).

The first scoped `nx format:check` named only this record's `verify.md`; its
formatter output was folded. At exact `ba462d54`, scoped `nx format:check`
over all six changed paths passed, and OpenSpec again passed **52 / 0**. The repository-wide
`nx format:check --all` also names 44 unrelated paths already present on the
base, so it cannot serve as a clean task-specific verdict. Impact: a whole-tree
format gate is red independent of this six-file documentation diff. Remedy:
prove the exact changed paths here and let CI expose whether the repository's
current gate baseline has been repaired before merge.

## Historical August evidence — not a TASK-364 gate

PR #67's branch recorded a full h2puni run at its then-current code head:

- be-01: 750 pass / 0 fail / 62 files under Bun 1.2.20;
- the same 750 tests / 0 fail / 62 files under Bun 1.3.14;
- fe-01: 1,342 pass / 0 fail / 52 files;
- gw-01: 45 pass / 0 fail / 8 files;
- OpenSpec: 49 passed / 0 failed;
- lint, typecheck, format, secrets, doc caps, and migration lint green.

Those numbers remain provenance for the original implementation and its fault
table. They are not presented as fresh results for `main` or TASK-364.

## 2026-09-08 coverage reconciliation

The first recovered record overstated current coverage: the August branch had
an alternating-pool case that required a second fixpoint round, while the
current focused file did not. The case now lives in
`libs/domain/src/schedule-joint-capacity.test.ts` on the current engine layout.

- Green control: `bun test libs/domain/src/schedule-joint-capacity.test.ts`
  reported **10 pass / 0 fail / 42 expect()**.
- Negative control: replaced the fixpoint candidate update with an immediate
  return of the first round. The new case received start day 3 and Alpha as the
  binding team instead of day 6 and Beta; the file reported **9 pass / 1 fail /
  40 expect()**.

The production fault was restored before the green control. This closes the
gap in D5's claim without importing the obsolete August implementation.
