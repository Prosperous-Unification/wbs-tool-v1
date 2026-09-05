export const SUPERVISOR_PROTOCOL_VERSION = 1;

export type SupervisorObjective = 'pri' | 'time';

export interface SupervisorStartFrame {
  readonly type: 'start';
  readonly protocolVersion: typeof SUPERVISOR_PROTOCOL_VERSION;
  readonly callerId: string;
  readonly projectId: string;
  readonly objective: SupervisorObjective;
  readonly attemptToken: string;
  readonly childDeadlineAt: number;
  readonly searchWorkers: number;
  readonly memoryLimitMb: number;
  readonly request: Readonly<Record<string, unknown>>;
}

export interface SupervisorStartDecodeContext {
  readonly now: number;
  readonly peerCallerId: string;
  readonly maxInputBytes: number;
  readonly maxSearchWorkers: number;
  readonly maxMemoryLimitMb: number;
}

const START_KEYS = [
  'type',
  'protocolVersion',
  'callerId',
  'projectId',
  'objective',
  'attemptToken',
  'childDeadlineAt',
  'searchWorkers',
  'memoryLimitMb',
  'request',
] as const;

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defect(message: string): Error {
  return new Error(`supervisor start frame: ${message}`);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw defect(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>): void {
  const unknown = Object.keys(value).filter((key) => !START_KEYS.includes(key as never));
  if (unknown.length > 0) throw defect(`unknown key ${unknown.sort().join(', ')}`);
  const missing = START_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw defect(`missing key ${missing.join(', ')}`);
}

function readPositiveBoundedInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw defect(`${name} must be an integer from 1 through ${String(maximum)}`);
  }
  return value as number;
}

export function decodeSupervisorStartFrame(
  raw: string,
  context: SupervisorStartDecodeContext,
): SupervisorStartFrame {
  const inputBytes = new TextEncoder().encode(raw).byteLength;
  if (inputBytes > context.maxInputBytes) {
    throw defect(
      `input bytes ${String(inputBytes)} exceed host limit ${String(context.maxInputBytes)}`,
    );
  }
  if (raw.includes('\n') || raw.includes('\r')) throw defect('expected exactly one line');

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw defect('malformed JSON');
  }
  const value = asRecord(decoded, 'payload');
  requireExactKeys(value);

  if (value['type'] !== 'start') throw defect(`unknown type ${JSON.stringify(value['type'])}`);
  if (value['protocolVersion'] !== SUPERVISOR_PROTOCOL_VERSION) {
    throw defect(`unknown protocolVersion ${JSON.stringify(value['protocolVersion'])}`);
  }

  const callerId = value['callerId'];
  if (typeof callerId !== 'string' || !CONTAINER_ID.test(callerId)) {
    throw defect('callerId is not a full Docker container id');
  }
  if (callerId !== context.peerCallerId) throw defect('callerId does not match peer caller id');

  const projectId = value['projectId'];
  if (typeof projectId !== 'string' || !UUID.test(projectId)) {
    throw defect('projectId is not a UUID');
  }
  const attemptToken = value['attemptToken'];
  if (typeof attemptToken !== 'string' || !UUID.test(attemptToken)) {
    throw defect('attemptToken is not a UUID');
  }

  const objective = value['objective'];
  if (objective !== 'pri' && objective !== 'time') {
    throw defect(`unknown objective ${JSON.stringify(objective)}`);
  }
  const childDeadlineAt = value['childDeadlineAt'];
  if (!Number.isSafeInteger(childDeadlineAt) || (childDeadlineAt as number) <= context.now) {
    throw defect('child deadline is spent or is not a safe integer');
  }

  const searchWorkers = readPositiveBoundedInteger(
    value['searchWorkers'],
    'searchWorkers',
    context.maxSearchWorkers,
  );
  const memoryLimitMb = readPositiveBoundedInteger(
    value['memoryLimitMb'],
    'memoryLimitMb',
    context.maxMemoryLimitMb,
  );
  const request = asRecord(value['request'], 'request');
  if (request['wireVersion'] !== 1) throw defect('request wireVersion is not 1');
  if (request['objective'] !== objective) throw defect('request objective does not match frame');

  return {
    type: 'start',
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    callerId,
    projectId,
    objective,
    attemptToken,
    childDeadlineAt: childDeadlineAt as number,
    searchWorkers,
    memoryLimitMb,
    request,
  };
}
