import { startSolverSupervisor } from '../../../tools/tool-remote-scripts/src/lib/solver-supervisor-runtime';

const [image, unix, callerName, readyMarker] = process.argv.slice(2);
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
