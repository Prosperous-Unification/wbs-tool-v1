-- Where the work a row stands for also exists: a Jira issue, a GitHub PR, a
-- Confluence page, a Slack thread.
--
-- Until this migration the only place to put that was the name or the notes,
-- where nothing can find it, nothing can follow it, and a reader scanning the
-- plan cannot see which rows are wired up at all.
--
-- **A ref is a link and nothing else.** No status, no issue state, no title, and
-- nothing is ever fetched — the change's non-goals rule out reading any external
-- system, and there is deliberately no column here that could hold a cached
-- answer from one. That absence is the model rule: a stale `state` column would
-- make the plan claim something about a Jira issue it has not looked at since.
--
-- **The system vocabulary is a growing list, exactly as `tag` is**: the known
-- systems are seeded below, and naming a new one saves it. That is the bargain
-- `tag` and `work_item_type` already make, and this table is their shape.
--
-- Seeded, and this is the one place this dimension differs from `tag` and
-- `work_item_type`, which are deliberately empty. Those hold somebody else's
-- taxonomy and inventing one would be the tool asserting it. These four are not
-- a taxonomy — they are the systems `systemOfUrl` in `libs/domain` has patterns
-- for, so an unseeded table would mean a pasted GitHub URL derives `github-pr`
-- and then fails to store it. The seed and the pattern list are one fact and
-- must not disagree; `external-system.test.ts` asserts every name the deriver
-- can answer exists here.
--
-- Stamped 20260830020000, later than every folder on main and later than
-- `20260830010000_add_work_item_type`, which is being added the same night in a
-- sibling worktree. Checked with `ls apps/be-01/drizzle | sed 's/_.*//' | sort |
-- uniq -d` across both, and checked mechanically by `duplicateMigrationStamps`
-- in `migrate-down.ts` — two migrations shared `20260814100000` on 2026-08-14,
-- and `migrationsToRollback` filters on a strict `created_at >`, so rolling back
-- *to* either of a colliding pair reversed nothing at all, silently.
--
-- **Additive only.** Blue and green share one SQLite file while green migrates.
CREATE TABLE `external_system` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
-- One spelling per system, and the index a rename reads before it answers
-- `taken` — `tag_name`'s job. Two systems spelled the same are two answers to
-- one question, and here they would also be two answers `systemOfUrl` could
-- derive interchangeably.
CREATE UNIQUE INDEX `external_system_name` ON `external_system` (`name`);--> statement-breakpoint
-- Every external ref one work item carries, in the order they were added.
--
-- **`id` is the primary key, not the pair.** This is where the table stops
-- resembling `work_item_tag` and `work_item_work_item_type`: a labelling is a
-- fact that is either stated or not, so the pair is the key and a repeat is a
-- second answer to one question. A ref is not a labelling — a row may honestly
-- link to two different GitHub PRs, and the pair `(work_item, github-pr)` would
-- refuse the second. What must be unique here is nothing at all; even the same
-- URL twice is a client being untidy rather than a contradiction, and the write
-- path deduplicates by URL rather than the schema refusing it.
--
-- `system_id` is `NOT NULL`: a ref with no system cannot be stored, and the
-- write refuses it as a modeled 4xx rather than writing a row no dot can draw.
-- The derived name is **stored** here through this column and never re-derived
-- on read (design D1) — the deriving rule will change, and deriving on read
-- would silently re-type every existing ref, including ones a reader corrected
-- by hand, with no record that it had happened.
--
-- `position` orders the list as it was built. Ordering by hand is a non-goal, so
-- nothing writes a position but the append.
--
-- `work_item_id` cascades for `work_item_tag`'s reason unchanged: the outgoing
-- release knows nothing about this table and its plain `DELETE FROM work_item`
-- must not hit a constraint it cannot see. `system_id` cascades too, and that is
-- a heavier decision than the tag's — deleting a system takes the **links**
-- with it, not just a label off a row. The route counts first and refuses with
-- 409 unless `?cascade=1`, which is where a reader is told what they are about
-- to lose.
--
-- Proof: `ON DELETE CASCADE` struck from `work_item_id` and `lets the outgoing
-- release keep deleting work items against the migrated schema` fails on that
-- exact statement with `FOREIGN KEY constraint failed`.
CREATE TABLE `work_item_external_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`system_id` text NOT NULL,
	`url` text NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `fk_wier_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_wier_system_id_external_system_id_fk` FOREIGN KEY (`system_id`) REFERENCES `external_system`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- The row's own refs, in order, which is the read every plan load makes.
CREATE INDEX `wier_by_work_item` ON `work_item_external_ref` (`work_item_id`, `position`);--> statement-breakpoint
-- Every ref into one system, which the index above cannot answer: it leads with
-- the work item, so "what would removing this system touch" would be a scan.
CREATE INDEX `wier_by_system` ON `work_item_external_ref` (`system_id`);--> statement-breakpoint
-- The seeded systems, and the whole of what `systemOfUrl` can answer. Ids are
-- fixed rather than random so a re-run of this migration on a second replica
-- produces the same rows — these are vocabulary, not user data, and a ref
-- written against one replica's `github-pr` must resolve on the other's.
INSERT INTO `external_system` (`id`, `name`) VALUES
	('sys-jira-issue', 'jira-issue'),
	('sys-github-pr', 'github-pr'),
	('sys-github-issue', 'github-issue'),
	('sys-confluence-page', 'confluence-page'),
	('sys-slack-message', 'slack-message');
