-- Reverses `20260906003000_add_work_item_read_order_index`.
--
-- Nothing reads this index by name, so a rollback costs a query plan and no
-- rows: the ordered select goes back to the indexed lookup plus temp B-tree
-- measured in `migration.sql`. The `ORDER BY` itself is in application code
-- and is not undone here — the contract survives the rollback, more slowly.
DROP INDEX `work_item_project_id_id`;
