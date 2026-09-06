import { type FormEvent, useState } from 'react';

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

/** Offers the local password session beside the server-side Authorization Code flow. */
export function AuthForm({ onSignedIn }: AuthFormProps) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordShown, setPasswordShown] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
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
