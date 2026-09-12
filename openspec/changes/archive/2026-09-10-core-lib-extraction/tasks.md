<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

Execute one numbered checkbox per reviewed slice. Read [design.md](design.md) and its
linked ADRs first. Checked boxes below are the pre-existing execution record, not new
verification. The 2026-09-08 preparation resolves the remaining decisions but does not
mark implementation or planned fault injections complete.

Paths below use the pre-namespacing layout. `repo-namespacing` follows this change. Before
each move, record the working revision and recheck active feature collisions; never copy
over another change's edits. Run focused tests from their owning project through Bun/Nx.
`bunx nx run <project>:typecheck` must compile both source and spec projects; add a new
root-level `.ts` file to its explicit lint target in the same slice.

## 1. The rings, before a single file moves

- [x] 1.1 **The totality test first, watched red.** `tools/tool-devsync/src/workspace-targets.test.ts`
      grows a case walking every `project.json` under `apps/`, `libs/` and `tools/`: exactly one
      `scope:`, one `ring:`, one `runtime:`. On `main` **two** projects carry a ring
      (`observability`, `runtime-portable`) and twenty-three do not, so it fails naming them —
      record the list, because that list is this slice's work.
- [x] 1.2 A `ring:` tag on every project. `tools/*` are `ring:adapter` (they call adapters and
      nothing calls them); `domain`, `contracts`, `validation` are `ring:domain`; the apps and
      the remaining libs are `ring:adapter`. Nothing is `ring:application` yet — there is no
      application project until slice 2.
- [x] 1.3 The `depConstraints` of plan §2 in `eslint.config.js`, with the `**/*.test.ts` and
      `**/testing/**` override. Negatives 6, 13 and 15 of §3.5 watched here — 4 and 5 name
      `@wbs/core`, which does not exist until slice 2, and are watched there rather than
      simulated against a project that is not the one the rule is about.
- [x] 1.4 `bunx nx run-many -t lint typecheck test` — the whole workspace, because a rule that
      changes what may import what is exactly the kind that passes per project and fails as a
      set (2026-08-30's import-sort incident).

  Historical checkbox retained, not a fresh whole-gate claim: `verify.md` records
  focused successful targets and a devsync run with six failures. Reconcile that
  record at 5.2; it does not establish a passing current workspace gate.

## 2. `libs/core`: the ports, the services, the use cases

- [x] 2.0 **Make project discovery complete before using its gates.** Add
      `tools/tool-devsync/workspace-projects.mjs` exporting `readProjects(workspace)`;
      recursively discover nested `project.json` files under apps/libs/tools even below
      another project. Return validated `{ root, name, tags, targets }`, exclude only
      named generated/dependency directories, reject symlinked project directories,
      duplicate names, unreadable/malformed manifests. Consolidate shallow walks in
      `workspace-targets.test.ts` and `sync.test.ts`; explicitly lint/track the root `.mjs`.
      Tests compare discovery to Nx's graph and name the nested supervisor-protocol
      project; temporary workspace negatives independently remove a ring/target, add a
      duplicate ring/name, and deny a directory/manifest read. Absence of a manifest on
      an ordinary directory is modeled, unreadability is not. Run `tool-devsync:test`
      plus lint/typecheck; require the intended fault diagnostic, not a fixture crash.
      Namespacing reuses this helper and later adds product/layout rules.

- [x] 2.1 The project: `project.json` with `ring:application` + `runtime:isomorphic`, its
      `tsconfig`s, and `typecheck` running `tsc --build --force` on the **source** project
      (R5 #16/#17 — a solution config compiles nothing). Watched failing on a deliberate
      `const deliberatelyWrong: number = 'not a number'`.
- [x] 2.2a **What has no adapter in its signature, moved first**: `WriteStamp`, `Clock` and
      the three runtime ports (`PasswordHasher`, `TokenCodec`, `Digest`). Twenty be-01 files
      import them from `@wbs/core` now; `repository/index.ts` re-exports `WriteStamp` for the
      ninety that name it there, which is an adapter naming its application's type and the
      right direction either way.
- [x] 2.2a.1 **The three signatures that blocked the store ports, dealt with**, which is
      what 2.2b builds the ports on. Each turned out to be a different answer, which is
      why they were worth naming rather than moving. `EventLogStore.recordEventIn(tx)`
      **splits off** as `EventLogTransactionalWrite`, an adapter-only interface: its one
      caller is the optimizer's atomic result-plus-event write, and what replaces it is
      that write moving onto `UnitOfWork.run` — `dual-optimized-scheduler`'s slice by the
      Wave 0 gate. `SavedPlanStore.holdingOf(db)`/`bodyOf(db)` are **deleted from the port**
      and were never port methods: their only callers are the adapter itself and its own
      database tests, and they were written in from the class's public surface rather
      than from what a caller needs. The four stored vocabularies — `SCHEDULE_ENGINES`,
      `MEASURE_METRICS`, `PERSON_KINDS`, `SOLVER_OBJECTIVES` — **move to `@wbs/domain`**,
      because a person's kind and a measure's unit are facts about the domain and the
      `CHECK` that enforces one is the adapter's way of storing a fact it did not invent;
      `schema.ts` re-exports all four so the column and the vocabulary cannot drift apart.
      `repository/index.ts` now imports `@wbs/core`, `@wbs/domain` and one `import type`
      from `event-log.ts`; `HistoryStores` and `Stores` moved beside the saved-plan ports.
      At this checkpoint `SavedPlanRow` remained Drizzle-inferred; completed slice 2.2b.1
      below subsequently made it explicit and moved the remaining history contracts into
      core.

- [x] 2.2b **Separate transaction-only methods from the ports (C1).** Create
      `libs/core/src/ports/{event-log-store,saved-plan-store,saved-plan-capture-store}.ts`.
      Keep `recordEventIn`, `holdingOf` and `bodyOf` on the SQLite classes; retarget the
      optimizer's concrete `Pick` and the memory event-log fixture. Change
      `SavedPlanServiceOptions` and `captureAndSchedulePlan` to accept ports, not classes.
      Define their referenced neutral values here too, including explicit SavedPlanRow
      and PlanInputReads; 2.2b.1 moves the remaining contracts and adds the full type checks.
      A temporary port importing its value type back from be-01 is not an intermediate state.
      Tests: `repository/event-log.db.test.ts`, `service/optimization-events.db.test.ts`,
      `service/saved-plan-{atomicity,quota,busy}.db.test.ts`,
      `repository/saved-plan-capture.db.test.ts`; add `ports/store-boundaries.test.ts`
      compiling a port consumer without importing SQLite. Negative: throw at event insert
      after the cache write and assert neither row survives through
      `storeOptimizedOutcomeAndRecord`; run quota races through `SavedPlanService.save`,
      moving the quota check outside the transaction to observe excess saved plans.
      Keep the event fault inside the transaction, not before the cache write.

- [x] 2.2b.1 **Move value contracts before consumers (C1/C2).** Split
      `repository/index.ts` into `core/ports/<noun>-store.ts` and `ports/stores.ts`.
      Preserve all members and JSDoc; `PlanTransactionalStores` excludes only `users`,
      `TransactionalStores` adds `AccountStores`, and `HistoryStores` remains separate.
      Move literal domain unions out of `schema.ts`, with the schema importing the same
      declaration. Make `SavedPlanRow` explicit; add two-way type tests against the
      adapter's inferred row. Tests: `ports/stores.types.test.ts` compiled by
      `core:typecheck` and `store-contracts.types.test.ts` compiled by `be-01:typecheck`.
      Negative: `scope.stores.savedPlans` fails to compile through a valid scope fixture;
      deliberately drop a nullable saved-plan column and watch the adapter type test fail.

- [x] 2.2b.2 **Construct command services from the admitted scope (C2).** Change
      `PlanCommandRunnerOptions.batchServices` to `(scope, broadcast) => WritingServices`,
      add `publicServices`, and move construction inside both `execute` and `walk`.
      `afterRollback(scope)` discards through that surviving scope; postcommit tree and
      undo reads use the public graph. Add `plan-command-scope.test.ts`: a staged source
      with distinct public/staged/repair stores drives a real runner command, refusal,
      undo, redo and subsequent batch. Faults: build from public stores (writes survive
      refusal), reuse the first staged graph (second batch's write missing), repair through
      discarded scope (journal entry remains). Assert stored values after settlement and
      repair while a second writer waits. Preserve `announcement-ownership.db.test.ts`,
      `plan-commands.db.test.ts` and the whole current unit-of-work conformance suite.

- [x] 2.2b.3 **Extract runtime value types and pure deadline logic (C4).** Move
      `Logger`/no-op to contracts, `Timers` to `core/ports/timers.ts`, and the four pure
      deadline helpers to `core/runtime/deadline.ts`. Runtime-portable reexports those
      names and keeps only concrete timers/digest adapters. Make `clockOf` arguments and
      consuming clocks required; production constructors receive the root's clock.
      Tests: existing clock, push-deadline, retention-timer and saved-plan-retry suites.
      Negative: omit the clock at a real `WorkItemService`/`AuthService` construction and
      require typecheck failure. The restored global-default lint fault is owned by 2.3,
      after its rule is installed. Retain existing timeout, delayed-timer and cleanup faults through
      their production callers. Run `core:typecheck`, `runtime-portable:typecheck`,
      `be-01:typecheck` and touched lint targets after the cross-project move.

- [x] 2.2b.4 **Put OIDC failure classification behind its port (C4).** Add
      `core/ports/oidc-verifier.ts` and contract identity value types. The `@wbs/auth`
      adapter owns today's exact invalid-credential classification and returns null only
      for those cases. `AuthService` takes `OidcVerifier`; account lookup remains outside
      verifier classification, and configured local-token fallback remains unchanged.
      Tests: `auth-service-null-password.test.ts`, all mounted account-store/verifier
      outage cases in `controller/auth-password-endpoints.test.ts` and
      `controller/oidc.integration.test.ts`, plus a literal service test for invalid
      OIDC with password fallback on/off. Faults: map a JWKS/network error to null,
      enclose account resolution in the credential catch, or fallback when disabled;
      assert existing 500/401/200 distinctions at the mounted route and the service.

- [x] 2.2c **Move directory and project service families (C4).** Move
      auth/project/step/directory/capacity/priority/calendar services.
      Preserve basenames under `libs/core/src/service/`. `servicesOver` takes
      `PlanTransactionalStores`, not `ReturnType<typeof buildStores>`; pure predicates
      currently imported from repositories move with their contracts. This family runs its existing tests at
      the new location plus `bun run test:unit`; record any count change by file and reason.
      Dependency gate: no import from `apps/`, SQLite schema or runtime adapters in moved
      production files. Verify by lint and its adjacent-production-file fault, not `rg`
      alone. Do not move the optimizer/process files into core to make this checkbox easy.

  Prerequisite for this family and the next two: finish `scheduler-runtime-port`
  after 2.2b.4. ProjectService also consumes its capability, so do not wait until the
  work-item move to complete that packet. A service can be moved only after every
  imported core sibling it needs is present; move shared pure sibling helpers first
  within the family and leave adapter consumers pointing inward through reexports.

- [x] 2.2c.1 **Move work-item services and their pure satellites (C4).** Requires
      `scheduler-runtime-port`. Move `work-item.service.ts`, command runner/normalizer,
      derivation, compensation and dependency helpers to `core/service/`, retaining
      basenames. Use the port contracts already extracted; no schema/adapter imports.
      Tests: existing work-item, estimate, actual, progress, measure, dependency,
      revision, freeze, undo and plan-commands suites plus `plan-command-scope.test.ts`.
      Verify no production core-to-app edge with actual lint; inject such an edge to
      observe its diagnostic. Compare every pre-move test file with its new location.

- [x] 2.2c.2 **Move saved-plan and publication services (C4).** Move saved-plan pure
      helpers, history, replay, retention and broadcaster services to `core/service/`.
      `GatewayBroadcaster` receives `PushTransport`; the concrete HTTP retry client stays
      in `runtime-portable/src/push-client.ts`. Tests: the existing saved-plan suites,
      replay/retention tests and gateway durability/order tests. Retain the named push
      deadline/cleanup fault oracles and independent history commit/rollback cases.
      Run touched targets and root unit tier; keep DB-only tests with their adapter.

- [x] 2.2d **Move endpoint bindings and extract use-case admission (C5).** Create
      `core/http/endpoint.ts`, move framework-free bindings, and create
      `core/use-cases/{run-command-batch,save-plan,replay,retention-sweep}.ts` with C5's
      inputs and outcomes. Move ownership/scope checks and success-only publication with
      the use case; preserve pre-parse HTTP policies. Tests: direct use-case tests with
      read-only actor, wrong project owner, absent account and noninternal caller, plus
      existing `http/elysia/*` and controller route tests. Faults: remove write-scope or
      owner check and observe a direct caller mutate; move publication before save and
      observe an event on a quota refusal. Every shape must still bind exactly once.

- [x] 2.3 **Enforce the production/test boundary (C7).** Extend existing ring rules and
      bans to the new core/domain paths and actual test suffixes. Test the effective ESLint
      configuration on temporary sibling production/test files using production lint
      targets, not a copy of the rule. Watch ports plan §3.5 negatives 1–4, 6, 9, 12 and
      15 individually, including `globalThis.fetch`, `globalThis['fetch']`, driver imports,
      frontend-to-core imports. The browser-adapter constraint is generic:
      `allSourceTags: ['ring:adapter','runtime:browser']` permits domain-ring dependencies
      or browser adapters, never application-ring code. `bun:test` in a core test must
      pass and next-door production must fail. Cases5/13 involving actual store projects
      run in4.3 after those projects exist. Record
      diagnostics, not merely nonzero exits caused by malformed fixtures. Product/layout
      negatives 10/11/product half of16 belong to repo-namespacing, not this checkbox.

## 3. `libs/store-sqlite` and `libs/store-memory`

- [x] 3.1 **Move SQLite as one source (C1/C3/C4).** Create `libs/store-sqlite` with
      `ring:adapter`, `runtime:bun`; move adapters, schema, connection/migration runners,
      coordinator, `buildStores` and their database tests. Expose `openSqliteSource` with
      C3's opened-source interface and independent history. Re-aim connection/Drizzle
      safety rules at the moved production call paths. Tests: `db.test.ts`, migration
      round-trip tests, `write-coordinator.db.test.ts`, saved-plan capture/busy tests and
      the source kits. Negative7: open a connection outside `store-sqlite/db.ts` and
      require the actual library lint target to report the ban. Missing/unreadable
      migration folders still throw. Run `store-sqlite:test`, lint and source/spec typecheck.

- [x] 3.2 **Keep deploy entrypoints stable.** `apps/be-01/drizzle/` and
      `migrate-cli.ts`, `migrate-down-cli.ts`, `migrate-status-cli.ts` remain in place and
      import the moved runners. Existing Dockerfiles retain their SQL copy paths. Tests:
      migration CLI and deployment command fixtures; inject a wrong runner import/path
      and require an actual CLI invocation on an isolated temporary database to fail.
      Up then down must still reproduce the prior schema. Do not apply migrations to a
      shared or deployed database for this check.

- [x] 3.3 **Promote one staged memory source (C6).** Create `libs/store-memory`, moving
      reusable fixtures and making `MemoryState` the single owner of transactional table
      values. Construct subtrees and public dependencies over the same dependency table.
      Implement `openMemorySource`, coordinator, fresh scope per act and independent
      history/capture. Tests: real source `memory-source.test.ts`, source conformance and
      unit-of-work conformance. Faults: swap history with staged state (successful save
      disappears on commit), return mutable stored arrays (caller edit changes storage),
      give subtrees a second dependency table (copied/deleted edges wrong), gate admitted
      stores (bounded deadlock assertion), and reuse staged state after rollback (next
      batch sees refused write). The four composition cases may not be on the allowlist.

  Also call the production SavedPlanService.save while a batch is held: capture
  reads committed values and the successful independent save survives either terminal
  decision. Fault: take the command gate in capture, observe the named bounded
  pending/deadlock assertion before releasing the batch in test cleanup. A direct
  history.write test alone cannot prove this save path. Keep the separate SQLite
  immediate-busy mechanism case; never claim it performed an interleaved success.

## 4. `libs/conformance`, and the proof the ports are ports

- [x] 4.1 **Move conformance without a dependency cycle.** Move `testing/kits/` to
      `libs/conformance` (`ring:application`, `runtime:bun`). Kits import core ports and
      take source factories; they never instantiate/import SQLite or memory production
      adapters. Each source's test file imports the kits and supplies its own factory.
      Tests: both source targets print the named ran/not-offered case report. Fault:
      delete one factory's kit registration and require an independent certification
      coverage test to report that source/case missing. The remaining thirteen kits are
      specified by source-conformance-completion, not claimed by moving these four.

- [x] 4.2 **Compose public and admitted services exactly once per lifetime.** Implement
      `core/compose.ts` C2/C3 and its accountful/accountless overloads; boot passes opened
      source and runtime ports, saved plans included. Tests: `core/src/compose.test.ts`
      runs a mixed-store batch commit/refusal, denied and permitted save, replay after
      commit, and retention that waits for batch release. Assert the same public buffer,
      clock and scheduler are used across two batches and that collectors/scopes differ.
      Faults: create a second buffer (replay loses new event), reuse a collector (one
      batch swallows another event), discard through old scope (stale journal retained),
      instantiate a second public graph in HTTP boot (the identity assertion fails).
      Compile an accountless graph fixture and assert its `auth` access fails; first
      compile the valid fixture so an absent declaration cannot satisfy the negative.

- [x] 4.2a **Execute the portable composition in a browser.** Add
      `libs/core/testing/portable-composition.ts` (no test-runner imports),
      `portable-composition.spec.ts`, `libs/core/playwright.config.ts` and Nx build/test
      targets. Scope Bun `test`/`test:unit` to `src`, so Bun never collects this Playwright
      spec. Add a referenced portable-test tsconfig covering `testing/**` and the config,
      and name both in lint. Inject a type error and lint error into the new files and
      observe the actual targets reject them. Bundle browser ESM through Bun; bootstrap
      a fresh Chromium page at intercepted `https://core-probe.invalid/` with a static
      HTML response and assert `isSecureContext` plus `crypto.subtle` before injection.
      This one synthetic bootstrap is fulfilled by Playwright; every other request fails
      and there is no webServer or actual network. The probe uses memory source and Web Crypto digest, fixed clock,
      controllable timers and an in-page push recorder. Run the same batch/save/replay/
      retention acceptance including denied actor and rollback. Any network request fails;
      require a completion record containing assertions for all four named operations.
      Faults: production `Bun` reference fails in Chromium, skipped operation fails the
      independently asserted completion record, stubbed save fails read-back. Run
      `bunx nx run core:test:portable` after its build dependency; retain the output and
      bundle identity. A Bun-only test cannot complete this checkbox.

- [x] 4.3 **Close the original enforcement inventory.** In `verify.md`, give each of
      ports plan §3.5's sixteen negatives one disposition: observed here with diagnostic,
      existing evidence revalidated on this tree, or explicitly owned by repo-namespacing.
      Cases5/13 import the now-existing store-sqlite/store-memory projects from core and
      fail the generic ring rule; the same memory import in a test passes. Case14 removes
      a real binding and fails the endpoint coverage test; case12/tool
      half16 remove/duplicate ring tags from discovered nested projects. Neither a failed
      fixture setup nor an unreadable-output default counts as a failed assertion.

## 5. The gate, and the docs

- [x] 5.1 **Discover every fast-tier project.** Change the root `test:unit` script to
      `nx run-many -t test:unit`; declare library targets for the eligible unit suites,
      preserving be-01's split and excluding process/browser/Python suites. Reuse2.0's
      complete nested-project discovery in `workspace-targets.test.ts` for totality.
      Negative: create a nested eligible library with one deliberately failing test and
      watch the root command fail on that assertion; a missing target must fail the
      separate inventory assertion. The fast tier cannot certify that it includes itself
      by enumerating only projects which already have the target.

- [x] 5.2 **Run the complete gate on the frozen landing tree.** Record revision,
      commands, elapsed time, counts and all unavailable checks in `verify.md`.
      On h2puni run `bin/h2puni-gate.sh`; run `openspec validate --all --json` and the
      complete Chromium gate with `CI=1 E2E_PORT_SHIFT=1900 bun run e2e` after proving
      those ports are free and belong to this checkout. Include `core:test:portable`,
      source conformance and all moved database tests. Review the final full diff after
      any fixes; green evidence from a predecessor does not cover a changed head.

- [x] 5.3 **Reconcile docs with evidence.** Update `LLM_README.md` links and the queue,
      mark ADR0014/0015 accepted when their implementation obligations are met, and
      explain moved tests/count differences and source capability limits. Each `Proof:`
      comment comes from the observed failure, not the planned row above. Delta specs
      remain pending sync until this implemented change is archived. The scheduler and
      namespacing ownership links must resolve; they are not silently ticked by this gate.
