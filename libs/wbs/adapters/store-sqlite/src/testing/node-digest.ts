import { createHash } from 'node:crypto';

import type { Digest } from '@wbs/core';

/** SHA-256 adapter for SQLite integration tests. */
export const nodeDigest: Digest = {
  sha256: (bytes) => Promise.resolve(createHash('sha256').update(bytes, 'utf8').digest('hex')),
};
