-- Which teams a work item's work belongs to becomes a **set**.
--
-- Dany, 2026-08-13: "can be several teams and several services per work item".
-- `work_item.service_team_id` holds one, so the set gets a table of its own and
-- every read moves onto it. The column is neither dropped nor stopped: blue and
-- green share one SQLite file mid-swap and the outgoing release selects it on
-- every tree read, so it is dual-written for one more release and dropped by
-- R2-6. `openspec/changes/team-sets/design.md` D2.
--
-- The pair is the primary key because the pair is the fact — this work item's
-- work is Platform's, stated or not — and a second row would be a second answer
-- to one question. `project_team_capacity`'s shape, one table along.
--
-- Both foreign keys cascade, and the cascade is the **only** thing that removes
-- these rows: nothing in be-01 deletes them on the way to deleting a team or a
-- work item. That is the guard rather than a belt over a brace, and it is the
-- same argument the per-project capacity table makes: the outgoing release
-- knows nothing about this table, and its plain `DELETE FROM service_team`
-- would hit a constraint it cannot see and answer 500 for the length of a swap.
--
-- Proof: `ON DELETE CASCADE` struck from both foreign keys, and `lets the
-- outgoing release keep removing teams against the migrated schema` failed on
-- `SQLiteError: FOREIGN KEY constraint failed` at its `DELETE FROM
-- service_team` — the 500 above, in the shape it would arrive in — 16 pass /
-- 1 fail. Watched 2026-08-14.
CREATE TABLE `work_item_team` (
	`work_item_id` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`work_item_id`, `team_id`),
	CONSTRAINT `fk_work_item_team_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_team_team_id_service_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `service_team`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- By team, because the directory asks "what would removing this team touch" of
-- every project at once and the primary key answers only the other direction.
CREATE INDEX `work_item_team_by_team` ON `work_item_team` (`team_id`);
--> statement-breakpoint
-- The seeding, and it is what makes this change invisible. Every work item that
-- carries a label today gets exactly one join row, so every effective set is of
-- one member or empty, every pool search is the single-pool search it already
-- was, and no plan's dates move. Without it, the release that reads the join
-- reads an empty one: every label disappears from every screen and every
-- capacity-floored slice comes back unpooled on the day this ran.
--
-- Not a cartesian product and not conditional on anything else — unlike
-- `project_team_capacity`'s seeding, which had to reach pairs no work item
-- named. There is nothing here to reach: the set a row carries is exactly the
-- label it carries, and a row with no label carries no set.
--
-- Proof: this statement struck — the file cut at the second statement
-- separator, so what is left stays valid SQL — and `carries every label into
-- the join, and nothing else` failed on
-- `expect(received).toEqual(expected)` with `+ []` where
-- `{ work_item_id: 'w1', team_id: 't-backend' }` was owed — the empty join
-- above — 16 pass / 1 fail. Watched 2026-08-14.
INSERT INTO `work_item_team` (`work_item_id`, `team_id`)
SELECT `id`, `service_team_id` FROM `work_item` WHERE `service_team_id` IS NOT NULL;
