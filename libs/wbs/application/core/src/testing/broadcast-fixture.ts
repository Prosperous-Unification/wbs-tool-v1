import type { Broadcaster, ProjectEvent } from '../service/broadcast';

export interface RecordingBroadcaster extends Broadcaster {
  readonly published: { projectId: string; event: ProjectEvent }[];
}

/** Collects what would have gone to gw-01, so a test can assert the payload shape. */
export function recordingBroadcaster(): RecordingBroadcaster {
  const published: { projectId: string; event: ProjectEvent }[] = [];
  return {
    published,
    publish(projectId, event) {
      published.push({ projectId, event });
      return Promise.resolve();
    },
    latestSeq(projectId) {
      // One sequence per project, counting from zero, so this mirrors what the
      // real sequencer would have assigned rather than a shared counter.
      const forProject = published.filter((entry) => entry.projectId === projectId);
      return Promise.resolve(forProject.length - 1);
    },
  };
}
