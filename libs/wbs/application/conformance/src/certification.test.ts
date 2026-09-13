import { describe, expect, it } from 'bun:test';

import { CASE_MANIFEST } from './case-manifest';
import { type ExecutionReport, runCases } from './case-runner';
import { certifyExecution, printCertification } from './certification';
import { offeredDeclaration, passingRegistrations } from './source-declaration.test-support';

describe('terminal certification', () => {
  it('prints certified cases, exclusions and absent families separately', async () => {
    const offered = offeredDeclaration();
    const projects = offered.capabilities.projects;
    if (projects.kind !== 'offered') throw new Error('test projects capability is absent');
    const gap = {
      caseId: CASE_MANIFEST.projects[0],
      reason: 'observed project gap',
      evidence: {
        sourceRevision: 'gap-revision',
        assertion: 'project assertion',
        observedFailure: 'project mismatch',
      },
    } as const;
    const declaration = {
      ...offered,
      capabilities: {
        ...offered.capabilities,
        projects: { ...projects, gaps: [gap] },
        users: { kind: 'absent' as const, reason: 'accountless source' },
      },
    };
    const registrations = passingRegistrations(declaration);
    const execution = await runCases(registrations, { declaration });
    const lines: string[] = [];

    const report = printCertification({ declaration, registrations, report: execution }, (line) =>
      lines.push(line),
    );

    expect(lines).toEqual([`source-conformance certification ${JSON.stringify(report)}`]);
    expect(report.exclusions).toEqual([{ family: 'projects', ...gap }]);
    expect(report.absentFamilies).toEqual([{ family: 'users', reason: 'accountless source' }]);
    expect(report.certifiedCases).not.toContain(gap.caseId);
    expect(report.certifiedCases).not.toContain(CASE_MANIFEST.users[0]);
  });

  it('a missing new kit cannot shrink certification', async () => {
    const declaration = offeredDeclaration();
    const complete = passingRegistrations(declaration);
    const registrations = complete.slice(0, -1);
    const report = await runCases(registrations);

    // Proof: deriving expected cases from registrations made this pass after
    // the final admission-specific history kit was removed.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('missing registered cases: history: history.batch:interleaved-success-survives');
  });

  it('rejects not-offered status for an offered case', async () => {
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration);
    const execution = await runCases(registrations);
    const report = {
      ...execution,
      cases: execution.cases.map((record, index) =>
        index === 0 ? { ...record, status: 'not-offered' as const } : record,
      ),
    } as unknown as ExecutionReport;

    // Proof: removing capability/status correlation failed here: expected
    // `capability status mismatch`; function did not throw.
    expect(() => {
      certifyExecution({
        declaration,
        registrations,
        report,
      });
    }).toThrow('capability status mismatch');
  });

  it('a skipped body is not passed', async () => {
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration).map((registration) =>
      registration.caseId === CASE_MANIFEST.projects[0]
        ? { family: registration.family, caseId: registration.caseId }
        : registration,
    );
    const report = await runCases(registrations);

    // Proof: removing the incomplete-status refusal after skipping body
    // invocation failed here: expected `incomplete cases`; function did not throw.
    expect(() => {
      certifyExecution({
        declaration,
        registrations,
        report,
      });
    }).toThrow('incomplete cases');
  });

  it('a supported case cannot keep a stale gap after its bypass passes', async () => {
    const offered = offeredDeclaration();
    const registrations = passingRegistrations(offered);
    const report = await runCases(registrations);
    const projects = offered.capabilities.projects;
    if (projects.kind !== 'offered') throw new Error('test projects capability is absent');
    const declaration = {
      ...offered,
      capabilities: {
        ...offered.capabilities,
        projects: {
          ...projects,
          gaps: [
            {
              caseId: CASE_MANIFEST.projects[0],
              reason: 'stale test exclusion',
              evidence: {
                sourceRevision: 'stale',
                assertion: 'the bypass passes',
                observedFailure: 'none',
              },
            },
          ],
        },
      },
    };

    // Proof: removing status-to-gap correlation certified this passing bypass
    // while the same case remained excluded.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('capability status mismatch: projects: projects.create:steps (passed)');
  });

  it('absent accounts do not create fake methods', async () => {
    const offered = offeredDeclaration();
    const declaration = {
      ...offered,
      capabilities: {
        ...offered.capabilities,
        users: { kind: 'absent' as const, reason: 'accountless source' },
      },
    };
    let userBodies = 0;
    const registrations = passingRegistrations(declaration).map((registration) =>
      registration.family === 'users'
        ? {
            ...registration,
            openAndRun: () => {
              userBodies += 1;
              return registration.openAndRun?.() ?? Promise.reject(new Error('missing body'));
            },
          }
        : registration,
    );
    const report = await runCases(registrations, { declaration });

    expect('open' in declaration.capabilities.users).toBe(false);
    expect(userBodies).toBe(0);
    expect(
      report.cases
        .filter(({ family }) => family === 'users')
        .map(({ status, executed }) => ({ status, executed })),
    ).toEqual(CASE_MANIFEST.users.map(() => ({ status: 'not-offered', executed: false })));
    certifyExecution({ declaration, registrations, report });
  });

  it('refuses a declaration-only case relabeled as passed', async () => {
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration).map((registration, index) =>
      index === 0 ? { family: registration.family, caseId: registration.caseId } : registration,
    );
    const execution = await runCases(registrations);
    const report = {
      ...execution,
      cases: execution.cases.map((record, index) =>
        index === 0 ? { ...record, status: 'passed' } : record,
      ),
    } as unknown as ExecutionReport;

    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('invalid execution evidence');
  });

  it('refuses a passed case with missing lifecycle evidence', async () => {
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration);
    const execution = await runCases(registrations);
    const report = {
      ...execution,
      cases: execution.cases.map((record, index) =>
        index === 0
          ? {
              family: record.family,
              caseId: record.caseId,
              status: 'passed',
              executed: true,
            }
          : record,
      ),
    } as unknown as ExecutionReport;

    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('invalid execution evidence');
  });

  it('refuses passed evidence paired with a declaration-only registration', async () => {
    const declaration = offeredDeclaration();
    const executedRegistrations = passingRegistrations(declaration);
    const report = await runCases(executedRegistrations);
    const registrations = executedRegistrations.map((registration, index) =>
      index === 0 ? { family: registration.family, caseId: registration.caseId } : registration,
    );

    // Proof: removing the body-presence check certified this untouched pass;
    // expected `invalid execution evidence`, received no throw.
    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('invalid execution evidence');
  });

  it('refuses a pass recorded before successful cleanup', async () => {
    const declaration = offeredDeclaration();
    const registrations = passingRegistrations(declaration);
    const execution = await runCases(registrations);
    const report = {
      ...execution,
      cases: execution.cases.map((record, index) =>
        index === 0 ? { ...record, assertionPhase: 'assertion' } : record,
      ),
    } as unknown as ExecutionReport;

    expect(() => {
      certifyExecution({ declaration, registrations, report });
    }).toThrow('invalid execution evidence');
  });
});
