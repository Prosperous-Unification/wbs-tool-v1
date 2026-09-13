ALTER TABLE `work_item` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `revision` integer DEFAULT 0 NOT NULL;
