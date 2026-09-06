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
  // The card reads its message out of the address, so a case that leaves one
  // behind would hand it to the next case. Restored here rather than per case.
  window.history.replaceState(null, '', '/');
});

/** Puts a refused SSO sign-in's code in the address, the way the callback does. */
const arriveWith = (query: string) => {
  window.history.replaceState(null, '', `/${query}`);
};

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

  itDom('reveals and re-hides the password it was given, keeping what was typed', () => {
    render(<AuthForm onSignedIn={() => undefined} />);
    const password = screen.getByLabelText<HTMLInputElement>('Password');
    fireEvent.change(password, { target: { value: 'lovelace99' } });
    expect(password.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(password.type).toBe('text');
    expect(password.value).toBe('lovelace99');

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(password.type).toBe('password');
    expect(password.value).toBe('lovelace99');
  });

  itDom('does not sign in when the password is merely revealed', () => {
    const fetched = vi.fn(() => Promise.resolve(response(200, {})));
    vi.stubGlobal('fetch', fetched);
    render(<AuthForm onSignedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'lovel' } });

    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    expect(fetched).not.toHaveBeenCalled();
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

/**
 * The OIDC callback answers a refused or failed SSO login with
 * `302 /?auth_error=<code>` and nothing else — the provider's own
 * `error_description` is deliberately never forwarded. So every sentence below
 * is one this app wrote, and each is asserted whole: a message reworded in
 * `auth-form.tsx` has to fail here rather than quietly change what a person is
 * told about being refused.
 */
describe('a refused SSO sign-in', () => {
  itDom('names the refusal for access_denied without saying the reader cancelled', () => {
    arriveWith('?auth_error=access_denied');
    const { container } = render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText(
        'SSO sign-in was refused. If you did not cancel it, your account may not have access to this app.',
      ),
    ).toBeDefined();
    // `access_denied` is also what a policy refusal looks like from here, and
    // accusing a reader of cancelling would be a lie in exactly the case where
    // they most need the other reading. This assertion is that decision.
    expect(container.textContent).not.toMatch(/you cancelled/i);
  });

  itDom('names the account choice SSO still needs', () => {
    arriveWith('?auth_error=account_selection_required');
    render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText(
        'SSO needs you to choose an account. Try again and pick the one you use here.',
      ),
    ).toBeDefined();
  });

  itDom('names the permission SSO still needs', () => {
    arriveWith('?auth_error=consent_required');
    render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText(
        'SSO needs your permission before this app can sign you in. Try again and accept the request.',
      ),
    ).toBeDefined();
  });

  itDom('names the step SSO could not complete on its own', () => {
    arriveWith('?auth_error=interaction_required');
    render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText(
        'SSO needs a step it could not complete on its own. Try again and follow the prompts.',
      ),
    ).toBeDefined();
  });

  itDom('names the sign-in SSO asks for again', () => {
    arriveWith('?auth_error=login_required');
    render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText('SSO needs you to sign in again. Try again to continue.'),
    ).toBeDefined();
  });

  itDom('offers the password form while SSO is temporarily unavailable', () => {
    arriveWith('?auth_error=temporarily_unavailable');
    render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText(
        'SSO is temporarily unavailable. Try again in a few minutes, or sign in with a password.',
      ),
    ).toBeDefined();
  });

  itDom('names an unpublished provider failure without repeating it', () => {
    arriveWith('?auth_error=provider_error');
    render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText('SSO sign-in did not complete. Try again, or sign in with a password.'),
    ).toBeDefined();
  });

  itDom('renders no SSO message for a code it does not publish', () => {
    // The backend collapses everything unrecognised into `provider_error`, so a
    // raw provider code can only reach the card if something forwarded it. The
    // card renders nothing for it, and says nothing about it in the console.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    arriveWith('?auth_error=okta_policy_evaluation_failure');
    render(<AuthForm onSignedIn={() => undefined} />);

    const slots = screen.getAllByRole('status');
    expect(slots).toHaveLength(1);
    expect(slots[0].className).toContain('min-h-5');
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  itDom('renders the card exactly as before when there is no auth_error', () => {
    render(<AuthForm onSignedIn={() => undefined} />);

    const slots = screen.getAllByRole('status');
    expect(slots).toHaveLength(1);
    expect(slots[0].className).toContain('min-h-5');
    expect(slots[0].textContent).toBe('');
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeDefined();
  });

  itDom('does not re-accuse the reader after a reload', () => {
    const refused =
      'SSO sign-in was refused. If you did not cancel it, your account may not have access to this app.';
    arriveWith('?auth_error=access_denied');
    render(<AuthForm onSignedIn={() => undefined} />);

    expect(screen.getByText(refused)).toBeDefined();
    expect(window.location.search).not.toContain('auth_error');

    cleanup();
    render(<AuthForm onSignedIn={() => undefined} />);
    expect(screen.queryByText(refused)).toBeNull();
  });
});
