-- Reverses 20260811100000_add_priority.
--
-- Dropping this loses every prioritising anybody set, and it cannot be recomputed:
-- the release that comes back levels by the critical path and the row number
-- alone, so two work items competing for one person go back to whichever of
-- them the plan reads first. Nothing else in the plan goes — the work items,
-- their estimates, their dependencies and their dates all survive — which is
-- why this runs only when the release that added the column is being taken
-- away.
ALTER TABLE `work_item` DROP COLUMN `priority`;
