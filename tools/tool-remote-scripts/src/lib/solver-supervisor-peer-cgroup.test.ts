import { describe, expect, it } from 'bun:test';

import {
  dockerContainerIdFromPeerCgroup,
  readSupervisorPeerCgroup,
  type SupervisorCgroupFile,
  type SupervisorCgroupOpen,
} from './solver-supervisor-peer-cgroup';

const ID = 'c9f2fe345449eb2ffe4be8334a9d94ea590eb6d9980e597321d16aa89791bd9a';

class MemoryCgroupFile implements SupervisorCgroupFile {
  readonly bytes: Uint8Array;
  closed = false;
  position = 0;

  constructor(text: string) {
    this.bytes = new TextEncoder().encode(text);
  }

  read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }> {
    const bytesRead = Math.min(length, this.bytes.byteLength - this.position);
    buffer.set(this.bytes.subarray(this.position, this.position + bytesRead), offset);
    this.position += bytesRead;
    return Promise.resolve({ bytesRead });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected operation to reject');
}

describe('dockerContainerIdFromPeerCgroup', () => {
  it('decodes the measured systemd Docker cgroup and the cgroupfs spelling', () => {
    expect(dockerContainerIdFromPeerCgroup(`0::/system.slice/docker-${ID}.scope\n`)).toBe(ID);
    expect(dockerContainerIdFromPeerCgroup(`0::/docker/${ID}\n`)).toBe(ID);
  });

  it('rejects host, partial, uppercase, and conflicting container paths', () => {
    for (const raw of [
      '0::/user.slice/user-1000.slice/session-2.scope\n',
      `0::/system.slice/docker-${ID.slice(0, 12)}.scope\n`,
      `0::/system.slice/docker-${ID.toUpperCase()}.scope\n`,
      `0::/docker/${ID}\n1:name=/docker/${'d'.repeat(64)}\n`,
    ]) {
      expect(() => dockerContainerIdFromPeerCgroup(raw)).toThrow(/peer cgroup/);
    }
  });

  it('rejects oversized proc evidence before parsing', () => {
    // Proof: dropping the proc-byte cap lets an injected filesystem seam retain
    // unbounded evidence before authentication has completed.
    expect(() => dockerContainerIdFromPeerCgroup('x'.repeat(65_537))).toThrow(/bytes/);
  });

  it('reads only the bounded peer PID cgroup file and closes it', async () => {
    const file = new MemoryCgroupFile(`0::/system.slice/docker-${ID}.scope\n`);
    const paths: string[] = [];
    const open: SupervisorCgroupOpen = (path) => {
      paths.push(path);
      return Promise.resolve(file);
    };

    expect(await readSupervisorPeerCgroup(4242, open)).toBe(
      `0::/system.slice/docker-${ID}.scope\n`,
    );
    expect(paths).toEqual(['/proc/4242/cgroup']);
    expect(file.closed).toBe(true);
  });

  it('rejects an invalid PID and one byte above the cap without retaining the file', async () => {
    let opens = 0;
    const neverOpen: SupervisorCgroupOpen = () => {
      opens += 1;
      throw new Error('must not open');
    };
    expect((await rejectionOf(readSupervisorPeerCgroup(0, neverOpen))).message).toMatch(/peer pid/);
    expect(opens).toBe(0);

    const oversize = new MemoryCgroupFile('x'.repeat(65_537));
    expect(
      (await rejectionOf(readSupervisorPeerCgroup(4242, () => Promise.resolve(oversize)))).message,
    ).toMatch(/bytes/);
    expect(oversize.closed).toBe(true);
  });
});
