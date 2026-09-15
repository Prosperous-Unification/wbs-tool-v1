import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { createLintWorkspace, runLint } from './testing/lint-workspace';

describe('generated product lint constraints', () => {
  it('admits own/shared imports and rejects WBS from probe production and tests', async () => {
    const workspace = await createLintWorkspace();
    const control = await runLint(workspace, 'probe-app');
    expect(control.code, control.output).toBe(0);

    await writeFile(
      join(workspace, 'apps/probe/app/src/main.ts'),
      "import '@probe/own';\nimport '@shared/utility';\nimport '@wbs/core';\n",
    );
    const production = await runLint(workspace, 'probe-app');
    expect(production.code, production.output).not.toBe(0);

    await writeFile(
      join(workspace, 'apps/probe/app/src/main.ts'),
      "import '@probe/own';\nimport '@shared/utility';\n",
    );
    await writeFile(join(workspace, 'apps/probe/app/src/main.test.ts'), "import '@wbs/core';\n");
    const test = await runLint(workspace, 'probe-app');
    expect(test.code, test.output).not.toBe(0);
  }, 30_000);

  it('rejects WBS from the shared product', async () => {
    const workspace = await createLintWorkspace();
    const control = await runLint(workspace, 'shared-utility');
    expect(control.code, control.output).toBe(0);
    await writeFile(join(workspace, 'libs/shared/utility/src/index.ts'), "import '@wbs/core';\n");

    const shared = await runLint(workspace, 'shared-utility');
    expect(shared.code, shared.output).not.toBe(0);
  }, 30_000);

  it('refuses a product import from a product-less tool and admits shared', async () => {
    const workspace = await createLintWorkspace();
    const attempt = await runLint(workspace, 'probe-tool');
    // Proof: before the generated scope:infra rule existed, this uncached Nx lint accepted
    // the tool's `@wbs/core` import and exited 0, failing the assertion below on
    // `Expected: 1 · Received: 0` (2026-09-15).
    expect(attempt.code, attempt.output).toBe(1);
    expect(attempt.output, attempt.output).toContain('forbidden.ts');
    // Pin the diagnostic, not merely the failure: any other rule erroring on `forbidden.ts`
    // would otherwise keep this negative green with the generated rule gone.
    // Proof: narrowing the generated rule to `['scope:infra']` left the exit code 1 and
    // `forbidden.ts` assertions passing and failed only here, on the reported
    // `A project tagged with "scope:infra" can only depend on libs tagged with
    // "scope:infra"` (2026-09-15).
    expect(attempt.output, attempt.output).toContain(
      'can only depend on libs tagged with "scope:infra", "product:shared"',
    );
    expect(attempt.output, attempt.output).not.toContain('allowed.ts');
  }, 30_000);
});
