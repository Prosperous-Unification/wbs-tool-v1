# A command batch is an outer transaction over the stores' own

be-01's stores are `async` and each opens its own SQLite transaction, so a batch of commands
that must apply all-or-none had two ways to become atomic: rewrite every store to take a
transaction handle (a unit of work, ~80 methods, and every service method grown a synchronous
twin because `bun:sqlite` transactions are synchronous), or open one `BEGIN IMMEDIATE` on the
connection around the existing async service methods and let their transactions nest. We chose
the second: `bun:sqlite` turns a transaction opened inside another into a savepoint, an inner
failure rolls back only its savepoint, and the outer `ROLLBACK` takes every step with it —
measured on 2026-08-29 against `bun:sqlite` 1.3.14 with drizzle's `db.transaction`, not read off
the docs. The price is a process-wide **write lock**: the one connection is shared and the
service awaits between steps, so another request's write landing mid-batch would sit inside
the batch's transaction and be rolled back with it. Every be-01 write waits behind the lock while
a batch is open; reads do not. This is fine for a single-host tool with one writer at a time and
would be the first thing to revisit if be-01 ever ran more than one connection.

**Considered**: unit-of-work refactor (rejected for size and for forcing every service method
synchronous); a generic HTTP batch replaying single routes (rejected: no atomicity, no single
undo, refs impossible).
