import type { DependencyStore, StoredDependency, WriteStamp } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

export const DEPENDENCY_SURVIVOR_IDS = [
  'dependency-survivor-one',
  'dependency-survivor-two',
] as const;

function byId(edges: StoredDependency[]): StoredDependency[] {
  return edges.toSorted((left, right) => left.id.localeCompare(right.id));
}

function edge(
  id: string,
  projectId: string,
  predecessorId: string,
  successorId: string,
): StoredDependency {
  return { id, projectId, predecessorId, successorId };
}

async function addEdge(
  port: DependencyStore,
  dependency: StoredDependency,
  stamp: WriteStamp,
): Promise<void> {
  await port.add(structuredClone(dependency), stamp);
}

/** Shared dependency cases observed through complete public project lists. */
export function dependencyRegistrations(
  open: OpenCase<'dependencies'>,
): readonly CaseRegistration[] {
  return [
    storeCase(
      'dependencies',
      'dependencies.listByWorkItems:incident-scope',
      open,
      async ({ port, seed }) => {
        const [firstId, secondId] = seed.workItemIds[0];
        await addEdge(
          port,
          edge('edge-targeted', seed.projectIds[0], firstId, secondId),
          seed.stamps[0],
        );
        expect(
          (await port.listByWorkItems(seed.projectIds[0], [firstId])).map(({ id }) => id),
        ).toEqual(['edge-targeted']);
        // Proof: an unrelated edge in this answer makes the exact id list fail.
        expect(await port.listByWorkItems(seed.projectIds[0], ['work-missing'])).toEqual([]);
        expect(await port.listByWorkItems(seed.projectIds[0], [seed.workItemIds[1][0]])).toEqual(
          [],
        );
        expect(await port.listByWorkItems(seed.projectIds[0], [])).toEqual([]);
        await addEdge(
          port,
          edge(
            'edge-cross-project',
            seed.projectIds[0],
            seed.workItemIds[1][0],
            seed.workItemIds[1][1],
          ),
          seed.stamps[0],
        );
        // Proof: dropping endpoint project validation returned this malformed
        // edge when the other project's id was targeted.
        expect(port.listByWorkItems(seed.projectIds[0], [seed.workItemIds[1][0]])).rejects.toThrow(
          /endpoint outside project/,
        );
      },
    ),
    storeCase(
      'dependencies',
      'dependencies.add:idempotent-pair',
      open,
      async ({ port, readers, seed }) => {
        const [predecessorId, successorId] = seed.workItemIds[0];
        const [survivorOneId, survivorTwoId] = DEPENDENCY_SURVIVOR_IDS;
        const original = edge(
          'dependency-idempotent-original',
          seed.projectIds[0],
          predecessorId,
          successorId,
        );
        const samePair = edge(
          'dependency-idempotent-second-id',
          seed.projectIds[0],
          predecessorId,
          successorId,
        );
        const surviving = edge(
          'dependency-idempotent-surviving',
          seed.projectIds[0],
          survivorOneId,
          survivorTwoId,
        );
        const otherProject = edge(
          'dependency-idempotent-other-project',
          seed.projectIds[1],
          seed.workItemIds[1][0],
          seed.workItemIds[1][1],
        );

        await addEdge(port, original, seed.stamps[0]);
        await addEdge(port, surviving, seed.stamps[0]);
        await addEdge(port, otherProject, seed.stamps[1]);
        // Proof: in-place input-ID faults on both real sources store the
        // complete mutated edge while this independent original remains fixed.
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual(
          byId([original, surviving]),
        );
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
          otherProject,
        ]);

        await addEdge(port, samePair, seed.stamps[1]);
        // Proof: both ID-keyed source faults retain the original and add this
        // complete second-ID edge through adapter-owned storage.
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual(
          byId([original, surviving]),
        );
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
          otherProject,
        ]);

        await addEdge(port, samePair, seed.stamps[1]);
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual(
          byId([original, surviving]),
        );
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
          otherProject,
        ]);
      },
    ),
    storeCase('dependencies', 'dependencies.remove:pair', open, async ({ port, readers, seed }) => {
      const [predecessorId, successorId] = seed.workItemIds[0];
      const [survivorOneId, survivorTwoId] = DEPENDENCY_SURVIVOR_IDS;
      const selected = edge(
        'dependency-remove-selected',
        seed.projectIds[0],
        predecessorId,
        successorId,
      );
      const samePredecessor = edge(
        'dependency-remove-same-predecessor',
        seed.projectIds[0],
        predecessorId,
        survivorOneId,
      );
      const sameSuccessor = edge(
        'dependency-remove-same-successor',
        seed.projectIds[0],
        survivorTwoId,
        successorId,
      );
      const surviving = edge(
        'dependency-remove-surviving',
        seed.projectIds[0],
        survivorOneId,
        survivorTwoId,
      );
      const otherProject = edge(
        'dependency-remove-other-project',
        seed.projectIds[1],
        seed.workItemIds[1][0],
        seed.workItemIds[1][1],
      );
      const projectA = [selected, samePredecessor, sameSuccessor, surviving];
      for (const seeded of projectA) await addEdge(port, seeded, seed.stamps[0]);
      await addEdge(port, otherProject, seed.stamps[1]);
      expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual(
        byId(projectA),
      );
      expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
        otherProject,
      ]);

      await port.remove(predecessorId, successorId, seed.stamps[1]);
      // Proof: both source proofs omit the successor half of the pair
      // predicate; the received list loses the exact same-predecessor edge.
      expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual(
        byId([samePredecessor, sameSuccessor, surviving]),
      );
      expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
        otherProject,
      ]);

      await port.remove(predecessorId, successorId, seed.stamps[1]);
      expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual(
        byId([samePredecessor, sameSuccessor, surviving]),
      );
      expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
        otherProject,
      ]);
    }),
    storeCase(
      'dependencies',
      'dependencies.removeAllFor:touching-set',
      open,
      async ({ port, readers, seed }) => {
        const [doomedOneId, doomedTwoId] = seed.workItemIds[0];
        const [survivorOneId, survivorTwoId] = DEPENDENCY_SURVIVOR_IDS;
        const incoming = edge(
          'dependency-remove-all-incoming',
          seed.projectIds[0],
          survivorOneId,
          doomedOneId,
        );
        const outgoing = edge(
          'dependency-remove-all-outgoing',
          seed.projectIds[0],
          doomedTwoId,
          survivorTwoId,
        );
        const doomed = edge(
          'dependency-remove-all-doomed',
          seed.projectIds[0],
          doomedOneId,
          doomedTwoId,
        );
        const surviving = edge(
          'dependency-remove-all-surviving',
          seed.projectIds[0],
          survivorOneId,
          survivorTwoId,
        );
        const otherProject = edge(
          'dependency-remove-all-other-project',
          seed.projectIds[1],
          seed.workItemIds[1][0],
          seed.workItemIds[1][1],
        );
        const projectA = [incoming, outgoing, doomed, surviving];
        for (const seeded of projectA) await addEdge(port, seeded, seed.stamps[0]);
        await addEdge(port, otherProject, seed.stamps[1]);
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual(
          byId(projectA),
        );
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
          otherProject,
        ]);

        await port.removeAllFor([doomedOneId, doomedTwoId], seed.stamps[1]);
        // Proof: the outgoing-only source faults leave the exact incoming edge;
        // the incomplete-set faults leave the exact outgoing edge for doomed two.
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual([
          surviving,
        ]);
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
          otherProject,
        ]);

        await port.removeAllFor([doomedOneId, doomedTwoId], seed.stamps[1]);
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[0]))).toEqual([
          surviving,
        ]);
        expect(byId(await readers.dependencies.listByProject(seed.projectIds[1]))).toEqual([
          otherProject,
        ]);
      },
    ),
  ];
}
