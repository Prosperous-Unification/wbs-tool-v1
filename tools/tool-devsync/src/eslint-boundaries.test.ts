import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

const workspace = fileURLToPath(new URL('../../..', import.meta.url));
const lint = new ESLint({ cwd: workspace });

async function ruleIds(path: string, source: string): Promise<readonly (string | null)[]> {
  const [report] = await lint.lintText(source, { filePath: path });
  return report.messages.map((message) => message.ruleId);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundaryOf(config: unknown): readonly unknown[] {
  if (!isRecord(config) || !isRecord(config['rules'])) {
    throw new Error('ESLint returned a malformed effective configuration');
  }
  const boundary = config['rules']['@nx/enforce-module-boundaries'];
  if (!Array.isArray(boundary)) throw new Error('ESLint returned no module-boundary rule');
  return boundary;
}

describe('the effective production and test boundaries', () => {
  it('rejects runtime packages and drivers from core and domain production', async () => {
    // Proof: before the core/domain production override existed, the Elysia
    // probe returned no `no-restricted-imports` diagnostic. Real uncached lint
    // targets then rejected Elysia, node:crypto, drizzle-orm and bun:sqlite at
    // their injected import lines (2026-09-10).
    // Proof: restoring only the production file scopes to libs/core and
    // libs/domain made the moved core Elysia probe receive no diagnostics
    // (2026-09-13).
    for (const [path, source] of [
      ['libs/wbs/application/core/src/index.ts', "import 'elysia';"],
      ['libs/wbs/application/core/src/index.ts', "import 'drizzle-orm';"],
      ['libs/wbs/application/core/src/index.ts', "import 'bun:sqlite';"],
      ['libs/wbs/application/core/src/index.ts', "import 'jose';"],
      ['libs/wbs/domain/domain/src/index.ts', "import 'node:crypto';"],
    ] as const) {
      expect(await ruleIds(path, source), `${path}: ${source}`).toContain('no-restricted-imports');
    }
  }, 30_000);

  it('rejects direct SQLite connections outside the database adapter boundary', async () => {
    // Proof: restoring the direct-SQLite file scopes to apps/be-01 and
    // libs/store-sqlite made both moved-path probes lose their diagnostic
    // (2026-09-13).
    const paths = [
      'apps/wbs/be-01/src/repository/capacity.ts',
      'libs/wbs/adapters/store-sqlite/src/capacity.ts',
    ] as const;
    const refused = await Promise.all(
      paths.map(async (path) =>
        (await ruleIds(path, "import 'bun:sqlite';")).includes(
          '@typescript-eslint/no-restricted-imports',
        ),
      ),
    );
    expect(refused).toEqual([true, true]);
  }, 30_000);

  it('rejects ambient runtime defaults from core production', async () => {
    // Proof: before the global fence existed, `Bun.version` produced only
    // `no-unused-expressions`; this case failed because it did not contain
    // `no-restricted-globals` (2026-09-10).
    for (const source of [
      'Bun.version;',
      'process.cwd();',
      "fetch('https://example.invalid');",
      'setTimeout(() => undefined, 1);',
      'setInterval(() => undefined, 1);',
      "Buffer.from('x');",
    ]) {
      expect(await ruleIds('libs/wbs/application/core/src/index.ts', source), source).toContain(
        'no-restricted-globals',
      );
    }
  }, 30_000);

  it('rejects both spellings of globalThis fetch from core production', async () => {
    // Proof: before both selectors existed, the dot spelling produced only
    // `no-floating-promises`; the effective test failed on the absent
    // `no-restricted-syntax`. The computed spelling later failed the uncached
    // core lint target at column 24 (2026-09-10).
    for (const source of [
      "globalThis.fetch('https://example.invalid');",
      "globalThis['fetch']('https://example.invalid');",
    ]) {
      expect(await ruleIds('libs/wbs/application/core/src/index.ts', source), source).toContain(
        'no-restricted-syntax',
      );
    }
  }, 30_000);

  it('keeps browser adapters outside the application ring in production and tests', async () => {
    // Proof: without the combined browser-adapter constraint, the production
    // probe returned no boundary diagnostic. The same edge injected into the
    // tracked frontend test failed wbs-fe-01:lint with the combined-tag message,
    // proving the test override retains this runtime boundary (2026-09-10).
    for (const path of [
      'apps/wbs/fe-01/src/components/wbs/plan-completeness.ts',
      'apps/wbs/fe-01/src/components/wbs/plan-completeness.test.ts',
    ]) {
      expect(await ruleIds(path, "import '@wbs/core';"), path).toContain(
        '@nx/enforce-module-boundaries',
      );
    }
  }, 30_000);

  it('rejects outer rings from domain production', async () => {
    // Proof: deleting the `ring:domain` constraint failed the effective-config
    // assertion on its exact missing object. Importing the non-circular,
    // isomorphic shared adapter supervisor protocol from tracked domain
    // production then failed the uncached wbs-domain lint target with “A project
    // tagged with \"ring:domain\" can only depend on libs tagged with
    // \"ring:domain\"” (2026-09-10).
    const config: unknown = await lint.calculateConfigForFile(
      'libs/wbs/domain/domain/src/index.ts',
    );
    const boundary = boundaryOf(config);
    const options = boundary[1];
    if (!isRecord(options) || !Array.isArray(options['depConstraints'])) {
      throw new Error('ESLint returned malformed domain boundary options');
    }
    expect(options['depConstraints']).toContainEqual({
      sourceTag: 'ring:domain',
      onlyDependOnLibsWithTags: ['ring:domain'],
    });
    expect(
      await ruleIds(
        'libs/wbs/domain/domain/src/index.ts',
        "import '@wbs/contracts/solver/supervisor-protocol';",
      ),
    ).toContain('@nx/enforce-module-boundaries');
  }, 30_000);

  it('rejects TypeBox across the repository', async () => {
    // Proof: deleting the repository-wide restriction made this tools/dev
    // production probe fail because `no-restricted-imports` was absent. The
    // same import in tracked tools/dev production failed its uncached lint
    // target with the ArkType diagnostic (2026-09-10).
    expect(
      await ruleIds('tools/dev/setup.ts', "import { Type } from '@sinclair/typebox'; void Type;"),
    ).toContain('no-restricted-imports');
  }, 30_000);

  it('permits bun:test only in core tests', async () => {
    // Proof: a temporary core test passed both wbs-core:lint and Bun (1 pass), then
    // its adjacent production sibling failed wbs-core:lint at the `bun:test`
    // import with `no-restricted-imports` (2026-09-10).
    expect(
      await ruleIds(
        'libs/wbs/application/core/src/ports/clock.test.ts',
        "import { describe } from 'bun:test'; describe('boundary', () => undefined);",
      ),
    ).not.toContain('no-restricted-imports');
    expect(await ruleIds('libs/wbs/application/core/src/index.ts', "import 'bun:test';")).toContain(
      'no-restricted-imports',
    );
  }, 30_000);

  it('applies the ring-only test exception to every tracked suffix and fixture', async () => {
    // Proof: before the runtime-only test override replaced the blanket `off`,
    // this case received severity 0 for `example.test.ts` instead of 2
    // (2026-09-10). With the scope constraints omitted from that replacement,
    // the new assertion failed because `scope:app` was absent. Importing
    // `@wbs/tool-compose` from config's tracked `define-config.test.ts` then
    // failed the uncached wbs-config lint target with “A project tagged with
    // \"scope:shared\" can only depend on libs tagged with \"scope:shared\"”.
    for (const path of [
      'libs/wbs/application/core/src/example.test.ts',
      'libs/wbs/application/core/src/example.test.tsx',
      'libs/wbs/application/core/src/example.spec.ts',
      'libs/wbs/application/core/src/example.property.test.ts',
      'libs/wbs/application/core/src/testing/example.ts',
    ]) {
      const config: unknown = await lint.calculateConfigForFile(path);
      const boundary = boundaryOf(config);
      expect(boundary[0], path).toBe(2);
      const options = boundary[1];
      if (!isRecord(options) || !Array.isArray(options['depConstraints'])) {
        throw new Error(`ESLint returned malformed boundary options for ${path}`);
      }
      // Proof: restoring the exception's two old Nx names made this moved core
      // config report core/store-memory instead of the qualified pair
      // (2026-09-13).
      expect(options['ignoredCircularDependencies'], path).toEqual([
        ['wbs-core', 'wbs-store-memory'],
      ]);
      expect(options['depConstraints'], path).toContainEqual({
        allSourceTags: ['ring:adapter', 'runtime:browser'],
        onlyDependOnLibsWithTags: ['ring:domain', 'runtime:browser'],
      });
      expect(options['depConstraints'], path).toContainEqual({
        sourceTag: 'scope:app',
        onlyDependOnLibsWithTags: ['scope:shared'],
      });
      expect(options['depConstraints'], path).toContainEqual({
        sourceTag: 'scope:shared',
        onlyDependOnLibsWithTags: ['scope:shared'],
      });
      expect(options['depConstraints'], path).toContainEqual({
        sourceTag: 'scope:infra',
        onlyDependOnLibsWithTags: ['scope:shared', 'scope:infra'],
      });
      expect(options['depConstraints'], path).not.toContainEqual(
        expect.objectContaining({ sourceTag: 'ring:application' }),
      );
    }
  });

  it('keeps generated product boundaries in production and every test override', async () => {
    for (const path of [
      'libs/wbs/application/core/src/index.ts',
      'libs/wbs/application/core/src/example.test.ts',
      'libs/wbs/application/core/src/testing/example.ts',
      'libs/wbs/adapters/store-memory/src/source.test.ts',
    ]) {
      const config: unknown = await lint.calculateConfigForFile(path);
      const boundary = boundaryOf(config);
      const options = boundary[1];
      if (!isRecord(options) || !Array.isArray(options['depConstraints'])) {
        throw new Error(`ESLint returned malformed boundary options for ${path}`);
      }
      expect(options['depConstraints'], path).toContainEqual({
        sourceTag: 'product:wbs',
        onlyDependOnLibsWithTags: ['product:wbs', 'product:shared'],
      });
    }
  });
});
