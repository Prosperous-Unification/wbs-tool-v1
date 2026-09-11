// Run explicitly against green before it takes traffic (design decision 8):
// `docker exec be-01-<color> bun run src/migrate-cli.ts`, invoked from
// tool-remote-scripts' swap executor as a discrete deploy step. A failure
// here aborts the deploy with the old colour untouched and un-migrated.
import { runMigrations } from '@wbs/store-sqlite/migrate';

const dbPath = process.env['DB_PATH'];
if (dbPath === undefined || dbPath === '') throw new Error('DB_PATH must be set');
runMigrations(dbPath, './drizzle');
console.log('migrations applied');
