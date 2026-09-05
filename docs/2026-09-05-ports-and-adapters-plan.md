# Ports-and-adapters plan — 2026-09-05

be-01 split into an isomorphic application core, one SQLite source, one in-memory source and
one Elysia HTTP adapter, with conformance kits that decide whether a new source is a correct
implementation and an endpoint table that is the one contract fe-01, be-01 and mcp-01 share.
**Not started.** Four OpenSpec changes, one per wave plus the namespacing change, created when
each wave starts. The implementation fixes have their own ordered backlog in
[`2026-09-02-refactoring-plan.md` §67](2026-09-02-refactoring-plan.md#67--review-follow-up--2026-09-06);
Wave 0 checks those overlaps too.

**This file is the normative text: the D-table and §2–§7.** How each decision got its shape —
the grilling session, two codex reviews, the evening compatibility was lifted, three later
reviews — is in
[`2026-09-05-ports-and-adapters-history.md`](2026-09-05-ports-and-adapters-history.md), which
keeps superseded decisions and is never a source for an OpenSpec change. Where a `D` row says
"superseded", the row that supersedes it is the only one to read.

Vocabulary: **port / adapter / source / unit of work / write coordinator / gate / scope /
endpoint / endpoint shape / request policy / conformance kit / ring** as defined in
`CONTEXT.md` → Architecture; **module /
interface / seam / depth** from `.claude/skills/improve-codebase-architecture/LANGUAGE.md`.
Decisions with alternatives are ADR 0014 (packages and rings) and ADR 0015 (unit of work),
both `proposed` until their wave merges.

## 0 · What is already true (measured 2026-09-05, `main` @ `2c839252`, re-checked on review)

The external analysis this plan started from said services import concrete repositories.
They mostly do not. Checked by import, not by grepping the word:

| Fact                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store ports exist: **16** `*Store` interfaces in the barrel plus `EventLogRepo` beside it, `implements`-ed by 17 drizzle classes                                                                                                           | `apps/be-01/src/repository/index.ts:64–2023` (2,063 lines; exports three **constants**, so not type-only), `event-log.ts:13`                                                        |
| Two repositories implement **no** port, open their own connection per call, and the service depends on their **class types**                                                                                                               | `SavedPlanRepository`, `SavedPlanCaptureRepository`; `saved-plan.service.ts:288` names both classes                                                                                 |
| Services import types from the barrel; **seven** value imports leak from repository modules                                                                                                                                                | `stepIsInUse`, `isForeignKeyViolation`, `MEASURE_METRICS`, `PERSON_KINDS`, `bodyByteLength`, `STEP_POSITION_STEP`; `PLAN_EVENT_RETENTION_DAYS` in `services.ts`                     |
| Zero Elysia imports in `service/` and `repository/`                                                                                                                                                                                        | `grep -rl "from 'elysia'"` → `app.ts`, 10 controllers, `middleware/caller.ts`, `openapi/hand-parsed-body.ts`                                                                        |
| Drizzle / `bun:sqlite` confined to `repository/`                                                                                                                                                                                           | two JSDoc mentions in `service/` only                                                                                                                                               |
| Runtime and platform in services: `Bun.password` (auth), `AsyncLocalStorage` (broadcast), `createHash` (saved-plan, saved-plan-integrity), `jose` + `@wbs/auth` (auth), `Buffer` (`bodyByteLength`), `fetch`/timers as injectable defaults | `auth.service.ts:1,76,129,167`, `broadcast.ts:2,225`, `saved-plan.service.ts:7,342`, `saved-plan-integrity.ts:1`, `saved-plan.ts:173`, `push-client.ts:31`, `retention-timer.ts:61` |
| `libs/domain` is not clean either: one `node:crypto` import, one `@wbs/validation` import                                                                                                                                                  | `canonical-schedule-input.ts` (input hash), `estimate.ts` (self-validating value)                                                                                                   |
| Two schedule engines already exist behind a stored per-project choice                                                                                                                                                                      | `schedule.ts` (2,588 lines, TypeScript), `libs/solver-py` (Python), `ScheduleEngine` in `schema.ts:309`, `optimizer-wiring.ts:21`                                                   |
| A composition root exists but is **split**: `services.ts` builds most services; `boot.ts` builds the saved-plan pair and `buildApp` builds `PlanCommandRunner`                                                                             | `services.ts`, `boot.ts:102–125`, `app.ts` (`new PlanCommandRunner`)                                                                                                                |
| In-memory stores exist for every port but are **documented as laxer than production**; the harness composes 12 of them                                                                                                                     | `testing/*-fixture.ts` (23 files), `harness.ts:55`, `replay-fixture.ts:12` (in-memory event log)                                                                                    |
| **The write lock guards publication, not writes.** Route writes (e.g. `StepService.add`) and the retention prune never take it                                                                                                             | `gateway-broadcaster.ts:108–112` ("every other publisher is an HTTP route that never takes the lock at all"), `step.service.ts:139`, `event-log.ts:94`                              |
| Undo rolls back on a **returned** `{ ok: false }`, then discards the stale journal entry after rollback and before releasing the lock                                                                                                      | `plan-commands.ts:74` (`Refused` thrown inside a batch), `:222–236`                                                                                                                 |
| The origin check is **global** for unsafe cookie-bearing requests and **additional** on login/register; write-scope is resolved **before body parsing**                                                                                    | `app.ts:169–178`, `auth.controller.ts:126,328`                                                                                                                                      |
| The OIDC callback sets three separate `Set-Cookie` headers and re-reads the raw request                                                                                                                                                    | `auth.controller.ts:231–238,271,350`                                                                                                                                                |
| The HTTP contract is owned by Elysia: TypeBox (~35 calls), OpenAPI from Elysia's route table; mcp-01 needs `operationId`s and inline object bodies                                                                                         | `openapi-plugin.ts`, `openapi.json` committed and diffed, `mcp-01/src/openapi-tools.ts:128–178`                                                                                     |
| The two batch routes parse bodies by hand: unknown fields are **ignored**, derived fields are **refused**, errors are `400 { error, at, kind }`                                                                                            | `hand-parsed-body.ts:31`, `work-item.controller.ts:541,809`, `work-item.controller.test.ts:1480`                                                                                    |
| fe-01 talks to the API through four hand-written modules and ~15 error-code branches, importing **nothing** from `@wbs/contracts`                                                                                                          | `apps/fe-01/src/lib/{api,wbs-api,saved-plan-api}.ts`, `testing/{fake-project-api,refusing-api}.ts`                                                                                  |
| fe-01 imports `@wbs/domain` from 11 files; gw-01 imports `@wbs/contracts` from 4                                                                                                                                                           | priority bands, dependency reach, workday, assumed duration; WS frames                                                                                                              |
| Saved-plan authorization and announcements live in the **controller**                                                                                                                                                                      | `saved-plan.controller.ts:210–222`                                                                                                                                                  |
| Existing guards are aimed at folders that will move: drizzle rules and the `bun:sqlite` ban name `apps/be-01/src/repository`; `test:unit` lists libs by name                                                                               | `eslint.config.js:116,154`, `package.json:11`                                                                                                                                       |

So the job is not "remove leakage". It is three seams that exist as folder conventions and
have to become **enforced contracts with two implementations each**, one seam (HTTP) that does
not exist yet, and one **pre-existing gap** (the lock) that the unit-of-work design has to close
rather than inherit.

## 1 · Decisions

| #   | Question                                                              | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What does "swappable source" require of ADR 0007's outer transaction? | A behavioural **unit of work** port. **Terminal atomicity** for the batch's writes: once `run` settles, all of `act`'s writes are observable or none are. Explicit post-rollback repair and independent history are separate acts (D27, D28). **Isolation is not promised.** ADR 0015.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D2  | Where do the pieces live?                                             | Four packages: `libs/core`, `libs/store-sqlite`, `libs/store-memory`, `apps/be-01`. Direction enforced by Nx ring tags + ESLint. ADR 0014.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D3  | What is the framework-independent controller?                         | **Endpoints as data** — an `EndpointShape` (method, path, operation id, request policies, Standard Schema types, document) in `@wbs/contracts`, and an `Endpoint` in core that binds a pure handler to one shape (D21). **ArkType from Wave 1**, unknown keys **rejected on every route**, **one refusal envelope** for every endpoint, and the OpenAPI document **emitted from the specs**. (Backward compatibility is not a constraint — Dany; history §9.)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D4  | Second adapters as living proof?                                      | **No** second HTTP adapter (Dany: "good idea, overkill for now"). The store kit gets two implementations by tightening the in-memory fixtures. HTTP characterization tests stay **local to the Elysia adapter**; an exported HTTP kit is written the day a second adapter exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D5  | Scope across apps                                                     | **be-01, fe-01's API client, and mcp-01's tool-schema derivation.** gw-01's WebSocket upgrade and services are outside this extraction; refactoring R4/R7 remain separate. mcp-01's authentication/server runtime stays unchanged. A shared Elysia adapter is a later decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D6  | The seven value leaks                                                 | Vocabulary moves to core/domain. `isForeignKeyViolation` is replaced by **reference-specific** store outcomes (`unknown_step`, `unknown_person`, …) that the adapter returns **only after proving that reference absent**; any other FK failure stays a thrown unknown. No blanket `unknown_reference`. **Confirmed by Dany after review.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D7  | Order                                                                 | Wave 0 collision gate → Wave 1 HTTP + shared contract → Wave 2 stores, unit of work, runtime ports, kits → Wave 3 extraction and rings. Each its own OpenSpec change and PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D8  | Packaging                                                             | This document + four OpenSpec changes: `http-endpoint-port`, `store-port-and-unit-of-work`, `core-lib-extraction`, `repo-namespacing`, each created when its wave starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D9  | Records                                                               | ADR 0014 and 0015 `proposed` now, `accepted` by the merging PR of their wave. CONTEXT.md terms written now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D10 | What runtime does core promise?                                       | **`runtime:isomorphic`.** Runtime concerns arrive through `composeServices({ source, runtime, shared })`: `PasswordHasher`, `TokenCodec`, `Digest`, `Timers`, `PushTransport`, `Scheduler`. Announcements are owned by the scoped service graph, with no ambient-context port (D24). §3.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D11 | Who coordinates writes?                                               | The **source** owns a **write coordinator**: a queue of turns, keyed however that source needs — process-wide for one-connection SQLite (today's `WriteLock`, moved inside the adapter), per project for a Postgres source (`pg_advisory_xact_lock`), a no-op where every transaction has its own connection. Every mutating adapter method asks it for a turn; `UnitOfWork.run` takes **one** turn for the whole batch. **There is no re-entrancy**: the batch's own writes never ask (D20), outsiders wait. `WriteLock` leaves core.                                                                                                                                                                                                                                                                                                                                                                   |
| D12 | Saved plans and the source                                            | **Independent history ports**, never enlisted in a command batch or queued on its coordinator. Existing bounded contention remains `snapshot_busy`. A successful save survives either outcome of a concurrent batch. Memory history lives outside staged transactional state (D27); post-rollback journal repair is transactional-store work, not history (D28).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D13 | **New.** What is the contract between fe-01 and be-01?                | **The endpoint shapes.** Every `EndpointShape`, its `P, Q, B, R` types and `RefusalCode` live in `@wbs/contracts`; be-01 binds handlers to those shapes, fe-01 derives a typed client from the same shapes. A renamed field breaks fe-01's typecheck, not a screen. fe-01's four hand-written API modules are replaced. (Revised by D21: the table with handlers cannot cross the ring boundary; the shapes can.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D14 | **New.** How is dependency direction stated across packages?          | **Rings**, as Nx tags, and **every project has exactly one**: `ring:domain` (`domain`, `contracts`, `validation`), `ring:application` (`core`, `conformance`), `ring:adapter` (`store-*`, `runtime-web`, `auth`, `realtime`, `solver-py`, `observability`, `config`, `be-01`, `fe-01`, `gw-01`, `mcp-01`, and every `tools/*` project). Each ring depends only inward; fe-01 additionally only on `ring:domain` and `runtime:browser` adapters. **Test files are outside the ring constraints** (not the runtime ones): a core test composes core over `@wbs/store-memory`, and that is the one hole, deliberately. `domain` and `contracts` stay **separate Nx projects** because fe-01 and gw-01 import them and a boundary is per project. A totality test asserts one `ring:` and one `runtime:` tag on every project, and one `product:` tag on every project under `apps/` and `libs/` (§3.5 #12). |
| D15 | Ambient batch context in the browser                                  | **Superseded by D24.** Read D24 only; history §9.3 and §11 hold the `AsyncContext` port that was chosen here and the write-before-next-batch window that removed it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D16 | Which validator, where?                                               | **ArkType everywhere, both ends of the wire.** `SchemaShape` pairs a `StandardSchemaV1` validator with a generated JSON Schema descriptor (D25); client validation covers successful and refusal responses by status (D26). TypeBox is banned once Wave 1 removes it. This is a target state; R4 in the refactoring follow-up closes the current WS frame-validation gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D17 | **New.** Can the whole product run in a browser?                      | **Yes, by construction, not by this plan's waves.** Core and the memory source are isomorphic (D10); `clientFromShapes(shapes, transport)` takes an in-process transport that calls `endpoint.handle` directly; the broadcaster gets an in-tab adapter; persistence is a third source the kit certifies — `store-indexeddb`, or the memory source with a persist hook (§7 Q7). A browser source has **no accounts**, so `Stores` is a composition and the kits are per port (D22); it has no Python solver, so a project stored on that engine is **refused** with `engine_unavailable`, never silently rescheduled (D23). Widening fe-01's ring constraint to `ring:application` is the day it starts.                                                                                                                                                                                                  |
| D18 | **New.** One repo, several products                                   | **Namespace by directory, project name and tag; aliases stay.** `apps/wbs/*`, `libs/wbs/*`, project names `wbs-*`, tag `product:wbs`, rule `product:X → product:X \| product:shared`; `@wbs/*` aliases unchanged; `tools/*` is infra. Its own change after Wave 3, verified by a prod dry-run because Dockerfile build contexts move. **Eighteen** files outside `apps/` name an app path (measured 2026-09-06, §4); the change's first task is that list.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D19 | **New.** Ring in the names?                                           | **In the directory, never in the name.** `libs/wbs/{domain,application,adapters}/…`, `apps/wbs/…`; project names and aliases stay short (`wbs-domain`, `@wbs/core`). The `ring:` tag is the enforced truth and a test asserts directory ring = tag, so the path cannot lie. Rejected: `wbs-adapter-01-fe-01` and `wbs-domain-contracts` — a ring is an attribute, a name is an identity; a lib that moves rings would churn every import; contracts' ring is still the open question.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D20 | How does a store know a write is the batch's own?                     | **Through `scope`, never ambiently.** `UnitOfWork.run` supplies admitted transactional stores; the runner builds its scoped services with that batch's collector (D24). SQLite reuses admitted store adapters, not a service graph holding another batch's collector. Public transactional stores take turns; independent history does not (D27). Repair receives its own live admitted scope (D28).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D21 | Where does the endpoint table live?                                   | **Split.** `EndpointShape<P,Q,B,R>` — everything but the handler — in `@wbs/contracts` (`ring:domain`), so fe-01, mcp-01 and `documentFromShapes` read it without touching core. `Endpoint = EndpointShape & { handle }` in core. The table fe-01 derives its client from is the shapes; the table be-01 mounts is the endpoints; one test asserts every shape has exactly one endpoint bound to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D22 | Stores: one record or a composition?                                  | **A composition, kits per port.** `Stores = TransactionalStores & HistoryStores`; transactional stores contain plan, directory and available account ports. `Scope` excludes history. `composeServices` accepts a source without account ports and omits auth in its type; each certificate names the kits actually run. D27 keeps independent history outside every staged write set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D23 | A project's engine is not available here                              | **Refuse.** `Scheduler.schedule` answers `{ ok: false; error: 'engine_unavailable'; engine }` when the project's stored engine has no adapter in this composition; every caller of the schedule surfaces it as a `Refusal`. Never fall back: dates from an engine the project did not choose are a wrong plan with no mark on it in any export (R5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D24 | Who owns announcements?                                               | **The service graph of one batch.** Build a fresh collector and scoped services per batch; ordinary services hold the direct broadcaster. Flush only after commit and release, drop only that batch's events on refusal. No `AsyncContext` or single-slot browser adapter. Supersedes D15.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D25 | How can shapes emit documents?                                        | **Validator + generated document descriptor.** `SchemaShape<T>` carries `StandardSchemaV1<T>` and JSON Schema from one ArkType declaration. Conversion stays at the declaration boundary; unsupported conversion fails explicitly. `documentFromShapes` consumes descriptors without validator introspection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D26 | Which replies does the contract admit?                                | **Status-specific success and refusal variants.** Include modeled 429 throttling and 503 contention/dependency failure, preserve empty 204/302 semantics and validate both response arms. Unexpected account-store errors propagate rather than become 401.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D27 | Which state does a batch own?                                         | **Transactional stores only.** Independent history is composed at the source, excluded from `Scope`, and held outside memory's staged tables. A successful concurrent history mutation survives commit and rollback; contention is a typed refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D28 | How does repair run after rollback?                                   | **A fresh admitted scope over surviving transactional state**, passed to `afterRollback` before releasing the coordinator. Never public gated stores or the discarded memory scope. A repair failure is propagated outside the transaction catch, so it cannot trigger another rollback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 2 · Target layout

```
libs/domain         @wbs/domain          ring:domain       runtime:isomorphic   vocabulary, tree rules, derivation, the TS schedule engine (a pure function; its Scheduler adapter lives in runtime-web and boot.ts), saved-plan shape
libs/contracts      @wbs/contracts       ring:domain       runtime:isomorphic   WS frames, internal, the Logger type with its no-op logger, and from Wave 1 every EndpointShape with its P/Q/B/R types and RefusalCode (D21)
libs/validation     @wbs/validation      ring:domain       runtime:isomorphic   ArkType wrapper; domain's self-validating values use it
libs/core           @wbs/core            ring:application  runtime:isomorphic
  ports/            one file per port: *Store, EventLogStore, SavedPlanStore, SavedPlanCaptureStore, UnitOfWork, Gate, Clock,
                    Broadcaster, IdentityResolver, PasswordHasher, TokenCodec, Digest, Timers, PushTransport, Scheduler
  services/         the application services, runtime dependencies injected and announcements scoped per batch (D24)
  use-cases/        runCommandBatch, savePlan (authorization + announcement, out of the controller), replay, retentionSweep
  http/             Endpoint = EndpointShape & { handle }, HttpReply, the binding table, mountable by any adapter
  compose.ts        composeServices({ source, runtime, shared }) — one root graph; servicesOver(stores, shared) — each batch's scoped graph
  compose.test.ts   the "any trigger, any runtime" proof: core over @wbs/store-memory with the runtime-web adapters, no HTTP (a test file, so outside the ring rule)
libs/conformance    @wbs/conformance     ring:application  runtime:bun          one kit per port, sourceConformance = their composition; unitOfWorkConformance(open); schedulerConformance(engine); brokenSource(source, faults). Imports core's ports and bun:test; every source's test target runs it
libs/store-sqlite   @wbs/store-sqlite    ring:adapter      runtime:bun          drizzle adapters, schema.ts, db.ts (openConnection, pragmas, the write coordinator), scheduleInputHash, migrate*.ts
libs/store-memory   @wbs/store-memory    ring:adapter      runtime:isomorphic   the in-memory source, promoted from apps/be-01/src/testing/*-fixture.ts; a persist hook is where a file source starts
libs/runtime-web    @wbs/runtime-web     ring:adapter      runtime:isomorphic   Digest over crypto.subtle, tsScheduler, in-tab Broadcaster — used by fe-01's future browser mode and by be-01's boot.ts alike
libs/auth           @wbs/auth            ring:adapter      runtime:bun          jose and node:crypto behind TokenCodec and the OIDC store (§7 Q5)
libs/observability  @wbs/observability   ring:adapter      runtime:bun          pino, OpenTelemetry, the Prometheus exporter; its Elysia /metrics plugin is deleted in Wave 1.5 when /metrics becomes a shape
libs/config         @wbs/config          ring:adapter      runtime:bun          ArkType-validated env shapes, process.env and the sops loader; boot.ts is its caller, core never reads config
libs/realtime       @wbs/realtime        ring:adapter      runtime:browser      unchanged
libs/solver-py      —                    ring:adapter      runtime:bun          the Python engine, mounted as a Scheduler adapter in boot.ts
apps/be-01                               ring:adapter      runtime:bun          elysia adapter, boot.ts (config, logger, the runtime adapters, composition), migrate-*-cli.ts
apps/fe-01                               ring:adapter      runtime:browser      the derived typed client replaces lib/{api,wbs-api,saved-plan-api}.ts
apps/gw-01                               ring:adapter      runtime:bun          unchanged by extraction; separate R4/R7 fixes in the refactoring plan
apps/mcp-01                              ring:adapter      runtime:bun          tool schemas derive from shapes; authentication/server runtime unchanged (D5)
```

Every project in the workspace appears above or is `scope:infra` under `tools/`, and the tools
are `ring:adapter`: they call adapters and nothing calls them. A ring the lint cannot find on a
project is a constraint that never fires, which is what the totality test below is for. Two
libs were tagged `runtime:isomorphic` while importing Elysia, pino and OpenTelemetry
(`observability`) or spawning `sops` (`config`); both are adapters, and the one thing core
needed from them — the `Logger` type — moves to `@wbs/contracts` so that core's graph holds no
adapter.

**Dependency direction, enforced** (§3.5 has the negatives):

- Nx `depConstraints` on rings: `ring:domain` → `ring:domain`; `ring:application` → `ring:domain | ring:application`; `ring:adapter` → any ring; plus `allSourceTags: ['ring:adapter', 'runtime:browser']` → `ring:domain` and `runtime:browser` adapters only, until an offline mode wants core in the browser.
- **Test files are exempt from the ring `depConstraints`** and from the two rules below, by an ESLint override on `**/*.test.ts` and `**/testing/**`. The runtime constraints still apply to them. This is what lets core's 39 service test files compose core over `@wbs/store-memory` and import `bun:test`; §3.5 #13 and #15 prove the exemption stops at the production file next door.
- `no-restricted-imports` in `libs/core/src` and `libs/domain/src` production files: `node:*`, `bun:*`, `elysia`, `@elysiajs/*`, `drizzle-orm`, `jose`.
- `no-restricted-globals` in the same two: `Bun`, `process`, `fetch`, `setTimeout`, `setInterval`, `Buffer` (plus `no-restricted-syntax` for `globalThis.fetch`).

The **existing** guards move with the code: the drizzle rules and the `bun:sqlite` ban are
re-aimed at `libs/store-sqlite/src` (with `db.ts` the one exemption), and `test:unit` in
`package.json` names the new projects.

**Directory layout (D18, D19), applied in the namespacing change after Wave 3:**

```
apps/wbs/{be-01,fe-01,gw-01,mcp-01}                                        product:wbs  ring:adapter
libs/wbs/domain/{domain,contracts,validation}                              product:wbs  ring:domain
libs/wbs/application/{core,conformance}                                    product:wbs  ring:application
libs/wbs/adapters/{store-sqlite,store-memory,runtime-web,auth,realtime,solver-py,observability,config}  product:wbs  ring:adapter
tools/*                                                                    scope:infra  ring:adapter  (no product: shared by every product)
```

Project names `wbs-be-01`, `wbs-domain`, `wbs-core`, …; import aliases stay `@wbs/*`. Two tests
in the shape of `test-tiers.test.ts` walk `libs/` and `apps/`: the **layout** test fails when a
project's directory ring disagrees with its `ring:` tag or its `product:` tag disagrees with
its top directory; the **totality** test fails when any project carries zero or two `scope:`,
`ring:` or `runtime:` tags, or when a project under `apps/` or `libs/` carries zero or two
`product:` tags, or when a project under `tools/` carries one — because a project the
constraints cannot see is a constraint that cannot fire, and a tool that belongs to a product
is a product file in the wrong directory.

**Physical layout of the domain ring.** `libs/domain` and `libs/contracts` are conceptually
the innermost ring of core, but they stay separate Nx projects: fe-01 imports one from 11
files and gw-01 the other from 4, and a boundary the linter can see is per project — a
subpath like `@wbs/core/domain` is a naming convention, not a rule. Their directory is
`libs/wbs/domain/…` (D19), applied in the namespacing change; nothing is nested under
`libs/core/`.

**What does not move.** `apps/be-01/drizzle/` and the three `migrate-*-cli.ts` entrypoints:
the blue/green swap (`tools/tool-remote-scripts/src/swap.ts`, `lib/docker.ts`) invokes them
by path and the Dockerfile copies them. The runner moves into `store-sqlite` and takes the
folder path as an argument, which it already does. How a **non-SQL** source becomes
deployment-ready is that source's adapter's business (`open / health / close` are on the
source port; there is no generic migration port).

## 3 · The seams

### 3.1 HTTP: endpoints as data, and the shared contract (Wave 1)

```ts
// @wbs/contracts — ring:domain. Everything a client, a document or a tool needs; no handler.
interface EndpointShape<Path extends string, Q, B, R, Pol extends readonly RequestPolicy[]> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: Path; // params are derived from it: ParamsOf<'/api/projects/:id'> = { id: string }
  operationId: string; // mcp-01 refuses to invent one
  policies: Pol; // applied in order, before parsing
  params?: SchemaShape<ParamsOf<Path>>; // refines the derived names; cannot add or drop one
  query?: SchemaShape<Q>;
  body?: SchemaShape<B>; // ArkType, unknown keys rejected
  response: SchemaShape<R> | TextResponse; // JSON, validated by the client (D16); or { kind: 'text'; contentType } — /metrics is the first
  refusals: readonly { status: RefusalStatus; schema: SchemaShape<Refusal> }[];
  document: { summary: string };
}
interface SchemaShape<T> {
  validator: StandardSchemaV1<T>;
  jsonSchema: JsonSchema; // JSON Schema descriptor generated from the same declaration
}
type RefusalStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;
type RequestPolicy =
  | { kind: 'origin'; when: 'always-unsafe-with-session-cookie' | 'always' }
  | { kind: 'identity'; require: 'signed-in' | 'read-scope' | 'write-scope' | 'internal' };
type Refusal = { [C in RefusalCode]: { error: C } & RefusalDetail[C] }[RefusalCode];
// one envelope, one union: `switch (refusal.error)` narrows the detail. Batch refusals carry
// { at, kind } in their own detail; the envelope itself has no batch-only fields.

// @wbs/core — ring:application. A handler bound to one shape.
type Endpoint<S extends EndpointShape<…>> = { shape: S; handle(input: EndpointInput<S>): Promise<HttpReply<S>> };
interface EndpointInput<S> {
  params: ParamsOf<S['path']>;
  query: QueryOf<S>;
  body: BodyOf<S>;
  principal: PrincipalOf<S['policies']>; // Identity when an identity policy is in the tuple, never otherwise
  request: { url: URL; method: string; headers: Headers }; // the OIDC callback re-reads the raw request
}
type HttpReply<S> =
  | { ok: true; status: 200 | 201; body: ResponseOf<S>; headers?: Header[] }
  | { ok: true; status: 204 | 302; body: typeof EMPTY; headers?: Header[] }
  | { ok: true; status: 200; text: string; headers?: Header[] } // only for a TextResponse shape; the adapter sets its contentType
  | RefusalReplyOf<S>; // status + refusal body derived together from S['refusals']
type Header = [name: string, value: string]; // ordered multimap: three Set-Cookie on the callback
```

The types are shaped so the three ways a hand-written spec can lie are unrepresentable: a
path and its params schema cannot disagree, a 200 cannot carry a refusal, and a handler on an
unauthenticated route cannot read a principal. `EMPTY ≠ JSON null`.

`SchemaShape` is authored once with ArkType; its JSON Schema descriptor is generated at the
declaration boundary, never maintained as a second handwritten contract. `JsonSchema` is the
standard serializable document type, not an invented validator interface. Standard Schema
provides validation/type inference, **not** document introspection; the
[complete interface](https://standardschema.dev/schema) has no JSON Schema conversion method.
The generator checks the declaration's input/output direction and fails explicitly on a
schema it cannot represent. `documentFromShapes` reads descriptors; the HTTP adapter and
client read validators. A library swap changes declarations and this conversion boundary,
not the emitter or client. Nested command unions and MCP's inline object-body requirement
are the first emitter tests (D25).

`RefusalReplyOf<S>` derives its status/body pairs from the shape's literal refusal variants;
it cannot attach a throttling body to an unrelated status. Login throttling declares 429,
saved-plan contention declares 503 `snapshot_busy`, and failed dependency health declares 503. Redirects are successful control replies with `EMPTY` and `Location`; unexpected
exceptions still throw to the error boundary rather than becoming an invalid-session
refusal. Both ends validate refusal bodies as well as successful bodies. These cases belong
in the Wave 1 adapter matrix before the existing routes are moved (D26).

- **Adapter phases are specified.** Policies run in `onRequest`, before Elysia parses a body —
  today's write-scope guard depends on that (`app.ts:174`). Negative: policies moved after
  parsing → malformed JSON with a read-only token answers 422 instead of 403, through `app.handle`.
- **Origin is its own policy**, applied to every unsafe request carrying a session cookie
  exactly as `hasInvalidCookieOrigin` does today, plus the always-on check on login/register.
  Negative: policy removed from a project POST → a foreign-origin cookie request writes.
- **One validation behaviour, one envelope.** Unknown keys are rejected on every route
  (ArkType `onUndeclaredKey: 'reject'`), a derived field is therefore refused rather than
  stripped, and every validation failure and every domain refusal answers `Refusal`. The
  hand-parsed bodies, `hand-parsed-body.ts` and `plan-command-schema.ts` are deleted. fe-01
  and mcp-01 change to match (D3, D13). The existing `*.controller.test.ts` files are
  **rewritten where the wire changed** and the rewrite is listed in the change's `verify.md`;
  where the wire did not change they run unchanged.
- **The document is emitted from the shapes** (`documentFromShapes`, in contracts, no core
  import), `@elysiajs/openapi` is removed, and **mounting stays the oracle**: a reachability
  test walks the shapes and requests every path through `app.handle`, so an adapter that
  skips a mount while the shape stays present fails there. Negative: one `mount` skipped →
  `404` at that path. `/health` and `/metrics` are shapes too; `/metrics` is a `TextResponse` shape whose handler serialises the meter, and `libs/observability`'s Elysia plugin (`otel-plugin.ts`) is deleted with it. `openapi.json` stops being a
  committed file and becomes a build output; mcp-01's tools derive from the shapes directly.
- **Two tables, one binding (D21).** `@wbs/contracts` exports the shapes; core exports the
  endpoints, each `bind(shape, handle)`; be-01 mounts the endpoints. A test in core asserts
  every shape has exactly one endpoint and no endpoint an unlisted shape. Negative: a shape
  added to contracts with no handler → that test red; the reachability test red as well.
- **The shared contract (D13).** `clientFromShapes(shapes, transport)` gives fe-01 a typed
  client with one method per `operationId`; fe-01's `lib/api.ts`, `lib/wbs-api.ts`,
  `lib/saved-plan-api.ts` and their two test fakes are replaced by it and by a fake built from
  the same shapes. `fe-01`'s ~15 `error ===` branches become `switch (refusal.error)` over the
  `Refusal` union, and the detail narrows with the code. Negative: a response field renamed
  in one shape → fe-01 `typecheck` red at the screen that read it.
- **Both ends validate (D16).** `clientFromShapes` parses every response with the shape's
  status-specific validator before handing it to a screen, so a be-01 that answers a shape the
  contract does not declare is a typed client error at the boundary rather than an
  `undefined` three renders later. **Undeclared keys in a response are ignored by the client**
  (`onUndeclaredKey: 'ignore'` on the response validator only; bodies still reject): a
  blue/green swap reconnects the socket without reloading the page, so an open tab runs the
  previous fe-01 bundle against the new be-01, and a client that rejected an added field would
  break every open tab on every additive deploy. Negatives: a response field's **type** changed
  in be-01 only → the client refuses the response in fe-01's tests; a response field **added**
  in be-01 only → the previous client still renders.
- **Refresh semantics survive the client replacement.** §67's R1 in the refactoring plan
  owns invalidation generations, pending resource scopes and the mandatory trailing read.
  `clientFromShapes` cannot reintroduce URL-only sharing of a GET started before an edit.
  Carry its held-response and overlapping-scope regressions through Wave 1.4 unchanged in
  behavior; the generated transport does not own the table's invalidation policy.
- **Transport is a parameter.** `transport` is `fetch` in production and an in-process
  `(shape, input) => endpointFor(shape).handle(input)` for tests and for the browser-only
  mode (D17). The same fake serves fe-01's unit tests; the two hand-written fakes are deleted.
- **Deletion test:** with the adapter deleted, every endpoint is a typed function a unit test
  can call with a literal input.

### 3.2 Stores, the write coordinator and the unit of work (Wave 2)

- Every `*Store` port stays, one file per port under `core/ports/`. **Added:** `EventLogStore`
  (renamed from `EventLogRepo`), `SavedPlanStore`, `SavedPlanCaptureStore`, `Gate`. `Stores`
  is a **composition** (D22): `TransactionalStores & HistoryStores`, where
  `TransactionalStores = PlanStores & DirectoryStores & AccountStores & { eventLog: EventLogStore }` —
  the batch records its events through `scope.stores.eventLog` (§7 Q4), replay and retention
  read and prune through the public gated one —
  so a source can implement a subset and the type of `composeServices` says what is then
  missing from the graph (`auth` is absent when `AccountStores` is). The `Source` port is
  `{ stores: Stores; uow: UnitOfWork; open(); health(); close() }`.
- **Write coordinator (D11).** A queue of turns the source owns, keyed as the source needs:
  process-wide for one-connection SQLite, per project for Postgres, a no-op where every
  transaction has its own connection. Every mutating transactional adapter method asks it for a turn through
  the **gate** it was constructed with; `UnitOfWork.run` takes one turn for the whole batch.
  This closes the pre-existing gap in §0. Negative, the one D11 hangs on: suspend a real batch
  after its first write, start `StepService.add` from outside, refuse the batch → the step
  **is** stored and its event is consistent. The implementer must watch this fail with the
  gate removed from `StepRepository.insert` (today's shape); this is a planned proof.

  ```ts
  interface Gate {
    enter<T>(work: () => Promise<T>): Promise<T>; // wait for a turn, run, release
  }
  const OPEN: Gate = { enter: (work) => work() }; // "the caller already has a turn"
  ```

- **Ownership is explicit (D20).** There is no re-entrancy: nothing that already holds a turn
  ever asks for one. `run` hands `act` a `Scope` whose `stores` are the same adapter classes
  built so their writes are already the batch's own — `buildStores(db, OPEN)` for SQLite,
  `buildStores(tx)` over the transaction client for Postgres, `buildStores(() => staged, OPEN)`
  for memory. `buildStores` constructs only `TransactionalStores`; independent saved-plan
  ports are composed into the public source separately. `Scope` exposes the transactional
  subset, so a command cannot accidentally enlist a saved-plan operation (D27).

  The batch runner builds `servicesOver(scope.stores, { ...shared, broadcast: collector })`
  with a fresh announcement collector per batch (D24). Ordinary services receive the direct
  broadcaster. The clock, throttle, replay buffer and optimizer wiring remain shared; the
  scoped graph and collector are built per batch. SQLite's admitted **store adapters** can
  still be built once at `open`; its service graph cannot be reused with another batch's
  collector. Memory's adapters point at its fresh staged transactional state. Route writes
  and retention use coordinator-gated public transactional stores; saved plans use the
  independent history ports and never ask this coordinator for a turn.

- **`UnitOfWork.run` protocol**, because refusals here are **returned values**:

  ```ts
  interface UnitOfWork {
    run<T>(act: (scope: Scope) => Promise<Decision<T>>): Promise<T>;
  }
  interface Scope {
    stores: TransactionalStores; // already admitted; never take a turn
  }
  type Decision<T> =
    | { commit: true; value: T }
    | { commit: false; value: T; afterRollback?: (scope: Scope) => Promise<void> };
  ```

  A thrown error rolls back and rethrows. `afterRollback` runs before the turn is released —
  undo's stale-journal discard needs that window (`plan-commands.ts:222–236`). The callback
  receives a **new admitted scope over the surviving state**, and writes through that
  scope's journal. An ordinary public store would reacquire the held coordinator and
  deadlock; the old memory scope would write into the discarded clone. The repair is a
  separate surviving act, explicitly excluded from the batch's atomic write set. A failed
  repair is rethrown without issuing another rollback on an already closed transaction (D28).

  SQLite and memory sketches; Postgres's additional lifetime requirement follows:

  ```ts
  // store-sqlite: same connection, savepoints nest as ADR 0007 measured
  run: (act) =>
    coordinator.enter(async () => {
      db.run('BEGIN IMMEDIATE');
      let decision: Decision<T>;
      try {
        decision = await act({ stores: admitted });
        db.run(decision.commit ? 'COMMIT' : 'ROLLBACK');
      } catch (cause) {
        try {
          db.run('ROLLBACK');
        } catch (rollbackCause) {
          throw new AggregateError([cause, rollbackCause], 'batch and rollback failed');
        }
        throw cause;
      }
      // Outside the transaction catch: failure here must not attempt a second rollback.
      if (!decision.commit) await decision.afterRollback?.({ stores: admitted });
      return decision.value;
    });
  // store-memory: only transactionalTables are cloned; historyTables stay independent
  run: (act) =>
    coordinator.enter(async () => {
      const staged = structuredClone(transactionalTables);
      const decision = await act({ stores: buildStores(() => staged, OPEN) });
      if (decision.commit) transactionalTables = staged;
      else await decision.afterRollback?.({ stores: buildStores(() => transactionalTables, OPEN) });
      return decision.value;
    });
  ```

  A future Postgres source binds scope stores to its borrowed transaction client. Its
  coordinator must outlive that transaction through post-rollback repair: a transaction-level
  advisory lock alone is released too early. Retain a session-level project lock on the
  borrowed connection, finish the transaction, run repair on admitted live stores, then
  release the lock and connection, with cleanup failures surfaced. This is a design
  requirement for a future adapter, not a Postgres implementation in these waves.

- **Terminal atomicity, tested in the window it lives in.** `unitOfWorkConformance`:
  (a) three writes across three stores, the third refused via `Decision` → none of those writes observable
  after `run`; (b) the same with the third **throwing**; (c) a committed batch observable
  through all three; (d) the D11 suspension case against **both** sources;
  (e) a retention prune started while a batch is suspended is **not**
  undone by the rollback; (f) a publish from inside a suspended batch is held by that batch
  and released after commit; (g) a write started from outside while a batch is suspended
  publishes **after** the batch's release, never inside it; (h) **the deadlock negative**: a
  `scope` store written inside `run` completes within the timeout — inject `admitted` built
  over the coordinator instead of `OPEN`; (i) every public transactional store takes a turn —
  call its write during a suspended batch and observe it wait, then inject `OPEN` and observe
  the premature write. History ports are excluded by D27. Publication cases (f), (g) and
  (l) exercise the scoped service composition over each source, not a pure store kit.
- **Saved plans (D12)**: coherent capture, fail-fast contention, header+body atomic, quota
  checked inside the write, all independent of any open batch and **taking no turn** — they
  run on their own connection. Case (j) asserts the save never waits in the batch coordinator:
  it succeeds independently or reports the existing bounded `snapshot_busy` contention.
  A successful save must survive both batch **commit and rollback**. In memory, `historyTables`
  are never cloned or replaced with `transactionalTables`; in SQLite the existing contention
  behavior stays modeled. `saved-plan-in-transaction.db.test.ts:120` becomes a kit case.
- **New failure windows (D24, D27, D28).** Case (k): refuse an undo, discard its journal entry
  through the repair scope while a second write waits, then let that write proceed. Inject
  the public journal (timeout), the discarded memory journal (entry remains), and a repair
  throw (original error survives, no second rollback; later writes still proceed). Case (l):
  commit an ordinary route write, admit a following batch before the route publishes, then
  refuse the batch — the route event still leaves, exactly once. Also cover a first batch's
  post-commit events while the next batch is open. Inject a process-wide announcement slot.
  Case (j)'s memory negative puts history back in the swapped clone and must lose the
  concurrent successful save on **commit**. These are planned negatives; record observed
  failures in the change's `verify.md` before writing `Proof:` comments.
- **Reference-specific outcomes (D6).** Negative: FK failure on a **person** while the step
  exists → throws; step deleted → `unknown_step`.
- **Kits per port (D22).** Every kit lives in `@wbs/conformance` (§2): it is a `bun:test`
  suite, which core's own import ban keeps out of core. `stepStoreConformance(openStores)`,
  `workItemStoreConformance`, …, one per port, each a function of a factory; `sourceConformance(open)` is their composition
  over the ports the source declares, and its report names which kits ran. A browser source
  without `AccountStores` is certified for what it has and is not asked about accounts.
- **Kit admission rule.** A case belongs in a kit if it states behaviour a caller can observe
  through the port, whether or not both sources already pass it. What earns it its place is
  being watched failing against `brokenSource(source, fault)`. SQLite-only cases stay in
  `store-sqlite`.
- Promoting the fixtures: each `inMemoryX` is tightened until the kit passes; `rows` /
  `stampsSeen` stay as an extra surface. A **file source** is the memory source plus a
  `persist` hook on commit (temp file + `rename`, atomic per file, the whole plan as one
  document); named here as the shape, not built (§7 Q7).

### 3.3 Core extraction and rings (Wave 3)

`git mv` into the packages of §2, imports rewritten, `project.json`s with ring and runtime
tags, the enforcement rules, the two relocated guards, `test:unit` driven by target rather
than by a list of project names (`package.json:11` today).
`composeServices({ source, runtime, shared })` builds **one** graph — saved plans and the
command runner included — and is grouped rather than flat so a new port widens one of three
records instead of a 25-field argument. `servicesOver(stores, shared)` is the half of it the
batch runner calls with `scope.stores` and a per-batch `broadcast` in `shared` (D20, D24). Use-case entrypoints are what a non-HTTP caller
invokes; `savePlan` carries the authorization and announcement the controller holds today
(`saved-plan.controller.ts:210–222`). Config loading, the logger adapter and the Bun runtime
adapters live in `boot.ts`; the portable adapters live in `libs/runtime-web`. The "any
trigger, any runtime" proof is `libs/core/src/compose.test.ts`: test files are outside the ring
rule (§2), so it composes core over `@wbs/store-memory` with the `runtime-web` adapters from
inside core, next to the code it proves.

What moves into core is what is in `apps/be-01/src/{service,repository/index.ts}` today less
the drizzle classes. What is already in `libs/domain` (6,465 lines, 31 modules) stays there:
vocabulary and arithmetic (`workday`, `estimate`, `progress`, `capacity`, `priority-band`,
`priority-weight`, `dependency-reach`, `external-system`, `contract-version`); tree rules
(`place-sibling`, the four `effective-*`, `label-mismatch`, `leaf-constraints`, `not-before`,
`is-within`, `assumed-duration`); derivation (`derive-numbers`, `slice-edges`, `slice-groups`);
the schedule engine (`schedule` at 2,588 lines plus six satellites); and `saved-plan/`. Its one
runtime import, `node:crypto` in `canonical-schedule-input.ts`, leaves in Wave 2.6 (§3.4);
`estimate.ts`'s `@wbs/validation` import is legal, which is why validation is `ring:domain`.

The 2,063-line `repository/index.ts` barrel is not split in place (W4-1, refused with
measurement); at the move it becomes one file per port under `core/ports/` with a re-exporting
index, because `git mv` cannot preserve history across a split and the move is the one moment
the split is free.

### 3.4 Runtime ports (D10; built in Wave 2 while the code still lives in be-01)

| Today                                                                                                                 | Port                                                                                                                                                                                                                        | Bun/Node adapter                                                                         | Browser adapter                                                                      | Size                                          |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `Bun.password.hash/verify` (`auth.service.ts:76,84`)                                                                  | `PasswordHasher { hash; verify }`                                                                                                                                                                                           | `Bun.password`                                                                           | none needed (no accounts offline)                                                    | 20 lines                                      |
| `SignJWT` / `jwtVerify` from `jose` (`auth.service.ts:129,167`)                                                       | `TokenCodec { sign(claims, ttl); verify(token) }`                                                                                                                                                                           | `jose`                                                                                   | `jose` (isomorphic)                                                                  | 30 lines                                      |
| `createHash('sha256')` (`saved-plan.service.ts:342`, `saved-plan-integrity.ts`)                                       | `Digest { sha256(bytes): Promise<string> }`                                                                                                                                                                                 | `node:crypto`                                                                            | `crypto.subtle`                                                                      | 15 lines, 2 files                             |
| `createHash('sha256')` in `domain/canonical-schedule-input.ts:246` (`scheduleInputHash`)                              | **none** — a `ring:domain` module cannot import a core port. The hash is synchronous and its only caller is `store-sqlite/optimized-schedule-cache.ts`; it **moves there**. `canonicalScheduleInput` stays in domain, pure. | —                                                                                        | —                                                                                    | 1 function moved                              |
| `Buffer.byteLength` (`saved-plan.ts:173`)                                                                             | none — `TextEncoder`                                                                                                                                                                                                        | —                                                                                        | —                                                                                    | 1 line                                        |
| `fetch`, `setTimeout`, `setInterval` defaults (`push-client`, `retention-timer`, `saved-plan-retry`)                  | `PushTransport`, `Timers` — already injected; the **global defaults are removed** so the root must pass them                                                                                                                | globals                                                                                  | globals                                                                              | 3 files                                       |
| `AsyncLocalStorage` in the current broadcaster                                                                        | **No runtime port (D24).** Replace ambience with a collector bound to the batch service graph                                                                                                                               | Same pure collector                                                                      | Same pure collector                                                                  | broadcaster + composition cases (f), (g), (l) |
| TS engine in `@wbs/domain/schedule` and the Python solver in `libs/solver-py`, chosen per project by `ScheduleEngine` | `Scheduler { schedule(input): Promise<Scheduled \| { ok: false; error: 'engine_unavailable'; engine }> }`                                                                                                                   | both engines as adapters in `boot.ts`; `schedulerConformance` holds them to one contract | `tsScheduler` in `runtime-web`; the Python engine answers `engine_unavailable` (D23) | `optimizer-wiring.ts` already half of it      |

`@wbs/auth` is `runtime:bun` today; whatever core needs from it moves behind `TokenCodec` or
`@wbs/auth` becomes isomorphic — decided at Wave 2 by what it actually holds.

**Announcements are explicit (D24).** A route may finish its store write just before the
next batch opens, then publish while that batch is suspended. Serializing store methods does
not serialize the publication after them. Bind a fresh collector to the batch's services and
the direct broadcaster to ordinary services; no shared ambient slot exists. The collector is
pure code in either runtime, so `AsyncLocalStorage` leaves with no replacement runtime port.
Cases (f), (g) and (l) check the actual service composition; (l) includes the previous batch's
post-commit publication, not only a route started during a hold.

**Validation and document generation are separate capabilities (D25).** The declaration
boundary produces `SchemaShape` with both a Standard Schema validator and a matching JSON
Schema descriptor. The emitter reads only the descriptor. Replacing ArkType changes the
schema declarations and their conversion boundary; it does not change the adapter, client
or document emitter. Unsupported conversion throws rather than producing a permissive
schema. §3.1 carries the schema and status-specific refusal tests.

### 3.5 Enforcement negatives (Wave 3, each watched on its own line before the rule is believed)

1. `import { Elysia } from 'elysia'` in a core file → `no-restricted-imports`.
2. `import { createHash } from 'node:crypto'` in `libs/domain` → `no-restricted-imports`.
3. `globalThis.fetch(...)` in core → `no-restricted-syntax`.
4. `@wbs/core` imported from a fe-01 component → ring constraint.
5. `@wbs/store-sqlite` imported from `libs/core` → ring constraint.
6. `@wbs/be-01` imported from `libs/domain` → ring constraint.
7. `new Database()` outside `store-sqlite/db.ts` → the relocated `bun:sqlite` ban.
8. A deliberately failing test in each new lib → `bun run test:unit` red.
9. `import { t } from '@sinclair/typebox'` anywhere → the repo-wide ban (D16).
10. A project moved to `libs/wbs/adapters/` while tagged `ring:application` → the layout test (D19).
11. A second product's lib importing `@wbs/core` → the `product:` constraint (D18).
12. A `project.json` with no `ring:` tag, and one with two → the totality test (D14).
13. `@wbs/store-memory` imported from a `libs/core` **production** file → ring constraint; the
    same import in `compose.test.ts` beside it passes, which is the edge of the test exemption.
14. A shape in `@wbs/contracts` with no `Endpoint` bound to it → the binding test (D21).
15. `import { describe } from 'bun:test'` in a `libs/core` production file → `no-restricted-imports`;
    the same line in a `*.test.ts` passes.
16. A `tools/*` project with no `ring:` tag, and a `libs/` project with no `product:` tag → the
    totality test; a `tools/*` project **with** a `product:` tag → the same test.

The 2026-08-09 gw-01 typecheck that compiled nothing for months is why these are watched
rather than read off the config.

## 4 · Waves

Each wave: one OpenSpec change (intent ≤ 400 words, design, delta specs, `tasks.md` as TDD
slices, `verify.md` with the failure-proof table), one PR, workspace gate green, kit green.

### Wave 0 — collision gate (half a day, no code)

Four open changes touch this plan's files: `dual-optimized-scheduler` (adds
`EventLogRepo.recordEventIn(tx)` and post-commit pushing — the source seam itself),
`plan-json-import` (a route, a TypeBox body, another transaction caller, an MCP tool),
`gantt-calendar-markers` (schema + endpoints), `retired-schema-cleanup` (`insertSubtree`), and
TASK-241 behind them. Before each wave's change is created: list the files it edits, diff
against every open change's `tasks.md`, and either wait for the collider to merge or take its
seam-shaped item into this plan's design. The change's intent names the window it ran in.
Wave 1 now touches `openapi.json`, mcp-01's tool tests and fe-01's client, so `plan-json-import`
in particular should merge first or be rebased onto the endpoint table.

**The critical path is longer than Wave 1's own estimate.** Wave 1.4 replaces fe-01's client
and must carry R1's invalidation coordinator; R1 folds into W4-4's `use-plan-read`, and W4-4
(4 days, not started) is the last open item of the refactoring plan. So W4-4 → R1 (1–2 days)
→ Wave 1.4, and about six agent-days stand in front of Wave 1's step 4 that its "~7 days" does
not include. With §67's R1–R10 the whole programme is roughly thirty agent-days of serial work
before a user sees a change; the plan accepts that, and this sentence is here so nobody
discovers it at Wave 1.4.

The 2026-09-06 follow-up in the refactoring plan (§67) is another collision ledger. Land R1
before replacing fe-01's client and carry its refresh negatives through Wave 1. R3 and R5
touch auth: land them before the auth controller move or name them as owned slices of Wave 1.
R2 and R6 touch stores: land them before Wave 2 wraps/moves those methods. R8 and R9 touch
publication/runtime seams and must have one owner across their fixes and Wave 2. R4 and R7
are gateway-local and do not widen D5; R10 is frontend rendering work, separate from the core
extraction. A fix already merged stays closed; the collision gate records the commit rather
than implementing it again.

### Wave 1 — `http-endpoint-port` (~5 days be-01 + ~2 days fe-01)

1. `SchemaShape`, `EndpointShape`, `ParamsOf`, `RequestPolicy`, the `Refusal` union and `RefusalDetail` in
   `@wbs/contracts`; `Endpoint`, `bind`, `HttpReply`, `EndpointInput`, `PrincipalOf`,
   `IdentityResolver` in be-01 (moving to core in Wave 3); the Elysia `mount(endpoints, ports)`
   adapter with the policy runner in `onRequest`. Type-level negatives first: a handler reading
   `params.foo` on a path without `:foo`, a `{ ok: true, refusal }` reply, a handler reading
   `principal` on a route with no identity policy — each must fail `tsc`. Adapter-local tests:
   policy matrix, pre-parse ordering, ordered `Set-Cookie` (`getSetCookie()` length 3), `EMPTY`
   vs JSON `null`, 302 + Location, the envelope, 429 login throttling, 503 `snapshot_busy`
   and failed dependency health. The reply's status and schema must agree at both ends;
   an injected account-store failure must remain an unexpected failure, never a 401. **Pin
   `tsc` wall time** for be-01 and fe-01 in `verify.md` before the generic shapes land and
   after: `ParamsOf`, `PrincipalOf` and `RefusalReplyOf` over ArkType inference are the kind of
   type that doubles a typecheck and produces errors an agent misreads. If the time doubles,
   `PrincipalOf` goes first (`principal: Identity | null` and a runtime check), `ParamsOf` stays.
2. Move controllers one at a time, smallest first: `smoke` → `step` → `work-item` → `history`
   → `solution` → `saved-plan` → `project` → `directory` → `internal` → `auth`. Each move: the
   controller's tests pass, rewritten only where the wire changed and each rewrite named in
   `verify.md`; one direct `endpoint.handle(literal)` test per refusal path added.
3. Generate JSON Schema descriptors beside the ArkType declarations; unsupported conversion
   fails explicitly. `documentFromShapes` in contracts consumes those descriptors; prove
   nested command unions, optional fields and MCP inline object bodies before broad migration.
   The binding test (every shape has one endpoint);
   `@elysiajs/openapi`, `hand-parsed-body.ts`, `plan-command-schema.ts` deleted;
   `openapi.json` becomes a build output and leaves git; reachability test; mcp-01 derives its
   tools from the shapes, its `openapi-tools.test.ts` green with the derived tool names pinned
   to the new `operationId`s.
4. `clientFromShapes`; fe-01's three API modules and two fakes replaced; the `error ===`
   branches become one `switch` over the `Refusal` union; `bun run e2e` green (the browser gate
   is the wire's oracle). Preserve refactoring R1's invalidation coordinator: hold an old
   response across a new event and require a trailing read; overlap full/step/tree scopes and
   require all pending resources to install. URL-only in-flight sharing is the injected fault.
5. `/health` and `/metrics` as shapes, `/metrics` as the first `TextResponse`; `libs/observability`'s Elysia plugin deleted and the lib retagged `ring:adapter`. `callerGuard` and `app.ts`'s inline `onRequest` deleted.

**Negatives, minimum:** identity policy deleted → 401 matrix; origin policy deleted on a
project POST → foreign-origin write lands; policies after parsing → 422 where 403 is owed;
one mount skipped → reachability 404; a shape with no endpoint → binding test red;
`operationId` dropped → mcp-01 refuses; a response field renamed → fe-01 typecheck red;
`onUndeclaredKey` set to `'delete'` → `number_is_derived` case fails through the adapter; the
three type-level negatives of step 1, each watched as a `tsc` error at the line it names;
drop a nested schema property/union arm → document/MCP fixture fails; make unsupported
conversion return `{}` → conversion refusal test fails; map throttling or `snapshot_busy`
to 400 → adapter status/body matrix fails; skip refusal validation → client accepts a
malformed 429/503 body; reintroduce either R1 race → held-response/scoped-refresh test fails.

### Wave 2 — `store-port-and-unit-of-work` (~6 days; Wave 0 gate first)

1. `Gate` port and `OPEN`; the write coordinator inside `store-sqlite`'s `db.ts`; a `gate`
   argument on every transactional repository constructor and every mutating method wrapped in
   `this.gate.enter`; the D11 suspension negative (d) written first and watched failing with
   the gate removed from one method.
2. `servicesOver(stores, shared)` factored out of `buildServices`; admitted SQLite store
   adapters built once at `open`, scoped services and a fresh collector built per batch.
   `UnitOfWork.run` with `Scope`, `Decision` and `afterRollback(scope)`;
   `PlanCommandRunner` and undo's `walk` moved onto it, undo's discard through the callback's
   fresh admitted live journal. Keep repair outside the transaction catch. Write cases (h),
   (i), (k), (l) first: ordinary gated repair deadlocks; staged repair vanishes; a repair throw
   must survive without a second rollback; a shared collector captures an outside event.
   `unitOfWorkConformance` (a)–(k), plus the scoped-publication case (l), each watched
   failing on its named fault against both sources; see §3.2 for the admission boundary.
3. `EventLogStore` (transactional, on `Scope`), `SavedPlanStore` and `SavedPlanCaptureStore`
   (independent history) ports; `Stores` as the D22 composition split into
   `TransactionalStores` and independent `HistoryStores`; the D12
   cases including (j), saved plans take no turn and successful saves survive both batch
   outcomes. Memory clones/swaps only transactional tables; swapping history too is the
   commit-window negative. Account-store optionality remains typed as D22 requires.
4. Reference-specific outcomes per method; `isForeignKeyViolation` deleted from `service/`.
5. One kit per port assembled from the `.db.test.ts` files under the admission rule, written
   under `apps/be-01/src/testing/kits/` for now and moved to `libs/conformance` in Wave 3.2;
   `sourceConformance` as their composition with a report naming the kits that ran; SQLite
   green; memory source tightened until green.
6. The runtime ports of §3.4 with their Bun adapters in `boot.ts`; global defaults removed;
   ambient announcements replaced by the pure scoped collector (D24), no `AsyncContext` port;
   `scheduleInputHash` moved from `libs/domain` to `store-sqlite/optimized-schedule-cache.ts`
   so domain imports no `node:*`; `Scheduler` with both engines, the `engine_unavailable`
   refusal (D23) surfaced as a `Refusal` by every caller and watched as a 4xx through the
   adapter, and `schedulerConformance`. Vocabulary values relocated.

### Wave 3 — `core-lib-extraction` (~2.5 days)

1. Packages with `project.json`, ring and runtime tags on **every** project — no project
   carries a `ring:` today, and the eleven under `tools/` are `ring:adapter` — the new
   `libs/runtime-web` and `libs/conformance`, `tsconfig`, `typecheck` running `tsc --build --force` on the
   **source** project (R5 #16/#17), `test`, `lint`, `lint:fast`. The totality test first,
   watched failing on a project with no ring.
2. `git mv` in three commits, imports rewritten, `bun run test:unit` green after each. The
   ports barrel becomes one file per port at the move (§3.3); the kits move from
   `apps/be-01/src/testing/kits/` to `libs/conformance`; the `Logger` type and no-op logger
   move from `libs/observability` to `@wbs/contracts`.
3. The rules of §2 with the test-file override, the two relocations, `test:unit` by target;
   the negatives of §3.5, all sixteen.
4. `composeServices({ source, runtime, shared })` and the four use-case entrypoints; the "any
   trigger, any runtime" proof is `libs/core/src/compose.test.ts`, composing core over the
   memory source with the `runtime-web` adapters for `Digest` and `Scheduler`, a batch-owned
   announcement collector, and
   runs a command batch, a saved-plan save with a refused actor, one replay, one retention
   sweep and one `engine_unavailable` refusal without HTTP.
5. Docs: `LLM_README.md`, ADR 0014 / 0015 → `accepted`, refactoring plan cross-reference.

### After Wave 3 — `repo-namespacing` (~1.5 days, own change)

D18 and D19 together, because both are `git mv` of the same directories. Every `project.json`,
`tsconfig.base.json` path, Dockerfile build context, Playwright and Vite config moves with its
app. **Eighteen** files outside `apps/` name an app path (measured 2026-09-06), and the
change's first task is to rewrite every one: `.github/workflows/ci.yml`, `bin/dev-deploy.sh`,
`lefthook.yml`, `tools/tool-bootstrap/src/configure.sh`, `tools/tool-dagger/src/lib/image.ts`,
`tools/tool-dagger/src/main.ts`, `tools/tool-deploy/src/{deploy,migrations}.ts`,
`tools/tool-devsync/src/sync.ts`, `tools/tool-git-hooks/src/hooks/migration-lint.ts`,
`tools/tool-remote-scripts/src/lib/docker.ts`, `tools/tool-smoke/src/{health,ws-ping}.ts` and
the six tests beside them. The migrate CLIs and `drizzle/` move with be-01 in this change and
nowhere else — ADR 0014's "do not move" holds for the three waves, and this is the change that
pays for moving them. The Nx project renames (`be-01` → `wbs-be-01`) ripple into `package.json`
scripts, `bin/*.sh`, lefthook and the deploy tools' `nx run` invocations — grep for every
project name before the move. Verified by the workspace gate **and** a prod `--dry-run`,
because the Dagger publish path builds from the Dockerfiles' contexts. The layout test and
negatives 10–11 are written first.

## 5 · Non-goals

- A second HTTP adapter, and an exported HTTP kit before one exists.
- gw-01's services and mcp-01's authentication/server runtime (D5). mcp-01's tool-schema
  derivation changes in Wave 1. A shared `libs/http-elysia` is a later decision.
- Isolation across a source's concurrent readers (D1).
- Building the browser-only mode (D17). This plan makes it possible and names what it
  needs; nothing here builds it, and the fe-01 ring constraint stays at `ring:domain` until
  something does. Running the Python solver in a browser is out for good.
- A second product. D18 prepares the namespace; no other product's code is part of this plan.
- Moving `apps/be-01/drizzle/` or the migrate CLIs in Waves 1–3 (they move with be-01 in the
  namespacing change); a generic migration port. Additive-only migrations stay: blue and
  green share one SQLite file mid-swap, which is deploy compatibility, not API compatibility.
- Splitting `repository/index.ts` **in place** (W4-1, refused with measurement). It is split
  at the move, §3.3.
- A Postgres source, a file source, a browser source. Each is sketched where it proves the
  port is not SQLite in disguise (§3.2, §7 Q7); none is built.
- A connection pool for SQLite. `bun:sqlite` is synchronous, so a second writer connection
  would sleep the whole thread in SQLite's busy handler while the first finishes, stalling every
  read; the async write coordinator is the writer lane of a pool without the stall. A reader
  pool pays only with worker threads and is the SQLite adapter's private option later.

## 6 · Risks and how each is checked

| Risk                                                                                  | Check                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A batch or repair store waits for its already-held turn                               | Scopes use admitted stores (D20, D28). Cases (h) and (k) inject a coordinator-gated batch write or repair and must time out; repair through the discarded memory scope must leave the journal entry behind.                           |
| An admitted store leaks outside its admitted turn                                     | Case (i) invokes each public transactional write while a batch is suspended and observes it wait; inject OPEN to expose the early write. Scope lifetime excludes public access; independent history is explicitly outside this check. |
| A service rebuilt per batch loses shared state                                        | Share clock, throttle, replay buffer and optimizer wiring; rebuild only the scoped graph/collector. Composition tests assert one shared instance and distinct batch collectors (D24).                                                 |
| A previous route or batch publishes during a following batch                          | Case (l) injects a shared collector; the already-committed event must still leave exactly once after the unrelated batch refuses. No ambient slot exists in either runtime (D24).                                                     |
| Elysia's inference of `params`/`body` lost at the adapter, handlers typed `unknown`   | `EndpointShape` is generic over its path and schemas; the three type-level negatives of Wave 1.1 watched as `tsc` errors                                                                                                              |
| The wire change breaks a client the plan forgot                                       | fe-01 through `clientFromShapes` and `bun run e2e`; mcp-01 through its tool tests; gw-01 forwards bodies opaquely (`forward-client.test.ts` in the gate)                                                                              |
| A project has no ring, so a constraint silently never fires                           | The totality test (§3.5 #12), watched failing on a project with zero tags on an axis                                                                                                                                                  |
| A kit case passes both sources for the wrong reason                                   | Every case watched failing against `brokenSource(memory, fault)` with the fault it names                                                                                                                                              |
| A test misses the window where concurrent work changes ownership                      | Cases (d)–(g), (j)–(l) observe suspended operations, both outcomes of a concurrent save, and the write-before-next-batch publication window. Isolation is not promised (D1).                                                          |
| Wave 2 collides with an open change on the source seam                                | Wave 0 gate, re-run before each change; `recordEventIn(tx)` reconciled into `UnitOfWork.scope` or waited for                                                                                                                          |
| Extraction leaves guards aimed at old folders                                         | §3.5 negatives 7 and 8; `eslint.config.js` has no `apps/be-01/src/repository` path left                                                                                                                                               |
| The emitter requires capabilities a validator does not expose                         | SchemaShape carries generated JSON Schema separately from StandardSchemaV1; nested-union/MCP fixtures and unsupported-conversion negative at the declaration boundary (D25).                                                          |
| The generic endpoint shapes make `tsc` slow and its errors unreadable                 | Wave 1.1's `tsc` wall-time pin, before and after; `PrincipalOf` is the first to go if it doubles                                                                                                                                      |
| Whole-workspace gate diverges from per-project runs (2026-08-30 import-sort incident) | Every wave's `verify.md` records the **workspace** gate                                                                                                                                                                               |

## 7 · Open questions for the implementer

1. `Identity` shape returned by `IdentityResolver`: the same as `userFromHeaders` today.
2. `STEP_POSITION_STEP` and `stepIsInUse`: `@wbs/domain` (facts about steps) rather than core.
3. ~~Whether `Scope` exposes all stores~~ — corrected by D27: transactional stores only.
   Independent history stays at the composition root; it cannot be enlisted by a command.
4. Whether `dual-optimized-scheduler`'s `recordEventIn(tx)` becomes `scope.stores.eventLog.record` —
   decided at Wave 0 by which lands first.
5. Whether `@wbs/auth` becomes isomorphic or is absorbed behind `TokenCodec` — decided at
   Wave 2 by what it holds. Either way it is `ring:adapter` (D14): it holds jose and crypto.
6. ~~Whether to nest `libs/{domain,contracts}` under `libs/core/`~~ — settled by D19: the
   directory is `libs/wbs/domain/…`, applied in the namespacing change.
7. Whether `store-indexeddb` or the memory source with a `persist` hook is the browser mode's
   persistence. Not this plan's to decide; the kit is the same either way. The hook shape is
   in §3.2: stage, act, persist atomically, then expose the committed state; failed persistence
   cannot expose a successful commit. Independent history must stay outside that write set.
8. Where `contracts` sits once the endpoint types join it: `ring:domain` today because fe-01
   and gw-01 import it; an `interface` ring between domain and application is the alternative
   if HTTP shapes in the domain ring start to grate.
