# Agentic Scalability Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Workstreams W2, W3, W5 and W7 change observable behavior and each opens its own OpenSpec change (`opsx:new`) whose `tasks.md` is derived from the tasks below; W1, W4 and W6 are refactors, docs and spec-restoring fixes and need none. W1, W6 and W7 are written for a medium-effort worker: every step names its file, command, expected output and commit.

**Goal:** After PR #457, make the repository accept a second product and more concurrent agents without hand-edited lists, without a lottery lock, and without a full gate per PR.

**Architecture:** Seven workstreams on `main` (ff0b0353), each its own branch and PR, each gated with `bin/h2puni-gate.sh <sha>`. W1 removes the product couplings the review found. W2 replaces the mkdir lottery with a FIFO ticket queue. W3 splits CI into an affected-only PR gate and a full merge-queue gate. W4 records that lanes are Claire's first-version SDLC enabler, not a repository contract. W5 gives a repository move a documented, tooled path through the trusted Tool Wiki activation. W6 makes the wiki the second product (`apps/wiki/cli`, `product:wiki`, product-neutral names). W7 releases it as a tagged archive other repositories consume.

**Tech Stack:** Bun, Nx 21 (`nx:run-commands`, tags, `@nx/enforce-module-boundaries`), ESLint flat config, bash + shellcheck, GitHub Actions (`pull_request`, `merge_group`), tool-wiki (ArkType records, sha256 identities).

**Spec:** the review and sweep in the session scratchpad (`agentic-scalability-report.md`) and, for the standing rules, `AGENTS.md` R1–R5. Findings referenced by number below are the "Design findings" and "Readiness sweep" items of that report.

## Global Constraints

- Bun and Nx only; never npm/pnpm/yarn.
- Every new or changed safety check ships a production-path negative watched failing with the check removed, plus an adjacent `Proof:` comment naming the fault and the observed test (R5).
- Missing, unreadable or malformed trusted state throws; never default it.
- Deployment identities (`APP_NAME`, `IMAGE_NAME`, ports, container names, `be-01.internal`) do not change in any workstream.
- Before claiming a workstream done: `bin/h2puni-gate.sh <exact sha>` under the canonical lock, and `git diff --check`.
- Merge is Dany's call; branches are kept synced with `main` but never merged by a worker.
- Plans and evidence go in the OpenSpec change (`verify.md`) for W2, W3, W5; W1 and W4 record evidence in the PR body.

## Sequencing

| Order | Workstream                                  | Branch                                 | Touches                                                                                                                         | Depends on                                                                    |
| ----- | ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1     | W1 second-product findings                  | `change/second-product-readiness`      | eslint.config.js, tools/tool-devsync, libs/shared, tools/tool-wiki imports, project.json files, docs/adr                        | nothing                                                                       |
| 2     | W4 lanes are Claire's v1 enabler            | `docs/lanes-are-claire-v1`             | LLM_README.md, HUMAN_README.md, docs/2026-08-30-agent-loop-audit.md, bin/h2puni-gate-lib.sh comments                            | nothing; can run beside W1                                                    |
| 3     | W2 FIFO heavy lock                          | `change/fifo-heavy-lock`               | bin/heavy-lock-lib.sh, bin/heavy-lock.test.sh, bin/with-heavy-lock.sh, bin/h2puni-gate.sh                                       | nothing; can run beside W1                                                    |
| 4     | W5 trusted-activation relocation            | `change/trusted-activation-relocation` | tools/tool-wiki/src/policy, docs/runbook-tool-wiki-activation.md, bin/tool-wiki-lint.sh                                         | nothing; can run beside W1                                                    |
| 5     | W3 affected PR gate + merge-queue full gate | `change/affected-pr-gate`              | .github/workflows/ci.yml, tools/tool-git-hooks/src/hooks/pixels-workflow.test.ts, tools/tool-devsync/src/toolchain-pins.test.ts | W1 (the CI paths it pins move), plus Dany enabling the merge queue ruleset    |
| 6     | W6 wiki becomes `product:wiki`              | `change/wiki-product-namespace`        | tools/tool-wiki → apps/wiki/cli, docs/wiki-policy, root gate selectors, module READMEs                                          | W1 (shared validation, product lint discovery) and W5 (relocation activation) |
| 7     | W7 wiki release for other repos             | `change/wiki-release`                  | .github/workflows/trusted-wiki.yml, ci.yml, apps/wiki/cli release target, consumer template                                     | W6                                                                            |

W1 lands first because W3's tests pin CI literals that W1 relocates and W6 needs its shared validation library and product lint discovery. W2, W4 and W5 touch disjoint files and can run as parallel lanes beside W1. W6 waits for W1 and W5; W7 waits for W6. Order for Dany's stated priority (W1 then wiki): W1 → W5 → W6 → W7, with W2 and W4 in parallel lanes and W3 last.

---

## W1 — Second-product readiness (findings 1–6 of the review)

Branch `change/second-product-readiness` from `main`. One PR. Tasks run in the order given; 1.2, 1.3 and 1.5 form one red-to-green sequence and are pushed together.

How to run things in this repo (read once):

- `bunx nx test tool-devsync --skip-nx-cache` runs every `tools/tool-devsync/src/*.test.ts` (about 30 s). Add `-- --test-name-pattern '<substring>'` after the command to run one test.
- `bunx nx run-many -t lint --skip-nx-cache` lints every project with the root `eslint.config.js` (about 6 min). `bunx nx run <project>:lint --skip-nx-cache` lints one project.
- `bunx nx run <project>:typecheck` typechecks one project.
- A "Proof:" comment is required next to every new check. Write it after you have watched the test fail, and copy the exact failing expectation text into it with today's date.
- Never use `--no-verify`. Never `git add -A`; add the files you changed by name.

### Task 1.1: Qualify ESLint cache locations by Nx project name

**Files:**

- Modify: the 16 manifests listed below (each has `--cache-location .nx/eslintcache-<suffix>` where `<suffix>` is not the project name)
- Test: `tools/tool-devsync/src/workspace-targets.test.ts` (append one test at the end of the file)

The 16 manifests and their new suffix (`<project name>`):

```
apps/wbs/be-01/project.json                    wbs-be-01
apps/wbs/fe-01/project.json                    wbs-fe-01
apps/wbs/gw-01/project.json                    wbs-gw-01
apps/wbs/mcp-01/project.json                   wbs-mcp-01
libs/wbs/domain/validation/project.json        wbs-validation
libs/wbs/domain/contracts/project.json         wbs-contracts
libs/wbs/domain/domain/project.json            wbs-domain
libs/wbs/application/conformance/project.json  wbs-conformance
libs/wbs/application/core/project.json         wbs-core
libs/wbs/adapters/config/project.json          wbs-config
libs/wbs/adapters/auth/project.json            wbs-auth
libs/wbs/adapters/realtime/project.json        wbs-realtime
libs/wbs/adapters/runtime-portable/project.json wbs-runtime-portable
libs/wbs/adapters/store-sqlite/project.json    wbs-store-sqlite
libs/wbs/adapters/store-memory/project.json    wbs-store-memory
libs/wbs/adapters/observability/project.json   wbs-observability
```

Every `tools/*` manifest already uses its project name (`eslintcache-tool-wiki`, `eslintcache-tool-dev-setup`, …); leave them.

- [ ] **Step 1: Append the failing test** to `tools/tool-devsync/src/workspace-targets.test.ts`. `readProjects` and `WORKSPACE` are already imported/defined at the top of that file.

```ts
test('every lint:fast cache location is qualified by the Nx project name', async () => {
  const unqualified = (await readProjects(WORKSPACE)).flatMap((project) => {
    const options = project.targets['lint:fast']?.options;
    const command = options?.command;
    if (typeof command !== 'string') return [];
    const expected = `--cache-location .nx/eslintcache-${project.name}`;
    return command.includes(expected) ? [] : [`${project.root}: ${command}`];
  });
  // Proof: <paste the 16 manifests this listed before the rename, with the date>. A second
  // product's be-01 would otherwise share `.nx/eslintcache-be-01` with WBS.
  expect(unqualified).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail.** `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'cache location'`. Expected: 1 fail, the diff lists 16 `apps/…`/`libs/…` roots. Copy that list into the Proof comment.
- [ ] **Step 3: Rewrite the 16 manifests.** For each row above run, from the repo root:

```bash
sed -i 's#\.nx/eslintcache-be-01#.nx/eslintcache-wbs-be-01#' apps/wbs/be-01/project.json
```

with the right suffix per row (the table's second column is the new suffix; the old suffix is the same string without `wbs-`).

- [ ] **Step 4: Run** the test again: 1 pass. Then `bunx nx run wbs-be-01:lint:fast` and `ls .nx/ | grep eslintcache-wbs-be-01` prints the new cache file.
- [ ] **Step 5: Commit.**

```bash
git add tools/tool-devsync/src/workspace-targets.test.ts apps/wbs/*/project.json libs/wbs/*/*/project.json
git commit -m "refactor(nx): qualify eslint cache locations by project name"
```

### Task 1.2: A product-less project may depend only on infra and shared

Today `scopeConstraints` in `eslint.config.js:41-45` lets `scope:infra` depend on `scope:shared`, and every product library is `scope:shared`, so tools may import any product code. Tools carry no `product:` tag, so `productConstraints` never applies to them.

**Files:**

- Modify: `tools/tool-devsync/workspace-projects.mjs` function `productConstraints` (it currently returns `[...products].sort().map(...)`)
- Modify: `eslint.config.js:41-45` (`scopeConstraints`)
- Test: `tools/tool-devsync/src/product-constraints.test.ts`

**Interfaces:**

- Produces: `productConstraints(projects)` returns, after the per-product rules, one extra rule `{ sourceTag: 'scope:infra', onlyDependOnLibsWithTags: ['scope:infra', 'product:shared'] }`. Task 1.5 relies on it existing exactly once.

- [ ] **Step 1: Extend the fixture workspace.** In `product-constraints.test.ts` the function `createLintWorkspace()` writes probe projects with `writeProject(workspace, root, name, tags)` and source files. After the existing `writeProject` calls add a tool:

```ts
await writeProject(workspace, 'tools/probe-tool', 'probe-tool', [
  'scope:infra',
  'type:scripts',
  'runtime:bun',
  'ring:adapter',
]);
```

and, beside the other `writeFile` calls, two source files:

```ts
writeFile(
  join(workspace, 'tools/probe-tool/src/forbidden.ts'),
  "import { wbs } from '@wbs/core';\nexport const tool = wbs;\n",
),
writeFile(
  join(workspace, 'tools/probe-tool/src/allowed.ts'),
  "import { shared } from '@shared/utility';\nexport const tool = shared;\n",
),
```

(`@wbs/core` and `@shared/utility` are already in the fixture's `tsconfig.base.json` `paths`; check the `paths` block near line 36 and add `'@shared/utility'` if only `@probe/*` and `@wbs/*` are present.) The fixture `eslint.config.mjs` (written near line 79) must also spread a `scope:infra` rule the same way the production config does, so copy the production `scopeConstraints` minus its `scope:infra` entry into it.

- [ ] **Step 2: Add the test case** inside `describe('generated product lint constraints', …)`:

```ts
it('refuses a product import from a product-less tool and admits shared', async () => {
  const workspace = await createLintWorkspace();
  const attempt = await runLint(workspace, 'probe-tool');
  // Proof: before the infra rule existed this lint exited 0 and the assertion below reported
  // `Expected: 1, Received: 0` (<date>).
  expect(attempt.code).toBe(1);
  expect(attempt.stdout).toContain('forbidden.ts');
  expect(attempt.stdout).not.toContain('allowed.ts');
});
```

- [ ] **Step 3: Run it.** `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'product-less tool'`. Expected: fails on `expect(attempt.code).toBe(1)` with `Received: 0`.
- [ ] **Step 4: Implement.** In `workspace-projects.mjs` replace the `return [...products].sort().map((product) => ({ ... }));` of `productConstraints` with:

```js
const perProduct = [...products].sort().map((product) => ({
  sourceTag: `product:${product}`,
  // (keep the existing Proof comment here)
  onlyDependOnLibsWithTags:
    product === 'shared' ? ['product:shared'] : [`product:${product}`, 'product:shared'],
}));
return [
  ...perProduct,
  // Proof: without this rule the fixture's probe tool imported `@wbs/core` and lint exited 0
  // (<date>). Tools carry no product tag, so no per-product rule ever applies to them.
  { sourceTag: 'scope:infra', onlyDependOnLibsWithTags: ['scope:infra', 'product:shared'] },
];
```

In `eslint.config.js` delete the line `{ sourceTag: 'scope:infra', onlyDependOnLibsWithTags: ['scope:shared', 'scope:infra'] },` from `scopeConstraints`.

- [ ] **Step 5: Run the fixture test** again: passes. Run the whole devsync suite `bunx nx test tool-devsync --skip-nx-cache`: everything else still green.
- [ ] **Step 6: Run the real lint** `bunx nx run-many -t lint --skip-nx-cache 2>&1 | tee /tmp/lint-1.2.log`. Expected red, and `grep -c 'can only depend on libs tagged with "scope:infra", "product:shared"' /tmp/lint-1.2.log` is greater than 0. The offenders must be exactly: files under `tools/tool-wiki/src` (import `@wbs/validation`), `tools/tool-devsync/src` (one file importing `@wbs/validation`), files under `tools/tool-remote-scripts/src` importing `@wbs/contracts/solver/supervisor-protocol`, and `tools/dev/write-fast-golden-corpus.ts` and `tools/dev/write-solver-quantum-golden-corpus.ts` importing `@wbs/domain`. Any other offender is a finding: stop and report it. Do not commit yet.

### Task 1.3: `libs/shared/domain/validation` holds the framework-free validators

**Files:**

- Create: `libs/shared/domain/validation/project.json`, `tsconfig.json`, `tsconfig.lib.json`, `tsconfig.spec.json`, `README.md`
- Move (`git mv`): `libs/wbs/domain/validation/src/core.ts`, `core.test.ts`, `errors.ts` → `libs/shared/domain/validation/src/`
- Create: `libs/shared/domain/validation/src/index.ts`
- Modify: `libs/wbs/domain/validation/src/index.ts`
- Modify: `tsconfig.base.json` (`compilerOptions.paths`)
- Modify: 25 files under `tools/tool-wiki/src` and `tools/tool-devsync/src` (imports)
- Test: `tools/tool-devsync/src/namespace-layout.test.ts` (one positive fixture)

**Interfaces:**

- Produces: alias `@shared/validation` exporting `parseOrThrow`, `parseSecretsOrThrow`, `type`, `Type`, `ValidationError`. `@wbs/validation` keeps exporting all of those plus `fixtures`, so no product file changes.

- [ ] **Step 1: Pin the layout rule for a shared library.** In `namespace-layout.test.ts` find the positive fixture list (projects that must produce zero violations) and add:

```ts
{
  root: 'libs/shared/domain/validation',
  name: 'shared-validation',
  tags: ['scope:shared', 'type:validation', 'runtime:isomorphic', 'ring:domain', 'product:shared'],
},
```

Run `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'layout'`: green already (the validator is generic). Keep it; it is the pin.

- [ ] **Step 2: Create the project.**

```bash
mkdir -p libs/shared/domain/validation/src
cp libs/wbs/domain/validation/tsconfig.json libs/wbs/domain/validation/tsconfig.lib.json libs/wbs/domain/validation/tsconfig.spec.json libs/shared/domain/validation/
git mv libs/wbs/domain/validation/src/core.ts libs/shared/domain/validation/src/core.ts
git mv libs/wbs/domain/validation/src/core.test.ts libs/shared/domain/validation/src/core.test.ts
git mv libs/wbs/domain/validation/src/errors.ts libs/shared/domain/validation/src/errors.ts
```

The three copied tsconfigs need no edits: they use `../../../../` relative paths and the new project sits at the same depth.

Write `libs/shared/domain/validation/project.json`:

```json
{
  "name": "shared-validation",
  "$schema": "../../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "libs/shared/domain/validation/src",
  "projectType": "library",
  "tags": [
    "scope:shared",
    "type:validation",
    "runtime:isomorphic",
    "ring:domain",
    "product:shared"
  ],
  "targets": {
    "lint": {
      "executor": "nx:run-commands",
      "options": { "command": "bunx eslint libs/shared/domain/validation/src" }
    },
    "lint:fast": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bunx eslint libs/shared/domain/validation/src --cache --cache-location .nx/eslintcache-shared-validation"
      }
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bun test --coverage --coverage-reporter=lcov",
        "cwd": "libs/shared/domain/validation"
      },
      "outputs": ["{projectRoot}/coverage"]
    },
    "test:unit": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bun test --coverage --coverage-reporter=lcov",
        "cwd": "libs/shared/domain/validation"
      },
      "outputs": ["{projectRoot}/coverage"]
    },
    "typecheck": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bunx tsc --build --force libs/shared/domain/validation/tsconfig.json"
      }
    }
  }
}
```

Write `libs/shared/domain/validation/src/index.ts`:

```ts
export * from './core';
export * from './errors';
```

Write `libs/shared/domain/validation/README.md` (three lines): what it is (ArkType parse helpers that print no secret), who may import it (any product and any tool), and that WBS fixtures stay in `@wbs/validation/fixtures`.

Replace `libs/wbs/domain/validation/src/index.ts` with:

```ts
export * from '@shared/validation';
```

(the `fixtures` subpath alias `@wbs/validation/fixtures` points at `src/fixtures/index.ts` directly and is unaffected).

- [ ] **Step 3: Alias.** In `tsconfig.base.json` `paths`, add next to `"@wbs/validation"`:

```json
"@shared/validation": ["./libs/shared/domain/validation/src/index.ts"],
```

- [ ] **Step 4: Rewrite the tool imports.**

```bash
grep -rl "'@wbs/validation'" tools/tool-wiki/src tools/tool-devsync/src | xargs sed -i "s#'@wbs/validation'#'@shared/validation'#"
grep -rn "@wbs/validation" tools/   # expected: no output
```

- [ ] **Step 5: Verify.**

```bash
bunx nx run-many -t typecheck lint test -p shared-validation,wbs-validation,tool-wiki,tool-devsync --skip-nx-cache
```

Expected: all green; tool-wiki's lint no longer reports the `scope:infra` rule. `bunx nx show projects | grep shared-validation` prints the project. Then `bunx nx run-many -t lint --skip-nx-cache 2>&1 | grep -c 'scope:infra'` must now count only tool-remote-scripts and the two `tools/dev` files (Task 1.5 handles them).

- [ ] **Step 6: Commit** (still not pushed; lint is red until 1.5).

```bash
git add libs/shared libs/wbs/domain/validation/src/index.ts tsconfig.base.json tools/tool-wiki/src tools/tool-devsync/src tools/tool-devsync/workspace-projects.mjs tools/tool-devsync/src/product-constraints.test.ts eslint.config.js
git commit -m "refactor(shared): extract framework-free validation into product:shared"
```

### Task 1.4: Product lint policy lives with the product

The root `eslint.config.js` has nine blocks keyed to WBS paths, all of which move. Line numbers are from `main` ff0b0353; re-check with `grep -n "files: \[" eslint.config.js`:

| Lines   | `files`                                                                                           | What it enforces                                            |
| ------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 182–228 | `apps/wbs/fe-01/**`, `libs/wbs/adapters/realtime/**`                                              | React, hooks, a11y, TanStack router/query rules             |
| 229–237 | `libs/wbs/adapters/store-sqlite/src/**`                                                           | Drizzle delete/update-with-where                            |
| 238–275 | `apps/wbs/be-01/src/**` except `repository/**`                                                    | bans `drizzle-orm` and typebox                              |
| 276–320 | be-01 src and store-sqlite src except `db.ts`                                                     | bans `bun:sqlite` outside `openDatabase()`                  |
| 321–414 | `apps/wbs/be-01/src/controller/**`                                                                | controller import restrictions                              |
| 415–463 | `apps/wbs/be-01/src/**` except controller, `http/elysia/**`, `app.ts`, `openapi-plugin.ts`        | framework-freedom bans for services                         |
| 464–489 | `libs/wbs/adapters/store-sqlite/src/db.ts`                                                        | the one file allowed to import `bun:sqlite`                 |
| 490–555 | `libs/wbs/application/core/src/**`, `libs/wbs/domain/domain/src/**` (not tests, not `testing/**`) | runtime-package and ambient-global bans for core and domain |
| 623–641 | `libs/wbs/adapters/store-memory/src/**/*.test.ts`                                                 | test boundary with the conformance `allow`                  |

Plus the ignore entry `'apps/wbs/be-01/tools/capture-capacity-oracle.ts'` at line 93. The blocks at 556–599 (`**/*.{ts,tsx}`, test files) and 600–622 (all tests) are generic and stay in the root.

**Files:**

- Create: `apps/wbs/eslint.product.mjs`
- Modify: `eslint.config.js`
- Modify: `nx.json` (`targetDefaults.lint.inputs`)
- Test: `tools/tool-devsync/src/eslint-boundaries.test.ts` (new `describe`), `tools/tool-devsync/src/lint-policy-cache.test.ts` (one case)

**Interfaces:**

- Produces: the convention "`apps/<product>/eslint.product.mjs` and `libs/<product>/eslint.product.mjs` default-export a function `(shared) => flatConfigArray`, where `shared = { productRules, scopeConstraints, runtimeConstraints, browserAdapterConstraint, testSourceFiles }`; the root config calls every one it finds and spreads what it returns". W6 relies on it for `apps/wiki/eslint.product.mjs`.

- [ ] **Step 0: Share the fixture helpers.** `product-constraints.test.ts` defines `writeProject`, `createLintWorkspace` and `runLint` privately. Move them to a new `tools/tool-devsync/src/testing/lint-workspace.ts` with `export` on each, keep `CHECKOUT` there too, and import them back into `product-constraints.test.ts`. Run `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'product lint'`: still green. Add a fourth export `createPolicyWorkspace()` that calls `createLintWorkspace()` and additionally writes `apps/probe/app/project.json` (name `probe-app`, tags `scope:app type:app runtime:bun ring:adapter product:probe`, a `lint` target `bunx eslint apps/probe/app/src --no-cache`) and `apps/probe/app/src/main.ts` containing `export const app = true;`.

- [ ] **Step 1: Write the failing discovery tests.** `eslint-boundaries.test.ts` uses `new ESLint({ cwd: workspace })` against the real workspace; discovery needs the fixture workspace from Step 0 (`import { createPolicyWorkspace, runLint } from './testing/lint-workspace';`). Add to `eslint-boundaries.test.ts`:

```ts
describe('product lint policy discovery', () => {
  it('applies apps/<product>/eslint.product.mjs and refuses an unreadable one', async () => {
    const fixture = await createPolicyWorkspace();
    await writeFile(
      join(fixture, 'apps/probe/eslint.product.mjs'),
      "export default [{ files: ['apps/probe/**/*.ts'], rules: { 'no-restricted-imports': ['error', { paths: ['left-pad'] }] } }];\n",
    );
    await writeFile(join(fixture, 'apps/probe/app/src/main.ts'), "import 'left-pad';\n");
    // Proof: before discovery existed this lint exited 0 (<date>).
    expect((await runLint(fixture, 'probe-app')).code).toBe(1);
    await rm(join(fixture, 'apps/probe/eslint.product.mjs'));
    expect((await runLint(fixture, 'probe-app')).code).toBe(0);
    await writeFile(join(fixture, 'apps/probe/eslint.product.mjs'), 'export default [];\n');
    await chmod(join(fixture, 'apps/probe/eslint.product.mjs'), 0o000);
    const unreadable = await runLint(fixture, 'probe-app');
    // Proof: swallowing every import failure made this exit 0 instead of naming the file (<date>).
    expect(unreadable.code).not.toBe(0);
    expect(unreadable.stderr).toContain('apps/probe/eslint.product.mjs');
  });
});
```

The fixture's `eslint.config.mjs` must contain the same discovery block as production (copy it verbatim from Step 3 into the fixture writer).

- [ ] **Step 2: Run** `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'policy discovery'`: fails at the first `toBe(1)`.
- [ ] **Step 3: Implement discovery** in `eslint.config.js`, after the `productRules` line:

```js
import { readdir } from 'node:fs/promises';

async function readProductPolicies(root, shared) {
  const policies = [];
  for (const group of ['apps', 'libs']) {
    for (const product of (await readdir(new URL(`./${group}/`, root))).sort()) {
      const policy = new URL(`./${group}/${product}/eslint.product.mjs`, root);
      let loaded;
      try {
        loaded = await import(policy.href);
      } catch (failure) {
        // Absent is the normal case; anything else (unreadable, syntax error) must stop lint.
        if (failure?.code === 'ERR_MODULE_NOT_FOUND') continue;
        throw new Error(`cannot load product lint policy ${policy.pathname}`, { cause: failure });
      }
      if (typeof loaded.default !== 'function') {
        throw new Error(
          `${policy.pathname} must default-export a function of the shared constants`,
        );
      }
      const configs = loaded.default(shared);
      if (!Array.isArray(configs)) {
        throw new Error(
          `${policy.pathname} must return an array of flat-config objects synchronously`,
        );
      }
      policies.push(...configs);
    }
  }
  return policies;
}
const productPolicies = await readProductPolicies(import.meta.url, {
  productRules,
  scopeConstraints,
  runtimeConstraints,
  browserAdapterConstraint,
  testSourceFiles,
});
```

Bun/Node throw `ERR_MODULE_NOT_FOUND` for a missing file and `EACCES` for an unreadable one; the test's unreadable case proves the distinction. Then move the nine WBS blocks from the table into `apps/wbs/eslint.product.mjs` as the array a default-exported `(shared) => flatConfigArray` returns, byte-for-byte except indentation. The product file imports `react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `@tanstack/eslint-plugin-router`, `@tanstack/eslint-plugin-query` and `eslint-plugin-drizzle` itself, and declares its own `const testSourceFiles = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.property.test.ts'];` (copy of the root constant; the two must stay equal, so add to the discovery test an assertion that the product file's list deep-equals the root's, exported from the root config as `export const testSourceFiles`). The block at 623–641 also needs `scopeConstraints`, `runtimeConstraints`, `browserAdapterConstraint` and `productRules`; export those four from the root config and import them in the product file (`import { productRules, ... } from '../../eslint.config.js'`). Spread `...productPolicies` in the root array where the first moved block was. Move the `capture-capacity-oracle.ts` ignore into the product file as its own `{ ignores: [...] }` entry.

- [ ] **Step 4: Prove the move is lossless.** `bunx nx run-many -t lint --skip-nx-cache` green (except the two known scope:infra offenders until 1.5). Then:

```bash
echo "import 'drizzle-orm';" >> apps/wbs/be-01/src/index.ts
bunx nx run wbs-be-01:lint --skip-nx-cache   # expected: exit 1, "Import Drizzle only from the store-sqlite adapter."
git checkout apps/wbs/be-01/src/index.ts
```

- [ ] **Step 5: Cache inputs.** In `nx.json` `targetDefaults.lint.inputs` add `"{workspaceRoot}/apps/*/eslint.product.mjs"` and `"{workspaceRoot}/libs/*/eslint.product.mjs"`. In `lint-policy-cache.test.ts` add a case that the two globs are present in `nx.json` (read and parse the file). Manual proof: `bunx nx run wbs-be-01:lint` twice (second is a cache hit, log says `[existing outputs match the cache]`), append a newline to `apps/wbs/eslint.product.mjs`, run again: cache miss.
- [ ] **Step 6: Commit.**

```bash
git add eslint.config.js apps/wbs/eslint.product.mjs nx.json tools/tool-devsync/src/eslint-boundaries.test.ts tools/tool-devsync/src/lint-policy-cache.test.ts
git commit -m "refactor(lint): product lint policy lives with the product"
```

### Task 1.5: Name the two infra-to-product exceptions

`tools/tool-remote-scripts` (13 files, `@wbs/contracts/solver/supervisor-protocol`) and `tools/dev/write-*-golden-corpus.ts` (`@wbs/domain`) are WBS host tooling misfiled as infra. Moving them is queued (Task 1.8). Until then lint must pass with the exception named.

**Files:**

- Modify: `eslint.config.js` (`allow: []` at line 54 and again at 606)
- Test: `tools/tool-devsync/src/eslint-boundaries.test.ts`

- [ ] **Step 1: Write the test** (reads the root config through ESLint's effective config, as the existing `boundaryOf` helper does):

```ts
it('names exactly the two pending infra-to-product exceptions and each is still used', async () => {
  const config = await lint.calculateConfigForFile(
    join(workspace, 'tools/tool-remote-scripts/src/lib/docker.ts'),
  );
  const [, options] = boundaryOf(config);
  const allow = isRecord(options) && Array.isArray(options['allow']) ? options['allow'] : [];
  expect([...allow].sort()).toEqual(['@wbs/contracts/solver/supervisor-protocol', '@wbs/domain']);
  for (const alias of allow) {
    const users = Bun.spawnSync(['grep', '-rl', `from '${alias}'`, 'tools/'], { cwd: workspace });
    // Proof: an allow entry nobody imports is dead policy; removing tool-dev's `@wbs/domain`
    // import made this fail by name (<date>).
    expect(users.stdout.toString(), alias).not.toBe('');
  }
});
```

- [ ] **Step 2: Run** it: fails on the empty `allow`.
- [ ] **Step 3: Edit both `allow: []`** in `eslint.config.js` to:

```js
// Pending relocation under apps/wbs (docs/refactoring/tasks.md, "solver host tooling"):
// tool-remote-scripts' supervisor host tooling and tools/dev's corpus writers are WBS code
// living in infra. eslint-boundaries.test.ts pins this list and fails when an entry is unused.
allow: ['@wbs/contracts/solver/supervisor-protocol', '@wbs/domain'],
```

- [ ] **Step 4: Run** `bunx nx run-many -t lint --skip-nx-cache`: green everywhere. Run `bunx nx test tool-devsync --skip-nx-cache`: green.
- [ ] **Step 5: Commit** and push the branch (first push; the head is green).

```bash
git add eslint.config.js tools/tool-devsync/src/eslint-boundaries.test.ts
git commit -m "chore(lint): name the two infra-to-product exceptions pending relocation"
```

### Task 1.6: Handoff test derives its manifests from the workspace

`tools/tool-devsync/src/repo-namespacing-handoff.test.ts` (646 lines) pins by hand: `EXPECTED_ALIASES` (lines 36–88), `EXPECTED_PROJECTS` (90–120), `CURRENT_MARKDOWN` (14–33), `CLASSIFIED_LEGACY_DOCUMENTATION` (124–160), `HANDOFF_TEST_INPUTS` (166–178). Keep the tests that scan for legacy paths, check links, check Nx selectors, pin migration blobs and Dockerfile variants. Replace the hand lists.

**Files:**

- Modify: `tools/tool-devsync/src/repo-namespacing-handoff.test.ts`
- Create: `docs/findings/legacy-path-allowlist.json`
- Modify: `tools/tool-devsync/project.json` (test inputs: add the JSON file)

- [ ] **Step 1: Snapshot.** `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'handoff' > /tmp/handoff-before.log`; all green.
- [ ] **Step 2: Aliases.** Replace `EXPECTED_ALIASES` and the test `the public alias manifest remains complete and stable` with:

```ts
test('every alias has an allowed prefix and resolves to a tracked file', async () => {
  const base = JSON.parse(await readFile(join(WORKSPACE, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const tracked = new Set(candidatePaths());
  const failures: string[] = [];
  for (const [alias, targets] of Object.entries(base.compilerOptions.paths)) {
    if (!/^@(wbs|shared|tools)\//.test(alias)) failures.push(`${alias}: prefix`);
    for (const target of targets) {
      const path = target.replace(/^\.\//, '').replace(/\/\*$/, '');
      const exists = tracked.has(path) || [...tracked].some((file) => file.startsWith(`${path}/`));
      if (!exists) failures.push(`${alias}: ${target} is not tracked`);
    }
  }
  // Proof: pointing @wbs/config at ./libs/wbs/adapters/config/src/missing.ts failed here by
  // name; an `@acme/x` alias failed on prefix (<date>).
  expect(failures).toEqual([]);
});
```

Until Task 1.7 lands the four `@wbs/tool-*` and `@wbs/deploy-contract` keys pass the prefix rule (they start with `@wbs/`); Task 1.7 tightens nothing here, it only moves them to `@tools/`.

- [ ] **Step 3: Projects.** Delete `EXPECTED_PROJECTS` and the test `the recursive Nx root and name manifest remains complete`; `workspace-inventory.test.ts` already compares `readProjects` with `bunx nx show projects --json`. Confirm with `grep -n "show projects" tools/tool-devsync/src/workspace-inventory.test.ts`.
- [ ] **Step 4: Legacy documentation.** Move the `CLASSIFIED_LEGACY_DOCUMENTATION` pairs into `docs/findings/legacy-path-allowlist.json`:

```json
{
  "expires": "2026-12-31",
  "entries": [{ "path": "docs/2026-08-30-agent-loop-audit.md", "reason": "dated audit" }]
}
```

(all 34 pairs). In the test, add the reader (schema validated once at this boundary; an absent or malformed file throws):

```ts
import { parseOrThrow, type } from '@shared/validation';

const LegacyAllowlist = type({
  expires: /^\d{4}-\d{2}-\d{2}$/,
  entries: type({ path: 'string>0', reason: 'string>0' }).array(),
});

async function readLegacyAllowlist(): Promise<typeof LegacyAllowlist.infer> {
  const path = join(WORKSPACE, 'docs/findings/legacy-path-allowlist.json');
  // Proof: deleting the file made every consumer fail here with ENOENT and the path (<date>).
  return parseOrThrow(LegacyAllowlist, JSON.parse(await readFile(path, 'utf8')));
}
```

and add:

```ts
test('the legacy documentation allowlist has not expired', async () => {
  const allowlist = await readLegacyAllowlist();
  // Proof: setting expires to 2020-01-01 failed here with the count of remaining entries (<date>).
  if (allowlist.entries.length > 0) {
    expect(new Date(allowlist.expires).getTime()).toBeGreaterThan(Date.now());
  }
});
```

Keep the two consumers of the list (`every root-routed current document participates` and `every legacy documentation reference is classified`) reading from `allowlist.entries`.

- [ ] **Step 5: Current markdown.** Replace `CURRENT_MARKDOWN` by discovery: current documents are every tracked `*.md` under `docs/`, the root `*.md` files, and `openspec/changes/<name>/**/*.md` for names not under `archive/`, minus the allowlist. Reuse `candidatePaths()` and `rootRoutedDocuments()` already in the file.
- [ ] **Step 6: Inputs.** Delete `HANDOFF_TEST_INPUTS` and its test; instead add `"{workspaceRoot}/docs/findings/legacy-path-allowlist.json"` to `tools/tool-devsync/project.json` test `inputs`, and confirm the existing `{workspaceRoot}/**/*` input already covers the rest (it does: it is the first entry).
- [ ] **Step 7: Run** `bunx nx test tool-devsync --skip-nx-cache`; compare pass counts with `/tmp/handoff-before.log` (two tests removed, two added). Negative: add the line `` see `libs/domain/src/x.ts` `` to `docs/capacity.md`, run, observe `current documentation and active solver packets use namespaced roots` fail naming `docs/capacity.md`; revert.
- [ ] **Step 8: Commit.**

```bash
git add tools/tool-devsync/src/repo-namespacing-handoff.test.ts docs/findings/legacy-path-allowlist.json tools/tool-devsync/project.json
git commit -m "test(devsync): derive handoff manifests from the workspace"
```

### Task 1.7: Infra aliases and the workspace name leave the product namespace

**Files:**

- Modify: `tsconfig.base.json` (four alias keys)
- Modify: the 46 importing files: `grep -rlE "@wbs/(deploy-contract|tool-compose|tool-env|tool-test-scratch)" apps libs tools bin`
- Modify: `package.json` line 2 `"name": "@wbs/source"` → `"name": "@puni/workspace"` (nothing imports `@wbs/source`; verified with grep on 2026-09-15)
- Modify: `tools/tool-devsync/src/repo-namespacing-handoff.test.ts` alias prefix regex stays `@(wbs|shared|tools)/`

- [ ] **Step 1: Rename the keys** in `tsconfig.base.json`:

```
"@wbs/deploy-contract"  -> "@tools/deploy-contract"
"@wbs/tool-compose"     -> "@tools/compose"
"@wbs/tool-env"         -> "@tools/env"
"@wbs/tool-test-scratch"-> "@tools/test-scratch"
```

- [ ] **Step 2: Rewrite imports.**

```bash
grep -rlE "@wbs/(deploy-contract|tool-compose|tool-env|tool-test-scratch)" apps libs tools bin \
  | xargs sed -i -e "s#'@wbs/deploy-contract'#'@tools/deploy-contract'#g" \
                 -e "s#'@wbs/tool-compose'#'@tools/compose'#g" \
                 -e "s#'@wbs/tool-env'#'@tools/env'#g" \
                 -e "s#'@wbs/tool-test-scratch'#'@tools/test-scratch'#g"
grep -rnE "@wbs/(deploy-contract|tool-compose|tool-env|tool-test-scratch)" apps libs tools bin docs   # docs hits are historical: leave; code hits: none expected
```

`tools/tool-devsync/src/poller.test.ts` writes a fixture alias `@wbs/probe-contract` into a temporary tsconfig; leave it, it is not in `tsconfig.base.json`.

- [ ] **Step 3: Workspace name.** Edit `package.json` line 2. Run `bun install` (lockfile records the root name; commit `bun.lock` if it changed).
- [ ] **Step 4: Verify.** `bunx nx run-many -t typecheck lint test --skip-nx-cache` green. `bun run dev:test` (bin/dev.test.sh) green, because `bin/*.sh` may reference the tool aliases through `bun run` entrypoints.
- [ ] **Step 5: Commit.**

```bash
git add tsconfig.base.json package.json bun.lock apps libs tools bin
git commit -m "refactor(aliases): infra packages move to @tools/*"
```

### Task 1.8: ADR numbering, and the two queued relocations

**Files:**

- Rename: `docs/adr/0018-the-dev-deploy-trigger-owns-solver-compatibility-preparation.md` → `docs/adr/0025-the-dev-deploy-trigger-owns-solver-compatibility-preparation.md` (the 2026-09-08 file `0018-adapter-transactions-stay-outside-core-ports.md` keeps 0018; 0025 is the next free number, check `ls docs/adr | tail -1`)
- Modify: the links: `openspec/changes/automatic-dev-solver-binding/proposal.md:50`, `openspec/changes/repo-namespacing/preflight-inventory.md:425` (historical inventory: leave), `docs/experiment-evidence/baseline-inventory.v1.json:4320` (frozen evidence: leave), `tools/tool-devsync/src/repo-namespacing-handoff.test.ts` (after 1.6 the list is derived; nothing to edit)
- Create: `tools/tool-devsync/src/adr-index.test.ts`
- Modify: `docs/refactoring/tasks.md` (queue section)

- [ ] **Step 1: Write the test.**

```ts
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const ADR_DIR = fileURLToPath(new URL('../../../docs/adr/', import.meta.url));

test('ADR numbers are unique and contiguous from 0001', async () => {
  const numbers = (await readdir(ADR_DIR))
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((left, right) => left - right);
  const expected = numbers.map((_, index) => index + 1);
  // Proof: two files numbered 0018 made this fail with `[..., 18, 18, 19, ...]` (<date>).
  expect(numbers).toEqual(expected);
});
```

- [ ] **Step 2: Run** `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'ADR numbers'`: fails on the duplicate 18.
- [ ] **Step 3: Rename and relink.**

```bash
git mv docs/adr/0018-the-dev-deploy-trigger-owns-solver-compatibility-preparation.md docs/adr/0025-the-dev-deploy-trigger-owns-solver-compatibility-preparation.md
sed -i 's#0018-the-dev-deploy-trigger#0025-the-dev-deploy-trigger#' openspec/changes/automatic-dev-solver-binding/proposal.md
```

Open the renamed file and change its title line `# ADR 0018` to `# ADR 0025` if the number is in the heading. Run the test: green. Run `bunx nx run tool-wiki:lint:source --skip-nx-cache` and the handoff link test (`--test-name-pattern 'links and anchors'`): green.

- [ ] **Step 4: Queue the relocations.** In `docs/refactoring/tasks.md`, in the queue section, append two unchecked items:

```
- [ ] core↔store-memory cycle: all 27 core importers of `@wbs/store-memory` are under
      `libs/wbs/application/core/src/testing/` and `libs/wbs/application/core/testing/`. Move
      `src/testing/harness.ts`, `src/testing/writes-fixture.ts` and `testing/portable-composition.ts`
      into `libs/wbs/application/conformance` (already `ring:application`, already depends on
      both), then delete every `ignoredCircularDependencies` entry in `eslint.config.js`.
- [ ] Solver host tooling relocation: `tools/tool-remote-scripts/src/lib/solver-supervisor-*`,
      `src/materialize-solver-supervisor-config.ts`, `deploy/solver-supervisor/*` and
      `tools/dev/write-*-golden-corpus.ts` are WBS code in infra. Move them under `apps/wbs/`
      (a `wbs-host-tools` project, `ring:adapter`, `product:wbs`), then remove both entries from
      the `allow` list in `eslint.config.js` and the pinning test in eslint-boundaries.test.ts.
```

- [ ] **Step 5: Commit.**

```bash
git add docs/adr tools/tool-devsync/src/adr-index.test.ts openspec/changes/automatic-dev-solver-binding/proposal.md docs/refactoring/tasks.md
git commit -m "docs(adr): renumber the duplicate 0018 and pin uniqueness"
```

### Task 1.9: Gate and PR

- [ ] `bunx nx format:write` then `bunx nx format:check --all`; `git diff --check`.
- [ ] Push. On h2puni: `bin/h2puni-gate.sh $(git rev-parse HEAD)`. Wait for `h2puni gate: running on <sha>` and exit 0. If exit 65, the shared tree is dirty: report the named files, do not clean.
- [ ] Open the PR with title `refactor: second-product readiness` and a body listing Tasks 1.1–1.8 with the gate line pasted verbatim. Do not merge.

---

## W2 — FIFO heavy lock (OpenSpec change `fifo-heavy-lock`)

**Problem:** `with_heavy_lock` polls `mkdir` every 5 s; release goes to whichever waiter polls first. Measured: a browser gate waited 50 minutes while four newer jobs won (audit item 12). **Outcome:** waiters are served in arrival order, the queue is observable, and a dead waiter never blocks the queue. **Non-goals:** more than one lane, a lock path override, cross-host locking.

### Task 2.1: Ticket queue in `heavy-lock-lib.sh`

**Files:**

- Modify: `bin/heavy-lock-lib.sh`
- Modify: `bin/heavy-lock.test.sh` (new cases 6–9)
- Modify: `bin/with-heavy-lock.sh` (new `status` subcommand)

**Design (bash, no new dependencies):**

- Queue directory `"$lock_path.queue"` beside `"$lock_path.d"`; created with `mkdir -p` under the same parent-writable check.
- Ticket file name `$(date +%s%N)-$$` (nanoseconds then pid; `date +%N` exists on Linux and Homebrew coreutils; on Darwin fall back to `python3 -c 'import time;print(time.time_ns())'`, both refused loudly if absent). Ticket content: pid, lane label from `$HEAVY_LOCK_LABEL` (default `unlabeled`), command line, ISO start time.
- A waiter claims only when (a) its ticket is the lexicographically smallest live ticket and (b) `mkdir "$lock_dir"` succeeds. A ticket whose pid is dead is removed by whoever sees it first, with a stderr line naming it.
- Holder deletes its ticket after `mkdir` succeeds; the EXIT trap removes both ticket and lock dir.
- Poll stays at 5 s; `HEAVY_LOCK_WAIT_SECONDS` semantics unchanged (0 = refuse if not first and free immediately).
- `with-heavy-lock.sh status` prints holder pid and label, then queued tickets oldest first with age in seconds. Exit 0.

- [ ] **Step 1: Write failing test case 6** in `heavy-lock.test.sh`: start holder H (sleep 6), start waiter A (`HEAVY_LOCK_WAIT_SECONDS=60`, label `a`), sleep 1, start waiter B (label `b`); release H; assert A's command ran before B's (each appends its label to a log file). With the current lottery this is flaky; make the test deterministic by having B poll faster (`HEAVY_LOCK_POLL_SECONDS=1`, new variable, default 5) so B would win under the lottery — the test then fails reliably.
- [ ] **Step 2: Run** `bash bin/heavy-lock.test.sh`; case 6 fails with order `b a`.
- [ ] **Step 3: Implement** the ticket queue.
- [ ] **Step 4: Cases 7–9**: 7 a dead waiter's ticket (pid of an exited process) is reclaimed and the next waiter proceeds; 8 an unreadable queue directory refuses with exit 70; 9 `status` output lists the holder and two waiters oldest first.
- [ ] **Step 5: Run** the whole suite green plus `shellcheck bin/heavy-lock-lib.sh bin/with-heavy-lock.sh`.
- [ ] **Step 6: Commit** `feat(heavy-lock): serve waiters in arrival order`.

### Task 2.2: Gate reports its queue wait

**Files:**

- Modify: `bin/h2puni-gate.sh` — export `HEAVY_LOCK_LABEL="gate:${sha:0:8}"`; print `heavy lock: waited <n>s behind <k> tickets` before `h2puni gate: running on <sha>`
- Test: `bin/h2puni-gate.test.sh` — new case asserting the line is printed and `<n>` is an integer when the lock was held by a dummy holder for 3 s

- [ ] Steps: write the case, watch it fail (no line), implement, rerun, commit `feat(gate): report heavy-lock queue wait`.

### Task 2.3: Verify and hand off

- [ ] On h2puni: `bin/heavy-lock:test` through `bun run heavy-lock:test`, then `bin/h2puni-gate.sh <sha>`; record in `verify.md` the observed wait line and the case-6 order. Update `docs/2026-08-30-agent-loop-audit.md` item 12 with a one-line "resolved by" pointer, not a rewrite.

---

## W3 — Affected-only PR gate, full gate in the merge queue (OpenSpec change `affected-pr-gate`)

**Problem:** every PR runs the full `nx run-many -t test lint typecheck build` (38 min at PR #457) and the merged tree runs it again; composition can only be tested on the merged tree. **Outcome:** a PR runs only affected targets against its merge base; the full gate runs on `merge_group` and `push` to `main`; the h2puni exact-head gate stays the final proof. **Non-goals:** remote Nx cache, changing what the full gate runs, weakening the gate for `main`.

**Prerequisite owned by Dany:** create a ruleset for `main` with a merge queue and the required checks `gate` and `pixels`. Today `GET /repos/…/rulesets` is `[]` and branch protection is 404, so nothing is required and `merge_group` never fires. W3's workflow changes are inert until the ruleset exists; land them first, enable the queue second.

### Task 3.1: Choose the gate mode per event in YAML

**Files:**

- Modify: `.github/workflows/ci.yml` job `gate`, step "Gate — test, lint, typecheck, build"
- Modify: `tools/tool-devsync/src/toolchain-pins.test.ts` (pins the command line)
- Modify: `tools/tool-git-hooks/src/hooks/pixels-workflow.test.ts` if the pixels job gains the same switch

**Design:** the boundary is chosen per event, never inferred (the corpus-version-lint step already does this):

```yaml
- name: Gate mode
  id: mode
  run: |
    case "${{ github.event_name }}" in
      pull_request) echo "mode=affected" >> "$GITHUB_OUTPUT"; echo "base=${{ github.event.pull_request.base.sha }}" >> "$GITHUB_OUTPUT" ;;
      merge_group|push|workflow_dispatch) echo "mode=full" >> "$GITHUB_OUTPUT" ;;
      *) echo "no gate mode for event ${{ github.event_name }}" >&2; exit 1 ;;
    esac
- name: Gate — test, lint, typecheck, build
  run: |
    if [ "${{ steps.mode.outputs.mode }}" = affected ]; then
      bunx nx affected -t test lint typecheck build --base="${{ steps.mode.outputs.base }}" --head=HEAD --parallel=2 --output-style=stream --exclude=tool-wiki
    else
      bunx nx run-many -t test lint typecheck build --parallel=2 --output-style=stream --exclude=tool-wiki
    fi
```

`actions/checkout` needs `fetch-depth: 0` on `pull_request` for `--base` to resolve; the workflow already fetches full history for corpus lint (check line ~470 and reuse).

- [ ] **Step 1: Extend `toolchain-pins.test.ts`** to assert both command lines and the `*)` refusal arm exist; run, watch fail.
- [ ] **Step 2: Edit the workflow**; rerun the pin test green.
- [ ] **Step 3: Negative on the affected path**: open a throwaway PR touching only `libs/shared/domain/validation/src/core.ts` with a deliberate type error; the PR gate must fail in `shared-validation:typecheck` and must not run `wbs-fe-01:build` (read the Nx task graph in the log). Close the PR.
- [ ] **Step 4: Commit** `ci: affected gate on pull requests, full gate on merge queue and main`.

### Task 3.2: `pixels` follows the same switch

- [ ] Modify the `pixels_shard` job to run only when `mode=full` or when `nx affected --graph` includes `wbs-fe-01`; use `bunx nx show projects --affected --base=<base>` and grep for `wbs-fe-01`; the `*)` arm still exits 1. Extend `pixels-workflow.test.ts` to pin the show-projects command. Commit `ci: pixels shards run when the frontend is affected`.

### Task 3.3: Verify

- [ ] `verify.md` records: one PR-only run's task list (must be a strict subset), one `push` to `main` run's full task list, the throwaway negative PR link, and the timing of both. Ask Dany to enable the ruleset; after the first `merge_group` run, add its link.

---

## W4 — Lanes are Claire's first-version SDLC enabler (docs only)

**Decision (Dany, 2026-09-15):** lanes, worktree ownership, queue dispatch and the lane registry are implemented in the Claire repository (`~/wd/personal/claire`: `bin/lane-registry.mjs`, `bin/lane-guard.mjs`, `bin/lane-commit.mjs`, `bin/queue-*.mjs`). This repository does not define lanes and will not grow a lane registry. Every mention of lanes here describes Claire's v1 mechanism.

### Task 4.1: One paragraph of record, linked from the index

**Files:**

- Create: `docs/lanes-are-claire-v1.md` (≤ 40 lines): what a lane is (a Claire worker session in its own worktree under one `.git`, gating on h2puni through `bin/h2puni-gate.sh <sha>`), that the mechanism is Claire's first-version SDLC enabler and is expected to be replaced, the three repository contracts a lane must honour (exact-SHA gate under the lock, never commit inside another lane's worktree, own your ports), and the pointer to the Claire scripts by path.
- Modify: `LLM_README.md` — the "More" table row for the agent-loop audit gains "; lanes are Claire's v1 mechanism, see `docs/lanes-are-claire-v1.md`". Keep under 150 lines (doc-caps hook).
- Modify: `HUMAN_README.md` "h1claw over WhatsApp" section — one sentence linking the same doc.
- Modify: `bin/h2puni-gate-lib.sh` header comment lines 6–12 — add "Lanes are Claire's v1 mechanism (docs/lanes-are-claire-v1.md)".
- Modify: `docs/2026-08-30-agent-loop-audit.md` — a dated note at the top: the audit describes Claire's v1 lanes; it is historical.

- [ ] **Step 1: Write the doc.** **Step 2:** run `bun run tools/tool-git-hooks/src/hooks/doc-caps.ts` and `bunx nx run tool-wiki:lint:source --skip-nx-cache` (link check). **Step 3:** commit `docs: lanes are Claire's first-version SDLC enabler`.

---

## W5 — A repository move has a path through the trusted activation (OpenSpec change `trusted-activation-relocation`)

**What actually blocks a move today:** the base-owned `trusted-wiki` workflow extracts an activation archive pinned to `TOOL_WIKI_ACTIVATION_VERSION` (a main SHA). Its policy selects `libs/domain/src/saved-plan`; the candidate moved that directory, so `selectedMembers` returns nothing and the validator throws `trusted boundary selector selects no candidate input`. The policy format already models a move: a boundary has `selector` (new path) and `sourceSelector` (old path), and `validatePilotModuleMapping` pins the candidate's `modules.json` by digest. What is missing is the procedure and tooling to activate the candidate's own policy before it merges, and an error that names that procedure.

**Outcome:** an operator can prepare a relocation activation from a candidate SHA in one command, the validator's refusal names that command, and the runbook documents the two-step landing. **Non-goals:** selectors that resolve through untrusted candidate files; weakening the digest pins.

### Task 5.1: The refusal names the procedure

**Files:**

- Modify: `tools/tool-wiki/src/policy/trust.ts` — where `selectedMembers` yields zero entries for a boundary, the error becomes `trusted boundary selector selects no candidate input: <id> (selector <value>); if the candidate moved these files, prepare a relocation activation from the candidate SHA: see docs/runbook-tool-wiki-activation.md#relocation`
- Test: `tools/tool-wiki/src/policy/pilot-policy.test.ts` — the existing case for the message asserts the new text; negative: a moved fixture directory still refuses (the check is unchanged, only its message)

- [ ] Steps: update the expectation, run red, change the message, run green, commit `fix(tool-wiki): a selector miss names the relocation procedure`.

### Task 5.2: `prepare-relocation-activation` CLI

**Files:**

- Create: `tools/tool-wiki/src/cli/prepare-relocation-activation.ts` — inputs: candidate SHA, base activation root; it reads the candidate's `docs/wiki-policy/policy.json` and `modules.json` at that SHA (`git show <sha>:<path>`, refusing a dirty or unknown SHA), asserts every boundary with a `sourceSelector` selects a non-empty baseline in the base activation's policy and a non-empty member set in the candidate (`selectedMembers`), asserts every `predecessorModuleIds` chain resolves, then calls the existing `prepareActivation` with the ten role paths and prints the version directory and digest
- Test: `tools/tool-wiki/src/cli/prepare-relocation-activation.test.ts` with two fixture commits spanning a directory rename: (a) rename with matching `sourceSelector` prepares; (b) rename without `sourceSelector` refuses naming the boundary; (c) unknown SHA refuses; (d) candidate whose `selector` still points at the old path refuses with `selector selects no candidate input`

- [ ] Steps: write (b) and (c) first, run red, implement, add (a) and (d), run `bunx nx test tool-wiki --skip-nx-cache`, commit `feat(tool-wiki): prepare a relocation activation from a candidate SHA`.

### Task 5.3: Runbook and workflow variable procedure

**Files:**

- Modify: `docs/runbook-tool-wiki-activation.md` — new section `## Relocation`: (1) candidate ships `selector` new + `sourceSelector` old + updated `modules.json` (predecessor ids for renamed modules); (2) operator runs the Task 5.2 command against the candidate head; (3) operator publishes the archive and sets the three repository variables to the candidate SHA; (4) `trusted-wiki` reruns green; (5) after merge the version is an ancestor of `main`, nothing else changes. Note the one hard limit: the variables can point at one SHA, so two concurrent move PRs serialize.
- Modify: `openspec/changes/repo-namespacing/verify.md` — a dated line: PR #457 merged with the trusted check red for this reason; relocation activation is owed and tracked by this change.

- [ ] Steps: write, link-check, commit `docs(tool-wiki): relocation activation procedure`.

### Task 5.4: Clear the debt from PR #457

- [ ] Run Task 5.2's command for the current `main` head on h2puni, publish, set the variables (Dany or an operator with repo admin), observe `trusted-wiki` green on the next PR. Record in `verify.md`.

---

## W6 — The wiki becomes `product:wiki` (refactor, no behavior change)

Branch `change/wiki-product-namespace` from `main` after W1 and W5 have merged. One PR. It moves a trusted boundary (`boundary.infra.tool-wiki` in `docs/wiki-policy/bootstrap-policy.json` selects `tools/tool-wiki`), so the PR's `trusted-wiki` check goes red until the W5 relocation activation is prepared from this PR's head (Task 6.7). That is expected and is the first real use of W5.

**Decision (Dany, 2026-09-15):** tool-wiki is a product, released separately so other repositories can consume it in CI. This workstream does the namespace and neutral naming only. W7 does the release.

**Destination mapping.** The project is one Nx project today (83 files, one `src/` with eight folders). Keep it one project; split into rings later if a second consumer needs it.

| Today             | Destination     | Nx name    | Tags                                                       |
| ----------------- | --------------- | ---------- | ---------------------------------------------------------- |
| `tools/tool-wiki` | `apps/wiki/cli` | `wiki-cli` | `scope:app type:app runtime:bun ring:adapter product:wiki` |

The layout validator (`findNamespaceLayoutViolations`) requires apps at `apps/<product>/<project>` with `ring:adapter` and name `<product>-<project>`; `apps/wiki/cli` → `wiki-cli` satisfies it with no validator change.

**Names that carry the product and their neutral replacements** (counts from `main` ff0b0353):

| Literal                                                                                    | Where                                                                              | Replacement                                                                                              |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `wbs-index` (14 in src, 11 README/doc files)                                               | `src/indexes/read-indexes.ts:15,73,226`, every module README marker                | `module-index`                                                                                           |
| `refs/wbs-wiki/publications` (5 + fixtures)                                                | `src/admission/publication.ts:350` and tests                                       | `refs/module-wiki/publications`                                                                          |
| `wbs-wiki-authority.v4` / `.v3`, `.git/wbs-wiki`, `wbs-wiki/authority.sqlite`              | `src/admission/authority-store.ts:28,404,792`                                      | `module-wiki-authority.v5`, `.git/module-wiki` (a schema version bump, because the on-disk name changes) |
| `WBS_WIKI_PLUGIN_SENTINEL`, `WBS_WIKI_NX_SENTINEL`                                         | test-only env names in `trusted-policy.test.ts`, `relationships.test.ts`           | `MODULE_WIKI_PLUGIN_SENTINEL`, `MODULE_WIKI_NX_SENTINEL`                                                 |
| `tool-wiki-active-v1` marker                                                               | `bin/tool-wiki-lint.sh:105`, `bin/tool-wiki-push-audit.sh:39`, activation fixtures | keep: it is the activation format, not the product name; W7 versions it                                  |
| `TOOL_WIKI_*` env vars, `tool-wiki-lint.sh`, `tool-wiki-push-audit.sh`, `trusted-wiki.yml` | consumer-side contract                                                             | keep in W6; W7 may rename with a compatibility window                                                    |

### Task 6.1: Move the project and its manifests

**Files:**

- Move: `tools/tool-wiki/**` → `apps/wiki/cli/**` (`git mv tools/tool-wiki apps/wiki/cli`)
- Modify: `apps/wiki/cli/project.json` (name, `$schema` depth, `sourceRoot`, tags, every command path, preload path)
- Modify: `apps/wiki/cli/tsconfig.json`, `tsconfig.lib.json`, `tsconfig.spec.json` (`extends` and `outDir` depth: `../../` → `../../../`)
- Modify: `package.json:13` lint script, `bin/h2puni-gate-steps.sh:26-28`, `.github/workflows/ci.yml:354-360`, `lefthook.yml` (unchanged: it calls `bin/tool-wiki-lint.sh`)
- Modify: `tools/tool-devsync/src/repo-namespacing-handoff.test.ts` (calls `../../tool-wiki/src/cli.ts` at the `production index checker` test → `../../../apps/wiki/cli/src/cli.ts`)
- Modify: `docs/wiki-policy/relationships.json` and `relationships.bootstrap.json` (`check.tool-wiki.*` facts: `project`, `cwd`, `command`)
- Modify: `apps/wiki/cli/README.md` marker: `memberships` stay relative (`src`, `project.json`, …), `applicableChecks` → `check.wiki-cli.test`, `check.wiki-cli.lint-source`, `check.wiki-cli.typecheck`
- Test: `tools/tool-devsync/src/namespace-layout.test.ts` (the real workspace must have zero violations after the move; it already runs against `readProjects(WORKSPACE)`), `apps/wiki/cli/src/policy/gate-entrypoints.test.ts` (14 pinned paths)

- [ ] **Step 1: Move.**

```bash
mkdir -p apps/wiki
git mv tools/tool-wiki apps/wiki/cli
```

- [ ] **Step 2: Manifest.** Rewrite `apps/wiki/cli/project.json` to:

```json
{
  "name": "wiki-cli",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "apps/wiki/cli/src",
  "projectType": "application",
  "tags": ["scope:app", "type:app", "runtime:bun", "ring:adapter", "product:wiki"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "TOOL_WIKI_TRUSTED_NODE_MODULES=$PWD/../../../node_modules bun test --preload ../../../tools/test/scratch/preload.ts",
        "cwd": "apps/wiki/cli"
      }
    },
    "lint": {
      "executor": "nx:run-commands",
      "cache": false,
      "inputs": ["{workspaceRoot}/**/*"],
      "options": { "command": "bash bin/tool-wiki-lint.sh working . HEAD" }
    },
    "lint:source": {
      "executor": "nx:run-commands",
      "cache": false,
      "options": { "command": "bunx eslint apps/wiki/cli/src" }
    },
    "lint:fast": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bunx eslint apps/wiki/cli/src --cache --cache-location .nx/eslintcache-wiki-cli"
      }
    },
    "typecheck": {
      "executor": "nx:run-commands",
      "options": { "command": "bunx tsc --build --force apps/wiki/cli/tsconfig.json" }
    }
  }
}
```

In the three tsconfigs replace `../../tsconfig.base.json` with `../../../tsconfig.base.json` and `../../dist/tools/tool-wiki` with `../../../dist/apps/wiki/cli`.

- [ ] **Step 3: Root callers.** `package.json:13` → `"lint": "nx run-many -t lint --exclude=wiki-cli && nx run wiki-cli:lint:source"`. `bin/h2puni-gate-steps.sh:26-28`: replace `tool-wiki` with `wiki-cli` in the three commands and fix the Proof comment on line 24–25 (`--exclude=wiki-cli`). `.github/workflows/ci.yml:354-360`: same three replacements. `apps/wiki/cli/src/policy/gate-entrypoints.test.ts` pins these strings at lines ~1006–1025 (`'tool-wiki:lint'`, `'bunx eslint tools/tool-wiki/src'`, `--exclude=tool-wiki`); update each expectation to the new name and path. Run `grep -rn "tool-wiki:" package.json bin .github apps/wiki` afterwards: only `bin/tool-wiki-lint.sh` script names remain.
- [ ] **Step 4: Relationship facts.** In both `docs/wiki-policy/relationships.json` and `relationships.bootstrap.json`, for the three facts `check.tool-wiki.test`, `check.tool-wiki.lint-source`, `check.tool-wiki.typecheck`: rename `factId` to `check.wiki-cli.*`, `project` to `wiki-cli`, `cwd` to `apps/wiki/cli`, and the commands to the ones in Step 2. Update `applicableChecks` in `apps/wiki/cli/README.md` to the three new ids. Run `bun apps/wiki/cli/src/cli.ts check-indexes working . HEAD`: exit 0 (the marker is still `wbs-index` at this step; Task 6.2 renames it).
- [ ] **Step 5: Fixtures with the old path.** `grep -rn "tools/tool-wiki\|tools', 'tool-wiki'" apps/wiki/cli/src` lists the test lines (gate-entrypoints 14, generations 8, activation 2, pilot-policy 1, audit 1). Replace each with `apps/wiki/cli` / `'apps', 'wiki', 'cli'`. `tools/tool-devsync/src/repo-namespacing-handoff.test.ts`: the `cli` URL becomes `new URL('../../../apps/wiki/cli/src/cli.ts', import.meta.url)`.
- [ ] **Step 6: Verify.**

```bash
bunx nx show projects | grep -E '^(wiki-cli|tool-wiki)$'     # expected: wiki-cli only
bunx nx test tool-devsync --skip-nx-cache                     # layout + inventory + handoff green
bunx nx run-many -t test typecheck build -p wiki-cli --skip-nx-cache
bunx nx run wiki-cli:lint:source --skip-nx-cache
```

Expected: wiki-cli's lint reports the `scope:app` rule? No: `scope:app` may depend on `scope:shared`, and `@shared/validation` is `scope:shared product:shared`; the product rule `product:wiki → product:wiki | product:shared` admits it. If lint reports any `@wbs/*` import, it is a finding: the wiki still depends on WBS code. Report it and stop.

- [ ] **Step 7: Commit** `refactor(wiki): tool-wiki becomes apps/wiki/cli under product:wiki`.

### Task 6.2: Neutral names

**Files:**

- Modify: `apps/wiki/cli/src/indexes/read-indexes.ts:15,73,226`
- Modify: the 11 Markdown files carrying `<!-- wbs-index … -->` (list: `grep -rl "wbs-index" --include='*.md' .`)
- Modify: `apps/wiki/cli/src/admission/publication.ts:350`, `authority-store.ts:28,404,792` and their tests
- Modify: `apps/wiki/cli/src/policy/trusted-policy.test.ts`, `src/relationships/relationships.test.ts` (sentinel env names)
- Modify: `apps/wiki/cli/src/indexes/check-indexes.ts:413` message `selected candidate contains no wbs indexes` → `no module indexes`
- Test: `apps/wiki/cli/src/indexes/*.test.ts` (marker fixtures), `apps/wiki/cli/src/admission/*.test.ts` (ref names)

- [ ] **Step 1: Marker.** In `read-indexes.ts` change the regex to `/^<!--\s*module-index\s+([\s\S]*?)-->$/`, the `includes('wbs-index')` to `includes('module-index')`, and the heading marker to `'module-index-heading'`. Run `bunx nx test wiki-cli --skip-nx-cache -- --test-name-pattern 'index'`: red wherever a fixture still writes `wbs-index`; fix those fixtures. Then rewrite the 11 Markdown markers:

```bash
grep -rl "wbs-index" --include='*.md' . | grep -v node_modules | xargs sed -i 's#<!-- wbs-index #<!-- module-index #'
bun apps/wiki/cli/src/cli.ts check-indexes working . HEAD   # exit 0, eight indexes
```

`openspec/changes/agent-scalable-llm-wiki/{design,verify}.md` and `docs/plans/2026-09-13-…` mention the marker in prose; leave prose, rewrite only literal markers (the sed above only matches the marker form).

- [ ] **Step 2: Refs and schema.** `publication.ts`: `refs/wbs-wiki/publications` → `refs/module-wiki/publications`. `authority-store.ts`: `AUTHORITY_SCHEMA_VERSION = 'module-wiki-authority.v5'`, directory `.git/module-wiki`, file `module-wiki/authority.sqlite`. Where the store opens an existing authority, an older schema version must throw by name (it does today for v3 vs v4; the test for that case exists in `authority-store.test.ts`, extend it with `wbs-wiki-authority.v4` as the rejected old value). Update the fixture refs in `admission/*.test.ts`.
- [ ] **Step 3: Sentinels.** `sed -i 's/WBS_WIKI_/MODULE_WIKI_/g' apps/wiki/cli/src/policy/trusted-policy.test.ts apps/wiki/cli/src/relationships/relationships.test.ts` and the same in any `src` file `grep -rn WBS_WIKI_ apps/wiki/cli/src` still lists.
- [ ] **Step 4: Verify.** `bunx nx run-many -t test typecheck build -p wiki-cli --skip-nx-cache` (about 15 min; run on h2puni or accept the wait) and `bunx nx run wiki-cli:lint:source --skip-nx-cache`. `grep -rn "wbs-index\|wbs-wiki\|WBS_WIKI" apps/wiki bin .github docs/wiki-policy` prints nothing.
- [ ] **Step 5: Commit** `refactor(wiki): product-neutral marker, refs and authority schema`.

### Task 6.3: Policy and mapping relocation entries

The bootstrap policy and mapping still describe the pre-#457 tree and the pre-W6 wiki path. W5 is the procedure; this task prepares the files it needs.

**Files:**

- Modify: `docs/wiki-policy/bootstrap-policy.json`: for `boundary.infra.tool-wiki` set `selector` to `{ "kind": "prefix", "value": "apps/wiki/cli" }` and add `"sourceSelector": { "kind": "prefix", "value": "tools/tool-wiki" }`; for the three boundaries still on pre-#457 paths (`libs/domain/src/saved-plan`, `libs/core/src/use-cases`, `libs/store-memory/src`) copy the `selector`/`sourceSelector` pairs from `policy.json`
- Modify: `docs/wiki-policy/modules.bootstrap.json`: `module.infra.tool-wiki` memberships prefix `apps/wiki/cli`, `indexPath` `apps/wiki/cli/README.md`; bump `mappingVersion` to `tool-wiki-bootstrap-<new sha8>-v2` and `sourceRevision` to the candidate head after the last content commit; the three relocated pilot modules get the namespaced prefixes from `modules.json`
- Modify: `docs/wiki-policy/policy.json` and `modules.json`: same wiki entries if the pilot policy lists the wiki module (it does not on `main`; verify with `grep -n tool-wiki docs/wiki-policy/policy.json`)
- Test: `apps/wiki/cli/src/policy/pilot-policy.test.ts` cases `trusted boundary baseline escapes selector` (they use `boundary.domain.saved-plan` fixtures and are unaffected), plus one new case: the bootstrap policy's `boundary.infra.tool-wiki` baseline entries all lie under `sourceSelector`

- [ ] **Step 1: Write the new case**: load `docs/wiki-policy/bootstrap-policy.json`, find `boundary.infra.tool-wiki`, assert every `baselineEntries[].path` starts with `tools/tool-wiki/` and `selector.value === 'apps/wiki/cli'`. Run: red (selector still `tools/tool-wiki`, no `sourceSelector`).
- [ ] **Step 2: Edit the four JSON files** as listed. `bun apps/wiki/cli/src/cli.ts check-indexes working . HEAD`: exit 0.
- [ ] **Step 3: Run** `bunx nx test wiki-cli --skip-nx-cache -- --test-name-pattern 'policy'`: green. Whole-tree diagnostic lint `bash bin/tool-wiki-lint.sh working . HEAD` exits 0 with `status: inactive` (no activation locally; that is the expected diagnostic result).
- [ ] **Step 4: Commit** `docs(wiki-policy): relocation selectors for the wiki move`.

### Task 6.4: Product lint policy and docs

**Files:**

- Create: `apps/wiki/eslint.product.mjs` spelled `export default () => [];` with a comment that the wiki has no product-specific lint rules yet (the file's presence proves discovery for a second product; Task 1.4's test covers absence)
- Modify: `LLM_README.md` first paragraph: add `wiki-cli` (the module-wiki validator, `apps/wiki/cli`, a product released separately) to the project list; the "More" table row for `docs/runbook-tool-wiki-activation.md` unchanged
- Modify: `docs/runbook-tool-wiki-activation.md`: every `tools/tool-wiki` path → `apps/wiki/cli`; the Nx targets `tool-wiki:test|lint:source|typecheck` → `wiki-cli:*`
- Modify: `docs/plans/2026-09-13-tool-wiki-precedents-and-extraction.md` Part 3: a dated note that the namespace move happened here and extraction to its own repo waits for the second consumer
- Modify: `CONTEXT.md`: under the `Product` term add `wiki` as the second product, one line

- [ ] Steps: make the edits; `bun run tools/tool-git-hooks/src/hooks/doc-caps.ts`; `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'links and anchors'`; `bunx nx run wiki-cli:lint:source --skip-nx-cache`; commit `docs(wiki): route the wiki product`.

### Task 6.5: Gate

- [ ] `bunx nx format:write`; `git diff --check`; push; on h2puni `bin/h2puni-gate.sh $(git rev-parse HEAD)`; paste the `running on` line into the PR body.

### Task 6.6: Second-product proof, recorded

- [ ] In the PR body list every file outside `apps/wiki/` and `docs/` that the move touched. The expected list is exactly: `package.json` (lint script), `bin/h2puni-gate-steps.sh`, `.github/workflows/ci.yml` (three gate commands), `docs/wiki-policy/*.json`, `tools/tool-devsync/src/repo-namespacing-handoff.test.ts` (one path), `LLM_README.md`, `CONTEXT.md`. Each of the first three is a hand-edited selector that the product descriptor (queued) should replace; say so in the body. Anything beyond that list is a new finding for the descriptor work.

### Task 6.7: Relocation activation (uses W5)

- [ ] Run W5's `prepare-relocation-activation` for this PR's head, publish the archive, set the three `TOOL_WIKI_ACTIVATION_*` repository variables to it (Dany or an admin), rerun the `trusted-wiki` check: green. Record the archive digest and version in `openspec/changes/agent-scalable-llm-wiki/verify.md` under a dated heading. Do not merge before this is green.

---

## W7 — The wiki is released for other repositories (OpenSpec change `wiki-release`)

**Problem:** the only way another repository can run the wiki's trusted check is to point `TOOL_WIKI_ACTIVATION_VERSION` at a 40-hex commit of _this_ repository, which `trusted-wiki.yml` then checks out to install the launcher's runtime. **Outcome:** a wiki release is a tagged, digest-pinned archive any repository consumes with a copied workflow and three variables; the consumer never checks out the wiki's source. **Non-goals:** moving the wiki to its own repository; changing the activation format; multi-consumer policy sharing (each consumer owns its `policy.json`, `modules.json` and README markers).

This is an OpenSpec change: run `opsx:new wiki-release`, write the intent from this section, and derive `tasks.md` from the tasks below. Design interview points to settle in the intent: (1) tag format `wiki-vMAJOR.MINOR.PATCH`; (2) what a release is reviewed against (the tag's commit, named in the review receipt); (3) the compatibility window during which the consumer workflow accepts either a 40-hex SHA or a tag.

### Task 7.1: A release is a tag resolved to a commit

**Files:**

- Modify: `.github/workflows/trusted-wiki.yml` step "Require immutable activation configuration": accept `^[0-9a-f]{40}$` or `^wiki-v[0-9]+\.[0-9]+\.[0-9]+$`; for a tag, resolve it with `git ls-remote --tags origin "refs/tags/$ACTIVATION_VERSION^{}"` and refuse when the tag is absent or resolves to more than one object
- Modify: the same guard in `.github/workflows/ci.yml` (push-audit provisioning, lines ~265–285) and `bin/tool-wiki-push-audit.sh` if it validates the version
- Test: `apps/wiki/cli/src/policy/gate-entrypoints.test.ts` already reads both workflows and asserts their guard strings; extend the expectations with the tag regex and add a negative: `wiki-v1` (no patch) must still be refused by the regex (unit-test the regex by extracting it from the YAML text and running it against `wiki-v1.2.3`, `wiki-v1`, a 40-hex SHA and `main`)

- [ ] Steps: extend the test (red), edit the YAML (green), commit `ci(wiki): accept a release tag as the activation version`.

### Task 7.2: The consumer never checks out the wiki's source

The trusted workflow today checks out `TOOL_WIKI_ACTIVATION_VERSION` into `trusted/` to get `bin/tool-wiki-lint.sh` and to `bun install` the runtime modules. The archive already carries a launcher copy (`launcher-path` descriptor) and `trusted-node-modules` (runbook, "Transport and admission"). Use them.

**Files:**

- Modify: `.github/workflows/trusted-wiki.yml`: delete the "Check out trusted launcher", "Preserve trusted launcher" and "Install trusted validator runtime modules" steps; after extraction, read `$activation_root/launcher-path` (relative to the archive root) and `install -m 0555` that file to `$RUNNER_TEMP/tool-wiki-lint.sh`; set `TOOL_WIKI_TRUSTED_NODE_MODULES=$activation_root/trusted-node-modules`; keep the candidate checkout at `path: candidate`
- Modify: `bin/tool-wiki-lint.sh`: it already defaults `TOOL_WIKI_TRUSTED_NODE_MODULES` on h2puni to the archive's directory; make the same default apply when `TOOL_WIKI_ACTIVATION_ROOT` is set and the variable is unset, and refuse when the directory is absent
- Test: `gate-entrypoints.test.ts` "production entrypoint adapter" cases: add one where the activation root carries `trusted-node-modules` and the environment variable is unset (must run), and one where neither exists (must refuse naming the directory)

- [ ] Steps: red, implement, green, then a real run: push a branch and watch `trusted-wiki` run against the current activation (it still works with a SHA version because the archive carries the launcher). Commit `ci(wiki): consumers run the archived launcher and runtime`.

### Task 7.3: `wiki-cli:release` target

**Files:**

- Create: `apps/wiki/cli/src/cli/release.ts`: inputs `--tag wiki-vX.Y.Z`, `--review-receipt <path>`, `--destination <dir>`; refuses a dirty tree, a tag that does not point at `HEAD`, a receipt whose reviewed revision is not `HEAD`; runs the three bootstrap checks (`wiki-cli:test`, `wiki-cli:lint:source`, `wiki-cli:typecheck`, uncached) and refuses on any non-zero exit; then calls `prepareActivation` with `sourceRevision = HEAD`, the ten role sources the runbook lists, `policyIdentity`/`mappingIdentity`/`validatorIdentity`/`reviewReceiptIdentity` computed with `hashBytes`; then `tar` the destination into `wiki-<tag>.tar` and print the archive path, its SHA-256 and the tag
- Modify: `apps/wiki/cli/project.json`: target `release` with `"cache": false`, command `bun src/cli/release.ts`, `cwd: apps/wiki/cli`
- Create: `.github/workflows/wiki-release.yml`: on `push` of tags `wiki-v*`, runs the release target on a runner, uploads the archive and a `SHA256SUMS` file as GitHub release assets with `softprops/action-gh-release` pinned by SHA; permissions `contents: write` only in this workflow
- Test: `apps/wiki/cli/src/cli/release.test.ts`: fixture repository with one commit and a tag; (a) dirty tree refuses; (b) tag not at HEAD refuses; (c) receipt for another revision refuses; (d) happy path produces an archive whose extracted `selected.json` names the tag's SHA and whose digest matches the printed one

- [ ] Steps: write (a)–(c) red, implement, add (d), green; do not create a real tag until Dany says so; commit `feat(wiki): release target builds a tagged activation archive`.

### Task 7.4: Consumer template and runbook

**Files:**

- Create: `apps/wiki/consumer/trusted-wiki.yml` (the workflow a consumer copies, identical to this repo's after 7.2) and `apps/wiki/consumer/README.md`: the three variables, where to put `policy.json`/`modules.json`, the `module-index` marker format with one example, and the relocation procedure link
- Modify: `docs/runbook-tool-wiki-activation.md`: "Prepare" becomes "Release" (Task 7.3 command), "Transport" says the archive is a GitHub release asset, "Relocation" (from W5) unchanged
- Test: `gate-entrypoints.test.ts`: the consumer template and this repo's `trusted-wiki.yml` are byte-identical

- [ ] Steps: red on the byte-identity test, write the files, green, commit `docs(wiki): consumer template and release runbook`.

### Task 7.5: Verify

- [ ] `verify.md`: a release built from a throwaway tag on a fork or a branch tag `wiki-v0.0.1-rc1` (delete after), a second repository (Dany names it; `aivn-v1` is the candidate) with the template workflow and one `module-index` README, the variables pointed at that archive, and the check green there. Only then is the change archivable.

---

## Queued, not in this plan (recorded in `docs/refactoring/tasks.md` by Task 1.8)

- Product descriptor manifest replacing `deploy-contract.ts`'s closed `Tier` union, `RESTART_PATHS`, the Dagger maps, the Caddy site template placeholders, `migration-lint`'s fixed root and the CI solver steps (report idea 1). It is the next change after W1 and needs its own design interview: it changes the deploy contract.
- Relocation of solver-supervisor host tooling and the `tools/dev` corpus writers under `apps/wbs/` (clears Task 1.5's allows).
- core↔store-memory cycle removal (Task 1.8 records the concrete move).
- Machine-readable gate evidence, generated OpenSpec queue, drift lint for inline code paths, Nx target defaults, permanent probe product in CI (report ideas 4, 9, 13, 20, 24).

## Self-review

- Coverage: findings 1–6 map to Tasks 1.6, 1.1, 1.4, 1.2+1.3+1.5, 1.7, 1.8. Lock → W2. CI speed → W3. Lanes → W4. Trusted boundary → W5. Wiki as a product → W6. Wiki released separately → W7.
- Every task names its files, its test and its negative. No task references a symbol not defined here except existing ones (`readProjects`, `productConstraints`, `selectedMembers`, `prepareActivation`, `validatePilotModuleMapping`), all verified present on `main` ff0b0353.
- Names used across tasks: `@shared/validation` (1.3, 1.6, 1.7, 3.1, 6.1), `apps/<product>/eslint.product.mjs` (1.4, 6.4), `wiki-cli` (6.1–7.5), `module-index` (6.2, 7.4), `HEAVY_LOCK_LABEL` and `HEAVY_LOCK_POLL_SECONDS` (2.1, 2.2), `mode`/`base` step outputs (3.1, 3.2), `prepare-relocation-activation` (5.2, 6.7).
