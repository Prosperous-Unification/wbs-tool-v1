import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Starts the server-side Authorization Code flow without exposing credentials. */
export function AuthForm() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
      </CardHeader>
      <CardContent>
        <a className={buttonVariants({ className: 'w-full' })} href="/api/auth/login">
          Continue with Okta
        </a>
      </CardContent>
    </Card>
  );
}
