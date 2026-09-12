import { realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

import { compareCanonicalText } from '../evidence/content-manifest';
import { type CandidateEntry, readCandidate } from '../inventory/read-candidate';
import { assertAuthoritySessionId, assertAuthorityWorktreePath } from './authority-identities';
import type { AuthorityClaim, AuthorityPacketBinding, AuthorityStore } from './authority-store';
import { bindAdmissionPacket, type ClaimToken, expandBoundPacketClaims } from './claims';
import {
  type AdmissionBase,
  type AdmissionPacket,
  type AdmissionPacketIntent,
  assertAdmissionPacket,
  assertNarrative,
  canonicalPaths,
  packetBody,
  packetBodyBytes,
  uniqueSorted,
  withPacketIdentity,
} from './packet-codec';

export type {
  AdmissionBase,
  AdmissionPacket,
  AdmissionPacketIntent,
  AdmissionReadDependency,
} from './packet-codec';
export { assertAdmissionPacket, decodeAdmissionPacket } from './packet-codec';

const Sha256Identity = /^[0-9a-f]{64}$/;

function canonicalRepository(repository: string): string {
  if (!isAbsolute(repository) || normalize(repository) !== repository) {
    throw new Error(`invalid canonical worktree path: ${repository}`);
  }
  const canonical = realpathSync(repository);
  if (canonical !== repository) {
    throw new Error(`worktree path is a filesystem alias: ${repository}`);
  }
  assertAuthorityWorktreePath(canonical);
  return canonical;
}

function ancestorPaths(path: string): string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let end = 1; end < segments.length; end += 1) {
    ancestors.push(segments.slice(0, end).join('/'));
  }
  return ancestors;
}

function assertUnambiguousPath(path: string, entries: ReadonlyMap<string, CandidateEntry>): void {
  for (const ancestor of ancestorPaths(path)) {
    const entry = entries.get(ancestor);
    // Proof: bypassing this submit-time ancestor check made both independently rehashed
    // `CLAUDE.md/escape` and Gitlink-descendant packets reach authority comparison; the
    // production CLI test lost the exact traversal refusal.
    if (entry?.mode === '120000' || entry?.mode === '160000') {
      throw new Error(
        `packet path traverses ${entry.mode === '120000' ? 'symlink' : 'gitlink'}: ${path}`,
      );
    }
  }
}

function entriesEqual(left: CandidateEntry | undefined, right: CandidateEntry): boolean {
  return left?.path === right.path && left.mode === right.mode && left.blob === right.blob;
}

function readBaseEntries(repository: string, base: AdmissionBase): Map<string, CandidateEntry> {
  const snapshot = readCandidate(repository, { kind: 'committed', revision: base.commit });
  if (snapshot.selection.kind !== 'committed' || snapshot.selection.tree !== base.tree) {
    throw new Error('packet base commit does not resolve to pinned tree');
  }
  return new Map(snapshot.entries.map((entry) => [entry.path, entry]));
}

/** Revalidates every packet path and read tuple against its immutable base tree. */
export function validatePacketAgainstBase(
  repository: string,
  packet: AdmissionPacket,
): Map<string, CandidateEntry> {
  assertAdmissionPacket(packet);
  const worktreePath = canonicalRepository(repository);
  if (worktreePath !== packet.worktreePath) {
    throw new Error('packet repository differs from packet worktree');
  }
  const entries = readBaseEntries(worktreePath, packet.base);
  for (const path of packet.ownedPaths) assertUnambiguousPath(path, entries);
  for (const dependency of packet.readDependencies) {
    assertUnambiguousPath(dependency.path, entries);
    // Proof: omitting this independent base-tuple check let a hash-valid forged read blob reach
    // authority comparison; the binding test lost its packet-read diagnostic.
    if (!entriesEqual(entries.get(dependency.path), dependency)) {
      throw new Error(`packet read dependency differs from base: ${dependency.path}`);
    }
  }
  return entries;
}

function expectedClaims(packet: AdmissionPacket): AuthorityClaim[] {
  return [
    ...packet.ownedPaths.map((identity): AuthorityClaim => ({
      access: 'write',
      identity,
      kind: 'path',
    })),
    ...packet.readDependencies.map(({ path: identity }): AuthorityClaim => ({
      access: 'read',
      identity,
      kind: 'path',
    })),
    ...packet.conflictGroups.map((identity): AuthorityClaim => ({ identity, kind: 'group' })),
  ].sort((left, right) => {
    const identity = compareCanonicalText(left.identity, right.identity);
    return identity === 0 ? compareCanonicalText(left.kind, right.kind) : identity;
  });
}

function packetBinding(packet: AdmissionPacket): AuthorityPacketBinding {
  return { packetBytes: packetBodyBytes(packet), packetIdentity: packet.packetIdentity };
}

/** Creates and atomically binds a finite packet to the exact live authority generation. */
export function createAdmissionPacket(
  store: AuthorityStore,
  token: ClaimToken,
  repository: string,
  intent: AdmissionPacketIntent,
): AdmissionPacket {
  assertAuthoritySessionId(token.sessionId);
  if (!Number.isSafeInteger(token.generation) || token.generation < 1) {
    throw new Error(`invalid generation: ${String(token.generation)}`);
  }
  assertNarrative(intent.objective, 'objective');
  assertNarrative(intent.outcome, 'outcome');
  if (!Sha256Identity.test(intent.policyIdentity)) throw new Error('invalid policy identity');
  if (!Sha256Identity.test(intent.mappingIdentity)) throw new Error('invalid mapping identity');
  const worktreePath = canonicalRepository(repository);
  const entries = readBaseEntries(worktreePath, intent.base);
  const ownedPaths = canonicalPaths(intent.ownedPaths, 'owned path');
  const readPaths = canonicalPaths(intent.readPaths, 'read path');
  for (const path of [...ownedPaths, ...readPaths]) assertUnambiguousPath(path, entries);
  const readDependencies = readPaths.map((path) => {
    const entry = entries.get(path);
    if (entry === undefined) throw new Error(`packet read dependency is absent: ${path}`);
    return entry;
  });
  const packet = withPacketIdentity({
    base: { ...intent.base },
    checks: uniqueSorted(intent.checks, 'check'),
    consumedContracts: uniqueSorted(intent.consumedContracts, 'consumed contract'),
    consumedInterfaces: uniqueSorted(intent.consumedInterfaces, 'consumed interface'),
    conflictGroups: uniqueSorted(intent.conflictGroups, 'conflict group'),
    evidenceRequirements: uniqueSorted(intent.evidenceRequirements, 'evidence requirement'),
    generation: token.generation,
    invariants: uniqueSorted(intent.invariants, 'invariant'),
    mappingIdentity: intent.mappingIdentity,
    objective: intent.objective,
    outcome: intent.outcome,
    ownedPaths,
    policyIdentity: intent.policyIdentity,
    producedContracts: uniqueSorted(intent.producedContracts, 'produced contract'),
    producedInterfaces: uniqueSorted(intent.producedInterfaces, 'produced interface'),
    readDependencies,
    schemaVersion: 1,
    sessionId: token.sessionId,
    worktreePath,
  });
  assertAdmissionPacket(packet);
  // Proof: omitting the stored binding let independently rehashed policy and checks submit under
  // the same generation; the production binding matrix received submitted reports.
  bindAdmissionPacket(store, {
    claims: expectedClaims(packet),
    nextPacket: packetBinding(packet),
    packet: undefined,
    token,
    worktreePath,
  });
  return packet;
}

/** Atomically adds pinned read dependencies while preserving the packet's write set. */
export function expandPacketReads(
  store: AuthorityStore,
  packet: AdmissionPacket,
  repository: string,
  additions: readonly string[],
): AdmissionPacket {
  const worktreePath = canonicalRepository(repository);
  if (worktreePath !== packet.worktreePath) {
    throw new Error('read expansion repository differs from packet worktree');
  }
  const entries = validatePacketAgainstBase(repository, packet);
  const paths = canonicalPaths(additions, 'read path');
  for (const path of paths) {
    if (
      packet.ownedPaths.some(
        (owned) => owned === path || path.startsWith(`${owned}/`) || owned.startsWith(`${path}/`),
      )
    ) {
      throw new Error('read expansion cannot overlap packet write claims');
    }
  }
  const dependencies = new Map(packet.readDependencies.map((entry) => [entry.path, entry]));
  for (const path of paths) {
    assertUnambiguousPath(path, entries);
    const entry = entries.get(path);
    if (entry === undefined) throw new Error(`packet read dependency is absent: ${path}`);
    dependencies.set(path, entry);
  }
  const expanded = withPacketIdentity({
    ...packetBody(packet),
    readDependencies: [...dependencies.values()].sort((left, right) =>
      compareCanonicalText(left.path, right.path),
    ),
  });
  // Proof: splitting expansion across claim mutation and later validation left `CLAUDE.md` added
  // after a stale packet refusal; the production test observed the claim count grow from three
  // to four instead of exact state equality.
  expandBoundPacketClaims(store, {
    additions: paths.map((path) => ({ access: 'read', path })),
    claims: expectedClaims(packet),
    nextPacket: packetBinding(expanded),
    packet: packetBinding(packet),
    token: { generation: packet.generation, sessionId: packet.sessionId },
    worktreePath: packet.worktreePath,
  });
  return expanded;
}

export function packetAuthorityClaims(packet: AdmissionPacket): readonly AuthorityClaim[] {
  assertAdmissionPacket(packet);
  return expectedClaims(packet);
}
