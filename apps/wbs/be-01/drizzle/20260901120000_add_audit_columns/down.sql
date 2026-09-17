-- Reverses `20260901120000_add_audit_columns`, dropping all 76 columns in the
-- reverse order they were added.
--
-- Destructive by definition, which is why it lives here: the migration lint
-- forbids `DROP COLUMN` in a forward migration and deliberately exempts a down
-- script. Running this loses every attribution recorded since the migration
-- landed — there is nowhere else that fact is kept.
ALTER TABLE `dependency` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `dependency` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `dependency` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `assignment` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `assignment` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `assignment` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `person_team` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `person_team` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `person_team` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `person` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `person` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `person` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `project_priority_band` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `project_priority_band` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `project_priority_band` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `project_team_capacity` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `project_team_capacity` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `project_team_capacity` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `work_item_service` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `work_item_service` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `work_item_service` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `team_service` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `team_service` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `team_service` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `service` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `service` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `service` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `work_item_external_ref` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `work_item_external_ref` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `work_item_external_ref` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `work_item_work_item_type` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `work_item_work_item_type` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `work_item_work_item_type` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `external_system` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `external_system` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `external_system` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `work_item_type` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `work_item_type` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `work_item_type` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `work_item_tag` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `work_item_tag` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `work_item_tag` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `tag` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `tag` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `tag` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `work_item_team` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `work_item_team` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `work_item_team` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `service_team` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `service_team` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `service_team` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `step_measure` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `step_measure` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `step_measure` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `step_progress` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `step_progress` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `step_progress` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `actual` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `actual` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `actual` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `estimate` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `estimate` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `estimate` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `step` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `step` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `step` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `work_item` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `work_item` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `work_item` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `project_access` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `project_access` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `project_access` DROP COLUMN `created_at`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `created_by`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `updated_at`;
