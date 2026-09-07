import { type SubmitEvent, useEffect, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { login, type Session } from '@/lib/api';
import { failureMessage, unreachable } from '@/lib/http';

/** Every declared login refusal has user-facing words; transport failures are separate. */
function refusalMessage(
  refusal: Extract<Awaited<ReturnType<typeof login>>, { kind: 'refusal' }>['body'],
): string {
  switch (refusal.error) {
    case 'invalid_credentials':
      return 'Username or password is incorrect.';
    case 'not_found':
      return 'Password sign-in is not available on this server. Continue with SSO.';
    case 'invalid_origin':
      return 'This sign-in request was refused. Reload this page and try again.';
    case 'invalid_client':
    case 'invalid_body':
    case 'invalid_json':
    case 'invalid_query':
      return 'Password sign-in could not start. Reload and try again.';
    default:
      return unreachable(refusal);
  }
}

export interface AuthFormProps {
  onSignedIn: (session: Session) => void;
}

/** The query parameter the OIDC callback sends a refused sign-in back with. */
const AUTH_ERROR_PARAM = 'auth_error';

/**
 * What the card says about a refused SSO sign-in, in this app's own words.
 *
 * The keys are the public `auth_error` values emitted by the callback in
 * `apps/be-01/src/controller/auth-oidc-endpoints.ts`. That boundary collapses
 * every unpublished provider code to `provider_error`, and nothing else reaches
 * a reader: the provider's own
 * `error_description` is deliberately never sent, so this app chooses the words
 * on its own origin and there is no string here it did not write.
 *
 * `access_denied` does not say "you cancelled". An authorization server sends it
 * both when a person cancels and when a policy refuses them, and the two are
 * indistinguishable from here — so the message names the refusal and then offers
 * the second reading, which is the case where the reader most needs the hint.
 *
 * Only `temporarily_unavailable` and `provider_error` mention the password form,
 * because they are the only two a password can actually route around. Telling a
 * reader to give up on `consent_required` would be advice to abandon a step they
 * can finish in one click.
 */
const SSO_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  access_denied:
    'SSO sign-in was refused. If you did not cancel it, your account may not have access to this app.',
  account_selection_required:
    'SSO needs you to choose an account. Try again and pick the one you use here.',
  consent_required:
    'SSO needs your permission before this app can sign you in. Try again and accept the request.',
  interaction_required:
    'SSO needs a step it could not complete on its own. Try again and follow the prompts.',
  login_required: 'SSO needs you to sign in again. Try again to continue.',
  temporarily_unavailable:
    'SSO is temporarily unavailable. Try again in a few minutes, or sign in with a password.',
  provider_error: 'SSO sign-in did not complete. Try again, or sign in with a password.',
});

/**
 * The message for the code in the address, or '' for an absent or unpublished one.
 *
 * `Object.hasOwn` rather than a bare lookup: `?auth_error=toString` would
 * otherwise resolve through the prototype and render a function's source.
 */
function ssoErrorMessage(): string {
  if (typeof window === 'undefined') return '';
  const code = new URLSearchParams(window.location.search).get(AUTH_ERROR_PARAM);
  if (code === null || !Object.hasOwn(SSO_ERROR_MESSAGES, code)) return '';
  return SSO_ERROR_MESSAGES[code];
}

/**
 * Drops the parameter once it has been read, so a reload does not repeat the
 * message at a reader who has since signed in some other way.
 *
 * The current history state is passed back rather than `null`: this card renders
 * outside the router today, but discarding whatever state is there would be a
 * silent trap for whoever mounts it under one.
 */
function clearAuthError(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(AUTH_ERROR_PARAM)) return;
  url.searchParams.delete(AUTH_ERROR_PARAM);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Offers the local password session beside the server-side Authorization Code flow. */
export function AuthForm({ onSignedIn }: AuthFormProps) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordShown, setPasswordShown] = useState(false);
  /*
   * Read in an initializer and cleared in an effect, so the two halves cannot
   * fight: the read never mutates, and the effect never writes state, which is
   * what keeps StrictMode's second invocation a no-op instead of a message that
   * erases itself.
   */
  const [ssoError] = useState(ssoErrorMessage);

  useEffect(() => {
    clearAuthError();
  }, []);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const username = values.get('username');
    const password = values.get('password');
    setBusy(true);
    setError('');
    try {
      const reply = await login(
        typeof username === 'string' ? username : '',
        typeof password === 'string' ? password : '',
      );
      switch (reply.kind) {
        case 'success':
          onSignedIn(reply.body);
          break;
        case 'refusal':
          setError(refusalMessage(reply.body));
          break;
        case 'failure':
          setError(failureMessage(reply.failure));
          break;
        default:
          unreachable(reply);
      }
    } catch {
      setError('Password sign-in could not start. Reload and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Label>
            Username
            <Input className="h-11" name="username" autoComplete="username" required />
          </Label>
          {/*
           * The reveal sits outside the `Label` on purpose: `Label` documents
           * that every caller nests its control, and a `<button>` nested in a
           * `<label>` would take the caption's own clicks as well as its own.
           */}
          <div className="relative grid gap-1.5">
            <Label>
              Password
              <Input
                className="h-11 pr-16"
                name="password"
                type={passwordShown ? 'text' : 'password'}
                autoComplete="current-password"
                required
              />
            </Label>
            {/*
             * `type="button"` is load-bearing, not decoration: a bare `<button>`
             * inside a `<form>` submits it, so revealing the password would post
             * the half-typed credentials as a sign-in attempt.
             *
             * Proof: with this line deleted, `does not sign in when the password
             * is merely revealed` failed on `expected "spy" to not be called at
             * all, but actually been called 1 times`. Watched 2026-09-02.
             */}
            {/*
             * Styled through `buttonVariants` rather than by hand, because this
             * app's reset leaves `<button>` its platform box on purpose (see
             * `buttonVariants`' own note): a bare one here drew the grey chrome
             * box and the browser's focus outline over the field's right edge.
             * `ghost` brings `border-0 bg-transparent` and the ring the rest of
             * the chrome focuses with.
             */}
            <button
              className={buttonVariants({
                variant: 'ghost',
                className:
                  'text-muted-foreground hover:text-foreground absolute right-1 bottom-1 h-9 px-2.5 font-normal',
              })}
              type="button"
              aria-pressed={passwordShown}
              onClick={() => {
                setPasswordShown((shown) => !shown);
              }}
            >
              {passwordShown ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-destructive min-h-5 text-sm" role="status" aria-live="polite">
            {error}
          </p>
          <Button className="h-11 w-full" type="submit" disabled={busy}>
            Sign in with password
          </Button>
        </form>
        <div className="grid gap-3">
          <div className="text-muted-foreground text-center text-sm">or</div>
          {/*
           * Conditional, not height-reserved. The password slot above carries
           * `min-h-5` so its form does not jump as an error comes and goes; this
           * one is shown once on arrival and never changes, so reserving a line
           * for it would leave a permanently empty message slot under the SSO
           * button on every ordinary visit.
           */}
          {ssoError === '' ? null : (
            <p className="text-destructive text-sm" role="status" aria-live="polite">
              {ssoError}
            </p>
          )}
          <a
            className={buttonVariants({ variant: 'outline', className: 'h-11 w-full' })}
            href="/api/auth/login"
          >
            Continue with SSO
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
