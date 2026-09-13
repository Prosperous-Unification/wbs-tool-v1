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

## Deferred verification

Sections 3–4, the full workspace/browser gate, image builds, migration transition probes,
production dry-run, publication and archive remain intentionally open. No path move is part
of this preflight branch.
