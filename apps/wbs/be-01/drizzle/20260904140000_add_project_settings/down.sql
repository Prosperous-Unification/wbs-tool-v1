-- Reverses `20260904140000_add_project_settings`.
--
-- Dropping the three columns loses every project's optimizer settings and no
-- plan data: a project whose engine choice is gone reads as Fast, which is what
-- the forward migration defaults every existing row to anyway. Nothing else
-- references them.
--
-- Each column is named rather than counted, and `optimization_delete_pending_at`
-- is **not** among them — it belongs to `20260904100000_add_optimizer_tables`
-- and its own `down.sql` removes it (tasks.md 3b.7, 3.1b).
--
-- SQLite has supported `ALTER TABLE … DROP COLUMN` since 3.35. A dropped column
-- takes its column-level `CHECK` with it, so no constraint is left pointing at
-- a name the table no longer has.
ALTER TABLE `project` DROP COLUMN `schedule_objective`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `schedule_engine`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `optimization_enabled`;
