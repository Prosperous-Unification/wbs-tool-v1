-- foreign-keys-off-rebuild
-- migration-lint: compatible-table-rebuild
-- SQLite cannot remove password_hash's NOT NULL constraint in place. The
-- runner sees the marker above, disables FK actions before Drizzle opens its
-- transaction, and this script proves the rebuilt graph is valid before that
-- transaction may commit. Without that protocol, DROP TABLE users cascades
-- every dependent project away.
CREATE TABLE `users_new` (
  `id` text PRIMARY KEY,
  `username` text NOT NULL,
  `password_hash` text,
  `email` text,
  `idp_issuer` text,
  `idp_sub` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `users_new` (`id`, `username`, `password_hash`, `created_at`)
SELECT `id`, `username`, `password_hash`, `created_at` FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `users_new` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username` ON `users` (`username`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_normalized` ON `users` (lower(`email`));
--> statement-breakpoint
CREATE UNIQUE INDEX `users_idp_identity` ON `users` (`idp_issuer`, `idp_sub`);
--> statement-breakpoint
CREATE TEMP TABLE `identity_fk_guard` (`violations` integer CHECK (`violations` = 0));
--> statement-breakpoint
INSERT INTO `identity_fk_guard` SELECT COUNT(*) FROM pragma_foreign_key_check;
