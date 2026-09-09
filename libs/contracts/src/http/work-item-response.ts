import { type } from 'arktype';

const scheduled = type({
  duration: 'number',
  estimated: 'boolean',
  earliestStart: 'number',
  earliestFinish: 'number',
  latestStart: 'number',
  latestFinish: 'number',
  float: 'number',
  critical: 'boolean',
});
const triple = type({ optimistic: 'number', realistic: 'number', pessimistic: 'number' });
const numbers = type({ '[string]': 'number' });
const named = type({ id: 'string', name: 'string' });
const numberedWorkItem = type({
  id: 'string',
  projectId: 'string',
  parentId: 'string | null',
  position: 'number',
  name: 'string',
  notes: 'string',
  frozenNumber: 'string | null',
  startNoEarlierThan: 'string | null',
  startNoEarlierThanReason: 'string | null',
  // Proof: widening deadline admitted false,200 instead of500 in the mounted tree case.
  deadline: 'string | null',
  priority: 'number | null',
  serviceTeamId: 'string | null',
  serviceId: 'string | null',
  maxParallel: 'number',
  revision: 'number',
  teamIds: type('string[]').readonly(),
  tagIds: type('string[]').readonly(),
  serviceIds: type('string[]').readonly(),
  typeIds: type('string[]').readonly(),
  // Proof: removing id made the direct production-client boundary test resolve a tree
  // containing numeric external-reference ids instead of rejecting.
  externalRefs: type({ id: 'string', systemId: 'string', url: 'string', name: 'string' })
    .array()
    .readonly(),
  number: 'string',
  estimates: type({ '[string]': triple }),
  rolledUp: 'boolean',
  actuals: numbers,
  progress: type({ '[string]': "'in_progress' | 'done'" }),
  state: "'not_started' | 'in_progress' | 'done'",
  measures: type({ '[string]': numbers }),
  dependsOn: 'string[]',
  finalDays: numbers,
  finalTotal: 'number',
  schedule: scheduled,
  dates: type({ startsOn: 'string', endsOn: 'string' }).or('null'),
  assignees: type({ '[string]': 'string' }),
  doesEveryStep: 'string | null',
});
const slice = scheduled.and({
  id: 'string',
  workItemId: 'string',
  stepId: 'string | null',
  personId: 'string | null',
  boundBy:
    "'projectStart' | 'predecessor' | 'stepOrder' | 'notBefore' | 'person' | 'capacity' | 'optimizer'",
  resourcePredecessorId: 'string | null',
  capacityPredecessorIds: 'string[]',
  capacityTeamId: 'string | null',
  // Proof: widening lateBy admitted text,200 instead of500 in the mounted tree case.
  width: 'number',
  effort: 'number',
  lateBy: 'number | null',
});
const optimizationVariant = type({ state: "'pending' | 'retrying' | 'idle'" })
  .or({
    state: "'ready'",
    proof: "'proven' | 'incomplete' | 'quantisation-floor'",
  })
  .or({
    state: "'failed'",
    reason:
      "'timeout' | 'invalid-output' | 'no-solution' | 'internal-error' | 'oom' | 'horizon-overflow' | 'objective-overflow'",
  })
  .or({ state: "'corrupt'", message: 'string' })
  .or({
    state: "'plan-infeasible'",
    items: type({
      ownerWorkItemId: 'string',
      boundWorkItemId: 'string',
      effectiveDeadlineOffset: 'number',
    })
      .array()
      .readonly(),
  });
const optimization = type({
  enabled: 'boolean',
  engine: "'fast' | 'optimized'",
  objective: "'pri' | 'time'",
  inputHash: 'string',
  generation: 'number | null',
  contractVersion: 'string',
  budgetMs: 'number',
  displayed: "'fast' | 'pri' | 'time'",
  variants: { pri: optimizationVariant, time: optimizationVariant },
  // Absolute finishes rather than one delta, and one entry per schedule the
  // read computed: the cue names Fast, PRI and Time together, every difference
  // is taken against Fast, and the delta is that subtraction through the shared
  // workday drift the client already applies. `fast` is required because a
  // read that carries this object at all has computed Fast — it is the
  // schedule the rows are placed by unless a variant displaces it.
  finishDays: { fast: 'number', 'pri?': 'number', 'time?': 'number' },
  // One boolean per variant that has a finish above, server-side per tasks.md
  // 8.7: the order relation is the half of the comparison a client cannot
  // derive from these numbers, and two implementations would disagree about
  // the same pair.
  sameOrderAsFast: { 'pri?': 'boolean', 'time?': 'boolean' },
});

/**
 * The complete project tree shared by reads and exports. Account-specific undo
 * flags are composed by the read endpoint, never required of a project export.
 * Wrap this raw declaration in responseSchema at the endpoint boundary so future
 * additive fields remain readable while every currently known field is checked.
 */
export const workItemTree = type({
  workItems: numberedWorkItem.array(),
  seq: 'number',
  scheduleError: "'cycle' | null",
  waitingForPerson: 'number',
  waitingForCapacity: 'number',
  slices: slice.array(),
  steps: type({ id: 'string', projectId: 'string', name: 'string', position: 'number' }).array(),
  assignedPeople: named.array(),
  teamCapacities: type({ serviceTeamId: 'string', size: 'number' }).array(),
  priorityBands: type({ startsAt: 'number', defaultValue: 'number', label: 'string' }).array(),
  estimateMethod: "'pert' | 'optimistic' | 'realistic' | 'pessimistic'",
  pertWeights: triple,
  estimateRounding: "'exact' | 'floor' | 'round' | 'ceil'",
  depReach: "'whole-item' | 'anchor-slice'",
  // Proof: making projectRevision optional admitted a missing producer field,200 instead of500 in the mounted tree case.
  startDate: 'string | null',
  projectRevision: 'number',
  // Proof: leaving this known response field unmodeled made the production-client
  // boundary test fail on `promise resolved … instead of rejecting` for `failed/unknown`.
  'optimization?': optimization,
});
