import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { usePageShortcutsSuspended } from '@/components/ui/page-shortcuts';

/** One thing a menu offers: what it is called, and what taking it does. */
export interface MenuAction {
  /** Stable within one menu — the React key, and what a caller names it by. */
  id: string;
  label: string;
  run: () => void;
  /**
   * Why this item cannot be taken here, or absent when it can.
   *
   * **Present-and-refused rather than absent**, which is the whole of what this
   * field buys. A frozen row's menu used to read `Duplicate / Unfreeze` with
   * `Delete` simply gone, and a reader who had seen `Delete` there a minute ago
   * had nothing on screen to tell them why it had left — the same fault the
   * drag handle's `aria-disabled` was written for, in a menu.
   *
   * Rendered as the item's `data-fact` and read out as its `aria-disabled`, and
   * `data-fact` rather than `data-hint` because it is about **this row** rather
   * than about what the item does — so it opens the moment the pointer arrives
   * instead of waiting three seconds. {@link FACT_ATTRIBUTE} carries the split.
   *
   * {@link MenuControl} refuses `run` while it is set. A reason and a refusal
   * from one field, because two fields is how an item comes to explain itself
   * and act anyway.
   */
  refusedBecause?: string;
}

/**
 * The words a trigger explains itself with — exactly one of the two kinds.
 *
 * `data-hint` is about **what the control does** and waits behind a ring;
 * `data-fact` is about **the thing on screen** and opens at once
 * (`tool-hints-wait` is the change that split them, and `hint.ts` holds both
 * attributes). A row's ⋯ is a hint; the schedule cue is a fact, because what
 * it explains is the project's own state rather than the button's job.
 *
 * A union rather than two optional fields, so a trigger cannot carry both:
 * `HintLayer` resolves a node with both to the fact and the hint would be
 * words nothing draws.
 */
export type MenuControlWords =
  { 'data-hint': string; 'data-fact'?: never } | { 'data-fact': string; 'data-hint'?: never };

interface MenuControlBase {
  /**
   * The accessible name of the trigger **and** of the menu it opens — one name
   * for both, because they are one control.
   */
  name: string;
  /** What the trigger shows — a glyph, a word, an icon. */
  children: ReactNode;
  actions: readonly MenuAction[];
  /** Whether this menu is the open one. Held by the caller: one at a time. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /**
   * A request is in flight, so the items are shown unavailable and refuse to be
   * taken — rather than being removed from a menu somebody is reading.
   */
  busy: boolean;
  /**
   * The trigger's **presentational** props only — className, style, `disabled`,
   * a `data-` mark. Spread before the ones this component owns, so its name,
   * its `aria-haspopup`/`aria-expanded`, its `title` and both of its handlers
   * cannot be overridden by a caller: those are the menu's behaviour, and a
   * caller that could replace them would be the second copy this component
   * exists to prevent.
   */
  trigger?: ButtonHTMLAttributes<HTMLButtonElement> & { 'data-busy'?: '' };
  /**
   * Which edge of the trigger the item box hangs from. `right` for a control at
   * the right edge of what it sits in, `left` for one in the middle of a row.
   */
  align?: 'left' | 'right';
}

export type MenuControlProps = MenuControlBase & MenuControlWords;

/**
 * The box the items sit in.
 *
 * `right: 0` is the row menu's: `actions` is the last column of the table, and
 * a 140px box hanging off the left edge of a 40px cell would open past the end
 * of the table instead of over it. It escapes the cell for the reason every
 * popover in this table does, and only because it is allowed to — see
 * `POPOVER_COLUMNS` in `wbs-table.tsx`, which exempts the `<td>` from `CELL`'s
 * clip. The z-index is the pickers', above all three of the sticky layers in
 * `table-frame.ts`, because an open menu has to be readable over a pinned
 * column and it closes the moment it has been used.
 *
 * A toolbar control is nowhere near an edge and hangs from its `left` instead,
 * so the items line up under the word that opened them.
 */
/** How much clear air a clamped menu keeps between itself and the window edge. */
const GUTTER_PX = 8;

/**
 * How far a menu has to move sideways to stay on screen, in CSS px.
 *
 * Negative pulls it left, positive right, zero leaves it where its `align`
 * put it. Pure, and separate from the component for the reason every
 * measurement in this app is: the numbers come from `getBoundingClientRect`,
 * which jsdom answers with zeroes, so the arithmetic can only be asserted where
 * it is handed the figures. That the shift is really applied is a browser fact
 * and is asserted in `e2e/optimization-cue.spec.ts`.
 *
 * **The fault it exists for, measured.** The schedule cue is the last control
 * in the plan toolbar, and on a window wide enough not to wrap that row the
 * pill stands at its right end: at 1600 the pill was at x=1400 and its 359px
 * box of items ran to 1759 — 159px of menu off the side of the screen, with no
 * way to read or reach the items on it (Dany, 2026-09-08). A menu that hangs
 * from `left: 0` cannot know that; only its own rectangle can say it.
 *
 * A box wider than the window it is in is pulled to the near gutter and clipped
 * at the far one rather than centred: the first item is the one a reader needs,
 * and `min` with the room actually available is what keeps the fix from
 * creating the opposite fault.
 */
export function menuShift(box: { left: number; right: number }, viewportWidth: number): number {
  const overRight = box.right - (viewportWidth - GUTTER_PX);
  const overLeft = GUTTER_PX - box.left;
  if (overRight > 0) {
    // Negated only when there is something to move, so a box already at the
    // gutter answers `0` rather than `-0` — which is a different value to
    // `Object.is`, and would reach the DOM as `translateX(-0px)`.
    const move = Math.min(overRight, Math.max(0, box.left - GUTTER_PX));
    return move === 0 ? 0 : -move;
  }
  if (overLeft > 0) return Math.min(overLeft, Math.max(0, viewportWidth - GUTTER_PX - box.right));
  return 0;
}

const menuBox = (align: 'left' | 'right'): CSSProperties => ({
  position: 'absolute',
  top: '100%',
  [align]: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  minWidth: 140,
  padding: 4,
  background: 'var(--popover)',
  color: 'var(--popover-foreground)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: '0 4px 12px oklch(0 0 0 / 12%)',
  zIndex: 15,
});

const ITEM: CSSProperties = {
  font: 'inherit',
  textAlign: 'left',
  border: 'none',
  background: 'none',
  color: 'inherit',
  borderRadius: 'var(--radius-sm)',
  padding: '3px 6px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/**
 * A set of actions behind one button — the ARIA menu button pattern, hand
 * rolled the way `CreatablePicker`'s list is.
 *
 * **One copy, two callers, and that is the point.** A row's ⋯ ({@link
 * ActionsMenu}) and the plan toolbar's `Freeze #` are the same keyboard, and
 * the keyboard is where this component's history is: the item handler shipped a
 * modifier guard that returned **without** `preventDefault`, so the browser
 * fired the button's own click and took the item the guard had just refused
 * (`AGENTS.md`, R5 #14). A second menu with a second copy of that handler is a
 * second place for that fault to come back, which is why `plan-toolbar-controls`
 * generalised this rather than writing one.
 *
 * Two narrowings of the ARIA pattern, both deliberate and both written down in
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
 * `open` is the caller's to hold, because at most one menu on the page may be
 * open at a time: two open menus are two sets of items with the same accessible
 * names, which is ambiguous to a screen reader and to a test alike.
 */
export function MenuControl({
  name,
  'data-hint': hint,
  'data-fact': fact,
  children,
  actions,
  open,
  onOpen,
  onClose,
  busy,
  trigger,
  align = 'right',
}: MenuControlProps): React.JSX.Element {
  // A menu owns the keyboard while it is open — `CONTEXT.md` says so, and this
  // is where that sentence is true. Cmd+Z fired through an open menu and undid
  // a rename behind it, observed live twice on 2026-08-09; the hook's own JSDoc
  // has why the chords are still let through to the items below. This is also
  // the whole of what "the freeze menu joins the inert-while-open set" means:
  // `onCommandKey` is wired to cells and a toolbar menu is not one, so the
  // page's own chords are the only ones that could reach past it.
  usePageShortcutsSuspended(open);

  const button = useRef<HTMLButtonElement | null>(null);
  const items = useRef<HTMLDivElement | null>(null);
  /**
   * How far this menu has been moved to keep it on screen — see {@link
   * menuShift}.
   *
   * Measured on every opening rather than once: the pill it hangs from is in a
   * toolbar that wraps, so the same control stands at the right edge of a wide
   * window and in the middle of a narrow one.
   */
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    // Narrowing rather than a guard: a layout effect runs on a mounted tree and
    // this branch only runs while the box is rendered. jsdom answers zeroes,
    // which is a shift of zero and leaves every existing case unchanged.
    const box = items.current?.getBoundingClientRect();
    if (box === undefined) return;
    setShift(menuShift({ left: box.left, right: box.right }, window.innerWidth));
  }, [open]);
  /** The rendered items, in order, so the one that is active can be focused. */
  const itemElements = useRef<(HTMLButtonElement | null)[]>([]);
  /** Which item holds the focus while the menu is open — the roving tab stop. */
  const [active, setActive] = useState(0);
  /**
   * That index, clamped to the items there are **now**.
   *
   * An item can leave a menu somebody is holding open: the schedule cue's
   * `Retry` is offered by a variant's own state, and a plan read that lands
   * while the menu is open takes it away. What that does unclamped is **drop
   * the focus**, measured rather than reasoned about: the effect below is keyed
   * on the index, so an unchanged `active` does not re-run it, the item holding
   * the focus unmounts, and the focus falls to `<body>` while the roving tab
   * stop points at an index that no longer exists. Clamped, the index moves,
   * the effect runs, and the focus lands on the last item there is.
   *
   * It keeps the throw for the case that throw was written for: a menu with no
   * items at all gives `-1`, and `.at(-1)` on an empty array is `undefined`.
   */
  const focusAt = Math.min(active, actions.length - 1);

  /**
   * Moves the DOM focus onto the active item whenever there is one.
   *
   * @throws When the item it was told to focus is not on the page. Unknown is
   * not OK, and this is the failure it hides: the ref callbacks below are the
   * wiring that would break silently, leaving `aria-expanded="true"` on a
   * button that still has the focus and a menu no keyboard can reach. Thrown
   * from an effect and never from `render`; both callers render this with at
   * least two actions and never with none.
   * Proof, both halves watched on 2026-08-08: replaced by a bare `return`,
   * `refuses to open with nothing to focus` failed on `expected [Function] to
   * throw an error`; and with the throw in place and the item `ref` callbacks
   * below deleted — the wiring failure this exists for — **10 of the 12 tests
   * in the file failed**, every one that opens the menu.
   */
  useEffect(() => {
    if (!open) return;
    const item = itemElements.current.at(focusAt);
    if (item === undefined || item === null) {
      throw new Error(`The ${name} menu opened with no item ${String(focusAt)} to focus.`);
    }
    item.focus();
  }, [open, focusAt, name]);

  /**
   * A press anywhere else closes the menu.
   *
   * `mousedown` rather than `click`: the press is what the person means by
   * "somewhere else", and waiting for the click would leave the menu open under
   * a text box that had already taken the caret. The press on this menu's own
   * button is inside the wrapper and so left alone — the button's own click
   * then closes it, which is what makes the trigger a toggle.
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

  const takeAction = (action: MenuAction): void => {
    // Proof: this line removed, `shows its items as unavailable while a request
    // is in flight, and refuses them` failed on `Unable to find an accessible
    // element with the role "menuitem"` — the first Enter took the action and
    // closed the menu, so the second half of the test had no menu left to press.
    // Watched, 2026-08-08.
    if (busy) return;
    // The same shape, for the reason this item is on screen at all: it is here
    // to say why it cannot be taken, so taking it is the one thing it must not
    // do. The menu stays open, because the sentence is in the item's
    // `data-fact` and closing the menu would take it away.
    // Proof: this line removed, `keeps Delete on a frozen row, refused and
    // saying why` failed on `expected [ { id: 'w1', …(16) }, …(1) ] to have a
    // length of 3 but got 2` — the row deleted by the item that says it cannot
    // delete it. Watched, 2026-08-09.
    if (action.refusedBecause !== undefined) return;
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
        {...trigger}
        ref={button}
        type="button"
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        data-hint={hint}
        data-fact={fact}
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
          // A **bare** key opens the menu, for the item handler's reason and
          // one more: this button sits in every row, so ⌘/Ctrl+Enter — the
          // table's next-or-create chord — used to open a menu over whichever
          // row the caret was passing. The key is consumed either way; the
          // guard decides only whether the menu opens.
          // Proof: this line removed, `opens on a bare Enter, Space or ↓ and on
          // no modified one` failed on `expected 'true' to be 'false'` for
          // Ctrl+Enter, and the browser's own `a modified Enter, Space or ↓
          // does not open the ⋯ menu` failed on `expected 0, received 1`.
          // Watched, 2026-08-09.
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (open) return;
          openOnto(0);
        }}
      >
        {children}
      </button>
      {open && (
        <div
          ref={items}
          role="menu"
          aria-label={name}
          style={{
            ...menuBox(align),
            // Measured **after** the box is laid out at its own place, so the
            // rectangle the shift is computed from is the unshifted one; a
            // second pass would otherwise chase its own correction.
            ...(shift === 0 ? {} : { transform: `translateX(${String(shift)}px)` }),
          }}
        >
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
              tabIndex={at === focusAt ? 0 : -1}
              // `aria-disabled`, never the attribute: a `disabled` button
              // cannot hold the DOM focus, so a menu that went busy while it
              // was open would drop the focus on the floor and one opened while
              // busy would have nothing to focus at all. It is also what keeps
              // a refused item on the roving tab stop, which is the only way
              // its reason gets read out.
              aria-disabled={busy || action.refusedBecause !== undefined}
              data-fact={action.refusedBecause}
              style={
                action.refusedBecause === undefined
                  ? ITEM
                  : { ...ITEM, cursor: 'not-allowed', color: 'var(--muted-foreground)' }
              }
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
                // **Before** the modifier guard, and that order is the whole
                // fix. A `<button>` fires a click of its own from Enter and
                // from Space unless the keydown was prevented, so returning
                // early left the browser to take the item the guard had just
                // refused — a chord aimed at the plan duplicating a branch
                // because a menu happened to be open. Observed live on
                // 2026-08-09.
                // Proof: this line moved back below the guard, `takes the key
                // away from a modified Enter or Space, and takes nothing`
                // failed on `expected true to be false`, and the browser's own
                // `a modified Enter or Space on a menu item takes nothing`
                // failed on Shift+Enter with a third row on screen. Watched,
                // 2026-08-09.
                event.preventDefault();
                // A **bare** Enter takes the item. Cmd/Ctrl+Enter is the
                // table's next-or-create chord, and the routing matrix says an
                // open menu is inert to it.
                // Proof: this guard removed, `every chord is inert while a
                // row’s ⋯ menu is open` failed on `expected [ { id: 'w1', … } ]
                // to have a length of 3 but got 4` — Duplicate taken by a
                // keystroke nobody aimed at it. Watched, 2026-08-08.
                if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
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

export interface ActionsMenuProps {
  /** The work item number this menu acts on, which is what names the button. */
  number: string;
  actions: readonly MenuAction[];
  /** Whether this row's menu is the open one. Held by the caller: one at a time. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  busy: boolean;
  /**
   * Grows the ⋯ button to a 44px tap target, every other pixel unchanged.
   *
   * Optional and off by default, so the table's 40px `actions` column — sized
   * for a mouse, not a finger — keeps the button it has always had. Cards are
   * the one caller that turns this on.
   */
  touchSized?: boolean;
}

/**
 * One row's actions, behind one ⋯ button.
 *
 * The keyboard, the focus rules and the item guards are all {@link
 * MenuControl}'s; what is here is the two things that are a *row's*: the name,
 * and the tap target.
 *
 * The name carries the number, because every row has one of these and `Actions`
 * alone would name as many buttons as there are rows — to a screen reader and
 * to a test alike. The items inside can be plainly named precisely because only
 * one menu is ever open.
 */
export function ActionsMenu({
  number,
  actions,
  open,
  onOpen,
  onClose,
  busy,
  touchSized = false,
}: ActionsMenuProps): React.JSX.Element {
  return (
    <MenuControl
      name={`Actions for ${number}`}
      data-hint="Row actions"
      actions={actions}
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      busy={busy}
      trigger={{
        style: touchSized
          ? {
              font: 'inherit',
              lineHeight: 1,
              padding: '0 4px',
              minWidth: 44,
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }
          : { font: 'inherit', lineHeight: 1, padding: '0 4px' },
      }}
    >
      ⋯
    </MenuControl>
  );
}
