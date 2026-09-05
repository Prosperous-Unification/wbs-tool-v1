# Ports-and-adapters plan — 2026-09-05

be-01 split into an isomorphic application core, one SQLite source, one in-memory source and
one Elysia HTTP adapter, with conformance kits that decide whether a new source is a correct
implementation and an endpoint table that is the one contract fe-01, be-01 and mcp-01 share.
Settled in a grilling session on 2026-09-05, revised the same day after two codex reviews (§8),
then revised again the same evening when Dany lifted the backward-compatibility constraint and
asked for every runtime dependency to arrive by injection (§9), and a third time on 2026-09-06
after a review found the plan's own contradictions (§10). **Not started.** Four OpenSpec
changes, one per wave plus the namespacing change, created when each starts.

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

| #   | Question                                                              | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What does "swappable source" require of ADR 0007's outer transaction? | A behavioural **unit of work** port. Contract: **terminal atomicity** — once `run` settles, either every write inside it is observable through every store's reads or none is. **Isolation is not promised.** ADR 0015.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D2  | Where do the pieces live?                                             | Four packages: `libs/core`, `libs/store-sqlite`, `libs/store-memory`, `apps/be-01`. Direction enforced by Nx ring tags + ESLint. ADR 0014.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D3  | What is the framework-independent controller?                         | **Endpoints as data** — an `EndpointShape` (method, path, operation id, request policies, Standard Schema types, document) in `@wbs/contracts`, and an `Endpoint` in core that binds a pure handler to one shape (D21). **ArkType from Wave 1**, unknown keys **rejected on every route**, **one refusal envelope** for every endpoint, and the OpenAPI document **emitted from the specs**. (Backward compatibility is not a constraint — Dany, §9.)                                                                                                                                                                                                                                                   |
| D4  | Second adapters as living proof?                                      | **No** second HTTP adapter (Dany: "good idea, overkill for now"). The store kit gets two implementations by tightening the in-memory fixtures. HTTP characterization tests stay **local to the Elysia adapter**; an exported HTTP kit is written the day a second adapter exists.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D5  | Scope across apps                                                     | **be-01 and fe-01's API client.** gw-01's `ws.controller.ts` is already framework-free, its upgrade lives in `gw-01/app.ts` and is not an endpoint, and Nx forbids app→app imports. A shared `libs/http-elysia` is a later decision. mcp-01's tools regenerate from the new document; its code is untouched.                                                                                                                                                                                                                                                                                                                                                                                            |
| D6  | The seven value leaks                                                 | Vocabulary moves to core/domain. `isForeignKeyViolation` is replaced by **reference-specific** store outcomes (`unknown_step`, `unknown_person`, …) that the adapter returns **only after proving that reference absent**; any other FK failure stays a thrown unknown. No blanket `unknown_reference`. **Confirmed by Dany after review.**                                                                                                                                                                                                                                                                                                                                                             |
| D7  | Order                                                                 | Wave 0 collision gate → Wave 1 HTTP + shared contract → Wave 2 stores, unit of work, runtime ports, kits → Wave 3 extraction and rings. Each its own OpenSpec change and PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D8  | Packaging                                                             | This document + four OpenSpec changes: `http-endpoint-port`, `store-port-and-unit-of-work`, `core-lib-extraction`, `repo-namespacing`, each created when its wave starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D9  | Records                                                               | ADR 0014 and 0015 `proposed` now, `accepted` by the merging PR of their wave. CONTEXT.md terms written now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D10 | What runtime does core promise?                                       | **`runtime:isomorphic`.** Core imports `@wbs/domain`, `@wbs/contracts`, `@wbs/validation` and the `StandardSchemaV1` type, and **nothing with a runtime**. Every Node, Bun or third-party runtime concern arrives through `composeServices(ports)`: `PasswordHasher`, `TokenCodec`, `Digest`, `AsyncContext`, `Timers`, `PushTransport`, `Scheduler`. §3.4 has the table.                                                                                                                                                                                                                                                                                                                               |
| D11 | Who coordinates writes?                                               | The **source** owns a **write coordinator**: a queue of turns, keyed however that source needs — process-wide for one-connection SQLite (today's `WriteLock`, moved inside the adapter), per project for a Postgres source (`pg_advisory_xact_lock`), a no-op where every transaction has its own connection. Every mutating adapter method asks it for a turn; `UnitOfWork.run` takes **one** turn for the whole batch. **There is no re-entrancy**: the batch's own writes never ask (D20), outsiders wait. `WriteLock` leaves core.                                                                                                                                                                  |
| D12 | Saved plans and the unit of work                                      | Saved-plan capture and write are **independent operations** of the source, never enlisted in a command batch and **never taking a turn**: they run on their own connection, so an open batch neither delays nor undoes them. Their kit cases say so.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D13 | **New.** What is the contract between fe-01 and be-01?                | **The endpoint shapes.** Every `EndpointShape`, its `P, Q, B, R` types and `RefusalCode` live in `@wbs/contracts`; be-01 binds handlers to those shapes, fe-01 derives a typed client from the same shapes. A renamed field breaks fe-01's typecheck, not a screen. fe-01's four hand-written API modules are replaced. (Revised by D21: the table with handlers cannot cross the ring boundary; the shapes can.)                                                                                                                                                                                                                                                                                       |
| D14 | **New.** How is dependency direction stated across packages?          | **Rings**, as Nx tags, and **every project has exactly one**: `ring:domain` (`domain`, `contracts`, `validation`, `observability`, `config`), `ring:application` (`core`), `ring:adapter` (`store-*`, `runtime-web`, `auth`, `realtime`, `solver-py`, `be-01`, `fe-01`, `gw-01`, `mcp-01`). Each ring depends only inward; fe-01 additionally only on `ring:domain` and `runtime:browser` adapters. `domain` and `contracts` stay **separate Nx projects** because fe-01 and gw-01 import them and a boundary is per project. A totality test asserts one tag per axis per project (§3.5 #12).                                                                                                          |
| D15 | **New.** Ambient batch context in the browser                         | `AsyncContext` is a port (Dany: option 1). Bun/Node adapt `AsyncLocalStorage`; the browser adapter is a single slot that **throws on overlap**. Correct **because of D20**: ownership of the batch's writes is explicit, so the coordinator keeps outsiders out and only the batch's own writes can publish while it is open. Had ownership been ambient, the slot would have admitted outsiders (§10). Two kit cases prove it.                                                                                                                                                                                                                                                                         |
| D16 | **New.** Which validator, where?                                      | **ArkType everywhere, both ends of the wire.** Every schema in the repo is an ArkType type exposed as `StandardSchemaV1`; `@sinclair/typebox` is banned repo-wide by lint once Wave 1 deletes Elysia's `t`. The derived client validates **responses** against the spec's `R` type, replacing fe-01's thirteen `as` casts in `wbs-api.ts`. Config, WS frames and the internal contract already use it.                                                                                                                                                                                                                                                                                                  |
| D17 | **New.** Can the whole product run in a browser?                      | **Yes, by construction, not by this plan's waves.** Core and the memory source are isomorphic (D10); `clientFromShapes(shapes, transport)` takes an in-process transport that calls `endpoint.handle` directly; the broadcaster gets an in-tab adapter; persistence is a third source the kit certifies — `store-indexeddb`, or the memory source with a persist hook (§7 Q7). A browser source has **no accounts**, so `Stores` is a composition and the kits are per port (D22); it has no Python solver, so a project stored on that engine is **refused** with `engine_unavailable`, never silently rescheduled (D23). Widening fe-01's ring constraint to `ring:application` is the day it starts. |
| D18 | **New.** One repo, several products                                   | **Namespace by directory, project name and tag; aliases stay.** `apps/wbs/*`, `libs/wbs/*`, project names `wbs-*`, tag `product:wbs`, rule `product:X → product:X \| product:shared`; `@wbs/*` aliases unchanged; `tools/*` is infra. Its own change after Wave 3, verified by a prod dry-run because Dockerfile build contexts move. **Eighteen** files outside `apps/` name an app path (measured 2026-09-06, §4); the change's first task is that list.                                                                                                                                                                                                                                              |
| D19 | **New.** Ring in the names?                                           | **In the directory, never in the name.** `libs/wbs/{domain,application,adapters}/…`, `apps/wbs/…`; project names and aliases stay short (`wbs-domain`, `@wbs/core`). The `ring:` tag is the enforced truth and a test asserts directory ring = tag, so the path cannot lie. Rejected: `wbs-adapter-01-fe-01` and `wbs-domain-contracts` — a ring is an attribute, a name is an identity; a lib that moves rings would churn every import; contracts' ring is still the open question.                                                                                                                                                                                                                   |
| D20 | **New (§10).** How does a store know a write is the batch's own?      | **Through `scope`, never ambiently.** `UnitOfWork.run` hands `act` a `Scope` whose `stores` are the same adapter classes built so their writes are already inside the batch: an open **gate** for one-connection SQLite, the transaction client for Postgres, the staged clone for memory. The batch runner builds its services with `servicesOver(scope.stores, shared)`; route writes, retention and saved plans use the ordinary stores, which take turns. For SQLite that graph is built once at `open`. The alternative — an owner token in `AsyncContext` — was rejected because the single-slot browser adapter hands the token to everyone (§10).                                               |
| D21 | **New (§10).** Where does the endpoint table live?                    | **Split.** `EndpointShape<P,Q,B,R>` — everything but the handler — in `@wbs/contracts` (`ring:domain`), so fe-01, mcp-01 and `documentFromShapes` read it without touching core. `Endpoint = EndpointShape & { handle }` in core. The table fe-01 derives its client from is the shapes; the table be-01 mounts is the endpoints; one test asserts every shape has exactly one endpoint bound to it.                                                                                                                                                                                                                                                                                                    |
| D22 | **New (§10).** One `Stores` record or a composition?                  | **A composition, and kits per port.** `Stores = PlanStores & DirectoryStores & AccountStores & HistoryStores`; `sourceConformance` is the composition of one kit per port (`stepStoreConformance(openStores)`, …); `composeServices` accepts a source without `AccountStores` and omits `AuthService`, and the type says so. A source is certified for the ports it implements, and the certificate names them.                                                                                                                                                                                                                                                                                         |
| D23 | **New (§10).** A project's engine is not available here               | **Refuse.** `Scheduler.schedule` answers `{ ok: false; error: 'engine_unavailable'; engine }` when the project's stored engine has no adapter in this composition; every caller of the schedule surfaces it as a `Refusal`. Never fall back: dates from an engine the project did not choose are a wrong plan with no mark on it in any export (R5).                                                                                                                                                                                                                                                                                                                                                    |

```
libs/domain         @wbs/domain          ring:domain       runtime:isomorphic   vocabulary, tree rules, derivation, the TS schedule engine (a pure function; its Scheduler adapter lives in runtime-web and boot.ts), saved-plan shape
libs/contracts      @wbs/contracts       ring:domain       runtime:isomorphic   WS frames, internal, and from Wave 1 every EndpointShape with its P/Q/B/R types and RefusalCode (D21)
libs/validation     @wbs/validation      ring:domain       runtime:isomorphic   ArkType wrapper; domain's self-validating values use it
libs/observability  @wbs/observability   ring:domain       runtime:isomorphic   Logger type and the no-op logger; core's services import the type
libs/config         @wbs/config          ring:domain       runtime:isomorphic   ArkType-validated env shapes; no I/O
libs/core           @wbs/core            ring:application  runtime:isomorphic
  ports/            one file per port: *Store, EventLogStore, SavedPlanStore, SavedPlanCaptureStore, UnitOfWork, Gate, Clock,
                    Broadcaster, IdentityResolver, PasswordHasher, TokenCodec, Digest, AsyncContext, Timers, PushTransport, Scheduler
  services/         every class now in apps/be-01/src/service, bodies changed only where a port replaces a global
  use-cases/        runCommandBatch, savePlan (authorization + announcement, out of the controller), replay, retentionSweep
  http/             Endpoint = EndpointShape & { handle }, HttpReply, the binding table, mountable by any adapter
  kits/             one kit per port, sourceConformance = their composition; unitOfWorkConformance(open); schedulerConformance(engine); brokenSource(source, faults)
  compose.ts        composeServices({ source, runtime, shared }) and servicesOver(stores, shared) — one graph, saved plans and the command runner included
libs/store-sqlite   @wbs/store-sqlite    ring:adapter      runtime:bun          drizzle adapters, schema.ts, db.ts (openConnection, pragmas, the write coordinator), scheduleInputHash, migrate*.ts
libs/store-memory   @wbs/store-memory    ring:adapter      runtime:isomorphic   the in-memory source, promoted from apps/be-01/src/testing/*-fixture.ts; a persist hook is where a file source starts
libs/runtime-web    @wbs/runtime-web     ring:adapter      runtime:isomorphic   Digest over crypto.subtle, the single-slot AsyncContext, tsScheduler, in-tab Broadcaster; the "any trigger, any runtime" proof test
libs/auth           @wbs/auth            ring:adapter      runtime:bun          jose and node:crypto behind TokenCodec and the OIDC store (§7 Q5)
libs/realtime       @wbs/realtime        ring:adapter      runtime:browser      unchanged
libs/solver-py      —                    ring:adapter      runtime:bun          the Python engine, mounted as a Scheduler adapter in boot.ts
apps/be-01                               ring:adapter      runtime:bun          elysia adapter, boot.ts (config, logger, the runtime adapters, composition), migrate-*-cli.ts
apps/fe-01                               ring:adapter      runtime:browser      the derived typed client replaces lib/{api,wbs-api,saved-plan-api}.ts
apps/gw-01, apps/mcp-01                  ring:adapter      runtime:bun          untouched (D5)
```

Every project in the workspace appears above or is `scope:infra` under `tools/`. A ring the
lint cannot find on a project is a constraint that never fires — the first Wave 3 lint run
over the v3.1 list would have failed on fe-01's import of `libs/realtime` and core's import of
`Logger` from `@wbs/observability` (§10).

**Dependency direction, enforced** (§3.5 has the negatives):

- Nx `depConstraints` on rings: `ring:domain` → `ring:domain`; `ring:application` → `ring:domain | ring:application`; `ring:adapter` → any ring; plus `allSourceTags: ['ring:adapter', 'runtime:browser']` → `ring:domain` and `runtime:browser` adapters only, until an offline mode wants core in the browser.
- `no-restricted-imports` in `libs/core/src` and `libs/domain/src`: `node:*`, `bun:*`, `elysia`, `@elysiajs/*`, `drizzle-orm`, `jose`.
- `no-restricted-globals` in the same two: `Bun`, `process`, `fetch`, `setTimeout`, `setInterval`, `Buffer` (plus `no-restricted-syntax` for `globalThis.fetch`).

The **existing** guards move with the code: the drizzle rules and the `bun:sqlite` ban are
re-aimed at `libs/store-sqlite/src` (with `db.ts` the one exemption), and `test:unit` in
`package.json` names the new projects.

**Directory layout (D18, D19), applied in the namespacing change after Wave 3:**

```
apps/wbs/{be-01,fe-01,gw-01,mcp-01}                                        product:wbs  ring:adapter
libs/wbs/domain/{domain,contracts,validation,observability,config}         product:wbs  ring:domain
libs/wbs/application/core                                                  product:wbs  ring:application
libs/wbs/adapters/{store-sqlite,store-memory,runtime-web,auth,realtime,solver-py}  product:wbs  ring:adapter
tools/*                                                                    scope:infra  (shared by every product)
```

Project names `wbs-be-01`, `wbs-domain`, `wbs-core`, …; import aliases stay `@wbs/*`. Two tests
in the shape of `test-tiers.test.ts` walk `libs/` and `apps/`: the **layout** test fails when a
project's directory ring disagrees with its `ring:` tag or its `product:` tag disagrees with
its top directory; the **totality** test fails when a project carries zero or two tags on any
axis (`scope`, `ring`, `runtime`, `product`), because a project the constraints cannot see is a
constraint that cannot fire.

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
  params?: StandardSchemaV1<ParamsOf<Path>>; // refines the derived names; cannot add or drop one
  query?: StandardSchemaV1<Q>;
  body?: StandardSchemaV1<B>; // ArkType, unknown keys rejected
  response: StandardSchemaV1<R>; // the client validates against it (D16)
  document: { summary: string; refusals: readonly RefusalCode[] };
}
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
  | { ok: true; status: 200 | 201 | 204 | 302; body: ResponseOf<S> | typeof EMPTY; headers?: Header[] }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 422; refusal: Refusal; headers?: Header[] };
type Header = [name: string, value: string]; // ordered multimap: three Set-Cookie on the callback
```

The types are shaped so the three ways a hand-written spec can lie are unrepresentable: a
path and its params schema cannot disagree, a 200 cannot carry a refusal, and a handler on an
unauthenticated route cannot read a principal. `EMPTY ≠ JSON null`.

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
  `404` at that path. `/health` and `/metrics` are shapes too. `openapi.json` stops being a
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
  `response` schema before handing it to a screen, so a be-01 that answers a shape the
  contract does not declare is a typed client error at the boundary rather than an
  `undefined` three renders later. Negative: a response field's type changed in be-01 only →
  the client refuses the response in fe-01's tests.
- **Transport is a parameter.** `transport` is `fetch` in production and an in-process
  `(shape, input) => endpointFor(shape).handle(input)` for tests and for the browser-only
  mode (D17). The same fake serves fe-01's unit tests; the two hand-written fakes are deleted.
- **Deletion test:** with the adapter deleted, every endpoint is a typed function a unit test
  can call with a literal input.

### 3.2 Stores, the write coordinator and the unit of work (Wave 2)

- Every `*Store` port stays, one file per port under `core/ports/`. **Added:** `EventLogStore`
  (renamed from `EventLogRepo`), `SavedPlanStore`, `SavedPlanCaptureStore`, `Gate`. `Stores`
  is a **composition** (D22): `PlanStores & DirectoryStores & AccountStores & HistoryStores`,
  so a source can implement a subset and the type of `composeServices` says what is then
  missing from the graph (`auth` is absent when `AccountStores` is). The `Source` port is
  `{ stores: Stores; uow: UnitOfWork; open(); health(); close() }`.
- **Write coordinator (D11).** A queue of turns the source owns, keyed as the source needs:
  process-wide for one-connection SQLite, per project for Postgres, a no-op where every
  transaction has its own connection. Every mutating adapter method asks it for a turn through
  the **gate** it was constructed with; `UnitOfWork.run` takes one turn for the whole batch.
  This closes the pre-existing gap in §0. Negative, the one D11 hangs on: suspend a real batch
  after its first write, start `StepService.add` from outside, refuse the batch → the step
  **is** stored and its event is consistent. Watched failing with the gate removed from
  `StepRepository.insert` (today's shape).

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
  for memory. The batch runner does `servicesOver(scope.stores, shared)`, where `shared` is
  the clock, the `DeferringBroadcaster`, the replay buffer and the optimizer wiring — one
  instance per process, never rebuilt. For SQLite the admitted stores and the services over
  them are built **once at `open`**; the memory source rebuilds per batch because its
  `scope.stores` point at a fresh clone. Route writes, the retention sweep and saved plans use
  `source.stores`, whose gate is the coordinator. `Scope` exposes the whole `Stores` record
  (§7 Q3 answered): one type for both callers of `servicesOver`; which stores a batch may use
  is the kit's job, not the type's. **Why not an owner token in `AsyncContext`:** in Bun an
  outsider would read `undefined` and wait, correct; in the browser the single slot hands the
  batch's token to everyone while the batch is open, so the outsider is admitted inside it —
  the very fault D11 exists to stop. D15's argument for the slot holds only because ownership
  does not travel through it.
- **`UnitOfWork.run` protocol**, because refusals here are **returned values**:

  ```ts
  interface UnitOfWork {
    run<T>(act: (scope: Scope) => Promise<Decision<T>>): Promise<T>;
  }
  interface Scope {
    stores: Stores; // already inside the batch; never take a turn
  }
  type Decision<T> =
    | { commit: true; value: T }
    | { commit: false; value: T; afterRollback?: () => Promise<void> };
  ```

  A thrown error rolls back and rethrows. `afterRollback` runs before the turn is released —
  undo's stale-journal discard needs that window (`plan-commands.ts:222–236`), and it writes
  through `source.stores.journal`, not `scope.stores.journal`: the batch's journal write was
  just rolled back, this one must stay.

  SQLite, memory and Postgres in one shape each:

  ```ts
  // store-sqlite: same connection, savepoints nest as ADR 0007 measured
  run: (act) =>
    coordinator.enter(async () => {
      db.run('BEGIN IMMEDIATE');
      try {
        const decision = await act({ stores: admitted });
        if (decision.commit) {
          db.run('COMMIT');
          return decision.value;
        }
        db.run('ROLLBACK');
        await decision.afterRollback?.();
        return decision.value;
      } catch (cause) {
        db.run('ROLLBACK');
        throw cause;
      }
    });
  // store-memory: stage, act, swap
  run: (act) =>
    coordinator.enter(async () => {
      const staged = structuredClone(tables);
      const decision = await act({ stores: buildStores(() => staged, OPEN) });
      if (decision.commit) tables = staged;
      else await decision.afterRollback?.();
      return decision.value;
    });
  // a future store-postgres: the transaction client is the scope
  run: (act) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${projectId})`); // the coordinator, per project
      const decision = await act({ stores: buildStores(tx) });
      if (!decision.commit) tx.rollback();
      return decision.value;
    });
  ```

  The Postgres sketch is not a promise of a Postgres source. It is here because it is the
  evidence that the port is not SQLite in disguise: the same three interfaces, and the only
  file that changes is the source's own.

- **Terminal atomicity, tested in the window it lives in.** `unitOfWorkConformance`:
  (a) three writes across three stores, the third refused via `Decision` → none observable
  after `run`; (b) the same with the third **throwing**; (c) a committed batch observable
  through all three; (d) the D11 suspension case, against **both** sources and both
  `AsyncContext` adapters; (e) a retention prune started while a batch is suspended is **not**
  undone by the rollback; (f) a publish from inside a suspended batch is held by that batch
  and released after commit; (g) a write started from outside while a batch is suspended
  publishes **after** the batch's release, never inside it; (h) **the deadlock negative**: a
  `scope` store written inside `run` completes within the timeout — watched timing out with
  `admitted` built over the coordinator instead of `OPEN`; (i) every value in `source.stores`
  was built over the coordinator — a walk that fails on the first store built over `OPEN`.
  (f) and (g) are D15's proof that a single-slot `AsyncContext` is correct; they run against
  both adapters.
- **Saved plans (D12)**: coherent capture, fail-fast contention, header+body atomic, quota
  checked inside the write, all independent of any open batch and **taking no turn** — they
  run on their own connection, and case (j) asserts a save during a suspended batch neither
  waits for it nor is undone by it. `saved-plan-in-transaction.db.test.ts:120` becomes a kit
  case.
- **Reference-specific outcomes (D6).** Negative: FK failure on a **person** while the step
  exists → throws; step deleted → `unknown_step`.
- **Kits per port (D22).** `stepStoreConformance(openStores)`, `workItemStoreConformance`, …,
  one per port, each a function of a factory; `sourceConformance(open)` is their composition
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
batch runner calls with `scope.stores` (D20). Use-case entrypoints are what a non-HTTP caller
invokes; `savePlan` carries the authorization and announcement the controller holds today
(`saved-plan.controller.ts:210–222`). Config loading, the logger adapter and the Bun runtime
adapters live in `boot.ts`; the browser adapters live in `libs/runtime-web`, which is also
where the "any trigger, any runtime" proof runs, because a test that composes core over a
source is an adapter-ring test and cannot live in core without breaking negative 5 in core's
own test file.

The 2,063-line `repository/index.ts` barrel is not split in place (W4-1, refused with
measurement); at the move it becomes one file per port under `core/ports/` with a re-exporting
index, because `git mv` cannot preserve history across a split and the move is the one moment
the split is free.

### 3.4 Runtime ports (D10; built in Wave 2 while the code still lives in be-01)

| Today                                                                                                                 | Port                                                                                                                                                                                                                        | Bun/Node adapter                                                                         | Browser adapter                                                                      | Size                                     |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `Bun.password.hash/verify` (`auth.service.ts:76,84`)                                                                  | `PasswordHasher { hash; verify }`                                                                                                                                                                                           | `Bun.password`                                                                           | none needed (no accounts offline)                                                    | 20 lines                                 |
| `SignJWT` / `jwtVerify` from `jose` (`auth.service.ts:129,167`)                                                       | `TokenCodec { sign(claims, ttl); verify(token) }`                                                                                                                                                                           | `jose`                                                                                   | `jose` (isomorphic)                                                                  | 30 lines                                 |
| `createHash('sha256')` (`saved-plan.service.ts:342`, `saved-plan-integrity.ts`)                                       | `Digest { sha256(bytes): Promise<string> }`                                                                                                                                                                                 | `node:crypto`                                                                            | `crypto.subtle`                                                                      | 15 lines, 2 files                        |
| `createHash('sha256')` in `domain/canonical-schedule-input.ts:246` (`scheduleInputHash`)                              | **none** — a `ring:domain` module cannot import a core port. The hash is synchronous and its only caller is `store-sqlite/optimized-schedule-cache.ts`; it **moves there**. `canonicalScheduleInput` stays in domain, pure. | —                                                                                        | —                                                                                    | 1 function moved                         |
| `Buffer.byteLength` (`saved-plan.ts:173`)                                                                             | none — `TextEncoder`                                                                                                                                                                                                        | —                                                                                        | —                                                                                    | 1 line                                   |
| `fetch`, `setTimeout`, `setInterval` defaults (`push-client`, `retention-timer`, `saved-plan-retry`)                  | `PushTransport`, `Timers` — already injected; the **global defaults are removed** so the root must pass them                                                                                                                | globals                                                                                  | globals                                                                              | 3 files                                  |
| `AsyncLocalStorage` (`broadcast.ts:225`)                                                                              | `AsyncContext<T> { run(value, fn); get() }` — announcements only, never ownership (D20)                                                                                                                                     | `AsyncLocalStorage`                                                                      | single slot, **throws on overlap**; correct under D11 + D20                          | 1 file + kit (f),(g)                     |
| TS engine in `@wbs/domain/schedule` and the Python solver in `libs/solver-py`, chosen per project by `ScheduleEngine` | `Scheduler { schedule(input): Promise<Scheduled \| { ok: false; error: 'engine_unavailable'; engine }> }`                                                                                                                   | both engines as adapters in `boot.ts`; `schedulerConformance` holds them to one contract | `tsScheduler` in `runtime-web`; the Python engine answers `engine_unavailable` (D23) | `optimizer-wiring.ts` already half of it |

`@wbs/auth` is `runtime:bun` today; whatever core needs from it moves behind `TokenCodec` or
`@wbs/auth` becomes isomorphic — decided at Wave 2 by what it actually holds.

**Why `AsyncContext` can be a single slot in the browser.** Browsers have no
`AsyncLocalStorage` and TC39's `AsyncContext` has not shipped. A publish is caused by a write;
under D11 every outside write waits for a turn and under D20 the batch's own writes are the
only ones that do not; so while a batch is open nothing else can publish and the slot cannot
be shared. The ambience only ever has to span the awaits inside **one** batch, and it carries
**only announcements** — the moment it also carried "who owns the coordinator", the slot
would answer that question wrongly for every outsider (§10). The slot throws on overlap so a
coordinator bug is loud rather than a mis-attributed announcement. A shared worker serving
several tabs would break the assumption and would need the announcements passed through
`scope` as well (ADR 0012's shape); that is the door left open, not a promise — and D20 has
already opened it half way, since `servicesOver(scope.stores, shared)` could take a
batch-scoped broadcaster in `shared` and make the port unnecessary.

**Validation is a boundary, not a port.** Contracts declares its ~35 schemas as ArkType values
and exposes them only as `StandardSchemaV1`. The adapter and `documentFromShapes` see the interface,
so swapping the library never touches them — but the declarations are authored code, and
swapping ArkType for Zod means rewriting them. Injection cannot remove that cost; it removes
every other file's knowledge of which library it was.

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
13. `@wbs/store-memory` imported from a `libs/core` **test** file → ring constraint; the proof
    test lives in `runtime-web` and this is what keeps it there.
14. A shape in `@wbs/contracts` with no `Endpoint` bound to it → the binding test (D21).

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

### Wave 1 — `http-endpoint-port` (~5 days be-01 + ~2 days fe-01)

1. `EndpointShape`, `ParamsOf`, `RequestPolicy`, the `Refusal` union and `RefusalDetail` in
   `@wbs/contracts`; `Endpoint`, `bind`, `HttpReply`, `EndpointInput`, `PrincipalOf`,
   `IdentityResolver` in be-01 (moving to core in Wave 3); the Elysia `mount(endpoints, ports)`
   adapter with the policy runner in `onRequest`. Type-level negatives first: a handler reading
   `params.foo` on a path without `:foo`, a `{ ok: true, refusal }` reply, a handler reading
   `principal` on a route with no identity policy — each must fail `tsc`. Adapter-local tests:
   policy matrix, pre-parse ordering, ordered `Set-Cookie` (`getSetCookie()` length 3), `EMPTY`
   vs JSON `null`, 302 + Location, the envelope.
2. Move controllers one at a time, smallest first: `smoke` → `step` → `work-item` → `history`
   → `solution` → `saved-plan` → `project` → `directory` → `internal` → `auth`. Each move: the
   controller's tests pass, rewritten only where the wire changed and each rewrite named in
   `verify.md`; one direct `endpoint.handle(literal)` test per refusal path added.
3. `documentFromShapes` in contracts; the binding test (every shape has one endpoint);
   `@elysiajs/openapi`, `hand-parsed-body.ts`, `plan-command-schema.ts` deleted;
   `openapi.json` becomes a build output and leaves git; reachability test; mcp-01 derives its
   tools from the shapes, its `openapi-tools.test.ts` green with the derived tool names pinned
   to the new `operationId`s.
4. `clientFromShapes`; fe-01's three API modules and two fakes replaced; the `error ===`
   branches become one `switch` over the `Refusal` union; `bun run e2e` green (the browser gate
   is the wire's oracle).
5. `/health` and `/metrics` as shapes. `callerGuard` and `app.ts`'s inline `onRequest` deleted.

**Negatives, minimum:** identity policy deleted → 401 matrix; origin policy deleted on a
project POST → foreign-origin write lands; policies after parsing → 422 where 403 is owed;
one mount skipped → reachability 404; a shape with no endpoint → binding test red;
`operationId` dropped → mcp-01 refuses; a response field renamed → fe-01 typecheck red;
`onUndeclaredKey` set to `'delete'` → `number_is_derived` case fails through the adapter; the
three type-level negatives of step 1, each watched as a `tsc` error at the line it names.

### Wave 2 — `store-port-and-unit-of-work` (~6 days; Wave 0 gate first)

1. `Gate` port and `OPEN`; the write coordinator inside `store-sqlite`'s `db.ts`; a `gate`
   argument on every repository constructor and every mutating method wrapped in
   `this.gate.enter`; the D11 suspension negative (d) written first and watched failing with
   the gate removed from one method.
2. `servicesOver(stores, shared)` factored out of `buildServices`; `admitted = buildStores(db,
OPEN)` built once at `open`; `UnitOfWork.run` with `Scope`, `Decision` and `afterRollback`;
   `PlanCommandRunner` and undo's `walk` moved onto it, undo's discard through
   `source.stores.journal`; the deadlock negative (h) watched timing out with `admitted` built
   over the coordinator; the walk (i) watched failing on one store built over `OPEN`.
   `unitOfWorkConformance` (a)–(j) watched failing against `brokenSource`.
3. `EventLogStore`, `SavedPlanStore`, `SavedPlanCaptureStore` ports; `Stores` as the D22
   composition; the D12 cases including (j), saved plans take no turn.
4. Reference-specific outcomes per method; `isForeignKeyViolation` deleted from `service/`.
5. One kit per port assembled from the `.db.test.ts` files under the admission rule;
   `sourceConformance` as their composition with a report naming the kits that ran; SQLite
   green; memory source tightened until green.
6. The runtime ports of §3.4 with their Bun adapters in `boot.ts`; global defaults removed;
   `scheduleInputHash` moved from `libs/domain` to `store-sqlite/optimized-schedule-cache.ts`
   so domain imports no `node:*`; `Scheduler` with both engines, the `engine_unavailable`
   refusal (D23) surfaced as a `Refusal` by every caller and watched as a 4xx through the
   adapter, and `schedulerConformance`. Vocabulary values relocated.

### Wave 3 — `core-lib-extraction` (~2.5 days)

1. Packages with `project.json`, ring and runtime tags on **every** project including the
   six that had none (`auth`, `config`, `observability`, `realtime`, `solver-py`, `mcp-01`),
   the new `libs/runtime-web`, `tsconfig`, `typecheck` running `tsc --build --force` on the
   **source** project (R5 #16/#17), `test`, `lint`, `lint:fast`. The totality test first,
   watched failing on a project with no ring.
2. `git mv` in three commits, imports rewritten, `bun run test:unit` green after each. The
   ports barrel becomes one file per port at the move (§3.3).
3. The three rules of §2, the two relocations, `test:unit` by target; the negatives of §3.5,
   all fourteen.
4. `composeServices({ source, runtime, shared })` and the four use-case entrypoints; the "any
   trigger, any runtime" proof is a test in `libs/runtime-web` that composes core over the
   memory source with the **browser** adapters for `Digest`, `AsyncContext` and `Scheduler` and
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
- gw-01's services and mcp-01's code (D5). A shared `libs/http-elysia` is a later decision.
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

## 6 · Risks and how each is checked

| Risk                                                                                  | Check                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A store write inside `run` waits for the turn `run` already holds (deadlock)          | No re-entrancy to get wrong: `scope.stores` never ask (D20). Kit (h) watched timing out with `admitted` built over the coordinator                                                    |
| An admitted store leaks outside `run` and writes without a turn                       | Kit (i) walks `source.stores` and fails on the first one built over `OPEN`; `run` is the only caller of `buildStores(…, OPEN)`, asserted by grep in `verify.md`                       |
| A service rebuilt per batch loses state a batch should share                          | Measured 2026-09-06: the only mutable per-instance field in a batch service is `WorkItemService.collector`, which is per-batch by design; throttle, buffer and timer live in `shared` |
| The browser `AsyncContext` slot mis-attributes a publish                              | Kit cases (f) and (g) against the slot adapter; the slot throws on overlap; ownership never travels through it (D20)                                                                  |
| Elysia's inference of `params`/`body` lost at the adapter, handlers typed `unknown`   | `EndpointShape` is generic over its path and schemas; the three type-level negatives of Wave 1.1 watched as `tsc` errors                                                              |
| The wire change breaks a client the plan forgot                                       | fe-01 through `clientFromShapes` and `bun run e2e`; mcp-01 through its tool tests; gw-01 forwards bodies opaquely (`forward-client.test.ts` in the gate)                              |
| A project has no ring, so a constraint silently never fires                           | The totality test (§3.5 #12), watched failing on a project with zero tags on an axis                                                                                                  |
| A kit case passes both sources for the wrong reason                                   | Every case watched failing against `brokenSource(memory, fault)` with the fault it names                                                                                              |
| Terminal atomicity tested after the fact misses in-flight visibility                  | Cases (d)–(g) assert **during** a suspended batch; isolation is documented as not promised (D1)                                                                                       |
| Wave 2 collides with an open change on the source seam                                | Wave 0 gate, re-run before each change; `recordEventIn(tx)` reconciled into `UnitOfWork.scope` or waited for                                                                          |
| Extraction leaves guards aimed at old folders                                         | §3.5 negatives 7 and 8; `eslint.config.js` has no `apps/be-01/src/repository` path left                                                                                               |
| Swapping the validation library later is dearer than it looks                         | Stated in §3.4: the ~35 declarations are the cost; everything else sees `StandardSchemaV1`                                                                                            |
| Whole-workspace gate diverges from per-project runs (2026-08-30 import-sort incident) | Every wave's `verify.md` records the **workspace** gate                                                                                                                               |

## 7 · Open questions for the implementer

1. `Identity` shape returned by `IdentityResolver`: the same as `userFromHeaders` today.
2. `STEP_POSITION_STEP` and `stepIsInUse`: `@wbs/domain` (facts about steps) rather than core.
3. ~~Whether `Scope` exposes all stores or only the mutating ones~~ — settled by D20: all,
   one type for both callers of `servicesOver`; the kit says which a batch may use.
4. Whether `dual-optimized-scheduler`'s `recordEventIn(tx)` becomes `scope.stores.eventLog.record` —
   decided at Wave 0 by which lands first.
5. Whether `@wbs/auth` becomes isomorphic or is absorbed behind `TokenCodec` — decided at
   Wave 2 by what it holds. Either way it is `ring:adapter` (D14): it holds jose and crypto.
6. ~~Whether to nest `libs/{domain,contracts}` under `libs/core/`~~ — settled by D19: the
   directory is `libs/wbs/domain/…`, applied in the namespacing change.
7. Whether `store-indexeddb` or the memory source with a `persist` hook is the browser mode's
   persistence. Not this plan's to decide; the kit is the same either way. The hook shape is
   in §3.2: stage, act, swap, then one atomic write of the whole document.
8. Where `contracts` sits once the endpoint types join it: `ring:domain` today because fe-01
   and gw-01 import it; an `interface` ring between domain and application is the alternative
   if HTTP shapes in the domain ring start to grate.

## 8 · Review disposition (2026-09-05, first revision)

Two headless codex runs over the first draft and the code: `tmp/review-codex-ports-and-adapters.txt`
(gpt-5.6-sol xhigh, 15 findings, verdict "rethink §§2–4") and
`tmp/review-codex-astra-ports-and-adapters.txt` (gpt-6-astra xhigh, 16 findings, verdict
"rethink §3.1 and §3.2"). Every file:line cited below was re-read before the disposition.
S = 5.6-sol finding, A = astra finding. Three dispositions were later **superseded by §9** and
are marked so.

| Finding                                                                                                      | Disposition                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1, A3 — the lock guards publication only; route writes and the retention prune land inside an open batch    | **Accepted, and it is a pre-existing gap between ADR 0007's text and the code.** D11, kit cases (d) and (e).                                                                       |
| S4, A2 — `run` cannot tell a returned refusal from success; undo needs post-rollback work; no lock ownership | **Accepted.** `Decision<T>` with `afterRollback`. The "re-entrancy by owner token" half was **superseded by §10 / D20**: ownership travels through `scope`, nothing re-enters.     |
| A3 — "not observable at all" over-promises on a shared connection                                            | **Accepted.** D1 narrowed to terminal atomicity; ADR 0015 amended.                                                                                                                 |
| S2, A1, A6 — origin check is global, write-scope is pre-parse; `caller` cannot express either                | **Accepted.** `RequestPolicy[]`; adapter phases specified; three negatives.                                                                                                        |
| S3, A5 — `HttpReply.headers` cannot carry three `Set-Cookie`; the callback re-reads the raw request          | **Accepted.** Ordered multimap, `request` on the input, `EMPTY` sentinel.                                                                                                          |
| S15, A6, A15 — ArkType blanket rejection changes the wire; interop is not the blocker                        | **Accepted then; superseded by §9.** Wire compatibility was the only reason to defer ArkType, and Dany lifted it. ArkType, one envelope and the emitted document are Wave 1 again. |
| S6, A9 — `document` too small for mcp-01; spec-derived diff loses the mounting oracle                        | **Accepted.** `operationId` on the spec; reachability test stays as the mounting oracle even with the document emitted from specs.                                                 |
| S5, A7 — Wave 3 is not mechanical: `node:async_hooks`, `node:crypto`, `jose`, `Bun.password`, `Buffer`       | **Accepted then as `runtime:bun`; superseded by §9.** Dany asked for injection instead; the ports are §3.4 and are built in Wave 2, so Wave 3 is a move again.                     |
| S7, A8 — saved-plan repositories are not ordinary Source members                                             | **Accepted.** D12.                                                                                                                                                                 |
| S12, A11 — blanket `unknown_reference` misreports other FK failures                                          | **Accepted, confirmed by Dany.** D6.                                                                                                                                               |
| S11, A4 — the kit admission rule was backwards                                                               | **Accepted, rule deleted.** Admission by observable behaviour; every case watched against `brokenSource`.                                                                          |
| S9, A14 — gw-01's "HTTP half" does not exist; app→app imports are forbidden                                  | **Accepted.** D5: gw-01 out.                                                                                                                                                       |
| S10, A10 — "any trigger" needs use-case entrypoints; saved-plan authorization lives in the controller        | **Accepted.** `use-cases/`, `savePlan`, one `composeServices`, the Wave 3.4 proof.                                                                                                 |
| S13, A13 — `no-restricted-imports` cannot ban globals; existing guards aimed at old paths                    | **Accepted.** §2 rules, two relocations, §3.5 negatives.                                                                                                                           |
| S8, A15 — sequencing: four open changes collide                                                              | **Accepted as Wave 0.** Order kept; the gate runs before every change and matters more now that Wave 1 touches the wire.                                                           |
| S14, A16 — inventory wrong                                                                                   | **Accepted, §0 corrected.**                                                                                                                                                        |
| S15 (second half) — an exported HTTP kit with one adapter is an unvalidated abstraction                      | **Accepted.** HTTP tests are adapter-local (D4).                                                                                                                                   |
| A12 — source lifecycle, no generic migration port                                                            | **Accepted.** On the `Source` port.                                                                                                                                                |
| S8 — build package shells and enforcement **before** the seams                                               | **Declined.** An empty shell has nothing to lint; the rules bite when files move. Wave 0 covers the ordering concern.                                                              |
| S11 — "a successful kit certifies only the named behaviours"                                                 | **Accepted as a sentence in the kit's JSDoc.**                                                                                                                                     |
| — the plan's "no behaviour change visible to fe-01" non-goal                                                 | **Deleted by §9.**                                                                                                                                                                 |

## 9 · Second revision (2026-09-05, evening): compatibility lifted, everything injected

Dany, after reading the review disposition: backward compatibility is **not** a constraint —
be-01 and fe-01 may both change to serve modularity — and every runtime dependency of core
should arrive by injection. What that changed, in the order it was discussed:

1. **Compatibility off.** D3 returns to ArkType in Wave 1 and goes further: unknown keys
   rejected everywhere, one `Refusal` envelope, the document emitted from specs, the two
   hand-parsed routes gone. The non-goal "no behaviour visible to fe-01 changes" is deleted.
   Two review-driven deferrals (ArkType to Wave 4, `runtime:bun`) are superseded; Wave 4 no
   longer exists. D5 (gw-01 out), D6, D11, D12, the request policies, the cookie multimap and
   additive-only migrations are **unchanged**, because none of them was about compatibility.
2. **D13, the endpoint table as the shared contract.** fe-01 has four hand-written API modules
   and ~15 error-code branches with zero `@wbs/contracts` imports; a client derived from the
   same table be-01 mounts turns a renamed field into a typecheck failure.
3. **D10 isomorphic, by injection.** Dany asked why core could not put Node and library
   dependencies behind ports; it can, and §3.4 is the table. The one real design point is
   `AsyncLocalStorage`, which is ambient context rather than a wrapper. Two options were laid
   out — an `AsyncContext` port with a single-slot browser adapter, or removing the ambience by
   passing the batch `Scope` everywhere as ADR 0012 did for stamps — and **Dany chose the
   port** (D15). §3.4 explains why the single slot is correct in a browser and only because of
   D11, and kit cases (f) and (g) prove it.
4. **What core still imports, and why those are not injected.** `jose` leaves behind
   `TokenCodec`. `@wbs/validation` is reached only through the `StandardSchemaV1` type, so the
   library is swappable everywhere except the ~35 declarations themselves. `@wbs/contracts` is
   types. `@wbs/domain` is core's own vocabulary — injecting it would be injecting the subject
   matter — **except the schedule engine**, which already has two implementations (TypeScript
   and the Python solver) behind a stored per-project choice, and therefore becomes the
   `Scheduler` port with a conformance kit of its own.
5. **Should domain and contracts live inside core?** Conceptually they are its innermost ring.
   Physically they stay separate Nx projects (D14), because fe-01 and gw-01 import them and a
   boundary the linter can see is per project; a `@wbs/core/domain` subpath is a convention
   the linter cannot see. Rings are enforced by the `@nx/enforce-module-boundaries` rule
   already at `eslint.config.js:17`, with three `depConstraints` rows and a fourth for the
   browser; §3.5 has the negatives. The word comes from Clean Architecture's Dependency Rule
   (Martin 2012) and Onion Architecture (Palermo 2008); Hexagonal (Cockburn 2005) is where
   "port" and "adapter" come from. `ring` rather than `layer` because "layer" already means a
   folder inside one project here, and the tag is a different axis.
6. **What lives in domain** (6,465 lines, 31 modules, no I/O): vocabulary and arithmetic
   (`workday`, `estimate`, `progress`, `capacity`, `priority-band`, `priority-weight`,
   `dependency-reach`, `external-system`, `contract-version`); tree rules (`place-sibling`,
   the four `effective-*`, `label-mismatch`, `leaf-constraints`, `not-before`, `is-within`,
   `assumed-duration`); derivation (`derive-numbers`, `slice-edges`, `slice-groups`); the
   schedule engine (`schedule` at 2,588 lines plus six satellites); and `saved-plan/`. Two
   impurities found while listing: `canonical-schedule-input.ts` imports `node:crypto`
   (→ the hash function moves to its one caller in `store-sqlite`, §3.4; a domain module cannot
   take a core port), and `estimate.ts` imports `@wbs/validation` (legal; puts
   `@wbs/validation` in `ring:domain`).
7. **Four more asks, added after "lgtm".** Universal ArkType is already true everywhere except
   Elysia's `t`, which Wave 1 deletes; the gap was fe-01's thirteen unvalidated response casts,
   now closed by the derived client validating against the spec's `R` type (D16). Running
   entirely in the browser is possible by construction — in-process transport, in-tab
   broadcaster, a third source the kit certifies, the TS engine as the only scheduler — and is
   named but not built (D17). Hosting other products is a namespacing change after Wave 3 with
   directory, project name and `product:` tag, aliases unchanged (D18). Ring terminology goes
   into the **directory**, not the name, with a layout test binding directory to tag; the
   proposed `wbs-adapter-01-fe-01` and `wbs-domain-contracts` were declined because a ring is
   an attribute, a name is an identity (D19).

## 10 · Third revision (2026-09-06): the plan's own contradictions

A review of the v3.1 branch against the code, before any OpenSpec change existed. Five design
holes, each of which would have surfaced as a failing lint or a hung test in the wave it
belongs to, and a set of sentences the OpenSpec changes would have copied in wrong. Every
finding was checked against a file; the decisions are D20–D23 and the amendments to D11–D15,
D17 and D18.

| Finding                                                                                                                                                                                                                                                                                                                                     | Resolution                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D11 deadlocks itself.** Every store method enters the coordinator; `run` holds it; the runner calls services built once over the same stores (`plan-commands.ts:149–170`). The "owner token" the risk table promised had no channel from `run` to the store method, and an ambient one would have made D15's single slot admit outsiders. | **D20.** Ownership travels through `scope`; `servicesOver(scope.stores, shared)`; `Gate` and `OPEN`; no re-entrancy. Three options were weighed — ambient token, `scope`, `Scope` as a parameter on ~80 methods — and Dany chose `scope`. Kit cases (h), (i). |
| **fe-01 cannot import the endpoint table.** `EndpointSpec` carried `handle`, which closes over services; fe-01 is `ring:adapter + runtime:browser → ring:domain`, and app→app imports are forbidden. D13 as written was unreachable.                                                                                                        | **D21.** `EndpointShape` in contracts, `Endpoint = shape + handle` in core, a binding test, `documentFromShapes` and mcp-01 reading contracts alone.                                                                                                          |
| **The ring taxonomy was not total.** Six projects had no ring; the first Wave 3 lint would have failed on fe-01 → `libs/realtime` and core → `@wbs/observability`. The browser adapters had no project, and the Wave 3.4 proof test imported `store-memory` from inside core, which is §3.5 negative 5.                                     | D14 amended: every project has one ring; `libs/runtime-web`; the proof moves there; the totality test; negatives 12–13.                                                                                                                                       |
| **A core port cannot serve the domain ring.** Wave 2.6 had `Digest` replacing `node:crypto` in `libs/domain`. `scheduleInputHash` is synchronous with one caller in the SQLite cache.                                                                                                                                                       | The hash moves to its caller; `canonicalScheduleInput` stays pure; the `tsScheduler` wrapper lives in the adapter ring. §3.4, §9.6.                                                                                                                           |
| **D17 contradicted the kit.** A browser source has no accounts, yet `Stores` was one record and `sourceConformance` one function. "Scheduler falls back to the TS engine" was silent degradation.                                                                                                                                           | **D22** kits per port, `Stores` a composition, `composeServices` typed for an absent `AccountStores`. **D23** `engine_unavailable`, refused, never substituted. Dany: fix 5a; 5b refuse.                                                                      |
| **Stale text from v3 → v3.1.** §2 and Wave 3.2 still offered nesting under `libs/core/`; D8 said three changes where §4 had four; Wave 3.3 said eight negatives where §3.5 had eleven; `clientFromSpecs(table, fetch)` and `(table, transport)` both appeared; D12 did not say whether saved plans take a turn.                             | All corrected in place. D12: no turn, own connection, case (j).                                                                                                                                                                                               |
| **D18's claim was false.** "Only `ci.yml` hard-codes an app path outside the apps" — eighteen files do.                                                                                                                                                                                                                                     | The list is the namespacing change's first task, §4. ADR 0014's "the CLIs do not move" is scoped to the three waves.                                                                                                                                          |
| **Glossary drift.** CONTEXT "Endpoint" said ArkType where the plan's point is Standard Schema; "Ring" omitted mcp-01; the Architecture section named files, which the glossary rule forbids.                                                                                                                                                | CONTEXT rewritten: terms only, `Gate` and `Scope` added, `Endpoint shape` added, paths removed.                                                                                                                                                               |

**Shapes adopted from the same review, because compatibility is lifted and Wave 1 is not
started:** `ParamsOf<Path>` so a path and its params cannot disagree; `HttpReply` as a
discriminated union so a 200 cannot carry a refusal; `PrincipalOf<Policies>` so a handler on an
open route cannot read a principal; `Refusal` as a union over `RefusalCode` with typed detail
and no batch-only fields in the envelope; `composeServices` grouped as `{ source, runtime,
shared }`; the ports barrel split at the move; `test:unit` by target. Each is a line in §3.1 or
§3.3 with its negative beside it.

**Two conversations worth keeping, because they are why the port is believed to be more than
SQLite renamed.** A Postgres source has no interleaving problem — a transaction belongs to the
borrowed connection — but it has the mirror-image bug: a service built over the pool, called
inside a transaction, writes **outside** it and survives the rollback. `scope.stores =
buildStores(tx)` is the same line that fixes both, and the coordinator becomes a per-project
advisory lock so two batches on one project still take turns while different projects run in
parallel. A file source has no transactions at all; terminal atomicity is stage, act, one
atomic rename, which is the memory source with a persist hook. Neither is built. Both are in
§3.2 so the next reader does not have to rediscover why `Gate`, `Scope` and `run` are three
things and not one.

**Not adopted:** a connection pool for SQLite. `bun:sqlite` is synchronous, so a second writer
connection would sleep the whole thread in SQLite's busy handler while the first finishes,
stalling every read; the async queue is the writer lane of a pool without the stall. A reader
pool pays only with worker threads and is the SQLite adapter's private option later.
