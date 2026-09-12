import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { parseOrThrow, type } from '@wbs/validation';

import {
  ArtifactGraph,
  CandidateInventory,
  ClassificationPolicy,
  ContentManifestRequest,
  GranularityPolicy,
  type Membership,
  ModuleMapping,
  OpaqueId,
  RelationshipRequest,
  RelativePath,
  SchemaVersion,
} from '../contracts/records';
import {
  buildContentManifest,
  hashBytes,
  hashCanonical,
  serializeCanonical,
  validateArtifacts,
} from '../evidence/content-manifest';
import {
  type ClassifiedEntry,
  classifyEntries,
  type ContentClassification,
  type ReadBlob,
} from '../inventory/classify-entries';
import { type CandidateSnapshot, readCandidate } from '../inventory/read-candidate';
import { extractRelationships } from '../relationships';
import {
  AuditEvaluation,
  type AuditObligation,
  AuditStratum,
  evaluateAudit,
  selectAudit,
} from './audit';
import { ReviewProtocol, ReviewSubject, ReviewSubjectLocator } from './protocol';

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

export interface ExhaustiveProject {
  projectId: string;
  locator: ReviewSubjectLocator;
}

export interface ExhaustivePopulationInput {
  entries: ClassifiedEntry[];
  projects: ExhaustiveProject[];
  explicitDocumentationPaths: string[];
  riskStratum: string;
  shardPrefixLength: number;
}

export interface ExhaustiveSubject {
  subjectId: string;
  kind: 'file' | 'directory' | 'project' | 'documentation';
  locator: ReviewSubjectLocator;
  contentIdentity: string;
}

export interface ExhaustiveShard {
  shardId: string;
  obligationIds: string[];
}

export interface ExhaustivePopulation {
  subjects: ExhaustiveSubject[];
  obligations: AuditObligation[];
  shards: ExhaustiveShard[];
}

const Sha256 = type(/^[0-9a-f]{64}$/);
const GitIdentity = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const PositiveInteger = type('number.integer>=1').narrow((value, context) =>
  Number.isSafeInteger(value) && !Object.is(value, -0)
    ? true
    : context.mustBe('a positive safe integer'),
);
export const ExhaustivePolicy = type({
  schemaVersion: SchemaVersion,
  policyId: OpaqueId,
  explicitDocumentationPaths: RelativePath.array(),
  nonNxProjects: type({ projectId: OpaqueId, locator: ReviewSubjectLocator })
    .onUndeclaredKey('reject')
    .array(),
  defaultRiskStratum: OpaqueId,
  reviewGeneration: PositiveInteger,
  auditStrata: type({
    stratumId: OpaqueId,
    sampleRateBps: PositiveInteger,
    disagreementTriggerBps: PositiveInteger,
  })
    .onUndeclaredKey('reject')
    .array(),
  shardRule: type({
    ruleId: "'shard.sha256-prefix.v1'",
    hashPrefixLength: PositiveInteger,
  }).onUndeclaredKey('reject'),
})
  .onUndeclaredKey('reject')
  .narrow((policy, context) => {
    if (policy.auditStrata.some(({ sampleRateBps }) => sampleRateBps > 10_000)) {
      return context.mustBe('audit sample rates no greater than 10000 basis points');
    }
    if (policy.auditStrata.some(({ disagreementTriggerBps }) => disagreementTriggerBps > 10_000)) {
      return context.mustBe('audit disagreement thresholds no greater than 10000 basis points');
    }
    if (policy.shardRule.hashPrefixLength > 64) {
      return context.mustBe('a shard hash prefix no wider than SHA-256');
    }
    const strata = policy.auditStrata.map(({ stratumId }) => stratumId);
    if (new Set(strata).size !== strata.length) return context.mustBe('unique audit strata');
    if (!strata.includes(policy.defaultRiskStratum)) {
      return context.mustBe('a default risk stratum declared in auditStrata');
    }
    const projectIds = policy.nonNxProjects.map(({ projectId }) => projectId);
    if (new Set(projectIds).size !== projectIds.length) {
      return context.mustBe('non-Nx projects with unique projectId values');
    }
    return true;
  });
export type ExhaustivePolicy = typeof ExhaustivePolicy.infer;

export const SweepModelContext = type({
  schemaVersion: SchemaVersion,
  configurationId: OpaqueId,
  executor: type({
    provider: 'string>=1',
    model: 'string>=1',
    version: 'string>=1',
    effort: 'string>=1',
    toolchain: 'string>=1',
  }).onUndeclaredKey('reject'),
  promptBlob: Sha256,
  toolsBlob: Sha256,
  harnessId: OpaqueId,
  coldContextRule: "'isolated-subject-only'",
  informedContextRule: "'declared-expansion'",
  budgets: type({
    contextTokens: PositiveInteger,
    inputTokens: PositiveInteger,
    outputTokens: PositiveInteger,
  }).onUndeclaredKey('reject'),
  overflow: "'refuse'|'truncate-recorded'",
  resourceCondition: 'string>=1',
  cacheCondition: 'string>=1',
}).onUndeclaredKey('reject');
export type SweepModelContext = typeof SweepModelContext.infer;

const InventoryProtocol = type({
  schemaVersion: SchemaVersion,
  protocolId: OpaqueId,
}).onUndeclaredKey('reject');

const InputBinding = type({ inputId: OpaqueId, blob: Sha256 }).onUndeclaredKey('reject');
const ResolvedGroup = type({ groupId: OpaqueId, paths: 'string[]' }).onUndeclaredKey('reject');
const ResolvedDimension = type({ groups: ResolvedGroup.array() }).onUndeclaredKey('reject');
const ResolvedMappings = type({
  knowledge: ResolvedDimension,
  review: ResolvedDimension,
  ownership: ResolvedDimension,
  task: ResolvedDimension,
  integration: ResolvedDimension,
}).onUndeclaredKey('reject');
const ResolvedModuleMapping = type({
  mappingId: OpaqueId,
  mappingVersion: OpaqueId,
  modules: type({
    moduleId: OpaqueId,
    indexPath: 'string>=1',
    paths: 'string[]',
    externalConsumerPaths: 'string[]',
  })
    .onUndeclaredKey('reject')
    .array(),
}).onUndeclaredKey('reject');
const ExhaustiveShardRecord = type({
  shardId: OpaqueId,
  obligationIds: OpaqueId.array(),
}).onUndeclaredKey('reject');

export const ExhaustivePlan = type({
  schemaVersion: SchemaVersion,
  planKind: "'exhaustive-sweep'",
  source: type({ commit: GitIdentity, tree: GitIdentity }).onUndeclaredKey('reject'),
  inventoryId: OpaqueId,
  inventoryIdentity: Sha256,
  contentIdentity: Sha256,
  evidenceValidationIdentity: Sha256,
  inputBindings: InputBinding.array(),
  modelContext: SweepModelContext,
  reviewProtocol: ReviewProtocol,
  reviewGeneration: PositiveInteger,
  primaryCoverage: "'exhaustive'",
  subjects: ReviewSubject.array(),
  obligations: type({
    obligationId: OpaqueId,
    riskStratum: OpaqueId,
    subject: ReviewSubject,
  })
    .onUndeclaredKey('reject')
    .array(),
  shards: ExhaustiveShardRecord.array(),
  moduleMapping: ResolvedModuleMapping,
  mappings: ResolvedMappings,
  audit: type({
    auditId: OpaqueId,
    seed: OpaqueId,
    strata: AuditStratum.array(),
    selectionId: Sha256,
    obligationIds: OpaqueId.array(),
  }).onUndeclaredKey('reject'),
  unresolvedGitlinks: type({ path: 'string>=1', object: GitIdentity, boundaryId: OpaqueId })
    .onUndeclaredKey('reject')
    .array(),
}).onUndeclaredKey('reject');
export type ExhaustivePlan = typeof ExhaustivePlan.infer;

export interface InputDocument {
  bytes: Uint8Array;
  input: unknown;
}

export interface ExhaustiveFreezeDocuments {
  inventory: InputDocument;
  inventoryProtocol: InputDocument;
  classificationPolicy: InputDocument;
  contentManifestRequest: InputDocument;
  exhaustivePolicy: InputDocument;
  reviewProtocol: InputDocument;
  moduleMapping: InputDocument;
  granularityPolicy: InputDocument;
  modelContext: InputDocument;
  relationshipRequest: InputDocument;
  artifactGraph: InputDocument;
}

export interface FrozenExhaustivePlan {
  plan: ExhaustivePlan;
  bytes: string;
  identity: string;
}

function decodeInput<T>(
  name: keyof ExhaustiveFreezeDocuments,
  document: InputDocument,
  decode: (input: unknown) => T,
): T {
  let byteInput: unknown;
  try {
    byteInput = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(document.bytes),
    ) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid exhaustive ${name} bytes: ${detail}`, { cause });
  }
  // Proof: supplying valid model-context input beside `{}` bytes previously froze the `{}` hash;
  // the production API test expected a named byte/input refusal and received no exception.
  if (hashCanonical(byteInput) !== hashCanonical(document.input)) {
    throw new Error(`exhaustive ${name} bytes differ from decoded input`);
  }
  try {
    return decode(byteInput);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid exhaustive ${name}: ${detail}`, { cause });
  }
}

function logicalSubjectKey(
  kind: ExhaustiveSubject['kind'],
  locator: ReviewSubjectLocator,
  projectId?: string,
): object {
  return { schemaVersion: 1, kind, locator, ...(projectId === undefined ? {} : { projectId }) };
}

function makeSubject(
  kind: ExhaustiveSubject['kind'],
  locator: ReviewSubjectLocator,
  contentIdentity: string,
  projectId?: string,
): ExhaustiveSubject {
  const identity = hashCanonical(logicalSubjectKey(kind, locator, projectId));
  return { subjectId: `subject.${kind}.${identity}`, kind, locator, contentIdentity };
}

function pathLocator(path: string): ReviewSubjectLocator {
  return { kind: 'path', path };
}

function directoryPaths(entries: readonly ClassifiedEntry[]): (string | undefined)[] {
  const directories = new Set<string | undefined>([undefined]);
  for (const { path } of entries) {
    let directory = posix.dirname(path);
    while (directory !== '.') {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  return [...directories].sort((left, right) =>
    left === undefined ? -1 : right === undefined ? 1 : compareText(left, right),
  );
}

function isBelow(locator: ReviewSubjectLocator, path: string): boolean {
  if (locator.kind === 'repository-root') return true;
  return path === locator.path || path.startsWith(`${locator.path}/`);
}

function directoryChildren(directory: string | undefined, entries: readonly ClassifiedEntry[]) {
  const prefix = directory === undefined ? '' : `${directory}/`;
  const children = new Map<
    string,
    | { name: string; kind: 'directory' }
    | {
        name: string;
        kind: 'entry';
        classification: ClassifiedEntry['classification'];
        mode: ClassifiedEntry['mode'];
      }
  >();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    const slash = relative.indexOf('/');
    if (slash >= 0) {
      // Proof: dropping directory segments kept repository-root currency unchanged after adding
      // `new-project/src/index.ts`; the production population test received the old identity.
      const name = relative.slice(0, slash);
      children.set(name, { name, kind: 'directory' });
    } else {
      children.set(relative, {
        name: relative,
        kind: 'entry',
        classification: entry.classification,
        mode: entry.mode,
      });
    }
  }
  return [...children.values()].sort((left, right) => compareText(left.name, right.name));
}

/**
 * Generates the fixed repository review universe before assignment or audit sampling.
 * Evidence bytes are not file-review subjects, but their ancestor topology remains a duty.
 */
export function deriveExhaustivePopulation(input: ExhaustivePopulationInput): ExhaustivePopulation {
  if (
    !Number.isSafeInteger(input.shardPrefixLength) ||
    input.shardPrefixLength < 1 ||
    input.shardPrefixLength > 64
  ) {
    throw new Error('exhaustive shard prefix length must be a safe integer from 1 through 64');
  }
  const explicitDocuments = new Set(input.explicitDocumentationPaths);
  const contentEntries = input.entries.filter(
    (entry): entry is ClassifiedEntry & { classification: ContentClassification } =>
      entry.classification.kind === 'content',
  );
  const contentPathSet = new Set(contentEntries.map(({ path }) => path));
  for (const path of explicitDocuments) {
    // Proof: removing this join let `docs/missing.md` silently disappear from the population;
    // the public derivation test expected the named unresolved selection and received no throw.
    if (!contentPathSet.has(path)) {
      throw new Error(`exhaustive documentation selection is unresolved: ${path}`);
    }
  }
  const subjects: ExhaustiveSubject[] = contentEntries.map((entry) =>
    makeSubject('file', pathLocator(entry.path), hashCanonical(entry)),
  );

  for (const directory of directoryPaths(input.entries)) {
    const children = directoryChildren(directory, input.entries);
    const locator: ReviewSubjectLocator =
      directory === undefined ? { kind: 'repository-root' } : pathLocator(directory);
    subjects.push(makeSubject('directory', locator, hashCanonical({ children })));
  }

  const projects = [
    { projectId: 'repository-root', locator: { kind: 'repository-root' } as const },
    ...input.projects,
  ];
  const projectIds = projects.map(({ projectId }) => projectId);
  // Proof: removing this check reduced duplicate `repository-root` identity to a generic
  // duplicate-subject error; the population test required the stable project identity name.
  if (new Set(projectIds).size !== projectIds.length) {
    throw new Error('exhaustive population contains duplicate stable project identities');
  }
  for (const project of projects) {
    const entries = input.entries
      .filter((entry) => isBelow(project.locator, entry.path))
      // Proof: retaining evidence blob/record fields here made a valid evidence-only commit
      // change repository-root project currency; the real-Git test received distinct subjects.
      .map(({ path, mode, blob, classification }) =>
        classification.kind === 'content'
          ? { path, mode, blob, classification }
          : { path, mode, classification: { kind: classification.kind } },
      );
    // Proof: removing this guard let `nx.missing` create an empty project obligation; the
    // population test expected the exact unresolved locator and received no exception.
    if (entries.length === 0) {
      const locator =
        project.locator.kind === 'repository-root' ? 'repository-root' : project.locator.path;
      throw new Error(`exhaustive project ${project.projectId} is unresolved: ${locator}`);
    }
    subjects.push(
      makeSubject(
        'project',
        project.locator,
        hashCanonical({ projectId: project.projectId, entries }),
        project.projectId,
      ),
    );
  }

  for (const entry of contentEntries) {
    const isDocument =
      entry.classification.contentClass === 'document' ||
      entry.classification.contentClass === 'openspec' ||
      explicitDocuments.has(entry.path);
    if (isDocument) {
      subjects.push(makeSubject('documentation', pathLocator(entry.path), hashCanonical(entry)));
    }
  }

  subjects.sort((left, right) => compareText(left.subjectId, right.subjectId));
  const subjectIds = subjects.map(({ subjectId }) => subjectId);
  if (new Set(subjectIds).size !== subjectIds.length) {
    throw new Error('exhaustive population contains duplicate logical subjects');
  }
  const obligations: AuditObligation[] = subjects.map((subject) => ({
    obligationId: `obligation.${hashCanonical({ schemaVersion: 1, subjectId: subject.subjectId })}`,
    riskStratum: input.riskStratum,
    subject,
  }));
  const shardObligations = new Map<string, string[]>();
  for (const obligation of obligations) {
    // Proof: appending the five-map artifact digest to this identity made every shard differ
    // after a pure regrouping; the production freeze test reported 22 changed shard IDs.
    const prefix = hashCanonical({ schemaVersion: 1, obligationId: obligation.obligationId }).slice(
      0,
      input.shardPrefixLength,
    );
    const ids = shardObligations.get(prefix) ?? [];
    ids.push(obligation.obligationId);
    shardObligations.set(prefix, ids);
  }
  const shards = [...shardObligations]
    .sort(([left], [right]) => compareText(left, right))
    .map(([prefix, obligationIds]) => ({
      shardId: `shard.v1.${prefix}`,
      obligationIds: obligationIds.sort(compareText),
    }));
  return { subjects, obligations, shards };
}

function readBlob(repository: string): ReadBlob {
  return (blob, path) => {
    const invocation = Bun.spawnSync(['git', '-C', repository, 'cat-file', 'blob', blob], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (invocation.exitCode !== 0) {
      const detail = invocation.stderr.toString('utf8').trim();
      throw new Error(
        `cannot read exhaustive candidate blob ${blob} for ${path}: ${detail.length === 0 ? `git exited ${String(invocation.exitCode)}` : detail}`,
      );
    }
    return invocation.stdout;
  };
}

function selectionIdentity(snapshot: CandidateSnapshot): object {
  return snapshot.selection;
}

function reconcileInventory(snapshot: CandidateSnapshot, inventory: CandidateInventory): void {
  if (hashCanonical(selectionIdentity(snapshot)) !== hashCanonical(inventory.selection)) {
    throw new Error('exhaustive inventory selection differs from independently selected candidate');
  }
  const actualByPath = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const claimedByPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  for (const actual of snapshot.entries) {
    const claimed = claimedByPath.get(actual.path);
    // Proof: bypassing the complete tuple join let an equal-count
    // `apps/alpha/src/index.ts` to `apps/alpha/src/substitute.ts` replacement freeze; the
    // production CLI test expected refusal and received exit 0.
    if (claimed === undefined)
      throw new Error(`exhaustive inventory missing tuple: ${actual.path}`);
    if (claimed.mode !== actual.mode) {
      // Proof: removing this comparison let the production CLI freeze a 100755 claim for
      // the committed 100644 source; the test expected exit 1 and received exit 0.
      throw new Error(
        `exhaustive inventory mode differs for ${actual.path}: ${claimed.mode} instead of ${actual.mode}`,
      );
    }
    if (claimed.blob !== actual.blob) {
      // Proof: removing this comparison let the production CLI freeze an attacker-chosen
      // blob for an unchanged path and mode; the test expected exit 1 and received exit 0.
      throw new Error(
        `exhaustive inventory blob differs for ${actual.path}: ${claimed.blob} instead of ${actual.blob}`,
      );
    }
  }
  for (const claimed of inventory.entries) {
    if (!actualByPath.has(claimed.path)) {
      throw new Error(`exhaustive inventory has unexpected tuple: ${claimed.path}`);
    }
  }
  if (hashCanonical(snapshot.untracked) !== hashCanonical(inventory.untracked)) {
    throw new Error('exhaustive inventory untracked set differs from selected candidate');
  }
}

function inputBindings(documents: ExhaustiveFreezeDocuments): { inputId: string; blob: string }[] {
  const names: (keyof ExhaustiveFreezeDocuments)[] = [
    'inventory',
    'inventoryProtocol',
    'classificationPolicy',
    'contentManifestRequest',
    'exhaustivePolicy',
    'reviewProtocol',
    'moduleMapping',
    'granularityPolicy',
    'modelContext',
    'relationshipRequest',
    'artifactGraph',
  ];
  return names
    .map((inputName) => ({
      inputId: `input.${inputName.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      blob: hashBytes(documents[inputName].bytes),
    }))
    .sort((left, right) => compareText(left.inputId, right.inputId));
}

function membershipPaths(
  membership: Membership,
  contentPaths: readonly string[],
  dimension: string,
  groupId: string,
): string[] {
  const selected =
    membership.kind === 'path'
      ? contentPaths.filter((path) => path === membership.path)
      : contentPaths.filter(
          (path) =>
            (path === membership.prefix || path.startsWith(`${membership.prefix}/`)) &&
            !membership.exclusions.some(
              (excluded) => path === excluded || path.startsWith(`${excluded}/`),
            ),
        );
  // Proof: removing this exact membership check reduced `missing/module-path.ts` to a generic
  // `orphan content path: README.md`; the production freeze test required the unresolved unit.
  if (selected.length === 0) {
    const locator = membership.kind === 'path' ? membership.path : membership.prefix;
    throw new Error(
      `exhaustive ${dimension} mapping group ${groupId} has unresolved membership: ${locator}`,
    );
  }
  return selected;
}

function resolveDimension(
  policy: GranularityPolicy,
  dimension: keyof GranularityPolicy['mappings'],
  contentPaths: readonly string[],
) {
  const groups = policy.mappings[dimension].groups
    .map((group) => ({
      groupId: group.groupId,
      paths: [
        ...new Set(
          group.memberships.flatMap((membership) =>
            membershipPaths(membership, contentPaths, dimension, group.groupId),
          ),
        ),
      ].sort(compareText),
    }))
    .sort((left, right) => compareText(left.groupId, right.groupId));
  const covered = new Set(groups.flatMap(({ paths }) => paths));
  const orphan = contentPaths.find((path) => !covered.has(path));
  // Proof: removing this refusal let an equal-count README.md-to-package.json replacement in
  // knowledge freeze a plan; the production test received a plan instead of throwing. The same
  // test repeats the observed production fault independently for all five dimensions.
  if (orphan !== undefined) {
    throw new Error(`exhaustive ${dimension} mapping has orphan content path: ${orphan}`);
  }
  return { groups };
}

function resolveMappings(
  policy: GranularityPolicy,
  contentPaths: readonly string[],
): ExhaustivePlan['mappings'] {
  return {
    knowledge: resolveDimension(policy, 'knowledge', contentPaths),
    review: resolveDimension(policy, 'review', contentPaths),
    ownership: resolveDimension(policy, 'ownership', contentPaths),
    task: resolveDimension(policy, 'task', contentPaths),
    integration: resolveDimension(policy, 'integration', contentPaths),
  };
}

function resolveModuleMapping(mapping: ModuleMapping, contentPaths: readonly string[]) {
  const modules = mapping.modules
    .map((module) => {
      if (!contentPaths.includes(module.indexPath)) {
        throw new Error(
          `exhaustive module ${module.moduleId} index is unresolved: ${module.indexPath}`,
        );
      }
      const paths = [
        ...new Set(
          module.memberships.flatMap((membership) =>
            membershipPaths(membership, contentPaths, 'module', module.moduleId),
          ),
        ),
      ].sort(compareText);
      const externalConsumerPaths =
        module.externalConsumers.kind === 'none'
          ? []
          : [
              ...new Set(
                module.externalConsumers.memberships.flatMap((membership) =>
                  membershipPaths(
                    membership,
                    contentPaths,
                    'module external consumer',
                    module.moduleId,
                  ),
                ),
              ),
            ].sort(compareText);
      return {
        moduleId: module.moduleId,
        indexPath: module.indexPath,
        paths,
        externalConsumerPaths,
      };
    })
    .sort((left, right) => compareText(left.moduleId, right.moduleId));
  const covered = new Set(modules.flatMap(({ paths }) => paths));
  const orphan = contentPaths.find((path) => !covered.has(path));
  if (orphan !== undefined)
    throw new Error(`exhaustive module mapping has orphan content path: ${orphan}`);
  return { mappingId: mapping.mappingId, mappingVersion: mapping.mappingVersion, modules };
}

function nxProjects(relationships: ReturnType<typeof extractRelationships>): ExhaustiveProject[] {
  return relationships.nx.projects.map((project) => ({
    projectId: `nx.${project.name}`,
    locator:
      project.root === '.'
        ? ({ kind: 'repository-root' } as const)
        : ({ kind: 'path', path: project.root } as const),
  }));
}

function assertDocumentBinding(
  name: keyof ExhaustiveFreezeDocuments,
  expected: string,
  document: InputDocument,
): void {
  const actual = hashBytes(document.bytes);
  if (actual !== expected) {
    throw new Error(`exhaustive ${name} bytes differ from their pinned digest: ${actual}`);
  }
}

/** Reads immutable candidate B and freezes its independently derived exhaustive review universe. */
export function freezeExhaustivePlan(
  repository: string,
  revision: string,
  documents: ExhaustiveFreezeDocuments,
  auditSeed: string,
): FrozenExhaustivePlan {
  const inventory = decodeInput('inventory', documents.inventory, (input) =>
    parseOrThrow(CandidateInventory, input),
  );
  const inventoryProtocol = decodeInput('inventoryProtocol', documents.inventoryProtocol, (input) =>
    parseOrThrow(InventoryProtocol, input),
  );
  const classificationPolicy = decodeInput(
    'classificationPolicy',
    documents.classificationPolicy,
    (input) => parseOrThrow(ClassificationPolicy, input),
  );
  const contentRequest = decodeInput(
    'contentManifestRequest',
    documents.contentManifestRequest,
    (input) => parseOrThrow(ContentManifestRequest, input),
  );
  const exhaustivePolicy = decodeInput('exhaustivePolicy', documents.exhaustivePolicy, (input) =>
    parseOrThrow(ExhaustivePolicy, input),
  );
  const reviewProtocol = decodeInput('reviewProtocol', documents.reviewProtocol, (input) =>
    parseOrThrow(ReviewProtocol, input),
  );
  const moduleMapping = decodeInput('moduleMapping', documents.moduleMapping, (input) =>
    parseOrThrow(ModuleMapping, input),
  );
  // Proof: defaulting an absent knowledge dimension to the review dimension let the production
  // freeze return a complete plan; the missing-dimension test failed with "function did not throw".
  const granularity = decodeInput('granularityPolicy', documents.granularityPolicy, (input) =>
    parseOrThrow(GranularityPolicy, input),
  );
  const modelContext = decodeInput('modelContext', documents.modelContext, (input) =>
    parseOrThrow(SweepModelContext, input),
  );
  const relationshipRequest = decodeInput(
    'relationshipRequest',
    documents.relationshipRequest,
    (input) => parseOrThrow(RelationshipRequest, input),
  );
  const artifactGraph = decodeInput('artifactGraph', documents.artifactGraph, (input) =>
    parseOrThrow(ArtifactGraph, input),
  );
  const snapshot = readCandidate(repository, { kind: 'committed', revision });
  if (snapshot.selection.kind !== 'committed') {
    throw new Error('exhaustive freeze requires an immutable committed candidate');
  }
  reconcileInventory(snapshot, inventory);
  if (
    inventory.protocol.protocolId !== inventoryProtocol.protocolId ||
    inventory.protocol.blob !== hashBytes(documents.inventoryProtocol.bytes)
  ) {
    throw new Error('exhaustive inventory protocol differs from its pinned input');
  }
  if (
    inventory.classificationPolicy.policyId !== classificationPolicy.policyId ||
    inventory.classificationPolicy.blob !== hashBytes(documents.classificationPolicy.bytes)
  ) {
    throw new Error('exhaustive classification policy differs from its pinned input');
  }
  if (contentRequest.protocol.protocolId !== inventoryProtocol.protocolId) {
    throw new Error('exhaustive content manifest protocol differs from inventory protocol');
  }
  assertDocumentBinding(
    'inventoryProtocol',
    contentRequest.protocol.blob,
    documents.inventoryProtocol,
  );
  if (contentRequest.classificationPolicy.policyId !== classificationPolicy.policyId) {
    throw new Error('exhaustive content manifest names a different classification policy');
  }
  assertDocumentBinding(
    'classificationPolicy',
    contentRequest.classificationPolicy.blob,
    documents.classificationPolicy,
  );
  if (moduleMapping.sourceRevision !== snapshot.selection.revision) {
    // Proof: reusing B's pre-move map with the fully refreshed moved candidate made the
    // production freeze name the old and new commits instead of accepting a stale mapping.
    throw new Error(
      `exhaustive module mapping source ${moduleMapping.sourceRevision} differs from candidate ${snapshot.selection.revision}`,
    );
  }
  const classifiedEntries = classifyEntries(
    snapshot.entries,
    classificationPolicy,
    readBlob(repository),
  );
  const candidate = {
    selection: snapshot.selection,
    entries: classifiedEntries,
    untracked: snapshot.untracked,
    policyId: classificationPolicy.policyId,
  };
  const relationships = extractRelationships(repository, snapshot, relationshipRequest);
  if (
    hashCanonical(relationships.manifestInputs.relationshipInputs) !==
      hashCanonical(contentRequest.relationshipInputs) ||
    hashCanonical(relationships.manifestInputs.extractors) !==
      hashCanonical(contentRequest.extractors)
  ) {
    throw new Error('exhaustive relationship inputs differ from exact candidate extraction');
  }
  const content = buildContentManifest(
    candidate,
    contentRequest,
    hashBytes(documents.classificationPolicy.bytes),
  );
  // Proof: retaining B's graph after a valid evidence-only commit made this production freeze
  // fail with "artifact descriptor differs from selected evidence" while content identity held.
  const evidence = validateArtifacts(candidate, artifactGraph, readBlob(repository));
  const projects = [
    ...nxProjects(relationships),
    ...exhaustivePolicy.nonNxProjects.map(({ projectId, locator }) => ({ projectId, locator })),
  ];
  const population = deriveExhaustivePopulation({
    entries: classifiedEntries,
    projects,
    explicitDocumentationPaths: exhaustivePolicy.explicitDocumentationPaths,
    riskStratum: exhaustivePolicy.defaultRiskStratum,
    shardPrefixLength: exhaustivePolicy.shardRule.hashPrefixLength,
  });
  const contentPaths = classifiedEntries
    .filter(({ classification }) => classification.kind === 'content')
    .map(({ path }) => path)
    .sort(compareText);
  const resolvedModuleMapping = resolveModuleMapping(moduleMapping, contentPaths);
  const mappings = resolveMappings(granularity, contentPaths);
  const selection = selectAudit({
    schemaVersion: 1,
    auditId: `audit.${hashCanonical({ policyId: exhaustivePolicy.policyId, auditSeed })}`,
    sourceBase: snapshot.selection.revision,
    candidateIdentity: content.identity,
    generation: exhaustivePolicy.reviewGeneration,
    seed: auditSeed,
    coverage: 'sampled',
    strata: exhaustivePolicy.auditStrata,
    obligations: population.obligations,
  });
  const unresolvedGitlinks = classifiedEntries.flatMap((entry) =>
    entry.classification.kind === 'content' && entry.classification.contentClass === 'gitlink'
      ? [
          {
            path: entry.path,
            object: entry.blob,
            boundaryId: entry.classification.boundaryId,
          },
        ]
      : [],
  );
  const plan = parseOrThrow(ExhaustivePlan, {
    schemaVersion: 1,
    planKind: 'exhaustive-sweep',
    source: { commit: snapshot.selection.revision, tree: snapshot.selection.tree },
    inventoryId: inventory.inventoryId,
    inventoryIdentity: hashBytes(documents.inventory.bytes),
    contentIdentity: content.identity,
    evidenceValidationIdentity: evidence.validationIdentity,
    inputBindings: inputBindings(documents),
    modelContext,
    reviewProtocol,
    reviewGeneration: exhaustivePolicy.reviewGeneration,
    primaryCoverage: 'exhaustive',
    subjects: population.subjects,
    obligations: population.obligations,
    shards: population.shards,
    moduleMapping: resolvedModuleMapping,
    mappings,
    audit: {
      auditId: selection.auditId,
      seed: auditSeed,
      strata: exhaustivePolicy.auditStrata,
      selectionId: selection.selectionId,
      obligationIds: selection.obligationIds,
    },
    unresolvedGitlinks,
  });
  const bytes = serializeCanonical(plan);
  return { plan, bytes, identity: hashBytes(bytes) };
}

function subjectLabel(subject: ExhaustiveSubject): string {
  const locator =
    subject.locator.kind === 'repository-root' ? 'repository-root' : subject.locator.path;
  return `${subject.kind}:${locator}`;
}

/** Independently recomputes candidate B and refuses any serialized population or binding drift. */
export function verifyExhaustivePlan(
  repository: string,
  expectedIdentity: string,
  submitted: unknown,
  documents: ExhaustiveFreezeDocuments,
  auditSeed: string,
): FrozenExhaustivePlan {
  const submittedPlan = parseOrThrow(ExhaustivePlan, submitted);
  const recomputed = freezeExhaustivePlan(
    repository,
    submittedPlan.source.commit,
    documents,
    auditSeed,
  );
  const submittedSubjects = new Map(
    submittedPlan.subjects.map((subject) => [subject.subjectId, subject]),
  );
  const recomputedSubjects = new Map(
    recomputed.plan.subjects.map((subject) => [subject.subjectId, subject]),
  );
  for (const subject of recomputed.plan.subjects) {
    // Proof: removing this exact omission check reduced a missing repository-root duty to the
    // generic population mismatch; the production verifier test required the omitted unit name.
    if (!submittedSubjects.has(subject.subjectId)) {
      throw new Error(`exhaustive plan omitted subject: ${subjectLabel(subject)}`);
    }
  }
  for (const subject of submittedPlan.subjects) {
    if (!recomputedSubjects.has(subject.subjectId)) {
      throw new Error(`exhaustive plan has unexpected subject: ${subjectLabel(subject)}`);
    }
  }
  if (hashCanonical(submittedPlan) !== hashCanonical(recomputed.plan)) {
    throw new Error('exhaustive plan differs from independently recomputed candidate population');
  }
  if (recomputed.identity !== expectedIdentity) {
    throw new Error(
      `exhaustive plan identity ${recomputed.identity} differs from expected ${expectedIdentity}`,
    );
  }
  return recomputed;
}

/** Replaces caller-claimed review population with the frozen exhaustive population. */
export function evaluateExhaustiveCoverage(planInput: unknown, auditInput: unknown) {
  const plan = parseOrThrow(ExhaustivePlan, planInput);
  if (typeof auditInput !== 'object' || auditInput === null || Array.isArray(auditInput)) {
    throw new Error('exhaustive coverage audit input must be an object');
  }
  const envelope = { ...auditInput } as Record<string, unknown>;
  // Proof: retaining the caller's shrunken obligation list let a merged review assignment omit
  // one valid subject and still return accepted; the coverage production test received true.
  envelope['sourceBase'] = plan.source.commit;
  envelope['candidateIdentity'] = plan.contentIdentity;
  // Proof: retaining attacker generation 99 made the complete generation-1 review set report
  // accepted: false; the production coverage test requires the frozen generation authority.
  envelope['generation'] = plan.reviewGeneration;
  envelope['auditId'] = plan.audit.auditId;
  envelope['seed'] = plan.audit.seed;
  envelope['coverage'] = 'exhaustive';
  envelope['claimedCoverage'] = 'exhaustive';
  envelope['strata'] = plan.audit.strata;
  envelope['obligations'] = plan.obligations;
  const evaluation = parseOrThrow(AuditEvaluation, envelope);
  for (const review of evaluation.reviews) {
    // Proof: removing this join let a forged protocol reach audit reconciliation, which failed
    // generically on supplied-context summary instead of naming the frozen protocol mismatch.
    if (
      hashCanonical(review.evidence.protocolEvidence.protocol) !==
      hashCanonical(plan.reviewProtocol)
    ) {
      throw new Error(`exhaustive review ${review.reviewId} does not bind the frozen protocol`);
    }
    // Proof: removing this join let a forged executor version return accepted: true in the
    // production coverage test after the attacker changed all internally reconciled receipts.
    if (
      hashCanonical(review.evidence.receipt.executor) !== hashCanonical(plan.modelContext.executor)
    ) {
      throw new Error(`exhaustive review ${review.reviewId} does not bind the frozen executor`);
    }
  }
  const report = evaluateAudit(evaluation);
  const unresolvedGitlinks = plan.unresolvedGitlinks;
  if (unresolvedGitlinks.length === 0) return { ...report, unresolvedGitlinks };
  const gitlinkRefusals = unresolvedGitlinks.map(({ path, boundaryId }) => ({
    obligationId: `gitlink:${path}`,
    kind: 'coverage' as const,
    reason: `external boundary ${boundaryId} at ${path} remains unresolved`,
  }));
  // Proof: omitting this unresolved-boundary refusal let complete local receipts for an
  // independently verified committed Gitlink return accepted true; the production coverage test
  // failed on `Expected: false, Received: true`.
  return {
    ...report,
    unresolvedGitlinks,
    unmetObligationIds: [
      ...report.unmetObligationIds,
      ...gitlinkRefusals.map(({ obligationId }) => obligationId),
    ].sort(compareText),
    refusals: [...report.refusals, ...gitlinkRefusals],
    accepted: false,
  };
}
