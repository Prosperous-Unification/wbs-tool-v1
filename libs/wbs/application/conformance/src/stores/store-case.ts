import type { Stores } from '@wbs/core';

import type { CASE_MANIFEST } from '../case-manifest';
import { type CaseRegistration, type PortName } from '../case-manifest';
import type { CaseFixture } from '../source-declaration';

export type FamilyCaseId<Family extends PortName> = (typeof CASE_MANIFEST)[Family][number];
export type OpenCase<Family extends PortName> = (
  caseId: FamilyCaseId<Family>,
) => Promise<CaseFixture<Stores[Family]>>;

/** Binds one typed store assertion to the lifecycle owned by the shared runner. */
export function storeCase<Family extends PortName>(
  family: Family,
  caseId: FamilyCaseId<Family>,
  open: OpenCase<Family>,
  assert: (fixture: CaseFixture<Stores[Family]>) => Promise<void>,
): CaseRegistration {
  return {
    family,
    caseId,
    async openAndRun() {
      const fixture = await open(caseId);
      return {
        fixtureId: fixture.fixtureId,
        assert: () => assert(fixture),
        close: () => fixture.close(),
      };
    },
  };
}
