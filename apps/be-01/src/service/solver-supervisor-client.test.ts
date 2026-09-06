import { describe, expect, it } from 'bun:test';

import type {
  SolverSupervisorConnect,
  SolverSupervisorSocketEvents,
} from './solver-supervisor-client';
import { connectSolverSupervisor } from './solver-supervisor-client';

const request = {
  unix: '/run/wbs-solver/supervisor.sock',
  callerId: 'a'.repeat(12),
  projectId: '018f3f08-2ef7-7d1c-b645-14f877575d65',
  objective: 'pri' as const,
  attemptToken: '018f3f08-2ef7-7d1c-b645-14f877575d66',
  childDeadlineAt: Date.now() + 60_000,
  searchWorkers: 2,
  memoryLimitMb: 512,
  request: { wireVersion: 1, objective: 'pri' },
};

function harness(): {
  readonly connect: SolverSupervisorConnect;
  readonly writes: string[];
  readonly events: () => SolverSupervisorSocketEvents;
  readonly terminated: () => number;
} {
  const writes: string[] = [];
  let callbacks: SolverSupervisorSocketEvents | undefined;
  let terminated = 0;
  return {
    connect: (_unix, events) => {
      callbacks = events;
      return Promise.resolve({
        write: (bytes, offset = 0, length = bytes.byteLength - offset) => {
          writes.push(new TextDecoder().decode(bytes.slice(offset, offset + length)));
          return length;
        },
        terminate: () => void (terminated += 1),
      });
    },
    writes,
    events: () => {
      if (callbacks === undefined) throw new Error('client did not connect');
      return callbacks;
    },
    terminated: () => terminated,
  };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('connectSolverSupervisor', () => {
  const rejectionOf = async (operation: Promise<unknown>): Promise<Error> => {
    try {
      await operation;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error('expected operation to reject');
  };

  it('sends one bounded start, then carries verdict, streams, and terminal evidence', async () => {
    const fake = harness();
    const connecting = connectSolverSupervisor(request, fake.connect);
    await Promise.resolve();
    const { unix, ...fields } = request;
    expect(unix).toBe('/run/wbs-solver/supervisor.sock');
    expect(fake.writes).toEqual([
      `${JSON.stringify({ type: 'start', protocolVersion: 1, ...fields })}\n`,
    ]);

    fake.events().data(bytes('{"type":"started","pid":42}\n'));
    const attempt = await connecting;
    await attempt.verdict('bound');
    fake.events().data(bytes('{"type":"stdout","payload":"aGVs'));
    fake.events().data(bytes('bG8="}\n{"type":"stderr","payload":"d2FybmluZw=="}\n'));
    fake
      .events()
      .data(bytes('{"type":"terminal","exitCode":0,"deadlineKilled":false,"oomKilled":false}\n'));

    expect(attempt.pid).toBe(42);
    expect(await new Response(attempt.stdout).text()).toBe('hello');
    expect(await new Response(attempt.stderr).text()).toBe('warning');
    expect(await attempt.terminal).toEqual({
      type: 'terminal',
      exitCode: 0,
      deadlineKilled: false,
      oomKilled: false,
    });
    expect(fake.writes.at(-1)).toBe('{"type":"bound"}\n');
    expect(fake.terminated()).toBe(0);
  });

  it('fails closed when the connection ends before started', async () => {
    const fake = harness();
    const connecting = connectSolverSupervisor(request, fake.connect);
    await Promise.resolve();
    fake.events().close();
    expect((await rejectionOf(connecting)).message).toMatch(/EOF before terminal/);
  });

  it('refuses a reply stream that does not begin with started', async () => {
    const fake = harness();
    const connecting = connectSolverSupervisor(request, fake.connect);
    await Promise.resolve();
    // Proof: removing the reply-phase check lets unauthenticated output allocate
    // stream memory before the supervisor has returned a child PID to bind.
    fake.events().data(bytes('{"type":"stdout","payload":"aGVsbG8="}\n'));
    expect((await rejectionOf(connecting)).message).toMatch(/reply before started/);
    expect(fake.terminated()).toBe(1);
  });
});
