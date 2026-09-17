import { describe, expect, it } from 'bun:test';

import { planBe } from './be-01';
import { planFe } from './fe-01';
import { planGw } from './gw-01';
import { bundleName } from './lib/bundle';

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

  it('starts the Bun tiers from their namespaced application roots', () => {
    const be = planBe({ sha: 'abc1234', mode: 'build-only' }).image;
    const gw = planGw({ sha: 'abc1234', mode: 'build-only' }).image;

    expect(be.entrypoint).toEqual(['bun', 'run', 'src/main.ts']);
    expect(be.workdir).toBe('/app/apps/wbs/be-01');
    expect(gw.entrypoint).toEqual(['bun', 'run', 'src/main.ts']);
    expect(gw.workdir).toBe('/app/apps/wbs/gw-01');
  });
});
