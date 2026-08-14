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

## 1. The vocabulary, before any storage

- [x] 1.1 `libs/domain/src/priority-band.ts`: `PriorityBand`,
      `DEFAULT_PRIORITY_BANDS` transcribed from Dany's sentence,
      `PRIORITY_BAND_COUNT`, `priorityBandRankOf`, `priorityBandOf`. A band is a
      **start** and resolution is total — design.md D1.
- [x] 1.2 `priorityLadderProblem`, the one guard, beside the resolution whose
      assumptions it enforces. Its own suite covers both directions of each rule:
      the count in both directions, the first band's start, equal and decreasing
      starts, a default above **and** below its own band, the top band's missing
      ceiling, and a label at exactly the limit as well as past it.

## 2. The table, its seeding, and a read that is total

- [x] 2.1 `project_priority_band(project_id, rank, starts_at, label,
default_value)`, primary key on `(project, rank)`, the project cascading.
      **Negative:** `ON DELETE CASCADE` struck, watched failing `lets the
outgoing release keep writing projects against the migrated schema` on
      `FOREIGN KEY constraint failed`. That case had to be rewritten to delete a
      **seeded** project first — against one created after the migration it holds
      no bands, and the same injection was 16 pass / 0 fail. R5 #2.
- [x] 2.2 The seeding: every existing project × the five defaults.
      **Negative:** the whole `INSERT … SELECT` struck, watched failing `seeds
every project that existed with the five default bands` on
      `Expected length: 15, Received length: 0`. Every behavioural test stays
      green with it struck, which is design.md D2's point and why the assertion
      is on the table. R5 #1.
- [x] 2.3 `PriorityBandRepository.listFor` — rank order, defaulting to
      `DEFAULT_PRIORITY_BANDS` for a project holding no rows, writing nothing to
      get there. **Negative, both arms:** the default arm deleted (R5 #3, 5 pass
      / 2 fail) and the default arm made unconditional (R5 #4, 4 pass / 3 fail).
- [x] 2.4 `down.sql`, and the rollback case that reads the result: the table
      goes, every priority stays. The migration-order lists in
      `migrate-down.test.ts` and `migrate.test.ts` gain the new folder.

## 3. The write path

- [x] 3.1 `PriorityBandStore.replace` — the **whole** ladder, delete-then-insert
      in one transaction, the project read inside it. **Negative:** the delete
      struck, watched failing `replaces the whole ladder rather than merging into
it` on `UNIQUE constraint failed` (R5 #5); and the existence read deleted,
      watched failing `refuses a project that is not there, and writes nothing`
      on an uncaught `FOREIGN KEY constraint failed` where a modeled `not_found`
      was owed (R5 #6).
- [x] 3.2 `PUT /api/projects/:id/priority-bands`, gated by `canEdit`, with
      `priorityLadderProblem` as its one guard. **Negative:** that call deleted,
      watched failing `refuses a ladder whose first band does not start at 1` on
      `status: 400 → 200` with the ladder stored (R5 #7). The route's `typeof`
      arms are recorded as **narrowing, not refusal** — striking one leaves the
      suite green, and the record says so rather than claiming a proof it does
      not have.
- [x] 3.3 `priority_bands_changed`, published to the named project and no other.
      **Negative:** the publish deleted, watched failing `tells the project it
names and no other` (R5 #9).

## 4. The claim: a ladder moves no date

- [x] 4.1 `tree()` gains `priorityBands` and hands it to nothing. The payload's
      key list is pinned in `work-item.service.test.ts`.
- [x] 4.2 The differential: `capacity-per-project`'s sixteen captured plans
      replayed twice, with the seeded ladder and with a re-cut one, every field
      of every work item and every slice.
- [x] 4.3 **The case the corpus cannot make.** Every priority in those plans is
      1–4, so all of them are in one band and both replays are blind to a ladder
      that reaches the leveller — measured at 4 pass / 0 fail with the fault in.
      So a contended plan whose order priority alone decides, measured under two
      ladders with a control on the **dates** over the numbers themselves.
      **Negative:** the ladder wired into `slicesOf` and `schedule`, watched
      failing on `bdev` at `earliestStart: 3` where 0 was owed (R5 #10).

## 5. The four faces, and the one function behind them

- [x] 5.1 `priority-band-style.ts` — `priorityBandStyleOf`, five inks keyed on
      the **rank**, null for an unprioritised work item. Its own suite pins that
      a renamed band keeps its colour and that two plans name one number
      differently.
- [x] 5.2 The Prio cell: the band's ink and its name in the title.
      **Negative:** the `color` line deleted, watched failing on
      `expected '' not to be ''` (R5 #11).
- [x] 5.3 The Prio cell's two languages — a typed number, a typed name, and a
      list opened on a **click**. **Negative:** the list moved onto the focus,
      watched taking five cases red, three of them pre-existing (R5 #17).
- [x] 5.4 The chart's band cap, a third channel beside the assignee's fill and
      the critical path's stroke, taking no pointer and no name.
      **Negative:** the cap block deleted (R5 #12).
- [x] 5.5 The cards' band chip, which is the only face a phone has.
      **Negative:** the chip deleted (R5 #13).
- [x] 5.6 The export's `Priority band` column, from the plan's **own** ladder.
      **Negative:** pointed at `DEFAULT_PRIORITY_BANDS`, watched failing on
      `expected 'Critical' to be 'Blocker'` (R5 #14).

## 6. The dialog

- [x] 6.1 `PrioritiesDialog` beside `TeamsDialog`: five rungs, each a name, a
      start and a number, with the **range** each start amounts to recomputed
      from the drafts. design.md D5.
- [x] 6.2 Drafts held until Save, so a cut can be moved past its neighbour.
      **Negative:** the send narrowed to the rung that changed, watched failing
      `sends the whole ladder on Save, never one rung of it` (R5 #16).
- [x] 6.3 The two local decisions, `TeamsDialog`'s reused: an empty box and a
      non-finite draft are refused here rather than sent, and everything else is
      be-01's to refuse. **Negative:** the guard replaced by a bare `Number`,
      watched taking two cases red (R5 #15).
- [x] 6.4 `priorityBandRefusalSentence`, with the 5xx arm C3 and C5 each had to
      add after the fact, written in from the start.

## 7. The gate

- [x] 7.1 `bunx nx format:check --all`, `bunx nx run-many -t lint typecheck`,
      both suites run directly (bun in `apps/be-01`, node vitest in `apps/fe-01`)
      and `openspec validate --all --json`, on h2puni. Nothing on h1claw. The
      `build` target is **not** run there — `tool-bootstrap` and `tool-devsync`
      refuse without `shellcheck`, which h2puni does not have, and CI is the gate
      of record for it.
- [x] 7.2 CI `gate` and `pixels`.
- [x] 7.3 `verify.md`: commands, results, and the R5 table with every injection's
      own output — including the two that did **not** go red, and what was done
      about each.
