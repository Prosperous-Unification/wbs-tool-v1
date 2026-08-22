import { Fragment, useState } from 'react';

import type { Days, PriorityBandView, RoleView } from '@/lib/wbs-api';

import { ActionsMenu, type RowAction } from './actions-menu';
import { CellInput } from './cell-input';
import type { CellRef } from './cell-navigation';
import { PickerList, type PickerOption } from './creatable-picker';
import { type CellElement, cellKey } from './editable-grid';
import { POINTS } from './estimate-draft';
import type { ServiceLabel, ServiceTeamLabel, TagLabel } from './gantt-geometry';
import { type CommitOutcome, flushCell } from './live-editing';
import { composeNameCell } from './name-notes';
import { priorityBandStyleOf } from './priority-band-style';
import type { PrintedDay } from './short-date';
import { cardIndentFor } from './table-frame';
import type { TreeRow } from './wbs-rows';

/** One work item as the list draws it: the row, where it sits, and its branch. */
export interface CardRow {
  row: TreeRow;
  /** How deep in the outline it is, which is the card's indent. */
  depth: number;
  /** Whether it has children this list can hide. False while a filter is on. */
  expandable: boolean;
  expanded: boolean;
  toggleBranch: () => void;
  /**
   * Whether this row answered the filter itself, rather than being one of the
   * rows kept to place it.
   *
   * The table's Name cell has carried this since `find-in-the-tree`
   * (`data-match`), and until R10 the mark was table-only — so a phone, which
   * is the only face some readers have, showed a narrowed list with no way to
   * tell a hit from the ancestors around it. False for every card while no
   * filter is on, when marking anything would make the mark mean nothing.
   */
  matched: boolean;
}

/**
 * Who is doing one phase of one work item, as a card prints it.
 *
 * `assumed` is the derived reading — nobody named on this phase and exactly one
 * person named on another — and it is why this is one answer with a flag rather
 * than two questions: the rule that a lone assignee is taken to be doing every
 * phase belongs to be-01 and is computed once by whoever hands this over, not
 * twice by two renderers.
 */
export interface CardAssignee {
  name: string;
  assumed: boolean;
  /**
   * Why this person is marked as assigned outside the team — the whole
   * sentence, or `null` where they are not (task 7.2).
   *
   * The sentence and not a boolean, so every surface showing this person shows
   * the same words: a flag would be three renderers each writing their own
   * wording for one rule, which is the drift `label-mismatch.ts` refuses a
   * third export to prevent.
   */
  outside: string | null;
}

export interface PlanCardsProps {
  /** The rows on screen, in the order and the expansion the table model gives them. */
  rows: readonly CardRow[];
  roles: readonly RoleView[];
  /**
   * This plan's priority ladder, for the chip on each card's header.
   *
   * The cards are the only face some readers have — a phone shows no table and
   * no chart — so a priority that were a bare number here would be the one face
   * where Dany's _"ui must display differently for different priorities"_ did
   * not land. The colour and the label come from `priorityBandStyleOf`, the same
   * one resolution the table's cell, the chart's bars and the export read.
   */
  priorityBands: readonly PriorityBandView[];
  /**
   * Takes the list element, which is this renderer's `[data-grid]`.
   *
   * A callback rather than a ref object because the holder's ref is an
   * `HTMLElement` — it is a `<table>` under the other renderer — and React's
   * `Ref<HTMLDivElement>` will not take one.
   */
  gridRef: (node: HTMLElement | null) => void;
  /** The name and the notes as one text, and what be-01 did with them. */
  commitName: (rowId: string, typed: string, baseline: string) => Promise<CommitOutcome>;
  /**
   * Offers a box that is attaching to whatever focus a structural edit asked
   * for — {@link import('./live-editing').FocusIntent.landOnAttached}.
   */
  claimFocus: (node: CellElement, cell: CellRef) => void;
  /** What one phase's figure box shows: the pending shorthand, or the final figure. */
  estimateValue: (row: TreeRow, roleId: string) => string;
  /** What is wrong with what that box shows, or null. */
  estimateProblem: (row: TreeRow, roleId: string) => string | null;
  commitEstimate: (
    row: TreeRow,
    roleId: string,
    typed: string,
    baseline: string,
  ) => Promise<CommitOutcome>;
  /** The focus arriving in a figure box, which is what remembers its value. */
  enterEstimate: (box: CellElement) => void;
  /** A keystroke in one, which is what opens and closes the `@` list. */
  readEstimate: (rowId: string, roleId: string, box: CellElement) => void;
  /** Escape: the list closes and the box is left exactly as it is. */
  closeMention: () => void;
  /** The focus leaving a figure box, which takes a half-typed `@` with it. */
  leaveEstimate: () => void;
  /** What the `@` list in one box is offering, or nothing while it is closed. */
  mentionOptions: (row: TreeRow, roleId: string) => PickerOption[];
  assigneeOn: (row: TreeRow, roleId: string) => CardAssignee | null;
  /** The numbers of the work items this one waits for. */
  waitsFor: (row: TreeRow) => string[];
  /**
   * Whose work this is: the row's own label, the one it inherits, or neither.
   *
   * The **effective** team and not the stored label, and it is the same
   * function the table's cell and the chart's bars read
   * (`effectiveTeamLabelOf`). A phone shown the stored label alone would say
   * nothing at all about a leaf under a labelled parent, whose dates came out
   * of that parent's pool — and a card is the only face some readers have.
   */
  teamLabel: (row: TreeRow) => ServiceTeamLabel;
  /**
   * What kind of thing this row is: its own tags, the ones it inherits, or
   * neither.
   *
   * Its own prop beside {@link teamLabel} rather than folded into it, because
   * the two dimensions are independent — a row states either, both or neither —
   * and a phone is the only face some readers have. A card showing a team and
   * silently dropping the tags would be the one surface that cannot answer
   * "what sort of work is this".
   *
   * A **set**, unlike the team's, and that is not a temporary difference: a
   * work item carries as many tags as somebody put on it, and there is no
   * `at(0)` anywhere in this dimension to grow out of later.
   */
  tagLabel: (row: TreeRow) => TagLabel;
  /**
   * What this row delivers: its own services, the ones it inherits, or neither
   * (task 7.3).
   *
   * The third prop rather than a third arm on either of the other two, for
   * {@link tagLabel}'s reason one dimension over: the three are independent, a
   * row states any of them, and the card is the only face some readers have. A
   * phone that names a team and a tag while dropping the service is the surface
   * that cannot answer "what is this work for" — which is the question the
   * split exists to make askable.
   *
   * **No mismatch marker rides this chip**, and that is still a decision rather
   * than an omission. 7.2's rule is that a marker carries the sentence saying
   * why, and both signals — `builtByNonOwner` here, `assignedOutsideTeam` on
   * the assignee — are one vocabulary. Marking the service chip alone would put
   * one half of a paired signal on a face that stays silent about the other,
   * which reads as "this row's people are fine" to a reader who has no table to
   * check against. Both land together, and since `phone-mismatch-markers` they
   * do: not on this chip, but under the chips as sentences — see
   * {@link PlanCardsProps.nonOwner}.
   */
  serviceLabel: (row: TreeRow) => ServiceLabel;
  /**
   * Why this row's work is marked as built by a non-owner — the whole sentence,
   * or `null` where it is not (task `phone-mismatch-markers`).
   *
   * The sentence and not a boolean, for {@link CardAssignee.outside}'s reason
   * one signal over: two surfaces phrasing one rule two ways is the drift
   * `label-mismatch.ts` refuses a third export to prevent. `wbs-table.tsx`
   * builds both, this renderer prints them, and neither asks the domain twice.
   */
  nonOwner: (row: TreeRow) => string | null;
  /**
   * When this work item happens: short dates on a plan with a start date, day
   * offsets without.
   *
   * The table's own function, not a card-shaped copy of it. One plan read on a
   * phone and on a laptop may not disagree about how a day is written.
   */
  spanOf: (row: TreeRow) => { start: PrintedDay; finish: PrintedDay };
  /** A figure as the table prints one, so two renderers cannot round differently. */
  showDay: (days: number) => string;
  /**
   * The row actions a phone could not reach until now — Duplicate, Unfreeze
   * (frozen rows only) and Delete, in the table's own `ActionsMenu` and the
   * table's own words, refusing Delete on a frozen row with the table's own
   * sentence (`wbs-table.tsx`'s `actions` column). One vocabulary, not two.
   *
   * Optional and additive: `wbs-table.tsx` is two other agents' file tonight
   * (`notes/wbs-plan-2026-08-14-mobile-parity.md` M2's file split), so wiring
   * real callbacks into its `<PlanCards>` call site is a follow-up left for
   * when the file frees up. Absent, a card prints no ⋯ button at all rather
   * than one that opens onto nothing.
   */
  rowActions?: CardRowActionHandlers;
}

/** What the ⋯ menu needs to act on a row — nothing about which menu is open, which this component holds itself, since cards and the table never show at once. */
export interface CardRowActionHandlers {
  /** A request from any row's menu is in flight, the table's own `busy`. */
  busy?: boolean;
  duplicate: (rowId: string) => void;
  unfreeze: (rowId: string) => void;
  remove: (row: TreeRow) => void;
}

/**
 * The ⋯ menu's items for one row, built the same way `wbs-table.tsx`'s own
 * `ActionsMenu` usage builds them — same three ids, same labels, same order,
 * same refusal sentence on a frozen row — so a phone and a laptop read one
 * menu rather than a card inventing a second one.
 */
const cardRowActions = (row: TreeRow, handlers: CardRowActionHandlers): RowAction[] => [
  {
    id: 'duplicate',
    label: 'Duplicate',
    run: () => {
      handlers.duplicate(row.id);
    },
  },
  ...(row.frozenNumber === null
    ? []
    : [
        {
          id: 'unfreeze',
          label: 'Unfreeze',
          run: () => {
            handlers.unfreeze(row.id);
          },
        },
      ]),
  {
    id: 'delete',
    label: 'Delete',
    ...(row.frozenNumber === null
      ? {}
      : { refusedBecause: 'Frozen — unfreeze this row before deleting it' }),
    run: () => {
      handlers.remove(row);
    },
  },
];

/**
 * What a card's span says in full, or nothing where there is nothing fuller to
 * say.
 *
 * Both ends in one attribute because a card has one span, and the ends can
 * disagree about whether they are dates at all — a schedule that failed
 * computes neither.
 */
const cardSpanTitle = (span: { start: PrintedDay; finish: PrintedDay }): string | undefined =>
  span.start.iso === null || span.finish.iso === null
    ? undefined
    : `${span.start.iso} → ${span.finish.iso}`;

/**
 * Whether a row's stored parallelism decides nothing, and the card therefore
 * has to say so beside the number.
 *
 * Two ways to get there and the reasons differ, but the reading is one: a
 * parent holds no slices of its own, so the number is inert on it (be-01
 * refuses new ones with `has_children`, and a leaf that later gained a child
 * keeps whatever it was given); and a row somebody is named on runs at width 1
 * whatever the number says, because one human cannot work beside themselves.
 *
 * Read off the row rather than passed in, because both facts are on it: this is
 * the same reading the table's In-parallel cell makes and it is deliberately
 * not routed through a prop, which would be a second place for the two faces to
 * disagree.
 */
const inertParallel = (row: TreeRow): boolean =>
  row.subRows.length > 0 || row.doesEveryPhase !== null;

/**
 * What the table's Slack column says about one row, read off the row the same
 * way the cell does — `critical` replaces the figure outright, and both
 * `title`s are the column's own sentences, so a reader of both faces meets one
 * vocabulary rather than a second one this card invented.
 */
const cardSlackOf = (
  row: TreeRow,
  showDay: (days: number) => string,
): { text: string; critical: boolean; title: string } => {
  if (row.schedule.critical) {
    return {
      text: 'critical',
      critical: true,
      title: 'On the critical path: any delay here moves the whole plan’s finish.',
    };
  }
  const days = showDay(row.schedule.float);
  return {
    text: `${days}d slack`,
    critical: false,
    title: `This work item can slip ${days} workday${days === '1' ? '' : 's'} before the plan finishes later.`,
  };
};

/**
 * The two mismatch signals as this card says them: the sentences, in one
 * vocabulary, or an empty list where the row is clean (`phone-mismatch-markers`).
 *
 * **Both signals or neither**, which is the rule {@link PlanCardsProps.nonOwner}
 * was added to keep: the service half and the assignee half are one signal
 * wearing two faces, and a card that showed one would tell a reader with no
 * table that the other is fine. So they are gathered in one place, printed by
 * one loop, and there is no arm here that can render one without the other.
 *
 * The assignee half is **deduplicated by sentence**, not by phase. One person
 * outside the team, named on Dev and assumed onto QA, is one fact about this
 * row; three phases would print the same words three times under a card that is
 * 390px wide, and a signal repeated is a signal a reader stops reading.
 *
 * Ordered service-then-assignee, matching the order `wbs-table.tsx` meets them
 * in left to right — the Services column sits before the assignee cells — so
 * the two faces of one plan say the two facts in one sequence.
 */
const cardMismatchesOf = (
  row: TreeRow,
  roles: readonly RoleView[],
  nonOwner: (row: TreeRow) => string | null,
  assigneeOn: (row: TreeRow, roleId: string) => CardAssignee | null,
): { kind: 'service' | 'assignee'; note: string }[] => {
  const built = nonOwner(row);
  const outside = [
    ...new Set(
      roles
        .map((role) => assigneeOn(row, role.id)?.outside)
        .filter((note): note is string => note !== undefined && note !== null),
    ),
  ];
  return [
    ...(built === null ? [] : [{ kind: 'service' as const, note: built }]),
    ...outside.map((note) => ({ kind: 'assignee' as const, note })),
  ];
};

/**
 * One point of one phase's trio, off the row rather than a box's draft —
 * `wbs-table.tsx`'s own `showDays`, so a phase estimated on the table and one
 * estimated on a phone cannot print the point differently.
 *
 * Takes the possibly-missing estimate as a parameter rather than reading
 * `row.estimates[roleId]` into a local first: a bare `Record<string, Days>`
 * index reads as always-present to the type checker once assigned to a
 * `const`, which is not true of a role nobody has estimated.
 */
const trioPoint = (estimate: Days | undefined, point: (typeof POINTS)[number]): string =>
  estimate === undefined ? '' : String(estimate[point]);

/** A phase's final figure, off the row — `wbs-table.tsx`'s own `showFinal`. */
const trioFinal = (finalDays: number | undefined, showDay: (days: number) => string): string =>
  finalDays === undefined ? '' : showDay(finalDays);

/**
 * One phase's `o/r/p` breakdown, said in the words `folded-role-card.tsx`
 * already prints on the table's hover card — this is the same read of the
 * same fields, not a second copy of "no estimate yet".
 */
const cardTrioOf = (
  row: TreeRow,
  roleId: string,
  showDay: (days: number) => string,
): { line: string; final: string } => {
  const points = POINTS.map((point) => ({ point, days: trioPoint(row.estimates[roleId], point) }));
  const estimated = points.some((each) => each.days !== '');
  return {
    line: estimated
      ? points.map((each) => `${each.point} ${each.days === '' ? '—' : each.days}`).join(' · ')
      : 'No estimate yet',
    final: trioFinal(row.finalDays[roleId], showDay),
  };
};

/** A tap target big enough to hit — 44px, which is `min-h-11` in this scale. */
const TAP = 'min-h-11';

/**
 * What a card that answered the filter is tinted.
 *
 * The **same custom property** `wbs-table.tsx`'s Name cell paints a match with
 * (`--grid-match`, `styles.css`), read here rather than imported: `wbs-table`
 * imports this file, so a constant taken from it would be a cycle. One colour
 * defined once in the stylesheet, two faces reading it — not two colours that
 * agree today.
 */
const MATCH_TINT = 'var(--grid-match)';

/**
 * The plan as a list of outline cards: what a phone gets instead of the table.
 *
 * **The same plan, not a summary of it.** Every card is a work item of the same
 * row model the table draws, at the same depth, in the same order, with the
 * same branches open — `WbsTable` builds that once and hands it to whichever
 * renderer the viewport asked for (`plan-renderer.ts`).
 *
 * **The same cells, too**, and that is the contract worth reading. Each box
 * carries the `data-cell` of the cell it edits — `rowId::name`, and
 * `rowId::<roleId>-final` for a phase's figure — which is the *same* string the
 * table's box for that cell carries. So the {@link import('./live-editing').LiveField}
 * a card mounts is the one the table mounted, and a draft be-01 refused is
 * still there when a phone is turned. That is the whole of what
 * `X live-editing-extraction` was for.
 *
 * **Three things are editable and nothing else is**: the name-and-notes box,
 * each phase's `o/r/p` figure, and — through the `@` list inside that figure's
 * box — who is on that phase. The dependencies, the team, the not-before date
 * and the three separate points are printed and not typed into: each is a
 * picker or a date field, and each is its own touch design.
 *
 * **No drag handle and no keyboard grid.** A phone has no pointer to drag a row
 * with and no Tab key to walk a grid with, so none of `onTabKey`, `onArrowKey`,
 * `onCommandKey` or `onAltMove` is wired here. The list is still marked as the
 * grid — the focus a create asks for has to be able to find a card — but
 * nothing on a card claims a key for moving between cells.
 *
 * **Structure moves through a menu, not a gesture.** Duplicate, Unfreeze and
 * Delete were reachable only from the table's `actions` column; each card now
 * carries the same `ActionsMenu` behind its own ⋯, one per row rather than one
 * for the table. Indent, outdent and reordering are a later slice
 * (`mobile-structure-menu`) — this one is the three actions the table already
 * had, not a fourth.
 */
export function PlanCards({
  rows,
  roles,
  priorityBands,
  gridRef,
  commitName,
  claimFocus,
  estimateValue,
  estimateProblem,
  commitEstimate,
  enterEstimate,
  readEstimate,
  closeMention,
  leaveEstimate,
  mentionOptions,
  assigneeOn,
  waitsFor,
  teamLabel,
  tagLabel,
  serviceLabel,
  nonOwner,
  spanOf,
  showDay,
  rowActions,
}: PlanCardsProps) {
  /**
   * Which row's ⋯ menu is open, held here rather than threaded through a prop:
   * cards and the table are never both on screen (`plan-renderer.ts`), so
   * there is no second menu anywhere to keep this one in step with.
   */
  const [openActionsRowId, setOpenActionsRowId] = useState<string | null>(null);
  return (
    /*
      `data-grid` for the same two reasons the `<table>` carries it: it scopes
      the vendored components' reset away from the boxes (`styles.css`), and
      since `X live-editing-extraction` it is how `editable-grid.ts` finds the
      grid at all. A card list that did not carry it would be a plan whose
      cells nothing could find — no focus after a create, no readiness walk.
    */
    <div
      data-grid
      data-plan-cards
      ref={gridRef}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2"
    >
      {rows.map(({ row, depth, expandable, expanded, toggleBranch, matched }) => {
        const waits = waitsFor(row);
        const team = teamLabel(row);
        const tags = tagLabel(row);
        const delivers = serviceLabel(row);
        const span = spanOf(row);
        const slack = cardSlackOf(row, showDay);
        const mismatches = cardMismatchesOf(row, roles, nonOwner, assigneeOn);
        return (
          <article
            key={row.id}
            data-card={row.id}
            data-frozen={row.frozenNumber !== null ? 'true' : 'false'}
            // The table's own attribute and the table's own reading: present
            // only on a row that answered the filter itself, absent — not
            // `false` — on the rows kept around it, so `[data-match]` selects
            // the hits on either face.
            data-match={matched ? 'true' : undefined}
            aria-label={`Work item ${row.number}`}
            // The outline, kept: a card list with no indent is a flat list of
            // rows whose numbers are the only thing saying what is under what.
            // `cardIndentFor` — the cards' own cap over the uncapped step: two
            // levels past the Number column's, because nothing here overlaps,
            // and no further, because the margin comes out of a 390px phone.
            // The `min-w-0` chain still keeps a card from shrinking under its
            // own content.
            style={{
              marginLeft: cardIndentFor(depth),
              // The whole card and not one field of it: a card has no Name
              // column to tint, and the name is one of seven things a filter
              // can have matched on — tinting the name box for a row that
              // matched on its team would point at the wrong fact.
              ...(matched ? { background: MATCH_TINT } : {}),
            }}
            className="border-border bg-card flex min-w-0 flex-col gap-2 rounded-lg border p-3"
          >
            <header className="flex items-center gap-2">
              {expandable && (
                <button
                  type="button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.number}`}
                  className={`${TAP} min-w-11 shrink-0 rounded-md border`}
                  onClick={toggleBranch}
                >
                  {expanded ? '▾' : '▸'}
                </button>
              )}
              {row.frozenNumber !== null && <span aria-label="Number is frozen">🔒</span>}
              <span data-number className="font-semibold">
                {row.number}
              </span>
              {/*
                The band, where somebody has prioritised this row, as a chip in
                its own colour — and **nothing at all** where nobody has, which is
                the bargain every other face makes with an unprioritised row. It
                carries the number as well as the name because the number is what
                the table and the export show, and a phone reader comparing two
                screens must not have to work out which `High` is 30.
              */}
              {(() => {
                const paint = priorityBandStyleOf(priorityBands, row.priority);
                if (paint === null) return null;
                return (
                  <span
                    data-card-priority={row.id}
                    data-priority-rank={paint.rank}
                    title={paint.words}
                    className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ color: paint.ink, background: paint.tint }}
                  >
                    {paint.label} {row.priority}
                  </span>
                );
              })()}
              <span data-final-total className="text-muted-foreground ml-auto text-sm">
                {showDay(row.finalTotal)} d
              </span>
              {rowActions !== undefined && (
                <ActionsMenu
                  number={row.number}
                  open={openActionsRowId === row.id}
                  busy={rowActions.busy ?? false}
                  touchSized
                  onOpen={() => {
                    setOpenActionsRowId(row.id);
                  }}
                  onClose={() => {
                    setOpenActionsRowId((current) => (current === row.id ? null : current));
                  }}
                  actions={cardRowActions(row, rowActions)}
                />
              )}
            </header>

            {/*
              The name and the notes in one box, exactly as the table holds them
              (`name-notes.ts`): the first line is the name and everything under
              it is the note. Taller at rest than the table's, because a phone
              is narrow and a name wraps sooner.
            */}
            <CellInput
              aria-label={`Name of ${row.number}`}
              cellKey={cellKey(row.id, 'name')}
              multiline
              autoSize
              rows={2}
              maxRestRows={8}
              className={`${TAP} box-border w-full rounded-md border p-2 text-base`}
              value={composeNameCell(row.name, row.notes)}
              onAttach={(element) => {
                claimFocus(element, { rowId: row.id, columnId: 'name' });
              }}
              commit={(typed, baseline) => commitName(row.id, typed, baseline)}
            />

            {roles.map((role) => {
              const problem = estimateProblem(row, role.id);
              const options = mentionOptions(row, role.id);
              const listId = `card-mention-${row.id}-${role.id}`;
              const assignee = assigneeOn(row, role.id);
              const trio = cardTrioOf(row, role.id, showDay);
              return (
                <Fragment key={role.id}>
                  <div
                    data-phase={role.id}
                    // The positioned ancestor `PickerList` measures `top: 100%`
                    // from — it owns the box, the caller owns the wrapper.
                    // The blur is the mention's, bubbling from the box inside:
                    // leaving the cell takes a half-typed `@ka` with it.
                    className="relative flex min-w-0 items-center gap-2"
                    onBlur={leaveEstimate}
                  >
                    <span className="text-muted-foreground w-20 shrink-0 truncate text-sm">
                      {role.name}
                    </span>
                    {row.rolledUp ? (
                      // A parent's figure is a sum of what is below it. Printed
                      // rather than typed into, the same rule the table's folded
                      // cell keeps.
                      <span className="font-semibold">{estimateValue(row, role.id)}</span>
                    ) : (
                      <CellInput
                        aria-label={`${role.name} estimate for ${row.number}`}
                        cellKey={cellKey(row.id, `${role.id}-final`)}
                        role="combobox"
                        aria-expanded={options.length > 0}
                        aria-controls={options.length > 0 ? listId : undefined}
                        aria-autocomplete="list"
                        aria-invalid={problem !== null}
                        title={problem ?? undefined}
                        placeholder="o/r/p"
                        // `inputMode` rather than `type="number"`: the value is
                        // `2/3/8` as often as it is `4`, and a number field
                        // refuses the slashes. This is the keyboard a phone
                        // offers, and nothing about what the box accepts.
                        inputMode="decimal"
                        className={`${TAP} box-border w-28 shrink-0 rounded-md border px-2 text-base font-semibold ${
                          problem === null ? '' : 'border-destructive text-destructive'
                        }`}
                        onFocus={(event) => {
                          enterEstimate(event.currentTarget);
                          event.currentTarget.select();
                        }}
                        onTyped={(box) => {
                          readEstimate(row.id, role.id, box);
                        }}
                        onKeyDown={(event) => {
                          // The open list owns the keyboard, and Escape is how it
                          // is given back — the same routing the table's folded
                          // cell has, minus the chords and the alt-arrows, which
                          // are not wired on a card at all.
                          if (options.length === 0) {
                            // Enter saves, the table's rule on the face that has
                            // the most reason to keep it: a phone has no
                            // convenient elsewhere to click, and the keyboard's
                            // own confirm key is how a number is finished on one.
                            // No modifier guard, because no chord is wired here
                            // for one to leave alone.
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void flushCell(event.currentTarget);
                            }
                            return;
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            closeMention();
                            return;
                          }
                          if (event.key === 'Enter') {
                            // The first entry, which is `CreatablePicker`'s rule:
                            // what is offered first is what is taken.
                            event.preventDefault();
                            options[0]?.take();
                          }
                        }}
                        value={estimateValue(row, role.id)}
                        commit={(typed, baseline) => commitEstimate(row, role.id, typed, baseline)}
                      />
                    )}
                    {problem !== null && (
                      <span role="status" className="text-destructive text-sm">
                        {problem}
                      </span>
                    )}
                    {assignee !== null && (
                      <span
                        data-card-assignee={role.id}
                        {...(assignee.assumed ? { 'data-assumed': role.id } : {})}
                        title={
                          assignee.assumed
                            ? `${assignee.name} — only one person is assigned, so they are assumed to do this phase too`
                            : assignee.name
                        }
                        className={`min-w-0 truncate text-sm ${
                          assignee.assumed ? 'text-muted-foreground' : ''
                        }`}
                      >
                        {assignee.assumed ? `(${assignee.name})` : assignee.name}
                      </span>
                    )}
                    {options.length > 0 && (
                      <PickerList
                        id={listId}
                        label={`${role.name} assignee for ${row.number}`}
                        options={options}
                      />
                    )}
                  </div>
                  {/*
                  The trio behind the figure box above — folded there into one
                  computed number the same way the table's own cell folds it —
                  said in the words `folded-role-card.tsx` already prints on
                  hover, since a phone has no hover to read them from. A native
                  `<details>` rather than a positioned card: it needs no
                  measurement, no pointer-type guard and no dismiss handler,
                  and a tap is what opens one already.
                */}
                  <details
                    data-phase-detail={role.id}
                    className="text-muted-foreground -mt-1 ml-20 text-xs"
                  >
                    <summary className="w-fit cursor-pointer py-1 select-none">o·r·p</summary>
                    <div data-phase-trio={role.id}>{trio.line}</div>
                    {trio.final !== '' && (
                      <div data-phase-final={role.id}>Final {trio.final} days</div>
                    )}
                  </details>
                </Fragment>
              );
            })}

            {/*
              What the plan says about this work item and a card cannot be typed
              into: when it happens, what it waits for, and whose it is. Read
              off the same fields the table's columns print.
            */}
            <p className="text-muted-foreground flex flex-wrap gap-x-3 text-sm">
              {/*
                The days in full behind the short ones, the same bargain the
                table's Start and End cells make — a phone has no hover, and
                the attribute is still what a test and a screen reader read.
              */}
              <span data-card-span title={cardSpanTitle(span)}>
                {span.start.text} → {span.finish.text}
              </span>
              {/*
                The Slack column's own word for the one figure it replaces
                outright: `critical` where there is none to give, read off the
                row the same way the cell reads it, not through a second
                schedule-error prop this renderer does not hold.
              */}
              <span
                data-card-slack
                {...(slack.critical ? { 'data-critical': 'true' } : {})}
                title={slack.title}
              >
                {slack.text}
              </span>
              {waits.length > 0 && <span data-card-waits>waits for {waits.join(', ')}</span>}
              {/*
                The team, and `↳` where the row carries no label of its own —
                the table's Team cell uses the same one glyph for the same one
                fact, and the sentence naming the row it came from is in the
                `title` on both faces. A card that printed the inherited name
                bare would say this row is labelled when it is not.
              */}
              {team.state !== 'none' && (
                <span
                  data-card-team
                  {...(team.state === 'inherited' ? { 'data-inherited': 'true' } : {})}
                  title={
                    team.state === 'inherited'
                      ? `${team.name} — inherited from ${team.fromRow}. This row carries no team of its own.`
                      : undefined
                  }
                >
                  {team.state === 'unresolved'
                    ? 'a team this plan has not loaded'
                    : team.state === 'inherited'
                      ? `↳ ${team.name}`
                      : team.name}
                </span>
              )}
              {/*
                The tags, and `↳` where the row carries none of its own — the
                team chip's one glyph for the same one fact, one dimension over,
                with the row it came from in the `title`.

                A separate chip and not a second line inside the team's: they
                answer different questions, and a reader scanning a phone for
                "what is regulatory here" should not have to read past a team
                name to find out.
              */}
              {tags.state !== 'none' && (
                <span
                  data-card-tags
                  {...(tags.state === 'inherited' ? { 'data-inherited': 'true' } : {})}
                  title={
                    tags.state === 'inherited'
                      ? `${tags.names.join(', ')} — inherited from ${tags.fromRow}. This row carries no tag of its own.`
                      : undefined
                  }
                >
                  {tags.state === 'inherited'
                    ? `↳ ${tags.names.join(', ')}`
                    : tags.names.join(', ')}
                </span>
              )}
              {/*
                The services, and `↳` where the row carries none of its own —
                the team chip's glyph again, third dimension over, with the row
                the set came from in the `title` (task 7.3).

                **Last of the three, because the table already settled that
                order** — `Service/team`, `Tags`, `Services`, in that sequence
                in `wbs-table.tsx`'s column list. A reader moving between the
                two faces of one plan should find its labels in one order, and
                a phone is not the surface that gets to re-argue it. This chip
                was written second, between the team and the tags, on the
                argument that team and service are the pair the ownership map
                relates; the table's order was not read before choosing, and
                agreeing with the other face is worth more than that argument.

                Every stated name, joined, exactly as the tags chip does it: a
                row's services are a set since the 2026-08-21 scope change, and
                a card naming the first of two would be the last surface still
                narrowing what the store, the wire, the filter and the cell all
                widened.
              */}
              {delivers.state !== 'none' && (
                <span
                  data-card-service
                  {...(delivers.state === 'inherited' ? { 'data-inherited': 'true' } : {})}
                  title={
                    delivers.state === 'inherited'
                      ? `${delivers.names.join(', ')} — inherited from ${delivers.fromRow}. This row carries no service of its own.`
                      : undefined
                  }
                >
                  {delivers.state === 'inherited'
                    ? `↳ ${delivers.names.join(', ')}`
                    : delivers.names.join(', ')}
                </span>
              )}
              {/*
                What the plan was asked to run this row at, where somebody asked
                for more than one. Blank at 1, which is every row of every plan
                nobody has widened — the column's own bargain, kept here so the
                two faces read the same.

                Muted and qualified where the number decides nothing: a parent
                holds no slices of its own, and a row one person is named on
                runs one at a time whatever this says (C1's D3). Both are facts
                a reader of a bare `3` cannot get anywhere else on a phone.
              */}
              {row.maxParallel > 1 && (
                <span data-card-parallel={inertParallel(row) ? 'inert' : 'live'}>
                  {inertParallel(row)
                    ? `${String(row.maxParallel)} at once (not applied)`
                    : `${String(row.maxParallel)} at once`}
                </span>
              )}
            </p>
            {/*
              The two mismatch signals, **as sentences and not as a tooltip**
              (`phone-mismatch-markers`, 2026-08-22).

              The table wears these as a `△` whose `title` and `aria-label`
              carry the sentence, and that mark did not reach a phone at all —
              Browser Use Cloud counted 0 titles and 0 triangles at 390px
              against 2 and 2 on the same data at desktop width, on a card that
              was still printing the team and the service the mismatch is
              *about*. A reader could even filter down to exactly these rows
              (`Plan actions` carries both facets) and then be told nothing
              about why they matched.

              Visible text rather than the table's `title`, and that is the
              breakpoint's decision rather than an oversight: the sentence *is*
              the signal — a glyph that cannot say why is a mystery rather than
              a signal, 7.2's own words — and a `title` is reachable by a
              pointer alone. A phone has no pointer. So the words that a
              desktop reader hovers for are simply printed here, where there is
              a card's width to print them in and no column budget to defend.
              The `△` comes along as the shared glyph and is `aria-hidden`,
              because the sentence beside it is now the accessible name and a
              screen reader announcing "white up-pointing triangle" first would
              be reading the decoration out loud.

              `--muted-foreground` for `MismatchMark`'s reason, unchanged:
              nothing here is refused, nothing moves, no date changes, and a
              signal loud enough to read as an error would be an error the
              reader cannot clear.
            */}
            {mismatches.length > 0 && (
              <ul data-card-mismatches className="text-muted-foreground m-0 list-none p-0 text-sm">
                {mismatches.map(({ kind, note }) => (
                  <li key={note} data-card-mismatch={kind} className="flex min-w-0 gap-1">
                    <span aria-hidden className="shrink-0">
                      △
                    </span>
                    <span className="min-w-0">{note}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </div>
  );
}
