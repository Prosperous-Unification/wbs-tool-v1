import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react';

/** One thing a row's menu offers: what it is called, and what taking it does. */
export interface RowAction {
  /** Stable within one menu — the React key, and what a caller names it by. */
  id: string;
  label: string;
  run: () => void;
}

export interface ActionsMenuProps {
  /** The work item number this menu acts on, which is what names the button. */
  number: string;
  actions: readonly RowAction[];
  /** Whether this row's menu is the open one. Held by the caller: one at a time. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /**
   * A request is in flight, so the items are shown unavailable and refuse to be
   * taken — rather than being removed from a menu somebody is reading.
   */
  busy: boolean;
}

/**
 * The box the items sit in.
 *
 * `right: 0` rather than `left: 0`: `actions` is the last column of the table,
 * and a 140px box hanging off the left edge of a 40px cell would open past the
 * end of the table instead of over it. It escapes the cell for the reason every
 * popover in this table does, and only because it is allowed to — see
 * `POPOVER_COLUMNS` in `wbs-table.tsx`, which exempts the `<td>` from `CELL`'s
 * clip. The z-index is the pickers', above all three of the sticky layers in
 * `table-frame.ts`, because an open menu has to be readable over a pinned
 * column and it closes the moment it has been used.
 */
const MENU: CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  minWidth: 140,
  padding: 2,
  background: '#fff',
  border: '1px solid #ccc',
  zIndex: 15,
};

const ITEM: CSSProperties = {
  font: 'inherit',
  textAlign: 'left',
  border: 'none',
  background: 'none',
  padding: '2px 6px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/**
 * One row's actions, behind one ⋯ button — the ARIA menu button pattern, hand
 * rolled the way `CreatablePicker`'s list is.
 *
 * Two narrowings of that pattern, both deliberate and both written down in
 * `openspec/changes/actions-menu/design.md`. It is **not a focus trap**: Tab
 * closes it and the browser's own Tab carries the focus on from the button,
 * which is what makes a menu in a table walked with Tab bearable. And the DOM
 * focus really moves onto an item rather than staying on the button with
 * `aria-activedescendant` — the items are buttons, and an "active" button that
 * is not focused takes no Enter of its own.
 *
 * Where the focus goes **after** an action is the caller's business, with one
 * floor this component keeps: every activation closes the menu and puts the
 * focus back on its own button. That is the whole answer for an action that
 * leaves the row where it is, and the starting point for one that does not —
 * `wbs-table.tsx` moves the caret into the row that arrives once be-01 has
 * taken the change, so a refused request leaves the focus here, where the
 * person left it.
 *
 * `open` is the caller's to hold, because at most one menu in the table may be
 * open at a time: two open menus are two sets of items with the same accessible
 * names, which is ambiguous to a screen reader and to a test alike.
 */
export function ActionsMenu({
  number,
  actions,
  open,
  onOpen,
  onClose,
  busy,
}: ActionsMenuProps): React.JSX.Element {
  const button = useRef<HTMLButtonElement | null>(null);
  /** The rendered items, in order, so the one that is active can be focused. */
  const itemElements = useRef<(HTMLButtonElement | null)[]>([]);
  /** Which item holds the focus while the menu is open — the roving tab stop. */
  const [active, setActive] = useState(0);

  /**
   * Moves the DOM focus onto the active item whenever there is one.
   *
   * @throws When the item it was told to focus is not on the page. Unknown is
   * not OK, and this is the failure it hides: the ref callbacks below are the
   * wiring that would break silently, leaving `aria-expanded="true"` on a
   * button that still has the focus and a menu no keyboard can reach. Thrown
   * from an effect and never from `render`; `wbs-table.tsx` renders this with
   * two actions and never with none.
   * Proof, both halves watched on 2026-08-08: replaced by a bare `return`,
   * `refuses to open with nothing to focus` failed on `expected [Function] to
   * throw an error`; and with the throw in place and the item `ref` callbacks
   * below deleted — the wiring failure this exists for — **10 of the 12 tests
   * in the file failed**, every one that opens the menu.
   */
  useEffect(() => {
    if (!open) return;
    const item = itemElements.current.at(active);
    if (item === undefined || item === null) {
      throw new Error(
        `The actions menu for ${number} opened with no item ${String(active)} to focus.`,
      );
    }
    item.focus();
  }, [open, active, number]);

  /**
   * A press anywhere else closes the menu.
   *
   * `mousedown` rather than `click`: the press is what the person means by
   * "somewhere else", and waiting for the click would leave the menu open under
   * a text box that had already taken the caret. The press on this menu's own
   * button is inside the wrapper and so left alone — the button's own click
   * then closes it, which is what makes ⋯ a toggle.
   */
  useEffect(() => {
    if (!open) return undefined;
    const closeOnPressOutside = (event: MouseEvent) => {
      const pressed = event.target;
      if (pressed instanceof Node && wrapper.current?.contains(pressed) === true) return;
      onClose();
    };
    document.addEventListener('mousedown', closeOnPressOutside);
    return () => {
      document.removeEventListener('mousedown', closeOnPressOutside);
    };
  }, [open, onClose]);

  const wrapper = useRef<HTMLSpanElement | null>(null);

  const closeAndReturnFocus = (): void => {
    onClose();
    button.current?.focus();
  };

  const takeAction = (action: RowAction): void => {
    // Proof: this line removed, `shows its items as unavailable while a request
    // is in flight, and refuses them` failed on `Unable to find an accessible
    // element with the role "menuitem"` — the first Enter took the action and
    // closed the menu, so the second half of the test had no menu left to press.
    // Watched, 2026-08-08.
    if (busy) return;
    closeAndReturnFocus();
    action.run();
  };

  const openOnto = (at: number): void => {
    setActive(at);
    onOpen();
  };

  return (
    <span ref={wrapper} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={button}
        type="button"
        // The number, because every row has one of these and `Actions` alone
        // would name as many buttons as there are rows — to a screen reader and
        // to a test alike. The items inside can be plainly named precisely
        // because only one menu is ever open.
        aria-label={`Actions for ${number}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Row actions"
        style={{ font: 'inherit', lineHeight: 1, padding: '0 4px' }}
        onClick={() => {
          if (open) {
            onClose();
            return;
          }
          openOnto(0);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return;
          // Taken from the browser: Enter and Space on a button fire a click of
          // their own, and the click handler above would toggle the menu shut
          // again the instant this opened it.
          event.preventDefault();
          if (open) return;
          openOnto(0);
        }}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" aria-label={`Actions for ${number}`} style={MENU}>
          {actions.map((action, at) => (
            <button
              key={action.id}
              ref={(element) => {
                itemElements.current[at] = element;
              }}
              type="button"
              role="menuitem"
              // Roving tab stop: the item with the focus is the one Tab would
              // leave from, and the rest are out of the tab order entirely.
              // Proof: hard-coded to 0, `moves the focus with the arrows, and
              // the tab stop with it` failed on `expected '0' to be '-1'`.
              // Watched, 2026-08-08.
              tabIndex={at === active ? 0 : -1}
              // `aria-disabled`, never the attribute: a `disabled` button
              // cannot hold the DOM focus, so a menu that went busy while it
              // was open would drop the focus on the floor and one opened while
              // busy would have nothing to focus at all.
              aria-disabled={busy}
              style={ITEM}
              onClick={() => {
                takeAction(action);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  // Wraps, as a menu does: two items and a dead end at either
                  // one is a keyboard that stops working before the menu does.
                  setActive((at + step + actions.length) % actions.length);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeAndReturnFocus();
                  return;
                }
                if (event.key === 'Tab') {
                  // No `preventDefault`. The menu closes and the focus goes
                  // back to the button synchronously, so the browser's own Tab
                  // — which acts on whatever holds the focus when this handler
                  // returns — moves on from there. jsdom performs no default
                  // action for a synthetic key, so where it lands is measured
                  // in `e2e/layout.spec.ts` and not here.
                  closeAndReturnFocus();
                  return;
                }
                if (event.key !== 'Enter' && event.key !== ' ') return;
                // A **bare** Enter takes the item. Cmd/Ctrl+Enter is the
                // table's next-or-create chord, and the routing matrix says an
                // open menu is inert to it: a chord aimed at the plan must not
                // duplicate a branch because a menu happened to be open.
                // Proof: this guard removed, `every chord is inert while a
                // row’s ⋯ menu is open` failed on `expected [ { id: 'w1', … } ]
                // to have a length of 3 but got 4` — Duplicate taken by a
                // keystroke nobody aimed at it. Watched, 2026-08-08.
                if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
                event.preventDefault();
                takeAction(action);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
