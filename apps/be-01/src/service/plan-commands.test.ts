import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Role } from '../repository';
import { ActualRepository } from '../repository/actual';
import { CapacityRepository } from '../repository/capacity';
import { CommandJournalRepository } from '../repository/command-journal';
import { drizzleOuterTransaction, openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { PlanEventRepository } from '../repository/plan-event';
import { PriorityBandRepository } from '../repository/priority-band';
import { ProjectRepository } from '../repository/project';
import { RoleMeasureRepository } from '../repository/role-measure';
import { RoleProgressRepository } from '../repository/role-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository } from '../repository/work-item';
import { WorkItemRepository } from '../repository/work-item';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import type { Broadcaster } from './broadcast';
import { CapacityService } from './capacity.service';
import { DirectoryService } from './directory.service';
import type { PlanCommand } from './plan-command';
import {
  type BatchOutcome,
  PlanCommandRunner,
  type PlanCommandRunnerOptions,
} from './plan-commands';
import { PriorityBandService } from './priority-band.service';
import { ProjectService } from './project.service';
import { WorkItemService, type WorkItemServiceOptions } from './work-item.service';
import { WriteLock } from './write-lock';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let runner: PlanCommandRunner;
let runnerOptions: PlanCommandRunnerOptions;
let serviceOptions: WorkItemServiceOptions;
let workItems: WorkItemService;
let workItemStore: WorkItemRepository;
let estimateStore: EstimateRepository;
let dependencyStore: DependencyRepository;
let directoryStore: DirectoryRepository;
let journalStore: CommandJournalRepository;
let planEvents: PlanEventRepository;
let projectId: string;
let ownerId: string;
let roles: Role[];

const dev = (): string => {
  const found = roles.at(0);
  if (found === undefined) throw new Error('the project was created without its starting roles');
  return found.id;
};
const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-batch-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  const projectStore = new ProjectRepository(db);
  workItemStore = new WorkItemRepository(db);
  estimateStore = new EstimateRepository(db);
  dependencyStore = new DependencyRepository(db);
  directoryStore = new DirectoryRepository(db);
  journalStore = new CommandJournalRepository(db);
  planEvents = new PlanEventRepository(db);
  const capacityStore = new CapacityRepository(db);
  const bandStore = new PriorityBandRepository(db);
  const broadcast = recordingBroadcaster();

  ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });

  serviceOptions = {
    workItems: workItemStore,
    projects: projectStore,
    estimates: estimateStore,
    actuals: new ActualRepository(db),
    measures: new RoleMeasureRepository(db),
    progress: new RoleProgressRepository(db),
    directory: directoryStore,
    capacity: capacityStore,
    priorityBands: bandStore,
    dependencies: dependencyStore,
    subtrees: new SubtreeRepository(db),
    journal: journalStore,
    broadcast,
  };
  workItems = new WorkItemService(serviceOptions);
  runnerOptions = {
    workItems,
    directory: new DirectoryService({ directory: directoryStore, broadcast }),
    capacity: new CapacityService({ projects: projectStore, capacity: capacityStore, broadcast }),
    priorityBands: new PriorityBandService({ projects: projectStore, bands: bandStore, broadcast }),
    transactions: drizzleOuterTransaction(db),
    lock: new WriteLock(),
  };
  runner = new PlanCommandRunner(runnerOptions);
  const created = await new ProjectService({ projects: projectStore }).create(
    'Rewire the shed',
    ownerId,
  );
  projectId = created.project.id;
  roles = created.roles;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (commands: PlanCommand[]): Promise<BatchOutcome> =>
  runner.run(projectId, ownerId, commands);

function applied(outcome: BatchOutcome): Map<string, string> {
  if (!outcome.ok) throw new Error(`refused at ${String(outcome.at)}: ${outcome.reason}`);
  return new Map(
    outcome.results.flatMap((each) =>
      each.ref !== undefined && each.id !== undefined ? [[each.ref, each.id]] : [],
    ),
  );
}

const names = async (): Promise<string[]> =>
  (await workItemStore.listByProject(projectId)).map((row) => row.name).sort();

const journal = () => journalStore.entriesFor(projectId, ownerId);

const DRAFT: PlanCommand[] = [
  { kind: 'createWorkItem', ref: 'strip', parentId: null, afterId: null, name: 'Strip' },
  { kind: 'createWorkItem', ref: 'sand', parentId: null, afterRef: 'strip', name: 'Sand' },
  { kind: 'createWorkItem', ref: 'paint', parentId: null, afterRef: 'sand', name: 'Paint' },
  { kind: 'setEstimate', ref: undefined, workItemRef: 'strip', roleId: 'ROLE', days: DAYS },
  { kind: 'setEstimate', workItemRef: 'sand', roleId: 'ROLE', days: DAYS },
  { kind: 'addDependency', workItemRef: 'sand', predecessorRef: 'strip' },
];
/** The draft with the project's real Dev role in place of the placeholder. */
const draft = (): PlanCommand[] =>
  DRAFT.map((command) =>
    'roleId' in command && command.roleId === 'ROLE' ? { ...command, roleId: dev() } : command,
  );

describe('a command batch', () => {
  it('drafts a plan in one request, and answers the id each ref became', async () => {
    const refs = applied(await run(draft()));
    expect([...refs.keys()].sort()).toEqual(['paint', 'sand', 'strip']);
    expect(await names()).toEqual(['Paint', 'Sand', 'Strip']);
    expect(
      (await estimateStore.listByProject(projectId)).map((each) => each.workItemId).sort(),
    ).toEqual([refs.get('sand'), refs.get('strip')].sort());
    expect(await dependencyStore.listByProject(projectId)).toHaveLength(1);
  });

  it('leaves the first two unwritten when the third is refused', async () => {
    // All or none, on real SQLite: the two creates before the refused estimate
    // are rolled back with it.
    // Proof: the runner's `rollback` replaced by `commit`, this failed on
    // `expected [ 'Sand', 'Strip' ] to equal []`. Watched, 2026-08-29.
    const outcome = await run([
      ...draft().slice(0, 2),
      { kind: 'setEstimate', workItemRef: 'strip', roleId: 'no-such-role', days: DAYS },
    ]);
    expect(outcome).toEqual({ ok: false, at: 2, kind: 'setEstimate', reason: 'unknown_role' });
    expect(await names()).toEqual([]);
    expect(await journal()).toHaveLength(0);
  });

  it('is one journal entry, one plan event, and one undo puts all of it back', async () => {
    // Proof: the collector bypassed so `record` wrote per step, this failed on
    // `expected 6 to be 1`. Watched, 2026-08-29.
    applied(await run(draft()));
    expect(await journal()).toHaveLength(1);
    expect(await planEvents.listFor(projectId, {})).toHaveLength(1);

    const undone = await runner.undo(projectId, ownerId);
    if (!undone.ok) throw new Error(`undo refused: ${undone.reason} ${undone.detail ?? ''}`);
    expect(await names()).toEqual([]);
    expect(await estimateStore.listByProject(projectId)).toHaveLength(0);
    expect(await dependencyStore.listByProject(projectId)).toHaveLength(0);

    const redone = await runner.redo(projectId, ownerId);
    if (!redone.ok) throw new Error(`redo refused: ${redone.reason} ${redone.detail ?? ''}`);
    expect(await names()).toEqual(['Paint', 'Sand', 'Strip']);
  });

  it('takes back the steps an undo already applied when a later step cannot', async () => {
    // A journal entry as the runner writes one, whose inverse renames X and
    // then sets an estimate for a role nobody has: the preconditions hold, so
    // the first step is applied before the second is refused — and the rename
    // must be gone again, or an undo has left a plan nobody asked for. The
    // entry is appended by hand because every natural way of making a later
    // step fail also moves a revision, and then the staleness check refuses
    // before any step runs (watched: `“A” has changed since then`).
    // Proof: `walk` made to commit on a refusal, this failed on `expected
    // 'Undone' to be 'X'`; the per-step refusal dropped from `apply`'s batch
    // arm, on `expected true to be false` — the undo reported done. Watched,
    // 2026-08-29.
    const refs = applied(
      await run([{ kind: 'createWorkItem', ref: 'x', parentId: null, afterId: null, name: 'X' }]),
    );
    const x = refs.get('x');
    if (x === undefined) throw new Error('no x');
    const row = await workItemStore.findById(x);
    if (row === null) throw new Error('x is not stored');
    const rename = { do: 'patch' as const, workItemId: x, patch: { name: 'Undone' } };
    const impossible = {
      do: 'set_estimate' as const,
      workItemId: x,
      roleId: 'no-such-role',
      days: DAYS,
    };
    const at = Date.now();
    await journalStore.append(
      {
        id: crypto.randomUUID(),
        projectId,
        userId: ownerId,
        kind: 'batch',
        payload: { label: '2 changes', forward: { do: 'batch', steps: [impossible, rename] } },
        inverse: { do: 'batch', steps: [rename, impossible] },
        preconditions: { expected: { [x]: row.revision }, from: { [x]: row.revision } },
        createdAt: at,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        userId: ownerId,
        kind: 'batch',
        label: '2 changes',
        workItemId: x,
        roleId: null,
        before: { do: 'batch', steps: [rename, impossible] },
        after: { do: 'batch', steps: [impossible, rename] },
        createdAt: at,
      },
    );

    const undone = await runner.undo(projectId, ownerId);
    expect(undone.ok).toBe(false);
    if (undone.ok) throw new Error('an undo naming a missing role was accepted');
    expect(undone.reason).toBe('stale_undo');
    expect(undone.detail).toBe('that phase is no longer in this project.');
    expect((await workItemStore.findById(x))?.name).toBe('X');
    // And the entry is gone for good, discarded outside the rolled-back
    // transaction: only the create is left to undo.
    expect(await journal()).toHaveLength(1);
  });

  it('records a batch of one as that command, not as a batch', async () => {
    const refs = applied(await run(draft()));
    const strip = refs.get('strip');
    if (strip === undefined) throw new Error('no strip');
    applied(await run([{ kind: 'patchWorkItem', workItemId: strip, patch: { name: 'Strip it' } }]));
    const [, rename] = await journal();
    expect(rename.kind).toBe('patch');
    expect(rename.payload).toMatchObject({ label: 'rename “Strip it”' });
  });

  it('records nothing for a batch that changed nothing', async () => {
    const refs = applied(await run(draft()));
    const paint = refs.get('paint');
    if (paint === undefined) throw new Error('no paint');
    applied(await run([{ kind: 'clearEstimate', workItemId: paint, roleId: dev() }]));
    expect(await journal()).toHaveLength(1);
  });

  it('refuses a ref nobody minted, and a ref minted twice, before applying anything', async () => {
    // Proof: ref substitution removed, the first case failed on `expected
    // { ok: false, at: 0, kind: 'createWorkItem', reason: 'unknown_ref' } …` —
    // the create went through with the literal word as its parent id and was
    // refused as `not_found` instead. Watched, 2026-08-29.
    expect(
      await run([{ kind: 'createWorkItem', parentRef: 'nope', afterId: null, name: 'Orphan' }]),
    ).toEqual({ ok: false, at: 0, kind: 'createWorkItem', reason: 'unknown_ref' });
    expect(
      await run([
        { kind: 'createWorkItem', ref: 'a', parentId: null, afterId: null, name: 'A' },
        { kind: 'createWorkItem', ref: 'a', parentId: null, afterId: null, name: 'B' },
      ]),
    ).toEqual({ ok: false, at: 1, kind: 'createWorkItem', reason: 'duplicate_ref' });
    expect(await names()).toEqual([]);
  });

  it('applies directory commands inside the batch, and undo leaves them in place', async () => {
    const refs = applied(
      await run([
        { kind: 'createService', ref: 'checkout', name: 'Checkout' },
        { kind: 'createWorkItem', ref: 'w', parentId: null, afterId: null, name: 'Pay' },
        { kind: 'patchWorkItem', workItemRef: 'w', patch: { serviceRefs: ['checkout'] } },
      ]),
    );
    expect(refs.has('checkout')).toBe(true);
    const undone = await runner.undo(projectId, ownerId);
    if (!undone.ok) throw new Error(`undo refused: ${undone.reason}`);
    expect(await names()).toEqual([]);
    expect((await directoryStore.listServices()).map((each) => each.name)).toEqual(['Checkout']);
  });

  it('answers a directory create with the entry, and a taken name with the survivor', async () => {
    // The browser's `addTag` answers with the row and its `renameTag` models
    // `taken` by the surviving name; both ride on the batch result rather than
    // costing a second read.
    const outcome = await run([{ kind: 'createTag', ref: 't', name: 'regulatory' }]);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.results[0]?.entity).toMatchObject({ name: 'regulatory' });
    const tagId = outcome.results[0]?.id;
    if (tagId === undefined) throw new Error('no tag id');
    applied(await run([{ kind: 'createTag', name: 'legal' }]));
    expect(await run([{ kind: 'patchTag', tagId, name: 'legal' }])).toEqual({
      ok: false,
      at: 0,
      kind: 'patchTag',
      reason: 'taken',
      detail: { name: 'legal' },
    });
  });

  it('applies a directory-only batch with no project, and refuses a plan command in it', async () => {
    // The directory page has no project; its writes go through `runDirectory`,
    // which holds the same lock and transaction and records nothing. A plan
    // command has no project to land in there and is refused by index.
    const outcome = await runner.runDirectory(ownerId, [
      { kind: 'createTeam', ref: 'platform', name: 'Platform' },
      { kind: 'createPerson', ref: 'kat', name: 'Kat', teamRefs: ['platform'] },
    ]);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.results.map((each) => each.ref)).toEqual(['platform', 'kat']);
    expect((await directoryStore.listTeams()).map((each) => each.name)).toEqual(['Platform']);
    expect(await journal()).toHaveLength(0);

    expect(
      await runner.runDirectory(ownerId, [
        { kind: 'createTag', name: 'x' },
        { kind: 'createWorkItem', name: 'Orphan' },
      ]),
    ).toEqual({ ok: false, at: 1, kind: 'createWorkItem', reason: 'project_required' });
    // All or none here too: the tag went with the refusal.
    expect(await directoryStore.listTags()).toHaveLength(0);
  });

  it('lets go of the write lock before the broadcast leaves', async () => {
    // The lock is for the one connection; a push to gw-01 is a network call,
    // and holding the lock across it would let one slow gateway stall every
    // write in the process. Batch A's publish is held open here; batch B must
    // still apply while it is pending.
    // Proof: with `announceTreeNow` inside `lock.run` (the shape this shipped in
    // until CI's `pixels` job stalled on a first create), batch B never got the
    // lock and this test timed out at 5000ms. Watched, 2026-08-29.
    let releaseA: () => void = () => undefined;
    let pushes = 0;
    const held = new Promise<void>((resume) => {
      releaseA = resume;
    });
    const slow: Broadcaster = {
      publish: () => {
        pushes += 1;
        return pushes === 1 ? held : Promise.resolve();
      },
      latestSeq: () => Promise.resolve(0),
    };
    const slowItems = new WorkItemService({ ...serviceOptions, broadcast: slow });
    const slowRunner = new PlanCommandRunner({ ...runnerOptions, workItems: slowItems });

    let a: 'pending' | 'applied' = 'pending';
    const first = slowRunner
      .run(projectId, ownerId, [
        { kind: 'createWorkItem', parentId: null, afterId: null, name: 'A' },
      ])
      .then(() => {
        a = 'applied';
      });
    const second = await slowRunner.run(projectId, ownerId, [
      { kind: 'createWorkItem', parentId: null, afterId: null, name: 'B' },
    ]);
    expect(second.ok).toBe(true);
    expect(a).toBe('pending');
    expect(await names()).toEqual(['A', 'B']);
    releaseA();
    await first;
    expect(a).toBe('applied');
  });

  it('refuses two hundred and one commands before applying any', async () => {
    const many: PlanCommand[] = Array.from({ length: 201 }, (_, n) => ({
      kind: 'createWorkItem',
      parentId: null,
      afterId: null,
      name: `Row ${String(n)}`,
    }));
    expect(await run(many)).toEqual({
      ok: false,
      at: 200,
      kind: 'createWorkItem',
      reason: 'too_many_commands',
    });
    expect(await names()).toEqual([]);
  });

  it('applies a rename queued behind a refused batch, after it', async () => {
    // The write lock on one connection: without it the rename's writes land
    // inside the refused batch's open transaction and vanish with its rollback.
    // Proof: `lock.run` bypassed in the runner, this failed on `expected [] to
    // equal [ 'Strip it' ]`. Watched, 2026-08-29.
    const refs = applied(await run(draft().slice(0, 1)));
    const strip = refs.get('strip');
    if (strip === undefined) throw new Error('no strip');
    const refused = run([
      { kind: 'createWorkItem', ref: 'x', parentId: null, afterId: null, name: 'Doomed' },
      { kind: 'setEstimate', workItemRef: 'x', roleId: 'no-such-role', days: DAYS },
    ]);
    const renamed = run([
      { kind: 'patchWorkItem', workItemId: strip, patch: { name: 'Strip it' } },
    ]);
    expect((await refused).ok).toBe(false);
    expect((await renamed).ok).toBe(true);
    expect(await names()).toEqual(['Strip it']);
  });
});
