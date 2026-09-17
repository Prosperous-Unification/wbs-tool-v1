CREATE TABLE `command_journal` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`inverse` text NOT NULL,
	`preconditions` text NOT NULL,
	`undone` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_command_journal_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_command_journal_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `command_journal_stack` ON `command_journal` (`project_id`,`user_id`,`seq`);
