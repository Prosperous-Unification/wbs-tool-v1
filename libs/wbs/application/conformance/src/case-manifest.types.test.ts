import type { HistoryStores, TransactionalStores } from '@wbs/core';

import { CASE_MANIFEST, defineCaseManifest } from './case-manifest';
import type { CertificationInput } from './certification';

interface ExtendedTransactionalStores extends TransactionalStores {
  conformanceProbe: TransactionalStores['projects'];
}

// Proof: removing this expected-error guard failed conformance:typecheck on
// TS2741: Property 'conformanceProbe' is missing in CASE_MANIFEST.
// @ts-expect-error The compile probe adds conformanceProbe without a manifest family.
defineCaseManifest<ExtendedTransactionalStores, HistoryStores>(CASE_MANIFEST);

// Proof: exposing an expected override failed conformance:typecheck on TS2578,
// because the forbidden-property error disappeared.
// @ts-expect-error Full certification owns its expected set; callers cannot replace it.
type _ExpectedOverride = CertificationInput['expected'];
