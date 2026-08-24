-- foreign-keys-off-rebuild
-- Refuses to roll back after an OIDC-only account exists: copying a NULL
-- password_hash into users_old fails and rolls this transaction back intact.
CREATE TABLE `users_old` (
  `id` text PRIMARY KEY,
  `username` text NOT NULL,
  `password_hash` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `users_old` (`id`, `username`, `password_hash`, `created_at`)
SELECT `id`, `username`, `password_hash`, `created_at` FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `users_old` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username` ON `users` (`username`);
--> statement-breakpoint
CREATE TEMP TABLE `identity_fk_guard` (`violations` integer CHECK (`violations` = 0));
--> statement-breakpoint
INSERT INTO `identity_fk_guard` SELECT COUNT(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `identity_fk_guard`;
