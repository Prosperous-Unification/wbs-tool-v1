import { describe, expect, it } from 'vitest';

import { createLocalWrite } from './local-write';

describe('LocalWrite', () => {
  it('keeps the completed prefix when a later request refuses', async () => {
    // Proof: clearing `completed` when the second request rejected failed here
    // with `expected [] to deeply equal ['tree']`. Watched, 2026-09-13.
    const write = createLocalWrite();

    await expect(write.perform(['tree'], () => Promise.resolve('created'))).resolves.toBe(
      'created',
    );
    await expect(
      write.perform(['directory'], () => Promise.reject(new Error('attachment refused'))),
    ).rejects.toThrow('attachment refused');

    expect(write.completedResources()).toEqual(['tree']);
  });
});
