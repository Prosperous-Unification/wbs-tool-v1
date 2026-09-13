import { type StepView } from '@/lib/wbs-api';

import { useCardOpenOn } from '../cell-card-store';
import { CellInput } from '../cell-input';
import { STEP_FINAL_HINT } from '../column-hints';
import { CreatablePicker, PickerList, pickerOptionId } from '../creatable-picker';
import { cellKey } from '../editable-grid';
import { POINTS, showTrio } from '../estimate-draft';
import { FoldedStepCard } from '../folded-step-card';
import { initialsOf } from '../initials';
import { altMoveIn, commandChordIn } from '../keyboard-bindings';
import { flushCell, unsent } from '../live-editing';
import type { PlanLive } from '../plan-live';
import { MismatchMark } from '../plan-mismatch';
import { showDays, showFinal } from '../plan-number-format';
import {
  type EstimateReadings,
  type FoldedEstimateReadings,
  type PlanRenderRow,
} from '../plan-render-rows';
import { column } from './column';

function estimateReading(row: PlanRenderRow, stepId: string): EstimateReadings {
  const reading = row.readings.estimateReadings.get(stepId);
  if (reading === undefined) {
    throw new Error(`Missing estimate reading for visible step ${stepId} on row ${row.id}`);
  }
  return reading;
}

function foldedReading(reading: EstimateReadings, stepId: string): FoldedEstimateReadings {
  if (reading.layout !== 'folded') {
    throw new Error(`Expected folded estimate reading for step ${stepId}`);
  }
  return reading;
}

/** Builds the estimates column family against the stable live cell contract. */
export function createEstimatesColumns({
  steps,
  unfoldedSteps,
  live,
}: {
  steps: StepView[];
  unfoldedSteps: readonly string[];
  live: PlanLive;
}) {
  return steps.flatMap((step) => {
    const unfolded = unfoldedSteps.includes(step.id);
    return [
      column.display({
        id: `${step.id}-final`,
        meta: { isEditable: (row) => !unfolded && !row.rolledUp },
        // The toggle lives on the column that never goes away, so nothing
        // jumps when the group opens: it extends to the right of this one.
        header: () => (
          <button
            type="button"
            aria-expanded={unfolded}
            aria-label={`${unfolded ? 'Fold' : 'Unfold'} ${step.name} estimates`}
            // The step's own name, in full, because the button now shows as
            // much of it as the column has room for and no more. A step
            // called "Infrastructure and platform" used to set the width of
            // everything under it instead.
            // The assignee no longer folds away — it is beside the figure
            // in this very cell, and `@` assigns from there — so the
            // button is about the three points and nothing else. It said
            // "any other step folds" until `unfolding-may-scroll`, and no
            // other step folds now; what the reader is owed instead is
            // that the table may become wider than the window, which is
            // the one thing unfolding can do that it could not before.
            // The column's own sentence first, then the toggle's: this
            // button covers most of its `<th>`, so a title naming only the
            // fold would be the one heading in the table where hovering
            // teaches nothing about the column (`column-hints.ts`).
            data-hint={`${STEP_FINAL_HINT} ${
              unfolded
                ? 'Click to fold the three points back into the figure.'
                : 'Click to show the three points; the table may scroll sideways.'
            }`}
            onClick={() => {
              live.current.toggleStep(step.id);
            }}
            style={{
              font: 'inherit',
              fontWeight: 'inherit',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {step.name} {unfolded ? '▾' : '▸'}
          </button>
        ),
        cell: ({ row }) => {
          const reading = estimateReading(row.original, step.id);
          if (reading.layout !== (unfolded ? 'unfolded' : 'folded')) {
            throw new Error(`Estimate reading layout disagrees for step ${step.id}`);
          }
          // A subscription and not a reading off `live`: this cell is a
          // component, so it can be told about its own card without the table
          // rendering. First, and unconditionally, because it is a hook.
          // `flexRender` builds this with `React.createElement`, so it **is** a
          // component and the hook below is legal; the rule reads the property
          // name `cell` and cannot see the call site.
          // eslint-disable-next-line react-hooks/rules-of-hooks
          const cardOpen = useCardOpenOn(
            live.current.cellCards,
            cellKey(row.original.id, `${step.id}-final`),
          );
          // A folded step must not be able to hide a complaint: a typed
          // trio that saves nothing stays visible as a mark on the figure
          // the fold leaves behind.
          const problem = reading.layout === 'folded' ? reading.combinedProblem : null;
          // The whole trio in one cell, but only where both halves of that
          // sentence hold: a folded step, so the three boxes are not on
          // screen to disagree with it, and a leaf, because a parent's
          // figure is a sum of what is below it and nothing to type into.
          const shorthand = !unfolded && !row.original.rolledUp;
          // What this row holds, off the row: the trio as it would be
          // typed, and the figure the project's estimate method makes of
          // it. Both read through `row.original` and **not** through
          // `combinedValue` beside them, which answers with the draft
          // where there is one. That is right for the box somebody is
          // typing in and wrong for the pair below, for the reason
          // {@link FoldedStepCard}'s points give at length: a figure is
          // what be-01 holds, and one recomputed per keystroke would
          // stand `2.2` beside `9/9/` claiming to be its answer.
          const stored = showTrio(row.original.estimates[step.id]);
          const final = showFinal(row.original.finalDays[step.id]);
          // What this cell says without a box in it — a parent's roll-up
          // while the step is folded, and every row's while it is
          // unfolded. The trio when it is the only place the trio is, and
          // the figure once the three boxes are on screen beside it: an
          // unfolded step already prints `2 | 2 | 3`, and a fourth column
          // repeating it would be the fold's own reading with nothing
          // folded.
          const atRest = unfolded ? final : stored;
          // The figure earns its pixels only where it says something the
          // cell does not say already. A flat trio prints as `5` and its
          // figure is `5` under every estimate method, so an unguarded
          // cell read `5 · 5` — and the column is 96px, shared with an
          // assignee. Unfolded, `atRest` **is** the figure and the
          // comparison closes the column back down to one reading.
          //
          // One condition and not two: a row with no estimate has neither
          // a trio nor a figure, so a `final !== ''` beside this would be
          // a check that cannot fail (`AGENTS.md`, R5, `T1
          // column-widths-drag`). be-01 computes `finalDays` from
          // `estimates` in the same call — see `WorkItemRow.finalDays` —
          // so the two are absent together.
          const finalSaysMore = final !== atRest;
          // Nobody on this step and exactly one person on another: they are
          // assumed to be doing this step too. The same rule the unfolded
          // column has, in the cell that is always on screen — which is the
          // whole reason the assignee stopped folding away. Read through
          // {@link assigneeOn}, which is where a card reads it too.
          const doing = reading.doing;
          // Only while this step is folded: unfolded, the assignee has a
          // column of its own with a picker in it, and two ways to assign
          // one person side by side is two things to keep in step.
          const options = reading.layout === 'folded' ? reading.mentionOptions : [];
          const listId = `mention-${row.original.id}-${step.id}`;
          const finalCell = cellKey(row.original.id, `${step.id}-final`);
          // The card opens on the cell itself — not on a marker, the way
          // the Name cell's preview does. The difference is size: this one
          // is four lines over a 96px cell, so a mouse crossing the column
          // is told something rather than interrupted.
          //
          // Not while a mention is being typed in this cell, because the
          // list and the card open from the bottom edge of this same
          // wrapper and the one somebody is typing into owns the cell.
          //
          // The **mention**, not its entries. Reading `options.length === 0`
          // was the same rule for every case but one, and that one is
          // reachable: a deployment with nobody on it yet answers a bare `@`
          // with no entries at all — nobody to match, and no `Add "…"` until
          // something follows the `@` — so the card opened over a box being
          // typed into. agy round 3, finding 7.
          // Proof: put back to `options.length === 0`, `keeps the cell to a
          // mention that has nobody to offer` failed on `expected 'Dev…' to
          // contain 'QA'`. Watched, 2026-08-09.
          const mentioning = reading.layout === 'folded' && reading.mentioning;
          const cardable = !unfolded && !mentioning;
          const carded = cardable && cardOpen;
          // The card's own id, which the box below points
          // `aria-describedby` at while it is open — this cell's answer to
          // "a card only a pointer can open is data withheld from anybody
          // who does not use one" (codex round 3, finding 2). The box is
          // the cell's only focusable thing, so it is the one that can
          // carry it; a parent's rolled-up figure has no box and no
          // keyboard route, which is its own entry in `design.md`.
          const cardId = `folded-${row.original.id}-${step.id}`;
          return (
            <span
              data-final={step.id}
              onMouseEnter={() => {
                // No card to show, no store notification. See the Depends on
                // cell's own enter for why passing an empty cell must not
                // close the card open somewhere else.
                if (!cardable) return;
                live.current.cellCards.arriveOn(finalCell);
              }}
              onMouseLeave={() => {
                // The same-cell guard the Name cell's marker gives its
                // reason for: a leave lands after the enter of whatever the
                // pointer moved on to.
                live.current.cellCards.leave(finalCell);
              }}
              // No native `title` here or on the input below: the card is
              // this cell's one hint (CONTEXT.md, "Hover preview"), and a
              // browser tooltip raced it over the same pixels. The
              // complaint still marks the figure (the `!` and the colour)
              // and rides the card.
              // A flex row, because this cell holds two things now: the
              // figure (or the box it is typed into) and who is doing it.
              // `relative` makes it the positioned ancestor the `@` list
              // opens against — the clip that would cut the list to 96px is
              // the `<td>`'s, which {@link opensAPopover} lifts.
              // The blur is the mention's: it bubbles from the box inside,
              // and leaving the cell has to take a half-typed `@ka` with
              // it. Nothing else in here can hold the focus.
              onBlur={() => {
                live.current.leaveFoldedCell();
                // The focus-opened card goes with the focus. Guarded like
                // every other clear: a blur can land after the next cell has
                // already taken the focus.
                live.current.cellCards.updateFocused((current) =>
                  current === finalCell ? null : current,
                );
              }}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'baseline',
                maxWidth: '100%',
                minWidth: 0,
                fontWeight: 600,
                color: problem === null ? undefined : 'var(--destructive)',
              }}
            >
              {shorthand ? (
                <CellInput
                  aria-label={`${step.name} estimate for ${row.original.number}`}
                  // In the keyboard grid, which is what makes Down-type-
                  // Down-type work down a step's column. Proof: dropped,
                  // `is a cell of the keyboard grid, so a column can be
                  // typed down` fails. Watched, 2026-08-06.
                  cellKey={cellKey(row.original.id, `${step.id}-final`)}
                  role="combobox"
                  aria-expanded={options.length > 0}
                  aria-controls={options.length > 0 ? listId : undefined}
                  // Which line Enter takes, for a reader who cannot see
                  // the highlight — `CreatablePicker`'s rule, carried to
                  // the one list it does not render. Cleared with
                  // `aria-controls` the moment the list closes, because
                  // both read the same `options.length > 0`.
                  aria-activedescendant={options.length > 0 ? pickerOptionId(listId, 0) : undefined}
                  aria-autocomplete="list"
                  placeholder="o/r/p"
                  aria-invalid={problem !== null}
                  // Every keystroke, so an `@` opens the people picker as
                  // it is typed. The estimate half is not read here and no
                  // draft is written — that is still the blur's job.
                  onTyped={(box) => {
                    live.current.readFoldedCell(row.original.id, step.id, box);
                  }}
                  onKeyDown={(e) => {
                    // `mentioning`, not `options.length > 0`, and the two
                    // are not the same thing: a deployment with nobody in it
                    // answers a bare `@` with no entries at all, and this
                    // branch then handed the keyboard back to a cell a
                    // mention owned — Alt+ArrowDown moved the row and
                    // Cmd+Enter made one, under a half-typed mention. The
                    // card's guard was corrected in round 3 and this one was
                    // left counting entries; round 4 caught the divergence.
                    // The hole itself predates the change: the same branch
                    // counts entries on the merge-base at `75d01a8`.
                    // Proof: put back to `options.length > 0`, `every chord
                    // is inert on a mention that has nobody to offer` failed
                    // on `expected [ 'Strip', 'Paint', 'Sand', '' ] to deeply
                    // equal [ 'Strip', 'Sand', 'Paint' ]` — the row moved and
                    // a row created. Watched, 2026-08-09.
                    if (mentioning) {
                      // Inert means consumed, and this is the one open list
                      // that had two ways out of it. Cmd/⌘+Enter fell
                      // through to the bare Enter below and assigned the
                      // first person offered; every Alt+arrow went on to
                      // `onAltMove` underneath and moved the row while its
                      // list was open — codex round 2, finding 2.
                      //
                      // Proof, two faults, both watched 2026-08-08. This
                      // guard removed: `Cmd+Enter in the folded cell’s open
                      // @ list assigns nobody` failed on `expected
                      // [ 'assign w2 step-dev person1' ] to deeply equal []`,
                      // and `Alt+arrows in the folded cell’s open @ list
                      // move no row` on `expected [ 'Strip', 'Paint',
                      // 'Sand' ] to deeply equal [ 'Strip', 'Sand',
                      // 'Paint' ]`.
                      if (commandChordIn(e) !== null || altMoveIn(e) !== null) {
                        e.preventDefault();
                        return;
                      }
                      if (e.key === 'Escape') {
                        // Closes the list and strips nothing: what was
                        // typed is still on screen to be corrected, and the
                        // blur that follows is what takes it back out.
                        e.preventDefault();
                        live.current.closeMention();
                        return;
                      }
                      if (e.key === 'Enter') {
                        // The first entry, which is `CreatablePicker`'s
                        // rule: what is offered first is what is taken —
                        // and where there is nothing on offer, Enter is
                        // consumed and takes nothing rather than falling
                        // through to "new work item" under a live mention.
                        e.preventDefault();
                        options[0]?.take();
                        return;
                      }
                    } else {
                      // Enter saves, exactly as Prio and People-at-once do
                      // and for the same reason — see the comment on Prio's.
                      // This cell is the one it mattered most in and the
                      // last to get it: a trio typed and confirmed sat as a
                      // draft with the plan's dates unmoved until somebody
                      // happened to click elsewhere. Observed live on dev by
                      // `wbs-e2e-planning-qa`, 2026-08-22.
                      //
                      // Inside the `else`, and that is the whole placement
                      // argument: with a mention open Enter belongs to the
                      // list above, which takes the first person offered.
                      // The modifier guard leaves Ctrl/⌘ + Enter to
                      // `onCommandKey` underneath, which saves *and* makes
                      // the next row.
                      if (
                        e.key === 'Enter' &&
                        !e.metaKey &&
                        !e.ctrlKey &&
                        !e.altKey &&
                        !e.shiftKey
                      ) {
                        e.preventDefault();
                        void flushCell(e.currentTarget);
                        return;
                      }
                      // The routing matrix's inert row is this `else` and
                      // nothing more: while the `@` list is open it owns
                      // the keyboard, and Escape above is how it is given
                      // back. A chord that fired through an open list
                      // would create a row under a half-typed name search.
                      live.current.onCommandKey(e, row.original, `${step.id}-final`);
                    }
                    live.current.onAltMove(e, row.original, `${step.id}-final`);
                    live.current.onTabKey(e, row.original.id, `${step.id}-final`);
                    live.current.onArrowKey(e, row.original.id, `${step.id}-final`);
                  }}
                  // Selected on arrival, because the value at rest is a
                  // computed figure and the syntax is a trio: there is no
                  // sensible edit to make *inside* `4`, and a caret dropped
                  // into it turns `2/3/8` into `2/3/84`. What the selection
                  // replaces is remembered first — see `enterFoldedCell`.
                  aria-describedby={carded ? cardId : undefined}
                  onFocus={(e) => {
                    live.current.enterFoldedCell(e.currentTarget);
                    // The focus opens the card the pointer opens — through
                    // its own state, so a mouse crossing the table cannot
                    // take it away from a box somebody is still typing in
                    // (round 4, finding 9). Cleared by the wrapper's
                    // `onBlur`, which this bubbles to.
                    // Proof, both watched 2026-08-09. This line dropped:
                    // `opens the card on the focus too, and points the box
                    // at it` failed on `Unable to find an accessible element
                    // with the role "tooltip"`. Written back to
                    // the hover's writer, with the open card folded back to the
                    // hover: `keeps the focused cell's card when the pointer
                    // visits another and leaves` failed the same way.
                    live.current.cellCards.updateFocused(() => finalCell);
                    e.currentTarget.select();
                  }}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    font: 'inherit',
                    fontWeight: 600,
                    // Grows, and that is only safe because what sits to
                    // its right is now the **same width on every row** —
                    // see {@link ASSIGNEE_SLOT_PX}. Growing against a
                    // varying sibling is what made the derived figure's x
                    // depend on whether somebody was assigned: measured on
                    // Dany's plan, 2026-08-31, `· 2` at 1143.75 on the
                    // seven assigned rows and 1172.32 on the one without.
                    //
                    // `0 1 59px` was tried instead — stop growing, keep a
                    // basis wide enough for `20/24/30`. It aligns on a
                    // roomy column and not on a tight one: at the declared
                    // 96px the box's `shrink` takes the difference, and
                    // how much it shrinks depends on the assignee again.
                    // Measured at 91.22px: assigned rows 40.52, unassigned
                    // 59, figures 18.48px apart. The slot is the fix; this
                    // is back to what it was.
                    flex: 1,
                    minWidth: 0,
                    ...(problem === null
                      ? {}
                      : {
                          background: 'var(--grid-invalid)',
                          borderColor: 'var(--destructive)',
                        }),
                  }}
                  value={foldedReading(reading, step.id).combinedValue}
                  commit={(typed, baseline) =>
                    live.current.commitCombinedEstimate(row.original, step.id, typed, baseline)
                  }
                />
              ) : unfolded ? (
                atRest
              ) : (
                // A parent's folded cell reads the shape its leaves do —
                // a column that printed a trio on a leaf and a bare
                // figure one row up would be two readings of one heading.
                // A parent's trio is the sum of its descendants', per
                // point, and the method applied to that sum is the sum of
                // the methods applied (PERT is linear), so the pair below
                // cannot contradict the leaves it is made of.
                //
                // `flex: 1`, the box above's own width rule, so the
                // figure and the assignee after this land in the same
                // right-hand slot on a parent as on the leaves under it —
                // a column where `· 5` stands two different places on
                // adjacent rows reads as two columns (Dany, 2026-08-30).
                // The clip mirrors the box's own: a wide roll-up loses
                // characters to the same edge a wide typed trio scrolls
                // behind, and the card carries the whole of both.
                <span
                  data-rolled-trio={step.id}
                  style={{
                    // **The leaf box's width rule, spelled the same way.**
                    // This span and that box are two spellings of one
                    // slot, and the moment they disagree a parent's figure
                    // and its leaves' stop lining up: left behind while
                    // the box was briefly `0 1 59px`, `stands a parent's
                    // figure in the same slot as its leaves'` failed on
                    // `Expected: 858 · Received: 872.875`. Watched in
                    // Chromium, 2026-08-31.
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    // **The box under a leaf's trio, spelled again.** A
                    // leaf types into an `<input>`, which carries the
                    // user agent's own `padding: 2px` and 1px border;
                    // this span carried neither, so a parent's first
                    // digit stood three pixels left of its children's
                    // and the column read as two columns — the same
                    // fault the figure had, one box further in (Dany,
                    // 2026-08-30). Transparent rather than absent: the
                    // border has to take its pixels for the text to
                    // start where the typed text starts, and a visible
                    // one would draw a box around a figure nobody can
                    // type into. `styles.css` does this for the Name
                    // cell's two boxes and gives the argument in full.
                    //
                    // **2px, which is the `<input>`'s own and not the
                    // `<textarea>`'s 1px** — Chromium's user agent
                    // defaults them differently and the box beside this
                    // one is an input. Written as the figure the browser
                    // reports rather than guessed: at 1px the test below
                    // failed on `borderLeftWidth "2px" / "1px"`, which is
                    // how the number was learned.
                    boxSizing: 'border-box',
                    padding: 2,
                    border: '2px solid transparent',
                  }}
                >
                  {atRest}
                </span>
              )}
              {finalSaysMore && (
                // `2/2/3 · 2.2`: the trio a person typed, and what the
                // project's estimate method makes of it. Muted and normal
                // weight, the treatment the assignee beside it has, for
                // the same reason — the bold thing in this cell is what
                // somebody chose, and both of these are the plan's answer
                // about it. The row's own total days is where a plan is
                // read at a glance, and it is unchanged.
                //
                // `flex: none`, so a narrow column takes its pixels out
                // of the box rather than out of this: the figure is three
                // characters and the box scrolls, and a clipped `2.` is
                // worse than a clipped trio the box can still be read in.
                //
                // **10px, the type this table's headings are set in
                // (`column-rebalance`), and it is load-bearing rather
                // than decorative.** At the row's own 13px the widest
                // trio anybody has typed here in anger — `20/24/30`,
                // live on dev, 2026-08-22 — did not fit: the box clipped
                // by 8px in a 96px column, measured in Chromium. The
                // caption size buys that back and leaves the figure
                // reading as the annotation it is rather than as a
                // second figure competing with the trio.
                // Proof: written at the row's own type instead, `holds a
                // trio and its figure on one line of a folded step cell`
                // failed on `the trio does not fit the box beside its
                // figure — Expected: <= 0, Received: 8`. Watched in
                // Chromium, 2026-08-30.
                <span
                  data-folded-final={step.id}
                  style={{
                    marginLeft: 3,
                    flex: 'none',
                    whiteSpace: 'nowrap',
                    fontWeight: 'normal',
                    fontSize: 10,
                    color: 'var(--muted-foreground)',
                  }}
                >
                  · {final}
                </span>
              )}
              {problem !== null && ' !'}
              {doing !== null && (
                // `4.8 · VA`, and the whole name in the tooltip. 96px holds
                // a figure and about four characters of a person, which is
                // how this printed `vad…` and `kuc…` — two people who read
                // identically. {@link initialsOf} is the same length every
                // time, so the column lines up and nothing needs an
                // ellipsis. Grey and in brackets where nobody is assigned
                // and somebody is assumed, exactly as the unfolded column
                // reads it.
                <span
                  data-folded-assignee={step.id}
                  {...(doing.assumed ? { 'data-assumed': step.id } : {})}
                  // No `title`, still. One was written here for the
                  // initials and taken back out: `leaves the assignee no
                  // title of its own to say it twice` is a decision from
                  // 2026-08-09 — a native tooltip is one line, a second
                  // late, and the hover card already names them in full
                  // (`folded-step-card.tsx`). Initials make the card more
                  // load-bearing, not the tooltip more welcome.
                  style={{
                    marginLeft: 4,
                    flex: 'none',
                    // The slot, so every row in a staffed column gives up
                    // the same width and the figure before it lands at one
                    // x. `hidden` rather than an ellipsis: the only form
                    // that overflows is the assumed `(XX)`, and half a
                    // bracket reads better than `…` where the card carries
                    // the whole name anyway.
                    width: ASSIGNEE_SLOT_PX,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    fontWeight: 'normal',
                    color: doing.assumed ? 'var(--muted-foreground)' : undefined,
                  }}
                >
                  · {doing.assumed ? `(${initialsOf(doing.name)})` : initialsOf(doing.name)}
                </span>
              )}
              {doing === null && reading.anyAssignee && (
                // The empty half of {@link ASSIGNEE_SLOT_PX}: a row with
                // nobody on it still gives up the slot, **but only in a
                // column where somebody is assigned**. That condition is
                // the whole of Dany's answer — an unstaffed plan pays
                // nothing and keeps its trio boxes full width.
                //
                // `aria-hidden` and empty: it is a spacer, and a screen
                // reader being told a row has an unnamed assignee would be
                // worse than it being told nothing. The cell's card is
                // where absence is stated in words.
                <span
                  aria-hidden="true"
                  data-folded-assignee-slot={step.id}
                  style={{ marginLeft: 4, flex: 'none', width: ASSIGNEE_SLOT_PX }}
                />
              )}
              {/*
                      Task 7.2's marker on the folded cell as well as the
                      unfolded one, and that is the point rather than a
                      duplication: steps start folded (`unfoldedSteps` is `[]`),
                      so a marker living only in the `by` column would be absent
                      from every plan nobody has unfolded. This cell already
                      holds the rule as `A folded step must not be able to hide
                      a complaint`; a signal is not a complaint, but it hides
                      exactly as easily.

                      `carded`, so the sentence rides {@link FoldedStepCard}
                      with the assignee's own name rather than fighting it as a
                      native tooltip.
                    */}
              {doing?.outside != null && (
                <MismatchMark kind="assignee" note={doing.outside} carded />
              )}
              {options.length > 0 && (
                <PickerList
                  id={listId}
                  label={`${step.name} assignee for ${row.original.number}`}
                  options={options}
                />
              )}
              {carded && (
                <FoldedStepCard
                  stepName={step.name}
                  number={row.original.number}
                  id={cardId}
                  points={POINTS.map((point) => ({
                    point,
                    // The row's own trio, off the row — **not** through
                    // `estimateValue`, and not through `combinedValue`
                    // below it. Those two answer with the draft where there
                    // is one, which is right for a box somebody is typing
                    // in and wrong for this: a card is what the fold left
                    // behind, and what the fold hid is the estimate be-01
                    // holds — the one the figure beside it is computed
                    // from, and the one every other reader of the plan
                    // sees. Reading the draft made a card say
                    // `realistic —` beside `Final 3.7 days`, and
                    // `Final 8/3/2 days` where a number of days belongs.
                    // The draft is not lost: unfolding the step puts it
                    // back in the box it was typed into, with its
                    // complaint, which is the only place it can be
                    // corrected. codex round 3, finding 4.
                    // Proof, two faults watched 2026-08-09. Points read
                    // through `estimateValue`: `reads the trio off the row,
                    // not out of the boxes it was typed into` failed on
                    // `expected 'Devoptimistic 2 · realistic — · pessi…' to
                    // contain 'realistic 3'`. `final` read through
                    // `combinedValue`: `says Final in days, whatever
                    // half-typed shorthand the cell is holding` failed on
                    // `expected 'Dev…Final 8/3/2 days' to contain 'Final
                    // 3.7 days'`.
                    days: showDays(row.original.estimates[step.id], point),
                  }))}
                  // The same read as the figure beside the box, and the
                  // same local: a card that computed its own would be a
                  // second opinion about one number, one element away.
                  final={final}
                  doing={doing}
                  problem={problem}
                />
              )}
            </span>
          );
        },
      }),
      ...(!unfolded
        ? []
        : [
            ...POINTS.map((point) =>
              column.display({
                id: `${step.id}-${point}`,
                // The step's name is on the group column; repeating it three
                // times over is how the headers came to set the table's width.
                //
                // The word itself in a `title`, because the column is 44px
                // and the word is not: measured on 2026-08-09, `optimistic`
                // wants 84px and reads `optimi`, `pessimistic` wants 95px
                // and reads `pessin`. There is no ellipsis to hint at it
                // either — the same answer the `Days` header takes, where
                // the sentence that would not fit moved into the `title`.
                //
                // One letter since `spreadsheet-geometry`, which is the
                // shorthand these cells already teach: the folded column's
                // box takes `o/r/p` as its placeholder and reads a trio
                // typed as `2/3/8`. A clipped word said less than its own
                // first letter does — `optimi` is not a word — and the
                // letter is what let the column drop to 44px. The word is
                // still the heading's accessible name, and it is the first
                // word of the `<th>`'s hint — which is why that one hint
                // opens with the column's name and the other fourteen open
                // with the effect (`column-hints.ts`).
                meta: { isEditable: (row) => !row.rolledUp, spokenHeading: point },
                header: () => <span>{point.slice(0, 1)}</span>,
                cell: ({ row }) => {
                  const reading = estimateReading(row.original, step.id);
                  if (reading.layout !== 'unfolded') {
                    throw new Error(`Expected unfolded estimate reading for step ${step.id}`);
                  }
                  const problem = reading.trioProblem;
                  const wrong = problem?.points.includes(point) ?? false;
                  return (
                    <CellInput
                      aria-label={`${step.name} ${point} for ${row.original.number}`}
                      cellKey={cellKey(row.original.id, `${step.id}-${point}`)}
                      // Narrow on purpose: these hold a number of days, and a box
                      // sized for a sentence reads as if it wants one. Which is
                      // the column's width to say now, not this box's.
                      //
                      // `decimal` and not `numeric` because half-days are typed
                      // here (`0.5`), and not `type="number"` for the folded
                      // cell's reason one column back — spinners a thumb cannot
                      // use. These three boxes had **no** `inputMode` at all
                      // until `wbs-mobile-orp-input`, so a touch device offered
                      // a letters keyboard for a box that only ever holds a
                      // number: the one three-box path a tablet can reach was
                      // the one path with no keypad on it.
                      inputMode="decimal"
                      aria-invalid={wrong}
                      data-fact={problem?.message}
                      onKeyDown={(e) => {
                        // Enter saves, the folded cell's rule in the face
                        // an estimator opens to argue about one number.
                        // A box with no list over it, so there is no
                        // `mentioning` arm to sit inside — the modifier
                        // guard is still the chord's, and is the whole of
                        // what this branch has to be careful about.
                        if (
                          e.key === 'Enter' &&
                          !e.metaKey &&
                          !e.ctrlKey &&
                          !e.altKey &&
                          !e.shiftKey
                        ) {
                          e.preventDefault();
                          void flushCell(e.currentTarget);
                          return;
                        }
                        live.current.onAltMove(e, row.original, `${step.id}-${point}`);
                        live.current.onCommandKey(e, row.original, `${step.id}-${point}`);
                        live.current.onTabKey(e, row.original.id, `${step.id}-${point}`);
                        live.current.onArrowKey(e, row.original.id, `${step.id}-${point}`);
                      }}
                      // A parent's figures are sums of what is below it, so the cell is
                      // shown and not editable — greyed rather than blank, because the
                      // number is real and worth reading.
                      readOnly={row.original.rolledUp}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        ...(row.original.rolledUp
                          ? { color: 'var(--muted-foreground)', background: 'var(--muted)' }
                          : wrong
                            ? {
                                background: 'var(--grid-invalid)',
                                borderColor: 'var(--destructive)',
                              }
                            : {}),
                      }}
                      value={reading.estimateValues[point]}
                      commit={(typed) =>
                        // A rolled-up figure is a sum of the rows below it:
                        // the box is read-only and there is nothing to send.
                        row.original.rolledUp
                          ? unsent()
                          : live.current.commitEstimate(row.original, step.id, point, typed)
                      }
                    />
                  );
                },
              }),
            ),
            column.display({
              id: `${step.id}-assignee`,
              meta: { isEditable: () => true },
              header: 'by',
              cell: ({ row }) => {
                const reading = estimateReading(row.original, step.id);
                if (reading.layout !== 'unfolded') {
                  throw new Error(`Expected unfolded estimate reading for step ${step.id}`);
                }
                const assigned = row.original.assignees[step.id];
                // Nobody on this step, and exactly one person on another: they are
                // assumed to be doing this step too, so the cell says so rather
                // than reading as unassigned. Assigning anyone here ends the
                // assumption by itself.
                const assumed = assigned === undefined ? row.original.doesEveryStep : null;
                // Task 7.2's second marker. Read through `assigneeOn` and
                // not off the row, because that is the one function that
                // resolves *which* person this cell shows — the named one
                // or the assumed one — and a marker computed from
                // `assigned` alone would go quiet on exactly the assumed
                // case, where nobody has looked at the assignment at all.
                const doing = reading.doing;
                const nameOf = (id: string) =>
                  row.original.readings.assigneeEntries.find((each) => each.id === id)?.name ??
                  '(unknown)';
                return (
                  // A flex row because the picker inside it is one now: the
                  // assumed name has to sit beside the box and shrink with
                  // it, rather than being pushed onto a line of its own.
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      maxWidth: '100%',
                      minWidth: 0,
                    }}
                  >
                    <CreatablePicker
                      label={`${step.name} assignee for ${row.original.number}`}
                      placeholder="search or add"
                      entries={row.original.readings.assigneeEntries}
                      value={assigned ?? null}
                      onChoose={(id) => {
                        live.current.assignTo(row.original.id, step.id, id);
                      }}
                      onCreate={(name) => {
                        live.current.createPersonFor(row.original, step.id, name);
                      }}
                      onClear={() => {
                        live.current.assignTo(row.original.id, step.id, null);
                      }}
                      gridCell={{
                        dataCell: cellKey(row.original.id, `${step.id}-assignee`),
                        onTabKey: (e) => {
                          live.current.onTabKey(e, row.original.id, `${step.id}-assignee`);
                        },
                        onCommandKey: (e) => {
                          live.current.onCommandKey(e, row.original, `${step.id}-assignee`);
                        },
                        onAltMove: (e) => {
                          live.current.onAltMove(e, row.original, `${step.id}-assignee`);
                        },
                      }}
                    />
                    {assumed !== null && (
                      <span
                        data-assumed={step.id}
                        data-fact="Only one person is assigned, so they are assumed to do this step too"
                        style={{
                          color: 'var(--muted-foreground)',
                          marginLeft: 4,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        ({nameOf(assumed)})
                      </span>
                    )}
                    {doing?.outside != null && (
                      <MismatchMark kind="assignee" note={doing.outside} />
                    )}
                  </span>
                );
              },
            }),
          ]),
    ];
  });
}

/**
 * The words the Columns control uses for the fixed columns a reader may hide —
 * the full word, where the header is abbreviated for width (`Prio`, `Not
 * bef.`) or is a glyph (People at once). Steps are named by the project.
 */
/**
 * How much of a folded step cell is kept for the assignee, **when that column
 * has one at all**.
 *
 * The derived figure beside the trio is a number people read down the column,
 * and it only lines up if everything to its right is the same width on every
 * row. The assignee is not: `· AI` is 19.51px, `· VS` 24.57, `· WW` 31.76 and
 * an assumed `· (WW)` 40.42, all measured in Chromium at this cell's `13px
 * sans-serif` on 2026-08-31. A row with nobody assigned reserved nothing at
 * all, which is the 28.57px Dany photographed.
 *
 * **Reserved per column and only when somebody is assigned in it** — his own
 * call, asked directly: "if there is no assignees on any work item, then
 * everything is aligned vertically without assignee, if there is at least one
 * assignee, then every row moves". So a plan nobody has staffed pays nothing
 * and its trio boxes stay full width; the moment one person is named, every row
 * in that column gives up the same 32px and the figures line up again.
 *
 * 32 and not 41: it seats `· WW`, the widest two-initial form, and lets an
 * assumed `· (WW)` clip by 8px rather than charge every row for a parenthesis
 * most plans never draw. The card names whoever it is in full
 * (`folded-step-card.tsx`), which is what makes the clip affordable.
 */
export const ASSIGNEE_SLOT_PX = 32;
