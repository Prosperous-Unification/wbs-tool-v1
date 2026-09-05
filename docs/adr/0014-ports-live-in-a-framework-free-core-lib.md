---
status: proposed
---

# Ports live in a framework-free core lib; adapters live outside it

be-01's store ports, services, use cases and HTTP endpoints move into `libs/core`, which may
import `@wbs/domain`, `@wbs/contracts`, `@wbs/validation` and the `StandardSchemaV1` type, and
**nothing with a runtime**: no `elysia`, `drizzle-orm`, `bun:sqlite`, `jose` or `node:*`, and
no `Bun`/`process`/`fetch`/timer/`Buffer` globals. Every runtime concern — password hashing,
token signing, digests, timers, push transport, the schedule engine —
arrives through `composeServices({ source, runtime, shared })`, so core is
**`runtime:isomorphic`**. Dependency direction is stated as **rings** on Nx projects, and
**every project carries exactly one**: `ring:domain` (`domain`, `contracts`, `validation` —
types and pure functions every ring may read), `ring:application` (`core`, and `conformance`
for the kits), `ring:adapter` (`store-*`, `runtime-web`, `auth`, `realtime`, `solver-py`,
`observability`, `config`, `be-01`, `fe-01`, `gw-01`, `mcp-01`, and every `tools/*` project) —
enforced by the `@nx/enforce-module-boundaries` rule already in
the gate, plus `no-restricted-imports` / `no-restricted-globals` for what Nx cannot see, plus
a totality test, because a project without a ring is a constraint that never fires. **Test
files are outside the ring constraints** and the import bans (the runtime constraints still
bind them): the one hole, so that core's tests can compose core over the in-memory source
without the source being a core dependency. The
SQLite adapters live in `libs/store-sqlite`, the in-memory source in `libs/store-memory`, the
browser adapters for the runtime ports in `libs/runtime-web`, and `apps/be-01` keeps only the
Elysia adapter, the composition root with the Bun runtime adapters, and the migrate CLIs.
The HTTP contract is split along the same line: an endpoint's **shape** — method, path,
operation id, policies, validators with generated document schemas, modeled reply statuses —
lives in `@wbs/contracts` so fe-01, mcp-01 and the OpenAPI emitter read it from the domain
ring, and core binds a handler to each shape; the
table with handlers cannot cross the ring boundary, the shapes can (plan D21). We chose
packages over folder conventions because the folder convention
had already held for a year and still let seven values leak from repositories into services
with nothing to say so: a rule enforced by a linter across a package boundary fails on the
import, a rule stated in a comment fails in review or not at all.
Plan: `docs/2026-09-05-ports-and-adapters-plan.md`.

The 2026-09-06 review corrects two parts of that seam before implementation. `SchemaShape`
pairs a Standard Schema validator with a JSON Schema descriptor generated from the same
ArkType declaration: Standard Schema cannot provide the document emitter's metadata by itself
(plan D25). Replies pair status with schema, including modeled 429/503 refusals; unexpected
account-store faults still throw (D26). Announcement ownership is explicit in each batch's
service graph, so core needs no ambient-context runtime port (D24; ADR 0015).

The same day's review of the plan against the workspace corrected three more. The
conformance kits are `bun:test` suites, which core's own import ban keeps out of core, so they
live in `libs/conformance` (`ring:application`, `runtime:bun`). `libs/observability` imports
Elysia, pino and OpenTelemetry and `libs/config` spawns `sops`, so both are `ring:adapter`,
and the one thing core wanted from them — the `Logger` type with its no-op — moves to
`@wbs/contracts`. And the `EventLogStore` is a transactional store on `Scope`, not history
(ADR 0015).

`libs/domain` and `libs/contracts` are conceptually core's innermost ring and stay **separate
Nx projects**: fe-01 imports one from 11 files and gw-01 the other from 4, and a boundary the
linter can see is per project — `@wbs/core/domain` as a subpath would be a convention it
cannot check. Their directories are grouped **by ring** — `libs/wbs/{domain,application,adapters}/` — with
short project names and unchanged aliases; the ring never enters a name, because a ring is an
attribute and a name is an identity, and a test binds directory to tag (plan D18, D19).

"Ring" is Clean Architecture's word (Martin 2012, the Dependency Rule) and Onion Architecture's
(Palermo 2008); "port" and "adapter" are Hexagonal Architecture's (Cockburn 2005). Not "layer",
which already means a folder inside one project in this repo.

## Considered options

**Folders inside `apps/be-01/src` with ESLint path rules.** Least churn. Rejected because
nothing outside be-01 can then compose the services — a CLI, a worker, gw-01 — which is
half of what the split is for, and because folder-scoped lint rules are the kind of check
that is scoped to where the fault is not (`svg-export-and-gutter`, 2026-08-31).

**Two packages, core + be-01, drizzle staying beside Elysia.** Rejected: the SQLite source
would not be swappable as a unit, and the in-memory source would stay a test fixture rather
than a peer implementation the conformance kit holds to the same contract.

**Core as `runtime:bun`, keeping `node:crypto`, `node:async_hooks` and `jose` as imports.**
The first review's recommendation and this ADR's own second draft. Rejected by Dany the same
day in favor of an isomorphic core. Runtime wrappers are injected; the later proposal to
replace `AsyncLocalStorage` with a single browser slot was itself rejected after the review
reproduced an outside publication entering a following batch's queue. A collector bound to
one batch's service graph removes the need for that runtime dependency (D24).

**One `@wbs/core` project holding domain and contracts as subpaths.** Rejected because Nx
boundaries are per project: fe-01 depending on core for `@wbs/core/domain` would be free to
import `WorkItemService`, and nothing would fail.

## Consequences

`services.ts` becomes `composeServices({ source, runtime, shared })` in core — one graph,
saved plans and the command runner included — with use-case entrypoints (`runCommandBatch`,
`savePlan`, `replay`, `retentionSweep`) that carry the authorization and announcements the
controllers hold today, so a worker cannot bypass them. be-01's `boot.ts` is one caller; the
"any trigger, any runtime" test, `libs/core/src/compose.test.ts`, is another — it composes core
over `@wbs/store-memory` from inside core, which the test-file exemption above permits and
which keeps the proof next to the code it proves. A domain module cannot take a core port — the rings point
inward — so the one `node:crypto` use in `libs/domain` moves to its single caller in the SQLite
adapter rather than behind `Digest`. gw-01 is **out**: Nx forbids app→app imports, so a be-01
adapter cannot serve it, and its WebSocket upgrade is not an endpoint; a shared
`libs/http-elysia` is a later decision. The migration SQL folder and the `migrate-*-cli.ts`
entrypoints do **not** move in the three waves: the blue/green swap invokes them by path. They
move with be-01 in the namespacing change, which is also where the eighteen files outside
`apps/` that name an app path are rewritten (plan §4).
