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

## Deferred verification

Sections 3–4, the full workspace/browser gate, image builds, migration transition probes,
production dry-run, publication and archive remain intentionally open. No path move is part
of this preflight branch.
