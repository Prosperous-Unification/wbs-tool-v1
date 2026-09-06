import { useState } from 'react';

import type {
  ProjectOptimizationPatch,
  ScheduleEngineView,
  ScheduleObjectiveView,
} from '@/lib/wbs-api';

export interface OptimizationSettingsValue {
  readonly enabled: boolean;
  readonly engine: ScheduleEngineView;
  readonly objective: ScheduleObjectiveView;
}

export interface OptimizationSettingsProps {
  readonly value: OptimizationSettingsValue;
  readonly setSettings: (patch: ProjectOptimizationPatch) => Promise<void>;
  readonly onChanged: () => Promise<void>;
  readonly onDirtyChange: (dirty: boolean) => void;
}

/** Project-owned optimizer controls. Every checked value comes from the latest plan read. */
export function OptimizationSettingsPanel({
  value,
  setSettings,
  onChanged,
  onDirtyChange,
}: OptimizationSettingsProps) {
  const [writing, setWriting] = useState(false);

  async function write(patch: ProjectOptimizationPatch): Promise<void> {
    setWriting(true);
    onDirtyChange(true);
    try {
      await setSettings(patch);
      await onChanged();
    } finally {
      setWriting(false);
      onDirtyChange(false);
    }
  }

  const selected = value.enabled ? (value.engine === 'fast' ? 'fast' : value.objective) : 'fast';

  return (
    <div aria-busy={writing} className="space-y-4">
      <div>
        <h3 className="font-medium">Schedule optimization</h3>
        <p className="text-muted-foreground text-sm">
          Compute and share priority-first and finish-first schedules for this project.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={writing}
          onChange={(event) => {
            void write({ optimizationEnabled: event.currentTarget.checked });
          }}
        />
        Optimize schedules
      </label>

      <fieldset className="space-y-2" disabled={!value.enabled || writing}>
        <legend className="text-sm font-medium">Active schedule</legend>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="schedule-variant"
              value="fast"
              checked={selected === 'fast'}
              onChange={() => {
                void write({ scheduleEngine: 'fast' });
              }}
            />
            Fast
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="schedule-variant"
              value="pri"
              checked={selected === 'pri'}
              onChange={() => {
                void write({ scheduleEngine: 'optimized', scheduleObjective: 'pri' });
              }}
            />
            PRI
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="schedule-variant"
              value="time"
              checked={selected === 'time'}
              onChange={() => {
                void write({ scheduleEngine: 'optimized', scheduleObjective: 'time' });
              }}
            />
            Time
          </label>
        </div>
      </fieldset>

      {!value.enabled && (
        <p className="text-muted-foreground text-sm">Fast is active while optimization is off.</p>
      )}
    </div>
  );
}
