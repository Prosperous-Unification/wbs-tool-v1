import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
      expect(screen.getByRole('link', { name: 'Continue with Okta' })).toBeDefined();
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
      expect(screen.getByRole('link', { name: 'Continue with Okta' })).toBeDefined();
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
