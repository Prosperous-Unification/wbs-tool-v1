-- What a project's priority numbers are **called**, and what each name writes.
--
-- Dany, 2026-08-13: "they are numeric but I want labels assigned to them; like
-- 1-20 are critical, 21-40 are high, 41-60 are medium, 61-80 are low, 81-further
-- is lowest; and by default critical sets to 10, high to 30, medium to 50, low to
-- 70, lowest to 90; I described the default setting, but all this needs to be
-- configurable by project".
--
-- **This table moves no date, and that is the load-bearing claim about it.** The
-- leveller reads `work_item.priority` and nothing else (`goesFirst` in
-- `service/schedule.ts`); a band is the vocabulary that integer is read and
-- written in. Re-cutting a ladder renames what a plan's numbers are called and
-- changes not one of its dates — `service/priority-band-identity.test.ts` replays
-- sixteen captured plans against a migrated database to say so.
--
-- `rank` is the rung, 0 (most important) to 4, and it is the key rather than
-- `starts_at` for one reason: a project re-cutting its ladder is an **update** to
-- five rows, not a delete and an insert of a new set of keys. It is also what
-- every face keys a colour off, because a label is renameable and a colour that
-- followed the word `Critical` would follow it out of the ladder.
--
-- There is no `CHECK` on the ladder's invariants — first band at 1, strictly
-- increasing starts, a default inside its own band — because they are facts about
-- the five rows **together** and SQLite's row-level CHECK cannot see a sibling.
-- `priorityLadderProblem` in `libs/domain` is the one guard, and the write
-- replaces all five rows in one transaction so there is no moment at which four
-- of them are a ladder and the fifth is not.
--
-- The foreign key cascades, and the cascade is the only thing that removes these
-- rows: no application code deletes them on the way to deleting a project. It has
-- to be, because blue and green share one SQLite file during a swap and the
-- outgoing release knows nothing about this table — its plain `DELETE FROM
-- project` would hit a constraint it cannot see.
--
-- Proof: with the cascade removed, `lets the outgoing release keep writing
-- projects against the migrated schema` fails on that exact statement with
-- `FOREIGN KEY constraint failed`; watched 2026-08-14.
CREATE TABLE `project_priority_band` (
	`project_id` text NOT NULL,
	`rank` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`label` text NOT NULL,
	`default_value` integer NOT NULL,
	PRIMARY KEY(`project_id`, `rank`),
	CONSTRAINT `fk_project_priority_band_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- The seeding: every project that exists gets the five default bands.
--
-- **It is a materialisation, not a behaviour**, and the distinction is what makes
-- it honest rather than redundant. `PriorityBandRepository.listFor` answers
-- `DEFAULT_PRIORITY_BANDS` for a project holding no rows, so a plan seeded here
-- and a plan created tomorrow read exactly the same ladder — nothing on any face
-- can tell them apart. What the rows buy is that the deployment's real projects
-- hold their ladder as data somebody can read out of the database, diff, and edit
-- one rung of, rather than as an absence that means five things.
--
-- That is also why this is a plain `SELECT` over `project` and not the cartesian
-- product argument `capacity-per-project` D2 had to make. There, seeding the
-- wrong set changed dates on day two; here every unseeded project reads the same
-- five bands the seeding would have written, so the set is a convenience and the
-- read is the contract. design.md D2.
--
-- Proof: the seeding deleted, and `seeds every project that existed with the five
-- default bands` fails on an empty `toEqual` where fifteen rows are owed — three
-- projects times five rungs. The *behaviour* tests stay green with it deleted,
-- which is the point of the paragraph above and is why this migration's claim is
-- asserted on the table rather than on a plan. Watched 2026-08-14.
INSERT INTO `project_priority_band` (`project_id`, `rank`, `starts_at`, `label`, `default_value`)
SELECT `p`.`id`, `b`.`rank`, `b`.`starts_at`, `b`.`label`, `b`.`default_value`
FROM `project` `p`
CROSS JOIN (
	SELECT 0 AS `rank`, 1 AS `starts_at`, 'Critical' AS `label`, 10 AS `default_value`
	UNION ALL SELECT 1, 21, 'High', 30
	UNION ALL SELECT 2, 41, 'Medium', 50
	UNION ALL SELECT 3, 61, 'Low', 70
	UNION ALL SELECT 4, 81, 'Lowest', 90
) `b`;
