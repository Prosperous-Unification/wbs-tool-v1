import { describe, expect, it } from 'bun:test';

import { SupervisorSocketInput } from './solver-supervisor-socket-input';

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected operation to reject');
}

describe('SupervisorSocketInput', () => {
  it('copies socket chunks, preserves order, and ends the iterator once', async () => {
    const input = new SupervisorSocketInput(8);
    const iterator = input[Symbol.asyncIterator]();
    const first = new Uint8Array([1, 2]);
    expect(input.push(first)).toBe(true);
    first[0] = 9;
    expect(input.push(new Uint8Array([3]))).toBe(true);

    expect(await iterator.next()).toEqual({ done: false, value: new Uint8Array([1, 2]) });
    expect(await iterator.next()).toEqual({ done: false, value: new Uint8Array([3]) });
    input.end();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    input.end();
  });

  it('rejects the stream and discards queued bytes at the ingress ceiling', async () => {
    const input = new SupervisorSocketInput(4);
    const iterator = input[Symbol.asyncIterator]();
    expect(input.push(new Uint8Array([1, 2, 3]))).toBe(true);
    // Proof: removing the ingress count makes this return true and preserves
    // attacker-controlled bytes queued before peer authentication completes.
    expect(input.push(new Uint8Array([4, 5]))).toBe(false);
    expect((await rejectionOf(iterator.next())).message).toMatch(/input bytes 5 exceed 4/);
    expect(input.push(new Uint8Array([6]))).toBe(false);
  });
});
