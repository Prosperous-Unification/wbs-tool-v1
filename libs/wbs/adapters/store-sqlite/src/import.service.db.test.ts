import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importServiceSourceContract } from '@wbs/core/testing/import-service-source-contract';

import { runMigrations } from './migrate';
import { openSqliteSource } from './source';

const MIGRATIONS = new URL('../../../../../apps/wbs/be-01/drizzle', import.meta.url).pathname;

importServiceSourceContract(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-plan-import-'));
  const path = join(dir, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });
  await source.stores.users.create(
    { id: 'import-owner', username: 'import-owner', passwordHash: 'x', createdAt: 1 },
    { at: 1, by: 'import-owner' },
  );
  const close = source.close.bind(source);
  return {
    ...source,
    async close() {
      await close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
