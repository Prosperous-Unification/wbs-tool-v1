import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  RouterProvider,
} from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react';

import { PageNav } from '@/components/chrome/page-nav';
import type { Roster } from '@/components/presence/presence-panel';
import { ProjectPage } from '@/components/wbs/project-page';
import type { DirectoryApi, ProjectApi } from '@/lib/wbs-api';

/**
 * What the signed-in region is given by the gate above it.
 *
 * These are the session's, not any page's: the token every client is built
 * from, the presence slot that needs the account's own username, and the
 * account menu that signs out. They reach the pages as **router context**
 * rather than as props threaded through routes, because a route component
 * takes no props — anything else would be a closure captured at route-creation
 * time, which is a second place the session would live.
 */
export interface SignedInRegion {
  token: string;
  presence: (roster: Roster) => ReactNode;
  account: ReactNode;
  /**
   * Injected in tests. Production leaves them out and each page builds the real
   * client from `token`, exactly as `ProjectPage` already did.
   */
  projectApi?: ProjectApi;
  directoryApi?: DirectoryApi;
}

/** The region, plus the navigation both pages draw and neither owns. */
interface RouteContext extends SignedInRegion {
  nav: ReactNode;
}

const rootRoute = createRootRouteWithContext<RouteContext>()({ component: Outlet });

/**
 * The project, at `/`.
 *
 * The header is **this page's**, not the root's. `ProjectPage` holds the
 * picker's list, its selection and the rename in progress, and a bar drawn once
 * above both routes would have to reach back in here for all three. What the
 * two pages share — the account, the presence slot, the navigation — arrives
 * through the context instead.
 */
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: function ProjectRoute() {
    const { token, presence, account, nav, projectApi } = projectRoute.useRouteContext();
    return (
      <ProjectPage token={token} api={projectApi} presence={presence} account={account} nav={nav} />
    );
  },
});

/**
 * The directory page, fetched when somebody asks for it.
 *
 * **Its own chunk**, and it is the one route that can have one honestly: it is
 * a whole page — six vocabularies, their cards, their pickers — that a reader
 * who came to look at a plan never opens, and it was in the single 797 kB
 * bundle the sign-in form waits for. `app.tsx` blocks on `fetchMe()` before it
 * draws anything, so every byte in that bundle is a byte in front of the login
 * box.
 *
 * The plan's own big components — `GanttPanel`, `PlanCards` — are **not** split
 * here, and the reason is not bundle size: they are rendered inside `WbsTable`,
 * which 2,061 jsdom tests render synchronously and then assert on. A `lazy()`
 * boundary there turns every one of those assertions into a `waitFor`, which is
 * a decision about the shape of the whole suite rather than a chunk boundary,
 * and it belongs to a change that says so.
 */
const DirectoryPage = lazy(async () => ({
  default: (await import('@/components/directory/directory-page')).DirectoryPage,
}));

/** The directory, at `/directory`. No project controls: see {@link DirectoryPage}. */
const directoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/directory',
  component: function DirectoryRoute() {
    const { token, account, nav, directoryApi } = directoryRoute.useRouteContext();
    return (
      // Nothing rather than a spinner: the chunk is fetched from the same
      // origin that just served the document, and a flash of "loading…"
      // between two paints is worse than the paint arriving a frame later. The
      // page reads on arrival anyway, so its own empty states are what a reader
      // sees first.
      <Suspense fallback={null}>
        <DirectoryPage token={token} api={directoryApi} nav={nav} account={account} />
      </Suspense>
    );
  },
});

const routeTree = rootRoute.addChildren([projectRoute, directoryRoute]);

/**
 * The router for the signed-in region, built in code rather than generated.
 *
 * Two pages do not pay for a file-based generator and the watched artifact it
 * puts in the Vite build; ADR 0004 has the rest of that argument.
 *
 * `history` is a seam for tests, which enter at an address with
 * `createMemoryHistory`. Left out, the router takes the browser's own — which
 * is what makes a reload land on the page it was reloaded from.
 */
export function createAppRouter(context: RouteContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, history });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

/**
 * Mounts the router **below** the auth gate.
 *
 * Nothing routed is reachable without a session, because this component is only
 * rendered by the branch `app.tsx` already chose: the sign-in form is not an
 * address, there is no redirect to get wrong, and a signed-out `/directory` is
 * simply the form with the address left alone — so signing in continues to the
 * page that was asked for. That is the whole of ADR 0004's second half, and
 * `app.test.tsx`'s `honours the address it was opened at, once the account is
 * in` is watched failing with the router hoisted above the gate.
 *
 * The router instance is created once and its **context** is refreshed on every
 * render, because the account menu and the presence slot are elements the gate
 * rebuilds when the session changes. A router recreated with them would throw
 * the current address away on a re-render.
 */
export function AppRouter({
  history,
  ...region
}: SignedInRegion & { history?: RouterHistory }): React.JSX.Element {
  const { token, presence, account, projectApi, directoryApi } = region;
  const context = useMemo<RouteContext>(
    () => ({ token, presence, account, projectApi, directoryApi, nav: <PageNav /> }),
    [token, presence, account, projectApi, directoryApi],
  );
  const [router] = useState(() => createAppRouter(context, history));
  return <RouterProvider router={router} context={context} />;
}
