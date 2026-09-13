import { unitOfWorkConformance } from '@wbs/conformance';
import { beforeEach, describe } from 'bun:test';

import { projectRow } from './project-fixture';
import { openMemorySource } from './source';

// Proof: after a confirmed `store-memory:test` local-cache hit, a throw in the
// imported conformance source forced Nx to rerun and fail on
// `injected conformance dependency cache fault`.

let latestSource: ReturnType<typeof openMemorySource> | null = null;
let latestFixture: {
  readonly projectId: string;
  readonly stamp: { readonly at: number; readonly by: string };
} | null = null;

beforeEach(async () => {
  const source = openMemorySource();
  const { stores } = source;
  const ownerId = crypto.randomUUID();
  const stamp = { at: 1, by: ownerId };
  const projectId = 'p1';
  const stepId = 'st-1';
  await stores.users.create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    stamp,
  );
  await stores.projects.create(
    projectRow({ id: projectId, name: 'Rewire the shed', ownerId }),
    [{ id: stepId, projectId, name: 'Dev', position: 10 }],
    stamp,
  );
  await stores.steps.add({ id: stepId, projectId, name: 'Dev' }, stamp);
  latestFixture = { projectId, stamp };
  latestSource = source;
});

describe('the in-memory unit of work', () => {
  unitOfWorkConformance(() => {
    const source = latestSource;
    const fixture = latestFixture;
    if (source === null || fixture === null) {
      throw new Error('the source was read before it opened');
    }
    return {
      uow: source.uow,
      reader: source.stores,
      projectId: fixture.projectId,
      stamp: fixture.stamp,
    };
  });
});
