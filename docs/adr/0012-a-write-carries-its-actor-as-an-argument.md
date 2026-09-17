# A write carries its actor as an argument, not as ambient context

Every record has to say who made it and when (`openspec/changes/audit-columns`),
and the repository layer knew neither: the acting user stops at the service layer
as `actorId`, and the clock is injected per service, never into a repository. So
87 audit columns needed one of two things — a **write stamp** passed to every
mutating store method, or ambient per-request context the repositories could read
without changing a signature.

We pass it. `WriteStamp { at, by }` is built once per act where `actorId` and
`this.now()` already meet, and every mutating store method takes it.

## Considered options

**`AsyncLocalStorage`.** One `als.run({ at, by }, …)` per request in the Elysia
layer, repositories reading the store, **no signature changes at all** — five
files against sixty. Rejected because it moves the guarantee from compile time to
runtime. A stamp that arrives as a parameter is found by `tsc` at every one of
the 67 write sites and 19 in-memory fixtures, and `nx typecheck` runs
`tsc --build --force` against the source project, so a missed site fails the
gate. With ambient context a missed `als.run` is a runtime throw reachable only
by a test that happens to write — and most of this suite exercises the
fixtures, not the real repositories, so the coverage that would catch it is
exactly the coverage that does not exist. That is R5's "check that cannot fail"
with a different mechanism.

**A SQLite trigger per table.** `updated_at` maintained by the database, so no
writer can forget it, and raw SQL is covered too. Rejected on two counts: the
value would come from SQLite's own clock rather than the service's injected
`now()`, which makes it untestable against a fake clock and breaks the rule that
one act carries one instant; and `20260831120000_rename_role_to_step` already
records this repo's disposition against triggers-as-machinery ("six views and
eighteen triggers alive for one release — that is the change this one refuses to
become"). It would also be 31 triggers and 31 drops in `down.sql`.

**Drizzle's `$onUpdate`.** One declarative line per column, beside the column.
Rejected for the clock, same as triggers: `$onUpdate(() => Date.now())` reaches
past the injected `now()`, and there is no `$onUpdate`, `$defaultFn` or
`$default(` anywhere in the repo today to follow.

**Derive attribution from the existing event log.** `command_journal` and
`plan_event` already record `userId` and `created_at` for every act routed
through the command path, so "who created this work item" is already answerable
by query. Rejected because it answers for plan data only: a tag, a work item
type, a service, an external system, a team and a person are created **outside**
the command path and appear in neither table — which is precisely the case Dany
asked for by name. A design that answers for 22 tables and silently not for the
other 9 is worse than no design, because the gap is invisible at the call site.

## Consequences

A new mutating store method cannot be written without naming its actor — the
compiler refuses. It **can** still be written without _using_ the stamp, so the
columns are filled by helpers (`auditOnCreate`, `auditOnUpdate`) and
`audit.test.ts` reads the folder's own source to require them; that test, not the
parameter, is what makes the fill non-forgettable, and it carries its own watched
negative. It is a test rather than an ESLint rule because the selector needed
fired on unrelated `.set(key, { … })` calls in the same folder — the change's
`design.md` has the detail.

The audit columns are nullable forever. Additive-only forward migrations forbid
`NOT NULL` without a default on a populated table, and a default would record an
author who did not write the row — R5's "never convert an unknown into a
default". A row from before the migration has no author, and its type says so.

The stamp is still an **argument** at every store call, and it is built by one
collaborator rather than by each service. Seven services held an identical
`private stampFor(actorId)` over an injected `now()`; since 2026-09-02 there is
one `Clock` in `libs/wbs/application/core/src/ports/clock.ts`, built once in
`apps/wbs/be-01/src/services.ts`
and handed to all seven. This does not weaken anything above: the compiler still
refuses a store method whose actor is unnamed, the value still comes from an
injected clock rather than from SQLite or from drizzle, and "one act, one
instant" is now one implementation instead of seven promises about seven
objects. What changed is only where the sentence lives.
