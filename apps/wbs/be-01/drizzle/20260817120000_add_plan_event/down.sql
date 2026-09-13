-- Reverses 20260817120000_add_plan_event.
--
-- Dropping this loses the plan's history and the loss is total: every estimate
-- change, rename, move and deletion anybody recorded while the release was up,
-- and it cannot be recomputed from anything. `command_journal` holds at most the
-- last fifty commands per account with the redo branch already deleted, so it is
-- not a source to rebuild from; nothing else records what a command replaced.
--
-- **No date moves, either way.** The scheduler reads work items, estimates,
-- dependencies, capacity and the calendar; it does not read this table, and
-- nothing writes to those tables on its behalf. A plan scheduled against a
-- database with this table and the same plan after this rollback come out
-- identical — asserted by replaying the identity corpus in
-- `service/live-plan-identity.test.ts` rather than claimed here.
--
-- Undo and redo are unaffected: they read `command_journal`, which this rollback
-- does not touch. A user mid-session loses no key.
--
-- The two indexes go with the table they are on. All three statements run solely
-- when the release that added them is being taken away — a forward migration in
-- this repo is additive so blue and green can share one file mid-swap, and
-- reversing an additive change is destructive by definition, which is why it
-- lives here and not there.
DROP INDEX IF EXISTS `plan_event_item`;--> statement-breakpoint
DROP INDEX IF EXISTS `plan_event_project_time`;--> statement-breakpoint
DROP TABLE IF EXISTS `plan_event`;
