import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scratchAsync } from '@tools/test-scratch';

/** The repository root the fixtures borrow `node_modules` and the generated policy from. */
export const CHECKOUT = fileURLToPath(new URL('../../../..', import.meta.url));

const PROJECT_READER = pathToFileURL(
  join(CHECKOUT, 'tools/tool-devsync/workspace-projects.mjs'),
).href;

const POLICY_READER = pathToFileURL(join(CHECKOUT, 'tools/tool-devsync/product-policies.mjs')).href;

/** One real `nx lint` run: its exit code, its merged streams, and stderr on its own. */
export interface LintAttempt {
  readonly code: number;
  readonly output: string;
  readonly stderr: string;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

/**
 * Write a project manifest with a `lint` target that runs ESLint over its own source.
 *
 * @param workspace Fixture workspace root.
 * @param root Project root relative to the workspace; `apps/` prefixes become applications.
 * @param name Nx project name, the argument `runLint` takes.
 * @param tags The project's tags, which is what the boundary rules read.
 */
export async function writeProject(
  workspace: string,
  root: string,
  name: string,
  tags: readonly string[],
): Promise<void> {
  await mkdir(join(workspace, root, 'src'), { recursive: true });
  await writeJson(join(workspace, root, 'project.json'), {
    name,
    sourceRoot: `${root}/src`,
    projectType: root.startsWith('apps/') ? 'application' : 'library',
    tags,
    targets: {
      lint: {
        executor: 'nx:run-commands',
        options: { command: `bunx eslint ${root}/src --no-cache` },
      },
    },
  });
}

/**
 * A scratch Nx workspace whose flat config carries the generated product constraints and
 * calls the production discovery function.
 *
 * The fixture imports `readProductPolicies` out of the checkout rather than copying it, so a
 * discovery negative run here exercises the same code the root config runs. The fixture's
 * `shared` argument is empty because the policies a test writes assert discovery itself, not
 * the shared constants.
 */
export async function createLintWorkspace(): Promise<string> {
  const workspace = await scratchAsync('repo-namespacing-product-');
  await Promise.all(
    ['apps', 'libs', 'tools'].map((group) => mkdir(join(workspace, group), { recursive: true })),
  );
  await symlink(join(CHECKOUT, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  await Promise.all([
    writeJson(join(workspace, 'package.json'), { name: 'product-fixture', private: true }),
    writeJson(join(workspace, 'nx.json'), { targetDefaults: { lint: { cache: false } } }),
    writeJson(join(workspace, 'tsconfig.base.json'), {
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@probe/own': ['libs/probe/own/src/index.ts'],
          '@shared/utility': ['libs/shared/utility/src/index.ts'],
          '@wbs/core': ['libs/wbs/core/src/index.ts'],
        },
      },
    }),
  ]);
  await Promise.all([
    writeProject(workspace, 'apps/probe/app', 'probe-app', [
      'scope:app',
      'ring:adapter',
      'runtime:bun',
      'product:probe',
    ]),
    writeProject(workspace, 'libs/probe/own', 'probe-own', [
      'scope:shared',
      'ring:domain',
      'runtime:isomorphic',
      'product:probe',
    ]),
    writeProject(workspace, 'libs/shared/utility', 'shared-utility', [
      'scope:shared',
      'ring:domain',
      'runtime:isomorphic',
      'product:shared',
    ]),
    writeProject(workspace, 'libs/wbs/core', 'wbs-core', [
      'scope:shared',
      'ring:domain',
      'runtime:isomorphic',
      'product:wbs',
    ]),
    writeProject(workspace, 'tools/probe-tool', 'probe-tool', [
      'scope:infra',
      'type:scripts',
      'runtime:bun',
      'ring:adapter',
    ]),
  ]);
  await Promise.all([
    writeFile(
      join(workspace, 'apps/probe/app/src/main.ts'),
      "import '@probe/own';\nimport '@shared/utility';\n",
    ),
    writeFile(join(workspace, 'libs/probe/own/src/index.ts'), 'export const own = true;\n'),
    writeFile(join(workspace, 'libs/shared/utility/src/index.ts'), 'export const shared = true;\n'),
    writeFile(join(workspace, 'libs/wbs/core/src/index.ts'), 'export const wbs = true;\n'),
    writeFile(
      join(workspace, 'tools/probe-tool/src/forbidden.ts'),
      "import { wbs } from '@wbs/core';\nexport const tool = wbs;\n",
    ),
    writeFile(
      join(workspace, 'tools/probe-tool/src/allowed.ts'),
      "import { shared } from '@shared/utility';\nexport const tool = shared;\n",
    ),
    writeFile(
      join(workspace, 'eslint.config.mjs'),
      `
        import nx from '@nx/eslint-plugin';
        import { productConstraints, readProjects } from '${PROJECT_READER}';
        import { readProductPolicies } from '${POLICY_READER}';
        const products = productConstraints(await readProjects(import.meta.dirname));
        const productPolicies = await readProductPolicies(import.meta.dirname, {
          browserAdapterConstraint: [],
          productRules: [],
          runtimeConstraints: [],
          scopeConstraints: [],
          testSourceFiles: [],
        });
        export default [{
          files: ['**/*.ts'],
          plugins: { '@nx': nx },
          rules: {
            '@nx/enforce-module-boundaries': ['error', {
              enforceBuildableLibDependency: false,
              allow: [],
              depConstraints: [
                {
                  sourceTag: 'ring:domain',
                  onlyDependOnLibsWithTags: ['ring:domain'],
                },
                {
                  sourceTag: 'ring:adapter',
                  onlyDependOnLibsWithTags: ['ring:domain', 'ring:adapter'],
                },
                {
                  sourceTag: 'scope:app',
                  onlyDependOnLibsWithTags: ['scope:shared'],
                },
                {
                  sourceTag: 'scope:shared',
                  onlyDependOnLibsWithTags: ['scope:shared'],
                },
                ...products,
              ],
            }],
          },
        }, ...productPolicies];
      `,
    ),
  ]);
  return workspace;
}

/**
 * {@link createLintWorkspace} with `probe-app` reduced to a source file that imports
 * nothing, so the only diagnostic a discovery test can observe is the one a product policy
 * it writes into `apps/probe/eslint.product.mjs` produces.
 */
export async function createPolicyWorkspace(): Promise<string> {
  const workspace = await createLintWorkspace();
  await writeProject(workspace, 'apps/probe/app', 'probe-app', [
    'scope:app',
    'type:app',
    'runtime:bun',
    'ring:adapter',
    'product:probe',
  ]);
  await writeFile(join(workspace, 'apps/probe/app/src/main.ts'), 'export const app = true;\n');
  return workspace;
}

/** Run `nx lint <project>` in a fixture workspace with the cache and the daemon off. */
export async function runLint(workspace: string, project: string): Promise<LintAttempt> {
  const nxCli = fileURLToPath(import.meta.resolve('nx/bin/nx.js'));
  const lint = Bun.spawn(
    [process.execPath, nxCli, 'lint', project, '--skip-nx-cache', '--output-style=stream'],
    {
      cwd: workspace,
      env: { ...process.env, NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(lint.stdout).text(),
    new Response(lint.stderr).text(),
    lint.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}`, stderr };
}
