import type { ReactNode } from 'react';

export interface AppHeaderProps {
  /**
   * The way between the two pages, and the mark on the one that is showing.
   *
   * On both pages and identical on both, which is why it comes from router
   * context rather than from either page.
   */
  nav?: ReactNode;
  /**
   * The project controls: the picker, with rename and new folded in beside it.
   *
   * A slot rather than a component of its own, because the picker is three
   * pieces of state deep in `ProjectPage` — the list, the selection, the
   * rename in progress — and hoisting them here to lay a row out would move
   * them further from the page that acts on them.
   *
   * Optional because the directory page has none: a control that belongs to a
   * project is **absent** off the project rather than drawn dead.
   */
  project?: ReactNode;
  /** Who else is in the project. Absent off the project, for the same reason. */
  presence?: ReactNode;
  account: ReactNode;
}

/**
 * The one bar the app's chrome fits in: brand, project, who else is here, and
 * the account.
 *
 * It replaces five stacked things — an `h1` with a margin, the "Signed in as …"
 * line, a "Projects" heading, the picker's own row and a "Working in …" line —
 * which together took about 190px off the top of every window. That number is
 * the whole reason this exists: what they cost was the table's, and
 * `e2e/header.spec.ts` measures what it got back.
 *
 * **Below 768px it wraps, and above it it may not.** `md:flex-nowrap` is the
 * half that matters: the fit matrix starts at 900 and the one-row claim is
 * made there, while a 390px phone cannot hold a brand, a picker, two buttons, a
 * presence roster and an account menu on one line at all — it held them on top
 * of each other, and the `+` that starts a project was under the picker's box
 * where nothing could click it. Found by a browser at 390×844, 2026-08-09;
 * `e2e/mobile.spec.ts` is where the page is asked whether it scrolls sideways.
 * The breakpoint is Tailwind's `md`, which is 768 — the same number
 * `plan-renderer.ts` swaps the renderer at, and deliberately the same one.
 *
 * **One row is a claim this bar has to keep at every width in the fit matrix**,
 * and the layout is what keeps it rather than a hope: the brand and the two
 * fold-in buttons are `shrink-0`, the picker takes the slack with a `max-w`,
 * and the roster inside {@link import('../presence/presence-panel').PresencePanel}
 * is clipped rather than allowed to grow with the number of people. Nothing
 * here wraps. `keeps the header to one row at every laptop width` is the
 * assertion; the toolbar underneath still wraps, deliberately, and that is the
 * other spec's.
 *
 * It is a `<header>` outside `<main>` so it is a `banner` landmark — which is
 * what a browser test can find the bar by, and what a screen reader gets to
 * skip. Inside `<main>` the same element is no landmark at all.
 */
export function AppHeader({ nav, project, presence, account }: AppHeaderProps): React.JSX.Element {
  return (
    <header className="border-border bg-background flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1 md:flex-nowrap">
      <h1 className="shrink-0 text-sm font-semibold tracking-tight">WBS tool v2</h1>
      {nav}
      {project}
      <div className="ml-auto flex min-w-0 items-center gap-3">
        {presence}
        {account}
      </div>
    </header>
  );
}
