-- How many of a team may be at work at once becomes a fact about one **project**,
-- and the global number it replaces stops being read.
--
-- Dany, 2026-08-13: "the capacity must be configurable per project", and "The
-- global number should not matter, only per project capacity configuration
-- matters." The second sentence is the one this file is shaped by: there is no
-- fallback to `service_team.size`, so a pair with no row here is *unstated* and
-- constrains that team's work on that plan not at all.
--
-- `size integer NOT NULL` and no default, which is the opposite of
-- `20260812100000_add_team_slots`'s choice and for the same underlying reason.
-- There, unstated had to be expressible in the column, because every team in the
-- database already existed and none of them was sized. Here unstated is the
-- **absence of a row** — one spelling of one fact — so a nullable column would be
-- a second spelling that every reader would have to handle. It is also what makes
-- the seeding below refuse to write an unsized team as a number rather than
-- silently inventing one.
--
-- Both foreign keys cascade, and the cascade is the **only** thing that removes
-- these rows. The application deletes none of them on its way to deleting a
-- project or a team — `CapacityRepository.set`'s clear-to-unstated is the one
-- `DELETE` against this table anywhere in be-01 — so this is the guard rather
-- than a belt over a brace. It has to be, because blue and green share one
-- SQLite file during a swap and the outgoing release knows nothing about this
-- table: its plain `DELETE FROM service_team` would hit a constraint it cannot
-- see and answer 500 for the length of the swap.
--
-- Proof: with the cascades removed, `lets the outgoing release keep writing
-- teams and projects against the migrated schema` fails on that exact statement
-- with `FOREIGN KEY constraint failed`; watched 2026-08-13.
CREATE TABLE `project_team_capacity` (
	`project_id` text NOT NULL,
	`service_team_id` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`project_id`, `service_team_id`),
	CONSTRAINT `fk_project_team_capacity_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_team_capacity_service_team_id_service_team_id_fk` FOREIGN KEY (`service_team_id`) REFERENCES `service_team`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- The seeding, and it is the whole reason this migration is not merely additive
-- in the boring sense: without it, every plan on the deployment would come back
-- from this deploy with its sized teams unconstrained, and dates nobody edited
-- would move on the day it ran.
--
-- A **CROSS JOIN**, deliberately, and not the join over labelled work. The join
-- would be enough for today's dates — a pair labelling nothing spends no slots —
-- and it is not enough for the promise, which is that existing global sizes do
-- not silently change existing schedules. Under the join, labelling one more row
-- in an existing project with `Platform` the day after this ran would give that
-- plan an unconstrained Platform where the release before this one gave it four.
-- The cost is rows nobody asked for, bounded at projects × sized teams, both
-- directory-scale here. `openspec/changes/capacity-per-project/design.md` D2.
--
-- Proof, both watched 2026-08-13 in `migrate.test.ts`. Narrowed to the two joins
-- over `work_item`: `seeds every project that existed from the global size it
-- retires` failed on a `toEqual` diff missing five of the six pairs — everything
-- for the project that labels nothing, and both unlabelled teams on the project
-- that labels one. With `WHERE st.size IS NOT NULL` struck, the migration itself
-- aborts and takes both seeding tests with it: `DrizzleError: Failed to run the
-- query '<this INSERT>'`, which is drizzle's wrapper around SQLite's `NOT NULL
-- constraint failed: project_team_capacity.size` (the bare statement's own
-- message, confirmed against `bun:sqlite` directly — the migrator prints only its
-- wrapper). The column's shape is what refuses to write *unstated* as a number.
INSERT INTO `project_team_capacity` (`project_id`, `service_team_id`, `size`)
SELECT `p`.`id`, `st`.`id`, `st`.`size`
FROM `project` `p`
CROSS JOIN `service_team` `st`
WHERE `st`.`size` IS NOT NULL;
