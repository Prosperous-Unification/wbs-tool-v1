import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/api';

import { AuthForm } from './auth-form';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * The accessible shape of the signed-out screen, which is what the shadcn swap
 * had to keep and — in one place — did not.
 *
 * This file exists because of that miss. `F shadcn-foundation` moved the form
 * into a `Card`, and the registry's `CardTitle` is a `div`, so "Log in" stopped
 * being a heading and nothing said so: every test and both browser specs found
 * the *controls* by label, and no assertion anywhere in the repository asked
 * what the title was. The suite went green on a page whose outline had lost a
 * level. Two reviewers found it by reading.
 *
 * The lesson is the one R5 keeps teaching, in its other form: a contract with
 * no assertion behind it is not kept, it is merely un-contradicted.
 *
 * Proof: `CardTitle` put back to a `div`, `names itself with a heading` failed
 * on `Unable to find an accessible element with the role "heading" and name
 * "Log in"`. Watched 2026-08-09; quoted in
 * `openspec/changes/shadcn-foundation/verify.md`.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the signed-out screen', () => {
  itDom('offers password credentials beside the server-side SSO flow', () => {
    render(<AuthForm onSignedIn={() => undefined} />);

    const link = screen.getByRole('link', { name: 'Continue with SSO' });
    expect(link.getAttribute('href')).toBe('/api/auth/login');
    expect(screen.getByLabelText('Username').getAttribute('autocomplete')).toBe('username');
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByRole('button', { name: 'Sign in with password' })).toBeDefined();

    for (const control of [
      link,
      screen.getByLabelText('Username'),
      screen.getByLabelText('Password'),
    ]) {
      expect(control.className).toContain('h-11');
    }
  });

  itDom('enters the returned cookie session after a password sign-in', async () => {
    const session: Session = { token: '', user: { id: 'u1', username: 'ada' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, session))),
    );
    const onSignedIn = vi.fn();
    render(<AuthForm onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'lovelace99' } });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Sign in with password' }).closest('form')!,
    );

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledWith(session);
    });
  });

  itDom('keeps a failed password sign-in inline without removing its error slot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(401, { error: 'invalid_credentials' }))),
    );
    render(<AuthForm onSignedIn={() => undefined} />);

    const error = screen.getByRole('status');
    expect(error.className).toContain('min-h-5');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Sign in with password' }).closest('form')!,
    );

    await waitFor(() => {
      expect(error.textContent).toBe('Username or password is incorrect.');
    });
    expect(screen.getByLabelText<HTMLInputElement>('Username').value).toBe('ada');
  });
});
