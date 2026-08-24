-- An external solution may name one plan by a stable slug and retain its own URL.
-- Both columns are nullable so every existing plan remains standalone after the
-- additive migration; the application writes and reads them as one nullable pair.
ALTER TABLE `project` ADD `solution_slug` text;
--> statement-breakpoint
ALTER TABLE `project` ADD `solution_url` text;
--> statement-breakpoint
-- One solution resolves to at most one plan. SQLite permits multiple NULLs, so
-- standalone plans do not collide with each other.
CREATE UNIQUE INDEX `project_solution_slug` ON `project` (`solution_slug`);
