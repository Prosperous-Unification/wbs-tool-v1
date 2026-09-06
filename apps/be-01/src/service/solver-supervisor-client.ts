import { Buffer } from 'node:buffer';

import {
  type DecodedSupervisorReply,
  decodeSupervisorReplyFrame,
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorReplyBudget,
  type SupervisorReplyFrame,
  type SupervisorStartFrame,
} from '@wbs/contracts/solver/supervisor-protocol';

const MAX_REPLY_WIRE_BYTES = 13 * 256 * 1024;
const EMPTY: Uint8Array = new Uint8Array();

type TerminalFrame = Extract<SupervisorReplyFrame, { readonly type: 'terminal' }>;

export interface SolverSupervisorRequest extends Omit<
  SupervisorStartFrame,
  'type' | 'protocolVersion'
> {
  readonly unix: string;
}

export interface SolverSupervisorAttempt {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly terminal: Promise<TerminalFrame>;
  readonly verdict: (verdict: 'bound' | 'abort') => Promise<void>;
  readonly kill: () => Promise<void>;
}

export interface SolverSupervisorSocket {
  write(bytes: Uint8Array, offset?: number, length?: number): number;
  terminate(): void;
}

export interface SolverSupervisorSocketEvents {
  readonly data: (chunk: Uint8Array) => void;
  readonly drain: () => void;
  readonly close: (error?: Error) => void;
}

export type SolverSupervisorConnect = (
  unix: string,
  events: SolverSupervisorSocketEvents,
) => Promise<SolverSupervisorSocket>;

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function joined(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const value = new Uint8Array(left.byteLength + right.byteLength);
  value.set(left);
  value.set(right, left.byteLength);
  return value;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error('solver supervisor client: no resolver');
      resolvePromise(value);
    },
    reject: (error) => {
      if (rejectPromise === undefined) throw new Error('solver supervisor client: no rejecter');
      rejectPromise(error);
    },
  };
}

class SocketWriter {
  #drain: (() => void) | undefined;
  #failure: Error | undefined;

  constructor(private readonly socket: SolverSupervisorSocket) {}

  drained(): void {
    this.#drain?.();
    this.#drain = undefined;
  }

  fail(error: Error): void {
    this.#failure ??= error;
    this.drained();
  }

  async write(text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.#failure !== undefined) throw this.#failure;
      const written = this.socket.write(bytes, offset, bytes.byteLength - offset);
      if (written < 0) throw new Error('solver supervisor client: socket closed while writing');
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

const bunConnect: SolverSupervisorConnect = async (unix, events) =>
  Bun.connect({
    unix,
    socket: {
      data(_socket, chunk) {
        events.data(chunk);
      },
      drain() {
        events.drain();
      },
      close(_socket, error) {
        events.close(error);
      },
      error(_socket, error) {
        events.close(error);
      },
    },
  });

/** Opens one bounded, non-multiplexed attempt through the host supervisor. */
export async function connectSolverSupervisor(
  request: SolverSupervisorRequest,
  connect: SolverSupervisorConnect = bunConnect,
): Promise<SolverSupervisorAttempt> {
  const { unix, ...fields } = request;
  const start: SupervisorStartFrame = {
    type: 'start',
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    ...fields,
  };
  const encoded = `${JSON.stringify(start)}\n`;

  const connection: { writer?: SocketWriter; socket?: SolverSupervisorSocket } = {};
  let buffer: Uint8Array = EMPTY;
  let receivedBytes = 0;
  let budget: SupervisorReplyBudget = {
    stdoutBytes: 0,
    stderrBytes: 0,
    maxPayloadBytes: 64 * 1024,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 256 * 1024,
  };
  let started = false;
  let finished = false;
  const startedReply = deferred<number>();
  const terminal = deferred<TerminalFrame>();
  let stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderr: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout = controller;
    },
  });
  const stderrStream = new ReadableStream<Uint8Array>({
    start(controller) {
      stderr = controller;
    },
  });

  const controllerOf = (
    controller: ReadableStreamDefaultController<Uint8Array> | undefined,
  ): ReadableStreamDefaultController<Uint8Array> => {
    if (controller === undefined) throw new Error('solver supervisor client: stream not started');
    return controller;
  };

  const fail = (reason: unknown): void => {
    if (finished) return;
    finished = true;
    const error = asError(reason);
    connection.writer?.fail(error);
    connection.socket?.terminate();
    if (!started) startedReply.reject(error);
    else {
      controllerOf(stdout).error(error);
      controllerOf(stderr).error(error);
      terminal.reject(error);
    }
  };

  const accept = (decoded: DecodedSupervisorReply): void => {
    budget = decoded.budget;
    const frame = decoded.frame;
    if (!started) {
      if (frame.type !== 'started')
        throw new Error('solver supervisor client: reply before started');
      started = true;
      startedReply.resolve(frame.pid);
      return;
    }
    if (frame.type === 'started')
      throw new Error('solver supervisor client: duplicate started reply');
    if (frame.type === 'terminal') {
      finished = true;
      controllerOf(stdout).close();
      controllerOf(stderr).close();
      terminal.resolve(frame);
      return;
    }
    const bytes = Buffer.from(frame.payload, 'base64');
    controllerOf(frame.type === 'stdout' ? stdout : stderr).enqueue(bytes);
  };

  const events: SolverSupervisorSocketEvents = {
    data: (chunk) => {
      try {
        if (finished) throw new Error('solver supervisor client: reply after terminal');
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_REPLY_WIRE_BYTES) {
          throw new Error('solver supervisor client: reply exceeds connection limit');
        }
        buffer = joined(buffer, chunk);
        for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.includes(13)) throw new Error('solver supervisor client: carriage return');
          accept(
            decodeSupervisorReplyFrame(
              new TextDecoder('utf-8', { fatal: true }).decode(line),
              budget,
            ),
          );
        }
      } catch (error) {
        fail(error);
      }
    },
    drain: () => {
      connection.writer?.drained();
    },
    close: (error) => {
      fail(error ?? new Error('solver supervisor client: EOF before terminal'));
    },
  };
  connection.socket = await connect(unix, events);
  const writer = new SocketWriter(connection.socket);
  connection.writer = writer;
  await writer.write(encoded);
  const pid = await startedReply.promise;
  let decision: 'bound' | 'abort' | undefined;

  return {
    pid,
    stdout: stdoutStream,
    stderr: stderrStream,
    terminal: terminal.promise,
    verdict: async (verdict) => {
      if (decision !== undefined) throw new Error('solver supervisor client: verdict already sent');
      decision = verdict;
      await writer.write(`${JSON.stringify({ type: verdict })}\n`);
    },
    kill: async () => {
      if (decision === undefined)
        throw new Error('solver supervisor client: kill before bind verdict');
      if (decision === 'abort' || finished || request.childDeadlineAt <= Date.now()) return;
      await writer.write(`${JSON.stringify({ type: 'kill' })}\n`);
    },
  };
}
