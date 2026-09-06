import { expect, spyOn, test } from 'bun:test';

import { PlanCommandRunner } from '../service/plan-commands';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { inMemoryServices } from '../testing/harness';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testWrites } from '../testing/writes-fixture';
import { workItemRoutes } from './work-item.routes';

function fixture() {
  const plan = inMemoryServices();
  const runner = new PlanCommandRunner({
    workItems: plan.service,
    directory: testDirectoryService(plan.stores.directory),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    ...testWrites(),
  });
  return { runner, endpoints: workItemRoutes(plan.service, runner) };
}

test('typed undo and redo preserve actor and details without exposing journal entry ids', async () => {
  const f = fixture();
  const actor = { id: 'owner', username: 'owner', scopes: ['read', 'write'] as const };
  for (const [endpoint, operation] of [
    [f.endpoints[3], 'undo'],
    [f.endpoints[4], 'redo'],
  ] as const) {
    const call = spyOn(f.runner, operation);
    const completed = {
      ok: true as const,
      value: { done: 'Undo change', detail: 'Work', entryId: 'private' },
    };
    call.mockResolvedValueOnce(completed);
    expect(
      await endpoint.handle({
        params: { id: 'p' },
        query: undefined,
        body: undefined,
        principal: actor,
        request: { method: 'POST', url: new URL('http://localhost'), headers: new Headers() },
      }),
    ).toEqual({ ok: true, status: 200, body: { done: 'Undo change', detail: 'Work' } });
    expect(call).toHaveBeenCalledWith('p', 'owner');
  }
});
