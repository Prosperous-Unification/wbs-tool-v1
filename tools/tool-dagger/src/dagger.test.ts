import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { planBe } from './be-01';
import { planFe } from './fe-01';
import { planGw } from './gw-01';
import { bundleName } from './lib/bundle';
import { DEFAULT_IMAGES } from './lib/image';
import { assertDockerfileInputs, dockerfileFor } from './main';

describe('bundleName', () => {
  it('formats a valid release name', () => {
    expect(bundleName('be', 'abc1234')).toBe('release-abc1234-be.tar.gz');
  });
  it('rejects invalid sha', () => {
    expect(() => bundleName('gw', 'NOPE')).toThrow(/invalid git sha/);
  });
});

describe('plan*', () => {
  it('builds a be plan with meta JSON', () => {
    const p = planBe({ sha: 'abc1234', mode: 'publish' });
    expect(p.bundle).toBe('release-abc1234-be.tar.gz');
    const meta = JSON.parse(p.meta) as { tier: string; sha: string; files: string[] };
    expect(meta.tier).toBe('be');
    expect(meta.sha).toBe('abc1234');
    expect(meta.files).toContain('META.json');
  });

  it('builds a gw plan', () => {
    const p = planGw({ sha: 'abc1234', mode: 'build-only' });
    expect(p.bundle).toBe('release-abc1234-gw.tar.gz');
    expect(p.image.tier).toBe('gw');
  });

  it('builds a fe plan without image tarball', () => {
    const p = planFe({ sha: 'abc1234', mode: 'publish' });
    expect(p.bundle).toBe('release-abc1234-fe.tar.gz');
    const meta = JSON.parse(p.meta) as { files: string[]; images?: string[] };
    expect(meta.files).toContain('dist/');
    expect(meta.images).toBeUndefined();
  });
});

describe('namespaced image inputs', () => {
  it('uses the moved Dockerfiles and runtime entrypoints', () => {
    expect(
      [DEFAULT_IMAGES.be, DEFAULT_IMAGES.gw, DEFAULT_IMAGES.fe].map(({ tier }) =>
        dockerfileFor(tier),
      ),
    ).toEqual([
      'apps/wbs/be-01/Dockerfile',
      'apps/wbs/gw-01/Dockerfile',
      'apps/wbs/fe-01/Dockerfile',
    ]);
    expect(DEFAULT_IMAGES.be.entrypoint).toEqual(['bun', 'run', 'apps/wbs/be-01/src/main.ts']);
    expect(DEFAULT_IMAGES.gw.entrypoint).toEqual(['bun', 'run', 'apps/wbs/gw-01/src/main.ts']);
  });

  it('resolves every local COPY input used to construct each candidate image', () => {
    const workspace = new URL('../../..', import.meta.url).pathname;
    // Proof: restoring the backend Dockerfile's local COPY input to
    // apps/be-01 failed this production preflight at Dockerfile:39 with
    // "COPY input apps/be-01 does not exist". Observed 2026-09-13 and restored.
    for (const tier of ['be', 'gw', 'fe'] as const) {
      expect(() => {
        assertDockerfileInputs(workspace, tier);
      }).not.toThrow();
    }
  });

  it('keeps moved workdirs, build selector and frontend output coherent', () => {
    const workspace = new URL('../../..', import.meta.url).pathname;
    const backend = readFileSync(join(workspace, dockerfileFor('be')), 'utf8');
    const gateway = readFileSync(join(workspace, dockerfileFor('gw')), 'utf8');
    const frontend = readFileSync(join(workspace, dockerfileFor('fe')), 'utf8');
    expect(backend).toContain('WORKDIR /app/apps/wbs/be-01');
    expect(backend).toContain('COPY libs/wbs/adapters/solver-py/requirements.lock');
    expect(gateway).toContain('WORKDIR /app/apps/wbs/gw-01');
    expect(frontend).toContain('RUN bunx nx run wbs-fe-01:build');
    expect(frontend).toContain('/app/dist/apps/wbs/fe-01');
  });

  it('runs the solver image smoke through moved host and container paths', () => {
    const workspace = new URL('../../..', import.meta.url).pathname;
    const smoke = readFileSync(
      join(workspace, 'apps/wbs/be-01/scripts/solver-image-smoke.sh'),
      'utf8',
    );
    expect(smoke).toContain('repo_root="$(cd "$script_dir/../../../.." && pwd)"');
    expect(smoke).toContain('$repo_root/apps/wbs/be-01/Dockerfile');
    expect(smoke).toContain('/app/apps/wbs/be-01/scripts/solver-supervisor-image-client.ts');
    expect(smoke).toContain('/app/libs/wbs/domain/contracts/solver/fixtures/request/');
    expect(smoke).toContain('apps/wbs/be-01/src/service/optimization-orphan.proc.db.test.ts');
  });
});
