# Command registry Task 1.1 report

## Status

Task 1.1 is complete on baseline `6a47a722`. No production behavior was changed. The characterization adds one independent structural-kind fixture, strengthens two mounted controls, corrects the stale 36-kind artifact count to the current 37, and records the baseline evidence in `openspec/changes/plan-command-registry/verify.md`.

**Commit**: `eeb62de0` (`test(commands): characterize current registry baseline`)

## Current implementation map

- Structural wire union: `libs/contracts/src/http/plan-command-shapes.ts`.
- Project/directory endpoint shapes: `libs/contracts/src/http/work-item-shapes.ts`.
- Binder and semantic parser: `libs/core/src/http/work-item.routes.ts`; `workItemRoutes` binds the shapes and `parseBatch` → `parseCommand` → `parseKind` normalizes them.
- Mounted adapter: `apps/be-01/src/app.ts` → `apps/be-01/src/http/elysia/mount.ts`.
- Route-to-runner boundary: `libs/core/src/use-cases/run-command-batch.ts`.
- Normalized union/kind list: `libs/core/src/service/plan-command.ts`.
- Runner: `libs/core/src/service/plan-commands.ts`; `execute` owns admission, unit of work, journal and publication, while `applyAll` owns ordered refs/scope/dispatch.
- The three old `apps/be-01/src/{controller,service}` command paths are compatibility re-exports from core after `core-lib-extraction`.

## Characterization delivered

- `libs/contracts/src/commands/definitions.test.ts` independently enumerates all 37 current kinds and compares them to the emitted production descriptor as a set plus cardinality.
- `apps/be-01/src/http/elysia/work-item.test.ts` now pins the measured semantic distinction: absent create priority stays absent, explicit null stays null, and absent assignee is intentionally normalized to null.
- The mounted cap-precedence case now sends exactly 201 commands, with invalid semantic data at index 200, and expects that semantic refusal before the cap.
- Existing mounted malformed nested-extra and semantic-invalid controls were preserved.

## Stale-count ruling

The approved artifacts were written against `339708fa`. Commit `521ef54f` subsequently added `arrangeBySchedule`, taking the production wire vocabulary from 36 to 37. The controller ruled that Task 1.1 must characterize the current independent set, so the proposal, design and Task 1.1 text now say 37 and name that commit. Registry implementation remains for later tasks.

## Evidence

- Command-kind fault: deleting the production `clearMeasure` schema arm made the independent set comparison fail because the received set omitted `clearMeasure`.
- Null/absence fault: defaulting absent create priority to null made the mounted runner-call assertion fail with an unexpected `priority: null`.
- Precedence fault: applying the 201-command cap in the mounted handler before parsing changed the expected `invalid_actual` into `too_many_commands` at index 200.
- Restored targeted run: 12 pass, 0 fail, 71 expectations.
- Exact required baseline: `bunx nx run-many -t test typecheck -p contracts core be-01 mcp-01` exited 0 with all eight targets successful.

## Concerns

- The exact baseline needed `bun install --frozen-lockfile` because this isolated worktree initially lacked `node_modules`; the install reported no lockfile changes. Nx records `contracts:test` as flaky because its earlier missing-compiler attempt failed before the successful rerun.
- The first sandboxed Nx run executed no visible targets after socket-denial warnings and is excluded from evidence.
- Final lint, format, OpenSpec validation and the h2puni gate are intentionally pending Task 3.2.
- OpenSpec’s optional telemetry flush was network-blocked, and the installed TDD skill’s linked `writing-good-tests.md` is missing.

## Task 1.2 continuation

Task 1.2 moves the unchanged structural ArkType arms and prose into `commandDefinitions`. `defineCommand` enforces its key/discriminator pair, while `PlanCommandWire`, `PlanCommandKind` and `PLAN_COMMAND_KINDS` derive from the registry. The HTTP adapter still applies the same strict request boundary and uncapped structural batch; refusal context consumes the derived kind through a type-only import. No normalizer, binding or runner work from Tasks 1.3–2.5 was started.

Observed negatives:

- Renaming the production `createWorkItem` registry key to `createWorkItemWrong` failed the agreement test with expected `createWorkItemWrong`, received `createWorkItem`.
- Removing `MatchingKind` from `defineCommand` failed the contracts spec compile only with TS2578 at the deliberately mismatched `setMeasure`/`clearMeasure` fixture.
- Removing the production `clearMeasure` definition and executing the real generated MCP input failed its independent set oracle with `clearMeasure` omitted.

Restored evidence: the contracts definition/shape run passed 7 tests; generated MCP coverage passed its focused test; definitions plus the complete mounted work-item controls passed 13 tests; the four-project Nx test/lint/typecheck gate passed all 12 targets; focused format check exited 0; OpenSpec validation passed all 75 items. The first broad gate exposed two import/export sorting errors, which were fixed before the complete gate reran green.

## Task 1.3 continuation

Task 1.3 keeps descriptor preservation visible at both boundaries. The contracts shape test pins `createWorkItem`'s existing prose alongside its pre-existing nested structural checks. The MCP shape-document test now runs the production `httpShapes` through `documentFromShapes` and the real `toolsFromDocument` generator, then verifies the emitted `createWorkItem` branch retains its discriminator, optional fields, nullable priority, required list and exact description. The generated-tool vocabulary oracle counts occurrences per independently listed kind rather than relying on total branches or a set alone.

Observed negatives:

- Replacing the production `clearMeasure` discriminator with `createTeam` retained 37 emitted alternatives and failed the generated-tool count oracle with `clearMeasure: 0` and `createTeam: 2`.
- Emptying only the production `createWorkItem` description failed its own generated branch at length 0. The direct contracts descriptor received `""` instead of the exact prior prose, and the production shape-document conversion showed the same empty field.

Restored evidence: the direct structural shape suite passed 5 tests; the focused production shape-document/generated-tool run passed 2 tests; the uncached contracts + mcp-01 Nx test/lint/typecheck gate passed all 6 targets. No semantic parser, runner or binding behavior changed.

## Task 2.1 continuation

Task 2.1 extracts all 37 pure semantic branches into the literal `commandNormalizers` record in `libs/core/src/service/command-normalizers.ts`. The normalized `PlanCommand` and `PlanCommandKind` now derive from those return types; the prior handwritten union is deleted, while `plan-command.ts` keeps compatibility exports and the temporary exhaustive kind list. The HTTP boundary delegates to `normalizeCommand`, translates its typed normalization error into the existing indexed refusal, and no longer carries the duplicate route-local command switch. Existing field parsers used by capacity and priority-band routes remain shared helpers.

The focused normalizer tests pin the three-state create priority and missing-assignee default. The required mounted negative configured a middle-band default of 47, changed the production normalizer to emit `null` for omitted priority, and failed on the persisted row with `Expected: 47`, `Received: null`; restored, the focused three cases passed. Adding the extracted production file to the existing core boundary inventory was separately proved by importing be-01's repository from it: the boundary test failed with `@nx/enforce-module-boundaries`, then the restored boundary plus mounted suite passed 15 tests.

Restored evidence: the uncached core + be-01 test/lint/typecheck gate passed all 6 targets in 1m23s; OpenSpec validation passed all 75 items; apply instructions reported `ready` with 4 of 10 tasks complete. The initial broad gate correctly failed on the dead route-local switch, strict inferred create fixtures, and lint inventory feedback; those root causes were removed or brought to the normalized boundary before the complete gate reran green.

### Task 2.1 review correction

Astra reproduced an externally visible refusal-order regression in the extracted record. The old parser eagerly validated `workItemId`, `workItemRef`, and `ref` before dispatch, while create and move parsed their base fields before placement refs. The extracted object-spread order had moved or omitted those reads. A mounted five-case aggregate test observed every reported mismatch before the fix: two creates chose `parentRef_must_be_an_id`, patch chose `expected_object`, move chose `parentRef_must_be_an_id`, and freezeProject fell through to bare `invalid_body`.

`normalizeCommand` now restores the common eager order for all 37 kinds, and create/move stage their values in the prior branch order. The restored mounted case passes with exact error/index/kind envelopes. A read-only differential loaded the real pre-extraction `parseKind` from `e8ccef3d^` and compared two successful variants per independently listed kind against the production normalizer: `NORMALIZED VALUES 74 matched; independent kinds 37; every returned discriminator matches`.

The final review-correction core + be-01 test/lint/typecheck gate passed all 6 targets uncached in 1m23s. Its first run had five successful targets and one test-only `no-unsafe-assignment` lint finding at the collected `Response.json()` boundary; typing that boundary as `unknown` made the focused lint and complete rerun green without production changes.

## Task 2.2 continuation

Task 2.2 makes structural-to-semantic completeness a compile-time property. `CommandNormalizerRecord` indexes a definitions object, gives each entry its own inferred structural wire input, and requires the returned discriminator to match that definition's key. The concrete 37-entry `commandNormalizers` literal satisfies the mapped record without narrowing its runtime `Record<string, unknown>` parameters, preserving semantic classification of structurally rejected mounted bodies and every existing field parser/refusal translation.

Observed negatives:

- The TDD fixture initially failed with TS2724 because the requested exhaustive type did not exist. With it implemented, removing the fixture's expected-error directive failed with TS2741 because `temporaryCommand` was absent from the normalizer record.
- Adding `temporaryCommand` to the real production structural definitions without a normalizer failed core typecheck with TS2741 at `command-normalizers.ts`'s production record. The existing structural scope map also failed, independently confirming the fault reached the real definition graph.
- Moving the 201-command cap into the mounted project handler before `parsedBatch` failed the existing production-path case with received `too_many_commands` instead of `invalid_actual`, both at index 200 and kind `setActual`. Only after observing that output was the production `Proof:` comment added.

Restored evidence: direct core build typecheck exited 0; the mounted cap case passed alone with six expectations; the complete normalizer plus mounted file run passed 15 tests and 78 expectations. The uncached contracts/core/be-01 test/lint/typecheck gate passed all nine targets in 1m27s. Its first run correctly found one fixture-only unused-name lint issue after eight targets passed; the repository's `_` convention fixed that issue and the entire uncached gate was rerun green.

## Task 2.3 continuation

Task 2.3 moves all 37 service handlers from `PlanCommandRunner.applyAll` into the kind-indexed `bindCommands(graph)` record. `CommandFor<K>` and `AppliedFor<K>` use the design's intersections, and the generic `applyCommand` dispatch preserves that correlation without a cast. `CommandContext` carries actor ID, nullable project ID, index, the batch's shared ref map, mint/lookup rules and service-refusal translation. Project admission reads each structural definition's `scope`. The runner now retains only batch orchestration: cap, ordered iteration, collection, calendar preflight, unit-of-work decision, journal recording and post-commit publication.

Observed production-path negatives:

- The persisted targeting fixture supplies `setEstimate` both a valid earlier raw ID and the ref minted by the preceding create. Making the binding ignore the ref kept the batch successful but wrote the estimate against the earlier row; the exact store assertion received that prior ID instead of the row independently found by name.
- Removing the definition-scope admission from `CommandContext` let a directory batch commit both a tag and an `unfreezeWorkItem` against a real plan row; the sharpened test received `ok: true` instead of `project_required` at index 1.
- Deferring create's duplicate-ref check until minting let its deliberately invalid parent reach the service and returned `not_found` instead of `duplicate_ref` at index 1.
- Adding a be-01 repository import to the new production binding file made the core service-boundary test report `@nx/enforce-module-boundaries`; the restored focused boundary test passed.

Restored evidence: the three ordering cases passed with nine expectations; the real-SQLite runner plus core scope/composition/boundary set passed 34 tests and 152 expectations; direct core build typecheck exited 0. The final formatted-tree contracts/core/be-01 test/lint/typecheck gate passed all nine targets uncached in 1m30s. OpenSpec validation passed all 75 items and apply instructions reported 6 of 10 tasks complete.

## Task 2.4 continuation

Task 2.4 retains the binding contract as executable compiler fixtures. Valid `setEstimate` and `createPerson` handlers establish the plain/entity positive cases. The negative cases independently reject an omitted key, `clearEstimate` input under `setEstimate`, `clearEstimate` output from `setEstimate`, and `createTeam` output from `createPerson`. `applyCommand` needs no cast: its generic discriminator selects the correlated handler and returns `AppliedFor<K>` directly.

Observed negatives:

- Making mapped binding keys optional produced TS2578 at the omitted-`setEstimate` fixture and a possibly-undefined diagnostic at the real dispatch.
- Correlating the production `setEstimate` key to `clearEstimate` input produced TS2578 at the wrong-input fixture.
- Widening every binding output to `Promise<AppliedCommand>` produced TS2578 at both wrong-response fixtures, exactly distinguishing plain and entity response drift.
- Routing the `setEstimate` binding to the `clearEstimate` store operation and invoking the actual SQLite-backed runner made the exact persisted estimate assertion receive `[]`. Restored, it passed with the expected named-row id, step and three-point estimate.

Restored evidence: direct core typecheck and focused fixture lint passed; the store-backed runner oracle passed once restored. The final contracts/core/be-01 test/lint/typecheck gate passed all nine targets uncached in 1m27s. Focused format and diff checks passed, and OpenSpec validation passed all 75 items. The first sandboxed broad attempt is not green evidence: it exposed two misplaced expected-error directives and 17 unrelated local-listener EPERM failures; both were resolved before the complete permitted rerun.

## Task 3.1 continuation

Task 3.1 leaves `commandDefinitions` as the single command-kind assembly. Contracts' `PlanCommandKind` and `PLAN_COMMAND_KINDS` now feed the HTTP refusal enumeration and core parser directly. Core's normalizers use the contracts kind to index their exhaustive mapped record and derive only the normalized `PlanCommand`; the compatibility module retains that application type and the independent batch cap, but no kind vocabulary. The obsolete `EVERY_KIND` and the duplicate 37-entry HTTP `commandKinds` record are deleted. `DIRECTORY_KINDS` had already disappeared when Task 2.3 moved scope admission to each definition.

Observed negative: a runtime `import '@wbs/core'` injected into production `libs/contracts/src/commands/definitions.ts` made `contracts:lint` fail. The direct ESLint output named both `@nx/enforce-module-boundaries` and the real circular chain `contracts -> core -> contracts`, including `command-bindings.ts`, `command-normalizers.ts` and `work-item.routes.ts`. Restored production contains no service or storage dependency.

Restored evidence: the six-file definitions/descriptor/mounted/SQLite runner set passed 45 tests with 279 expectations. Direct contracts + core build typecheck passed. The final contracts/core/be-01 test/lint/typecheck gate passed all nine targets uncached in 1m31s. Task 2.5 was intentionally left for its separately assigned slice below.

## Task 2.5 continuation

Task 2.5 collapses only the compatible tag, work-item-type and service create/patch/delete mechanics. Three generic helpers preserve duplicate-ref admission, minted IDs, ID/ref lookup, refusal translation, cascade defaults and entity response shapes; each of the nine bindings still supplies its own typed directory service operation and literal command kind. The team and person branches remain explicit because their ownership and membership contracts are not compatible with the named-vocabulary triple.

Observed production-path negative: the mounted real-SQLite test sends `createWorkItemType` through `/api/directory/commands` and reads the work-item-type and tag stores independently. Routing that binding to `DirectoryService.addTag` retained an HTTP 200 but failed the work-item-type store assertion with `Expected: ["Incident"] · Received: []`. Restored production writes the name only to the work-item-type vocabulary.

Restored evidence: the five focused mounted directory and real-SQLite rollback/atomicity cases passed with 18 expectations. The broader five-file command runner/controller set passed 137 tests with 580 expectations, and direct core typecheck passed. The contracts/core/be-01 test/lint/typecheck gate passed all nine targets uncached in 1m28s. Focused format and diff checks passed, OpenSpec validation passed all 75 items, and apply instructions report 9 of 10 tasks complete.

The first sandboxed Nx attempt exited 0 after socket-denial warnings without listing or running targets, so it is excluded from evidence. The permitted rerun produced the nine-target output recorded above. Task 3.2's full workspace/h2puni gate remains pending; no behavior mismatch was found in this slice.

## Task 3.2 integration attempt

Astra's Task 2.5 minor is corrected: the verify header no longer says Task 2.5 is pending, and the central failure-proof table now includes Task 2.5's observed wrong-vocabulary mutation.

The exact `bunx nx run-many -t test lint typecheck -p contracts core be-01 fe-01 mcp-01` command completed all 15 targets successfully in 6m33s. Its sole cache hit was `mcp-01:lint`; a separate uncached invocation executed that target successfully in 7.3s. Fresh generated-tool tests passed 36 cases/235 expectations, fresh mounted and SQLite command coverage passed 149 cases/634 expectations, and fe-01's command client passed 52 cases.

The real browser gate used `CI=1 E2E_PORT_SHIFT=1900`, started this checkout's stack on ports 5000/5100/6100, and completed in 17m54s with 340 passed, two failed and 37 skipped. Both failures are existing 1280px toolbar budget pins: optimization cue received 1603.875 against a 1603 ceiling; project settings received 1306.46875 against a 1305.5 ceiling. A focused two-test rerun reproduced both exact figures. This branch has no changes from baseline under fe-01, `package.json`, `bun.lock`, or `nx.json`, so the unrelated browser assertions were not modified and the gate is recorded red.

The h2puni checkout does not know unpushed commit `d0301d6076a86ade8ca9a65dc63dce1f2764c7fa`; its read-only object check failed. The task forbids publishing the branch, and policy denied transferring the private repository history by bundle without explicit approval. No alternate transfer was attempted, so the required h2puni gate is unavailable.

Whole-workspace format checking and OpenSpec validation passed, the latter for 75/75 items. Verification maps all three delta requirements and seven scenarios to passing focused evidence, and the implementation remains coherent with the design. Completeness is 9/10: Task 3.2 stays unchecked, and archive readiness is blocked on an available exact-SHA h2puni gate plus a green or explicitly adjudicated browser gate. The full workspace build/test/lint/typecheck targets and solver image smoke were not run locally because repository guidance requires the locked h2puni wrapper; no archive command was run. No production code changed in this final attempt.
