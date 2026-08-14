import { DEFAULT_PRIORITY_BANDS, type PriorityBand } from '@wbs/domain';

import type { PriorityBandStore, PriorityBandsWritten, ProjectStore } from '../repository';
import type { Broadcaster } from '../service/broadcast';
import { PriorityBandService } from '../service/priority-band.service';
import { recordingBroadcaster } from './broadcast-fixture';
import { inMemoryProjects } from './project-fixture';

/**
 * A {@link PriorityBandStore} backed by a Map, for service and controller tests
 * that do not need SQLite.
 *
 * It keeps the two guarantees the real store has, because a fixture laxer than
 * production lets a test pass against behaviour that does not exist: a project
 * holding nothing reads as {@link DEFAULT_PRIORITY_BANDS} rather than as an empty
 * list, and a `replace` **replaces** rather than merging.
 *
 * What it deliberately does not keep is the existence check on the project id.
 * `PriorityBandRepository.replace` reads it inside its own transaction and
 * answers `not_found`; this Map holds no projects, so a fixture answering
 * anything about an unknown id would be answering a question it cannot know —
 * `inMemoryCapacity`'s own shape. That refusal is asserted against real SQLite in
 * `repository/priority-band.test.ts`.
 */
export function inMemoryPriorityBands(
  /** What the store starts holding, as `projectId -> its five bands`. */
  seed: Readonly<Record<string, readonly PriorityBand[]>> = {},
): PriorityBandStore {
  const held = new Map<string, PriorityBand[]>();
  for (const [projectId, bands] of Object.entries(seed)) {
    held.set(
      projectId,
      bands.map((band) => ({ ...band })),
    );
  }
  return {
    listFor(projectId) {
      const own = held.get(projectId);
      // A copy either way: a caller that mutated what it was handed would be
      // editing the store from the read side, and mutating the exported default
      // would edit every project at once.
      return Promise.resolve((own ?? DEFAULT_PRIORITY_BANDS).map((band) => ({ ...band })));
    },
    replace(projectId, bands) {
      held.set(
        projectId,
        bands.map((band) => ({ ...band, label: band.label.trim() })),
      );
      const written: PriorityBandsWritten = { ok: true };
      return Promise.resolve(written);
    },
  };
}

/**
 * A PriorityBandService over the in-memory stores, for tests that only need
 * `buildApp` to construct.
 *
 * Required rather than optional in `AppOptions` for the reason every other
 * service there is: a process built without it answers 404 on the ladder route,
 * and a Priorities dialog whose Save silently does nothing reads as a plan whose
 * configuration does not matter.
 */
export function testPriorityBandService(
  projects: ProjectStore = inMemoryProjects(),
  bands: PriorityBandStore = inMemoryPriorityBands(),
  broadcast: Broadcaster = recordingBroadcaster(),
): PriorityBandService {
  return new PriorityBandService({ projects, bands, broadcast });
}
