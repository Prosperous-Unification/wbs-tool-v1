import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

import { createPolicyWorkspace, runLint } from './testing/lint-workspace';

const workspace = fileURLToPath(new URL('../../..', import.meta.url));
const lint = new ESLint({ cwd: workspace });

/**
 * The only entries the root config's `allow` list may name, sorted. A bare `allow` entry is an
 * unanchored regular expression, so each is anchored and excuses its exact specifier alone. They
 * are WBS host tooling misfiled under `tools/`, and the exception dies with the relocation that
 * moves them: the case below fails once an entry stops being imported.
 */
const PENDING_INFRA_TO_PRODUCT_ALIASES = [
  '^@wbs/contracts/solver/supervisor-protocol$',
  '^@wbs/domain$',
] as const;

/** The specifier an anchored `allow` entry excuses, which is what the sources are scanned for. */
function specifierOf(entry: string): string {
  return entry.replace(/^\^/, '').replace(/\$$/, '');
}

async function ruleIds(path: string, source: string): Promise<readonly (string | null)[]> {
  const [report] = await lint.lintText(source, { filePath: path });
  return report.messages.map((message) => message.ruleId);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `source` ends an import statement on `alias`. Matched on a whole line rather than
 * anywhere in the file, and never on a comment line, so that prose naming an alias — the Proof
 * below included — cannot keep a dead `allow` entry alive. The last line is what is tested
 * because the repository's imports of these aliases are multi-line.
 */
function importsAlias(source: string, alias: string): boolean {
  return source
    .split('\n')
    .some((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && line.endsWith(`from '${alias}';`));
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
    // tracked frontend test failed fe-01:lint with the combined-tag message,
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
    // production then failed the uncached domain lint target with “A project
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
    // Proof: a temporary core test passed both core:lint and Bun (1 pass), then
    // its adjacent production sibling failed core:lint at the `bun:test`
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
    // `@tools/compose` from config's tracked `define-config.test.ts` then
    // failed the uncached config lint target with “A project tagged with
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
      // The sole `scope:infra` rule is the generated one, at the production `nxRules` site
      // and in every test override alike: a product-less tool reaches infra and the shared
      // product, never another product's `scope:shared` library.
      // Proof: restoring the old `{ sourceTag: 'scope:infra', onlyDependOnLibsWithTags:
      // ['scope:shared', 'scope:infra'] }` entry in `scopeConstraints` failed this case on
      // `libs/wbs/application/core/src/index.ts` with `Expected - 0 · Received + 7`, the
      // second infra entry. While this check sat in the test-override case above, that
      // production path went unchecked and the duplicate passed (2026-09-15).
      expect(
        options['depConstraints'].filter(
          (constraint: unknown) =>
            isRecord(constraint) && constraint['sourceTag'] === 'scope:infra',
        ),
        path,
      ).toEqual([
        { sourceTag: 'scope:infra', onlyDependOnLibsWithTags: ['scope:infra', 'product:shared'] },
      ]);
    }
  });

  it('names exactly the two pending infra-to-product exceptions and each is still used', async () => {
    // Production and test alike: the generic test override carries its own `allow: []`, so the
    // tools block only reaches the supervisor tests while it follows that override.
    for (const path of [
      'tools/tool-remote-scripts/src/lib/docker.ts',
      'tools/tool-remote-scripts/src/lib/solver-supervisor-channel.test.ts',
    ]) {
      const config: unknown = await lint.calculateConfigForFile(join(workspace, path));
      const options = boundaryOf(config)[1];
      if (!isRecord(options) || !Array.isArray(options['allow'])) {
        throw new Error(`ESLint returned malformed boundary options for ${path}`);
      }
      const named = options['allow'].filter(
        (entry: unknown): entry is string => typeof entry === 'string',
      );
      // Proof: with the tools block's `allow` emptied, this case failed on
      // `Expected - 4 · Received + 1` — the two aliases against `[]`. Moving the block above the
      // generic test override left the `.test.ts` path with `[]` for the same failure
      // (2026-09-15).
      expect([...named].sort(), path).toEqual([...PENDING_INFRA_TO_PRODUCT_ALIASES]);
    }

    const tools = join(workspace, 'tools');
    const sources = await Promise.all(
      (await readdir(tools, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
    );
    for (const entry of PENDING_INFRA_TO_PRODUCT_ALIASES) {
      const alias = specifierOf(entry);
      // Proof: an allow entry nobody imports is dead policy. Repointing the two tools/dev
      // corpus writers at a nonexistent alias failed this case by name —
      // `error: @wbs/domain · Expected: true · Received: false` (2026-09-15).
      expect(
        sources.some((source) => importsAlias(source, alias)),
        alias,
      ).toBe(true);
    }
  }, 30_000);

  it('excuses the named specifier alone and refuses its subpaths', async () => {
    // A bare `allow` entry is matched as an unanchored regular expression, so `@wbs/domain`
    // would excuse `@wbs/domain/workday` and every other subpath of it as well.
    // Proof: with the two entries in `eslint.config.js` spelled bare, the subpath import below
    // produced no boundary diagnostic and this case failed on `Expected to contain:
    // "@nx/enforce-module-boundaries" · Received: [ "@typescript-eslint/no-unused-vars",
    // "unused-imports/no-unused-imports" ]` (2026-09-16).
    const path = 'tools/tool-smoke/src/color.ts';
    expect(await ruleIds(path, "import { workday } from '@wbs/domain/workday';")).toContain(
      '@nx/enforce-module-boundaries',
    );
    expect(await ruleIds(path, "import { x } from '@wbs/domain';")).not.toContain(
      '@nx/enforce-module-boundaries',
    );
  }, 30_000);
});

describe('product lint policy discovery', () => {
  it('applies apps/<product>/eslint.product.mjs and refuses an unreadable one', async () => {
    const fixture = await createPolicyWorkspace();
    await writeFile(
      join(fixture, 'apps/probe/eslint.product.mjs'),
      "export default () => [{ files: ['apps/probe/**/*.ts'], rules: { 'no-restricted-imports': ['error', { paths: ['left-pad'] }] } }];\n",
    );
    await writeFile(join(fixture, 'apps/probe/app/src/main.ts'), "import 'left-pad';\n");
    const applied = await runLint(fixture, 'probe-app');
    // Proof: with `...productPolicies` dropped from the fixture's flat config — the state
    // before discovery existed — this uncached Nx lint exited 0 and failed here on
    // `Expected: 1 · Received: 0` (2026-09-15). The fixture calls the production
    // `readProductPolicies`, so every negative below runs the code the root config runs.
    expect(applied.code, applied.output).toBe(1);

    // Absent is the normal case, and the only failure discovery is allowed to pass over.
    await rm(join(fixture, 'apps/probe/eslint.product.mjs'));
    const absent = await runLint(fixture, 'probe-app');
    expect(absent.code, absent.output).toBe(0);

    await writeFile(join(fixture, 'apps/probe/eslint.product.mjs'), 'export default () => [];\n');
    await chmod(join(fixture, 'apps/probe/eslint.product.mjs'), 0o000);
    const unreadable = await runLint(fixture, 'probe-app');
    // Proof: replacing the rethrow in `product-policies.mjs` with an unconditional `continue` —
    // swallowing every import failure — made this same unreadable policy exit 0, failing on
    // `Expected: not 0 · Received: 0` (2026-09-15). Nx prefixes the child's streams onto its
    // own stdout, so the diagnostic is read from the merged output rather than from stderr.
    expect(unreadable.code, unreadable.output).not.toBe(0);
    // Pin the diagnostic, not merely the failure: any other way of breaking this lint would
    // otherwise keep the negative green with the rethrow gone.
    expect(unreadable.output, unreadable.output).toContain('cannot load product lint policy');
    expect(unreadable.output, unreadable.output).toContain('apps/probe/eslint.product.mjs');
  }, 90_000);

  it('refuses a policy that is not a function and one that returns no array', async () => {
    const fixture = await createPolicyWorkspace();
    const policy = join(fixture, 'apps/probe/eslint.product.mjs');

    // The shape W6's `apps/wiki/eslint.product.mjs` must not ship: the array a reader would
    // reach for first, which the root config cannot hand the shared constants to.
    await writeFile(policy, 'export default [];\n');
    const notAFunction = await runLint(fixture, 'probe-app');
    // Proof: with the `typeof loaded.default !== 'function'` check removed from
    // `product-policies.mjs`, this lint still failed but on `TypeError: loaded.default is not a
    // function`, so the `must default-export a function` assertion below failed instead
    // (2026-09-15).
    expect(notAFunction.code, notAFunction.output).not.toBe(0);
    expect(notAFunction.output, notAFunction.output).toContain(
      'must default-export a function of the shared constants',
    );
    expect(notAFunction.output, notAFunction.output).toContain('apps/probe/eslint.product.mjs');

    await writeFile(policy, 'export default () => ({ files: [] });\n');
    const notAnArray = await runLint(fixture, 'probe-app');
    // Proof: with the `Array.isArray(configs)` check removed from `product-policies.mjs`, this
    // lint failed on a raw `Spread syntax requires ...iterable[Symbol.iterator] to be a function`
    // instead, naming neither the contract nor the file, so both assertions below failed
    // (2026-09-15).
    expect(notAnArray.code, notAnArray.output).not.toBe(0);
    expect(notAnArray.output, notAnArray.output).toContain(
      'must return an array of flat-config objects',
    );
    expect(notAnArray.output, notAnArray.output).toContain('apps/probe/eslint.product.mjs');
  }, 90_000);

  it('refuses a policy whose function throws', async () => {
    const fixture = await createPolicyWorkspace();
    await writeFile(
      join(fixture, 'apps/probe/eslint.product.mjs'),
      "export default () => {\n  throw new Error('probe policy refuses to compose');\n};\n",
    );
    const throwing = await runLint(fixture, 'probe-app');
    // Proof: with `loaded.default(shared)` left unwrapped in `product-policies.mjs`, this lint
    // failed on the policy's own bare `Error: probe policy refuses to compose`, naming the file
    // only in a stack frame, so the assertion below failed on `Expected to contain: "cannot
    // evaluate product lint policy"` (2026-09-16).
    expect(throwing.code, throwing.output).not.toBe(0);
    expect(throwing.output, throwing.output).toContain('cannot evaluate product lint policy');
    expect(throwing.output, throwing.output).toContain('apps/probe/eslint.product.mjs');
  }, 90_000);

  it('refuses a policy whose own imports do not resolve', async () => {
    const fixture = await createPolicyWorkspace();
    await writeFile(
      join(fixture, 'apps/probe/eslint.product.mjs'),
      "import plugin from 'this-package-does-not-exist';\nexport default () => [plugin];\n",
    );
    const unresolved = await runLint(fixture, 'probe-app');
    // A present policy that names six plugin packages must not read as absent because one of
    // them is missing: absence is decided on the file, before the import.
    // Proof: with absence decided by `failure?.code === 'ERR_MODULE_NOT_FOUND'` from the import
    // instead of by `stat`, this lint exited 0 with every fence silently discarded, failing on
    // `Expected: not 0 · Received: 0` (2026-09-15).
    expect(unresolved.code, unresolved.output).not.toBe(0);
    expect(unresolved.output, unresolved.output).toContain('cannot load product lint policy');
    expect(unresolved.output, unresolved.output).toContain('apps/probe/eslint.product.mjs');
  }, 90_000);
});
