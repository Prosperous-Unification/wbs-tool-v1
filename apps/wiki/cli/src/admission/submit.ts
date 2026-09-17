import { Buffer } from 'node:buffer';

import { hashBytes, hashCanonical } from '../evidence/content-manifest';
import { type CandidateEntry, readCandidate } from '../inventory/read-candidate';
import type { AuthorityStore, SubmissionIdentity } from './authority-store';
import { type ClaimToken } from './claims';
import { submitGenerationMatching } from './generations';
import { type AdmissionPacket, packetAuthorityClaims, validatePacketAgainstBase } from './packet';

const ObjectIdentity = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type SubmissionSelection =
  | { readonly kind: 'staged'; readonly base: string }
  | { readonly kind: 'committed'; readonly revision: string };

export interface AdmissionSubmissionReport extends SubmissionIdentity {
  readonly status: 'submitted';
  readonly sessionId: string;
  readonly generation: number;
  readonly candidateTree: string;
  readonly baseRelationship: 'index-based-on-packet-head' | 'commit-descends-from-packet-base';
  readonly changedPaths: readonly string[];
  readonly scope: 'publication violations were detected and refused at submission; editing-time writes were not prevented';
}

interface GitOutput {
  readonly stdout: Buffer;
}

function git(repository: string, argv: readonly string[], context: string): GitOutput {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.toString('utf8');
    throw new Error(
      `publication refused: ${context}: ${detail.length === 0 ? `git exited ${String(invocation.exitCode)}` : detail.trim()}`,
    );
  }
  return { stdout: invocation.stdout };
}

function gitText(repository: string, argv: readonly string[], context: string): string {
  const bytes = git(repository, argv, context).stdout;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`publication refused: ${context}: non-UTF-8 Git output`, { cause });
  }
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (!ObjectIdentity.test(text))
    throw new Error(`publication refused: ${context}: malformed object identity`);
  return text;
}

function entryMap(entries: readonly CandidateEntry[]): Map<string, CandidateEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function entriesEqual(
  left: CandidateEntry | undefined,
  right: CandidateEntry | undefined,
): boolean {
  return left?.path === right?.path && left?.mode === right?.mode && left?.blob === right?.blob;
}

function changedEntries(
  baseEntries: readonly CandidateEntry[],
  candidateEntries: readonly CandidateEntry[],
): { changedPaths: string[]; tuples: unknown[] } {
  const base = entryMap(baseEntries);
  const candidate = entryMap(candidateEntries);
  const paths = [...new Set([...base.keys(), ...candidate.keys()])].sort(compareText);
  const changedPaths: string[] = [];
  const tuples: unknown[] = [];
  for (const path of paths) {
    const before = base.get(path);
    const after = candidate.get(path);
    if (entriesEqual(before, after)) continue;
    changedPaths.push(path);
    tuples.push({ after: after ?? null, before: before ?? null, path });
  }
  return { changedPaths, tuples };
}

function pathOwned(path: string, ownedPaths: readonly string[]): boolean {
  return ownedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`));
}

function resolveSelection(
  repository: string,
  packet: AdmissionPacket,
  selection: SubmissionSelection,
): {
  readonly tree: string;
  readonly entries: readonly CandidateEntry[];
  readonly relationship: AdmissionSubmissionReport['baseRelationship'];
} {
  if (selection.kind === 'staged') {
    // Proof: omitting the HEAD fence let the successor-based index reach diff admission; the
    // production test received an outside-path diagnostic instead of this base refusal.
    const head = gitText(
      repository,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      'cannot resolve worktree HEAD',
    );
    if (selection.base !== packet.base.commit || head !== packet.base.commit) {
      throw new Error('publication refused: staged candidate is not based on packet base HEAD');
    }
    const snapshot = readCandidate(repository, { base: selection.base, kind: 'staged' });
    if (snapshot.selection.kind !== 'staged')
      throw new Error('publication refused: invalid staged selection');
    return {
      entries: snapshot.entries,
      relationship: 'index-based-on-packet-head',
      tree: snapshot.selection.indexTree,
    };
  }
  const snapshot = readCandidate(repository, { kind: 'committed', revision: selection.revision });
  if (snapshot.selection.kind !== 'committed')
    throw new Error('publication refused: invalid committed selection');
  // Proof: omitting the ancestry check submitted an unrelated root with the same tree; the
  // production test received `status: submitted` instead of the required base refusal.
  git(
    repository,
    ['merge-base', '--is-ancestor', packet.base.commit, snapshot.selection.revision],
    'committed candidate does not descend from packet base',
  );
  return {
    entries: snapshot.entries,
    relationship: 'commit-descends-from-packet-base',
    tree: snapshot.selection.tree,
  };
}

/** Validates and freezes one exact immutable publication before fencing its generation. */
export function submitPacket(
  store: AuthorityStore,
  packet: AdmissionPacket,
  repository: string,
  selection: SubmissionSelection,
): AdmissionSubmissionReport {
  const baseEntries = [...validatePacketAgainstBase(repository, packet).values()];
  const candidate = resolveSelection(repository, packet, selection);
  const differences = changedEntries(baseEntries, candidate.entries);
  const candidateByPath = entryMap(candidate.entries);
  for (const dependency of packet.readDependencies) {
    // Proof: bypassing this exact tuple comparison let owned `src/read.ts` change after scoped
    // checks; the production dependency test received a submitted report instead of refusal.
    if (!entriesEqual(dependency, candidateByPath.get(dependency.path))) {
      throw new Error(`publication refused: read dependency changed: ${dependency.path}`);
    }
  }
  for (const path of differences.changedPaths) {
    // Proof: bypassing this complete union check submitted `new-outside.ts`; the production
    // negative matrix received a submitted report instead of the required thrown refusal.
    if (!pathOwned(path, packet.ownedPaths)) {
      throw new Error(`publication refused: changed path is outside packet write claims: ${path}`);
    }
  }
  const patch = git(
    repository,
    [
      'diff-tree',
      '--binary',
      '--full-index',
      '--no-renames',
      '--no-ext-diff',
      '--no-color',
      packet.base.tree,
      candidate.tree,
    ],
    'cannot freeze candidate patch',
  ).stdout;
  // A second immutable selection catches index movement after the first snapshot and patch read.
  const reselected = resolveSelection(repository, packet, selection);
  // Proof: bypassing this final comparison made the raced production CLI exit 0 after its index
  // changed during `diff-tree`; the test expected refusal before authority submission.
  if (reselected.tree !== candidate.tree) {
    throw new Error('publication refused: candidate changed while submission was frozen');
  }
  const submission = {
    candidateDiffIdentity: hashCanonical(differences.tuples),
    contentIdentity: hashCanonical({
      entries: candidate.entries,
      schemaVersion: 1,
      tree: candidate.tree,
    }),
    patchIdentity: hashBytes(patch),
  };
  const token: ClaimToken = { generation: packet.generation, sessionId: packet.sessionId };
  submitGenerationMatching(store, token, submission, {
    claims: packetAuthorityClaims(packet),
    packetIdentity: packet.packetIdentity,
    worktreePath: packet.worktreePath,
  });
  return {
    ...submission,
    baseRelationship: candidate.relationship,
    candidateTree: candidate.tree,
    changedPaths: differences.changedPaths,
    generation: packet.generation,
    scope:
      'publication violations were detected and refused at submission; editing-time writes were not prevented',
    sessionId: packet.sessionId,
    status: 'submitted',
  };
}
