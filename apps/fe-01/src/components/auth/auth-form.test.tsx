import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
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
  // Console spies are restored here, not at the end of each case that installs
  // one: a case that fails before its own `mockRestore()` would otherwise leave
  // `console.error` swallowed for every case after it, and the next reader
  // would be debugging silence.
  vi.restoreAllMocks();
  // The card reads its message out of the address, so a case that leaves one
  // behind would hand it to the next case. Restored here rather than per case.
  window.history.replaceState(null, '', '/');
});

/** Puts a refused SSO sign-in's code in the address, the way the callback does. */
const arriveWith = (query: string) => {
  window.history.replaceState(null, '', `/${query}`);
};

/**
 * Silences every console method and hands back the assertion that none was
 * called.
 *
 * All five, not the two a first draft reaches for: `log`, `info` and `debug`
 * are exactly where a "just checking what code we got" line survives review,
 * and a card that narrates a refused sign-in to the console has published the
 * code it went to the trouble of not rendering. An assertion over `error` and
 * `warn` alone would let all three through.
 */
const watchConsole = () => {
  const methods = ['error', 'warn', 'log', 'info', 'debug'] as const;
  const spies = methods.map((name) => [name, vi.spyOn(console, name)] as const);
  for (const [, spy] of spies) spy.mockImplementation(() => undefined);
  return {
    expectSilent: () => {
      for (const [name, spy] of spies) {
        expect(`console.${name} calls: ${String(spy.mock.calls.length)}`).toBe(
          `console.${name} calls: 0`,
        );
      }
    },
  };
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
    /*
     * The sentinel is the whole case. `?auth_error=provider_error` alone puts
     * no provider-supplied words in the address, so a regression that started
     * rendering `error_description` — or any other parameter the callback did
     * not write — would pass a case whose own name forbids it. This address
     * carries a provider-shaped string this app never writes, so the negative
     * has something to be negative about.
     */
    const providerText = 'AADSTS50105: the signed-in user is not assigned to a role';
    arriveWith(`?auth_error=provider_error&error_description=${encodeURIComponent(providerText)}`);
    const { container } = render(<AuthForm onSignedIn={() => undefined} />);

    expect(
      screen.getByText('SSO sign-in did not complete. Try again, or sign in with a password.'),
    ).toBeDefined();
    /*
     * `innerHTML`, not `textContent`: text nodes are only one of the surfaces a
     * leak could use. A regression that hung the provider's words on a `title`
     * or an `aria-label` while leaving the visible child alone would reach a
     * reader — a tooltip for one, a screen reader for the other — and a
     * `textContent` negative would stay green through it.
     *
     * Proof: with the lookup changed to return `error_description` from the
     * address, this case failed. Watched on h2puni 2026-09-07, negative
     * control 5, 1 fail / 18 pass.
     */
    expect(container.innerHTML).not.toContain(providerText);
    expect(container.innerHTML).not.toContain('AADSTS50105');
  });

  itDom('renders no SSO message for a code it does not publish', () => {
    // The backend collapses everything unrecognised into `provider_error`, so a
    // raw provider code can only reach the card if something forwarded it. The
    // card renders nothing for it, and says nothing about it in the console.
    const consoleWatch = watchConsole();
    arriveWith('?auth_error=okta_policy_evaluation_failure');
    render(<AuthForm onSignedIn={() => undefined} />);

    const slots = screen.getAllByRole('status');
    expect(slots).toHaveLength(1);
    expect(slots[0].className).toContain('min-h-5');
    consoleWatch.expectSilent();
  });

  /*
   * `ssoErrorMessage` looks its code up with `Object.hasOwn`, and the comment
   * above it says why: a bare lookup resolves `?auth_error=toString` through
   * `Object.prototype` and hands a reader who just failed to sign in a
   * function's source. Nothing proved that. The only unrecognised-code case
   * above uses `okta_policy_evaluation_failure`, which is not a prototype
   * property, so weakening the guard to `code in SSO_ERROR_MESSAGES` — or to a
   * truthiness check on the lookup — left the whole suite green.
   *
   * These three are the keys a link could actually hand the card, and each
   * fails differently once the guard goes: `toString` and `constructor` resolve
   * to functions, `__proto__` to `Object.prototype` itself.
   *
   * Proof, with `!Object.hasOwn(SSO_ERROR_MESSAGES, code)` weakened to
   * `!(code in SSO_ERROR_MESSAGES)` and nothing else changed: 3 fail / 16 pass.
   * `toString` and `constructor` both failed on `expected [ <p …(3)></p>,
   * <p …(3)></p> ] to have a length of 1 but got 2` — React 18 does not
   * stringify a function child, so what the leak produces is a second, EMPTY
   * status paragraph, not visible source text. `__proto__` failed on `Objects
   * are not valid as a React child (found: object with keys {})`. Watched on
   * h2puni 2026-09-07.
   */
  for (const code of ['toString', 'constructor', '__proto__']) {
    itDom(`renders no SSO message for the prototype property ${code}`, () => {
      const consoleWatch = watchConsole();
      arriveWith(`?auth_error=${code}`);
      const { container } = render(<AuthForm onSignedIn={() => undefined} />);

      // One slot, the password form's own reserved line — the SSO paragraph is
      // conditional, so a second `role="status"` means something rendered.
      const slots = screen.getAllByRole('status');
      expect(slots).toHaveLength(1);
      expect(slots[0].className).toContain('min-h-5');
      expect(slots[0].textContent).toBe('');
      /*
       * The two shapes a leaked prototype value can take as text. Neither is
       * what the measured red above actually produces under React 18 — the
       * status count catches it first — so these are kept as the criterion's
       * literal wording and as cover for a renderer that stringifies rather
       * than drops. A card-wide ban on the word `function` was here and is
       * deliberately gone: it was redundant against the count assertion and
       * would have false-redded the day a legitimate sentence used the word.
       */
      expect(container.textContent).not.toContain('[native code]');
      expect(container.textContent).not.toContain('[object Object]');
      consoleWatch.expectSilent();
    });
  }

  itDom('renders the card exactly as before when there is no auth_error', () => {
    render(<AuthForm onSignedIn={() => undefined} />);

    const slots = screen.getAllByRole('status');
    expect(slots).toHaveLength(1);
    expect(slots[0].className).toContain('min-h-5');
    expect(slots[0].textContent).toBe('');
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeDefined();
  });

  itDom('clears auth_error without taking history state, other parameters or the hash', () => {
    /*
     * `clearAuthError` passes `window.history.state` back and rebuilds the path
     * from the parsed URL, and its own comment says the alternative would be a
     * silent trap for whoever mounts this card under a router. The case that
     * checked the clearing started from null state, no other parameter and no
     * hash, so `replaceState(null, '', '/')` — which discards all three — passed
     * it. This one seeds each of the three, so the weakened form cannot.
     *
     * `StrictMode` because the effect that clears runs twice under it and the
     * initializer that reads runs before either: the message must survive the
     * second pass, and the second `clearAuthError` must find nothing to do.
     *
     * Proof, one weakening at a time, each watched on h2puni 2026-09-07 against
     * a 19-pass baseline. A failing assertion aborts the case, so one control
     * per preservation — otherwise only the first is really contradicted:
     *   - the whole clear reduced to `replaceState(null, '', '/')`:
     *     `expected '' to be '?tab=plan'` (1 fail / 18 pass)
     *   - state dropped, rebuilt URL kept: `expected null to deeply equal
     *     { from: '/plan/7', key: 'wjq3' }` (1 fail / 18 pass)
     *   - `${url.hash}` dropped: `expected '' to be '#risks'` (1 fail / 18 pass)
     */
    const routerState = { from: '/plan/7', key: 'wjq3' };
    window.history.replaceState(routerState, '', '/?tab=plan&auth_error=access_denied#risks');
    render(
      <StrictMode>
        <AuthForm onSignedIn={() => undefined} />
      </StrictMode>,
    );

    expect(
      screen.getByText(
        'SSO sign-in was refused. If you did not cancel it, your account may not have access to this app.',
      ),
    ).toBeDefined();
    expect(window.location.search).toBe('?tab=plan');
    expect(window.location.hash).toBe('#risks');
    expect(window.history.state).toEqual(routerState);
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
