## 1. The table, and the migration that adds it

- [x] 1.1 `roleMeasure` in `schema.ts`: `(work_item_id, role_id, metric)` primary
      key, `value` and `recorded_at` `NOT NULL`, `work_item_id` cascading and
      `role_id` deliberately not, `metric` a Drizzle enum **and** a `CHECK` on
      the closed set — the pair `role_progress.state` already uses, because
      Drizzle's enum is erased at runtime. The JSDoc says what absence means per
      metric, and what the table is **not**: not a column on `estimate`, not a
      number any scheduler reads, not the home of `actual.days` yet (design D1).
- [x] 1.2 `drizzle/20260821140000_add_role_measure/{migration,down}.sql`. **Stamp
      checked against every folder on disk first**, including the two
      `change/service-split` adds (`20260821000000_add_service`,
      `20260821080000_add_work_item_service`) since that branch is in review and
      merges first, and against `duplicateMigrationStamps`.
- [x] 1.3 `migrate.test.ts`, six cases: the table arrives empty, the outgoing
      release can still delete a work item, a role still holding a measure cannot
      be deleted, a second row for one `(pair, metric)` is refused, a **fourth
      metric value is refused by the CHECK**, and the rollback takes the measures
      and leaves every estimate and actual. **Negatives:** the cascade struck
      from `work_item_id`; a cascade _added_ to `role_id`; the `CHECK` dropped
      from the table and a `metric` of `'nonsense'` inserted — verify.md F1–F3.
- [x] 1.4 The rollback ordering lists in `migrate.test.ts` and
      `migrate-down.test.ts` gain the new stamp, newest first, and
      `does nothing when the target is already the newest applied` names it.

## 2. `person.kind`

- [x] 2.1 `kind` on `person` in `schema.ts`: `text NOT NULL DEFAULT 'person'`,
      Drizzle enum `person | agent`, `CHECK` on the same set. JSDoc carries D6 —
      why a column, why not a boolean, and that the default is a claim about a
      directory that predates agents rather than an invented fact.
- [x] 2.2 `drizzle/20260821150000_add_person_kind/{migration,down}.sql`.
      **This item's premise was wrong and the correction is the finding of the
      chunk that did it.** It read: SQLite cannot `ALTER TABLE … ADD
      CONSTRAINT`, so the `CHECK` arrives by table rebuild — new table, copy,
      drop, rename, indexes recreated. The first clause is true; the conclusion
      does not follow. The restriction is on `ADD CONSTRAINT`, and a
      *column-level* `CHECK` inside `ADD COLUMN` is not on SQLite's list of
      what that clause may not carry. Probed on h2puni against bun's SQLite
      3.53.0 before a line was written: the column backfills, `'robot'` is
      refused with `CHECK constraint failed: kind`, the two-column insert takes
      the default, `person_name` is untouched.
      **And the rebuild would not merely have been unnecessary — it deletes
      data here.** This repo migrates with `PRAGMA foreign_keys = ON`
      (`assertPragmas` in `db.ts` sets it and verifies it was adopted), so the
      rebuild's `DROP TABLE person` cascades: the same probe ended with the
      person copied across and `person_team` and `assignment` **empty**. The
      SQLite manual's rebuild recipe opens by turning foreign keys off, and
      that escape is unavailable — `PRAGMA foreign_keys` is a no-op inside a
      transaction and drizzle wraps each migration in one, confirmed by probe.
      So: `ALTER TABLE person ADD COLUMN` with a column-level `CHECK`, and
      `DROP COLUMN` on the way down (3.53.0 drops a column a `CHECK` names and
      takes the constraint with it, restoring the original DDL byte for byte —
      asserted, not trusted). **Backward-compatible for the blue/green window:**
      the outgoing release's `INSERT INTO person (id, name)` must still succeed,
      which is exactly what the `DEFAULT` buys.
- [x] 2.3 `migrate.test.ts`: every existing person reads back `person` after the
      migration, `person_name`'s unique index survives the rebuild, an insert
      naming no `kind` still works, an insert naming `'robot'` is refused, and
      the rollback drops the column and keeps every person and team membership.
      **Negatives:** the `CHECK` dropped (F4); and, since 2.2's rebuild never
      happened, F5 became the stronger fault — the migration rewritten *as* the
      rebuild, which reddens the membership-and-assignment counts exactly as the
      probe predicted. verify.md F4–F5.
- [x] 2.4 Unplanned, and landed here because 2.1 caused it: `Person` in
      `repository/index.ts` declares `kind?`. `DirectoryRepository` spreads the
      Drizzle row, so the column reached the API response the moment it existed
      — nine assertions across the service and controller suites said so — and a
      type that denied it would be a lie TypeScript cannot catch, since excess
      properties survive a spread. Optional rather than required, with the
      narrowing left to section 3: making it required needs a separate insert
      input type and `addPerson`'s signature, which is store work.

## 3. The store

- [ ] 3.1 `RoleMeasureRepository`, the five methods `EstimateRepository` and
      `ActualRepository` have, in the same order, each taking `metric` as a
      parameter with **no default** (design D1's stated cost), each write bumping
      the work item's revision in its own transaction.
- [ ] 3.2 `moveAll` bumps **only when a row moved**, `changes()` inside the
      transaction — the conditional `actual-days` 2.2 established, for the same
      reason: it runs on every create that gives a leaf its first child and
      almost no plan holds measures. **Negative:** bumped unconditionally,
      watched — verify.md F6.
- [ ] 3.3 `repository/role-measure.test.ts` against real SQLite: the
      replace-and-restamp, all three parts of the delete's key, the idempotent
      remove, a stored zero, **two metrics on one pair independent of each
      other**, project isolation, the revision bumps, the conditional bump, the
      work-item cascade and the role's refusal.

## 4. The write path

- [ ] 4.1 `WorkItemService.setMeasure` / `clearMeasure`, cloned from the actual
      pair: `rolled_up`, `unknown_role`, `not_found`, `forbidden`, idempotent
      clear, and the clear of nothing recording nothing. `unknown_metric` is the
      one new refusal — a metric outside the closed set is a 404, not a 400,
      because it names a thing that does not exist.
- [ ] 4.2 Journalled through `record` as `set_measure` / `clear_measure`;
      `CompensatingCommand`, `COMMANDS`, `touchedBy`, `subjectOf` and `apply`
      all carry the metric. The inverse of a **first** recording is
      `clear_measure`, never `set_measure 0`. **Negative:** verify.md F7.
- [ ] 4.3 `PUT` / `DELETE /work-items/:id/measures/:metric/:roleId`, hand-parsed
      body, `invalid_measure` for anything not a finite number at or above zero,
      and the OpenAPI document regenerated.
- [ ] 4.4 `PATCH /people/:id` accepts `kind`, refusing anything outside the set
      as `invalid_kind` (400). Journalled beside the rename the directory already
      journals, so a mis-marking is undoable.

## 5. The roll-up and the payload

- [ ] 5.1 `foldByRole` in `roll-up.ts` gains a third caller rather than a third
      copy — `rollUpMeasures(metric)`, one recursion, generic over the figure.
- [ ] 5.2 `measures` on every work item in `tree()`: keyed by metric then role,
      its own if a leaf, the sum of its descendants' otherwise, and a metric
      nobody recorded **absent** rather than an empty object.
- [ ] 5.3 The identity oracles lift the new key and **assert it empty** rather
      than dropping it — the shape `team-sets` established for a payload that
      gained a field. **Negative:** verify.md F8.
- [ ] 5.4 `kind` on every person in the directory payload.

## 6. The structure

- [ ] 6.1 Hand-down on a first child, hand-up on a last child's deletion, restore
      with a branch, **no copy** into a duplicate — a token fact belongs to the
      work that was actually done, and a duplicate is work that has not been.
- [ ] 6.2 `setMeasures`, `measures` and `removedMeasures` on the subtree commands,
      written and unwound in `SubtreeRepository`'s one transaction.
      **Negatives:** verify.md F9 and F10.
- [ ] 6.3 `RoleRepository.remove` counts measures, refuses an unconfirmed removal
      that would take one, and deletes them explicitly inside its transaction.
      **Negative:** verify.md F11.

## 7. The directory card

- [ ] 7.1 A person/agent control in the directory card (fe-01), reading `kind`
      from the payload and writing it through 4.4. Existing people render as
      `person` without a request.
- [ ] 7.2 Component tests: the control shows the stored kind, a change round-trips,
      and a failed write leaves the displayed kind unchanged rather than
      optimistically wrong.

## 8. The record

- [ ] 8.1 `proposal.md`, `design.md` (seven decisions), this file, and the spec
      delta. **Done in chunk 1.**
- [ ] 8.2 `verify.md`: both stamps and their collision check, up and down through
      the real CLIs on h2puni, the full gate with the bun version, the F1–F11
      fault table, and the **empty diff on `service/schedule.ts` and
      `libs/domain/**`** quoted from `git diff --stat` as a claim that was
      checked rather than asserted.
