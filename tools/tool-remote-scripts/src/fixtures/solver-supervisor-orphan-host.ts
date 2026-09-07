import { startSolverSupervisor } from '../lib/solver-supervisor-runtime';

const image = process.argv.at(2);
const unix = process.argv.at(3);
const callerName = process.argv.at(4);
const readyMarker = process.argv.at(5);
if (
  image === undefined ||
  unix === undefined ||
  callerName === undefined ||
  readyMarker === undefined
) {
  throw new Error('solver orphan host: expected image, socket, caller name, and ready marker');
}
const escapedCallerName = callerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listener = await startSolverSupervisor({
  connection: {
    unix,
    allowedNamePatterns: [new RegExp(`^${escapedCallerName}$`)],
    maxInputBytes: 2 * 1024 * 1024,
    bindTimeoutMs: 60_000,
    maxSearchWorkers: 2,
    maxMemoryLimitMb: 512,
    now: Date.now,
    onConnectionError: (error) => {
      console.error(`[solver-orphan-proc] connection ended: ${error.message}`);
    },
  },
  lifecycle: {
    pidsLimit: 128,
    maxManagedContainers: 16,
    outputLimits: {
      maxPayloadBytes: 64 * 1024,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    },
  },
  imageFor: (identity) => {
    if (identity.name !== callerName || identity.image !== image) {
      throw new Error('solver orphan host: authenticated caller mapping changed');
    }
    return image;
  },
});
await Bun.write(readyMarker, 'ready');

await new Promise<void>((resolve) => {
  const stop = (): void => {
    listener.stop(true);
    resolve();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
});
