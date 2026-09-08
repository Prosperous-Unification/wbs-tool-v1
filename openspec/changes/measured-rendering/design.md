## Context

Approved §67 R10 follows integrated R1 and extracted row/filter responsibilities. WbsTable still constructs every visible cell and query state is held in its rendering parent. Keyboard navigation currently enumerates mounted editors. Table rows can grow with names and notes; Gantt is a separately docked surface with28px rows, not a shared-height grid.

## Goals / Non-Goals

Measure before optimizing; bound mounted work, retain logical navigation and active editing, isolate urgent Find updates, and preserve complete Gantt export. Backend scheduling/persistence, HTTP migration and new product features are outside this slice.

## Decisions

First establish real Chromium baselines through the canonical isolated stack and actual authenticated API batches. Fixture creation is timed separately and occurs with the plan observer unmounted. Flat rows have deterministic names and positive estimates in every step. Sparse dependencies connect every tenth row to its previous row; dense dependencies connect each row to up to eight preceding rows. Record exact rows, steps, estimates and edges from the server before measuring.

Use1400×900, no CPU throttle, UTC/en-US, Gantt closed for table isolation. Cold means a fresh browser context with explicit session/project selection; Vite/backend stay warm and their state is reported. Record every sample, context/navigation-to-painted-ready, input-to-paint opportunities, settled filter time, mounted/viewport row/cell counts and geometry. Double animation-frame timestamps are paint-opportunity proxies, not compositor presentation. Collect production flexibleCellStyle execution counts through Chromium precise coverage in a separate instrumented pass; latency samples retain only readiness/long-task observers. Record an additional open-Gantt/unfolded-step series. The first five configurations have3cold+7warm samples; the remaining initial matrix uses1cold+1warm with explicit limited-sample claims after a500-row case took6.2minutes. Repeat selected threshold cases and the optimized matrix before believing latency budgets.

After measured budgets are written into proposal.md, introduce a logical grid based on ordered visible row IDs and editable column IDs. Navigation resolves a logical target, requests it into the viewport and focuses after it mounts. Initially adapt it over full mounting; prove behavior before windowing.

Rows then own explicit committed values, relevant directory/frame/editor state and stable action capabilities. Search input updates locally and supplies deferred criteria to the filter owner. Keep row dependency proofs tied to exact peer changes with an unrelated half-typed editor.

Virtualization uses viewport intervals, measured variable heights and explicit overscan, with a separate active-editor allowance. Preserve native table column geometry, pinned columns and logical zebra parity. Offscreen target navigation and drag autoscroll operate on the logical model, not mounted row enumeration. Accessible row indices/count remain logical. Gantt preserves logical order, independent label/bar alignment and complete export.

## Risks / Trade-offs

Windowing changes DOM identity and keyboard assumptions; parent-only memoization cannot fix mutable live reads. Row height measurement must respond to wrapping, notes, resize and peer content. Search deferral must not retain another project's answer. A rendered-count budget derived from its own range is vacuous: assertions use fixed fixture/viewport and independently observed intersections, with full-mount and missing-dependency faults.

## Migration Plan

Measurement → explicit row dependencies and logical navigation → search isolation → viewport windowing/editor pinning → geometry/drag/accessibility → complete browser gate and independent review. Each slice has observed negative proof before its check is trusted.

### Bounded remaining measurement work

The next single case is 1000 rows / 2 steps / sparse, using the existing R10_BASELINE_SMOKE=1 switch for one cold context plus one warm reload. Parent selected the larger sparse plan to clarify the need for viewport rendering. The completed 500-row sparse counterpart took 6.2 minutes for ten navigation/Find samples plus separate coverage/Gantt observations. Allow roughly 4–6 minutes for this next case plus stack startup, with an explicit stop/report at the bounded window if the estimate is wrong; the existing test cap is10 minutes. This is a low-confidence estimate, not measured 1000-row completion. Run only this case after the parent grants the next quiet window. Preserve its JSON immediately before another Playwright invocation overwrites test-results.

Then schedule each remaining configuration separately, retaining the complete set of 12 configurations without reserving a 30–60 minute uninterrupted run. All five accepted configurations keep their existing repeated raw samples. New limited samples cannot establish p95 or variance. Measurements already show full cell mounting grows from 1,500 to 7,500 at the same viewport; structural budgets must therefore count actual mounted cells against independently observed viewport rows/columns and an explicit overscan/editor allowance. Numeric acceptance budgets remain pending the remaining configurations and review; no application optimization has started.

### Explicit input and logical grid seams

Keep event capabilities behind stable access to current actions, but replace render-time PlanLive reads with immutable cell inputs. Row-original identity alone is insufficient: directory labels, inherited service/team labels, predecessor names/numbers, assignment options, draft/refusal values, search matches, open card/menu identity, disabled start-date state and cross-row assignment state can all change the displayed cell. The dependency audit is recorded in the worker ledger. A memo comparator must compare the inputs the cell actually renders; passing the whole frequently replaced live object or memoizing around mutable live reads would defeat the contract.

Introduce a committed logical grid containing ordered CellRef entries and a lookup of row/column positions. Its order comes from the full filtered/expanded TanStack row model and visible column definitions, before any viewport slice. Column definitions should declare logical editability beside their rendered field: rolled-up estimates remain readonly, disabled not-before fields remain absent, and hidden/unfolded step columns keep the current keyboard ordering. Publish this model in a layout effect after commit, preserving the existing protection against navigation into an abandoned React render.

Separate navigation destination from DOM attachment. The former consumes logical CellRefs through existing nextCell/commandMove/nextRowName operations; the latter requests an offscreen target into the viewport and focuses after its input is committed. Migrate focusAdjacentCell, arrow navigation, command movement and next-row Name first while all rows mount. Then migrate FocusIntent.land, readiness-gap focus, Gantt goToRow and date-editor focus to the same attachment capability. Preserve first/last-cell browser behavior, caret positioning, modifiers, composition, create/duplicate landing and disappearing filter/collapse targets before introducing virtual rows.

The first dependency negative should change a predecessor's displayed name or an inherited directory label while another row holds a half-typed Name editor, omit exactly that immutable dependency and observe stale text without losing the editor node/selection. Existing row render-cost tests alone cannot establish that dependency completeness. Browser navigation across a future viewport edge must assert the logical destination and preserved caret, not simply that some mounted input gained focus.

## Open Questions

Latency, mounted-cell and overscan budgets await actual baseline measurements; no implementation optimization begins before those values are recorded.
