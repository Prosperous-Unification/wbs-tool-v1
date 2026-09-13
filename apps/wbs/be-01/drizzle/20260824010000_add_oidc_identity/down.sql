-- foreign-keys-off-rebuild
-- The pre-OIDC service requires a password hash. Preserve every identity field
-- outside the legacy schema, then lock passwordless accounts with the same
-- non-guessable Argon2 digest the old login path uses for unknown users. The
-- migrator consumes this recovery state after the forward scripts re-apply.
CREATE TABLE IF NOT EXISTS `oidc_identity_downgrade` (
  `user_id` text PRIMARY KEY,
  `password_was_null` integer NOT NULL CHECK (`password_was_null` IN (0, 1)),
  `email` text,
  `idp_issuer` text,
  `idp_sub` text
);
--> statement-breakpoint
DELETE FROM `oidc_identity_downgrade`;
--> statement-breakpoint
INSERT INTO `oidc_identity_downgrade`
  (`user_id`, `password_was_null`, `email`, `idp_issuer`, `idp_sub`)
SELECT `id`, `password_hash` IS NULL, `email`, `idp_issuer`, `idp_sub`
FROM `users`;
--> statement-breakpoint
CREATE TABLE `users_old` (
  `id` text PRIMARY KEY,
  `username` text NOT NULL,
  `password_hash` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `users_old` (`id`, `username`, `password_hash`, `created_at`)
SELECT
  `id`,
  `username`,
  coalesce(
    `password_hash`,
    '$argon2id$v=19$m=65536,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$0RTS8ZC+9Bfl7Bx4rvGIYYqEs0mfOB5+3H4mPa0BvXk'
  ),
  `created_at`
FROM `users`;
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
