import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OptimizationSettingsPanel, type OptimizationSettingsProps } from './optimization-settings';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

const OFF = { enabled: false, engine: 'optimized', objective: 'time' } as const;
const ON = { enabled: true, engine: 'optimized', objective: 'time' } as const;

function mounted(value: OptimizationSettingsProps['value'] = OFF) {
  const setSettings = vi.fn(() => Promise.resolve());
  const onChanged = vi.fn(() => Promise.resolve());
  const onDirtyChange = vi.fn();
  const view = render(
    <OptimizationSettingsPanel
      value={value}
      setSettings={setSettings}
      onChanged={onChanged}
      onDirtyChange={onDirtyChange}
    />,
  );
  return { view, setSettings, onChanged, onDirtyChange };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resume) => setTimeout(resume, 0));
  });
}

describe('project optimization settings', () => {
  itDom('keeps Fast active while optimization is off without erasing the stored choice', () => {
    mounted();

    expect(screen.getByRole('checkbox', { name: 'Optimize schedules' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'PRI' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Time' })).toBeDisabled();
    expect(screen.getByText('Fast is active while optimization is off.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Active schedule' })).toHaveAccessibleDescription(
      'Fast is active while optimization is off.',
    );
  });

  itDom('writes the shared project flag, then rereads the plan', async () => {
    const { setSettings, onChanged, onDirtyChange } = mounted();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Optimize schedules' }));
    await settle();

    expect(setSettings).toHaveBeenCalledWith({ optimizationEnabled: true });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onDirtyChange).toHaveBeenCalledWith(true);
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false]);
  });

  itDom('keeps a refused project change on this surface', async () => {
    const setSettings = vi.fn(() => Promise.reject(new Error('forbidden')));
    render(
      <OptimizationSettingsPanel
        value={OFF}
        setSettings={setSettings}
        onChanged={() => Promise.resolve()}
        onDirtyChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Optimize schedules' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That optimization change did not land. Try again.',
    );
  });

  itDom.each([
    ['Fast', ON, { scheduleEngine: 'fast' }],
    ['PRI', ON, { scheduleEngine: 'optimized', scheduleObjective: 'pri' }],
    [
      'Time',
      { enabled: true, engine: 'optimized', objective: 'pri' },
      { scheduleEngine: 'optimized', scheduleObjective: 'time' },
    ],
  ] as const)('maps %s to the persisted engine and objective', async (label, before, patch) => {
    const { setSettings, onChanged } = mounted(before);

    fireEvent.click(screen.getByRole('radio', { name: label }));
    await settle();

    expect(setSettings).toHaveBeenCalledWith(patch);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  itDom('follows an incoming project read instead of keeping a local selector', () => {
    const { view } = mounted({ enabled: true, engine: 'fast', objective: 'pri' });
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeChecked();

    view.rerender(
      <OptimizationSettingsPanel
        value={ON}
        setSettings={() => Promise.resolve()}
        onChanged={() => Promise.resolve()}
        onDirtyChange={() => undefined}
      />,
    );

    // Proof: the selected schedule held in component state instead of read
    // from `value` leaves Fast checked here after the collaborator's reread.
    expect(screen.getByRole('radio', { name: 'Time' })).toBeChecked();
  });
});
