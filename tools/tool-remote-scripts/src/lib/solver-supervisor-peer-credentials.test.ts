import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import {
  readSupervisorPeerCredentials,
  type SupervisorGetsockopt,
} from './solver-supervisor-peer-credentials';

describe('readSupervisorPeerCredentials', () => {
  it('reads the accepted fd with Linux SO_PEERCRED and decodes struct ucred', () => {
    const calls: number[][] = [];
    const getsockopt: SupervisorGetsockopt = (fd, level, option, value, length) => {
      calls.push([fd, level, option]);
      new DataView(value.buffer, value.byteOffset, value.byteLength).setInt32(0, 4242, true);
      new DataView(value.buffer, value.byteOffset, value.byteLength).setUint32(4, 1000, true);
      new DataView(value.buffer, value.byteOffset, value.byteLength).setUint32(8, 1001, true);
      length[0] = 12;
      return 0;
    };

    expect(readSupervisorPeerCredentials({ fd: 17 }, getsockopt, true)).toEqual({
      pid: 4242,
      uid: 1000,
      gid: 1001,
    });
    // Proof: replacing SO_PEERCRED with another socket option changes this
    // exact kernel call before caller-controlled bytes can be trusted.
    expect(calls).toEqual([[17, 1, 17]]);
  });

  it('fails closed on an absent fd, syscall error, or malformed native evidence', () => {
    expect(() => readSupervisorPeerCredentials({}, () => 0, true)).toThrow(/file descriptor/);
    expect(() => readSupervisorPeerCredentials({ fd: 9 }, () => -1, true)).toThrow(
      /getsockopt failed/,
    );
    expect(() =>
      readSupervisorPeerCredentials(
        { fd: 9 },
        (_fd, _level, _option, value, length) => {
          new DataView(value.buffer, value.byteOffset, value.byteLength).setInt32(0, 0, true);
          length[0] = 12;
          return 0;
        },
        true,
      ),
    ).toThrow(/invalid peer pid/);
  });

  // Proof: running this unguarded on macOS failed at dlopen('libc.so.6') with
  // ERR_DLOPEN_FAILED before the SO_PEERCRED assertion could run.
  it.skipIf(process.platform !== 'linux')(
    'obtains the real peer pid, uid, and gid from a Bun Unix listener on Linux',
    async () => {
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (uid === undefined || gid === undefined) {
        throw new Error('real SO_PEERCRED proof requires Linux process credentials');
      }
      const path = `/tmp/wbs-peer-credentials-${String(process.pid)}-${randomUUID()}.sock`;
      let resolveCredentials: (value: ReturnType<typeof readSupervisorPeerCredentials>) => void;
      const credentials = new Promise<ReturnType<typeof readSupervisorPeerCredentials>>(
        (resolve) => {
          resolveCredentials = resolve;
        },
      );
      const listener = Bun.listen({
        unix: path,
        socket: {
          open(socket) {
            resolveCredentials(readSupervisorPeerCredentials(socket));
            socket.end();
          },
          data(socket) {
            socket.end();
          },
        },
      });
      const client = await Bun.connect({
        unix: path,
        socket: {
          open(socket) {
            socket.write('probe');
          },
          data(socket) {
            socket.end();
          },
        },
      });

      try {
        expect(await credentials).toEqual({
          pid: process.pid,
          uid,
          gid,
        });
      } finally {
        client.end();
        listener.stop(true);
      }
    },
  );
});
