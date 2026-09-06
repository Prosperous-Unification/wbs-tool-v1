# Design

DirectoryStore adds assignmentsInProject(projectId), returning assignments with a deduplicated id/name list from the same joined SQLite statement, and assignmentsFor(workItemId) for indexed single-row reads. The existing subset method delegates to those bounded single-row reads; it never builds an arbitrarily large IN list or scans global assignments. Tree reads call the project projection; assignment writes call the single-row method.

The project join uses work_item_project_id_id, assignment's composite primary key, and person's primary key. No index migration is needed. The memory fixture receives a deferred project work-item reader to model the same scope without making up project ownership.

The query oracle records statements issued by the real repository while WorkItemService.tree/assign runs. On a migrated SQLite database it executes those captured SELECTs to count actual materialized rows and EXPLAIN QUERY PLAN to reject full assignment/person scans. Unrelated projects carry distinct assignments and people, so restoring either global read breaches the independent one-row budget.
