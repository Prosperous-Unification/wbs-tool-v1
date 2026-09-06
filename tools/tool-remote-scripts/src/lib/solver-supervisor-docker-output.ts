import type { ManagedContainerEvidence } from './solver-supervisor-lifecycle';

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const BACKEND_IDENTITY_KEYS = ['id', 'name', 'running', 'image'] as const;

export interface BackendContainerIdentity {
  readonly id: string;
  readonly name: string;
  readonly image: string;
}

function defect(message: string): Error {
  return new Error(`solver supervisor Docker output: ${message}`);
}

function oneLine(raw: string): string {
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (line.includes('\n') || line.includes('\r')) throw defect('expected one line');
  return line;
}

function requireContainerId(value: string): string {
  if (!CONTAINER_ID.test(value)) throw defect('expected a full container id');
  return value;
}

/** Decodes `docker create` output without accepting warnings or short ids. */
export function parseManagedContainerId(raw: string): string {
  return requireContainerId(oneLine(raw));
}

/** Decodes the managed-label `docker ps --format {{.ID}}` output. */
export function parseManagedContainerList(raw: string): string[] {
  if (raw === '') return [];
  const body = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (body.includes('\r')) throw defect('container list contains carriage return');
  const ids = body.split('\n').map(requireContainerId);
  if (new Set(ids).size !== ids.length) throw defect('container list contains a duplicate id');
  return ids;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw defect(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactBackendKeys(value: Record<string, unknown>): void {
  const unknown = Object.keys(value).filter((key) => !BACKEND_IDENTITY_KEYS.includes(key as never));
  if (unknown.length > 0)
    throw defect(`backend inspect has unknown key ${unknown.sort().join(', ')}`);
  const missing = BACKEND_IDENTITY_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw defect(`backend inspect has missing key ${missing.join(', ')}`);
}

/** Authenticates one running Docker backend under host-configured exact name patterns. */
export function parseBackendContainerIdentity(
  raw: string,
  expectedPeerId: string,
  allowedNamePatterns: readonly RegExp[],
): BackendContainerIdentity {
  requireContainerId(expectedPeerId);
  if (allowedNamePatterns.length === 0) throw defect('backend name pattern list is empty');
  for (const pattern of allowedNamePatterns) {
    if (!pattern.source.startsWith('^') || !pattern.source.endsWith('$') || pattern.flags !== '') {
      throw defect('backend name patterns must be anchored and have no flags');
    }
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(oneLine(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw defect('backend inspect output is malformed JSON');
    throw error;
  }
  const identity = asRecord(decoded, 'backend inspect');
  requireExactBackendKeys(identity);

  const id = identity['id'];
  if (typeof id !== 'string' || !CONTAINER_ID.test(id)) {
    throw defect('backend inspect id is not a full container id');
  }
  // Proof: solver-supervisor-docker-output.test.ts substitutes another valid
  // live id and requires rejection before the frame's claimed id is decoded.
  if (id !== expectedPeerId) throw defect('backend inspect id does not equal expected peer id');

  if (identity['running'] !== true) throw defect('backend container is not running');
  const rawName = identity['name'];
  if (typeof rawName !== 'string' || !rawName.startsWith('/')) {
    throw defect('backend container name is malformed');
  }
  const name = rawName.slice(1);
  if (!CONTAINER_NAME.test(name)) throw defect('backend container name is malformed');
  if (!allowedNamePatterns.some((pattern) => pattern.test(name))) {
    throw defect('backend container name is not allowed');
  }

  const image = identity['image'];
  if (typeof image !== 'string' || image.length === 0 || image.length > 512 || /\s/.test(image)) {
    throw defect('backend container image is malformed');
  }
  return { id, name, image };
}

/** Decodes the native exit evidence used to construct a terminal frame. */
export function parseManagedContainerEvidence(
  raw: string,
  deadlineKilled: boolean,
): ManagedContainerEvidence {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw defect('inspect output is malformed JSON');
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    throw defect('inspect output must contain one record');
  }
  const state = asRecord(asRecord(decoded[0], 'inspect record')['State'], 'State');
  const pid = state['Pid'];
  if (!Number.isSafeInteger(pid) || (pid as number) < 0) {
    throw defect('State.Pid is not a non-negative safe integer');
  }
  const exitCode = state['ExitCode'];
  if (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0) {
    throw defect('State.ExitCode is not a non-negative safe integer');
  }
  const oomKilled = state['OOMKilled'];
  if (typeof oomKilled !== 'boolean') throw defect('State.OOMKilled is not boolean');
  if (typeof deadlineKilled !== 'boolean') throw defect('deadlineKilled is not boolean');
  return {
    pid: pid as number,
    exitCode: exitCode as number,
    oomKilled,
    deadlineKilled,
  };
}
