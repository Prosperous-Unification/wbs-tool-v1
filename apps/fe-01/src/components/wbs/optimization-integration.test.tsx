import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlanOptimizationView } from '@/lib/wbs-api';
import { DEV, fakeProjectApi } from '@/testing/fake-project-api';

import { readScopeFor, type SubscriptionHandlers, WbsTable } from './wbs-table';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

const READY: PlanOptimizationView = {
  enabled: true,
  engine: 'optimized',
  objective: 'pri',
  inputHash: 'same-input',
  generation: 1,
  contractVersion: '1.5+test',
  budgetMs: 60_000,
  displayed: 'pri',
  variants: { pri: { state: 'ready' }, time: { state: 'idle' } },
  comparison: { deltaDays: -2, sameOrder: true },
};

async function openOptimization(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Project settings' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Optimization' }));
}

describe('project optimization in the plan', () => {
  /**
   * Proof: replacing the latest plan-read value with one captured in local
   * component state made this case and the collaborator-event case fail. The
   * persisted API state alone could no longer move the checked controls.
   * Watched on h2puni, 2026-09-06.
   */
  itDom('persists a project-wide schedule choice across a remount', async () => {
    const api = fakeProjectApi();
    const setSettings = vi.spyOn(api, 'setOptimizationSettings');
    const first = render(<WbsTable projectId="p1" api={api} />);
    await openOptimization();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Optimize schedules' }));
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Optimize schedules' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Time' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Time' }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Time' })).toBeChecked();
    });

    expect(setSettings.mock.calls).toEqual([
      ['p1', { optimizationEnabled: true }],
      ['p1', { scheduleEngine: 'optimized', scheduleObjective: 'time' }],
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Optimizing…');

    first.unmount();
    render(<WbsTable projectId="p1" api={api} />);
    await openOptimization();
    expect(screen.getByRole('checkbox', { name: 'Optimize schedules' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Time' })).toBeChecked();
  });

  itDom('rereads another collaborator’s project settings event', async () => {
    const api = fakeProjectApi();
    let notify: SubscriptionHandlers['onChange'] = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await openOptimization();
    expect(screen.getByRole('checkbox', { name: 'Optimize schedules' })).not.toBeChecked();

    await api.setOptimizationSettings('p1', {
      optimizationEnabled: true,
      scheduleEngine: 'optimized',
      scheduleObjective: 'time',
    });
    act(() => {
      notify('project_settings_changed');
    });

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Optimize schedules' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Time' })).toBeChecked();
    });
  });

  itDom('removes a ready comparison when a later plan read fails', async () => {
    const api = fakeProjectApi();
    const readTree = api.tree.bind(api);
    let refuseRead = false;
    api.tree = async (projectId) => {
      if (refuseRead) throw new Error('offline');
      return { ...(await readTree(projectId)), optimization: READY };
    };
    let notify: SubscriptionHandlers['onChange'] = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Earlier project deadline by 2 days',
    );

    refuseRead = true;
    act(() => {
      notify('project_settings_changed');
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveAttribute('data-stale-tree');
      expect(screen.getByRole('status')).toHaveTextContent(
        'Schedule comparison unavailable while this plan may be stale',
      );
    });
    expect(screen.queryByText(/project deadline by/)).toBeNull();
  });

  /**
   * 9.3, and the half `optimization-indicator.test.tsx` cannot reach: that
   * suite renders the banner alone, so "Fast is still on screen and usable"
   * is trivially true there — there is nothing else on screen to lose. The
   * claim is about the table, so it is asserted against the table.
   */
  itDom(
    'leaves the Fast plan on screen and usable, and offers no Retry, when infeasible',
    async () => {
      const api = fakeProjectApi();
      const row = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Launch' });
      // A day zero **and** a cost, so Fast has something to place: a project
      // with no start date has no coordinate system, and the chart filters
      // every unestimated slice out at rest, so without both the assertion
      // below would pass against an empty chart.
      await api.setStartDate('p1', '2026-09-07');
      await api.setEstimate(row.id, DEV.id, { optimistic: 2, realistic: 3, pessimistic: 8 });
      const patch = vi.spyOn(api, 'patchWorkItem');
      const readTree = api.tree.bind(api);
      api.tree = async (projectId) => ({
        ...(await readTree(projectId)),
        optimization: {
          ...READY,
          displayed: 'fast',
          comparison: undefined,
          variants: {
            ...READY.variants,
            pri: {
              state: 'plan-infeasible',
              items: [
                { ownerWorkItemId: row.id, boundWorkItemId: row.id, effectiveDeadlineOffset: 2 },
              ],
            },
          },
        } satisfies PlanOptimizationView,
      });
      render(<WbsTable projectId="p1" api={api} />);

      expect(await screen.findByText('Plan infeasible · 1 Work item deadline')).toBeInTheDocument();

      // **On screen** is the Fast schedule itself, not merely the row list: an
      // infeasible optimized plan is a statement about the optimized variant,
      // and the Fast plan it is measured against is still the one being drawn.
      // The chart is behind its own control, so opening it is part of the
      // claim — an affordance that stopped working would fail here too. The
      // assertion is a drawn **bar**, not the panel: `aria-label="Gantt chart"`
      // sits on the section unconditionally, and the "nothing can be drawn"
      // branch carries it too, so finding the region proves a shell. A bar is
      // a Fast placement.
      fireEvent.click(await screen.findByRole('button', { name: 'Gantt' }));
      await screen.findByLabelText('Gantt chart');
      await waitFor(() => {
        expect(document.querySelectorAll('[data-gantt-bar]').length).toBeGreaterThan(0);
      });

      // **Usable** has to cross the edit boundary. `CellInput` is uncontrolled
      // (`defaultValue`), so reading the node's own value back after a `change`
      // asserts jsdom, not the table — the write starts on blur and lands in
      // `api.patchWorkItem`. Spy on it and wait for the reread.
      const name = await screen.findByLabelText('Name of 010');
      expect(name).toHaveValue('Launch');
      expect(name).toBeEnabled();
      name.focus();
      fireEvent.change(name, { target: { value: 'Launch v2' } });
      fireEvent.blur(name);
      await waitFor(() => {
        expect(patch).toHaveBeenCalledWith(row.id, { name: 'Launch v2' });
      });
      // The fake's own row, not the input's value: the cell is uncontrolled, so
      // it holds `Launch v2` because `fireEvent.change` put it there whether or
      // not anything was written. This is the model behind the API answering
      // that the write landed.
      await waitFor(() => {
        expect(api.rows.find((each) => each.id === row.id)?.name).toBe('Launch v2');
      });

      // No toast and no modal, and no Retry — the whole document, because the
      // point of the item is that the affordance is absent from the screen, not
      // merely from one component's own markup.
      //
      // `[data-toast]` and not `queryByRole('alert')`: `ToastStack` gives the
      // alert role to error toasts **only**, deliberately, so an info toast is
      // a toast that an alert query cannot see. The alert query stays as well,
      // because it is doing separate double duty — it is also the stale-tree
      // banner, so its absence says these rows are the current ones rather than
      // a copy the reader was warned about.
      expect(document.querySelectorAll('[data-toast]')).toHaveLength(0);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
      expect(screen.queryByText(/Optimization unavailable/)).toBeNull();
    },
  );

  /**
   * TASK-313 AC #1's live half, and the reason it is asserted through the
   * socket rather than through a second render.
   *
   * A cold page load renders `plan-infeasible` correctly and always did — that
   * is what the case above proves. The half that was missing is a client
   * **already on screen**: the indicator is event-driven, so before
   * `schedule_optimization_infeasible` existed a stored certificate announced
   * nothing and that client sat on `Optimizing…` until something unrelated
   * forced a refetch. Nothing on its own side could ever move it, because this
   * state never auto-respawns and offers no Retry.
   *
   * `notify` is the only thing that happens between the two assertions. No
   * remount, no user action, no timer.
   *
   * **What this case cannot say, so that nobody reads it as saying it** (Sol
   * peer review, 2026-09-07): it would pass for any event string, because
   * `readScopeFor` sends every unrecognised one down the same full read. It is
   * not a check on the *name* — that is `be-01`'s
   * `optimization-events.db.test.ts:280`, which asserts the literal
   * `schedule_optimization_infeasible` on the pushed event. What this case is,
   * and what nothing else covered, is the client's half of the same contract:
   * that an event arriving for a variant on `Optimizing…` is enough to move
   * that indicator to the certificate's words. "Without a refetch" in the
   * acceptance criterion means without something *else* forcing one — the read
   * this event triggers is the mechanism, not a violation of it.
   */
  itDom('leaves Optimizing… on the infeasible event alone', async () => {
    const api = fakeProjectApi();
    const row = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Launch' });
    let infeasible = false;
    const readTree = api.tree.bind(api);
    api.tree = async (projectId) => ({
      ...(await readTree(projectId)),
      optimization: {
        ...READY,
        displayed: 'fast',
        comparison: undefined,
        variants: {
          ...READY.variants,
          pri: infeasible
            ? {
                state: 'plan-infeasible',
                items: [
                  { ownerWorkItemId: row.id, boundWorkItemId: row.id, effectiveDeadlineOffset: 2 },
                ],
              }
            : { state: 'pending' },
        },
      } satisfies PlanOptimizationView,
    });
    let notify: SubscriptionHandlers['onChange'] = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Optimizing…');

    // The solve finished and stored its certificate; the event is the only
    // notice this client gets of it.
    infeasible = true;
    act(() => {
      notify('schedule_optimization_infeasible');
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Plan infeasible · 1 Work item deadline',
      );
    });
    expect(screen.queryByText('Optimizing…')).toBeNull();
    // Still not a failure, on the path that used to be the only way here: an
    // event that flipped the variant to `failed` would offer the Retry this
    // state exists to withhold.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  /**
   * The three optimizer events named on this side, and what each of them reads.
   *
   * `readScopeFor` answers `'all'` for anything it does not recognise, so all
   * three already pass through the default and none of them is exercising a
   * branch. **They are not a check on the name, and the first draft's comment
   * claiming they were is the thing Sol's review corrected** — a be-01 rename
   * leaves every one of them green, because the renamed string takes the same
   * default. The name is pinned in be-01, at
   * `optimization-events.db.test.ts:280`.
   *
   * What they do catch is the change that would strand the client: a narrowing
   * branch added here for an optimizer event. `'tree'` and `'tree-and-steps'`
   * are claims about be-01's tree and step events; an optimizer outcome is
   * neither, and it moves a variant's stored state, which only the plan read
   * carries. Narrow one of these and the case above stops passing for a real
   * reason rather than a fixture one.
   */
  describe('the read scope each optimizer event asks for', () => {
    for (const event of [
      'schedule_optimized',
      'schedule_optimization_failed',
      'schedule_optimization_infeasible',
    ]) {
      it(`reads everything for ${event}`, () => {
        expect(readScopeFor(event)).toBe('all');
      });
    }

    it('keeps the narrow scopes the tree and step events earned', () => {
      expect(readScopeFor('tree_replaced')).toBe('tree');
      expect(readScopeFor('step_added')).toBe('tree-and-steps');
      expect(readScopeFor('step_renamed')).toBe('tree-and-steps');
      expect(readScopeFor('step_removed')).toBe('tree-and-steps');
    });

    it('reads everything for a frame that said nothing and for an event this build has never heard of', () => {
      expect(readScopeFor(null)).toBe('all');
      expect(readScopeFor(undefined)).toBe('all');
      expect(readScopeFor('schedule_optimization_invented_next_year')).toBe('all');
    });
  });
});
