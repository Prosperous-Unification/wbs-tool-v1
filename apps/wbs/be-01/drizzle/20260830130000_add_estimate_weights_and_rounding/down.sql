-- Reverses 20260830130000_add_estimate_weights_and_rounding.
--
-- Dropping the columns returns every project to 1/4/1 and to the fractional
-- days this release replaced, and nothing records that a project ever chose
-- otherwise: a team planning on a plain average goes back to PERT silently.
-- That is why this runs only when the release that added them is being taken
-- away.
--
-- SQLite has supported DROP COLUMN since 3.35 and bun:sqlite is well past it.
ALTER TABLE `project` DROP COLUMN `pert_weight_optimistic`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `pert_weight_realistic`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `pert_weight_pessimistic`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `estimate_rounding`;
