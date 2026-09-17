-- Reverses 20260806190000_add_teams_and_assignees.
--
-- Dropping these loses every team, every person, who belongs to which team,
-- and every assignment anyone made. The work items, estimates, dependencies
-- and dates all survive — only who is doing the work does not — which is why
-- this runs solely when the release that created those rows is being taken
-- away.
--
-- The work_item column goes last: the assignment rows referencing it are
-- already gone by then.
DROP TABLE IF EXISTS `assignment`;--> statement-breakpoint
DROP TABLE IF EXISTS `person_team`;--> statement-breakpoint
DROP INDEX IF EXISTS `person_name`;--> statement-breakpoint
DROP TABLE IF EXISTS `person`;--> statement-breakpoint
ALTER TABLE `work_item` DROP COLUMN `service_team_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `service_team_name`;--> statement-breakpoint
DROP TABLE IF EXISTS `service_team`;
