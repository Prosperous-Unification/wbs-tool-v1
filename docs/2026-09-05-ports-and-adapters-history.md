# Ports-and-adapters plan — revision history (2026-09-05 → 2026-09-06)

**Not normative.** Every decision in here is either in the plan's D-table and §2–§7
([`2026-09-05-ports-and-adapters-plan.md`](2026-09-05-ports-and-adapters-plan.md)) or was
superseded there. This file exists so a future reader can see _why_ a decision has the shape it
has; an OpenSpec change must never copy a sentence from this file. Where a paragraph below
disagrees with the plan, the plan is right. The plan's own §10 records an agent copying stale
text from an earlier revision into a later one, which is why the history and the normative text
are now two files.

Section numbers are kept as they were in the plan so that ADR 0014/0015 and the refactoring
plan's cross-references still resolve.

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

Historical rationale: §11 supersedes this revision's choice of a single-slot `AsyncContext`
and its claim that Standard Schema alone supplies document metadata. The current contracts
are in §3.1–§3.4 and D24–D28.

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
   port** (D15 at that revision). The later review found the write-before-next-batch window
   those cases missed; D24 supersedes this choice and case (l) tests that window.
4. **What core still imports, and why those are not injected.** `jose` leaves behind
   `TokenCodec`. At this revision the plan exposed validation only through `StandardSchemaV1`;
   D25 later added generated document descriptors and the conversion boundary. `@wbs/contracts` is
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

Historical disposition: D24–D28 in §11 correct the remaining publication window, rollback
repair, document-emission capability and independent-state boundary. In particular, the
then-current claim that SQLite reuses the batch service graph is replaced by reuse of store
adapters only; the graph now binds a fresh collector for each batch.

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

## 11 · Repository review incorporated — 2026-09-06

The user asked to add the repository-wide review's fixes to the plans. These are corrections
to the proposed design, not completed runtime changes. The review covered documentation
branch `6dec1ec1` over `main` `2c839252`; its eleven implementation findings are owned by
the [refactoring plan §67](2026-09-02-refactoring-plan.md#67--review-follow-up--2026-09-06).
Review D1–D5 below are finding IDs, not this plan's decision IDs. D24–D28 and the normative
seams/waves above incorporate all five; ADR 0014/0015 remain `proposed` until implementation.

| Review finding                                                             | Decision and implementation location                                                                                                                             | Required negative                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1: post-rollback journal repair reacquires its held coordinator           | **D28**, §3.2, Wave 2.2, ADR 0015. Pass a new admitted live scope to `afterRollback`; keep repair outside the transaction catch.                                 | Case (k): inject ordinary gated repair (deadlock), discarded memory scope (discard vanishes), or a repair throw (preserve that error, no second rollback, later writes proceed).                                |
| D2: an already-committed route publishes into the next batch's shared slot | **D24 supersedes D15**, §3.2/§3.4, Wave 2.2, ADR 0014/0015. Bind a fresh collector to each batch's service graph; ordinary services hold the direct broadcaster. | Case (l): outside write commits before the next hold, its publication resumes during the hold, and the batch refuses; the outside event still leaves once. Include a preceding batch's post-commit events.      |
| D3: Standard Schema cannot emit the promised documents alone               | **D25**, §3.1/§3.4, Wave 1.1/1.3, ADR 0014. Carry a generated JSON Schema descriptor beside each validator.                                                      | Drop a nested command-union arm/property or emit `{}` for unsupported conversion; document/MCP and refusal fixtures must fail. Never maintain two handwritten schema truths.                                    |
| D4: the reply union excludes modeled 429/503 responses                     | **D26**, §3.1, Wave 1.1/1.5, ADR 0014. Derive status/body variants together and validate refusal responses too.                                                  | Throttled login, busy capture and failed health dependencies must keep their declared statuses; malformed refusal bodies fail client validation. Repository exceptions remain unexpected failures.              |
| D5: committing a memory clone can overwrite an independent saved plan      | **D27**, §3.2, Wave 2.3, ADR 0015. History lives outside transactional state and Scope. This was a conditional design risk; the source is not implemented.       | Case (j): put history into the cloned/swapped tables, save independently during a suspended batch, then commit; the lost successful save must fail the case. Also retain rollback and bounded contention cases. |

Two mechanisms were reproduced with today's production `WriteLock`, not an implemented new
source: nested public-store admission stayed blocked; an async route write followed by the
next batch captured and dropped the route event under a single shared slot. The Standard
Schema capability was checked against its [complete interface](https://standardschema.dev/schema).
429/503 paths were read in the current controllers. The memory case remains an inference
about the old whole-state sketch and is now an explicit exclusion in the design.

The kit must be measured through real composition and in the relevant window. Counting the
number of evictions does not bound key enumeration (refactoring R8); reading after every
request settles cannot see an invalidation lost during a held response (R1); reserving login
capacity after verification cannot constrain pending work (R5). The moved code carries those
production-path negatives with it, and each wave's `verify.md` records the observed failures
before any `Proof:` is written. This update changes documents only and does not certify the
future adapters, their throughput, or the browser's rendering latency.

## 12 · Fourth revision (2026-09-06, late): a review of the plan against the workspace

Findings that were contradictions inside the plan or between the plan and the code as it is,
each fixed in the normative text:

| Finding                                                                                                                                                                                                                                                                               | Resolution                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core's tests had nowhere legal to live.** 39 of 57 `service/*.test.ts` files import the in-memory fixtures; after Wave 3 those are `@wbs/store-memory`, and §3.5 #13 made a core test importing it a lint failure. The plan relocated one proof test and said nothing about the 39. | Test files are exempt from the ring constraints (not from the runtime ones). #13 is now about a core **production** file; the "any trigger, any runtime" proof lives in core's own tests. §2, §3.3, §3.5.                                   |
| **Kits could not live in `libs/core`.** A kit is a `describe/it/expect` suite, so it imports `bun:test`, which core's `no-restricted-imports` bans.                                                                                                                                   | `libs/conformance` (`@wbs/conformance`, `ring:application`, `runtime:bun`) holds every kit and `brokenSource`. Written under `apps/be-01/src/testing/kits/` in Wave 2, moved in Wave 3. §2, Wave 2.5, Wave 3.2.                             |
| **Two "ring:domain, isomorphic, no runtime" libs were neither.** `libs/observability` imports `elysia`, `pino` and OpenTelemetry and serves `/metrics` as an Elysia plugin; `libs/config` spawns `sops` and reads `process.env` and is tagged `runtime:bun` today.                    | Both are `ring:adapter`, `runtime:bun`. The `Logger` type and the no-op logger move to `@wbs/contracts` so core imports no adapter. `/metrics` becomes a text-bodied endpoint shape in Wave 1.5, and `HttpReply` gets a text arm. §2, §3.1. |
| **The totality test contradicted CONTEXT.md.** It failed a project with zero tags on any axis including `product`; CONTEXT said tools belong to no product; eleven `tools/*` projects had no ring.                                                                                    | `ring` and `runtime` on every project including `tools/*` (which are `ring:adapter`); `product` on every project under `apps/` and `libs/`, none under `tools/`. §2.                                                                        |
| **`EventLogStore` was in two places.** Wave 2.3 grouped it with the independent history ports; Q4 and `recordEventIn(tx)` need it inside `scope.stores`.                                                                                                                              | It is a transactional store. §3.2, Wave 2.3, ADR 0015.                                                                                                                                                                                      |
| **Client response validation with undeclared keys rejected would break open tabs across a blue/green swap.** The socket reconnects and the page does not reload, so an old fe-01 bundle would refuse any additive response.                                                           | Bodies reject undeclared keys; the client **ignores** undeclared keys in responses. §3.1, with its negative.                                                                                                                                |
| **The critical path was hidden.** Wave 1.4 needs R1 (refactoring §67); R1 needs W4-4 (4 days, not started). Wave 1's "~7 days" did not include either.                                                                                                                                | Wave 0 lists the chain and the total. §4.                                                                                                                                                                                                   |
| **Deep generic shapes over ArkType inference have an unmeasured `tsc` cost**, and the error messages are the kind agents misread.                                                                                                                                                     | A `tsc` wall-time pin in Wave 1.1's verify table, with the fallback named. §4, §6.                                                                                                                                                          |
| **§8–§11 kept superseded decisions inline** (D15, §9.3, "historical rationale"), which §10 itself records as having caused a copy-in error.                                                                                                                                           | Moved here. The plan is the D-table and §2–§7.                                                                                                                                                                                              |

Recommended and **not** applied, because each is a design choice for Dany rather than a
contradiction: renaming `runtime-web` (it hosts adapters be-01's `boot.ts` also uses); dropping
the two-implementations requirement for store ports until a second real source exists, which
would roughly halve the per-feature file fan-out the split adds (measured: the last eleven
feature commits on `main` touched 2–4 files each; after the split a wire-visible field touches
contracts, a core port, a core service, `store-sqlite`, `store-memory`, a kit case and fe-01).
