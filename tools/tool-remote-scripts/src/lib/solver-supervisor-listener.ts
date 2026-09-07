import { lstatSync, unlinkSync } from 'node:fs';

import {
  serveSupervisorConnection,
  type SupervisorConnectionDependencies,
  type SupervisorConnectionOptions,
} from './solver-supervisor-service';
import { SupervisorSocketInput } from './solver-supervisor-socket-input';

interface SupervisorSocketState {
  readonly input: SupervisorSocketInput;
  readonly writer: SupervisorSocketWriter;
}

export interface SupervisorUnixListenerOptions extends SupervisorConnectionOptions {
  readonly unix: string;
  readonly onConnectionError?: (error: Error) => void;
}

function connectionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function unixSocketIsAcceptingConnections(unix: string): Promise<boolean> {
  try {
    const probe = await Bun.connect({
      unix,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {
          return undefined;
        },
      },
    });
    probe.end();
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ENOENT') return false;
    throw new Error('solver supervisor listener: socket liveness probe failed', {
      cause: connectionError(error),
    });
  }
}

/** Serializes concurrent stdout/stderr frames and observes Bun socket backpressure. */
class SupervisorSocketWriter {
  readonly #socket: Bun.Socket<SupervisorSocketState | undefined>;
  #tail: Promise<void> = Promise.resolve();
  #drain: (() => void) | undefined;
  #failure: Error | undefined;

  constructor(socket: Bun.Socket<SupervisorSocketState | undefined>) {
    this.#socket = socket;
  }

  write(text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    const operation = this.#tail.then(() => this.#writeBytes(bytes));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  drained(): void {
    this.#drain?.();
    this.#drain = undefined;
  }

  fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.drained();
  }

  async #writeBytes(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.#failure !== undefined) throw this.#failure;
      const written = this.#socket.write(bytes, offset, bytes.byteLength - offset);
      if (written < 0) throw new Error('solver supervisor listener: socket closed while writing');
      if (written === 0) {
        await new Promise<void>((resolve) => {
          this.#drain = resolve;
        });
      } else {
        offset += written;
      }
    }
  }
}

function stateOf(socket: Bun.Socket<SupervisorSocketState | undefined>): SupervisorSocketState {
  const state = socket.data;
  if (state === undefined)
    throw new Error('solver supervisor listener: socket opened without state');
  return state;
}

/** Owns one copied input bridge and one ordered output writer per accepted socket. */
export function supervisorSocketHandler(
  options: SupervisorUnixListenerOptions,
  dependencies: SupervisorConnectionDependencies,
): Bun.SocketHandler<SupervisorSocketState | undefined> {
  return {
    open(socket) {
      const input = new SupervisorSocketInput(options.maxInputBytes);
      const writer = new SupervisorSocketWriter(socket);
      socket.data = { input, writer };
      void serveSupervisorConnection(
        socket,
        input,
        (text) => writer.write(text),
        options,
        dependencies,
      ).then(
        () => {
          socket.end();
        },
        (reason: unknown) => {
          const error = connectionError(reason);
          options.onConnectionError?.(error);
          writer.fail(error);
          socket.terminate();
        },
      );
    },
    data(socket, chunk) {
      if (!stateOf(socket).input.push(chunk)) socket.terminate();
    },
    drain(socket) {
      stateOf(socket).writer.drained();
    },
    end(socket) {
      stateOf(socket).input.end();
    },
    close(socket, error) {
      const state = socket.data;
      if (state === undefined) return;
      state.input.end();
      state.writer.fail(error ?? new Error('solver supervisor listener: socket closed'));
    },
    error(socket, error) {
      const state = socket.data;
      if (state === undefined) return;
      state.input.end();
      state.writer.fail(error);
    },
  };
}

/** Opens the supervisor's host-owned Unix socket. Startup cleanup runs outside this seam. */
export async function listenForSupervisorConnections(
  options: SupervisorUnixListenerOptions,
  dependencies: SupervisorConnectionDependencies,
): Promise<Bun.UnixSocketListener<SupervisorSocketState | undefined>> {
  try {
    const stale = lstatSync(options.unix);
    if (!stale.isSocket()) {
      throw new Error('solver supervisor listener: configured path exists and is not a socket');
    }
    if (await unixSocketIsAcceptingConnections(options.unix)) {
      throw new Error(
        'solver supervisor listener: configured socket is already accepting connections',
      );
    }
    // A SIGKILL cannot run listener.stop(), so Restart=always inherits the
    // dead socket inode. Unlink only after proving this validated socket path
    // refuses connections, so a second process cannot steal a live listener.
    unlinkSync(options.unix);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error instanceof Error
        ? error
        : new Error('solver supervisor listener: non-Error socket preparation failure');
    }
  }
  return Bun.listen<SupervisorSocketState | undefined>({
    unix: options.unix,
    data: undefined,
    socket: supervisorSocketHandler(options, dependencies),
  });
}
