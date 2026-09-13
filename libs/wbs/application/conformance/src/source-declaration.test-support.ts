import { type CaseRegistration, expectedCasesFor, PORT_NAMES } from './case-manifest';
import type { Capabilities, SourceDeclaration } from './source-declaration';

export function offeredDeclaration(): SourceDeclaration {
  // Test-only construction from the closed PORT_NAMES tuple; the runtime
  // manifest test independently checks that tuple's exact nineteen members.
  const capabilities = Object.fromEntries(
    PORT_NAMES.map((family) => [
      family,
      {
        kind: 'offered' as const,
        gaps: [],
        open: () =>
          Promise.reject(new Error(`test fixture for ${family} was not expected to open`)),
      },
    ]),
  ) as unknown as Capabilities;
  return {
    name: 'test-source',
    revision: 'baseline',
    capabilities,
    historyAdmission: 'independent-write',
  };
}

export function passingRegistrations(declaration: SourceDeclaration): CaseRegistration[] {
  return expectedCasesFor(declaration.historyAdmission).map(({ family, caseId }) => ({
    family,
    caseId,
    openAndRun: () =>
      Promise.resolve({
        fixtureId: `${family}:${caseId}`,
        assert: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
  }));
}
