import {
  type CanonicalExternalRef,
  type CanonicalStepValue,
  combinedDays,
  type EstimateRule,
  type PlanInputRows,
} from '@wbs/domain';

import type { PlanInputReads } from '../repository/saved-plan-capture';

/**
 * Fold one capture's seventeen reads into the nineteen collections
 * `canonicalisePlanInput` folds again into the body.
 *
 * Two steps rather than one, and the seam is deliberate: this one knows the
 * store row shapes and nothing about ordering or hashing;
 * `canonicalisePlanInput` (`@wbs/domain`) knows the canonical order and nothing
 * about be-01. So nothing here sorts — every collection is handed over in
 * whatever order the read produced it, which is exactly the contract
 * {@link PlanInputRows} states it accepts. A sort added here would be a second
 * place stability is decided, and the day the two disagreed the hash would move
 * with neither of them changing.
 *
 * **Pure, and it holds no connection.** It runs after
 * `SavedPlanCaptureRepository.readPlanInput` has committed and closed
 * (`saved-plan-schedule.ts`, the same guarantee `schedulePlanInput` is written
 * under), over values already detached from the database.
 */
export function planInputRowsOf(reads: PlanInputReads): PlanInputRows {
  const rule: EstimateRule = {
    method: reads.project.estimateMethod,
    pertWeights: reads.project.pertWeights,
    rounding: reads.project.estimateRounding,
  };
  const captured = capturedDirectory(reads);
  return {
    project: {
      id: reads.project.id,
      name: reads.project.name,
      restricted: reads.project.restricted,
      ownerId: reads.project.ownerId,
      solutionSlug: reads.project.solutionRef?.slug ?? null,
      solutionUrl: reads.project.solutionRef?.url ?? null,
      estimateMethod: reads.project.estimateMethod,
      depReach: reads.project.depReach,
      estimateRounding: reads.project.estimateRounding,
      startDate: reads.project.startDate,
      pertWeightOptimistic: reads.project.pertWeights.optimistic,
      pertWeightRealistic: reads.project.pertWeights.realistic,
      pertWeightPessimistic: reads.project.pertWeights.pessimistic,
    },
    workItems: reads.workItems.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      position: row.position,
      name: row.name,
      notes: row.notes,
      typeIds: row.typeIds,
      tagIds: row.tagIds,
      // `position` is the **rank in this array**, not a column read. The read
      // type carries no position (`ExternalRef` is `{ id, systemId, url }`,
      // `repository/index.ts:481-485`) and does not need to: both readers order
      // by the column (`work-item.ts:220`, `directory.ts:171`) and the only
      // writer assigns `position: at` over the deduplicated list it is about to
      // insert, having first deleted every row for the item
      // (`work-item.ts:641-658`). So the stored numbers are dense from 0 in
      // exactly this order, and the index is the same fact with no second
      // spelling to disagree with. Ranking here is also the stabler of the two:
      // were a row ever spaced in gaps, two plans identical in every visible way
      // would hash apart on the spacing alone.
      // **A ref's `name` is deliberately not captured**, and this is the only
      // place that decision is visible, so it is written here. A snapshot exists
      // to compare *schedules*: `CANONICAL_PLAN_INPUT_SCHEMA_VERSION` is the
      // hashed shape, adding a field to it bumps the version and every stored
      // plan needs a normaliser for the reader — and what the field would buy is
      // a compare that mentions a label. A name moves no date, orders no queue
      // and is read by nothing in `libs/domain`.
      //
      // Nothing can lose a name by this, which is the half that makes the
      // omission safe rather than merely cheap: no path restores a saved plan
      // over live rows. Saved plans are written, listed, read and compared
      // (`saved-plan.controller.db.test.ts`), and a restore would be the change
      // that has to revisit this line.
      externalRefs: row.externalRefs.map((ref, at): CanonicalExternalRef => ({
        externalSystemId: ref.systemId,
        url: ref.url,
        position: at,
      })),
      priority: row.priority,
      maxParallel: row.maxParallel,
      frozenNumber: row.frozenNumber,
      serviceTeamId: row.serviceTeamId,
      serviceId: row.serviceId,
      startNoEarlierThan: row.startNoEarlierThan,
      startNoEarlierThanReason: row.startNoEarlierThanReason,
    })),
    steps: reads.steps.map((row) => ({ id: row.id, name: row.name, position: row.position })),
    stepValues: stepValuesOf(reads, rule),
    measures: reads.measures.map((row) => ({
      workItemId: row.workItemId,
      stepId: row.stepId,
      metric: row.metric,
      value: row.value,
    })),
    dependencies: reads.dependencies.map((row) => ({
      predecessorId: row.predecessorId,
      successorId: row.successorId,
    })),
    assignments: reads.assignments.map((row) => ({
      workItemId: row.workItemId,
      stepId: row.stepId,
      personId: row.personId,
    })),
    people: captured.people.map((row) => ({ id: row.id, name: row.name })),
    teams: captured.teams.map((row) => ({ id: row.id, name: row.name })),
    services: captured.services.map((row) => ({ id: row.id, name: row.name })),
    personTeams: captured.people.flatMap((person) =>
      person.teamIds
        .filter((teamId) => captured.teamIds.has(teamId))
        .map((teamId) => ({ personId: person.id, teamId })),
    ),
    teamServices: captured.teams.flatMap((team) =>
      team.serviceIds.map((serviceId) => ({ teamId: team.id, serviceId })),
    ),
    workItemTeams: reads.workItems.flatMap((row) =>
      row.teamIds.map((teamId) => ({ workItemId: row.id, teamId })),
    ),
    workItemServices: reads.workItems.flatMap((row) =>
      row.serviceIds.map((serviceId) => ({ workItemId: row.id, serviceId })),
    ),
    priorityBands: reads.priorityBands.map((band) => ({
      startsAt: band.startsAt,
      label: band.label,
      defaultValue: band.defaultValue,
    })),
    capacity: [...reads.capacity].map(([teamId, people]) => ({ teamId, people })),
    tags: referenced(
      reads.tags,
      reads.workItems.flatMap((row) => row.tagIds),
    ),
    workItemTypes: referenced(
      reads.workItemTypes,
      reads.workItems.flatMap((row) => row.typeIds),
    ),
    externalSystems: referenced(
      reads.externalSystems,
      reads.workItems.flatMap((row) => row.externalRefs.map((ref) => ref.systemId)),
    ),
  };
}

/**
 * One row per (work item, step) **any** of the three reads mentions.
 *
 * An outer join rather than a walk over the estimates: a step with an actual and
 * no estimate, or with progress stated and nothing else, is an ordinary state of
 * an early plan and is exactly the row a saved plan must not lose. The key is
 * the pair, and every read contributes keys to it.
 *
 * `derived` is `combinedDays` under the project's own rule — the *unrounded*
 * figure, which is what {@link CanonicalStepValue} names and what a reader
 * asking "what does this estimate mean" wants; everything that schedules uses
 * the rounded one and derives it again from the same three points. It is `null`
 * exactly when there is no estimate to combine, which is the same absence its
 * three points carry.
 *
 * Storing it at all, when the three points and the rule are both in the body, is
 * the deliberate part: `combinedDays` is a *semantics*, and a saved plan that
 * re-derived the figure on read would restate history the day the arithmetic
 * changed — the same reason the dates are materialised rather than recomputed.
 */
function stepValuesOf(reads: PlanInputReads, rule: EstimateRule): CanonicalStepValue[] {
  const keyOf = (workItemId: string, stepId: string): string => `${workItemId}\u0000${stepId}`;
  const pairs = new Map<string, { workItemId: string; stepId: string }>();
  const note = (workItemId: string, stepId: string): void => {
    pairs.set(keyOf(workItemId, stepId), { workItemId, stepId });
  };
  for (const row of reads.estimates) note(row.workItemId, row.stepId);
  for (const row of reads.actuals) note(row.workItemId, row.stepId);
  for (const row of reads.progress) note(row.workItemId, row.stepId);

  const estimates = new Map(reads.estimates.map((row) => [keyOf(row.workItemId, row.stepId), row]));
  const actuals = new Map(reads.actuals.map((row) => [keyOf(row.workItemId, row.stepId), row]));
  const progress = new Map(reads.progress.map((row) => [keyOf(row.workItemId, row.stepId), row]));

  return [...pairs.values()].map((pair) => {
    const key = keyOf(pair.workItemId, pair.stepId);
    const estimate = estimates.get(key);
    return {
      workItemId: pair.workItemId,
      stepId: pair.stepId,
      optimistic: estimate?.optimistic ?? null,
      realistic: estimate?.realistic ?? null,
      pessimistic: estimate?.pessimistic ?? null,
      derived: estimate === undefined ? null : combinedDays(estimate, rule),
      actual: actuals.get(key)?.days ?? null,
      progress: progress.get(key)?.state ?? null,
    };
  });
}

/**
 * The directory rows this plan names, out of the global directory the capture
 * read unfiltered.
 *
 * The reads are the whole directory — `listPeople`, `listTeams` and
 * `listServices` take no project — and storing all of it would put every account
 * in the company into every saved plan's bytes and its hash, so two saves of an
 * unchanged plan would differ because somebody else hired a designer.
 *
 * **Teams** are the ones the plan names: through `work_item_team`, and through
 * the capacity map, whose keys are teams a project stated a number for and which
 * `saved-plan-capture.ts` records as nameable by nothing else.
 *
 * **People** are the assigned plus every member of a captured team — the spec's
 * rule, and its reason: an unassigned member of a team the plan constrains is a
 * `person_team` id that would otherwise be stored with no name.
 *
 * **Services** are those the plan names through `work_item_service`, plus every
 * service a captured team delivers, so `team_service` has no dangling id either.
 *
 * Assumption A-8: a captured team's `person_team` rows are narrowed to captured
 * teams only, not to every team its people belong to. Otherwise one shared
 * person drags in their other teams' names, then those teams' other members, and
 * the "referenced rows by value" bound is not a bound. Falsified if the read
 * path needs a person's full team list to render a saved plan.
 */
function capturedDirectory(reads: PlanInputReads): {
  people: PlanInputReads['people'];
  teams: PlanInputReads['teams'];
  services: PlanInputReads['services'];
  teamIds: ReadonlySet<string>;
} {
  const teamIds = new Set<string>(reads.capacity.keys());
  for (const row of reads.workItems) for (const id of row.teamIds) teamIds.add(id);
  const teams = reads.teams.filter((team) => teamIds.has(team.id));

  const personIds = new Set(reads.assignments.map((row) => row.personId));
  const people = reads.people.filter(
    (person) => personIds.has(person.id) || person.teamIds.some((id) => teamIds.has(id)),
  );

  const serviceIds = new Set<string>();
  for (const row of reads.workItems) for (const id of row.serviceIds) serviceIds.add(id);
  for (const team of teams) for (const id of team.serviceIds) serviceIds.add(id);
  const services = reads.services.filter((service) => serviceIds.has(service.id));

  return { people, teams, services, teamIds };
}

/** The registry rows whose ids the captured items actually use. */
function referenced(
  rows: readonly { id: string; name: string }[],
  usedIds: readonly string[],
): { id: string; name: string }[] {
  const used = new Set(usedIds);
  return rows.filter((row) => used.has(row.id)).map((row) => ({ id: row.id, name: row.name }));
}
