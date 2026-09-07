import { randomUUID } from 'node:crypto';

import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorStartFrame,
} from '@wbs/contracts/solver/supervisor-protocol';
import { describe, expect, it } from 'bun:test';

import { listenForSupervisorConnections } from './solver-supervisor-listener';

const CALLER_ID = 'a'.repeat(64);
const FRAME: SupervisorStartFrame = {
  type: 'start',
  protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
  callerId: CALLER_ID,
  projectId: '018f3f08-2ef7-7d1c-b645-14f877575d65',
  objective: 'pri',
  attemptToken: '018f3f08-2ef7-7d1c-b645-14f877575d66',
  childDeadlineAt: 20_000,
  searchWorkers: 2,
  memoryLimitMb: 512,
  request: { wireVersion: 1, objective: 'pri' },
};

describe('the solver supervisor Unix listener', () => {
  it('carries a real accepted socket through peer authentication and one attempt', async () => {
    const path = `/tmp/wbs-supervisor-${String(process.pid)}-${randomUUID()}.sock`;
    let acceptedSocket: unknown;
    let seenFrame: SupervisorStartFrame | undefined;
    const errors: Error[] = [];
    const listener = await listenForSupervisorConnections(
      {
        unix: path,
        allowedNamePatterns: [/^wbs-dev-src$/],
        maxInputBytes: 2 * 1024 * 1024,
        bindTimeoutMs: 1_000,
        maxSearchWorkers: 2,
        maxMemoryLimitMb: 512,
        now: () => 10_000,
        onConnectionError: (error) => errors.push(error),
      },
      {
        credentials: (socket) => {
          acceptedSocket = socket;
          return { pid: process.pid, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
        },
        cgroup: () => Promise.resolve(`0::/system.slice/docker-${CALLER_ID}.scope\n`),
        inspect: (id) => Promise.resolve({ id, name: 'wbs-dev-src', image: 'wbs-dev-src:1' }),
        run: async (frame, channel) => {
          seenFrame = frame;
          await channel.send({ type: 'started', pid: 99 });
        },
      },
    );
    let resolveReply: (value: string) => void;
    const reply = new Promise<string>((resolve) => {
      resolveReply = resolve;
    });
    let response = '';
    const client = await Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(FRAME)}\n`);
        },
        data(socket, chunk) {
          response += chunk.toString();
          if (response.includes('\n')) {
            resolveReply(response);
            socket.end();
          }
        },
      },
    });

    try {
      expect(await reply).toBe('{"type":"started","pid":99}\n');
      expect(acceptedSocket).toBeDefined();
      expect(seenFrame).toEqual(FRAME);
      expect(errors).toEqual([]);
    } finally {
      client.end();
      listener.stop(true);
    }
  });

  it('refuses to replace a Unix socket that is accepting connections', async () => {
    const path = `/tmp/wbs-supervisor-${String(process.pid)}-${randomUUID()}.sock`;
    const incumbent = Bun.listen({
      unix: path,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {
          return undefined;
        },
      },
    });
    let replacement: Awaited<ReturnType<typeof listenForSupervisorConnections>> | undefined;
    let rejection: unknown;

    try {
      try {
        replacement = await listenForSupervisorConnections(
          {
            unix: path,
            allowedNamePatterns: [/^wbs-dev-src$/],
            maxInputBytes: 2 * 1024 * 1024,
            bindTimeoutMs: 1_000,
            maxSearchWorkers: 2,
            maxMemoryLimitMb: 512,
            now: () => 10_000,
          },
          {
            credentials: () => ({ pid: process.pid, uid: 0, gid: 0 }),
            cgroup: () => Promise.resolve(`0::/system.slice/docker-${CALLER_ID}.scope\n`),
            inspect: (id) => Promise.resolve({ id, name: 'wbs-dev-src', image: 'wbs-dev-src:1' }),
            run: () => Promise.resolve(),
          },
        );
      } catch (error) {
        rejection = error;
      }

      // Proof: without the liveness probe, rejection is undefined and a replacement binds.
      expect(rejection).toEqual(
        new Error('solver supervisor listener: configured socket is already accepting connections'),
      );
    } finally {
      replacement?.stop(true);
      incumbent.stop(true);
    }
  });
});
