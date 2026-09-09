## Why

The screenshot shows unnecessary space between each row's drag handle and work item number. Tightening that gap makes the leading controls easier to read together without changing the plan's hierarchy.

## What Changes

Move the default work item numbers 8px closer to their drag handles. Keep parent and childless sibling numbers aligned, and keep the expander and drag control usable. Verify the rendered distance, push the isolated change and merge after the gate passes.

## Non-Goals

No number-format, hierarchy, drag behavior, saved-width reset, mobile-card or unrelated link-card changes. No deployment is requested.

## Constraints

Preserve the Number column's existing width and caret gutter. Use the common frame geometry so pinned offsets stay consistent. Prove the spacing regression in Chromium with the old spacing present, preserve existing interaction checks, and leave the separate link-card branch untouched. User approved the 8px reduction on 2026-09-09.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wbs-domain`: compact spacing between the drag handle and work item number.

## Domain Terms

None; existing work item and number terminology is unchanged.

## Decisions Recorded

None; this is a reversible layout adjustment.

## Impact

fe-01 table-frame geometry and browser layout tests. No API, database, dependency or deployment changes.
