# domain

Every rule about what a plan **is**, as pure functions over rows. No storage, no
HTTP, no React — `runtime:isomorphic`, so be-01 schedules with it and fe-01 draws
with it, and the two cannot disagree about a date.

## The nouns, and where each one lives

| Ask                                        | Module                 | Decided by                                        |
| ------------------------------------------ | ---------------------- | ------------------------------------------------- |
| When does the work happen                  | `schedule.ts`          | 2,200 lines: CPM, leveling, slices, priorities    |
| What is a workday, and how many between    | `workday.ts`           | ADR 0011 — `snapWorkdays` stays here              |
| What a step's three points are worth       | `estimate.ts`          | ADR 0011 — rounded per step, then summed          |
| What number a row carries                  | `derive-numbers.ts`    | position, not identity; a freeze pins it          |
| Where a new sibling goes                   | `place-sibling.ts`     | one gap arithmetic, shared with the drag          |
| Which team the work belongs to             | `effective-team.ts`    | ADR 0008 — an ancestor's **overrides**            |
| Which service it is part of                | `effective-service.ts` | ADR 0008 — overrides, like the team               |
| What kind of thing it is (tags)            | `effective-tag.ts`     | ADR 0008 — tags **accumulate** down the tree      |
| Its work item type                         | — nowhere              | ADR 0009 — a type does not inherit at all         |
| How far into a predecessor an edge reaches | `dependency-reach.ts`  | ADR 0010 — the project's choice                   |
| What a priority number is called           | `priority-band.ts`     | five rungs, always                                |
| What a priority is worth to the solver     | `priority-weight.ts`   | dense rank, because an absolute is never a weight |
| How far the work has got                   | `progress.ts`          | states fold with `agree`, which is commutative    |
| How many of a team work at once            | `capacity.ts`          | per project, never a property of the team         |
| Whether a row sits under another           | `is-within.ts`         | one upward walk, four copies before 2026-09-02    |
| How long a slice is on the solver's axis   | `solver-quantum.ts`    | quantises `durationOf`, never restates it         |

`effective-label.ts` is the walk those three `effective-*` modules share and is
**not** exported from the barrel: it is the mechanism, not a fourth way to read a
plan.

## Landmines

- **The barrel pulls `schedule.ts` in.** fe-01 imports the pure modules by deep
  subpath (`@wbs/domain/workday`) so 2,200 lines of scheduler stay out of the
  browser bundle; every such alias is listed in **seven** config files, and
  `vite-config.test.ts` compares two of them as sets.
- **The engine is safe to change because of one test.**
  `schedule-identity.test.ts` runs a thousand seeded plans through it and diffs
  every date against two captured oracles. Change `schedule.ts` and run it
  first, not last.
- Floating-point addition is not associative, so the **order** estimates are
  summed in is part of the contract, not a side effect of a query plan.

## Test

```sh
bunx nx run domain:test        # 321 cases, eight files of them the engine's
```
