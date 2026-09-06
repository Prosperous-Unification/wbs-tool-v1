type SocketInputNext = IteratorResult<Uint8Array, undefined>;

interface SocketInputWaiter {
  resolve(value: SocketInputNext): void;
  reject(error: Error): void;
}

function defect(message: string): Error {
  return new Error(`supervisor socket input: ${message}`);
}

/** A copied, ingress-bounded bridge from Bun socket callbacks to one async reader. */
export class SupervisorSocketInput implements AsyncIterableIterator<Uint8Array> {
  readonly #maximumBytes: number;
  readonly #chunks: Uint8Array[] = [];
  #receivedBytes = 0;
  #waiter: SocketInputWaiter | undefined;
  #closed = false;
  #failure: Error | undefined;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw defect('maximumBytes must be a positive safe integer');
    }
    this.#maximumBytes = maximumBytes;
  }

  push(chunk: Uint8Array): boolean {
    if (this.#closed || this.#failure !== undefined) return false;
    const receivedBytes = this.#receivedBytes + chunk.byteLength;
    if (!Number.isSafeInteger(receivedBytes) || receivedBytes > this.#maximumBytes) {
      // Proof: solver-supervisor-socket-input.test.ts crosses the limit while
      // bytes are queued and requires both their removal and iterator failure.
      const failure = defect(
        `input bytes ${String(receivedBytes)} exceed ${String(this.#maximumBytes)}`,
      );
      this.#failure = failure;
      this.#chunks.length = 0;
      this.#waiter?.reject(failure);
      this.#waiter = undefined;
      return false;
    }
    this.#receivedBytes = receivedBytes;
    const copied = chunk.slice();
    if (this.#waiter !== undefined) {
      this.#waiter.resolve({ done: false, value: copied });
      this.#waiter = undefined;
    } else {
      this.#chunks.push(copied);
    }
    return true;
  }

  end(): void {
    if (this.#closed || this.#failure !== undefined) return;
    this.#closed = true;
    this.#waiter?.resolve({ done: true, value: undefined });
    this.#waiter = undefined;
  }

  next(): Promise<SocketInputNext> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    if (this.#waiter !== undefined) return Promise.reject(defect('concurrent reads are forbidden'));
    return new Promise<SocketInputNext>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }
}
