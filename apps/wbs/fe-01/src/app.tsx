import { useEffect, useState } from 'react';

import { AppRouter } from '@/app-router';
import { AuthForm } from '@/components/auth/auth-form';
import { AccountMenu } from '@/components/chrome/account-menu';
import { AppFaultBoundary } from '@/components/chrome/app-fault';
import { PresencePanel } from '@/components/presence/presence-panel';
import { HintLayer } from '@/components/wbs/hint';
import { me as fetchMe, type Session } from '@/lib/api';
import { failureMessage, unreachable } from '@/lib/http';
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
  const [sessionError, setSessionError] = useState('');

  // Session refusal and unavailable verification are distinct rendered states.
  useEffect(() => {
    void fetchMe()
      .then((reply) => {
        switch (reply.kind) {
          case 'success':
            if (reply.body.user !== null) setSession({ token: '', user: reply.body.user });
            return;
          case 'failure':
            setSessionError(failureMessage(reply.failure));
            return;
          case 'refusal':
            switch (reply.body.error) {
              case 'invalid_token':
                return;
              case 'invalid_body':
              case 'invalid_query':
              case 'invalid_params':
                setSessionError('Could not check your session. Reload and try again.');
                return;
              default:
                return unreachable(reply.body);
            }
          default:
            return unreachable(reply);
        }
      })
      .catch(() => {
        setSessionError('Could not check your session. Reload and try again.');
      })
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
        {sessionError !== '' && <p role="alert">{sessionError}</p>}
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
       * Every hint in this app, in one card. Mounted here rather than per page
       * because it is driven by an attribute and not by a prop: any control
       * anywhere under this element that carries `data-hint` is hinted, and
       * there is exactly one card and one listener for all of them. See
       * {@link HintLayer} for why that is what makes it stale-proof.
       */}
      <HintLayer />
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
          // The panel is presentational and the roster is the page's, because
          // it arrives on the table's own socket — one connection per browser
          // since 2026-09-02. What the session contributes is the username the
          // panel marks as "you".
          // Proof: renaming the shared login response username to displayName produced
          // TS2339 here and at AccountMenu below in the actual FE app typecheck.
          (roster) => <PresencePanel me={session.user.username} {...roster} />
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
