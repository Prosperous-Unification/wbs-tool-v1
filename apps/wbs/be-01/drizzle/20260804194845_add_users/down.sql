-- Reverses 20260804194845_add_users.
--
-- Dropping `users` destroys every registered account. That is the correct
-- behaviour for this script and the reason it only ever runs on a failed
-- deploy: the release that created those rows is the one being taken away.
DROP INDEX IF EXISTS `users_username`;
--> statement-breakpoint
DROP TABLE IF EXISTS `users`;
