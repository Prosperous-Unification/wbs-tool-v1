-- The plan's history: one row per command somebody ran on a project, kept.
--
-- Dany, 2026-08-13: "I need to be able to save current state as a snapshot; so
-- that later I can examine the history of estimates changes". This is the second
-- half of that sentence and none of the first — no snapshot table, no actuals, no
-- reading surface. `notes/wbs-brief-2026-08-14-r5-r6-history.md` §6 H1.
--
-- **Not `command_journal` and not `event_log`.** The journal is an undo stack: one
-- per (project, *account*), fifty deep, and its append deletes that account's redo
-- branch. The event log is the websocket resume buffer, keyed by subscription and
-- pruned by count. Neither is a history, and this table is additive to both — it
-- replaces nothing and nothing reads it yet.
--
-- **Stamped 20260817120000, later than every folder on main.** Two migrations
-- shared `20260814100000` on 2026-08-14; drizzle's `created_at` is the folder's
-- numeric prefix, `migrationsToRollback` filters on a strict `created_at >`, and
-- rolling back *to* either of a colliding pair therefore reversed nothing at all,
-- silently, with both tables still standing. `duplicateMigrationStamps` in
-- `migrate-down.ts` is now the mechanical check; this stamp was chosen against it.
--
-- `work_item_id` and `role_id` carry **no foreign key**, deliberately. A cascade
-- would delete the history of the work item somebody is asking about at the moment
-- it is deleted; a restricting reference would refuse the delete instead. A history
-- that cannot outlive its subject is not one — the same argument `work_item.frozen_number`
-- makes for a number that has left the tool.
--
-- The two foreign keys that do exist cascade, and both are about the blue/green
-- swap window rather than tidiness: two be-01 processes share one SQLite file
-- while green migrates, the outgoing release knows nothing about this table, and
-- its plain `DELETE FROM project` would hit a constraint it cannot see and answer
-- 500 for the length of the swap.
--
-- Proof: `ON DELETE CASCADE` struck from `project_id`, and `lets the outgoing
-- release keep deleting projects against the migrated schema` in `migrate.test.ts`
-- fails on that exact statement with `FOREIGN KEY constraint failed`; struck from
-- `user_id`, `lets the outgoing release keep deleting accounts against the migrated
-- schema` fails the same way. Both watched 2026-08-17 — see verify.md.
--
-- No seeding, and nothing to seed: a history begins when it begins, and there is
-- nowhere to read yesterday's estimate changes from. Every plan on the server
-- starts this table empty, which reads as "nothing has been recorded yet" and not
-- as "nothing has changed" — the absence rule this repo applies everywhere. The
-- first row is written by the next edit anybody makes.
CREATE TABLE `plan_event` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`work_item_id` text,
	`role_id` text,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_plan_event_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_plan_event_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- The project's history in time order, which is the only order it is ever read
-- in, and the one retention deletes from the old end of.
CREATE INDEX `plan_event_project_time` ON `plan_event` (`project_id`,`created_at`);
--> statement-breakpoint
-- One work item's history. A separate index rather than a suffix of the one
-- above: "how did this estimate move" filters on the item and never on the
-- project first, and a composite led by `project_id` cannot serve it.
CREATE INDEX `plan_event_item` ON `plan_event` (`work_item_id`,`created_at`);
