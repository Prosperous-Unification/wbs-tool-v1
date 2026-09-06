import type { RefusalWords } from '@/lib/refusal';
import type {
  ProjectOptimizationPatch,
  ScheduleEngineView,
  ScheduleObjectiveView,
} from '@/lib/wbs-api';

import { SectionProblem, useSettingsSection } from './use-settings-section';

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

const OPTIMIZATION_REFUSALS: RefusalWords = {
  sentences: {},
  otherwise: () => 'That optimization change did not land. Try again.',
};

/** Project-owned optimizer controls. Every checked value comes from the latest plan read. */
export function OptimizationSettingsPanel({
  value,
  setSettings,
  onChanged,
  onDirtyChange,
}: OptimizationSettingsProps) {
  const section = useSettingsSection({
    words: OPTIMIZATION_REFUSALS,
    dirty: false,
    onDirtyChange,
    onChanged,
  });

  function write(patch: ProjectOptimizationPatch): void {
    void section.attempt(() => setSettings(patch));
  }

  const selected = value.enabled ? (value.engine === 'fast' ? 'fast' : value.objective) : 'fast';

  return (
    <div aria-busy={section.busy} className="space-y-4">
      <div>
        <h3 className="font-medium">Schedule optimization</h3>
        <p className="text-muted-foreground text-sm">
          Compute and share priority-first and finish-first schedules for this project.
        </p>
      </div>

      <SectionProblem problem={section.problem} />

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={section.busy}
          onChange={(event) => {
            write({ optimizationEnabled: event.currentTarget.checked });
          }}
        />
        Optimize schedules
      </label>

      <fieldset
        className="space-y-2"
        disabled={!value.enabled || section.busy}
        aria-describedby={!value.enabled ? 'optimization-disabled-reason' : undefined}
      >
        <legend className="text-sm font-medium">Active schedule</legend>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="schedule-variant"
              value="fast"
              checked={selected === 'fast'}
              onChange={() => {
                write({ scheduleEngine: 'fast' });
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
                write({ scheduleEngine: 'optimized', scheduleObjective: 'pri' });
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
                write({ scheduleEngine: 'optimized', scheduleObjective: 'time' });
              }}
            />
            Time
          </label>
        </div>
      </fieldset>

      {!value.enabled && (
        <p id="optimization-disabled-reason" className="text-muted-foreground text-sm">
          Fast is active while optimization is off.
        </p>
      )}
    </div>
  );
}
