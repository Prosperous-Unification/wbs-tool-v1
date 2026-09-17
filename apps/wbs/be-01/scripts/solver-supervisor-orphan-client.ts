import { connectSolverSupervisor } from '../src/service/solver-supervisor-client';

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('solver orphan client: request fixture is not an object');
  }
  return { ...value };
}

const unix = process.argv.at(2);
const requestPath = process.argv.at(3);
const attemptToken = process.argv.at(4);
const deadlineText = process.argv.at(5);
const marker = process.argv.at(6);
const decision = process.argv.at(7);
if (
  unix === undefined ||
  requestPath === undefined ||
  attemptToken === undefined ||
  deadlineText === undefined ||
  marker === undefined ||
  (decision !== 'wait' && decision !== 'bound' && decision !== 'gate')
) {
  throw new Error(
    'solver orphan client: expected socket, request, token, deadline, marker, and decision',
  );
}
const callerId = process.env['HOSTNAME'];
if (callerId === undefined || !/^[0-9a-f]{12}$/.test(callerId)) {
  throw new Error('solver orphan client: caller hostname is not a 12-hex Docker id');
}
const childDeadlineAt = Number(deadlineText);
if (!Number.isSafeInteger(childDeadlineAt)) {
  throw new Error('solver orphan client: deadline is not a safe integer');
}

const attempt = await connectSolverSupervisor({
  unix,
  callerId,
  projectId: '11111111-1111-4111-8111-111111111111',
  objective: 'pri',
  attemptToken,
  childDeadlineAt,
  searchWorkers: 2,
  memoryLimitMb: 512,
  request: recordOf(JSON.parse(await Bun.file(requestPath).text())),
});
void attempt.terminal.catch(() => undefined);
if (decision === 'gate') {
  await Bun.write(marker, String(attempt.pid));
  while (!(await Bun.file(`${marker}.bound`).exists())) await Bun.sleep(10);
  await attempt.verdict('bound');
  await Bun.write(`${marker}.bound-sent`, 'bound');
} else {
  if (decision === 'bound') await attempt.verdict('bound');
  await Bun.write(marker, String(attempt.pid));
}

await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
