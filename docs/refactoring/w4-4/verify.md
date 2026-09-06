# W4-4 verification

Worktree: `.worktrees/refactoring`, branch `refactor/planned-project`.

Baseline, 2026-09-06: from `apps/fe-01`, `TZ=UTC bunx vitest run --no-file-parallelism --maxWorkers=1 --minWorkers=1 src/components/wbs/plan-read-and-write.test.tsx src/components/wbs/plan-keyboard.test.tsx src/components/wbs/plan-chart-seam.test.tsx` passed **151 tests across 3 files**, 69.86s. Existing React act warnings were printed. Full output: `/private/tmp/w4-4-baseline.log`.

Current status: **601 table concept tests passed**, source and root frontend typechecks passed, scoped lint has **0 errors / 1 preserved dependency warning**, and both deliberate negatives were observed. Independent review and the full frontend/browser gates are pending parent coordination.

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

R1 has one frontend owner in `use-plan-read.ts`: `usePlanRead` holds refresh generations, first read, live subscription, `refreshOrMarkStale`, `run` and `stepStack`; `usePlanReadState` owns the installed state values and current-project ref. `readScopeFor` remains unchanged and is re-exported by WbsTable for existing callers. URL-only sharing in wbs-api/project-stream is untouched. The coordinator beside project-stream can replace this read orchestration while retaining the current setters/installed state interface; the dropped wider-scope and stale in-flight read faults are **not fixed** here.

R10 has `use-plan-filter.ts` for query/facet/saved-view state and narrowing, `plan-columns/*` plus `plan-cell-props.ts` for cell behavior, and the exported `PlanLiveValues`/`PlanLive` contract. PlanRow and the pointed store stay unchanged. All rows still mount; search still causes the same parent render. Hovered/focused/open-card state remains in composition, and PlanCards' fresh props remain as before. Virtualization, filter isolation, per-cell subscription and PlanCard memoization are **not implemented or claimed** by this mechanical slice.
