## 1. Establish browser evidence

- [x] 1.1 Build deterministic real-backend matrix seeding (100/500/1000rows,2/8steps,sparse/dense dependencies) with command batches <=200 and server verification; reject failed setup explicitly.
- [ ] 1.2 Measure Chromium cold-context/warm navigation and Find input/filter paint opportunities, actual mounted/intersecting cells, and separately instrumented production render calls. Record all samples and environment; add open-Gantt and unfolded-column stress observations.
- [x] 1.3 Observe setup refusal/missing identity/wrong geometry faults at intended assertions. Record actual failures before Proof comments.
- [ ] 1.4 Derive concrete latency/mounted-cell/render budgets from measurements and write them in intent before optimization. Independent review of this first measured slice.

## 2. Establish explicit row and logical grid ownership

- [x] 2.1 Inventory every row/cell live dependency and add peer-update/focus regressions; omit an exact dependency and watch the displayed value fail while an unrelated editor remains active.
- [ ] 2.2 Move row construction behind explicit render inputs and stable cell component identities; preserve directory labels, draft/refusal/busy/selection and geometry dependencies.
- [ ] 2.3 Introduce logical editable row/column navigation over the full filtered/expanded order while all rows still mount. Cover arrows, Tab wrapping, first/last rows, gaps, hidden/unfolded steps, create/duplicate focus and filter/collapse changes.

## 3. Isolate Find work

- [ ] 3.1 Separate urgent query input from deferred criteria/filter computation without stale project answers; cover facets, saved views and peer updates.
- [ ] 3.2 Prove broad-query unchanged rows avoid all-cell rerenders; restore parent query state and observe production Chromium count failure. Remeasure input and filter completion separately.

## 4. Bound mounted cells

- [ ] 4.1 Introduce viewport row/column ranges, measured variable heights and explicit overscan; count mounted cells independently of implementation ranges.
- [ ] 4.2 Pin the active editor across scrolling with same node/text/selection and commit/Escape/refusal behavior; logical navigation mounts offscreen targets before focusing.
- [ ] 4.3 Preserve scroll anchoring, pinned columns, logical striping, accessible row count/index, drag destinations/autoscroll and mobile card behavior.
- [ ] 4.4 Preserve Gantt logical order,28px label/bar alignment, hover correspondence and whole-chart SVG export; test height/width changes near window boundaries.
- [ ] 4.5 Restore full mounting at fixed viewport and watch the cell budget fail; remeasure the complete matrix and document trade-offs.

## 5. Integrate and review

- [ ] 5.1 Run focused/unit/host/root type/lint checks and mutation table; every Proof must match observed output.
- [ ] 5.2 Freeze source and run complete Chromium and workspace gates, including shared CSS, keyboard, names/references, hover, drag, mobile, markers and Auckland timezone coverage.
- [ ] 5.3 Independent implementation review, OpenSpec validation and parent integration; no commit before review.
