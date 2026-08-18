# verify — `saved-views`

Branch `change/saved-views`, cut from `main` @ `8269ebd` (#79 `actual-days`
merged) on 2026-08-18. **R10 F4** of `notes/wbs-brief-2026-08-17-r10-filtering.md`,
built to the eight answers Dany settled on 2026-08-17 (`notes/decisions.md`).

**PoC mode** (`notes/delivery-modes.md`): no `design.md`, no citation table, no
R5 fault table. New guards still get their injected fault — five are below.

`apps/fe-01/src/components/wbs/` only. **No `apps/be-01` change, no `gw-01`
change, no `libs/domain` change, no migration, no wire field.** A saved view is
a thing one browser remembers about one project; nothing crosses the socket.

## The change, in one line

`wbs.views.<projectId>` in `localStorage`, the same per-project-per-browser shape
`rememberedWidthOverrides` already uses — a name plus the seven-facet criteria in
force, written on `Save` and on `Delete` and at no other moment.

## Written across two sessions — say so plainly

The code and its nine tests were written by a subagent on 2026-08-18, which died
on a harness output limit **before running the gate and before writing this
file**. It left commit `e71285e` plus an uncommitted typecheck fix in the working
tree. This session folded that fix in (`bfb746a`), fixed the delta spec, ran the
whole gate, and wrote this record. **No wall-clock split is available for the
authoring half** — the timings other records in this folder carry are not
reconstructible here, and a made-up one would be worse than none.

## The gate

`bunx nx affected -t test lint typecheck --base=origin/main` plus
`bunx nx format:check --all`, on **h2puni**, bun **1.3.14** (the version CI
pins), in `/home/puni1/wd/puni/wt-saved-views` — a worktree of
`/home/puni1/wbs-reds`. Nothing was built or run on h1claw
(`bin/block-local-builds.sh`).

| run                                              | result                               |
| ------------------------------------------------ | ------------------------------------ |
| `nx affected -t test` (fe-01)                    | **53 files, 1487 tests, all passed** |
| `nx affected -t lint typecheck`                  | **Successfully ran** for fe-01       |
| `nx format:check --all`                          | **clean, exit 0**                    |
| `bunx @fission-ai/openspec@1.3.0 validate --all` | **64 items, 64 passed, 0 failed**    |

`filter-honesty` (#78) left fe-01 at 1478 tests; this change adds **nine**, which
is exactly the nine cases in `describe('saved views, per browser')`. **be-01,
gw-01 and `libs/domain` are not affected** and `nx affected` did not select them.

**CI has not run yet** — the branch is not pushed at the time of writing. CI is
the gate of record and this file will be wrong about that until it does.

## The one thing `openspec validate` caught, and why

`validate --all` first came back **63/64**, with `saved-views` failing on:

```
✗ wbs-domain/spec.md: ADDED "A saved view naming something since removed
  narrows to nothing, not to an error" must contain SHALL or MUST
✗ wbs-domain/spec.md: ADDED "A malformed saved view is dropped without losing
  the rest" must contain SHALL or MUST
```

Both requirements were full of `SHALL`. **The parser takes only the first line
of the requirement body as its text** — `change show --json --deltas-only` shows
`"text"` truncated at the first newline — and both of those started with a
`Where …` clause that put the `SHALL` on line two. Reworded to lead with the
obligation; nothing about what either requirement asks for changed. Worth
knowing for every future delta: **the modal verb has to be on the first line.**

## Watched reds

Each guard was reverted on h2puni, the case it exists for run alone, then the
revert dropped and the tree checked clean.

| #   | fault injected                                              | case that must go red                               | result                      |
| --- | ----------------------------------------------------------- | --------------------------------------------------- | --------------------------- |
| 1   | `isSavedView` stops requiring a non-blank `name`            | drops one unusable saved view and keeps the rest    | **1 failed** — red as asked |
| 2   | `rememberedSavedViews` stops checking the store is an array | drops a hand-edited store that is not a list        | **1 failed** — red as asked |
| 3   | `canSave` drops the `filtering &&` half                     | offers no Save while nothing is filtered            | **1 failed** — red as asked |
| 4   | `onApply` writes `query` but not `facets`                   | applies a saved view … together, in one gesture     | **1 failed** — red as asked |
| 5   | `onDelete` updates state but never writes storage           | deletes a saved view, and forgets it in storage too | **1 failed** — red as asked |

**Not red-run: "never writes a view merely by typing or ticking — only Save
does."** It is a negative-space guard — it asserts the key is still `null` — and
its fault is _an added write somewhere else_, not a removed line. There is no
one-line inversion that injects it honestly, so it was left un-injected rather
than faked with an unrelated edit. It passes in the suite; it has not been proven
to fail.

## What this deliberately does not do

- **No server-side views.** Per browser, per project, like the width overrides.
  Sharing a view is not in R10.
- **The ad-hoc filter is still forgotten across a reload** (Q6, settled
  2026-08-17). Saved views are the remembering; the filter in force is not.
- **A view naming a deleted team narrows to nothing**, and the facet panel still
  offers its ticked box through `optionsFor`'s existing "not loaded" fallback —
  no crash, and no silent repair that would hide the stale id from the reader.
