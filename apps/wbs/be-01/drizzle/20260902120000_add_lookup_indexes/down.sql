-- Reverses `20260902120000_add_lookup_indexes`, dropping the four indexes it
-- created and leaving the three it only declared.
--
-- Nothing reads through these by name, so a rollback costs query plans and no
-- rows: the clauses go back to the scans measured in `migration.sql`.
DROP INDEX `dependency_by_successor`;--> statement-breakpoint
DROP INDEX `assignment_by_step`;--> statement-breakpoint
DROP INDEX `assignment_by_person`;--> statement-breakpoint
DROP INDEX `estimate_by_step`;
