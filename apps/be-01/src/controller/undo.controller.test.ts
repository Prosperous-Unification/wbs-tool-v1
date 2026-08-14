import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { RoleRepository } from '../repository/role';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { AuthService } from '../service/auth.service';
import { ProjectService } from '../service/project.service';
import { RoleService } from '../service/role.service';
import { WorkItemService } from '../service/work-item.service';
import { TEST_JWT_KEY } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity, testCapacityService } from '../testing/capacity-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testReplay } from '../testing/replay-fixture';

/**
 * The undo and redo routes, **over real SQLite**.
 *
 * Every other controller test here runs on the in-memory stores, which model
 * no revisions at all — so a `stale_undo` asserted against them would be
 * asserted against a counter that never moves, and would pass with the whole
 * precondition check deleted. The status codes are the point of this file and
 * they are all decided by the revision comparison, so it runs against the
 * database that actually does the comparing.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let app: ReturnType<typeof buildApp>;
/**
 * The same journal the app writes through, kept so a test can read the stack
 * it left behind rather than infer it from what undo happens to answer.
 */
let journal: CommandJournalRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-undo-http-'));
  const db = openDrizzle(join(dir, 'test.db'));
  runMigrations(join(dir, 'test.db'), FOLDER);
  journal = new CommandJournalRepository(db);

  const projects = new ProjectRepository(db);
  const workItems = new WorkItemRepository(db);
  const estimates = new EstimateRepository(db);
  const dependencies = new DependencyRepository(db);
  const directory = new DirectoryRepository(db);

  app = buildApp({
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    auth: new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY }),
    projects: new ProjectService({ projects }),
    roles: new RoleService({
      projects,
      roles: new RoleRepository(db),
      broadcast: recordingBroadcaster(),
    }),
    workItems: new WorkItemService({
      workItems,
      projects,
      estimates,
      dependencies,
      directory,
      capacity: inMemoryCapacity(),
      priorityBands: inMemoryPriorityBands(),
      subtrees: new SubtreeRepository(db),
      journal,
      broadcast: recordingBroadcaster(),
    }),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    migrationsApplied: true,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function registerAccount(username: string): Promise<{ token: string; userId: string }> {
  const res = await app.handle(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct-horse' }),
    }),
  );
  const account = (await res.json()) as { token: string; user: { id: string } };
  return { token: account.token, userId: account.user.id };
}

async function register(username: string): Promise<string> {
  return (await registerAccount(username)).token;
}

function send(
  path: string,
  token: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-wbs-token': token },
    }),
  );
}

async function newProject(token: string, name = 'Rewire the shed'): Promise<string> {
  const created = await send('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return ((await created.json()) as { project: { id: string } }).project.id;
}

async function addRoot(token: string, projectId: string, name: string): Promise<string> {
  const created = await send(`/api/projects/${projectId}/work-items`, token, {
    method: 'POST',
    body: JSON.stringify({ parentId: null, afterId: null, name }),
  });
  return ((await created.json()) as { id: string }).id;
}

describe('POST /api/projects/:id/undo', () => {
  it('turns an anonymous request away before it reaches the stack', async () => {
    const token = await register('owner');
    const projectId = await newProject(token);

    const res = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}/undo`, { method: 'POST' }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('answers 404 for a project that does not exist', async () => {
    const token = await register('owner');

    const res = await send(`/api/projects/${crypto.randomUUID()}/undo`, token, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 403 to somebody who may read the project but not write to it', async () => {
    const owner = await register('owner');
    const stranger = await register('stranger');
    const projectId = await newProject(owner);
    await send(`/api/projects/${projectId}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const res = await send(`/api/projects/${projectId}/undo`, stranger, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('answers 409 nothing_to_undo on an untouched project', async () => {
    const token = await register('owner');
    const projectId = await newProject(token);

    const res = await send(`/api/projects/${projectId}/undo`, token, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nothing_to_undo', detail: null });
  });

  it('answers what it undid, so the screen can say it', async () => {
    const token = await register('owner');
    const projectId = await newProject(token);
    const strip = await addRoot(token, projectId, 'Strip');
    await send(`/api/work-items/${strip}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Strip out' }),
    });

    const res = await send(`/api/projects/${projectId}/undo`, token, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: 'rename “Strip out”', detail: null });
  });

  it('answers 409 stale_undo naming what moved, and undoes nothing', async () => {
    const owner = await register('owner');
    const stranger = await register('stranger');
    const projectId = await newProject(owner);
    const strip = await addRoot(owner, projectId, 'Strip');
    await send(`/api/work-items/${strip}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Mine' }),
    });
    await send(`/api/work-items/${strip}`, stranger, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Theirs' }),
    });

    const res = await send(`/api/projects/${projectId}/undo`, owner, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('stale_undo');
    expect(body.detail).toContain('Theirs');

    const tree = await send(`/api/projects/${projectId}/work-items`, owner);
    const names = ((await tree.json()) as { workItems: { name: string }[] }).workItems.map(
      (each) => each.name,
    );
    expect(names).toEqual(['Theirs']);
  });
});

describe('POST /api/projects/:id/redo', () => {
  it('answers 409 nothing_to_undo until something has been undone', async () => {
    const token = await register('owner');
    const projectId = await newProject(token);
    await addRoot(token, projectId, 'Strip');

    const res = await send(`/api/projects/${projectId}/redo`, token, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nothing_to_undo', detail: null });
  });

  it('puts back what the undo took away', async () => {
    const token = await register('owner');
    const projectId = await newProject(token);
    const strip = await addRoot(token, projectId, 'Strip');
    await send(`/api/work-items/${strip}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Strip out' }),
    });
    await send(`/api/projects/${projectId}/undo`, token, { method: 'POST' });

    const res = await send(`/api/projects/${projectId}/redo`, token, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: 'rename “Strip out”', detail: null });
  });
});

describe('what the tree read says about the stack', () => {
  it('carries undoable and redoable for the account reading it', async () => {
    const owner = await register('owner');
    const stranger = await register('stranger');
    const projectId = await newProject(owner);
    await addRoot(owner, projectId, 'Strip');

    const mine = await send(`/api/projects/${projectId}/work-items`, owner);
    expect(await mine.json()).toMatchObject({ undoable: true, redoable: false });

    // Somebody who has changed nothing here has nothing to undo, however much
    // anybody else has done. The stack is per account.
    const theirs = await send(`/api/projects/${projectId}/work-items`, stranger);
    expect(await theirs.json()).toMatchObject({ undoable: false, redoable: false });
  });

  it('reports something to redo once something has been undone', async () => {
    const token = await register('owner');
    const projectId = await newProject(token);
    await addRoot(token, projectId, 'Strip');
    await send(`/api/projects/${projectId}/undo`, token, { method: 'POST' });

    const tree = await send(`/api/projects/${projectId}/work-items`, token);

    expect(await tree.json()).toMatchObject({ undoable: false, redoable: true });
  });
});

/**
 * What the front end's Name cell sends, arriving here as one request.
 *
 * The fe-01 test that proves the cell sends one `patch` proves one HTTP call
 * and stops there — codex round 1, finding 3. Whether one call is one entry on
 * the undo stack, and whether one press of Cmd+Z brings both fields back
 * together, is decided by this service, this journal and this route, so it is
 * asked of them.
 */
describe('PATCH /api/work-items/:id with a name and its notes at once', () => {
  it('writes one journal entry, and one undo puts both fields back', async () => {
    const { token, userId } = await registerAccount('owner');
    const projectId = await newProject(token);
    const strip = await addRoot(token, projectId, 'Strip');
    await send(`/api/work-items/${strip}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'measure twice' }),
    });
    // The stack as the composite edit finds it: the row's creation and the
    // note written under it, both this account's.
    expect((await journal.entriesFor(projectId, userId)).map((each) => each.kind)).toEqual([
      'create',
      'patch',
    ]);

    // Both fields, one gesture, one request — what `commitNameCell` sends when
    // somebody rewrites a line and the note under it before leaving the cell.
    const patched = await send(`/api/work-items/${strip}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Strip the wiring', notes: 'measure twice, cut once' }),
    });
    expect(patched.status).toBe(200);

    // Proof: the same edit sent as two requests instead — `{ name }`, then
    // `{ notes }` — this failed here on a fourth entry (`Expected - 0 /
    // Received + 1`, the extra `"patch"`), and with this assertion taken out
    // it failed further down on `Expected: "Strip" / Received: "Strip the
    // wiring"`: one undo, one field, one Cmd+Z short. Watched, 2026-08-08.
    expect((await journal.entriesFor(projectId, userId)).map((each) => each.kind)).toEqual([
      'create',
      'patch',
      'patch',
    ]);

    const undone = await send(`/api/projects/${projectId}/undo`, token, { method: 'POST' });
    expect(undone.status).toBe(200);

    // Proof: `revertTo`'s `if (patch.notes !== undefined) out.notes =
    // before.notes` deleted in `work-item.service.ts`, this failed on
    // `Expected: "measure twice" / Received: "measure twice, cut once"` — an
    // undo that put the name back and left the note where nobody asked for it.
    // Watched, 2026-08-08.
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const rows = ((await tree.json()) as { workItems: { name: string; notes: string }[] })
      .workItems;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Strip');
    expect(rows[0]?.notes).toBe('measure twice');
  });
});
