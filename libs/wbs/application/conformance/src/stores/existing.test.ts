import { describe, expect, it } from 'bun:test';

import type { CaseId } from '../case-manifest';
import { SOURCE_CONFORMANCE_CASES } from '../certification';
import { sourceConformanceRegistrations } from '../source-conformance';

describe('the migrated existing store kits', () => {
  it('preserves the original IDs and adds each completed family inventory', () => {
    const unopened = () => Promise.reject(new Error('ID inventory must not open a fixture'));
    const openers = {
      projects: unopened,
      users: unopened,
      capacity: unopened,
      priorityBands: unopened,
      calendarMarkers: unopened,
      workItems: unopened,
      steps: unopened,
      estimates: unopened,
      actuals: unopened,
      measures: unopened,
      progress: unopened,
      dependencies: unopened,
      directory: unopened,
      eventLog: unopened,
      planEvents: unopened,
      subtrees: unopened,
      journal: unopened,
      savedPlans: unopened,
      savedPlanCapture: unopened,
      historyBatch: unopened,
    };
    const memoryRegistrations = sourceConformanceRegistrations(
      { historyAdmission: 'independent-write' },
      openers,
    );
    const sqliteRegistrations = sourceConformanceRegistrations(
      { historyAdmission: 'immediate-busy' },
      openers,
    );
    const registrations = memoryRegistrations.slice(0, -3);

    // Proof: before subtreeRegistrations joined the production catalog, this
    // failed with both subtree IDs absent (`Expected - 2 / Received + 0`).
    // Proof: removing journalRegistrations from the production catalog failed
    // here with both journal IDs absent (`Expected - 2 / Received + 0`).
    // Proof: before Task 5.2's three registrations existed, this failed with
    // exactly those three IDs absent (`Expected - 3 / Received + 0`).
    // Proof: before savedPlanRegistrations joined the production catalog, this
    // failed with exactly the two Task 6.1 IDs absent (`Expected - 2 / Received + 0`).
    expect(registrations.map(({ caseId }) => caseId)).toEqual([
      'projects.create:steps',
      'projects.update:scope',
      'projects.recordOpen:reader-order',
      'users.create:unique-name',
      'users.find:identity',
      'users.resolveOidcIdentity:issuer-subject',
      'users.resolveOidcIdentity:verified-conflict',
      'capacity.set:project-team-key',
      'capacity.set:clear',
      'capacity.set:missing-reference',
      'priorityBands.listFor:defaults',
      'priorityBands.replace:whole-project',
      'priorityBands.replace:missing-project',
      'calendarMarkers.listFor:total-order',
      'calendarMarkers.write:project-scope',
      'workItems.listByIds:labels-scope',
      'workItems.listPlacements:source-order',
      'workItems.insert:respace',
      'workItems.patch:refusal-atomic',
      'workItems.move:parent-position',
      'workItems.remove:promotion',
      'workItems.setFrozenNumbers:clear',
      'steps.add',
      'steps.rename',
      'steps.rename:unknown',
      'estimates.listByWorkItems:scope-order',
      'estimates.listPlacements:source-order',
      'estimates.set',
      'estimates.set:replace',
      'estimates.set:unknown_step',
      'estimates.remove',
      'estimates.moveAll:ownership',
      'actuals.listPlacements:source-order',
      'actuals.listByWorkItems:scope-order',
      'actuals.set:replace',
      'actuals.remove:pair',
      'actuals.moveAll:ownership',
      'actuals.set:unknown_step',
      'measures.listPlacements:source-order',
      'measures.listByWorkItems:scope-order',
      'measures.set:metric-key',
      'measures.remove:metric-key',
      'measures.moveAll:all-metrics',
      'measures.set:unknown_step',
      'progress.listPlacements:source-order',
      'progress.listByWorkItems:scope-order',
      'progress.set:replace',
      'progress.remove:absence',
      'progress.moveAll:ownership',
      'progress.set:unknown_step',
      'dependencies.listByWorkItems:incident-scope',
      'dependencies.add:idempotent-pair',
      'dependencies.remove:pair',
      'dependencies.removeAllFor:touching-set',
      'directory.addTag',
      'directory.assign:unknown_person',
      'directory.assign:scope-replace-clear',
      'directory.patchTeam:atomic-refusal',
      'eventLog.recordEvent',
      'eventLog.rangeSince',
      'eventLog.pruneBeyond',
      'eventLog.pruneBeyond:empty-sequence',
      'planEvents.listFor:filters-order',
      'planEvents.pruneOlderThan:strict-cutoff',
      'subtrees.insertSubtree:complete-copy',
      'subtrees.insertSubtree:late-failure',
      'journal.append:history-atomic',
      'journal.append:account-redo-depth',
      'journal.flip:preconditions',
      'savedPlans.write:bytes-and-bodies',
      'savedPlans.write:quota-refusal',
      'savedPlans.write:quota-window',
      'savedPlans.touch:principals-scope',
      'savedPlans.write:late-body-failure',
      'savedPlanCapture.readPlanInput:complete',
      'savedPlanCapture.readPlanInput:coherent-interleave',
      'savedPlanCapture.readPlanInput:missing-project',
      'savedPlanCapture.readPlanInput:detached',
    ]);
    // Proof: before the independent implemented inventory was repaired, this
    // complete equality failed with the five work-item and two directory IDs absent.
    const implementedCaseIds: CaseId[] = [...SOURCE_CONFORMANCE_CASES];
    expect(implementedCaseIds).toEqual([
      ...sqliteRegistrations.map(({ caseId }) => caseId),
      'history.batch:interleaved-success-survives',
    ]);
  });
});
