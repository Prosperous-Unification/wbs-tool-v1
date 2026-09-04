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
    // Negative: delete the `if (!available)` line and this reddens on `list`
    // having been called once.
    const list = vi.fn(() => Promise.resolve([ROW]));
    await expect(
      readShelf({ available: () => Promise.resolve(false), list }, 'p1'),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(list).not.toHaveBeenCalled();
  });

  it('reads the rows once the node says it has the routes', async () => {
    const list = vi.fn(() => Promise.resolve([ROW]));
    await expect(readShelf({ available: () => Promise.resolve(true), list }, 'p1')).resolves.toEqual(
      { kind: 'ready', rows: [ROW] },
    );
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
    await expect(
      readShelf(
        { available: () => Promise.resolve(true), list: () => Promise.reject('a bare string') },
        'p1',
      ),
    ).resolves.toEqual({ kind: 'error', code: 'a bare string' });
  });
});
