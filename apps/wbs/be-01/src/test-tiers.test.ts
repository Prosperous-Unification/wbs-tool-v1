import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

/**
 * The suffix that decides which tier a suite runs in.
 *
 * `be-01:test:unit` runs every `*.test.ts` that is **not** `*.db.test.ts`;
 * `be-01:test:store` runs the rest. Measured 2026-09-02: 650 tests in 12.7s
 * against 617 in 43.3s, and together exactly the 1,267 that `test` runs. So the
 * suffix is the whole mechanism, and a suite filed under the wrong one is either
 * a slow "fast" tier or a store suite nobody runs before saying done.
 *
 * Opening SQLite is the thing that costs: `mkdtemp` plus a migration run is
 * about 0.7s per file, and it is what separates the two tiers.
 *
 * This walks the directory rather than trusting a list, in the shape of
 * `audit.test.ts` beside it — a suite added tomorrow is checked by the same rule.
 *
 * Proof: with `src/repository/db.test.ts` renamed back to `db.test.ts`, watched
 * failing on `Expected value to be empty · Received: [ "repository/db.test.ts
 * opens a database and is not named .db.test.ts" ]` (2026-09-02).
 */
const SRC = new URL('.', import.meta.url).pathname;

/**
 * What a suite must mention to be counted as opening a database.
 *
 * The three real openers, and **not** `mkdtemp`. The first draft included it and
 * this check immediately caught `deployed-commit.test.ts`, which makes a temp
 * directory to write a `HEAD` file into and never touches SQLite — it had been
 * renamed into the store tier on that evidence and is back out of it.
 */
const OPENS_A_DATABASE = /\b(openDrizzle|openDatabase|runMigrations)\b/;

/** Every `*.test.ts` under `src`, as a path relative to it. */
function suites(dir = SRC, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...suites(at, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.test.ts') && entry.name !== 'test-tiers.test.ts') {
      // Itself excluded: this file quotes the opener names in its own regex, so
      // scanning it would file the rule under the tier it describes.
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

describe('every suite is in exactly one tier', () => {
  const all = suites();

  it('finds the suites at all', () => {
    // Both lists below would be empty if the walk found nothing, and two empty
    // lists agree with each other perfectly.
    expect(all.length).toBeGreaterThan(80);
    expect(all.filter((name) => name.endsWith('.db.test.ts')).length).toBeGreaterThan(20);
  });

  it('names a suite `.db.test.ts` when it opens a database, and only then', () => {
    const misfiled: string[] = [];
    for (const name of all) {
      const opens = OPENS_A_DATABASE.test(readFileSync(join(SRC, name), 'utf8'));
      const filed = name.endsWith('.db.test.ts');
      if (opens && !filed) misfiled.push(`${name} opens a database and is not named .db.test.ts`);
      if (!opens && filed) misfiled.push(`${name} is named .db.test.ts and opens no database`);
    }
    expect(misfiled).toBeEmpty();
  });
});
