# Repo namespacing preflight inventory

Pinned at `6ca89944d37ee1bdaed7f7290df0fc4272847d81` on 2026-09-14 before any project move. This is the comparison source for Sections 3–4; historical documents and archived OpenSpec changes were excluded from the active-path sweep.

## Project roots, Nx identities and tags

The recursive enumerator and Nx graph both reported 31 identical projects, including the nested supervisor protocol project. The 18 application/library rows are asserted as an exact set in `workspace-projects.test.ts`.

```text
apps/be-01	be-01	scope:app,type:app,runtime:bun,ring:adapter
apps/fe-01	fe-01	scope:app,type:app,runtime:browser,ring:adapter
apps/gw-01	gw-01	scope:app,type:app,runtime:bun,ring:adapter
apps/mcp-01	mcp-01	scope:app,type:app,runtime:bun,ring:adapter
libs/auth	auth	scope:shared,type:auth,runtime:bun,ring:adapter
libs/config	config	scope:shared,type:config,runtime:bun,ring:adapter
libs/conformance	conformance	scope:shared,ring:application,runtime:bun,product:wbs
libs/contracts	contracts	scope:shared,type:contracts,runtime:isomorphic,ring:domain
libs/contracts/solver/supervisor-protocol	solver-supervisor-protocol	scope:shared,type:contracts,runtime:isomorphic,ring:adapter
libs/core	core	scope:shared,ring:application,runtime:isomorphic,product:wbs
libs/domain	domain	scope:shared,type:domain,runtime:isomorphic,ring:domain
libs/observability	observability	scope:shared,type:observability,ring:adapter,runtime:bun
libs/realtime	realtime	scope:shared,type:realtime,runtime:browser,ring:adapter
libs/runtime-portable	runtime-portable	scope:shared,ring:adapter,runtime:isomorphic,product:wbs
libs/solver-py	solver-py	scope:lib,type:lib,runtime:python,ring:adapter
libs/store-memory	store-memory	scope:shared,ring:adapter,runtime:isomorphic,product:wbs
libs/store-sqlite	store-sqlite	scope:shared,ring:adapter,runtime:bun,product:wbs
libs/validation	validation	scope:shared,type:validation,runtime:isomorphic,ring:domain
tools/dev	tool-dev-setup	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/test/scratch	tool-test-scratch	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-bootstrap	tool-bootstrap	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-compose	tool-compose	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-dagger	tool-dagger	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-deploy	tool-deploy	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-devsync	tool-devsync	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-git-hooks	tool-git-hooks	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-observability-stack	tool-observability-stack	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-remote-scripts	tool-remote-scripts	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-secrets	tool-secrets	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-smoke	tool-smoke	scope:infra,type:scripts,runtime:bun,ring:adapter
tools/tool-wiki	tool-wiki	scope:infra,type:scripts,runtime:bun,ring:adapter
```

## Workspace-root path token consumers

This is the 288-file tracked-source/config set matching an `apps/` or `libs/` path
literal/wildcard, a constructed `apps/${…}` or `libs/${…}` path, or the shared recursive
project-group symbols. This sweep proves only those token forms; it does not cover
parent-relative configuration or documentation. `docs/**`, `openspec/**`, `.superpowers/**`,
and `notes/**` were excluded here and handled separately below. Some in-tree source files
appear because their tests or JSDoc name a cross-tree path.

```text
.dockerignore
.github/workflows/ci.yml
.gitignore
.prettierignore
AGENTS.md
HUMAN_README.md
LLM_README.md
apps/be-01/Dockerfile
apps/be-01/drizzle/20260814110000_add_priority_band/migration.sql
apps/be-01/drizzle/20260818010000_add_role_progress/migration.sql
apps/be-01/drizzle/20260818090000_add_not_before_reason/migration.sql
apps/be-01/drizzle/20260819120000_add_tag/migration.sql
apps/be-01/drizzle/20260821000000_add_service/migration.sql
apps/be-01/drizzle/20260821080000_add_work_item_service/migration.sql
apps/be-01/drizzle/20260821140000_add_role_measure/migration.sql
apps/be-01/drizzle/20260821150000_add_person_kind/down.sql
apps/be-01/drizzle/20260821150000_add_person_kind/migration.sql
apps/be-01/drizzle/20260830010000_add_work_item_type/migration.sql
apps/be-01/drizzle/20260830020000_add_external_ref/migration.sql
apps/be-01/drizzle/20260831120000_rename_role_to_step/migration.sql
apps/be-01/drizzle/20260905090000_add_calendar_marker/migration.sql
apps/be-01/drizzle/20260906090000_add_work_item_deadline/migration.sql
apps/be-01/drizzle/20260909120000_add_external_ref_name/down.sql
apps/be-01/project.json
apps/be-01/scripts/solver-image-smoke.sh
apps/be-01/scripts/solver-orphan-fixture.Dockerfile
apps/be-01/src/app.ts
apps/be-01/src/boot.ts
apps/be-01/src/controller/calendar-marker-identity.db.test.ts
apps/be-01/src/controller/step.controller.db.test.ts
apps/be-01/src/deployed-commit.test.ts
apps/be-01/src/dev/main.ts
apps/be-01/src/main.ts
apps/be-01/src/openapi/openapi-build.test.ts
apps/be-01/src/production-entrypoint.test.ts
apps/be-01/src/service/capacity-migration-identity.db.test.ts
apps/be-01/src/service/clock.test.ts
apps/be-01/src/service/deadline-plan-read.test.ts
apps/be-01/src/service/optimization-orphan.proc.db.test.ts
apps/be-01/src/service/optimized-plan-read-annotations.test.ts
apps/be-01/src/service/saved-plan-read.db.test.ts
apps/be-01/src/service/service-empty-diff.db.test.ts
apps/be-01/src/service/solver-launcher-process.ts
apps/be-01/tools/capture-capacity-oracle.ts
apps/fe-01/Caddyfile
apps/fe-01/Dockerfile
apps/fe-01/e2e-packaged/packaged.spec.ts
apps/fe-01/e2e/gantt.spec.ts
apps/fe-01/e2e/rendering-evidence.ts
apps/fe-01/playwright-config.test.ts
apps/fe-01/playwright.config.ts
apps/fe-01/playwright.packaged.config.ts
apps/fe-01/project.json
apps/fe-01/src/components/auth/auth-form.tsx
apps/fe-01/src/components/wbs/column-hints.test.ts
apps/fe-01/src/components/wbs/column-hints.ts
apps/fe-01/src/components/wbs/dep-graph.test.ts
apps/fe-01/src/components/wbs/dep-graph.ts
apps/fe-01/src/components/wbs/dep-light-store.ts
apps/fe-01/src/components/wbs/gantt-geometry.test.ts
apps/fe-01/src/components/wbs/gantt-geometry.ts
apps/fe-01/src/components/wbs/gantt-panel.tsx
apps/fe-01/src/components/wbs/plan-chart-input.ts
apps/fe-01/src/components/wbs/plan-export.ts
apps/fe-01/src/components/wbs/short-date.test.ts
apps/fe-01/src/components/wbs/teams-panel.tsx
apps/fe-01/src/components/wbs/tree-search.ts
apps/fe-01/src/components/wbs/use-plan-filter.ts
apps/fe-01/src/components/wbs/use-plan-read.ts
apps/fe-01/src/components/wbs/use-reference-sets.ts
apps/fe-01/src/deadline-copy.test.ts
apps/fe-01/src/lib/project-stream.ts
apps/fe-01/src/lib/saved-plan-compare.test.ts
apps/fe-01/src/lib/saved-plan-compare.ts
apps/fe-01/src/lib/wbs-api.test.ts
apps/fe-01/src/lib/wbs-api.ts
apps/fe-01/src/styles.test.ts
apps/fe-01/src/test-tiers.test.ts
apps/fe-01/src/testing/fake-project-api.ts
apps/fe-01/tsconfig.app.json
apps/fe-01/tsconfig.e2e.json
apps/fe-01/tsconfig.json
apps/fe-01/tsconfig.spec.json
apps/fe-01/vite-config.test.ts
apps/fe-01/vite.config.ts
apps/fe-01/vitest.config.ts
apps/fe-01/vitest.node-suites.ts
apps/gw-01/Dockerfile
apps/gw-01/project.json
apps/gw-01/src/service/socket-writer.ts
apps/mcp-01/README.md
apps/mcp-01/project.json
apps/mcp-01/src/config.ts
apps/mcp-01/src/openapi-tools.test.ts
apps/mcp-01/src/wbs-client.test.ts
apps/mcp-01/src/wbs-client.ts
bin/dev-deploy.sh
bin/dev-ports.sh
bin/dev.test.sh
deploy/dev-src/compose.yml
eslint.config.js
lefthook.yml
libs/auth/project.json
libs/config/project.json
libs/config/src/define-config.ts
libs/conformance/project.json
libs/contracts/project.json
libs/contracts/solver/solver-wire.v1.json
libs/contracts/solver/src/build-solver-request.test.ts
libs/contracts/solver/src/materialise-optimized.ts
libs/contracts/solver/src/optimized-result-dto.ts
libs/contracts/solver/src/revalidate-solver-result.test.ts
libs/contracts/solver/src/revalidate-solver-result.ts
libs/contracts/solver/src/solver-failure-disposition.test.ts
libs/contracts/solver/src/solver-failure-disposition.ts
libs/contracts/solver/src/solver-units.test.ts
libs/contracts/solver/src/solver-units.ts
libs/contracts/solver/src/wire-vocabulary.test.ts
libs/contracts/solver/src/wire-vocabulary.ts
libs/contracts/solver/supervisor-protocol/project.json
libs/contracts/src/http/document-from-shapes.ts
libs/contracts/src/http/refusal.test.ts
libs/contracts/src/http/refusal.ts
libs/core/project.json
libs/core/src/http/priority-ladder-body.ts
libs/core/src/ports/clock.test.ts
libs/core/src/ports/work-item-store.ts
libs/core/src/service/command-normalizers.ts
libs/core/src/service/priority-band.service.ts
libs/core/src/service/progress.test.ts
libs/core/src/service/saved-plan-input.ts
libs/core/src/service/service-boundaries.test.ts
libs/core/src/service/work-item.service.test.ts
libs/core/src/service/work-item.service.ts
libs/core/src/use-cases/README.md
libs/core/testing/portable-composition.spec.ts
libs/domain/project.json
libs/domain/src/canonical-schedule-input.ts
libs/domain/src/capacity.ts
libs/domain/src/contract-version.ts
libs/domain/src/derive-numbers.ts
libs/domain/src/effective-service.ts
libs/domain/src/effective-tag.ts
libs/domain/src/external-system.test.ts
libs/domain/src/index.ts
libs/domain/src/label-mismatch.ts
libs/domain/src/label-mismatch.test.ts
libs/domain/src/leaf-constraints.ts
libs/domain/src/marker-color.test.ts
libs/domain/src/marker-color.ts
libs/domain/src/priority-band.ts
libs/domain/src/publication-guard.ts
libs/domain/src/saved-plan/README.md
libs/domain/src/saved-plan/canonical-plan-input.ts
libs/domain/src/saved-plan/diff-plans.ts
libs/domain/src/schedule.ts
libs/domain/src/slice-edges.ts
libs/domain/src/solver-seams.test.ts
libs/observability/project.json
libs/realtime/project.json
libs/runtime-portable/project.json
libs/solver-py/project.json
libs/solver-py/pyproject.toml
libs/solver-py/requirements.lock
libs/solver-py/requirements.macos-arm64.lock
libs/solver-py/src/wbs_solver/cli.py
libs/solver-py/src/wbs_solver/model.py
libs/solver-py/src/wbs_solver/solver-wire.v1.json
libs/solver-py/src/wbs_solver/validate.py
libs/solver-py/tests/test_model.py
libs/solver-py/tests/test_schema_copy.py
libs/solver-py/tests/test_version.py
libs/store-memory/project.json
libs/store-memory/src/README.md
libs/store-sqlite/project.json
libs/store-sqlite/src/actual.db.test.ts
libs/store-sqlite/src/assignment-scope.db.test.ts
libs/store-sqlite/src/audit-columns.db.test.ts
libs/store-sqlite/src/calendar-marker-migration.db.test.ts
libs/store-sqlite/src/calendar-marker-repository.db.test.ts
libs/store-sqlite/src/calendar-marker.db.test.ts
libs/store-sqlite/src/capacity.db.test.ts
libs/store-sqlite/src/captured-optimization-reader.db.test.ts
libs/store-sqlite/src/changes.db.test.ts
libs/store-sqlite/src/command-journal.db.test.ts
libs/store-sqlite/src/constraint.db.test.ts
libs/store-sqlite/src/db.ts
libs/store-sqlite/src/dependency.db.test.ts
libs/store-sqlite/src/directory.db.test.ts
libs/store-sqlite/src/estimate.db.test.ts
libs/store-sqlite/src/event-log.db.test.ts
libs/store-sqlite/src/external-ref.db.test.ts
libs/store-sqlite/src/identity-migration.db.test.ts
libs/store-sqlite/src/import-performance.db.test.ts
libs/store-sqlite/src/import.service.db.test.ts
libs/store-sqlite/src/migrate-down.db.test.ts
libs/store-sqlite/src/migrate.db.test.ts
libs/store-sqlite/src/optimization-admission-global.db.test.ts
libs/store-sqlite/src/optimization-admission.db.test.ts
libs/store-sqlite/src/optimization-drain.db.test.ts
libs/store-sqlite/src/optimization-generation.db.test.ts
libs/store-sqlite/src/optimization-queue.db.test.ts
libs/store-sqlite/src/optimized-cache.db.test.ts
libs/store-sqlite/src/optimized-outcome.db.test.ts
libs/store-sqlite/src/optimized-schedule-cache.db.test.ts
libs/store-sqlite/src/optimizer-rows.db.test.ts
libs/store-sqlite/src/plan-event.db.test.ts
libs/store-sqlite/src/priority-band.db.test.ts
libs/store-sqlite/src/priority-not-backfilled.db.test.ts
libs/store-sqlite/src/project-settings.db.test.ts
libs/store-sqlite/src/project.db.test.ts
libs/store-sqlite/src/retired-schema-untouched.db.test.ts
libs/store-sqlite/src/saved-plan-busy.db.test.ts
libs/store-sqlite/src/saved-plan-capture.db.test.ts
libs/store-sqlite/src/saved-plan-concurrency.db.test.ts
libs/store-sqlite/src/saved-plan-created-by-id.db.test.ts
libs/store-sqlite/src/saved-plan-in-transaction.db.test.ts
libs/store-sqlite/src/saved-plan-migration.db.test.ts
libs/store-sqlite/src/saved-plan.db.test.ts
libs/store-sqlite/src/schema-indexes.db.test.ts
libs/store-sqlite/src/schema.ts
libs/store-sqlite/src/service-untouched.db.test.ts
libs/store-sqlite/src/source.test.ts
libs/store-sqlite/src/sqlite-unit-of-work.db.test.ts
libs/store-sqlite/src/step-measure.db.test.ts
libs/store-sqlite/src/step-progress.db.test.ts
libs/store-sqlite/src/step.db.test.ts
libs/store-sqlite/src/targeted-readers.db.test.ts
libs/store-sqlite/src/testing/faults.test.ts
libs/store-sqlite/src/testing/source-conformance.db.test.ts
libs/store-sqlite/src/user-oidc.db.test.ts
libs/store-sqlite/src/work-item-type.db.test.ts
libs/store-sqlite/src/work-item.db.test.ts
libs/store-sqlite/src/working-plan-order.db.test.ts
libs/store-sqlite/src/working-plan-performance.test.ts
libs/store-sqlite/src/write-coordinator.db.test.ts
libs/validation/project.json
tools/dev/chord-probe.html
tools/dev/setup.test.ts
tools/dev/setup.ts
tools/dev/solver-environment.test.ts
tools/dev/solver-environment.ts
tools/dev/write-fast-golden-corpus.ts
tools/dev/write-solver-quantum-golden-corpus.ts
tools/tool-bootstrap/src/configure.sh
tools/tool-dagger/src/lib/image.ts
tools/tool-dagger/src/main.ts
tools/tool-deploy/src/deploy.test.ts
tools/tool-deploy/src/deploy.ts
tools/tool-deploy/src/migrations.ts
tools/tool-devsync/project.json
tools/tool-devsync/src/eslint-boundaries.test.ts
tools/tool-devsync/src/poller.test.ts
tools/tool-devsync/src/solver-preparation.test.ts
tools/tool-devsync/src/solver-preparation.ts
tools/tool-devsync/src/sync.test.ts
tools/tool-devsync/src/sync.ts
tools/tool-devsync/src/toolchain-pins.test.ts
tools/tool-devsync/src/workspace-projects.test.ts
tools/tool-devsync/src/workspace-targets.test.ts
tools/tool-devsync/workspace-projects.mjs
tools/tool-git-hooks/src/hooks/ci-gate-annotations.test.ts
tools/tool-git-hooks/src/hooks/corpus-version-lint.test.ts
tools/tool-git-hooks/src/hooks/corpus-version-lint.ts
tools/tool-git-hooks/src/hooks/migration-lint.test.ts
tools/tool-git-hooks/src/hooks/migration-lint.ts
tools/tool-remote-scripts/src/lib/docker.test.ts
tools/tool-remote-scripts/src/lib/docker.ts
tools/tool-smoke/src/health.ts
tools/tool-smoke/src/ws-ping.ts
tools/tool-wiki/src/admission/authority-store.ts
tools/tool-wiki/src/admission/claims.db.test.ts
tools/tool-wiki/src/admission/claims.test.ts
tools/tool-wiki/src/admission/claims.ts
tools/tool-wiki/src/admission/generations.test.ts
tools/tool-wiki/src/contracts/contracts.test.ts
tools/tool-wiki/src/contracts/fixtures/granularity-policy.v1.json
tools/tool-wiki/src/contracts/fixtures/module-mapping.v1.json
tools/tool-wiki/src/contracts/index.ts
tools/tool-wiki/src/contracts/records.ts
tools/tool-wiki/src/indexes/indexes.test.ts
tools/tool-wiki/src/inventory/classification.test.ts
tools/tool-wiki/src/policy/pilot-policy.test.ts
tools/tool-wiki/src/relationships/relationships.test.ts
tools/tool-wiki/src/relationships/selectors.test.ts
tools/tool-wiki/src/review/exhaustive-coverage.test.ts
tools/tool-wiki/src/review/exhaustive-coverage.ts
tsconfig.base.json
```

The operational ownership families within this token set are root aliases/scripts/lint/CI/ignore files; app/lib manifests with workspace-root values; Vite/Vitest/Playwright and packaged frontend paths; `bin/dev*` plus `tools/dev` and tool-devsync restart/compatibility paths; application Dockerfiles and tool-dagger inputs; deployment/migration and migration-lint callers; corpus-version and solver fixtures; and cross-tree store/domain/backend/frontend reads.

## Depth-sensitive app/library configuration

`readDepthSensitiveConfigPaths` recursively discovers app/library roots, parses their
`project.json` and `tsconfig*.json` as JSONC, and records every string containing `../` with
its file and property path. The pinned pre-move run reports 148 values in these 72 files:

```text
apps/be-01                         project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json, tsconfig.tools.json
apps/fe-01                         project.json, tsconfig.json, tsconfig.app.json, tsconfig.e2e.json, tsconfig.spec.json
apps/gw-01                         project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
apps/mcp-01                        project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/auth                          project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/config                        project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/conformance                   project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/contracts                     project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/contracts/solver/supervisor-protocol project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/core                          project.json, tsconfig.json, tsconfig.lib.json, tsconfig.portable.json, tsconfig.spec.json
libs/domain                        project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/observability                 project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/realtime                      project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/runtime-portable              project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/solver-py                     project.json
libs/store-memory                  project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/store-sqlite                  project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
libs/validation                    project.json, tsconfig.json, tsconfig.lib.json, tsconfig.spec.json
```

The 148 values divide exactly into 18 project-schema paths, 17 root `extends` paths, 37
compiler `outDir` paths, and 76 frontend compiler-alias targets. The ordinary-depth values
use `../../`; the nested supervisor uses `../../../../`; backend tools compilation uses
`../../dist/out-tsc-tools`. The frontend's 19 alias targets each occur in `tsconfig.json`,
`tsconfig.app.json`, `tsconfig.spec.json`, and `tsconfig.e2e.json`. Sibling `./tsconfig*`
references move with their owning files and are not depth-sensitive; workspace-root values
remain in the token inventory above.

The non-JSON configuration/script sweep adds these depth-sensitive paths:

```text
apps/be-01/scripts/solver-image-smoke.sh:5       $script_dir/../../.. -> workspace root
apps/fe-01/vite-config.test.ts:72                ../../deploy/dev-src/compose.yml
apps/fe-01/vite.config.ts:232                    ../../dist/apps/fe-01
libs/core/playwright.config.ts:8                 ../../tmp/core-portable-results
```

The frontend Vite and Vitest alias paths also use `../../libs/...`; those files and values
are already captured by the workspace-root token sweep. The cross-project source/test
relative reads are recorded in their own AST-derived table below. Relative imports that
stay inside one moving project, such as `../src/...`, retain their meaning and are excluded.
The non-JSON review was reproduced with:

```sh
rg -n '\.\./' apps libs --glob '!**/src/**' --glob '!**/drizzle/**' --glob '!**/e2e/**' --glob '!**/e2e-packaged/**' --glob '!**/README.md' --glob '!**/*.lock' --glob '!**/__snapshots__/**'
```

## Documentation path references

The tracked `docs/**/*.md` sweep below records all 41 files containing an existing app/lib
root token. It intentionally includes current runbooks and historical plans, ADRs, reviews,
and evidence. Section 4 must classify each occurrence before rewriting; inclusion here does
not claim that frozen historical evidence should change.

```text
docs/2026-08-30-agent-loop-audit.md
docs/2026-08-30-sustainability-audit.md
docs/2026-09-02-refactoring-handoff.md
docs/2026-09-02-refactoring-plan.md
docs/2026-09-02-refactoring-review/A-be-repository.md
docs/2026-09-02-refactoring-review/B-be-service-controller.md
docs/2026-09-02-refactoring-review/C-fe-wbs-table.md
docs/2026-09-02-refactoring-review/D-fe-rest.md
docs/2026-09-02-refactoring-review/E-gw-mcp-libs.md
docs/2026-09-02-refactoring-review/F-tools-tests.md
docs/2026-09-02-refactoring-review/README.md
docs/2026-09-05-ports-and-adapters-history.md
docs/2026-09-05-ports-and-adapters-plan.md
docs/adr/0008-tags-accumulate-down-the-tree.md
docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md
docs/adr/0012-a-write-carries-its-actor-as-an-argument.md
docs/adr/0014-ports-live-in-a-framework-free-core-lib.md
docs/adr/0016-a-tied-sibling-position-is-legal-and-the-row-id-resolves-it.md
docs/adr/0018-the-dev-deploy-trigger-owns-solver-compatibility-preparation.md
docs/adr/0024-a-done-work-item-draws-its-facts-not-its-slices.md
docs/auth-integration.md
docs/capacity.md
docs/findings/checks-that-cannot-fail.md
docs/findings/current.md
docs/local-dev.md
docs/plans/2026-08-07-table-ui-cleanup.md
docs/plans/2026-08-08-tailwind-spike-verify.md
docs/plans/2026-08-09-resource-planning.md
docs/plans/2026-09-13-tool-wiki-precedents-and-extraction.md
docs/refactoring/tasks.md
docs/refactoring/verify.md
docs/refactoring/w4-4/extraction-map.md
docs/refactoring/w4-4/verify.md
docs/runbook-dev-deploy.md
docs/state/TASK-347-http-endpoint-port.md
docs/superpowers/plans/2026-08-02-compose-blue-green-HANDOVER.md
docs/superpowers/plans/2026-08-02-compose-blue-green-deploy.md
docs/superpowers/plans/2026-08-04-cheap-dev-deploy.md
docs/superpowers/plans/2026-08-24-password-login.md
docs/superpowers/specs/2026-08-02-compose-blue-green-deploy-design.md
docs/superpowers/specs/2026-09-05-be01-route-auth-metadata-design.md
```

Reproduction command:

```sh
rg -l --glob '*.md' '(^|[^[:alnum:]_])(apps|libs)/(be-01|fe-01|gw-01|mcp-01|auth|config|conformance|contracts|core|domain|observability|realtime|runtime-portable|solver-py|store-memory|store-sqlite|validation)(/|\b)' docs | sort
```

## Nx selector sweep

Path matching does not find selector-only consumers. These two additional active-source
searches reported 27 direct invocation/project-option matches and 60 target-label matches:

```sh
rg -n --hidden --pcre2 --glob '!node_modules/**' --glob '!.git/**' --glob '!openspec/**' --glob '!docs/**' --glob '!notes/**' --glob '!.superpowers/**' --glob '!**/*.md' '(?:nx\s+run\s+|(?:-p|--projects=)\s*)(?:be-01|fe-01|gw-01|mcp-01|auth|config|conformance|contracts|solver-supervisor-protocol|core|domain|observability|realtime|runtime-portable|solver-py|store-memory|store-sqlite|validation)\b' package.json bin .github tools apps libs
rg -n --hidden --pcre2 --glob '!node_modules/**' --glob '!.git/**' --glob '!openspec/**' --glob '!docs/**' --glob '!notes/**' --glob '!.superpowers/**' --glob '!**/*.md' '(?:be-01|fe-01|gw-01|mcp-01|auth|config|conformance|contracts|solver-supervisor-protocol|core|domain|observability|realtime|runtime-portable|solver-py|store-memory|store-sqlite|validation):(?:serve|serve-local-solver|e2e|e2e-packaged|solver-image-smoke|setup-macos|test(?::(?:unit|store|conformance))?|lint(?::fast)?|typecheck|build|deploy|push)\b' package.json bin .github tools apps libs
```

The executable/configuration selectors owned by the coordinated move are root scripts for
`be-01`, `gw-01` and `fe-01`; `bin/dev.sh`'s four-app project list; the CI and h2puni-gate
`be-01:solver-image-smoke` targets; the frontend Dockerfile/project build commands; and the
backend `solver-py:setup-macos` command. The complete results also retain source comments,
refusal messages and test oracles for app test tiers, frontend browser/build targets,
`mcp-01`'s backend fixture, tool-devsync's image-smoke command, and both store conformance
targets. Their file membership is already pinned by the active-path inventory above.

## Cross-project relative reads

These paths are the AST-classified reader-side literals used by the production outside-read coverage gate. Repeated migration directory reads are kept because each owning test target must declare the input.

```text
be-01	apps/be-01/src/controller/calendar-marker-identity.db.test.ts	libs/runtime-portable/src/scheduler.ts
be-01	apps/be-01/src/controller/calendar-marker-identity.db.test.ts	libs/domain/src/schedule.ts
be-01	apps/be-01/src/service/optimization-orphan.proc.db.test.ts	tools/tool-remote-scripts/src/fixtures/solver-supervisor-orphan-host.ts
domain	libs/domain/src/readme.test.ts	docs/adr
domain	libs/domain/src/marker-color.test.ts	apps/fe-01/src/styles.css
domain	libs/domain/src/external-system.test.ts	apps/be-01/drizzle/20260830020000_add_external_ref/migration.sql
store-sqlite	libs/store-sqlite/src/calendar-marker-migration.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimized-cache.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/dependency.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/estimate.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimization-generation.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/project.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/work-item-type.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/capacity.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/service-untouched.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/plan-event.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-concurrency.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-concurrency.db.test.ts	apps/be-01/src/testing/saved-plan-lock-holder.ts
store-sqlite	libs/store-sqlite/src/identity-migration.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/import-performance.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/import.service.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/event-log.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/audit-columns.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimization-admission-global.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-created-by-id.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/actual.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-migration.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/step.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/write-coordinator.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/constraint.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/assignment-scope.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimizer-rows.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimizer-rows.db.test.ts	openspec/changes/dual-optimized-scheduler/design.md
store-sqlite	libs/store-sqlite/src/step-progress.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/changes.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/user-oidc.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimization-drain.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimization-admission.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/work-item.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/migrate-down.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/step-measure.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/targeted-readers.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/project-settings.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/calendar-marker-repository.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/priority-band.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/directory.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/source.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimization-queue.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-capture.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/sqlite-unit-of-work.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimized-schedule-cache.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/external-ref.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/optimized-outcome.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/calendar-marker.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/captured-optimization-reader.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/schema-indexes.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/command-journal.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/retired-schema-untouched.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/priority-not-backfilled.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-in-transaction.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-busy.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/saved-plan-busy.db.test.ts	apps/be-01/src/testing/saved-plan-lock-holder.ts
store-sqlite	libs/store-sqlite/src/migrate.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/testing/source-conformance.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/testing/faults.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/working-plan-order.db.test.ts	apps/be-01/drizzle
store-sqlite	libs/store-sqlite/src/working-plan-performance.test.ts	apps/be-01/drizzle
tool-bootstrap	tools/tool-bootstrap/src/configure-caddy.test.ts	deploy/compose/Caddyfile.bootstrap
tool-bootstrap	tools/tool-bootstrap/src/configure-caddy.test.ts	deploy/compose/log-redact.caddy
tool-compose	tools/tool-compose/src/render.test.ts	deploy/compose
tool-compose	tools/tool-compose/src/dev-caddy.test.ts	deploy/compose/site-dev.caddy.candidate
tool-dagger	tools/tool-dagger/src/main.test.ts	docs/runbook-prod-deploy.md
tool-dagger	tools/tool-dagger/src/heavy-lock.test.ts	bin/with-heavy-lock.sh
tool-dagger	tools/tool-dagger/src/heavy-lock.test.ts	bin/heavy-lock-lib.sh
tool-deploy	tools/tool-deploy/src/assert-no-prod-release.test.ts	bin/assert-no-prod-release.sh
tool-devsync	tools/tool-devsync/src/mcp-preflight.test.ts	bin/dev-mcp-preflight.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-deploy.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/dev-poll-sync.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/h2puni-gate.sh
tool-devsync	tools/tool-devsync/src/poller.test.ts	bin/h2puni-gate-steps.sh
tool-devsync	tools/tool-devsync/src/mcp-probe.test.ts	bin/dev-mcp-probe.sh
tool-devsync	tools/tool-devsync/src/sync.test.ts	bin/dev.sh
tool-devsync	tools/tool-devsync/src/sync.test.ts	package.json
tool-devsync	tools/tool-devsync/src/sync.test.ts	deploy/dev-src/compose.yml
tool-devsync	tools/tool-devsync/src/be-probe.test.ts	bin/dev-be-probe.sh
```

## Alias keys

All public keys must remain identical after their targets move.

```text
@wbs/auth
@wbs/be-01
@wbs/config
@wbs/conformance
@wbs/conformance/*
@wbs/contracts
@wbs/contracts/solver/build-request
@wbs/contracts/solver/materialise-optimized
@wbs/contracts/solver/optimized-result
@wbs/contracts/solver/parse-solver-response
@wbs/contracts/solver/plan-infeasible
@wbs/contracts/solver/quantised-baseline
@wbs/contracts/solver/revalidate-solver-result
@wbs/contracts/solver/solver-failure-disposition
@wbs/contracts/solver/supervisor-protocol
@wbs/contracts/ws-frames
@wbs/core
@wbs/core/*
@wbs/deploy-contract
@wbs/domain
@wbs/domain/arrange-siblings
@wbs/domain/assumed-duration
@wbs/domain/canonical-schedule-input
@wbs/domain/deadline-offsets
@wbs/domain/dependency-reach
@wbs/domain/effective-service
@wbs/domain/effective-tag
@wbs/domain/effective-team
@wbs/domain/external-system
@wbs/domain/is-within
@wbs/domain/label-mismatch
@wbs/domain/marker-color
@wbs/domain/priority-band
@wbs/domain/progress
@wbs/domain/stored-vocabularies
@wbs/domain/tree-order
@wbs/domain/workday
@wbs/gw-01
@wbs/observability
@wbs/realtime
@wbs/runtime-portable
@wbs/runtime-portable/testing
@wbs/store-memory
@wbs/store-memory/*
@wbs/store-sqlite
@wbs/store-sqlite/*
@wbs/tool-compose
@wbs/tool-env
@wbs/tool-test-scratch
@wbs/validation
@wbs/validation/fixtures
```

## Migration path/blob manifest

Git blob identities preserve the exact bytes while paths move. Section 3 compares these blob IDs after the rename.

```text
17a1968e86ce3c457d3d317ea1e9bf8ae27824ca apps/be-01/drizzle/20260426171432_talented_smiling_tiger/down.sql
91e8e636229a16e863d4f1720914a15ed30fe5db apps/be-01/drizzle/20260426171432_talented_smiling_tiger/migration.sql
2c5549dc811b03e90de6a006585e5a23c41352a4 apps/be-01/drizzle/20260426171432_talented_smiling_tiger/snapshot.json
d3e208b5012be547104b78d7ec3e4031c6eb7a4a apps/be-01/drizzle/20260804194845_add_users/down.sql
ee656fd1299768f709712462a17a2b5ecd6eeaf9 apps/be-01/drizzle/20260804194845_add_users/migration.sql
b479a5de7c03c4f0a33e91724d7a27c31a6cfa7d apps/be-01/drizzle/20260804194845_add_users/snapshot.json
cc1b569ffbdda7601a6fcaab66a9e595be2fe417 apps/be-01/drizzle/20260805154500_add_wbs_domain/down.sql
8328f83840305b92441d1192999b1da6046fab33 apps/be-01/drizzle/20260805154500_add_wbs_domain/migration.sql
3a47318644d60b3418c8922c9d2504ad4105ef4b apps/be-01/drizzle/20260805154500_add_wbs_domain/snapshot.json
8cad141afd31dff523d2443dfa86d762bdcae9b5 apps/be-01/drizzle/20260806084828_add_dependencies/down.sql
795945095c3d478bc6544e39d69a021595921696 apps/be-01/drizzle/20260806084828_add_dependencies/migration.sql
38000bded9b60fe616e1feaeff00f1d87ec0a5be apps/be-01/drizzle/20260806084828_add_dependencies/snapshot.json
13b32caa084c2ffa2215e9c4f20aa3853b280d05 apps/be-01/drizzle/20260806160000_add_project_access/down.sql
4d1f204b507786f74f2138dd953fce98aac9513e apps/be-01/drizzle/20260806160000_add_project_access/migration.sql
1f2ef62a54073f940f82ea7372d1e26b0592c719 apps/be-01/drizzle/20260806170000_add_estimate_method/down.sql
abfc2c72fccd4d55504cb61eb9dcbbf8400fb5f4 apps/be-01/drizzle/20260806170000_add_estimate_method/migration.sql
0d0f5cb4fd1f99bb5b6aaf6cb1c6226fedd0845f apps/be-01/drizzle/20260806180000_add_calendar_dates/down.sql
ea3e1b292d9406564795bcd0897a5194ee0916e8 apps/be-01/drizzle/20260806180000_add_calendar_dates/migration.sql
483907bcac58735454729393856cda4d37f1527b apps/be-01/drizzle/20260806190000_add_teams_and_assignees/down.sql
f20d0c033ebfc99e7d4531ca3cbb061b4d7f33bb apps/be-01/drizzle/20260806190000_add_teams_and_assignees/migration.sql
1d716f11dca0defd012c109850571db85b9c97e5 apps/be-01/drizzle/20260807090000_add_revisions/down.sql
7621109850aba6a1436deb7e020c73fef6824c78 apps/be-01/drizzle/20260807090000_add_revisions/migration.sql
67c5926d0849a70bf5690b89bc6ace829b157238 apps/be-01/drizzle/20260807180000_add_command_journal/down.sql
bcb504e7370b314d46d64b5fc8cd6603c6884b05 apps/be-01/drizzle/20260807180000_add_command_journal/migration.sql
9193e579b729061181aad23378dda41ad7a68e89 apps/be-01/drizzle/20260809090000_add_role_position/down.sql
6b1964d010559c4152b2a8d2c7e17aec7594bb8b apps/be-01/drizzle/20260809090000_add_role_position/migration.sql
219a790de4ba22d5f399e6e39599fe0e22c41fb1 apps/be-01/drizzle/20260811100000_add_priority/down.sql
80dcf8d54c0d74bcf3c638e48fc308af2cbf81a2 apps/be-01/drizzle/20260811100000_add_priority/migration.sql
01b53c7a58b8b2e6d955fd513e6520335042c2a3 apps/be-01/drizzle/20260812100000_add_team_slots/down.sql
c96a08461f970d1c6dcaf1c321251e527b1ab1e5 apps/be-01/drizzle/20260812100000_add_team_slots/migration.sql
0d15408ed13681abb39b4b0da28f9ec53488dab2 apps/be-01/drizzle/20260812100001_add_max_parallel/down.sql
2cf338465d8c3339756d66f04f9db188245d9fbd apps/be-01/drizzle/20260812100001_add_max_parallel/migration.sql
0fec9aca5561f8f4b8f37a1b0b34fa0c28938640 apps/be-01/drizzle/20260813120000_add_project_team_capacity/down.sql
cb0847aa38272588cc18c25fb84c87ffe362d92d apps/be-01/drizzle/20260813120000_add_project_team_capacity/migration.sql
0cd521c5208b019f0c7b7b6cd2395b020bd2b834 apps/be-01/drizzle/20260814100000_add_work_item_team/down.sql
f643cceed802958e728a17d119ecdce1accbd93e apps/be-01/drizzle/20260814100000_add_work_item_team/migration.sql
25b9e9f4296ee0069a37854dde87f95811a376af apps/be-01/drizzle/20260814110000_add_priority_band/down.sql
274b883ef7f90e0696208e8fc8adbc9d0ecff438 apps/be-01/drizzle/20260814110000_add_priority_band/migration.sql
1e1e5d66e139f254c79e94c4276d0bbade18b004 apps/be-01/drizzle/20260817120000_add_plan_event/down.sql
2ab310ef72f036531b2585d8ca1f3a041bbca571 apps/be-01/drizzle/20260817120000_add_plan_event/migration.sql
ca275cebee7029b3cc1faa7c0bdddc9c9d9176cd apps/be-01/drizzle/20260817130000_add_actual/down.sql
92e91b051e2c5f7400b145ae3a7bc4f020720bad apps/be-01/drizzle/20260817130000_add_actual/migration.sql
0b6bf47411b87f1ddb5a5854b1e24a3ccf7afc55 apps/be-01/drizzle/20260818010000_add_role_progress/down.sql
58fb79876d376dcfda4c642e65a829578ae2a9dd apps/be-01/drizzle/20260818010000_add_role_progress/migration.sql
6fa33e1c224be1700abd0576a21ac3d0b2a15694 apps/be-01/drizzle/20260818090000_add_not_before_reason/down.sql
fa07c9224e5c8f006d40346808b05de78ef02a80 apps/be-01/drizzle/20260818090000_add_not_before_reason/migration.sql
a789d001f08947c296e85f676977ae9c20f8bcaf apps/be-01/drizzle/20260819120000_add_tag/down.sql
fc0b24f590f2ff1985194a1f1a88c0d050a2e83c apps/be-01/drizzle/20260819120000_add_tag/migration.sql
451c93653328fbae53d5435fabed3fe3026fd412 apps/be-01/drizzle/20260821000000_add_service/down.sql
d47ef172cc7b74dfa2e64743d68c5812b14c8b18 apps/be-01/drizzle/20260821000000_add_service/migration.sql
c6e2a730aeba2e193de7ae3ab833f6e3926e6744 apps/be-01/drizzle/20260821080000_add_work_item_service/down.sql
5183e7e800210ac8e38336c818753b335a5705d5 apps/be-01/drizzle/20260821080000_add_work_item_service/migration.sql
af7c98da40b9d0d73fa77d75b5ea5f867fdaa7b8 apps/be-01/drizzle/20260821140000_add_role_measure/down.sql
9ee57abd9b5fc45bc46a616c3bf9049998d27986 apps/be-01/drizzle/20260821140000_add_role_measure/migration.sql
c676628b4694133f43e5ebe2bfcd096166658c94 apps/be-01/drizzle/20260821150000_add_person_kind/down.sql
18eb7daf4066e85e14cb462ceacd1db82bb93ace apps/be-01/drizzle/20260821150000_add_person_kind/migration.sql
f030a4ab587675491c8e78076f3938e98765ae4e apps/be-01/drizzle/20260824010000_add_oidc_identity/down.sql
5e22aabd472e142204ed7537d0d224086ca03afd apps/be-01/drizzle/20260824010000_add_oidc_identity/migration.sql
6c4a991578af801d7dcefd214fec1075f311fe2d apps/be-01/drizzle/20260824020000_add_solution_ref/down.sql
fe53ccdbbbb1ef6132ab91b3ecca1ad49a5841c1 apps/be-01/drizzle/20260824020000_add_solution_ref/migration.sql
2008bdbfe33ef727fdac068e53cf5ab4512f6611 apps/be-01/drizzle/20260830010000_add_work_item_type/down.sql
a679e2e91d84da9278a90d8d0b5fbf54ccc67af1 apps/be-01/drizzle/20260830010000_add_work_item_type/migration.sql
00909c499a2e93ecbcc57072d5020dc4984f9118 apps/be-01/drizzle/20260830020000_add_external_ref/down.sql
541948e8f8da39fab3fc863dca841bcd3e1c25d5 apps/be-01/drizzle/20260830020000_add_external_ref/migration.sql
aa3393f7cc7bc7570879e42d684d4f3d82ebb9b5 apps/be-01/drizzle/20260830120000_add_dep_reach/down.sql
0e6b72c2a0e31051c82b3d46d616ff2f24ee1b18 apps/be-01/drizzle/20260830120000_add_dep_reach/migration.sql
c5077e81786a1e148f737097745761d241ec73b0 apps/be-01/drizzle/20260830130000_add_estimate_weights_and_rounding/down.sql
1e68889361055f13e6329a21eef747ff4b3f6332 apps/be-01/drizzle/20260830130000_add_estimate_weights_and_rounding/migration.sql
70338cf71ba765fceab0cf6412ee420a13b35286 apps/be-01/drizzle/20260831120000_rename_role_to_step/down.sql
d686c863b0142aa31a281c01ecca6ea31e016e61 apps/be-01/drizzle/20260831120000_rename_role_to_step/migration.sql
cebcadff1d611a427bf4049228c14217f0ea3bb1 apps/be-01/drizzle/20260901120000_add_audit_columns/down.sql
0ee66e37a6c146103a522773837a0e26e6e480c7 apps/be-01/drizzle/20260901120000_add_audit_columns/migration.sql
2467ed33ff24a58aac8d49fe43ac7eaac8b42bb5 apps/be-01/drizzle/20260902120000_add_lookup_indexes/down.sql
ce500929450f2a13c8656271be6e1c4dbc7b0cca apps/be-01/drizzle/20260902120000_add_lookup_indexes/migration.sql
df6d1b58b611072c5f7ec3515de03c4b896c5d3b apps/be-01/drizzle/20260903190000_add_saved_plan/down.sql
dc41efc8bceff38724b11f2693633593bd147b10 apps/be-01/drizzle/20260903190000_add_saved_plan/migration.sql
24643ad76544eb1abcfe61003dda41da22c1dd48 apps/be-01/drizzle/20260904020000_add_saved_plan_created_by_id/down.sql
94dd5005a145a17148a472d74c0e6454fa9905ed apps/be-01/drizzle/20260904020000_add_saved_plan_created_by_id/migration.sql
32cec0870271b9aec478139ac731bf878ea5397c apps/be-01/drizzle/20260904100000_add_optimizer_tables/down.sql
7cca9351faa000b37cd2e98324d2138c6c3c7a9a apps/be-01/drizzle/20260904100000_add_optimizer_tables/migration.sql
e097231126e1e9d286d5733e4a121b4c0e629bac apps/be-01/drizzle/20260904140000_add_project_settings/down.sql
6c12acb76a44d0284880d0f111df63722877b60d apps/be-01/drizzle/20260904140000_add_project_settings/migration.sql
7fb8949ea1d1392ce3e879e92dc373a9312d969d apps/be-01/drizzle/20260905090000_add_calendar_marker/down.sql
e2c8eb5c3099956456ac5bd3fdc4fbf7c3a2212a apps/be-01/drizzle/20260905090000_add_calendar_marker/migration.sql
2b496c88553a79c979bec664dce896e130a3662b apps/be-01/drizzle/20260906003000_add_work_item_read_order_index/down.sql
eb04cb96be42dd02044daba437a9cc5f250f596d apps/be-01/drizzle/20260906003000_add_work_item_read_order_index/migration.sql
4308945246a797ad161b478b5f8e88db7137d2ec apps/be-01/drizzle/20260906090000_add_work_item_deadline/down.sql
7927d2ec2d4509a02172c3541a36d71d6c90b8ae apps/be-01/drizzle/20260906090000_add_work_item_deadline/migration.sql
6ba9da365e56f9a3a884e64a3927150408706b09 apps/be-01/drizzle/20260909120000_add_external_ref_name/down.sql
99bbcc5c588438b16516ade2c72ec05227e1c9f1 apps/be-01/drizzle/20260909120000_add_external_ref_name/migration.sql
7da37ca28b0ebb66c7e77d03183b1bb38ccc42ff apps/be-01/drizzle/20260912120000_add_work_item_facts/down.sql
f070b61fe1cce1cdd1a537c2cfd3926bef496370 apps/be-01/drizzle/20260912120000_add_work_item_facts/migration.sql
```

## Deployment identities

The authoritative deploy contract remains:

```text
APP_NAME = { be: 'be-01', gw: 'gw-01', fe: 'fe-01' }
IMAGE_NAME = { be: 'wbs-be-01', gw: 'wbs-gw-01', fe: 'wbs-fe-01' }
PORT = { be: 3100, gw: 3200, fe: 80 }
mcp development PORT = 3300
frontend development default PORT = 4200
```

The project move must not change these values, the public alias keys above, `be-01.internal`, container/colour names, registry repositories, state paths, or environment filenames.
