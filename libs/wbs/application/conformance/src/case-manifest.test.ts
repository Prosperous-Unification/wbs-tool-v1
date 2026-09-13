import { describe, expect, it } from 'bun:test';

import {
  CASE_MANIFEST,
  type CaseRegistration,
  expectedCasesFor,
  SUPPLEMENTAL_CASE_MANIFEST,
} from './case-manifest';
import { runCases } from './case-runner';
import { certifyExecution } from './certification';
import { offeredDeclaration } from './source-declaration.test-support';

function passingRegistration(
  family: CaseRegistration['family'],
  caseId: CaseRegistration['caseId'],
): CaseRegistration {
  return {
    family,
    caseId,
    openAndRun: () =>
      Promise.resolve({
        fixtureId: `${family}:${caseId}`,
        assert: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
  };
}

describe('the closed case manifest', () => {
  it('rejects a missing family', async () => {
    const declaration = offeredDeclaration();
    const expected = expectedCasesFor(declaration.historyAdmission);
    const registrations = expected
      .filter(({ family }) => family !== 'projects')
      .map(({ family, caseId }) => passingRegistration(family, caseId));
    const report = await runCases(registrations);

    // Proof: removing the registration exact-set check after the projects kit
    // was removed failed here: expected `missing registered cases`, received
    // `missing case reports: projects: projects.create:steps`.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('missing registered cases: projects: projects.create:steps');
  });

  it('rejects a duplicated case', async () => {
    const declaration = offeredDeclaration();
    const expected = expectedCasesFor(declaration.historyAdmission);
    const registrations = expected.map(({ family, caseId }) => passingRegistration(family, caseId));
    registrations.push(passingRegistration(expected[0].family, expected[0].caseId));
    const report = await runCases(registrations);

    // Proof: removing the registration duplicate check after duplicating the
    // first case failed here: expected `duplicate registered cases`, received
    // `duplicate case reports: projects: projects.create:steps`.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('duplicate registered cases');
  });

  it('contains the nineteen source families and exact history mechanisms', () => {
    expect(Object.keys(CASE_MANIFEST)).toEqual([
      'projects',
      'users',
      'directory',
      'capacity',
      'priorityBands',
      'calendarMarkers',
      'eventLog',
      'planEvents',
      'steps',
      'workItems',
      'estimates',
      'actuals',
      'measures',
      'progress',
      'dependencies',
      'subtrees',
      'journal',
      'savedPlans',
      'savedPlanCapture',
    ]);
    expect(SUPPLEMENTAL_CASE_MANIFEST).toEqual({
      common: ['history.batch:independent-commit', 'history.batch:independent-rollback'],
      immediateBusy: ['history.batch:busy-does-not-wait'],
      independentWrite: ['history.batch:interleaved-success-survives'],
    });
  });
});
