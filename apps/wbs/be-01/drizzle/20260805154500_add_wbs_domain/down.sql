-- Reverses 20260805154500_add_wbs_domain.
--
-- Dropping these four destroys every project, every work item and every
-- estimate anyone has entered. That is correct for this script and the reason
-- it runs only when the release that created those rows is being taken away.
--
-- `users` is deliberately untouched: accounts predate the domain and survive a
-- failed domain release, so everyone can still log in to an empty tool.
--
-- Order is reverse-dependency. `estimate` references `work_item` and `role`,
-- both reference `project`, and `project` references `users`; dropping a parent
-- first fails while foreign keys are enforced.
DROP INDEX IF EXISTS `work_item_siblings`;
--> statement-breakpoint
DROP INDEX IF EXISTS `role_project_name`;
--> statement-breakpoint
DROP TABLE IF EXISTS `estimate`;
--> statement-breakpoint
DROP TABLE IF EXISTS `work_item`;
--> statement-breakpoint
DROP TABLE IF EXISTS `role`;
--> statement-breakpoint
DROP TABLE IF EXISTS `project`;
