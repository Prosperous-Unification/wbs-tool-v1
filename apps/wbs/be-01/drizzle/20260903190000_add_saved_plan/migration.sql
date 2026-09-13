-- Saved plans: one project's whole plan copied by value at one instant.
--
-- Additive, like every forward migration in this repo, so blue and green can
-- share one SQLite file through a swap. Two tables and one index; nothing
-- existing is altered, and no row anywhere is rewritten.
--
-- `openspec/changes/saved-plans/design.md`. The short version of why this is a
-- materialised document rather than a pointer: `plan_event` is a log of
-- commands and is pruned at 365 days, dates are derived and never stored, and
-- no whole-plan version counter exists — `project.revision` deliberately
-- excludes work items. There is nothing to point at.
--
-- **Stamped 20260903190000**, later than every folder on main
-- (`20260902120000_add_lookup_indexes`). Two migrations shared
-- `20260814100000` on 2026-08-14; drizzle's `created_at` is the folder's
-- numeric prefix and `migrationsToRollback` filters on a strict `created_at >`,
-- so a colliding stamp silently reverses nothing. `duplicateMigrationStamps` in
-- `migrate-down.ts` is the mechanical check; this stamp was chosen against it.
--
-- Both foreign keys cascade, and both are about the blue/green swap window
-- rather than tidiness — the argument `plan_event`, `dependency` and
-- `project_priority_band` all make: the outgoing release knows nothing of these
-- tables, and its plain `DELETE FROM project` must not hit a constraint it
-- cannot see and answer 500 for the length of the swap. `saved_plan_body`
-- cascades off `saved_plan` for the same reason, one hop along.
--
-- `created_by` carries **no** foreign key, deliberately, and that is not the
-- same choice as the cascade above. A saved plan is permanent, so an account
-- deletion must neither orphan it nor erase it; the creator is copied as a
-- value and stays readable after the account is gone. Same terms as the `keep`
-- decision for people, 2026-09-03.
CREATE TABLE `saved_plan` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`input_schema_version` integer NOT NULL,
	`input_bytes` integer NOT NULL,
	`input_sha256` text NOT NULL,
	`schedule_schema_version` integer,
	`schedule_bytes` integer,
	`schedule_sha256` text,
	`schedule_input_sha256` text,
	`scheduler_algorithm_id` text,
	`schedule_absent_reason` text,
	CONSTRAINT `saved_plan_schedule_all_or_nothing` CHECK ((
		(`schedule_schema_version` IS NULL AND `schedule_bytes` IS NULL
			AND `schedule_sha256` IS NULL AND `schedule_input_sha256` IS NULL
			AND `scheduler_algorithm_id` IS NULL AND `schedule_absent_reason` IS NOT NULL)
		OR
		(`schedule_schema_version` IS NOT NULL AND `schedule_bytes` IS NOT NULL
			AND `schedule_sha256` IS NOT NULL AND `schedule_input_sha256` IS NOT NULL
			AND `scheduler_algorithm_id` IS NOT NULL AND `schedule_absent_reason` IS NULL)
	)),
	CONSTRAINT `fk_saved_plan_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- One project's saved plans, newest first — the only order they are read in.
CREATE INDEX `saved_plan_project_time` ON `saved_plan` (`project_id`,`created_at`);
--> statement-breakpoint
-- The bytes, one row per side. An absent schedule is an absent row rather than
-- a sentinel inside a blob, which is what makes "no schedule was saved" a state
-- the header's `schedule_absent_reason` can explain.
CREATE TABLE `saved_plan_body` (
	`saved_plan_id` text NOT NULL,
	`kind` text NOT NULL,
	`bytes` text NOT NULL,
	PRIMARY KEY (`saved_plan_id`, `kind`),
	CONSTRAINT `saved_plan_body_kind` CHECK (`kind` IN ('input', 'schedule')),
	CONSTRAINT `fk_saved_plan_body_saved_plan_id_saved_plan_id_fk` FOREIGN KEY (`saved_plan_id`) REFERENCES `saved_plan`(`id`) ON DELETE CASCADE
);
