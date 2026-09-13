import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scratchAsync } from '@wbs/tool-test-scratch';
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
  if (!isRecord(targetDefaults)) {
    throw new Error('nx.json target defaults are absent');
  }
  const lint = targetDefaults['lint'];
  if (!isRecord(lint)) {
    throw new Error('nx.json lint default is absent');
  }
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
        paths: { '@wbs/domain': ['libs/domain/src/index.ts'] },
      },
    }),
    writeFile(join(workspace, '.prettierrc.json'), '{}\n'),
    writeFile(join(workspace, POLICY), await readFile(join(CHECKOUT, POLICY), 'utf8')),
  ]);
  await Promise.all([
    writeProject(
      workspace,
      'libs/config',
      'config',
      ['scope:shared', 'ring:adapter', 'runtime:bun', 'product:wbs'],
      true,
    ),
    writeProject(workspace, 'libs/domain', 'domain', [
      'scope:shared',
      'ring:domain',
      'runtime:isomorphic',
      'product:wbs',
    ]),
  ]);
  await Promise.all([
    writeFile(join(workspace, 'libs/config/src/index.ts'), "import '@wbs/domain';\n"),
    writeFile(join(workspace, 'libs/domain/src/index.ts'), 'export const domain = true;\n'),
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
  const lint = Bun.spawn(
    [
      process.execPath,
      join(workspace, 'node_modules/.bin/nx'),
      'lint',
      'config',
      '--output-style=stream',
    ],
    {
      cwd: workspace,
      env: environment,
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

async function runDirectLint(workspace: string): Promise<LintRun> {
  const lint = Bun.spawn(
    [
      process.execPath,
      join(workspace, 'node_modules/.bin/eslint'),
      'libs/config/src',
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
    // Proof: deleting the apps manifest glob failed this exact inventory with
    // that one entry absent when watched through the owning Nx target
    // (2026-09-13).
    expect(await productionLintInputs()).toEqual([
      'default',
      '{workspaceRoot}/eslint.config.js',
      '{workspaceRoot}/tools/tool-devsync/workspace-projects.mjs',
      '{workspaceRoot}/apps/**/project.json',
      '{workspaceRoot}/libs/**/project.json',
      '{workspaceRoot}/tools/**/project.json',
      '{workspaceRoot}/.prettierrc.json',
    ]);
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

    const denied = await runLint(workspace);
    // Proof: before the policy module became a global lint input, this third
    // production Nx invocation was a 1/1 cache hit and returned exit 0
    // despite the review-denied policy (2026-09-13).
    expect(denied.code, denied.output).not.toBe(0);
    const direct = await runDirectLint(workspace);
    expect(direct.code, direct.output).not.toBe(0);
    expect(direct.output).toContain('product:review-denied');
  }, 30_000);

  it('reruns cached lint when only a discovered project manifest changes', async () => {
    const workspace = await createLintWorkspace();
    await primeLint(workspace);
    await writeProject(workspace, 'libs/domain', 'domain', [
      'scope:shared',
      'ring:domain',
      'runtime:isomorphic',
      'product:review-denied',
    ]);
    await markChanged(join(workspace, 'libs/domain/project.json'));

    const denied = await runLint(workspace);
    // Proof: before recursive project manifests became global lint inputs,
    // this inventory-only change produced a 1/1 cache hit and exit 0 instead
    // of observing the cross-product refusal (2026-09-13).
    expect(denied.code, denied.output).not.toBe(0);
    const direct = await runDirectLint(workspace);
    expect(direct.code, direct.output).not.toBe(0);
    expect(direct.output).toContain('@nx/enforce-module-boundaries');
    expect(direct.output).toContain('product:wbs');
  }, 30_000);
});
