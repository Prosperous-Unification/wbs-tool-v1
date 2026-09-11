import { Buffer } from 'node:buffer';

import { type } from '@wbs/validation';

const RelativePathPattern =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[*?[\]{}\\])(?!.*\/\/)(?!.*\/$).+$/;
const IsoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OpaqueIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const GitObjectId = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const Sha256 = type(/^[0-9a-f]{64}$/);
export const RelativePath = type(RelativePathPattern).narrow((path, context) => {
  // Proof: removing this entire canonical-path narrow produced [0, 0, 0, 0];
  // removing only the NUL refusal accepted its third CLI case: [1, 1, 0, 1].
  if (path.includes('\u0000')) return context.mustBe('a repository path without NUL bytes');
  // Proof: removing this entire canonical-path narrow produced [0, 0, 0, 0];
  // removing only the dot-segment refusal accepted cases 1, 2 and 4: [0, 0, 1, 0].
  return path.split('/').every((segment) => segment !== '.')
    ? true
    : context.mustBe('a canonical repository-relative path without dot segments');
});
export const OpaqueId = type(OpaqueIdPattern);
export const IsoInstant = type(IsoInstantPattern).narrow((instant, context) => {
  const epochMs = Date.parse(instant);
  const normalized = instant.length === 20 ? `${instant.slice(0, -1)}.000Z` : instant;
  // Proof: removing this semantic check made the production CLI print
  // `valid invocation-receipt` for 2026-02-30T17:00:00.000Z (expected exit 1).
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === normalized
    ? true
    : context.mustBe('a real ISO 8601 UTC instant');
});
// Proof: widening this to any positive integer made the production CLI print
// `valid candidate-entry` for schemaVersion 99 (expected exit 1), and made artifact graph
// version 99 exit 0 with artifactCount 2 instead of refusing before traversal.
export const SchemaVersion = type('1');
const NonNegativeInteger = type('number.integer>=0');
const PositiveInteger = type('number.integer>=1');
const PortNumber = type('number.integer>=1').and(type('number<=65535'));

const compareGitPaths = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

export const CandidateEntry = type({
  schemaVersion: SchemaVersion,
  path: RelativePath,
  mode: "'100644'|'100755'|'120000'|'160000'",
  blob: GitObjectId,
}).onUndeclaredKey('reject');
export type CandidateEntry = typeof CandidateEntry.infer;

export const EvidenceRecordKind = type(
  "'benchmark-corpus'|'candidate-inventory'|'experiment-manifest'|'opaque-transcript'|'review-receipt'",
);
export type EvidenceRecordKind = typeof EvidenceRecordKind.infer;

export const ContentClass = type(
  "'source'|'test'|'config'|'script'|'migration'|'fixture'|'generated'|'vendored'|'placeholder'|'document'|'openspec'",
);
export type ContentClass = typeof ContentClass.infer;
const SupportedContentClasses: readonly ContentClass[] = [
  'source',
  'test',
  'config',
  'script',
  'migration',
  'fixture',
  'generated',
  'vendored',
  'placeholder',
  'document',
  'openspec',
];

const SelectorValue = type('string>=1').narrow((value, context) => {
  if (value.includes('\u0000')) return context.mustBe('a selector without NUL bytes');
  return true;
});

const ContentSelector = type({
  kind: "'path'|'prefix'|'segment'|'name'|'suffix'",
  value: SelectorValue,
})
  .onUndeclaredKey('reject')
  .narrow((selector, context) => {
    if (selector.kind === 'path' || selector.kind === 'prefix') {
      return RelativePathPattern.test(selector.value) &&
        selector.value.split('/').every((segment) => segment !== '.')
        ? true
        : context.mustBe('a canonical repository-relative path selector');
    }
    if (selector.kind === 'segment' || selector.kind === 'name') {
      return !selector.value.includes('/') && selector.value !== '.' && selector.value !== '..'
        ? true
        : context.mustBe('one canonical path segment');
    }
    return !selector.value.includes('/')
      ? true
      : context.mustBe('a path suffix without directory separators');
  });

const ContentRule = type({
  contentClass: ContentClass,
  include: ContentSelector.array(),
  exclude: ContentSelector.array(),
})
  .onUndeclaredKey('reject')
  .narrow((rule, context) =>
    rule.include.length > 0 ? true : context.mustBe('at least one include selector'),
  );

const RegenerationAuthority = type({ kind: "'source'", path: RelativePath })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'external'", authority: 'string>=1' }).onUndeclaredKey('reject'));

export const ClassificationPolicy = type({
  schemaVersion: SchemaVersion,
  policyId: OpaqueId,
  selectorVersion: SchemaVersion,
  contentClasses: ContentClass.array(),
  contentRules: ContentRule.array(),
  evidenceRoots: type({
    path: RelativePath,
    allowedRecordKinds: EvidenceRecordKind.array(),
  })
    .onUndeclaredKey('reject')
    .array(),
  binaryDeclarations: type({
    path: RelativePath,
    format: 'string>=1',
    consumer: RelativePath,
    regenerationAuthority: RegenerationAuthority,
  })
    .onUndeclaredKey('reject')
    .array(),
  gitlinkBoundaries: type({
    path: RelativePath,
    object: GitObjectId,
    boundaryId: OpaqueId,
    repository: 'string>=1',
  })
    .onUndeclaredKey('reject')
    .array(),
  symlinks: "'inventory-only'",
  gitlinks: "'declared-external-boundary'",
})
  .onUndeclaredKey('reject')
  .narrow((policy, context) => {
    const classes = [...policy.contentClasses].sort();
    const ruleClasses = policy.contentRules.map((rule) => rule.contentClass).sort();
    const supportedClasses = [...SupportedContentClasses].sort();
    if (
      new Set(classes).size !== classes.length ||
      // Proof: removing the supported-set comparisons made the production CLI exit 0 for a
      // policy with both the source class and source rule removed (expected exit 1).
      classes.length !== supportedClasses.length ||
      classes.some((contentClass, index) => contentClass !== supportedClasses[index]) ||
      classes.length !== ruleClasses.length ||
      classes.some((contentClass, index) => contentClass !== ruleClasses[index])
    ) {
      return context.mustBe('exactly one rule for every supported content class');
    }
    const roots = policy.evidenceRoots.map((root) => root.path).sort();
    // The two evidence locations are reserved by the repository design, not extensible candidate input.
    if (
      roots.length !== 2 ||
      roots[0] !== 'docs/experiment-evidence' ||
      roots[1] !== 'docs/review-evidence'
    ) {
      return context.mustBe('the two reserved evidence roots');
    }
    if (policy.evidenceRoots.some((root) => root.allowedRecordKinds.length === 0)) {
      return context.mustBe('nonempty evidence schema allowlists');
    }
    const declaredPaths = [
      ...policy.binaryDeclarations.map((declaration) => declaration.path),
      ...policy.gitlinkBoundaries.map((boundary) => boundary.path),
    ];
    return new Set(declaredPaths).size === declaredPaths.length
      ? true
      : context.mustBe('unique binary and Gitlink declaration paths');
  });
export type ClassificationPolicy = typeof ClassificationPolicy.infer;

const ContentIdentityInput = type({ inputId: OpaqueId, blob: Sha256 }).onUndeclaredKey('reject');
const ExtractorIdentity = type({
  extractorId: OpaqueId,
  version: OpaqueId,
  blob: Sha256,
}).onUndeclaredKey('reject');

export const ContentManifestRequest = type({
  schemaVersion: SchemaVersion,
  protocol: type({ protocolId: OpaqueId, blob: Sha256 }).onUndeclaredKey('reject'),
  classificationPolicy: type({ policyId: OpaqueId, blob: Sha256 }).onUndeclaredKey('reject'),
  relationshipInputs: ContentIdentityInput.array(),
  extractors: ExtractorIdentity.array(),
})
  .onUndeclaredKey('reject')
  .narrow((request, context) => {
    const inputIds = request.relationshipInputs.map((input) => input.inputId);
    // Proof: removing this guard made the production CLI exit 0 with two differently hashed
    // relationship inputs both claiming `relationship.z`.
    if (new Set(inputIds).size !== inputIds.length) {
      return context.mustBe('relationship inputs with unique inputId values');
    }
    const extractorIds = request.extractors.map((extractor) => extractor.extractorId);
    // Proof: removing this guard made the production CLI exit 0 with two differently hashed
    // extractors both claiming `extractor.z`.
    return new Set(extractorIds).size === extractorIds.length
      ? true
      : context.mustBe('extractors with unique extractorId values');
  });
export type ContentManifestRequest = typeof ContentManifestRequest.infer;

export const RelationshipRequest = type({
  schemaVersion: SchemaVersion,
  'declarationPaths?': RelativePath.array(),
  typescript: type({
    configPaths: RelativePath.array(),
    publicEntrypoints: RelativePath.array(),
  })
    .onUndeclaredKey('reject')
    .narrow((request, context) => {
      // Proof: removing this refusal reached public resolution with zero configs; the production
      // request oracle lost `at least one TypeScript config path`.
      if (request.configPaths.length === 0) {
        return context.mustBe('at least one TypeScript config path');
      }
      // Proof: removing this refusal let the empty-public-selector production request exit 0;
      // its exact request-boundary oracle expected exit 1.
      if (request.publicEntrypoints.length === 0) {
        return context.mustBe('at least one TypeScript public entrypoint');
      }
      // Proof: removing this refusal reached public resolution with two config owners; the
      // production request oracle lost `unique TypeScript config paths`.
      if (new Set(request.configPaths).size !== request.configPaths.length) {
        return context.mustBe('unique TypeScript config paths');
      }
      // Proof: removing this refusal let the duplicated-public-selector production request exit 0;
      // its exact request-boundary oracle expected exit 1.
      return new Set(request.publicEntrypoints).size === request.publicEntrypoints.length
        ? true
        : context.mustBe('unique TypeScript public entrypoints');
    }),
})
  .onUndeclaredKey('reject')
  .narrow((request, context) => {
    const paths = request.declarationPaths ?? [];
    // Proof: bypassing this guard made the duplicate-path request lose its boundary diagnosis and
    // fail later with `relationship declarations must have unique declarationId values`.
    return new Set(paths).size === paths.length
      ? true
      : context.mustBe('unique relationship declaration paths');
  });
export type RelationshipRequest = typeof RelationshipRequest.infer;

const FactAt = type({ kind: "'current'" })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'historical'", revision: GitObjectId }).onUndeclaredKey('reject'));

const PackageScriptFact = type({
  factId: OpaqueId,
  family: "'scripts'",
  at: FactAt,
  kind: "'package-script'",
  path: RelativePath,
  name: 'string>=1',
  expected: 'string',
}).onUndeclaredKey('reject');

const CiStepCommandFact = type({
  factId: OpaqueId,
  family: "'ci'",
  at: FactAt,
  kind: "'ci-step-command'",
  path: RelativePath,
  job: 'string>=1',
  step: 'string>=1',
  expected: 'string',
}).onUndeclaredKey('reject');

const HookCommandFact = type({
  factId: OpaqueId,
  family: "'hooks'",
  at: FactAt,
  kind: "'hook-command'",
  path: RelativePath,
  hook: 'string>=1',
  command: 'string>=1',
  expected: 'string',
}).onUndeclaredKey('reject');

const DockerInstructionFact = type({
  factId: OpaqueId,
  family: "'docker'",
  at: FactAt,
  kind: "'docker-instruction'",
  path: RelativePath,
  stage: 'string>=1',
  instruction: "'ARG'|'CMD'|'COPY'|'ENV'|'EXPOSE'|'FROM'|'RUN'|'WORKDIR'",
  ordinal: PositiveInteger,
  expected: 'string',
}).onUndeclaredKey('reject');

const GeneratedBlobFact = type({
  factId: OpaqueId,
  family: "'generated'",
  at: FactAt,
  kind: "'generated-blob'",
  path: RelativePath,
  expectedBlob: GitObjectId,
}).onUndeclaredKey('reject');

const EnvironmentVariableFact = type({
  factId: OpaqueId,
  family: "'environment'",
  at: FactAt,
  kind: "'environment-variable'",
  path: RelativePath,
  name: 'string>=1',
  expected: 'string',
}).onUndeclaredKey('reject');

const PortFact = type({
  factId: OpaqueId,
  family: "'ports'",
  at: FactAt,
  kind: "'port'",
  path: RelativePath,
  name: 'string>=1',
  expected: PortNumber,
}).onUndeclaredKey('reject');

const DrizzleTableFact = type({
  factId: OpaqueId,
  family: "'tables'",
  at: FactAt,
  kind: "'drizzle-table'",
  path: RelativePath,
  exportName: 'string>=1',
  expected: 'string>=1',
}).onUndeclaredKey('reject');

const MigrationTableFact = type({
  factId: OpaqueId,
  family: "'migrations'",
  at: FactAt,
  kind: "'migration-table'",
  path: RelativePath,
  operation: "'alter'|'create'|'drop'|'references'",
  occurrence: PositiveInteger,
  expected: 'string>=1',
}).onUndeclaredKey('reject');

const HttpEndpointFact = type({
  factId: OpaqueId,
  family: "'http'",
  at: FactAt,
  kind: "'http-endpoint'",
  path: RelativePath,
  exportName: 'string>=1',
  expectedMethod: "'DELETE'|'GET'|'PATCH'|'POST'|'PUT'",
  expectedPath: type(/^\/.+$/),
}).onUndeclaredKey('reject');

const NxTargetFact = type({
  factId: OpaqueId,
  family: "'targets'",
  at: FactAt,
  kind: "'nx-target'",
  project: 'string>=1',
  target: 'string>=1',
  expectedConfiguration: 'unknown',
}).onUndeclaredKey('reject');

const VendoredLockFact = type({
  factId: OpaqueId,
  family: "'vendored-locks'",
  at: FactAt,
  kind: "'vendored-lock'",
  path: RelativePath,
  expectedBlob: GitObjectId,
}).onUndeclaredKey('reject');

const ExternalConsumerFact = type({
  factId: OpaqueId,
  family: "'external-consumers'",
  at: FactAt,
  kind: "'external-consumer'",
  system: 'string>=1',
  contract: 'string>=1',
  knowledgeLimit: 'string>=1',
}).onUndeclaredKey('reject');

export const RelationshipFact = PackageScriptFact.or(CiStepCommandFact)
  .or(HookCommandFact)
  .or(DockerInstructionFact)
  .or(GeneratedBlobFact)
  .or(EnvironmentVariableFact)
  .or(PortFact)
  .or(DrizzleTableFact)
  .or(MigrationTableFact)
  .or(HttpEndpointFact)
  .or(NxTargetFact)
  .or(VendoredLockFact)
  .or(ExternalConsumerFact);
export type RelationshipFact = typeof RelationshipFact.infer;

const FactEndpoint = type({ kind: "'fact'", factId: OpaqueId }).onUndeclaredKey('reject');
const PathEndpoint = type({ kind: "'path'", path: RelativePath }).onUndeclaredKey('reject');
const ExternalEndpoint = type({ kind: "'external'", system: 'string>=1' }).onUndeclaredKey(
  'reject',
);
const RelationshipEndpoint = FactEndpoint.or(PathEndpoint).or(ExternalEndpoint);

const DeclaredRelationship = type({
  relationshipId: OpaqueId,
  kind: OpaqueId,
  status: "'declared'",
  source: RelationshipEndpoint,
  target: RelationshipEndpoint,
}).onUndeclaredKey('reject');

const UnresolvedRelationship = type({
  relationshipId: OpaqueId,
  kind: OpaqueId,
  status: "'unresolved'",
  source: RelationshipEndpoint,
  target: RelationshipEndpoint,
  reason: 'string>=1',
}).onUndeclaredKey('reject');

export const RelationshipDeclaration = type({
  schemaVersion: SchemaVersion,
  declarationId: OpaqueId,
  // Proof: widening this to PositiveInteger made selectorVersion 99 reach the production CLI;
  // `rejects unknown declaration versions` expected exit 1 and received 0.
  selectorVersion: SchemaVersion,
  coverage: "'selected-facts-only'",
  facts: RelationshipFact.array(),
  edges: DeclaredRelationship.or(UnresolvedRelationship).array(),
})
  .onUndeclaredKey('reject')
  .narrow((declaration, context) => {
    const factIds = declaration.facts.map((fact) => fact.factId);
    // Proof: bypassing this guard made the duplicate-fact production CLI invocation exit 0;
    // `rejects unknown declaration versions` expected exit 1 and received 0.
    if (new Set(factIds).size !== factIds.length) {
      return context.mustBe('facts with unique factId values');
    }
    const relationshipIds = declaration.edges.map((edge) => edge.relationshipId);
    // Proof: bypassing this guard made the duplicate-edge production CLI invocation exit 0;
    // `rejects unknown declaration versions` expected exit 1 and received 0.
    return new Set(relationshipIds).size === relationshipIds.length
      ? true
      : context.mustBe('edges with unique relationshipId values');
  });
export type RelationshipDeclaration = typeof RelationshipDeclaration.infer;

const EvidenceArtifact = type({
  artifactId: Sha256,
  path: RelativePath,
  blob: GitObjectId,
  recordKind: EvidenceRecordKind,
  references: Sha256.array(),
})
  .onUndeclaredKey('reject')
  .narrow((artifact, context) =>
    // Proof: removing this guard made the production CLI accept the same dependency twice and
    // exit 0 with traversalBound 4, so duplicate obligations were not a canonical finite graph.
    new Set(artifact.references).size === artifact.references.length
      ? true
      : context.mustBe('artifact references with unique identities'),
  );

export const ArtifactGraph = type({
  schemaVersion: SchemaVersion,
  validationId: OpaqueId,
  roots: Sha256.array(),
  artifacts: EvidenceArtifact.array(),
})
  .onUndeclaredKey('reject')
  .narrow((graph, context) => {
    // Proof: removing this guard made the production CLI accept one root identity twice and exit
    // 0 with artifactCount 2 instead of rejecting the ambiguous external boundary.
    if (new Set(graph.roots).size !== graph.roots.length) {
      return context.mustBe('unique artifact root identities');
    }
    const identities = graph.artifacts.map((artifact) => artifact.artifactId);
    // Proof: removing this guard let duplicate identities reach byte validation and lose the
    // graph-boundary diagnosis, reporting the second artifact as a byte mismatch instead.
    if (new Set(identities).size !== identities.length) {
      return context.mustBe('artifacts with unique identities');
    }
    const paths = graph.artifacts.map((artifact) => artifact.path);
    // Proof: removing this guard let a duplicated path hide the second selected artifact, and the
    // production CLI failed later on `candidate evidence absent` instead of the malformed graph.
    return new Set(paths).size === paths.length
      ? true
      : context.mustBe('artifacts with unique paths');
  });
export type ArtifactGraph = typeof ArtifactGraph.infer;

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

export const ExecutorIdentity = type({
  provider: 'string>=1',
  model: 'string>=1',
  version: 'string>=1',
  effort: 'string>=1',
  toolchain: 'string>=1',
}).onUndeclaredKey('reject');

export const RawUsage = type({
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

/** A provenance-bearing container whose payload remains opaque to classification. */
export const OpaqueTranscript = type({
  schemaVersion: SchemaVersion,
  recordKind: "'opaque-transcript'",
  invocationId: OpaqueId,
  mediaType: "'text/plain'|'application/json'",
  payload: 'string',
}).onUndeclaredKey('reject');
export type OpaqueTranscript = typeof OpaqueTranscript.infer;

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
