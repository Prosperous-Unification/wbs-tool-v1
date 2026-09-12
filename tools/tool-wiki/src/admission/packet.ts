import { realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

import { hashCanonical } from '../evidence/content-manifest';
import { type CandidateEntry, readCandidate } from '../inventory/read-candidate';
import type { AuthorityClaim, AuthorityStore } from './authority-store';
import {
  assertAuthorityClaimPath,
  assertAuthorityConflictGroup,
  assertAuthoritySessionId,
  assertAuthorityWorktreePath,
} from './authority-store';
import { type ClaimToken, expandClaims } from './claims';

const ObjectIdentity = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const Sha256Identity = /^[0-9a-f]{64}$/;
const PacketTerm = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface AdmissionBase {
  readonly commit: string;
  readonly tree: string;
}

export type AdmissionReadDependency = CandidateEntry;

export interface AdmissionPacketIntent {
  readonly objective: string;
  readonly outcome: string;
  readonly base: AdmissionBase;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly ownedPaths: readonly string[];
  readonly readPaths: readonly string[];
  readonly conflictGroups: readonly string[];
  readonly consumedContracts: readonly string[];
  readonly consumedInterfaces: readonly string[];
  readonly producedContracts: readonly string[];
  readonly producedInterfaces: readonly string[];
  readonly invariants: readonly string[];
  readonly checks: readonly string[];
  readonly evidenceRequirements: readonly string[];
}

export interface AdmissionPacket {
  readonly schemaVersion: 1;
  readonly packetIdentity: string;
  readonly objective: string;
  readonly outcome: string;
  readonly base: AdmissionBase;
  readonly policyIdentity: string;
  readonly mappingIdentity: string;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly ownedPaths: readonly string[];
  readonly readDependencies: readonly AdmissionReadDependency[];
  readonly conflictGroups: readonly string[];
  readonly consumedContracts: readonly string[];
  readonly consumedInterfaces: readonly string[];
  readonly producedContracts: readonly string[];
  readonly producedInterfaces: readonly string[];
  readonly invariants: readonly string[];
  readonly checks: readonly string[];
  readonly evidenceRequirements: readonly string[];
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function uniqueSorted(values: readonly string[], subject: string): string[] {
  const normalized = [...values].sort(compareText);
  for (let index = 0; index < normalized.length; index += 1) {
    const value = normalized[index];
    if (!PacketTerm.test(value)) {
      throw new Error(`invalid ${subject}: ${value}`);
    }
    if (index > 0 && normalized[index - 1] === value) {
      throw new Error(`duplicate ${subject}: ${value}`);
    }
  }
  return normalized;
}

function assertCanonicalOrder(values: readonly string[], subject: string): void {
  const canonical = uniqueSorted(values, subject);
  if (canonical.some((value, index) => value !== values[index])) {
    throw new Error(`noncanonical ${subject} order`);
  }
}

function canonicalPaths(values: readonly string[], subject: string): string[] {
  const paths = [...values].sort(compareText);
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    assertAuthorityClaimPath(path);
    if (index > 0 && paths[index - 1] === path) throw new Error(`duplicate ${subject}: ${path}`);
  }
  return paths;
}

function canonicalRepository(repository: string): string {
  if (!isAbsolute(repository) || normalize(repository) !== repository) {
    throw new Error(`invalid canonical worktree path: ${repository}`);
  }
  const canonical = realpathSync(repository);
  // Proof: accepting the lexical alias returned a packet for `repository-alias`; the production
  // real-worktree test received that packet instead of a filesystem-alias refusal.
  if (canonical !== repository)
    throw new Error(`worktree path is a filesystem alias: ${repository}`);
  assertAuthorityWorktreePath(canonical);
  return canonical;
}

function assertBase(base: AdmissionBase): void {
  if (!ObjectIdentity.test(base.commit)) throw new Error('invalid packet base commit');
  if (!ObjectIdentity.test(base.tree)) throw new Error('invalid packet base tree');
}

function assertDigest(identity: string, subject: string): void {
  if (!Sha256Identity.test(identity)) throw new Error(`invalid ${subject} identity`);
}

function assertNarrative(value: string, subject: string): void {
  if (value.trim().length === 0 || value.includes('\u0000')) {
    throw new Error(`invalid packet ${subject}`);
  }
}

function ancestorPaths(path: string): string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let end = 1; end < segments.length; end += 1)
    ancestors.push(segments.slice(0, end).join('/'));
  return ancestors;
}

function assertUnambiguousPath(path: string, entries: ReadonlyMap<string, CandidateEntry>): void {
  for (const ancestor of ancestorPaths(path)) {
    const entry = entries.get(ancestor);
    // Proof: bypassing this ancestor check let `owned-link/escaped.ts` enter the packet; the
    // real-worktree test received a packet instead of the required symlink-traversal refusal.
    if (entry?.mode === '120000' || entry?.mode === '160000') {
      throw new Error(
        `packet path traverses ${entry.mode === '120000' ? 'symlink' : 'gitlink'}: ${path}`,
      );
    }
  }
}

function readBaseEntries(repository: string, base: AdmissionBase): Map<string, CandidateEntry> {
  assertBase(base);
  const snapshot = readCandidate(repository, { kind: 'committed', revision: base.commit });
  if (snapshot.selection.kind !== 'committed' || snapshot.selection.tree !== base.tree) {
    throw new Error('packet base commit does not resolve to pinned tree');
  }
  return new Map(snapshot.entries.map((entry) => [entry.path, entry]));
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
    const identity = compareText(left.identity, right.identity);
    return identity === 0 ? compareText(left.kind, right.kind) : identity;
  });
}

function assertGeneration(
  store: AuthorityStore,
  token: ClaimToken,
  worktreePath: string,
  claims: readonly AuthorityClaim[],
): void {
  store.transact((transaction) => {
    const generation = transaction
      .readState()
      .generations.find(
        (candidate) =>
          candidate.sessionId === token.sessionId && candidate.generation === token.generation,
      );
    if (generation?.status !== 'working') {
      throw new Error(`generation is not working: ${token.sessionId}`);
    }
    const sameClaims =
      generation.claims.length === claims.length &&
      generation.claims.every((claim, index) => {
        const expected = claims[index];
        return (
          claim.kind === expected.kind &&
          claim.identity === expected.identity &&
          (claim.kind === 'group' || (expected.kind === 'path' && claim.access === expected.access))
        );
      });
    if (generation.worktreePath !== worktreePath || !sameClaims) {
      throw new Error(`generation authority differs from admission packet: ${token.sessionId}`);
    }
  });
}

function packetWithoutIdentity(packet: AdmissionPacket): Omit<AdmissionPacket, 'packetIdentity'> {
  const { packetIdentity: _identity, ...body } = packet;
  return body;
}

function withIdentity(body: Omit<AdmissionPacket, 'packetIdentity'>): AdmissionPacket {
  return { ...body, packetIdentity: hashCanonical(body) };
}

/** Creates a finite packet bound to the exact live authority generation and base tree. */
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
  assertDigest(intent.policyIdentity, 'policy');
  assertDigest(intent.mappingIdentity, 'mapping');
  const worktreePath = canonicalRepository(repository);
  const entries = readBaseEntries(worktreePath, intent.base);
  const ownedPaths = canonicalPaths(intent.ownedPaths, 'owned path');
  const readPaths = canonicalPaths(intent.readPaths, 'read path');
  if (ownedPaths.length === 0) throw new Error('packet requires at least one owned path');
  if (intent.checks.length === 0) throw new Error('packet requires at least one check');
  if (intent.invariants.length === 0) throw new Error('packet requires at least one invariant');
  if (intent.evidenceRequirements.length === 0) {
    throw new Error('packet requires at least one evidence requirement');
  }
  for (const path of [...ownedPaths, ...readPaths]) assertUnambiguousPath(path, entries);
  const readDependencies = readPaths.map((path) => {
    const entry = entries.get(path);
    if (entry === undefined) throw new Error(`packet read dependency is absent: ${path}`);
    return entry;
  });
  const body: Omit<AdmissionPacket, 'packetIdentity'> = {
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
  };
  const packet = withIdentity(body);
  assertGeneration(store, token, worktreePath, expectedClaims(packet));
  return packet;
}

/** Atomically adds pinned read dependencies while preserving the packet's write set. */
export function expandPacketReads(
  store: AuthorityStore,
  packet: AdmissionPacket,
  repository: string,
  additions: readonly string[],
): AdmissionPacket {
  assertAdmissionPacket(packet);
  const paths = canonicalPaths(additions, 'read path');
  for (const path of paths) {
    // Proof: removing this separation let `src/owned.ts` join the packet's read set beneath its
    // write claim; the production expansion test received an expanded packet instead of refusal.
    if (
      packet.ownedPaths.some(
        (owned) => owned === path || path.startsWith(`${owned}/`) || owned.startsWith(`${path}/`),
      )
    ) {
      throw new Error('read expansion cannot overlap packet write claims');
    }
  }
  const worktreePath = canonicalRepository(repository);
  // Proof: omitting this binding returned an expanded packet from the sibling worktree; the
  // production test received that packet instead of the required worktree refusal.
  if (worktreePath !== packet.worktreePath) {
    throw new Error('read expansion repository differs from packet worktree');
  }
  const entries = readBaseEntries(worktreePath, packet.base);
  const dependencies = new Map(packet.readDependencies.map((entry) => [entry.path, entry]));
  for (const path of paths) {
    assertUnambiguousPath(path, entries);
    const entry = entries.get(path);
    if (entry === undefined) throw new Error(`packet read dependency is absent: ${path}`);
    dependencies.set(path, entry);
  }
  expandClaims(store, {
    conflictGroups: [],
    paths: paths.map((path) => ({ access: 'read', path })),
    token: { generation: packet.generation, sessionId: packet.sessionId },
  });
  const expanded = withIdentity({
    ...packetWithoutIdentity(packet),
    readDependencies: [...dependencies.values()].sort((left, right) =>
      compareText(left.path, right.path),
    ),
  });
  assertGeneration(
    store,
    { generation: packet.generation, sessionId: packet.sessionId },
    packet.worktreePath,
    expectedClaims(expanded),
  );
  return expanded;
}

/** Validates an external packet before any authority or Git operation consumes it. */
export function assertAdmissionPacket(packet: AdmissionPacket): void {
  assertBase(packet.base);
  assertDigest(packet.packetIdentity, 'packet');
  // Proof: bypassing this digest guard made the production CLI accept the independently rehashed
  // `policyIdentity: bad` packet with exit 0; its boundary test expected exit 1.
  assertDigest(packet.policyIdentity, 'policy');
  // Proof: bypassing this guard made the production CLI accept `mappingIdentity: bad` with exit
  // 0; the independently rehashed malformed-packet test expected exit 1.
  assertDigest(packet.mappingIdentity, 'mapping');
  assertAuthoritySessionId(packet.sessionId);
  assertAuthorityWorktreePath(packet.worktreePath);
  // Proof: bypassing this early boundary changed generation 0's production CLI diagnostic to the
  // authority token error; the malformed-packet test requires this packet refusal.
  if (!Number.isSafeInteger(packet.generation) || packet.generation < 1) {
    throw new Error(`invalid admission packet generation: ${String(packet.generation)}`);
  }
  // Proof: bypassing this decoder guard made the production CLI accept the independently rehashed
  // blank-objective packet with exit 0; its boundary test expected exit 1.
  assertNarrative(packet.objective, 'objective');
  // Proof: bypassing this guard made the production CLI accept the independently rehashed blank
  // outcome with exit 0; its malformed-packet test expected exit 1.
  assertNarrative(packet.outcome, 'outcome');
  const ownedPaths = canonicalPaths(packet.ownedPaths, 'owned path');
  const readPaths = canonicalPaths(
    packet.readDependencies.map(({ path }) => path),
    'read path',
  );
  // Proof: bypassing this guard changed the production CLI failure for the independently rehashed
  // `['z','a']` write set to a later authority mismatch; the boundary test required canonicality.
  if (ownedPaths.some((path, index) => path !== packet.ownedPaths[index])) {
    throw new Error('noncanonical owned path order');
  }
  if (readPaths.some((path, index) => path !== packet.readDependencies[index]?.path)) {
    throw new Error('noncanonical read dependency order');
  }
  for (const group of packet.conflictGroups) assertAuthorityConflictGroup(group);
  assertCanonicalOrder(packet.conflictGroups, 'conflict group');
  // Proof: bypassing canonical check order made the production CLI accept `['z','a']` with exit 0;
  // its independently rehashed malformed-packet test expected exit 1.
  assertCanonicalOrder(packet.checks, 'check');
  assertCanonicalOrder(packet.consumedContracts, 'consumed contract');
  assertCanonicalOrder(packet.consumedInterfaces, 'consumed interface');
  assertCanonicalOrder(packet.producedContracts, 'produced contract');
  assertCanonicalOrder(packet.producedInterfaces, 'produced interface');
  assertCanonicalOrder(packet.invariants, 'invariant');
  assertCanonicalOrder(packet.evidenceRequirements, 'evidence requirement');
  if (packet.ownedPaths.length === 0) throw new Error('packet requires at least one owned path');
  // Proof: bypassing this obligation guard made the production CLI accept the independently
  // rehashed empty-check packet with exit 0; its boundary test expected exit 1.
  if (packet.checks.length === 0) throw new Error('packet requires at least one check');
  // Proof: bypassing this guard made the production CLI accept empty invariants with exit 0; its
  // independently rehashed malformed-packet test expected exit 1.
  if (packet.invariants.length === 0) throw new Error('packet requires at least one invariant');
  // Proof: bypassing this guard made the production CLI accept empty evidence requirements with
  // exit 0; its independently rehashed malformed-packet test expected exit 1.
  if (packet.evidenceRequirements.length === 0) {
    throw new Error('packet requires at least one evidence requirement');
  }
  for (const entry of packet.readDependencies) {
    if (!ObjectIdentity.test(entry.blob))
      throw new Error(`invalid read dependency object: ${entry.path}`);
  }
  // Proof: bypassing this comparison made the production CLI accept changed outcome bytes under
  // the old packet identity with exit 0; the identity test expected exit 1.
  if (hashCanonical(packetWithoutIdentity(packet)) !== packet.packetIdentity) {
    throw new Error('admission packet identity mismatch');
  }
}

function record(
  input: unknown,
  subject: string,
  allowedFields?: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${subject} must be an object`);
  }
  const decoded = Object.fromEntries(
    Reflect.ownKeys(input).map((key) => [String(key), Reflect.get(input, key)]),
  );
  if (allowedFields !== undefined) {
    for (const key of Object.keys(decoded)) {
      if (!allowedFields.has(key)) throw new Error(`undeclared ${subject} field: ${key}`);
    }
  }
  return decoded;
}

function textField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string') throw new Error(`admission packet ${field} must be a string`);
  return value;
}

function textArray(source: Record<string, unknown>, field: string): string[] {
  const value = source[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`admission packet ${field} must be a string array`);
  }
  return value.map((entry) => String(entry));
}

function candidateMode(source: Record<string, unknown>): CandidateEntry['mode'] {
  const mode = textField(source, 'mode');
  // Proof: replacing this refusal with mode 100644 made the production CLI accept a rehashed
  // `100600` dependency with exit 0; its malformed-packet test expected exit 1.
  if (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') {
    throw new Error(`invalid read dependency mode: ${mode}`);
  }
  return mode;
}

/** Decodes the closed packet shape at the JSON/CLI boundary. */
export function decodeAdmissionPacket(input: unknown): AdmissionPacket {
  const allowed = new Set([
    'schemaVersion',
    'packetIdentity',
    'objective',
    'outcome',
    'base',
    'policyIdentity',
    'mappingIdentity',
    'sessionId',
    'worktreePath',
    'generation',
    'ownedPaths',
    'readDependencies',
    'conflictGroups',
    'consumedContracts',
    'consumedInterfaces',
    'producedContracts',
    'producedInterfaces',
    'invariants',
    'checks',
    'evidenceRequirements',
  ]);
  const source = record(input, 'admission packet', allowed);
  // Proof: accepting undeclared packet keys let a caller attach a second unvalidated write set;
  // the production CLI malformed-packet test observed exit 0 instead of boundary refusal.
  const base = record(source['base'], 'admission packet base', new Set(['commit', 'tree']));
  const readInput = source['readDependencies'];
  if (!Array.isArray(readInput))
    throw new Error('admission packet readDependencies must be an array');
  const readDependencies = readInput.map((inputEntry) => {
    const entry = record(
      inputEntry,
      'admission read dependency',
      new Set(['blob', 'mode', 'path']),
    );
    return {
      blob: textField(entry, 'blob'),
      mode: candidateMode(entry),
      path: textField(entry, 'path'),
    };
  });
  const schemaVersion = source['schemaVersion'];
  const generation = source['generation'];
  if (schemaVersion !== 1) throw new Error('invalid admission packet schema version');
  if (typeof generation !== 'number')
    throw new Error('admission packet generation must be a number');
  const packet: AdmissionPacket = {
    base: { commit: textField(base, 'commit'), tree: textField(base, 'tree') },
    checks: textArray(source, 'checks'),
    conflictGroups: textArray(source, 'conflictGroups'),
    consumedContracts: textArray(source, 'consumedContracts'),
    consumedInterfaces: textArray(source, 'consumedInterfaces'),
    evidenceRequirements: textArray(source, 'evidenceRequirements'),
    generation,
    invariants: textArray(source, 'invariants'),
    mappingIdentity: textField(source, 'mappingIdentity'),
    objective: textField(source, 'objective'),
    outcome: textField(source, 'outcome'),
    ownedPaths: textArray(source, 'ownedPaths'),
    packetIdentity: textField(source, 'packetIdentity'),
    policyIdentity: textField(source, 'policyIdentity'),
    producedContracts: textArray(source, 'producedContracts'),
    producedInterfaces: textArray(source, 'producedInterfaces'),
    readDependencies,
    schemaVersion,
    sessionId: textField(source, 'sessionId'),
    worktreePath: textField(source, 'worktreePath'),
  };
  assertAdmissionPacket(packet);
  return packet;
}

export function packetAuthorityClaims(packet: AdmissionPacket): readonly AuthorityClaim[] {
  assertAdmissionPacket(packet);
  return expectedClaims(packet);
}
