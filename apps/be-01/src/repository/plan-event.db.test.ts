import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { projectRow } from '../testing/project-fixture';
import { openDatabase, openDrizzle } from './db';
import { OPEN } from './gate';
import type { PlanEvent, Project, WriteStamp } from './index';
import { runMigrations } from './migrate';
import { PlanEventRepository } from './plan-event';
import { ProjectRepository } from './project';
import { UserRepository } from './user';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The stamp the setup's writes carry; `owner` is the account it creates first. */
const wrote: WriteStamp = { at: 1, by: 'owner' };

/**
 * The plan's history against real SQLite: what a reader gets, in what order, and
 * what the retention sweep takes.
 *
 * Rows are written through the raw handle rather than through the journal, on
 * purpose: what the *service* records is asserted in `service/plan-history.test.ts`,
 * and what the transaction guarantees in `command-journal.test.ts`. This file is
 * about the read and the prune, which are the two statements a caller of this
 * class ever reaches.
 */
describe('the plan’s history, against a real database', () => {
  let dir: string;
  let sqlite: Database;
  let events: PlanEventRepository;

  const project = (id: string, name: string): Project =>
    projectRow({
      id,
      name,
      ownerId: 'owner',
    });

  /** One recorded command, written the way `record` writes it. */
  function write(
    id: string,
    at: number,
    over: Partial<Omit<PlanEvent, 'id' | 'createdAt'>> = {},
  ): void {
    const row = {
      projectId: 'p1',
      userId: 'owner',
      kind: 'estimate',
      label: `estimate ${id}`,
      workItemId: 'w1' as string | null,
      stepId: 'r1' as string | null,
      before: { do: 'clear_estimate', workItemId: 'w1', stepId: 'r1' },
      after: { do: 'set_estimate', workItemId: 'w1', stepId: 'r1', days: { o: 1, r: 2, p: 3 } },
      ...over,
    };
    sqlite.run(
      'INSERT INTO plan_event (id, project_id, user_id, kind, label, work_item_id, step_id, before, after, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        row.projectId,
        row.userId,
        row.kind,
        row.label,
        row.workItemId,
        row.stepId,
        JSON.stringify(row.before),
        JSON.stringify(row.after),
        at,
      ],
    );
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-plan-event-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const db = openDrizzle(path);
    sqlite = openDatabase(path);
    events = new PlanEventRepository(db, OPEN);
    await new UserRepository(db, OPEN).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    const projects = new ProjectRepository(db, OPEN);
    await projects.create(project('p1', 'Rewire the shed'), [], wrote);
    await projects.create(project('p2', 'Reroof the barn'), [], wrote);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers one project’s events, newest first, and nobody else’s', async () => {
    write('a', 1_000);
    write('c', 3_000);
    write('b', 2_000);
    write('other', 9_000, { projectId: 'p2' });

    expect((await events.listFor('p1', {})).map((each) => each.id)).toEqual(['c', 'b', 'a']);
    // The other plan's event is the newest of the four and is not in that answer,
    // which is what makes the filter load-bearing rather than incidental.
    expect((await events.listFor('p2', {})).map((each) => each.id)).toEqual(['other']);
  });

  it('orders two events written in one millisecond by id, not by the order they were written', async () => {
    // `created_at` is milliseconds and a burst of commands shares one. Ordered by
    // id after it, so two reads of an unchanged plan cannot disagree.
    //
    // **Written `b` first and `a` second, and that is the whole of the test.**
    // With the rows inserted in id order the tie-break is unobservable: SQLite
    // walks the `(project_id, created_at)` index backwards for a `DESC` read and
    // hands back the later rowid first, which for `a` then `b` is `["b", "a"]` —
    // exactly what the tie-break asks for. That version passed with
    // `desc(planEvent.id)` struck: **7 pass, 0 fail**, watched 2026-08-17. Writing
    // them the other way round is what makes the two orders disagree.
    //
    // Proof, after that rewrite: `desc(planEvent.id)` removed from the `orderBy`,
    // and this fails on `["a", "b"]` where `["b", "a"]` was owed — the answer
    // following insertion order rather than any order the caller asked for.
    // Watched 2026-08-17.
    write('b', 5_000);
    write('a', 5_000);

    expect((await events.listFor('p1', {})).map((each) => each.id)).toEqual(['b', 'a']);
    expect((await events.listFor('p1', {})).map((each) => each.id)).toEqual(['b', 'a']);
  });

  it('narrows to one work item, and leaves the plan-wide events out of it', async () => {
    write('on-w1', 1_000);
    write('on-w2', 2_000, { workItemId: 'w2' });
    write('plan-wide', 3_000, { workItemId: null, stepId: null, kind: 'freeze' });

    expect((await events.listFor('p1', { workItemId: 'w1' })).map((each) => each.id)).toEqual([
      'on-w1',
    ]);
    // A row's history is that row's. The freeze belongs to the plan and is in the
    // unfiltered answer, which is the reading `PlanEventFilter` states.
    expect((await events.listFor('p1', {})).map((each) => each.id)).toEqual([
      'plan-wide',
      'on-w2',
      'on-w1',
    ]);
  });

  it('narrows to the kinds asked for, and reads a list naming nothing as no filter', async () => {
    write('set', 1_000);
    write('cleared', 2_000, { kind: 'clear_estimate' });
    write('renamed', 3_000, { kind: 'patch' });

    // The whole of "the history of estimate changes", in one request.
    expect(
      (await events.listFor('p1', { kinds: ['estimate', 'clear_estimate'] })).map(
        (each) => each.id,
      ),
    ).toEqual(['cleared', 'set']);
    // A kind nothing was recorded under is not an error; it is an empty history.
    expect(await events.listFor('p1', { kinds: ['actual'] })).toEqual([]);
    // And a list that names nothing is the same question as no filter at all,
    // rather than the SQL `IN ()` that answers nothing.
    expect((await events.listFor('p1', { kinds: [] })).map((each) => each.id)).toEqual([
      'renamed',
      'cleared',
      'set',
    ]);
  });

  it('hands back the two commands parsed, not the text they are stored as', async () => {
    write('a', 1_000);

    const [event] = await events.listFor('p1', {});
    expect(event.after).toEqual({
      do: 'set_estimate',
      workItemId: 'w1',
      stepId: 'r1',
      days: { o: 1, r: 2, p: 3 },
    });
    expect(event.before).toEqual({ do: 'clear_estimate', workItemId: 'w1', stepId: 'r1' });
  });

  it('throws on a stored command that is not JSON, rather than answering half a history', () => {
    // Malformed data in a column this process wrote is R5's "unknown is not OK",
    // and `asEntry` in `command-journal.ts` makes the identical call. A row read
    // as `null` would put a history on screen with a blank where a change was.
    sqlite.run(
      'INSERT INTO plan_event (id, project_id, user_id, kind, label, work_item_id, step_id, before, after, created_at)' +
        " VALUES ('bad', 'p1', 'owner', 'estimate', 'x', NULL, NULL, 'not json', '{}', 1)",
    );

    expect(events.listFor('p1', {})).rejects.toThrow();
  });

  it('prunes what is older than the cutoff, counts it, and leaves the rest', async () => {
    write('ancient', 1_000);
    write('old', 2_000);
    write('kept', 3_000);
    write('other-plan', 1_500, { projectId: 'p2' });

    // Every project's old events, in one statement: retention is about the table,
    // not about a plan somebody happens to be looking at.
    expect(await events.pruneOlderThan(3_000)).toBe(3);
    expect((await events.listFor('p1', {})).map((each) => each.id)).toEqual(['kept']);
    expect(await events.listFor('p2', {})).toEqual([]);
    // The cutoff is exclusive: an event written exactly at it stays. The boundary
    // is asserted because getting it wrong deletes a day of history silently.
    expect(await events.pruneOlderThan(3_000)).toBe(0);
    expect((await events.listFor('p1', {})).map((each) => each.id)).toEqual(['kept']);
  });
});
