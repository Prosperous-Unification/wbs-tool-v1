import { afterAll } from 'bun:test';

import { removeProcessRoot } from '.';

// Bun test workers skip Node-compatible exit hooks at runner teardown. A
// preload hook spans every file assigned to the worker, unlike a hook registered
// by the first test file that happens to import the cached scratch module.
// Proof: TASK-385's h2puni fault run removed this hook; scratch.test.ts failed
// and the watched wbs-test-* count increased.
afterAll(removeProcessRoot);
