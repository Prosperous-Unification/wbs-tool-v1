import { describe, expect, it } from 'bun:test';

import { CASE_MANIFEST, type CaseRegistration } from './case-manifest';
import { runCases } from './case-runner';
import { certifyExecution } from './certification';
import { offeredDeclaration, passingRegistrations } from './source-declaration.test-support';

describe('case execution', () => {
  it('a declared body is not a passed body', async () => {
    const report = await runCases([{ family: 'projects', caseId: CASE_MANIFEST.projects[0] }]);

    // Proof: marking a declaration with no body passed failed here on
    // `Expected status: "incomplete"; Received: "passed"`.
    expect(report.cases).toEqual([
      expect.objectContaining({
        caseId: CASE_MANIFEST.projects[0],
        status: 'incomplete',
        executed: false,
      }),
    ]);
  });

  it('a setup rejection is failed execution and cannot certify', async () => {
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration).map((registration, index) =>
      index === 0
        ? {
            ...registration,
            openAndRun: () => Promise.reject(new Error('injected setup failure')),
          }
        : registration,
    );
    const report = await runCases(registrations);

    // Proof: reporting the setup rejection as a completed pass failed here;
    // expected `failed cases ... (setup: injected setup failure)`, received no throw.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('failed cases: projects: projects.create:steps (setup: injected setup failure)');
  });

  it('an assertion rejection still cleans up and cannot certify', async () => {
    let closed = false;
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration).map((registration, index) =>
      index === 0
        ? {
            ...registration,
            openAndRun: () =>
              Promise.resolve({
                fixtureId: 'fixture:assertion-failure',
                assert: () => Promise.reject(new Error('injected assertion failure')),
                close: () => {
                  closed = true;
                  return Promise.resolve();
                },
              }),
          }
        : registration,
    );
    const report = await runCases(registrations);

    expect(closed).toBe(true);
    // Proof: ignoring the caught assertion after cleanup failed here; expected
    // `failed cases ... (assertion: injected assertion failure)`, received no throw.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow(
      'failed cases: projects: projects.create:steps (assertion: injected assertion failure)',
    );
  });

  it('a failed close cannot certify its case', async () => {
    let assertionRan = false;
    const registration: CaseRegistration = {
      family: 'projects',
      caseId: CASE_MANIFEST.projects[0],
      openAndRun: () =>
        Promise.resolve({
          fixtureId: 'fixture:close-failure',
          assert: () => {
            assertionRan = true;
            return Promise.resolve();
          },
          close: () => Promise.reject(new Error('injected close failure')),
        }),
    };
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration).map((candidate) =>
      candidate.caseId === registration.caseId ? registration : candidate,
    );
    const report = await runCases(registrations);

    expect(assertionRan).toBe(true);
    // Proof: marking the case passed in the cleanup-failure branch failed here:
    // expected `failed cases ... (cleanup: injected close failure)`; no throw.
    expect(() => {
      certifyExecution({
        declaration,
        registrations,
        report,
      });
    }).toThrow('failed cases: projects: projects.create:steps (cleanup: injected close failure)');
    const execution = report.cases[0];
    expect(execution.status).toBe('failed');
    if (execution.status !== 'failed') throw new Error('expected failed case evidence');
    expect(execution.assertionPhase).toBe('cleanup');
    expect(execution.failure).toBe('injected close failure');
  });

  it('an undefined assertion rejection fails after cleanup and cannot certify', async () => {
    let closed = false;
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration).map((registration, index) =>
      index === 0
        ? {
            ...registration,
            openAndRun: () =>
              Promise.resolve({
                fixtureId: 'fixture:undefined-rejection',
                // This test specifically exercises a legal non-Error rejection reason.
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                assert: () => Promise.reject(undefined),
                close: () => {
                  closed = true;
                  return Promise.resolve();
                },
              }),
          }
        : registration,
    );
    const report = await runCases(registrations);

    expect(closed).toBe(true);
    // Proof: restoring the rejection-value sentinel made certification return;
    // expected `failed cases ... (assertion: undefined)`, received no throw.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('failed cases: projects: projects.create:steps (assertion: undefined)');
  });

  it('an undefined assertion rejection is retained when cleanup also fails', async () => {
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration).map((registration, index) =>
      index === 0
        ? {
            ...registration,
            openAndRun: () =>
              Promise.resolve({
                fixtureId: 'fixture:combined-failure',
                // This test specifically exercises a legal non-Error rejection reason.
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                assert: () => Promise.reject(undefined),
                close: () => Promise.reject(new Error('injected close failure')),
              }),
          }
        : registration,
    );
    const report = await runCases(registrations);

    // Proof: restoring the rejection-value sentinel lost the assertion reason;
    // expected `undefined; cleanup failed`, received only the cleanup failure.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow(
      'failed cases: projects: projects.create:steps (cleanup: undefined; cleanup failed: injected close failure)',
    );
  });

  it('focused execution reports partial', async () => {
    const first = CASE_MANIFEST.projects[0];
    const second = CASE_MANIFEST.projects[1];
    const registrations: CaseRegistration[] = [first, second].map((caseId) => ({
      family: 'projects',
      caseId,
      openAndRun: () =>
        Promise.resolve({
          fixtureId: `fixture:${caseId}`,
          assert: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
    }));
    const report = await runCases(registrations, { focus: [first] });

    // Proof: reporting every run as full failed here on
    // `Expected: "partial"; Received: "full"`.
    expect(report.kind).toBe('partial');
    expect(report.cases.map(({ caseId }) => caseId)).toEqual([first]);
  });
});
