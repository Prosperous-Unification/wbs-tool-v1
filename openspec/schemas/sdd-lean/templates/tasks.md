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

## 1. <!-- Slice group -->

- [ ] 1.1 <!-- What changes --> — test: <!-- test that proves it -->
- [ ] 1.2 <!-- What changes --> — test: <!-- test that proves it -->

## 2. <!-- Slice group -->

- [ ] 2.1 <!-- What changes --> — test: <!-- test that proves it -->
- [ ] 2.2 <!-- Safety check added --> — test: <!-- positive -->; negative: <!-- fault injected, test that observed the failure -->
