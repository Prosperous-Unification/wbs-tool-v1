import { useEffect, useState } from 'react';

import { AppRouter } from '@/app-router';
import { AuthForm } from '@/components/auth/auth-form';
import { AccountMenu } from '@/components/chrome/account-menu';
import { AppFaultBoundary } from '@/components/chrome/app-fault';
import { PresencePanel } from '@/components/presence/presence-panel';
import { me as fetchMe, type Session } from '@/lib/api';
import { ThemeProvider, useThemeChoice } from '@/lib/theme';

/**
 * The document's whole app, inside the boundary that catches what it throws.
 *
 * The split is what makes the boundary outermost: everything with state, an
 * effect or a child is in {@link AppContent}, and this component has none of
 * the three, so there is nothing above the boundary left to throw. Wrapping
 * only the signed-in branch would have left the session check — the effect that
 * runs before anything is on screen — outside it.
 *
 * See {@link AppFaultBoundary} for why the fallback offers a reload and not a
 * retry.
 */
export function App() {
  return (
    <AppFaultBoundary>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </AppFaultBoundary>
  );
}

/**
 * The account menu, wired to the live theme rather than to a prop.
 *
 * `account` is a React element passed through the router's frozen match
 * context, so a `theme` prop baked into it would keep the value it was built
 * with until the next navigation — choosing Dark would repaint the page while
 * the control kept reporting `System`. The theme is read back through
 * {@link useThemeChoice} instead, so the control follows the stored choice
 * live and after a reload. `username` and `onSignOut` are safe as props: they
 * change only at sign-in and sign-out, which remounts this element.
 */
function ThemedAccountMenu({
  username,
  onSignOut,
}: {
  username: string;
  onSignOut: () => void;
}): React.JSX.Element {
  const { choice, chooseTheme } = useThemeChoice();
  return (
    <AccountMenu
      username={username}
      theme={choice}
      onChooseTheme={chooseTheme}
      onSignOut={onSignOut}
    />
  );
}

function AppContent() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);

  // A token in localStorage is a claim, not a session. It is checked against
  // /api/auth/me before the app renders as signed in, so an expired or
  // revoked token shows the login form instead of a UI that fails on every
  // request.
  useEffect(() => {
    // `.catch` is not optional here: a rejected fetch — the site gate refusing
    // the request, a dropped connection — would otherwise leave `checked` false
    // forever and the app stuck on "Loading…", with no way to reach the form
    // that could fix it. A failed check means "not signed in", never "wait".
    void fetchMe()
      .then((user) => {
        if (user !== null) setSession({ token: '', user });
      })
      .catch(() => undefined)
      .finally(() => {
        setChecked(true);
      });
  }, []);

  if (!checked)
    return (
      <main className="bg-background text-muted-foreground min-h-full p-8 font-sans">Loading…</main>
    );

  if (session === null)
    return (
      // The page's own type and colour, which used to be `fontFamily:
      // 'sans-serif'` inline — the browser's generic sans, whatever that was on
      // the machine. `font-sans` is the named stack `styles.css` declares, and
      // the two colour tokens are what a dark set would re-point.
      <main className="bg-background text-foreground min-h-full p-8 font-sans">
        {/*
         * The tracer for the Tailwind integration, and still the assertion
         * `e2e/tailwind.spec.ts` reads the computed letter-spacing off. The
         * explicit size and weight beside it are not decoration: the scoped
         * reset in `styles.css` takes an `h1`'s user-agent font-size and weight
         * away, the way every reset does, so a heading now says how big it is.
         *
         * The signed-out page keeps its own layout: it is a form on an empty
         * page, it fits any window, and giving it the signed-in page's
         * viewport-height flex would buy nothing and cost a second thing to
         * keep in step.
         */}
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">WBS tool v2</h1>
        <AuthForm onSignedIn={setSession} />
      </main>
    );

  return (
    /*
     * The signed-in page is exactly one window tall, and that is what makes the
     * table's frame the thing that scrolls: `h-full` fixes the outer height —
     * against `#root`, `body` and `html`, which `styles.css` gives the window's
     * height and which is `100vh` done in a way CSS `zoom` cannot lie about —
     * the header takes what it needs, and the frame takes the rest. A `min-h-`
     * of anything would grow with the table instead: the frame would be as tall
     * as its own content, nothing would ever scroll inside it, and the sticky
     * heading row would ride up the page. See `table-frame.ts`.
     *
     * Nothing here hides the overflow. A window too short for the frame's own
     * minimum leaves the page scrolling vertically, which is the honest fallback:
     * clipping it would put rows below the fold with no way to reach them.
     */
    <div className="bg-background text-foreground flex h-full flex-col font-sans">
      {/*
       * The router is mounted **here**, inside the branch the gate already
       * chose, and never around it. That is what makes a signed-out
       * `/directory` the sign-in form with the address left alone rather than a
       * redirect to a `/sign-in` nobody asks for by name, and it is why signing
       * in continues to the page that was asked for: nothing rewrote it.
       * ADR 0004 has the alternatives.
       */}
      <AppRouter
        token={session.token}
        presence={
          // A roster is a project's, so the panel is built from the page's
          // selection rather than handed down finished — gw-01 scopes the
          // roster by the project the socket subscribes to (F4, and
          // {@link PresencePanel}).
          (projectId) => <PresencePanel me={session.user.username} projectId={projectId} />
        }
        account={
          <ThemedAccountMenu
            username={session.user.username}
            onSignOut={() => {
              setSession(null);
            }}
          />
        }
      />
    </div>
  );
}
