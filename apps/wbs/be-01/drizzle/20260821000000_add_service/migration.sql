-- What a work item is delivered *for* — `Payments`, `Search`, `Billing` — as a
-- third label dimension beside its teams and its tags, plus the map of which
-- team is responsible for which service.
--
-- Dany, 2026-08-20: "I need to have service and team as separate entities", and,
-- asked how the two relate, "Let service and teams be independent." Until this
-- migration the directory's one entity was literally called `service_team` and
-- answered both questions with one row.
--
-- **The name trap, said before anybody trips over it: `service_team` means
-- *team* and `service` means *service*, for one release.** Nothing is renamed
-- here. Blue and green share one SQLite file while green migrates and the
-- outgoing release selects `service_team` on every tree read, so a rename would
-- break the release still running while this one boots. R2-6 does it once no
-- running release reads the old name — design.md D9. Both tables' JSDoc in
-- `schema.ts` says which is which.
--
-- **The defining absence: no pool, no size, no effect on any date.** There is no
-- `size` column on `service` and no per-project capacity table beside it, so
-- nothing anywhere can ask how many of a service may run at once. Capacity
-- belongs to `service_team`, because capacity is spent by the people doing the
-- work and not by the thing the work is for. `service/schedule.ts` has an empty
-- diff in the change that adds these, asserted rather than claimed — a test
-- wires the scheduler to read a service, watches every downstream date move, and
-- reverts. `libs/domain/**` does **not** have an empty diff: the inheritance rule
-- is a rule the two apps share, so `effective-service.ts` and the walk it,
-- `effective-team.ts` and `effective-tag.ts` all read live there. What a service
-- is absent from is the **scheduler** — design.md D3.
--
-- **Global, no project column** — `service_team`'s and `tag`'s shape exactly.
-- `Payments` means `Payments` in every plan, which is what lets an export column
-- mean the same thing across plans and what a name-matched import would need.
--
-- **Additive only. Nothing is renamed and nothing is dropped.** Blue and green
-- share one SQLite file while green migrates, so the outgoing release must keep
-- running against the migrated schema without knowing any of this exists.
--
-- **Stamped 20260821000000, later than every folder on main.** Checked against
-- all twenty-two before this folder was created — `ls apps/be-01/drizzle | sed
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
-- that reads identically. Two services spelled the same are two answers to one
-- question.
--
-- No seeding, and nothing to seed. Existing `service_team` rows are **teams** and
-- they start owning nothing; every work item starts with no service. Decision 4
-- on the task, and it is the honest reading: nobody has ever stated a service on
-- this server, so inventing one from a team name would be the tool asserting a
-- fact nobody typed. A test asserts both tables empty and every `service_id`
-- null after this runs, because "no backfill" is cheap to intend and cheap to
-- break.
CREATE TABLE `service` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
-- One spelling per service, and the index a rename reads before it answers
-- `taken`. `service_team_name`'s and `tag_name`'s job, one dimension over.
CREATE UNIQUE INDEX `service_name` ON `service` (`name`);--> statement-breakpoint
-- Which services one team is responsible for — several, and this is the row that
-- makes a service more than a label.
--
-- Dany, 2026-08-20: "one team can be responsible for several services - it must
-- be configurable in the directory. It will help in the future to flag where
-- teams build something they do not own." This is directory data about teams and
-- services themselves: it labels no work item, and the flagging it enables is a
-- signal computed on read — an item whose effective team and effective service
-- are both stated, where the service is not in that team's owned set — never a
-- validation and never a block.
--
-- The pair is the primary key because the pair is the fact: "Platform owns
-- Payments" is either stated or not, and a second row saying it again would be a
-- second answer to one question. `work_item_team`'s shape, two tables over.
--
-- **Both sides cascade**, carrying `work_item_tag`'s argument unchanged: the
-- outgoing release knows nothing about this table, and its plain
-- `DELETE FROM service_team` must not hit a constraint it cannot see and answer
-- 500 for the length of a swap. `DELETE /api/services/:id` still counts what it
-- would unlabel and still refuses with 409 unless `?cascade=1`; the rows *this*
-- table loses are deliberately not in that count — design.md D7.
--
-- Not a capacity and not a scheduling input: a team owning three services is not
-- thereby three times as busy.
CREATE TABLE `team_service` (
	`team_id` text NOT NULL,
	`service_id` text NOT NULL,
	PRIMARY KEY(`team_id`, `service_id`),
	CONSTRAINT `fk_team_service_team_id_service_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `service_team`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_team_service_service_id_service_id_fk` FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Every ownership statement about one service, which is the one question the
-- primary key cannot answer: it leads with the team, so "what would removing this
-- service touch" would otherwise be a scan. `work_item_tag_by_tag`'s job, one
-- dimension over.
CREATE INDEX `team_service_by_service` ON `team_service` (`service_id`);--> statement-breakpoint
-- The item's own service: **a column, not a join table**, because one service per
-- item is the cardinality — design.md D2, and the task's one open detail
-- defaulted. A join table with a `work_item_id` unique index would say the same
-- thing in a weaker way: the shape reads as many-valued to anyone scanning the
-- schema, and every read becomes a group-by returning arrays of length ≤ 1, which
-- is how a temporarily single-valued field turns many-valued by accident. The
-- *domain* reading is set-shaped regardless — `effectiveServicesOf` hands the
-- shared walk a singleton set — so widening later is a migration plus a read, not
-- a redesign of the inheritance.
--
-- **`ON DELETE SET NULL`, not `CASCADE`, and the difference is the whole of it:
-- deleting a service must not delete work items.** It is also the arm that makes
-- the directory's removal effect `label_nulled` rather than `label_removed`: a
-- column is nulled, a set member is removed, and `directory-usage.ts` already
-- tells those two sentences apart.
--
-- Nullable, and blank means **inherit** — a row with no service takes its nearest
-- ancestor's, a row with one overrides it, per dimension and independently of
-- teams and tags. There is no third "deliberately none" state, exactly as there
-- is none for the other two.
--
-- Added as a column on `work_item` rather than a rebuild:
-- `20260818090000_add_not_before_reason` is the precedent, and SQLite adds a
-- nullable column with a foreign key without touching a row.
ALTER TABLE `work_item` ADD `service_id` text REFERENCES `service`(`id`) ON DELETE SET NULL;
