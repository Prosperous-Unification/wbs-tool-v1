import { type KeyboardEvent, type ReactNode, useState } from 'react';

import { commandChordIn, escapesAnOpenList } from './keyboard-bindings';

export interface PickableEntry {
  id: string;
  name: string;
  /** Shown after the name, greyed — a person's teams, say. */
  detail?: string;
}

/** One line of an open picker list: what it says, and what taking it does. */
export interface PickerOption {
  /** Stable within one list — the React key. */
  key: string;
  label: ReactNode;
  /** Whether this is the entry currently in force, for `aria-selected`. */
  selected: boolean;
  take: () => void;
}

/** An entry as a list line reads it: the name, and its detail in grey. */
export function pickableLabel(entry: PickableEntry): ReactNode {
  return (
    <>
      {entry.name}
      {entry.detail !== undefined && (
        <span style={{ color: 'var(--muted-foreground)' }}> — {entry.detail}</span>
      )}
    </>
  );
}

/**
 * The list an open picker drops under its box.
 *
 * Shared rather than repeated, because there are two boxes that open one now:
 * this file's own combobox, and the folded estimate cell where an `@` starts a
 * mention (`wbs-table.tsx`). Both need the same three things to be true, and
 * each of them is a bug the moment two copies disagree about it — the
 * `mousedown` that must not blur the box behind it, the `z-index` that puts
 * the list above every sticky layer in `table-frame.ts`, and the `top: 100%`
 * that is measured from a `position: relative` wrapper the caller supplies.
 *
 * The caller owns the wrapper and the keyboard. This owns the box and the
 * lines in it.
 */
/**
 * The DOM id of one line, so a box above the list can point at it.
 *
 * The ids are per-line rather than one id moved onto whichever line is first
 * because `aria-activedescendant` is how arrow-key navigation says where it is:
 * the combobox points the attribute at whichever line is active, and every line
 * needs a name of its own for that to be a move rather than a rewrite.
 */
export function pickerOptionId(listId: string, index: number): string {
  return `${listId}-option-${String(index)}`;
}

export function PickerList({
  id,
  label,
  options,
  activeIndex = 0,
}: {
  id: string;
  label: string;
  options: readonly PickerOption[];
  /**
   * The line Enter takes, drawn and read as one. Defaults to the top because
   * the callers with no arrow-key path of their own (`@` mention lists, the
   * priority cell) take the top and always will; `CreatablePicker` passes the
   * index its arrows have walked to.
   */
  activeIndex?: number;
}) {
  // A list longer than its 200px box scrolls; the active line must be where
  // the eye is. jsdom has no scrollIntoView, hence the typeof — that boundary
  // is the test environment, not a browser this will meet. (Same guard the
  // depends list uses in `wbs-table.tsx`.)
  const scrollToActive = (element: HTMLLIElement | null, active: boolean) => {
    if (active && element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  };
  return (
    <ul
      role="listbox"
      id={id}
      aria-label={label}
      // `styles.css` reads this to tell a CreatablePicker's list from the
      // depends list: the two share `role='option'` under `[data-grid]`, but
      // this one carries its active line inline and must not inherit the
      // accent a hover or an `aria-selected` would otherwise paint there —
      // two lines looking active at once was the defect it exists to stop.
      data-picker-list=""
      // One preventDefault for the whole list, options included, by
      // bubbling: a mousedown here must not blur the input, or the list
      // would close before the click could land.
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        margin: 0,
        padding: 0,
        listStyle: 'none',
        background: 'var(--popover)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 4px 12px oklch(0 0 0 / 12%)',
        overflow: 'hidden',
        maxHeight: 200,
        overflowY: 'auto',
        zIndex: 15,
        minWidth: '100%',
      }}
    >
      {options.map((option, index) => {
        const active = index === activeIndex;
        return (
          // The ARIA combobox pattern is the boundary that makes this safe:
          // options are not focusable and the keyboard drives them from the
          // box above.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <li
            key={option.key}
            id={pickerOptionId(id, index)}
            role="option"
            aria-selected={option.selected}
            ref={(element) => {
              scrollToActive(element, active);
            }}
            // The line Enter takes, said in ink as well as in ARIA. Without it
            // the ordering fix is invisible: a reader typing a name that already
            // exists somewhere in the directory has no way to tell whether
            // Enter is about to make their team or join the other one. Exactly
            // one line wears it — the active one — because a second line
            // painted the same way is the defect this component was reworked
            // to end (TASK-104).
            //
            // `--accent` and not a border, because a border on one line moves
            // the lines under it by a pixel as the typing narrows the list.
            data-picker-take={active ? '' : undefined}
            style={{
              padding: '2px 6px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: active ? 'var(--accent)' : undefined,
            }}
            onClick={option.take}
          >
            {option.label}
          </li>
        );
      })}
    </ul>
  );
}

export interface CreatablePickerProps {
  label: string;
  /** Everything on offer, in the order the server sent it. */
  entries: readonly PickableEntry[];
  /** The chosen entry's id, or null. */
  value: string | null;
  onChoose: (id: string) => void;
  /**
   * Called with a name that is not in the list. The caller creates it and
   * chooses it.
   *
   * **Absent where the surface must not create**, which is the tag cell: a tag
   * is made on the directory page, where a typo can be seen and renamed,
   * rather than in a cell where it becomes a second spelling of something that
   * already exists (`tags`' own non-goal). With it absent, a name that matches
   * nothing offers nothing and the list simply does not open — which is the
   * honest answer for a picker that cannot make one.
   */
  onCreate?: (name: string) => void;
  /**
   * A visible `+` that opens the box's search list, on the leading edge —
   * the Depends-on cell's add affordance, carried by the shared component so
   * every surface that can create (Teams, Tags, Services, and the card faces)
   * inherits one `+` instead of three lookalikes.
   *
   * Only meaningful where {@link onCreate} is present: the `+` promises "add
   * here", so a surface that cannot make one must not pass it. The name is
   * typed in the box and Enter creates through `onCreate`; the button itself
   * only focuses the box, exactly as the deps `+` focuses its input. Not a
   * tab stop, for the deps `+`'s reason: Tab into the cell already lands on
   * the box, and a stop here would add one Tab per row to every walk.
   */
  addButtonLabel?: string;
  /** Absent where there is nothing a clear could take off. */
  onClear?: () => void;
  /**
   * Whether a chosen entry's clear action remains visible while the input has
   * focus.
   *
   * Absent preserves the table cell's compact contract: focus gives the
   * directory and the typed search the whole row. The phone card's modal sheet
   * opts in because its focus scope autofocuses this input as the sheet opens;
   * without this, the closed state that normally exposes Clear is unreachable.
   */
  clearVisibleWhileFocused?: boolean;
  placeholder?: string;
  /**
   * The box's own hover text, where the caller has something to say about a
   * value it did not store.
   *
   * The Service/team cell's inherited label is the case it exists for: the box
   * is empty because this row carries no team, and the placeholder beside it
   * names the one it inherits — which is a claim a reader is owed the source
   * of.
   */
  title?: string;
  /**
   * The cell this box edits, on a surface that is **not** a keyboard grid.
   *
   * Beside {@link gridCell} rather than inside it, and the pair below is why:
   * `gridCell` deliberately refuses to hand out the attribute without the keys,
   * because a box in a table that Tab can walk into and not out of is a trap.
   * A card is not a table. `plan-cards.tsx` wires none of `onTabKey`,
   * `onCommandKey` or `onAltMove` — a phone has no Tab key and no chords — yet
   * every editable box on a card still carries its cell's id, because that id
   * is what `editable-grid.ts` finds a box by and what makes a draft refused on
   * one face still be there on the other. The name box already does this; this
   * prop is how a picker can.
   *
   * Ignored when `gridCell` is given: a box in a grid takes the grid's id.
   */
  dataCell?: string;
  /**
   * What joins this box to a table's keyboard grid, where it stands in one.
   *
   * Both halves together, because either alone is broken: `dataCell` makes the
   * box somewhere the grid can land, and `onTabKey` is what lets Tab leave it
   * again. A box carrying only the attribute is one the keyboard can walk into
   * and not out of.
   *
   * Tab only. Enter, Escape and the typing stay this picker's own, and a
   * picker rendered without this prop is untouched: its Tab is the browser's.
   */
  gridCell?: {
    dataCell: string;
    onTabKey: (event: KeyboardEvent<HTMLInputElement>) => void;
    /**
     * The table's command chords, offered **only while this list is closed**.
     *
     * The condition is this component's to apply rather than the table's,
     * because whether a list is open is this component's own state and nothing
     * outside it can read it. An open list owns the keyboard — that is the
     * routing matrix's rule, and Escape is how it is given back — so a chord
     * that fired through one would create a work item under a half-typed
     * search nobody had finished.
     *
     * Narrowed in `table-mechanics` to the chords that *act on a row*: the
     * four motion chords are offered open or shut, because this box opens its
     * list on focus and a chord that only moves the caret out cannot commit
     * anything to a list nobody has finished reading. See
     * {@link escapesAnOpenList}.
     */
    onCommandKey: (event: KeyboardEvent<HTMLInputElement>) => void;
    /**
     * The table's Alt+arrow row moves, offered open or shut.
     *
     * Beside `onCommandKey` rather than folded into it because they are two
     * families with two handlers on the table's side, and the cheat sheet
     * promises this one "from any cell and any caret position" — a promise
     * this component broke by having no way to make it at all until now.
     */
    onAltMove: (event: KeyboardEvent<HTMLInputElement>) => void;
  };
}

/**
 * A combobox you can also type a new entry into — the "Jira label" shape Dany
 * asked for on 2026-08-06.
 *
 * Filtering is a case-insensitive substring, the same rule the dependency and
 * project pickers use; three pickers side by side that filter differently is a
 * surprise with nothing to gain from it.
 *
 * **Order is not the order given, and that is the whole of
 * `team-picker-substitutes`.** Typing `QA` into a new plan's team cell and
 * pressing Enter used to bind `claire qa billing`, because the list was the
 * directory's own order and Enter took the first line of it. The directory
 * being global is not the fault — `service_team`'s own comment says every
 * project draws from one list on purpose — the fault is that a name typed in
 * full lost to a name it merely sits inside, silently, on a control whose
 * choice levels the plan against that team's capacity.
 *
 * So the list is ranked by how much of it the typing accounts for, and Enter
 * takes the first line, whatever it is:
 *
 * 1. the entry spelled exactly that way (case aside),
 * 2. the entries it is the beginning of — autocomplete, which is why `plat`
 *    still binds `Platform` rather than making a team called `plat`,
 * 3. `Add "…"`, a new entry by the name as typed,
 * 4. the entries that merely contain it.
 *
 * The rule and the display are one thing rather than two that can disagree:
 * `options` below is both what is drawn and what Enter reads, and one
 * `activeIndex` state drives the highlight, Enter, and the input's
 * `aria-activedescendant` together — the option about to be taken is the
 * option shown as such. The arrows walk that index through the ranking;
 * typing puts it back on top, because a new search is a new question and the
 * top line is the answer.
 *
 * "Add" appears only when what has been typed matches no entry **exactly**.
 * Offering it beside an exact match is how a list grows a second `Platform`
 * with a trailing space, and be-01 is idempotent by name precisely because
 * that will still happen from two browsers at once.
 */
export function CreatablePicker({
  label,
  entries,
  value,
  onChoose,
  onCreate,
  addButtonLabel,
  onClear,
  clearVisibleWhileFocused,
  placeholder,
  title,
  dataCell,
  gridCell,
}: CreatablePickerProps) {
  /** What has been typed, or null while the picker is closed. */
  const [typed, setTyped] = useState<string | null>(null);
  /**
   * Which line Enter takes, shared by the highlight, Enter and
   * `aria-activedescendant` — one state rather than three that could disagree.
   * Every keystroke re-ranks the list and puts it back on top; the arrows walk
   * it. Clamped on the way to the render rather than trusted, because a list
   * the typing narrowed between the last move and this frame has fewer lines
   * than the index remembers.
   */
  const [activeIndex, setActiveIndex] = useState(0);

  // Derived from the label so two pickers in one row do not share an id.
  const listId = `creatable-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const chosen = entries.find((entry) => entry.id === value);
  const wanted = typed === null ? '' : typed.trim().toLowerCase();
  const offered =
    typed === null
      ? []
      : entries.filter((entry) => wanted === '' || entry.name.toLowerCase().includes(wanted));
  const exact = entries.some((entry) => entry.name.toLowerCase() === wanted);
  // `onCreate` absent means this surface cannot make one — see the prop.
  const canCreate = onCreate !== undefined && typed !== null && wanted !== '' && !exact;

  // The three tiers of the doc comment's ranking, over the entries that matched
  // at all. `leads` is true of everything while nothing has been typed, so a
  // freshly focused box is the directory in the order it arrived — the ranking
  // only has an opinion once there is something to rank against.
  const leads = (entry: PickableEntry) => entry.name.toLowerCase().startsWith(wanted);
  const isExact = (entry: PickableEntry) => entry.name.toLowerCase() === wanted;
  const ahead = [...offered.filter(isExact), ...offered.filter((e) => !isExact(e) && leads(e))];
  const behind = offered.filter((entry) => !leads(entry));

  const choose = (entry: PickableEntry): PickerOption => ({
    key: entry.id,
    label: pickableLabel(entry),
    selected: entry.id === value,
    take: () => {
      onChoose(entry.id);
      setTyped(null);
    },
  });
  /** What is drawn, and — first line first — what Enter takes. One array. */
  const options: PickerOption[] = [
    ...ahead.map(choose),
    // No `?.` and no re-test of `typed`: `canCreate` is
    // `onCreate !== undefined && typed !== null && …`, and TypeScript narrows
    // through an aliased condition, so either would be dead syntax the linter
    // is right to refuse. (It refused them, 2026-08-23.)
    ...(canCreate
      ? [
          {
            key: '(add)',
            label: `Add “${typed.trim()}”`,
            selected: false,
            take: () => {
              onCreate(typed.trim());
              setTyped(null);
            },
          },
        ]
      : []),
    ...behind.map(choose),
  ];
  const open = typed !== null && options.length > 0;
  const active = options.length === 0 ? 0 : Math.min(activeIndex, options.length - 1);

  return (
    // A flex row so the box and its ✕ share one cell's width instead of adding
    // up to more than it: the input takes what is left over and the button
    // keeps its own size. `minWidth: 0` on both, because a flex item refuses to
    // shrink below its content by default and an input's default content width
    // is about twenty characters — which is how this pair used to push past its
    // column. It is also the positioned ancestor the list below is placed
    // against — which decides where the list opens, not whether it is clipped.
    // The clipper is the `<td>` this sits in, and the columns this picker is
    // rendered in are exempted from that clip by `opensAPopover` in
    // `wbs-table.tsx`.
    <span style={{ position: 'relative', display: 'flex', maxWidth: '100%', minWidth: 0 }}>
      {addButtonLabel !== undefined && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={addButtonLabel}
          data-creatable-add=""
          // The press must not move the focus, or the box's own blur discards
          // what was typed — the deps `+`'s contract, and the Name cell's notes
          // marker before it. `preventDefault` on mousedown suppresses focus,
          // not the click below.
          onMouseDown={(pressed) => {
            pressed.preventDefault();
          }}
          onClick={(pressed) => {
            pressed.currentTarget.parentElement?.querySelector<HTMLInputElement>('input')?.focus();
          }}
          style={{ flexShrink: 0, marginRight: 2 }}
        >
          +
        </button>
      )}
      <input
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // Which line Enter takes, for a reader who cannot see the highlight.
        aria-activedescendant={open ? pickerOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        placeholder={placeholder}
        title={title}
        data-cell={gridCell?.dataCell ?? dataCell}
        // A layout the grid does not touch: the attribute is what the table
        // finds this box by, and it adds nothing to the flex row it sits in.
        style={{ font: 'inherit', flex: 1, minWidth: 0, width: 'auto' }}
        value={typed ?? chosen?.name ?? ''}
        onFocus={() => {
          setTyped('');
          setActiveIndex(0);
        }}
        // A blur discards the typing and shows the choice again. It does not
        // create anything: leaving a field is not a decision to add a team to
        // a list everybody shares.
        onBlur={() => {
          setTyped(null);
        }}
        onChange={(e) => {
          setTyped(e.target.value);
          // New typing, new ranking: the top line is the one that answers it.
          setActiveIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            // First, and on its own: leaving is the table's move, and the blur
            // it causes discards the typing exactly as any other blur here
            // does. A picker with no `gridCell` leaves the key to the browser.
            //
            // Proof: the call dropped, leaving only the `return`, `walks every
            // field of a row in turn, and on into the next row` failed with the
            // focus left in the team box. Watched, 2026-08-07.
            gridCell?.onTabKey(e);
            return;
          }
          if (e.key === 'Escape') {
            setTyped(null);
            setActiveIndex(0);
            return;
          }
          if (gridCell !== undefined && escapesAnOpenList(e)) {
            // The eight keys an open list may not swallow — four out of the
            // cell, four onto the row under it. Offered whether or not the
            // list is open, because it opens on focus: a rule that only held
            // while it was shut held for nobody.
            gridCell.onAltMove(e);
            gridCell.onCommandKey(e);
            return;
          }
          if (open) {
            // **Inert means consumed**, not merely "not the table's". The
            // bare-Enter branch below reads no modifiers, so a Cmd/Ctrl+Enter
            // that only skipped `onCommandKey` went on to choose the first
            // entry or create one out of a half-typed search — codex round 2,
            // finding 2. Taken from the browser as well, for the reason every
            // chord this table claims is: Ctrl+D unhandled is a bookmark.
            //
            // Only where the box is a cell of a grid. A picker with no
            // `gridCell` is not in a table, none of these keystrokes is a
            // chord there, and this component promises to leave it alone.
            //
            // Proof: this guard removed, `Cmd+Enter in an open team picker
            // takes no entry and creates none` failed on `expected 'team1' to
            // be null` and `Cmd+Enter in an open assignee picker assigns
            // nobody and adds nobody` on `expected [ 'assign w2 role-dev
            // person1' ] to deeply equal []`. Watched, 2026-08-08.
            if (gridCell !== undefined && commandChordIn(e) !== null) {
              e.preventDefault();
              return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              // An open list owns the bare arrows: they walk the options and
              // nothing else. The grid's own moves arrive as Alt+arrow or a
              // chord and left through `escapesAnOpenList` above — before this
              // branch on purpose, so an Alt+↑ aimed at the row moves the row,
              // not the highlight (the depends list's ordering, same reason).
              // Clamped, not wrapped: pressing past the last line is more often
              // a miscount than a request to start over.
              e.preventDefault();
              setActiveIndex((current) =>
                Math.max(
                  0,
                  Math.min(
                    options.length - 1,
                    Math.min(current, options.length - 1) + (e.key === 'ArrowDown' ? 1 : -1),
                  ),
                ),
              );
              return;
            }
          } else {
            // Proof: the `!open` guard dropped so the chords fired through an
            // open list, `every chord is inert while a team picker’s list is
            // open` failed on `expected '020' to be null` — a row armed for
            // deletion by a Ctrl+D aimed at a list of teams. Watched,
            // 2026-08-08.
            gridCell?.onCommandKey(e);
          }
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (typed === null) return;
          // One line, and it is the same line the reader is looking at: the
          // line the arrows walked to, or the top where they left it. The
          // branch that used to stand here — first filtered entry, else create
          // — was a second copy of the ordering rule, and the two disagreed:
          // the list showed `claire qa billing` under an `Add “QA”` nobody
          // could reach from the keyboard, and Enter took the one above it.
          options.at(active)?.take();
        }}
      />
      {chosen !== undefined && (typed === null || clearVisibleWhileFocused === true) && (
        <button
          type="button"
          aria-label={`Clear ${label}`}
          title="Clear"
          onClick={onClear}
          style={{ marginLeft: 2, flex: 'none' }}
        >
          ✕
        </button>
      )}
      {open && <PickerList id={listId} label={label} options={options} activeIndex={active} />}
    </span>
  );
}
