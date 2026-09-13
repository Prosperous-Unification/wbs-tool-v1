CREATE TABLE `service_team` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_team_name` ON `service_team` (`name`);--> statement-breakpoint
CREATE TABLE `person` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_name` ON `person` (`name`);--> statement-breakpoint
CREATE TABLE `person_team` (
	`person_id` text NOT NULL,
	`service_team_id` text NOT NULL,
	PRIMARY KEY(`person_id`, `service_team_id`),
	CONSTRAINT `fk_person_team_person_id_person_id_fk` FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_person_team_service_team_id_service_team_id_fk` FOREIGN KEY (`service_team_id`) REFERENCES `service_team`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `assignment` (
	`work_item_id` text NOT NULL,
	`role_id` text NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`work_item_id`, `role_id`),
	CONSTRAINT `fk_assignment_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_assignment_role_id_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_assignment_person_id_person_id_fk` FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `work_item` ADD `service_team_id` text REFERENCES `service_team`(`id`);
