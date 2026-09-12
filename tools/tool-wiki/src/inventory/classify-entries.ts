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

/** Git-compatible NUL sniff window; valid UTF-8 after it remains eligible as source text. */
const BinarySniffByteLimit = 8_000;

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

function decodeUtf8(bytes: Uint8Array, path: string, preserveBom = false): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`undeclared binary content at ${path}: ${detail}`, { cause });
  }
}

function classifySymlink(entry: CandidateEntry, readBlob: ReadBlob): ContentClassification {
  // Proof: omitting `ignoreBOM: true` made the production CLI report `README.md` for both
  // target fields where the exact committed symlink blob starts with `\uFEFFREADME.md`.
  const target = decodeUtf8(readBlob(entry.blob, entry.path), entry.path, true);
  if (target.length === 0 || target.includes('\u0000') || target.startsWith('/')) {
    throw new Error(`symlink ${entry.path} has an invalid repository-relative target`);
  }
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(entry.path), target));
  // Proof: removing this refusal made the production CLI exit 0 with target `../../outside`
  // resolved to the repository-external path `../outside`.
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
  // Proof: removing this comparison made the production CLI exit 0 and classify the selected
  // Gitlink object through a boundary pinned to a different object.
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

function hasBinaryBytes(bytes: Uint8Array): boolean {
  // Proof: removing the bounded NUL check made the production CLI reject a declared minimal WASM
  // module as ordinary UTF-8 and accept the same undeclared bytes at a `.ts` path as source.
  // Proof: widening the sample to the whole blob made the production CLI exit 1 with
  // `undeclared binary content` for valid UTF-8 whose literal NUL follows byte 8,192.
  if (bytes.subarray(0, BinarySniffByteLimit).includes(0)) return true;
  try {
    // Proof: removing `fatal: true` made the production CLI exit 0 and classify a non-NUL
    // `0xff` byte after offset 8,000 at `src/invalid-utf8.ts` as source.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    return true;
  }
}

function classifyOrdinary(
  entry: CandidateEntry,
  policy: ClassificationPolicy,
  readBlob: ReadBlob,
): ContentClassification {
  const binary = policy.binaryDeclarations.find((candidate) => candidate.path === entry.path);
  const bytes = readBlob(entry.blob, entry.path);
  const isBinary = hasBinaryBytes(bytes);
  if (isBinary && binary !== undefined) {
    return {
      kind: 'content',
      contentClass: 'binary',
      format: binary.format,
      consumer: binary.consumer,
      regenerationAuthority: binary.regenerationAuthority,
    };
  }
  // Proof: removing this refusal made the production CLI exit 0 and classify the NUL-bearing
  // minimal WASM bytes at `src/undeclared.ts` as source.
  if (isBinary) throw new Error(`undeclared binary content at ${entry.path}`);
  if (binary !== undefined) {
    throw new Error(`declared binary ${entry.path} contains ordinary UTF-8 text`);
  }
  const matches = policy.contentRules.filter(
    (rule) =>
      rule.include.some((selector) => isSelected(entry.path, selector)) &&
      !rule.exclude.some((selector) => isSelected(entry.path, selector)),
  );
  // Proof: removing this refusal made the production CLI lose the contextual diagnostic and
  // emit `undefined is not an object (evaluating 'matches[0].contentClass')` for `unknown.zzz`.
  if (matches.length === 0) {
    throw new Error(
      `ordinary content ${entry.path} matched ${String(matches.length)} classification rules`,
    );
  }
  // Proof: removing this refusal made the production CLI exit 0 and classify a path matched by
  // both test and source rules as test content.
  if (matches.length > 1) {
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
    // Proof: putting the symlink early return above this lookup made a reserved mode-120000 path
    // exit 0 as symlink content; doing the same for Gitlinks made mode 160000 exit 0 as content.
    const evidenceRoot = policy.evidenceRoots.find(
      (root) => entry.path === root.path || entry.path.startsWith(`${root.path}/`),
    );
    if (evidenceRoot !== undefined) {
      return { ...entry, classification: classifyEvidence(entry, evidenceRoot, readBlob) };
    }
    if (entry.mode === '120000') {
      return { ...entry, classification: classifySymlink(entry, readBlob) };
    }
    if (entry.mode === '160000') {
      return { ...entry, classification: classifyGitlink(entry, policy) };
    }
    return {
      ...entry,
      classification: classifyOrdinary(entry, policy, readBlob),
    };
  });
}
