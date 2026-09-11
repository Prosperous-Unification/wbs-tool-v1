## Context

Reconciled against checkout `339708fa`, 2026-09-08. The rings and
`libs/core/src/ports/{clock,runtime,write-stamp}.ts` already exist. The source-independent
service graph does not yet exist: `services.ts` types its stores as the return type of
`buildStores`, `SavedPlanService` names concrete repositories, `AuthService` imports `jose`
and `@wbs/auth`, and `PlanCommandRunner` constructs its graph before its unit of work and
ignores the scope passed to the act. These are extraction prerequisites, not file moves.

Authority: [ADR 0014](../../../docs/adr/0014-ports-live-in-a-framework-free-core-lib.md),
[ADR 0015](../../../docs/adr/0015-a-command-batch-is-a-unit-of-work-the-source-implements.md),
[ADR 0018](../../../docs/adr/0018-adapter-transactions-stay-outside-core-ports.md).
User-authorized assumptions are recorded in
[execution readiness](../../../docs/refactoring/execution-readiness.md).

## Goals / Non-Goals

**Goals:** one source-independent service composition; public and admitted graphs with
distinct lifetimes; portable executable composition over a real staged memory source;
enforced dependency direction and complete test discovery after relocation.

**Non-Goals:** browser UI mode, new persistence backends, database migrations, replacing
solver supervision, repository namespacing, and filling every memory-source capability.
The independently planned scheduler boundary and conformance completion are prerequisites
or successors named below, not work that may disappear behind these non-goals.

## Decisions

### C1. Transaction-specific operations are adapter methods

`core/ports/event-log-store.ts` owns `RecordedEvent` and the five asynchronous methods
`recordEvent`, `rangeSince`, `oldestSeq`, `latestSeq`, `pruneBeyond`, retaining current
arguments and answers. `recordEventIn` is absent. `store-sqlite/event-log.ts` retains
`EventLogTransaction` and `DrizzleEventLogStore.recordEventIn` for SQLite callers.
The optimizer's `eventLog` dependency becomes
`Pick<DrizzleEventLogStore, 'recordEventIn'>` in its adapter code. Its
`storeOptimizedOutcomeAndRecord` moves to `store-sqlite/optimized-outcome.ts`, with the
result write and event insert inside the same existing `db.transaction` callback. Core
never receives that function, its transaction, or its concrete store.

`core/ports/saved-plan-store.ts` owns the existing source-neutral records, write callbacks,
outcomes and methods `write`, `readOf`, `listOf`, `principalsOf`, `renameTo`, `deleteOf`.
`holdingOf` and `bodyOf` remain SQLite adapter helpers. The quota `check` passed to `write`
continues to receive a holding measured inside that write; do not replace it with a
preflight call. `core/ports/saved-plan-capture-store.ts` owns `PlanInputReads` and
`SavedPlanCaptureStore.readPlanInput`. `SavedPlanService` and `captureAndSchedulePlan`
depend on these ports. Saved-plan capture still opens its own connection and closes it
before scheduling. `bodyByteLength` is pure UTF-8 byte counting in
`core/service/saved-plan-integrity.ts` using `TextEncoder`.

`SavedPlanRow` becomes an explicit value type in `core/ports/saved-plan-store.ts`, with the
same fields and nullability as the current Drizzle select. Its adapter has a type-level
assignment check in both directions against `typeof savedPlan.$inferSelect`; the port
does not infer its type from a schema in an outer ring. Apply the same rule to
`PersonKind`, `MeasureMetric`, `ScheduleEngine`, `SolverObjectiveName` and
`SolverFailureReason`: pure literals live in `domain` (reuse an existing declaration when
present), and the SQLite schema imports them to build its checks. No cast bridges drift.

`STEP_POSITION_STEP`, `stepIsInUse` and its `StepHoldings` value type move to
`libs/domain/src/step.ts` and are exported by `@wbs/domain`; they describe step facts,
not database operations. Retarget their service, SQLite and memory callers to that one
declaration. Preserve their values, predicate and shape; no core-to-repository import
or duplicated source-specific predicate remains.

### C2. Scope is an argument, never a closed-over adapter graph

Keep the existing unit-of-work result protocol. Parameterize its scope over the stores
offered by the source; commands need the plan/directory stores and durable event log,
not an account store. The public SQLite `TransactionalStores` alias remains the full
intersection for adapter callers.

```ts
interface Scope<S extends PlanTransactionalStores = PlanTransactionalStores> {
  stores: S;
}
type Decision<T, S extends PlanTransactionalStores = PlanTransactionalStores> =
  | { commit: true; value: T }
  | { commit: false; value: T; afterRollback?: (scope: Scope<S>) => Promise<void> };
interface UnitOfWork<S extends PlanTransactionalStores = PlanTransactionalStores> {
  run<T>(act: (scope: Scope<S>) => Promise<Decision<T, S>>): Promise<T>;
}
interface PlanCommandRunnerOptions {
  batchServices: (scope: Scope, broadcast: Broadcaster) => WritingServices;
  publicServices: WritingServices;
  uow: UnitOfWork;
  announcements: Broadcaster;
}
```

`PlanTransactionalStores` contains the current transactional members except `users`;
`AccountStores` contains `users: UserStore & OidcIdentityStore`.
`TransactionalStores = PlanTransactionalStores & AccountStores` preserves SQLite's full
type. `HistoryStores` remains separate and absent from `Scope`.
`type Stores = TransactionalStores & HistoryStores` is the neutral full-catalog value
alias used to index conformance port signatures. It does not change the `Source<S>`
composition: an accountless `Source<PlanTransactionalStores>` still has no users store,
and its history remains outside the admitted scope rather than flattened into it.

In `execute` and `walk`, construct the collector per invocation, construct the graph only
inside the admitted callback, and use `publicServices` after `run` returns. `afterRollback`
uses its callback's scope to discard the journal entry, before release. It must not use
the original `workItems` closure. Fresh scope graphs share the clock and optimizer reader
but never a collector or a mutable working plan. Existing publication ordering is retained;
this change must not silently move durable event writes into or out of a transaction.

### C3. An opened source is the composition input

```ts
type SourceHealth = { ok: true } | { ok: false; reason: 'unavailable' };
interface Source<S extends PlanTransactionalStores = PlanTransactionalStores> {
  readonly stores: S;
  readonly history: HistoryStores;
  readonly uow: UnitOfWork<S>;
  health(): Promise<SourceHealth>;
  close(): Promise<void>;
}
```

`openSqliteSource(options)` and `openMemorySource(options)` return an opened source;
there is no half-open object on which a service might run. SQLite options own the database
path and the connection factory; opening does not migrate. The existing migrate CLIs
remain the deployment authority. `health` models known unavailability, and unknown
corruption or programming failures throw with context. `close` is idempotent and must
surface cleanup failures; boot stops retention and the optimizer before closing the source.

`composeServices({ source, runtime, shared })` is the only service graph factory.
`servicesOver(stores, { clock, broadcast, scheduler })` is its pure transactional half.
`runtime` contains required `clock`, `digest`, `timers`, `intervals`, `push` and `scheduler`
ports. `shared` contains `logger` and the existing configured replay/retention limits;
the factory constructs one buffer, throttle and public broadcaster. It does not start
timers, migrate, listen, load configuration, or open a database.

Account capability is explicit through two composition overloads: a
`Source<TransactionalStores>` together with required account runtime
`{ passwords, tokens, oidc?, passwordSessions, localIdentity? }` returns a graph with
`auth`; a `Source<PlanTransactionalStores>` with no account runtime returns a graph
without an `auth` property. A core test asserts `graph.auth` is a compile error for the
second overload. No fake account store throwing at login and no optional chained calls
substitute for absence. Both graphs include saved-plan history because the composition
proof must save, read and retain a plan independently of the batch.

### C4. Runtime extraction is an explicit file classification

| Current authority                                                                                                          | Destination and invariant                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `repository/index.ts`                                                                                                      | `core/ports/*-store.ts`, one port and its value types per file; `ports/stores.ts` composes them; root index reexports                |
| `services.ts`                                                                                                              | `core/compose.ts` for graph construction; `store-sqlite/source.ts` for `buildStores`; be-01 keeps adapter options                    |
| `service/unit-of-work.ts`                                                                                                  | `core/ports/unit-of-work.ts`; SQLite's gate/coordinator stays in `store-sqlite/gate.ts`                                              |
| Pure `service/*.ts`                                                                                                        | `core/service/<same basename>.ts`, with adjacent pure tests; names and behavior retained                                             |
| `http/endpoint.ts` and framework-free endpoint builders                                                                    | `core/http/endpoint.ts` and `core/http/<same basename>.ts`                                                                           |
| Elysia mounts, credential extraction, OIDC redirects/cookies, metrics/health IO                                            | remain be-01 adapters; builders consume ports and bind injected adapter callbacks                                                    |
| `repository/{schema,db,migrate,...}.ts`                                                                                    | `store-sqlite/src/<same basename>.ts`; all database-only tests and schema fixtures follow                                            |
| `testing/*-fixture.ts`, staged memory source                                                                               | `store-memory/src/`; recording counters belong in `testing/`, not the production port                                                |
| `testing/kits/*`                                                                                                           | `conformance/src/`; source factories are supplied by each adapter's own tests                                                        |
| `service/optimization-coordinator.ts`, `solver-{child-lifecycle,launcher-process,supervisor-client,supervisor-spawner}.ts` | be-01 `runtime/optimization/` for process orchestration; their SQL helpers move to `store-sqlite`; core sees only the scheduler port |
| `optimizationVariantState`, cache row decoding, `scheduleInputHash`                                                        | SQLite adapter; only public read value types enter core; canonical schedule serialization remains in domain                          |

Before each move, classify the actual file's imports and globals; the table defines the
destination rule for files added after this inventory. A newly discovered adapter import
must be assigned to one of the named ports before the file moves. Never leave an unchecked
cast, new lint exception, or app-to-core back-import to make the move compile.

`Logger` and its no-op move from `@wbs/observability` to `@wbs/contracts`; observability
reexports them. Pure OIDC identity value types (`OidcIdentity`, `WbsScope`) move to
contracts. `OidcVerifier.verify(token): Promise<OidcIdentity | null>` is a core port;
the auth adapter runs today's verification, claims parsing and exact
`isInvalidCredential` classification. Only the existing credential failures return null;
network/discovery/malformed-JWKS faults and account-store failures still throw. Core
uses `passwordSessions` to decide whether a null OIDC answer permits local-token fallback.

The real timer adapter remains in `runtime-portable`. `Timers` moves to core ports;
pure `DeadlineExceeded`, `withinDeadline`, `untilAborted` and `delay` move to
`core/runtime/deadline.ts`, and runtime-portable reexports them. This removes the current
core-to-adapter dependency through `PushClient`. `clockOf` takes required `now` and
`newId` functions; the runtime owns `Date.now`/`crypto.randomUUID`. Constructors take a
required clock. Runtime defaults are replaced at every production caller and test factory,
not with a dummy global in core.

`PushTransport.push(payload, signal?): Promise<{ delivered: number }>` owns HTTP and its
bounded retries in an adapter. Core's broadcaster owns durable-record-before-delivery and
buffering. It consumes that port, not the concrete `PushClient`. `Intervals` has
`every(milliseconds, callback): () => void`; stopping retention cancels the returned
subscription and awaits its current sweep. Reuse the existing suppression-of-overlap and
stop-drains tests through this interface.

The synchronous scheduling contract and engine-unavailable response are specified by
[scheduler-runtime-port](../2026-09-10-scheduler-runtime-port/design.md), whose implementation must
precede moving the scheduling consumers. They preserve the current distinction between an
installed optimizer with pending/failed results and a source with no optimized capability.

### C5. Use cases retain admission and publication

Public entrypoints live in `core/use-cases/`. Export types by named interfaces, retaining
current `BatchOutcome`, `SavedPlanSaveOutcome`, `ReplayOutcome` and refusal details.

| Function                                                 | Input and result                                                                                                                           | Obligations retained                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runCommandBatch(graph, { projectId, actor, commands })` | authenticated actor `{ id, username, scopes }`; `Promise<BatchOutcome>` plus the existing unauthorized/insufficient-scope refusal envelope | require write scope, keep command/project ownership/ref resolution in runner/services; no caller may mint actor identity from a request body     |
| `savePlan(graph, { projectId, actor, name? })`           | `Promise<SavedPlanUseCaseOutcome>`: existing save outcomes plus `not_found`, `forbidden`, `insufficient_scope`                             | project access check, creator id/name from actor, save via independent history, publish once after success; no publication on quota/busy refusal |
| `replay(graph, { resumePoints, principal })`             | `resumePoints: Record<string, number>`; exact `ReplayOrchestrator.replay` answer; principal must be internal                               | preserve internal admission and bounded range/buffer semantics                                                                                   |
| `retentionSweep(graph, { principal })`                   | internal principal; `{ eventLogRemoved, planEventsRemoved }`                                                                               | run existing event-log count and plan-event age sweeps through public gated stores, preserve cancellation and retention limits                   |

Use cases trust only a principal supplied by an authentication/trigger adapter, never an
external JSON object. HTTP request policies continue to run before body parsing. HTTP
builders merely map use-case outcomes to the existing status-specific shapes; their
authorization cannot be the only authorization. Moving a guard is accompanied by both a
literal non-HTTP refusal test and the existing mounted-route regression.

`savePlan` names a function in core and an endpoint shape in contracts; the HTTP builder
imports the latter as `savePlanShape`, an explicit scope qualifier rather than renaming the
external operation id.

### C6. Memory is staged state, not a clone of objects with methods

`MemoryState` stores tables (rows, junctions, sequencers, journals) as cloneable values.
`buildMemoryStores(() => state, gate)` binds every port, including subtrees and
dependencies, to the same table state. The existing `inMemoryStores` currently builds a
second dependency fixture for subtrees; promotion must remove that split. Store instances
and closures are never passed to `structuredClone`.

An admitted act gets a clone of transactional tables and fresh store closures. Commit
swaps only those tables. Rollback repair gets fresh admitted closures over surviving
tables. Independent history lives in a distinct state object, so its concurrent successful
write survives either settlement. Public transactional writes take the source coordinator's
turn; admitted stores use `OPEN`. History writes and captures do not take that coordinator.
Memory capture clones committed transactional state synchronously at capture entry, not
an admitted graph's staged state, and returns detached reads from that epoch. A production
`SavedPlanService.save` must settle while another batch remains held; testing only
`history.savedPlans.write` would miss a capture that deadlocks before the write. SQLite's
capture retains its independent read connection. Values returned from storage must not allow callers to mutate
the stored state through an old array reference.

Implement enough real memory history/capture to run the four composition use cases and
their refusal paths. Additional conformance cases are owned by
[source-conformance-completion](../source-conformance-completion/tasks.md); the existing
allowlist remains named and visible. Neither unit-of-work correctness nor the four
composition acceptance cases can be allowlisted or stubbed.

Independent history does not promise that SQLite can successfully write through another
connection's held write lock. Both sources prove a successfully prewritten saved plan
survives command-batch commit and rollback. SQLite separately proves its history attempt
returns `snapshot_busy` while the conflicting batch remains held; staged memory must
actually return `written` for an interleaved history write and read back that exact saved
ID after either settlement. The conformance declaration names these mechanisms as
`historyAdmission: 'immediate-busy' | 'independent-write'`; this is test-adapter metadata,
not a new production source option. A busy/refused attempt never counts as successful-save
survival, and no conditional early return can replace that assertion. The exact mechanism
cases live in [source conformance completion](../source-conformance-completion/design.md).

### C7. Enforcement follows the effective runtime of each file

Core production is isomorphic and imports no driver or global runtime default. Core's Bun
unit tests may import `bun:test` and memory adapters under a test-only ring/import
exception. This does not make production `runtime:bun`; use a spec-file runtime rule that
permits the runner while retaining a browser runtime prohibition in frontend specs.
The exemption covers the actual tracked suffixes (`*.test.ts`, `*.test.tsx`,
`*.spec.ts`, `*.property.test.ts`) only where those are tests, and never the adjacent
production file. Runtime assertions still apply to code under test.

Browser adapters have the explicit additional Nx constraint
`allSourceTags: ['ring:adapter', 'runtime:browser']`: depend only on the domain ring or
other browser adapters. Test-only ring exemptions do not exempt frontend tests from their
runtime restrictions. This is the generic policy behind the frontend-to-core negative.

The portable composition proof is executed in Chromium through an Nx `test:portable`
target. `libs/core/testing/portable-composition.ts` is a pure probe bundled with Bun's
browser target; `libs/core/testing/portable-composition.spec.ts` loads that bundle into
a fresh page with `addScriptTag` and reads its completion record. Playwright fulfills a
single synthetic HTTPS bootstrap at `https://core-probe.invalid/`; the case asserts secure
context and Web Crypto before injecting the bundle, and rejects every other request.
Its config starts no backend, gateway or solver and uses no actual network. Bun tests are
scoped to `src`; a separately referenced portable-test tsconfig and explicit lint inputs
cover the probe, Playwright spec and root config. Both discovery boundaries have injected
type/lint failures in their own newly covered files.
A Bun test which imports no `bun:sqlite` proves the dependency subset, not execution
without Bun. The bundle must contain neither Bun shims nor unresolved `@wbs/` aliases.
Build tooling may use Bun; the executing environment may not. Inject a production `Bun`
access and observe the browser probe fail before claiming portability. The build and
Playwright commands are Nx targets run through Bun, preserving the repository toolchain.

`test:unit` selects a named Nx `test:unit` target, not a list of project names. Every
library eligible for the fast tier declares that target; be-01 keeps its existing focused
unit command. A discovery test independently enumerates projects and asserts coverage
of the eligible set. A new lib's deliberately failing test must fail the root command.
Do not include Python, process integration or DOM suites merely because a new project exists.

Enforcement negatives 10, 11 and the product-tag half of 16 in ports plan §3.5 belong to
`repo-namespacing`; this change owns the other negatives and the recursive discovery
prerequisite that proves they find nested projects. Do not mark a namespacing check done
before the corresponding layout and product policy exists.

## Risks / Trade-offs

The broad source move intersects active optimizer work. The event-log port split can land
independently because it preserves the adapter operation; moving optimizer files must use
the merged scheduler feature and scheduler-runtime-port revision, not overwrite the current
working edits. Core consumer moves change package imports, so existing integration tests
remain mandatory even when a narrow source test passes.

The current memory fixtures are useful implementations, but the kits do not prove every
contract. The staged-source and non-Bun composition tests are separate deliverables; existing
kit counts cannot substitute for them. Plan dates, access refusals, audit stamps, quota
limits, replay sequences and announcement timing remain exact observable comparisons.

## Migration Plan

Follow `tasks.md`: remove driver types from ports; bind actual scopes; separate runtime
capabilities; create staged source and use cases; move consumers/adapters/kits; enforce
boundaries; run focused and whole gates. Keep migration SQL and migrate CLI entrypoint
paths unchanged until repo-namespacing. Compatibility barrels may reexport inward during
individual slices and must be gone from core's dependency graph before the final gate.

## Open Questions

None assigned to the implementer. The decisions above are authorized assumptions from
the existing plans and inspected callers. A changed upstream signature requires updating
its exact mapping before execution; it does not authorize inventing another architecture.
