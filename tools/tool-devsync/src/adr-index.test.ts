import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'bun:test';

const ADR_DIR = fileURLToPath(new URL('../../../docs/adr/', import.meta.url));

it('ADR numbers are unique and contiguous from 0001', async () => {
  const numbers = (await readdir(ADR_DIR))
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((left, right) => left - right);
  const expected = numbers.map((_, index) => index + 1);
  // Proof: two ADRs numbered 0018 made this fail with `[..., 18, 18, 19, ...]` against
  // `[..., 18, 19, ..., 25]` before the second one was renumbered to 0025 (2026-09-16).
  expect(numbers).toEqual(expected);
});
