import { describe, expect, it } from 'bun:test';

import { dockerContainerIdFromPeerCgroup } from './solver-supervisor-peer-cgroup';

const ID = 'c9f2fe345449eb2ffe4be8334a9d94ea590eb6d9980e597321d16aa89791bd9a';

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
});
