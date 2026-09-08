## Why

The plan mounts every visible row and column, and Find input updates the component that constructs every cell. Large plans therefore pay rendering costs proportional to project size even when most cells are offscreen. R1 now supplies coherent resource ownership; R10 can make rendering dependencies and viewport ownership explicit without concealing stale reads.

## What Changes

Record actual Chromium cold-context/warm navigation, input-to-paint opportunities, filter completion and mounted-cell baselines for100/500/1000 rows, two/eight steps and sparse/dense dependency graphs. Publish measured budgets here before optimization begins.

Then isolate urgent Find editing, give rows explicit committed/editor dependencies, introduce logical keyboard traversal, and bound mounted cells by the viewport with overscan and a pinned active editor. Preserve peer updates, typed text/selection, variable heights, drag, accessibility and table/Gantt correspondence.

## Non-Goals

Backend scheduling or persistence optimization, HTTP-client migration, new product features, and replacing the Gantt's independent28px logical rows or whole-chart export.

## Constraints

Approved refactoring plan §67 R10 is the design authority; no new interview is required. Measurements use real authenticated backend requests and the owned Chromium stack, with cold browser context distinguished from server warmth. No budgets or speed claims precede measurements. Logical navigation precedes virtualization. Existing column component identities, R1 coverage, draft/refusal semantics and complete browser gates remain binding.

At1400×900 with1,000 rows, acceptance requires at most1,200 folded mounted cells and2,250 with eight estimate groups unfolded. The derivation, including300px vertical overscan on each side,256px horizontal overscan on each side and one complete pinned-editor row, is recorded in `verify.md`; increasing100 rows to1,000 must not increase either bound. A broad Find may execute `flexibleCellStyle` at most2,250 times, must offer an input paint within250ms and settle filtering within5s. Cold-context and warm ready paint must each remain within10s. These are per-sample development-stack ceilings, not p95 or production claims; fixture setup is excluded. Optimized samples are compared only with a baseline from the same environment/protocol. The absolute ceilings apply to the retained Darwin/Chromium151 and Linux/Chromium153 no-throttle protocols, with every miss reported rather than averaged away.

## Capabilities

### New Capabilities

- `measured-rendering`: bounded plan rendering and responsive search with logical navigation and observable browser budgets.

### Modified Capabilities

None.

## Domain Terms

None.

## Decisions Recorded

None.

## Impact

Frontend row/cell/filter/keyboard/frame modules, browser fixtures and rendering tests. No backend or database contract changes.
