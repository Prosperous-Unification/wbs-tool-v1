import { JOURNAL_DEPTH, type JournalEntry, type NewJournalEntry, type PlanEvent } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import type { SeededPlan, SourceReaders } from '../source-declaration';
import { type OpenCase, storeCase } from './store-case';

function entry(id: string, projectId: string, userId: string, createdAt: number): NewJournalEntry {
  return {
    id,
    projectId,
    userId,
    kind: 'rename',
    payload: { label: `Rename ${id}`, forward: { type: 'rename', name: `After ${id}` } },
    inverse: { type: 'rename', name: `Before ${id}` },
    preconditions: { expected: { [id]: createdAt }, from: { [id]: createdAt - 1 } },
    createdAt,
  };
}

function event(id: string, projectId: string, userId: string, createdAt: number): PlanEvent {
  return {
    id: `event-${id}`,
    projectId,
    userId,
    kind: 'rename',
    label: `Rename ${id}`,
    workItemId: `${id}-work`,
    stepId: null,
    before: { type: 'rename', name: `Before ${id}` },
    after: { type: 'rename', name: `After ${id}` },
    createdAt,
  };
}

function stored(
  incoming: NewJournalEntry,
  seq: number,
  undone = false,
  preconditions: unknown = incoming.preconditions,
): JournalEntry {
  return { ...structuredClone(incoming), seq, undone, preconditions };
}

async function seedAtomicSentinels(
  port: { append(entry: NewJournalEntry, event: PlanEvent): Promise<void> },
  seed: SeededPlan,
) {
  const rows = [
    entry('atomic-sentinel-a', seed.projectIds[0], seed.ownerIds[0], 101),
    entry('atomic-sentinel-b', seed.projectIds[0], seed.ownerIds[1], 102),
    entry('atomic-other-project', seed.projectIds[1], seed.ownerIds[1], 103),
  ];
  for (const row of rows)
    await port.append(
      structuredClone(row),
      event(row.id, row.projectId, row.userId, row.createdAt),
    );
  return rows;
}

function expectedFlipTarget(
  seed: SeededPlan,
  undone: boolean,
  expectedRevision: number,
  fromRevision: number,
): JournalEntry {
  return {
    id: 'flip-target',
    projectId: seed.projectIds[0],
    userId: seed.ownerIds[0],
    seq: 1,
    kind: 'rename',
    payload: {
      label: 'Rename flip-target',
      forward: { type: 'rename', name: 'After flip-target' },
    },
    inverse: { type: 'rename', name: 'Before flip-target' },
    preconditions: {
      expected: { 'work-a-one': expectedRevision },
      from: { 'work-a-one': fromRevision },
    },
    undone,
    createdAt: 101,
  };
}

function expectedFlipPeer(seed: SeededPlan): JournalEntry {
  return {
    id: 'flip-peer',
    projectId: seed.projectIds[0],
    userId: seed.ownerIds[0],
    seq: 2,
    kind: 'rename',
    payload: { label: 'Rename flip-peer', forward: { type: 'rename', name: 'After flip-peer' } },
    inverse: { type: 'rename', name: 'Before flip-peer' },
    preconditions: { expected: { 'work-a-two': 12 }, from: { 'work-a-two': 11 } },
    undone: false,
    createdAt: 102,
  };
}

function expectedFlipOther(seed: SeededPlan): JournalEntry {
  return {
    id: 'flip-other-project',
    projectId: seed.projectIds[1],
    userId: seed.ownerIds[1],
    seq: 1,
    kind: 'rename',
    payload: {
      label: 'Rename flip-other-project',
      forward: { type: 'rename', name: 'After flip-other-project' },
    },
    inverse: { type: 'rename', name: 'Before flip-other-project' },
    preconditions: {
      expected: { 'flip-other-project': 103 },
      from: { 'flip-other-project': 102 },
    },
    undone: false,
    createdAt: 103,
  };
}

function expectedFlipHistory(seed: SeededPlan): [PlanEvent[], PlanEvent[]] {
  return [
    [
      {
        id: 'event-flip-peer',
        projectId: seed.projectIds[0],
        userId: seed.ownerIds[0],
        kind: 'rename',
        label: 'Rename flip-peer',
        workItemId: 'flip-peer-work',
        stepId: null,
        before: { type: 'rename', name: 'Before flip-peer' },
        after: { type: 'rename', name: 'After flip-peer' },
        createdAt: 102,
      },
      {
        id: 'event-flip-target',
        projectId: seed.projectIds[0],
        userId: seed.ownerIds[0],
        kind: 'rename',
        label: 'Rename flip-target',
        workItemId: 'flip-target-work',
        stepId: null,
        before: { type: 'rename', name: 'Before flip-target' },
        after: { type: 'rename', name: 'After flip-target' },
        createdAt: 101,
      },
    ],
    [
      {
        id: 'event-flip-other-project',
        projectId: seed.projectIds[1],
        userId: seed.ownerIds[1],
        kind: 'rename',
        label: 'Rename flip-other-project',
        workItemId: 'flip-other-project-work',
        stepId: null,
        before: { type: 'rename', name: 'Before flip-other-project' },
        after: { type: 'rename', name: 'After flip-other-project' },
        createdAt: 103,
      },
    ],
  ];
}

async function readFlipObservation(readers: SourceReaders, seed: SeededPlan) {
  return {
    entries: await Promise.all([
      readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[0]),
      readers.journal.entriesFor(seed.projectIds[1], seed.ownerIds[1]),
    ]),
    states: await Promise.all([
      readers.journal.stateOf(seed.projectIds[0], seed.ownerIds[0]),
      readers.journal.stateOf(seed.projectIds[1], seed.ownerIds[1]),
    ]),
    history: await Promise.all([
      readers.planEvents.listFor(seed.projectIds[0], {}),
      readers.planEvents.listFor(seed.projectIds[1], {}),
    ]),
  };
}

/** Shared append atomicity, account isolation, depth and history-retention cases. */
export function journalRegistrations(open: OpenCase<'journal'>): readonly CaseRegistration[] {
  return [
    storeCase(
      'journal',
      'journal.append:history-atomic',
      open,
      async ({ port, readers, seed, scenario }) => {
        const sentinels = await seedAtomicSentinels(port, seed);
        const beforeEntries = await Promise.all([
          readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[0]),
          readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[1]),
          readers.journal.entriesFor(seed.projectIds[1], seed.ownerIds[1]),
        ]);
        const beforeHistory = await Promise.all(
          seed.projectIds.map((projectId) => readers.planEvents.listFor(projectId, {})),
        );
        expect(beforeEntries).toEqual([
          [stored(sentinels[0], 1)],
          [stored(sentinels[1], 1)],
          [stored(sentinels[2], 1)],
        ]);
        expect(beforeHistory).toEqual([
          [
            event('atomic-sentinel-b', seed.projectIds[0], seed.ownerIds[1], 102),
            event('atomic-sentinel-a', seed.projectIds[0], seed.ownerIds[0], 101),
          ],
          [event('atomic-other-project', seed.projectIds[1], seed.ownerIds[1], 103)],
        ]);

        const target = entry('atomic-target', seed.projectIds[0], seed.ownerIds[0], 201);
        const history = event(target.id, target.projectId, target.userId, target.createdAt);
        await port.append(structuredClone(target), structuredClone(history));
        const settledEntries: [JournalEntry[], JournalEntry[], JournalEntry[]] = [
          [stored(sentinels[0], 1), stored(target, 2)],
          beforeEntries[1],
          beforeEntries[2],
        ];
        const settledHistory = [
          [
            history,
            event('atomic-sentinel-b', seed.projectIds[0], seed.ownerIds[1], 102),
            event('atomic-sentinel-a', seed.projectIds[0], seed.ownerIds[0], 101),
          ],
          beforeHistory[1],
        ];
        expect(
          await Promise.all([
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[0]),
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[1]),
            readers.journal.entriesFor(seed.projectIds[1], seed.ownerIds[1]),
          ]),
        ).toEqual(settledEntries);
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.planEvents.listFor(projectId, {})),
          ),
        ).toEqual(settledHistory);

        // Proof: removing the journal late control from either real source opener
        // failed its dedicated Task 5.1 run here with this exact scenario error.
        if (scenario.kind !== 'late-write' || scenario.point !== 'journal-history-insert')
          throw new Error('journal.append:history-atomic requires journal-history-insert scenario');
        const lateTarget = entry('atomic-late-target', seed.projectIds[0], seed.ownerIds[0], 202);
        const lateHistory = event(
          lateTarget.id,
          lateTarget.projectId,
          lateTarget.userId,
          lateTarget.createdAt,
        );
        scenario.arm();
        const rejected = port.append(structuredClone(lateTarget), structuredClone(lateHistory));
        expect(rejected).rejects.toThrow('journal-history-insert');
        await rejected.catch(() => undefined);
        expect(scenario.reached()).toBe(true);
        expect(
          await Promise.all([
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[0]),
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[1]),
            readers.journal.entriesFor(seed.projectIds[1], seed.ownerIds[1]),
          ]),
        ).toEqual(settledEntries);
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.planEvents.listFor(projectId, {})),
          ),
        ).toEqual(settledHistory);
      },
    ),
    storeCase(
      'journal',
      'journal.append:account-redo-depth',
      open,
      async ({ port, readers, seed }) => {
        const undoneA = entry('redo-a', seed.projectIds[0], seed.ownerIds[0], 101);
        const undoneB = entry('redo-b', seed.projectIds[0], seed.ownerIds[1], 102);
        const other = entry('redo-other-project', seed.projectIds[1], seed.ownerIds[1], 103);
        for (const row of [undoneA, undoneB, other]) {
          await port.append(
            structuredClone(row),
            event(row.id, row.projectId, row.userId, row.createdAt),
          );
          await port.flip(row.id, true, { expected: { [row.id]: 900 }, from: { [row.id]: 899 } });
        }
        const flippedA = stored(undoneA, 1, true, {
          expected: { 'redo-a': 900 },
          from: { 'redo-a': 899 },
        });
        const flippedB = stored(undoneB, 1, true, {
          expected: { 'redo-b': 900 },
          from: { 'redo-b': 899 },
        });
        const flippedOther = stored(other, 1, true, {
          expected: { 'redo-other-project': 900 },
          from: { 'redo-other-project': 899 },
        });
        expect(
          await Promise.all([
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[0]),
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[1]),
            readers.journal.entriesFor(seed.projectIds[1], seed.ownerIds[1]),
          ]),
        ).toEqual([[flippedA], [flippedB], [flippedOther]]);
        expect(
          await Promise.all([
            readers.journal.stateOf(seed.projectIds[0], seed.ownerIds[0]),
            readers.journal.stateOf(seed.projectIds[0], seed.ownerIds[1]),
            readers.journal.stateOf(seed.projectIds[1], seed.ownerIds[1]),
          ]),
        ).toEqual([
          { undoable: false, redoable: true },
          { undoable: false, redoable: true },
          { undoable: false, redoable: true },
        ]);
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.planEvents.listFor(projectId, {})),
          ),
        ).toEqual([
          [
            event(undoneB.id, undoneB.projectId, undoneB.userId, undoneB.createdAt),
            event(undoneA.id, undoneA.projectId, undoneA.userId, undoneA.createdAt),
          ],
          [event(other.id, other.projectId, other.userId, other.createdAt)],
        ]);
        const replacement = entry('redo-a-replacement', seed.projectIds[0], seed.ownerIds[0], 200);
        await port.append(
          structuredClone(replacement),
          event(replacement.id, replacement.projectId, replacement.userId, replacement.createdAt),
        );
        expect(
          await Promise.all([
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[0]),
            readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[1]),
            readers.journal.entriesFor(seed.projectIds[1], seed.ownerIds[1]),
          ]),
        ).toEqual([[stored(replacement, 1)], [flippedB], [flippedOther]]);
        expect(
          await Promise.all([
            readers.journal.stateOf(seed.projectIds[0], seed.ownerIds[0]),
            readers.journal.stateOf(seed.projectIds[0], seed.ownerIds[1]),
            readers.journal.stateOf(seed.projectIds[1], seed.ownerIds[1]),
          ]),
        ).toEqual([
          { undoable: true, redoable: false },
          { undoable: false, redoable: true },
          { undoable: false, redoable: true },
        ]);
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.planEvents.listFor(projectId, {})),
          ),
        ).toEqual([
          [
            event(replacement.id, replacement.projectId, replacement.userId, replacement.createdAt),
            event(undoneB.id, undoneB.projectId, undoneB.userId, undoneB.createdAt),
            event(undoneA.id, undoneA.projectId, undoneA.userId, undoneA.createdAt),
          ],
          [event(other.id, other.projectId, other.userId, other.createdAt)],
        ]);
        // Proof: changing only the production constant to 51 or 2 failed both
        // real-source Task 5.1 runs here (`Expected: 50`, `Received: 51`/`2`).
        expect(JOURNAL_DEPTH).toBe(50);
        const bulk = Array.from({ length: 51 }, (_, index) =>
          entry(
            `depth-${String(index).padStart(2, '0')}`,
            seed.projectIds[0],
            seed.ownerIds[0],
            300 + index,
          ),
        );
        for (const row of bulk)
          await port.append(
            structuredClone(row),
            event(row.id, row.projectId, row.userId, row.createdAt),
          );

        expect(await readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[0])).toEqual(
          Array.from({ length: 50 }, (_, index) =>
            stored(
              entry(
                `depth-${String(index + 1).padStart(2, '0')}`,
                seed.projectIds[0],
                seed.ownerIds[0],
                301 + index,
              ),
              index + 3,
            ),
          ),
        );
        expect(await readers.journal.entriesFor(seed.projectIds[0], seed.ownerIds[1])).toEqual([
          stored(undoneB, 1, true, { expected: { 'redo-b': 900 }, from: { 'redo-b': 899 } }),
        ]);
        expect(await readers.journal.stateOf(seed.projectIds[0], seed.ownerIds[0])).toEqual({
          undoable: true,
          redoable: false,
        });
        expect(await readers.journal.stateOf(seed.projectIds[0], seed.ownerIds[1])).toEqual({
          undoable: false,
          redoable: true,
        });
        expect(await readers.journal.entriesFor(seed.projectIds[1], seed.ownerIds[1])).toEqual([
          stored(other, 1, true, {
            expected: { 'redo-other-project': 900 },
            from: { 'redo-other-project': 899 },
          }),
        ]);
        expect(await readers.planEvents.listFor(seed.projectIds[0], {})).toEqual([
          ...Array.from({ length: 51 }, (_, index) => {
            const depth = 50 - index;
            return event(
              `depth-${String(depth).padStart(2, '0')}`,
              seed.projectIds[0],
              seed.ownerIds[0],
              300 + depth,
            );
          }),
          event(replacement.id, replacement.projectId, replacement.userId, replacement.createdAt),
          event(undoneB.id, undoneB.projectId, undoneB.userId, undoneB.createdAt),
          event(undoneA.id, undoneA.projectId, undoneA.userId, undoneA.createdAt),
        ]);
        expect(await readers.planEvents.listFor(seed.projectIds[1], {})).toEqual([
          event(other.id, other.projectId, other.userId, other.createdAt),
        ]);
      },
    ),
    storeCase('journal', 'journal.flip:preconditions', open, async ({ port, readers, seed }) => {
      const target = {
        ...entry('flip-target', seed.projectIds[0], seed.ownerIds[0], 101),
        preconditions: { expected: { 'work-a-one': 11 }, from: { 'work-a-one': 10 } },
      };
      const peer = {
        ...entry('flip-peer', seed.projectIds[0], seed.ownerIds[0], 102),
        preconditions: { expected: { 'work-a-two': 12 }, from: { 'work-a-two': 11 } },
      };
      const other = entry('flip-other-project', seed.projectIds[1], seed.ownerIds[1], 103);
      for (const row of [target, peer, other]) {
        await port.append(
          structuredClone(row),
          event(row.id, row.projectId, row.userId, row.createdAt),
        );
      }

      expect(await readFlipObservation(readers, seed)).toEqual({
        entries: [
          [expectedFlipTarget(seed, false, 11, 10), expectedFlipPeer(seed)],
          [expectedFlipOther(seed)],
        ],
        states: [
          { undoable: true, redoable: false },
          { undoable: true, redoable: false },
        ],
        history: expectedFlipHistory(seed),
      });

      await port.flip(
        target.id,
        true,
        structuredClone({ expected: { 'work-a-one': 21 }, from: { 'work-a-one': 11 } }),
      );
      expect(await readFlipObservation(readers, seed)).toEqual({
        entries: [
          [expectedFlipTarget(seed, true, 21, 11), expectedFlipPeer(seed)],
          [expectedFlipOther(seed)],
        ],
        states: [
          { undoable: true, redoable: true },
          { undoable: true, redoable: false },
        ],
        history: expectedFlipHistory(seed),
      });

      await port.restamp(
        target.id,
        structuredClone({ expected: { 'work-a-one': 31 }, from: { 'work-a-one': 11 } }),
      );
      expect(await readFlipObservation(readers, seed)).toEqual({
        entries: [
          [expectedFlipTarget(seed, true, 31, 11), expectedFlipPeer(seed)],
          [expectedFlipOther(seed)],
        ],
        states: [
          { undoable: true, redoable: true },
          { undoable: true, redoable: false },
        ],
        history: expectedFlipHistory(seed),
      });

      await port.discard(peer.id);
      expect(await readFlipObservation(readers, seed)).toEqual({
        entries: [[expectedFlipTarget(seed, true, 31, 11)], [expectedFlipOther(seed)]],
        states: [
          { undoable: false, redoable: true },
          { undoable: true, redoable: false },
        ],
        history: expectedFlipHistory(seed),
      });

      await port.discard(target.id);
      expect(await readFlipObservation(readers, seed)).toEqual({
        entries: [[], [expectedFlipOther(seed)]],
        states: [
          { undoable: false, redoable: false },
          { undoable: true, redoable: false },
        ],
        history: expectedFlipHistory(seed),
      });
    }),
  ];
}
