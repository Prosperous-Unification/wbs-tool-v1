import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Project, Step, StoredDependency, WorkItem, WriteStamp } from '../repository';
import { STEP_POSITION_STEP } from '../repository';
import { CapacityRepository } from '../repository/capacity';
import { openDatabase, openDrizzle } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { rollbackTo } from '../repository/migrate-down';
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
/** The pre-C5 tip: `main@050fd45`'s schema, and the state the migration runs against. */
const PRE_C5 = '20260812100001_add_max_parallel';
/**
 * The stamp every replayed write carries. The oracle was captured before a write
 * recorded who made it, so the plan's own owner stands in for the actor and the
 * instant is fixed — nothing here is a claim about either.
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
  /** Whatever `tree()` answered. Compared whole, so it is deliberately not narrowed. */
  answers: Record<string, unknown>[];
}

// The boundary: a file captured from a be-01 that no longer exists, read as the
// fixture it is. Nothing here validates it into existence — the first test below
// asserts the shape and the coverage the rest of the file depends on, and would
// fail loudly on a recapture of something thinner.
const oracle = captured as unknown as Oracle;

/**
 * The pre-`capacity-per-project` identity differential: **Claim B** of that
 * change's `design.md` D7, and — since `team-sets` (2026-08-14) — of that
 * change's D5 as well.
 *
 * One oracle, two changes, deliberately not two copies of a 150-line replay
 * harness: the fixture was captured at `050fd45`, which is before either of
 * them, so it measures both at once. What `team-sets` adds is `teamIds` on
 * every row, lifted off below and asserted separately, since a payload that
 * gained a field is not a payload that moved a date.
 *
 * The promise this change makes is that every plan on the deployment schedules
 * byte-identically across the migration. It decomposes into two claims, and
 * either on its own reads like the whole thing and is not:
 *
 * - **Claim A**, in `repository/migrate.test.ts`: the migration writes one row per
 *   (existing project, sized team) carrying that team's global number.
 * - **Claim B**, here: those numbers produce the answer be-01 gave before the
 *   change — every field of every work item and every slice.
 *
 * And the wire between them, `slotsFor`, is pinned on its own in
 * `repository/capacity.test.ts`, because Claim B holds `slotsFor`'s *output* fixed
 * by construction and a `slotsFor` reading the wrong column would pass both.
 *
 * **The oracle is data, not a copied function.** C1's identity differential copied
 * the previous engine into its test file, because the engine was one pure function
 * and copying it was cheap. What changed here is the **adapter**, and copying
 * `tree()` would be copying six collaborators and their fixtures — a copy large
 * enough that its own drift is the likelier bug. So
 * `fixtures/capacity-oracle-2026-08-13.json` holds sixteen plans *and* the answer
 * be-01 gave each of them, written by `apps/be-01/tools/capture-capacity-oracle.ts` run at
 * `050fd45` before this branch had a line of code in it (its own commit, so `git
 * log` shows the oracle predates the code it measures).
 *
 * **Re-running that script against this branch would prove nothing** — it would
 * measure the new code against itself. The JSON is the pin; the script is
 * committed for reproducibility only.
 *
 * The plans are read **out of the fixture** rather than regenerated from a shared
 * generator, for the same reason: a generator both sides call is free to drift in
 * one direction and take the whole differential with it.
 */
describe('every plan schedules identically across the migration', () => {
  it('has an oracle worth measuring against, captured before this branch existed', () => {
    // `schedule-identity.test.ts`'s `generates plans worth measuring` rule. A
    // recapture that lost any of this makes the differential below vacuous while
    // leaving it green, so the coverage is asserted rather than assumed.
    expect(oracle.capturedFrom).toBe('050fd45');
    expect(oracle.plans).toHaveLength(16);
    expect(oracle.answers).toHaveLength(16);

    const rows = oracle.plans.flatMap((plan) => plan.rows);
    expect(rows).toHaveLength(151);
    // Every estimate method, so the differential covers what a plan is computed
    // in and not only PERT.
    expect([...new Set(oracle.plans.map((plan) => plan.estimateMethod))].sort()).toEqual([
      'optimistic',
      'pert',
      'pessimistic',
      'realistic',
    ]);
    // Plans off the calendar, and manual dates on plans that are on it.
    expect(oracle.plans.filter((plan) => plan.startDate === null)).toHaveLength(2);
    expect(
      oracle.plans.filter((plan) => plan.rows.some((row) => row.startNoEarlierThan !== null)),
    ).toHaveLength(3);
    // Every team including the unsized one, and the unlabelled case.
    expect([...new Set(rows.map((row) => row.serviceTeamId))].sort()).toEqual([
      null,
      'team-backend',
      'team-design',
      'team-platform',
      'team-unsized',
    ]);
    expect(oracle.teams.filter((team) => team.size === null)).toHaveLength(1);
    // Parents that carry a label whose leaves do not — the inheritance case the
    // pool is drawn through.
    expect(
      oracle.plans.some((plan) =>
        plan.rows.some(
          (row) =>
            row.parentId === null &&
            row.serviceTeamId !== null &&
            plan.rows.some((leaf) => leaf.parentId === row.id && leaf.serviceTeamId === null),
        ),
      ),
    ).toBe(true);

    const slices = oracle.answers.flatMap((answer) => answer['slices'] as { boundBy: string }[]);
    // All six binding floors, and capacity among them 25 times: without those the
    // differential would be measuring plans no pool ever touched.
    expect([...new Set(slices.map((slice) => slice.boundBy))].sort()).toEqual([
      'capacity',
      'notBefore',
      'person',
      'predecessor',
      'projectStart',
      'stepOrder',
    ]);
    expect(slices.filter((slice) => slice.boundBy === 'capacity')).toHaveLength(25);
    expect(
      oracle.answers.reduce((sum, answer) => sum + (answer['waitingForCapacity'] as number), 0),
    ).toBe(18);
    // Widths above one, so the parallelism arm of the adapter is exercised too.
    expect(
      [...new Set(slices.map((slice) => (slice as unknown as { width: number }).width))].sort(),
    ).toEqual([1, 2, 3]);
    // And no plan in the corpus failed to schedule, which would make its answer a
    // page of `UNSCHEDULED` and assert nothing.
    for (const answer of oracle.answers) expect(answer['scheduleError']).toBeNull();
  });

  it('answers exactly what be-01 answered, with the migration’s own seeded numbers', async () => {
    let fullyEstimated = 0;
    let moved = 0;
    // The claim, and the two halves of how it is set up are both load-bearing.
    //
    // The **numbers** come from the real migration: a temp database rolled back to
    // the pre-C5 tip, the teams written the way the outgoing release writes them
    // with their global sizes, then migrated forward. Nothing here decides what
    // gets seeded; `runMigrations` does, and `slotsFor` reads back what it wrote.
    //
    // The **plans** come out of the fixture and are replayed through this branch's
    // service. So the only thing that could make this pass while the change is
    // wrong is `slotsFor` and the migration agreeing on a wrong answer, which is
    // what `repository/capacity.test.ts` exists for.
    //
    // Proof: the seeded map replaced by an empty one — every pair unstated, which
    // is the shape of forgetting the seeding altogether — and this failed on `p1`'s
    // very first comparison: `p1-g0-l0step-1` came back `boundBy: 'stepOrder'` with
    // an empty `capacityPredecessorIds` where `boundBy: 'capacity'` and four
    // predecessors were owed, and its `earliestStart` moved 7.5 → 3. Watched
    // 2026-08-13.
    //
    // **What this test cannot see, stated because a reader would assume it can.**
    // Seeding only the pairs a plan already labels — the join `design.md` D2
    // rejects — would leave this green **on a database with work items in it**:
    // every date in the corpus is identical under it, because a pair labelling
    // nothing spends no slots. That is exactly D2's point, and exactly why the
    // promise needs `migrate.test.ts`'s `seeds every project that existed…` and
    // the third test in this file, not this one alone.
    //
    // **Reasoned, not watched, and this comment claimed otherwise until the
    // 2026-08-13 cross-review ran it.** The injection gives 1 pass / 2 fail here,
    // and not because the join is caught: `slotsAfterTheMigration()` below writes
    // no work items at all — it does not need any, since the plans are replayed
    // through in-memory stores — so a seeding joined over `work_item` matches
    // nothing, seeds nothing, and degenerates into the empty-map injection two
    // paragraphs up. The first failure's output is character-for-character the
    // one quoted there. The argument stands; the run does not support it.
    const seeded = await slotsAfterTheMigration();

    for (const [at, plan] of oracle.plans.entries()) {
      // `.at`, so a fixture with fewer answers than plans throws here rather than
      // spreading `undefined` into the comparison and passing against nothing.
      const answer = oracle.answers.at(at);
      if (answer === undefined) throw new Error(`no captured answer for ${plan.projectId}`);
      const tree = await replay(plan, seeded);
      // `teamIds` is lifted off every row before the comparison and asserted on
      // its own below, because the oracle predates the field and a payload that
      // gained one is not the payload that lost a date. Lifting rather than
      // listing the fields the oracle *does* carry: a projection is a minimum
      // over slices and can hide a slice that moved under one that did not, and
      // a hand-written field list is a list to forget to extend.
      //
      // Both halves are load-bearing and each is green under the other's fault.
      // `team-sets` design.md D5.
      const parentOf = new Map(plan.rows.map((row) => [row.id, row.parentId]));
      const ownTeam = new Map(plan.rows.map((row) => [row.id, row.serviceTeamId]));
      const sized = new Set(
        oracle.teams.filter((team) => team.size !== null).map((team) => team.id),
      );
      /** The label in force on a row: its own, else the nearest ancestor's. */
      const effectiveTeamOf = (rowId: string): string | null => {
        for (let at: string | null | undefined = rowId; at !== null && at !== undefined;) {
          const own = ownTeam.get(at);
          if (own !== undefined && own !== null) return own;
          at = parentOf.get(at);
        }
        return null;
      };
      const { depReach, pertWeights, estimateRounding, ...treeWithoutReach } = tree;
      // The weights and the rounding are lifted for `depReach`'s reason exactly
      // — the oracle predates both fields — and asserted rather than dropped so
      // that a replay which stopped setting them would fail here instead of
      // measuring these plans against an oracle for an arithmetic they were not
      // computed by. `exact` is not the shipped default: it is the arithmetic
      // these captures were taken under, when a step's figure was a fraction
      // and reached the schedule as one.
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
      const lifted = {
        ...treeWithoutReach,
        // `capacityTeamId` is lifted off every slice for `teamIds`' reason and
        // asserted on its own here: the oracle predates the field, and a
        // payload that gained one is not a payload that moved a date.
        // `lateBy` comes off beside it, by `work-item-deadline` 5.2 and for the
        // same reason, asserted null rather than dropped: no plan in this
        // corpus carries a deadline, so a slice reporting itself late would be
        // the engine inventing a date. The column exists as of `b2bb095c`, is
        // readable and writable as of slice 6, and the plan read resolves it
        // into `schedule()`'s seventh argument as of 3.4/4.2 — so the reason the
        // null holds is now the **corpus** alone: not one of the sixteen
        // replayed plans states a deadline, and a row with none is absent from
        // the map. See `priority-band-identity.db.test.ts`, which asserts the
        // same null for the same reason.
        slices: tree.slices.map(({ capacityTeamId, lateBy, ...slice }) => {
          if (slice.boundBy === 'capacity') {
            const owed = effectiveTeamOf(slice.workItemId);
            expect(owed).not.toBeNull();
            expect(sized.has(owed ?? '')).toBe(true);
            expect(capacityTeamId).toBe(owed);
          } else {
            expect(capacityTeamId).toBeNull();
          }
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
            // The arity claim, and the only place it is made: the set the join
            // answered is exactly the singleton of the label the oracle recorded.
            //
            // Proof, both watched 2026-08-14 and each green under the other's
            // fault. This assertion: the fixture's join derivation replaced by
            // one that answers `[]` for every row, and it failed on
            // `Expected - 3 / Received + 1` — a labelled row whose set is empty,
            // which is the shape of a write path that forgot the join. The lift
            // itself: before it existed, the whole-document comparison failed on
            // the oracle's very first labelled row with `+ "teamIds": [
            // "team-unsized" ]` and nothing else in the diff — the payload had
            // gained a field and moved no date, which is this change's claim
            // arriving as a red test.
            expect(teamIds).toEqual(row.serviceTeamId === null ? [] : [row.serviceTeamId]);
            // `tagIds` is lifted the same way by `tags` (R10-B) and asserted **empty**
            // for `actuals`' reason: the oracle predates the dimension, nothing in
            // sixteen replayed plans is labelled, and an empty set on every row is
            // this change's own claim — a plan nobody has tagged reads as untagged.
            // A bare lift would let a read path that invented a label pass silently.
            //
            // **These are the row's STATED tags, and they must stay stated.**
            // `tags-accumulate` (ADR 0008) made the *effective* set a union of
            // every ancestor's, and this assertion survived it untouched because
            // no replayed row states a tag and this payload has never carried the
            // effective reading. If it ever goes red on a tag, the fix is not to
            // lift `effectiveTagsOf` in here: this file's claim is that a plan
            // schedules identically across a migration, so an effective assertion
            // would report every future inheritance-rule change as a fidelity
            // regression — and, because an effective set is a function of tree
            // shape, would test the walk sixteen times inside a file about
            // migration identity, leaving a red unable to say which broke.
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
            // so `[]` here is the whole answer rather than the stated half of one:
            // an inheriting walk added to this dimension out of symmetry with
            // `effectiveTagsOf` would leave every descendant of a typed row
            // carrying a type nobody wrote, and on a corpus where nothing is typed
            // at all that fault is invisible *here* — which is why the negative for
            // it lives in `work-item-type.test.ts`, on a tree that does carry one.
            expect(typeIds).toEqual([]);
            // `externalRefs` is lifted and asserted empty for `serviceIds`' reason exactly:
            // the oracle predates `external-refs`, no row in the replayed plans links to
            // anything, and the empty list on every one of them is that change's own
            // claim — the payload grew a field and moved no date.
            expect(externalRefs).toEqual([]);
            // Lifted for `teamIds`' reason and asserted for the same one:
            // `actual-days` (R6 H2) put this key on every row and the oracle
            // predates the table. Empty on all sixteen replayed plans is the
            // claim — nothing recorded reads as nothing recorded, never as zero —
            // and a bare lift would hide a roll-up that invented a figure.
            expect(actuals).toEqual({});
            // Lifted for `actuals`' reason and asserted for the same one, one
            // table over: `token-tracking` put this key on every row and the
            // oracle predates `step_measure` entirely. `{}` here is the whole
            // object and not three empty metrics — a metric nobody recorded is
            // struck rather than carried — so this one assertion is both of the
            // change's absence rules at once, and a bare lift would hide a fold
            // that invented a figure or a payload that carried `hours_actual: {}`
            // on a plan where nobody ever opened the column.
            expect(measures).toEqual({});
            // Lifted for `actuals`' reason and asserted for the same one:
            // `role-progress` (R6 H2b) put two more keys on every row and the
            // oracle predates the table. `{}` and `not_started` on all sixteen
            // replayed plans is the claim — nobody having said anything reads as
            // nobody having said anything, never as untouched-therefore-done — and
            // a bare lift would hide a fold that invented a state.
            expect(progress).toEqual({});
            expect(state).toBe('not_started');
            // The last two lifts, and the newest reason: both keys are on the
            // row today and the oracle predates both — `serviceId` came with
            // task 10.2's column, `startNoEarlierThanReason` with the words
            // beside a not-before date. Until 2026-09-02 the corpus was replayed
            // through row literals that simply **lacked** them, which is not a
            // `WorkItem` and was a type error no `typecheck` target compiled;
            // built whole, the answer carries both and the pinned document
            // cannot. `null` on all sixteen replayed plans is the claim — no row
            // in this corpus delivers a service or says why it waits — and a
            // bare lift would hide a read path that invented either.
            expect(serviceId).toBeNull();
            expect(startNoEarlierThanReason).toBeNull();
            // The third of the same kind, and the newest: `work-item-deadline`
            // slice 6 made `work_item.deadline` readable, so every row now
            // carries a key the pinned document predates. `null` on all sixteen
            // replayed plans is the claim — no row in this corpus has a deadline
            // and none was invented by the read path that widened to carry one —
            // and a bare lift would hide a projection that defaulted the column.
            expect(deadline).toBeNull();
            return row;
          },
        ),
      };
      // `assumed-duration-schedules` (2026-08-29): thirteen of these sixteen
      // plans leave a pair unestimated, and this change moves exactly those
      // plans' placement on purpose. The document is compared whole where the
      // two engines coincide and with the placement set aside where they do
      // not — see {@link withoutPlacement}, which also says what is *not* set
      // aside. `countMovedDates` below holds the part that is.
      // `withSnappedRollUps` on both sides for the reassociated parent totals
      // `estimate-weights-and-rounding` introduced — see its JSDoc for the one
      // row in this corpus it is about and why 1e-9 cannot hide a real move.
      const narrow = (document: Record<string, unknown>): Record<string, unknown> =>
        withSnappedRollUps(isFullyEstimated(plan) ? document : withoutPlacement(document));
      moved += countMovedDates(answer, tree);
      if (isFullyEstimated(plan)) fullyEstimated += 1;
      expect(narrow({ project: plan.projectId, ...lifted })).toEqual(
        narrow({
          project: plan.projectId,
          ...answer,
          // The one key the capture could not carry, because it did not exist:
          // `teamCapacities` is this change's own addition to the payload. Its
          // *values* are the seeded numbers, which is the thing under test, so it is
          // asserted here rather than deleted from the comparison.
          teamCapacities: [...(seeded.get(plan.projectId) ?? new Map<string, number>())]
            .map(([serviceTeamId, size]) => ({ serviceTeamId, size }))
            .sort((a, b) => a.serviceTeamId.localeCompare(b.serviceTeamId)),
          // The second key the capture predates, added by `priority-bands`. Its
          // presence here is the whole of that change's effect on this
          // differential: the ladder is read into the payload and passed to
          // nothing, so every date, every slice and every other field is
          // byte-identical to the answer captured at `050fd45`. The claim in the
          // other direction — that a project which has **re-cut** its ladder
          // schedules identically too — is `priority-band-identity.test.ts`, and
          // it is that change's to make rather than this file's.
          priorityBands: DEFAULT_PRIORITY_BANDS,
        }),
      );
    }
    // The corpus halves of the narrowing, both of which a silent regression
    // would take with it: three plans compared whole, and a placement that
    // really did move on the other thirteen.
    expect(fullyEstimated).toBe(3);
    expect(moved).toBeGreaterThan(0);
  });

  it('gives every project the same numbers, which is what makes the identity hold', async () => {
    // Why the differential can pass at all: before the change, two projects
    // labelled `Platform` were each told they had all of it, and after it each was
    // seeded with that same number. The identity is not a property of the engine —
    // it is a property of the **seeding**, and this is that property stated on its
    // own so a reader does not have to infer it from 16 passing comparisons.
    const seeded = await slotsAfterTheMigration();

    // A predicate rather than a boolean: a plain `filter` leaves `size` as
    // `number | null`, and `toBe(null)` is not the claim this makes.
    const sized = oracle.teams.filter(
      (team): team is (typeof oracle.teams)[number] & { size: number } => team.size !== null,
    );
    for (const plan of oracle.plans) {
      const slots = seeded.get(plan.projectId);
      if (slots === undefined) throw new Error(`${plan.projectId} was seeded nothing at all`);
      for (const team of sized) expect(slots.get(team.id)).toBe(team.size);
      // The unsized team is seeded nowhere, so it is absent — which is unstated,
      // which is what it was before the migration.
      for (const team of oracle.teams.filter((each) => each.size === null)) {
        expect(slots.has(team.id)).toBe(false);
      }
    }
  });

  let dir: string | null = null;

  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /**
   * The oracle's teams and projects written the way the release being replaced
   * wrote them, then migrated forward — and the numbers `slotsFor` reads back.
   *
   * The `INSERT`s are written out rather than built through drizzle, exactly as
   * `migrate.test.ts` writes them and for the same reason: drizzle is the new
   * release, and the point is the state the old one left behind.
   */
  async function slotsAfterTheMigration(): Promise<Map<string, Map<string, number>>> {
    dir = mkdtempSync(join(tmpdir(), 'wbs-capacity-identity-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    rollbackTo(path, FOLDER, PRE_C5);
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
      for (const team of oracle.teams) {
        before.run('INSERT INTO service_team (id, name, size) VALUES (?, ?, ?)', [
          team.id,
          team.name,
          team.size,
        ]);
      }
    } finally {
      before.close();
    }

    runMigrations(path, FOLDER);

    const store = new CapacityRepository(openDrizzle(path));
    const seeded = new Map<string, Map<string, number>>();
    for (const plan of oracle.plans)
      seeded.set(plan.projectId, await store.slotsFor(plan.projectId));
    return seeded;
  }

  /** One captured plan, rebuilt behind this branch's service and read back through it. */
  async function replay(
    plan: CapturedPlan,
    seeded: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ): Promise<NonNullable<Awaited<ReturnType<WorkItemService['tree']>>>> {
    const projects = inMemoryProjects();
    const directory = inMemoryDirectory((projectId): Promise<readonly { id: string }[]> =>
      workItems.listByProject(projectId),
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
      capacity: inMemoryCapacity({
        [plan.projectId]: Object.fromEntries(seeded.get(plan.projectId) ?? []),
      }),
      priorityBands: inMemoryPriorityBands(),
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

    // The id and the name and nothing else: a team has no size to add since
    // `capacity-per-project`, and the captured `size` is deliberately left in
    // the oracle rather than carried in here — a fixture that spread it would
    // be handing a build that still fell back to the global column the numbers
    // that make the fallback look right. The type refuses that spread now.
    for (const team of oracle.teams)
      await directory.addTeam({ id: team.id, name: team.name }, STAMP);
    for (const who of oracle.people) await directory.addPerson({ ...who }, [], STAMP);

    const project: Project = projectRow({
      id: plan.projectId,
      name: `Plan ${plan.projectId}`,
      ownerId: 'owner',
      estimateMethod: plan.estimateMethod,
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

  beforeEach(() => {
    dir = null;
  });
});
