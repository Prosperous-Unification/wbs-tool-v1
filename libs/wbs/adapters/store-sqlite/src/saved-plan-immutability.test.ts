import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

/**
 * No `UPDATE` ever targets `saved_plan_body`, and none targets any `saved_plan`
 * column except `name`.
 *
 * This is the immutability property of a saved plan, and a comment cannot hold
 * it. `openspec/changes/saved-plans/design.md`, "Integrity is checked, not
 * assumed": a hash that nothing recomputes is a comment, and hashes that can be
 * rewritten are worse than none — `schedule_input_sha256 = input_sha256` is the
 * check that stops a schedule being rendered against an input it was not
 * computed from, and one `UPDATE` of that column satisfies it for a schedule
 * computed from a different input. So the guard covers the **header** as well
 * as the bodies; scoping it to `saved_plan_body` alone would leave the whole
 * hash set rewritable.
 *
 * `name` is the one exception and it is deliberate: a save writes immediately
 * with the server timestamp as the default name (assumption A-1) and naming it
 * is an edit afterwards, permissioned like delete and touching nothing else.
 *
 * A source check in the shape of `audit.test.ts`, for its reasons: a required
 * parameter proves arrival and not use, and the esquery selector this would
 * need does not exist. What it does not cover is the same as there — it reads
 * text, so a write assembled across two statements or naming its table through
 * a variable is invisible to it.
 *
 * Unlike `audit.test.ts` the negatives here are not a hand-watched note.
 * {@link updatesOf} is a pure function over (file, text) pairs, so the two the
 * task asks for are run on every invocation, as arguments, below.
 */

const FOLDER = import.meta.dir;

interface Update {
  readonly file: string;
  readonly table: string;
  readonly statement: string;
}

interface Source {
  readonly name: string;
  readonly text: string;
}

/**
 * Every `.update(<table>)` chain in the given sources, as text: from the call to
 * the `;` that ends the chain.
 *
 * An object literal cannot hold a `;`, which is what makes the semicolon a sound
 * boundary for the chain shapes this folder writes — the same reasoning, and the
 * same limitation, as `audit.test.ts`.
 */
function updatesOf(sources: readonly Source[]): Update[] {
  const found: Update[] = [];
  for (const { name, text } of sources) {
    for (const hit of text.matchAll(/\.update\((\w+)\)/g)) {
      const end = text.indexOf(';', hit.index);
      found.push({
        file: name,
        table: hit[1],
        statement: text.slice(hit.index, end === -1 ? undefined : end),
      });
    }
  }
  return found;
}

/**
 * The columns a `.set({ … })` in the given chain names.
 *
 * Shorthand counts: `set({ inputSha256 })` writes the same column as
 * `set({ inputSha256: hash })`, so the key is matched up to a `:` **or** a comma
 * or the end of the object, and not to a colon alone.
 */
function columnsSet(statement: string): string[] {
  const set = /\.set\(\{([\s\S]*?)\}\)/.exec(statement);
  if (set === null) return [];
  return [...set[1].matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*(?=[:,]|$)/g)].map((hit) => hit[1]);
}

/**
 * The offences in one set of sources: an update of `savedPlanBody` at all, or an
 * update of `savedPlan` naming any column but `name`.
 */
function immutabilityOffences(sources: readonly Source[]): string[] {
  return updatesOf(sources).flatMap((update) => {
    if (update.table === 'savedPlanBody') return [`${update.file}: update of saved_plan_body`];
    if (update.table !== 'savedPlan') return [];
    return columnsSet(update.statement)
      .filter((column) => column !== 'name')
      .map((column) => `${update.file}: update of saved_plan.${column}`);
  });
}

/** Every repository source, minus this test, the schema and the barrel. */
function repositorySources(): Source[] {
  return readdirSync(FOLDER)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .filter((name) => name !== 'index.ts' && name !== 'schema.ts')
    .map((name) => ({ name, text: readFileSync(join(FOLDER, name), 'utf8') }));
}

describe('a saved plan is never rewritten', () => {
  // The precondition, and R5 is why it is stated rather than assumed: a check
  // that read no files would make the assertion below true of nothing. The
  // floor is well under the real count so an ordinary edit does not fail it,
  // while a change that stops this reading the folder does.
  it('reads the repository folder', () => {
    expect(
      repositorySources().length,
      'no repository sources were read, so this suite asserts nothing',
    ).toBeGreaterThan(10);
  });

  it('no UPDATE targets saved_plan_body, and none targets saved_plan except name', () => {
    expect(immutabilityOffences(repositorySources())).toEqual([]);
  });

  /**
   * The two watched negatives the task names, run as arguments rather than
   * recorded as a note somebody once observed. Without these the assertion
   * above is green today for the uninteresting reason that no saved-plan
   * repository exists yet, and it would stay green if the scanner broke before
   * one did.
   */
  it('catches an update of saved_plan_body', () => {
    expect(
      immutabilityOffences([
        {
          name: 'saved-plan.ts',
          text: `await db.update(savedPlanBody).set({ bytes: next }).where(eq(savedPlanBody.savedPlanId, id));`,
        },
      ]),
    ).toEqual(['saved-plan.ts: update of saved_plan_body']);
  });

  it('catches an update of a saved_plan hash', () => {
    expect(
      immutabilityOffences([
        {
          name: 'saved-plan.ts',
          text: `await db.update(savedPlan).set({ inputSha256: hash }).where(eq(savedPlan.id, id));`,
        },
      ]),
    ).toEqual(['saved-plan.ts: update of saved_plan.inputSha256']);
  });

  it('catches a hash smuggled in beside a rename', () => {
    expect(
      immutabilityOffences([
        {
          name: 'saved-plan.ts',
          text: `await db.update(savedPlan).set({ name, scheduleInputSha256: hash }).where(eq(savedPlan.id, id));`,
        },
      ]),
    ).toEqual(['saved-plan.ts: update of saved_plan.scheduleInputSha256']);
  });

  it('catches a hash written in shorthand', () => {
    expect(
      immutabilityOffences([
        {
          name: 'saved-plan.ts',
          text: `await db.update(savedPlan).set({ inputSha256 }).where(eq(savedPlan.id, id));`,
        },
      ]),
    ).toEqual(['saved-plan.ts: update of saved_plan.inputSha256']);
  });

  it('allows the rename, which is the one exception', () => {
    expect(
      immutabilityOffences([
        {
          name: 'saved-plan.ts',
          text: `await db.update(savedPlan).set({ name }).where(eq(savedPlan.id, id));`,
        },
      ]),
    ).toEqual([]);
  });
});
