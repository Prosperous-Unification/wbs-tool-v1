-- A work item's team stops being a column and becomes a set, and a second,
-- independent set of product-area labels arrives beside it.
--
-- Dany, 2026-08-13: "I want to separate team vs service in each of the work
-- item; can be several teams and several services per work item", then at 23:41
-- the answer that shapes the second half of this file — a service is "A label":
-- a product area a work item wears, with no size, no pool and **no effect on any
-- date**. Capacity stays teams-only, which is why `project_team_capacity` and
-- `person_team` are not touched here by so much as a comment.
--
-- Additive, as every forward migration here is: nothing is dropped and nothing
-- is renamed, because blue and green share one SQLite file and the outgoing
-- release still selects `work_item.service_team_id` on every tree read. That
-- column is kept **and kept written** for one release; R2-6 drops it.
CREATE TABLE `work_item_team` (
	`work_item_id` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`work_item_id`, `team_id`),
	CONSTRAINT `fk_work_item_team_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_team_team_id_service_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `service_team`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- The direction the primary key cannot serve. The directory's removal asks
-- "which work items name this team", which is a scan of the whole table without
-- it.
CREATE INDEX `work_item_team_by_team` ON `work_item_team` (`team_id`);
--> statement-breakpoint
-- `service` is `service_team` minus `size`: two columns, one **global** list
-- (Q7, 2026-08-13 23:59). No `project_id`, deliberately — Payments means
-- Payments in every plan, which is what makes an export column and R3's
-- name-matched import well defined. Were the list ever scoped, the change is a
-- nullable `project_id` plus a filtered read and a widened unique index, which
-- is additive and not a redesign; a half-built scoping column now would read as
-- a promise the code does not keep.
CREATE TABLE `service` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
-- Unique at the database rather than only in the service, for
-- `service_team_name`'s reason: two people creating `Payments` at the same
-- moment both pass a check-then-insert, and only a constraint stops the second.
CREATE UNIQUE INDEX `service_name` ON `service` (`name`);
--> statement-breakpoint
CREATE TABLE `work_item_service` (
	`work_item_id` text NOT NULL,
	`service_id` text NOT NULL,
	PRIMARY KEY(`work_item_id`, `service_id`),
	CONSTRAINT `fk_work_item_service_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_service_service_id_service_id_fk` FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `work_item_service_by_service` ON `work_item_service` (`service_id`);
--> statement-breakpoint
-- The seed, and it is the whole of "no plan moves". Every read path in the
-- release this migration ships with takes a work item's teams from
-- `work_item_team`; without this statement every plan on the deployment would
-- come back from the deploy with its labels gone, its pools unspent, and dates
-- nobody edited moved on the day it ran.
--
-- One row per work item that carries a non-null column, so **every set is of
-- size one or empty**. That arity is what makes the identity differential hold
-- by construction rather than by care: a set of one resolves to the label the
-- column held, and a pool spent for a set of one is the pool spent for the
-- column.
--
-- Every cascade above is load-bearing for the same reason `project_team_capacity`'s
-- are: the outgoing release's plain `DELETE FROM service_team` knows nothing
-- about these tables and must not hit a constraint it cannot see.
--
-- Proof: this INSERT struck (replaced by `SELECT 1;`), and `seeds one team row
-- per work item that carried a label` failed on `expect(received).toEqual(expected)`
-- with `[]` where three rows were owed; `lets the outgoing release keep deleting
-- teams` went with it, for 19 pass / 2 fail. Watched 2026-08-14.
--
-- **What did not fail, and it matters:** `capacity-migration-identity.test.ts`
-- stayed green through that injection. It replays its sixteen plans through
-- in-memory stores, so the SQL seeding is not on its path at all — the oracle
-- proves the *read model* schedules identically, and this file is the only thing
-- that proves the rows it reads were written. Two claims, two tests, and neither
-- covers the other; verify.md says so where a reader would otherwise assume the
-- oracle covers both.
-- `service` and `work_item_service` get no seeding statement at all, and that is
-- a decision rather than an omission (Q6, 2026-08-14 09:00). Today's
-- `service_team` rows are pools; nothing in the data distinguishes a row
-- somebody typed meaning "Payments" from one meaning "Platform", and moving a
-- row into the service table would take its pool away from every work item that
-- named it — a date change nobody typed. So no migration converts anything, and
-- none ever should: the conversion Dany asked for is a **per-row, opt-in action
-- in the directory** — he picks the row, a modal states what is lost — landing
-- in R2-4/R2-5. See design.md D1. Services otherwise start empty and users
-- create them, from R2-5's directory page. `migrate.test.ts` asserts both tables
-- come out of this migration empty, so the absence is checked rather than
-- assumed.
INSERT INTO `work_item_team` (`work_item_id`, `team_id`)
SELECT `id`, `service_team_id` FROM `work_item` WHERE `service_team_id` IS NOT NULL;
