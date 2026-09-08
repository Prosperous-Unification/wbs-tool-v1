## Context

Preparation inspected tracked source at `339708fa` on 2026-09-08. No build, runtime,
network or gate observation was made. The [ports plan](../../../docs/2026-09-05-ports-and-adapters-plan.md)
D18/D19 and [ADR 0014](../../../docs/adr/0014-ports-live-in-a-framework-free-core-lib.md)
govern this change. The queue's claim that Wave 3 has not started is stale:
`core-lib-extraction` already holds the ring rules, `libs/core` and runtime port types.
Its remaining extraction must finish before this move starts.

## Goals / Non-Goals

Enforce product/ring layout while preserving every source consumer, configured target,
development entrypoint and deployment contract. This is one coordinated rename candidate;
intermediate commits with old consumers of missing paths cannot integrate.

No deployment identity change, second product, database content migration, solver policy
change or revival of the refused repository-barrel split in place. Migration files move
byte-for-byte only here, after the adapter extraction has left their CLI paths intact.

## Decisions

### Exact destination mapping

Apply the following table to the post-extraction base. `name` is an Nx project identity;
directory names retain the existing short suffix. All application/library rows gain exactly
`product:wbs`; existing `scope:` and `runtime:` tags remain unless the extraction explicitly
changed them. Every existing import alias, including subpaths, retains its key and changes
only its target path in `tsconfig.base.json` and frontend resolver configuration.

| Current root                                          | Destination root                               | Nx name                          | Ring / runtime                             |
| ----------------------------------------------------- | ---------------------------------------------- | -------------------------------- | ------------------------------------------ |
| `apps/be-01`                                          | `apps/wbs/be-01`                               | `wbs-be-01`                      | adapter / bun                              |
| `apps/fe-01`                                          | `apps/wbs/fe-01`                               | `wbs-fe-01`                      | adapter / browser                          |
| `apps/gw-01`                                          | `apps/wbs/gw-01`                               | `wbs-gw-01`                      | adapter / bun                              |
| `apps/mcp-01`                                         | `apps/wbs/mcp-01`                              | `wbs-mcp-01`                     | adapter / bun                              |
| `libs/domain`                                         | `libs/wbs/domain/domain`                       | `wbs-domain`                     | domain / isomorphic                        |
| `libs/contracts` except the nested supervisor project | `libs/wbs/domain/contracts`                    | `wbs-contracts`                  | domain / isomorphic                        |
| `libs/validation`                                     | `libs/wbs/domain/validation`                   | `wbs-validation`                 | domain / isomorphic                        |
| `libs/core`                                           | `libs/wbs/application/core`                    | `wbs-core`                       | application / isomorphic                   |
| `libs/conformance` after extraction                   | `libs/wbs/application/conformance`             | `wbs-conformance`                | application / bun                          |
| `libs/store-sqlite` after extraction                  | `libs/wbs/adapters/store-sqlite`               | `wbs-store-sqlite`               | adapter / bun                              |
| `libs/store-memory` after extraction                  | `libs/wbs/adapters/store-memory`               | `wbs-store-memory`               | adapter / isomorphic                       |
| `libs/runtime-portable`                               | `libs/wbs/adapters/runtime-portable`           | `wbs-runtime-portable`           | adapter / isomorphic                       |
| `libs/auth`                                           | `libs/wbs/adapters/auth`                       | `wbs-auth`                       | adapter / bun at inspection                |
| `libs/realtime`                                       | `libs/wbs/adapters/realtime`                   | `wbs-realtime`                   | adapter / browser                          |
| `libs/solver-py`                                      | `libs/wbs/adapters/solver-py`                  | `wbs-solver-py`                  | adapter / python                           |
| `libs/observability`                                  | `libs/wbs/adapters/observability`              | `wbs-observability`              | adapter / bun                              |
| `libs/config`                                         | `libs/wbs/adapters/config`                     | `wbs-config`                     | adapter / bun                              |
| `libs/contracts/solver/supervisor-protocol`           | `libs/wbs/adapters/solver-supervisor-protocol` | `wbs-solver-supervisor-protocol` | adapter / isomorphic                       |
| Every `tools/*` project                               | Same root                                      | Same name                        | adapter / existing runtime; no product tag |

The nested supervisor project was absent from the original plan's table. Its existing
`ring:adapter` is preserved and determines its destination; its public alias remains
`@wbs/contracts/solver/supervisor-protocol`. It serves backend/host adapter traffic, has no
domain importer at inspection, and must not acquire a domain ring merely by being inside
the old contracts directory. `solver-py` already says `runtime:python`; the plan's old
`runtime:bun` description is not an instruction to relabel Python.

Aliases into `tools/*` (`@wbs/deploy-contract`, `@wbs/tool-compose`, `@wbs/tool-env`) remain
where they are. The package name `@wbs/source` is unrelated to an Nx project rename.
Generated outputs follow the same relative destination below `dist/`, including
`dist/apps/wbs/fe-01` and `dist/out-tsc/libs/wbs/...`; update every corresponding `outputs`,
compiler `outDir`, Vite build directory, packaged-browser mount and Docker COPY together.

### Complete discovery before enforcement

Reuse the recursive project enumerator supplied by `core-lib-extraction`; consolidate its
shared entrypoint as `tools/tool-devsync/workspace-projects.mjs`, a Node-standard-library module usable
by both ESLint configuration and Bun tests without TypeScript loader assumptions. It exports
`readProjects(workspace)` with validated records `{root, name, tags, targets}` and
`productConstraints(projects)`. It recursively visits application/library/tool trees,
including nested project roots; a project root does not end traversal. Ignore only named
generated/dependency directories (`node_modules`, `dist`, `.nx`, `coverage`, `.git`), not
arbitrary directories that lack a direct manifest. Do not follow directory symlinks: reject
one encountered in these project trees with its path. A directory without `project.json`
is modeled; unreadable directory/manifest, malformed JSON, duplicate identity and malformed
required metadata throw. Preserve target metadata needed by existing gate-discovery tests.

Use the enumerator in every project walk in `workspace-targets.test.ts`, `sync.test.ts`
and the new `namespace-layout.test.ts`. Re-aim the outside-read and deploy-union scans at
each discovered source root, not `<group>/<immediate-child>/src`. The old `>20` count is not
coverage proof: compare the complete discovered `(root,name)` set with Nx's project graph
in an integration test, and pin the nested supervisor in a direct fixture assertion.

`productConstraints` produces a rule for every discovered `product:X`: only `product:X`
or `product:shared` libraries are permitted. A `product:shared` source only depends on
`product:shared`; it cannot become an escape into WBS. Infra has no product rule. Register
these constraints in production and test ESLint configurations: only ring constraints
have the existing test exemption. A second-product fixture added to the candidate must
receive its rule without a manual edit to an allowlist.

Layout validation requires apps at `apps/<product>/<project>` with adapter ring, and libs
at `libs/<product>/<domain|application|adapters>/<project>`, matching the directory's product
and ring (`adapters` maps to `ring:adapter`). Project name is `<product>-<suffix>`. Tools
retain `scope:infra`, adapter ring, no product tag. All projects have exactly one scope,
ring and runtime tag; all apps/libs exactly one product tag. Adopt final layout validation
in the same candidate as the move, after proving it against temporary fixture workspaces.

### Operational paths are distinct from deployment identities

Keep `APP_NAME`, `IMAGE_NAME`, tier ports, `be-01.internal`, container/colour names, registry
repository names, remote state and environment filenames unchanged. `APP_NAME` is used by
container DNS and `/srv/wbs/<app>.env`, not Nx selection. Do not blindly replace every
`be-01` token with `wbs-be-01`. Rewrite only Nx project selectors and filesystem references.

The three migration CLIs and `drizzle/` move with the backend. Container WORKDIR becomes
`/app/apps/wbs/be-01`, so the existing swap commands `bun run src/migrate-*-cli.ts` and
CLI `./drizzle` argument remain correct. `tools/tool-deploy/src/migrations.ts` resolves its
Git-tree source directory **at the SHA being read**: deployment compares HEAD with the
previously deployed backend SHA, which can still have `apps/be-01/drizzle`. Probe the two
exact supported layouts at that revision; exactly one must exist as a tree. Both present,
neither present or unreadable/malformed Git state throws. This is a modeled layout transition,
not an empty-list fallback. Enumerate and compare migration ids within the selected tree.
A rename-only deploy must report no new migrations against an old-layout release; adding a
new folder afterward must still require acknowledgment. Do not infer an old revision's
layout from the working tree. Migration lint's `gateScriptPath` must account for the extra
`wbs` segment; prefer an explicit workspace-root argument from the hook entrypoint, validated
against the migration location, over adding another magic ascent. The waiver still names
the same repository-root `bin/assert-no-prod-release.sh`; test its absence separately.

### Consumer inventory, refreshed at implementation base

The original eighteen-file estimate is obsolete. Slice 1 records actual tracked references,
including dynamic path constructors, in this change's evidence before editing. This
inspection found at least the following families; this list is routing, not a second source
of mutable facts or permission to rewrite frozen historical documents:

| Consumer                               | Paths / behavior to preserve                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project manifests and tsconfigs        | Every app/lib `project.json`, relative `$schema`, `sourceRoot`, commands/cwd/outputs, `extends`, references, `outDir`; nested supervisor paths                     |
| Root configuration                     | `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.prettierignore`, `.dockerignore`, `lefthook.yml`, `.github/workflows/ci.yml`             |
| Frontend resolvers/browser entrypoints | Vite and Vitest aliases; Vite output; Playwright config, packaged config, their tests and server commands; root-source lint inputs                                 |
| Development                            | `bin/dev.sh`, `bin/dev.test.sh`, `bin/dev-deploy.sh`, `tools/dev/{setup,solver-environment}.ts` and tests; explicit remote MCP `.env` preflight                    |
| Restart/compatibility guards           | `tools/tool-devsync/src/{sync,sync.test,workspace-targets.test,toolchain-pins.test}.ts`; recursive project/config and Dockerfile cache inputs in its manifest      |
| Images                                 | Each app Dockerfile; `tools/tool-dagger/src/{main.ts,lib/image.ts}` and tests; solver lock/package COPY and smoke script; `.dockerignore` dev-entrypoint exclusion |
| Deployment/migrations                  | `tools/tool-deploy/src/{migrations,deploy}.ts` and tests; remote Docker/swap tests; migration-lint hook, waiver root and staged SQL glob                           |
| Corpus gates                           | `tools/tool-git-hooks/src/hooks/corpus-version-lint.ts` and tests; domain version/corpus paths, hook target inputs, CI's Python requirements path                  |
| Cross-tree fixtures                    | Domain README/ADR and external-system migration readers; solver Python fixture paths; backend/contract test fixtures; `tools/dev` fixture reads                    |
| Current documentation                  | Index/runbooks, symbol JSDoc and active-change paths; preserve archived evidence as historical references                                                          |

Also inspect wildcard-only references such as `apps/*/Dockerfile`, `libs/*/project.json`,
`apps/${app}` and relative `../../../` traversal. Literal app-path searches miss them.

## Risks / Trade-offs

One rename touches broad infrastructure shared by every parallel worker. Freeze and merge
ordinary feature/extraction work first; assign the complete move to one owner. Radical
Modularity's baseline can pin the earlier revision, but its eventual indexes/mappings need
the final namespace. Keep root gate ownership coordinated across those changes.

Warm Nx cache evidence must accompany discovery/input changes: a moved project/Dockerfile
mutation must rerun its real guard. Changing a test to expect a renamed string does not
prove the production consumer reached the moved file. Use actual Nx lint, typecheck,
development-planning and migration entrypoints plus the packaged image paths.

## Migration Plan

Finish core extraction and reconcile solver ownership; prove recursive discovery and
generated constraints using isolated fixture workspaces; move all projects/consumers in one
candidate; verify aliases, migration bytes and runtime identities; run complete gates and
the production dry-run with fresh built bundles. The dry-run must plan all requested tiers
from the candidate and resolve the moved Dockerfiles. It is not evidence that publishing or
a live swap happened. No production publish or deploy is part of this change's preparation.

## Open Questions

No unresolved design choice blocks an implementation worker. The exact post-extraction
commit and additional paths introduced since this inspection are launch evidence to obtain,
not permission to redesign the mapping. A new project absent from the table is mapped by
its established ring/runtime and reported in the refreshed inventory before the move.
