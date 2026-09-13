CREATE TABLE `dependency` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`predecessor_id` text NOT NULL,
	`successor_id` text NOT NULL,
	CONSTRAINT `fk_dependency_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`),
	CONSTRAINT `fk_dependency_predecessor_id_work_item_id_fk` FOREIGN KEY (`predecessor_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_dependency_successor_id_work_item_id_fk` FOREIGN KEY (`successor_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `dependency_project` ON `dependency` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_pair` ON `dependency` (`predecessor_id`,`successor_id`);