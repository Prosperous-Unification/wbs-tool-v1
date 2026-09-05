# be-01

The API, and the only thing that writes the database. Elysia + Drizzle +
`bun:sqlite`, port 3100.

## Where things are

- **`repository/`** — one class per table, and the only place SQL lives. Every
  mutating method takes a `WriteStamp` (ADR 0012).
- **`service/`** — the rules. `work-item.service.ts` is the big one;
  `plan-commands.ts` applies a batch as one transaction and one undo.
- **`controller/`** — route lists against `http/route.ts`, naming no framework.
  They resolve nothing themselves: the caller comes from `http/caller.ts`'s
  `callerGuard` and arrives non-null. `http/elysia/bind.ts` binds a list to
  Elysia and `http/in-process/bind.ts` binds the same list to nothing at all,
  which is what `http/binder.contract.test.ts` uses to prove the independence.
- **`services.ts`** — the composition. One broadcaster, one clock, one write
  lock, built once and shared, because "there is exactly one of these in the
  process" is a claim about this file rather than about the classes.

## Refusals

Every refusal a client can cause is **modeled**: a 4xx with be-01's own word for
it, never a 500. `controller/refusal-status.ts` maps the word to the status —
four shared arms and each route's own default. A malformed body is 400/422, a
restricted project is 403 (never 404: the caller may read it), a state of the
plan is 409.

## Landmines

- **`bun:sqlite` defaults to no WAL and `busy_timeout=0`.** Both are set **and
  asserted** at open in `repository/db.ts`, and an ESLint rule bans importing
  `bun:sqlite` anywhere else under `src/` — the pragmas are per connection, so a
  direct `new Database()` silently loses them.
- **A migration must be additive and must ship a `down.sql`.** Blue and green
  share one file mid-swap; the lint refuses the obvious destructive statements
  and the judgement is yours.
- **`ALTER TABLE … RENAME` rewrites other tables' `REFERENCES` only with
  `foreign_keys` on**, and that pragma is decided per pending migration
  (`pendingNeedingForeignKeysOff`), not per run.
- The audit columns are **recorded and not published**: every read that crosses
  the boundary names its columns (`WORK_ITEM_COLUMNS`, `STEP_COLUMNS`, …), and a
  bare `select()` typechecks while publishing `created_by`.

## Test

```sh
bunx nx run be-01:test:unit    # ~490 cases, no database, ~11s
bunx nx run be-01:test:store   # ~620 cases against real SQLite, ~45s
bunx nx run be-01:test         # both
```

The tiers are the `.db.test.ts` suffix, and `src/test-tiers.test.ts` is what
keeps a database-touching suite from landing in the fast one.
