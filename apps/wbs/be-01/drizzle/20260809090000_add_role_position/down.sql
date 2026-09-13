-- Reverses 20260809090000_add_role_position.
--
-- Dropping this loses the only record of what order a project works its roles
-- in. It cannot be recomputed: the release that comes back reads the roles in
-- whatever order SQLite hands them over, which is name order, and a project
-- that had put `Review` after `Dev` gets it back in front. Nothing else in the
-- plan goes — the roles, their estimates and their assignments all survive —
-- which is why this runs only when the colour that added the column is being
-- taken away.
ALTER TABLE `role` DROP COLUMN `position`;
