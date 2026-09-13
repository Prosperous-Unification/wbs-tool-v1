# Verification Report

**Change**: `repo-namespacing`
**Implementation base**: `b93c0b5f4d69446abde02fe8ce2b71a65de2e6cd`
**Verified at**: 2026-09-13
**Scope in this report**: Tasks 1.1–1.2 and 2.1–2.2 only

## Preflight inventory

[`preflight-inventory.md`](preflight-inventory.md) records the 31 recursively discovered
projects, all 18 WBS roots and Nx identities from the destination table, the active tracked
path-consumer sweep, AST-classified cross-project reads, every public alias key, the complete
migration path/blob manifest, and deployment identities. The recursive reader and the Nx
graph returned identical `(root, name)` sets; the nested supervisor protocol is a direct
assertion rather than an inferred count.

## Section 1 verification

- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun test src/workspace-projects.test.ts src/workspace-targets.test.ts --test-name-pattern='readProjects|every project says|deploy contract|outside-read syntax'` from `tools/tool-devsync` — 21 passed, 0 failed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p tool-devsync --skip-nx-cache` — both targets passed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx test tool-devsync --skip-nx-cache` with host permissions required by listener and Git fixture tests — 133 passed, 0 failed, 419 expectations.

The first restricted-sandbox baseline reached 121 passes and 10 environmental failures:
three Nx/Git fixture operations could not create their plugin socket or cross-device links,
and seven local listener tests received `EPERM`. The host-permitted owning run above resolved
all ten without code changes. During the first implementation run, the Nx CLI child invoked
through `bunx` exited 0 with empty stdout; direct observation showed the checkout's pinned
`node_modules/.bin/nx` returned the complete JSON graph, so the test now invokes that pinned
executable and treats empty output as malformed.

| Check                                          | Fault injected                                                                       | Production-path observer                                                                | Observed failure                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Recursive project traversal                    | Replaced recursive descent with `continue`                                           | `workspace-projects.test.ts` nested project case                                        | Expected `outer`, `protocol`, and `probe-core`; received `[]`.    |
| Required nested metadata through owning target | Removed `ring:adapter` from `libs/contracts/solver/supervisor-protocol/project.json` | `nx test tool-devsync --skip-nx-cache -- --test-name-pattern='carries exactly one tag'` | The target named the complete nested manifest path and `found 0`. |
| Generated/dependency exclusions                | Removed `.git` from the enumerator's named exclusions                                | `workspace-projects.test.ts` recursive fixture                                          | Received the forbidden project `libs/outer/.git/hidden`.          |
| Directory symlink refusal                      | Retained the prior manifest-only symlink check                                       | `workspace-projects.test.ts` ordinary directory symlink case                            | `readProjects unexpectedly succeeded`.                            |

The stacked source-conformance branch had already consolidated recursive discovery into
`tools/tool-devsync/workspace-projects.mjs`, migrated `sync.test.ts` and
`workspace-targets.test.ts`, and declared the module in tool-devsync's lint and test inputs.
This slice retained that work, added the product/ring-depth fixture and exact Nx root/name
comparison, covered every named excluded directory, and tightened directory-symlink refusal.

## Section 2 verification

The production ESLint configuration now derives one rule per discovered product. A product
may depend on itself or `product:shared`; the shared product may depend only on itself. The
same rules are present in production and both test overrides. The temporary workspace test
invokes its actual Nx lint targets, admitting same-product/shared controls and refusing WBS
imports from probe production, probe tests and shared-product source.

The authorized activation prerequisite adds only `product:wbs` to the 13 manifests listed
in [`preflight-inventory.md`](preflight-inventory.md#section-2-product-axis-activation). A
byte comparison against `7af4b472` after removing that one appended literal reported no
other manifest changes. The pre-move totality oracle sees one `product:wbs` tag on all 18
WBS apps/libraries; the actual Nx dependency graph satisfies every generated product rule.

The namespace validator proves the final app/library shapes, qualified names, product/path
agreement, all three library ring directories and product-neutral infra/adapter tools. It
is intentionally fixture-only in this slice: applying it to the current repository reports
18 expected shape violations because Section 3 owns the coordinated path and Nx-name move.

| Check                       | Fault injected                                                                            | Production-path observer                              | Observed failure                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Generated probe rule        | Removed only `product:probe` from rule generation                                         | Probe workspace's actual Nx lint target               | Forbidden probe production import passed with exit 0.                                                                                  |
| Shared direction            | Added `product:wbs` to the shared rule                                                    | Shared fixture's actual Nx lint target                | Forbidden shared-to-WBS import passed with exit 0.                                                                                     |
| Effective rule placements   | Removed product rules from production, general-test and store-memory-test configs in turn | `nx test tool-devsync` effective ESLint config oracle | Missing rule named `libs/core/src/index.ts`, `libs/core/src/example.test.ts` and `libs/store-memory/src/source.test.ts`, respectively. |
| Actual manifest totality    | Removed `product:wbs` from `libs/contracts/project.json`                                  | Actual recursive project oracle                       | `libs/contracts` carried an empty product-tag array.                                                                                   |
| Actual graph satisfiability | Removed `product:wbs` from `libs/contracts/project.json`                                  | Actual Nx project graph oracle                        | Reported 10 incoming product edges, including all four apps, core and store-sqlite.                                                    |
| Scope/ring/runtime totality | Disabled the common axis guard                                                            | Namespace test through `nx test tool-devsync`         | Absent scope returned no violation.                                                                                                    |
| Product totality            | Disabled the app/library product-count guard                                              | Namespace test through `nx test tool-devsync`         | Absent product returned no violation.                                                                                                  |
| App correlation             | Disabled ring, product/path and qualified-name checks                                     | Namespace test through `nx test tool-devsync`         | Omitted the three expected app violations.                                                                                             |
| Library correlation         | Disabled product/path, ring/directory and qualified-name checks                           | Namespace test through `nx test tool-devsync`         | Omitted the three expected library violations.                                                                                         |
| Directory shapes            | Disabled app and library shape guards                                                     | Namespace test through `nx test tool-devsync`         | Returned derived `undefined` errors instead of both named shape refusals.                                                              |
| Tool neutrality             | Disabled scope, ring and product checks                                                   | Namespace test through `nx test tool-devsync`         | Invalid shared/domain/product tool returned no violations.                                                                             |
| Workspace-root boundary     | Disabled the app/lib/tool prefix check                                                    | Namespace test through `nx test tool-devsync`         | `packages/probe` fell through to an unrelated library-shape error.                                                                     |

Fresh green commands and exact counts are recorded after the restored implementation's final
owning run.

- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx test tool-devsync --skip-nx-cache`
  with host permissions required by listener and Git fixture tests — 145 passed, 0 failed,
  444 expectations.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p tool-devsync --skip-nx-cache`
  — both targets passed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint -p be-01,fe-01,gw-01,mcp-01,auth,config,conformance,contracts,solver-supervisor-protocol,core,domain,observability,realtime,runtime-portable,solver-py,store-memory,store-sqlite,validation --skip-nx-cache --output-style=stream`
  — all 17 declared lint targets passed; Nx explicitly reported `solver-py` has no lint
  target, so its product metadata remains covered by totality and graph tests.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate repo-namespacing --strict --json`
  — 1 passed, 0 failed.
- `git diff --check` — passed.

## Terminal review repairs

The terminal review at `8be56fdaeb86203061ed2a9b0933532b72076874`
found two incomplete preflight boundaries. The root lint default now hashes the generated
policy module and all three recursively discovered manifest trees because
`eslint.config.js` reads both through `readProjects`. A temporary workspace warms the real
Nx lint cache, changes only one of those policy inputs, and requires the next production lint
invocation to execute and observe the cross-product refusal. Each scratch mutation advances
the file timestamp so concurrent test files cannot hide the content change behind Nx's
workspace metadata cache.

`readProjects` now inspects each top-level `apps`, `libs` and `tools` group with `lstat`
before `readdir`; a linked group is refused by its workspace-relative name. Missing and
unreadable groups retain the existing `cannot read directory <group>` failure contract.

The recorded [Nx selector sweep](preflight-inventory.md#nx-selector-sweep) supplements the
path-literal inventory with its two exact search recipes, 27 direct invocation/project-option
matches and 60 target-label matches. It names the selector-only root scripts, supervisor
arguments, CI/gate commands, application build commands, source-level instructions and
oracles that Section 3 must rewrite. Frozen documentation and OpenSpec history were excluded.

| Check                            | Fault injected                                                                  | Production-path observer                                                           | Observed failure                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Policy-module lint cache input   | Omitted `workspace-projects.mjs` from the root lint inputs                      | Third cached `nx lint config` after changing only `productConstraints`             | `1/1` cache hit and exit 0 instead of the three cross-product lint errors.        |
| Manifest-tree lint cache inputs  | Omitted recursive project-manifest inputs                                       | Third cached `nx lint config` after changing only `libs/domain/project.json`       | `1/1` cache hit and exit 0 instead of the cross-product refusal.                  |
| Exact transitive input inventory | Removed only `{workspaceRoot}/apps/**/project.json` from the restored input set | Focused `lint-policy-cache.test.ts` through the owning `tool-devsync:test` target  | Exact-array assertion reported the one missing glob.                              |
| Top-level no-follow contract     | Called the prior production reader with linked apps/libs/tools roots            | Focused `workspace-projects.test.ts` through the owning `tool-devsync:test` target | Three `readProjects unexpectedly succeeded` failures replaced the named refusals. |

Fresh focused evidence after restoring all four checks:

- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx test tool-devsync --skip-nx-cache --output-style=stream -- --test-name-pattern='production lint policy cache inputs|top-level project group'` — 4 passed, 0 failed, 16 expectations; 145 unrelated tests filtered out. The cache cases require both the production Nx miss and the direct named ESLint product-boundary diagnostic.
- The same complete `tool-devsync:test` target in the restricted sandbox — 140 passed, 9 failed, 443 expectations. Seven local-listener cases failed with `EPERM listen`; two clean uninstalled candidate-bundler fixtures failed under restricted Git/scratch operations. All repair cases passed.
- The complete target rerun with the required host permission — 149 passed, 0 failed, 460 expectations in 17.64 seconds (17.8 seconds reported by Nx).
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p tool-devsync --skip-nx-cache --parallel=1 --output-style=stream` — both targets passed.
- The two selector-sweep `rg` commands recorded in `preflight-inventory.md` — exit 0; 27 direct invocation/project-option matches and 60 target-label matches.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate repo-namespacing --strict --json` — 1 passed, 0 failed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx format:check --files=<seven repair files>` — passed after `format:write`; the explicit file list covers `nx.json`, all three changed OpenSpec artifacts, both reader files and the cache test.
- `git diff --check b93c0b5f4d69446abde02fe8ce2b71a65de2e6cd` and `git diff --check 8be56fdaeb86203061ed2a9b0933532b72076874` — both passed, including removal of the reviewed Markdown hard breaks.

The coordinator released the host before the complete target above. Both whitespace commands
were repeated against the repair commit range and passed.

## Section 3.1 namespaced project graph

The nested solver supervisor project moved out of `libs/contracts` before that parent moved.
All four applications and fourteen libraries now use the exact roots and qualified Nx names
from `design.md`; their pre-existing tags remain byte-for-byte identical. The 51 public
TypeScript alias keys are unchanged and point at the mapped roots. Explicit app/library
artifacts follow their namespaced `dist` roots, while deployment identities and tools remain
unchanged. Root package selectors and ESLint file scopes use the qualified graph, including
the existing core-to-memory test-cycle exemption under its two new Nx names.

The actual-inventory namespace oracle first failed on all 18 legacy roots, naming each old
app or library and its required final shape. The restored inventory and Nx graph agree on
all project root/name pairs. The following additional faults were observed and restored:

| Check                     | Fault injected                                                               | Production-path observer                                           | Observed failure                                                         |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Alias roots               | Restored only `@wbs/core` to `./libs/core/src/index.ts`                      | Actual `tsconfig.base.json` oracle                                 | Reported the old root instead of `libs/wbs/application/core`.            |
| Artifact outputs          | Restored only the backend output to `dist/apps/be-01`                        | Actual recursively read manifest oracle                            | Reported the legacy output instead of `dist/apps/wbs/be-01`.             |
| Tag preservation          | Changed only `wbs-realtime` from `runtime:browser` to `runtime:bun`          | Exact actual-manifest oracle                                       | Reported the changed runtime tag.                                        |
| Moved test compilation    | Appended `const movedTypecheckFault: string = 1` to moved `progress.test.ts` | `wbs-domain:typecheck`                                             | Failed at the new path with TS2322; the restored target passed.          |
| Moved config compilation  | Added a number-valued string assignment to moved `drizzle.config.ts`         | `wbs-be-01:typecheck` through `tsconfig.tools.json`                | Failed at the new path with TS2322; the restored target passed.          |
| Core/domain runtime scope | Restored the ESLint file scopes to `libs/core` and `libs/domain`             | Effective-config lint probe at moved core source                   | The Elysia import received no restriction diagnostic.                    |
| Direct SQLite scope       | Restored the ESLint file scopes to `apps/be-01` and `libs/store-sqlite`      | Effective-config probes at moved backend and SQLite adapter source | Both refusals changed from `true` to `false`.                            |
| Ring test-cycle exemption | Restored the exemption's two old Nx names                                    | Effective config at moved core test paths                          | Reported `core`/`store-memory` instead of `wbs-core`/`wbs-store-memory`. |

Fresh restored evidence:

- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p <17 renamed TypeScript projects> --skip-nx-cache --parallel=1 --output-style=stream` — all 17 targets passed in 20.5 seconds; the Python adapter has no TypeScript target.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun test tools/tool-devsync/src/workspace-projects.test.ts tools/tool-devsync/src/namespace-layout.test.ts` — 27 passed, 0 failed, 88 expectations.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun test tools/tool-devsync/src/workspace-targets.test.ts --test-name-pattern 'source conformance target discovery|every typecheck target compiles files'` — 6 passed, 0 failed, 35 expectations.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun test tools/tool-devsync/src/eslint-boundaries.test.ts` — 10 passed, 0 failed, 60 expectations across the moved core, domain, frontend, backend, memory and SQLite paths.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p tool-devsync --skip-nx-cache --parallel=1 --output-style=stream` — both owning static targets passed in 3.9 seconds.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate repo-namespacing --strict --json` — 1 passed, 0 failed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx format:check --files=<Task 3.1 files>` and `git diff --cached --check` — passed across root configuration, every moved project/tsconfig and the focused oracles.

The first owning static run found one test-only readonly tuple mismatch in the new output
oracle. Comparing against a mutable copy retained the exact assertion; the complete lint and
typecheck pair was then rerun and passed as recorded above.

Two later-slice lines were pulled forward mechanically. Source-conformance discovery in
`workspace-targets.test.ts` now expects the qualified memory/SQLite names, moved adapter roots
and moved backend migration input already declared by their Task 3.1 manifests. The single
`.prettierignore` migration-snapshot glob now names `apps/wbs/be-01/drizzle`; without that Task
3.5 line, the required pre-commit format hook attempted to rewrite four generated snapshots
at their moved paths. No Vite, Vitest, Playwright, Docker, development, migration-discovery or
deployment consumer was otherwise changed; their Sections 3.2–3.5 work remains open.

The first commit-hook attempt also exposed two move-wide checks that focused targets do not
exercise. Format rejected four generated snapshots while the ignore still named the old
migration root, and lint exhausted Node's default 4 GiB heap while parsing all staged moved
TypeScript files. With the snapshot glob corrected, an 8 GiB lint heap completed discovery
and named `drizzle.config.ts` plus the deliberately non-compiling historical capture oracle
as absent from the TypeScript project service. `tsconfig.tools.json` now includes the backend
config, while the existing capture-oracle exclusion is preserved as the same exact ESLint
path exemption. The restored backend typecheck passed before the hook rerun.

## Section 3.2 frontend and cross-tree consumers

Vite and Vitest now resolve every frontend alias to the mapped domain, contract or validation
source, and Vite writes to `dist/apps/wbs/fe-01`. The source-run Playwright stack starts all
three applications from `apps/wbs`, while the packaged configuration reads the namespaced
build and Caddy file. The CI browser artifact uploads follow the moved frontend root. The
frontend root-source lint oracle now derives the same namespaced paths declared by both lint
commands.

Every executable cross-tree reader owned by this slice follows the moved roots: the SQLite
migration fixtures, domain README/ADR/style/migration readers, contract compiler and wire
fixtures, Python solver corpus readers, backend source/version/bundle probes, core portable
artifact and service-boundary probe, and conformance Git-root reader. A static resolution
pass found 63 such `new URL(..., import.meta.url)` references and required every target to
exist. Development, restart, image, migration tooling and corpus-hook consumers remain with
Tasks 3.3-3.5.

| Check                    | Fault injected                                                      | Production-path observer                            | Observed failure                                                                                     |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Frontend alias targets   | Restored Vite's workday alias to `../../libs/domain/src/workday.ts` | Actual `wbs-fe-01:build`, cache disabled            | Exit 1; Vite named `UNLOADABLE_DEPENDENCY` from `completion-prompt.tsx`.                             |
| Alias-map correlation    | Left both Vite/Vitest maps on their legacy `../../libs/*` targets   | `vite-config.test.ts`                               | Every shared alias resolved under deleted `apps/libs/*` instead of `libs/wbs/*`.                     |
| Root lint reachability   | Added two deliberate lint errors to moved `vite.config.ts`          | Actual `wbs-fe-01:lint`, cache disabled             | Exit 1; direct diagnostic named both errors at line 295.                                             |
| Root lint input totality | Kept the fault but omitted `vite.config.ts` from both lint commands | Actual lint target plus owning `test:unit` target   | Lint incorrectly passed; the owning target exited 1 and its oracle named the one omitted moved path. |
| Vite output              | Restored `../../dist/apps/fe-01`                                    | `vite-config.test.ts`                               | Received the legacy output instead of `../../../dist/apps/wbs/fe-01`.                                |
| Source Playwright roots  | Removed `wbs` from the server helper                                | `playwright-config.test.ts`                         | Reported all three received roots under `apps/<app>` instead of `apps/wbs/<app>`.                    |
| Packaged Playwright site | Restored `dist/apps/fe-01`                                          | Packaged production config through its focused test | Refused the absent legacy site with `dist/apps/fe-01 holds no index.html`.                           |
| CI browser artifacts     | Restored only `apps/fe-01/test-results/`                            | `pixels-workflow.test.ts`                           | Reported the legacy first upload line instead of the namespaced path.                                |
| Backend Python metadata  | Restored the old relative `libs/solver-py` source path              | `readRuntimeSolverVersion` through its owning test  | Failed with ENOENT at `apps/libs/solver-py/src/wbs_solver/__init__.py`.                              |

Fresh restored evidence:

- `NODE_OPTIONS=--max-old-space-size=8192 NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t build lint typecheck -p wbs-fe-01 --skip-nx-cache --parallel=1 --output-style=stream` — all three targets passed in 41.3 seconds; Vite transformed 911 modules.
- The host-permitted `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run wbs-fe-01:test:unit --skip-nx-cache --output-style=stream` — 32 files and 547 tests passed. The restricted run had previously reached 14/15 focused assertions before its existing nested Bun origin probe received `spawnSync bun EPERM`.
- `TZ=UTC bunx vitest run vite-config.test.ts --config vitest.config.ts --no-file-parallelism --maxWorkers=1` from the frontend root — 18 passed, 0 failed.
- The same focused node command for `playwright-config.test.ts` and `src/test-tiers.test.ts`, excluding only the separately host-proven origin probe — 15 passed, 1 skipped; the complete owning target above proves that probe too.
- `NODE_OPTIONS=--max-old-space-size=8192 NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p wbs-be-01,wbs-core,wbs-conformance,wbs-contracts,wbs-domain,wbs-store-sqlite,tool-git-hooks --skip-nx-cache --parallel=1 --output-style=stream` — all seven targets passed in 9.1 seconds.
- Focused moved readers: 51 domain/contract tests, 35 wire-vocabulary tests, 80 SQLite migration/source tests, 16 backend/core path tests, 7 solver-launcher tests, 1 calendar-marker source-boundary test and 2 host-permitted production-entrypoint bundle tests passed.
- `bun test tools/tool-git-hooks/src/hooks/pixels-workflow.test.ts` — 1 passed, 0 failed, 8 expectations.
- Focused ESLint over the changed frontend configuration/tests and CI workflow oracle — passed.
- The Python fixture path formula directly resolved the namespaced schema and request corpus. The full Python test remains unavailable in this checkout because `python3` has no `jsonschema` installation; Task 3.4 owns solver installation/package consumers.

## Section 3.3 development and sync consumers

Development setup now reads and writes the three managed environments below `apps/wbs`,
while the port preflight resolves the same root and the supervisor selects all four qualified
Nx projects in both modes. The macOS solver environment, package installation and golden
request proof read their mapped adapter and contract roots. Dev deployment and sync use the
moved remote MCP environment without reading or changing a live `.env` during verification.

Restart fingerprints cover every moved application configuration, migration root and
library manifest discovered from the actual project graph. Solver compatibility binds the
moved Python adapter and backend Dockerfile to the image mapping. The two owning test targets
now declare their namespaced external inputs, including recursive application Dockerfiles.

| Check                      | Fault injected                                                              | Production-path observer                     | Observed failure                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Setup environment root     | Restored `seedApp` to `apps/<app>`                                          | Moved-layout setup fixture                   | Threw `MissingEnvExampleError: apps/be-01/.env.example is missing`; the required namespaced diagnostic also failed.        |
| Solver environment/corpus  | Restored the old solver lock and contract fixture roots                     | `solverEnvironment` and `solveGoldenRequest` | Returned the old absolute lock; the golden-request caller then failed with ENOENT before invoking the fake solver.         |
| Development selectors      | Restored the four unqualified project names in `bin/dev.sh`                 | Host `bin/dev.test.sh`                       | Exactly `local solver runs all four tiers` failed with expected `yes`, actual `no`; fake Nx was still invoked.             |
| Restart paths              | Restored the pre-move app/library list                                      | `needsRestart` and actual inventory tests    | First failed on absent `apps/wbs/be-01/drizzle`; moved migration/config changes no longer requested the restart.           |
| Solver compatibility paths | Restored `libs/solver-py` and `apps/be-01/Dockerfile`                       | Real compatibility-object reader fixture     | Threw `fixture has no object id` at its first old-path lookup instead of proving the moved sources compatible.             |
| Remote MCP environment     | Restored `src/apps/mcp-01/.env` at the deployment and sync callers          | Production-script/default-path oracles       | Both exact namespaced-path assertions failed before any live remote environment was read.                                  |
| Solver test cache          | Restored the old solver-lock input, then changed the moved Linux numpy pin  | Actual cached `tool-dev-setup:test` target   | Returned `[local cache]`, exit 0; the moved input reran and exited 1 on `numpy: linux 2.5.3, macos 2.5.2`.                 |
| Dockerfile test cache      | Restored the one-level app Dockerfile input, then changed the moved Bun tag | Actual cached `tool-devsync:test` target     | Returned `[local cache]`, 1/1 hit and exit 0; the recursive input reran and failed on `apps/wbs/be-01/Dockerfile: 1.3.14`. |

Fresh restored evidence:

- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx test tool-devsync --skip-nx-cache --output-style=stream` with host permission — 155 passed, 0 failed across 15 files, 524 expectations.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx test tool-dev-setup --skip-nx-cache --output-style=stream` — 19 passed, 0 failed across 2 files, 36 expectations.
- Host-permitted `bash bin/dev.test.sh` — all 47 checks passed, including actual loopback bind/refusal and all four qualified selectors.
- `NODE_OPTIONS=--max-old-space-size=8192 NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p tool-dev-setup,tool-devsync --skip-nx-cache --parallel=1 --output-style=stream` — all four owning static targets passed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx build tool-devsync --skip-nx-cache --output-style=stream` — the shellcheck build and its four dependencies passed.

Three narrow adjustments outside the named callers were mechanically required for this coherent slice.
`bin/dev-ports.sh` defaults to `apps/wbs` because `bin/dev.sh` invokes that real path without
an override. The tool-devsync Dockerfile input, Bun-pin list and clean-candidate fixture name
the moved backend file so the owning cache and candidate suite can run; no Dockerfile or image
build implementation from Task 3.4 changed. The root-fast-tier test now expects the qualified
backend/frontend names already introduced by Task 3.1. No Task 3.4 image, migration or hook
consumer was otherwise implemented.

## Integration with origin/main before Task 3.4

The Task 3.3 head `2c28c7b4ec2b694192877b9e1aef6557230f37c7` merged current
`origin/main` at `9b13f98e62a7cd880977e348421e992e8c4951a3`; their merge base was
`b84e07131b90f0e9a00fcb697c3a39800fe95a89`. Git reported three location
conflicts and no content conflicts: main's new `lead-word.tsx` and two new solver request
fixtures. Each stage-3 blob was compared with main and retained byte-for-byte at its mapped
`apps/wbs/fe-01` or `libs/wbs/domain/contracts` destination. Main's solver host-image repair
merged with the Task 3.3 restart, compatibility and MCP paths intact. Its changed runbook
sentence was mapped to the same namespaced solver/backend roots.

The resulting top-level `apps` and `libs` directories contain only `.gitkeep` and `wbs`.
The actual Nx graph, tags, artifact outputs and all 51 public alias keys still match the pinned
destination map.

Fresh merge evidence:

- `NODE_OPTIONS=--max-old-space-size=8192 NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p wbs-be-01,wbs-fe-01,wbs-core,wbs-contracts,wbs-domain,tool-devsync,tool-git-hooks --skip-nx-cache --parallel=1 --output-style=stream` — all seven overlapping TypeScript projects passed.
- `bun test --preload ../test/scratch/preload.ts src/workspace-projects.test.ts src/namespace-layout.test.ts` from `tools/tool-devsync` — 27 passed, 0 failed, 88 expectations; this includes the actual graph and alias oracles.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t test -p wbs-core,wbs-contracts,wbs-domain --skip-nx-cache --parallel=1 --output-style=stream` — all three owning targets passed; the core target ran 424 tests.
- Focused incoming scheduler tests at their moved paths — 71 contract tests and 24 domain tests passed. The two changed backend files ran 94 tests; the merged devsync sync/image-runtime files ran 49 tests; the changed agent-trailer hook ran 14 tests.
- Host-permitted `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run wbs-fe-01:test:unit --skip-nx-cache --output-style=stream` — 32 files and 547 tests passed.
- `NODE_OPTIONS=--max-old-space-size=8192 NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx build wbs-fe-01 --skip-nx-cache --output-style=stream` — passed and transformed 912 modules, including the new namespaced component.
- The corresponding seven-project `lint` matrix passed with cache disabled.
- Python syntax compilation passed for the two changed solver tests. The owning Python runtime suite remains unavailable in this checkout: fresh `python3` import failed with `ModuleNotFoundError: No module named 'jsonschema'`, and `.venv-solver` is absent. Task 3.4 still owns solver installation/package consumers.

## Deferred verification

Sections 3.4–4, the full workspace/browser gate, image builds, migration transition probes,
production dry-run, publication and archive remain intentionally open. Sections 3.1–3.3 prove
the coordinated project/configuration move and its frontend, development and sync consumers.
