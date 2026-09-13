-- Reverses 20260806084828_add_dependencies.
--
-- Dropping this destroys every dependency anyone has drawn. The work items and
-- their estimates survive — only the ordering between them is lost — which is
-- correct for this script and the reason it runs only when the release that
-- created those rows is being taken away.
--
-- The indexes go with the table in SQLite; they are named here anyway so a
-- partially-applied forward migration has something to undo.
DROP INDEX IF EXISTS `dependency_pair`;--> statement-breakpoint
DROP INDEX IF EXISTS `dependency_project`;--> statement-breakpoint
DROP TABLE IF EXISTS `dependency`;
