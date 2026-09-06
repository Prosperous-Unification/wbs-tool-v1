<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The order, watched red before it exists

- [x] 1.1 The three tests TASK-219 excised come back verbatim into
      `apps/be-01/src/repository/work-item.db.test.ts`, under
      `describe('the order the work-item select answers in')`, together with the
      `spanOf` and `@wbs/domain` + `slicesOf` imports that went with them. They
      are preserved in TASK-260's `## Excised tests` section; restore them
      **unedited**, so the assertions are the ones that were measured rather than
      ones rewritten to suit the fix.
- [x] 1.2 Watch all three red first, against the unordered select on `main`:
      TASK-219 run 13 measured **31 pass / 3 fail against a green 34 / 0**, and
      that count is the acceptance criterion for this slice. A restore that is
      already green means the fixture is not reaching the tie-break.
- [x] 1.3 `ORDER BY work_item.id` on `listByProject`'s work-item select, and the
      JSDoc paragraph that currently explains why the order is **absent** is
      replaced by the paragraph stating what the order now promises and why the
      promise is load-bearing — the `slicesOf` walk, the stable
      `deriveNumbers` sort, `goesFirst`'s third tie-break. Link ADR 0016 rather
      than restating it (R3).
- [x] 1.4 The three tests go green and the rest of the be-01 suite stays green.
      Negative to watch, and it is the one that matters: delete the `ORDER BY`
      again and read the same 3 failures back.

## 2. The index the order needs

- [x] 2.1 `index('work_item_project_id_id').on(t.projectId, t.id)` in
      `schema.ts` beside `work_item_siblings`, with the JSDoc saying it exists to
      serve slice 1's `ORDER BY` rather than a `WHERE`.
- [x] 2.2 One migration folder, `<stamp>_add_work_item_read_order_index`: the
      `CREATE INDEX`, plus the `down.sql` that drops it —
      `readMigrationFolders` refuses an empty one. Additive, so blue and green
      share the file safely during a swap; the outgoing release never reads the
      index and the incoming one does.
- [x] 2.3 The measurement, in the migration comment and in `verify.md`, taken the
      way `20260902120000_add_lookup_indexes` took its: `EXPLAIN QUERY PLAN`
      before and after on a freshly migrated database. Before is the control —
      a `SCAN work_item` with a temp B-tree for the sort; after is a `SEARCH`
      using the new index.
      **Measured, and the prediction was half wrong:** before is not a `SCAN`.
      `work_item_siblings` leads on `project_id`, so the `WHERE` was already
      index-served and only the sort was not — before is
      `SEARCH … USING INDEX work_item_siblings` **plus**
      `USE TEMP B-TREE FOR ORDER BY`, and the temp B-tree is what the new index
      removes. `verify.md` §2.3 carries the run.

## 3. The movement, measured over the population it can touch

- [x] 3.1 A read-only probe over the live database that counts projects holding
      at least one sibling group with a duplicated `(parent_id, position)` — the
      only projects this change can move. Report the count and the project ids;
      a zero here is the answer that makes slice 3.2 trivial, and it has to be
      measured rather than assumed.
- [x] 3.2 Pre/post fixtures for each affected project: the plan as it schedules
      today and as it schedules under the ordered read, diffed to the work items
      whose dates move. This is the announcement's content.
      **Zero affected projects measured in 3.1, so there is no per-project pair
      to build.** The one shape that moves is covered by the third restored test
      in `work-item.db.test.ts`, which is itself a pre/post pair over two
      siblings tied on `position`; `verify.md` §3.2 says so rather than leaving
      the tick to stand for fixtures that do not exist.
- [x] 3.3 The announcement itself lands with the PR, so the movement is stated
      before the deploy rather than discovered after it. A project whose dates do
      not move is named as unaffected rather than omitted.

## 4. The gate

- [x] 4.1 `bunx nx run-many -t test lint typecheck build` and
      `bunx nx format:check --all` on h2puni, plus
      `bunx @fission-ai/openspec@1.3.0 validate --all --json` for this change
      directory.

Green at `0a15ebc3`, `dirty=0`, on h2puni: `run-many -t test lint typecheck build`
rc 0 — `Successfully ran targets test, lint, typecheck, build for 22 projects`;
`nx format:check --all` rc 0; `openspec validate --all --json` 38 / 38, 0 failed.
`verify.md` §4 carries the same run.
