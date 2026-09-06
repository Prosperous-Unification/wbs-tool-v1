import { BunManagedContainerDriver } from '../../../tools/tool-remote-scripts/src/lib/solver-supervisor-driver';
import type { PersistentDeadlineTimerCommands } from '../../../tools/tool-remote-scripts/src/lib/solver-supervisor-command';
import type { ManagedDeadlineTimer } from '../../../tools/tool-remote-scripts/src/lib/solver-supervisor-lifecycle';
import { startSolverSupervisor } from '../../../tools/tool-remote-scripts/src/lib/solver-supervisor-runtime';

class SmokeDriver extends BunManagedContainerDriver {
  override list(): Promise<readonly string[]> {
    // Production may be solving while this gate runs. The smoke owns only the
    // exact attempt token supplied by its client, so startup must not sweep the
    // host's independently managed containers.
    return Promise.resolve([]);
  }

  override armDeadline(_commands: PersistentDeadlineTimerCommands): Promise<ManagedDeadlineTimer> {
    // The production driver/systemd command contract has its own watched unit
    // tests. This packaging proof exercises the authenticated socket, Docker
    // create/attach/start, bind verdict, launcher, evidence, and removal without
    // installing a persistent timer on a CI or shared h2puni host.
    return Promise.resolve({
      hasFired: () => Promise.resolve(false),
      cancel: () => Promise.resolve(),
    });
  }
}

const [image, unix, callerName] = process.argv.slice(2);
if (image === undefined || unix === undefined || callerName === undefined) {
  throw new Error('solver supervisor image smoke: expected image, socket, and caller name');
}
const escapedCallerName = callerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listener = await startSolverSupervisor(
  {
    connection: {
      unix,
      allowedNamePatterns: [new RegExp(`^${escapedCallerName}$`)],
      maxInputBytes: 2 * 1024 * 1024,
      bindTimeoutMs: 5_000,
      maxSearchWorkers: 2,
      maxMemoryLimitMb: 512,
      now: Date.now,
      onConnectionError: (error) => {
        console.error(`[solver-image-smoke] supervisor connection failed: ${error.message}`);
      },
    },
    lifecycle: {
      pidsLimit: 128,
      maxManagedContainers: 1,
      outputLimits: {
        maxPayloadBytes: 64 * 1024,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      },
    },
    imageFor: (identity) => {
      if (identity.name !== callerName || identity.image !== image) {
        throw new Error('solver supervisor image smoke: authenticated caller mapping changed');
      }
      return image;
    },
  },
  new SmokeDriver(),
);

await new Promise<void>((resolve) => {
  const stop = (): void => {
    listener.stop(true);
    resolve();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
});
