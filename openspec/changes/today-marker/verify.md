# verify — today-marker

**PoC mode** (`notes/delivery-modes.md`): fe-01 only, no `drizzle/**`, no
scheduler, nothing in `libs/domain`. No design.md, no citation table, no R5
fault table — three watched reds instead, below.

## The gate

Run on **h2puni**, worktree `~/wd/puni/wt-today-marker`, **bun 1.3.14**, base
`origin/main@7bfab90` (#83 merged).

| what                                               | result                            |
| -------------------------------------------------- | --------------------------------- |
| `nx test fe-01`                                    | **1,504 pass / 0 fail**, 53 files |
| `nx affected -t lint typecheck --base=origin/main` | green                             |
| `nx format:check --all`                            | exit 0                            |

1,497 before, so **seven new cases**: six on the marker, one on `isoToday`.

Head `810056d`, five commits off `7bfab90`. The last is prettier alone — the
first `format:check` named `gantt-panel.tsx`, and it is committed from h2puni
because this box does not run the toolchain.

## Watched reds

Each fault was injected, the run watched, and the file restored — `git diff
--stat` silent after every one.

**1. The null arm replaced by a clamp.** `todayOffset` made to answer a real
column for a date that is not on the axis, which is the obvious "keep it on
screen" instinct.

> **2 failed | 3 passed.** `draws no marker when today is before the plan
begins` and `draws no marker when today is past the last day drawn`, both on
> `expected SVGElement{…} to be null`.

A chart claiming a plan starts today when today is a week before it. This is
Dany's own call, asked on 2026-08-19 and answered before the build.

**2. An offset-based placement instead of a date match.** `todayOffset` made to
fall back to a computed column rather than matching on the cell's date.

> **1 failed | 1 passed.** `draws no marker at all on a plan with no start date`,
> on `expected SVGElement{…} to be null`.

A marker standing at some workday number on an axis where nothing is a date.

**3. `isoToday` written through UTC** — `today.toISOString().slice(0, 10)`, run
under `TZ=Europe/Kyiv`.

> **1 failed | 120 skipped.** `reads a late evening as the day the reader is
having`, on `expected '2026-08-18' to be '2026-08-19'`.

The failure landed on the **00:30** assertion, not the 23:30 one, and that is
worth recording because it is the opposite of the intuition: east of Greenwich
it is the small hours that break — 00:30 in Kyiv is 21:30 UTC the day before —
so the marker would stand a column _left_ of today for the first three hours of
every day. West of UTC the late evening breaks instead. Both ends of one day are
asserted for that reason, and both are built from local parts so the test holds
in every zone.

The comments in `gantt-panel.tsx` and the test file were corrected after this
run: they had claimed the evening case fires. It does not, east of UTC.

## Not gated here

- **CI** — the run at the head goes in the PR; this file records the local gate.
- **`pixels`** — `apps/fe-01/**` changed, so it runs. This change adds a column
  and an axis colour, so a pixel diff is expected on any snapshot holding a
  chart whose span contains the day the snapshot is taken. If `pixels` is red on
  exactly that, it is the change and not a flake, and the snapshot is the thing
  to update.
- **be-01, gw-01, `libs/domain`** — untouched, and `nx affected` did not select
  them.

## One thing worth saying about the test clock

The panel reads `new Date()` at render, so the six marker cases drive it with
`vi.setSystemTime` and restore real timers in a `finally` **before** asserting —
the assertions touch nothing timed, and a suite that leaves fake timers running
poisons every test after it. There is an `afterEach` restoring them as well, for
the case where the render itself throws.
