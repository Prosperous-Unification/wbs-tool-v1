Implementation is blocked only on the completed `core-lib-extraction` handoff and current
solver-path ownership. These are ordered slices for one coordinated namespace candidate;
none has been executed. Read `design.md`'s mapping before assigning ownership. Names below
refer to the old root before slice 3 and its mapped destination afterward.

## 1. Pin scope and make nested projects visible

- [ ] 1.1 Pin the post-extraction commit, clean isolated worktree and complete Nx/project/alias
      inventory. Record all tracked literal and constructed app/lib paths, project selectors,
      wildcard cache inputs and cross-root relative reads in this change's implementation
      evidence. Check the nested supervisor project and all new extracted libs explicitly.
      Preserve a `(migration path, blob)` manifest and the values of `APP_NAME`, `IMAGE_NAME`,
      tier ports and public alias keys. Test: the inventory matches
      `bunx nx show projects --json` and every table row in `design.md`;
      no fixed minimum count is an oracle.
- [ ] 1.2 Reuse core extraction's recursive discovery, consolidate the shared entrypoint
      as `tools/tool-devsync/workspace-projects.mjs` and extend its fixture suite
      `src/workspace-projects.test.ts`; migrate any remaining shallow walks in
      `workspace-targets.test.ts` and `sync.test.ts`, including outside-read and deploy-union
      scans. Add the module to tool-devsync's lint scope and test inputs. Test: discover a
      project nested inside contracts and below product/ring directories, compare complete
      roots/names with the Nx graph; negative: restore a shallow traversal and observe the
      missing named project, then remove that nested project's ring and observe the actual
      totality target fail. Separate absent manifest (non-project directory) from unreadable
      manifest/directory and malformed JSON (required failures); exercise directory symlink
      rejection. Command: `bunx nx test tool-devsync --skip-nx-cache`.

## 2. Prove the product and layout rules before moving source

- [ ] 2.1 Implement `productConstraints(projects)` and use it in both relevant ESLint rule
      sets; tests remain exempt only from ring rules. In a temporary fixture workspace with
      installed dependencies referenced from this checkout, add `product:probe` projects
      importing own/shared/WBS aliases. Test: actual
      `bunx nx lint <probe-project> --skip-nx-cache`
      refuses the cross-product import in production and test files while
      own/shared controls pass. Negative: remove only the generated probe constraint and
      observe the forbidden-import oracle fail because lint passed; restore it. Also prove
      a shared-product lib cannot depend on WBS. No second product is committed.
- [ ] 2.2 Add `src/namespace-layout.test.ts` and the layout validator using enumerated
      projects. Exercise directory/ring disagreement, directory/product disagreement,
      unqualified Nx name, absent/duplicate scope/ring/runtime/product tags and product tags
      on tools. Watch each fault through the tool-devsync test target with that check
      removed. Pin both positive apps and all three library ring directories; use `adapters`
      to `ring:adapter` explicitly. Final-layout enforcement joins the repository in slice
      3; the fixture proof is executable before the move. These are ports-plan negatives
      10, 11 and the product half of 16, owned here rather than by core extraction.

## 3. Move projects and every active consumer in one candidate

- [ ] 3.1 Apply the exact root/name/tag/alias/output mapping in `design.md`, extracting the
      nested supervisor project before moving its old contracts parent. Rewrite manifests,
      tsconfigs, aliases, root scripts and ESLint path scopes in the same candidate. Test:
      project graph and alias keys preserve the pinned set; actual renamed app/library
      typechecks compile source and specs. Negative: inject a type error into a moved test
      file and observe its renamed Nx target fail; restore. Carry core's ring/runtime/
      SQLite negatives through their new paths; do not change their intended exemption.
- [ ] 3.2 Rewrite Vite/Vitest aliases and outputs, both Playwright configurations and tests,
      the packaged-build server, root lint source inputs, CI artifact paths and all
      cross-tree fixtures. Test: frontend configuration/test-tier suites and `wbs-fe-01`
      typecheck/build resolve the moved files. Negative: restore one old alias target and
      one omitted moved root lint input; observe the actual build/lint target fail with a
      deliberate source fault in the omitted file. Remove injected faults before proceeding.
- [ ] 3.3 Rewrite development setup/environment and solver paths in `tools/dev`, all four
      project selectors in `bin/dev.sh` and its test, MCP remote preflight path in
      `bin/dev-deploy.sh`, sync restart/solver-compatibility paths and tests. Test: setup
      operates in a temporary moved-layout fixture, supervisor still selects four apps,
      migration/config changes request restart and solver-image incompatibility refuses.
      Negative: restore each old path at its real caller and observe missing environment,
      missing restart or compatibility-refusal assertion. Do not edit a live remote `.env`.
- [ ] 3.4 Rewrite the Dagger Dockerfile map, image entrypoints, Docker COPY/WORKDIR/output
      paths, solver lock/package paths, image-smoke script, corpus-version hook and fixtures,
      migration-directory discovery, migration-lint root handling and lefthook SQL glob.
      Test: tool-dagger/deploy/git-hooks/devsync suites and moved migration CLI fixtures.
      Test migration discovery against two fixture commits spanning the directory rename:
      rename-only reports no new ids, a subsequent added migration still demands the flag.
      Negative: always select the new directory for the old deployed SHA and observe this
      comparison fail; absent/ambiguous migration roots produce named failure rather than
      zero migrations. A missing down script and missing root waiver script still refuse;
      restored old Docker COPY input must fail candidate image construction/input resolution.
      Assert preserved migration blobs and all pinned deployment identity values.
- [ ] 3.5 Correct recursive Nx inputs and every changed out-of-project read declaration,
      `.dockerignore` dev exclusion, `.prettierignore` migration snapshots and solver build
      ignores. Test: warm `tool-devsync:test`, mutate a nested manifest and a moved Dockerfile
      with separately invalid values and observe a cache miss plus the named failure.
      Negative: remove their input patterns and observe the stale-cache oracle fail. Restore
      inputs/faults; do not treat `--skip-nx-cache` as proof of cache coverage. Sweep active
      source/config/scripts for old paths, classifying documented historical occurrences.

## 4. Handoff and production-path evidence

- [ ] 4.1 Update current indexes/runbooks and JSDoc with final root paths and Nx names,
      preserving frozen OpenSpec/history references as historical. Reconcile read dependencies
      with Radical Modularity and any active solver packet. Test: resolved documentation links,
      complete migration/alias/project manifests and source/config path inventory on the
      actual candidate; `git diff --check` and
      `OPENSPEC_TELEMETRY=0 openspec validate repo-namespacing --strict --json`.
- [ ] 4.2 On the frozen candidate run `bin/h2puni-gate.sh` under its canonical host lock,
      then the complete browser gate with `CI=1 E2E_PORT_SHIFT=1900` on verified owned ports,
      and the packaged frontend check if its serving paths changed. Run the renamed backend
      image-smoke target with its required host prerequisites. Record actual commands,
      counts, timings, skipped cases and restored negative outputs in `verify.md`.
- [ ] 4.3 Build fresh executor bundles through the existing release workflow and run
      `bunx nx run tool-deploy:deploy --all --env=prod --dry-run` against the candidate's
      current release inputs. Respect existing release-manifest/clean-tree refusals; do not
      synthesize or reuse stale success evidence. Record all tier plans, moved build inputs
      and relative migration CLI resolution; a dry-run is not a publish or live deploy.
      If the required release inputs or host authority are unavailable, leave this task
      open with the exact prerequisite instead of claiming the namespace is deployment-ready.
- [ ] 4.4 Independent review of the complete namespace diff and observed failure-proof
      table, source restoration check, full OpenSpec validation and normal PR integration
      at the tested head. Archive only after all runtime/deployment obligations above have
      evidence; update the central queue without relabeling design preparation as completion.
