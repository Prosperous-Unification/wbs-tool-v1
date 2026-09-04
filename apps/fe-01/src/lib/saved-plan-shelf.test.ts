import { describe, expect, it, vi } from 'vitest';

import type { SavedPlanListEntryView } from './saved-plan-api';
import { readShelf } from './saved-plan-shelf';

const ROW: SavedPlanListEntryView = {
  id: 'sp1',
  name: 'before the re-plan',
  createdBy: 'ada',
  createdAt: 1_788_501_600_000,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
};

describe('reading a project’s shelf', () => {
  it('does not ask for a list a node cannot answer', async () => {
    // **The case that closes 6.4.** The probe and the sentence were both written
    // before this function, and each is asserted against its own input — so a
    // build where the probe is never invoked passed all of them. This is the
    // assertion neither of them can make: the answer is *used*.
    // Negative, MEASURED on h2puni at b9940187 and reverted with dirty=0
    // re-asserted: delete the `if (!available)` line and this file is 4 pass /
    // 1 fail, the one being this case. It reddens on the *returned state* —
    // `{ kind: 'ready', rows: [ROW] }` where `{ kind: 'unavailable' }` was
    // expected — so `resolves.toEqual` throws and the spy assertion below never
    // runs. Stated because the obvious guess is the other way round. The spy is
    // still not redundant: it is the only thing that would catch a build that
    // answered `unavailable` and asked for the list anyway, which is a shape no
    // assertion on the return value can see.
    const list = vi.fn(() => Promise.resolve([ROW]));
    await expect(
      readShelf({ available: () => Promise.resolve(false), list }, 'p1'),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(list).not.toHaveBeenCalled();
  });

  it('reads the rows once the node says it has the routes', async () => {
    const list = vi.fn(() => Promise.resolve([ROW]));
    await expect(
      readShelf({ available: () => Promise.resolve(true), list }, 'p1'),
    ).resolves.toEqual({ kind: 'ready', rows: [ROW] });
    expect(list).toHaveBeenCalledWith('p1');
  });

  it('separates a refused probe from a probe that answered no', async () => {
    // A document that could not be read is a fault to report; a document that
    // was read and lacked the paths is a node to upgrade. One try block covering
    // both would collapse them, and the reader would be told to upgrade a server
    // that is merely behind a broken proxy.
    await expect(
      readShelf(
        { available: () => Promise.reject(new Error('http_500')), list: () => Promise.resolve([]) },
        'p1',
      ),
    ).resolves.toEqual({ kind: 'error', code: 'http_500' });
  });

  it('carries be-01’s own code out of a failed read', async () => {
    await expect(
      readShelf(
        {
          available: () => Promise.resolve(true),
          list: () => Promise.reject(new Error('not_found')),
        },
        'p1',
      ),
    ).resolves.toEqual({ kind: 'error', code: 'not_found' });
  });

  it('shows whatever was thrown when something throws a non-Error', async () => {
    // Every throw in the API layer is an Error carrying be-01's code. On the day
    // one is not, showing what arrived beats erasing it behind 'unknown'.
    // Negative, MEASURED and reverted with dirty=0 re-asserted: `String(fault)`
    // replaced by the literal `'unknown'` is 4 pass / 1 fail, the one being this
    // case. The arm is load-bearing rather than defensive decoration.
    await expect(
      readShelf(
        {
          available: () => Promise.resolve(true),
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with a non-Error is the branch under test, and the rule is right about the production code it is aimed at: this is the one place the shape has to be written down literally, because the fault has to arrive as a bare string for `codeOf`'s `String(fault)` arm to be reached at all.
          list: () => Promise.reject('a bare string'),
        },
        'p1',
      ),
    ).resolves.toEqual({ kind: 'error', code: 'a bare string' });
  });
});
