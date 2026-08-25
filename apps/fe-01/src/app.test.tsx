import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Api from '@/lib/api';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const me = vi.hoisted(() => vi.fn<[], Promise<Api.SessionUser | null>>());

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  me,
}));

const { App } = await import('./app');

const muteConsoleError = () =>
  // React writes a caught error to `console.error` whatever a boundary does.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

let logged: ReturnType<typeof muteConsoleError>;

beforeEach(() => {
  me.mockResolvedValue(null);
  logged = muteConsoleError();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  logged.mockRestore();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('the app root', () => {
  itDom('shows the sign-in link when there is no browser session', async () => {
    render(<App />);

    // The boundary is transparent when nothing throws: the app it wraps is
    // what renders, and this is what says so.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'WBS tool v2' })).toBeDefined();
    });
    expect(document.querySelector('[data-app-fault]')).toBeNull();
  });

  itDom('offers sign-in when the session check fails', async () => {
    me.mockRejectedValue(new Error('network down'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeDefined();
    });
    expect(document.querySelector('[data-app-fault]')).toBeNull();
  });
});

/**
 * The gate, and the address it is asked for while it is shut.
 *
 * Both halves are here rather than in `app-router.test.tsx` because the claim
 * is about the **order** of the two: the router is mounted inside the branch
 * the gate already chose, so a signed-out visitor gets the form at every
 * address, and nothing rewrites the address on the way in.
 */
describe('a signed-in address asked for while signed out', () => {
  itDom('draws the sign-in form and no directory', async () => {
    window.history.replaceState({}, '', '/directory');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeDefined();
    });
    // The whole of the negative below: with the router hoisted above the gate,
    // this heading is on screen for somebody with no session at all.
    expect(screen.queryByRole('heading', { name: 'Directory' })).toBeNull();
    expect(window.location.pathname).toBe('/directory');
  });

  /**
   * Proof: the router hoisted above the gate — `app.tsx`'s
   * `if (session === null)` branch made unreachable so `<AppRouter>` is
   * mounted whether or not there is a session, the token passed as
   * `session?.token ?? ''` — and **both** tests in this block were watched
   * failing on `Unable to find role="button" and name "Log in"`, the directory
   * drawn to a visitor holding no session at all. Restored. Watched
   * 2026-08-09.
   */
  itDom('honours the address it was opened at, once the account is in', async () => {
    window.history.replaceState({}, '', '/directory');
    me.mockResolvedValue({ id: 'u1', username: 'kat' });
    // The directory page reads on arrival; it is the page under the address
    // rather than the subject here, so its two reads answer empty.
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const collection = path.split('/').at(-1) ?? 'unknown';
        return Promise.resolve(new Response(JSON.stringify({ [collection]: [] }), { status: 200 }));
      }),
    );

    render(<App />);

    // The page that was asked for, not the project — and the address it was
    // asked at, unrewritten.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Directory' })).toBeDefined();
    });
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
    expect(window.location.pathname).toBe('/directory');
  });
});

/**
 * The theme control, exercised through the whole app rather than the hook and
 * menu in isolation.
 *
 * The seam `wbs-theme-indicator-lies` found lives where `useTheme`'s choice is
 * carried into the account menu: as a React element baked through the router's
 * frozen match context, a `theme` prop holds the value it was built with until
 * the next navigation — so choosing `Dark` repaints the page while the control
 * keeps reporting `System`. A harness that mounts `AccountMenu` beside
 * `useTheme` never sees that, which is why this drives the real `App`. The
 * first case is the live half, the second the reload half; both were watched
 * failing before the theme moved into `ThemeProvider`/`useThemeChoice`.
 */
describe('the theme control through the app', () => {
  const signedIn = () => {
    me.mockResolvedValue({ id: 'u1', username: 'kat' });
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const collection = path.split('/').at(-1) ?? 'unknown';
        return Promise.resolve(new Response(JSON.stringify({ [collection]: [] }), { status: 200 }));
      }),
    );
  };

  const checkedOf = (name: string) =>
    screen.getByRole('menuitemradio', { name }).getAttribute('aria-checked');

  const open = () => fireEvent.click(screen.getByRole('button', { name: 'kat' }));

  itDom('reports the answer just chosen, and only that one, without a reload', async () => {
    signedIn();
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'kat' })).toBeDefined();
    });
    open();

    for (const answer of ['System', 'Light', 'Dark']) {
      fireEvent.click(screen.getByRole('menuitemradio', { name: answer }));
      for (const offered of ['System', 'Light', 'Dark']) {
        expect(checkedOf(offered), `${offered} while ${answer} was chosen`).toBe(
          offered === answer ? 'true' : 'false',
        );
      }
    }
  });

  itDom('reports the answer that was chosen, and only that one, after a reload', async () => {
    signedIn();
    for (const answer of ['System', 'Light', 'Dark']) {
      const first = render(<App />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'kat' })).toBeDefined();
      });
      open();
      fireEvent.click(screen.getByRole('menuitemradio', { name: answer }));
      first.unmount();

      // A reload is a fresh mount: the control reads the stored answer, not a default.
      const second = render(<App />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'kat' })).toBeDefined();
      });
      open();
      for (const offered of ['System', 'Light', 'Dark']) {
        expect(checkedOf(offered), `${offered} after ${answer} was chosen and reloaded`).toBe(
          offered === answer ? 'true' : 'false',
        );
      }
      second.unmount();
    }
  });
});
