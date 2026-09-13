CREATE TABLE `project_access` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`last_opened_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	CONSTRAINT `fk_project_access_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_project_access_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`)
);
