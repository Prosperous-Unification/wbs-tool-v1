-- Reverses 20260903190000_add_saved_plan.
--
-- **This destroys every saved plan, and the loss is total.** The product calls
-- these records permanent: they are copied by value precisely so that nothing
-- else in the database can restate them, so there is nowhere to rebuild one
-- from. `plan_event` is a log of commands, pruned at 365 days, and replaying it
-- would reimplement every command's inverse; the live plan is the *current*
-- plan and re-deriving dates from it restates history, which is the whole
-- reason this feature exists. Rolling back past this migration is a data-loss
-- decision.
--
-- That cost is acceptable only while the feature is new and nobody has saved a
-- plan they rely on. Once it is in real use this stops being a routine
-- rollback, and the release that eventually retires these tables owes an export
-- first. `openspec/changes/saved-plans/design.md`, "Deletion and blue/green".
--
-- **No date moves, either way.** The scheduler reads work items, estimates,
-- dependencies, capacity and the calendar; it does not read either of these
-- tables, and nothing writes to those tables on their behalf. A plan scheduled
-- against a database with these tables and the same plan after this rollback
-- come out identical.
--
-- Bodies before headers, so the drop order does not lean on the cascade it is
-- removing. All three statements run solely when the release that added them is
-- being taken away — a forward migration here is additive so blue and green can
-- share one file mid-swap, and reversing an additive change is destructive by
-- definition, which is why it lives here and not there.
DROP TABLE IF EXISTS `saved_plan_body`;--> statement-breakpoint
DROP INDEX IF EXISTS `saved_plan_project_time`;--> statement-breakpoint
DROP TABLE IF EXISTS `saved_plan`;
