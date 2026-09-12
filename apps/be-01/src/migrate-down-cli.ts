// Reverses migrations this deploy applied, run from the swap executor's abort
// path while the incoming container is still up:
//
//   docker exec be-01-<color> bun run src/migrate-down-cli.ts --to=<name|none>
//
// `--to` is the newest migration that was applied BEFORE the deploy, captured
// by migrate-status-cli.ts in the same swap. `none` means the database had no
// migrations applied at all, so everything this deploy added comes back off.
//
// Blue and green share one SQLite file. A forward migration is required to be
// additive, so the old colour keeps working while green migrates; the reverse
// is not additive by nature, which is why this runs only on an abort, when
// green is being taken away and blue is the release that will keep serving.
import { ROLLBACK_ALL, rollbackTo } from '@wbs/store-sqlite/migrate-down';

const dbPath = process.env['DB_PATH'];
if (dbPath === undefined || dbPath === '') throw new Error('DB_PATH must be set');

const arg = process.argv.slice(2).find((a) => a.startsWith('--to='));
if (arg === undefined) {
  throw new Error(
    'refusing: --to=<migration-name|none> is required.\n' +
      '  Without it there is no way to tell which migrations this deploy added,\n' +
      '  and rolling back the wrong number is worse than rolling back none.',
  );
}
const target = arg.slice('--to='.length);
if (target === '') throw new Error(`--to must name a migration, or "${ROLLBACK_ALL}"`);

const reversed = rollbackTo(dbPath, './drizzle', target);
if (reversed.length === 0) {
  console.log(`no migrations to roll back (already at ${target})`);
} else {
  console.log(`rolled back: ${reversed.join(', ')}`);
}
