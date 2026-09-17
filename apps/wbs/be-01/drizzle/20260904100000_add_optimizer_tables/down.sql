-- Reverses `20260904100000_add_optimizer_tables`.
--
-- Dropping the four tables loses every cached schedule, every reserved slot and
-- every queued entry, which costs re-solving and no plan data: each row is
-- derived from an input hash that still exists, and a project whose cache is
-- empty reads as Fast rather than as broken.
--
-- The `project` column goes last, because three of the four tables reference
-- that table and the fence is read by the drain that empties them. SQLite has
-- supported `ALTER TABLE … DROP COLUMN` since 3.35 and the column carries no
-- index or constraint, so this is the plain statement rather than a table
-- rebuild.
DROP INDEX `solver_queue_dequeue_order`;--> statement-breakpoint
DROP TABLE `solver_queue`;--> statement-breakpoint
DROP TABLE `solver_slot`;--> statement-breakpoint
DROP TABLE `optimization_generation`;--> statement-breakpoint
DROP TABLE `optimized_schedule_cache`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `optimization_delete_pending_at`;
