import type { CaseId, CaseRegistration } from './case-manifest';
import { failureMessage } from './failure-message';
import type { SourceDeclaration } from './source-declaration';

export type TerminalCaseStatus = 'passed' | 'failed' | 'not-offered' | 'incomplete';
export type AssertionPhase = 'setup' | 'assertion' | 'cleanup';

interface CaseIdentity {
  readonly family: CaseRegistration['family'];
  readonly caseId: CaseId;
}

interface UnexecutedCase extends CaseIdentity {
  readonly status: 'not-offered' | 'incomplete';
  readonly executed: false;
}

interface StartedCase extends CaseIdentity {
  readonly executed: true;
  readonly executionStartedAt: number;
  readonly executionEndedAt: number;
}

interface SetupFailure extends StartedCase {
  readonly status: 'failed';
  readonly assertionPhase: 'setup';
  readonly failure: string;
}

interface LifecycleFailure extends StartedCase {
  readonly status: 'failed';
  readonly fixtureId: string;
  readonly assertionPhase: 'assertion' | 'cleanup';
  readonly failure: string;
}

interface PassedCase extends StartedCase {
  readonly status: 'passed';
  readonly fixtureId: string;
  readonly assertionPhase: 'cleanup';
}

/** A status whose required evidence is encoded by its discriminants. */
export type CaseExecution = UnexecutedCase | SetupFailure | LifecycleFailure | PassedCase;

export interface ExecutionReport {
  readonly kind: 'full' | 'partial';
  readonly cases: readonly CaseExecution[];
}

export interface RunCasesOptions {
  readonly focus?: readonly CaseId[];
  readonly declaration?: SourceDeclaration;
}

async function runCase(registration: CaseRegistration): Promise<CaseExecution> {
  const executionStartedAt = Date.now();
  if (registration.openAndRun === undefined) {
    return {
      family: registration.family,
      caseId: registration.caseId,
      status: 'incomplete',
      executed: false,
    };
  }

  let lifecycle;
  try {
    lifecycle = await registration.openAndRun();
  } catch (failure) {
    return {
      family: registration.family,
      caseId: registration.caseId,
      status: 'failed',
      executed: true,
      executionStartedAt,
      executionEndedAt: Date.now(),
      assertionPhase: 'setup',
      failure: failureMessage(failure),
    };
  }

  let didAssertionFail = false;
  let assertionFailure: unknown;
  try {
    await lifecycle.assert();
  } catch (failure) {
    didAssertionFail = true;
    assertionFailure = failure;
  }

  try {
    await lifecycle.close();
  } catch (failure) {
    const cleanupFailure = failureMessage(failure);
    return {
      family: registration.family,
      caseId: registration.caseId,
      status: 'failed',
      executed: true,
      fixtureId: lifecycle.fixtureId,
      executionStartedAt,
      executionEndedAt: Date.now(),
      assertionPhase: 'cleanup',
      failure: !didAssertionFail
        ? cleanupFailure
        : `${failureMessage(assertionFailure)}; cleanup failed: ${cleanupFailure}`,
    };
  }

  if (didAssertionFail) {
    return {
      family: registration.family,
      caseId: registration.caseId,
      status: 'failed',
      executed: true,
      fixtureId: lifecycle.fixtureId,
      executionStartedAt,
      executionEndedAt: Date.now(),
      assertionPhase: 'assertion',
      failure: failureMessage(assertionFailure),
    };
  }

  return {
    family: registration.family,
    caseId: registration.caseId,
    status: 'passed',
    executed: true,
    fixtureId: lifecycle.fixtureId,
    executionStartedAt,
    executionEndedAt: Date.now(),
    assertionPhase: 'cleanup',
  };
}

/** Executes registered bodies and owns their cleanup before assigning pass. */
export async function runCases(
  registrations: readonly CaseRegistration[],
  options: RunCasesOptions = {},
): Promise<ExecutionReport> {
  const selected =
    options.focus === undefined
      ? registrations
      : registrations.filter(({ caseId }) => options.focus?.includes(caseId) === true);
  const cases: CaseExecution[] = [];
  for (const registration of selected) {
    if (registration.family !== 'history' && options.declaration !== undefined) {
      const capability = options.declaration.capabilities[registration.family];
      if (
        capability.kind === 'absent' ||
        capability.gaps.some(({ caseId }) => caseId === registration.caseId)
      ) {
        cases.push({
          family: registration.family,
          caseId: registration.caseId,
          status: 'not-offered',
          executed: false,
        });
        continue;
      }
    }
    cases.push(await runCase(registration));
  }
  return { kind: options.focus === undefined ? 'full' : 'partial', cases };
}
