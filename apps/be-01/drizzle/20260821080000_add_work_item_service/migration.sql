-- A work item is delivered for a **set** of services, not one.
--
-- Dany, 2026-08-21: "can be several services." `20260821000000_add_service`
-- shipped this dimension eight hours earlier as a single nullable column,
-- `work_item.service_id`, on the explicit ground that the schema should state
-- the cardinality rather than a comment stating it. The cardinality changed, so
-- the schema changes with it: `work_item_service`, `work_item_tag` line for
-- line, because a service and a tag are now the same shape of fact about a row.
--
-- **Additive, and the older column deliberately survives this migration.** Blue
-- and green share one SQLite file while green migrates. The outgoing release
-- selects `work_item.service_id` on every tree read and writes it on every
-- patch; a migration that dropped it would take the running release down for
-- the length of the swap, and a column that is merely no longer read breaks
-- nobody. It goes in a later migration, once no running release names it —
-- `service_team` keeps its wrong name for exactly the same reason
-- (design.md D2 and D9).
--
-- **Seeded from that column, which is the whole of why this is safe to run on a
-- database with plans in it.** Every row that states a service arrives here
-- carrying it, so a reader after this migration gets the singleton it got
-- before. Creating the table empty would have unlabelled every plan on the box
-- in the name of a wider type — the one thing the widening must not cost.
-- `WHERE service_id IS NOT NULL` because a null column is "this row states
-- nothing and inherits", and a row in this table is a statement: an inheriting
-- row seeded with a null would be claiming a service nobody gave it.
--
-- **Nothing a date reads, still.** The dimension's defining absence is unchanged
-- by its cardinality: no pool, no size, no per-project table beside this one, so
-- nothing anywhere can ask how many of a service may run at once.
-- `service/schedule.ts` has an empty diff in the change that adds this, watched
-- by `service-empty-diff.test.ts` — which wires the scheduler to read a service
-- as a team and shows every downstream date move.
--
-- **Stamped 20260821080000, later than every folder on disk.** Checked before
-- this folder existed: `ls apps/be-01/drizzle | sed 's/_.*//' | sort | uniq -d`
-- was silent and `20260821080000` matched nothing, with
-- `duplicateMigrationStamps` in `migrate-down.ts` the mechanical half. Two
-- migrations shared `20260814100000` on 2026-08-14 and `migrationsToRollback`
-- filters on a strict `created_at >`, so rolling back *to* either of a colliding
-- pair reversed nothing at all, silently.
CREATE TABLE `work_item_service` (
	`work_item_id` text NOT NULL,
	`service_id` text NOT NULL,
	PRIMARY KEY(`work_item_id`, `service_id`),
	CONSTRAINT `fk_work_item_service_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_service_service_id_service_id_fk` FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- Every labelling of one service, which is the one question the primary key
-- cannot answer: it leads with the work item, so "what would removing this
-- service touch" would otherwise be a scan of the table. `directoryUsageOfService`
-- asks it across every project at once before the directory shows its
-- confirmation, and the delete route asks it again before it answers 409.
-- `work_item_tag_by_tag`'s job, one dimension over.
CREATE INDEX `work_item_service_by_service` ON `work_item_service` (`service_id`);
--> statement-breakpoint
-- The seed. Idempotent by the primary key rather than by `INSERT OR IGNORE`: the
-- table is created two statements above and cannot already hold a pair, and a
-- silent ignore would hide a seed that ran against rows it did not expect.
INSERT INTO `work_item_service` (`work_item_id`, `service_id`)
SELECT `id`, `service_id` FROM `work_item` WHERE `service_id` IS NOT NULL;
