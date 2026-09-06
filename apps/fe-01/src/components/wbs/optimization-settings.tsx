export interface OptimizationSettingsValue {
  readonly enabled: boolean;
  readonly engine: 'fast' | 'optimized';
  readonly objective: 'pri' | 'time';
}

export interface OptimizationSettingsPatch {
  readonly optimizationEnabled?: boolean;
  readonly scheduleEngine?: 'fast' | 'optimized';
  readonly scheduleObjective?: 'pri' | 'time';
}

export interface OptimizationSettingsProps {
  readonly value: OptimizationSettingsValue;
  readonly setSettings: (patch: OptimizationSettingsPatch) => Promise<void>;
  readonly onChanged: () => Promise<void>;
  readonly onDirtyChange: (dirty: boolean) => void;
}

export function OptimizationSettingsPanel(_props: OptimizationSettingsProps) {
  return <p>Not implemented</p>;
}
