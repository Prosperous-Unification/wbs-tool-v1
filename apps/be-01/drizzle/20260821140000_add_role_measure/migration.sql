-- What one role's work on one work item cost, in a unit that is not days.
--
-- Dany, 2026-08-20: "estimate token use and then record fact token use for each
-- task (even each phase/role) … then how many hours was spent on a task". The
-- plan measures work in days and assigns it to people, and both are wrong at the
-- edges now: some rows are executed by agents, whose effort is a number of
-- tokens rather than a day of somebody's attention, and whose cost is knowable
-- to the digit rather than guessed.
--
-- **One table with a `metric` discriminator, not three tables.** Three figures
-- arrive together — `token_estimate`, `token_actual`, `hours_actual` — and all
-- three are the same sentence about the same pair. Written as three tables they
-- would each need the five-method repository, the PUT/DELETE pair, the
-- `rolled_up` and `unknown_role` refusals, two journalled commands, the roll-up
-- fold, the hand-down/hand-up/restore/no-copy structure rules and the
-- role-removal count: seven mechanisms times three, twenty-one copies that can
-- drift from their siblings in silence. `token-tracking/design.md` D1.
--
-- **The obvious objection is that `estimate` and `actual` are already two
-- tables, and it does not carry over.** That split exists because folding an
-- actual into `estimate` would have made it a fourth column on the same row, and
-- `estimate`'s three columns are NOT NULL, so recording a real actual would have
-- forced a made-up trio beside it. Here the figures are separate **rows**. The
-- rule that argument was protecting survives exactly, because the primary key
-- carries `metric`: absence is **per metric**, and a pair holding an hours
-- figure is still absent from every token figure. A wide three-column table
-- would have needed nullable columns and then a ruling on whether NULL and "no
-- row" mean different things.
--
-- **`actual` is not folded in here.** It is the obvious fourth tenant and it is
-- deliberately left alone: it holds live rows on dev and prod, so folding it is
-- a data migration plus a rewrite of a shipped, journalled, tested write path,
-- and doing that inside the change that adds three untested figures makes the
-- two sets of failure modes indistinguishable.
--
-- **Reporting only, exactly as `actual` and `role_progress` are.** Nothing below
-- `slicesOf` reads this table: `service/schedule.ts` and `libs/domain` have an
-- empty diff in the change that adds it. A token fact is not evidence about a
-- date — a row that burned four million tokens may be finished or may still be
-- going, and `role_progress`, the model's only completion state, is silent about
-- tokens. Substituting one reading for the other moves every successor's dates
-- on a claim nobody made.
--
-- **One number per figure, never a trio.** A days estimate is three numbers
-- because a weighted final falls out of them and the scheduler consumes it.
-- Nothing consumes these, so a range would be three numbers no code folds, and a
-- reader asked to say which of the three a variance is against. D2.
--
-- **Hours are recorded, never derived.** No tokens-to-hours or days-to-hours
-- conversion exists here, because neither is a fact about the world: an agent's
-- tokens buy no hours of anybody's attention, and a day in this plan is a
-- capacity unit rather than eight hours of one person. D5.
--
-- **`metric` is CHECKed rather than trusted.** Drizzle's enum is compile-time
-- only, and this column is the closed set the whole design rests on: a fourth
-- value written by a hand-edit or a stale release would be dispatched on by
-- every reader and folded by none of them — the argument `role_progress.state`
-- already makes. The check is safe across a blue/green swap because the outgoing
-- release does not know this table exists and never writes to it.
--
-- **Stamped 20260821140000, later than every folder on disk.** Checked before
-- this folder existed — `ls apps/be-01/drizzle | sed 's/_.*//' | sort | uniq -d`
-- silent — and checked mechanically by `duplicateMigrationStamps` in
-- `migrate-down.ts`, which throws where the folders are read. It was also
-- stamped past the two folders `change/service-split` adds
-- (`20260821000000_add_service`, `20260821080000_add_work_item_service`) while
-- that branch was still in review, on the expectation that it would merge first:
-- a stamp that sorted before them would apply out of order on any database that
-- took that release. It did merge first, at `04d644e`, and this branch was
-- rebased onto it — so both folders now sit below this one on disk, and the
-- `uniq -d` above was re-run at the rebased head. Two migrations shared
-- `20260814100000` on 2026-08-14 and `migrationsToRollback` filters on a strict
-- `created_at >`, so rolling back *to* either of the pair reversed nothing at
-- all, silently, with both tables still standing.
--
-- **`work_item_id` cascades, `role_id` deliberately does not** — the asymmetry
-- `estimate`, `actual` and `role_progress` all carry. A measure is somebody's
-- typing, so a role removal must *count* it before taking it: the missing
-- cascade makes a role delete that forgot to say so fail loudly instead of
-- quietly dropping what an agent's run cost. `RoleRepository.remove` deletes
-- these rows explicitly inside the transaction that removes the role. The
-- cascade on `work_item_id` is the blue/green swap window rather than tidiness:
-- two be-01 processes share one SQLite file while green migrates, and the
-- outgoing release's plain `DELETE FROM work_item` would hit a constraint it
-- cannot see and answer 500 for the length of the swap.
--
-- `recorded_at` is when the number was typed, and a correction carries the
-- moment the correction was typed rather than the moment the figure it replaced
-- was.
--
-- No seeding, and nothing to seed: no plan on the server has ever recorded what
-- its work cost in tokens or hours, and inventing a figure would be the tool
-- asserting somebody else's spend. Every plan starts this table empty, which
-- reads as "nobody has said" and not as "it cost nothing".
CREATE TABLE `role_measure` (
	`work_item_id` text NOT NULL,
	`role_id` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`work_item_id`, `role_id`, `metric`),
	CONSTRAINT `fk_role_measure_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_role_measure_role_id_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`id`),
	CONSTRAINT `role_measure_metric` CHECK (`metric` IN ('token_estimate', 'token_actual', 'hours_actual'))
);
--> statement-breakpoint
-- Every measure of one role, which is the one question the primary key cannot
-- answer: it leads with the work item, so "what would removing this role take
-- with it" would otherwise be a scan of the table. `RoleRepository.remove` asks
-- it on every removal and the role dialog asks it before every confirmation —
-- the same question `actual_by_role` and `role_progress_by_role` exist for.
CREATE INDEX `role_measure_by_role` ON `role_measure` (`role_id`);
