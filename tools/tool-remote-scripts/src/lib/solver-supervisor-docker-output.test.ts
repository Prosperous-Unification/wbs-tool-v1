import { describe, expect, it } from 'bun:test';

import {
  parseBackendContainerIdentity,
  parseManagedContainerEvidence,
  parseManagedContainerId,
  parseManagedContainerList,
} from './solver-supervisor-docker-output';

const CONTAINER_ID = 'a'.repeat(64);

describe('the solver supervisor Docker output boundary', () => {
  it('accepts the measured live backend identity under one configured name pattern', () => {
    expect(
      parseBackendContainerIdentity(
        JSON.stringify({
          id: CONTAINER_ID,
          name: '/wbs-dev-src',
          running: true,
          image: 'wbs-dev-src:1',
        }),
        CONTAINER_ID,
        [/^wbs-dev-src$/],
      ),
    ).toEqual({ id: CONTAINER_ID, name: 'wbs-dev-src', image: 'wbs-dev-src:1' });
  });

  it('rejects a stopped, renamed, or different live container and malformed policy', () => {
    const identity = {
      id: CONTAINER_ID,
      name: '/wbs-dev-src',
      running: true,
      image: 'wbs-dev-src:1',
    };
    // Proof: dropping any of the live-id-name conjunction admits one of these
    // caller identities before the claimed id reaches the protocol decoder.
    expect(() =>
      parseBackendContainerIdentity(
        JSON.stringify({ ...identity, id: 'b'.repeat(64) }),
        CONTAINER_ID,
        [/^wbs-dev-src$/],
      ),
    ).toThrow(/expected peer id/);
    expect(() =>
      parseBackendContainerIdentity(JSON.stringify({ ...identity, running: false }), CONTAINER_ID, [
        /^wbs-dev-src$/,
      ]),
    ).toThrow(/not running/);
    expect(() =>
      parseBackendContainerIdentity(
        JSON.stringify({ ...identity, name: '/attacker' }),
        CONTAINER_ID,
        [/^wbs-dev-src$/],
      ),
    ).toThrow(/name is not allowed/);
    expect(() =>
      parseBackendContainerIdentity(JSON.stringify(identity), CONTAINER_ID, [/wbs-dev-src/]),
    ).toThrow(/anchored/);
    expect(() => parseBackendContainerIdentity(JSON.stringify(identity), CONTAINER_ID, [])).toThrow(
      /name pattern/,
    );
  });

  it('rejects noisy or incomplete backend inspection evidence', () => {
    const identity = {
      id: CONTAINER_ID,
      name: '/wbs-dev-src',
      running: true,
      image: 'wbs-dev-src:1',
    };
    expect(() =>
      parseBackendContainerIdentity(
        JSON.stringify({ ...identity, labels: { trusted: 'true' } }),
        CONTAINER_ID,
        [/^wbs-dev-src$/],
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseBackendContainerIdentity(
        JSON.stringify({ id: CONTAINER_ID, name: '/wbs-dev-src', running: true }),
        CONTAINER_ID,
        [/^wbs-dev-src$/],
      ),
    ).toThrow(/missing key/);
  });

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
