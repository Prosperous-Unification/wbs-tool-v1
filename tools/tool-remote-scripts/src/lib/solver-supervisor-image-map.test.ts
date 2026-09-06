import { describe, expect, it } from 'bun:test';

import { supervisorImagePolicy } from './solver-supervisor-image-map';

const BLUE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;
const GREEN = `registry.example/wbs-be@sha256:${'b'.repeat(64)}`;
const SOLVER = `registry.example/wbs-solver@sha256:${'c'.repeat(64)}`;
const DEV_SOLVER = `registry.example/wbs-solver@sha256:${'d'.repeat(64)}`;
const RULES = [
  { callerName: 'be-01-blue', callerImage: BLUE, solverImage: SOLVER },
  { callerName: 'be-01-green', callerImage: GREEN, solverImage: SOLVER },
  { callerName: 'wbs-dev-src', callerImage: null, solverImage: DEV_SOLVER },
];

describe('the host-owned solver image map', () => {
  it('derives exact allow patterns and images from authenticated backend identity', () => {
    const policy = supervisorImagePolicy(RULES);
    expect(policy.allowedNamePatterns.map((pattern) => pattern.source)).toEqual([
      '^be-01-blue$',
      '^be-01-green$',
      '^wbs-dev-src$',
    ]);
    expect(policy.imageFor({ id: '1', name: 'be-01-blue', image: BLUE })).toBe(SOLVER);
    expect(policy.imageFor({ id: '2', name: 'wbs-dev-src', image: 'wbs-dev-src:1' })).toBe(
      DEV_SOLVER,
    );
  });

  it('refuses a stale prod image and an authenticated caller absent from the map', () => {
    const policy = supervisorImagePolicy(RULES);
    expect(() =>
      policy.imageFor({
        id: '1',
        name: 'be-01-blue',
        image: `registry.example/wbs-be@sha256:${'e'.repeat(64)}`,
      }),
    ).toThrow(/image does not match/);
    expect(() => policy.imageFor({ id: '2', name: 'dev-be-01-blue', image: BLUE })).toThrow(
      /no rule/,
    );
  });

  it('rejects duplicate, unknown, incomplete, and authority-bearing rules', () => {
    expect(() => supervisorImagePolicy([])).toThrow(/non-empty/);
    expect(() => supervisorImagePolicy([RULES[0], RULES[0]])).toThrow(/duplicate/);
    expect(() => supervisorImagePolicy([{ ...RULES[0], network: 'host' }])).toThrow(/unknown key/);
    expect(() => supervisorImagePolicy([{ callerName: 'be-01-blue', callerImage: BLUE }])).toThrow(
      /missing key/,
    );
    expect(() =>
      supervisorImagePolicy([
        { callerName: 'be-01-blue', callerImage: BLUE, solverImage: 'wbs-solver:latest' },
      ]),
    ).toThrow(/solverImage is not digest-pinned/);
    expect(() =>
      supervisorImagePolicy([{ callerName: 'be-01-blue', callerImage: null, solverImage: SOLVER }]),
    ).toThrow(/callerImage is not digest-pinned/);
    expect(() =>
      supervisorImagePolicy([
        { callerName: 'wbs-dev-src', callerImage: 'wbs-dev-src:1', solverImage: DEV_SOLVER },
      ]),
    ).toThrow(/callerImage must be null/);
  });
});
