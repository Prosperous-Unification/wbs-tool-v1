# Calendar horizon guard

## Problem

An estimate is validated one point at a time, but calendar representability is a
property of the placed plan. Several legal estimates can produce a makespan
beyond ECMAScript's finite `Date` range. The third write then persists and both
that command's announcement and every later plan read surface an opaque 500.

## Desired outcome

Calendar projection reports a named `calendar_range` state. A command batch
that would newly leave the project in that state is refused atomically with a
422. A project already holding such data remains readable and can commit an edit
that returns it to range.

## Non-goals

- Lowering the per-point estimate maximum.
- Clamping or inventing a calendar date.
- Limiting the dimensionless scheduler's arithmetic or optimizer horizon.
- Expanding ECMAScript's calendar implementation.

## Constraints

- The guard must cover dependency and capacity shapes, not only estimate sums.
- The 30,000,000-day control remains representable when its placed makespan is
  within range.
- Unknown scheduling and projection defects still throw; only the typed range
  condition is modeled.
