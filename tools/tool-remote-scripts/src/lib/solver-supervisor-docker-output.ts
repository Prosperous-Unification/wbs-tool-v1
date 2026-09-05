import type { ManagedContainerEvidence } from './solver-supervisor-lifecycle';

const CONTAINER_ID = /^[0-9a-f]{64}$/;

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
