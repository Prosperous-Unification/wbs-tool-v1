-- Reverses 20260806160000_add_project_access.
--
-- Dropping this loses every account's "when did I last open this", so the
-- picker falls back to creation order for everybody. No planning data is in
-- here — it is navigation history — which is why this script is safe to run
-- when the release that created the rows is being taken away.
DROP TABLE IF EXISTS `project_access`;
