-- What kind of work a row *is* — `Story`, `Bug`, `Spike`, `Epic`.
--
-- The fourth reference dimension, after the team (who does it), the service
-- (what it is delivered for) and the tag (what kind of thing it is about). A
-- plan tracked against Jira carries an issue type per row and the table had
-- nowhere to put it, so readers encoded it in the name (`[BUG] …`) or in a tag —
-- which made the tag vocabulary carry two unrelated things at once and made the
-- filter's tag facet a mix of vocabulary and taxonomy.
--
-- **A tag says what a row is *about*; a type says what a row *is*.** `regulatory`
-- and `Bug` are not the same kind of statement, and one row answers both. That
-- separation is the whole reason this is a table and not three more tags.
--
-- **Set-valued, on Dany's call (2026-08-29): a row may carry several types**, the
-- way it carries several tags, rather than the single-valued column a Jira issue
-- type would suggest. That is why the join carries a composite primary key rather
-- than this being a `type_id` column on `work_item`.
--
-- **Not anything the scheduler may read.** There is no size, no pool and no
-- per-project capacity table beside this one, so nothing can ask how many Bugs
-- may run at once. `service/schedule.ts` has an empty diff in the change that
-- adds these tables, asserted by `service-untouched.test.ts` rather than claimed
-- here. A type is a label; it decides nothing.
--
-- **Global, no project column** — {@link tag} and `service_team`'s shape exactly.
-- A type that meant `Bug` on one plan and something else on the next would make
-- the directory a per-project screen.
--
-- **Additive only. Nothing renamed, nothing dropped.** Blue and green share one
-- SQLite file while green migrates, so the outgoing release keeps running against
-- the migrated schema without knowing either table exists.
--
-- Stamped 20260830010000, later than every folder on main — checked with
-- `ls apps/be-01/drizzle | sed 's/_.*//' | sort | uniq -d`, which was silent, and
-- checked mechanically by `duplicateMigrationStamps` in `migrate-down.ts`. Two
-- migrations shared `20260814100000` on 2026-08-14 and `migrationsToRollback`
-- filters on a strict `created_at >`, so rolling back *to* either of a colliding
-- pair reversed nothing at all, silently.
--
-- No seeding. Naming the Jira vocabulary here would be the tool asserting
-- somebody else's taxonomy, and the change's own non-goals rule out Jira
-- integration. Every plan starts both tables empty.
CREATE TABLE `work_item_type` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
-- One spelling per type, and the index a rename reads before it answers `taken`.
-- `tag_name`'s job, one dimension over. Two types spelled the same are two
-- answers to one question.
CREATE UNIQUE INDEX `work_item_type_name` ON `work_item_type` (`name`);--> statement-breakpoint
-- Which types one work item carries — several, independently of its tags.
--
-- The pair is the primary key because the pair is the fact. `work_item_tag`'s
-- shape, deliberately identical and deliberately unjoined to it.
--
-- **Inheritance is not computed for this dimension, and that is the one place
-- this table's rules differ from `work_item_tag`'s.** A row's types are its own;
-- an unset type is unset, and reads as nothing rather than as an ancestor's. See
-- `docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md` for why this dimension
-- answers R2's Q4 differently from teams and tags, and how it relates to the
-- `tags-accumulate` change deciding the tag dimension in the opposite direction.
--
-- Both sides cascade, for `work_item_tag`'s reasons unchanged: a type is a label,
-- deleting the label takes the labelling with it, and the outgoing release's
-- plain `DELETE FROM work_item` must not hit a constraint it cannot see.
--
-- Proof: `ON DELETE CASCADE` struck from `work_item_id` and `lets the outgoing
-- release keep deleting work items against the migrated schema` fails on that
-- exact statement with `FOREIGN KEY constraint failed`.
CREATE TABLE `work_item_work_item_type` (
	`work_item_id` text NOT NULL,
	`type_id` text NOT NULL,
	PRIMARY KEY(`work_item_id`, `type_id`),
	CONSTRAINT `fk_wiwit_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_wiwit_type_id_work_item_type_id_fk` FOREIGN KEY (`type_id`) REFERENCES `work_item_type`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Every labelling of one type, which the primary key cannot answer: it leads with
-- the work item, so "what would removing this type touch" would be a table scan.
-- The directory asks it across every project before it shows its confirmation,
-- and the delete route asks it again before answering 409.
-- `work_item_tag_by_tag`'s job, one dimension over.
CREATE INDEX `wiwit_by_type` ON `work_item_work_item_type` (`type_id`);
