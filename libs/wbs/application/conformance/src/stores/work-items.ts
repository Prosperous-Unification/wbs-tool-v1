import type { LabelledWorkItem, WorkItem, WorkItemStore } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import type { SeededPlan, SourceReaders } from '../source-declaration';
import { type OpenCase, storeCase } from './store-case';

interface Place {
  readonly id: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly position: number;
}

function placed(rows: readonly LabelledWorkItem[]): Place[] {
  return rows
    .map(({ id, projectId, parentId, position }) => ({ id, projectId, parentId, position }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sorted(rows: readonly LabelledWorkItem[]): LabelledWorkItem[] {
  return [...structuredClone(rows)].sort((left, right) => left.id.localeCompare(right.id));
}

function changed(
  rows: readonly LabelledWorkItem[],
  changes: Readonly<Record<string, Partial<LabelledWorkItem>>>,
): LabelledWorkItem[] {
  return sorted(rows.map((row) => ({ ...row, ...changes[row.id] })));
}

function bumped(
  rows: readonly LabelledWorkItem[],
  revisions: Readonly<Record<string, number>>,
): LabelledWorkItem[] {
  return changed(
    rows,
    Object.fromEntries(
      Object.entries(revisions).map(([id, by]) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row === undefined) throw new Error(`cannot bump unknown expected row ${id}`);
        return [id, { revision: row.revision + by }];
      }),
    ),
  );
}

async function addJunctionWitness(
  port: WorkItemStore,
  id: string,
  seed: SeededPlan,
): Promise<void> {
  expect(
    await port.patch(
      id,
      {
        teamIds: [seed.teamIds[0]],
        tagIds: [seed.tagIds[0]],
        serviceIds: [seed.serviceIds[0]],
        typeIds: [seed.typeIds[0]],
        externalRefs: [
          {
            systemId: seed.externalSystemIds[0],
            url: `https://jira.example.test/browse/${id}`,
            name: `Junction witness for ${id}`,
          },
        ],
      },
      seed.stamps[0],
    ),
  ).toMatchObject({ ok: true });
}

function expectJunctionWitness(
  rows: readonly LabelledWorkItem[],
  id: string,
  seed: SeededPlan,
): void {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`junction witness row ${id} was not publicly readable`);
  expect(row).toMatchObject({
    teamIds: [seed.teamIds[0]],
    serviceIds: [seed.serviceIds[0]],
    typeIds: [seed.typeIds[0]],
    externalRefs: [
      {
        systemId: seed.externalSystemIds[0],
        url: `https://jira.example.test/browse/${id}`,
        name: `Junction witness for ${id}`,
      },
    ],
  });
}

function rowFrom(row: LabelledWorkItem, overrides: Partial<WorkItem>): WorkItem {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    position: row.position,
    name: row.name,
    notes: row.notes,
    frozenNumber: row.frozenNumber,
    startNoEarlierThan: row.startNoEarlierThan,
    startNoEarlierThanReason: row.startNoEarlierThanReason,
    deadline: row.deadline,
    factStart: row.factStart,
    factEnd: row.factEnd,
    priority: row.priority,
    serviceTeamId: row.serviceTeamId,
    serviceId: row.serviceId,
    maxParallel: row.maxParallel,
    revision: row.revision,
    ...overrides,
  };
}

async function seededRows(readers: SourceReaders, projectId: string): Promise<LabelledWorkItem[]> {
  const rows = await readers.workItems.listByProject(projectId);
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/** The shared work-row cases for transactional placement, refusal, promotion, and freezing. */
export function workItemRegistrations(open: OpenCase<'workItems'>): readonly CaseRegistration[] {
  return [
    storeCase('workItems', 'workItems.insert:respace', open, async ({ port, readers, seed }) => {
      const [projectA, projectB] = seed.projectIds;
      const [firstId, secondId] = seed.workItemIds[0];
      await addJunctionWitness(port, secondId, seed);
      const beforeA = structuredClone(await seededRows(readers, projectA));
      const beforeB = structuredClone(await seededRows(readers, projectB));
      expect(beforeA.map(({ id }) => id)).toEqual([firstId, secondId]);
      expect(beforeB.map(({ id }) => id)).toEqual([...seed.workItemIds[1]]);
      expectJunctionWitness(beforeA, secondId, seed);

      await port.setPositions(
        [
          { id: firstId, position: 10 },
          { id: secondId, position: 11 },
        ],
        [],
        seed.stamps[0],
      );
      await port.insert(
        rowFrom(beforeA[0], {
          id: 'work-a-inserted',
          position: 20,
          name: 'Inserted between tight siblings',
          revision: 0,
        }),
        [
          { id: firstId, position: 10 },
          { id: secondId, position: 30 },
        ],
        seed.stamps[0],
      );

      const inserted: LabelledWorkItem = {
        ...rowFrom(beforeA[0], {
          id: 'work-a-inserted',
          position: 20,
          name: 'Inserted between tight siblings',
          revision: 0,
        }),
        teamIds: [],
        tagIds: [],
        serviceIds: [],
        typeIds: [],
        externalRefs: [],
      };
      const afterA = await seededRows(readers, projectA);
      const expectedA = sorted([
        ...changed(beforeA, {
          [firstId]: { position: 10 },
          [secondId]: { position: 30 },
        }),
        inserted,
      ]);

      // Proof: both source faults omitted the real insert call's `respaced`
      // argument; this complete snapshot failed with work-a-two still at
      // position 11 rather than 30 while its populated junction collections
      // remained independently expected.
      expect(afterA).toEqual(expectedA);
      expect(
        afterA
          .map(({ id, position }) => ({ id, position }))
          .sort((left, right) => left.position - right.position),
      ).toEqual([
        { id: firstId, position: 10 },
        { id: 'work-a-inserted', position: 20 },
        { id: secondId, position: 30 },
      ]);
      expect(await seededRows(readers, projectB)).toEqual(beforeB);
    }),
    storeCase(
      'workItems',
      'workItems.patch:refusal-atomic',
      open,
      async ({ port, readers, seed }) => {
        const [projectA, projectB] = seed.projectIds;
        const [targetId] = seed.workItemIds[0];
        expect(
          await port.patch(targetId, { teamIds: [seed.teamIds[0]] }, seed.stamps[0]),
        ).toMatchObject({ ok: true });
        const beforeA = structuredClone(await seededRows(readers, projectA));
        const beforeB = structuredClone(await seededRows(readers, projectB));
        expect(beforeA.find(({ id }) => id === targetId)?.teamIds).toEqual([seed.teamIds[0]]);
        expect(beforeB.map(({ id }) => id)).toEqual([...seed.workItemIds[1]]);

        const refused = await port.patch(
          targetId,
          { name: 'Escaped rename', teamIds: [seed.teamIds[0], 'team-missing'] },
          seed.stamps[1],
        );
        expect(refused).toEqual({ ok: false, reason: 'unknown_team' });
        const afterA = await seededRows(readers, projectA);

        // Proof: both late partial-write faults performed the scalar rename before
        // the real unknown-team refusal; this failed on name `Escaped rename`.
        expect(afterA).toEqual(beforeA);
        expect(await seededRows(readers, projectB)).toEqual(beforeB);
      },
    ),
    storeCase(
      'workItems',
      'workItems.move:parent-position',
      open,
      async ({ port, readers, seed }) => {
        const [projectA, projectB] = seed.projectIds;
        const [parentId, movingId] = seed.workItemIds[0];
        const beforeB = structuredClone(await seededRows(readers, projectB));
        const seededA = await seededRows(readers, projectA);
        expect(seededA.map(({ id }) => id)).toEqual([parentId, movingId]);
        expect(beforeB.map(({ id }) => id)).toEqual([...seed.workItemIds[1]]);

        await port.insert(
          rowFrom(seededA[0], {
            id: 'work-a-child',
            parentId,
            position: 11,
            name: 'Existing child',
            revision: 0,
          }),
          [],
          seed.stamps[0],
        );
        await addJunctionWitness(port, movingId, seed);
        await addJunctionWitness(port, 'work-a-child', seed);
        const beforeA = structuredClone(await seededRows(readers, projectA));
        expectJunctionWitness(beforeA, movingId, seed);
        expectJunctionWitness(beforeA, 'work-a-child', seed);
        await port.move(
          movingId,
          parentId,
          20,
          [{ id: 'work-a-child', position: 30 }],
          seed.stamps[1],
        );

        const afterA = await seededRows(readers, projectA);
        const unchangedRevision = changed(beforeA, {
          [movingId]: { parentId, position: 20 },
          'work-a-child': { position: 30 },
        });
        const bumpedRevision = bumped(unchangedRevision, { [movingId]: 1 });

        // The shared postcondition permits exactly the two revision policies
        // exposed by its public sources: no structural bookkeeping bump, or one
        // bump on the directly reparented row. No mixed or larger bump passes;
        // every other field and all populated junctions remain exact.
        expect([unchangedRevision, bumpedRevision]).toContainEqual(afterA);
        expect(placed(afterA)).toEqual([
          { id: 'work-a-child', projectId: projectA, parentId, position: 30 },
          { id: parentId, projectId: projectA, parentId: null, position: 10 },
          { id: movingId, projectId: projectA, parentId, position: 20 },
        ]);
        expect(await seededRows(readers, projectB)).toEqual(beforeB);
      },
    ),
    storeCase('workItems', 'workItems.remove:promotion', open, async ({ port, readers, seed }) => {
      const [projectA, projectB] = seed.projectIds;
      const [parentId, siblingId] = seed.workItemIds[0];
      const beforeB = structuredClone(await seededRows(readers, projectB));
      const seededA = await seededRows(readers, projectA);
      expect(seededA.map(({ id }) => id)).toEqual([parentId, siblingId]);
      expect(beforeB.map(({ id }) => id)).toEqual([...seed.workItemIds[1]]);

      const children = [
        rowFrom(seededA[0], {
          id: 'work-a-child-one',
          parentId,
          position: 10,
          name: 'First surviving child',
          revision: 0,
        }),
        rowFrom(seededA[0], {
          id: 'work-a-child-two',
          parentId,
          position: 20,
          name: 'Second surviving child',
          revision: 0,
        }),
      ];
      for (const child of children) await port.insert(child, [], seed.stamps[0]);
      await addJunctionWitness(port, children[0].id, seed);
      await addJunctionWitness(port, children[1].id, seed);
      await addJunctionWitness(port, siblingId, seed);
      const beforeA = structuredClone(await seededRows(readers, projectA));
      expectJunctionWitness(beforeA, children[0].id, seed);
      expectJunctionWitness(beforeA, children[1].id, seed);
      expectJunctionWitness(beforeA, siblingId, seed);
      let didRefuse = false;
      try {
        await port.remove(
          [parentId],
          [
            { id: children[0].id, parentId: null, position: 10 },
            { id: children[1].id, parentId: null, position: 20 },
            { id: siblingId, parentId: null, position: 30 },
          ],
          seed.stamps[1],
        );
      } catch {
        didRefuse = true;
      }

      const afterA = await seededRows(readers, projectA);
      const promoted = changed(
        beforeA.filter(({ id }) => id !== parentId),
        {
          'work-a-child-one': { parentId: null, position: 10 },
          'work-a-child-two': { parentId: null, position: 20 },
          [siblingId]: { parentId: null, position: 30 },
        },
      );
      const promotedAndBumped = bumped(promoted, {
        'work-a-child-one': 1,
        'work-a-child-two': 1,
      });

      // Proof: both source faults omitted the second promoted child. This full
      // settled snapshot, including the populated junction collections on every
      // survivor, failed on memory's dangling parent and SQLite's refusal.
      expect([
        { didRefuse: false, rows: promoted },
        { didRefuse: false, rows: promotedAndBumped },
      ]).toContainEqual({ didRefuse, rows: afterA });
      expect(placed(afterA)).toEqual([
        { id: 'work-a-child-one', projectId: projectA, parentId: null, position: 10 },
        { id: 'work-a-child-two', projectId: projectA, parentId: null, position: 20 },
        { id: siblingId, projectId: projectA, parentId: null, position: 30 },
      ]);
      expect(await seededRows(readers, projectB)).toEqual(beforeB);
    }),
    storeCase(
      'workItems',
      'workItems.setFrozenNumbers:clear',
      open,
      async ({ port, readers, seed }) => {
        const [projectA, projectB] = seed.projectIds;
        const [firstId, secondId] = seed.workItemIds[0];
        const beforeB = structuredClone(await seededRows(readers, projectB));
        expect((await seededRows(readers, projectA)).map(({ id }) => id)).toEqual([
          firstId,
          secondId,
        ]);
        expect(beforeB.map(({ id }) => id)).toEqual([...seed.workItemIds[1]]);
        await addJunctionWitness(port, firstId, seed);
        await addJunctionWitness(port, secondId, seed);
        const beforeA = structuredClone(await seededRows(readers, projectA));
        expectJunctionWitness(beforeA, firstId, seed);
        expectJunctionWitness(beforeA, secondId, seed);

        await port.setFrozenNumbers(
          [
            { id: firstId, frozenNumber: '010' },
            { id: secondId, frozenNumber: '020' },
          ],
          seed.stamps[0],
        );
        const frozenA = changed(beforeA, {
          [firstId]: { frozenNumber: '010' },
          [secondId]: { frozenNumber: '020' },
        });
        const frozenAndBumpedA = bumped(frozenA, { [firstId]: 1, [secondId]: 1 });

        // Proof: faults which let the real batch/bookkeeping run but prevent
        // work-a-one acquiring `010` fail this first complete project snapshot.
        expect([frozenA, frozenAndBumpedA]).toContainEqual(await seededRows(readers, projectA));
        expect(await seededRows(readers, projectB)).toEqual(beforeB);

        await port.setFrozenNumbers([{ id: firstId, frozenNumber: null }], seed.stamps[1]);

        const afterA = await seededRows(readers, projectA);
        const unchangedRevision = changed(beforeA, {
          [firstId]: { frozenNumber: null },
          [secondId]: { frozenNumber: '020' },
        });
        const bumpedRevision = bumped(unchangedRevision, { [firstId]: 2, [secondId]: 1 });

        // Proof: both source faults broadened the clear to every frozen row;
        // this complete snapshot failed with work-a-two null rather than `020`
        // while every populated junction collection stayed in the oracle.
        expect([unchangedRevision, bumpedRevision]).toContainEqual(afterA);
        expect(afterA.map(({ id, frozenNumber }) => ({ id, frozenNumber }))).toEqual([
          { id: firstId, frozenNumber: null },
          { id: secondId, frozenNumber: '020' },
        ]);
        expect(await seededRows(readers, projectB)).toEqual(beforeB);
      },
    ),
  ];
}
