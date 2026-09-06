import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PRIORITY_BANDS, type PriorityBand } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Project, Step, StoredDependency, WorkItem, WriteStamp } from '../repository';
import { STEP_POSITION_STEP } from '../repository';
import { openDatabase, openDrizzle } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { rollbackTo } from '../repository/migrate-down';
import { PriorityBandRepository } from '../repository/priority-band';
import { inMemoryActuals } from '../testing/actual-fixture';
import {
  countMovedDates,
  isFullyEstimated,
  withoutPlacement,
  withSnappedRollUps,
} from '../testing/assumed-duration-oracle';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { inMemoryMeasures } from '../testing/measure-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { inMemoryProgress } from '../testing/progress-fixture';
import { inMemoryProjects, projectRow } from '../testing/project-fixture';
import { inMemorySubtrees } from '../testing/subtree-fixture';
import { inMemoryWorkItems, workItemRow } from '../testing/work-item-fixture';
import captured from './fixtures/capacity-oracle-2026-08-13.json';
import { WorkItemService } from './work-item.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
/** The tip before this change: the schema every existing plan is on when the migration runs. */
const PRE_BANDS = '20260813120000_add_project_team_capacity';
/**
 * The stamp every replayed write carries. The oracle was captured before a write
 * recorded who made it, so the project's own owner stands in for the actor and
 * the instant is fixed — these replays are claims about the ladder, not either.
 */
const STAMP: WriteStamp = { at: 1, by: 'owner' };

interface CapturedRow {
  id: string;
  parentId: string | null;
  position: number;
  name: string;
  priority: number | null;
  maxParallel: number;
  startNoEarlierThan: string | null;
  serviceTeamId: string | null;
  estimates: Record<string, { optimistic: number; realistic: number; pessimistic: number }>;
  assignees: Record<string, string>;
  dependsOn: string[];
}

interface CapturedPlan {
  projectId: string;
  stepIds: string[];
  estimateMethod: 'pert' | 'optimistic' | 'realistic' | 'pessimistic';
  startDate: string | null;
  rows: CapturedRow[];
}

interface Oracle {
  capturedAt: string;
  capturedFrom: string;
  teams: { id: string; name: string; size: number | null }[];
  people: { id: string; name: string }[];
  plans: CapturedPlan[];
  answers: Record<string, unknown>[];
}

const oracle = captured as unknown as Oracle;

/**
 * The capacities every plan in the corpus is bounded by, as `(team → slots)`.
 *
 * The oracle was captured from a be-01 in which a team's size was **global**, so
 * every plan saw every sized team's number — and `capacity-per-project`'s
 * migration seeded exactly that, one row per (project, sized team). Replaying
 * with no capacities at all would therefore not be replaying the captured plans:
 * every capacity floor would be gone, and the first prioritised plan's
 * `earliestStart` moves 7.5 → 3 with `boundBy` falling back to `'stepOrder'`.
 * Observed, 2026-08-14, which is why this constant exists rather than an empty
 * map.
 *
 * Taken from the oracle's own `teams` rather than from a migrated database:
 * whether the migration writes these numbers is `capacity-per-project`'s claim
 * and is asserted in its own two files. What this file needs is only that both
 * of its replays are bounded identically, so the *ladder* is the one thing that
 * differs between them.
 */
const CAPACITIES: Readonly<Record<string, number>> = Object.fromEntries(
  oracle.teams
    .filter((team): team is { id: string; name: string; size: number } => team.size !== null)
    .map((team) => [team.id, team.size]),
);

/**
 * A ladder that disagrees with the default one about **every** priority in the
 * corpus, so "the dates did not move" cannot pass by the two ladders agreeing.
 *
 * Checked rather than asserted by eye: `the two ladders disagree about every
 * priority in the corpus` below is what makes the re-cut replay a real second
 * measurement instead of the first one run twice.
 */
const RECUT: readonly PriorityBand[] = [
  { startsAt: 1, label: 'Blocker', defaultValue: 1 },
  { startsAt: 2, label: 'Urgent', defaultValue: 2 },
  { startsAt: 3, label: 'Normal', defaultValue: 3 },
  { startsAt: 4, label: 'Later', defaultValue: 4 },
  { startsAt: 5, label: 'Never', defaultValue: 900 },
];

/**
 * **A priority band moves no date**, against the same sixteen plans
 * `capacity-per-project` measured itself against.
 *
 * This is the claim the whole change rests on, and it is the one Dany's brief
 * said to stop and report on if it turned out false: priority already drives the
 * leveller's queue, so a ladder that could reach a date would be a scheduling
 * change wearing a presentation change's clothes. It cannot — `goesFirst` in
 * `schedule.ts` orders on `work_item.priority` and that integer alone, and
 * nothing in `tree()` hands the ladder to `slicesOf` or to `schedule` — and this
 * file is that argument as a measurement.
 *
 * It is **two** replays of the corpus and neither is the claim on its own:
 *
 * - **with the ladder the migration seeds**, which says the new read added to
 *   `tree()` perturbs nothing;
 * - **with a ladder re-cut so that every priority in the corpus changes its
 *   name**, which says the configuration itself is inert. The first alone would
 *   pass a build in which the ladder reached the scheduler and simply happened to
 *   agree with the defaults.
 *
 * The oracle is `capacity-per-project`'s, unchanged and deliberately reused: it
 * was captured at `050fd45` by a script committed before that branch had a line
 * of implementation in it, so it predates **both** changes. Re-capturing it for
 * this change would replace a pin taken from a be-01 that no longer exists with
 * one taken from the code under test. `capacity-per-project`'s design.md D7 has
 * the full argument for why the oracle is data rather than a copied function.
 */
describe('a priority ladder moves no date', () => {
  it('has a corpus worth measuring, and one that is mostly prioritised', () => {
    // The non-vacuity rule. `capacity-per-project`'s own version of this asserts
    // the capacity coverage; what *this* differential needs is priorities, and a
    // corpus of unprioritised rows would make both replays below identical for a
    // reason that has nothing to do with the claim.
    expect(oracle.capturedFrom).toBe('050fd45');
    expect(oracle.plans).toHaveLength(16);

    const rows = oracle.plans.flatMap((plan) => plan.rows);
    expect(rows).toHaveLength(151);
    const prioritised = rows.filter((row) => row.priority !== null);
    expect(prioritised.length).toBeGreaterThan(20);
    // And unprioritised rows too, because "no priority" is the state that is
    // placed after every priority rather than among them, and a corpus without it
    // would leave the differential blind to the arm most likely to be broken by a
    // ladder that resolved `null` to something.
    expect(rows.filter((row) => row.priority === null).length).toBeGreaterThan(20);
  });

  it('measures against a ladder that renames every priority in the corpus', () => {
    // What makes the second replay a second measurement. Every priority in the
    // corpus falls in `Lowest` under `RECUT` (its top band starts at 5) and in
    // something else under the defaults — so if a band could reach a date, the two
    // replays could not both equal the oracle.
    const prioritised = oracle.plans
      .flatMap((plan) => plan.rows)
      .map((row) => row.priority)
      .filter((priority): priority is number => priority !== null);
    expect(prioritised.length).toBeGreaterThan(20);
    for (const priority of prioritised) {
      expect(labelIn(RECUT, priority)).not.toBe(labelIn(DEFAULT_PRIORITY_BANDS, priority));
    }
  });

  it('answers exactly what be-01 answered, with the ladder the migration seeds', async () => {
    // **This replay cannot see a ladder that reaches the leveller, and the case
    // three tests down is why.** Every priority in the corpus is 1, 2, 3 or 4, so
    // all 26 of them fall in the default ladder's first band — a build that
    // ordered on the *band* instead of the number would collapse them all to one
    // rank and still come back byte-identical here. Measured, not supposed: the
    // ladder wired into `slicesOf` and `schedule` gives 4 pass / 0 fail against
    // the corpus alone. What this replay does say is the thing it is for — the
    // read added to `tree()` perturbs nothing.
    const seeded = await ladderAfterTheMigration();
    expect(seeded).toEqual([...DEFAULT_PRIORITY_BANDS]);

    let moved = 0;
    for (const [at, plan] of oracle.plans.entries()) {
      const answer = oracle.answers.at(at);
      if (answer === undefined) throw new Error(`no captured answer for ${plan.projectId}`);
      const tree = await replay(plan, seeded);
      moved += countMovedDates(answer, tree);
      const narrow = narrowedFor(plan);
      expect(narrow({ project: plan.projectId, ...lifted(tree) })).toEqual(
        narrow(expected(plan, answer, seeded)),
      );
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('answers exactly what be-01 answered again, with every band renamed and re-cut', async () => {
    // **The claim in its strong form.** Same sixteen plans, same oracle, a ladder
    // that calls every priority in the corpus something different — and every
    // field of every work item and every slice is what be-01 answered before
    // either change existed. Re-cutting a ladder renames a plan's numbers and
    // moves not one of its dates.
    for (const [at, plan] of oracle.plans.entries()) {
      const answer = oracle.answers.at(at);
      if (answer === undefined) throw new Error(`no captured answer for ${plan.projectId}`);
      const narrow = narrowedFor(plan);
      expect(narrow({ project: plan.projectId, ...lifted(await replay(plan, RECUT)) })).toEqual(
        narrow(expected(plan, answer, RECUT)),
      );
    }
  });

  it('answers the same under both ladders, every field of every plan', async () => {
    // What the narrowing above cost, paid back — and it is the file's own claim
    // stated without an oracle at all. The two replays are both **this** engine,
    // so `assumed-duration-schedules` (2026-08-29) touches neither side and
    // nothing has to be set aside: sixteen plans, two ladders that call every
    // priority in the corpus something different, and every date, slice, float
    // and red row byte-identical between them.
    //
    // Proof: the ladder wired into the leveller's `goesFirst` in place of the
    // raw priority — the fault the two replays above exist to catch and can no
    // longer see on the thirteen narrowed plans — and this failed on `p11`,
    // `- "earliestStart": 0 / + "earliestStart": 4` with the two documents
    // otherwise identical; watched 2026-08-29.
    for (const plan of oracle.plans) {
      const underDefault = lifted(await replay(plan, DEFAULT_PRIORITY_BANDS));
      const underRecut = lifted(await replay(plan, RECUT));
      expect({ ...underRecut, priorityBands: null }, plan.projectId).toEqual({
        ...underDefault,
        priorityBands: null,
      });
    }
  });

  it('leaves a plan whose order priority decides exactly where it was, under any ladder', async () => {
    // **The corpus above cannot see this, and that is why this test exists.**
    // Inverting every priority in the sixteen captured plans — inside the
    // scheduler, with the payload's own numbers left alone — moves not one date:
    // `4 pass, 0 fail`, watched 2026-08-14. Those plans' contention is decided by
    // dependencies, pools and people, and their 26 priorities never break a tie.
    // So a build in which the ladder reached the leveller would pass both replays
    // above, and the differential would be green for a reason that has nothing to
    // do with the claim.
    //
    // This is a plan where priority is the **only** thing deciding the order: one
    // person, two independent leaves, no dependencies and no pool. It is measured
    // three ways — the default ladder, a re-cut ladder, and the same plan with the
    // two numbers swapped — and the third is the control that proves the first two
    // are measuring something.
    const underDefault = await contended(1, 2, DEFAULT_PRIORITY_BANDS);
    const underRecut = await contended(1, 2, RECUT);
    const swapped = await contended(2, 1, DEFAULT_PRIORITY_BANDS);

    // Non-vacuity first: the two numbers decide the order, so swapping them has
    // to move the plan. Without this the two assertions below could both hold on
    // a plan where nothing was contended at all.
    expect(swapped).not.toEqual(underDefault);
    // And under the two ladders the plan is byte-identical — every field of every
    // work item and every slice. `Blocker` and `Urgent` name what `Critical` named
    // a moment ago and the dates do not know about it.
    expect(underRecut).toEqual(underDefault);
  });

  /**
   * Two independent leaves, one person on both, and nothing else to decide which
   * goes first — so the two priorities are the whole of the order.
   *
   * Returns **only what the schedule decided** — each row's placement and dates,
   * and every slice. Not the whole payload, and that is not tidiness: the payload
   * carries each row's stored `priority`, so a comparison over all of it is
   * satisfied by the numbers being different and says nothing about whether a
   * date moved. The control below would have passed on that alone, and did until
   * this was narrowed. Watched 2026-08-14.
   */
  async function contended(
    first: number,
    second: number,
    bands: readonly PriorityBand[],
  ): Promise<Record<string, unknown>> {
    const projects = inMemoryProjects();
    const directory = inMemoryDirectory(
      (projectId): Promise<readonly { id: string }[]> => workItems.listByProject(projectId),
    );
    const workItems = inMemoryWorkItems(directory);
    const estimates = inMemoryEstimates(workItems);
    const actuals = inMemoryActuals(workItems);
    const measures = inMemoryMeasures(workItems);
    const progress = inMemoryProgress(workItems);
    const dependencies = inMemoryDependencies();
    const service = new WorkItemService({
      workItems,
      projects,
      estimates,
      actuals,
      measures,
      progress,
      dependencies,
      directory,
      capacity: inMemoryCapacity(),
      priorityBands: inMemoryPriorityBands({ contended: bands }),
      subtrees: inMemorySubtrees({
        workItems,
        estimates,
        actuals,
        measures,
        progress,
        dependencies,
        directory,
      }),
      journal: inMemoryCommandJournal(),
      broadcast: recordingBroadcaster(),
    });
    await directory.addPerson({ id: 'ada', name: 'Ada' }, [], STAMP);
    await projects.create(
      projectRow({
        id: 'contended',
        name: 'Two things, one person',
        ownerId: 'owner',
        estimateMethod: 'realistic',
        // The arithmetic this capture was taken under: a step's figure reached
        // the schedule as the fraction the method produced. See
        // `estimate-weights-and-rounding`, which made `ceil` the default for
        // every project and left `exact` as the arm an oracle replays on.
        estimateRounding: 'exact',
        // The `anchor-slice` reach, for the reason the replayed plans below
        // carry it: this fixture's figures were derived before a reach existed.
        depReach: 'anchor-slice',
      }),
      [{ id: 'dev', projectId: 'contended', name: 'Dev', position: STEP_POSITION_STEP }],
      STAMP,
    );
    for (const [id, position, priority] of [
      ['a', 10, first],
      ['b', 20, second],
    ] as const) {
      await workItems.insert(
        workItemRow({
          id,
          projectId: 'contended',
          position,
          name: id,
          priority,
        }),
        [],
        STAMP,
      );
      await estimates.set(
        {
          workItemId: id,
          stepId: 'dev',
          optimistic: 3,
          realistic: 3,
          pessimistic: 3,
        },
        STAMP,
      );
      // One person on both, which is what makes the two compete: a person's next
      // slice is only ever placed after their previous one is final.
      await directory.assign(id, 'dev', 'ada', STAMP);
    }
    const tree = await service.tree('contended');
    if (tree === null) throw new Error('the contended plan vanished on replay');
    return {
      slices: tree.slices,
      placed: tree.workItems.map((row) => ({
        id: row.id,
        schedule: row.schedule,
        dates: row.dates,
      })),
    };
  }

  /**
   * The payload with `teamIds` lifted off every row, and the arity claim asserted
   * where it comes off.
   *
   * `team-sets` (#61) merged to main while this branch was open and put a set on
   * every row. The oracle was captured at `050fd45`, before it, so a whole-document
   * comparison fails on `+ "teamIds": [ "team-unsized" ]` and nothing else —
   * a payload that gained a field, which is not a payload that moved a date. Seen
   * exactly that way on the rebase, 2026-08-14: 2 fail, both here, diff nothing but
   * the new key on every labelled row.
   *
   * Lifted rather than listing the fields the oracle *does* carry, and the set is
   * **asserted** rather than dropped: a bare lift would let a write path that
   * forgot the join pass this file silently. Same shape as
   * `capacity-migration-identity.test.ts`, which is where `team-sets` makes the
   * claim first; it is repeated here because this file compares the same oracle
   * and a lift with nothing behind it is a hole.
   *
   * **`actuals` is lifted the same way, by `actual-days` (R6 H2).** The oracle
   * predates the table entirely, so every row of the payload now carries an
   * `actuals: {}` the capture cannot have. It is **asserted empty** rather than
   * dropped: an empty object on every row of sixteen replayed plans is this
   * change's own claim — a plan nobody has recorded a day against reads as
   * nobody having recorded a day, never as zero days spent — and a bare lift
   * would let a roll-up that invented figures pass here silently.
   *
   * **`tagIds` is lifted by `tags` (R10-B)**, and asserted empty rather than
   * dropped, for `actuals`' reason. The oracle predates the second label
   * dimension entirely, so every row now carries a `tagIds: []` the capture
   * cannot have — a payload that gained a field, which is not a payload that
   * moved a date. That the corpus replays identically with the dimension present
   * is the strongest form of this change's central claim: the scheduler does not
   * read a tag.
   *
   * **They are the row's STATED tags, and they must stay stated.**
   * `tags-accumulate` (ADR 0008) made the *effective* set a union of every
   * ancestor's, and this assertion survived it untouched because no replayed row
   * states a tag and this payload has never carried the effective reading. If it
   * ever goes red on a tag, the fix is not to lift `effectiveTagsOf` in here:
   * this file's claim is a replay-fidelity one, so an effective assertion would
   * report every future inheritance-rule change as a fidelity regression — and,
   * because an effective set is a function of tree shape, would test the walk
   * sixteen times inside a file about band identity, leaving a red unable to say
   * which of the two had broken.
   *
   * **`measures` is lifted by `token-tracking` (R10-C)**, and asserted empty for
   * `actuals`' reason exactly, one table over.
   */
  function lifted(
    tree: NonNullable<Awaited<ReturnType<WorkItemService['tree']>>>,
  ): Record<string, unknown> {
    const byId = new Map(tree.workItems.map((row) => [row.id, row]));
    const effectiveTeamOf = (rowId: string): string | null => {
      for (let at: string | null = rowId; at !== null; ) {
        const row = byId.get(at);
        if (row === undefined) return null;
        if (row.serviceTeamId !== null) return row.serviceTeamId;
        at = row.parentId;
      }
      return null;
    };

    const { depReach, pertWeights, estimateRounding, ...treeWithoutReach } = tree;
    // The weights and the rounding are lifted for `depReach`'s reason exactly —
    // the oracle predates both fields — and asserted rather than dropped, so a
    // replay that stopped setting them would fail here instead of being
    // measured against an oracle for an arithmetic it was not computed by.
    // `exact` is not the shipped default: it is what these captures were taken
    // under, when a step's figure reached the schedule as a fraction.
    expect(pertWeights).toEqual({ optimistic: 1, realistic: 4, pessimistic: 1 });
    expect(estimateRounding).toBe('exact');
    // **`depReach` is lifted by `dep-reach-whole-item` (2026-08-29)**, and
    // asserted to be the reach these plans were replayed on rather than
    // dropped. The oracle predates the setting entirely, so the payload now
    // carries a field the capture cannot have — a payload that gained a
    // field, which is not a payload that moved a date. Asserting it here is
    // what keeps the whole differential honest: if the replay ever stopped
    // setting `anchor-slice`, every one of these plans would be measured
    // against an oracle for a rule it was not scheduled by.
    expect(depReach).toBe('anchor-slice');
    return {
      ...treeWithoutReach,
      // The capture predates the pool named on each slice. Assert the new field
      // against the replayed plan, then lift it so the old scheduling oracle
      // continues to compare only fields that existed when it was recorded.
      slices: tree.slices.map(({ capacityTeamId, lateBy, ...slice }) => {
        if (slice.boundBy === 'capacity') {
          const owed = effectiveTeamOf(slice.workItemId);
          expect(owed).not.toBeNull();
          expect(capacityTeamId).toBe(owed);
        } else {
          expect(capacityTeamId).toBeNull();
        }
        // **`lateBy` is lifted by `work-item-deadline` 5.2**, for
        // `capacityTeamId`'s reason and asserted null rather than dropped. The
        // oracle predates the field, so every slice now carries a key the
        // capture cannot have — a payload that gained a field, which is not a
        // payload that moved a date. Null is the assertion and not a
        // convenience: no work item in these sixteen plans carries a deadline,
        // so a replay reporting any slice late would mean the engine had
        // invented a date rather than read one. The column exists as of
        // `b2bb095c`, is readable and writable as of slice 6, and the plan read
        // resolves it into `schedule()`'s seventh argument as of 3.4/4.2 — so
        // what keeps the claim true is the **corpus** alone: none of these
        // sixteen plans states a deadline, and a row with none is absent from
        // the map the read builds.
        expect(lateBy).toBeNull();
        return slice;
      }),
      workItems: tree.workItems.map(
        ({
          teamIds,
          tagIds,
          serviceIds,
          typeIds,
          externalRefs,
          actuals,
          measures,
          progress,
          state,
          serviceId,
          startNoEarlierThanReason,
          deadline,
          ...row
        }) => {
          // Lifted by `work-item-deadline` 6.1, which made the column readable,
          // and asserted **null** for `tagIds`' reason: the oracle predates the
          // column, nothing in sixteen replayed plans sets one, and a null on
          // every row is this slice's own claim — the read path widened by one
          // column and invented no date on the way. A bare lift would let a
          // projection that defaulted the column to today pass silently.
          expect(deadline).toBeNull();
          expect(teamIds).toEqual(row.serviceTeamId === null ? [] : [row.serviceTeamId]);
          // `tagIds` is lifted the same way by `tags` (R10-B) and asserted **empty**
          // for `actuals`' reason: the oracle predates the dimension, nothing in
          // sixteen replayed plans is labelled, and an empty set on every row is
          // this change's own claim — a plan nobody has tagged reads as untagged.
          // A bare lift would let a read path that invented a label pass silently.
          expect(tagIds).toEqual([]);
          // `serviceIds` is lifted and asserted empty for `tagIds`' reason exactly,
          // one dimension over: the oracle predates the dimension, no row in the
          // replayed plans delivers a service, and the empty set on every one of
          // them is task 10.2's own claim — the read path widened from a column to
          // a join and invented nothing on the way.
          expect(serviceIds).toEqual([]);
          // `typeIds` is lifted and asserted empty for `serviceIds`' reason
          // exactly, one dimension over: the oracle predates `work-item-types`,
          // no row in the replayed plans carries one, and the empty set on every
          // one of them is this change's own claim.
          //
          // It carries a second claim the other three cannot. A type does not
          // inherit (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`),
          // so `[]` here is the whole answer rather than the stated half of one —
          // and on a corpus where nothing is typed at all, an inheriting walk
          // added out of symmetry with `effectiveTagsOf` would be invisible here.
          // The negative for that lives in `work-item-type.test.ts`, on a tree
          // that does carry a type.
          expect(typeIds).toEqual([]);
          // `externalRefs` is lifted and asserted empty for `serviceIds`' reason exactly:
          // the oracle predates `external-refs`, no row in the replayed plans links to
          // anything, and the empty list on every one of them is that change's own
          // claim — the payload grew a field and moved no date.
          expect(externalRefs).toEqual([]);
          expect(actuals).toEqual({});
          // `measures` is lifted by `token-tracking` (R10-C) and asserted empty
          // for `actuals`' reason, one table over. The oracle predates
          // `step_measure` entirely, so every row now carries a key the capture
          // cannot have — and `{}` is the whole object rather than three empty
          // metrics, because a metric nobody recorded is struck rather than
          // carried. Sixteen replayed plans reporting no metrics at all is this
          // change's claim about itself: a figure that is not a day reaches
          // nothing that schedules, and none was invented on the way out.
          expect(measures).toEqual({});
          // `progress` and `state` are lifted the same way by `role-progress`
          // (R6 H2b), and asserted for `actuals`' reason: an empty object and
          // `not_started` on every row of sixteen replayed plans is that change's
          // own claim — nobody has said anything, and a fold that invented a state
          // would otherwise pass here silently.
          expect(progress).toEqual({});
          expect(state).toBe('not_started');
          // Lifted for the reason every key above it is, and the newest one:
          // `serviceId` came with task 10.2's column and
          // `startNoEarlierThanReason` with the words beside a not-before date,
          // and the oracle predates both. Until 2026-09-02 this corpus was
          // replayed through row literals that simply **lacked** them — not a
          // `WorkItem`, and a type error no `typecheck` target compiled. Built
          // whole, the answer carries both keys and the pinned document cannot.
          // `null` on every replayed row is the claim; a bare lift would hide a
          // read path that invented either.
          expect(serviceId).toBeNull();
          expect(startNoEarlierThanReason).toBeNull();
          return row;
        },
      ),
    };
  }

  /**
   * How much of the captured answer a plan is still compared against.
   *
   * Whole for the three plans in which every pair is estimated, and with the
   * placement set aside for the thirteen `assumed-duration-schedules` moves on
   * purpose — see {@link withoutPlacement} for what that does and does not
   * remove, and the ladder-against-ladder test above for the claim this file
   * makes without any oracle at all.
   */
  const narrowedFor =
    (plan: CapturedPlan) =>
    (document: Record<string, unknown>): Record<string, unknown> =>
      // `withSnappedRollUps` on both sides for the reassociated parent totals
      // `estimate-weights-and-rounding` introduced — see its JSDoc for the one
      // row in this corpus it is about and why 1e-9 cannot hide a real move.
      withSnappedRollUps(isFullyEstimated(plan) ? document : withoutPlacement(document));

  /** What the payload is owed: the capture, plus the two keys it predates. */
  function expected(
    plan: CapturedPlan,
    answer: Record<string, unknown>,
    bands: readonly PriorityBand[],
  ): Record<string, unknown> {
    return {
      project: plan.projectId,
      ...answer,
      // `capacity-per-project`'s addition, carrying {@link CAPACITIES} in the
      // order `listFor` gives. Identical across both replays.
      teamCapacities: Object.entries(CAPACITIES)
        .map(([serviceTeamId, size]) => ({ serviceTeamId, size }))
        .sort((a, b) => a.serviceTeamId.localeCompare(b.serviceTeamId)),
      // This change's addition, and the **only** difference between the two
      // replays above. Everything else in this object is byte-identical across
      // them, which is the whole measurement.
      priorityBands: [...bands],
    };
  }

  let dir: string | null = null;

  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  beforeEach(() => {
    dir = null;
  });

  /**
   * The oracle's projects written the way the release being replaced wrote them,
   * then migrated forward — and the ladder `listFor` reads back.
   *
   * The `INSERT`s are written out rather than built through drizzle, exactly as
   * `migrate.test.ts` writes them and for the same reason: drizzle is the new
   * release, and the point is the state the old one left behind.
   */
  async function ladderAfterTheMigration(): Promise<PriorityBand[]> {
    dir = mkdtempSync(join(tmpdir(), 'wbs-band-identity-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    rollbackTo(path, FOLDER, PRE_BANDS);
    const before = openDatabase(path);
    try {
      before.run(
        "INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'owner', 'x', 1)",
      );
      for (const plan of oracle.plans) {
        before.run(
          'INSERT INTO project (id, name, owner_id, restricted, estimate_method, start_date, revision, created_at)' +
            ` VALUES (?, ?, 'u', 0, ?, ?, 0, 1)`,
          [plan.projectId, `Plan ${plan.projectId}`, plan.estimateMethod, plan.startDate],
        );
      }
    } finally {
      before.close();
    }

    runMigrations(path, FOLDER);

    const store = new PriorityBandRepository(openDrizzle(path));
    const first = oracle.plans.at(0);
    if (first === undefined) throw new Error('the oracle holds no plans');
    const seeded = await store.listFor(first.projectId);
    // Every project, not only the first: the seeding is a cartesian one row per
    // project per rung, and a `SELECT` that reached one project would pass an
    // assertion made about one.
    for (const plan of oracle.plans) {
      expect(await store.listFor(plan.projectId)).toEqual(seeded);
    }
    return seeded;
  }

  /** One captured plan, rebuilt behind this branch's service and read back through it. */
  async function replay(
    plan: CapturedPlan,
    bands: readonly PriorityBand[],
  ): Promise<NonNullable<Awaited<ReturnType<WorkItemService['tree']>>>> {
    const projects = inMemoryProjects();
    const directory = inMemoryDirectory(
      (projectId): Promise<readonly { id: string }[]> => workItems.listByProject(projectId),
    );
    const workItems = inMemoryWorkItems(directory);
    const estimates = inMemoryEstimates(workItems);
    const actuals = inMemoryActuals(workItems);
    const measures = inMemoryMeasures(workItems);
    const progress = inMemoryProgress(workItems);
    const dependencies = inMemoryDependencies();
    const service = new WorkItemService({
      workItems,
      projects,
      estimates,
      actuals,
      measures,
      progress,
      dependencies,
      directory,
      // The pools the capture was taken under — see {@link CAPACITIES}. Identical
      // across both replays, so the ladder is the only thing that differs.
      capacity: inMemoryCapacity({ [plan.projectId]: CAPACITIES }),
      priorityBands: inMemoryPriorityBands({ [plan.projectId]: bands }),
      subtrees: inMemorySubtrees({
        workItems,
        estimates,
        actuals,
        measures,
        progress,
        dependencies,
        directory,
      }),
      journal: inMemoryCommandJournal(),
      broadcast: recordingBroadcaster(),
    });

    for (const team of oracle.teams)
      await directory.addTeam({ id: team.id, name: team.name }, STAMP);
    for (const who of oracle.people) await directory.addPerson({ ...who }, [], STAMP);

    const project: Project = projectRow({
      id: plan.projectId,
      name: `Plan ${plan.projectId}`,
      ownerId: 'owner',
      estimateMethod: plan.estimateMethod,
      // The arithmetic this capture was taken under: a step's figure reached
      // the schedule as the fraction the method produced. See
      // `estimate-weights-and-rounding`, which made `ceil` the default for
      // every project and left `exact` as the arm an oracle replays on.
      estimateRounding: 'exact',
      // The oracle was captured at a tip whose engine had no reach at all and
      // waited on the anchor slice, so these plans are replayed on
      // `anchor-slice`. Replaying them on the default would be measuring
      // `dep-reach-whole-item` with a differential written about a different
      // change, and the two would fail each other's claims for ever after.
      depReach: 'anchor-slice',
      startDate: plan.startDate,
    });
    const steps: Step[] = plan.stepIds.map((id, place) => ({
      id,
      projectId: plan.projectId,
      name: `Step ${String(place)}`,
      position: (place + 1) * STEP_POSITION_STEP,
    }));
    await projects.create(project, steps, STAMP);
    for (const row of plan.rows) {
      const stored: WorkItem = workItemRow({
        id: row.id,
        projectId: plan.projectId,
        parentId: row.parentId,
        position: row.position,
        name: row.name,
        priority: row.priority,
        maxParallel: row.maxParallel,
        startNoEarlierThan: row.startNoEarlierThan,
        serviceTeamId: row.serviceTeamId,
      });
      await workItems.insert(stored, [], STAMP);
    }
    // After the rows, so an estimate is never written against a work item that is
    // not there yet — the fixture mirrors the foreign key.
    for (const row of plan.rows) {
      for (const [stepId, days] of Object.entries(row.estimates)) {
        await estimates.set({ workItemId: row.id, stepId, ...days }, STAMP);
      }
      for (const [stepId, personId] of Object.entries(row.assignees)) {
        await directory.assign(row.id, stepId, personId, STAMP);
      }
      for (const predecessorId of row.dependsOn) {
        const edge: StoredDependency = {
          id: `${predecessorId}->${row.id}`,
          projectId: plan.projectId,
          predecessorId,
          successorId: row.id,
        };
        await dependencies.add(edge, STAMP);
      }
    }

    const tree = await service.tree(plan.projectId);
    if (tree === null) throw new Error(`${plan.projectId} vanished on replay`);
    return tree;
  }
});

/** Which band holds a priority, by name — the assertion's own reading, kept tiny on purpose. */
function labelIn(bands: readonly PriorityBand[], priority: number): string {
  let held = bands.at(0);
  for (const band of bands) if (band.startsAt <= priority) held = band;
  return held === undefined ? '' : held.label;
}
