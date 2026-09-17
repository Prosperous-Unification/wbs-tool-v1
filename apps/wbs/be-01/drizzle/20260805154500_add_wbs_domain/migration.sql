CREATE TABLE `estimate` (
	`work_item_id` text NOT NULL,
	`role_id` text NOT NULL,
	`optimistic` real NOT NULL,
	`realistic` real NOT NULL,
	`pessimistic` real NOT NULL,
	CONSTRAINT `estimate_pk` PRIMARY KEY(`work_item_id`, `role_id`),
	CONSTRAINT `fk_estimate_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`),
	CONSTRAINT `fk_estimate_role_id_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`id`)
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`restricted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_project_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `role` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT `fk_role_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`)
);
--> statement-breakpoint
CREATE TABLE `work_item` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`parent_id` text,
	`position` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`frozen_number` text,
	CONSTRAINT `fk_work_item_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`),
	CONSTRAINT `fk_work_item_parent_id_work_item_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `work_item`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_project_name` ON `role` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `work_item_siblings` ON `work_item` (`project_id`,`parent_id`,`position`);