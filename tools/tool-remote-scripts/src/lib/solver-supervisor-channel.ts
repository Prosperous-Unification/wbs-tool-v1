import type { SupervisorAttemptChannel, SupervisorControl } from './solver-supervisor-lifecycle';
import {
  decodeSupervisorStartFrame,
  type SupervisorReplyFrame,
  type SupervisorStartDecodeContext,
  type SupervisorStartFrame,
} from './solver-supervisor-protocol';

export interface SupervisorChannelTimer {
  after(milliseconds: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface SupervisorChannelOptions {
  readonly maxInputBytes: number;
  readonly bindTimeoutMs: number;
  readonly timer?: SupervisorChannelTimer;
}

type ChannelPhase = 'start' | 'decision' | 'active' | 'closed';

const DEFAULT_TIMER: SupervisorChannelTimer = {
  after: (milliseconds, callback) => setTimeout(callback, milliseconds),
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const EMPTY = new Uint8Array();
const BIND_TIMEOUT = Symbol('bind-timeout');

function defect(message: string): Error {
  return new Error(`supervisor channel: ${message}`);
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw defect(`${name} must be a positive safe integer`);
  }
}

function joined(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const value = new Uint8Array(left.byteLength + right.byteLength);
  value.set(left);
  value.set(right, left.byteLength);
  return value;
}

function decodeControl(raw: string, phase: ChannelPhase): SupervisorControl {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw defect('control frame is malformed JSON');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw defect('control frame is not an object');
  }
  const value = decoded as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'type') {
    throw defect('control frame must contain only type');
  }
  const type = value['type'];
  if (phase === 'decision' && (type === 'bound' || type === 'abort' || type === 'kill')) {
    return type;
  }
  if (phase === 'active' && type === 'kill') return type;
  if (phase === 'active' && (type === 'bound' || type === 'abort')) {
    throw defect(`${type} control received after decision`);
  }
  throw defect(`unknown or out-of-phase control frame ${JSON.stringify(type)}`);
}

/**
 * Owns one bounded newline-framed connection. It deliberately exposes no
 * multiplexing or request reset: one instance can authenticate one start and
 * then carry only that attempt's decision, kill, and replies.
 */
export class SupervisorOneAttemptChannel implements SupervisorAttemptChannel {
  readonly #reader: AsyncIterator<Uint8Array>;
  readonly #write: (value: string) => Promise<void>;
  readonly #maximum: number;
  readonly #bindTimeoutMs: number;
  readonly #timer: SupervisorChannelTimer;
  #buffer = EMPTY;
  #receivedBytes = 0;
  #phase: ChannelPhase = 'start';

  constructor(
    input: AsyncIterable<Uint8Array>,
    write: (value: string) => Promise<void>,
    options: SupervisorChannelOptions,
  ) {
    requirePositiveInteger(options.maxInputBytes, 'maxInputBytes');
    requirePositiveInteger(options.bindTimeoutMs, 'bindTimeoutMs');
    this.#reader = input[Symbol.asyncIterator]();
    this.#write = write;
    this.#maximum = options.maxInputBytes;
    this.#bindTimeoutMs = options.bindTimeoutMs;
    this.#timer = options.timer ?? DEFAULT_TIMER;
  }

  async #readLine(): Promise<string | undefined> {
    for (;;) {
      const newline = this.#buffer.indexOf(10);
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.includes(13)) throw defect('carriage returns are forbidden');
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(line);
        } catch {
          throw defect('frame is not valid UTF-8');
        }
      }

      const next = await this.#reader.next();
      if (next.done) {
        if (this.#buffer.byteLength !== 0) throw defect('EOF inside an unterminated frame');
        return undefined;
      }
      this.#receivedBytes += next.value.byteLength;
      if (this.#receivedBytes > this.#maximum) {
        throw defect(
          `input bytes ${String(this.#receivedBytes)} exceed connection limit ${String(this.#maximum)}`,
        );
      }
      this.#buffer = joined(this.#buffer, next.value);
    }
  }

  async readStart(
    context: Omit<SupervisorStartDecodeContext, 'maxInputBytes'>,
  ): Promise<SupervisorStartFrame> {
    if (this.#phase !== 'start') throw defect('start frame was already read');
    const raw = await this.#readLine();
    if (raw === undefined) throw defect('EOF before start frame');
    if (this.#buffer.byteLength !== 0) {
      throw defect('unexpected bytes before started reply');
    }
    const frame = decodeSupervisorStartFrame(raw, {
      ...context,
      maxInputBytes: this.#maximum,
    });
    this.#phase = 'decision';
    return frame;
  }

  async nextControl(): Promise<SupervisorControl> {
    if (this.#phase === 'start') throw defect('control requested before start frame');
    if (this.#phase === 'closed') return 'eof';

    const phase = this.#phase;
    const line = phase === 'decision' ? await this.#readDecisionLine() : await this.#readLine();
    if (line === BIND_TIMEOUT) {
      this.#phase = 'closed';
      return 'timeout';
    }
    if (line === undefined) {
      this.#phase = 'closed';
      return 'eof';
    }

    const control = decodeControl(line, phase);
    this.#phase = control === 'bound' ? 'active' : 'closed';
    return control;
  }

  async #readDecisionLine(): Promise<string | undefined | typeof BIND_TIMEOUT> {
    let fire: (() => void) | undefined;
    const timeout = new Promise<typeof BIND_TIMEOUT>((resolve) => {
      fire = () => {
        resolve(BIND_TIMEOUT);
      };
    });
    const handle = this.#timer.after(this.#bindTimeoutMs, () => {
      fire?.();
    });
    try {
      return await Promise.race([this.#readLine(), timeout]);
    } finally {
      this.#timer.cancel(handle);
    }
  }

  send(frame: SupervisorReplyFrame): Promise<void> {
    return this.#write(`${JSON.stringify(frame)}\n`);
  }
}
