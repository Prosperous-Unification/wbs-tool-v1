import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'bun:test';

import { readDepthSensitiveConfigPaths } from '../workspace-inventory.mjs';

const WORKSPACE = new URL('../../../', import.meta.url);

async function failureMessageOf(reading: Promise<readonly unknown[]>): Promise<string> {
  try {
    await reading;
  } catch (failure) {
    if (failure instanceof Error) return failure.message;
    throw new Error('inventory rejected without an Error', { cause: failure });
  }
  throw new Error('inventory unexpectedly succeeded');
}

it('finds every parent-relative path in project and TypeScript configuration', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workspace-inventory-'));
  await Promise.all(
    ['apps/probe', 'libs', 'tools'].map((root) =>
      mkdir(join(workspace, root), { recursive: true }),
    ),
  );
  await writeFile(
    join(workspace, 'apps/probe/project.json'),
    JSON.stringify({
      name: 'probe',
      tags: ['scope:app', 'ring:adapter', 'runtime:bun'],
      targets: { test: {} },
      $schema: '../../node_modules/nx/schemas/project-schema.json',
    }),
  );
  await writeFile(
    join(workspace, 'apps/probe/tsconfig.json'),
    `{
      // JSONC is the TypeScript configuration boundary.
      "extends": "../../tsconfig.base.json",
      "compilerOptions": { "outDir": "../../dist/out-tsc" },
      "references": [{ "path": "./tsconfig.spec.json" }]
    }`,
  );

  expect(await readDepthSensitiveConfigPaths(workspace)).toEqual([
    {
      file: 'apps/probe/project.json',
      propertyPath: '$schema',
      value: '../../node_modules/nx/schemas/project-schema.json',
    },
    {
      file: 'apps/probe/tsconfig.json',
      propertyPath: 'compilerOptions.outDir',
      value: '../../dist/out-tsc',
    },
    {
      file: 'apps/probe/tsconfig.json',
      propertyPath: 'extends',
      value: '../../tsconfig.base.json',
    },
  ]);
});

it('refuses malformed depth-sensitive configuration by its workspace path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workspace-inventory-'));
  await Promise.all(
    ['apps/probe', 'libs', 'tools'].map((root) =>
      mkdir(join(workspace, root), { recursive: true }),
    ),
  );
  await writeFile(
    join(workspace, 'apps/probe/project.json'),
    JSON.stringify({
      name: 'probe',
      tags: ['scope:app', 'ring:adapter', 'runtime:bun'],
      targets: { test: {} },
    }),
  );
  await writeFile(join(workspace, 'apps/probe/tsconfig.json'), '{ "extends": "../../oops" ');

  expect(await failureMessageOf(readDepthSensitiveConfigPaths(workspace))).toStartWith(
    'cannot parse apps/probe/tsconfig.json:',
  );
});

it('pins the complete moved depth-sensitive configuration inventory', async () => {
  const paths = await readDepthSensitiveConfigPaths(WORKSPACE);

  // Proof: filtering out `compilerOptions.outDir` made this production-workspace
  // oracle fail with 111 instead of 148 rows and omitted the core outDir below
  // (2026-09-14).
  // Proof: adding libs/shared/domain/validation's three tsconfigs without
  // raising these numbers failed with `Received length: 152` rows, then
  // `Received length: 76` files (2026-09-15).
  // Proof: adding the `@shared/validation` path mapping to fe-01's four tsconfigs without
  // raising the row count failed with `Received length: 156` against the pinned 152; the file
  // count stayed at 76 because all four were already inventoried (2026-09-16).
  // Proof: leaving 156/76 here after tool-wiki became the app apps/wiki/cli failed with
  // `Received length: 162` rows, then `Received length: 80` files — this inventory reads apps
  // and libraries only, so the project's four configuration files entered it for the first time
  // with six parent-relative values between them (2026-09-16).
  expect(paths).toHaveLength(162);
  expect(new Set(paths.map(({ file }) => file))).toHaveLength(80);
  expect(paths).toContainEqual({
    file: 'apps/wbs/be-01/tsconfig.json',
    propertyPath: 'extends',
    value: '../../../tsconfig.base.json',
  });
  expect(paths).toContainEqual({
    file: 'libs/wbs/application/core/tsconfig.lib.json',
    propertyPath: 'compilerOptions.outDir',
    value: '../../../../dist/out-tsc',
  });
  expect(paths).toContainEqual({
    file: 'libs/wbs/adapters/solver-supervisor-protocol/tsconfig.lib.json',
    propertyPath: 'compilerOptions.outDir',
    value: '../../../../dist/out-tsc',
  });
  expect(paths).toContainEqual({
    file: 'apps/wbs/fe-01/tsconfig.e2e.json',
    propertyPath: 'compilerOptions.paths.@wbs/domain/workday.0',
    value: '../../../libs/wbs/domain/domain/src/workday.ts',
  });
  // Proof: pinning the pre-move `../../dist/tools/tool-wiki` here failed this oracle with the
  // moved project's actual three-deep outDir (2026-09-16).
  expect(paths).toContainEqual({
    file: 'apps/wiki/cli/tsconfig.lib.json',
    propertyPath: 'compilerOptions.outDir',
    value: '../../../dist/apps/wiki/cli',
  });
});

it('hashes every recursively discovered app and library TypeScript config', async () => {
  // Proof: after a 1/1 local cache hit, changing only
  // `libs/wbs/application/core/tsconfig.lib.json` made the owning target execute and fail with
  // 147 instead of 148 inventory rows (2026-09-14).
  const manifest = await Bun.file(new URL('../project.json', import.meta.url)).text();
  expect(manifest).toContain('"{workspaceRoot}/apps/**/tsconfig*.json"');
  expect(manifest).toContain('"{workspaceRoot}/libs/**/tsconfig*.json"');
});
