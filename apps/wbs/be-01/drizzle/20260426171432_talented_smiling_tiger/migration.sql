CREATE TABLE `event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`subscription` text NOT NULL,
	`seq` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_sequencer` (
	`subscription` text PRIMARY KEY,
	`next_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `examples` (
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_log_sub_seq` ON `event_log` (`subscription`,`seq`);