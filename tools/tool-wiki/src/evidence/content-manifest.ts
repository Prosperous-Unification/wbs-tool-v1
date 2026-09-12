import { Buffer } from 'node:buffer';

import { decodeRecord } from '../contracts/decode-record';
import type { ArtifactGraph, ContentManifestRequest } from '../contracts/records';
import type {
  ClassifiedCandidate,
  ClassifiedEntry,
  ContentClassification,
  EvidenceClassification,
  ReadBlob,
} from '../inventory/classify-entries';

const Sha256Pattern = /^[0-9a-f]{64}$/;

export function compareCanonicalText(left: string, right: string): number {
  const byteOrder = Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  if (byteOrder !== 0) return byteOrder;
  // Proof: without the code-unit tie-breaker, canonical objects containing `\ud800` and `\ud801`
  // retained opposite insertion orders because both encode as the same UTF-8 replacement bytes.
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeJson(input: unknown, ancestors: Set<object>): string {
  if (input === null) return 'null';
  switch (typeof input) {
    case 'boolean':
      return input ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(input) || Object.is(input, -0)) {
        throw new Error('canonical JSON requires a finite number other than negative zero');
      }
      return JSON.stringify(input);
    case 'string':
      return JSON.stringify(input);
    case 'undefined':
      throw new Error('canonical JSON cannot serialize undefined');
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new Error(`canonical JSON cannot serialize ${typeof input}`);
    case 'object':
      break;
  }
  if (ancestors.has(input)) throw new Error('canonical JSON cannot serialize a cyclic JSON value');
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) {
          throw new Error('canonical JSON cannot serialize a sparse array');
        }
      }
      return `[${input.map((element) => serializeJson(element, ancestors)).join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonical JSON requires a plain JSON object');
    }
    if (Object.getOwnPropertySymbols(input).length !== 0) {
      throw new Error('canonical JSON cannot serialize symbol keys');
    }
    const fields = Object.entries(input).sort(([left], [right]) =>
      compareCanonicalText(left, right),
    );
    return `{${fields
      .map(([key, field]) => `${JSON.stringify(key)}:${serializeJson(field, ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(input);
  }
}

/** Serializes the finite JSON value model with byte-sorted keys and one terminal newline. */
export function serializeCanonical(input: unknown): string {
  return `${serializeJson(input, new Set())}\n`;
}

/** Validates that a value belongs to the finite, non-mutating canonical JSON value model. */
export function assertCanonicalJsonValue(input: unknown): void {
  serializeJson(input, new Set());
}

/** Returns the SHA-256 identity of exact bytes without interpreting their format. */
export function hashBytes(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** Returns the SHA-256 identity of the canonical JSON serialization. */
export function hashCanonical(input: unknown): string {
  return hashBytes(serializeCanonical(input));
}

type ContentEntry = ClassifiedEntry & { classification: ContentClassification };

export interface ContentManifest {
  schemaVersion: 1;
  manifestKind: 'content';
  protocol: ContentManifestRequest['protocol'];
  classificationPolicy: ContentManifestRequest['classificationPolicy'];
  relationshipInputs: ContentManifestRequest['relationshipInputs'];
  extractors: ContentManifestRequest['extractors'];
  entries: ContentEntry[];
}

export interface BuiltContentManifest {
  manifest: ContentManifest;
  bytes: string;
  identity: string;
}

function isContent(entry: ClassifiedEntry): entry is ContentEntry {
  return entry.classification.kind === 'content';
}

/**
 * Builds the reviewable-content identity from exact content tuples and their declared inputs.
 * Candidate selection and evidence tuples stay outside the digest so evidence can validate finitely.
 */
export function buildContentManifest(
  candidate: ClassifiedCandidate,
  request: ContentManifestRequest,
  actualPolicyBlob: string,
): BuiltContentManifest {
  // Proof: removing this binding made the production CLI exit 0 with a manifest claiming
  // `classification.other.v1` over tuples classified by `classification.baseline.v1`.
  if (candidate.policyId !== request.classificationPolicy.policyId) {
    throw new Error(
      `content manifest policy ${request.classificationPolicy.policyId} differs from classified policy ${candidate.policyId}`,
    );
  }
  // Proof: removing this byte binding made the production CLI exit 0 with a manifest that named
  // policy blob 999... while classification read the shipped 5e19ae... policy bytes.
  if (actualPolicyBlob !== request.classificationPolicy.blob) {
    throw new Error(
      `content manifest policy blob ${request.classificationPolicy.blob} differs from actual policy blob ${actualPolicyBlob}`,
    );
  }
  // Proof: including evidence entries here changed the identity from 797015... to fa835d...
  // after an evidence-only edit, so the production CLI reported stale instead of current.
  const entries = candidate.entries
    .filter(isContent)
    .sort((left, right) => compareCanonicalText(left.path, right.path));
  const manifest: ContentManifest = {
    schemaVersion: 1,
    manifestKind: 'content',
    protocol: request.protocol,
    classificationPolicy: request.classificationPolicy,
    relationshipInputs: [...request.relationshipInputs].sort((left, right) =>
      compareCanonicalText(left.inputId, right.inputId),
    ),
    extractors: [...request.extractors].sort((left, right) =>
      compareCanonicalText(left.extractorId, right.extractorId),
    ),
    entries,
  };
  const bytes = serializeCanonical(manifest);
  return { manifest, bytes, identity: hashBytes(bytes) };
}

/** Compares a reviewed content identity with a freshly built manifest identity. */
export function compareContentIdentity(
  reviewedIdentity: string | undefined,
  currentIdentity: string,
): 'unassessed' | 'current' | 'stale' {
  if (reviewedIdentity === undefined) return 'unassessed';
  // Proof: removing this boundary made the production CLI accept `not-a-content-identity` and
  // report ordinary stale currency instead of refusing malformed review state.
  if (!Sha256Pattern.test(reviewedIdentity)) {
    throw new Error(`reviewed content identity is not SHA-256: ${reviewedIdentity}`);
  }
  return reviewedIdentity === currentIdentity ? 'current' : 'stale';
}

interface ArtifactReport {
  validationId: string;
  validationIdentity: string;
  artifactCount: number;
  visitedCount: number;
  traversalBound: number;
}

type EvidenceEntry = ClassifiedEntry & { classification: EvidenceClassification };

function isEvidence(entry: ClassifiedEntry): entry is EvidenceEntry {
  return entry.classification.kind === 'evidence';
}

function parseArtifact(bytes: Uint8Array, path: string): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`evidence artifact ${path} is not UTF-8: ${detail}`, { cause });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`evidence artifact ${path} is malformed JSON: ${detail}`, { cause });
  }
}

function checkAcyclic(
  artifacts: ReadonlyMap<string, ArtifactGraph['artifacts'][number]>,
  traversalBound: number,
): void {
  const states = new Map<string, 'visiting' | 'visited'>();
  let operations = 0;
  for (const start of artifacts.keys()) {
    if (states.has(start)) continue;
    const stack: { identity: string; referenceIndex: number }[] = [
      { identity: start, referenceIndex: 0 },
    ];
    states.set(start, 'visiting');
    operations += 1;
    while (stack.length > 0) {
      if (operations > traversalBound) {
        throw new Error(
          'finite artifact validation exceeded its graph bound while resolving cyclic or self evidence obligations',
        );
      }
      const frame = stack.at(-1);
      if (frame === undefined) throw new Error('artifact traversal stack lost its active frame');
      const artifact = artifacts.get(frame.identity);
      if (artifact === undefined) {
        throw new Error(`missing artifact dependency ${frame.identity}`);
      }
      if (frame.referenceIndex >= artifact.references.length) {
        states.set(frame.identity, 'visited');
        stack.pop();
        continue;
      }
      const dependency = artifact.references[frame.referenceIndex];
      frame.referenceIndex += 1;
      operations += 1;
      if (dependency === frame.identity) {
        // Evidence artifacts are schema/provenance checked; demanding review of their own bytes
        // would make each validating edit create a new obligation forever.
        throw new Error(`evidence cannot require itself: ${artifact.path}`);
      }
      // Proof: removing this edge-boundary check lost the referring artifact from the production
      // diagnostic, reporting only the absent 999... identity instead of the broken obligation.
      if (!artifacts.has(dependency)) {
        throw new Error(`missing artifact dependency ${dependency} referenced by ${artifact.path}`);
      }
      const state = states.get(dependency);
      // Proof: removing this cycle diagnosis did not hang or rely on a test timeout: the production
      // CLI exited 1 at its finite graph bound, and the oracle missed `cyclic evidence dependency`.
      if (state === 'visiting') {
        throw new Error(`cyclic evidence dependency from ${artifact.path} to ${dependency}`);
      }
      if (state !== 'visited') {
        states.set(dependency, 'visiting');
        stack.push({ identity: dependency, referenceIndex: 0 });
        operations += 1;
      }
    }
  }
}

function findReachable(
  roots: readonly string[],
  artifacts: ReadonlyMap<string, ArtifactGraph['artifacts'][number]>,
): Set<string> {
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const identity = pending.pop();
    if (identity === undefined || reachable.has(identity)) continue;
    const artifact = artifacts.get(identity);
    if (artifact === undefined) throw new Error(`missing artifact root ${identity}`);
    reachable.add(identity);
    pending.push(...artifact.references);
  }
  return reachable;
}

function identifyArtifactGraph(graph: ArtifactGraph): string {
  // Proof: hashing caller array order gave 9b5194... for the same graph whose canonical
  // identity was 30b837..., and the production CLI reordering oracle failed.
  return hashCanonical({
    ...graph,
    roots: [...graph.roots].sort(compareCanonicalText),
    artifacts: graph.artifacts
      .map((artifact) => ({
        ...artifact,
        references: [...artifact.references].sort(compareCanonicalText),
      }))
      .sort((left, right) => compareCanonicalText(left.artifactId, right.artifactId)),
  });
}

/**
 * Validates the exact selected evidence set against a finite, externally supplied artifact graph.
 * @throws when bytes, schema, descriptors, roots, dependencies, reachability, or finiteness differ.
 */
export function validateArtifacts(
  candidate: ClassifiedCandidate,
  graph: ArtifactGraph,
  readBlob: ReadBlob,
): ArtifactReport {
  const evidence = candidate.entries.filter(isEvidence);
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry]));
  const descriptorsByPath = new Map(graph.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const entry of evidence) {
    // Proof: removing this exact-set guard made the production oracle miss the omitted path and
    // fail later on a different dependency diagnostic instead of naming unaccounted evidence.
    if (!descriptorsByPath.has(entry.path)) {
      throw new Error(`candidate evidence absent from artifact graph: ${entry.path}`);
    }
  }
  for (const artifact of graph.artifacts) {
    const entry = evidenceByPath.get(artifact.path);
    if (entry === undefined) {
      // Proof: replacing this refusal with `continue` made the production CLI accept an extra
      // reachable graph artifact with artifactCount 3, visitedCount 3 and traversalBound 4.
      throw new Error(`artifact graph path absent from candidate evidence: ${artifact.path}`);
    }
    // Proof: removing this exact descriptor comparison let a graph name blob 888... for selected
    // evidence while the production CLI exited 0 with artifactCount 2.
    if (artifact.blob !== entry.blob || artifact.recordKind !== entry.classification.recordKind) {
      throw new Error(`artifact descriptor differs from selected evidence: ${artifact.path}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = readBlob(entry.blob, entry.path);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`cannot read evidence artifact ${entry.path}: ${detail}`, { cause });
    }
    // Proof: removing the byte-identity comparison made the production CLI exit 0 after the graph
    // substituted artifact identity 777... while retaining the candidate's actual bytes.
    if (hashBytes(bytes) !== artifact.artifactId) {
      throw new Error(`artifact byte identity differs from graph: ${artifact.path}`);
    }
    // Proof: removing strict record decoding let a second artifact read substitute an allowlisted
    // blob with `recordKind: unknown`; the production CLI exited 0 with artifactCount 2.
    decodeRecord(artifact.recordKind, parseArtifact(bytes, artifact.path));
  }

  // Proof: injecting every artifact's own identity as a required dependency made the bounded
  // production validator exit 1 on `evidence cannot require itself: ...second.v1.json`.
  const artifacts = new Map(graph.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const traversalBound =
    graph.artifacts.length +
    graph.artifacts.reduce((count, artifact) => count + artifact.references.length, 0);
  checkAcyclic(artifacts, traversalBound);
  const reachable = findReachable(graph.roots, artifacts);
  const unreachable = graph.artifacts.find((artifact) => !reachable.has(artifact.artifactId));
  // Proof: removing this root-reachability refusal made the production CLI exit 0 with
  // artifactCount 2 and visitedCount 0 for a graph whose roots were empty.
  if (unreachable !== undefined) {
    throw new Error(`unreachable artifact outside finite roots: ${unreachable.path}`);
  }
  return {
    validationId: graph.validationId,
    validationIdentity: identifyArtifactGraph(graph),
    artifactCount: graph.artifacts.length,
    visitedCount: reachable.size,
    traversalBound,
  };
}
