import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@wbs/tool-test-scratch';
import { afterAll, describe, expect, it } from 'bun:test';

import { checkCap, DOC_CAPS } from './doc-caps';

const dir = scratchSync('wbs-doc-caps-');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function doc(name: string, lines: number): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `${Array.from({ length: lines }, (_, i) => `line ${String(i)}`).join('\n')}\n`,
  );
  return path;
}

describe('checkCap', () => {
  it('passes a file at exactly its cap', async () => {
    expect(await checkCap(doc('at-cap.md', 10), 10)).toBeNull();
  });

  it('fails a file one line over, naming both numbers', async () => {
    const issue = await checkCap(doc('over.md', 11), 10);
    expect(issue?.reason).toMatch(/11 lines, capped at 10/);
  });

  it('fails a file it cannot read rather than passing it', async () => {
    // An unreadable doc must not be indistinguishable from a short one.
    const issue = await checkCap(join(dir, 'does-not-exist.md'), 10);
    expect(issue?.reason).toMatch(/could not be read/);
  });
});

describe('the real capped docs', () => {
  // The paths in DOC_CAPS are relative to the repo root, which is where
  // lefthook and CI invoke the hook. `bun test` runs with the project as its
  // cwd, so the root is resolved from this file rather than assumed.
  const root = new URL('../../../../', import.meta.url).pathname;

  it('are within their caps', async () => {
    for (const { file, maxLines } of DOC_CAPS) {
      expect(await checkCap(join(root, file), maxLines)).toBeNull();
    }
  });
});
