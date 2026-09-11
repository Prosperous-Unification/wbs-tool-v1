import { describe, expect, it } from 'bun:test';

import {
  decodeInstalledProdImages,
  decodeProdContainerImages,
  decodePublishedSolverImage,
  prepareTargetSolverBinding,
  registryPasswordFromEnv,
  type TargetSolverBindingDependencies,
} from './solver-binding-host';

const SHA = 'a'.repeat(40);
const BLUE = `registry.example/wbs-be@sha256:${'b'.repeat(64)}`;
const GREEN = `registry.example/wbs-be@sha256:${'c'.repeat(64)}`;
const DEV = `registry.example/wbs-be@sha256:${'d'.repeat(64)}`;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const installedConfig = () => ({
  socketPath: '/run/user/1000/wbs-solver/supervisor.sock',
  maxSearchWorkers: 2,
  maxMemoryLimitMb: 512,
  pidsLimit: 128,
  maxManagedContainers: 16,
  devSourceSha: SHA,
  images: [
    { callerName: 'be-01-blue', callerImage: BLUE, solverImage: BLUE },
    { callerName: 'be-01-green', callerImage: GREEN, solverImage: GREEN },
    { callerName: 'wbs-dev-src', callerImage: null, solverImage: DEV },
  ],
});
const prodContainers = bytes(
  [
    { name: '/be-01-blue', running: false, image: BLUE },
    { name: '/be-01-green', running: true, image: GREEN },
  ]
    .map((container) => JSON.stringify(container))
    .join('\n'),
);

describe('the automatic solver binding host inputs', () => {
  it('reads exactly one non-empty registry password without truncating equals signs', () => {
    expect(registryPasswordFromEnv(bytes(`OTHER=kept\nREGISTRY_PASS=a=b=c\n`))).toBe('a=b=c');
    expect(() => registryPasswordFromEnv(bytes('OTHER=present\n'))).toThrow(
      /REGISTRY_PASS.*missing/,
    );
    expect(() => registryPasswordFromEnv(bytes('REGISTRY_PASS=\n'))).toThrow(
      /REGISTRY_PASS.*empty/,
    );
    expect(() =>
      registryPasswordFromEnv(bytes('REGISTRY_PASS=first\nREGISTRY_PASS=second\n')),
    ).toThrow(/REGISTRY_PASS.*duplicate/);
  });

  it('accepts only the target source and registry-returned immutable be image', () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    expect(
      decodePublishedSolverImage(
        bytes(
          JSON.stringify({
            be: { sha: SHA, digest, ref: `registry.example/wbs-be:${SHA}`, image: DEV },
          }),
        ),
        SHA,
      ),
    ).toBe(DEV);
    expect(() =>
      decodePublishedSolverImage(
        bytes(JSON.stringify({ be: { sha: 'e'.repeat(40), digest, ref: 'tag', image: DEV } })),
        SHA,
      ),
    ).toThrow(/source SHA/);
    expect(() =>
      decodePublishedSolverImage(
        bytes(
          JSON.stringify({
            be: { sha: SHA, digest, ref: 'tag', image: 'registry.example/wbs-be:latest' },
          }),
        ),
        SHA,
      ),
    ).toThrow(/digest-pinned/);
    // Proof: the case above cannot reach `!image.endsWith(`@${digest}`)` —
    // `registry.example/wbs-be:latest` is already refused by
    // DIGEST_PINNED_IMAGE, so deleting that clause left the whole suite green
    // (`98 pass, 0 fail`). This is the manifest the clause exists for: an image
    // pinned to a real digest that is NOT the one the entry reports, which is a
    // registry answer naming a different build. Watched failing on
    // `error: expect(received).toThrow(expected)` with the clause removed.
    expect(() =>
      decodePublishedSolverImage(
        bytes(
          JSON.stringify({
            be: {
              sha: SHA,
              digest,
              ref: 'tag',
              image: `registry.example/wbs-be@sha256:${'e'.repeat(64)}`,
            },
          }),
        ),
        SHA,
      ),
    ).toThrow(/digest-pinned to its returned digest/);
    // Proof: `!DIGEST.test(digest)` had no case at all — deleted, the suite
    // stayed green. A digest too short to be a sha256 is the fault it is about.
    // Watched failing on `expect(received).toThrow(expected)` without it.
    expect(() =>
      decodePublishedSolverImage(
        bytes(JSON.stringify({ be: { sha: SHA, digest: 'sha256:short', ref: 'tag', image: DEV } })),
        SHA,
      ),
    ).toThrow(/digest is invalid/);
  });

  it('refuses an input above the host decoder byte ceiling', () => {
    // Proof: `bytes.byteLength > HOST_INPUT_MAX_BYTES` in `jsonOf` had no case
    // on any of its four callers — removing the clause from both its sites left
    // the suite green (`98 pass, 0 fail`). The empty half was covered; the
    // ceiling was not, so an oversized manifest was parsed rather than refused.
    // One byte over 256 KiB, still valid JSON so the refusal cannot be the
    // parser's. Watched failing on `expect(received).toThrow(expected)`.
    const oversized = bytes(
      JSON.stringify({ be: { sha: SHA, ref: 'tag', pad: 'x'.repeat(256 * 1024) } }),
    );
    expect(oversized.byteLength).toBeGreaterThan(256 * 1024);
    expect(() => decodePublishedSolverImage(oversized, SHA)).toThrow(/1 through 262144 bytes/);
    expect(() => decodeInstalledProdImages(oversized)).toThrow(/1 through 262144 bytes/);
  });

  it('preserves both exact prod mappings and refuses a divergent prod solver image', () => {
    const config = installedConfig();
    expect(decodeInstalledProdImages(bytes(JSON.stringify(config)))).toEqual({
      blueImage: BLUE,
      greenImage: GREEN,
    });
    config.images[0] = { ...config.images[0], solverImage: GREEN };
    expect(() => decodeInstalledProdImages(bytes(JSON.stringify(config)))).toThrow(
      /be-01-blue.*solver image/,
    );
  });

  it('refuses incomplete or mutable production container inspection', () => {
    expect(() =>
      decodeProdContainerImages(
        bytes(
          [
            { name: '/be-01-blue', running: false, image: 'registry.example/wbs-be:latest' },
            { name: '/be-01-green', running: true, image: GREEN },
          ]
            .map((container) => JSON.stringify(container))
            .join('\n'),
        ),
      ),
    ).toThrow(/invalid/);
    expect(() =>
      decodeProdContainerImages(
        bytes(
          [
            { name: '/be-01-blue', running: false, image: BLUE },
            { name: '/be-01-blue', running: true, image: GREEN },
          ]
            .map((container) => JSON.stringify(container))
            .join('\n'),
        ),
      ),
    ).toThrow(/one be-01-blue/);
  });

  it('validates host inputs, publishes, installs, verifies, checkpoints, then resets', async () => {
    const events: string[] = [];
    const digest = `sha256:${'d'.repeat(64)}`;
    const manifest = bytes(
      JSON.stringify({
        be: { sha: SHA, digest, ref: `registry.example/wbs-be:${SHA}`, image: DEV },
      }),
    );

    await prepareTargetSolverBinding(
      { sourceSha: SHA, compatibilityIdentity: 'e'.repeat(64) },
      undefined,
      {
        readRegistryEnv: () => {
          events.push('read-registry');
          return Promise.resolve(bytes('REGISTRY_PASS=protected-value\n'));
        },
        readInstalledConfig: () => {
          events.push('read-config');
          return Promise.resolve(undefined);
        },
        readProdContainers: () => {
          events.push('read-prod-containers');
          return Promise.resolve(prodContainers);
        },
        publish: (sourceSha, password) => {
          expect(sourceSha).toBe(SHA);
          expect(password).toBe('protected-value');
          events.push('publish');
          return Promise.resolve(manifest);
        },
        materialize: (binding) => {
          expect(binding).toEqual({
            blueImage: BLUE,
            greenImage: GREEN,
            devSolverImage: DEV,
            devSourceSha: SHA,
          });
          events.push('materialize');
          return Promise.resolve();
        },
        install: () => {
          events.push('install');
          return Promise.resolve();
        },
        preflight: () => {
          events.push('preflight');
          return Promise.resolve();
        },
        checkpoint: (state) => {
          events.push(`checkpoint:${state.phase}`);
          return Promise.resolve();
        },
        withHostMutationLock: async (action) => {
          events.push('prod-lock');
          await action();
          events.push('prod-unlock');
        },
        reset: () => {
          events.push('reset');
          return Promise.resolve();
        },
      } satisfies TargetSolverBindingDependencies,
    );

    expect(events).toEqual([
      'read-config',
      'read-prod-containers',
      'read-registry',
      'publish',
      'checkpoint:published',
      'prod-lock',
      'materialize',
      'install',
      'preflight',
      'prod-unlock',
      'checkpoint:complete',
      'reset',
    ]);
  });
});
