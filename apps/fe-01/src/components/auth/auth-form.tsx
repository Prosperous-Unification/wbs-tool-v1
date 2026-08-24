import { type FormEvent, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { login, type Session } from '@/lib/api';

export interface AuthFormProps {
  onSignedIn: (session: Session) => void;
}

/** Offers the local password session beside the server-side Authorization Code flow. */
export function AuthForm({ onSignedIn }: AuthFormProps) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const username = values.get('username');
    const password = values.get('password');
    setBusy(true);
    setError('');
    try {
      const session = await login(
        typeof username === 'string' ? username : '',
        typeof password === 'string' ? password : '',
      );
      onSignedIn(session);
    } catch {
      setError('Username or password is incorrect.');
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
          <Label>
            Password
            <Input
              className="h-11"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Label>
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
