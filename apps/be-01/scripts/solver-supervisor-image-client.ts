import { parseSolverResponse } from '@wbs/contracts/solver/parse-solver-response';

import { connectSolverSupervisor } from '../src/service/solver-supervisor-client';

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('solver supervisor image smoke: request fixture is not an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

const [unix, requestPath, attemptToken] = process.argv.slice(2);
if (unix === undefined || requestPath === undefined || attemptToken === undefined) {
  throw new Error('solver supervisor image smoke: expected socket, request, and attempt token');
}
const callerId = process.env['HOSTNAME'];
if (callerId === undefined || !/^[0-9a-f]{12}$/.test(callerId)) {
  throw new Error('solver supervisor image smoke: caller hostname is not a 12-hex Docker id');
}

const request = recordOf(JSON.parse(await Bun.file(requestPath).text()));
const attempt = await connectSolverSupervisor({
  unix,
  callerId,
  projectId: '11111111-1111-4111-8111-111111111111',
  objective: 'pri',
  attemptToken,
  // The deadline also covers Docker create/start on contended shared runners.
  childDeadlineAt: Date.now() + 180_000,
  searchWorkers: 2,
  memoryLimitMb: 512,
  request,
});
await attempt.verdict('bound');

const [stdout, stderr, terminal] = await Promise.all([
  new Response(attempt.stdout).text(),
  new Response(attempt.stderr).text(),
  attempt.terminal,
]);
if (terminal.exitCode !== 0 || terminal.deadlineKilled || terminal.oomKilled) {
  throw new Error(
    `solver supervisor image smoke: launcher classified internal-error (${String(terminal.exitCode)}): ${stderr.trim()}`,
  );
}
const parsed = parseSolverResponse(stdout);
if (!parsed.ok) {
  throw new Error(
    `solver supervisor image smoke: launcher output ${parsed.failure}: ${parsed.detail}`,
  );
}
console.log('[solver-image-smoke] supervisor authenticated, bound, and completed launcher');
