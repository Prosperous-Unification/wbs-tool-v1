import { Buffer } from 'node:buffer';

import { type } from '@wbs/validation';

const RelativePathPattern =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[*?[\]{}\\])(?!.*\/\/)(?!.*\/$).+$/;
const IsoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OpaqueIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const GitObjectId = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const Sha256 = type(/^[0-9a-f]{64}$/);
const RelativePath = type(RelativePathPattern).narrow((path, context) => {
  // Proof: without the NUL exclusion the production CLI printed `valid candidate-entry`
  // for `libs/domain\\u0000.ts`; the path-negative oracle received [0, 0, 0, 0].
  if (path.includes('\u0000')) return context.mustBe('a repository path without NUL bytes');
  // Proof: without this segment check the production CLI printed `valid`
  // for `.`, `./libs/domain.ts`, and `libs/./domain.ts`; the oracle received four exit 0s.
  return path.split('/').every((segment) => segment !== '.')
    ? true
    : context.mustBe('a canonical repository-relative path without dot segments');
});
const OpaqueId = type(OpaqueIdPattern);
const IsoInstant = type(IsoInstantPattern).narrow((instant, context) => {
  const epochMs = Date.parse(instant);
  const normalized = instant.length === 20 ? `${instant.slice(0, -1)}.000Z` : instant;
  // Proof: removing this semantic check made the production CLI print
  // `valid invocation-receipt` for 2026-02-30T17:00:00.000Z (expected exit 1).
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === normalized
    ? true
    : context.mustBe('a real ISO 8601 UTC instant');
});
// Proof: widening this to any positive integer made the production CLI print
// `valid candidate-entry` for schemaVersion 99 (expected exit 1).
const SchemaVersion = type('1');
const NonNegativeInteger = type('number.integer>=0');
const PositiveInteger = type('number.integer>=1');

const compareGitPaths = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

export const CandidateEntry = type({
  schemaVersion: SchemaVersion,
  path: RelativePath,
  mode: "'100644'|'100755'|'120000'|'160000'",
  blob: GitObjectId,
}).onUndeclaredKey('reject');
export type CandidateEntry = typeof CandidateEntry.infer;

export const ClassificationPolicy = type({
  schemaVersion: SchemaVersion,
  policyId: OpaqueId,
  contentClasses: type(
    "('source'|'test'|'config'|'script'|'migration'|'fixture'|'generated'|'vendored'|'placeholder'|'document'|'openspec')[]",
  ),
  evidenceRoots: type({
    path: RelativePath,
    allowedRecordKinds: 'string[]',
  })
    .onUndeclaredKey('reject')
    .array(),
  symlinks: "'inventory-only'",
  gitlinks: "'declared-external-boundary'",
}).onUndeclaredKey('reject');
export type ClassificationPolicy = typeof ClassificationPolicy.infer;

const InventoryEntry = type({
  path: RelativePath,
  mode: "'100644'|'100755'|'120000'|'160000'",
  blob: GitObjectId,
}).onUndeclaredKey('reject');

const CandidateSelection = type({
  kind: "'committed'",
  revision: GitObjectId,
  // Proof: making tree optional made the production CLI print
  // `valid candidate-inventory` for the missing-tree fixture (expected exit 1).
  tree: GitObjectId,
})
  .onUndeclaredKey('reject')
  .or(
    type({ kind: "'staged'", base: GitObjectId, indexTree: GitObjectId }).onUndeclaredKey('reject'),
  )
  .or(
    type({
      kind: "'working'",
      base: GitObjectId,
      trackedSnapshot: Sha256,
      untrackedSnapshot: Sha256,
    }).onUndeclaredKey('reject'),
  );

export const CandidateInventory = type({
  schemaVersion: SchemaVersion,
  inventoryId: OpaqueId,
  protocol: type({ protocolId: OpaqueId, blob: Sha256 }).onUndeclaredKey('reject'),
  selection: CandidateSelection,
  entries: InventoryEntry.array(),
  untracked: RelativePath.array(),
  classificationPolicy: type({ policyId: OpaqueId, blob: Sha256 }).onUndeclaredKey('reject'),
})
  .onUndeclaredKey('reject')
  .narrow((inventory, context) => {
    const paths = inventory.entries.map((entry) => entry.path);
    // Proof: removing this branch made the production CLI print
    // `valid candidate-inventory` for a duplicated path (expected exit 1).
    if (new Set(paths).size !== paths.length) return context.mustBe('entries with unique paths');
    const sorted = [...paths].sort(compareGitPaths);
    // Proof: removing this branch made the production CLI print
    // `valid candidate-inventory` for z.ts before a.ts (expected exit 1).
    if (paths.some((path, index) => path !== sorted[index])) {
      return context.mustBe('entries sorted by path');
    }
    return true;
  });
export type CandidateInventory = typeof CandidateInventory.infer;

// Proof: accepting arbitrary nonempty paths made the production CLI print
// `valid granularity-policy` for the `../escape` membership (expected exit 1).
const ExactMembership = type({ kind: "'path'", path: RelativePath }).onUndeclaredKey('reject');
const DirectoryMembership = type({
  kind: "'directory-prefix'",
  prefix: RelativePath,
  exclusions: RelativePath.array(),
})
  .onUndeclaredKey('reject')
  .narrow((membership, context) => {
    const outside = membership.exclusions.find(
      (excluded) => excluded !== membership.prefix && !excluded.startsWith(`${membership.prefix}/`),
    );
    // Proof: removing this narrow made the production CLI print
    // `valid granularity-policy` for excluding apps/be-01 from libs/domain (expected exit 1).
    return outside === undefined
      ? true
      : context.mustBe('memberships whose exclusions remain below their directory prefix');
  });

export const Membership = ExactMembership.or(DirectoryMembership);
export type Membership = typeof Membership.infer;

const MappingGroup = type({
  groupId: OpaqueId,
  memberships: Membership.array(),
}).onUndeclaredKey('reject');

const DimensionMapping = type({ groups: MappingGroup.array() })
  .onUndeclaredKey('reject')
  // Proof: removing this narrow made the production CLI print
  // `valid granularity-policy` for duplicate task groupId values (expected exit 1).
  .narrow((mapping, context) =>
    new Set(mapping.groups.map((group) => group.groupId)).size === mapping.groups.length
      ? true
      : context.mustBe('groups with unique groupId'),
  );

export const GranularityPolicy = type({
  schemaVersion: SchemaVersion,
  policyId: OpaqueId,
  mappingVersion: OpaqueId,
  mappings: type({
    knowledge: DimensionMapping,
    review: DimensionMapping,
    ownership: DimensionMapping,
    task: DimensionMapping,
    // Proof: making this optional made the production CLI print
    // `valid granularity-policy` without the integration mapping (expected exit 1).
    integration: DimensionMapping,
  }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
export type GranularityPolicy = typeof GranularityPolicy.infer;

const ExternalConsumers = type({ kind: "'none'" })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'declared'", memberships: Membership.array() }).onUndeclaredKey('reject'));

/** One logical module whose identity survives path moves, splits and merges. */
const ModuleIdentity = type({
  moduleId: OpaqueId,
  name: 'string>=1',
  memberships: Membership.array(),
  predecessorModuleIds: OpaqueId.array(),
  indexPath: RelativePath,
  externalConsumers: ExternalConsumers,
}).onUndeclaredKey('reject');

export const ModuleMapping = type({
  schemaVersion: SchemaVersion,
  mappingId: OpaqueId,
  mappingVersion: OpaqueId,
  sourceRevision: GitObjectId,
  modules: ModuleIdentity.array(),
})
  .onUndeclaredKey('reject')
  // Proof: removing this narrow made the production CLI print
  // `valid module-mapping` for two modules carrying the same moduleId (expected exit 1).
  .narrow((mapping, context) =>
    new Set(mapping.modules.map((module) => module.moduleId)).size === mapping.modules.length
      ? true
      : context.mustBe('modules with unique moduleId'),
  );
export type ModuleMapping = typeof ModuleMapping.infer;

const ExecutorIdentity = type({
  provider: 'string>=1',
  model: 'string>=1',
  version: 'string>=1',
  effort: 'string>=1',
  toolchain: 'string>=1',
}).onUndeclaredKey('reject');

const RawUsage = type({
  category: 'string>=1',
  quantity: 'number>=0',
  unit: 'string>=1',
}).onUndeclaredKey('reject');

export const PriceIdentity = type({
  priceId: OpaqueId,
  provider: 'string>=1',
  model: 'string>=1',
  currency: /^[A-Z]{3}$/,
  source: 'string>=1',
}).onUndeclaredKey('reject');
export type PriceIdentity = typeof PriceIdentity.infer;

export const InvocationReceipt = type({
  schemaVersion: SchemaVersion,
  receiptKind: "'invocation'",
  receiptId: OpaqueId,
  invocationId: OpaqueId,
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  status: "'completed'|'failed'|'censored'",
  executor: ExecutorIdentity,
  // Proof: making rawUsage optional made the production CLI print
  // `valid invocation-receipt` when the raw usage receipt was absent (expected exit 1).
  rawUsage: RawUsage.array(),
  // Proof: making priceIdentity optional made the production CLI print
  // `valid invocation-receipt` when price provenance was absent (expected exit 1).
  priceIdentity: PriceIdentity,
  chargedAmountMicros: NonNegativeInteger,
  inputArtifact: Sha256,
  outputArtifact: Sha256,
  // Receipt bytes deliberately have no identity field of their own: evidence
  // names source/output artifacts, and an external binding names the receipt.
  // Proof: removing undeclared-key rejection made the production CLI print
  // `valid invocation-receipt` for a self-referential receiptBlob (expected exit 1).
})
  .onUndeclaredKey('reject')
  .narrow((receipt, context) => {
    // Proof: removing this interval check made the production CLI print
    // `valid invocation-receipt` when endedAt preceded startedAt (expected exit 1).
    if (Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt)) {
      return context.mustBe('an interval whose endedAt is not before startedAt');
    }
    // Proof: removing this completed-usage check made the production CLI print
    // `valid invocation-receipt` for completed work with rawUsage [] (expected exit 1).
    if (receipt.status === 'completed' && receipt.rawUsage.length === 0) {
      return context.mustBe('completed invocation telemetry with at least one raw usage entry');
    }
    return true;
  });
export type InvocationReceipt = typeof InvocationReceipt.infer;

export const ElapsedReceipt = type({
  schemaVersion: SchemaVersion,
  receiptKind: "'elapsed'",
  receiptId: OpaqueId,
  trialId: OpaqueId,
  outcomeId: OpaqueId,
  attemptId: OpaqueId,
  phase:
    "'discovery'|'review'|'upkeep'|'waiting'|'execution'|'integration'|'gate'|'human'|'infrastructure'",
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  // Proof: making elapsedMs optional made the production CLI print
  // `valid elapsed-receipt` for the missing elapsed-time fixture (expected exit 1).
  elapsedMs: NonNegativeInteger,
  status: "'completed'|'failed'|'censored'",
})
  .onUndeclaredKey('reject')
  .narrow((receipt, context) => {
    // `elapsedMs` is the exact UTC wall-clock difference between the two
    // recorded instants; executor time, aggregation, and rounding are not inferred.
    // Proof: removing this check made the production CLI print `valid elapsed-receipt`
    // for a 60-second interval carrying elapsedMs 59999 (expected exit 1).
    return Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt) === receipt.elapsedMs
      ? true
      : context.mustBe('elapsedMs equal to endedAt minus startedAt');
  });
export type ElapsedReceipt = typeof ElapsedReceipt.infer;

export const CheckReceipt = type({
  schemaVersion: SchemaVersion,
  receiptKind: "'check'",
  receiptId: OpaqueId,
  command: 'string[]',
  cwdIdentity: OpaqueId,
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  elapsedMs: NonNegativeInteger,
  status: "'passed'|'failed'|'skipped'",
  exitCode: 'number.integer',
  candidateManifest: Sha256,
  toolIdentity: Sha256,
  resourceLane: OpaqueId,
  stdoutArtifact: Sha256,
  stderrArtifact: Sha256,
  skips: 'string[]',
})
  .onUndeclaredKey('reject')
  .narrow((receipt, context) => {
    // `elapsedMs` follows the same exact UTC wall-clock rule as ElapsedReceipt.
    // Proof: removing this check made the production CLI print `valid check-receipt`
    // for a 60-second interval carrying elapsedMs 60001 (expected exit 1).
    return Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt) === receipt.elapsedMs
      ? true
      : context.mustBe('elapsedMs equal to endedAt minus startedAt');
  });
export type CheckReceipt = typeof CheckReceipt.infer;

export const ReviewReceipt = type({
  schemaVersion: SchemaVersion,
  receiptKind: "'review'",
  receiptId: OpaqueId,
  invocationId: OpaqueId,
  executor: ExecutorIdentity,
  suppliedContextIds: Sha256.array(),
  observedReadIds: Sha256.array(),
  rawResponseArtifact: Sha256,
  rawUsage: RawUsage.array(),
  priceIdentity: PriceIdentity,
  trust: type({
    scope: "'local-cooperative'|'trusted-harness'|'external-verifier'",
    journalId: OpaqueId,
  }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
export type ReviewReceipt = typeof ReviewReceipt.infer;

const BenchmarkOutcome = type({
  outcomeId: OpaqueId,
  title: 'string>=1',
  stratum: "'independent-module'|'shared-contract'",
  heldOut: 'boolean',
  acceptanceCriteria: 'string[]',
})
  .onUndeclaredKey('reject')
  // Proof: removing this narrow made the production CLI print
  // `valid benchmark-corpus` for an outcome with no acceptance criterion (expected exit 1).
  .narrow((outcome, context) =>
    outcome.acceptanceCriteria.length === 0
      ? context.mustBe('an outcome with at least one acceptance criterion')
      : outcome.acceptanceCriteria.some((criterion) => criterion.trim().length === 0)
        ? // Proof: removing this branch made both production corpus paths print `valid`
          // for whitespace-only acceptance criteria (expected two exit 1s).
          context.mustBe('acceptance criteria containing non-whitespace text')
        : true,
  );

export const BenchmarkCorpus = type({
  schemaVersion: SchemaVersion,
  corpusId: OpaqueId,
  acceptanceId: OpaqueId,
  repository: type({
    revision: GitObjectId,
    tree: GitObjectId,
    inventoryId: OpaqueId,
  }).onUndeclaredKey('reject'),
  outcomes: BenchmarkOutcome.array(),
})
  .onUndeclaredKey('reject')
  .narrow((corpus, context) => {
    // Proof: removing this branch made the production CLI print `valid benchmark-corpus`
    // for outcomes [] (expected exit 1).
    if (corpus.outcomes.length === 0) return context.mustBe('a nonempty benchmark outcome set');
    // Proof: removing this narrow made the production CLI print
    // `valid benchmark-corpus` for duplicate outcomeId values (expected exit 1).
    return new Set(corpus.outcomes.map((outcome) => outcome.outcomeId)).size ===
      corpus.outcomes.length
      ? true
      : context.mustBe('a corpus with unique outcomeId values');
  });
export type BenchmarkCorpus = typeof BenchmarkCorpus.infer;

export const ExperimentManifest = type({
  schemaVersion: SchemaVersion,
  manifestId: OpaqueId,
  repository: type({
    revision: GitObjectId,
    tree: GitObjectId,
    inventoryId: OpaqueId,
  }).onUndeclaredKey('reject'),
  corpus: type({
    corpusId: OpaqueId,
    acceptanceId: OpaqueId,
    outcomes: BenchmarkOutcome.array(),
  }).onUndeclaredKey('reject'),
  granularity: type({
    policyId: OpaqueId,
    mappingVersion: OpaqueId,
    mappingBlob: Sha256,
  }).onUndeclaredKey('reject'),
  reviewProtocol: type({ protocolId: OpaqueId, protocolBlob: Sha256 }).onUndeclaredKey('reject'),
  execution: type({
    provider: 'string>=1',
    model: 'string>=1',
    version: 'string>=1',
    effort: 'string>=1',
    promptHash: Sha256,
    toolHash: Sha256,
  }).onUndeclaredKey('reject'),
  resources: type({
    resourceId: OpaqueId,
    allocationMode: "'fixed-total'|'fixed-per-session'",
    maxConcurrentSessions: PositiveInteger,
    cacheCondition: "'cold'|'warm'|'mixed'",
  }).onUndeclaredKey('reject'),
  seeds: NonNegativeInteger.array(),
  retryPolicy: type({
    maxAttemptsPerOutcome: PositiveInteger,
    timeBudgetMs: PositiveInteger,
  }).onUndeclaredKey('reject'),
  integrationPolicy: type({
    maxSubmissions: PositiveInteger,
    maxWaitMs: PositiveInteger,
  }).onUndeclaredKey('reject'),
  priceIdentity: PriceIdentity,
  receiptJournal: type({ journalId: OpaqueId, schemaVersion: SchemaVersion }).onUndeclaredKey(
    'reject',
  ),
  observation: type({ postAcceptanceDefectWindowHours: PositiveInteger }).onUndeclaredKey('reject'),
  hypotheses: type({
    q2OverQ1Minimum: 'number>0',
    q4OverQ1Minimum: 'number>0',
    q8OverQ1Minimum: 'number>0',
    conflictRateMaximum: '0<=number<=1',
    integrationReworkRateMaximum: '0<=number<=1',
    medianDiscoveryMsMaximum: PositiveInteger,
    reviewAmplificationMaximum: 'number>0',
    leaseWaitFractionMaximum: '0<=number<=1',
  }).onUndeclaredKey('reject'),
})
  .onUndeclaredKey('reject')
  .narrow((manifest, context) => {
    const outcomeIds = manifest.corpus.outcomes.map((outcome) => outcome.outcomeId);
    // Proof: removing this branch made the production CLI print `valid experiment-manifest`
    // for outcomes [] (expected exit 1).
    if (outcomeIds.length === 0) return context.mustBe('a nonempty benchmark outcome set');
    // Proof: removing this branch made the production CLI print
    // `valid experiment-manifest` for duplicate outcomeId values (expected exit 1).
    if (new Set(outcomeIds).size !== outcomeIds.length) {
      return context.mustBe('a corpus with unique outcomeId values');
    }
    // Proof: removing this branch made the production CLI print
    // `valid experiment-manifest` for two randomized seeds (expected exit 1).
    if (manifest.seeds.length < 3) return context.mustBe('at least three randomized seeds');
    return true;
  });
export type ExperimentManifest = typeof ExperimentManifest.infer;
