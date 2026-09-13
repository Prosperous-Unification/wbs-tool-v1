-- Reverses 20260807090000_add_revisions.
--
-- Dropping these loses every count of how many times a work item or a project
-- has been written to. Nothing about the plan itself goes — the rows, their
-- estimates, dependencies, dates and assignees all survive — but the one fact
-- that lets a later write say "only if nothing has changed since I read it"
-- does, and it cannot be recomputed: nothing else records that a write
-- happened. A reader that held revision 7 and comes back to a column that
-- starts again at 0 would be told nothing had changed, which is the failure
-- this column exists to prevent. That is why this runs solely when the release
-- that added it is being taken away.
ALTER TABLE `project` DROP COLUMN `revision`;--> statement-breakpoint
ALTER TABLE `work_item` DROP COLUMN `revision`;
