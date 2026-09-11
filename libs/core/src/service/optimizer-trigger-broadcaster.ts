import type { Broadcaster, ProjectEvent } from './broadcast';

export type OptimizationInputChanged = (projectId: string) => void;

function changesScheduleInput(event: ProjectEvent): boolean {
  return (
    event.type === 'tree_replaced' ||
    event.type === 'step_added' ||
    event.type === 'step_removed' ||
    event.type === 'directory_changed' ||
    event.type === 'capacity_changed' ||
    event.type === 'project_settings_changed'
  );
}

/**
 * Starts the optimizer's edit debounce only after the corresponding project
 * event has been durably published. Name-only events may reach this boundary;
 * the canonical input hash suppresses them without spending another child.
 */
export class OptimizerTriggerBroadcaster implements Broadcaster {
  constructor(
    private readonly inner: Broadcaster,
    private readonly inputChanged: OptimizationInputChanged,
  ) {}

  async publish(projectId: string, event: ProjectEvent): Promise<void> {
    await this.inner.publish(projectId, event);
    if (changesScheduleInput(event)) this.inputChanged(projectId);
  }

  latestSeq(projectId: string): Promise<number> {
    return this.inner.latestSeq(projectId);
  }
}
