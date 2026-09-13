-- Reverses 20260426171432_talented_smiling_tiger.
--
-- Statements are in the opposite order to the forward migration: the index
-- goes before the table it indexes, and each table is dropped after anything
-- that references it. IF EXISTS throughout, because a rollback may be running
-- against a database where the forward migration failed partway.
DROP INDEX IF EXISTS `event_log_sub_seq`;
--> statement-breakpoint
DROP TABLE IF EXISTS `examples`;
--> statement-breakpoint
DROP TABLE IF EXISTS `event_sequencer`;
--> statement-breakpoint
DROP TABLE IF EXISTS `event_log`;
