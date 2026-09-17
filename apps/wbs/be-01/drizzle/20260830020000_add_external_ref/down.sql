-- Reverses 20260830020000_add_external_ref.
--
-- Dropping these loses every link anybody recorded and the system vocabulary
-- they were typed against. The loss is total in one direction and harmless in
-- the other, and that asymmetry is why this rollback is safe to run.
--
-- **No date moves, either way.** The scheduler reads work items, estimates,
-- dependencies, capacity and the calendar. It does not read either of these
-- tables — a ref is a link and decides nothing — and nothing writes to the
-- tables it does read on their behalf.
--
-- **What comes back is the state the change was written to end**: the only place
-- to record where the work also lives is the name or the notes, where nothing
-- can find it and nothing can follow it. Worse here than for a label rollback,
-- because a URL somebody pasted into the ref list is not recoverable from
-- anywhere — a tag rollback loses a word a reader can retype, and this loses the
-- address of the thing.
--
-- The dot column degrades to blank on every row rather than breaking: the plan
-- payload carries no refs, and a cell with nothing to draw draws nothing, which
-- is already the rendered state for a row nobody has wired up.
--
-- Undo and redo are unaffected in shape and lossy in one arm, exactly as every
-- additive rollback here is: `command_journal` is untouched so every entry stays
-- pressable, but an entry whose command carries `externalRefs` names a table
-- that is no longer there and fails when applied.
--
-- The indexes go with the table they are on, and `work_item_external_ref` goes
-- first: its rows reference `external_system`, and dropping the referenced table
-- first would leave a foreign key pointing at nothing for the length of one
-- statement. The seeded rows go with their table and are not deleted separately
-- — a `DELETE FROM external_system` before the `DROP` would be two statements
-- doing one thing, and the second is the one that matters.
--
-- All five statements run solely when the release that added them is being taken
-- away. A forward migration here is additive so blue and green can share one
-- file mid-swap; reversing an additive change is destructive by definition,
-- which is why it lives here and not there.
DROP INDEX IF EXISTS `wier_by_system`;--> statement-breakpoint
DROP INDEX IF EXISTS `wier_by_work_item`;--> statement-breakpoint
DROP TABLE IF EXISTS `work_item_external_ref`;--> statement-breakpoint
DROP INDEX IF EXISTS `external_system_name`;--> statement-breakpoint
DROP TABLE IF EXISTS `external_system`;
