import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlanOptimizationView } from '@/lib/wbs-api';
import { DEV, fakeProjectApi } from '@/testing/fake-project-api';

import { type SubscriptionHandlers, WbsTable } from './wbs-table';

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
});
