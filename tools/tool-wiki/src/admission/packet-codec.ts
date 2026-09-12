import {
  compareCanonicalText,
  hashCanonical,
  serializeCanonical,
} from '../evidence/content-manifest';
import type { CandidateEntry } from '../inventory/read-candidate';
import {
  assertAuthorityClaimPath,
  assertAuthorityConflictGroup,
  assertAuthoritySessionId,
  assertAuthorityWorktreePath,
} from './authority-identities';

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

export function uniqueSorted(values: readonly string[], subject: string): string[] {
  const normalized = [...values].sort(compareCanonicalText);
  for (let index = 0; index < normalized.length; index += 1) {
    const value = normalized[index];
    if (!PacketTerm.test(value)) throw new Error(`invalid ${subject}: ${value}`);
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

export function canonicalPaths(values: readonly string[], subject: string): string[] {
  const paths = [...values].sort(compareCanonicalText);
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    assertAuthorityClaimPath(path);
    if (index > 0 && paths[index - 1] === path) throw new Error(`duplicate ${subject}: ${path}`);
  }
  return paths;
}

function assertBase(base: AdmissionBase): void {
  if (!ObjectIdentity.test(base.commit)) throw new Error('invalid packet base commit');
  if (!ObjectIdentity.test(base.tree)) throw new Error('invalid packet base tree');
}

function assertDigest(identity: string, subject: string): void {
  if (!Sha256Identity.test(identity)) throw new Error(`invalid ${subject} identity`);
}

export function assertNarrative(value: string, subject: string): void {
  if (value.trim().length === 0 || value.includes('\u0000')) {
    throw new Error(`invalid packet ${subject}`);
  }
}

export function packetBody(packet: AdmissionPacket): Omit<AdmissionPacket, 'packetIdentity'> {
  const { packetIdentity: _identity, ...body } = packet;
  return body;
}

export function packetBodyBytes(packet: AdmissionPacket): string {
  return serializeCanonical(packetBody(packet));
}

export function withPacketIdentity(body: Omit<AdmissionPacket, 'packetIdentity'>): AdmissionPacket {
  return { ...body, packetIdentity: hashCanonical(body) };
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
  // Proof: bypassing this boundary changed generation 0's CLI diagnostic to the token error; the
  // malformed-packet test requires this exact packet refusal.
  if (!Number.isSafeInteger(packet.generation) || packet.generation < 1) {
    throw new Error(`invalid admission packet generation: ${String(packet.generation)}`);
  }
  // Proof: bypassing these narrative guards made independently rehashed blank objective/outcome
  // packets exit 0 in their production CLI matrix cases.
  assertNarrative(packet.objective, 'objective');
  assertNarrative(packet.outcome, 'outcome');
  const ownedPaths = canonicalPaths(packet.ownedPaths, 'owned path');
  const readPaths = canonicalPaths(
    packet.readDependencies.map(({ path }) => path),
    'read path',
  );
  // Proof: bypassing this guard changed `['z','a']` to a later authority mismatch; the production
  // boundary test required the canonical-order refusal.
  if (ownedPaths.some((path, index) => path !== packet.ownedPaths[index])) {
    throw new Error('noncanonical owned path order');
  }
  if (readPaths.some((path, index) => path !== packet.readDependencies[index]?.path)) {
    throw new Error('noncanonical read dependency order');
  }
  for (const group of packet.conflictGroups) assertAuthorityConflictGroup(group);
  assertCanonicalOrder(packet.conflictGroups, 'conflict group');
  // Proof: bypassing canonical check order made the production CLI accept `['z','a']` with exit 0.
  assertCanonicalOrder(packet.checks, 'check');
  assertCanonicalOrder(packet.consumedContracts, 'consumed contract');
  assertCanonicalOrder(packet.consumedInterfaces, 'consumed interface');
  assertCanonicalOrder(packet.producedContracts, 'produced contract');
  assertCanonicalOrder(packet.producedInterfaces, 'produced interface');
  assertCanonicalOrder(packet.invariants, 'invariant');
  assertCanonicalOrder(packet.evidenceRequirements, 'evidence requirement');
  if (packet.ownedPaths.length === 0) throw new Error('packet requires at least one owned path');
  // Proof: bypassing these obligations made the production CLI accept independently rehashed
  // empty checks, invariants and evidence requirements in their targeted cases.
  if (packet.checks.length === 0) throw new Error('packet requires at least one check');
  if (packet.invariants.length === 0) throw new Error('packet requires at least one invariant');
  if (packet.evidenceRequirements.length === 0) {
    throw new Error('packet requires at least one evidence requirement');
  }
  for (const entry of packet.readDependencies) {
    if (!ObjectIdentity.test(entry.blob)) {
      throw new Error(`invalid read dependency object: ${entry.path}`);
    }
  }
  // Proof: bypassing this comparison made changed outcome bytes under the old identity exit 0.
  if (hashCanonical(packetBody(packet)) !== packet.packetIdentity) {
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
  // `100600` dependency with exit 0.
  if (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') {
    throw new Error(`invalid read dependency mode: ${mode}`);
  }
  return mode;
}

/** Decodes the closed packet shape at the JSON/CLI and persisted-authority boundaries. */
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
  // Proof: accepting undeclared keys let a caller attach `extraWrites`; the production CLI
  // malformed-packet test observed exit 0 instead of boundary refusal.
  const base = record(source['base'], 'admission packet base', new Set(['commit', 'tree']));
  const readInput = source['readDependencies'];
  if (!Array.isArray(readInput)) {
    throw new Error('admission packet readDependencies must be an array');
  }
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
  if (typeof generation !== 'number') {
    throw new Error('admission packet generation must be a number');
  }
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

/** Strictly recovers the exact packet authenticated by stored canonical body bytes. */
export function decodeAdmissionPacketBody(packetIdentity: string, bytes: string): AdmissionPacket {
  let body: unknown;
  try {
    body = JSON.parse(bytes);
  } catch (cause) {
    throw new Error('authority packet bytes are malformed JSON', { cause });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('authority packet body must be an object');
  }
  const packet = decodeAdmissionPacket({ ...body, packetIdentity });
  if (packetBodyBytes(packet) !== bytes) {
    throw new Error('authority packet bytes are not canonical');
  }
  return packet;
}
