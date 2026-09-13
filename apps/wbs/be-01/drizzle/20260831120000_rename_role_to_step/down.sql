-- Reverses 20260831120000_rename_role_to_step, statement for statement.
--
-- **This rollback is total, which almost no `down.sql` in this repo is.** The
-- forward migration creates nothing, drops nothing and defaults nothing: every
-- statement is a rename, so reversing it restores the exact schema it found and
-- every row it left alone. That is why `migrate-down.test.ts` compares the full
-- schema and every table's contents across the round trip rather than counting
-- rows — a missing rename here leaves a database that still reads every row
-- fine, so a count-only assertion could not see it (design D3).
--
-- Reversed in the opposite order to the forward file: the indexes come back
-- first, then the columns, then the tables. The column renames have to happen
-- while the tables still carry their new names, and `step_progress`'s and
-- `step_measure`'s columns have to be reversed before those tables are renamed
-- back — the same reason the forward file renames the tables before the columns
-- on them.
--
-- What running this means is that the release which asked for the domain's own
-- storage names is being taken away, and the release coming back reads `role`.
-- No statement anybody typed is lost either way.
DROP INDEX IF EXISTS `step_measure_by_step`;--> statement-breakpoint
CREATE INDEX `role_measure_by_role` ON `step_measure` (`step_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `step_progress_by_step`;--> statement-breakpoint
CREATE INDEX `role_progress_by_role` ON `step_progress` (`step_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `actual_by_step`;--> statement-breakpoint
CREATE INDEX `actual_by_role` ON `actual` (`step_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `step_project_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `role_project_name` ON `step` (`project_id`,`name`);--> statement-breakpoint
ALTER TABLE `step_measure` RENAME COLUMN `step_id` TO `role_id`;--> statement-breakpoint
ALTER TABLE `step_progress` RENAME COLUMN `step_id` TO `role_id`;--> statement-breakpoint
ALTER TABLE `plan_event` RENAME COLUMN `step_id` TO `role_id`;--> statement-breakpoint
ALTER TABLE `assignment` RENAME COLUMN `step_id` TO `role_id`;--> statement-breakpoint
ALTER TABLE `actual` RENAME COLUMN `step_id` TO `role_id`;--> statement-breakpoint
ALTER TABLE `estimate` RENAME COLUMN `step_id` TO `role_id`;--> statement-breakpoint
ALTER TABLE `step_measure` RENAME TO `role_measure`;--> statement-breakpoint
ALTER TABLE `step_progress` RENAME TO `role_progress`;--> statement-breakpoint
ALTER TABLE `step` RENAME TO `role`;
