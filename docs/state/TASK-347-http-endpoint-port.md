# TASK-347 — http-endpoint-port shared typed contracts

State dump written 2026-09-07T15:57Z at the request of the repository owner, so
the branch carries its own current state rather than leaving it in a PR
description that has since gone stale.

- **Branch:** `refactor/planned-project`
- **PR:** [#287](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/287)
- **Head at dump:** `0f2fefc5fe531340caa997bfdd6143cd4ccb5ba4`
- **Head author/date:** Dany Fedorov, 2026-09-07 18:36:07 +0300 — a merge of
  `origin/main` into the branch
- **Position:** 46 commits ahead of `origin/main`, 1 behind
- **Queue task:** TASK-347 (`backlog/tasks/task-347 - http-endpoint-port-shared-typed-contracts.md`),
  filed retroactively — the branch had no owning task, so it appeared in no
  lane's pick order and nothing was watching its CI.

## What the branch does

The backend declared HTTP behaviour in six places at once: Elysia routes,
handwritten schemas, committed OpenAPI, MCP conversion, frontend clients and
test fakes. Any of them could drift from the others in validation, policy
ordering, status codes or response representation. This refactor makes literal
endpoint shapes the shared contract and derives backend bindings, generated
documents and tools, production clients and fakes from that one source.

The migrated boundary validates external requests once, preserves ordered
auth/origin policies before parsing, validates status-specific success and
refusal replies, distinguishes EMPTY / JSON null / text / redirect responses,
and rejects unmodeled bodies on GET and HEAD. Merged authentication,
calendar-marker, refresh, scheduler, gateway and deployment behaviour are
preserved; the legacy route and OpenAPI duplication are removed.

OpenSpec change complete and archived at
`openspec/changes/archive/2026-09-07-http-endpoint-port/`, synchronized to
`openspec/specs/http-endpoint-port/spec.md`.

## CI at this exact head — RED, and the PR body does not say so

The PR description lists a full green sweep (24 Nx projects, fe 2,461 unit + 3
zoned, be 1,954 tests / 19,737 assertions, contracts 370, browser 293 pass / 1
skip, Linux solver 195, SO_PEERCRED 3/6, strict OpenSpec, independent review
with no Critical or Important findings). **That evidence predates the current
head.** Read from the run rather than the prose:

| Run                                                                                           | Head       | Result                                                                           |
| --------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| [34139211224](https://github.com/Prosperous-Unification/wbs-tool-v1/actions/runs/34139211224) | `0f2fefc5` | **failure** — `pixels shard 2/2`, then `pixels` on "Require every browser shard" |
| 34126986014                                                                                   | `e3b98468` | cancelled                                                                        |

Two layout assertions fail, both in `apps/fe-01/e2e/layout.spec.ts`:

1. `:1233` — _the table, measured by a browser › a step's figure lands at one x
   whether or not the row is assigned_ (36.2s)
2. `:2721` — _the table, measured by a browser › opens the folded step's @
   picker out past the bottom of a 96px cell_ (36.0s)

`2 failed`, and `NX Running target e2e for project fe-01 failed`. The `[vite] ws
proxy error: write EPIPE` lines in the same log are noise from the dev server
being torn down, not the failure.

### These are the branch's, not `main`'s

`main` at `0adaf700` — the exact commit this branch merged in at `0f2fefc5` —
is green, `gate: success` and `pixels: success` (run 34139366881). The same two
specs pass there and fail here, so the branch owns them.

### Neither is a pixel diff

Both are DOM assertions, not screenshot comparisons, and both land on the
folded step row's assignee UI. From the failure artifacts of run 34140957558:

**1. `layout.spec.ts:1296` — the folded assignee never renders.**
`rowOf('010').locator('[data-folded-assignee]')` resolved to 0 elements, 64
polls across 30s. The DOM snapshot shows row 010's estimate cell as
`"1/2/3 · 2 Dev for 010 …"` — the figure and the final are there, the `· XX`
initials are not. That span is gated on `doing !== null` in
`plan-columns/estimates.tsx:497`, where `doing =
live.current.assigneeOn(row.original, step.id)`. So `assigneeOn` returned null
for a row the fixture assigns.

**2. `layout.spec.ts:2737` — the picker opens empty.**
The preceding assertion passes: the listbox `QA assignee for 030` _is_ visible
with `@Kat` typed. Only `option "Add “Kat”"` is missing. That option is built in
`use-estimate-drafts.ts:426` under `wanted !== '' && !exact`, in a
`mentionOptions` whose first line is
`if (open?.rowId !== row.id || open.stepId !== stepId) return []`. An open
listbox with zero options is what that early return looks like from the outside.

Both failures are the same shape: `live.current` reaching
`plan-columns/estimates.tsx` without the assignee/mention state the folded cell
reads. The suspect commit is `281144a9 refactor: split the plan table into
concept modules`, which moved this rendering out of `wbs-table.tsx` into
`plan-columns/estimates.tsx`; the branch also reshapes the `setAssignee`
contract, dropping `personId` from `required` and adding `personRef:
'unresolved'`. Which of the two is the cause is **not** proved here — that needs
the two specs run, and nothing in this dump ran them.

## What remains

1. Disposition the two layout failures: reproduce against `main` to see whether
   they are this branch's or inherited, then fix or dispose them in writing.
2. Re-read CI at whatever head that produces — green at the exact head is the
   merge gate, not the body's earlier sweep.
3. Merge, or record why it is being held.
