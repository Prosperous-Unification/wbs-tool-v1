-- Four indexes for four `WHERE` clauses that were measured scanning.
--
-- Additive, which is what blue/green needs: `CREATE INDEX` adds a structure the
-- outgoing release never reads and the incoming one does, so both colours run
-- against this file happily during a swap.
--
-- Measured on a freshly migrated database with `EXPLAIN QUERY PLAN`, 2026-09-02:
--
--   assignment by person      SCAN assignment
--   assignment by step        SCAN assignment
--   estimate by step          SCAN estimate
--   dependency by successor   SCAN dependency
--
-- and, as the control that says the read is the problem rather than the table,
-- two clauses on the same tables that already resolve:
--
--   dependency by predecessor SEARCH … USING INDEX dependency_pair
--   assignment by work item   SEARCH … USING INDEX sqlite_autoindex_assignment_1
--
-- `step_id` and `person_id` are not prefixes of their tables' primary keys,
-- which is why the implicit index does nothing for them. `dependency_pair` is
-- `(predecessor_id, successor_id)`, so it answers one direction and not the
-- other — and the subtree delete reads the direction it does not answer, once
-- per work item.
--
-- Three more indexes were declared in `schema.ts` in the same change and are
-- deliberately absent here: `actual_by_step`, `step_progress_by_step` and
-- `step_measure_by_step` already exist, created by
-- `20260831120000_rename_role_to_step` and never written back into the schema.
-- They needed the declaration, not the statement.
CREATE INDEX `estimate_by_step` ON `estimate` (`step_id`);--> statement-breakpoint
CREATE INDEX `assignment_by_person` ON `assignment` (`person_id`);--> statement-breakpoint
CREATE INDEX `assignment_by_step` ON `assignment` (`step_id`);--> statement-breakpoint
CREATE INDEX `dependency_by_successor` ON `dependency` (`successor_id`);
