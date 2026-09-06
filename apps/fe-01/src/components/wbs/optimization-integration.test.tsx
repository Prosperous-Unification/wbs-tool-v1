import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeProjectApi } from '@/testing/fake-project-api';

import { type SubscriptionHandlers, WbsTable } from './wbs-table';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

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
});
