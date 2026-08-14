-- Reverses 20260814090000_add_resource_sets.
--
-- Cheaper to reverse than most, and the reason is the mirror: while this release
-- runs, every write that changes a work item's team writes **both**
-- `work_item_team` and `work_item.service_team_id`. So the release that comes
-- back reads a column that is still exactly in step with the set being dropped,
-- and no label is lost.
--
-- The one thing that is lost is anything only the set could hold — a work item
-- naming two teams. This release writes none, and refuses to read one
-- (`PluralMembershipError`), so on the deployment this reverses there are none
-- to lose. Once R2-4 lets a second team be written, dropping this table stops
-- being reversible in that sense and the rollback window closes; that is stated
-- in R2-4's own change, not smuggled in here.
--
-- `service` and `work_item_service` go with it, and take every service anybody
-- created. In this release that is nothing at all: no route creates one. From
-- R2-5 it is real data, which is why R2-5 ships its own migration rather than
-- widening this one.
--
-- Order: the join tables before the directory they reference, or the drop hits
-- the foreign key it declared. `migrate-down-cli.ts --to=<name>` walks the
-- applied set in reverse, so this file's own statements are the only ordering
-- decision left here.
DROP TABLE IF EXISTS `work_item_service`;
--> statement-breakpoint
DROP TABLE IF EXISTS `service`;
--> statement-breakpoint
DROP TABLE IF EXISTS `work_item_team`;
