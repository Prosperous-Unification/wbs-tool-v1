-- Reverses 20260807180000_add_command_journal.
--
-- Dropping this loses every recorded command and therefore every undo and redo
-- anybody still had available. Nothing about the plan itself goes — the rows,
-- estimates, dependencies, dates and assignees are all untouched, because a
-- journal entry describes a change that has already been applied and never
-- holds the only copy of anything on screen. What is lost is the ability to
-- reverse those changes, and it cannot be recomputed: nothing else records
-- what a command replaced.
--
-- The index goes with the table it is on. Both run solely when the release
-- that added them is being taken away.
DROP INDEX IF EXISTS `command_journal_stack`;--> statement-breakpoint
DROP TABLE IF EXISTS `command_journal`;
