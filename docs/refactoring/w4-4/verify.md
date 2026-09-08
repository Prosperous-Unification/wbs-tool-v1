# W4-4 verification

Worktree: `.worktrees/refactoring`, branch `refactor/planned-project`.

Baseline, 2026-09-06: from `apps/fe-01`, `TZ=UTC bunx vitest run --no-file-parallelism --maxWorkers=1 --minWorkers=1 src/components/wbs/plan-read-and-write.test.tsx src/components/wbs/plan-keyboard.test.tsx src/components/wbs/plan-chart-seam.test.tsx` passed **151 tests across 3 files**, 69.86s. Existing React act warnings were printed. Full output: `/private/tmp/w4-4-baseline.log`.

Extraction checkpoint (historical): **601 table concept tests passed**, source and root frontend typechecks passed, scoped lint has **0 errors / 1 preserved dependency warning**, and both deliberate negatives were observed. The independent review is recorded later in this file on 2026-09-08. Remaining task 3.5 reconciles gate evidence and the handoff; see [the current ledger](../tasks.md), not this earlier checkpoint, for closeout status.

First extraction checkpoint: the same three suites passed **151/151** in **68.95s**, output `/private/tmp/w4-4-after-core.log`. The output contains the same pre-existing React act warnings as the baseline. `bunx tsc --build --force apps/fe-01/tsconfig.app.json` exited 0 with no diagnostics after column factories and the exported live contract were wired (log `/private/tmp/w4-types.log`, subsequently reused for iterative checks).

## Column identity failure proof

Before injection, the focused case passed (1 passed / 42 intentionally filtered), `/private/tmp/w4-4-focus-green-before.log`.

Injected `workItems` into the production `columns` dependency list. The existing production-path case `does not take the focus or the half-typed value` failed at `plan-read-and-write.test.tsx:410`: the active element was `<body>` instead of the Name cell. Output `/private/tmp/w4-4-column-fault-observed.log`, **1 failed / 42 filtered**. The correct dependency list was restored immediately and the adjacent Proof comment records the observed focus failure. The first fault invocation used the repo cwd rather than `apps/fe-01`; it collected no test files (`/private/tmp/w4-4-column-fault.log`) and is not failure evidence.

All concept suites below include the restored case. No browser geometry proof is claimed from this jsdom failure.

Structural comparison after extraction (`/private/tmp/w4-4-ast-comparison.log`): **286 of 322** original variable initializers/function bodies are token-identical; **136 of 137** original hook callback bodies are token-identical (the exception is the columns registry). Most full-initializer differences are the explicitly added stable setter/ref dependencies. The other named differences are liveNow, columns, the exported Start sentence, toolbar JSX moved to a component, and prettier's parentheses around conditional arrow bodies. The script is `/private/tmp/w4-compare.cjs`; this comparison supports review and does not replace runtime tests.

A first all-concept invocation ran from the repository cwd and failed during collection: **11 files failed / no tests**, `/private/tmp/w4-4-concepts.log`. It was rerun from the required `apps/fe-01` cwd; `/private/tmp/w4-4-concepts-app.log` is the actual verification run.

## Full table concept run

From `apps/fe-01`, run `TZ=UTC bunx vitest run --no-file-parallelism --maxWorkers=1 --minWorkers=1` with these eleven paths under `src/components/wbs/`: `plan-table.test.tsx`, `plan-read-and-write.test.tsx`, `plan-keyboard.test.tsx`, `plan-chart-seam.test.tsx`, `plan-layout.test.tsx`, `plan-filter.test.tsx`, `plan-estimates.test.tsx`, `plan-dependencies.test.tsx`, `plan-cells.test.tsx`, `plan-structure.test.tsx`, `plan-toolbar.test.tsx`.

**601 tests passed across 11 files**, 177.41s. The source was frozen throughout this run. Output: `/private/tmp/w4-4-concepts-app.log`. React act warnings were printed; no test failures or timeouts occurred. Subsequent source changes only choose `.ts` for non-JSX modules, correct stale comments, and add the observed proof comments.

## Type and lint checks

- `bunx nx typecheck fe-01 --skip-nx-cache`: passed after restoring the live-field fault; source, spec and e2e references are included by the root project. Output `/private/tmp/w4-fe-root-typecheck.log`.
- `bunx tsc --build --force apps/fe-01/tsconfig.app.json`: passed with no diagnostics after the final filename/comment cleanup; `/private/tmp/w4-types-final.log`.
- `bunx eslint` over the changed frontend file list (`/private/tmp/w4-files.json`): **0 errors, 1 warning**, `/private/tmp/w4-lint-final.log`. The warning names the original filter memo's redundant `ownedServicesByTeam` and `teamsByPerson` dependencies; both were kept to preserve invalidation behavior.
- Missing-live-field negative: remove `busy` only from the production `liveNow` literal; the source TypeScript command reports **TS2741**, `Property 'busy' is missing ... but required in type 'PlanLiveValues'`. Output `/private/tmp/w4-live-type-fault.log`. The field was restored before the root frontend typecheck.
- `bunx openspec validate wbs-table-modules --strict`: reports **valid**; `/private/tmp/w4-openspec.log`. Its optional analytics flush also prints a network failure (`edge.openspec.dev` DNS unavailable), separate from validation.

## R1 / R10 seams

R1 has one frontend owner in `use-plan-read.ts`: `usePlanRead` holds refresh generations, first read, live subscription, `refreshOrMarkStale`, `run` and `stepStack`; `usePlanReadState` owns the installed state values and current-project ref. `PlanReadScope` is declared in `use-plan-read.ts` and imported from there by
`use-plan-dependencies.ts` and `plan-toolbar.tsx` directly — **corrected 2026-09-08**: this
line said `readScopeFor` "remains unchanged and is re-exported by WbsTable", and there is no
such function anywhere in `apps/` (it survives only in stale `.worktrees/` checkouts). The
re-export it named was `PlanReadScope`, and that has been deleted too: a table acting as a
barrel for a module it no longer owns is the shape this split was for. URL-only sharing in wbs-api/project-stream is untouched. The coordinator beside project-stream can replace this read orchestration while retaining the current setters/installed state interface; the dropped wider-scope and stale in-flight read faults are **not fixed** here.

R10 has `use-plan-filter.ts` for query/facet/saved-view state and narrowing, `plan-columns/*` plus `plan-cell-props.ts` for cell behavior, and the exported `PlanLiveValues`/`PlanLive` contract. PlanRow and the pointed store stay unchanged. All rows still mount; search still causes the same parent render. Hovered/focused/open-card state remains in composition, and PlanCards' fresh props remain as before. Virtualization, filter isolation, per-cell subscription and PlanCard memoization are **not implemented or claimed** by this mechanical slice.

## Independent review, 2026-09-08

Task 3.4's independent review, run against `main` at `f64ceea4` by a reader that had the plan
and the three invariants and had not written the split. Its findings, and what was done:

**The split meets what the plan asked for on every load-bearing point.** All fourteen planned
modules exist under their planned names; `wbs-table.tsx` is **12,150 → 2,011** lines (669 of
them comments, so ~1,340 of composition against the plan's "~900–1,100"); the three
untouchables hold — `live` is the cells' sole contract with `PlanLiveValues`/`PlanLive`
exported and compiler-enforced, the `columns` memo depends on exactly
`[steps, unfoldedSteps, hiddenColumnIds]` with a recorded failure proof, and `PlanRow` and
`pointed-row-store.ts` are byte-identical to baseline. No cycles; no module reaches back into
the table; no hook closes over a value it should read through `live`. Six modules exist beyond
the fourteen, all recorded in the extraction map, and one of them — `plan-live.ts` — is the
exported contract the plan asked for as a type.

Four defects, all of documentation or surface rather than behaviour, **fixed in the same
change as this record**:

1. **Thirty-two template JSDoc lines that described nothing**, seven of them verbatim
   duplicates within one file (`use-plan-keyboard.ts`'s three, `use-plan-layout.tsx`'s four).
   A reader opening those files could not tell the hooks apart from their doc. Every one is
   now a sentence about what that hook is for and why it is its own hook.
2. **`wbs-table.tsx:317` still said "`columns` depends on `steps` alone"** — false since the
   dep list is three, and precisely the restatement the exported type was meant to retire. It
   names `PlanLiveValues`' three now.
3. **`verify.md` and `extraction-map.md` named `readScopeFor`**, which does not exist anywhere
   in `apps/` — it survives only in stale `.worktrees/` checkouts. Both lines are corrected,
   and the R1 handoff sentence that rested on the claim is rewritten.
4. **Two re-exports through the table**: `PlanReadScope` (imported from `wbs-table` by nobody)
   and `widthFromDrag` (re-exported solely so `plan-layout.test.tsx` could import it through
   the table rather than from `use-plan-layout`). Both deleted; the test names the owner.

Two findings were **left as they are, with reasons**:

- The cell-open state (`hoveredCell`, `focusedCell`, the derived `openCard`) is still
  composition state — W2-7's deferred half. `tasks.md` and this file both re-defer it to R10
  in writing, which is a disclosed gap rather than a miss.
- None of the sixteen new modules has a suite naming it; the oracle is still the whole-table
  suite (601 tests across eleven concept files, split by W1-2 before this change). That is
  `design.md`'s decision — "keep the existing component suites on `WbsTable`'s production
  path" — and changing it is R10's business, where the row/cell dependencies become explicit.

The review also noted `use-column-set.ts` importing `COLUMN_LABELS` from `./plan-toolbar` — a
hook taking vocabulary from a component module. Not a cycle, and not changed here: moving the
label table to `table-frame` beside `hideableColumnIds` is a rename with its own blast radius.
