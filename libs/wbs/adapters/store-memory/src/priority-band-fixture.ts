import type { PriorityBandStore, PriorityBandsWritten } from '@wbs/core';
import { DEFAULT_PRIORITY_BANDS, type PriorityBand } from '@wbs/domain';

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
  table: MemoryPriorityBandTable = memoryPriorityBandTable(seed),
): PriorityBandStore {
  const { held } = table;
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */
  return {
    listFor(projectId) {
      const own = held.get(projectId);
      // A copy either way: a caller that mutated what it was handed would be
      // editing the store from the read side, and mutating the exported default
      // would edit every project at once.
      return Promise.resolve((own ?? DEFAULT_PRIORITY_BANDS).map((band) => ({ ...band })));
    },
    replace(projectId, bands, _stamp) {
      held.set(
        projectId,
        bands.map((band) => ({ ...band, label: band.label.trim() })),
      );
      const written: PriorityBandsWritten = { ok: true };
      return Promise.resolve(written);
    },
  };
}

export interface MemoryPriorityBandTable {
  readonly held: Map<string, PriorityBand[]>;
}
export function memoryPriorityBandTable(
  seed: Readonly<Record<string, readonly PriorityBand[]>> = {},
): MemoryPriorityBandTable {
  return {
    held: new Map(
      Object.entries(seed).map(([projectId, bands]) => [projectId, structuredClone([...bands])]),
    ),
  };
}
