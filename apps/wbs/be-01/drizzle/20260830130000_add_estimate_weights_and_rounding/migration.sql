-- The arithmetic a project turns its three-point estimates into days with, per
-- project: the three PERT coefficients and the rounding one step's combined
-- figure is charged at.
--
-- The weight defaults are the textbook 1/4/1 every plan was already computed
-- with, so no existing project's PERT figure moves on this column alone. The
-- rounding default is `ceil`, and that one **does** move every existing plan:
-- a step that combined to 2.5 days is charged 3, and a work item's total is the
-- sum of its steps' whole days. That is the intent of
-- `estimate-weights-and-rounding` rather than a migration accident — see
-- `docs/adr/0011-final-days-are-whole-days-rounded-per-step.md`.
--
-- Additive, so the outgoing colour keeps reading `project` while green
-- migrates: it selects the columns it knows and never sees these four.
ALTER TABLE `project` ADD `pert_weight_optimistic` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `pert_weight_realistic` real DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `pert_weight_pessimistic` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `estimate_rounding` text DEFAULT 'ceil' NOT NULL;
