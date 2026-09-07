import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { projectRow } from '../testing/project-fixture';
import { openDrizzle } from './db';
import { DirectoryRepository } from './directory';
import { OPEN } from './gate';
import type { Project, Step, WorkItem, WriteStamp } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { workItemExternalRef } from './schema';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let ownerId: string;
let repo: DirectoryRepository;
let workItems: WorkItemRepository;
let projectId: string;
let itemId: string;
let childId: string;
let db: ReturnType<typeof openDrizzle>;

/**
 * The stamp every write here carries. The account is the project's owner, which
 * the `created_by` foreign key requires to exist; the owner's own signup carries
 * it too, because a new account authors its own row.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

const newItem = (
  id: string,
  position: number,
  name: string,
  parentId: string | null,
): WorkItem => ({
  id,
  projectId,
  parentId,
  position,
  name,
  notes: '',
  frozenNumber: null,
  priority: null,
  startNoEarlierThan: null,
  serviceTeamId: null,
  serviceId: null,
  maxParallel: 1,
  startNoEarlierThanReason: null,
  deadline: null,
  revision: 0,
});

const JIRA = 'sys-jira-issue';
const GITHUB_PR = 'sys-github-pr';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-external-ref-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);
  repo = new DirectoryRepository(db, OPEN);
  workItems = new WorkItemRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );
  projectId = crypto.randomUUID();
  const project: Project = projectRow({
    id: projectId,
    ownerId,
  });
  const steps: Step[] = [{ id: crypto.randomUUID(), projectId, name: 'Dev', position: 10 }];
  await new ProjectRepository(db, OPEN).create(project, steps, wrote());

  itemId = crypto.randomUUID();
  childId = crypto.randomUUID();
  await workItems.insert(newItem(itemId, 10, 'Strip', null), [], wrote());
  await workItems.insert(newItem(childId, 10, 'Cladding', itemId), [], wrote());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a work item\u2019s external refs', () => {
  it('holds several refs into one system, because two PRs are two links', () => {
    // **Where this dimension stops resembling a label set.** `work_item_tag`'s
    // pair key makes a repeat a second answer to one question; a row may honestly
    // link to two different GitHub PRs, and a pair key would refuse the second.
    //
    // Proof: a `PRIMARY KEY(work_item_id, system_id)` put on the table in place
    // of the `id` key, watched 2026-08-30 failing with `UNIQUE constraint failed`
    // on the second ref.
    return (async () => {
      await workItems.patch(
        itemId,
        {
          externalRefs: [
            { systemId: GITHUB_PR, url: 'https://github.com/acme/shed/pull/1' },
            { systemId: GITHUB_PR, url: 'https://github.com/acme/shed/pull/2' },
          ],
        },
        wrote(),
      );

      const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
      expect(row?.externalRefs.map((each) => each.url)).toEqual([
        'https://github.com/acme/shed/pull/1',
        'https://github.com/acme/shed/pull/2',
      ]);
    })();
  });

  it('keeps the order the refs were added', async () => {
    // `position` is written by the append and the read orders by it. The rows go
    // in physically out of order — position 1 first — so rowid order and position
    // order disagree and the answer cannot come from insertion order by accident.
    //
    // **This assertion is a contract check, not a proof, and the distinction is
    // the point.** Two attempts were made to watch it fail. The first wrote the
    // refs through `patch`, which appends in array order, so rowid and position
    // always coincided and striking the `ORDER BY` was watched **passing**. The
    // second is the arrangement below — and striking the `ORDER BY` was watched
    // passing against that too, because `wier_by_work_item` is on
    // `(work_item_id, position)` and SQLite satisfies this read from that index,
    // which is *already* in position order.
    //
    // So the `ORDER BY` cannot be made to fail through any write this store
    // offers: the index answers the question before it is asked. It is kept
    // anyway, and this is the reasoning rather than a `Proof:` it has not earned
    // — SQLite contracts no row order without `ORDER BY`, and a later index change
    // (dropping `position` from it, or a planner choosing the `wier_by_system`
    // index) would silently scramble every ref list. What this case does prove is
    // that the read **is** in position order today, which is the behaviour a
    // reader depends on; what it cannot prove is which line delivers it.
    await db.insert(workItemExternalRef).values([
      {
        id: crypto.randomUUID(),
        workItemId: itemId,
        systemId: JIRA,
        url: 'https://acme.atlassian.net/browse/SHED-2',
        position: 1,
      },
      {
        id: crypto.randomUUID(),
        workItemId: itemId,
        systemId: JIRA,
        url: 'https://acme.atlassian.net/browse/SHED-1',
        position: 0,
      },
    ]);

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs.map((each) => each.url)).toEqual([
      'https://acme.atlassian.net/browse/SHED-1',
      'https://acme.atlassian.net/browse/SHED-2',
    ]);
  });

  it('writes ascending positions as the caller stated the list', async () => {
    // The other half of the pair above: the read orders by `position`, and this
    // is what makes `position` mean "where the caller put it".
    await workItems.patch(
      itemId,
      {
        externalRefs: [
          { systemId: JIRA, url: 'https://acme.atlassian.net/browse/SHED-9' },
          { systemId: GITHUB_PR, url: 'https://github.com/acme/shed/pull/1' },
        ],
      },
      wrote(),
    );

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs.map((each) => each.url)).toEqual([
      'https://acme.atlassian.net/browse/SHED-9',
      'https://github.com/acme/shed/pull/1',
    ]);
  });

  it('replaces the list whole, never merging', async () => {
    // Proof: the `tx.delete(workItemExternalRef)` removed so the write is
    // additive, watched 2026-08-30 failing on the removed ref coming back.
    await workItems.patch(
      itemId,
      {
        externalRefs: [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/SHED-1' }],
      },
      wrote(),
    );

    await workItems.patch(
      itemId,
      {
        externalRefs: [{ systemId: GITHUB_PR, url: 'https://github.com/acme/shed/pull/1' }],
      },
      wrote(),
    );

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs.map((each) => each.url)).toEqual([
      'https://github.com/acme/shed/pull/1',
    ]);
  });

  it('collapses the same URL twice, and only the same URL', async () => {
    // Deduplicated **by URL** and not by the pair: two refs into one system are
    // two links, and the only untidiness worth collapsing is the same address
    // stated twice. The schema refuses neither, so this is where it happens.
    await workItems.patch(
      itemId,
      {
        externalRefs: [
          { systemId: GITHUB_PR, url: 'https://github.com/acme/shed/pull/1' },
          { systemId: GITHUB_PR, url: 'https://github.com/acme/shed/pull/1' },
          { systemId: GITHUB_PR, url: 'https://github.com/acme/shed/pull/2' },
        ],
      },
      wrote(),
    );

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs).toHaveLength(2);
  });

  it('an empty list takes every ref off', async () => {
    await workItems.patch(
      itemId,
      {
        externalRefs: [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/SHED-1' }],
      },
      wrote(),
    );

    await workItems.patch(itemId, { externalRefs: [] }, wrote());

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs).toEqual([]);
  });

  it('a patch that does not name the refs leaves them alone', async () => {
    await workItems.patch(
      itemId,
      {
        externalRefs: [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/SHED-1' }],
      },
      wrote(),
    );

    await workItems.patch(itemId, { name: 'Strip the walls' }, wrote());

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs).toHaveLength(1);
  });

  it('a patch naming only the refs is written, not swallowed by the no-field branch', async () => {
    // Proof: `patch.externalRefs === undefined` removed from the no-field
    // condition, watched 2026-08-30 failing on the written list coming back
    // empty — a patch that answers `ok` having written nothing. The tag line's
    // own red, a third time in that one condition.
    const outcome = await workItems.patch(
      itemId,
      {
        externalRefs: [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/SHED-1' }],
      },
      wrote(),
    );

    expect(outcome.ok).toBe(true);
    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs).toHaveLength(1);
  });

  it('refuses a ref naming a system the directory does not hold, and writes nothing', async () => {
    // Decided inside the write's transaction: `system_id` cascades, so a system
    // removed between a precheck and the write leaves nothing for a foreign key
    // to catch, and the refusal must name the system rather than be a 500.
    //
    // Proof: the `unknown_system` check removed, watched 2026-08-30 failing with
    // `SQLiteError: FOREIGN KEY constraint failed` in place of the refusal.
    const outcome = await workItems.patch(
      itemId,
      {
        name: 'Renamed',
        externalRefs: [{ systemId: 'sys-nobody-has-this', url: 'https://example.com/x' }],
      },
      wrote(),
    );

    expect(outcome).toEqual({ ok: false, reason: 'unknown_system' });
    // The **whole** patch, which is the half a reader loses if the refusal lands
    // after the other fields are written.
    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.name).toBe('Strip');
    expect(row?.externalRefs).toEqual([]);
  });

  it('mints its own ref ids, never taking one from the caller', async () => {
    // A ref's identity is the store's. Accepting a caller's id would let a client
    // rewrite another row's ref by naming its id.
    await workItems.patch(
      itemId,
      {
        externalRefs: [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/SHED-1' }],
      },
      wrote(),
    );

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    const minted = row?.externalRefs[0]?.id;
    expect(typeof minted).toBe('string');
    expect(minted).not.toBe(JIRA);
  });

  it('stores the system it was given, and never re-derives it on read', async () => {
    // Design D1, and the change's one irreversible-by-accident rule. A reader may
    // override the derived type — `systemOfUrl` would call this GitHub, and the
    // ref is stored as Jira because that is what the write said.
    //
    // Proof: the read path made to call `systemOfUrl(url)` instead of returning
    // the stored `system_id`, watched 2026-08-30 failing on `github-pr` coming
    // back where `sys-jira-issue` was written.
    await workItems.patch(
      itemId,
      {
        externalRefs: [{ systemId: JIRA, url: 'https://github.com/acme/shed/pull/1' }],
      },
      wrote(),
    );

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.externalRefs[0]?.systemId).toBe(JIRA);
  });

  it('lets the outgoing release keep deleting work items against the migrated schema', async () => {
    // Blue and green share one SQLite file while green migrates, and the outgoing
    // release knows nothing about `work_item_external_ref`. Its plain
    // `DELETE FROM work_item` must not hit a constraint it cannot see.
    //
    // Proof: `ON DELETE CASCADE` struck from `work_item_id`, watched 2026-08-30
    // failing with `FOREIGN KEY constraint failed`.
    await workItems.patch(
      childId,
      {
        externalRefs: [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/SHED-1' }],
      },
      wrote(),
    );

    await workItems.remove([childId], [], wrote());

    expect((await workItems.listByProject(projectId)).map((each) => each.id)).toEqual([itemId]);
  });

  it('seeds every system the deriver can answer', async () => {
    // The seed and `systemOfUrl`'s pattern list are one fact — a URL that derives
    // a name this table does not hold is a paste that types itself and then fails
    // to store. `external-system.test.ts` asserts the two agree by reading the
    // migration; this asserts the migration actually ran.
    expect((await repo.listExternalSystems()).map((each) => each.name)).toEqual([
      'confluence-page',
      'github-issue',
      'github-pr',
      'jira-issue',
      'slack-message',
    ]);
  });
});
