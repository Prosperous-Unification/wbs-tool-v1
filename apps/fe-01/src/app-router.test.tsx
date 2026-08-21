import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectApi } from '@/lib/wbs-api';

import { AppRouter } from './app-router';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * A `ProjectApi` with an empty deployment behind it.
 *
 * Only the four reads `ProjectPage` makes on arrival answer; everything else
 * rejects, because a route test that quietly succeeded at a write would be
 * asserting about the wrong page.
 */
function emptyProjects(): ProjectApi {
  const notHere = () => Promise.reject(new Error('not_in_these_tests'));
  return {
    listProjects: () => Promise.resolve([]),
    openProject: notHere,
    createProject: notHere,
    renameProject: notHere,
    tree: notHere,
    setEstimateMethod: notHere,
    setStartDate: notHere,
    listTeams: () => Promise.resolve([]),
    listTags: () => Promise.resolve([]),
    listServices: () => Promise.resolve([]),
    addTeam: notHere,
    listPeople: () => Promise.resolve([]),
    addPerson: notHere,
    assign: notHere,
    roles: () => Promise.resolve([]),
    addRole: notHere,
    renameRole: notHere,
    removeRole: notHere,
    create: notHere,
    patch: notHere,
    move: notHere,
    duplicate: notHere,
    remove: notHere,
    setEstimate: notHere,
    clearEstimate: notHere,
    freeze: notHere,
    unfreezeProject: notHere,
    unfreeze: notHere,
    addDependency: notHere,
    removeDependency: notHere,
    undo: notHere,
    redo: notHere,
  };
}

/** The signed-in region entered at one address, the way a reload enters it. */
const regionAt = (path: string) =>
  render(
    <AppRouter
      token="t"
      presence={() => null}
      account={<span>account menu</span>}
      projectApi={emptyProjects()}
      history={createMemoryHistory({ initialEntries: [path] })}
    />,
  );

const directoryShowing = () => screen.queryByRole('heading', { name: 'Directory' }) !== null;
const projectShowing = () => screen.queryByRole('combobox', { name: 'Project' }) !== null;

afterEach(() => {
  cleanup();
});

describe('the signed-in region, routed', () => {
  itDom('draws the project at /', async () => {
    regionAt('/');

    await waitFor(() => {
      expect(projectShowing()).toBe(true);
    });
    expect(directoryShowing()).toBe(false);
  });

  itDom('draws the directory at /directory', async () => {
    regionAt('/directory');

    await waitFor(() => {
      expect(directoryShowing()).toBe(true);
    });
    expect(projectShowing()).toBe(false);
  });

  /**
   * The reload, which is the whole reason the page has an address.
   *
   * A fresh region entered at `/directory` a second time — a new router, a new
   * history, nothing carried over — is exactly what a browser does on F5. A
   * page held in a state variable in `app.tsx` would draw the project here.
   */
  itDom('draws the directory again when it is re-entered at /directory', async () => {
    const first = regionAt('/directory');
    await waitFor(() => {
      expect(directoryShowing()).toBe(true);
    });
    first.unmount();

    regionAt('/directory');
    await waitFor(() => {
      expect(directoryShowing()).toBe(true);
    });
    expect(projectShowing()).toBe(false);
  });

  /**
   * The header contract task 1.1 pins, read off both routes.
   *
   * Each route renders its own `AppHeader`: the account and the navigation are
   * on both, and the project controls are on the project alone — absent off it
   * rather than drawn dead.
   */
  itDom(
    'gives each page its own header, with the project controls on the project alone',
    async () => {
      const project = regionAt('/');
      await waitFor(() => {
        expect(projectShowing()).toBe(true);
      });
      const projectBar = screen.getByRole('banner');
      expect(projectBar.textContent).toContain('account menu');
      expect(screen.getByRole('navigation', { name: 'Pages' })).toBeDefined();
      expect(screen.getByRole('link', { name: 'Directory' })).toBeDefined();
      project.unmount();

      regionAt('/directory');
      await waitFor(() => {
        expect(directoryShowing()).toBe(true);
      });
      const directoryBar = screen.getByRole('banner');
      expect(directoryBar.textContent).toContain('account menu');
      expect(screen.getByRole('navigation', { name: 'Pages' })).toBeDefined();
      expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    },
  );

  /**
   * The mark on the page that is showing, and the half that can be wrong.
   *
   * Both ends on both pages: a mark on the page that is showing says nothing
   * unless the other page is unmarked at the same moment.
   *
   * Proof: the directory's `Link` replaced by `<a href="/directory">` — the
   * shape somebody reaches for when a nav is "just two links" — and this failed
   * on `expected null to be 'page'` at `/directory`, the mark having come from
   * the router and nowhere else. Watched 2026-08-09. The
   * `activeOptions={{ exact: true }}` that was written first is **not** here:
   * removing it was watched changing nothing, because `/` and `/directory` are
   * siblings rather than parent and child.
   */
  itDom('marks only the page that is showing', async () => {
    const project = regionAt('/');
    await waitFor(() => {
      expect(projectShowing()).toBe(true);
    });
    expect(screen.getByRole('link', { name: 'Plan' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Directory' }).getAttribute('aria-current')).toBeNull();
    project.unmount();

    regionAt('/directory');
    await waitFor(() => {
      expect(directoryShowing()).toBe(true);
    });
    expect(screen.getByRole('link', { name: 'Directory' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Plan' }).getAttribute('aria-current')).toBeNull();
  });
});
