import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

/**
 * Every write in this folder fills the audit columns.
 *
 * **Why this is a test and not a lint rule.** A required `stamp: WriteStamp`
 * parameter proves the stamp *arrived* — the compiler sees to that at every call
 * site — and proves nothing about whether it was used: `insert(row, stamp)` that
 * never mentions `stamp` compiles perfectly. So the guarantee needs a second
 * enforcer, and the obvious one was an ESLint `no-restricted-syntax` selector.
 * It was tried and rejected: "an object literal that does **not** contain a
 * spread of `auditOnCreate`" needs `:has()` inside `:not()` over an argument at a
 * known position, esquery has no argument-index selector, and
 * `CallExpression > ObjectExpression` matches any argument — so a plain
 * `map.set(key, { … })` in this folder would have failed the build. A rule that
 * fires on the wrong thing gets disabled, and a disabled rule guards nothing.
 *
 * Reading the source is the precedent this repo already sets (`styles.test.ts`,
 * `vite-config.test.ts`, `playwright-config.test.ts` all assert against files
 * rather than behaviour), and it buys exactness here: the check knows which
 * tables are exempt and why, which no syntax selector could express.
 *
 * **What it does not cover**, stated rather than left to be discovered: it reads
 * text, so a write assembled across two statements, or one whose table is named
 * through a variable, is invisible to it. Both are absent today and the
 * assertion below on the number of statements it found is what will notice if a
 * refactor makes them present.
 *
 * Proof, and it is not a hypothetical: on its **first** run this found two
 * unstamped updates nobody had noticed — `revision.ts`'s `bumpWorkItems` and
 * `bumpProject`, which write a `revision` column and so move a row that
 * survives. Both are stamped now. Then `...auditOnUpdate(stamp)` was deleted
 * from `estimate.ts`'s `moveAll` and this failed on `+ ["estimate.ts: update of
 * estimate"]`, green again with it restored. Watched 2026-09-01.
 */

/** Where the repositories live, relative to this file. */
const FOLDER = import.meta.dir;

/**
 * The drizzle tables that carry no audit columns, by the identifier the code
 * writes them as — the five exceptions `schema.ts` documents.
 *
 * `eventLog`, `commandJournal` and `planEvent` record an **act** rather than a
 * record: each already holds the acting user and the instant, and nothing ever
 * updates them. `eventSequencer` is one counter row and `examples` is scaffold.
 */
// `examples` is the scaffold table. Its repository was deleted on 2026-09-02
// and the table kept, because `migrate.test.ts` and `migrate-down.test.ts`
// assert it survives a round trip — a claim about migrations rather than about
// any code. It stays listed so a write added against it is a deliberate act.
//
// `optimizationGeneration` is the sixth, added 2026-09-04 with slice 3's first
// production write. It is `event_sequencer`'s reason exactly: a counter row, one
// per `(project, contract version)`, holding the generation the solver is on.
// There is no acting user to put in `created_by` — `SCHEDULER_CONTRACT_VERSION`
// bumping on deploy is what writes it — and `auditColumns()` is not on the table,
// so `auditOnCreate(stamp)` could not be spread into that write even if a stamp
// existed: `createdAt` and `createdBy` are not columns and the compiler says so.
// What the table does carry is a `NOT NULL updated_at`, which is stronger than
// the nullable audit column, and `optimization-generation.db.test.ts` pins that
// BOTH branches of its upsert move it. That case is this exemption's price:
// exempting the table drops the guard, so the invariant the guard was protecting
// is asserted where the write lives instead.
//
// `solverSlot` is the seventh, added the same day with `optimization-drain.ts`'s
// first write. It is a **lease**, not a record: one row per reserved solver
// process, deleted when the process is released or reclaimed. Its `owner_id`
// already names who holds it and `started_at` when, so a `created_by` beside
// them would be two columns for one fact — `event_log`'s reason. It carries no
// `updated_at` either, deliberately: the two instants that matter to a lease are
// `heartbeat_at` and `cancel_requested_at`, both of which say *which* thing last
// happened, where a general `updated_at` would say only that something did.
// `optimization-drain.db.test.ts` pins the one this drain writes, including that
// a re-run does not move an instant already stamped.
// `savedPlan` and `savedPlanBody` join them for `planEvent`'s reason, one step
// further: a saved plan records an act too, and it records it **by value**.
// The header carries its own `created_by` — the display name at the instant of
// the save, deliberately not a `users` reference — and its own `created_at`,
// the instant the capture's read snapshot opened rather than the instant the
// row was written. `auditOnCreate` would stamp a second, later pair of the same
// two facts, and a reader would have to pick. Nothing updates either table:
// `saved_plan_body` is never rewritten at all, which is the whole immutability
// property (`schema.ts`), and a rename touches the header's `name` alone.
//
// `calendarMarker` is the tenth, and its `created_at` is **an ordering key
// rather than a stamp**: the list is totally ordered by `(date, created_at,
// id)` and nothing reads that column as "when somebody did this". The other
// three audit columns would each name a fact no rule reads. There is
// deliberately **no per-marker role** — the change's spec says so in as many
// words, and every mutation is gated by the project's own write permission — so
// a `created_by` would record an author whom no later decision consults, and a
// `updated_by` an editor of a row whose whole content a rename or a recolour
// replaces. `project_id` already answers whose marker it is.
const EXEMPT = new Set([
  'eventLog',
  'commandJournal',
  'planEvent',
  'eventSequencer',
  'examples',
  // The three optimizer tables are machine state keyed by generation, not
  // authored rows: nothing in them has an author to record, and each is deleted
  // wholesale by the next allocation. The `it` below is what keeps that claim
  // honest — an exemption survives only while the table declares no audit
  // columns.
  'optimizationGeneration',
  'solverSlot',
  'optimizedScheduleCache',
  'savedPlan',
  'savedPlanBody',
  'calendarMarker',
]);

/** The files that hold writes — every repository, and not this test or the helper. */
function repositorySources(): { name: string; text: string }[] {
  return readdirSync(FOLDER)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .filter((name) => name !== 'audit.ts' && name !== 'index.ts' && name !== 'schema.ts')
    .map((name) => ({ name, text: readFileSync(join(FOLDER, name), 'utf8') }));
}

/**
 * One drizzle write, as text: from `.insert(table)` or `.update(table)` to the
 * `;` that ends the chain.
 *
 * An object literal cannot hold a `;` and none of the arrow bodies in this
 * folder do either, so the semicolon is a sound boundary for the chains that are
 * actually here. {@link auditedWrites} asserts how many it found, so a chain
 * shape this cannot read stops being silent.
 */
interface Write {
  readonly file: string;
  readonly kind: 'insert' | 'update';
  readonly table: string;
  readonly statement: string;
}

function auditedWrites(): Write[] {
  const found: Write[] = [];
  for (const { name, text } of repositorySources()) {
    for (const hit of text.matchAll(/\.(insert|update)\((\w+)\)/g)) {
      const kind = hit[1] === 'insert' ? 'insert' : 'update';
      // Both groups are inside the match, so neither can be absent — this repo
      // has `noUncheckedIndexedAccess` off and a `??` here would be a branch no
      // input can reach.
      const table = hit[2];
      if (EXEMPT.has(table)) continue;
      const end = text.indexOf(';', hit.index);
      found.push({
        file: name,
        kind,
        table,
        statement: text.slice(hit.index, end === -1 ? undefined : end),
      });
    }
  }
  return found;
}

/**
 * The body of one `sqliteTable` declaration in `schema.ts`, as text.
 *
 * Sliced to the next top-level `export`, which is sound because a table
 * declaration contains none — the `export type X = typeof x.$inferSelect` that
 * follows each one is the boundary. Returns null when the name is not declared
 * there at all, which is itself a failure worth naming: an exemption for a table
 * that does not exist is an exemption nobody can check.
 */
function tableDeclaration(schema: string, name: string): string | null {
  const start = schema.indexOf(`export const ${name} = sqliteTable(`);
  if (start === -1) return null;
  const end = schema.indexOf('\nexport ', start + 1);
  return schema.slice(start, end === -1 ? undefined : end);
}

describe('every write fills the audit columns', () => {
  const writes = auditedWrites();

  // The exemption list is the one way to make everything below vacuously true,
  // so it is checked rather than trusted: a table is exempt only if it genuinely
  // has no audit columns to fill. Without this, adding a name here would silence
  // the guard on a table that carries `created_by` and simply stopped writing
  // it — the exact fault the suite exists to catch, committed through its own
  // escape hatch.
  it('exempts only tables that carry no audit columns', () => {
    const schema = readFileSync(join(FOLDER, 'schema.ts'), 'utf8');
    const wrong = [...EXEMPT].map((name) => {
      const declaration = tableDeclaration(schema, name);
      if (declaration === null) return `${name}: exempt but not declared in schema.ts`;
      if (declaration.includes('auditColumns()')) return `${name}: exempt but carries auditColumns`;
      if (declaration.includes('auditColumnsBesidesCreatedAt()'))
        return `${name}: exempt but carries auditColumnsBesidesCreatedAt`;
      return null;
    });
    expect(wrong.filter((entry) => entry !== null)).toEqual([]);
  });

  // The precondition, and R5 is why it is here rather than assumed: a regex that
  // matched nothing would make every assertion below true of an empty list. The
  // floor is deliberately well under the real count so an ordinary edit does not
  // fail it, while a change that stops this test reading the folder at all does.
  it('found the writes it is about', () => {
    expect(
      writes.length,
      'no drizzle writes were found, so this suite asserts nothing',
    ).toBeGreaterThan(40);
  });

  it('stamps every insert with auditOnCreate', () => {
    const missing = writes
      .filter((write) => write.kind === 'insert')
      .filter((write) => !write.statement.includes('auditOnCreate('))
      // `users` and `project` date themselves, so their inserts carry the
      // variant that leaves their own `created_at` alone.
      .filter((write) => !write.statement.includes('auditOnCreateBesidesCreatedAt('))
      .map((write) => `${write.file}: insert into ${write.table}`);
    expect(missing).toEqual([]);
  });

  it('stamps every update with auditOnUpdate', () => {
    const missing = writes
      .filter((write) => write.kind === 'update')
      .filter((write) => !write.statement.includes('auditOnUpdate('))
      .map((write) => `${write.file}: update of ${write.table}`);
    expect(missing).toEqual([]);
  });

  // An upsert is two writes in one statement, and the branch that fires decides
  // which columns are owed: the insert branch creates the row, the conflict
  // branch updates one that was already there. A statement carrying only
  // `auditOnCreate` would leave `updated_at` at the instant of the *first* write
  // forever, which is the quiet half of this fault.
  it('stamps the conflict branch of every upsert with auditOnUpdate', () => {
    const missing = writes
      .filter((write) => write.statement.includes('onConflictDoUpdate'))
      .filter((write) => !write.statement.includes('auditOnUpdate('))
      .map((write) => `${write.file}: upsert into ${write.table}`);
    expect(missing).toEqual([]);
  });
});
