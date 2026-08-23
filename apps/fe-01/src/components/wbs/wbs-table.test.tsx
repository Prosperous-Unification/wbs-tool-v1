import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AssumedAssigneeFlipView,
  Days,
  EstimateMethod,
  ProjectApi,
  RoleView,
  UndoResult,
  WorkItemView,
} from '@/lib/wbs-api';

import { hintFor, ROLE_FINAL_HINT } from './column-hints';
import { cellKey } from './editable-grid';
import { DAY_PX } from './gantt-panel';
import { initialsOf } from './initials';
import { refusedDraftFor } from './live-editing';
import {
  DATE_EDITOR_WIDTH,
  DEEPEST_INDENT,
  FLEXIBLE_CAP,
  FLEXIBLE_FLOOR,
  frameLayout,
  type FrameLayoutState,
  POPOVER_ROW_LAYER,
} from './table-frame';
import { type SubscriptionHandlers, WbsTable, widthFromDrag } from './wbs-table';

/** The two elements a table cell can be, since a wrapping cell is a textarea. */
const isCell = (node: unknown): node is HTMLInputElement | HTMLTextAreaElement =>
  node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * A plan where no row sets an earliest start, which is what every plan built
 * by these helpers is unless it says otherwise.
 */
const UNDATED: FrameLayoutState = { hasAnyNotBefore: false };
/** And one where somebody has, which is 28px wider. */
const DATED: FrameLayoutState = { hasAnyNotBefore: true };

const DEV: RoleView = { id: 'role-dev', name: 'Dev' };
// A second role, because "one assignee is assumed to do every phase" is only
// observable when there is another phase for them to be assumed into.
const QA: RoleView = { id: 'role-qa', name: 'QA' };

/**
 * A ProjectApi over an in-memory tree, numbering rows the way be-01 does.
 *
 * It has to renumber on every change rather than assign once: the whole point
 * of the component's "refetch, never patch" rule is that a create or move moves
 * numbers it never touched, and a fake that kept numbers stable would let a
 * broken component pass.
 */
function fakeApi(): ProjectApi & {
  rows: WorkItemView[];
  stack: { undoable: boolean; redoable: boolean };
  stackCalls: ('undo' | 'redo')[];
  answerStackWith: (answer: UndoResult) => void;
  /**
   * The three service writes this fake models directly rather than through
   * {@link ProjectApi}.
   *
   * There is no service CRUD on this client yet — task 7.5. A fixture that needs
   * a labelled row writes the set straight onto the view, which since task 10.2
   * is what be-01 sends: `serviceIds` off the join, no column anywhere on the
   * wire.
   */
  addService: (name: string) => { id: string; name: string };
  labelWithService: (workItemId: string, serviceIds: readonly string[]) => void;
  ownService: (teamId: string, serviceId: string) => void;
  /** The same write undone, for the map emptying under a ticked signal. */
  disownService: (teamId: string, serviceId: string) => void;
} {
  const rows: WorkItemView[] = [];
  const edges: { predecessorId: string; successorId: string }[] = [];
  let next = 0;
  let seq = -1;
  let estimateMethod: EstimateMethod = 'pert';
  let startDate: string | null = null;
  /**
   * `serviceIds` present and empty on every team, never absent — be-01 sends
   * the ownership map whole ({@link TeamView.serviceIds}) and a fake that left
   * it off would hand the table an `undefined` it can never see in production.
   * This file's `typecheck` target does not cover the spec tsconfig, so the
   * shape is kept here by hand rather than by the compiler.
   */
  const teams: { id: string; name: string; serviceIds: string[] }[] = [];
  /** The global service directory, in the order it was added. */
  const services: { id: string; name: string }[] = [];
  const people: { id: string; name: string; teamIds: string[] }[] = [];
  const assigned = new Map<string, string>();
  /**
   * The project's phases, which this fake can now be asked to change.
   *
   * A list of its own rather than the two constants, because `P phases-ui` adds
   * and removes them: a fake answering a fixed pair would let a dialog that
   * wrote nothing pass.
   */
  let roleList: RoleView[] = [{ ...DEV }, { ...QA }];
  /**
   * The undo stack as far as this table can see it, which is only what be-01
   * reports and what it answers.
   *
   * Set by the tests rather than derived from the mutations above, deliberately:
   * whether there is anything to undo is a fact about a per-account stack on
   * the server — cleared by a refusal, cleared by anybody's forward edit — and
   * a fake that guessed at it would be a second implementation of a rule this
   * component does not own.
   */
  const stack = { undoable: false, redoable: false };
  const stackCalls: ('undo' | 'redo')[] = [];
  let stackAnswer: UndoResult = { ok: true, done: 'rename “Strip”', detail: null };

  /** The final figure be-01 would report, under whichever method is set. */
  const finalOf = (days: Days): number =>
    estimateMethod === 'pert'
      ? (days.optimistic + 4 * days.realistic + days.pessimistic) / 6
      : days[estimateMethod];

  /**
   * The schedule be-01 would compute, in miniature.
   *
   * Not the real algorithm — one pass over rows already in tree order is enough
   * for a fake, because these tests are about the table. What it does model
   * faithfully is the part the table renders differently: an unestimated row,
   * and a parent's span being its children's rather than their sum.
   */
  function scheduleOf(row: WorkItemView): WorkItemView['schedule'] {
    const children = rows.filter((r) => r.parentId === row.id);
    const own = Object.values(row.estimates).reduce(
      (total, days) => total + (days.optimistic + 4 * days.realistic + days.pessimistic) / 6,
      0,
    );
    const waits = edges
      .filter((e) => e.successorId === row.id)
      .map((e) => rows.find((r) => r.id === e.predecessorId))
      .map((r) => (r === undefined ? 0 : scheduleOf(r).earliestFinish));
    const start = Math.max(0, ...waits);
    const duration = children.length > 0 ? 0 : own;
    const finish =
      children.length > 0
        ? Math.max(0, ...children.map((c) => scheduleOf(c).earliestFinish))
        : start + duration;
    return {
      duration,
      estimated: children.length > 0 ? children.some((c) => scheduleOf(c).estimated) : own > 0,
      earliestStart: start,
      earliestFinish: finish,
      latestStart: start,
      latestFinish: finish,
      float: 0,
      critical: true,
    };
  }

  /**
   * The work items whose assumed assignee removing `roleId` would move, the way
   * `apps/be-01/src/service/assumed-assignee.ts` computes them: exactly one
   * assignment means that person is taken to be doing every phase.
   */
  function flipsFor(roleId: string): AssumedAssigneeFlipView[] {
    const byWorkItem = new Map<string, Record<string, string>>();
    for (const [key, personId] of assigned) {
      const [workItemId = '', held = ''] = key.split('::');
      byWorkItem.set(workItemId, { ...(byWorkItem.get(workItemId) ?? {}), [held]: personId });
    }
    const only = (byRole: Record<string, string>): string | null => {
      const named = Object.values(byRole);
      return named.length === 1 ? (named[0] ?? null) : null;
    };
    return [...byWorkItem.entries()]
      .map(([workItemId, byRole]) => ({
        workItemId,
        assumedNow: only(byRole),
        assumedAfter: only(
          Object.fromEntries(Object.entries(byRole).filter(([each]) => each !== roleId)),
        ),
      }))
      .filter((flip) => flip.assumedNow !== flip.assumedAfter)
      .sort((a, b) => (a.workItemId < b.workItemId ? -1 : 1));
  }

  function renumber(): void {
    seq += 1;
    const numberOf = new Map<string | null, string>([[null, '']]);
    const assign = (parentId: string | null, prefix: string): void => {
      const group = rows.filter((r) => r.parentId === parentId);
      group.forEach((row, i) => {
        row.number =
          prefix === '' ? String((i + 1) * 10).padStart(3, '0') : `${prefix}.${String(i + 1)}`;
        numberOf.set(row.id, row.number);
        assign(row.id, row.number);
      });
    };
    assign(null, '');
    rows.sort((a, b) => (a.number < b.number ? -1 : 1));
    for (const row of rows) row.rolledUp = rows.some((r) => r.parentId === row.id);
  }

  return {
    rows,
    stack,
    stackCalls,
    /** What the next undo or redo answers, for the refusals be-01 models. */
    answerStackWith(answer: UndoResult) {
      stackAnswer = answer;
    },
    addService(name: string) {
      // Idempotent by name, as `addTeam` is and as be-01's unique
      // `service_name` makes it: two `Billing`s is not a state the directory
      // can be in, so it must not be one this fake can be in either.
      const already = services.find((s) => s.name === name);
      if (already !== undefined) return already;
      const service = { id: `service${String(services.length + 1)}`, name };
      services.push(service);
      return service;
    },
    labelWithService(workItemId: string, serviceIds: readonly string[]) {
      const row = rows.find((r) => r.id === workItemId);
      if (row !== undefined) row.serviceIds = [...serviceIds];
      // Through `renumber` like every other write here, so the next `tree`
      // read carries a fresh sequence and the table does not discard it.
      renumber();
    },
    disownService(teamId: string, serviceId: string) {
      const team = teams.find((t) => t.id === teamId);
      if (team === undefined) return;
      team.serviceIds = team.serviceIds.filter((each) => each !== serviceId);
    },
    ownService(teamId: string, serviceId: string) {
      const team = teams.find((t) => t.id === teamId);
      // Silent on an unknown team rather than throwing: be-01 refuses that
      // write with `unknown_team`, and a fixture that threw instead would make
      // a typo in a case look like a bug in the table.
      if (team !== undefined && !team.serviceIds.includes(serviceId)) {
        team.serviceIds.push(serviceId);
      }
    },
    listProjects: () =>
      Promise.resolve([
        {
          id: 'p1',
          name: 'Rewire the shed',
          restricted: false,
          lastOpenedAt: null,
          ownerName: 'kat',
          createdAt: 1_780_000_000_000,
        },
      ]),
    // No `lastOpenedAt`: the create route answers with the project it wrote,
    // and never with this account's navigation history.
    createProject: (name: string) => Promise.resolve({ id: 'p1', name, restricted: false }),
    openProject: () => Promise.resolve(),
    renameProject: () => Promise.resolve(),
    tree: () =>
      // The sequence advances with every mutation, the way be-01's does, so a
      // test that asserts what the stream was told is asserting something real.
      Promise.resolve({
        workItems: rows.map((r) => ({
          ...r,
          dependsOn: edges.filter((e) => e.successorId === r.id).map((e) => e.predecessorId),
          schedule: scheduleOf(r),
          finalDays: Object.fromEntries(
            Object.entries(r.estimates).map(([roleId, days]) => [roleId, finalOf(days)]),
          ),
          finalTotal: Object.values(r.estimates).reduce((total, days) => total + finalOf(days), 0),
          // be-01 works the dates out; the fake only has to place them on the
          // calendar the same way, so the table is asserted on what it renders.
          dates: startDate === null ? null : { startsOn: startDate, endsOn: startDate },
          assignees: Object.fromEntries(
            [...assigned.entries()]
              .filter(([key]) => key.startsWith(`${r.id}::`))
              .map(([key, personId]) => [key.split('::')[1] ?? '', personId]),
          ),
          doesEveryPhase: (() => {
            const mine = [...assigned.entries()].filter(([key]) => key.startsWith(`${r.id}::`));
            return mine.length === 1 ? (mine[0]?.[1] ?? null) : null;
          })(),
        })),
        seq,
        scheduleError: null,
        // One per leaf and phase, as be-01 places them: a parent has no work of
        // its own and gets none. The ids are this fake's, and opaque — the
        // table looks them up and never takes them apart.
        slices: rows
          .filter((r) => !rows.some((child) => child.parentId === r.id))
          .map((r) => ({
            id: `${r.id}::${DEV.id}`,
            workItemId: r.id,
            roleId: DEV.id,
            personId: assigned.get(`${r.id}::${DEV.id}`) ?? null,
            ...scheduleOf(r),
            // The one floor this fake can honestly tell apart, and it tells it
            // apart because `row-start-floor` made the Start column say which:
            // be-01 floors a row with a stored predecessor on `predecessor`,
            // and a constant `projectStart` here would let a cell claim a plan
            // has no waits in it at all. The other four floors need a scheduler
            // and this fake is not one — the tests about them are
            // `gantt-geometry.test.ts`'s, over payloads shaped by hand.
            boundBy: edges.some((e) => e.successorId === r.id)
              ? ('predecessor' as const)
              : ('projectStart' as const),
            resourcePredecessorId: null,
            // One at a time and nothing holding a pool, which is every plan
            // this fake stands in for.
            width: 1,
            effort: scheduleOf(r).duration,
            capacityPredecessorIds: [],
          })),
        // On the read that carried the slices, as be-01 sends them: the chart
        // reads its roles and its names from here and not from the separate
        // `roles`/`listPeople` calls the pickers make.
        roles: roleList.map((role) => ({ ...role })),
        assignedPeople: people.map(({ id, name }) => ({ id, name })),
        // Present and empty, never absent: be-01 always sends it, so a fake that
        // left it out would let `teamsOnThePlan` be handed `undefined` here and
        // never in production. A plan whose teams are unlimited is what `[]` says.
        teamCapacities: [],
        priorityBands: DEFAULT_PRIORITY_BANDS,
        estimateMethod,
        startDate,
        // Never moved by anything the table does: the fake's mutations are all
        // work item writes, and be-01 keeps the project's revision off them.
        projectRevision: 0,
        undoable: stack.undoable,
        redoable: stack.redoable,
      }),
    setEstimateMethod(_projectId, method) {
      estimateMethod = method;
      renumber();
      return Promise.resolve();
    },
    listTeams: () => Promise.resolve(teams.map((t) => ({ ...t, serviceIds: [...t.serviceIds] }))),
    listTags: () => Promise.resolve([]),
    listServices: () => Promise.resolve([...services]),
    addTeam(name: string) {
      // Idempotent by name, exactly as be-01 is: the picker's "type it if it
      // is not in the list" must not be able to make two `Platform`s.
      const already = teams.find((t) => t.name === name);
      if (already !== undefined) return Promise.resolve(already);
      const team = { id: `team${String(teams.length + 1)}`, name, serviceIds: [] };
      teams.push(team);
      return Promise.resolve(team);
    },
    listPeople: () => Promise.resolve(people.map((p) => ({ ...p, teamIds: [...p.teamIds] }))),
    addPerson(name: string, teamIds: readonly string[]) {
      const already = people.find((p) => p.name === name);
      if (already !== undefined) return Promise.resolve(already);
      const person = { id: `person${String(people.length + 1)}`, name, teamIds: [...teamIds] };
      people.push(person);
      return Promise.resolve(person);
    },
    assign(workItemId: string, roleId: string, personId: string | null) {
      const key = `${workItemId}::${roleId}`;
      if (personId === null) assigned.delete(key);
      else assigned.set(key, personId);
      renumber();
      return Promise.resolve();
    },
    setStartDate(_projectId, day) {
      startDate = day;
      renumber();
      return Promise.resolve();
    },
    roles: () => Promise.resolve(roleList.map((role) => ({ ...role }))),
    addRole(_projectId, name) {
      const clean = name.trim();
      if (clean === '') return Promise.reject(new Error('name_required'));
      if (roleList.some((role) => role.name === clean)) {
        return Promise.reject(new Error('taken'));
      }
      const role = { id: `role-${clean.toLowerCase()}`, name: clean };
      roleList.push(role);
      renumber();
      return Promise.resolve(role);
    },
    renameRole(_projectId, roleId, name) {
      const clean = name.trim();
      if (clean === '') return Promise.reject(new Error('name_required'));
      const role = roleList.find((each) => each.id === roleId);
      if (role === undefined) return Promise.reject(new Error('not_found'));
      if (roleList.some((each) => each.id !== roleId && each.name === clean)) {
        return Promise.reject(new Error('taken'));
      }
      role.name = clean;
      renumber();
      return Promise.resolve({ ...role });
    },
    removeRole(_projectId, roleId, cascade) {
      const role = roleList.find((each) => each.id === roleId);
      if (role === undefined) return Promise.reject(new Error('not_found'));
      // `Object.hasOwn` rather than an index and a comparison: `estimates` is a
      // `Record<string, Days>`, so the index is typed as always finding one and
      // the comparison is dead code the lint rightly refuses.
      const estimates = rows.filter((row) => Object.hasOwn(row.estimates, roleId)).length;
      const holders = [...assigned.keys()].filter((key) => key.endsWith(`::${roleId}`));
      if (!cascade && estimates + holders.length > 0) {
        return Promise.resolve({
          ok: false as const,
          reason: 'in_use' as const,
          inUse: { estimates, assignments: holders.length, assumedAssignees: flipsFor(roleId) },
        });
      }
      for (const row of rows) {
        // Rebuilt rather than `delete`d on a computed key, which this repo bans.
        row.estimates = Object.fromEntries(
          Object.entries(row.estimates).filter(([each]) => each !== roleId),
        );
      }
      for (const key of holders) assigned.delete(key);
      roleList = roleList.filter((each) => each.id !== roleId);
      renumber();
      return Promise.resolve({ ok: true as const });
    },
    create(_projectId, input) {
      next += 1;
      const id = `w${String(next)}`;
      const at =
        input.afterId === null ? rows.length : rows.findIndex((r) => r.id === input.afterId) + 1;
      rows.splice(at, 0, {
        id,
        parentId: input.parentId,
        // A new row has never been written to since it came into being, and
        // this fake never writes to a row again — the table sends patches and
        // refetches, so nothing here would move it.
        revision: 0,
        number: '',
        name: input.name ?? '',
        notes: '',
        frozenNumber: null,
        priority: null,
        // One at a time, which is be-01's `NOT NULL DEFAULT 1` — never absent,
        // because 1 and unset are the same fact.
        maxParallel: 1,
        startNoEarlierThan: null,
        startNoEarlierThanReason: null,
        // Beside the date it explains, and null for the same reason: nobody has
        // said. A duplicate `teamIds` sat here until 2026-08-18 — harmless, and
        // only because nothing typechecks this file (`fe-01:typecheck` builds
        // `tsconfig.app.json` and `tsconfig.e2e.json`, not `.spec`).
        startNoEarlierThanReason: null,
        serviceTeamId: null,
        teamIds: [],
        assignees: {},
        doesEveryPhase: null,
        rolledUp: false,
        estimates: {},
        dependsOn: [],
        finalDays: {},
        finalTotal: 0,
        schedule: {
          duration: 0,
          estimated: false,
          earliestStart: 0,
          earliestFinish: 0,
          latestStart: 0,
          latestFinish: 0,
          float: 0,
          critical: true,
        },
      });
      renumber();
      return Promise.resolve({ id });
    },
    patch(id, patch) {
      const row = rows.find((r) => r.id === id);
      // `maxParallel: null` is a **reset to 1** and not a clear, which is
      // be-01's own normalisation (`capacity-write-paths`, slice 1.3) rather
      // than this fake's convenience: the column is NOT NULL, and a fake that
      // stored the null would let the table pass a test against a row shape
      // be-01 can never send.
      const written =
        'maxParallel' in patch && patch.maxParallel === null ? { ...patch, maxParallel: 1 } : patch;
      if (row !== undefined) Object.assign(row, written);
      // The dual write be-01 performs: the column and the join, in one act, and
      // the join is what this client reads. A fake that wrote only the column
      // would leave the table reading an empty set and every label test green
      // against a screen with no labels on it.
      if (row !== undefined && 'serviceTeamId' in written) {
        row.teamIds = written.serviceTeamId === null ? [] : [written.serviceTeamId ?? ''];
      }
      return Promise.resolve();
    },
    move(id, parentId, afterId) {
      const index = rows.findIndex((r) => r.id === id);
      const row = rows.splice(index, 1).at(0);
      if (row === undefined) return Promise.resolve();
      row.parentId = parentId;
      const at = afterId === null ? 0 : rows.findIndex((r) => r.id === afterId) + 1;
      rows.splice(at, 0, row);
      renumber();
      return Promise.resolve();
    },
    duplicate(id) {
      const source = rows.find((r) => r.id === id);
      if (source === undefined) return Promise.reject(new Error('not_found'));
      // be-01's rules in miniature, because the table is asserted against
      // them: the whole branch, the root renamed, no frozen numbers, and only
      // the edges with both ends inside it.
      const subtree: WorkItemView[] = [];
      const collect = (row: WorkItemView): void => {
        subtree.push(row);
        for (const child of rows.filter((r) => r.parentId === row.id)) collect(child);
      };
      collect(source);
      const copyOf = new Map<string, string>();
      for (const row of subtree) {
        next += 1;
        copyOf.set(row.id, `w${String(next)}`);
      }
      const copyId = (originalId: string): string => {
        const copied = copyOf.get(originalId);
        if (copied === undefined) throw new Error(`no copy for ${originalId}`);
        return copied;
      };
      const copies = subtree.map((row, index) => ({
        ...row,
        id: copyId(row.id),
        parentId: index === 0 ? row.parentId : copyId(row.parentId ?? row.id),
        name: index === 0 ? `${row.name} (copy)` : row.name,
        frozenNumber: null,
        priority: null,
        estimates: { ...row.estimates },
      }));
      const inside = new Set(subtree.map((r) => r.id));
      for (const edge of edges.filter(
        (e) => inside.has(e.predecessorId) && inside.has(e.successorId),
      )) {
        edges.push({
          predecessorId: copyId(edge.predecessorId),
          successorId: copyId(edge.successorId),
        });
      }
      for (const [key, personId] of [...assigned.entries()]) {
        const [workItemId = '', roleId = ''] = key.split('::');
        if (inside.has(workItemId)) assigned.set(`${copyId(workItemId)}::${roleId}`, personId);
      }
      const last = subtree.at(-1);
      rows.splice(last === undefined ? rows.length : rows.indexOf(last) + 1, 0, ...copies);
      renumber();
      const root = copies.at(0);
      if (root === undefined) throw new Error('a duplication copied nothing');
      return Promise.resolve({ id: root.id });
    },
    remove(id) {
      const index = rows.findIndex((r) => r.id === id);
      if (index >= 0) rows.splice(index, 1);
      renumber();
      return Promise.resolve();
    },
    setEstimate(id, roleId, days: Days) {
      const row = rows.find((r) => r.id === id);
      if (row !== undefined) row.estimates[roleId] = days;
      return Promise.resolve();
    },
    clearEstimate(id, roleId) {
      const row = rows.find((r) => r.id === id);
      // Rebuilt without the role rather than `delete`d on a computed key, the
      // same way the table drops a trio's drafts.
      if (row !== undefined) {
        row.estimates = Object.fromEntries(
          Object.entries(row.estimates).filter(([key]) => key !== roleId),
        );
      }
      return Promise.resolve();
    },
    freeze() {
      for (const row of rows) row.frozenNumber ??= row.number;
      return Promise.resolve();
    },
    unfreezeProject() {
      for (const row of rows) row.frozenNumber = null;
      return Promise.resolve();
    },
    unfreeze(id) {
      const row = rows.find((r) => r.id === id);
      if (row !== undefined) row.frozenNumber = null;
      return Promise.resolve();
    },
    addDependency(id, predecessorId) {
      // Mirrors the unique pair the real table has: adding the same edge twice
      // is not two edges, and a fake that let it be would not be modelling it.
      const already = edges.some((e) => e.predecessorId === predecessorId && e.successorId === id);
      if (!already) edges.push({ predecessorId, successorId: id });
      renumber();
      return Promise.resolve();
    },
    removeDependency(id, predecessorId) {
      const at = edges.findIndex((e) => e.predecessorId === predecessorId && e.successorId === id);
      if (at >= 0) edges.splice(at, 1);
      renumber();
      return Promise.resolve();
    },
    undo() {
      stackCalls.push('undo');
      renumber();
      return Promise.resolve(stackAnswer);
    },
    redo() {
      stackCalls.push('redo');
      renumber();
      return Promise.resolve(stackAnswer);
    },
  };
}

const numbersOnScreen = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[data-number]')?.textContent ?? '');

/** What the toast stack is saying, newest first. */
const toastTexts = (): string[] =>
  [...document.querySelectorAll('[data-toast-text]')].map((node) => node.textContent);

/** The stale-tree banner, or null while the tree on screen is believed current. */
const staleBanner = (): Element | null => document.querySelector('[data-stale-tree]');

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

/** Opens one row's ⋯ menu, the way a pointer does. */
const openRowMenu = (number: string) => {
  click(`Actions for ${number}`);
};

/**
 * Opens a row's ⋯ menu and takes one of its items.
 *
 * The items are named plainly — `Duplicate`, not `Duplicate 010` — which is
 * only unambiguous because one menu is open at a time. That rule is the subject
 * of `opening one row’s menu closes the one already open`; if it broke, every
 * use of this helper would fail on two elements with the same name.
 */
const takeRowAction = (number: string, label: string) => {
  openRowMenu(number);
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};

const typeName = (number: string, value: string) => {
  fireEvent.change(screen.getByLabelText(`Name of ${number}`), { target: { value } });
};

/**
 * Ctrl+N in a named row's Name cell: a new work item below it.
 *
 * Keys are fired at a named row rather than at `document.activeElement`.
 * Focus is a real behaviour and gets its own assertion, but using it to steer
 * these tests would make every one of them fail for the same reason if focus
 * broke — and none of them would say which behaviour was actually wrong.
 *
 * This was `pressEnter` until `command-keys`. Enter in a name is now the
 * browser's own newline — a work item's notes are written under its name in
 * that box — and the tests that only ever used Enter as scaffolding to *get* a
 * second row moved to the chord that makes one. What Enter does instead has
 * its own tests in `the command chords`.
 */
const pressNewItem = (number: string) => {
  fireEvent.keyDown(screen.getByLabelText(`Name of ${number}`), {
    key: 'n',
    code: 'KeyN',
    ctrlKey: true,
  });
};

/**
 * Opens a role's folded columns — the trio and the assignee. Folded is the
 * default, so every test that types an estimate or assigns someone does this
 * first, exactly as a person would.
 */
const unfoldRole = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Unfold ${name} estimates` }));
};

const pressTab = (number: string, shiftKey = false) => {
  fireEvent.keyDown(screen.getByLabelText(`Name of ${number}`), { key: 'Tab', shiftKey });
};

// The table remembers each project's open branches in localStorage, so one
// test's collapsing would arrive as the next test's starting shape.
beforeEach(() => {
  localStorage.clear();
});

describe('the WBS table', () => {
  itDom('types a three-level breakdown without touching the mouse', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    typeName('010', 'Strip');

    // Ctrl+N makes a sibling; Tab makes that sibling a child of the row above.
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });

    typeName('010.1', 'Sockets');
    pressNewItem('010.1');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
    });

    pressTab('010.2');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
    });
  });

  /**
   * A planner typing out a backlog clicks faster than the round trip, and every
   * click has to become a row.
   *
   * Measured on dev by `wbs-e2e-planning-qa`, with trusted mouse events and the
   * button re-measured before every click: **6 clicks at 350ms produced 3 rows,
   * 4 clicks at 1500ms produced 4** — counted as `tbody tr` after a four-second
   * settle, so not a render race in the counter. The lost clicks are silent:
   * no toast, nothing queued, and the rows the planner thinks they made are
   * simply not there.
   *
   * **be-01 is not the one refusing.** `create` sends `{parentId, afterId,
   * name}` and carries no revision at all, so there is no stale-revision
   * conflict to lose the second write to — the drop happens on this client,
   * which is why this test lives here rather than on the route.
   *
   * The write is held open on purpose rather than left to timing. That is the
   * whole window under test: what a click does while the last one is still
   * being answered.
   */
  itDom('makes a row for every click on Add work item, including the ones mid-write', async () => {
    const api = fakeApi();
    const inFlight: (() => void)[] = [];
    // Everything else answers at once; only the create waits, so the busy
    // window is exactly one call wide and nothing else in the table is slowed.
    const slow: ProjectApi = {
      ...api,
      create: async (projectId, input) => {
        await new Promise<void>((resolve) => {
          inFlight.push(resolve);
        });
        return api.create(projectId, input);
      },
    };
    render(<WbsTable projectId="p1" api={slow} />);
    await screen.findByRole('button', { name: 'Add work item' });

    for (let i = 0; i < 6; i += 1) click('Add work item');

    // Answering is a loop rather than one release, because a serialised burst
    // sends its next write only once the last is answered — so waiting for a
    // write to appear, answering it, and waiting again is what a network doing
    // its job looks like from here. A client that dropped the other five runs
    // out of writes to answer and leaves the loop early, which is the shape of
    // the failure rather than a timeout.
    for (let answered = 0; answered < 6; answered += 1) {
      try {
        await waitFor(() => {
          expect(inFlight.length).toBeGreaterThan(0);
        });
      } catch {
        break;
      }
      for (const release of inFlight.splice(0)) release();
    }

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040', '050', '060']);
    });
  });

  itDom('outdents with shift-tab', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });

    pressTab('010.1', true);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('replaces the slices on every refetch, as it replaces the rows', async () => {
    // The plan's slices arrive on the same read as its rows and are held beside
    // them, so an edit that changes what be-01 placed changes what this holds —
    // in both directions. Counted rather than listed because the ids are
    // opaque; what is asserted is that they are this read's and not the last
    // one's.
    const api = fakeApi();
    const { container } = render(<WbsTable projectId="p1" api={api} />);
    const sliceCount = () =>
      container.querySelector('[data-slice-count]')?.getAttribute('data-slice-count');

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    await waitFor(() => {
      expect(sliceCount()).toBe('1');
    });

    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    await waitFor(() => {
      expect(sliceCount()).toBe('2');
    });

    // Indenting takes one away: 010 has become a parent, and a parent has no
    // work of its own for anybody to place a slice of.
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    await waitFor(() => {
      expect(sliceCount()).toBe('1');
    });
  });

  itDom('backspace at the start of the name outdents the row', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });

    const name = screen.getByLabelText<HTMLInputElement>('Name of 010.1');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('backspace anywhere else, or over a selection, stays a backspace', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');
    typeName('010.1', 'Sockets');

    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 010.1');

    // Mid-text: an ordinary backspace.
    name.setSelectionRange(3, 3);
    fireEvent.keyDown(name, { key: 'Backspace' });
    // A selection anchored at the start: deleting it, not moving the row.
    name.setSelectionRange(0, 3);
    fireEvent.keyDown(name, { key: 'Backspace' });

    expect(moved).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010', '010.1']);
  });

  itDom('backspace in an empty root row removes it and puts the focus above', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
  });

  itDom('a nested empty row outdents on backspace, and is not removed', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');

    const removed: unknown[] = [];
    api.remove = (...args: unknown[]) => {
      removed.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 010.1');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    expect(removed).toEqual([]);
  });

  itDom('anything the item holds vetoes the backspace removal', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    // 010 gets its child first, so the numbering of everything after is settled.
    pressNewItem('010');
    await screen.findByLabelText('Name of 020');
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');
    // Four more root rows: one per remaining kind of content that must veto.
    for (const upTo of ['020', '030', '040', '050'] as const) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${upTo}`);
    }

    // 030 gets notes, 040 an estimate, 050 a dependency — committed by blur.
    // The notes are typed under an empty first line, so 030 has notes and no
    // name: this test is about a work item whose *only* content is a note, and
    // a name typed above it would veto the removal for the wrong reason.
    const notes = screen.getByLabelText<HTMLInputElement>('Name of 030');
    fireEvent.change(notes, { target: { value: '\nmeasure twice' } });
    fireEvent.blur(notes);
    unfoldRole('Dev');
    // A whole trio on 040 — one point alone is a draft, not an estimate, since
    // the table stopped inventing the other two.
    for (const point of ['optimistic', 'realistic', 'pessimistic'] as const) {
      const estimate = screen.getByLabelText<HTMLInputElement>(`Dev ${point} for 040`);
      fireEvent.change(estimate, { target: { value: '3' } });
      fireEvent.blur(estimate);
    }
    const depends = screen.getByLabelText<HTMLInputElement>('Add a dependency to 050');
    fireEvent.change(depends, { target: { value: '010' } });
    fireEvent.keyDown(depends, { key: 'Enter' });
    fireEvent.blur(depends);
    await waitFor(() => {
      expect(api.rows.find((row) => row.number === '030')?.notes).toBe('measure twice');
    });
    expect(screen.getByLabelText('Name of 030')).toHaveValue('\nmeasure twice');

    const removed: unknown[] = [];
    api.remove = (...args: unknown[]) => {
      removed.push(args);
      return Promise.resolve();
    };

    // 020: text typed into the Name and not yet committed is still a name.
    const named = screen.getByLabelText<HTMLInputElement>('Name of 020');
    fireEvent.change(named, { target: { value: 'Sand' } });
    named.setSelectionRange(0, 0);
    fireEvent.keyDown(named, { key: 'Backspace' });

    for (const number of ['010', '030', '040', '050'] as const) {
      const name = screen.getByLabelText<HTMLInputElement>(`Name of ${number}`);
      name.setSelectionRange(0, 0);
      fireEvent.keyDown(name, { key: 'Backspace' });
    }

    expect(removed).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010', '010.1', '020', '030', '040', '050']);
  });

  itDom('a note that has not been deleted yet still vetoes the removal', async () => {
    // The committed half of "is this work item empty", and the reason the
    // `row.notes` conjunct stays beside `input.value === ''` now that one box
    // holds both fields: emptying the box is not the same as having emptied
    // the work item. Nothing has been sent — the blur that would send it has
    // not happened — so the note is still there for everyone else, and a
    // keystroke reflex must not take the row it belongs to with it.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLInputElement>('Name of 010');
    fireEvent.change(name, { target: { value: '\nmeasure twice' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe('measure twice');
    });

    const removed: unknown[] = [];
    api.remove = (...args: unknown[]) => {
      removed.push(args);
      return Promise.resolve();
    };

    // Select it all and delete it, then Backspace once more — one gesture, and
    // the blur that would commit the emptying has not happened.
    const again = screen.getByLabelText<HTMLInputElement>('Name of 010');
    fireEvent.change(again, { target: { value: '' } });
    again.setSelectionRange(0, 0);
    fireEvent.keyDown(again, { key: 'Backspace' });

    expect(removed).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('tab inside the text walks to the next cell instead of indenting', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Unfolded before typing: the fold rebuilds the column set, which
    // remounts every cell, and a name typed but not yet committed would be
    // reset to the server's value — the one cost of folding, paid on an
    // explicit click.
    unfoldRole('Dev');
    typeName('020', 'Sand');

    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.focus();
    name.setSelectionRange(2, 2);
    fireEvent.keyDown(name, { key: 'Tab' });

    // The next field, which is the one beside the name: what a row waits for.
    const next = screen.getByLabelText<HTMLInputElement>('Add a dependency to 020');
    expect(document.activeElement).toBe(next);
    expect(moved).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010', '020']);
  });

  itDom('shift-tab inside the text walks backwards instead of outdenting', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Unfolded before typing: the fold rebuilds the column set, which
    // remounts every cell, and a name typed but not yet committed would be
    // reset to the server's value — the one cost of folding, paid on an
    // explicit click.
    unfoldRole('Dev');
    typeName('020', 'Sand');

    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.focus();
    name.setSelectionRange(2, 2);
    fireEvent.keyDown(name, { key: 'Tab', shiftKey: true });

    // The row above's last editable cell — 010 is a leaf and the plan has no
    // start date, so its folded QA estimate. The Notes cell that used to be
    // last is gone: those live under the name now.
    expect(document.activeElement).toBe(screen.getByLabelText('QA estimate for 010'));
    expect(moved).toEqual([]);
  });

  itDom('tab over a selection navigates rather than indenting', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Unfolded before typing: the fold rebuilds the column set, which
    // remounts every cell, and a name typed but not yet committed would be
    // reset to the server's value — the one cost of folding, paid on an
    // explicit click.
    unfoldRole('Dev');
    typeName('020', 'Sand');

    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.focus();
    // Anchored at the start: atStart alone would still indent this.
    name.setSelectionRange(0, 3);
    fireEvent.keyDown(name, { key: 'Tab' });

    expect(document.activeElement).toBe(
      screen.getByLabelText<HTMLInputElement>('Add a dependency to 020'),
    );
    expect(moved).toEqual([]);
  });

  itDom('backspace at the start of a root row moves nothing', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');

    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 010');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    expect(moved).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('shows a parent estimate cell as read-only and a leaf as editable', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');
    unfoldRole('Dev');

    // A parent's figures are sums of what is below it. Typing into them would be
    // either ignored or double-counted, and neither is visible to whoever typed.
    expect(screen.getByLabelText('Dev optimistic for 010')).toHaveProperty('readOnly', true);
    expect(screen.getByLabelText('Dev optimistic for 010.1')).toHaveProperty('readOnly', false);
  });

  itDom('locks a frozen row and offers to unfreeze it', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');

    click('Freeze numbering');

    await waitFor(() => {
      expect(screen.getByLabelText('Number is frozen')).toBeDefined();
    });
    openRowMenu('010');
    expect(screen.getByRole('menuitem', { name: 'Unfreeze' })).toBeDefined();
  });
});

describe('duplicating a branch', () => {
  /** A one-row project, already loaded, so the button has something to copy. */
  async function shownRow(api: ProjectApi): Promise<void> {
    await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
  }

  itDom('copies the branch and lands the caret in the copy’s name', async () => {
    const api = fakeApi();
    await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });
    await api.create('p1', { parentId: api.rows[0]?.id ?? null, afterId: null, name: 'Sockets' });
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');

    takeRowAction('010', 'Duplicate');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020', '020.1']);
    });
    expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Strip (copy)');
    expect(screen.getByLabelText('Name of 020.1')).toHaveProperty('value', 'Sockets');
    // Proof: with the `focusNext` write removed from `duplicateRow`, this
    // failed with the focus left on the Duplicate button. Watched 2026-08-07,
    // and again on 2026-08-08 once the button became the ⋯ the menu returns
    // the focus to.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
  });

  itDom('offers Duplicate on a frozen row, which cannot be moved', async () => {
    // Freezing stops a row moving, not a row being copied — the copy gets no
    // frozen number of its own, so nothing that left the tool is duplicated.
    const api = fakeApi();
    await shownRow(api);

    click('Freeze numbering');
    await waitFor(() => {
      expect(screen.getByLabelText('Number is frozen')).toBeDefined();
    });

    takeRowAction('010', 'Duplicate');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('says why a duplication was refused, and copies nothing', async () => {
    const api = fakeApi();
    await shownRow({
      ...api,
      duplicate: () => Promise.reject(new Error('too_large')),
    });

    takeRowAction('010', 'Duplicate');

    await waitFor(() => {
      expect(toastTexts()).toContain('That change could not be completed (too_large).');
    });
    expect(numbersOnScreen()).toEqual(['010']);
  });
});

describe('the row actions menu', () => {
  /** Three root rows, named, already on screen. */
  async function threeRows(api: ProjectApi): Promise<void> {
    for (const name of ['Strip', 'Sand', 'Paint']) {
      await api.create('p1', { parentId: null, afterId: null, name });
    }
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 030');
  }

  itDom('offers Duplicate and Delete on an ordinary row', async () => {
    const api = fakeApi();
    await threeRows(api);

    openRowMenu('020');

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Duplicate',
      'Delete',
    ]);
    expect(screen.getByRole('button', { name: 'Actions for 020' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  itDom('opening one row’s menu closes the one already open', async () => {
    // One menu at a time, and it is not decoration: two open menus are two
    // `Duplicate` items with the same accessible name, which is ambiguous to a
    // screen reader and to `getByRole` alike.
    // Proof: the cell's `open` widened to `openMenuRowId !== null`, so every
    // row's menu opened at once: **11 tests failed**, this one on `Found
    // multiple elements with the role "menuitem" and name "Duplicate"`.
    // Watched, 2026-08-08.
    const api = fakeApi();
    await threeRows(api);

    openRowMenu('010');
    openRowMenu('020');

    expect(screen.getByRole('button', { name: 'Actions for 010' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeDefined();
  });

  itDom('promotes the children of a parent it deletes', async () => {
    const api = fakeApi();
    await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });
    await api.create('p1', { parentId: api.rows[0]?.id ?? null, afterId: null, name: 'Sockets' });
    await api.create('p1', { parentId: null, afterId: api.rows[0]?.id ?? null, name: 'Sand' });
    const removed: [string, unknown][] = [];
    const real = api.remove.bind(api);
    api.remove = (id, options) => {
      removed.push([id, options]);
      return real(id, options);
    };
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010.1');

    takeRowAction('010', 'Delete');

    await waitFor(() => {
      expect(removed).toHaveLength(1);
    });
    // The rule the two buttons had and this menu keeps: a branch's children
    // move up rather than being deleted with the row above them.
    expect(removed[0]?.[1]).toEqual({ strategy: 'promote' });
  });

  itDom('sends no strategy for a leaf, which has nothing to promote', async () => {
    const api = fakeApi();
    const removed: unknown[] = [];
    const real = api.remove.bind(api);
    api.remove = (id, options) => {
      removed.push(options);
      return real(id, options);
    };
    await threeRows(api);

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(removed).toHaveLength(1);
    });
    expect(removed[0]).toEqual({ strategy: undefined });
  });

  itDom('lands the caret in the next sibling’s name after a delete', async () => {
    const api = fakeApi();
    await threeRows(api);

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // 030 was renumbered 020 by the delete: the row that took its place, which
    // is where typing carries on.
    // Proof: the `focusNext` write removed from `deleteRow`, this and the
    // last-row test below both failed on `expected <body>…</body> to be
    // <textarea …>` — the deleted row took the ⋯ button the focus had been
    // given back to with it, so there was nothing left holding it. Watched,
    // 2026-08-08.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Paint');
  });

  itDom('lands the caret in the row above when the last row is deleted', async () => {
    const api = fakeApi();
    await threeRows(api);

    takeRowAction('030', 'Delete');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Proof: `?? above` dropped, leaving only the next sibling, this failed
    // alone on `expected <body>…</body> to be <textarea …>` — the last row has
    // no sibling below it. Watched, 2026-08-08.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Sand');
  });

  itDom('says why a delete was refused, moves the focus nowhere and deletes nothing', async () => {
    const api = fakeApi();
    await threeRows({ ...api, remove: () => Promise.reject(new Error('forbidden')) });

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    // Proof: `focusNext` assigned before the `await` rather than after it, this
    // failed on `expected <textarea …> to be <button …>` — the caret in the
    // name of a row nobody deleted. Watched, 2026-08-08.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for 020' }));
  });

  itDom('gives the focus back to the ⋯ button after unfreezing', async () => {
    const api = fakeApi();
    await threeRows(api);
    click('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });

    takeRowAction('020', 'Unfreeze');

    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(2);
    });
    // Nothing was created or removed, so nothing claims the caret: the menu's
    // own rule — closes, and gives the focus back where it came from — is the
    // whole answer here.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for 020' }));
  });

  itDom('keeps Delete on a frozen row, refused and saying why', async () => {
    // It used to be absent, and absent explains nothing: a reader who saw
    // Delete on this menu a minute ago had nothing on screen telling them the
    // freeze is what took it away. Present, refused, and carrying the reason —
    // the same answer the drag handle gives on a frozen row.
    const api = fakeApi();
    await threeRows(api);
    click('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });

    openRowMenu('020');

    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.getAttribute('title')).toBe('Frozen — unfreeze this row before deleting it');
    expect(screen.getByRole('menuitem', { name: 'Unfreeze' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeDefined();

    // And it really is refused. The item carries the real `deleteRow`, so this
    // is the whole guard: with `refusedBecause` unread in `takeAction` the row
    // goes.
    // Proof: the `refusedBecause` line removed from `takeAction`, this failed
    // on `expected [ { id: 'w1', …(16) }, …(1) ] to have a length of 3 but got
    // 2`. Watched, 2026-08-09.
    fireEvent.click(remove);
    await Promise.resolve();
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(api.rows).toHaveLength(3);
    // The menu stays open, because the sentence saying why is on the item.
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDefined();
  });
});

describe('live edits from other people', () => {
  itDom('focuses a newly created row so the next keystroke lands in it', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    const first = await screen.findByLabelText('Name of 010');
    pressNewItem('010');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(document.activeElement).not.toBe(first);
  });

  itDom('refetches when the subscription reports a change', async () => {
    const api = fakeApi();
    // Throws rather than doing nothing: if the component never subscribes, this
    // test should fail loudly instead of quietly asserting a tree that never
    // needed refreshing.
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    let unsubscribed = false;
    const seen: number[] = [];
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return {
        seen: (seq: number) => seen.push(seq),
        unsubscribe: () => {
          unsubscribed = true;
        },
      };
    };

    const view = render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(1);
    });

    // Somebody else's edit, arriving through the socket rather than this client.
    await api.create('p1', { parentId: null, afterId: null, name: 'Theirs' });
    notify();

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });

    // The stream resumes from what the table read, so every read must report
    // where it landed — otherwise the next reconnect asks for a range that
    // starts before the rows already on screen.
    expect(seen.at(-1)).toBe(api.rows.length - 1);

    view.unmount();
    expect(unsubscribed).toBe(true);
  });

  itDom('says so while the connection is down', async () => {
    // A table that looks identical whether or not it is live is the failure this
    // is here to remove: other people's edits stop arriving silently.
    const api = fakeApi();
    let report: (connected: boolean) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      report = handlers.onConnectionChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };

    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(1);
    });
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      report(false);
    });
    expect(screen.getByRole('status').textContent).toContain('Reconnecting');

    act(() => {
      report(true);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('collapsing a branch', () => {
  itDom('hides the children of a collapsed parent and brings them back', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    unfoldRole('Dev');

    click('Collapse 010');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    // The parent is still there and still shows its rolled-up figures; only the
    // work beneath it is folded away.
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();

    click('Expand 010');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
  });

  itDom('offers no expander on a leaf', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');

    expect(screen.queryByLabelText('Collapse 010')).toBeNull();
    expect(screen.queryByLabelText('Expand 010')).toBeNull();
  });
});

describe('teams and assignees', () => {
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    // Dev only, and QA deliberately left folded: the folded cell is where the
    // every-phase assumption is read, beside the figure. A second unfold
    // would have folded this one until `unfolding-may-scroll`; it would leave
    // both open now, and this fixture wants one of each.
    unfoldRole('Dev');
    return api;
  }

  /** The entries a creatable picker is offering, scoped to its own listbox. */
  const offeredIn = (label: string) => {
    const list = screen
      .queryAllByRole('listbox')
      .find((box) => box.getAttribute('aria-label') === label);
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  };

  itDom('reads the team out of the set, not the column beside it', async () => {
    // The switch this change is: `work_item_team` is the read, and
    // `serviceTeamId` is a second copy be-01 keeps written for one release so
    // that the outgoing fe-01 bundle still works mid-swap. Every other test
    // here has both written and agreeing, so none of them can tell which one
    // this cell is reading — this one states them apart, which is also what
    // R2-4's payload looks like once the column becomes the derived copy.
    //
    // Proof: `effectiveTeamLabelOf`'s own-set arm pointed back at
    // `row.serviceTeamId`, and this failed on `expected 'Platform — inherited
    // from 010 (unname…' to be null` — the cell telling a reader it inherits
    // its team from itself — 1 failed / 425 passed; watched 2026-08-14. The
    // value assertion alone stays green under that fault, because the picker's
    // value is a second read of the same set: which arm answered is the part
    // only the title can say.
    const api = await oneRow();
    await api.addTeam('Platform');
    const [row] = api.rows;
    row.teamIds = ['team1'];
    row.serviceTeamId = null;
    // A refresh the component will take: adding a row is the cheapest.
    click('Add work item');
    await screen.findByLabelText('Name of 020');

    const box = screen.getByLabelText<HTMLInputElement>('Service or team for 010');
    expect(box.value).toBe('Platform');
    // And it is the row's **own** team, not one it is told it inherits: the
    // two arms of `effectiveTeamLabelOf` read different things, and only the
    // second one leaves a title on the cell.
    expect(box.getAttribute('title')).toBeNull();
  });

  itDom('adds a team by typing a name the list does not have', async () => {
    const api = await oneRow();
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Platform' } });
    expect(offeredIn(label)).toEqual(['Add “Platform”']);
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe('team1');
    });
  });

  itDom('offers an existing team rather than adding a second one', async () => {
    const api = await oneRow();
    await api.addTeam('Platform');
    // Added behind the component's back, so a refresh has to bring it in —
    // adding a row is the cheapest one to trigger.
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'plat' } });

    // A partial match offers the team *and* the chance to add a team actually
    // called `plat` — both are things somebody might mean.
    expect(offeredIn(label)).toEqual(['Platform', 'Add “plat”']);

    // The exact name offers no "Add": that is how a list grows a second
    // `Platform`, and be-01 is idempotent by name because it will be tried
    // from two browsers at once anyway.
    fireEvent.change(picker, { target: { value: 'Platform' } });
    expect(offeredIn(label)).toEqual(['Platform']);
  });

  /**
   * `wbs-team-picker-substitutes`, finding 2 of the 2026-08-22 planning QA:
   * typed `QA` into a new plan's team cell, pressed Enter, got
   * `claire qa billing`.
   *
   * The shared directory is not the fault — `service_team`'s own comment says
   * every project draws from one list on purpose, so a team somebody else made
   * belongs on offer. The fault is that Enter took it: a name typed in full
   * lost to a name it merely sits inside, with nothing on screen distinguishing
   * "made the team I named" from "joined one that is already carrying four
   * other plans' load". The knock-on is a schedule levelled against capacity
   * the planner never chose.
   */
  itDom('creates the name typed rather than joining one that merely contains it', async () => {
    const api = await oneRow();
    await api.addTeam('claire qa billing');
    // Added behind the component's back, so a refresh has to bring it in.
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'QA' } });

    // The order *is* the fix: the first line is the line Enter takes, so the
    // new team stands above the name that happens to contain those letters —
    // which is still offered, because joining it is a thing somebody might
    // mean, just not the thing they said.
    expect(offeredIn(label)).toEqual(['Add “QA”', 'claire qa billing']);
    // And the box says which line that is, for a reader who cannot see it.
    expect(picker.getAttribute('aria-activedescendant')).toBe(
      screen.getByText('Add “QA”').getAttribute('id'),
    );

    fireEvent.keyDown(picker, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe('QA');
    });
    // The stranger's team is untouched and still there: nothing was renamed
    // and nothing was joined.
    expect((await api.listTeams()).map((team) => team.name)).toEqual(['claire qa billing', 'QA']);
  });

  /**
   * The case that makes the reorder a rule rather than "Enter always creates".
   *
   * A leading match is autocomplete and has to keep winning, or every planner
   * half-way through spelling `Platform` gets a second team called `plat` —
   * which is the exact duplicate-directory harm the `Add` line is guarded
   * against in the first place.
   */
  itDom('still takes the team it is half-way through spelling', async () => {
    const api = await oneRow();
    const platform = await api.addTeam('Platform');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'plat' } });
    expect(offeredIn(label)).toEqual(['Platform', 'Add “plat”']);
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe(platform.id);
    });
    expect((await api.listTeams()).map((team) => team.name)).toEqual(['Platform']);
  });

  /**
   * The other half of the QA report — typed `Backend`, got `backend` — and it
   * is the one thing in that finding which is right. An exact match case aside
   * is the team, and joining it is what stops the directory growing a second
   * spelling of one name. Pinned because the ranking above sorts on the same
   * comparison and could lose it.
   */
  itDom('joins the team already spelled that way in another case', async () => {
    const api = await oneRow();
    const backend = await api.addTeam('backend');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Backend' } });
    expect(offeredIn(label)).toEqual(['backend']);
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe(backend.id);
    });
    expect((await api.listTeams()).map((team) => team.name)).toEqual(['backend']);
  });

  itDom('assigns a person who is in no team as a free agent', async () => {
    const api = await oneRow();
    const label = 'Dev assignee for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Ada' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe('Ada');
    });
    const people = await api.listPeople();
    expect(people).toEqual([{ id: 'person1', name: 'Ada', teamIds: [] }]);
  });

  itDom('joins a new person to the work item’s team', async () => {
    const api = await oneRow();
    const team = await api.addTeam('Billing');
    await api.patch('w1', { serviceTeamId: team.id });
    // The tree has to come back carrying the team before the assignee picker
    // can act on it.
    const teamPicker = screen.getByLabelText('Service or team for 010');
    fireEvent.focus(teamPicker);
    fireEvent.change(teamPicker, { target: { value: 'Billing' } });
    fireEvent.keyDown(teamPicker, { key: 'Enter' });
    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe(team.id);
    });

    const picker = screen.getByLabelText('Dev assignee for 010');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Grace' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(async () => {
      expect(await api.listPeople()).toContainEqual({
        id: 'person1',
        name: 'Grace',
        teamIds: [team.id],
      });
    });
  });

  itDom('says the single assignee is doing the other phase too', async () => {
    await oneRow();

    const picker = screen.getByLabelText('Dev assignee for 010');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Ada' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Dev assignee for 010').value).toBe('Ada');
    });
    // The QA cell is empty and says who is assumed to be covering it — which
    // is a reading of one assignment, not a second one written down.
    expect(rowFor('010').querySelector('[data-assumed]')?.textContent).toBe('· (AD)');
  });
});

describe('the plan on a calendar', () => {
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  itDom('shows day offsets until the project has a start date', async () => {
    await oneRow();

    expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('0');
  });

  itDom('shows dates once the project starts on a day, as somebody reads one', async () => {
    // `2026-08-06` in a 52px column, for a reader who already knows what year
    // it is. The whole day stays in the cell's `title`, so the shortening
    // costs nothing.
    // Proof: `printedDay` made to hand back the raw `iso` as its `text`, this
    // failed on `expected '2026-08-06' to be '6 Aug'`. Watched, 2026-08-09.
    const api = await oneRow();

    typeIntoDate('Project start date', '2026-08-06');

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('6 Aug');
    });
    // The day and then what holds it there, the `End` cell's own two-facts
    // shape. This assertion read `toBe('2026-08-06')` until `row-start-floor`
    // put the floor sentence beside it, and the change is why it is spelled out
    // rather than loosened to `toContain`: what a reader is shown on hover is
    // exactly this, dash and all.
    expect(rowFor('010').querySelector('[data-start]')?.getAttribute('title')).toBe(
      '2026-08-06 — Starts with the project',
    );
    expect(rowFor('010').querySelector('[data-finish]')?.textContent).toContain('6 Aug');
    expect(rowFor('010').querySelector('[data-finish]')?.getAttribute('title')).toContain(
      '2026-08-06',
    );
    expect(api.rows.length).toBe(1);
  });

  itDom('carries the year on a day that is not in this one', async () => {
    // The omission is only unambiguous while it is the reader's own year, so a
    // plan that runs into another one says which.
    const today = new Date();
    await oneRow();

    typeIntoDate('Project start date', `${String(today.getFullYear() + 1)}-06-01`);

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe(
        `1 Jun ${String(today.getFullYear() + 1)}`,
      );
    });
  });

  itDom('leaves the workday offsets alone while the plan has no start date', async () => {
    // The fallback this change did not touch: without a project start date
    // there are no dates to shorten, and the columns print day numbers with no
    // fuller day to put in a `title`.
    //
    // The floor sentence is there anyway, and that is the point of asserting it
    // here rather than deleting the line: what holds a row's start is a fact
    // about the plan's shape, not about the calendar it has not been put on, so
    // it is the one thing this cell can say on a plan with no dates at all.
    await oneRow();

    expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('0');
    expect(rowFor('010').querySelector('[data-start]')?.getAttribute('title')).toBe(
      'Starts with the project',
    );
  });

  itDom('says a row is waiting on a dependency where its Start does not look like it', async () => {
    // The fault this whole task is about, in one row pair: `020` waits for
    // `010`, and a reader who compares `020`'s Start against `010`'s End
    // concludes the tool is broken. `dep-waits-on-first-role` is why it is not,
    // and this is the line that says so.
    // Built through the api before the render, the way the picker's fixtures
    // are: the shape is the fixture here, not the thing under test.
    const api = fakeApi();
    const strip = await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });
    const paint = await api.create('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    await api.addDependency(paint.id, strip.id);
    // Five days on `Strip`'s Dev and a **Tuesday** start, so the day this cell
    // names is neither the plan's start date nor a count of calendar days: the
    // fifth working day from Tuesday 1 Sep is Monday 7 Sep.
    await api.setEstimate(strip.id, DEV.id, { optimistic: 5, realistic: 5, pessimistic: 5 });
    // `020` gets an estimate of its own too, so the row under test owns a real
    // slice rather than an empty one. It does not move the day this cell shows,
    // and the assertion below says why.
    await api.setEstimate(paint.id, DEV.id, { optimistic: 2, realistic: 2, pessimistic: 2 });
    await api.setStartDate('p1', '2026-09-01');
    // The clock is pinned for this case alone, and it is the assertion below
    // that needs it: `<WbsTable>` hands `startFloorByRow` a `today` of
    // `new Date()`, and `shortIsoDate` drops a date's year only while it
    // matches the reader's own — so `finishes 7 Sep` becomes `finishes 7 Sep
    // 2026` on the first run of 2027 and this case fails on a calendar page
    // turning rather than on anything in the code. The day is
    // `gantt-geometry.test.ts`'s `calendarOf()`'s, so the two specs pin one
    // reader's today and not two.
    //
    // `shouldAdvanceTime` because everything below it is async RTL: a frozen
    // clock stops `findBy*`'s polling and the render never resolves. Restored
    // in `finally` and not after the expectations, so a red case cannot leave
    // a mocked clock to the ~500 that follow it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    try {
      render(<WbsTable projectId="p1" api={api} />);
      await screen.findByLabelText('Name of 020');

      // The whole title through the real call site, day and sentence, spelled out
      // dash and all for the same reason the calendar case above is: this cell now
      // joins ` — ` twice, and `e2e/gantt.spec.ts:218` splits on it.
      //
      // `finishes 7 Sep` is the part that proves something, and the leading
      // `2026-09-01` is not: this fake gives EVERY row `dates: { startsOn:
      // startDate }` (see `tree()`), so the day in front is a constant and would
      // read `2026-09-01` whatever the row waited for. The day inside the sentence
      // is computed here and nowhere else — five working days from a **Tuesday**
      // start is Monday the 7th, not the 5th — and `<WbsTable>` is the only thing
      // that hands `startFloorByRow` a calendar, so a stubbed or forgotten second
      // argument is invisible to every unit test of the function itself.
      expect(rowFor('020').querySelector('[data-start]')?.getAttribute('title')).toBe(
        '2026-09-01 — Waits for Strip (Dev) — finishes 7 Sep',
      );
      // Not the successor's own sentence on the row it waits for: the two cells
      // answer for themselves, which a single shared string would hide.
      expect(rowFor('010').querySelector('[data-start]')?.getAttribute('title')).toBe(
        '2026-09-01 — Starts with the project',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('will not take an earliest start while the plan has no start date', async () => {
    // Without a project start date there is no day zero, so be-01 ignores the
    // constraint entirely. A date that saves and does nothing is worse than a
    // field that will not take one — this shipped and was found on dev.
    await oneRow();

    const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');

    expect(cell.disabled).toBe(true);
    expect(cell.title).toContain('project start date');
    // And the columns say which of the two they are showing.
    // And the column says which of the two it is showing — in its `title`,
    // because the heading itself is one word wide now.
    expect(headerTitled('Start')).toContain('days from the start of the plan');
  });

  itDom('takes one once the plan is on a calendar, and drops the "(day)" wording', async () => {
    await oneRow();

    typeIntoDate('Project start date', '2026-08-06');

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    // Scoped to the column headers: the toolbar has a "Starts" label of its own.
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.trim());
    expect(headers).toContain('Start');
    expect(headerTitled('Start')).not.toContain('days from the start of the plan');
  });

  itDom('gives every heading on screen the sentence its column carries', async () => {
    // The seam, asserted where the columns actually render: `column-hints.ts`
    // has its own unit test for the copy, and this is the one that says the
    // copy reaches the reader — on the `<th>`, for every column the table put
    // on screen, with nothing left saying only what it is called.
    //
    // Read through `hintFor` rather than against a written-out list, because a
    // list here is a second place to add a column to and the whole point of the
    // seam is that there is one.
    await oneRow();

    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(5);
    for (const th of headers) {
      const columnId = th.getAttribute('data-column') ?? '';
      expect(th.getAttribute('title')).toBe(hintFor(columnId, { hasProjectStartDate: false }));
    }
  });

  itDom('holds a date typed one segment at a time, and saves the one that was typed', async () => {
    // The fault, exactly as a browser produces it. A native date input fires a
    // `change` for **every completed segment**, so typing the year `2026` fires
    // four of them and the first three are dates in years 2, 20 and 202. Each
    // was committed, each commit refetched the project, and the controlled box
    // was re-rendered from be-01's answer mid-word — so the year segment reset
    // under the caret and the rest of the digits went nowhere. A plan was saved
    // starting in **year 0002**; observed in Chrome on 2026-08-09.
    //
    // Proof: `commit` moved back onto an `onChange` in `DateField`, this failed
    // on `expected [ '0002-08-17', '0020-08-17', …(2) ] to deeply equal []`,
    // and its `Not before` twin on `expected [ …(4) ] to deeply equal []`.
    // Watched, 2026-08-09.
    const api = await oneRow();
    const sent: (string | null)[] = [];
    const realSet = api.setStartDate.bind(api);
    api.setStartDate = (projectId: string, day: string | null) => {
      sent.push(day);
      return realSet(projectId, day);
    };

    const box = screen.getByLabelText<HTMLInputElement>('Project start date');
    box.focus();
    typeYearInto(box);

    expect(sent).toEqual([]);

    fireEvent.blur(box);

    await waitFor(() => {
      expect(sent).toEqual(['2026-08-17']);
    });
    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('17 Aug');
    });
  });

  itDom('holds a row’s earliest start the same way, and sends it once', async () => {
    // The same fault in the other date field on the page: `26.08.0002` was
    // typed into a row's `Not before` and saved, on the same pass.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const patched: unknown[] = [];
    const realPatch = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      patched.push(patch);
      return realPatch(id, patch);
    };

    const box = openNotBefore('010');
    box.focus();
    typeYearInto(box);

    expect(patched).toEqual([]);

    fireEvent.blur(box);

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThan: '2026-08-17' }]);
    });
  });

  itDom('takes Enter as "I have finished typing this date"', async () => {
    // The one way to send a date without leaving the field, so a keyboard is
    // not obliged to Tab out of a box to save what is in it.
    // Proof: the `Enter` branch removed from `DateField`, this failed on
    // `expected [] to deeply equal [ '2026-08-17' ]`. Watched, 2026-08-09.
    const api = await oneRow();
    const sent: (string | null)[] = [];
    const realSet = api.setStartDate.bind(api);
    api.setStartDate = (projectId: string, day: string | null) => {
      sent.push(day);
      return realSet(projectId, day);
    };

    const box = screen.getByLabelText<HTMLInputElement>('Project start date');
    box.focus();
    fireEvent.change(box, { target: { value: '2026-08-17' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(sent).toEqual(['2026-08-17']);
    });
    // And leaving afterwards sends nothing more: the box and the server agree.
    fireEvent.blur(box);
    await Promise.resolve();
    expect(sent).toEqual(['2026-08-17']);
  });

  itDom('sends a work item’s earliest start, and clears it again', async () => {
    const api = await oneRow();
    // The field only takes a date once the plan is on a calendar.
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const patched: unknown[] = [];
    const realPatch = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      patched.push(patch);
      return realPatch(id, patch);
    };

    typeIntoNotBefore('010', '2026-08-12');
    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThan: '2026-08-12' }]);
    });

    // Cleared reads as '' from a date input, and means "no constraint" rather
    // than "an empty date" — and it takes the words about that date with it,
    // because be-01 refuses the pair the other way round. See the test below.
    typeIntoNotBefore('010', '');

    await waitFor(() => {
      expect(patched).toEqual([
        { startNoEarlierThan: '2026-08-12' },
        { startNoEarlierThan: null, startNoEarlierThanReason: null },
      ]);
    });
  });

  itDom('clears the words with the day, in the one request', async () => {
    // The pair rule is be-01's, since `not-before-reason` (#81): a reason with
    // no date to be about is `not_before_reason_needs_a_date`, **400**. So a
    // bare `{ startNoEarlierThan: null }` stops clearing the date on exactly
    // the rows somebody has taken the trouble to explain, and it fails in their
    // face rather than quietly.
    //
    // Proof: `startNoEarlierThanReason: null` dropped from the null arm of
    // `setNotBefore`, this fails on `expected [ { startNoEarlierThan: null } ]
    // to deeply equal [ { startNoEarlierThan: null, startNoEarlierThanReason:
    // null } ]`. Watched, 2026-08-18.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const explained = api.rows.at(0);
    if (explained === undefined) throw new Error('the plan has no row');
    explained.startNoEarlierThan = '2026-09-12';
    explained.startNoEarlierThanReason = 'waiting on client sign-off';
    // A refetch, so the table is showing the explained row rather than the
    // blank one it created.
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe(
        '12 Sep',
      );
    });

    const patched: unknown[] = [];
    const realPatch = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      patched.push(patch);
      return realPatch(id, patch);
    };

    typeIntoNotBefore('010', '');

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThan: null, startNoEarlierThanReason: null }]);
    });
  });

  itDom('takes the words about the date, and does not shut on the way to them', async () => {
    // Two boxes, one editor. `DateField`'s `onExit` reports the blur and not
    // where the focus went, so the cell's wrapper is what asks — `focusout`
    // bubbles and carries `relatedTarget`.
    //
    // Proof: the wrapper's `contains(relatedTarget)` guard replaced by a bare
    // `close()`, this fails on `expected null not to be null` — the panel shuts
    // on the way to the reason box and there is nothing left to type into.
    // Watched, 2026-08-18.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const patched: unknown[] = [];
    const realPatch = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      patched.push(patch);
      return realPatch(id, patch);
    };

    const editor = openNotBefore('010');
    const reason = screen.getByLabelText<HTMLInputElement>('Why 010 may not start earlier');

    fireEvent.blur(editor, { relatedTarget: reason });

    expect(screen.queryByLabelText('Why 010 may not start earlier')).not.toBeNull();

    // Trimmed on the way out, so there is one spelling of every sentence.
    fireEvent.change(reason, { target: { value: '  waiting on client sign-off  ' } });
    fireEvent.blur(reason);

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThanReason: 'waiting on client sign-off' }]);
    });
    // And that blur had nowhere inside the editor to go, so it closed it.
    expect(screen.queryByLabelText('Why 010 may not start earlier')).toBeNull();
  });

  itDom('spells an emptied reason box as “nobody has said”', async () => {
    // `null`, not `''`: one spelling of the absence, which is the same call the
    // Prio cell makes about an emptied number and the one thing be-01 cannot
    // see from a request that omits the field.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const explained = api.rows.at(0);
    if (explained === undefined) throw new Error('the plan has no row');
    explained.startNoEarlierThan = '2026-09-12';
    explained.startNoEarlierThanReason = 'waiting on client sign-off';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe(
        '12 Sep',
      );
    });

    const patched: unknown[] = [];
    const realPatch = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      patched.push(patch);
      return realPatch(id, patch);
    };

    openNotBefore('010');
    const reason = screen.getByLabelText<HTMLInputElement>('Why 010 may not start earlier');
    // The box opens holding what the server said, which is the other half of
    // this: a reader edits the sentence rather than retyping it.
    expect(reason.value).toBe('waiting on client sign-off');
    fireEvent.change(reason, { target: { value: '' } });
    fireEvent.blur(reason);

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThanReason: null }]);
    });
  });

  itDom('says why the date is there, on the cell at rest', async () => {
    // Appended, never substituted — the same bargain `floorWordsOf` strikes on
    // the bar. What the constraint *does* is the part a reader cannot work out;
    // what it is *for* is the part only a planner can say.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const explained = api.rows.at(0);
    if (explained === undefined) throw new Error('the plan has no row');
    explained.startNoEarlierThan = '2026-09-12';
    explained.startNoEarlierThanReason = 'waiting on client sign-off';
    click('Add work item');

    await waitFor(() => {
      const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');
      expect(cell.title).toBe(
        '2026-09-12. This work item may not start before this day. Its dependencies can still push it later. Why: waiting on client sign-off',
      );
    });
    // And a row nobody has explained says exactly what it said before.
    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 020').title).toBe(
      'This work item may not start before this day. Its dependencies can still push it later.',
    );
  });
});

describe('the priority cell', () => {
  /** Two empty root rows, and the api the table is driving. */
  async function twoRows() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    return api;
  }

  /** Every PATCH the table sends, still performed. */
  const watchPatches = (api: ProjectApi): unknown[] => {
    const seen: unknown[] = [];
    const perform = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      seen.push(patch);
      return perform(id, patch);
    };
    return seen;
  };

  const priorityCell = (number: string): HTMLInputElement =>
    screen.getByLabelText<HTMLInputElement>(`Priority for ${number}`);

  /** Types into the cell and leaves it, which is when a `CellInput` commits. */
  const typeIntoPriority = (number: string, text: string): void => {
    const cell = priorityCell(number);
    fireEvent.focus(cell);
    fireEvent.change(cell, { target: { value: text } });
    fireEvent.blur(cell);
  };

  /** This row's priority cell as the refusal map keys it — `rowId::priority`. */
  const priorityCellKey = (number: string): string => {
    const key = priorityCell(number).dataset['cell'];
    // The box is a `CellInput`, which requires a `cellKey` and renders it as
    // `data-cell`. A cell without one is a bug in the wiring, not a state.
    if (key === undefined) throw new Error(`The priority cell of ${number} carries no data-cell.`);
    return key;
  };

  itDom('is blank on every row of a plan nobody has given priorities', async () => {
    // No placeholder and no em-dash. A priority is a scale, and a hint on every
    // empty cell of every row is a wall of grey saying nothing — Dany's
    // compaction, 2026-08-08.
    await twoRows();

    for (const number of ['010', '020']) {
      expect(priorityCell(number).value).toBe('');
      expect(priorityCell(number).placeholder).toBe('');
    }
  });

  itDom('sends what was typed and shows what came back', async () => {
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '2');

    await waitFor(() => {
      expect(patched).toEqual([{ priority: 2 }]);
    });
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('2');
    });
  });

  itDom('clears the priority when the cell is emptied, rather than sending a zero', async () => {
    // `Number('')` is 0, and 0 is a priority be-01 refuses. An emptied box is the
    // one reading this client makes on its own.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '3');
    await waitFor(() => {
      expect(patched).toEqual([{ priority: 3 }]);
    });

    typeIntoPriority('010', '');

    await waitFor(() => {
      expect(patched).toEqual([{ priority: 3 }, { priority: null }]);
    });
  });

  itDom('sends a number be-01 will refuse rather than deciding for it', async () => {
    // `0`, `-1` and `1.5` go out and come back refused, exactly as a bad name
    // does. The rule about what a priority may be is be-01's, and a second copy of
    // it here is a rule that can quietly disagree with the one that counts.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '0');
    await waitFor(() => {
      expect(patched).toEqual([{ priority: 0 }]);
    });

    typeIntoPriority('020', '1.5');
    await waitFor(() => {
      expect(patched).toEqual([{ priority: 0 }, { priority: 1.5 }]);
    });
  });

  itDom('says so, and sends nothing, when what was typed is not a number at all', async () => {
    // The one refusal this client makes alone, and only because it cannot ask:
    // JSON has no literal for `NaN`, so a request carrying one arrives as
    // `null` — which is the request that clears a priority. Silently clearing
    // somebody's priority because they typed a letter is the fault this avoids.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', 'urgent');

    await waitFor(() => {
      expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
    });
    expect(patched).toEqual([]);
  });

  itDom(
    'says so, and sends nothing, when what was typed is a number too big to be one',
    async () => {
      // `1e999` is the trap the same guard already has to survive on a stored
      // column width (`rememberedWidthOverrides`, `wbs-table.tsx`): `Number` reads
      // it as `Infinity`, which is not `NaN` and would pass a `Number.isNaN`
      // check — and JSON has no literal for `Infinity` either, so the request
      // arrives at be-01 as `{"priority":null}`, which is the request that
      // **clears** a priority. Somebody's priority silently wiped by a typo is
      // the fault this refuses; the guard is `Number.isFinite`, not `isNaN`.
      //
      // The patch is recorded as the wire sees it — through `JSON.stringify` —
      // because `Infinity` in a JS object is not the value that arrives, and a
      // test watching the object alone cannot see the loss.
      const api = await twoRows();
      const onTheWire: unknown[] = [];
      const perform = api.patch.bind(api);
      api.patch = (id: string, patch: Record<string, unknown>) => {
        onTheWire.push(JSON.parse(JSON.stringify(patch)));
        return perform(id, patch);
      };

      typeIntoPriority('010', '1e999');

      await waitFor(() => {
        expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
      });
      expect(onTheWire).toEqual([]);
    },
  );

  itDom('sends what was typed on Enter, without waiting for the cell to be left', async () => {
    // Enter is the keystroke a number goes in with, and until this it sent
    // nothing at all: the dates under the plan sat still until the reader
    // happened to click elsewhere. Observed live on dev, Group D, 2026-08-11.
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = priorityCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '1' } });
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(patched).toEqual([{ priority: 1 }]);
    });
    // The caret stays where it is. Moving on is the chord's — Ctrl/⌘ + Enter
    // saves and lands in the next row — and a bare Enter that also moved would
    // be a second chord wearing the first one's key.
    expect(document.activeElement).toBe(priorityCell('010'));
  });

  itDom('sends one request for a priority entered with Enter and then left', async () => {
    // Rule 5 of `LiveField`: `shown` has not advanced while the request is out,
    // so the blur that follows an Enter looks exactly like a fresh edit unless
    // the submission already recorded is what answers it. Two patches here
    // would be two journal entries and two Ctrl/⌘ + Zs for one typed number.
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = priorityCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '4' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.blur(cell);

    await waitFor(() => {
      expect(priorityCell('010').value).toBe('4');
    });
    expect(patched).toEqual([{ priority: 4 }]);
  });

  itDom('leaves Ctrl/⌘ + Enter to the chord, which saves and moves on', async () => {
    // The modifier guard on the bare-Enter branch, and the negative that says
    // it can fail: without it the branch consumes the chord, so a save that
    // was supposed to land in the next row leaves the caret in Prio.
    // Proof: the four modifier tests dropped from that branch, this failed on
    // `expected <input aria-label="Priority for 010" …> to be <textarea
    // aria-label="Name of 020" …>`. Watched, 2026-08-11.
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = priorityCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2' } });
    fireEvent.keyDown(cell, { key: 'Enter', code: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(patched).toEqual([{ priority: 2 }]);
  });

  itDom('shows the draft just refused, not the one refused before it', async () => {
    // A refusal is held so the only copy of what somebody typed is not lost
    // (`LiveField`, rule 4) — and what has to be held is the *newest* of them.
    // Typing over a refused draft and being refused again put the previous
    // draft back on screen: the number on the row was one nobody had typed for
    // several seconds. Observed live on dev, Group D, 2026-08-11.
    await twoRows();

    typeIntoPriority('010', '1e999');
    await waitFor(() => {
      expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
    });
    expect(priorityCell('010').value).toBe('1e999');

    typeIntoPriority('010', 'urgent');

    await waitFor(() => {
      expect(refusedDraftFor(priorityCellKey('010'))).toBe('urgent');
    });
    expect(priorityCell('010').value).toBe('urgent');

    // Emptying the box is how a draft is abandoned rather than retried, and it
    // is what keeps this test's refusal out of the next one's map.
    typeIntoPriority('010', '');
    await waitFor(() => {
      expect(refusedDraftFor(priorityCellKey('010'))).toBeUndefined();
    });
  });

  itDom('draws the number in its band’s colour and names the band in the title', async () => {
    // Dany, 2026-08-13: "ui must display differently for different priorities".
    // The cell's **ink**, not a background: the column is 48px of right-aligned
    // digits between two bordered cells, and a filled swatch there reads as a
    // selection. The colour is `priorityBandStyleOf`'s, which is the same one the
    // chart's cap, the cards' chip and the export's column resolve through.
    //
    // Proof: the `color: paint?.ink` line deleted from `PriorityCell`, and this
    // failed on `expected '' not to be ''` — a Critical row and a Lowest row
    // drawn in one ink. Watched 2026-08-14.
    const api = await twoRows();
    typeIntoPriority('010', '5');
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('5');
    });
    typeIntoPriority('020', '90');
    await waitFor(() => {
      expect(priorityCell('020').value).toBe('90');
    });
    void api;

    const critical = priorityCell('010').style.color;
    const lowest = priorityCell('020').style.color;
    expect(critical).not.toBe('');
    expect(lowest).not.toBe('');
    expect(critical).not.toBe(lowest);
    // And the name is in the hover text, because a colour alone is a fact only a
    // reader who already knows the ladder can read.
    expect(priorityCell('010').title).toContain('Critical — priority 5');
    expect(priorityCell('020').title).toContain('Lowest — priority 90');
  });

  itDom('leaves an unprioritised cell the table’s own ink and offers no band', async () => {
    // The bargain every face makes with an unranked row: nothing at all rather
    // than a grey chip reading `—`.
    await twoRows();

    expect(priorityCell('010').style.color).toBe('');
    expect(priorityCell('010').title).toContain('Blank means nobody has said');
  });

  itDom('opens the five bands on a click, and taking one writes the number it says', async () => {
    // Dany's "select priority by labels", as the picker. The line carries the
    // number as well as the name because taking it **stores** that number, and a
    // picker that hid what it was about to write would leave the reader unable to
    // predict the digits that appear in the box.
    const api = await twoRows();
    const patched = watchPatches(api);

    fireEvent.click(priorityCell('010'));
    const list = screen.getByRole('listbox', { name: 'Priority bands for 010' });
    expect([...list.querySelectorAll('[role="option"]')].map((each) => each.textContent)).toEqual([
      'Critical — 10',
      'High — 30',
      'Medium — 50',
      'Low — 70',
      'Lowest — 90',
    ]);

    fireEvent.click(screen.getByText('High'));
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('30');
    });
    // One request and one journal entry, through the same `setPriority` a typed
    // number reaches — which is what makes the two languages round-trip into each
    // other rather than into two histories.
    expect(patched).toEqual([{ priority: 30 }]);
  });

  itDom('does not open the band list merely because the caret landed here', async () => {
    // The one place this departs from `CreatablePicker`, and it is a departure
    // with a mechanical reason as well as a taste one: opening on focus is a
    // `setState` during the focus that lands in this box, so `CellInput`'s inline
    // `ref` runs again, `LiveField.takeNode` re-attaches, and a refusal held for
    // this cell is written back over the draft somebody is part-way through.
    //
    // Proof: the `onClick` moved onto the wrapper's `onFocus`, and three cases in
    // this describe went red — `sends what was typed on Enter` with no request at
    // all, and `sends one request for a priority entered with Enter and then
    // left` holding a previous case's refused `1e999`. Watched 2026-08-14.
    await twoRows();

    fireEvent.focus(priorityCell('010'));

    expect(screen.queryByRole('listbox', { name: 'Priority bands for 010' })).toBeNull();
  });

  itDom('takes a band’s name typed into the box, and stores the number it writes', async () => {
    // The keyboard's way to the same five lines, and the reason the grid needs no
    // chord for the picker: `high` in this box is 30. Case-insensitive and
    // trimmed, because a name typed by hand is not a name copied out of a list.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '  MEDIUM ');
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('50');
    });

    expect(patched).toEqual([{ priority: 50 }]);
    // And it round-trips: the number that was stored resolves back to the band
    // whose name was typed.
    expect(priorityCell('010').title).toContain('Medium — priority 50');
  });

  itDom('still refuses a word that is no band’s name, rather than clearing the row', async () => {
    // `Number('urgent')` is `NaN` and `NaN` on the wire is `null`, which is the
    // clear — so a typo would silently unprioritise the row. `priorityTyped`
    // deliberately hands anything it does not recognise straight back to
    // `setPriority`, which has refused it out loud since `priority-column`.
    const api = await twoRows();
    typeIntoPriority('010', '7');
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('7');
    });
    const patched = watchPatches(api);

    typeIntoPriority('010', 'urgent');
    await waitFor(() => {
      expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
    });
    expect(patched).toEqual([]);

    // As above: the draft is abandoned so this test's refusal does not reach the
    // next one's map.
    typeIntoPriority('010', '');
    await waitFor(() => {
      expect(refusedDraftFor(priorityCellKey('010'))).toBeUndefined();
    });
  });
});

describe('the In-parallel cell', () => {
  /** Two empty root rows, and the api the table is driving. */
  async function twoRows() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    return api;
  }

  /** Every PATCH the table sends, still performed. */
  const watchPatches = (api: ProjectApi): unknown[] => {
    const seen: unknown[] = [];
    const perform = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      seen.push(patch);
      return perform(id, patch);
    };
    return seen;
  };

  const parallelCell = (number: string): HTMLInputElement =>
    screen.getByLabelText<HTMLInputElement>(`People at once for ${number}`);

  /** Types into the cell and leaves it, which is when a `CellInput` commits. */
  const typeIntoParallel = (number: string, text: string): void => {
    const cell = parallelCell(number);
    fireEvent.focus(cell);
    fireEvent.change(cell, { target: { value: text } });
    fireEvent.blur(cell);
  };

  itDom('is blank on every row of a plan nobody has widened', async () => {
    // Blank and not `1`, which is what the column stores for every row of every
    // plan: a column of ones down the table is furniture, and the Prio column
    // one place back makes the same bargain for the same reason.
    await twoRows();

    for (const number of ['010', '020']) {
      expect(parallelCell(number).value).toBe('');
    }
  });

  itDom('sends what was typed and shows what came back', async () => {
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoParallel('010', '3');

    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 3 }]);
    });
    await waitFor(() => {
      expect(parallelCell('010').value).toBe('3');
    });
    // And the row beside it is untouched — one cell's write is one row's.
    expect(parallelCell('020').value).toBe('');
  });

  itDom(
    'resets to one at a time when the cell is emptied, rather than sending a zero',
    async () => {
      // `Number('')` is 0, and a width of 0 is a duration of `Infinity` — the
      // fault `capacity-write-paths` refuses 400 and `capacity-engine` throws on.
      // An emptied box plainly means one at a time, and `null` is how be-01
      // spells that.
      const api = await twoRows();
      const patched = watchPatches(api);

      typeIntoParallel('010', '4');
      await waitFor(() => {
        expect(patched).toEqual([{ maxParallel: 4 }]);
      });

      typeIntoParallel('010', '');
      await waitFor(() => {
        expect(patched).toEqual([{ maxParallel: 4 }, { maxParallel: null }]);
      });
      // Back to blank, because 1 renders as nothing.
      await waitFor(() => {
        expect(parallelCell('010').value).toBe('');
      });
    },
  );

  itDom('sends a number be-01 will refuse rather than deciding for it', async () => {
    // The rule about what a parallelism may be lives at be-01's boundary
    // (`capacity-write-paths`), and a second copy here is a rule free to
    // disagree with it — the Prio cell's own bargain, one column back.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoParallel('010', '0');
    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 0 }]);
    });

    typeIntoParallel('010', '1001');
    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 0 }, { maxParallel: 1001 }]);
    });
  });

  /**
   * Two rows over an api that answers every parallelism with one of be-01's
   * own words — the half of "send it and let be-01 answer" that nothing in this
   * file exercised: the test above asserts only that the number was **sent**.
   */
  async function twoRowsRefusing(code: string): Promise<void> {
    const api = fakeApi();
    const perform = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) =>
      'maxParallel' in patch ? Promise.reject(new Error(code)) : perform(id, patch);
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
  }

  itDom('says what a parallelism may be when be-01 refuses one', async () => {
    // Proof: the `maxParallel_must_be_a_whole_number_from_1` entry struck from
    // `REFUSAL_SENTENCES`, so the grammatical fallback carries the code. This
    // failed on `expected [ 'That change could not be completed
    // (maxParallel_must_be_a_whole_number_from_1).' ] to contain 'People at
    // once is a whole number of 1 or more…'` — the wire code in the corner of
    // the screen, which is the defect `not_found` and `http_500` were fixed for
    // on 2026-08-09 and the sibling size box avoids one screen away. Watched
    // 2026-08-13.
    await twoRowsRefusing('maxParallel_must_be_a_whole_number_from_1');

    typeIntoParallel('010', '0');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'People at once is a whole number of 1 or more. Empty the cell for one at a time.',
      );
    });
  });

  itDom('reads the ceiling out of be-01’s own word for it', async () => {
    // The limit is spelled into the code from be-01's `MOST_PEOPLE_AT_ONCE`, so
    // the sentence is built from what arrived rather than from a second copy of
    // 1000 here — `wbs-api.ts`'s bargain for the size box, for its reason.
    //
    // Proof: the prefix arm deleted. This failed on `expected [ 'That change
    // could not be completed (maxParallel_must_be_at_most_1000).' ] to contain
    // 'People at once is at most 1000.'`. Watched 2026-08-13.
    await twoRowsRefusing('maxParallel_must_be_at_most_1000');

    typeIntoParallel('010', '1001');

    await waitFor(() => {
      expect(toastTexts()).toContain('People at once is at most 1000.');
    });
  });

  itDom('says why a parent’s parallelism was refused, in the tree’s words', async () => {
    // `has_children` is be-01's, and it is only reachable through this cell:
    // the cell is read-only on every parent, so this is the row that gained a
    // child while the draft was open.
    //
    // Proof: the `has_children` entry struck. This failed on `expected [ 'That
    // change could not be completed (has_children).' ] to contain 'A row with
    // work under it…'`. Watched 2026-08-13.
    await twoRowsRefusing('has_children');

    typeIntoParallel('010', '3');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'A row with work under it runs no people of its own — set People at once on the rows beneath it.',
      );
    });
  });

  itDom('refuses a draft JSON cannot carry, rather than silently resetting the row', async () => {
    // `Number('1e999')` is `Infinity`, which `JSON.stringify` writes as `null`
    // — and `null` here is the **reset to one at a time**. A typed `1e999`
    // reaching be-01 would quietly put a widened row back to 1 while looking
    // like a refusal.
    //
    // Proof: the `Number.isFinite` guard deleted, watched failing on `Unable to
    // find an element with the text: /People at once is a whole number from 1
    // to 1000./` — nothing refused, and the `expect(patched).toEqual([])` below
    // it is what says where the draft went instead. Watched 2026-08-13.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoParallel('010', '1e999');

    await waitFor(() => {
      expect(screen.getByText(/People at once is a whole number from 1 to 1000\./)).toBeDefined();
    });
    expect(patched).toEqual([]);

    // Abandoning the draft keeps this test's refusal out of the next one's map.
    typeIntoParallel('010', '');
  });

  itDom('sends on Enter, without waiting for the cell to be left', async () => {
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = parallelCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2' } });
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 2 }]);
    });
    expect(document.activeElement).toBe(parallelCell('010'));
  });

  itDom('is printed and not editable on a row with children', async () => {
    // A parent holds no slices of its own, so `slicesOf` skips it and a number
    // on it schedules nothing — be-01 answers 400 `has_children`. The cell is
    // read-only rather than offering an edit that is refused, and it still
    // shows the inert number a leaf was given before it gained a child, which
    // is the state `capacity-write-paths` deliberately leaves standing.
    await twoRows();
    typeIntoParallel('010', '3');
    await waitFor(() => {
      expect(parallelCell('010').value).toBe('3');
    });

    // 020 goes under 010, which makes 010 a parent.
    pressTab('020');
    await waitFor(() => {
      expect(screen.queryByLabelText('Name of 010.1')).not.toBeNull();
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('People at once for 010')).toBeNull();
    });
    const printed = screen.getByTitle(/holds no work of its own/);
    expect(printed.textContent).toBe('3');
  });

  itDom('says a number is not applied where one person is named on the work', async () => {
    // C1's D3: one human cannot work beside themselves, so a named assignee
    // collapses the item to width 1 whatever the column says. The number is
    // still stored and applies the moment the assignment goes, so it is shown
    // and qualified rather than hidden.
    await twoRows();
    typeIntoParallel('010', '3');
    await waitFor(() => {
      expect(parallelCell('010').value).toBe('3');
    });
    expect(parallelCell('010').title).toContain('effort is compressed');

    // The assignee box lives in the unfolded role, which is where somebody
    // names a person on the work.
    unfoldRole('Dev');
    const picker = await screen.findByLabelText('Dev assignee for 010');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Kat' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(parallelCell('010').title).toContain('one at a time whatever this says');
    });
    // Still 3 on screen: it is what is stored, and it is what comes back the
    // day the assignment goes.
    expect(parallelCell('010').value).toBe('3');
  });

  itDom(
    'says a number is not applied where two different people are named on two different roles',
    async () => {
      // be-01's `widthFor` collapses **per slice**: a role with its own named
      // assignee runs at width 1 on that slice alone. Two roles, two different
      // people, is two slices each individually collapsed — `doesEveryPhase`
      // is `null` here (it only fires for exactly one named role project-wide
      // on the row), so the row-level reading this cell used to lean on cannot
      // see it, and a `3` sits there doing nothing while looking editable.
      const api = await twoRows();
      const [row] = api.rows;
      const trio = { optimistic: 1, realistic: 2, pessimistic: 3 };
      row.estimates = { [DEV.id]: trio, [QA.id]: trio };

      typeIntoParallel('010', '3');
      await waitFor(() => {
        expect(parallelCell('010').value).toBe('3');
      });
      expect(parallelCell('010').title).toContain('effort is compressed');

      unfoldRole('Dev');
      const dev = await screen.findByLabelText('Dev assignee for 010');
      fireEvent.focus(dev);
      fireEvent.change(dev, { target: { value: 'Ada' } });
      fireEvent.keyDown(dev, { key: 'Enter' });
      await waitFor(() => {
        expect(screen.getByLabelText<HTMLInputElement>('Dev assignee for 010').value).toBe('Ada');
      });

      unfoldRole('QA');
      const qa = await screen.findByLabelText('QA assignee for 010');
      fireEvent.focus(qa);
      fireEvent.change(qa, { target: { value: 'Bo' } });
      fireEvent.keyDown(qa, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByLabelText<HTMLInputElement>('QA assignee for 010').value).toBe('Bo');
      });

      // Proof: `everySliceNamed` reverted to `doesEveryPhase !== null` alone,
      // this failed on `expected '3 people at once…' to contain 'one at a
      // time whatever this says'` — un-muted with both roles individually
      // named and neither slice free to run more than one at once. Watched
      // 2026-08-14.
      await waitFor(() => {
        expect(parallelCell('010').title).toContain('one at a time whatever this says');
      });
      expect(parallelCell('010').value).toBe('3');
    },
  );
});

describe('the earliest-start cell', () => {
  /** One empty root row on a plan that is on a calendar, so the cell will open. */
  async function datedPlan() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    return api;
  }

  /** Every date editor on the page, which is what "one at a time" is counted from. */
  const editorsOnScreen = () => [...document.querySelectorAll('input[type="date"][data-cell]')];

  itDom('is the short date as text, with no editor in it', async () => {
    // 146px of column was a native date input on every row. The cell is the
    // day now, and the editor is mounted only for the cell being edited —
    // which is the whole of how the column fits in 84px.
    // Proof: the `editing` branch inverted so the editor is what is rendered at
    // rest, this failed on `expected '2026-06-01' to be '1 Jun'` — the cell
    // holding a native date input again. **Nineteen** tests failed in that run:
    // `reads as an em-dash where the row sets no day` on `expected '' to be
    // '—'`, `mounts one editor at a time` on `expected 2 to be 1`, and the Tab
    // and arrow walks all over the table. Watched, 2026-08-09.
    const api = await datedPlan();
    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.startNoEarlierThan = '2026-06-01';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe('1 Jun');
    });

    expect(editorsOnScreen()).toEqual([]);
    // And the whole day is a hover away, the same bargain Start and End make.
    expect(screen.getByLabelText('Earliest start for 010').title).toContain('2026-06-01');
  });

  itDom('reads as an em-dash where the row sets no day', async () => {
    await datedPlan();

    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe('—');
  });

  itDom('mounts one editor at a time, on the cell that asked for it', async () => {
    // Two rows, two cells, one editor: opening the second closes the first,
    // because a column this narrow can hold exactly one 138px box and only
    // by hanging it over its neighbours.
    await datedPlan();

    openNotBefore('010');
    expect(editorsOnScreen().length).toBe(1);

    openNotBefore('020');

    expect(editorsOnScreen().length).toBe(1);
    expect(editorsOnScreen()[0]?.getAttribute('data-not-before')).toBe(
      screen.getByLabelText('Name of 020').getAttribute('data-cell')?.split('::')[0],
    );
  });

  itDom('offers no editor at all while the plan has no start date', async () => {
    // Without a project start date there is no day zero to count from and
    // be-01 ignores the constraint entirely, so the cell is a rendered
    // disabled state that says why — not an editor that opens onto nothing.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');

    const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');
    expect(cell.disabled).toBe(true);
    expect(cell.title).toContain('project start date');

    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.mouseDown(cell);

    expect(editorsOnScreen()).toEqual([]);
  });

  itDom('gives the focus back to the cell on every way out', async () => {
    // A keyboard is where it was rather than at the top of the page. Asserted
    // per exit route, because the three take three different paths out of the
    // editor and only one of them sends anything.
    // Proof: the focus-return effect's `focusCellAt` removed, this failed on
    // `expected <body /> to be <input …>` for the Enter route, and the Escape
    // and blur routes with it. Watched, 2026-08-09.
    await datedPlan();

    for (const leave of [
      (box: HTMLInputElement) => fireEvent.keyDown(box, { key: 'Enter' }),
      (box: HTMLInputElement) => fireEvent.keyDown(box, { key: 'Escape' }),
      (box: HTMLInputElement) => fireEvent.blur(box),
    ]) {
      const editor = openNotBefore('010');
      expect(document.activeElement).toBe(editor);

      leave(editor);

      expect(editorsOnScreen()).toEqual([]);
      expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));
      // And the cell it came back to is still a cell of the keyboard grid, on
      // the terms it always had: Tab is the table's from here.
      expect(screen.getByLabelText('Earliest start for 010').dataset['cell']).toContain(
        '::not-before',
      );
    }
  });

  itDom('leaves the Tab handling exactly where it was', async () => {
    // The cell is text now and it is still a cell: Tab from the phase before
    // it lands here, and Tab from here goes on to the next row.
    await datedPlan();

    const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');
    cell.focus();

    expect(fireEvent.keyDown(cell, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
  });

  itDom('never writes a peer’s day over one being typed', async () => {
    // The grid's refused-draft rule, in the one cell that had no draft to hold
    // until now: a refetch that lands while a day is half-typed leaves the box
    // alone, exactly as it does for a half-typed name.
    // A whole day rather than a truncated one, because a date input refuses to
    // hold a value it cannot parse — `value` reads back `''` — and the box
    // would then be empty for a reason that has nothing to do with the guard.
    // Proof: `DateField`'s `document.activeElement` guard removed from its
    // effect, this failed on `expected '2026-09-09' to be '2026-08-17'`.
    // Watched, 2026-08-09.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    const editor = openNotBefore('010');
    editor.focus();
    fireEvent.change(editor, { target: { value: '2026-08-17' } });

    const peer = api.rows.at(0);
    if (peer === undefined) throw new Error('the plan has no row');
    peer.startNoEarlierThan = '2026-09-09';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe(
      '2026-08-17',
    );
  });
});

describe('names wrap and notes carry markdown', () => {
  /** The wrapper the marker and the preview live on — the Name cell's own parent. */
  const nameCellOf = (number: string): HTMLElement => {
    const found = screen.getByLabelText(`Name of ${number}`).parentElement;
    if (found === null) throw new Error(`name cell for ${number} has no wrapper`);
    return found;
  };

  /** The one thing on a Name cell that opens its preview. */
  const notesMarkerOf = (number: string): HTMLElement =>
    screen.getByLabelText(`Notes on ${number}`);

  /**
   * One row whose Name cell holds a name and, under it, these notes.
   *
   * Typed as one text through the one box, because that is the only way to
   * write a note now: the Notes column is gone and its content lives under the
   * first line of the name.
   */
  async function oneRowWithNotes(notes: string) {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText('Name of 010');
    fireEvent.change(cell, { target: { value: `Strip\n${notes}` } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe(notes);
    });
    // Both fields, from one box and one request: the name is what was on the
    // first line and nothing else.
    expect(api.rows[0]?.name).toBe('Strip');
    return api;
  }

  /**
   * jsdom does no layout, so `scrollHeight` is 0 for everything. Faking it is
   * what makes the auto-sizing testable at all: the component reads it, and
   * this is the only place its value can come from here.
   */
  const withScrollHeight = (node: HTMLElement, height: number) => {
    Object.defineProperty(node, 'scrollHeight', { value: height, configurable: true });
  };

  itDom('grows the name box to fit a long name, focus or no focus', async () => {
    // Dany, 2026-08-06: the name "must wrap instead of cutting text". A
    // one-row textarea wraps and then hides everything past the first line,
    // which is the same crop with extra steps.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    withScrollHeight(name, 60);
    fireEvent.change(name, { target: { value: 'a name long enough to need three lines' } });
    // `name.blur()`, not `fireEvent.blur`: the latter dispatches the event
    // without moving `document.activeElement`, so the component would still
    // read the cell as focused and this test would prove nothing.
    name.blur();

    // Sized from its own content while nobody is in it — the whole point.
    expect(name.style.height).toBe('60px');
    expect(document.activeElement).not.toBe(name);
  });

  itDom('clips the notes at rest and opens the box to write in', async () => {
    // The two halves of the at-rest clamp jsdom can see. The height itself it
    // cannot — `scrollHeight` is 0 here and this test stubs it — so what the
    // box is *as tall as* is proven in `e2e/name-cell.spec.ts` and nowhere
    // else. What is proven here is that the notes are clipped rather than
    // scrollable, which is the difference between hiding them and putting
    // them one wheel-turn away, and that no `maxRestRows` cap binds this cell
    // any more: a name is shown whole however long it is.
    //
    // Proof: `restShowsFirstLineOnly` taken off the Name column — `expected
    // 'auto' to be 'hidden'`; and the cap left on with it — `expected '5.6em'
    // to be 'none'`. Watched, 2026-08-09.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    withScrollHeight(name, 400);
    fireEvent.change(name, { target: { value: 'Strip\nmeasure twice\nthe fuse box is old' } });
    // `name.blur()`, not `fireEvent.blur`: the latter leaves
    // `document.activeElement` where it was, so the component would still read
    // the cell as focused.
    name.blur();

    expect(name.style.overflowY).toBe('hidden');
    expect(name.style.maxHeight).toBe('none');

    name.focus();

    expect(name.style.overflowY).toBe('auto');
    expect(name.style.maxHeight).toBe('none');
  });

  itDom('gives the name a box that wraps rather than one that scrolls', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010').catch(() => undefined);
    click('Add work item');

    const name = await screen.findByLabelText('Name of 010');

    // A textarea is the wrapping half of this; an input scrolls a long name
    // out of sight one character at a time.
    expect(name.tagName).toBe('TEXTAREA');
  });

  itDom('makes room for a note while it is being written in', async () => {
    // What the deleted Notes column's own `grows while it is being written in,
    // and shrinks after` used to say, asked of the box the note is written in
    // now. In the cell the box follows the text; the clamp is the other half
    // of this and only a browser can measure it.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    name.focus();
    withScrollHeight(name, 20);
    fireEvent.change(name, { target: { value: 'Strip' } });
    expect(name.style.height).toBe('20px');

    withScrollHeight(name, 80);
    fireEvent.change(name, { target: { value: 'Strip\n\n## Risks\n\n- the fuse box is old' } });

    expect(name.style.height).toBe('80px');
  });

  itDom('still holds the whole text in the box it shows one line of', async () => {
    // The clamp changes the box's height and nothing else. It measures the
    // first line by holding only the first line for the length of one
    // `scrollHeight` read, and what everything after that read sees — the
    // blur that follows it, `LiveField`'s diff against its baseline, the next
    // person to click into the cell — has to be the whole composed text
    // again. A clamp that forgot to put it back would send the name over the
    // notes and delete them, from a focus and a blur with nothing typed.
    //
    // Proof: the restore dropped from `resize` — the swapped-in first line
    // left in the box. It failed one line sooner than it was written for, on
    // `expected '' to be 'measure twice'` at the wait below: the blur that
    // sets this test up read the truncated box and deleted the note on the
    // way past. Watched, 2026-08-09.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    withScrollHeight(name, 60);
    fireEvent.change(name, { target: { value: 'Strip\nmeasure twice' } });
    name.blur();
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe('measure twice');
    });

    const patched: unknown[] = [];
    const realPatch = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      patched.push([id, patch]);
      return realPatch(id, patch);
    };

    // A look, not an edit: in and straight out again.
    name.focus();
    name.blur();

    expect(name.value).toBe('Strip\nmeasure twice');
    expect(patched).toEqual([]);
  });

  itDom('renders the markdown on hover over the notes marker', async () => {
    await oneRowWithNotes('## Risks\n\n- the fuse box is *old*');

    fireEvent.mouseEnter(notesMarkerOf('010'));

    const preview = await screen.findByRole('tooltip');
    // Rendered, not printed: a heading is an element and the emphasis is one
    // too, which is the whole difference between this and the cell beneath it.
    expect(preview.querySelector('h2')?.textContent).toBe('Risks');
    expect(preview.querySelector('li em')?.textContent).toBe('old');
    // The row's own name at the head of it, which is the wiring `hover-preview.test.tsx`
    // cannot see: this column composes the cell's text and holds the two
    // fields apart again for the preview.
    // Proof: the column passing `name=""` — `expected '' to be 'Strip'`.
    // Watched, 2026-08-09.
    expect(preview.querySelector('h1')?.textContent).toBe('Strip');
  });

  itDom('lifts the hovered row above the pinned cells the preview opens over', async () => {
    // The one thing about this preview that no amount of correct CSS on the
    // preview itself could fix, and that only a browser found: the Name cell
    // is pinned, a pinned cell is `position: sticky` **with a z-index**, and
    // that makes it a stacking context — so the preview inside it is trapped
    // there and the next row's pinned Name cell paints straight over it.
    // Proof: observed on h2puni before this existed, with `opensAPopover` and
    // every other rule already right — `opens the notes preview out past the
    // bottom of the name cell` failed on `4px below the name cell is
    // <textarea> in the name column, not the preview`. 2026-08-08.
    await oneRowWithNotes('## Risks');

    const cell = (): HTMLElement => {
      const found = nameCellOf('010').closest('td');
      if (found === null) throw new Error('the name cell is not in a cell');
      return found;
    };
    // At rest it is an ordinary pinned cell, or the lift below would be a
    // rule that was always on and could not be seen to do anything.
    expect(cell().style.zIndex).toBe('1');

    fireEvent.mouseEnter(notesMarkerOf('010'));
    await screen.findByRole('tooltip');

    expect(Number(cell().style.zIndex)).toBe(POPOVER_ROW_LAYER);
    fireEvent.mouseLeave(notesMarkerOf('010'));
    expect(cell().style.zIndex).toBe('1');
  });

  itDom('renders a script in a note as the text somebody typed', async () => {
    // Notes are written by one person and read by everyone else on the
    // project. react-markdown is used without rehype-raw precisely so this
    // cannot become markup — watched here rather than asserted in a comment.
    await oneRowWithNotes('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');

    fireEvent.mouseEnter(notesMarkerOf('010'));

    const preview = await screen.findByRole('tooltip');
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.textContent).toContain('alert(1)');
  });

  itDom('marks a row that has notes, and only one that has', async () => {
    // The marker is the whole trigger now, so a row wearing one it should not
    // have is a row whose preview opens holding nothing, and a row missing one
    // is a row whose notes cannot be read at all.
    //
    // Proof: the `notes.trim() !== ''` condition on the marker replaced by
    // `true`, this failed on `expected
    // <span aria-label="Notes on 020" …/> to be null`. Watched, 2026-08-09.
    const api = await oneRowWithNotes('## Risks');
    click('Add work item');
    const bare = await screen.findByLabelText('Name of 020');
    fireEvent.change(bare, { target: { value: 'Sand' } });
    fireEvent.blur(bare);
    await waitFor(() => {
      expect(api.rows[1]?.name).toBe('Sand');
    });

    const marker = screen.getByLabelText('Notes on 010');
    expect(marker).toBeDefined();
    // Ink, not furniture: 11px muted was invisible at arm's length. Inline
    // sizes are the production mechanism, so jsdom can hold this one.
    // Proof: the size put back to 11, this failed on `expected '11px' to be
    // '15px'`. Watched, 2026-08-09.
    expect(marker.style.fontSize).toBe('15px');
    expect(marker.style.color).toBe('var(--foreground)');
    expect(screen.queryByLabelText('Notes on 020')).toBeNull();

    // A glyph this visible reads as clickable; the click lands the caret in
    // the name rather than dying on furniture.
    fireEvent.mouseDown(marker);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
  });

  itDom('shows no popover over a row with no notes', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText('Name of 010');
    // A named row with no note: the hover has a cell and a name to find, and
    // still nothing to render. Hovering an empty row would pass this test
    // against a preview that simply never opened.
    fireEvent.change(name, { target: { value: 'Strip' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(api.rows[0]?.name).toBe('Strip');
    });

    fireEvent.mouseEnter(nameCellOf('010'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('opens nothing from the cell the notes are typed in', async () => {
    // Dany, 2026-08-09: a rendered document over the rows below on every pass
    // of the mouse is too disruptive. The Name column is the widest thing on
    // the way to anywhere in this table, so the preview waits behind its
    // marker — while the folded role cell and the depends cell, which are a
    // few lines over a narrow cell, keep the whole cell as their trigger.
    //
    // Proof: the handlers put back on the cell wrapper, this failed on
    // `expected <div role="tooltip" …/> to be null`. Watched, 2026-08-09.
    await oneRowWithNotes('## Risks');

    fireEvent.mouseEnter(nameCellOf('010'));

    expect(screen.queryByRole('tooltip')).toBeNull();

    // And the marker beside it does open one, or the assertion above would
    // hold for a preview that had simply been deleted.
    fireEvent.mouseEnter(notesMarkerOf('010'));
    expect(await screen.findByRole('tooltip')).toBeDefined();
  });

  itDom('leaves one card open when the pointer walks from row to row', async () => {
    // Two facts in one sequence, both about the single `hoveredCell` state:
    // the second hover replaces the first card rather than adding to it, and
    // the first cell's `mouseleave` — which a browser fires *after* the second
    // cell's `mouseenter` — leaves the second card alone.
    //
    // Proof: the same-cell guard in the marker's `onMouseLeave` replaced by an
    // unconditional `setHoveredCell(null)`, this failed on `Unable to find
    // role="tooltip"` at the last assertion — a card closed by the leave of a
    // cell the pointer had already left. Watched, 2026-08-09.
    const api = await oneRowWithNotes('## Risks');
    click('Add work item');
    const second = await screen.findByLabelText('Name of 020');
    fireEvent.change(second, { target: { value: 'Sand\n## Later' } });
    fireEvent.blur(second);
    await waitFor(() => {
      expect(api.rows[1]?.notes).toBe('## Later');
    });

    fireEvent.mouseEnter(notesMarkerOf('010'));
    await screen.findByRole('tooltip');
    fireEvent.mouseEnter(notesMarkerOf('020'));

    const open = screen.getAllByRole('tooltip');
    expect(open).toHaveLength(1);
    expect(open[0]?.getAttribute('aria-label')).toBe('Notes for 020, rendered');

    fireEvent.mouseLeave(notesMarkerOf('010'));

    expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('Notes for 020, rendered');
  });

  itDom('reads the whole note in the preview while the box shows the name', async () => {
    // The clamp and the preview are one answer between them: at rest the cell
    // is its name and nothing else, so forty rows fit on a screen, and the
    // hover is where the note is read. Without the preview the clamp would be
    // a note nobody could find.
    await oneRowWithNotes('## Risks\n\n- one\n- two\n- three\n- four\n- five\n- six');

    fireEvent.mouseEnter(notesMarkerOf('010'));

    const preview = await screen.findByRole('tooltip');
    expect(preview.querySelectorAll('li')).toHaveLength(6);
    expect(preview.getAttribute('aria-label')).toBe('Notes for 010, rendered');
  });

  itDom('closes the card when a peer moves the row it is anchored to', async () => {
    // A card is an absolutely positioned child of one cell, and `hoveredCell`
    // is a row id — so a refresh that moves that row moves the card with it,
    // to wherever the row landed, which is not where the pointer is. Nothing
    // reconciled the hover against the tree, so the card teleported and stayed
    // open until the pointer happened to cross another cell. codex round 3,
    // finding 3.
    //
    // A refresh that leaves the row where it was must **not** close it, or the
    // reconciliation would be "close on every refresh" — and a peer typing a
    // name anywhere on this plan refetches, so that would be a card nobody
    // could keep open long enough to read.
    //
    // Proof: `setHoveredCell(hoveredCellAfterRefresh(…))` deleted from
    // `refresh`, this failed on `expected <div role="tooltip" …/> to be null` —
    // the card still open over a row that had moved to the top of the plan.
    // Watched, 2026-08-09.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    render(
      <WbsTable
        projectId="p1"
        api={api}
        subscribe={(_projectId, handlers) => {
          notify = handlers.onChange;
          return { seen: () => undefined, unsubscribe: () => undefined };
        }}
      />,
    );
    for (const number of ['010', '020']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    const second = screen.getByLabelText('Name of 020');
    fireEvent.change(second, { target: { value: 'Sand\nsomething to read' } });
    fireEvent.blur(second);
    await waitFor(() => {
      expect(api.rows[1]?.notes).toBe('something to read');
    });

    fireEvent.mouseEnter(notesMarkerOf('020'));
    await screen.findByRole('tooltip');

    // Somebody else renames the other row. Nothing moved, so the card stays.
    await api.patch(api.rows[0]?.id ?? '', { name: 'Renamed by a peer' });
    await act(async () => {
      notify();
      await Promise.resolve();
    });
    expect(screen.queryByRole('tooltip'), 'a plain refresh took the card away').not.toBeNull();

    // And now they move the hovered row to the top of the plan.
    await api.move(api.rows[1]?.id ?? '', null, null);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  itDom('closes the card when a peer moves the branch the row sits inside', async () => {
    // Round 4, finding 10. Settling on the immediate parent and the position
    // among its siblings answers for the row itself and for nothing above it: a
    // peer moving an **ancestor** takes the whole branch to another part of the
    // plan while the hovered row's own pair reads exactly as it did, so the card
    // travelled with it and stayed open on a line the pointer was never on.
    //
    // The placement is a walk of the tree the table is about to draw — the
    // position in the rendered order — which is the thing that actually moved,
    // and which no ancestor can change without changing.
    //
    // Proof: `placementsOf` put back to counting siblings under a parent, this
    // failed on `expected <div role="tooltip" …/> to be null`. Watched,
    // 2026-08-09.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    render(
      <WbsTable
        projectId="p1"
        api={api}
        subscribe={(_projectId, handlers) => {
          notify = handlers.onChange;
          return { seen: () => undefined, unsubscribe: () => undefined };
        }}
      />,
    );
    for (const number of ['010', '020', '030']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    const second = screen.getByLabelText('Name of 020');
    fireEvent.change(second, { target: { value: 'Sand\nsomething to read' } });
    fireEvent.blur(second);
    await waitFor(() => {
      expect(api.rows[1]?.notes).toBe('something to read');
    });
    const branch = api.rows[0]?.id ?? '';
    const inside = api.rows[1]?.id ?? '';
    const last = api.rows[2]?.id ?? '';

    // 020 goes under 010, so the hovered row has an ancestor to be moved.
    await api.move(inside, branch, null);
    await act(async () => {
      notify();
      await Promise.resolve();
    });
    const child = api.rows.find((row) => row.id === inside)?.number ?? '';
    expect(child, 'the row did not end up inside a branch').toBe('010.1');

    fireEvent.mouseEnter(notesMarkerOf(child));
    await screen.findByRole('tooltip');

    // The branch moves to the end of the plan. The hovered row is still the
    // first child of the same parent — and it is drawn two lines further down.
    await api.move(branch, null, last);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  itDom('keeps the preview open while the pointer crosses the cell to reach it', async () => {
    // The preview is the one card that scrolls, and a note taller than 320px
    // can only be read by putting the pointer on it and turning the wheel. The
    // marker is a 7px glyph at the top right of the cell and the card hangs off
    // the cell's bottom edge, so that trip crosses the name box between them —
    // and while the marker owned the `mouseleave`, crossing it unmounted the
    // card before the pointer could arrive. codex round 3, finding 1.
    //
    // The region that holds the card open is therefore the **cell**, which
    // contains both the marker and the card; the marker stays the only thing
    // that opens one.
    //
    // `mouseOut` with a `relatedTarget` rather than `mouseLeave`, and that is
    // the difference between an oracle and a test that cannot fail. React
    // synthesises leave from `mouseout`: given where the pointer went it walks
    // up to the common ancestor of the two and fires leave on that stretch
    // alone — exactly what a browser does. A bare `fireEvent.mouseLeave(marker)`
    // carries no `relatedTarget`, which means "the pointer left the document",
    // and React fires leave on the marker *and* on every ancestor — so it would
    // report this fixed or broken identically. Measured here on 2026-08-09.
    //
    // Proof: the `onMouseLeave` put back on the marker, this failed on
    // `expected null not to be null` at the first assertion — the card gone the
    // moment the pointer left the glyph. Watched, 2026-08-09.
    await oneRowWithNotes('## Risks\n\n- one\n- two\n- three');

    fireEvent.mouseEnter(notesMarkerOf('010'));
    await screen.findByRole('tooltip');

    // Off the glyph, onto the name box under it — still inside the cell.
    fireEvent.mouseOut(notesMarkerOf('010'), {
      relatedTarget: screen.getByLabelText('Name of 010'),
    });

    expect(screen.queryByRole('tooltip')).not.toBeNull();

    // And off the cell altogether, which is what closes it — or the assertion
    // above would hold for a card nothing could ever close.
    fireEvent.mouseOut(nameCellOf('010'), { relatedTarget: document.body });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('role columns fold away', () => {
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  const headerTexts = () => screen.getAllByRole('columnheader').map((th) => th.textContent.trim());

  itDom('starts folded: one column per role, the final figure kept', async () => {
    await oneRow();

    // The whole point of the fold: two roles cost ten columns and the dates
    // fell off the screen. The figure a plan is read by stays.
    expect(screen.queryByLabelText('Dev optimistic for 010')).toBeNull();
    expect(screen.queryByLabelText('Dev assignee for 010')).toBeNull();
    expect(rowFor('010').querySelector('[data-final="role-dev"]')).not.toBeNull();
    expect(headerTexts()).toContain('Dev ▸');
  });

  itDom('unfolds to the trio and the assignee, and folds back', async () => {
    await oneRow();

    unfoldRole('Dev');

    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
    expect(screen.getByLabelText('Dev assignee for 010')).toBeDefined();
    // The other role stays folded — each opens on its own.
    expect(screen.queryByLabelText('QA optimistic for 010')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    expect(screen.queryByLabelText('Dev optimistic for 010')).toBeNull();
  });

  itDom('heads each point with its first letter, and says the whole word twice over', async () => {
    // Superseded, deliberately: this asserted the heading *read* `optimistic`
    // and was clipped to `optimi` by a 52px column, with the whole word in the
    // `title` as the only place a reader could get it. `spreadsheet-geometry`
    // stopped printing a word no column of this table can hold — `optimistic`
    // wants 84px, measured 2026-08-09 — and prints the letter the cells
    // already teach (`o/r/p` is the folded box's own placeholder) at 44px.
    //
    // The word is still reachable in both of the ways it was: in the `title`,
    // and — new here — as the heading's accessible name, which is what a
    // screen reader reads out for the column and what `o` alone would have
    // reduced to a letter.
    //
    // The `title` is the column's hint since `wbs-column-hints` and no longer
    // the bare word, so these three are the one place in the table where a hint
    // opens with the column's name rather than with its effect — the heading is
    // a single letter, and a sentence that never says `optimistic` would leave
    // the reader with nothing to call it.
    await oneRow();

    unfoldRole('Dev');

    for (const point of ['optimistic', 'realistic', 'pessimistic']) {
      expect(headerTitled(point.slice(0, 1)).toLowerCase()).toContain(point);
      expect(screen.getByRole('columnheader', { name: point })).toBeDefined();
    }
  });

  itDom('unfolds each role on its own, and leaves the others open', async () => {
    // **Superseded, by name**: this was `unfolds one role at a time, so the
    // table still fits the window`, and it asserted the accordion — QA open,
    // Dev's three boxes gone. `unfolding-may-scroll` reverses that decision
    // (Dany, 2026-08-08, U3) and adopts its recorded injected fault as the
    // behaviour: `[...current, roleId]` is what the writer does now.
    //
    // The arithmetic it quoted is unchanged and is still pinned in
    // `table-frame.test.ts`: a folded role costs 96px and an unfolded one 348,
    // so two folded need 1231px, one open 1483 and both open 1735 (1219 →
    // 1231 → 1483 → 1735 in `number-column-widen`, 93 → 105 in
    // `COLUMN_WIDTHS`). What changed at `unfolding-may-scroll` is that the
    // third of those is now reachable, and the frame scrolling is what pays
    // for it — `e2e/layout.spec.ts` measures that half.
    await oneRow();

    unfoldRole('Dev');
    unfoldRole('QA');

    expect(screen.getByLabelText('QA optimistic for 010')).toBeDefined();
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
    expect(screen.getByRole('table').style.minWidth).toBe('1735px');

    // Folding one leaves the other open, rather than leaving nothing open.
    fireEvent.click(screen.getByRole('button', { name: 'Fold QA estimates' }));
    expect(screen.queryByLabelText('QA optimistic for 010')).toBeNull();
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
    expect(screen.getByRole('table').style.minWidth).toBe('1483px');

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    expect(screen.queryByLabelText('Dev optimistic for 010')).toBeNull();
    expect(screen.getByRole('table').style.minWidth).toBe('1231px');
  });

  itDom('says what the fold button does, which is no longer hiding the assignee', async () => {
    // The copy is the change: who is doing the work is in the folded cell now,
    // so a button claiming to hide it would be describing the table of a week
    // ago. The second half is superseded with the accordion — it promised that
    // any other role would fold, and none does — and what replaces it is the
    // one thing unfolding can now do that it could not before: make the table
    // wider than the window.
    // Proof: the old copy restored, this failed on `expected 'Dev — show the
    // three-point estimate a…' to contain 'show the three points behind the
    // figu…'`. Watched, 2026-08-08.
    await oneRow();

    const folded = screen.getByRole('button', { name: 'Unfold Dev estimates' });
    expect(folded.title).toContain('Click to show the three points');
    expect(folded.title).toContain('the table may scroll sideways');
    expect(folded.title).not.toContain('any other role folds');
    expect(folded.title).not.toContain('assignee');
    // And it opens with the column's own sentence, because this button covers
    // most of its `<th>`: a reader resting on it would otherwise be the one
    // reader in the table who learns nothing about the column under the cursor.
    expect(folded.title.startsWith(ROLE_FINAL_HINT)).toBe(true);

    unfoldRole('Dev');
    const open = screen.getByRole('button', { name: 'Fold Dev estimates' });
    expect(open.title).toContain('Click to fold the three points back into the figure');
    expect(open.title).not.toContain('assignee');
  });

  itDom('keeps a typed estimate draft across a fold and back', async () => {
    // Drafts live in the table's state, not in the inputs, precisely so a
    // fold cannot swallow one.
    const api = await oneRow();
    const sent: unknown[] = [];
    api.setEstimate = (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve();
    };
    unfoldRole('Dev');
    const cell = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(cell, { target: { value: '5' } });
    fireEvent.blur(cell);

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    unfoldRole('Dev');

    expect(screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010').value).toBe('5');
    expect(sent).toEqual([]);
  });

  itDom('a folded role cannot hide a complaint', async () => {
    await oneRow();
    unfoldRole('Dev');
    const cell = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(cell, { target: { value: '5' } });
    fireEvent.blur(cell);

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    // One point of a trio saves nothing; folded, that fact must still show on
    // the figure the fold leaves behind — the mark on the figure, and the
    // complaint on the cell's one hint, the card. No native `title`: two
    // hints over one cell is the bug this line used to be.
    const final = rowFor('010').querySelector('[data-final="role-dev"]');
    expect(final?.textContent).toContain('!');
    expect(final?.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(final as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toContain('not saved');
  });
});

describe('assigning from a folded role’s cell with @', () => {
  /** One row and two roles, both folded — where a person starts. */
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  const foldedCell = (role = 'Dev') =>
    screen.getByLabelText<HTMLInputElement>(`${role} estimate for 010`);

  /** Focuses the folded box and puts `text` in it, keystroke by keystroke’s event. */
  const typeInto = (cell: HTMLInputElement, text: string): HTMLInputElement => {
    fireEvent.focus(cell);
    fireEvent.change(cell, { target: { value: text } });
    return cell;
  };

  /** Records every estimate written, and still performs it. */
  const watchEstimates = (api: ProjectApi): unknown[][] => {
    const written: unknown[][] = [];
    const perform = api.setEstimate.bind(api);
    api.setEstimate = (id: string, roleId: string, days: Days) => {
      written.push([id, roleId, days]);
      return perform(id, roleId, days);
    };
    return written;
  };

  /** What a folded role's cell says about who is doing the work, or null. */
  const assigneeShown = (role = 'role-dev'): string | null =>
    rowFor('010').querySelector(`[data-folded-assignee="${role}"]`)?.textContent ?? null;

  /** The `@` picker's entries, in the order they are offered. */
  const offered = (role = 'Dev'): (string | null)[] => {
    const list = screen
      .queryAllByRole('listbox')
      .find((box) => box.getAttribute('aria-label') === `${role} assignee for 010`);
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  };

  /** Puts a person on the directory the way a person does: `@name` in a cell. */
  const addPersonThrough = async (role: string, name: string): Promise<void> => {
    fireEvent.keyDown(typeInto(foldedCell(role), `@${name}`), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown(role === 'Dev' ? 'role-dev' : 'role-qa')).toContain(initialsOf(name));
    });
    fireEvent.blur(foldedCell(role));
  };

  itDom('opens the people picker on an @ and filters it by what follows', async () => {
    await oneRow();
    await addPersonThrough('Dev', 'Kateryna');
    await addPersonThrough('QA', 'Ada');

    const cell = foldedCell();
    expect(offered()).toEqual([]);

    // An estimate is not a mention: nothing opens until the `@` is typed.
    typeInto(cell, '2/3/8');
    expect(offered()).toEqual([]);

    fireEvent.change(cell, { target: { value: '2/3/8@' } });
    expect(offered()).toEqual(['Remove Kateryna', 'Kateryna — free agent', 'Ada — free agent']);

    fireEvent.change(cell, { target: { value: '2/3/8@ad' } });
    expect(offered()).toEqual(['Ada — free agent', 'Add “ad”']);
  });

  itDom('assigns on Enter and takes the @ back out, leaving the trio alone', async () => {
    // Dany's one gesture: `2/3/8@ka⏎` — trio typed, Kateryna assigned. The box
    // is left holding the trio and nothing else, and the blur that follows
    // sends exactly that.
    const api = await oneRow();
    await addPersonThrough('QA', 'Kateryna');

    const cell = typeInto(foldedCell(), '2/3/8@ka');
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(assigneeShown('role-dev')).toBe('· KA');
    });
    // The mention is gone and the estimate half is untouched.
    expect(cell.value).toBe('2/3/8');
    expect(offered()).toEqual([]);

    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
  });

  itDom('never lets the @ half read as an estimate, half-typed or abandoned', async () => {
    // The rule that holds the two apart. `@ka` alone is somebody looking a
    // person up in a cell that was selected on focus — not somebody clearing
    // the estimate that selection replaced — and `4@ka` left behind is the
    // figure this tool computed, not a request for 4/4/4.
    // Proof: the `splitMention` call in `commitCombinedEstimate` replaced by
    // `const estimate = typed`, this failed on `expected '@ka' to be '4'` —
    // the mention committed as a shorthand estimate. Watched, 2026-08-08.
    const api = await oneRow();
    await addPersonThrough('QA', 'Kateryna');
    const written = watchEstimates(api);

    // An estimate to lose.
    const first = foldedCell();
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: '4' } });
    fireEvent.blur(first);
    await waitFor(() => {
      expect(foldedCell().value).toBe('4');
    });
    expect(written).toHaveLength(1);

    // A mention typed over the whole selection: no complaint while it is
    // half-typed, and the figure back in the box when the cell is left.
    const cell = typeInto(foldedCell(), '@ka');
    expect(cell.getAttribute('aria-invalid')).toBe('false');
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(foldedCell().value).toBe('4');
    });
    expect(written).toHaveLength(1);

    // And a mention abandoned beside the figure the cell was already showing
    // asks be-01 for nothing at all.
    const again = typeInto(foldedCell(), '4@ka');
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(offered()).toEqual([]);
    fireEvent.blur(again);
    await waitFor(() => {
      expect(foldedCell().value).toBe('4');
    });
    expect(written).toHaveLength(1);
  });

  itDom('adds a contributor nobody had, and offers to remove the one assigned', async () => {
    const api = await oneRow();

    const cell = typeInto(foldedCell(), '@Grace');
    expect(offered()).toEqual(['Add “Grace”']);
    fireEvent.keyDown(cell, { key: 'Enter' });

    // The figure and who is doing it, in the one cell that never folds away.
    await waitFor(() => {
      expect(assigneeShown('role-dev')).toBe('· GR');
    });
    expect(await api.listPeople()).toEqual([{ id: 'person1', name: 'Grace', teamIds: [] }]);

    // A bare `@` offers to take them off again — first, so Enter on it is the
    // gesture that unassigns, and `@gr⏎` never can be.
    const again = typeInto(foldedCell(), '@');
    expect(offered()).toEqual(['Remove Grace', 'Grace — free agent']);
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('role-dev')).toBeNull();
    });
  });

  itDom('shows the assumed name in grey beside the figure of the other phase', async () => {
    // One person on one phase is read as doing the others too, and the folded
    // cell is where that is now visible — it used to need the role unfolded.
    await oneRow();

    fireEvent.keyDown(typeInto(foldedCell(), '@Ada'), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('role-dev')).toBe('· AD');
    });

    const dev = rowFor('010').querySelector('[data-folded-assignee="role-dev"]');
    const qa = rowFor('010').querySelector('[data-folded-assignee="role-qa"]');
    expect(dev?.textContent).toBe('· AD');
    expect(dev?.getAttribute('data-assumed')).toBeNull();
    // Bracketed and grey: a reading of one assignment, not a second one
    // written down.
    expect(qa?.textContent).toBe('· (AD)');
    expect(qa?.getAttribute('data-assumed')).toBe('role-qa');
    // The palette's own muted ink rather than the `#666` it was: `styles.css`
    // re-points every token under `.dark` and a literal is the one shade that
    // would not follow. jsdom hands back the declaration, not a resolved colour.
    expect((qa as HTMLElement | null)?.style.color).toBe('var(--muted-foreground)');
  });

  itDom('says nothing where nobody is assigned and nobody is assumed', async () => {
    await oneRow();

    expect(rowFor('010').querySelector('[data-folded-assignee="role-dev"]')).toBeNull();
  });

  /** The wrapper the folded figure, its assignee and its card all live on. */
  const foldedWrapper = (role = 'role-dev'): HTMLElement => {
    const found = rowFor('010').querySelector(`[data-final="${role}"]`);
    if (found === null) throw new Error(`no folded cell for ${role}`);
    return found as HTMLElement;
  };

  itDom('opens the folded figure into its parts, without asking the server', async () => {
    // The whole of what 96px hides: the role, the trio behind the computed
    // figure, the figure, and who is doing it — read off the row the client
    // already holds, which is what makes a hover free.
    //
    // Proof: the card's `points` fed the folded cell's own value instead of
    // the row's trio (`live.current.combinedValue(...).split('/')`), this
    // failed on `expected 'Devoptimistic 3.7 · realistic — · pes…' to contain
    // 'optimistic 2'`. Watched, 2026-08-09.
    const api = await oneRow();
    await addPersonThrough('Dev', 'Kateryna');
    const cell = typeInto(foldedCell(), '2/3/8');
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });

    // Every request from here on, so "no request on hover" is a fact about
    // this hover rather than about a component that never talks to be-01.
    const asked: string[] = [];
    for (const method of ['tree', 'listPeople', 'setEstimate', 'assign'] as const) {
      const real = api[method].bind(api) as (...args: never[]) => unknown;
      (api as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
        asked.push(method);
        return real(...args);
      };
    }

    fireEvent.mouseEnter(foldedWrapper());

    const card = screen.getByRole('tooltip');
    // Whose card this is, in the card — not in an `aria-label` on it. It is the
    // box's description as well as its hover, and a label would be read out in
    // place of everything under it; `opens the card on the focus too` is where
    // that pair is watched.
    expect(card.textContent).toContain('Dev for 010');
    expect(card.textContent).toContain('optimistic 2');
    expect(card.textContent).toContain('realistic 3');
    expect(card.textContent).toContain('pessimistic 8');
    // The final figure the cell shows — `(2 + 4×3 + 8) / 6` — and the assignee
    // it can only show four letters of.
    expect(card.textContent).toContain('Final 3.7 days');
    expect(card.textContent).toContain('Kateryna');
    expect(asked, 'the hover asked be-01 for something').toEqual([]);
  });

  itDom('opens the card on the focus too, and points the box at it', async () => {
    // A card that only a pointer can open is half the table's data withheld
    // from anybody who does not use one — codex round 3, finding 2. This cell
    // has a box in it, so the box is the answer: focusing it opens the same
    // card and names it as the box's description, which is what a screen reader
    // reads out after the label.
    //
    // The card carries **no** `aria-label` for exactly that reason. A
    // description is computed by the accessible-name algorithm over the element
    // it points at, and a label wins over contents there — so `aria-label="Dev
    // for 010"` would have replaced the trio it exists to convey with four
    // words. The card says whose it is in its first line instead, where it is
    // both read out and on screen.
    //
    // Proof, two faults watched 2026-08-09. The `onFocus` line dropped: this
    // failed on `Unable to find an accessible element with the role "tooltip"`.
    // The `aria-label` put back on `FoldedRoleCard`: on `expected 'Dev for 010'
    // to be null`.
    const api = await oneRow();
    fireEvent.blur(typeInto(foldedCell(), '2/3/8'));
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']?.realistic).toBe(3);
    });

    // No pointer has been anywhere near this cell.
    fireEvent.focus(foldedCell());

    const card = screen.getByRole('tooltip');
    expect(card.id, 'a description has to be pointed at, so it needs an id').not.toBe('');
    expect(foldedCell().getAttribute('aria-describedby')).toBe(card.id);
    expect(card.getAttribute('aria-label')).toBeNull();
    expect(card.textContent).toContain('Dev for 010');
    expect(card.textContent).toContain('optimistic 2');

    fireEvent.blur(foldedCell());

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(foldedCell().getAttribute('aria-describedby')).toBeNull();
  });

  itDom('keeps the focused cell’s card when the pointer visits another and leaves', async () => {
    // Round 4, finding 9. The focus and the pointer wrote one state, so a
    // pointer wandering across any other cardable cell and off it again ran the
    // guarded clear and left that state null — while the Dev box still had the
    // focus, still had nothing describing it, and had no reason to fire a focus
    // event ever again. A description that disappears because a mouse went past
    // is worse than one that was never there.
    //
    // Two states now, and one card derived from them: the pointer wins while it
    // is on something, and the focus is what is left when it is not.
    //
    // Proof: `focusedCell` folded back into `hoveredCell`, this failed on
    // `Unable to find an accessible element with the role "tooltip"` — no card
    // at all after the pointer had been and gone. Watched, 2026-08-09.
    const api = await oneRow();
    fireEvent.blur(typeInto(foldedCell(), '2/3/8'));
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']?.realistic).toBe(3);
    });

    fireEvent.focus(foldedCell());
    const opened = screen.getByRole('tooltip');
    expect(foldedCell().getAttribute('aria-describedby')).toBe(opened.id);

    // The pointer crosses the QA cell — which has a card of its own, so it owns
    // the screen while it is there — and leaves again.
    fireEvent.mouseEnter(foldedWrapper('role-qa'));
    expect(screen.getByRole('tooltip').textContent).toContain('QA for 010');
    fireEvent.mouseLeave(foldedWrapper('role-qa'));

    const back = screen.getByRole('tooltip');
    expect(back.textContent).toContain('Dev for 010');
    expect(foldedCell().getAttribute('aria-describedby')).toBe(back.id);

    // And the blur is still what ends it, or the card above would be one
    // nothing could close.
    fireEvent.blur(foldedCell());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('reads the trio off the row, not out of the boxes it was typed into', async () => {
    // The case the first round left out. A half-filled trio is never sent, so
    // what was typed stays a draft — and folding the role takes those boxes off
    // screen while the draft outlives them. The card is what the fold leaves
    // behind, and what the fold hid is the estimate this plan is *made of*: the
    // one be-01 holds, the one the figure beside it is computed from, the one
    // every other reader of the plan sees. A card showing 'realistic —' beside
    // 'Final 3.7 days' is a card disagreeing with itself.
    //
    // The draft is not lost by this and is not meant to be: unfolding the role
    // puts it back in the box it was typed into, with its complaint, which is
    // the only place it can be corrected. codex round 3, finding 4.
    //
    // Proof: the card's points read back through `estimateValue`, this failed on
    // `expected 'Devoptimistic 2 · realistic — · pessi…' to contain 'realistic
    // 3'`. Watched, 2026-08-09.
    const api = await oneRow();
    const cell = typeInto(foldedCell(), '2/3/8');
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });

    // Unfold, empty one of the three, and leave it: two boxes filled and one
    // not is a complaint rather than a request, so nothing is sent and what was
    // typed is held.
    click('Unfold Dev estimates');
    const realistic = await screen.findByLabelText<HTMLInputElement>('Dev realistic for 010');
    fireEvent.change(realistic, { target: { value: '' } });
    fireEvent.blur(realistic);
    expect(realistic.value, 'the emptied box did not keep what was typed').toBe('');
    expect(api.rows[0]?.estimates['role-dev']?.realistic, 'the half trio was sent').toBe(3);

    click('Fold Dev estimates');
    fireEvent.mouseEnter(foldedWrapper());

    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('optimistic 2');
    expect(card.textContent).toContain('realistic 3');
    expect(card.textContent).toContain('pessimistic 8');
  });

  itDom('says Final in days, whatever half-typed shorthand the cell is holding', async () => {
    // The same rule one line down, and the reason it is a second test: a box's
    // draft and the folded cell's own shorthand cannot both exist — writing
    // either drops the other — so one test cannot reach both.
    //
    // `Final 8/3/2 days` is what the card said while it read the cell: the
    // refused shorthand, printed where a number of days belongs.
    //
    // Proof: `final` read back through `combinedValue`, this failed on
    // `expected 'Devoptimistic 2 · realistic 3 · pessi…' to contain 'Final 3.7
    // days'`, the card reading `Final 8/3/2 days`. Watched, 2026-08-09.
    const api = await oneRow();
    fireEvent.blur(typeInto(foldedCell(), '2/3/8'));
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']?.realistic).toBe(3);
    });

    // Out of order, so be-01 is never asked and the shorthand stays in the cell
    // with its complaint on it.
    fireEvent.blur(typeInto(foldedCell(), '8/3/2'));
    expect(foldedCell().value).toBe('8/3/2');
    expect(api.rows[0]?.estimates['role-dev']?.optimistic).toBe(2);

    fireEvent.mouseEnter(foldedWrapper());

    expect(screen.getByRole('tooltip').textContent).toContain('Final 3.7 days');
  });

  itDom('says on the card that an assignee is assumed', async () => {
    await oneRow();
    fireEvent.keyDown(typeInto(foldedCell(), '@Ada'), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('role-dev')).toBe('· AD');
    });
    fireEvent.blur(foldedCell());

    fireEvent.mouseEnter(foldedWrapper('role-qa'));

    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Ada');
    expect(card.textContent).toContain('assumed');
  });

  itDom('leaves the assignee no title of its own to say it twice', async () => {
    // The name used to be a `title` on the truncated span — one line, a second
    // late, and now the card's job. What stays native is help about an action:
    // the fold/unfold button says what it does.
    //
    // Proof: the `title` put back on the assignee span, this failed on
    // `expected 'Ada' to be null`. Watched, 2026-08-09.
    await oneRow();
    fireEvent.keyDown(typeInto(foldedCell(), '@Ada'), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('role-dev')).toBe('· AD');
    });

    const shown = rowFor('010').querySelector('[data-folded-assignee="role-dev"]');
    expect(shown?.getAttribute('title')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Unfold Dev estimates' }).getAttribute('title'),
    ).toContain('show the three points');
  });

  itDom('keeps the cell to the @ list while that list is open', async () => {
    // Two boxes opening from the bottom edge of one 96px cell, one of them
    // being typed into. The list wins.
    //
    // Proof: the `options.length === 0` condition dropped from the card, this
    // failed on `expected [ <div role="tooltip" …/> ] to have a length of +0
    // but got 1` — the card stacked under the open list over one cell.
    // Watched, 2026-08-09.
    await oneRow();
    await addPersonThrough('Dev', 'Kateryna');

    fireEvent.mouseEnter(foldedWrapper());
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    typeInto(foldedCell(), '@ka');

    expect(offered(), 'the @ list is not open, so nothing is being kept out').toContain(
      'Kateryna — free agent',
    );
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  itDom('keeps the cell to a mention that has nobody to offer', async () => {
    // The guard used to read the list rather than the mention, and a mention
    // with an empty list is reachable: a deployment with nobody on it yet
    // answers a bare `@` with no entries at all — no people to match, and no
    // `Add "…"` until something is typed after it. The card then opened over the
    // box being typed in, which is the one place it must never be. agy round 3,
    // finding 7.
    //
    // The probe is a card open on the QA cell, so this watches the *write* as
    // well as the render: without the guard the Dev cell takes the hover, its
    // own card is suppressed by the empty list, and the reader is left with
    // nothing at all.
    //
    // Proof: the guard put back to `options.length === 0`, this failed on
    // `expected 'Dev for 010…' to contain 'QA'`. Watched, 2026-08-09.
    await oneRow();

    typeInto(foldedCell(), '@');
    expect(offered(), 'somebody is on this deployment, so the list is not empty').toEqual([]);
    fireEvent.mouseEnter(foldedWrapper('role-qa'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.mouseEnter(foldedWrapper());

    const open = screen.getAllByRole('tooltip');
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('QA');
  });
});

describe('one cell for the whole trio', () => {
  /** The folded role's cell: shows the final figure, takes `o/r/p`. */
  const combinedCell = (number: string, role = 'Dev') =>
    screen.getByLabelText<HTMLInputElement>(`${role} estimate for ${number}`);

  /** Types shorthand into the folded cell and leaves it, the way a person does. */
  const typeCombined = (number: string, value: string) => {
    const cell = combinedCell(number);
    fireEvent.change(cell, { target: { value } });
    fireEvent.blur(cell);
    return cell;
  };

  /** Records every estimate written, and still performs it. */
  const watchWrites = (api: ProjectApi): unknown[][] => {
    const written: unknown[][] = [];
    const perform = api.setEstimate.bind(api);
    api.setEstimate = (id: string, roleId: string, days: Days) => {
      written.push([id, roleId, days]);
      return perform(id, roleId, days);
    };
    return written;
  };

  /** One row, roles left folded — which is where a person starts. */
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  itDom('sends one estimate for the trio typed into the folded cell', async () => {
    // The dominant loop of an estimating session: no unfolding, one cell, one
    // request. Three separate writes would each be a broadcast and a refetch
    // for everybody else, and the two in the middle would be trios nobody
    // meant to save.
    const api = await oneRow();
    const written = watchWrites(api);

    typeCombined('010', '2/3/8');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
    expect(written).toEqual([['w1', 'role-dev', { optimistic: 2, realistic: 3, pessimistic: 8 }]]);
  });

  itDom('goes back to showing be-01’s final figure once the trio lands', async () => {
    // The honest shape of this cell: a computed figure at rest, shorthand
    // while it is being typed into. `2/3/10` is PERT 4, which is not any of
    // the three numbers typed.
    await oneRow();

    typeCombined('010', '2/3/10');

    await waitFor(() => {
      expect(combinedCell('010').value).toBe('4');
    });
  });

  itDom('takes one number as the estimator saying all three are the same', async () => {
    const api = await oneRow();
    const written = watchWrites(api);

    typeCombined('010', '5');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 5,
        realistic: 5,
        pessimistic: 5,
      });
    });
    expect(written).toHaveLength(1);
  });

  itDom('sends the trio on Enter, without waiting for the cell to be left', async () => {
    // The most-edited box in the product, and until this it was the one cell of
    // the grid where Enter did nothing at all: the name cell takes it, the
    // dependency picker takes it, Prio has taken it since 2026-08-11, and an
    // estimate typed and confirmed sat as a draft with the plan's dates
    // unmoved. Observed live on dev by `wbs-e2e-planning-qa` chunk 3,
    // 2026-08-22: `20/24/30` into `Dev estimate for 040`, Enter, ten seconds of
    // an unchanged DAYS and END, then `8.8 → 26.5 days` the instant the cell
    // was clicked away from.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = combinedCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2/3/8' } });
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(written).toEqual([
        ['w1', 'role-dev', { optimistic: 2, realistic: 3, pessimistic: 8 }],
      ]);
    });
    // The caret stays where it is, exactly as Prio's does: moving on is
    // Ctrl/⌘ + Enter's, and a bare Enter that also moved would be a second
    // chord wearing the first one's key.
    expect(document.activeElement).toBe(combinedCell('010'));
  });

  itDom('sends one request for a trio entered with Enter and then left', async () => {
    // `LiveField` rule 5 across the two callers: the blur that follows an Enter
    // finds `shown` no further on than the submission already recorded, and
    // sends nothing. Two patches here would be two broadcasts, two refetches
    // and two Ctrl/⌘ + Zs for one trio.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = combinedCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2/3/8' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.blur(cell);

    await waitFor(() => {
      // `2/3/8` is PERT 3.7, which is none of the three numbers typed — the
      // cell going back to be-01's computed figure is what says the trio landed.
      expect(combinedCell('010').value).toBe('3.7');
    });
    expect(written).toHaveLength(1);
  });

  itDom('sends an unfolded point on Enter too', async () => {
    // The same keystroke one column along. The three-box face is the one an
    // estimator opens to argue about a single number, and a number typed and
    // confirmed there was the same silent draft.
    //
    // The first two boxes are left the old way and send nothing — a trio with a
    // box still empty is a complaint, not a request (`trioProblem`) — so the
    // only thing that can produce a write here is Enter in the third.
    const api = await oneRow();
    const written = watchWrites(api);
    click('Unfold Dev estimates');

    const optimistic = await screen.findByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(optimistic, { target: { value: '2' } });
    fireEvent.blur(optimistic);
    const pessimistic = screen.getByLabelText<HTMLInputElement>('Dev pessimistic for 010');
    fireEvent.change(pessimistic, { target: { value: '8' } });
    fireEvent.blur(pessimistic);
    expect(written, 'a half-filled trio was sent').toEqual([]);

    const realistic = screen.getByLabelText<HTMLInputElement>('Dev realistic for 010');
    realistic.focus();
    fireEvent.change(realistic, { target: { value: '3' } });
    fireEvent.keyDown(realistic, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
  });

  itDom('takes the spaces and the decimals a person types', async () => {
    const api = await oneRow();

    typeCombined('010', ' 0.5 / 1 / 2 ');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 0.5,
        realistic: 1,
        pessimistic: 2,
      });
    });
  });

  itDom('sends nothing for a trio that runs backwards, and says why', async () => {
    // Out of order is a complaint, not a sort. `8/3/2` is either a typo or a
    // person thinking in the other direction, and guessing which is how the
    // old table came to save numbers nobody typed.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = typeCombined('010', '8/3/2');

    expect(written).toEqual([]);
    expect(api.rows[0]?.estimates['role-dev']).toBeUndefined();
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    // The complaint reads off the card, the cell's one hint. 'Must read' and
    // not 'optimistic': the card's help line says 'optimistic' about every
    // cell, so that word can never fail here.
    fireEvent.focus(cell);
    expect(screen.getByRole('tooltip').textContent).toContain('Must read optimistic');
    // What was typed stays typed. Clearing it would take the correction away
    // from the only person who can make it.
    expect(cell.value).toBe('8/3/2');
  });

  itDom('sends nothing for two numbers where three were needed', async () => {
    // `2/3` is a half-typed trio, exactly like two filled boxes and one empty
    // one, and it saves nothing for the same reason: be-01 stores a trio or
    // nothing.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = typeCombined('010', '2/3');

    expect(written).toEqual([]);
    expect(api.rows[0]?.estimates['role-dev']).toBeUndefined();
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    expect(cell.value).toBe('2/3');
  });

  itDom('keeps a refused entry through somebody else’s refetch', async () => {
    // Drafts live in the table's state rather than in the input, so the refetch
    // every edit triggers cannot swallow a correction half made.
    const api = await oneRow();
    typeCombined('010', '1/2/3/4');

    click('Add work item');
    await screen.findByLabelText('Name of 020');

    const cell = combinedCell('010');
    expect(cell.value).toBe('1/2/3/4');
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    expect(api.rows[0]?.estimates['role-dev']).toBeUndefined();
  });

  itDom('clears the stored trio when the cell is emptied', async () => {
    const api = await oneRow();
    typeCombined('010', '2/3/10');
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toBeDefined();
    });
    const cleared: [string, string][] = [];
    const perform = api.clearEstimate.bind(api);
    api.clearEstimate = (id: string, roleId: string) => {
      cleared.push([id, roleId]);
      return perform(id, roleId);
    };

    typeCombined('010', '');

    await waitFor(() => {
      expect(cleared).toEqual([['w1', 'role-dev']]);
    });
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toBeUndefined();
    });
    expect(combinedCell('010').value).toBe('');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('asks for nothing when a cell with no estimate is emptied', async () => {
    // Tabbing through an unestimated plan must not post a deletion per role
    // per row. A space is what a person leaves behind after select-all.
    const api = await oneRow();
    const cleared: unknown[] = [];
    api.clearEstimate = (...args: unknown[]) => {
      cleared.push(args);
      return Promise.resolve();
    };
    const written = watchWrites(api);

    typeCombined('010', ' ');

    expect(cleared).toEqual([]);
    expect(written).toEqual([]);
  });

  itDom('gives way to the three boxes when the role is unfolded', async () => {
    // Two editors for one trio side by side is two places to disagree. The
    // combined cell is the folded role's; unfolded, the boxes are.
    await oneRow();
    expect(combinedCell('010')).toBeDefined();

    unfoldRole('Dev');

    expect(screen.queryByLabelText('Dev estimate for 010')).toBeNull();
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
  });

  itDom('leaves a parent’s rolled-up figure to be read, not typed into', async () => {
    const api = await oneRow();
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');

    typeCombined('010.1', '2/3/10');
    await waitFor(() => {
      expect(api.rows.find((r) => r.id === 'w2')?.estimates['role-dev']).toBeDefined();
    });

    // The parent sums what is below it; there is nothing there to type. Its
    // figure is still shown — read-only text where the leaf has a box.
    expect(screen.queryByLabelText('Dev estimate for 010')).toBeNull();
    expect(rowFor('010').querySelector('[data-final="role-dev"]')).not.toBeNull();
    await waitFor(() => {
      expect(combinedCell('010.1').value).toBe('4');
    });
  });

  itDom('is a cell of the keyboard grid, so a column can be typed down', async () => {
    // The whole point of the shorthand is typing estimates for many rows fast,
    // and that is Down, type, Down, type.
    const api = await oneRow();
    click('Add work item');
    await screen.findByLabelText('Name of 020');

    const first = combinedCell('010');
    first.focus();
    first.setSelectionRange(0, 0);
    fireEvent.keyDown(first, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(combinedCell('020'));
    fireEvent.change(combinedCell('020'), { target: { value: '1/1/1' } });
    fireEvent.blur(combinedCell('020'));
    await waitFor(() => {
      expect(api.rows[1]?.estimates['role-dev']).toEqual({
        optimistic: 1,
        realistic: 1,
        pessimistic: 1,
      });
    });
  });

  itDom('lets a folded entry replace what the boxes were holding', async () => {
    // One row and role has one pending draft, whichever way it was typed. The
    // alternative is two half-typed estimates of one trio and a rule about
    // which of them is real — and this is the case where it shows, because a
    // refused entry is the one that stays.
    const api = await oneRow();
    const written = watchWrites(api);
    unfoldRole('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    typeCombined('010', '8/3/2');

    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');
    // The `7` was a draft of this same trio, and the trio has since been typed
    // again — differently, and last. It is not still waiting in a box.
    unfoldRole('Dev');
    const after = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    expect(after.value).toBe('');
    expect(after).toHaveAttribute('aria-invalid', 'false');
    expect(written).toEqual([]);
  });

  itDom('lets a box replace what the folded cell was holding', async () => {
    // The same rule the other way round: the boxes were typed last, so the
    // refused shorthand is gone and the complaint on the folded figure is the
    // boxes' own.
    const api = await oneRow();
    const written = watchWrites(api);
    typeCombined('010', '8/3/2');

    unfoldRole('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '1' } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    expect(combinedCell('010').value).toBe('');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.focus(combinedCell('010'));
    expect(screen.getByRole('tooltip').textContent).toContain('not saved');
    expect(written).toEqual([]);
  });

  itDom('lets a box win back over a refused folded entry', async () => {
    const api = await oneRow();
    typeCombined('010', '8/3/2');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');

    unfoldRole('Dev');
    for (const [point, value] of [
      ['optimistic', '1'],
      ['realistic', '2'],
      ['pessimistic', '3'],
    ] as const) {
      const box = screen.getByLabelText<HTMLInputElement>(`Dev ${point} for 010`);
      fireEvent.change(box, { target: { value } });
      fireEvent.blur(box);
    }

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
      });
    });
    // Folded again, the cell shows the figure be-01 computed — not the `8/3/2`
    // that was refused before the boxes said something else.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    expect(combinedCell('010').value).toBe('2');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('marks the folded cell when the boxes hold a trio that saves nothing', async () => {
    // The `!` marker `role-columns-fold` put on the figure now has an input
    // under it, and the complaint has to reach both.
    await oneRow();
    unfoldRole('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '5' } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.focus(combinedCell('010'));
    expect(screen.getByRole('tooltip').textContent).toContain('not saved');
    expect(rowFor('010').querySelector('[data-final="role-dev"]')?.textContent).toContain('!');
  });
});

describe('estimates are never edited for you', () => {
  /** Types `value` into one estimate box and leaves it, the way a person does. */
  const typeEstimate = (number: string, point: string, value: string) => {
    const cell = screen.getByLabelText<HTMLInputElement>(`Dev ${point} for ${number}`);
    fireEvent.change(cell, { target: { value } });
    fireEvent.blur(cell);
    return cell;
  };

  const estimateCell = (number: string, point: string) =>
    screen.getByLabelText<HTMLInputElement>(`Dev ${point} for ${number}`);

  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    unfoldRole('Dev');
    return api;
  }

  itDom('sends nothing, and keeps what was typed, until the trio is complete', async () => {
    const api = await oneRow();
    const sent: unknown[] = [];
    api.setEstimate = (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve();
    };

    typeEstimate('010', 'optimistic', '5');

    // The old table turned this into 5/5/5 and sent it — three numbers from
    // one keystroke, two of which nobody typed.
    expect(sent).toEqual([]);
    expect(estimateCell('010', 'optimistic').value).toBe('5');
    expect(estimateCell('010', 'realistic').value).toBe('');
  });

  itDom('marks the boxes that are still empty rather than filling them', async () => {
    await oneRow();

    typeEstimate('010', 'optimistic', '5');

    expect(estimateCell('010', 'realistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'pessimistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic').title).toContain('not saved');
    // The box holding a real number is not the mistake.
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('marks both members of a pair that breaks the order, and sends nothing', async () => {
    const api = await oneRow();
    const sent: unknown[] = [];
    api.setEstimate = (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve();
    };

    typeEstimate('010', 'optimistic', '5');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    expect(sent).toEqual([]);
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'pessimistic')).toHaveAttribute('aria-invalid', 'false');
    // And the numbers are exactly the ones typed — nothing was reordered.
    expect(estimateCell('010', 'optimistic').value).toBe('5');
    expect(estimateCell('010', 'realistic').value).toBe('3');
  });

  itDom('sends the trio, unaltered, once it reads sensibly', async () => {
    const api = await oneRow();

    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 10,
      });
    });
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('fixing the broken box sends the trio it was holding back', async () => {
    const api = await oneRow();
    typeEstimate('010', 'optimistic', '5');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    typeEstimate('010', 'realistic', '7');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 5,
        realistic: 7,
        pessimistic: 10,
      });
    });
  });

  /** Records every clear the table asks for, and still performs it. */
  const watchClears = (api: ProjectApi): [string, string][] => {
    const cleared: [string, string][] = [];
    const perform = api.clearEstimate.bind(api);
    api.clearEstimate = (id: string, roleId: string) => {
      cleared.push([id, roleId]);
      return perform(id, roleId);
    };
    return cleared;
  };

  /** Types a stored `2 / 3 / 10` for Dev on `010` and waits for be-01 to hold it. */
  async function estimated() {
    const api = await oneRow();
    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toBeDefined();
    });
    return api;
  }

  itDom('clears the stored trio when all three boxes are emptied', async () => {
    // Until now a trio could be overwritten but never taken back off. Emptying
    // the three boxes is the only gesture that says "this row does not need
    // this role", and it used to save nothing at all.
    const api = await estimated();
    const cleared = watchClears(api);

    typeEstimate('010', 'optimistic', '');
    typeEstimate('010', 'realistic', '');
    typeEstimate('010', 'pessimistic', '');

    await waitFor(() => {
      expect(cleared).toEqual([['w1', 'role-dev']]);
    });
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toBeUndefined();
    });
    // The drafts went with it, so the boxes read from the tree again rather
    // than from three empty strings the table is still holding.
    expect(estimateCell('010', 'optimistic').value).toBe('');
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('does not clear when only two of the three boxes are emptied', async () => {
    // The half-emptied trio stays exactly what it was before: a complaint. A
    // clear here would be the tool deciding that two blanks mean "delete it",
    // which is the same class of assumption as repairing a trio.
    const api = await estimated();
    const cleared = watchClears(api);

    typeEstimate('010', 'optimistic', '');
    typeEstimate('010', 'realistic', '');

    expect(cleared).toEqual([]);
    expect(api.rows[0]?.estimates['role-dev']).toEqual({
      optimistic: 2,
      realistic: 3,
      pessimistic: 10,
    });
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic').title).toContain('not saved');
    expect(estimateCell('010', 'pessimistic').value).toBe('10');
  });

  itDom('asks for nothing when three empty boxes were already empty', async () => {
    // A row nobody estimated is the ordinary state. Tabbing through its boxes
    // must not post a deletion for every role on every row it passes.
    const api = await oneRow();
    const cleared = watchClears(api);

    typeEstimate('010', 'optimistic', '');
    typeEstimate('010', 'pessimistic', '');

    expect(cleared).toEqual([]);
  });

  itDom('shows the final figure be-01 computed, per role and in total', async () => {
    const api = await oneRow();

    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final="role-dev"]')?.textContent).toBe('4');
    });
    expect(rowFor('010').querySelector('[data-final-total]')?.textContent).toBe('4');
    expect(api.rows[0]?.estimates['role-dev']?.realistic).toBe(3);
  });

  itDom('follows the project’s chosen method', async () => {
    await oneRow();
    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');
    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final="role-dev"]')?.textContent).toBe('4');
    });

    fireEvent.change(screen.getByLabelText('Final estimate'), {
      target: { value: 'pessimistic' },
    });

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final="role-dev"]')?.textContent).toBe('10');
    });
  });
});

/**
 * What the column heading reading `text` says about itself in its `title`.
 *
 * The headings are a word or a mark each, so the sentence saying what the
 * column does to the plan lives in the tooltip rather than in the heading. Read
 * off the `<th>` itself since `wbs-column-hints`, which is where every column's
 * sentence is (`column-hints.ts`) — a descendant `[title]` would find whichever
 * control the heading happens to hold, and on a resizable column that is the
 * drag handle.
 */
const headerTitled = (text: string): string => {
  const header = screen.getAllByRole('columnheader').find((th) => th.textContent.trim() === text);
  if (header === undefined) throw new Error(`no column heading reads ${text}`);
  const hint = header.getAttribute('title');
  if (hint === null) throw new Error(`the ${text} heading says nothing about itself`);
  return hint;
};

/**
 * Types a whole date into a date field and leaves it, which is what saves one.
 *
 * The blur is the commit, and it is not decoration here: {@link DateField}
 * holds everything typed while the box has the focus, because a native date
 * input fires a `change` per completed segment and committing each of them
 * saved a plan starting in year 0002. A test that fires the `change` alone is
 * asserting the browser's fault, not the field's behaviour.
 */
/**
 * Types the year `2026` into an open date box the way Chrome delivers it: a
 * `keydown` for the digit, then the `change` that digit completed — four dates,
 * in years 2, 20, 202 and 2026.
 *
 * The keydowns are not decoration. Since 2026-08-23 `DateField` sends a `change`
 * with **no key behind it** at once, because that is a day picked from the
 * calendar popup (`wbs-gantt-stale-on-start-date`) — so a version of this helper
 * that fired the four changes alone would be asking this table about a gesture
 * nobody performs, and would report the year-`0002` guard broken when it is
 * intact. Which gesture really produces a key is a browser's answer and
 * `e2e/keyboard.spec.ts` holds both halves of it.
 */
const typeYearInto = (box: HTMLInputElement): void => {
  for (const partial of ['0002-08-17', '0020-08-17', '0202-08-17', '2026-08-17']) {
    fireEvent.keyDown(box, { key: partial.slice(3, 4) });
    fireEvent.change(box, { target: { value: partial } });
  }
};

const typeIntoDate = (label: string, day: string): void => {
  const box = screen.getByLabelText(label);
  fireEvent.change(box, { target: { value: day } });
  fireEvent.blur(box);
};

/**
 * Opens one row's earliest-start editor, the way a reader does.
 *
 * The cell is text at rest since `T2 compact-columns` — the editor is mounted
 * for the cell being edited and for no other — so every date typed into a row
 * has to be typed into an editor that was opened first. Enter is the keyboard's
 * way in; a click is the pointer's.
 */
const openNotBefore = (number: string): HTMLInputElement => {
  const cell = screen.getByLabelText<HTMLInputElement>(`Earliest start for ${number}`);
  fireEvent.keyDown(cell, { key: 'Enter' });
  return screen.getByLabelText<HTMLInputElement>(`Earliest start for ${number}`);
};

/** Opens a row's earliest-start editor, types a day into it, and leaves. */
const typeIntoNotBefore = (number: string, day: string): void => {
  const editor = openNotBefore(number);
  fireEvent.change(editor, { target: { value: day } });
  fireEvent.blur(editor);
};

/** The `<tr>` whose number cell reads `number`. */
const rowFor = (number: string): HTMLElement => {
  const found = screen
    .getAllByRole('row')
    .find((tr) => tr.querySelector('[data-number]')?.textContent === number);
  if (found === undefined) throw new Error(`no row numbered ${number}`);
  return found;
};

/** Pins a row's geometry so a drop can be aimed at a zone jsdom cannot lay out. */
const withHeight = (element: HTMLElement, top: number, height: number): HTMLElement => {
  element.getBoundingClientRect = () =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
  return element;
};

/**
 * jsdom has no `DragEvent`, so `fireEvent.dragOver(el, {clientY})` degrades to a
 * plain `Event` and the coordinate is silently dropped — which made the first
 * version of these tests pass on a zone nobody aimed at. A `MouseEvent` named
 * `dragover` carries it, and React dispatches on the type either way.
 */
const dragEvent = (type: string, clientY: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientY });

const dragOnto = (from: string, to: string, clientY: number) => {
  fireEvent.dragStart(screen.getByLabelText(`Reorder ${from}`));
  const target = rowFor(to);
  fireEvent(target, dragEvent('dragover', clientY));
  fireEvent(target, dragEvent('drop', clientY));
};

/** Three named root rows: `010 Strip`, `020 Sand`, `030 Paint`. */
async function threeRoots() {
  // Dev's columns take part in the keyboard grid below, so they are open.

  const api = fakeApi();
  render(<WbsTable projectId="p1" api={api} />);
  // Named, not left blank. Blank names made an ordering assertion compare three
  // empty strings against three empty strings, which passes for any order.
  for (const [number, name] of [
    ['010', 'Strip'],
    ['020', 'Sand'],
    ['030', 'Paint'],
  ]) {
    click('Add work item');
    await screen.findByLabelText(`Name of ${number}`);
    typeName(number, name);
    fireEvent.blur(screen.getByLabelText(`Name of ${number}`));
    await waitFor(() => {
      expect(screen.getByLabelText(`Name of ${number}`)).toHaveProperty('value', name);
    });
  }
  unfoldRole('Dev');
  return api;
}

const namesOnScreen = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((tr) => {
      const input = tr.querySelector('[data-name-input]');
      // Thrown rather than defaulted: a row without a name cell means the
      // markup changed, and an empty string here would quietly pass an
      // ordering assertion that is no longer looking at anything.
      if (!isCell(input)) throw new Error('a row has no name cell');
      return input.value;
    });

describe('dragging a row', () => {
  itDom('makes the dragged row a child of the row it is dropped into', async () => {
    await threeRoots();
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);

    // The middle half of the row is "into". jsdom lays nothing out, so the
    // geometry is pinned; the arithmetic itself is `zoneFor`'s own test.
    withHeight(rowFor('010'), 0, 40);
    dragOnto('030', '010', 20);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
  });

  itDom('puts the row above the target when dropped on its top quarter', async () => {
    const api = await threeRoots();
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);

    withHeight(rowFor('010'), 0, 40);
    dragOnto('030', '010', 2);

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Paint', 'Strip', 'Sand']);
    });
    // Moved, not copied: the same three rows, still at the root.
    expect(api.rows).toHaveLength(3);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('refuses to drag a frozen row and says why', async () => {
    // This test used to fire a `drop` with no `dragstart` before it, so `dropOn`
    // returned on its null check and the frozen rule was never reached. Deleting
    // that rule left it passing. Both reviewers found it; it drags for real now.
    const api = await threeRoots();
    click('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });
    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    // The handle stays, and says why it will not help.
    const handle = screen.getByLabelText('Reorder 030');
    expect(handle.getAttribute('title')).toContain('unfreeze');
    expect(handle.getAttribute('aria-disabled')).toBe('true');

    withHeight(rowFor('010'), 0, 40);
    dragOnto('030', '010', 20);

    expect(moved).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('frozen');
  });

  itDom('refuses a drop inside the dragged row’s own subtree, with the reason', async () => {
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    withHeight(rowFor('010.1'), 0, 40);
    dragOnto('010', '010.1', 20);

    expect(moved).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('inside itself');
  });

  itDom('sends nothing when a row is dropped where it already is', async () => {
    const api = await threeRoots();
    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    // The bottom quarter of the row directly above it.
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 38);

    expect(moved).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the drag handle as assistive technology meets it', () => {
  itDom('is a control with a role and a name, not a decorated span', async () => {
    // It was a bare `<span aria-label="Reorder">` with no `role` and no
    // `tabindex` — a label on nothing, which is what a screen reader is handed.
    // ⌥+arrows are the keyboard route to reordering, so the handle is
    // deliberately out of the tab order; what it is not allowed to be is
    // roleless.
    await threeRoots();

    const handle = screen.getByLabelText('Reorder 020');

    expect(handle.getAttribute('role')).toBe('button');
    expect(handle.getAttribute('tabindex')).toBe('-1');
    expect(handle.getAttribute('title')).toBe('Drag to move this row');
    expect(handle).toHaveProperty('draggable', true);
  });

  itDom('says on itself why a frozen row will not move', async () => {
    await threeRoots();
    click('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });

    const handle = screen.getByLabelText('Reorder 020');

    expect(handle.getAttribute('aria-disabled')).toBe('true');
    expect(handle.getAttribute('title')).toBe('Frozen — unfreeze this row before moving it');
  });
});

describe('what a drag shows while it is happening', () => {
  itDom('marks the row and the zone the drop would land in', async () => {
    // The marker is not decoration: the drop uses the zone the last dragover
    // worked out, so what is drawn and what happens are the same decision.
    await threeRoots();
    withHeight(rowFor('010'), 0, 40);

    fireEvent.dragStart(screen.getByLabelText('Reorder 030'));
    fireEvent(rowFor('010'), dragEvent('dragover', 2));
    expect(rowFor('010').getAttribute('data-drop')).toBe('above');

    fireEvent(rowFor('010'), dragEvent('dragover', 20));
    expect(rowFor('010').getAttribute('data-drop')).toBe('into');

    fireEvent.dragLeave(rowFor('010'));
    expect(rowFor('010').getAttribute('data-drop')).toBeNull();
  });

  itDom('opens a collapsed branch it is dropped into', async () => {
    // A row dropped into a closed branch is a row nobody can see, which reads
    // as a move that did nothing.
    await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
    });
  });
});

describe('someone else editing while you are typing', () => {
  itDom('does not take the focus or the half-typed value', async () => {
    // Two reviewers found this and neither was looking for it. `onKeyDown`
    // reaches `flat` through `indent`/`outdent`, and `flat` is rebuilt by every
    // refresh — so `columns` was a new array on every socket event, `flexRender`
    // gave every cell a new component type, and React unmounted and remounted
    // the lot. The comment above the dependency list had been warning about
    // exactly this while the list itself caused it.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });
    expect(document.activeElement).toBe(input);

    // Somebody else's edit lands mid-word.
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('survives their edit landing in the very field being typed in', async () => {
    // The test above only ever delivered an edit that left this row's name
    // alone, so it passed while `key={`${id}-${name}`}` was still on the input:
    // an unchanged name is an unchanged key. Changing the name is the case that
    // remounted the node and dropped the focus to the body, and it is the one
    // that happens whenever two people work on one row.
    // Proof: `key` restored on the name input in `wbs-table.tsx` and only this
    // test failed — `document.activeElement` was `<body>` and the value was the
    // peer's, not the half-typed one.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });

    // Their edit, to this row's name — the value this cell renders from.
    api.rows[0].name = 'Rewire the shed';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('shows their edit in a cell nobody is typing in', async () => {
    // The other half of the rule, and the reason it is a separate test: a cell
    // that simply never accepted a new value would pass both tests above.
    // Proof: the `input.value = latest.current` assignment in `cell-input.tsx`
    // deleted, and only this test failed — the cell still read 'Strip'.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    fireEvent.change(input, { target: { value: 'Strip' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(input).toHaveProperty('value', 'Strip');
    });

    api.rows[0].name = 'Rewire the shed';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(input).toHaveProperty('value', 'Rewire the shed');
  });

  itDom('sends nothing when a cell is left without being typed in', async () => {
    // Every blur used to be a PATCH of whatever the box held, so clicking
    // through a row wrote every cell it passed. Each of those writes is a
    // broadcast and a refetch for everyone else, and one of them is a revert: a
    // cell whose peer edit was held back while its owner was typing, then typed
    // back to what it said before, blurs holding the older of the two values.
    // Proof: `input.value !== shown.current` in `cell-input.tsx`'s `onBlur`
    // replaced with `true`, and only this test failed — one patch of a name
    // nobody typed.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    fireEvent.change(input, { target: { value: 'Strip' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(api.rows[0].name).toBe('Strip');
    });

    const patched: unknown[] = [];
    api.patch = (...args: unknown[]) => {
      patched.push(args);
      return Promise.resolve();
    };

    // Their edit lands, then this client focuses the cell and leaves it again
    // without typing.
    api.rows[0].name = 'Rewire the shed';
    await act(async () => {
      notify();
      await Promise.resolve();
    });
    input.focus();
    fireEvent.blur(input);

    expect(patched).toEqual([]);
    expect(input).toHaveProperty('value', 'Rewire the shed');
  });

  /**
   * One row with a name and a note, a live subscription, and the two handles a
   * peer-collision test needs: what be-01 was asked for, and the peer's own
   * arrival.
   *
   * The whole point is that this goes through the real render path — the peer's
   * edit reaches the cell as new props from a refetch, exactly as it does in
   * the app, and `CellInput`'s rule 2 holds it back because this client is
   * mid-word. A test that reached into the component would prove nothing about
   * the arrival that causes the bug.
   */
  async function peerAndMe(name: string, notes: string) {
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const cell = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(cell, { target: { value: `${name}\n${notes}` } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe(notes);
    });

    const patched: [string, Record<string, string>][] = [];
    const real = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return real(id, patch);
    };
    /** Their edit, landing while this client is mid-word. */
    const theirEdit = async (change: (row: WorkItemView) => void) => {
      change(api.rows[0]);
      await act(async () => {
        notify();
        await Promise.resolve();
      });
    };
    return { api, patched, cell, theirEdit };
  }

  itDom('keeps a peer’s note when the name is what was being typed', async () => {
    // codex #3 and agy #3, from opposite ends of the same hole. The commit is
    // diffed against what this box was showing when the typing began, never
    // against the row it renders from: their note arrived mid-word and was
    // held back, so this client's blur has no idea it exists — and must not
    // therefore send `notes: ''` over the top of it.
    //
    // Proof: `was` in `commitNameCell` re-pointed at the current row props,
    // `splitNameCell(composeNameCell(here.name, here.notes))` off `flat`. This
    // failed on `expected 'measure twice' to be 'their note'` — their note
    // replaced with the stale one this client had on screen, by somebody who
    // never saw theirs. Watched, 2026-08-08.
    const { api, patched, cell, theirEdit } = await peerAndMe('Strip', 'measure twice');

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip the old wir\nmeasure twice' } });
    await theirEdit((row) => {
      row.notes = 'their note';
    });
    // Held back rather than shown: this client is mid-word in the box their
    // edit landed in, which is the collision that makes the diff hard.
    expect(cell.value).toBe('Strip the old wir\nmeasure twice');

    fireEvent.blur(cell);
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });

    // Their note first, because it is the harm: the request shape below is how
    // it is avoided, and a test that only asserted the shape would report a
    // clobber as a disagreement about JSON.
    expect(api.rows[0]?.notes).toBe('their note');
    expect(patched).toEqual([['w1', { name: 'Strip the old wir' }]]);
    expect(api.rows[0]?.name).toBe('Strip the old wir');
  });

  itDom('keeps a peer’s name when the notes are what was being typed', async () => {
    // The mirror of it, and a separate test for the reason the pair above is:
    // a diff that got one direction right by accident would pass the other.
    //
    // Proof: the same fault. This failed on `expected 'Strip' to be 'Rewire
    // the shed'` — their rename written over by somebody who was typing a
    // note. Watched, 2026-08-08.
    const { api, patched, cell, theirEdit } = await peerAndMe('Strip', 'measure twice');

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip\nmeasure twice, cut once' } });
    await theirEdit((row) => {
      row.name = 'Rewire the shed';
    });
    expect(cell.value).toBe('Strip\nmeasure twice, cut once');

    fireEvent.blur(cell);
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });

    expect(api.rows[0]?.name).toBe('Rewire the shed');
    expect(patched).toEqual([['w1', { notes: 'measure twice, cut once' }]]);
    expect(api.rows[0]?.notes).toBe('measure twice, cut once');
  });

  itDom('keeps a refused draft on screen when the next refetch arrives', async () => {
    // codex round 1, finding 1. A refusal leaves the typed text in the box and
    // nowhere else: be-01 has not got it, and the row this cell renders from
    // still says what it always said. The next refetch — anybody's edit, this
    // client's own next request, a reconnect — carries a value that differs
    // from what the box was last showing, and rule 1 would write it in over
    // two fields the person typed and was never told were lost.
    //
    // Proof: the `refused.current` gate deleted from `sync`, this failed on
    // `expected 'Rewire the shed\nmeasure twice' to be 'Strip the wiring\n
    // measure twice, cut …'` — both typed fields replaced by the server's,
    // silently. Watched, 2026-08-08.
    const { api, cell, theirEdit } = await peerAndMe('Strip', 'measure twice');
    // Refused for a reason retyping cannot fix, so what is in the box is all
    // there is of this edit anywhere.
    api.patch = () => Promise.reject(new Error('forbidden'));

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip the wiring\nmeasure twice, cut once' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });

    await theirEdit((row) => {
      row.name = 'Rewire the shed';
    });

    expect(cell.value).toBe('Strip the wiring\nmeasure twice, cut once');
  });
});

describe('a name and its notes in one box', () => {
  /**
   * One row, named and noted, with every `patch` recorded.
   *
   * The row is set up through the box itself rather than by writing to the
   * fake, so what these tests start from is a state this component can
   * actually produce.
   */
  async function noted(name: string, notes: string) {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(cell, { target: { value: notes === '' ? name : `${name}\n${notes}` } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.name).toBe(name);
    });
    expect(api.rows[0]?.notes).toBe(notes);

    const patched: [string, Record<string, string>][] = [];
    const real = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return real(id, patch);
    };
    return { api, patched, cell };
  }

  /** Types a whole value into the Name cell and leaves it, the way a person does. */
  const retype = (value: string) => {
    const cell = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    cell.focus();
    fireEvent.change(cell, { target: { value } });
    fireEvent.blur(cell);
  };

  itDom('writes the first line as the name and the rest as the notes', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText('Name of 010');

    fireEvent.change(cell, { target: { value: 'Strip\n## Risks\n\n- the fuse box is old' } });
    fireEvent.blur(cell);

    await waitFor(() => {
      expect(api.rows[0]?.name).toBe('Strip');
    });
    expect(api.rows[0]?.notes).toBe('## Risks\n\n- the fuse box is old');
  });

  itDom('sends one request for a name and a note typed together', async () => {
    // One request, so one refusal, one journal entry and one Cmd+Z. Two
    // patches would undo as two, which is a name and a note that came from one
    // gesture coming back in two.
    const { patched } = await noted('Strip', 'measure twice');

    retype('Strip the wiring\nmeasure twice, cut once');

    await waitFor(() => {
      expect(patched).toEqual([
        ['w1', { name: 'Strip the wiring', notes: 'measure twice, cut once' }],
      ]);
    });
  });

  itDom('sends only the field that changed', async () => {
    // The subset, not the pair: a patch of both fields is a write to be-01 of
    // a field nobody touched, and the last-writer-wins collision this whole
    // design is trying not to have.
    const { patched } = await noted('Strip', 'measure twice');

    retype('Strip the wiring\nmeasure twice');
    await waitFor(() => {
      expect(patched).toEqual([['w1', { name: 'Strip the wiring' }]]);
    });

    retype('Strip the wiring\nmeasure twice, cut once');
    await waitFor(() => {
      expect(patched).toHaveLength(2);
    });
    expect(patched[1]).toEqual(['w1', { notes: 'measure twice, cut once' }]);
  });

  itDom('does not rewrite a note that was stored with Windows line endings', async () => {
    // Where a `\r` actually reaches this code, which is not the keyboard: a
    // `<textarea>` normalises whatever is assigned to it, so the box can never
    // hold one — but the string this cell renders from is be-01's, and be-01
    // takes what an API client or another front end sent it. The box's value
    // and the server's then differ as text while meaning the same thing, and
    // every focus-and-leave of that row would be a patch nobody typed.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    click('Add work item');
    const cell = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(cell, { target: { value: 'Strip' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.name).toBe('Strip');
    });

    const patched: [string, Record<string, string>][] = [];
    api.patch = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return Promise.resolve();
    };
    api.rows[0].notes = 'measure twice\r\ncut once';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    // The box holds the browser's newlines; the server holds Windows's.
    expect(cell.value).toBe('Strip\nmeasure twice\ncut once');

    // Clicked into and out of, nothing typed.
    cell.focus();
    fireEvent.blur(cell);
    await act(async () => {
      await Promise.resolve();
    });

    expect(patched).toEqual([]);
    expect(api.rows[0]?.notes).toBe('measure twice\r\ncut once');
  });

  itDom('renames the work item when the first line is deleted', async () => {
    // The edit this design has to be honest about, watched end to end: one
    // merged field means what it says. Cmd+Z is the way back, and the plan's
    // reviewers chose this over a guard that would make one field behave like
    // two.
    const { api, patched } = await noted('Strip', 'measure twice\nand again');

    retype('measure twice\nand again');

    await waitFor(() => {
      expect(patched).toEqual([['w1', { name: 'measure twice', notes: 'and again' }]]);
    });
    expect(api.rows[0]?.name).toBe('measure twice');
  });

  itDom('commits an unnamed work item when the first line is emptied', async () => {
    // Same rule, no special case: the completeness checker is what reports a
    // work item with no name, and it does.
    const { api, patched } = await noted('Strip', 'measure twice');

    retype('\nmeasure twice');

    await waitFor(() => {
      expect(patched).toEqual([['w1', { name: '' }]]);
    });
    expect(api.rows[0]?.name).toBe('');
    expect(api.rows[0]?.notes).toBe('measure twice');
    expect(screen.getByLabelText('Name of 010')).toHaveValue('\nmeasure twice');
  });

  itDom('sends one request however often the cell is left before it lands', async () => {
    // codex round 1, finding 2. `shown` deliberately stays on the old value
    // until the refetch this commit triggers comes back, so between the blur
    // and that refetch the box and the baseline still disagree — and a second
    // focus-and-leave in that window would send the identical patch again.
    // Two requests are two journal entries and two Cmd+Zs for one gesture,
    // which is the thing one atomic patch was for.
    //
    // Proof: the `sent.current` comparison deleted from `onLeave`, this
    // failed on `expected [ [ 'w1', { …(2) } ], …(1) ] to have a length of 1
    // but got 2` — the same name and note written twice. Watched, 2026-08-08.
    const { api, patched, cell } = await noted('Strip', 'measure twice');
    let land: () => void = () => {
      throw new Error('nothing is in flight');
    };
    api.patch = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return new Promise<void>((resolve) => {
        land = resolve;
      });
    };

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip the wiring\nmeasure twice, cut once' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });

    // Clicked back into and out of while the first request is still out.
    cell.focus();
    fireEvent.blur(cell);
    await act(async () => {
      await Promise.resolve();
    });
    expect(patched).toHaveLength(1);

    await act(async () => {
      land();
      await Promise.resolve();
    });
    expect(patched).toHaveLength(1);
  });

  itDom('sends a refused edit again when the cell is left a second time', async () => {
    // The other half of the rule above: an unchanged resubmission is dropped
    // because be-01 already has it, so a resubmission of something be-01
    // refused must not be. Leaving the cell is how a person retries.
    //
    // Proof: the `sent.current = null` on a refusal removed, this failed on
    // `expected [] to deeply equal [ [ 'w1', { …(2) } ] ]` — the retry
    // silently dropped as a duplicate of a request that never landed.
    // Watched, 2026-08-08.
    const { api, patched, cell } = await noted('Strip', 'measure twice');
    api.patch = () => Promise.reject(new Error('forbidden'));

    retype('Strip the wiring\nmeasure twice, cut once');
    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });

    api.patch = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return Promise.resolve();
    };
    cell.focus();
    fireEvent.blur(cell);

    await waitFor(() => {
      expect(patched).toEqual([
        ['w1', { name: 'Strip the wiring', notes: 'measure twice, cut once' }],
      ]);
    });
  });

  itDom('a refused edit changes neither field and says so', async () => {
    // Atomicity is the whole reason the two fields travel in one request: a
    // refusal has to leave the row as it was, not half written.
    const { api } = await noted('Strip', 'measure twice');
    api.patch = () => Promise.reject(new Error('forbidden'));

    retype('Strip the wiring\nmeasure twice, cut once');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });
    expect(api.rows[0]?.name).toBe('Strip');
    expect(api.rows[0]?.notes).toBe('measure twice');
  });
});

describe('a drag interrupted by someone else', () => {
  itDom('is cancelled rather than left holding a row nobody picked up', async () => {
    // The browser does not reliably fire `dragend` on a source node replaced
    // mid-gesture, so `dragging` could stay set forever — after which moving the
    // pointer over the table drew drop markers and a click moved a row nobody
    // had picked up. And planning against the newest tree turns "below 010" into
    // a different move than the one that was on screen at pickup.
    const api = await threeRoots();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    // Re-render with a subscription so a peer edit can be delivered.
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Reorder 0/)).toHaveLength(6);
    });

    const moved: unknown[] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    fireEvent.dragStart(screen.getAllByLabelText('Reorder 030')[1]);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    // The drop that follows belongs to a gesture that no longer exists.
    const target = withHeight(screen.getAllByRole('row').at(-1)!, 0, 40);
    fireEvent(target, dragEvent('dragover', 20));
    fireEvent(target, dragEvent('drop', 20));

    expect(moved).toEqual([]);
    // Said in a toast, and an `info` one: nobody's request was refused and
    // nothing was lost, so this is context that may take itself off again —
    // not a failure waiting to be dismissed.
    expect(toastTexts().at(-1)).toContain('changed while you were dragging');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('moving between cells with the arrow keys', () => {
  /** Focuses a cell and puts the caret where a test needs it. */
  const focusCell = (label: string, caret: 'start' | 'end' | 'middle'): HTMLInputElement => {
    const input = screen.getByLabelText(label);
    // Either element: the Name and Notes cells are textareas so their text
    // wraps, and both carry the selection fields the keyboard code reads.
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const at =
      caret === 'start'
        ? 0
        : caret === 'end'
          ? input.value.length
          : Math.floor(input.value.length / 2);
    input.setSelectionRange(at, at);
    return input;
  };

  /** Returns whether the browser would still act on the key. */
  const press = (input: HTMLInputElement, key: string): boolean =>
    fireEvent.keyDown(input, { key });

  itDom('moves down a column of estimates', async () => {
    const api = await threeRoots();
    expect(api.rows).toHaveLength(3);

    const first = focusCell('Dev optimistic for 010', 'end');
    press(first, 'ArrowDown');

    expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 020'));
  });

  itDom('stays put at the bottom of a column', async () => {
    await threeRoots();

    const last = focusCell('Dev optimistic for 030', 'end');
    press(last, 'ArrowDown');

    expect(document.activeElement).toBe(last);
  });

  itDom('moves along a row once the caret has run out', async () => {
    await threeRoots();

    const name = focusCell('Name of 010', 'end');
    press(name, 'ArrowRight');

    // The cell beside the name, which is every field the row has and not only
    // the ones that are typed into: the pickers and the date joined the grid
    // when Tab was made to reach them.
    expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 010'));
  });

  itDom('leaves the caret alone in the middle of a word', async () => {
    // The rule that has to be right: hijacking this would make the table
    // unusable for the thing it is mainly used for. jsdom does not move a caret
    // for an arrow key, so "the browser still gets it" is asserted through
    // `defaultPrevented` rather than through where the caret ended up.
    await threeRoots();

    const name = focusCell('Name of 010', 'middle');
    const stillTheBrowsers = press(name, 'ArrowRight');

    expect(document.activeElement).toBe(name);
    expect(stillTheBrowsers).toBe(true);
  });

  itDom('takes the key only when it is moving the focus', async () => {
    await threeRoots();

    const first = focusCell('Dev optimistic for 010', 'end');
    expect(press(first, 'ArrowDown')).toBe(false);

    const last = focusCell('Dev optimistic for 030', 'end');
    expect(press(last, 'ArrowDown')).toBe(true);
  });

  itDom('does not stop on the derived number', async () => {
    await threeRoots();

    const name = focusCell('Name of 010', 'start');
    press(name, 'ArrowLeft');

    expect(document.activeElement).toBe(name);
  });

  itDom('keeps ↑ and ↓ in the name until the caret has run out of text', async () => {
    // The Name cell holds the notes under the name, so Up and Down are how
    // that text is walked. They leave the cell from the extremes only —
    // position 0 and the end of the value — which is wrap-proof: a name wraps,
    // so counting logical lines would let go of the key while the caret still
    // had visual lines to climb. `e2e/layout.spec.ts` measures the wrapped case
    // in a browser; jsdom cannot wrap anything.
    await threeRoots();
    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 020');
    fireEvent.change(name, { target: { value: 'Sand the frames\nmeasure twice' } });
    name.focus();

    // Mid-text: the browser keeps both keys and the focus does not move.
    name.setSelectionRange(6, 6);
    expect(fireEvent.keyDown(name, { key: 'ArrowUp' })).toBe(true);
    expect(document.activeElement).toBe(name);
    expect(fireEvent.keyDown(name, { key: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(name);

    // At the very start, Up leaves — the second press of a real keyboard,
    // where the first walked the caret up to 0.
    name.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(name, { key: 'ArrowUp' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));

    // And at the very end, Down does.
    name.focus();
    name.setSelectionRange(name.value.length, name.value.length);
    expect(fireEvent.keyDown(name, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 030'));
  });

  itDom('still walks a column of one-line boxes from any caret position', async () => {
    // The other half of the same rule, and the reason it is a separate test: a
    // gate applied to every cell would break filling an estimate column down
    // forty rows, where Up and Down do nothing to the text at all.
    await threeRoots();
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '345' } });
    box.focus();
    box.setSelectionRange(1, 1);

    expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 020'));
  });

  itDom('skips the children of a collapsed branch', async () => {
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    // `010.1` is off screen; Down has to land on the next row a person can see.
    const name = focusCell('Name of 010', 'end');
    press(name, 'ArrowDown');

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    expect(api.rows).toHaveLength(3);
  });
});

describe('arrow keys — cross-review findings', () => {
  const focus = (label: string, at: 'start' | 'end') => {
    const input = screen.getByLabelText(label);
    // Either element: the Name and Notes cells are textareas so their text
    // wraps, and both carry the selection fields the keyboard code reads.
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const pos = at === 'start' ? 0 : input.value.length;
    input.setSelectionRange(pos, pos);
    return input;
  };

  const arrow = (key: string, init: Record<string, unknown> = {}) => {
    const active = document.activeElement;
    if (!isCell(active)) throw new Error('nothing focused');
    fireEvent.keyDown(active, { key, ...init });
    return document.activeElement;
  };

  itDom('arrives with a collapsed caret, not a selection', async () => {
    // agy, high. Arriving cells were selected, and a full selection reads as
    // `hasSelection` — the rule that keeps Shift+Arrow out of the grid — so the
    // next press in the same direction did nothing and crossing a row of
    // populated cells took twice the keys.
    //
    // jsdom does not move a caret for an arrow key, so what is asserted is the
    // caret this code puts there, on the edge the travel came from. Whether the
    // browser then walks it across the value is the browser's own behaviour.
    await threeRoots();
    const typed: readonly (readonly [string, string])[] = [
      ['Dev optimistic for 010', '3'],
      ['Dev realistic for 010', '5'],
    ];
    for (const [label, days] of typed) {
      const box = screen.getByLabelText(label);
      fireEvent.change(box, { target: { value: days } });
      fireEvent.blur(box);
    }
    await waitFor(() => {
      expect(screen.getByLabelText('Dev realistic for 010')).toHaveProperty('value', '5');
    });

    // Between two populated boxes, which is where a caret dropped on the wrong
    // edge is felt: crossing a row of them is what took twice the keys.
    focus('Dev optimistic for 010', 'end');
    const arrived = arrow('ArrowRight');

    expect(arrived).toBe(screen.getByLabelText('Dev realistic for 010'));
    if (!isCell(arrived)) throw new Error('not an editable cell');
    expect(arrived.value).toBe('5');
    expect([arrived.selectionStart, arrived.selectionEnd]).toEqual([0, 0]);

    // And coming back the other way lands on the far edge, for the same reason.
    const back = arrow('ArrowLeft');
    if (!isCell(back)) throw new Error('not an editable cell');
    expect(back).toBe(screen.getByLabelText('Dev optimistic for 010'));
    expect([back.selectionStart, back.selectionEnd]).toEqual([
      back.value.length,
      back.value.length,
    ]);
  });

  itDom('leaves an IME composition to the input', async () => {
    // codex, high. Up and Down pick a candidate while composing; taking them
    // moves the focus out of a half-written word and commits it.
    await threeRoots();
    focus('Name of 010', 'end');

    expect(arrow('ArrowDown', { isComposing: true })).toBe(screen.getByLabelText('Name of 010'));
  });

  itDom('leaves a modified arrow to the browser', async () => {
    // Ctrl and Meta only. Alt is the grid's own now — it moves the row rather
    // than the focus, which is `moving rows with alt and the arrows` below.
    await threeRoots();

    for (const modifier of ['ctrlKey', 'metaKey']) {
      focus('Name of 010', 'end');
      expect(arrow('ArrowDown', { [modifier]: true })).toBe(screen.getByLabelText('Name of 010'));
    }
  });

  itDom('never stops on a parent’s rolled-up figures', async () => {
    // Both reviewers. A parent's estimates are sums and read-only; landing there
    // is the same dead keypress the derived number column was excluded for.
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    expect(api.rows.find((r) => r.number === '010')?.rolledUp).toBe(true);

    // Up the column from the child, where the parent's box is the row directly
    // above: it is a sum, so there is nothing above this one to type into and
    // the focus stays where it is.
    //
    // Proof: `:not([readonly])` stripped from `editableGrid`'s selector, this
    // failed with the focus on `Dev optimistic for 010` — the parent's own
    // rolled-up box. Watched, 2026-08-07. The row-wise half of this claim is
    // `Shift+Tab steps over a parent’s read-only estimate boxes`: an arrow
    // cannot reach the trio from the right, because the assignee picker
    // between them is a cell Tab leaves and the arrows do not.
    focus('Dev optimistic for 010.1', 'start');
    expect(arrow('ArrowUp')).toBe(screen.getByLabelText('Dev optimistic for 010.1'));

    // And down the column from the child, past the row below it.
    focus('Dev optimistic for 010.1', 'end');
    expect(arrow('ArrowDown')).toBe(screen.getByLabelText('Dev optimistic for 020'));
  });

  itDom('navigates from every editable cell, not just the ones the first tests used', async () => {
    // codex, medium. The original tests moved from the name and from Dev
    // optimistic only, so removing the handler from the last cell of the row —
    // or from realistic and pessimistic — left them green.
    await threeRoots();
    const columns = [
      'Name of 010',
      'Dev optimistic for 010',
      'Dev realistic for 010',
      'Dev pessimistic for 010',
      'QA estimate for 010',
    ];

    for (const label of columns) {
      // `end` is load-bearing for the Name cell and inert for the rest: the
      // box that holds the notes keeps Down until the caret has run out of
      // text, and an estimate box is one line where it never has any to run
      // out of.
      focus(label, 'end');
      expect(arrow('ArrowDown')).toBe(screen.getByLabelText(label.replace('010', '020')));
    }
  });
});

describe('Tab moves between the fields, from every cell', () => {
  /** Focuses a cell and puts the caret where a test needs it. */
  const focusCaret = (
    label: string,
    at: 'start' | 'middle' | 'end',
  ): HTMLInputElement | HTMLTextAreaElement => {
    const input = screen.getByLabelText(label);
    // Either element: the Name and Notes cells are textareas so their text
    // wraps, and both carry the selection fields the keyboard code reads.
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const pos =
      at === 'start' ? 0 : at === 'end' ? input.value.length : Math.floor(input.value.length / 2);
    input.setSelectionRange(pos, pos);
    return input;
  };

  /** Presses Tab where the focus is, and says whether the browser still gets the key. */
  const tab = (shiftKey = false): boolean => {
    const active = document.activeElement;
    if (!isCell(active)) throw new Error('nothing focused');
    return fireEvent.keyDown(active, { key: 'Tab', shiftKey });
  };

  /** Each label paired with the one after it, so a walk reads as its own steps. */
  const stepsThrough = (labels: readonly string[]): (readonly [string, string])[] => {
    const steps: (readonly [string, string])[] = [];
    let previous: string | undefined;
    for (const label of labels) {
      if (previous !== undefined) steps.push([previous, label] as const);
      previous = label;
    }
    return steps;
  };

  itDom('Tab moves from an estimate cell to the next editable cell', async () => {
    await threeRoots();

    focusCaret('Dev optimistic for 010', 'end');
    expect(tab()).toBe(false);

    expect(document.activeElement).toBe(screen.getByLabelText('Dev realistic for 010'));
  });

  itDom('Tab in the middle of a name navigates; at caret 0 it still indents', async () => {
    await threeRoots();

    // Mid-text, Tab is what it is in any table: the next field, and the tree
    // is left alone.
    focusCaret('Name of 020', 'middle');
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 020'));
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);

    // At the very start it is still the outliner's indent, which is the one
    // special case this change keeps.
    focusCaret('Name of 020', 'start');
    tab();

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
  });

  itDom(
    'Tab from the depends input closes the picker, discards the typed search, and moves once',
    async () => {
      const api = await threeRoots();
      const added: unknown[] = [];
      const realAdd = api.addDependency.bind(api);
      api.addDependency = (id: string, predecessorId: string) => {
        added.push([id, predecessorId]);
        return realAdd(id, predecessorId);
      };

      const box = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
      box.focus();
      fireEvent.change(box, { target: { value: 'Strip' } });
      expect(screen.getByRole('listbox', { name: 'Work items 030 can depend on' })).toBeDefined();

      expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false);

      // One cell along, not two: the handler moves the focus and takes the key,
      // so the browser adds no move of its own.
      expect(document.activeElement).toBe(screen.getByLabelText('Priority for 030'));
      expect(screen.queryByRole('listbox')).toBeNull();
      // Typed text is a search, not a value. Leaving discards it, which is what
      // leaving this cell has always done.
      expect(added).toEqual([]);
      expect(screen.getByLabelText('Add a dependency to 030')).toHaveProperty('value', '');
    },
  );

  itDom('Shift+Tab from the depends input lands in the name, not on a chip button', async () => {
    await threeRoots();

    const box = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
    box.focus();
    fireEvent.change(box, { target: { value: '010' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop 030 waiting for 010' })).toBeDefined();
    });

    // The chip sits before the input inside this one cell, so the browser's own
    // Shift+Tab would land on its ✕ — a dependency one keystroke from being
    // removed by somebody who only meant to go back a field.
    const again = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
    again.focus();
    expect(fireEvent.keyDown(again, { key: 'Tab', shiftKey: true })).toBe(false);

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 030'));
  });

  itDom('walks every field of a row in turn, and on into the next row', async () => {
    // The reason this walks all of them rather than sampling: a handler left
    // off one cell is invisible to a test that starts in another, which is how
    // Tab came to work in the name and nowhere else.
    await threeRoots();

    for (const [from, to] of stepsThrough([
      'Name of 010',
      'Add a dependency to 010',
      'Priority for 010',
      'Service or team for 010',
      'People at once for 010',
      'Dev optimistic for 010',
      'Dev realistic for 010',
      'Dev pessimistic for 010',
      'Dev assignee for 010',
      'QA estimate for 010',
      'Name of 020',
    ])) {
      focusCaret(from, 'end');
      tab();
      expect(document.activeElement).toBe(screen.getByLabelText(to));
    }
  });

  itDom('walks both open roles in turn, and the grid arrows cross between them', async () => {
    // The keyboard's half of `unfolding-may-scroll`: with two roles open the
    // row is eight cells longer than any walk ever asserted, because until
    // that change a second role could not be open at all. The Tab order and
    // the grid's own left/right are the two ways across a row and both are
    // asked here — a handler left off the second role's boxes is invisible to
    // a walk that only ever sees the first one's.
    await threeRoots();
    unfoldRole('QA');

    for (const [from, to] of stepsThrough([
      'Dev pessimistic for 010',
      'Dev assignee for 010',
      'QA optimistic for 010',
      'QA realistic for 010',
      'QA pessimistic for 010',
      'QA assignee for 010',
      'Name of 020',
    ])) {
      focusCaret(from, 'end');
      tab();
      expect(document.activeElement).toBe(screen.getByLabelText(to));
    }

    // And the chord that moves between cells rather than through them: out of
    // the first open role and into the second, then back.
    focusCaret('Dev assignee for 010', 'end');
    fireEvent.keyDown(screen.getByLabelText('Dev assignee for 010'), { key: 'l', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('QA optimistic for 010'));
    fireEvent.keyDown(screen.getByLabelText('QA optimistic for 010'), { key: 'h', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Dev assignee for 010'));
  });

  itDom('steps over the date cell until the plan is on a calendar', async () => {
    // Without a project start date the earliest-start field is disabled: a Tab
    // that stopped there would take the key and land nothing, which is a dead
    // keystroke in the middle of every row.
    await threeRoots();
    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(true);

    // Straight into the next row: the date is stepped over and it was the last
    // cell of this one, now that the notes are written under the name.
    focusCaret('QA estimate for 010', 'end');
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));

    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    focusCaret('QA estimate for 010', 'end');
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));

    // And out again. A date input is focused rather than selected: it has no
    // text caret to ask for.
    expect(fireEvent.keyDown(screen.getByLabelText('Earliest start for 010'), { key: 'Tab' })).toBe(
      false,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
  });

  itDom('the arrows land in a date cell without asking it for a caret it has none of', async () => {
    // `setSelectionRange` throws `InvalidStateError` on a date input, and the
    // arrows have one to land on: the folded QA estimate sits next to it.
    await threeRoots();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    // Watched rather than left to the runner: React re-throws what a handler
    // threw as an uncaught error, which the run reports away from the test that
    // caused it. Collected here, the assertion is this test's own.
    const thrown: unknown[] = [];
    const collect = (event: ErrorEvent) => {
      thrown.push(event.error);
    };
    window.addEventListener('error', collect);
    focusCaret('QA estimate for 010', 'end');
    fireEvent.keyDown(screen.getByLabelText('QA estimate for 010'), { key: 'ArrowRight' });
    window.removeEventListener('error', collect);

    expect(thrown).toEqual([]);
    expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));
  });

  itDom('Shift+Tab steps over a parent’s read-only estimate boxes', async () => {
    // A parent's trio is a sum of what is below it: the boxes are on screen to
    // be read and take no typing, so the field before the assignee is the team
    // and the three boxes between them are not stopped in. This is the row-wise
    // half of `never stops on a parent’s rolled-up figures` — an arrow cannot
    // make this trip, because the assignee picker in the way is a cell Tab
    // leaves and the arrows do not.
    //
    // Proof: `:not([readonly])` stripped from `editableGrid`'s selector, this
    // failed with the focus on `Dev pessimistic for 010`. Watched, 2026-08-07.
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    expect(api.rows.find((r) => r.number === '010')?.rolledUp).toBe(true);
    expect(screen.getByLabelText('Dev optimistic for 010')).toHaveProperty('readOnly', true);

    const assignee = screen.getByLabelText('Dev assignee for 010');
    assignee.focus();
    expect(fireEvent.keyDown(assignee, { key: 'Tab', shiftKey: true })).toBe(false);

    expect(document.activeElement).toBe(screen.getByLabelText('Service or team for 010'));
  });

  itDom('at the edges of the grid the key is left to the browser', async () => {
    // No focus trap. The grid's edges are the first and last editable cells of
    // the whole table, not of a row: Tab at the end of a row walks into the
    // next one, and only past the last cell of the last row is the key left to
    // the browser — which finds that row's own ⋯ button. The actions are
    // reachable at the end of the table and never from the middle of a row,
    // which is what this makes consistent. One stop per row since 2026-08-08,
    // where it used to be two.
    await threeRoots();

    const last = focusCaret('QA estimate for 030', 'end');
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(last);

    const first = focusCaret('Name of 010', 'end');
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});

describe('moving rows with alt and the arrows', () => {
  /**
   * Focuses a cell and puts the caret where the test needs it.
   *
   * `middle` is the position that matters here: it is where Tab navigates and
   * Backspace deletes a character, so a structural key that works there is the
   * whole point of this block.
   */
  const focusAt = (label: string, caret: 'start' | 'middle' | 'end'): HTMLElement => {
    const input = screen.getByLabelText(label);
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const at =
      caret === 'start'
        ? 0
        : caret === 'end'
          ? input.value.length
          : Math.floor(input.value.length / 2);
    input.setSelectionRange(at, at);
    return input;
  };

  /** Presses one Alt+arrow, and reports whether the browser would still act on it. */
  const altArrow = (label: string, key: string, caret: 'start' | 'middle' | 'end' = 'middle') =>
    fireEvent.keyDown(focusAt(label, caret), { key, altKey: true });

  /** Records every move asked for, and makes none of them happen. */
  const watchMoves = (api: ProjectApi): unknown[][] => {
    const moved: unknown[][] = [];
    api.move = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    return moved;
  };

  itDom('swaps the row with the sibling below it', async () => {
    const api = await threeRoots();

    // Taken from the browser: on macOS an un-prevented Alt+arrow types a
    // character into the field as well as moving the caret.
    expect(altArrow('Name of 010', 'ArrowDown')).toBe(false);

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });
    // Moved, not copied, and still all at the root.
    expect(api.rows).toHaveLength(3);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('swaps the row with the sibling above it', async () => {
    await threeRoots();

    expect(altArrow('Name of 030', 'ArrowUp')).toBe(false);

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Paint', 'Sand']);
    });
  });

  itDom('at the first sibling it moves nothing, and still takes the key', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    // No wrap to the other end: running out of siblings is not a request to
    // reparent, nor to jump to the bottom of the group.
    expect(altArrow('Name of 010', 'ArrowUp')).toBe(false);

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    // Nothing to complain about either: a row at the top is not a mistake.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('at the last sibling it moves nothing', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    expect(altArrow('Name of 030', 'ArrowDown')).toBe(false);

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('indents from the middle of the text, where tab would not', async () => {
    // The whole point of the change: Tab restructures only at position zero of
    // the Name cell, so today this caret position means "next cell".
    await threeRoots();

    expect(altArrow('Name of 020', 'ArrowRight')).toBe(false);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('outdents from an estimate box', async () => {
    await threeRoots();
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    expect(altArrow('Dev optimistic for 010.1', 'ArrowLeft', 'end')).toBe(false);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  /**
   * Waits for the table to stop working.
   *
   * `indent` and `outdent` route a dead key through the busy-and-refetch shell
   * anyway, so a test that asserted the instant after the keystroke would be
   * asserting into the middle of a refresh — and the next keystroke would be
   * dropped by the busy rule rather than judged on its own merits.
   */
  const settle = async () => {
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add work item' })).toHaveProperty(
        'disabled',
        false,
      );
    });
  };

  itDom('a root row has nothing to outdent into', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    expect(altArrow('Name of 010', 'ArrowLeft')).toBe(false);
    await settle();

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('a first sibling has nothing to indent under', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    expect(altArrow('Name of 010', 'ArrowRight')).toBe(false);
    await settle();

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  /**
   * Drops the focus the way a browser does when React moves the row.
   *
   * jsdom keeps the focus on a node that is detached and reinserted; a browser
   * does not, which is the whole reason the table puts the focus back after a
   * move. Without this line the assertions below pass on a focus that was never
   * lost — a check that cannot fail — and with it they observe the refocus
   * itself. Proof: the refocus removed, both tests pass without this line and
   * fail with it; watched, 2026-08-06.
   */
  const dropTheFocusAsABrowserWould = () => {
    const focused = document.activeElement;
    if (!isCell(focused)) throw new Error('nothing focused to drop');
    focused.blur();
  };

  itDom('lands in the same column after an indent, not back in the name', async () => {
    // The mechanism this proves twice over: `indent` on its own lands the focus
    // in the Name cell, which is right for Enter and Backspace and wrong for a
    // key pressed in an estimate box.
    await threeRoots();

    altArrow('Dev optimistic for 020', 'ArrowRight', 'end');
    dropTheFocusAsABrowserWould();

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 010.1'));
    });
  });

  itDom('lands in the same column after a sibling swap', async () => {
    await threeRoots();

    altArrow('Dev pessimistic for 010', 'ArrowDown', 'end');
    dropTheFocusAsABrowserWould();

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });
    // The moved row is `020` now, and the focus is in the box it started in.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev pessimistic for 020'));
    });
  });

  itDom('refuses to move a frozen row and says why', async () => {
    const api = await threeRoots();
    click('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });
    const moved = watchMoves(api);

    expect(altArrow('Name of 010', 'ArrowDown')).toBe(false);

    expect(moved).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('frozen');
  });

  itDom('drops a second alt+down while the first is in flight', async () => {
    const api = await threeRoots();
    const asked: unknown[][] = [];
    const finish: (() => void)[] = [];
    api.move = (...args: unknown[]) => {
      asked.push(args);
      return new Promise<void>((resolve) => finish.push(resolve));
    };

    altArrow('Name of 010', 'ArrowDown');
    expect(asked).toHaveLength(1);

    // A held key repeats. The second press arrives against a tree that has not
    // come back yet, so it is dropped rather than queued.
    altArrow('Name of 010', 'ArrowDown');
    expect(asked).toHaveLength(1);

    await act(async () => {
      finish[0]?.();
      await Promise.resolve();
    });
    // And once the first has landed, the key works again.
    altArrow('Name of 010', 'ArrowDown');
    expect(asked).toHaveLength(2);
  });

  itDom('a plain arrow is still navigation', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    const name = focusAt('Name of 010', 'end');
    fireEvent.keyDown(name, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    expect(moved).toEqual([]);
  });

  itDom('leaves a composing alt arrow, and one with a second modifier, alone', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    for (const extra of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }]) {
      const name = focusAt('Name of 010', 'middle');
      expect(fireEvent.keyDown(name, { key: 'ArrowDown', altKey: true, ...extra })).toBe(true);
    }

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('moves the row from the dependency picker, and leaves its bare arrows alone', async () => {
    // **This pin is the reverse of the one it replaces.** `leaves the
    // dependency picker's own alt arrows alone` said the handler lives on the
    // grid cells and this box is not one of them — which made the sheet's "from
    // any cell and any caret position" false in the three cell classes that
    // open a list, and `table-mechanics` reverses it by name. What the picker
    // keeps is the *bare* arrows, which are its highlight's; Alt is not a
    // highlight gesture in any cell of this table.
    const api = await threeRoots();
    const moved = watchMoves(api);

    const picker = screen.getByLabelText('Add a dependency to 020');
    fireEvent.focus(picker);
    fireEvent.keyDown(picker, { key: 'ArrowDown' });

    // The bare arrow moved the list's highlight and nothing else.
    expect(moved).toEqual([]);

    fireEvent.keyDown(picker, { key: 'ArrowDown', altKey: true });

    expect(moved).toEqual([['w2', null, 'w3']]);
  });
});

describe('dependencies in the table', () => {
  const dependOn = (rowNumber: string, predecessorNumber: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value: predecessorNumber } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  itDom('adds a dependency by the number that is on screen', async () => {
    // Ids are not something anyone can look at. Numbers are what the table
    // shows, so numbers are what it takes.
    const api = await threeRoots();

    dependOn('020', '010');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom('says so when the number typed is not a work item', async () => {
    const api = await threeRoots();
    const added: unknown[] = [];
    api.addDependency = (...args: unknown[]) => {
      added.push(args);
      return Promise.resolve();
    };

    dependOn('020', '999');

    expect(added).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('No work item numbered 999');
  });

  itDom('removes a dependency from the chip that shows it', async () => {
    await threeRoots();
    dependOn('020', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Stop 020 waiting for 010'));

    await waitFor(() => {
      expect(screen.queryByLabelText('Stop 020 waiting for 010')).toBeNull();
    });
  });

  /** `threeRoots` plus `040` and `050`, so a row can wait for four others. */
  const fiveRoots = async () => {
    const api = await threeRoots();
    for (const number of ['040', '050']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    return api;
  };

  /** One row's dependency count, or `null` where the cell shows none. */
  const dependsCountOf = (number: string): HTMLElement | null => {
    const found = dependsCellOf(number).querySelector('[data-dep-count]');
    return found instanceof HTMLElement ? found : null;
  };

  const waitFor050 = async (predecessor: string) => {
    dependOn('050', predecessor);
    await waitFor(() => {
      expect(screen.getByLabelText(`Stop 050 waiting for ${predecessor}`)).toBeDefined();
    });
  };

  itDom('counts what a row waits for, where the chips saying it are clipped', async () => {
    // The filed bug, in a fixture: four predecessors, a 110px column, and two
    // chips on screen. The count is the cell's answer to "is that all of
    // them" — asked of the *data*, so it is right whatever the column's width
    // does to the chips, which is why nothing here measures anything.
    await fiveRoots();
    for (const predecessor of ['010', '020', '030', '040']) await waitFor050(predecessor);

    expect(dependsCountOf('050')?.textContent).toBe('4');
  });

  itDom('says nothing where one chip is the whole truth', async () => {
    // A `1` beside a single chip is the cell saying the same thing twice in a
    // column with no room to say anything once.
    await fiveRoots();
    await waitFor050('010');

    expect(dependsCountOf('050')).toBeNull();
  });

  itDom('keeps the count off the line a reader is already told in full', async () => {
    // The cell's sr-only line names every dependency; a count spoken beside it
    // is a third voice saying less. The pointer, which has no such line, gets
    // the same fact as a `title`.
    await fiveRoots();
    for (const predecessor of ['010', '020', '030', '040']) await waitFor050(predecessor);

    const count = dependsCountOf('050');
    expect(count?.getAttribute('aria-hidden')).toBe('true');
    expect(count?.getAttribute('title')).toBe('Waits for 4 rows');
  });

  /**
   * The depends cell's wrapper for one row: the strip, the box, and the card.
   *
   * Through the `<td>` rather than as the box's parent — since
   * `deps-single-line` the box's parent is the clipping strip, and the strip
   * carries no hover handler; the wrapper above it does.
   */
  const dependsCellOf = (number: string): HTMLElement => {
    const cell = screen.getByLabelText(`Add a dependency to ${number}`).closest('td');
    const found = cell?.firstElementChild;
    if (!(found instanceof HTMLElement)) throw new Error(`no depends cell for ${number}`);
    return found;
  };

  itDom('turns the numbers a row waits for into names, on hover', async () => {
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    dependOn('030', '020');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
    });
    // The box the numbers were typed into holds the focus, and a cell being
    // typed in is the picker's — so the pointer has to arrive after it has been
    // left, which is also how a reader gets there.
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    fireEvent.mouseEnter(dependsCellOf('030'));

    const card = screen.getByRole('tooltip');
    expect(card.getAttribute('aria-label')).toBe('What 030 waits for');
    expect(card.textContent).toContain('010 - Strip');
    expect(card.textContent).toContain('020 - Sand');
  });

  itDom('describes the box with what the row waits for, pointer or no pointer', async () => {
    // This cell's card cannot open on the focus the way the folded role cell's
    // does: the focus here already belongs to the dependency picker, which
    // opens on it and offers the rows this one could *start* waiting for — a
    // different list, over the same 110px, and stacking the two is the thing the
    // design ruled out. So the names reach a reader with no pointer as the
    // box's description instead: same list, same wording, off the same
    // `waitingFor` the card is built from, so the two cannot drift.
    //
    // Off-screen rather than absent, because it is the one route to this data
    // for anybody not using a mouse — codex round 3, finding 2.
    //
    // Proof: the `aria-describedby` dropped from the input, this failed on
    // `expected null to be 'depends-w3'`. Watched, 2026-08-09.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    const box = screen.getByLabelText('Add a dependency to 030');
    const describes = box.getAttribute('aria-describedby');
    expect(describes).not.toBeNull();
    const said = document.getElementById(describes ?? '');
    expect(said?.textContent).toContain('010 - Strip');

    // And a row waiting for nothing describes itself with nothing, rather than
    // with an empty sentence.
    expect(
      screen.getByLabelText('Add a dependency to 020').getAttribute('aria-describedby'),
    ).toBeNull();
  });

  itDom('opens no card over a row that waits for nothing', async () => {
    // The empty cell is a box and no chips; a card holding an empty list is a
    // box over the row below saying nothing.
    //
    // Proof: the `waitingFor.length > 0` condition dropped, this failed on
    // `expected <div role="tooltip" …/> to be null`. Watched, 2026-08-09.
    await threeRoots();

    fireEvent.mouseEnter(dependsCellOf('020'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('keys the hover by value, so a second enter on one cell renders nothing', () => {
    // The other half of "a hover costs one render of the table" (codex round 3,
    // finding 5), and it is the cheap half: React skips the render entirely when
    // a `useState` is set to the value it already holds, judged by `Object.is`.
    // A key that were an object — `{ rowId, columnId }` — would be a fresh
    // identity on every `mouseenter`, and a pointer resting inside one cell
    // sends those as it moves. This asserts exactly the predicate React uses.
    //
    // Not a rendering test, because jsdom counts no renders: it pins the
    // property the bailout rests on, which is the thing a later change could
    // take away. `verify.md` says so rather than claiming more.
    //
    // Proof: `cellKey` made to return `{ rowId, columnId }`, this failed on
    // `expected { rowId: 'w1', columnId: 'name' } to be { rowId: 'w1',
    // columnId: 'name' } // Object.is equality`. Watched, 2026-08-09.
    expect(cellKey('w1', 'name')).toBe(cellKey('w1', 'name'));
    expect(typeof cellKey('w1', 'name')).toBe('string');
  });

  itDom('writes no hovered cell from a cell that has no card to show', async () => {
    // Every hover boundary in this table costs one render of the whole table —
    // the state lives on the table, which is what keeps `columns` off it. A
    // cell with nothing to open must therefore not pay it, and the assertion
    // that it does not has to watch the *state*, not the card: "no card" is
    // already true of an empty depends cell for a second reason.
    //
    // So the probe is a card open elsewhere. The enter is delivered on its own,
    // without the leave a browser would send first, precisely so the write is
    // the only thing that could close it. codex round 3, finding 5.
    //
    // Proof: the `cardable` guard dropped from the depends cell's
    // `onMouseEnter`, this failed on `expected [] to have a length of 1` — the
    // open card closed by a cell that had nothing to put in its place. Watched,
    // 2026-08-09.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    fireEvent.mouseEnter(dependsCellOf('030'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.mouseEnter(dependsCellOf('020'));

    const open = screen.getAllByRole('tooltip');
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('010 - Strip');
  });

  itDom('keeps the cell to the dependency picker while it is open', async () => {
    // Two boxes off the bottom edge of one 110px cell. The list somebody is
    // typing into wins, and it opens on the focus rather than on a keystroke —
    // which is why the guard reads the picker rather than its entries.
    //
    // Proof: the `picker === null` condition dropped, this failed on `expected
    // [ <div role="tooltip" …/> ] to have a length of +0 but got 1` — the card
    // and the list stacked over one cell. Watched, 2026-08-09.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    fireEvent.mouseEnter(dependsCellOf('030'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));

    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  itDom('moves the dependent row’s start to when its predecessor finishes', async () => {
    const api = await threeRoots();
    // All three, typed. The old table nudged the neighbours of whichever box
    // you filled; it no longer edits an estimate nobody typed, so a trio is
    // saved only once it reads sensibly on its own.
    for (const [point, value] of [
      ['optimistic', '0'],
      ['realistic', '4'],
      ['pessimistic', '4'],
    ] as const) {
      const cell = screen.getByLabelText(`Dev ${point} for 010`);
      fireEvent.change(cell, { target: { value } });
      fireEvent.blur(cell);
    }
    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']?.realistic).toBe(4);
    });

    dependOn('020', '010');

    await waitFor(() => {
      const row = screen
        .getAllByRole('row')
        .find((tr) => tr.querySelector('[data-number]')?.textContent === '020');
      // `0 / 4 / 4` expects `(0 + 16 + 4) / 6` = 3.33… days. Displayed to one
      // decimal, because a column of `3.3333333333333335` is unreadable — and
      // rounded only here, never in the schedule.
      expect(row?.querySelector('[data-start]')?.textContent).toBe('3.3');
    });
  });

  itDom('marks a row with no estimate rather than showing a bare zero', async () => {
    // A zero that means "instant" and a zero that means "nobody has looked" are
    // the same number and opposite facts.
    await threeRoots();

    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');

    expect(row?.querySelector('[data-finish]')?.textContent).toContain('?');
    // And what the marker means, in the one attribute the cell has — beside
    // the day in full once there is one, rather than instead of it.
    // Proof: the `'No estimate yet'` half dropped from the cell's `title`,
    // this failed on `the given combination of arguments (null and string) is
    // invalid for this assertion` — no `title` on the cell at all, this plan
    // having no start date and so no day to put in it either. Watched,
    // 2026-08-09.
    expect(row?.querySelector('[data-finish]')?.getAttribute('title')).toContain('No estimate yet');
  });

  /**
   * The strip the chips and the box sit in at rest — the clipper
   * `deps-single-line` added — and the wrapper above it, which is still the
   * positioned ancestor the popovers hang from. Reached from the box, thrown
   * rather than defaulted: a missing strip is the change gone, not a cell
   * with nothing to say.
   */
  const stripOf = (number: string): { strip: HTMLElement; wrapper: HTMLElement } => {
    const strip = screen.getByLabelText(`Add a dependency to ${number}`).parentElement;
    if (!(strip instanceof HTMLElement) || !strip.hasAttribute('data-depends-strip')) {
      throw new Error(`the ${number} depends box is not in a strip`);
    }
    const wrapper = strip.parentElement;
    if (!(wrapper instanceof HTMLElement)) throw new Error(`the ${number} strip has no wrapper`);
    return { strip, wrapper };
  };

  /**
   * Row 030 waiting on seven others — the deep-plan fixture's dependency
   * shape, typed as one separated list the way the cell has always taken
   * one. Left at rest on the way out, which is what every claim about the
   * strip's clamp is about.
   */
  const sevenChips = async (): Promise<readonly string[]> => {
    await threeRoots();
    for (const number of ['040', '050', '060', '070', '080']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    const waited = ['010', '020', '040', '050', '060', '070', '080'];
    dependOn('030', waited.join(', '));
    await waitFor(() => {
      for (const number of waited) {
        expect(screen.getByLabelText(`Stop 030 waiting for ${number}`)).toBeDefined();
      }
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
    return waited;
  };

  itDom('clamps the chips and the box onto one nowrap line at rest', async () => {
    // jsdom lays nothing out, so what is watched here is the declarations
    // arriving on the strip under the load the change is about — seven chips,
    // the deep-plan fixture's shape: one flex line that does not wrap,
    // clipping what overruns it. That the seven-chip row really is one line
    // tall — and that a clipped chip really is invisible — is Chromium's to
    // prove, in `e2e/deps-cell.spec.ts` (R5 #14–16 fault class).
    //
    // Proof: the strip's rest branch forced to `flexWrap: 'wrap'` — the strip
    // losing nowrap — this failed on `expected 'wrap' to be 'nowrap'`.
    // Watched, 2026-08-10.
    const waited = await sevenChips();

    const { strip, wrapper } = stripOf('030');
    // All seven chips share the strip with the box: the clamp is about the
    // whole crowd, not a token pair.
    for (const number of waited) {
      expect(screen.getByLabelText(`Stop 030 waiting for ${number}`).parentElement).toBe(strip);
    }
    expect(strip.style.display).toBe('flex');
    expect(strip.style.flexWrap).toBe('nowrap');
    expect(strip.style.whiteSpace).toBe('nowrap');
    expect(strip.style.overflow).toBe('hidden');
    // The mask assumes a physical right edge to fade; the strip says which.
    expect(strip.style.direction).toBe('ltr');
    // And the wrapper above it is still the positioned ancestor, with the
    // superseded wrap declaration really gone from it.
    expect(wrapper.style.position).toBe('relative');
    expect(wrapper.style.whiteSpace).toBe('');
  });

  itDom('keeps the truncation fade on the rested strip, and off the open one', async () => {
    // The fade is the *rest* state's truncation cue, by the picker's state
    // and never by a measurement — "fade only when clipped" would need the
    // `scrollWidth` read the `+N` marker was rejected for. It comes off while
    // the picker owns the cell: the strip wraps then, nothing is clipped, and
    // the box spans the full width — a mask there fades the focus ring, the
    // caret and the typed text across the last 14px (codex + agy review,
    // 2026-08-10).
    //
    // Proof, two faults, both watched 2026-08-10: the fade deleted from the
    // strip, this failed at rest on `expected '' to contain
    // 'linear-gradient'`; the fade applied unconditionally, it failed at the
    // assertion below the focus — the picker open — on
    // `expected 'linear-gradient(to right, #000 calc(1…' to be ''`.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    const { strip } = stripOf('030');
    expect(strip.style.maskImage).toContain('linear-gradient');

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(strip.style.maskImage).toBe('');
    // While the picker owns the cell the strip wraps as the cell always did,
    // so nothing about typing or the open list changes.
    expect(strip.style.flexWrap).toBe('wrap');
  });

  itDom('keeps clipped chips out of the tab order at rest', async () => {
    // A clipped chip is a native button a sequential Tab or a reader's focus
    // walk could still reach, invisible — and on the way there the browser
    // may scroll the `overflow: hidden` strip to show what it focused,
    // shifting the rested layout. So at rest every ✕ is `tabIndex={-1}`;
    // with the picker open the strip wraps, every chip is on screen, and the
    // buttons are back in the order. The keyboard path to removal is
    // unchanged: the grid's Tab enters the cell at the box, the picker opens
    // on the focus, and the chips are visible and focusable again.
    //
    // Proof: the rest condition dropped — chips always focusable — this
    // failed on `expected +0 to be -1`. Watched, 2026-08-10.
    const waited = await sevenChips();

    for (const number of waited) {
      expect(screen.getByLabelText(`Stop 030 waiting for ${number}`).tabIndex).toBe(-1);
    }

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    // The picker owns the cell now — no listbox to look for, since a row
    // already waiting on everything has no entries to be offered, but the
    // strip wrapping is the open state the flip is tied to.
    const { strip } = stripOf('030');
    expect(strip.style.flexWrap).toBe('wrap');
    for (const number of waited) {
      expect(screen.getByLabelText(`Stop 030 waiting for ${number}`).tabIndex).toBe(0);
    }
  });

  itDom('keeps both popovers out of the clipper', async () => {
    // The strip is an `overflow: hidden` box, and an absolutely positioned
    // popover escapes such a box only when its containing block is outside it
    // — the `<td>` exemption's own rule, one layer down. A listbox or a card
    // that slipped *inside* the strip would be cut to one line however the
    // `<td>` is styled, so both stay children of the wrapper.
    //
    // Proof: the strip's closing tag moved past the listbox — the listbox
    // rendered inside the clipper — this failed on `expected
    // <span …(2)>…(3)</span> to be <span …(1)>…(2)</span>`, the listbox's
    // parent the strip rather than the wrapper. Watched, 2026-08-10.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    const { strip, wrapper } = stripOf('030');
    fireEvent.mouseEnter(wrapper);
    const card = screen.getByRole('tooltip');
    expect(card.parentElement).toBe(wrapper);
    expect(strip.contains(card)).toBe(false);

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    const list = screen.getByRole('listbox');
    expect(list.parentElement).toBe(wrapper);
    expect(strip.contains(list)).toBe(false);
  });

  /**
   * The add affordance on one row's deps cell — `dep-add-button`. By its own
   * name, which is deliberately not the box's: two controls in one cell
   * answering to `Add a dependency to 030` would be a reader told the same
   * thing twice.
   */
  const addButtonOf = (number: string): HTMLElement =>
    screen.getByLabelText(`Make ${number} wait for something`);

  itDom('offers an add button at the head of every rested deps cell', async () => {
    // Always on screen and first on the strip's line. First is the load-bearing
    // half: the strip clips its right edge, so a trailing affordance would be
    // cut out of sight in exactly the crowded cell that needs it most. jsdom
    // can watch it arrive at the head of the strip; that the head of a clipping
    // line really is the one place never cut is Chromium's, in
    // `e2e/deps-cell.spec.ts` (R5 #14–16).
    //
    // Proof: the button removed from the strip, this failed on `Unable to find
    // a label with the text of: Make 030 wait for something`. Watched,
    // 2026-08-11.
    await threeRoots();

    const { strip } = stripOf('030');
    const add = addButtonOf('030');
    expect(strip.firstElementChild).toBe(add);
    // Not squeezed away by a crowded line: the cell clips chips, never this.
    expect(add.style.flexShrink).toBe('0');
    // A real button, so a reader's element walk finds it — see the tab-order
    // test below for the one thing it deliberately is not.
    expect(add.tagName).toBe('BUTTON');
  });

  itDom('opens the picker from the add button, on the box the cell already has', async () => {
    // What the button is for: the flow a click in the cell already triggers,
    // reached without knowing the cell holds a box. The click focuses the box
    // and the box's own `onFocus` opens the picker — no second path to the
    // picker, which is why nothing here asserts a new one.
    //
    // Proof: the `onClick` body dropped (the button rendered and inert), this
    // failed on `expected <body><div>…(1)</div></body> to be <input …(10)>
    // </input>` — the focus never left the document body. Watched, 2026-08-11.
    await threeRoots();

    fireEvent.click(addButtonOf('030'));

    const box = screen.getByLabelText('Add a dependency to 030');
    expect(document.activeElement).toBe(box);
    // The picker is open on it: 030 can wait for 010 and 020, so the list has
    // entries to show.
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  itDom('keeps the add button out of the tab order, at rest and with the picker open', async () => {
    // Where the chips flip — `deps-single-line` takes them out at rest and puts
    // them back when the strip wraps — this one never enters. The keyboard has
    // this exact path already and reaches it first: Tab into the cell lands on
    // the box, and the box's focus is what opens the picker. A stop here would
    // cost one Tab per row on every walk through the plan and do nothing at the
    // end of it that the next Tab does not already do.
    //
    // Proof: the chips' condition copied onto it (`picker === null ? -1 :
    // undefined`), this failed on `expected +0 to be -1` at the assertion below
    // the focus. Watched, 2026-08-11.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    expect(addButtonOf('030').tabIndex).toBe(-1);
    // Both at rest: the chip's -1 is `deps-single-line`'s and is asserted
    // beside this one so the contrast below is between two known states.
    expect(screen.getByLabelText('Stop 030 waiting for 010').tabIndex).toBe(-1);

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    expect(stripOf('030').strip.style.flexWrap).toBe('wrap');
    // The chip is back in the order — and the add button is still out of it.
    expect(screen.getByLabelText('Stop 030 waiting for 010').tabIndex).toBe(0);
    expect(addButtonOf('030').tabIndex).toBe(-1);
  });

  itDom('refuses the press the focus, so the box beside it keeps what was typed', async () => {
    // The press must not move the focus: a button that takes it from this
    // cell's *own* box blurs the box, and this box's blur closes the picker and
    // drops the search typed into it. Somebody who types `01` and then reaches
    // for the affordance beside it would lose the search to the control that
    // means "search".
    //
    // jsdom performs no default action at all (R5 #14–15's fault class), so
    // what is watched here is the refusal itself — `preventDefault` on the
    // press — and the typed text surviving it is Chromium's, in
    // `e2e/deps-cell.spec.ts`.
    //
    // Proof: the `preventDefault` dropped from `onMouseDown`, this failed on
    // `expected true to be false` — the press left to the browser, which would
    // have moved the focus onto the button. Watched, 2026-08-11.
    await threeRoots();

    const box = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '01' } });

    // `fireEvent` answers `false` when the event was cancelled, which is the
    // only observation jsdom can make about a default action it never performs.
    expect(fireEvent.mouseDown(addButtonOf('030'))).toBe(false);
    expect(box.value).toBe('01');
  });

  itDom(
    'leaves an empty cell’s open strip on one nowrap line, and a chipped one wrapping',
    async () => {
      // The wrap is for the chips and for nothing else. With `flexWrap: 'wrap'`
      // the box's `width: 100%` claim is a whole flex line, so it cannot share
      // one with the `+` beside it: an empty cell grew a second line the moment
      // somebody clicked into it, taking the listbox down the page with it.
      // Observed in a cloud Chromium on dev at `2b2affec` — 26px at rest,
      // 44.98px open — and the pixels are `e2e/deps-cell.spec.ts`'s to keep;
      // what jsdom watches is the declaration that decides it.
      //
      // Both halves in one check on purpose: `nowrap` everywhere would pass the
      // first assertion and silently undo `deps-single-line`'s open state, which
      // is the fault a chipless-only test could not see.
      //
      // Proof: the chip condition dropped (`picker !== null ? 'wrap' :
      // 'nowrap'`, the branch as it shipped), this failed on `expected 'wrap' to
      // be 'nowrap'`. Watched, 2026-08-11.
      await threeRoots();

      // 030 waits for nothing: the chipless cell the growth was measured on.
      fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
      expect(screen.getByRole('listbox')).toBeDefined();
      expect(stripOf('030').strip.style.flexWrap).toBe('nowrap');

      // And the crowded cell is untouched — one chip is enough to need the room.
      fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
      dependOn('020', '010');
      await waitFor(() => {
        expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
      });
      expect(stripOf('020').strip.style.flexWrap).toBe('wrap');
    },
  );

  itDom('answers to one name, with no tooltip saying a different one', async () => {
    // The name is `Make 030 wait for something`, chosen so that this control
    // and the box beside it are not two controls under one name. A
    // `title="Add a dependency"` was here as well, which put the control back
    // under two: the tooltip a sighted reader gets and the name a reader's
    // walk announces disagreed, and neither is the other's summary (codex
    // review, 2026-08-11).
    //
    // Proof: `title="Add a dependency"` restored on the button, this failed on
    // `expected 'Add a dependency' to be null`. Watched, 2026-08-11.
    await threeRoots();

    const add = addButtonOf('030');
    expect(add.getAttribute('title')).toBeNull();
    expect(add.getAttribute('aria-label')).toBe('Make 030 wait for something');
  });
});

describe('picking dependencies from a list', () => {
  const depInput = (rowNumber: string) => screen.getByLabelText(`Add a dependency to ${rowNumber}`);
  /**
   * The Depends on list's entries, scoped to that listbox.
   *
   * Not a bare `getAllByRole('option')`: the toolbar's estimate-method
   * `<select>` contributes four options of its own, and a query across the
   * whole page would read the picker's list as starting with `PERT`.
   */
  const optionTexts = () => {
    const list = screen.queryAllByRole('listbox').find((box) => box.id.startsWith('dep-options-'));
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  };

  itDom('offers every other row as `number - name`, while the cell is focused', async () => {
    await threeRoots();
    fireEvent.focus(depInput('020'));

    // The separator is the assertion, not decoration around it: a bare space
    // ran `010` into a name and the two halves read as one word.
    //
    // Proof: the option's `{entry.number} - {entry.name}` cut back to
    // `{entry.name}` — the number gone from the label a person picks by.
    // **Eleven** tests failed, `11 failed | 290 passed`: this one on `expected
    // [ 'Strip', 'Paint' ] to deeply equal [ '010 - Strip', '030 - Paint' ]`,
    // `narrows the list by the number too` on `expected [ 'Strip' ] to deeply
    // equal [ '010 - Strip' ]`, and nine more — the rest of this describe and
    // every greyed-row test, three of them on `Unable to find an accessible
    // element with the role "option" and name "010 - Strip"`. Watched,
    // 2026-08-09.
    expect(optionTexts()).toEqual(['010 - Strip', '030 - Paint']);
  });

  itDom('narrows the list by name as letters are typed', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pai' } });
    expect(optionTexts()).toEqual(['030 - Paint']);
  });

  itDom('narrows the list by the number too, which is what is on the chips', async () => {
    // The other half of `pickerEntries`'s filter, and the half a person reaches
    // for: the chips in this cell say `010 ✕` and the Number column says `010`,
    // so `010` is what gets typed. Both halves need a test — a filter over the
    // name alone passes the one above and fails here.
    //
    // Proof: `row.number.toLowerCase().includes(wanted) ||` dropped from
    // `pickerEntries` — this test failed on `expected [] to deeply equal [ '010
    // - Strip' ]`, typing a number having narrowed the list to nothing at all.
    // **Six** failed in that run, `6 failed | 306 passed`: `pickerEntries >
    // filters by number substring` and one more in `dep-picker.test.ts`, and
    // three of the command chords, which reach the open list by typing a
    // number into it. Watched, 2026-08-09.
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '010' } });
    expect(optionTexts()).toEqual(['010 - Strip']);
  });

  itDom('adds the clicked entry and keeps the list open for the next pick', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole('option', { name: '010 - Strip' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
    });
    // Still open, cleared, and no longer offering what was just taken.
    expect(optionTexts()).toEqual(['030 - Paint']);
    expect(input).toHaveProperty('value', '');
  });

  itDom('Enter adds the entry the typing narrowed to', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pa' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 030')).toBeDefined();
    });
  });

  itDom('arrows move the highlight and Enter takes it', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 030')).toBeDefined();
    });
  });

  itDom('Enter with nothing typed and nothing highlighted adds nothing', async () => {
    const api = await threeRoots();
    const added: unknown[] = [];
    api.addDependency = (...args: unknown[]) => {
      added.push(args);
      return Promise.resolve();
    };
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(added).toEqual([]);
  });

  itDom('Escape closes the list', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    expect(optionTexts()).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(optionTexts()).toEqual([]);
  });

  itDom('leaving the cell closes the list', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    expect(optionTexts()).toHaveLength(2);
    fireEvent.blur(input);
    expect(optionTexts()).toEqual([]);
  });

  itDom('pressing the mouse on an option does not steal the focus', async () => {
    // In a real browser an unprevented mousedown blurs the input, the blur
    // closes the list, and the click lands on nothing. jsdom fires no blur on
    // its own, so the observable here is the prevention itself.
    await threeRoots();
    fireEvent.focus(depInput('020'));
    const option = screen.getByRole('option', { name: '010 - Strip' });
    const press = createEvent.mouseDown(option);
    fireEvent(option, press);
    expect(press.defaultPrevented).toBe(true);
  });

  itDom('pressing the mouse on the list itself does not steal the focus either', async () => {
    // The list scrolls past ~10 entries, and a scrollbar drag is a mousedown
    // on the ul, not on any option. Unprevented, it blurred the input and the
    // list unmounted under the pointer — cross review #6.
    await threeRoots();
    fireEvent.focus(depInput('020'));
    const list = screen.getByRole('listbox');
    const press = createEvent.mouseDown(list);
    fireEvent(list, press);
    expect(press.defaultPrevented).toBe(true);
  });

  itDom('the highlight follows its row when a peer edit reshuffles the list', async () => {
    const api = fakeApi();
    const strip = await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });
    const sand = await api.create('p1', { parentId: null, afterId: strip.id, name: 'Sand' });
    const paint = await api.create('p1', { parentId: null, afterId: sand.id, name: 'Paint' });
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    const input = await screen.findByLabelText('Add a dependency to 020');

    // Highlight Paint by hand: Down to Strip, Down again to Paint.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint.id}`);

    // A peer inserts a row between Strip and Sand. By index the highlight
    // would now sit on the newcomer; it must stay on Paint.
    await api.create('p1', { parentId: null, afterId: strip.id, name: 'Wedge' });
    notify();
    await waitFor(() => {
      expect(optionTexts()).toHaveLength(3);
    });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint.id}`);

    fireEvent.keyDown(input, { key: 'Enter' });
    // After the insert the rows renumbered: Sand is 030 and Paint 040. The
    // chip is the read the user gets, and it names the row the highlight was
    // on — not the one that took its index. (`api.rows` keeps a static
    // dependsOn; edges only materialize through tree(), so the chip is also
    // the honest assertion.)
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 040')).toBeDefined();
    });
  });

  itDom('a typed list of numbers still lands as several dependencies', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '010, 030' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
      expect(screen.getByLabelText('Stop 020 waiting for 030')).toBeDefined();
    });
  });
});

describe('the picker marks what be-01 would refuse', () => {
  /**
   * ```
   * 010    Strip
   *   010.1  Sand
   * 020    Paint
   * ```
   * Built through the api before the render rather than through the table's own
   * keyboard: the shape is the fixture here, not the thing under test.
   */
  const nested = async (
    edges: readonly (readonly ['strip' | 'sand' | 'paint', 'strip' | 'sand' | 'paint'])[] = [],
  ) => {
    const api = fakeApi();
    const strip = await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });
    const sand = await api.create('p1', { parentId: strip.id, afterId: null, name: 'Sand' });
    const paint = await api.create('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    const idOf = { strip: strip.id, sand: sand.id, paint: paint.id };
    for (const [predecessor, successor] of edges) {
      await api.addDependency(idOf[successor], idOf[predecessor]);
    }
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await screen.findByLabelText('Add a dependency to 010.1');
    return {
      api,
      ...idOf,
      notify: () => {
        notify();
      },
    };
  };

  const optionTexts = () => {
    const list = screen.queryAllByRole('listbox').find((box) => box.id.startsWith('dep-options-'));
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  };

  const openPicker = (rowNumber: string) => {
    const input = screen.getByLabelText<HTMLInputElement>(`Add a dependency to ${rowNumber}`);
    fireEvent.focus(input);
    return input;
  };

  /** Every call to `addDependency`, so "nothing was picked" is an observation. */
  const watchAdds = (api: ProjectApi) => {
    const added: [string, string][] = [];
    const real = api.addDependency.bind(api);
    api.addDependency = (id: string, predecessorId: string) => {
      added.push([id, predecessorId]);
      return real(id, predecessorId);
    };
    return added;
  };

  itDom('greys the row this one sits inside, and says so', async () => {
    await nested();
    openPicker('010.1');
    expect(optionTexts()).toEqual(['010 - Strip — contains this row', '020 - Paint']);
    const refused = screen.getByRole('option', { name: '010 - Strip — contains this row' });
    expect(refused.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: '020 - Paint' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  itDom('greys the row that sits inside this one', async () => {
    await nested();
    openPicker('010');
    expect(optionTexts()).toEqual(['010.1 - Sand — inside this row', '020 - Paint']);
  });

  itDom('greys the row that would loop, through the tree', async () => {
    // `020 Paint` waits for `010.1 Sand`. Sand waiting for Paint is the loop —
    // and so is `010 Strip` waiting for Paint, because Strip's only leaf is
    // Sand and that is the graph be-01 orders.
    await nested([['sand', 'paint']]);

    openPicker('010.1');
    expect(optionTexts()).toEqual(['010 - Strip — contains this row', '020 - Paint — would loop']);

    fireEvent.blur(screen.getByLabelText('Add a dependency to 010.1'));
    openPicker('010');
    expect(optionTexts()).toEqual(['010.1 - Sand — inside this row', '020 - Paint — would loop']);
  });

  itDom('clicking a greyed row adds nothing', async () => {
    const { api } = await nested();
    const added = watchAdds(api);
    openPicker('010.1');

    fireEvent.click(screen.getByRole('option', { name: '010 - Strip — contains this row' }));

    expect(added).toEqual([]);
    expect(screen.queryByLabelText('Stop 010.1 waiting for 010')).toBeNull();
  });

  itDom('the arrows step over a greyed row', async () => {
    const { paint } = await nested();
    const input = openPicker('010.1');

    // One press. Down from nothing enters at the top of the list, and the top
    // of this list is refused, so the first thing it may land on is `020`.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint}`);

    // And back up again: still nothing above `020` to reach.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint}`);
  });

  itDom('drops a highlight that a peer’s edit has just made a loop', async () => {
    // The graph moves under an open list. Nothing here is cached, so the mark
    // is re-derived from the tree that arrived — and the entry the highlight
    // was sitting on stops being pickable the moment it stops being writable.
    const { api, sand, paint, notify } = await nested();
    const input = openPicker('010.1');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint}`);

    await api.addDependency(paint, sand);
    notify();
    await waitFor(() => {
      expect(optionTexts()).toContain('020 - Paint — would loop');
    });
    // Watched from here, so the peer's own edit above is not mistaken for one
    // this cell made.
    const added = watchAdds(api);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(added).toEqual([]);
    expect(screen.queryByLabelText('Stop 010.1 waiting for 020')).toBeNull();
  });

  itDom('Enter takes nothing when the typing narrowed to a greyed row alone', async () => {
    const { api } = await nested();
    const added = watchAdds(api);
    const input = openPicker('010.1');

    fireEvent.change(input, { target: { value: 'strip' } });
    expect(optionTexts()).toEqual(['010 - Strip — contains this row']);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(added).toEqual([]);
    expect(screen.queryByLabelText('Stop 010.1 waiting for 010')).toBeNull();
  });
});

describe('dependencies in the table — cross-review findings', () => {
  /**
   * A tree read with a schedule this component did not compute.
   *
   * The `fakeApi` above works out its own miniature schedule, which makes the
   * date tests a proof about the fake. Both reviewers said so. This returns
   * fixed, distinctive numbers instead: what is asserted is that the table
   * renders what be-01 sent, which is the only part of this the table owns.
   */
  const apiReturning = (
    scheduleError: 'cycle' | null,
    schedule: Partial<WorkItemView['schedule']> = {},
  ): ProjectApi => ({
    listProjects: () =>
      Promise.resolve([
        {
          id: 'p1',
          name: 'P',
          restricted: false,
          lastOpenedAt: null,
          ownerName: 'kat',
          createdAt: 1_780_000_000_000,
        },
      ]),
    createProject: (name: string) => Promise.resolve({ id: 'p1', name, restricted: false }),
    openProject: () => Promise.resolve(),
    setEstimateMethod: () => Promise.resolve(),
    setStartDate: () => Promise.resolve(),
    listTeams: () => Promise.resolve([]),
    listTags: () => Promise.resolve([]),
    listServices: () => Promise.resolve([]),
    addTeam: () => Promise.reject(new Error('not_in_these_tests')),
    listPeople: () => Promise.resolve([]),
    addPerson: () => Promise.reject(new Error('not_in_these_tests')),
    assign: () => Promise.resolve(),
    renameProject: () => Promise.resolve(),
    duplicate: () => Promise.reject(new Error('not_in_these_tests')),
    roles: () => Promise.resolve([DEV]),
    addRole: () => Promise.reject(new Error('not_in_these_tests')),
    renameRole: () => Promise.reject(new Error('not_in_these_tests')),
    removeRole: () => Promise.reject(new Error('not_in_these_tests')),
    tree: () =>
      Promise.resolve({
        seq: 0,
        scheduleError,
        // A cycle takes the slices with the dates: there is no schedule to have
        // placed any.
        slices:
          scheduleError !== null
            ? []
            : [
                {
                  id: `w1::${DEV.id}`,
                  workItemId: 'w1',
                  roleId: DEV.id,
                  personId: null,
                  duration: 7,
                  estimated: true,
                  earliestStart: 11,
                  earliestFinish: 18,
                  latestStart: 13,
                  latestFinish: 20,
                  float: 2,
                  critical: false,
                  boundBy: 'projectStart' as const,
                  resourcePredecessorId: null,
                  width: 1,
                  effort: 7,
                  capacityPredecessorIds: [],
                  ...schedule,
                },
              ],
        roles: [DEV],
        assignedPeople: [],
        // Present and empty, never absent: be-01 always sends it, so a fake that
        // left it out would let `teamsOnThePlan` be handed `undefined` here and
        // never in production. A plan whose teams are unlimited is what `[]` says.
        teamCapacities: [],
        priorityBands: DEFAULT_PRIORITY_BANDS,
        estimateMethod: 'pert' as const,
        workItems: [
          {
            id: 'w1',
            parentId: null,
            revision: 0,
            number: '010',
            name: 'Strip',
            notes: '',
            frozenNumber: null,
            priority: null,
            rolledUp: false,
            estimates: {},
            dependsOn: [],
            finalDays: {},
            finalTotal: 0,
            startNoEarlierThan: null,
            startNoEarlierThanReason: null,
            serviceTeamId: null,
            teamIds: [],
            assignees: {},
            doesEveryPhase: null,
            dates: null,
            schedule: {
              duration: 7,
              estimated: true,
              earliestStart: 11,
              earliestFinish: 18,
              latestStart: 13,
              latestFinish: 20,
              float: 2,
              critical: false,
              ...schedule,
            },
          },
        ],
        undoable: false,
        redoable: false,
      }),
    create: () => Promise.resolve({ id: 'w2' }),
    patch: () => Promise.resolve(),
    move: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    setEstimate: () => Promise.resolve(),
    clearEstimate: () => Promise.resolve(),
    freeze: () => Promise.resolve(),
    unfreezeProject: () => Promise.resolve(),
    unfreeze: () => Promise.resolve(),
    addDependency: () => Promise.resolve(),
    removeDependency: () => Promise.resolve(),
    undo: () => Promise.reject(new Error('not_in_these_tests')),
    redo: () => Promise.reject(new Error('not_in_these_tests')),
  });

  const cells = async () => {
    const row = await waitFor(() => {
      const found = screen
        .getAllByRole('row')
        .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
      if (found === undefined) throw new Error('no row yet');
      return found;
    });
    return {
      start: row.querySelector('[data-start]')?.textContent,
      finish: row.querySelector('[data-finish]')?.textContent,
      float: row.querySelector('[data-float]')?.textContent,
    };
  };

  itDom('shows the schedule be-01 sent, not one it worked out itself', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null)} />);

    expect(await cells()).toEqual({ start: '11', finish: '18', float: '2' });
  });

  itDom('names a critical row rather than printing its zero', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null, { float: 0, critical: true })} />);

    // One word, which is what the 56px column can hold now that the word is a
    // tag rather than a figure — and what `plan-export.ts` has always printed.
    expect((await cells()).float).toBe('critical');
  });

  itDom('explains a slack figure in its hover title', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null)} />);

    await cells();
    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
    expect(row?.querySelector('[data-float]')?.getAttribute('title')).toBe(
      'This work item can slip 2 workdays before the plan finishes later.',
    );
  });

  itDom('explains what critical means in the hover title', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null, { float: 0, critical: true })} />);

    await cells();
    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
    expect(row?.querySelector('[data-float]')?.getAttribute('title')).toBe(
      'On the critical path: any delay here moves the whole plan’s finish.',
    );
  });

  itDom('shows dashes rather than zeroes when there is no schedule', async () => {
    // agy, medium. A cycle sends every row the same zeroed schedule, and
    // printing those reads as "everything happens on day zero" — a confident
    // wrong answer, next to a banner saying no dates could be worked out.
    render(<WbsTable projectId="p1" api={apiReturning('cycle')} />);

    expect(await cells()).toEqual({ start: '—', finish: '—', float: '—' });
    expect(screen.getByRole('alert').textContent).toContain('run in a circle');
    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
    expect(row?.querySelector('[data-float]')?.getAttribute('title')).toBe(
      'No schedule could be worked out, so there is no slack to show.',
    );
  });
});

describe('hovering a dependency lights the rows it names', () => {
  const dependOn = (rowNumber: string, predecessorNumber: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value: predecessorNumber } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  /**
   * The Depends on cell itself — the `<td>`, and not the wrapper inside it.
   *
   * It was `cell.firstElementChild` until 2026-08-14, because that is where
   * the cell-level enter and leave lived. They are on the cell now: a wrapper
   * stands inside the cell's padding box, and at the column's resolved 110px
   * the pills fill the wrapper edge to edge, so the gesture the spec names —
   * "the pointer is in this cell" — had nowhere left to be made from.
   * `openspec/changes/table-width-budget/design.md` D2 has the measurement.
   *
   * Proof: the handlers left on the wrapper with this helper already pointing
   * at the `<td>` — which is the fault, spelt as the state before the fix —
   * and all five cases in this block failed together, the first of them on
   * `lights every dependency’s row from the cell, and no other row:
   * expected [] to deeply equal [ '010', '020' ]`. Watched on h2puni,
   * 2026-08-14 (fault F7).
   */
  const hoverTargetOf = (number: string): HTMLElement => {
    const cell = screen.getByLabelText(`Add a dependency to ${number}`).closest('td');
    if (!(cell instanceof HTMLElement)) throw new Error(`no depends cell for ${number}`);
    return cell;
  };

  /** The numbers of every row the table has lit, in document order. */
  const litNumbers = (): string[] =>
    [...document.querySelectorAll('tr[data-dep-lit]')].map((tr) => {
      const number = tr.querySelector('[data-number]')?.textContent;
      if (number == null) throw new Error('a lit row has no number cell');
      return number;
    });

  /** Three roots where 030 waits for 010 and 020, at rest. */
  async function planWhere030Waits() {
    const api = await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    dependOn('030', '020');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
    return api;
  }

  itDom('takes the pointer on the cell itself, not on a wrapper inside it', async () => {
    // The move, said outright rather than left implicit in a helper. jsdom
    // cannot see *why* it matters — whether a pill covers the place the
    // handler answered from is a hit-testing fact and jsdom lays nothing out
    // (R5 #14–16) — but it can see **where** the handler is, which is the half
    // that is a fact about the markup. `e2e/deps-cell.spec.ts`'s `lights the
    // whole set from a crowded cell at its default width` is the other half.
    //
    // An enter reaches the element entered **and its ancestors**, never its
    // descendants — which is what makes this discriminating in one direction
    // and vacuous in the other. Entering the `<td>` cannot reach a handler on
    // the wrapper inside it, so this assertion is exactly the move; entering
    // the wrapper still reaches a handler on the `<td>`, so the mirror of it
    // would pass either way and is deliberately not written.
    await planWhere030Waits();
    const cell = hoverTargetOf('030');
    expect(cell.tagName).toBe('TD');
    // And the wrapper is really a different element, or the two names above
    // are one element and this test is about nothing.
    expect(cell.firstElementChild).not.toBe(cell);
    expect(cell.firstElementChild?.tagName).toBe('SPAN');

    fireEvent.mouseEnter(cell);
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseLeave(cell);
    expect(litNumbers()).toEqual([]);
  });

  itDom('lights every dependency’s row from the cell, and no other row', async () => {
    await planWhere030Waits();
    expect(litNumbers()).toEqual([]);

    fireEvent.mouseEnter(hoverTargetOf('030'));

    // 010 and 020 — the rows 030 waits for — and pointedly not 030 itself:
    // deriving the lit set from the hovered row's own id is the wrong-id
    // fault this assertion exists to catch.
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseLeave(hoverTargetOf('030'));
    expect(litNumbers()).toEqual([]);
  });

  itDom('narrows to the pill’s row, and widens again when the pill is left', async () => {
    await planWhere030Waits();
    fireEvent.mouseEnter(hoverTargetOf('030'));
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 010'));
    expect(litNumbers()).toEqual(['010']);

    // Off the pill but still in the cell: back to the whole waited-for set,
    // not stuck on the one pill and not cleared. `relatedTarget` names where
    // the pointer went — jsdom's default of null reads as leaving the whole
    // cell, which fires the wrapper's leave too and would make this pass for
    // the wrong reason.
    fireEvent.mouseLeave(screen.getByLabelText('Stop 030 waiting for 010'), {
      relatedTarget: screen.getByLabelText('Add a dependency to 030'),
    });
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseLeave(hoverTargetOf('030'));
    expect(litNumbers()).toEqual([]);
  });

  itDom(
    'widens back to the remaining dependencies when a pill is deleted under the pointer',
    async () => {
      await planWhere030Waits();
      fireEvent.mouseEnter(hoverTargetOf('030'));
      fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 010'));
      expect(litNumbers()).toEqual(['010']);

      // The ✕ *is* the pill, and that is the whole of the fault: the click
      // unmounts the element the pointer is on, so no `mouseleave` of its own
      // can ever arrive to say the pointer left it. Nothing else moves here —
      // no leave is fired, no hover is re-entered — because nothing else moves
      // in the browser either. The pointer is exactly where it was.
      fireEvent.click(screen.getByLabelText('Stop 030 waiting for 010'));
      await waitFor(() => {
        expect(screen.queryByLabelText('Stop 030 waiting for 010')).toBeNull();
      });

      // The cut edge's row is dark and the remaining dependency's is lit: the
      // light widened to the cell, because the cell is where the pointer still
      // is. Both ends of the fix answer to this one assertion, with a red of
      // their own: with the chip's widen dropped the light goes out altogether
      // (`expected [] to deeply equal ['020']`), and with `depLit`'s check of
      // `pillId` against the cell dropped as well it stays on the deleted edge
      // (`expected ['010'] to deeply equal ['020']`).
      expect(litNumbers()).toEqual(['020']);
    },
  );

  itDom('lights the rows a cell waits for while its box holds the focus', async () => {
    await planWhere030Waits();
    expect(litNumbers()).toEqual([]);

    // The keyboard's half of the light. Tab through the plan lands on this box
    // — `deps-single-line` keeps the chips out of the rested tab order, so the
    // box is where a Tab arrives — and the rows this row waits for light with
    // no pointer anywhere near them.
    //
    // `fireEvent.focus` and not `.focus()`: React reads focus through
    // `focusin`, which is what this dispatches, and it is wrapped in `act` so
    // the render it causes has landed by the assertion below. A bare `.focus()`
    // moves `document.activeElement` and leaves the state update unflushed —
    // watched, `expected [] to deeply equal ['010', '020']`. That a real Tab
    // reaches this box and really paints is the browser's to say, in
    // `e2e/hover-cards.spec.ts`.
    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));

    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
    expect(litNumbers()).toEqual([]);
  });

  itDom('narrows to a focused pill, and clears when the focus leaves it', async () => {
    await planWhere030Waits();
    const box = screen.getByLabelText('Add a dependency to 030');
    fireEvent.focus(box);
    expect(litNumbers()).toEqual(['010', '020']);

    // The chips are focusable while the picker owns the cell — the `tabIndex`
    // −1 above is the *rested* strip's, where a clipped chip would be a button
    // focused off screen — so this is a focus that can really be carried, and
    // it narrows exactly as a hovered pill does. Box first, then chip, in the
    // order a browser fires them: the old element's blur lands before the new
    // one's focus, which is why the box's blur cannot clear what the chip's
    // focus is about to write.
    fireEvent.blur(box);
    fireEvent.focus(screen.getByLabelText('Stop 030 waiting for 010'));
    expect(litNumbers()).toEqual(['010']);

    // A blur clears where a mouseleave widens, and the asymmetry is the point:
    // a leave means the pointer is still in the cell and the wrapper's own
    // leave is what clears, but a blur means nothing of the sort. Widening here
    // would leave the cell lit with nobody in it once the focus walked out of
    // the plan from a chip.
    fireEvent.blur(screen.getByLabelText('Stop 030 waiting for 010'));
    expect(litNumbers()).toEqual([]);
  });

  itDom('emphasises the pill’s entry in the card as a background, not bold', async () => {
    await planWhere030Waits();
    fireEvent.mouseEnter(hoverTargetOf('030'));
    const card = screen.getByRole('tooltip');
    const entryOf = (text: string): HTMLElement => {
      const found = [...card.querySelectorAll('div')].find((line) => line.textContent === text);
      if (!(found instanceof HTMLElement)) throw new Error(`no card entry reading ${text}`);
      return found;
    };
    // From the cell's input area no entry is emphasised — the whole list is.
    expect(entryOf('010 - Strip').style.background).toBe('');
    expect(entryOf('020 - Sand').style.background).toBe('');

    fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 010'));

    // The same tint the lit rows use, as a background swatch — emphasis by
    // weight would make one line read as a heading over the others. The card's
    // surface token, not the grid's: the same dose of the same ink into the
    // surface this line sits on, which is what keeps the emphasis moving the
    // same perceptual direction in both places (`styles.css`, and the browser
    // proof in `e2e/hover-cards.spec.ts` that walks both palettes).
    expect(entryOf('010 - Strip').style.background).toBe('var(--card-dep-lit)');
    expect(entryOf('010 - Strip').style.fontWeight).toBe('');
    expect(entryOf('020 - Sand').style.background).toBe('');

    // To the input area, not out of the cell (`relatedTarget`, as above): the
    // card stays open and no entry is singled out any more.
    fireEvent.mouseLeave(screen.getByLabelText('Stop 030 waiting for 010'), {
      relatedTarget: screen.getByLabelText('Add a dependency to 030'),
    });
    expect(entryOf('010 - Strip').style.background).toBe('');
  });

  itDom('a collapsed dependency has no row to light, and the card still names it', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    typeName('010.1', 'Sand the keel');
    fireEvent.blur(screen.getByLabelText('Name of 010.1'));
    // The rename is in flight and `Add work item` is disabled while it is;
    // settled first, or the click lands on a busy button and does nothing.
    await waitFor(() => {
      expect(screen.getByLabelText('Name of 010.1')).toHaveProperty('value', 'Sand the keel');
    });
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    dependOn('020', '010.1');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010.1')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 020'));

    // The probe proven live before the branch closes (R5 #16, `D
    // directory-page`): the same hover lights 010.1 while its row is shown.
    fireEvent.mouseEnter(hoverTargetOf('020'));
    expect(litNumbers()).toEqual(['010.1']);
    fireEvent.mouseLeave(hoverTargetOf('020'));

    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    fireEvent.mouseEnter(hoverTargetOf('020'));

    // No shown row is 010.1, so nothing is lit — the parent 010 must not be
    // lit in its place — and the card still names the hidden dependency.
    expect(litNumbers()).toEqual([]);
    expect(screen.getByRole('tooltip').textContent).toContain('010.1 - Sand the keel');
  });

  itDom('lights rows without remounting the cells under a half-typed name', async () => {
    // The landmine: `columns` may depend on `roles` and `unfoldedRoles` and
    // nothing else. A `columns` that rebuilt on `depHover` would hand every
    // cell a new component type on the first hover, and React would remount
    // the lot — dropping the focus to the body and the half-typed name with
    // it. The lit rows are asserted first so this cannot pass vacuously on a
    // hover that wrote nothing.
    //
    // Proof: `depHover` added to the `columns` memo's dependency list, this
    // failed on `expected <textarea …(5)></textarea> to be <textarea
    // …(5)></textarea>` — the same-labelled box a different node, the cell
    // remounted under the typist. Watched, 2026-08-10.
    await planWhere030Waits();
    const input = screen.getByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });
    expect(document.activeElement).toBe(input);

    fireEvent.mouseEnter(hoverTargetOf('030'));

    expect(litNumbers()).toEqual(['010', '020']);
    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value', 'Strip the old wir');
  });
});

describe('the pointed row', () => {
  /**
   * A pointer event of one kind or the other, built by hand.
   *
   * jsdom has no `PointerEvent`, so `fireEvent.pointerOver(node, { pointerType
   * })` builds a plain `Event` and drops the init's `pointerType` — the guard
   * then reads `undefined` and refuses, and every assertion about the pointer
   * path passes because nothing was ever pointed. `gantt-panel.test.tsx` has
   * the same helper for the same reason; both are the trap, not a preference.
   */
  const pointerEvent = (kind: 'mouse' | 'touch', name: 'pointerover' | 'pointerout'): Event => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: kind });
    // React synthesizes `onPointerEnter`/`onPointerLeave` from over/out, and
    // decides "left the row" from where the pointer went. Null is out of the
    // document, which is the departure the row's handler is about.
    Object.defineProperty(event, 'relatedTarget', { value: null });
    return event;
  };

  /** The `<tr>` a row number stands on. */
  const trOf = (number: string): HTMLElement => {
    const found = [...document.querySelectorAll('tbody tr')].find(
      (tr) => tr.querySelector('[data-number]')?.textContent === number,
    );
    if (!(found instanceof HTMLElement)) throw new Error(`no row for ${number}`);
    return found;
  };

  /** A bar on the open chart, found by the row it names. */
  const barOf = (number: string): Element => {
    const found = document.querySelector(`[data-gantt-bar][aria-label^="${number} - "]`);
    if (found === null) throw new Error(`no bar on the chart for ${number}`);
    return found;
  };

  /** The row label on the open chart, found by the words it prints. */
  const labelOf = (number: string): Element => {
    const found = [...document.querySelectorAll('[data-gantt-label]')].find((button) =>
      button.textContent.startsWith(`${number} - `),
    );
    if (found === undefined) throw new Error(`no row label for ${number}`);
    return found;
  };

  /** The numbers of every table row lit as pointed, in document order. */
  const litRows = (): string[] =>
    [...document.querySelectorAll('tr[data-row-lit]')].map((tr) => {
      const number = tr.querySelector('[data-number]')?.textContent;
      if (number == null) throw new Error('a pointed row has no number cell');
      return number;
    });

  /** The row indices of every pointed band the chart has drawn. */
  const litBands = (): string[] =>
    [...document.querySelectorAll('[data-gantt-row-lit]')].map(
      (rect) => rect.getAttribute('data-gantt-row-lit') ?? '(none)',
    );

  /**
   * Three estimated roots with the chart open beneath them.
   *
   * The chart is opened rather than left shut, because what is under test is the
   * wiring **between** the two faces: a suite that only hovered rows in the
   * table would be asserting the absence of a light with nothing to light.
   */
  async function planWithTheChartOpen() {
    const api = await threeRoots();
    // `threeRoots` unfolds Dev, so the three points are three boxes rather than
    // the folded cell's one.
    for (const number of ['010', '020', '030']) {
      for (const [point, days] of [
        ['optimistic', '2'],
        ['realistic', '3'],
        ['pessimistic', '4'],
      ]) {
        const box = screen.getByLabelText(`Dev ${point} for ${number}`);
        fireEvent.change(box, { target: { value: days } });
        fireEvent.blur(box);
      }
      await waitFor(() => {
        expect(screen.getByLabelText(`Dev realistic for ${number}`)).toHaveProperty('value', '3');
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await waitFor(() => {
      expect(document.querySelector('[data-gantt-bar]')).not.toBeNull();
    });
    return api;
  }

  itDom('lights the table row from a bar, and clears when the pointer leaves', async () => {
    await planWithTheChartOpen();
    expect(litRows()).toEqual([]);

    fireEvent(barOf('020'), pointerEvent('mouse', 'pointerover'));

    expect(litRows()).toEqual(['020']);
    expect(litBands()).toEqual(['1']);

    fireEvent(barOf('020'), pointerEvent('mouse', 'pointerout'));
    expect(litRows()).toEqual([]);
    expect(litBands()).toEqual([]);
  });

  itDom('lights the chart from a table row, and not the row itself', async () => {
    await planWithTheChartOpen();

    fireEvent(trOf('030'), pointerEvent('mouse', 'pointerover'));

    // The chart answers, which is the point of the gesture.
    expect(litBands()).toEqual(['2']);
    expect(labelOf('030').getAttribute('data-gantt-label-lit')).toBe('true');

    // And the row does **not** light itself. `tr:hover` is already tinting it,
    // and `data-row-lit` here makes the banded-hover rule unmatchable — four of
    // `e2e/hover-cards.spec.ts`'s assertions failed on exactly that, 2026-08-14.
    expect(litRows()).toEqual([]);
  });

  itDom('points one row at a time', async () => {
    await planWithTheChartOpen();

    fireEvent(barOf('010'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['010']);

    // Straight to another bar without a departure in between, which is what a
    // pointer crossing the chart does. Exactly one row stays lit.
    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['030']);
    expect(litBands()).toEqual(['2']);
  });

  itDom('is pointed by a bar’s focus, and the pointer outranks it', async () => {
    await planWithTheChartOpen();

    fireEvent.focus(barOf('010'));
    expect(litRows()).toEqual(['010']);

    // A pointer elsewhere wins while both are live: the pointer is where the
    // eyes are. One field for both would have made this impossible to express.
    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['030']);

    // And losing the pointer falls back to the focus rather than to nothing.
    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerout'));
    expect(litRows()).toEqual(['010']);
  });

  itDom('is not pointed by a tap', async () => {
    await planWithTheChartOpen();

    // Chromium synthesizes a whole mouse sequence from a tap, so a row lit on a
    // mouse event lights on every tap as well — and a tap has no departure to
    // clear it, so the light would be stuck on whatever was touched last.
    fireEvent(barOf('020'), pointerEvent('touch', 'pointerover'));
    expect(litRows()).toEqual([]);

    fireEvent(trOf('020'), pointerEvent('touch', 'pointerover'));
    expect(litBands()).toEqual([]);
  });

  itDom('points a row without remounting the cells under a half-typed name', async () => {
    // The landmine: `columns` may depend on `roles` and `unfoldedRoles` and
    // nothing else. A `columns` that rebuilt on a pointed row would hand every
    // cell a new component type on the first hover and React would remount the
    // lot, dropping the focus to the body and the half-typed name with it. The
    // lit row is asserted first so this cannot pass vacuously on a hover that
    // wrote nothing.
    await planWithTheChartOpen();
    const input = screen.getByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });
    expect(document.activeElement).toBe(input);

    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerover'));

    expect(litRows()).toEqual(['030']);
    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value', 'Strip the old wir');
  });
});

describe('the chart under a plan being edited', () => {
  /**
   * An api whose schedule moves when a not-before lands, the way be-01's does.
   *
   * `tree()` serves the schedule the last `patch` implies: no floor is day 11,
   * a floor is day 16. The numbers are distinctive rather than computed — what
   * is under test is that the open chart draws the read that followed the
   * edit, not that this fake can schedule.
   */
  const apiWithMovableFloor = (): ProjectApi => {
    let floored = false;
    const scheduleNow = () => ({
      duration: 7,
      estimated: true,
      earliestStart: floored ? 16 : 11,
      earliestFinish: floored ? 23 : 18,
      latestStart: floored ? 18 : 13,
      latestFinish: floored ? 25 : 20,
      float: 2,
      critical: false,
    });
    return {
      listProjects: () =>
        Promise.resolve([{ id: 'p1', name: 'P', restricted: false, lastOpenedAt: null }]),
      createProject: (name: string) =>
        Promise.resolve({ id: 'p1', name, restricted: false, lastOpenedAt: null }),
      openProject: () => Promise.resolve(),
      setEstimateMethod: () => Promise.resolve(),
      setStartDate: () => Promise.resolve(),
      listTeams: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
      listServices: () => Promise.resolve([]),
      addTeam: () => Promise.reject(new Error('not_in_these_tests')),
      listPeople: () => Promise.resolve([]),
      addPerson: () => Promise.reject(new Error('not_in_these_tests')),
      assign: () => Promise.resolve(),
      renameProject: () => Promise.resolve(),
      duplicate: () => Promise.reject(new Error('not_in_these_tests')),
      roles: () => Promise.resolve([DEV]),
      addRole: () => Promise.reject(new Error('not_in_these_tests')),
      renameRole: () => Promise.reject(new Error('not_in_these_tests')),
      removeRole: () => Promise.reject(new Error('not_in_these_tests')),
      tree: () =>
        Promise.resolve({
          seq: 0,
          scheduleError: null,
          startDate: '2026-08-03',
          projectRevision: 0,
          slices: [
            {
              id: `w1::${DEV.id}`,
              workItemId: 'w1',
              roleId: DEV.id,
              personId: null,
              // Which floor binds moves with the edit, the way be-01's does: a
              // row with a not-before that pushed it is a slice bound by that
              // date, and it is the one floor whose sentence has words of its
              // own to carry.
              boundBy: floored ? ('notBefore' as const) : ('projectStart' as const),
              resourcePredecessorId: null,
              width: 1,
              effort: 3,
              capacityPredecessorIds: [],
              ...scheduleNow(),
            },
          ],
          roles: [DEV],
          assignedPeople: [],
          // Present and empty, never absent: be-01 always sends it, so a fake that
          // left it out would let `teamsOnThePlan` be handed `undefined` here and
          // never in production. A plan whose teams are unlimited is what `[]` says.
          teamCapacities: [],
          priorityBands: DEFAULT_PRIORITY_BANDS,
          estimateMethod: 'pert' as const,
          workItems: [
            {
              id: 'w1',
              parentId: null,
              revision: 0,
              number: '010',
              name: 'Strip',
              notes: '',
              frozenNumber: null,
              priority: null,
              rolledUp: false,
              estimates: {},
              dependsOn: [],
              finalDays: {},
              finalTotal: 0,
              startNoEarlierThan: floored ? '2026-08-10' : null,
              startNoEarlierThanReason: null,
              startNoEarlierThanReason: floored ? 'waiting on client sign-off' : null,
              serviceTeamId: null,
              teamIds: [],
              assignees: {},
              doesEveryPhase: null,
              dates: null,
              schedule: scheduleNow(),
            },
          ],
          undoable: false,
          redoable: false,
        }),
      create: () => Promise.resolve({ id: 'w2' }),
      patch: (_id: string, body: object) => {
        if ('startNoEarlierThan' in body) floored = body.startNoEarlierThan !== null;
        return Promise.resolve();
      },
      move: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      setEstimate: () => Promise.resolve(),
      clearEstimate: () => Promise.resolve(),
      freeze: () => Promise.resolve(),
      unfreezeProject: () => Promise.resolve(),
      unfreeze: () => Promise.resolve(),
      addDependency: () => Promise.resolve(),
      removeDependency: () => Promise.resolve(),
      undo: () => Promise.reject(new Error('not_in_these_tests')),
      redo: () => Promise.reject(new Error('not_in_these_tests')),
    };
  };

  itDom('redraws the open chart when a not-before edit moves the schedule', async () => {
    render(<WbsTable projectId="p1" api={apiWithMovableFloor()} />);
    await waitFor(() => rowFor('010'));

    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const bar = () => document.querySelector('[data-gantt-bar]');
    expect(bar()?.getAttribute('data-start')).toBe('11');

    typeIntoNotBefore('010', '2026-08-10');

    // The chart is on screen the whole time, and the read that followed the
    // edit is what it must be drawing — a bar still on day 11 is the schedule
    // of a moment ago under a table already showing the new one.
    await waitFor(() => {
      expect(bar()?.getAttribute('data-start')).toBe('16');
    });
    expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('16');
  });

  itDom('says on the bar why the date that holds it is there', async () => {
    // The wiring `not-before-reason` (#81) could not do from its own side: the
    // chart row is built in this file, and a `GanttRow` that carried no reason
    // left `floorWordsOf` appending nothing to a sentence it was already
    // printing. The words themselves are `gantt-geometry`'s and tested there.
    //
    // Proof: `notBeforeReason` dropped from `ganttPlan`'s row literal, this
    // fails on `expected 'Strip. 1 person. Held by its start-no-earlier-than
    // date' to contain 'Held by its start-no-earlier-than date — waiting on
    // client sign-off'`. Watched, 2026-08-18.
    render(<WbsTable projectId="p1" api={apiWithMovableFloor()} />);
    await waitFor(() => rowFor('010'));
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const bar = () => document.querySelector('[data-gantt-bar]');

    typeIntoNotBefore('010', '2026-08-10');

    await waitFor(() => {
      expect(bar()?.getAttribute('aria-label')).toContain(
        'Held by its start-no-earlier-than date — waiting on client sign-off',
      );
    });
  });
});

describe('the order of the columns', () => {
  itDom('opens with the number, the name, and then what the row waits for', async () => {
    // "Depends on" sat between Number and Name until 2026-08-06, because
    // dependencies belong beside the identity of a row and the numbers in the
    // cell refer to the Number column. They still do, and they still are — the
    // identity of a row is now Number *and* Name, with what it waits for
    // immediately after both.
    //
    // What moved it is the pinned frame below. `position: sticky; left` holds
    // a cell at a fixed offset from the left edge, which only lines up while
    // the pinned columns are contiguous from that edge — so pinning Name, the
    // thing a plan is read by while scrolling out to the dates, meant Name had
    // to come third rather than fourth. Deliberate reversal, written down in
    // `openspec/changes/sticky-table-frame/proposal.md`.
    await threeRoots();

    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.trim());

    // `#` rather than `Number` since `spreadsheet-geometry`: the glyph every
    // spreadsheet heads this column with, in a column 93px wide. The word is
    // still the heading's accessible name, which the assertion below is about.
    expect(headers.slice(0, 4)).toEqual(['', '#', 'Name', 'Depends on']);
    expect(screen.getByRole('columnheader', { name: 'Number' })).toBeDefined();
    // And the schedule stays on the right, where it reads as an outcome of
    // everything to its left rather than as something to fill in.
    // The schedule stays on the right, where it reads as an outcome of
    // everything to its left. "Not before" is the one input among them, and it
    // sits immediately before the dates it constrains.
    // One word each: at 52px a heading has room for a word and the sentence
    // it used to be lives in the `title`.
    // No Notes column: a work item's notes are typed under its name, in the
    // Name cell, and the column they had is gone.
    // `Not bef.`, not `Not before`: the column is 84px at its widest and 56 at
    // its narrowest, and the sentence it used to be is in the heading's
    // `title`.
    expect(headers.slice(-5)).toEqual(['Not bef.', 'Start', 'End', 'Slack', '']);
    expect(headers).not.toContain('Notes');
  });
});

describe('the frame the table scrolls inside', () => {
  /**
   * jsdom lays nothing out, so nothing here can watch a column actually stay
   * put. What it can watch is every rule that makes it stay put arriving on
   * the element it has to be on — which is where all three of these went
   * wrong while this was being written. Whether the result reads well at 1280
   * pixels is Dany's screen's to say; `verify.md` says so out loud.
   */
  itDom('scrolls the table rather than the page', async () => {
    await threeRoots();

    const frame = screen.getByRole('table').parentElement;

    expect(frame?.dataset['tableFrame']).toBeDefined();
    // Both axes: `overflow-x: auto` forces the other one to compute to `auto`
    // regardless, and the bound on the height is what makes this box the
    // scrollport the heading below sticks to.
    expect(frame?.style.overflow).toBe('auto');
    // That bound was `max-height: calc(100vh - 16rem)` until `H
    // header-fits-a-row`; it is now `flex-shrink: 1` inside a column that is
    // one window tall, so a plan past the remainder is shrunk to it rather than
    // measured against an estimate of the chrome. Same claim — this box is
    // bounded and therefore scrolls — read off the property that now carries
    // it. Since `unified-scroll-docking` it does not grow past its own rows
    // either. What a browser makes of both is `e2e/header.spec.ts`'s and
    // `e2e/plan-surface.spec.ts`'s; jsdom lays nothing out.
    expect(frame?.style.flex).toBe('0 1 auto');
    // And the flex basis is the only opinion about it: a `max-height` back
    // beside it would be the estimate again, disagreeing with the layout the
    // first time the header changed.
    expect(frame?.style.maxHeight).toBe('');
  });

  itDom('keeps the column headings against the top of the frame', async () => {
    await threeRoots();

    const headers = screen.getAllByRole('columnheader');

    expect(headers.length).toBeGreaterThan(6);
    for (const header of headers) {
      expect(header.style.position).toBe('sticky');
      expect(header.style.top).toBe('0px');
      // Transparent, the heading would have rows sliding through it.
      expect(header.style.background).not.toBe('');
    }
  });

  itDom('pins the handle, the number and the name, and nothing past them', async () => {
    await threeRoots();

    const cells = [...rowFor('020').querySelectorAll('td')];

    // Each offset is the sum of the widths in front of it — 24, then 24+105.
    expect(cells.slice(0, 3).map((td) => [td.style.position, td.style.left])).toEqual([
      ['sticky', '0px'],
      ['sticky', '24px'],
      ['sticky', '129px'],
    ]);
    // Pinned and still flexible: the pin places the Name cell and the colgroup
    // sizes it, and a `width` here would be the second opinion that put a
    // pinned Name over "Depends on" in the first place.
    // Proof: `pinnedCellStyle` made to declare `width: pinned.width ?? 360`
    // again, this failed on `expected '360px' to be ''`. Watched, 2026-08-08.
    expect(cells[2]?.style.width).toBe('');
    expect(cells[1]?.style.width).toBe('105px');
    // And the floor that keeps it readable while the frame is scrolling.
    expect(cells[2]?.style.minWidth).toBe('200px');
    // Opaque, or the row scrolling behind a pinned cell shows through it.
    for (const pinned of cells.slice(0, 3)) expect(pinned.style.background).not.toBe('');
    // "Depends on" is the fourth column now, and it scrolls away like the rest.
    expect(cells[3]?.style.position).toBe('');
  });

  itDom('pins the same three columns in the heading, over everything else', async () => {
    await threeRoots();

    const headers = screen.getAllByRole('columnheader');

    // Sticky on both axes at once: scrolled right *and* down, the Number
    // heading is the one cell that has to stay in its corner.
    expect(headers[1]?.style.left).toBe('24px');
    expect(headers[1]?.style.top).toBe('0px');
    // And it crosses both of the others, so it paints over both.
    const [pinnedBodyCell] = [...rowFor('020').querySelectorAll('td')].slice(1);
    expect(Number(headers[1]?.style.zIndex)).toBeGreaterThan(Number(headers[6]?.style.zIndex));
    expect(Number(headers[1]?.style.zIndex)).toBeGreaterThan(Number(pinnedBodyCell.style.zIndex));
  });
});

describe('holding the chart to the row the table is showing', () => {
  /**
   * A plan be-01 could work no dates out for, which is what a circle of
   * dependencies gets back.
   *
   * The rows still arrive — the table draws them with dashes where the dates
   * would be — and it is the *chart* that becomes something else: a sentence
   * about the circle under the same `[data-gantt-panel]` a chart carries.
   */
  const circularApi = (): ProjectApi => {
    const api = fakeApi();
    return {
      ...api,
      // A cycle takes the slices with it, the way be-01 sends it: there is no
      // schedule to have placed any.
      tree: () =>
        api.tree().then((tree) => ({ ...tree, scheduleError: 'cycle' as const, slices: [] })),
    };
  };

  itDom('does not hold the chart to the table while the plan is a circle', async () => {
    // Found in cross-review, 2026-08-12, and by nothing else: the link is
    // installed on whatever answers `[data-gantt-panel]`, and on a cycle that
    // is the message rather than the chart. The message has no calendar axis,
    // `panelFace` refuses an element it cannot measure — and it does it inside
    // a scroll listener, where no React boundary is, so every scroll of the
    // frame threw for as long as the circle stood.
    //
    // Proof: the axis guard in `wbs-table.tsx` dropped — this failed on
    // `expected [ 'Error: the Gantt panel has no calendar axis to measure its
    // content top from' ] to deeply equal []`. Watched on h2puni, 2026-08-13.
    render(<WbsTable projectId="p1" api={circularApi()} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Gantt');

    const panel = document.querySelector('[data-gantt-panel]');
    // The state this is about: a panel, and not a chart.
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-gantt-axis]')).toBeNull();

    // A listener that throws does not throw at the dispatch — the browser
    // reports it to the window instead, which is exactly why this went
    // unnoticed. So that is where it is watched for.
    const reported: string[] = [];
    const onError = (event: ErrorEvent) => {
      reported.push(String(event.error ?? event.message));
    };
    window.addEventListener('error', onError);
    try {
      const frame = screen.getByRole('table').parentElement;
      if (frame === null) throw new Error('no table frame rendered');
      fireEvent.scroll(frame);
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(reported).toEqual([]);
  });
});

describe('the widths the table is laid out by', () => {
  /**
   * jsdom lays nothing out, so none of this can watch a column stop short of
   * its neighbour. What it can watch is the one thing that made the overlap
   * possible — more than one opinion about how wide a column is — being gone
   * from the markup: one declared width per column, the table adding up to the
   * same total, and no control inside a cell asking for a width of its own.
   */
  itDom('declares every rendered column once, in the order they are rendered', async () => {
    await threeRoots();

    const cols = [...document.querySelectorAll<HTMLElement>('colgroup col')];
    const headerCells = screen.getAllByRole('columnheader');

    expect(cols.length).toBe(headerCells.length);
    // In order, not merely in the same number: the pinned offsets are the
    // running total of the first columns' widths, so a colgroup that declared
    // the same widths in another order would lay Name out somewhere other than
    // the 196px it is pinned at. These are the numbers the pin test asserts.
    // Proof: the colgroup rendered from a reversed id list, this failed on
    // `['110px','260px','90px']` against `['28px','168px','360px']`. Watched,
    // 2026-08-07.
    //
    // Name is the third and it declares nothing at all: it is the one column
    // that takes what the others leave, which is what makes the table fit the
    // window instead of the other way round.
    // Proof: the colgroup made to declare `360` for a flexible column, this
    // failed on `expected ['24px','93px','360px'] to deeply equal
    // ['24px','93px','']`. Watched, 2026-08-08, when this column was 169px.
    expect(cols.slice(0, 3).map((col) => col.style.width)).toEqual(['24px', '105px', '']);
    for (const [at, col] of cols.entries()) {
      expect(col.style.width === '').toBe(at === 2);
    }
  });

  itDom('names every cell with the column it belongs to, in both halves of the table', async () => {
    await threeRoots();

    const cols = [...document.querySelectorAll<HTMLElement>('colgroup col')];
    const named = (cells: Element[]) => cells.map((cell) => cell.getAttribute('data-column'));

    // The browser layout gate measures these boxes and compares them against
    // the declared widths; a rectangle with no column name attached is a
    // failure that cannot say which column moved. Asserted here because that
    // gate needs a browser and this suite is the only thing the repo gate runs.
    // Proof: `data-column` dropped from the `td`, this failed with a row of
    // `null`s against the header's names. Watched, 2026-08-07.
    expect(named(screen.getAllByRole('columnheader'))).toEqual(
      named([...rowFor('020').querySelectorAll('td')]),
    );
    expect(named(screen.getAllByRole('columnheader')).length).toBe(cols.length);
    for (const name of named(screen.getAllByRole('columnheader'))) expect(name).not.toBe(null);
  });

  itDom('is as wide as the frame, and never narrower than its own equation', async () => {
    await threeRoots();

    const table = screen.getByRole('table');
    const columnIds = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');

    // `fixed`, or the browser sizes the columns from their content and the
    // declared widths become decoration — which is the auto layout half of the
    // overlap.
    expect(table.style.tableLayout).toBe('fixed');
    // The frame's width, and the equation as the floor under it. A declared
    // total is what this replaces: it made the window fit the table.
    // Proof: the `<table>` put back to a declared total —
    // `width: tableMinWidth(leafColumnIds)` with no `minWidth` — this failed
    // on `expected '1420px' to be '100%'`. Watched, 2026-08-08, when this read
    // a flat `100%`; `spreadsheet-geometry` put the Name cap in the same
    // declaration and the frame's 100% is still the first term of it.
    expect(table.style.width).toBe(
      `min(100%, ${String(frameLayout(columnIds, UNDATED).maxWidth)}px)`,
    );
    expect(table.style.minWidth).toBe(`${String(frameLayout(columnIds, UNDATED).minWidth)}px`);
    // Not a constant, which is the point of computing it per render: this
    // plan has Dev unfolded and QA folded, so the floor is the 839px of fixed
    // columns (827 → 839 in `number-column-widen`, 93 → 105 in
    // `COLUMN_WIDTHS`) — nobody has dated a row, so `not-before` is at its
    // narrow 56 — plus 348 for the open role, 96 for the closed one and
    // Name's 200. Folded it would be 1231, and both open 1735 — the
    // difference is what `unfolding-may-scroll` decided to spend the frame's
    // scrollbar on.
    expect(table.style.minWidth).toBe('1483px');
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    expect(screen.getByRole('table').style.minWidth).toBe('1231px');
  });

  itDom('carries a row’s whole number in its cell, however much of it is shown', async () => {
    // The Number column is sized to a stated envelope — eleven characters at
    // the deepest indent — because there is no longest work item number to
    // size it to. A number past that envelope is clipped rather than allowed to
    // widen a column every row in the table would then move with, so the whole
    // of it lives in the cell's `title`. `e2e/layout.spec.ts` is what watches
    // the clipping; jsdom lays nothing out and can only watch the `title`.
    // Proof: the `title` removed from the Number cell's span, this failed on
    // `expected '' to be '020'`. Watched, 2026-08-09.
    await threeRoots();

    expect(rowFor('020').querySelector('[data-number]')?.parentElement?.title).toBe('020');
  });

  itDom('declares exactly the widths the resolved layout holds for this state', async () => {
    // The `<colgroup>` and the table's minimum read one `frameLayout` call per
    // render, so a column that resolves differently cannot reach one of them
    // and miss the other. Asserted against the resolution rather than against
    // literals, because the literals are `table-frame.test.ts`'s job and this
    // one is about the wiring.
    // Proof: the `<colgroup>` left mapping `leafColumnIds` through a
    // `widthFor(id, { hasAnyNotBefore: true })` of its own while the table's
    // `min-width` read the layout, this failed on `expected [ '24px', …(12) ]
    // to deeply equal [ '24px', …(12) ]` with `not-before` at 84px against the
    // layout's 56px. Watched, 2026-08-09.
    await threeRoots();

    const columnIds = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');
    const layout = frameLayout(columnIds, UNDATED);

    expect(
      [...document.querySelectorAll<HTMLElement>('colgroup col')].map((col) => col.style.width),
    ).toEqual(
      layout.columns.map((column) =>
        column.colWidth === undefined ? '' : `${String(column.colWidth)}px`,
      ),
    );
    expect(screen.getByRole('table').style.minWidth).toBe(`${String(layout.minWidth)}px`);
  });

  itDom('changes a width without rebuilding a single cell of the table', async () => {
    // The landmine this whole seam is built around (LLM_README #1): `columns`
    // may depend on `roles` and `unfoldedRoles` and nothing else. `flexRender`
    // renders every `cell` as a component *type*, so a width threaded through
    // a column definition — and the `frameState` dependency that would have to
    // come with it — gives every cell a new type and React unmounts and
    // remounts the lot, taking the focus and the half-typed value with it.
    //
    // Delivered as somebody else's edit, which is the gesture that makes the
    // claim: the width really does change — `not-before` goes 56 → 84 the
    // moment any row in the project sets a day — and the reader whose focus
    // must survive it is not the one who caused it.
    //
    // Proof: `frameState` added to the `columns` dependency array, this failed
    // on `expected <body /> to be <textarea …>` — the focus on the body and the
    // half-typed name gone. Watched, 2026-08-09.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    click('Add work item');
    const name = await screen.findByLabelText('Name of 010');
    const before = screen.getByRole('table').style.minWidth;

    name.focus();
    fireEvent.change(name, { target: { value: 'Strip the old wir' } });

    const dated = api.rows.at(0);
    if (dated === undefined) throw new Error('the plan has no row to date');
    dated.startNoEarlierThan = '2026-08-12';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole('table').style.minWidth).not.toBe(before);
    });
    expect(screen.getByRole('table').style.minWidth).toBe(
      `${String(
        frameLayout(
          screen.getAllByRole('columnheader').map((th) => th.getAttribute('data-column') ?? ''),
          DATED,
        ).minWidth,
      )}px`,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('gives every cell the chrome its declared width is measured with', async () => {
    await threeRoots();

    const cells = [
      ...screen.getAllByRole('columnheader'),
      ...rowFor('020').querySelectorAll<HTMLElement>('td'),
    ];

    expect(cells.length).toBeGreaterThan(12);
    for (const cell of cells) {
      // Or the padding is width the offsets never counted.
      expect(cell.style.boxSizing).toBe('border-box');
      // The backstop: whatever a cell ends up holding, it stops at the cell.
      // The body cells holding a popover are exempt — the test below is where
      // that exception is pinned, and it is restated here so this loop cannot
      // be read as "every cell clips".
      const column = cell.dataset['column'] ?? '';
      const exempt =
        cell.tagName === 'TD' &&
        // `not-before` since `T2 compact-columns`: its date editor is wider
        // than the column and leaves the cell rather than sizing it.
        // `priority` since `priority-bands`: the Prio cell opens the five band
        // lines over a 48px column, which is now the narrowest clip in the table.
        (['depends', 'name', 'team', 'actions', 'not-before', 'priority'].includes(column) ||
          column.endsWith('-assignee') ||
          // A folded role's cell opens the `@` people picker over a 96px
          // column, which is the narrowest clip in the table.
          column.endsWith('-final'));
      expect(cell.style.overflow).toBe(exempt ? 'visible' : 'hidden');
    }
  });

  itDom('lets no control in a cell assert a width of its own', async () => {
    await threeRoots();
    // With an editor open, so the one deliberate exception below is a case this
    // really walks rather than a branch nothing reaches.
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    openNotBefore('010');

    const controls = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'tbody input:not([type=checkbox]), tbody textarea',
      ),
    ];

    // The name, the dependency box, the service/team picker, the folded
    // estimate, the three points, the assignee picker, the date.
    expect(controls.length).toBeGreaterThan(6);
    for (const control of controls) {
      // The one exception, and it is the point of this change rather than a
      // hole in the rule: an open date editor is `DATE_EDITOR_WIDTH` wide in a
      // column of 84px or 56, because that is what a browser lays an
      // unconstrained `input[type=date]` out at and a column that grew to fit
      // one would move every cell under the person typing. It leaves the cell
      // through `opensAPopover`'s exemption instead. Nothing else in the table
      // may ask for a width.
      if (control.getAttribute('type') === 'date') {
        expect(control.style.width).toBe(`${String(DATE_EDITOR_WIDTH)}px`);
        continue;
      }
      // The reason box is the second half of that same editor, not a second
      // exception: absolutely positioned under the date, at the date's width
      // because a box narrower than the day it explains reads as a different
      // control. It is out of the flow, so it moves no cell and grows no
      // column — the thing the rule is actually about. In the flow it would
      // have to be `100%` like everything else.
      if (control.hasAttribute('data-not-before-reason')) {
        expect(control.style.width).toBe(`${String(DATE_EDITOR_WIDTH)}px`);
        expect(control.style.position).toBe('absolute');
        continue;
      }
      // A control that asks for `22em` is a second opinion about how wide its
      // column is, and the one the browser takes when it is the wider of the
      // two.
      expect(['100%', 'auto', '']).toContain(control.style.width);
      // `size` is the same claim in an attribute: an input sized for 14
      // characters is as wide as 14 characters of the page's font.
      expect(control.getAttribute('size')).toBeNull();
    }
  });

  itDom('does not clip the cells whose popovers open over the rows', async () => {
    // The CSS rule, spelled out because the first version of this test
    // asserted its opposite and called the wrong thing a proof: an absolutely
    // positioned box escapes an `overflow: hidden` ancestor only when its
    // containing block — its nearest *positioned* ancestor — is **outside**
    // that clipper. Every popover in this table sits in a `position: relative`
    // wrapper span that is *inside* the `<td>`, so the `<td>` cuts it to the
    // cell rectangle however the wrapper is styled. The invariant is therefore
    // about the cells, not the wrappers: the cells that hold a popover do not
    // clip, and their neighbours do.
    //
    // Proof: the `opensAPopover` exception removed from the `<td>` style in
    // `wbs-table.tsx`, this failed on
    // `expected 'hidden' to be 'visible' // Object.is equality`. Watched,
    // 2026-08-07.
    await threeRoots();
    fireEvent.focus(screen.getByLabelText('Add a dependency to 020'));

    const cellOf = (columnId: string): HTMLElement => {
      const cell = rowFor('020').querySelector<HTMLElement>(`td[data-column="${columnId}"]`);
      // Thrown rather than asserted away: a missing cell would otherwise read
      // as `undefined` overflow and quietly satisfy nothing.
      if (cell === null) throw new Error(`row 020 has no ${columnId} cell`);
      return cell;
    };

    openRowMenu('020');
    const openList = screen.getByRole('listbox');
    const openMenu = screen.getByRole('menu');
    const nameBox = screen.getByLabelText('Name of 020');
    const teamBox = screen.getByLabelText('Service or team for 020');
    // The cells the popovers are really in. Without this the overflow
    // assertions below would go on passing about columns the popovers had
    // moved out of.
    expect(openList.closest('td')).toBe(cellOf('depends'));
    expect(nameBox.closest('td')).toBe(cellOf('name'));
    expect(teamBox.closest('td')).toBe(cellOf('team'));
    expect(openMenu.closest('td')).toBe(cellOf('actions'));

    expect(cellOf('depends').style.overflow).toBe('visible');
    // The Name cell, which holds the notes and the rendered preview that hangs
    // off them — the cell that used to clip is the one the popover moved into.
    // Proof: `'name'` removed from `POPOVER_COLUMNS`, this failed on
    // `expected 'hidden' to be 'visible'`. Watched, 2026-08-08.
    expect(cellOf('name').style.overflow).toBe('visible');
    // The row's actions menu is the same absolutely positioned box in the same
    // kind of wrapper, in a cell 40px wide and one line high — the narrowest
    // clip in the table.
    // Proof: `'actions'` removed from `POPOVER_COLUMNS`, this failed on
    // `expected 'hidden' to be 'visible'`. Watched, 2026-08-08.
    expect(cellOf('actions').style.overflow).toBe('visible');
    // The service/team box and every assignee box are `CreatablePicker`s, and
    // a picker's list is the same absolutely positioned popover in the same
    // kind of wrapper. Their columns are named `<roleId>-assignee` at runtime,
    // so they are found rather than written out.
    expect(cellOf('team').style.overflow).toBe('visible');
    const assigneeCells = [
      ...rowFor('020').querySelectorAll<HTMLElement>('td[data-column$="-assignee"]'),
    ];
    // Or an empty list would satisfy the loop below without a picker column
    // being rendered at all. One here: this plan has two roles and the second
    // is folded, and a folded role shows one estimate box and no assignee.
    expect(assigneeCells.length).toBeGreaterThan(0);
    for (const cell of assigneeCells) expect(cell.style.overflow).toBe('visible');

    // A folded role's cell: `@` opens the people picker there, over a column
    // 96px wide. `final-total` is not one of these — it ends in `total`, and
    // it still clips, which is what says the suffix match is a match and not a
    // blanket.
    // Proof: the `-final` suffix dropped from `opensAPopover`, this and
    // `gives every cell the chrome its declared width is measured with` both
    // failed on `expected 'hidden' to be 'visible'`. Watched, 2026-08-08.
    expect(cellOf('role-qa-final').style.overflow).toBe('visible');
    expect(cellOf('final-total').style.overflow).toBe('hidden');

    // Still an exception. If the backstop had simply been dropped everywhere,
    // every assertion above would pass and this one would not.
    expect(cellOf('float').style.overflow).toBe('hidden');

    // And the wrappers are still the positioned ancestors — which is what
    // decides *where* each popover opens. `top: 100%` against a static wrapper
    // would be measured from whatever ancestor is positioned instead.
    for (const wrapper of [openList.parentElement, nameBox.parentElement]) {
      expect(wrapper?.tagName).toBe('SPAN');
      expect(wrapper?.style.position).toBe('relative');
    }
  });
});

describe('the outline past the Number cap', () => {
  /**
   * The next number a new sibling of `number` gets: its last segment stepped
   * by one. What {@link pressNewItem} makes on a nested row, spelled once.
   */
  const siblingOf = (number: string): string =>
    number.replace(/(\d+)$/, (last) => String(Number(last) + 1));

  /**
   * jsdom lays nothing out, so what is watched here is the arithmetic arriving
   * on the two elements that share it: the Number cell keeps
   * `numberIndentFor`'s capped padding, and the Name cell's wrapper carries
   * exactly the share the cap withheld — zero until the cap, one step per
   * level past it. The browser measurement that the two **add up** to a strictly
   * deeper outline at every level is `e2e/layout.spec.ts`'s deep-plan fixture.
   */
  itDom('hands the Name cell the share of the indent the Number cap withheld', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await screen.findByLabelText('Name of 020');
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');

    // One level per round: a sibling of the deepest row, Tab'd under it. Six
    // levels, two past `DEEPEST_INDENT` — the two the cap used to flatten.
    let deepest = '010.1';
    while (deepest.split('.').length < 7) {
      pressNewItem(deepest);
      const sibling = siblingOf(deepest);
      await screen.findByLabelText(`Name of ${sibling}`);
      pressTab(sibling);
      deepest = `${deepest}.1`;
      await screen.findByLabelText(`Name of ${deepest}`);
    }

    const indents = (number: string): { number: string; name: string } => {
      const numberSpan = document.querySelector<HTMLElement>(`span[title="${number}"]`);
      const nameWrapper = screen.getByLabelText(`Name of ${number}`).closest('span');
      if (numberSpan === null || nameWrapper === null) {
        throw new Error(`no indent-carrying cells on screen for ${number}`);
      }
      return { number: numberSpan.style.paddingLeft, name: nameWrapper.style.paddingLeft };
    };

    /** `010` with `depth` levels of `.1` under it — the row built above. */
    const at = (depth: number): string => ['010', ...Array<string>(depth).fill('1')].join('.');

    // Below the cap the Number cell does all the indenting and the Name cell
    // none of it — the rendered table is unchanged there.
    //
    // Read off {@link DEEPEST_INDENT} rather than off the four pixel literals
    // this held until `table-mechanics`: they were the arithmetic of a cap of
    // 4, so moving the cap to 2 to unclip the number would have been a test
    // edit either way. Written against the cap, the relation is what is pinned
    // and the next move of the cap is free.
    const capped = `${String(DEEPEST_INDENT * 12)}px`;
    expect(indents(at(1))).toEqual({ number: '12px', name: '0px' });
    expect(indents(at(DEEPEST_INDENT))).toEqual({ number: capped, name: '0px' });
    // Past the cap the Number cell stays put and the Name cell steps: the sum
    // grows by one step at every level, which is the whole of `deep-indent`.
    for (const past of [1, 2, 3, 4]) {
      expect(indents(at(DEEPEST_INDENT + past))).toEqual({
        number: capped,
        name: `${String(12 * past)}px`,
      });
    }
  });
});

describe('the widths this browser has dragged', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.columnWidths.p1';

  /** What the `<colgroup>` declares, by the column each `<col>` belongs to. */
  const laidOut = (): Record<string, string> => {
    const ids = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');
    const cols = [...document.querySelectorAll<HTMLElement>('colgroup col')];
    return Object.fromEntries(ids.map((id, at) => [id, cols[at]?.style.width ?? '(no col)']));
  };

  /** A remembered set of widths, as a hand-edited store would hold it. */
  const storedWidths = (widths: unknown): void => {
    localStorage.setItem(KEY, typeof widths === 'string' ? widths : JSON.stringify(widths));
  };

  /** What is under the key now, which is what a reload would read. */
  const stored = (): string | null => localStorage.getItem(KEY);

  /**
   * One row on p1, and a way to hand the table somebody else's edit.
   *
   * The peer's edit is how the `not-before` column's resolved default is made
   * to move — 56px to 84px the moment any row in the project sets a day — which
   * is the only way to ask whether an override outranks a default that changes.
   */
  async function planWithAPeer() {
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return {
      api,
      dateTheRow: async () => {
        const row = api.rows.at(0);
        if (row === undefined) throw new Error('the plan has no row to date');
        row.startNoEarlierThan = '2026-08-12';
        await act(async () => {
          notify();
          await Promise.resolve();
        });
      },
    };
  }

  itDom('offers a handle on every column, the Name column included', async () => {
    // Until `name-column-drag` this case held the opposite: the Name column
    // was the remainder-absorber and a handle on it was a gesture with
    // nothing to write. A dragged Name writes an override now — the delta
    // spec strikes the old requirement by name — so the handle set is every
    // leaf column, and Name's gesture is the one that starts from a measured
    // width rather than a resolved one.
    await threeRoots();

    const ids = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');
    const handles = [...document.querySelectorAll('thead [data-resize-handle]')].map((handle) =>
      handle.getAttribute('data-resize-handle'),
    );

    expect(handles).toEqual(ids);
    expect(handles).toContain('name');
  });

  itDom('says a mark heading’s word on the handle beside it', async () => {
    // The handle's accessible name is the heading it was rendered with, and
    // this change turned `header: 'Number'` into a node drawing `#`. A node is
    // not a string, so the handle fell through to the column id and the one
    // control that reads a heading said `Resize number` where it had said
    // `Resize Number` — the exact loss `ColumnMeta.spokenHeading` exists to
    // prevent, one call away from the `<th>` that was already told.
    await threeRoots();

    const spoken = new Map(
      [...document.querySelectorAll('thead [data-resize-handle]')].map((handle) => [
        handle.getAttribute('data-resize-handle'),
        handle.getAttribute('aria-label'),
      ]),
    );

    expect(spoken.get('number')).toBe('Resize Number');
    // The columns whose heading is already a word are unmoved by the fallback.
    expect(spoken.get('name')).toBe('Resize Name');
  });

  itDom('works a dragged width out from where the handle was grabbed', () => {
    // The gesture itself is `e2e/layout.spec.ts`'s: jsdom performs no default
    // action for a pointer event and cannot tell a working drag from a
    // half-done one. What it can hold is the arithmetic the gesture writes
    // through — the floor is the column's own where that is narrower, and the
    // ceiling is the one the stored-width check reads.
    expect(widthFromDrag('number', 93, 40, UNDATED)).toBe(133);
    expect(widthFromDrag('number', 93, -1000, UNDATED)).toBe(36);
    expect(widthFromDrag('drag', 24, -50, UNDATED)).toBe(24);
    expect(widthFromDrag('number', 93, 10_000, UNDATED)).toBe(600);
    // The Name column clamps to its own bounds: the flexible floor — the same
    // 200 the cell's `min-width` declares — up to the one shared ceiling. Its
    // `fromWidth` is the one measured number in the gesture, taken from the
    // header cell at pointerdown; jsdom measures every box at 0, so the
    // gesture itself is `e2e/layout.spec.ts`'s.
    expect(widthFromDrag('name', 200, 60, UNDATED)).toBe(260);
    expect(widthFromDrag('name', 300, -1000, UNDATED)).toBe(200);
    expect(widthFromDrag('name', 300, 10_000, UNDATED)).toBe(600);
  });

  itDom(
    'lays a remembered Name width on the table itself, and leaves its <col> silent',
    async () => {
      // The excess-width design, asserted where jsdom can see it: with a Name
      // override in force the table declares its own width as the resolved sum
      // — every column at exactly its resolved width, Name at the override,
      // the viewport keeping the slack — while the `<col>` stays unsized and
      // the Name cells carry the override only as their `min-width` floor. A
      // cell `width` against a `width: 100%` table was the design tried first,
      // and Chromium answered it by distributing the viewport's excess across
      // every sized column: Number measured 103.48 against its 93px envelope
      // (CI `pixels` run 31430669282, 2026-08-10). The distribution is a
      // browser's to prove either way: `e2e/layout.spec.ts` measures Number
      // still on its envelope with a Name override in force.
      storedWidths({ name: 300 });
      await threeRoots();

      const header = document.querySelector<HTMLElement>('thead th[data-column="name"]');
      const body = document.querySelector<HTMLElement>('tbody td[data-column="name"]');
      expect(header?.style.width).toBe('');
      expect(header?.style.minWidth).toBe('300px');
      expect(body?.style.width).toBe('');
      expect(body?.style.minWidth).toBe('300px');
      expect(laidOut().name).toBe('');
      // The table's own width is the declaration: the resolved sum — the 1483
      // this plan resolves at rest (1471 → 1483 in `number-column-widen`, 93
      // → 105 in `COLUMN_WIDTHS`), less the 200 floor, plus the 300 override
      // — as its width and its minimum alike, so the frame keeps the slack
      // above it and scrolls below it.
      expect(screen.getByRole('table').style.width).toBe('1583px');
      expect(screen.getByRole('table').style.minWidth).toBe('1583px');
    },
  );

  itDom('lays the Name cap on the table itself, with nothing dragged', async () => {
    // The at-rest half of the same declaration, and the whole of how
    // `FLEXIBLE_CAP` reaches a browser: the table takes the frame until the
    // Name column would pass the cap and stops there, leaving the slack to the
    // right of the last column instead of inside the Name cells.
    //
    // `min(100%, …)` and not a `max-width` beside a `width`, so there is one
    // declaration to read; and on the table rather than on the cells, because
    // `table-layout: fixed` gives a cell no vote on its column's width.
    //
    // Proof: the `min()` in `tableWidthStyle` reverted to a flat `'100%'`,
    // this failed on `expected '100%' to be 'min(100%, 1691px)'`. Watched on
    // h2puni, 2026-08-12 (fault F2).
    await threeRoots();

    const table = screen.getByRole('table');
    const resolved = Number.parseInt(table.style.minWidth, 10);

    expect(resolved).toBeGreaterThan(0);
    // The minimum budgets Name's floor and the cap swaps in the other end of
    // the same range, so the difference between the two is exactly what the
    // Name column is allowed to grow by and nothing else.
    expect(table.style.width).toBe(
      `min(100%, ${String(resolved - FLEXIBLE_FLOOR + FLEXIBLE_CAP)}px)`,
    );
    // And the Name cells still declare a floor and no width: the cap is the
    // table's, or it is a second width authority.
    expect(document.querySelector<HTMLElement>('thead th[data-column="name"]')?.style.width).toBe(
      '',
    );
    expect(laidOut().name).toBe('');
  });

  itDom('drops a stored Name width outside Name’s own bounds, each end on its own', async () => {
    // The same claim rules as every other column, read against Name's own
    // range: the flexible floor up to the shared ceiling. A width below 200
    // is one no Name drag can produce — the clamp stops there — so a stored
    // one is a hand-edit, refused exactly as Number's 1e9 is.
    storedWidths({ name: 150, number: 240 });
    await threeRoots();

    const header = document.querySelector<HTMLElement>('thead th[data-column="name"]');
    expect(header?.style.width).toBe('');
    expect(header?.style.minWidth).toBe('200px');
    // The entry beside it still applies: one bad entry takes only itself.
    expect(laidOut().number).toBe('240px');

    cleanup();
    localStorage.clear();
    storedWidths({ name: 1e9 });
    await threeRoots();

    const above = document.querySelector<HTMLElement>('thead th[data-column="name"]');
    expect(above?.style.width).toBe('');
    expect(above?.style.minWidth).toBe('200px');
  });

  itDom('one reset gives Name back to the remainder with the rest', async () => {
    // Reset stays `forgetWidthOverrides`: one key forgotten, never a snapshot
    // written, and Name goes back to being the column with no width at all —
    // the table back to the frame's own 100%.
    storedWidths({ name: 300, number: 140 });
    await threeRoots();
    expect(
      document.querySelector<HTMLElement>('thead th[data-column="name"]')?.style.minWidth,
    ).toBe('300px');
    expect(screen.getByRole('table').style.width).not.toBe('100%');

    click('Reset layout');

    const header = document.querySelector<HTMLElement>('thead th[data-column="name"]');
    expect(header?.style.width).toBe('');
    expect(header?.style.minWidth).toBe('200px');
    expect(laidOut().number).toBe('105px');
    expect(screen.getByRole('table').style.width).toMatch(/^min\(100%, \d+px\)$/);
    expect(stored()).toBe(null);
  });

  itDom('lays a remembered width out over the one it would have resolved', async () => {
    storedWidths({ number: 240 });
    await threeRoots();

    expect(laidOut().number).toBe('240px');
    // And the pinned column behind it moved with it, which is the whole of why
    // the override lives in the frame layout rather than in the `<colgroup>`.
    expect([...rowFor('020').querySelectorAll('td')][2]?.style.left).toBe(`${String(24 + 240)}px`);
    // Read, not written back: nothing about opening a project changes what is
    // remembered about it.
    expect(stored()).toBe(JSON.stringify({ number: 240 }));
  });

  itDom('applies a width dragged as far right as it goes, on the reload after it', async () => {
    // The two ends of one constant. A drag clamps to `WIDEST_COLUMN` and the
    // stored-width check accepts up to `WIDEST_COLUMN`, so the width a reader
    // stops at is the width that comes back — this seeds exactly what the
    // clamp can produce rather than a number typed here.
    // Proof: the stored-width check given a ceiling of its own at 500, this
    // failed on `expected '93px' to be '600px'` — the width the drag had just
    // produced refused by the reload. Watched, 2026-08-09.
    storedWidths({ number: widthFromDrag('number', 93, 10_000, UNDATED) });
    await threeRoots();

    expect(laidOut().number).toBe('600px');
  });

  itDom('drops storage that is not a set of column widths, key and all', async () => {
    // localStorage is user-editable, so what comes back is a claim. A table
    // that cannot be opened until somebody clears storage by hand is a worse
    // answer than a table at its defaults, which is the posture the remembered
    // expansion beside it takes.
    // Proof: the `isWidthOverrides` guard deleted, this failed on `TypeError:
    // Cannot convert undefined or null to object`, thrown out of the render
    // that mounts the table — the text that is not JSON reaching
    // `Object.entries` as `undefined`. Watched, 2026-08-09.
    for (const junk of ['not json at all', '[93, 240]', '{"number":"wide"}', '"a string"']) {
      cleanup();
      localStorage.clear();
      storedWidths(junk);
      await threeRoots();

      expect(laidOut().number).toBe('105px');
      expect(stored()).toBe(null);
    }
  });

  itDom(
    'drops an entry naming a column nothing can size, and keeps the one beside it',
    async () => {
      // Proof: the `sizableColumn` check deleted, this failed on
      // `UnknownColumnError: No declared width for column "serviec"` thrown out
      // of the render — the width table asked for a floor for a column that does
      // not exist. Watched, 2026-08-09.
      storedWidths({ number: 240, serviec: 80 });
      await threeRoots();

      expect(laidOut().number).toBe('240px');
      expect(Object.keys(laidOut())).not.toContain('serviec');
    },
  );

  itDom('drops a width that is not a finite number, and keeps the one beside it', async () => {
    // `1e999` is JSON a browser parses to `Infinity`, which is the only
    // non-finite width storage can hold — JSON has no `NaN` — and it reaches
    // the `<colgroup>` as a `<col>` with no usable width at all and the table's
    // `min-width` as `NaN`.
    //
    // The **range** check is what refuses it, and this is the second test
    // watching that one line rather than a `Number.isFinite` of its own. That
    // line was written first and its negative watched *passing* with the line
    // deleted — `Infinity` is above every ceiling, exactly as `-Infinity` is
    // below every floor — so the line was removed rather than believed. R5;
    // `wbs-table.tsx`'s `rememberedWidthOverrides` has the note.
    //
    // Proof: the range check deleted, this failed on `expected '' to be '56px'`
    // — the `<col>` left with no width the browser would take, and the table's
    // own `min-width` reading `NaNpx` beside it. Watched, 2026-08-09.
    // Written as the text a hand-edited store holds, not as an object: an
    // `Infinity` put through `JSON.stringify` comes out as `null`, and this has
    // to be the case that survives the whole-key check and is refused per
    // entry.
    storedWidths('{"number":240,"not-before":1e999}');
    await threeRoots();

    expect(laidOut().number).toBe('240px');
    expect(laidOut()['not-before']).toBe('56px');
    expect(screen.getByRole('table').style.minWidth).not.toContain('NaN');
  });

  itDom(
    'drops a width outside the range a drag can produce, and keeps the one beside it',
    async () => {
      // Both ends, because a range check is two comparisons and a test that only
      // ever hands it a huge number cannot see the floor go.
      // Proof: the range check deleted, this failed on `expected '1000000000px'
      // to be '93px'` — a column a billion pixels wide laid out from a
      // hand-edited store. Watched, 2026-08-09.
      storedWidths({ number: 1e9, depends: 4, team: 240 });
      await threeRoots();

      expect(laidOut().number).toBe('105px');
      expect(laidOut().depends).toBe('110px');
      expect(laidOut().team).toBe('240px');
    },
  );

  itDom('leaves a phase this project no longer holds alone', async () => {
    // Never looked at rather than dropped: expansion's deleted row ids are
    // harmless for the same reason, and a width for a column nothing renders
    // costs nothing to keep. The role coming back would find its width waiting.
    storedWidths({ 'role-gone-final': 140, number: 240 });
    await threeRoots();

    expect(laidOut().number).toBe('240px');
    expect(stored()).toContain('role-gone-final');
  });

  itDom('freezes a width that would otherwise move with the plan', async () => {
    // The `not-before` column is 56px until any row in the project sets a day
    // and 84px afterwards. A reader who has said how wide they want it has said
    // so about both states.
    // Proof: the precedence reversed in `widthFor`, so a plan width outranks
    // the override, this failed on `expected '56px' to be '110px'` — the
    // remembered width never reaching the column at all, and the two-state
    // default deciding it in both directions. Watched, 2026-08-09.
    storedWidths({ 'not-before': 110 });
    const { dateTheRow } = await planWithAPeer();
    expect(laidOut()['not-before']).toBe('110px');

    await dateTheRow();

    expect(laidOut()['not-before']).toBe('110px');
    // And the default really would have moved, which is what makes the
    // assertion above a freeze rather than a coincidence.
    expect(frameLayout(['not-before'], DATED).minWidth).not.toBe(
      frameLayout(['not-before'], UNDATED).minWidth,
    );
  });

  itDom(
    'resets to the width resolved now, not to the one that held when it was dragged',
    async () => {
      // The whole of what a width reset is: the key is forgotten, not overwritten
      // with a snapshot. The column's default has changed under the override
      // while it was in force, and the reset has to land on the new one.
      // Proof: the reset re-written to store the widths resolved at the moment it
      // was pressed, this failed on `expected '110px' to be '84px'` — the
      // override renamed a default rather than forgotten. Watched, 2026-08-09.
      storedWidths({ 'not-before': 110 });
      const { dateTheRow } = await planWithAPeer();
      await dateTheRow();
      expect(laidOut()['not-before']).toBe('110px');

      click('Reset layout');

      expect(laidOut()['not-before']).toBe('84px');
      expect(stored()).toBe(null);
    },
  );

  itDom('offers the reset only while there is a width to reset', async () => {
    // A control that provably does nothing reads as a broken one.
    // Proof: the `size > 0` condition removed, this failed on `expected
    // <button …(3)></button> to be null` on a project nobody had dragged a
    // column in. Watched, 2026-08-09.
    await threeRoots();
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBe(null);

    cleanup();
    localStorage.clear();
    storedWidths({ number: 240 });
    await threeRoots();
    expect(screen.getByRole('button', { name: 'Reset layout' })).toBeInTheDocument();

    click('Reset layout');
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBe(null);
  });

  itDom('changes a width without rebuilding a single cell of the table', async () => {
    // Landmine #1 again, from the other side. `columns` may depend on `roles`
    // and `unfoldedRoles` and nothing else, so the overrides live beside
    // `expanded` and never enter a column definition: `flexRender` renders each
    // `cell` as a component *type*, and a definition that changed with a width
    // would unmount and remount every cell in the table, taking the focus and
    // the half-typed value with it.
    //
    // Proof: the width overrides added to the `columns` dependency array, this
    // failed on `expected <body><div>…(1)</div></body> to be <textarea
    // …(5)></textarea>` — the caret dropped on the body by the remount, and the
    // half-typed name gone with it. Watched, 2026-08-09.
    storedWidths({ number: 240 });
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText('Name of 010');
    name.focus();
    fireEvent.change(name, { target: { value: 'Strip the old wir' } });

    click('Reset layout');

    expect(laidOut().number).toBe('105px');
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('reads the next project’s widths rather than stamping this one’s on it', async () => {
    // This component is not remounted between projects (`project-page.tsx`
    // renders it without a `key`), so the state and the key it is written under
    // have to be swapped together — exactly as the remembered expansion beside
    // it is.
    storedWidths({ number: 240 });
    localStorage.setItem('wbs.columnWidths.p2', JSON.stringify({ number: 300 }));
    const api = fakeApi();
    const { rerender } = render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    expect(laidOut().number).toBe('240px');

    rerender(<WbsTable projectId="p2" api={api} />);

    await waitFor(() => {
      expect(laidOut().number).toBe('300px');
    });
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ number: 240 }));
  });
});

describe('the day scale this browser picked for this project', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.ganttDayPx.p1';

  const openTheChart = async (): Promise<HTMLSelectElement> => {
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const control = document.querySelector<HTMLSelectElement>('[data-gantt-day-scale]');
    if (control === null) throw new Error('no day-scale control rendered');
    return control;
  };

  itDom('opens the chart at the remembered rung, and the axis with it', async () => {
    localStorage.setItem(KEY, '4');
    const control = await openTheChart();
    expect(control.value).toBe('4');
    // The stored rung reaches the drawing and not merely the control: a scale
    // the select agrees with while the chart stays at 28 is the whole feature
    // failing quietly.
    const cell = document.querySelector<HTMLElement>('[data-axis-day="0"]');
    expect(cell?.style.width).toBe('4px');
  });

  itDom('opening a project does not change what is remembered about it', async () => {
    localStorage.setItem(KEY, '12');
    await openTheChart();
    expect(localStorage.getItem(KEY)).toBe('12');
  });

  itDom('writes the rung that was picked', async () => {
    const control = await openTheChart();
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.change(control, { target: { value: '12' } });
    expect(localStorage.getItem(KEY)).toBe('12');
    expect(document.querySelector<HTMLElement>('[data-axis-day="0"]')?.style.width).toBe('12px');
  });

  itDom('refuses a width that is not one of the rungs, and drops the key', async () => {
    // Discrete and not a range, which is where this parts from the height
    // beside it: 9 is between two rungs and inside every plausible bound, and a
    // chart opened at it is one no control can return to a rung.
    localStorage.setItem(KEY, '9');
    const control = await openTheChart();
    expect(control.value).toBe(String(DAY_PX));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('refuses storage that is not a number at all, and drops the key', async () => {
    localStorage.setItem(KEY, 'wide please');
    const control = await openTheChart();
    expect(control.value).toBe(String(DAY_PX));
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('the row names this browser left shown for this project', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.ganttLabels.p1';

  const openTheChart = async (): Promise<HTMLButtonElement> => {
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const control = document.querySelector<HTMLButtonElement>('[data-gantt-labels-toggle]');
    if (control === null) throw new Error('no names control rendered');
    return control;
  };

  itDom('opens the chart with the column collapsed where it was left that way', async () => {
    localStorage.setItem(KEY, 'false');
    const control = await openTheChart();
    expect(control.getAttribute('aria-pressed')).toBe('false');
    // The stored answer reaches the drawing and not merely the control, for the
    // rung's reason one describe up.
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(0);
  });

  itDom('opening a project does not change what is remembered about it', async () => {
    localStorage.setItem(KEY, 'false');
    await openTheChart();
    expect(localStorage.getItem(KEY)).toBe('false');
  });

  itDom('writes the answer that was picked, and it is the false one', async () => {
    // `false` is the interesting write and the reason the read is a `typeof`
    // test rather than a `??`: the collapsed state is the one somebody bothers
    // to ask for, and a nullish default would eat it on every reopen.
    const control = await openTheChart();
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.click(control);
    expect(localStorage.getItem(KEY)).toBe('false');
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(0);
  });

  itDom('refuses storage that is not a boolean, and drops the key', async () => {
    localStorage.setItem(KEY, '"no thanks"');
    const control = await openTheChart();
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('a collapsed column alone offers the reset, and the reset brings it back', async () => {
    // The fourth clause of the reset's condition, measured the way the height
    // half was: with nothing else touched, so the offer can only be coming from
    // this. A reset that forgot three of four would leave the chart looking
    // reset while the names stayed gone.
    const control = await openTheChart();
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();

    fireEvent.click(control);
    const reset = screen.getByRole('button', { name: 'Reset layout' });
    fireEvent.click(reset);

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(1);
  });
});

describe('the chart height this browser has dragged', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.ganttHeight.p1';

  const openTheChart = async (): Promise<HTMLElement> => {
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const panel = document.querySelector('[data-gantt-panel]');
    if (!(panel instanceof HTMLElement)) throw new Error('no gantt panel rendered');
    return panel;
  };

  itDom('opens the chart at the remembered height', async () => {
    localStorage.setItem(KEY, '500');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('500px');
  });

  itDom('opening a project does not change what is remembered about it', async () => {
    // The write happens when a drag is let go of and at no other time; a
    // sanitize-and-write-back on read would quietly rewrite a preference the
    // reader never touched.
    localStorage.setItem(KEY, '500');
    await openTheChart();
    expect(localStorage.getItem(KEY)).toBe('500');
  });

  itDom('refuses storage that is not a number, and drops the key', async () => {
    // localStorage is user-editable, so what comes back is a claim.
    localStorage.setItem(KEY, 'not a number at all');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('');
    expect(panel.classList.contains('max-h-[40vh]')).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('refuses a height below the floor, and drops the key', async () => {
    localStorage.setItem(KEY, '10');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('refuses a height above the ceiling, and drops the key', async () => {
    // `1e999` parses to Infinity, which is above the ceiling exactly as any
    // huge finite number is — the range check is the only line either needs
    // (T1's finiteness lesson).
    localStorage.setItem(KEY, '99999');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  /**
   * jsdom has no pointer capture, so the call the real gesture depends on is
   * filled in before the drag is driven. What these tests can see is the
   * wiring — the height following the pointer, the commit, the fallback; the
   * browser's own half (capture, hit-testing, a real from-height) is
   * `e2e/gantt.spec.ts`'s.
   */
  const grabbable = (): HTMLElement => {
    const handle = screen.getByRole('separator', { name: 'Resize the Gantt chart' });
    handle.setPointerCapture = () => undefined;
    return handle;
  };

  // A hand-built event, because jsdom's PointerEvent takes neither the
  // `pointerId` nor the `clientY` an init dictionary hands it — the axis
  // hover's `axisPointer` (gantt-panel.test.tsx) is the same shape for the
  // same reason.
  const heightPointer = (
    name: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    pointerId: number,
    clientY: number,
  ): Event => {
    const grab = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(grab, 'pointerId', { value: pointerId });
    Object.defineProperty(grab, 'clientY', { value: clientY });
    return grab;
  };

  itDom('follows the pointer while dragged, and remembers where it was let go', async () => {
    localStorage.setItem(KEY, '400');
    const panel = await openTheChart();
    const handle = grabbable();

    fireEvent(handle, heightPointer('pointerdown', 7, 600));
    fireEvent(handle, heightPointer('pointermove', 7, 550));

    // Up 50px is 50px taller, and nothing is written while the drag is in
    // flight — the write is the release's alone.
    expect(panel.style.height).toBe('450px');
    expect(localStorage.getItem(KEY)).toBe('400');

    fireEvent(handle, heightPointer('pointerup', 7, 500));

    expect(panel.style.height).toBe('500px');
    expect(localStorage.getItem(KEY)).toBe('500');
  });

  itDom('a cancelled gesture falls back to the height last let go at', async () => {
    localStorage.setItem(KEY, '400');
    const panel = await openTheChart();
    const handle = grabbable();

    fireEvent(handle, heightPointer('pointerdown', 7, 600));
    fireEvent(handle, heightPointer('pointermove', 7, 500));
    expect(panel.style.height).toBe('500px');

    fireEvent(handle, heightPointer('pointercancel', 7, 500));

    expect(panel.style.height).toBe('400px');
    expect(localStorage.getItem(KEY)).toBe('400');
  });

  itDom('another pointer’s move is not this drag', async () => {
    localStorage.setItem(KEY, '400');
    const panel = await openTheChart();
    const handle = grabbable();

    fireEvent(handle, heightPointer('pointerdown', 7, 600));
    fireEvent(handle, heightPointer('pointermove', 8, 100));

    expect(panel.style.height).toBe('400px');
  });

  itDom(
    'a height override alone offers the reset, and pressing it forgets the height',
    async () => {
      localStorage.setItem(KEY, '500');
      const panel = await openTheChart();
      expect(panel.style.height).toBe('500px');

      click('Reset layout');

      expect(panel.style.height).toBe('');
      expect(panel.classList.contains('max-h-[40vh]')).toBe(true);
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    },
  );

  itDom('one reset forgets the widths and the height together', async () => {
    localStorage.setItem(KEY, '500');
    localStorage.setItem('wbs.columnWidths.p1', JSON.stringify({ number: 240 }));
    await openTheChart();

    click('Reset layout');

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem('wbs.columnWidths.p1')).toBeNull();
  });

  itDom('the reset sits in the toolbar row, not on a line of its own', async () => {
    // The control joins the toolbar's own flex row — never `toolbarControls`,
    // the array the Plan actions sheet renders (plan-cards.test.tsx holds that
    // side) — and the line of its own between toolbar and table is gone.
    localStorage.setItem(KEY, '500');
    await openTheChart();

    const reset = screen.getByRole('button', { name: 'Reset layout' });
    expect(reset.parentElement?.hasAttribute('data-toolbar')).toBe(true);
    expect(document.querySelector('[data-width-controls]')).toBeNull();
  });
});

describe('adding several dependencies at once', () => {
  const typeDeps = (rowNumber: string, value: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  itDom('adds every number in one comma-separated list', async () => {
    // A row that waits for three things is ordinary. Typing it three times was
    // not. Asked for on 2026-08-06.
    const api = await threeRoots();
    const added: [string, string][] = [];
    const real = api.addDependency.bind(api);
    api.addDependency = (id: string, predecessorId: string) => {
      added.push([id, predecessorId]);
      return real(id, predecessorId);
    };

    typeDeps('030', '010, 020');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
    expect(added).toHaveLength(2);
  });

  itDom('takes spaces as readily as commas', async () => {
    await threeRoots();

    typeDeps('030', '010 020');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
  });

  itDom('keeps the good numbers when one in the list is a typo', async () => {
    // Discarding a correct entry because of the one beside it is how a field
    // stops being used.
    await threeRoots();

    typeDeps('030', '010, 999');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByRole('alert').textContent).toContain('No work item numbered 999');
  });

  itDom('names every dependency the server refused, and keeps the rest', async () => {
    const api = await threeRoots();
    const real = api.addDependency.bind(api);
    api.addDependency = (id: string, predecessorId: string) => {
      const number = api.rows.find((r) => r.id === predecessorId)?.number;
      if (number === '020') return Promise.reject(new Error('cycle'));
      return real(id, predecessorId);
    };

    typeDeps('030', '010, 020');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByRole('alert').textContent).toContain('020 (cycle)');
    expect(screen.queryByLabelText('Stop 030 waiting for 020')).toBeNull();
  });

  itDom('still takes a single number, which is most of the typing', async () => {
    await threeRoots();

    typeDeps('030', '010');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('what the plan is still missing', () => {
  /** The readiness badge, or null when the plan is complete and it is gone. */
  const badge = () => screen.queryByRole('button', { name: /unestimated/ });

  /** The badge, thrown for rather than defaulted: a null here means test setup. */
  const theBadge = (): HTMLElement => {
    const found = badge();
    if (found === null) throw new Error('no readiness badge on screen');
    return found;
  };

  /** Rows with nothing typed into them yet, roles left folded — where a person starts. */
  async function rows(count: number) {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    for (const number of ['010', '020', '030'].slice(0, count)) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    return api;
  }

  /** Estimates one row and role through the folded cell, and waits for it to land. */
  const estimate = async (number: string, role: 'Dev' | 'QA') => {
    const cell = screen.getByLabelText<HTMLInputElement>(`${role} estimate for ${number}`);
    fireEvent.change(cell, { target: { value: '5' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(`${role} estimate for ${number}`).value).toBe(
        '5',
      );
    });
  };

  itDom('counts the leaves that are short, not the roles they are short of', async () => {
    // Two work items to go and fix, three role-sized holes between them. The
    // badge is a number of rows a reader can walk; adding the per-role counts
    // would print a bigger number than there are rows to visit.
    await rows(3);
    await estimate('010', 'Dev');
    await estimate('010', 'QA');
    await estimate('020', 'Dev');

    expect(theBadge().textContent).toBe('2 unestimated');
    expect(theBadge().getAttribute('title')).toBe('1 missing Dev, 2 missing QA');
    // A native button, so Enter and Space activate it without this table
    // binding a key. jsdom does not perform that activation, so it is the
    // element itself that is asserted here.
    expect(theBadge().tagName).toBe('BUTTON');
  });

  itDom('says nothing at all about a plan that is complete', async () => {
    // A complete plan needs no badge. A permanent green tick is a thing to
    // stop seeing, and this one has to be noticed the day it appears.
    await rows(1);
    expect(badge()).not.toBeNull();

    await estimate('010', 'Dev');
    await estimate('010', 'QA');

    expect(badge()).toBeNull();
  });

  itDom('says nothing about a project with no work items in it', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add work item' })).toBeDefined();
    });

    expect(badge()).toBeNull();
  });

  itDom('lands the focus in the cell of the first role that leaf is missing', async () => {
    // Per role, not per row: 010 has a Dev estimate and no QA one, so the cell
    // to be standing in is QA's. Sending the focus to Dev would be the tool
    // pointing at the one number that is already there.
    await rows(2);
    await estimate('010', 'Dev');

    fireEvent.click(theBadge());

    expect(document.activeElement).toBe(screen.getByLabelText('QA estimate for 010'));
  });

  itDom('moves on to the next leaf on the next click, and wraps at the end', async () => {
    await rows(2);

    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));

    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 020'));

    // Wraps rather than stopping: the badge is a walk through what is left,
    // and a button that stops working at the end reads as broken.
    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));
  });

  itDom('starts again from the top when the leaf it was on has been estimated', async () => {
    await rows(3);
    fireEvent.click(theBadge());
    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 020'));

    await estimate('020', 'Dev');
    await estimate('020', 'QA');

    // The row the cycle was standing on is no longer in the list. Rather than
    // guess where it used to be, the walk starts over.
    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));
  });

  itDom('opens a collapsed branch rather than focusing a cell nobody can see', async () => {
    const api = await rows(2);
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    // The parent is a roll-up of the child, so the child is the only gap.
    expect(theBadge().textContent).toBe('1 unestimated');
    expect(api.rows).toHaveLength(2);

    fireEvent.click(theBadge());

    expect(numbersOnScreen()).toEqual(['010', '010.1']);
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010.1'));
  });

  itDom('lands in the first box while the role is unfolded, where the trio is typed', async () => {
    // Unfolded, the folded cell is the read-only figure again and the three
    // boxes are the editor — so that is where the walk has to put the caret.
    await rows(1);
    unfoldRole('Dev');

    fireEvent.click(theBadge());

    expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 010'));
  });
});

describe('finding a work item in the tree', () => {
  /**
   * A plan with a match three levels down and a branch with nothing in it.
   *
   * ```
   * 010     Strip the walls
   *  010.1   Sockets
   *   010.1.1 Back boxes
   *  010.2   Skirting
   * 020     Paint
   *  020.1   Undercoat
   * ```
   */
  async function decorating(): Promise<ProjectApi & { rows: WorkItemView[] }> {
    const api = fakeApi();
    const strip = await api.create('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    const sockets = await api.create('p1', {
      parentId: strip.id,
      afterId: null,
      name: 'Sockets',
    });
    await api.create('p1', { parentId: sockets.id, afterId: null, name: 'Back boxes' });
    await api.create('p1', { parentId: strip.id, afterId: sockets.id, name: 'Skirting' });
    const paint = await api.create('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    await api.create('p1', { parentId: paint.id, afterId: null, name: 'Undercoat' });
    return api;
  }

  const EVERY_ROW = ['010', '010.1', '010.1.1', '010.2', '020', '020.1'];

  /** Renders the plan above and waits for it to be on screen. */
  async function shownPlan(): Promise<ProjectApi & { rows: WorkItemView[] }> {
    const api = await decorating();
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(EVERY_ROW);
    });
    return api;
  }

  const findBox = () => screen.getByLabelText<HTMLInputElement>('Find');

  const find = (typed: string) => {
    fireEvent.change(findBox(), { target: { value: typed } });
  };

  itDom('keeps the rows that place a match, and drops everything else', async () => {
    await shownPlan();

    find('back boxes');

    // `010` and `010.1` are context: without them the hit reads as a root of a
    // plan it is three levels inside.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
  });

  itDom('reveals a match inside a branch the reader had closed', async () => {
    await shownPlan();
    click('Collapse 010.1');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020', '020.1']);

    find('back boxes');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
  });

  itDom('marks the row that matched, so the rows around it read as context', async () => {
    await shownPlan();

    find('back boxes');

    const hit = screen.getByLabelText('Name of 010.1.1');
    expect(hit.dataset['match']).toBe('true');
    expect(hit.style.background).not.toBe('');
    const ancestor = screen.getByLabelText('Name of 010.1');
    expect(ancestor.dataset['match']).toBeUndefined();
    expect(ancestor.style.background).toBe('');
  });

  itDom('shows the whole subtree under a matched parent', async () => {
    await shownPlan();

    find('strip');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
    // Only the row whose own name matched is a hit; the three under it are
    // there because their parent is.
    expect(screen.getByLabelText('Name of 010').dataset['match']).toBe('true');
    expect(screen.getByLabelText('Name of 010.1').dataset['match']).toBeUndefined();
  });

  itDom('shows an empty table and says so when nothing matches', async () => {
    await shownPlan();

    find('plumbing');

    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByText(/No matches for/).textContent).toContain('plumbing');
  });

  itDom('counts what is on screen against the whole plan', async () => {
    await shownPlan();

    find('back boxes');

    expect(screen.getByText('3 of 6 rows')).toBeDefined();
  });

  itDom('clearing the search puts the reader’s own collapse back', async () => {
    await shownPlan();
    click('Collapse 010.1');
    click('Collapse 020');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020']);

    find('back boxes');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);

    // Escape, which is how a search is left.
    fireEvent.keyDown(findBox(), { key: 'Escape' });

    expect(findBox().value).toBe('');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020']);
  });

  itDom('the expansion controls stand down while a search is on', async () => {
    await shownPlan();

    find('back boxes');

    // A triangle here would either lie about what the search opened or close a
    // branch holding the hit.
    expect(screen.queryByRole('button', { name: 'Collapse 010' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled();
  });

  itDom('the Find box is not a cell of the keyboard grid', async () => {
    await shownPlan();

    const box = findBox();
    expect(box.getAttribute('data-cell')).toBeNull();
    expect(box.closest('table')).toBeNull();
  });

  itDom('the arrows walk the rows a search left on screen', async () => {
    await shownPlan();
    find('skirting');
    expect(numbersOnScreen()).toEqual(['010', '010.2']);

    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    name.focus();
    name.setSelectionRange(name.value.length, name.value.length);
    fireEvent.keyDown(name, { key: 'ArrowDown' });

    // Not `010.1`: it is not on screen, so it is not in the grid the keys read
    // out of the committed DOM.
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010.2'));
  });

  itDom('re-derives from the rows that came back, so a renamed row can leave', async () => {
    const api = await shownPlan();
    find('skirting');
    expect(numbersOnScreen()).toEqual(['010', '010.2']);

    const name = screen.getByLabelText('Name of 010.2');
    fireEvent.change(name, { target: { value: 'Trim' } });
    fireEvent.blur(name);

    // A row edited out of the match set disappears from the narrowed view.
    // Deliberate: the alternative is a table showing a row that no longer
    // answers the question on screen above it.
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
    expect(api.rows.map((row) => row.name)).toContain('Trim');
    expect(screen.getByText('0 of 6 rows')).toBeDefined();
  });

  itDom('collapses every branch and opens them all again', async () => {
    await shownPlan();

    click('Collapse all');
    expect(numbersOnScreen()).toEqual(['010', '020']);

    click('Expand all');
    expect(numbersOnScreen()).toEqual(EVERY_ROW);
  });

  itDom('remembers a collapsed branch across a remount', async () => {
    const api = await shownPlan();
    click('Collapse 010.1');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020', '020.1']);

    cleanup();
    render(<WbsTable projectId="p1" api={api} />);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020', '020.1']);
    });
  });

  itDom('remembers each project separately', async () => {
    const api = await shownPlan();
    click('Collapse all');
    expect(numbersOnScreen()).toEqual(['010', '020']);

    cleanup();
    render(<WbsTable projectId="p2" api={api} />);

    // A different project has its own memory, and no memory means everything
    // open — not the shape the last project was left in.
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(EVERY_ROW);
    });
  });

  itDom('drops a remembered expansion that is not one, rather than obeying it', async () => {
    // localStorage is user-editable, so what comes back is a claim. A table
    // that cannot be opened until somebody clears storage by hand is a worse
    // answer than forgetting which triangles were pointing down.
    localStorage.setItem('wbs.expanded.p1', 'not json at all');

    await shownPlan();

    expect(localStorage.getItem('wbs.expanded.p1')).toBe('true');
  });
});

describe('failures you can see', () => {
  /** Types a dependency list into a row's cell and sends it. */
  const typeDeps = (rowNumber: string, value: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  /** A table subscribed to a socket, with the handle that fires a change event. */
  async function subscribedTable() {
    const api = fakeApi();
    // Throws rather than doing nothing: a table that never subscribed must
    // fail loudly here instead of quietly asserting a tree nothing refreshed.
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
    return {
      api,
      notify: () => {
        notify();
      },
    };
  }

  itDom('says a refused rename in a toast, and puts nothing above the table', async () => {
    const api = await threeRoots();
    api.patch = () => Promise.reject(new Error('forbidden'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));

    await waitFor(() => {
      expect(toastTexts()).toEqual([
        'That change could not be completed: this plan is not yours to change.',
      ]);
    });
    // The single alert on screen is the toast itself. The top-of-page error
    // line is gone: two alerts here would be the old one still rendering.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.closest('[data-toasts]')).not.toBeNull();
  });

  itDom('keeps a failure on screen when the next action succeeds', async () => {
    // `run` used to clear the error line before every request, so the reason a
    // rename was refused disappeared the moment anything else worked. A toast
    // owns its own lifecycle: only its ✕ takes it off.
    const api = await threeRoots();
    const realPatch = api.patch.bind(api);
    api.patch = () => Promise.reject(new Error('forbidden'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        'That change could not be completed: this plan is not yours to change.',
      ]);
    });

    api.patch = realPatch;
    typeName('020', 'Sanded');
    fireEvent.blur(screen.getByLabelText('Name of 020'));
    await waitFor(() => {
      expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Sanded');
    });

    expect(toastTexts()).toEqual([
      'That change could not be completed: this plan is not yours to change.',
    ]);
  });

  itDom('takes a failure off when its ✕ is pressed', async () => {
    const api = await threeRoots();
    api.patch = () => Promise.reject(new Error('forbidden'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));
    await waitFor(() => {
      expect(toastTexts()).toHaveLength(1);
    });

    click('Dismiss: That change could not be completed: this plan is not yours to change.');

    expect(toastTexts()).toEqual([]);
  });

  itDom('says a row that has gone is gone, and rereads the tree that proves it', async () => {
    // The race a real user hits: somebody else deletes the row first, and this
    // client's delete comes back `not_found`. The word itself reached the
    // corner of the screen as `not_found` until 2026-08-09 — and the row it
    // was about stayed on screen, because `run` skips the reread after a
    // refusal. Both halves are the fix.
    //
    // Proof, two faults, both watched 2026-08-09. The mapping removed so the
    // code is passed through, this failed on `expected [ 'not_found' ] to
    // include 'That change could not be completed: its target is no longer
    // here — someone may have deleted it.'`. The reread removed, it failed on
    // `expected [ '010', '020', '030' ] to deeply equal [ '010', '020' ]` — a
    // sentence saying a row is gone above the row, still there.
    const api = await threeRoots();
    const realRemove = api.remove.bind(api);
    api.remove = async (id: string) => {
      // The peer's delete, renumbering and all, and then be-01's answer to
      // ours: there is no such row any more.
      await realRemove(id);
      throw new Error('not_found');
    };

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: its target is no longer here — someone may have deleted it.',
      );
    });
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('says the server could not do it rather than showing a status', async () => {
    // `http_500` is what `send` throws when be-01 answers with one and the body
    // carries no word of its own. It was the toast, verbatim, until 2026-08-09.
    // Not "the server did not answer": something answered, with a 500.
    // Proof: the 5xx branch removed, this failed on `expected [ 'http_500' ] to
    // include 'The server could not complete that change. Try again.'`.
    // Watched, 2026-08-09.
    const api = await threeRoots();
    api.remove = () => Promise.reject(new Error('http_500'));

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain('The server could not complete that change. Try again.');
    });
    // A 500 is not a "gone": nothing is reread and nothing leaves the screen.
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('turns a validation refusal into a sentence, and rereads the plan', async () => {
    // `http_422` is what `send` throws when be-01 refuses the *body* — an
    // ArkType failure carries Elysia's own JSON, with no word for `send` to
    // read. It reached the corner of the screen verbatim on 2026-08-09, to
    // somebody who had done nothing more exotic than type a date.
    // Proof: the `INVALID_REQUEST` branch removed from `refusalSentence`, this
    // failed on `expected [ Array(1) ] to include 'That change was not valid,
    // so nothing…'`; and the `INVALID_REQUEST` half of the reread condition
    // removed, it failed on `expected +0 to be 1`. Both watched, 2026-08-09.
    const api = await threeRoots();
    let reads = 0;
    const realTree = api.tree.bind(api);
    api.tree = (projectId: string) => {
      reads += 1;
      return realTree(projectId);
    };
    api.patch = () => Promise.reject(new Error('http_422'));

    fireEvent.change(screen.getByLabelText('Name of 020'), { target: { value: 'Sand it' } });
    fireEvent.blur(screen.getByLabelText('Name of 020'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change was not valid, so nothing was saved — what is on screen was read again.',
      );
    });
    // No status code anywhere in what the reader is shown.
    expect(toastTexts().join(' ')).not.toContain('http_422');
    // And the plan really was read again, which is what the sentence claims:
    // `run` skips the reread after a refusal, so this only happens for the
    // refusals that say the screen is behind.
    await waitFor(() => {
      expect(reads).toBe(1);
    });
  });

  itDom('puts a code it has no sentence for inside one', async () => {
    // The grammatical fallback `auth-form.tsx` established. A code nobody has
    // written a sentence for is still a sentence, with the word in brackets for
    // whoever is reading the console beside it.
    // Proof: the fallback replaced by the bare code, this failed on `expected
    // [ 'unknown_strategy' ] to include 'That change could not be completed
    // (unknown_strategy).'`. Watched, 2026-08-09.
    const api = await threeRoots();
    api.remove = () => Promise.reject(new Error('unknown_strategy'));

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain('That change could not be completed (unknown_strategy).');
    });
  });

  itDom('raises the stale-tree banner when a socket refetch fails', async () => {
    const { api, notify } = await subscribedTable();
    const realTree = api.tree.bind(api);
    api.tree = () => Promise.reject(new Error('offline'));

    act(() => {
      notify();
    });

    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });
    expect(staleBanner()?.textContent).toContain('may be out of date');
    // The rows that were on screen are still on screen: a failed refetch does
    // not throw the plan away, it says the plan may have moved on without it.
    expect(numbersOnScreen()).toEqual([]);
    // Nobody asked for this refetch, so nothing was refused: no toast.
    expect(toastTexts()).toEqual([]);

    api.tree = realTree;
    click('Retry');

    await waitFor(() => {
      expect(staleBanner()).toBeNull();
    });
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('clears the banner on a later successful refetch from any path', async () => {
    // The retry button is one way back; somebody else's edit arriving and
    // refetching cleanly is another, and it is the common one.
    const { api, notify } = await subscribedTable();
    const realTree = api.tree.bind(api);
    api.tree = () => Promise.reject(new Error('offline'));

    act(() => {
      notify();
    });
    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });

    api.tree = realTree;
    act(() => {
      notify();
    });

    await waitFor(() => {
      expect(staleBanner()).toBeNull();
    });
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('raises the banner when the refetch after an edit fails', async () => {
    const api = await threeRoots();
    api.tree = () => Promise.reject(new Error('offline'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));

    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });
    // The edit itself was taken. Only the reread failed, so there is nothing
    // to refuse and nothing to toast.
    expect(toastTexts()).toEqual([]);
  });

  itDom('reports every refused dependency in one toast, not one each', async () => {
    // The reviewers killed a toast per change for being noise. Three lines
    // saying three halves of one answer is the same failure.
    const api = await threeRoots();
    const real = api.addDependency.bind(api);
    api.addDependency = (id: string, predecessorId: string) => {
      const number = api.rows.find((r) => r.id === predecessorId)?.number;
      if (number === '010' || number === '020') return Promise.reject(new Error('cycle'));
      return real(id, predecessorId);
    };

    typeDeps('030', '010, 020, 999');

    await waitFor(() => {
      expect(toastTexts()).toHaveLength(1);
    });
    const said = toastTexts()[0] ?? '';
    expect(said).toContain('999');
    expect(said).toContain('010 (cycle)');
    expect(said).toContain('020 (cycle)');
  });

  itDom('shows both the refusal and the banner when the refetch failed too', async () => {
    // Two different facts: the request was refused, and what is on screen may
    // no longer be what be-01 holds. Reporting one of them would be a lie by
    // omission whichever one was dropped.
    const api = await threeRoots();
    api.addDependency = () => Promise.reject(new Error('cycle'));
    api.tree = () => Promise.reject(new Error('offline'));

    // A list, not one number: a single number is taken by the picker's
    // highlight and goes through `run`, which does not reread after a refusal.
    // The combined path is the one that refuses and rereads in one gesture.
    typeDeps('030', '010, 020');

    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });
    expect(toastTexts()).toEqual([expect.stringContaining('010 (cycle), 020 (cycle)')]);
  });
});

describe('a click made while a save is in flight', () => {
  itDom('says the toolbar is busy, and marks the controls the wait holds back', async () => {
    // What the wait looks like, now that it no longer eats what arrives during
    // it. The drop *was* real — reproduced in Chrome on 2026-08-09, a ⌘+Enter
    // and an immediate click producing a PATCH, two GETs and **no POST at
    // all** — and this test was written to make it visible because "queuing
    // the click is a design decision nobody has made". It has been made, on
    // 2026-08-23, after dev measured 6 clicks at 350ms producing 3 rows: `Add
    // work item` queues, so it is the one toolbar write that is **not**
    // `disabled={busy}`. The affordance is what stayed.
    //
    // Proof: `aria-busy={busy}` pinned to `false` on the toolbar, this failed
    // on `expected 'false' to be 'true'`; and `busyAffordance(busy)` dropped
    // from `Add work item`, it failed on `expected '' to be 'progress'`.
    // Both watched, 2026-08-09.
    const api = await threeRoots();
    const finish: (() => void)[] = [];
    api.patch = () => new Promise<void>((resolve) => finish.push(resolve));

    const toolbar = document.querySelector('[data-toolbar]');
    if (toolbar === null) throw new Error('the table rendered no toolbar');
    expect(toolbar.getAttribute('aria-busy')).toBe('false');

    fireEvent.change(screen.getByLabelText('Name of 010'), { target: { value: 'Strip it' } });
    fireEvent.blur(screen.getByLabelText('Name of 010'));

    const add = screen.getByRole('button', { name: 'Add work item' });
    await waitFor(() => {
      expect(toolbar.getAttribute('aria-busy')).toBe('true');
    });
    // Takeable throughout, unlike `Freeze all` beside it: the click is queued
    // rather than refused, which is the whole of `add-item-drops-clicks`.
    expect(add).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Freeze numbering' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(add.style.cursor).toBe('progress');
    expect(add.hasAttribute('data-busy')).toBe(true);

    await act(async () => {
      finish[0]?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toolbar.getAttribute('aria-busy')).toBe('false');
    });
    expect(add.style.cursor).toBe('');
    expect(add.hasAttribute('data-busy')).toBe(false);
  });

  itDom('leaves Undo-with-nothing-to-undo plain, because waiting will not help it', async () => {
    // The distinction the affordance draws. `Undo` is `disabled={busy || !undoable}`
    // and an empty stack is not a wait — a progress cursor over it would be a
    // lie about something that is not going to change on its own.
    await threeRoots();

    const undo = screen.getByRole('button', { name: 'Undo' });

    expect(undo).toHaveProperty('disabled', true);
    expect(undo.style.cursor).toBe('');
    expect(undo.hasAttribute('data-busy')).toBe(false);
  });
});

describe('sharing the plan', () => {
  /**
   * Puts a clipboard on `navigator` for one test.
   *
   * jsdom ships none, which is the same shape as an http page in a real
   * browser — so the absent case below needs no stub at all, and the two
   * present cases need this one.
   */
  const stubClipboard = (writeText: (text: string) => Promise<void>): void => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  };

  /**
   * What `URL.createObjectURL` was handed, and what an anchor was told to
   * download.
   *
   * jsdom implements neither the object URL nor a download, so both are
   * replaced for the length of a test and put back after. The blob is kept
   * rather than only counted: the file's first bytes are the assertion.
   */
  const captureDownloads = (): { blobs: Blob[]; names: string[]; revoked: string[] } => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    const revoked: string[] = [];
    // jsdom defines neither, so this is an assignment rather than a spy.
    const urls = URL as unknown as {
      createObjectURL: (blob: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
    urls.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return `blob:plan-${String(blobs.length)}`;
    };
    urls.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    HTMLAnchorElement.prototype.click = function capture(this: HTMLAnchorElement) {
      names.push(this.download);
    };
    return { blobs, names, revoked };
  };

  /**
   * The bytes of a blob, through `FileReader`.
   *
   * jsdom's `Blob` has no `text()`, and the bytes are what is wanted anyway:
   * `readAsText` strips a leading byte-order mark per spec, so a text read
   * could not tell a file that carries one from a file that does not.
   */
  const readBlobBytes = (blob: Blob): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const read = reader.result;
        if (read instanceof ArrayBuffer) resolve(new Uint8Array(read));
        else reject(new Error('the downloaded blob read back as something else'));
      };
      reader.onerror = () => {
        reject(new Error('the downloaded blob could not be read'));
      };
      reader.readAsArrayBuffer(blob);
    });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(HTMLAnchorElement.prototype, 'click');
  });

  /** One named, estimated row, so an export has something to disagree about. */
  const onePlannedRow = async (): Promise<ReturnType<typeof fakeApi>> => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    typeName('010', 'Strip, sand & paint');
    fireEvent.blur(screen.getByLabelText('Name of 010'));
    await waitFor(() => {
      expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip, sand & paint');
    });
    return api;
  };

  itDom('offers all four ways of taking the plan out of the tool', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    expect(await screen.findByRole('button', { name: 'Copy as Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy as Mermaid' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download as Markdown' })).toBeInTheDocument();
  });

  itDom('copies the whole plan, header first, and says it did', async () => {
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await onePlannedRow();

    click('Copy as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual(['Copied as Markdown.']);
    });
    const [markdown] = copied;
    expect(markdown).toContain('**Project:** Rewire the shed');
    expect(markdown).toContain('**Final figures:** PERT');
    expect(markdown).toContain('| Strip, sand & paint |');
    // An info toast, so no alert role: nothing was refused.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('says so when the clipboard refuses the write', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
    await onePlannedRow();

    click('Copy as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('refused the clipboard')]);
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  itDom('says so when the page has no clipboard at all', async () => {
    // No stub: jsdom has none, which is what an http page has.
    await onePlannedRow();

    click('Copy as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('no clipboard')]);
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  itDom('copies the chart as a Mermaid gantt, and says it did', async () => {
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await onePlannedRow();
    typeIntoDate('Project start date', '2026-08-03');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    click('Copy as Mermaid');

    await waitFor(() => {
      expect(toastTexts()).toEqual(['Copied as Mermaid.']);
    });
    const [diagram] = copied;
    expect(diagram).toContain('gantt');
    expect(diagram).toContain('dateFormat');
    // An info toast, so no alert role: nothing was refused.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('says so when there is no diagram to draw, and copies nothing', async () => {
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await onePlannedRow();

    click('Copy as Mermaid');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('not on a calendar')]);
    });
    expect(copied).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  itDom('downloads a CSV named after the project and the day, and lets the URL go', async () => {
    const downloads = captureDownloads();
    await onePlannedRow();

    click('Download CSV');

    expect(downloads.names).toHaveLength(1);
    expect(downloads.names[0]).toMatch(/^rewire-the-shed-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(downloads.revoked).toEqual(['blob:plan-1']);
    // `.at`, not `[0]`: the index signature would hand back a `Blob` whatever
    // is in the array, and the guard below would then be checking nothing.
    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    expect(file.type).toBe('text/csv;charset=utf-8');
    const bytes = await readBlobBytes(file);
    // The byte-order mark first, or Excel on Windows reads the em dashes and
    // every non-ASCII name as the system codepage.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Project,Rewire the shed');
    // The name holds a comma, so it is quoted rather than splitting the row.
    expect(text).toContain('"Strip, sand & paint"');
    expect(text).toContain('\r\n');
  });

  itDom('downloads the bundled Markdown document, the fence and the table together', async () => {
    const downloads = captureDownloads();
    await onePlannedRow();
    typeIntoDate('Project start date', '2026-08-03');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    click('Download as Markdown');

    expect(downloads.names).toHaveLength(1);
    expect(downloads.names[0]).toMatch(/^rewire-the-shed-\d{4}-\d{2}-\d{2}\.md$/);
    expect(downloads.revoked).toEqual(['blob:plan-1']);
    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    expect(file.type).toBe('text/markdown;charset=utf-8');
    const text = new TextDecoder().decode(await readBlobBytes(file));
    expect(text).toContain('```mermaid');
    expect(text).toContain('gantt');
    expect(text).toContain('| Strip, sand & paint |');
    // Q6 of the R7 brief: which rows are in this document, since the chart on
    // screen and this document do not agree.
    expect(text).toContain('the whole plan, not what is on screen');
  });

  itDom('says so when there is nothing to bundle, and downloads nothing', async () => {
    const downloads = captureDownloads();
    await onePlannedRow();

    click('Download as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('not on a calendar')]);
    });
    expect(downloads.names).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('the keyboard cheat sheet', () => {
  /** The sheet, or null while it is closed. */
  const sheet = (): HTMLElement | null =>
    screen.queryByRole('dialog', { name: 'Keyboard shortcuts' });

  /** The sheet, or a thrown error rather than a null the assertions walk into. */
  const openSheet = (): HTMLElement => {
    const open = sheet();
    if (open === null) throw new Error('the cheat sheet is not open');
    return open;
  };

  /** The area outside the dialog, which closes it when it is clicked. */
  const backdrop = (): Element => {
    const found = document.querySelector('[data-cheat-sheet-backdrop]');
    if (found === null) throw new Error('the cheat sheet has no backdrop');
    return found;
  };

  itDom('opens the sheet when ? is pressed outside a cell', async () => {
    await threeRoots();
    expect(sheet()).toBeNull();

    // At the table itself: a keystroke landing on the page rather than in a
    // box somebody is typing into.
    fireEvent.keyDown(screen.getByRole('table'), { key: '?' });

    expect(openSheet().getAttribute('aria-modal')).toBe('true');
    // One of the registry's groups, so this is asserting the sheet rendered
    // the bindings rather than an empty box. What is in each group is
    // `keyboard-cheat-sheet.test.tsx`'s business.
    expect(screen.getByRole('heading', { name: 'Moving rows' })).toBeDefined();
  });

  itDom('a question mark typed into a name stays a question mark', async () => {
    await threeRoots();

    const stillTheBrowsers = fireEvent.keyDown(screen.getByLabelText('Name of 010'), { key: '?' });

    // Nothing opened, and the keystroke was left to the field that wanted it.
    expect(sheet()).toBeNull();
    expect(stillTheBrowsers).toBe(true);
  });

  itDom('closes on Escape and gives the focus back to what had it', async () => {
    await threeRoots();
    const opener = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    // jsdom does not focus a clicked button; a browser does, and where the
    // focus goes back to is what this test is about.
    opener.focus();
    click('Keyboard shortcuts');
    expect(openSheet().contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(openSheet(), { key: 'Escape' });

    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  itDom('gives the focus back to the cell that had it', async () => {
    await threeRoots();
    const name = screen.getByLabelText('Name of 010');
    name.focus();

    // The keystroke lands on the page while the cell holds the focus, which is
    // the only way `?` opens anything from a row: inside the cell it is a
    // question mark.
    fireEvent.keyDown(screen.getByRole('table'), { key: '?' });
    expect(openSheet().contains(document.activeElement)).toBe(true);
    fireEvent.click(backdrop());

    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(name);
  });

  itDom('opens from the toolbar for anyone who was never told about ?', async () => {
    await threeRoots();

    click('Keyboard shortcuts');

    expect(openSheet()).toBeDefined();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' }).title).toBe(
      'Keyboard shortcuts (?)',
    );
  });
});

describe('undo and redo', () => {
  /** The chord as a browser delivers it, with `Z` uppercased by Shift. */
  const pressUndo = (target: Element, shiftKey = false) =>
    fireEvent.keyDown(target, { key: shiftKey ? 'Z' : 'z', ctrlKey: true, shiftKey });

  itDom('undoes the last change and says what it undid', async () => {
    const api = await threeRoots();
    api.answerStackWith({ ok: true, done: 'rename “Strip”', detail: null });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['undo']);
    });
    await waitFor(() => {
      expect(toastTexts()).toContain('Undid: rename “Strip”');
    });
  });

  itDom('leaves ctrl-z alone inside a name cell, where the browser owns it', async () => {
    const api = await threeRoots();

    // The return value is `false` when something called `preventDefault`. A
    // half-typed word is the browser's to undo, and taking the chord here
    // would reverse a change that has landed instead of the letters on screen.
    const stillTheBrowsers = pressUndo(screen.getByLabelText('Name of 010'));

    expect(stillTheBrowsers).toBe(true);
    expect(api.stackCalls).toEqual([]);
    expect(toastTexts()).toEqual([]);
  });

  itDom('redoes what was undone', async () => {
    const api = await threeRoots();
    api.answerStackWith({ ok: true, done: 'rename “Strip”', detail: null });

    pressUndo(screen.getByRole('table'), true);

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['redo']);
    });
    await waitFor(() => {
      expect(toastTexts()).toContain('Redid: rename “Strip”');
    });
  });

  itDom('names the change that stood in the way when an undo is refused', async () => {
    // be-01's own sentence, ended: it used to stop at `has changed since`, with
    // no full stop and no answer to "since what?", while every toast beside it
    // was a whole sentence. Read on screen on 2026-08-09.
    const api = await threeRoots();
    api.answerStackWith({
      ok: false,
      reason: 'stale_undo',
      detail: '“Sand it twice” has changed since then.',
    });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That could not be undone: “Sand it twice” has changed since then.',
      );
    });
  });

  itDom('says whose stack is empty rather than leaving the key silent', async () => {
    const api = await threeRoots();
    api.answerStackWith({ ok: false, reason: 'nothing_to_undo', detail: null });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'There are none of your own changes left to undo on this plan.',
      );
    });
  });

  itDom('says a partial restore out loud rather than reporting a clean undo', async () => {
    const api = await threeRoots();
    api.answerStackWith({
      ok: true,
      done: 'delete “Strip”',
      detail: 'put back without 1 dependency the plan no longer allows (not_found)',
    });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'Undid: delete “Strip” — put back without 1 dependency the plan no longer allows (not_found)',
      );
    });
  });

  itDom('greys the buttons out until be-01 says there is something in that half', async () => {
    const api = await threeRoots();

    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveProperty('disabled', true);

    // be-01 is the only thing that knows: the stack is per account, and
    // somebody else's edit can empty this reader's redo branch.
    api.stack.undoable = true;
    // Any refetch carries the answer; a socket event is the one nobody asked
    // for, which is exactly the case the buttons must still follow.
    click('Add work item');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', false);
    });
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveProperty('disabled', true);
  });

  itDom('undoes from the toolbar for anyone who never learns the chord', async () => {
    const api = await threeRoots();
    api.stack.undoable = true;
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', false);
    });

    click('Undo');

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['undo']);
    });
  });
});

/**
 * The command chords: one gesture family for structure, one for motion.
 *
 * Every row of the routing matrix in `openspec/changes/command-keys/design.md`
 * is a test in here — chord × cell class, and the cells whose picker is open,
 * where a chord must be inert because the list owns the keyboard.
 */
describe('the command chords', () => {
  /** A chord as a browser delivers it, aimed at a named box. */
  const chord = (
    box: Element,
    key: string,
    modifiers: { code?: string; ctrl?: boolean; meta?: boolean; alt?: boolean; repeat?: boolean },
  ) =>
    fireEvent.keyDown(box, {
      key,
      code: modifiers.code ?? `Key${key.toUpperCase()}`,
      ctrlKey: modifiers.ctrl ?? false,
      metaKey: modifiers.meta ?? false,
      altKey: modifiers.alt ?? false,
      repeat: modifiers.repeat ?? false,
    });

  const nameOf = (number: string) =>
    screen.getByLabelText<HTMLTextAreaElement>(`Name of ${number}`);
  /** Whatever holds the focus, as a box the helpers above can be aimed at. */
  const focused = (): Element => {
    const active = document.activeElement;
    // Thrown rather than defaulted: a chord test whose focus went nowhere must
    // say so, not fire its next key at the document body and pass.
    if (active === null) throw new Error('nothing has the focus');
    return active;
  };
  /** Ctrl+N, the new-work-item chord, in the box named. */
  const newItem = (box: Element) => chord(box, 'n', { code: 'KeyN', ctrl: true });
  /** Cmd+Enter, the next-or-create chord. */
  const nextOrCreate = (box: Element) => chord(box, 'Enter', { code: 'Enter', meta: true });
  /** Ctrl+D, once. A confirming second press needs {@link releaseD} in between. */
  const armDelete = (box: Element, repeat = false) =>
    chord(box, 'd', { code: 'KeyD', ctrl: true, repeat });
  /** The keyup of D the confirm waits for: a held key can never reach it. */
  const releaseD = (box: Element) => fireEvent.keyUp(box, { key: 'd', code: 'KeyD' });

  /** The sentence an armed row puts on screen, which is only true while it is armed. */
  const armSays = (number: string) => `Ctrl+D again deletes ${number} — its children move up`;

  /** Which row is tinted as armed for deletion, by number. */
  const armedRow = (): string | null => {
    const row = document.querySelector('tr[data-armed="true"]');
    return row === null ? null : (row.querySelector('[data-number]')?.textContent ?? '');
  };

  itDom('Enter in a name is a newline, and makes nothing', async () => {
    // The whole of R1's second half: a note is typed under the name, which
    // needs Enter to mean what it means in every other text box in the world.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText('Name of 010');

    const event = createEvent.keyDown(cell, { key: 'Enter', code: 'Enter' });
    fireEvent(cell, event);

    // Not taken: the browser writes the newline. jsdom performs no default
    // action for a synthetic key, so this is the assertion it can make — the
    // real newline is the browser spec's.
    expect(event.defaultPrevented).toBe(false);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(api.rows).toHaveLength(1);
  });

  itDom('Ctrl+N makes a sibling below this row, mid-table, and lands in its name', async () => {
    await threeRoots();

    newItem(nameOf('020'));

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    // Below 020, not at the end: that is what Ctrl+N has over Cmd+Enter.
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', '', 'Paint']);
    expect(document.activeElement).toBe(nameOf('030'));
  });

  itDom('Alt+N is the same chord for the keyboards Ctrl+N never reaches', async () => {
    // macOS turns Alt+N into a dead key, so the letter never arrives — the
    // physical key does, and that is what this is matched on.
    await threeRoots();

    chord(nameOf('020'), 'Dead', { code: 'KeyN', alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(document.activeElement).toBe(nameOf('030'));
  });

  itDom('Ctrl+N works from an estimate cell, and sends what was in it first', async () => {
    const api = await threeRoots();
    const box = screen.getByLabelText('Dev optimistic for 020');
    box.focus();
    fireEvent.change(box, { target: { value: '3' } });

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    // One box of a trio is a draft, not a request — the flush is still the
    // cell's own commit path, and the row below it exists either way.
    expect(document.activeElement).toBe(nameOf('030'));
    expect(api.rows.find((row) => row.number === '020')?.estimates).toEqual({});
  });

  itDom('Cmd+Enter moves to the next row’s name', async () => {
    await threeRoots();
    const cell = nameOf('010');
    cell.focus();

    nextOrCreate(cell);

    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('020'));
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('Cmd+Enter on the last row makes one and lands in it', async () => {
    await threeRoots();
    const cell = nameOf('030');
    cell.focus();

    nextOrCreate(cell);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(document.activeElement).toBe(nameOf('040'));
  });

  itDom('two Cmd+Enters on the last row make exactly one row', async () => {
    // The chord runs a request and then another; two presses inside that
    // window are one gesture arriving twice, not two work items.
    // Proof: the in-flight gate removed, this failed on `expected [ '010',
    // '020', '030', '040', '050' ] to deeply equal [ '010', '020', '030',
    // '040' ]`. Watched, 2026-08-08.
    const api = await threeRoots();
    const cell = nameOf('030');
    cell.focus();

    nextOrCreate(cell);
    nextOrCreate(cell);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(api.rows).toHaveLength(4);
  });

  itDom('waits for the save to land before it creates anything', async () => {
    // codex #5, and the assertion has to be about *settling* rather than about
    // the order the two calls go out in. Both leave synchronously either way —
    // what an unawaited flush loses is the answer, and with it the right to
    // decide whether to create at all. So the patch is held open and the
    // create must not have happened while it hangs.
    //
    // Proof: the `await` dropped — `const outcome = 'landed'` with the flush
    // fired and forgotten — this failed on `expected [ 'patch', 'create' ] to
    // deeply equal [ 'patch' ]`, a row created against an answer nobody had.
    // Watched, 2026-08-08.
    const api = await threeRoots();
    const asked: string[] = [];
    let letThePatchLand: () => void = () => {
      throw new Error('the patch was never sent');
    };
    const held = new Promise<void>((resolve) => {
      letThePatchLand = resolve;
    });
    const realPatch = api.patch.bind(api);
    api.patch = async (id: string, patch: Record<string, unknown>) => {
      asked.push('patch');
      await held;
      return realPatch(id, patch);
    };
    const realCreate = api.create.bind(api);
    api.create = (
      projectId: string,
      input: { parentId: string | null; afterId: string | null },
    ) => {
      asked.push('create');
      return realCreate(projectId, input);
    };

    const cell = nameOf('030');
    cell.focus();
    fireEvent.change(cell, { target: { value: 'Paint the trim' } });
    nextOrCreate(cell);

    await waitFor(() => {
      expect(asked).toEqual(['patch']);
    });
    // Still nothing created: the chord is waiting to hear what be-01 did.
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);

    await act(async () => {
      letThePatchLand();
      await held;
    });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(asked).toEqual(['patch', 'create']);
    expect(api.rows.find((row) => row.id === 'w3')?.name).toBe('Paint the trim');
  });

  itDom('a refused save leaves the caret where it was and makes no row', async () => {
    const api = await threeRoots();
    api.patch = () => Promise.reject(new Error('forbidden'));

    const cell = nameOf('030');
    cell.focus();
    fireEvent.change(cell, { target: { value: 'Paint the trim' } });
    nextOrCreate(cell);

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(document.activeElement).toBe(cell);
  });

  /**
   * A blur's PATCH held open, the cell refocused unchanged, and the chord
   * pressed while that first request is still out.
   *
   * Rule 5 in `cell-input.tsx` recognizes the second leave as a resubmission
   * of the request already in flight. What it must **not** do is answer the
   * chord with `unsent`: the chord reads that as "nothing to wait for" and
   * moves or creates against an answer nobody has yet.
   *
   * @param at The row whose Name cell is typed in and then chorded from.
   * @returns The fake, the cell, the request log and the two ways to settle
   * the held PATCH.
   */
  async function patchHeldOpen(at: string) {
    const api = await threeRoots();
    const asked: string[] = [];
    let landThePatch: () => void = () => {
      throw new Error('the patch was never sent');
    };
    let refuseThePatch: () => void = () => {
      throw new Error('the patch was never sent');
    };
    const realPatch = api.patch.bind(api);
    api.patch = (id: string, patch: Record<string, unknown>) => {
      asked.push('patch');
      return new Promise<void>((resolve, reject) => {
        landThePatch = () => {
          void realPatch(id, patch).then(resolve);
        };
        refuseThePatch = () => {
          reject(new Error('forbidden'));
        };
      });
    };
    const realCreate = api.create.bind(api);
    api.create = (
      projectId: string,
      input: { parentId: string | null; afterId: string | null },
    ) => {
      asked.push('create');
      return realCreate(projectId, input);
    };

    const cell = nameOf(at);
    cell.focus();
    fireEvent.change(cell, { target: { value: `${cell.value} the trim` } });
    // The blur is what starts the request the chord will have to wait for.
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(asked).toEqual(['patch']);
    });
    // Back in the cell, having typed nothing: the sequence the finding names.
    cell.focus();
    return {
      api,
      asked,
      cell,
      landThePatch: () => {
        landThePatch();
      },
      refuseThePatch: () => {
        refuseThePatch();
      },
    };
  }

  /** Turns of the microtask queue, enough for anything that never waited. */
  const letTheLoopRun = () =>
    act(async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    });

  itDom(
    'a chord waits for the blur’s patch that is still out, and a refusal makes nothing',
    async () => {
      // codex round 2, finding 1. The dedup in rule 5 answered `unsent`
      // immediately, which is the one answer that is not true here: the request
      // *is* out, and the chord's whole contract is that a refused save leaves
      // the caret where it was with nothing created.
      //
      // Proof: `return sent.current.landing` put back as `return unsent()`, this
      // failed on `expected [ 'patch', 'create' ] to deeply equal [ 'patch' ]` —
      // a row created against a request nobody had heard back from. Watched,
      // 2026-08-08.
      const { asked, cell, refuseThePatch } = await patchHeldOpen('030');

      nextOrCreate(cell);
      await letTheLoopRun();

      // Nothing while it hangs: no create, and the caret has not moved.
      expect(asked).toEqual(['patch']);
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(document.activeElement).toBe(cell);

      refuseThePatch();
      await waitFor(() => {
        expect(toastTexts()).toContain(
          'That change could not be completed: this plan is not yours to change.',
        );
      });
      await letTheLoopRun();

      // The refusal is the chord's answer as much as the blur's: nothing made,
      // nowhere moved, and the only copy of what was typed still in the box for
      // rule 4 to hold.
      expect(asked).toEqual(['patch']);
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(document.activeElement).toBe(cell);
      expect(cell.value).toBe('Paint the trim');
    },
  );

  itDom('…and moves on once that patch lands', async () => {
    // The other half: waiting is not refusing. When the request the chord
    // joined comes back landed, the move it was holding happens.
    //
    // Proof: the same line put back as `return unsent()`, this failed on
    // `expected <textarea …></textarea> to be <textarea …></textarea>` — the
    // focus already in 020 while the save was still out. Watched, 2026-08-08.
    const { cell, landThePatch } = await patchHeldOpen('010');

    nextOrCreate(cell);
    await letTheLoopRun();

    expect(document.activeElement).toBe(cell);

    landThePatch();

    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('020'));
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(nameOf('010').value).toBe('Strip the trim');
  });

  itDom('Ctrl+H, J, K and L move between cells from a caret no arrow could leave', async () => {
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    // Mid-text in a box that holds the notes as well: every arrow belongs to
    // the text here, which is exactly what these four are for.
    cell.setSelectionRange(2, 2);

    chord(cell, 'j', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('030'));
    });

    chord(focused(), 'k', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('020'));
    });

    // Sideways, in the trio — where every box is a cell of the grid and none
    // of them opens a list. The picker cells are the matrix's own rows below.
    const optimistic = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 020');
    optimistic.focus();
    fireEvent.change(optimistic, { target: { value: '3' } });
    optimistic.setSelectionRange(1, 1);

    chord(optimistic, 'l', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev realistic for 020'));
    });

    chord(focused(), 'h', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(optimistic);
    });
  });

  itDom('a chord at the grid’s edge is consumed rather than leaking to the browser', async () => {
    // Ctrl+H in Chrome is the history. A chord this table advertises must never
    // reach it, edge or no edge — so the key is taken whether or not it moved.
    await threeRoots();
    const cell = nameOf('010');
    cell.focus();

    const event = createEvent.keyDown(cell, { key: 'h', code: 'KeyH', ctrlKey: true });
    fireEvent(cell, event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cell);
  });

  itDom('Ctrl+D twice deletes the row, and says Cmd+Z puts it back', async () => {
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain('Ctrl+D again deletes 020 — its children move up');
    });
    expect(armedRow()).toBe('020');

    releaseD(cell);
    armDelete(cell);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    expect(api.rows.map((row) => row.name)).toEqual(['Strip', 'Paint']);
    expect(toastTexts()).toContain('Deleted 020 — Cmd+Z restores');
    // The row that took its place, as the actions menu's delete does it.
    expect(document.activeElement).toBe(nameOf('020'));
    expect(armedRow()).toBeNull();
  });

  itDom('a held Ctrl+D never deletes, however long it is held', async () => {
    // The repeat guard. A held key arms once and can never confirm: there is
    // no keyup between the presses, and a repeat is not a press.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    for (let press = 0; press < 5; press += 1) armDelete(cell, true);

    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom(
    'a repeat after the confirming press does not arm the row that took its place',
    async () => {
      // What `event.repeat` uniquely buys: the key is still down when the row
      // goes, and the repeats that follow must not arm whatever slid up into it.
      // Proof: the `repeat` guard removed, this failed on `expected '020' to be
      // null` — the row that slid up into the gap armed by a key nobody pressed
      // again. Watched, 2026-08-08.
      const api = await threeRoots();
      const cell = nameOf('020');
      cell.focus();
      armDelete(cell);
      releaseD(cell);
      armDelete(cell);
      await waitFor(() => {
        expect(api.rows).toHaveLength(2);
      });

      armDelete(focused(), true);
      armDelete(focused(), true);

      expect(armedRow()).toBeNull();
    },
  );

  itDom('two presses with no release between them only re-arm', async () => {
    // The keyup guard, on its own. Two keydowns and no keyup is what a held
    // key looks like on a browser that does not set `repeat` — and what two
    // keyboards produce. Dany's rule is that D must be *released* between the
    // presses, so this can never be a delete.
    // Proof: the `dReleased` conjunct dropped from the confirm, this failed on
    // `expected null to be '020'` — one gesture destroying a row, so there was
    // no arm left to find. Watched, 2026-08-08.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    armDelete(cell);

    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(api.rows).toHaveLength(3);
  });

  itDom('arming 020 and pressing Ctrl+D on 030 arms 030 and deletes neither', async () => {
    // Proof: the same-row check dropped, this failed on `expected null to be
    // '030'` — the second press deleting the row the first one had armed
    // rather than arming the one it was actually pressed in. Watched,
    // 2026-08-08.
    const api = await threeRoots();
    armDelete(nameOf('020'));
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    releaseD(nameOf('020'));

    armDelete(nameOf('030'));

    await waitFor(() => {
      expect(armedRow()).toBe('030');
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom('any other keystroke disarms it, and a modifier on its own does not', async () => {
    // agy #9: holding Control down to press the second D is a `Control`
    // keydown of its own, and disarming on it would make the chord unusable.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    releaseD(cell);

    for (const key of ['Control', 'Shift', 'Alt', 'Meta']) {
      fireEvent.keyDown(cell, { key, code: key });
    }
    expect(armedRow()).toBe('020');

    fireEvent.keyDown(cell, { key: 'x', code: 'KeyX' });

    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
    armDelete(cell);
    // Re-armed rather than confirmed: the arm it would have confirmed is gone.
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom('the arm toast leaves with the arm, however the arm ends', async () => {
    // The sentence is a promise about one row — "Ctrl+D again deletes 020" —
    // and it was pushed independently of the state that made it true, so it sat
    // on screen for its whole five seconds after the arm had gone. Observed
    // live on 2026-08-09, next to a row that was no longer armed.
    //
    // Proof: `dismissToast` dropped from the armed-state effect's cleanup, this
    // failed on `expected [ 'Ctrl+D again deletes 020 — its children move up' ]
    // not to include 'Ctrl+D again deletes 020 — its children move up'`.
    // Watched, 2026-08-09.
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(armSays('020'));
    });

    fireEvent.keyDown(cell, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
    expect(toastTexts()).not.toContain(armSays('020'));

    // And again for the other way out, because the arm is a fresh object per
    // press: the toast has to come back and then leave a second time.
    releaseD(cell);
    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(armSays('020'));
    });

    fireEvent.focusOut(cell);
    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
    expect(toastTexts()).not.toContain(armSays('020'));
  });

  itDom('the arm toast leaves when the delete it promised happens', async () => {
    // The pair seen together live: `Deleted 050 — Cmd+Z restores` under
    // `Ctrl+D again deletes 050 — its children move up`, one of them about a
    // row that no longer existed.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(armSays('020'));
    });
    releaseD(cell);
    armDelete(cell);

    await waitFor(() => {
      expect(toastTexts()).toContain('Deleted 020 — Cmd+Z restores');
    });
    expect(toastTexts()).not.toContain(armSays('020'));
    expect(api.rows).toHaveLength(2);
  });

  itDom('Escape disarms it', async () => {
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });

    fireEvent.keyDown(cell, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
  });

  itDom('leaving the cell disarms it, however the focus went', async () => {
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });

    // A pointer-driven focus move, which is the one a keydown listener cannot
    // see. `focusout` is what the DOM says about it either way.
    fireEvent.focusOut(cell);

    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
  });

  itDom('a peer renumbering the armed row disarms it', async () => {
    // The arm holds the row's *id* and the number it promised to delete, and
    // both halves are read back on every refresh: "Ctrl+D again deletes 020"
    // stops being true the moment somebody else makes this row 030. The other
    // branch of the same expression is the row that has gone altogether — a
    // peer's delete — which cannot be asserted through the DOM, because a row
    // that is not rendered carries no tint to look for.
    //
    // Proof: the comparison replaced by `return armed`, this failed on
    // `expected '030' to be null` — a row still tinted, and a second Ctrl+D
    // still live, under a sentence that named a different work item. Watched,
    // 2026-08-08.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    render(
      <WbsTable
        projectId="p1"
        api={api}
        subscribe={(_projectId, handlers) => {
          notify = handlers.onChange;
          return { seen: () => undefined, unsubscribe: () => undefined };
        }}
      />,
    );
    for (const number of ['010', '020']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }

    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });

    // Their new row, moved above the armed one, which renumbers it to 030.
    const theirs = await api.create('p1', { parentId: null, afterId: null, name: 'Theirs' });
    await api.move(theirs.id, null, null);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
    expect(armedRow()).toBeNull();
    // The sentence goes with the tint: it named 020, and there is no armed 020
    // any more for it to be true about.
    expect(toastTexts()).not.toContain(armSays('020'));
  });

  itDom('a frozen row refuses to arm and says how to unfreeze it', async () => {
    const api = await threeRoots();
    click('Freeze numbering');
    await waitFor(() => {
      expect(api.rows[1]?.frozenNumber).toBe('020');
    });

    armDelete(nameOf('020'));

    await waitFor(() => {
      expect(toastTexts()).toContain('020 is frozen — unfreeze it first');
    });
    expect(armedRow()).toBeNull();
  });

  itDom('a late create does not take the focus back off a cell somebody moved to', async () => {
    // codex's mechanism for the one-off chord leak seen live on 2026-08-09. A
    // structural edit records the cell to focus when its refetch lands, and
    // that intent used to fire whatever the reader had done in the meantime —
    // so a create still in flight yanked the caret out of a folded cell with
    // an open `@` list, closed the list, and the keys still being typed landed
    // in an ordinary cell and made a row.
    //
    // The wanted steals are the ones where the reader never left: Ctrl+N,
    // Alt+N, Cmd+Enter, Duplicate and Delete all still move the caret, and
    // their own tests are what say so.
    //
    // Proof: the staleness check dropped from both consumers, this failed on
    // `expected <textarea …>…</textarea> to be <input …>` — the caret pulled
    // into the new row's name, out of the box that was being typed in.
    // Watched, 2026-08-09.
    const api = await threeRoots();
    let letTheCreateLand: () => void = () => {
      throw new Error('nothing was ever created');
    };
    const realCreate = api.create.bind(api);
    api.create = async (
      projectId: string,
      input: { parentId: string | null; afterId: string | null },
    ) => {
      await new Promise<void>((resolve) => {
        letTheCreateLand = resolve;
      });
      return realCreate(projectId, input);
    };

    // The command, from the last row so nothing above it is renumbered.
    const from = nameOf('030');
    from.focus();
    newItem(from);
    await waitFor(() => {
      expect(typeof letTheCreateLand).toBe('function');
    });

    // And now the reader goes somewhere else entirely and starts typing a
    // name into a folded role's cell, which opens the people list.
    const folded = screen.getByLabelText<HTMLInputElement>('QA estimate for 010');
    folded.focus();
    fireEvent.focus(folded);
    fireEvent.change(folded, { target: { value: '@Ada' } });
    await screen.findByRole('listbox', { name: 'QA assignee for 010' });

    await act(async () => {
      letTheCreateLand();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });

    // The row was made — the edit is not what is being refused here — and the
    // caret is still where the person put it, with the list still open under
    // the name they are halfway through.
    expect(api.rows).toHaveLength(4);
    expect(document.activeElement).toBe(folded);
    expect(folded.value).toBe('@Ada');
    expect(screen.getByRole('listbox', { name: 'QA assignee for 010' })).toBeDefined();
  });

  itDom(
    'every chord that makes or destroys a row is inert while the depends list is open',
    async () => {
      // The routing matrix's fourth row, narrowed by `table-mechanics`: an open
      // list still owns the chords that *act on a row*, and Escape is how it is
      // given back. The four motion chords are no longer among them — this box
      // opens its list on focus, so a rule that held only while it was shut held
      // for nobody, and `Ctrl+J and Ctrl+K walk the Depends on column with its
      // list open` is that half.
      const api = await threeRoots();
      const box = screen.getByLabelText('Add a dependency to 020');
      box.focus();
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '010' } });
      await screen.findByRole('listbox', { name: 'Work items 020 can depend on' });

      newItem(box);
      nextOrCreate(box);
      armDelete(box);

      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(armedRow()).toBeNull();
      expect(document.activeElement).toBe(box);
      expect(api.rows).toHaveLength(3);
    },
  );

  itDom('the same chords work in that box once the list is closed', async () => {
    // The other half of the matrix row, and what makes the first half a rule
    // rather than a dead cell: closed, this box is a cell like any other.
    await threeRoots();
    const box = screen.getByLabelText('Add a dependency to 020');
    box.focus();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '010' } });
    await screen.findByRole('listbox', { name: 'Work items 020 can depend on' });
    fireEvent.keyDown(box, { key: 'Escape' });

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
  });

  itDom(
    'every chord that makes or destroys a row is inert while a team picker’s list is open',
    async () => {
      // Narrowed with the depends box's twin above, and for the same reason: the
      // four motion chords leave this cell whether the list is up or not.
      const api = await threeRoots();
      const box = screen.getByLabelText('Service or team for 020');
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: 'Plat' } });
      await screen.findByRole('listbox', { name: 'Service or team for 020' });

      newItem(box);
      armDelete(box);

      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(armedRow()).toBeNull();
      expect(api.rows).toHaveLength(3);
    },
  );

  itDom('the same chords work in a picker whose list is closed', async () => {
    await threeRoots();
    const box = screen.getByLabelText('Service or team for 020');
    box.focus();

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
  });

  itDom('every chord is inert while the folded cell’s @ list is open', async () => {
    const api = await threeRoots();
    // Folded, which is where the `@` picker lives.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const box = await screen.findByLabelText('Dev estimate for 020');
    box.focus();
    // A name nobody has: the list offers to add them, which is a list.
    fireEvent.change(box, { target: { value: '@Ada' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    newItem(box);
    armDelete(box);

    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(armedRow()).toBeNull();
    expect(api.rows).toHaveLength(3);
  });

  /**
   * The chord as an open list receives it, so what it did there can be read.
   *
   * `createEvent` rather than `fireEvent.keyDown`, because half of "inert"
   * is that the key was **taken**: an open list that ignores Cmd+Enter and
   * lets it through to the browser has not consumed it.
   */
  const chordInto = (box: Element, key: string, modifiers: { meta?: boolean; alt?: boolean }) => {
    const event = createEvent.keyDown(box, {
      key,
      code: key === 'Enter' ? 'Enter' : key,
      metaKey: modifiers.meta ?? false,
      altKey: modifiers.alt ?? false,
    });
    fireEvent(box, event);
    return event;
  };

  /** Every `assign` and `addPerson` the table asked for, in order. */
  const watchPeopleWrites = (api: ProjectApi): string[] => {
    const written: string[] = [];
    const realAssign = api.assign.bind(api);
    api.assign = (id: string, roleId: string, personId: string | null) => {
      written.push(`assign ${id} ${roleId} ${String(personId)}`);
      return realAssign(id, roleId, personId);
    };
    const realAdd = api.addPerson.bind(api);
    api.addPerson = (name: string, teamIds: readonly string[]) => {
      written.push(`addPerson ${name}`);
      return realAdd(name, teamIds);
    };
    return written;
  };

  itDom('Cmd+Enter in an open team picker takes no entry and creates none', async () => {
    // codex round 2, finding 2. The `!open` guard kept the chord away from the
    // table's handler and stopped there: the bare `e.key === 'Enter'` branch
    // underneath reads no modifiers, so the chord went on to choose the first
    // entry — or to create one out of a half-typed search.
    //
    // Proof: the `commandChord` consume guard removed from
    // `creatable-picker.tsx`, this failed on `expected 'team1' to be null` —
    // 020 labelled with a team by a keystroke aimed at the plan. Watched,
    // 2026-08-08.
    const api = await threeRoots();
    // A team on offer, made the way a person makes one: bare Enter still does.
    const first = screen.getByLabelText('Service or team for 010');
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: 'Platform' } });
    fireEvent.keyDown(first, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe('team1');
    });

    const box = screen.getByLabelText('Service or team for 020');
    fireEvent.focus(box);
    // Matches `Platform` without being it, so the list holds both an entry to
    // choose and an `Add “Plat”` to create.
    fireEvent.change(box, { target: { value: 'Plat' } });
    await screen.findByRole('listbox', { name: 'Service or team for 020' });

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    // No assignment, no entry created, and no work item either.
    expect(api.rows[1]?.serviceTeamId).toBeNull();
    expect(await api.listTeams()).toHaveLength(1);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    // The search is still there to go on typing: consumed is not cleared.
    expect(box).toHaveValue('Plat');
  });

  itDom('Cmd+Enter in an open assignee picker assigns nobody and adds nobody', async () => {
    // The same component, the other column it is rendered in — and the writes
    // it would have made are recorded rather than inferred.
    //
    // Proof: the same guard removed, this failed on `expected [ 'assign w2
    // role-dev person1' ] to deeply equal []`. Watched, 2026-08-08.
    const api = await threeRoots();
    const first = screen.getByLabelText('Dev assignee for 010');
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: 'Kateryna' } });
    fireEvent.keyDown(first, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Dev assignee for 010')).toHaveValue('Kateryna');
    });
    const written = watchPeopleWrites(api);

    const box = screen.getByLabelText('Dev assignee for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Kat' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    expect(written).toEqual([]);
    expect(await api.listPeople()).toHaveLength(1);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('Cmd+Enter in the open depends list adds no dependency', async () => {
    // Both of the box's Enter flows are in range here: an entry is highlighted
    // *and* the typed text is a number a person could have meant.
    //
    // Proof: the consume guard removed from the depends `onKeyDown`, this
    // failed on `expected null not to be null` — 020 waiting for 010 on a
    // chord nobody aimed at the list. Watched, 2026-08-08.
    await threeRoots();
    const box = screen.getByLabelText('Add a dependency to 020');
    box.focus();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '010' } });
    await screen.findByRole('listbox', { name: 'Work items 020 can depend on' });
    const highlighted = box.getAttribute('aria-activedescendant');
    expect(highlighted).toBe('dep-option-w1');

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByLabelText('Stop 020 waiting for 010')).toBeNull();
    // Nothing about the list moved either: same search, same highlight.
    expect(box).toHaveValue('010');
    expect(box.getAttribute('aria-activedescendant')).toBe(highlighted);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('Cmd+Enter in the folded cell’s open @ list assigns nobody', async () => {
    // Proof: the consume guard removed from the folded cell's `onKeyDown`,
    // this failed on `expected [ 'assign w2 role-dev person1' ] to deeply
    // equal []`. Watched, 2026-08-08.
    const api = await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const first = await screen.findByLabelText('Dev estimate for 010');
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: '@Kateryna' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-folded-assignee="role-dev"]')).not.toBeNull();
    });
    fireEvent.blur(first);
    const written = watchPeopleWrites(api);

    const box = screen.getByLabelText<HTMLInputElement>('Dev estimate for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '@Kat' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    expect(written).toEqual([]);
    expect(await api.listPeople()).toHaveLength(1);
    expect(rowFor('020').querySelector('[data-folded-assignee="role-dev"]')).toBeNull();
    // The mention was not taken out of the box, because nothing was taken.
    expect(box.value).toBe('@Kat');
  });

  itDom('Alt+arrows in the folded cell’s open @ list move no row', async () => {
    // The one open list wired to `onAltMove`, and the finding's second half: a
    // structural move is not something an open people picker may perform.
    //
    // Proof: the consume guard removed, this failed on `expected [ 'Strip',
    // 'Paint', 'Sand' ] to deeply equal [ 'Strip', 'Sand', 'Paint' ]` — the
    // row reordered under a half-typed name search. Watched, 2026-08-08.
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const box = await screen.findByLabelText<HTMLInputElement>('Dev estimate for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '@Ada' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    const down = chordInto(box, 'ArrowDown', { alt: true });
    await letTheLoopRun();
    const right = chordInto(box, 'ArrowRight', { alt: true });
    await letTheLoopRun();

    expect(down.defaultPrevented).toBe(true);
    expect(right.defaultPrevented).toBe(true);
    // Neither moved among its siblings nor indented under one.
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(box.value).toBe('@Ada');
  });

  itDom('every chord is inert on a mention that has nobody to offer', async () => {
    // The keyboard's half of agy round 3, finding 7, which round 4 caught: the
    // card learned to read the mention and this branch was still counting the
    // entries. A deployment with nobody in it answers a bare `@` with no
    // entries at all, so `options.length > 0` was false, the `else` handed the
    // keyboard back, and Alt+ArrowDown moved the row while a mention owned the
    // cell — the exact fault round 2 wrote this guard for, through the one hole
    // it left open. The hole predates this change; it is on the merge-base at
    // `75d01a8`, where the same branch counts entries. What is this change's is
    // that the two guards diverged, and so is the fix.
    //
    // Proof: the branch put back to `options.length > 0`, this failed on
    // `expected [ 'Strip', 'Paint', 'Sand' ] to deeply equal [ 'Strip', 'Sand',
    // 'Paint' ]` — the row reordered under a half-typed mention. Watched,
    // 2026-08-09.
    const api = await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const box = await screen.findByLabelText<HTMLInputElement>('Dev estimate for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '@' } });

    // Nobody to offer, so no list is drawn — which is the state the old branch
    // read as "no mention here". The mention is open all the same.
    expect(screen.queryByRole('listbox', { name: 'Dev assignee for 020' })).toBeNull();

    const down = chordInto(box, 'ArrowDown', { alt: true });
    await letTheLoopRun();
    const created = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(down.defaultPrevented).toBe(true);
    expect(created.defaultPrevented).toBe(true);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(api.rows).toHaveLength(3);
    expect(box.value).toBe('@');
  });

  itDom('every chord is inert while a row’s ⋯ menu is open', async () => {
    const api = await threeRoots();
    openRowMenu('020');
    const item = screen.getByRole('menuitem', { name: 'Duplicate' });

    newItem(item);
    nextOrCreate(item);
    armDelete(item);

    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(armedRow()).toBeNull();
    expect(api.rows).toHaveLength(3);
  });

  itDom('⌘+Z is inert while a row’s ⋯ menu is open, and works again once it closes', async () => {
    // `CONTEXT.md`: the ⋯ menu *"owns the keyboard while it is open"*. The
    // modal path held the page's own chords back and the menu path did not, so
    // ⌘+Z through an open menu ran an undo behind it — the menu stayed open,
    // the toast read `Undid: rename “Roof it”` and a row two down came back
    // off. Observed live twice on 2026-08-09, with `[role="menu"]` asserted in
    // the DOM at the moment of the keypress.
    //
    // Proof: `usePageShortcutsSuspended(open)` pinned to `false` in
    // `ActionsMenu`, this failed on `expected [ 'undo' ] to deeply equal []`.
    // Watched, 2026-08-09.
    const api = await threeRoots();
    api.answerStackWith({ ok: true, done: 'rename “Strip”', detail: null });
    openRowMenu('020');
    const item = screen.getByRole('menuitem', { name: 'Duplicate' });

    fireEvent.keyDown(item, { key: 'z', ctrlKey: true });

    expect(api.stackCalls).toEqual([]);
    expect(toastTexts()).toEqual([]);
    // Still open: the chord was swallowed, not turned into a dismissal.
    expect(screen.getByRole('menu', { name: 'Actions for 020' })).toBeDefined();

    // And the other half, which is what makes the first half a rule rather than
    // an undo that never worked: Escape closes the menu and the chord is the
    // page's again.
    fireEvent.keyDown(item, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('table'), { key: 'z', ctrlKey: true });

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['undo']);
    });
  });

  itDom('the date cell answers the chords, and keeps its own arrows', async () => {
    const api = await threeRoots();
    typeIntoDate('Project start date', '2026-08-10');
    const box = await screen.findByLabelText('Earliest start for 020');
    await waitFor(() => {
      expect(box).toHaveProperty('disabled', false);
    });
    box.focus();

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(api.rows).toHaveLength(4);
  });
});

/**
 * The eight keys that must work from **every** cell, pickers open included.
 *
 * The cheat sheet promises Ctrl+H/J/K/L "between cells" and the Alt+arrows
 * "from any cell and any caret position", both unqualified — and three cell
 * classes answered none of them. Every cell here is asserted in all four
 * directions, once per class, because "the chords are wired" was true of the
 * Name cell and false of these while one sentence covered both.
 *
 * The picker cells are asserted with their list **open**, which is the state
 * a reader is always in: focusing either box opens its list, so a rule that
 * only holds while the list is shut is a rule that never holds. The chords
 * that create and destroy are still the open list's to swallow — that half is
 * `every chord that makes or destroys a row is inert while … is open`.
 */
describe('the chords reach the picker cells and the date cell', () => {
  const chord = (box: Element, key: string, modifiers: { ctrl?: boolean; alt?: boolean }) =>
    fireEvent.keyDown(box, {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
    });

  /** The Depends on box of one row, with its list open — which is how focus leaves it. */
  const openDepends = async (number: string): Promise<HTMLElement> => {
    const box = screen.getByLabelText(`Add a dependency to ${number}`);
    box.focus();
    fireEvent.focus(box);
    await screen.findByRole('listbox', { name: `Work items ${number} can depend on` });
    return box;
  };

  /**
   * Three roots and one team, which is what makes the Service/team box open on
   * a bare focus: a picker with nothing to offer and nothing typed stays shut,
   * and a plan with no teams in it is not the state this block is about.
   */
  const threeRootsAndATeam = async () => {
    const api = await threeRoots();
    const box = screen.getByLabelText('Service or team for 010');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Platform' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Service or team for 010')).toHaveProperty('value', 'Platform');
    });
    fireEvent.blur(box);
    return api;
  };

  /**
   * One row's Service/team box.
   *
   * By role, because an open `CreatablePicker` gives its listbox the same
   * accessible name as its input — two elements answer to `Service or team for
   * 020` while the list is up, and only one of them is the box.
   */
  const teamBox = (number: string): HTMLElement =>
    screen.getByRole('combobox', { name: `Service or team for ${number}` });

  /** The Service/team box of one row, with its list open. */
  const openTeam = async (number: string): Promise<HTMLElement> => {
    const box = teamBox(number);
    box.focus();
    fireEvent.focus(box);
    await screen.findByRole('listbox', { name: `Service or team for ${number}` });
    return box;
  };

  /** A plan on a calendar, so the earliest-start cells are not disabled. */
  const datedThreeRoots = async () => {
    const api = await threeRoots();
    typeIntoDate('Project start date', '2026-08-10');
    await waitFor(() => {
      expect(screen.getByLabelText('Earliest start for 020')).toHaveProperty('disabled', false);
    });
    return api;
  };

  itDom('Ctrl+H and Ctrl+L leave the Depends on cell with its list open', async () => {
    await threeRoots();
    const box = await openDepends('020');

    chord(box, 'h', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });

    const back = await openDepends('020');
    chord(back, 'l', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Priority for 020'));
    });
  });

  itDom('Ctrl+J and Ctrl+K walk the Depends on column with its list open', async () => {
    await threeRoots();
    const box = await openDepends('020');

    chord(box, 'j', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 030'));
    });

    const back = await openDepends('020');
    chord(back, 'k', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 010'));
    });
  });

  itDom('Alt+↑ and Alt+↓ move the row from the Depends on cell', async () => {
    await threeRoots();
    const box = await openDepends('010');

    chord(box, 'ArrowDown', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });

    const up = await openDepends('020');
    chord(up, 'ArrowUp', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from the Depends on cell', async () => {
    await threeRoots();
    const box = await openDepends('020');

    chord(box, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const out = await openDepends('010.1');
    chord(out, 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Ctrl+H and Ctrl+L leave the Service/team cell with its list open', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('020');

    chord(box, 'h', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Priority for 020'));
    });

    const back = await openTeam('020');
    chord(back, 'l', { ctrl: true });

    // The In-parallel cell, which `capacity-ui` put between the team and the
    // first role: the chord goes to the next cell of the row, whatever that is.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('People at once for 020'));
    });
  });

  itDom('Ctrl+J and Ctrl+K walk the Service/team column with its list open', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('020');

    chord(box, 'j', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(teamBox('030'));
    });

    const back = await openTeam('020');
    chord(back, 'k', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(teamBox('010'));
    });
  });

  itDom('Alt+↑ and Alt+↓ move the row from the Service/team cell', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('010');

    chord(box, 'ArrowDown', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });

    const up = await openTeam('020');
    chord(up, 'ArrowUp', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from the Service/team cell', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('020');

    chord(box, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const out = await openTeam('010.1');
    chord(out, 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from an assignee cell', async () => {
    // The third `CreatablePicker` in this table, and the reason the fix is that
    // component's rather than the Service/team column's.
    await threeRoots();
    const box = screen.getByLabelText('Dev assignee for 020');
    box.focus();
    fireEvent.focus(box);

    chord(box, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const out = screen.getByLabelText('Dev assignee for 010.1');
    out.focus();
    fireEvent.focus(out);
    chord(out, 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Ctrl+H and Ctrl+L move out of the Not before cell', async () => {
    await datedThreeRoots();
    const box = screen.getByLabelText('Earliest start for 020');
    box.focus();

    chord(box, 'h', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('QA estimate for 020'));
    });
  });

  itDom('Ctrl+J and Ctrl+K walk the Not before column', async () => {
    await datedThreeRoots();
    const box = screen.getByLabelText('Earliest start for 020');
    box.focus();

    chord(box, 'j', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 030'));
    });

    const back = screen.getByLabelText('Earliest start for 020');
    back.focus();
    chord(back, 'k', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));
    });
  });

  itDom('Alt+↑ and Alt+↓ move the row from the Not before cell', async () => {
    await datedThreeRoots();

    chord(screen.getByLabelText('Earliest start for 010'), 'ArrowDown', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });

    chord(screen.getByLabelText('Earliest start for 020'), 'ArrowUp', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from the Not before cell', async () => {
    await datedThreeRoots();

    chord(screen.getByLabelText('Earliest start for 020'), 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    chord(screen.getByLabelText('Earliest start for 010.1'), 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Alt+→ restructures the row from an open Not before editor', async () => {
    // The editor is a different element from the cell at rest, wired through
    // `DateField` — a cell class the at-rest tests above cannot speak for.
    await datedThreeRoots();
    const editor = openNotBefore('020');

    chord(editor, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
  });
});

describe('a phase changing, and what the table does about it', () => {
  /** The Phases surface, from the toolbar button somebody really clicks. */
  const openPhases = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Phases' }));
  };

  const closePhases = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  };

  /*
   * Both helpers wait for the **dialog's** own list to settle before closing,
   * and only then look at the table. An open Radix dialog puts `aria-hidden`
   * on everything else in the document, so a query for a column header while
   * the surface is up answers "not there" whatever the table is really showing
   * — a wait that could never fail, and it was written that way first.
   */

  /** Adds a phase through the dialog and waits for the column to arrive. */
  async function addPhase(name: string): Promise<void> {
    openPhases();
    fireEvent.change(screen.getByLabelText('New phase'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    await screen.findByRole('button', { name: `Remove ${name}` });
    closePhases();
    await screen.findByRole('button', { name: `Unfold ${name} estimates` });
  }

  /** Removes a phase through the dialog and waits for the column to go. */
  async function removePhase(name: string): Promise<void> {
    openPhases();
    fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: `Remove ${name}` })).toBeNull();
    });
    closePhases();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: `Unfold ${name} estimates` })).toBeNull();
    });
  }

  /** One empty root row, with both seeded phases still there. */
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  itDom('takes the columns of a phase that has gone, unfolded and all', async () => {
    // The accordion is left holding `role-qa` on purpose — see
    // `settleAgainstRoles`. Nothing can observe that, because `columns` is
    // built by mapping over `roles` and a dead id selects no role to unfold;
    // what this measures is the columns following the phases.
    // Proof: `setRoles` made to keep whatever it first loaded, so a later read
    // could not take a phase away, this failed in `removePhase` on `expected
    // <button …(2)></button> to be null` — the removed phase's fold button
    // still in the table's header. Watched, 2026-08-09.
    await oneRow();
    unfoldRole('QA');
    expect(screen.getByRole('table').style.minWidth).toBe('1483px');

    await removePhase('QA');

    // One phase left, folded: 839px of fixed columns (827 → 839 in
    // `number-column-widen`, 93 → 105 in `COLUMN_WIDTHS`), 200 for Name, 96
    // for it.
    expect(screen.getByRole('table').style.minWidth).toBe('1135px');
    expect(screen.queryByLabelText('QA optimistic for 010')).toBeNull();
  });

  itDom('drops a half-typed figure for a phase that has gone', async () => {
    // Observable because a pending draft **vetoes** the backspace removal of an
    // otherwise empty row: typing counts as content. A draft for a phase that
    // no longer exists would go on vetoing forever, over a figure nobody can
    // see, reach or finish.
    await oneRow();
    unfoldRole('QA');
    const box = screen.getByLabelText<HTMLInputElement>('QA optimistic for 010');
    fireEvent.change(box, { target: { value: '5' } });
    fireEvent.blur(box);

    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });
    // Still there: the draft is content, and this is the state the assertion
    // below is measured against.
    expect(numbersOnScreen()).toEqual(['010']);

    await removePhase('QA');

    const after = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    after.setSelectionRange(0, 0);
    fireEvent.keyDown(after, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
  });

  itDom('keeps the drafts of the phases that stayed', async () => {
    // The other half, and the reason the sanitizer is a filter rather than a
    // clear: a phase going must not take the figures of the ones that remain.
    await oneRow();
    unfoldRole('Dev');
    const dev = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(dev, { target: { value: '7' } });
    fireEvent.blur(dev);

    await removePhase('QA');

    // Dev is still unfolded — it is still there, so the set keeps it — and its
    // three boxes are new elements after the rebuild.
    expect(screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010').value).toBe('7');
    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('rebuilds nothing when the phases came back the same', async () => {
    // A phase change is the **one** sanctioned remount, and this is the other
    // side of that sentence: a read that changed no phase must cost nobody
    // their place. `roles` is `columns`' dependency, so an array replaced on
    // every read rebuilds every column definition and unmounts every cell.
    // Proof: `sameRoles` made to answer false, this failed on `expected <body
    // style><div>…(1)</div></body> to be <input …(5)></input>` — the focused
    // box unmounted by a reread that changed nothing. Watched, 2026-08-09.
    await oneRow();
    unfoldRole('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    box.focus();

    // A reread of the whole project, which is what any edit and any socket
    // event makes this table do.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Freeze numbering' }));
      await new Promise((resume) => setTimeout(resume, 0));
    });

    expect(document.activeElement).toBe(box);
  });

  itDom('keeps a draft be-01 refused when a new phase rebuilds every column', async () => {
    // The one sanctioned remount: a phase change really does rebuild the
    // columns, and every cell in the table is a new element afterwards. The
    // focus goes with it, by design — but a refused draft is text that exists
    // nowhere else, and `CellInput`'s rule 4 held it in a ref that dies with
    // the component.
    const api = await oneRow();
    api.patch = () => Promise.reject(new Error('forbidden'));
    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(name, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });

    await addPhase('Design');

    expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 010').value).toBe(
      'Strip the wiring',
    );
  });

  itDom('forgets a refusal held for a phase that has gone', async () => {
    // The held refusals are keyed by cell, and a cell of a phase that no longer
    // exists is one nobody can ever resolve — it would sit in the map for the
    // life of the page.
    const api = await oneRow();
    api.setEstimate = () => Promise.reject(new Error('forbidden'));
    const folded = screen.getByLabelText<HTMLInputElement>('QA estimate for 010');
    fireEvent.change(folded, { target: { value: '9' } });
    fireEvent.blur(folded);
    await waitFor(() => {
      expect(refusedDraftFor('w1::role-qa-final')).toBe('9');
    });

    await removePhase('QA');

    expect(refusedDraftFor('w1::role-qa-final')).toBeUndefined();
  });
});

describe('narrowing the plan by facet', () => {
  /**
   * The `finding a work item in the tree` plan, with facts on it:
   *
   * ```
   * 010     Strip the walls   Billing, Ada on Dev, priority 10 (Critical)
   *  010.1   Sockets
   *   010.1.1 Back boxes      Wiring
   *  010.2   Skirting
   * 020     Paint             Dev and QA estimated
   *  020.1   Undercoat
   * ```
   *
   * Two teams and two people in the directory rather than one each, because the
   * question a facet control gets wrong is which of them it offers: the
   * directory holds every team in the deployment and this is one plan.
   */
  async function aFacetedPlan(): Promise<ProjectApi & { rows: WorkItemView[] }> {
    const api = fakeApi();
    const strip = await api.create('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    const sockets = await api.create('p1', { parentId: strip.id, afterId: null, name: 'Sockets' });
    const back = await api.create('p1', {
      parentId: sockets.id,
      afterId: null,
      name: 'Back boxes',
    });
    await api.create('p1', { parentId: strip.id, afterId: sockets.id, name: 'Skirting' });
    const paint = await api.create('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    await api.create('p1', { parentId: paint.id, afterId: null, name: 'Undercoat' });

    const billing = await api.addTeam('Billing');
    const wiring = await api.addTeam('Wiring');
    // Only one of the two is on the plan, which is what the control must offer.
    await api.patch(strip.id, { serviceTeamId: billing.id });
    await api.patch(back.id, { serviceTeamId: wiring.id });
    const ada = await api.addPerson('Ada', []);
    await api.addPerson('Bo', []);
    await api.assign(strip.id, DEV.id, ada.id);
    await api.patch(strip.id, { priority: 10 });
    await api.setEstimate(paint.id, DEV.id, { optimistic: 1, realistic: 2, pessimistic: 3 });
    await api.setEstimate(paint.id, QA.id, { optimistic: 1, realistic: 2, pessimistic: 3 });

    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    return api;
  }

  const openFilters = () => {
    fireEvent.click(screen.getByText(/^Filters/));
  };

  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };

  const find = (typed: string) => {
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Find'), {
      target: { value: typed },
    });
  };

  itDom('narrows to the rows carrying a team, and keeps the rows that place them', async () => {
    await aFacetedPlan();
    openFilters();

    tick('Team Wiring');

    // `010` and `010.1` are context, exactly as they are under a typed name:
    // a hit three levels down with no ancestry is a tree lying about itself.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
    expect(screen.getByLabelText('Name of 010.1.1').dataset['match']).toBe('true');
    expect(screen.getByLabelText('Name of 010.1').dataset['match']).toBeUndefined();
  });

  itDom('does not bring the subtree a typed name would bring', async () => {
    // R10 §4 and §9's Q2, Dany 2026-08-17: `Strip` means the branch, and
    // `assignee = Ada` means the rows Ada is on. The same row matched both
    // ways, and only one of them is a request for the work underneath.
    //
    // Ada and not `Team Billing`, which is what this was first written with and
    // is the wrong facet to ask the question through: the team facet reads the
    // **effective** team, so `010.1` and `010.2` carry Billing on their own
    // account by inheritance and stay on screen for a reason that has nothing
    // to do with rule 3. An assignee does not inherit — `row.assignees` is the
    // row's own — so what is left when Ada is ticked is rule 3 and nothing else.
    await aFacetedPlan();
    find('strip');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);

    find('');
    openFilters();
    tick('Assignee Ada');

    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('keeps the rows that inherit a ticked team, which is not rule 3', async () => {
    // The other half of the pair above, and the trap §8.5 names: a leaf drawing
    // its slots from an ancestor's pool is that team's work, so it answers the
    // facet itself. `010.1.1` is out because it carries a team of its own —
    // most-specific-wins, `effectiveTeamsOf`'s rule, not the filter's.
    await aFacetedPlan();
    openFilters();

    tick('Team Billing');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
  });

  itDom('drops the subtree the moment a facet joins a name that was bringing one', async () => {
    await aFacetedPlan();
    find('strip');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);

    openFilters();
    tick('Team Billing');

    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('takes a person on any phase, a band by its name, and a phase’s estimate', async () => {
    await aFacetedPlan();
    openFilters();

    tick('Assignee Ada');
    expect(numbersOnScreen()).toEqual(['010']);
    tick('Assignee Ada');

    tick('Priority Critical');
    expect(numbersOnScreen()).toEqual(['010']);
    tick('Priority Critical');

    tick('Estimated for QA');
    expect(numbersOnScreen()).toEqual(['020']);
  });

  itDom('takes only the rows answering every facet ticked', async () => {
    await aFacetedPlan();
    openFilters();

    tick('Team Billing');
    tick('Estimated for Dev');

    // `010` is Billing's and has no estimate; `020` has both estimates and no
    // team. Nothing answers both, and the table says so rather than showing a
    // plan that looks emptied.
    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByText('0 of 6 rows')).toBeInTheDocument();
    expect(screen.getByText('No rows match these filters')).toBeInTheDocument();
  });

  itDom('offers only the teams and the people this plan carries', async () => {
    // The directory holds `Wiring` **and** `Billing`, `Ada` **and** `Bo`; a
    // checkbox for a value no row has is a filter whose only answer is an
    // empty table.
    await aFacetedPlan();
    openFilters();

    expect(screen.getByLabelText('Team Billing')).toBeInTheDocument();
    expect(screen.getByLabelText('Team Wiring')).toBeInTheDocument();
    expect(screen.getByLabelText('Assignee Ada')).toBeInTheDocument();
    expect(screen.queryByLabelText('Assignee Bo')).toBeNull();
    // Nobody has been given `Low`, so the ladder's other four rungs are not
    // offered either.
    expect(screen.getByLabelText('Priority Critical')).toBeInTheDocument();
    expect(screen.queryByLabelText('Priority Low')).toBeNull();
  });

  itDom('says how many facets are ticked, and clears them all in one', async () => {
    await aFacetedPlan();
    openFilters();
    tick('Team Billing');
    tick('Priority Critical');
    expect(screen.getByText('Filters (2)')).toBeInTheDocument();

    click('Clear filters');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    expect(screen.getByText('Filters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  itDom('leaves the Find box alone when the ticks are cleared', async () => {
    // Two gestures, and each undoes its own half: Escape empties the box, and
    // this unticks the boxes. One control undoing the other's work is how a
    // reader loses a query they were still using.
    await aFacetedPlan();
    find('paint');
    openFilters();
    tick('Estimated for QA');

    click('Clear filters');

    expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('paint');
    // `020.1 Undercoat` back with it, and that is the second thing this proves:
    // with the ticks gone the filter is a typed name again, so rule 3 is in
    // force again and `Paint` brings the work it is a heading for.
    expect(numbersOnScreen()).toEqual(['020', '020.1']);
  });

  itDom('stands the expansion controls down while a facet is on with nothing typed', async () => {
    // The controls read one flag, and until R10 that flag was the query alone:
    // a facet-only filter would have left `Collapse all` live over an
    // expansion the filter owns, and the triangles on rows the filter opened.
    await aFacetedPlan();
    openFilters();

    tick('Team Wiring');

    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Collapse 010' })).toBeNull();
  });

  itDom('narrows the chart with the table, because they are one list', async () => {
    // The half of Dany's sentence that reads like the hard part — "must affect
    // the gantt chart to only show what matches with the filter" — and it costs
    // nothing, because `shownRows` is what the panel is drawn from and a facet
    // narrows the same list a name already did (`gantt-panel.test.tsx`'s
    // `draws exactly the rows a search narrowed the plan to`, watched
    // 2026-08-09). Asserted here anyway: "for free" is a claim about a seam,
    // and a seam nothing holds is how the next change quietly re-routes it.
    await aFacetedPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');

    openFilters();
    tick('Team Wiring');

    expect(
      [...document.querySelectorAll('[data-gantt-label]')].map((label) => label.textContent),
    ).toEqual(['010 - Strip the walls', '010.1 - Sockets', '010.1.1 - Back boxes']);
  });

  itDom('keeps offering a ticked team after the last row carrying it has gone', async () => {
    // The tree refetches on everybody's edit, so the row a tick is aimed at can
    // leave while the tick is still in force. Dropping the box then would
    // narrow the plan to nothing with nothing on screen to untick.
    await aFacetedPlan();
    openFilters();
    tick('Team Wiring');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);

    takeRowAction('010.1.1', 'Delete');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
    expect(screen.getByLabelText('Team Wiring')).toBeChecked();
  });

  itDom('is empty on the next load, because an ad-hoc filter is not remembered', async () => {
    // R10 §9's Q6, Dany 2026-08-17: the plan you open is the whole plan. A
    // filter restored from a session nobody remembers setting is the "my rows
    // are gone" report, and it is the likeliest thing this change could break.
    const api = await aFacetedPlan();
    openFilters();
    tick('Team Wiring');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);

    cleanup();
    render(<WbsTable projectId="p1" api={api} />);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    openFilters();
    expect(screen.getByLabelText('Team Wiring')).not.toBeChecked();
  });
});

describe('narrowing the plan by service, and by the two mismatch signals', () => {
  /**
   * The faceted plan again with the third dimension on it, and the directory
   * facts the two signals are asked against:
   *
   * ```
   * 010     Strip the walls   team Billing, service Checkout, Ada on Dev
   *  010.1   Sockets          inherits both
   *   010.1.1 Back boxes      team Wiring, inherits Checkout
   *  010.2   Skirting         inherits both
   * 020     Paint             nothing
   *  020.1   Undercoat        nothing
   * ```
   *
   * `Wiring` owns `Checkout` and `Billing` owns nothing, so `010` is built by a
   * non-owner and `010.1.1` — the row whose own team is the owner — is not.
   * Ada belongs to `Wiring` and is on `010`, whose effective team is `Billing`,
   * so she is assigned outside it. Both facts are deliberately **not** true of
   * every row: a signal that flagged the whole plan would pass a test that only
   * counted flags.
   *
   * Two services in the directory and one on the plan, the same trap the team
   * facet's fixture sets: the control must offer what the plan carries, not
   * what the deployment knows about.
   */
  async function aServicedPlan(): Promise<
    ReturnType<typeof fakeApi> & {
      checkout: string;
      ledger: string;
      strip: string;
      billing: string;
      wiring: string;
    }
  > {
    const api = fakeApi();
    const strip = await api.create('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    const sockets = await api.create('p1', { parentId: strip.id, afterId: null, name: 'Sockets' });
    const back = await api.create('p1', {
      parentId: sockets.id,
      afterId: null,
      name: 'Back boxes',
    });
    await api.create('p1', { parentId: strip.id, afterId: sockets.id, name: 'Skirting' });
    const paint = await api.create('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    await api.create('p1', { parentId: paint.id, afterId: null, name: 'Undercoat' });

    const billing = await api.addTeam('Billing');
    const wiring = await api.addTeam('Wiring');
    await api.patch(strip.id, { serviceTeamId: billing.id });
    await api.patch(back.id, { serviceTeamId: wiring.id });

    const checkout = api.addService('Checkout');
    // In the directory and on no row — what the facet must not offer. One case
    // below puts it on `Strip` as a **second** service, and does so itself
    // rather than here, so every other case keeps the unlabelled `Ledger` this
    // fixture exists to offer.
    const ledger = api.addService('Ledger');
    api.labelWithService(strip.id, [checkout.id]);

    const ada = await api.addPerson('Ada', [wiring.id]);
    await api.assign(strip.id, DEV.id, ada.id);

    return Object.assign(api, {
      checkout: checkout.id,
      // The unlabelled service and the labelled row, handed back so the
      // two-service case can state its own labelling without this fixture
      // carrying it for every other case.
      ledger: ledger.id,
      strip: strip.id,
      billing: billing.id,
      wiring: wiring.id,
    });
  }

  /** Draw it, and wait for the six rows the fixture builds. */
  async function shown(api: ProjectApi): Promise<void> {
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    fireEvent.click(screen.getByText(/^Filters/));
  }

  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };

  itDom(
    'offers the services the plan carries, by name, and not the rest of the directory',
    async () => {
      const api = await aServicedPlan();
      await shown(api);

      expect(screen.getByLabelText('Service Checkout')).toBeInTheDocument();
      // `Ledger` is in the directory and on nothing here. Offering it would be a
      // box that provably empties the table — `optionsFor`'s whole argument.
      expect(screen.queryByLabelText('Service Ledger')).toBeNull();
    },
  );

  itDom('finds a row by the second service it delivers, which is task 10.2', async () => {
    // **The case 10.2's watched red drives, and it is the only one that can.**
    // Every other service case on this surface states one service per row, and a
    // row with one member reads identically through a set and through the
    // singleton fold the store used to force — so a fold left in would pass all
    // of them.
    //
    // `Strip` delivers `Checkout` **and** `Ledger`. Ticking `Ledger` must find
    // it. Injected on h2puni and watched red, chunk 15: the deleted `.map` in
    // `wbs-table.tsx` restored as `serviceIds.slice(0, 1)` — **1 fail, this
    // case, 1558 pass**. It failed one step earlier than written above:
    // `Unable to find a label with the text of: Service Ledger`. The facet is
    // built from the effective reading, so a fold does not merely narrow to
    // nothing — the second service never becomes a facet value at all, and the
    // box a user would tick is not on screen.
    const api = await aServicedPlan();
    api.labelWithService(api.strip, [api.checkout, api.ledger]);
    await shown(api);

    tick('Service Ledger');

    // The whole branch, because the three rows under `Strip` inherit both of its
    // services — the set is inherited whole, not by its first member.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
  });

  itDom('keeps the rows that inherit a ticked service, which is task 6.2', async () => {
    // **The case 6.2's watched red drives.** Only `010` states `Checkout`; the
    // three rows under it answer to it through `effectiveServicesOf`, and
    // `020`/`020.1` do not. Point the predicate at `row.serviceIds` — the row's
    // own stated set, a column until task 10.2 — instead of the effective reading and this drops to
    // `['010']`, which is why the fault could not be observed until a control
    // existed to tick. Injected on h2puni and watched red, chunk 9.
    const api = await aServicedPlan();
    await shown(api);

    tick('Service Checkout');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
    expect(screen.getByLabelText('Name of 010.2').dataset['match']).toBe('true');
  });

  itDom(
    'stands both signal boxes down, with the reason, while the directory says nothing',
    async () => {
      // The design's first risk. A deployment ships with an empty ownership map
      // and nobody in a team, and in that state both signals answer `false` for
      // every row — which is "nobody has said", not "nothing is wrong". An
      // enabled box answering the second question is how a reader concludes the
      // feature is broken.
      const api = fakeApi();
      await api.create('p1', { parentId: null, afterId: null, name: 'Strip the walls' });
      render(<WbsTable projectId="p1" api={api} />);
      await waitFor(() => {
        expect(numbersOnScreen()).toEqual(['010']);
      });
      fireEvent.click(screen.getByText(/^Filters/));

      const owner = screen.getByLabelText('Built by non-owner only');
      const outside = screen.getByLabelText('Assigned outside the team only');
      expect(owner).toBeDisabled();
      expect(outside).toBeDisabled();
      // Followed by hand rather than through `toHaveAccessibleDescription`:
      // jest-dom computes that through `dom-accessibility-api`, and a matcher
      // that quietly answers `''` on both boxes would pass this test in either
      // state. `describedBy` fails loudly instead — a missing attribute or a
      // dangling id throws here rather than reading as an empty description.
      const describedBy = (box: HTMLElement): string => {
        const id = box.getAttribute('aria-describedby');
        expect(id).toBeTruthy();
        const said = document.getElementById(id!);
        expect(said).not.toBeNull();
        return said?.textContent ?? '';
      };
      expect(describedBy(owner)).toMatch(/No team owns a service yet/);
      expect(describedBy(outside)).toMatch(/Nobody belongs to a team yet/);
      // Mouse readers get the same sentence, and it is the only place a hint
      // fits at this panel width.
      expect(owner.closest('label')).toHaveAttribute(
        'title',
        expect.stringMatching(/No team owns/),
      );
    },
  );

  itDom('takes teams from a be-01 that has never heard of services', async () => {
    // The blue/green window, and this one is not hypothetical: three fixtures
    // in this repo already answer `listTeams` with `{ id, name }`, and the
    // first version of `ownershipKnown` threw `Cannot read properties of
    // undefined (reading 'length')` on all of them — a white screen for the
    // length of a deploy, in the render, not in a test-only shape.
    const api = await aServicedPlan();
    const older: ProjectApi = {
      ...api,
      listTeams: () =>
        Promise.resolve([
          { id: api.billing, name: 'Billing' },
          { id: api.wiring, name: 'Wiring' },
        ]),
    };
    await shown(older);

    // Drawn at all is most of the claim; the box is down because a server that
    // has never heard of services cannot have been told who owns one.
    expect(screen.getByLabelText('Built by non-owner only')).toBeDisabled();
  });

  itDom('narrows to the rows a non-owner is building, and not to every labelled row', async () => {
    const api = await aServicedPlan();
    api.ownService(api.wiring, api.checkout);
    await shown(api);

    tick('Built by non-owner only');

    // `010.1.1` carries `Wiring` itself and `Wiring` owns `Checkout`, so the
    // row nearest the fault is the one **not** flagged. Without it in the
    // fixture this assertion would pass over a signal that flagged everything
    // wearing a service — chunk 5's over-broad-usage lesson, one dimension on.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
  });

  itDom('narrows to the rows somebody outside the team is on', async () => {
    const api = await aServicedPlan();
    await shown(api);

    tick('Assigned outside the team only');

    // Ada is in `Wiring` and `010`'s effective team is `Billing`. The rows
    // under it inherit the team but not the assignee — `row.assignees` is the
    // row's own — so one row answers, not the branch.
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('marks the service cell of a row a non-owner is building, and says why', async () => {
    // **Task 7.2's first marker.** The facet cases above prove the rule; this
    // proves it reaches the cell it is about, with the sentence on it. A mark
    // that cannot say why is a mystery rather than a signal — 7.2's own words,
    // and the reason the whole string is asserted rather than its presence.
    const api = await aServicedPlan();
    api.ownService(api.wiring, api.checkout);
    await shown(api);

    const said =
      'Built by a non-owner: Billing does not own Checkout.' +
      ' Nothing is blocked — the plan is recording this, not refusing it.';
    const mark = rowFor('010').querySelector('[data-mismatch="service"]');
    expect(mark?.getAttribute('title')).toBe(said);
    // The same sentence to a reader with no pointer. `role="img"` and a label
    // rather than a `title` alone, which reaches a mouse only.
    expect(mark?.getAttribute('aria-label')).toBe(said);
    expect(mark?.getAttribute('role')).toBe('img');
    // `010.1.1` states `Wiring` itself, and `Wiring` owns `Checkout`: the row
    // nearest the fault is the one **not** marked. Without it this case would
    // pass over a marker that landed on every row wearing a service — chunk
    // 5's over-broad-usage lesson, on a third surface.
    expect(rowFor('010.1.1').querySelector('[data-mismatch="service"]')).toBeNull();
    // And it is the **effective** reading: `010.1` states no service of its own
    // and is marked, because what it inherits is what it is delivering.
    expect(rowFor('010.1').querySelector('[data-mismatch="service"]')).not.toBeNull();
  });

  itDom('names every offending service, and only the offending ones', async () => {
    // **The case the scope change needs and the only one that can drive it.**
    // Three services on the row, one of them owned: a sentence built from the
    // row's whole set names `Checkout` — which the team *does* own — and a
    // sentence taking the first offender names `Ledger` and drops `Search`.
    // Every other marker case here has one service, and one service reads
    // identically through either fault.
    const api = await aServicedPlan();
    const search = api.addService('Search');
    api.labelWithService(api.strip, [api.checkout, api.ledger, search.id]);
    api.ownService(api.billing, api.checkout);
    await shown(api);

    const said = rowFor('010').querySelector('[data-mismatch="service"]')?.getAttribute('title');
    expect(said).toContain('Billing does not own Ledger and Search.');
    // Said out loud, because it is half the claim: the owned service is not in
    // the sentence, so a reader is sent to the two that need looking at.
    expect(said).not.toContain('Checkout');
  });

  itDom('marks the assignee on a folded role, which is where every plan starts', async () => {
    // **Task 7.2's second marker, on the surface that is on screen by default.**
    // `unfoldedRoles` starts empty, so a marker living only in the unfolded `by`
    // column would be absent from every plan nobody has unfolded — the same
    // hiding this cell already refuses for a complaint.
    const api = await aServicedPlan();
    await shown(api);

    const said =
      'Assigned outside the team: Ada is not in Billing.' +
      ' Nothing is blocked — the plan is recording this, not refusing it.';
    const final = rowFor('010').querySelector('[data-final="role-dev"]');
    const mark = final?.querySelector('[data-mismatch="assignee"]');
    expect(mark?.getAttribute('aria-label')).toBe(said);
    // **No native `title` here**, unlike the service cell's mark: this cell's
    // one hint is its card, and a tooltip raced it over the same pixels
    // (2026-08-09). So the sentence moves to the card rather than being
    // dropped, and both halves of that are asserted.
    expect(mark?.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(final as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toContain('Ada is not in Billing');
    // The team is inherited down the branch and the assignee is not, so the
    // rows under `010` carry no mark. Absence flagging nothing, on screen.
    expect(rowFor('010.1').querySelector('[data-mismatch="assignee"]')).toBeNull();
  });

  itDom('keeps the assignee mark when the role is unfolded, with its own sentence', async () => {
    // The other half of the same claim: unfolding moves the assignee into a
    // column of its own, and a marker that lived only on the folded cell would
    // vanish exactly when somebody looked closer.
    const api = await aServicedPlan();
    await shown(api);

    fireEvent.click(screen.getByRole('button', { name: 'Unfold Dev estimates' }));

    const cell = screen.getByLabelText('Dev assignee for 010').closest('td');
    const mark = cell?.querySelector('[data-mismatch="assignee"]');
    // A `title` here, where the folded cell has none: this column has no card
    // to fight, so the pointer gets the sentence the way the service cell's
    // does.
    expect(mark?.getAttribute('title')).toContain('Ada is not in Billing');
  });

  itDom(
    'answers a pointer at every mark, by title or by the card that owns the hover',
    async () => {
      // **The case the three above cannot state between them.** Each of them
      // pins one mark's own attributes, so the pair drifting apart reads as two
      // green tests: 2026-08-22's cloud walk counted `title` in the DOM, found
      // the service mark carrying one and both assignee marks carrying `null`,
      // and filed it as one mark saying nothing to a pointer.
      //
      // It is not saying nothing — it is saying it through the card, because the
      // mark sits inside the cell whose hover opens that card. So the promise
      // worth asserting is the **outcome**, not the attribute: hover a mark, get
      // its sentence. Written over `querySelectorAll` rather than over two named
      // marks, so a third mark added anywhere on this row has to answer it too.
      //
      // Proof, three faults watched on h2puni 2026-08-22, one per way the pair
      // can drift. `title` dropped from the uncarded arm: `expected null to be
      // 'Built by a non-owner: Billing does no…'`. The card's sentence removed
      // (`folded-role-card.tsx`, the `doing?.outside` block): `expected 'Dev for
      // 010No estimate yetAdaDays as …' to contain 'Assigned outside the team:
      // Ada is not…'`. A `title` put back on the carded arm, which is the race
      // 2026-08-09 ended: `expected 'Assigned outside the team: Ada is not…' to
      // be null`. Three for three.
      const api = await aServicedPlan();
      api.ownService(api.wiring, api.checkout);
      await shown(api);

      const marks = [...rowFor('010').querySelectorAll('[data-mismatch]')];
      // Said out loud and by kind, because every assertion below is inside the
      // loop: a render that stopped drawing the marks would otherwise pass this
      // by having nothing left to check. One service mark, and two assignee
      // marks — Ada named on Dev and assumed onto QA.
      expect(marks.map((mark) => mark.getAttribute('data-mismatch')).sort()).toEqual([
        'assignee',
        'assignee',
        'service',
      ]);

      for (const mark of marks) {
        const note = mark.getAttribute('aria-label') ?? '';
        // The sentence exists at all before either route is asked about it.
        expect(note).toContain('Nothing is blocked — the plan is recording this, not refusing it.');
        const owner = mark.closest('[data-final]');
        if (owner === null) {
          // Nothing else owns this hover, so the mark carries the sentence
          // itself — and carries the **same** one, not a shorter cousin of it.
          expect(mark.getAttribute('title')).toBe(note);
          continue;
        }
        // A card owns the hover. Both halves: no `title` to race it, and the
        // sentence really is on the card the same hover opens.
        expect(mark.getAttribute('title')).toBeNull();
        fireEvent.mouseEnter(owner);
        expect(screen.getByRole('tooltip').textContent).toContain(note);
        fireEvent.mouseLeave(owner);
      }
    },
  );

  itDom('marks the phase nobody named, where the assumption puts them on it', async () => {
    // **The surface every other assignee case here walks straight past.** Ada is
    // named on Dev alone, so `doesEveryPhase` puts her on QA as an assumption,
    // and a phase the plan says she is doing is work assigned to her.
    //
    // Written during chunk 17's injection round, which is also how the branch
    // that used to serve it got deleted: `assigneeOn` carried a special arm for
    // the assumed case, F4 forced it off, and every case stayed green — because
    // an assumption is the row's own single stated assignee, so the ordinary
    // path had been answering it all along. The arm went; this case stays,
    // because nothing else asserts an assumed phase is marked at all.
    const api = await aServicedPlan();
    await shown(api);

    const qa = rowFor('010').querySelector('[data-final="role-qa"]');
    const mark = qa?.querySelector('[data-mismatch="assignee"]');
    // The same sentence as the named phase beside it. A phase the plan says she
    // is doing is work assigned to her, and a marker that went quiet exactly
    // where nobody has looked at the assignment would be quiet where it is most
    // needed.
    expect(mark?.getAttribute('aria-label')).toContain('Ada is not in Billing');
  });

  itDom('leaves a ticked signal live after somebody empties the map under it', async () => {
    // Ticked wins. Somebody in the directory clears the last owned service
    // while this reader is filtered by the signal: the map arrives empty on the
    // next refetch and the box would go down with the tick still in force — a
    // filter nobody can leave, an empty table and a greyed-out control that
    // emptied it. It stays live so it can be turned off, and turning it off
    // puts the plan back.
    const api = await aServicedPlan();
    api.ownService(api.wiring, api.checkout);
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    fireEvent.click(screen.getByText(/^Filters/));

    tick('Built by non-owner only');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);

    // Somebody else's directory edit, arriving the way every other one does.
    api.disownService(api.wiring, api.checkout);
    notify();
    await waitFor(() => {
      expect(screen.getByLabelText('Built by non-owner only')).toBeChecked();
    });

    const owner = screen.getByLabelText('Built by non-owner only');
    expect(owner).not.toBeDisabled();
    // **And the answer went the other way, which is the finding.** An empty
    // ownership map does not make the signal quiet: `builtByNonOwner` asks
    // whether one of the row's teams owns the service, and with nobody owning
    // anything the answer is "no" for every labelled row. Four of the six here
    // — the whole branch under `010`, `010.1.1` included, because `Wiring` has
    // just stopped owning `Checkout` too. That is the marker-on-most-of-a-plan
    // failure `label-mismatch.ts` argues against, arriving through the
    // directory rather than through the rule, and it is the real reason the box
    // is stood down while the map is empty.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
    fireEvent.click(owner);
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
  });
});

describe('saved views, per browser', () => {
  /**
   * Where this browser remembers `p1`'s saved views — the key F4 writes.
   */
  const KEY = 'wbs.views.p1';

  /**
   * ```
   * 010  Strip the walls   Billing
   * 020  Paint
   * ```
   *
   * One team on one row, which is enough to ask what a saved view stores and
   * what happens once the team it named is gone.
   */
  async function aPlanWithATeam(): Promise<ProjectApi & { rows: WorkItemView[] }> {
    const api = fakeApi();
    const strip = await api.create('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    await api.create('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    const billing = await api.addTeam('Billing');
    await api.patch(strip.id, { serviceTeamId: billing.id });

    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    return api;
  }

  const openFilters = () => {
    fireEvent.click(screen.getByText(/^Filters/));
  };
  const openViews = () => {
    fireEvent.click(screen.getByText(/^Views/));
  };
  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };
  const find = (typed: string) => {
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Find'), {
      target: { value: typed },
    });
  };
  const nameTheView = (typed: string) => {
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Name this view'), {
      target: { value: typed },
    });
  };

  itDom('offers no Save while nothing is filtered', async () => {
    // A view of the whole plan has nothing to be picked back to, since
    // opening the project already shows it — the same bargain `Clear
    // filters` makes over in `FilterFacets`.
    await aPlanWithATeam();
    openViews();

    nameTheView('Everything');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('remembers a view once something is actually filtered', async () => {
    await aPlanWithATeam();
    openFilters();
    tick('Team Billing');
    openViews();
    nameTheView('Billing only');
    click('Save');

    expect(screen.getByText('Views (1)')).toBeInTheDocument();
    expect(screen.getByText('Billing only')).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as {
      name: string;
      criteria: unknown;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Billing only');
    expect(stored[0].criteria).toMatchObject({ query: '', teamIds: [expect.any(String)] });
  });

  itDom('applies a saved view: the Find box and the ticks together, in one gesture', async () => {
    await aPlanWithATeam();
    find('paint');
    openFilters();
    tick('Team Billing');
    // `020` (Paint) answers the name but not the team, so nothing is on
    // screen — proving the saved criteria really is both halves together.
    expect(numbersOnScreen()).toEqual([]);
    openViews();
    nameTheView('Nothing');
    click('Save');

    // Leave the view for the whole plan, the same as a reader who moved on:
    // clear the box and untick the box the save just read. Both panels are
    // already open, so nothing here re-toggles either `<details>`.
    find('');
    tick('Team Billing');
    expect(numbersOnScreen()).toEqual(['010', '020']);

    fireEvent.click(screen.getByText('Nothing'));

    expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('paint');
    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByLabelText('Team Billing')).toBeChecked();
  });

  itDom('deletes a saved view, and forgets it in storage too', async () => {
    await aPlanWithATeam();
    find('strip');
    openViews();
    nameTheView('Strip');
    click('Save');
    expect(screen.getByText('Views (1)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete view Strip' }));

    expect(screen.queryByText('Strip')).toBeNull();
    expect(screen.getByText('Views')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual([]);
  });

  itDom('never writes a view merely by typing or ticking — only Save does', async () => {
    // The regression this change must not cause: an ad-hoc filter (R10 §9's
    // Q6) is a different state to `savedViews`, and F4 must not blur them —
    // ticking a box must not silently start a view nobody named.
    await aPlanWithATeam();
    find('strip');
    openFilters();
    tick('Team Billing');

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('is gone on the next load if never saved, but a saved view survives it', async () => {
    const api = await aPlanWithATeam();
    find('strip');
    openViews();
    nameTheView('Strip');
    click('Save');
    find('');

    cleanup();
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    // The ad-hoc half is gone, exactly as Q6 requires.
    expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('');
    // The named half is not — that is the whole point of F4.
    openViews();
    expect(screen.getByText('Strip')).toBeInTheDocument();
  });

  itDom('drops a hand-edited store that is not a list, and offers no views', async () => {
    localStorage.setItem(KEY, '{"not": "a list"}');
    await aPlanWithATeam();

    openViews();
    expect(screen.getByText('No saved views yet.')).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('drops one unusable saved view and keeps the rest', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: 'a',
          name: 'Good',
          criteria: {
            query: 'x',
            teamIds: [],
            assigneeIds: [],
            priorityBands: [],
            estimatedRoleIds: [],
            unestimated: false,
            critical: false,
          },
        },
        {
          id: 'b',
          name: '',
          criteria: {
            query: '',
            teamIds: [],
            assigneeIds: [],
            priorityBands: [],
            estimatedRoleIds: [],
            unestimated: false,
            critical: false,
          },
        },
        { id: 'c', criteria: {} },
      ]),
    );
    await aPlanWithATeam();

    openViews();
    expect(screen.getByText('Views (1)')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
  });

  itDom('a view naming a team since deleted narrows to nothing, not to a crash', async () => {
    // Stands in for the team the view named being removed from the directory
    // outright, the same as the row it labelled having its team cleared
    // underneath it: the id in the stored criteria answers to nothing on
    // this plan from the first render on.
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: 'ghost',
          name: 'Ghost team',
          criteria: {
            query: '',
            teamIds: ['team-does-not-exist'],
            assigneeIds: [],
            priorityBands: [],
            estimatedRoleIds: [],
            unestimated: false,
            critical: false,
          },
        },
      ]),
    );

    await aPlanWithATeam();
    openViews();
    fireEvent.click(screen.getByText('Ghost team'));

    // Empty means empty — the same answer any other facet gives when nothing
    // on the plan carries the value asked for. No crash, no fallback to the
    // whole table.
    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByText('No rows match these filters')).toBeInTheDocument();
    openFilters();
    expect(screen.getByLabelText('Team a team this plan has not loaded')).toBeChecked();
  });
});

describe('what the filter says it dropped, and what it exports', () => {
  /**
   * Two roots with a dependency between them, both leaves so both are placed:
   *
   * ```
   * 010  Strip the walls   Billing
   * 020  Paint             Wiring, waits for 010
   * ```
   *
   * A team on each, so one tick keeps one row and hides the other end of the
   * only stored edge on the plan — which is the whole state F3 is about.
   */
  async function twoTeamsOneEdge(): Promise<ProjectApi> {
    const api = fakeApi();
    const strip = await api.create('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    const paint = await api.create('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    const billing = await api.addTeam('Billing');
    const wiring = await api.addTeam('Wiring');
    await api.patch(strip.id, { serviceTeamId: billing.id });
    await api.patch(paint.id, { serviceTeamId: wiring.id });
    await api.setEstimate(strip.id, DEV.id, { optimistic: 1, realistic: 2, pessimistic: 3 });
    await api.setEstimate(paint.id, DEV.id, { optimistic: 1, realistic: 2, pessimistic: 3 });
    await api.addDependency(paint.id, strip.id);

    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    return api;
  }

  const openFilters = () => {
    fireEvent.click(screen.getByText(/^Filters/));
  };
  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };

  /**
   * What a download was handed and what it was filed as — jsdom implements
   * neither the object URL nor a click that saves, so both are replaced for the
   * length of a test. The same shape `sharing the plan` uses above, written
   * again rather than hoisted: that block's copy is scoped to its own
   * `afterEach`, and one shared stub restored in two places is how a test that
   * passes alone fails in a suite.
   */
  const captureDownloads = (): { blobs: Blob[]; names: string[] } => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    const urls = URL as unknown as {
      createObjectURL: (blob: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
    urls.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return `blob:on-screen-${String(blobs.length)}`;
    };
    urls.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function capture(this: HTMLAnchorElement) {
      names.push(this.download);
    };
    return { blobs, names };
  };

  /** The bytes of a downloaded blob, through `FileReader` — jsdom's Blob has no `text()`. */
  const readBlobText = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const read = reader.result;
        if (typeof read === 'string') resolve(read);
        else reject(new Error('the downloaded blob read back as something else'));
      };
      reader.onerror = () => {
        reject(new Error('the downloaded blob could not be read'));
      };
      reader.readAsText(blob);
    });

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(HTMLAnchorElement.prototype, 'click');
  });

  /** The chart's sentence about the waits it did not draw, or null. */
  const droppedSentence = (): string | null =>
    document.querySelector('[data-gantt-dropped-links]')?.textContent ?? null;

  itDom(
    'says under the chart that a wait went undrawn, and says it only while filtering',
    async () => {
      await twoTeamsOneEdge();
      fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
      await screen.findByLabelText('Gantt chart');
      expect(droppedSentence()).toBeNull();

      openFilters();
      tick('Team Wiring');

      // `020` is drawn and the row it waits for is not, so the bar sits at a date
      // with nothing on the chart holding it there. R10 §9's Q7: the edge is not
      // pulled back — one edge can drag a whole plan in — it is counted and said.
      expect(numbersOnScreen()).toEqual(['020']);
      expect(droppedSentence()).toBe(
        'Not drawn: 1 wait whose other end this filter is hiding — 1 stored dependency. ' +
          'Clear the filter to see it.',
      );

      tick('Team Wiring');

      expect(droppedSentence()).toBeNull();
    },
  );

  itDom('counts the wait that leaves a shown row for a hidden one', async () => {
    // The direction the chart could not see before F3: `010` is on screen and
    // its **successor** is not, so its bar loses the arrow that left it.
    await twoTeamsOneEdge();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');

    openFilters();
    tick('Team Billing');

    expect(numbersOnScreen()).toEqual(['010']);
    expect(droppedSentence()).toContain('1 stored dependency');
  });

  itDom('downloads what is on screen, with a header saying what was filtered out', async () => {
    const downloads = captureDownloads();
    await twoTeamsOneEdge();
    openFilters();
    tick('Team Wiring');

    click('Download what’s on screen');

    expect(downloads.names).toHaveLength(1);
    // `-on-screen`, off the scope itself: two documents of one plan taken on
    // one day would otherwise land in a folder under the same name, and the
    // one with rows missing is the one nobody can tell apart afterwards.
    expect(downloads.names[0]).toMatch(/^rewire-the-shed-\d{4}-\d{2}-\d{2}-on-screen\.md$/);
    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    const text = await readBlobText(file);
    // What it holds, what kept it, and the two things a reader of a partial
    // document cannot work out for themselves: that the figures were not
    // recomputed, and that a Depends on points somewhere this file has not got.
    expect(text).toContain(
      '**Scope:** what one reader had on screen, not the whole plan — 1 of 2 rows, kept by: team Wiring.',
    );
    expect(text).toContain("The figures are the whole plan's schedule unchanged");
    expect(text).toContain(
      '1 Depends on reference points at a work item this document does not hold',
    );
    expect(text).toContain('| Paint |');
    expect(text).not.toContain('| Strip the walls |');
  });

  itDom('leaves the four whole-plan exports claiming the whole plan', async () => {
    // R10 §9's Q3, settled 2026-08-17: the export does not follow the filter,
    // and the second action is why it does not have to. A filtered plan
    // downloaded through the old button is still every row, and still says so.
    const downloads = captureDownloads();
    await twoTeamsOneEdge();
    openFilters();
    tick('Team Wiring');
    expect(numbersOnScreen()).toEqual(['020']);

    click('Download CSV');

    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    const text = await readBlobText(file);
    expect(text).toContain('Strip the walls');
    expect(text).toContain('Paint');
    expect(text).not.toContain('Scope');
  });
});

describe('the service cell', () => {
  /**
   * The fixture the facet cases use, one file down: two services in the
   * directory, `Checkout` on `010`, and three rows under it that state none of
   * their own. That is the whole of what this cell has to say — what a row is,
   * and what it inherits when it says nothing.
   */
  async function aServicedPlan(): Promise<ReturnType<typeof fakeApi> & { checkout: string }> {
    const api = fakeApi();
    const strip = await api.create('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    await api.create('p1', { parentId: strip.id, afterId: null, name: 'Sockets' });
    const checkout = api.addService('Checkout');
    api.addService('Ledger');
    api.labelWithService(strip.id, [checkout.id]);
    return Object.assign(api, { checkout: checkout.id });
  }

  const drawn = async (api: ProjectApi): Promise<void> => {
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
  };

  itDom('says what a row is, and what its children inherit when they say nothing', async () => {
    const api = await aServicedPlan();
    await drawn(api);

    // The row's own, as a chip rather than as the picker's value — task 10.4's
    // control change. The box beside the chip is the *add* box and holds
    // nothing, which is what `own.length > 0 ? 'add'` says.
    expect(screen.getByLabelText('Remove Checkout from 010')).toBeTruthy();
    expect(screen.getByLabelText('Services for 010')).toHaveAttribute('placeholder', 'add');
    // The child's, as placeholder ink that is shown and not stored — `↳` for
    // the inheritance, the same glyph and the same bargain the Team cell makes
    // at 120px. Inheritance did not change with the widening: blank still means
    // inherit, and a row with a chip of its own inherits nothing.
    const child = screen.getByLabelText('Services for 010.1');
    expect(child).toHaveValue('');
    expect(child).toHaveAttribute('placeholder', '↳ Checkout');
    // A marker that cannot say where it came from is a mystery, not a signal.
    expect(child).toHaveAttribute(
      'title',
      expect.stringMatching(/Checkout — inherited from 010 Strip the walls/),
    );
  });

  itDom('shows every service a row states, and takes one off without the rest', async () => {
    // **Task 10.4's own case, and the one a single-select could not pass.** The
    // store has been a set since 10.2 and the cell read `serviceIds[0]` until
    // now, so a row carrying two services showed one of them and any edit sent
    // that one back — the second was invisible on screen and lost on the next
    // choice.
    const api = fakeApi();
    const strip = await api.create('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    await api.create('p1', { parentId: strip.id, afterId: null, name: 'Sockets' });
    const checkout = api.addService('Checkout');
    // `addService` is idempotent by name, so this is the same `Ledger` the
    // shared fixture makes rather than a second one.
    const ledger = api.addService('Ledger');
    api.labelWithService(strip.id, [checkout.id, ledger.id]);

    const patches: unknown[] = [];
    const watched: ProjectApi = {
      ...api,
      patch: async (id, patch) => {
        patches.push({ id, patch });
        return api.patch(id, patch);
      },
    };
    await drawn(watched);

    // Both on screen, each removable on its own.
    expect(screen.getByLabelText('Remove Checkout from 010')).toBeTruthy();
    expect(screen.getByLabelText('Remove Ledger from 010')).toBeTruthy();

    // Removing one sends **the set as it will stand**, not the member removed —
    // a delta has no inverse the undo journal could carry (task 10.3).
    fireEvent.click(screen.getByLabelText('Remove Checkout from 010'));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({ patch: { serviceIds: [ledger.id] } });
    await waitFor(() => {
      expect(screen.queryByLabelText('Remove Checkout from 010')).toBeNull();
    });
    expect(screen.getByLabelText('Remove Ledger from 010')).toBeTruthy();
  });

  itDom(
    'sends the service the picker chose, and the empty set when the last chip goes',
    async () => {
      const api = await aServicedPlan();
      const patches: unknown[] = [];
      const watched: ProjectApi = {
        ...api,
        patch: async (id, patch) => {
          patches.push({ id, patch });
          return api.patch(id, patch);
        },
      };
      await drawn(watched);

      // Choosing on the child, which had none: the id goes out, as the whole set
      // it will stand as — one member here because the child had nothing.
      const child = screen.getByLabelText('Services for 010.1');
      fireEvent.change(child, { target: { value: 'Ledger' } });
      fireEvent.click(await screen.findByText('Ledger'));
      await waitFor(() => {
        expect(patches).toHaveLength(1);
      });

      // Taking the last one off the parent, which had one. **`[]`, not an omitted
      // field.** An absent `serviceIds` is "no opinion" to the patch and would
      // leave `Checkout` standing — the cell would appear to clear and the next
      // refetch would put the label back. The empty array is the one spelling of
      // taking the label off since task 10.2; the `null` this asserted was the
      // column's.
      //
      // Through the **chip**, not through a Clear button: since task 10.4 this box
      // holds no value, and `CreatablePicker` draws its ✕ only for a box that
      // does. This case is what found that — written against `Clear Services for
      // 010` it failed on `Unable to find a label with the text of`, which is why
      // the cell passes no `onClear` and says so.
      fireEvent.click(screen.getByLabelText('Remove Checkout from 010'));
      await waitFor(() => {
        expect(patches).toHaveLength(2);
      });
      expect(patches[1]).toMatchObject({ patch: { serviceIds: [] } });
    },
  );

  itDom('is not a column at all on a deployment that has never made a service', async () => {
    // `CONDITIONAL_COLUMNS`' whole bargain: 120px is only spent where somebody
    // has opted into the dimension. Keyed on the **directory**, not on this
    // plan's rows — a plan nobody has labelled still needs the cell to put a
    // first service in, which is why the assertion below uses a fixture with a
    // service in the directory and none on the row.
    const bare = fakeApi();
    await bare.create('p1', { parentId: null, afterId: null, name: 'Strip the walls' });
    render(<WbsTable projectId="p1" api={bare} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(screen.queryByLabelText('Services for 010')).toBeNull();

    cleanup();

    const stocked = fakeApi();
    await stocked.create('p1', { parentId: null, afterId: null, name: 'Strip the walls' });
    stocked.addService('Checkout');
    render(<WbsTable projectId="p1" api={stocked} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(screen.getByLabelText('Services for 010')).toHaveValue('');
  });
});
