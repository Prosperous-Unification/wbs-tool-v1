import { useCardOpenOn } from '../cell-card-store';
import { PICKER_PANEL_STYLE } from '../creatable-picker';
import { REFUSAL_SUFFIX } from '../dep-picker';
import { DependsCard, dependsLine } from '../depends-card';
import { cellKey } from '../editable-grid';
import { commandChordIn, escapesAnOpenList } from '../keyboard-bindings';
import { DEP_EDGE_FADE, DEP_LIST_WIDTH } from '../plan-cell-props';
import type { PlanLive } from '../plan-live';
import {
  REFERENCE_SET_ADD_CLASS,
  REFERENCE_SET_CHIP_CLASS,
  REFERENCE_SET_STRIP_STYLE,
} from '../reference-set-field';
import { column } from './column';

/** Builds the depends column family against the stable live cell contract. */
export function createDependsColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'depends',
    meta: { isEditable: () => true },
    header: 'Depends on',
    cell: ({ row }) => {
      // A subscription and not a reading off `live`: this cell is a component
      // ({@link flexRender} builds it with `createElement`), so it can be told
      // about its own card without the table rendering. First, and
      // unconditionally, because it is a hook.
      // `flexRender` builds this with `React.createElement`, so it **is** a
      // component and the hook below is legal; the rule reads the property
      // name `cell` and cannot see the call site.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const cardOpen = useCardOpenOn(live.current.cellCards, cellKey(row.original.id, 'depends'));
      // From the tree (`dependenciesOf` walks `flat`), never from the
      // rows on screen: a collapsed or filtered-out dependency has no row
      // to light, and the card naming it is then the only place it is
      // said at all.
      // Proof: narrowed to entries with a rendered `<tr>`, `a collapsed
      // dependency has no row to light, and the card still names it`
      // failed on `Unable to find an accessible element with the role
      // "tooltip"` — the hidden dependency dropped, the cell left with
      // nothing to say. Watched, 2026-08-10.
      const waitingFor = row.original.readings.dependencies;
      const dependsCell = cellKey(row.original.id, 'depends');
      // This cell's picker, or null while it is closed or under another row.
      const picker = row.original.readings.dependencyPicker;
      const entries = row.original.readings.dependencyEntries;
      // The entries a click or an Enter may actually take. A marked entry
      // is on screen to be read, not to be picked: be-01 would refuse it,
      // and the mark is this cell saying so before the click rather than
      // after it.
      const pickable = entries.filter((entry) => entry.refusal === undefined);
      // Resolved by id at render, so a highlight whose row has left the
      // list — or has since become one be-01 would refuse — is simply
      // nothing rather than somebody else's row.
      const activeOption =
        picker?.highlightId == null
          ? undefined
          : pickable.find((entry) => entry.id === picker.highlightId);
      const open = picker !== null && entries.length > 0;
      // Nothing to expand where nothing is waited for, and the picker owns
      // the cell while it is open: both boxes hang off the bottom edge of
      // one 110px cell, and the one somebody is typing into is the one they
      // are looking at. `picker`, not `open`: a picker with nothing to
      // offer is still a cell being typed in.
      const cardable = waitingFor.length > 0 && picker === null;
      const carded = cardable && cardOpen;
      // What the card says, for a reader with no pointer. This cell cannot
      // answer a focus with the card the way the folded step cell does —
      // the focus here already belongs to the picker, which opens on it and
      // offers the rows this one could *start* waiting for, and stacking
      // two boxes over one 110px cell is what the design ruled out. So the
      // names are a description of the box instead, off the same
      // `waitingFor` list the card is built from. codex round 3, finding 2.
      // Proof: the `aria-describedby` dropped from the input, `describes the
      // box with what the row waits for, pointer or no pointer` failed on
      // `expected null to be 'depends-w3'`. Watched, 2026-08-09.
      const waitsForId = `depends-${row.original.id}`;
      return (
        <span
          // **No `onMouseEnter` here, and that is this change.** The
          // cell-level dependency hover used to be on this wrapper, which
          // stands *inside* the `<td>`'s padding box and, at the column's
          // own 110px, is filled edge to edge by the pills — so a reader
          // pointing at the cell got nothing, and the only place that
          // answered the whole-cell gesture was the 15.8px add button. It
          // is on the `<td>` now; see `dependsCellHoverProps`, and
          // `openspec/changes/table-width-budget/design.md` D2 for the
          // measurement.
          //
          // This wrapper carried `whiteSpace: 'normal'` until 2026-08-10,
          // with the rationale "an uneven row height is a cost worth
          // paying; a dependency nobody can see is not". The change
          // `deps-single-line` reverses that decision by name — and
          // `table-geometry-and-tab-order`'s "wraps its chips onto a
          // second line rather than clipping them" with it (archived at
          // openspec/changes/archive/2026-08-10-table-geometry-and-tab-order/)
          // — because the full list now lives in the DependsCard hover
          // and the box's sr-only description, so the cell no longer has
          // to be several lines tall to say it. At rest the strip below
          // clamps to one clipped line; the fade on it is the cue.
          //
          // The positioned ancestor the listbox below is placed against —
          // which is what decides *where* the list opens, not whether it
          // is clipped. The clipper is the `<td>`, and it is what
          // {@link POPOVER_COLUMNS} exempts.
          style={{
            position: 'relative',
            display: 'block',
            maxWidth: '100%',
          }}
        >
          {waitingFor.length > 0 && (
            <span id={waitsForId} className="sr-only">
              {`Waiting for ${waitingFor.map(dependsLine).join(', ')}`}
            </span>
          )}
          {/*
                The strip: the chips and the box, and nothing else — the
                popovers below hang from the wrapper, because this box clips
                and they must not be inside the clipper. At rest it is one
                flex line that does not wrap; while the picker owns the cell
                **and the cell has chips** it wraps exactly as the cell always
                did, so typing and the open list are unchanged (precedent:
                {@link CellInputProps.restShowsFirstLineOnly} — clamped at
                rest, whole while somebody is in it). `whiteSpace: 'nowrap'`
                is not decoration beside `flexWrap`: it is what keeps a
                squeezed chip's `✕` from folding under its number and growing
                the one line into two. The fade is the rest state's
                truncation cue — {@link DEP_EDGE_FADE} says why it belongs to
                rest and to nothing else. No `+N` marker: counting hidden
                variable-width pills means real layout measurement for
                marginal information.

                **And only with chips**, which is this change's own correction
                and not a tidy. `wrap` plus the box's `width: 100%` claim
                means the box can never share a flex line with anything: its
                hypothetical size is the whole strip, so the 13px `+` beside
                it pushed it onto a second line and made an *empty* cell grow
                the moment somebody clicked into it. Measured on dev at
                `2b2affec` in a cloud Chromium, 2026-08-11: a chipless row
                rested at **26px** and stood at **44.98px** with the picker
                open, the box dropping from `y=198` to `y=219.98` and taking
                the listbox 21px down the page with it — the affordance
                moving the list somebody had just opened to read. Clicking
                the cell and clicking the `+` measured identically, so it was
                the layout and not the button's handler.

                Wrapping only for chips returns the open empty cell to the
                geometry it has at rest — one line, the box shrunk past the
                `+` by `minWidth: 0` to the same `84.2px` it rests at — and
                leaves the crowded cell's open state untouched, which is the
                half `deps-single-line` measured. The `+` was not hidden
                instead: always on screen is the whole of what it is for
                (Dany, 2026-08-11), and a cell somebody is typing into is
                where an affordance saying "another one" has most to say.

                Proof: the rest branch's `flexWrap` forced to `'wrap'`,
                `clamps the chips and the box onto one nowrap line at rest`
                failed on `expected 'wrap' to be 'nowrap'`. Watched,
                2026-08-10. The chipless half is its own check, below. The
                row height itself — seven chips no taller than none, a
                clipped chip invisible, an empty cell no taller open than
                shut — is Chromium's proof, in `e2e/deps-cell.spec.ts`.
              */}
          <span
            data-depends-strip={row.original.id}
            data-reference-strip=""
            style={{
              ...REFERENCE_SET_STRIP_STYLE,
              // Wrapping is for the chips, and only for them. See the
              // block above: an empty cell has nothing to wrap, and the
              // wrap is what made it two lines tall the moment it was
              // clicked into.
              flexWrap: picker !== null && waitingFor.length > 0 ? 'wrap' : 'nowrap',
              gap: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              // Pinned, in one line: the mask above fades the *physical*
              // right edge — the app is LTR-only today, and a
              // logical-direction gradient is not portable syntax.
              direction: 'ltr',
              ...(picker === null
                ? { WebkitMaskImage: DEP_EDGE_FADE, maskImage: DEP_EDGE_FADE }
                : {}),
            }}
          >
            {/*
                  The add affordance, first on the strip's line and always on
                  it. Adding a dependency has only ever been discoverable by
                  knowing that the cell's box is a box — a rested cell full of
                  chips shows `010 ✕ 030 ✕` and nothing that says another one
                  can be added (Dany, 2026-08-11). This is that affordance, and
                  it triggers exactly the flow a click in the cell already
                  triggers: the box takes the focus, and the box's own
                  `onFocus` opens the picker ready to type.

                  **First, not last.** The strip clips its right edge and fades
                  the last {@link DEP_EDGE_FADE} pixels of it; a trailing
                  affordance in a cell waiting on seven rows would be clipped
                  out of sight in exactly the crowded cell that needs it most,
                  and the box's `width: 100%` claim would have pushed it there
                  on an empty one too. The leading edge is the one place on a
                  clipping `nowrap` line that is never cut. Proven in Chromium
                  — `keeps the add button visible in a cell whose chips are
                  clipped`, `e2e/deps-cell.spec.ts` — because whether a box is
                  clipped is a layout fact and jsdom lays nothing out (R5
                  #14–16).

                  Sized as a chip and no larger: the row rests at 28px and the
                  chips are what set that line's height, so an affordance built
                  to their `line-height` costs the row nothing. `flexShrink: 0`
                  because a squeezed cell must clip chips rather than crush
                  this.
                */}
            <button
              type="button"
              data-dep-add={row.original.id}
              data-reference-add=""
              className={REFERENCE_SET_ADD_CLASS}
              // Not `Add a dependency to 020` — that is the box's own
              // label, and two controls in one cell answering to one name
              // is a reader told the same thing twice with no way to tell
              // which is which. The chips' voice instead: they say `Stop
              // 020 waiting for 030`, so this says what it starts.
              //
              // No `title` beside it. `Add a dependency` was one, and a
              // tooltip reading one thing while the accessible name reads
              // another is the control answering to two names — the exact
              // fault the name above was chosen to avoid, reintroduced by
              // the attribute that was meant to explain it (codex review,
              // 2026-08-11). The sighted reader has the `+`; anyone who
              // needs words has the name.
              aria-label={`Make ${row.original.number} wait for something`}
              // Deliberately not a tab stop, at rest and with the picker
              // open alike — where the chips flip (`deps-single-line`).
              // The keyboard already has this exact path and reaches it
              // first: Tab into the cell lands on the box, and the box's
              // focus is what opens the picker. A stop here would add one
              // Tab per row to every walk through the plan and offer
              // nothing at the end of it that the next Tab does not
              // already do. It stays a `<button>` with a name, so a
              // reader's element walk still finds it; what it does not do
              // is stand in the sequential order.
              tabIndex={-1}
              onMouseDown={(pressed) => {
                // The press must not move the focus. Without this the
                // button takes it, and a button taking the focus from this
                // cell's *own* box is a blur — which closes the picker and
                // drops what was typed into it (the box's `onBlur`, this
                // cell's contract since it was written). Somebody who
                // types `03` and then reaches for the affordance beside it
                // would lose the search to the control that means "search".
                // The precedent is the Name cell's notes marker, which
                // forwards its press to the box under it the same way.
                //
                // The click below still fires — `preventDefault` on
                // `mousedown` suppresses the focus, not the click (R5 #14's
                // lesson, read the other way round). And the action lives
                // there rather than here for two reasons: a `mousedown`
                // that re-renders before the browser performs its default
                // action is R5 #12's fault class, and an assistive
                // technology's activation dispatches a click with no
                // `mousedown` at all.
                pressed.preventDefault();
              }}
              onClick={(pressed) => {
                // The box is this button's sibling on the strip — the same
                // reach the notes marker makes, scoped by the row's own id
                // so a stale query can never focus another row's cell.
                const box = pressed.currentTarget.parentElement?.querySelector<HTMLInputElement>(
                  `[data-depends-input="${row.original.id}"]`,
                );
                /*
                        **A toggle**, and the question is about the picker rather
                        than the focus. Dany, 2026-09-01: _"can you make it so
                        that clicking second time on plus sign for tags/deps
                        on/teams/services hides the add UI"_.

                        `picker` is already exactly "this cell's picker, or null
                        while it is closed or under another row", so this cell
                        needs no `aria-expanded` reading the way the reference
                        strip's `+` does — it has the state itself. What it must
                        not read is the focus: this box opens its picker *on*
                        focus, so "focused" and "open" are the same thing here
                        only because nothing closes the list under a box that
                        keeps the focus. The reference strip's `+` says at length
                        why that distinction matters on the cells where a take
                        closes the list and leaves the focus behind.

                        `blur()` and not `setDepPicker(null)`: the blur is the
                        close this cell already makes from Escape and from a
                        click outside, and it clears the cell-level focus light
                        beside the picker. Closing the picker alone would leave
                        the box holding the keyboard with no list under it.
                      */
                if (picker !== null) {
                  box?.blur();
                  return;
                }
                box?.focus();
              }}
              style={{ flexShrink: 0 }}
            >
              +
            </button>
            {/*
                  How many rows this one waits for, on the leading edge beside
                  the `+` because that is the only place on a clipping `nowrap`
                  line that is never cut — the same reason the add affordance is
                  first (see the block above it).

                  **This is not the `+N` the block above ruled out**, and the
                  difference is the whole design. That marker was to be the
                  count of the *hidden* chips, which is a layout fact: it needs
                  the strip measured, a `ResizeObserver` on every deps cell, and
                  a number that changes when the column is dragged. This is the
                  count of the *dependencies*, which is data the cell already
                  holds — `waitingFor.length`, the same list the sr-only line
                  and the hover card are built from. It cannot be stale and it
                  needs nothing measured.

                  Filed by `wbs-e2e-planning-qa` on dev: `020` waits for four
                  rows, `030` five, `060` six, and every one of them showed two
                  clipped chips with no count anywhere — so the planner reading
                  the cell had no way to know the chips were a sample, and the
                  one dependency that explains the row's start is exactly the
                  one off the right edge. The fade said "there is more" to
                  somebody already looking for it; a number says how much more.

                  Only past one, because a single chip is the whole truth and a
                  `1` beside it is a second way of saying what is already said —
                  noise in a 110px cell whose every pixel is a chip that does
                  not fit.

                  `aria-hidden`, and that is deliberate rather than an omission:
                  the cell already tells a reader `Waiting for 010 - Strip, …`
                  in full through {@link waitsForId}, so a count spoken beside
                  it would be a third voice in one cell saying less than the
                  second.

                  **And no `data-hint` either**, which `hints-are-the-page-s-own`
                  took off it: this cell draws its own card on hover, listing
                  every row it waits for by name, and a hint card opening over
                  the same pixels to say `Waits for 2 rows` is the second
                  surface the Start cell's own comment refuses. The card is this
                  cell's one hint. Watched: with the hint back on, three of
                  `e2e/hover-cards.spec.ts`'s cases failed on `no card opened on
                  the depends cell · Expected: 1 · Received: 2`.
                */}
            {waitingFor.length > 1 && (
              <span data-dep-count={row.original.id} aria-hidden="true" style={{ flexShrink: 0 }}>
                {waitingFor.length}
              </span>
            )}
            {waitingFor.map(({ id, number }) => (
              <button
                key={id}
                type="button"
                data-reference-chip={id}
                className={`${REFERENCE_SET_CHIP_CLASS} border-0`}
                aria-label={`Stop ${row.original.number} waiting for ${number}`}
                // No hint here for the count's reason above: the cell's
                // own card owns this hover, and the ✕ already answers to
                // `Stop 020 waiting for 010`.
                // Out of the tab order while the strip is clipped: a
                // clipped chip is a native button a sequential Tab could
                // still reach, invisible, and the browser may scroll the
                // `overflow: hidden` strip to show what it focused —
                // shifting the rested layout. With the picker open the
                // strip wraps, every chip is on screen, and the ✕ is
                // focusable the way a visible button should be. Keyboard
                // removal is unchanged: Tab enters the cell at the box,
                // the picker opens on the focus, the chips are back.
                // Proof: the condition dropped (chips always focusable),
                // `keeps clipped chips out of the tab order at rest`
                // failed on `expected +0 to be -1`. Watched, 2026-08-10.
                tabIndex={picker === null ? -1 : undefined}
                // The pill-level hover: this one dependency's row alone,
                // and the card's emphasis with it. A chip the strip has
                // clipped simply has no hover target — the cell-level
                // enter above still lights every dependency's row, which
                // is the U3→U4 case named in the plan rather than
                // discovered.
                onMouseEnter={() => {
                  // **No guard, since 2026-09-09**, and the cell's own is gone
                  // with it: while the card stood *under* its cell, a chip of
                  // the row beneath was what the pointer landed on inside the
                  // card's passive padding, and narrowing to that chip's row lit
                  // the wrong plan. The card opens **beside** its cell now, so
                  // no chip but this card's own row's is ever under it.
                  live.current.depLights.updateHover((current) =>
                    current?.rowId === row.original.id && current.pillId === id
                      ? current
                      : { rowId: row.original.id, pillId: id },
                  );
                }}
                onMouseLeave={() => {
                  // Off the pill but still in the cell: back to the whole
                  // waited-for set, not cleared — the wrapper's own leave
                  // is what clears. Guarded on this pill's id so a leave
                  // that lands after the next pill's enter cannot widen
                  // the hover that enter just narrowed.
                  // Proof: the restore dropped (leave returning
                  // `current`), `narrows to the pill's row, and widens
                  // again when the pill is left` failed on `expected
                  // ['010'] to deeply equal ['010', '020']`. Watched,
                  // 2026-08-10.
                  live.current.depLights.updateHover((current) =>
                    current?.rowId === row.original.id && current.pillId === id
                      ? { rowId: row.original.id, pillId: null }
                      : current,
                  );
                }}
                // The keyboard's reading of the same pill — see
                // {@link depFocus}. The enter/leave pair above, with focus
                // in place of the pointer, and one difference: the blur
                // *clears* where the leave widens. A leave means the
                // pointer is still in the cell (the wrapper's own leave is
                // what clears); a blur means nothing of the sort, and
                // widening on it would leave the cell lit forever once the
                // focus walked out of the plan from a chip. Focus moving
                // chip → box relights the cell from the box's own focus,
                // which fires after this blur.
                onFocus={() => {
                  live.current.depLights.updateFocus((current) =>
                    current?.rowId === row.original.id && current.pillId === id
                      ? current
                      : { rowId: row.original.id, pillId: id },
                  );
                }}
                onBlur={() => {
                  live.current.depLights.updateFocus((current) =>
                    current?.rowId === row.original.id && current.pillId === id ? null : current,
                  );
                }}
                onClick={() => {
                  // This button *is* the pill, so the click unmounts it and
                  // no `mouseleave` or `blur` of its own ever arrives: the
                  // hover would stay on an id the cell no longer names and
                  // keep the cut edge's row lit under a pointer that had
                  // not moved. The pointer *is* still in the cell, so this
                  // widens to the cell itself — exactly what the leave that
                  // cannot fire would have done, which is why the light
                  // goes to the remaining dependencies rather than out.
                  // Focus is cleared instead, for the reason `onBlur` above
                  // gives. `depLit` refuses a `pillId` the cell no longer
                  // names as well: this end is the pointer's truth, that
                  // end is the paint's.
                  //
                  // Proof: this widen dropped, `widens back to the
                  // remaining dependencies when a pill is deleted under the
                  // pointer` failed on `expected [] to deeply equal
                  // ['020']` — the light gone from a cell the pointer was
                  // still in. Watched, 2026-08-11.
                  live.current.depLights.updateHover((current) =>
                    current?.rowId === row.original.id && current.pillId === id
                      ? { rowId: row.original.id, pillId: null }
                      : current,
                  );
                  live.current.depLights.updateFocus((current) =>
                    current?.rowId === row.original.id && current.pillId === id ? null : current,
                  );
                  void live.current.run(() =>
                    live.current.api.removeDependency(row.original.id, id),
                  );
                }}
              >
                {number} ✕
              </button>
            ))}
            <input
              aria-label={`Add a dependency to ${row.original.number}`}
              role="combobox"
              aria-expanded={open}
              aria-controls={open ? `dep-options-${row.original.id}` : undefined}
              aria-activedescendant={
                activeOption === undefined ? undefined : `dep-option-${activeOption.id}`
              }
              aria-autocomplete="list"
              aria-describedby={waitingFor.length > 0 ? waitsForId : undefined}
              placeholder="search, or 010, 020"
              // No hint on this box, for the count chip's reason above:
              // the Depends on cell draws its own card over these pixels,
              // and a second surface saying how to type into the box is
              // the race `start-date-hover-card` removed rather than one
              // to reintroduce. The placeholder beside it —
              // `search, or 010, 020` — is the same instruction, on
              // screen, with nothing to open. Watched with the hint back
              // on: `no card opened on the depends cell · Expected: 1 ·
              // Received: 2`, the second card reading `Type to search by
              // number or name, or a l…`.
              // `minWidth: 0` is what lets the box shrink behind the chips
              // on the strip's one rested line: a flex item's automatic
              // minimum would hold an `<input>` at its intrinsic width and
              // push its rect out past the cell. `100%` is still its claim
              // — the whole cell where it has the line to itself, the
              // remainder where it does not.
              style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
              data-depends-input={row.original.id}
              // A cell of the keyboard grid, so Tab reaches this box and
              // leaves it again rather than walking the chips' ✕ buttons.
              data-cell={cellKey(row.original.id, 'depends')}
              value={picker?.typed ?? ''}
              onFocus={() => {
                live.current.setDepPicker({
                  rowId: row.original.id,
                  typed: '',
                  highlightId: null,
                });
                // The keyboard's cell-level light — see {@link depFocus}.
                // This is the reachable half: Tab through the plan lands on
                // this box, and the rows the row waits for light while it
                // is here. Guarded on having something to say by the same
                // rule the wrapper's `mouseenter` uses.
                if (waitingFor.length > 0) {
                  live.current.depLights.updateFocus(() => ({
                    rowId: row.original.id,
                    pillId: null,
                  }));
                }
              }}
              onBlur={() => {
                live.current.setDepPicker((current) =>
                  current?.rowId === row.original.id ? null : current,
                );
                // Only the cell-level focus this box owns. `pillId === null`
                // in the guard and not just the row: focus moving box → chip
                // fires this blur *before* the chip's focus, and without the
                // field in the guard a later blur could not tell its own
                // reading from the chip's.
                live.current.depLights.updateFocus((current) =>
                  current?.rowId === row.original.id && current.pillId === null ? null : current,
                );
              }}
              onChange={(e) => {
                const typed = e.currentTarget.value;
                // Typing is aiming at the narrowed-to entry; emptying the
                // cell aims at nothing again.
                const first =
                  typed.trim() === ''
                    ? undefined
                    : live.current
                        .depEntriesFor(row.original, typed)
                        .find((entry) => entry.refusal === undefined);
                live.current.setDepPicker({
                  rowId: row.original.id,
                  typed,
                  highlightId: first?.id ?? null,
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  // The move blurs this input, which closes the list and
                  // drops what was typed into it — this cell's blur contract
                  // since it was written, now reached by Tab on purpose. The
                  // typed text is a *search*: committing it on the way out
                  // would add dependencies nobody confirmed.
                  //
                  // Proof: the call dropped, leaving only the `return`, both
                  // `Tab from the depends input closes the picker…` and
                  // `Shift+Tab from the depends input lands in the name…`
                  // failed with the key left to the browser. Watched,
                  // 2026-08-07.
                  live.current.onTabKey(e, row.original.id, 'depends');
                  return;
                }
                if (escapesAnOpenList(e)) {
                  // The eight keys the list may not swallow: the four
                  // motion chords out of this cell and the four row moves
                  // under it. This box opens its list on **focus**, so
                  // without this branch Ctrl+L into it had no documented
                  // way out — see {@link escapesAnOpenList}, which is where
                  // the split between these and the chords that make or
                  // destroy a row is argued.
                  //
                  // Before the ArrowUp/ArrowDown branch below on purpose:
                  // that one reads no modifiers, so an Alt+↑ aimed at the
                  // row would have moved the list's highlight instead.
                  live.current.onAltMove(e, row.original, 'depends');
                  live.current.onCommandKey(e, row.original, 'depends');
                  return;
                }
                if (open && commandChordIn(e) !== null) {
                  // Inert means consumed. Skipping `onCommandKey` was not
                  // enough on its own: Cmd/⌘+Enter fell through to the Enter
                  // branch below, which reads no modifiers, and added the
                  // highlighted dependency — codex round 2, finding 2.
                  // Proof: this guard removed, `Cmd+Enter in the open
                  // depends list adds no dependency` failed on `expected
                  // <button type="button" …(2)></button> to be null` — the
                  // chip for an edge nobody confirmed. Watched, 2026-08-08.
                  e.preventDefault();
                  return;
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  live.current.moveDepHighlight(
                    row.original.id,
                    e.key === 'ArrowDown' ? 1 : -1,
                    // The refused entries are not in this list, so the
                    // highlight steps over them: a highlight that could stop
                    // on one would be an Enter that does nothing, which is
                    // the click this change exists to prevent.
                    pickable.map((entry) => entry.id),
                  );
                  return;
                }
                if (e.key === 'Escape') {
                  live.current.setDepPicker(null);
                  return;
                }
                if (!open) {
                  // Closed, this is a cell like any other and the chords
                  // that make and destroy a row reach it. Open, the list
                  // owns those — the routing matrix's inert row, narrowed
                  // by the branch above to the chords that act on a row
                  // rather than merely leaving the cell.
                  // Proof: the condition forced true, `every chord is inert
                  // while the depends list is open` failed on `expected
                  // <input …(11)></input> to be <input …(10)></input>` — the
                  // focus taken out of a list somebody was reading. Watched,
                  // 2026-08-08.
                  live.current.onCommandKey(e, row.original, 'depends');
                }
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (activeOption !== undefined) {
                  void live.current.pickDependency(row.original.id, activeOption.id);
                  return;
                }
                // No highlight to take — the typed flow: one number or a
                // separated list of them, exactly as this cell always worked.
                const typed = picker?.typed ?? e.currentTarget.value;
                if (typed.trim() === '') return;
                live.current.dependOn(row.original.id, typed);
                live.current.setDepPicker((current) =>
                  current === null ? null : { ...current, typed: '', highlightId: null },
                );
              }}
            />
          </span>
          {picker !== null && entries.length > 0 && (
            <ul
              role="listbox"
              id={`dep-options-${row.original.id}`}
              aria-label={`Work items ${row.original.number} can depend on`}
              // One preventDefault for the whole list — options included,
              // by bubbling. A mousedown anywhere here must not take the
              // input's focus: on an option, blur would close the list
              // before the click could pick; on the scrollbar, the list
              // unmounted under the pointer and everything past the fold
              // was unpickable by mouse (cross review #6).
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              style={{
                // {@link PICKER_PANEL_STYLE} and not a copy of it. This
                // list is the one the four reference cells do **not**
                // share a component with, and the copy it used to carry
                // had drifted: no radius, no shadow, no `overflow:
                // hidden`, so the same gesture drew a flat square list
                // here and a rounded card three columns over. The tokens
                // that copy did get right — `--popover` over `#fff`, on a
                // dark page 1.05:1 measured — are in the shared style now.
                ...PICKER_PANEL_STYLE,
                // `--popover-foreground` is this list's own: the reference
                // panel inherits the cell's colour and reads correctly
                // doing it, and changing that is not what was asked for.
                color: 'var(--popover-foreground)',
                // The table's own popover layer, which is 10 everywhere in
                // this file. `CreatablePicker` stacks its list at 15 —
                // that is its surface's number, not this one's.
                zIndex: 10,
                // Wider than its own column on purpose, since that column
                // is 110px: an entry is a work item's number and its name,
                // and a list as narrow as the box it drops from would show
                // the number and about four letters. It escapes the cell
                // either way — see `opensAPopover`.
                minWidth: DEP_LIST_WIDTH,
              }}
            >
              {entries.map((entry) => (
                // The ARIA combobox pattern is the boundary that makes this
                // safe: options are not focusable, and the keyboard drives
                // them from the input above through aria-activedescendant
                // (ArrowUp/ArrowDown/Enter there).
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <li
                  key={entry.id}
                  id={`dep-option-${entry.id}`}
                  role="option"
                  aria-selected={entry.id === activeOption?.id}
                  // Shown and refused, rather than quietly absent: a row
                  // that vanishes from the list reads as a bug in the tool,
                  // and one that says why it cannot be picked teaches the
                  // shape of the plan.
                  aria-disabled={entry.refusal !== undefined}
                  // The list scrolls; the highlighted entry must be where
                  // the eye is. jsdom has no scrollIntoView, hence the
                  // typeof — that boundary is the test environment, not a
                  // browser this will meet.
                  ref={(element) => {
                    if (
                      entry.id === activeOption?.id &&
                      element !== null &&
                      typeof element.scrollIntoView === 'function'
                    ) {
                      element.scrollIntoView({ block: 'nearest' });
                    }
                  }}
                  style={{
                    padding: '2px 6px',
                    cursor: entry.refusal === undefined ? 'pointer' : 'default',
                    whiteSpace: 'nowrap',
                    color: entry.refusal === undefined ? undefined : 'var(--muted-foreground)',
                    // No `background` here at all any more. `#e8f0fe` was
                    // an inline style that outranked the stylesheet's own
                    // `[data-grid] [role='option'][aria-selected='true']`
                    // rule — which paints `var(--accent)` and has been
                    // there all along — so the keyboard's highlight was a
                    // fixed pale blue while the pointer's followed the
                    // palette. One rule now answers for both.
                  }}
                  onClick={() => {
                    if (entry.refusal !== undefined) return;
                    void live.current.pickDependency(row.original.id, entry.id);
                  }}
                >
                  {/*
                        `010 - Strip the hull`, the way the plan is spoken
                        about: a space alone let a number and a name that starts
                        with a digit run together. The filter behind the list
                        already matches either half (`pickerEntries`).
                      */}
                  {entry.number} - {entry.name}
                  {entry.refusal === undefined ? '' : ` — ${REFUSAL_SUFFIX[entry.refusal]}`}
                </li>
              ))}
            </ul>
          )}
          {carded && (
            <DependsCard
              number={row.original.number}
              entries={waitingFor}
              // This cell's pill hover and no other's: a card is only on
              // screen for the hovered cell, but the guard keeps a stale
              // `depHover` from another row emphasising an entry here.
              // Proof: hardcoded to null, `emphasises the pill's entry in
              // the card as a background, not bold` failed on `expected
              // '' to be 'var(--card-dep-lit)'`. Watched, 2026-08-11.
              // Subscribed inside the card since 2026-09-02, so moving
              // the pointer between its entries costs a render of the
              // card and not of the plan. The guard the prop used to
              // carry is {@link DepLights.pillFor}'s own.
              depLights={live.current.depLights}
              rowId={row.original.id}
              onPointEntry={(pillId) => {
                // **A line of the card, and only a line, is an arrival on the
                // card.** The bridge also reports the pointer on this cell
                // itself (`pillId === null`), and until the takeover that too
                // went to the store as `cancelHold` — harmless while every
                // arrival elsewhere was instant. It is not harmless now: at a
                // row boundary the bridge's rectangle test still says "owner"
                // for a point Chromium has already handed to the row below, so
                // the store had just been told `arriveOn(030)` when this said
                // "on the card" and dropped that takeover. Traced in Chromium
                // on 2026-09-11 — `arriveOn 030 · bridge move owner · arriveOnCard
                // pending=030 · bridge move outside · hold fired` — and 030 never
                // answered. The cell's own `mouseenter` is what says the pointer
                // is back on this cell, and it goes through `arriveOn`.
                // Proof: the guard removed (every region cancelling) — `card-lanes.spec.ts`'s
                // `the pointer walks down each column and every row answers for
                // itself` failed on `Depends on: the pointer reached 030 and 030
                // did not answer · Expected: 1 · Received: 0`. Watched, 2026-09-11.
                if (pillId !== null) live.current.cellCards.arriveOnCard();
                live.current.depLights.updateHover((current) =>
                  current?.rowId === row.original.id && current.pillId === pillId
                    ? current
                    : { rowId: row.original.id, pillId },
                );
              }}
              onPointerOutside={() => {
                live.current.depLights.updateHover((current) =>
                  current?.rowId === row.original.id ? null : current,
                );
                // **Held rather than cleared**, since the card became diagonal
                // — past this cell and past this row — so the pointer going to
                // one of its lines is outside every region the bridge knows for
                // the length of the trip. See {@link REACH_FOR_THE_CARD_MS};
                // arriving on the card cancels it, because the card is inside
                // this cell's own subtree.
                live.current.cellCards.holdHovered(dependsCell);
              }}
            />
          )}
        </span>
      );
    },
  });
}
