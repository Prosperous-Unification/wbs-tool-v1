<!--
Ordered TDD slices. There is no separate plan.md in this schema — this file
absorbed it.

A slice is a coherent unit of behavior with a test that proves it, not a
two-minute keystroke. "Add a failing test for X, then make it pass" is ONE
slice.

Any slice that adds a safety check must also name the negative test proving the
check fails when the guarded thing is broken. See AGENTS.md, "Non-vacuous
checks". A check with no negative test is not done.

Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The rule, before any table

- [x] 1.1 `libs/domain/src/effective-set.ts`: `effectiveSetOf(rows, membersOf)`
      answering `Map<rowId, {memberIds, fromId}>` — most-specific wins, override
      rather than union, empty set means unstated, absent rather than empty for a
      row whose ancestry states nothing, and the cycle throw kept.
      `effective-team.ts` **deleted** in the same slice, so every call site is a
      compile error (design.md D7). **Negative:** the `own.length > 0` arm
      replaced by a union with the nearest ancestor's, watched failing
      `overrides the ancestor's set whole rather than adding to it`.
- [x] 1.2 The per-dimension case: two accessors over one row list, watched
      failing `resolves each dimension on its own` with the service walk given
      the team accessor — the one-line mistake a second dimension invites.
- [x] 1.3 `soleMemberOf(memberIds, at)` and `PluralMembershipError`: null for
      none, the member for one, a throw naming the row and both ids for two
      (design.md D7). **Negative:** the length check removed so it answers
      `memberIds[0]`, watched failing `refuses a plural set rather than spending
    its first member`.

## 2. The tables and the seeding

- [x] 2.1 `work_item_team(work_item_id, team_id)`, `service(id, name)` and
      `work_item_service(work_item_id, service_id)` in `schema.ts` and in
      `20260814090000_add_resource_sets`, primary keys on the pairs, both join
      tables cascading both ways, `service.name` unique, `service` global with no
      `project_id` (design.md D1, D3). `down.sql` beside it, dropping the join
      tables before the directory they reference.
- [x] 2.2 The seed: one row per work item carrying a non-null column.
      **Negative:** the `INSERT` struck, watched failing `seeds one team row per
    work item that carried a label` on `expected [] to have a length of 3 but
    got 0`, taking the oracle differential with it.
- [x] 2.3 What the migration must **not** touch: `service` and
      `work_item_service` empty, `project_team_capacity` and `person_team`
      row-for-row unchanged, `work_item.service_team_id` unchanged. Three
      assertions, and they are the cheapest proof that a service has no size and
      no members.
- [x] 2.4 The blue/green case: the outgoing release deletes a team and a work
      item against the migrated schema. **Negative:** the cascades removed from
      `work_item_team`, watched failing on `SQLiteError: FOREIGN KEY constraint
    failed`. Recorded while writing it: the deployed
      `work_item.service_team_id` carries a foreign key `schema.ts` does not
      declare (design.md D11).
- [x] 2.5 The rollback: `rollbackTo` reverses this migration first, the three
      tables go, and every label is still in the column beside them. The two
      migration-order lists in `migrate-down.test.ts` and the one in
      `migrate.test.ts` learn the new name.

## 3. The read model

- [x] 3.1 `WorkItemStore.resourceSetsOf(projectId)` — two maps, joined back
      through `work_item`, sorted in SQL (design.md D4). **Negative:** the team
      statement pointed back at `work_item.service_team_id`, watched failing
      `reads a work item's teams from the join table rather than from the column`
      against a row written to disagree with its own column.
- [x] 3.2 `mirrorTeam` on insert, on a label patch and on every row of a subtree
      copy, inside the caller's transaction (design.md D8). **Negatives:** the
      call dropped from `patch`, from the clear arm, and from the subtree loop,
      each watched failing its own case.
- [x] 3.3 `NumberedWorkItem` and the wire gain `teamIds` and `serviceIds` — each
      row's **own** sets (design.md D5).
- [x] 3.4 `slicesOf` takes effective **team** sets and narrows through
      `soleMemberOf`; the service sets are not a parameter, which is the
      structural half of "no service id reaches `schedule()`".
- [x] 3.5 `directoryUsageOfTeam` and `DirectoryRepository`'s two labelled reads
      switch to the join, `label_nulled` now meaning "this row's own set holds
      the team".

## 4. fe-01 reads the set

- [x] 4.1 The table's `effectiveTeams`, its cell, the picker's current value, the
      Teams dialog's per-row team and `createPersonFor`'s membership all read
      `teamIds` through `effectiveSetOf` / `soleMemberOf`; the cards follow the
      table's `teamLabel` and need no change of their own.
- [x] 4.2 The export's `teamsInForce` and `Team` column read the set.
      **Negative:** `soleMemberOf`'s length check removed, watched failing
      `refuses to print one of two teams as if it were the answer` while the CSV
      named the first of two.
- [x] 4.3 The fe-01 fakes mirror the write the way be-01 does — a patch naming
      the label moves the set — so no test passes against a row shape be-01
      never sends.

## 5. Nothing moved, proved

- [x] 5.1 The committed capacity oracle, replayed field by field over the keys
      the capture holds, with `teamIds` asserted equal to the singleton the
      captured column derives and `serviceIds` asserted empty (design.md D9). The
      fixture is **not** recaptured.
- [x] 5.2 The service no-op differential against real SQLite: a plan a pool
      binds, read twice, the second time with every row on two services
      (design.md D10). **Negative:** `slicesOf` given `poolId = teams[0] ??
    services[0]`, watched failing on `no size for pool payments` and, with
      sizes seeded for services too, on a moved `earliestStart`.
- [x] 5.3 The gate on h2puni and CI green, both recorded in verify.md at the head
      they ran on.
