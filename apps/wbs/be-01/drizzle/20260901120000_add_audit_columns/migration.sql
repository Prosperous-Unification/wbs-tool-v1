-- Audit columns: every stored record gains `created_at`, `updated_at` and
-- `created_by`. 76 columns across the 26 tables that hold a domain record.
--
-- Nullable, with no default, and that is the design rather than a concession.
-- Forward migrations here stay additive because blue and green share one SQLite
-- file across a swap, so `ADD COLUMN ... NOT NULL` with no default is refused by
-- SQLite on a populated table outright — and a default would be worse than
-- refused: it would stamp every row written before today with an author who did
-- not write it. A row's instant is guessable and its author is not, so both stay
-- null and the row types say so. Nothing backfills these, and no later migration
-- tightens them: the author of a row written in August 2026 is unknowable rather
-- than unknown-for-now.
--
-- `created_by` carries a plain `REFERENCES users(id)` — no `ON DELETE`, so
-- SQLite's default `NO ACTION` applies and a user with authored rows cannot be
-- deleted out from under them. That is the same choice `project.owner_id` and
-- `project_access.user_id` already make, and the opposite of the cascade the two
-- journals use: a journal entry is about an act and goes when its actor does,
-- while a work item outlives whoever typed it.
--
-- Five tables are absent on purpose. `event_log`, `command_journal` and
-- `plan_event` record an **act** rather than a record: each already carries the
-- acting user and the instant, nothing ever updates them, and a `created_by`
-- beside their `user_id` would be two columns for one fact. `event_sequencer`
-- holds one counter row. `examples` is scaffold.
--
-- `users` and `project` gain only two columns each: their `NOT NULL`
-- `created_at` predates this and stays theirs, so nothing here weakens a
-- constraint the database already enforces.
ALTER TABLE `users` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `project` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `project` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `project_access` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `project_access` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `project_access` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `work_item` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `work_item` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `work_item` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `step` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `step` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `step` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `estimate` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `estimate` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `estimate` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `actual` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `actual` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `actual` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `step_progress` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `step_progress` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `step_progress` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `step_measure` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `step_measure` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `step_measure` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `service_team` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `service_team` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `service_team` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `work_item_team` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_team` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_team` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `tag` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `tag` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `tag` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `work_item_tag` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_tag` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_tag` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `work_item_type` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_type` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_type` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `external_system` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `external_system` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `external_system` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `work_item_work_item_type` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_work_item_type` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_work_item_type` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `work_item_external_ref` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_external_ref` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_external_ref` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `service` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `service` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `service` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `team_service` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `team_service` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `team_service` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `work_item_service` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_service` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `work_item_service` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `project_team_capacity` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `project_team_capacity` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `project_team_capacity` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `project_priority_band` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `project_priority_band` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `project_priority_band` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `person` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `person` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `person` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `person_team` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `person_team` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `person_team` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `assignment` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `assignment` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `assignment` ADD `created_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `dependency` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `dependency` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `dependency` ADD `created_by` text REFERENCES `users`(`id`);
