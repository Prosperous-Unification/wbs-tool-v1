import { describe, expect, it } from 'bun:test';

import type { AppOptions } from './app';
import { buildApp, mountedRouteLists } from './app';
import type { Route } from './http/route';
import { PlanCommandRunner } from './service/plan-commands';
import { inMemoryUsers, testAuthService } from './testing/auth-fixture';
import { testCapacityService } from './testing/capacity-fixture';
import { testDirectoryService } from './testing/directory-fixture';
import { testHistoryService } from './testing/history-fixture';
import { testPriorityBandService } from './testing/priority-band-fixture';
import { testProjectService } from './testing/project-fixture';
import { testReplay } from './testing/replay-fixture';
import { testSavedPlanService } from './testing/saved-plan-fixture';
import { testStepService } from './testing/step-fixture';
import { testWorkItemService } from './testing/work-item-fixture';
import { testWrites } from './testing/writes-fixture';

/**
 * Properties of the mounted route list itself, rather than of any answer it
 * gives — which is why they are here and not in `http/binder.contract.test.ts`.
 * That suite may not import `controller/`; the whole claim of the refactor is
 * that `http/` names no controller and no framework.
 */

function options(): AppOptions {
  return {
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth: testAuthService(inMemoryUsers()),
    projects: testProjectService(),
    workItems: testWorkItemService(),
    savedPlans: testSavedPlanService(),
    steps: testStepService(),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    writes: testWrites(),
    migrationsApplied: true,
  };
}

function assembled(): readonly Route[] {
  const opts = options();
  return mountedRouteLists(
    opts,
    new PlanCommandRunner({
      workItems: opts.workItems,
      directory: opts.directory,
      capacity: opts.capacity,
      priorityBands: opts.priorityBands,
      transactions: opts.writes.transactions,
      lock: opts.writes.lock,
      announcements: opts.writes.announcements,
    }),
  ).flat();
}

describe('the mounted route list', () => {
  /**
   * The control `Route.preflight` exists under, and it asserts the **pairing**
   * rather than the requirement: a route needs one exactly when a
   * framework-derived validator could answer ahead of its handler guard, which
   * is what carrying a `documentation.query` means. Nothing else in Elysia's
   * per-route pipeline refuses before the handler for these routes, so this is
   * the complete set — and it is checkable without enumerating the app, which
   * is what a `(method, path, auth)` table would have needed.
   *
   * A guarded route with no query schema is left at today's ordering on
   * purpose. There is nothing in front of its handler to be ordered against,
   * and a preflight there would be a second auth mechanism bought for nothing.
   *
   * `preflight: undefined` cannot be told from a forgotten one, so the day an
   * **open** route carries a query schema this needs a named allowlist beside
   * it rather than a widened predicate. None exists today: both routes below
   * are guarded.
   */
  it('gives every route carrying a query schema a preflight', () => {
    const withQuery = assembled()
      .filter((route) => route.documentation?.query !== undefined)
      .map(
        (route) =>
          `${route.method} ${route.path} preflight=${String(route.preflight !== undefined)}`,
      )
      .sort();

    expect(withQuery).toEqual([
      'GET /api/projects/:id/history preflight=true',
      'GET /api/projects/:id/saved-plans/compare preflight=true',
    ]);
  });

  /**
   * What makes the clause above speak for the whole app rather than for
   * whatever `mountedRouteLists` happens to contain. A controller factory
   * dropped from that array would take its routes out of both the app and the
   * check together, and every clause would stay green.
   *
   * Elysia's own route table is the independent witness: it is built from what
   * was actually registered, including through `.use()`, so a route that
   * reaches the app by any path shows up here. Three do not come from a list,
   * and they are **named** rather than filtered by shape, because a filter is
   * one more thing that can quietly widen: `/health` is attached to the
   * instance directly, and `/metrics` and `/api/openapi.json` are mounted by
   * `observabilityPlugin` and `openApiPlugin`. Finding those two is what this
   * clause is for — no route list mentions them, so nothing else in the suite
   * would have said they exist.
   */
  it('covers every path the app actually mounts', () => {
    const mounted = (
      buildApp(options()) as unknown as { routes: readonly { method: string; path: string }[] }
    ).routes
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const declared = [
      ...assembled().map((route) => `${route.method} ${route.path}`),
      'GET /health',
      'GET /metrics',
      'GET /api/openapi.json',
    ].sort();

    expect(mounted).toEqual(declared);
  });
});
