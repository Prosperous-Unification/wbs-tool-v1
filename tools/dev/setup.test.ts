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

describe('the seeded env files must agree where two tiers share a secret', () => {
  // be-01 signs the tokens gw-01 verifies. When the two `.env.example` files
  // disagree, `dev:setup` seeds a checkout where registration and login work
  // and the WebSocket then 401s -- which reads as a gateway fault rather than a
  // configuration one. That shipped for a day, with be-01's own comment stating
  // the rule the value beneath it broke.
  it('gives be-01 and gw-01 the same JWT_SIGNING_KEY_CURRENT', async () => {
    const root = new URL('../../', import.meta.url).pathname;
    const read = async (app: string): Promise<string> => {
      const text = await Bun.file(`${root}apps/${app}/.env.example`).text();
      const line = text.split('\n').find((l) => l.startsWith('JWT_SIGNING_KEY_CURRENT='));
      if (line === undefined) throw new Error(`${app}/.env.example has no JWT_SIGNING_KEY_CURRENT`);
      return line.slice('JWT_SIGNING_KEY_CURRENT='.length);
    };

    const [be, gw] = await Promise.all([read('be-01'), read('gw-01')]);
    expect(be).toBe(gw);
    // A shared secret that is not a secret-sized string is its own defect: both
    // configs hold this to >=32 characters, so a seeded checkout that passes
    // this test must also pass startup validation.
    expect(be.length).toBeGreaterThanOrEqual(32);
  });

  it('seeds be-01 and gw-01 into local auth with an explicit development signal', async () => {
    const root = new URL('../../', import.meta.url).pathname;
    const read = async (app: string): Promise<Map<string, string>> => {
      const text = await Bun.file(`${root}apps/${app}/.env.example`).text();
      return new Map(
        text
          .split('\n')
          .filter((line) => line !== '' && !line.startsWith('#'))
          .map((line) => {
            const splitAt = line.indexOf('=');
            return [line.slice(0, splitAt), line.slice(splitAt + 1)];
          }),
      );
    };

    for (const env of await Promise.all([read('be-01'), read('gw-01')])) {
      expect(env.get('AUTH_MODE')).toBe('local');
      expect(env.get('NODE_ENV')).toBe('development');
    }
  });
});
