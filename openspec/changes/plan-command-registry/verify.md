# Verification Report

**Change**: `plan-command-registry`
**Scope**: Tasks 1.1–3.1 complete; Task 3.2 still requires its exact-SHA h2puni gate
**Latest local verification**: 2026-09-12; see the final local integration section below
**Original baseline**: `6a47a7220109484bae8f86fe03c35dc570fa1845`
**Integrated runtime tree**: `822c843c57be7b536750392f1016fe253a2df13b`, including main `a5088fdf98ed23d0d8b79dd26c6def1ba8e9615f`

## Current path map

| Design responsibility          | Current production path                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural command declaration | `libs/contracts/src/commands/definitions.ts` (`commandDefinitions`); `libs/contracts/src/http/plan-command-shapes.ts` composes `planCommandSchema` and `planCommandsBody`                                                        |
| HTTP endpoint declaration      | `libs/contracts/src/http/work-item-shapes.ts` (`applyProjectCommands`, `applyDirectoryCommands`)                                                                                                                                 |
| Backend binder                 | `libs/core/src/http/work-item.routes.ts` (`workItemRoutes` binds both command endpoint shapes); `apps/be-01/src/app.ts` mounts those bindings through `apps/be-01/src/http/elysia/mount.ts`                                      |
| Semantic parser                | `libs/core/src/http/work-item.routes.ts` (`parseBatch` → `parseCommand`) delegates pure command semantics to `libs/core/src/service/command-normalizers.ts`                                                                      |
| Normalized command vocabulary  | `libs/core/src/service/command-normalizers.ts` (`commandNormalizers`, inferred `PlanCommand`) consumes the contracts-owned `PlanCommandKind`; `plan-command.ts` retains only that application type and the independent batch cap |
| Route-to-runner use case       | `libs/core/src/use-cases/run-command-batch.ts`                                                                                                                                                                                   |
| Bindings and runner            | `libs/core/src/service/command-bindings.ts` owns handlers/context/refs/scope admission; `plan-commands.ts` owns cap, ordered iteration, transaction, collection and publication                                                  |
| Historical be-01 paths         | `apps/be-01/src/controller/work-item.routes.ts`, `apps/be-01/src/service/plan-command.ts` and `apps/be-01/src/service/plan-commands.ts` are compatibility re-exports from core                                                   |

## Baseline correction

The design was written against `339708fa` with 36 kinds. Commit `521ef54f` added the already-shipped `arrangeBySchedule` command on 2026-09-11. The current independent fixture therefore pins 37 literal kinds. It compares its handwritten set with the production structural descriptor and separately checks branch cardinality, so a missing arm and a duplicate arm cannot preserve a false green.

## Task 1.2 registry ownership

`libs/contracts/src/commands/definitions.ts` now owns the 37 unchanged ArkType structural arms, descriptions and project/directory scopes. `defineCommand` binds each declared key to its schema's literal discriminator. `PlanCommandWire`, `PlanCommandKind` and the readonly `PLAN_COMMAND_KINDS` derive from that object. The HTTP shape composes the same strict standalone and batch schemas from those definitions, and refusal context imports the derived kind as a type only. Semantic normalization and runner dispatch remain untouched for later slices.

## Failure proofs

| Check                                                                                                               | Fault injected on production path                                                                  | Observed RED                                                                                                                                                              | Restored green                                                               |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Independent current command-kind set (`libs/contracts/src/commands/definitions.test.ts`)                            | Deleted the `clearMeasure` arm from `libs/contracts/src/http/plan-command-shapes.ts`               | Set equality failed: expected contained `clearMeasure`; received omitted it                                                                                               | Targeted run: 12 pass, 0 fail across the fixture and mounted work-item tests |
| Mounted priority absent/null and assignee default characterization (`apps/be-01/src/http/elysia/work-item.test.ts`) | Changed `parseKind(createWorkItem)` to default absent priority to `null`                           | `toHaveBeenCalledWith` failed because the first received create gained `"priority": null`                                                                                 | Targeted run: 12 pass, 0 fail                                                |
| Mounted exactly-201 semantic-before-cap precedence (`apps/be-01/src/http/elysia/work-item.test.ts`)                 | Returned the cap refusal in the bound project handler before `parsedBatch`                         | Expected `invalid_actual`; received `too_many_commands`, both at index 200/kind `setActual`                                                                               | Targeted run: 12 pass, 0 fail                                                |
| Definition key/discriminator agreement (`definitions.test.ts`)                                                      | Renamed the production `createWorkItem` registry key to `createWorkItemWrong`                      | Expected `createWorkItemWrong`; received schema discriminator `createWorkItem`                                                                                            | Focused contracts run: 7 pass, 0 fail                                        |
| `defineCommand` compile correlation                                                                                 | Removed `MatchingKind` from the production helper parameter                                        | Contracts spec compile failed only with TS2578 at the `setMeasure`/`clearMeasure` fixture                                                                                 | `bunx tsc --noEmit -p libs/contracts/tsconfig.spec.json`: exit 0             |
| Generated MCP input owns the independent kind oracle                                                                | Removed the production `clearMeasure` definition                                                   | Generated commands tool set equality failed with `clearMeasure` omitted                                                                                                   | Focused generated-tool run: 1 pass, 0 fail                                   |
| Generated MCP kind multiplicity                                                                                     | Replaced `clearMeasure`'s production discriminator with `createTeam`, retaining 37 structural arms | Per-kind counts failed with `clearMeasure: 0` and `createTeam: 2`                                                                                                         | Focused generator run: 2 pass, 0 fail                                        |
| `createWorkItem` descriptor prose before and after MCP conversion                                                   | Emptied only the production `createWorkItem` description                                           | Direct descriptor expected the prior prose but received `""`; generated tool expected length >10 but received 0                                                           | Direct shape: 5 pass; focused generator: 2 pass                              |
| Mounted absent-priority middle-band behavior (`work-item.test.ts`)                                                  | Defaulted absent priority to `null` in the production `createWorkItem` normalizer                  | Persisted row assertion failed with `Expected: 47`, `Received: null`                                                                                                      | Focused Task 2.1 run: 3 pass, 0 fail                                         |
| Extracted normalizer remains inside the core boundary (`service-boundaries.test.ts`)                                | Imported be-01's repository by relative path from production `command-normalizers.ts`              | Boundary assertion received `@nx/enforce-module-boundaries`: projects cannot be imported by relative path                                                                 | Focused boundary and mounted run: 15 pass, 0 fail                            |
| Mounted within-command semantic refusal precedence (`work-item.test.ts`)                                            | Used the extracted branch-local evaluation order without the old eager target/ref validation       | Five-case aggregate received `parentRef_must_be_an_id` twice, `expected_object`, `parentRef_must_be_an_id`, and bare `invalid_body` instead of the prior indexed refusals | Focused mounted case: 1 pass, 0 fail                                         |
| Structural-definition/normalizer completeness (`command-normalizers.ts`)                                            | Added production `temporaryCommand` definition without a normalizer entry                          | Core typecheck failed with TS2741 at the normalizer record: property `temporaryCommand` was missing                                                                       | Restored core typecheck: exit 0                                              |
| Created-ref target resolution (`plan-commands.db.test.ts`)                                                          | Made `setEstimate` use a valid previous raw ID instead of its competing minted ref                 | Stored estimate carried the previous row's ID instead of the independently found `Named by the store` row's ID                                                            | Focused binding case: 1 pass, 0 fail                                         |
| Registry-derived project admission (`plan-commands.db.test.ts`)                                                     | Removed the definition-scope check from `CommandContext`                                           | Directory batch returned `ok: true`, committed its tag and unfreeze, instead of `project_required` at index 1/kind `unfreezeWorkItem`                                     | Focused ordering run: 3 pass, 0 fail                                         |
| Duplicate-ref-before-write ordering (`plan-commands.db.test.ts`)                                                    | Deferred `createWorkItem` duplicate detection until after its service write                        | The deliberately invalid parent reached the service first and returned `not_found` instead of `duplicate_ref` at index 1                                                  | Focused ordering run: 3 pass, 0 fail                                         |
| Extracted bindings remain inside the core boundary (`service-boundaries.test.ts`)                                   | Imported be-01's repository from production `command-bindings.ts`                                  | Boundary assertion received `@nx/enforce-module-boundaries`: projects cannot be imported by relative path                                                                 | Focused boundary run: 1 pass, 0 fail                                         |
| Complete binding record (`command-bindings.test.ts`)                                                                | Made every production binding key optional                                                         | Fixture failed with TS2578 at the omitted-`setEstimate` expected error; dispatch also reported its possibly-undefined binding                                             | Restored core typecheck: exit 0                                              |
| Binding input correlation (`command-bindings.test.ts`)                                                              | Correlated production `setEstimate` to `clearEstimate` input                                       | Wrong-input fixture failed with TS2578                                                                                                                                    | Restored core typecheck: exit 0                                              |
| Binding output correlation (`command-bindings.test.ts`)                                                             | Widened production binding output from `Promise<AppliedFor<K>>` to `Promise<AppliedCommand>`       | Both wrong-response fixtures failed with TS2578 (`setEstimate` returning `clearEstimate`; `createPerson` returning `createTeam`)                                          | Restored core typecheck: exit 0                                              |
| Discriminator-indexed runtime dispatch (`plan-commands.db.test.ts`)                                                 | Bound `setEstimate` to the `clearEstimate` store operation                                         | Actual runner committed but the independently selected named row had no estimate: expected one exact persisted estimate, received `[]`                                    | Focused store-backed run: 1 pass, 0 fail                                     |
| Named-directory binding routes to its own vocabulary (`directory.controller.db.test.ts`)                            | Routed `createWorkItemType` through `DirectoryService.addTag`                                      | Mounted endpoint returned 200, but the real work-item-type store expected `["Incident"]` and received `[]`                                                                | Focused mounted directory run: 1 pass, 0 fail                                |
| Contracts remain inside the domain ring (`contracts:lint`)                                                          | Added runtime `import '@wbs/core'` to production `commands/definitions.ts`                         | ESLint reported `@nx/enforce-module-boundaries`: circular `contracts -> core -> contracts`; the direct file run also named the full production chain                      | Restored uncached `contracts:lint`: exit 0                                   |

The pre-existing mounted malformed nested-extra and semantic-invalid-value controls remain in the same test file and passed in both the targeted run and the project baseline.

## Exact Task 1.1 baseline

Command:

```sh
bunx nx run-many -t test typecheck -p contracts core be-01 mcp-01
```

Final result on the formatted tree: exit 0; Nx reported all eight `test`/`typecheck` targets successful for `contracts`, `core`, `be-01` and `mcp-01`. Four targets were cache hits; both tests and typechecks for `contracts` and `be-01` executed, with `be-01:test` on the 1m20s critical path. An earlier run labelled `contracts:test` flaky because its first attempt in the dependency-less worktree could not find `node_modules/.bin/tsc`; after `bun install --frozen-lockfile` reported 1,565 installs checked and no lockfile changes, both exact reruns passed.

The first sandboxed invocation emitted only Nx Unix-socket permission warnings and no target results, so it is not counted as evidence. The successful command was run with Unix-socket permission.

## Task 1.2 verification

| Command                                                                                                                                                                                                                                                                       | Result                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bun test libs/contracts/src/commands/definitions.test.ts libs/contracts/src/http/plan-command-shapes.test.ts`                                                                                                                                                                | 7 pass, 0 fail, 114 expectations                                                                           |
| `bun test apps/mcp-01/src/openapi-tools.test.ts --test-name-pattern 'describes every command kind'`                                                                                                                                                                           | 1 pass, 0 fail, 76 expectations                                                                            |
| `bun test libs/contracts/src/commands/definitions.test.ts apps/be-01/src/http/elysia/work-item.test.ts`                                                                                                                                                                       | 13 pass, 0 fail, 109 expectations; mounted malformed/absent/null/semantic/201-precedence controls retained |
| `bunx nx run-many -t test lint typecheck -p contracts core be-01 mcp-01`                                                                                                                                                                                                      | all 12 targets successful; 3 cache hits, `be-01:test` executed on the 1m22s critical path                  |
| `bunx nx format:check --files=libs/contracts/src/commands/definitions.ts,libs/contracts/src/commands/definitions.test.ts,libs/contracts/src/http/plan-command-shapes.ts,libs/contracts/src/http/refusal.ts,libs/contracts/src/index.ts,apps/mcp-01/src/openapi-tools.test.ts` | exit 0                                                                                                     |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                                                                                                                  | 75 items, 75 passed, 0 failed                                                                              |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 instructions apply --change plan-command-registry --json`                                                                                                                                                               | state `ready`; 2 of 10 tasks complete after this checkbox update                                           |

The first broad Task 1.2 gate found import/export ordering in the new fixture and barrel (11 targets green, `contracts:lint` red). ESLint's sorter corrected those two files; the complete command above was then rerun and all 12 targets passed.

## Task 1.3 verification

`plan-command-shapes.test.ts` pins the existing inline nested structural fields and now pins `createWorkItem`'s exact description at the contracts boundary. `shape-document.test.ts` sends the production `httpShapes` through `documentFromShapes` and the real `toolsFromDocument` generator, then checks the same command branch retains its discriminator, optional structural fields, nullable priority descriptor, required list and prose. The generated-document vocabulary check counts every independently enumerated kind, so equal total cardinality cannot hide a missing/duplicate pair.

| Command                                                                                                                                                                            | Result                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `bun test libs/contracts/src/http/plan-command-shapes.test.ts`                                                                                                                     | 5 pass, 0 fail, 75 expectations                             |
| `bun test apps/mcp-01/src/shape-document.test.ts apps/mcp-01/src/openapi-tools.test.ts --test-name-pattern 'carries production command descriptors\|describes every command kind'` | 2 pass, 0 fail, 79 expectations                             |
| `bunx nx run-many -t test lint typecheck -p contracts mcp-01`                                                                                                                      | all 6 targets successful, 0 cache hits, 10.8s critical path |

## Task 2.1 verification

Pure command semantics now live in `libs/core/src/service/command-normalizers.ts`. The literal `commandNormalizers` record preserves all 37 current branches, and `PlanCommand` is the union of its return types rather than a handwritten second declaration. The HTTP boundary translates normalizer errors into the existing indexed refusal envelope; the old route-local command switch is gone. `plan-command.ts` remains a compatibility re-export plus the temporary exhaustive kind enumeration for the later registry-convergence slice.

The focused normalizer cases distinguish an omitted create priority from explicit `null` and a number, and retain the intentional missing-assignee default to `null`. The mounted negative configures the project's middle priority band to 47, executes the real command endpoint, and reads the persisted work item rather than inspecting only a parser call.

Review found that extraction had changed within-command refusal precedence. `normalizeCommand` now performs the former eager `workItemId`, `workItemRef`, then `ref` validation before every branch; create and move evaluate their base fields in the original order before their placement refs. The mounted five-case collision test preserves exact error/index/kind responses, including a structurally rejected field on `freezeProject`. A read-only differential loaded the pre-extraction parser from `e8ccef3d^` and compared it with the production normalizer for two successful variants of each independently listed kind: all 74 values and all 37 discriminators matched.

| Command                                                                                                                                                                                                                                                            | Result                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `bun test libs/core/src/service/command-normalizers.test.ts apps/be-01/src/http/elysia/work-item.test.ts -t 'preserves priority absence null and number\|defaults missing assignee to null\|mounted create without priority uses the project middle-band default'` | 3 pass, 0 fail, 7 expectations                                                      |
| `bun test libs/core/src/service/command-normalizers.test.ts apps/be-01/src/http/elysia/work-item.test.ts libs/core/src/service/service-boundaries.test.ts`                                                                                                         | 15 pass, 0 fail, 111 expectations                                                   |
| `bunx nx run-many -t test lint typecheck -p core be-01 --skip-nx-cache`                                                                                                                                                                                            | all 6 targets successful, 0 cache hits, 1m23s                                       |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                                                                                                       | 75 items, 75 passed, 0 failed                                                       |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 instructions apply --change plan-command-registry --json`                                                                                                                                                    | state `ready`; 4 of 10 tasks complete                                               |
| all-37 pre-extraction/current normalization differential (read-only Bun probe)                                                                                                                                                                                     | 74 values matched across 37 independent kinds; every returned discriminator matched |
| review-correction `bunx nx run-many -t test lint typecheck -p core be-01 --skip-nx-cache`                                                                                                                                                                          | all 6 targets successful, 0 cache hits, 1m23s on the corrected tree                 |

## Task 2.2 verification

`CommandNormalizerRecord` maps every structural definition to a function accepting that definition's inferred wire value and returning the same literal discriminator. The production `commandNormalizers` literal now satisfies that record while retaining its broad runtime parameters, so semantic-invalid mounted inputs still reach the existing field parsers and refusal translation. `PlanCommand` remains inferred from the concrete normalizer returns.

The compile fixture extends the real definitions with `temporaryCommand` but intentionally leaves the normalizer record unchanged. Its first TDD run failed because `CommandNormalizerRecord` did not exist; after implementation, removing the expected-error directive exposed TS2741 at the fixture record. The stronger production mutation added the same definition to `commandDefinitions` and independently produced TS2741 at the production normalizer record. The mounted cap mutation was observed before its production `Proof:` comment: returning admission from the handler before `parsedBatch` changed the last command's exact `{ error: 'invalid_actual', at: 200, kind: 'setActual' }` refusal to `too_many_commands` at the same index and kind.

| Command                                                                                                         | Result                                                        |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `bunx tsc --build --force libs/core/tsconfig.json`                                                              | exit 0; compile-negative fixture consumed its expected TS2741 |
| focused mounted index-200 test                                                                                  | 1 pass, 0 fail, 6 expectations                                |
| `bun test libs/core/src/service/command-normalizers.test.ts apps/be-01/src/http/elysia/work-item.test.ts`       | 15 pass, 0 fail, 78 expectations                              |
| `bunx nx run-many -t test lint typecheck -p contracts core be-01 --skip-nx-cache`                               | all 9 targets successful, 0 cache hits, 1m27s                 |
| focused six-file `nx format:check` and `git diff --check`                                                       | exit 0                                                        |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                    | 75 items, 75 passed, 0 failed                                 |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 instructions apply --change plan-command-registry --json` | state `ready`; 5 of 10 tasks complete                         |

The first broad gate completed eight targets successfully and found only the compile fixture's type-only local lacking the repository's `_` prefix. Renaming it made focused core lint green; the complete nine-target command was then rerun uncached and passed.

## Task 2.3 verification

`command-bindings.ts` now owns `CommandFor<K>`, `AppliedFor<K>`, the kind-indexed `CommandBindings` map and all 37 service handlers. `CommandContext` owns actor/project/index, definition-scope admission, shared batch refs, minting and service-refusal translation. `bindCommands(graph)` closes each handler over the admitted batch graph; the runner retains the command cap, iteration, collector, calendar preflight, unit of work, journal recording and post-commit publication. Its dispatch is a generic discriminator-indexed call with no cast.

The store-backed test creates an earlier row, then sends `setEstimate` with both that raw ID and the ref minted by the immediately preceding create. The row under test is found independently by its stored name, and its exact stored step/three-point estimate is asserted. Under the named fault the batch still committed, but the estimate row carried the earlier ID, so the assertion failed in the persistence window rather than at a mock or handler count. The sharpened scope and duplicate cases likewise force their ordering collisions: a real plan row can be unfrozen from a directory batch if registry admission is absent, and an invalid parent outranks a duplicate ref if the duplicate check moves after the write.

| Command                                                                                                                                                                                    | Result                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| focused create-ref-estimate, directory `project_required`, duplicate-ref ordering run                                                                                                      | 3 pass, 0 fail, 9 expectations                |
| `bun test apps/be-01/src/service/plan-commands.db.test.ts libs/core/src/service/plan-command-scope.test.ts libs/core/src/compose.test.ts libs/core/src/service/service-boundaries.test.ts` | 34 pass, 0 fail, 152 expectations             |
| `bunx tsc --build --force libs/core/tsconfig.json`                                                                                                                                         | exit 0                                        |
| `bunx nx run-many -t test lint typecheck -p contracts core be-01 --skip-nx-cache`                                                                                                          | all 9 targets successful, 0 cache hits, 1m30s |
| focused eight-file `nx format:check` and `git diff --check`                                                                                                                                | exit 0                                        |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                               | 75 items, 75 passed, 0 failed                 |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 instructions apply --change plan-command-registry --json`                                                                            | state `ready`; 6 of 10 tasks complete         |

## Task 2.4 verification

`command-bindings.test.ts` compiles valid plain (`setEstimate`) and entity (`createPerson`) bindings, then retains four independent failures: a missing `setEstimate` key, `clearEstimate` input under `setEstimate`, `clearEstimate` output from `setEstimate`, and `createTeam` output from `createPerson`. The production mapped type remains required and kind-indexed in both directions. The generic dispatch compiles without a cast, so no indexed-dispatch boundary comment was needed.

The required runtime mutation replaced `setEstimate`'s service call with `clearEstimate` while retaining the keyed binding and returned discriminator. The actual SQLite-backed runner committed successfully, but the exact persisted estimate assertion for the independently named row received `[]`; restored production wrote the expected step and three-point estimate.

| Command                                                                                                  | Result                                        |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `bunx tsc --build --force libs/core/tsconfig.json`                                                       | exit 0; all compile-negative directives used  |
| focused store-backed wrong-kind dispatch oracle                                                          | 1 pass, 0 fail, 1 expectation                 |
| `bunx nx run-many -t test lint typecheck -p contracts core be-01 --skip-nx-cache`                        | all 9 targets successful, 0 cache hits, 1m27s |
| focused two-file `nx format:check` and `git diff --check`                                                | exit 0                                        |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                             | 75 items, 75 passed, 0 failed                 |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 instructions apply --change plan-command-registry` | state `ready`; 6 of 10 before checkbox update |

The first broad sandboxed attempt found the fixture directives on wrapped assignment lines and then could not open local listener sockets in 17 unrelated be-01 boot tests. After moving the directives to the actual rejected expressions, direct typecheck and lint passed. The complete uncached gate was rerun with local socket permission and all nine targets passed.

## Task 3.1 verification

`commandDefinitions` is now the only assembly of the full kind vocabulary. Contracts' derived `PlanCommandKind` and `PLAN_COMMAND_KINDS` feed the parser-refusal schema and core command parser directly. The exhaustive normalizer record consumes that shared key type while continuing to derive normalized `PlanCommand` from its return values. The obsolete core `EVERY_KIND` and contracts HTTP `commandKinds` copies are deleted; `DIRECTORY_KINDS` was already removed by Task 2.3's definition-scope admission.

The required production mutation added a runtime core import to `commands/definitions.ts`. The actual contracts lint target failed, and the direct ESLint diagnostic identified `@nx/enforce-module-boundaries` plus the circular `contracts -> core -> contracts` production chain. Restoring the import boundary made the uncached lint target and complete proportional gate green.

| Command                                                                                                                                                                                                                                                                                                     | Result                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `bun test libs/contracts/src/commands/definitions.test.ts libs/contracts/src/http/plan-command-shapes.test.ts apps/be-01/src/http/elysia/work-item.test.ts apps/be-01/src/service/plan-commands.db.test.ts libs/core/src/service/plan-command-scope.test.ts libs/core/src/service/command-bindings.test.ts` | 45 pass, 0 fail, 279 expectations             |
| `bunx tsc --build --force libs/contracts/tsconfig.json libs/core/tsconfig.json`                                                                                                                                                                                                                             | exit 0                                        |
| `bunx nx run-many -t test lint typecheck -p contracts core be-01 --skip-nx-cache`                                                                                                                                                                                                                           | all 9 targets successful, 0 cache hits, 1m31s |

## Task 2.5 verification

The tag, work-item-type and service bindings now share generic create, patch and delete mechanics while each binding retains its own typed service operation and literal response kind. Team and person handlers remain explicit because their ownership, membership, patch and entity contracts are different. Ref admission, ID/ref resolution, refusal translation, cascade defaulting and entity-bearing responses retain their previous order and shape.

The mounted real-SQLite negative sends `createWorkItemType` through `/api/directory/commands`, then reads the work-item-type and tag stores independently. Routing that production binding through `DirectoryService.addTag` still returned HTTP 200 but made the type-store assertion fail with `Expected: ["Incident"] · Received: []`. Restoring the typed operation writes the name only to work-item types. The existing mounted directory batch and real-SQLite rollback/atomicity cases pass unchanged.

| Command                                                                                                                                                                                                                                                                     | Result                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| focused mounted vocabulary, directory route and real-SQLite directory/rollback cases                                                                                                                                                                                        | 5 pass, 0 fail, 18 expectations               |
| `bun test apps/be-01/src/controller/directory.controller.db.test.ts apps/be-01/src/controller/work-item.controller.test.ts apps/be-01/src/service/plan-commands.db.test.ts libs/core/src/service/command-bindings.test.ts libs/core/src/service/plan-command-scope.test.ts` | 137 pass, 0 fail, 580 expectations            |
| `bunx tsc --build --force libs/core/tsconfig.json`                                                                                                                                                                                                                          | exit 0                                        |
| `bunx nx run-many -t test lint typecheck -p contracts core be-01 --skip-nx-cache`                                                                                                                                                                                           | all 9 targets successful, 0 cache hits, 1m28s |
| focused five-file `nx format:check` and `git diff --check`                                                                                                                                                                                                                  | exit 0                                        |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                                                                                                                | 75 items, 75 passed, 0 failed                 |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 instructions apply --change plan-command-registry --json`                                                                                                                                                             | state `ready`; 9 of 10 tasks complete         |

## Task 3.2 integration attempt

The exact five-project test/lint/typecheck command completed all 15 targets successfully. Nx reused one `mcp-01:lint` result; that target was then run separately with `--skip-nx-cache` and completed successfully. Fresh direct runs exercised the generated MCP document/tools, the mounted and real-SQLite command API/runner, and fe-01's command client.

The full browser gate ran with `CI=1` and `E2E_PORT_SHIFT=1900`, which made Playwright start this worktree's own be-01/gw-01/fe-01 stack on ports 5000/5100/6100 rather than reuse another checkout. Its recorded totals were 340 passed, 37 skipped and two failed 1280px toolbar-budget cases. The skips were not all caused by those failures: the rendering-baseline suite declares 36 opt-in experimental cases. The prior raw log is unavailable, so the remaining skip is not classified here. A focused rerun recorded both exact measurements: optimization cue `Expected <= 1603`, `Received 1603.875`; project settings `Expected <= 1305.5`, `Received 1306.46875`. This change has no diff from baseline `6a47a722` under `apps/fe-01`, `package.json`, `bun.lock`, or `nx.json`, but that alone does not establish a passing or failing same-environment baseline. The browser gate remains red evidence, not a pass.

The h2puni build checkout does not contain unpushed implementation commit `d0301d6076a86ade8ca9a65dc63dce1f2764c7fa`. The read-only `git cat-file` check failed with `Not a valid object name`. Publishing the branch is forbidden by task scope, and transferring private repository history by bundle was denied because it lacks explicit authorization; no workaround was attempted. Therefore `bin/h2puni-gate.sh d0301d6076a86ade8ca9a65dc63dce1f2764c7fa` did not run on h2puni.

| Command                                                                                                                                                                                                                                                                 | Result                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bunx nx run-many -t test lint typecheck -p contracts core be-01 fe-01 mcp-01`                                                                                                                                                                                          | all 15 targets successful in 6m33s; 1 cached (`mcp-01:lint`)                        |
| `bunx nx run mcp-01:lint --skip-nx-cache`                                                                                                                                                                                                                               | exit 0; target executed uncached in 7.3s                                            |
| `bun test apps/mcp-01/src/shape-document.test.ts apps/mcp-01/src/openapi-tools.test.ts apps/mcp-01/src/generated-document.test.ts`                                                                                                                                      | 36 pass, 0 fail, 235 expectations                                                   |
| `bun test apps/be-01/src/http/elysia/work-item.test.ts apps/be-01/src/controller/directory.controller.db.test.ts apps/be-01/src/controller/work-item.controller.test.ts apps/be-01/src/service/plan-commands.db.test.ts libs/core/src/service/command-bindings.test.ts` | 149 pass, 0 fail, 634 expectations                                                  |
| `TZ=UTC bunx vitest run src/lib/wbs-api.test.ts --no-file-parallelism --maxWorkers=1` from `apps/fe-01`                                                                                                                                                                 | 52 pass, 0 fail                                                                     |
| `CI=1 E2E_PORT_SHIFT=1900 bun run e2e`                                                                                                                                                                                                                                  | exit 1 in 17m54s; 340 pass, 2 fail, 37 skipped                                      |
| focused Playwright rerun of the two toolbar-budget failures                                                                                                                                                                                                             | exit 1; both failures reproduced with identical measurements                        |
| `bunx nx format:check --all`                                                                                                                                                                                                                                            | exit 0                                                                              |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                                                                                                            | 75 items, 75 passed, 0 failed                                                       |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 instructions apply --change plan-command-registry --json`                                                                                                                                                         | state `ready`; 9 of 10 tasks complete                                               |
| h2puni `bin/h2puni-gate.sh d0301d6076a86ade8ca9a65dc63dce1f2764c7fa`                                                                                                                                                                                                    | unavailable; target SHA absent and no approved publication/private-history transfer |

### OpenSpec verification scorecard

| Dimension    | Status                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completeness | 9/10 tasks complete; Task 3.2 remains unchecked because its required host gate is unavailable and browser gate is red                                                       |
| Correctness  | 3/3 delta requirements mapped to passing definition/binding, behavior-preservation, and generated-MCP evidence; all six named delta scenarios have passing focused coverage |
| Coherence    | Implementation follows the contracts-owned definitions, core-owned normalizers/bindings, cast-free correlated dispatch, and special person/team branch decisions            |

**Critical archive blocker:** complete the exact-SHA h2puni gate after the commit is available there, and obtain a green or explicitly adjudicated full browser gate. OpenSpec artifacts validate, but this change is not archive-ready while Task 3.2 remains unchecked.

The full workspace build/test/lint/typecheck targets and `be-01:solver-image-smoke` were not run locally: `LLM_README.md` requires those checks to run through the locked h2puni wrapper, and the exact SHA could not be made available there. No archive command was run because the change is not archive-ready.

## Pending change verification

- Task 3.2 remains unchecked. The exact five-project and focused integration checks completed as recorded above; the h2puni gate was unavailable and the browser gate was red.
- The optional OpenSpec telemetry flush could not reach `edge.openspec.dev`; status and apply instructions themselves completed successfully via the pinned CLI.

## Resumed integration — 2026-09-12

The branch resumed from `1a61d13c` and merged current origin/main
`a5088fdf98ed23d0d8b79dd26c6def1ba8e9615f` without textual conflicts as
`46dfa705de0ffe2e73b828cc23e61b909a697579`. All commit hooks passed. This is
an integration baseline, not a completed final gate.

The first uncached five-project command passed 13 targets. Backend tests failed on
sandbox-denied `Bun.serve` socket calls; rerunning that target with sockets allowed
passed 1048 tests, skipped the explicitly optional supervisor orphan-process case,
and failed none. The frontend target also failed; its separate streamed rerun
identified one directory keyboard-focus assertion failure among 2652 tests. That
failure is being diagnosed before the final gate is repeated.

| Command at integrated baseline                                                                                 | Observed result                                                              | Retained raw output                                |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `NX_DAEMON=false bunx nx run-many -t test lint typecheck -p contracts core be-01 fe-01 mcp-01 --skip-nx-cache` | Exit 1: 13 targets passed; backend and frontend tests failed                 | `/tmp/command-registry-46dfa705-project-gate.log`  |
| `NX_DAEMON=false bunx nx run be-01:test --skip-nx-cache` with local sockets allowed                            | Exit 0: 1048 pass, 1 explicit skip, 0 fail                                   | `/tmp/command-registry-46dfa705-backend-gate.log`  |
| `NX_DAEMON=false bunx nx run fe-01:test --skip-nx-cache --output-style=stream` with local sockets allowed      | Exit 1: 2651 pass, 1 directory-focus failure; Auckland follow-on did not run | `/tmp/command-registry-46dfa705-frontend-gate.log` |
| `NX_DAEMON=false bunx nx format:check --all`                                                                   | Exit 0                                                                       | `/tmp/command-registry-46dfa705-format.log`        |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                   | Exit 0: 79 entries passed (68 changes, 11 specs)                             | `/tmp/command-registry-46dfa705-openspec.json`     |

Astra's final review requested a P2 repair to correlate normalizer input fields
and kinds with their structural definitions. Task 2.2 is reopened for that
requirement; a complete normalizer record alone did not enforce field correlation.
The review's bounded comparison found no behavioral differences in 3392 parser
probes across all 37 kinds, and both generated batch schemas matched the baseline.
Report: `/tmp/command-registry-astra-review.md`.

Both toolbar-budget failures also reproduced at this integrated baseline. The
browser diagnosis measured Arrange by schedule at 32px plus a 6px gap, whereas
the earlier pin update charged 35px. Excluding that measured control and its gap from the same page
recovered the prior totals: 1268.46875px without the cue and 1565.875px with it.
The corrected pins still require watched negatives and a complete restored gate.

Publication remains unavailable. GitHub's fresh repository metadata identifies
origin as the public `Prosperous-Unification/wbs-tool-v1` repository and the current
account as ADMIN. The complete branch diff passed the plaintext-secrets scanner.
Automatic approval review nevertheless rejected the same branch push twice,
requiring a direct trusted user message approving publication of this exact branch
to that public destination. No push, PR, merge, archive, bundle or alternate
transfer was performed. The exact-SHA h2puni gate remains unrun. Its shared build
checkout had an unrelated tracked edit and must be preserved; an owned gate
checkout will be needed when the branch can be published.

### Integration repairs and focused verification

The normalizers now take each definition's inferred input. Shared and nested readers
retain named-field correlation, and the raw rejected-body classifier still crosses
one documented dispatch boundary before running the existing value checks. The
Astra finding's wrong-kind call and required-field-rename fixtures both produced
TS2578 with the broad inputs; both are consumed after the repair. The core, contracts
and backend `tsc --build --force` commands passed. The focused core suite passed
3 tests, the mounted command suite passed 13, and the 3392 differential parser
comparisons remained identical. Scoped ESLint, Prettier and diff checks passed.
The attempted sandboxed Nx wrappers emitted socket warnings without visible target
execution; their exit codes are not used as typecheck evidence. Report:
`/tmp/command-registry-normalizer-fix-report.md`.

The directory failure was reproduced over 50 repetitions. Its assertion read focus
between the removal redraw and the effect that runs after the controls become live.
The test now waits for both removal and focus handoff; production behavior is unchanged.
Fifty restored repetitions and all 47 directory tests passed. Dropping only `busy`
from the dependency list did not fail the focused run, so that experiment is not a
proof; removing the actual production focus call failed at the intended assertion.
Report: `/tmp/command-registry-directory-focus-report.md`.

The toolbar pins now charge the measured 38px control-plus-gap cost: 1306.5px for
settings and 1604px with the cue. The 2px tolerance, control counts and two-row
assertions are unchanged. Both focused cases passed after removing the injected
faults. Vite logged WebSocket proxy EPIPE warnings during these cases; this focused
geometry run does not establish their cause or certify the full transport behavior.
Report: `/tmp/command-registry-browser-report.md`.

| Repaired check                                 | Fault / original failure                                                        | Observed failure                                                        | Restored evidence                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Normalizer kind and required field correlation | Broad `Record<string, unknown>` inputs with the two new expected-error fixtures | Core spec compile reported TS2578 at both fixtures                      | Contracts/core/backend direct typechecks passed; 3392 parser comparisons unchanged |
| Directory keyboard focus handoff               | Removed production `node.focus()`                                               | Retrying focus assertion timed out with BODY instead of the Design chip | 50 repetitions and all 47 directory tests passed; production source restored       |
| Settings toolbar budget                        | Added one labelled `Squad` button                                               | Expected <=1308.5; received 1371.171875                                 | Both focused browser cases passed after restoration                                |
| Cue toolbar budget                             | Widened the production cue from 11.5rem to 44rem                                | Expected <=1606; received 2123.875                                      | Both focused browser cases passed after restoration                                |

The following final local integration section supersedes the pending local-gate
status above; the exact-SHA h2puni gate remains unrun.

## Final local integration — 2026-09-12

The implementation and repair tree was committed with hooks enabled as
`822c843c57be7b536750392f1016fe253a2df13b`. It remained clean and unchanged
through both complete local runs below. These results apply to that runtime tree.
The subsequent handoff changes move the existing ladder parser JSDoc onto its
overload and update these artifacts; they introduce no runtime behavior change.

| Command / review                                                                                                                                                | Observed result                                                                                                          | Retained output                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `NX_DAEMON=false bunx nx run-many -t test lint typecheck -p contracts core be-01 fe-01 mcp-01 --skip-nx-cache --output-style=stream` with local sockets allowed | Exit 0; all 15 targets passed uncached in 6m47s                                                                          | `/tmp/command-registry-822c843c-project-gate.log`                                       |
| `CI=1 E2E_PORT_SHIFT=1900 bun run e2e`                                                                                                                          | Exit 0; 345 passed, 37 skipped, 0 failed in 18.0m; one Chromium worker, zero retries, no Nx cache hit                    | `/tmp/command-registry-browser-full.log`                                                |
| `NX_DAEMON=false bunx nx format:check --all`                                                                                                                    | Exit 0                                                                                                                   | `/tmp/command-registry-822c843c-format.log`                                             |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                    | Exit 0; 79/79 entries passed (68 changes, 11 specs)                                                                      | `/tmp/command-registry-822c843c-openspec.json`                                          |
| Astra scoped repair review and final xhigh epic review of `a5088fdf..822c843c`                                                                                  | Original P2 addressed; no Critical or Important findings. The minor ladder JSDoc attachment is corrected in this handoff | `/tmp/command-registry-astra-rereview.md`, `/tmp/command-registry-astra-epic-review.md` |

The five-project test targets passed contracts 380, core 412, MCP 114, backend
1048, and frontend 2652 plus three Auckland cases. The backend's one explicit
supervisor orphan-process skip remains unverified by this local run; the required
host solver-image gate has not run.

The browser stack used its own ports 5000/5100/6100 under CI mode, with server
reuse disabled. Both repaired toolbar cases passed in full context. Its 37 skips
are 36 opt-in rendering-baseline experiment cases and the existing Gantt
`test.fixme('dragging up moves the boundary up')` at `gantt.spec.ts:2720`.
That fixme's current behavior was not established by this run. Vite continued
logging WebSocket proxy EPIPE and ECONNRESET warnings during cases; their cause remains unverified.
Report: `/tmp/command-registry-browser-full-report.md`.

Astra's fresh bounded probes found no differences in 1776 dispatcher comparisons
and 3392 parser comparisons across the 37 kinds. The dispatcher probe uses stub
services, so it does not replace the persisted transaction tests. The parser probe
uses the current capacity/ladder helpers, which were also reviewed directly.
The focused type probe produced no diagnostics, and actual MCP generation retained
33 tools with both 37-branch batches and baseline-equal inputs. These are bounded
checks, not a claim of exhaustive behavioral equivalence.

Task 2.2 is accepted again; the change is 9/10 complete. Task 3.2 remains unchecked:
the exact-SHA locked h2puni workspace/build gate, including
`be-01:solver-image-smoke`, is still required. No host run, remote CI pass, PR,
merge or archive is claimed.

The host is prepared for that gate in an owned checkout at
`/home/puni1/gates/codex-command-registry-20260912`. It was cloned from public
main `a5088fdf`; `bun install --frozen-lockfile` passed and left tracked files
clean. Its login shell reports Bun 1.4.2 and Node 24.18.1; shellcheck and Docker
commands are present. The unrelated dirty `/home/puni1/wbs-build` checkout was
preserved. No unpublished candidate content was transferred. Once direct publication
approval is provided, fetch the candidate into the owned checkout and pass its
final SHA to `bin/h2puni-gate.sh`; the wrapper must perform the checkout under
the canonical heavy lock. Publication remains blocked by the two automatic-review
rejections described above.

## Current-main integration and host gate — 2026-09-13

The branch was published after direct user authorization, then merged with
`origin/main` at `029f65c7`. The semantic conflict resolution retained the
central registry and added main's `setStatus` command and fact-date patch fields
to its definition, normalizer and binding. The first clean host run at
`4e31db5543899741a120f3cf68b91979a55bf24d` rejected two real integration faults:
the independent kind fixture still named 37 commands, and the in-memory harness
accepted a clock override but constructed the service with `testClock`. The
former failed `contracts:test` at the exact set comparison; the latter failed
`core:test` with expected `2026-09-12`, received `2026-09-13`. The same run passed
99 other workspace tasks. Both faults were repaired in `1decec9f` and their exact
focused tests passed before publication.

The canonical target-version wrapper then ran against exact commit
`1decec9f251ec6fa13db178cc1c3515da5a05b2a` in the owned clean checkout
`/home/puni1/wbs-gate-command-registry-6e9b1b9c`. Its uncached workspace phase
reported all 101 test, lint, typecheck and build tasks successful in 10m42s. The
wrapper continued through the tool-wiki test/typecheck/build and source-lint
phase and the solver-image smoke. After those processes ended, the wrapper's
checkout remained detached, clean and pinned at the candidate SHA. This is the
wrapper's successful state: its guarded EXIT path restores the pre-gate commit
on any nonzero step.

The SSH transport did not close after the remote wrapper process ended because a
completed host test retained its channel; it was interrupted locally and
therefore has local exit 255. That transport exit is not claimed as gate evidence.
The wrapper's completed process sequence and preserved candidate checkout are the
evidence. No check was skipped. The external tool-wiki activation probe reported
inactive because no activation marker is provisioned; the required repository
policy checks still ran.

| Check                                                                          | Observed result                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Forced contracts/core/SQLite/backend/MCP TypeScript build after semantic merge | Exit 0                                                                                      |
| Focused command, mounted HTTP, generated MCP and write-coordinator suites      | 116 pass, 0 fail, 730 assertions                                                            |
| Gate-failure reproductions                                                     | Independent kind pin and injected-clock status day both failed at their intended assertions |
| Restored focused checks                                                        | 2 pass, 0 fail                                                                              |
| Scoped ESLint and Prettier                                                     | Exit 0                                                                                      |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`   | 81/81 entries passed                                                                        |
| Exact-SHA h2puni workspace phase                                               | 101/101 tasks passed uncached                                                               |
| Exact-SHA h2puni remaining phases                                              | Tool-wiki checks and solver-image smoke completed; wrapper retained candidate SHA           |
