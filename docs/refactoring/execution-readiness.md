# Refactoring execution readiness

## Authority and scope

The requested deliverable is the architectural preparation for the remaining refactoring
queue, so a medium-effort implementer can execute one bounded slice without inventing its
contract. Preparation does not claim implementation, runtime measurements or passing gates.
The implementation queue is [tasks.md](tasks.md); ordered TDD slices stay in each OpenSpec
change's `tasks.md`. This document records assumptions and cross-change readiness only.

The initial audit reads checkout `339708fa`, 2026-09-08, on
`change/optimization-cue-and-suggestion`. Its pre-existing uncommitted optimization code,
tests and `dual-optimized-scheduler` artifacts belong to the active feature work. They are
part of the dependency inventory, not permission to overwrite that work. Code moves must
recheck the landing revision before starting; the documentation here is prepared in place.
Feature work advanced HEAD through `33e786b3` to `aca7a5c9` during preparation. The audit
inspected the new optimized read shape and preserved both variant schedules/comparison
cues. No feature edits were reverted or replaced.

Integration reconciles against `main` at `14cc7367`. R10 landed independently in PR #353
as `f66f73e8`: its complete packet and evidence are preserved unchanged from main, not
replaced by the earlier preparation draft. That draft remains in snapshot commit
`24c5f851` on local branch `docs/refactoring-preparation-snapshot`. The optimization
feature PR #354 remains separate; its inspected scheduler contracts are prerequisites,
not claims about the current main implementation or permission to merge that feature.

## Assumptions authorized by the request

1. **Resolve design choices autonomously.** The instruction to make and document assumptions
   replaces the design skills' interactive confirmation steps for this preparation. Existing
   accepted product decisions and precise specifications still constrain the answer.
2. **Preserve the whole queue.** Include R10, W4-4 closeout, R1–R9 archival, core extraction,
   namespacing, command registry, live plan snapshot, local-write invalidation, e2e seeding,
   MCP OIDC store adoption and the already-listed JSON import. Audit the linked Radical
   Modularity proposal for additional remaining preparation; do not silently lose it.
3. **Readiness permits ordered prerequisites.** A successor can be specified now and executed
   after its predecessor. A missing prerequisite must have a concrete task and acceptance
   condition; an unresolved architectural choice is not a prerequisite.
4. **Measurements remain observations.** Fix the sampling procedure, comparison rules and
   decision algorithm before execution. Never invent latency budgets or label an injected
   fault as observed until its output exists. Experimental evidence must identify its tree,
   environment and the window the assertion measures.
5. **Boundaries carry capability honestly.** Keep independent saved-plan history outside a
   command batch, preserve explicit announcement ownership and authorization, and retain
   unsupported source capabilities as typed absences or named allowlisted refusals.

## Execution handoff

Start with [core task 2.0](../../openspec/changes/core-lib-extraction/tasks.md): complete
recursive project discovery before relying on the move's gates. Execute one checkbox per
reviewed slice. The eleven remaining packets have intent, explicit design, delta requirements and
ordered tasks; implementation evidence is still owed. This is readiness for bounded
medium-effort execution, not a claim that one unreviewed model run can finish the programme.

The table covers every unfinished item in the original queue plus the explicit Wave 2
tails and linked Radical Modularity programme. Counts are implementation checkboxes at
integration reconciliation; historical checked boxes are not newly verified. R10 is shown
as a completed dependency, outside the eleven remaining packets.

| Scope / owning task file                                                                 | Prepared state                     | Prerequisite and first action                                                                      |
| ---------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Core extraction](../../openspec/changes/core-lib-extraction/tasks.md)                   | 6 historical checked, 21 remaining | 2.0 discovery; then neutral values, admitted scopes and runtime ports                              |
| [Scheduler boundary](../../openspec/changes/scheduler-runtime-port/tasks.md)             | 9 remaining                        | core through 2.2b.4 and #354 or equivalent interfaces landed; 1.1 selection/input characterization |
| [Source conformance](../../openspec/changes/source-conformance-completion/tasks.md)      | 24 remaining                       | completed core/staged sources; 1.1 exact 19-family and executed-case inventory                     |
| [Command registry](../../openspec/changes/plan-command-registry/tasks.md)                | 10 remaining                       | core; 1.1 independently pin wire kinds and refusal precedence                                      |
| [Working plan](../../openspec/changes/live-plan-snapshot/tasks.md)                       | 14 remaining                       | core and registry; 1.1 admitted read/mutation characterization                                     |
| [JSON import](../../openspec/changes/plan-json-import/tasks.md)                          | 22 remaining                       | core and scheduler; 1.1 pin current export/authored fields                                         |
| [Local write invalidation](../../openspec/changes/local-write-invalidation/tasks.md)     | 10 remaining                       | R1 and R10 landed; 1.1 map successful subrequests and preserve R10 interfaces                      |
| [MCP OIDC adoption](../../openspec/changes/mcp-oidc-store/tasks.md)                      | 10 remaining                       | serialize auth edits with core; 1.1 characterize capacity/callback tests                           |
| [R10 rendering](../../openspec/changes/measured-rendering/tasks.md)                      | Completed, 17/17 checked           | #353 at f66f73e8; preserve landed implementation and evidence                                      |
| [E2E seeding](../../openspec/changes/e2e-plan-seeding/tasks.md)                          | 11 remaining                       | R10 #353 completed; 1.1 distinguish setup from the tested gesture                                  |
| [Namespacing](../../openspec/changes/repo-namespacing/tasks.md)                          | 13 remaining                       | core and serialized moves; 1.1 project/path/alias/deploy identity manifest                         |
| [Radical Modularity / LLM wiki](../../openspec/changes/agent-scalable-llm-wiki/tasks.md) | 29 remaining                       | 1.1 untouched baseline before policy/root cleanup; final mapping follows namespacing               |
| [W4 closeout](../../openspec/changes/wbs-table-modules/tasks.md)                         | 9/10 historically checked          | 3.5 gate-evidence reconciliation and handoff; review 3.4 already recorded                          |
| [R1–R9 archival](tasks.md#r1r9-archival-closeout)                                        | A1–A9 administrative slices        | reconcile each change before sync/archive; R1 5.2 needs named browser evidence                     |

There are **173 unchecked implementation slices** across the eleven remaining packets,
plus closeout work. The original snapshot's 24 pending R10 slices are superseded by the
independently landed 17/17 implementation, not added to it. Completed Wave 2 and the
archived HTTP foundation are not new implementation.
Previously refused changes stay refused unless explicitly listed here. The hosted
optimization API exploration, offline persistence/product mode, new memory capabilities
and unrelated feature backlog are out.

### Dependency order and collision lanes

The sole interleaved prerequisite is explicit: core 2.0 through 2.2b.4 → scheduler packet
→ core 2.2c onward. Core need not be complete before creating the scheduler port it needs.
Scheduler's modified saved-plan requirements require the existing `saved-plans` base delta
to be synced first; this preparation does not archive that feature.

For serial implementation without path rebasing: complete core/scheduler, conformance,
registry and WorkingPlan, then import. MCP/auth and local-write work can proceed while
preserving the landed R10 interfaces. Reconcile W4/R1 handoffs before their consumers.
R10's prerequisite for e2e seeding is complete; preserve its acceptance ceilings and
record fresh source/fixture hashes for new measurements rather than relabeling the old
evidence. Namespacing follows these pre-layout packets; Radical
Modularity can preserve its initial baseline earlier but catches up to the final layout.
Independent work can overlap only with disjoint ownership; heavy checks still serialize.

Main collision lanes: core ↔ optimizer runtime, core ↔ MCP auth, registry ↔ WorkingPlan/
import wiring, local writes ↔ landed R10 hooks/actions, fixture seeding ↔ R10 measurement
oracles, and namespacing ↔
root/config/move consumers. Radical Modularity owns root policy/AGENTS/indexes/hooks only
after its baseline and coordinates those files with namespacing. Renames require a full
manifest rebase, not global replacement of deployment identities.

### Resolved assumptions that affect implementation

| Decision                                         | Authority and consequence                                                                                                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver transactions stay outside ports           | [ADR0018](../adr/0018-adapter-transactions-stay-outside-core-ports.md); optimizer outcome/event stays atomic, saved quota stays inside its independent write                                                                                  |
| Scope supplies actual stores                     | core C2/C6; graphs are made after admission, repair uses surviving scope, capture/history do not wait for the command gate                                                                                                                    |
| WorkingPlan lasts for one batch                  | [ADR0019](../adr/0019-a-working-plan-belongs-to-one-admitted-batch.md); detached before-images, targeted refresh, global-directory barriers; project assignment is not a full barrier                                                         |
| Scheduler reads do not await solving             | [ADR0022](../adr/0022-scheduling-reads-do-not-wait-for-solves.md); absent capability refuses reads, successful writes invalidate, capture records selected output or typed absence                                                            |
| Accounts are optional; history is separate       | core overloads exclude auth without fake stores; conformance separates 17 transactional + 2 history families, exact gaps and actual execution                                                                                                 |
| Wire registry already partly exists              | preserve ArkType/SchemaShape/OpenAPI and MCP operation IDs; finish normalizer/handler correlation, not a new Elysia probe                                                                                                                     |
| Measurements have fixed decision rules           | preserve R10's landed acceptance ceilings and evidence; WorkingPlan's 20 paired trials and 10% median tolerance; e2e's six runs and 20% median improvement threshold                                                                          |
| Evidence and ownership do not certify themselves | [ADR0020](../adr/0020-module-identities-and-finite-evidence.md), [ADR0021](../adr/0021-shared-git-admission-authority.md); stable identities, finite manifests, externally trusted provenance, atomic common-Git claims and final-ref fencing |

Thresholds and policies are authorized assumptions, not observed improvements. Saved-plan
capture expressly amends its earlier Fast-only/current requirement; canonical input-body
schema and stored history remain unchanged. Input equality can coexist with changed
selected schedule identity/presence. Import retains existing directory metadata rather
than overwriting global people/teams from a file.

## Preparation verification

Historical documentation-only checks for the preparation snapshot `24c5f851`, 2026-09-08
(before rebasing onto the independently completed R10):

- Strict whole-workspace OpenSpec validation: **63 items valid, 0 failures, 0 issues**
  (`OPENSPEC_TELEMETRY=0 openspec validate --all --strict --json`). An earlier run failed
  while source-conformance's delta was absent; the final valid result is after that packet
  was supplied, not an ignored failure.
- Twelve intents are 203–367 whitespace-delimited words, within the 400-word bound;
  all have proposal/design/spec/tasks and pending TDD slices. Apply readiness is separate
  from implementation completion: `openspec instructions apply --change <name> --json`
  reported **ready for all twelve**, totaling 197 remaining slices. No new verify artifact
  was invented. R10 integration reduces the remaining queue to eleven packets and 173 slices.
- The changed/untracked Markdown inventory contains **68 files**. Its **103 local links**,
  including **7 heading fragments**, resolve; no trailing whitespace was found. In-memory
  missing-file and missing-heading controls were both rejected by the same checker.
  This checks Markdown links, not backticked future implementation paths.
- Scoped `bunx prettier --check` and `git diff --check` pass after normalizing four
  task files' non-idempotent indented-paragraph/multiline-code formatting. The original
  format failure was observed, the corrected outputs are idempotent, and the whole
  68-file Markdown set is included in the final format check. Untracked files are checked
  by the file inventory/formatter, not claimed to be covered by `git diff --check`.

During design preparation, no application implementation, application tests, browser
measurement, h2puni gate, live service change or archive was performed. Commit, push and
merge are a separately authorized integration step; fresh integration checks belong below.
Historical verification remains historical. Factual execution prerequisites include a
frozen candidate, owned safe ports, required h2puni/release inputs, and real model/usage/
eight-way capacity for wiki trials. Missing access or telemetry must be reported, not
replaced with simulated passing evidence. Fault/window/assertion instructions are future
proofs; production Proof comments are written only after observing their failures.

### Integration verification

Fresh documentation checks on the candidate reconciled against `14cc7367`, 2026-09-08:

- Strict whole-workspace OpenSpec validation: **63 valid, 0 failures**; apply instructions
  report **ready for all eleven pending packets**, totaling **173 unchecked slices**.
  Their intents contain 203–334 whitespace-delimited words, within the 400-word bound.
- Scoped Prettier write followed by check: **72 Markdown/YAML files pass**;
  `git diff --check origin/main` passes. This is documentation formatting, not the full gate.
- The **63 changed Markdown files** contain **101 local links**, including **7 heading
  fragments**; all resolve. The same in-memory checker rejects an injected missing file
  with `ENOENT` and an injected absent fragment with `Missing heading`.
- `git diff --name-only origin/main -- openspec/changes/measured-rendering` is empty:
  the landed R10 packet, completed tasks and implementation evidence are unchanged.

Full application/browser gates are not run locally for this documentation-only integration;
the PR's fresh CI checks must pass before merge. Those results remain in the PR run record,
not inferred from the preparation snapshot or R10's historical run.
