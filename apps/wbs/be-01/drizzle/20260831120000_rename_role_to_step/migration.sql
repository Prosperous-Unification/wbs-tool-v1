-- The physical schema takes the domain's name: `role` becomes `step`.
--
-- `steps-not-phases` (20260830, archived) renamed the domain everywhere the
-- code can see and stopped at the storage layer, because a table rename is not
-- an additive migration and blue and green share one SQLite file mid-swap. What
-- it left was a documented disagreement — `sqliteTable('role', …)` exported as
-- `step`, `text('role_id')` read as `stepId`, in six tables — held together by a
-- boundary comment in `schema.ts`. R2 says the name carries the domain; this
-- migration pays that comment off and deletes it.
--
-- **This is deliberately NOT backward-compatible, and it is allowed only
-- because there is nothing to be compatible with.** No prod release exists
-- (`LLM_README.md`, open findings 1 and 2, both prod-phase: work stops at dev),
-- so no outgoing colour is reading `role` while this runs. Dev is one container
-- running from a bind-mounted checkout with no swap at all.
--
-- **The precondition is checked, not asserted here.**
-- `bin/assert-no-prod-release.sh` reads the recorded release state and refuses
-- when a colour is named — and refuses just as loudly when the state is missing
-- or unreadable, which is the fault `swap.js`'s `readRecordedColor` and
-- `remote-state.ts`'s `|| true` both shipped. The migration lint's waiver for
-- this folder requires that script to be in the tree, so this migration cannot
-- land in a checkout where the check has been deleted
-- (`tools/tool-git-hooks/src/hooks/migration-lint.ts`, `WAIVERS`).
--
-- **What this would have to be after the first prod deploy** is recorded in
-- `openspec/changes/steps-schema-rename/design.md` D2 so nobody re-derives it
-- under pressure: expand (rename, then a view per old name with INSTEAD OF
-- triggers writing through) then contract (drop the views once no colour reads
-- them). Six views and eighteen triggers alive for one release. That is the
-- change this one refuses to become.
--
-- **Indexes are dropped and recreated because SQLite has no `ALTER INDEX`.**
-- `ALTER TABLE … RENAME TO` carries an index across under its old name, so
-- `role_project_name` would survive on a table called `step`. Dropping and
-- recreating is the only rename SQLite offers, and it is safe here for the same
-- reason the table renames are: nothing is reading through them.
--
-- **FK and CHECK constraint names keep the spelling they were created with** —
-- `fk_actual_role_id_role_id_fk`, `role_progress_state`, `role_measure_metric`.
-- Renaming a constraint in SQLite means rebuilding the table it is on, which is
-- three table rebuilds with `foreign_keys` off, plus three FK-integrity guards,
-- to change strings no query names and no reader reaches for. The spec this
-- migration implements asks that no **table, column or index** name carry the
-- word, and that is what it does; the residue is recorded in
-- `openspec/changes/steps-schema-rename/verify.md` rather than left for a
-- future reader to discover.
--
-- **No data moves.** Every statement below is a rename. Row counts and values
-- are identical before and after, which is what makes `down.sql` a total
-- inverse and the round trip in `migrate-down.test.ts` a real check rather than
-- a hopeful one.
--
-- **Stamped 20260831120000, later than every folder on disk.** Checked before
-- this folder was created — `ls apps/be-01/drizzle | sed 's/_.*//' | sort |
-- uniq -d` was silent, with `20260830130000_add_estimate_weights_and_rounding`
-- the newest — and checked mechanically by `duplicateMigrationStamps` in
-- `migrate-down.ts`, which throws where the folders are read. Two migrations
-- shared `20260814100000` on 2026-08-14 and `migrationsToRollback` filters on a
-- strict `created_at >`, so rolling back *to* either of the pair reversed
-- nothing at all, silently.
ALTER TABLE `role` RENAME TO `step`;--> statement-breakpoint
ALTER TABLE `role_progress` RENAME TO `step_progress`;--> statement-breakpoint
ALTER TABLE `role_measure` RENAME TO `step_measure`;--> statement-breakpoint
ALTER TABLE `estimate` RENAME COLUMN `role_id` TO `step_id`;--> statement-breakpoint
ALTER TABLE `actual` RENAME COLUMN `role_id` TO `step_id`;--> statement-breakpoint
ALTER TABLE `assignment` RENAME COLUMN `role_id` TO `step_id`;--> statement-breakpoint
ALTER TABLE `plan_event` RENAME COLUMN `role_id` TO `step_id`;--> statement-breakpoint
ALTER TABLE `step_progress` RENAME COLUMN `role_id` TO `step_id`;--> statement-breakpoint
ALTER TABLE `step_measure` RENAME COLUMN `role_id` TO `step_id`;--> statement-breakpoint
DROP INDEX `role_project_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `step_project_name` ON `step` (`project_id`,`name`);--> statement-breakpoint
DROP INDEX `actual_by_role`;--> statement-breakpoint
CREATE INDEX `actual_by_step` ON `actual` (`step_id`);--> statement-breakpoint
DROP INDEX `role_progress_by_role`;--> statement-breakpoint
CREATE INDEX `step_progress_by_step` ON `step_progress` (`step_id`);--> statement-breakpoint
DROP INDEX `role_measure_by_role`;--> statement-breakpoint
CREATE INDEX `step_measure_by_step` ON `step_measure` (`step_id`);
