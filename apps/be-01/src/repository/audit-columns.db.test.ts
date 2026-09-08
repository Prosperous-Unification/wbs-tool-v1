import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

import { messagesOf } from './constraint';
import type { Drizzle } from './db';
import { openDrizzle } from './db';
import { DirectoryRepository } from './directory';
import { OPEN } from './gate';
import type { WriteStamp } from './index';
import { runMigrations } from './migrate';
import { person, personTeam, tag } from './schema';
import { UserRepository } from './user';

/**
 * What the audit columns say after a write, measured against SQLite.
 *
 * `audit.test.ts` beside this one reads the *source* and proves every write site
 * names a helper. This proves the helpers put the right values in the right
 * columns, which is a different claim and needs a real database: the column
 * defaults, the `NOT NULL`-ness and the foreign key are the database's answers,
 * not TypeScript's.
 */

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let db: Drizzle;
let directory: DirectoryRepository;
/** The account every stamp below is attributed to unless a case says otherwise. */
let kim: string;
/** A second account, because "the author did not change" is a claim about two. */
let sam: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-audit-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);
  directory = new DirectoryRepository(db, OPEN);

  kim = crypto.randomUUID();
  sam = crypto.randomUUID();
  const users = new UserRepository(db, OPEN);
  await users.create(
    { id: kim, username: 'kim', passwordHash: 'x', createdAt: 1 },
    stampAt(1, kim),
  );
  await users.create(
    { id: sam, username: 'sam', passwordHash: 'x', createdAt: 1 },
    stampAt(1, sam),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stampAt = (at: number, by: string): WriteStamp => ({ at, by });

describe('a row records who made it and when', () => {
  it('stamps a new row with the acting account and one instant', async () => {
    const made = await directory.addTag(
      { id: crypto.randomUUID(), name: 'wiring' },
      stampAt(1000, kim),
    );

    const rows = await db.select().from(tag).where(eq(tag.id, made.id));
    const row = rows.at(0);
    expect(row?.createdBy).toBe(kim);
    expect(row?.createdAt).toBe(1000);
    // Equal, not null: "never changed since it was made" and "last changed when
    // it was made" are the same fact, and a null here would make every reader of
    // the pair write `updatedAt ?? createdAt`.
    //
    // Proof: `auditOnCreate` with its `updatedAt` line deleted — watched failing
    // on `expected null to be 1000`. 2026-09-01.
    expect(row?.updatedAt).toBe(1000);
  });

  it('moves updatedAt on a change and leaves the author alone', async () => {
    const made = await directory.addTag(
      { id: crypto.randomUUID(), name: 'wiring' },
      stampAt(1000, kim),
    );

    // A **different** account at a **later** instant, and both halves matter:
    // renaming as `kim` would leave "the author is still kim" true of a row
    // nobody else ever touched, and R5 has five bills for an assertion made
    // outside the window its fault lives in.
    const renamed = await directory.renameTag(made.id, 'rewiring', stampAt(2000, sam));
    expect(renamed.ok).toBe(true);

    const rows = await db.select().from(tag).where(eq(tag.id, made.id));
    const row = rows.at(0);
    expect(row?.name).toBe('rewiring');
    expect(row?.updatedAt).toBe(2000);
    // The row was made by kim and always will have been. An update that carried
    // `createdBy` would hand authorship to whoever touched it last, which is the
    // quiet half of this fault — the row still reads plausibly.
    //
    // Proof: `auditOnUpdate` returning `auditOnCreate`'s three columns instead —
    // watched failing on `expected <sam> to be <kim>`. 2026-09-01.
    expect(row?.createdBy).toBe(kim);
    expect(row?.createdAt).toBe(1000);
  });

  it('gives every row one act wrote the same instant', async () => {
    // `addPerson` writes `person` and `person_team` in one transaction, which is
    // the smallest act in the schema that lands in two tables.
    const team = await directory.addTeam(
      { id: crypto.randomUUID(), name: 'Sparks' },
      stampAt(500, kim),
    );
    const added = await directory.addPerson(
      { id: crypto.randomUUID(), name: 'Ali' },
      [team.id],
      stampAt(1500, kim),
    );
    expect(added.ok).toBe(true);

    const people = await db.select().from(person).where(eq(person.name, 'Ali'));
    const membership = await db
      .select()
      .from(personTeam)
      .where(eq(personTeam.serviceTeamId, team.id));

    // One act, one instant — the rule the stamp exists to make structural. Two
    // `now()` reads inside one act is what this forbids, and the history is
    // ordered by these columns.
    //
    // The assertion is against the stamp's **own** figure rather than "the two
    // are equal", and that is what makes it able to fail: two clock reads a
    // microsecond apart land in the same millisecond most runs, so an equality
    // between the two tables would have passed with a stray `Date.now()` in
    // place. Proof: `auditOnCreate`'s `createdAt` changed to `Date.now()` —
    // watched failing here and in the two cases above, on the real epoch
    // against 1500 and 1000. 2026-09-01.
    expect(people.at(0)?.createdAt).toBe(1500);
    expect(membership.at(0)?.createdAt).toBe(1500);
    expect(membership.at(0)?.createdBy).toBe(kim);
  });

  it('leaves a row written before the columns existed unattributed', async () => {
    // A row from before the migration, written the way the migration leaves
    // them: the three columns null. Nothing may substitute for them — the
    // instant is guessable and the author is not, and a default would record an
    // account that did not write the row.
    await db.insert(tag).values({ id: 'older-than-the-column', name: 'legacy' });

    const rows = await db.select().from(tag).where(eq(tag.id, 'older-than-the-column'));
    const row = rows.at(0);
    expect(row?.createdBy).toBeNull();
    expect(row?.createdAt).toBeNull();
    expect(row?.updatedAt).toBeNull();
  });

  it('refuses a row authored by an account that does not exist', async () => {
    // The foreign key, which is what makes `created_by` a reference rather than
    // a string that looks like one. Measured because a `REFERENCES` clause can
    // be present in the DDL and unenforced — `steps-schema-rename` shipped
    // exactly that, and the check written for it passed against the broken
    // database.
    //
    // Read down the `cause` chain, as `dependency.db.test.ts` does: drizzle
    // 1.0.0-rc.4 wraps SQLite's refusal in a `DrizzleQueryError` whose own
    // message names the statement, not the constraint.
    const refusal = await directory
      .addTag({ id: crypto.randomUUID(), name: 'ghost' }, stampAt(1000, 'nobody'))
      .catch((err: unknown) => err);
    expect(messagesOf(refusal).join('\n')).toMatch(/FOREIGN KEY/);
  });
});
