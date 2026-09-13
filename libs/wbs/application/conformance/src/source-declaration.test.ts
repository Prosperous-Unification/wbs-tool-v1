import { describe, expect, it } from 'bun:test';

import { CASE_MANIFEST, type CaseId } from './case-manifest';
import { runCases } from './case-runner';
import { certifyExecution } from './certification';
import { offeredDeclaration, passingRegistrations } from './source-declaration.test-support';

describe('source declarations', () => {
  it('rejects a duplicated gap', async () => {
    const baseline = offeredDeclaration();
    const caseId = CASE_MANIFEST.projects[0];
    const gap = {
      caseId,
      reason: 'observed source lag',
      evidence: {
        sourceRevision: 'revision',
        assertion: 'expected exact project',
        observedFailure: 'received null',
      },
    };
    const declaration = {
      ...baseline,
      capabilities: {
        ...baseline.capabilities,
        projects: { ...baseline.capabilities.projects, gaps: [gap, gap] },
      },
    };
    const registrations = passingRegistrations(declaration);
    const report = await runCases(registrations, { declaration });

    // Proof: removing duplicate-gap validation failed here: expected
    // `duplicate gaps`; function did not throw.
    expect(() => {
      certifyExecution({
        declaration,
        registrations,
        report,
      });
    }).toThrow('duplicate gaps');
  });

  it('reports a declared gap as not offered without invoking its body', async () => {
    const baseline = offeredDeclaration();
    const caseId = CASE_MANIFEST.projects[0];
    let bodyRan = false;
    const declaration = {
      ...baseline,
      capabilities: {
        ...baseline.capabilities,
        projects: {
          ...baseline.capabilities.projects,
          gaps: [
            {
              caseId,
              reason: 'observed source lag',
              evidence: {
                sourceRevision: 'revision',
                assertion: 'expected exact project',
                observedFailure: 'received null',
              },
            },
          ],
        },
      },
    };
    const selectedRegistration = {
      family: 'projects' as const,
      caseId,
      openAndRun: () =>
        Promise.resolve({
          fixtureId: 'fixture:gap',
          assert: () => {
            bodyRan = true;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        }),
    };
    const registrations = passingRegistrations(declaration).map((registration) =>
      registration.caseId === caseId ? selectedRegistration : registration,
    );

    const report = await runCases(registrations, { declaration });

    // Proof: ignoring declared gaps in runCases failed here on
    // `Expected: false; Received: true` for bodyRan.
    expect(bodyRan).toBe(false);
    expect(report.cases[0]?.status).toBe('not-offered');
    expect(() => {
      certifyExecution({
        declaration,
        registrations,
        report,
      });
    }).not.toThrow();
  });

  it('rejects an unknown gap after executing the offered baseline', async () => {
    const baseline = offeredDeclaration();
    let bodyRan = false;
    const selectedRegistration = {
      family: 'projects' as const,
      caseId: CASE_MANIFEST.projects[0],
      openAndRun: () =>
        Promise.resolve({
          fixtureId: 'fixture:projects',
          assert: () => {
            bodyRan = true;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        }),
    };
    const registrations = passingRegistrations(baseline).map((registration) =>
      registration.caseId === selectedRegistration.caseId ? selectedRegistration : registration,
    );
    const report = await runCases(registrations);
    expect(bodyRan).toBe(true);
    const declaration = {
      ...baseline,
      capabilities: {
        ...baseline.capabilities,
        projects: {
          ...baseline.capabilities.projects,
          gaps: [
            {
              caseId: 'projects.unknown:gap' as CaseId,
              reason: 'injected unknown gap',
              evidence: {
                sourceRevision: 'fault',
                assertion: 'unknown gap is refused',
                observedFailure: 'injected',
              },
            },
          ],
        },
      },
    };

    // Proof: removing declaration gap validation after the baseline body ran
    // failed here: expected `unknown gaps`; function did not throw.
    expect(() => {
      certifyExecution({
        declaration,
        registrations,
        report,
      });
    }).toThrow('unknown gaps');
  });
});
