import { describe, expect, it } from 'bun:test';

import {
  parseManagedContainerEvidence,
  parseManagedContainerId,
  parseManagedContainerList,
} from './solver-supervisor-docker-output';

const CONTAINER_ID = 'a'.repeat(64);

describe('the solver supervisor Docker output boundary', () => {
  it('accepts one canonical create id and a unique labelled list', () => {
    expect(parseManagedContainerId(`${CONTAINER_ID}\n`)).toBe(CONTAINER_ID);
    expect(parseManagedContainerList(`${CONTAINER_ID}\n${'b'.repeat(64)}\n`)).toEqual([
      CONTAINER_ID,
      'b'.repeat(64),
    ]);
  });

  it('rejects partial, duplicate, and noisy container identities', () => {
    // Proof: removing full-id and uniqueness validation admits every value below.
    expect(() => parseManagedContainerId('abc\n')).toThrow(/full container id/);
    expect(() => parseManagedContainerId(`${CONTAINER_ID}\nwarning\n`)).toThrow(/one line/);
    expect(() => parseManagedContainerList(`${CONTAINER_ID}\n${CONTAINER_ID}\n`)).toThrow(
      /duplicate/,
    );
  });

  it('decodes only one complete Docker state record', () => {
    expect(
      parseManagedContainerEvidence(
        JSON.stringify([{ State: { Pid: 0, ExitCode: 137, OOMKilled: true } }]),
        false,
      ),
    ).toEqual({ pid: 0, exitCode: 137, oomKilled: true, deadlineKilled: false });
  });

  it('rejects missing or malformed native evidence', () => {
    // Proof: defaulting absent OOMKilled to false makes the first case pass.
    expect(() =>
      parseManagedContainerEvidence(JSON.stringify([{ State: { Pid: 0, ExitCode: 137 } }]), false),
    ).toThrow(/OOMKilled/);
    expect(() =>
      parseManagedContainerEvidence(
        JSON.stringify([{ State: { Pid: -1, ExitCode: '137', OOMKilled: false } }]),
        false,
      ),
    ).toThrow(/Pid/);
    expect(() => parseManagedContainerEvidence('{}', false)).toThrow(/one record/);
  });
});
