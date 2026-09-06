import type { DependencyReach } from '@wbs/domain/dependency-reach';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';

import type {
  AssumedAssigneeFlipView,
  CalendarMarkerView,
  Days,
  EstimateMethod,
  ProjectApi,
  StepView,
  UndoResult,
  WorkItemView,
} from '@/lib/wbs-api';
import { DEFAULT_PERT_WEIGHTS_VIEW } from '@/lib/wbs-api';

/**
 * The plan fixtures every fe-01 suite drives the table through.
 *
 * There were seven independent `ProjectApi` fakes and no `src/testing/` at all,
 * the largest of them 674 lines inside `wbs-table.test.tsx`. This is that one,
 * moved out unchanged so the suites that share it share one model of be-01
 * rather than each inheriting a copy — and so `wbs-table.test.tsx` can be split
 * by concept without the fixture being copied eleven times.
 *
 * It is a **model of be-01's answers**, not a stub: it renumbers on every write,
 * accumulates tags down the tree, resolves assumed assignees, and refuses what
 * be-01 refuses. That is the point. A fake that answered whatever the caller
 * asked for would let a broken table pass every one of these suites.
 */

/** The first step every fixture starts with. */
export const DEV: StepView = { id: 'step-dev', name: 'Dev' };
/**
 * A second step, because "one assignee is assumed to do every step" is only
 * observable when there is another step for them to be assumed into.
 */
export const QA: StepView = { id: 'step-qa', name: 'QA' };

/**
 * A ProjectApi over an in-memory tree, numbering rows the way be-01 does.
 *
 * It has to renumber on every change rather than assign once: the whole point
 * of the component's "refetch, never patch" rule is that a create or move moves
 * numbers it never touched, and a fake that kept numbers stable would let a
 * broken component pass.
 */
export function fakeProjectApi(): ProjectApi & {
  rows: WorkItemView[];
  /**
   * The markers this fake is holding right now, readable by the test.
   *
   * Exposed the way {@link rows} is, and for the slice that needs it: 7.2
   * asserts an undated plan's axis cell wrote **nothing**, and "nothing" is
   * only observable against a list a create would have grown.
   */
  markers: CalendarMarkerView[];
  stack: { undoable: boolean; redoable: boolean };
  stackCalls: ('undo' | 'redo')[];
  answerStackWith: (answer: UndoResult) => void;
  /**
   * The label/ownership writes this fake models directly rather than through
   * {@link ProjectApi}. A fixture that needs a labelled row writes the set
   * straight onto the view, which since task 10.2 is what be-01 sends:
   * `serviceIds` off the join, no column anywhere on the wire. `addService`
   * joined `ProjectApi` on 2026-08-23, so it is no longer listed here.
   */
  labelWithService: (workItemId: string, serviceIds: readonly string[]) => void;
  /**
   * The tag half of the same thing, added by `tags-accumulate` because that
   * change is the first to need a **tagged ancestor** in this file: until then
   * the tag directory was empty here and the Tags cell had nothing to inherit.
   */
  labelWithTag: (workItemId: string, tagIds: readonly string[]) => void;
  ownService: (teamId: string, serviceId: string) => void;
  /** The same write undone, for the map emptying under a ticked signal. */
  disownService: (teamId: string, serviceId: string) => void;
  /**
   * The ref half of {@link labelWithTag}: writes a row's links straight onto
   * the view, minting an id per entry the way be-01's store does.
   *
   * A fixture rather than a patch, for `labelWithService`'s reason — a test
   * that needs a row already wired up is arranging a screen, not driving the
   * editor.
   */
  linkTo: (workItemId: string, refs: readonly { systemId: string; url: string }[]) => void;
} {
  const rows: WorkItemView[] = [];
  const edges: { predecessorId: string; successorId: string }[] = [];
  let next = 0;
  let seq = -1;
  let estimateMethod: EstimateMethod = 'pert';
  let depReach: DependencyReach = 'whole-item';
  let startDate: string | null = null;
  /**
   * The project's calendar markers, in creation order — which is the order
   * `listCalendarMarkers` answers in.
   *
   * A **store** and not a call log, and the difference is what two slices rest
   * on: 7.2 asserts an undated plan's cell wrote nothing, and 6.3 reads the
   * rename and recolour back off what the fake now holds. A spy that recorded
   * arguments and kept nothing would let a composer writing to the wrong marker
   * pass both.
   */
  const markers: CalendarMarkerView[] = [];
  /** Minted here when the caller names none, as be-01 mints one. */
  let nextMarkerId = 0;
  const markerAt = (markerId: string): CalendarMarkerView => {
    const found = markers.find((marker) => marker.id === markerId);
    // The refusal be-01 answers, so a write aimed at an id nothing holds fails
    // here rather than being silently absorbed.
    if (found === undefined) throw new Error('not_found');
    return found;
  };
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
  /** The global tag directory, `services`' shape — a tag is a name and nothing else. */
  const tags: { id: string; name: string }[] = [];
  /**
   * The work-item-type directory, `tags`' shape. Empty until a case adds one:
   * `listWorkItemTypes` answered a fresh `[]` before {@link addWorkItemType}
   * existed here, so a type added through the API vanished on the next read.
   */
  const workItemTypes: { id: string; name: string }[] = [];
  /**
   * The external-system vocabulary, **seeded** where every other directory here
   * starts empty — which is what be-01 does, and the difference is load-bearing:
   * the names are exactly what `systemOfUrl` answers, so a pasted URL can type
   * itself on a deployment nobody has configured. A fake starting empty would
   * let a cell that never resolves a system name pass.
   */
  const externalSystems: { id: string; name: string }[] = [
    { id: 'sys-jira', name: 'jira-issue' },
    { id: 'sys-gh-pr', name: 'github-pr' },
    { id: 'sys-gh-issue', name: 'github-issue' },
    { id: 'sys-confluence', name: 'confluence-page' },
    { id: 'sys-slack', name: 'slack-message' },
  ];
  /** Ref ids are minted by the store and never taken from a caller, as be-01's are. */
  let nextRefId = 0;
  const people: { id: string; name: string; teamIds: string[] }[] = [];
  const assigned = new Map<string, string>();
  /**
   * The project's steps, which this fake can now be asked to change.
   *
   * A list of its own rather than the two constants, because `P phases-ui` adds
   * and removes them: a fake answering a fixed pair would let a dialog that
   * wrote nothing pass.
   */
  let stepList: StepView[] = [{ ...DEV }, { ...QA }];
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
   * The work items whose assumed assignee removing `stepId` would move, the way
   * `apps/be-01/src/service/assumed-assignee.ts` computes them: exactly one
   * assignment means that person is taken to be doing every step.
   */
  function flipsFor(stepId: string): AssumedAssigneeFlipView[] {
    const byWorkItem = new Map<string, Record<string, string>>();
    for (const [key, personId] of assigned) {
      const [workItemId = '', held = ''] = key.split('::');
      byWorkItem.set(workItemId, { ...(byWorkItem.get(workItemId) ?? {}), [held]: personId });
    }
    const only = (byStep: Record<string, string>): string | null => {
      const named = Object.values(byStep);
      return named.length === 1 ? (named[0] ?? null) : null;
    };
    return [...byWorkItem.entries()]
      .map(([workItemId, byStep]) => ({
        workItemId,
        assumedNow: only(byStep),
        assumedAfter: only(
          Object.fromEntries(Object.entries(byStep).filter(([each]) => each !== stepId)),
        ),
      }))
      .filter((flip) => flip.assumedNow !== flip.assumedAfter)
      .sort((a, b) => (a.workItemId < b.workItemId ? -1 : 1));
  }

  /**
   * One row's estimates as be-01 sends them: its own where it is a leaf, and
   * the sum of every descendant's per step and per point where it is not.
   *
   * A work item with children has no estimate of its own (`CONTEXT.md`), so
   * summing the whole subtree and summing the leaves in it are the same walk.
   */
  function rolledUpEstimates(of: { id: string }): Record<string, Days> {
    const summed: Record<string, Days> = {};
    const walk = (rowId: string): void => {
      const row = rows.find((r) => r.id === rowId);
      if (row === undefined) return;
      for (const [stepId, days] of Object.entries(row.estimates)) {
        const already = summed[stepId] ?? { optimistic: 0, realistic: 0, pessimistic: 0 };
        summed[stepId] = {
          optimistic: already.optimistic + days.optimistic,
          realistic: already.realistic + days.realistic,
          pessimistic: already.pessimistic + days.pessimistic,
        };
      }
      for (const child of rows.filter((r) => r.parentId === rowId)) walk(child.id);
    };
    walk(of.id);
    return summed;
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
    markers,
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
      // A Promise now, because the plan's service cell creates through
      // `ProjectApi.addService` since 2026-08-23.
      const already = services.find((s) => s.name === name);
      if (already !== undefined) return Promise.resolve(already);
      const service = { id: `service${String(services.length + 1)}`, name };
      services.push(service);
      return Promise.resolve(service);
    },
    labelWithService(workItemId: string, serviceIds: readonly string[]) {
      const row = rows.find((r) => r.id === workItemId);
      if (row !== undefined) row.serviceIds = [...serviceIds];
      // Through `renumber` like every other write here, so the next `tree`
      // read carries a fresh sequence and the table does not discard it.
      renumber();
    },
    linkTo(workItemId: string, refs: readonly { systemId: string; url: string }[]) {
      const row = rows.find((r) => r.id === workItemId);
      if (row === undefined) throw new Error(`no work item ${workItemId}`);
      row.externalRefs = refs.map((ref) => {
        nextRefId += 1;
        return { id: `ref${String(nextRefId)}`, systemId: ref.systemId, url: ref.url };
      });
    },
    labelWithTag(workItemId: string, tagIds: readonly string[]) {
      const row = rows.find((r) => r.id === workItemId);
      // The row's **own** set, which is all be-01 ever sends: what the row
      // carries from above is `effectiveTagsOf`'s answer and is never stored.
      if (row !== undefined) row.tagIds = [...tagIds];
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
          // On the wire since `project-dropdown-details`, and missing from this
          // fixture until it was moved somewhere a compiler reads it: a spec
          // project is out of fe-01's typecheck target, so a fake could stop
          // satisfying `ProjectApi` and nothing would say so.
          startDate,
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
          // A parent carries the sum of its descendants' trios, per step and
          // per point — `work-item.service.ts`'s `totals`, which is what
          // `WorkItemRow.estimates` means on the wire for a row with children.
          // Until 2026-08-29 this fake handed a parent `{}` and its own
          // `rolledUp` flag in the same object, so the roll-up column read
          // empty in jsdom and every claim about it was made against nothing.
          estimates: rolledUpEstimates(r),
          finalDays: Object.fromEntries(
            Object.entries(rolledUpEstimates(r)).map(([stepId, days]) => [stepId, finalOf(days)]),
          ),
          finalTotal: Object.values(rolledUpEstimates(r)).reduce(
            (total, days) => total + finalOf(days),
            0,
          ),
          // be-01 works the dates out; the fake only has to place them on the
          // calendar the same way, so the table is asserted on what it renders.
          dates: startDate === null ? null : { startsOn: startDate, endsOn: startDate },
          assignees: Object.fromEntries(
            [...assigned.entries()]
              .filter(([key]) => key.startsWith(`${r.id}::`))
              .map(([key, personId]) => [key.split('::')[1] ?? '', personId]),
          ),
          doesEveryStep: (() => {
            const mine = [...assigned.entries()].filter(([key]) => key.startsWith(`${r.id}::`));
            return mine.length === 1 ? (mine[0]?.[1] ?? null) : null;
          })(),
        })),
        seq,
        scheduleError: null,
        // One per leaf and step, as be-01 places them: a parent has no work of
        // its own and gets none. The ids are this fake's, and opaque — the
        // table looks them up and never takes them apart.
        slices: rows
          .filter((r) => !rows.some((child) => child.parentId === r.id))
          .map((r) => ({
            id: `${r.id}::${DEV.id}`,
            workItemId: r.id,
            stepId: DEV.id,
            personId: assigned.get(`${r.id}::${DEV.id}`) ?? null,
            ...scheduleOf(r),
            // The one floor this fake can honestly tell apart, and it tells it
            // apart because `row-start-floor` made the Start column say which:
            // be-01 floors a row with a stored predecessor on `predecessor`,
            // and a constant `projectStart` here would let a cell claim a plan
            // has no waits in it at all. The other four floors need a scheduler
            // and this fake is not one — the tests about them are
            // `gantt-geometry.test.ts`'s, over payloads shaped by hand.
            // Unstated, like every other pool fact this fixture leaves alone: no case
            // here levels against a team's capacity.
            capacityTeamId: null,
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
        // reads its steps and its names from here and not from the separate
        // `steps`/`listPeople` calls the pickers make.
        steps: stepList.map((step) => ({ ...step })),
        assignedPeople: people.map(({ id, name }) => ({ id, name })),
        // Present and empty, never absent: be-01 always sends it, so a fake that
        // left it out would let `teamsOnThePlan` be handed `undefined` here and
        // never in production. A plan whose teams are unlimited is what `[]` says.
        teamCapacities: [],
        // Copied, not handed over: `DEFAULT_PRIORITY_BANDS` is `readonly` in
        // `@wbs/domain` and the wire type is not, and a fixture that shared the
        // array would let one case's edit reach the next.
        priorityBands: [...DEFAULT_PRIORITY_BANDS],
        estimateMethod,
        // Present on every read, never absent: be-01 always sends the project's
        // reach, and a fake that left it off would hand the chart an
        // `undefined` it can never see in production — every arrow would then
        // be drawn out of the anchor slice whatever the plan was scheduled by.
        depReach,
        pertWeights: DEFAULT_PERT_WEIGHTS_VIEW,
        estimateRounding: 'ceil' as const,
        startDate,
        // Never moved by anything the table does: the fake's mutations are all
        // work item writes, and be-01 keeps the project's revision off them.
        projectRevision: 0,
        undoable: stack.undoable,
        redoable: stack.redoable,
      }),
    setDepReach(_projectId, reach) {
      depReach = reach;
      renumber();
      return Promise.resolve();
    },
    setEstimateMethod(_projectId, method) {
      estimateMethod = method;
      renumber();
      return Promise.resolve();
    },
    listTeams: () => Promise.resolve(teams.map((t) => ({ ...t, serviceIds: [...t.serviceIds] }))),
    listTags: () => Promise.resolve([...tags]),
    listWorkItemTypes: () => Promise.resolve([...workItemTypes]),
    addTag(name: string) {
      // Idempotent by name, `addTeam`'s and `addService`'s rule and be-01's.
      const already = tags.find((each) => each.name === name);
      if (already !== undefined) return Promise.resolve(already);
      const tag = { id: `tag${String(tags.length + 1)}`, name };
      tags.push(tag);
      return Promise.resolve(tag);
    },
    /**
     * The six members below were **absent** until 2026-09-02, and the fixture
     * still claimed to be a `ProjectApi`. A spec project is outside fe-01's
     * typecheck target, so an interface could grow a method and every fake go
     * on satisfying nothing at all. Moving this file into `src/` is what said
     * so, and it named all six at once.
     *
     * They answer the shape and change nothing, deliberately: no case in these
     * suites drives them, and inventing behaviour a test does not ask for is
     * how a fixture starts disagreeing with be-01. A case that needs one of
     * these models it here, properly, at that point.
     */
    addWorkItemType(name: string) {
      const already = workItemTypes.find((each) => each.name === name);
      if (already !== undefined) return Promise.resolve(already);
      const type = { id: `type${String(workItemTypes.length + 1)}`, name };
      workItemTypes.push(type);
      return Promise.resolve(type);
    },
    renameTag(tagId: string, name: string) {
      const tag = tags.find((each) => each.id === tagId);
      if (tag === undefined)
        return Promise.resolve({
          ok: false as const,
          reason: 'taken' as const,
          survivingName: name,
        });
      tag.name = name;
      return Promise.resolve({ ok: true as const, entry: { ...tag } });
    },
    removeTag(tagId: string) {
      const at = tags.findIndex((each) => each.id === tagId);
      if (at !== -1) tags.splice(at, 1);
      return Promise.resolve({ ok: true as const });
    },
    setEstimateArithmetic: () => Promise.resolve(),
    setTeamCapacity: () => Promise.resolve(),
    setPriorityBands: () => Promise.resolve(),
    listServices: () => Promise.resolve([...services]),
    listExternalSystems: () => Promise.resolve(externalSystems.map((each) => ({ ...each }))),
    addTeam(name: string) {
      // Idempotent by name, exactly as be-01 is: the picker's "type it if it
      // is not in the list" must not be able to make two `Platform`s.
      const already = teams.find((t) => t.name === name);
      if (already !== undefined) return Promise.resolve(already);
      const team = { id: `team${String(teams.length + 1)}`, name, serviceIds: [] };
      teams.push(team);
      return Promise.resolve(team);
    },
    // `kind` on every person, never absent: be-01 sends one whether or not
    // anybody chose it, and a fixture that left it off would hand the directory
    // an `undefined` it cannot see in production.
    listPeople: () =>
      Promise.resolve(
        people.map((p) => ({ ...p, kind: 'person' as const, teamIds: [...p.teamIds] })),
      ),
    addPerson(name: string, teamIds: readonly string[]) {
      const already = people.find((p) => p.name === name);
      if (already !== undefined) {
        return Promise.resolve({ ...already, kind: 'person' as const });
      }
      const person = {
        id: `person${String(people.length + 1)}`,
        name,
        teamIds: [...teamIds],
      };
      people.push(person);
      return Promise.resolve({ ...person, kind: 'person' as const });
    },
    assignPerson(workItemId: string, stepId: string, personId: string | null) {
      const key = `${workItemId}::${stepId}`;
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
    listCalendarMarkers: () => Promise.resolve(markers.map((marker) => ({ ...marker }))),
    createCalendarMarker(_projectId, marker) {
      const stored: CalendarMarkerView = {
        id: marker.markerId ?? `marker-${String(nextMarkerId++)}`,
        date: marker.date,
        name: marker.name,
        // Absent and `null` are one answer — the automatic colour — because
        // that is what the route stores for both, and a fake that kept
        // `undefined` would hand `markerFill` something production never sees.
        color: marker.color ?? null,
      };
      markers.push(stored);
      // No `renumber()`: a marker moves nothing in the plan, which is task 4's
      // axis-1 obligation. Recomputing here would hide a marker write that had
      // quietly become a schedule input.
      return Promise.resolve({ ...stored });
    },
    renameCalendarMarker(_projectId, markerId, name) {
      const marker = markerAt(markerId);
      marker.name = name;
      return Promise.resolve({ ...marker });
    },
    recolorCalendarMarker(_projectId, markerId, color) {
      const marker = markerAt(markerId);
      marker.color = color;
      return Promise.resolve({ ...marker });
    },
    deleteCalendarMarker(_projectId, markerId) {
      markers.splice(markers.indexOf(markerAt(markerId)), 1);
      return Promise.resolve();
    },
    steps: () => Promise.resolve(stepList.map((step) => ({ ...step }))),
    addStep(_projectId, name) {
      const clean = name.trim();
      if (clean === '') return Promise.reject(new Error('name_required'));
      if (stepList.some((step) => step.name === clean)) {
        return Promise.reject(new Error('taken'));
      }
      const step = { id: `step-${clean.toLowerCase()}`, name: clean };
      stepList.push(step);
      renumber();
      return Promise.resolve(step);
    },
    renameStep(_projectId, stepId, name) {
      const clean = name.trim();
      if (clean === '') return Promise.reject(new Error('name_required'));
      const step = stepList.find((each) => each.id === stepId);
      if (step === undefined) return Promise.reject(new Error('not_found'));
      if (stepList.some((each) => each.id !== stepId && each.name === clean)) {
        return Promise.reject(new Error('taken'));
      }
      step.name = clean;
      renumber();
      return Promise.resolve({ ...step });
    },
    removeStep(_projectId, stepId, cascade) {
      const step = stepList.find((each) => each.id === stepId);
      if (step === undefined) return Promise.reject(new Error('not_found'));
      // `Object.hasOwn` rather than an index and a comparison: `estimates` is a
      // `Record<string, Days>`, so the index is typed as always finding one and
      // the comparison is dead code the lint rightly refuses.
      const estimates = rows.filter((row) => Object.hasOwn(row.estimates, stepId)).length;
      const holders = [...assigned.keys()].filter((key) => key.endsWith(`::${stepId}`));
      if (!cascade && estimates + holders.length > 0) {
        return Promise.resolve({
          ok: false as const,
          reason: 'in_use' as const,
          inUse: { estimates, assignments: holders.length, assumedAssignees: flipsFor(stepId) },
        });
      }
      for (const row of rows) {
        // Rebuilt rather than `delete`d on a computed key, which this repo bans.
        row.estimates = Object.fromEntries(
          Object.entries(row.estimates).filter(([each]) => each !== stepId),
        );
      }
      for (const key of holders) assigned.delete(key);
      stepList = stepList.filter((each) => each.id !== stepId);
      renumber();
      return Promise.resolve({ ok: true as const });
    },
    createWorkItem(_projectId, input) {
      next += 1;
      const id = `w${String(next)}`;
      // Absent is null, as be-01's schema says ("null or absent puts it first
      // in its group"); left apart, an absent one fell through to
      // `findIndex(undefined) + 1` and landed at 0 instead.
      //
      // The end of the row list rather than the head of the group, and the two
      // coincide for the only null this app sends: `wbs-table.tsx` reads the
      // last sibling's id and passes null only when the group is empty.
      const after = input.afterId ?? null;
      const at = after === null ? rows.length : rows.findIndex((r) => r.id === after) + 1;
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
        // A duplicate `teamIds` sat here until 2026-08-18, and a duplicate
        // `startNoEarlierThanReason` until 2026-09-02 — both harmless, and both
        // only possible because nothing typechecked this file. Moving it here,
        // into a project the compiler reads, is what found the second one.
        serviceTeamId: null,
        teamIds: [],
        assignees: {},
        doesEveryStep: null,
        rolledUp: false,
        estimates: {},
        dependsOn: [],
        finalDays: {},
        finalTotal: 0,
        // Null until the plan is on a calendar, which is what be-01 sends for a
        // row it has just written into an undated project.
        dates: null,
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
    patchWorkItem(id, patch) {
      const row = rows.find((r) => r.id === id);
      // `maxParallel: null` is a **reset to 1** and not a clear, which is
      // be-01's own normalisation (`capacity-write-paths`, slice 1.3) rather
      // than this fake's convenience: the column is NOT NULL, and a fake that
      // stored the null would let the table pass a test against a row shape
      // be-01 can never send.
      const written =
        'maxParallel' in patch && patch.maxParallel === null ? { ...patch, maxParallel: 1 } : patch;
      // The refs be-01 would have written: the whole list replaced, with an id
      // minted per entry. Taken off the patch **before** the spread, because the
      // wire shape has no `id` and a spread would put `{systemId, url}` on the
      // view where every reader expects an `ExternalRefView`.
      const { externalRefs: statedRefs, ...restOfPatch } = written as Record<string, unknown> & {
        externalRefs?: readonly { systemId: string; url: string }[];
      };
      if (row !== undefined) Object.assign(row, restOfPatch);
      if (row !== undefined && statedRefs !== undefined) {
        row.externalRefs = statedRefs.map((ref) => {
          nextRefId += 1;
          return { id: `ref${String(nextRefId)}`, systemId: ref.systemId, url: ref.url };
        });
      }
      // The dual write be-01 performs: the column and the join, in one act, and
      // the join is what this client reads. A fake that wrote only the column
      // would leave the table reading an empty set and every label test green
      // against a screen with no labels on it.
      if (row !== undefined && 'teamIds' in written && written.teamIds !== undefined) {
        row.teamIds = [...written.teamIds];
        row.serviceTeamId = row.teamIds.at(0) ?? null;
      } else if (row !== undefined && 'serviceTeamId' in written) {
        row.teamIds = written.serviceTeamId === null ? [] : [written.serviceTeamId ?? ''];
      }
      return Promise.resolve();
    },
    moveWorkItem(id, parentId, afterId) {
      const index = rows.findIndex((r) => r.id === id);
      const row = rows.splice(index, 1).at(0);
      if (row === undefined) return Promise.resolve();
      row.parentId = parentId;
      const at = afterId === null ? 0 : rows.findIndex((r) => r.id === afterId) + 1;
      rows.splice(at, 0, row);
      renumber();
      return Promise.resolve();
    },
    duplicateWorkItem(id) {
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
        const [workItemId = '', stepId = ''] = key.split('::');
        if (inside.has(workItemId)) assigned.set(`${copyId(workItemId)}::${stepId}`, personId);
      }
      const last = subtree.at(-1);
      rows.splice(last === undefined ? rows.length : rows.indexOf(last) + 1, 0, ...copies);
      renumber();
      const root = copies.at(0);
      if (root === undefined) throw new Error('a duplication copied nothing');
      return Promise.resolve({ id: root.id });
    },
    removeWorkItem(id) {
      const index = rows.findIndex((r) => r.id === id);
      if (index >= 0) rows.splice(index, 1);
      renumber();
      return Promise.resolve();
    },
    setEstimate(id, stepId, days: Days) {
      const row = rows.find((r) => r.id === id);
      if (row !== undefined) row.estimates[stepId] = days;
      return Promise.resolve();
    },
    clearEstimate(id, stepId) {
      const row = rows.find((r) => r.id === id);
      // Rebuilt without the step rather than `delete`d on a computed key, the
      // same way the table drops a trio's drafts.
      if (row !== undefined) {
        row.estimates = Object.fromEntries(
          Object.entries(row.estimates).filter(([key]) => key !== stepId),
        );
      }
      return Promise.resolve();
    },
    freezeProject() {
      for (const row of rows) row.frozenNumber ??= row.number;
      return Promise.resolve();
    },
    unfreezeProject() {
      for (const row of rows) row.frozenNumber = null;
      return Promise.resolve();
    },
    unfreezeWorkItem(id) {
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
