# Refuse a calendar marker on an undated plan, with a reason

A calendar marker is an annotation on an absolute date, visible on the Gantt but not to the scheduler. When the plan has no project start date, it cannot compute an axis date for the chart. The click on an undated cell must not fail silently, so it refuses with a message naming what is missing.

The plan's axis chooses between a workday axis (`startDate === null`) and a calendar axis. On a workday axis every cell carries `date: null`, so no axis cell emits a `data-axis-date` attribute — the DOM already states the fact the feature turns on. A click on such a cell is refused, not silently ignored. The refusal names the missing project start date, which is also the fix the user needs.

This is hard to reverse, surprising as UI goes, and had real alternatives. All three deserved consideration.

## Considered options

**Hide the marker affordance on an undated plan.** A disabled or absent control signals "not supported here," but the user cannot distinguish between "not supported" and "not implemented." Silent absence is the least debuggable failure this product has. Rejected.

**Synthesise a date from the workday number.** The chart displays one number per cell, and in principle a number could become a date if the plan held a start date. But this option requires inventing one — a stored date that would never appear on the axis again and that every later dated render would move. This is R5's "default the unknown away": the absence of a start date is a real state, not an error to cover. Rejected.

**Refuse, with a reason.** The click lands, nothing is written, and the message names the missing project start date — which is also what the user needs to fix. The refusal is a product statement, not an error path; it surfaces on the cell itself, not thrown as an exception. Chosen.
