-- The days a role actually spent on one work item, beside the estimate of it.
--
-- Dany, 2026-08-13: "I want to be able to track fact days near the estimate of
-- completion". `notes/wbs-brief-2026-08-14-r5-r6-history.md` §3.2 and §6 H2.
-- This is the table and the write path and nothing else: no faces (H3), no
-- snapshots (H4), no reading surface (H5).
--
-- **Keyed (work_item_id, role_id) — the estimate's own grain.** Per role rather
-- than per item because that is the pair every read in the tool already groups
-- by, and because "who overran, Dev or QA?" is the question an actual exists to
-- answer. A per-item actual would be a second spelling of a total that then has
-- to agree with per-role estimates, and would not.
--
-- **Its own table rather than a fourth column on `estimate`.** Work nobody
-- estimated still takes days; `estimate`'s three columns are NOT NULL, so a
-- column there would force a made-up trio to record a real actual.
--
-- **`days` is NOT NULL and there is no row for "unstated".** The absence of a
-- row is what "nobody has said" looks like — the rule `project_team_capacity`
-- follows and the one the export has carried since it was written, that an empty
-- cell means nobody typed it and never zero. Clearing an actual deletes the row.
-- A stored 0 is therefore a person saying the work took no days, which is a
-- statement somebody made rather than the absence of one.
--
-- **Stamped 20260817130000, later than every folder on main.** Checked against
-- all eighteen of them before this folder was created, and mechanically: two
-- migrations shared `20260814100000` on 2026-08-14, drizzle records the folder's
-- numeric prefix as a migration's `created_at`, `migrationsToRollback` filters on
-- a strict `created_at >`, and rolling back *to* either of a colliding pair
-- therefore reversed nothing at all, silently, with both tables still standing.
-- `duplicateMigrationStamps` in `migrate-down.ts` — added by H1 — now throws
-- where the folders are read. This stamp passes it; see verify.md for the run.
--
-- **`work_item_id` cascades, `role_id` deliberately does not.** The asymmetry is
-- the same one `estimate` carries and is argued on `role` in `schema.ts`. An
-- actual is somebody's typing, so a role removal must *count* it before taking
-- it: the missing cascade is what makes a role delete that forgot to say so fail
-- loudly instead of quietly emptying the plan, and `RoleRepository.remove`
-- deletes actuals explicitly inside the transaction that removes the role.
--
-- The cascade on `work_item_id` is about the blue/green swap window rather than
-- tidiness: two be-01 processes share one SQLite file while green migrates, the
-- outgoing release knows nothing about this table, and its plain
-- `DELETE FROM work_item` would hit a constraint it cannot see and answer 500
-- for the length of the swap. The same argument `dependency` makes.
--
-- Proof: `ON DELETE CASCADE` struck from `work_item_id`, and `lets the outgoing
-- release keep deleting work items against the migrated schema` in
-- `migrate.test.ts` fails on that exact statement with `FOREIGN KEY constraint
-- failed`; the cascade *added* to `role_id`, and `keeps a role that still holds
-- an actual undeletable behind the repository that counts them` fails with the
-- actual silently gone. Both watched 2026-08-17 — see verify.md.
--
-- **Nothing here reaches the scheduler.** No date moves either way: the engine's
-- input is built from `estimate` in `slicesOf`, and this table is read nowhere
-- below it. `service/schedule.ts` has an empty diff in the change that adds this
-- file, which is a claim asserted by replaying the identity corpus rather than
-- written down here.
--
-- No seeding, and nothing to seed: no plan on the server has ever recorded a day
-- spent, and inventing one would be the tool asserting a fact about somebody's
-- past week. Every plan starts this table empty, which reads as "nobody has
-- recorded anything yet" and not as "no days were spent".
CREATE TABLE `actual` (
	`work_item_id` text NOT NULL,
	`role_id` text NOT NULL,
	`days` real NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`work_item_id`, `role_id`),
	CONSTRAINT `fk_actual_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_actual_role_id_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`id`)
);
--> statement-breakpoint
-- Every actual of one role, which is the one question the primary key cannot
-- answer: it leads with the work item, so "what would removing this role take
-- with it" would otherwise be a scan of the table. `RoleRepository.remove` asks
-- it on every removal, and the role dialog asks it before every confirmation.
CREATE INDEX `actual_by_role` ON `actual` (`role_id`);
