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
      chunk that did it.** It read: SQLite cannot add a constraint to an
      existing table, so the `CHECK` arrives by table rebuild — new table, copy,
      drop, rename, indexes recreated. The first clause is true; the conclusion
      does not follow. The restriction is on `ADD CONSTRAINT`, and a
      _column-level_ `CHECK` inside `ADD COLUMN` is not on SQLite's list of
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
      happened, F5 became the stronger fault — the migration rewritten _as_ the
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
      **Done in chunk 9, after 4.4 rather than in section 3** — `Person.kind` is
      required, `PersonInsert` (`kind?`) is what `DirectoryStore.addPerson` and
      the fixture take, and the fixture applies `DEFAULT 'person'` itself so it
      can no longer hold a row shape SQLite cannot. It found two types that
      claimed a whole person for a two-column projection and were only accepted
      because `kind` was optional: `DirectoryUsageRows.members` (the removal
      confirmation prints who, and `directory-usage.ts` already narrowed it) and
      `WorkItemService`'s `assignedPeople` (whose own doc says "the names, not
      the whole directory"). Both are now typed as what they build. Negatives:
      verify.md F9a and F9b.

## 3. The store

- [x] 3.1 `RoleMeasureRepository`, the **four** methods `EstimateRepository` and
      `ActualRepository` have, in the same order, taking `metric` as a parameter
      on the one method that names a single row and as a field of the record on
      the one that writes it, with **no default** anywhere (design D1's stated
      cost), each write bumping the work item's revision in its own transaction.

      > **Corrected while doing it.** This read _"the five methods"_ and _"each
      > taking `metric` as a parameter"_, and both halves were wrong. There are
      > four — `listByProject`, `set`, `remove`, `moveAll` — in all three
      > repositories; the "five" was copied from `ActualStore`'s own JSDoc, which
      > had said it since the store was written and now says four. And the metric
      > reaches two of them, not four: `remove` names one row so it takes one,
      > `set` carries it in the record, while `listByProject` hands back every
      > metric (5.2's payload folds all three from one read, and three queries
      > could show three different instants of the same plan) and `moveAll` moves
      > every metric (a leaf that gains a child stops holding figures in any
      > unit). D1's _"every read path takes the metric as a parameter"_ is about
      > the fold, `rollUpMeasures(metric)` in 5.1, not the list underneath it.

- [x] 3.2 `moveAll` bumps **only when a row moved**, `changes()` inside the
      transaction — the conditional `actual-days` 2.2 established, for the same
      reason: it runs on every create that gives a leaf its first child and
      almost no plan holds measures. **Negative:** bumped unconditionally,
      watched — verify.md F6.
- [x] 3.3 `repository/role-measure.test.ts` against real SQLite: the
      replace-and-restamp, all three parts of the delete's key, the idempotent
      remove, a stored zero, **two metrics on one pair independent of each
      other**, project isolation, the revision bumps, the conditional bump, the
      work-item cascade and the role's refusal. Eleven cases. The read-order case
      defends its role half and **not** its metric half — verify.md F6c says why
      and why no fault at this layer can make it.

## 4. The write path

- [x] 4.1 `WorkItemService.setMeasure` / `clearMeasure`, cloned from the actual
      pair: `rolled_up`, `unknown_role`, `not_found`, `forbidden`, idempotent
      clear, and the clear of nothing recording nothing. `unknown_metric` is the
      one new refusal — a metric outside the closed set is a 404, not a 400,
      because it names a thing that does not exist.
- [x] 4.2 Journalled through `record` as `set_measure` / `clear_measure`;
      `CompensatingCommand`, `COMMANDS`, `touchedBy`, `subjectOf` and `apply`
      all carry the metric. The inverse of a **first** recording is
      `clear_measure`, never `set_measure 0`. **Negative:** verify.md F7.
- [x] 4.3 `PUT` / `DELETE /work-items/:id/measures/:metric/:roleId`, hand-parsed
      body, `invalid_measure` for anything not a finite number at or above zero,
      and the OpenAPI document regenerated. The body key is **`value`**: the
      unit is in the path, so `tokens` or `hours` would be the same fact twice
      and the two could disagree. `unknown_metric` joins the 404 list in the
      controller's `statusFor`. **Negative:** verify.md F8, F8b.
- [x] 4.4 `PATCH /people/:id` accepts `kind`, refusing anything outside the set
      as `invalid_kind` (400). **Negatives:** verify.md F8c, F8d.

      > **Done 2026-08-21 (chunk 8).** The closed set is checked in
      > `DirectoryService.patchPerson` by `holdsKind`, beside the write and
      > once, so the route's schema takes a `t.String()` rather than a union of
      > the two kinds — a union would have Elysia refuse `'robot'` with its own
      > body and `invalid_kind` would be unreachable through the API that
      > refusal exists for. It is `holdsMetric`'s argument, one entity over.
      >
      > **400 is the only one in this controller**, and it joins
      > `invalid_measure` rather than the 422s beside it: a blank name is a
      > value this directory declines, while a `kind` outside the set is a
      > spelling the API does not have. 404 would claim something was looked
      > up.
      >
      > **Not announced to the broadcaster**, for the membership edit's reason
      > rather than a weaker one: no row in a plan's tree draws a `kind`. It
      > reaches the directory payload (5.4) and the card (7.1), both of which
      > read the directory. The day a badge appears beside an assignee in a
      > tree, `says nothing when a person becomes an agent` is the case that
      > has to change first.

      > **Corrected 2026-08-21 (chunk 7), premise disproved rather than
      > rewritten.** This item read: _"Journalled beside the rename the directory
      > already journals, so a mis-marking is undoable."_ **The directory
      > journals nothing.** `directory.service.ts` contains no call to `record`
      > and no reference to the journal at all; `patchPerson` announces the
      > rename to the broadcaster so open plans reread, which is a different
      > mechanism with a similar shape.
      >
      > It is not an oversight to fix in this change, either. `plan_event`
      > carries `project_id` **`NOT NULL`, `REFERENCES project(id) ON DELETE
      > CASCADE`**, and `WorkItemService.record` takes a `projectId` as its first
      > argument — the journal is a **plan's** history. The directory is global
      > and belongs to no project (`directoryController`'s own comment says so),
      > so journalling a kind change would mean either inventing a project to
      > file it under or making a person's history disappear when some unrelated
      > project is deleted.
      >
      > **So `kind` is undone the way a rename is: by patching it back.** That is
      > the directory's existing contract for every field it holds, and a kind
      > that alone had an undo would be the odd one out in the card it sits in.
      > A journalled directory is a change of its own, with `plan_event`'s
      > project scoping as its first question.

## 5. The roll-up and the payload

- [x] 5.1 `foldByRole` in `roll-up.ts` gains a third caller rather than a third
      copy — `rollUpMeasures(metric)`, one recursion, generic over the figure.
      Landed in chunk 10 at `8868d6d`, eight cases. **One metric per call** is
      the shape the brief's "generic over the figure" turned into: the fold's
      combine adds two numbers, so the numbers reaching it have to be in one
      unit, and filtering by metric before the recursion is what makes that true
      by construction rather than by hoping. Absence stays per metric — a pair
      holding a `token_actual` and nothing else is absent from `hours_actual` —
      and a **recorded** zero is kept and summed, as `rollUpActuals` keeps one.
      **Negatives:** verify.md F10a, F10b.
- [x] 5.2 `measures` on every work item in `tree()`: keyed by metric then role,
      its own if a leaf, the sum of its descendants' otherwise, and a metric
      nobody recorded **absent** rather than an empty object. Landed in chunk 11
      at `7015af5`, seven cases. Built as **one fold per metric over the whole
      project** — a `Map` of metric to `rollUpMeasures`' answer, taken apart per
      row — rather than three folds per row, because the recursion is over the
      tree and the tree does not change between rows. The absence rule is
      enforced by **striking** empty metrics from the object rather than by
      mapping all three and hoping: `hours_actual: {}` on a row says somebody
      looked at the hours and found none, which is a statement nobody made. So a
      row nobody has recorded anything against is `{}` — no metrics at all.
      **Negatives:** verify.md F11a, F11b.
- [x] 5.3 The identity oracles lift the new key and **assert it empty** rather
      than dropping it — the shape `team-sets` established for a payload that
      gained a field. Landed with 5.2, both files. **Negative:** verify.md F11a,
      not F8 as this line originally said — F8 is the controller's 404 list and
      has nothing to do with the corpus; corrected here rather than silently,
      and F11a is the fault that actually reddens these two files (3 of its 10).
      F11b is recorded beside it because it leaves both oracles **green**: the
      corpus proves a change invented nothing and cannot prove the payload
      carries what it was given.
- [x] 5.4 `kind` on every person in the directory payload. Landed with the 2.4
      narrowing in chunk 9, because they are one claim: the payload is
      `listPeople()` spread whole, so the be-01 half needed an assertion rather
      than code. The case is `answers a kind for a person nobody has patched`,
      and it reads both `POST /api/people` and `GET /api/people` — one answers
      the row it wrote, the other re-reads, and a default appearing on only one
      of them would send a client's fallback back into the fe. The OpenAPI
      document is unchanged and was regenerated to prove it: neither route
      schemas its response. **fe-01's `PersonView` still has no `kind`** — that
      is 7.1's, and nothing in fe-01 reads the field yet.

## 6. The structure

- [x] 6.1 Hand-down on a first child, hand-up on a last child's deletion, restore
      with a branch, **no copy** into a duplicate — a token fact belongs to the
      work that was actually done, and a duplicate is work that has not been.
- [x] 6.2 `setMeasures`, `measures` and `removedMeasures` on the subtree commands,
      written and unwound in `SubtreeRepository`'s one transaction.
      **Negatives:** verify.md F9 and F10.
- [x] 6.3 `RoleRepository.remove` counts measures, refuses an unconfirmed removal
      that would take one, and deletes them explicitly inside its transaction.
      **Negative:** verify.md F12a/F12b. _(Written 6.3's negative as "F11"; F11
      is section 5's pair and was already spent — the structure's faults are
      F12. Corrected in place with the original quoted, chunk 13.)_

## 7. The directory card

- [x] 7.1 A person/agent control in the directory card (fe-01), reading `kind`
      from the payload and writing it through 4.4. Existing people render as
      `person` without a request. _(A `<select>` beside the name box, the
      `Plan with` control's gesture for a closed set. `PersonView.kind` is
      **required**: the column is `NOT NULL DEFAULT 'person'`, so "without a
      request" is a fact about the read and not a client-side `?? 'person'`.)_
- [x] 7.2 Component tests: the control shows the stored kind, a change round-trips,
      and a failed write leaves the displayed kind unchanged rather than
      optimistically wrong. _(Four cases. The third is non-vacuous only because
      the page holds **no draft** for the kind — see verify.md F13a.)_

## 8. The record

- [x] 8.1 `proposal.md`, `design.md` (seven decisions), this file, and the spec
      delta. **Done in chunk 1.**
- [x] 8.2 `verify.md`: both stamps and their collision check, up and down through
      the real CLIs on h2puni, the full gate with the bun version, the F1–F11
      fault table, and the **empty diff on `service/schedule.ts` and
      `libs/domain/**`** quoted from `git diff --stat` as a claim that was
      checked rather than asserted.

      > **Done 2026-08-21 (chunk 15).** Both stamps on disk and the `uniq -d`
      > collision check re-run at the head against all 26 folders. The CLIs were
      > run for real — `migrate-status-cli`, `migrate-cli`, `migrate-down-cli`
      > against a byte copy of the dev database (9 people, 342 work items): up
      > applies exactly the two, `person.kind` backfills `person` × 9, down
      > reverses exactly the two newest-first, and a second round trip with a
      > recorded `agent` and a recorded 120,000-token estimate leaves the person
      > digest identical across the column drop. `openspec validate --all` is 72
      > passed / 0 failed under the CLI's real name, `@fission-ai/openspec@1.3.0`
      > — the earlier "could not determine executable" was a wrong package name,
      > not a missing dependency. The absence diff is empty at the branch head
      > on the gate host. `fe-01`'s baseline was read at `origin/main` (1584) so
      > 1588 is a delta and not arithmetic. One Owed entry was **withdrawn as
      > false**: `role_measure_by_role` has existed since section 1.
