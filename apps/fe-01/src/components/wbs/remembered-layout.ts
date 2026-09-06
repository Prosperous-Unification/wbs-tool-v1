import { type ExpandedState } from '@tanstack/react-table';

import { type Remembered, remembered } from '@/lib/remembered';

import { type DayPx, GANTT_CEILING_PX, GANTT_MIN_PX, isDayPx } from './gantt-panel';
import { isSectionMode, type SectionMode } from './plan-mermaid';
import {
  floorFor,
  type FrameLayoutState,
  INITIAL_HIDDEN_COLUMNS,
  resetHiddenColumns,
  sizableColumn,
  WIDEST_COLUMN,
} from './table-frame';
import { type FilterCriteria, NO_FILTER } from './tree-search';

/**
 * Where this browser remembers which of one project's branches are open.
 *
 * Per project, because the shape being remembered is that project's tree.
 * Per browser, like the chosen project beside it (`project-page.tsx`): my
 * collapsing must not reshuffle anybody else's table.
 */
export const expansionKey = (projectId: string): string => `wbs.expanded.${projectId}`;

/** One project's expansion, judged by {@link isExpansion} — see {@link remembered}. */
export const storedExpansion = (projectId: string): Remembered<ExpandedState> =>
  remembered(expansionKey(projectId), isExpansion);

/**
 * Whether a value read back out of storage is an expansion this table can use.
 *
 * TanStack models expansion as `true` — everything open — or a record of the
 * rows that are open. Nothing else is one; `false` in particular is not, since
 * the all-closed state is the empty record.
 */
export function isExpansion(value: unknown): value is ExpandedState {
  if (value === true) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((open) => typeof open === 'boolean');
}

/**
 * The expansion this browser last saved for `projectId`, or everything open
 * when it has never saved one.
 *
 * The stored value is a claim, not a fact. It is user-editable storage read at
 * a boundary, so it is validated here and dropped — key and all — when it is
 * not an expansion, the same posture `project-page.tsx` takes to a remembered
 * project the list no longer holds. Deliberately not the "unknown is not OK"
 * throw: the alternative is a table that cannot be opened at all until somebody
 * clears storage by hand, over a preference about which triangles point down.
 *
 * Two things the remembered record does **not** do, both verified against
 * `getExpandedRowModel` and `RowExpanding`'s `getIsExpanded`:
 *
 * - Ids naming rows that have since been deleted are harmless. Expansion is
 *   read per row id, so a key nothing asks about is never looked at.
 * - **A row created since the save arrives collapsed** while a record is in
 *   force, because an absent key reads as closed (`expanded?.[row.id]`). Under
 *   `true` — the state of a browser that has never collapsed anything — it
 *   arrives open. That is TanStack's own rule, adopted rather than papered
 *   over: the alternative is a fourth state to keep in step with the other
 *   three.
 */
export function rememberedExpansion(projectId: string): ExpandedState {
  return storedExpansion(projectId).readAndDrop() ?? true;
}

export function rememberExpansion(projectId: string, expanded: ExpandedState): void {
  storedExpansion(projectId).write(expanded);
}

/**
 * Where this browser remembers how wide one project's columns were dragged.
 *
 * Per project and per browser, exactly as {@link expansionKey} beside it: a
 * width is one reader's answer to how much of their screen a column deserves,
 * and be-01 is never told about it.
 */
export const widthOverridesKey = (projectId: string): string => `wbs.columnWidths.${projectId}`;

/**
 * One project's dragged widths, as **stored** — a record, not the `Map` the
 * table holds, because the two are different shapes and only one of them is
 * JSON. Per-entry sanitising is {@link rememberedWidthOverrides}'s.
 */
export const storedWidthOverrides = (projectId: string): Remembered<Record<string, number>> =>
  remembered(widthOverridesKey(projectId), isWidthOverrides);

/**
 * Where this browser remembers how tall one project's Gantt panel was dragged.
 *
 * Per project and per browser for {@link widthOverridesKey}'s reason: the
 * chart's share of the screen is one reader's answer, and be-01 is never told
 * about it.
 */
export const ganttHeightKey = (projectId: string): string => `wbs.ganttHeight.${projectId}`;

/**
 * One project's panel height, in bounds or not stored at all.
 *
 * The range is part of the guard rather than a check after it, for the reason
 * {@link remembered} states: a height outside the bounds a drag can reach is
 * not a height this app wrote, and `1e999` parses to an `Infinity` above every
 * ceiling.
 */
export const storedGanttHeight = (projectId: string): Remembered<number> =>
  remembered(
    ganttHeightKey(projectId),
    (claimed): claimed is number =>
      typeof claimed === 'number' && claimed >= GANTT_MIN_PX && claimed <= GANTT_CEILING_PX,
  );

/**
 * The panel height this browser last saved for `projectId`, or none where it
 * has never saved one.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary. Anything that is not a number inside the same range the drag
 * clamps to — {@link GANTT_MIN_PX} up to {@link GANTT_CEILING_PX}, the same
 * constants, so the two cannot drift apart — takes the key with it and the
 * panel opens at its default share. One comparison each way and no separate
 * finiteness test in front of them: `1e999` parses to `Infinity`, which is
 * above the ceiling exactly as `-Infinity` is below the floor, and JSON has no
 * `NaN` (the line that could not fail, `T1 column-widths-drag`).
 *
 * Deliberately not the "unknown is not OK" throw, for {@link
 * rememberedWidthOverrides}'s reason: the alternative is a chart nobody can
 * open until they clear storage by hand, over a preference about its height.
 */
export function rememberedGanttHeight(projectId: string): number | null {
  // Proof: the range dropped from `storedGanttHeight`'s guard, leaving
  // `typeof claimed === 'number'`. `refuses a height below the floor, and drops
  // the key` failed on `expected '10px' to be ''` and `refuses a height above
  // the ceiling, and drops the key` on `expected '99999px' to be ''` — the
  // panel drawn at the claimed height, the key still there. `refuses storage
  // that is not a number` stays green under that fault, which is why the range
  // is in the guard rather than beside it. Observed 2026-09-02; the original
  // watch of these two was 2026-08-10.
  return storedGanttHeight(projectId).readAndDrop();
}

/**
 * Writes the panel height in force for `projectId`.
 *
 * Called when a drag is let go of and at no other time, for {@link
 * rememberWidthOverrides}'s reason: opening a project must not change what is
 * remembered about it.
 */
export function rememberGanttHeight(projectId: string, heightPx: number): void {
  storedGanttHeight(projectId).write(heightPx);
}

/**
 * Where this browser remembers how wide one day of one project's chart is drawn.
 *
 * Per project for {@link ganttHeightKey}'s reason, and it is the same reason
 * rather than a similar one: a scale is **this plan's span against this
 * screen**, so a 74-day plan and a fortnight's worth of work want different
 * answers and neither is a preference about the feature. That is where it parts
 * from `wbs.ganttDetail`, which is one answer for the browser because turning
 * sixty elbows off is a statement about elbows.
 */
export const ganttDayPxKey = (projectId: string): string => `wbs.ganttDayPx.${projectId}`;

/** One project's day scale, judged against the same `DAY_SCALES` the control offers. */
export const storedGanttDayPx = (projectId: string): Remembered<DayPx> =>
  remembered(ganttDayPxKey(projectId), isDayPx);

/**
 * The day scale this browser last picked for `projectId`, or none where it has
 * never picked one — which opens the chart at {@link DAY_PX}.
 *
 * The stored value is a claim, not a fact: user-editable storage read at a
 * boundary. Checked with {@link isDayPx} against the same `DAY_SCALES` array
 * the control offers — **not** against a range — because the rungs are discrete
 * and a stored `9` is a width no control can get back to, so a chart opened at
 * it would be one nothing could return to a rung. Anything else takes the key
 * with it.
 *
 * Deliberately not the "unknown is not OK" throw, for
 * {@link rememberedGanttHeight}'s reason: the alternative is a chart nobody can
 * open until they clear storage by hand, over a preference about its zoom.
 */
export function rememberedGanttDayPx(projectId: string): DayPx | null {
  return storedGanttDayPx(projectId).readAndDrop();
}

/**
 * Writes the day scale in force for `projectId`.
 *
 * Called when the control is used and at no other time, for
 * {@link rememberGanttHeight}'s reason: opening a project must not change what
 * is remembered about it.
 */
export function rememberGanttDayPx(projectId: string, dayPx: DayPx): void {
  storedGanttDayPx(projectId).write(dayPx);
}

/** Forgets the remembered day scale for `projectId` — the third part of a {@link Layout reset}. */
export function forgetGanttDayPx(projectId: string): void {
  storedGanttDayPx(projectId).forget();
}

/**
 * Where this browser remembers whether one project's chart draws its row-name
 * column.
 *
 * Per project for {@link ganttDayPxKey}'s reason and the same one: the column
 * costs a fixed 176px whatever is in it, so whether that is worth paying is
 * **this plan's names against this screen** — a 74-day plan on a phone and a
 * fortnight on a monitor give opposite answers, and neither is a preference
 * about names. It parts from `wbs.ganttDetail` where the scale does.
 */
export const ganttLabelsKey = (projectId: string): string => `wbs.ganttLabels.${projectId}`;

/**
 * Whether one project's chart draws its name column.
 *
 * A boolean and nothing else to check: unlike a height there is no range, and
 * `false` is a real stored answer that a `??` would eat — which is why the
 * caller keeps the `boolean | null` this answers with.
 */
export const storedGanttLabels = (projectId: string): Remembered<boolean> =>
  remembered(
    ganttLabelsKey(projectId),
    (claimed): claimed is boolean => typeof claimed === 'boolean',
  );

/**
 * Whether this browser last left `projectId`'s row names shown, or none where
 * it has never said — which opens the chart with them shown.
 *
 * A boolean is the whole domain, so the guard is `typeof` and there is nothing
 * else to check: unlike a height there is no range and unlike a rung there is
 * no ladder, and `false` is a real stored answer that `??` would eat. Anything
 * that is not a boolean takes the key with it.
 *
 * Deliberately not the "unknown is not OK" throw, for
 * {@link rememberedGanttHeight}'s reason.
 */
export function rememberedGanttLabels(projectId: string): boolean | null {
  return storedGanttLabels(projectId).readAndDrop();
}

/**
 * Writes whether `projectId`'s row names are shown.
 *
 * Called when the control is used and at no other time, for
 * {@link rememberGanttDayPx}'s reason.
 */
export function rememberGanttLabels(projectId: string, labelsShown: boolean): void {
  storedGanttLabels(projectId).write(labelsShown);
}

/** Forgets the remembered name column for `projectId` — the fourth part of a {@link Layout reset}. */
export function forgetGanttLabels(projectId: string): void {
  storedGanttLabels(projectId).forget();
}

/**
 * Where this browser remembers what the two Mermaid exports group their bars
 * into sections by.
 *
 * **One key for the browser, not one per project**, and that is where it sides
 * with `wbs.ganttDetail` rather than with {@link ganttLabelsKey} above it. A
 * column's width or a panel's height is this plan's share of this screen, so it
 * is answered per plan; grouping a fence by assignee is an answer about **what
 * an exported document is for** — a reader who pastes lane-coloured charts into
 * a status update wants them lane-coloured in every plan, and having to say so
 * again in the next one is the fault this remembers away.
 */
export const MERMAID_SECTION_MODE_KEY = 'wbs.mermaidSectionMode';

/** The Mermaid lane, judged against the modes `sectionOf` has a branch for. */
export const storedMermaidSectionMode = remembered(MERMAID_SECTION_MODE_KEY, isSectionMode);

/**
 * The grouping this browser last picked for the Mermaid exports, or none where
 * it has never picked one — which exports under {@link DEFAULT_SECTION_MODE}.
 *
 * The stored value is a claim, not a fact: user-editable storage read at a
 * boundary. Checked with {@link isSectionMode} against the same
 * {@link SECTION_MODES} list the picker offers — **not** against `typeof
 * claimed === 'string'` — because a string that is not one of the three is a
 * grouping `sectionOf` has no branch for and the picker has no option for, so a
 * fence exported under it would be a document no control could get back to.
 * Anything else takes the key with it.
 *
 * Deliberately not the "unknown is not OK" throw, for
 * {@link rememberedGanttHeight}'s reason: the alternative is a plan nobody can
 * open until they clear storage by hand, over a preference about a `section`
 * line.
 */
export function rememberedMermaidSectionMode(): SectionMode | null {
  // Proof: `readAndDrop` replaced by `read`, which is what "read the claim,
  // drop nothing" comes to. `refuses a remembered lane this app does not offer,
  // and drops the key` failed on `expected '"assignees"' to be null` and
  // `refuses remembered lanes that are not JSON at all, and drops the key` on
  // `expected '{not json' to be null` — `2 failed | 6 passed`, the refused
  // answer left in storage to be read again next time. Note what did **not**
  // fail: the picker still read `outline`, because a `<select>` whose value
  // matches no option falls back to its first. The dropped key is the
  // observable half. Watched 2026-08-30.
  return storedMermaidSectionMode.readAndDrop();
}

/**
 * Writes the grouping the Mermaid exports are drawn with.
 *
 * Called when the picker is used and at no other time, for
 * {@link rememberGanttLabels}'s reason: opening a plan must not write to what
 * is remembered about it.
 */
export function rememberMermaidSectionMode(sectionMode: SectionMode): void {
  storedMermaidSectionMode.write(sectionMode);
}

/**
 * Forgets the remembered panel height for `projectId` — the chart half of a
 * {@link Layout reset}.
 *
 * `removeItem`, never a default written over it: what the panel returns to is
 * its default share as it stands then, exactly as the columns return to what
 * the frame layout resolves now.
 */
export function forgetGanttHeight(projectId: string): void {
  storedGanttHeight(projectId).forget();
}

/**
 * The plan as it stands when the key is read, which is before a single row has
 * arrived.
 *
 * A stored width is checked against the range a drag clamps to, and that range
 * is {@link floorFor} up to {@link WIDEST_COLUMN}. Neither end moves with the
 * plan — the only width that depends on it, `not-before`, is 56px or 84px and
 * so has the same 36px floor in both states — which is what lets this be read
 * at mount rather than deferred to the first render that knows the plan.
 * `table-frame.test.ts`'s `has a floor that does not move with the plan` is
 * what holds that true.
 */
export const STATE_AT_MOUNT: FrameLayoutState = { hasAnyNotBefore: false };

/**
 * Whether a value read back out of storage is a set of column widths at all.
 *
 * The whole-key question, asked before any single entry is: an array, a string
 * and a record of names are none of them a set of widths, and a table that
 * declared `widepx` for a column would be laid out by nothing at all.
 */
export function isWidthOverrides(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((width) => typeof width === 'number');
}

/**
 * The column widths this browser last saved for `projectId`, or none where it
 * has never saved any.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary — and it is validated in two rounds, because the two failures are
 * different. Storage that is not a set of widths takes the key with it, as a
 * remembered expansion that is not one does. A single entry that cannot be
 * used is dropped **on its own**, and the entries beside it still apply: one
 * hand-edited number is no reason to forget the other four columns.
 *
 * Two things disqualify an entry, and each is a line with a negative test of
 * its own (`wbs-table.test.tsx`, `the widths this browser has dragged`):
 *
 * - an id the frame layout cannot size, which would throw out of the render
 *   that tried to lay it out;
 * - a width outside the range a drag can produce, read from the same
 *   {@link floorFor} and {@link WIDEST_COLUMN} the drag clamps to, so the two
 *   cannot drift apart.
 *
 * **Two, not the three this was written with.** A `Number.isFinite(width)` line
 * stood between these until its negative was watched — and passed with the line
 * deleted. It could not fail: `1e999` is the only non-finite width JSON can
 * express, it parses to `Infinity`, and `Infinity` is above every ceiling just
 * as `-Infinity` is below every floor. JSON has no `NaN` for the case it would
 * have been about. The range check below is what really refuses both, and it is
 * the line the negative watches. R5, and `P phases-ui`'s sanitizer before it.
 *
 * An id naming a step this project no longer holds survives all three and is
 * then never looked at — the harmlessness a remembered expansion's deleted row
 * ids have, and the reason the step coming back finds its width waiting.
 *
 * Deliberately not the "unknown is not OK" throw, for {@link
 * rememberedExpansion}'s reason: the alternative is a plan nobody can open
 * until they clear storage by hand, over a preference about a column.
 */
export function rememberedWidthOverrides(projectId: string): Map<string, number> {
  const claimed = storedWidthOverrides(projectId).readAndDrop();
  if (claimed === null) return new Map();
  const kept = new Map<string, number>();
  for (const [columnId, width] of Object.entries(claimed)) {
    if (!sizableColumn(columnId, STATE_AT_MOUNT)) continue;
    // One comparison each way, and no separate finiteness test in front of
    // them: see the note above about the line that could not fail. The range
    // is each column's own: `name` reads its 200px flexible floor here, so a
    // stored Name entry is judged by the same rule as everything else.
    // Proof: the check bypassed for `name`, `drops a stored Name width
    // outside Name's own bounds, each end on its own` failed on `expected
    // '150px' to be ''` — a hand-edited 150 laid onto the Name cells below
    // the floor no drag can pass. Watched, 2026-08-10.
    if (width < floorFor(columnId, STATE_AT_MOUNT) || width > WIDEST_COLUMN) continue;
    kept.set(columnId, width);
  }
  return kept;
}

/**
 * Writes the widths in force for `projectId`.
 *
 * Called when a drag is let go of and at no other time. In particular the
 * sanitized set is **not** written back on read: opening a project must not
 * change what is remembered about it, and a write-back would quietly discard
 * the entry for a step that is only temporarily absent.
 */
export function rememberWidthOverrides(
  projectId: string,
  overrides: ReadonlyMap<string, number>,
): void {
  storedWidthOverrides(projectId).write(Object.fromEntries(overrides));
}

/**
 * Forgets every remembered width for `projectId` — the widths half of a
 * {@link Layout reset}.
 *
 * `removeItem`, never an empty object written over it. What the columns return
 * to is whatever the frame layout resolves for them *now*, and a snapshot
 * stored here is that promise broken: a column whose default has changed since
 * the drag would come back to the old one.
 */
export function forgetWidthOverrides(projectId: string): void {
  storedWidthOverrides(projectId).forget();
}

/**
 * Where this browser remembers which of one project's columns a reader has
 * hidden — the {@link Hidden column}s that, taken off the default column set,
 * are that reader's {@link Column set}.
 *
 * Per project and per browser for {@link widthOverridesKey}'s reason: which
 * columns a reader wants on their screen is their answer, and be-01 is never
 * told about it.
 */
export const hiddenColumnsKey = (projectId: string): string => `wbs.hiddenColumns.${projectId}`;

/** One project's hide-list, judged by {@link isStringArray}. */
export const storedHiddenColumns = (projectId: string): Remembered<readonly string[]> =>
  remembered(hiddenColumnsKey(projectId), isStringArray);

/** A reset that showed Links survives reload without freezing the whole hide-list. */
export const linksResetShownKey = (projectId: string): string => `wbs.linksResetShown.${projectId}`;

export const storedLinksResetShown = (projectId: string): Remembered<true> =>
  remembered(linksResetShownKey(projectId), (value): value is true => value === true);

/**
 * The hide-list this browser last saved for `projectId`, or the default hidden
 * columns where it has never saved one.
 *
 * A **hide-list**, so a column this table learns to draw later is on screen by
 * default without anybody's storage being touched; and an absent key means
 * {@link DEFAULT_HIDDEN_COLUMNS}, while a stored `[]` means "everything shown"
 * — the two are different facts and this is where they part.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary, the posture {@link rememberedWidthOverrides} takes. A value that is
 * not a list of strings takes the key with it and the default set is shown. An
 * id the table does not declare is **not** judged here: a step's id is only
 * known once the steps have loaded, so the list is kept whole and
 * `hiddenColumnIds` in the component filters it against
 * {@link hideableColumnIds} on every render that could change the answer. It
 * is also not written back — opening a project must not change what is
 * remembered about it, and a hidden step that is only temporarily absent must
 * find its entry waiting.
 *
 * Deliberately not the "unknown is not OK" throw, for {@link
 * rememberedWidthOverrides}'s reason: the alternative is a plan nobody can open
 * until they clear storage by hand, over a preference about a column.
 *
 * Proof: the shape check deleted, `clears a store that is not a list of strings
 * and shows the default set` (wbs-table.test.tsx) failed with `TypeError:
 * storedHiddenColumns.filter is not a function` — the `'4'` handed to the
 * component as a list; with only the `removeItem` deleted, on `expected '4' to
 * be null`. Watched, 2026-08-28.
 */
export function rememberedHiddenColumns(projectId: string): readonly string[] {
  const explicit = storedHiddenColumns(projectId).readAndDrop();
  if (explicit !== null) return explicit;
  return storedLinksResetShown(projectId).readAndDrop() === true
    ? resetHiddenColumns(true)
    : INITIAL_HIDDEN_COLUMNS;
}

/**
 * Writes the hide-list in force for `projectId`.
 *
 * Called when a reader ticks or unticks a column in the Columns control, or
 * applies a saved view that carries a column set, and at no other time — see
 * {@link rememberedHiddenColumns} for why not on read.
 */
export function rememberHiddenColumns(projectId: string, hidden: readonly string[]): void {
  storedHiddenColumns(projectId).write(hidden);
  storedLinksResetShown(projectId).forget();
}

/**
 * Forgets which columns are hidden for `projectId` — the columns half of a
 * {@link Layout reset}.
 *
 * `removeItem`, never the default list written over it: the default column set
 * is whatever {@link DEFAULT_HIDDEN_COLUMNS} says *now*, and a snapshot stored
 * here is that promise broken the day the default moves.
 */
export function forgetHiddenColumns(projectId: string): void {
  storedHiddenColumns(projectId).forget();
}

/** Remembers only the reset outcome that differs from the initial hidden-Links baseline. */
export function rememberLinksResetTarget(projectId: string, hasAnyExternalRefs: boolean): void {
  const marker = storedLinksResetShown(projectId);
  if (hasAnyExternalRefs) marker.write(true);
  else marker.forget();
}

/**
 * A named filter this browser has saved, so it can be picked again later —
 * R10 F4 — with, since `configurable-columns`, the {@link Column set} that was
 * on screen when it was saved. Not the expansion, not the column widths. A
 * saved view is *how one reader is looking at a plan*, the exact phrase
 * `planForExport` uses to justify not exporting a collapsed branch or a running
 * search — so it lives here, per browser, beside every other display
 * preference, and be-01 is never told about it.
 *
 * `hiddenColumnIds` is optional because views saved before it existed have
 * none, and absent means what it meant then: this view says nothing about
 * columns, and applying it leaves them as they are. Present, it is the whole
 * hide-list to apply — `[]` shows everything.
 */
export interface SavedView {
  id: string;
  name: string;
  criteria: FilterCriteria;
  hiddenColumnIds?: readonly string[];
}

/**
 * Where this browser remembers one project's saved views.
 *
 * Per project and per browser, exactly as {@link widthOverridesKey} beside
 * it: a view is one reader's own named answer to "what am I looking at",
 * and it must not appear in front of a different reader who opens the same
 * plan on their own machine.
 */
export const savedViewsKey = (projectId: string): string => `wbs.views.${projectId}`;

/**
 * One project's saved views, as a **list of anything** — each entry is judged
 * by {@link isSavedView} in {@link rememberedSavedViews}, which keeps the ones
 * that are views rather than dropping the whole key over one bad entry.
 */
export const storedSavedViews = (projectId: string): Remembered<readonly unknown[]> =>
  remembered(savedViewsKey(projectId), (claimed): claimed is unknown[] => Array.isArray(claimed));

/** Whether a claimed value is a list of strings — a facet's chosen ids. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'string');
}

/**
 * Whether a claimed value is a facet list that **was not stored at all** — the
 * state a view saved before that facet existed is in.
 *
 * Absent is usable and means "this view asks nothing about that facet", which
 * is what it did mean when it was saved. Present-but-wrong is not: a
 * hand-edited `tagIds: 3` is a view this table cannot apply, and it is dropped
 * with the rest of the unusable ones.
 */
export function isAbsentOrStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

/**
 * The same tolerance for a facet that is a **flag** rather than a list — the
 * two mismatch signals, added 2026-08-21.
 *
 * Its own function rather than a widened {@link isAbsentOrStringArray}, because
 * a view storing `builtByNonOwner: []` is malformed and a check that accepted
 * either shape would apply it as `false` instead of dropping it.
 */
export function isAbsentOrBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/**
 * Whether a claimed value has every field {@link FilterCriteria} declares —
 * treating a facet **added after this view was saved** as absent rather than as
 * malformed.
 *
 * `saved-views` shipped on 2026-08-19 (#83) and `tags` added a facet on
 * 2026-08-20, so between those two dates a reader could save a view that has no
 * `tagIds` in it. Requiring the field outright would have made every one of
 * those views unusable, and `rememberedSavedViews` drops what it cannot use —
 * so the tool would have deleted somebody's saved filters because a feature
 * they never asked for shipped. Each new facet joins this list the same way.
 *
 * Found by `drops one unusable saved view and keeps the rest`, which crashed on
 * `Cannot read properties of undefined (reading 'length')` inside `filterWords`
 * rather than failing an assertion — the shape check passed a view the rest of
 * the module could not read. Watched 2026-08-20.
 */
export function isFilterCriteriaShape(value: unknown): value is FilterCriteria {
  if (typeof value !== 'object' || value === null) return false;
  const claimed = value as Record<string, unknown>;
  return (
    typeof claimed['query'] === 'string' &&
    isStringArray(claimed['teamIds']) &&
    isAbsentOrStringArray(claimed['tagIds']) &&
    isAbsentOrStringArray(claimed['serviceIds']) &&
    isAbsentOrBoolean(claimed['builtByNonOwner']) &&
    isAbsentOrBoolean(claimed['assignedOutsideTeam']) &&
    isStringArray(claimed['assigneeIds']) &&
    isStringArray(claimed['priorityBands']) &&
    isStringArray(claimed['estimatedStepIds']) &&
    typeof claimed['unestimated'] === 'boolean' &&
    typeof claimed['critical'] === 'boolean'
  );
}

/**
 * One stored view's criteria with every facet present, whatever the storage
 * held.
 *
 * The **one** place a stored view becomes a `FilterCriteria` the rest of this
 * module may assume is whole. `filterWords`, `narrowTree` and the facet panel
 * all read `criteria.tagIds.length` without checking, and they are right to:
 * the type says it is there. This is what makes the type true at the boundary,
 * which is where user-editable storage is turned into a fact.
 *
 * Spread over {@link NO_FILTER} rather than field by field, so a facet added
 * later is defaulted here without this function being touched again.
 */
export function everyFacetOf(criteria: FilterCriteria): FilterCriteria {
  return { ...NO_FILTER, ...criteria };
}

/** Whether a claimed value is one saved view this table can offer and apply. */
export function isSavedView(value: unknown): value is SavedView {
  if (typeof value !== 'object' || value === null) return false;
  const claimed = value as Record<string, unknown>;
  const name = claimed['name'];
  return (
    typeof claimed['id'] === 'string' &&
    typeof name === 'string' &&
    name.trim() !== '' &&
    isFilterCriteriaShape(claimed['criteria']) &&
    // Absent is a view from before column sets; present-but-wrong is a view
    // this table cannot apply, dropped with the other unusable ones.
    // Proof: this line deleted, `drops a view whose column set is not a list
    // of strings, and keeps the one beside it` failed on `Unable to find an
    // element with the text: Views (1)` — both offered. Watched, 2026-08-28.
    isAbsentOrStringArray(claimed['hiddenColumnIds'])
  );
}

/**
 * The views this browser last saved for `projectId`, or none where it has
 * never saved any.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary, the same posture {@link rememberedWidthOverrides} takes. Storage
 * that is not an array at all takes the key with it; a single entry that is
 * not a usable view is dropped **on its own**, and the views beside it still
 * apply — one hand-edited view is no reason to forget the rest.
 *
 * A view naming a team, a person or a step this project no longer holds
 * survives this check and is simply never a live checkbox: applying it ticks
 * a box the facet panel already knows how to draw for an absent value
 * (`optionsFor`, "a team this plan has not loaded"), and narrowing by an id
 * no row carries answers empty — the same "empty means empty" rule any other
 * facet with nothing left to match gets. Nothing here repairs or deletes the
 * view on the reader's behalf.
 */
export function rememberedSavedViews(projectId: string): SavedView[] {
  const claimed = storedSavedViews(projectId).readAndDrop();
  if (claimed === null) return [];
  return claimed
    .filter(isSavedView)
    .map((view) => ({ ...view, criteria: everyFacetOf(view.criteria) }));
}

/**
 * Writes the saved views in force for `projectId`.
 *
 * Called on Save and on Delete, and at no other time — same as {@link
 * rememberWidthOverrides}, opening a project must not change what it
 * remembers about it, and the sanitized set from {@link rememberedSavedViews}
 * is never written back on a read.
 */
export function rememberSavedViews(projectId: string, views: readonly SavedView[]): void {
  storedSavedViews(projectId).write(views);
}
