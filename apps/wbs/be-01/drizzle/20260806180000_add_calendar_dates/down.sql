-- Reverses 20260806180000_add_calendar_dates.
--
-- Dropping these loses the project's start date and every manual "start no
-- earlier than" anyone set, so the plan returns to whole-day offsets from an
-- unnamed day zero. The work items, their estimates and their dependencies all
-- survive — only the calendar does not — which is why this runs solely when
-- the release that added the columns is being taken away.
ALTER TABLE `work_item` DROP COLUMN `start_no_earlier_than`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `start_date`;
