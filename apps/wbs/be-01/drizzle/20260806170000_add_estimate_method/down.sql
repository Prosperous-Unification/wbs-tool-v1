-- Reverses 20260806170000_add_estimate_method.
--
-- Dropping the column returns every project to PERT, which is the default the
-- forward migration gave them: a project that had chosen `pessimistic` plans
-- on a different number afterwards, and nothing records that it ever chose.
-- That is why this runs only when the release that added the column is being
-- taken away.
--
-- SQLite has supported DROP COLUMN since 3.35 and bun:sqlite is well past it.
ALTER TABLE `project` DROP COLUMN `estimate_method`;
