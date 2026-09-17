-- `calendar_marker` — a named annotation on an absolute calendar date, scoped
-- to one project.
--
-- `openspec/changes/gantt-calendar-markers/design.md` §5. The alternative the
-- product has today is a zero-duration work item, which enters the dependency
-- graph, the critical path, capacity and all three of Fast, PRI and Time. This
-- table exists so a demo date or an external deadline can be drawn on the Gantt
-- without the scheduler being able to see it; nothing under
-- `libs/domain/src/schedule.ts` reads it.
--
-- **`project_id` cascades**, for the reason `20260903190000_add_saved_plan`
-- gives and `plan_event` before it: blue and green share one SQLite file
-- through a swap, and the outgoing release — which knows nothing of this table
-- — issues a plain `DELETE FROM project`. Without the cascade that statement
-- hits a constraint it cannot see and answers 500 for the length of the swap.
-- The cascade is a deployment property, not tidiness, which is why
-- `calendar-marker-migration.db.test.ts` watches the clause's absence fail.
--
-- **The index is deliberately not unique.** A demo and a deadline can land on
-- one day, and design.md §5 carries the stacked render for it. `(project_id,
-- date)` is the shape of the only read this table has: this project's markers,
-- by date.
--
-- **`color` is nullable and NULL means automatic**, derived from `id` at read
-- time rather than materialised here. Materialising would freeze today's
-- palette into storage — a palette change would have to migrate rows, and a
-- marker whose colour was never chosen would be indistinguishable from one that
-- was.
--
-- Additive, like every forward migration in this repo, so blue and green can
-- share one file through a swap: the outgoing release neither selects from nor
-- inserts into a table it has never heard of.
--
-- **Stamped 20260905090000**, later than every folder on main — the newest is
-- `20260904020000_add_saved_plan_created_by_id`. Drizzle records the folder's
-- numeric prefix as the migration's `created_at` and `migrationsToRollback`
-- filters on a strict `created_at >`, so a colliding stamp silently reverses
-- nothing and reports success. `duplicateMigrationStamps` in `migrate-down.ts`
-- is the mechanical check; this stamp was chosen against it and
-- `calendar-marker-migration.db.test.ts` asserts it.
CREATE TABLE `calendar_marker` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_calendar_marker_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- One project's markers, by date — the only read. Not unique: see above.
CREATE INDEX `calendar_marker_project_date` ON `calendar_marker` (`project_id`,`date`);
