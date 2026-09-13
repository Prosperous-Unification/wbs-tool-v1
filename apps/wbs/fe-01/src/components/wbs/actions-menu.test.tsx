import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionsMenu, type MenuAction, menuShift } from './actions-menu';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

/**
 * The menu with its open state held for it, the way the table holds it.
 *
 * A controlled component tested through a controller rather than by re-rendering
 * with new props: "one menu open at a time" is the table's rule and this is the
 * smallest thing that keeps it, so every test here presses keys at a menu that
 * really opens and closes.
 */
function Harness({
  actions,
  busy = false,
}: {
  actions: readonly MenuAction[];
  busy?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <ActionsMenu
        number="020"
        actions={actions}
        busy={busy}
        open={open}
        onOpen={() => {
          setOpen(true);
        }}
        onClose={() => {
          setOpen(false);
        }}
      />
      <button type="button">Somewhere else</button>
    </div>
  );
}

/** Two actions that record being taken, which is all the menu owes its caller. */
function twoActions(taken: string[]): MenuAction[] {
  return [
    {
      id: 'duplicate',
      label: 'Duplicate',
      run: () => {
        taken.push('duplicate');
      },
    },
    {
      id: 'delete',
      label: 'Delete',
      run: () => {
        taken.push('delete');
      },
    },
  ];
}

const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'Actions for 020' });
const items = (): HTMLElement[] => screen.getAllByRole('menuitem');

/**
 * The sideways clamp, asserted where the figures can be handed to it.
 *
 * jsdom lays nothing out — every rectangle is zeroes — so the component cannot
 * be observed shifting anything here. This is the arithmetic; that the shift is
 * really applied to a real box is `e2e/optimization-cue.spec.ts`'s, against the
 * 1600px window where the fault was measured.
 */
describe('menuShift', () => {
  it.each([
    ['a box with room on both sides stays put', { left: 400, right: 759 }, 1600, 0],
    ['the schedule cue at 1600, measured', { left: 1400, right: 1759 }, 1600, -167],
    ['a box exactly on the gutter stays put', { left: 100, right: 1592 }, 1600, 0],
    ['one pixel past it moves one pixel', { left: 100, right: 1593 }, 1600, -1],
    ['a box hanging off the left is pushed right', { left: -20, right: 300 }, 1600, 28],
  ] as const)('%s', (_what, box, viewportWidth, expected) => {
    expect(menuShift(box, viewportWidth)).toBe(expected);
  });

  it('pulls a box wider than the window to the near gutter and no further', () => {
    // 500px of items in a 390px phone: the first item is the one a reader
    // needs, so the box is clipped on the far side rather than centred.
    expect(menuShift({ left: 16, right: 516 }, 390)).toBe(-8);
    // And the same box already at the gutter cannot move at all, rather than
    // being pushed off the left edge to satisfy the right one.
    expect(menuShift({ left: 8, right: 508 }, 390)).toBe(0);
  });
});

describe('the row actions menu', () => {
  itDom('says what it is before anything is pressed', () => {
    render(<Harness actions={twoActions([])} />);

    const button = menuButton();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  itDom('opens on Enter, Space and ↓, landing the focus on the first item', () => {
    for (const key of ['Enter', ' ', 'ArrowDown']) {
      render(<Harness actions={twoActions([])} />);
      const button = menuButton();
      button.focus();

      fireEvent.keyDown(button, { key });

      expect(button.getAttribute('aria-expanded')).toBe('true');
      // The focus really moves into the menu, rather than the button keeping it
      // with `aria-activedescendant` pointing at an item: these items are
      // buttons, and a button that is not focused takes no Enter of its own.
      expect(document.activeElement).toBe(items()[0]);
      cleanup();
    }
  });

  itDom('moves the focus with the arrows, and the tab stop with it', () => {
    render(<Harness actions={twoActions([])} />);
    fireEvent.keyDown(menuButton(), { key: 'ArrowDown' });

    const [first, second] = items();
    expect(document.activeElement).toBe(first);
    // Roving tabIndex: exactly one item is in the tab order, and it is the one
    // holding the focus. Proof: `tabIndex` hard-coded to 0 on every item, this
    // failed on `expected '0' to be '-1'` for the second item. Watched, 2026-08-08.
    expect(first.getAttribute('tabindex')).toBe('0');
    expect(second.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect(first.getAttribute('tabindex')).toBe('-1');
    expect(second.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  itDom('wraps at either end rather than stopping', () => {
    render(<Harness actions={twoActions([])} />);
    fireEvent.keyDown(menuButton(), { key: 'ArrowDown' });
    const [first, second] = items();

    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
  });

  itDom('takes the focused item on Enter and on Space, and closes', () => {
    for (const key of ['Enter', ' ']) {
      const taken: string[] = [];
      render(<Harness actions={twoActions(taken)} />);
      fireEvent.keyDown(menuButton(), { key: 'ArrowDown' });
      fireEvent.keyDown(items()[0], { key: 'ArrowDown' });

      fireEvent.keyDown(items()[1], { key });

      expect(taken).toEqual(['delete']);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(menuButton());
      cleanup();
    }
  });

  itDom('takes the key away from a modified Enter or Space, and takes nothing', () => {
    // Half of a guard is worse than none. Returning early left the key
    // unprevented, and a `<button>` fires a click of its own from Enter and
    // from Space unless the keydown was prevented — so the browser took the
    // item the guard had just refused. jsdom performs no default action, so
    // what it can say is that the key was consumed, and
    // `e2e/keyboard.spec.ts` says what a browser then does with it.
    // Proof: `event.preventDefault()` moved back below the modifier guard,
    // this failed on `expected true to be false` for Ctrl+Enter — the key
    // handed to the browser to act on. Watched, 2026-08-09.
    for (const key of ['Enter', ' ']) {
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
        const taken: string[] = [];
        render(<Harness actions={twoActions(taken)} />);
        fireEvent.keyDown(menuButton(), { key: 'ArrowDown' });

        const event = createEvent.keyDown(items()[0], { key, [modifier]: true });
        fireEvent(items()[0], event);

        expect(event.defaultPrevented, `${key} with ${modifier}`).toBe(true);
        expect(taken, `${key} with ${modifier}`).toEqual([]);
        // And the menu is still open under the hand reading it.
        expect(items(), `${key} with ${modifier}`).toHaveLength(2);
        cleanup();
      }
    }
  });

  itDom('opens on a bare Enter, Space or ↓ and on no modified one', () => {
    // The same rule on the button that opens it, where the leak is direct
    // rather than a default click: this handler recognized the three keys and
    // opened on them without looking at the modifiers at all, so every chord
    // aimed at the plan opened a menu over the row it was aimed at.
    // Proof: the modifier guard removed, this failed on `expected 'true' to be
    // 'false'` for Ctrl+Enter — a menu opened by a keystroke nobody aimed at
    // it. Watched, 2026-08-09.
    for (const key of ['Enter', ' ', 'ArrowDown']) {
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
        render(<Harness actions={twoActions([])} />);
        const button = menuButton();
        button.focus();

        const event = createEvent.keyDown(button, { key, [modifier]: true });
        fireEvent(button, event);

        expect(button.getAttribute('aria-expanded'), `${key} with ${modifier}`).toBe('false');
        expect(screen.queryByRole('menu'), `${key} with ${modifier}`).toBeNull();
        // Consumed all the same: a chord this button refuses must not reach
        // the browser either, for the reason the table preventDefaults the
        // ones it claims.
        expect(event.defaultPrevented, `${key} with ${modifier}`).toBe(true);
        cleanup();
      }

      render(<Harness actions={twoActions([])} />);
      fireEvent.keyDown(menuButton(), { key });
      expect(menuButton().getAttribute('aria-expanded'), key).toBe('true');
      cleanup();
    }
  });

  itDom('takes an item that is clicked', () => {
    const taken: string[] = [];
    render(<Harness actions={twoActions(taken)} />);
    fireEvent.click(menuButton());

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    expect(taken).toEqual(['duplicate']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  itDom('closes on Escape, taking nothing and giving the focus back', () => {
    const taken: string[] = [];
    render(<Harness actions={twoActions(taken)} />);
    fireEvent.keyDown(menuButton(), { key: 'Enter' });

    fireEvent.keyDown(items()[0], { key: 'Escape' });

    expect(taken).toEqual([]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menuButton());
  });

  itDom('closes on Tab and leaves the key to the browser', () => {
    const taken: string[] = [];
    render(<Harness actions={twoActions(taken)} />);
    fireEvent.keyDown(menuButton(), { key: 'Enter' });

    // `fireEvent` returns false when a handler called `preventDefault`. This
    // key must be left alone: the menu is not a focus trap, and the browser's
    // own Tab is what carries the focus on from the button. Where it lands is
    // a default action jsdom never performs — `e2e/layout.spec.ts` measures
    // that half.
    expect(fireEvent.keyDown(items()[0], { key: 'Tab' })).toBe(true);

    expect(taken).toEqual([]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  itDom('closes when a press lands outside it', () => {
    render(<Harness actions={twoActions([])} />);
    fireEvent.click(menuButton());
    expect(screen.getByRole('menu')).toBeDefined();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Somewhere else' }));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  itDom('stays open when the press is inside it', () => {
    render(<Harness actions={twoActions([])} />);
    fireEvent.click(menuButton());

    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Duplicate' }));

    expect(screen.getByRole('menu')).toBeDefined();
  });

  itDom('shows its items as unavailable while a request is in flight, and refuses them', () => {
    const taken: string[] = [];
    render(<Harness actions={twoActions(taken)} busy />);
    fireEvent.keyDown(menuButton(), { key: 'ArrowDown' });

    // Still focusable, which is why this is `aria-disabled` and not the
    // attribute: a `disabled` button cannot hold the focus, so a menu that went
    // busy while it was open would drop the focus on the floor.
    expect(document.activeElement).toBe(items()[0]);
    expect(items()[0].getAttribute('aria-disabled')).toBe('true');

    fireEvent.keyDown(items()[0], { key: 'Enter' });
    fireEvent.click(items()[1]);

    // Proof: the `busy` guard removed from `takeAction`, this failed on
    // `Unable to find an accessible element with the role "menuitem"` — the
    // Enter above took the action and closed the menu, so the click had nothing
    // left to press. Watched, 2026-08-08.
    expect(taken).toEqual([]);
    // And the items are still there to be read, rather than a menu that
    // changed shape under the hand using it.
    expect(items()).toHaveLength(2);
  });

  itDom('refuses to open with nothing to focus', () => {
    // The wiring that collects the item elements is what would break silently:
    // `aria-expanded="true"` on a button that still has the focus, and a menu
    // the keyboard cannot reach. Unknown is not OK — it throws.
    // Proof: the throw replaced by a bare `return`, this failed on `expected
    // [Function] to throw an error`. And with the throw kept and the item `ref`
    // callbacks deleted — the wiring fault it is really for — ten of the twelve
    // tests here failed, every one that opens the menu. Watched, 2026-08-08.
    expect(() =>
      render(
        <ActionsMenu
          number="020"
          actions={[]}
          busy={false}
          open
          onOpen={() => undefined}
          onClose={() => undefined}
        />,
      ),
    ).toThrow(/no item/);
  });

  itDom('keeps its focus on the last item when one leaves the open menu', () => {
    // The fault this exists for is not hypothetical: the schedule cue offers a
    // `Retry` that a variant's own state carries, so a plan read landing while
    // the menu is open takes an item away under the reader's hand. The item
    // array is written by index and never truncated, so the unmounting item's
    // own ref callback leaves `null` behind at index 2.
    //
    // Proof: `focusAt`'s `Math.min` replaced by `active`, this failed on
    // `expect(element).toHaveFocus()` with `Received element with focus:
    // <body>` — the effect that focuses is keyed on the index, so an unchanged
    // `active` never re-runs it and the focus goes with the unmounted item. Not
    // a throw: `.at(2)` is only reached again on the next opening, and opening
    // resets the index to 0. Watched 2026-09-08.
    const three: MenuAction[] = [
      { id: 'a', label: 'Duplicate', run: () => undefined },
      { id: 'b', label: 'Unfreeze', run: () => undefined },
      { id: 'c', label: 'Delete', run: () => undefined },
    ];
    const { rerender } = render(
      <ActionsMenu
        number="020"
        actions={three}
        busy={false}
        open
        onOpen={() => undefined}
        onClose={() => undefined}
      />,
    );
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Duplicate' }), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    expect(() => {
      rerender(
        <ActionsMenu
          number="020"
          actions={three.slice(0, 2)}
          busy={false}
          open
          onOpen={() => undefined}
          onClose={() => undefined}
        />,
      );
    }).not.toThrow();
    expect(screen.getByRole('menuitem', { name: 'Unfreeze' })).toHaveFocus();
  });

  itDom('grows the ⋯ button to a 44px tap target only when asked to', () => {
    const { rerender } = render(
      <ActionsMenu
        number="020"
        actions={[]}
        busy={false}
        open={false}
        onOpen={() => undefined}
        onClose={() => undefined}
      />,
    );
    const button = () => screen.getByRole('button', { name: 'Actions for 020' });
    expect(button().style.minHeight).toBe('');

    rerender(
      <ActionsMenu
        number="020"
        actions={[]}
        busy={false}
        open={false}
        onOpen={() => undefined}
        onClose={() => undefined}
        touchSized
      />,
    );
    expect(button().style.minHeight).toBe('44px');
    expect(button().style.minWidth).toBe('44px');
  });
});
