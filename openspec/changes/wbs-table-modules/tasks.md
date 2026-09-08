# W4-4 ordered tasks

## 1. Baseline

- [x] 1.1 Read the table, callers, concept suites, sweep C and handoff; record the baseline.

## 2. Mechanical extraction

- [x] 2.1 Move remembered layout and column families behind the exported live type.
- [x] 2.2 Extract layout, column set, read, filter, export, keyboard, structure, draft and reference hooks.
- [x] 2.3 Extract toolbar, cell props and chart input; preserve PlanRow, pointed store and the three column dependencies.
- [x] 2.4 Move remaining dependency, field, refusal, number and mismatch helpers to concept owners; record the mapping and wiring changes.

## 3. Verification and handoff

- [x] 3.1 Run all eleven table concept suites; observe the column-remount negative and restore the passing code.
- [x] 3.2 Verify the source typecheck and scoped lint; observe a missing live field rejected by TypeScript.
- [x] 3.3 Verify the root frontend typecheck including spec/e2e projects.
- [x] 3.4 Independent review done 2026-09-08 and recorded in
      [W4-4 verification](../../../docs/refactoring/w4-4/verify.md) § "Independent review": the
      split holds on every load-bearing point, and the four documentation-and-surface defects it
      found are fixed in the same change as the record. The coordinated browser gate is `main`'s
      own CI at `a0c7cada` and `7aa61b09`, both `gate: success` and `pixels: success`.
- [ ] 3.5 Reconcile the final gate record and hand off the R1/R10 interfaces: cite the
      historical merged-state CI with its actual revisions, preserve the three column
      dependencies and PlanLive/editor-identity obligations, and record the receiving
      changes. Do not claim those old runs verify the current tree. Review 3.4 is already
      complete; any newly required current-head gate remains pending until freshly run.

The approved W4-4 plan is the design; no separate plan artifact is created. Cell hover-store isolation and PlanCard memoization remain performance work for R10, requiring its browser measurements and explicit row dependencies.
