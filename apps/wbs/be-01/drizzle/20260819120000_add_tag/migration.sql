-- What kind of thing a work item is, as a second label dimension beside its
-- teams: `regulatory`, `tech-debt`, `q3-must-have`.
--
-- Dany, 2026-08-19: "Ok let's add tags - might be useful." R2-5 designed this
-- dimension already under the name `service` and `notes/decisions.md:85` dropped
-- it pointing at R10; this is that design built, renamed, and nothing else about
-- it changed.
--
-- **A team says who does the work and the scheduler spends its capacity. A tag
-- says what kind of thing this is and the scheduler must never read it.** The two
-- questions are different, an item answers both at once, and until this migration
-- it could only answer the first.
--
-- **The defining absence: no pool, no size, no effect on any date.** There is no
-- `size` column here and no per-project capacity table beside this one, so
-- nothing anywhere can ask how many of a tag may run at once. `service/schedule.ts`
-- has an empty diff in the change that adds these tables, and that is asserted
-- rather than claimed — a test wires the scheduler to read a tag, watches every
-- downstream date move, and reverts. `libs/domain/**` does **not** have an empty
-- diff and an earlier draft of this comment said it did: the inheritance rule is
-- a rule the two apps share, so `effective-tag.ts` and the walk it and
-- `effective-team.ts` now read live there. What a tag is absent from is the
-- **scheduler**, not the shared library — design.md D3.
--
-- **Global, no project column** — `service_team`'s shape exactly. A label that
-- meant one thing on one plan and another on the next would make the directory a
-- per-project screen and the filter a per-project vocabulary, and neither is what
-- a tag is for.
--
-- **Additive only. Nothing is renamed and nothing is dropped.** Blue and green
-- share one SQLite file while green migrates, so the outgoing release must keep
-- running against the migrated schema without knowing either table exists.
--
-- **Stamped 20260819120000, later than every folder on main.** Checked against
-- all twenty-one before this folder was created — `ls apps/be-01/drizzle | sed
-- 's/_.*//' | sort | uniq -d` was silent — and checked mechanically by
-- `duplicateMigrationStamps` in `migrate-down.ts`, which throws where the folders
-- are read. Two migrations shared `20260814100000` on 2026-08-14;
-- `migrationsToRollback` filters on a strict `created_at >`, so rolling back *to*
-- either of a colliding pair reversed nothing at all, silently, with both tables
-- still standing. There is deliberately no `drizzle/meta/_journal.json` in this
-- repo and none was added.
--
-- `name` is `NOT NULL` and carries a unique index below, which is what lets a
-- rename answer `taken` with the surviving name instead of writing a second row
-- that reads identically. Two tags spelled the same are two answers to one
-- question.
--
-- No seeding, and nothing to seed: no plan on the server has ever carried a tag,
-- and inventing a vocabulary would be the tool asserting somebody else's
-- taxonomy. Every plan starts both tables empty, which reads as "nobody has
-- labelled anything" and not as "everything is untagged on purpose" — blank means
-- inherit, and at the root inherit means nothing.
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
-- One spelling per tag, and the index a rename reads before it answers `taken`.
-- `service_team_name`'s job, one dimension over.
CREATE UNIQUE INDEX `tag_name` ON `tag` (`name`);--> statement-breakpoint
-- Which tags one work item carries — several, and independently of its teams.
--
-- The pair is the primary key because the pair is the fact: "this work item is
-- regulatory" is either stated or not, and a second row saying it again would be
-- a second answer to one question. `work_item_team`'s shape, deliberately
-- identical and deliberately unjoined to it — an item answers who and what kind
-- at once, through two tables that know nothing about each other.
--
-- **Inheritance is not stored here.** A work item with no rows in this table
-- inherits its ancestor's tags; one with rows overrides them. Override, per
-- dimension, independently — R2's Q4 — computed by `effectiveTagsOf` on every
-- read the way `effectiveTeamsOf` already computes the other dimension. Nothing
-- denormalised is ever written, so no row here is ever a copy of an ancestor's.
--
-- **Both sides cascade, and `tag_id` is where this differs from `role_progress`.**
-- There, `role_id` deliberately does not cascade: a progress state is somebody's
-- statement about their own work, so a role removal must count it before taking
-- it, and a missing cascade makes a forgetful delete fail loudly instead of
-- quietly marking a finished plan unfinished. A tag is a label. Deleting the
-- label should take the labelling with it, and there is nothing to count that the
-- label itself was not. `DELETE /api/tags/:id` still counts first and still
-- refuses with 409 unless `?cascade=1` — the count is for the person pressing the
-- button, not for the integrity of anything.
--
-- The cascade on `work_item_id` carries `work_item_team`'s argument unchanged:
-- two be-01 processes share one SQLite file while green migrates, the outgoing
-- release knows nothing about this table, and its plain `DELETE FROM work_item`
-- would hit a constraint it cannot see and answer 500 for the length of the swap.
--
-- Proof: `ON DELETE CASCADE` struck from `work_item_id` and `lets the outgoing
-- release keep deleting work items against the migrated schema` fails on that
-- exact statement with `FOREIGN KEY constraint failed`.
CREATE TABLE `work_item_tag` (
	`work_item_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`work_item_id`, `tag_id`),
	CONSTRAINT `fk_work_item_tag_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_tag_tag_id_tag_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Every labelling of one tag, which is the one question the primary key cannot
-- answer: it leads with the work item, so "what would removing this tag touch"
-- would otherwise be a scan of the table. `directoryUsageOfTag` asks it across
-- every project at once before the directory shows its confirmation, and the
-- delete route asks it again before it answers 409. `work_item_team_by_team`'s
-- job, one dimension over.
CREATE INDEX `work_item_tag_by_tag` ON `work_item_tag` (`tag_id`);
