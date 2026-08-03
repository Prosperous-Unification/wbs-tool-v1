import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { MissingEnvExampleError, seedApp } from './setup';

async function makeFakeRepo(apps: Record<string, { example?: string; env?: string }>) {
  const root = await mkdtemp(join(tmpdir(), 'dev-setup-'));
  for (const [app, files] of Object.entries(apps)) {
    await mkdir(join(root, 'apps', app), { recursive: true });
    if (files.example !== undefined)
      await writeFile(join(root, 'apps', app, '.env.example'), files.example, 'utf8');
    if (files.env !== undefined)
      await writeFile(join(root, 'apps', app, '.env'), files.env, 'utf8');
  }
  return root;
}

describe('dev:setup seedApp', () => {
  it('writes .env from .env.example when .env is absent', async () => {
    const root = await makeFakeRepo({ 'be-01': { example: 'PORT=3100\n' } });
    expect(await seedApp('be-01', root)).toBe('wrote');
    expect(await Bun.file(join(root, 'apps', 'be-01', '.env')).text()).toBe('PORT=3100\n');
  });

  it('leaves an existing .env alone', async () => {
    const root = await makeFakeRepo({
      'be-01': { example: 'PORT=3100\n', env: 'PORT=9999\n' },
    });
    expect(await seedApp('be-01', root)).toBe('already-present');
    // The point of non-destructive: the developer's edits survive.
    expect(await Bun.file(join(root, 'apps', 'be-01', '.env')).text()).toBe('PORT=9999\n');
  });

  // The negative test. This used to log "no .env.example — skipping" and return,
  // so a checkout missing a committed file produced a green setup and the
  // failure surfaced much later as an unexplained missing-env crash at serve.
  it('throws when .env.example is missing rather than skipping', async () => {
    const root = await makeFakeRepo({ 'be-01': {} });
    expect(seedApp('be-01', root)).rejects.toThrow(MissingEnvExampleError);
  });
});
