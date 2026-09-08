import type * as React from 'react';
import { type ComponentProps } from 'react';

import { type DepLights } from './dep-light-store';
import { entersThroughDependsCard } from './depends-card';
import { cellKey } from './editable-grid';
import type { PlanLive } from './plan-live';
import { REFERENCE_SET_EDGE_FADE } from './reference-set-field';
import { type TreeRow } from './wbs-rows';

/**
 * The two `<td>` props builders: what a cell's element carries beyond its
 * content — the pinned styles, the hover card's `aria-describedby`, the
 * popover's layer.
 *
 * Built per render outside the `columns` memo, so nothing here can pin a stale
 * reading into a column definition. See the note beside {@link cellProps}.
 */
export function createPlanCellProps({
  dependenciesOf,
  depLights,
  depPicker,
  setHoveredCell,
  live,
  openCard,
}: {
  dependenciesOf: (ids: readonly string[]) => { id: string; number: string; name: string }[];
  depLights: DepLights;
  depPicker: { rowId: string; typed: string; highlightId: string | null } | null;
  setHoveredCell: React.Dispatch<React.SetStateAction<string | null>>;
  live: PlanLive;

  openCard: string | null;
}) {
  /**
   * What one row's Depends on `<td>` does with a pointer arriving and leaving.
   *
   * **On the `<td>`, because the gesture is "the pointer is in this cell".**
   * These two handlers lived on a wrapper `<span>` inside the cell until
   * 2026-08-14, and the wrapper stands inside the cell's padding box: the
   * cell's own 4px either side answered nothing, and at the column's resolved
   * 110px two pills and the add button fill the strip edge to edge, so the
   * only surface left that produced the cell's reading was the 15.8px `+`
   * — a control whose job is "start waiting for something else". Measured
   * in Chromium: the box the gesture names is laid out **7.7px outside its own
   * cell** at that width, `elementFromPoint` down the cell's midline answers a
   * pill everywhere but the padding, and the padding lit nothing.
   * `openspec/changes/table-width-budget/design.md` D2 has the table.
   *
   * The pills' own narrower reading is unaffected and is the one thing this
   * move could have cost. `mouseenter` fires on every element being entered,
   * outermost first, so a pointer arriving straight onto a pill runs this
   * handler (`pillId: null`, the whole set) and then the pill's
   * (`pillId: <id>`, one row) — and the pill's write is the one that lands.
   * jsdom cannot say so, because `fireEvent.mouseEnter` dispatches to one
   * element and walks no chain; `e2e/deps-cell.spec.ts`'s `narrows to one pill
   * when the pointer settles on it, from the cell` is the browser that can.
   *
   * The `<td>` is rendered outside the registry so pointer readings do not
   * rebuild column definitions. See the stable {@link PlanLive} contract.
   */
  const dependsCellHoverProps = (
    row: TreeRow,
  ): Pick<ComponentProps<'td'>, 'onMouseEnter' | 'onMouseLeave'> => {
    const dependsCell = cellKey(row.id, 'depends');
    return {
      onMouseEnter: (event) => {
        // Not an enter at all when it arrives through the open card's passive
        // padding, which hit-tests to this cell while the pointer is on its
        // way to a card line — see {@link entersThroughDependsCard}. Writing
        // either state here would take the card over from the row above.
        if (entersThroughDependsCard({ x: event.clientX, y: event.clientY }, event.currentTarget)) {
          return;
        }
        // Every row this one waits for is lit, `pillId: null` saying the
        // pointer is on the cell rather than on one pill. Guarded by the same
        // "nothing to say, nothing written" rule as the card below — a cell
        // that waits for nothing has no row to light and no reason to spend a
        // render (codex round 3, finding 5). The functional writer returns the
        // current object when the value is already there, which is the
        // string-key bail-out below, spelt for an object.
        if (dependenciesOf(row.dependsOn).length > 0) {
          depLights.updateHover((current) =>
            current?.rowId === row.id && current.pillId === null
              ? current
              : { rowId: row.id, pillId: null },
          );
        }
        // Nothing to open, nothing written. `hoveredCell` lives on the table,
        // so every boundary the pointer crosses costs one render of the whole
        // of it — and a cell with no card to show has no reason to spend one,
        // nor to close the card open somewhere else on the pointer's way past.
        // codex round 3, finding 5.
        //
        // The key is a string, so a second enter on the same cell writes the
        // value already there and React bails out without rendering.
        // Proof: this guard dropped, `writes no hovered cell from a cell
        // that has no card to show` failed on `Unable to find an accessible
        // element with the role "tooltip"`. Watched, 2026-08-09.
        //
        // `depPicker` and not the cell's local `picker`: the card and the
        // picker are the two boxes that hang off one 110px cell, and the one
        // somebody is typing into is the one they are looking at. Read from
        // the state directly, because this is outside the column definitions.
        const cardable = dependenciesOf(row.dependsOn).length > 0 && depPicker?.rowId !== row.id;
        if (!cardable) return;
        setHoveredCell(dependsCell);
      },
      onMouseLeave: () => {
        // The open dependency card owns dismissal through its document
        // pointer bridge. Clearing here would unmount the row targets while
        // the pointer is crossing the card's passive padding. The bridge sees
        // the next real pointer position and clears if it is outside; a
        // `relatedTarget` is deliberately not required because passive card
        // pixels hit-test through to the plan and Chromium may report that
        // boundary as a leave with no related node.
        if (dependenciesOf(row.dependsOn).length > 0 && depPicker?.rowId !== row.id) return;

        // Leaving the cell clears the dependency hover outright — with the
        // same-cell guard `hoveredCell`'s clear uses, because a leave lands
        // after the next cell's enter.
        depLights.updateHover((current) => (current?.rowId === row.id ? null : current));
        // The same-cell guard, for the reason the Name cell's marker gives: a
        // leave lands after the next cell's enter.
        setHoveredCell((current) => (current === dependsCell ? null : current));
      },
    };
  };

  /** Reads the Start sentence through the shared live contract. */
  const startSentence = (row: TreeRow): string | null => readStartSentence(row, live);

  /**
   * What one row's Start `<td>` carries so the sentence that explains its day is
   * reachable without a pointer resting on the right 34×13px of it, **and
   * without waiting for a browser to decide it has rested long enough**.
   *
   * `wbs-waiting-sentence-hover-target` moved this sentence off
   * `span[data-start]` and onto the `<td>`, which fixed the target: a 442px²
   * surface in a 4116px² cell, `cursor: auto`, no keyboard path, no on-screen
   * mark that there was anything to read. It left the sentence a native `title`,
   * and that is what `start-date-hover-card` replaces (Dany, 2026-08-31 —
   * hovering the Start date must give an **instant** tooltip, and not the native
   * one).
   *
   * A `title` is the browser's, not this app's: Chromium waits about a second
   * before showing one, draws it in the platform's own chrome rather than the
   * page's, and puts it where the pointer is rather than under the cell. Nothing
   * in a stylesheet reaches any of that. The folded step cell said the same
   * thing about the same conflict a fortnight earlier — _"no native `title`
   * here: the card is this cell's one hint, and a browser tooltip raced it over
   * the same pixels"_ — so this cell now does what that one does.
   *
   * The keyboard path is the reason `onFocus` is here beside `onMouseEnter`. A
   * `title` on a focusable cell is announced as its description; a card that
   * only a pointer can open is data withheld from anybody who does not use one
   * (codex round 3, finding 2). So focus opens the same card, and the cell points
   * `aria-describedby` at it while it is open.
   */
  const startCellProps = (
    row: TreeRow,
  ): Pick<
    ComponentProps<'td'>,
    'tabIndex' | 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'aria-describedby'
  > & { 'data-start-said'?: string } => {
    const said = startSentence(row);
    if (said === null) return {};
    const startCell = cellKey(row.id, 'start');
    // The same-cell guard every surface here clears with: a leave fires after
    // the enter of whatever the pointer moved on to.
    const close = () => {
      setHoveredCell((current) => (current === startCell ? null : current));
    };
    return {
      /*
        The sentence, at rest, for anything that is not a reader.

        The `title` this replaces was read by two oracles as well as by people:
        `gantt-panel.test.tsx`'s `columnDay` compares the axis under the chart
        against the day the column is showing, and `e2e/gantt.spec.ts`'s fixture
        reads a row's own start day back out of the table to type it in as a
        not-before date. Both need the **whole** day, which the column prints as
        `14 Aug`, and neither can hover.

        So the fact stays in the DOM and only the tooltip goes. An attribute
        rather than a hidden span for the same reason the card is not always
        rendered: this is 40 rows, and a card each is 40 measured boxes.
      */
      'data-start-said': said,
      tabIndex: 0,
      onMouseEnter: () => {
        setHoveredCell(startCell);
      },
      onMouseLeave: close,
      onFocus: () => {
        setHoveredCell(startCell);
      },
      onBlur: close,
      'aria-describedby': openCard === startCell ? startCardId(row.id) : undefined,
    };
  };
  return { dependsCellHoverProps, startSentence, startCellProps };
}

/**
 * The sentence that explains one row's Start day, or null where there is
 * nothing to explain.
 *
 * Two facts joined: the whole day, so the column's shortening costs nothing,
 * then what is holding that day where it is — the floor sentence word for word
 * from the chart's `startFloorByRow`.
 *
 * Read through {@link PlanLive}, including the stable start-floor ref that
 * is filled after the chart projection is built.
 */
export function readStartSentence(row: TreeRow, live: PlanLive): string | null {
  const said = [live.current.spanOf(row).start.iso, live.current.startFloor.current.get(row.id)]
    .filter((part) => part !== null && part !== undefined)
    .join(' — ');
  return said === '' ? null : said;
}

/**
 * The columns by fixed id whose `<td>` must not clip, because something in them
 * opens over the rows below. {@link opensAPopover} is what asks.
 */
export const POPOVER_COLUMNS: ReadonlySet<string> = new Set([
  'depends',
  'name',
  'team',
  // The other two reference cells, and their absence here was the whole of the
  // 2026-08-29 Tags report. All three render a `CreatablePicker`; only `team`
  // was ever listed, so a Tags cell's open list made its `<td>` 94px of content
  // in a 26px row and Chromium **scrolled the cell** to reveal it —
  // `td.scrollTop === 22`, measured in the running dev server, the strip drawn
  // 21px above the row it belongs to and the `+` scrolled out of sight.
  // A column that grows a popover and does not join this set is this bug again.
  'tag',
  'service',
  // The fourth reference cell, and this set's own sentence coming true: the
  // Types column shipped in `work-item-types` with a `ReferenceSetStrip` in it
  // and was never added here, so its `<td>` kept `overflow: clip` and the
  // picker's list was cut at a 26px row. Measured in Chromium, 2026-08-31: with
  // `Bug` typed into `Types for 010`, the `Add “Bug”` line's own rectangle
  // stands at y=175.19 with the cell's bottom edge at y=175.19, and
  // `elementFromPoint` at the middle of that line answers whichever row is
  // **next** — `<input aria-label="Types for 020"> … intercepts pointer
  // events`, a 60s Playwright timeout, and `Types for 010.1` on the fixture
  // `e2e/reference-cell-panel.spec.ts` now uses. Nothing was offerable, which
  // is Dany's 2026-08-31 report: *"for types - i need to be able to type same
  // as tags, services, teams"*. It is also what lets the cell's hover card
  // open at all.
  'type',
  'actions',
  'not-before',
  'deadline',
  // The ref cell's hover card, which is the whole list of links hanging off a
  // 40px column: without the exemption it is cut at the cell edge and a reader
  // sees five characters of a URL.
  'refs',
  // The Prio cell's band list, since `priority-bands`. The column is 48px and a
  // line reads `Critical — 10`, so the list is wider than its cell by more than
  // any other in this set except the date editor. Without the exemption it is cut
  // at the cell edge and the reader sees the first three characters of a name.
  'priority',
  // The Start cell's own card, since `start-date-hover-card`. The sentence that
  // explains a row's day used to be a native `title` on this `<td>`; Dany asked
  // for it *instantly*, which no browser tooltip does, so it is a `HoverCard`
  // like the four reference cells' — and a card is absolutely positioned inside
  // the cell, so without this exemption it is cut off at a 52px column and a
  // reader sees five characters of a sentence.
  'start',
]);

/**
 * Whether this column holds something that opens over the rows below, and so
 * needs its `<td>` exempted from {@link CELL}'s `overflow: hidden`.
 *
 * The CSS rule this exists for, stated because the first version of this change
 * got it backwards and shipped every popover in the table cut off at the cell
 * edge: an absolutely positioned box escapes an `overflow: hidden` ancestor only
 * when its containing block — its nearest *positioned* ancestor — is **outside**
 * that clipper. Every popover here is `position: absolute` inside a
 * `position: relative` wrapper span, and that wrapper is inside the cell, so the
 * `<td>`'s own clip cuts it to the cell rectangle however the wrapper is styled.
 * Lifting the clip on the `<td>` is the only thing that lets one open.
 *
 * Seven kinds of column, not two: the dependency listbox (`depends`), the
 * rendered notes preview (`name` — the notes live in that box since the Notes
 * column was folded into it), a `CreatablePicker`'s list — which is the
 * service/team cell and each step's assignee cell — the row's own actions
 * menu (`actions`), which hangs a 140px box off a 40px cell one line high,
 * a folded step's own cell (`<stepId>-final`), where an `@` opens the people
 * picker over a 96px column, and the earliest-start cell (`not-before`), whose
 * date editor is `DATE_EDITOR_WIDTH` wide in a column of 84px or 56. That last
 * one is the widest escape of the lot, and the one number here this repository
 * does not get to choose: it is what Chromium lays an unconstrained
 * `input[type=date]` out at. A column that grew to fit one would move every
 * cell under the person typing, so the editor leaves the cell instead.
 * Both kinds of step column are named for a step that only exists at runtime,
 * so they are matched by suffix, the same way `widthFor` sizes them.
 *
 * `name` is also a pinned column, and the two rules do not fight: the pin
 * places the cell, the clip decides what may leave it, and the preview has to.
 *
 * Since 2026-08-09 two of these columns are exempt for a **second** reason, and
 * it is written down here so a later change that moves a picker out of one of
 * them cannot take the exemption with it: `depends` and `<stepId>-final` each
 * open a hover card as well as a list, and a card is what a reader of a folded
 * plan is left with when nothing is open. `e2e/hover-cards.spec.ts` injects the
 * suffix branch's removal and watches the folded step's card get clipped.
 *
 * Since 2026-08-31 the four reference columns are too: `ReferenceSetStrip`
 * opens a `HoverCard` from its anchor with the whole set on it, which is what a
 * reader of a clipped one-line cell is otherwise left without. So `team`,
 * `tag`, `service` and `type` each earn this exemption twice over, and losing
 * it takes both the list and the card with it.
 *
 * What still keeps these cells from painting into their neighbours, now that the
 * structural backstop is off for them: every control inside them is
 * `width: 100%` (or a flex child of a `maxWidth: 100%` row) with `border-box`
 * sizing — asserted by `lets no control in a cell assert a width of its own` and
 * measured in a browser by `keeps every control inside the cell it belongs to`
 * in `e2e/layout.spec.ts`.
 */
export const opensAPopover = (columnId: string): boolean =>
  POPOVER_COLUMNS.has(columnId) || columnId.endsWith('-assignee') || columnId.endsWith('-final');

/**
 * How wide the Depends on list opens, in px, whatever its column is.
 *
 * The column is 110px — one clipped line of chips at rest — and an entry in
 * this list is a number and a work item's name. A list held to its own column
 * would be a list nobody can read; it hangs over the columns beside it, which
 * is what `opensAPopover` exempts the cell for. The browser gate measures it.
 */
export const DEP_LIST_WIDTH = 260;

/**
 * The id of one row's Start card, so the `<td>` can point `aria-describedby` at
 * it while it is open.
 *
 * A module constant rather than a string built at each of the two sites that
 * need it: the cell renders the card with this id and the `<td>` refers to it,
 * and two spellings of one id is a description that silently refers to nothing.
 */
export const startCardId = (rowId: string): string => `start-${rowId}`;

/**
 * The truncation cue on the Depends on cell's strip: the strip's last 14px
 * fade to transparent, so a line of chips that was clipped visibly runs out
 * rather than ending on what looks like the last chip.
 *
 * Applied at **rest only** — whenever the picker is closed, clipped or not.
 * The rest condition is the picker's state, never a measurement: "fade only
 * when clipped" would need the `scrollWidth` read the `+N` marker was
 * rejected for, and that door stays shut. It is not applied while the picker
 * owns the cell, because the strip wraps then — nothing is clipped, there is
 * nothing to cue, and the box spans the full width, so the mask would fade
 * the focus ring, the caret and the typed text across the last 14px. One
 * known cosmetic cost at rest: the box's `width: 100%` means a chipless
 * row's placeholder tail sits under the fade — recorded in the delta spec,
 * awaiting eyes on dev. A mask rather than a painted gradient, so it holds
 * over a tinted row (`--cell-bg`) as well as a white one.
 *
 * Proof, two faults, both watched 2026-08-10: this taken off the strip,
 * `keeps the truncation fade on the rested strip, and off the open one`
 * failed at rest on `expected '' to contain 'linear-gradient'`; applied
 * unconditionally, the same test failed with the picker open on
 * `expected 'linear-gradient(to right, #000 calc(1…' to be ''`.
 *
 * The value itself lives in `reference-set-field.tsx` since 4b, where the three
 * directory-backed cells clip and fade their rest line by the same rule. Two
 * cells fading by different amounts is a difference a reader would read as
 * meaning something.
 */
export const DEP_EDGE_FADE = REFERENCE_SET_EDGE_FADE;

/**
 * What a row matching the Find box is tinted, so a hit reads apart from its
 * context.
 *
 * A token rather than the hex it was, for the reason every colour in this file
 * is one now: `styles.css` re-points the whole palette under `.dark`, and a
 * literal is the one shade that would not follow.
 */
export const MATCH_TINT = 'var(--grid-match)';
