import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DARK_CLASS, THEME_KEY, useTheme } from '@/lib/theme';

import { AccountMenu, type AccountMenuProps } from './account-menu';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * The account menu's accessible shape.
 *
 * It exists in the form R5 keeps asking for. The pair this replaces — a
 * paragraph reading "Signed in as kat" and a "Log out" button beside it — had
 * **no assertion anywhere in the repository**: nothing named either of them,
 * so a change could have deleted the way out of the app and every test would
 * have stayed green. `F shadcn-foundation` learned that lesson on the auth
 * panel's heading and wrote the rule down: where a swap finds no assertion on a
 * role or a name, the swap writes one.
 *
 * Watched failures for every test here are quoted in
 * `openspec/changes/header-fits-a-row/verify.md`.
 */
describe('the account menu', () => {
  const nothing = () => {
    // Most tests here never take the item; the callback is required.
  };

  /**
   * The palette props, for the tests that are not about the palette.
   *
   * Spread rather than defaulted in the component: the theme is `app.tsx`'s to
   * hold — one answer for the whole document, above the branch that decides
   * whether anybody is signed in — and a default here would let a caller mount
   * a menu whose control says `System` while the page is dark.
   */
  const palette = { theme: 'system' as const, onChooseTheme: nothing };

  itDom('names its trigger with the account it belongs to', () => {
    render(<AccountMenu username="kat" onSignOut={nothing} {...palette} />);

    const trigger = screen.getByRole('button', { name: 'kat' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  itDom('opens a menu that says who is signed in', () => {
    render(<AccountMenu username="kat" onSignOut={nothing} {...palette} />);

    fireEvent.click(screen.getByRole('button', { name: 'kat' }));

    // The name carries the identity because the visible line is `role="none"`:
    // a `menu` with a paragraph in its children is not a menu to a reader.
    expect(screen.getByRole('menu', { name: 'Signed in as kat' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'kat' }).getAttribute('aria-expanded')).toBe('true');
  });

  itDom('moves the focus onto the item it opens', () => {
    render(<AccountMenu username="kat" onSignOut={nothing} {...palette} />);

    fireEvent.click(screen.getByRole('button', { name: 'kat' }));

    // The assertion that stands in for `ActionsMenu`'s throw: if the ref
    // wiring stops working, the menu opens with the focus still on the trigger
    // and the keyboard has nowhere to go.
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Log out' }));
  });

  itDom('opens on ArrowDown, which is the only key the trigger claims', () => {
    render(<AccountMenu username="kat" onSignOut={nothing} {...palette} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'kat' }), { key: 'ArrowDown' });

    expect(screen.getByRole('menu', { name: 'Signed in as kat' })).toBeDefined();
  });

  itDom('signs out when the item is taken, and closes', () => {
    const signOut = vi.fn();
    render(<AccountMenu username="kat" onSignOut={signOut} {...palette} />);

    fireEvent.click(screen.getByRole('button', { name: 'kat' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  itDom('closes on Escape and gives the focus back to the trigger', () => {
    render(<AccountMenu username="kat" onSignOut={nothing} {...palette} />);

    fireEvent.click(screen.getByRole('button', { name: 'kat' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Log out' }), { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'kat' }));
  });

  itDom('closes on a press anywhere else', () => {
    render(<AccountMenu username="kat" onSignOut={nothing} {...palette} />);

    fireEvent.click(screen.getByRole('button', { name: 'kat' }));
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  itDom('leaves a press on its own trigger to the toggle', () => {
    render(<AccountMenu username="kat" onSignOut={nothing} {...palette} />);

    fireEvent.click(screen.getByRole('button', { name: 'kat' }));
    // The press the outside-listener must not act on: it is inside the
    // wrapper, and the click that follows is what closes the menu. Without the
    // `contains` guard the listener closes it first and the click reopens it —
    // a toggle that never shuts.
    fireEvent.mouseDown(screen.getByRole('button', { name: 'kat' }));

    expect(screen.getByRole('menu', { name: 'Signed in as kat' })).toBeDefined();
  });
});

/**
 * The palette control the menu grew in `dark-mode`.
 *
 * Three answers rather than a switch, because "follow the machine" is an answer
 * of its own — `lib/theme.ts` has the reasoning, and `theme.test.ts` the
 * resolution. What is asserted here is only the menu: the roles a reader meets,
 * which item the menu opens onto now that there are four, and that the keyboard
 * reaches all of them.
 *
 * Watched failures are in `openspec/changes/dark-mode/verify.md`.
 */
describe('the palette, in the account menu', () => {
  const nothing = () => {
    // Most tests here never choose; the callback is required.
  };

  const open = (props: Partial<AccountMenuProps> = {}) => {
    render(
      <AccountMenu
        username="kat"
        onSignOut={nothing}
        theme="system"
        onChooseTheme={nothing}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'kat' }));
  };

  itDom('offers the three answers as one question', () => {
    open();

    // `menuitemradio` and not `menuitem`: one answer with three values. The
    // group is what names the question they answer.
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(
      within(group)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['System', 'Light', 'Dark']);
  });

  itDom('checks the one this browser is on, and only that one', () => {
    open({ theme: 'dark' });

    expect(screen.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'System' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  itDom('reports the answer that was taken', () => {
    const chosen = vi.fn();
    open({ onChooseTheme: chosen });

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    expect(chosen).toHaveBeenCalledWith('dark');
  });

  itDom('stays open when a palette is chosen, unlike the way out', () => {
    open();

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));

    // The page changing colour is the whole feedback this control has, and a
    // menu that closed on the same tick would take the comparison — and the
    // way back — off the screen with it.
    expect(screen.getByRole('menu', { name: 'Signed in as kat' })).toBeDefined();
  });

  itDom('still opens onto the way out, with three items above it', () => {
    open();

    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Log out' }));
  });

  itDom('walks every item with the arrows, and wraps', () => {
    open();
    const logOut = screen.getByRole('menuitem', { name: 'Log out' });

    fireEvent.keyDown(logOut, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Dark' }));

    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Dark' }), { key: 'ArrowDown' });
    // Past the last item and round to the first, which is `ActionsMenu`'s rule:
    // four items and a dead end at either one is a keyboard that stops working
    // before the menu does.
    expect(document.activeElement).toBe(logOut);
    fireEvent.keyDown(logOut, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'System' }));
  });

  itDom('answers the arrow that points along the row it drew', () => {
    open();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Log out' }), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Dark' }));

    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Dark' }), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Log out' }));
  });

  itDom('keeps the tab stop on the item that has the focus', () => {
    open();

    // Roving: the item with the focus is the one Tab would leave from, and the
    // rest are out of the tab order entirely.
    expect(screen.getByRole('menuitem', { name: 'Log out' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('tabindex')).toBe('-1');
  });

  itDom('closes on Escape from a palette item too', () => {
    open();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Log out' }), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Dark' }), { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'kat' }));
  });

  itDom('takes a modified Enter away, and leaves a bare one to the browser', () => {
    open();
    const dark = screen.getByRole('menuitemradio', { name: 'Dark' });

    // R5 #14, in this menu. jsdom performs no default action for a synthetic
    // key, so what it can see is the `preventDefault` and not the click that
    // would follow it — which is why the browser half of this is in
    // `e2e/dark-mode.spec.ts`. A guard that returned without preventing would
    // leave Chromium to fire the click it had just refused.
    expect(fireEvent.keyDown(dark, { key: 'Enter', ctrlKey: true })).toBe(false);
    // Bare: not prevented, so the browser's own click on a `<button>` is what
    // takes the item. Nothing here fakes that click.
    expect(fireEvent.keyDown(dark, { key: 'Enter' })).toBe(true);
  });
});
/**
 * The control wired to the hook that owns the answer, as `app.tsx` mounts it.
 *
 * `AccountMenu` takes the choice and the chooser as props; `useTheme` is where
 * the choice lives and where choosing writes it. Mounting the two together is
 * the only thing that closes the seam `wbs-theme-indicator-lies` found: a
 * control that paints the page dark while still reporting `System`, because its
 * checked state read a default rather than the stored answer. Every assertion
 * here is a watched red — pointing the hook's initialiser back at a hardcoded
 * default fails them (proved by reverting `useState(readTheme)` in `lib/theme.ts`).
 */
function ThemeHarness() {
  const { choice, chooseTheme } = useTheme();
  return (
    <AccountMenu
      username="kat"
      theme={choice}
      onChooseTheme={chooseTheme}
      onSignOut={() => {
        // The harness never signs out; the callback is required.
      }}
    />
  );
}

describe('the theme control, wired to the hook that owns it', () => {
  const answers = ['System', 'Light', 'Dark'] as const;

  beforeEach(() => {
    localStorage.removeItem(THEME_KEY);
    document.documentElement.classList.remove(DARK_CLASS);
  });

  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: 'kat' }));
  };

  const checkedOf = (name: (typeof answers)[number]): string =>
    screen.getByRole('menuitemradio', { name }).getAttribute('aria-checked') ?? '';

  itDom('reports the answer just chosen, for every answer, and only that one', () => {
    render(<ThemeHarness />);
    open();

    for (const answer of answers) {
      fireEvent.click(screen.getByRole('menuitemradio', { name: answer }));
      for (const offered of answers) {
        expect(checkedOf(offered), `${offered} while ${answer} was chosen`).toBe(
          offered === answer ? 'true' : 'false',
        );
      }
    }
  });

  itDom('reports the answer that was chosen, and only that one, after a reload', () => {
    for (const answer of answers) {
      const first = render(<ThemeHarness />);
      open();
      fireEvent.click(screen.getByRole('menuitemradio', { name: answer }));
      first.unmount();

      // A reload is a fresh mount: the menu must read the stored answer, not a
      // default, and report it.
      const second = render(<ThemeHarness />);
      open();
      for (const offered of answers) {
        expect(checkedOf(offered), `${offered} after ${answer} was chosen and reloaded`).toBe(
          offered === answer ? 'true' : 'false',
        );
      }
      second.unmount();
    }
  });
});
