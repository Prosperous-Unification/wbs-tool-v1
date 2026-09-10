import { posix } from 'node:path';

import { ValidationError } from '@wbs/validation';

import { decodeRecord } from '../contracts/decode-record';
import type { ClassificationPolicy, ContentClass, EvidenceRecordKind } from '../contracts/records';
import type { CandidateEntry, CandidateSelection } from './read-candidate';

interface ContentSelector {
  kind: 'path' | 'prefix' | 'segment' | 'name' | 'suffix';
  value: string;
}

export type ContentClassification =
  | { kind: 'content'; contentClass: ContentClass }
  | {
      kind: 'content';
      contentClass: 'binary';
      format: string;
      consumer: string;
      regenerationAuthority:
        { kind: 'source'; path: string } | { kind: 'external'; authority: string };
    }
  | {
      kind: 'content';
      contentClass: 'symlink';
      target: string;
      resolvedTarget: string;
    }
  | {
      kind: 'content';
      contentClass: 'gitlink';
      boundaryId: string;
      repository: string;
    };

export interface EvidenceClassification {
  kind: 'evidence';
  evidenceRoot: string;
  recordKind: EvidenceRecordKind;
}

export interface ClassifiedEntry extends CandidateEntry {
  classification: ContentClassification | EvidenceClassification;
}

export interface ClassifiedCandidate {
  selection: CandidateSelection;
  entries: ClassifiedEntry[];
  untracked: string[];
  policyId: string;
}

export type ReadBlob = (blob: string, path: string) => Uint8Array;

function isSelected(path: string, selector: ContentSelector): boolean {
  const segments = path.split('/');
  switch (selector.kind) {
    case 'path':
      return path === selector.value;
    case 'prefix':
      return path === selector.value || path.startsWith(`${selector.value}/`);
    case 'segment':
      return segments.includes(selector.value);
    case 'name':
      return segments.at(-1) === selector.value;
    case 'suffix':
      return path.endsWith(selector.value);
  }
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`undeclared binary content at ${path}: ${detail}`, { cause });
  }
}

function classifySymlink(entry: CandidateEntry, readBlob: ReadBlob): ContentClassification {
  const target = decodeUtf8(readBlob(entry.blob, entry.path), entry.path);
  if (target.length === 0 || target.includes('\u0000') || target.startsWith('/')) {
    throw new Error(`symlink ${entry.path} has an invalid repository-relative target`);
  }
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(entry.path), target));
  if (resolvedTarget === '..' || resolvedTarget.startsWith('../')) {
    throw new Error(`symlink ${entry.path} escapes the repository: ${target}`);
  }
  return { kind: 'content', contentClass: 'symlink', target, resolvedTarget };
}

function classifyGitlink(
  entry: CandidateEntry,
  policy: ClassificationPolicy,
): ContentClassification {
  const boundary = policy.gitlinkBoundaries.find((candidate) => candidate.path === entry.path);
  if (boundary === undefined) {
    // Proof: replacing this refusal with an implicit boundary made the production CLI exit 0
    // and emit `external/tool` as `injected.undeclared` (expected refusal).
    throw new Error(`Gitlink ${entry.path} has no declared external boundary`);
  }
  if (boundary.object !== entry.blob) {
    throw new Error(
      `Gitlink ${entry.path} object ${entry.blob} differs from declared object ${boundary.object}`,
    );
  }
  return {
    kind: 'content',
    contentClass: 'gitlink',
    boundaryId: boundary.boundaryId,
    repository: boundary.repository,
  };
}

function parseEvidence(bytes: Uint8Array, path: string): unknown {
  const source = decodeUtf8(bytes, path);
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Proof: replacing this refusal with an implicit opaque-transcript wrapper made the
    // production CLI exit 0 and accept `prose.v1.json` as schema-wrapped evidence.
    throw new Error(`reserved evidence ${path} is not JSON: ${detail}`, { cause });
  }
}

function classifyEvidence(
  entry: CandidateEntry,
  root: ClassificationPolicy['evidenceRoots'][number],
  readBlob: ReadBlob,
): EvidenceClassification {
  // Proof: removing this mode guard made the production CLI exit 0 and classify
  // `executable.v1.json` at mode 100755 as opaque-transcript evidence.
  if (entry.mode !== '100644') {
    throw new Error(`reserved evidence must use mode 100644: ${entry.path} uses ${entry.mode}`);
  }
  // Proof: removing this path guard made the production CLI exit 0 and classify
  // `docs/review-evidence/hidden.ts` as the opaque-transcript evidence schema.
  if (!entry.path.endsWith('.json')) {
    throw new Error(`source-like path is not an evidence schema: ${entry.path}`);
  }
  const input = parseEvidence(readBlob(entry.blob, entry.path), entry.path);
  const matches: EvidenceRecordKind[] = [];
  for (const kind of root.allowedRecordKinds) {
    try {
      decodeRecord(kind, input);
      matches.push(kind);
    } catch (cause) {
      if (!(cause instanceof ValidationError)) throw cause;
    }
  }
  // Proof: removing this cardinality guard made the production CLI exit 0 for
  // `unknown.v1.json`, emitting evidence with no `recordKind` (expected refusal).
  if (matches.length !== 1) {
    throw new Error(
      `reserved evidence ${entry.path} does not match exactly one allowlisted evidence schema`,
    );
  }
  const recordKind = matches[0];
  return { kind: 'evidence', evidenceRoot: root.path, recordKind };
}

function classifyOrdinary(
  entry: CandidateEntry,
  policy: ClassificationPolicy,
  readBlob: ReadBlob,
): ContentClassification {
  const binary = policy.binaryDeclarations.find((candidate) => candidate.path === entry.path);
  const bytes = readBlob(entry.blob, entry.path);
  let isBinary = false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    isBinary = true;
  }
  if (isBinary) {
    if (binary === undefined) throw new Error(`undeclared binary content at ${entry.path}`);
    return {
      kind: 'content',
      contentClass: 'binary',
      format: binary.format,
      consumer: binary.consumer,
      regenerationAuthority: binary.regenerationAuthority,
    };
  }
  if (binary !== undefined) {
    throw new Error(`declared binary ${entry.path} contains ordinary UTF-8 text`);
  }
  const matches = policy.contentRules.filter(
    (rule) =>
      rule.include.some((selector) => isSelected(entry.path, selector)) &&
      !rule.exclude.some((selector) => isSelected(entry.path, selector)),
  );
  if (matches.length !== 1) {
    throw new Error(
      `ordinary content ${entry.path} matched ${String(matches.length)} classification rules`,
    );
  }
  const match = matches[0];
  return { kind: 'content', contentClass: match.contentClass };
}

/**
 * Partitions exact candidate tuples into ordinary content and the two reserved evidence roots.
 * Blob reads use each tuple's object identity; symlinks are inspected without following targets.
 */
export function classifyEntries(
  entries: readonly CandidateEntry[],
  policy: ClassificationPolicy,
  readBlob: ReadBlob,
): ClassifiedEntry[] {
  return entries.map((entry) => {
    if (entry.mode === '120000') {
      return { ...entry, classification: classifySymlink(entry, readBlob) };
    }
    if (entry.mode === '160000') {
      return { ...entry, classification: classifyGitlink(entry, policy) };
    }
    const evidenceRoot = policy.evidenceRoots.find(
      (root) => entry.path === root.path || entry.path.startsWith(`${root.path}/`),
    );
    return {
      ...entry,
      classification:
        evidenceRoot === undefined
          ? classifyOrdinary(entry, policy, readBlob)
          : classifyEvidence(entry, evidenceRoot, readBlob),
    };
  });
}
