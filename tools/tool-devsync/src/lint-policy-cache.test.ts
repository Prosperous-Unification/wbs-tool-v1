import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchAsync } from '@tools/test-scratch';
import { describe, expect, it } from 'bun:test';

const CHECKOUT = fileURLToPath(new URL('../../..', import.meta.url));
const POLICY = 'tools/tool-devsync/workspace-projects.mjs';

interface LintRun {
  readonly code: number;
  readonly output: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

async function writeProject(
  workspace: string,
  root: string,
  name: string,
  tags: readonly string[],
  hasLint = false,
): Promise<void> {
  await mkdir(join(workspace, root, 'src'), { recursive: true });
  await writeJson(join(workspace, root, 'project.json'), {
    name,
    sourceRoot: `${root}/src`,
    projectType: root.startsWith('apps/') ? 'application' : 'library',
    tags,
    targets: hasLint
      ? {
          lint: {
            executor: 'nx:run-commands',
            options: { command: `bunx eslint ${root}/src --no-cache` },
          },
        }
      : { typecheck: { executor: 'nx:run-commands', options: { command: 'bun --version' } } },
  });
}

async function productionLintInputs(): Promise<readonly unknown[]> {
  const parsed: unknown = JSON.parse(await readFile(join(CHECKOUT, 'nx.json'), 'utf8'));
  if (!isRecord(parsed)) throw new Error('nx.json is not an object');
  const targetDefaults = parsed['targetDefaults'];
  if (!isRecord(targetDefaults)) throw new Error('nx.json target defaults are absent');
  const lint = targetDefaults['lint'];
  if (!isRecord(lint)) throw new Error('nx.json lint default is absent');
  const inputs = lint['inputs'];
  if (!Array.isArray(inputs)) throw new Error('nx.json lint inputs are absent');
  return inputs.map((input: unknown): unknown => input);
}

async function createLintWorkspace(): Promise<string> {
  const workspace = await scratchAsync('repo-namespacing-lint-cache-');
  await Promise.all(
    ['apps', 'libs', 'tools/tool-devsync'].map((root) =>
      mkdir(join(workspace, root), { recursive: true }),
    ),
  );
  await symlink(join(CHECKOUT, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  await Promise.all([
    writeJson(join(workspace, 'package.json'), { name: 'lint-policy-cache', private: true }),
    writeJson(join(workspace, 'nx.json'), {
      targetDefaults: { lint: { cache: true, inputs: await productionLintInputs() } },
      plugins: [],
    }),
    writeJson(join(workspace, 'tsconfig.base.json'), {
      compilerOptions: {
        baseUrl: '.',
        paths: { '@wbs/domain': ['libs/wbs/domain/domain/src/index.ts'] },
      },
    }),
    writeFile(join(workspace, '.prettierrc.json'), '{}\n'),
    writeFile(join(workspace, POLICY), await readFile(join(CHECKOUT, POLICY), 'utf8')),
  ]);
  await Promise.all([
    writeProject(
      workspace,
      'libs/wbs/adapters/config',
      'config',
      ['scope:shared', 'ring:adapter', 'runtime:bun', 'product:wbs'],
      true,
    ),
    writeProject(workspace, 'libs/wbs/domain/domain', 'domain', [
      'scope:shared',
      'ring:domain',
      'runtime:isomorphic',
      'product:wbs',
    ]),
  ]);
  await Promise.all([
    writeFile(join(workspace, 'libs/wbs/adapters/config/src/index.ts'), "import '@wbs/domain';\n"),
    writeFile(
      join(workspace, 'libs/wbs/domain/domain/src/index.ts'),
      'export const domain = true;\n',
    ),
    writeFile(
      join(workspace, 'eslint.config.js'),
      `
        import nx from '@nx/eslint-plugin';
        import { productConstraints, readProjects } from './${POLICY}';
        const products = productConstraints(await readProjects(import.meta.dirname));
        export default [{
          files: ['**/*.ts'],
          plugins: { '@nx': nx },
          rules: {
            '@nx/enforce-module-boundaries': ['error', {
              enforceBuildableLibDependency: false,
              allow: [],
              depConstraints: products,
            }],
          },
        }];
      `,
    ),
  ]);
  return workspace;
}

async function runLint(workspace: string): Promise<LintRun> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    NX_DAEMON: 'false',
    NX_ISOLATE_PLUGINS: 'false',
  };
  delete environment['NX_SKIP_NX_CACHE'];
  delete environment['NX_DISABLE_NX_CACHE'];
  const nxCli = fileURLToPath(import.meta.resolve('nx/bin/nx.js'));
  const lint = Bun.spawn([process.execPath, nxCli, 'lint', 'config', '--output-style=stream'], {
    cwd: workspace,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(lint.stdout).text(),
    new Response(lint.stderr).text(),
    lint.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

async function runDirectLint(workspace: string): Promise<LintRun> {
  const lint = Bun.spawn(
    [
      process.execPath,
      join(workspace, 'node_modules/.bin/eslint'),
      'libs/wbs/adapters/config/src',
      '--no-cache',
    ],
    {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(lint.stdout).text(),
    new Response(lint.stderr).text(),
    lint.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

async function primeLint(workspace: string): Promise<void> {
  const initial = await runLint(workspace);
  expect(initial.code, initial.output).toBe(0);
  const cached = await runLint(workspace);
  expect(cached.code, cached.output).toBe(0);
  expect(cached.output).toContain('existing outputs match the cache');
}

async function markChanged(path: string): Promise<void> {
  const changedAt = new Date(Date.now() + 2_000);
  await utimes(path, changedAt, changedAt);
}

describe('production lint policy cache inputs', () => {
  it('declares every transitive workspace input read by the generated policy', async () => {
    // Proof: before the generated-policy and manifest globs were declared, this
    // exact inventory reported all four inputs absent (2026-09-14).
    expect(await productionLintInputs()).toEqual([
      'default',
      '{workspaceRoot}/eslint.config.js',
      '{workspaceRoot}/tools/tool-devsync/product-policies.mjs',
      '{workspaceRoot}/tools/tool-devsync/workspace-projects.mjs',
      '{workspaceRoot}/apps/*/eslint.product.mjs',
      '{workspaceRoot}/libs/*/eslint.product.mjs',
      '{workspaceRoot}/apps/**/project.json',
      '{workspaceRoot}/libs/**/project.json',
      '{workspaceRoot}/tools/**/project.json',
      '{workspaceRoot}/.prettierrc.json',
    ]);
  });

  it('declares the discovery module and both product lint policy globs', async () => {
    // A product policy the root config discovers, and the module that discovers it, are read
    // at every lint, so a lint cached before either changed is a lint run against a fence that
    // no longer exists.
    // Proof: with the two globs removed from nx.json, this case failed on the absent
    // `{workspaceRoot}/apps/*/eslint.product.mjs`, and `wbs-be-01:lint` reported
    // `[existing outputs match the cache]` after `apps/wbs/eslint.product.mjs` changed.
    // Proof: with the discovery module entry removed, this case failed on the absent
    // `{workspaceRoot}/tools/tool-devsync/product-policies.mjs` (2026-09-15).
    const inputs = await productionLintInputs();
    expect(inputs).toContain('{workspaceRoot}/apps/*/eslint.product.mjs');
    expect(inputs).toContain('{workspaceRoot}/libs/*/eslint.product.mjs');
    expect(inputs).toContain('{workspaceRoot}/tools/tool-devsync/product-policies.mjs');
  });

  it('reruns cached lint when only the generated policy module changes', async () => {
    const workspace = await createLintWorkspace();
    await primeLint(workspace);
    const path = join(workspace, POLICY);
    const policy = await readFile(path, 'utf8');
    const changed = policy.replace(
      "product === 'shared' ? ['product:shared'] : [`product:${product}`, 'product:shared']",
      "['product:review-denied']",
    );
    expect(changed).not.toBe(policy);
    await writeFile(path, changed);
    await markChanged(path);

    // Proof: before POLICY was a lint input, this third real Nx run reused 1/1
    // cached task and exited 0 after the policy denied every product (2026-09-14).
    const denied = await runLint(workspace);
    expect(denied.code, denied.output).not.toBe(0);
    const direct = await runDirectLint(workspace);
    expect(direct.code, direct.output).not.toBe(0);
    expect(direct.output).toContain('product:review-denied');
  }, 30_000);

  it('reruns cached lint when only a discovered project manifest changes', async () => {
    const workspace = await createLintWorkspace();
    await primeLint(workspace);
    await writeProject(workspace, 'libs/wbs/domain/domain', 'domain', [
      'scope:shared',
      'ring:domain',
      'runtime:isomorphic',
      'product:review-denied',
    ]);
    await markChanged(join(workspace, 'libs/wbs/domain/domain/project.json'));

    // Proof: before project manifests were lint inputs, this third real Nx run
    // reused 1/1 cached task and exited 0 after the target tag changed (2026-09-14).
    const denied = await runLint(workspace);
    expect(denied.code, denied.output).not.toBe(0);
    const direct = await runDirectLint(workspace);
    expect(direct.code, direct.output).not.toBe(0);
    expect(direct.output).toContain('@nx/enforce-module-boundaries');
    expect(direct.output).toContain('product:wbs');
  }, 30_000);
});
